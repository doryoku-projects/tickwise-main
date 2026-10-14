import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PageLadderService } from '../src/common/cache/page-ladder.js';
import { readPathSnapshot, resetReadPathMeter } from '../src/common/cache/read-path-meter.js';
import { ReadBudgetService } from '../src/common/read-budget.js';
import { PoolsRepository, type PoolsLeaderboardQuery } from '../src/database/pools.repository.js';
import { LIST_PROJECTION, PositionsRepository, type LeaderboardQuery } from '../src/database/positions.repository.js';
import { observeHeartbeat, resetReplicationLag } from '../src/database/replication-lag.js';
import { QueryTimeoutException } from '../src/database/user-read.js';
import { LeaderboardCountService } from '../src/leaderboard/count-cache.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { PoolsService } from '../src/pools/pools.service.js';
import { matches, miniModel, mongoCompare, prng, type Doc } from './support/mini-mongo.js';

/**
 * Deep pages end to end: the real repositories and services over in-memory
 * shards that follow MongoDB's matching and sorting rules (`mini-mongo`),
 * compared with a naive "filter every row, sort it all, slice" reference.
 * No depth cap: pages far past the old 1,000-row window, past the end, from
 * ladder rungs, and with a shard down.
 */

const CHAINS = [1, 4663, 42161];
const PROTO = 'uniswap-v4';

function at(doc: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((cur, key) => (cur && typeof cur === 'object' ? (cur as Doc)[key] : undefined), doc);
}

/** Positions with heavy ties, nulls and missing metrics; positionIds shared across chains. */
function positions(seed: number, perChain: number): Map<number, Doc[]> {
  const rand = prng(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
  const out = new Map<number, Doc[]>();
  for (const chainId of CHAINS) {
    const docs: Doc[] = [];
    for (let i = 0; i < perChain; i++) {
      const id = String(1 + i * 2 + (chainId === 4663 ? 1 : 0)); // overlapping ranges across chains
      const active = rand() < 0.8;
      const metrics: Doc = {
        aprExGas: pick([null, 0, 1, 5, 5, 12.5, 40, 900, -3]),
        feeApr: pick([0, 2, 2, 7]),
        roi: pick([0, 0.5, 1, -0.2]),
        poolPnlUsd: pick([null, -10, 0, 0, 3, 100]),
        underlyingValueUsd: pick([0, 0, 50, 600, 600, 1_500, 25_000]),
        inRange: rand() < 0.7,
        performanceReady: rand() < 0.9,
      };
      if (rand() < 0.05) delete metrics.aprExGas; // missing sorts with null
      docs.push({
        chainId,
        protocol: PROTO,
        positionId: id,
        tokenId: id,
        isActive: active,
        createdAtTimestamp: pick([1_700_000_000, 1_700_000_100, 1_700_000_100, 1_700_000_200]),
        metrics,
        poolStats: { tvlUsd: pick([0, 500, 5_000, 1e6]) },
        pricing: { source: pick(['dex', 'dex', 'none']), usedFallback: rand() < 0.1 },
        token0: { address: pick(['0xaaa', '0xbad', '0xccc']) },
        token1: { address: '0xddd' },
      });
    }
    out.set(chainId, docs);
  }
  return out;
}

function positionsRepo(data: Map<number, Doc[]>, opts: { failing?: number; ladder?: PageLadderService; budget?: ReadBudgetService } = {}) {
  const models = new Map(
    [...data].map(([chainId, docs]) => [
      chainId,
      miniModel(docs, chainId === opts.failing ? { fail: () => Object.assign(new Error('shard down'), { name: 'MongoNetworkError' }) } : {}),
    ]),
  );
  const tokens = { readyLeaderboardExclusions: async () => ({ addresses: ['0xbad'], ok: true }) };
  const repo = new PositionsRepository(
    { positionModel: (chainId: number) => models.get(chainId)!.model } as never,
    tokens as never,
    undefined,
    opts.ladder,
    opts.budget,
  );
  return { repo, models };
}

const query = (over: Partial<LeaderboardQuery> = {}): LeaderboardQuery => ({
  chainId: 1,
  protocol: PROTO,
  sort: 'apr',
  page: 1,
  limit: 25,
  activeOnly: true,
  status: 'active',
  range: 'all',
  minValueUsd: 0,
  minPoolTvl: 0,
  includeRisky: true,
  ...over,
});

/** The naive reference: every chain's matches, sorted by Mongo's rules, merged (chainId last), sliced. */
async function expectedPositions(repo: PositionsRepository, data: Map<number, Doc[]>, q: LeaderboardQuery, chains = CHAINS) {
  const plans = await Promise.all(chains.map((chainId) => repo.leaderboardPlan({ ...q, chainId })));
  const head = plans[0]!;
  const rows = plans.flatMap((plan) => data.get(plan.chainId)!.filter((doc) => matches(doc, plan.filter, true)));
  rows.sort((a, b) => {
    const byField = mongoCompare(at(a, head.sortField), at(b, head.sortField), true) * head.sortDirection;
    if (byField !== 0) return byField;
    const byId = mongoCompare(a.positionId, b.positionId, true) * head.tieDirection;
    if (byId !== 0) return byId;
    return (a.chainId as number) - (b.chainId as number);
  });
  const skip = (q.page - 1) * q.limit;
  return { page: rows.slice(skip, skip + q.limit).map((d) => `${d.chainId}:${d.positionId}`), total: rows.length, more: rows.length > skip + q.limit };
}

const ids = (rows: Array<{ chainId: number; positionId: string }>) => rows.map((r) => `${r.chainId}:${r.positionId}`);

beforeEach(() => resetReadPathMeter());

describe('positions: all-chains deep pages equal the naive merged order, at any depth', () => {
  const data = positions(5, 1_400);

  for (const sort of ['apr', 'pnl', 'age', 'nft_id_desc', 'nft_id_asc', 'underlying_value']) {
    it(`sort=${sort}: sequential and jumping deep pages, from rungs and from the top`, async () => {
      const ladder = new PageLadderService();
      const { repo } = positionsRepo(data, { ladder });
      for (const page of [41, 42, 43, 80, 60, 61, 1_000]) {
        const q = query({ sort, page, status: sort === 'pnl' ? 'all' : 'active', activeOnly: sort !== 'pnl' });
        const want = await expectedPositions(repo, data, q);
        const got = await repo.findLeaderboardDeep(CHAINS.map((chainId) => ({ ...q, chainId })));
        expect(ids(got.positions as never), `page ${page}`).toEqual(want.page);
        expect(got.hasMore).toBe(want.more);
        expect(got.missingChains).toEqual([]);
        if (!got.hasMore && got.positions.length < q.limit) expect(got.total).toBe(want.total);
      }
      // Sequential paging started from the previous page's boundary.
      expect(readPathSnapshot().deepWalks.fromRung).toBeGreaterThan(0);
    });
  }

  it('applies the whole visibility filter (exclusions, guards, floors) exactly as the windows do', async () => {
    const { repo } = positionsRepo(data);
    const q = query({ sort: 'apr', page: 45, includeRisky: false, minValueUsd: 500, minPoolTvl: 1000, range: 'in' });
    const want = await expectedPositions(repo, data, q);
    const got = await repo.findLeaderboardDeep(CHAINS.map((chainId) => ({ ...q, chainId })));
    expect(ids(got.positions as never)).toEqual(want.page);
  });

  it('single chain: a deep page through findLeaderboard is the same walk (no Mongo skip)', async () => {
    const { repo, models } = positionsRepo(data);
    const q = query({ sort: 'age', page: 50, chainId: 4663 });
    const want = await expectedPositions(repo, data, q, [4663]);
    const page = await repo.findLeaderboard(q);
    expect(ids(page.positions as never)).toEqual(want.page);
    expect(models.get(4663)!.calls.every((call) => call.opts.skip === undefined)).toBe(true);
  });

  it('a shard that fails is dropped: the page is the other chains\' merged order, flagged missing', async () => {
    const { repo } = positionsRepo(data, { failing: 42161 });
    const q = query({ sort: 'apr', page: 45 });
    const want = await expectedPositions(repo, data, q, [1, 4663]);
    const got = await repo.findLeaderboardDeep(CHAINS.map((chainId) => ({ ...q, chainId })));
    expect(got.missingChains).toEqual([42161]);
    expect(ids(got.positions as never)).toEqual(want.page);
  });

  it('every shard failing is a 503 (QueryTimeoutException on a timeout), never an empty 200', async () => {
    const models = new Map(CHAINS.map((c) => [c, miniModel([], { fail: () => Object.assign(new Error('x'), { code: 50 }) })]));
    const repo = new PositionsRepository(
      { positionModel: (c: number) => models.get(c)!.model } as never,
      { readyLeaderboardExclusions: async () => ({ addresses: [], ok: true }) } as never,
    );
    await expect(repo.findLeaderboardDeep(CHAINS.map((chainId) => query({ chainId, page: 50 })))).rejects.toBeInstanceOf(
      QueryTimeoutException,
    );
  });

  it('the walk answering but every page-document read failing is an error, not an empty 200', async () => {
    const models = new Map(
      [...data].map(([chainId, docs]) => [
        chainId,
        miniModel(docs, {
          fail: (call) => (call.filter.positionId ? Object.assign(new Error('x'), { code: 50 }) : undefined),
        }),
      ]),
    );
    const repo = new PositionsRepository(
      { positionModel: (c: number) => models.get(c)!.model } as never,
      { readyLeaderboardExclusions: async () => ({ addresses: [], ok: true }) } as never,
    );
    await expect(repo.findLeaderboardDeep(CHAINS.map((chainId) => query({ chainId, page: 45 })))).rejects.toBeInstanceOf(
      QueryTimeoutException,
    );
  });

  it('a chain whose page-document fetch keeps failing is dropped and the page RE-ANCHORED on the others (no holes)', async () => {
    const models = new Map(
      [...data].map(([chainId, docs]) => [
        chainId,
        miniModel(docs, {
          // The walk (sort keys) answers; the by-id fetch of 4663's rows fails every time.
          fail: (call) => (chainId === 4663 && call.filter.positionId ? Object.assign(new Error('x'), { code: 50 }) : undefined),
        }),
      ]),
    );
    const repo = new PositionsRepository(
      { positionModel: (c: number) => models.get(c)!.model } as never,
      { readyLeaderboardExclusions: async () => ({ addresses: ['0xbad'], ok: true }) } as never,
    );
    // Page 42 (rows 1,025–1,049): deep, and inside the two remaining chains' 1,081 rows.
    const q = query({ sort: 'apr', page: 42 });
    const want = await expectedPositions(repo, data, q, [1, 42161]);
    const got = await repo.findLeaderboardDeep(CHAINS.map((chainId) => ({ ...q, chainId })));
    expect(got.missingChains).toEqual([4663]);
    // A FULL page of the other chains' merged order — the same page a walk-time drop gives —
    // not the three-chain page with 4663's rows cut out of it (fewer rows, wrong ranks).
    expect(ids(got.positions as never)).toEqual(want.page);
    expect(got.positions).toHaveLength(25);
    // Asked twice (one retry) before it was dropped.
    expect(models.get(4663)!.calls.filter((c) => c.filter.positionId).length).toBe(2);
  });

  it('…and an exhausted re-anchored walk reports the total of the chains on the page only', async () => {
    const models = new Map(
      [...data].map(([chainId, docs]) => [
        chainId,
        miniModel(docs, {
          fail: (call) => (chainId === 4663 && call.filter.positionId ? Object.assign(new Error('x'), { code: 50 }) : undefined),
        }),
      ]),
    );
    const repo = new PositionsRepository(
      { positionModel: (c: number) => models.get(c)!.model } as never,
      { readyLeaderboardExclusions: async () => ({ addresses: ['0xbad'], ok: true }) } as never,
    );
    const others = await expectedPositions(repo, data, query({ sort: 'apr', page: 1 }), [1, 42161]);
    const lastPage = Math.ceil(others.total / 25);
    const q = query({ sort: 'apr', page: lastPage });
    const got = await repo.findLeaderboardDeep(CHAINS.map((chainId) => ({ ...q, chainId })));
    expect(got.missingChains).toEqual([4663]);
    expect(got.hasMore).toBe(false);
    expect(got.total).toBe(others.total);
  });

  it('reads through the global read budget (lane deep), and the long walk holds a slot', async () => {
    const budget = new ReadBudgetService({ readBudgetDocsPerSec: 1_000_000, readBudgetBurstDocs: 1_000_000, leaderboardDeepWalkConcurrency: 1 } as never);
    const reserve = vi.spyOn(budget, 'reserve');
    const walkSlot = vi.spyOn(budget, 'walkSlot');
    const { repo } = positionsRepo(data, { budget });
    await repo.findLeaderboardDeep(CHAINS.map((chainId) => query({ chainId, page: 100 })));
    expect(reserve.mock.calls.every(([, opts]) => opts.lane === 'deep')).toBe(true);
    // Reserved before reading, in slices: at least every row the walk read.
    const walked = readPathSnapshot().deepWalks.rows;
    expect(walked).toBeGreaterThan(1_000);
    expect(reserve.mock.calls.reduce((sum, [rows]) => sum + rows, 0)).toBeGreaterThanOrEqual(walked);
    expect(walkSlot).toHaveBeenCalledTimes(1);
  });

  it('identical concurrent deep requests share one walk', async () => {
    const { repo, models } = positionsRepo(data);
    const qs = CHAINS.map((chainId) => query({ chainId, page: 47 }));
    const [a, b] = await Promise.all([repo.findLeaderboardDeep(qs), repo.findLeaderboardDeep(qs)]);
    expect(ids(a.positions as never)).toEqual(ids(b.positions as never));
    const walks = [...models.values()].flatMap((m) => m.calls).filter((c) => c.opts.batchSize !== undefined);
    expect(walks.length).toBeLessThanOrEqual(CHAINS.length * 4); // one walk's segments, not two walks'
  });
});

describe('LeaderboardService: all-chains deep pages and partial pages', () => {
  const data = positions(6, 2_000);
  const config = {
    isSupportedChain: () => true,
    isSupportedProtocol: () => true,
    leaderboardCountCap: 25_000,
    enabledIntegrations: CHAINS.map((chainId) => ({ chainId, protocol: PROTO })),
  };

  it('a deep all-chains page is ONE streaming merge — no page × limit read per shard — with the right ranks', async () => {
    const { repo, models } = positionsRepo(data);
    const svc = new LeaderboardService(config as never, repo as never, {} as never, {} as never, new LeaderboardCountService());
    const res = await svc.getTopPositions({ protocol: PROTO, page: 60, limit: 25, sort: 'apr', status: 'active', range: 'all', minValueUsd: 0, minPoolTvl: 0, includeRisky: true, activeOnly: true } as never);
    const want = await expectedPositions(repo, data, query({ page: 60 }));
    expect(want.page).toHaveLength(25);
    expect(ids(res.positions)).toEqual(want.page);
    expect(res.positions[0]!.rank).toBe(59 * 25 + 1);
    // The old path read page × limit + 1 = 1,501 WHOLE documents from every shard.
    for (const { calls } of models.values()) {
      // Whole documents are read only for the page's own rows, by id.
      const wholeDocReads = calls.filter((c) => c.opts.select === LIST_PROJECTION);
      expect(wholeDocReads.length).toBeLessThanOrEqual(1);
      for (const read of wholeDocReads) expect((read.filter.positionId as { $in: string[] }).$in.length).toBeLessThanOrEqual(25);
      // Everything else streamed sort keys only.
      for (const walk of calls.filter((c) => c.op === 'find' && c.opts.select !== LIST_PROJECTION)) {
        expect(Object.keys(walk.opts.select as object).sort()).toEqual(['_id', 'metrics.aprExGas', 'positionId']);
      }
    }
    expect(res).not.toHaveProperty('partial');
  });

  it('shallow all-chains page with one shard down: partial + missingChains, the rest merged, counts only for them', async () => {
    const { repo } = positionsRepo(data, { failing: 4663 });
    const countLeaderboard = vi.spyOn(repo, 'countLeaderboard').mockResolvedValue({ count: 10, capped: false });
    const svc = new LeaderboardService(config as never, repo as never, {} as never, {} as never, new LeaderboardCountService());
    const meta: { noStore?: boolean } = {};
    const res = await svc.getTopPositions(
      { protocol: PROTO, page: 2, limit: 25, sort: 'apr', status: 'active', range: 'all', minValueUsd: 0, minPoolTvl: 0, includeRisky: true, activeOnly: true } as never,
      { meta, countWaitMs: 1_000 },
    );
    const want = await expectedPositions(repo, data, query({ page: 2 }), [1, 42161]);
    expect(res).toMatchObject({ partial: true, missingChains: [4663] });
    expect(ids(res.positions)).toEqual(want.page);
    expect(meta.noStore).toBe(true);
    // The total describes the chains on the page: the failed shard's count is never asked for.
    expect(countLeaderboard.mock.calls.map(([plan]) => plan.chainId).sort()).toEqual([1, 42161]);
    expect(readPathSnapshot().partialServed.positions).toBe(1);
  });

  it('a deep page read from a secondary lagging past the budget is flagged stale + dataAsOf (no-store)', async () => {
    const now = Date.now();
    observeHeartbeat('p:1', { isWritablePrimary: true, lastWrite: { lastWriteDate: new Date(now) } }, now, 10_000);
    observeHeartbeat('s:2', { secondary: true, lastWrite: { lastWriteDate: new Date(now - 90_000) } }, now, 10_000);
    try {
      const { repo } = positionsRepo(data);
      const svc = new LeaderboardService(config as never, repo as never, {} as never, {} as never, new LeaderboardCountService());
      const meta: { noStore?: boolean } = {};
      const res = await svc.getTopPositions(
        { protocol: PROTO, page: 60, limit: 25, sort: 'apr', status: 'active', range: 'all', minValueUsd: 0, minPoolTvl: 0, includeRisky: true, activeOnly: true } as never,
        { meta },
      );
      expect(res).toMatchObject({ stale: true });
      expect(Date.parse((res as { dataAsOf: string }).dataAsOf)).toBeLessThanOrEqual(Date.now() - 90_000);
      expect(meta.noStore).toBe(true);
    } finally {
      resetReplicationLag();
    }
  });

  it('every shard down is still an error (the first shard\'s), not an empty partial page', async () => {
    const models = new Map(CHAINS.map((c) => [c, miniModel([], { fail: () => Object.assign(new Error('x'), { code: 50 }) })]));
    const repo = new PositionsRepository(
      { positionModel: (c: number) => models.get(c)!.model } as never,
      { readyLeaderboardExclusions: async () => ({ addresses: [], ok: true }) } as never,
    );
    const svc = new LeaderboardService(config as never, repo as never, {} as never, {} as never, new LeaderboardCountService());
    await expect(svc.getTopPositions({ protocol: PROTO, page: 1, limit: 25, sort: 'apr' } as never)).rejects.toBeInstanceOf(
      QueryTimeoutException,
    );
  });
});

describe('pools: deep pages (uncollated, poolId tie plain lexicographic) and partial pages', () => {
  function pools(seed: number, perChain: number): Map<number, Doc[]> {
    const rand = prng(seed);
    const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
    const out = new Map<number, Doc[]>();
    for (const chainId of CHAINS) {
      const docs: Doc[] = [];
      for (let i = 0; i < perChain; i++) {
        docs.push({
          chainId,
          protocol: PROTO,
          // '0x9' > '0x10' in plain order — the collated order would differ.
          poolId: `0x${(i * 7 + (chainId % 5)).toString(16)}`,
          createdAtTimestamp: pick([1, 2, 2, 3]),
          metrics: {
            tvlUsd: pick([0, 0, 10, 10, 5_000, 2e6]),
            volumeUsd24h: pick([null, 0, 1, 1, 50]),
            feesUsd24h: pick([0, 3]),
            feeApr: pick([null, 0, 9]),
          },
          pricing: { source: pick(['dex', 'none']), usedFallback: rand() < 0.1 },
          token0: { address: pick(['0xaaa', '0xbad']), symbol: 'A' },
          token1: { address: '0xccc', symbol: 'B' },
        });
      }
      out.set(chainId, docs);
    }
    return out;
  }
  const data = pools(9, 1_300);

  function repoFor(failing?: number, ladder?: PageLadderService) {
    const models = new Map(
      [...data].map(([chainId, docs]) => [chainId, miniModel(docs, chainId === failing ? { fail: () => new Error('down') } : {})]),
    );
    const repo = new PoolsRepository(
      { poolModel: (c: number) => models.get(c)!.model } as never,
      { readyLeaderboardExclusions: async () => ({ addresses: ['0xbad'], ok: true }) } as never,
      undefined,
      ladder,
    );
    return { repo, models };
  }

  async function expectedPools(repo: PoolsRepository, q: PoolsLeaderboardQuery, chains = CHAINS) {
    const plans = await Promise.all(chains.map((chainId) => repo.poolsPlan({ ...q, chainId })));
    const head = plans[0]!;
    const rows = plans.flatMap((plan) => data.get(plan.chainId)!.filter((doc) => matches(doc, plan.filter, false)));
    rows.sort((a, b) => {
      const byField = mongoCompare(at(a, head.sortField), at(b, head.sortField), false) * head.sortDirection;
      if (byField !== 0) return byField;
      const byId = mongoCompare(a.poolId, b.poolId, false);
      if (byId !== 0) return byId;
      return (a.chainId as number) - (b.chainId as number);
    });
    const skip = (q.page - 1) * q.limit;
    return rows.slice(skip, skip + q.limit).map((d) => `${d.chainId}:${d.poolId}`);
  }

  const q = (over: Partial<PoolsLeaderboardQuery> = {}): PoolsLeaderboardQuery => ({
    chainId: 1,
    protocol: PROTO,
    sort: 'tvl',
    page: 1,
    limit: 20,
    minTvlUsd: 0,
    includeRisky: true,
    ...over,
  });

  for (const sort of ['tvl', 'volume', 'fee_apr', 'age']) {
    it(`sort=${sort}: deep all-chains pages, sequential and jumping, equal the naive order`, async () => {
      const { repo } = repoFor(undefined, new PageLadderService());
      for (const page of [51, 52, 90, 70, 150]) {
        const query = q({ sort, page });
        const got = await repo.findPoolsLeaderboardDeep(CHAINS.map((chainId) => ({ ...query, chainId })));
        expect(got.pools.map((p) => `${p.chainId}:${p.poolId}`), `page ${page}`).toEqual(await expectedPools(repo, query));
      }
    });
  }

  it('the PoolsService all-chains deep page and a partial shallow page', async () => {
    const config = {
      isSupportedChain: () => true,
      isSupportedProtocol: () => true,
      leaderboardCountCap: 25_000,
      enabledIntegrations: CHAINS.map((chainId) => ({ chainId, protocol: PROTO })),
    };
    const positions = { countsByPoolIds: async () => new Map() };
    const tokens = { findLatestPrices: async () => new Map() };
    const healthy = new PoolsService(config as never, repoFor().repo as never, positions as never, tokens as never, new LeaderboardCountService());
    const deep = await healthy.getTopPools({ protocol: PROTO, page: 80, limit: 20, sort: 'tvl', minTvlUsd: 0, includeRisky: true } as never);
    expect(deep.pools.map((p) => `${p.chainId}:${p.poolId}`)).toEqual(await expectedPools(repoFor().repo, q({ page: 80 })));
    expect(deep.pools[0]!.rank).toBe(79 * 20 + 1);

    const { repo: broken } = repoFor(42161);
    const countPools = vi.spyOn(broken, 'countPoolsLeaderboard').mockResolvedValue({ count: 50, capped: false });
    const meta: { noStore?: boolean } = {};
    const partial = await new PoolsService(config as never, broken as never, positions as never, tokens as never, new LeaderboardCountService()).getTopPools(
      { protocol: PROTO, page: 1, limit: 20, sort: 'tvl', minTvlUsd: 0, includeRisky: true } as never,
      { meta, countWaitMs: 1_000 },
    );
    expect(partial).toMatchObject({ partial: true, missingChains: [42161] });
    expect(partial.pools.map((p) => `${p.chainId}:${p.poolId}`)).toEqual(await expectedPools(broken, q({ page: 1 }), [1, 4663]));
    // A partial page is never stored by a cache in front of the API…
    expect(meta.noStore).toBe(true);
    // …and its total counts only the chains that answered (the failed shard's count is never asked for).
    expect(countPools.mock.calls.map(([plan]) => plan.chainId).sort()).toEqual([1, 4663]);
    expect(partial.pagination.total).toBe(100);
  });

  it('a deep pools page under a lagging secondary is flagged stale too', async () => {
    const config = {
      isSupportedChain: () => true,
      isSupportedProtocol: () => true,
      leaderboardCountCap: 25_000,
      enabledIntegrations: CHAINS.map((chainId) => ({ chainId, protocol: PROTO })),
    };
    const now = Date.now();
    observeHeartbeat('p:1', { isWritablePrimary: true, lastWrite: { lastWriteDate: new Date(now) } }, now, 10_000);
    observeHeartbeat('s:2', { secondary: true, lastWrite: { lastWriteDate: new Date(now - 90_000) } }, now, 10_000);
    try {
      const svc = new PoolsService(config as never, repoFor().repo as never, { countsByPoolIds: async () => new Map() } as never, { findLatestPrices: async () => new Map() } as never, new LeaderboardCountService());
      const res = await svc.getTopPools({ protocol: PROTO, page: 80, limit: 20, sort: 'tvl', minTvlUsd: 0, includeRisky: true } as never);
      expect(res).toMatchObject({ stale: true });
    } finally {
      resetReplicationLag();
    }
  });

  it('a pools page\'s holder counts failing for one shard leave those pools null, not the page a 5xx', async () => {
    const config = {
      isSupportedChain: () => true,
      isSupportedProtocol: () => true,
      leaderboardCountCap: 25_000,
      enabledIntegrations: [{ chainId: 1, protocol: PROTO }],
    };
    const positionsRepo = { countsByPoolIds: async () => Promise.reject(new Error('aggregate failed')) };
    const svc = new PoolsService(config as never, repoFor().repo as never, positionsRepo as never, { findLatestPrices: async () => new Map() } as never);
    const res = await svc.getTopPools({ chainId: 1, protocol: PROTO, page: 1, limit: 5, sort: 'tvl', minTvlUsd: 0, includeRisky: true } as never);
    expect(res.countsPending).toBe(true);
    expect(res.pools.every((p) => p.positionsCount === null)).toBe(true);
  });
});
