import { beforeEach, describe, expect, it } from 'vitest';
import {
  BadRequestException,
  HttpException,
  HttpStatus,
  InternalServerErrorException,
  NotFoundException,
  type CallHandler,
  type ExecutionContext,
} from '@nestjs/common';
import { RateLimiterAbstract, RateLimiterMemory } from 'rate-limiter-flexible';
import { of, throwError as rxThrowError } from 'rxjs';
import {
  MeteringRejectionError,
  MeteringService,
  secondsUntilQuotaReset,
} from '../src/billing/metering.service.js';
import { MeteringInterceptor, isRefundable } from '../src/v1/metering.interceptor.js';
import type { CachedPlan } from '../src/billing/settings-cache.service.js';

// Subclass swaps the Redis-backed limiter for an in-memory one so the test
// exercises real consume/reward semantics without a live Redis.
class TestMetering extends MeteringService {
  protected override createLimiter(_keyPrefix: string, points: number, duration: number): RateLimiterAbstract {
    return new RateLimiterMemory({ points, duration });
  }
}

/**
 * A quota limiter that is DOWN: `consume` rejects with an `Error` rather than a
 * `RateLimiterRes`, which is exactly how `rate-limiter-flexible` reports a store
 * failure as opposed to a limit rejection — and the branch `checkAndConsume`
 * fails OPEN on. The burst limiter stays real so only the quota half is broken.
 *
 * `quotaRewards` counts credit attempts, so a test can assert that nothing was
 * refunded rather than inferring it from a counter that was never charged.
 */
class FailOpenQuotaMetering extends MeteringService {
  quotaRewards = 0;

  protected override createLimiter(
    keyPrefix: string,
    points: number,
    duration: number,
  ): RateLimiterAbstract {
    if (keyPrefix !== 'meter:quota') return new RateLimiterMemory({ points, duration });
    return {
      consume: async () => {
        throw new Error('Redis connection is closed');
      },
      reward: async () => {
        this.quotaRewards += 1;
        return undefined;
      },
      delete: async () => true,
    } as unknown as RateLimiterAbstract;
  }
}

const usageStub = { updateOne: () => ({ exec: async () => undefined }) };
const configStub = { redisUrl: 'redis://localhost:6379' } as any;

/** Records every `usage` write so the Mongo half of a refund is assertable. */
function recordingUsage() {
  const writes: Array<{ filter: any; update: any; options?: any }> = [];
  const model = {
    updateOne: (filter: any, update: any, options?: any) => {
      writes.push({ filter, update, options });
      return { exec: async () => ({ matchedCount: 1, upsertedCount: 0 }) };
    },
  };
  return { writes, model };
}

/**
 * Stateful `usage` stub: models the `{customerId, period}` row, the unique
 * index on it, and the `quotaResetAt: { $exists: false }` claim filter that
 * makes `resetQuotaPeriod` at-most-once per period.
 */
function usageStore() {
  const rows = new Map<string, { quotaResetAt?: Date }>();
  const filters: any[] = [];
  const model = {
    updateOne: (filter: any, update: any, options: any = {}) => {
      filters.push(filter);
      const rowKey = `${String(filter.customerId)}:${filter.period}`;
      const existing = rows.get(rowKey);
      if (filter.quotaResetAt?.$exists === false) {
        if (existing?.quotaResetAt) {
          // Filter misses; the upsert then trips the unique index.
          return { exec: async () => { throw new Error('E11000 duplicate key error'); } };
        }
        rows.set(rowKey, { ...existing, quotaResetAt: update.$set.quotaResetAt });
        return {
          exec: async () => (existing ? { matchedCount: 1, upsertedCount: 0 } : { matchedCount: 0, upsertedCount: 1 }),
        };
      }
      if (!existing) rows.set(rowKey, {});
      return { exec: async () => ({ matchedCount: 1, upsertedCount: 0 }) };
    },
  };
  return { rows, filters, model };
}

function plan(over: Partial<CachedPlan> = {}): CachedPlan {
  return {
    key: 'free',
    name: 'Free',
    monthlyUnits: 100,
    rateLimitPerMin: 10,
    price: 0,
    enabled: true,
    selfServe: true,
    maxApiKeys: 1,
    allowBrowserKeys: false,
    description: '',
    features: [],
    prices: [],
    ...over,
  };
}

const CUSTOMER = '6650aaaaaaaaaaaaaaaaaaaa';

describe('MeteringService', () => {
  let svc: TestMetering;
  beforeEach(() => {
    svc = new TestMetering(configStub, usageStub as never);
  });

  it('decrements quota by unit cost and reports remaining', async () => {
    const r1 = await svc.checkAndConsume({ apiKeyId: 'k', customerId: '6650aaaaaaaaaaaaaaaaaaaa', plan: plan(), unitCost: 10 });
    expect(r1.quota?.limit).toBe(100);
    expect(r1.quota?.remaining).toBe(90);
    expect(r1.rate.remaining).toBe(9);

    const r2 = await svc.checkAndConsume({ apiKeyId: 'k', customerId: '6650aaaaaaaaaaaaaaaaaaaa', plan: plan(), unitCost: 10 });
    expect(r2.quota?.remaining).toBe(80);
  });

  it('throws a quota rejection when the monthly budget is exhausted', async () => {
    const p = plan({ monthlyUnits: 15, rateLimitPerMin: 1000 });
    await svc.checkAndConsume({ apiKeyId: 'k', customerId: '6650aaaaaaaaaaaaaaaaaaaa', plan: p, unitCost: 10 });
    await expect(
      svc.checkAndConsume({ apiKeyId: 'k', customerId: '6650aaaaaaaaaaaaaaaaaaaa', plan: p, unitCost: 10 }),
    ).rejects.toMatchObject({ kind: 'quota' } satisfies Partial<MeteringRejectionError>);
  });

  it('throws a rate rejection when the per-minute burst is exhausted', async () => {
    const p = plan({ monthlyUnits: 1_000_000, rateLimitPerMin: 2 });
    await svc.checkAndConsume({ apiKeyId: 'k', customerId: '6650aaaaaaaaaaaaaaaaaaaa', plan: p, unitCost: 1 });
    await svc.checkAndConsume({ apiKeyId: 'k', customerId: '6650aaaaaaaaaaaaaaaaaaaa', plan: p, unitCost: 1 });
    await expect(
      svc.checkAndConsume({ apiKeyId: 'k', customerId: '6650aaaaaaaaaaaaaaaaaaaa', plan: p, unitCost: 1 }),
    ).rejects.toMatchObject({ kind: 'rate' });
  });

  it('skips quota entirely for an unlimited plan (monthlyUnits 0)', async () => {
    const p = plan({ monthlyUnits: 0, rateLimitPerMin: 1000 });
    const r = await svc.checkAndConsume({ apiKeyId: 'k', customerId: '6650aaaaaaaaaaaaaaaaaaaa', plan: p, unitCost: 9999 });
    expect(r.quota).toBeNull();
  });

  it('refunds consumed units via reward()', async () => {
    const p = plan();
    const first = await svc.checkAndConsume({ apiKeyId: 'k', customerId: '6650aaaaaaaaaaaaaaaaaaaa', plan: p, unitCost: 10 });
    expect(first.quota?.remaining).toBe(90);
    await svc.reward({ customerId: '6650aaaaaaaaaaaaaaaaaaaa', plan: p, unitCost: 10, quotaCharged: true });
    const second = await svc.checkAndConsume({ apiKeyId: 'k2', customerId: '6650aaaaaaaaaaaaaaaaaaaa', plan: p, unitCost: 10 });
    expect(second.quota?.remaining).toBe(90); // back to 90, not 80
  });

  it('reports quotaCharged only when the counter really moved', async () => {
    // The flag the refund path branches on. `quota` being non-null does NOT imply
    // it — the fail-open branch returns a synthetic full-budget view.
    const charged = await svc.checkAndConsume({
      apiKeyId: 'k',
      customerId: CUSTOMER,
      plan: plan(),
      unitCost: 10,
    });
    expect(charged.quotaCharged).toBe(true);

    const unlimited = await svc.checkAndConsume({
      apiKeyId: 'k',
      customerId: CUSTOMER,
      plan: plan({ monthlyUnits: 0, rateLimitPerMin: 1000 }),
      unitCost: 10,
    });
    expect(unlimited.quotaCharged).toBe(false);

    const freeRoute = await svc.checkAndConsume({
      apiKeyId: 'k',
      customerId: CUSTOMER,
      plan: plan(),
      unitCost: 0,
    });
    expect(freeRoute.quotaCharged).toBe(false);
  });

  it('reports quotaCharged FALSE when the quota limiter fails open', async () => {
    // FINDING 9, at its source. A Redis error is swallowed and the request is
    // allowed through having consumed NOTHING, so a later 4xx must not credit
    // anything — `reward` is an INCRBY of a negative amount, which would leave a
    // negative counter under a 35-day TTL, i.e. free units for the period.
    const usage = recordingUsage();
    const svc2 = new FailOpenQuotaMetering(configStub, usage.model as never);

    const result = await svc2.checkAndConsume({
      apiKeyId: 'k',
      customerId: CUSTOMER,
      plan: plan(),
      unitCost: 10,
    });

    // Allowed through, with a synthetic full-budget view whose `resetSec` is the
    // MONTH ROLLOVER. This used to assert `35 * 24 * 60 * 60` — the literal
    // `QUOTA_DURATION_SEC` the branch returned — which is the Redis key's TTL
    // and not when the customer's units come back. The quota resets because the
    // key NAME carries `YYYY-MM`, so the honest answer is the 1st of next month
    // (also what the portal's `QuotaMeter` has always told people).
    expect(result.quota).toEqual({
      limit: 100,
      remaining: 100,
      resetSec: secondsUntilQuotaReset(),
    });
    // …and never the old 35-day figure, whichever day of the month this runs on.
    expect(result.quota?.resetSec).toBeLessThanOrEqual(31 * 24 * 60 * 60);
    // …and explicitly NOT charged.
    expect(result.quotaCharged).toBe(false);

    await svc2.reward({ customerId: CUSTOMER, plan: plan(), unitCost: 10, quotaCharged: false });
    expect(svc2.quotaRewards).toBe(0);
  });

  it('compensates the MONGO usage snapshot on a refund, and never upserts one', async () => {
    // FINDING 6. `checkAndConsume` writes Redis AND the Mongo snapshot; `reward`
    // used to write Redis only, so the enforced quota came back while the number
    // the customer READS (`QuotaMeter`, via `customer-self.service.ts`) kept the
    // charge.
    const usage = recordingUsage();
    const svc2 = new TestMetering(configStub, usage.model as never);
    const p = plan();

    await svc2.checkAndConsume({ apiKeyId: 'k', customerId: CUSTOMER, plan: p, unitCost: 10 });
    expect(usage.writes.at(-1)?.update.$inc).toEqual({ unitsConsumed: 10, requestCount: 1 });

    await svc2.reward({ customerId: CUSTOMER, plan: p, unitCost: 10, quotaCharged: true });

    const compensation = usage.writes.at(-1)!;
    // Units come back…
    expect(compensation.update.$inc).toEqual({ unitsConsumed: -10 });
    // …the request itself stays counted (it happened; only the CHARGE reversed)…
    expect(compensation.update.$inc).not.toHaveProperty('requestCount');
    // …and NO upsert: a missing row means the snapshot never landed, so there is
    // nothing to reverse and upserting would CREATE negative units.
    expect(compensation.options?.upsert).toBeFalsy();
    expect(String(compensation.filter.customerId)).toBe(CUSTOMER);
    expect(compensation.filter.period).toMatch(/^\d{4}-\d{2}$/);
  });

  it('compensates Mongo even when Redis was NOT charged — each store on its own terms', async () => {
    // The fail-open path still wrote the Mongo snapshot (it is unconditional in
    // `checkAndConsume`), so gating BOTH halves on `quotaCharged` would leave the
    // customer-visible number permanently over-counted.
    const usage = recordingUsage();
    const svc2 = new TestMetering(configStub, usage.model as never);

    await svc2.reward({ customerId: CUSTOMER, plan: plan(), unitCost: 10, quotaCharged: false });

    expect(usage.writes).toHaveLength(1);
    expect(usage.writes[0].update.$inc).toEqual({ unitsConsumed: -10 });
  });

  it('does nothing at all for a zero-cost route', async () => {
    const usage = recordingUsage();
    const svc2 = new TestMetering(configStub, usage.model as never);

    await svc2.reward({ customerId: CUSTOMER, plan: plan(), unitCost: 0, quotaCharged: true });

    expect(usage.writes).toHaveLength(0);
  });

  it('applies the new ceiling after evictPlanLimiter', async () => {
    const small = plan({ monthlyUnits: 10, rateLimitPerMin: 1000 });
    await svc.checkAndConsume({ apiKeyId: 'k', customerId: '6650aaaaaaaaaaaaaaaaaaaa', plan: small, unitCost: 10 }); // exhausts 10
    // the cached limiter still has the old ceiling, so another consume rejects
    await expect(
      svc.checkAndConsume({ apiKeyId: 'k', customerId: '6650aaaaaaaaaaaaaaaaaaaa', plan: small, unitCost: 10 }),
    ).rejects.toMatchObject({ kind: 'quota' });
    // raise the ceiling + evict → the next call rebuilds the limiter with new points
    svc.evictPlanLimiter('free');
    const bigger = plan({ monthlyUnits: 100, rateLimitPerMin: 1000 });
    const r = await svc.checkAndConsume({ apiKeyId: 'k', customerId: '6650aaaaaaaaaaaaaaaaaaaa', plan: bigger, unitCost: 10 });
    expect(r.quota?.limit).toBe(100);
    // (under Redis the prior consumption persists; the in-memory test limiter
    // starts fresh, which still proves the new ceiling is in effect)
    expect(r.quota?.remaining).toBe(90);
  });
});

describe('MeteringService.resetQuotaPeriod', () => {
  it('clears the shared quota key so an involuntary downgrade is not a month-long 429', async () => {
    const usage = usageStore();
    const svc = new TestMetering(configStub, usage.model as never);
    // The downgrade state: consumed already at/over the new ceiling, so every
    // request 429s for the rest of the calendar month.
    const p = plan({ monthlyUnits: 100, rateLimitPerMin: 1000 });
    const other = '6650bbbbbbbbbbbbbbbbbbbb';
    await svc.checkAndConsume({ apiKeyId: 'k', customerId: CUSTOMER, plan: p, unitCost: 100 });
    await svc.checkAndConsume({ apiKeyId: 'k2', customerId: other, plan: p, unitCost: 40 });
    await expect(
      svc.checkAndConsume({ apiKeyId: 'k', customerId: CUSTOMER, plan: p, unitCost: 1 }),
    ).rejects.toMatchObject({ kind: 'quota' });

    expect(await svc.resetQuotaPeriod(CUSTOMER)).toBe(true);

    const after = await svc.checkAndConsume({ apiKeyId: 'k', customerId: CUSTOMER, plan: p, unitCost: 1 });
    expect(after.quota?.limit).toBe(100);
    expect(after.quota?.remaining).toBe(99);
    // Scoped to one customer — nobody else's consumption is forgiven.
    const untouched = await svc.checkAndConsume({ apiKeyId: 'k2', customerId: other, plan: p, unitCost: 1 });
    expect(untouched.quota?.remaining).toBe(59);
  });

  it('stamps usage.quotaResetAt and refuses a second reset in the same period', async () => {
    const usage = usageStore();
    const svc = new TestMetering(configStub, usage.model as never);
    await svc.checkAndConsume({ apiKeyId: 'k', customerId: CUSTOMER, plan: plan(), unitCost: 10 });

    expect(await svc.resetQuotaPeriod(CUSTOMER)).toBe(true);
    const stamped = [...usage.rows.values()].find((row) => row.quotaResetAt);
    expect(stamped?.quotaResetAt).toBeInstanceOf(Date);

    // Second attempt: the claim filter misses and the unique index rejects.
    expect(await svc.resetQuotaPeriod(CUSTOMER)).toBe(false);
    // The claim is scoped to one customer + one period, never a blanket wipe.
    const claim = usage.filters.find((f) => f.quotaResetAt?.$exists === false);
    expect(String(claim.customerId)).toBe(CUSTOMER);
    expect(claim.period).toMatch(/^\d{4}-\d{2}$/);
  });

  it('refuses a malformed customer id instead of throwing', async () => {
    const usage = usageStore();
    const svc = new TestMetering(configStub, usage.model as never);
    expect(await svc.resetQuotaPeriod('not-an-object-id')).toBe(false);
    expect(usage.filters).toHaveLength(0);
  });
});

/**
 * `MeteringGuard` charges BEFORE the handler runs, so anything that fails
 * afterwards has already been billed. These pin which failures get the units
 * back. Driven through the real `MeteringService` (in-memory limiter) rather
 * than a spy, so each case asserts the quota a customer actually has left.
 */
describe('MeteringInterceptor refunds', () => {
  const CUSTOMER_ID = '6650cccccccccccccccccccc';

  function harness() {
    const svc = new TestMetering(configStub, usageStub as never);
    const p = plan({ monthlyUnits: 100, rateLimitPerMin: 1000 });
    const cache = { getPlan: (key: string) => (key === p.key ? p : undefined) };
    return { svc, plan: p, interceptor: new MeteringInterceptor(svc, cache as never) };
  }

  /**
   * Mirrors what `MeteringGuard` stamps on the request after charging.
   *
   * `quotaCharged` is part of that stamp and must be modelled here, because the
   * refund path now branches on it: the guard writes `false` up front and
   * overwrites it with `result.quotaCharged` only once the consume RETURNS, so a
   * fixture that omits it is a request whose counter was never charged.
   */
  function meteredRequest(unitCost = 10, quotaCharged = true) {
    return { metering: { customerId: CUSTOMER_ID, planKey: 'free', unitCost, quotaCharged } };
  }

  function contextFor(req: unknown): ExecutionContext {
    return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
  }

  /**
   * Run the interceptor over a handler that throws `err` (or succeeds).
   *
   * Resolves on the MICROTASK queue only — never `setTimeout`. `reward` on
   * `RateLimiterMemory` mutates the store synchronously (the Promise executor
   * runs inline), so no timer is needed, and letting one fire would break the
   * assertions: `QUOTA_DURATION_SEC` (35 days) overflows a 32-bit timeout, so
   * Node clamps the record's expiry to 1ms and the consumed counter silently
   * resets between two awaited ticks.
   */
  async function runThrough(
    interceptor: MeteringInterceptor,
    req: unknown,
    err?: unknown,
  ): Promise<{ error?: unknown; value?: unknown }> {
    const handler = {
      handle: () => (err ? rxThrowError(() => err) : of({ ok: true })),
    } as unknown as CallHandler;
    let seen: { error?: unknown; value?: unknown } = {};
    interceptor.intercept(contextFor(req), handler).subscribe({
      next: (value) => (seen = { value }),
      error: (error: unknown) => (seen = { error }),
    });
    await Promise.resolve();
    return seen;
  }

  it('refunds a 4xx — the API refused to serve the request, so it is not billable', async () => {
    const { svc, plan: p, interceptor } = harness();
    const first = await svc.checkAndConsume({ apiKeyId: 'k', customerId: CUSTOMER_ID, plan: p, unitCost: 10 });
    expect(first.quota?.remaining).toBe(90);

    // The live case: a bad `?protocol=` 400s in the handler after the charge.
    const seen = await runThrough(interceptor, meteredRequest(), new BadRequestException('Unsupported protocol'));
    expect(seen).toMatchObject({ error: expect.any(BadRequestException) }); // still rethrown

    const next = await svc.checkAndConsume({ apiKeyId: 'k', customerId: CUSTOMER_ID, plan: p, unitCost: 10 });
    expect(next.quota?.remaining).toBe(90); // credited back, not 80
  });

  it('refunds a 404 the same way (any 4xx, not just validation)', async () => {
    const { svc, plan: p, interceptor } = harness();
    await svc.checkAndConsume({ apiKeyId: 'k', customerId: CUSTOMER_ID, plan: p, unitCost: 10 });
    await runThrough(interceptor, meteredRequest(), new NotFoundException('Position not found'));
    const next = await svc.checkAndConsume({ apiKeyId: 'k', customerId: CUSTOMER_ID, plan: p, unitCost: 10 });
    expect(next.quota?.remaining).toBe(90);
  });

  it('still refunds a 5xx (the original contract — clients never pay for our outages)', async () => {
    const { svc, plan: p, interceptor } = harness();
    await svc.checkAndConsume({ apiKeyId: 'k', customerId: CUSTOMER_ID, plan: p, unitCost: 10 });
    await runThrough(interceptor, meteredRequest(), new InternalServerErrorException('boom'));
    const next = await svc.checkAndConsume({ apiKeyId: 'k', customerId: CUSTOMER_ID, plan: p, unitCost: 10 });
    expect(next.quota?.remaining).toBe(90);
  });

  it('refunds a non-HttpException escape as the 500 it becomes', async () => {
    const { svc, plan: p, interceptor } = harness();
    await svc.checkAndConsume({ apiKeyId: 'k', customerId: CUSTOMER_ID, plan: p, unitCost: 10 });
    await runThrough(interceptor, meteredRequest(), new TypeError('undefined is not a function'));
    const next = await svc.checkAndConsume({ apiKeyId: 'k', customerId: CUSTOMER_ID, plan: p, unitCost: 10 });
    expect(next.quota?.remaining).toBe(90);
  });

  it('does NOT refund a 2xx — a served request stays charged', async () => {
    const { svc, plan: p, interceptor } = harness();
    await svc.checkAndConsume({ apiKeyId: 'k', customerId: CUSTOMER_ID, plan: p, unitCost: 10 });
    const seen = await runThrough(interceptor, meteredRequest());
    expect(seen).toMatchObject({ value: { ok: true } });
    const next = await svc.checkAndConsume({ apiKeyId: 'k', customerId: CUSTOMER_ID, plan: p, unitCost: 10 });
    expect(next.quota?.remaining).toBe(80);
  });

  it('does NOT refund a 429 — that status IS the meter working', async () => {
    const { svc, plan: p, interceptor } = harness();
    await svc.checkAndConsume({ apiKeyId: 'k', customerId: CUSTOMER_ID, plan: p, unitCost: 10 });
    // Unreachable today (MeteringGuard runs before interceptors) but pinned:
    // refunding a limit rejection would MINT units on a loop.
    await runThrough(
      interceptor,
      meteredRequest(),
      new HttpException({ error: 'Monthly quota exceeded' }, HttpStatus.TOO_MANY_REQUESTS),
    );
    const next = await svc.checkAndConsume({ apiKeyId: 'k', customerId: CUSTOMER_ID, plan: p, unitCost: 10 });
    expect(next.quota?.remaining).toBe(80);
  });

  it('does NOT refund a request that was never charged (no metering context)', async () => {
    const { svc, plan: p, interceptor } = harness();
    await svc.checkAndConsume({ apiKeyId: 'k', customerId: CUSTOMER_ID, plan: p, unitCost: 10 });
    // How a 401/403 arrives: the auth guard rejected before `req.metering` existed.
    await runThrough(interceptor, {}, new BadRequestException('never metered'));
    const next = await svc.checkAndConsume({ apiKeyId: 'k', customerId: CUSTOMER_ID, plan: p, unitCost: 10 });
    expect(next.quota?.remaining).toBe(80);
  });

  it('refunds at most once per request', async () => {
    const { svc, plan: p, interceptor } = harness();
    await svc.checkAndConsume({ apiKeyId: 'k', customerId: CUSTOMER_ID, plan: p, unitCost: 10 });
    const req = meteredRequest();
    await runThrough(interceptor, req, new BadRequestException('bad'));
    await runThrough(interceptor, req, new BadRequestException('bad'));
    const next = await svc.checkAndConsume({ apiKeyId: 'k', customerId: CUSTOMER_ID, plan: p, unitCost: 10 });
    // One credit → back to 90. A double credit would drive consumption
    // negative and hand out 100.
    expect(next.quota?.remaining).toBe(90);
  });

  it('does not refund when the plan has vanished from the settings cache', async () => {
    const { svc, plan: p, interceptor } = harness();
    await svc.checkAndConsume({ apiKeyId: 'k', customerId: CUSTOMER_ID, plan: p, unitCost: 10 });
    const req = {
      metering: { customerId: CUSTOMER_ID, planKey: 'deleted-plan', unitCost: 10, quotaCharged: true },
    };
    await runThrough(interceptor, req, new BadRequestException('bad'));
    expect(req.metering).not.toHaveProperty('refunded', true); // retryable, not swallowed
    const next = await svc.checkAndConsume({ apiKeyId: 'k', customerId: CUSTOMER_ID, plan: p, unitCost: 10 });
    expect(next.quota?.remaining).toBe(80);
  });

  it('classifies statuses: every error except 429', () => {
    for (const status of [400, 401, 403, 404, 422, 500, 502, 503]) {
      expect(isRefundable(status)).toBe(true);
    }
    for (const status of [200, 201, 204, 301, 304, 429]) {
      expect(isRefundable(status)).toBe(false);
    }
  });
});
