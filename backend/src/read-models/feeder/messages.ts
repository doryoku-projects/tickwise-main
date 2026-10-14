import type { Cell } from '../core/cells.js';
import type { ReadModelName } from '../core/fields.js';
import type { LeafSet } from './normalize.js';

/**
 * The feeder worker's protocol (worker ↔ main thread).
 *
 * Split of work (design §2.4, with one deviation recorded in the docs): the
 * WORKER owns everything that talks to Mongo — its own client, the change
 * stream, the paced scans, the scan buffers, repair reads — and normalises
 * documents and update descriptions into `RowChange`s. The MAIN thread owns
 * the model: it coalesces changes per row, drops no-ops, mints dictionary
 * ids, encodes, appends (fenced) and applies. Every message from the worker
 * is applied IN ORDER, and every message that carries rows is acknowledged
 * (`ack`) before the worker sends the next one — that is the backpressure:
 * a main thread whose appends fail stops acknowledging, and the worker stops
 * reading the change stream.
 */

/** One normalised change to one row. */
export interface RowChange {
  /** The collection (namespace) it happened in. */
  coll: string;
  /** The `_id` (24-hex ObjectId). */
  oid: string;
  /**
   * `state`  — insert / replace / scan row / repaired row: `state` is the full row;
   * `delete` — the row is gone;
   * `none`   — an update: `sets` apply on top of the row's current state.
   * A coalesced scan-buffer record may carry `state` + `sets` (sets after the base).
   */
  base: 'none' | 'state' | 'delete';
  state?: Cell[];
  sets?: LeafSet[];
  /** Resume token `_data` of the (last) change-stream event folded in. */
  rt?: string;
  /** Its cluster time, `t:i`. */
  ct?: string;
}

/** A served shard collection, as the worker is told about it. */
export interface ShardCollection {
  coll: string;
  model: ReadModelName;
  chainId: number;
  protocol: string;
}

export type IdProbe = 'ok' | 'empty' | 'bad';

export interface FeederStartOptions {
  /** The shard collections the feeder may serve (enabled integrations × active models). */
  shards: ShardCollection[];
  /**
   * `cold` — probes, T0, stream opened at T0, paced scans of every shard,
   *          catch-up, then live (§3.2);
   * `resume` — live from the change stream after `rt`; `known` lists the
   *          collections the model already holds (anything else first seen in
   *          the stream gets a shard scan); `rescan` lists collections whose
   *          scan must (re)start at once (left `scanning` by a previous holder,
   *          or newly activated); `unsupported` lists collections the model
   *          marked unsupported (their events are ignored).
   */
  start: { kind: 'cold' } | { kind: 'resume'; rt: string; known: string[]; rescan: string[]; unsupported?: string[] };
  scanDocsPerSec: number;
  oplogWindowHintMs: number;
  /** Read preference of the scans and repair reads (`secondary` in production). */
  scanReadPreference: 'secondary' | 'secondaryPreferred';
  /** Rows per scan batch (2000). */
  scanBatchSize?: number;
  /** Scan-buffer cap in estimated bytes. */
  scanBufferBytes?: number;
}

// ── worker → main ──

export type WorkerMessage =
  | { type: 'probe'; shards: Array<{ coll: string; idType: IdProbe }>; present: string[] }
  | { type: 't0'; ct: string }
  /** Rows of a scan batch (cold build or an in-epoch shard scan). */
  | { type: 'scanRows'; seq: number; coll: string; rows: RowChange[]; scanned: number }
  /** Live change-stream changes (after their shard is live). */
  | { type: 'changes'; seq: number; items: RowChange[] }
  /** The coalesced scan buffer of a shard (or of every shard at a cold catch-up). */
  | { type: 'buffer'; seq: number; coll: string | null; items: RowChange[] }
  /** An in-epoch shard scan starts: its rows follow; `existing` = the model already had the shard (reset first). */
  | { type: 'shardScanStart'; coll: string; reason: string }
  /** An in-epoch shard scan is complete (its buffer was sent before this). */
  | { type: 'shardScanDone'; coll: string; rows: number }
  /** The cold build is complete: everything up to `rt` / `ct` is in the messages before this one. */
  | { type: 'catchUp'; rt: string; ct: string }
  /** The stream is drained up to `rt` and the cluster's majority point as of `ca` is behind it (§6.7). */
  | { type: 'confirm'; ca: number; rt: string; ct: string }
  /** A shard collection was dropped (or renamed away): its rows are gone. */
  | { type: 'shardDropped'; coll: string; how: 'drop' | 'rename' }
  /** A shard whose `_id`s are not all ObjectIds (probe or event): never served. */
  | { type: 'shardUnsupported'; coll: string; reason: string }
  | { type: 'repairResult'; reqId: number; coll: string; oid: string; state: Cell[] | null }
  /** The feeder cannot continue: history lost, oplog too short, invalidate / dropDatabase, fatal errors. */
  | { type: 'fatal'; reason: FeederFatalReason; detail: string }
  | { type: 'alert'; name: string; detail: string }
  | { type: 'stats'; stats: WorkerStats };

export type FeederFatalReason = 'history_lost' | 'oplog_too_short' | 'invalidate' | 'drop_database' | 'error';

export interface WorkerStats {
  events: number;
  eventsSkipped: number;
  /** Bytes of trimmed events received (BSON size estimate). */
  bytes: number;
  scan?: { coll: string; scanned: number; total?: number; docsPerSec: number; paused: boolean; startedAt: number } | undefined;
  buffer: { records: number; bytes: number; overflowed: boolean };
  trim: 'full' | 'top' | 'none';
  streamRt?: string;
  majorityCt?: string;
  repairs: number;
}

// ── main → worker ──

export type MainCommand =
  | { type: 'ack'; seq: number }
  | { type: 'pace'; docsPerSec: number }
  | { type: 'pause' }
  | { type: 'resume' }
  /** The user read budget is under pressure: scans yield. */
  | { type: 'pressure'; under: boolean }
  | { type: 'repair'; reqId: number; coll: string; oid: string; afterCt: string }
  | { type: 'rescan'; coll: string; reason: string }
  | { type: 'stop' };
