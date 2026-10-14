/*
 * Holder-side guards (design §2.4, §3.2, §3.5) the end-to-end replay does not
 * pin on its own:
 *  - a shard whose `_id`s are not all ObjectIds is never served;
 *  - a scan buffer that overflows during the cold scan replays the stream
 *    after its last buffered event — and still converges;
 *  - while a snapshot holds the store, merges, no-op checks and new
 *    dictionary ids read the appended-but-unapplied overlay;
 *  - apply-AFTER-append: an append the fence refuses never reaches the store;
 *  - a consumer whose holder went quiet is not caught up;
 *  - the holder stays caught up under sustained writes, judged by the age of
 *    its oldest unappended change (pending or in flight), not by emptiness.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { leafIndex } from '../../src/read-models/core/fields.js';
import type { ReadModelsRuntime } from '../../src/read-models/feeder/feeder.service.js';
import { MemoryModelsTransport, MemoryStateTransport } from '../../src/read-models/transport.js';
import { FakeCluster, poolDoc, positionDoc } from './fake-cluster.js';
import { expectModelEqualsCluster, KEYS, makeRuntime, MemoryRedis, POOLS_COLL, RANK_COLL, rng, settled, sleep, SpecAlerts, waitUntil } from './support.js';

const running: ReadModelsRuntime[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((r) => r.stop()));
});

function cluster(): FakeCluster {
  const c = new FakeCluster();
  c.t = Math.floor(Date.now() / 1000);
  for (let n = 0; n < 200; n++) c.insert(RANK_COLL, positionDoc(n));
  for (let n = 0; n < 40; n++) c.insert(POOLS_COLL, poolDoc(n));
  return c;
}

describe('holder guards', () => {
  it('a shard with non-ObjectId _ids is unsupported: no rows, alerted, the others serve', async () => {
    const c = cluster();
    c.badIds.add(POOLS_COLL);
    const { runtime, alerts } = makeRuntime(new MemoryRedis(), c, { owner: 'A' });
    running.push(runtime);
    await runtime.start();
    await waitUntil(() => runtime.holder?.phase === 'running', 8_000, 'running');
    await settled(runtime, c);
    expect(runtime.store.table('pools', '1:uniswap-v4')).toMatchObject({ state: 'unsupported', live: 0 });
    expect(alerts.names).toContain('read_models.id_type');
    expectModelEqualsCluster(runtime.store, c, RANK_COLL, 'rank');
    // Its events are ignored, not scanned again and again.
    c.update(POOLS_COLL, c.liveDocs(POOLS_COLL)[0].oid, { set: { 'metrics.tvlUsd': 1 } });
    await settled(runtime, c);
    expect(runtime.store.table('pools', '1:uniswap-v4')?.live).toBe(0);
    expect(alerts.names.filter((n) => n === 'read_models.shard_scan')).toEqual([]);
  }, 30_000);

  it('a cold-scan buffer overflow replays the stream after its last buffered event and still converges', async () => {
    const c = cluster();
    for (let n = 200; n < 700; n++) c.insert(RANK_COLL, positionDoc(n));
    const random = rng(5);
    const { runtime, alerts } = makeRuntime(new MemoryRedis(), c, {
      owner: 'A',
      // A slow scan (the bucket starts with one second of rate) and a buffer that fits a few rows.
      holder: { feeder: { scanDocsPerSec: 250, oplogWindowHintMs: 3_600_000, scanReadPreference: 'secondary', scanBatchSize: 25, scanBufferBytes: 6_000 } },
    });
    running.push(runtime);
    const started = runtime.start();
    for (let i = 0; i < 300; i++) {
      const docs = c.liveDocs(RANK_COLL);
      const doc = docs[Math.floor(random() * docs.length)];
      if (random() < 0.1) c.delete(RANK_COLL, doc.oid);
      else if (random() < 0.2) c.insert(RANK_COLL, positionDoc(5_000 + i));
      else c.update(RANK_COLL, doc.oid, { set: { 'metrics.underlyingValueUsd': i, owner: `0xo${i % 17}` } });
      await sleep(5);
    }
    await started;
    await waitUntil(() => runtime.holder?.phase === 'running', 20_000, 'running');
    await settled(runtime, c, 15_000);
    expect(alerts.names).toContain('read_models.scan_buffer_overflow');
    expectModelEqualsCluster(runtime.store, c, RANK_COLL, 'rank');
    expectModelEqualsCluster(runtime.store, c, POOLS_COLL, 'pools');
  }, 40_000);

  it('while the store is held (a snapshot encoding), a change and its reversal are both appended, with fresh dictionary ids', async () => {
    const c = cluster();
    const redis = new MemoryRedis();
    const { runtime } = makeRuntime(redis, c, { owner: 'A' });
    const { runtime: follower } = makeRuntime(redis, c, { owner: 'F', role: 'server' });
    running.push(runtime, follower);
    await runtime.start();
    await waitUntil(() => runtime.holder?.phase === 'running', 8_000, 'running');
    await follower.start();
    await settled(runtime, c);
    const oid = c.liveDocs(RANK_COLL)[5].oid;
    const original = c.latest(RANK_COLL, oid)!;
    runtime.store.hold(); // what a snapshot does while it encodes
    c.update(RANK_COLL, oid, { set: { owner: '0xheld-new-owner-1', 'metrics.underlyingValueUsd': 1 } });
    await settled(runtime, c);
    c.update(RANK_COLL, oid, { set: { owner: '0xheld-new-owner-2' } });
    await settled(runtime, c);
    c.update(RANK_COLL, oid, { set: { owner: original.owner, 'metrics.underlyingValueUsd': (original.metrics as { underlyingValueUsd: number }).underlyingValueUsd } });
    await settled(runtime, c);
    runtime.store.release();
    await sleep(50);
    expectModelEqualsCluster(runtime.store, c, RANK_COLL, 'rank');
    await waitUntil(() => follower.store.pos.s === runtime.holder!.appended.s, 8_000, 'the follower');
    expectModelEqualsCluster(follower.store, c, RANK_COLL, 'rank');
    const a = runtime.store.table('rank', '1:uniswap-v4')!.dict;
    const b = follower.store.table('rank', '1:uniswap-v4')!.dict;
    expect(b.size).toBe(a.size);
    expect(a.find('0xheld-new-owner-1')).not.toBe(a.find('0xheld-new-owner-2'));
  }, 30_000);

  it('apply AFTER append: a batch the fence refuses never reaches the holder’s store', async () => {
    const c = cluster();
    const redis = new MemoryRedis();
    let seenAtRefusal: unknown;
    let runtimeRef: ReadModelsRuntime | undefined;
    const oidBox: { oid?: string } = {};
    const alerts = new SpecAlerts((line) => {
      if (line.includes('read_models.lease_lost') && runtimeRef && oidBox.oid && seenAtRefusal === undefined) {
        const table = runtimeRef.store.table('rank', '1:uniswap-v4')!;
        seenAtRefusal = table.cellAt(table.liveSlotOf(oidBox.oid), leafIndex('rank', 'metrics.roi'));
      }
    });
    const { runtime } = makeRuntime(redis, c, { owner: 'A', alerts });
    runtimeRef = runtime;
    running.push(runtime);
    await runtime.start();
    await waitUntil(() => runtime.holder?.phase === 'running', 8_000, 'running');
    await settled(runtime, c);
    const oid = c.liveDocs(RANK_COLL)[3].oid;
    oidBox.oid = oid;
    const before = runtime.store.table('rank', '1:uniswap-v4')!.cellAt(runtime.store.table('rank', '1:uniswap-v4')!.liveSlotOf(oid), leafIndex('rank', 'metrics.roi'));
    // A newer holder's fence lands on redis-models; then a change arrives for A to append.
    const newer = await new MemoryStateTransport(redis, KEYS).nextFence(Date.now());
    await new MemoryModelsTransport(redis, KEYS).seedFence(newer, 3_600_000);
    c.update(RANK_COLL, oid, { set: { 'metrics.roi': 123.25 } });
    await waitUntil(() => seenAtRefusal !== undefined, 8_000, 'the refusal');
    expect(seenAtRefusal).toEqual(before);
  }, 30_000);

  it('stays caught up under sustained writes (the M10 rig read not ready 14% of the time while ~1.5 s behind)', async () => {
    const c = cluster();
    const redis = new MemoryRedis();
    const { runtime: a } = makeRuntime(redis, c, { owner: 'A' });
    running.push(a);
    await a.start();
    await waitUntil(() => a.readiness().rank.ready, 8_000, 'ready');
    let samples = 0;
    let notReady = 0;
    let pendingSeen = 0;
    let n = 1_000;
    const until = Date.now() + 2_500;
    while (Date.now() < until) {
      c.insert(RANK_COLL, positionDoc(n++));
      await sleep(20);
      samples++;
      if ((a.holder as unknown as { pending: Map<string, unknown> }).pending.size > 0) pendingSeen++;
      if (!a.readiness().rank.ready) notReady++;
    }
    expect(samples).toBeGreaterThan(50);
    expect(pendingSeen).toBeGreaterThan(0); // the old "pending must be empty" rule would have failed these
    expect(notReady).toBe(0);
  }, 30_000);

  it('a change waiting to be appended past the window (pending or a stuck append) is not caught up', async () => {
    const c = cluster();
    const redis = new MemoryRedis();
    const { runtime: a } = makeRuntime(redis, c, { owner: 'A' });
    running.push(a);
    await a.start();
    await waitUntil(() => a.readiness().rank.ready, 8_000, 'ready');
    const h = a.holder! as unknown as {
      caughtUp(now?: number): boolean;
      pending: Map<string, unknown>;
      pendingSince: number;
      inflight?: unknown;
      inflightSince: number;
      lastCa: number;
    };
    // Synchronous from here to the restore: no timer can run in between.
    const now = Date.now();
    h.lastCa = now;
    const saved = { pending: new Map(h.pending), pendingSince: h.pendingSince, inflight: h.inflight, inflightSince: h.inflightSince };
    h.pending.clear();
    h.inflight = undefined;
    expect(h.caughtUp(now)).toBe(true);
    h.pending.set('probe', {});
    h.pendingSince = now - 1_500;
    expect(h.caughtUp(now)).toBe(true); // young: inside the 2 s window
    h.pendingSince = now - 2_500;
    expect(h.caughtUp(now)).toBe(false); // old: an append that is not happening
    h.pending.clear();
    h.inflight = { rows: new Map(), attempts: 3 };
    h.inflightSince = now - 2_500;
    expect(h.caughtUp(now)).toBe(false); // an append retried past the window
    h.inflightSince = now - 100;
    expect(h.caughtUp(now)).toBe(true);
    h.pending.clear();
    for (const [k, v] of saved.pending) h.pending.set(k, v);
    h.pendingSince = saved.pendingSince;
    h.inflight = saved.inflight;
    h.inflightSince = saved.inflightSince;
  }, 30_000);

  it('a consumer is not caught up before it reads, nor once its holder has gone quiet', async () => {
    const c = cluster();
    const redis = new MemoryRedis();
    const { runtime: a } = makeRuntime(redis, c, { owner: 'A' });
    const { runtime: b } = makeRuntime(redis, c, { owner: 'B', role: 'server' });
    running.push(a, b);
    expect(b.readiness().rank.ready).toBe(false);
    await a.start();
    await waitUntil(() => a.holder?.phase === 'running', 8_000, 'running');
    await b.start();
    await waitUntil(() => b.readiness().rank.ready, 8_000, 'ready');
    await a.holder!.stop(); // the holder dies: no more entries, no lease renewals (nobody else can take it)
    await waitUntil(() => !b.readiness().rank.ready, 8_000, 'not caught up');
    expect(b.readiness().rank.reason).toBe('not_caught_up');
  }, 30_000);
});
