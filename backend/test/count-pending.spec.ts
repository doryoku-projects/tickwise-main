import { beforeEach, describe, expect, it, vi } from 'vitest';
import { withReadHeaders } from '../src/common/cache/read-headers.js';
import { readPathSnapshot, resetReadPathMeter } from '../src/common/cache/read-path-meter.js';
import { ReadBudgetService, ReadBudgetTimeoutError } from '../src/common/read-budget.js';
import { QueryTimeoutException } from '../src/database/user-read.js';
import {
  CountQueueFullError,
  countPendingReason,
  LeaderboardCountService,
  resolveCountRoute,
  resolveListPagination,
} from '../src/leaderboard/count-cache.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { PoolsService } from '../src/pools/pools.service.js';

const PENDING = { total: null, capped: false, pending: true };

const config = {
  isSupportedChain: () => true,
  isSupportedProtocol: () => true,
  leaderboardCountCap: 25_000,
  enabledIntegrations: [
    { chainId: 1, protocol: 'uniswap-v4' },
    { chainId: 42161, protocol: 'uniswap-v4' },
  ],
};

function positionsService(countLeaderboard: () => Promise<{ count: number; capped: boolean }>, plan?: () => Promise<unknown>) {
  const positions = {
    leaderboardPlan: plan ?? (async ({ chainId }: { chainId: number }) => ({ countKey: `k${chainId}` })),
    countLeaderboard,
  };
  return new LeaderboardService(
    config as never,
    positions as never,
    {} as never,
    {} as never,
    new LeaderboardCountService(),
  );
}

function poolsService(countPoolsLeaderboard: () => Promise<{ count: number; capped: boolean }>) {
  const pools = { poolsPlan: async ({ chainId }: { chainId: number }) => ({ countKey: `p${chainId}` }), countPoolsLeaderboard };
  return new PoolsService(config as never, pools as never, {} as never, {} as never, new LeaderboardCountService());
}

beforeEach(() => resetReadPathMeter());

describe('the /count routes never 5xx', () => {
  const failures: Array<[string, () => unknown, string]> = [
    ['CountQueueFullError', () => new CountQueueFullError(), 'queue_full'],
    ['QueryTimeoutException (the 8 s maxTimeMS)', () => new QueryTimeoutException(), 'timeout'],
    ['ReadBudgetTimeoutError (no global budget before the deadline)', () => new ReadBudgetTimeoutError('count', 900), 'budget'],
    ['a Redis error (ioredis ReplyError)', () => Object.assign(new Error('READONLY'), { name: 'ReplyError' }), 'redis'],
    ['a Mongo network error', () => Object.assign(new Error('socket'), { name: 'MongoNetworkError' }), 'mongo'],
    ['anything else', () => new TypeError('boom'), 'error'],
  ];

  for (const [name, make, reason] of failures) {
    it(`positions: ${name} → 200 {total: null, capped: false, pending: true}`, async () => {
      const svc = positionsService(async () => Promise.reject(make()));
      const headers: Record<string, string> = {};
      const res = await withReadHeaders({ setHeader: (k, v) => (headers[k] = v) }, (meta) =>
        svc.getTopPositionsCount({ protocol: 'uniswap-v4' } as never, meta),
      );
      expect(res).toEqual(PENDING);
      expect(headers['Cache-Control']).toBe('no-store'); // a pending answer is never cached
      expect(readPathSnapshot().countPending[`positions:${reason}`]).toBe(1);
    });

    it(`pools: ${name} → pending`, async () => {
      const svc = poolsService(async () => Promise.reject(make()));
      expect(await svc.getTopPoolsCount({ protocol: 'uniswap-v4' } as never)).toEqual(PENDING);
    });
  }

  it('a count still running after the route\'s wait answers pending, and lands in the cache for the re-poll', async () => {
    vi.useFakeTimers();
    try {
      let finish!: (v: { count: number; capped: boolean }) => void;
      const count = vi.fn(() => new Promise<{ count: number; capped: boolean }>((r) => (finish = r)));
      const counts = new LeaderboardCountService();
      const task = { key: 'k', run: count };
      const first = resolveCountRoute({ route: 'positions', counts, tasks: async () => [task] });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await first).toEqual(PENDING);
      expect(readPathSnapshot().countPending['positions:wait']).toBe(1);
      finish({ count: 26_000, capped: true });
      await vi.advanceTimersByTimeAsync(0);
      // The re-poll gets the number, and the 25k cap + capped are unchanged.
      expect(await resolveCountRoute({ route: 'positions', counts, tasks: async () => [task] })).toEqual({
        total: 26_000,
        capped: true,
      });
      expect(count).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed count PLAN (the exclusion set\'s first load) is pending, not a 500', async () => {
    const svc = positionsService(
      async () => ({ count: 1, capped: false }),
      async () => Promise.reject(Object.assign(new Error('pool closed'), { name: 'MongoNotConnectedError' })),
    );
    expect(await svc.getTopPositionsCount({ protocol: 'uniswap-v4' } as never)).toEqual(PENDING);
  });

  it('sums the shards when every count is in', async () => {
    const svc = positionsService(async () => ({ count: 100, capped: false }));
    expect(await svc.getTopPositionsCount({ protocol: 'uniswap-v4' } as never)).toEqual({ total: 200, capped: false });
  });

  it('pending when ONE shard\'s count failed — a partial sum is never served as the total', async () => {
    let calls = 0;
    const svc = positionsService(async () => (++calls === 1 ? { count: 100, capped: false } : Promise.reject(new CountQueueFullError())));
    expect(await svc.getTopPositionsCount({ protocol: 'uniswap-v4' } as never)).toEqual(PENDING);
  });

  it('a bad request (unsupported chain) is still a 400, not "pending"', async () => {
    const svc = new LeaderboardService(
      { ...config, isSupportedChain: () => false } as never,
      {} as never,
      {} as never,
      {} as never,
      new LeaderboardCountService(),
    );
    await expect(svc.getTopPositionsCount({ chainId: 999, protocol: 'uniswap-v4' } as never)).rejects.toMatchObject({ status: 400 });
  });

  it('a queue-full or budget refusal is NOT remembered as the count\'s failure (the next ask runs it)', async () => {
    const counts = new LeaderboardCountService();
    const run = vi.fn<() => Promise<{ count: number; capped: boolean }>>()
      .mockRejectedValueOnce(new ReadBudgetTimeoutError('count', 1))
      .mockResolvedValueOnce({ count: 5, capped: false });
    expect(await counts.settle('k', run, 1_000)).toEqual({ pending: 'budget' });
    expect(await counts.settle('k', run, 1_000)).toMatchObject({ result: { count: 5, capped: false } });
  });

  it('a count TIMEOUT is remembered for 90 s (not re-run on every view), still answered as pending', async () => {
    const counts = new LeaderboardCountService();
    const run = vi.fn(async () => Promise.reject(new QueryTimeoutException()));
    expect(await counts.settle('k', run, 1_000)).toEqual({ pending: 'timeout' });
    expect(await counts.settle('k', run, 1_000)).toEqual({ pending: 'timeout' });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('classifies every pending reason', () => {
    expect(countPendingReason(new CountQueueFullError())).toBe('queue_full');
    expect(countPendingReason(Object.assign(new Error(), { code: 50 }))).toBe('timeout');
    expect(countPendingReason(Object.assign(new Error(), { name: 'MaxRetriesPerRequestError' }))).toBe('redis');
    expect(countPendingReason(Object.assign(new Error(), { name: 'MongoServerSelectionError' }))).toBe('mongo');
    expect(countPendingReason(new Error('x'))).toBe('error');
  });
});

describe('counts go through the global read budget', () => {
  it('reserve the last result (a default the first time) before running, then repay the surplus', async () => {
    const budget = { reserve: vi.fn(async () => undefined), charge: vi.fn(), chargeTime: vi.fn() };
    const counts = new LeaderboardCountService(undefined, budget as unknown as ReadBudgetService);
    const run = vi.fn(async () => ({ count: 9_000, capped: false }));
    await counts.get('k', run);
    expect(budget.reserve).toHaveBeenCalledWith(2_500, expect.objectContaining({ lane: 'count' }));
    expect(budget.charge).toHaveBeenCalledWith(6_500, 'count');
  });

  it('settles the count\'s DATABASE TIME against its reservation (a `$nin` count FETCHes every key it tests) — even when it fails', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const budget = { reserve: vi.fn(async () => undefined), charge: vi.fn(), chargeTime: vi.fn() };
      const counts = new LeaderboardCountService(undefined, budget as unknown as ReadBudgetService);
      await counts.get('k', async () => {
        vi.setSystemTime(Date.now() + 1_200); // a 1.2 s count
        return { count: 40, capped: false };
      });
      expect(budget.chargeTime).toHaveBeenCalledWith(1_200, 2_500, 'count');
      await counts
        .get('j', async () => {
          vi.setSystemTime(Date.now() + 8_000);
          throw Object.assign(new Error('timed out'), { code: 50 });
        })
        .catch(() => undefined);
      expect(budget.chargeTime).toHaveBeenLastCalledWith(8_000, 2_500, 'count');
    } finally {
      vi.useRealTimers();
    }
  });

  it('the next run of the same count reserves its last result', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const budget = { reserve: vi.fn(async () => undefined), charge: vi.fn(), chargeTime: vi.fn() };
      const counts = new LeaderboardCountService(undefined, budget as unknown as ReadBudgetService);
      await counts.get('k', async () => ({ count: 9_000, capped: false }));
      vi.setSystemTime(Date.now() + 60_000); // past the 30 s stale age: gone
      await counts.get('k', async () => ({ count: 9_000, capped: false }));
      expect(budget.reserve).toHaveBeenLastCalledWith(9_000, expect.objectContaining({ lane: 'count' }));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a list page whose count PLAN fails', () => {
  const base = { page: 1, limit: 25, rowsOnPage: 25, hasMore: true, counts: new LeaderboardCountService() };
  const failing = async () => Promise.reject(new Error('exclusion set: first load failed'));

  it('/api: totalPending (the total is unknown, not zero)', async () => {
    expect(await resolveListPagination({ ...base, tasks: failing })).toEqual({
      page: 1,
      limit: 25,
      total: null,
      totalPages: null,
      hasMore: true,
      totalPending: true,
    });
  });

  it('/v1: the proven floor, flagged totalCapped (the contract is unchanged)', async () => {
    expect(await resolveListPagination({ ...base, tasks: failing, countWaitMs: 50 })).toEqual({
      page: 1,
      limit: 25,
      total: 26,
      totalPages: 2,
      hasMore: true,
      totalCapped: true,
    });
  });
});
