/*
 * One budget for every indexer request, per upstream URL.
 *
 * Without it, user detail/charts calls compete with background jobs for the
 * deployment's 1000 req/min with nothing to arbitrate: the background estimate
 * alone was 565-1,020 req/min, so users got the 429s and sat in retry backoff
 * (12-21s detail and charts). The gateway is the single choke point
 * (`HyperindexUpstream.execute` and `loadTokens` both run through it) and does
 * four things in ENFORCE mode:
 *
 *  1. Budget. A token bucket of `budgetPerMin` (refilled continuously, burst
 *     ~2s worth) shared by everyone, plus a second bucket of
 *     `backgroundMaxPerMin` that every non-interactive call must ALSO draw from —
 *     so at least `budget - background` per minute is always left for users.
 *  2. Strict priority: interactive > live > health > refresh > sweep. A lower lane
 *     never dispatches while a higher one is waiting.
 *  3. In-flight cap (`maxInFlight`, of which `interactiveReservedInFlight` only
 *     interactive may use), to protect the indexer's Postgres from bursts.
 *  4. 429 handling in ONE place: a 429 pauses the bucket until Retry-After (else
 *     2s doubling to 30s), and queued calls resume in priority order instead of
 *     every caller sleeping its own backoff and retrying into the same wall.
 *     Plus per-call timeouts (interactive: the request's remaining deadline, at
 *     most `interactiveTimeoutMs`; background: `backgroundTimeoutMs`).
 *
 * OBSERVE mode (the default) does none of that: no queue, no bucket, no pause,
 * no timeouts. It only meters, and honours the caller's own abort signal (an HTTP
 * client that hung up), which is not a new limit but an old leak — the handler
 * used to keep spending budget on a response nobody would read.
 *
 * Per process by default (`INDEXER_BUDGET_SCOPE=process`, today). With
 * `INDEXER_BUDGET_SCOPE=shared` (P2.2 §3.3, enforce mode only) the TOKEN
 * budget is ONE fleet-wide bucket in Redis, keyed by the indexer URL — not by
 * deployment namespace, because the limit belongs to the indexer deployment
 * and two environments pointing at it must share it:
 *   - a dispatch takes 1 token from `tw:ix:v1:<url-hash>:all` and, for every
 *     non-interactive lane, also from `…:bg`, in ONE Lua call (both or neither);
 *   - a 429 sets `…:pause` (Retry-After, else 2 s doubling ≤ 30 s), and every
 *     process reads it in that same call before taking anything;
 *   - priority, the in-flight cap and timeouts stay PER PROCESS (per-role
 *     in-flight defaults sum to today's 12 — no fleet semaphore);
 *   - Redis unavailable (or no shared backend bound) → this process falls back
 *     to a LOCAL bucket at `budget × INDEXER_BUDGET_LOCAL_SHARE` (role default;
 *     `all` = 1.0 = today), retrying Redis after 5 s.
 * Tokens taken from Redis are held as per-process credits (at most one of
 * each), so the queue logic is the same in both scopes.
 */

import { Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { can, type ProcessRole, ROLE_DEFAULTS, roleCan } from '../../common/process-role.js';
import { onceAMinute, type RedisGcra } from '../../common/redis-gcra.js';
import {
  anySignal,
  INDEXER_LANES,
  type IndexerContext,
  type IndexerLane,
} from './indexer-context.js';
import {
  displayUrl,
  indexerMeterSnapshots,
  meterForUrl,
  setIndexerBudgetLineSuffix,
  type IndexerMeter,
  type IndexerMeterSnapshot,
  type IndexerOutcome,
} from './indexer-meter.js';

export type IndexerGatewayMode = 'observe' | 'enforce';
/** Where the token budget lives: this process (today) or one Redis bucket for the fleet. */
export type IndexerBudgetScope = 'process' | 'shared';

export interface IndexerGatewayConfig {
  mode: IndexerGatewayMode;
  budgetPerMin: number;
  backgroundMaxPerMin: number;
  maxInFlight: number;
  interactiveReservedInFlight: number;
  interactiveTimeoutMs: number;
  backgroundTimeoutMs: number;
  /** P2.2: `process` (default = today) | `shared` (enforce only). */
  scope?: IndexerBudgetScope;
  /** P2.2: share of the budget this process takes alone while the shared bucket is unreachable (0–1; default 1). */
  localShare?: number;
  /**
   * P2.1: does this process serve interactive (`/api`, `/v1`) traffic? Unset
   * = `can('http-api')` (`all` / `api` → true = today). A process that serves
   * none reserves NO slots for it: `interactiveReservedInFlight` is then 0 and
   * every slot is a background slot. (Reserving 4 of the sync role's 6 left
   * backfill, refresh, live and sweeps on 2 concurrent calls, with the 4
   * reserved slots idle.)
   */
  servesInteractive?: boolean;
}

/**
 * `INDEXER_INTERACTIVE_RESERVED_IN_FLIGHT` when unset, per role: `all` keeps
 * today's 4 of 12; `api` (3 slots) reserves 1, leaving 2 for its health
 * probes and refresh-lane chart walks; a role without `http-api` reserves 0
 * (and the gateway ignores any reserve there — `servesInteractive`).
 * Background slots per role = maxInFlight − this: all 8, api 2, sync 6,
 * fee 2, feeder 2.
 */
export function defaultInteractiveReservedInFlight(role: ProcessRole): number {
  if (!roleCan(role, 'http-api')) return 0;
  return ROLE_DEFAULTS[role].indexerInteractiveReservedInFlight;
}

export const DEFAULT_INDEXER_GATEWAY_CONFIG: Readonly<IndexerGatewayConfig> = Object.freeze({
  mode: 'observe',
  budgetPerMin: 900,
  backgroundMaxPerMin: 600,
  maxInFlight: 12,
  interactiveReservedInFlight: 4,
  interactiveTimeoutMs: 8_000,
  backgroundTimeoutMs: 30_000,
  scope: 'process',
  localShare: 1,
});

/** How long a process stays on its local share after the shared bucket failed, before asking Redis again. */
export const SHARED_RETRY_MS = 5_000;

/** One answer from the fleet-wide bucket. */
export interface IndexerSharedTake {
  /** `taken`: the tokens asked for are ours. `wait`: none taken, retry in `ms`. `paused`: a 429 pause is in force for `ms`. */
  status: 'taken' | 'wait' | 'paused';
  ms: number;
}

/**
 * The fleet-wide budget backend (`RedisIndexerSharedBudget` in production,
 * a fake in specs). `take` answers `undefined` when the shared state is
 * unreachable — the gateway then falls back to its local share.
 */
export interface IndexerSharedBudget {
  take(
    url: string,
    need: { all: boolean; bg: boolean },
    rates: { budgetPerMin: number; backgroundMaxPerMin: number },
  ): Promise<IndexerSharedTake | undefined>;
  pause(url: string, ms: number): Promise<void>;
}

/** `tw:ix:v1:<sha256(url)[0..16]>` — the URL itself may carry a key, so it is hashed. */
export function indexerBudgetKeyBase(url: string): string {
  return `tw:ix:v1:${createHash('sha256').update(url).digest('hex').slice(0, 16)}`;
}

/** The Redis-backed fleet budget (one `GCRA_SCRIPT` call per take). */
export class RedisIndexerSharedBudget implements IndexerSharedBudget {
  constructor(private readonly gcra: RedisGcra) {}

  async take(
    url: string,
    need: { all: boolean; bg: boolean },
    rates: { budgetPerMin: number; backgroundMaxPerMin: number },
  ): Promise<IndexerSharedTake | undefined> {
    const base = indexerBudgetKeyBase(url);
    const buckets = [];
    if (need.all) {
      buckets.push({ key: `${base}:all`, perSec: rates.budgetPerMin / 60, burst: capacityFor(rates.budgetPerMin), cost: 1 });
    }
    if (need.bg) {
      buckets.push({ key: `${base}:bg`, perSec: rates.backgroundMaxPerMin / 60, burst: capacityFor(rates.backgroundMaxPerMin), cost: 1 });
    }
    if (buckets.length === 0) return { status: 'taken', ms: 0 };
    // maxWait 0: take only what is there NOW; the gateway's own timer retries,
    // so its strict lane priority still decides who gets the next token.
    const res = await this.gcra.take({ buckets, maxWaitMs: 0, pauseKey: `${base}:pause`, ttlMs: 120_000 });
    if (!res) return undefined;
    if (res.status === 'taken') return { status: 'taken', ms: 0 };
    return { status: res.status === 'paused' ? 'paused' : 'wait', ms: Math.max(1, res.waitMs) };
  }

  async pause(url: string, ms: number): Promise<void> {
    await this.gcra.pause(`${indexerBudgetKeyBase(url)}:pause`, ms);
  }
}

/** First pause on a 429 without Retry-After; doubles per consecutive 429. */
const PAUSE_BASE_MS = 2_000;
const PAUSE_MAX_MS = 30_000;
/** A Retry-After longer than this is clamped: one bad header must not stall every job for an hour. */
const RETRY_AFTER_MAX_MS = 60_000;

/** What an upstream call settles to. The gateway reads only these two fields. */
export interface GatewaySettled {
  readonly status: number;
  readonly retryAfter?: string;
}

/**
 * The gateway refused to dispatch: the caller went away, or an interactive
 * request's deadline passed while it was queued. `rateLimited` says the queue was
 * held by a 429 pause, so the caller can surface it AS a 429.
 */
export class GatewayRejection extends Error {
  constructor(
    message: string,
    readonly reason: 'aborted' | 'deadline',
    readonly rateLimited: boolean,
    readonly retryAfter?: string,
  ) {
    super(message);
    this.name = 'GatewayRejection';
  }
}

/** The reason a gateway timeout aborts the fetch with. */
export class GatewayTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`timed out after ${timeoutMs}ms`);
    this.name = 'TimeoutError';
  }
}

/** Retry-After as milliseconds from `now`: delta-seconds or an HTTP-date. */
export function parseRetryAfterMs(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (value === undefined || value === null) return undefined;
  const v = value.trim();
  if (v === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

export function outcomeForStatus(status: number): IndexerOutcome {
  if (status === 429) return '429';
  if (status >= 500) return '5xx';
  if (status >= 400) return '4xx';
  return '2xx';
}

interface Waiter {
  readonly lane: IndexerLane;
  resolve(): void;
  reject(e: Error): void;
  cleanup(): void;
}

function normalise(c: IndexerGatewayConfig): IndexerGatewayConfig {
  const budgetPerMin = Math.max(1, c.budgetPerMin || DEFAULT_INDEXER_GATEWAY_CONFIG.budgetPerMin);
  const maxInFlight = Math.max(1, Math.floor(c.maxInFlight || DEFAULT_INDEXER_GATEWAY_CONFIG.maxInFlight));
  const share = Number(c.localShare);
  const servesInteractive = typeof c.servesInteractive === 'boolean' ? c.servesInteractive : can('http-api');
  return {
    scope: c.scope === 'shared' ? 'shared' : 'process',
    // A garbage share reads as 1 (today); a share is never above the whole budget.
    localShare: Number.isFinite(share) && share > 0 ? Math.min(1, share) : 1,
    mode: c.mode === 'enforce' ? 'enforce' : 'observe',
    budgetPerMin,
    // Background can never be granted more than the whole budget.
    backgroundMaxPerMin: Math.min(budgetPerMin, Math.max(1, c.backgroundMaxPerMin || 1)),
    maxInFlight,
    servesInteractive,
    // At least one slot must stay usable by background, or background never runs;
    // a process that serves no interactive traffic reserves nothing for it.
    interactiveReservedInFlight: servesInteractive
      ? Math.min(maxInFlight - 1, Math.max(0, Math.floor(c.interactiveReservedInFlight) || 0))
      : 0,
    interactiveTimeoutMs: Math.max(1, c.interactiveTimeoutMs || DEFAULT_INDEXER_GATEWAY_CONFIG.interactiveTimeoutMs),
    backgroundTimeoutMs: Math.max(1, c.backgroundTimeoutMs || DEFAULT_INDEXER_GATEWAY_CONFIG.backgroundTimeoutMs),
  };
}

/** Burst: about two seconds' worth of budget (30 at 900/min), never below one call. */
function capacityFor(perMin: number): number {
  return Math.max(1, Math.round(perMin / 30));
}

export interface IndexerGatewaySnapshot {
  url: string;
  mode: IndexerGatewayMode;
  paused: boolean;
  pausedForMs: number;
  consecutive429: number;
  inFlight: number;
  queued: Record<IndexerLane, number>;
  tokens: number;
  backgroundTokens: number;
  /** P2.2: present only with `scope: 'shared'`. */
  shared?: IndexerSharedSnapshot;
}

export interface IndexerSharedSnapshot {
  /** The fleet bucket is in use right now (false = local share fallback or unbound). */
  active: boolean;
  bound: boolean;
  localShare: number;
  credits: { all: number; bg: number };
  takes: number;
  waits: number;
  pausedReads: number;
  pausesPublished: number;
  fallbacks: number;
  fallbackForMs: number;
}

/** `blockedFor` answer: no budget here — ask the fleet bucket. */
const NEED_SHARED = -1;

export class IndexerGateway {
  private readonly logger = new Logger('IndexerGateway');
  private config: IndexerGatewayConfig;
  private readonly queues: Record<IndexerLane, Waiter[]> = Object.fromEntries(
    INDEXER_LANES.map((l) => [l, [] as Waiter[]]),
  ) as Record<IndexerLane, Waiter[]>;
  private inFlight = 0;
  private tokens: number;
  private bgTokens: number;
  private refilledAt: number;
  private pausedUntil = 0;
  private consecutive429 = 0;
  private wakeTimer?: NodeJS.Timeout;
  private wakeAt = 0;
  // ── P2.2 shared scope ──
  /** Tokens already taken from the fleet bucket and not yet dispatched (≤ 1 each). */
  private creditAll = 0;
  private creditBg = 0;
  /** A fleet take is in flight (one at a time per gateway). */
  private taking = false;
  /** Until when this process runs on its local share (the fleet bucket failed). */
  private sharedDownUntil = 0;
  private readonly sharedStats = { takes: 0, waits: 0, pausedReads: 0, pausesPublished: 0, fallbacks: 0 };

  constructor(
    readonly url: string,
    config: IndexerGatewayConfig = DEFAULT_INDEXER_GATEWAY_CONFIG,
    private readonly meter: IndexerMeter = meterForUrl(url),
    /** The fleet budget backend; defaults to the process-wide one (`setIndexerSharedBudget`). */
    private readonly sharedBudget: () => IndexerSharedBudget | undefined = () => processSharedBudget,
  ) {
    this.config = normalise(config);
    this.tokens = capacityFor(this.config.budgetPerMin);
    this.bgTokens = capacityFor(this.config.backgroundMaxPerMin);
    this.refilledAt = Date.now();
  }

  get mode(): IndexerGatewayMode {
    return this.config.mode;
  }

  configure(config: IndexerGatewayConfig): void {
    this.config = normalise(config);
    this.tokens = Math.min(this.tokens, capacityFor(this.config.budgetPerMin));
    this.bgTokens = Math.min(this.bgTokens, capacityFor(this.config.backgroundMaxPerMin));
    this.pump();
  }

  /**
   * Run one upstream call under the budget. `fn` receives the signal to hand to
   * `fetch` and must settle to `{ status, retryAfter? }` (it may throw on a
   * transport failure; that propagates unchanged after being metered).
   */
  async run<T extends GatewaySettled>(
    ctx: IndexerContext,
    fn: (signal: AbortSignal | undefined) => Promise<T>,
  ): Promise<T> {
    if (this.config.mode === 'observe') return this.observe(ctx, fn);

    const queuedAt = Date.now();
    try {
      await this.acquire(ctx);
    } catch (e) {
      this.record(ctx, e instanceof GatewayRejection && e.reason === 'deadline' ? 'timeout' : 'abort', 0, Date.now() - queuedAt);
      throw e;
    }
    const startedAt = Date.now();
    const queuedMs = startedAt - queuedAt;

    const timeoutMs =
      ctx.lane === 'interactive'
        ? Math.max(1, Math.min(this.config.interactiveTimeoutMs, (ctx.deadlineAt ?? Infinity) - startedAt))
        : this.config.backgroundTimeoutMs;
    // A cleared timer rather than `AbortSignal.timeout`: that one cannot be
    // cancelled once the call settles, and it ignores fake timers in specs.
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(new GatewayTimeoutError(timeoutMs)), timeoutMs);
    timer.unref?.();
    const signal = anySignal([ctx.signal, timeout.signal]);

    try {
      const out = await fn(signal);
      this.observeStatus(out.status, out.retryAfter);
      this.record(ctx, outcomeForStatus(out.status), Date.now() - startedAt, queuedMs);
      return out;
    } catch (e) {
      const outcome: IndexerOutcome = timeout.signal.aborted ? 'timeout' : ctx.signal?.aborted ? 'abort' : 'network';
      this.record(ctx, outcome, Date.now() - startedAt, queuedMs);
      throw e;
    } finally {
      clearTimeout(timer);
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.pump();
    }
  }

  snapshot(now: number = Date.now()): IndexerGatewaySnapshot {
    this.refill(now);
    return {
      url: displayUrl(this.url),
      mode: this.config.mode,
      paused: this.pausedUntil > now,
      pausedForMs: Math.max(0, this.pausedUntil - now),
      consecutive429: this.consecutive429,
      inFlight: this.inFlight,
      queued: Object.fromEntries(INDEXER_LANES.map((l) => [l, this.queues[l].length])) as Record<IndexerLane, number>,
      tokens: Math.round(this.tokens * 10) / 10,
      backgroundTokens: Math.round(this.bgTokens * 10) / 10,
      ...(this.config.scope === 'shared'
        ? {
            shared: {
              active: this.config.mode === 'enforce' && this.sharedActive(now),
              bound: Boolean(this.sharedBudget()),
              localShare: this.config.localShare ?? 1,
              credits: { all: this.creditAll, bg: this.creditBg },
              ...this.sharedStats,
              fallbackForMs: Math.max(0, this.sharedDownUntil - now),
            },
          }
        : {}),
    };
  }

  /** `shared{…}` for the minute `[indexer-budget]` line; undefined in process scope (today's line). */
  budgetLineSuffix(now: number = Date.now()): string | undefined {
    if (this.config.scope !== 'shared') return undefined;
    const st = this.sharedStats;
    const active = this.config.mode === 'enforce' && this.sharedActive(now);
    return (
      `shared{active=${active} takes=${st.takes} waits=${st.waits} pausedReads=${st.pausedReads} ` +
      `pausesPublished=${st.pausesPublished} fallbacks=${st.fallbacks}}`
    );
  }

  /** The fleet bucket is the budget right now (shared scope, backend bound, not in its fallback window). */
  private sharedActive(now: number): boolean {
    return this.config.scope === 'shared' && Boolean(this.sharedBudget()) && now >= this.sharedDownUntil;
  }

  /**
   * The per-minute rates the LOCAL bucket refills at: the whole budget in
   * process scope (today), the local share while a shared scope falls back.
   */
  private localRates(): { all: number; bg: number } {
    if (this.config.scope !== 'shared') return { all: this.config.budgetPerMin, bg: this.config.backgroundMaxPerMin };
    const share = this.config.localShare ?? 1;
    return {
      all: Math.max(1, this.config.budgetPerMin * share),
      bg: Math.max(1, this.config.backgroundMaxPerMin * share),
    };
  }

  private async observe<T extends GatewaySettled>(
    ctx: IndexerContext,
    fn: (signal: AbortSignal | undefined) => Promise<T>,
  ): Promise<T> {
    if (ctx.signal?.aborted) {
      this.record(ctx, 'abort', 0, 0);
      throw new GatewayRejection('indexer request dropped: the client closed the request', 'aborted', false);
    }
    const startedAt = Date.now();
    try {
      const out = await fn(ctx.signal);
      this.record(ctx, outcomeForStatus(out.status), Date.now() - startedAt, 0);
      return out;
    } catch (e) {
      this.record(ctx, ctx.signal?.aborted ? 'abort' : 'network', Date.now() - startedAt, 0);
      throw e;
    }
  }

  private record(ctx: IndexerContext, outcome: IndexerOutcome, latencyMs: number, queuedMs: number): void {
    this.meter.record({ lane: ctx.lane, job: ctx.job, outcome, latencyMs, queuedMs });
    if (ctx.stats) {
      ctx.stats.indexerCalls += 1;
      ctx.stats.indexerMs += latencyMs;
      ctx.stats.queuedMs += queuedMs;
    }
  }

  /** Resolves once the call holds an in-flight slot and its tokens. */
  private acquire(ctx: IndexerContext): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const now = Date.now();
      if (ctx.signal?.aborted) {
        reject(new GatewayRejection('indexer request dropped: the client closed the request', 'aborted', false));
        return;
      }
      if (ctx.lane === 'interactive' && ctx.deadlineAt !== undefined && ctx.deadlineAt <= now) {
        reject(this.deadlineRejection(now));
        return;
      }

      const queue = this.queues[ctx.lane];
      let deadlineTimer: NodeJS.Timeout | undefined;
      const remove = () => {
        const i = queue.indexOf(waiter);
        if (i !== -1) queue.splice(i, 1);
      };
      const onAbort = () => {
        remove();
        waiter.cleanup();
        reject(new GatewayRejection('indexer request dropped: the client closed the request', 'aborted', false));
        // A removed head may have been what held lower lanes back.
        this.pump();
      };
      const waiter: Waiter = {
        lane: ctx.lane,
        resolve,
        reject,
        cleanup: () => {
          if (deadlineTimer) clearTimeout(deadlineTimer);
          ctx.signal?.removeEventListener('abort', onAbort);
        },
      };
      ctx.signal?.addEventListener('abort', onAbort, { once: true });
      if (ctx.lane === 'interactive' && ctx.deadlineAt !== undefined) {
        deadlineTimer = setTimeout(() => {
          remove();
          waiter.cleanup();
          reject(this.deadlineRejection(Date.now()));
          this.pump();
        }, ctx.deadlineAt - now);
        deadlineTimer.unref?.();
      }
      queue.push(waiter);
      this.pump();
    });
  }

  private deadlineRejection(now: number): GatewayRejection {
    const paused = this.pausedUntil > now;
    return new GatewayRejection(
      paused
        ? 'indexer is rate limiting: the request deadline passed while the budget was paused'
        : 'indexer request timed out waiting for budget',
      'deadline',
      paused,
      paused ? String(Math.max(1, Math.ceil((this.pausedUntil - now) / 1000))) : undefined,
    );
  }

  private refill(now: number): void {
    const elapsed = Math.max(0, now - this.refilledAt);
    this.refilledAt = now;
    const rates = this.localRates();
    this.tokens = Math.min(capacityFor(rates.all), this.tokens + (elapsed * rates.all) / 60_000);
    this.bgTokens = Math.min(capacityFor(rates.bg), this.bgTokens + (elapsed * rates.bg) / 60_000);
  }

  /**
   * 0 = may dispatch now; >0 = ms until it may; Infinity = wait for a slot to
   * free; `NEED_SHARED` = no credit here, take from the fleet bucket.
   */
  private blockedFor(lane: IndexerLane, now: number, shared: boolean): number {
    if (this.pausedUntil > now) return this.pausedUntil - now;
    const slots =
      lane === 'interactive' ? this.config.maxInFlight : this.config.maxInFlight - this.config.interactiveReservedInFlight;
    if (this.inFlight >= slots) return Infinity;
    const EPS = 1e-9;
    if (shared) {
      return this.creditAll < 1 - EPS || (lane !== 'interactive' && this.creditBg < 1 - EPS) ? NEED_SHARED : 0;
    }
    const rates = this.localRates();
    let wait = 0;
    if (this.tokens < 1 - EPS) {
      wait = Math.max(wait, Math.ceil(((1 - this.tokens) * 60_000) / rates.all));
    }
    if (lane !== 'interactive' && this.bgTokens < 1 - EPS) {
      wait = Math.max(wait, Math.ceil(((1 - this.bgTokens) * 60_000) / rates.bg));
    }
    return wait;
  }

  /**
   * Take what the head of `lane` is missing from the fleet bucket — `all`,
   * plus `bg` for a non-interactive lane — in one call, then pump again.
   * One take at a time per gateway; a refusal waits on the gateway's timer
   * (strict priority then picks who gets the next token).
   */
  private fetchShared(lane: IndexerLane): void {
    if (this.taking) return;
    const backend = this.sharedBudget();
    if (!backend) {
      this.sharedUnavailable('no shared indexer budget is bound');
      this.pump();
      return;
    }
    const EPS = 1e-9;
    const need = { all: this.creditAll < 1 - EPS, bg: lane !== 'interactive' && this.creditBg < 1 - EPS };
    this.taking = true;
    const rates = { budgetPerMin: this.config.budgetPerMin, backgroundMaxPerMin: this.config.backgroundMaxPerMin };
    backend.take(this.url, need, rates).then(
      (res) => {
        this.taking = false;
        if (!res) {
          this.sharedUnavailable('redis-state unavailable');
          this.pump();
          return;
        }
        this.sharedStats.takes += 1;
        if (res.status === 'taken') {
          if (need.all) this.creditAll += 1;
          if (need.bg) this.creditBg += 1;
          this.pump();
          return;
        }
        const now = Date.now();
        if (res.status === 'paused') {
          this.sharedStats.pausedReads += 1;
          this.notePause(now + res.ms, now, 'fleet');
          this.pump();
          return;
        }
        this.sharedStats.waits += 1;
        this.wakeIn(Math.max(1, res.ms), now);
      },
      (err: unknown) => {
        this.taking = false;
        this.sharedUnavailable((err as Error)?.message ?? String(err));
        this.pump();
      },
    );
  }

  /** Shared scope asked for, but main.ts bound no backend: say so (once a minute) — it runs on the local share. */
  private warnUnbound(): void {
    if (!onceAMinute(`indexer.shared_unbound:${this.url}`)) return;
    this.logger.warn(
      `[alert] indexer.shared_unbound url=${displayUrl(this.url)} — INDEXER_BUDGET_SCOPE=shared but no shared ` +
        `budget is bound; this process runs on ${Math.round((this.config.localShare ?? 1) * 100)}% of the budget`,
    );
  }

  /** The fleet bucket failed: run on the local share for `SHARED_RETRY_MS`. */
  private sharedUnavailable(why: string): void {
    this.sharedDownUntil = Date.now() + SHARED_RETRY_MS;
    this.sharedStats.fallbacks += 1;
    if (onceAMinute(`indexer.shared_unavailable:${this.url}`)) {
      this.logger.warn(
        `[alert] indexer.shared_unavailable url=${displayUrl(this.url)} — ${why}; this process runs on ` +
          `${Math.round((this.config.localShare ?? 1) * 100)}% of the budget until it can reach the fleet bucket`,
      );
    }
  }

  /**
   * Dispatch every waiter that may go, highest lane first. The first head that
   * cannot go stops the walk: every lower lane needs a superset of what it is
   * missing (the same pause and bucket, a smaller slot allowance, and the
   * background bucket on top), so strict priority costs nothing here.
   */
  private pump(): void {
    const enforcing = this.config.mode === 'enforce';
    const now = Date.now();
    const shared = enforcing && this.sharedActive(now);
    if (enforcing && this.config.scope === 'shared' && !this.sharedBudget()) this.warnUnbound();
    if (!shared) this.refill(now);
    for (const lane of INDEXER_LANES) {
      const queue = this.queues[lane];
      while (queue.length > 0) {
        // Switched back to observe with calls still queued: release them all.
        const wait = enforcing ? this.blockedFor(lane, now, shared) : 0;
        if (wait === NEED_SHARED) {
          this.fetchShared(lane);
          return;
        }
        if (wait > 0) {
          if (Number.isFinite(wait)) this.wakeIn(wait, now);
          return;
        }
        const waiter = queue.shift()!;
        if (enforcing && shared) {
          this.creditAll -= 1;
          if (lane !== 'interactive') this.creditBg -= 1;
        } else if (enforcing) {
          this.tokens -= 1;
          if (lane !== 'interactive') this.bgTokens -= 1;
        }
        this.inFlight += 1;
        waiter.cleanup();
        waiter.resolve();
      }
    }
  }

  private wakeIn(ms: number, now: number): void {
    const at = now + ms;
    if (this.wakeTimer && this.wakeAt <= at) return;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeAt = at;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      this.pump();
    }, ms);
    this.wakeTimer.unref?.();
  }

  private observeStatus(status: number, retryAfter: string | undefined): void {
    if (status !== 429) {
      if (status < 400) this.consecutive429 = 0;
      return;
    }
    const now = Date.now();
    this.consecutive429 += 1;
    const fromHeader = parseRetryAfterMs(retryAfter, now);
    const ms = Math.min(
      RETRY_AFTER_MAX_MS,
      fromHeader ?? Math.min(PAUSE_MAX_MS, PAUSE_BASE_MS * 2 ** (this.consecutive429 - 1)),
    );
    const until = now + ms;
    // Shared scope: every other process reads this pause before its next take.
    if (this.config.scope === 'shared' && this.config.mode === 'enforce') {
      const backend = this.sharedBudget();
      if (backend) {
        this.sharedStats.pausesPublished += 1;
        void backend.pause(this.url, ms).catch(() => undefined);
      }
    }
    if (until <= this.pausedUntil) return;
    const wasPaused = this.pausedUntil > now;
    this.pausedUntil = until;
    if (!wasPaused) {
      this.logger.warn(
        `[indexer-gateway] url=${displayUrl(this.url)} paused ${ms}ms after a 429 ` +
          `(retry-after=${retryAfter ?? 'none'}, consecutive=${this.consecutive429})`,
      );
    }
  }

  /** A pause another process published (shared scope): hold this queue too. */
  private notePause(until: number, now: number, _source: 'fleet'): void {
    if (until <= this.pausedUntil) return;
    const wasPaused = this.pausedUntil > now;
    this.pausedUntil = until;
    if (!wasPaused && onceAMinute(`indexer.shared_pause:${this.url}`)) {
      this.logger.warn(
        `[alert] indexer.shared_pause url=${displayUrl(this.url)} paused ${until - now}ms — another process got a 429`,
      );
    }
  }
}

let globalConfig: IndexerGatewayConfig = { ...DEFAULT_INDEXER_GATEWAY_CONFIG };
const gateways = new Map<string, IndexerGateway>();
/** The fleet budget every gateway uses in `scope: 'shared'` (main.ts binds it; unbound = local share). */
let processSharedBudget: IndexerSharedBudget | undefined;

setIndexerBudgetLineSuffix((url) => gateways.get(url)?.budgetLineSuffix());

/** Bind (or clear) the fleet-wide indexer budget backend. main.ts, before the first indexer call. */
export function setIndexerSharedBudget(budget: IndexerSharedBudget | undefined): void {
  processSharedBudget = budget;
}

/** Applied once at boot from `AppConfigService` (main.ts); every gateway follows. */
export function configureIndexerGateways(config: Partial<IndexerGatewayConfig>): void {
  globalConfig = normalise({ ...globalConfig, ...config });
  for (const g of gateways.values()) g.configure(globalConfig);
}

export function indexerGatewayMode(): IndexerGatewayMode {
  return globalConfig.mode;
}

export function gatewayForUrl(url: string): IndexerGateway {
  let g = gateways.get(url);
  if (!g) {
    g = new IndexerGateway(url, globalConfig);
    gateways.set(url, g);
  }
  return g;
}

export interface IndexerBudgetSnapshot {
  url: string;
  meter: IndexerMeterSnapshot | null;
  gateway: IndexerGatewaySnapshot | null;
}

/** Meter + gateway state per URL, for `GET /admin/sync/status`. Empty before the first indexer call. */
export function indexerBudgetSnapshot(now: number = Date.now()): IndexerBudgetSnapshot[] {
  const byUrl = new Map<string, IndexerBudgetSnapshot>();
  for (const m of indexerMeterSnapshots(now)) byUrl.set(m.url, { url: m.url, meter: m, gateway: null });
  for (const g of gateways.values()) {
    const s = g.snapshot(now);
    const row = byUrl.get(s.url) ?? { url: s.url, meter: null, gateway: null };
    row.gateway = s;
    byUrl.set(s.url, row);
  }
  return [...byUrl.values()];
}

/** Test seam. */
export function __resetIndexerGateways(): void {
  gateways.clear();
  globalConfig = { ...DEFAULT_INDEXER_GATEWAY_CONFIG };
  processSharedBudget = undefined;
}
