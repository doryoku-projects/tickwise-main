import { describe, expect, it } from 'vitest';
import { EngineOverloadError, InThreadEngine, type EngineRunner } from '../../src/read-models/core/engine-runner.js';
import { shardKey } from '../../src/read-models/core/fields.js';
import type { ModelStore } from '../../src/read-models/core/model-store.js';
import { MAX_GENERATION_RETRIES, PoolCatalog } from '../../src/read-models/pools/pool-catalog.js';
import { RANK_PERMS } from '../../src/read-models/rank/rank-columns.js';
import { RankEngine, type RankShard } from '../../src/read-models/rank/rank-engine.js';
import { buildStore, shardsFor as poolShardsFor, upsertRow as upsertPool } from './pools-support.js';
import { buildRankStore, makePositions, PROTO, touch, upsertRow } from './rank-support.js';

/**
 * Integration fixes to the engines' generation step (P-R review, rank + pools
 * + feeder lenses): the rank engine keeps a shard at its generation when a
 * build / update is refused (re-queues the taken slots, reuses its copy) like
 * the pool catalog, drains a table that is not ready, refuses a frozen stream
 * position; both engines drop a shard whose R1 table was REPLACED (a snapshot
 * reload) before building the new copy; a pools pass waits for a swap at most
 * its acquire wait.
 */

const CHAIN = 1;
const KEY = shardKey(CHAIN, PROTO);

/** An in-thread engine that refuses generation tasks (build / update) while `overloaded`, and records broadcasts. */
function refusingEngine() {
  const inner = new InThreadEngine();
  const state = { overloaded: false, refused: 0, drops: [] as string[] };
  const engine: EngineRunner = {
    kind: 'in-thread',
    run: ((kind: string, input: unknown, options?: unknown) => {
      if (state.overloaded && (kind.endsWith('.build') || kind.endsWith('.update'))) {
        state.refused++;
        return Promise.reject(new EngineOverloadError('queue_full'));
      }
      return (inner.run as (k: string, i: unknown, o?: unknown) => Promise<unknown>)(kind, input, options);
    }) as EngineRunner['run'],
    broadcast: ((kind: string, input: { instanceKey?: string }) => {
      if (kind === 'drop' && input.instanceKey) state.drops.push(input.instanceKey);
      (inner.broadcast as (k: string, i: unknown) => void)(kind, input);
    }) as EngineRunner['broadcast'],
    stats: () => inner.stats(),
    stop: () => inner.stop(),
  };
  return { engine, state };
}

function rankOver(store: ModelStore, engine: EngineRunner, alerts: string[] = []): RankEngine {
  return new RankEngine({ engine, source: () => ({ store, shards: [{ chainId: CHAIN, protocol: PROTO }] }), alert: (name) => alerts.push(name) });
}

/** The current permutations of a shard (comparable across instances). */
function permsOf(shard: RankShard): number[][] {
  return RANK_PERMS.map((_, p) => Array.from(shard.perms[shard.permCur][p]!.subarray(0, shard.permLen[p])).map((slot) => Number(shard.cols.arrays.pv[0]![slot])));
}

async function freshPerms(store: ModelStore): Promise<number[][]> {
  const fresh = rankOver(store, new InThreadEngine());
  await fresh.tick();
  return permsOf(fresh.current!.shards.get(KEY)!);
}

describe('rank engine: an overloaded engine never drops a shard', () => {
  it('a refused update keeps the shard at its generation, then applies the taken changes once the engine accepts', async () => {
    const docs = makePositions(51, CHAIN, 300);
    const store = buildRankStore(new Map([[CHAIN, docs]]));
    const { engine, state } = refusingEngine();
    const rank = rankOver(store, engine);
    await rank.tick();
    const before = rank.current!;
    const shard = before.shards.get(KEY)!;
    const { instance, gen } = shard;
    upsertRow(store, CHAIN, { ...docs[3]!, metrics: { ...(docs[3]!.metrics as object), underlyingValueUsd: 9e15, aprExGas: 9e9 } });
    touch(store);
    state.overloaded = true;
    await rank.tick();
    await rank.tick();
    expect(state.refused).toBeGreaterThanOrEqual(2);
    // Nothing published: every shard (and the clusterTime) is where it was.
    expect(rank.current).toBe(before);
    expect(rank.current!.shards.get(KEY)).toBe(shard);
    expect((rank.status() as { requeuedSlots: number }).requeuedSlots).toBeGreaterThan(0);
    state.overloaded = false;
    await rank.tick();
    const after = rank.current!.shards.get(KEY)!;
    expect(after.instance).toBe(instance);
    expect(after.gen).toBe(gen + 1);
    expect(rank.current!.ct).toBe(store.pos.ct);
    // The requeued slot was applied: the permutations are a fresh build's.
    expect(permsOf(after)).toEqual(await freshPerms(store));
  });

  it('a refused (re)build reuses its copy once accepted — exactly one new instance', async () => {
    const docs = makePositions(52, CHAIN, 300);
    const store = buildRankStore(new Map([[CHAIN, docs]]));
    const { engine, state } = refusingEngine();
    const rank = rankOver(store, engine);
    await rank.tick();
    const first = rank.current!.shards.get(KEY)!.instance;
    const table = store.table('rank', KEY)!;
    table.reset();
    for (const d of docs) upsertRow(store, CHAIN, d);
    table.state = 'ready';
    touch(store);
    state.overloaded = true;
    await rank.tick();
    await rank.tick();
    expect(rank.current!.shards.get(KEY)!.instance).toBe(first);
    expect((rank.status() as { stashed: string[] }).stashed).toEqual([KEY]);
    upsertRow(store, CHAIN, { ...docs[7]!, metrics: { ...(docs[7]!.metrics as object), underlyingValueUsd: 7e15 } });
    state.overloaded = false;
    await rank.tick();
    const rebuilt = rank.current!.shards.get(KEY)!;
    expect(rebuilt.instance).toBe(first + 1);
    expect(permsOf(rebuilt)).toEqual(await freshPerms(store));
  });

  it(`a task failing ${MAX_GENERATION_RETRIES} times in a row drops the shard (rebuilt from a fresh copy)`, async () => {
    const docs = makePositions(53, CHAIN, 200);
    const store = buildRankStore(new Map([[CHAIN, docs]]));
    const { engine, state } = refusingEngine();
    const rank = rankOver(store, engine);
    await rank.tick();
    upsertRow(store, CHAIN, { ...docs[1]!, metrics: { ...(docs[1]!.metrics as object), underlyingValueUsd: 9 } });
    state.overloaded = true;
    for (let i = 1; i < MAX_GENERATION_RETRIES; i++) {
      await rank.tick();
      expect(rank.current!.shards.has(KEY)).toBe(true);
    }
    await rank.tick();
    expect(rank.current!.shards.has(KEY)).toBe(false);
    state.overloaded = false;
    await rank.tick();
    expect(rank.current!.shards.has(KEY)).toBe(true);
    expect(permsOf(rank.current!.shards.get(KEY)!)).toEqual(await freshPerms(store));
  });

  it('a table that is not ready has its changes drained (a rescan re-inserts every slot)', async () => {
    const docs = makePositions(54, CHAIN, 200);
    const store = buildRankStore(new Map([[CHAIN, docs]]));
    const rank = rankOver(store, new InThreadEngine());
    await rank.tick();
    const table = store.table('rank', KEY)!;
    table.state = 'scanning';
    for (const d of docs) upsertRow(store, CHAIN, d);
    await rank.tick();
    expect(table.takeChanges()).toEqual([]);
    table.state = 'ready';
    await rank.tick();
    expect(permsOf(rank.current!.shards.get(KEY)!)).toEqual(await freshPerms(store));
  });

  it('a frozen stream position marks the generation frozen (not served, not lane-checked)', async () => {
    const store = buildRankStore(new Map([[CHAIN, makePositions(55, CHAIN, 50)]]));
    const rank = rankOver(store, new InThreadEngine());
    await rank.tick();
    expect(rank.current!.frozen).toBe(false);
    touch(store);
    (store.pos as { frozen?: boolean }).frozen = true;
    await rank.tick();
    expect(rank.current!.frozen).toBe(true);
    touch(store);
    (store.pos as { frozen?: boolean }).frozen = false;
    await rank.tick();
    expect(rank.current!.frozen).toBe(false);
  });
});

describe('a snapshot reload (R1 tables replaced) never holds the old engine copy beside the new one', () => {
  it('rank: the replaced shard leaves the generation before its new copy is built', async () => {
    const docs = makePositions(56, CHAIN, 200);
    const store = buildRankStore(new Map([[CHAIN, docs]]));
    const { engine, state } = refusingEngine();
    const rank = rankOver(store, engine);
    await rank.tick();
    const old = rank.current!.shards.get(KEY)!;
    // The runtime's reload: drop every table, then load new ones.
    store.clear();
    const fresh = buildRankStore(new Map([[CHAIN, docs]]));
    store.setTable(fresh.table('rank', KEY)!);
    touch(store);
    // The new copy's build is refused: the old copy must be gone anyway.
    state.overloaded = true;
    await rank.tick();
    expect(rank.current!.shards.has(KEY)).toBe(false);
    expect(state.drops).toContain(`rank:${KEY}#${old.instance}`);
    expect((rank.status() as { replacedDrops: number }).replacedDrops).toBe(1);
    state.overloaded = false;
    await rank.tick();
    expect(rank.current!.shards.get(KEY)!.table).toBe(store.table('rank', KEY));
  });

  it('pools: the replaced shard leaves the generation before its new copy is built', async () => {
    const shards = poolShardsFor(57, { 1: 40, 42161: 40, 4663: 40 });
    const store = buildStore(shards);
    const { engine, state } = refusingEngine();
    const catalog = new PoolCatalog({ engine, source: () => ({ store, shards: [1, 42161, 4663].map((chainId) => ({ chainId, protocol: PROTO })) }), alert: () => undefined });
    await catalog.tick();
    const old = catalog.current!.shards.get(KEY)!;
    store.clear();
    const fresh = buildStore(shards);
    for (const chainId of [1, 42161, 4663]) store.setTable(fresh.table('pools', shardKey(chainId, PROTO))!);
    touch(store);
    state.overloaded = true;
    await catalog.tick();
    expect(catalog.current!.shards.size).toBe(0);
    expect(state.drops).toContain(`${KEY}#${old.instance}`);
    state.overloaded = false;
    await catalog.tick();
    expect(catalog.current!.shards.get(KEY)!.table).toBe(store.table('pools', KEY));
    // A plain change (same table) is not a replacement.
    const drops = state.drops.length;
    upsertPool(store, 1, { ...shards.get(1)![0]!, metrics: { tvlUsd: 1 } });
    touch(store);
    await catalog.tick();
    expect(state.drops.length).toBe(drops);
  });
});

describe('a pools pass and a swap in progress', () => {
  it('waits at most its acquire wait, then is refused as an overload (503), never parked', async () => {
    const store = buildStore(poolShardsFor(58, { 1: 20 }));
    const catalog = new PoolCatalog({ engine: new InThreadEngine(), source: () => ({ store, shards: [{ chainId: 1, protocol: PROTO }] }), alert: () => undefined });
    await catalog.tick();
    let open!: () => void;
    (catalog as unknown as { gate?: Promise<void> }).gate = new Promise<void>((resolve) => (open = resolve));
    const started = Date.now();
    await expect(catalog.acquire(80)).rejects.toMatchObject({ name: 'EngineOverloadError', reason: 'deadline' });
    expect(Date.now() - started).toBeLessThan(1_000);
    const entering = catalog.acquire(1_000);
    (catalog as unknown as { gate?: Promise<void> }).gate = undefined;
    open();
    await expect(entering).resolves.toBeDefined();
    catalog.release();
  });
});

describe('the pools pass cache stays bounded', () => {
  it('a pass on a newer generation drops the instance’s older generations’ bitsets at once', async () => {
    const { PoolPassCache } = await import('../../src/read-models/pools/pool-pass.js');
    const cache = new PoolPassCache();
    cache.putBits('1:uniswap-v4#7|1|live', new Uint32Array(8));
    cache.putBits('1:uniswap-v4#7|1|q:x', new Uint32Array(8));
    cache.putBits('1:uniswap-v4#8|1|live', new Uint32Array(8)); // another instance
    cache.noteGeneration('1:uniswap-v4#7', 1);
    expect(cache.stats.bitsets).toBe(3);
    cache.noteGeneration('1:uniswap-v4#7', 2);
    expect(cache.getBits('1:uniswap-v4#7|1|live')).toBeUndefined();
    expect(cache.getBits('1:uniswap-v4#7|1|q:x')).toBeUndefined();
    expect(cache.getBits('1:uniswap-v4#8|1|live')).toBeDefined();
    expect(cache.stats.bitBytes).toBe(32);
  });

  it('needle states are capped in BYTES, least recently used first (their bitsets grow to the dictionary)', async () => {
    const { PoolPassCache } = await import('../../src/read-models/pools/pool-pass.js');
    const cache = new PoolPassCache(64 * 1024 * 1024, 64, 4_000);
    const a = cache.needle('i', 'aaa');
    a.known = new Uint32Array(500); // 2,000 bytes
    const b = cache.needle('i', 'bbb');
    b.known = new Uint32Array(500);
    expect(cache.stats).toMatchObject({ needles: 2, needleBytes: 4_000 });
    const c = cache.needle('i', 'ccc'); // still within the cap (c is empty)
    c.known = new Uint32Array(500);
    cache.needle('i', 'ddd'); // 6,000 bytes held: the oldest go until ≤ 4,000
    expect(cache.stats).toMatchObject({ needles: 3, needleBytes: 4_000 });
    expect(cache.needle('i', 'aaa')).not.toBe(a); // evicted (a fresh state)
    expect(cache.needle('i', 'bbb')).toBe(b); // kept
  });
});
