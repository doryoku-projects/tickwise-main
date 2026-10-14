import type { UnitCost } from '@/lib/site-data';

/**
 * Re-exported, not defined here.
 *
 * It moved to `lib/api.ts` when the landing page needed the same origin: the
 * hero terminal and the quickstart snippet were printing a literal hostname from
 * the reference design, and a second definition is how the docs and the home
 * page end up giving two answers to "what do I call?".
 */
export { QUICKSTART_BASE } from '@/lib/api';

/**
 * The live unit cost of one route, or an honest gap.
 *
 * Read from `GET /v1/pricing/units` via `getPublicUnitCosts()` rather than
 * typed into the page. The meter resolves the same numbers from the same
 * admin-editable table, so a repriced endpoint cannot leave the docs quoting
 * the old figure — which is exactly the drift that once had `/pricing`
 * advertising charts at 10 while the guard charged 1.
 */
export function Units({ costs, routeKey }: { costs: UnitCost[]; routeKey: string }) {
  const row = costs.find((c) => c.routeKey === routeKey);
  if (!row) {
    return <span className="mono">cost unavailable</span>;
  }
  if (row.units === 0) {
    return <span className="mono">free, unmetered</span>;
  }
  return (
    <span className="mono">
      {row.units} {row.units === 1 ? 'unit' : 'units'}
    </span>
  );
}
