import { describe, expect, it, vi } from 'vitest';
import { PoolsRepository, type PoolsLeaderboardQuery } from '../src/database/pools.repository.js';
import { QueryTimeoutException, USER_READ_PREFERENCE } from '../src/database/user-read.js';
import { LeaderboardCountService } from '../src/leaderboard/count-cache.js';
import { PoolsService } from '../src/pools/pools.service.js';

interface Call {
  op: string;
  filter: Record<string, unknown>;
  arg?: unknown;
  opts: Record<string, unknown>;
}

function fakePoolModel(handlers: { find?: (c: Call) => unknown; findOne?: (c: Call) => unknown; count?: number } = {}) {
  const calls: Call[] = [];
  const query = (op: string, filter: Record<string, unknown>, arg?: unknown) => {
    const call: Call = { op, filter, arg, opts: {} };
    calls.push(call);
    const run = async () => {
      if (op === 'find') return handlers.find ? handlers.find(call) : [];
      if (op === 'findOne') return handlers.findOne ? handlers.findOne(call) : null;
      return handlers.count ?? 0;
    };
    const q: Record<string, unknown> = {};
    for (const m of ['sort', 'skip', 'limit', 'read', 'maxTimeMS', 'hint', 'collation', 'select']) {
      q[m] = (v: unknown) => {
        call.opts[m] = v;
        return q;
      };
    }
    q.lean = run;
    q.exec = run;
    return q;
  };
  return {
    calls,
    model: {
      find: (f: Record<string, unknown>) => query('find', f),
      findOne: (f: Record<string, unknown>) => query('findOne', f),
      countDocuments: (f: Record<string, unknown>, o?: unknown) => query('count', f, o),
    },
  };
}

function makeRepo(handlers: Parameters<typeof fakePoolModel>[0] = {}, addresses: string[] = []) {
  const { model, calls } = fakePoolModel(handlers);
  const tokens = { readyLeaderboardExclusions: vi.fn(async () => ({ addresses, ok: true })) };
  return { repo: new PoolsRepository({ poolModel: () => model } as never, tokens as never), calls, tokens };
}

const q = (over: Partial<PoolsLeaderboardQuery> = {}): PoolsLeaderboardQuery => ({
  chainId: 1,
  protocol: 'uniswap-v4',
  sort: 'tvl',
  page: 1,
  limit: 20,
  minTvlUsd: 10_000,
  includeRisky: false,
  ...over,
});

const pool = (poolId: string) => ({ chainId: 1, protocol: 'uniswap-v4', poolId, metrics: { tvlUsd: 1 } });

describe('PoolsRepository read path', () => {
  it('reads a 50-row window + 1 with no collation, secondary-preferred, 5 s budget, and caches it', async () => {
    const rows = Array.from({ length: 51 }, (_, i) => pool(`0x${i}`));
    const { repo, calls } = makeRepo({ find: () => rows });
    const first = await repo.findPoolsLeaderboard(q());
    expect(first).toMatchObject({ hasMore: true, cache: 'miss' });
    expect(first.pools).toHaveLength(20);
    expect(calls[0].opts).toMatchObject({ skip: 0, limit: 51, read: USER_READ_PREFERENCE, maxTimeMS: 5_000 });
    expect(calls[0].opts.collation).toBeUndefined();
    expect((await repo.findPoolsLeaderboard(q({ page: 2 }))).cache).toBe('hit');
    expect(calls).toHaveLength(1);
  });

  it('keys searches apart (a RegExp must not collapse to {})', async () => {
    const { repo } = makeRepo();
    const a = await repo.poolsPlan(q({ search: 'usdc' }));
    const b = await repo.poolsPlan(q({ search: 'weth' }));
    expect(a.key).not.toBe(b.key);
    expect(a.countKey).not.toBe(b.countKey);
  });

  it('uses the merged exclusion set — and skips it for a search', async () => {
    const { repo, tokens } = makeRepo({}, ['0xbad']);
    const plan = await repo.poolsPlan(q());
    expect(plan.filter.$and).toEqual([{ 'token0.address': { $nin: ['0xbad'] }, 'token1.address': { $nin: ['0xbad'] } }]);
    await repo.poolsPlan(q({ search: 'x' }));
    expect(tokens.readyLeaderboardExclusions).toHaveBeenCalledTimes(1);
  });

  it('counts with the cap, secondary-preferred, 8 s budget', async () => {
    const { repo, calls } = makeRepo({ count: 7 });
    const plan = await repo.poolsPlan(q());
    expect(await repo.countPoolsLeaderboard(plan, 25_000)).toEqual({ count: 7, capped: false });
    expect(calls[0].arg).toEqual({ limit: 25_000 });
    expect(calls[0].opts).toMatchObject({ read: USER_READ_PREFERENCE, maxTimeMS: 8_000 });
  });

  it('a timeout with no retained window is a 503; pool detail too', async () => {
    const timeout = () => {
      throw Object.assign(new Error('x'), { code: 50 });
    };
    const { repo } = makeRepo({ find: timeout, findOne: timeout });
    await expect(repo.findPoolsLeaderboard(q())).rejects.toBeInstanceOf(QueryTimeoutException);
    await expect(repo.findPoolById(1, 'uniswap-v4', '0xabc')).rejects.toBeInstanceOf(QueryTimeoutException);
  });
});

describe('PoolsService', () => {
  const config = {
    isSupportedChain: () => true,
    isSupportedProtocol: () => true,
    leaderboardCountCap: 25_000,
    enabledIntegrations: [{ chainId: 1, protocol: 'uniswap-v4' }],
  };
  const poolDoc = (poolId: string) => ({
    poolId,
    chainId: 1,
    protocol: 'uniswap-v4',
    token0: { address: '0xaaaa' },
    token1: { address: '0xbbbb' },
    fee: 3000,
    metrics: { tvlUsd: 1, feeApr: 0 },
  });

  it('caches pool detail (with its holder counts) for 60 s', async () => {
    const findPoolById = vi.fn(async () => poolDoc('0xAbC'));
    const countsByPoolIds = vi.fn(async () => new Map([['0xabc', { positionsCount: 2, holdersCount: 1 }]]));
    const svc = new PoolsService(
      config as never,
      { findPoolById } as never,
      { countsByPoolIds } as never,
      { findLatestPrices: async () => new Map() } as never,
      new LeaderboardCountService(),
    );
    const meta: { cache?: string } = {};
    expect(await svc.getPool(1, 'uniswap-v4', '0xAbC', meta)).toMatchObject({ positionsCount: 2, holdersCount: 1 });
    expect(meta.cache).toBe('miss');
    await svc.getPool(1, 'uniswap-v4', '0xabc', meta);
    expect(meta.cache).toBe('hit');
    expect(findPoolById).toHaveBeenCalledTimes(1);
    expect(countsByPoolIds).toHaveBeenCalledTimes(1);
  });

  // The dynamic-fee flag is stored as the pool's `fee` (the indexer no longer
  // overwrites it with a swap's fee) and is served with `isDynamicFee: true`, so
  // no client has to format 8,388,608 pips as a 838.86% fee.
  it('labels a dynamic-fee pool: fee stays the 0x800000 flag and isDynamicFee is true; a static pool is not', async () => {
    const dynamic = { ...poolDoc('0xAbC'), fee: 0x800000 };
    const svc = new PoolsService(
      config as never,
      {
        findPoolById: async () => dynamic,
        findPoolsLeaderboard: async () => ({ pools: [dynamic, poolDoc('0xdef')], hasMore: false, cache: 'hit' }),
        poolsPlan: async () => ({ countKey: 'pk' }),
      } as never,
      { countsByPoolIds: async () => new Map() } as never,
      { findLatestPrices: async () => new Map() } as never,
      new LeaderboardCountService(),
    );
    expect(await svc.getPool(1, 'uniswap-v4', '0xAbC')).toMatchObject({ fee: 8_388_608, isDynamicFee: true });
    const list = await svc.getTopPools({ chainId: 1, protocol: 'uniswap-v4', page: 1, limit: 20 } as never);
    expect(list.pools.map((p: { fee: number; isDynamicFee: boolean }) => [p.fee, p.isDynamicFee])).toEqual([
      [8_388_608, true],
      [3000, false],
    ]);
  });

  it('detail: a read timeout serves the retained detail as stale; with none retained it is a 503', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      let timeOut = false;
      const findPoolById = vi.fn(async () => {
        if (timeOut) throw new QueryTimeoutException();
        return poolDoc('0xAbC');
      });
      const svc = new PoolsService(
        config as never,
        { findPoolById } as never,
        { countsByPoolIds: async () => new Map() } as never,
        { findLatestPrices: async () => new Map() } as never,
        new LeaderboardCountService(),
      );
      await svc.getPool(1, 'uniswap-v4', '0xAbC');
      timeOut = true;
      vi.setSystemTime(Date.now() + 3 * 60_000); // past the 2-min stale age, still retained
      const meta: { cache?: string } = {};
      expect(await svc.getPool(1, 'uniswap-v4', '0xAbC', meta)).toMatchObject({ poolId: '0xAbC' });
      expect(meta.cache).toBe('stale');
      await expect(svc.getPool(1, 'uniswap-v4', '0xOther')).rejects.toBeInstanceOf(QueryTimeoutException);
    } finally {
      vi.useRealTimers();
    }
  });

  it('detail: one whose counts are still being computed is served but not cached', async () => {
    const countsByPoolIds = vi.fn(async () => new Map([['0xabc', null]]));
    const svc = new PoolsService(
      config as never,
      { findPoolById: async () => poolDoc('0xAbC') } as never,
      { countsByPoolIds } as never,
      { findLatestPrices: async () => new Map() } as never,
      new LeaderboardCountService(),
    );
    expect(await svc.getPool(1, 'uniswap-v4', '0xAbC')).toMatchObject({ positionsCount: null, holdersCount: null });
    await svc.getPool(1, 'uniswap-v4', '0xAbC');
    expect(countsByPoolIds).toHaveBeenCalledTimes(2);
  });

  it('list: totalPending until counted; GET /count answers it', async () => {
    const pools = Array.from({ length: 20 }, (_, i) => poolDoc(`0x${i}`));
    const repo = {
      findPoolsLeaderboard: async () => ({ pools, hasMore: true, cache: 'hit' }),
      poolsPlan: async () => ({ countKey: 'pk' }),
      countPoolsLeaderboard: vi.fn(async () => ({ count: 900, capped: false })),
    };
    const svc = new PoolsService(
      config as never,
      repo as never,
      { countsByPoolIds: async () => new Map() } as never,
      { findLatestPrices: async () => new Map() } as never,
      new LeaderboardCountService(),
    );
    const list = await svc.getTopPools({ chainId: 1, protocol: 'uniswap-v4', page: 1, limit: 20 } as never);
    expect(list.pagination).toMatchObject({ total: null, totalPages: null, totalPending: true, hasMore: true });
    expect(await svc.getTopPoolsCount({ chainId: 1, protocol: 'uniswap-v4' } as never)).toEqual({
      total: 900,
      capped: false,
    });
    expect(repo.countPoolsLeaderboard).toHaveBeenCalledTimes(1);
  });
});
