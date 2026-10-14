import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readPathSnapshot, resetReadPathMeter } from '../src/common/cache/read-path-meter.js';
import { DEEP_BACKGROUND_MAX_MS, ReadBudgetService, ReadBudgetTimeoutError } from '../src/common/read-budget.js';
import { PositionsRepository, type LeaderboardQuery } from '../src/database/positions.repository.js';
import { QueryTimeoutException } from '../src/database/user-read.js';

function clock(start = 0) {
  const state = { now: start, slept: [] as number[] };
  return {
    state,
    now: () => state.now,
    sleep: async (ms: number) => {
      state.slept.push(ms);
      state.now += ms;
    },
  };
}

const config = (over: Record<string, unknown> = {}) => ({
  readBudgetDocsPerSec: 20_000,
  readBudgetBurstDocs: 20_000,
  leaderboardDeepWalkConcurrency: 2,
  ...over,
});

beforeEach(() => resetReadPathMeter());

describe('global read budget (per-process bucket: Redis off)', () => {
  it('serves a burst at once, then makes later reads WAIT for the refill — never refuses one that fits its deadline', async () => {
    const c = clock();
    const budget = new ReadBudgetService(config() as never, undefined, c);
    await budget.reserve(20_000, { deadlineAt: 5_000, lane: 'deep' });
    expect(c.state.slept).toEqual([]);
    // The bucket is empty: 10,000 more rows at 20k/s is a 500 ms wait, inside the deadline.
    await budget.reserve(10_000, { deadlineAt: c.now() + 5_000, lane: 'deep' });
    expect(c.state.slept).toEqual([500]);
    // A read far larger than the bucket still goes through — it just waits for the refill.
    await budget.reserve(60_000, { deadlineAt: c.now() + 10_000, lane: 'deep' });
    expect(c.state.slept[1]).toBe(3_000);
    const lane = readPathSnapshot().budget.deep!;
    expect(lane).toMatchObject({ reservations: 3, rows: 90_000, waits: 2, waitMs: 3_500, rejected: 0, fallback: 3 });
  });

  it('a wait past the deadline takes nothing and throws ReadBudgetTimeoutError (the timeout path, not a depth refusal)', async () => {
    const c = clock();
    const budget = new ReadBudgetService(config() as never, undefined, c);
    await budget.reserve(20_000, { deadlineAt: 5_000, lane: 'count' });
    const err = await budget.reserve(30_000, { deadlineAt: c.now() + 1_000, lane: 'count' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReadBudgetTimeoutError);
    expect((err as ReadBudgetTimeoutError).waitMs).toBe(1_500);
    // Nothing was taken: a read that fits now still waits only for what IT needs.
    await budget.reserve(1_000, { deadlineAt: c.now() + 1_000, lane: 'count' });
    expect(c.state.slept).toEqual([50]);
    expect(readPathSnapshot().budget.count!.rejected).toBe(1);
  });

  it('charge() repays rows read beyond a reservation as debt the NEXT reservation waits out', async () => {
    const c = clock();
    const budget = new ReadBudgetService(config() as never, undefined, c);
    await budget.reserve(20_000, { deadlineAt: 1_000, lane: 'count' });
    budget.charge(10_000, 'count');
    await new Promise((r) => setTimeout(r, 0));
    await budget.reserve(1, { deadlineAt: c.now() + 5_000, lane: 'count' });
    expect(c.state.slept).toEqual([501]); // (10,000 + 1) rows at 20/ms
  });

  it('rate 0 turns the budget off', async () => {
    const c = clock();
    const budget = new ReadBudgetService(config({ readBudgetDocsPerSec: 0 }) as never, undefined, c);
    await budget.reserve(1e9, { deadlineAt: 0, lane: 'deep' });
    expect(c.state.slept).toEqual([]);
  });
});

describe('user-read pressure (the read models\' scans yield to it, P-R §3.2)', () => {
  it('a wait or a refusal puts the budget under pressure for 10 s', async () => {
    const c = clock(1_000);
    const budget = new ReadBudgetService(config() as never, undefined, c);
    expect(budget.underPressure()).toBe(false);
    await budget.reserve(20_000, { deadlineAt: c.now() + 5_000, lane: 'count' }); // the burst: no wait
    expect(budget.underPressure()).toBe(false);
    await budget.reserve(1_000, { deadlineAt: c.now() + 5_000, lane: 'count' }); // a USER lane waits
    expect(budget.underPressure()).toBe(true);
    c.state.now += 10_001;
    expect(budget.underPressure()).toBe(false);
    await budget.reserve(60_000, { deadlineAt: c.now() + 1, lane: 'deep' }).catch(() => undefined); // refused
    expect(budget.underPressure()).toBe(true);
  });

  it('the shared bucket below 10% of its depth is pressure from other processes; the budget off is never under pressure', async () => {
    const c = clock(10_000);
    const hmget = vi.fn(async () => ['1000', '10000']);
    const redis = { namespace: 'ns', client: async () => ({ hmget }), logError: () => undefined };
    const budget = new ReadBudgetService(config() as never, redis as never, c);
    expect(await budget.sharedPressure()).toBe(true); // 1,000 of 20,000 tokens
    expect(hmget).toHaveBeenCalledWith('tw:rb:v1:ns', 'tokens', 'ts');
    hmget.mockResolvedValue(['15000', '10000']);
    expect(await budget.sharedPressure()).toBe(false);
    hmget.mockResolvedValue(['0', '9500']); // refilled since: 0 + 500 ms × 20/ms = 10,000 tokens
    expect(await budget.sharedPressure()).toBe(false);
    const off = new ReadBudgetService(config({ readBudgetDocsPerSec: 0 }) as never, redis as never, c);
    expect(off.underPressure()).toBe(false);
    expect(await off.sharedPressure()).toBe(false);
  });
});

describe('global read budget through Redis', () => {
  it('reserves with ONE atomic script per call, keyed by deployment, with a TTL and the deadline as max wait', async () => {
    const c = clock(1_000);
    const evalCalls: unknown[][] = [];
    const client = {
      eval: vi.fn(async (...args: unknown[]) => {
        evalCalls.push(args);
        return 250;
      }),
    };
    const redis = { namespace: 'prod0000aaaa1111', client: async () => client, logError: vi.fn() };
    const budget = new ReadBudgetService(config() as never, redis as never, c);
    await budget.reserve(5_000, { deadlineAt: 3_000, lane: 'deep' });
    const [script, numKeys, key, rate, burst, cost, maxWait, ttl] = evalCalls[0]!;
    expect(String(script)).toMatch(/redis\.call\('TIME'\)/);
    expect(numKeys).toBe(1);
    expect(key).toBe('tw:rb:v1:prod0000aaaa1111');
    expect([rate, burst, cost, maxWait, ttl]).toEqual(['20', '20000', '5000', '2000', '60000']);
    expect(c.state.slept).toEqual([250]);
    expect(readPathSnapshot().budget.deep).toMatchObject({ fallback: 0 });
  });

  it('a refusal from the script (negative wait) is a ReadBudgetTimeoutError', async () => {
    const client = { eval: async () => -900 };
    const redis = { namespace: 'ns', client: async () => client, logError: vi.fn() };
    const budget = new ReadBudgetService(config() as never, redis as never, clock());
    await expect(budget.reserve(1, { deadlineAt: 100, lane: 'rescue' })).rejects.toMatchObject({ waitMs: 900 });
  });

  it('a Redis error falls back to the per-process bucket: the read still runs, paced', async () => {
    const client = {
      eval: async () => {
        throw Object.assign(new Error('READONLY'), { name: 'ReplyError' });
      },
    };
    const redis = { namespace: 'ns', client: async () => client, logError: vi.fn() };
    const c = clock();
    const budget = new ReadBudgetService(config() as never, redis as never, c);
    await budget.reserve(100, { deadlineAt: 1_000, lane: 'deep' });
    expect(redis.logError).toHaveBeenCalled();
    expect(readPathSnapshot().budget.deep).toMatchObject({ reservations: 1, fallback: 1 });
  });
});

describe('database time is charged, not only rows', () => {
  it('chargeTime: a read whose server time exceeds its rows (a filter that rejects most of what it examines) pays the difference as debt', async () => {
    const c = clock();
    const budget = new ReadBudgetService(config() as never, undefined, c);
    await budget.reserve(20_000, { deadlineAt: 1_000, lane: 'deep' }); // the bucket is empty
    // 3,000 rows that took 983 ms of Mongo (m10-3, chain-1 landing walk, 211k keys examined):
    // at 20k rows/s of server time that is 19,660 rows — 16,660 more than reserved.
    budget.chargeTime(983, 3_000, 'deep');
    await new Promise((r) => setTimeout(r, 0));
    await budget.reserve(1, { deadlineAt: c.now() + 5_000, lane: 'deep' });
    expect(c.state.slept).toEqual([834]); // (16,660 + 1) rows at 20/ms
  });

  it('a read cheap in time costs exactly its rows (no charge), and the budget off charges nothing', async () => {
    const c = clock();
    const budget = new ReadBudgetService(config() as never, undefined, c);
    const charge = vi.spyOn(budget, 'charge');
    budget.chargeTime(50, 3_000, 'deep'); // 1,000 rows of time < 3,000 reserved
    budget.chargeTime(0, 3_000, 'deep');
    expect(charge).not.toHaveBeenCalled();
    const off = new ReadBudgetService(config({ readBudgetDocsPerSec: 0 }) as never, undefined, c);
    const offCharge = vi.spyOn(off, 'charge');
    off.chargeTime(60_000, 0, 'deep');
    expect(offCharge).not.toHaveBeenCalled();
  });
});

describe('background deep walks', () => {
  it('ONE at a time per process: a second start is refused while one runs, and the slot frees when it ends', async () => {
    const budget = new ReadBudgetService(config() as never);
    let finish!: () => void;
    const first = vi.fn(() => new Promise<void>((r) => (finish = r)));
    expect(budget.startBackgroundWalk('a', first)).toBe(true);
    expect(budget.startBackgroundWalk('b', async () => undefined)).toBe(false);
    await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1));
    expect(budget.backgroundWalks).toBe(1);
    finish();
    await vi.waitFor(() => expect(budget.backgroundWalks).toBe(0));
    expect(budget.startBackgroundWalk('b', async () => undefined)).toBe(true);
  });

  it('runs with no request deadline — up to DEEP_BACKGROUND_MAX_MS — and a failure is logged, not thrown', async () => {
    const c = clock(1_000);
    const budget = new ReadBudgetService(config() as never, undefined, c);
    (budget as unknown as { logger: unknown }).logger = { warn: vi.fn() };
    let deadline = 0;
    budget.startBackgroundWalk('a', async (deadlineAt) => {
      deadline = deadlineAt;
      throw new Error('walk failed');
    });
    await vi.waitFor(() => expect(budget.backgroundWalks).toBe(0));
    expect(deadline).toBe(1_000 + DEEP_BACKGROUND_MAX_MS);
    expect(readPathSnapshot().deepWalks.background).toMatchObject({ started: 1, failed: 1 });
  });

  it('across processes through a Redis lease: a walk another process holds the lease for is skipped here', async () => {
    const store = new Map<string, string>();
    const redis = {
      set: vi.fn(async (key: string, value: string, _px: string, _ms: number, _nx: string) => {
        if (store.has(key)) return null;
        store.set(key, value);
        return 'OK';
      }),
      eval: vi.fn(async () => 0),
    };
    const readPathRedis = { namespace: 'prod0000aaaa1111', client: async () => redis, logError: vi.fn() };
    store.set('tw:lease:v1:prod0000aaaa1111:deep-walk', 'other-host:1:abcd');
    const budget = new ReadBudgetService(config() as never, readPathRedis as never);
    const run = vi.fn(async () => undefined);
    expect(budget.startBackgroundWalk('a', run)).toBe(true);
    await vi.waitFor(() => expect(budget.backgroundWalks).toBe(0));
    expect(run).not.toHaveBeenCalled();
    // Free: this process takes it, runs, and releases it (compare-and-set).
    store.clear();
    expect(budget.startBackgroundWalk('a', run)).toBe(true);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(budget.backgroundWalks).toBe(0));
    expect(redis.set.mock.calls.at(-1)![0]).toBe('tw:lease:v1:prod0000aaaa1111:deep-walk');
    expect(redis.eval).toHaveBeenCalled(); // the release
  });

  it('a background walk takes at most HALF the budget: each reservation is followed by an equal idle', async () => {
    const c = clock();
    const budget = new ReadBudgetService(config() as never, undefined, c);
    await budget.reserveBackground(2_000, 60_000); // inside the burst: no wait for budget
    expect(c.state.slept).toEqual([100]); // 2,000 rows at 20/ms = 100 ms — then idle that long again
    expect(readPathSnapshot().budget['deep-background']).toMatchObject({ reservations: 1, rows: 2_000 });
  });

  it('the budget off: no background walks (nothing would pace them)', () => {
    const budget = new ReadBudgetService(config({ readBudgetDocsPerSec: 0 }) as never);
    expect(budget.startBackgroundWalk('a', async () => undefined)).toBe(false);
  });
});

describe('long deep-walk slots', () => {
  it('at most LEADERBOARD_DEEP_WALK_CONCURRENCY at once; a waiter past its deadline gives up and leaves the queue', async () => {
    const budget = new ReadBudgetService(config({ leaderboardDeepWalkConcurrency: 1 }) as never);
    let release!: () => void;
    const first = budget.walkSlot(Date.now() + 1_000, () => new Promise<void>((r) => (release = r)));
    const late = budget.walkSlot(Date.now() + 20, async () => 'ran').catch((e: unknown) => e);
    expect(await late).toBeInstanceOf(ReadBudgetTimeoutError);
    const next = budget.walkSlot(Date.now() + 1_000, async () => 'ran');
    release();
    await first;
    expect(await next).toBe('ran'); // the timed-out waiter did not swallow the released slot
  });
});

describe('the non-page reads that go through the budget', () => {
  const TIMEOUT = () => Object.assign(new Error('x'), { code: 50, codeName: 'MaxTimeMSExpired' });
  const q = (): LeaderboardQuery => ({
    chainId: 1,
    protocol: 'uniswap-v4',
    sort: 'apr',
    page: 1,
    limit: 25,
    activeOnly: true,
    status: 'active',
    range: 'in',
    minValueUsd: 500,
    minPoolTvl: 1000,
    includeRisky: true,
  });

  function repoWith(budget: unknown, find: (maxTimeMS: number) => unknown, aggregate?: () => unknown) {
    const model = {
      find: () => {
        let maxTimeMS = 0;
        const query: Record<string, unknown> = {};
        for (const m of ['select', 'sort', 'collation', 'hint', 'skip', 'limit', 'read']) query[m] = () => query;
        query.maxTimeMS = (ms: number) => ((maxTimeMS = ms), query);
        query.lean = async () => find(maxTimeMS);
        return query;
      },
      aggregate: () => {
        const query: Record<string, unknown> = {};
        for (const m of ['read', 'option', 'hint']) query[m] = () => query;
        query.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve().then(aggregate).then(resolve, reject);
        return query;
      },
    };
    return new PositionsRepository(
      { positionModel: () => model } as never,
      { readyLeaderboardExclusions: async () => ({ addresses: [], ok: true }) } as never,
      undefined,
      undefined,
      budget as ReadBudgetService,
    );
  }

  it('a window RESCUE — by definition a slow read — is charged its DATABASE TIME, not its 51 rows', async () => {
    const budget = { reserve: vi.fn(async () => undefined), charge: vi.fn(), chargeTime: vi.fn() };
    let calls = 0;
    const repo = repoWith(budget, () => {
      calls++;
      if (calls === 1) throw TIMEOUT(); // the request's read times out → the rescue
      return [{ positionId: '1', tokenId: '1', metrics: {} }];
    });
    await expect(repo.findLeaderboard(q())).rejects.toBeInstanceOf(QueryTimeoutException);
    await vi.waitFor(() => expect(budget.chargeTime).toHaveBeenCalledTimes(1));
    expect(budget.chargeTime).toHaveBeenCalledWith(expect.any(Number), 51, 'rescue');
  });

  it('a window RESCUE reserves its rows (lane rescue) before it reads, and skips the read when no budget comes', async () => {
    const order: string[] = [];
    const budget = {
      reserve: vi.fn(async (rows: number, opts: { lane: string }) => {
        order.push(`reserve:${opts.lane}:${rows}`);
        throw new ReadBudgetTimeoutError('rescue', 1);
      }),
      charge: vi.fn(),
    };
    const repo = repoWith(budget, (maxTimeMS) => {
      order.push(`find:${maxTimeMS}`);
      throw TIMEOUT();
    });
    await expect(repo.findLeaderboard(q())).rejects.toBeInstanceOf(QueryTimeoutException);
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(['find:5000', 'reserve:rescue:51']); // the 30 s rescue read never ran
  });

  it('a pool holder count on the REQUEST path that cannot get budget answers null (+ background), never a 5xx', async () => {
    const budget = {
      reserve: vi.fn(async (_rows: number, opts: { lane: string; deadlineAt: number }) => {
        if (opts.deadlineAt - Date.now() <= 1_000) throw new ReadBudgetTimeoutError('pool-counts', 2_000);
      }),
      charge: vi.fn(),
    };
    const aggregate = vi.fn(() => [{ _id: '0xabc', positionsCount: 3, holdersCount: 2 }]);
    const repo = repoWith(budget, () => [], aggregate);
    const counts = await repo.countsByPoolIds(1, 'uniswap-v4', ['0xabc']);
    expect(counts.get('0xabc')).toBeNull();
    await vi.waitFor(() => expect(aggregate).toHaveBeenCalledTimes(1)); // counted in the background, with a longer wait
    expect(budget.reserve.mock.calls.map(([, opts]) => opts.lane)).toEqual(['pool-counts', 'pool-counts']);
  });
});
