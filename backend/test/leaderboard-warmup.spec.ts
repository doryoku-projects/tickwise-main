import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LeaderboardCountService } from '../src/leaderboard/count-cache.js';
import { LeaderboardWarmupService } from '../src/leaderboard/leaderboard-warmup.service.js';

function config(over: Record<string, unknown> = {}) {
  return {
    leaderboardWarmupEnabled: true,
    leaderboardSnapshotRedisEnabled: true,
    leaderboardCountCap: 25_000,
    leaderboardSnapshotNamespace: 'prod0000aaaa1111',
    redisUrl: 'redis://127.0.0.1:1',
    enabledIntegrations: [
      { chainId: 1, protocol: 'uniswap-v4' },
      { chainId: 42161, protocol: 'uniswap-v4' },
    ],
    ...over,
  };
}

/**
 * A positions repository whose window keys are readable, which records warms
 * and primes, and which ages each window from when it was last warmed (gone
 * past 5 min, like the real stale age). `lastLeaderboardReadAt` defaults to
 * "a user just read", i.e. the landing page is being browsed.
 */
function fakePositions() {
  const keyOf = (q: { chainId: number; sort: string }) => `${q.chainId}|${q.sort}|w50`;
  const warmedAt = new Map<string, number>();
  return {
    warmed: [] as Array<Record<string, unknown>>,
    primed: [] as Array<{ key: string; rows: unknown[]; storedAt: number }>,
    warmedAt,
    lastLeaderboardReadAt: Date.now(),
    leaderboardWindowAgeMs: vi.fn(async (q: { chainId: number; sort: string }) => {
      const at = warmedAt.get(keyOf(q));
      if (at === undefined) return undefined;
      const age = Date.now() - at;
      return age < 5 * 60_000 ? age : undefined;
    }),
    warmLeaderboardWindow: vi.fn(async function (this: { warmed: unknown[] }, q: { chainId: number; sort: string }, maxTimeMS: number) {
      (this.warmed as Array<Record<string, unknown>>).push({ ...q, maxTimeMS });
      warmedAt.set(keyOf(q), Date.now());
      return { key: keyOf(q), rows: [{ positionId: `${q.chainId}-${q.sort}` }] };
    }),
    leaderboardPlan: vi.fn(async (q: { chainId: number; sort: string }) => ({
      countKey: `count|${q.chainId}|${['apr', 'fee_apr', 'roi'].includes(q.sort) ? 'rate' : q.sort}`,
    })),
    countLeaderboard: vi.fn(async () => ({ count: 10, capped: false })),
    leaderboardWindowKey: vi.fn(async (q: { chainId: number; sort: string }) => keyOf(q)),
    primeLeaderboardWindow: vi.fn(function (this: { primed: unknown[] }, key: string, rows: unknown[], storedAt: number) {
      (this.primed as unknown[]).push({ key, rows, storedAt });
      return true;
    }),
  };
}

/** Enough of ioredis for the snapshot path. */
function fakeRedis() {
  const store = new Map<string, { value: Buffer; ex: number }>();
  return {
    store,
    status: 'ready',
    set: vi.fn(async (key: string, value: Buffer, _ex: string, seconds: number) => {
      store.set(key, { value, ex: seconds });
      return 'OK';
    }),
    getBuffer: vi.fn(async (key: string) => store.get(key)?.value ?? null),
    quit: async () => 'OK',
  };
}

function makeService(positions = fakePositions(), cfg = config()) {
  const svc = new LeaderboardWarmupService(cfg as never, positions as never, new LeaderboardCountService());
  return { svc, positions };
}

afterEach(() => vi.useRealTimers());

describe('LeaderboardWarmupService', () => {
  it('warms the landing filters × 8 sorts × every enabled shard, with its own time budget', async () => {
    const { svc, positions } = makeService();
    const result = await svc.runCycle();
    expect(result).toEqual({ warmed: 16, failed: 0 });
    expect(positions.warmed[0]).toMatchObject({
      chainId: 1,
      page: 1,
      limit: 25,
      status: 'active',
      range: 'in',
      minValueUsd: 500,
      minPoolTvl: 1000,
      includeRisky: false,
      maxTimeMS: 15_000,
    });
    expect(new Set(positions.warmed.map((w) => w.sort)).size).toBe(8);
    // Counts depend on the filter, not the sort: the 3 rate sorts share one.
    await new Promise((r) => setTimeout(r, 0));
    expect(positions.countLeaderboard).toHaveBeenCalledTimes(2 * 6);
  });

  it('skips a tick while a cycle is still running', async () => {
    const { svc, positions } = makeService();
    let release!: () => void;
    positions.warmLeaderboardWindow.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve(null))) as never,
    );
    const first = svc.runCycle();
    expect(await svc.runCycle()).toBeNull();
    await vi.waitFor(() => expect(positions.warmLeaderboardWindow).toHaveBeenCalled());
    expect(await svc.runCycle()).toBeNull(); // still running, mid-read
    release();
    await first;
  });

  it('writes each window to Redis gzipped with EX 45 (the staleness budget), and a new process loads it back', async () => {
    const redis = fakeRedis();
    const { svc } = makeService();
    (svc as unknown as { redis: unknown }).redis = redis;
    await svc.runCycle();
    expect(redis.store.size).toBe(16);
    const [key, entry] = [...redis.store.entries()][0];
    expect(key).toMatch(/^tw:lb:snap:v1:prod0000aaaa1111:[0-9a-f]{40}$/);
    expect(entry.ex).toBe(45); // the staleness budget — a hard TTL on every L2 entry (it was 300)
    const snapshot = JSON.parse(gunzipSync(entry.value).toString('utf8'));
    expect(snapshot).toMatchObject({ v: 1, ns: 'prod0000aaaa1111', key: '1|apr|w50', rows: [{ positionId: '1-apr' }] });

    const next = makeService();
    (next.svc as unknown as { redis: unknown }).redis = redis;
    expect(await next.svc.loadSnapshots()).toBe(16);
    expect(next.positions.primed[0]).toMatchObject({ key: '1|apr|w50', rows: [{ positionId: '1-apr' }] });
  });

  it('ignores a snapshot whose payload names a different window (never primes the wrong key)', async () => {
    const redis = fakeRedis();
    const { svc } = makeService();
    (svc as unknown as { redis: unknown }).redis = redis;
    await svc.runCycle();
    // Swap two payloads: each Redis key now holds another window's rows.
    const [[k1, e1], [k2, e2]] = [...redis.store.entries()];
    redis.store.set(k1, e2);
    redis.store.set(k2, e1);
    const next = makeService();
    (next.svc as unknown as { redis: unknown }).redis = redis;
    expect(await next.svc.loadSnapshots()).toBe(14);
    expect(next.positions.primed.every((p) => p.key === `${(p.rows[0] as { positionId: string }).positionId.replace('-', '|')}|w50`)).toBe(true);
  });

  it('never loads a snapshot another deployment wrote (a dev box on the prod Redis)', async () => {
    const redis = fakeRedis();
    const dev = makeService(fakePositions(), config({ leaderboardSnapshotNamespace: 'devbeefdevbeef00' }));
    (dev.svc as unknown as { redis: unknown }).redis = redis;
    await dev.svc.runCycle();
    expect(redis.store.size).toBe(16);
    // Prod boots on the same Redis: its keys are elsewhere, so nothing is primed.
    const prod = makeService();
    (prod.svc as unknown as { redis: unknown }).redis = redis;
    expect(await prod.svc.loadSnapshots()).toBe(0);
    // Even a payload copied under prod's own key name is refused on its ns.
    for (const [k, v] of [...redis.store.entries()]) redis.store.set(k.replace('devbeefdevbeef00', 'prod0000aaaa1111'), v);
    expect(await prod.svc.loadSnapshots()).toBe(0);
    expect(prod.positions.primed).toHaveLength(0);
  });

  it('fails open when Redis errors — the warm still happens', async () => {
    const redis = fakeRedis();
    redis.set.mockRejectedValue(new Error('ECONNREFUSED'));
    redis.getBuffer.mockRejectedValue(new Error('ECONNREFUSED'));
    const { svc } = makeService();
    (svc as unknown as { redis: unknown }).redis = redis;
    expect(await svc.loadSnapshots()).toBe(0);
    expect(await svc.runCycle()).toEqual({ warmed: 16, failed: 0 });
  });

  it('does nothing at all when LEADERBOARD_WARMUP_ENABLED=false', async () => {
    vi.useFakeTimers();
    const { svc, positions } = makeService(fakePositions(), config({ leaderboardWarmupEnabled: false }));
    svc.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(positions.warmLeaderboardWindow).not.toHaveBeenCalled();
    expect((svc as unknown as { redis?: unknown }).redis).toBeUndefined();
    svc.onModuleDestroy();
  });

  it('runs on a 10 s timer by default (Redis snapshots off), re-reading a window once it is no longer fresh (15 s)', async () => {
    vi.useFakeTimers();
    const positions = fakePositions();
    const { svc } = makeService(positions, config({ leaderboardSnapshotRedisEnabled: false }));
    svc.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    expect(positions.warmLeaderboardWindow).toHaveBeenCalledTimes(16);
    positions.lastLeaderboardReadAt = Date.now() + 60_000; // still browsed
    await vi.advanceTimersByTimeAsync(9_999);
    expect(positions.warmLeaderboardWindow).toHaveBeenCalledTimes(16); // no tick yet
    await vi.advanceTimersByTimeAsync(1);
    // 10 s old: still FRESH (15 s) — re-reading it now would be wasted secondary work.
    expect(positions.warmLeaderboardWindow).toHaveBeenCalledTimes(16);
    positions.lastLeaderboardReadAt = Date.now() + 60_000;
    await vi.advanceTimersByTimeAsync(10_000);
    // 20 s old: past fresh, inside the stale age (27 s at the shortest jitter) — re-read before it expires.
    expect(positions.warmLeaderboardWindow).toHaveBeenCalledTimes(32);
    svc.onModuleDestroy();
  });

  it('takes its tick and minimum age from config (LEADERBOARD_WARMUP_INTERVAL_MS / _MIN_AGE_MS)', async () => {
    vi.useFakeTimers();
    const positions = fakePositions();
    const { svc } = makeService(
      positions,
      config({ leaderboardSnapshotRedisEnabled: false, leaderboardWarmupIntervalMs: 10_000, leaderboardWarmupMinAgeMs: 12_000 }),
    );
    svc.onApplicationBootstrap();
    await vi.advanceTimersByTimeAsync(0);
    expect(positions.warmLeaderboardWindow).toHaveBeenCalledTimes(16);
    positions.lastLeaderboardReadAt = Date.now() + 60_000;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(positions.warmLeaderboardWindow).toHaveBeenCalledTimes(16); // 10 s old < 12 s: left alone
    positions.lastLeaderboardReadAt = Date.now() + 60_000;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(positions.warmLeaderboardWindow).toHaveBeenCalledTimes(32);
    svc.onModuleDestroy();
  });

  it('a window a user request refreshed recently is not read again', async () => {
    const positions = fakePositions();
    positions.warmedAt.set('1|apr|w50', Date.now() - 5_000);
    const { svc } = makeService(positions);
    expect(await svc.runCycle()).toEqual({ warmed: 15, failed: 0 });
    expect(positions.warmed.some((w) => w.chainId === 1 && w.sort === 'apr')).toBe(false);
  });

  it('with nobody browsing (or right after boot) only the default sort is kept warm', async () => {
    const positions = fakePositions();
    positions.lastLeaderboardReadAt = 0;
    const { svc } = makeService(positions);
    expect(await svc.runCycle()).toEqual({ warmed: 2, failed: 0 });
    expect(positions.warmed.map((w) => w.sort)).toEqual(['apr', 'apr']);
  });

  it('stops starting reads after its wall-time budget — oldest first, the rest next cycle', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const positions = fakePositions();
    // Every read takes 8 s, as the ranked query does before the Set R indexes.
    positions.warmLeaderboardWindow.mockImplementation(async function (this: unknown, q: { chainId: number; sort: string }) {
      vi.setSystemTime(Date.now() + 8_000);
      positions.warmed.push({ ...q });
      positions.warmedAt.set(`${q.chainId}|${q.sort}|w50`, Date.now());
      return { key: `${q.chainId}|${q.sort}|w50`, rows: [] };
    });
    // One window is cached but 4 min old: older than the rest only if they are cached too.
    positions.warmedAt.set('42161|pnl|w50', Date.now() - 4 * 60_000);
    const { svc } = makeService(positions);
    const first = await svc.runCycle();
    expect(first).toEqual({ warmed: 4, failed: 0, deferred: 12 }); // 4 × 8 s crosses 30 s
    positions.lastLeaderboardReadAt = Date.now();
    const second = await svc.runCycle();
    // The windows the first cycle did not reach come first now; the 4 it read are young.
    expect(second?.warmed).toBe(4);
    const firstFour = positions.warmed.slice(0, 4).map((w) => `${w.chainId}|${w.sort}`);
    const nextFour = positions.warmed.slice(4, 8).map((w) => `${w.chainId}|${w.sort}`);
    expect(nextFour.some((k) => firstFour.includes(k))).toBe(false);
  });

  it('the windows closest to expiring are read first', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const positions = fakePositions();
    positions.warmLeaderboardWindow.mockImplementation(async function (this: unknown, q: { chainId: number; sort: string }) {
      vi.setSystemTime(Date.now() + 8_000);
      positions.warmed.push({ ...q });
      return { key: `${q.chainId}|${q.sort}|w50`, rows: [] };
    });
    // All 16 cached, aged 2:00 … 4:45 in an order unrelated to the query order.
    const svcForQueries = makeService(positions).svc;
    const keys = svcForQueries.landingQueries().map((q) => `${q.chainId}|${q.sort}|w50`);
    const ages = keys.map((_, i) => 120_000 + ((i * 7) % 16) * 11_000);
    keys.forEach((key, i) => positions.warmedAt.set(key, Date.now() - ages[i]!));
    const oldest = keys
      .map((key, i) => ({ key, age: ages[i]! }))
      .sort((a, b) => b.age - a.age)
      .slice(0, 4)
      .map((e) => e.key.replace('|w50', ''));
    await makeService(positions).svc.runCycle();
    expect(positions.warmed.map((w) => `${w.chainId}|${w.sort}`)).toEqual(oldest);
  });
});
