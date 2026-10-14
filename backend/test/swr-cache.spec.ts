import { describe, expect, it, vi } from 'vitest';
import {
  combineCacheStatus,
  listWindowRows,
  stableKey,
  staleSince,
  SwrCache,
  type SwrCacheOptions,
} from '../src/common/cache/swr-cache.js';

/** A cache on a hand-driven clock, with jitter pinned to zero unless asked. */
function makeCache<T>(over: Partial<SwrCacheOptions> = {}) {
  let now = 1_000_000;
  const cache = new SwrCache<T>({
    name: 'spec',
    maxBytes: 1_000_000,
    freshMs: 30_000,
    staleMs: 300_000,
    jitter: 0,
    now: () => now,
    ...over,
  });
  return { cache, advance: (ms: number) => (now += ms), at: () => now };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('SwrCache — fresh / stale / miss', () => {
  it('loads on a miss, then serves fresh without loading again', async () => {
    const { cache, advance } = makeCache<number>();
    const loader = vi.fn(async () => 1);
    expect(await cache.get('k', loader)).toMatchObject({ value: 1, status: 'miss' });
    advance(29_000);
    expect(await cache.get('k', loader)).toMatchObject({ value: 1, status: 'hit' });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('serves a stale value immediately and refreshes it ONCE in the background', async () => {
    const { cache, advance } = makeCache<number>();
    await cache.get('k', async () => 1);
    advance(31_000);
    let release!: (v: number) => void;
    const loader = vi.fn(() => new Promise<number>((resolve) => (release = resolve)));
    expect(await cache.get('k', loader)).toMatchObject({ value: 1, status: 'stale' });
    expect(await cache.get('k', loader)).toMatchObject({ value: 1, status: 'stale' });
    expect(loader).toHaveBeenCalledTimes(1); // single-flight
    release(2);
    await flush();
    expect(await cache.get('k', loader)).toMatchObject({ value: 2, status: 'hit' });
  });

  it('stops serving past the stale age and awaits a load instead', async () => {
    const { cache, advance } = makeCache<number>();
    await cache.get('k', async () => 1);
    advance(300_001);
    expect(await cache.get('k', async () => 9)).toMatchObject({ value: 9, status: 'miss' });
  });

  it('keeps an expired value for peekFallback only, until stale + fallback', () => {
    const { cache, advance } = makeCache<number>({ fallbackMs: 600_000 });
    cache.set('k', 1);
    advance(400_000);
    expect(cache.peek('k')).toBeUndefined();
    expect(cache.peekFallback('k')).toBe(1);
    advance(600_000);
    expect(cache.peekFallback('k')).toBeUndefined();
  });

  it('shares one load between concurrent misses, and caches nothing when it fails', async () => {
    const { cache } = makeCache<number>();
    const boom = new Error('down');
    const loader = vi.fn(async () => {
      throw boom;
    });
    const results = await Promise.allSettled([cache.get('k', loader), cache.get('k', loader)]);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(cache.peek('k')).toBeUndefined();
  });

  it('keeps the stale value when its background refresh fails', async () => {
    const onBackgroundError = vi.fn();
    const { cache, advance } = makeCache<number>({ onBackgroundError });
    await cache.get('k', async () => 1);
    advance(31_000);
    await cache.get('k', async () => {
      throw new Error('timeout');
    });
    await flush();
    expect(onBackgroundError).toHaveBeenCalledTimes(1);
    expect(cache.peek('k')).toMatchObject({ value: 1, status: 'stale' });
  });

  it('runs at most maxBackgroundRefreshes stale refreshes at once', async () => {
    const { cache, advance } = makeCache<number>({ maxBackgroundRefreshes: 2 });
    for (const key of ['a', 'b', 'c']) await cache.get(key, async () => 1);
    advance(31_000);
    const pending = vi.fn(() => new Promise<number>(() => undefined));
    for (const key of ['a', 'b', 'c']) await cache.get(key, pending);
    expect(pending).toHaveBeenCalledTimes(2);
  });

  it('does not store a value its caller marked uncacheable', async () => {
    const { cache } = makeCache<number>();
    expect(await cache.get('k', async () => 1, { shouldStore: () => false })).toMatchObject({ value: 1, status: 'miss' });
    expect(cache.peek('k')).toBeUndefined();
  });

  it('lets a TTL function see how long the load took', async () => {
    const { cache, advance } = makeCache<number>();
    await cache.get(
      'slow',
      async () => {
        advance(2_000);
        return 1;
      },
      { ttl: (_v, loadMs) => ({ freshMs: loadMs > 1_000 ? 600_000 : 1_000, staleMs: 900_000 }) },
    );
    advance(100_000);
    expect(cache.peek('slow')?.status).toBe('hit');
  });

  it('backdates a value set with storedAt', () => {
    const { cache, at } = makeCache<number>();
    cache.set('k', 1, { storedAt: at() - 31_000 });
    expect(cache.peek('k')?.status).toBe('stale');
  });

  it('applies jitter within ±20% of both TTLs', () => {
    for (const random of [0, 1]) {
      const { cache, advance } = makeCache<number>({ jitter: 0.2, random: () => random });
      cache.set('k', 1);
      // random 0 → factor 0.8 (fresh 24 s); random 1 → factor 1.2 (fresh 36 s).
      advance(random === 0 ? 24_001 : 35_999);
      expect(cache.peek('k')?.status).toBe(random === 0 ? 'stale' : 'hit');
    }
  });
});

describe('SwrCache — byte budget', () => {
  it('evicts least-recently-used entries past the budget (JSON length)', () => {
    const { cache } = makeCache<string>({ maxBytes: 30 });
    cache.set('a', 'x'.repeat(8)); // 10 bytes as JSON
    cache.set('b', 'x'.repeat(8));
    cache.peek('a'); // a is now most recently used
    cache.set('c', 'x'.repeat(8));
    cache.set('d', 'x'.repeat(8));
    expect(cache.peek('b')).toBeUndefined();
    expect(cache.peek('a')).toBeDefined();
    expect(cache.totalBytes).toBeLessThanOrEqual(30);
  });

  it('refuses a single value larger than the whole budget', () => {
    const { cache } = makeCache<string>({ maxBytes: 5 });
    expect(cache.set('big', 'too long')).toBe(false);
    expect(cache.size).toBe(0);
  });
});

describe('SwrCache — data age (dataAt) vs cache age', () => {
  it('stamps an entry with its load time less the read\'s replication lag, and keeps the TTLs on the load time', async () => {
    let lag = 20_000;
    const { cache, advance, at } = makeCache<number>({ dataLag: () => lag });
    const first = await cache.get('k', async () => 1);
    expect(first).toMatchObject({ status: 'miss', dataAt: at() - 20_000 });
    lag = 0; // the lag at LOAD time is what the entry carries
    advance(10_000);
    const hit = await cache.get('k', async () => 2);
    expect(hit).toMatchObject({ value: 1, status: 'hit', dataAt: at() - 30_000 });
    // The TTLs still run from the load: a lagging secondary must not turn every entry into a miss.
    expect(cache.peek('k')?.status).toBe('hit');
    expect(cache.peekRetained('k')).toMatchObject({ dataAt: at() - 30_000, storedAt: at() - 10_000 });
  });

  it('a value COMPOSED from cached inputs: `times` backdates its TTLs and its data age to the oldest input', async () => {
    const { cache, at } = makeCache<{ v: number; inputAt: number }>({ freshMs: 15_000, staleMs: 30_000 });
    const loaded = await cache.get('d', async () => ({ v: 1, inputAt: at() - 20_000 }), {
      times: (value) => ({ storedAt: value.inputAt, dataAt: value.inputAt - 5_000 }),
    });
    expect(loaded.dataAt).toBe(at() - 25_000);
    // Built from a 20 s old input: already past fresh — the caches do not stack.
    expect(cache.peek('d')?.status).toBe('stale');
    expect(cache.peekRetained('d')?.storedAt).toBe(at() - 20_000);
  });

  it('`times` can never date a value AFTER its load', async () => {
    const { cache, at } = makeCache<number>();
    const loaded = await cache.get('k', async () => 1, { times: () => ({ storedAt: at() + 60_000, dataAt: at() + 60_000 }) });
    expect(loaded.dataAt).toBe(at());
    expect(cache.peekRetained('k')?.storedAt).toBe(at());
  });

  it('an unstored value still reports its data age (load time less lag)', async () => {
    const { cache, at } = makeCache<number>({ dataLag: () => 7_000 });
    const loaded = await cache.get('k', async () => 1, { shouldStore: () => false });
    expect(loaded.dataAt).toBe(at() - 7_000);
  });

  it('a value SET directly (a snapshot restored) is stamped with the lag too, unless given its own dataAt', () => {
    const { cache, at } = makeCache<number>({ dataLag: () => 9_000 });
    cache.set('a', 1, { storedAt: at() - 5_000 });
    expect(cache.peekRetained('a')?.dataAt).toBe(at() - 14_000);
    cache.set('b', 1, { storedAt: at(), dataAt: at() - 1_000 });
    expect(cache.peekRetained('b')?.dataAt).toBe(at() - 1_000);
  });

  it('`times` cannot date an UNSTORED value after its load either', async () => {
    const { cache, at } = makeCache<number>();
    const loaded = await cache.get('k', async () => 1, { shouldStore: () => false, times: () => ({ dataAt: at() + 60_000 }) });
    expect(loaded.dataAt).toBe(at());
  });

  it('staleSince: flags only data OLDER than the budget, with when it was current', () => {
    expect(staleSince(1_000, 45_000, 46_000)).toBeUndefined(); // exactly the budget
    expect(staleSince(1_000, 45_000, 46_001)).toBe(1_000);
    expect(staleSince(undefined, 45_000, 1e12)).toBeUndefined();
  });
});

describe('stableKey', () => {
  it('ignores key order and undefined, but not values', () => {
    expect(stableKey({ a: 1, b: 'x', c: undefined })).toBe(stableKey({ b: 'x', a: 1 }));
    expect(stableKey({ a: 1 })).not.toBe(stableKey({ a: '1' }));
    expect(stableKey([1, 2])).not.toBe(stableKey([2, 1]));
  });

  it('gives RegExps a distinct form (JSON would turn every one into {})', () => {
    expect(stableKey({ $or: [{ s: /usdc/i }] })).not.toBe(stableKey({ $or: [{ s: /weth/i }] }));
    expect(stableKey(/a/i)).not.toBe(stableKey(/a/));
  });
});

describe('list windows', () => {
  it('rounds page × limit up to the 50-row window, and refuses very deep pages', () => {
    expect(listWindowRows(1, 25)).toBe(50);
    expect(listWindowRows(2, 25)).toBe(50);
    expect(listWindowRows(3, 25)).toBe(100);
    expect(listWindowRows(1, 100)).toBe(100);
    expect(listWindowRows(10, 100)).toBe(1000);
    expect(listWindowRows(11, 100)).toBeNull();
  });

  it('combines shard statuses worst-first', () => {
    expect(combineCacheStatus(['hit', 'hit'])).toBe('hit');
    expect(combineCacheStatus(['hit', 'stale'])).toBe('stale');
    expect(combineCacheStatus(['stale', 'miss', 'hit'])).toBe('miss');
    expect(combineCacheStatus([])).toBe('miss');
  });
});
