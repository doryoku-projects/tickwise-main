import { sqrtRatioX96ToToken1PerToken0 } from './tick-math.js';

// Pure pool-vs-market consistency helpers. Kept in their own module (no NestJS
// deps) so they can be unit-tested AND imported by the read-only diagnostic
// script straight from `dist` — the diagnostic must run the REAL code, not a
// reimplementation (a float reimplementation previously hid a BigInt underflow
// bug in the ratio and produced wrong "all good" conclusions).

// Largest tolerated divergence between a lower-trust leg's external USD price and
// the price implied by the pool (reference price × pool ratio). Arbitraged pools
// track the market within the fee (~1x); a stale aggregator quote (e.g. MAPO 31x
// above its pool, stkGHO ~300x) or an extreme/non-arbitrageable pool diverges far
// more. Aligned with pricing-policy's maxVerifiedDivergence. Env-tunable.
export const MAX_POOL_PRICE_DIVERGENCE = Math.max(1, Number(process.env.MAX_POOL_PRICE_DIVERGENCE) || 5);

/**
 * Trust tier of one pool leg, from the pricing decision:
 * - `anchor`     — config anchor (stable / native / trusted list)
 * - `verified`   — CoinGecko-listed real market (`external-verified`)
 * - `unverified` — has an external quote but no listing (`external-unverified`)
 * - `none`       — no trusted external price (pool-derived-only / missing)
 * - `suspect`    — symbol-spoof scam; never valued, never derived
 */
export type LegTrust = 'anchor' | 'verified' | 'unverified' | 'none' | 'suspect';

const TRUST_RANK: Record<LegTrust, number> = {
  anchor: 3,
  verified: 2,
  unverified: 1,
  none: 0,
  suspect: -1,
};

// A leg qualifies as the consistency REFERENCE only with an independently
// trustworthy market price: a config anchor or a verified (listed) token.
const REFERENCE_MIN_RANK = TRUST_RANK.verified;

/** Numeric rank of a trust tier (anchor=3 … suspect=-1). */
export function trustRank(trust: LegTrust): number {
  return TRUST_RANK[trust] ?? 0;
}

/** True when a priced leg can serve as the pool-consistency reference. */
export function isReferenceLeg(vp: number, trust: LegTrust): boolean {
  return vp > 0 && trustRank(trust) >= REFERENCE_MIN_RANK;
}

export interface PoolConsistencyResult {
  vp0: number;
  vp1: number;
  /** true → the leg's price was replaced by the pool-implied price. */
  derived0: boolean;
  derived1: boolean;
}

/** Pool's token1-per-token0 price ratio (human), or NaN if unusable. */
export function poolRatio(sqrtPriceX96: string, decimals0: number, decimals1: number): number {
  try {
    return sqrtRatioX96ToToken1PerToken0(BigInt(sqrtPriceX96 || '0'), decimals0, decimals1);
  } catch {
    return Number.NaN;
  }
}

/**
 * Per-leg pool-consistency with pool-truth derivation. When one leg is a priced
 * REFERENCE (anchor/verified — a real, independently-priced market) and the
 * other leg ranks strictly lower, the pool's own ratio gives an independent
 * expected price for the lower-trust leg (`reference price × ratio`):
 * - external price within `MAX_POOL_PRICE_DIVERGENCE` of implied → kept;
 * - external price contradicting the pool from ABOVE (stale/garbage aggregator
 *   quote, e.g. stkGHO quoted $47 vs pool-implied $0.148) → REPLACED by the
 *   implied price. Correction is downward-only: on divergence the LOWER of
 *   (external, implied) wins, so the pool can deflate a bogus quote but a
 *   fantasy-ratio pool can never inflate a leg above its real market price —
 *   no absolute price cap needed, and a $1M-per-token blue chip stays intact;
 * - leg with NO external quote at all → stays $0. Derivation only corrects a
 *   real market's mispricing — it never fabricates value for a no-market token
 *   from the pool ratio alone (e.g. AU/USDT: 490k quoteless AU at a fantasy
 *   189-USDT ratio must NOT become a $93M position);
 * - pool gives no usable signal (ratio underflow/≤0) while the external claims
 *   value → that leg is $0 (cannot cross-check — e.g. extreme-tick pools).
 * Equal-trust REFERENCE pairs (anchor/anchor, verified/verified) are left
 * as-is — both sides are real markets and there is no basis to pick a wrong
 * leg. When the pool has NO reference leg at all, an `unverified` leg's quote
 * is UNCORROBORATED → $0: a non-listed token's quotes come from DEX-derived
 * sources circular with its own pools (geckoterminal), so without an
 * anchor/verified counterparty nothing independent backs them (e.g.
 * fwUSDC/fwDAI fake forex, BLOTIX/SAFEMONEY — both legs "quoted", all
 * fabricated). `suspect` (symbol-spoof) legs are always $0 and never derived.
 * `ratio` = token1-per-token0 (human).
 */
export function enforcePoolConsistency(
  vp0: number,
  vp1: number,
  trust0: LegTrust,
  trust1: LegTrust,
  ratio: number,
): PoolConsistencyResult {
  if (trust0 === 'suspect') vp0 = 0;
  if (trust1 === 'suspect') vp1 = 0;
  const rank0 = TRUST_RANK[trust0] ?? 0;
  const rank1 = TRUST_RANK[trust1] ?? 0;
  const reference0 = vp0 > 0 && rank0 >= REFERENCE_MIN_RANK;
  const reference1 = vp1 > 0 && rank1 >= REFERENCE_MIN_RANK;
  // token1 is the reference → implied vp0 = ratio × vp1 (1 token0 = ratio token1).
  if (reference1 && rank0 < rank1 && trust0 !== 'suspect') {
    const { vp, derived } = reconcileLeg(vp0, usableImplied(ratio * vp1));
    return { vp0: vp, vp1, derived0: derived, derived1: false };
  }
  // token0 is the reference → implied vp1 = vp0 / ratio (1 token1 = 1/ratio token0).
  if (reference0 && rank1 < rank0 && trust1 !== 'suspect') {
    const { vp, derived } = reconcileLeg(vp1, usableImplied(vp0 / ratio));
    return { vp0, vp1: vp, derived0: false, derived1: derived };
  }
  // No reference leg in the pool → an unverified leg's quote has no independent
  // corroboration (circular DEX-derived quotes price these tokens off their own
  // pools) → contributes $0. Verified/anchor legs are never zeroed here.
  if (!reference0 && !reference1) {
    const z0 = trust0 === 'unverified' && vp0 > 0;
    const z1 = trust1 === 'unverified' && vp1 > 0;
    if (z0 || z1) return { vp0: z0 ? 0 : vp0, vp1: z1 ? 0 : vp1, derived0: false, derived1: false };
  }
  return { vp0, vp1, derived0: false, derived1: false };
}

/**
 * Pool-truth price for a QUOTELESS leg (no external market quote anywhere),
 * gated by economic realizability: the derivation is believed only when what it
 * would claim for THIS position (`legAmount × implied`) is actually backed by
 * the pool's reference-side reserves (`refBackingUsd` = reference-token
 * reserves × its trusted price). You can never extract more from a pool than
 * the other side really holds — so a seeded fantasy pool derives nothing
 * (490k AU at an implied $189 against $11k of real USDT → $0), while a
 * modest position in a genuinely-backed pool gets the pool-implied price.
 * Returns the implied price, or 0 when unbacked/unusable.
 */
export function deriveQuotelessLeg(
  implied: number,
  legAmount: number,
  refBackingUsd: number,
): number {
  if (!Number.isFinite(implied) || implied <= 0) return 0;
  if (!Number.isFinite(refBackingUsd) || refBackingUsd <= 0) return 0;
  if (!Number.isFinite(legAmount) || legAmount < 0) return 0;
  return legAmount * implied <= refBackingUsd ? implied : 0;
}

/**
 * Economic-realizability check for a PRICED lower-trust candidate leg: zero it
 * when the value this position claims (`claimAmount × vp`) exceeds the pool's
 * real reference-side backing (`refBackingUsd` = reference-token reserves ×
 * its trusted price). The quote itself may be genuine — a launch-style LP
 * holding 1B PNKSTR (the full supply) at a real $0.0076 quote still "claims"
 * $7.6M against ~$517k of actual ETH in the pool; the position can never
 * realize it. Balanced two-sided pools pass naturally (each side's reserves
 * are commensurate with positions in them); single-sided full-supply spam
 * fails. Returns the kept price, or 0 when unbacked.
 */
export function enforceRealizability(vp: number, claimAmount: number, refBackingUsd: number): number {
  if (!(vp > 0)) return vp;
  if (!Number.isFinite(refBackingUsd) || refBackingUsd <= 0) return 0;
  if (!Number.isFinite(claimAmount) || claimAmount < 0) return 0;
  return claimAmount * vp <= refBackingUsd ? vp : 0;
}

/**
 * Pool MARKET-EXISTENCE floor for a priced lower-trust leg (provider-independent,
 * no value cap). Distinct from `enforceRealizability` (which is per-position:
 * `claim × price ≤ backing`, and zeroed RPC's huge claim too — why the
 * market-value pivot retired it from the headline). This checks only that the
 * pool holds SOME real reference-side market: `refBackingUsd` (reference-token
 * reserves × its trusted price) ≥ `floorUsd`. A seeded fantasy pool (USDC/GPCG
 * holds ~$25 of real USDC) fails; a genuinely-backed pool (USDC/RPC ~$11k,
 * DHN/USDT ~$11.6k, Knicks/ETH ~$67k) passes and keeps its FULL market value —
 * the floor is on the POOL's reserves (does a market exist), never on the
 * position's value. `floorUsd ≤ 0` disables the gate. A non-finite/negative
 * backing (reserves unknown/corrupt) fails CLOSED for a lower-trust leg — an
 * outage must not flip a seeded leg from $0 to a fabricated headline.
 */
export function meetsMarketBackingFloor(refBackingUsd: number, floorUsd: number): boolean {
  if (!(floorUsd > 0)) return true;
  return Number.isFinite(refBackingUsd) && refBackingUsd >= floorUsd;
}

/** Pool-implied price, or NaN when the pool gives no usable signal. */
function usableImplied(implied: number): number {
  return Number.isFinite(implied) && implied > 0 ? implied : Number.NaN;
}

/**
 * Reconcile a lower-trust leg's external price against the pool-implied price:
 * keep it when consistent, correct it DOWNWARD to the implied price when the
 * quote is inflated vs the pool, and drop it when the pool can't corroborate a
 * claimed value. A leg with no external quote stays $0 — the pool ratio alone
 * never creates value, and a divergence never raises a price above its real
 * market quote (downward-only correction needs no absolute price cap).
 */
function reconcileLeg(external: number, implied: number): { vp: number; derived: boolean } {
  // No real market for this leg → nothing to correct; never fabricate from the
  // pool ratio alone (a seeded fantasy-ratio pool would mint value from thin air).
  if (!(external > 0)) return { vp: 0, derived: false };
  if (Number.isNaN(implied)) {
    // External claims value but the pool gives no usable signal → max divergence.
    return { vp: 0, derived: false };
  }
  const divergence = Math.max(external, implied) / Math.min(external, implied);
  if (divergence > MAX_POOL_PRICE_DIVERGENCE) {
    // Lower side wins: deflate a bogus quote to pool-truth, but never inflate a
    // leg above its external market price off a fantasy pool ratio.
    return implied < external ? { vp: implied, derived: true } : { vp: external, derived: false };
  }
  return { vp: external, derived: false };
}

export interface AllowlistedPairInput {
  vp0: number;
  vp1: number;
  trust0: LegTrust;
  trust1: LegTrust;
  /** token1-per-token0 (human), NaN when unusable. */
  ratio: number;
  /** ≥ 2 independent sources agree on the leg's quote. */
  corroborated0: boolean;
  corroborated1: boolean;
  /** The backing floor applies to open positions only (a dead pool corroborates nothing). */
  open: boolean;
  /** Reference-side reserves; undefined = unknown or corrupt (floor not applied). */
  reserve0?: number;
  reserve1?: number;
  floorUsd: number;
}

export interface AllowlistedPairResult {
  vp0: number;
  vp1: number;
  derived0: boolean;
  derived1: boolean;
  unrealizable0: boolean;
  unrealizable1: boolean;
}

/**
 * The cross-check two ALLOWLISTED legs (`verified`/`verified`, neither a
 * config anchor) skip in `enforcePoolConsistency`: each leg whose quote is
 * SINGLE-SOURCE is checked against the other leg through the pool —
 *
 *  1. pool ratio: when the two quotes diverge from the pool by more than
 *     `MAX_POOL_PRICE_DIVERGENCE`, the single-source leg that sits ABOVE its
 *     pool-implied price is lowered to it (downward only: a pool ratio never
 *     raises a quote). A pool with no usable ratio cannot corroborate a
 *     single-source leg: $0.
 *  2. backing floor (open positions, known reserves): a single-source leg is
 *     $0 (`unrealizable`) when the OTHER leg's reserves × price is below
 *     `floorUsd` — the same market-existence floor a lower-trust leg meets.
 *
 * A corroborated leg, and every pair that is not two allowlisted legs, is
 * returned unchanged.
 */
export function crossCheckAllowlistedPair(input: AllowlistedPairInput): AllowlistedPairResult {
  let { vp0, vp1 } = input;
  const out: AllowlistedPairResult = { vp0, vp1, derived0: false, derived1: false, unrealizable0: false, unrealizable1: false };
  if (input.trust0 !== 'verified' || input.trust1 !== 'verified') return out;
  const single0 = !input.corroborated0 && vp0 > 0;
  const single1 = !input.corroborated1 && vp1 > 0;
  if (!single0 && !single1) return out;
  const ratio = input.ratio;
  if (vp0 > 0 && vp1 > 0) {
    if (!Number.isFinite(ratio) || ratio <= 0) {
      if (single0) vp0 = 0;
      if (single1) vp1 = 0;
    } else {
      const implied0 = ratio * vp1;
      const implied1 = vp0 / ratio;
      if (single0 && Number.isFinite(implied0) && implied0 > 0 && vp0 / implied0 > MAX_POOL_PRICE_DIVERGENCE) {
        vp0 = implied0;
        out.derived0 = true;
      } else if (single1 && Number.isFinite(implied1) && implied1 > 0 && vp1 / implied1 > MAX_POOL_PRICE_DIVERGENCE) {
        vp1 = implied1;
        out.derived1 = true;
      }
    }
  }
  if (input.open && input.floorUsd > 0) {
    // Both backings from the ratio-checked prices, before either leg is zeroed.
    const backing0 = input.reserve1 === undefined ? undefined : Math.max(0, input.reserve1) * vp1;
    const backing1 = input.reserve0 === undefined ? undefined : Math.max(0, input.reserve0) * vp0;
    if (single0 && vp0 > 0 && backing0 !== undefined && !meetsMarketBackingFloor(backing0, input.floorUsd)) {
      vp0 = 0;
      out.derived0 = false;
      out.unrealizable0 = true;
    }
    if (single1 && vp1 > 0 && backing1 !== undefined && !meetsMarketBackingFloor(backing1, input.floorUsd)) {
      vp1 = 0;
      out.derived1 = false;
      out.unrealizable1 = true;
    }
  }
  out.vp0 = vp0;
  out.vp1 = vp1;
  return out;
}
