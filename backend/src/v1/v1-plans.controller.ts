import { Controller, Get, Inject } from '@nestjs/common';
import { ENDPOINT_COST_SEEDS, seedCostFor } from '../billing/endpoint-costs.seed.js';
import type { PlanPriceInterval } from '../billing/plan.schema.js';
import { SettingsCacheService } from '../billing/settings-cache.service.js';

/** A price row exactly as the pricing page renders it. */
interface PublicPriceView {
  id: string;
  interval: PlanPriceInterval;
  /** Money. ALWAYS an integer in MINOR units (cents) — never a float. */
  unitAmountMinor: number;
  currency: string;
  displayNote?: string;
}

/** A plan card. Every field here is a permanent public commitment. */
interface PublicPlanView {
  key: string;
  name: string;
  description: string;
  features: string[];
  monthlyUnits: number;
  rateLimitPerMin: number;
  maxApiKeys: number;
  allowBrowserKeys: boolean;
  selfServe: boolean;
  prices: PublicPriceView[];
}

/** One published per-call price, in the same units the quota is denominated in. */
interface PublicUnitCostView {
  routeKey: string;
  cost: number;
  description: string;
}

/**
 * Public, unauthenticated pricing endpoints (no API key, no metering) — the
 * marketing site and the pricing page must render for an anonymous visitor, so
 * these deliberately carry NO `@UseGuards`/`@UseInterceptors`/`@UnitCost`.
 * That omission IS the free-route mechanism in this codebase (same posture as
 * `V1MetadataController`); there is no `@Public()` flag to set, and adding any
 * of those three decorators — or moving these handlers onto one of the metered
 * controllers — would 401 every anonymous pricing request.
 *
 * Both handlers read the in-memory `SettingsCacheService` (sync, no DB) rather
 * than `PlansService`: `listPublicPlans()` is the projected, sellable-only view,
 * whereas the admin service returns raw documents including `providerPriceId`,
 * disabled tiers and `_id`/`__v`. Serving the public route from the cache is
 * also why `PlansService` never needs exporting from `BillingModule`.
 */
@Controller('v1')
export class V1PlansController {
  constructor(@Inject(SettingsCacheService) private readonly cache: SettingsCacheService) {}

  @Get('plans')
  plans(): { plans: PublicPlanView[] } {
    return {
      plans: this.cache.listPublicPlans().map((plan) => ({
        key: plan.key,
        name: plan.name,
        description: plan.description,
        features: plan.features,
        monthlyUnits: plan.monthlyUnits,
        rateLimitPerMin: plan.rateLimitPerMin,
        maxApiKeys: plan.maxApiKeys,
        allowBrowserKeys: plan.allowBrowserKeys,
        // Constant `true`: `listPublicPlans()` already filters to enabled AND
        // self-serve plans, so a sales-led tier never reaches here. The field is
        // echoed so the pricing page can key its checkout button off the payload
        // instead of assuming — it is NOT a filter the client has to apply.
        selfServe: true,
        // Re-projected rather than passed through: the cache's `PublicPlanPrice`
        // also carries `intervalCount`, which is not part of the published
        // contract. Every field on a public response is forever.
        prices: plan.prices.map((price) => {
          const view: PublicPriceView = {
            id: price.id,
            interval: price.interval,
            unitAmountMinor: price.unitAmountMinor,
            currency: price.currency,
          };
          if (price.displayNote !== undefined) view.displayNote = price.displayNote;
          return view;
        }),
      })),
    };
  }

  @Get('pricing/units')
  units(): { units: PublicUnitCostView[] } {
    // The seed list is the published route universe (there is no admin "create
    // endpoint cost" — rows only ever exist because they were seeded), and it is
    // the only place the human-readable label survives: the settings cache keeps
    // `Map<routeKey, number>` and throws labels away. Costs still come from the
    // cache so an admin repricing takes effect within the 30s TTL. A disabled row
    // caches as 0, which is exactly what the metering guard then charges — so
    // publishing it as free is truthful, not a leak of the `enabled` flag.
    return {
      units: ENDPOINT_COST_SEEDS.map((seed) => ({
        routeKey: seed.routeKey,
        // `seedCostFor(seed.routeKey)` rather than `seed.unitCost`, which is the
        // same number by construction — the point is that this route and
        // `MeteringGuard` now resolve the fallback through ONE function, so
        // "what we publish" and "what we charge" cannot drift apart again.
        cost: this.cache.getEndpointCost(seed.routeKey, seedCostFor(seed.routeKey)),
        description: seed.label,
      })),
    };
  }
}
