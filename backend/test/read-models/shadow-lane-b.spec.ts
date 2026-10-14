/*
 * Lane B — live data parity (design §7.1, P-R R4): the holder's model rows
 * against Mongo's documents at ONE clusterTime. The store here is a real R1
 * `ModelStore` / `ShardTable`; Mongo is a map of documents behind the
 * `DataParityReader` interface (the raw-command reader itself is pinned at the
 * bottom by the commands it sends).
 */
import mongoose from 'mongoose';
import { describe, expect, it, vi } from 'vitest';
import { shardKey, type ReadModelName } from '../../src/read-models/core/fields.js';
import { ModelStore } from '../../src/read-models/core/model-store.js';
import { encodeCells } from '../../src/read-models/core/row-store.js';
import { scanProjection } from '../../src/read-models/feeder/change-stream.js';
import { normalizeDoc } from '../../src/read-models/feeder/normalize.js';
import { AlertLog } from '../../src/read-models/status.js';
import {
  DataParityLane,
  LANE_B_CONFIRM_AFTER_MS,
  LANE_B_RESCAN_COOLDOWN_MS,
  MongoDataParityReader,
  parseCt,
  type ClusterTime,
  type DataParityReader,
  type DataParityShard,
} from '../../src/read-models/shadow/data-parity.js';

const CHAIN = 43114;
const PROTOCOL = 'uniswap-v4';
const KEY = shardKey(CHAIN, PROTOCOL);
const SHARD: DataParityShard = { coll: '43114_uniswap_v4_pools', model: 'pools', chainId: CHAIN, protocol: PROTOCOL };
const T0 = 1_791_000_000; // seconds

function poolDoc(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: new mongoose.Types.ObjectId(n.toString(16).padStart(24, '0')),
    chainId: CHAIN,
    protocol: PROTOCOL,
    poolId: `0x${n.toString(16).padStart(64, '0')}`,
    createdAtTimestamp: 1_700_000_000 + n,
    token0: { address: '0xaaa', symbol: 'AAA' },
    token1: { address: '0xbbb', symbol: 'BBB' },
    metrics: { tvlUsd: 1000 + n, volumeUsd24h: n, feesUsd24h: 0, feeApr: 0.1 },
    pricing: { source: 'subgraph', usedFallback: false },
    ...over,
  };
}

const hex = (doc: Record<string, unknown>) => (doc._id as mongoose.Types.ObjectId).toHexString();

/** Mongo as a map of documents; every read is "at" the requested clusterTime (the spec moves the truth itself). */
class MapReader implements DataParityReader {
  readonly docs = new Map<string, Record<string, unknown>>();
  readonly reads: Array<{ op: string; at: ClusterTime; n: number }> = [];
  fail?: Error;

  async byIds(_coll: string, _model: ReadModelName, oids: readonly string[], at: ClusterTime) {
    if (this.fail) throw this.fail;
    this.reads.push({ op: 'byIds', at, n: oids.length });
    return oids.map((oid) => this.docs.get(oid)).filter((d): d is Record<string, unknown> => Boolean(d));
  }

  async sampleIds(_coll: string, size: number, at: ClusterTime) {
    this.reads.push({ op: 'sample', at, n: size });
    return [...this.docs.keys()].slice(0, size);
  }

  async keyset(_coll: string, _model: ReadModelName, afterOid: string | null, limit: number, at: ClusterTime) {
    this.reads.push({ op: 'keyset', at, n: limit });
    return [...this.docs.keys()]
      .sort()
      .filter((oid) => afterOid === null || oid > afterOid)
      .slice(0, limit)
      .map((oid) => this.docs.get(oid)!);
  }
}

function harness(opts: { rows?: number; verify?: number; consistent?: boolean; holder?: boolean; alertLog?: AlertLog } = {}) {
  const store = new ModelStore(new Set<ReadModelName>(['pools']));
  const table = store.ensureTable('pools', KEY);
  const reader = new MapReader();
  for (let n = 1; n <= (opts.rows ?? 10); n++) {
    const doc = poolDoc(n);
    reader.docs.set(hex(doc), doc);
    table.upsert(hex(doc), encodeCells(table.leaves, normalizeDoc('pools', doc), (v) => table.dict.intern(v)));
  }
  table.state = 'ready';
  let now = T0 * 1000 + 1_000;
  store.pos = { ...store.pos, ct: `${T0}:1` };
  const alerts: Array<{ name: string; detail: string }> = [];
  const rescans: string[] = [];
  let pressure = false;
  const state = { consistent: opts.consistent ?? true, holder: opts.holder ?? true, scanning: false, session: 'f1:0' };
  const lane = new DataParityLane({
    source: () => (state.holder ? { store, consistent: state.consistent, scanning: state.scanning, session: state.session } : undefined),
    shards: () => [SHARD],
    reader,
    alert: (name, detail) => alerts.push({ name, detail }),
    ...(opts.alertLog ? { evidence: (name: string, detail: string) => opts.alertLog!.evidence(name, detail) } : {}),
    rescan: async (model, shard) => {
      rescans.push(`${model}|${shard}`);
    },
    pressure: () => pressure,
    verifyDocsPerSec: () => opts.verify ?? 0,
    now: () => now,
    random: () => 0.5,
  });
  return {
    store,
    table,
    reader,
    lane,
    alerts,
    rescans,
    state,
    advance: (ms: number) => {
      now += ms;
      // the stream keeps the store's clusterTime current
      store.pos = { ...store.pos, ct: `${Math.floor(now / 1000) - 1}:1` };
    },
    setPressure: (on: boolean) => {
      pressure = on;
    },
    /** Change the model's row (as an applied delta would). */
    setModel: (doc: Record<string, unknown>) => table.upsert(hex(doc), encodeCells(table.leaves, normalizeDoc('pools', doc), (v) => table.dict.intern(v))),
  };
}

describe('lane B: exact checks', () => {
  it('a model that equals Mongo has no diffs, and every row counts as a match', async () => {
    const h = harness();
    const diffs = await h.lane.checkExact(SHARD, [...h.reader.docs.keys()]);
    expect(diffs).toEqual([]);
    expect(h.lane.meter.matches).toBe(10);
    // read AT the store's clusterTime
    expect(h.reader.reads[0].at).toEqual(parseCt(h.store.pos.ct));
  });

  it('names the differing leaves with their normalised values', async () => {
    const h = harness();
    const doc = poolDoc(3, { metrics: { tvlUsd: 5, volumeUsd24h: 3, feesUsd24h: 0, feeApr: 0.1 } });
    h.reader.docs.set(hex(doc), doc);
    const diffs = await h.lane.checkExact(SHARD, [hex(doc)]);
    expect(diffs).toEqual([{ kind: 'row', model: 'pools', shard: KEY, oid: hex(doc), ct: h.store.pos.ct, fields: [{ leaf: 'metrics.tvlUsd', engine: '1003', mongo: '5' }] }]);
  });

  it('a row Mongo has and the model lacks is `missing`; one the model holds and Mongo deleted is `extra`', async () => {
    const h = harness();
    const added = poolDoc(99);
    h.reader.docs.set(hex(added), added);
    const gone = poolDoc(2);
    h.reader.docs.delete(hex(gone));
    const diffs = await h.lane.checkExact(SHARD, [hex(added), hex(gone)]);
    expect(diffs?.map((d) => d.kind).sort()).toEqual(['extra', 'missing']);
  });

  it('does not check while the holder blocks rows on a repair, off the holder, or past the snapshot window', async () => {
    const h = harness({ consistent: false });
    expect(await h.lane.checkExact(SHARD, [...h.reader.docs.keys()].slice(0, 1))).toBeUndefined();
    h.state.consistent = true;
    h.state.holder = false;
    expect(await h.lane.checkExact(SHARD, [...h.reader.docs.keys()].slice(0, 1))).toBeUndefined();
    h.state.holder = true;
    h.store.pos = { ...h.store.pos, ct: `${T0 - 300}:1` }; // 5 min behind "now"
    expect(await h.lane.checkExact(SHARD, [...h.reader.docs.keys()].slice(0, 1))).toBeUndefined();
    expect(h.lane.meter.skipped).toMatchObject({ repair_pending: 1, not_holder: 1, window: 1 });
    expect(h.reader.reads).toHaveLength(0);
  });

  it('counts a snapshot the server cannot serve as a skip, not a diff', async () => {
    const h = harness();
    h.reader.fail = Object.assign(new Error('Read timestamp is older than the oldest available timestamp'), { code: 239, codeName: 'SnapshotTooOld' });
    expect(await h.lane.checkExact(SHARD, [...h.reader.docs.keys()].slice(0, 1))).toBeUndefined();
    expect(h.lane.meter.skipped.snapshot_too_old).toBe(1);
    expect(h.lane.meter.diffs).toBe(0);
  });
});

describe('lane B: samples, confirmation, rescan', () => {
  it('a difference seen twice ≥ 5 s apart is a confirmed data_diff with a rescan request (once an hour per shard)', async () => {
    const h = harness();
    const bad = poolDoc(4, { pricing: { source: 'subgraph', usedFallback: true } });
    h.reader.docs.set(hex(bad), bad);
    await h.lane.tick(); // samples: model rows + Mongo docs → suspect
    expect(h.alerts).toHaveLength(0);
    h.advance(LANE_B_CONFIRM_AFTER_MS - 1);
    await h.lane.confirm();
    expect(h.alerts).toHaveLength(0); // not yet due
    h.advance(1);
    await h.lane.confirm();
    expect(h.alerts.map((a) => a.name)).toEqual(['read_models.data_diff']);
    const line = JSON.parse(h.alerts[0].detail);
    expect(line).toMatchObject({ lane: 'B', kind: 'row', model: 'pools', shard: KEY, oid: hex(bad), fields: [{ leaf: 'pricing.usedFallback', engine: 'false', mongo: 'true' }] });
    expect(h.rescans).toEqual([`pools|${KEY}`]);
    expect(h.lane.meter.diffs).toBe(1);
    expect(h.lane.meter.diffsByModel.pools).toBe(1);
    // a second confirmed diff on the same shard within the hour: alert, no second rescan
    const bad2 = poolDoc(5, { pricing: { source: 'x', usedFallback: false } });
    h.reader.docs.set(hex(bad2), bad2);
    h.advance(61_000);
    await h.lane.tick();
    h.advance(LANE_B_CONFIRM_AFTER_MS);
    await h.lane.confirm();
    expect(h.lane.meter.diffs).toBe(2);
    expect(h.rescans).toHaveLength(1);
    h.advance(LANE_B_RESCAN_COOLDOWN_MS);
    const bad3 = poolDoc(6, { pricing: { source: 'y', usedFallback: false } });
    h.reader.docs.set(hex(bad3), bad3);
    await h.lane.tick();
    h.advance(LANE_B_CONFIRM_AFTER_MS);
    await h.lane.confirm();
    expect(h.rescans).toHaveLength(2);
  });

  it('a difference gone by the re-check (the model caught up) is transient: no alert, no rescan', async () => {
    const h = harness();
    const newer = poolDoc(7, { metrics: { tvlUsd: 1, volumeUsd24h: 7, feesUsd24h: 0, feeApr: 0.1 } });
    h.reader.docs.set(hex(newer), newer);
    await h.lane.tick();
    h.setModel(newer); // the next delta lands
    h.advance(LANE_B_CONFIRM_AFTER_MS);
    await h.lane.confirm();
    expect(h.alerts).toEqual([]);
    expect(h.rescans).toEqual([]);
    expect(h.lane.meter.transient).toBe(1);
  });

  it('samples at most once a minute', async () => {
    const h = harness();
    await h.lane.sample();
    const reads = h.reader.reads.length;
    h.advance(30_000);
    await h.lane.sample();
    expect(h.reader.reads.length).toBe(reads);
    h.advance(30_000);
    await h.lane.sample();
    expect(h.reader.reads.length).toBeGreaterThan(reads);
  });
});

describe('lane B: the verification scan', () => {
  it('walks every row in _id order in paced batches, counts the pass, and starts over', async () => {
    const h = harness({ rows: 10, verify: 2 }); // batch = ceil(2 × 4) = 8
    await h.lane.verify();
    expect(h.reader.reads.filter((r) => r.op === 'keyset')).toHaveLength(1);
    // paced: 8 docs at 2/s → 4 s before the next batch
    h.advance(3_999);
    await h.lane.verify();
    expect(h.reader.reads.filter((r) => r.op === 'keyset')).toHaveLength(1);
    h.advance(1);
    await h.lane.verify();
    const status = h.lane.status().verify.shards[`pools|${KEY}`];
    expect(status).toMatchObject({ verified: 10, batches: 2, passes: 1, inPass: false });
    expect(h.alerts).toEqual([]);
  });

  it('re-checks a disagreeing row exactly and queues it for confirmation', async () => {
    const h = harness({ rows: 5, verify: 100 });
    const bad = poolDoc(2, { token1: { address: '0xbbb', symbol: 'XXX' } });
    h.reader.docs.set(hex(bad), bad);
    await h.lane.verify();
    expect(h.reader.reads.filter((r) => r.op === 'byIds')).toHaveLength(1);
    h.advance(LANE_B_CONFIRM_AFTER_MS);
    await h.lane.confirm();
    expect(JSON.parse(h.alerts[0].detail).fields).toEqual([{ leaf: 'token1.symbol', engine: '"BBB"', mongo: '"XXX"' }]);
  });

  it('is off at 0 docs/s, paused / resumed / re-paced by a VERIFY scan command, and yields to user-read pressure', async () => {
    const off = harness({ verify: 0 });
    await off.lane.verify();
    expect(off.reader.reads).toEqual([]);
    const h = harness({ verify: 100 });
    // A feeder-scan command (the default target) never reaches lane B.
    h.lane.applyScanCommand({ action: 'pause' });
    h.lane.applyScanCommand({ action: 'pace', docsPerSec: 4_000, target: 'feeder' });
    expect(h.lane.status().verify).toMatchObject({ paused: false, docsPerSec: 100 });
    h.lane.applyScanCommand({ action: 'pause', target: 'verify' });
    await h.lane.verify();
    expect(h.reader.reads).toEqual([]);
    h.lane.applyScanCommand({ action: 'resume', docsPerSec: 9_999, target: 'verify' });
    expect(h.lane.status().verify.docsPerSec).toBe(5_000);
    h.setPressure(true);
    await h.lane.verify();
    expect(h.reader.reads).toEqual([]);
    expect(h.lane.meter.skipped.pressure).toBe(1);
    h.setPressure(false);
    h.advance(1_000);
    await h.lane.verify();
    expect(h.reader.reads.filter((r) => r.op === 'keyset')).toHaveLength(1);
  });

  it('a resume clears a pace override, and so does a new holder session', async () => {
    const h = harness({ verify: 100 });
    h.lane.applyScanCommand({ action: 'pace', docsPerSec: 4_000, target: 'verify' });
    expect(h.lane.status().verify.docsPerSec).toBe(4_000);
    h.lane.applyScanCommand({ action: 'resume', target: 'verify' });
    expect(h.lane.status().verify.docsPerSec).toBe(100);
    h.lane.applyScanCommand({ action: 'pause', docsPerSec: 4_000, target: 'verify' });
    await h.lane.tick();
    expect(h.lane.status().verify).toMatchObject({ paused: true, docsPerSec: 4_000 });
    h.state.session = 'f2:5';
    await h.lane.tick();
    expect(h.lane.status().verify).toMatchObject({ paused: false, docsPerSec: 100 });
  });

  it('yields to the feeder’s own scan (one scan at a time on the secondary)', async () => {
    const h = harness({ verify: 100 });
    h.state.scanning = true;
    await h.lane.verify();
    expect(h.reader.reads).toEqual([]);
    expect(h.lane.meter.skipped.feeder_scanning).toBe(1);
    h.state.scanning = false;
    h.advance(5_000);
    await h.lane.verify();
    expect(h.reader.reads.filter((r) => r.op === 'keyset')).toHaveLength(1);
  });

  it('logs EVERY confirmed row (evidence lines are not throttled per shard)', async () => {
    const lines: string[] = [];
    const h = harness({ rows: 6, verify: 100, alertLog: new AlertLog({ warn: (l: string) => lines.push(l) }, () => T0 * 1000) });
    for (const n of [2, 3, 4]) {
      const bad = poolDoc(n, { token1: { address: '0xbbb', symbol: `X${n}` } });
      h.reader.docs.set(hex(bad), bad);
    }
    await h.lane.verify();
    h.advance(LANE_B_CONFIRM_AFTER_MS);
    await h.lane.confirm();
    expect(lines.filter((l) => l.startsWith('[alert] read_models.data_diff'))).toHaveLength(3);
  });

  it('skips a shard that is not ready (scanning) and does nothing off the holder', async () => {
    const h = harness({ verify: 100 });
    h.table.state = 'scanning';
    await h.lane.verify();
    h.state.holder = false;
    h.table.state = 'ready';
    await h.lane.verify();
    expect(h.reader.reads).toEqual([]);
  });
});

describe('lane B: the raw-command reader', () => {
  it('reads by _id, samples and walks keysets with readConcern snapshot at the exact clusterTime, on the given read preference', async () => {
    const commands: Array<{ command: Record<string, unknown>; options?: Record<string, unknown> }> = [];
    const db = {
      command: vi.fn(async (command: Record<string, unknown>, options?: Record<string, unknown>) => {
        commands.push({ command, options });
        return { cursor: { firstBatch: [{ _id: new mongoose.Types.ObjectId('0000000000000000000000aa') }] } };
      }),
    };
    const pref = { mode: 'secondary' };
    const reader = new MongoDataParityReader(() => db, pref);
    const at = { t: 1_791_000_000, i: 7 };
    await reader.byIds('c', 'pools', ['0000000000000000000000aa'], at);
    expect(await reader.sampleIds('c', 3, at)).toEqual(['0000000000000000000000aa']);
    await reader.keyset('c', 'rank', '0000000000000000000000aa', 50, at);
    for (const { command, options } of commands) {
      const rc = command.readConcern as { level: string; atClusterTime: { getHighBits(): number; getLowBits(): number } };
      expect(rc.level).toBe('snapshot');
      expect([rc.atClusterTime.getHighBits(), rc.atClusterTime.getLowBits()]).toEqual([at.t, at.i]);
      expect(options).toEqual({ readPreference: pref });
      expect(command.maxTimeMS).toBe(10_000);
    }
    expect(commands[0].command).toMatchObject({ find: 'c', projection: scanProjection('pools'), singleBatch: true });
    expect(commands[1].command).toMatchObject({ aggregate: 'c', pipeline: [{ $sample: { size: 3 } }, { $project: { _id: 1 } }] });
    expect(commands[2].command).toMatchObject({ find: 'c', sort: { _id: 1 }, hint: { _id: 1 }, limit: 50, projection: scanProjection('rank') });
    expect(String((commands[2].command.filter as { _id: { $gt: unknown } })._id.$gt)).toBe('0000000000000000000000aa');
  });

  it('refuses to read without a connection', async () => {
    await expect(new MongoDataParityReader(() => undefined, 'secondary').byIds('c', 'pools', [], { t: 1, i: 0 })).rejects.toThrow(/no Mongo connection/);
  });
});
