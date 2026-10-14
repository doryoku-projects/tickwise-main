/**
 * Stable route keys shared by the `@UnitCost(routeKey, fallback)` decorators
 * and the seeded `endpoint_costs` rows. The metering guard resolves the live
 * cost from the DB-backed settings cache by this key, falling back to the
 * decorator's value when no row exists.
 */
export const ROUTE_KEYS = {
  positionsList: 'v1.positions.list',
  positionsDetail: 'v1.positions.detail',
  positionsCharts: 'v1.positions.charts',
  poolsList: 'v1.pools.list',
  poolsDetail: 'v1.pools.detail',
  poolsCharts: 'v1.pools.charts',
  chains: 'v1.chains',
  protocols: 'v1.protocols',
} as const;

export interface SeedEndpointCost {
  routeKey: string;
  label: string;
  unitCost: number;
  enabled: boolean;
}

/**
 * The published cost ladder. `/pricing` sells "a request is not a request:
 * endpoints cost different numbers of units, and metadata is free", so a flat
 * 1-unit-per-route table contradicted the page it is rendered on.
 *
 * The tiers are cost-weighted by what the request actually costs us to serve:
 *   METADATA (0) — a static in-process registry read, no Mongo, no fan-out.
 *   DETAIL   (1) — one indexed lookup on one shard.
 *   LIST     (2) — a sorted, filtered page: a scatter-gather across every
 *                  enabled shard plus grouped count aggregations, so it is
 *                  strictly more work than a detail read and must not be the
 *                  cheapest way to bulk-export the dataset.
 *   CHARTS  (10) — a multi-query fan-out to the paid Graph key with per-range
 *                  series assembly; by far the most expensive route we serve,
 *                  and the only one whose upstream we pay per call for.
 */
export const UNIT_COST_TIERS = {
  metadata: 0,
  detail: 1,
  list: 2,
  charts: 10,
} as const;

/**
 * First-boot endpoint costs, and the reconciliation source of truth.
 *
 * `SettingsCacheService.seedIfEmpty` inserts these ONLY when `endpoint_costs`
 * is empty, so on an install that predates a route this list is the ONLY record
 * that the route should have a row at all. `scripts/billing-subscriptions-migration.mjs`
 * reads this array to INSERT missing route keys into an existing collection
 * (never overwriting a cost an operator set) and, behind `--reprice-endpoints`,
 * to bring already-priced rows back onto the ladder.
 */
export const ENDPOINT_COST_SEEDS: SeedEndpointCost[] = [
  { routeKey: ROUTE_KEYS.positionsList, label: 'List positions', unitCost: UNIT_COST_TIERS.list, enabled: true },
  { routeKey: ROUTE_KEYS.positionsDetail, label: 'Position detail', unitCost: UNIT_COST_TIERS.detail, enabled: true },
  { routeKey: ROUTE_KEYS.positionsCharts, label: 'Position charts', unitCost: UNIT_COST_TIERS.charts, enabled: true },
  { routeKey: ROUTE_KEYS.poolsList, label: 'List pools', unitCost: UNIT_COST_TIERS.list, enabled: true },
  { routeKey: ROUTE_KEYS.poolsDetail, label: 'Pool detail', unitCost: UNIT_COST_TIERS.detail, enabled: true },
  { routeKey: ROUTE_KEYS.poolsCharts, label: 'Pool charts', unitCost: UNIT_COST_TIERS.charts, enabled: true },
  { routeKey: ROUTE_KEYS.chains, label: 'List chains (metadata)', unitCost: UNIT_COST_TIERS.metadata, enabled: true },
  { routeKey: ROUTE_KEYS.protocols, label: 'List protocols (metadata)', unitCost: UNIT_COST_TIERS.metadata, enabled: true },
];

/**
 * Built from the array above rather than written out again — a second copy of
 * these numbers is precisely the drift `seedCostFor` exists to remove.
 */
const SEEDED_COSTS = new Map(ENDPOINT_COST_SEEDS.map((seed) => [seed.routeKey, seed.unitCost]));

/**
 * THE ONE FALLBACK LOOKUP: what a route costs when `endpoint_costs` has no row
 * for it.
 *
 * That is not hypothetical. `SettingsCacheService.seedIfEmpty` inserts the seeds
 * ONLY into an EMPTY collection, so every install that first booted before a
 * route key existed has no row for that key and never will — silently, with no
 * error anywhere.
 *
 * Before this function, the fallback was a literal `1` written into each
 * `@UnitCost(routeKey, 1)` decorator while `V1PlansController` published
 * `seed.unitCost` from the ladder above. On such an install the pricing page
 * therefore ADVERTISED charts at 10 units and the meter CHARGED 1 — a 10x
 * undercharge on the most expensive route we serve, the only one whose upstream
 * (the paid Graph key) we pay per call for.
 *
 * Both readers come through here now, so the published price and the charged
 * price cannot disagree. A key that is not in the ladder falls to `fallback`
 * (1): that is a route missing from the published pricing table, which is a
 * review defect rather than a pricing decision, and 1 is the historical
 * behaviour rather than a fresh guess.
 */
export function seedCostFor(routeKey: string, fallback = 1): number {
  const seeded = SEEDED_COSTS.get(routeKey);
  return seeded === undefined ? fallback : seeded;
}
