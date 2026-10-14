import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Pool sync walks the indexer by KEYSET (`id_gt`), resumes a failed walk where
 * it stopped, skips a scheduled run right after a complete walk, and writes
 * only pools whose content changed. Each of these is a load decision (2026-10-02:
 * a chain-1 walk ran past 90 min on deep `skip` offsets and rewrote every pool),
 * so each is pinned here.
 */

const calls: Array<{ op: string; vars: Record<string, unknown> }> = [];
const dayCalls: Array<{ ids: string[]; first: number }> = [];
let failOnCall: number | null = null;
let universe: string[] = [];
/** Day rows per pool the fake indexer holds (newest first), keyed by pool id. */
let dayRows: Map<string, Array<{ date: string; volumeUSD: string; feesUSD: string; tvlUSD: string }>> = new Map();
let dayFloor: number | null = null;
/** Pools the fake indexer returns with two chain-1 ANCHOR legs (USDC/WETH), so they are priced, not stubbed. */
let pricedIds = new Set<string>();

vi.mock('../src/subgraph/request-retry.js', () => ({
  requestWithRetry: async (_client: unknown, query: unknown, vars: Record<string, unknown>) => {
    const text = String(query);
    if (text.includes('PoolDayMax')) return { poolDayDatas: dayFloor === null ? [] : [{ date: String(dayFloor) }] };
    if (text.includes('PoolDayBatch')) {
      const ids = vars.ids as string[];
      const first = Number(vars.first);
      dayCalls.push({ ids, first });
      // Ordered globally by date desc (then id), capped at `first` — the indexer's truncation.
      const rows = ids
        .flatMap((id) => (dayRows.get(id) ?? []).map((r) => ({ ...r, pool: { id } })))
        .sort((a, b) => Number(b.date) - Number(a.date) || (a.pool.id < b.pool.id ? -1 : 1))
        .slice(0, first);
      return { poolDayDatas: rows };
    }
    calls.push({ op: 'pools', vars });
    if (failOnCall !== null && calls.length === failOnCall) throw new Error('indexer 502');
    const where = (vars.where ?? {}) as { id_gt?: string };
    const first = Number(vars.first);
    const rows = universe.filter((id) => where.id_gt === undefined || id > where.id_gt).slice(0, first);
    return { pools: rows.map(row) };
  },
}));

import {
  POOL_REWRITE_JITTER,
  POOL_REWRITE_MAX_AGE_MS,
  POOL_WRITE_CHUNK,
  PoolsRepository,
  packPoolMemo,
  poolContentHash,
  poolRewriteDueAt,
  unpackPoolMemo,
  type PoolUpsert,
} from '../src/database/pools.repository.js';
import { DAY_DATA_MAX_ROWS, POOL_SYNC_PAGE_SIZE, PoolsSyncService, fetchDayDataFor } from '../src/sync/pools-sync.service.js';

function row(id: string) {
  const priced = pricedIds.has(id);
  return {
    id,
    // Not anchors, not allowlisted → the risky-stub path (no pricing call) —
    // unless the test asked for a priced pool (USDC / WETH, both anchors).
    token0: priced
      ? { id: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', symbol: 'USDC', decimals: '6' }
      : { id: '0x00000000000000000000000000000000000000a1', symbol: 'AAA', decimals: '18' },
    token1: priced
      ? { id: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', symbol: 'WETH', decimals: '18' }
      : { id: '0x00000000000000000000000000000000000000b2', symbol: 'BBB', decimals: '18' },
    feeTier: '3000',
    tickSpacing: '60',
    tick: '10',
    sqrtPrice: '79228162514264337593543950336',
    liquidity: '1000',
    createdAtTimestamp: '1700000000',
    totalValueLockedToken0: '1',
    totalValueLockedToken1: '2',
    totalValueLockedUSD: '0',
    volumeUSD: '5',
    feesUSD: '0.01',
    txCount: '3',
    token0Price: '1',
    token1Price: '1',
  };
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `0x${(i + 1).toString(16).padStart(64, '0')}`);

const PAGE = POOL_SYNC_PAGE_SIZE;

function makeService(intervalMs = 6 * 3_600_000, opts: { failUpsertOnCall?: number } = {}) {
  const written: string[] = [];
  const walks: Array<{ chainId: number; protocol: string; pools: number; tvlUsd: number; skipped: number }> = [];
  let upserts = 0;
  const repo = {
    upsertMany: async (pools: PoolUpsert[]) => {
      upserts++;
      if (opts.failUpsertOnCall === upserts) throw new Error('mongo write failed');
      written.push(...pools.map((p) => p.poolId));
      return { written: pools.length, unchanged: 0, hashReads: 0 };
    },
  };
  const syncRepo = {
    recordPoolWalk: async (chainId: number, protocol: string, walk: { pools: number; tvlUsd: number; skipped: number }) => {
      walks.push({ chainId, protocol, pools: walk.pools, tvlUsd: walk.tvlUsd, skipped: walk.skipped });
    },
  };
  const config = {
    getIntegration: () => ({ chainId: 1, protocol: 'uniswap-v4', subgraphUrl: 'http://indexer.test/graphql' }),
    poolsSyncIntervalMs: intervalMs,
  };
  // Anchor legs price at $1 / $2,000 with anchor confidence: a priced pool's
  // trusted TVL is reserve0 × 1 + reserve1 × 2,000 = 1 + 4,000.
  const pricing = {
    pricePool: async () => ({ token0Usd: 1, token1Usd: 2_000, source: 'test', usedFallback: false, token0Confidence: 'anchor', token1Confidence: 'anchor' }),
  };
  const svc = new PoolsSyncService(config as never, repo as never, pricing as never, syncRepo as never);
  (svc as unknown as { logger: unknown }).logger = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  return { svc, written, walks };
}

beforeEach(() => {
  calls.length = 0;
  dayCalls.length = 0;
  failOnCall = null;
  universe = ids(2 * PAGE + PAGE / 2);
  dayRows = new Map();
  dayFloor = null;
  pricedIds = new Set();
});

describe('PoolsSyncService keyset walk', () => {
  it(`pages of ${POOL_SYNC_PAGE_SIZE} by id_gt from the last id the server returned, with no skip, and writes every pool once`, async () => {
    expect(PAGE).toBe(1000);
    const { svc, written } = makeService();
    await svc.syncPools(1, 'uniswap-v4');
    expect(calls.map((c) => c.vars.where)).toEqual([{}, { id_gt: universe[PAGE - 1] }, { id_gt: universe[2 * PAGE - 1] }]);
    expect(calls.every((c) => c.vars.first === PAGE && !('skip' in c.vars))).toBe(true);
    expect(written).toEqual(universe);
  });

  it('a failed walk resumes after the last WRITTEN page, and a later complete walk starts from the top', async () => {
    const { svc, written } = makeService();
    failOnCall = 2;
    await expect(svc.syncPools(1, 'uniswap-v4')).rejects.toThrow('indexer 502');
    expect(written).toEqual(universe.slice(0, PAGE));

    failOnCall = null;
    calls.length = 0;
    await svc.syncPools(1, 'uniswap-v4');
    expect(calls[0]!.vars.where).toEqual({ id_gt: universe[PAGE - 1] });
    expect(written).toEqual(universe);

    calls.length = 0;
    await svc.syncPools(1, 'uniswap-v4');
    expect(calls[0]!.vars.where).toEqual({});
  });

  it('a failed WRITE resumes after the last written page too (it used to restart from an older resume point)', async () => {
    const { svc, written } = makeService(6 * 3_600_000, { failUpsertOnCall: 2 });
    await expect(svc.syncPools(1, 'uniswap-v4')).rejects.toThrow('mongo write failed');
    expect(written).toEqual(universe.slice(0, PAGE));
    calls.length = 0;
    await svc.syncPools(1, 'uniswap-v4');
    expect(calls[0]!.vars.where).toEqual({ id_gt: universe[PAGE - 1] });
  });

  it('records the walk totals in sync_cursors ONLY when a walk completes — a resumed walk counts every pool once', async () => {
    const { svc, walks } = makeService();
    failOnCall = 2;
    await expect(svc.syncPools(1, 'uniswap-v4')).rejects.toThrow();
    expect(walks).toEqual([]); // a partial walk records nothing
    failOnCall = null;
    await svc.syncPools(1, 'uniswap-v4');
    // Risky stubs (the fixture's tokens are not anchors / allowlisted) carry 0 TVL.
    expect(walks).toEqual([{ chainId: 1, protocol: 'uniswap-v4', pools: universe.length, tvlUsd: 0, skipped: 0 }]);
    await svc.syncPools(1, 'uniswap-v4');
    expect(walks[1]).toMatchObject({ pools: universe.length });
  });

  it('the recorded TVL is the sum of the walk\'s trusted pool TVLs, across pages and a resumed retry', async () => {
    // 3 priced pools on page 1, 2 on page 3; everything else a $0 stub.
    pricedIds = new Set([universe[0]!, universe[1]!, universe[PAGE - 1]!, universe[2 * PAGE]!, universe[2 * PAGE + 7]!]);
    const { svc, walks } = makeService();
    failOnCall = 2;
    await expect(svc.syncPools(1, 'uniswap-v4')).rejects.toThrow();
    failOnCall = null;
    await svc.syncPools(1, 'uniswap-v4');
    expect(walks).toHaveLength(1);
    expect(walks[0]!.tvlUsd).toBeCloseTo(5 * 4_001, 6);
    expect(walks[0]!.pools).toBe(universe.length);
  });

  it('skips a SCHEDULED run within half an interval of a complete walk; an unscheduled one always walks', async () => {
    const { svc } = makeService(6 * 3_600_000);
    await svc.syncPools(1, 'uniswap-v4');
    calls.length = 0;
    await expect(svc.syncPools(1, 'uniswap-v4', { scheduled: true })).resolves.toEqual({ upserted: 0, skipped: 0 });
    expect(calls).toHaveLength(0);
    await svc.syncPools(1, 'uniswap-v4', { scheduled: true, now: Date.now() + 3 * 3_600_000 + 1 });
    expect(calls.length).toBeGreaterThan(0);
    calls.length = 0;
    await svc.syncPools(1, 'uniswap-v4');
    expect(calls.length).toBeGreaterThan(0);
  });

  it('a failed walk does not count as finished: the next scheduled run still walks', async () => {
    const { svc } = makeService();
    failOnCall = 1;
    await expect(svc.syncPools(1, 'uniswap-v4')).rejects.toThrow();
    failOnCall = null;
    calls.length = 0;
    await svc.syncPools(1, 'uniswap-v4', { scheduled: true });
    expect(calls.length).toBeGreaterThan(0);
  });
});

describe('PoolsRepository.upsertMany skips unchanged pools', () => {
  const base: PoolUpsert = {
    chainId: 1,
    protocol: 'uniswap-v4',
    poolId: '0xp1',
    token0: { address: '0xa', symbol: 'A', decimals: 18 },
    token1: { address: '0xb', symbol: 'B', decimals: 6 },
    fee: 3000,
    tickSpacing: 60,
    currentTick: 10,
    sqrtPriceX96: '123',
    liquidity: '1000',
    createdAtTimestamp: 1,
    metrics: {
      tvlUsd: 1234.56789,
      volumeUsd24h: 0,
      volumeUsd7d: 0,
      feesUsd24h: 0,
      feesUsd7d: 0,
      feeApr: 0,
      txCount: 3,
      currentPrice: 1,
    },
    pricing: { source: 'x', usedFallback: false },
  };

  it('hashes past rounding noise but not past a real move', () => {
    const h = poolContentHash(base);
    expect(poolContentHash({ ...base, metrics: { ...base.metrics, tvlUsd: 1234.567891 } })).toBe(h);
    expect(poolContentHash({ ...base, metrics: { ...base.metrics, tvlUsd: 1240 } })).not.toBe(h);
    expect(poolContentHash({ ...base, sqrtPriceX96: '124' })).not.toBe(h);
    expect(poolContentHash({ ...base, currentTick: 11 })).not.toBe(h);
    // `undefined` is "absent", like the stored document.
    expect(poolContentHash({ ...base, metrics: { ...base.metrics, tvlToken0: undefined } })).toBe(h);
  });

  function repoWith(
    stored: Array<{ poolId: string; contentHash?: string; updatedAt?: Date }>,
    opts: { failBulkWriteOnCall?: number; storedCount?: () => number } = {},
  ) {
    const ops: unknown[] = [];
    const batches: number[] = [];
    const finds: string[][] = [];
    let bulkWrites = 0;
    const model = {
      estimatedDocumentCount: () => ({ exec: async () => opts.storedCount?.() ?? 0 }),
      find: (filter: { poolId: { $in: string[] } }) => {
        finds.push([...filter.poolId.$in]);
        return { lean: () => ({ exec: async () => stored.filter((row) => filter.poolId.$in.includes(row.poolId)) }) };
      },
      bulkWrite: async (batch: unknown[]) => {
        bulkWrites++;
        if (opts.failBulkWriteOnCall === bulkWrites) throw new Error('bulkWrite failed');
        ops.push(...batch);
        batches.push(batch.length);
        return { upsertedCount: 0, modifiedCount: batch.length };
      },
    };
    const resolver = { poolModel: () => model };
    const repo = new PoolsRepository(resolver as never, {} as never);
    return { repo, ops, batches, finds };
  }

  const HOUR = 3_600_000;
  /** Past any pool's jittered forced-rewrite age (+ the memo's 1-hour rounding). */
  const OVERDUE_MS = POOL_REWRITE_MAX_AGE_MS * (1 + POOL_REWRITE_JITTER) + 2 * HOUR;

  it('writes only changed, new or rewrite-due pools, and stamps the hash it compared', async () => {
    const now = new Date('2026-10-02T12:00:00Z');
    const recent = new Date(now.getTime() - 60_000);
    const old = new Date(now.getTime() - OVERDUE_MS);
    const same = { ...base, poolId: '0xsame' };
    const moved = { ...base, poolId: '0xmoved' };
    const stale = { ...base, poolId: '0xstale' };
    const fresh = { ...base, poolId: '0xnew' };
    const { repo, ops } = repoWith([
      { poolId: '0xsame', contentHash: poolContentHash(same), updatedAt: recent },
      { poolId: '0xmoved', contentHash: 'other', updatedAt: recent },
      { poolId: '0xstale', contentHash: poolContentHash(stale), updatedAt: old },
    ]);
    const result = await repo.upsertMany([same, moved, stale, fresh], now);
    expect(result).toEqual({ written: 3, unchanged: 1, hashReads: 4 });
    const written = (ops as Array<{ updateOne: { filter: { poolId: string }; update: { $set: { contentHash: string; updatedAt: Date } } } }>);
    expect(written.map((o) => o.updateOne.filter.poolId).sort()).toEqual(['0xmoved', '0xnew', '0xstale']);
    for (const o of written) {
      expect(o.updateOne.update.$set.updatedAt).toBe(now);
      expect(o.updateOne.update.$set.contentHash).toBe(poolContentHash({ ...base, poolId: o.updateOne.filter.poolId }));
    }
  });

  it('a warm walk decides from memory: no stored-hash read at all, and unchanged pools are not written', async () => {
    const t0 = new Date('2026-10-02T12:00:00Z');
    const pools = ['0xa', '0xb', '0xc'].map((poolId) => ({ ...base, poolId }));
    const { repo, ops, finds } = repoWith([]);
    expect(await repo.upsertMany(pools, t0)).toEqual({ written: 3, unchanged: 0, hashReads: 3 });
    expect(finds).toHaveLength(1);
    // The next walk, an hour later: nothing changed, nothing read, nothing written.
    const t1 = new Date(t0.getTime() + HOUR);
    expect(await repo.upsertMany(pools, t1)).toEqual({ written: 0, unchanged: 3, hashReads: 0 });
    expect(finds).toHaveLength(1);
    expect(ops).toHaveLength(3);
    // A real change is written — still with no read.
    const movedB = { ...pools[1]!, currentTick: 99 };
    expect(await repo.upsertMany([pools[0]!, movedB, pools[2]!], t1)).toEqual({ written: 1, unchanged: 2, hashReads: 0 });
    expect(finds).toHaveLength(1);
  });

  it('the forced rewrite comes due 24 h ±25% after the last write, per pool, from memory too', async () => {
    const t0 = new Date('2026-10-02T12:00:00Z');
    const pools = Array.from({ length: 40 }, (_, i) => ({ ...base, poolId: `0x${i.toString(16).padStart(4, '0')}` }));
    const { repo } = repoWith([]);
    await repo.upsertMany(pools, t0);
    // Before the earliest possible due time nobody is rewritten …
    const early = new Date(t0.getTime() + POOL_REWRITE_MAX_AGE_MS * (1 - POOL_REWRITE_JITTER) - 2 * HOUR);
    expect((await repo.upsertMany(pools, early)).written).toBe(0);
    // … after the latest, everybody is …
    const late = new Date(t0.getTime() + OVERDUE_MS);
    expect((await repo.upsertMany(pools, late)).written).toBe(pools.length);
    // … and in between, exactly the pools whose own due time has passed (spread, not one wave).
    const { repo: repo2 } = repoWith([]);
    await repo2.upsertMany(pools, t0);
    const mid = new Date(t0.getTime() + POOL_REWRITE_MAX_AGE_MS);
    const due = pools.filter((p) => mid.getTime() >= Math.floor(poolRewriteDueAt(p.poolId, t0.getTime()) / HOUR) * HOUR);
    const result = await repo2.upsertMany(pools, mid);
    expect(result.written).toBe(due.length);
    expect(due.length).toBeGreaterThan(0);
    expect(due.length).toBeLessThan(pools.length);
  });

  it(`writes in bulkWrites of at most ${POOL_WRITE_CHUNK} ops`, async () => {
    const pools = Array.from({ length: 1_200 }, (_, i) => ({ ...base, poolId: `0x${i.toString(16).padStart(6, '0')}` }));
    const { repo, batches } = repoWith([]);
    const result = await repo.upsertMany(pools, new Date('2026-10-02T12:00:00Z'));
    expect(result.written).toBe(1_200);
    expect(batches).toEqual([500, 500, 200]);
  });

  it('a chunk whose write fails is NOT remembered: the next walk writes those pools again', async () => {
    const pools = Array.from({ length: 600 }, (_, i) => ({ ...base, poolId: `0x${i.toString(16).padStart(6, '0')}` }));
    const { repo, finds } = repoWith([], { failBulkWriteOnCall: 2 });
    const t0 = new Date('2026-10-02T12:00:00Z');
    await expect(repo.upsertMany(pools, t0)).rejects.toThrow('bulkWrite failed');
    const result = await repo.upsertMany(pools, new Date(t0.getTime() + 60_000));
    // The first chunk (500) is remembered; the failed one (100) is read again and written.
    expect(finds[1]).toEqual(pools.slice(500).map((p) => p.poolId));
    expect(result).toEqual({ written: 100, unchanged: 500, hashReads: 100 });
  });

  it('a REMEMBERED pool whose new content fails to write is still changed on the next walk', async () => {
    const pool = { ...base, poolId: '0xremembered' };
    const { repo, ops } = repoWith([], { failBulkWriteOnCall: 2 });
    const t0 = new Date('2026-10-02T12:00:00Z');
    await repo.upsertMany([pool], t0); // remembered with its hash
    const moved = { ...pool, currentTick: 42 };
    await expect(repo.upsertMany([moved], new Date(t0.getTime() + 60_000))).rejects.toThrow('bulkWrite failed');
    const retry = await repo.upsertMany([moved], new Date(t0.getTime() + 120_000));
    expect(retry).toEqual({ written: 1, unchanged: 0, hashReads: 0 });
    expect(ops).toHaveLength(2);
  });
});

describe('pool write memo against the shard', () => {
  const base = {
    chainId: 1, protocol: 'uniswap-v4', token0: { address: '0xa', symbol: 'A', decimals: 18 }, token1: { address: '0xb', symbol: 'B', decimals: 6 },
    fee: 3000, tickSpacing: 60, currentTick: 10, sqrtPriceX96: '1', liquidity: '1', createdAtTimestamp: 1,
    metrics: { tvlUsd: 0, volumeUsd24h: 0, volumeUsd7d: 0, feesUsd24h: 0, feesUsd7d: 0, feeApr: 0, txCount: 0, currentPrice: 1 },
    pricing: { source: 'none', usedFallback: true },
  } as PoolUpsert;

  it('a shard holding FEWER pools than remembered (dropped / pruned by hand) forgets the memory; otherwise it is kept', async () => {
    let storedCount = 3;
    const finds: string[][] = [];
    const model = {
      estimatedDocumentCount: () => ({ exec: async () => storedCount }),
      find: (filter: { poolId: { $in: string[] } }) => (finds.push(filter.poolId.$in), { lean: () => ({ exec: async () => [] }) }),
      bulkWrite: async (batch: unknown[]) => ({ upsertedCount: batch.length, modifiedCount: 0 }),
    };
    const repo = new PoolsRepository({ poolModel: () => model } as never, {} as never);
    (repo as unknown as { logger: unknown }).logger = { warn: () => {} };
    const pools = ['0x1', '0x2', '0x3'].map((poolId) => ({ ...base, poolId }));
    await repo.upsertMany(pools);
    expect(await repo.revalidateWriteMemo(1, 'uniswap-v4')).toEqual({ remembered: 3, stored: 3, cleared: false });
    expect((await repo.upsertMany(pools)).hashReads).toBe(0);
    storedCount = 0; // somebody dropped the collection
    expect(await repo.revalidateWriteMemo(1, 'uniswap-v4')).toEqual({ remembered: 3, stored: 0, cleared: true });
    const after = await repo.upsertMany(pools);
    expect(after).toMatchObject({ hashReads: 3, written: 3 });
  });

  it('pool sync re-checks it when a walk starts from the TOP, not when it resumes', async () => {
    const checks: number[] = [];
    const repo = {
      revalidateWriteMemo: async (chainId: number) => {
        checks.push(chainId);
      },
      upsertMany: async (pools: PoolUpsert[]) => ({ written: pools.length, unchanged: 0, hashReads: 0 }),
    };
    const config = { getIntegration: () => ({ chainId: 1, protocol: 'uniswap-v4', subgraphUrl: 'http://indexer.test/graphql' }), poolsSyncIntervalMs: 1 };
    const svc = new PoolsSyncService(config as never, repo as never, {} as never);
    (svc as unknown as { logger: unknown }).logger = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    failOnCall = 2;
    await expect(svc.syncPools(1, 'uniswap-v4')).rejects.toThrow();
    expect(checks).toEqual([1]);
    failOnCall = null;
    await svc.syncPools(1, 'uniswap-v4'); // resumed
    expect(checks).toEqual([1]);
    await svc.syncPools(1, 'uniswap-v4'); // from the top again
    expect(checks).toEqual([1, 1]);
  });
});

describe('pool write memo', () => {
  it('packs 32 bits of the hash and the due HOUR (rounded down) into one safe integer', () => {
    const hash = poolContentHash({ chainId: 1, protocol: 'p', poolId: '0x1' } as never);
    const due = Date.UTC(2026, 9, 3, 17, 42, 5);
    const packed = packPoolMemo(hash, due)!;
    expect(Number.isSafeInteger(packed)).toBe(true);
    const back = unpackPoolMemo(packed);
    expect(back.hash32).toBe(parseInt(hash.slice(0, 8), 16));
    expect(back.dueAtMs).toBe(Date.UTC(2026, 9, 3, 17, 0, 0));
    // An all-ones hash at a far-future hour is still below 2^53.
    expect(Number.isSafeInteger(packPoolMemo('ffffffff', Date.UTC(2200, 0, 1))!)).toBe(true);
    expect(packPoolMemo(undefined, due)).toBeUndefined();
    expect(packPoolMemo('other', due)).toBeUndefined();
  });

  it('the jitter is deterministic per pool and stays inside ±25%', () => {
    const t = Date.UTC(2026, 0, 1);
    const factors = Array.from({ length: 200 }, (_, i) => (poolRewriteDueAt(`0x${i}`, t) - t) / POOL_REWRITE_MAX_AGE_MS);
    for (const f of factors) {
      expect(f).toBeGreaterThanOrEqual(1 - POOL_REWRITE_JITTER);
      expect(f).toBeLessThan(1 + POOL_REWRITE_JITTER);
    }
    expect(new Set(factors.map((f) => f.toFixed(3))).size).toBeGreaterThan(100);
    expect(poolRewriteDueAt('0xabc', t)).toBe(poolRewriteDueAt('0xabc', t));
  });
});

describe('fetchDayDataFor: truncation-safe at a 1,000-pool page', () => {
  const day = (d: number) => ({ date: String(d), volumeUSD: '1', feesUSD: '0.1', tvlUSD: '5' });

  it(`asks for ${DAY_DATA_MAX_ROWS} rows; a short answer is one request`, async () => {
    const pools = ids(1_000);
    for (const id of pools.slice(0, 50)) dayRows.set(id, [day(700), day(600)]);
    const out = await fetchDayDataFor({} as never, pools, 0);
    expect(dayCalls).toEqual([{ ids: pools, first: DAY_DATA_MAX_ROWS }]);
    expect(out.get(pools[0]!)).toHaveLength(2);
  });

  it('a FULL answer is split in halves until every request comes back short — no pool loses a day', async () => {
    const pools = ids(400);
    // 400 pools × 8 rows = 3,200 rows: a single capped request would drop the oldest days of most pools.
    for (const id of pools) dayRows.set(id, [800, 700, 600, 500, 400, 300, 200, 100].map(day));
    const out = await fetchDayDataFor({} as never, pools, 0);
    expect(dayCalls.length).toBeGreaterThan(1);
    expect(dayCalls.every((c) => c.first === DAY_DATA_MAX_ROWS)).toBe(true);
    for (const id of pools) {
      const rows = out.get(id)!;
      expect(rows.map((r) => r.date)).toEqual(['800', '700', '600', '500', '400', '300', '200']); // newest 7, newest first
    }
  });

  it('a single pool with a full page keeps its newest rows and is not split further', async () => {
    const one = ids(1);
    dayRows.set(one[0]!, Array.from({ length: 1_200 }, (_, i) => day(10_000 - i)));
    const out = await fetchDayDataFor({} as never, one, 0);
    expect(dayCalls).toHaveLength(1);
    expect(out.get(one[0]!)!.map((r) => r.date)).toEqual(['10000', '9999', '9998', '9997', '9996', '9995', '9994']);
  });
});
