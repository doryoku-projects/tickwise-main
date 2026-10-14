import { describe, expect, it } from 'vitest';
import type { PriceResult, PricingService } from '../src/pricing/pricing.service.js';
import { positionAmountsAtPrice } from '../src/pricing/tick-math.js';
import { EnvioAdapter } from '../src/subgraph/adapters/envio.adapter.js';
import type { IntegrationConfig } from '../src/config/integrations.config.js';
import type { NormalizedPosition } from '../src/subgraph/normalized-position.js';

// MARKET-VALUE display (product decision — see envio.adapter.ts):
// pooled assets show quantity × consistency-checked market price, NOT the
// realizable $0. The USDC/RPC spam-pool position (NFT 133302) — an open
// single-sided LP holding 1e9 RPC at a real ~$0.0098 quote against ~10,576 USDC
// of pool backing — therefore VALUES at ~$9.8M (Krystal/Etherscan-style), and
// `unrealizableLeg` is a non-fatal informational flag. These specs pin that the
// VALUE keeps the market quote, while the ANTI-FABRICATION gates still hold:
// a leg with no external market stays $0, and the pools-leaderboard TVL gate
// (evaluatePoolTvl) still flags the pool risky.

const INTEGRATION: IntegrationConfig = {
  chainId: 1,
  protocol: 'uniswap-v4',
  enabled: true,
  subgraphUrl: 'https://example.com/subgraph',
};

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'; // config anchor
const RPC = '0xed025a9fe4b30bcd68460bca42583090c2266468'; // spam token (not allowlisted)
const POOL_ID = '0xd8442c1d563ba9b7dc1bba16430f6f999c0f8dd26914ca757d43ce88d416ebc7';

// token1-per-token0 ratio ≈ 80 (matching decimals) → pool-implied RPC price
// = 1/80 = $0.0125; the $0.0098 quote diverges only 1.3x → kept by consistency.
const SQRT_80_X96 = String(BigInt(Math.round(Math.sqrt(80) * 2 ** 48)) << 48n);

function fakePricing(prices: PriceResult): PricingService {
  return {
    pricePool: async () => prices,
    prefetchPrices: async () => undefined,
    positionAmounts: positionAmountsAtPrice,
  } as unknown as PricingService;
}

function makeMaps(stats: Record<string, unknown> | undefined) {
  const pools = new Map([
    [POOL_ID, {
      id: POOL_ID,
      name: 'USDC/RPC',
      fee: 3000,
      tickSpacing: 60,
      tick: 43820,
      sqrtPriceX96: SQRT_80_X96,
      token0Id: USDC,
      token1Id: RPC,
    }],
  ]);
  const tokens = new Map([
    [USDC, { id: USDC, symbol: 'USDC', name: 'USD Coin', decimals: 18, verified: true }],
    [RPC, { id: RPC, symbol: 'RPC', name: 'RPC', decimals: 18, verified: false }],
  ]);
  const poolStats = new Map(stats ? [[POOL_ID, { id: POOL_ID, ...stats }]] : []);
  return { pools, tokens, poolStats };
}

function rawPosition(overrides: Record<string, unknown> = {}) {
  return {
    chainId: 1,
    tokenId: '133302',
    owner: '0x1234567890abcdef1234567890abcdef12345678',
    poolId: POOL_ID,
    tickLower: -23040,
    tickUpper: 43200,
    // The pool's tick (43820) is above tickUpper, so the position is single-sided
    // in token1 — exactly the 1e9-RPC position these specs are about. `liquidity`
    // is the value that YIELDS that: getAmountsForLiquidity(sqrt(80)·2^96, -23040,
    // 43200, L) = {0, 1e27} at 18 decimals. It has to be self-consistent now that
    // normalize computes the amounts from pool state instead of reading
    // `amount0`/`amount1` (nothing re-prices those columns any more); the old
    // placeholder `123456789` described ~1e-11 RPC, not 1e9.
    liquidity: '119700572005730204538986275',
    isActive: true,
    isPriceable: true,
    createdAtTimestamp: '1768000000',
    createdAtBlockNumber: '21000000',
    closedAtTimestamp: null,
    depositedToken0: 0,
    depositedToken1: 1_000_000_000,
    withdrawnToken0: 0,
    withdrawnToken1: 0,
    totalFeesCollected0: 0,
    totalFeesCollected1: 0,
    amount0: 0,
    amount1: 1_000_000_000,
    totalGasCostETH: 0.0001,
    updatedAtBlock: '21000001',
    updatedAtTimestamp: '1768000001',
    ...overrides,
  };
}

const SPAM_POOL_PRICES: PriceResult = {
  token0Usd: 0.9998,
  token1Usd: 0.0098,
  source: 'orchestrated' as PriceResult['source'],
  usedFallback: false,
  token0Confidence: 'anchor',
  token1Confidence: 'external-unverified',
};

const TICKMATH = { positionAmountsSource: 'tickmath' };

async function normalize(
  prices: PriceResult,
  raw: Record<string, unknown>,
  stats: Record<string, unknown> | undefined,
  config: Record<string, unknown> = {},
): Promise<NormalizedPosition> {
  const adapter = new EnvioAdapter(
    fakePricing(prices),
    { findByIds: async () => [] } as never,
    { minRealMarketBackingUsd: 1000, ...config } as never,
  );
  const { pools, tokens, poolStats } = makeMaps(stats);
  return (adapter as unknown as {
    normalize: (
      raw: Record<string, unknown>,
      integration: IntegrationConfig,
      pools: Map<string, unknown>,
      tokens: Map<string, unknown>,
      poolStats: Map<string, unknown>,
    ) => Promise<NormalizedPosition>;
  }).normalize(raw, INTEGRATION, pools, tokens, poolStats);
}

describe('ponder normalize — spam-pool market-value (USDC/RPC class)', () => {
  const LIVE_STATS = {
    totalValueLockedUSD: '9858057.39', // subgraph derivedETH headline (≈ market)
    totalValueLockedUSDUntracked: '0',
    totalValueLockedToken0: '10576.6', // REAL USDC backing
    totalValueLockedToken1: '1000925588.8',
    volumeUSD: '221975.94',
    feesUSD: '665.92',
  };

  it('values the leg at its MARKET quote (1e9 RPC × $0.0098 ≈ $9.8M), flagged unrealizable', async () => {
    const pos = await normalize(SPAM_POOL_PRICES, rawPosition(), LIVE_STATS);

    // Market value: the quote is KEPT even though the claim exceeds backing.
    expect(pos.token1.priceUsd).toBeCloseTo(0.0098, 6);
    expect(pos.metrics.underlyingValueUsd).toBeCloseTo(1_000_000_000 * 0.0098, 0);
    // Priceable + a real source; nominal == underlying under market-value.
    expect(pos.metrics.isPriceable).toBe(true);
    expect(pos.pricing.source).not.toBe('none');
    expect(pos.pricing.usedFallback).toBe(false);
    expect(pos.metrics.nominalValueUsd).toBeCloseTo(pos.metrics.underlyingValueUsd, 6);
    // Realizability survives as an INFORMATIONAL flag (claim ≫ backing), not a
    // value override.
    expect(pos.metrics.unrealizableLeg).toBe(true);
  });

  it('Layer 1: a seeded pool with thin reference-side backing (GPCG-class: $24.84) zeroes the priced lower-trust leg', async () => {
    // Same shape as the legit USDC/RPC pool, but the pool holds only $24.84 of
    // real USDC (USDC/GPCG live: 24.84 USDC) — below MIN_REAL_MARKET_BACKING_USD
    // ($1000). No real reference-side market backs the leg → $0, no fabricated
    // headline, regardless of how many providers quoted the token.
    const thinStats = { ...LIVE_STATS, totalValueLockedToken0: '24.84' };
    const pos = await normalize(SPAM_POOL_PRICES, rawPosition(), thinStats);

    expect(pos.token1.priceUsd).toBe(0);
    expect(pos.metrics.underlyingValueUsd).toBe(0);
    expect(pos.metrics.unrealizableLeg).toBe(true);
    // The held leg can't be valued → priceUnavailable (not a misleading market $).
    expect(pos.metrics.isPriceable).toBe(false);
    expect(pos.metrics.priceUnavailable).toBe(true);
  });

  it('Layer 1: a DEEP-backed pool (USDC/RPC: ~$10.6k) keeps the full market value', async () => {
    // The exact contrast to the GPCG-class case: same token, same quote, but
    // $10,576 of real USDC backing (≥ floor) → the leg keeps its market value.
    const pos = await normalize(SPAM_POOL_PRICES, rawPosition(), LIVE_STATS);
    expect(pos.token1.priceUsd).toBeCloseTo(0.0098, 6);
    expect(pos.metrics.underlyingValueUsd).toBeCloseTo(1_000_000_000 * 0.0098, 0);
  });

  it('keeps the market quote when reserves are UNKNOWN (no realizability pend)', async () => {
    const statsWithoutReserves = { totalValueLockedUSD: '9858057.39' };
    const pos = await normalize(SPAM_POOL_PRICES, rawPosition(), statsWithoutReserves);

    expect(pos.token1.priceUsd).toBeCloseTo(0.0098, 6);
    expect(pos.metrics.underlyingValueUsd).toBeCloseTo(1_000_000_000 * 0.0098, 0);
    expect(pos.metrics.isPriceable).toBe(true);
    // No reserves → the realizability flag can't be evaluated → false.
    expect(pos.metrics.unrealizableLeg).toBe(false);
  });

  it('keeps the market quote with NO stats row at all (pool absent from fetch and cache)', async () => {
    const pos = await normalize(SPAM_POOL_PRICES, rawPosition(), undefined);

    expect(pos.token1.priceUsd).toBeCloseTo(0.0098, 6);
    expect(pos.metrics.underlyingValueUsd).toBeCloseTo(1_000_000_000 * 0.0098, 0);
    expect(pos.metrics.isPriceable).toBe(true);
  });

  it('keeps the market quote on CLOSED positions (recompute values withdrawn at market)', async () => {
    const closed = rawPosition({
      isActive: false,
      liquidity: '0',
      closedAtTimestamp: '1768100000',
      amount0: 0,
      amount1: 0,
      withdrawnToken1: 1_000_000_000,
    });
    const pos = await normalize(SPAM_POOL_PRICES, closed, LIVE_STATS);

    // The stored price is what recompute multiplies with withdrawn/deposited
    // history — under market-value the quote is kept (no closed-leg zeroing).
    expect(pos.token1.priceUsd).toBeCloseTo(0.0098, 6);
    // No CURRENT holdings → current underlying is 0 (value is in withdrawn).
    expect(pos.metrics.underlyingValueUsd).toBe(0);
  });

  it('ANTI-FABRICATION: a leg with NO external market (and no priced reference) stays $0 / priceUnavailable', async () => {
    // Neither leg has a real external quote → no reference leg → nothing to
    // derive against → the held RPC leg cannot be valued. No fabrication.
    const noMarket: PriceResult = {
      token0Usd: 0,
      token1Usd: 0,
      source: 'orchestrated' as PriceResult['source'],
      usedFallback: false,
      token0Confidence: 'missing',
      token1Confidence: 'missing',
    };
    const pos = await normalize(noMarket, rawPosition(), LIVE_STATS);

    expect(pos.token1.priceUsd).toBe(0);
    expect(pos.metrics.underlyingValueUsd).toBe(0);
    expect(pos.metrics.isPriceable).toBe(false);
    expect(pos.metrics.priceUnavailable).toBe(true);
  });

  /*
   * With POSITION_AMOUNTS_SOURCE=tickmath normalize() computes amount0/1 from the pool's
   * current price instead of reading the indexer's columns (nothing re-prices those). The ONE
   * exception is a position the indexer marked unpriceable — a pool pinned at the
   * tick/price domain edge, where the same tick math returns physically impossible
   * amounts. The indexer stores 0 there; recomputing would put the astronomical
   * figure back into `amounts.amount0/1`, which are served on detail and feed the
   * per-leg confidence inputs, even though the valuation guard rejects the position.
   */
  it('does NOT recompute amounts for an unpriceable (degenerate-pool) position', async () => {
    const pos = await normalize(
      SPAM_POOL_PRICES,
      rawPosition({ isPriceable: false, amount0: 0, amount1: 0 }),
      LIVE_STATS,
      TICKMATH,
    );
    expect(pos.amounts.amount0).toBe('0');
    expect(pos.amounts.amount1).toBe('0');
    expect(pos.metrics.isPriceable).toBe(false);
    expect(pos.metrics.underlyingValueUsd).toBe(0);
  });

  it('POSITION_AMOUNTS_SOURCE=tickmath recomputes amounts for a priceable position (the indexer column is only a fallback)', async () => {
    // Same row, but with the indexer's amounts deliberately stale/wrong: the computed
    // value must win, not the stored one.
    const pos = await normalize(SPAM_POOL_PRICES, rawPosition({ amount0: 777, amount1: 777 }), LIVE_STATS, TICKMATH);
    expect(Number(pos.amounts.amount0)).toBe(0); // out of range above ⇒ all token1
    expect(Number(pos.amounts.amount1)).toBeCloseTo(1_000_000_000, 0);
  });

  it('pools-leaderboard TVL gate still flags the pool risky (untrusted leg dominates)', async () => {
    const pos = await normalize(SPAM_POOL_PRICES, rawPosition(), LIVE_STATS);

    // evaluatePoolTvl is UNCHANGED: RPC (external-unverified) is untrusted for
    // TVL and its ~$9.8M dwarfs the ~$10.6k trusted USDC side → materially
    // fabricated → risky → tvlUsd 0. The pools leaderboard stays curated even
    // though the POSITION shows market value. (The position-detail UI shows the
    // charts/live TVL, not this gated field.)
    expect(pos.poolStats.tvlUsd).toBe(0);
    // volume/fees stay as reported (display-only).
    expect(pos.poolStats.volumeUsd).toBeCloseTo(221975.94, 2);
  });
});
