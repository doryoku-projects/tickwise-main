import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withReadHeaders } from '../src/common/cache/read-headers.js';
import { readPathSnapshot, resetReadPathMeter } from '../src/common/cache/read-path-meter.js';
import { AppConfigService } from '../src/config/app-config.service.js';
import { PoolsRepository } from '../src/database/pools.repository.js';
import { PositionsRepository, type LeaderboardQuery } from '../src/database/positions.repository.js';
import { observeHeartbeat, replicationLagSnapshot, resetReplicationLag, userReadLagMs } from '../src/database/replication-lag.js';
import { QueryTimeoutException } from '../src/database/user-read.js';
import { LeaderboardCountService, resolveCountRoute } from '../src/leaderboard/count-cache.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { PoolsService } from '../src/pools/pools.service.js';

/**
 * The ONE staleness budget: lists cached 15 s, data at most ~45 s old. Every
 * origin cache on the list path is fresh 15 s / stale 30 s (±10 % jitter, so
 * ≤ 33 s); anything older is served only on a database timeout, and then
 * flagged `stale: true` + `dataAsOf`, counted, and never cacheable.
 */

const TIMEOUT = () => Object.assign(new Error('operation exceeded time limit'), { code: 50, codeName: 'MaxTimeMSExpired' });

beforeEach(() => resetReadPathMeter());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('config', () => {
  it('defaults: budget 45 s, lists fresh 15 s / stale 30 s, warmup every 10 s at the fresh age (15 s), ladder kept 10 min', () => {
    const config = new AppConfigService();
    expect(config.readStalenessBudgetMs).toBe(45_000);
    expect(config.leaderboardListFreshMs).toBe(15_000);
    expect(config.leaderboardListStaleMs).toBe(30_000);
    expect(config.leaderboardWarmupIntervalMs).toBe(10_000);
    expect(config.leaderboardWarmupMinAgeMs).toBe(15_000);
    expect(config.leaderboardLadderMaxAgeMs).toBe(600_000);
    expect(config.readBudgetDocsPerSec).toBe(20_000);
    expect(config.mongoReplicationLagAlertMs).toBe(10_000);
  });

  it('keeps the windows inside the budget whatever is configured (stale × 1.1 jitter ≤ budget)', () => {
    vi.stubEnv('LEADERBOARD_LIST_STALE_MS', '600000');
    vi.stubEnv('LEADERBOARD_LIST_FRESH_MS', '600000');
    const config = new AppConfigService();
    expect(config.leaderboardListFreshMs).toBe(45_000);
    expect(config.leaderboardListStaleMs).toBe(45_000); // ≥ fresh wins over the jitter margin
    vi.stubEnv('LEADERBOARD_LIST_FRESH_MS', '15000');
    expect(new AppConfigService().leaderboardListStaleMs).toBe(40_909); // floor(45 000 / 1.1)
    vi.stubEnv('READ_STALENESS_BUDGET_MS', '1');
    expect(new AppConfigService().readStalenessBudgetMs).toBe(5_000);
  });

  it('LEADERBOARD_WARMUP_MIN_AGE_MS unset follows the list fresh age; set, it wins (0 allowed)', () => {
    vi.stubEnv('LEADERBOARD_LIST_FRESH_MS', '20000');
    expect(new AppConfigService().leaderboardWarmupMinAgeMs).toBe(20_000);
    vi.stubEnv('LEADERBOARD_WARMUP_MIN_AGE_MS', '12000');
    expect(new AppConfigService().leaderboardWarmupMinAgeMs).toBe(12_000);
    vi.stubEnv('LEADERBOARD_WARMUP_MIN_AGE_MS', '0');
    expect(new AppConfigService().leaderboardWarmupMinAgeMs).toBe(0);
    vi.stubEnv('LEADERBOARD_WARMUP_MIN_AGE_MS', 'garbage');
    expect(new AppConfigService().leaderboardWarmupMinAgeMs).toBe(20_000);
  });

  it('LEADERBOARD_LADDER_MAX_AGE_MS is clamped between the staleness budget and 1 h', () => {
    vi.stubEnv('LEADERBOARD_LADDER_MAX_AGE_MS', '1000');
    expect(new AppConfigService().leaderboardLadderMaxAgeMs).toBe(45_000);
    vi.stubEnv('LEADERBOARD_LADDER_MAX_AGE_MS', '99999999');
    expect(new AppConfigService().leaderboardLadderMaxAgeMs).toBe(3_600_000);
    vi.stubEnv('LEADERBOARD_LADDER_MAX_AGE_MS', 'garbage');
    expect(new AppConfigService().leaderboardLadderMaxAgeMs).toBe(600_000);
  });

  it('READ_BUDGET_DOCS_PER_SEC=0 turns the global read budget off; the burst is at least one second of rate', () => {
    vi.stubEnv('READ_BUDGET_DOCS_PER_SEC', '0');
    expect(new AppConfigService().readBudgetDocsPerSec).toBe(0);
    vi.stubEnv('READ_BUDGET_DOCS_PER_SEC', '50000');
    vi.stubEnv('READ_BUDGET_BURST_DOCS', '10');
    expect(new AppConfigService().readBudgetBurstDocs).toBe(50_000);
  });
});

function positionsRepo(find: () => unknown) {
  const model = {
    find: () => {
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'sort', 'collation', 'hint', 'skip', 'limit', 'read', 'maxTimeMS']) q[m] = () => q;
      q.lean = async () => find();
      return q;
    },
  };
  const tokens = { readyLeaderboardExclusions: async () => ({ addresses: [], ok: true }) };
  return new PositionsRepository({ positionModel: () => model } as never, tokens as never);
}

const query = (over: Partial<LeaderboardQuery> = {}): LeaderboardQuery => ({
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
  ...over,
});

describe('positions windows: fresh 15 s, stale 30 s, then gone', () => {
  it('hit until ~15 s, served stale (and refreshed) until ~30 s, re-read after 33 s at the longest jitter', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const find = vi.fn(() => [{ positionId: '1', tokenId: '1', metrics: {} }]);
    const repo = positionsRepo(find);
    expect((await repo.findLeaderboard(query())).cache).toBe('miss');
    vi.setSystemTime(Date.now() + 13_000);
    expect((await repo.findLeaderboard(query())).cache).toBe('hit');
    vi.setSystemTime(Date.now() + 4_500); // 17.5 s: past fresh at the longest jitter
    expect((await repo.findLeaderboard(query())).cache).toBe('stale');
    await vi.waitFor(() => expect(find).toHaveBeenCalledTimes(2)); // one background refresh
    vi.setSystemTime(Date.now() + 34_000);
    expect((await repo.findLeaderboard(query())).cache).toBe('miss');
  });

  it('a database timeout serves the retained window FLAGGED with when it was read', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let fail = false;
    const repo = positionsRepo(() => {
      if (fail) throw TIMEOUT();
      return [{ positionId: '7', tokenId: '7', metrics: {} }];
    });
    const readAt = Date.now();
    await repo.findLeaderboard(query());
    fail = true;
    vi.setSystemTime(readAt + 5 * 60_000);
    const page = await repo.findLeaderboard(query());
    expect(page.cache).toBe('stale');
    expect(page.dataAsOf).toBe(readAt);
    expect(page.positions.map((p) => p.positionId)).toEqual(['7']);
    expect(readPathSnapshot().staleServed.positions).toEqual({ count: 1, maxAgeMs: 5 * 60_000 });
  });

  it('…and the response says so: stale: true + dataAsOf, Cache-Control: no-store', async () => {
    const dataAsOf = Date.UTC(2026, 9, 3, 10, 0, 0);
    const positions = { findLeaderboard: async () => ({ positions: [], hasMore: false, cache: 'stale', dataAsOf }) };
    const svc = new LeaderboardService(
      { isSupportedChain: () => true, isSupportedProtocol: () => true, enabledIntegrations: [] } as never,
      positions as never,
      {} as never,
      {} as never,
      new LeaderboardCountService(),
    );
    const headers: Record<string, string> = {};
    const res = await withReadHeaders({ setHeader: (k, v) => (headers[k] = v) }, (meta) =>
      svc.getTopPositions({ chainId: 1, protocol: 'uniswap-v4', page: 1, limit: 25 } as never, { meta }),
    );
    expect(res).toMatchObject({ stale: true, dataAsOf: '2026-10-03T10:00:00.000Z' });
    expect(headers['Cache-Control']).toBe('no-store');
    expect(headers['X-Cache']).toBe('stale');
  });

  it('an unflagged answer never carries stale/dataAsOf', async () => {
    const positions = { findLeaderboard: async () => ({ positions: [], hasMore: false, cache: 'stale' }) };
    const svc = new LeaderboardService(
      { isSupportedChain: () => true, isSupportedProtocol: () => true, enabledIntegrations: [] } as never,
      positions as never,
      {} as never,
      {} as never,
    );
    const res = await svc.getTopPositions({ chainId: 1, protocol: 'uniswap-v4', page: 1, limit: 25 } as never);
    expect(res).not.toHaveProperty('stale');
    expect(res).not.toHaveProperty('dataAsOf');
  });
});

describe('pools windows, pool detail and pool holder counts: the same budget', () => {
  function poolsRepo(find: () => unknown) {
    const model = {
      find: () => {
        const q: Record<string, unknown> = {};
        for (const m of ['sort', 'skip', 'limit', 'read', 'maxTimeMS', 'select']) q[m] = () => q;
        q.lean = async () => find();
        return q;
      },
    };
    const tokens = { readyLeaderboardExclusions: async () => ({ addresses: [], ok: true }) };
    return new PoolsRepository({ poolModel: () => model } as never, tokens as never);
  }
  const q = { chainId: 1, protocol: 'uniswap-v4', sort: 'tvl', page: 1, limit: 20, minTvlUsd: 0, includeRisky: false };

  it('pools window: hit at 13 s, stale at 17.5 s, gone at 34 s (it was fresh 60 s / stale 10 min)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const find = vi.fn(() => [{ poolId: '0xa', chainId: 1, metrics: { tvlUsd: 1 } }]);
    const repo = poolsRepo(find);
    expect((await repo.findPoolsLeaderboard(q)).cache).toBe('miss');
    vi.setSystemTime(Date.now() + 13_000);
    expect((await repo.findPoolsLeaderboard(q)).cache).toBe('hit');
    vi.setSystemTime(Date.now() + 4_500);
    expect((await repo.findPoolsLeaderboard(q)).cache).toBe('stale');
    vi.setSystemTime(Date.now() + 34_000);
    expect((await repo.findPoolsLeaderboard(q)).cache).toBe('miss');
  });

  it('pools timeout fallback is flagged dataAsOf', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let fail = false;
    const repo = poolsRepo(() => {
      if (fail) throw TIMEOUT();
      return [{ poolId: '0xa', chainId: 1, metrics: { tvlUsd: 1 } }];
    });
    const at = Date.now();
    await repo.findPoolsLeaderboard(q);
    fail = true;
    vi.setSystemTime(at + 120_000);
    const page = await repo.findPoolsLeaderboard(q);
    expect(page).toMatchObject({ cache: 'stale', dataAsOf: at });
    expect(readPathSnapshot().staleServed.pools?.count).toBe(1);
  });

  const poolDoc = { poolId: '0xAbC', chainId: 1, protocol: 'uniswap-v4', token0: { address: '0xa' }, token1: { address: '0xb' }, fee: 3000, metrics: { tvlUsd: 1, feeApr: 0 } };

  it('pool detail: fresh 15 s (was 60 s), and a timeout fallback is flagged stale + dataAsOf', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let fail = false;
    const findPoolById = vi.fn(async () => {
      if (fail) throw new QueryTimeoutException();
      return poolDoc;
    });
    const svc = new PoolsService(
      { isSupportedChain: () => true, isSupportedProtocol: () => true } as never,
      { findPoolById } as never,
      { countsByPoolIds: async () => new Map() } as never,
      { findLatestPrices: async () => new Map() } as never,
      new LeaderboardCountService(),
    );
    const at = Date.now();
    await svc.getPool(1, 'uniswap-v4', '0xabc');
    vi.setSystemTime(at + 17_000);
    const meta: { cache?: string; noStore?: boolean } = {};
    await svc.getPool(1, 'uniswap-v4', '0xabc', meta);
    expect(meta.cache).toBe('stale'); // past 15 s fresh: revalidating
    await vi.waitFor(() => expect(findPoolById).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 0)); // let the background refresh store
    fail = true;
    vi.setSystemTime(at + 5 * 60_000);
    const stale = (await svc.getPool(1, 'uniswap-v4', '0xabc', meta)) as unknown as { poolId: string; stale: boolean; dataAsOf: string };
    // The retained copy is the one the 17 s background refresh stored (vi.waitFor
    // nudges the fake clock by its poll interval, hence the window).
    expect(stale).toMatchObject({ poolId: '0xAbC', stale: true });
    expect(Date.parse(stale.dataAsOf)).toBeGreaterThanOrEqual(at + 17_000);
    expect(Date.parse(stale.dataAsOf)).toBeLessThan(at + 18_000);
    expect(meta.noStore).toBe(true);
    expect(readPathSnapshot().staleServed['pool-detail']?.count).toBe(1);
  });

  it('pool holder counts served past their stale age flag the pools list stale', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    let fail = false;
    const aggregate = vi.fn(() => {
      if (fail) throw TIMEOUT();
      return [{ _id: '0xabc', positionsCount: 3, holdersCount: 2 }];
    });
    const model = {
      aggregate: () => {
        const q: Record<string, unknown> = {};
        for (const m of ['read', 'option', 'hint']) q[m] = () => q;
        q.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
          Promise.resolve().then(aggregate).then(resolve, reject);
        return q;
      },
    };
    const tokens = { readyLeaderboardExclusions: async () => ({ addresses: [], ok: true }) };
    const positions = new PositionsRepository({ positionModel: () => model } as never, tokens as never);
    const at = Date.now();
    expect((await positions.countsByPoolIds(1, 'uniswap-v4', ['0xabc'])).get('0xabc')).toEqual({ positionsCount: 3, holdersCount: 2 });
    fail = true;
    vi.setSystemTime(at + 5 * 60_000);
    const meta: { dataAsOf?: number } = {};
    expect((await positions.countsByPoolIds(1, 'uniswap-v4', ['0xabc'], meta)).get('0xabc')).toEqual({ positionsCount: 3, holdersCount: 2 });
    expect(meta.dataAsOf).toBe(at);
  });
});

describe('list counts: fresh 15 s, stale 30 s (were 2–10 min fresh, 30 min stale)', () => {
  it('peek serves a fresh count, refreshes a stale one, and forgets one past the stale age', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const counts = new LeaderboardCountService();
    const run = vi.fn(async () => ({ count: 10, capped: false }));
    await counts.get('k', run);
    vi.setSystemTime(Date.now() + 13_000);
    expect(counts.peek('k', run)).toEqual({ count: 10, capped: false });
    expect(run).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 4_500);
    expect(counts.peek('k', run)).toEqual({ count: 10, capped: false });
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    vi.setSystemTime(Date.now() + 34_000);
    expect(counts.peek('k', run)).toBeUndefined();
  });

  it('a SLOW count no longer stays fresh for 10 minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const counts = new LeaderboardCountService();
    const run = vi.fn(async () => {
      vi.setSystemTime(Date.now() + 5_000); // a 5 s count
      return { count: 10, capped: false };
    });
    await counts.get('k', run);
    vi.setSystemTime(Date.now() + 60_000);
    expect(counts.peek('k', run)).toBeUndefined();
  });
});

describe('replication lag (from the driver heartbeats)', () => {
  beforeEach(() => resetReplicationLag());

  it('a secondary\'s lag = how far its last write trails the primary\'s, each against when its reply arrived', () => {
    const t = Date.UTC(2026, 9, 3);
    observeHeartbeat('m10-1:27031', { isWritablePrimary: true, lastWrite: { lastWriteDate: new Date(t - 1_000) } }, t, 10_000);
    const lagging = observeHeartbeat('m10-2:27032', { secondary: true, lastWrite: { lastWriteDate: new Date(t - 13_000) } }, t + 500, 10_000);
    expect(replicationLagSnapshot().members).toEqual([
      { member: 'm10-1:27031', role: 'primary', lagMs: null },
      { member: 'm10-2:27032', role: 'secondary', lagMs: 12_500 },
    ]);
    expect(lagging).toEqual([{ member: 'm10-2:27032', lagMs: 12_500 }]); // past the 10 s alert
    expect(observeHeartbeat('m10-3:27033', { secondary: true, lastWrite: { lastWriteDate: new Date(t - 2_000) } }, t, 10_000)).toEqual([
      { member: 'm10-2:27032', lagMs: 12_500 },
    ]);
  });

  it('ignores a reply with no lastWrite (a standalone, an arbiter)', () => {
    expect(observeHeartbeat('solo:27017', { isWritablePrimary: true }, Date.now(), 10_000)).toEqual([]);
    expect(replicationLagSnapshot().members).toEqual([]);
  });
});

/** A primary and one secondary `lagMs` behind it, as the driver's heartbeats report them now. */
function setLag(lagMs: number): void {
  const now = Date.now();
  observeHeartbeat('p:27031', { isWritablePrimary: true, lastWrite: { lastWriteDate: new Date(now) } }, now, 10_000);
  observeHeartbeat('s:27032', { secondary: true, lastWrite: { lastWriteDate: new Date(now - lagMs) } }, now, 10_000);
}

describe('replication lag counts against the staleness budget (data ≤ 45 s, or flagged)', () => {
  beforeEach(() => resetReplicationLag());
  afterEach(() => resetReplicationLag());

  it('userReadLagMs: the worst secondary a user read can be routed to — not one past maxStaleness, nor one gone silent', () => {
    const now = Date.now();
    expect(userReadLagMs(now)).toBe(0); // nothing known yet
    observeHeartbeat('p:1', { isWritablePrimary: true, lastWrite: { lastWriteDate: new Date(now) } }, now, 10_000);
    expect(userReadLagMs(now)).toBe(0); // primary only: reads go there
    observeHeartbeat('s:2', { secondary: true, lastWrite: { lastWriteDate: new Date(now - 20_000) } }, now, 10_000);
    observeHeartbeat('s:3', { secondary: true, lastWrite: { lastWriteDate: new Date(now - 4_000) } }, now, 10_000);
    expect(userReadLagMs(now)).toBe(20_000);
    // 130 s behind: past maxStalenessSeconds 120 — the driver never reads it.
    observeHeartbeat('s:2', { secondary: true, lastWrite: { lastWriteDate: new Date(now - 130_000) } }, now, 10_000);
    expect(userReadLagMs(now)).toBe(4_000);
    // A member heard from more than a minute ago is not routed to.
    expect(userReadLagMs(now + 61_000)).toBe(0);
  });

  it('a positions window read from a secondary 60 s behind is served FLAGGED (dataAsOf = now − lag), and counted', async () => {
    const repo = positionsRepo(() => [{ positionId: '1', tokenId: '1', metrics: {} }]);
    setLag(60_000);
    const before = Date.now();
    const page = await repo.findLeaderboard(query());
    expect(page.dataAsOf).toBeGreaterThanOrEqual(before - 60_000);
    expect(page.dataAsOf).toBeLessThanOrEqual(Date.now() - 60_000);
    expect(readPathSnapshot().staleServed.positions?.count).toBe(1);
    // …and the cached copy stays flagged while it is served: the lag it was read with sticks to it.
    resetReplicationLag();
    const again = await repo.findLeaderboard(query());
    expect(again.cache).toBe('hit');
    expect(again.dataAsOf).toBe(page.dataAsOf);
  });

  it('a few seconds of lag inside the budget: no flag (stale × 1.1 + lag ≤ 45 s)', async () => {
    const repo = positionsRepo(() => [{ positionId: '1', tokenId: '1', metrics: {} }]);
    setLag(5_000);
    const page = await repo.findLeaderboard(query());
    expect(page.dataAsOf).toBeUndefined();
  });

  it('a window read 40 s behind passes (40 ≤ 45 s); the SAME cached copy is flagged once its data passes 45 s', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const repo = positionsRepo(() => [{ positionId: '1', tokenId: '1', metrics: {} }]);
    setLag(40_000);
    const readAt = Date.now();
    expect((await repo.findLeaderboard(query())).dataAsOf).toBeUndefined();
    vi.setSystemTime(readAt + 10_000); // a fresh HIT — but its data is now 50 s old
    const hit = await repo.findLeaderboard(query());
    expect(hit.cache).toBe('hit');
    expect(hit.dataAsOf).toBe(readAt - 40_000);
  });

  it('a pools window read under the same lag is flagged too', async () => {
    const model = {
      find: () => {
        const q: Record<string, unknown> = {};
        for (const m of ['sort', 'skip', 'limit', 'read', 'maxTimeMS', 'select']) q[m] = () => q;
        q.lean = async () => [{ poolId: '0xa', chainId: 1, metrics: { tvlUsd: 1 } }];
        return q;
      },
    };
    const repo = new PoolsRepository({ poolModel: () => model } as never, { readyLeaderboardExclusions: async () => ({ addresses: [], ok: true }) } as never);
    setLag(50_000);
    const page = await repo.findPoolsLeaderboard({ chainId: 1, protocol: 'uniswap-v4', sort: 'tvl', page: 1, limit: 20, minTvlUsd: 0, includeRisky: false });
    expect(page.dataAsOf).toBeLessThanOrEqual(Date.now() - 50_000);
  });

  it('holder counts counted under that lag — and a cached one served while it lasts — flag the pools response', async () => {
    const aggregate = vi.fn(() => [{ _id: '0xabc', positionsCount: 3, holdersCount: 2 }]);
    const model = {
      aggregate: () => {
        const q: Record<string, unknown> = {};
        for (const m of ['read', 'option', 'hint']) q[m] = () => q;
        q.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve().then(aggregate).then(resolve, reject);
        return q;
      },
    };
    const positions = new PositionsRepository({ positionModel: () => model } as never, { readyLeaderboardExclusions: async () => ({ addresses: [], ok: true }) } as never);
    setLag(60_000);
    const counted: { dataAsOf?: number } = {};
    await positions.countsByPoolIds(1, 'uniswap-v4', ['0xabc'], counted);
    expect(counted.dataAsOf).toBeLessThanOrEqual(Date.now() - 60_000);
    const hit: { dataAsOf?: number } = {};
    await positions.countsByPoolIds(1, 'uniswap-v4', ['0xabc'], hit); // a fresh HIT, still carrying its lag
    expect(aggregate).toHaveBeenCalledTimes(1);
    expect(hit.dataAsOf).toBe(counted.dataAsOf);
    const calm = new PositionsRepository({ positionModel: () => model } as never, { readyLeaderboardExclusions: async () => ({ addresses: [], ok: true }) } as never);
    setLag(2_000);
    const ok: { dataAsOf?: number } = {};
    await calm.countsByPoolIds(1, 'uniswap-v4', ['0xabc'], ok);
    expect(ok.dataAsOf).toBeUndefined();
  });

  it('the /count route answers a count read under that lag with stale + dataAsOf, no-store', async () => {
    const counts = new LeaderboardCountService();
    setLag(60_000);
    const meta: { noStore?: boolean } = {};
    const res = await resolveCountRoute({
      route: 'positions',
      counts,
      meta,
      tasks: async () => [{ key: 'k', run: async () => ({ count: 7, capped: false }) }],
    });
    expect(res).toMatchObject({ total: 7, capped: false, stale: true });
    expect(Date.parse(res.dataAsOf!)).toBeLessThanOrEqual(Date.now() - 60_000);
    expect(meta.noStore).toBe(true);
    resetReplicationLag();
    const fresh = await resolveCountRoute({
      route: 'positions',
      counts: new LeaderboardCountService(),
      tasks: async () => [{ key: 'k', run: async () => ({ count: 7, capped: false }) }],
    });
    expect(fresh).toEqual({ total: 7, capped: false });
  });

  it('position detail read under that lag says so (stale + dataAsOf, no-store); within it, nothing', async () => {
    const positions = { findOneForRead: async () => ({ positionId: '9', isActive: false, token0: { address: '0xa' }, token1: { address: '0xb' }, metrics: {}, poolStats: {}, pricing: { source: 'dex' }, amounts: {} }) };
    const svc = new LeaderboardService(
      { isSupportedChain: () => true, isSupportedProtocol: () => true, enabledIntegrations: [], getIntegration: () => undefined } as never,
      positions as never,
      { findForPosition: async () => [] } as never,
      { resolve: () => ({ recomputeMode: 'transactions' }) } as never,
    );
    setLag(60_000);
    const meta: { noStore?: boolean } = {};
    const detail = await svc.getPosition(1, 'uniswap-v4', '9', meta);
    expect(detail).toMatchObject({ stale: true });
    expect(meta.noStore).toBe(true);
    setLag(2_000);
    expect(await svc.getPosition(1, 'uniswap-v4', '9')).not.toHaveProperty('stale');
  });
});

describe('pool detail does not stack its caches (review finding)', () => {
  const poolDoc = { poolId: '0xAbC', chainId: 1, protocol: 'uniswap-v4', token0: { address: '0xa' }, token1: { address: '0xb' }, fee: 3000, metrics: { tvlUsd: 1, feeApr: 0 } };
  const svcWith = (countsByPoolIds: (...args: unknown[]) => Promise<Map<string, unknown>>, findPoolById = vi.fn(async () => poolDoc)) =>
    new PoolsService(
      { isSupportedChain: () => true, isSupportedProtocol: () => true } as never,
      { findPoolById } as never,
      { countsByPoolIds } as never,
      { findLatestPrices: async () => new Map() } as never,
      new LeaderboardCountService(),
    );

  it('a holder count kept long past its stale age makes the detail older than the budget: flagged (dataAsOf = the count\'s), every time', async () => {
    const countAt = Date.now() - 10 * 60_000;
    const svc = svcWith(async (_c, _p, _ids, meta) => {
      Object.assign(meta as object, { dataAsOf: countAt, storedAt: countAt, dataAt: countAt });
      return new Map([['0xabc', { positionsCount: 4, holdersCount: 3 }]]);
    });
    for (let i = 0; i < 2; i++) {
      const meta: { noStore?: boolean } = {};
      const detail = (await svc.getPool(1, 'uniswap-v4', '0xabc', meta)) as unknown as { stale: boolean; dataAsOf: string; positionsCount: number };
      expect(detail).toMatchObject({ stale: true, positionsCount: 4 });
      expect(Date.parse(detail.dataAsOf)).toBe(countAt);
      expect(meta.noStore).toBe(true);
    }
  });

  it('a count COUNTED under lag (recent, but its data 60 s old) flags the detail too', async () => {
    const svc = svcWith(async (_c, _p, _ids, meta) => {
      Object.assign(meta as object, { storedAt: Date.now(), dataAt: Date.now() - 60_000 });
      return new Map([['0xabc', { positionsCount: 4, holdersCount: 3 }]]);
    });
    expect(await svc.getPool(1, 'uniswap-v4', '0xabc')).toMatchObject({ stale: true });
  });

  it('a pool read from a secondary lagging past the budget is flagged even with fresh counts', async () => {
    setLag(60_000);
    try {
      const svc = svcWith(async (_c, _p, _ids, meta) => {
        Object.assign(meta as object, { storedAt: Date.now(), dataAt: Date.now() });
        return new Map([['0xabc', { positionsCount: 4, holdersCount: 3 }]]);
      });
      expect(await svc.getPool(1, 'uniswap-v4', '0xabc')).toMatchObject({ stale: true });
    } finally {
      resetReplicationLag();
    }
  });

  it('a detail built from a 20 s old count is stored 20 s old (stale at once), not new', async () => {
    const findPoolById = vi.fn(async () => poolDoc);
    const svc = svcWith(async (_c, _p, _ids, meta) => {
      const at = Date.now() - 20_000;
      Object.assign(meta as object, { storedAt: at, dataAt: at });
      return new Map([['0xabc', { positionsCount: 4, holdersCount: 3 }]]);
    }, findPoolById);
    await svc.getPool(1, 'uniswap-v4', '0xabc');
    const meta: { cache?: string } = {};
    const second = await svc.getPool(1, 'uniswap-v4', '0xabc', meta);
    // Past the 15 s fresh age already: served stale + one background refresh — it would have been a 'hit' for 15 s more.
    expect(meta.cache).toBe('stale');
    expect(second).not.toHaveProperty('stale'); // 20 s of data: inside the budget, unflagged
    await vi.waitFor(() => expect(findPoolById).toHaveBeenCalledTimes(2));
  });
});
