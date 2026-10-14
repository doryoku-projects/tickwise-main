import { readPathMeter } from '../../common/cache/read-path-meter.js';
import { rowsEqual, type Cell } from '../core/cells.js';
import { type ReadModelName, type ShardKey, shardKey } from '../core/fields.js';
import { ModelStore, positionOf, type StreamPosition } from '../core/model-store.js';
import { encodeCells, type ShardTable } from '../core/row-store.js';
import type { RmKeys } from '../keys.js';
import type { AlertLog, FeederMeter } from '../status.js';
import type { Lease, ModelsTransport } from '../transport.js';
import { compareStreamIds, EMPTY_PAYLOAD, encodePayload, type DeltaEntry, type DeltaRecord, type ShardRecordState } from './delta-codec.js';
import type { FeederHost } from './feeder-host.js';
import { sweepModels } from './janitor.js';
import type { FeederStartOptions, RowChange, ShardCollection, WorkerMessage, WorkerStats } from './messages.js';
import { applySets } from './normalize.js';
import { compareTimes, formatTime, parseTime, tokenTime } from './resume-token.js';
import type { SnapshotSink } from './snapshot-sink.js';
import { chunkKeys, SnapshotAbortedError, writeSnapshotSet, type Manifest } from './snapshot-store.js';

/**
 * The lease holder's feeder session (design §2.4, §3.2–§3.6), main thread.
 *
 * The worker (`feeder-core.ts`) hands over normalised changes; this session
 *  - coalesces them per row into FULL row states (an update merges onto the
 *    row's newest state: pending → in flight → appended-but-unapplied → the
 *    store), drops no-ops, mints dictionary ids, encodes;
 *  - appends a batch every ≥ 1,000 changed rows or ≥ 500 ms with a change,
 *    a heartbeat every 1 s while idle, through the fenced script;
 *  - APPLIES each entry to its own store only after the append succeeded
 *    (apply-after-append): the holder's model never holds an entry the
 *    stream lacks, so a demoted holder simply carries on as a consumer;
 *  - retries a failed append AS-IS and stops acknowledging the worker
 *    meanwhile (backpressure: the worker stops reading the change stream);
 *  - writes snapshots (store frozen while encoding, manifest last, fenced),
 *    trims the stream (never past the live manifest), refreshes TTLs, sweeps;
 *  - recovers a lost redis-models without a cold scan (new incarnation, new
 *    epoch that `continues` the last appended position, snapshot from memory).
 * Cold start: the worker's scan rows and buffer are applied straight into the
 * store (no stream yet); at the worker's `catchUp` mark every shard is
 * `ready`, snapshot #1 + manifest of the new epoch are written, and only then
 * do appends start at `s = 1` (§3.2 step 7).
 */

export interface HolderConfig {
  snapshotIntervalMs: number;
  /** TTL of the live manifest + set, the stream, cursor, incarnation and fence copy. */
  liveTtlMs: number;
  /** TTL of a set being written (until its manifest commits). */
  writingTtlMs: number;
  /** TTL a superseded set gets at the switch. */
  supersededTtlMs: number;
  /**
   * Abort a snapshot encode past this many ms (`READ_MODELS_SNAPSHOT_ENCODE_TIMEOUT_MS`,
   * default 20 s). Never applied past half of `writingTtlMs` (`snapshotEncodeCapMs`).
   */
  maxEncodeMs: number;
  batchRows: number;
  batchMs: number;
  heartbeatMs: number;
  renewMs: number;
  /** Stop acknowledging the worker past this many pending rows. */
  pendingHighWater: number;
  /** Every Nth snapshot set also goes to the durable sink. */
  durableEvery: number;
  /**
   * Alert (and still write) when a snapshot would take redis-models past this
   * share of maxmemory. Only `redisMemoryHardRatio` refuses a snapshot: the
   * snapshot is what lets the stream be trimmed, so refusing it at the alert
   * line would lock the stream into growing until maxmemory.
   */
  redisMemoryRatio: number;
  /** Skip a snapshot when redis-models would pass this share of maxmemory (default 0.9). */
  redisMemoryHardRatio?: number;
  feeder: Pick<FeederStartOptions, 'scanDocsPerSec' | 'oplogWindowHintMs' | 'scanReadPreference' | 'scanBatchSize' | 'scanBufferBytes'>;
}

/**
 * Snapshot encode cap (§3.5). The default is today's hard-coded 20 s, and
 * `READ_MODELS_SNAPSHOT_ENCODE_TIMEOUT_MS` unset keeps it EXACTLY (no
 * row-count-derived default: the capacity plan measured ~17 s at 6.5M rows and
 * ~23 s at 8.8M, so above ~7.5M total rows every snapshot aborts and a cold
 * start never becomes ready until an operator raises it). The config getter
 * clamps the env var into [MIN, MAX]; MAX is half the 10-min "being written"
 * chunk TTL, so the first chunk of a set always outlives its encode.
 */
export const SNAPSHOT_ENCODE_TIMEOUT_DEFAULT_MS = 20_000;
export const SNAPSHOT_ENCODE_TIMEOUT_MIN_MS = 5_000;
export const SNAPSHOT_ENCODE_TIMEOUT_MAX_MS = 300_000;
/** `[alert] read_models.snapshot_encode_slow` once a committed encode takes more than this share of the cap. */
export const SNAPSHOT_ENCODE_WARN_RATIO = 0.75;
const ENCODE_TIMEOUT_ENV = 'READ_MODELS_SNAPSHOT_ENCODE_TIMEOUT_MS';

/**
 * The cap a snapshot encode actually runs under: `maxEncodeMs` (a non-finite
 * or non-positive value falls back to the 20 s default), never past half of
 * `writingTtlMs` — a chunk written at the start must not expire before the
 * manifest commits the set.
 */
export function snapshotEncodeCapMs(cfg: Pick<HolderConfig, 'maxEncodeMs' | 'writingTtlMs'>): number {
  const raw = Math.floor(cfg.maxEncodeMs);
  const cap = Number.isFinite(raw) && raw > 0 ? raw : SNAPSHOT_ENCODE_TIMEOUT_DEFAULT_MS;
  const ttl = Math.floor(cfg.writingTtlMs);
  return Number.isFinite(ttl) && ttl > 0 ? Math.min(cap, Math.max(1, Math.floor(ttl / 2))) : cap;
}

/** A cap that leaves the measured encode at ≤ 50%: 2 × encode, rounded up to 5 s, within the env var's bounds. */
export function suggestedSnapshotEncodeCapMs(encodeMs: number): number {
  const twice = Math.ceil((2 * Math.max(0, encodeMs)) / 5_000) * 5_000;
  return Math.min(SNAPSHOT_ENCODE_TIMEOUT_MAX_MS, Math.max(SNAPSHOT_ENCODE_TIMEOUT_MIN_MS, twice));
}

function encodeAdvice(encodeMs: number, capMs: number): string {
  const suggested = suggestedSnapshotEncodeCapMs(encodeMs);
  return suggested > capMs
    ? `raise ${ENCODE_TIMEOUT_ENV} to ≥ ${suggested} ms`
    : `${ENCODE_TIMEOUT_ENV} is already at ${capMs} ms (ceiling ${SNAPSHOT_ENCODE_TIMEOUT_MAX_MS} ms): fewer rows per feeder or a faster encode is needed`;
}

/**
 * The `snapshot_encode_slow` warning for a COMMITTED snapshot, or null while
 * the encode stays at or under `SNAPSHOT_ENCODE_WARN_RATIO` of the cap.
 */
export function snapshotEncodeSlowDetail(encodeMs: number, capMs: number, rows: number): string | null {
  if (!(capMs > 0) || !(encodeMs > capMs * SNAPSHOT_ENCODE_WARN_RATIO)) return null;
  const pct = Math.round((encodeMs / capMs) * 100);
  const perMillion = rows > 0 ? `, ~${Math.round(encodeMs / (rows / 1_000_000))} ms per 1M rows` : '';
  return `snapshot encode took ${encodeMs} ms for ${rows} rows — ${pct}% of the ${capMs} ms cap (${ENCODE_TIMEOUT_ENV})${perMillion}; past the cap every snapshot aborts and a cold start never becomes ready — ${encodeAdvice(encodeMs, capMs)}`;
}

/** The `snapshot_failed` detail for an encode that ran past its cap (not one aborted by its session ending). */
export function snapshotEncodeTimeoutDetail(message: string, elapsedMs: number, capMs: number, rows: number): string {
  return `${message} (${rows} rows; aborted, retried at the next interval — a cold start stays NOT READY while every snapshot times out) — ${encodeAdvice(elapsedMs, capMs)}`;
}

export const DEFAULT_HOLDER_CONFIG: Omit<HolderConfig, 'feeder' | 'snapshotIntervalMs' | 'liveTtlMs'> = {
  writingTtlMs: 10 * 60_000,
  supersededTtlMs: 120_000,
  maxEncodeMs: SNAPSHOT_ENCODE_TIMEOUT_DEFAULT_MS,
  batchRows: 1_000,
  batchMs: 500,
  heartbeatMs: 1_000,
  renewMs: 5_000,
  pendingHighWater: 50_000,
  durableEvery: 6,
  redisMemoryRatio: 0.7,
  redisMemoryHardRatio: 0.9,
};

export type HolderEnd =
  | { kind: 'stopped' }
  | { kind: 'lease_lost' }
  | { kind: 'fenced_out'; detail: string }
  | { kind: 'diverged'; detail: string }
  | { kind: 'new_epoch'; why: string }
  | { kind: 'oplog_too_short'; detail: string }
  | { kind: 'worker_failed'; detail: string };

export type HolderStart =
  | { kind: 'cold' }
  | { kind: 'resume'; rescan?: string[] }
  /** A new epoch continuing the store's position (redis-models lost, or a durable copy loaded). */
  | { kind: 'continue'; why: string };

export interface HolderDeps {
  store: ModelStore;
  transport: ModelsTransport;
  keys: RmKeys;
  lease: Lease;
  fence: number;
  inc: string;
  /** Served shard collections of the active models. */
  shards: ShardCollection[];
  createHost: () => FeederHost;
  sink: SnapshotSink;
  alerts: AlertLog;
  meter: FeederMeter;
  config: HolderConfig;
  /** Is the user read budget under pressure (the scans yield)? */
  pressure?: () => boolean;
  /** redis-state command channel (admin → holder). */
  popCommand?: () => Promise<string | null>;
  onCommandDone?: (record: Record<string, unknown>) => Promise<void>;
  onEnd: (end: HolderEnd) => void;
  log?: (message: string) => void;
  now?: () => number;
}

interface PendingRow {
  coll: string;
  model: ReadModelName;
  shard: ShardKey;
  oid: string;
  op: 'upsert' | 'delete';
  state?: Cell[];
}

interface Inflight {
  entry: DeltaEntry;
  rows: Map<string, PendingRow>;
  dicts: Array<{ table: string; value: string; id: number }>;
  attempts: number;
}

export type HolderPhase = 'building' | 'snapshotting' | 'running' | 'ended';

export class HolderSession {
  phase: HolderPhase = 'building';
  epoch = 0;
  inc: string;
  /** Position of the last APPENDED entry (ahead of the store while a snapshot holds it). */
  appended: StreamPosition;
  /** Newest stream position whose changes are all in pending / appended. */
  latestRt = '';
  latestCt = '0:0';
  /** The rt before the first change now blocked on a repair (heartbeats and batches must not pass it). */
  private frozenRt?: { rt: string; ct: string };
  lastCa = 0;
  lastAppendAt = 0;
  lastConfirmAt = 0;
  workerStats?: WorkerStats;
  startedAt: number;
  private readonly pending = new Map<string, PendingRow>();
  private readonly blocked = new Map<string, RowChange[]>();
  private readonly repairs = new Map<number, string>();
  private repairSeq = 0;
  private readonly rescanAfterRepair = new Set<string>();
  /** Rows / dictionary ids of entries appended while the store was held (applied at release). */
  private readonly overlayRows = new Map<string, PendingRow>();
  private readonly overlayDicts = new Map<string, Map<string, number>>();
  /** Tables reset by an entry appended while the store was held: their stored rows no longer count. */
  private readonly overlayResets = new Set<string>();
  private inflight?: Inflight;
  /** When the oldest change now in `pending` arrived (0 while `pending` is empty). */
  private pendingSince = 0;
  /** When the oldest change in the batch in flight arrived (0 while nothing is in flight). */
  private inflightSince = 0;
  private appendChain: Promise<unknown> = Promise.resolve();
  private messageChain: Promise<void> = Promise.resolve();
  private host!: FeederHost;
  private readonly timers: Array<ReturnType<typeof setInterval>> = [];
  private ended = false;
  private cold = false;
  private ticking = false;
  private snapshotting = false;
  /** True while THIS session holds the store for a snapshot encode (it releases only its own hold). */
  private holdOwned = false;
  /** The snapshot write in progress (stop() waits for it to settle). */
  private snapshotRun?: Promise<boolean>;
  private snapSeq = 0;
  private snapshotsWritten = 0;
  private lastSnapshotAt = 0;
  private changedSinceSnapshot = false;
  private liveManifest?: Manifest;
  private lastPressure?: boolean;
  private readonly shardByColl = new Map<string, ShardCollection>();
  private readonly now: () => number;
  private readonly cfg: HolderConfig;
  private ackWaiters: Array<() => void> = [];

  constructor(private readonly deps: HolderDeps) {
    this.now = deps.now ?? Date.now;
    this.cfg = deps.config;
    this.inc = deps.inc;
    this.appended = { ...deps.store.pos };
    this.startedAt = this.now();
    for (const shard of deps.shards) this.shardByColl.set(shard.coll, shard);
  }

  get fence(): number {
    return this.deps.fence;
  }

  get pendingRows(): number {
    return this.pending.size + (this.inflight?.rows.size ?? 0);
  }

  get blockedRows(): number {
    return this.blocked.size;
  }

  /**
   * §6.7 holder rule: nothing blocked, the last confirm ≤ 5 s old, and no change
   * waiting to be appended for longer than `unappendedFreshMs`.
   *
   * It used to require `pending` to be EMPTY. Under sustained writes a batch goes
   * out every ≥ 500 ms (`batchMs`) and `pending` refills in between, so on the M10
   * rig (backfill + refresh + fee writes) the models read not ready 14% of the
   * time — exactly during write bursts, which sent requests back to Mongo when it
   * was busiest — while their data was ~1.5 s behind. What matters is how OLD
   * the oldest unappended change is, not whether there is one.
   */
  caughtUp(now = this.now()): boolean {
    if (this.phase !== 'running' || this.blocked.size > 0 || now - this.lastCa > 5_000) return false;
    const oldest = Math.min(this.pending.size > 0 ? this.pendingSince : Infinity, this.inflight ? this.inflightSince : Infinity);
    return oldest === Infinity || now - oldest <= this.unappendedFreshMs();
  }

  /** How long a change may wait to be appended and still count as caught up: 4 batch periods, at least 2 s. */
  private unappendedFreshMs(): number {
    return Math.max(2_000, 4 * this.cfg.batchMs);
  }

  async start(start: HolderStart): Promise<void> {
    const { store } = this.deps;
    this.startTimers();
    if (start.kind === 'cold') {
      this.cold = true;
      this.epoch = Math.max(this.now(), store.pos.epoch + 1);
      store.clear();
      this.appended = { ...store.pos };
      this.deps.alerts.alert('read_models.cold_scan', `new epoch ${this.epoch}: cold scan of ${this.deps.shards.length} shard collection(s)`);
      this.startWorker({ kind: 'cold' });
      return;
    }
    if (start.kind === 'continue') {
      const pos = store.pos;
      const continues = { fence: pos.fence, epoch: pos.epoch, s: pos.s };
      this.epoch = Math.max(this.now(), pos.epoch + 1);
      store.pos = { ...pos, fence: this.fence, epoch: this.epoch, s: 0, inc: this.inc, id: (await this.deps.transport.tailId()) ?? '0-0' };
      this.appended = { ...store.pos };
      this.phase = 'snapshotting';
      if (!(await this.snapshotUntilWritten({ continues }))) return;
      this.deps.alerts.alert('read_models.epoch_continued', `${start.why}: epoch ${this.epoch} continues fence ${continues.fence} epoch ${continues.epoch} s=${continues.s}`);
    } else {
      this.epoch = store.pos.epoch;
      // A restarted session in the same (fence, epoch) must never reuse the live set's snapSeq.
      await this.adoptLiveManifest();
    }
    this.latestRt = store.pos.rt;
    this.latestCt = store.pos.ct;
    this.lastCa = store.pos.ca;
    this.phase = 'running';
    const rescan = new Set(start.kind === 'resume' ? start.rescan ?? [] : []);
    const known: string[] = [];
    const unsupported: string[] = [];
    for (const shard of this.deps.shards) {
      const table = store.table(shard.model, shardKey(shard.chainId, shard.protocol));
      if (!table) {
        rescan.add(shard.coll);
        continue;
      }
      if (table.state === 'unsupported') unsupported.push(shard.coll);
      else if (table.state === 'scanning' || table.missingLeaves.size > 0) rescan.add(shard.coll);
      else known.push(shard.coll);
    }
    if (!store.pos.rt) {
      this.end({ kind: 'new_epoch', why: 'no resume token in the model' });
      return;
    }
    this.startWorker({ kind: 'resume', rt: store.pos.rt, known, rescan: [...rescan], unsupported });
    for (const coll of unsupported) this.deps.log?.(`shard ${coll} stays unsupported (non-ObjectId _id)`);
  }

  private startWorker(start: FeederStartOptions['start']): void {
    this.host = this.deps.createHost();
    this.host.onMessage((message) => {
      // Repair results, alerts and stats need no ordering — and a repair result
      // must not wait behind a handler that is itself waiting for repairs
      // (the cold catch-up, a shard scan's end).
      // A `fatal` too: the worker exits right after posting it, and the exit must
      // not end the session as `worker_failed` while the ordered chain is busy.
      if (message.type === 'repairResult' || message.type === 'alert' || message.type === 'stats' || message.type === 'fatal') {
        void this.handle(message).catch((err) => this.end({ kind: 'diverged', detail: `holder: ${(err as Error)?.message ?? String(err)}` }));
        return;
      }
      this.messageChain = this.messageChain
        .then(() => this.handle(message))
        .catch((err) => this.end({ kind: 'diverged', detail: `holder: ${(err as Error)?.message ?? String(err)}` }));
    });
    this.host.onExit((error) => {
      if (this.ended) return;
      this.end({ kind: 'worker_failed', detail: error?.message ?? 'feeder worker exited' });
    });
    this.host.start({ ...this.cfg.feeder, shards: this.deps.shards, start });
  }

  /** Stop the session. `flush` (shutdown): append what is pending first (bounded). */
  async stop(opts: { flush?: boolean } = {}): Promise<void> {
    if (this.ended) return;
    if (opts.flush && this.phase === 'running') {
      await Promise.race([this.flushPending().catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 3_000).unref?.())]);
    }
    this.end({ kind: 'stopped' });
    // A snapshot encode in flight aborts (end) — wait for it to settle, so no
    // chunk of this session is written after the next session starts.
    if (this.snapshotRun) {
      await Promise.race([this.snapshotRun.catch(() => false), new Promise((resolve) => setTimeout(resolve, 5_000).unref?.())]);
    }
    await this.host?.stop().catch(() => undefined);
  }

  private end(end: HolderEnd): void {
    if (this.ended) return;
    this.ended = true;
    this.phase = 'ended';
    for (const timer of this.timers.splice(0)) clearInterval(timer);
    for (const wake of this.ackWaiters.splice(0)) wake();
    // Release only the hold THIS session took (a snapshot in flight then aborts
    // before its manifest: `writeSnapshot` checks `ended`). The store applies
    // the queued entries now, so the next session starts from every appended entry.
    this.releaseOwnHold();
    this.pending.clear();
    this.pendingSince = 0;
    this.blocked.clear();
    this.inflight = undefined;
    this.inflightSince = 0;
    void this.host?.stop().catch(() => undefined);
    this.deps.onEnd(end);
  }

  // ── worker messages ──

  private async handle(message: WorkerMessage): Promise<void> {
    if (this.ended) return;
    switch (message.type) {
      case 'probe':
        for (const probe of message.shards) {
          const shard = this.shardByColl.get(probe.coll);
          if (!shard) continue;
          const table = this.deps.store.ensureTable(shard.model, shardKey(shard.chainId, shard.protocol));
          table.state = probe.idType === 'bad' ? 'unsupported' : 'scanning';
        }
        return;
      case 't0':
        this.deps.log?.(`cold scan T0 = ${message.ct}`);
        return;
      case 'scanRows':
        for (const row of message.rows) this.merge(row);
        this.deps.meter.rows.add(message.rows.length);
        this.deps.meter.totals.rows += message.rows.length;
        await this.ack(message.seq);
        return;
      case 'buffer':
      case 'changes':
        for (const item of message.items) {
          this.merge(item);
          this.advance(item.rt, item.ct);
        }
        this.deps.meter.events.add(message.items.length);
        this.deps.meter.totals.events += message.items.length;
        await this.ack(message.seq);
        return;
      case 'catchUp':
        this.advance(message.rt, message.ct);
        await this.finishColdBuild();
        return;
      case 'confirm':
        this.lastCa = Math.max(this.lastCa, message.ca);
        this.lastConfirmAt = this.now();
        this.advance(message.rt, message.ct);
        return;
      case 'shardScanStart': {
        const shard = this.shardByColl.get(message.coll);
        if (!shard) return;
        this.deps.alerts.alert('read_models.shard_scan', `${message.coll}: ${message.reason}`);
        if (this.cold) return;
        await this.flushPending();
        await this.appendShard(shard, ['scanning', 'reset']);
        return;
      }
      case 'shardScanDone': {
        const shard = this.shardByColl.get(message.coll);
        if (!shard || this.cold) return;
        await this.waitRepairs(message.coll);
        await this.flushPending();
        await this.appendShard(shard, ['ready']);
        this.deps.log?.(`shard scan of ${message.coll} done (${message.rows} rows)`);
        return;
      }
      case 'shardDropped': {
        const shard = this.shardByColl.get(message.coll);
        if (!shard) return;
        if (this.cold) {
          const table = this.deps.store.ensureTable(shard.model, shardKey(shard.chainId, shard.protocol));
          table.reset();
          return;
        }
        await this.flushPending();
        await this.appendShard(shard, ['reset', 'ready']);
        return;
      }
      case 'shardUnsupported': {
        const shard = this.shardByColl.get(message.coll);
        if (!shard) return;
        if (this.cold) {
          const table = this.deps.store.ensureTable(shard.model, shardKey(shard.chainId, shard.protocol));
          table.reset();
          table.state = 'unsupported';
          return;
        }
        await this.flushPending();
        await this.appendShard(shard, ['unsupported']);
        return;
      }
      case 'repairResult':
        this.resolveRepair(message.reqId, message.coll, message.oid, message.state);
        return;
      case 'fatal':
        switch (message.reason) {
          case 'history_lost':
            this.deps.alerts.alert('read_models.history_lost', message.detail);
            this.end({ kind: 'new_epoch', why: `history lost: ${message.detail}` });
            return;
          case 'oplog_too_short':
            this.deps.alerts.alert('read_models.oplog_too_short', message.detail);
            this.end({ kind: 'oplog_too_short', detail: message.detail });
            return;
          case 'invalidate':
          case 'drop_database':
            this.deps.alerts.alert('read_models.history_lost', `${message.reason}: ${message.detail}`);
            this.end({ kind: 'new_epoch', why: message.reason });
            return;
          default:
            this.end({ kind: 'worker_failed', detail: message.detail });
            return;
        }
      case 'alert':
        this.deps.alerts.alert(message.name, message.detail);
        return;
      case 'stats':
        this.workerStats = message.stats;
        return;
    }
  }

  /** Acknowledge a row message — but not while too much is pending (backpressure). */
  private async ack(seq: number): Promise<void> {
    while (!this.ended && !this.cold && (this.pending.size >= this.cfg.pendingHighWater || (this.inflight?.attempts ?? 0) > 0)) {
      await new Promise<void>((resolve) => this.ackWaiters.push(resolve));
    }
    if (!this.ended) this.host.send({ type: 'ack', seq });
  }

  private wakeAckWaiters(): void {
    for (const wake of this.ackWaiters.splice(0)) wake();
  }

  private advance(rt: string | undefined, ct: string | undefined): void {
    if (!rt) return;
    const time = parseTime(ct) ?? tokenTime(rt);
    const current = parseTime(this.latestCt);
    if (time && current && compareTimes(time, current) < 0) return;
    this.latestRt = rt;
    if (time) this.latestCt = formatTime(time);
  }

  /** The rt / ct a new entry may claim: never past a change that is still blocked on a repair. */
  private safePosition(): { rt: string; ct: string } {
    return this.frozenRt ?? { rt: this.latestRt, ct: this.latestCt };
  }

  // ── merging changes ──

  private keyOf(coll: string, oid: string): string {
    return `${coll}|${oid}`;
  }

  private tableFor(shard: ShardCollection): ShardTable {
    return this.deps.store.ensureTable(shard.model, shardKey(shard.chainId, shard.protocol));
  }

  /** The newest known state of a row: pending → in flight → appended-unapplied → the store. */
  private currentRow(key: string, shard: ShardCollection, oid: string): PendingRow | undefined {
    const known = this.pending.get(key) ?? this.inflight?.rows.get(key) ?? this.overlayRows.get(key);
    if (known) return known;
    const table = this.tableFor(shard);
    if (this.overlayResets.has(ModelStore.key(table.model, table.shard))) return undefined;
    const slot = table.liveSlotOf(oid);
    if (slot < 0) return undefined;
    return { coll: shard.coll, model: shard.model, shard: table.shard, oid, op: 'upsert', state: table.cellsAt(slot) };
  }

  private merge(change: RowChange): void {
    const shard = this.shardByColl.get(change.coll);
    if (!shard) return;
    const key = this.keyOf(change.coll, change.oid);
    const queue = this.blocked.get(key);
    if (queue) {
      queue.push(change);
      return;
    }
    const base: Omit<PendingRow, 'op' | 'state'> = { coll: shard.coll, model: shard.model, shard: shardKey(shard.chainId, shard.protocol), oid: change.oid };
    if (change.base === 'state') {
      this.put(key, { ...base, op: 'upsert', state: applySets(change.state ?? [], change.sets ?? []) });
      return;
    }
    if (change.base === 'delete') {
      this.put(key, { ...base, op: 'delete' });
      return;
    }
    const current = this.currentRow(key, shard, change.oid);
    if (current && current.op === 'upsert' && current.state) {
      this.put(key, { ...base, op: 'upsert', state: applySets(current.state, change.sets ?? []) });
      return;
    }
    // An update for a row we do not have: a scan miss (or a row deleted and
    // never re-inserted): repair read, then the queued changes on top (§3.3).
    this.block(key, shard, change);
  }

  private put(key: string, row: PendingRow): void {
    if (this.cold) {
      this.applyDirect(row);
      return;
    }
    if (this.pending.size === 0) this.pendingSince = this.now();
    this.pending.set(key, row);
  }

  /** Cold build: straight into the store (no stream yet; ids minted directly). */
  private applyDirect(row: PendingRow): void {
    const shard = this.shardByColl.get(row.coll)!;
    const table = this.tableFor(shard);
    if (row.op === 'delete') {
      table.delete(row.oid);
      return;
    }
    table.upsert(row.oid, encodeCells(table.leaves, row.state!, (value) => table.dict.intern(value)));
  }

  private block(key: string, shard: ShardCollection, change: RowChange): void {
    if (this.blocked.size === 0 && !this.frozenRt) this.frozenRt = { rt: this.latestRt, ct: this.latestCt };
    this.blocked.set(key, [change]);
    const reqId = ++this.repairSeq;
    this.repairs.set(reqId, key);
    this.deps.meter.repairs++;
    this.host.send({ type: 'repair', reqId, coll: shard.coll, oid: change.oid, afterCt: change.ct ?? this.latestCt });
  }

  private resolveRepair(reqId: number, coll: string, oid: string, state: Cell[] | null): void {
    const key = this.repairs.get(reqId);
    this.repairs.delete(reqId);
    if (!key) return;
    const queue = this.blocked.get(key) ?? [];
    this.blocked.delete(key);
    const shard = this.shardByColl.get(coll);
    if (shard && state) {
      // The document exists and was not in the model: a genuine miss.
      this.deps.alerts.alert('read_models.repair', `${coll} ${oid}: an update arrived for a row the model did not hold (scan miss) — repaired; the shard will be rescanned`);
      this.rescanAfterRepair.add(coll);
      this.put(key, { coll, model: shard.model, shard: shardKey(shard.chainId, shard.protocol), oid, op: 'upsert', state });
    }
    // Replay the queued changes on top (a null repair: the document is gone; its updates are moot).
    for (const change of queue) {
      if (!state && change.base === 'none') continue;
      this.merge(change);
    }
    if (this.blocked.size === 0) {
      this.frozenRt = undefined;
      if (!this.cold) {
        for (const c of this.rescanAfterRepair) this.host.send({ type: 'rescan', coll: c, reason: 'repair' });
        this.rescanAfterRepair.clear();
      }
    }
  }

  private async waitRepairs(coll?: string): Promise<void> {
    const pending = () => [...this.blocked.keys()].some((key) => coll === undefined || key.startsWith(`${coll}|`));
    while (!this.ended && pending()) await sleep(50);
  }

  // ── the cold build's end (§3.2 step 7) ──

  private async finishColdBuild(): Promise<void> {
    await this.waitRepairs();
    if (this.ended) return;
    const { store } = this.deps;
    for (const table of store.tables.values()) if (table.state === 'scanning') table.state = 'ready';
    store.pos = {
      fence: this.fence,
      epoch: this.epoch,
      s: 0,
      id: (await this.deps.transport.tailId().catch(() => null)) ?? '0-0',
      rt: this.latestRt,
      ct: this.latestCt,
      ca: 0,
      inc: this.inc,
    };
    this.appended = { ...store.pos };
    this.cold = false;
    this.phase = 'snapshotting';
    if (!(await this.snapshotUntilWritten({}))) return;
    this.phase = 'running';
    this.deps.alerts.alert('read_models.cold_scan_done', `epoch ${this.epoch}: ${[...store.tables.values()].reduce((n, t) => n + t.live, 0)} rows; snapshot #1 written`);
    for (const coll of this.rescanAfterRepair) this.host.send({ type: 'rescan', coll, reason: 'repair' });
    this.rescanAfterRepair.clear();
  }

  /** Write a snapshot, retrying until it lands (an epoch start cannot append before its manifest). */
  private async snapshotUntilWritten(opts: { continues?: Manifest['continues'] }): Promise<boolean> {
    for (let attempt = 1; !this.ended; attempt++) {
      if (await this.writeSnapshot(opts)) return true;
      await sleep(Math.min(30_000, 2_000 * attempt));
    }
    return false;
  }

  // ── appends ──

  /** Serialise every append (batches, shard marks, heartbeats). */
  private withAppendLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.appendChain.then(fn, fn);
    this.appendChain = next.catch(() => undefined);
    return next;
  }

  /** Append until nothing is pending (used before a shard mark, and at shutdown). */
  async flushPending(): Promise<void> {
    while (!this.ended && (this.pending.size > 0 || this.inflight)) {
      const ok = await this.withAppendLock(() => this.appendBatch());
      if (!ok) await sleep(250);
    }
  }

  private async appendShard(shard: ShardCollection, states: ShardRecordState[]): Promise<void> {
    const key = shardKey(shard.chainId, shard.protocol);
    const records: DeltaRecord[] = states.map((state) => ({ t: 'shard', model: shard.model, shard: key, state }));
    const resets = states.some((state) => state === 'reset' || state === 'unsupported') ? [ModelStore.key(shard.model, key)] : [];
    for (;;) {
      if (this.ended) return;
      const ok = await this.withAppendLock(() => this.appendEntry('shard', encodePayload(records), resets));
      if (ok) return;
      await sleep(250);
    }
  }

  /** Build (or retry) the batch and append it. True when nothing is left in flight. */
  private async appendBatch(): Promise<boolean> {
    if (!this.inflight) {
      this.inflight = this.buildBatch();
      if (!this.inflight) return true;
    }
    const inflight = this.inflight;
    const result = await this.appendRaw(inflight.entry, { rows: inflight.rows, dicts: inflight.dicts });
    if (result === 'ok') {
      this.deps.meter.batchRowsLast = inflight.rows.size;
      this.deps.meter.batches.add();
      this.deps.meter.totals.batches++;
      this.deps.meter.totals.batchRows += inflight.rows.size;
      this.inflight = undefined;
      this.inflightSince = 0;
      this.wakeAckWaiters();
      return true;
    }
    inflight.attempts++;
    if (result === 'rebuild') {
      // Put the rows back (newer pending states win) and rebuild under the new epoch / incarnation.
      for (const [key, row] of inflight.rows) if (!this.pending.has(key)) this.pending.set(key, row);
      // The rows put back are the oldest changes now pending.
      if (this.pending.size > 0) this.pendingSince = Math.min(this.pendingSince || Infinity, this.inflightSince || this.now());
      this.inflight = undefined;
      this.inflightSince = 0;
    }
    return false;
  }

  private buildBatch(): Inflight | undefined {
    if (this.pending.size === 0) return undefined;
    const rows = new Map(this.pending);
    this.pending.clear();
    this.inflightSince = this.pendingSince || this.now();
    this.pendingSince = 0;
    const dictRecords: DeltaRecord[] = [];
    const rowRecords: DeltaRecord[] = [];
    const dicts: Inflight['dicts'] = [];
    const tentative = new Map<string, Map<string, number>>();
    for (const [key, row] of rows) {
      const shard = this.shardByColl.get(row.coll);
      if (!shard) continue;
      const table = this.tableFor(shard);
      const tableKey = ModelStore.key(row.model, row.shard);
      const overlay = this.overlayRows.get(key);
      const slot = this.overlayResets.has(tableKey) ? -1 : table.liveSlotOf(row.oid);
      const liveNow = overlay ? overlay.op === 'upsert' : slot >= 0;
      if (row.op === 'delete') {
        if (!liveNow) {
          rows.delete(key);
          this.deps.meter.noops.add();
          this.deps.meter.totals.noops++;
          continue;
        }
        rowRecords.push({ t: 'delete', model: row.model, shard: row.shard, oid: row.oid });
        continue;
      }
      // No-op drop: the newest appended state already equals this one.
      const same = overlay ? overlay.op === 'upsert' && rowsEqual(overlay.state!, row.state!) : slot >= 0 && table.sameAs(slot, row.state!);
      if (same) {
        rows.delete(key);
        this.deps.meter.noops.add();
        this.deps.meter.totals.noops++;
        continue;
      }
      let tent = tentative.get(tableKey);
      const intern = (value: string): number => {
        const found = table.dict.find(value);
        if (found >= 0) return found;
        const held = this.overlayDicts.get(tableKey)?.get(value);
        if (held !== undefined) return held;
        tent ??= new Map();
        tentative.set(tableKey, tent);
        let id = tent.get(value);
        if (id === undefined) {
          id = table.dict.size + (this.overlayDicts.get(tableKey)?.size ?? 0) + tent.size;
          tent.set(value, id);
          dictRecords.push({ t: 'dict', model: row.model, shard: row.shard, id, value });
          dicts.push({ table: tableKey, value, id });
        }
        return id;
      };
      rowRecords.push({ t: 'upsert', model: row.model, shard: row.shard, oid: row.oid, row: encodeCells(table.leaves, row.state!, intern) });
    }
    if (rowRecords.length === 0) return undefined;
    const position = this.safePosition();
    const entry: DeltaEntry = {
      f: this.fence,
      e: this.epoch,
      inc: this.inc,
      s: this.appended.s + 1,
      ct: position.ct,
      rt: position.rt,
      k: 'batch',
      ca: this.lastCa,
      d: encodePayload([...dictRecords, ...rowRecords]),
      ...(this.frozenRt ? { fz: true } : {}),
    };
    return { entry, rows, dicts, attempts: 0 };
  }

  private async appendEntry(kind: 'shard' | 'heartbeat', payload: Uint8Array, resets: string[] = []): Promise<boolean> {
    const position = this.safePosition();
    const entry: DeltaEntry = {
      f: this.fence,
      e: this.epoch,
      inc: this.inc,
      s: this.appended.s + 1,
      ct: position.ct,
      rt: position.rt,
      k: kind,
      ca: this.lastCa,
      d: payload,
      ...(this.frozenRt ? { fz: true } : {}),
    };
    const result = await this.appendRaw(entry, { resets });
    return result === 'ok';
  }

  /** One fenced append + apply-after-append. */
  private async appendRaw(
    entry: DeltaEntry,
    overlay: { rows?: Map<string, PendingRow>; dicts?: Inflight['dicts']; resets?: string[] } = {},
  ): Promise<'ok' | 'retry' | 'rebuild' | 'ended'> {
    // An epoch's first entry only after its manifest (§3.2 step 7, §3.6): wait out an
    // epoch-start snapshot or a redis-models recovery.
    while (!this.ended && (this.phase === 'snapshotting' || this.recovering)) await sleep(50);
    if (this.ended) return 'ended';
    if (entry.e !== this.epoch || entry.inc !== this.inc) return 'rebuild';
    const started = this.now();
    let outcome;
    try {
      outcome = await this.deps.transport.append(entry, this.cfg.liveTtlMs);
    } catch (err) {
      this.deps.meter.appendFailures++;
      this.deps.alerts.alert('read_models.append_failed', `${(err as Error)?.message ?? String(err)} — retrying the same entry; the worker is held`);
      return 'retry';
    }
    if (this.ended) return 'ended';
    if (outcome.ok) {
      const applied: DeltaEntry = { ...entry, id: outcome.id };
      this.applyAppended(applied, overlay);
      this.deps.meter.appendMsLast = this.now() - started;
      this.deps.meter.appendedBytes.add(entry.d.byteLength);
      return 'ok';
    }
    this.deps.meter.appendFailures++;
    switch (outcome.reason) {
      case 'fence_mismatch':
        this.deps.alerts.alert('read_models.lease_lost', `fenced out: redis-models holds fence ${outcome.detail}, ours is ${this.fence}`);
        this.end({ kind: 'fenced_out', detail: outcome.detail });
        return 'ended';
      case 'fence_missing':
      case 'inc_missing':
      case 'inc_mismatch':
        await this.recoverRedisModels(`append refused: ${outcome.reason}`);
        return this.ended ? 'ended' : 'rebuild';
      case 'seq_gap': {
        // An earlier attempt of THIS entry may have landed with its reply lost
        // (a command timeout, a reconnect): the cursor then holds our own entry.
        const landed = await this.landedAs(entry).catch(() => null);
        if (this.ended) return 'ended';
        if (landed) {
          // Apply what the stream holds (consumers apply exactly that entry).
          this.applyAppended(landed, overlay);
          this.deps.meter.appendMsLast = this.now() - started;
          this.deps.meter.appendedBytes.add(entry.d.byteLength);
          this.deps.alerts.alert('read_models.append_recovered', `s=${entry.s} epoch=${entry.e} had landed (id ${landed.id}) though its reply was lost — applied`);
          return 'ok';
        }
        this.end({ kind: 'diverged', detail: `append refused: ${outcome.reason} (cursor ${outcome.detail}, s=${entry.s} epoch=${entry.e})` });
        return 'ended';
      }
      case 'epoch_behind':
        this.end({ kind: 'diverged', detail: `append refused: ${outcome.reason} (cursor ${outcome.detail}, s=${entry.s} epoch=${entry.e})` });
        return 'ended';
      default:
        return 'retry';
    }
  }

  /**
   * The stream entry `entry` already landed as, or null: the cursor names
   * (epoch, s, fence) of `entry` AND the entry right after our last applied one
   * carries the same fence, epoch, s, incarnation, kind and byte-identical
   * payload. Its position fields (rt / ct / ca) may be older — a heartbeat or a
   * shard mark is rebuilt per attempt — and the caller applies the STREAM's
   * entry, so the store always equals what consumers apply. A different entry
   * that merely shares the sequence (e.g. a late append of a previous session
   * with other rows) never matches.
   */
  private async landedAs(entry: DeltaEntry): Promise<DeltaEntry | null> {
    const { transport } = this.deps;
    const cursor = await transport.cursor();
    if (!cursor || cursor.epoch !== entry.e || cursor.s !== entry.s || cursor.fence !== entry.f) return null;
    const next = await transport.range(this.appended.id, 2);
    const found = next.find((e) => e.id === cursor.id);
    if (!found) return null;
    const same = found.f === entry.f && found.e === entry.e && found.s === entry.s && found.inc === entry.inc && found.k === entry.k && bytesEqual(found.d, entry.d);
    return same ? { ...found, id: cursor.id } : null;
  }

  private releaseOwnHold(): void {
    if (!this.holdOwned) return;
    this.holdOwned = false;
    this.deps.store.release();
    this.clearOverlay();
  }

  /** Take the committed manifest as the live one when this session has none yet (snapSeq, TTLs, the memory estimate). */
  private async adoptLiveManifest(): Promise<void> {
    if (this.liveManifest) return;
    const live = await this.deps.transport.manifest().catch(() => null);
    if (live && !this.liveManifest && !this.ended) this.liveManifest = live;
  }

  private applyAppended(entry: DeltaEntry, overlay: { rows?: Map<string, PendingRow>; dicts?: Inflight['dicts']; resets?: string[] }): void {
    const { store } = this.deps;
    const held = store.isHeld;
    store.applyEntry(entry);
    if (held) {
      // The store applies this at release: until then merges and no-op checks read the overlay.
      for (const table of overlay.resets ?? []) {
        this.overlayResets.add(table);
        for (const key of [...this.overlayRows.keys()]) {
          const row = this.overlayRows.get(key)!;
          if (ModelStore.key(row.model, row.shard) === table) this.overlayRows.delete(key);
        }
      }
      for (const [key, row] of overlay.rows ?? []) this.overlayRows.set(key, row);
      for (const add of overlay.dicts ?? []) {
        const map = this.overlayDicts.get(add.table) ?? new Map<string, number>();
        map.set(add.value, add.id);
        this.overlayDicts.set(add.table, map);
      }
    }
    this.appended = positionOf(entry);
    this.lastAppendAt = this.now();
    this.changedSinceSnapshot = true;
  }

  private clearOverlay(): void {
    this.overlayRows.clear();
    this.overlayDicts.clear();
    this.overlayResets.clear();
  }

  // ── redis-models lost (§3.6) ──

  private recovering = false;

  private async recoverRedisModels(why: string): Promise<void> {
    if (this.recovering || this.ended) return;
    this.recovering = true;
    try {
      this.deps.alerts.alert('read_models.redis_flush', `${why}: re-creating the incarnation and continuing in a new epoch (no cold scan)`);
      if (!(await this.deps.lease.renew())) {
        this.end({ kind: 'lease_lost' });
        return;
      }
      const { inc } = await this.deps.transport.ensureIncarnation(this.cfg.liveTtlMs);
      if (!(await this.deps.transport.seedFence(this.fence, this.cfg.liveTtlMs))) {
        this.end({ kind: 'fenced_out', detail: 'a greater fence is on the new incarnation' });
        return;
      }
      // Every appended entry must be in the store before it is snapshotted.
      while (this.snapshotting) await sleep(50);
      this.releaseOwnHold();
      const pos = this.deps.store.pos;
      const continues = { fence: pos.fence, epoch: pos.epoch, s: pos.s };
      this.inc = inc;
      this.epoch = Math.max(this.now(), this.epoch + 1);
      this.deps.store.pos = { ...pos, fence: this.fence, epoch: this.epoch, s: 0, inc, id: (await this.deps.transport.tailId().catch(() => null)) ?? '0-0' };
      this.appended = { ...this.deps.store.pos };
      this.liveManifest = undefined;
      await this.snapshotUntilWritten({ continues });
    } catch (err) {
      this.deps.alerts.alert('read_models.redis_flush', `recovery failed: ${(err as Error)?.message ?? String(err)} — will retry`);
    } finally {
      // The phase is never restored here: an epoch-start snapshot loop sets
      // `running` itself once its snapshot is in, and recovery never changes it.
      this.recovering = false;
    }
  }

  // ── snapshots (§3.5) ──

  /** Write a snapshot now; false when skipped or failed (alerted). */
  writeSnapshot(opts: { continues?: Manifest['continues'] } = {}): Promise<boolean> {
    if (this.snapshotting || this.ended) return Promise.resolve(false);
    const run = this.writeSnapshotNow(opts);
    this.snapshotRun = run;
    return run;
  }

  private async writeSnapshotNow(opts: { continues?: Manifest['continues'] }): Promise<boolean> {
    this.snapshotting = true;
    const { store, transport, keys, sink, meter, alerts } = this.deps;
    /** Set when the encode starts: the cap it runs under and the rows it encodes (the alerts quote both). */
    let encode: { started: number; capMs: number; rows: number } | undefined;
    try {
      await this.adoptLiveManifest();
      const memory = await transport.memory().catch(() => null);
      const estimate = this.liveManifest?.stored ?? Math.ceil(store.memoryBytes * 0.5);
      if (memory && memory.max > 0) {
        const hard = this.cfg.redisMemoryHardRatio ?? DEFAULT_HOLDER_CONFIG.redisMemoryHardRatio!;
        if (memory.used + estimate > memory.max * Math.max(hard, this.cfg.redisMemoryRatio)) {
          alerts.alert('read_models.redis_memory', `snapshot skipped: used ${memory.used} + ~${estimate} B would pass ${Math.round(Math.max(hard, this.cfg.redisMemoryRatio) * 100)}% of maxmemory ${memory.max}`);
          meter.snapshots.failed++;
          return false;
        }
        if (memory.used + estimate > memory.max * this.cfg.redisMemoryRatio) {
          // Still written: the stream is trimmed only after a snapshot, so this is what frees memory.
          alerts.alert('read_models.redis_memory', `snapshot written although used ${memory.used} + ~${estimate} B passes ${Math.round(this.cfg.redisMemoryRatio * 100)}% of maxmemory ${memory.max} (the stream trim after it frees memory)`);
        }
      }
      if (this.ended) return false;
      const durable = sink.kind !== 'none' && (this.snapshotsWritten + 1) % this.cfg.durableEvery === 1 % this.cfg.durableEvery;
      const snapSeq = Math.max(this.snapSeq, this.liveManifest?.snapSeq ?? 0) + 1;
      store.hold();
      this.holdOwned = true;
      try {
        encode = { started: this.now(), capMs: snapshotEncodeCapMs(this.cfg), rows: this.heldRows() };
        const manifest = await writeSnapshotSet({
          transport,
          keys,
          store,
          head: { fence: this.fence, epoch: this.epoch, inc: this.inc, snapSeq, continues: opts.continues },
          writingTtlMs: this.cfg.writingTtlMs,
          maxEncodeMs: encode.capMs,
          copy: durable ? sink : undefined,
          now: this.now,
          // The session ended mid-encode: its hold is released, the tables move on.
          aborted: () => this.ended || !this.holdOwned,
        });
        // No await between this check and the manifest switch.
        if (this.ended || !this.holdOwned) throw new SnapshotAbortedError('snapshot aborted before its manifest: the holder session ended');
        const outcome = await transport.putManifest(manifest, this.cfg.liveTtlMs);
        if (outcome === 'fence_mismatch') {
          this.end({ kind: 'fenced_out', detail: 'manifest write refused' });
          return false;
        }
        if (outcome !== 'ok') {
          if (this.ended) return false;
          alerts.alert('read_models.snapshot_failed', `manifest write refused: ${outcome}`);
          meter.snapshots.failed++;
          void this.recoverRedisModels(`manifest write refused: ${outcome}`);
          return false;
        }
        const previous = this.liveManifest;
        this.liveManifest = manifest;
        this.snapSeq = manifest.snapSeq;
        this.snapshotsWritten++;
        this.lastSnapshotAt = this.now();
        this.changedSinceSnapshot = this.appended.s !== manifest.s || this.appended.epoch !== manifest.epoch;
        meter.snapshots = {
          written: meter.snapshots.written + 1,
          failed: meter.snapshots.failed,
          lastAt: this.lastSnapshotAt,
          lastBytes: manifest.stored,
          lastEncodeMs: manifest.encodeMs,
          lastRows: manifest.shards.reduce((n, s) => n + s.rows, 0),
        };
        const slow = snapshotEncodeSlowDetail(manifest.encodeMs, encode.capMs, meter.snapshots.lastRows);
        if (slow) alerts.alert('read_models.snapshot_encode_slow', slow);
        await transport.expire(chunkKeys(keys, manifest), this.cfg.liveTtlMs).catch(() => undefined);
        if (previous && `${previous.fence}:${previous.epoch}:${previous.snapSeq}` !== `${manifest.fence}:${manifest.epoch}:${manifest.snapSeq}`) {
          await transport.expire(chunkKeys(keys, previous), this.cfg.supersededTtlMs).catch(() => undefined);
        }
        if (durable) await sink.commit(manifest).catch((err) => alerts.alert('read_models.durable_snapshot_failed', String((err as Error)?.message ?? err)));
        // Retention: 2 × the interval, never past the live manifest.
        const timeMin = `${Math.max(0, this.now() - 2 * this.cfg.snapshotIntervalMs)}-0`;
        const minId = compareStreamIds(timeMin, manifest.streamId) < 0 ? timeMin : manifest.streamId;
        await transport.trim(minId).catch(() => undefined);
        return true;
      } finally {
        this.releaseOwnHold();
      }
    } catch (err) {
      meter.snapshots.failed++;
      if (this.ended) return false;
      const elapsed = encode ? this.now() - encode.started : 0;
      if (err instanceof SnapshotAbortedError && encode && elapsed > encode.capMs) {
        alerts.alert('read_models.snapshot_failed', snapshotEncodeTimeoutDetail(err.message, elapsed, encode.capMs, encode.rows));
        return false;
      }
      alerts.alert('read_models.snapshot_failed', err instanceof SnapshotAbortedError ? `${err.message} (aborted; retried at the next interval)` : (err as Error)?.message ?? String(err));
      return false;
    } finally {
      this.snapshotting = false;
    }
  }

  /** Live rows of the active models' tables (what a snapshot encodes). */
  private heldRows(): number {
    const { store } = this.deps;
    let rows = 0;
    for (const table of store.tables.values()) if (store.models.has(table.model)) rows += table.live;
    return rows;
  }

  // ── timers ──

  private startTimers(): void {
    const every = (ms: number, fn: () => unknown) => {
      const timer = setInterval(() => void Promise.resolve().then(fn).catch(() => undefined), ms);
      timer.unref?.();
      this.timers.push(timer);
    };
    every(100, () => this.tick());
    every(this.cfg.renewMs, () => this.renew());
    every(this.cfg.snapshotIntervalMs, () => this.periodicSnapshot());
    every(Math.min(60_000, Math.max(5_000, Math.floor(this.cfg.liveTtlMs / 10))), () => this.refreshTtls());
    every(1_000, () => this.housekeeping());
  }

  private async tick(): Promise<void> {
    if (this.phase !== 'running' || this.ticking || this.ended) return;
    this.ticking = true;
    try {
      const now = this.now();
      if (this.inflight || this.pending.size >= this.cfg.batchRows || (this.pending.size > 0 && now - this.lastAppendAt >= this.cfg.batchMs)) {
        await this.withAppendLock(() => this.appendBatch());
      } else if (this.pending.size === 0 && now - this.lastAppendAt >= this.cfg.heartbeatMs) {
        const ok = await this.withAppendLock(() => this.appendEntry('heartbeat', EMPTY_PAYLOAD));
        if (ok) this.deps.meter.heartbeats++;
      }
    } finally {
      this.ticking = false;
    }
  }

  private async renew(): Promise<void> {
    if (this.ended) return;
    if (!(await this.deps.lease.renew())) {
      this.deps.alerts.alert('read_models.lease_lost', `lease renew failed (fence ${this.fence})`);
      this.end({ kind: 'lease_lost' });
      return;
    }
    try {
      if (!(await this.deps.transport.seedFence(this.fence, this.cfg.liveTtlMs))) {
        this.end({ kind: 'fenced_out', detail: 'a greater fence copy is on redis-models' });
      }
    } catch {
      // redis-models unreachable: the next append says so.
    }
  }

  private async periodicSnapshot(): Promise<void> {
    if (this.phase !== 'running' || this.ended) return;
    if (this.changedSinceSnapshot) await this.writeSnapshot();
  }

  private async refreshTtls(): Promise<void> {
    if (this.phase !== 'running' || this.ended) return;
    const { transport, keys } = this.deps;
    try {
      const { inc, created } = await transport.ensureIncarnation(this.cfg.liveTtlMs);
      if (created || inc !== this.inc) {
        await this.recoverRedisModels(`incarnation ${created ? 'missing' : 'changed'}`);
        return;
      }
      const live = this.liveManifest ? chunkKeys(keys, this.liveManifest) : [];
      await transport.expire([keys.manifest, keys.deltas, keys.cursor, keys.fenceCopy, ...live], this.cfg.liveTtlMs);
    } catch {
      // unreachable now: retried at the next interval
    }
  }

  private async housekeeping(): Promise<void> {
    if (this.ended) return;
    const now = this.now();
    // Scans yield to user reads.
    const under = this.deps.pressure?.() ?? false;
    if (under !== this.lastPressure) {
      this.lastPressure = under;
      this.host?.send({ type: 'pressure', under });
      if (under) readPathMeter.readModelScanYield();
    }
    if (this.phase === 'running') {
      if (this.lastCa > 0 && now - this.lastCa > 10_000) {
        this.deps.alerts.alert('read_models.feeder_lag', `last confirmed caught up ${Math.round((now - this.lastCa) / 1000)} s ago (pending ${this.pending.size}, blocked ${this.blocked.size})`);
      }
      const resumeTime = tokenTime(this.latestRt);
      if (resumeTime && now - resumeTime.t * 1000 > this.cfg.feeder.oplogWindowHintMs / 2) {
        this.deps.alerts.alert('read_models.resume_age', `the resume point is ${Math.round((now - resumeTime.t * 1000) / 60_000)} min old (oplog window hint ${Math.round(this.cfg.feeder.oplogWindowHintMs / 60_000)} min)`);
      }
      if (this.lastSnapshotAt > 0 && now - this.lastSnapshotAt > 2 * this.cfg.snapshotIntervalMs) {
        this.deps.alerts.alert('read_models.snapshot_gap', `the live manifest is ${Math.round((now - this.lastSnapshotAt) / 1000)} s old (interval ${Math.round(this.cfg.snapshotIntervalMs / 1000)} s)`);
      }
    }
    await this.pollCommand().catch(() => undefined);
  }

  // ── admin commands (§14) ──

  private async pollCommand(): Promise<void> {
    if (!this.deps.popCommand || this.phase !== 'running') return;
    const raw = await this.deps.popCommand();
    if (!raw) return;
    let command: Record<string, unknown>;
    try {
      command = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const result = await this.runCommand(command);
    await this.deps.onCommandDone?.({ ...command, result, doneAt: new Date(this.now()).toISOString(), fence: this.fence });
  }

  async runCommand(command: Record<string, unknown>): Promise<string> {
    switch (command.type) {
      case 'rescan': {
        const model = command.model === 'rank' || command.model === 'pools' ? command.model : undefined;
        if (!model) return 'refused: model must be rank or pools';
        if (typeof command.shard === 'string' && command.shard) {
          const shard = this.deps.shards.find((s) => s.model === model && shardKey(s.chainId, s.protocol) === command.shard);
          if (!shard) return `refused: ${model} ${command.shard} is not a served shard`;
          this.host.send({ type: 'rescan', coll: shard.coll, reason: 'admin' });
          return `shard scan of ${shard.coll} started`;
        }
        this.end({ kind: 'new_epoch', why: 'admin rescan' });
        return 'new epoch with a full cold scan';
      }
      case 'scan': {
        // Lane B's verification scan is paced by the read-models service, not the feeder.
        if (command.target === 'verify') return `verification scan ${String(command.action ?? 'paced')} (lane B)`;
        if (command.action === 'pause') this.host.send({ type: 'pause' });
        else if (command.action === 'resume') this.host.send({ type: 'resume' });
        if (typeof command.docsPerSec === 'number' && command.docsPerSec > 0) this.host.send({ type: 'pace', docsPerSec: Math.min(5_000, command.docsPerSec) });
        return `scan ${String(command.action ?? 'paced')}`;
      }
      case 'snapshot':
        return (await this.writeSnapshot()) ? 'snapshot written' : 'snapshot not written (see alerts)';
      case 'sweep': {
        const result = await sweepModels(this.deps.transport, this.deps.keys, { writingTtlMs: this.cfg.writingTtlMs });
        return `swept ${result.sweptSets.length} set(s), ${result.sweptKeys} key(s)`;
      }
      default:
        return `refused: unknown command ${String(command.type)}`;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}
