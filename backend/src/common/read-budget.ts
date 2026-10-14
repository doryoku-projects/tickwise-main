import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import { currentIndexerContext } from '../subgraph/hyperindex/indexer-context.js';
import { readPathMeter } from './cache/read-path-meter.js';
import { ReadPathRedis } from './cache/read-path-redis.js';
import { RedisLease } from './redis-lease.js';
import { Semaphore } from './semaphore.js';

/**
 * What a reservation is for (metered per lane). Every lane is a USER read.
 * The read models' verification reads (lane A, lane B) take NOTHING from
 * this budget: they draw from their own per-process bucket
 * (`LaneABudget`, ≤ 2k docs/s) and skip while `underPressure()` — a shadow
 * check must never delay a user's count or deep walk.
 */
export type ReadBudgetLane = 'count' | 'deep' | 'deep-background' | 'rescue' | 'pool-counts';

/**
 * How long a wait or a refusal counts as "the user read budget is under
 * pressure" — the read models' paced scans pause while it does (P-R §3.2).
 */
export const READ_BUDGET_PRESSURE_WINDOW_MS = 10_000;
/** The shared bucket counts as under pressure below this share of its depth. */
const SHARED_PRESSURE_SHARE = 0.1;

/**
 * The read budget could not be had before the caller's deadline. For a list
 * read this is the same outcome as a `maxTimeMS` expiry (the route answers 503
 * + Retry-After through `QueryTimeoutException`); a count answers `pending`;
 * a background read skips its turn. Never a depth- or size-based refusal: a
 * reservation of any size succeeds once the bucket has refilled enough.
 */
export class ReadBudgetTimeoutError extends Error {
  constructor(
    readonly lane: ReadBudgetLane,
    readonly waitMs: number,
  ) {
    super(`read budget: ${lane} would wait ${Math.round(waitMs)} ms, past its deadline`);
    this.name = 'ReadBudgetTimeoutError';
  }
}

/**
 * GCRA-style token bucket in ONE Lua call: refill by elapsed time (Redis's own
 * clock, so processes with skewed clocks share one timeline), then take `cost`
 * — letting the balance go NEGATIVE, which is what queues later reservers
 * behind this one — and answer how long the caller must wait before reading.
 * A wait longer than `maxWait` takes nothing and answers `-wait`.
 * `maxWait < 0` charges without a check (`charge`).
 */
const TAKE_SCRIPT = `
local key = KEYS[1]
local rate = tonumber(ARGV[1])
local burst = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local maxWait = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local state = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(state[1])
local ts = tonumber(state[2])
if tokens == nil then tokens = burst end
if ts == nil then ts = now end
tokens = math.min(burst, tokens + math.max(0, now - ts) * rate)
local wait = 0
if tokens < cost then wait = math.ceil((cost - tokens) / rate) end
if maxWait >= 0 and wait > maxWait then
  redis.call('HSET', key, 'tokens', tostring(tokens), 'ts', tostring(now))
  redis.call('PEXPIRE', key, ttl)
  return -wait
end
tokens = tokens - cost
redis.call('HSET', key, 'tokens', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', key, ttl)
return wait
`;

/** The bucket key's TTL: an idle budget forgets its debt. */
const BUCKET_TTL_MS = 60_000;

/** The longest a background deep walk runs (`startBackgroundWalk`). */
export const DEEP_BACKGROUND_MAX_MS = 5 * 60_000;
/**
 * The share of the budget a background deep walk may take: after each
 * reservation it idles as long again (`reserveBackground`), so a long walk
 * leaves at least half of the rate to the counts, rescues and request walks
 * queued behind it instead of holding the whole bucket for a minute.
 */
export const DEEP_BACKGROUND_SHARE = 0.5;
/** The background deep-walk lease's TTL; renewed every third of it while the walk runs. */
const DEEP_BACKGROUND_LEASE_MS = 60_000;

/**
 * ONE global Mongo read budget for every read that is not a page read —
 * counts, deep-page walks, window rescues and pool holder counts. Its unit is
 * a ROW, and a read costs the larger of two measures:
 *  - the rows it reads, RESERVED before it runs (`reserve`);
 *  - the database time it took, at `READ_BUDGET_DOCS_PER_SEC` rows per second
 *    of server time — settled after it ran (`chargeTime`), the excess over
 *    what was reserved charged as debt. A filter that rejects most of what
 *    its index hands it (the spam `$nin`, a value floor tested after a FETCH)
 *    examines far more keys and documents than it returns: measured on m10-3,
 *    3,000 rows of a chain-1 landing walk were 211k keys / 18.7k docs /
 *    983 ms. Rows alone charged 3,000; time charges ~19.7k at the defaults.
 * So the budget bounds what M10 actually pays: at the defaults, the reads it
 * governs use at most about one second of secondary time per second across
 * every process, whatever their selectivity.
 *
 * Shared by every process through Redis (`tw:rb:v1:<deployment>`); per
 * process when Redis is off or unreachable.
 *
 * A read RESERVES before it runs and WAITS for the budget up to its own
 * deadline — a deep page is never refused for its depth, it just queues
 * behind the reads already holding the budget. Only a wait past the deadline
 * gives up (`ReadBudgetTimeoutError`).
 *
 * Also owns the per-process cap on LONG deep walks (`walkSlot`) and the ONE
 * background deep walk allowed at a time across every process
 * (`startBackgroundWalk`), because a walk's cost is exactly what this budget
 * meters.
 */
@Injectable()
export class ReadBudgetService {
  private readonly logger = new Logger(ReadBudgetService.name);
  private local = { tokens: Number.NaN, ts: 0 };
  /** The keyless `/api` sub-bucket's own copy of `local` (`API_READ_SHARE`). */
  private localKeyless = { tokens: Number.NaN, ts: 0 };
  private readonly walks: Semaphore;
  /** Background deep walks: the keys running here (one at a time per process). */
  private readonly backgroundKeys = new Set<string>();
  private backgroundLease?: RedisLease;
  /** Last time a reservation here had to wait or was refused (P-R scans yield to it). */
  private lastPressureAt = Number.NEGATIVE_INFINITY;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    @Optional() @Inject(AppConfigService) private readonly config?: AppConfigService,
    @Optional() @Inject(ReadPathRedis) private readonly redis?: ReadPathRedis,
    // Specs only (a fake clock); Nest finds nothing to inject and passes undefined.
    @Optional() clock?: { now?: () => number; sleep?: (ms: number) => Promise<void> },
  ) {
    this.now = clock?.now ?? Date.now;
    this.sleep = clock?.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.walks = new Semaphore(config?.leaderboardDeepWalkConcurrency ?? 2);
  }

  /** Rows per second; 0 = the budget is off. */
  get ratePerSec(): number {
    return this.config?.readBudgetDocsPerSec ?? 0;
  }

  private get burst(): number {
    return this.config?.readBudgetBurstDocs ?? this.ratePerSec;
  }

  /**
   * Take `rows` of budget, waiting for it up to `deadlineAt` (epoch ms).
   * Throws `ReadBudgetTimeoutError` — having taken nothing — when the wait
   * would run past the deadline.
   */
  async reserve(rows: number, opts: { deadlineAt: number; lane: ReadBudgetLane }): Promise<void> {
    const cost = Math.max(0, Math.ceil(rows));
    if (cost === 0 || this.ratePerSec <= 0) return;
    const maxWait = Math.max(0, opts.deadlineAt - this.now());
    const { wait, fallback } = await this.takeFor(cost, maxWait);
    if (wait < 0) {
      this.lastPressureAt = this.now();
      readPathMeter.budgetRejected(opts.lane);
      throw new ReadBudgetTimeoutError(opts.lane, -wait);
    }
    if (wait > 0) this.lastPressureAt = this.now();
    readPathMeter.budgetReserved(opts.lane, cost, wait, fallback);
    if (wait > 0) await this.sleep(wait);
  }

  /**
   * Charge `rows` already read beyond what was reserved (a count that matched
   * more rows than its estimate). Never waits: the debt delays the NEXT
   * reservations instead.
   */
  charge(rows: number, lane: ReadBudgetLane): void {
    const cost = Math.max(0, Math.ceil(rows));
    if (cost === 0 || this.ratePerSec <= 0) return;
    void this.takeFor(cost, -1)
      .then(({ fallback }) => readPathMeter.budgetReserved(lane, cost, 0, fallback))
      .catch(() => undefined);
  }

  /**
   * `reserve` for a BACKGROUND deep walk (lane `deep-background`): the same
   * wait for budget, then an idle of `(1 / DEEP_BACKGROUND_SHARE − 1)` times
   * what those rows cost at the full rate — so the walk averages at most
   * `DEEP_BACKGROUND_SHARE` of the budget.
   */
  async reserveBackground(rows: number, deadlineAt: number): Promise<void> {
    await this.reserve(rows, { deadlineAt, lane: 'deep-background' });
    const rate = this.ratePerSec;
    if (rate <= 0 || rows <= 0) return;
    await this.sleep(Math.ceil(((rows * 1000) / rate) * (1 / DEEP_BACKGROUND_SHARE - 1)));
  }

  /**
   * Settle a read's DATABASE TIME against the rows it reserved: `mongoMs` of
   * server time costs `mongoMs × rate / 1000` rows, and whatever exceeds
   * `reservedRows` is charged as debt (never a wait: the NEXT reservations
   * absorb it). A read cheap in time costs exactly its rows.
   */
  chargeTime(mongoMs: number, reservedRows: number, lane: ReadBudgetLane): void {
    if (this.ratePerSec <= 0 || !(mongoMs > 0)) return;
    const excess = (mongoMs * this.ratePerSec) / 1000 - Math.max(0, reservedRows);
    if (excess >= 1) this.charge(excess, lane);
  }

  /**
   * Run `fn` holding one of this process's long-walk slots
   * (`LEADERBOARD_DEEP_WALK_CONCURRENCY`), waiting for one up to `deadlineAt`.
   */
  async walkSlot<T>(deadlineAt: number, fn: () => Promise<T>): Promise<T> {
    const waitMs = Math.max(0, deadlineAt - this.now());
    if (!(await this.walks.acquireWithin(waitMs))) {
      this.lastPressureAt = this.now();
      readPathMeter.budgetRejected('deep');
      throw new ReadBudgetTimeoutError('deep', waitMs);
    }
    try {
      return await fn();
    } finally {
      this.walks.release();
    }
  }

  /**
   * Start a BACKGROUND deep walk for `key` — a page whose request ran out of
   * its deadline, walked on (paced by this budget, with no request deadline:
   * up to `DEEP_BACKGROUND_MAX_MS`) so the ladder reaches it and the client's
   * retry finds a rung next to its page. At most ONE runs at a time across
   * every process (a Redis lease, `tw:lease:v1:<deployment>:deep-walk`; per
   * process when Redis is off) — the plan's "one uncached deep walk at a time",
   * for the walks with no request deadline to bound them. Fire-and-forget:
   * false when one is already running (here or elsewhere) or the budget is
   * off; a failure is logged and forgotten (the next retry asks again).
   */
  startBackgroundWalk(key: string, run: (deadlineAt: number) => Promise<unknown>): boolean {
    if (this.ratePerSec <= 0 || this.backgroundKeys.size > 0) return false;
    this.backgroundKeys.add(key);
    void (async () => {
      const lease = this.redis ? (this.backgroundLease ??= this.deepWalkLease()) : undefined;
      const got = lease ? await lease.acquire() : 'unavailable';
      if (got === 'held') return; // another process is walking
      const renew =
        got === 'acquired' ? setInterval(() => void lease!.renew(), Math.floor(DEEP_BACKGROUND_LEASE_MS / 3)) : undefined;
      renew?.unref?.();
      const started = this.now();
      readPathMeter.deepBackground('started');
      try {
        await run(started + DEEP_BACKGROUND_MAX_MS);
        readPathMeter.deepBackground('finished');
      } catch (err) {
        readPathMeter.deepBackground('failed');
        this.logger.warn(
          `background deep walk failed key=${key.slice(0, 120)} after ${this.now() - started}ms: ` +
            `${(err as Error)?.message ?? String(err)} (the next retry asks again)`,
        );
      } finally {
        if (renew) clearInterval(renew);
        if (got === 'acquired') await lease!.release();
      }
    })()
      .catch(() => undefined)
      .finally(() => this.backgroundKeys.delete(key));
    return true;
  }

  /**
   * Is the user read budget under pressure? True when a reservation in this
   * process waited or was refused within `READ_BUDGET_PRESSURE_WINDOW_MS`
   * The read models' scans and verification checks pause while it is (P-R
   * §3.2) — they never draw from this budget.
   */
  underPressure(withinMs = READ_BUDGET_PRESSURE_WINDOW_MS): boolean {
    return this.ratePerSec > 0 && this.now() - this.lastPressureAt <= withinMs;
  }

  /**
   * The same question across EVERY process: this process's own signal, or the
   * shared Redis bucket below 10% of its depth (other replicas' user reads are
   * draining it). One `HMGET`; false when the budget is off or Redis is not.
   */
  async sharedPressure(): Promise<boolean> {
    if (this.underPressure()) return true;
    if (this.ratePerSec <= 0) return false;
    const client = await this.redis?.client().catch(() => undefined);
    if (!client) return false;
    try {
      const [tokens, ts] = await client.hmget(`tw:rb:v1:${this.redis!.namespace}`, 'tokens', 'ts');
      if (tokens === null || ts === null) return false;
      const refilled = Math.min(this.burst, Number(tokens) + Math.max(0, this.now() - Number(ts)) * (this.ratePerSec / 1000));
      return Number.isFinite(refilled) && refilled < this.burst * SHARED_PRESSURE_SHARE;
    } catch {
      return false;
    }
  }

  /** Background deep walks running in this process (for specs and the status block). */
  get backgroundWalks(): number {
    return this.backgroundKeys.size;
  }

  private deepWalkLease(): RedisLease {
    return new RedisLease(() => this.redis!.client(), `tw:lease:v1:${this.redis!.namespace}:deep-walk`, DEEP_BACKGROUND_LEASE_MS);
  }

  /**
   * The share of the budget THIS read may take: `API_READ_SHARE` for a keyless
   * `/api` read (`ApiLimitService` marks the request), 1 for everything else.
   */
  private keylessShare(): number {
    if (currentIndexerContext().stats?.keyless !== true) return 1;
    return this.config?.apiReadShare ?? 1;
  }

  /**
   * `take` through the keyless sub-bucket first when this read is a keyless
   * `/api` one and a share is set: keyless reads can then never take more than
   * `API_READ_SHARE` of the rate, whatever the keyed `/v1` customers and the
   * sync use, so they cannot starve either. Refused by the sub-bucket = nothing
   * taken from the shared one.
   */
  private async takeFor(cost: number, maxWait: number): Promise<{ wait: number; fallback: boolean }> {
    if (this.keylessShare() >= 1) return this.take(cost, maxWait, false);
    const keyless = await this.take(cost, maxWait, true);
    if (keyless.wait < 0) return keyless;
    const shared = await this.take(cost, maxWait, false);
    if (shared.wait < 0) {
      // Give the sub-bucket its tokens back: the read did not happen.
      await this.take(-cost, -1, true).catch(() => undefined);
      return shared;
    }
    return { wait: Math.max(keyless.wait, shared.wait), fallback: keyless.fallback || shared.fallback };
  }

  /** `{wait, fallback}`: wait ≥ 0 = taken (sleep that long); < 0 = refused. */
  private async take(cost: number, maxWait: number, keyless: boolean): Promise<{ wait: number; fallback: boolean }> {
    const share = keyless ? this.keylessShare() : 1;
    const client = await this.redis?.client();
    if (client) {
      try {
        const wait = await client.eval(
          TAKE_SCRIPT,
          1,
          `tw:rb:v1:${this.redis!.namespace}${keyless ? ':api' : ''}`,
          String((this.ratePerSec * share) / 1000),
          String(this.burst * share),
          String(cost),
          String(maxWait),
          String(BUCKET_TTL_MS),
        );
        return { wait: Number(wait), fallback: false };
      } catch (err) {
        this.redis?.logError(err);
      }
    }
    return { wait: this.takeLocal(cost, maxWait, keyless), fallback: true };
  }

  /** The same bucket in process (Redis off or unreachable). */
  private takeLocal(cost: number, maxWait: number, keyless: boolean): number {
    const now = this.now();
    const share = keyless ? this.keylessShare() : 1;
    const rate = (this.ratePerSec * share) / 1000;
    const burst = this.burst * share;
    const state = keyless ? this.localKeyless : this.local;
    let tokens = Number.isNaN(state.tokens) ? burst : state.tokens;
    tokens = Math.min(burst, tokens + Math.max(0, now - state.ts) * rate);
    const wait = tokens < cost ? Math.ceil((cost - tokens) / rate) : 0;
    const next = maxWait >= 0 && wait > maxWait ? { tokens, ts: now } : { tokens: tokens - cost, ts: now };
    if (keyless) this.localKeyless = next;
    else this.local = next;
    return maxWait >= 0 && wait > maxWait ? -wait : wait;
  }
}
