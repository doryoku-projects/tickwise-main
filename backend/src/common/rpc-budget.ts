import { Inject, Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import { CoordinationRedis } from './coordination-redis.js';
import { currentProcessRole, type ProcessRole } from './process-role.js';
import {
  LocalGcra,
  onceAMinute,
  RedisGcra,
  sharedStateRedis,
  type GcraRequest,
  type GcraResult,
  type SharedStateRedisSource,
} from './redis-gcra.js';

/**
 * P2.2 §3.4 — ONE request budget per Dwellir ACCOUNT, shared by every chain,
 * key, process and batch member that bills to it.
 *
 * Dwellir's limit (500 req/s, burst 2,500, 150M/month on Growth) is
 * ACCOUNT-WIDE, so the bucket is keyed by account — never by host and never by
 * deployment namespace: `tw:rpc:v1:acct:<account>`. `RPC_ACCOUNT_MAP`
 * (`host=account,…`) names the account of each RPC host; every host not
 * listed is `default`, so by default all chains share ONE bucket.
 *
 *   RPC_BUDGET_PER_SEC=0 (default)  off: nothing is taken, nothing is counted,
 *                                   `budgetedFetch` is plain `fetch` — today.
 *   RPC_BUDGET_PER_SEC=N            the BACKEND's share of the account's req/s
 *                                   (the indexer and the rig keep the rest).
 *
 * `budgetedFetch(lane)` is a `fetchFn` for viem's `http()` transport: EVERY
 * HTTP attempt — viem's retries included — takes its tokens before it is
 * sent, and a JSON-RPC batch body costs one token per member (Dwellir bills
 * members). A multicall is one request.
 *
 * Month counter: the same Lua call `INCRBY`s
 * `tw:rpc:v1:acct:<account>:month:<YYYY-MM>`; crossing 50 / 75 / 90 % of
 * `RPC_MONTHLY_CAP` (the backend's monthly share) logs `[alert] rpc.month_<p>`.
 *
 * Redis unavailable → a per-process bucket at the ROLE's local share of the
 * rate (`rpcLocalShareFor`): `all` = 1.0 (the one process that reads RPC owns
 * the whole share, as with no budget), every split role = `RPC_LOCAL_SHARE`
 * (0.25 = design §3.5's 0.5 / the two processes that read RPC). Fail OPEN.
 */

export type RpcLane = 'fee' | 'backfill' | 'payments';
export const RPC_LANES: readonly RpcLane[] = ['fee', 'backfill', 'payments'];

/** Burst = this many seconds of the rate (design: 2 s). */
export const RPC_BURST_SECONDS = 2;
/** Redis-down share of the rate per SPLIT-role process (design §3.5: × 0.5 / 2 RPC processes). */
export const RPC_LOCAL_SHARE = 0.25;

/**
 * Redis-down share of `RPC_BUDGET_PER_SEC` a process takes alone. `all` is
 * the whole fleet in one process, so it keeps the whole rate (a quarter would
 * stretch the fee pass and the backfill reads ~4× during a redis-state
 * outage); a split role takes `RPC_LOCAL_SHARE`, so the RPC-reading processes
 * of a split fleet stay inside the account's limit together.
 */
export function rpcLocalShareFor(role: ProcessRole): number {
  return role === 'all' ? 1 : RPC_LOCAL_SHARE;
}
/** Default longest wait for tokens before a request is refused (viem treats it as a failed attempt). */
export const RPC_MAX_WAIT_MS = 30_000;
export const RPC_MONTH_THRESHOLDS = [50, 75, 90] as const;
/** `status().reqPerSec` window, in one-second slots. */
const RECENT_WINDOW_SEC = 60;
/** Month keys live ~40 days (the month plus a margin to read it back). */
const MONTH_TTL_SEC = 40 * 24 * 3600;

export const DEFAULT_ACCOUNT = 'default';

/** `tw:rpc:v1:acct:<account>` — NOT namespaced: the account is shared by every environment on it. */
export function rpcBucketKey(account: string): string {
  return `tw:rpc:v1:acct:${account}`;
}

/** `tw:rpc:v1:acct:<account>:month:<YYYY-MM>` (UTC). */
export function rpcMonthKey(account: string, at: Date): string {
  return `${rpcBucketKey(account)}:month:${monthOf(at)}`;
}

function monthOf(at: Date): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Parse `host=account,host2=account2` (case-insensitive hosts; blanks and malformed pairs ignored). */
export function parseRpcAccountMap(raw: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (typeof raw !== 'string') return map;
  for (const pair of raw.split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const host = pair.slice(0, eq).trim().toLowerCase();
    const account = pair.slice(eq + 1).trim();
    if (host && /^[A-Za-z0-9_.-]+$/.test(account)) map.set(host, account);
  }
  return map;
}

/** The Dwellir account `url` bills to (`default` for any host not in the map, or an unparseable url). */
export function rpcAccountFor(url: string | undefined, map: ReadonlyMap<string, string>): string {
  if (!url) return DEFAULT_ACCOUNT;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return DEFAULT_ACCOUNT;
  }
  return map.get(host) ?? DEFAULT_ACCOUNT;
}

/**
 * Tokens one HTTP request costs: 1, or the member count of a JSON-RPC batch
 * (Dwellir counts batch members). Only a body that starts with `[` is parsed.
 */
export function rpcRequestCost(body: unknown): number {
  if (typeof body !== 'string') return 1;
  const head = body.trimStart();
  if (!head.startsWith('[')) return 1;
  try {
    const parsed = JSON.parse(head) as unknown;
    return Array.isArray(parsed) && parsed.length > 0 ? parsed.length : 1;
  } catch {
    return 1;
  }
}

export class RpcBudgetTimeoutError extends Error {
  constructor(
    readonly lane: RpcLane,
    readonly account: string,
    readonly waitMs: number,
  ) {
    super(`rpc budget: ${lane} on account ${account} would wait ${Math.round(waitMs)} ms, past its deadline`);
    this.name = 'RpcBudgetTimeoutError';
  }
}

export interface RpcTakeOptions {
  /** The request URL (its host picks the account). */
  url?: string;
  /** Or the account directly. */
  account?: string;
  /** Aborts the wait (the request's own signal — viem's timeout). */
  signal?: AbortSignal | null;
  maxWaitMs?: number;
}

export interface RpcBudgetStatus {
  enabled: boolean;
  perSec: number;
  monthlyCap: number;
  accounts: Record<
    string,
    { requests: number; tokens: number; waitedMs: number; refused: number; local: number; month: number | null; monthPct: number | null }
  >;
  byLane: Record<RpcLane, number>;
  /** Requests per second over the last minute, this process. */
  reqPerSec: number;
}

interface RpcConfigView {
  rpcBudgetPerSec?: number;
  rpcAccountMap?: string;
  rpcMonthlyCap?: number;
}

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

@Injectable()
export class RpcBudget implements OnModuleInit {
  private readonly logger = new Logger(RpcBudget.name);
  private readonly local: LocalGcra;
  private gcra?: RedisGcra;
  private source?: SharedStateRedisSource;
  private readonly accountStats = new Map<
    string,
    { requests: number; tokens: number; waitedMs: number; refused: number; local: number; month: number | null }
  >();
  private readonly byLane: Record<RpcLane, number> = { fee: 0, backfill: 0, payments: 0 };
  /** month string → thresholds already alerted (per account). */
  private readonly alerted = new Map<string, Set<number>>();
  /**
   * Requests per whole second over the last minute: a 60-slot ring of
   * counters (slot = second % 60, `recentSec` = the second it holds), so the
   * rate is exact at any volume and a take is O(1). It used to be one
   * timestamp per request cut to 4,096 entries — a ceiling of ~68 req/s.
   */
  private readonly recentCount = new Array<number>(RECENT_WINDOW_SEC).fill(0);
  private readonly recentSec = new Array<number>(RECENT_WINDOW_SEC).fill(-1);
  private accountMapCache?: { raw: unknown; map: Map<string, string> };
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal | null) => Promise<void>;

  constructor(
    @Optional() @Inject(AppConfigService) private readonly config?: AppConfigService,
    @Optional() @Inject(CoordinationRedis) private readonly redis?: SharedStateRedisSource,
    // Specs only (fake clock / fetch); Nest finds nothing to inject.
    @Optional() private readonly hooks?: {
      now?: () => number;
      sleep?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
      gcra?: RedisGcra;
      fetch?: FetchFn;
      role?: ProcessRole;
    },
  ) {
    this.now = hooks?.now ?? Date.now;
    this.sleep = hooks?.sleep ?? abortableSleep;
    this.local = new LocalGcra(this.now);
  }

  /** A Nest-built budget becomes the process's (`processRpcBudget()`), for callers outside DI. */
  onModuleInit(): void {
    registerProcessRpcBudget(this);
  }

  private view(): RpcConfigView {
    return (this.config as unknown as RpcConfigView | undefined) ?? {};
  }

  /** Requests per second of the backend's share; 0 = off. */
  get perSec(): number {
    const v = Number(this.view().rpcBudgetPerSec);
    return Number.isFinite(v) && v > 0 ? v : 0;
  }

  get enabled(): boolean {
    return this.perSec > 0;
  }

  /** This process's Redis-down share of the rate (by role — see `rpcLocalShareFor`). */
  get localShare(): number {
    return rpcLocalShareFor(this.role());
  }

  private role(): ProcessRole {
    return this.hooks?.role ?? currentProcessRole();
  }

  get monthlyCap(): number {
    const v = Number(this.view().rpcMonthlyCap);
    return Number.isFinite(v) && v > 0 ? v : 150_000_000;
  }

  private accountMap(): Map<string, string> {
    const raw = this.view().rpcAccountMap;
    if (!this.accountMapCache || this.accountMapCache.raw !== raw) {
      this.accountMapCache = { raw, map: parseRpcAccountMap(raw) };
    }
    return this.accountMapCache.map;
  }

  /** The account a request to `url` bills to. */
  accountFor(url: string | undefined): string {
    return rpcAccountFor(url, this.accountMap());
  }

  private redisGcra(): RedisGcra {
    if (this.hooks?.gcra) return this.hooks.gcra;
    this.source ??= sharedStateRedis(this.redis, this.config);
    const source = this.source;
    this.gcra ??= new RedisGcra(() => source.client());
    return this.gcra;
  }

  /**
   * Take `cost` tokens for `lane` and wait until they are ours. Off → returns
   * at once. A wait past `maxWaitMs` takes nothing and throws
   * `RpcBudgetTimeoutError`; an abort of `signal` while waiting rejects with
   * the signal's reason (the tokens stay spent — the request may be retried).
   */
  async take(lane: RpcLane, cost = 1, opts: RpcTakeOptions = {}): Promise<{ waitedMs: number; source: 'off' | 'redis' | 'local' }> {
    if (!this.enabled) return { waitedMs: 0, source: 'off' };
    const tokens = Number.isFinite(cost) && cost > 0 ? Math.ceil(cost) : 1;
    const account = opts.account ?? this.accountFor(opts.url);
    const maxWait = Math.max(0, opts.maxWaitMs ?? RPC_MAX_WAIT_MS);
    const now = new Date(this.now());
    const req: GcraRequest = {
      buckets: [{ key: rpcBucketKey(account), perSec: this.perSec, burst: Math.max(tokens, this.perSec * RPC_BURST_SECONDS), cost: tokens }],
      maxWaitMs: maxWait,
      counter: { key: rpcMonthKey(account, now), by: tokens, ttlSec: MONTH_TTL_SEC },
    };
    let source: 'redis' | 'local' = 'redis';
    let res: GcraResult | undefined = await this.redisGcra().take(req);
    if (!res) {
      source = 'local';
      const share = this.localShare;
      res = this.local.take({
        ...req,
        buckets: req.buckets.map((b) => ({ ...b, perSec: b.perSec * share, burst: Math.max(tokens, b.burst * share) })),
        counter: undefined,
      });
      if (onceAMinute(`rpc.budget_local:${account}`)) {
        this.logger.warn(
          `rpc budget: redis-state unavailable, account ${account} on a per-process bucket at ` +
            `${Math.round(share * 100)}% of ${this.perSec}/s (fail-open; role ${this.role()})`,
        );
      }
    }
    const stats = this.stats(account);
    if (res.status !== 'taken') {
      stats.refused += 1;
      throw new RpcBudgetTimeoutError(lane, account, res.waitMs);
    }
    stats.requests += 1;
    stats.tokens += tokens;
    if (source === 'local') stats.local += 1;
    this.byLane[lane] += 1;
    this.noteRecent();
    if (res.counter !== undefined) this.noteMonth(account, res.counter, now);
    if (res.waitMs > 0) {
      stats.waitedMs += res.waitMs;
      await this.sleep(res.waitMs, opts.signal);
    }
    return { waitedMs: res.waitMs, source };
  }

  /**
   * A `fetchFn` for viem's `http(url, { fetchFn })`: every attempt (viem's
   * retries included) takes its tokens first. Off → the plain fetch, so the
   * transport behaves exactly as today.
   */
  budgetedFetch(lane: RpcLane, fetchImpl?: FetchFn): FetchFn {
    const base: FetchFn = fetchImpl ?? this.hooks?.fetch ?? ((input, init) => fetch(input, init));
    // Off: hand back the fetch itself — not a wrapper — so the transport is
    // exactly today's (the config is fixed for the life of the process).
    if (!this.enabled) return base;
    return async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      await this.take(lane, rpcRequestCost(init?.body), { url, signal: init?.signal });
      return base(input, init);
    };
  }

  status(): RpcBudgetStatus {
    const accounts: RpcBudgetStatus['accounts'] = {};
    for (const [account, s] of this.accountStats) {
      accounts[account] = { ...s, monthPct: s.month === null ? null : Math.round((s.month / this.monthlyCap) * 1000) / 10 };
    }
    const nowSec = Math.floor(this.now() / 1000);
    let lastMinute = 0;
    for (let i = 0; i < RECENT_WINDOW_SEC; i++) {
      const sec = this.recentSec[i];
      if (sec > nowSec - RECENT_WINDOW_SEC && sec <= nowSec) lastMinute += this.recentCount[i];
    }
    return {
      enabled: this.enabled,
      perSec: this.perSec,
      monthlyCap: this.monthlyCap,
      accounts,
      byLane: { ...this.byLane },
      reqPerSec: Math.round((lastMinute / 60) * 10) / 10,
    };
  }

  private stats(account: string) {
    let s = this.accountStats.get(account);
    if (!s) {
      s = { requests: 0, tokens: 0, waitedMs: 0, refused: 0, local: 0, month: null };
      this.accountStats.set(account, s);
    }
    return s;
  }

  private noteRecent(): void {
    const sec = Math.floor(this.now() / 1000);
    const slot = ((sec % RECENT_WINDOW_SEC) + RECENT_WINDOW_SEC) % RECENT_WINDOW_SEC;
    if (this.recentSec[slot] !== sec) {
      this.recentSec[slot] = sec;
      this.recentCount[slot] = 0;
    }
    this.recentCount[slot] += 1;
  }

  /** Alert once per threshold per account per month as the month total crosses 50 / 75 / 90 % of the cap. */
  private noteMonth(account: string, total: number, at: Date): void {
    this.stats(account).month = total;
    const cap = this.monthlyCap;
    const key = `${account}:${monthOf(at)}`;
    let done = this.alerted.get(key);
    for (const pct of RPC_MONTH_THRESHOLDS) {
      if (total < (cap * pct) / 100) continue;
      if (!done) {
        done = new Set();
        this.alerted.set(key, done);
      }
      if (done.has(pct)) continue;
      done.add(pct);
      this.logger.warn(
        `[alert] rpc.month_${pct} account=${account} month=${monthOf(at)} requests=${total} ` +
          `cap=${cap} (${Math.round((total / cap) * 1000) / 10}% of the backend's monthly RPC share)`,
      );
    }
  }
}

/** Sleep `ms`, rejecting with the signal's reason if it aborts first. */
function abortableSleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error('aborted'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

let processBudget: RpcBudget | undefined;

/** The process's RPC budget (set by the integrator's provider; undefined = off). */
export function processRpcBudget(): RpcBudget | undefined {
  return processBudget;
}

export function registerProcessRpcBudget(budget: RpcBudget | undefined): void {
  processBudget = budget;
}
