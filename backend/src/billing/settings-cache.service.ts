import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { InvalidationBus } from '../common/invalidation-bus.js';
import { EndpointCost } from './endpoint-cost.schema.js';
import { ENDPOINT_COST_SEEDS } from './endpoint-costs.seed.js';
import { Plan } from './plan.schema.js';
import type { PlanPrice, PlanPriceInterval } from './plan.schema.js';
import { PLAN_SEEDS } from './plans.seed.js';

export interface CachedPlan {
  key: string;
  name: string;
  monthlyUnits: number;
  rateLimitPerMin: number;
  /** Float USD/month — the maintained denormalisation of the monthly price. */
  price: number;
  enabled: boolean;
  /** Gates the public pricing page + checkout ONLY, never metering. */
  selfServe: boolean;
  /** Active-key ceiling enforced by the portal. `0` = unlimited. */
  maxApiKeys: number;
  allowBrowserKeys: boolean;
  description: string;
  features: string[];
  prices: PlanPrice[];
}

/** A `prices[]` entry as a prospect may see it — no `providerPriceId`. */
export interface PublicPlanPrice {
  id: string;
  interval: PlanPriceInterval;
  intervalCount: number;
  /** Money. ALWAYS an integer in MINOR units (cents) — never a float. */
  unitAmountMinor: number;
  currency: string;
  displayNote?: string;
}

/** Pricing-page projection of a plan. Deliberately narrower than the raw doc. */
export interface PublicPlan {
  key: string;
  name: string;
  description: string;
  monthlyUnits: number;
  rateLimitPerMin: number;
  maxApiKeys: number;
  allowBrowserKeys: boolean;
  features: string[];
  /** Headline float USD/month, `0` for a granted tier. */
  priceUsd: number;
  prices: PublicPlanPrice[];
}

const REFRESH_TTL_MS = 30_000;

/** Seed inserts: unordered (concurrent boots) and still loud on a row that fails validation. */
export const SEED_INSERT_OPTIONS = { ordered: false, throwOnValidationError: true } as const;

/**
 * In-memory cache of plans + per-endpoint unit costs. Loaded on boot (seeding
 * each collection if empty), refreshed explicitly whenever an admin mutates a
 * plan or cost, and lazily re-read on a short TTL as a safety net. The metering
 * hot-path reads from here so it never queries Mongo per request.
 */
@Injectable()
export class SettingsCacheService implements OnModuleInit {
  private readonly logger = new Logger(SettingsCacheService.name);
  private plans = new Map<string, CachedPlan>();
  /**
   * Route key → its live price AND the operator-facing name it is billed
   * under. The label rides along because the usage-detail views render a
   * route's NAME beside its cost, and a report that read the cost from here
   * and the name from somewhere else would label a repriced route with the old
   * ladder's wording.
   */
  private endpointCosts = new Map<string, { label: string; unitCost: number }>();
  private lastLoadedAt = 0;
  private refreshing?: Promise<void>;
  /**
   * Load generations: every `refresh()` takes the next number when it STARTS
   * and applies its maps only if no later-started load has applied already.
   * A bus-triggered reload (P2.2) runs beside a TTL `maybeRefresh` that may
   * have read Mongo BEFORE the admin write; without this the older load could
   * finish last and put the old plans back until the next TTL refresh.
   */
  private loadStarted = 0;
  private loadApplied = 0;

  constructor(
    @InjectModel(Plan.name) private readonly planModel: Model<Plan>,
    @InjectModel(EndpointCost.name) private readonly endpointCostModel: Model<EndpointCost>,
    /**
     * APPENDED and optional (P2.2): an admin write on ANOTHER replica reloads
     * this one at once instead of after the 30 s TTL. Off/absent = today.
     */
    @Optional() @Inject(InvalidationBus) private readonly bus?: InvalidationBus,
  ) {
    const reload = () =>
      this.refresh().catch((err) => this.logger.warn(`Settings cache reload after a remote change failed: ${String(err)}`));
    this.bus?.on('settings', reload);
    this.bus?.on('plan', reload);
  }

  async onModuleInit(): Promise<void> {
    await this.seedIfEmpty();
    await this.refresh();
  }

  /** Seed defaults only when a collection is empty; admin owns them afterwards. */
  private async seedIfEmpty(): Promise<void> {
    const [planCount, costCount] = await Promise.all([
      this.planModel.estimatedDocumentCount(),
      this.endpointCostModel.estimatedDocumentCount(),
    ]);
    if (planCount === 0) {
      await this.seed('plans', () => this.planModel.insertMany(PLAN_SEEDS, SEED_INSERT_OPTIONS), PLAN_SEEDS.length);
    }
    if (costCount === 0) {
      await this.seed(
        'endpoint costs',
        () => this.endpointCostModel.insertMany(ENDPOINT_COST_SEEDS, SEED_INSERT_OPTIONS),
        ENDPOINT_COST_SEEDS.length,
      );
    }
  }

  /**
   * One seed insert, tolerant of a CONCURRENT boot (P2: several processes
   * start together and each may see the collection empty). The unique key
   * index makes the loser's rows E11000; `ordered: false` still inserts any
   * row the winner did not, so the collection ends complete either way.
   * `throwOnValidationError` is load-bearing: an unordered Mongoose 9
   * `insertMany` otherwise DROPS a row that fails schema validation without
   * throwing (even when every row fails), the boot logs "Seeded N" and the
   * row is never seeded on that database. With it Mongoose throws a
   * `MongooseBulkWriteError`, which is not a duplicate-key error → the boot
   * fails loudly, as the ordered insert used to.
   */
  private async seed(what: string, insert: () => Promise<unknown>, total: number): Promise<void> {
    try {
      await insert();
      this.logger.log(`Seeded ${total} ${what}`);
    } catch (err) {
      if (!isOnlyDuplicateKeyErrors(err)) throw err;
      this.logger.log(`Seed of ${what}: already seeded by a concurrent boot (duplicate keys skipped)`);
    }
  }

  /** Reload both maps from Mongo. Called on boot and after every admin write. */
  async refresh(): Promise<void> {
    const generation = ++this.loadStarted;
    const [plans, costs] = await Promise.all([
      this.planModel.find().lean().exec(),
      this.endpointCostModel.find().lean().exec(),
    ]);
    const planMap = new Map<string, CachedPlan>();
    for (const p of plans) {
      planMap.set(p.key, {
        key: p.key,
        name: p.name,
        monthlyUnits: p.monthlyUnits,
        rateLimitPerMin: p.rateLimitPerMin,
        price: p.price,
        enabled: p.enabled,
        // A field-by-field copy, not a spread — anything added to `Plan` must be
        // added here too or it reads back `undefined` from `getPlan()`.
        // `.lean()` does NOT apply schema defaults, so rows written before these
        // fields existed arrive without them: normalize FAIL-CLOSED (no public
        // listing, tightest key ceiling, no browser keys) until the backfill
        // migration runs.
        selfServe: p.selfServe ?? false,
        maxApiKeys: p.maxApiKeys ?? 1,
        allowBrowserKeys: p.allowBrowserKeys ?? false,
        description: p.description ?? '',
        features: p.features ?? [],
        prices: p.prices ?? [],
      });
    }
    const costMap = new Map<string, { label: string; unitCost: number }>();
    for (const c of costs) {
      // `.lean()` applies no defaults, so a row written before `label` existed
      // arrives without one — an empty string here, resolved against the
      // published ladder by `getEndpointLabel`.
      costMap.set(c.routeKey, { label: c.label ?? '', unitCost: c.enabled ? c.unitCost : 0 });
    }
    // A load that started later has already applied newer data — keep it.
    if (generation < this.loadApplied) return;
    this.loadApplied = generation;
    this.plans = planMap;
    this.endpointCosts = costMap;
    this.lastLoadedAt = Date.now();
  }

  private maybeRefresh(): void {
    if (this.refreshing) return;
    if (Date.now() - this.lastLoadedAt < REFRESH_TTL_MS) return;
    this.refreshing = this.refresh()
      .catch((err) => this.logger.warn(`Settings cache refresh failed: ${String(err)}`))
      .finally(() => {
        this.refreshing = undefined;
      });
  }

  getPlan(key: string): CachedPlan | undefined {
    this.maybeRefresh();
    return this.plans.get(key);
  }

  /**
   * Pricing-page listing: self-serve, enabled plans with ONLY the fields a
   * prospect may see — no `providerPriceId`, no inactive or $0 prices, no
   * `_id`/`__v`, no `enabled`/`selfServe` flags. This is what lets a public
   * `GET /v1/plans` be served without exporting `PlansService`, whose `list()`
   * returns raw documents verbatim.
   *
   * `enabled` filters here and ONLY here: a retired plan must disappear from
   * the pricing page while the customers already on it keep working (metering
   * never gates on it).
   */
  listPublicPlans(): PublicPlan[] {
    this.maybeRefresh();
    return [...this.plans.values()]
      .filter((plan) => plan.enabled && plan.selfServe)
      // `refresh()` has no `.sort()`, so the map is in Mongo natural order —
      // without this the pricing page shuffles between pods.
      .sort((a, b) => a.price - b.price || a.key.localeCompare(b.key))
      .map((plan) => ({
        key: plan.key,
        name: plan.name,
        description: plan.description,
        monthlyUnits: plan.monthlyUnits,
        rateLimitPerMin: plan.rateLimitPerMin,
        maxApiKeys: plan.maxApiKeys,
        allowBrowserKeys: plan.allowBrowserKeys,
        features: [...plan.features],
        priceUsd: plan.price,
        prices: plan.prices
          // A $0 price is not something anyone checks out — a free tier is
          // granted at signup, so it must not render a "buy" button.
          .filter((price) => price.active && price.unitAmountMinor > 0)
          .map((price) => {
            const out: PublicPlanPrice = {
              id: price.id,
              interval: price.interval,
              intervalCount: price.intervalCount,
              unitAmountMinor: price.unitAmountMinor,
              currency: price.currency,
            };
            if (price.displayNote !== undefined) out.displayNote = price.displayNote;
            return out;
          }),
      }));
  }

  /** Live unit cost for a route, falling back to the decorator default. */
  getEndpointCost(routeKey: string, fallback: number): number {
    this.maybeRefresh();
    const entry = this.endpointCosts.get(routeKey);
    return entry === undefined ? fallback : entry.unitCost;
  }

  /**
   * The operator-facing NAME of a route, for the usage-detail views.
   *
   * Three sources in order, and the order matters: the operator's own
   * `endpoint_costs.label`, then the published ladder, then the route key
   * itself. The middle step is not defensive — `seedIfEmpty` only ever fills an
   * EMPTY collection, so any install whose first boot predates a route key has
   * no row for it and never will, which is the same gap `seedCostFor` closes
   * for the price. Falling through to the key rather than inventing a name
   * keeps a route this build does not publish readable instead of anonymous.
   */
  getEndpointLabel(routeKey: string): string {
    this.maybeRefresh();
    const stored = this.endpointCosts.get(routeKey)?.label;
    if (stored) return stored;
    return SEEDED_LABELS.get(routeKey) ?? routeKey;
  }
}

/**
 * The published ladder's labels, keyed by route. Built from the seed array
 * rather than restated — a second copy of these strings is exactly the drift
 * `seedCostFor` exists to remove on the price side.
 */
const SEEDED_LABELS = new Map(ENDPOINT_COST_SEEDS.map((seed) => [seed.routeKey, seed.label]));

/**
 * True when `err` is a duplicate-key error (E11000) — a single one, or a bulk
 * insert whose EVERY write error is one. Anything else is a real failure.
 */
export function isOnlyDuplicateKeyErrors(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: number; writeErrors?: Array<{ code?: number; err?: { code?: number } }> };
  const writeErrors = Array.isArray(e.writeErrors) ? e.writeErrors : undefined;
  if (writeErrors && writeErrors.length > 0) {
    return writeErrors.every((w) => (w?.code ?? w?.err?.code) === 11000);
  }
  return e.code === 11000;
}
