import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type BeforeApplicationShutdown,
  type OnApplicationShutdown,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { RedisOptions } from 'ioredis';
import type { Model } from 'mongoose';
import { CoordinationRedis, SharedControlClient } from '../common/coordination-redis.js';
import { LeaseRunner } from '../common/lease-runner.js';
import { can, currentProcessRole, leasesEnabled } from '../common/process-role.js';
import { leaseOwnerId } from '../common/redis-lease.js';
import { AppConfigService } from '../config/app-config.service.js';
import { ROLE_OPTIONS } from '../read-models/models-redis.js';
import { UsageBucket } from './usage-bucket.schema.js';
import {
  USAGE_ACK_MARKER_TTL_MS,
  USAGE_ACK_SCRIPT,
  USAGE_AMBIGUOUS_MAX_AGE_MS,
  USAGE_CLAIM_SCRIPT,
  USAGE_INCR_SCRIPT,
  USAGE_OP_TTL_MS,
  USAGE_RETIRE_SCRIPT,
  USAGE_TAKEOVER_SCRIPT,
  USAGE_TOUCH_SCRIPT,
  appliedBeforeError,
  bucketField,
  buildUsageFlushOps,
  chunked,
  objectIdHex,
  redisNotSent,
  resolveUsageFlushIntervalMs,
  resolveUsageWriteMode,
  rowBatches,
  usageField,
  type BucketIdentity,
  type UsageWriteMode,
  type FlushOp,
  type FlushPlan,
} from './usage-flush.js';
import { Usage } from './usage.schema.js';

export {
  USAGE_FLUSH_DEFAULT_INTERVAL_MS,
  USAGE_FLUSH_MAX_INTERVAL_MS,
  USAGE_FLUSH_MIN_INTERVAL_MS,
  resolveUsageFlushIntervalMs,
  resolveUsageWriteMode,
  type UsageWriteMode,
} from './usage-flush.js';

/**
 * `USAGE_WRITE_MODE` — how the two per-request usage writes of a metered `/v1`
 * call reach Mongo (capacity plan 2026-10-04: at 330 req/s the two upserts are
 * ~660 writes/s, above the M10 write envelope).
 *
 *  - `direct` (DEFAULT, today, byte-identical): `MeteringService.snapshotUsage`
 *    / `compensateUsageSnapshot` and `UsageBucketService.record` each send their
 *    own fire-and-forget `updateOne`. This service is then inert: no timer, no
 *    Redis, no lease.
 *  - `batched`: each write becomes an atomic `HINCRBY` of its deltas into ONE
 *    hash on redis-state (`REDIS_URL`, AOF everysec) shared by every api
 *    replica, and ONE flusher turns the accumulated deltas into `bulkWrite`
 *    upserts (≤ 500 ops each) every `USAGE_FLUSH_INTERVAL_MS` (10 s). Mongo then
 *    sees one write per distinct row per interval instead of one per request.
 *  - `drain`: producers write directly (as `direct`) while the flusher keeps
 *    running exactly as in `batched` until the buffer is empty. ROLLBACK is
 *    `batched → drain → direct`: set `drain` everywhere, wait for
 *    `metrics().drained === true` on the flusher, then set `direct`. Going
 *    straight to `direct` leaves nothing that flushes — the live hash and any
 *    leftover claims would stay in Redis, never reaching Mongo.
 *
 * WHO FLUSHES. With leases on (every split role) the holder of the fenced lease
 * `usage-flush` (TTL 30 s, roles with `http-api`; fail-open in role `all`);
 * with leases off (role `all`, one process) that process. Correctness does not
 * hang on the lease: every claim is atomic, so two flushers can never write the
 * same deltas — the lease only keeps the fleet to one Mongo writer. A holder
 * whose flush has been in flight longer than `staleMs` gives the lease up, so a
 * hung flush cannot freeze the fleet's usage.
 *
 * PRODUCING (exactly once into Redis): each record is ONE Lua call carrying an
 * op id (`SET op NX PX 120 s` + the `HINCRBY`s). The buffer has its OWN control
 * connection with `autoResendUnfulfilledCommands: false`, so ioredis never
 * replays a script after a reconnect. A rejection that proves the command never
 * left (no client, offline queue refused, an error reply) falls back to the
 * in-process buffer; an AMBIGUOUS one (1 s command timeout, connection lost
 * with the command queued) is retried against Redis with the SAME op id on each
 * flush, so a script that did run is not counted twice. Past 90 s unresolved
 * (Redis unreachable that long) it goes to the local buffer — at-least-once —
 * and logs `[alert] usage.ambiguous_unresolved`.
 *
 * CLAIM, THEN WRITE, THEN ACK (crash safety):
 *   1. `CLAIM`: `RENAME buf → claim:<owner>:<n>` + register it in the claims
 *      ZSET (score = last touch). A request lands either before (in the claim)
 *      or after (in the next live hash) — never lost, never in both. CLAIM never
 *      overwrites an existing key, and refuses while any earlier claim is still
 *      registered, so claims reach Mongo IN ORDER (a refund in a newer claim
 *      can never be written before the charge's upsert in an older one).
 *   2. per chunk: `TOUCH` (still ours? refresh the score) → `bulkWrite` (driver
 *      `timeoutMS`) → `ACK` (`HDEL` exactly the fields written, retried; the
 *      claim retires when empty).
 *   3. A claim nobody touched for `staleMs` (max(60 s, 6 × interval)) is taken
 *      over atomically by the next flusher and replayed. So a flusher that dies
 *      between claim and write loses nothing.
 *   AT-LEAST-ONCE, stated plainly: a flusher that dies (or loses its claim)
 *   AFTER a chunk's `bulkWrite` committed but BEFORE its `ACK` landed leaves
 *   that chunk (≤ 500 rows) to be replayed, i.e. counted twice. Every way that
 *   can happen that this process can see logs `[alert]
 *   usage.flush_double_count_risk`: the ACK answered "not ours", the ACK failed
 *   after its retries, or the shutdown flush timed out with a chunk in flight.
 *   A `bulkWrite` that fails with an AMBIGUOUS error (a network error / timeout
 *   carrying no write errors — the driver has already retried it once as a
 *   retryable write) is retried the same way. These rows are a display (the
 *   portal's `QuotaMeter`, the usage breakdown, the admin panel); ENFORCEMENT
 *   stays in rate-limiter-flexible and is untouched.
 *
 * SEMANTICS KEPT (see `buildUsageFlushOps`): a compensation never upserts (no
 * row holding negative units); the period of a snapshot is resolved at the
 * moment of the charge / compensation (`currentPeriod()`, as today), the day
 * of a bucket from the guard's `chargedAt`; zero-unit charges still create
 * their row; 499 abandons arrive here as zero-unit bucket records exactly as
 * before; `quotaResetAt` claims (`resetQuotaPeriod`) are untouched — they are
 * their own `updateOne`, and a later `$inc` upsert on the same row only adds.
 *
 * READ LAG: portal / admin usage reads trail the truth by up to one flush
 * interval (≤ 10 s by default; up to `staleMs` + one interval after a flusher
 * dies holding a claim, longer while Mongo or the flusher is down — the deltas
 * wait in Redis, nothing is dropped).
 *
 * REDIS UNAVAILABLE: deltas go to an in-process buffer (≤ 50 000 fields). Once
 * Redis answers again that buffer is MOVED into the shared live hash (one
 * op-id'd INCR per batch of whole rows), so it joins the one ordered stream; it
 * is written to Mongo from here only while Redis stays unavailable. A crash
 * loses that local buffer (Redis-down only). Past the cap, or once the shutdown
 * flush has started, a record is written straight away (the direct path's
 * rules, through the same op builder).
 *
 * SHUTDOWN: `beforeApplicationShutdown` stops the timer, switches new records
 * to immediate writes, and runs one final flush bounded by 5 s.
 *
 * METRICS: `status()` / `metrics()` (buffered keys, pending claims, last flush
 * age, flush failures, ambiguous writes, `drained`) for the admin status;
 * `[alert] usage.flush_failed`.
 */

/** The structural config view read here (getters added by the integrator). */
export interface UsageFlushConfigView {
  usageWriteMode?: string;
  usageFlushIntervalMs?: number;
}

/** The Redis commands this service sends (an ioredis `Redis` satisfies it). */
export interface UsageBufferRedis {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
  zrangebyscore(key: string, min: string | number, max: string | number, limit: 'LIMIT', offset: number, count: number): Promise<string[]>;
  hlen(key: string): Promise<number>;
  zcard(key: string): Promise<number>;
}

/** Spec / wiring seams. Every field optional; absent = production behaviour. */
export interface UsageFlushOptions {
  now?: () => number;
  redis?: () => Promise<UsageBufferRedis | undefined>;
  namespace?: string;
  owner?: string;
  /** Override "may this process flush the SHARED buffer now" (the lease view). */
  sharedFlushAllowed?: () => boolean;
  /** Start the interval timer in `onModuleInit` (default true). */
  timer?: boolean;
  logger?: Pick<Logger, 'log' | 'warn' | 'error'>;
  /** Delay between ACK retries (default 100 ms × attempt). */
  ackRetryMs?: number;
}

export const USAGE_FLUSH_OPTIONS = Symbol('USAGE_FLUSH_OPTIONS');

/**
 * The buffer's own control connection: P-R's control options (1 s command
 * timeout, one retry, no offline queue) with `autoResendUnfulfilledCommands`
 * OFF — the shared coordination client keeps ioredis's default (resend), and a
 * resent INCR / CLAIM that already ran is exactly the loss / double count the
 * scripts must never see (the read models' MODELS_CONTROL_OPTIONS, same reason).
 */
export const USAGE_REDIS_OPTIONS: RedisOptions = { ...ROLE_OPTIONS.control, autoResendUnfulfilledCommands: false };

/** Ops per `bulkWrite`. */
export const USAGE_FLUSH_CHUNK = 500;
/** In-process fallback buffer cap (fields); past it a record is written at once. */
export const USAGE_LOCAL_MAX_FIELDS = 50_000;
/** Fields per INCR when the local buffer moves into Redis (whole rows only). */
export const USAGE_LOCAL_MOVE_BATCH = 1_000;
/** Stale claims taken over per flush. */
export const USAGE_TAKEOVERS_PER_FLUSH = 20;
export const USAGE_SHUTDOWN_FLUSH_MS = 5_000;
export const USAGE_FLUSH_LEASE = 'usage-flush';
export const USAGE_FLUSH_LEASE_TTL_MS = 30_000;
export const USAGE_FLUSH_LEASE_RENEW_MS = 10_000;
/** ACK attempts after a committed chunk before the double-count alert. */
export const USAGE_ACK_ATTEMPTS = 3;
/** Driver-side timeout of a flush `bulkWrite`: min(staleMs / 2, this). */
export const USAGE_FLUSH_WRITE_TIMEOUT_MAX_MS = 20_000;
const ALERT_EVERY_MS = 60_000;
/** E11000: a concurrent upsert of the same new row; transient, retried next flush. */
const DUPLICATE_KEY = 11000;

export interface UsageFlushStatus {
  mode: UsageWriteMode;
  /** `lease-holder` | `standby` (leases on), `every-process` (leases off), `off` (direct). */
  flusher: 'lease-holder' | 'standby' | 'every-process' | 'off';
  intervalMs: number;
  /** Fields waiting in this process's Redis-down fallback buffer. */
  localKeys: number;
  /** Claims this process holds that are not fully written yet. */
  ownClaims: number;
  lastFlushAt: string | null;
  lastFlushAgeMs: number | null;
  /** Mongo ops sent by the last successful flush. */
  lastFlushOps: number;
  flushes: number;
  flushFailures: number;
  consecutiveFailures: number;
  lastError: string | null;
  /** Records that fell back to the in-process buffer because Redis was unavailable BEFORE sending. */
  redisFallbacks: number;
  /** INCRs whose outcome was unknown (sent, reply lost) — retried with their op id. */
  ambiguousWrites: number;
  /** Ambiguous INCRs still waiting for a definite answer. */
  ambiguousPending: number;
  /** Ambiguous INCRs given up on (Redis unreachable past 90 s, or shutdown) and written at-least-once. */
  ambiguousUnresolved: number;
  /** Records written at once (local buffer full, or after the shutdown flush began). */
  immediateWrites: number;
  /** How long the current flush has been running (null when none). */
  flushInFlightMs: number | null;
}

export interface UsageFlushMetrics extends UsageFlushStatus {
  /** Fields in the shared live hash (null: Redis unavailable or direct mode). */
  bufferedKeys: number | null;
  /** Claims registered fleet-wide and not yet retired. */
  pendingClaims: number | null;
  /**
   * Nothing left to flush anywhere this process can see (live hash, claims,
   * local buffer, ambiguous INCRs). In `drain` this is the signal that
   * `direct` is now safe. Null when unknown (direct mode, Redis unavailable).
   */
  drained: boolean | null;
}

interface AmbiguousOp {
  op: string;
  pairs: Array<[string, number]>;
  since: number;
}

type IncrOutcome = 'applied' | 'not-sent' | 'ambiguous';

/** Raised inside a claim's processing when Mongo refuses a chunk (ends the round). */
class FlushWriteError extends Error {}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, Math.max(0, ms));
    t.unref?.();
  });
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const t = setTimeout(done, Math.max(0, ms));
    t.unref?.();
    signal.addEventListener('abort', done, { once: true });
  });
}

@Injectable()
export class UsageFlushService implements OnModuleInit, OnModuleDestroy, BeforeApplicationShutdown, OnApplicationShutdown {
  private readonly logger: Pick<Logger, 'log' | 'warn' | 'error'>;
  private readonly now: () => number;
  private readonly owner: string;
  private local = new Map<string, number>();
  private ambiguous: AmbiguousOp[] = [];
  private readonly myClaims = new Set<string>();
  private claimSeq = 0;
  private opSeq = 0;
  private ackSeq = 0;
  private closing = false;
  private timer?: ReturnType<typeof setInterval>;
  private runner?: LeaseRunner;
  private ownClient?: SharedControlClient;
  private inFlight?: Promise<void>;
  private inFlightSince: number | undefined;
  /** Ops of a chunk sent to Mongo and not yet acknowledged (a replay candidate). */
  private chunkInFlightOps = 0;
  private lastFlushAtMs: number | undefined;
  private lastFlushOps = 0;
  private flushes = 0;
  private flushFailures = 0;
  private consecutiveFailures = 0;
  private lastError: string | null = null;
  private failureAlertAt: number | undefined;
  private unresolvedAlertAt: number | undefined;
  private redisFallbacks = 0;
  private ambiguousWrites = 0;
  private ambiguousUnresolved = 0;
  private immediateWrites = 0;

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @InjectModel(Usage.name) private readonly usageModel: Model<Usage>,
    @InjectModel(UsageBucket.name) private readonly bucketModel: Model<UsageBucket>,
    @Optional() @Inject(CoordinationRedis) private readonly coordination?: CoordinationRedis,
    @Optional() @Inject(USAGE_FLUSH_OPTIONS) private readonly options: UsageFlushOptions = {},
  ) {
    this.options = options ?? {};
    this.logger = this.options.logger ?? new Logger(UsageFlushService.name);
    this.now = this.options.now ?? (() => Date.now());
    this.owner = this.options.owner ?? leaseOwnerId();
  }

  private get view(): UsageFlushConfigView {
    return (this.config ?? {}) as unknown as UsageFlushConfigView;
  }

  /** As configured (`USAGE_WRITE_MODE`). */
  get configuredMode(): UsageWriteMode {
    return resolveUsageWriteMode(this.view.usageWriteMode);
  }

  /** True while records are buffered (batched and the shutdown flush has not begun). */
  get batching(): boolean {
    return this.configuredMode === 'batched' && !this.closing;
  }

  /** The flusher runs in `batched` and `drain`; `direct` touches nothing. */
  private get flushing(): boolean {
    return this.configuredMode !== 'direct';
  }

  get intervalMs(): number {
    return resolveUsageFlushIntervalMs(this.view.usageFlushIntervalMs);
  }

  /** A claim untouched for this long is taken over by the next flusher. */
  get staleMs(): number {
    return Math.max(60_000, 6 * this.intervalMs);
  }

  /** Driver-side timeout on every flush `bulkWrite`: well under `staleMs`. */
  get writeTimeoutMs(): number {
    return Math.min(Math.floor(this.staleMs / 2), USAGE_FLUSH_WRITE_TIMEOUT_MAX_MS);
  }

  private get namespace(): string {
    return this.options.namespace ?? this.coordination?.namespace ?? 'local';
  }

  get liveKey(): string {
    return `tw:usage:v1:${this.namespace}:buf`;
  }

  get claimsKey(): string {
    return `tw:usage:v1:${this.namespace}:claims`;
  }

  private newClaimKey(): string {
    this.claimSeq += 1;
    return `tw:usage:v1:${this.namespace}:claim:${this.owner}:${this.now()}:${this.claimSeq}`;
  }

  private newOpKey(): string {
    this.opSeq += 1;
    return `tw:usage:v1:${this.namespace}:op:${this.owner}:${this.opSeq}`;
  }

  private async redis(): Promise<UsageBufferRedis | undefined> {
    try {
      if (this.options.redis) return await this.options.redis();
      const url = (this.coordination as { url?: unknown } | undefined)?.url;
      if (typeof url === 'string' && url) {
        this.ownClient ??= new SharedControlClient(() => url, USAGE_REDIS_OPTIONS, 'tw-usage', this.logger);
        return (await this.ownClient.get()) as unknown as UsageBufferRedis | undefined;
      }
      return (await this.coordination?.client()) as unknown as UsageBufferRedis | undefined;
    } catch {
      return undefined;
    }
  }

  // ── producers ────────────────────────────────────────────────────────────

  /**
   * Buffer one `snapshotUsage` charge. False = not taken (direct / drain mode,
   * a malformed id or a non-integer cost): the caller writes it directly, as today.
   */
  enqueueUsageCharge(customerId: string, unitCost: number, period: string): boolean {
    if (!this.batching || !Number.isSafeInteger(unitCost)) return false;
    const id = objectIdHex(customerId);
    if (!id) return false;
    this.push([
      [usageField(id, period, 'u'), unitCost],
      [usageField(id, period, 'r'), 1],
    ]);
    return true;
  }

  /** Buffer one `compensateUsageSnapshot` (units as a POSITIVE amount). Same contract. */
  enqueueUsageCompensation(customerId: string, unitCost: number, period: string): boolean {
    if (!this.batching || !Number.isSafeInteger(unitCost)) return false;
    const id = objectIdHex(customerId);
    if (!id) return false;
    this.push([[usageField(id, period, 'c'), unitCost]]);
    return true;
  }

  /** Buffer one `UsageBucketService.record`. Same contract. */
  enqueueBucket(identity: BucketIdentity, units: number): boolean {
    if (!this.batching || !Number.isSafeInteger(units)) return false;
    const customerId = objectIdHex(identity.customerId);
    const apiKeyId = objectIdHex(identity.apiKeyId);
    if (!customerId || !apiKeyId) return false;
    const id: BucketIdentity = {
      ...identity,
      customerId,
      apiKeyId,
      keyPrefix: identity.keyPrefix ?? '',
      keyLabel: identity.keyLabel ?? '',
    };
    this.push([
      [bucketField(id, 'u'), units],
      [bucketField(id, 'r'), 1],
    ]);
    return true;
  }

  /** One op-id'd INCR: applied (now or by an earlier run of the same op), never sent, or unknown. */
  private async incr(redis: UsageBufferRedis, op: string, pairs: Array<[string, number]>): Promise<IncrOutcome> {
    const args: Array<string | number> = [this.liveKey, op, USAGE_OP_TTL_MS];
    for (const [field, delta] of pairs) args.push(field, delta);
    try {
      await redis.eval(USAGE_INCR_SCRIPT, 2, ...args);
      return 'applied';
    } catch (err) {
      return redisNotSent(err) ? 'not-sent' : 'ambiguous';
    }
  }

  /**
   * Fire-and-forget: Redis first; the in-process buffer only when the record
   * provably never reached Redis; an ambiguous outcome is retried by op id at
   * the next flush (never written locally, which would count it twice). Never throws.
   */
  private push(pairs: Array<[string, number]>): void {
    void (async () => {
      const redis = await this.redis();
      const op = this.newOpKey();
      const outcome: IncrOutcome = redis ? await this.incr(redis, op, pairs) : 'not-sent';
      if (outcome === 'applied') return;
      if (outcome === 'not-sent') {
        this.redisFallbacks += 1;
        this.addLocal(pairs);
        return;
      }
      this.ambiguousWrites += 1;
      this.ambiguous.push({ op, pairs, since: this.now() });
    })().catch((err: unknown) => this.logger.warn(`Usage buffer write skipped: ${String(err)}`));
  }

  private addLocal(pairs: Array<[string, number]>): void {
    if (this.closing || this.local.size + pairs.length > USAGE_LOCAL_MAX_FIELDS) {
      this.writeImmediately(pairs);
      return;
    }
    for (const [field, delta] of pairs) this.local.set(field, (this.local.get(field) ?? 0) + delta);
  }

  private writeOptions(): { ordered: true; timeoutMS: number } {
    return { ordered: true, timeoutMS: this.writeTimeoutMs };
  }

  /** The direct path's rules through the flush op builder, sent at once. Best-effort. */
  private writeImmediately(pairs: Array<[string, number]>): void {
    this.immediateWrites += 1;
    const entries: Record<string, number> = {};
    for (const [field, delta] of pairs) entries[field] = (entries[field] ?? 0) + delta;
    const plan = buildUsageFlushOps(entries);
    const send = async () => {
      if (plan.usage.length) await this.usageModel.bulkWrite(plan.usage.map((o) => o.op) as never, this.writeOptions());
      if (plan.buckets.length) await this.bucketModel.bulkWrite(plan.buckets.map((o) => o.op) as never, this.writeOptions());
    };
    send().catch((err: unknown) => this.logger.warn(`Usage immediate write failed: ${String(err)}`));
  }

  // ── flushing ─────────────────────────────────────────────────────────────

  /** May this process flush the SHARED buffer right now? */
  private sharedFlushAllowed(): boolean {
    if (this.options.sharedFlushAllowed) return this.options.sharedFlushAllowed();
    if (!leasesEnabled()) return true;
    return this.runner?.stillHeld() ?? false;
  }

  /** How long the running flush has been in flight (0 when none). */
  private flushInFlightMs(): number {
    return this.inFlightSince === undefined ? 0 : Math.max(0, this.now() - this.inFlightSince);
  }

  /**
   * One flush: ambiguous INCRs, this process's fallback buffer (moved into
   * Redis when it answers), then (when allowed) the shared buffer — own
   * unfinished claims, stale claims of dead flushers, then the live hash.
   * Single-flight: a call while one runs awaits that one.
   * `force` flushes the shared buffer regardless of the lease (shutdown; safe
   * because every claim is atomic).
   */
  async flushNow(force = false): Promise<void> {
    // Direct mode never buffers, so it never touches Redis here either.
    if (!this.flushing) return;
    if (this.inFlight) return this.inFlight;
    this.inFlightSince = this.now();
    this.inFlight = this.flushOnce(force).finally(() => {
      this.inFlight = undefined;
      this.inFlightSince = undefined;
    });
    return this.inFlight;
  }

  private async flushOnce(force: boolean): Promise<void> {
    let ops = 0;
    let failure: unknown;
    const redis = await this.redis();
    try {
      await this.resolveAmbiguous(redis);
    } catch (err) {
      failure ??= err;
    }
    try {
      ops += await this.flushLocal(redis);
    } catch (err) {
      failure ??= err;
    }
    if (force || this.sharedFlushAllowed()) {
      try {
        ops += await this.flushShared(redis);
      } catch (err) {
        failure ??= err;
      }
    }
    if (failure === undefined) {
      this.flushes += 1;
      this.lastFlushAtMs = this.now();
      this.lastFlushOps = ops;
      this.consecutiveFailures = 0;
      return;
    }
    this.flushFailures += 1;
    this.consecutiveFailures += 1;
    this.lastError = (failure as Error)?.message ?? String(failure);
    const now = this.now();
    if (this.failureAlertAt === undefined || now - this.failureAlertAt >= ALERT_EVERY_MS) {
      this.failureAlertAt = now;
      this.logger.warn(
        `[alert] usage.flush_failed failures=${this.flushFailures} consecutive=${this.consecutiveFailures} — ${this.lastError} (deltas kept for the next flush)`,
      );
    }
  }

  /**
   * Retry every ambiguous INCR with its own op id. One past the window (or any
   * left at shutdown) is written at-least-once through the local buffer.
   */
  private async resolveAmbiguous(redis: UsageBufferRedis | undefined): Promise<void> {
    if (this.ambiguous.length === 0) return;
    const queue = this.ambiguous;
    this.ambiguous = [];
    const keep: AmbiguousOp[] = [];
    let givenUp = 0;
    for (const item of queue) {
      if (redis && (await this.incr(redis, item.op, item.pairs)) === 'applied') continue;
      if (this.closing || this.now() - item.since > USAGE_AMBIGUOUS_MAX_AGE_MS) {
        givenUp += 1;
        this.addLocal(item.pairs);
        continue;
      }
      keep.push(item);
    }
    this.ambiguous = [...keep, ...this.ambiguous];
    if (givenUp === 0) return;
    this.ambiguousUnresolved += givenUp;
    const now = this.now();
    if (this.unresolvedAlertAt === undefined || now - this.unresolvedAlertAt >= ALERT_EVERY_MS) {
      this.unresolvedAlertAt = now;
      this.logger.warn(
        `[alert] usage.ambiguous_unresolved records=${givenUp} total=${this.ambiguousUnresolved} — Redis gave no definite answer for ${
          this.closing ? 'them before shutdown' : `${USAGE_AMBIGUOUS_MAX_AGE_MS / 1000} s`
        }; written at-least-once (each may now be counted twice)`,
      );
    }
  }

  /**
   * Write `plan`, chunk by chunk; `beforeChunk` false stops (claim lost), `ack`
   * settles a chunk's fields. A committed chunk's ACK is retried; one that still
   * fails is a replay candidate and is alerted before the error propagates.
   */
  private async writePlan(
    plan: FlushPlan,
    hooks: { beforeChunk?: () => Promise<boolean>; ack: (fields: string[], ackId: string) => Promise<boolean> },
  ): Promise<{ ops: number; stopped: boolean }> {
    const settle = [...plan.noWrite, ...plan.malformed];
    if (plan.malformed.length) this.logger.warn(`Usage flush dropped ${plan.malformed.length} malformed buffer field(s)`);
    if (settle.length && !(await hooks.ack(settle, this.newAckId()))) return { ops: 0, stopped: true };
    let ops = 0;
    const work: Array<{ model: Model<Usage> | Model<UsageBucket>; chunk: FlushOp[] }> = [
      ...chunked(plan.usage, USAGE_FLUSH_CHUNK).map((chunk) => ({ model: this.usageModel as Model<Usage> | Model<UsageBucket>, chunk })),
      ...chunked(plan.buckets, USAGE_FLUSH_CHUNK).map((chunk) => ({ model: this.bucketModel as Model<Usage> | Model<UsageBucket>, chunk })),
    ];
    for (const { model, chunk } of work) {
      if (hooks.beforeChunk && !(await hooks.beforeChunk())) return { ops, stopped: true };
      this.chunkInFlightOps = chunk.length;
      try {
        await (model as Model<Usage>).bulkWrite(chunk.map((o) => o.op) as never, this.writeOptions());
      } catch (err) {
        const partial = appliedBeforeError(err);
        if (partial) {
          const applied = chunk.slice(0, partial.applied).flatMap((o) => o.fields);
          if (applied.length) await this.ackWritten(hooks.ack, applied, partial.applied);
          const failed = chunk[partial.applied];
          if (failed && partial.code !== DUPLICATE_KEY) {
            // A deterministic refusal of ONE row would poison the buffer forever.
            await hooks.ack(failed.fields, this.newAckId());
            this.logger.warn(
              `[alert] usage.flush_dropped_op kind=${failed.kind} code=${partial.code ?? 'n/a'} fields=${failed.fields.length} — ${String(err)}`,
            );
          }
          ops += partial.applied;
        }
        this.chunkInFlightOps = 0;
        throw new FlushWriteError(`bulkWrite failed: ${(err as Error)?.message ?? String(err)}`);
      }
      ops += chunk.length;
      const acked = await this.ackWritten(hooks.ack, chunk.flatMap((o) => o.fields), chunk.length);
      this.chunkInFlightOps = 0;
      if (!acked) {
        this.logger.warn(
          `[alert] usage.flush_double_count_risk ops=${chunk.length} — the claim was taken over after this chunk was written; its new owner may replay it`,
        );
        return { ops, stopped: true };
      }
    }
    return { ops, stopped: false };
  }

  private newAckId(): string {
    this.ackSeq += 1;
    return `ack:${this.owner}:${this.ackSeq}`;
  }

  /**
   * ACK fields Mongo already committed: retried with ONE ack id (the script is
   * idempotent per id, so a retry after a lost reply answers 1, not "not ours");
   * a final failure is alerted, then rethrown.
   */
  private async ackWritten(ack: (fields: string[], ackId: string) => Promise<boolean>, fields: string[], ops: number): Promise<boolean> {
    const ackId = this.newAckId();
    let lastErr: unknown;
    for (let attempt = 1; attempt <= USAGE_ACK_ATTEMPTS; attempt++) {
      try {
        return await ack(fields, ackId);
      } catch (err) {
        lastErr = err;
        if (attempt < USAGE_ACK_ATTEMPTS) await delay((this.options.ackRetryMs ?? 100) * attempt);
      }
    }
    this.chunkInFlightOps = 0;
    this.logger.warn(
      `[alert] usage.flush_double_count_risk ops=${ops} — the ACK of a written chunk failed ${USAGE_ACK_ATTEMPTS}× (${
        (lastErr as Error)?.message ?? String(lastErr)
      }); the claim keeps those fields and the next flush may replay them`,
    );
    throw lastErr;
  }

  private async flushLocal(redis: UsageBufferRedis | undefined): Promise<number> {
    if (this.local.size === 0) return 0;
    const pending = this.local;
    this.local = new Map();
    try {
      if (redis) {
        // Redis answers again: hand the buffer to the shared live hash so it
        // joins the one ordered stream (a refund held here can no longer be
        // written before a charge sitting in Redis).
        for (const batch of rowBatches([...pending], USAGE_LOCAL_MOVE_BATCH)) {
          const op = this.newOpKey();
          const outcome = await this.incr(redis, op, batch);
          if (outcome === 'not-sent') break;
          for (const [field] of batch) pending.delete(field);
          if (outcome === 'ambiguous') {
            this.ambiguousWrites += 1;
            this.ambiguous.push({ op, pairs: batch, since: this.now() });
          }
        }
        if (pending.size === 0) return 0;
      }
      // Redis unavailable: today's Redis-down path, straight to Mongo.
      const { ops } = await this.writePlan(buildUsageFlushOps(Object.fromEntries(pending)), {
        ack: async (fields) => {
          for (const f of fields) pending.delete(f);
          return true;
        },
      });
      return ops;
    } finally {
      // Whatever was not written goes back (added to anything recorded meanwhile).
      for (const [field, delta] of pending) this.local.set(field, (this.local.get(field) ?? 0) + delta);
    }
  }

  private async flushShared(redis: UsageBufferRedis | undefined): Promise<number> {
    if (!redis) {
      if (this.myClaims.size > 0) throw new Error('redis unavailable with unfinished claims');
      return 0;
    }
    let ops = 0;
    // 1. Our own unfinished claims, oldest first (a write failure last round).
    for (const claim of [...this.myClaims]) ops += await this.processClaim(redis, claim);

    // 2. Claims of flushers that died between claim and ack.
    const staleBefore = this.now() - this.staleMs;
    const stale = await redis.zrangebyscore(this.claimsKey, '-inf', staleBefore, 'LIMIT', 0, USAGE_TAKEOVERS_PER_FLUSH);
    for (const old of stale) {
      if (this.myClaims.has(old)) continue;
      const mine = this.newClaimKey();
      let got: number;
      try {
        got = Number(await redis.eval(USAGE_TAKEOVER_SCRIPT, 3, this.claimsKey, old, mine, this.now(), staleBefore));
      } catch (err) {
        // It may have run: `mine` is ours if it exists; the next round's TOUCH decides.
        if (!redisNotSent(err)) this.myClaims.add(mine);
        throw err;
      }
      if (got !== 1) continue;
      this.logger.warn(`usage flush: took over stale claim ${old} (its flusher stopped before acknowledging it)`);
      this.myClaims.add(mine);
      ops += await this.processClaim(redis, mine);
    }

    // 3. The live buffer (refused while an earlier claim is still registered).
    const mine = this.newClaimKey();
    let claimed: number;
    try {
      claimed = Number(await redis.eval(USAGE_CLAIM_SCRIPT, 3, this.liveKey, mine, this.claimsKey, this.now()));
    } catch (err) {
      if (!redisNotSent(err)) this.myClaims.add(mine);
      throw err;
    }
    if (claimed === 1) {
      this.myClaims.add(mine);
      ops += await this.processClaim(redis, mine);
    }
    return ops;
  }

  /** Write one claim; throws on a Mongo refusal (the claim stays ours, retried next flush). */
  private async processClaim(redis: UsageBufferRedis, claim: string): Promise<number> {
    const touch = async () => Number(await redis.eval(USAGE_TOUCH_SCRIPT, 2, this.claimsKey, claim, this.now())) === 1;
    if (!(await touch())) {
      this.myClaims.delete(claim);
      return 0;
    }
    const entries = await redis.hgetall(claim);
    const { ops, stopped } = await this.writePlan(buildUsageFlushOps(entries ?? {}), {
      beforeChunk: touch,
      ack: async (fields, ackId) =>
        Number(await redis.eval(USAGE_ACK_SCRIPT, 3, this.claimsKey, claim, `${claim}:${ackId}`, USAGE_ACK_MARKER_TTL_MS, ...fields)) === 1,
    });
    if (stopped) {
      this.myClaims.delete(claim);
      return ops;
    }
    await redis.eval(USAGE_RETIRE_SCRIPT, 2, this.claimsKey, claim);
    this.myClaims.delete(claim);
    return ops;
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  onModuleInit(): void {
    if (!this.flushing) return;
    // Only processes that serve `/v1` produce usage records.
    if (!can('http-api')) return;
    if (leasesEnabled() && !this.options.sharedFlushAllowed && this.coordination) {
      const coordination = this.coordination;
      this.runner = new LeaseRunner({
        name: USAGE_FLUSH_LEASE,
        redis: () => coordination.client(),
        namespace: coordination.namespace,
        ttlMs: USAGE_FLUSH_LEASE_TTL_MS,
        renewMs: USAGE_FLUSH_LEASE_RENEW_MS,
        failOpen: currentProcessRole() === 'all',
        // Hold while the flusher makes progress; the timer asks `stillHeld()`
        // before each shared flush. A flush in flight past `staleMs` (a hang the
        // driver / command timeouts did not end) gives the lease up — throwing
        // ends the session — so another replica can take the buffer over.
        work: ({ signal }) => this.holdLease(signal),
        logger: new Logger(`LeaseRunner:${USAGE_FLUSH_LEASE}`),
      });
      this.runner.start();
    }
    if (this.options.timer === false) return;
    this.timer = setInterval(() => void this.flushNow(), this.intervalMs);
    this.timer.unref?.();
    const where = leasesEnabled() ? `lease ${USAGE_FLUSH_LEASE}` : 'this process';
    this.logger.log(
      this.configuredMode === 'drain'
        ? `usage writes DRAINING: producers write directly; flushing the buffer every ${this.intervalMs} ms (${where}) — set direct once metrics().drained`
        : `usage writes BATCHED: flush every ${this.intervalMs} ms (${where})`,
    );
  }

  /** The `usage-flush` lease's work: hold until aborted; throw (= release) when a flush is stuck. */
  async holdLease(signal: AbortSignal, checkEveryMs: number = USAGE_FLUSH_LEASE_RENEW_MS): Promise<void> {
    while (!signal.aborted) {
      await abortableSleep(checkEveryMs, signal);
      if (signal.aborted) return;
      const inFlight = this.flushInFlightMs();
      if (inFlight > this.staleMs) {
        this.logger.warn(
          `[alert] usage.flush_stuck inFlightMs=${inFlight} — releasing lease ${USAGE_FLUSH_LEASE} so another replica can flush`,
        );
        throw new Error(`usage flush in flight for ${inFlight} ms`);
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.runner?.stop();
  }

  /** Final bounded flush; new records are written at once from here on. */
  async beforeApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (!this.flushing) return;
    this.closing = true;
    // A periodic flush may be in flight without `force`; let it finish, then
    // run the forced one so the shared buffer is drained too.
    const final = (async () => {
      await this.inFlight?.catch(() => undefined);
      await this.flushNow(true);
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), USAGE_SHUTDOWN_FLUSH_MS);
      timer.unref?.();
    });
    const outcome = await Promise.race([final.then(() => 'done' as const), timeout]);
    if (timer) clearTimeout(timer);
    if (outcome === 'timeout') {
      this.logger.warn(
        `[alert] usage.flush_failed shutdown flush exceeded ${USAGE_SHUTDOWN_FLUSH_MS} ms — shared deltas stay in Redis for the next flusher; local=${this.local.size} field(s) may be lost`,
      );
      if (this.chunkInFlightOps > 0) {
        this.logger.warn(
          `[alert] usage.flush_double_count_risk ops=${this.chunkInFlightOps} — shutdown abandoned a chunk sent to Mongo and not acknowledged; the flusher that takes the claim over may replay it`,
        );
      }
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.ownClient?.quit();
  }

  // ── metrics ──────────────────────────────────────────────────────────────

  status(): UsageFlushStatus {
    const mode = this.configuredMode;
    const flusher: UsageFlushStatus['flusher'] =
      mode === 'direct' ? 'off' : !leasesEnabled() && !this.options.sharedFlushAllowed ? 'every-process' : this.sharedFlushAllowed() ? 'lease-holder' : 'standby';
    return {
      mode,
      flusher,
      intervalMs: this.intervalMs,
      localKeys: this.local.size,
      ownClaims: this.myClaims.size,
      lastFlushAt: this.lastFlushAtMs !== undefined ? new Date(this.lastFlushAtMs).toISOString() : null,
      lastFlushAgeMs: this.lastFlushAtMs !== undefined ? Math.max(0, this.now() - this.lastFlushAtMs) : null,
      lastFlushOps: this.lastFlushOps,
      flushes: this.flushes,
      flushFailures: this.flushFailures,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
      redisFallbacks: this.redisFallbacks,
      ambiguousWrites: this.ambiguousWrites,
      ambiguousPending: this.ambiguous.length,
      ambiguousUnresolved: this.ambiguousUnresolved,
      immediateWrites: this.immediateWrites,
      flushInFlightMs: this.inFlightSince === undefined ? null : this.flushInFlightMs(),
    };
  }

  async metrics(): Promise<UsageFlushMetrics> {
    const base = this.status();
    const unknown = { ...base, bufferedKeys: null, pendingClaims: null, drained: null };
    if (base.mode === 'direct') return unknown;
    const redis = await this.redis();
    if (!redis) return unknown;
    try {
      const [bufferedKeys, pendingClaims] = await Promise.all([redis.hlen(this.liveKey), redis.zcard(this.claimsKey)]);
      const drained = bufferedKeys === 0 && pendingClaims === 0 && base.localKeys === 0 && base.ambiguousPending === 0;
      return { ...base, bufferedKeys, pendingClaims, drained };
    } catch {
      return unknown;
    }
  }
}
