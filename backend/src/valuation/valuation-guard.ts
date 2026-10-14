// Retained for back-compat with any external import (e.g. leaderboard query
// helpers that referenced these constants historically). Neither constant is
// applied as a hard clamp anymore — see commit history for the rationale.
// Both pool-TVL ceiling and the material-value-with-zero-tvl rejection were
// safety nets against bogus upstream pricing; with the orchestrator-side
// fixes (anchored pool-ratio math, derived-cache invalidation) they now
// cause more false negatives than they catch — especially for v4 pools
// containing untracked tokens, where `tvlUsd` reflects only the tracked
// side and falsely undercuts real position values.
export const MAX_POSITION_POOL_TVL_RATIO = 1.25;
export const MIN_MATERIAL_VALUE_USD = 500;

/**
 * Confidence labels accepted on `ValuationInput`. Mirror the
 * `PriceConfidence` union exported from `pricing.service` so callers can
 * pass through pricing-decision metadata without re-mapping. Optional —
 * absence means "no per-token confidence available" and the guard falls
 * back to the legacy boolean checks.
 */
export type ValuationConfidence =
  | 'anchor'
  | 'external-verified'
  | 'external-unverified'
  | 'pool-derived-strong'
  | 'pool-derived-weak'
  | 'last-known-strong'
  | 'last-known-weak'
  | 'missing'
  | 'suspect';

export interface ValuationInput {
  underlyingValueUsd: number;
  poolTvlUsd: number;
  poolTvlUsdUntracked: number;
  poolVolumeUsd: number;
  poolTotalFeesUsd: number;
  hasPriceSource: boolean;
  subgraphPriceable: boolean;
  /** Optional per-token confidence labels — when present, drive richer gating. */
  token0Confidence?: ValuationConfidence;
  token1Confidence?: ValuationConfidence;
  /**
   * True → a lower-trust priced leg could not be realizability-checked because
   * the pool's reserves are unknown (live stats outage AND no cached pool row).
   * Such a leg's only quote is circular (DEX-derived), so the valuation must
   * PEND — neither accept a possibly self-minted value nor store a wrong $0.
   */
  reservesPending?: boolean;
}

export interface ValuationResult {
  accepted: boolean;
  reason?: string;
}

const REJECTED_CONFIDENCES: ReadonlySet<ValuationConfidence> = new Set([
  'pool-derived-weak',
  'last-known-weak',
  'suspect',
  'missing',
]);

export function assessValuation(input: ValuationInput): ValuationResult {
  if (!input.hasPriceSource) return { accepted: false, reason: 'missing-price-source' };
  if (!input.subgraphPriceable) return { accepted: false, reason: 'subgraph-unpriceable' };
  if (input.reservesPending) return { accepted: false, reason: 'pending-reserves' };

  // Pool-vs-market consistency is enforced per-leg upstream (the adapter zeroes a
  // leg whose external price contradicts the pool), so a position reaching here
  // is valued only from trusted, pool-consistent legs — no off-market reject or
  // value ceiling needed.

  // Confidence-aware gating only fires when caller wires it through —
  // legacy callers don't pass the fields and behaviour is unchanged.
  if (input.token0Confidence && REJECTED_CONFIDENCES.has(input.token0Confidence)) {
    return { accepted: false, reason: `low-confidence-token0:${input.token0Confidence}` };
  }
  if (input.token1Confidence && REJECTED_CONFIDENCES.has(input.token1Confidence)) {
    return { accepted: false, reason: `low-confidence-token1:${input.token1Confidence}` };
  }

  return { accepted: true };
}
