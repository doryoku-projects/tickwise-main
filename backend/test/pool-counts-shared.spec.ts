import { afterEach, describe, expect, it, vi } from 'vitest';
import { PositionsRepository } from '../src/database/positions.repository.js';

/**
 * Scale plan 1.11 (interim): pool holder counts are shared through Redis.
 * The process that counts a pool publishes it (TTL = the list stale age);
 * the others adopt it BACKDATED to when it was counted, so no process serves
 * it past the age it would have locally — and one `$group` serves every API
 * replica instead of one each.
 */

function fakeRedis() {
  const store = new Map<string, { value: string; px: number }>();
  const client = {
    store,
    mget: vi.fn(async (...keys: string[]) => keys.map((k) => store.get(k)?.value ?? null)),
    multi: () => {
      const ops: Array<() => void> = [];
      const tx = {
        set: (key: string, value: string, _px: string, ms: number) => {
          ops.push(() => store.set(key, { value, px: ms }));
          return tx;
        },
        exec: async () => {
          for (const op of ops) op();
          return [];
        },
      };
      return tx;
    },
  };
  return client;
}

function repo(redis: ReturnType<typeof fakeRedis> | undefined, rows: Array<{ _id: string; positionsCount: number; holdersCount: number }>) {
  const aggregate = vi.fn(() => rows);
  const model = {
    aggregate: () => {
      const q: Record<string, unknown> = {};
      for (const m of ['read', 'option', 'hint']) q[m] = () => q;
      q.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve().then(aggregate).then(resolve, reject);
      return q;
    },
  };
  const readPathRedis = redis ? { namespace: 'prod0000aaaa1111', client: async () => redis, logError: vi.fn() } : undefined;
  const r = new PositionsRepository(
    { positionModel: () => model } as never,
    { readyLeaderboardExclusions: async () => ({ addresses: [], ok: true }) } as never,
    undefined,
    undefined,
    undefined,
    readPathRedis as never,
  );
  return { repo: r, aggregate, readPathRedis };
}

afterEach(() => vi.useRealTimers());

describe('holder counts shared through Redis', () => {
  it('one process counts and publishes; another ADOPTS it (no aggregation of its own)', async () => {
    const redis = fakeRedis();
    const a = repo(redis, [{ _id: '0xabc', positionsCount: 3, holdersCount: 2 }]);
    expect((await a.repo.countsByPoolIds(1, 'uniswap-v4', ['0xABC'])).get('0xabc')).toEqual({ positionsCount: 3, holdersCount: 2 });
    await vi.waitFor(() => expect(redis.store.size).toBe(1));
    const [[key, entry]] = [...redis.store];
    expect(key).toBe('tw:pc:v1:prod0000aaaa1111:1:uniswap-v4:0xabc');
    expect(entry!.px).toBe(30_000); // the list stale age: nothing older is ever adopted
    expect(JSON.parse(entry!.value)).toMatchObject({ p: 3, h: 2 });

    const b = repo(redis, [{ _id: '0xabc', positionsCount: 99, holdersCount: 99 }]);
    expect((await b.repo.countsByPoolIds(1, 'uniswap-v4', ['0xabc'])).get('0xabc')).toEqual({ positionsCount: 3, holdersCount: 2 });
    expect(b.aggregate).not.toHaveBeenCalled();
  });

  it('an adopted count keeps its OWN age: counted 20 s ago, it is served stale (and recounted), not fresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const redis = fakeRedis();
    const countedAt = Date.now() - 20_000;
    redis.store.set('tw:pc:v1:prod0000aaaa1111:1:uniswap-v4:0xabc', {
      value: JSON.stringify({ p: 3, h: 2, t: countedAt, d: countedAt }),
      px: 30_000,
    });
    const b = repo(redis, [{ _id: '0xabc', positionsCount: 4, holdersCount: 2 }]);
    const meta: { storedAt?: number; dataAsOf?: number } = {};
    expect((await b.repo.countsByPoolIds(1, 'uniswap-v4', ['0xabc'], meta)).get('0xabc')).toEqual({ positionsCount: 3, holdersCount: 2 });
    expect(meta.storedAt).toBe(countedAt);
    expect(meta.dataAsOf).toBeUndefined(); // 20 s: inside the budget
    await vi.waitFor(() => expect(b.aggregate).toHaveBeenCalledTimes(1)); // past fresh: recounted in the background
  });

  it('a shared count older than the stale age, or unreadable, is ignored: this process counts', async () => {
    const redis = fakeRedis();
    redis.store.set('tw:pc:v1:prod0000aaaa1111:1:uniswap-v4:0xold', {
      value: JSON.stringify({ p: 1, h: 1, t: Date.now() - 31_000, d: Date.now() - 31_000 }),
      px: 30_000,
    });
    redis.store.set('tw:pc:v1:prod0000aaaa1111:1:uniswap-v4:0xbad', { value: '{nope', px: 30_000 });
    const b = repo(redis, [
      { _id: '0xold', positionsCount: 5, holdersCount: 5 },
      { _id: '0xbad', positionsCount: 6, holdersCount: 6 },
    ]);
    const out = await b.repo.countsByPoolIds(1, 'uniswap-v4', ['0xold', '0xbad']);
    expect(out.get('0xold')).toEqual({ positionsCount: 5, holdersCount: 5 });
    expect(out.get('0xbad')).toEqual({ positionsCount: 6, holdersCount: 6 });
    expect(b.aggregate).toHaveBeenCalledTimes(1);
  });

  it('Redis down is an accelerator lost: the process counts for itself', async () => {
    const redis = fakeRedis();
    redis.mget.mockRejectedValueOnce(new Error('ECONNRESET'));
    const b = repo(redis, [{ _id: '0xabc', positionsCount: 2, holdersCount: 1 }]);
    expect((await b.repo.countsByPoolIds(1, 'uniswap-v4', ['0xabc'])).get('0xabc')).toEqual({ positionsCount: 2, holdersCount: 1 });
    expect(b.readPathRedis!.logError).toHaveBeenCalled();
  });

  it('a fresh local count is served without asking Redis', async () => {
    const redis = fakeRedis();
    const a = repo(redis, [{ _id: '0xabc', positionsCount: 3, holdersCount: 2 }]);
    await a.repo.countsByPoolIds(1, 'uniswap-v4', ['0xabc']);
    redis.mget.mockClear();
    await a.repo.countsByPoolIds(1, 'uniswap-v4', ['0xabc']);
    expect(redis.mget).not.toHaveBeenCalled();
  });
});
