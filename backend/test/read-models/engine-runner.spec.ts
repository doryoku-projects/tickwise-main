import { afterAll, describe, expect, it } from 'vitest';
import { EngineOverloadError, EngineTaskTimeoutError, InThreadEngine, WorkerEngine } from '../../src/read-models/core/engine-runner.js';
import { sharedU32 } from '../../src/read-models/core/shared-memory.js';
import { POOL_PERMS } from '../../src/read-models/pools/pool-columns.js';
import { PoolCatalog } from '../../src/read-models/pools/pool-catalog.js';
import { compilePoolFilter } from '../../src/read-models/pools/pool-query.js';
import { buildStore, CHAINS, makeConfig, PROTO, poolsRepo, poolsService, shardsFor } from './pools-support.js';
import { shardKey } from '../../src/read-models/core/fields.js';
import { prng } from '../support/mini-mongo.js';
import { PoolCatalogService } from '../../src/read-models/pools/pool-catalog.service.js';
import { fakeReadModels } from './pools-support.js';

/**
 * The pass workers (design §4.10): real worker threads running the same task
 * code over the SAME shared memory give the in-thread engine's results
 * exactly; admission refuses instead of queueing without bound.
 */

describe('engine runner', () => {
  const workers = new WorkerEngine({ workers: 2, maxQueued: 64 });
  afterAll(() => workers.stop());

  it('worker threads build permutations and run passes exactly like the main thread', async () => {
    const shards = shardsFor(31, { 1: 300, 42161: 200, 4663: 900 });
    const store = buildStore(shards);
    const inThread = new InThreadEngine();
    const catalogs = await Promise.all(
      [inThread, workers].map(async (engine) => {
        const catalog = new PoolCatalog({ engine, source: () => ({ store, shards: CHAINS.map((chainId) => ({ chainId, protocol: PROTO })) }), alert: () => undefined });
        await catalog.tick();
        return catalog;
      }),
    );
    for (const chainId of CHAINS) {
      const [a, b] = catalogs.map((catalog) => catalog.current!.shards.get(shardKey(chainId, PROTO))!);
      for (let p = 0; p < POOL_PERMS.length; p++) expect([...b.perms[b.current][p].subarray(0, b.permLen)]).toEqual([...a.perms[a.current][p].subarray(0, a.permLen)]);
    }
    const repo = poolsRepo(shards, makeConfig()).repo;
    const rand = prng(2);
    for (let i = 0; i < 40; i++) {
      const plans = await Promise.all(
        CHAINS.map((chainId) =>
          repo.poolsPlan({ chainId, protocol: PROTO, sort: ['tvl', 'age', 'fees'][i % 3], page: 1, limit: 20, minTvlUsd: [0, 10_000][i % 2], includeRisky: rand() < 0.5, search: ['usd', undefined, 'ſ', '0xab'][i % 4] }),
        ),
      );
      const inputs = plans.map((plan) => {
        const compiled = compilePoolFilter(plan.shapeFilter, plan.chainId, plan.protocol);
        if (!compiled.ok) throw new Error(compiled.reason);
        return { key: shardKey(plan.chainId, plan.protocol), plan: compiled.plan, excluded: plan.excluded };
      });
      const [x, y] = await Promise.all(catalogs.map((catalog) => catalog.answer(inputs, i % 3 === 1 ? 4 : i % 3 === 2 ? 2 : 0, { atomCounts: true })));
      expect(y.counts).toEqual(x.counts);
      expect(y.atomCounts).toEqual(x.atomCounts);
      expect([...y.slots]).toEqual([...x.slots]);
      expect([...(y.shard ?? [])]).toEqual([...(x.shard ?? [])]);
    }
    expect(workers.stats()).toMatchObject({ kind: 'workers', workers: 2, failed: 0 });
    // the workers' bitset caches, reported with their replies
    expect(workers.stats().cache!.bitBytes).toBeGreaterThan(0);
  }, 60_000);

  it('serves the pools list through worker threads exactly like the Mongo path', async () => {
    const shards = shardsFor(37, { 1: 300, 42161: 200, 4663: 1_200 });
    const store = buildStore(shards);
    const config = makeConfig({ readModelsWorkers: 2 });
    const catalog = new PoolCatalogService(config as never, fakeReadModels(store, CHAINS) as never);
    await catalog.tick();
    const oracle = poolsService(poolsRepo(shards, config).repo, config);
    const engine = poolsService(poolsRepo(shards, config).repo, config, catalog);
    const rand = prng(3);
    for (let i = 0; i < 60; i++) {
      const q = {
        chainId: [1, 4663, undefined][i % 3],
        protocol: PROTO,
        sort: ['tvl', 'volume', 'age'][i % 3],
        page: 1 + Math.floor(rand() * 15),
        limit: [20, 100][i % 2],
        minTvlUsd: [0, 10_000][Math.floor(rand() * 2)],
        includeRisky: rand() < 0.5,
        search: [undefined, 'usd', 'K'][Math.floor(rand() * 3)],
      };
      const [a, b] = await Promise.all([oracle.getTopPools(q as never, { countWaitMs: 2_000 }), engine.getTopPools(q as never, { countWaitMs: 2_000 })]);
      expect(b, JSON.stringify(q)).toEqual(a);
    }
    expect((catalog.status().engine as { kind: string }).kind).toBe('workers');
    expect((catalog.status().requests as { served: number }).served).toBe(60);
    await catalog.onApplicationShutdown();
  }, 60_000);

  it('refuses work past the queue bound or the start deadline (never runs it late)', async () => {
    const engine = new WorkerEngine({ workers: 1, maxQueued: 1 });
    try {
      await engine.run('spin', { ms: 0 }); // the worker is up
      const first = engine.run('spin', { ms: 300 });
      const second = engine.run('spin', { ms: 0 }, { deadlineMs: 5_000 });
      await expect(engine.run('spin', { ms: 0 })).rejects.toMatchObject({ reason: 'queue_full' });
      await Promise.all([first, second]);
      const late = engine.run('spin', { ms: 200 });
      const stale = engine.run('spin', { ms: 0 }, { deadlineMs: 0 });
      await expect(stale).rejects.toBeInstanceOf(EngineOverloadError);
      await late;
      expect(engine.stats().refused).toBe(2);
    } finally {
      await engine.stop();
    }
  }, 60_000);

  it('admits a GENERATION task past the queue bound and runs it ahead of the queued passes', async () => {
    const engine = new WorkerEngine({ workers: 1, maxQueued: 1 });
    try {
      const store = buildStore(shardsFor(41, { 1: 200 }));
      const table = store.table('pools', shardKey(1, PROTO))!;
      const { PoolColumns } = await import('../../src/read-models/pools/pool-columns.js');
      const cols = new PoolColumns(table.capacity);
      cols.copyFrom(table);
      await engine.run('spin', { ms: 0 }); // the worker is up
      const order: string[] = [];
      const running = engine.run('spin', { ms: 400 });
      const pass = engine.run('spin', { ms: 0 }, { deadlineMs: 10_000 }).then(() => order.push('pass'));
      // The queue is full for user work…
      await expect(engine.run('spin', { ms: 0 })).rejects.toMatchObject({ reason: 'queue_full' });
      // …but not for a generation step, which also goes first.
      const build = engine
        .run('pools.build', { cols: cols.arrays, dict: table.dict.sharedView(), slots: cols.slots, out: POOL_PERMS.map(() => sharedU32(cols.arrays.capacity)) }, { deadlineMs: 10_000 })
        .then(() => order.push('build'));
      await Promise.all([running, pass, build]);
      expect(order).toEqual(['build', 'pass']);
      expect(engine.stats().refused).toBe(1);
    } finally {
      await engine.stop();
    }
  }, 60_000);

  it('a generation task runs under the generation timeout, not runTimeoutMs (a long build is not a stuck pass)', async () => {
    const engine = new WorkerEngine({ workers: 1, maxQueued: 8, runTimeoutMs: 1 });
    try {
      const store = buildStore(shardsFor(43, { 1: 20_000 }));
      const table = store.table('pools', shardKey(1, PROTO))!;
      const { PoolColumns } = await import('../../src/read-models/pools/pool-columns.js');
      const cols = new PoolColumns(table.capacity);
      cols.copyFrom(table);
      await expect(
        engine.run('pools.build', { cols: cols.arrays, dict: table.dict.sharedView(), slots: cols.slots, out: POOL_PERMS.map(() => sharedU32(cols.arrays.capacity)) }, { deadlineMs: 30_000 }),
      ).resolves.toMatchObject({ length: 20_000 });
      // a user pass still has the 1 ms run timeout
      await expect(engine.run('spin', { ms: 200 }, { deadlineMs: 30_000 })).rejects.toMatchObject({ name: 'EngineTaskTimeoutError' });
    } finally {
      await engine.stop();
    }
  }, 60_000);

  it('refuses a queued task AT its deadline, not when its slot frees up', async () => {
    const engine = new WorkerEngine({ workers: 1, maxQueued: 8 });
    try {
      await engine.run('spin', { ms: 0 }); // the worker is up
      const long = engine.run('spin', { ms: 1_500 });
      const started = Date.now();
      const late = engine.run('spin', { ms: 0 }, { deadlineMs: 100 }).then(
        () => ({ ok: true, afterMs: Date.now() - started }),
        (err: EngineOverloadError) => ({ ok: false, reason: err.reason, afterMs: Date.now() - started }),
      );
      const result = await late;
      expect(result).toMatchObject({ ok: false, reason: 'deadline' });
      expect(result.afterMs).toBeLessThan(800);
      await long;
      expect(engine.stats()).toMatchObject({ queued: 0, refused: 1 });
    } finally {
      await engine.stop();
    }
  }, 30_000);

  it('affinity is a preference: a task whose worker is busy runs on an idle one instead of waiting', async () => {
    const engine = new WorkerEngine({ workers: 2, maxQueued: 8 });
    try {
      await Promise.all([engine.run('spin', { ms: 0 }), engine.run('spin', { ms: 0 })]);
      const long = engine.run('spin', { ms: 1_500 }, { affinity: 'same' });
      const started = Date.now();
      await expect(engine.run('spin', { ms: 0 }, { affinity: 'same', deadlineMs: 300 })).resolves.toMatchObject({ spunMs: expect.any(Number) });
      expect(Date.now() - started).toBeLessThan(800);
      await long;
    } finally {
      await engine.stop();
    }
  }, 30_000);

  it('a task running past runTimeoutMs fails, and its worker is terminated and replaced', async () => {
    const alerts: string[] = [];
    const engine = new WorkerEngine({ workers: 1, maxQueued: 8, runTimeoutMs: 300, onAlert: (name) => alerts.push(name) });
    try {
      await engine.run('spin', { ms: 0 });
      const started = Date.now();
      await expect(engine.run('spin', { ms: 20_000 }, { deadlineMs: 60_000 })).rejects.toBeInstanceOf(EngineTaskTimeoutError);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(engine.stats()).toMatchObject({ timedOut: 1, restarts: 1 });
      expect(alerts).toContain('read_models.worker_failed');
      // the replacement worker answers
      await expect(engine.run('spin', { ms: 0 }, { deadlineMs: 10_000 })).resolves.toMatchObject({ spunMs: expect.any(Number) });
      expect(engine.stats().workers).toBe(1);
    } finally {
      await engine.stop();
    }
  }, 30_000);

  it('reports the workers’ cache footprint in its stats', async () => {
    const engine = new WorkerEngine({ workers: 1 });
    try {
      await engine.run('spin', { ms: 0 });
      expect(engine.stats().cache).toEqual({ bitBytes: 0, bitsets: 0, needles: 0 });
    } finally {
      await engine.stop();
    }
  }, 30_000);
});
