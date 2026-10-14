/*
 * What the /api budget needed from the shared limiter factory: points handed
 * back (`reward`), and a store chosen per limiter so the budget's rollback is
 * not tied to the auth limiters' (`API_LIMITER_STORE` vs `AUTH_LIMITER_STORE`).
 */
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { beforeEach, describe, expect, it } from 'vitest';
import { LimiterFactory, MEMORY_LIMITER_FACTORY, SharedAuthLimiter } from '../../src/common/limiter-factory.js';
import { __resetAlertPacing } from '../../src/common/redis-gcra.js';
import { FakeSharedRedis, fakeSource } from '../shared-state/fake-redis.js';

async function outcome(run: () => Promise<unknown>): Promise<'ok' | 'limited' | 'error'> {
  try {
    await run();
    return 'ok';
  } catch (err) {
    return err instanceof RateLimiterRes ? 'limited' : 'error';
  }
}

function factoryOn(redis: FakeSharedRedis, store: 'memory' | 'redis') {
  const factory = new LimiterFactory({ authLimiterStore: store } as never, fakeSource(redis, 'test') as never);
  (factory as unknown as { logger: { warn: () => void } }).logger = { warn: () => undefined };
  return factory;
}

beforeEach(() => __resetAlertPacing());

describe('reward (give points back)', () => {
  it('memory: a reward reopens the window by exactly the points returned', async () => {
    const limiter = MEMORY_LIMITER_FACTORY.create('api-limit', '10s', { points: 5, duration: 60 });
    expect(await outcome(() => limiter.consume('k', 5))).toBe('ok');
    expect(await outcome(() => limiter.consume('k', 1))).toBe('limited'); // the library counted that 1 before refusing it
    await limiter.reward('k', 1); // the refund of the refused request
    await limiter.reward('k', 2); // the refund of a cache hit's surcharge
    expect(await outcome(() => limiter.consume('k', 2))).toBe('ok');
    expect(await outcome(() => limiter.consume('k', 1))).toBe('limited');
  });

  it('redis: the same through the shared limiter, and every replica sees it', async () => {
    const redis = new FakeSharedRedis();
    const one = factoryOn(redis, 'redis').create('api-limit', 'hour', { points: 4, duration: 3600 });
    const two = factoryOn(redis, 'redis').create('api-limit', 'hour', { points: 4, duration: 3600 });
    expect(one).toBeInstanceOf(SharedAuthLimiter);
    expect(await outcome(() => one.consume('k', 4))).toBe('ok');
    expect(await outcome(() => two.consume('k', 1))).toBe('limited'); // one budget for both
    await two.reward('k', 1);
    await one.reward('k', 3);
    expect(await outcome(() => one.consume('k', 3))).toBe('ok');
  });

  it('redis down: a reward goes to the per-process insurance limiter and never throws', async () => {
    const redis = new FakeSharedRedis();
    const limiter = factoryOn(redis, 'redis').create('api-limit', 'hour', { points: 2, duration: 3600 });
    redis.failing = true;
    expect(await outcome(() => limiter.consume('k', 2))).toBe('ok'); // insurance
    expect(await outcome(() => limiter.reward('k', 2))).toBe('ok');
    expect(await outcome(() => limiter.consume('k', 2))).toBe('ok');
  });
});

describe('a store per limiter', () => {
  it('a redis factory still builds a memory limiter when the spec says memory', () => {
    const limiter = factoryOn(new FakeSharedRedis(), 'redis').create('api-limit', '10s', { points: 1, duration: 10, store: 'memory' });
    expect(limiter).toBeInstanceOf(RateLimiterMemory);
  });

  it('a memory factory builds a shared limiter when the spec says redis, under its own prefix', () => {
    const factory = factoryOn(new FakeSharedRedis(), 'memory');
    const limiter = factory.create('api-limit', '10s', { points: 1, duration: 10, store: 'redis' });
    expect(limiter).toBeInstanceOf(SharedAuthLimiter);
    expect(factory.stats().prefixes).toEqual(['rl:v1:test:api-limit:10s']);
  });

  it('unset follows the factory: nothing the auth limiters rely on changes', () => {
    expect(factoryOn(new FakeSharedRedis(), 'memory').create('customer', 'login', { points: 1, duration: 10 })).toBeInstanceOf(RateLimiterMemory);
    expect(factoryOn(new FakeSharedRedis(), 'redis').create('customer', 'login', { points: 1, duration: 10 })).toBeInstanceOf(SharedAuthLimiter);
  });

  it('the three api-limit limiters have distinct prefixes that cannot meet an auth limiter', () => {
    const factory = factoryOn(new FakeSharedRedis(), 'redis');
    for (const name of ['10s', 'hour', 'count-miss']) factory.create('api-limit', name, { points: 1, duration: 10 });
    factory.create('customer', 'login', { points: 1, duration: 10 });
    const prefixes = factory.stats().prefixes;
    expect(new Set(prefixes).size).toBe(4);
    expect(prefixes.filter((p) => p.includes(':api-limit:')).length).toBe(3);
  });
});
