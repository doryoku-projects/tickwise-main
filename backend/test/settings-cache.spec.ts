import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  activeMonthlyAmountMinor,
  mergePlanPrices,
  monthlyPriceId,
  syncMonthlyAmount,
} from '../src/billing/plan.schema.js';
import type { PlanPrice } from '../src/billing/plan.schema.js';
import { SettingsCacheService } from '../src/billing/settings-cache.service.js';

function modelStub(rowsRef: { rows: any[] }, count = 1) {
  return {
    estimatedDocumentCount: vi.fn(async () => count),
    insertMany: vi.fn(async () => undefined),
    find: () => ({ lean: () => ({ exec: async () => rowsRef.rows }) }),
  };
}

describe('SettingsCacheService', () => {
  it('loads seeded plans + costs and applies the decorator fallback for unknown routes', async () => {
    const plans = { rows: [{ key: 'free', name: 'Free', monthlyUnits: 50000, rateLimitPerMin: 60, price: 0, enabled: true }] };
    const costs = { rows: [{ routeKey: 'v1.positions.list', unitCost: 5, enabled: true }] };
    const cache = new SettingsCacheService(modelStub(plans) as never, modelStub(costs) as never);

    await cache.onModuleInit();

    expect(cache.getPlan('free')?.monthlyUnits).toBe(50000);
    expect(cache.getPlan('missing')).toBeUndefined();
    expect(cache.getEndpointCost('v1.positions.list', 1)).toBe(5); // DB value wins
    expect(cache.getEndpointCost('v1.unknown', 7)).toBe(7); // fallback to decorator default
  });

  it('treats a disabled endpoint cost as 0', async () => {
    const costs = { rows: [{ routeKey: 'v1.positions.list', unitCost: 5, enabled: false }] };
    const cache = new SettingsCacheService(modelStub({ rows: [] }) as never, modelStub(costs) as never);
    await cache.onModuleInit();
    expect(cache.getEndpointCost('v1.positions.list', 1)).toBe(0);
  });

  it('reflects new values after refresh() (admin-edit invalidation)', async () => {
    const plans = { rows: [{ key: 'free', name: 'Free', monthlyUnits: 100, rateLimitPerMin: 60, price: 0, enabled: true }] };
    const cache = new SettingsCacheService(modelStub(plans) as never, modelStub({ rows: [] }) as never);
    await cache.onModuleInit();
    expect(cache.getPlan('free')?.monthlyUnits).toBe(100);

    plans.rows = [{ key: 'free', name: 'Free', monthlyUnits: 5, rateLimitPerMin: 60, price: 0, enabled: true }];
    await cache.refresh();
    expect(cache.getPlan('free')?.monthlyUnits).toBe(5);
  });

  it('listPublicPlans exposes only sellable plans and only public fields', async () => {
    const plans = {
      rows: [
        // enabled + selfServe → listed, priciest first in Mongo natural order
        {
          key: 'pro',
          name: 'Pro',
          monthlyUnits: 50_000_000,
          rateLimitPerMin: 600,
          price: 790,
          enabled: true,
          selfServe: true,
          maxApiKeys: 20,
          allowBrowserKeys: true,
          description: 'High volume',
          features: ['20 keys'],
          prices: [
            { id: 'pro_monthly', interval: 'month', intervalCount: 1, unitAmountMinor: 79_000, currency: 'USD', active: true, providerPriceId: 'radom_secret_123' },
            { id: 'pro_annual', interval: 'year', intervalCount: 1, unitAmountMinor: 790_000, currency: 'USD', active: true, displayNote: '2 months free' },
            { id: 'pro_legacy', interval: 'month', intervalCount: 1, unitAmountMinor: 59_000, currency: 'USD', active: false },
          ],
        },
        { key: 'free', name: 'Free', monthlyUnits: 50_000, rateLimitPerMin: 60, price: 0, enabled: true, selfServe: true, maxApiKeys: 1, allowBrowserKeys: false, description: 'Evaluate', features: [], prices: [] },
        // sales-led → never on the pricing page
        { key: 'enterprise', name: 'Enterprise', monthlyUnits: 0, rateLimitPerMin: 1200, price: 0, enabled: true, selfServe: false, maxApiKeys: 0, allowBrowserKeys: true, description: '', features: [], prices: [] },
        // retired → hidden from the page, but still resolvable for metering
        { key: 'legacy', name: 'Legacy', monthlyUnits: 10, rateLimitPerMin: 10, price: 5, enabled: false, selfServe: true, maxApiKeys: 2, allowBrowserKeys: false, description: '', features: [], prices: [] },
      ],
    };
    const cache = new SettingsCacheService(modelStub(plans) as never, modelStub({ rows: [] }) as never);
    await cache.onModuleInit();

    const publicPlans = cache.listPublicPlans();
    expect(publicPlans.map((p) => p.key)).toEqual(['free', 'pro']); // sorted by price, deterministic
    // a retired plan is hidden publicly but must STILL resolve for metering
    expect(cache.getPlan('legacy')?.monthlyUnits).toBe(10);

    const pro = publicPlans[1];
    expect(pro.prices.map((p) => p.id)).toEqual(['pro_monthly', 'pro_annual']); // inactive dropped
    expect(pro.prices[1].displayNote).toBe('2 months free');
    expect(pro.priceUsd).toBe(790);
    expect(JSON.stringify(publicPlans)).not.toContain('radom_secret_123'); // providerPriceId never public
  });

  it('normalizes plans written before the self-serve fields existed (fail-closed)', async () => {
    const plans = { rows: [{ key: 'standard', name: 'Standard', monthlyUnits: 5_000_000, rateLimitPerMin: 300, price: 99, enabled: true }] };
    const cache = new SettingsCacheService(modelStub(plans) as never, modelStub({ rows: [] }) as never);
    await cache.onModuleInit();

    const cached = cache.getPlan('standard');
    expect(cached?.selfServe).toBe(false);
    expect(cached?.maxApiKeys).toBe(1);
    expect(cached?.allowBrowserKeys).toBe(false);
    expect(cached?.prices).toEqual([]);
    expect(cache.listPublicPlans()).toEqual([]); // not sellable until the backfill runs
  });

  it('seeds each collection only when empty', async () => {
    const planModel = modelStub({ rows: [] }, 0);
    const costModel = modelStub({ rows: [] }, 5);
    const cache = new SettingsCacheService(planModel as never, costModel as never);
    await cache.onModuleInit();
    expect(planModel.insertMany).toHaveBeenCalled(); // empty → seeded
    expect(costModel.insertMany).not.toHaveBeenCalled(); // non-empty → left alone
  });
});

/**
 * Rows that never went through Mongoose. The backfill migration writes with the
 * RAW driver and `.lean()` reads apply no defaults either, so `intervalCount`
 * and `currency` can legitimately be ABSENT in memory. Matching strictly on
 * `intervalCount === 1` made those rows invisible to both helpers: the pricing
 * page kept serving the stale amount and the first admin reprice APPENDED a
 * second monthly price instead of updating the first.
 */
describe('plan price helpers — rows written without Mongoose defaults', () => {
  // No `intervalCount`, no `currency` — exactly what the raw-driver backfill
  // used to store.
  const legacyMonthly = { id: 'standard_monthly', interval: 'month', unitAmountMinor: 9_900, active: true } as unknown as PlanPrice;

  it('resolves the monthly amount when intervalCount and currency are missing', () => {
    expect(activeMonthlyAmountMinor([legacyMonthly])).toBe(9_900);
  });

  it('treats a row missing `active` as active (the schema default)', () => {
    const noActive = { id: 'standard_monthly', interval: 'month', unitAmountMinor: 9_900 } as unknown as PlanPrice;
    expect(activeMonthlyAmountMinor([noActive])).toBe(9_900);
  });

  it('repricing a defaults-less plan UPDATES the row instead of appending a second one', () => {
    const next = syncMonthlyAmount('standard', [legacyMonthly], 129);

    expect(next).toHaveLength(1); // NOT forked
    expect(next[0].id).toBe('standard_monthly');
    expect(next[0].unitAmountMinor).toBe(12_900);
    // Repricing also backfills the defaults the raw write never applied, so the
    // row cannot fork on the NEXT edit either.
    expect(next[0].intervalCount).toBe(1);
    expect(next[0].currency).toBe('USD');
    // What the public pricing page reads is now the new amount.
    expect(activeMonthlyAmountMinor(next)).toBe(12_900);
  });

  it('leaves the annual price untouched while repricing the monthly one', () => {
    const annual = { id: 'standard_annual', interval: 'year', intervalCount: 1, unitAmountMinor: 99_000, currency: 'USD', active: true } as PlanPrice;
    const next = syncMonthlyAmount('standard', [legacyMonthly, annual], 129);
    expect(next).toHaveLength(2);
    expect(next[1]).toEqual(annual);
  });

  it('collapses a plan that already carries TWO active monthly rows', () => {
    // The state the old code produced in production: a migrated row plus the
    // one the first reprice appended.
    const forked = [
      legacyMonthly,
      { id: 'standard_monthly_2', interval: 'month', intervalCount: 1, unitAmountMinor: 12_900, currency: 'USD', active: true } as PlanPrice,
    ];
    const next = syncMonthlyAmount('standard', forked, 149);

    expect(next).toHaveLength(2); // history is kept…
    expect(next.filter((p) => p.active && p.interval === 'month')).toHaveLength(1); // …but only one is sellable
    expect(next[0]).toMatchObject({ id: 'standard_monthly', unitAmountMinor: 14_900, active: true });
    expect(next[1]).toMatchObject({ id: 'standard_monthly_2', active: false });
    expect(activeMonthlyAmountMinor(next)).toBe(14_900);
  });

  it('still creates the monthly row when a plan has none, and never for a $0 plan', () => {
    expect(syncMonthlyAmount('standard', [], 99)).toEqual([
      { id: 'standard_monthly', interval: 'month', intervalCount: 1, unitAmountMinor: 9_900, currency: 'USD', active: true },
    ]);
    expect(syncMonthlyAmount('free', [], 0)).toEqual([]);
  });

  it('heals a row already stored with the pre-fix hyphen id', () => {
    // Installs migrated before the id was fixed carry `standard-monthly`, which
    // no merge-by-id can reach. Matching on the CADENCE (not the id) is what
    // lets the next reprice update it in place instead of forking.
    const hyphenated = { id: 'standard-monthly', interval: 'month', unitAmountMinor: 9_900, active: true } as unknown as PlanPrice;
    const next = syncMonthlyAmount('standard', [hyphenated], 129);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ id: 'standard-monthly', unitAmountMinor: 12_900, intervalCount: 1, currency: 'USD' });
    expect(activeMonthlyAmountMinor(next)).toBe(12_900);
  });

  it('does not resurrect a deliberately deactivated monthly price', () => {
    const retired = { id: 'standard_monthly', interval: 'month', intervalCount: 1, unitAmountMinor: 9_900, currency: 'USD', active: false } as PlanPrice;
    const next = syncMonthlyAmount('standard', [retired], 129);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ unitAmountMinor: 12_900, active: false });
  });
});

describe('billing-subscriptions-migration.mjs price backfill', () => {
  const source = readFileSync(new URL('../scripts/billing-subscriptions-migration.mjs', import.meta.url), 'utf8');

  it('emits the id `monthlyPriceId()` generates, so a later merge-by-id hits', () => {
    // A HYPHEN here (`standard-monthly`) made the row unreachable from
    // `PlansService.update`, which merges prices[] by id.
    const suffix = source.match(/id: `\$\{plan\.key\}([^`]*)`/)?.[1];
    expect(suffix).toBe(monthlyPriceId(''));
    expect(mergePlanPrices(
      [{ id: monthlyPriceId('standard'), interval: 'month', intervalCount: 1, unitAmountMinor: 9_900, currency: 'USD', active: true }],
      [{ id: monthlyPriceId('standard'), interval: 'month', unitAmountMinor: 12_900 }],
    )).toHaveLength(1);
  });

  it('writes the fields Mongoose would have defaulted, since the raw driver does not', () => {
    expect(source).toContain('intervalCount: 1');
    expect(source).toContain("currency: 'USD'");
    expect(source).toContain('active: true');
  });
});
