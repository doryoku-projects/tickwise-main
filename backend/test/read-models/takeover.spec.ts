/*
 * Takeover, demotion, fencing and redis-models loss (design §2.4–§2.5, §3.6),
 * with several simulated processes on one simulated Redis and one simulated
 * replica set:
 *  - a consumer that wins the lease catches up from the stream, continues the
 *    epoch's sequence and the dictionaries' ids — every replica identical;
 *  - a dotted-leaf update that moves a row into the A+ set after a takeover
 *    yields its REAL rates (every leaf is kept for every row);
 *  - a fenced-out holder demotes to a consumer without a rebuild;
 *  - a flushed redis-models is continued from memory (new incarnation, new
 *    epoch that `continues`), consumers switching without a reload.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { leafIndex } from '../../src/read-models/core/fields.js';
import { entryFromFields, type DeltaEntry } from '../../src/read-models/feeder/delta-codec.js';
import type { ReadModelsRuntime } from '../../src/read-models/feeder/feeder.service.js';
import { MemoryStateTransport } from '../../src/read-models/transport.js';
import { FakeCluster, poolDoc, positionDoc } from './fake-cluster.js';
import { expectModelEqualsCluster, KEYS, makeRuntime, MemoryRedis, POOLS_COLL, RANK_COLL, settled, sleep, waitUntil } from './support.js';

const running: ReadModelsRuntime[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((r) => r.stop()));
});

function seededCluster(): FakeCluster {
  const cluster = new FakeCluster();
  cluster.t = Math.floor(Date.now() / 1000);
  for (let n = 0; n < 150; n++) cluster.insert(RANK_COLL, positionDoc(n));
  for (let n = 0; n < 40; n++) cluster.insert(POOLS_COLL, poolDoc(n));
  return cluster;
}

/** Every entry in the stream, in order. */
function streamEntries(redis: MemoryRedis): DeltaEntry[] {
  return redis.xrange(KEYS.deltas, '0-0', 1_000_000).map((row) => entryFromFields(row.id, row.fields.map((f) => (typeof f === 'string' ? f : Buffer.from(f)))));
}

/** Within each epoch, `s` is contiguous and fences never go down. */
function expectContiguous(entries: DeltaEntry[]): void {
  const byEpoch = new Map<number, DeltaEntry[]>();
  for (const entry of entries) byEpoch.set(entry.e, [...(byEpoch.get(entry.e) ?? []), entry]);
  for (const [, list] of byEpoch) {
    for (let i = 1; i < list.length; i++) {
      expect(list[i].s).toBe(list[i - 1].s + 1);
      expect(list[i].f).toBeGreaterThanOrEqual(list[i - 1].f);
    }
  }
}

/** Simulate a process that dies holding the lease: its session stops, nothing is released. */
async function crashHolder(runtime: ReadModelsRuntime): Promise<void> {
  const holder = runtime.holder!;
  // The session's end is 'stopped', which the runtime ignores: it keeps its phase and never renews again.
  await holder.stop();
}

describe('takeover', () => {
  it('a consumer wins the lease, catches up, and continues the epoch, s and dictionary ids', async () => {
    const cluster = seededCluster();
    const redis = new MemoryRedis();
    const { runtime: a } = makeRuntime(redis, cluster, { owner: 'A' });
    const { runtime: b } = makeRuntime(redis, cluster, { owner: 'B' });
    const { runtime: c } = makeRuntime(redis, cluster, { owner: 'C', role: 'server' });
    running.push(a, b, c);
    await a.start();
    await waitUntil(() => a.holder?.phase === 'running', 8_000, 'A holds');
    await b.start();
    await c.start();
    expect(b.phase).toBe('consumer');
    for (let n = 0; n < 60; n++) cluster.update(RANK_COLL, cluster.liveDocs(RANK_COLL)[n].oid, { set: { owner: `0xnew-owner-${n}` } });
    await settled(a, cluster);
    const epoch = a.holder!.epoch;
    const lastS = a.holder!.appended.s;
    const fenceA = a.holder!.fence;

    await crashHolder(a);
    // Writes while nobody holds the lease: the new holder resumes the change stream after A's last entry.
    const zeroValue = cluster.insert(RANK_COLL, positionDoc(9_000, { metrics: { ...(positionDoc(9_000).metrics as object), underlyingValueUsd: 0, aprExGas: 12.5, feeApr: 3.25, roi: 0.5 } }));
    for (let n = 0; n < 30; n++) cluster.update(RANK_COLL, cluster.liveDocs(RANK_COLL)[n].oid, { set: { metrics: positionDoc(500 + n).metrics } });
    await waitUntil(() => b.phase === 'holder' && b.holder?.phase === 'running', 8_000, 'B takes over');
    expect(b.holder!.epoch).toBe(epoch); // a takeover keeps the epoch
    expect(b.holder!.fence).toBeGreaterThan(fenceA);
    await settled(b, cluster);
    expect(b.holder!.appended.s).toBeGreaterThan(lastS);

    // The dotted-leaf update that moves the row into A+ (value 0 → 5): its rates are the real ones.
    cluster.update(RANK_COLL, zeroValue, { set: { 'metrics.underlyingValueUsd': 5 } });
    await settled(b, cluster);
    const table = b.store.table('rank', '1:uniswap-v4')!;
    const slot = table.liveSlotOf(zeroValue);
    expect(table.cellAt(slot, leafIndex('rank', 'metrics.underlyingValueUsd'))).toBe(5);
    expect(table.cellAt(slot, leafIndex('rank', 'metrics.aprExGas'))).toBe(12.5);
    expect(table.cellAt(slot, leafIndex('rank', 'metrics.feeApr'))).toBe(3.25);
    expect(table.cellAt(slot, leafIndex('rank', 'metrics.roi'))).toBe(0.5);

    expectModelEqualsCluster(b.store, cluster, RANK_COLL, 'rank');
    expectModelEqualsCluster(b.store, cluster, POOLS_COLL, 'pools');
    await waitUntil(() => c.store.pos.s === b.holder!.appended.s, 8_000, 'C follows B');
    expectModelEqualsCluster(c.store, cluster, RANK_COLL, 'rank');
    // Identical dictionaries on every replica: same ids, same strings, none reused.
    const db = b.store.table('rank', '1:uniswap-v4')!.dict;
    const dc = c.store.table('rank', '1:uniswap-v4')!.dict;
    expect(dc.size).toBe(db.size);
    const seen = new Set<string>();
    for (let id = 0; id < db.size; id++) {
      expect(dc.get(id)).toBe(db.get(id));
      expect(seen.has(db.get(id))).toBe(false);
      seen.add(db.get(id));
    }
    expectContiguous(streamEntries(redis));
  }, 40_000);

  it('a holder fenced out by a newer fence demotes to a consumer — no rebuild, no stream gap', async () => {
    const cluster = seededCluster();
    const redis = new MemoryRedis();
    const { runtime: a, alerts } = makeRuntime(redis, cluster, { owner: 'A' });
    running.push(a);
    await a.start();
    await waitUntil(() => a.holder?.phase === 'running', 8_000, 'A holds');
    await settled(a, cluster);
    const fenceA = a.holder!.fence;
    // Another holder took a newer fence and seeded it (e.g. after A's lease lapsed in a GC pause).
    const newer = await new MemoryStateTransport(redis, KEYS).nextFence(Date.now());
    const models = (await import('../../src/read-models/transport.js')).MemoryModelsTransport;
    await new models(redis, KEYS).seedFence(newer, 3_600_000);
    cluster.update(RANK_COLL, cluster.liveDocs(RANK_COLL)[0].oid, { set: { 'metrics.roi': 77 } });
    await waitUntil(() => alerts.names.includes('read_models.lease_lost'), 8_000, 'fenced out');
    // A is still the only candidate: it takes the lease back under a newer fence and resumes.
    await waitUntil(() => a.holder?.phase === 'running' && a.holder.fence > newer, 8_000, 'A back with a newer fence');
    expect(a.holder!.fence).toBeGreaterThan(fenceA);
    await settled(a, cluster);
    expectModelEqualsCluster(a.store, cluster, RANK_COLL, 'rank');
    expectContiguous(streamEntries(redis));
  }, 30_000);

  it('redis-models flushed: the holder continues from memory in a new epoch; consumers switch without reloading', async () => {
    const cluster = seededCluster();
    const models = new MemoryRedis();
    const state = new MemoryRedis();
    const { runtime: a, alerts } = makeRuntime(models, cluster, { owner: 'A', stateRedis: state });
    const { runtime: c } = makeRuntime(models, cluster, { owner: 'C', role: 'server', stateRedis: state });
    running.push(a, c);
    await a.start();
    await waitUntil(() => a.holder?.phase === 'running', 8_000, 'A holds');
    await c.start();
    await settled(a, cluster);
    await waitUntil(() => c.store.pos.s === a.holder!.appended.s, 8_000, 'C follows');
    const reloads = c.consumer!.reloads;
    const epoch = a.holder!.epoch;
    const scans = cluster.scanCalls;

    models.flushAll();
    cluster.update(RANK_COLL, cluster.liveDocs(RANK_COLL)[3].oid, { set: { 'metrics.roi': 3.3 } });
    await waitUntil(() => alerts.names.includes('read_models.redis_flush'), 8_000, 'flush detected');
    await waitUntil(() => (a.holder?.epoch ?? 0) > epoch && a.holder?.phase === 'running', 8_000, 'continuation epoch');
    await settled(a, cluster);
    expect(cluster.scanCalls).toBe(scans); // no cold scan
    await waitUntil(() => c.store.pos.epoch === a.holder!.epoch && c.store.pos.s === a.holder!.appended.s, 8_000, 'C continues');
    expect(c.consumer!.reloads).toBe(reloads);
    expectModelEqualsCluster(c.store, cluster, RANK_COLL, 'rank');
    expectModelEqualsCluster(a.store, cluster, RANK_COLL, 'rank');
  }, 30_000);

  it('a fresh candidate with no model loads the manifest, catches up, and takes over (no cold scan)', async () => {
    const cluster = seededCluster();
    const redis = new MemoryRedis();
    const { runtime: a } = makeRuntime(redis, cluster, { owner: 'A' });
    running.push(a);
    await a.start();
    await waitUntil(() => a.holder?.phase === 'running', 8_000, 'A holds');
    await settled(a, cluster);
    const scans = cluster.scanCalls;
    await a.stop(); // a clean shutdown: flush + release
    for (let n = 0; n < 10; n++) cluster.update(RANK_COLL, cluster.liveDocs(RANK_COLL)[n].oid, { set: { 'metrics.feeApr': n } });
    const { runtime: d } = makeRuntime(redis, cluster, { owner: 'D' });
    running.push(d);
    await d.start();
    await waitUntil(() => d.holder?.phase === 'running', 8_000, 'D holds');
    await settled(d, cluster);
    expect(cluster.scanCalls).toBe(scans);
    expectModelEqualsCluster(d.store, cluster, RANK_COLL, 'rank');
    expectContiguous(streamEntries(redis));
    await sleep(10);
  }, 30_000);
});
