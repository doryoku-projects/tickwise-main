/*
 * Opt-in: the REAL Lua of `src/billing/usage-flush.ts` on a real Redis, step
 * for step against `FakeUsageRedis` (which every other usage-batching spec
 * runs on). Set USAGE_FLUSH_TEST_REDIS_URL to a THROWAWAY Redis — the spec
 * FLUSHDBs it.
 */
import { Redis } from 'ioredis';
import { Types } from 'mongoose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  USAGE_ACK_MARKER_TTL_MS as AT,
  USAGE_ACK_SCRIPT,
  USAGE_CLAIM_SCRIPT,
  USAGE_INCR_SCRIPT,
  USAGE_OP_TTL_MS as OT,
  USAGE_RETIRE_SCRIPT,
  USAGE_TAKEOVER_SCRIPT,
  USAGE_TOUCH_SCRIPT,
  usageField,
} from '../../src/billing/usage-flush.js';
import { UsageFlushService, type UsageBufferRedis } from '../../src/billing/usage-flush.service.js';
import { FakeMongoCollection, FakeUsageRedis, settle } from './fakes.js';

const URL = process.env.USAGE_FLUSH_TEST_REDIS_URL;

describe.skipIf(!URL)('usage flush Lua (real Redis) = FakeUsageRedis', () => {
  let real: Redis;

  beforeAll(async () => {
    real = new Redis(URL as string, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await real.connect();
    await real.flushdb();
  });

  afterAll(async () => {
    await real?.flushdb();
    await real?.quit();
  });

  it('every script answers identically on the same command sequence', async () => {
    const fake = new FakeUsageRedis();
    const A = new Types.ObjectId().toHexString();
    const fu = usageField(A, '2026-10', 'u');
    const fr = usageField(A, '2026-10', 'r');
    const steps: Array<[string, number, Array<string | number>]> = [
      [USAGE_CLAIM_SCRIPT, 3, ['buf', 'c1', 'z', 1000]], // nothing buffered → 0
      [USAGE_INCR_SCRIPT, 2, ['buf', 'op1', OT, fu, 10, fr, 1]], // → 1
      [USAGE_INCR_SCRIPT, 2, ['buf', 'op1', OT, fu, 10, fr, 1]], // same op again (a retry) → 0, nothing added
      [USAGE_INCR_SCRIPT, 2, ['buf', 'op2', OT, fu, 5, fr, 1]],
      [USAGE_CLAIM_SCRIPT, 3, ['buf', 'c1', 'z', 1000]], // → 1
      [USAGE_INCR_SCRIPT, 2, ['buf', 'op3', OT, fu, 7, fr, 1]], // lands in a NEW live hash
      [USAGE_CLAIM_SCRIPT, 3, ['buf', 'c1', 'z', 1000]], // the SAME claim re-run (a resend) → -3, c1 intact
      [USAGE_CLAIM_SCRIPT, 3, ['buf', 'c9', 'z', 1000]], // any claim while c1 is pending → -3
      [USAGE_TOUCH_SCRIPT, 2, ['z', 'c1', 1500]], // → 1
      [USAGE_TOUCH_SCRIPT, 2, ['z', 'nope', 1500]], // → 0
      [USAGE_TAKEOVER_SCRIPT, 3, ['z', 'c1', 'c2', 2000, 1000]], // touched at 1500 > 1000 → 0
      [USAGE_TAKEOVER_SCRIPT, 3, ['z', 'c1', 'buf', 2000, 1600]], // destination exists → -2, nothing moved
      [USAGE_TAKEOVER_SCRIPT, 3, ['z', 'c1', 'c2', 2000, 1600]], // stale → 1
      [USAGE_TOUCH_SCRIPT, 2, ['z', 'c1', 2100]], // old owner lost it → 0
      [USAGE_ACK_SCRIPT, 3, ['z', 'c1', 'c1:a1', AT, fu]], // not ours → 0
      [USAGE_ACK_SCRIPT, 3, ['z', 'c2', 'c2:a1', AT, fu]], // → 1
      [USAGE_RETIRE_SCRIPT, 2, ['z', 'c2']], // still has fr → 0
      [USAGE_ACK_SCRIPT, 3, ['z', 'c2', 'c2:a2', AT, fr]], // → 1, claim retired
      [USAGE_ACK_SCRIPT, 3, ['z', 'c2', 'c2:a2', AT, fr]], // the same ACK re-run → 1 (not a false "not ours")
      [USAGE_ACK_SCRIPT, 3, ['z', 'c2', 'c2:a3', AT, fr]], // a different ACK on a retired claim → 0
      [USAGE_RETIRE_SCRIPT, 2, ['z', 'c2']], // gone → 0
      [USAGE_TAKEOVER_SCRIPT, 3, ['z', 'ghost', 'c3', 3000, 9999]], // unregistered → 0
    ];
    for (const [script, n, args] of steps) {
      const want = Number(await fake.eval(script, n, ...args));
      const got = Number(await real.eval(script, n, ...args));
      expect(got, `step ${steps.findIndex((s) => s[2] === args)}`).toBe(want);
    }
    expect(await real.hgetall('buf')).toEqual(await fake.hgetall('buf'));
    expect(await real.hgetall('buf')).toEqual({ [fu]: '7', [fr]: '1' });
    expect(await real.zcard('z')).toBe(await fake.zcard('z'));
    expect(await real.exists('c1', 'c2')).toBe(0);
    expect(await real.pttl('op1')).toBeGreaterThan(0);
  });

  it('a CLAIM re-run with identical args after new HINCRBYs loses nothing (the resend hazard)', async () => {
    const A = new Types.ObjectId().toHexString();
    const fu = usageField(A, '2026-10', 'u');
    for (let i = 0; i < 5; i++) await real.eval(USAGE_INCR_SCRIPT, 2, 'rbuf', `rop${i}`, OT, fu, 10);
    expect(Number(await real.eval(USAGE_CLAIM_SCRIPT, 3, 'rbuf', 'rc1', 'rz', 1))).toBe(1);
    await real.eval(USAGE_INCR_SCRIPT, 2, 'rbuf', 'rop9', OT, fu, 10);
    expect(Number(await real.eval(USAGE_CLAIM_SCRIPT, 3, 'rbuf', 'rc1', 'rz', 1))).toBeLessThan(0);
    expect(await real.hget('rc1', fu)).toBe('50');
    expect(await real.hget('rbuf', fu)).toBe('10');
  });

  it('CLAIM refuses an existing destination even with no claim registered (-2)', async () => {
    await real.hset('dbuf', 'f', '1');
    await real.hset('dc1', 'g', '2');
    expect(Number(await real.eval(USAGE_CLAIM_SCRIPT, 3, 'dbuf', 'dc1', 'dz', 1))).toBe(-2);
    expect(await real.hgetall('dc1')).toEqual({ g: '2' });
    expect(await real.hgetall('dbuf')).toEqual({ f: '1' });
  });

  it('a registered-but-missing claim is dropped by TAKEOVER (-1)', async () => {
    await real.zadd('z2', 10, 'lost');
    expect(Number(await real.eval(USAGE_TAKEOVER_SCRIPT, 3, 'z2', 'lost', 'new', 20, 15))).toBe(-1);
    expect(await real.zcard('z2')).toBe(0);
  });

  it('ACK handles more than one HDEL batch of fields', async () => {
    const fields = Array.from({ length: 1_203 }, (_, i) => `f${i}`);
    const args: Array<string | number> = [];
    for (const f of fields) args.push(f, 1);
    await real.eval(USAGE_INCR_SCRIPT, 2, 'big', 'bigop', OT, ...args);
    await real.eval(USAGE_CLAIM_SCRIPT, 3, 'big', 'bigc', 'bz', 1);
    expect(Number(await real.eval(USAGE_ACK_SCRIPT, 3, 'bz', 'bigc', 'bigc:a', AT, ...fields))).toBe(1);
    expect(await real.exists('bigc')).toBe(0);
    expect(await real.zcard('bz')).toBe(0);
  });

  it('the service end to end on real Redis: two flushers, every request counted once', async () => {
    await real.flushdb();
    const usage = new FakeMongoCollection();
    const buckets = new FakeMongoCollection();
    const mk = (owner: string) =>
      new UsageFlushService({ usageWriteMode: 'batched' } as never, usage as never, buckets as never, undefined, {
        redis: async () => real as unknown as UsageBufferRedis,
        namespace: 'contract',
        owner,
        sharedFlushAllowed: () => true,
        timer: false,
        logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
      });
    const a = mk('A');
    const b = mk('B');
    const C = new Types.ObjectId().toHexString();
    let sent = 0;
    for (let round = 0; round < 10; round++) {
      for (let i = 0; i < 20; i++) {
        (i % 2 ? a : b).enqueueUsageCharge(C, 2, '2026-10');
        sent += 1;
      }
      await settle(3);
      await Promise.all([a.flushNow(), b.flushNow()]);
    }
    await settle(5);
    await a.flushNow();
    expect(usage.find({ customerId: C })).toMatchObject({ unitsConsumed: sent * 2, requestCount: sent });
    expect(await real.exists('tw:usage:v1:contract:buf')).toBe(0);
    expect(await real.zcard('tw:usage:v1:contract:claims')).toBe(0);
  });

  it('production wiring: the service opens its OWN connection (tw-usage), never the shared coordination client', async () => {
    await real.flushdb();
    const usage = new FakeMongoCollection();
    const buckets = new FakeMongoCollection();
    const coordination = {
      url: URL,
      namespace: 'own',
      client: async () => {
        throw new Error('the shared coordination client must not be used');
      },
    };
    const svc = new UsageFlushService({ usageWriteMode: 'batched' } as never, usage as never, buckets as never, coordination as never, {
      owner: 'O',
      sharedFlushAllowed: () => true,
      timer: false,
      logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
    });
    const C = new Types.ObjectId().toHexString();
    svc.enqueueUsageCharge(C, 3, '2026-10');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(String(await real.client('LIST'))).toContain('name=tw-usage');
    await svc.flushNow();
    expect(usage.find({ customerId: C })).toMatchObject({ unitsConsumed: 3, requestCount: 1 });
    await svc.onApplicationShutdown();
  });
});
