import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The hook badge's backend, end to end through the REAL services (2026-10-06):
 *
 *   indexer `Pool.hooks` (mixed-case EIP-55; the zero address = none)
 *     → pools sync's `POOLS_QUERY` + upsert           (`hooks`, lower-case, absent when none)
 *     → the stored pool document
 *     → `PoolsService` list / detail rows              (`hooks`, `customAccounting`, additive)
 *   and, for POSITION rows (which carry no hook of their own):
 *     → `LeaderboardService` list / detail rows        (looked up by poolId from the pools collection)
 *
 * The example pool is Angstrom's USDC/WETH on Ethereum, as the live indexer
 * reports it (`1_0xe500210c…`, hook 0x0000000aa232009084Bd71A5797d089AA4Edfad4,
 * whose address sets AFTER_SWAP_RETURNS_DELTA).
 */

let universe: Array<Record<string, unknown>> = [];
let queries: string[] = [];

vi.mock('../src/subgraph/request-retry.js', () => ({
  requestWithRetry: async (_client: unknown, query: unknown, vars: Record<string, unknown>) => {
    const text = String(query);
    queries.push(text);
    if (text.includes('PoolDayMax')) return { poolDayDatas: [{ date: '1000000' }] };
    if (text.includes('PoolDayBatch')) return { poolDayDatas: [] };
    const where = (vars.where ?? {}) as { id_gt?: string };
    return { pools: universe.filter((p) => where.id_gt === undefined || String(p.id) > where.id_gt) };
  },
}));

import { PoolsRepository, poolContentHash, type PoolUpsert } from '../src/database/pools.repository.js';
import { QueryTimeoutException, USER_READ_PREFERENCE } from '../src/database/user-read.js';
import { LeaderboardCountService } from '../src/leaderboard/count-cache.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { PoolsService } from '../src/pools/pools.service.js';
import { buildRiskyPoolUpsert, PoolsSyncService } from '../src/sync/pools-sync.service.js';

const ANGSTROM_EIP55 = '0x0000000aa232009084Bd71A5797d089AA4Edfad4';
const ANGSTROM = ANGSTROM_EIP55.toLowerCase();
const PLAIN_HOOK = '0xcdf0049105D85B0A32D39D0EA7A99818733D80C0'; // 0xc0: beforeSwap + afterSwap — no returns-delta bit
const ZERO = '0x0000000000000000000000000000000000000000';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';

const ANGSTROM_POOL = '0xe500210c7ea6bfd9f69dce044b09ef384ec2b34832f132baec3b418208e3a657';
const PLAIN_POOL = `0x${'a'.repeat(64)}`;
const BARE_POOL = `0x${'b'.repeat(64)}`;
const DYNAMIC_POOL = `0x${'c'.repeat(64)}`;

/** A pool row exactly as `POOLS_QUERY` returns it (strings throughout). */
function indexerRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    token0: { id: USDC, symbol: 'USDC', decimals: '6' },
    token1: { id: WETH, symbol: 'WETH', decimals: '18' },
    feeTier: '500',
    tickSpacing: '10',
    tick: '10',
    sqrtPrice: '79228162514264337593543950336',
    liquidity: '1000',
    createdAtTimestamp: '1700000000',
    totalValueLockedToken0: '1',
    totalValueLockedToken1: '2',
    totalValueLockedUSD: '0',
    volumeUSD: '1000000',
    feesUSD: '1234.5',
    txCount: '3',
    token0Price: '1',
    token1Price: '1',
    ...over,
  };
}

async function sync(): Promise<PoolUpsert[]> {
  const written: PoolUpsert[] = [];
  const repo = {
    upsertMany: async (pools: PoolUpsert[]) => {
      written.push(...pools);
      return { written: pools.length, unchanged: 0, hashReads: 0 };
    },
  };
  const config = {
    getIntegration: () => ({ chainId: 1, protocol: 'uniswap-v4', subgraphUrl: 'http://indexer.test/graphql' }),
    poolsSyncIntervalMs: 6 * 3_600_000,
  };
  const pricing = {
    pricePool: async () => ({ token0Usd: 1, token1Usd: 2_000, source: 'test', usedFallback: false, token0Confidence: 'anchor', token1Confidence: 'anchor' }),
  };
  const svc = new PoolsSyncService(config as never, repo as never, pricing as never, { recordPoolWalk: async () => undefined } as never);
  (svc as unknown as { logger: unknown }).logger = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  await svc.syncPools(1, 'uniswap-v4');
  return written;
}

beforeEach(() => {
  universe = [];
  queries = [];
});

describe('pools sync: the pool document carries its hook', () => {
  it('asks the indexer for `hooks` on every pool page', async () => {
    universe = [indexerRow(ANGSTROM_POOL, { hooks: ANGSTROM_EIP55 })];
    await sync();
    const poolsQuery = queries.find((q) => q.includes('PoolsPage'))!;
    expect(poolsQuery).toMatch(/\bhooks\b/);
  });

  it('stores the hook lower-cased, and nothing at all for a pool without one', async () => {
    universe = [
      indexerRow(ANGSTROM_POOL, { hooks: ANGSTROM_EIP55 }),
      indexerRow(BARE_POOL, { hooks: ZERO }),
      indexerRow(PLAIN_POOL.replace(/a/g, 'd'), { hooks: null }),
      indexerRow(PLAIN_POOL.replace(/a/g, 'e')), // an indexer that does not report the column
    ];
    const out = await sync();
    const byId = new Map(out.map((p) => [p.poolId, p]));
    expect(byId.get(ANGSTROM_POOL)!.hooks).toBe(ANGSTROM);
    for (const pool of out.filter((p) => p.poolId !== ANGSTROM_POOL)) {
      expect(Object.hasOwn(pool, 'hooks'), pool.poolId).toBe(false);
    }
  });

  it('leaves a pool without a hook with the key set (and so the content hash) it had before the field existed — no rewrite wave', async () => {
    universe = [indexerRow(BARE_POOL, { hooks: ZERO }), indexerRow(PLAIN_POOL, {})];
    const [zeroHook, noColumn] = await sync();
    const keysBefore = [
      'chainId',
      'createdAtTimestamp',
      'currentTick',
      'fee',
      'liquidity',
      'metrics',
      'poolId',
      'pricing',
      'protocol',
      'sqrtPriceX96',
      'tickSpacing',
      'token0',
      'token1',
    ];
    expect(Object.keys(zeroHook!).sort()).toEqual(keysBefore);
    expect(Object.keys(noColumn!).sort()).toEqual(keysBefore);
    // the hash drops an undefined value, so an explicit `hooks: undefined` could not have moved it either
    expect(poolContentHash({ ...zeroHook!, hooks: undefined })).toBe(poolContentHash(zeroHook!));
    // a hooked pool DOES change: it is rewritten once, which is what stores the field
    expect(poolContentHash({ ...zeroHook!, hooks: ANGSTROM })).not.toBe(poolContentHash(zeroHook!));
  });

  it('the risky stub carries the hook too (a pool we refuse to price is still hooked)', () => {
    const stub = buildRiskyPoolUpsert(1, 'uniswap-v4', { ...indexerRow(ANGSTROM_POOL, { hooks: ANGSTROM_EIP55 }), poolDayData: [] } as never);
    expect(stub.hooks).toBe(ANGSTROM);
    const bare = buildRiskyPoolUpsert(1, 'uniswap-v4', { ...indexerRow(BARE_POOL, { hooks: ZERO }), poolDayData: [] } as never);
    expect(Object.hasOwn(bare, 'hooks')).toBe(false);
  });
});

const config = { isSupportedChain: () => true, isSupportedProtocol: () => true, enabledIntegrations: [], leaderboardCountCap: 25_000 };

/** The stored pool document an upsert becomes (what `findPoolsLeaderboard` / `findPoolById` return). */
const stored = (upsert: PoolUpsert) => ({ ...upsert, updatedAt: new Date('2026-10-06T00:00:00Z'), contentHash: 'x' });

describe('PoolsService: pool rows carry hooks / customAccounting', () => {
  it('serves a real hooked pool through the sync and the service, additively', async () => {
    universe = [
      indexerRow(ANGSTROM_POOL, { hooks: ANGSTROM_EIP55, feeTier: '0' }),
      indexerRow(PLAIN_POOL, { hooks: PLAIN_HOOK }),
      indexerRow(BARE_POOL, { hooks: ZERO }),
      indexerRow(DYNAMIC_POOL, { hooks: PLAIN_HOOK, feeTier: '8388608' }),
    ];
    const docs = (await sync()).map(stored);
    const pools = {
      findPoolsLeaderboard: async () => ({ pools: docs, hasMore: false, cache: 'miss', total: docs.length }),
      findPoolById: async (_c: number, _p: string, id: string) => docs.find((d) => d.poolId === id) ?? null,
    };
    const svc = new PoolsService(
      config as never,
      pools as never,
      { countsByPoolIds: async () => new Map() } as never,
      { findLatestPricesForRead: async () => new Map() } as never,
    );

    const list = await svc.getTopPools({ chainId: 1, protocol: 'uniswap-v4' } as never);
    const row = (id: string) => list.pools.find((p) => p.poolId === id) as Record<string, unknown>;

    expect(row(ANGSTROM_POOL)).toMatchObject({ hooks: ANGSTROM, customAccounting: true, fee: 0, isDynamicFee: false });
    expect(row(PLAIN_POOL)).toMatchObject({ hooks: PLAIN_HOOK.toLowerCase(), customAccounting: false });
    // A dynamic-fee pool still reads dynamic AND carries its hook.
    expect(row(DYNAMIC_POOL)).toMatchObject({ hooks: PLAIN_HOOK.toLowerCase(), isDynamicFee: true });
    // A pool without a hook has neither key.
    expect(Object.hasOwn(row(BARE_POOL), 'hooks')).toBe(false);
    expect(Object.hasOwn(row(BARE_POOL), 'customAccounting')).toBe(false);

    const detail = (await svc.getPool(1, 'uniswap-v4', ANGSTROM_POOL)) as Record<string, unknown>;
    expect(detail).toMatchObject({ poolId: ANGSTROM_POOL, hooks: ANGSTROM, customAccounting: true });
    const bare = (await svc.getPool(1, 'uniswap-v4', BARE_POOL)) as Record<string, unknown>;
    expect(Object.hasOwn(bare, 'hooks')).toBe(false);
  });

  it('a stored document without the field (every pool before the next walk) serves no hook keys', async () => {
    universe = [indexerRow(BARE_POOL)];
    const legacy = stored((await sync())[0]!);
    const pools = {
      findPoolsLeaderboard: async () => ({ pools: [legacy], hasMore: false, cache: 'miss', total: 1 }),
      findPoolById: async () => legacy,
    };
    const svc = new PoolsService(config as never, pools as never, { countsByPoolIds: async () => new Map() } as never, { findLatestPricesForRead: async () => new Map() } as never);
    const [row] = (await svc.getTopPools({ chainId: 1, protocol: 'uniswap-v4' } as never)).pools as unknown as Array<Record<string, unknown>>;
    expect(Object.hasOwn(row!, 'hooks')).toBe(false);
    expect(Object.hasOwn(row!, 'customAccounting')).toBe(false);
  });
});

describe('LeaderboardService: position rows carry their pool’s hook', () => {
  const position = (positionId: string, poolId: string) => ({
    chainId: 1,
    protocol: 'uniswap-v4',
    positionId,
    tokenId: positionId,
    poolId,
    token0: { address: USDC, symbol: 'USDC', priceUsd: 1 },
    token1: { address: WETH, symbol: 'WETH', priceUsd: 2000 },
    amounts: {},
    metrics: { underlyingValueUsd: 1000, isPriceable: true },
    poolStats: { tvlUsd: 5_000_000, tvlUsdUntracked: 5_000_000, volumeUsd: 1, totalFeesUsd: 1 },
    pricing: { source: 'external' },
  });
  const rows = [position('1', ANGSTROM_POOL), position('2', PLAIN_POOL), position('3', BARE_POOL), position('4', ANGSTROM_POOL)];
  const poolsDb: Record<string, string | undefined> = { [ANGSTROM_POOL]: ANGSTROM, [PLAIN_POOL]: PLAIN_HOOK.toLowerCase(), [BARE_POOL]: undefined };

  function build(poolsRepo: unknown) {
    const repo = {
      findLeaderboard: async () => ({ positions: rows, hasMore: false, cache: 'hit', total: rows.length }),
      findOneForRead: async (_c: number, _p: string, id: string) => rows.find((r) => r.positionId === id) ?? null,
    };
    return new LeaderboardService(
      { ...config, getIntegration: () => undefined } as never,
      repo as never,
      { findForPosition: async () => [] } as never,
      { resolve: () => ({ recomputeMode: 'per-tx' }) } as never,
      new LeaderboardCountService(),
      undefined,
      undefined,
      undefined,
      undefined,
      poolsRepo as never,
    );
  }

  function poolsRepoOver(db: Record<string, string | undefined>) {
    const calls: Array<{ chainId: number; protocol: string; poolIds: string[] }> = [];
    return {
      calls,
      findHooksByPoolIds: async (chainId: number, protocol: string, poolIds: string[]) => {
        calls.push({ chainId, protocol, poolIds: [...poolIds] });
        return poolIds.filter((id) => Object.hasOwn(db, id)).map((poolId) => ({ poolId, hooks: db[poolId] }));
      },
    };
  }

  it('list rows: hooks + customAccounting from ONE read of the pools collection; an unhooked pool has neither key', async () => {
    const poolsRepo = poolsRepoOver(poolsDb);
    const res = await build(poolsRepo).getTopPositions({ chainId: 1, protocol: 'uniswap-v4' } as never);
    const byId = new Map(res.positions.map((p) => [p.positionId, p as Record<string, unknown>]));

    expect(byId.get('1')).toMatchObject({ hooks: ANGSTROM, customAccounting: true });
    expect(byId.get('4')).toMatchObject({ hooks: ANGSTROM, customAccounting: true });
    expect(byId.get('2')).toMatchObject({ hooks: PLAIN_HOOK.toLowerCase(), customAccounting: false });
    expect(Object.hasOwn(byId.get('3')!, 'hooks')).toBe(false);
    expect(Object.hasOwn(byId.get('3')!, 'customAccounting')).toBe(false);

    // One `$in` on the shard with each distinct pool once — not a read per row.
    expect(poolsRepo.calls).toHaveLength(1);
    expect(poolsRepo.calls[0]!.poolIds.sort()).toEqual([ANGSTROM_POOL, BARE_POOL, PLAIN_POOL].sort());
  });

  it('a second page of the same pools reads nothing (a pool’s hook never changes)', async () => {
    const poolsRepo = poolsRepoOver(poolsDb);
    const svc = build(poolsRepo);
    await svc.getTopPositions({ chainId: 1, protocol: 'uniswap-v4' } as never);
    await svc.getTopPositions({ chainId: 1, protocol: 'uniswap-v4', page: 2 } as never);
    expect(poolsRepo.calls).toHaveLength(1);
  });

  it('detail carries the same fields', async () => {
    const svc = build(poolsRepoOver(poolsDb));
    const detail = (await svc.getPosition(1, 'uniswap-v4', '1')) as Record<string, unknown>;
    expect(detail).toMatchObject({ positionId: '1', hooks: ANGSTROM, customAccounting: true });
    const bare = (await svc.getPosition(1, 'uniswap-v4', '3')) as Record<string, unknown>;
    expect(Object.hasOwn(bare, 'hooks')).toBe(false);
  });

  it('a failed pools read serves the page without hook keys instead of failing it', async () => {
    const svc = build({
      findHooksByPoolIds: async () => {
        throw new Error('mongo down');
      },
    });
    const res = await svc.getTopPositions({ chainId: 1, protocol: 'uniswap-v4' } as never);
    expect(res.positions).toHaveLength(4);
    for (const p of res.positions) expect(Object.hasOwn(p, 'hooks')).toBe(false);
  });

  it('without a pools repository (a spec double) rows are exactly what they were', async () => {
    const res = await build(undefined).getTopPositions({ chainId: 1, protocol: 'uniswap-v4' } as never);
    for (const p of res.positions) {
      expect(Object.hasOwn(p, 'hooks')).toBe(false);
      expect(Object.hasOwn(p, 'customAccounting')).toBe(false);
    }
  });
});

describe('PoolsRepository.findHooksByPoolIds', () => {
  function repoOver(result: () => unknown) {
    const seen: { filter?: Record<string, unknown>; projection?: unknown; read?: unknown; maxTimeMS?: unknown } = {};
    const model = {
      find: (filter: Record<string, unknown>, projection: unknown) => {
        seen.filter = filter;
        seen.projection = projection;
        const q: Record<string, unknown> = {
          read: (v: unknown) => ((seen.read = v), q),
          maxTimeMS: (v: unknown) => ((seen.maxTimeMS = v), q),
          lean: async () => result(),
        };
        return q;
      },
    };
    return { repo: new PoolsRepository({ poolModel: () => model } as never, {} as never), seen };
  }

  it('is one `$in` on the unique key with a two-field projection, on the user read path', async () => {
    const { repo, seen } = repoOver(() => [{ poolId: ANGSTROM_POOL, hooks: ANGSTROM }]);
    const out = await repo.findHooksByPoolIds(1, 'uniswap-v4', [ANGSTROM_POOL.toUpperCase().replace('0X', '0x'), PLAIN_POOL]);
    expect(out).toEqual([{ poolId: ANGSTROM_POOL, hooks: ANGSTROM }]);
    expect(seen.filter).toEqual({ chainId: 1, protocol: 'uniswap-v4', poolId: { $in: [ANGSTROM_POOL, PLAIN_POOL] } });
    expect(seen.projection).toEqual({ _id: 0, poolId: 1, hooks: 1 });
    expect(seen.read).toBe(USER_READ_PREFERENCE);
    expect(seen.maxTimeMS).toBe(5_000);
  });

  it('reads nothing for no ids', async () => {
    const { repo, seen } = repoOver(() => {
      throw new Error('should not read');
    });
    expect(await repo.findHooksByPoolIds(1, 'uniswap-v4', [])).toEqual([]);
    expect(seen.filter).toBeUndefined();
  });

  it('answers a server-side timeout as the 503 exception', async () => {
    const { repo } = repoOver(() => {
      throw Object.assign(new Error('operation exceeded time limit'), { code: 50 });
    });
    await expect(repo.findHooksByPoolIds(1, 'uniswap-v4', [ANGSTROM_POOL])).rejects.toBeInstanceOf(QueryTimeoutException);
  });
});
