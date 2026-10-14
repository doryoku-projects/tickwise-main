import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { POOL_SORT_FIELD_MAP, PoolsRepository } from '../../src/database/pools.repository.js';
import { POOL_PERMS, permFor } from '../../src/read-models/pools/pool-columns.js';
import type { PoolCatalogService } from '../../src/read-models/pools/pool-catalog.service.js';
import type { PoolsService } from '../../src/pools/pools.service.js';
import { prng, type Doc } from '../support/mini-mongo.js';
import { buildStore, catalogFor, CHAINS, makeConfig, makePools, oidOf, PROTO, poolsRepo, poolsService, shardsFor, touch, upsertRow } from './pools-support.js';
import { shardKey } from '../../src/read-models/core/fields.js';
import type { ModelStore } from '../../src/read-models/core/model-store.js';

/**
 * The pool catalog's acceptance bar (design §9.1 `pool-catalog-parity`): the
 * REAL `PoolsService.getTopPools` / `getTopPoolsCount` over mini-mongo shards
 * (the Mongo path, the oracle) and the same service answered by the catalog
 * in `serve` must return the SAME response — rows, order, ranks, pagination
 * (25k-style cap at 37 here, `totalCapped`, the deep past-the-end rule),
 * holder counts, flags — for random filters over pools with $0-TVL stubs,
 * negative / NaN / ±Infinity / -0 / null / missing values, TVL past the
 * ceiling, tie storms, shared poolId prefixes, case and Unicode symbols,
 * excluded and equity tokens. Every compared answer must have been SERVED by
 * the catalog (no silent fallback).
 */

const SIZES = { 1: 700, 42161: 420, 4663: 1_600 };
/** More requests / another seed for a longer local run: `POOL_PARITY_N=5000 POOL_PARITY_SEED=3`. */
const N = Number(process.env.POOL_PARITY_N ?? 500);
const SEED = Number(process.env.POOL_PARITY_SEED ?? 7);
const SEARCHES = [undefined, undefined, undefined, 'usd', 'USD', 'ſ', 'S', 'K', 'k', '0x', '0xab', 'AB12', '0XABCDEF', 'é', '金', 'a.b', '(x', '\\', 'weth', 'ETH', ' ', 'line\nb', '🍏', 'İ', 'i', 'aaaa', '0x00aaaa'];
const FLOORS: unknown[] = [0, 0, 0, 0.5, 10_000, 10_000, 123.45, 1e6, 6e10, -3, '500'];
const LIMITS = [1, 7, 20, 20, 50, 100];

interface Q {
  chainId?: number;
  protocol: string;
  sort: string;
  page: number;
  limit: number;
  minTvlUsd: number;
  includeRisky: boolean;
  search?: string;
  assetClass?: 'equity';
}

function randomQuery(rand: () => number): Q {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  const limit = pick(LIMITS);
  const deep = rand() < 0.25;
  const page = deep ? Math.ceil(1_001 / limit) + Math.floor(rand() * 15) : 1 + Math.floor(rand() * (rand() < 0.5 ? 3 : 40));
  return {
    chainId: pick([1, 42161, 4663, undefined, undefined]),
    protocol: PROTO,
    sort: pick(['tvl', 'volume', 'fees', 'fee_apr', 'age']),
    page,
    limit,
    minTvlUsd: pick(FLOORS) as number,
    includeRisky: rand() < 0.5,
    search: pick(SEARCHES),
    assetClass: rand() < 0.12 ? 'equity' : undefined,
  };
}

async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    return { ok: false, error: `${(err as Error)?.name}:${(err as Error)?.message}` };
  }
}

describe('pool catalog parity with the Mongo path (property)', () => {
  let shards: Map<number, Doc[]>;
  let store: ModelStore;
  let catalog: PoolCatalogService;
  let oracle: PoolsService;
  let engine: PoolsService;
  const config = makeConfig();

  beforeAll(async () => {
    shards = shardsFor(SEED, SIZES, { missingAddresses: true });
    store = buildStore(shards);
    ({ catalog } = await catalogFor(store, config));
    oracle = poolsService(poolsRepo(shards, config).repo, config);
    engine = poolsService(poolsRepo(shards, config).repo, config, catalog);
  });

  afterEach(() => vi.useRealTimers());

  it('covers every pools-list sort with a permutation', () => {
    const repo = new PoolsRepository({} as never, {} as never);
    for (const sort of Object.keys(POOL_SORT_FIELD_MAP)) {
      expect(permFor(repo.sortFieldFor(sort), repo.sortDirectionFor(sort)), sort).toBeGreaterThanOrEqual(0);
    }
    expect(POOL_PERMS).toHaveLength(Object.keys(POOL_SORT_FIELD_MAP).length);
  });

  it('builds every shard, with every pool (stubs included)', () => {
    const generation = catalog.catalog!.current!;
    for (const chainId of CHAINS) {
      const shard = generation.shards.get(shardKey(chainId, PROTO))!;
      expect(shard.cols.live).toBe(shards.get(chainId)!.length);
      expect(shard.permLen).toBe(shards.get(chainId)!.length);
    }
  });

  it('answers random list requests exactly like the Mongo path (/v1 count wait)', async () => {
    const rand = prng(11 + SEED);
    let served = 0;
    for (let i = 0; i < N; i++) {
      const q = randomQuery(rand);
      const before = (catalog.status().requests as { served: number }).served;
      const [a, b] = await Promise.all([settle(oracle.getTopPools(q as never, { countWaitMs: 2_000 })), settle(engine.getTopPools(q as never, { countWaitMs: 2_000 }))]);
      expect(b, JSON.stringify(q)).toEqual(a);
      const after = (catalog.status().requests as { served: number }).served;
      if (a.ok) {
        expect(after - before, `served ${JSON.stringify(q)}`).toBe(1);
        served++;
      }
    }
    // Pages holding a pool with no token address throw on BOTH paths (the response builder).
    expect(served).toBeGreaterThan(N * 0.8);
  }, Math.max(60_000, N * 30));

  it('answers /api lists (totalPending on a first view, then the cached count) and /count like the Mongo path', async () => {
    const rand = prng(23);
    for (let i = 0; i < 120; i++) {
      const q = { ...randomQuery(rand), page: 1 + Math.floor(rand() * 3) };
      const first = await Promise.all([settle(oracle.getTopPools(q as never)), settle(engine.getTopPools(q as never))]);
      expect(first[1], JSON.stringify(q)).toEqual(first[0]);
      const counts = await Promise.all([settle(oracle.getTopPoolsCount(q as never)), settle(engine.getTopPoolsCount(q as never))]);
      expect(counts[1], JSON.stringify(q)).toEqual(counts[0]);
      const again = await Promise.all([settle(oracle.getTopPools(q as never)), settle(engine.getTopPools(q as never))]);
      expect(again[1], JSON.stringify(q)).toEqual(again[0]);
    }
  }, 60_000);

  it('pins the deep past-the-end rule: exact uncapped total beyond the windows, capped counts inside them', async () => {
    const q = { chainId: 4663, protocol: PROTO, sort: 'tvl', minTvlUsd: 0, includeRisky: true } as const;
    const excluded = new Set(['0x00aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '0x03aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '0x04aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
    const total = shards.get(4663)!.filter((d) => {
      const tvl = (d.metrics as Doc | null)?.tvlUsd;
      const legs = [(d.token0 as Doc).address, (d.token1 as Doc).address] as string[];
      return typeof tvl === 'number' && tvl >= 0 && tvl <= 5e10 && !legs.some((a) => excluded.has(a));
    }).length;
    expect(total).toBeGreaterThan(1_000);
    const deepPast = { ...q, page: Math.ceil(total / 100) + 3, limit: 100 };
    const [a, b] = await Promise.all([oracle.getTopPools(deepPast as never), engine.getTopPools(deepPast as never)]);
    expect(b).toEqual(a);
    expect(b.pools).toEqual([]);
    // Uncapped (the cap is 37) and exact, with no count read.
    expect(b.pagination).toMatchObject({ total, hasMore: false });
    expect(b.pagination).not.toHaveProperty('totalCapped');
    const windowPast = { ...q, page: 40, limit: 20, minTvlUsd: 1e6 };
    const [c, d] = await Promise.all([oracle.getTopPools(windowPast as never, { countWaitMs: 2_000 }), engine.getTopPools(windowPast as never, { countWaitMs: 2_000 })]);
    expect(d).toEqual(c);
  });

  it('/api, cold count cache, no count wait: a deep page past the end carries Mongo’s exact total at once (served by the catalog)', async () => {
    const q = { chainId: 4663, protocol: PROTO, sort: 'tvl', minTvlUsd: 0, includeRisky: true, limit: 100 } as const;
    for (const page of [40, 80]) {
      // fresh services: a cold count cache on both paths, the /api path (no countWaitMs)
      const coldOracle = poolsService(poolsRepo(shards, config).repo, config);
      const coldEngine = poolsService(poolsRepo(shards, config).repo, config, catalog);
      const served = (catalog.status().requests as { served: number }).served;
      const [a, b] = await Promise.all([coldOracle.getTopPools({ ...q, page } as never), coldEngine.getTopPools({ ...q, page } as never)]);
      expect((catalog.status().requests as { served: number }).served, `page ${page}`).toBe(served + 1);
      expect(b.pagination, `page ${page}`).toEqual(a.pagination);
      expect(a.pagination, `page ${page}`).not.toHaveProperty('totalPending');
      expect(b).toEqual(a);
    }
  });

  it('stays exact through generations: inserts, updates (a stub priced, a row moving across the floor), deletes', async () => {
    // Its own fixture, built under the fake clock so every cache ages with it.
    vi.useFakeTimers({ toFake: ['Date'] });
    const shards = shardsFor(8, SIZES);
    const store = buildStore(shards);
    const { catalog } = await catalogFor(store, config);
    const engine = poolsService(poolsRepo(shards, config).repo, config, catalog);
    const rand = prng(99);
    for (let round = 0; round < 4; round++) {
      // Mutate the Mongo shards AND the model store the same way.
      for (const chainId of CHAINS) {
        const docs = shards.get(chainId)!;
        const fresh = makePools(1_000 + round * 10 + chainId, chainId, 25);
        for (const doc of fresh) {
          docs.push(doc);
          upsertRow(store, chainId, doc);
        }
        for (let k = 0; k < 30; k++) {
          const doc = docs[Math.floor(rand() * docs.length)]!;
          doc.metrics = { ...(doc.metrics as Doc | null), tvlUsd: [0, 12_345, 1e6, NaN, null][Math.floor(rand() * 5)], volumeUsd24h: rand() * 1000 };
          doc.pricing = { source: rand() < 0.5 ? 'none' : 'stable-anchor', usedFallback: rand() < 0.5 };
          upsertRow(store, chainId, doc);
        }
        for (let k = 0; k < 10; k++) {
          const index = Math.floor(rand() * docs.length);
          const [gone] = docs.splice(index, 1);
          store.table('pools', shardKey(chainId, PROTO))!.delete(oidOf(gone!));
        }
      }
      vi.setSystemTime(Date.now() + 60_000); // past every cache
      touch(store);
      await catalog.tick();
      const fresh = poolsService(poolsRepo(shards, config).repo, config);
      for (let i = 0; i < 80; i++) {
        const q = randomQuery(rand);
        const [a, b] = await Promise.all([settle(fresh.getTopPools(q as never, { countWaitMs: 2_000 })), settle(engine.getTopPools(q as never, { countWaitMs: 2_000 }))]);
        expect(b, `round ${round} ${JSON.stringify(q)}`).toEqual(a);
      }
    }
  }, 60_000);
});
