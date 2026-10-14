/**
 * Bump when shipping a pricing-logic fix that needs to invalidate already-priced
 * historical rows. The recompute self-heal re-prices any stored txn tagged with
 * a derived source AND whose `lastSyncedAt` predates this cutoff; `lastSyncedAt`
 * is rewritten on every reprice, so the heal converges to zero after every
 * touched position has cycled through recompute once.
 */
export const PRICING_LOGIC_REVISION_AT = new Date('2026-05-27T00:00:00Z');

/**
 * Historical price sources considered derived state — i.e. computed downstream
 * from another quote rather than fetched directly from an external pricing
 * provider. Rows tagged with one of these are eligible for retroactive heal,
 * and Mongo cache reads ignore them so the orchestrator re-validates through
 * external providers.
 */
export const DERIVED_HISTORICAL_SOURCES = ['subgraph-pool-ratio'] as const;

export type DerivedHistoricalSource = (typeof DERIVED_HISTORICAL_SOURCES)[number];

export function isDerivedHistoricalSource(source: string | undefined): boolean {
  return typeof source === 'string' && (DERIVED_HISTORICAL_SOURCES as readonly string[]).includes(source);
}
