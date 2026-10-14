/*
 * The Redis lease (`src/common/redis-lease.ts`): one holder across processes,
 * compare-and-set renew/release, and an explicit `unavailable` when there is
 * no Redis — the helper `/v1/stats` uses now and Phase 2's leader-only jobs
 * will reuse.
 */
import { describe, expect, it } from 'vitest';
import { RedisLease, RELEASE_SCRIPT, RENEW_SCRIPT, withLease } from '../src/common/redis-lease.js';

/** A Redis stand-in for SET NX PX / GET / the two Lua scripts (told apart by their command). */
class FakeRedis {
  readonly store = new Map<string, { value: string; expiresAt: number }>();
  now = 0;
  fail = false;

  private live(key: string) {
    const entry = this.store.get(key);
    if (entry && entry.expiresAt <= this.now) this.store.delete(key);
    return this.store.get(key);
  }

  async set(key: string, value: string, px: 'PX', ttl: number, nx: 'NX'): Promise<'OK' | null> {
    if (this.fail) throw new Error('redis down');
    expect([px, nx]).toEqual(['PX', 'NX']);
    if (this.live(key)) return null;
    this.store.set(key, { value, expiresAt: this.now + ttl });
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async eval(script: string, _keys: number, key: string, owner: string, ttl?: string): Promise<number> {
    if (this.fail) throw new Error('redis down');
    const entry = this.live(key);
    if (!entry || entry.value !== owner) return 0;
    if (script.includes('PEXPIRE')) {
      entry.expiresAt = this.now + Number(ttl);
      return 1;
    }
    if (script.includes('DEL')) {
      this.store.delete(key);
      return 1;
    }
    throw new Error('unknown script');
  }
}

const leaseOn = (redis: FakeRedis | undefined, owner: string, ttlMs = 30_000) =>
  new RedisLease(async () => redis as never, 'tw:lease:test', ttlMs, owner);

describe('RedisLease', () => {
  it('one holder at a time: the second process is told `held` until the first releases', async () => {
    const redis = new FakeRedis();
    const a = leaseOn(redis, 'a');
    const b = leaseOn(redis, 'b');
    expect(await a.acquire()).toBe('acquired');
    expect(await b.acquire()).toBe('held');
    await a.release();
    expect(await b.acquire()).toBe('acquired');
  });

  it('re-acquiring our OWN lease extends it instead of refusing ourselves', async () => {
    const redis = new FakeRedis();
    const a = leaseOn(redis, 'a', 1_000);
    expect(await a.acquire()).toBe('acquired');
    redis.now = 900;
    expect(await a.acquire()).toBe('acquired');
    expect(redis.store.get('tw:lease:test')!.expiresAt).toBe(1_900);
  });

  it('the TTL frees a dead holder; the old holder can then neither renew nor release the NEW lease', async () => {
    const redis = new FakeRedis();
    const a = leaseOn(redis, 'a', 1_000);
    const b = leaseOn(redis, 'b', 1_000);
    expect(await a.acquire()).toBe('acquired');
    redis.now = 1_000; // a stalled past its TTL
    expect(await b.acquire()).toBe('acquired');
    expect(await a.renew()).toBe(false);
    await a.release();
    expect(await redis.get('tw:lease:test')).toBe('b');
    expect(await b.renew()).toBe(true);
  });

  it('no Redis, or a Redis error, is `unavailable` — never a throw', async () => {
    expect(await leaseOn(undefined, 'a').acquire()).toBe('unavailable');
    const redis = new FakeRedis();
    redis.fail = true;
    const a = leaseOn(redis, 'a');
    expect(await a.acquire()).toBe('unavailable');
    expect(await a.renew()).toBe(false);
    await expect(a.release()).resolves.toBeUndefined();
    const broken = new RedisLease(async () => Promise.reject(new Error('connect failed')), 'k', 1_000, 'a');
    expect(await broken.acquire()).toBe('unavailable');
  });

  it('owners default to host:pid:random, unique per lease object', () => {
    const redis = new FakeRedis();
    const one = new RedisLease(async () => redis as never, 'k', 1_000);
    const two = new RedisLease(async () => redis as never, 'k', 1_000);
    expect(one.owner).toMatch(/^.+:\d+:[0-9a-f]{8}$/);
    expect(one.owner).not.toBe(two.owner);
  });
});

describe('withLease', () => {
  it('runs the work only when acquired, and releases after (also when the work throws)', async () => {
    const redis = new FakeRedis();
    const a = leaseOn(redis, 'a');
    await expect(withLease(a, async () => 42)).resolves.toEqual({ ran: true, value: 42 });
    expect(await redis.get('tw:lease:test')).toBeNull();
    await expect(withLease(a, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await redis.get('tw:lease:test')).toBeNull();
    const b = leaseOn(redis, 'b');
    await b.acquire();
    let ran = false;
    await expect(
      withLease(a, async () => {
        ran = true;
      }),
    ).resolves.toEqual({ ran: false, reason: 'held' });
    expect(ran).toBe(false);
    await expect(withLease(leaseOn(undefined, 'c'), async () => 1)).resolves.toEqual({ ran: false, reason: 'unavailable' });
  });
});

describe('the lease scripts', () => {
  // The fake above implements the compare itself, so the Lua is pinned here
  // (and checked against a real Redis on the rig): both act ONLY when the key
  // still holds our owner id, and renew re-arms the full TTL.
  it('renew and release compare the owner before acting', () => {
    for (const script of [RENEW_SCRIPT, RELEASE_SCRIPT]) {
      expect(script).toMatch(/if redis\.call\('GET', KEYS\[1\]\) == ARGV\[1\] then/);
      expect(script).toMatch(/return 0\s*$/);
    }
    expect(RENEW_SCRIPT).toMatch(/redis\.call\('PEXPIRE', KEYS\[1\], ARGV\[2\]\)/);
    expect(RELEASE_SCRIPT).toMatch(/redis\.call\('DEL', KEYS\[1\]\)/);
  });
});
