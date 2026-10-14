/*
 * LeaderboardWarmupService as a leader-only poller (capacity plan step 1).
 * Leases on + snapshots on: ONE process (the `leaderboard-warmup` holder) runs
 * the warm cycle and writes `tw:lb:snap` + an index + a heartbeat; the others
 * load the snapshots newer than their own windows every 2 s, and run the cycle
 * themselves only without a live holder or without Redis. Leases off: today.
 */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LeaderboardCountService } from '../../src/leaderboard/count-cache.js';
import { LeaderboardWarmupService } from '../../src/leaderboard/leaderboard-warmup.service.js';
import { configureProcessRole, resetProcessRoleForTests } from '../../src/common/process-role.js';
import { resetLeaseRunnersForTests } from '../../src/common/lease-runner.js';
import { resetShutdownForTests } from '../../src/common/shutdown.js';
import { leaseKey } from '../../src/common/coordination-redis.js';
import { LeaderRedis, coordinationOf } from './fakes.js';

const NS = 'prod0000aaaa1111';

function config(chainIds: number[] = [1]) {
  return {
    leaderboardWarmupEnabled: true,
    leaderboardSnapshotRedisEnabled: true,
    leaderboardCountCap: 25_000,
    leaderboardSnapshotNamespace: NS,
    redisUrl: 'redis://127.0.0.1:1',
    enabledIntegrations: chainIds.map((chainId) => ({ chainId, protocol: 'uniswap-v4' })),
  };
}

function fakePositions(lastReadAt = Date.now()) {
  const keyOf = (q: { chainId: number; sort: string }) => `${q.chainId}|${q.sort}|w50`;
  const warmedAt = new Map<string, number>();
  return {
    warmed: [] as Array<Record<string, unknown>>,
    primed: [] as Array<{ key: string; storedAt: number }>,
    warmedAt,
    lastLeaderboardReadAt: lastReadAt,
    leaderboardWindowAgeMs: vi.fn(async (q: { chainId: number; sort: string }) => {
      const at = warmedAt.get(keyOf(q));
      return at === undefined ? undefined : Date.now() - at;
    }),
    warmLeaderboardWindow: vi.fn(async function (this: { warmed: unknown[] }, q: { chainId: number; sort: string }) {
      (this.warmed as Array<Record<string, unknown>>).push({ ...q });
      warmedAt.set(keyOf(q), Date.now());
      return { key: keyOf(q), rows: [{ positionId: `${q.chainId}-${q.sort}` }] };
    }),
    leaderboardPlan: vi.fn(async (q: { chainId: number; sort: string }) => ({ countKey: `count|${q.chainId}|${q.sort}` })),
    countLeaderboard: vi.fn(async () => ({ count: 10, capped: false })),
    leaderboardWindowKey: vi.fn(async (q: { chainId: number; sort: string }) => keyOf(q)),
    primeLeaderboardWindow: vi.fn(function (this: { primed: unknown[] }, key: string, _rows: unknown[], storedAt: number) {
      (this.primed as unknown[]).push({ key, storedAt });
      warmedAt.set(key, storedAt);
      return true;
    }),
    /** No read: the cached window (still servable) with when it was stored. */
    peekLeaderboardWindow: vi.fn(async (q: { chainId: number; sort: string }) => {
      const key = keyOf(q);
      const at = warmedAt.get(key);
      if (at === undefined || Date.now() - at >= 30_000) return undefined;
      return { key, rows: [{ positionId: `${q.chainId}-${q.sort}-cached` }], storedAt: at };
    }),
  };
}

/** A rank engine stub: `serves` = this replica's engine answers the shard (reduced cycle there). */
function rankStub(serves: boolean | ((chainId: number) => boolean)) {
  return {
    warmupReduced: vi.fn((chainIds: number[]) => (typeof serves === 'function' ? serves(chainIds[0]) : serves)),
  };
}

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');
const isRunning = (svc: LeaderboardWarmupService) => (svc as unknown as { running: boolean }).running;

const services: LeaderboardWarmupService[] = [];

afterEach(() => {
  for (const svc of services.splice(0)) svc.onModuleDestroy();
  resetProcessRoleForTests();
  resetLeaseRunnersForTests();
  resetShutdownForTests();
  vi.restoreAllMocks();
});

/** Bootstrap with the snapshot client swapped for the fake (the real one is never connected). */
function boot(
  redis: LeaderRedis,
  positions = fakePositions(),
  opts: { coordination?: boolean; rank?: ReturnType<typeof rankStub>; chainIds?: number[] } = {},
) {
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const svc = new LeaderboardWarmupService(
    config(opts.chainIds) as never,
    positions as never,
    new LeaderboardCountService(),
    opts.rank as never,
    (opts.coordination === false ? undefined : coordinationOf(redis, NS)) as never,
  );
  services.push(svc);
  Object.assign(redis, { status: 'ready', quit: async () => 'OK' });
  const internals = svc as unknown as { redis?: { disconnect(): void } };
  svc.onApplicationBootstrap();
  internals.redis?.disconnect();
  internals.redis = redis as never;
  return { svc, positions };
}

const isWarmKey = (k: string) => k.startsWith('tw:lb:warm:') || k.startsWith('tw:lb:snapidx:');

describe('leaderboard warmup — leases OFF', () => {
  it('runs its own cycle and writes only the snapshots (no index, heartbeat or lastread)', async () => {
    const redis = new LeaderRedis();
    const { positions } = boot(redis);
    await vi.waitFor(() => expect(positions.warmed.length).toBeGreaterThan(0));
    await vi.waitFor(() => expect([...redis.kv.keys()].some((k) => k.startsWith('tw:lb:snap:v1:'))).toBe(true));
    expect([...redis.kv.keys()].filter(isWarmKey)).toEqual([]);
    expect(redis.hashes.size).toBe(0);
  });
});

describe('leaderboard warmup — leases ON', () => {
  it('the holder warms, writes snapshots, indexes them and beats', async () => {
    configureProcessRole({ processRole: 'api' });
    const redis = new LeaderRedis();
    const { positions } = boot(redis);
    await vi.waitFor(() => expect(redis.kv.has(`tw:lb:warm:v1:${NS}:leader`)).toBe(true));
    await vi.waitFor(() => expect(positions.warmed.length).toBe(8));
    const index = await redis.hgetall(`tw:lb:snapidx:v1:${NS}`);
    expect(Object.keys(index)).toHaveLength(8);
  });

  async function holderAndFollower() {
    configureProcessRole({ processRole: 'api' });
    const redis = new LeaderRedis();
    const holder = boot(redis);
    await vi.waitFor(() => expect(redis.hashes.get(`tw:lb:snapidx:v1:${NS}`)?.size).toBe(8));
    const follower = boot(redis, fakePositions());
    return { redis, holder, follower };
  }

  it('a follower loads the holder\'s snapshots and reads nothing from Mongo', async () => {
    const { follower } = await holderAndFollower();
    await follower.svc.followCycle();
    expect(follower.positions.primed).toHaveLength(8);
    expect(follower.positions.warmed).toHaveLength(0);
    // A second tick with nothing newer loads nothing.
    await follower.svc.followCycle();
    expect(follower.positions.primed).toHaveLength(8);
  });

  it('a follower keeps a window it refreshed more recently than the snapshot', async () => {
    const { follower } = await holderAndFollower();
    follower.positions.warmedAt.set('1|apr|w50', Date.now() + 1_000);
    await follower.svc.followCycle();
    expect(follower.positions.primed.map((p) => p.key)).not.toContain('1|apr|w50');
    expect(follower.positions.primed).toHaveLength(7);
  });

  it('without a live holder heartbeat a follower warms itself — at the cycle period, not every tick', async () => {
    configureProcessRole({ processRole: 'api' });
    const redis = new LeaderRedis();
    redis.steal(leaseKey(NS, 'leaderboard-warmup'), 'dead-holder', 10 * 60_000);
    const follower = boot(redis);
    await follower.svc.followCycle();
    expect(follower.positions.warmed.length).toBe(8);
    const before = follower.positions.warmed.length;
    follower.positions.warmedAt.clear();
    await follower.svc.followCycle();
    expect(follower.positions.warmed.length).toBe(before); // throttled to the 10 s period
  });

  it('a stale heartbeat counts as no holder', async () => {
    configureProcessRole({ processRole: 'api' });
    const redis = new LeaderRedis();
    redis.steal(leaseKey(NS, 'leaderboard-warmup'), 'dead-holder', 10 * 60_000);
    await redis.set(`tw:lb:warm:v1:${NS}:leader`, JSON.stringify({ v: 1, at: Date.now() - 10 * 60_000 }), 'PX', 60_000);
    const follower = boot(redis);
    await follower.svc.followCycle();
    expect(follower.positions.warmed.length).toBe(8);
  });

  it('without Redis a follower warms itself', async () => {
    configureProcessRole({ processRole: 'api' });
    const redis = new LeaderRedis();
    redis.steal(leaseKey(NS, 'leaderboard-warmup'), 'other', 10 * 60_000);
    const follower = boot(redis);
    (redis as unknown as { status: string }).status = 'end';
    await follower.svc.followCycle();
    expect(follower.positions.warmed.length).toBe(8);
  });

  it('the holder\'s idle rule sees a read served by a follower', async () => {
    configureProcessRole({ processRole: 'api' });
    const redis = new LeaderRedis();
    const idleHolder = fakePositions(0); // nobody read through the holder
    const holder = boot(redis, idleHolder);
    await vi.waitFor(() => expect(idleHolder.warmed.length).toBe(1)); // idle: the default sort only
    expect(idleHolder.warmed[0]).toMatchObject({ sort: 'apr' });

    const follower = boot(redis, fakePositions(Date.now())); // a user is browsing on the follower
    await follower.svc.followCycle();
    expect(await redis.get(`tw:lb:warm:v1:${NS}:lastread`)).not.toBeNull();

    await (holder.svc as unknown as { leadCycle(): Promise<void> }).leadCycle();
    expect(new Set(idleHolder.warmed.map((w) => w.sort)).size).toBe(8);
  });
});

describe('leaderboard warmup — leases ON, review fixes', () => {
  async function holderAndFollower(rank?: { holder?: boolean; follower?: boolean }) {
    configureProcessRole({ processRole: 'api' });
    const redis = new LeaderRedis();
    const holder = boot(redis, fakePositions(), { rank: rank?.holder === undefined ? undefined : rankStub(rank.holder) });
    return { redis, holder };
  }

  it('the holder snapshots a window its own traffic refreshed, from the cache (no read), with that window\'s storedAt', async () => {
    const { redis, holder } = await holderAndFollower();
    await vi.waitFor(() => expect(redis.hashes.get(`tw:lb:snapidx:v1:${NS}`)?.size).toBe(8));
    await vi.waitFor(() => expect(isRunning(holder.svc)).toBe(false));
    const follower = boot(redis, fakePositions());
    await follower.svc.followCycle();
    expect(follower.positions.primed).toHaveLength(8);

    // A user request on the holder refreshes a landing window in the background.
    await new Promise((r) => setTimeout(r, 5));
    const refreshedAt = Date.now();
    holder.positions.warmedAt.set('1|fee_apr|w50', refreshedAt);

    // The next cycle runs 3 s later: the snapshot must carry the window's storedAt, not "now".
    const realNow = Date.now.bind(Date);
    const later = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 3_000);
    await holder.svc.runCycle();
    later.mockRestore();
    expect(holder.positions.warmed).toHaveLength(8); // no Mongo read: the window is not due
    expect(redis.hashes.get(`tw:lb:snapidx:v1:${NS}`)?.get(sha1('1|fee_apr|w50'))).toBe(String(refreshedAt));

    // The follower (no traffic of its own) now ages its copy from the refresh, not the old snapshot.
    await follower.svc.followCycle();
    expect(follower.positions.primed.at(-1)).toEqual({ key: '1|fee_apr|w50', storedAt: refreshedAt });

    // Unchanged windows are not written again.
    const hsets = redis.calls.filter((c) => c === 'hset').length;
    await holder.svc.runCycle();
    expect(redis.calls.filter((c) => c === 'hset').length).toBe(hsets);
  });

  it('leases OFF: a window refreshed by traffic is not snapshotted from the cache (today)', async () => {
    const redis = new LeaderRedis();
    const { svc, positions } = boot(redis);
    await vi.waitFor(() => expect(positions.warmed.length).toBe(8));
    await vi.waitFor(() => expect(isRunning(svc)).toBe(false));
    positions.warmedAt.set('1|fee_apr|w50', Date.now() + 5);
    await svc.runCycle();
    expect(positions.peekLeaderboardWindow).not.toHaveBeenCalled();
  });

  it('a follower skips index entries older than the snapshot TTL (no GET of an expired snapshot every tick)', async () => {
    const { redis } = await holderAndFollower();
    await vi.waitFor(() => expect(redis.hashes.get(`tw:lb:snapidx:v1:${NS}`)?.size).toBe(8));
    const follower = boot(redis, fakePositions());
    await follower.svc.followCycle();
    // The holder stopped warming `roi` (idle / reduced): its snapshot expired, its index entry did not.
    redis.drop([...redis.kv.keys()].find((k) => k.endsWith(sha1('1|roi|w50')))!);
    redis.hashes.get(`tw:lb:snapidx:v1:${NS}`)!.set(sha1('1|roi|w50'), String(Date.now() - 60_000));
    follower.positions.warmedAt.delete('1|roi|w50'); // expired locally too
    const gets = vi.spyOn(redis, 'getBuffer');
    await follower.svc.followCycle();
    expect(gets).not.toHaveBeenCalled();
  });

  it('a follower whose engine does not serve a shard the holder reduces warms that shard\'s other sorts itself', async () => {
    const { redis, holder } = await holderAndFollower({ holder: true });
    const beatKey = `tw:lb:warm:v1:${NS}:leader`;
    await vi.waitFor(async () => expect(JSON.parse((await redis.get(beatKey))!).reduced).toEqual(['1:uniswap-v4']));
    expect(holder.positions.warmed.map((w) => w.sort)).toEqual(['apr']); // reduced: default sort only

    const degraded = boot(redis, fakePositions(), { rank: rankStub(false) });
    await degraded.svc.followCycle();
    expect(degraded.positions.primed.map((p) => p.key)).toEqual(['1|apr|w50']); // the holder's default sort
    expect(degraded.positions.warmed.map((w) => w.sort).sort()).toEqual(
      ['age', 'fee_apr', 'nft_id_asc', 'nft_id_desc', 'pnl', 'roi', 'underlying_value'],
    );
    // At the cycle period, not every 2 s tick.
    const cycles = vi.spyOn(degraded.svc, 'runCycle');
    await degraded.svc.followCycle();
    expect(cycles).not.toHaveBeenCalled();

    // A follower whose own engine serves the shard too needs nothing more (not even the fleet read time).
    const serving = boot(redis, fakePositions(), { rank: rankStub(true) });
    const gets = vi.spyOn(redis, 'get');
    await serving.svc.followCycle();
    expect(serving.positions.warmed).toHaveLength(0);
    expect(gets.mock.calls.map(([k]) => k)).not.toContain(`tw:lb:warm:v1:${NS}:lastread`);
  });

  it('the follower covers only the shards the holder reduces, never the ones the holder warms', async () => {
    configureProcessRole({ processRole: 'api' });
    const redis = new LeaderRedis();
    const holder = boot(redis, fakePositions(), { rank: rankStub((chainId) => chainId === 1), chainIds: [1, 42161] });
    const beatKey = `tw:lb:warm:v1:${NS}:leader`;
    await vi.waitFor(async () => expect(JSON.parse((await redis.get(beatKey))!).reduced).toEqual(['1:uniswap-v4']));
    await vi.waitFor(() => expect(isRunning(holder.svc)).toBe(false));

    const degraded = boot(redis, fakePositions(), { rank: rankStub(false), chainIds: [1, 42161] });
    await degraded.svc.followCycle();
    // 42161's windows came from the holder; age them (and the holder's snapshots) past the
    // re-read age — the holder re-reads them, not us.
    const cycles = vi.spyOn(degraded.svc, 'runCycle');
    const index = redis.hashes.get(`tw:lb:snapidx:v1:${NS}`)!;
    const agedAt = Date.now() - 20_000;
    for (const key of [...degraded.positions.warmedAt.keys()]) {
      if (!key.startsWith('42161|')) continue;
      degraded.positions.warmedAt.set(key, agedAt);
      index.set(sha1(key), String(agedAt));
    }
    (degraded.svc as unknown as { lastCoverAt: number }).lastCoverAt = 0;
    degraded.positions.warmed.length = 0;
    await degraded.svc.followCycle();
    expect(cycles).toHaveBeenCalledTimes(1);
    expect(degraded.positions.warmed.filter((w) => w.chainId === 42161)).toHaveLength(0);
  });
});

describe('leaderboard warmup — re-read age (review finding: followers\' copies expired before the holder replaced them)', () => {
  const internals = (svc: LeaderboardWarmupService) => svc as unknown as { lastCycleMs: number };

  /** The boot cycle has finished (it sets lastCycleMs itself). */
  async function settled(svc: LeaderboardWarmupService, positions: ReturnType<typeof fakePositions>) {
    await vi.waitFor(() => expect(positions.warmed.length).toBeGreaterThanOrEqual(8));
    await vi.waitFor(() => expect(isRunning(svc)).toBe(false));
  }

  /** Every landing window fresh, then the named ones aged; returns the sorts the next cycle re-reads. */
  async function rereadAfter(svc: LeaderboardWarmupService, positions: ReturnType<typeof fakePositions>, ages: Record<string, number>) {
    await vi.waitFor(() => expect(positions.warmed.length).toBeGreaterThanOrEqual(8));
    await vi.waitFor(() => expect(isRunning(svc)).toBe(false));
    const now = Date.now();
    for (const key of [...positions.warmedAt.keys()]) positions.warmedAt.set(key, now);
    for (const [sort, age] of Object.entries(ages)) positions.warmedAt.set(`1|${sort}|w50`, now - age);
    const before = positions.warmed.length;
    await svc.runCycle();
    return positions.warmed.slice(before).map((w) => w.sort);
  }

  it('leases OFF: a window is re-read at LEADERBOARD_WARMUP_MIN_AGE_MS (15 s), exactly as today', async () => {
    const redis = new LeaderRedis();
    const { svc, positions } = boot(redis);
    expect(await rereadAfter(svc, positions, { apr: 13_500, roi: 15_500 })).toEqual(['roi']);
  });

  it('leases ON: the holder re-reads earlier by the 2 s follower pickup (and the last cycle\'s duration)', async () => {
    configureProcessRole({ processRole: 'api' });
    const redis = new LeaderRedis();
    const { svc, positions } = boot(redis);
    await settled(svc, positions);
    internals(svc).lastCycleMs = 0;
    // due at 15 − 2 − 0 = 13 s
    expect((await rereadAfter(svc, positions, { apr: 13_500, roi: 12_500 })).sort()).toEqual(['apr']);
    internals(svc).lastCycleMs = 2_500;
    // due at 15 − 2 − 2.5 = 10.5 s
    expect((await rereadAfter(svc, positions, { apr: 11_000, roi: 10_200 })).sort()).toEqual(['apr']);
  });

  it('leases ON: never earlier than one tick, so a window the previous tick read is not read again', async () => {
    configureProcessRole({ processRole: 'api' });
    const redis = new LeaderRedis();
    const { svc, positions } = boot(redis);
    await settled(svc, positions);
    internals(svc).lastCycleMs = 20_000; // a slow cycle would put it at −7 s
    expect((await rereadAfter(svc, positions, { apr: 9_800, roi: 10_200 })).sort()).toEqual(['roi']);
  });

  it('a full cycle records its duration (a scoped follower cycle does not)', async () => {
    configureProcessRole({ processRole: 'api' });
    const redis = new LeaderRedis();
    const { svc, positions } = boot(redis);
    await settled(svc, positions);
    internals(svc).lastCycleMs = 7_777;
    await svc.runCycle({ shards: new Set(['1:uniswap-v4']) });
    expect(internals(svc).lastCycleMs).toBe(7_777);
    await svc.runCycle();
    expect(internals(svc).lastCycleMs).toBeLessThan(1_000);
  });
});
