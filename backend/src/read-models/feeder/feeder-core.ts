import { isPipelineRefusal, isHistoryLost, toStreamItem, type TrimLevel } from './change-stream.js';
import type {
  FeederStartOptions,
  MainCommand,
  RowChange,
  ShardCollection,
  WorkerMessage,
  WorkerStats,
} from './messages.js';
import { normalizeDoc, oidHex } from './normalize.js';
import { ScanBuffer } from './scan-buffer.js';
import { compareTimes, formatTime, maxTime, parseTime, timeFromMs, tokenTime, type ClusterTime } from './resume-token.js';
import type { FeederSource, StreamHandle } from './source.js';

/**
 * The feeder's Mongo side (design §3.1–§3.2, §3.6): runs in the feeder WORKER
 * thread (`feeder.worker.ts`), or in-thread for specs and `READ_MODELS_WORKERS=0`.
 *
 * Cold start (§3.2):
 *  0. probes — the oplog window (a stream opened at now − ½ × the hint; history
 *     lost ⇒ `fatal oplog_too_short`, fail closed), each shard's `_id` type
 *     (first/last key both ObjectId, F10; otherwise the shard is unsupported),
 *     the shard set (served ∩ present);
 *  1. T0 = the operationTime of a `majority` read on the scan member;
 *  2. the change stream is opened AT T0, BEFORE scanning, and drained
 *     concurrently into the coalescing scan buffer;
 *  3. each shard is scanned by `_id` keyset, paced, every batch `majority`
 *     after max(T0, the previous batch's snapshot);
 *  5. catch-up: once the stream has passed the last batch's snapshot, the
 *     buffer is handed over and every shard goes live — atomically, at one
 *     stream position, which is the `catchUp` mark the main thread snapshots at.
 *     A buffer that overflows stops the stream; after the scans the buffer is
 *     handed over and the stream REPLAYS from the last buffered event, and the
 *     `catchUp` mark follows once the replay has passed the last snapshot.
 * Resume: the stream continues after the given token; a served collection the
 * model does not know, renamed into, or asked for gets an in-epoch shard scan
 * (`shardScanStart` → rows → its own buffer → `shardScanDone`, §3.6).
 *
 * Every message leaves through one ordered outbox; row-bearing messages are
 * acknowledged before the next one is sent (backpressure, §2.4).
 */

export interface FeederCoreDeps {
  source: FeederSource;
  emit: (message: WorkerMessage) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Live changes per `changes` message. */
  liveBatch?: number;
  /** How often pending live changes are flushed (ms). */
  liveFlushMs?: number;
  /** How often the majority point is read and a `confirm` considered (ms). */
  confirmEveryMs?: number;
  statsEveryMs?: number;
}

const DEFAULT_SCAN_BATCH = 2_000;
const DEFAULT_BUFFER_BYTES = 96 * 1024 * 1024;
/** A majority reading older than this cannot confirm (design §6.7: "taken ≤ 5 s earlier"). */
const CONFIRM_MAX_AGE_MS = 5_000;
const MAX_UNACKED = 2;
/** Records per `buffer` message (a cold catch-up can hand over hundreds of thousands). */
const BUFFER_CHUNK = 5_000;

interface ScanJob {
  coll: string;
  shard: ShardCollection;
  reason: string;
  buffer: ScanBuffer;
  aborted: boolean;
  started: boolean;
  rows: number;
  /**
   * In-epoch scans: the stream position when this job's buffer started
   * capturing the shard's events. Events at or before it never reach the
   * buffer (applied live and then reset, or consumed by a previous session),
   * so the scan must read at or after it (§3.6).
   */
  floor?: ClusterTime;
  /** Cold jobs: the collection's drop generation at the job's start (a drop / rename-into supersedes the job). */
  gen?: number;
}

type Outgoing = { message: WorkerMessage; needsAck: boolean };

export class FeederCore {
  private readonly source: FeederSource;
  private readonly emitNow: (message: WorkerMessage) => void;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly shards = new Map<string, ShardCollection>();
  private readonly live = new Set<string>();
  private readonly unsupported = new Set<string>();
  private readonly scans = new Map<string, ScanJob>();
  private cold?: { buffer: ScanBuffer; colls: Set<string>; queue: string[]; dropped: Set<string>; gens: Map<string, number> };
  private opts!: FeederStartOptions;

  private stopped = false;
  private stream?: StreamHandle;
  private streamStart?: { at: ClusterTime } | { after: string };
  private streamTrim: TrimLevel = 'full';
  private scanTrim: TrimLevel = 'full';
  private pumpRunning?: Promise<void>;
  private pumpHalt = false;
  private lastRt?: string;
  private lastCt?: ClusterTime;
  private drained = false;
  /** Recent majority-point readings (≤ 5 s old), oldest first. */
  private majorityReadings: Array<{ ct: ClusterTime; at: number }> = [];

  private readonly outbox: Outgoing[] = [];
  private sending = false;
  private seq = 0;
  private unacked = 0;
  private ackWaiters: Array<() => void> = [];
  private awaitingAck?: { seq: number; resolve: () => void };
  private pendingLive: RowChange[] = [];

  private docsPerSec = 5_000;
  private paused = false;
  private pressure = false;
  private tokens = 0;
  private refilledAt = 0;
  private timers: Array<ReturnType<typeof setInterval>> = [];

  private readonly stats: WorkerStats = {
    events: 0,
    eventsSkipped: 0,
    bytes: 0,
    buffer: { records: 0, bytes: 0, overflowed: false },
    trim: 'full',
    repairs: 0,
  };
  private scanProgress?: WorkerStats['scan'];

  constructor(private readonly deps: FeederCoreDeps) {
    this.source = deps.source;
    this.emitNow = deps.emit;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Run until stopped or fatal. Never throws: failures leave as `fatal` / `alert` messages. */
  async run(opts: FeederStartOptions): Promise<void> {
    this.opts = opts;
    this.docsPerSec = clampRate(opts.scanDocsPerSec);
    this.tokens = this.docsPerSec;
    this.refilledAt = this.now();
    for (const shard of opts.shards) this.shards.set(shard.coll, shard);
    this.startTimers();
    try {
      if (opts.start.kind === 'cold') await this.runCold();
      else await this.runResume(opts.start);
      // Live until stopped.
      while (!this.stopped) await this.sleep(250);
    } catch (err) {
      if (!this.stopped) this.fatal('error', errorText(err));
    } finally {
      this.stopTimers();
      await this.stream?.close().catch(() => undefined);
      await this.source.close().catch(() => undefined);
    }
  }

  /** A command from the main thread. */
  command(command: MainCommand): void {
    switch (command.type) {
      case 'ack':
        if (this.awaitingAck && this.awaitingAck.seq <= command.seq) {
          const { resolve } = this.awaitingAck;
          this.awaitingAck = undefined;
          resolve();
        }
        break;
      case 'pace':
        this.docsPerSec = clampRate(command.docsPerSec);
        break;
      case 'pause':
        this.paused = true;
        break;
      case 'resume':
        this.paused = false;
        break;
      case 'pressure':
        this.pressure = command.under;
        break;
      case 'repair':
        void this.repair(command.reqId, command.coll, command.oid, command.afterCt);
        break;
      case 'rescan':
        if (this.shards.has(command.coll) && !this.cold) this.startShardScan(command.coll, command.reason);
        break;
      case 'stop':
        this.stop();
        break;
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.pumpHalt = true;
    this.awaitingAck?.resolve();
    this.awaitingAck = undefined;
    for (const wake of this.ackWaiters.splice(0)) wake();
  }

  // ── cold start ──

  private async runCold(): Promise<void> {
    const present = new Set(await this.retry('list collections', () => this.source.listCollections()));
    const probes: Array<{ coll: string; idType: 'ok' | 'empty' | 'bad' }> = [];
    for (const coll of this.shards.keys()) {
      if (!present.has(coll)) continue;
      const idType = await this.retry(`_id probe ${coll}`, () => this.source.idProbe(coll));
      probes.push({ coll, idType });
    }
    this.enqueue({ type: 'probe', shards: probes, present: [...present].filter((coll) => this.shards.has(coll)) });
    for (const { coll, idType } of probes) {
      if (idType === 'bad') this.markUnsupported(coll, '_id is not an ObjectId at one end of the _id index');
    }

    const windowStart = timeFromMs(this.now() - this.opts.oplogWindowHintMs / 2);
    const probe = await this.retry('oplog probe', () => this.source.oplogProbe(windowStart, this.streamTrim));
    if (probe === 'history_lost') {
      this.fatal('oplog_too_short', `a change stream cannot start ${Math.round(this.opts.oplogWindowHintMs / 2 / 60_000)} min back (READ_MODELS_OPLOG_WINDOW_HINT_MS / 2): the oplog window is shorter than the hint`);
      return;
    }
    if (this.stopped) return;

    const t0 = await this.retry('T0', () => this.source.majorityTime());
    this.enqueue({ type: 't0', ct: formatTime(t0) });
    const colls = probes.filter((p) => p.idType !== 'bad').map((p) => p.coll);
    this.cold = {
      buffer: new ScanBuffer(this.opts.scanBufferBytes ?? DEFAULT_BUFFER_BYTES),
      colls: new Set(colls),
      queue: [...colls],
      dropped: new Set(),
      gens: new Map(),
    };
    this.streamStart = { at: t0 };
    this.lastCt = t0;
    this.startPump();

    let maxS = t0;
    while (this.cold.queue.length > 0 && !this.stopped) {
      const coll = this.cold.queue.shift()!;
      const shard = this.shards.get(coll)!;
      const job: ScanJob = { coll, shard, reason: 'cold', buffer: this.cold.buffer, aborted: false, started: true, rows: 0, gen: this.cold.gens.get(coll) ?? 0 };
      const result = await this.scanCollection(job, t0);
      if (result) maxS = maxTime(maxS, result.maxS);
    }
    if (this.stopped) return;

    const cold = this.cold;
    if (!cold.buffer.overflowed) {
      await this.waitFor(() => cold.buffer.overflowed || (this.lastCt !== undefined && compareTimes(this.lastCt, maxS) >= 0));
      if (this.stopped) return;
    }
    if (!cold.buffer.overflowed) {
      // Atomic flip: everything routed so far is in the buffer; from here on the shards are live.
      const items = cold.buffer.drain().filter((item) => !this.unsupported.has(item.coll));
      for (const coll of cold.colls) if (!this.unsupported.has(coll)) this.live.add(coll);
      const rt = this.lastRt ?? '';
      const ct = this.lastCt ?? t0;
      this.cold = undefined;
      this.enqueueBuffer(null, items);
      this.enqueue({ type: 'catchUp', rt, ct: formatTime(ct) });
      return;
    }

    // Replay mode (§3.2 step 2): the buffer overflowed and the stream stopped at its last event.
    this.emitAlert('read_models.scan_buffer_overflow', `scan buffer full (${cold.buffer.bytes} B, ${cold.buffer.size} rows): replaying the stream after the last buffered event`);
    this.pumpHalt = true;
    await this.pumpRunning;
    await this.stream?.close().catch(() => undefined);
    this.stream = undefined;
    const replayFrom = cold.buffer.lastRt;
    const items = cold.buffer.drain().filter((item) => !this.unsupported.has(item.coll));
    for (const coll of cold.colls) if (!this.unsupported.has(coll)) this.live.add(coll);
    this.enqueueBuffer(null, items);
    this.cold = undefined;
    this.streamStart = replayFrom ? { after: replayFrom } : { at: t0 };
    this.lastRt = replayFrom;
    this.lastCt = replayFrom ? tokenTime(replayFrom) ?? t0 : t0;
    this.pumpHalt = false;
    this.startPump();
    await this.waitFor(() => this.lastCt !== undefined && compareTimes(this.lastCt, maxS) >= 0);
    if (this.stopped) return;
    this.enqueue({ type: 'catchUp', rt: this.lastRt ?? '', ct: formatTime(this.lastCt ?? maxS) });
  }

  // ── resume ──

  private async runResume(start: { kind: 'resume'; rt: string; known: string[]; rescan: string[]; unsupported?: string[] }): Promise<void> {
    const known = new Set(start.known);
    for (const coll of start.unsupported ?? []) this.unsupported.add(coll);
    for (const coll of this.shards.keys()) if (known.has(coll)) this.live.add(coll);
    this.streamStart = { after: start.rt };
    this.lastRt = start.rt;
    this.lastCt = tokenTime(start.rt);
    this.startPump();
    for (const coll of start.rescan) if (this.shards.has(coll)) this.startShardScan(coll, 'resume');
  }

  // ── in-epoch shard scans (§3.6) ──

  private startShardScan(coll: string, reason: string): void {
    const shard = this.shards.get(coll);
    if (!shard) return;
    const existing = this.scans.get(coll);
    if (existing) existing.aborted = true;
    this.unsupported.delete(coll);
    this.live.delete(coll);
    // From here the shard's events go to this job's buffer: everything up to the
    // stream's current position must come from the scan (its floor).
    const job: ScanJob = {
      coll,
      shard,
      reason,
      buffer: new ScanBuffer((this.opts.scanBufferBytes ?? DEFAULT_BUFFER_BYTES) / 2),
      aborted: false,
      started: false,
      rows: 0,
      floor: this.lastCt,
    };
    this.scans.set(coll, job);
    this.enqueue({ type: 'shardScanStart', coll, reason });
    void this.runShardScan(job).catch((err) => {
      if (!this.stopped) this.emitAlert('read_models.shard_scan_failed', `${coll}: ${errorText(err)} — retrying`);
      if (!this.stopped && this.scans.get(coll) === job) setTimeout(() => this.startShardScan(coll, `${reason} (retry)`), 5_000);
    });
  }

  private async runShardScan(job: ScanJob): Promise<void> {
    const idType = await this.retry(`_id probe ${job.coll}`, () => this.source.idProbe(job.coll));
    if (job.aborted || this.stopped) return;
    if (idType === 'bad') {
      this.markUnsupported(job.coll, '_id is not an ObjectId at one end of the _id index');
      return;
    }
    const majority = await this.retry(`T0 ${job.coll}`, () => this.source.majorityTime());
    // Never before the diversion point: a scan member whose majority view trails
    // the stream member would otherwise answer from before events that went
    // live (and were then reset) — losing them for good. A lagging member waits
    // (afterClusterTime) instead.
    const t0 = job.floor ? maxTime(majority, job.floor) : majority;
    job.started = true;
    const result = await this.scanCollection(job, t0);
    if (!result || job.aborted || this.stopped) return;
    await this.waitFor(() => job.aborted || job.buffer.overflowed || (this.lastCt !== undefined && compareTimes(this.lastCt, result.maxS) >= 0));
    if (job.aborted || this.stopped) return;
    if (job.buffer.overflowed) {
      this.emitAlert('read_models.scan_buffer_overflow', `${job.coll}: shard scan buffer full — restarting the shard scan`);
      this.startShardScan(job.coll, `${job.reason} (buffer overflow)`);
      return;
    }
    // Atomic flip, as at a cold catch-up.
    const items = job.buffer.drain();
    this.scans.delete(job.coll);
    this.live.add(job.coll);
    this.enqueueBuffer(job.coll, items);
    this.enqueue({ type: 'shardScanDone', coll: job.coll, rows: job.rows });
  }

  /** Is this scan job no longer the one whose rows count? */
  private superseded(job: ScanJob): boolean {
    if (job.aborted || this.stopped || this.unsupported.has(job.coll)) return true;
    if (job.gen !== undefined) return (this.cold?.gens.get(job.coll) ?? 0) !== job.gen;
    return this.scans.get(job.coll) !== job;
  }

  /** Scan one collection; null when aborted / stopped / unsupported. */
  private async scanCollection(job: ScanJob, t0: ClusterTime): Promise<{ maxS: ClusterTime } | null> {
    const batch = this.opts.scanBatchSize ?? DEFAULT_SCAN_BATCH;
    let after: string | null = null;
    let readAt = t0;
    let maxS = t0;
    const total = await this.source.estimatedCount(job.coll).catch(() => undefined);
    this.scanProgress = { coll: job.coll, scanned: 0, total, docsPerSec: this.docsPerSec, paused: false, startedAt: this.now() };
    for (;;) {
      if (job.aborted || this.stopped || this.unsupported.has(job.coll)) return null;
      await this.paceGate(batch);
      await this.room();
      if (job.aborted || this.stopped) return null;
      let result: { docs: Array<Record<string, unknown>>; opTime: ClusterTime };
      try {
        result = await this.source.scanBatch(job.coll, job.shard.model, after, batch, readAt, this.scanTrim);
      } catch (err) {
        if (isPipelineRefusal(err) && this.scanTrim !== 'top') {
          this.scanTrim = 'top';
          this.emitAlert('read_models.trim_fallback', `scan projection refused (${errorText(err)}): scanning with the top-level projection`);
          continue;
        }
        this.emitAlert('read_models.scan_retry', `${job.coll} after ${after ?? 'start'}: ${errorText(err)}`);
        await this.sleep(2_000);
        continue;
      }
      // A batch read before an abort / restart / drop must not land after the
      // reset that followed it (its deletes were in the discarded buffer: ghost rows).
      if (this.superseded(job)) return null;
      readAt = maxTime(readAt, result.opTime);
      maxS = maxTime(maxS, result.opTime);
      const rows: RowChange[] = [];
      for (const doc of result.docs) {
        const oid = oidHex(doc._id);
        if (!oid) {
          this.markUnsupported(job.coll, 'a scanned _id is not an ObjectId');
          return null;
        }
        rows.push({ coll: job.coll, oid, base: 'state', state: normalizeDoc(job.shard.model, doc) });
        after = oid;
      }
      job.rows += rows.length;
      if (this.scanProgress) {
        this.scanProgress.scanned = job.rows;
        this.scanProgress.docsPerSec = this.docsPerSec;
      }
      if (rows.length > 0) this.enqueue({ type: 'scanRows', seq: 0, coll: job.coll, rows, scanned: job.rows });
      if (result.docs.length < batch) break;
    }
    this.scanProgress = undefined;
    return { maxS };
  }

  // ── the change stream ──

  private startPump(): void {
    this.pumpHalt = false;
    this.pumpRunning = this.pump().catch((err) => {
      if (!this.stopped) this.fatal('error', `change stream: ${errorText(err)}`);
    });
  }

  private async openStream(): Promise<StreamHandle> {
    const start = this.lastRt ? { after: this.lastRt } : this.streamStart!;
    return this.source.openStream(start, this.streamTrim);
  }

  private async pump(): Promise<void> {
    let failures = 0;
    while (!this.stopped && !this.pumpHalt) {
      if (!this.stream) {
        try {
          this.stream = await this.openStream();
        } catch (err) {
          if (await this.streamError(err, ++failures)) return;
          continue;
        }
      }
      await this.room();
      if (this.stopped || this.pumpHalt) return;
      let event: Record<string, unknown> | null;
      try {
        event = await this.stream.tryNext();
        failures = 0;
      } catch (err) {
        await this.stream.close().catch(() => undefined);
        this.stream = undefined;
        if (await this.streamError(err, ++failures)) return;
        continue;
      }
      if (this.pumpHalt) return;
      if (!event) {
        this.drained = true;
        const token = this.stream.resumeToken();
        if (token) {
          this.lastRt = token;
          const time = tokenTime(token);
          if (time && (!this.lastCt || compareTimes(time, this.lastCt) > 0)) this.lastCt = time;
        }
        this.flushLive();
        continue;
      }
      this.drained = false;
      this.stats.events++;
      this.stats.bytes += approxBytes(event);
      if (!this.route(event)) return; // overflow / fatal: stop pumping here
      const token = this.stream.resumeToken();
      if (token) {
        this.lastRt = token;
        const time = tokenTime(token);
        if (time && (!this.lastCt || compareTimes(time, this.lastCt) > 0)) this.lastCt = time;
      }
    }
  }

  /** True = stop pumping (fatal). */
  private async streamError(err: unknown, failures: number): Promise<boolean> {
    if (this.stopped) return true;
    if (isHistoryLost(err)) {
      this.fatal('history_lost', `change stream: ${errorText(err)}`);
      return true;
    }
    if (isPipelineRefusal(err) && this.streamTrim !== 'none') {
      const next: TrimLevel = this.streamTrim === 'full' ? 'top' : 'none';
      this.emitAlert('read_models.trim_fallback', `change-stream trim '${this.streamTrim}' refused (${errorText(err)}): falling back to '${next}'`);
      this.streamTrim = next;
      this.stats.trim = next;
      return false;
    }
    this.emitAlert('read_models.stream_retry', `change stream error #${failures}: ${errorText(err)}`);
    await this.sleep(Math.min(30_000, 500 * 2 ** Math.min(6, failures)));
    return false;
  }

  /** Route one event; false = the pump must stop (cold buffer overflow, fatal). */
  private route(event: Record<string, unknown>): boolean {
    const item = toStreamItem(event, this.shards);
    switch (item.kind) {
      case 'skip':
      case 'noop':
        this.stats.eventsSkipped++;
        return true;
      case 'dropDatabase':
        this.fatal('drop_database', 'dropDatabase on the positions database');
        return false;
      case 'invalidate':
        this.fatal('invalidate', 'the change stream was invalidated');
        return false;
      case 'badId':
        this.markUnsupported(item.coll, 'an event carried a non-ObjectId _id');
        return true;
      case 'drop':
        this.shardDropped(item.coll, item.how);
        return true;
      case 'renameBetween':
        // Both served: the source's rows go (rename-FROM), the target is rescanned.
        this.shardDropped(item.from, 'rename');
        this.renamedInto(item.coll);
        return true;
      case 'renameInto':
        this.renamedInto(item.coll);
        return true;
      case 'row': {
        const change = item.change;
        const coll = change.coll;
        if (this.unsupported.has(coll)) return true;
        if (this.cold) {
          if (!this.cold.colls.has(coll)) {
            // A served collection created during the cold build: scanned as part of it.
            this.cold.colls.add(coll);
            this.cold.queue.push(coll);
          }
          if (!this.cold.buffer.add(change)) return false;
          return true;
        }
        const job = this.scans.get(coll);
        if (job) {
          // An overflow is handled when the scan ends (the shard scan restarts).
          job.buffer.add(change);
          return true;
        }
        if (!this.live.has(coll)) {
          // First seen (a newly enabled chain, or a collection created since the epoch's scan):
          // scanned before it serves, never assumed empty.
          this.startShardScan(coll, 'first seen in the stream');
          this.scans.get(coll)?.buffer.add(change);
          return true;
        }
        this.pendingLive.push(change);
        if (this.pendingLive.length >= (this.deps.liveBatch ?? 500)) this.flushLive();
        return true;
      }
    }
  }

  /** A collection renamed INTO a served shard: its previous content is gone, the new one is scanned. */
  private renamedInto(coll: string): void {
    if (!this.cold) {
      this.startShardScan(coll, 'rename-into');
      return;
    }
    // Cold build: drop what was scanned / buffered of the old collection (and any
    // batch in flight), then scan it (again) as part of the build.
    if (this.cold.colls.has(coll)) {
      this.cold.buffer.drain(coll);
      this.cold.gens.set(coll, (this.cold.gens.get(coll) ?? 0) + 1);
      this.enqueue({ type: 'shardDropped', coll, how: 'rename' });
    } else this.cold.colls.add(coll);
    this.cold.dropped.delete(coll);
    if (!this.cold.queue.includes(coll)) this.cold.queue.push(coll);
  }

  private shardDropped(coll: string, how: 'drop' | 'rename'): void {
    const job = this.scans.get(coll);
    if (job) {
      job.aborted = true;
      this.scans.delete(coll);
    }
    if (this.cold?.colls.has(coll)) {
      this.cold.buffer.drain(coll);
      this.cold.dropped.add(coll);
      // A cold batch of it still in flight is superseded.
      this.cold.gens.set(coll, (this.cold.gens.get(coll) ?? 0) + 1);
    }
    this.live.add(coll);
    this.enqueue({ type: 'shardDropped', coll, how });
    this.emitAlert('read_models.shard_dropped', `${coll} was ${how === 'drop' ? 'dropped' : 'renamed away'}: its rows are removed`);
  }

  private markUnsupported(coll: string, reason: string): void {
    if (this.unsupported.has(coll)) return;
    this.unsupported.add(coll);
    this.live.delete(coll);
    const job = this.scans.get(coll);
    if (job) {
      job.aborted = true;
      this.scans.delete(coll);
    }
    this.cold?.buffer.drain(coll);
    this.enqueue({ type: 'shardUnsupported', coll, reason });
    this.emitAlert('read_models.id_type', `${coll}: ${reason} — the shard is not served (queries spanning it go to Mongo)`);
  }

  // ── repairs (§3.3) ──

  private async repair(reqId: number, coll: string, oid: string, afterCt: string): Promise<void> {
    const shard = this.shards.get(coll);
    if (!shard) {
      this.emitNow({ type: 'repairResult', reqId, coll, oid, state: null });
      return;
    }
    const after = parseTime(afterCt) ?? this.lastCt ?? { t: 0, i: 0 };
    for (let attempt = 1; !this.stopped; attempt++) {
      try {
        const doc = await this.source.findOne(coll, shard.model, oid, after, this.scanTrim);
        this.stats.repairs++;
        // Out of band (not behind unacknowledged row messages): the main thread may be
        // holding its acks while it waits for exactly this answer.
        if (!this.stopped) this.emitNow({ type: 'repairResult', reqId, coll, oid, state: doc ? normalizeDoc(shard.model, doc) : null });
        return;
      } catch (err) {
        if (attempt === 3) this.emitAlert('read_models.repair_retry', `${coll} ${oid}: ${errorText(err)}`);
        await this.sleep(Math.min(30_000, 1_000 * attempt));
      }
    }
  }

  // ── pacing (own bucket, yields to user reads; §3.2 step 3) ──

  private async paceGate(rows: number): Promise<void> {
    for (;;) {
      if (this.stopped) return;
      if (this.paused || this.pressure) {
        if (this.scanProgress) this.scanProgress.paused = true;
        await this.sleep(500);
        continue;
      }
      if (this.scanProgress) this.scanProgress.paused = false;
      const now = this.now();
      this.tokens = Math.min(this.docsPerSec, this.tokens + ((now - this.refilledAt) * this.docsPerSec) / 1000);
      this.refilledAt = now;
      if (this.tokens >= Math.min(rows, this.docsPerSec)) {
        this.tokens -= rows;
        return;
      }
      await this.sleep(Math.max(10, Math.ceil(((Math.min(rows, this.docsPerSec) - this.tokens) * 1000) / this.docsPerSec)));
    }
  }

  // ── the outbox ──

  /** Queue a message, in order. Row-bearing ones get a sequence number and wait for their `ack`. */
  private enqueue(message: WorkerMessage): void {
    if (this.stopped && message.type !== 'fatal') return;
    if (message.type !== 'changes') this.flushLive();
    const needsAck = message.type === 'scanRows' || message.type === 'changes' || message.type === 'buffer';
    if (needsAck) {
      (message as { seq: number }).seq = ++this.seq;
      this.unacked++;
    }
    this.outbox.push({ message, needsAck });
    void this.drainOutbox();
  }

  /** A drained scan buffer, in messages of at most `BUFFER_CHUNK` records (none when empty). */
  private enqueueBuffer(coll: string | null, items: RowChange[]): void {
    for (let i = 0; i < items.length; i += BUFFER_CHUNK) {
      this.enqueue({ type: 'buffer', seq: 0, coll, items: items.slice(i, i + BUFFER_CHUNK) });
    }
  }

  private flushLive(): void {
    if (this.pendingLive.length === 0) return;
    const items = this.pendingLive;
    this.pendingLive = [];
    this.enqueue({ type: 'changes', seq: 0, items });
  }

  private async drainOutbox(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      while (this.outbox.length > 0) {
        const { message, needsAck } = this.outbox.shift()!;
        if (!needsAck) {
          this.emitNow(message);
          continue;
        }
        if (this.stopped) {
          this.unacked--;
          continue;
        }
        const acked = new Promise<void>((resolve) => {
          this.awaitingAck = { seq: (message as { seq: number }).seq, resolve };
        });
        this.emitNow(message);
        await acked;
        this.unacked--;
        for (const wake of this.ackWaiters.splice(0)) wake();
      }
    } finally {
      this.sending = false;
    }
  }

  /** Wait until fewer than `MAX_UNACKED` row messages are outstanding. */
  private async room(): Promise<void> {
    while (!this.stopped && this.unacked >= MAX_UNACKED) {
      await new Promise<void>((resolve) => this.ackWaiters.push(resolve));
    }
  }

  // ── timers: live flush, confirm (§6.7), stats ──

  private startTimers(): void {
    const flush = setInterval(() => this.flushLive(), this.deps.liveFlushMs ?? 100);
    const confirm = setInterval(() => void this.confirmTick(), this.deps.confirmEveryMs ?? 1_000);
    const stats = setInterval(() => this.emitStats(), this.deps.statsEveryMs ?? 5_000);
    for (const timer of [flush, confirm, stats]) timer.unref?.();
    this.timers.push(flush, confirm, stats);
  }

  private stopTimers(): void {
    for (const timer of this.timers.splice(0)) clearInterval(timer);
  }

  private confirming = false;

  /**
   * Read the cluster's majority point every tick and keep the readings of the
   * last 5 s. The NEWEST reading the stream has delivered past (or reached,
   * drained) proves that everything majority-committed when it was taken is in
   * the messages sent so far: `confirm` with `ca` = when it was taken (§6.7).
   * Comparing only against the latest reading would never confirm on a busy
   * cluster, where the stream's member always trails the newest majority
   * point by the replication lag.
   */
  async confirmTick(): Promise<void> {
    if (this.confirming || this.stopped) return;
    this.confirming = true;
    try {
      const at = this.now();
      try {
        const ct = await this.source.clusterMajority();
        this.majorityReadings.push({ ct, at });
        this.stats.majorityCt = formatTime(ct);
      } catch (err) {
        this.emitAlert('read_models.majority_probe', errorText(err));
      }
      const now = this.now();
      this.majorityReadings = this.majorityReadings.filter((reading) => now - reading.at <= CONFIRM_MAX_AGE_MS);
      if (this.cold || !this.lastCt || !this.lastRt) return;
      let confirmed: { ct: ClusterTime; at: number } | undefined;
      for (const reading of this.majorityReadings) {
        const order = compareTimes(this.lastCt, reading.ct);
        if (order > 0 || (order === 0 && this.drained)) confirmed = reading;
      }
      if (!confirmed) return;
      this.majorityReadings = this.majorityReadings.filter((reading) => reading.at > confirmed!.at);
      this.enqueue({ type: 'confirm', ca: confirmed.at, rt: this.lastRt, ct: formatTime(this.lastCt) });
    } finally {
      this.confirming = false;
    }
  }

  private emitStats(): void {
    if (this.stopped) return;
    let records = 0;
    let bytes = 0;
    let overflowed = false;
    for (const buffer of [this.cold?.buffer, ...[...this.scans.values()].map((job) => job.buffer)]) {
      if (!buffer) continue;
      records += buffer.size;
      bytes += buffer.bytes;
      overflowed ||= buffer.overflowed;
    }
    this.stats.buffer = { records, bytes, overflowed };
    this.stats.scan = this.scanProgress ? { ...this.scanProgress } : undefined;
    this.stats.streamRt = this.lastRt;
    this.emitNow({ type: 'stats', stats: { ...this.stats, buffer: { ...this.stats.buffer } } });
  }

  private emitAlert(name: string, detail: string): void {
    this.emitNow({ type: 'alert', name, detail });
  }

  private fatal(reason: Extract<WorkerMessage, { type: 'fatal' }>['reason'], detail: string): void {
    if (this.stopped) return;
    this.enqueue({ type: 'fatal', reason, detail });
    this.stop();
  }

  private async waitFor(condition: () => boolean): Promise<void> {
    while (!this.stopped && !condition()) await this.sleep(100);
  }

  /** Retry a setup read until it answers (alerting on the third failure); throws only when stopped. */
  private async retry<T>(what: string, read: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      if (this.stopped) throw new Error('stopped');
      try {
        return await read();
      } catch (err) {
        if (attempt === 3) this.emitAlert('read_models.feeder_retry', `${what}: ${errorText(err)}`);
        await this.sleep(Math.min(30_000, 500 * 2 ** Math.min(6, attempt)));
      }
    }
  }
}

function clampRate(rate: number): number {
  return Number.isFinite(rate) && rate > 0 ? Math.min(5_000, Math.floor(rate)) : 5_000;
}

function errorText(err: unknown): string {
  const record = err as { code?: unknown; codeName?: unknown; message?: unknown } | null;
  const message = typeof record?.message === 'string' ? record.message : String(err);
  const code = record?.codeName ?? record?.code;
  return code !== undefined ? `${String(code)}: ${message}` : message;
}

/** A cheap size estimate of an event (bytes/s metric only; JSON length ≈ BSON size). */
function approxBytes(event: Record<string, unknown>): number {
  try {
    return JSON.stringify(event).length;
  } catch {
    return 0;
  }
}
