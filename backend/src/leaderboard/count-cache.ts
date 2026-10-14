import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  LIST_CACHE_JITTER,
  listCacheTtl,
  staleSince,
  stalenessBudgetMs,
  SwrCache,
  type ReadMeta,
  type SwrTtl,
} from '../common/cache/swr-cache.js';
import { readPathMeter } from '../common/cache/read-path-meter.js';
import { ReadBudgetService, ReadBudgetTimeoutError } from '../common/read-budget.js';
import { AppConfigService } from '../config/app-config.service.js';
import { userReadLagMs } from '../database/replication-lag.js';
import { isMaxTimeMSExpired, QueryTimeoutException } from '../database/user-read.js';

/** A list count, capped: when `capped`, `count` is a floor. */
export interface CountResult {
  count: number;
  capped: boolean;
}

const UNMETERED = Symbol('unmetered-count');

/**
 * Mark a count runner that reads nothing from Mongo (the read-model engines,
 * P-R R2): it shares the count cache — the same key, the same peek / within /
 * settle contract, so a page's total does not depend on which path counted
 * it — but skips the read budget and the count slots.
 */
export function unmeteredCount<T extends () => Promise<CountResult>>(run: T): T {
  return Object.assign(run, { [UNMETERED]: true as const });
}

function isUnmetered(run: () => Promise<CountResult>): boolean {
  return (run as { [UNMETERED]?: true })[UNMETERED] === true;
}

/**
 * At most this many count queries run at once, awaited or background — per
 * process; the global read budget (`ReadBudgetService`, lane `count`) is what
 * bounds them across processes.
 */
const MAX_CONCURRENT_COUNTS = 2;
/**
 * At most this many counts wait for a slot. Past it a new count is refused
 * (`CountQueueFullError`) instead of queued: a page then says pending and a
 * later view asks again, rather than a backlog of counts for filters nobody is
 * still looking at holding both slots for minutes.
 */
const MAX_WAITING_COUNTS = 32;
/**
 * A failed count (typically its 8 s `maxTimeMS`) is remembered this long, so
 * the next views of that filter neither re-run a count that is going to fail
 * again nor wait on one — without it a broad filter on a pre-index shard ran
 * an 8 s doomed scan on every view.
 */
const FAILED_COUNT_MS = 90_000;
/** How long a count waits for read budget before it gives up (and the route says pending). */
const COUNT_BUDGET_WAIT_MS = 5_000;
/**
 * Rows reserved for a count never seen before. A count's real cost is only
 * known afterwards (it matched `count` rows, and examined at least that many),
 * so the first run reserves this and repays the difference (`charge`); later
 * runs reserve the last result.
 */
const DEFAULT_COUNT_COST = 2_500;
const MAX_REMEMBERED_COSTS = 2_000;

/** Raised when the count queue is full; never remembered as the key's failure. */
export class CountQueueFullError extends Error {
  constructor() {
    super('count queue is full');
    this.name = 'CountQueueFullError';
  }
}

/** Why a `/count` route answered `pending` (metered). */
export type CountPendingReason = 'wait' | 'queue_full' | 'budget' | 'timeout' | 'redis' | 'mongo' | 'error';

/**
 * The reason a count did not produce a number. Everything here answers
 * `pending` on the `/count` routes — a count never 5xx's — and only `error`
 * (something not a known transient condition) is worth an `[alert]`.
 */
export function countPendingReason(err: unknown): CountPendingReason {
  if (err instanceof CountQueueFullError) return 'queue_full';
  if (err instanceof ReadBudgetTimeoutError) return 'budget';
  if (err instanceof QueryTimeoutException || isMaxTimeMSExpired(err)) return 'timeout';
  const name = (err as { name?: unknown })?.name;
  if (name === 'ReplyError' || name === 'MaxRetriesPerRequestError') return 'redis';
  if (typeof name === 'string' && /^Mongo(Network|ServerSelection|NotConnected|NetworkTimeout|PoolCleared)Error$/.test(name)) {
    return 'mongo';
  }
  return 'error';
}

/** `/api/top-positions/count` and `/api/top-pools/count`. */
export interface ListCountResponse {
  /** Null while not known — `pending`. */
  total: number | null;
  capped: boolean;
  /** No number yet: the count is still running, queued, or failed for now. Ask again. */
  pending?: true;
  /**
   * The count was read from a secondary lagging past the staleness budget:
   * `dataAsOf` (ISO) is when its data was current. Additive, and no-store.
   */
  stale?: true;
  dataAsOf?: string;
}

/** How long a `/count` route waits for its count before answering `pending`. */
export const COUNT_ROUTE_WAIT_MS = 3_000;

/**
 * List counts, OFF the page's critical path.
 *
 * A list page never awaits a count: it reads `peek` (a cached value, or nothing
 * plus a background count) and says `totalPending` until one exists. The
 * `/count` routes `get` it (single-flight, so the background count a page just
 * started is the one they join), and `/v1` waits a bounded time with `within`.
 *
 * Counts are expensive and unbounded in a way a page is not — so at most
 * `MAX_CONCURRENT_COUNTS` run at once across every key, at most
 * `MAX_WAITING_COUNTS` more queue, and a count that failed is not re-run for
 * `FAILED_COUNT_MS`.
 * Keys are the plan `countKey`s the repositories derive from the filter they
 * actually run, which already name the shard and the query.
 */
@Injectable()
export class LeaderboardCountService {
  private readonly logger = new Logger(LeaderboardCountService.name);
  private readonly cache: SwrCache<CountResult>;
  private readonly ttl: SwrTtl;
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  /** Keys whose last count failed, until when, and the error to answer with meanwhile. */
  private readonly failed = new Map<string, { until: number; err: unknown }>();
  /** The last result per key: the next run's budget reservation. */
  private readonly costs = new Map<string, number>();
  private readonly now = (): number => Date.now();
  /** The staleness budget: a count whose data is older is reported `stale` by the `/count` routes. */
  readonly budgetMs: number;

  constructor(
    // APPENDED and optional: specs construct this service with no arguments.
    @Optional() @Inject(AppConfigService) config?: AppConfigService,
    @Optional() @Inject(ReadBudgetService) private readonly budget?: ReadBudgetService,
  ) {
    // Inside the staleness budget like every list cache: fresh 15 s, stale 30 s
    // (it was 2 min — 10 min for a slow count — and 30 min stale).
    this.ttl = listCacheTtl(config);
    this.budgetMs = stalenessBudgetMs(config);
    this.cache = new SwrCache<CountResult>({
      name: 'list-counts',
      maxBytes: 8 * 1024 * 1024,
      ...this.ttl,
      fallbackMs: 0,
      jitter: LIST_CACHE_JITTER,
      // Counted on secondaries: the count is as old as their lag.
      dataLag: () => userReadLagMs(),
      // Background refreshes queue on the semaphore below rather than being
      // skipped, so this only bounds how many keys can be waiting at once.
      maxBackgroundRefreshes: 64,
      onBackgroundError: (key, err) => {
        if (countPendingReason(err) !== 'error') return; // transient; a later view retries
        this.logger.warn(`count refresh failed key=${key.slice(0, 120)}: ${(err as Error)?.message ?? String(err)}`);
      },
    });
  }

  /** The cached count, if any — never waits. A stale or missing count is refreshed in the background. */
  peek(key: string, run: () => Promise<CountResult>): CountResult | undefined {
    const cached = this.cache.peek(key);
    if ((!cached || cached.status === 'stale') && !this.recentFailure(key)) {
      this.cache.refreshInBackground(key, this.loader(key, run), this.getOptions());
    }
    return cached?.value;
  }

  /**
   * The count, waiting for it when nothing is cached (single-flight per key).
   * A count that failed in the last `FAILED_COUNT_MS` answers with that failure
   * at once instead of running again.
   */
  async get(key: string, run: () => Promise<CountResult>): Promise<CountResult> {
    return (await this.getWithAge(key, run)).result;
  }

  /** `get`, with when the count's data was current (its read less the replication lag). */
  private async getWithAge(key: string, run: () => Promise<CountResult>): Promise<{ result: CountResult; dataAt: number }> {
    const cached = this.cache.peek(key);
    const failure = cached ? undefined : this.recentFailure(key);
    if (failure) throw failure.err;
    const { value, dataAt } = await this.cache.get(key, this.loader(key, run), this.getOptions());
    return { result: value, dataAt };
  }

  /**
   * A result may carry its own `dataAt` (an engine count is as old as the
   * model generation it was counted on, P-R R2); a Mongo count does not, and
   * is as old as the secondary's lag.
   */
  private getOptions(): { ttl: SwrTtl; times: (value: CountResult) => { dataAt?: number } } {
    return { ttl: this.ttl, times: (value) => ({ dataAt: (value as CountResult & { dataAt?: number }).dataAt }) };
  }

  /**
   * The count if it is cached or arrives within `ms` — otherwise why not (the
   * count carries on in the background and lands in the cache). Never throws.
   */
  async settle(
    key: string,
    run: () => Promise<CountResult>,
    ms: number,
  ): Promise<{ result: CountResult; dataAt?: number; cached?: true } | { pending: CountPendingReason }> {
    const entry = this.cache.peek(key);
    const cached = this.peek(key, run);
    // `cached`: answered from the cache with no wait (the `/api` budget gives a
    // count's miss surcharge back for it).
    if (cached) return { result: cached, cached: true, ...(entry ? { dataAt: entry.dataAt } : {}) };
    const failure = this.recentFailure(key);
    if (failure) return { pending: countPendingReason(failure.err) };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.getWithAge(key, run).then(
          ({ result, dataAt }) => ({ result, dataAt }),
          (err: unknown) => ({ pending: countPendingReason(err) }),
        ),
        new Promise<{ pending: CountPendingReason }>((resolve) => {
          timer = setTimeout(() => resolve({ pending: 'wait' }), Math.max(0, ms));
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * The count if it is cached or arrives within `ms`; otherwise undefined (the
   * count carries on in the background and lands in the cache).
   */
  async within(key: string, run: () => Promise<CountResult>, ms: number): Promise<CountResult | undefined> {
    const settled = await this.settle(key, run, ms);
    return 'result' in settled ? settled.result : undefined;
  }

  /**
   * The cache loader for `key`: the count under the slot limit and the global
   * read budget, its failure remembered — except a full queue or an exhausted
   * budget, which say nothing about the count itself.
   */
  private loader(key: string, run: () => Promise<CountResult>): () => Promise<CountResult> {
    return async () => {
      try {
        // A count that reads no Mongo (a read-model engine's, P-R R2) takes no
        // read budget and no count slot: it must not queue behind 8 s scans.
        const result = isUnmetered(run) ? await run() : await this.limited(() => this.budgeted(key, run));
        this.failed.delete(key);
        return result;
      } catch (err) {
        const reason = countPendingReason(err);
        if (reason !== 'queue_full' && reason !== 'budget') this.rememberFailure(key, err);
        if (reason === 'error') {
          this.logger.warn(
            `[alert] counts.failed key=${key.slice(0, 120)} err=${(err as Error)?.message ?? String(err)} ` +
              `(the /count route answers pending)`,
          );
        }
        throw err;
      }
    };
  }

  /**
   * Run a Mongo count under a count slot and the read budget, outside the
   * cache — for a runner that is marked unmetered but has to fall back to
   * Mongo at run time (a read-model engine refusing a count it compiled,
   * P-R R3): the fallback pays what any Mongo count pays.
   */
  metered(key: string, run: () => Promise<CountResult>): Promise<CountResult> {
    return this.limited(() => this.budgeted(key, run));
  }

  /**
   * Run a count through the global read budget: reserve its expected cost
   * (the key's last result, or `DEFAULT_COUNT_COST`), waiting up to
   * `COUNT_BUDGET_WAIT_MS`, then repay whatever it matched beyond that.
   */
  private async budgeted(key: string, run: () => Promise<CountResult>): Promise<CountResult> {
    if (!this.budget) return run();
    const estimate = this.costs.get(key) ?? DEFAULT_COUNT_COST;
    await this.budget.reserve(estimate, { deadlineAt: this.now() + COUNT_BUDGET_WAIT_MS, lane: 'count' });
    const startedAt = this.now();
    let result: CountResult;
    try {
      result = await run();
    } finally {
      // A count carrying the spam `$nin` FETCHes every key it tests: its
      // database time, not the rows it matched, is what it cost.
      this.budget.chargeTime(this.now() - startedAt, estimate, 'count');
    }
    if (result.count > estimate) this.budget.charge(result.count - estimate, 'count');
    this.costs.delete(key);
    this.costs.set(key, Math.max(1, result.count));
    if (this.costs.size > MAX_REMEMBERED_COSTS) {
      const oldest = this.costs.keys().next().value;
      if (oldest !== undefined) this.costs.delete(oldest);
    }
    return result;
  }

  private recentFailure(key: string): { until: number; err: unknown } | undefined {
    const failure = this.failed.get(key);
    if (!failure) return undefined;
    if (failure.until > this.now()) return failure;
    this.failed.delete(key);
    return undefined;
  }

  private rememberFailure(key: string, err: unknown): void {
    const now = this.now();
    if (this.failed.size >= 1_000) {
      for (const [k, failure] of this.failed) if (failure.until <= now) this.failed.delete(k);
    }
    this.failed.set(key, { until: now + FAILED_COUNT_MS, err });
  }

  /**
   * Run `task` once a count slot is free. A finishing task hands its slot
   * straight to the next waiter (no decrement in between), so a newcomer can
   * never slip in and push the count past the limit. With every slot busy and
   * `MAX_WAITING_COUNTS` already queued, it refuses rather than queue.
   */
  private async limited<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= MAX_CONCURRENT_COUNTS) {
      if (this.waiting.length >= MAX_WAITING_COUNTS) throw new CountQueueFullError();
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active++;
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }

  /** In-flight count queries (for specs). */
  get activeCounts(): number {
    return this.active;
  }
}

/** How long `/v1` list routes wait for an uncached count before answering a floor. */
export const V1_COUNT_WAIT_MS = 2_000;

/**
 * `pagination` on `/api/top-positions`, `/api/top-pools` and their `/v1`
 * twins. `hasMore` is always exact. `total`/`totalPages` are null with
 * `totalPending` while no count is cached (`/api` only — the `/count` routes
 * answer it); `totalCapped` marks `total` as a floor (the count hit the cap, or
 * `/v1` gave up waiting and reports the rows it can prove exist).
 */
export interface ListPagination {
  page: number;
  limit: number;
  total: number | null;
  totalPages: number | null;
  hasMore: boolean;
  totalPending?: true;
  totalCapped?: true;
}

export interface CountTask {
  key: string;
  run: () => Promise<CountResult>;
}

/**
 * Build a list `pagination` block without putting a count on the page's path.
 *
 * Order of preference: a total the page itself PROVES (no next row and the page
 * is not past the end; or the read already knew the exact match count) → the
 * cached counts → pending (`/api`) or, after `countWaitMs`, a floor (`/v1`).
 * A cached count below what the page proves exists is stale; the floor wins and
 * is flagged as one.
 */
export async function resolveListPagination(args: {
  page: number;
  limit: number;
  rowsOnPage: number;
  hasMore: boolean;
  exactTotal?: number;
  counts: LeaderboardCountService;
  /** Built lazily: only needed when the page cannot prove its own total. */
  tasks: () => Promise<CountTask[]>;
  countWaitMs?: number;
}): Promise<ListPagination> {
  const { page, limit, rowsOnPage, hasMore } = args;
  // Rows the page PROVES exist. The earlier pages' rows count only when this
  // page returned rows itself: an empty page past the end proves nothing about
  // how many came before it (page 5 of a 40-row result is empty, and must not
  // report 100).
  const proven = rowsOnPage > 0 ? (page - 1) * limit + rowsOnPage + (hasMore ? 1 : 0) : 0;
  const totals = (total: number, capped: boolean): ListPagination => ({
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
    hasMore,
    ...(capped ? { totalCapped: true as const } : {}),
  });

  if (!hasMore && (rowsOnPage > 0 || page === 1)) return totals(proven, false);
  if (args.exactTotal !== undefined) return totals(Math.max(args.exactTotal, proven), false);

  let tasks: CountTask[] | undefined;
  try {
    tasks = await args.tasks();
  } catch {
    // Building a count's plan failed (the exclusion set's first load, a
    // database error): the page itself is fine, its total is just unknown.
    tasks = undefined;
  }
  let results: Array<CountResult | undefined>;
  if (!tasks) results = [undefined];
  else if (args.countWaitMs === undefined) {
    results = tasks.map((task) => args.counts.peek(task.key, task.run));
  } else {
    const waitMs = args.countWaitMs;
    results = await Promise.all(tasks.map((task) => args.counts.within(task.key, task.run, waitMs)));
  }

  if (results.some((result) => result === undefined)) {
    if (args.countWaitMs === undefined) {
      return { page, limit, total: null, totalPages: null, hasMore, totalPending: true };
    }
    return totals(proven, true);
  }
  const counted = results as CountResult[];
  const sum = counted.reduce((acc, result) => acc + result.count, 0);
  const capped = counted.some((result) => result.capped);
  return totals(Math.max(sum, proven), capped || sum < proven);
}

/**
 * The `/count` routes: the capped total for a list's filters, summed across
 * the shards it spans — or `{total: null, capped: false, pending: true}` when
 * any shard's count is not in within `COUNT_ROUTE_WAIT_MS` (still running,
 * queued, out of read budget, timed out, or failed). NEVER a 5xx: a count is a
 * decoration of a page the client already has, and the dashboard asks again.
 * The 25,000 cap and `capped` are unchanged. A count whose data is older than
 * the staleness budget (counted on a secondary lagging past it) is answered
 * with `stale: true` + `dataAsOf` and no-store.
 */
export async function resolveCountRoute(args: {
  route: string;
  counts: LeaderboardCountService;
  tasks: () => Promise<CountTask[]>;
  meta?: ReadMeta;
  waitMs?: number;
}): Promise<ListCountResponse> {
  // `meta.cache` here (hit = every shard's count was already cached) is how the
  // `/api` budget tells a cheap count from one that started a scan. Only the
  // `/api` count routes come through this function, so it never overwrites a
  // list's own `X-Cache`.
  const pending = (reason: CountPendingReason): ListCountResponse => {
    readPathMeter.countPending(args.route, reason);
    if (args.meta) {
      args.meta.noStore = true;
      args.meta.cache = 'miss';
    }
    return { total: null, capped: false, pending: true };
  };
  let tasks: CountTask[];
  try {
    tasks = await args.tasks();
  } catch (err) {
    return pending(countPendingReason(err));
  }
  const settled = await Promise.all(
    tasks.map((task) => args.counts.settle(task.key, task.run, args.waitMs ?? COUNT_ROUTE_WAIT_MS)),
  );
  const notIn = settled.find((entry): entry is { pending: CountPendingReason } => 'pending' in entry);
  if (notIn) return pending(notIn.pending);
  const answered = settled as Array<{ result: CountResult; dataAt?: number; cached?: true }>;
  if (args.meta) args.meta.cache = answered.every((entry) => entry.cached) ? 'hit' : 'miss';
  const results = answered.map((entry) => entry.result);
  const oldest = Math.min(...answered.map((entry) => entry.dataAt ?? Infinity));
  const dataAsOf = Number.isFinite(oldest) ? staleSince(oldest, args.counts.budgetMs) : undefined;
  if (dataAsOf !== undefined) {
    readPathMeter.staleServed(`${args.route}-count`, Date.now() - dataAsOf);
    if (args.meta) args.meta.noStore = true;
  }
  return {
    total: results.reduce((sum, result) => sum + result.count, 0),
    capped: results.some((result) => result.capped),
    ...(dataAsOf !== undefined ? { stale: true as const, dataAsOf: new Date(dataAsOf).toISOString() } : {}),
  };
}
