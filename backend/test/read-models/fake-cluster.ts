/*
 * A simulated replica set for the read-model specs: document version history
 * by cluster time, an oplog of change events, two "secondaries" at different
 * majority lags, and a change stream over the oplog — implementing the
 * feeder's `FeederSource`, so `FeederCore` runs against it unmodified.
 *
 * Semantics modelled (design §1 F4, §3.2):
 *  - every write gets the next cluster time; a change stream delivers events
 *    in cluster-time order; `startAtOperationTime` includes events AT that
 *    time, `startAfter` a token excludes it; a start point older than the
 *    retained oplog throws ChangeStreamHistoryLost (286);
 *  - a `majority` read after `afterClusterTime` on a member answers at
 *    max(afterClusterTime, that member's majority point) — never older;
 *  - an update's description: `$set` of a top-level field → `updatedFields`
 *    carries the whole value; a dotted `$set` → the dotted key; `$unset` →
 *    `removedFields`.
 */
import mongoose from 'mongoose';
import { compareTimes, type ClusterTime } from '../../src/read-models/feeder/resume-token.js';
import type { FeederSource, StreamHandle } from '../../src/read-models/feeder/source.js';
import type { IdProbe } from '../../src/read-models/feeder/messages.js';
import type { TrimLevel } from '../../src/read-models/feeder/change-stream.js';
import type { ReadModelName } from '../../src/read-models/core/fields.js';

const { ObjectId } = mongoose.mongo;
type Doc = Record<string, unknown>;

interface Version {
  ct: ClusterTime;
  doc: Doc | null;
}

interface OplogEvent {
  ct: ClusterTime;
  idx: number;
  token: string;
  event: Doc;
}

const hex8 = (n: number) => (n >>> 0).toString(16).padStart(8, '0');

export function tokenFor(ct: ClusterTime, idx: number): string {
  return `82${hex8(ct.t)}${hex8(ct.i)}${hex8(idx)}`;
}

function idxOf(token: string): number {
  return Number.parseInt(token.slice(18, 26), 16);
}

/** Deep copy of plain objects / arrays; ObjectIds and Dates are kept (structuredClone would strip their prototypes). */
function clone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof ObjectId || value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
  const out: Doc = {};
  for (const [key, item] of Object.entries(value as Doc)) out[key] = clone(item);
  return out as T;
}

function setPath(doc: Doc, path: string, value: unknown): void {
  const segs = path.split('.');
  let at: Doc = doc;
  for (let i = 0; i < segs.length - 1; i++) {
    const next = at[segs[i]];
    if (!next || typeof next !== 'object') at[segs[i]] = {};
    at = at[segs[i]] as Doc;
  }
  at[segs[segs.length - 1]] = value;
}

function unsetPath(doc: Doc, path: string): void {
  const segs = path.split('.');
  let at: Doc | undefined = doc;
  for (let i = 0; i < segs.length - 1 && at; i++) at = at[segs[i]] as Doc | undefined;
  if (at && typeof at === 'object') delete at[segs[segs.length - 1]];
}

export class FakeCluster implements FeederSource {
  /** Current cluster time. */
  t = 1_790_000_000;
  i = 0;
  private idx = 0;
  private readonly colls = new Map<string, Map<string, Version[]>>();
  readonly oplog: OplogEvent[] = [];
  /** Oplog entries older than this are gone (history lost). */
  oldestRetained: ClusterTime = { t: 0, i: 0 };
  /** Majority lag of each simulated secondary, in cluster-time increments. */
  memberLags = [0, 3];
  /** The change stream's member trails the latest write by this many increments. */
  streamLag = 0;
  /** Fault injection: oids a scan never returns (a "scan miss"). */
  readonly scanSkips = new Set<string>();
  /** Collections whose ends are not ObjectIds (`_id` probe answers bad). */
  readonly badIds = new Set<string>();
  closed = false;
  scanCalls = 0;
  /** A repair read takes this long (ms). */
  findOneDelayMs = 0;
  random: () => number = Math.random;

  now(): ClusterTime {
    return { t: this.t, i: this.i };
  }

  private nextTime(): ClusterTime {
    this.i++;
    if (this.i > 50) {
      this.t++;
      this.i = 1;
    }
    return { t: this.t, i: this.i };
  }

  /** Advance the clock without a write (the periodic no-op writer). */
  idle(): ClusterTime {
    return this.nextTime();
  }

  private coll(name: string): Map<string, Version[]> {
    let map = this.colls.get(name);
    if (!map) {
      map = new Map();
      this.colls.set(name, map);
    }
    return map;
  }

  private record(event: Doc, ct: ClusterTime): void {
    const idx = ++this.idx;
    const token = tokenFor(ct, idx);
    this.oplog.push({ ct, idx, token, event: { _id: { _data: token }, clusterTime: { t: ct.t, i: ct.i }, ...event } });
  }

  /** The latest document (or null). */
  latest(coll: string, oid: string): Doc | null {
    const versions = this.colls.get(coll)?.get(oid);
    return versions ? clone(versions[versions.length - 1].doc) : null;
  }

  /** Every live document of a collection now. */
  liveDocs(coll: string): Array<{ oid: string; doc: Doc }> {
    const out: Array<{ oid: string; doc: Doc }> = [];
    for (const [oid, versions] of this.colls.get(coll) ?? []) {
      const doc = versions[versions.length - 1].doc;
      if (doc) out.push({ oid, doc: clone(doc) });
    }
    return out;
  }

  private docAt(coll: string, oid: string, at: ClusterTime): Doc | null {
    const versions = this.colls.get(coll)?.get(oid);
    if (!versions) return null;
    let found: Doc | null = null;
    for (const version of versions) {
      if (compareTimes(version.ct, at) <= 0) found = version.doc;
      else break;
    }
    return found;
  }

  insert(coll: string, doc: Doc, oid = new ObjectId().toHexString()): string {
    const ct = this.nextTime();
    const stored = { ...clone(doc), _id: new ObjectId(oid) };
    this.coll(coll).set(oid, [...(this.coll(coll).get(oid) ?? []), { ct, doc: stored }]);
    this.record({ operationType: 'insert', ns: { db: 'db', coll }, documentKey: { _id: new ObjectId(oid) }, fullDocument: clone(stored) }, ct);
    return oid;
  }

  /** `$set` (top-level keys replace whole values; dotted keys set a leaf) and `$unset`. */
  update(coll: string, oid: string, ops: { set?: Doc; unset?: string[] }): void {
    const versions = this.coll(coll).get(oid);
    const current = versions?.[versions.length - 1].doc;
    if (!current) throw new Error(`update of a missing document ${coll} ${oid}`);
    const ct = this.nextTime();
    const next = clone(current);
    const updatedFields: Doc = {};
    for (const [key, value] of Object.entries(ops.set ?? {})) {
      setPath(next, key, clone(value));
      updatedFields[key] = clone(value);
    }
    for (const key of ops.unset ?? []) unsetPath(next, key);
    versions!.push({ ct, doc: next });
    this.record(
      {
        operationType: 'update',
        ns: { db: 'db', coll },
        documentKey: { _id: new ObjectId(oid) },
        updateDescription: { updatedFields, removedFields: [...(ops.unset ?? [])], truncatedArrays: [] },
      },
      ct,
    );
  }

  replace(coll: string, oid: string, doc: Doc): void {
    const ct = this.nextTime();
    const stored = { ...clone(doc), _id: new ObjectId(oid) };
    this.coll(coll).get(oid)!.push({ ct, doc: stored });
    this.record({ operationType: 'replace', ns: { db: 'db', coll }, documentKey: { _id: new ObjectId(oid) }, fullDocument: clone(stored) }, ct);
  }

  delete(coll: string, oid: string): void {
    const ct = this.nextTime();
    this.coll(coll).get(oid)!.push({ ct, doc: null });
    this.record({ operationType: 'delete', ns: { db: 'db', coll }, documentKey: { _id: new ObjectId(oid) } }, ct);
  }

  drop(coll: string): void {
    const ct = this.nextTime();
    for (const versions of this.coll(coll).values()) versions.push({ ct, doc: null });
    this.record({ operationType: 'drop', ns: { db: 'db', coll } }, ct);
  }

  private majorityOf(member: number): ClusterTime {
    let { t, i } = this.now();
    let lag = this.memberLags[member] ?? 0;
    while (lag > 0) {
      i--;
      if (i <= 0) {
        t--;
        i = 50;
      }
      lag--;
    }
    return { t, i };
  }

  // ── FeederSource ──

  async listCollections(): Promise<string[]> {
    return [...this.colls.keys()];
  }

  async idProbe(coll: string): Promise<IdProbe> {
    if (this.badIds.has(coll)) return 'bad';
    return (this.colls.get(coll)?.size ?? 0) > 0 ? 'ok' : 'empty';
  }

  async oplogProbe(startAt: ClusterTime): Promise<'ok' | 'history_lost'> {
    return compareTimes(startAt, this.oldestRetained) < 0 ? 'history_lost' : 'ok';
  }

  async majorityTime(): Promise<ClusterTime> {
    return this.majorityOf(0);
  }

  async scanBatch(coll: string, _model: ReadModelName, afterOid: string | null, limit: number, afterClusterTime: ClusterTime, _trim: TrimLevel) {
    this.scanCalls++;
    await new Promise((resolve) => setImmediate(resolve));
    // A majority read after afterClusterTime on a randomly chosen secondary.
    const member = Math.floor(this.random() * this.memberLags.length);
    const memberMajority = this.majorityOf(member);
    const at = compareTimes(memberMajority, afterClusterTime) >= 0 ? memberMajority : afterClusterTime;
    const oids = [...(this.colls.get(coll)?.keys() ?? [])].sort().filter((oid) => afterOid === null || oid > afterOid);
    const docs: Doc[] = [];
    for (const oid of oids) {
      if (docs.length >= limit) break;
      if (this.scanSkips.has(oid)) continue;
      const doc = this.docAt(coll, oid, at);
      if (doc) docs.push(clone(doc));
    }
    return { docs, opTime: at };
  }

  async findOne(coll: string, _model: ReadModelName, oid: string, afterClusterTime: ClusterTime) {
    if (this.findOneDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.findOneDelayMs));
    const majority = this.majorityOf(0);
    const at = compareTimes(majority, afterClusterTime) >= 0 ? majority : afterClusterTime;
    const doc = this.docAt(coll, oid, at);
    return doc ? clone(doc) : null;
  }

  async estimatedCount(coll: string): Promise<number | undefined> {
    return this.colls.get(coll)?.size ?? 0;
  }

  async openStream(start: { at: ClusterTime } | { after: string }): Promise<StreamHandle> {
    const startTime = 'at' in start ? start.at : { t: Number.parseInt(start.after.slice(2, 10), 16), i: Number.parseInt(start.after.slice(10, 18), 16) };
    if (compareTimes(startTime, this.oldestRetained) < 0) {
      throw Object.assign(new Error('Resume of change stream was not possible, as the resume point may no longer be in the oplog.'), { code: 286, codeName: 'ChangeStreamHistoryLost' });
    }
    // Position: the first oplog index to deliver.
    let next = 'at' in start
      ? this.oplog.findIndex((entry) => compareTimes(entry.ct, start.at) >= 0)
      : this.oplog.findIndex((entry) => compareTimes(entry.ct, startTime) > 0 || (compareTimes(entry.ct, startTime) === 0 && entry.idx > idxOf(start.after)));
    if (next < 0) next = this.oplog.length;
    let token: string | undefined = 'after' in start ? start.after : undefined;
    let closed = false;
    const cluster = this;
    return {
      async tryNext() {
        if (closed) throw new Error('stream closed');
        await new Promise((resolve) => setImmediate(resolve));
        const visible = cluster.streamVisible();
        const entry = cluster.oplog[next];
        if (entry && compareTimes(entry.ct, visible) <= 0) {
          next++;
          token = entry.token;
          return clone(entry.event);
        }
        // Drained: the high-water mark is the member's applied point.
        token = tokenFor(visible, 0xffffffff);
        await new Promise((resolve) => setTimeout(resolve, 2));
        return null;
      },
      resumeToken: () => token,
      async close() {
        closed = true;
      },
    };
  }

  /** The newest cluster time the stream's member has applied. */
  streamVisible(): ClusterTime {
    let { t, i } = this.now();
    let lag = this.streamLag;
    while (lag > 0) {
      i--;
      if (i <= 0) {
        t--;
        i = 50;
      }
      lag--;
    }
    return { t, i };
  }

  async clusterMajority(): Promise<ClusterTime> {
    return this.majorityOf(0);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** A position document of the rank model (whole subtrees, as the sync writes them). */
export function positionDoc(n: number, over: Doc = {}): Doc {
  return {
    chainId: 1,
    protocol: 'uniswap-v4',
    positionId: String(n),
    tokenId: String(n),
    owner: `0x${(n % 97).toString(16).padStart(40, '0')}`,
    poolId: `0x${(n % 13).toString(16).padStart(64, 'a')}`,
    isActive: n % 3 !== 0,
    createdAtTimestamp: 1_700_000_000 + n,
    token0: { address: '0xa0b8', symbol: 'USDC', decimals: 6 },
    token1: { address: '0xc02a', symbol: 'WETH', decimals: 18 },
    metrics: {
      underlyingValueUsd: n % 5 === 0 ? 0 : n * 10.5,
      poolPnlUsd: n % 7 === 0 ? Number.NaN : n - 50,
      aprExGas: (n % 11) - 3,
      feeApr: n % 4,
      roi: n % 6 === 0 ? null : n / 100,
      inRange: n % 2 === 0,
      performanceReady: n % 9 !== 0,
      apr: 1,
    },
    poolStats: { tvlUsd: n * 1000 },
    pricing: { source: n % 8 === 0 ? 'none' : 'external', usedFallback: n % 10 === 0 },
    amounts: { amount0: '1' },
    ...over,
  };
}

/** A pool document of the pools model. */
export function poolDoc(n: number, over: Doc = {}): Doc {
  return {
    chainId: 1,
    protocol: 'uniswap-v4',
    poolId: `0x${n.toString(16).padStart(64, '0')}`,
    createdAtTimestamp: 1_690_000_000 + n,
    token0: { address: `0x${(n % 5).toString(16).padStart(40, '1')}`, symbol: `T${n % 5}` },
    token1: { address: '0xc02a', symbol: 'WETH' },
    metrics: { tvlUsd: n % 4 === 0 ? 0 : n * 100, volumeUsd24h: n, feesUsd24h: n / 10, feeApr: n % 3 },
    pricing: { source: 'external', usedFallback: false },
    fee: 3000,
    ...over,
  };
}
