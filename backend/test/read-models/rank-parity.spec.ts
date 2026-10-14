import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { leaderboardSortSpec } from '../../src/database/positions.repository.js';
import { shardKey } from '../../src/read-models/core/fields.js';
import type { ModelStore } from '../../src/read-models/core/model-store.js';
import { RANK_PERMS, rankPermFor } from '../../src/read-models/rank/rank-columns.js';
import type { RankEngineService } from '../../src/read-models/rank/rank-engine.service.js';
import type { LeaderboardService } from '../../src/leaderboard/leaderboard.service.js';
import { prng, type Doc } from '../support/mini-mongo.js';
import {
  buildRankStore,
  CHAINS,
  leaderboardService,
  makePositions,
  makeRankConfig,
  OWNERS,
  oidOf,
  POOLS,
  positionsRepo,
  PROTO,
  rankFor,
  shardsFor,
  SORTS,
  touch,
  upsertRow,
} from './rank-support.js';

/**
 * The rank engine's acceptance bar (design §9.1 `rank-parity`, the core gate):
 * the REAL `LeaderboardService.getTopPositions` / `getTopPositionsCount` over
 * mini-mongo shards (the Mongo path — `buildLeaderboardFilter`, the shapes,
 * the collation, the windows, the deep walk, the count contract: the oracle)
 * and the same service answered by the rank engine in `serve` must return the
 * SAME response — rows, order, ranks, pagination (cap 37 here, `totalCapped`,
 * the deep past-the-end rule, the pool / lookup exact totals), flags — over
 * the full filter matrix: every sort × status (± activeOnly) × range × value
 * floors × pool-TVL floors × risky × equity × shape (ranked, owner, owner +
 * poolId, pool, lookup canonical / missing / non-canonical) × pages (first,
 * mid, last, past the end, deep, deep past the end) × limits × one chain / all
 * chains × /api and /v1 — on data with NaN / null / missing / ±Infinity / −0
 * values, tie storms, positionIds shared across chains, collation-equal owners,
 * pools and excluded tokens (`0x00a1…` == `0x0a01…`), case variants, 'NONE'
 * sources and null booleans. Every compared answer must have been SERVED by
 * the engine (no silent fallback).
 */

const SIZES = { 1: 1_400, 42161: 900, 4663: 2_300 };
/** More requests / another seed for a longer local run: `RANK_PARITY_N=5000 RANK_PARITY_SEED=3`. */
const N = Number(process.env.RANK_PARITY_N ?? 600);
const SEED = Number(process.env.RANK_PARITY_SEED ?? 11);
const LIMITS = [1, 7, 20, 20, 25, 50, 100];
const VALUE_FLOORS = [0, 0, 0, 0.5, 500, 500, 1_000, 10_000, 123.45];
const TVL_FLOORS = [0, 0, 1_000, 777];

interface Q {
  chainId?: number;
  protocol: string;
  sort: string;
  page: number;
  limit: number;
  activeOnly: boolean;
  status?: 'active' | 'inactive' | 'all';
  range?: string;
  minValueUsd: number;
  minPoolTvl: number;
  includeRisky: boolean;
  positionId?: string;
  poolId?: string;
  owner?: string;
  assetClass?: 'equity';
}

function randomQuery(rand: () => number, shards: Map<number, Doc[]>): Q {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  const limit = pick(LIMITS);
  const r = rand();
  const page = r < 0.2 ? Math.ceil(1_001 / limit) + Math.floor(rand() * (limit >= 50 ? 20 : 400)) : r < 0.3 ? 1 + Math.floor(rand() * 200) : 1 + Math.floor(rand() * 4);
  const q: Q = {
    chainId: pick([1, 42161, 4663, undefined, undefined]),
    protocol: PROTO,
    sort: pick(SORTS),
    page,
    limit,
    activeOnly: rand() < 0.6,
    status: pick(['active', 'inactive', 'all', undefined] as const),
    range: pick(['in', 'out', 'all', undefined]),
    minValueUsd: pick(VALUE_FLOORS),
    minPoolTvl: pick(TVL_FLOORS),
    includeRisky: rand() < 0.5,
    assetClass: rand() < 0.1 ? 'equity' : undefined,
  };
  const shape = rand();
  if (shape < 0.12) q.owner = pick(OWNERS).toLowerCase();
  else if (shape < 0.16) {
    q.owner = pick(OWNERS).toLowerCase();
    q.poolId = pick(POOLS);
  } else if (shape < 0.28) q.poolId = rand() < 0.9 ? pick(POOLS) : `0x${'9'.repeat(64)}`;
  else if (shape < 0.36) {
    const docs = shards.get(q.chainId ?? pick(CHAINS))!;
    q.positionId = pick([String(docs[Math.floor(rand() * docs.length)]!.positionId), '999999', '007', '0', 'abc', '4294967296', '1']);
    if (rand() < 0.2) q.owner = pick(OWNERS).toLowerCase();
    if (rand() < 0.2) q.poolId = pick(POOLS);
  }
  return q;
}

async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    return { ok: false, error: `${(err as Error)?.name}:${(err as Error)?.message}` };
  }
}

function served(rank: RankEngineService): number {
  return (rank.status().requests as { served: number }).served;
}

describe('rank engine parity with the Mongo path (property)', () => {
  let shards: Map<number, Doc[]>;
  let store: ModelStore;
  let rank: RankEngineService;
  let oracle: LeaderboardService;
  let engine: LeaderboardService;
  const config = makeRankConfig();
  let confirmedAt = 0;
  /**
   * The feeder confirms it is caught up every second in production; the store
   * here is static, so long runs re-confirm it (and publish a generation) to
   * keep the data younger than the 45 s staleness budget — or every answer
   * would (correctly) carry `stale` + `dataAsOf`.
   */
  async function confirm(): Promise<void> {
    if (Date.now() - confirmedAt < 5_000) return;
    touch(store);
    await rank.tick();
    confirmedAt = Date.now();
  }

  beforeAll(async () => {
    shards = shardsFor(SEED, SIZES);
    store = buildRankStore(shards);
    ({ rank } = await rankFor(store, config));
    confirmedAt = Date.now();
    oracle = leaderboardService(positionsRepo(shards, config).repo, config);
    engine = leaderboardService(positionsRepo(shards, config).repo, config, rank);
  });

  afterEach(() => vi.useRealTimers());

  it('covers every leaderboard sort with a permutation (and its walk direction)', () => {
    for (const sort of SORTS) {
      const spec = leaderboardSortSpec(sort);
      const got = rankPermFor(spec.field, spec.direction, spec.tieDirection);
      expect(got, sort).toBeDefined();
      expect(RANK_PERMS[got!.perm]!.leaf).toBeGreaterThanOrEqual(0);
    }
    expect(rankPermFor('tokenId', 1, -1)).toBeUndefined();
  });

  it('builds every shard with every position', () => {
    const generation = rank.engine!.current!;
    for (const chainId of CHAINS) {
      const shard = generation.shards.get(shardKey(chainId, PROTO))!;
      expect(shard.cols.live).toBe(shards.get(chainId)!.length);
      expect(shard.permLen[RANK_PERMS.length - 1]).toBe(shards.get(chainId)!.length);
    }
  });

  it('answers random list requests exactly like the Mongo path (/v1 count wait)', async () => {
    const rand = prng(101 + SEED);
    let compared = 0;
    for (let i = 0; i < N; i++) {
      await confirm();
      const q = randomQuery(rand, shards);
      const before = served(rank);
      const [a, b] = await Promise.all([settle(oracle.getTopPositions(q as never, { countWaitMs: 2_000 })), settle(engine.getTopPositions(q as never, { countWaitMs: 2_000 }))]);
      expect(b, JSON.stringify(q)).toEqual(a);
      if (a.ok) {
        expect(served(rank) - before, `served ${JSON.stringify(q)}`).toBe(1);
        compared++;
      }
    }
    expect(compared).toBe(N);
  }, Math.max(120_000, N * 200));

  it('answers /api lists (totalPending on a first view, then the cached count) and /count like the Mongo path', async () => {
    // Fresh services: each carries its own count cache, and two caches warmed by the
    // earlier test expire at different (jittered) moments — a first view must be cold on both.
    const oracle = leaderboardService(positionsRepo(shards, config).repo, config);
    const engine = leaderboardService(positionsRepo(shards, config).repo, config, rank);
    const rand = prng(23 + SEED);
    for (let i = 0; i < 150; i++) {
      await confirm();
      const q = { ...randomQuery(rand, shards), page: 1 + Math.floor(rand() * 3) };
      const first = await Promise.all([settle(oracle.getTopPositions(q as never)), settle(engine.getTopPositions(q as never))]);
      expect(first[1], JSON.stringify(q)).toEqual(first[0]);
      const counts = await Promise.all([settle(oracle.getTopPositionsCount(q as never)), settle(engine.getTopPositionsCount(q as never))]);
      expect(counts[1], JSON.stringify(q)).toEqual(counts[0]);
      const again = await Promise.all([settle(oracle.getTopPositions(q as never)), settle(engine.getTopPositions(q as never))]);
      expect(again[1], JSON.stringify(q)).toEqual(again[0]);
    }
  }, 120_000);

  it('walks every sort × status × shape on deep pages, past the end, and inside the windows', async () => {
    const base = { protocol: PROTO, activeOnly: false, range: undefined, minValueUsd: 0, minPoolTvl: 0, includeRisky: true } as const;
    for (const sort of SORTS) {
      for (const status of ['active', 'inactive', 'all'] as const) {
        for (const chainId of [4663, undefined]) {
          for (const [page, limit] of [
            [1, 25],
            [2, 25],
            [41, 25],
            [11, 100],
            [30, 100],
            [500, 100],
            [44, 50],
          ] as const) {
            await confirm();
            const q = { ...base, sort, status, chainId, page, limit };
            const [a, b] = await Promise.all([settle(oracle.getTopPositions(q as never, { countWaitMs: 2_000 })), settle(engine.getTopPositions(q as never, { countWaitMs: 2_000 }))]);
            expect(b, JSON.stringify(q)).toEqual(a);
          }
        }
      }
    }
  }, 120_000);

  it('applies the collation exactly: collation-equal owners, pools and excluded twins', async () => {
    await confirm();
    const owner = OWNERS[0]!; // 0x00a1… == 0x0a01… under the collation, != 0x00A1…
    for (const q of [
      { owner, sort: 'pnl', status: 'all' },
      { owner: OWNERS[1]!, sort: 'age', status: 'all' },
      { owner, poolId: POOLS[1]!, sort: 'nft_id_desc', status: 'all' },
      { poolId: POOLS[0]!, sort: 'pnl', status: 'all' },
      { poolId: POOLS[1]!, sort: 'apr', status: 'active' },
    ]) {
      const full = { protocol: PROTO, page: 1, limit: 100, activeOnly: false, minValueUsd: 0, minPoolTvl: 0, includeRisky: true, chainId: 1, ...q };
      const [a, b] = await Promise.all([oracle.getTopPositions(full as never, { countWaitMs: 2_000 }), engine.getTopPositions(full as never, { countWaitMs: 2_000 })]);
      expect(b).toEqual(a);
    }
    // The owner shape matched BOTH spellings (collated), the pool shape only its own (binary).
    const both = await engine.getTopPositions({ protocol: PROTO, page: 1, limit: 100, activeOnly: false, status: 'all', minValueUsd: 0, minPoolTvl: 0, includeRisky: true, chainId: 1, owner: OWNERS[0]!, sort: 'pnl' } as never);
    const owners = new Set(both.positions.map((p) => p.owner));
    expect(owners).toEqual(new Set([OWNERS[0], OWNERS[1]].filter((o) => shards.get(1)!.some((d) => d.owner === o))));
    expect(owners.size).toBe(2);
    const pool = await engine.getTopPositions({ protocol: PROTO, page: 1, limit: 100, activeOnly: false, status: 'all', minValueUsd: 0, minPoolTvl: 0, includeRisky: true, chainId: 1, poolId: POOLS[0]!, sort: 'pnl' } as never);
    expect(new Set(pool.positions.map((p) => p.poolId))).toEqual(new Set([POOLS[0]]));
  });

  it('stays exact through generations: inserts, value 0 → 5 into A+, isActive flips, owner / pool moves, deletes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const local = shardsFor(SEED + 1, { 1: 600, 42161: 400, 4663: 900 });
    const localStore = buildRankStore(local);
    const { rank: localRank } = await rankFor(localStore, config);
    const engineSvc = leaderboardService(positionsRepo(local, config).repo, config, localRank);
    const rand = prng(99 + SEED);
    let nextId = 50_000;
    for (let round = 0; round < 5; round++) {
      for (const chainId of CHAINS) {
        const docs = local.get(chainId)!;
        for (const doc of makePositions(1_000 + round * 10 + chainId, chainId, 20, { idBase: nextId })) {
          docs.push(doc);
          upsertRow(localStore, chainId, doc);
        }
        nextId += 100;
        for (let k = 0; k < 40; k++) {
          const doc = docs[Math.floor(rand() * docs.length)]!;
          const metrics = { ...(doc.metrics as Doc) };
          metrics.underlyingValueUsd = [0, 5, 600, 12_000, NaN, null][Math.floor(rand() * 6)];
          metrics.aprExGas = [1, 50, 0, -3][Math.floor(rand() * 4)];
          doc.metrics = metrics;
          if (rand() < 0.3) doc.isActive = !doc.isActive;
          if (rand() < 0.15) doc.owner = OWNERS[Math.floor(rand() * OWNERS.length)];
          if (rand() < 0.15) doc.poolId = POOLS[Math.floor(rand() * POOLS.length)];
          upsertRow(localStore, chainId, doc);
        }
        for (let k = 0; k < 10; k++) {
          const index = Math.floor(rand() * docs.length);
          const [gone] = docs.splice(index, 1);
          localStore.table('rank', shardKey(chainId, PROTO))!.delete(oidOf(gone!));
        }
      }
      vi.setSystemTime(Date.now() + 60_000); // past every cache
      touch(localStore);
      await localRank.tick();
      const fresh = leaderboardService(positionsRepo(local, config).repo, config);
      for (let i = 0; i < 80; i++) {
        const q = randomQuery(rand, local);
        const [a, b] = await Promise.all([settle(fresh.getTopPositions(q as never, { countWaitMs: 2_000 })), settle(engineSvc.getTopPositions(q as never, { countWaitMs: 2_000 }))]);
        expect(b, `round ${round} ${JSON.stringify(q)}`).toEqual(a);
      }
    }
    expect(localRank.engine!.swaps).toBeGreaterThanOrEqual(5);
  }, 120_000);
});

describe('rank engine: each path’s exact-total rule on /api (cold count cache, no count wait)', () => {
  it('a single-chain pool page deeper than the windows (not past the end) and a deep page past the end carry Mongo’s total at once', async () => {
    const docs = makePositions(56, 1, 1_700);
    for (const d of docs) d.poolId = POOLS[2]!;
    const shards = new Map([[1, docs]]);
    const store = buildRankStore(shards);
    const config = makeRankConfig();
    const { rank } = await rankFor(store, config, 'serve', [1]);
    const base = { protocol: PROTO, chainId: 1, limit: 50, activeOnly: false, status: 'all', minValueUsd: 0, minPoolTvl: 0, includeRisky: true };
    const cases = [
      { ...base, poolId: POOLS[2], sort: 'pnl', page: 25 }, // pool shape, skip 1,200: deep, inside the result
      { ...base, poolId: POOLS[2], sort: 'nft_id_asc', page: 30 }, // pool shape, deep
      { ...base, sort: 'age', page: 60 }, // ranked (collated), deep and past the end
    ];
    for (const q of cases) {
      // a fresh service each: a cold count cache, the /api path (no countWaitMs)
      const oracle = leaderboardService(positionsRepo(shards, config).repo, config);
      const engine = leaderboardService(positionsRepo(shards, config).repo, config, rank);
      const served = (rank.status().requests as { served: number }).served;
      const [a, b] = await Promise.all([oracle.getTopPositions(q as never), engine.getTopPositions(q as never)]);
      expect((rank.status().requests as { served: number }).served, JSON.stringify(q)).toBe(served + 1);
      expect(b.pagination, JSON.stringify(q)).toEqual(a.pagination);
      expect(a.pagination, JSON.stringify(q)).not.toHaveProperty('totalPending');
      expect(b).toEqual(a);
    }
  });
});
