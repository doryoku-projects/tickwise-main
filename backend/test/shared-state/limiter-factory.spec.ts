/*
 * P2.2 §3.1 — the auth limiters' store.
 *
 * `memory` (the default) must be EXACTLY today's object: a RateLimiterMemory
 * per limiter, per process. `redis` puts every limiter on redis-state under
 * its own `rl:v1:<ns>:<realm>:<name>` prefix so every replica spends ONE
 * budget per key — and falls back to a per-process insurance limiter (today)
 * whenever Redis is unreachable or a command fails. A wrong prefix would merge
 * two realms' budgets, so every one of the 16 is asserted.
 */
import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from '../../src/auth/auth.service.js';
import {
  authLimiterPrefix,
  LimiterFactory,
  MEMORY_LIMITER_FACTORY,
  resolveAuthLimiterStore,
  SharedAuthLimiter,
} from '../../src/common/limiter-factory.js';
import { __resetAlertPacing } from '../../src/common/redis-gcra.js';
import { IdentityService } from '../../src/identity/identity.service.js';
import { CustomerAuthService } from '../../src/portal/customer-auth.service.js';
import { FakeSharedRedis, fakeSource } from './fake-redis.js';

function redisFactory(redis: FakeSharedRedis, ns = 'test') {
  const source = fakeSource(redis, ns);
  const factory = new LimiterFactory({ authLimiterStore: 'redis' } as never, source as never);
  (factory as unknown as { logger: { warn: () => void } }).logger = { warn: () => undefined };
  return { factory, source };
}

async function outcome(run: () => Promise<unknown>): Promise<'ok' | 'limited' | 'error'> {
  try {
    await run();
    return 'ok';
  } catch (err) {
    return err instanceof RateLimiterRes ? 'limited' : 'error';
  }
}

beforeEach(() => __resetAlertPacing());

describe('store resolution', () => {
  it('reads redis only for the literal value redis (any case); everything else is memory', () => {
    expect(resolveAuthLimiterStore('redis')).toBe('redis');
    expect(resolveAuthLimiterStore(' REDIS ')).toBe('redis');
    for (const v of [undefined, '', 'memory', 'mem', 'redis-cluster', 1, null]) expect(resolveAuthLimiterStore(v)).toBe('memory');
  });

  it('memory (no config, or memory) is a plain RateLimiterMemory with the same points and duration', async () => {
    for (const factory of [new LimiterFactory(), new LimiterFactory({ authLimiterStore: 'memory' } as never), MEMORY_LIMITER_FACTORY]) {
      const limiter = factory.create('customer', 'login', { points: 2, duration: 300 });
      expect(limiter).toBeInstanceOf(RateLimiterMemory);
      expect(await outcome(() => limiter.consume('k'))).toBe('ok');
      expect(await outcome(() => limiter.consume('k'))).toBe('ok');
      expect(await outcome(() => limiter.consume('k'))).toBe('limited');
    }
  });

  it('memory never touches Redis', () => {
    const redis = new FakeSharedRedis();
    const factory = new LimiterFactory({ authLimiterStore: 'memory' } as never, fakeSource(redis) as never);
    factory.create('customer', 'login', { points: 2, duration: 300 });
    expect(redis.calls).toBe(0);
  });
});

describe('redis store', () => {
  let redis: FakeSharedRedis;
  beforeEach(() => {
    redis = new FakeSharedRedis();
  });

  it('keys every counter under rl:v1:<ns>:<realm>:<name>', async () => {
    const { factory } = redisFactory(redis, 'prod-abc');
    const limiter = factory.create('customer', 'login', { points: 10, duration: 300 });
    expect(limiter).toBeInstanceOf(SharedAuthLimiter);
    await limiter.consume('customer:a@b.c');
    expect([...redis.kv.keys()]).toEqual(['rl:v1:prod-abc:customer:login:customer:a@b.c']);
  });

  it('two replicas share ONE budget per key (the 3rd consume across both is refused)', async () => {
    const a = redisFactory(redis).factory.create('admin', 'login', { points: 2, duration: 300 });
    const b = redisFactory(redis).factory.create('admin', 'login', { points: 2, duration: 300 });
    expect(await outcome(() => a.consume('admin:x'))).toBe('ok');
    expect(await outcome(() => b.consume('admin:x'))).toBe('ok');
    expect(await outcome(() => a.consume('admin:x'))).toBe('limited');
    expect(await outcome(() => b.consume('admin:x'))).toBe('limited');
  });

  it('a failing store falls to the per-process insurance limiter (today), counted', async () => {
    const { factory } = redisFactory(redis);
    const limiter = factory.create('customer', 'login', { points: 2, duration: 300 });
    redis.failing = true;
    expect(await outcome(() => limiter.consume('k'))).toBe('ok');
    expect(await outcome(() => limiter.consume('k'))).toBe('ok');
    // Insurance is a real budget, not "unlimited while Redis is down".
    expect(await outcome(() => limiter.consume('k'))).toBe('limited');
    expect(factory.stats().insuranceHits).toBe(3);
  });

  it('no client at all (Redis off / connecting) also goes to insurance', async () => {
    const { factory, source } = redisFactory(redis);
    source.down = true;
    const limiter = factory.create('customer', 'signup', { points: 1, duration: 3600 });
    expect(await outcome(() => limiter.consume('ip'))).toBe('ok');
    expect(await outcome(() => limiter.consume('ip'))).toBe('limited');
    expect(redis.calls).toBe(0);
    expect(factory.stats().insuranceHits).toBe(2);
  });

  it('a rate-limit REJECTION is never retried on insurance', async () => {
    const { factory } = redisFactory(redis);
    const limiter = factory.create('customer', 'login', { points: 1, duration: 300 });
    await limiter.consume('k');
    expect(await outcome(() => limiter.consume('k'))).toBe('limited');
    expect(factory.stats().insuranceHits).toBe(0);
  });

  it('delete clears the Redis counter AND any insurance count left from an outage', async () => {
    const { factory } = redisFactory(redis);
    const limiter = factory.create('customer', 'login', { points: 1, duration: 300 });
    redis.failing = true;
    await limiter.consume('k'); // insurance now at 1
    redis.failing = false;
    await limiter.consume('k'); // redis at 1
    await limiter.delete('k');
    expect(redis.kv.size).toBe(0);
    redis.failing = true;
    expect(await outcome(() => limiter.consume('k'))).toBe('ok'); // insurance was cleared too
  });

  it('rebinds to a new client after a reconnect', async () => {
    const { factory, source } = redisFactory(redis);
    const limiter = factory.create('customer', 'login', { points: 5, duration: 300 });
    await limiter.consume('k');
    const other = new FakeSharedRedis();
    (source as unknown as { client: () => Promise<unknown> }).client = async () => other;
    await limiter.consume('k');
    expect(other.kv.size).toBe(1);
  });
});

describe('every auth limiter has its own prefix (no merged realms)', () => {
  it('the 16 limiters of the three services are distinct and realm-namespaced', () => {
    const redis = new FakeSharedRedis();
    const { factory } = redisFactory(redis);
    const config = { isProduction: false, customerEmailVerificationRequired: true } as never;
    new CustomerAuthService({} as never, {} as never, {} as never, config, undefined, factory);
    new IdentityService({} as never, {} as never, {} as never, config, {} as never, {} as never, {} as never, factory);
    new AuthService({} as never, {} as never, config, factory);
    const { prefixes, limiters } = factory.stats();
    expect(limiters).toBe(16);
    expect(new Set(prefixes).size).toBe(16);
    const byRealm = (realm: string) => prefixes.filter((p) => p.startsWith(`rl:v1:test:${realm}:`)).length;
    expect(byRealm('customer')).toBe(12);
    expect(byRealm('sso')).toBe(3);
    expect(byRealm('admin')).toBe(1);
    expect(prefixes).toContain(authLimiterPrefix('test', 'customer', 'loginIp'));
    expect(prefixes).toContain(authLimiterPrefix('test', 'admin', 'login'));
  });
});

describe('end to end: admin login across two replicas', () => {
  afterEach(() => undefined);

  function admin(factory?: LimiterFactory) {
    const adminUsers = { findOne: () => ({ exec: async () => null }) };
    return new AuthService(adminUsers as never, {} as never, {} as never, factory);
  }

  async function status(run: () => Promise<unknown>): Promise<number> {
    try {
      await run();
      return 200;
    } catch (err) {
      return err instanceof HttpException ? err.getStatus() : 500;
    }
  }

  it('redis: 10 wrong passwords split across two replicas → the 11th is 429 on either', async () => {
    const redis = new FakeSharedRedis();
    const a = admin(redisFactory(redis).factory);
    const b = admin(redisFactory(redis).factory);
    for (let i = 0; i < 10; i++) expect(await status(() => (i % 2 ? a : b).login('x@y.z', 'wrong'))).toBe(401);
    expect(await status(() => a.login('x@y.z', 'wrong'))).toBe(429);
    expect(await status(() => b.login('x@y.z', 'wrong'))).toBe(429);
  });

  it('memory (default): each replica has its own 10 — today', async () => {
    const a = admin();
    const b = admin();
    for (let i = 0; i < 10; i++) expect(await status(() => a.login('x@y.z', 'wrong'))).toBe(401);
    expect(await status(() => a.login('x@y.z', 'wrong'))).toBe(429);
    expect(await status(() => b.login('x@y.z', 'wrong'))).toBe(401);
  });
});
