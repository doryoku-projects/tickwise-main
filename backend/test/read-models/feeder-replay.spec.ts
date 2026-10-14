/*
 * The feeder end to end against a simulated replica set (design §3.2–§3.4):
 * a cold scan racing concurrent writes on two secondaries at different lags,
 * the stream opened at T0 and coalesced into the scan buffer, catch-up,
 * snapshot #1, live batches — the final model must equal the cluster's
 * documents, normalised, row for row, cell for cell; and a consumer replica
 * that loads the snapshot and follows the stream must hold the same model.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { leafIndex } from '../../src/read-models/core/fields.js';
import type { ReadModelsRuntime } from '../../src/read-models/feeder/feeder.service.js';
import { FakeCluster, poolDoc, positionDoc } from './fake-cluster.js';
import { expectModelEqualsCluster, makeRuntime, MemoryRedis, POOLS_COLL, RANK_COLL, rng, settled, sleep, SpecAlerts, waitUntil } from './support.js';

const running: ReadModelsRuntime[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((r) => r.stop()));
});

function newCluster(seed: number, startT = Math.floor(Date.now() / 1000)): { cluster: FakeCluster; rank: string[]; pools: string[] } {
  const cluster = new FakeCluster();
  cluster.t = startT;
  cluster.random = rng(seed);
  const rank: string[] = [];
  const pools: string[] = [];
  for (let n = 0; n < 240; n++) rank.push(cluster.insert(RANK_COLL, positionDoc(n)));
  for (let n = 0; n < 80; n++) pools.push(cluster.insert(POOLS_COLL, poolDoc(n)));
  return { cluster, rank, pools };
}

/** One random write, the shapes the sync makes (whole subtrees) and the fee refresh makes (dotted leaves). */
function randomWrite(cluster: FakeCluster, random: () => number, rank: string[], pools: string[]): void {
  const r = random();
  const pick = (list: string[]) => list[Math.floor(random() * list.length)];
  const live = (coll: string, list: string[]) => {
    for (let tries = 0; tries < 10; tries++) {
      const oid = pick(list);
      if (cluster.latest(coll, oid)) return oid;
    }
    return undefined;
  };
  if (r < 0.1) {
    rank.push(cluster.insert(RANK_COLL, positionDoc(1_000 + Math.floor(random() * 9_000))));
  } else if (r < 0.15) {
    const oid = live(RANK_COLL, rank);
    if (oid) cluster.delete(RANK_COLL, oid);
  } else if (r < 0.45) {
    const oid = live(RANK_COLL, rank);
    if (oid) cluster.update(RANK_COLL, oid, { set: { metrics: positionDoc(Math.floor(random() * 500)).metrics, updatedAt: new Date() } });
  } else if (r < 0.65) {
    const oid = live(RANK_COLL, rank);
    if (oid) cluster.update(RANK_COLL, oid, { set: { 'metrics.underlyingValueUsd': Math.round(random() * 1e5) / 100, 'metrics.feeApr': random() < 0.1 ? Number.NaN : random() } });
  } else if (r < 0.7) {
    const oid = live(RANK_COLL, rank);
    if (oid) cluster.update(RANK_COLL, oid, { unset: ['metrics.roi'] });
  } else if (r < 0.75) {
    const oid = live(RANK_COLL, rank);
    if (oid) cluster.replace(RANK_COLL, oid, positionDoc(Math.floor(random() * 500), { owner: `0xreplaced${Math.floor(random() * 10)}` }));
  } else if (r < 0.8) {
    const oid = live(RANK_COLL, rank);
    if (oid) cluster.update(RANK_COLL, oid, { set: { isActive: random() < 0.5, poolStats: { tvlUsd: random() * 1e6 } } });
  } else if (r < 0.85) {
    pools.push(cluster.insert(POOLS_COLL, poolDoc(500 + Math.floor(random() * 500))));
  } else if (r < 0.97) {
    const oid = live(POOLS_COLL, pools);
    if (oid) cluster.update(POOLS_COLL, oid, { set: { metrics: { tvlUsd: random() < 0.2 ? 0 : random() * 1e7, volumeUsd24h: random() * 1e5, feesUsd24h: random() * 1e3, feeApr: random() } } });
  } else {
    const oid = live(POOLS_COLL, pools);
    if (oid) cluster.delete(POOLS_COLL, oid);
  }
}

describe('feeder replay (simulated replica set)', () => {
  for (const seed of [1, 2, 3]) {
    it(`cold scan racing writes, then live: the model equals Mongo (seed ${seed})`, async () => {
      const { cluster, rank, pools } = newCluster(seed);
      const random = rng(seed * 101);
      const redis = new MemoryRedis();
      const { runtime: a, alerts } = makeRuntime(redis, cluster, { owner: 'A' });
      running.push(a);
      const started = a.start();
      // Writes DURING the cold scan (inserts, deletes, subtree replaces, dotted leaves, unsets).
      for (let i = 0; i < 300; i++) {
        randomWrite(cluster, random, rank, pools);
        if (i % 10 === 0) await sleep(2);
      }
      await started;
      await waitUntil(() => a.holder?.phase === 'running', 8_000, 'the cold build');
      // Writes in live mode.
      for (let i = 0; i < 300; i++) {
        randomWrite(cluster, random, rank, pools);
        if (i % 20 === 0) await sleep(2);
      }
      await settled(a, cluster);
      expectModelEqualsCluster(a.store, cluster, RANK_COLL, 'rank');
      expectModelEqualsCluster(a.store, cluster, POOLS_COLL, 'pools');
      expect(alerts.names).toContain('read_models.cold_scan_done');
      expect(a.store.table('rank', '1:uniswap-v4')?.state).toBe('ready');

      // A consumer replica (P2 api role): snapshot + stream → the same model.
      const { runtime: b } = makeRuntime(redis, cluster, { role: 'server', owner: 'B' });
      running.push(b);
      await b.start();
      await waitUntil(() => b.store.pos.s === a.holder!.appended.s && b.store.pos.epoch === a.holder!.epoch, 8_000, 'the consumer to catch up');
      expectModelEqualsCluster(b.store, cluster, RANK_COLL, 'rank');
      expectModelEqualsCluster(b.store, cluster, POOLS_COLL, 'pools');
      // Dictionaries are identical replica to replica (same ids, same order).
      const da = a.store.table('rank', '1:uniswap-v4')!.dict;
      const db = b.store.table('rank', '1:uniswap-v4')!.dict;
      expect(db.size).toBe(da.size);
      for (let id = 0; id < da.size; id++) expect(db.get(id)).toBe(da.get(id));
      await waitUntil(() => b.readiness().rank.ready, 5_000, `consumer readiness (${JSON.stringify({ reason: b.readiness().rank.reason })})`);
    }, 30_000);
  }

  it('a stream member that always trails the newest majority point still confirms (ca keeps moving)', async () => {
    const { cluster, rank, pools } = newCluster(29);
    const random = rng(29);
    const redis = new MemoryRedis();
    const { runtime } = makeRuntime(redis, cluster, { owner: 'A' });
    running.push(runtime);
    await runtime.start();
    await waitUntil(() => runtime.holder?.phase === 'running', 8_000, 'running');
    // Continuous writes, the stream's member 3 increments behind the majority point at every reading.
    cluster.streamLag = 3;
    const confirmsBefore = runtime.holder!.lastCa;
    const until = Date.now() + 1_500;
    while (Date.now() < until) {
      randomWrite(cluster, random, rank, pools);
      await sleep(3);
    }
    expect(runtime.holder!.lastCa).toBeGreaterThan(confirmsBefore);
    expect(Date.now() - runtime.holder!.lastCa).toBeLessThan(1_500);
    cluster.streamLag = 0;
    await settled(runtime, cluster);
    expectModelEqualsCluster(runtime.store, cluster, RANK_COLL, 'rank');
  }, 30_000);

  it('scans never read older than T0, even on a secondary far behind (majority + afterClusterTime)', async () => {
    const { cluster, rank } = newCluster(31);
    // One secondary 60 increments behind; every scan batch picks a member at random.
    cluster.memberLags = [0, 60];
    // Writes just before the feeder starts (before T0): a scan that read older than T0 would miss them,
    // and the stream (opened AT T0) would never deliver them.
    for (const oid of rank.slice(0, 120)) cluster.update(RANK_COLL, oid, { set: { 'metrics.underlyingValueUsd': 777 } });
    const { runtime } = makeRuntime(new MemoryRedis(), cluster, { owner: 'A' });
    running.push(runtime);
    await runtime.start();
    await waitUntil(() => runtime.holder?.phase === 'running', 8_000, 'running');
    await settled(runtime, cluster);
    expectModelEqualsCluster(runtime.store, cluster, RANK_COLL, 'rank');
  }, 30_000);

  it('no-op updates are dropped before they reach the stream', async () => {
    const { cluster, rank } = newCluster(7);
    const redis = new MemoryRedis();
    const { runtime } = makeRuntime(redis, cluster, { owner: 'A' });
    running.push(runtime);
    await runtime.start();
    await waitUntil(() => runtime.holder?.phase === 'running', 8_000, 'running');
    await settled(runtime, cluster);
    const s = runtime.holder!.appended.s;
    const noopsBefore = runtime.meter.totals.noops;
    const rowsBefore = runtime.meter.totals.batchRows;
    // Re-$set the same metrics object: an update event whose normalised state is unchanged.
    for (const oid of rank.slice(0, 20)) cluster.update(RANK_COLL, oid, { set: { metrics: cluster.latest(RANK_COLL, oid)!.metrics, updatedAt: new Date() } });
    await settled(runtime, cluster);
    await sleep(100);
    // The 20 unchanged rows were dropped as no-ops (no batch carried them).
    expect(runtime.meter.totals.noops - noopsBefore).toBe(20);
    expect(runtime.meter.totals.batchRows - rowsBefore).toBe(0);
    expect(runtime.holder!.appended.s).toBeGreaterThan(s);
    expectModelEqualsCluster(runtime.store, cluster, RANK_COLL, 'rank');
  }, 30_000);

  it('a scan miss (an update for a row the scan never returned) is repaired, alerted and the shard rescanned', async () => {
    const { cluster, rank } = newCluster(11);
    const missed = rank[17];
    cluster.scanSkips.add(missed);
    cluster.findOneDelayMs = 150; // the repair answer arrives after live changes have queued up
    const redis = new MemoryRedis();
    // The miss is transient: once the repair fires, the next scan sees the row.
    const alerts = new SpecAlerts((line) => {
      if (line.includes('read_models.repair ')) cluster.scanSkips.clear();
    });
    // A slow scan (100 docs/s after the bucket's first second), so the update below lands mid-scan.
    const { runtime } = makeRuntime(redis, cluster, {
      owner: 'A',
      alerts,
      holder: { feeder: { scanDocsPerSec: 100, oplogWindowHintMs: 3_600_000, scanReadPreference: 'secondary', scanBatchSize: 40, scanBufferBytes: 64 * 1024 * 1024 } },
    });
    running.push(runtime);
    const started = runtime.start();
    // While the scan runs (after T0), the missed row is updated (dotted leaf: no full state in the event)…
    await waitUntil(() => cluster.scanCalls > 0, 8_000, 'the scan to start');
    cluster.update(RANK_COLL, missed, { set: { 'metrics.underlyingValueUsd': 4242 } });
    // …and other rows keep changing, so live `changes` messages queue behind the catch-up while
    // it waits for the repair: the repair's answer must not wait behind them.
    let writing = true;
    const writer = (async () => {
      for (let i = 0; writing; i++) {
        cluster.update(RANK_COLL, rank[(i % 100) + 50], { set: { 'metrics.feeApr': i } });
        await sleep(3);
      }
    })();
    await started;
    try {
      await waitUntil(() => runtime.holder?.phase === 'running', 8_000, 'running');
      await waitUntil(() => alerts.names.includes('read_models.repair'), 8_000, 'the repair alert');
    } finally {
      writing = false;
      await writer;
    }
    await waitUntil(() => alerts.names.filter((n) => n === 'read_models.shard_scan').length >= 1, 8_000, 'the shard rescan');
    await waitUntil(() => runtime.store.table('rank', '1:uniswap-v4')?.state === 'ready', 8_000, 'the rescan to finish');
    await settled(runtime, cluster);
    expectModelEqualsCluster(runtime.store, cluster, RANK_COLL, 'rank');
    const table = runtime.store.table('rank', '1:uniswap-v4')!;
    expect(table.cellAt(table.liveSlotOf(missed), leafIndex('rank', 'metrics.underlyingValueUsd'))).toBe(4242);
  }, 30_000);

  it('a collection first seen in the stream gets its own shard scan before it serves', async () => {
    const { cluster } = newCluster(13);
    const redis = new MemoryRedis();
    const { runtime, alerts } = makeRuntime(redis, cluster, { owner: 'A', modes: { rank: 'shadow', pools: 'off' } });
    running.push(runtime);
    await runtime.start();
    await waitUntil(() => runtime.holder?.phase === 'running', 8_000, 'running');
    expect(runtime.store.table('pools', '1:uniswap-v4')).toBeUndefined();
    // Pools turned on at run time (the kill switch raised): its shard is scanned in-epoch.
    await runtime.applyModes({ rank: 'shadow', pools: 'shadow' });
    await waitUntil(() => runtime.store.table('pools', '1:uniswap-v4')?.state === 'ready', 8_000, 'the pools shard scan');
    await settled(runtime, cluster);
    expectModelEqualsCluster(runtime.store, cluster, POOLS_COLL, 'pools');
    expect(alerts.names).toContain('read_models.shard_scan');
  }, 30_000);

  it('a dropped shard collection: its rows are reset through the stream', async () => {
    const { cluster } = newCluster(17);
    const redis = new MemoryRedis();
    const { runtime } = makeRuntime(redis, cluster, { owner: 'A' });
    running.push(runtime);
    await runtime.start();
    await waitUntil(() => runtime.holder?.phase === 'running', 8_000, 'running');
    await settled(runtime, cluster);
    cluster.drop(POOLS_COLL);
    await settled(runtime, cluster);
    await waitUntil(() => runtime.store.table('pools', '1:uniswap-v4')?.live === 0, 8_000, 'the reset');
    expect(runtime.store.table('pools', '1:uniswap-v4')?.state).toBe('ready');
  }, 30_000);

  it('history lost (the resume point left the oplog) cold-scans into a new epoch', async () => {
    const nowT = Math.floor(Date.now() / 1000);
    // The model's resume point is two hours old…
    const { cluster } = newCluster(19, nowT - 7_200);
    const redis = new MemoryRedis();
    const { runtime, alerts } = makeRuntime(redis, cluster, { owner: 'A' });
    running.push(runtime);
    await runtime.start();
    await waitUntil(() => runtime.holder?.phase === 'running', 8_000, 'running');
    await settled(runtime, cluster);
    const epoch = runtime.holder!.epoch;
    // …the cluster moves on and the oplog only keeps the last hour.
    cluster.t = nowT;
    cluster.oldestRetained = { t: nowT - 3_600, i: 0 };
    cluster.update(RANK_COLL, cluster.liveDocs(RANK_COLL)[0].oid, { set: { 'metrics.roi': 9 } });
    await runtime.applyModes({ rank: 'shadow', pools: 'off' }); // restarts the worker: resume after the old token
    await waitUntil(() => alerts.names.includes('read_models.history_lost'), 8_000, 'history lost');
    await waitUntil(() => (runtime.holder?.epoch ?? 0) > epoch && runtime.holder?.phase === 'running', 10_000, 'the new epoch');
    await settled(runtime, cluster);
    expectModelEqualsCluster(runtime.store, cluster, RANK_COLL, 'rank');
    expect(runtime.store.table('pools', '1:uniswap-v4')).toBeUndefined();
  }, 30_000);

  it('an oplog shorter than the hint refuses to start the feeder (fail closed)', async () => {
    const { cluster } = newCluster(23);
    cluster.oldestRetained = { t: Math.floor(Date.now() / 1000) - 60, i: 0 }; // only a minute of oplog
    const redis = new MemoryRedis();
    const { runtime, alerts } = makeRuntime(redis, cluster, { owner: 'A' });
    running.push(runtime);
    await runtime.start();
    await waitUntil(() => alerts.names.includes('read_models.oplog_too_short'), 8_000, 'oplog_too_short');
    await waitUntil(() => runtime.phase === 'consumer', 2_000, 'demotion');
    expect(runtime.readiness().rank.ready).toBe(false);
    expect(cluster.scanCalls).toBe(0); // no scan ran
  }, 30_000);
});
