import { ServiceUnavailableException } from '@nestjs/common';
import mongoose from 'mongoose';

/**
 * Options for the USER-FACING read path only (leaderboard, pools, position
 * detail and charts). Applied per query, never on the connection: billing,
 * portal, admin and every worker keep primary reads and no time limit, because
 * they need read-your-writes and a background job must not be cut off at a
 * request-sized budget.
 *
 * `secondaryPreferred` moves list CPU off a primary that is also absorbing every
 * sync write; `maxStalenessSeconds: 120` makes the driver fall back to the
 * primary rather than serve a secondary more than two minutes behind. The
 * driver keeps one pool per server, so these reads also stop queueing behind
 * the workers in the primary's pool.
 *
 * Typed as the mode string Mongoose's typings demand: `Query.read` and
 * `Aggregate.read` hand a `ReadPreference` INSTANCE to the driver unchanged
 * (mongoose 9.6.3, `lib/query.js` `read()`), and an instance is the only way to
 * carry `maxStalenessSeconds` on a single query.
 */
export const USER_READ_PREFERENCE = new mongoose.mongo.ReadPreference('secondaryPreferred', undefined, {
  maxStalenessSeconds: 120,
}) as unknown as 'secondaryPreferred';

/**
 * HEAVY background reads that must FAIL rather than load the primary (P-R:
 * the read models' scans, repair reads and verification reads, design §3.2 /
 * §7.1): `secondary`, no fallback. A user read never uses this — it would 503
 * whenever both secondaries are down. The feeder worker builds the same
 * preference on its own client (`read-models/feeder/source.ts`).
 */
export const SECONDARY_ONLY_READ_PREFERENCE = new mongoose.mongo.ReadPreference('secondary') as unknown as 'secondary';

/** A cluster time as the driver takes it (`Timestamp`), from `{t, i}`. */
export function clusterTimestamp(time: { t: number; i: number }) {
  return new mongoose.mongo.Timestamp({ t: time.t, i: time.i });
}

/**
 * `readConcern: majority` after `time`, for reads that must see at least
 * that cluster time and nothing that can be rolled back (P-R scans and repair
 * reads: a lagging secondary waits instead of answering older). Use with a
 * causally consistent session: `session.advanceOperationTime(clusterTimestamp(time))`
 * and `{ session, readConcern: MAJORITY_READ_CONCERN }`.
 */
export const MAJORITY_READ_CONCERN = { level: 'majority' as const };

/**
 * `readConcern: snapshot` at an exact cluster time (P-R: rows read by id at
 * an engine answer's clusterTime, and the lane-A shadow checks, §6.7 / §7.1).
 * Works on secondaries for `find` and `aggregate` (rig, MongoDB 8.0.32);
 * older than `minSnapshotHistoryWindowInSeconds` (300 s) answers
 * `SnapshotTooOld` — `isSnapshotTooOld`.
 */
export function snapshotReadConcern(time: { t: number; i: number }) {
  return { level: 'snapshot' as const, atClusterTime: clusterTimestamp(time) };
}

/** A snapshot read the server cannot serve at that clusterTime (too old, ahead of it, or unsupported). */
export class SnapshotUnavailableError extends Error {
  constructor(readonly cause: unknown) {
    super(`snapshot read unavailable: ${(cause as Error)?.message ?? String(cause)}`);
    this.name = 'SnapshotUnavailableError';
  }
}

/**
 * A failure of a snapshot read at a clusterTime that a plain read at "now"
 * can stand in for: too old (239), ahead of the node's clusterTime / not
 * supported (72 InvalidOptions), or a server message naming the snapshot.
 */
export function isSnapshotReadError(err: unknown): boolean {
  if (isSnapshotTooOld(err)) return true;
  const e = err as { code?: unknown; codeName?: unknown; message?: unknown };
  if (e?.code === 72 || e?.codeName === 'InvalidOptions') return true;
  return typeof e?.message === 'string' && /snapshot|atClusterTime/i.test(e.message);
}

/** `SnapshotTooOld` (239): the requested cluster time is past the history window. */
export function isSnapshotTooOld(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 3; depth++) {
    const record = e as { code?: unknown; codeName?: unknown; cause?: unknown };
    if (record.code === 239 || record.codeName === 'SnapshotTooOld') return true;
    e = record.cause;
  }
  return false;
}

/**
 * Server-side time limits. A query past its budget is killed by MongoDB itself
 * (error code 50) instead of running on for a minute after the client has
 * gone — the 70 s / 119 s slow ops Atlas reported.
 */
export const READ_MAX_TIME_MS = {
  /** Leaderboard page / window find, per shard. */
  find: 5_000,
  /** Leaderboard and pools counts — always off the page's critical path. */
  count: 8_000,
  /** Position detail and charts lookups. */
  findOne: 2_000,
  /** Per-pool open-position / holder aggregation. */
  countsByPoolIds: 3_000,
  /** Pools list and pool detail. */
  pools: 5_000,
} as const;

/** Seconds a client is told to wait after a timed-out read. */
export const QUERY_TIMEOUT_RETRY_AFTER_SECONDS = 5;

/**
 * A read that did not answer within its budget: MongoServerError
 * `MaxTimeMSExpired` (code 50), as the driver or Mongoose surfaces it — or
 * the driver's `MongoWaitQueueTimeoutError`, raised when no pooled connection
 * came free within `waitQueueTimeoutMS` (`MONGO_WAIT_QUEUE_TIMEOUT_MS`). The
 * second never reached the server, but for the read path it is the same
 * outcome: serve the retained copy flagged, or 503 + Retry-After — never an
 * uncached 500 because the pool was busy.
 */
export function isMaxTimeMSExpired(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 3; depth++) {
    const record = e as { code?: unknown; codeName?: unknown; name?: unknown; cause?: unknown };
    if (record.code === 50 || record.codeName === 'MaxTimeMSExpired') return true;
    if (isWaitQueueTimeout(record)) return true;
    e = record.cause;
  }
  return false;
}

/**
 * The driver's connection-pool wait-queue timeout. Matched by NAME: the class
 * (`WaitQueueTimeoutError`, driver 7.2 `lib/cmap/errors.js`) is not part of
 * the driver's public exports.
 */
export function isWaitQueueTimeout(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { name?: unknown }).name === 'MongoWaitQueueTimeoutError');
}

/**
 * The planner refusing a `hint` that names an index the collection does not
 * have: `BadValue` (code 2), "hint provided does not correspond to an existing
 * index" (MongoDB 8.0, find / count / aggregate alike). NOT a timeout — left
 * alone it surfaces as an uncached 500 on every request to that shard.
 */
export function isMissingHintError(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 3; depth++) {
    const record = e as { code?: unknown; codeName?: unknown; message?: unknown; cause?: unknown };
    if (
      (record.code === 2 || record.codeName === 'BadValue') &&
      typeof record.message === 'string' &&
      /hint provided does not correspond to an existing index/i.test(record.message)
    ) {
      return true;
    }
    e = record.cause;
  }
  return false;
}

/**
 * A server that does not accept `hint` on the command at all: `IDLUnknownField`
 * (code 40415), e.g. "BSON field 'distinctCommandRequest.hint' is an unknown
 * field." That is what `distinct` answers below MongoDB 7.1, where the command
 * has no `hint` field and is IDL-strict (verified on 8.0.32 with a made-up
 * field: the same code and wording). NOT the missing-index BadValue above, so
 * `withHint` alone would rethrow it. True only when the unknown field IS
 * `hint`: any other unknown field is a real bug and must surface.
 */
export function isUnsupportedHintError(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 3; depth++) {
    const record = e as { code?: unknown; codeName?: unknown; message?: unknown; cause?: unknown };
    if (
      (record.code === 40415 || record.codeName === 'IDLUnknownField') &&
      typeof record.message === 'string' &&
      /['"](?:[\w$]+\.)*hint['"] is an unknown field/i.test(record.message)
    ) {
      return true;
    }
    e = record.cause;
  }
  return false;
}

/**
 * A user read that exceeded its time limit with nothing stale to serve. A 503
 * (metering refunds every 5xx), and the controller adds `Retry-After`.
 */
export class QueryTimeoutException extends ServiceUnavailableException {
  /**
   * `retryAfterSeconds` defaults to the plain retry; a read that knows better
   * (a background rescue is under way, or the same read just timed out there
   * too) says so, and the `Retry-After` header carries the same number.
   */
  constructor(readonly retryAfterSeconds: number = QUERY_TIMEOUT_RETRY_AFTER_SECONDS) {
    super({
      error: 'The query took too long to answer. Retry shortly.',
      retryAfterSeconds,
    });
  }
}
