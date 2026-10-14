/*
 * Package B against a REAL Redis (opt-in):
 *
 *   SHARED_STATE_TEST_REDIS_URL=redis://127.0.0.1:6398 npx vitest run test/shared-state/redis-contract.spec.ts
 *
 * Use a THROWAWAY instance: every case flushes its database.
 *  - GCRA_SCRIPT equals its TS reference model (`LocalGcra`) step for step over
 *    random sequences (multi-bucket atomicity, refusals, counter). Elapsed time
 *    is simulated by moving every stored `ts` back by the same amount in Redis
 *    and in the model; the model then runs at the `ts` the script wrote.
 *  - the pause script, the auth limiters on ioredis, pub/sub through two
 *    CoordinationRedis instances, the indexer fleet budget and the RPC month key.
 */
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CoordinationRedis } from '../../src/common/coordination-redis.js';
import { InvalidationBus } from '../../src/common/invalidation-bus.js';
import { LimiterFactory } from '../../src/common/limiter-factory.js';
import {
  decodeGcraReply,
  GCRA_PAUSE_SCRIPT,
  GCRA_SCRIPT,
  gcraArgs,
  LocalGcra,
  RedisGcra,
  type GcraRequest,
} from '../../src/common/redis-gcra.js';
import { RpcBudget } from '../../src/common/rpc-budget.js';
import { indexerBudgetKeyBase, RedisIndexerSharedBudget } from '../../src/subgraph/hyperindex/indexer-gateway.js';

const URL = process.env.SHARED_STATE_TEST_REDIS_URL;

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe.skipIf(!URL)('package B on a real Redis', () => {
  let redis: Redis;
  beforeAll(() => {
    redis = new Redis(URL!, { maxRetriesPerRequest: 1 });
  });
  beforeEach(async () => {
    await redis.flushdb();
  });
  afterAll(async () => {
    await redis.quit();
  });

  it('GCRA_SCRIPT = LocalGcra over 4 × 300 random steps', async () => {
    for (const seed of [1, 2, 3, 4]) {
      await redis.flushdb();
      const rnd = mulberry32(seed);
      let modelNow = 0;
      const model = new LocalGcra(() => modelNow);
      const modelState = (model as unknown as { buckets: Map<string, { tokens: number; ts: number }> }).buckets;
      const keys = ['b:a', 'b:b', 'b:c'];
      const rates = { 'b:a': 5, 'b:b': 1, 'b:c': 0.5 } as Record<string, number>;
      const bursts = { 'b:a': 10, 'b:b': 2, 'b:c': 1 } as Record<string, number>;
      for (let step = 0; step < 300; step++) {
        const dt = Math.floor(rnd() * 2500);
        for (const k of keys) {
          const ts = await redis.hget(k, 'ts');
          if (ts !== null) await redis.hset(k, 'ts', String(Number(ts) - dt));
          const m = modelState.get(k);
          if (m) m.ts -= dt;
        }
        const chosen = keys.filter(() => rnd() < 0.6);
        if (chosen.length === 0) chosen.push(keys[0]);
        const req: GcraRequest = {
          buckets: chosen.map((k) => ({ key: k, perSec: rates[k], burst: bursts[k], cost: 1 + Math.floor(rnd() * 2) })),
          maxWaitMs: rnd() < 0.3 ? -1 : Math.floor(rnd() * 3000),
          counter: rnd() < 0.5 ? { key: 'ctr', by: 1 + Math.floor(rnd() * 3), ttlSec: 100 } : undefined,
        };
        const { keys: k, argv } = gcraArgs(req);
        const got = decodeGcraReply(await redis.eval(GCRA_SCRIPT, k.length, ...k, ...argv));
        modelNow = Number(await redis.hget(chosen[0], 'ts'));
        const want = model.take(req);
        expect({ step, status: got.status }).toEqual({ step, status: want.status });
        expect(Math.abs(got.waitMs - want.waitMs)).toBeLessThanOrEqual(1);
        if (want.counter !== undefined) expect(got.counter).toBe(want.counter);
        for (const key of chosen) {
          expect(Number(await redis.hget(key, 'tokens'))).toBeCloseTo(modelState.get(key)!.tokens, 6);
        }
      }
      expect(await redis.ttl('ctr')).toBeGreaterThan(90);
    }
  });

  it('pause: refuses without taking, keeps the longer pause', async () => {
    await redis.eval(GCRA_PAUSE_SCRIPT, 1, 'p', '5000');
    await redis.eval(GCRA_PAUSE_SCRIPT, 1, 'p', '100');
    expect(await redis.pttl('p')).toBeGreaterThan(4000);
    const req: GcraRequest = { buckets: [{ key: 'x', perSec: 1, burst: 1, cost: 1 }], maxWaitMs: -1, pauseKey: 'p' };
    const { keys, argv } = gcraArgs(req);
    const got = decodeGcraReply(await redis.eval(GCRA_SCRIPT, keys.length, ...keys, ...argv));
    expect(got.status).toBe('paused');
    expect(got.waitMs).toBeGreaterThan(4000);
    expect(await redis.exists('x')).toBe(0);
  });

  it('auth limiters: two replicas share one budget on ioredis, under their own prefix', async () => {
    const coordA = new CoordinationRedis({ redisUrl: URL, leaderboardSnapshotNamespace: 'contract' } as never);
    const coordB = new CoordinationRedis({ redisUrl: URL, leaderboardSnapshotNamespace: 'contract' } as never);
    try {
      const a = new LimiterFactory({ authLimiterStore: 'redis' } as never, coordA).create('admin', 'login', { points: 2, duration: 60 });
      const b = new LimiterFactory({ authLimiterStore: 'redis' } as never, coordB).create('admin', 'login', { points: 2, duration: 60 });
      await a.consume('admin:x');
      await b.consume('admin:x');
      await expect(a.consume('admin:x')).rejects.toMatchObject({ consumedPoints: 3 });
      expect(await redis.keys('rl:*')).toEqual(['rl:v1:contract:admin:login:admin:x']);
      await b.delete('admin:x');
      expect(await redis.keys('rl:*')).toEqual([]);
    } finally {
      await coordA.close();
      await coordB.close();
    }
  });

  it('invalidation bus: A → B over real pub/sub, A drops its own echo', async () => {
    const cfg = { redisUrl: URL, leaderboardSnapshotNamespace: 'contract', cacheInvalidation: 'redis' } as never;
    const coordA = new CoordinationRedis(cfg);
    const coordB = new CoordinationRedis(cfg);
    const a = new InvalidationBus(cfg, coordA);
    const b = new InvalidationBus(cfg, coordB);
    try {
      a.onModuleInit();
      b.onModuleInit();
      await Promise.all([a.whenSubscribed(), b.whenSubscribed()]);
      const got = new Promise<unknown>((resolve) => b.on('plan', resolve));
      a.publish({ t: 'plan', planKey: 'pro' });
      expect(await got).toMatchObject({ t: 'plan', planKey: 'pro', src: a.id });
      await new Promise((r) => setTimeout(r, 50));
      expect(a.stats()).toMatchObject({ published: 1, droppedSelf: 1, received: 0 });
    } finally {
      await a.onModuleDestroy();
      await b.onModuleDestroy();
      await coordA.close();
      await coordB.close();
    }
  });

  it('indexer fleet budget: all+bg in one call, pause readable by the next take', async () => {
    const shared = new RedisIndexerSharedBudget(new RedisGcra(async () => redis));
    const url = 'https://indexer.example/graphql';
    const rates = { budgetPerMin: 60, backgroundMaxPerMin: 30 };
    expect(await shared.take(url, { all: true, bg: true }, rates)).toEqual({ status: 'taken', ms: 0 });
    const base = indexerBudgetKeyBase(url);
    expect((await redis.keys(`${base}:*`)).sort()).toEqual([`${base}:all`, `${base}:bg`]);
    await shared.pause(url, 3000);
    expect(await shared.take(url, { all: true, bg: false }, rates)).toMatchObject({ status: 'paused' });
  });

  it('RPC budget: per-account bucket and month counter with a TTL', async () => {
    const b = new RpcBudget({ rpcBudgetPerSec: 50 } as never, undefined, { gcra: new RedisGcra(async () => redis) });
    await b.take('fee', 3);
    const month = new Date().toISOString().slice(0, 7);
    expect(await redis.get(`tw:rpc:v1:acct:default:month:${month}`)).toBe('3');
    expect(await redis.ttl(`tw:rpc:v1:acct:default:month:${month}`)).toBeGreaterThan(30 * 24 * 3600);
    expect(await redis.exists('tw:rpc:v1:acct:default')).toBe(1);
  });
});
