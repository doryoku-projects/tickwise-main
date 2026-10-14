import mongoose from 'mongoose';
import { describeCell, rowsEqual, type Cell } from '../core/cells.js';
import { leavesOf, shardKey, type ReadModelName, type ShardKey } from '../core/fields.js';
import type { ModelStore } from '../core/model-store.js';
import { scanProjection } from '../feeder/change-stream.js';
import { normalizeDoc, oidHex } from '../feeder/normalize.js';
import { clusterTimestamp, isSnapshotReadError, isSnapshotTooOld } from '../../database/user-read.js';

/**
 * Lane B — live DATA parity (design §7.1, P-R R4). Lane A proves an engine's
 * ANSWERS equal Mongo's; lane B proves the model's ROWS do — every leaf of
 * every row, normalised exactly as the feeder normalises a scanned document.
 * Holder only (it reads the R1 store, which the holder keeps at the stream's
 * own clusterTime), off the request path, on a SECONDARY with `readConcern:
 * snapshot` at the store's clusterTime — so a difference is a data difference,
 * never two reads of different moments.
 *
 *  - **Samples** (every minute): k random live model rows by `_id`, and k
 *    random Mongo documents (`$sample` → `_id`s) — the second catches a row the
 *    model lacks, the first a row it holds that Mongo does not.
 *  - **Verification scan** (`READ_MODELS_VERIFY_DOCS_PER_SEC`, 0 = off):
 *    `_id`-keyset batches of 2,000 per ready shard, round robin, yielding to
 *    user-read pressure AND to the feeder's own scans (a cold scan or a shard
 *    rescan running on the holder: the secondary's scan load stays one scan's
 *    pace, ≤ 5,000 docs/s); paused / resumed / re-paced by
 *    `POST /admin/read-models/scan {target: 'verify', …}` (a `feeder` command
 *    never touches it; a pace override is cleared by `resume` and by a new
 *    holder session). A batch is compared with the live store
 *    as soon as it arrives; any row that disagrees is re-checked EXACTLY (both
 *    sides at one clusterTime), because the store may have moved on while the
 *    batch was in flight. A row the model holds that Mongo deleted inside a
 *    batch's range is not seen by the scan (the model has no `_id` order);
 *    the random model-row sample covers that direction.
 *  - **Exact checks** capture the model's cells for the `_id`s and the store's
 *    clusterTime in ONE synchronous step, then read Mongo by `_id` at that
 *    clusterTime. Skipped while the holder blocks rows on a repair (its store
 *    then holds changes newer than the clusterTime it claims).
 *  - **Confirmation**: a differing row is re-checked ≥ 5 s later at a newer
 *    clusterTime; only a row that differs TWICE is a diff (one entry carrying
 *    a transaction split across two batches would otherwise read as one).
 *    A confirmed diff logs `[alert] read_models.data_diff` (one structured
 *    JSON line with the normalised values of every differing leaf — EVERY
 *    confirmed row, not throttled per minute: `AlertLog.evidence`) and asks
 *    the holder for a shard rescan (at most once an hour per shard).
 *  - **Budget**: the samples' reads come from lane B's own bucket and skip
 *    while user reads are under pressure — never the user read budget.
 */

export const LANE_B_SAMPLE_ROWS = 20;
export const LANE_B_SAMPLE_EVERY_MS = 60_000;
export const LANE_B_BATCH = 2_000;
export const LANE_B_CONFIRM_AFTER_MS = 5_000;
/** Older than this, a snapshot read at the store's clusterTime risks SnapshotTooOld (300 s history). */
export const LANE_B_MAX_AGE_MS = 240_000;
export const LANE_B_RESCAN_COOLDOWN_MS = 60 * 60_000;
const KEEP_DIFFS = 20;
const MAX_PENDING = 2_000;

export interface ClusterTime {
  t: number;
  i: number;
}

export function parseCt(ct: string | undefined): ClusterTime | undefined {
  if (!ct) return undefined;
  const at = ct.indexOf(':');
  const t = Number(ct.slice(0, at));
  const i = Number(ct.slice(at + 1));
  return at > 0 && Number.isInteger(t) && t > 0 && Number.isInteger(i) && i >= 0 ? { t, i } : undefined;
}

export interface DataParityShard {
  coll: string;
  model: ReadModelName;
  chainId: number;
  protocol: string;
}

/** Mongo reads at an exact clusterTime (`readConcern: snapshot`, secondary). */
export interface DataParityReader {
  /** Documents by `_id`, projected like the feeder's scan. */
  byIds(coll: string, model: ReadModelName, oids: readonly string[], at: ClusterTime): Promise<Array<Record<string, unknown>>>;
  /** `size` random `_id`s (`$sample`). */
  sampleIds(coll: string, size: number, at: ClusterTime): Promise<string[]>;
  /** The next `limit` documents after `afterOid` in `_id` order. */
  keyset(coll: string, model: ReadModelName, afterOid: string | null, limit: number, at: ClusterTime): Promise<Array<Record<string, unknown>>>;
}

export interface DataParitySource {
  store: ModelStore;
  /**
   * The store is exactly Mongo at `store.pos.ct` — false while the holder
   * blocks rows on a repair (the overlay then holds newer changes).
   */
  consistent: boolean;
  /** The feeder is scanning a shard right now (lane B's verification scan yields to it). */
  scanning?: boolean;
  /** Identifies the holder session (a new one clears a pace override and a pause). */
  session?: string;
}

export interface DataParityDeps {
  /** The holder's store; undefined on a consumer, while booting, or with the model off. */
  source(): DataParitySource | undefined;
  /** Served shards of the models that are on. */
  shards(): DataParityShard[];
  reader: DataParityReader;
  alert(name: string, detail: string, key?: string): void;
  /** An evidence line (every confirmed diff; `AlertLog.evidence`) — falls back to `alert` keyed per row. */
  evidence?(name: string, detail: string): void;
  /** Ask the lease holder for a shard rescan. */
  rescan(model: ReadModelName, shard: ShardKey): Promise<void>;
  /** User reads are under pressure (the scan yields). */
  pressure(): boolean;
  verifyDocsPerSec(): number;
  /** Reserve sample reads in lane B's own budget (false = skip) — never the user read budget. */
  reserve?(docs: number): Promise<boolean>;
  now?(): number;
  random?(): number;
}

export type RowDiffKind = 'row' | 'missing' | 'extra';

export interface RowDiff {
  kind: RowDiffKind;
  model: ReadModelName;
  shard: ShardKey;
  oid: string;
  ct: string;
  /** Leaf-by-leaf, only the leaves that differ (normalised values). */
  fields?: Array<{ leaf: string; engine: string; mongo: string }>;
}

interface Captured {
  shard: DataParityShard;
  key: ShardKey;
  ct: string;
  at: ClusterTime;
  rows: Map<string, Cell[] | null>;
}

/** Compare captured model rows with Mongo's documents (both at the same clusterTime). */
export function compareCaptured(captured: Captured, docs: ReadonlyArray<Record<string, unknown>>): { diffs: RowDiff[]; matched: number } {
  const byOid = new Map<string, Record<string, unknown>>();
  for (const doc of docs) {
    const oid = oidHex(doc._id);
    if (oid) byOid.set(oid, doc);
  }
  const leaves = leavesOf(captured.shard.model);
  const diffs: RowDiff[] = [];
  let matched = 0;
  for (const [oid, engine] of captured.rows) {
    const doc = byOid.get(oid);
    const base = { model: captured.shard.model, shard: captured.key, oid, ct: captured.ct };
    if (!doc) {
      if (engine === null) matched++;
      else diffs.push({ kind: 'extra', ...base });
      continue;
    }
    const mongo = normalizeDoc(captured.shard.model, doc);
    if (engine === null) {
      diffs.push({ kind: 'missing', ...base });
      continue;
    }
    if (rowsEqual(engine, mongo)) {
      matched++;
      continue;
    }
    const fields: NonNullable<RowDiff['fields']> = [];
    for (let l = 0; l < leaves.length; l++) {
      if (!rowsEqual([engine[l]], [mongo[l]])) fields.push({ leaf: leaves[l].path, engine: describeCell(engine[l]), mongo: describeCell(mongo[l]) });
    }
    diffs.push({ kind: 'row', ...base, fields });
  }
  return { diffs, matched };
}

interface VerifyCursor {
  lastOid: string | null;
  verified: number;
  passes: number;
  passStartedAt: number;
  lastPassAt: number;
  lastPassMs: number;
  batches: number;
}

interface Pending {
  shard: DataParityShard;
  key: ShardKey;
  oid: string;
  firstAt: number;
  first: RowDiff;
  /** Re-checks already done (a re-check that cannot run is retried, then dropped). */
  attempts: number;
}

/** Lane B: random samples + the paced verification scan + confirmation. */
export class DataParityLane {
  private readonly now: () => number;
  private readonly random: () => number;
  private nextSampleAt = 0;
  private sampleShard = 0;
  private verifyShard = 0;
  private verifyNextAt = 0;
  private paused = false;
  private paceOverride?: number;
  private session?: string;
  private running = false;
  private readonly cursors = new Map<string, VerifyCursor>();
  private readonly pending = new Map<string, Pending>();
  private readonly lastRescan = new Map<string, number>();
  /** Rows already reported, so a persistent difference is one diff (re-reported after the rescan cooldown). */
  private readonly reported = new Map<string, number>();
  readonly meter = {
    checks: 0,
    rows: 0,
    matches: 0,
    diffs: 0,
    transient: 0,
    rescans: 0,
    diffsByModel: { rank: 0, pools: 0 } as Record<ReadModelName, number>,
    kinds: {} as Record<string, number>,
    skipped: {} as Record<string, number>,
    lastDiffs: [] as Array<Record<string, unknown>>,
  };

  constructor(private readonly deps: DataParityDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.random = deps.random ?? Math.random;
  }

  private skip(reason: string): void {
    this.meter.skipped[reason] = (this.meter.skipped[reason] ?? 0) + 1;
  }

  /**
   * `POST /admin/read-models/scan {target: 'verify', …}` (§14): pause / resume /
   * re-pace the verification scan. A `feeder` command (the default target)
   * never reaches it — one pace for both scans would let a cold scan's pace
   * stick to lane B (and a lane-B pause stall the feeder's catch-up). `resume`
   * clears a pace override before applying the one it carries.
   */
  applyScanCommand(command: { action?: unknown; docsPerSec?: unknown; target?: unknown }): void {
    if (command.target !== 'verify') return;
    if (command.action === 'pause') this.paused = true;
    else if (command.action === 'resume') {
      this.paused = false;
      this.paceOverride = undefined;
    }
    if (typeof command.docsPerSec === 'number' && command.docsPerSec > 0) this.paceOverride = Math.min(5_000, Math.floor(command.docsPerSec));
  }

  /** A new holder session starts lane B at its configured pace, unpaused. */
  private observeSession(source: DataParitySource | undefined): void {
    const session = source?.session;
    if (session === undefined || session === this.session) return;
    if (this.session !== undefined) {
      this.paceOverride = undefined;
      this.paused = false;
    }
    this.session = session;
  }

  private rate(): number {
    return this.paceOverride ?? this.deps.verifyDocsPerSec();
  }

  /** The ready, served shards the holder's store holds right now. */
  private readyShards(store: ModelStore): DataParityShard[] {
    return this.deps.shards().filter((s) => {
      const table = store.table(s.model, shardKey(s.chainId, s.protocol));
      return Boolean(table && table.state === 'ready' && table.missingLeaves.size === 0);
    });
  }

  /** Capture the model's cells for `oids` and the store's clusterTime in one synchronous step. */
  private capture(shard: DataParityShard, oids: readonly string[]): Captured | string {
    const source = this.deps.source();
    if (!source) return 'not_holder';
    if (!source.consistent) return 'repair_pending';
    const key = shardKey(shard.chainId, shard.protocol);
    const table = source.store.table(shard.model, key);
    if (!table || table.state !== 'ready' || table.missingLeaves.size > 0) return 'shard_not_ready';
    const ct = source.store.pos.ct;
    const at = parseCt(ct);
    if (!at) return 'no_clustertime';
    if (this.now() - at.t * 1000 > LANE_B_MAX_AGE_MS) return 'window';
    const rows = new Map<string, Cell[] | null>();
    for (const oid of oids) {
      const slot = table.liveSlotOf(oid);
      rows.set(oid, slot >= 0 ? table.cellsAt(slot) : null);
    }
    return { shard, key, ct, at, rows };
  }

  /** Both sides at one clusterTime: the differing rows (undefined = could not check). */
  async checkExact(shard: DataParityShard, oids: readonly string[]): Promise<RowDiff[] | undefined> {
    if (oids.length === 0) return [];
    const captured = this.capture(shard, oids);
    if (typeof captured === 'string') {
      this.skip(captured);
      return undefined;
    }
    let docs: Array<Record<string, unknown>>;
    try {
      docs = await this.deps.reader.byIds(shard.coll, shard.model, oids, captured.at);
    } catch (err) {
      this.skip(isSnapshotTooOld(err) ? 'snapshot_too_old' : isSnapshotReadError(err) ? 'snapshot' : 'mongo');
      return undefined;
    }
    const { diffs, matched } = compareCaptured(captured, docs);
    this.meter.checks++;
    this.meter.rows += captured.rows.size;
    this.meter.matches += matched;
    return diffs;
  }

  /** Queue first-seen diffs for confirmation (a row already pending keeps its first sighting). */
  private suspect(shard: DataParityShard, diffs: RowDiff[]): void {
    const now = this.now();
    for (const diff of diffs) {
      const id = `${diff.shard}|${diff.model}|${diff.oid}`;
      if (this.pending.has(id)) continue;
      if (now - (this.reported.get(id) ?? -Infinity) < LANE_B_RESCAN_COOLDOWN_MS) continue;
      if (this.pending.size >= MAX_PENDING) {
        this.skip('pending_full');
        return;
      }
      this.pending.set(id, { shard, key: diff.shard, oid: diff.oid, firstAt: now, first: diff, attempts: 0 });
    }
  }

  /** Re-check rows that differed ≥ 5 s ago; a second difference is a confirmed diff. */
  async confirm(): Promise<void> {
    const now = this.now();
    const due = [...this.pending.values()].filter((p) => now - p.firstAt >= LANE_B_CONFIRM_AFTER_MS);
    const byShard = new Map<string, Pending[]>();
    for (const p of due) {
      const list = byShard.get(`${p.key}|${p.shard.model}`) ?? [];
      list.push(p);
      byShard.set(`${p.key}|${p.shard.model}`, list);
    }
    for (const list of byShard.values()) {
      const shard = list[0].shard;
      for (let i = 0; i < list.length; i += 500) {
        const chunk = list.slice(i, i + 500);
        const again = await this.checkExact(shard, chunk.map((p) => p.oid));
        if (!again) {
          for (const p of chunk) if (++p.attempts >= 3) this.pending.delete(`${p.key}|${p.shard.model}|${p.oid}`);
          continue;
        }
        const still = new Map(again.map((d) => [d.oid, d]));
        for (const p of chunk) {
          this.pending.delete(`${p.key}|${p.shard.model}|${p.oid}`);
          const diff = still.get(p.oid);
          if (!diff) {
            this.meter.transient++;
            continue;
          }
          await this.confirmed(diff, p);
        }
      }
    }
  }

  private async confirmed(diff: RowDiff, pending: Pending): Promise<void> {
    const now = this.now();
    this.reported.set(`${diff.shard}|${diff.model}|${diff.oid}`, now);
    if (this.reported.size > MAX_PENDING) {
      for (const [id, at] of this.reported) if (now - at >= LANE_B_RESCAN_COOLDOWN_MS) this.reported.delete(id);
    }
    this.meter.diffs++;
    this.meter.diffsByModel[diff.model]++;
    this.meter.kinds[diff.kind] = (this.meter.kinds[diff.kind] ?? 0) + 1;
    const line = { lane: 'B', ...diff, firstCt: pending.first.ct, firstAt: new Date(pending.firstAt).toISOString() };
    this.meter.lastDiffs.unshift({ at: new Date(now).toISOString(), ...line });
    if (this.meter.lastDiffs.length > KEEP_DIFFS) this.meter.lastDiffs.length = KEEP_DIFFS;
    // Every confirmed row is a line (the runbook keeps them): never throttled per shard.
    if (this.deps.evidence) this.deps.evidence('read_models.data_diff', JSON.stringify(line));
    else this.deps.alert('read_models.data_diff', JSON.stringify(line), `${diff.model}|${diff.shard}|${diff.oid}`);
    const rescanKey = `${diff.model}|${diff.shard}`;
    if (now - (this.lastRescan.get(rescanKey) ?? -Infinity) < LANE_B_RESCAN_COOLDOWN_MS) return;
    this.lastRescan.set(rescanKey, now);
    try {
      await this.deps.rescan(diff.model, diff.shard);
      this.meter.rescans++;
    } catch {
      this.skip('rescan_failed');
    }
  }

  /** The once-a-minute samples (model rows and Mongo documents), up to two shards per tick. */
  async sample(): Promise<void> {
    const now = this.now();
    if (now < this.nextSampleAt) return;
    this.nextSampleAt = now + LANE_B_SAMPLE_EVERY_MS;
    const source = this.deps.source();
    if (!source) return this.skip('not_holder');
    const shards = this.readyShards(source.store);
    if (shards.length === 0) return this.skip('no_ready_shard');
    for (let n = 0; n < Math.min(2, shards.length); n++) {
      const shard = shards[this.sampleShard++ % shards.length];
      if (this.deps.reserve && !(await this.deps.reserve(LANE_B_SAMPLE_ROWS * 2))) {
        this.skip('budget');
        continue;
      }
      // Model side: random live slots.
      const table = source.store.table(shard.model, shardKey(shard.chainId, shard.protocol));
      const oids = new Set<string>();
      if (table && table.live > 0) {
        for (let tries = 0; oids.size < Math.min(LANE_B_SAMPLE_ROWS, table.live) && tries < LANE_B_SAMPLE_ROWS * 20; tries++) {
          const slot = Math.floor(this.random() * table.slots);
          if (table.alive[slot] === 1) oids.add(table.oidAt(slot));
        }
      }
      const fromModel = await this.checkExact(shard, [...oids]);
      if (fromModel?.length) this.suspect(shard, fromModel);
      // Mongo side: random documents.
      const ct = parseCt(this.deps.source()?.store.pos.ct);
      if (!ct) continue;
      let ids: string[];
      try {
        ids = await this.deps.reader.sampleIds(shard.coll, LANE_B_SAMPLE_ROWS, ct);
      } catch (err) {
        this.skip(isSnapshotReadError(err) ? 'snapshot' : 'mongo');
        continue;
      }
      const fromMongo = await this.checkExact(shard, ids);
      if (fromMongo?.length) this.suspect(shard, fromMongo);
    }
  }

  /** One verification batch when due (the 1 s timer calls this). */
  async verify(): Promise<void> {
    const rate = this.rate();
    if (!(rate > 0) || this.paused) return;
    const now = this.now();
    if (now < this.verifyNextAt) return;
    if (this.deps.pressure()) {
      this.skip('pressure');
      this.verifyNextAt = now + 1_000;
      return;
    }
    const source = this.deps.source();
    if (!source) return;
    if (!source.consistent) {
      this.skip('repair_pending');
      return;
    }
    // The feeder's own scan is reading the secondary: one scan at a time.
    if (source.scanning) {
      this.skip('feeder_scanning');
      this.verifyNextAt = now + 5_000;
      return;
    }
    const shards = this.readyShards(source.store);
    if (shards.length === 0) return;
    const shard = shards[this.verifyShard % shards.length];
    const key = shardKey(shard.chainId, shard.protocol);
    const id = `${shard.model}|${key}`;
    const cursor = this.cursors.get(id) ?? { lastOid: null, verified: 0, passes: 0, passStartedAt: now, lastPassAt: 0, lastPassMs: 0, batches: 0 };
    this.cursors.set(id, cursor);
    const at = parseCt(source.store.pos.ct);
    if (!at || now - at.t * 1000 > LANE_B_MAX_AGE_MS) {
      this.skip('window');
      this.verifyNextAt = now + 1_000;
      return;
    }
    const limit = Math.max(1, Math.min(LANE_B_BATCH, Math.ceil(rate * 4)));
    let docs: Array<Record<string, unknown>>;
    try {
      docs = await this.deps.reader.keyset(shard.coll, shard.model, cursor.lastOid, limit, at);
    } catch (err) {
      this.skip(isSnapshotTooOld(err) ? 'snapshot_too_old' : isSnapshotReadError(err) ? 'snapshot' : 'mongo');
      this.verifyNextAt = now + 5_000;
      return;
    }
    // A fast compare against the live store; any disagreement is re-checked exactly.
    const table = this.deps.source()?.store.table(shard.model, key);
    const suspects: string[] = [];
    let last: string | null = cursor.lastOid;
    for (const doc of docs) {
      const oid = oidHex(doc._id);
      if (!oid) continue;
      last = oid;
      const slot = table ? table.liveSlotOf(oid) : -1;
      if (slot < 0 || !table!.sameAs(slot, normalizeDoc(shard.model, doc))) suspects.push(oid);
    }
    cursor.batches++;
    cursor.verified += docs.length;
    for (let i = 0; i < suspects.length; i += 500) {
      const exact = await this.checkExact(shard, suspects.slice(i, i + 500));
      if (exact?.length) this.suspect(shard, exact);
    }
    if (docs.length < limit) {
      cursor.passes++;
      cursor.lastPassAt = this.now();
      cursor.lastPassMs = cursor.lastPassAt - cursor.passStartedAt;
      cursor.lastOid = null;
      cursor.passStartedAt = this.now();
      this.verifyShard++;
    } else {
      cursor.lastOid = last;
    }
    this.verifyNextAt = this.now() + Math.ceil((Math.max(docs.length, 1) / rate) * 1000);
  }

  /** The timer's one entry point: never overlaps itself. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      this.observeSession(this.deps.source());
      await this.sample();
      await this.verify();
      await this.confirm();
    } finally {
      this.running = false;
    }
  }

  status() {
    return {
      ...this.meter,
      diffsByModel: { ...this.meter.diffsByModel },
      kinds: { ...this.meter.kinds },
      skipped: { ...this.meter.skipped },
      lastDiffs: [...this.meter.lastDiffs],
      pending: this.pending.size,
      verify: {
        docsPerSec: this.rate(),
        paused: this.paused,
        shards: Object.fromEntries(
          [...this.cursors].map(([id, c]) => [
            id,
            {
              verified: c.verified,
              batches: c.batches,
              passes: c.passes,
              inPass: c.lastOid !== null,
              lastPassAt: c.lastPassAt ? new Date(c.lastPassAt).toISOString() : null,
              lastPassMs: c.lastPassMs || null,
            },
          ]),
        ),
      },
    };
  }
}

type NativeDb = { command(command: Record<string, unknown>, options?: Record<string, unknown>): Promise<Record<string, unknown>> };

/**
 * Lane B's Mongo reads: RAW commands (the driver's find / aggregate helpers
 * drop `atClusterTime` from a readConcern — R2), `readConcern: snapshot` at
 * the clusterTime, on the read preference given (production: `secondary`,
 * which fails rather than loads the primary), `maxTimeMS` 10 s.
 */
export class MongoDataParityReader implements DataParityReader {
  constructor(
    private readonly db: () => NativeDb | undefined,
    private readonly readPreference: unknown,
  ) {}

  private async run(command: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
    const db = this.db();
    if (!db) throw new Error('no Mongo connection');
    const reply = await db.command(command, { readPreference: this.readPreference });
    return ((reply as { cursor?: { firstBatch?: Array<Record<string, unknown>> } }).cursor?.firstBatch ?? []) as Array<Record<string, unknown>>;
  }

  private snapshot(at: ClusterTime) {
    return { level: 'snapshot', atClusterTime: clusterTimestamp(at) };
  }

  byIds(coll: string, model: ReadModelName, oids: readonly string[], at: ClusterTime) {
    return this.run({
      find: coll,
      filter: { _id: { $in: oids.map((oid) => new mongoose.Types.ObjectId(oid)) } },
      projection: scanProjection(model),
      batchSize: oids.length + 1,
      singleBatch: true,
      readConcern: this.snapshot(at),
      maxTimeMS: 10_000,
    });
  }

  async sampleIds(coll: string, size: number, at: ClusterTime): Promise<string[]> {
    const docs = await this.run({
      aggregate: coll,
      pipeline: [{ $sample: { size } }, { $project: { _id: 1 } }],
      cursor: { batchSize: size + 1 },
      readConcern: this.snapshot(at),
      maxTimeMS: 10_000,
    });
    return docs.map((doc) => oidHex(doc._id)).filter((oid): oid is string => Boolean(oid));
  }

  keyset(coll: string, model: ReadModelName, afterOid: string | null, limit: number, at: ClusterTime) {
    return this.run({
      find: coll,
      filter: afterOid ? { _id: { $gt: new mongoose.Types.ObjectId(afterOid) } } : {},
      sort: { _id: 1 },
      hint: { _id: 1 },
      limit,
      projection: scanProjection(model),
      batchSize: limit,
      singleBatch: true,
      readConcern: this.snapshot(at),
      maxTimeMS: 10_000,
    });
  }
}
