import { afterAll, describe, expect, it, vi } from 'vitest';
import { WorkerEngine } from '../../src/read-models/core/engine-runner.js';
import { shardKey } from '../../src/read-models/core/fields.js';
import { RANK_PERMS } from '../../src/read-models/rank/rank-columns.js';
import { RankEngine } from '../../src/read-models/rank/rank-engine.js';
import { PoolsService } from '../../src/pools/pools.service.js';
import { LeaderboardCountService } from '../../src/leaderboard/count-cache.js';
import { matches, mongoSort, prng, type Doc } from '../support/mini-mongo.js';
import { RankEngineService } from '../../src/read-models/rank/rank-engine.service.js';
import { LaneABudget } from '../../src/read-models/shadow/pools-lane-a.js';
import {
  buildRankStore,
  CHAINS,
  fakeRankReadModels,
  leaderboardService,
  makePositions,
  makeRankConfig,
  oidOf,
  OWNERS,
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
 * The rank engine as the services see it (design §8, §6.6, §7.1):
 *  - `off` and `shadow` leave every response byte-identical to a service with
 *    no engine at all (`off` builds nothing; `shadow` answers nothing);
 *  - real worker threads answer exactly like the in-thread engine;
 *  - a quarantined field sends exactly the queries that read it to Mongo, and
 *    a chain whose rows cannot be read is dropped like the Mongo path drops it;
 *  - holder counts come from the engine in serve (Mongo only for ambiguous
 *    pools), from Mongo in shadow / off;
 *  - lane A finds no difference on correct data and finds a planted one.
 */

const SIZES = { 1: 500, 42161: 300, 4663: 800 };

function randomQuery(rand: () => number) {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  const limit = pick([7, 20, 50]);
  const q: Record<string, unknown> = {
    chainId: pick([1, 42161, 4663, undefined]),
    protocol: PROTO,
    sort: pick(SORTS),
    page: rand() < 0.2 ? Math.ceil(1_001 / limit) + 2 : 1 + Math.floor(rand() * 3),
    limit,
    activeOnly: rand() < 0.5,
    status: pick(['active', 'inactive', 'all', undefined]),
    range: pick(['in', 'out', undefined]),
    minValueUsd: pick([0, 500, 1_000]),
    minPoolTvl: pick([0, 1_000]),
    includeRisky: rand() < 0.5,
  };
  if (rand() < 0.15) q.owner = pick(OWNERS).toLowerCase();
  else if (rand() < 0.15) q.poolId = pick(POOLS);
  return q;
}

async function settle<T>(p: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await p };
  } catch (err) {
    return { ok: false, error: `${(err as Error)?.name}:${(err as Error)?.message}` };
  }
}

describe('rank engine: off and shadow change nothing', () => {
  it('off builds nothing and answers through today’s path, byte for byte', async () => {
    const shards = shardsFor(41, SIZES);
    const store = buildRankStore(shards);
    const config = makeRankConfig();
    const { rank } = await rankFor(store, config, 'off');
    expect(rank.engine).toBeUndefined();
    const plain = leaderboardService(positionsRepo(shards, config).repo, config);
    const withOff = leaderboardService(positionsRepo(shards, config).repo, config, rank);
    const rand = prng(3);
    for (let i = 0; i < 60; i++) {
      const q = randomQuery(rand);
      const [a, b] = await Promise.all([settle(plain.getTopPositions(q as never)), settle(withOff.getTopPositions(q as never))]);
      expect(b, JSON.stringify(q)).toEqual(a);
    }
    expect(rank.engine).toBeUndefined();
  });

  it('shadow maintains the engine and samples lane A, but every response is Mongo’s', async () => {
    const shards = shardsFor(42, SIZES);
    const store = buildRankStore(shards);
    const config = makeRankConfig({ readModelsShadowSample: 1 });
    const { rank } = await rankFor(store, config, 'shadow');
    expect(rank.engine?.current).toBeDefined();
    const plain = leaderboardService(positionsRepo(shards, config).repo, config);
    const withShadow = leaderboardService(positionsRepo(shards, config).repo, config, rank);
    const rand = prng(4);
    for (let i = 0; i < 60; i++) {
      const q = randomQuery(rand);
      const [a, b] = await Promise.all([settle(plain.getTopPositions(q as never, { countWaitMs: 2_000 })), settle(withShadow.getTopPositions(q as never, { countWaitMs: 2_000 }))]);
      expect(b, JSON.stringify(q)).toEqual(a);
      const [c, d] = await Promise.all([settle(plain.getTopPositionsCount(q as never)), settle(withShadow.getTopPositionsCount(q as never))]);
      expect(d, JSON.stringify(q)).toEqual(c);
    }
    // Neither a list nor a COUNT was answered by the engine in shadow.
    expect((rank.status().requests as { served: number; counted: number })).toMatchObject({ served: 0, counted: 0 });
  });

  it('shadow /count on a model that is not ready (or below the ramp) is exactly the Mongo-only answer', async () => {
    const shards = shardsFor(44, SIZES);
    const store = buildRankStore(shards);
    for (const [label, over, prep] of [
      ['not ready', {}, () => (store.table('rank', shardKey(4663, PROTO))!.state = 'scanning')],
      ['percent 0', { readModelsServePercent: 0 }, () => undefined],
    ] as Array<[string, Record<string, unknown>, () => unknown]>) {
      const config = makeRankConfig(over);
      const { rank } = await rankFor(store, config, 'shadow');
      prep();
      const plain = leaderboardService(positionsRepo(shards, config).repo, config);
      const withShadow = leaderboardService(positionsRepo(shards, config).repo, config, rank);
      for (const q of [{ chainId: 4663, protocol: PROTO }, { protocol: PROTO }, { chainId: 1, protocol: PROTO, sort: 'pnl' }]) {
        expect(await settle(withShadow.getTopPositionsCount(q as never)), `${label} ${JSON.stringify(q)}`).toEqual(await settle(plain.getTopPositionsCount(q as never)));
      }
      expect((rank.status().requests as { counted: number }).counted).toBe(0);
      store.table('rank', shardKey(4663, PROTO))!.state = 'ready';
    }
  });
});

describe('rank engine: worker threads', () => {
  const workers = new WorkerEngine({ workers: 2, maxQueued: 64 });
  afterAll(() => workers.stop());

  it('builds and answers through real worker threads exactly like the Mongo path', async () => {
    const shards = shardsFor(43, SIZES);
    const store = buildRankStore(shards);
    const config = makeRankConfig();
    const { rank } = await rankFor(store, config);
    // Swap the in-thread engine for real worker threads (same shared memory).
    const threaded = new RankEngine({ engine: workers, source: () => ({ store, shards: CHAINS.map((chainId) => ({ chainId, protocol: PROTO })) }), alert: () => undefined });
    await threaded.tick();
    const inThread = rank.engine!;
    for (const chainId of CHAINS) {
      const a = inThread.current!.shards.get(shardKey(chainId, PROTO))!;
      const b = threaded.current!.shards.get(shardKey(chainId, PROTO))!;
      for (let p = 0; p < RANK_PERMS.length; p++) expect([...b.perms[b.permCur][p]!.subarray(0, b.permLen[p])]).toEqual([...a.perms[a.permCur][p]!.subarray(0, a.permLen[p])]);
    }
    rank.engine = threaded;
    const oracle = leaderboardService(positionsRepo(shards, config).repo, config);
    const engine = leaderboardService(positionsRepo(shards, config).repo, config, rank);
    const rand = prng(5);
    for (let i = 0; i < 80; i++) {
      const q = randomQuery(rand);
      const [a, b] = await Promise.all([settle(oracle.getTopPositions(q as never, { countWaitMs: 2_000 })), settle(engine.getTopPositions(q as never, { countWaitMs: 2_000 }))]);
      expect(b, JSON.stringify(q)).toEqual(a);
    }
    expect((rank.status().requests as { served: number }).served).toBe(80);
    // Generations through the workers too: inserts, owner / pool moves (CSR rebuilds), isActive flips, deletes.
    vi.useFakeTimers({ toFake: ['Date'] });
    const mutate = prng(6);
    let nextId = 700_000;
    for (let round = 0; round < 3; round++) {
      for (const chainId of CHAINS) {
        const docs = shards.get(chainId)!;
        for (const doc of makePositions(300 + round * 7 + chainId, chainId, 15, { idBase: nextId })) {
          docs.push(doc);
          upsertRow(store, chainId, doc);
        }
        nextId += 100;
        for (let k = 0; k < 25; k++) {
          const doc = docs[Math.floor(mutate() * docs.length)]!;
          if (mutate() < 0.4) doc.owner = OWNERS[Math.floor(mutate() * OWNERS.length)];
          if (mutate() < 0.4) doc.poolId = POOLS[Math.floor(mutate() * POOLS.length)];
          if (mutate() < 0.4) doc.isActive = !doc.isActive;
          upsertRow(store, chainId, doc);
        }
        const [gone] = docs.splice(Math.floor(mutate() * docs.length), 1);
        store.table('rank', shardKey(chainId, PROTO))!.delete(oidOf(gone!));
      }
      // Past every cache (answers are fresh 15 s / stale 30 s across generations, by design).
      vi.setSystemTime(Date.now() + 60_000);
      touch(store);
      await threaded.tick();
      const fresh = leaderboardService(positionsRepo(shards, config).repo, config);
      const after = leaderboardService(positionsRepo(shards, config).repo, config, rank);
      for (let i = 0; i < 40; i++) {
        const q = randomQuery(rand);
        const [a, b] = await Promise.all([settle(fresh.getTopPositions(q as never, { countWaitMs: 2_000 })), settle(after.getTopPositions(q as never, { countWaitMs: 2_000 }))]);
        expect(b, `round ${round} ${JSON.stringify(q)}`).toEqual(a);
      }
    }
    vi.useRealTimers();
    expect(threaded.csrRebuilds).toBeGreaterThan(0);
    expect(workers.stats()).toMatchObject({ kind: 'workers', failed: 0 });
  }, 60_000);
});

describe('rank engine: fallbacks', () => {
  it('a quarantined isActive sends exactly the queries reading it to Mongo (same response), the rest are served', async () => {
    const shards = shardsFor(44, SIZES);
    shards.get(1)![7]!.isActive = 'true';
    const store = buildRankStore(shards);
    const config = makeRankConfig();
    const { rank } = await rankFor(store, config);
    const oracle = leaderboardService(positionsRepo(shards, config).repo, config);
    const engine = leaderboardService(positionsRepo(shards, config).repo, config, rank);
    const base = { protocol: PROTO, page: 1, limit: 20, activeOnly: false, minValueUsd: 0, minPoolTvl: 0, includeRisky: true, chainId: 1, sort: 'pnl' };
    const servedBefore = (rank.status().requests as { served: number }).served;
    const readsIsActive = { ...base, status: 'active' };
    expect(await engine.getTopPositions(readsIsActive as never)).toEqual(await oracle.getTopPositions(readsIsActive as never));
    expect((rank.status().requests as { served: number }).served).toBe(servedBefore);
    expect(Object.keys((rank.status().requests as { fallback: Record<string, number> }).fallback).some((k) => k.startsWith('quarantine:'))).toBe(true);
    const noIsActive = { ...base, status: 'all' };
    expect(await engine.getTopPositions(noIsActive as never)).toEqual(await oracle.getTopPositions(noIsActive as never));
    expect((rank.status().requests as { served: number }).served).toBe(servedBefore + 1);
  });

  it('a quarantined leaf sends the COUNT to Mongo too: /count answers the total, and a /v1 list right after carries it', async () => {
    const shards = shardsFor(44, SIZES);
    shards.get(1)![7]!.isActive = 'true';
    const store = buildRankStore(shards);
    const config = makeRankConfig();
    const { rank } = await rankFor(store, config);
    const oracle = leaderboardService(positionsRepo(shards, config).repo, config);
    const engine = leaderboardService(positionsRepo(shards, config).repo, config, rank);
    const q = { protocol: PROTO, page: 1, limit: 7, activeOnly: false, minValueUsd: 0, minPoolTvl: 0, includeRisky: true, chainId: 1, sort: 'pnl', status: 'active' };
    const expected = await oracle.getTopPositionsCount(q as never);
    expect(expected).not.toMatchObject({ pending: true });
    expect(await engine.getTopPositionsCount(q as never)).toEqual(expected);
    // asked again: still the total, never a remembered failure
    expect(await engine.getTopPositionsCount(q as never)).toEqual(expected);
    expect(await engine.getTopPositions(q as never, { countWaitMs: 2_000 })).toEqual(await oracle.getTopPositions(q as never, { countWaitMs: 2_000 }));
    // refused up front (Mongo tasks built), not discovered by a running engine task
    const fallback = (rank.status().requests as { fallback: Record<string, number> }).fallback;
    expect(Object.keys(fallback).some((k) => k.startsWith('quarantine:'))).toBe(true);
    expect(Object.keys(fallback).filter((k) => k.startsWith('count:'))).toEqual([]);
  });

  it('a refusal that appears only when the count task RUNS is counted by Mongo, not stored as the key’s failure', async () => {
    const shards = shardsFor(44, SIZES);
    const store = buildRankStore(shards);
    const config = makeRankConfig();
    const { rank } = await rankFor(store, config);
    const oracle = leaderboardService(positionsRepo(shards, config).repo, config);
    const engine = leaderboardService(positionsRepo(shards, config).repo, config, rank);
    const q = { protocol: PROTO, page: 1, limit: 7, activeOnly: false, minValueUsd: 0, minPoolTvl: 0, includeRisky: true, chainId: 1, sort: 'pnl', status: 'active' };
    const expected = await oracle.getTopPositionsCount(q as never);
    // the generation swaps between building the task and running it: the engine now refuses
    const answer = rank.engine!.answer.bind(rank.engine!);
    const spy = vi.spyOn(rank.engine!, 'answer').mockImplementationOnce(async () => {
      throw new (await import('../../src/read-models/rank/rank-engine.js')).RankUnsupported('quarantine:3');
    });
    expect(await engine.getTopPositionsCount(q as never)).toEqual(expected);
    spy.mockImplementation(answer);
    expect((rank.status().requests as { fallback: Record<string, number> }).fallback['count:quarantine:3']).toBe(1);
    expect(await engine.getTopPositions(q as never, { countWaitMs: 2_000 })).toEqual(await oracle.getTopPositions(q as never, { countWaitMs: 2_000 }));
  });

  it('drops an all-chains chain whose rows cannot be read (partial + missingChains), like the Mongo path; one chain → Mongo', async () => {
    const shards = shardsFor(45, SIZES);
    const store = buildRankStore(shards);
    const config = makeRankConfig();
    const { rank } = await rankFor(store, config);
    const down = () => Object.assign(new Error('shard down'), { name: 'MongoNetworkError' });
    const hooks = new Map([[42161, { fail: () => down() }]]);
    const oracle = leaderboardService(positionsRepo(shards, config, hooks).repo, config);
    const engine = leaderboardService(positionsRepo(shards, config, hooks).repo, config, rank);
    for (const q of [
      { protocol: PROTO, page: 1, limit: 25, activeOnly: false, status: 'all', minValueUsd: 0, minPoolTvl: 0, includeRisky: true, sort: 'pnl' },
      { protocol: PROTO, page: 45, limit: 25, activeOnly: false, status: 'all', minValueUsd: 0, minPoolTvl: 0, includeRisky: true, sort: 'age' },
    ]) {
      const [a, b] = await Promise.all([oracle.getTopPositions(q as never), engine.getTopPositions(q as never)]);
      expect(b).toEqual(a);
      expect(b).toMatchObject({ partial: true, missingChains: [42161] });
    }
    const single = { protocol: PROTO, chainId: 42161, page: 1, limit: 25, activeOnly: false, status: 'all', minValueUsd: 0, minPoolTvl: 0, includeRisky: true, sort: 'pnl' };
    const [a, b] = await Promise.all([settle(oracle.getTopPositions(single as never)), settle(engine.getTopPositions(single as never))]);
    expect(b).toEqual(a);
    expect((rank.status().requests as { fallback: Record<string, number> }).fallback['rows:MongoNetworkError']).toBeGreaterThan(0);
  });
});

describe('rank engine: holder counts in the pools routes', () => {
  function poolsServiceWith(docs: Doc[], rank: Awaited<ReturnType<typeof rankFor>>['rank'] | undefined, calls: string[][]) {
    const config = makeRankConfig();
    const positions = {
      countsByPoolIds: async (_c: number, _p: string, ids: string[]) => {
        calls.push(ids);
        const out = new Map<string, { positionsCount: number; holdersCount: number }>();
        for (const id of ids.map((x) => x.toLowerCase())) {
          const rows = docs.filter((d) => d.poolId === id && d.isActive === true);
          if (rows.length === 0) continue;
          out.set(id, { positionsCount: rows.length, holdersCount: new Set(rows.map((r) => r.owner ?? null)).size });
        }
        return out;
      },
      castFilter: () => ({}),
      findListRowsByIds: async () => [],
      snapshotReference: async () => ({ rows: [], count: 0 }),
      snapshotPoolCounts: async () => new Map(),
    };
    const pools = {
      findPoolById: async (chainId: number, protocol: string, poolId: string) => ({
        chainId,
        protocol,
        poolId,
        token0: { address: '0xa', symbol: 'A', decimals: 18 },
        token1: { address: '0xb', symbol: 'B', decimals: 18 },
        fee: 3000,
        metrics: {},
        pricing: {},
      }),
    };
    const tokens = { findLatestPricesForRead: async () => new Map() };
    return new PoolsService(config as never, pools as never, positions as never, tokens as never, new LeaderboardCountService(config as never), undefined, rank);
  }

  it('serve: counted by the engine (exactly the $group), Mongo only for an ambiguous pool; shadow / off: Mongo', async () => {
    const docs = makePositions(46, 1, 900);
    const ambiguousPool = POOLS[5]!;
    const victim = docs.find((d) => d.poolId === ambiguousPool && d.isActive === true)!;
    victim.owner = null;
    const store = buildRankStore(new Map([[1, docs]]));
    const config = makeRankConfig();
    const { rank, readModels } = await rankFor(store, config, 'serve', [1]);
    const calls: string[][] = [];
    const svc = poolsServiceWith(docs, rank, calls);
    for (const poolId of [POOLS[0]!, POOLS[1]!, POOLS[3]!.toUpperCase(), ambiguousPool]) {
      const detail = await svc.getPool(1, PROTO, poolId);
      const rows = docs.filter((d) => d.poolId === poolId.toLowerCase() && d.isActive === true);
      expect(detail.positionsCount, poolId).toBe(rows.length);
      expect(detail.holdersCount, poolId).toBe(new Set(rows.map((r) => r.owner ?? null)).size);
    }
    expect(calls).toEqual([[ambiguousPool]]);
    // shadow: every count from Mongo
    readModels.mode = 'shadow';
    const shadowCalls: string[][] = [];
    const shadowSvc = poolsServiceWith(docs, rank, shadowCalls);
    await shadowSvc.getPool(1, PROTO, POOLS[0]!);
    expect(shadowCalls).toEqual([[POOLS[0]!]]);
  });
});

describe('rank engine: holder-count changes evict pool details only in serve', () => {
  it('serve hands the changed pools to the listener; shadow never does', async () => {
    for (const mode of ['serve', 'shadow'] as const) {
      const docs = makePositions(55, 1, 300);
      const store = buildRankStore(new Map([[1, docs]]));
      const { rank } = await rankFor(store, makeRankConfig(), mode, [1]);
      const evicted: string[][] = [];
      rank.onChangedHolders((keys) => evicted.push(keys));
      const victim = docs.find((d) => d.isActive === true)!;
      upsertRow(store, 1, { ...victim, isActive: false });
      touch(store);
      await rank.tick();
      if (mode === 'serve') expect(evicted.flat()).toContain(`1:${PROTO}:${String(victim.poolId).toLowerCase()}`);
      else expect(evicted).toEqual([]);
    }
  });
});

describe('rank engine: lane A', () => {
  /** An independent reference: mini-mongo's matching and sorting at "the snapshot". */
  function miniReference(shards: Map<number, Doc[]>) {
    return async (
      chainId: number,
      _protocol: string,
      args: { filter: Record<string, unknown>; collated: boolean; sortField: string; sortDirection: 1 | -1; tieDirection: 1 | -1; skip: number; limit: number; cap: number },
    ) => {
      const docs = shards.get(chainId)!.filter((d) => matches(d, args.filter, args.collated));
      const sorted = mongoSort(docs, { [args.sortField]: args.sortDirection, positionId: args.tieDirection }, true);
      const at = (d: Doc, path: string) => path.split('.').reduce<unknown>((cur, k) => (cur && typeof cur === 'object' ? (cur as Doc)[k] : undefined), d);
      return {
        rows: sorted.slice(args.skip, args.skip + args.limit).map((d) => ({ positionId: d.positionId, value: at(d, args.sortField) })),
        count: args.collated ? Math.min(docs.length, args.cap) : docs.length,
      };
    };
  }

  it('records checks without a difference on correct data, and catches a planted one', async () => {
    const shards = shardsFor(47, { 1: 200, 42161: 150, 4663: 300 });
    const store = buildRankStore(shards);
    const config = makeRankConfig({ readModelsShadowSample: 1, leaderboardCountCap: 25_000 });
    const { rank } = await rankFor(store, config, 'shadow');
    const repo = positionsRepo(shards, config).repo;
    const access = {
      cast: (_c: number, _p: string, filter: Record<string, unknown>) => filter,
      rows: async () => [],
      reference: miniReference(shards),
    };
    const lane = rank.lane;
    const run = async (q: Record<string, unknown>) => {
      const chainIds = q.chainId === undefined ? CHAINS : [q.chainId as number];
      rank.offer({ plans: () => Promise.all(chainIds.map((chainId) => repo.leaderboardPlan({ ...(q as never), chainId }))), page: q.page as number, limit: q.limit as number, kind: 'list' }, access as never);
      await vi.waitFor(() => expect(lane.checks + Object.values(lane.skipped).reduce((a, b) => a + b, 0)).toBeGreaterThan(0));
    };
    const base = { protocol: PROTO, limit: 20, activeOnly: false, minValueUsd: 0, minPoolTvl: 0, includeRisky: true };
    for (const q of [
      { ...base, chainId: 1, sort: 'pnl', status: 'all', page: 1 },
      { ...base, sort: 'age', status: 'active', page: 2 },
      { ...base, chainId: 4663, sort: 'apr', status: 'active', page: 1 },
      { ...base, chainId: 1, sort: 'nft_id_desc', status: 'all', page: 1, poolId: POOLS[2] },
    ]) {
      const before = lane.checks;
      await run(q);
      await vi.waitFor(() => expect(lane.checks).toBe(before + 1));
    }
    expect(lane.diffs).toBe(0);
    // Plant a wrong value in the engine's columns: lane A must see it.
    const shard = rank.engine!.current!.shards.get(shardKey(1, PROTO))!;
    const pnl = RANK_PERMS.findIndex((p) => p.name === 'pnl');
    const top = shard.perms[shard.permCur][pnl]![0]!;
    shard.cols.arrays.pv[0]![top] = 4_000_000_000;
    lane.buckets.clear();
    const before = lane.checks;
    await run({ ...base, chainId: 1, sort: 'pnl', status: 'all', page: 1 });
    await vi.waitFor(() => expect(lane.checks).toBe(before + 1));
    expect(lane.diffs).toBe(1);
    expect(lane.lastDiffs[0]).toMatchObject({ model: 'rank', shape: 'ranked' });
  });

  it('a sample its bucket gate (or the shadow ticket) discards costs no engine pass', async () => {
    const shards = shardsFor(49, { 1: 200, 42161: 150, 4663: 300 });
    const store = buildRankStore(shards);
    const config = makeRankConfig({ readModelsShadowSample: 1, leaderboardCountCap: 25_000 });
    const { rank, readModels } = await rankFor(store, config, 'shadow');
    const repo = positionsRepo(shards, config).repo;
    const access = { cast: (_c: number, _p: string, filter: Record<string, unknown>) => filter, rows: async () => [], reference: miniReference(shards) };
    const lane = rank.lane;
    const settled = () => lane.checks + Object.values(lane.skipped).reduce((a, b) => a + b, 0);
    const offer = async (q: Record<string, unknown>, kind: 'list' | 'count' = 'list') => {
      const before = settled();
      rank.offer({ plans: () => repo.leaderboardPlan({ ...(q as never), chainId: 1 }).then((plan) => [plan]), page: q.page as number, limit: q.limit as number, kind }, access as never);
      await vi.waitFor(() => expect(settled()).toBe(before + 1));
    };
    const q = { protocol: PROTO, limit: 20, activeOnly: false, minValueUsd: 0, minPoolTvl: 0, includeRisky: true, sort: 'pnl', status: 'all', page: 3 };
    await offer(q);
    await offer(q, 'count');
    expect(lane.checks).toBe(2);
    const answer = vi.spyOn(rank.engine!, 'answer');
    // the same buckets again: skipped before any pass
    await offer(q);
    await offer({ ...q, minValueUsd: 500 }, 'count');
    expect(lane.skipped.bucket_recent).toBe(2);
    expect(answer).not.toHaveBeenCalled();
    // a deep page whose total is not known (nothing cached): both buckets it could fall in are recent → no count pass either
    for (const bucket of [...lane.buckets.keys()]) lane.buckets.set(bucket.replace(/\|shallow$/, '|pastEnd'), { checks: 1, diffs: 0, lastAt: Date.now() });
    (rank as unknown as { answers: { clear(): void } }).answers.clear();
    await offer(q);
    expect(lane.skipped.bucket_recent).toBe(3);
    expect(answer).not.toHaveBeenCalled();
    // out of shadow tickets: skipped before the engine side's pass too
    lane.buckets.clear();
    readModels.shadowTicket = async () => false;
    await offer({ ...q, page: 1 });
    expect(lane.skipped.sample_cap).toBe(1);
    expect(answer).not.toHaveBeenCalled();
  });

  it('takes NOTHING from the user read budget: its own bucket, and it skips while users are under pressure', async () => {
    const shards = shardsFor(50, { 1: 200, 42161: 150, 4663: 300 });
    const store = buildRankStore(shards);
    const config = makeRankConfig({ readModelsShadowSample: 1, leaderboardCountCap: 25_000 });
    const readModels = fakeRankReadModels(store, CHAINS, 'shadow');
    const userBudget = { pressure: false, reserve: vi.fn(async () => undefined), underPressure: () => userBudget.pressure };
    const rank = new RankEngineService(config as never, readModels as never, userBudget as never);
    await rank.tick();
    const repo = positionsRepo(shards, config).repo;
    const access = { cast: (_c: number, _p: string, filter: Record<string, unknown>) => filter, rows: async () => [], reference: miniReference(shards) };
    const lane = rank.lane;
    const settled = () => lane.checks + Object.values(lane.skipped).reduce((x, y) => x + y, 0);
    const offer = async (q: Record<string, unknown>) => {
      const before = settled();
      rank.offer({ plans: () => repo.leaderboardPlan({ ...(q as never), chainId: 1 }).then((plan) => [plan]), page: 1, limit: 20, kind: 'list' }, access as never);
      await vi.waitFor(() => expect(settled()).toBe(before + 1));
    };
    const q = { protocol: PROTO, limit: 20, activeOnly: false, minValueUsd: 0, minPoolTvl: 0, includeRisky: true, status: 'all', page: 1 };
    await offer({ ...q, sort: 'pnl' });
    expect(lane.checks).toBe(1);
    expect(userBudget.reserve).not.toHaveBeenCalled();
    userBudget.pressure = true;
    lane.buckets.clear();
    await offer({ ...q, sort: 'age' });
    expect(lane.skipped.budget).toBe(1);
    userBudget.pressure = false;
    (rank as unknown as { laneBudget: LaneABudget }).laneBudget = new LaneABudget(2_000, 0);
    lane.buckets.clear();
    await offer({ ...q, sort: 'underlying_value' });
    expect(lane.skipped.budget).toBe(2);
    expect(lane.checks).toBe(1);
    expect(userBudget.reserve).not.toHaveBeenCalled();
  });
});

describe('rank engine: a frozen stream position (a repair blocked)', () => {
  it('is neither served nor lane-checked (position_frozen), and serves again once it thaws', async () => {
    const shards = shardsFor(51, SIZES);
    const store = buildRankStore(shards);
    const config = makeRankConfig();
    const { rank } = await rankFor(store, config);
    expect(rank.notServable([1], PROTO)).toBeUndefined();
    touch(store);
    (store.pos as { frozen?: boolean }).frozen = true;
    await rank.tick();
    expect(rank.notServable([1], PROTO)).toBe('position_frozen');
    const oracle = leaderboardService(positionsRepo(shards, config).repo, config);
    const engine = leaderboardService(positionsRepo(shards, config).repo, config, rank);
    const q = { protocol: PROTO, chainId: 1, page: 1, limit: 20, activeOnly: false, status: 'all', minValueUsd: 0, minPoolTvl: 0, includeRisky: true, sort: 'pnl' };
    expect(await engine.getTopPositions(q as never, { countWaitMs: 2_000 })).toEqual(await oracle.getTopPositions(q as never, { countWaitMs: 2_000 }));
    expect((rank.status().requests as { served: number }).served).toBe(0);
    touch(store);
    (store.pos as { frozen?: boolean }).frozen = false;
    await rank.tick();
    expect(rank.notServable([1], PROTO)).toBeUndefined();
  });
});

describe('the memory guard’s cache stages (80 / 85 %)', () => {
  it('each engine registers a shedder: 80 drops its answer cache, 85 also its compiled plans', async () => {
    const shards = shardsFor(52, SIZES);
    const store = buildRankStore(shards);
    const config = makeRankConfig({ readModelsRole: 'both' });
    const readModels = { ...fakeRankReadModels(store, CHAINS), shedders: new Map<string, (stage: 80 | 85) => void>() };
    (readModels as unknown as { registerShedder(name: string, fn: (stage: 80 | 85) => void): void }).registerShedder = (name, fn) => readModels.shedders.set(name, fn);
    const rank = new RankEngineService(config as never, readModels as never);
    rank.onApplicationBootstrap();
    await rank.tick();
    const engine = leaderboardService(positionsRepo(shards, config).repo, config, rank);
    const q = { protocol: PROTO, chainId: 1, page: 1, limit: 20, activeOnly: false, status: 'all', minValueUsd: 0, minPoolTvl: 0, includeRisky: true, sort: 'pnl' };
    await engine.getTopPositions(q as never, { countWaitMs: 2_000 });
    const internals = rank as unknown as { answers: { stats(): { entries: number } }; compiled: Map<string, unknown> };
    expect(internals.answers.stats().entries).toBeGreaterThan(0);
    expect(internals.compiled.size).toBeGreaterThan(0);
    readModels.shedders.get('rank')!(80);
    expect(internals.answers.stats().entries).toBe(0);
    expect(internals.compiled.size).toBeGreaterThan(0);
    readModels.shedders.get('rank')!(85);
    expect(internals.compiled.size).toBe(0);
    await rank.onApplicationShutdown();
  });
});

describe('rank engine: data age (design §6.7)', () => {
  it('flags an answer whose data is past the staleness budget, and goes back to Mongo past READ_MODELS_MAX_LAG_MS', async () => {
    const shards = shardsFor(48, SIZES);
    const store = buildRankStore(shards);
    const config = makeRankConfig();
    const { rank } = await rankFor(store, config);
    const oracle = leaderboardService(positionsRepo(shards, config).repo, config);
    const engine = leaderboardService(positionsRepo(shards, config).repo, config, rank);
    const q = { protocol: PROTO, chainId: 1, page: 1, limit: 20, activeOnly: false, status: 'all', minValueUsd: 0, minPoolTvl: 0, includeRisky: true, sort: 'pnl' };
    const want = await oracle.getTopPositions(q as never);
    // The feeder last confirmed 60 s ago: answered, flagged (and not cacheable downstream).
    const ca = Date.now() - 60_000;
    store.pos = { ...store.pos, ca };
    await rank.tick();
    const meta: { noStore?: boolean } = {};
    expect(await engine.getTopPositions(q as never, { meta })).toEqual({ ...want, stale: true, dataAsOf: new Date(ca).toISOString() });
    expect(meta.noStore).toBe(true);
    // 130 s: past the max lag — today's path answers, unflagged.
    store.pos = { ...store.pos, ca: Date.now() - 130_000 };
    await rank.tick();
    const served = (rank.status().requests as { served: number }).served;
    expect(await engine.getTopPositions({ ...q, sort: 'age' } as never)).toEqual(await oracle.getTopPositions({ ...q, sort: 'age' } as never));
    expect((rank.status().requests as { served: number }).served).toBe(served);
    expect((rank.status().requests as { fallback: Record<string, number> }).fallback.engine_lag).toBeGreaterThan(0);
  });

  it('flags a pool detail whose engine holder counts are past the budget', async () => {
    const docs = makePositions(49, 1, 300);
    const store = buildRankStore(new Map([[1, docs]]));
    const config = makeRankConfig();
    const { rank } = await rankFor(store, config, 'serve', [1]);
    const ca = Date.now() - 60_000;
    store.pos = { ...store.pos, ca };
    await rank.tick();
    const positions = { countsByPoolIds: vi.fn(async () => new Map()), castFilter: () => ({}), findListRowsByIds: async () => [], snapshotReference: async () => ({ rows: [], count: 0 }), snapshotPoolCounts: async () => new Map() };
    const pools = { findPoolById: async (chainId: number, protocol: string, poolId: string) => ({ chainId, protocol, poolId, token0: { address: '0xa' }, token1: { address: '0xb' }, fee: 3000, metrics: {}, pricing: {} }) };
    const svc = new PoolsService(config as never, pools as never, positions as never, { findLatestPricesForRead: async () => new Map() } as never, new LeaderboardCountService(config as never), undefined, rank);
    const detail = await svc.getPool(1, PROTO, POOLS[0]!);
    expect(detail).toMatchObject({ stale: true, dataAsOf: new Date(ca).toISOString() });
    expect(positions.countsByPoolIds).not.toHaveBeenCalled();
  });
});
