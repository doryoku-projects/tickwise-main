export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const Q96 = 2n ** 96n;
const Q32 = 2n ** 32n;
const UINT256_MAX = (1n << 256n) - 1n;

const RATIOS: readonly bigint[] = [
  0xfffcb933bd6fad37aa2d162d1a594001n,
  0xfff97272373d413259a46990580e213an,
  0xfff2e50f5f656932ef12357cf3c7fdccn,
  0xffe5caca7e10e4e61c3624eaa0941cd0n,
  0xffcb9843d60f6159c9db58835c926644n,
  0xff973b41fa98c081472e6896dfb254c0n,
  0xff2ea16466c96a3843ec78b326b52861n,
  0xfe5dee046a99a2a811c461f1969c3053n,
  0xfcbe86c7900a88aedcffc83b479aa3a4n,
  0xf987a7253ac413176f2b074cf7815e54n,
  0xf3392b0822b70005940c7a398e4b70f3n,
  0xe7159475a2c29b7443b29c7fa6e889d9n,
  0xd097f3bdfd2022b8845ad8f792aa5825n,
  0xa9f746462d870fdf8a65dc1f90e061e5n,
  0x70d869a156d2a1b890bb3df62baf32f7n,
  0x31be135f97d08fd981231505542fcfa6n,
  0x9aa508b5b7a84e1c677de54f3e99bc9n,
  0x5d6af8dedb81196699c329225ee604n,
  0x2216e584f5fa1ea926041bedfe98n,
  0x48a170391f7dc42444e8fa2n,
];

export function getSqrtRatioAtTick(tick: number): bigint {
  if (!Number.isInteger(tick)) throw new Error(`tick must be an integer: ${tick}`);
  if (tick < MIN_TICK || tick > MAX_TICK) {
    throw new Error(`tick ${tick} out of range`);
  }

  const absTick = BigInt(Math.abs(tick));
  let ratio = (absTick & 0x1n) !== 0n
    ? RATIOS[0]
    : 0x100000000000000000000000000000000n;

  for (let i = 1; i < RATIOS.length; i++) {
    if ((absTick & (1n << BigInt(i))) !== 0n) {
      ratio = (ratio * RATIOS[i]) >> 128n;
    }
  }

  if (tick > 0) ratio = UINT256_MAX / ratio;
  return (ratio >> 32n) + (ratio % Q32 === 0n ? 0n : 1n);
}

function order(a: bigint, b: bigint): [bigint, bigint] {
  return a <= b ? [a, b] : [b, a];
}

export function getAmount0Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  const [lo, hi] = order(sqrtA, sqrtB);
  if (lo <= 0n) return 0n;
  return ((liquidity << 96n) * (hi - lo)) / hi / lo;
}

export function getAmount1Delta(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  const [lo, hi] = order(sqrtA, sqrtB);
  return (liquidity * (hi - lo)) / Q96;
}

export function getAmountsForLiquidity(
  sqrtCurrent: bigint,
  tickLower: number,
  tickUpper: number,
  liquidity: bigint,
): { amount0: bigint; amount1: bigint } {
  if (tickLower >= tickUpper || liquidity <= 0n) return { amount0: 0n, amount1: 0n };

  const sqrtLower = getSqrtRatioAtTick(tickLower);
  const sqrtUpper = getSqrtRatioAtTick(tickUpper);

  if (sqrtCurrent <= sqrtLower) {
    return { amount0: getAmount0Delta(sqrtLower, sqrtUpper, liquidity), amount1: 0n };
  }
  if (sqrtCurrent < sqrtUpper) {
    return {
      amount0: getAmount0Delta(sqrtCurrent, sqrtUpper, liquidity),
      amount1: getAmount1Delta(sqrtLower, sqrtCurrent, liquidity),
    };
  }
  return { amount0: 0n, amount1: getAmount1Delta(sqrtLower, sqrtUpper, liquidity) };
}

export function sqrtRatioX96ToToken1PerToken0(
  sqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number,
): number {
  if (sqrtPriceX96 <= 0n) return 0;
  // Float computation. The previous BigInt form `(sqrt^2 * 1e18) / 2^192` floors
  // to 0 whenever the numerator < 2^192 — i.e. for extreme-low-price pools (e.g.
  // PORT3/USDT) — which silently returns ratio 0 and breaks every ratio-based
  // consumer (pool-consistency guard, pool-ratio override). Float preserves a
  // tiny-but-finite ratio across the full sqrt range (~1e-63 … 1e56) at ~15
  // significant digits, which is ample for price comparisons. For normal pools
  // this returns the same value as before (tick-0 → 1, decimals 6/18 → 1e-12).
  const base = Number(sqrtPriceX96) / Number(Q96);
  const ratio = base * base * Math.pow(10, decimals0 - decimals1);
  return Number.isFinite(ratio) ? ratio : 0;
}

/**
 * A position's in-pool token amounts at a pool price, in HUMAN units.
 *
 * Pure, and deliberately not a `PricingService` method: it needs no prices, no
 * config and no I/O, only the position's own ticks plus the pool's current price.
 * Both position adapters can call it at normalize time instead of reading an amount
 * column (`POSITION_AMOUNTS_SOURCE=tickmath`; the default `indexer` still serves the
 * column). No indexer re-prices that column between the position's own liquidity
 * events — the sweep that used to is gone — so a stored pair can describe a price
 * that is weeks old. `PricingService.positionAmounts` delegates here.
 *
 * `sqrtPriceX96` wins over `currentTick` when both are given (it is the exact
 * price; the tick is its floor). Returns null when neither yields a usable price or
 * the liquidity is not a valid integer — the caller then keeps whatever it had.
 */
export function positionAmountsAtPrice(input: {
  liquidity: string;
  tickLower: number;
  tickUpper: number;
  sqrtPriceX96?: string | null;
  currentTick?: number | null;
  decimals0: number;
  decimals1: number;
}): { amount0: number; amount1: number } | null {
  let liquidity: bigint;
  try {
    liquidity = BigInt(input.liquidity || '0');
  } catch {
    return null;
  }

  let sqrt: bigint | null = null;
  try {
    if (input.sqrtPriceX96) sqrt = BigInt(input.sqrtPriceX96);
  } catch {
    sqrt = null;
  }
  if (!sqrt && input.currentTick != null && Number.isFinite(input.currentTick)) {
    try {
      sqrt = getSqrtRatioAtTick(Math.trunc(input.currentTick));
    } catch {
      sqrt = null;
    }
  }
  if (!sqrt) return null;

  const { amount0, amount1 } = getAmountsForLiquidity(sqrt, input.tickLower, input.tickUpper, liquidity);
  return {
    amount0: Number(amount0) / Math.pow(10, input.decimals0),
    amount1: Number(amount1) / Math.pow(10, input.decimals1),
  };
}
