/*
 * `GET /v1/stats` (scale plan 1.3): metadata and index-only counts instead of
 * collection scans, pool totals from pool sync's recorded walks, and ONE
 * process computing per 45 s through a Redis lease while the others adopt its
 * result.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PoolsRepository } from '../src/database/pools.repository.js';
import { PositionsRepository } from '../src/database/positions.repository.js';
import { STATS_COLD_WAIT_MS, STATS_HELD_RETRY_MS, STATS_TTL_MS, V1StatsService } from '../src/v1/v1-stats.service.js';

const INTEGRATIONS = [
  { chainId: 1, protocol: 'uniswap-v4' },
  { chainId: 4663, protocol: 'uniswap-v4' },
];

/** A Redis stand-in: GET / SET (PX, NX) and the lease scripts. */
class FakeRedis {
  readonly store = new Map<string, string>();
  sets: string[] = [];
  async get(key: string) {
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string, ...args: unknown[]) {
    if (args.includes('NX') && this.store.has(key)) return null;
    this.store.set(key, value);
    this.sets.push(key);
    return 'OK';
  }
  async eval(script: string, _n: number, key: string, owner: string) {
    if (this.store.get(key) !== owner) return 0;
    if (script.includes('DEL')) this.store.delete(key);
    return 1;
  }
}

function makeService(opts: { walks?: Map<string, unknown>; redis?: FakeRedis; failPositions?: boolean } = {}) {
  const calls: string[] = [];
  const positions = {
    estimatedTotal: vi.fn(async (chainId: number) => {
      calls.push(`positions.estimatedTotal:${chainId}`);
      if (opts.failPositions) throw new Error('mongo down');
      return chainId === 1 ? 430_000 : 400_000;
    }),
    countActive: vi.fn(async (chainId: number) => {
      calls.push(`positions.countActive:${chainId}`);
      return chainId === 1 ? 77_000 : 122_000;
    }),
  };
  const pools = {
    estimatedTotal: vi.fn(async (chainId: number) => {
      calls.push(`pools.estimatedTotal:${chainId}`);
      return chainId === 1 ? 133_100 : 611_300;
    }),
    sumTvlUsd: vi.fn(async (chainId: number) => {
      calls.push(`pools.sumTvlUsd:${chainId}`);
      return { tvlUsd: chainId === 1 ? 533e6 : 68e6, pools: 1 };
    }),
  };
  const syncRepo = { poolWalkStats: vi.fn(async () => opts.walks ?? new Map()) };
  const indexing = { getStatus: vi.fn(async (i: { chainId: number }) => ({ indexedUpToTimestamp: i.chainId === 1 ? 1_790_000_000 : 1_790_000_500 })) };
  const readPathRedis = opts.redis
    ? { client: async () => opts.redis, namespace: 'ns', logError: () => {} }
    : undefined;
  const service = new V1StatsService(
    { enabledIntegrations: INTEGRATIONS } as never,
    positions as never,
    pools as never,
    syncRepo as never,
    indexing as never,
    readPathRedis as never,
  );
  (service as unknown as { logger: unknown }).logger = { warn: () => {}, log: () => {} };
  return { service, positions, pools, syncRepo, calls };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('what /v1/stats reads', () => {
  it('positions: metadata count + index-only active count; pools: the recorded complete walk — no pools read at all', async () => {
    const walks = new Map([
      ['1:uniswap-v4', { pools: 133_000, tvlUsd: 500e6, skipped: 0, finishedAt: new Date() }],
      ['4663:uniswap-v4', { pools: 611_000, tvlUsd: 60e6, skipped: 0, finishedAt: new Date() }],
    ]);
    const { service, pools, calls } = makeService({ walks });
    const stats = await service.read();
    expect(pools.estimatedTotal).not.toHaveBeenCalled();
    expect(pools.sumTvlUsd).not.toHaveBeenCalled();
    expect(calls.sort()).toEqual([
      'positions.countActive:1',
      'positions.countActive:4663',
      'positions.estimatedTotal:1',
      'positions.estimatedTotal:4663',
    ]);
    expect(stats).toMatchObject({ positions: 830_000, activePositions: 199_000, pools: 744_000, tvlUsd: 560e6 });
    expect(stats.byChain.find((c) => c.chainId === 4663)).toMatchObject({ pools: 611_000, tvlUsd: 60e6, activePositions: 122_000 });
    expect(stats.indexedTo).toBe(new Date(1_790_000_500 * 1000).toISOString());
  });

  it('a shard with no recorded walk falls back to the pools metadata count + the covered TVL sum', async () => {
    const walks = new Map([['1:uniswap-v4', { pools: 133_000, tvlUsd: 500e6, skipped: 0, finishedAt: new Date() }]]);
    const { service, pools } = makeService({ walks });
    const stats = await service.read();
    expect(pools.estimatedTotal.mock.calls.map((c) => c[0])).toEqual([4663]);
    expect(pools.sumTvlUsd.mock.calls.map((c) => c[0])).toEqual([4663]);
    expect(stats.byChain.find((c) => c.chainId === 4663)).toMatchObject({ pools: 611_300, tvlUsd: 68e6 });
  });

  it('a walk that SKIPPED pools (pricing threw) reads the stored rows instead — its TVL left them out', async () => {
    // The skipped pools keep their last stored TVL and stay in the lists; the
    // walk's own sum would under-state what is indexed (the homepage tile).
    const walks = new Map([
      ['1:uniswap-v4', { pools: 133_000, tvlUsd: 500e6, skipped: 0, finishedAt: new Date() }],
      ['4663:uniswap-v4', { pools: 611_000, tvlUsd: 59e6, skipped: 2, finishedAt: new Date() }],
    ]);
    const { service, pools } = makeService({ walks });
    const stats = await service.read();
    expect(pools.sumTvlUsd.mock.calls.map((c) => c[0])).toEqual([4663]);
    expect(pools.estimatedTotal.mock.calls.map((c) => c[0])).toEqual([4663]);
    expect(stats.byChain.find((c) => c.chainId === 4663)).toMatchObject({ pools: 611_300, tvlUsd: 68e6 });
    expect(stats.byChain.find((c) => c.chainId === 1)).toMatchObject({ pools: 133_000, tvlUsd: 500e6 });
  });

  it('a failed walk-totals read only sends every shard to the fallback', async () => {
    const { service, syncRepo, pools } = makeService();
    syncRepo.poolWalkStats.mockRejectedValueOnce(new Error('cursor read failed'));
    const stats = await service.read();
    expect(pools.sumTvlUsd).toHaveBeenCalledTimes(2);
    expect(stats.pools).toBe(744_400);
  });
});

describe('caching without Redis (each process alone, as before)', () => {
  it('fresh for 45 s; stale serves last-good and refreshes once in the background', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { service, positions } = makeService();
    await service.read();
    await service.read();
    expect(positions.estimatedTotal).toHaveBeenCalledTimes(2); // one compute, two shards
    vi.setSystemTime(Date.now() + STATS_TTL_MS);
    const stale = service.read();
    await stale;
    await vi.waitFor(() => expect(positions.estimatedTotal).toHaveBeenCalledTimes(4));
  });

  it('a cold failure RE-THROWS (never "0 positions indexed"); a warm one keeps the last value', async () => {
    const cold = makeService({ failPositions: true });
    await expect(cold.service.read()).rejects.toThrow('mongo down');
    vi.useFakeTimers({ toFake: ['Date'] });
    const warm = makeService();
    const first = await warm.service.read();
    warm.positions.estimatedTotal.mockRejectedValue(new Error('mongo down'));
    vi.setSystemTime(Date.now() + STATS_TTL_MS + 1);
    await expect(warm.service.read()).resolves.toEqual(first);
  });
});

describe('one process computes (Redis lease + shared copy)', () => {
  it('the lease holder computes and publishes with a 45 s TTL; another process ADOPTS it without computing', async () => {
    const redis = new FakeRedis();
    const a = makeService({ redis });
    const b = makeService({ redis });
    const fromA = await a.service.read();
    expect(redis.sets).toContain('tw:stats:v1:ns');
    expect(redis.store.has('tw:lease:v1:ns:v1-stats')).toBe(false); // released
    const fromB = await b.service.read();
    expect(fromB).toEqual(fromA);
    expect(b.positions.estimatedTotal).not.toHaveBeenCalled();
  });

  it('a COLD process whose refresh finds the lease held waits for the holder\'s result instead of computing too', async () => {
    const redis = new FakeRedis();
    redis.store.set('tw:lease:v1:ns:v1-stats', 'someone-else');
    const b = makeService({ redis });
    const sleeps: number[] = [];
    (b.service as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async (ms) => {
      sleeps.push(ms);
      if (sleeps.length === 3) {
        const holder = makeService();
        const value = await holder.service.read();
        redis.store.set('tw:stats:v1:ns', JSON.stringify({ computedAt: Date.now(), value }));
      }
    };
    const stats = await b.service.read();
    expect(stats.positions).toBe(830_000);
    expect(b.positions.estimatedTotal).not.toHaveBeenCalled();
    expect(sleeps).toHaveLength(3);
  });

  it('…and computes itself when nothing arrives within the cold wait', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const redis = new FakeRedis();
    redis.store.set('tw:lease:v1:ns:v1-stats', 'someone-else');
    const b = makeService({ redis });
    (b.service as unknown as { sleep: (ms: number) => Promise<void> }).sleep = async (ms) => {
      vi.setSystemTime(Date.now() + ms);
    };
    const t0 = Date.now();
    await b.service.read();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(STATS_COLD_WAIT_MS);
    expect(b.positions.estimatedTotal).toHaveBeenCalledTimes(2);
  });

  it('a process with a STALE value whose refresh finds the lease held serves it and asks again only after a second', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const redis = new FakeRedis();
    const b = makeService({ redis });
    await b.service.read(); // computed and published
    redis.store.delete('tw:stats:v1:ns'); // the shared copy expired …
    redis.store.set('tw:lease:v1:ns:v1-stats', 'someone-else'); // … and another process is recomputing it
    vi.setSystemTime(Date.now() + STATS_TTL_MS + 1);
    const getSpy = vi.spyOn(redis, 'get');
    await b.service.read();
    await vi.waitFor(() => expect(getSpy).toHaveBeenCalled());
    await Promise.resolve();
    const reads = getSpy.mock.calls.length;
    await b.service.read();
    await b.service.read();
    expect(getSpy.mock.calls.length).toBe(reads); // within the retry window: no new Redis read
    vi.setSystemTime(Date.now() + STATS_HELD_RETRY_MS);
    await b.service.read();
    await vi.waitFor(() => expect(getSpy.mock.calls.length).toBeGreaterThan(reads));
    expect(b.positions.estimatedTotal).toHaveBeenCalledTimes(2); // never recomputed while held
  });

  it('a shared copy older than the TTL is not adopted', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const redis = new FakeRedis();
    const holder = makeService();
    const value = await holder.service.read();
    redis.store.set('tw:stats:v1:ns', JSON.stringify({ computedAt: Date.now() - STATS_TTL_MS, value: { ...value, positions: 1 } }));
    const b = makeService({ redis });
    const stats = await b.service.read();
    expect(stats.positions).toBe(830_000);
    expect(b.positions.estimatedTotal).toHaveBeenCalled();
  });
});

describe('the repository reads behind it', () => {
  it('positions: estimatedDocumentCount on a secondary; the active count hinted to bg_active_walk with the exact filter', async () => {
    const seen: Array<{ op: string; filter?: unknown; hint?: unknown }> = [];
    const chain = (op: string, filter?: unknown) => {
      const entry: { op: string; filter?: unknown; hint?: unknown } = { op, filter };
      seen.push(entry);
      const q = {
        read: () => q,
        maxTimeMS: () => q,
        hint: (h: unknown) => {
          entry.hint = h;
          return q;
        },
        exec: async () => 7,
      };
      return q;
    };
    const model = {
      estimatedDocumentCount: () => chain('estimated'),
      countDocuments: (filter: unknown) => chain('count', filter),
    };
    const repo = new PositionsRepository({ positionModel: () => model, hintUnusable: () => undefined } as never, {} as never);
    expect(await repo.estimatedTotal(1, 'uniswap-v4')).toBe(7);
    expect(await repo.countActive(1, 'uniswap-v4')).toBe(7);
    expect(seen).toEqual([
      { op: 'estimated', filter: undefined },
      { op: 'count', filter: { chainId: 1, protocol: 'uniswap-v4', isActive: true }, hint: 'bg_active_walk' },
    ]);
  });

  it('pools: the TVL sum reads the TVL index keys (tvl > 0 only), retried unhinted when the index is missing', async () => {
    const hints: unknown[] = [];
    let pipeline: unknown;
    let fail = true;
    const model = {
      aggregate: (p: unknown) => {
        pipeline = p;
        const agg = {
          read: () => agg,
          option: () => agg,
          hint: (h: unknown) => {
            hints.push(h);
            return agg;
          },
          exec: async () => {
            if (hints.length > 0 && fail) {
              fail = false;
              throw Object.assign(new Error('hint provided does not correspond to an existing index'), { code: 2, codeName: 'BadValue' });
            }
            return [{ total: 12.5, n: 3 }];
          },
        };
        return agg;
      },
    };
    const repo = new PoolsRepository({ poolModel: () => model } as never, {} as never);
    expect(await repo.sumTvlUsd(1, 'uniswap-v4')).toEqual({ tvlUsd: 12.5, pools: 3 });
    expect(hints).toEqual(['chainId_1_protocol_1_metrics.tvlUsd_-1']);
    expect(pipeline).toEqual([
      { $match: { chainId: 1, protocol: 'uniswap-v4', 'metrics.tvlUsd': { $gt: 0 } } },
      { $group: { _id: null, total: { $sum: '$metrics.tvlUsd' }, n: { $sum: 1 } } },
    ]);
  });
});
