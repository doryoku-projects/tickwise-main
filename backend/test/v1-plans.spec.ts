import 'reflect-metadata';
import { GUARDS_METADATA, INTERCEPTORS_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it, vi } from 'vitest';
import { ENDPOINT_COST_SEEDS, seedCostFor, UNIT_COST_TIERS } from '../src/billing/endpoint-costs.seed.js';
import { UNIT_COST_KEY } from '../src/v1/unit-cost.decorator.js';
import { V1PlansController } from '../src/v1/v1-plans.controller.js';
import { V1PoolsController } from '../src/v1/v1-pools.controller.js';
import { V1PositionsController } from '../src/v1/v1-positions.controller.js';

/**
 * The cache view a controller sees: already filtered to enabled + self-serve and
 * already stripped of `providerPriceId`. `priceUsd`/`intervalCount` are present
 * here on purpose — they are the two fields the controller must NOT republish.
 */
function cacheStub() {
  return {
    listPublicPlans: vi.fn(() => [
      {
        key: 'standard',
        name: 'Standard',
        description: 'For production apps',
        monthlyUnits: 5_000_000,
        rateLimitPerMin: 300,
        maxApiKeys: 5,
        allowBrowserKeys: true,
        features: ['5 API keys', 'Browser keys'],
        priceUsd: 99,
        prices: [
          { id: 'standard_monthly', interval: 'month', intervalCount: 1, unitAmountMinor: 9_900, currency: 'USD' },
          {
            id: 'standard_annual',
            interval: 'year',
            intervalCount: 1,
            unitAmountMinor: 99_000,
            currency: 'USD',
            displayNote: '2 months free',
          },
        ],
      },
    ]),
    // Mirrors the real accessor: an admin-set DB value wins, otherwise the caller's fallback.
    getEndpointCost: vi.fn((routeKey: string, fallback: number) =>
      routeKey === 'v1.positions.charts' ? 10 : fallback,
    ),
  };
}

const PLAN_FIELDS = [
  'key',
  'name',
  'description',
  'features',
  'monthlyUnits',
  'rateLimitPerMin',
  'maxApiKeys',
  'allowBrowserKeys',
  'selfServe',
  'prices',
];

describe('V1PlansController — public, unmetered pricing routes', () => {
  it('serves both routes with no request, no API key and no metering context', () => {
    const cache = cacheStub();
    const controller = new V1PlansController(cache as never);

    // Neither handler takes a request/response, so there is nothing for an
    // anonymous caller to be missing — no header, no `req.apiClient`, no plan.
    expect(controller.plans().plans).toHaveLength(1);
    expect(controller.units().units).toHaveLength(ENDPOINT_COST_SEEDS.length);
  });

  it('carries NO guards, NO interceptor and NO @UnitCost — the free-route mechanism', () => {
    const handlers = [V1PlansController.prototype.plans, V1PlansController.prototype.units];

    for (const target of [V1PlansController, ...handlers]) {
      expect(Reflect.getMetadata(GUARDS_METADATA, target)).toBeUndefined();
      expect(Reflect.getMetadata(INTERCEPTORS_METADATA, target)).toBeUndefined();
    }
    for (const handler of handlers) {
      // A handler under MeteringGuard with no @UnitCost would silently meter at
      // cost 1 under 'v1.unknown'; here there must be no metering at all.
      expect(Reflect.getMetadata(UNIT_COST_KEY, handler)).toBeUndefined();
    }

    // Positive control: a metered controller DOES carry both, so the assertions
    // above are reading the right metadata keys rather than passing vacuously.
    expect(Reflect.getMetadata(GUARDS_METADATA, V1PositionsController)).toBeDefined();
    expect(Reflect.getMetadata(INTERCEPTORS_METADATA, V1PositionsController)).toBeDefined();
  });

  it('registers exactly GET /v1/plans and GET /v1/pricing/units', () => {
    expect(Reflect.getMetadata(PATH_METADATA, V1PlansController)).toBe('v1');
    expect(Reflect.getMetadata(PATH_METADATA, V1PlansController.prototype.plans)).toBe('plans');
    expect(Reflect.getMetadata(PATH_METADATA, V1PlansController.prototype.units)).toBe('pricing/units');
  });

  it('GET /v1/plans exposes the contract fields and nothing else', () => {
    const cache = cacheStub();
    const { plans } = new V1PlansController(cache as never).plans();

    const [plan] = plans;
    expect(Object.keys(plan).sort()).toEqual([...PLAN_FIELDS].sort());
    expect(plan).toMatchObject({
      key: 'standard',
      name: 'Standard',
      description: 'For production apps',
      features: ['5 API keys', 'Browser keys'],
      monthlyUnits: 5_000_000,
      rateLimitPerMin: 300,
      maxApiKeys: 5,
      allowBrowserKeys: true,
      selfServe: true,
    });

    // The cache view carries these; the published contract does not.
    expect(plan).not.toHaveProperty('priceUsd');
    expect(plan).not.toHaveProperty('enabled');
    expect(plan.prices[0]).not.toHaveProperty('intervalCount');
    expect(plan.prices[0]).not.toHaveProperty('providerPriceId');

    expect(Object.keys(plan.prices[0]).sort()).toEqual(['currency', 'id', 'interval', 'unitAmountMinor']);
    // `displayNote` is emitted only when set, never as an explicit `undefined`.
    expect(plan.prices[0]).not.toHaveProperty('displayNote');
    expect(Object.keys(plan.prices[1]).sort()).toEqual([
      'currency',
      'displayNote',
      'id',
      'interval',
      'unitAmountMinor',
    ]);
    expect(plan.prices[1].displayNote).toBe('2 months free');
  });

  it('GET /v1/pricing/units publishes the live cost per route and nothing else', () => {
    const cache = cacheStub();
    const { units } = new V1PlansController(cache as never).units();

    for (const unit of units) {
      expect(Object.keys(unit).sort()).toEqual(['cost', 'description', 'routeKey']);
      expect(unit).not.toHaveProperty('enabled'); // an internal toggle, never published
      expect(unit).not.toHaveProperty('label');
    }

    const byRoute = new Map(units.map((u) => [u.routeKey, u]));
    expect(byRoute.get('v1.positions.list')).toEqual({
      routeKey: 'v1.positions.list',
      // The SEEDED ladder, not a literal: pinning a number here means every
      // pricing change breaks a test that is really about the response SHAPE.
      cost: UNIT_COST_TIERS.list,
      description: 'List positions',
    });
    // The ladder is ordered, and that ordering is the product claim the pricing
    // page makes ("a chart costs more than a list"). Assert the RELATIONSHIP so
    // a future reprice that flattens it fails here rather than on the website.
    expect(UNIT_COST_TIERS.charts).toBeGreaterThan(UNIT_COST_TIERS.list);
    expect(UNIT_COST_TIERS.list).toBeGreaterThan(UNIT_COST_TIERS.detail);
    expect(byRoute.get('v1.positions.charts')?.cost).toBe(UNIT_COST_TIERS.charts);
    // …and the free metadata routes stay at 0.
    expect(byRoute.get('v1.chains')?.cost).toBe(UNIT_COST_TIERS.metadata);
    expect(UNIT_COST_TIERS.metadata).toBe(0);
    expect(cache.getEndpointCost).toHaveBeenCalledWith('v1.chains', 0);
  });
});

/**
 * FINDING 5 — THE 10x UNDERCHARGE. What the page publishes and what the meter
 * charges must be the same number on an install whose `endpoint_costs` has no
 * row for a route.
 *
 * That install is the normal case for any route added after first boot:
 * `SettingsCacheService.seedIfEmpty` only ever fills an EMPTY collection, so the
 * row never appears and nothing reports it. `V1PlansController` published the
 * seeded ladder while `MeteringGuard` fell back to a literal `1` written into
 * each `@UnitCost(routeKey, 1)` — charts advertised at 10, charged at 1, on the
 * one route whose upstream we pay per call for.
 */
describe('the published cost and the charged cost share ONE fallback', () => {
  /** What `MeteringGuard` resolves for a route when the DB has no row. */
  function guardFallback(routeKey: string): number {
    const meta = { routeKey } as { routeKey: string; fallback?: number };
    // `getEndpointCost(key, fallback)` returns the fallback when no row exists.
    return seedCostFor(meta.routeKey, meta.fallback);
  }

  it('agrees with GET /v1/pricing/units for every seeded route', () => {
    // The cache stub here answers "no row for anything", which is the whole
    // point: with rows present the two paths agree trivially.
    const cache = {
      listPublicPlans: () => [],
      getEndpointCost: (_routeKey: string, fallback: number) => fallback,
    };
    const { units } = new V1PlansController(cache as never).units();

    expect(units.length).toBe(ENDPOINT_COST_SEEDS.length);
    for (const unit of units) {
      expect(guardFallback(unit.routeKey)).toBe(unit.cost);
    }
    // And the expensive one is genuinely 10 on both sides, not 1.
    const charts = units.find((unit) => unit.routeKey === 'v1.positions.charts');
    expect(charts?.cost).toBe(UNIT_COST_TIERS.charts);
    expect(guardFallback('v1.positions.charts')).toBe(UNIT_COST_TIERS.charts);
  });

  it('carries NO literal fallback on any @UnitCost decorator', () => {
    // The literal is the defect: a number written beside the route key is a
    // second source of truth that silently outvoted the ladder. These handlers
    // must tag the key only.
    const handlers = [
      V1PositionsController.prototype.list,
      V1PositionsController.prototype.detail,
      V1PositionsController.prototype.positionCharts,
      V1PoolsController.prototype.list,
      V1PoolsController.prototype.detail,
      V1PoolsController.prototype.poolCharts,
    ];

    for (const handler of handlers) {
      const meta = Reflect.getMetadata(UNIT_COST_KEY, handler) as {
        routeKey: string;
        fallback?: number;
      };
      expect(meta.routeKey).toMatch(/^v1\./);
      expect(meta.fallback).toBeUndefined();
      // …and the key it tags is one the ladder actually prices.
      expect(ENDPOINT_COST_SEEDS.some((seed) => seed.routeKey === meta.routeKey)).toBe(true);
    }
  });

  it('falls back to 1 for a route absent from the ladder', () => {
    // An unpriced route key is a review defect, not a pricing decision — so the
    // historical 1 stands rather than a guess, and an explicit override wins.
    expect(seedCostFor('v1.some.future.route')).toBe(1);
    expect(seedCostFor('v1.some.future.route', 7)).toBe(7);
    // An override must NOT be able to undercut a route that IS on the ladder.
    expect(seedCostFor('v1.positions.charts', 1)).toBe(UNIT_COST_TIERS.charts);
  });
});
