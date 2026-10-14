// Floating-point Uniswap tick math, specialised for CHART series (not indexing).
// The exact integer port lives in the indexer core (amounts.ts/math.ts) and is
// used where on-chain-exact amounts matter. Here we only need approximate
// amounts to draw a PnL/assets curve, so float is faster and simpler — and the
// final point is normalised to the position's real current state anyway.
//
// All `*Raw` quantities are in raw token base units (human × 10^decimals) and
// `liquidity` is raw L. sqrt prices are the RAW ratio sqrt(raw1/raw0) =
// 1.0001^(tick/2), so the formulas below are decimal-agnostic — callers convert
// to human units by dividing by 10^decimals.

const TICK_BASE = 1.0001;

export function sqrtPriceAtTick(tick: number): number {
  return Math.pow(TICK_BASE, tick / 2);
}

export interface RawAmounts {
  amount0Raw: number;
  amount1Raw: number;
}

/** Token amounts (raw) held by `liquidity` over [tickLower,tickUpper] at `tick`. */
export function amountsForLiquidity(
  liquidity: number,
  tick: number,
  tickLower: number,
  tickUpper: number,
): RawAmounts {
  if (!Number.isFinite(liquidity) || liquidity <= 0) return { amount0Raw: 0, amount1Raw: 0 };
  const sqrtP = sqrtPriceAtTick(tick);
  const sqrtPa = sqrtPriceAtTick(tickLower);
  const sqrtPb = sqrtPriceAtTick(tickUpper);
  if (sqrtPb <= sqrtPa) return { amount0Raw: 0, amount1Raw: 0 };

  if (tick < tickLower) {
    // Entirely token0 (price below range).
    return { amount0Raw: liquidity * (1 / sqrtPa - 1 / sqrtPb), amount1Raw: 0 };
  }
  if (tick >= tickUpper) {
    // Entirely token1 (price above range).
    return { amount0Raw: 0, amount1Raw: liquidity * (sqrtPb - sqrtPa) };
  }
  // In range — split.
  return {
    amount0Raw: liquidity * (1 / sqrtP - 1 / sqrtPb),
    amount1Raw: liquidity * (sqrtP - sqrtPa),
  };
}

/** Inverse: raw liquidity implied by depositing/withdrawing (amount0Raw,amount1Raw) at `tick`. */
export function liquidityForAmounts(
  tick: number,
  tickLower: number,
  tickUpper: number,
  amount0Raw: number,
  amount1Raw: number,
): number {
  const sqrtP = sqrtPriceAtTick(tick);
  const sqrtPa = sqrtPriceAtTick(tickLower);
  const sqrtPb = sqrtPriceAtTick(tickUpper);
  if (sqrtPb <= sqrtPa) return 0;

  if (tick <= tickLower) {
    // Below range → only token0 funds it.
    return safe(amount0Raw * ((sqrtPa * sqrtPb) / (sqrtPb - sqrtPa)));
  }
  if (tick >= tickUpper) {
    // Above range → only token1 funds it.
    return safe(amount1Raw / (sqrtPb - sqrtPa));
  }
  // In range → the binding side (min) sets the liquidity.
  const l0 = amount0Raw > 0 ? amount0Raw * ((sqrtP * sqrtPb) / (sqrtPb - sqrtP)) : Infinity;
  const l1 = amount1Raw > 0 ? amount1Raw / (sqrtP - sqrtPa) : Infinity;
  const l = Math.min(l0, l1);
  return Number.isFinite(l) ? safe(l) : 0;
}

function safe(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Raw token amounts locked in a single tick bin [tickIdx, tickIdx+spacing] by
 * `liquidity` — for the liquidity-distribution histogram tooltip. `amount0Raw`
 * is what the bin holds when price is BELOW it (entirely token0); `amount1Raw`
 * is what it holds when price is ABOVE it (entirely token1). Callers pick the
 * side by the bin's position relative to the current tick.
 */
export function tickLockedAmounts(
  liquidity: number,
  tickIdx: number,
  tickSpacing: number,
): RawAmounts {
  if (!Number.isFinite(liquidity) || liquidity <= 0 || tickSpacing <= 0) {
    return { amount0Raw: 0, amount1Raw: 0 };
  }
  const sqrtA = sqrtPriceAtTick(tickIdx);
  const sqrtB = sqrtPriceAtTick(tickIdx + tickSpacing);
  if (sqrtB <= sqrtA) return { amount0Raw: 0, amount1Raw: 0 };
  return {
    amount0Raw: liquidity * (1 / sqrtA - 1 / sqrtB),
    amount1Raw: liquidity * (sqrtB - sqrtA),
  };
}
