import { Inject, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Redis } from 'ioredis';
import { Model, Types } from 'mongoose';
import { RateLimiterAbstract, RateLimiterRedis, RateLimiterRes } from 'rate-limiter-flexible';
import { InvalidationBus } from '../common/invalidation-bus.js';
import { AppConfigService } from '../config/app-config.service.js';
import type { CachedPlan } from './settings-cache.service.js';
import { UsageFlushService } from './usage-flush.service.js';
import { Usage } from './usage.schema.js';

export interface LimitView {
  limit: number;
  remaining: number;
  resetSec: number;
}

export interface MeteringResult {
  rate: LimitView;
  quota: LimitView | null; // null = unlimited / not metered
  /**
   * Whether the QUOTA COUNTER IN REDIS was actually decremented for this
   * request. The refund path must not credit units that were never charged.
   *
   * It is false in three distinct situations, and a `quota` view being present
   * does not imply it:
   *  - unlimited plan (`monthlyUnits <= 0`) or a zero-cost route, where the
   *    consume is skipped entirely;
   *  - the quota limiter FAILED OPEN — Redis errored, the request was allowed,
   *    and a synthetic full-budget view was returned. This is the dangerous one:
   *    a `reward` here does an INCRBY of a NEGATIVE amount against a key nothing
   *    ever incremented, leaving a negative consumed counter that then sits
   *    under a 35-day TTL granting free units.
   *  - (by construction) a quota REJECTION, which throws instead of returning.
   *
   * The Mongo usage snapshot is charged separately and unconditionally, so it is
   * compensated on its own terms — see `reward`.
   */
  quotaCharged: boolean;
}

export class MeteringRejectionError extends Error {
  constructor(
    readonly kind: 'rate' | 'quota',
    readonly retryAfterSec: number,
    readonly view: LimitView,
  ) {
    super(`Metering rejected: ${kind} limit exceeded`);
    this.name = 'MeteringRejectionError';
  }
}

const QUOTA_DURATION_SEC = 35 * 24 * 60 * 60; // > 1 month; key carries YYYY-MM so it rolls anyway
const BURST_DURATION_SEC = 60;

/**
 * Seconds until the monthly quota budget actually resets: 00:00 UTC on the 1st
 * of the next calendar month.
 *
 * THE HEADER USED TO REPORT SOMETHING ELSE. `X-Quota-Reset` was
 * `Math.ceil(res.msBeforeNext / 1000)` against `QUOTA_DURATION_SEC`, i.e. the
 * remaining life of a 35-DAY Redis key — and the fail-open branch returned the
 * literal 35 days. Neither is when the customer's units come back. The budget
 * resets because the KEY NAME carries `YYYY-MM` (`currentPeriod()`), so at the
 * month boundary a brand-new key exists with the full allowance; the TTL only
 * ever garbage-collects the old one. So the header was telling an integrator to
 * wait up to 35 days for something that happens within 31, while the portal's
 * `QuotaMeter` said "resets on the 1st of each month, UTC" — the API and the UI
 * disagreeing about the same number.
 *
 * The month boundary is also never LATER than the key's own expiry (a key is
 * first written at most 31 days before the boundary, under a 35-day TTL), so
 * this can only ever be the earlier, truer answer.
 *
 * Exported and pure so the header, the 429 `Retry-After` and the tests all read
 * one implementation.
 */
export function secondsUntilQuotaReset(now: Date = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0);
  // `Date.UTC` rolls month 12 into January of the next year on its own, so
  // December needs no special case.
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

/**
 * Atomic, distributed metering on the existing Redis via rate-limiter-flexible.
 * Two checks per metered request:
 *   1. burst rate-limit  — points = plan.rateLimitPerMin, keyed by api-key id
 *   2. monthly unit quota — points = plan.monthlyUnits, keyed by clientId:YYYY-MM
 * Limiter instances are cached per plan (only `points` differs between plans);
 * they share the same keyPrefix so a plan change preserves the consumed counter.
 */
@Injectable()
export class MeteringService implements OnModuleDestroy {
  private readonly logger = new Logger(MeteringService.name);
  protected readonly redis: Redis;
  /**
   * Per plan key, the limiter AND the ceiling it was built with. A cached
   * limiter is reused only while the plan still carries that ceiling, so a
   * changed limit builds a new limiter on the next request whatever order the
   * settings reload and any eviction happen in (P2.2: a remote `plan` message
   * evicts here synchronously while the settings cache reloads asynchronously;
   * a request landing in between used to rebuild — and pin — the OLD limits).
   * One entry per plan key, so the map stays bounded. The Redis key prefix is
   * shared, so a rebuild carries the consumed counter over.
   */
  private readonly burstLimiters = new Map<string, { points: number; limiter: RateLimiterAbstract }>();
  private readonly quotaLimiters = new Map<string, { points: number; limiter: RateLimiterAbstract }>();
  /** Fallback quota limiter for `resetQuotaPeriod`; see `quotaKeyLimiter()`. */
  private standaloneQuotaLimiter?: RateLimiterAbstract;

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @InjectModel(Usage.name) private readonly usageModel: Model<Usage>,
    /**
     * APPENDED and optional (P2.2): a plan edited on another replica evicts
     * its cached limiters here too (memory hygiene — correctness no longer
     * depends on it: limiters are keyed by the ceiling they were built with,
     * so whichever of this eviction and the async settings reload lands
     * first, the next request after the reload builds the new limits).
     * Absent / off = today.
     */
    @Optional() @Inject(InvalidationBus) bus?: InvalidationBus,
    /**
     * APPENDED and optional: `USAGE_WRITE_MODE=batched` buffers the snapshot
     * charge / compensation through it (see `usage-flush.service.ts`). Absent,
     * or `direct` (the default), = today's per-request `updateOne`.
     */
    @Optional() @Inject(UsageFlushService) private readonly usageFlush?: UsageFlushService,
  ) {
    bus?.on('plan', (msg) => this.evictPlanLimiter(msg.planKey));
    // lazyConnect: the socket opens on the first limiter command, so tests that
    // override `createLimiter` never touch Redis.
    this.redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });
    this.redis.on('error', (err) => this.logger.error(`Metering Redis error: ${err.message}`));
  }

  onModuleDestroy(): void {
    void this.redis.quit().catch(() => undefined);
  }

  /** Seam for tests to swap in an in-memory limiter. */
  protected createLimiter(keyPrefix: string, points: number, duration: number): RateLimiterAbstract {
    return new RateLimiterRedis({ storeClient: this.redis, keyPrefix, points, duration });
  }

  /** Drop a plan's cached limiters so the next request rebuilds them with new limits. */
  evictPlanLimiter(planKey: string): void {
    this.burstLimiters.delete(planKey);
    this.quotaLimiters.delete(planKey);
  }

  private burstLimiter(plan: CachedPlan): RateLimiterAbstract {
    return this.limiterFor(this.burstLimiters, plan.key, 'meter:burst', Math.max(1, plan.rateLimitPerMin), BURST_DURATION_SEC);
  }

  private quotaLimiter(plan: CachedPlan): RateLimiterAbstract {
    return this.limiterFor(this.quotaLimiters, plan.key, 'meter:quota', Math.max(1, plan.monthlyUnits), QUOTA_DURATION_SEC);
  }

  /** The cached limiter for `planKey` if it was built with `points`, else a new one (replacing it). */
  private limiterFor(
    cache: Map<string, { points: number; limiter: RateLimiterAbstract }>,
    planKey: string,
    keyPrefix: string,
    points: number,
    duration: number,
  ): RateLimiterAbstract {
    const cached = cache.get(planKey);
    if (cached && cached.points === points) return cached.limiter;
    const limiter = this.createLimiter(keyPrefix, points, duration);
    cache.set(planKey, { points, limiter });
    return limiter;
  }

  /**
   * Enforce burst + quota for one request. Returns header views on success;
   * throws `MeteringRejectionError` when a limit is exceeded. Fails open (allows
   * the request) if Redis itself errors, so a cache blip never hard-downs the API.
   */
  async checkAndConsume(args: {
    apiKeyId: string;
    customerId: string;
    plan: CachedPlan;
    unitCost: number;
  }): Promise<MeteringResult> {
    const { apiKeyId, customerId, plan, unitCost } = args;

    // 1. burst rate-limit (cost 1 per request)
    const burst = this.burstLimiter(plan);
    let rate: LimitView;
    try {
      const res = await burst.consume(apiKeyId, 1);
      rate = this.view(Math.max(1, plan.rateLimitPerMin), res);
    } catch (rejection) {
      if (rejection instanceof Error) {
        this.logger.warn(`Burst limiter unavailable, failing open: ${rejection.message}`);
        rate = { limit: Math.max(1, plan.rateLimitPerMin), remaining: Math.max(1, plan.rateLimitPerMin), resetSec: 60 };
      } else {
        const res = rejection as RateLimiterRes;
        throw new MeteringRejectionError('rate', Math.ceil(res.msBeforeNext / 1000), this.view(Math.max(1, plan.rateLimitPerMin), res));
      }
    }

    // 2. monthly unit quota (cost = unitCost). monthlyUnits 0 = unlimited.
    let quota: LimitView | null = null;
    // Flipped ONLY by a consume that really returned. See `MeteringResult`.
    let quotaCharged = false;
    if (plan.monthlyUnits > 0 && unitCost > 0) {
      const limiter = this.quotaLimiter(plan);
      const key = `${customerId}:${currentPeriod()}`;
      try {
        const res = await limiter.consume(key, unitCost);
        quota = this.quotaView(plan.monthlyUnits, res);
        quotaCharged = true;
      } catch (rejection) {
        if (rejection instanceof Error) {
          this.logger.warn(`Quota limiter unavailable, failing open: ${rejection.message}`);
          // ALERT-WORTHY, not just a warning: a fail-open request is one served
          // without being metered, so a sustained run of these is unbilled
          // traffic. Logged with a stable prefix so it can be alerted on.
          this.logger.warn(`[alert] metering.fail_open customer=${customerId} route_units=${unitCost}`);
          quota = {
            limit: plan.monthlyUnits,
            remaining: plan.monthlyUnits,
            // The month rollover, never `QUOTA_DURATION_SEC` — see
            // `secondsUntilQuotaReset`. This branch returned the literal 35 days.
            resetSec: secondsUntilQuotaReset(),
          };
          // quotaCharged stays FALSE: the request is allowed through, but
          // nothing was consumed, so nothing may be refunded later.
        } else {
          const res = rejection as RateLimiterRes;
          // `Retry-After` on a quota 429 is the month rollover too. `msBeforeNext`
          // here is the 35-day key TTL, so the old value told an exhausted
          // customer to come back up to four days after their units had already
          // come back.
          throw new MeteringRejectionError(
            'quota',
            secondsUntilQuotaReset(),
            this.quotaView(plan.monthlyUnits, res),
          );
        }
      }
    }

    this.snapshotUsage(customerId, unitCost);
    return { rate, quota, quotaCharged };
  }

  /**
   * Any limiter that can address a quota key. Every plan's quota limiter shares
   * `keyPrefix: 'meter:quota'`, so ANY instance can delete ANY customer's key —
   * which is why `resetQuotaPeriod` needs no plan argument.
   *
   * Prefers an already-cached instance (under the in-memory test limiter each
   * instance owns its own store, so reuse is what makes the delete observable);
   * otherwise builds a standalone one that is deliberately NOT filed under a
   * plan key in `quotaLimiters`, where a `points: 1` entry would corrupt that
   * plan's real ceiling.
   */
  private quotaKeyLimiter(): RateLimiterAbstract {
    for (const entry of this.quotaLimiters.values()) return entry.limiter;
    if (!this.standaloneQuotaLimiter) {
      this.standaloneQuotaLimiter = this.createLimiter('meter:quota', 1, QUOTA_DURATION_SEC);
    }
    return this.standaloneQuotaLimiter;
  }

  /**
   * Clear the current period's consumed units for one customer. Called ONLY on
   * an INVOLUNTARY downgrade (grace expiry → Free).
   *
   * Without it a downgrade is a month-long hard suspension: the quota limiter
   * rejects whenever `consumedPoints > plan.points`, and the Redis key is
   * SHARED across plan-specific limiter instances (that sharing is what makes a
   * mid-period UPGRADE correct). So a customer downgraded mid-month having
   * consumed 3M units 429s on every request for the rest of the calendar month,
   * with a `Retry-After` of up to ~2.6 million seconds on a $0 tier.
   *
   * Do NOT "fix" this by making the Redis key plan-specific: that would zero
   * consumption on every plan toggle (free units) and break the upgrade
   * property above. Do NOT call `evictPlanLimiter` either — nothing needs
   * invalidating when `planKey` changes, because `resolveByRawKey` reads the
   * customer→plan pointer from Mongo on every request.
   *
   * Returns true when this call performed the reset. The `usage.quotaResetAt`
   * stamp makes it at-most-once per calendar month: a second attempt in the
   * same period is refused rather than handing out another free allowance.
   */
  async resetQuotaPeriod(customerId: string): Promise<boolean> {
    let owner: Types.ObjectId;
    try {
      owner = new Types.ObjectId(customerId);
    } catch {
      this.logger.warn(`Quota reset skipped: invalid customer id '${customerId}'`);
      return false;
    }
    const period = currentPeriod();

    // Claim the reset first. The FILTER is the guard — `$exists: false` matches
    // only a period that has never been reset, so a doubled sweep tick can't
    // re-zero a consumed quota and there is no read-then-write window. `upsert`
    // covers a customer whose best-effort usage snapshot never landed; when the
    // row exists AND already carries a stamp the filter misses, the upsert
    // trips the unique `{customerId, period}` index, and E11000 IS the "already
    // reset" answer. `strict: false` because `quotaResetAt` is written here and
    // nowhere else, so it is not declared on the Usage schema.
    try {
      const claim = await this.usageModel
        .updateOne(
          { customerId: owner, period, quotaResetAt: { $exists: false } },
          { $set: { quotaResetAt: new Date() } },
          { upsert: true, strict: false },
        )
        .exec();
      if (claim.matchedCount === 0 && claim.upsertedCount === 0) return false;
    } catch (err) {
      this.logger.warn(`Quota reset refused for ${customerId} (${period}): ${String(err)}`);
      return false;
    }

    try {
      await this.quotaKeyLimiter().delete(`${customerId}:${period}`);
      this.logger.log(`Quota reset for customer ${customerId} (${period})`);
      return true;
    } catch (err) {
      // The stamp is already written, so a retry will be refused — surface it
      // loudly rather than pretending the downgrade landed cleanly.
      this.logger.error(`Quota reset stamped but Redis key survived for ${customerId} (${period}): ${String(err)}`);
      return false;
    }
  }

  /**
   * Credit back the units a request consumed when the API did not serve it.
   *
   * `checkAndConsume` charges TWO stores, so this refunds two — and it refunds
   * each ONLY IF that store was actually charged, which is not the same
   * condition for both:
   *
   *  - REDIS (the enforced quota) is charged only when the consume returned, so
   *    it is refunded only when `quotaCharged` says so. Crediting an uncharged
   *    key is not a no-op: `reward` is an INCRBY of a negative amount, so it
   *    drives the consumed counter NEGATIVE and that value then sits under a
   *    35-day TTL handing out free units. The reachable path is a Redis blip
   *    that made the quota consume fail OPEN followed by a 4xx from the handler.
   *  - MONGO (`usage.unitsConsumed`, the customer-visible snapshot behind
   *    `QuotaMeter` in `customer-self.service.ts`) is charged UNCONDITIONALLY by
   *    `snapshotUsage`, including on unlimited plans and on the fail-open path.
   *    So it is compensated whenever there were units to compensate, regardless
   *    of `quotaCharged`. Without this the refund was Redis-only: the enforced
   *    quota came back while the number the customer READS kept the charge, and
   *    the diff that widened refunds from 5xx to every-4xx-except-429 widened
   *    that divergence with it.
   *
   * `requestCount` is deliberately NOT decremented. The request genuinely
   * happened; what was reversed is the CHARGE, so "100 requests, 60 units" is
   * the honest record and a request that vanishes from the count is not.
   *
   * Best-effort on both sides, with the same fire-and-forget `.catch()` shape
   * `snapshotUsage` uses: a refund is a courtesy on an already-failed request
   * and must never turn a 4xx into a 500.
   */
  async reward(args: {
    customerId: string;
    plan: CachedPlan;
    unitCost: number;
    quotaCharged: boolean;
  }): Promise<void> {
    const { customerId, plan, unitCost, quotaCharged } = args;
    if (unitCost <= 0) return;

    if (quotaCharged && plan.monthlyUnits > 0) {
      const key = `${customerId}:${currentPeriod()}`;
      try {
        await this.quotaLimiter(plan).reward(key, unitCost);
      } catch (err) {
        this.logger.warn(`Quota reward failed: ${String(err)}`);
      }
    }

    this.compensateUsageSnapshot(customerId, unitCost);
  }

  private view(limit: number, res: RateLimiterRes): LimitView {
    return {
      limit,
      remaining: Math.max(0, res.remainingPoints),
      resetSec: Math.ceil(res.msBeforeNext / 1000),
    };
  }

  /**
   * The BURST view's `resetSec` is honest — a 60-second window really does
   * expire with its key. The QUOTA view's is not, so it is overridden here
   * rather than at each of the three call sites. See `secondsUntilQuotaReset`.
   */
  private quotaView(limit: number, res: RateLimiterRes): LimitView {
    return { ...this.view(limit, res), resetSec: secondsUntilQuotaReset() };
  }

  /** Best-effort Mongo snapshot for the admin panel — never blocks or fails the request. */
  private snapshotUsage(customerId: string, unitCost: number): void {
    try {
      const period = currentPeriod();
      // Batched (`USAGE_WRITE_MODE=batched`): the same delta, resolved against
      // the same period NOW, flushed later with the same upsert rule. False =
      // direct mode (or an input the buffer refuses) → today's write below.
      if (this.usageFlush?.enqueueUsageCharge(customerId, unitCost, period)) return;
      this.usageModel
        .updateOne(
          { customerId: new Types.ObjectId(customerId), period },
          { $inc: { unitsConsumed: unitCost, requestCount: 1 } },
          { upsert: true },
        )
        .exec()
        .catch((err) => this.logger.warn(`Usage snapshot failed: ${String(err)}`));
    } catch (err) {
      this.logger.warn(`Usage snapshot skipped: ${String(err)}`);
    }
  }

  /**
   * The mirror of `snapshotUsage` — same collection, same period key, same
   * best-effort shape, negated units.
   *
   * NO `upsert` here, and that is the one deliberate difference: a compensation
   * is only ever for a snapshot this same request already wrote, so if the row
   * is missing then the snapshot never landed and there is nothing to reverse.
   * Upserting would CREATE a row holding negative units.
   *
   * `requestCount` is untouched — see `reward`.
   */
  private compensateUsageSnapshot(customerId: string, unitCost: number): void {
    try {
      const period = currentPeriod();
      // Batched: buffered apart from charges, and flushed WITHOUT upsert when
      // its window holds no charge for the row — the rule below, kept.
      if (this.usageFlush?.enqueueUsageCompensation(customerId, unitCost, period)) return;
      this.usageModel
        .updateOne(
          { customerId: new Types.ObjectId(customerId), period },
          { $inc: { unitsConsumed: -unitCost } },
        )
        .exec()
        .catch((err) => this.logger.warn(`Usage compensation failed: ${String(err)}`));
    } catch (err) {
      this.logger.warn(`Usage compensation skipped: ${String(err)}`);
    }
  }
}

/** Current calendar month as `YYYY-MM` in UTC. */
export function currentPeriod(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}
