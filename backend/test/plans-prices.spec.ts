import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  activeMonthlyAmountMinor,
  countActiveMonthlyPrices,
  isActivePrice,
  isMonthlyPrice,
  monthlyPriceId,
  syncMonthlyAmount,
} from '../src/billing/plan.schema.js';
import type { PlanPrice } from '../src/billing/plan.schema.js';
import { PlansService } from '../src/billing/plans.service.js';

/**
 * FINDING 10 — A PLAN MAY HAVE EXACTLY ONE ACTIVE MONTHLY PRICE.
 *
 * `activeMonthlyAmountMinor` resolves the monthly amount with `.find()`, and that
 * one value is both the public pricing page's number and the float `Plan.price`
 * the admin table renders. So the moment a plan carries two ACTIVE monthly rows,
 * what a customer is quoted is whichever row happens to sit earlier in the array
 * — and nothing anywhere reports the conflict.
 *
 * How it got there: `PlansService.update` merges an incoming `prices[]` BY id.
 * A PATCH carrying one monthly price whose id DIFFERS from the stored one — the
 * `standard-monthly` / `standard_monthly` hyphen-vs-underscore hazard the
 * migration script warns about in its own comments — is not an edit. It APPENDS.
 * And the `prices[]` branch never reaches `syncMonthlyAmount`, which is the only
 * code that deactivates rival monthly rows, so there was nothing left to notice.
 *
 * The check therefore runs on the MERGED array in both `create` and `update`,
 * never on the incoming payload: in isolation the payload is impeccable.
 */

const PLAN_KEY = 'standard';

function monthly(id: string, unitAmountMinor: number, over: Partial<PlanPrice> = {}): PlanPrice {
  return {
    id,
    interval: 'month',
    intervalCount: 1,
    unitAmountMinor,
    currency: 'USD',
    active: true,
    ...over,
  };
}

function annual(id: string, unitAmountMinor: number): PlanPrice {
  return { id, interval: 'year', intervalCount: 1, unitAmountMinor, currency: 'USD', active: true };
}

/**
 * `PlansService` over an in-memory plans collection.
 *
 * Only `findOne`/`create`/`findOneAndUpdate` are reached by these paths; the
 * cache and metering collaborators are no-ops because what is under test is the
 * money array, not the invalidation that follows a successful write.
 */
function buildService(stored?: Record<string, unknown>) {
  const writes: Array<Record<string, unknown>> = [];
  const plans = {
    findOne: () => ({ lean: () => ({ exec: async () => stored ?? null }) }),
    create: async (doc: Record<string, unknown>) => ({ toObject: () => doc }),
    findOneAndUpdate: (
      _filter: unknown,
      update: { $set: Record<string, unknown> },
    ) => ({
      lean: () => ({
        exec: async () => {
          writes.push(update.$set);
          return { key: PLAN_KEY, ...update.$set };
        },
      }),
    }),
  };
  const service = new PlansService(
    plans as never,
    { refresh: async () => undefined } as never,
    { evictPlanLimiter: () => undefined } as never,
    { countDocuments: () => ({ exec: async () => 0 }) } as never,
  );
  return { service, writes };
}

/** A stored plan carrying one active monthly price under the UNDERSCORE id. */
function storedPlan(over: Record<string, unknown> = {}) {
  return {
    key: PLAN_KEY,
    name: 'Standard',
    price: 19,
    monthlyUnits: 5_000_000,
    rateLimitPerMin: 300,
    enabled: true,
    prices: [monthly(monthlyPriceId(PLAN_KEY), 1_900), annual('standard_annual', 19_000)],
    __v: 3,
    ...over,
  };
}

describe('countActiveMonthlyPrices', () => {
  it('counts only ACTIVE 1-month rows', () => {
    expect(countActiveMonthlyPrices(undefined)).toBe(0);
    expect(countActiveMonthlyPrices([])).toBe(0);
    expect(countActiveMonthlyPrices([monthly('a', 100)])).toBe(1);
    expect(countActiveMonthlyPrices([monthly('a', 100), annual('b', 1_000)])).toBe(1);
    expect(countActiveMonthlyPrices([monthly('a', 100), monthly('b', 200)])).toBe(2);
    // A DEACTIVATED rival is fine — that is how `syncMonthlyAmount` resolves one.
    expect(
      countActiveMonthlyPrices([monthly('a', 100), monthly('b', 200, { active: false })]),
    ).toBe(1);
  });

  it('treats a raw-driver row with NO intervalCount/active as monthly and active', () => {
    // The raw driver applies no Mongoose defaults and neither does `.lean()`, so
    // a migration-written row simply has no `intervalCount`. Matching strictly on
    // `=== 1` classified those as "not monthly", which is what let a second
    // monthly row in unnoticed in the first place.
    const bare = { id: 'legacy_monthly', interval: 'month' as const, unitAmountMinor: 1_900 };
    expect(isMonthlyPrice(bare)).toBe(true);
    expect(isActivePrice(bare)).toBe(true);
    expect(countActiveMonthlyPrices([bare, monthly('standard_monthly', 2_900)])).toBe(2);
  });
});

describe('PlansService.update — the merge cannot fork the monthly price', () => {
  it('REFUSES a payload whose price id differs from the stored one', async () => {
    // THE bug, exactly: a hyphen where the stored row has an underscore. The
    // payload is a single, valid monthly price; the MERGED result is two.
    const { service, writes } = buildService(storedPlan());

    await expect(
      service.update(PLAN_KEY, {
        prices: [{ id: 'standard-monthly', interval: 'month', unitAmountMinor: 2_900 }],
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);

    // Nothing was written — the refusal happens before the update.
    expect(writes).toHaveLength(0);
  });

  it('names both ids in the error, so the fix is obvious', async () => {
    const { service } = buildService(storedPlan());

    // Read the RESPONSE, not `.message`: every refusal in this service throws
    // `new BadRequestException({ error })`, whose `.message` is the generic
    // "Bad Request Exception" — a `toThrow(/…/)` here would assert nothing.
    let response: unknown;
    try {
      await service.update(PLAN_KEY, {
        prices: [{ id: 'standard-monthly', interval: 'month', unitAmountMinor: 2_900 }],
      } as never);
      throw new Error('expected the update to be refused');
    } catch (err) {
      response = (err as BadRequestException).getResponse();
    }

    const message = (response as { error: string }).error;
    expect(message).toContain('standard_monthly');
    expect(message).toContain('standard-monthly');
    // It says what to DO, not just that the input was bad.
    expect(message).toMatch(/Deactivate|reuse/);
  });

  it('ALLOWS a reprice that reuses the stored id — the intended edit', async () => {
    const { service, writes } = buildService(storedPlan());

    await service.update(PLAN_KEY, {
      prices: [{ id: monthlyPriceId(PLAN_KEY), interval: 'month', unitAmountMinor: 2_900 }],
    } as never);

    const written = writes[0].prices as PlanPrice[];
    expect(countActiveMonthlyPrices(written)).toBe(1);
    expect(activeMonthlyAmountMinor(written)).toBe(2_900);
    // The annual row survives the merge — that regression is what made `update`
    // a merge rather than a wholesale `$set` in the first place.
    expect(written.some((price) => price.interval === 'year')).toBe(true);
    // …and the float `price` denormalisation follows the new amount.
    expect(writes[0].price).toBe(29);
  });

  it('ALLOWS a new monthly id when the payload DEACTIVATES the old one', async () => {
    // The legitimate way to swap a price row: retire one, add the other, in the
    // same PATCH. Only the ACTIVE count is constrained.
    const { service, writes } = buildService(storedPlan());

    await service.update(PLAN_KEY, {
      prices: [
        { id: monthlyPriceId(PLAN_KEY), interval: 'month', unitAmountMinor: 1_900, active: false },
        { id: 'standard_monthly_v2', interval: 'month', unitAmountMinor: 2_900 },
      ],
    } as never);

    const written = writes[0].prices as PlanPrice[];
    expect(countActiveMonthlyPrices(written)).toBe(1);
    expect(activeMonthlyAmountMinor(written)).toBe(2_900);
  });

  it('leaves the float-price path alone — syncMonthlyAmount already deconflicts', async () => {
    // A PATCH carrying only `price` goes through `syncMonthlyAmount`, which
    // deactivates rival monthly rows on the way past. So even a plan that is
    // ALREADY forked (a half-run migration, a hand edit) is repaired rather than
    // refused: refusing here would leave the operator no way to fix it.
    const forked = storedPlan({
      prices: [monthly('standard_monthly', 1_900), monthly('standard-monthly', 9_900)],
    });
    const { service, writes } = buildService(forked);

    await service.update(PLAN_KEY, { price: 39 } as never);

    const written = writes[0].prices as PlanPrice[];
    expect(countActiveMonthlyPrices(written)).toBe(1);
    expect(activeMonthlyAmountMinor(written)).toBe(3_900);
  });

  it('and that repair is what syncMonthlyAmount does directly', () => {
    const repaired = syncMonthlyAmount(
      PLAN_KEY,
      [monthly('standard_monthly', 1_900), monthly('standard-monthly', 9_900)],
      39,
    );

    expect(countActiveMonthlyPrices(repaired)).toBe(1);
    expect(activeMonthlyAmountMinor(repaired)).toBe(3_900);
  });
});

describe('PlansService.create — a plan cannot be born forked', () => {
  it('REFUSES two active monthly prices in the create payload', async () => {
    const { service } = buildService();

    await expect(
      service.create({
        key: PLAN_KEY,
        name: 'Standard',
        monthlyUnits: 1,
        rateLimitPerMin: 1,
        prices: [
          { id: 'standard_monthly', interval: 'month', unitAmountMinor: 1_900 },
          { id: 'standard_monthly_too', interval: 'month', unitAmountMinor: 2_900 },
        ],
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts the ordinary monthly + annual pair', async () => {
    const { service } = buildService();

    const created = await service.create({
      key: PLAN_KEY,
      name: 'Standard',
      monthlyUnits: 1,
      rateLimitPerMin: 1,
      prices: [
        { id: 'standard_monthly', interval: 'month', unitAmountMinor: 1_900 },
        { id: 'standard_annual', interval: 'year', unitAmountMinor: 19_000 },
      ],
    } as never);

    expect(countActiveMonthlyPrices((created as { prices: PlanPrice[] }).prices)).toBe(1);
  });
});
