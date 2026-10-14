import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryTimeoutException } from '../../src/database/user-read.js';
import { EngineOverloadError, InThreadEngine } from '../../src/read-models/core/engine-runner.js';
import { shardKey } from '../../src/read-models/core/fields.js';
import { PoolCatalog } from '../../src/read-models/pools/pool-catalog.js';
import { PoolCatalogService } from '../../src/read-models/pools/pool-catalog.service.js';
import { compilePoolFilter } from '../../src/read-models/pools/pool-query.js';
import type { Doc } from '../support/mini-mongo.js';
import {
  buildStore,
  catalogFor,
  CHAINS,
  EXCLUDED,
  fakeReadModels,
  makeConfig,
  makePools,
  oidOf,
  PROTO,
  poolsRepo,
  poolsService,
  shardsFor,
  touch,
  upsertRow,
} from './pools-support.js';

/**
 * The pool catalog's mechanics (design §4.7, §4.8, §5.4, §6.7, §7.2): the
 * generation swap waits for passes in flight, quarantine and unready shards
 * send requests to Mongo, rebuilds invalidate cached answers, a failing
 * chain is dropped (`partial`, like the Mongo path), overload is a 503, data
 * past the staleness budget is flagged, and `off` / `shadow` never change a
 * response.
 */

const KEY_4663 = shardKey(4663, PROTO);
const q = (over: Record<string, unknown> = {}) => ({ chainId: 4663, protocol: PROTO, sort: 'tvl', page: 1, limit: 20, minTvlUsd: 0, includeRisky: true, ...over });

afterEach(() => vi.useRealTimers());

describe('generations', () => {
  it('a tick with no change only moves the stream position; a change bumps the shard generation', async () => {
    const shards = shardsFor(1, { 1: 50, 42161: 40, 4663: 80 });
    const store = buildStore(shards);
    const { catalog } = await catalogFor(store, makeConfig());
    const c = catalog.catalog!;
    const seq = c.current!.seq;
    const gen = (key: string) => c.current!.shards.get(key)!.gen;
    const gen4663 = gen(KEY_4663);
    const gen1 = gen(shardKey(1, PROTO));
    touch(store);
    await catalog.tick();
    expect(c.current!.seq).toBe(seq + 1);
    expect(c.current!.ct).toBe(store.pos.ct);
    expect(gen(KEY_4663)).toBe(gen4663);
    const doc = shards.get(4663)![0]!;
    doc.metrics = { tvlUsd: 77 };
    upsertRow(store, 4663, doc);
    await catalog.tick();
    expect(gen(KEY_4663)).toBe(gen4663 + 1);
    expect(gen(shardKey(1, PROTO))).toBe(gen1);
  });

  it('the swap waits for a pass in flight, and a pass that starts during the swap waits for it', async () => {
    const shards = shardsFor(2, { 1: 30, 42161: 30, 4663: 60 });
    const store = buildStore(shards);
    const catalog = new PoolCatalog({ engine: new InThreadEngine(), source: () => ({ store, shards: CHAINS.map((chainId) => ({ chainId, protocol: PROTO })) }), alert: () => undefined });
    await catalog.tick();
    const held = await catalog.acquire();
    const before = { gen: held!.shards.get(KEY_4663)!.gen };
    const doc = shards.get(4663)![1]!;
    doc.metrics = { tvlUsd: 999_999 };
    upsertRow(store, 4663, doc);
    let swapped = false;
    const ticking = catalog.tick().then(() => (swapped = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(swapped).toBe(false); // drained? not while the pass holds G
    expect(catalog.current!.shards.get(KEY_4663)!.gen).toBe(before.gen);
    let late: number | undefined;
    const waiting = catalog.acquire().then((generation) => (late = generation!.shards.get(KEY_4663)!.gen));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(late).toBeUndefined();
    catalog.release();
    await ticking;
    await waiting;
    catalog.release();
    expect(swapped).toBe(true);
    expect(late).toBe(before.gen + 1);
  });

  it('rebuilds a shard (new instance) when its table is reset or replaced, or a row changes its poolId', async () => {
    const shards = shardsFor(3, { 1: 20, 42161: 20, 4663: 40 });
    const store = buildStore(shards);
    const { catalog } = await catalogFor(store, makeConfig());
    const instance = () => catalog.catalog!.current!.shards.get(KEY_4663)!.instance;
    const first = instance();
    const doc = { ...shards.get(4663)![0]!, poolId: '0x' + 'e'.repeat(64) };
    upsertRow(store, 4663, doc);
    await catalog.tick();
    expect(instance()).not.toBe(first);
    const second = instance();
    store.table('pools', KEY_4663)!.reset();
    for (const d of shards.get(4663)!) upsertRow(store, 4663, d);
    await catalog.tick();
    expect(instance()).not.toBe(second);
    store.table('pools', KEY_4663)!.state = 'scanning';
    await catalog.tick();
    expect(catalog.catalog!.current!.shards.has(KEY_4663)).toBe(false);
    expect(catalog.notServable([4663], PROTO)).toBe('shard_not_built');
  });
});

describe('a failed generation', () => {
  it('rebuilds the shards next tick instead of serving a copy that misses the changes it had taken', async () => {
    const shards = shardsFor(19, { 1: 20, 42161: 20, 4663: 60 });
    const store = buildStore(shards);
    const config = makeConfig();
    const { catalog } = await catalogFor(store, config);
    const shard = catalog.catalog!.current!.shards.get(KEY_4663)!;
    const instance = shard.instance;
    const excluded = new Set(EXCLUDED.get(4663));
    const doc = shards.get(4663)!.find((d) => typeof (d.metrics as Doc | null)?.tvlUsd === 'number' && ![(d.token0 as Doc).address, (d.token1 as Doc).address].some((a) => excluded.has(a as string)))!;
    doc.metrics = { ...(doc.metrics as Doc), tvlUsd: 4.2e10 };
    upsertRow(store, 4663, doc);
    const capture = shard.cols.captureOverlay.bind(shard.cols);
    shard.cols.captureOverlay = () => {
      throw new Error('boom');
    };
    await catalog.tick();
    shard.cols.captureOverlay = capture;
    await catalog.tick();
    expect(catalog.catalog!.current!.shards.get(KEY_4663)!.instance).not.toBe(instance);
    const engine = poolsService(poolsRepo(shards, config).repo, config, catalog);
    const oracle = poolsService(poolsRepo(shards, config).repo, config);
    // The changed pool (4.2e10, the largest TVL under the 5e10 ceiling) is where the Mongo path has it.
    const query = q({ minTvlUsd: 4e10 });
    const served = await engine.getTopPools(query as never);
    expect(served).toEqual(await oracle.getTopPools(query as never));
    expect(served.pools.map((p) => p.poolId)).toContain(doc.poolId);
  });
});

describe('serving decisions', () => {
  it('quarantine sends exactly the queries that read the field to Mongo', async () => {
    const shards = shardsFor(4, { 1: 30, 42161: 30, 4663: 60 });
    (shards.get(4663)![3]!.metrics as Doc) = { tvlUsd: 5, volumeUsd24h: '12' }; // a string where a number belongs
    const store = buildStore(shards);
    const config = makeConfig();
    const { catalog } = await catalogFor(store, config);
    const oracle = poolsService(poolsRepo(shards, config).repo, config);
    const engine = poolsService(poolsRepo(shards, config).repo, config, catalog);
    const served = () => (catalog.status().requests as { served: number }).served;
    expect(await engine.getTopPools(q() as never)).toEqual(await oracle.getTopPools(q() as never));
    expect(served()).toBe(1);
    expect(await engine.getTopPools(q({ sort: 'volume' }) as never)).toEqual(await oracle.getTopPools(q({ sort: 'volume' }) as never));
    expect(served()).toBe(1);
    expect((catalog.status().requests as { fallback: Record<string, number> }).fallback).toMatchObject({ 'quarantine:9': 1 });
  });

  it('a foreign chainId on the shard sends every query of that shard to Mongo', async () => {
    const shards = shardsFor(5, { 1: 30, 42161: 30, 4663: 60 });
    shards.get(4663)![0]!.chainId = 1;
    const store = buildStore(shards);
    const { catalog } = await catalogFor(store, makeConfig());
    const engine = poolsService(poolsRepo(shards, makeConfig()).repo, makeConfig(), catalog);
    await engine.getTopPools(q() as never);
    expect((catalog.status().requests as { served: number }).served).toBe(0);
  });

  it('a search MongoDB rejects (U+2028) goes to Mongo and fails there exactly as today', async () => {
    const shards = shardsFor(6, { 1: 30, 42161: 30, 4663: 60 });
    const store = buildStore(shards);
    const config = makeConfig();
    const { catalog } = await catalogFor(store, config);
    const oracle = poolsService(poolsRepo(shards, config).repo, config);
    const engine = poolsService(poolsRepo(shards, config).repo, config, catalog);
    const query = q({ search: 'a\u2028b' });
    const [a, b] = await Promise.allSettled([oracle.getTopPools(query as never), engine.getTopPools(query as never)]);
    expect(a.status).toBe('rejected');
    expect(b.status).toBe('rejected');
    expect((catalog.status().requests as { fallback: Record<string, number> }).fallback).toMatchObject({ 'unsupported:regex_pcre_escape': 1 });
  });

  it('only `serve` answers; not-ready models and lagging data go to Mongo; the ramp percent is honoured', async () => {
    const shards = shardsFor(7, { 1: 30, 42161: 30, 4663: 60 });
    const store = buildStore(shards);
    const config = makeConfig();
    const readModels = fakeReadModels(store, CHAINS, 'shadow');
    const catalog = new PoolCatalogService(config as never, readModels as never);
    await catalog.tick();
    expect(catalog.route([4663], PROTO)).toEqual({ serve: false, reason: 'mode' });
    readModels.mode = 'serve';
    expect(catalog.route([4663], PROTO)).toEqual({ serve: true });
    store.pos = { ...store.pos, ca: Date.now() - 200_000 };
    await catalog.tick();
    expect(catalog.notServable([4663], PROTO)).toBe('catalog_lag');
    touch(store);
    await catalog.tick();
    readModels.readiness = () => ({ pools: { mode: 'serve', ready: false, reason: 'not_caught_up', caughtUp: false, dataAt: Date.now(), lagMs: 0, shards: {} } }) as never;
    expect(catalog.notServable([4663], PROTO)).toBe('not_caught_up');
    const half = new PoolCatalogService(makeConfig({ readModelsServePercent: 0 }) as never, fakeReadModels(store, CHAINS) as never);
    expect(half.route([4663], PROTO)).toEqual({ serve: false, reason: 'percent' });
  });
});

describe('counts', () => {
  it('cap exactly like countDocuments({limit: cap}): exactly the cap is capped, one less is not', async () => {
    const shards = shardsFor(17, { 1: 30, 42161: 30, 4663: 200 });
    const store = buildStore(shards);
    const { catalog } = await catalogFor(store, makeConfig());
    const repo = poolsRepo(shards, makeConfig()).repo;
    const plan = await repo.poolsPlan({ chainId: 4663, protocol: PROTO, sort: 'tvl', page: 1, limit: 20, minTvlUsd: 0, includeRisky: true });
    const access = { cast: (_c: number, _p: string, f: Record<string, unknown>) => f, rows: async () => [], reference: async () => ({ rows: [], count: 0 }) };
    const n = await catalog.countTask(plan, access as never, 1_000_000)!.run();
    expect(n).toMatchObject({ capped: false });
    expect(await catalog.countTask(plan, access as never, n.count)!.run()).toMatchObject({ count: n.count, capped: true });
    expect(await catalog.countTask(plan, access as never, n.count + 1)!.run()).toMatchObject({ count: n.count, capped: false });
  });
});

describe('failure modes', () => {
  it('all chains: a chain whose rows fail is dropped (partial + missingChains), exactly like the Mongo path', async () => {
    const shards = shardsFor(8, { 1: 120, 42161: 90, 4663: 300 });
    const store = buildStore(shards);
    const config = makeConfig();
    const { catalog } = await catalogFor(store, config);
    // 42161's reads fail when they RUN (building a query never touches the server).
    const down = () => new Map([[42161, { fail: (call: { op: string }) => (call.op === 'find' ? Object.assign(new Error('down'), { code: 6 }) : undefined) }]]);
    const oracle = poolsService(poolsRepo(shards, config, down()).repo, config);
    const engine = poolsService(poolsRepo(shards, config, down()).repo, config, catalog);
    for (const page of [1, 2, 7]) {
      const query = { protocol: PROTO, sort: 'tvl', page, limit: 20, minTvlUsd: 0, includeRisky: true };
      const [a, b] = await Promise.all([oracle.getTopPools(query as never, { countWaitMs: 2_000 }), engine.getTopPools(query as never, { countWaitMs: 2_000 })]);
      expect(b).toEqual(a);
      expect(b).toMatchObject({ partial: true, missingChains: [42161] });
    }
    expect((catalog.status().requests as { partial: number }).partial).toBe(3);
  });

  it('one chain whose rows fail falls back to the Mongo path (and its own outcome)', async () => {
    const shards = shardsFor(9, { 1: 30, 42161: 30, 4663: 60 });
    const store = buildStore(shards);
    const config = makeConfig();
    const { catalog } = await catalogFor(store, config);
    const repo = poolsRepo(shards, config);
    const engine = poolsService(repo.repo, config, catalog);
    repo.repo.findRowsByPoolIds = async () => {
      throw new Error('rows down');
    };
    const oracle = poolsService(poolsRepo(shards, config).repo, config);
    expect(await engine.getTopPools(q() as never)).toEqual(await oracle.getTopPools(q() as never));
    expect((catalog.status().requests as { fallback: Record<string, number> }).fallback).toMatchObject({ 'rows:Error': 1 });
  });

  it('an engine overload is a 503 + Retry-After, never a Mongo read', async () => {
    const shards = shardsFor(10, { 1: 30, 42161: 30, 4663: 60 });
    const store = buildStore(shards);
    const config = makeConfig();
    const { catalog } = await catalogFor(store, config);
    const repo = poolsRepo(shards, config);
    const engine = poolsService(repo.repo, config, catalog);
    const pass = catalog.catalog!.answer.bind(catalog.catalog!);
    catalog.catalog!.answer = async () => {
      throw new EngineOverloadError('queue_full');
    };
    await expect(engine.getTopPools(q() as never)).rejects.toBeInstanceOf(QueryTimeoutException);
    // No read RAN (the cast builds a query object and never sends it: no maxTimeMS set).
    expect(repo.models.get(4663)!.calls.filter((call) => call.opts.maxTimeMS !== undefined)).toHaveLength(0);
    catalog.catalog!.answer = pass;
    expect((await engine.getTopPools(q() as never)).pools.length).toBe(20);
  });

  it('data older than the staleness budget is flagged stale + dataAsOf (no-store)', async () => {
    const shards = shardsFor(11, { 1: 30, 42161: 30, 4663: 60 });
    const store = buildStore(shards);
    store.pos = { ...store.pos, ca: Date.now() - 60_000 };
    const config = makeConfig();
    const { catalog } = await catalogFor(store, config);
    const engine = poolsService(poolsRepo(shards, config).repo, config, catalog);
    const meta: { noStore?: boolean } = {};
    const out = await engine.getTopPools(q() as never, { meta });
    expect(out).toMatchObject({ stale: true, dataAsOf: new Date(store.pos.ca).toISOString() });
    expect(meta.noStore).toBe(true);
  });

  it('a cached answer is never served across a rebuild of its shard', async () => {
    const shards = shardsFor(12, { 1: 30, 42161: 30, 4663: 60 });
    const store = buildStore(shards);
    const config = makeConfig();
    const { catalog } = await catalogFor(store, config);
    const engine = poolsService(poolsRepo(shards, config).repo, config, catalog);
    await engine.getTopPools(q() as never);
    store.table('pools', KEY_4663)!.reset();
    const docs = shards.get(4663)!;
    docs.splice(0, 30);
    for (const d of docs) upsertRow(store, 4663, d);
    await catalog.tick();
    const oracle = poolsService(poolsRepo(shards, config).repo, config);
    expect(await engine.getTopPools(q() as never)).toEqual(await oracle.getTopPools(q() as never));
  });
});

describe('off / shadow / serve side effects', () => {
  it('off: the catalog never builds and never answers; responses are today’s', async () => {
    const shards = shardsFor(13, { 1: 30, 42161: 30, 4663: 60 });
    const store = buildStore(shards);
    const config = makeConfig();
    const { catalog } = await catalogFor(store, config, 'off');
    expect(catalog.catalog).toBeUndefined();
    const oracle = poolsService(poolsRepo(shards, config).repo, config);
    const engine = poolsService(poolsRepo(shards, config).repo, config, catalog);
    for (const query of [q(), q({ chainId: undefined }), q({ page: 60, limit: 20 })]) {
      expect(JSON.stringify(await engine.getTopPools(query as never))).toBe(JSON.stringify(await oracle.getTopPools(query as never)));
    }
    expect(JSON.stringify(await engine.getTopPoolsCount(q() as never))).toBe(JSON.stringify(await oracle.getTopPoolsCount(q() as never)));
  });

  it('shadow: responses are byte-identical to off while lane A checks them against Mongo at the clusterTime (0 diffs)', async () => {
    const shards = shardsFor(14, { 1: 80, 42161: 60, 4663: 200 });
    const store = buildStore(shards);
    const config = makeConfig({ readModelsShadowSample: 1 });
    const { catalog, readModels } = await catalogFor(store, config, 'shadow');
    const oracle = poolsService(poolsRepo(shards, config).repo, config);
    const repo = poolsRepo(shards, config);
    // The lane-A reference read, over the same mini-mongo shards (no snapshot there: the data is static).
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
    const engine = poolsService(repo.repo, config, catalog);
    const queries = [
      q(),
      q({ chainId: undefined }),
      q({ sort: 'age', minTvlUsd: 10_000, includeRisky: false }),
      q({ search: 'usd' }),
      q({ chainId: 1, page: 3, limit: 7, sort: 'volume' }),
      q({ chainId: undefined, page: 2, sort: 'fees', search: 'K' }),
      q({ page: 30 }),
    ];
    for (const query of queries) {
      expect(JSON.stringify(await engine.getTopPools(query as never))).toBe(JSON.stringify(await oracle.getTopPools(query as never)));
      expect(JSON.stringify(await engine.getTopPoolsCount(query as never))).toBe(JSON.stringify(await oracle.getTopPoolsCount(query as never)));
    }
    await vi.waitFor(() => expect(catalog.lane.checks).toBeGreaterThanOrEqual(10), { timeout: 5_000 });
    expect(catalog.lane.diffs).toBe(0);
    expect(readModels.tickets).toBeGreaterThanOrEqual(10);
    // Neither a list nor a COUNT was answered by the catalog in shadow.
    expect(catalog.status().requests as { served: number; counted: number }).toMatchObject({ served: 0, counted: 0 });
    // A deliberately wrong model: lane A reports it.
    const doc = shards.get(4663)!.find((d) => typeof (d.metrics as Doc | null)?.tvlUsd === 'number' && ((d.metrics as Doc).tvlUsd as number) > 0)!;
    upsertRow(store, 4663, { ...doc, metrics: { ...(doc.metrics as Doc), tvlUsd: 4.9e10 } });
    await catalog.tick();
    catalog.lane.buckets.clear();
    await engine.getTopPools(q({ minTvlUsd: 1 }) as never);
    await vi.waitFor(() => expect(catalog.lane.diffs).toBe(1), { timeout: 5_000 });
    expect(readModels.alerts.snapshot().counts['read_models.shadow_diff']).toBe(1);
    expect(['ids', 'order']).toContain((catalog.lane.snapshot().lastDiffs[0] as { diff: { kind: string } }).diff.kind);
  });

  it('shadow /count on a catalog that is not ready (or below the ramp) is exactly the Mongo-only answer', async () => {
    const shards = shardsFor(16, { 1: 30, 42161: 30, 4663: 60 });
    const store = buildStore(shards);
    for (const [label, over, prep] of [
      ['not ready', {}, () => (store.table('pools', shardKey(4663, PROTO))!.state = 'scanning')],
      ['percent 0', { readModelsServePercent: 0 }, () => undefined],
    ] as Array<[string, Record<string, unknown>, () => unknown]>) {
      const config = makeConfig(over);
      const { catalog } = await catalogFor(store, config, 'shadow');
      prep();
      const oracle = poolsService(poolsRepo(shards, config).repo, config);
      const engine = poolsService(poolsRepo(shards, config).repo, config, catalog);
      for (const query of [q(), q({ chainId: undefined }), q({ chainId: 1, sort: 'age' })]) {
        expect(JSON.stringify(await engine.getTopPoolsCount(query as never)), `${label} ${JSON.stringify(query)}`).toBe(JSON.stringify(await oracle.getTopPoolsCount(query as never)));
      }
      expect((catalog.status().requests as { counted: number }).counted).toBe(0);
      store.table('pools', shardKey(4663, PROTO))!.state = 'ready';
    }
  });

  it('serve evicts the pool detail of changed pools; shadow does not', async () => {
    const shards = shardsFor(15, { 1: 20, 42161: 20, 4663: 40 });
    const store = buildStore(shards);
    const config = makeConfig();
    for (const mode of ['shadow', 'serve'] as const) {
      const { catalog } = await catalogFor(store, config, mode);
      const repo = poolsRepo(shards, config);
      const engine = poolsService(repo.repo, config, catalog);
      const doc = shards.get(4663)![mode === 'serve' ? 0 : 1]!;
      const finds = () => repo.models.get(4663)!.calls.length;
      repo.repo.findPoolById = vi.fn(async () => ({ ...doc, metrics: { ...(doc.metrics as Doc | null) } }) as never);
      await engine.getPool(4663, PROTO, doc.poolId as string);
      await engine.getPool(4663, PROTO, doc.poolId as string);
      expect(repo.repo.findPoolById).toHaveBeenCalledTimes(1);
      upsertRow(store, 4663, { ...doc, metrics: { tvlUsd: 5 } });
      await catalog.tick();
      await engine.getPool(4663, PROTO, doc.poolId as string);
      expect(repo.repo.findPoolById).toHaveBeenCalledTimes(mode === 'serve' ? 2 : 1);
      expect(finds()).toBe(0);
    }
  });
});

describe('answers and instances', () => {
  it('an answer’s slots never resolve against a rebuilt instance of their shard', async () => {
    const shards = shardsFor(18, { 1: 20, 42161: 20, 4663: 60 });
    const store = buildStore(shards);
    const { catalog } = await catalogFor(store, makeConfig());
    const repo = poolsRepo(shards, makeConfig()).repo;
    const plan = await repo.poolsPlan({ chainId: 4663, protocol: PROTO, sort: 'tvl', page: 1, limit: 20, minTvlUsd: 0, includeRisky: true });
    const compiled = compilePoolFilter(plan.shapeFilter, 4663, PROTO);
    if (!compiled.ok) throw new Error(compiled.reason);
    const answer = await catalog.catalog!.answer([{ key: KEY_4663, plan: compiled.plan, excluded: plan.excluded }], 0);
    expect(catalog.catalog!.poolIdOf(answer, 0, answer.slots[0]!)).toBeDefined();
    store.table('pools', KEY_4663)!.reset();
    for (const d of shards.get(4663)!.slice(10)) upsertRow(store, 4663, d);
    await catalog.tick();
    expect(catalog.catalog!.isCurrent(answer)).toBe(false);
    expect(catalog.catalog!.poolIdOf(answer, 0, answer.slots[0]!)).toBeUndefined();
  });
});

describe('a fresh shard set', () => {
  it('serves a shard added later only once it is built; ids of deleted pools resolve (tombstones keep the poolId)', async () => {
    const shards = shardsFor(16, { 1: 20, 42161: 20, 4663: 40 });
    const store = buildStore(new Map([...shards].filter(([c]) => c !== 42161)));
    const config = makeConfig();
    const { catalog } = await catalogFor(store, config);
    expect(catalog.notServable([42161], PROTO)).toBe('shard_not_built');
    for (const d of shards.get(42161)!) upsertRow(store, 42161, d);
    store.table('pools', shardKey(42161, PROTO))!.state = 'ready';
    await catalog.tick();
    expect(catalog.notServable([42161], PROTO)).toBeUndefined();
    const doc = makePools(99, 4663, 1)[0]!;
    shards.get(4663)!.push(doc);
    upsertRow(store, 4663, doc);
    await catalog.tick();
    store.table('pools', KEY_4663)!.delete(oidOf(doc));
    const slot = store.table('pools', KEY_4663)!.slotOf(oidOf(doc));
    const shard = catalog.catalog!.current!.shards.get(KEY_4663)!;
    expect(catalog.catalog!.poolIdOf({ shards: [{ key: KEY_4663, chainId: 4663, protocol: PROTO, instance: shard.instance, gen: shard.gen }] }, 0, slot)).toBe(doc.poolId);
  });
});
