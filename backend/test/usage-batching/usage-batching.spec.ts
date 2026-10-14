import { Types } from 'mongoose';
import { RateLimiterAbstract, RateLimiterMemory } from 'rate-limiter-flexible';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MeteringService } from '../../src/billing/metering.service.js';
import type { CachedPlan } from '../../src/billing/settings-cache.service.js';
import { UsageBucketService } from '../../src/billing/usage-bucket.service.js';
import {
  USAGE_FLUSH_CHUNK,
  USAGE_LOCAL_MAX_FIELDS,
  USAGE_REDIS_OPTIONS,
  UsageFlushService,
  resolveUsageFlushIntervalMs,
  resolveUsageWriteMode,
  type UsageFlushOptions,
} from '../../src/billing/usage-flush.service.js';
import { USAGE_CLAIM_SCRIPT, USAGE_TAKEOVER_SCRIPT, bucketField, buildUsageFlushOps, redisNotSent, rowBatches, usageField } from '../../src/billing/usage-flush.js';
import { SharedControlClient } from '../../src/common/coordination-redis.js';
import { configureProcessRole, resetProcessRoleForTests } from '../../src/common/process-role.js';
import { resetLeaseRunnersForTests } from '../../src/common/lease-runner.js';
import type { MeteringContext } from '../../src/v1/metering-context.js';
import { FakeMongoCollection, FakeUsageRedis, bulkError, settle } from './fakes.js';

/**
 * `USAGE_WRITE_MODE=batched`: the two per-request usage writes buffered in
 * redis-state and flushed as `bulkWrite` upserts — driven through the REAL
 * `MeteringService` (snapshot + compensation) and `UsageBucketService.record`,
 * over fake Redis / Mongo that apply real upsert semantics. The yardstick of
 * every batched case is the DIRECT path: the same sequence must leave the same
 * rows (see `parity`).
 */

class TestMetering extends MeteringService {
  protected override createLimiter(_keyPrefix: string, points: number, duration: number): RateLimiterAbstract {
    return new RateLimiterMemory({ points, duration });
  }
}

const A = '6650aaaaaaaaaaaaaaaaaaaa';
const B = '6650cccccccccccccccccccc';
const KEY = '6650bbbbbbbbbbbbbbbbbbbb';

/** Unlimited: the quota limiter is skipped, so no 35-day memory timers; the snapshot is still charged. */
const PLAN: CachedPlan = {
  key: 'unl',
  name: 'Unlimited',
  monthlyUnits: 0,
  rateLimitPerMin: 1_000_000,
  price: 0,
  enabled: true,
  selfServe: true,
  maxApiKeys: 1,
  allowBrowserKeys: false,
  description: '',
  features: [],
  prices: [],
} as CachedPlan;

function quietLogger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

interface RigOpts {
  mode?: 'direct' | 'batched';
  redis?: FakeUsageRedis;
  usage?: FakeMongoCollection;
  buckets?: FakeMongoCollection;
  clock?: { t: number };
  state?: { redisUp: boolean };
  owner?: string;
  options?: Partial<UsageFlushOptions>;
  coordination?: unknown;
}

function rig(o: RigOpts = {}) {
  const redis = o.redis ?? new FakeUsageRedis();
  const usage = o.usage ?? new FakeMongoCollection();
  const buckets = o.buckets ?? new FakeMongoCollection();
  const clock = o.clock ?? { t: Date.parse('2026-10-05T12:00:00Z') };
  const state = o.state ?? { redisUp: true };
  const logger = quietLogger();
  const config = {
    redisUrl: 'redis://localhost:6379',
    ...(o.mode ? { usageWriteMode: o.mode, usageFlushIntervalMs: 10_000 } : {}),
  };
  const flush = new UsageFlushService(config as never, usage as never, buckets as never, o.coordination as never, {
    now: () => clock.t,
    redis: async () => (state.redisUp ? redis : undefined),
    namespace: 't',
    owner: o.owner ?? 'p1',
    sharedFlushAllowed: () => true,
    timer: false,
    logger,
    ...o.options,
  });
  const metering = new TestMetering(config as never, usage as never, undefined, flush);
  const writer = new UsageBucketService(buckets as never, flush);
  return { redis, usage, buckets, clock, state, logger, flush, metering, writer };
}

type Rig = ReturnType<typeof rig>;

function ctx(over: Partial<MeteringContext> = {}): MeteringContext {
  return {
    customerId: A,
    planKey: 'unl',
    routeKey: 'v1.positions',
    apiKeyId: KEY,
    keyPrefix: 'tk_live_a3f9',
    keyLabel: 'prod',
    unitCost: 10,
    unitsCharged: 10,
    chargedAt: new Date('2026-10-05T12:00:00Z'),
    ...over,
  };
}

async function charge(r: Rig, customerId: string, unitCost: number): Promise<void> {
  await r.metering.checkAndConsume({ apiKeyId: KEY, customerId, plan: PLAN, unitCost });
}

async function refund(r: Rig, customerId: string, unitCost: number): Promise<void> {
  await r.metering.reward({ customerId, plan: PLAN, unitCost, quotaCharged: false });
}

/** A sequence touching every semantic: charges, a refund, a zero-unit route, 2xx / 4xx / 429 / 499 buckets. */
async function scenario(r: Rig): Promise<void> {
  await charge(r, A, 10);
  await charge(r, A, 10);
  await charge(r, A, 10);
  await refund(r, A, 10);
  await charge(r, B, 0);
  r.writer.record(ctx(), 200);
  r.writer.record(ctx(), 200);
  r.writer.record(ctx({ unitsCharged: 0 }), 404);
  r.writer.record(ctx({ unitsCharged: 0 }), 429);
  r.writer.record(ctx({ unitsCharged: 0 }), 499);
  r.writer.record(ctx({ customerId: B, unitCost: 0, unitsCharged: 0 }), 200);
}

afterEach(() => {
  vi.useRealTimers();
  resetProcessRoleForTests();
  resetLeaseRunnersForTests();
});

describe('USAGE_WRITE_MODE parsing', () => {
  it('defaults to direct for anything but "batched", and clamps the interval', () => {
    expect(resolveUsageWriteMode(undefined)).toBe('direct');
    expect(resolveUsageWriteMode('')).toBe('direct');
    expect(resolveUsageWriteMode('nonsense')).toBe('direct');
    expect(resolveUsageWriteMode(' Batched ')).toBe('batched');
    expect(resolveUsageWriteMode('DRAIN')).toBe('drain');
    expect(resolveUsageFlushIntervalMs(undefined)).toBe(10_000);
    expect(resolveUsageFlushIntervalMs(0)).toBe(10_000);
    expect(resolveUsageFlushIntervalMs(5)).toBe(1_000);
    expect(resolveUsageFlushIntervalMs(10_000_000)).toBe(300_000);
  });
});

describe('direct (default) — today, unchanged', () => {
  it('writes one updateOne per snapshot and per bucket, and never touches Redis', async () => {
    const r = rig();
    r.flush.onModuleInit();
    await scenario(r);
    await settle();
    // 4 charges + 1 compensation, 6 bucket upserts — each its own write, as today.
    expect(r.usage.updateOneCalls).toHaveLength(5);
    expect(r.usage.updateOneCalls[0]).toEqual({
      filter: { customerId: new Types.ObjectId(A), period: expect.any(String) },
      update: { $inc: { unitsConsumed: 10, requestCount: 1 } },
      options: { upsert: true },
    });
    expect(r.usage.updateOneCalls[3].options.upsert).toBeUndefined(); // the compensation never upserts
    expect(r.buckets.updateOneCalls).toHaveLength(6);
    expect(r.usage.bulkCalls).toHaveLength(0);
    expect(r.redis.calls).toEqual([]);
    expect(r.flush.status().flusher).toBe('off');
    await r.flush.flushNow();
    await r.flush.beforeApplicationShutdown();
    expect(r.redis.calls).toEqual([]);
  });
});

describe('batched', () => {
  it('parity: leaves exactly the rows the direct path leaves, with zero per-request Mongo writes', async () => {
    const direct = rig();
    await scenario(direct);
    await settle();

    const batched = rig({ mode: 'batched' });
    await scenario(batched);
    await settle();
    expect(batched.usage.updateOneCalls).toHaveLength(0);
    expect(batched.buckets.updateOneCalls).toHaveLength(0);
    expect(batched.usage.docs.size).toBe(0);

    await batched.flush.flushNow();
    expect(batched.usage.rows()).toEqual(direct.usage.rows());
    expect(batched.buckets.rows()).toEqual(direct.buckets.rows());
    // ONE bulkWrite per collection for the whole window.
    expect(batched.usage.bulkCalls).toHaveLength(1);
    expect(batched.buckets.bulkCalls).toHaveLength(1);
    expect(batched.usage.find({ customerId: A })).toMatchObject({ unitsConsumed: 20, requestCount: 3 });
    expect(batched.usage.find({ customerId: B })).toMatchObject({ unitsConsumed: 0, requestCount: 1 }); // zero-unit row kept
    expect(batched.buckets.find({ statusClass: '4xx' })).toMatchObject({ units: 0, requests: 2 }); // 404 + 499
    expect(batched.redis.totalBuffered()).toBe(0);
    expect(batched.redis.zsets.size).toBe(0);
  });

  it('a refund of an already-flushed charge decrements without upsert and leaves requestCount alone', async () => {
    const r = rig({ mode: 'batched' });
    await charge(r, A, 10);
    await settle();
    await r.flush.flushNow();
    await refund(r, A, 10);
    await settle();
    await r.flush.flushNow();
    const op = r.usage.bulkCalls[1].ops[0].updateOne;
    expect(op.upsert).toBeUndefined();
    expect(op.update).toEqual({ $inc: { unitsConsumed: -10 } });
    expect(r.usage.find({ customerId: A })).toMatchObject({ unitsConsumed: 0, requestCount: 1 });
  });

  it('refund before flush nets into the charge upsert', async () => {
    const r = rig({ mode: 'batched' });
    await charge(r, A, 7);
    await refund(r, A, 7);
    await settle();
    await r.flush.flushNow();
    expect(r.usage.bulkCalls[0].ops[0].updateOne).toMatchObject({
      update: { $inc: { unitsConsumed: 0, requestCount: 1 } },
      upsert: true,
    });
    expect(r.usage.find({ customerId: A })).toMatchObject({ unitsConsumed: 0, requestCount: 1 });
  });

  it('a compensation whose row does not exist never creates a negative row (direct rule)', async () => {
    const r = rig({ mode: 'batched' });
    await refund(r, A, 10);
    await settle();
    await r.flush.flushNow();
    expect(r.usage.docs.size).toBe(0);

    const d = rig();
    await refund(d, A, 10);
    await settle();
    expect(d.usage.docs.size).toBe(0);
  });

  it('month boundary: the charge and its compensation each resolve their own period, exactly as direct', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const run = async (r: Rig) => {
      vi.setSystemTime(new Date('2026-01-31T23:59:59.900Z'));
      await charge(r, A, 10);
      vi.setSystemTime(new Date('2026-02-01T00:00:00.100Z'));
      await refund(r, A, 10);
      await settle();
    };
    const d = rig();
    await run(d);
    const b = rig({ mode: 'batched' });
    await run(b);
    await b.flush.flushNow();
    expect(b.usage.rows()).toEqual(d.usage.rows());
    expect(b.usage.find({ period: '2026-01' })).toMatchObject({ unitsConsumed: 10 });
    expect(b.usage.find({ period: '2026-02' })).toBeUndefined();
  });

  it('buckets: day from chargedAt (not flush time), first label wins on a rename inside the window', async () => {
    const r = rig({ mode: 'batched' });
    const chargedAt = new Date('2026-01-31T23:59:59Z');
    r.writer.record(ctx({ chargedAt, keyLabel: 'old' }), 200);
    await settle();
    r.writer.record(ctx({ chargedAt, keyLabel: 'new' }), 200);
    await settle();
    await r.flush.flushNow();
    expect(r.buckets.docs.size).toBe(1);
    expect(r.buckets.find({ customerId: A })).toMatchObject({
      day: '2026-01-31',
      period: '2026-01',
      keyLabel: 'old',
      units: 20,
      requests: 2,
    });
  });

  it('chunks bulkWrites at 500 ops', async () => {
    const r = rig({ mode: 'batched' });
    for (let i = 0; i < 1_203; i++) await charge(r, new Types.ObjectId().toHexString(), 1);
    await settle(20);
    await r.flush.flushNow();
    expect(r.usage.bulkCalls.map((c) => c.ops.length)).toEqual([USAGE_FLUSH_CHUNK, USAGE_FLUSH_CHUNK, 203]);
    expect(r.usage.bulkCalls.every((c) => (c.options as { ordered: boolean }).ordered === true)).toBe(true);
    expect(r.usage.docs.size).toBe(1_203);
  });

  it('crash between claim and write: the stale claim is taken over and written exactly once, never before staleMs', async () => {
    const shared = { redis: new FakeUsageRedis(), usage: new FakeMongoCollection(), buckets: new FakeMongoCollection(), clock: { t: 1_000_000 } };
    const a = rig({ mode: 'batched', ...shared, owner: 'A' });
    await charge(a, A, 10);
    await charge(a, A, 10);
    a.writer.record(ctx(), 200);
    await settle();
    // A claims, then "dies" inside the write (network error, nothing applied).
    shared.usage.failBulk = (_ops, call) => (call === 0 ? new Error('connection reset') : undefined);
    await a.flush.flushNow();
    expect(a.flush.status().ownClaims).toBe(1);
    expect(shared.usage.docs.size).toBe(0);
    // A is gone; B (a new process) flushes 1 s later: the claim is not stale.
    const b = rig({ mode: 'batched', ...shared, owner: 'B' });
    shared.clock.t += 1_000;
    await b.flush.flushNow();
    expect(shared.usage.docs.size).toBe(0);
    expect(shared.redis.zsets.get(a.flush.claimsKey)?.size).toBe(1);
    // Past staleMs it is taken over and written once.
    shared.clock.t += b.flush.staleMs;
    await b.flush.flushNow();
    expect(shared.usage.find({ customerId: A })).toMatchObject({ unitsConsumed: 20, requestCount: 2 });
    expect(shared.buckets.find({ customerId: A })).toMatchObject({ units: 10, requests: 1 });
    await b.flush.flushNow();
    expect(shared.usage.find({ customerId: A })).toMatchObject({ unitsConsumed: 20, requestCount: 2 });
    expect(shared.redis.zsets.size).toBe(0);
    expect(shared.redis.hashes.size).toBe(0);
  });

  it('a surviving flusher retries its own failed claim at the next flush (acked chunks are not replayed)', async () => {
    const r = rig({ mode: 'batched' });
    await charge(r, A, 5);
    r.writer.record(ctx(), 200);
    await settle();
    r.buckets.failBulk = (_ops, call) => (call === 0 ? new Error('timeout') : undefined);
    await r.flush.flushNow();
    expect(r.usage.find({ customerId: A })).toMatchObject({ unitsConsumed: 5, requestCount: 1 });
    expect(r.buckets.docs.size).toBe(0);
    expect(r.flush.status()).toMatchObject({ flushFailures: 1, consecutiveFailures: 1, ownClaims: 1 });
    expect(r.logger.warn).toHaveBeenCalledWith(expect.stringContaining('[alert] usage.flush_failed'));
    // New traffic arrives meanwhile.
    await charge(r, A, 5);
    await settle();
    await r.flush.flushNow();
    expect(r.usage.find({ customerId: A })).toMatchObject({ unitsConsumed: 10, requestCount: 2 });
    expect(r.buckets.find({ customerId: A })).toMatchObject({ units: 10, requests: 1 });
    expect(r.flush.status()).toMatchObject({ consecutiveFailures: 0, ownClaims: 0 });
  });

  it('a claim taken over mid-flush stops its old owner before the next chunk (no double write)', async () => {
    const shared = { redis: new FakeUsageRedis(), usage: new FakeMongoCollection(), buckets: new FakeMongoCollection(), clock: { t: 1_000_000 } };
    const a = rig({ mode: 'batched', ...shared, owner: 'A' });
    const b = rig({ mode: 'batched', ...shared, owner: 'B' });
    const ids = Array.from({ length: USAGE_FLUSH_CHUNK + 100 }, () => new Types.ObjectId().toHexString());
    for (const id of ids) await charge(a, id, 1);
    await settle(20);
    let armed = true;
    // Right after A acknowledged its FIRST chunk, A stalls past staleMs and B
    // takes the claim over (writing the second chunk). A must notice before
    // writing that chunk again.
    shared.redis.after = async (name, reply) => {
      if (!armed || name !== 'ACK' || Number(reply) !== 1) return;
      armed = false;
      shared.clock.t += a.flush.staleMs + 1;
      await b.flush.flushNow();
    };
    await a.flush.flushNow();
    expect(shared.usage.docs.size).toBe(ids.length);
    for (const id of ids) expect(shared.usage.find({ customerId: id })).toMatchObject({ unitsConsumed: 1, requestCount: 1 });
    expect(shared.redis.zsets.size).toBe(0);
  });

  it('documents the at-least-once window: a claim lost between write and ack is replayed (and alerted)', async () => {
    const shared = { redis: new FakeUsageRedis(), usage: new FakeMongoCollection(), buckets: new FakeMongoCollection(), clock: { t: 1_000_000 } };
    const a = rig({ mode: 'batched', ...shared, owner: 'A' });
    const b = rig({ mode: 'batched', ...shared, owner: 'B' });
    await charge(a, A, 10);
    await settle();
    shared.usage.afterBulk = async (call) => {
      if (call !== 0) return;
      shared.clock.t += a.flush.staleMs + 1;
      await b.flush.flushNow();
    };
    await a.flush.flushNow();
    expect(shared.usage.find({ customerId: A })).toMatchObject({ unitsConsumed: 20, requestCount: 2 });
    expect(a.logger.warn).toHaveBeenCalledWith(expect.stringContaining('[alert] usage.flush_double_count_risk'));
  });

  it('two flushers racing on one buffer, with producers on both replicas, count every request exactly once', async () => {
    const shared = { redis: new FakeUsageRedis(), usage: new FakeMongoCollection(), buckets: new FakeMongoCollection(), clock: { t: 1_000_000 } };
    const a = rig({ mode: 'batched', ...shared, owner: 'A' });
    const b = rig({ mode: 'batched', ...shared, owner: 'B' });
    // Every Redis command yields, so the two flushers' steps interleave.
    shared.redis.before = () => new Promise<void>((resolve) => setImmediate(resolve));
    let sent = 0;
    for (let round = 0; round < 12; round++) {
      for (let i = 0; i < 5; i++) {
        const replica = (round + i) % 2 === 0 ? a : b;
        await charge(replica, i % 2 ? A : B, 3);
        replica.writer.record(ctx({ customerId: i % 2 ? A : B, unitsCharged: 3 }), 200);
        sent += 1;
      }
      await Promise.all([a.flush.flushNow(), b.flush.flushNow(), settle(2)]);
    }
    await settle(10);
    await a.flush.flushNow();
    await b.flush.flushNow();
    const usageReq = shared.usage.rows().reduce((n, d) => n + (d.requestCount as number), 0);
    const usageUnits = shared.usage.rows().reduce((n, d) => n + (d.unitsConsumed as number), 0);
    const bucketReq = shared.buckets.rows().reduce((n, d) => n + (d.requests as number), 0);
    expect(usageReq).toBe(sent);
    expect(usageUnits).toBe(sent * 3);
    expect(bucketReq).toBe(sent);
    expect(shared.redis.hashes.size).toBe(0);
    expect(shared.redis.zsets.size).toBe(0);
  });

  it('Redis unavailable: deltas buffer in-process and this process flushes them; a failed local flush keeps them', async () => {
    const r = rig({ mode: 'batched', state: { redisUp: false } });
    await charge(r, A, 4);
    r.writer.record(ctx({ unitsCharged: 4 }), 200);
    await settle();
    expect(r.flush.status()).toMatchObject({ localKeys: 4, redisFallbacks: 2 });
    r.usage.failBulk = (_ops, call) => (call === 0 ? new Error('mongo down') : undefined);
    await r.flush.flushNow();
    expect(r.flush.status().localKeys).toBe(4); // the round stops at the first refusal; nothing lost
    expect(r.buckets.docs.size).toBe(0);
    await charge(r, A, 4);
    await settle();
    await r.flush.flushNow();
    expect(r.usage.find({ customerId: A })).toMatchObject({ unitsConsumed: 8, requestCount: 2 });
    expect(r.buckets.find({ customerId: A })).toMatchObject({ units: 4, requests: 1 });
    expect(r.flush.status().localKeys).toBe(0);
  });

  it('a Redis error that proves the INCR never left (offline queue / error reply) falls back to the local buffer', async () => {
    for (const failure of [
      () => new Error("Stream isn't writeable and enableOfflineQueue options is false"),
      () => Object.assign(new Error('OOM command not allowed'), { name: 'ReplyError' }),
    ]) {
      const r = rig({ mode: 'batched' });
      r.redis.failing = true;
      r.redis.failWith = failure;
      await charge(r, A, 4);
      await settle();
      expect(r.flush.status()).toMatchObject({ localKeys: 2, redisFallbacks: 1, ambiguousWrites: 0 });
      r.redis.failing = false;
      await r.flush.flushNow();
      expect(r.usage.find({ customerId: A })).toMatchObject({ unitsConsumed: 4, requestCount: 1 });
    }
  });

  it('an AMBIGUOUS INCR (it ran, the reply was lost) is not counted twice: retried by op id, never written locally', async () => {
    const r = rig({ mode: 'batched' });
    let lose = true;
    r.redis.after = (name) => {
      if (name === 'INCR' && lose) {
        lose = false;
        throw new Error('Command timed out');
      }
    };
    await charge(r, A, 10);
    await settle();
    expect(r.flush.status()).toMatchObject({ localKeys: 0, redisFallbacks: 0, ambiguousWrites: 1, ambiguousPending: 1 });
    await r.flush.flushNow();
    expect(r.usage.find({ customerId: A })).toMatchObject({ unitsConsumed: 10, requestCount: 1 });
    expect(r.flush.status()).toMatchObject({ ambiguousPending: 0, ambiguousUnresolved: 0 });
  });

  it('an AMBIGUOUS INCR that did NOT run is applied exactly once when Redis answers again', async () => {
    const r = rig({ mode: 'batched' });
    r.redis.failing = true; // default failure: a plain error = outcome unknown
    await charge(r, A, 6);
    await settle();
    expect(r.flush.status()).toMatchObject({ localKeys: 0, ambiguousPending: 1 });
    await r.flush.flushNow(); // still failing: kept, not written anywhere
    expect(r.usage.docs.size).toBe(0);
    expect(r.flush.status().ambiguousPending).toBe(1);
    r.redis.failing = false;
    await r.flush.flushNow();
    expect(r.usage.find({ customerId: A })).toMatchObject({ unitsConsumed: 6, requestCount: 1 });
    await r.flush.flushNow();
    expect(r.usage.find({ customerId: A })).toMatchObject({ unitsConsumed: 6, requestCount: 1 });
  });

  it('an ambiguous INCR still unanswered past 90 s goes to the local buffer at-least-once, with an alert', async () => {
    const state = { redisUp: true };
    const r = rig({ mode: 'batched', state });
    r.redis.failing = true;
    await charge(r, A, 3);
    await settle();
    r.redis.failing = false;
    state.redisUp = false;
    r.clock.t += 89_000;
    await r.flush.flushNow();
    expect(r.flush.status()).toMatchObject({ ambiguousPending: 1, ambiguousUnresolved: 0 });
    expect(r.usage.docs.size).toBe(0);
    r.clock.t += 2_000;
    await r.flush.flushNow();
    expect(r.flush.status()).toMatchObject({ ambiguousPending: 0, ambiguousUnresolved: 1 });
    expect(r.logger.warn).toHaveBeenCalledWith(expect.stringContaining('[alert] usage.ambiguous_unresolved'));
    expect(r.usage.find({ customerId: A })).toMatchObject({ unitsConsumed: 3, requestCount: 1 });
  });

  it('past the local cap a record is written at once (direct rules), never dropped', async () => {
    const r = rig({ mode: 'batched', state: { redisUp: false } });
    const n = USAGE_LOCAL_MAX_FIELDS / 2;
    for (let i = 0; i < n; i++) await charge(r, new Types.ObjectId().toHexString(), 1);
    await settle(20);
    expect(r.flush.status().localKeys).toBe(USAGE_LOCAL_MAX_FIELDS);
    await charge(r, A, 9);
    await settle();
    expect(r.flush.status().immediateWrites).toBe(1);
    expect(r.usage.find({ customerId: A })).toMatchObject({ unitsConsumed: 9, requestCount: 1 });
  }, 30_000);

  it('shutdown: a bounded final flush drains the shared and local buffers; later records are written at once', async () => {
    const state = { redisUp: true };
    const r = rig({ mode: 'batched', state });
    await charge(r, A, 2);
    await settle();
    state.redisUp = false;
    await charge(r, A, 3);
    await settle();
    state.redisUp = true;
    await r.flush.beforeApplicationShutdown();
    expect(r.usage.find({ customerId: A })).toMatchObject({ unitsConsumed: 5, requestCount: 2 });
    expect(r.flush.batching).toBe(false);
    await charge(r, A, 1);
    r.writer.record(ctx({ unitsCharged: 1 }), 200);
    await settle();
    // Not buffered: today's direct writes (the buffer is closed).
    expect(r.usage.updateOneCalls).toHaveLength(1);
    expect(r.buckets.updateOneCalls).toHaveLength(1);
    expect(r.usage.find({ customerId: A })).toMatchObject({ unitsConsumed: 6, requestCount: 3 });
  });

  it('shutdown forces the shared flush even where the lease view says standby', async () => {
    const r = rig({ mode: 'batched', options: { sharedFlushAllowed: () => false } });
    await charge(r, A, 2);
    await settle();
    await r.flush.flushNow();
    expect(r.usage.docs.size).toBe(0);
    expect(r.flush.status().flusher).toBe('standby');
    await r.flush.beforeApplicationShutdown();
    expect(r.usage.find({ customerId: A })).toMatchObject({ unitsConsumed: 2 });
  });

  it('leases on: only the usage-flush lease holder flushes the shared buffer; a local buffer joins it once Redis answers', async () => {
    configureProcessRole({ role: 'api', leasesSetting: 'on', leases: true });
    const coordination = { client: async () => undefined, namespace: 't' };
    const state = { redisUp: true };
    const r = rig({ mode: 'batched', state, coordination, options: { sharedFlushAllowed: undefined } });
    r.flush.onModuleInit();
    await charge(r, A, 2); // → shared buffer
    await settle();
    state.redisUp = false;
    await charge(r, B, 3); // → local buffer
    await settle();
    expect(r.flush.status().localKeys).toBe(2);
    state.redisUp = true;
    await r.flush.flushNow();
    // A standby writes neither: B moved into the shared buffer, for the holder.
    expect(r.usage.docs.size).toBe(0);
    expect(r.flush.status().localKeys).toBe(0);
    expect(await r.flush.metrics()).toMatchObject({ bufferedKeys: 4, drained: false });
    expect(r.flush.status().flusher).toBe('standby');
    // While Redis stays down, this process writes its local buffer itself.
    state.redisUp = false;
    await charge(r, B, 5);
    await settle();
    await r.flush.flushNow();
    expect(r.usage.find({ customerId: B })).toMatchObject({ unitsConsumed: 5, requestCount: 1 });
    await r.flush.onModuleDestroy();
  });

  it('metrics: buffered keys, pending claims, last flush age', async () => {
    const r = rig({ mode: 'batched' });
    expect((await r.flush.metrics()).lastFlushAgeMs).toBeNull();
    await charge(r, A, 2);
    await settle();
    expect(await r.flush.metrics()).toMatchObject({ mode: 'batched', flusher: 'lease-holder', bufferedKeys: 2, pendingClaims: 0 });
    await r.flush.flushNow();
    r.clock.t += 4_000;
    expect(await r.flush.metrics()).toMatchObject({ bufferedKeys: 0, lastFlushAgeMs: 4_000, lastFlushOps: 1, flushes: 1 });
  });

  it('inputs the buffer refuses go down the direct path (malformed id, non-integer cost)', async () => {
    const r = rig({ mode: 'batched' });
    await charge(r, A, 1.5);
    r.writer.record(ctx({ customerId: 'not-an-id' }), 200);
    await settle();
    expect(r.usage.updateOneCalls).toHaveLength(1);
    expect(r.usage.updateOneCalls[0].update).toEqual({ $inc: { unitsConsumed: 1.5, requestCount: 1 } });
    // The malformed bucket id throws synchronously on the direct path → logged and skipped, as today.
    expect(r.buckets.updateOneCalls).toHaveLength(0);
    expect(r.redis.totalBuffered()).toBe(0);
  });

  it('a deterministic write error drops that one row (no poisoned buffer); a duplicate-key race is retried', async () => {
    const r = rig({ mode: 'batched' });
    await charge(r, A, 1);
    await charge(r, B, 1);
    await settle();
    r.usage.failBulk = (_ops, call) => (call === 0 ? bulkError(1, 121, 'Document failed validation') : undefined);
    await r.flush.flushNow();
    expect(r.logger.warn).toHaveBeenCalledWith(expect.stringContaining('[alert] usage.flush_dropped_op'));
    await r.flush.flushNow();
    expect(r.usage.docs.size).toBe(1); // op 0 applied once; op 1 dropped
    expect(r.flush.status().ownClaims).toBe(0);

    const d = rig({ mode: 'batched' });
    await charge(d, A, 1);
    await charge(d, B, 1);
    await settle();
    d.usage.failBulk = (_ops, call) => (call === 0 ? bulkError(1, 11000, 'E11000') : undefined);
    await d.flush.flushNow();
    await d.flush.flushNow();
    expect(d.usage.docs.size).toBe(2);
    expect(d.usage.rows().map((x) => x.requestCount)).toEqual([1, 1]);
  });
});

describe('review fixes (2026-10-05)', () => {
  it('the buffer has its own control connection that never resends a command after a reconnect', async () => {
    expect(USAGE_REDIS_OPTIONS).toMatchObject({ autoResendUnfulfilledCommands: false, enableOfflineQueue: false, commandTimeout: 1_000 });
    const get = vi.spyOn(SharedControlClient.prototype, 'get').mockResolvedValue(undefined);
    try {
      const coordination = { url: 'redis://127.0.0.1:1', namespace: 't', client: vi.fn(async () => undefined) };
      const flush = new UsageFlushService({ usageWriteMode: 'batched' } as never, {} as never, {} as never, coordination as never, {
        timer: false,
        logger: quietLogger(),
      });
      await flush.metrics();
      expect(get).toHaveBeenCalled();
      expect(coordination.client).not.toHaveBeenCalled(); // never the shared, resending client
      expect((flush as unknown as { ownClient: { options: unknown } }).ownClient.options).toBe(USAGE_REDIS_OPTIONS);
    } finally {
      get.mockRestore();
    }
  });

  it('classifies ioredis rejections: only a provably unsent command is "not sent"', () => {
    expect(redisNotSent(new Error("Stream isn't writeable and enableOfflineQueue options is false"))).toBe(true);
    expect(redisNotSent(Object.assign(new Error('ERR x'), { name: 'ReplyError' }))).toBe(true);
    expect(redisNotSent(new Error('Command timed out'))).toBe(false);
    expect(redisNotSent(Object.assign(new Error('max retries'), { name: 'MaxRetriesPerRequestError' }))).toBe(false);
    expect(redisNotSent(new Error('Connection is closed.'))).toBe(false);
  });

  it('a CLAIM that ran but whose reply was lost: re-running it (an ioredis resend) loses nothing, and the claim is resumed', async () => {
    const r = rig({ mode: 'batched' });
    for (let i = 0; i < 5; i++) await charge(r, A, 10);
    await settle();
    const real = r.redis.eval.bind(r.redis);
    let replay: Parameters<typeof real> | undefined;
    r.redis.eval = async (...args: Parameters<typeof real>) => {
      const reply = await real(...args);
      if (args[0] === USAGE_CLAIM_SCRIPT && !replay) {
        replay = args;
        throw new Error('Command timed out');
      }
      return reply;
    };
    await r.flush.flushNow();
    expect(r.usage.docs.size).toBe(0);
    expect(r.flush.status()).toMatchObject({ flushFailures: 1, ownClaims: 1 });
    await charge(r, A, 10); // a new live hash
    await settle();
    // The identical EVAL again, as a resend after a reconnect would send it: refused.
    expect(Number(await real(...(replay as Parameters<typeof real>)))).toBeLessThan(0);
    await r.flush.flushNow();
    expect(r.usage.find({ customerId: A })).toMatchObject({ unitsConsumed: 60, requestCount: 6 });
    expect(r.redis.hashes.size).toBe(0);
    expect(r.redis.zsets.size).toBe(0);
  });

  it('a TAKEOVER that ran but whose reply was lost is resumed at the next flush, not left to go stale again', async () => {
    const shared = { redis: new FakeUsageRedis(), usage: new FakeMongoCollection(), buckets: new FakeMongoCollection(), clock: { t: 1_000_000 } };
    const a = rig({ mode: 'batched', ...shared, owner: 'A' });
    const b = rig({ mode: 'batched', ...shared, owner: 'B' });
    await charge(a, A, 10);
    await settle();
    shared.usage.failBulk = (_ops, call) => (call === 0 ? new Error('connection reset') : undefined);
    await a.flush.flushNow(); // A's claim is stuck; A dies
    shared.clock.t += b.flush.staleMs + 1;
    const real = shared.redis.eval.bind(shared.redis);
    let lost = false;
    shared.redis.eval = async (...args: Parameters<typeof real>) => {
      const reply = await real(...args);
      if (args[0] === USAGE_TAKEOVER_SCRIPT && !lost) {
        lost = true;
        throw new Error('Command timed out');
      }
      return reply;
    };
    await b.flush.flushNow(); // the takeover ran, B never saw the reply
    expect(shared.usage.docs.size).toBe(0);
    expect(b.flush.status().ownClaims).toBe(1);
    shared.clock.t += 1_000; // well inside staleMs of the new claim
    await b.flush.flushNow();
    expect(shared.usage.find({ customerId: A })).toMatchObject({ unitsConsumed: 10, requestCount: 1 });
    expect(shared.redis.zsets.size).toBe(0);
  });

  it('claims reach Mongo in order: a refund buffered after a stuck charge claim is never written before it', async () => {
    const shared = { redis: new FakeUsageRedis(), usage: new FakeMongoCollection(), buckets: new FakeMongoCollection(), clock: { t: 1_000_000 } };
    let p1Holds = true;
    const p1 = rig({ mode: 'batched', ...shared, owner: 'P1', options: { sharedFlushAllowed: () => p1Holds } });
    const p2 = rig({ mode: 'batched', ...shared, owner: 'P2' });
    await charge(p1, A, 10); // the customer's first charge of the period: no row yet
    await settle();
    shared.usage.failBulk = (_ops, call) => (call === 0 ? new Error('connection reset') : undefined);
    await p1.flush.flushNow(); // claimed, the write failed, the claim is stuck with P1 …
    p1Holds = false; // … which then loses the lease
    await refund(p2, A, 10); // lands in the live hash
    await settle();
    await p2.flush.flushNow(); // must not write the refund before the charge
    expect(shared.usage.docs.size).toBe(0);
    shared.clock.t += p2.flush.staleMs + 1;
    await p2.flush.flushNow(); // takes the charge over, THEN the refund
    const direct = rig();
    await charge(direct, A, 10);
    await refund(direct, A, 10);
    await settle();
    expect(shared.usage.rows()).toEqual(direct.usage.rows());
    expect(shared.usage.find({ customerId: A })).toMatchObject({ unitsConsumed: 0, requestCount: 1 });
  });

  it('a refund held in the local buffer while Redis blipped joins the shared stream instead of overtaking the charge', async () => {
    const state = { redisUp: true };
    const r = rig({ mode: 'batched', state });
    await charge(r, A, 10); // → Redis
    await settle();
    state.redisUp = false;
    await refund(r, A, 10); // → local
    await settle();
    expect(r.flush.status().localKeys).toBe(1);
    state.redisUp = true;
    await r.flush.flushNow();
    expect(r.usage.find({ customerId: A })).toMatchObject({ unitsConsumed: 0, requestCount: 1 });
  });

  it('rowBatches never splits one row across two INCR batches', () => {
    const f = (c: string, m: 'u' | 'r' | 'c') => usageField(c, '2026-10', m);
    const C = new Types.ObjectId().toHexString();
    const pairs: Array<[string, number]> = [
      [f(A, 'u'), 1],
      [f(B, 'u'), 1],
      [f(A, 'r'), 1],
      [f(B, 'r'), 1],
      [f(C, 'u'), 1],
      [f(C, 'r'), 1],
    ];
    const batches = rowBatches(pairs, 3);
    expect(batches.map((b) => b.length)).toEqual([2, 2, 2]);
    for (const b of batches) expect(new Set(b.map(([k]) => JSON.parse(k)[1])).size).toBe(1);
    expect(batches.flat()).toHaveLength(pairs.length);
  });

  it('drain: producers write directly while the flusher empties what batched replicas left; metrics say when direct is safe', async () => {
    const shared = { redis: new FakeUsageRedis(), usage: new FakeMongoCollection(), buckets: new FakeMongoCollection(), clock: { t: 1_000_000 } };
    const a = rig({ mode: 'batched', ...shared, owner: 'A' });
    await charge(a, A, 10);
    await settle();
    shared.usage.failBulk = (_ops, call) => (call === 0 ? new Error('connection reset') : undefined);
    await a.flush.flushNow(); // A's claim is stuck …
    const d = rig({ mode: 'drain', ...shared, owner: 'D' });
    // An empty live hash is not "drained" while a claim is still registered.
    expect(await d.flush.metrics()).toMatchObject({ drained: false, bufferedKeys: 0, pendingClaims: 1 });
    await charge(a, A, 10); // … and more is buffered; then A is killed with no shutdown flush.
    await settle();
    expect(d.flush.batching).toBe(false);
    await charge(d, B, 4);
    await settle();
    expect(shared.usage.updateOneCalls).toHaveLength(1); // direct write, not buffered
    expect(d.flush.status()).toMatchObject({ mode: 'drain', flusher: 'lease-holder' });
    await d.flush.flushNow();
    expect(await d.flush.metrics()).toMatchObject({ mode: 'drain', drained: false, pendingClaims: 1, bufferedKeys: 2 });
    shared.clock.t += d.flush.staleMs + 1;
    await d.flush.flushNow();
    expect(shared.usage.find({ customerId: A })).toMatchObject({ unitsConsumed: 20, requestCount: 2 });
    expect(await d.flush.metrics()).toMatchObject({ drained: true, bufferedKeys: 0, pendingClaims: 0 });
  });

  it('drain still runs the bounded shutdown flush', async () => {
    const shared = { redis: new FakeUsageRedis(), usage: new FakeMongoCollection(), buckets: new FakeMongoCollection(), clock: { t: 1_000_000 } };
    const a = rig({ mode: 'batched', ...shared, owner: 'A' });
    await charge(a, A, 3);
    await settle();
    const d = rig({ mode: 'drain', ...shared, owner: 'D', options: { sharedFlushAllowed: () => false } });
    await d.flush.beforeApplicationShutdown();
    expect(shared.usage.find({ customerId: A })).toMatchObject({ unitsConsumed: 3, requestCount: 1 });
  });

  it('every flush bulkWrite carries a driver timeoutMS well under staleMs', async () => {
    const r = rig({ mode: 'batched' });
    await charge(r, A, 1);
    r.writer.record(ctx(), 200);
    await settle();
    await r.flush.flushNow();
    expect(r.flush.writeTimeoutMs).toBe(20_000);
    expect(r.flush.writeTimeoutMs).toBeLessThan(r.flush.staleMs);
    expect(r.usage.bulkCalls[0].options).toEqual({ ordered: true, timeoutMS: 20_000 });
    expect(r.buckets.bulkCalls[0].options).toEqual({ ordered: true, timeoutMS: 20_000 });
  });

  it('an ambiguous INCR left at shutdown is written at once (with a timeout), and alerted', async () => {
    const r = rig({ mode: 'batched' });
    r.redis.failing = true;
    await charge(r, A, 2);
    await settle();
    expect(r.flush.status().ambiguousPending).toBe(1);
    await r.flush.beforeApplicationShutdown();
    await settle();
    expect(r.logger.warn).toHaveBeenCalledWith(expect.stringContaining('[alert] usage.ambiguous_unresolved'));
    expect(r.flush.status().immediateWrites).toBe(1);
    expect(r.usage.bulkCalls[0].options).toEqual({ ordered: true, timeoutMS: 20_000 });
    expect(r.usage.find({ customerId: A })).toMatchObject({ unitsConsumed: 2, requestCount: 1 });
  });

  it('a flush in flight past staleMs gives the usage-flush lease up; a healthy one keeps it', async () => {
    const r = rig({ mode: 'batched' });
    await charge(r, A, 1);
    await settle();
    let release: () => void = () => undefined;
    r.usage.beforeBulk = () => new Promise<void>((resolve) => (release = resolve));
    const flushing = r.flush.flushNow();
    await settle();
    expect(r.flush.status().flushInFlightMs).toBe(0);
    // Within staleMs: the lease work keeps holding until it is stopped.
    r.clock.t += r.flush.staleMs;
    const ac = new AbortController();
    const holding = r.flush.holdLease(ac.signal, 1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    ac.abort();
    await expect(holding).resolves.toBeUndefined();
    // Past staleMs: it throws, which ends the lease session (released).
    r.clock.t += 1;
    await expect(r.flush.holdLease(new AbortController().signal, 1)).rejects.toThrow(/in flight/);
    expect(r.logger.warn).toHaveBeenCalledWith(expect.stringContaining('[alert] usage.flush_stuck'));
    release();
    await flushing;
    expect(r.usage.find({ customerId: A })).toMatchObject({ unitsConsumed: 1 });
    expect(r.flush.status().flushInFlightMs).toBeNull();
  });

  it('an ACK that ran but whose reply was lost is retried by ack id: no false alert, no replay', async () => {
    const r = rig({ mode: 'batched', options: { ackRetryMs: 0 } });
    await charge(r, A, 4);
    await settle();
    let lose = true;
    r.redis.after = (name) => {
      if (name === 'ACK' && lose) {
        lose = false;
        throw new Error('Command timed out');
      }
    };
    await r.flush.flushNow();
    await r.flush.flushNow();
    expect(r.usage.find({ customerId: A })).toMatchObject({ unitsConsumed: 4, requestCount: 1 });
    expect(r.logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('double_count_risk'));
    expect(r.flush.status()).toMatchObject({ flushFailures: 0, ownClaims: 0 });
    expect(r.redis.zsets.size).toBe(0);
  });

  it('an ACK that keeps failing after a committed write is alerted as a double-count risk (not just flush_failed)', async () => {
    const r = rig({ mode: 'batched', options: { ackRetryMs: 0 } });
    await charge(r, A, 4);
    await settle();
    let ackDown = true;
    r.redis.before = (name) => {
      if (name === 'ACK' && ackDown) throw new Error('Command timed out');
    };
    await r.flush.flushNow();
    expect(r.logger.warn).toHaveBeenCalledWith(expect.stringContaining('[alert] usage.flush_double_count_risk ops=1'));
    expect(r.flush.status()).toMatchObject({ flushFailures: 1, ownClaims: 1 });
    ackDown = false;
    await r.flush.flushNow();
    // The documented at-least-once outcome: the unacknowledged chunk is replayed.
    expect(r.usage.find({ customerId: A })).toMatchObject({ unitsConsumed: 8, requestCount: 2 });
  });

  it('a shutdown flush that times out with a chunk in flight is alerted as a double-count risk', async () => {
    const r = rig({ mode: 'batched' });
    await charge(r, A, 1);
    await settle();
    r.usage.beforeBulk = () => new Promise<void>(() => undefined); // never returns
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const done = r.flush.beforeApplicationShutdown();
    await settle(10);
    vi.advanceTimersByTime(5_000);
    await done;
    expect(r.logger.warn).toHaveBeenCalledWith(expect.stringContaining('[alert] usage.flush_double_count_risk ops=1'));
  });
});

describe('buildUsageFlushOps', () => {
  it('never invents a bucket row from units without a request', () => {
    const plan = buildUsageFlushOps({
      [bucketField({ customerId: A, day: '2026-10-05', routeKey: 'v1.x', apiKeyId: KEY, statusClass: '2xx', keyPrefix: 'p', keyLabel: 'l' }, 'u')]: '5',
    });
    expect(plan.buckets).toEqual([]);
    expect(plan.noWrite).toHaveLength(1);
  });

  it('ignores malformed fields and skips net-zero compensation-only rows', () => {
    const plan = buildUsageFlushOps({
      'not json': '1',
      [JSON.stringify(['u', 'bad', '2026-10', 'u'])]: '1',
      [usageField(A, '2026-10', 'c')]: '0',
      [usageField(B, '2026-10', 'u')]: 'x',
    });
    expect(plan.usage).toEqual([]);
    expect(plan.malformed).toHaveLength(3);
    expect(plan.noWrite).toHaveLength(1);
  });
});
