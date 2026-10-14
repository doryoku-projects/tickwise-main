/*
 * Feeder / holder-session guards found by the R1–R3 review (P-R): snapshot
 * holds owned per session, snapSeq never reused within a (fence, epoch),
 * in-epoch shard scans that never read before their diversion point and never
 * emit rows of a superseded job, idempotent recognition of an append whose
 * reply was lost, the phase after a recovery, renames between two served
 * shards, a worker `fatal` racing its exit, the redis-models memory guard and
 * the reload order (old tables dropped before the new ones are built).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { rowsEqual } from '../../src/read-models/core/cells.js';
import type { ModelStore } from '../../src/read-models/core/model-store.js';
import { toStreamItem } from '../../src/read-models/feeder/change-stream.js';
import { EMPTY_PAYLOAD } from '../../src/read-models/feeder/delta-codec.js';
import { type FeederHost, InThreadFeederHost } from '../../src/read-models/feeder/feeder-host.js';
import { ReadModelsRuntime } from '../../src/read-models/feeder/feeder.service.js';
import type { FeederStartOptions, MainCommand, ShardCollection, WorkerMessage } from '../../src/read-models/feeder/messages.js';
import { normalizeDoc } from '../../src/read-models/feeder/normalize.js';
import { NoopSnapshotSink } from '../../src/read-models/feeder/snapshot-sink.js';
import { loadSnapshotSet, type Manifest } from '../../src/read-models/feeder/snapshot-store.js';
import { MemoryModelsTransport, MemoryStateTransport } from '../../src/read-models/transport.js';
import { FakeCluster, poolDoc, positionDoc } from './fake-cluster.js';
import {
  expectModelEqualsCluster,
  HOLDER_CONFIG,
  KEYS,
  makeRuntime,
  MemoryRedis,
  POOLS_COLL,
  RANK_COLL,
  rng,
  settled,
  sleep,
  SpecAlerts,
  waitUntil,
} from './support.js';

const running: ReadModelsRuntime[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((r) => r.stop().catch(() => undefined)));
});

function cluster(seed: number): { c: FakeCluster; rank: string[] } {
  const c = new FakeCluster();
  c.t = Math.floor(Date.now() / 1000);
  c.random = rng(seed);
  const rank: string[] = [];
  for (let n = 0; n < 100; n++) rank.push(c.insert(RANK_COLL, positionDoc(n)));
  for (let n = 0; n < 20; n++) c.insert(POOLS_COLL, poolDoc(n));
  return { c, rank };
}

type AnyTransport = MemoryModelsTransport & Record<string, unknown>;
const transportOf = (runtime: ReadModelsRuntime): AnyTransport => (runtime as unknown as { deps: { transport: AnyTransport } }).deps.transport;

async function startHolder(c: FakeCluster, redis = new MemoryRedis(), opts: Parameters<typeof makeRuntime>[2] = {}) {
  const made = makeRuntime(redis, c, { owner: 'A', ...opts });
  running.push(made.runtime);
  await made.runtime.start();
  await waitUntil(() => made.runtime.holder?.phase === 'running', 8_000, 'running');
  await settled(made.runtime, c);
  return { ...made, redis, transport: transportOf(made.runtime) };
}

describe('snapshots vs the holder session', () => {
  it('a session that ends mid-encode never commits that snapshot (no torn manifest under a valid fence)', async () => {
    const { c } = cluster(11);
    const { runtime, redis, transport } = await startHolder(c);
    const before = await transport.manifest();
    const origPut = transport.putChunk.bind(transport);
    transport.putChunk = async (...a: Parameters<typeof origPut>) => {
      await sleep(25);
      return origPut(...a);
    };
    const holder = runtime.holder!;
    const snap = holder.writeSnapshot();
    await sleep(15);
    expect(runtime.store.isHeld).toBe(true);
    for (let n = 0; n < 10; n++) c.insert(RANK_COLL, positionDoc(5_000 + n));
    await waitUntil(() => runtime.store.queued > 0, 8_000, 'entries queued behind the hold');
    await sleep(100);
    await holder.stop({ flush: true });
    expect(await snap).toBe(false);
    expect(runtime.store.isHeld).toBe(false);
    const manifest = await transport.manifest();
    expect(manifest?.snapSeq).toBe(before?.snapSeq);
    // A fresh consumer loads what is committed and follows the stream: nothing lost.
    const { runtime: b } = makeRuntime(redis, c, { role: 'server', owner: 'B' });
    running.push(b);
    await b.start();
    await waitUntil(() => b.store.pos.s >= runtime.store.pos.s && b.store.pos.epoch === runtime.store.pos.epoch, 8_000, 'consumer at the tail');
    expectModelEqualsCluster(b.store, c, RANK_COLL, 'rank');
  }, 30_000);

  it('a restarted session in the same (fence, epoch) never overwrites the live snapshot set', async () => {
    const { c } = cluster(13);
    const { runtime, transport } = await startHolder(c);
    const live = (await transport.manifest())!;
    await runtime.applyModes({ rank: 'shadow', pools: 'off' });
    await waitUntil(() => runtime.holder?.phase === 'running', 8_000, 'restarted');
    expect(runtime.holder!.epoch).toBe(live.epoch);
    for (let n = 0; n < 7; n++) c.insert(RANK_COLL, positionDoc(7_000 + n));
    await settled(runtime, c);
    // The new session's snapshot never commits (a hung commit, or the process dies here).
    let written: Manifest | undefined;
    transport.putManifest = (m: Manifest) => {
      written = m;
      return new Promise(() => undefined);
    };
    void runtime.holder!.writeSnapshot();
    await waitUntil(() => written !== undefined, 8_000, 'the new set encoded');
    expect(written!.snapSeq).toBeGreaterThan(live.snapSeq);
    const still = (await transport.manifest())!;
    expect(still.snapSeq).toBe(live.snapSeq);
    const loaded = await loadSnapshotSet({ transport, keys: KEYS, manifest: still, models: new Set(['rank', 'pools'] as const) });
    expect(loaded.tables.find((t) => t.model === 'rank')?.live).toBe(100);
  }, 30_000);
});

describe('in-epoch shard scans', () => {
  it('a rescan never reads before the point its buffer started (scan members trailing the stream member)', async () => {
    const { c, rank } = cluster(5);
    c.memberLags = [40, 40];
    c.streamLag = 0;
    const { runtime, alerts } = await startHolder(c);
    for (let i = 0; i < 60; i++) c.idle();
    await settled(runtime, c);
    for (let k = 0; k < 20; k++) c.update(RANK_COLL, rank[k], { set: { 'metrics.underlyingValueUsd': 999_000 + k } });
    await settled(runtime, c);
    expectModelEqualsCluster(runtime.store, c, RANK_COLL, 'rank');
    const before = alerts.names.filter((n) => n === 'read_models.shard_scan').length;
    await runtime.holder!.runCommand({ type: 'rescan', model: 'rank', shard: '1:uniswap-v4' });
    await waitUntil(() => alerts.names.filter((n) => n === 'read_models.shard_scan').length > before, 8_000, 'scan start');
    await waitUntil(() => runtime.store.table('rank', '1:uniswap-v4')?.state === 'ready' && runtime.holder!.pendingRows === 0, 8_000, 'scan done');
    await sleep(300);
    await settled(runtime, c);
    expectModelEqualsCluster(runtime.store, c, RANK_COLL, 'rank');
  }, 30_000);

  it('rows of a superseded scan job (a batch in flight at the restart) never land: no ghost rows', async () => {
    const { c, rank } = cluster(7);
    c.memberLags = [0, 0];
    const { runtime } = await startHolder(c);
    const orig = c.scanBatch.bind(c);
    let inFlight = 0;
    let slow = true;
    (c as unknown as { scanBatch: typeof c.scanBatch }).scanBatch = async (...args) => {
      const r = await orig(...args);
      if (slow) {
        inFlight++;
        await sleep(80);
        inFlight--;
      }
      return r;
    };
    await runtime.holder!.runCommand({ type: 'rescan', model: 'rank', shard: '1:uniswap-v4' });
    await waitUntil(() => inFlight > 0, 8_000, 'first batch in flight');
    c.delete(RANK_COLL, rank[0]);
    await sleep(20);
    slow = false;
    await runtime.holder!.runCommand({ type: 'rescan', model: 'rank', shard: '1:uniswap-v4' });
    await sleep(500);
    await waitUntil(() => runtime.store.table('rank', '1:uniswap-v4')?.state === 'ready' && runtime.holder!.pendingRows === 0, 8_000, 'scan done');
    await settled(runtime, c);
    expect(runtime.store.table('rank', '1:uniswap-v4')!.liveSlotOf(rank[0])).toBe(-1);
    expectModelEqualsCluster(runtime.store, c, RANK_COLL, 'rank');
  }, 30_000);
});

describe('cold scans', () => {
  /** Slow the scan batches (read at call time, answered 80 ms later) until `fast()`. */
  function slowScans(c: FakeCluster): { inFlight: () => number; fast: () => void } {
    const orig = c.scanBatch.bind(c);
    let inFlight = 0;
    let slow = true;
    (c as unknown as { scanBatch: typeof c.scanBatch }).scanBatch = async (...args) => {
      const r = await orig(...args);
      if (slow) {
        inFlight++;
        await sleep(80);
        inFlight--;
      }
      return r;
    };
    return { inFlight: () => inFlight, fast: () => (slow = false) };
  }

  it('a shard dropped while a cold batch is in flight keeps none of its rows', async () => {
    const { c } = cluster(47);
    c.memberLags = [6, 6];
    const scans = slowScans(c);
    const { runtime } = makeRuntime(new MemoryRedis(), c, { owner: 'A' });
    running.push(runtime);
    await runtime.start();
    await waitUntil(() => scans.inFlight() > 0, 8_000, 'a cold batch in flight');
    c.drop(RANK_COLL);
    await sleep(20);
    scans.fast();
    await waitUntil(() => runtime.holder?.phase === 'running', 8_000, 'running');
    await settled(runtime, c);
    expectModelEqualsCluster(runtime.store, c, RANK_COLL, 'rank');
  }, 30_000);

  it('a collection renamed INTO a shard during the cold scan replaces what was scanned of the old one', async () => {
    const { c } = cluster(53);
    for (let n = 0; n < 6; n++) c.insert('tmp_positions', positionDoc(6_000 + n));
    const scans = slowScans(c);
    const { runtime } = makeRuntime(new MemoryRedis(), c, { owner: 'A' });
    running.push(runtime);
    await runtime.start();
    await waitUntil(() => scans.inFlight() > 0, 8_000, 'a cold batch in flight');
    rename(c, 'tmp_positions', RANK_COLL);
    await sleep(20);
    scans.fast();
    await waitUntil(() => runtime.holder?.phase === 'running', 8_000, 'running');
    await settled(runtime, c);
    expect(c.liveDocs(RANK_COLL).length).toBe(6);
    expectModelEqualsCluster(runtime.store, c, RANK_COLL, 'rank');
  }, 30_000);
});

describe('appends', () => {
  it('an append that landed but whose reply was lost is recognised as ours (no divergence, no reload)', async () => {
    const { c, rank } = cluster(17);
    const { runtime, alerts, transport, redis } = await startHolder(c);
    const orig = transport.append.bind(transport);
    let armed = true;
    transport.append = async (entry: Parameters<typeof orig>[0], ttl: number) => {
      const out = await orig(entry, ttl);
      if (armed && entry.k === 'batch') {
        armed = false;
        throw new Error('Command timed out');
      }
      return out;
    };
    c.update(RANK_COLL, rank[3], { set: { 'metrics.underlyingValueUsd': 123 } });
    await waitUntil(() => !armed, 8_000, 'the ambiguous append');
    await sleep(500);
    expect(runtime.lastEnd?.kind).not.toBe('diverged');
    expect(runtime.phase).toBe('holder');
    expect(alerts.names).toContain('read_models.append_recovered');
    await settled(runtime, c);
    expectModelEqualsCluster(runtime.store, c, RANK_COLL, 'rank');
    // Every replica following the stream holds the same model (the entry is applied once).
    const { runtime: b } = makeRuntime(redis, c, { role: 'server', owner: 'B' });
    running.push(b);
    await b.start();
    await waitUntil(() => b.store.pos.s >= runtime.store.pos.s && b.store.pos.epoch === runtime.store.pos.epoch, 8_000, 'consumer at the tail');
    expectModelEqualsCluster(b.store, c, RANK_COLL, 'rank');
  }, 30_000);

  it('a DIFFERENT entry at our sequence is never taken for ours (still diverged)', async () => {
    const { c, rank } = cluster(19);
    const { runtime, transport } = await startHolder(c);
    const orig = transport.append.bind(transport);
    let armed = true;
    transport.append = async (entry: Parameters<typeof orig>[0], ttl: number) => {
      if (armed && entry.k === 'batch') {
        armed = false;
        // Someone else's entry (a late append of a previous session) takes our s.
        await orig({ ...entry, k: 'heartbeat', d: EMPTY_PAYLOAD }, ttl);
        throw new Error('Command timed out');
      }
      return orig(entry, ttl);
    };
    c.update(RANK_COLL, rank[4], { set: { 'metrics.underlyingValueUsd': 456 } });
    await waitUntil(() => runtime.lastEnd?.kind === 'diverged', 8_000, 'diverged');
  }, 30_000);
});

describe('recovery and the worker', () => {
  it('a recovery that starts during the epoch-start snapshot never leaves the session stuck in snapshotting', async () => {
    const { c } = cluster(23);
    const redis = new MemoryRedis();
    const { runtime } = makeRuntime(redis, c, { owner: 'A' });
    running.push(runtime);
    const transport = transportOf(runtime);
    const origPut = transport.putManifest.bind(transport);
    const origTail = transport.tailId.bind(transport);
    let refused = false;
    let slowTail = false;
    let recovered = false;
    transport.putManifest = async (m: Manifest, ttl: number) => {
      if (!refused) {
        refused = true;
        slowTail = true;
        return 'inc_mismatch';
      }
      return origPut(m, ttl);
    };
    transport.tailId = async () => {
      if (slowTail) {
        slowTail = false;
        // Recovery is parked here while the epoch-start loop's retry lands and sets `running`.
        await sleep(2_600);
        recovered = true;
      }
      return origTail();
    };
    await runtime.start();
    await waitUntil(() => recovered, 15_000, 'recovery past its tail read');
    await waitUntil(() => runtime.holder?.phase === 'running' && runtime.holder.epoch !== 0, 8_000, 'running');
    await sleep(400);
    expect(runtime.holder?.phase).toBe('running');
    const s = runtime.holder!.appended.s;
    c.insert(RANK_COLL, positionDoc(9_001));
    await waitUntil(() => (runtime.holder?.appended.s ?? 0) > s, 8_000, 'appends resume');
  }, 30_000);

  it('a worker fatal posted right before its exit ends the session with the fatal reason, not worker_failed', async () => {
    const { c } = cluster(29);
    const redis = new MemoryRedis();
    const alerts = new SpecAlerts();
    const hosts: TapHost[] = [];
    const runtime = runtimeWith(redis, c, alerts, undefined, () => {
      const host = new TapHost(new InThreadFeederHost(() => c, { liveFlushMs: 10, confirmEveryMs: 40, statsEveryMs: 60_000 }));
      hosts.push(host);
      return host;
    });
    running.push(runtime);
    await runtime.start();
    await waitUntil(() => runtime.holder?.phase === 'running', 8_000, 'running');
    await settled(runtime, c);
    const transport = transportOf(runtime);
    const orig = transport.append.bind(transport);
    transport.append = async (...a: Parameters<typeof orig>) => {
      await sleep(300);
      return orig(...a);
    };
    const host = hosts[hosts.length - 1];
    // The ordered chain is busy (a shard mark appending slowly) when the fatal and the exit arrive.
    host.inject({ type: 'shardScanStart', coll: RANK_COLL, reason: 'spec' });
    await sleep(20);
    host.inject({ type: 'fatal', reason: 'history_lost', detail: 'spec' });
    host.exit(new Error('feeder worker exited'));
    await waitUntil(() => runtime.lastEnd !== undefined, 8_000, 'the session end');
    expect(runtime.lastEnd?.kind).toBe('new_epoch');
    transport.append = orig;
  }, 30_000);
});

describe('renames between served shards', () => {
  const SHARD_10 = '10_uniswap_v4_positions';
  const shards: ShardCollection[] = [
    { coll: RANK_COLL, model: 'rank', chainId: 1, protocol: 'uniswap-v4' },
    { coll: SHARD_10, model: 'rank', chainId: 10, protocol: 'uniswap-v4' },
  ];

  it('toStreamItem: A → B with both served carries both effects', () => {
    const map = new Map(shards.map((s) => [s.coll, s]));
    const ev = { _id: { _data: '82000000050000000100' }, clusterTime: { t: 5, i: 1 }, operationType: 'rename', ns: { db: 'db', coll: RANK_COLL }, to: { db: 'db', coll: SHARD_10 } };
    expect(toStreamItem(ev, map)).toMatchObject({ kind: 'renameBetween', from: RANK_COLL, coll: SHARD_10 });
    expect(toStreamItem({ ...ev, ns: { db: 'db', coll: 'tmp' } }, map)).toMatchObject({ kind: 'renameInto', coll: SHARD_10 });
    expect(toStreamItem({ ...ev, to: { db: 'db', coll: 'elsewhere' } }, map)).toMatchObject({ kind: 'drop', coll: RANK_COLL, how: 'rename' });
  });

  it('A → B in epoch: A is emptied (no ghost shard), B is rescanned', async () => {
    const { c } = cluster(31);
    for (let n = 0; n < 5; n++) c.insert(SHARD_10, positionDoc(8_000 + n));
    const redis = new MemoryRedis();
    const runtime = runtimeWith(redis, c, new SpecAlerts(), shards);
    running.push(runtime);
    await runtime.start();
    await waitUntil(() => runtime.holder?.phase === 'running', 8_000, 'running');
    await settled(runtime, c);
    expect(runtime.store.table('rank', '10:uniswap-v4')?.live).toBe(5);
    rename(c, RANK_COLL, SHARD_10);
    await waitUntil(
      () => runtime.store.table('rank', '1:uniswap-v4')?.live === 0 && runtime.store.table('rank', '10:uniswap-v4')?.state === 'ready' && runtime.store.table('rank', '10:uniswap-v4')?.live === 100,
      8_000,
      'A emptied, B rescanned',
    );
    await settled(runtime, c);
    expect(runtime.store.table('rank', '1:uniswap-v4')?.live).toBe(0);
    expectShardEquals(runtime.store, c, SHARD_10, '10:uniswap-v4');
  }, 30_000);
});

describe('redis-models memory guard', () => {
  it('a snapshot past the alert line (but under the hard ceiling) is still written — it is what trims the stream', async () => {
    const { c } = cluster(37);
    const { runtime, redis, transport, alerts } = await startHolder(c);
    const live = (await transport.manifest())!;
    redis.maxmemory = Math.ceil((redis.usedBytes() + live.stored) / 0.8);
    expect(await runtime.holder!.writeSnapshot()).toBe(true);
    expect((await transport.manifest())!.snapSeq).toBeGreaterThan(live.snapSeq);
    expect(alerts.names).toContain('read_models.redis_memory');
  }, 30_000);

  it('past the hard ceiling the snapshot is skipped', async () => {
    const { c } = cluster(41);
    const { runtime, redis, transport } = await startHolder(c);
    const live = (await transport.manifest())!;
    redis.maxmemory = Math.ceil((redis.usedBytes() + live.stored) / 0.95);
    expect(await runtime.holder!.writeSnapshot()).toBe(false);
    expect((await transport.manifest())!.snapSeq).toBe(live.snapSeq);
  }, 30_000);
});

describe('reloads', () => {
  it('a reload drops the old tables before it builds the new ones (no doubled peak)', async () => {
    const { c } = cluster(43);
    const { redis } = await startHolder(c);
    const { runtime: b } = makeRuntime(redis, c, { role: 'server', owner: 'B' });
    running.push(b);
    await b.start();
    await waitUntil(() => (b.store.table('rank', '1:uniswap-v4')?.live ?? 0) === 100, 8_000, 'B loaded');
    const tb = transportOf(b);
    const origGet = tb.getChunk.bind(tb);
    let tablesAtFirstChunk: number | undefined;
    tb.getChunk = async (key: string) => {
      tablesAtFirstChunk ??= b.store.tables.size;
      return origGet(key);
    };
    b.consumer!.requestReload('spec');
    await waitUntil(() => tablesAtFirstChunk !== undefined && (b.store.table('rank', '1:uniswap-v4')?.live ?? 0) === 100, 8_000, 'reloaded');
    expect(tablesAtFirstChunk).toBe(0);
  }, 30_000);
});

// ── helpers ──

class TapHost implements FeederHost {
  private handler: (message: WorkerMessage) => void = () => undefined;
  private exitHandler: (error?: Error) => void = () => undefined;
  constructor(private readonly inner: InThreadFeederHost) {}
  start(options: FeederStartOptions): void {
    this.inner.onMessage((m) => this.handler(m));
    this.inner.onExit((e) => this.exitHandler(e));
    this.inner.start(options);
  }
  send(command: MainCommand): void {
    this.inner.send(command);
  }
  onMessage(handler: (message: WorkerMessage) => void): void {
    this.handler = handler;
  }
  onExit(handler: (error?: Error) => void): void {
    this.exitHandler = handler;
  }
  stop(): Promise<void> {
    return this.inner.stop();
  }
  inject(message: WorkerMessage): void {
    this.handler(message);
  }
  exit(error?: Error): void {
    this.exitHandler(error);
  }
}

function runtimeWith(redis: MemoryRedis, c: FakeCluster, alerts: SpecAlerts, shards?: ShardCollection[], createHost?: () => FeederHost): ReadModelsRuntime {
  return new ReadModelsRuntime(
    {
      transport: new MemoryModelsTransport(redis, KEYS),
      state: new MemoryStateTransport(redis, KEYS),
      keys: KEYS,
      sink: new NoopSnapshotSink(),
      createHost: createHost ?? (() => new InThreadFeederHost(() => c, { liveFlushMs: 10, confirmEveryMs: 40, statsEveryMs: 60_000 })),
      alerts,
      owner: 'A',
    },
    {
      role: 'both',
      shards: shards ?? [
        { coll: RANK_COLL, model: 'rank', chainId: 1, protocol: 'uniswap-v4' },
        { coll: POOLS_COLL, model: 'pools', chainId: 1, protocol: 'uniswap-v4' },
      ],
      holder: HOLDER_CONFIG,
      maxLagMs: 120_000,
      positionsCapacity: 0,
      leaseTtlMs: 1_000,
      leaseRetryMs: 100,
      oplogRetryMs: 60_000,
    },
    { rank: 'shadow', pools: shards ? 'off' : 'shadow' },
  );
}

/** `renameCollection(from, to, dropTarget)` on the simulated cluster. */
function rename(c: FakeCluster, from: string, to: string): void {
  type Versions = Map<string, Array<{ ct: unknown; doc: Record<string, unknown> | null }>>;
  const priv = c as unknown as { nextTime(): { t: number; i: number }; coll(name: string): Versions; record(event: Record<string, unknown>, ct: unknown): void };
  const ct = priv.nextTime();
  const src = priv.coll(from);
  const dst = priv.coll(to);
  for (const versions of dst.values()) versions.push({ ct, doc: null });
  for (const [oid, versions] of src) {
    const last = versions[versions.length - 1];
    if (last?.doc) {
      const target = dst.get(oid) ?? [];
      target.push({ ct, doc: last.doc });
      dst.set(oid, target);
    }
    versions.push({ ct, doc: null });
  }
  priv.record({ operationType: 'rename', ns: { db: 'db', coll: from }, to: { db: 'db', coll: to } }, ct);
}

function expectShardEquals(store: ModelStore, c: FakeCluster, coll: string, shard: `${number}:${string}`): void {
  const table = store.table('rank', shard)!;
  const docs = c.liveDocs(coll);
  const bad = docs.filter(({ oid, doc }) => {
    const slot = table.liveSlotOf(oid);
    return slot < 0 || !rowsEqual(table.cellsAt(slot), normalizeDoc('rank', doc));
  });
  expect(bad.length).toBe(0);
  expect(table.live).toBe(docs.length);
}
