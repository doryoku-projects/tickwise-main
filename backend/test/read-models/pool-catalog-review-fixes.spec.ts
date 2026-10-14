import { afterEach, describe, expect, it, vi } from 'vitest';
import { CountQueueFullError } from '../../src/leaderboard/count-cache.js';
import { EngineOverloadError, InThreadEngine, type EngineRunner } from '../../src/read-models/core/engine-runner.js';
import { shardKey } from '../../src/read-models/core/fields.js';
import { MAX_GENERATION_RETRIES, PoolCatalog } from '../../src/read-models/pools/pool-catalog.js';
import { PoolCatalogService } from '../../src/read-models/pools/pool-catalog.service.js';
import { compilePoolFilter } from '../../src/read-models/pools/pool-query.js';
import { LaneABudget } from '../../src/read-models/shadow/pools-lane-a.js';
import type { Doc } from '../support/mini-mongo.js';
import {
  ADDRESSES,
  buildStore,
  catalogFor,
  CHAINS,
  fakeReadModels,
  makeConfig,
  PROTO,
  poolsRepo,
  poolsService,
  shardsFor,
  touch,
  upsertRow,
} from './pools-support.js';

/**
 * Review fixes to the pool catalog (R1–R3 review, pools lens): an engine
 * count never poisons the count key Mongo shares; lane A never compares an
 * answer bound to one exclusion list with a reference built from another; a
 * frozen stream position or a missing page row never yields a wrong page; an
 * overloaded engine never drops a shard or reallocates its buffers; a table
 * that is not ready does not accumulate changes; lane A takes nothing from the
 * user read budget.
 */

const KEY_4663 = shardKey(4663, PROTO);
const q = (over: Record<string, unknown> = {}) => ({ chainId: 4663, protocol: PROTO, sort: 'tvl', page: 1, limit: 20, minTvlUsd: 0, includeRisky: true, ...over });

afterEach(() => vi.useRealTimers());

/** Every pool of 4663, by tvl descending (no filter, no exclusions). */
function everyPool() {
  const compiled = compilePoolFilter({}, 4663, PROTO);
  if (!compiled.ok) throw new Error(compiled.reason);
  return [{ key: KEY_4663, plan: compiled.plan, excluded: [] as string[] }];
}

/** The lane-A reference read over mini-mongo (static data: no snapshot needed). */
function withReference(repo: ReturnType<typeof poolsRepo>) {
  repo.repo.snapshotReference = async (chainId, _protocol, args) => {
    const model = repo.models.get(chainId)!.model;
    const rows = (await (model.find(args.filter) as unknown as { sort(s: unknown): { skip(n: number): { limit(n: number): { lean(): Promise<Doc[]> } } } })
      .sort({ [args.sortField]: args.sortDirection, poolId: 1 })
      .skip(args.skip)
      .limit(args.limit)
      .lean()) as Doc[];
    const count = await (model.countDocuments(args.filter, { limit: args.cap }) as unknown as { exec(): Promise<number> }).exec();
    const value = (doc: Doc) => args.sortField.split('.').reduce<unknown>((cur, key) => (cur && typeof cur === 'object' ? (cur as Doc)[key] : undefined), doc);
    return { rows: rows.map((doc) => ({ poolId: doc.poolId, value: value(doc) })), count };
  };
  return repo;
}

/** An in-thread engine that refuses generation tasks (build / update) while `overloaded`. */
function refusingEngine() {
  const inner = new InThreadEngine();
  const state = { overloaded: false, refused: 0 };
  const engine: EngineRunner = {
    kind: 'in-thread',
    run: ((kind: string, input: unknown, options?: unknown) => {
      if (state.overloaded && kind !== 'pools.pass') {
        state.refused++;
        return Promise.reject(new EngineOverloadError('queue_full'));
      }
      return (inner.run as (k: string, i: unknown, o?: unknown) => Promise<unknown>)(kind, input, options);
    }) as EngineRunner['run'],
    broadcast: ((kind: string, input: unknown) => (inner.broadcast as (k: string, i: unknown) => void)(kind, input)) as EngineRunner['broadcast'],
    stats: () => inner.stats(),
    stop: () => inner.stop(),
  };
  return { engine, state };
}

describe('engine counts never poison the count key Mongo shares', () => {
  it('a quarantined leaf: /count and the list totals are Mongo’s, on the first view and every later one', async () => {
    const config = makeConfig();
    const shards = shardsFor(7, { 1: 200, 42161: 100, 4663: 100 });
    // A string where tvl belongs: MongoDB never matches it with a numeric bound; R1 quarantines the leaf.
    const one = shards.get(1)!;
    one[5]!.metrics = { ...((one[5]!.metrics as Doc | null) ?? {}), tvlUsd: '123' };
    const store = buildStore(shards);
    const { catalog } = await catalogFor(store, config);
    const oracle = poolsService(poolsRepo(shards, config).repo, config);
    const engine = poolsService(poolsRepo(shards, config).repo, config, catalog);
    const query = q({ chainId: 1, limit: 5 });
    const expected = await oracle.getTopPoolsCount(query as never);
    expect(expected).toEqual({ total: 37, capped: true });
    expect(await engine.getTopPoolsCount(query as never)).toEqual(expected);
    expect((await engine.getTopPools(query as never)).pagination).toEqual((await oracle.getTopPools(query as never)).pagination);
    expect(await engine.getTopPoolsCount(query as never)).toEqual(expected);
    expect((catalog.status().requests as { counted: number }).counted).toBe(0);
  });

  it('a shard dropped between the check and the run: `pending` once (not remembered), then Mongo counts the key', async () => {
    const config = makeConfig();
    const shards = shardsFor(8, { 1: 60, 42161: 40, 4663: 80 });
    const store = buildStore(shards);
    const { catalog } = await catalogFor(store, config);
    const repo = poolsRepo(shards, config).repo;
    const engine = poolsService(repo, config, catalog);
    const oracle = poolsService(poolsRepo(shards, config).repo, config);
    const access = (engine as unknown as { access: Parameters<PoolCatalogService['countTask']>[1] }).access;
    const plan = await repo.poolsPlan({ protocol: PROTO, sort: 'tvl', minTvlUsd: 0, includeRisky: true, chainId: 4663, page: 1, limit: 20 } as never);
    const task = catalog.countTask(plan, access, config.leaderboardCountCap)!;
    expect(task).toBeDefined();
    // The shard leaves the generation before the task runs.
    store.table('pools', KEY_4663)!.state = 'scanning';
    await catalog.tick();
    await expect(task.run()).rejects.toBeInstanceOf(CountQueueFullError);
    // The key now goes to Mongo even once the shard is back.
    store.table('pools', KEY_4663)!.state = 'ready';
    await catalog.tick();
    expect(catalog.countTask(plan, access, config.leaderboardCountCap)).toBeUndefined();
    expect(await engine.getTopPoolsCount(q() as never)).toEqual(await oracle.getTopPoolsCount(q() as never));
    // ... for a while only.
    expect(catalog.countTask(plan, access, config.leaderboardCountCap, Date.now() + 91_000)).toBeDefined();
  });
});

describe('lane A and the exclusion list', () => {
  it('a served answer bound to an older exclusion list is not compared with a reference built from the new one', async () => {
    const shards = shardsFor(14, { 1: 80, 42161: 60, 4663: 200 });
    const store = buildStore(shards);
    const config = makeConfig({ readModelsShadowSample: 1 });
    const { catalog } = await catalogFor(store, config, 'serve');
    const repo = withReference(poolsRepo(shards, config));
    let excluded = [ADDRESSES[0]];
    // The exclusion set as TokensRepository publishes it: a new array whenever its content changes.
    (repo.repo as unknown as { tokens: unknown }).tokens = { readyLeaderboardExclusions: async (c: number) => ({ addresses: c === 4663 ? excluded : [], ok: true }) };
    const engine = poolsService(repo.repo, config, catalog);
    await engine.getTopPools(q() as never);
    await vi.waitFor(() => expect(catalog.lane.checks).toBe(1), { timeout: 5_000 });
    // The set's rebuild publishes new content (a new array); the next request is an answer-cache hit.
    excluded = [ADDRESSES[0], ADDRESSES[5], ADDRESSES[6]];
    catalog.lane.buckets.clear();
    await engine.getTopPools(q() as never);
    await vi.waitFor(() => expect(catalog.lane.checks).toBe(2), { timeout: 5_000 });
    expect(catalog.lane.diffs).toBe(0);
  });
});

describe('rows and the clusterTime', () => {
  it('a frozen stream position is neither served nor lane-checked', async () => {
    const shards = shardsFor(21, { 1: 30, 42161: 30, 4663: 60 });
    const store = buildStore(shards);
    const config = makeConfig({ readModelsShadowSample: 1 });
    const { catalog } = await catalogFor(store, config);
    expect(catalog.notServable([4663], PROTO)).toBeUndefined();
    (store.pos as { frozen?: boolean }).frozen = true;
    touch(store);
    (store.pos as { frozen?: boolean }).frozen = true;
    await catalog.tick();
    expect(catalog.notServable([4663], PROTO)).toBe('position_frozen');
    const oracle = poolsService(poolsRepo(shards, config).repo, config);
    const engine = poolsService(withReference(poolsRepo(shards, config)).repo, config, catalog);
    expect(await engine.getTopPools(q() as never)).toEqual(await oracle.getTopPools(q() as never));
    expect((catalog.status().requests as { served: number }).served).toBe(0);
    await vi.waitFor(() => expect(catalog.lane.skipped.position_frozen).toBe(1), { timeout: 5_000 });
    (store.pos as { frozen?: boolean }).frozen = false;
    await catalog.tick();
    expect(catalog.notServable([4663], PROTO)).toBeUndefined();
  });

  it('an ordered pool with no document at the clusterTime sends the page to Mongo — never a short page', async () => {
    const shards = shardsFor(22, { 1: 30, 42161: 30, 4663: 60 });
    const store = buildStore(shards);
    const config = makeConfig();
    // The model holds a pool MongoDB does not have at the answer's clusterTime, at the top of the order.
    const ghost = { ...shards.get(4663)![0]!, _id: undefined as unknown, poolId: '0x' + 'f'.repeat(64), metrics: { tvlUsd: 4.99e10 } };
    ghost._id = new (await import('mongoose')).default.mongo.ObjectId();
    upsertRow(store, 4663, ghost as Doc);
    const { catalog, readModels } = await catalogFor(store, config);
    const oracle = poolsService(poolsRepo(shards, config).repo, config);
    const engine = poolsService(poolsRepo(shards, config).repo, config, catalog);
    for (const query of [q(), q({ chainId: undefined })]) {
      const served = await engine.getTopPools(query as never);
      expect(served).toEqual(await oracle.getTopPools(query as never));
      expect(served.pools).toHaveLength(20);
    }
    expect((catalog.status().requests as { fallback: Record<string, number> }).fallback.rows_missing).toBe(2);
    expect(readModels.alerts.snapshot().counts['read_models.catalog_rows_missing']).toBe(2);
  });
});

/** Every 4663 poolId in tvl order on `catalog`'s current generation. */
async function orderOf(catalog: PoolCatalog): Promise<string[]> {
  const answer = await catalog.answer(everyPool(), 0);
  return [...answer.slots].map((slot) => catalog.poolIdOf(answer, 0, slot)!);
}

async function freshCatalog(store: ReturnType<typeof buildStore>): Promise<PoolCatalog> {
  const catalog = new PoolCatalog({ engine: new InThreadEngine(), source: () => ({ store, shards: CHAINS.map((chainId) => ({ chainId, protocol: PROTO })) }), alert: () => undefined });
  await catalog.tick();
  return catalog;
}

describe('an overloaded engine', () => {
  function catalogOver(store: ReturnType<typeof buildStore>, engine: EngineRunner, alerts: string[] = []) {
    return new PoolCatalog({ engine, source: () => ({ store, shards: CHAINS.map((chainId) => ({ chainId, protocol: PROTO })) }), alert: (name) => alerts.push(name) });
  }

  it('a refused update keeps the shard at its generation, then applies the taken changes once the engine accepts', async () => {
    const shards = shardsFor(31, { 1: 30, 42161: 30, 4663: 80 });
    const store = buildStore(shards);
    const { engine, state } = refusingEngine();
    const catalog = catalogOver(store, engine);
    await catalog.tick();
    const before = catalog.current!;
    const shard = before.shards.get(KEY_4663)!;
    const { instance, gen } = shard;
    const doc = shards.get(4663)![2]!;
    upsertRow(store, 4663, { ...doc, metrics: { tvlUsd: 9e15 } });
    touch(store);
    state.overloaded = true;
    await catalog.tick();
    await catalog.tick();
    expect(state.refused).toBeGreaterThanOrEqual(2);
    // Nothing published: every shard (and the clusterTime) is where it was.
    expect(catalog.current).toBe(before);
    expect(catalog.current!.shards.get(KEY_4663)).toBe(shard);
    state.overloaded = false;
    await catalog.tick();
    const after = catalog.current!.shards.get(KEY_4663)!;
    expect(after.instance).toBe(instance);
    expect(after.gen).toBe(gen + 1);
    expect(catalog.current!.ct).toBe(store.pos.ct);
    // The requeued slot was applied: the order is a fresh build's.
    expect(await orderOf(catalog)).toEqual(await orderOf(await freshCatalog(store)));
  });

  it('a refused (re)build reuses its copy once accepted — no buffers thrown away', async () => {
    const shards = shardsFor(32, { 1: 30, 42161: 30, 4663: 80 });
    const store = buildStore(shards);
    const { engine, state } = refusingEngine();
    const catalog = catalogOver(store, engine);
    await catalog.tick();
    const first = catalog.current!.shards.get(KEY_4663)!.instance;
    store.table('pools', KEY_4663)!.reset();
    for (const d of shards.get(4663)!) upsertRow(store, 4663, d);
    store.table('pools', KEY_4663)!.state = 'ready';
    touch(store);
    state.overloaded = true;
    await catalog.tick();
    await catalog.tick();
    expect(catalog.current!.shards.get(KEY_4663)!.instance).toBe(first);
    const changed = shards.get(4663)![4]!;
    upsertRow(store, 4663, { ...changed, metrics: { tvlUsd: 9e15 } });
    state.overloaded = false;
    await catalog.tick();
    const rebuilt = catalog.current!.shards.get(KEY_4663)!;
    // Exactly ONE new instance (the copy made under overload, patched with the later change).
    expect(rebuilt.instance).toBe(first + 1);
    expect(await orderOf(catalog)).toEqual(await orderOf(await freshCatalog(store)));
    expect(await orderOf(catalog)).toContain(changed.poolId);
  });

  it(`a task failing ${MAX_GENERATION_RETRIES} times in a row drops the shard (rebuilt from a fresh copy)`, async () => {
    const shards = shardsFor(33, { 1: 30, 42161: 30, 4663: 80 });
    const store = buildStore(shards);
    const { engine, state } = refusingEngine();
    const alerts: string[] = [];
    const catalog = catalogOver(store, engine, alerts);
    await catalog.tick();
    upsertRow(store, 4663, { ...shards.get(4663)![1]!, metrics: { tvlUsd: 9 } });
    state.overloaded = true;
    for (let i = 1; i < MAX_GENERATION_RETRIES; i++) {
      await catalog.tick();
      expect(catalog.current!.shards.has(KEY_4663)).toBe(true);
    }
    await catalog.tick();
    expect(catalog.current!.shards.has(KEY_4663)).toBe(false);
    expect(catalog.current!.shards.has(shardKey(1, PROTO))).toBe(true);
    state.overloaded = false;
    await catalog.tick();
    expect(catalog.current!.shards.has(KEY_4663)).toBe(true);
  });
});

describe('a table that is not ready', () => {
  it('does not accumulate the slots it changes (a rescan re-inserts every one)', async () => {
    const shards = shardsFor(41, { 1: 30, 42161: 30, 4663: 80 });
    const store = buildStore(shards);
    const config = makeConfig();
    const { catalog } = await catalogFor(store, config);
    const table = store.table('pools', KEY_4663)!;
    table.state = 'scanning';
    for (const d of shards.get(4663)!) upsertRow(store, 4663, d);
    await catalog.tick();
    expect(table.takeChanges()).toEqual([]);
    // Ready again: rebuilt from a fresh copy, served exactly as Mongo.
    for (const d of shards.get(4663)!) upsertRow(store, 4663, d);
    table.state = 'ready';
    await catalog.tick();
    const oracle = poolsService(poolsRepo(shards, config).repo, config);
    const engine = poolsService(poolsRepo(shards, config).repo, config, catalog);
    expect(await engine.getTopPools(q() as never)).toEqual(await oracle.getTopPools(q() as never));
    expect((catalog.status().requests as { served: number }).served).toBe(1);
  });
});

describe('lane A’s read budget', () => {
  it('LaneABudget: a bucket of 2k docs/s, 20k deep, refused (nothing taken) when short', () => {
    let now = 0;
    const budget = new LaneABudget(2_000, 20_000, () => now);
    expect(budget.take(20_000)).toBe(true);
    expect(budget.take(1)).toBe(false);
    now += 1_000;
    expect(budget.take(2_001)).toBe(false);
    expect(budget.take(2_000)).toBe(true);
    now += 60_000;
    expect(budget.take(20_000)).toBe(true);
    expect(budget.take(1)).toBe(false);
  });

  it('takes nothing from the user read budget, and skips while it is under pressure', async () => {
    const shards = shardsFor(51, { 1: 30, 42161: 30, 4663: 60 });
    const store = buildStore(shards);
    const config = makeConfig({ readModelsShadowSample: 1 });
    const readModels = fakeReadModels(store, CHAINS, 'shadow');
    const userBudget = { pressure: false, reserve: vi.fn(async () => undefined), underPressure: () => userBudget.pressure };
    const catalog = new PoolCatalogService(config as never, readModels as never, userBudget as never);
    await catalog.tick();
    const engine = poolsService(withReference(poolsRepo(shards, config)).repo, config, catalog);
    await engine.getTopPools(q() as never);
    await vi.waitFor(() => expect(catalog.lane.checks).toBe(1), { timeout: 5_000 });
    expect(userBudget.reserve).not.toHaveBeenCalled();
    userBudget.pressure = true;
    catalog.lane.buckets.clear();
    await engine.getTopPools(q({ sort: 'volume' }) as never);
    await vi.waitFor(() => expect(catalog.lane.skipped.budget).toBe(1), { timeout: 5_000 });
    expect(catalog.lane.checks).toBe(1);
    // No pressure, but lane A's own bucket is empty: skipped too.
    userBudget.pressure = false;
    (catalog as unknown as { laneBudget: LaneABudget }).laneBudget = new LaneABudget(2_000, 0);
    catalog.lane.buckets.clear();
    await engine.getTopPools(q({ sort: 'fees' }) as never);
    await vi.waitFor(() => expect(catalog.lane.skipped.budget).toBe(2), { timeout: 4_000 });
    expect(catalog.lane.checks).toBe(1);
    expect(userBudget.reserve).not.toHaveBeenCalled();
  });
});

describe('a shard no longer served', () => {
  it('drops the copy kept for its refused build (no buffers held for it)', async () => {
    const shards = shardsFor(61, { 1: 30, 42161: 30, 4663: 80 });
    const store = buildStore(shards);
    const { engine, state } = refusingEngine();
    let chains = CHAINS;
    const catalog = new PoolCatalog({ engine, source: () => ({ store, shards: chains.map((chainId) => ({ chainId, protocol: PROTO })) }), alert: () => undefined });
    await catalog.tick();
    store.table('pools', KEY_4663)!.reset();
    for (const d of shards.get(4663)!) upsertRow(store, 4663, d);
    state.overloaded = true;
    await catalog.tick();
    expect(catalog.status().stashed).toEqual([KEY_4663]);
    chains = CHAINS.filter((c) => c !== 4663);
    await catalog.tick();
    expect(catalog.status().stashed).toEqual([]);
  });
});

describe('integration: lane A’s gates run before any engine pass', () => {
  it('a sample its bucket gate (or the shadow ticket) discards costs no catalog pass', async () => {
    const shards = shardsFor(61, { 1: 30, 42161: 30, 4663: 60 });
    const store = buildStore(shards);
    const config = makeConfig({ readModelsShadowSample: 1 });
    const readModels = fakeReadModels(store, CHAINS, 'shadow');
    const catalog = new PoolCatalogService(config as never, readModels as never);
    await catalog.tick();
    const engine = poolsService(withReference(poolsRepo(shards, config)).repo, config, catalog);
    const lane = catalog.lane;
    const settled = () => lane.checks + Object.values(lane.skipped).reduce((a, b) => a + b, 0);
    const offer = async (query: Record<string, unknown>) => {
      const before = settled();
      await engine.getTopPools(query as never);
      await vi.waitFor(() => expect(settled()).toBe(before + 1), { timeout: 5_000 });
    };
    await offer(q());
    expect(lane.checks).toBe(1);
    const answer = vi.spyOn(catalog.catalog!, 'answer');
    await offer(q()); // the same bucket again
    expect(lane.skipped.bucket_recent).toBe(1);
    expect(answer).not.toHaveBeenCalled();
    lane.buckets.clear();
    readModels.shadowTicket = async () => false;
    await offer(q({ sort: 'age' }));
    expect(lane.skipped.sample_cap).toBe(1);
    expect(answer).not.toHaveBeenCalled();
  });
});

describe('integration: the memory guard’s cache stages', () => {
  it('the catalog registers a shedder: 80 drops its answer cache, 85 also its compiled plans', async () => {
    const shards = shardsFor(62, { 1: 30, 42161: 30, 4663: 60 });
    const store = buildStore(shards);
    const config = makeConfig({ readModelsRole: 'both' });
    const shedders = new Map<string, (stage: 80 | 85) => void>();
    const readModels = { ...fakeReadModels(store, CHAINS), registerShedder: (name: string, fn: (stage: 80 | 85) => void) => shedders.set(name, fn) };
    const catalog = new PoolCatalogService(config as never, readModels as never);
    catalog.onApplicationBootstrap();
    await catalog.tick();
    await poolsService(poolsRepo(shards, config).repo, config, catalog).getTopPools(q() as never, { countWaitMs: 2_000 });
    const internals = catalog as unknown as { answers: { stats(): { entries: number } }; compiled: Map<string, unknown> };
    expect(internals.answers.stats().entries).toBeGreaterThan(0);
    expect(internals.compiled.size).toBeGreaterThan(0);
    shedders.get('pools')!(80);
    expect(internals.answers.stats().entries).toBe(0);
    expect(internals.compiled.size).toBeGreaterThan(0);
    shedders.get('pools')!(85);
    expect(internals.compiled.size).toBe(0);
    await catalog.onApplicationShutdown();
  });
});

describe('integration: a pools pass on a newer generation', () => {
  it('drops the shard’s older generations’ bitsets from the engine cache', async () => {
    const shards = shardsFor(63, { 1: 30, 42161: 30, 4663: 80 });
    const store = buildStore(shards);
    const inner = new InThreadEngine();
    const catalog = new PoolCatalog({ engine: inner, source: () => ({ store, shards: CHAINS.map((chainId) => ({ chainId, protocol: PROTO })) }), alert: () => undefined });
    await catalog.tick();
    await catalog.answer(everyPool(), 0);
    const shard = catalog.current!.shards.get(KEY_4663)!;
    const keysOf = () => [...(inner.state.pools as unknown as { bits: Map<string, unknown> }).bits.keys()].filter((k) => k.startsWith(`${KEY_4663}#${shard.instance}|`));
    expect(keysOf().some((k) => k.startsWith(`${KEY_4663}#${shard.instance}|1|`))).toBe(true);
    upsertRow(store, 4663, { ...shards.get(4663)![3]!, metrics: { tvlUsd: 777 } });
    touch(store);
    await catalog.tick();
    expect(catalog.current!.shards.get(KEY_4663)!.gen).toBe(2);
    await catalog.answer(everyPool(), 0);
    expect(keysOf().some((k) => k.startsWith(`${KEY_4663}#${shard.instance}|1|`))).toBe(false);
    expect(keysOf().some((k) => k.startsWith(`${KEY_4663}#${shard.instance}|2|`))).toBe(true);
  });
});
