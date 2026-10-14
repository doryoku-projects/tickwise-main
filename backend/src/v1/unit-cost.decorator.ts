import { SetMetadata } from '@nestjs/common';

export const UNIT_COST_KEY = 'v1:unitCost';

export interface UnitCostMeta {
  routeKey: string;
  /**
   * Almost always ABSENT, and that is the correct state. See the decorator.
   */
  fallback?: number;
}

/**
 * Tags a `/v1` route with its stable route key.
 *
 * The guard resolves the live cost from the admin-editable settings cache by
 * `routeKey`, and when no DB row exists it falls back to the PUBLISHED LADDER
 * via `seedCostFor(routeKey)` — not to a number written here.
 *
 * `fallback` therefore has NO DEFAULT any more and should stay unused. It
 * previously defaulted to 1, and every call site passed 1 explicitly, so on an
 * install whose `endpoint_costs` collection predates a route key (seeds only
 * fill an EMPTY collection) the meter charged 1 for a route the pricing page
 * published at 10. Pass it only for a route deliberately absent from
 * `ENDPOINT_COST_SEEDS`, and expect a reviewer to ask why.
 */
export const UnitCost = (routeKey: string, fallback?: number) =>
  SetMetadata(UNIT_COST_KEY, { routeKey, fallback } satisfies UnitCostMeta);
