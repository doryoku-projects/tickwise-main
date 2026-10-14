import { describe, expect, it } from 'vitest';
import { PricingService, type PriceResult } from '../src/pricing/pricing.service.js';
import { RevertCompatibleAdapter } from '../src/subgraph/adapters/revert-compatible.adapter.js';
import type { IntegrationConfig } from '../src/config/integrations.config.js';
import { assessValuation } from '../src/valuation/valuation-guard.js';
import { deriveQuotelessLeg, enforcePoolConsistency, enforceRealizability, meetsMarketBackingFloor, poolRatio } from '../src/pricing/pool-consistency.js';

const INTEGRATION: IntegrationConfig = {
  chainId: 1,
  protocol: 'uniswap-v4',
  enabled: true,
  subgraphUrl: 'https://example.com/subgraph',
};

function fakePricing(options: {
  prices: PriceResult;
  amount0: number;
  amount1: number;
}): PricingService {
  return {
    pricePool: async () => options.prices,
    historicalPricePool: async () => options.prices,
    positionAmounts: () => ({ amount0: options.amount0, amount1: options.amount1 }),
    prefetchPrices: async () => undefined,
  } as unknown as PricingService;
}

function rawPosition(overrides: Record<string, unknown> = {}) {
  return {
    id: '1',
    tokenId: '1',
    owner: '0xowner',
    liquidity: '1000000',
    isActive: true,
    isPriceable: true,
    tickLower: '-100',
    tickUpper: '100',
    createdAtTimestamp: '1700000000',
    depositedToken0: '0',
    depositedToken1: '0',
    withdrawnToken0: '0',
    withdrawnToken1: '0',
    totalFeesCollected0: '0',
    totalFeesCollected1: '0',
    totalFeesUncollected0: '0',
    totalFeesUncollected1: '0',
    currentValueUSD: '999999999',
    tvlUSD: '999999999',
    pool: {
      id: '0xpool',
      fee: 3000,
      tickSpacing: 60,
      tick: 0,
      sqrtPriceX96: '79228162514264337593543950336',
      totalValueLockedUSD: '1000000',
      totalValueLockedUSDUntracked: '1000000',
      volumeUSD: '5000000',
      totalFeesUSD: '50000',
      priceDivergence: '0',
      token0: {
        id: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        symbol: 'USDC',
        decimals: '6',
        verified: true,
      },
      token1: {
        id: '0xdac17f958d2ee523a2206206994597c13d831ec7',
        symbol: 'USDT',
        decimals: '6',
        verified: true,
      },
    },
    ...overrides,
  };
}

async function normalize(pricing: PricingService, raw: Record<string, unknown>) {
  const adapter = new RevertCompatibleAdapter(pricing);
  return (adapter as unknown as {
    normalize: (rawPosition: Record<string, unknown>, integration: IntegrationConfig) => Promise<unknown>;
  }).normalize(raw, INTEGRATION) as Promise<{
    metrics: {
      underlyingValueUsd: number;
      apr: number;
      roi: number;
      pnlUsd: number;
      pendingFeesUsd: number;
      collectedFeesUsd: number;
      totalFeesUsd: number;
      investedUsd: number;
      isPriceable: boolean;
      performanceReady: boolean;
      performanceSource: string;
    };
    pricing: { source: string; usedFallback: boolean };
  }>;
}

describe('valuation guard', () => {
  // The 1.25× pool-TVL ceiling and material-value-with-zero-TVL rejection
  // were removed because v4 pools with untracked tokens report a
  // heavily-undercounted `tvlUsd`, falsely rejecting legitimate positions
  // (see commit context: USDC/RPC position with real $9.3M value vs $19k
  // tracked TVL). The orchestrator-side pricing fixes are now the only line
  // of defence; if both held tokens have a positive priceUsd, the computed
  // value is trusted.

  it('accepts a position whose computed value exceeds the tracked pool TVL when both sides are priced', () => {
    expect(assessValuation({
      underlyingValueUsd: 9_300_000,
      poolTvlUsd: 18_999,
      poolTvlUsdUntracked: 9_499,
      poolVolumeUsd: 277_087,
      poolTotalFeesUsd: 289,
      hasPriceSource: true,
      subgraphPriceable: true,
    })).toEqual({ accepted: true });
  });

  it('accepts material values even when reported pool TVL is zero (untracked-token v4 pools)', () => {
    expect(assessValuation({
      underlyingValueUsd: 755_000,
      poolTvlUsd: 0,
      poolTvlUsdUntracked: 0,
      poolVolumeUsd: 0,
      poolTotalFeesUsd: 0,
      hasPriceSource: true,
      subgraphPriceable: true,
    })).toEqual({ accepted: true });
  });

  it('rejects when our pricing orchestrator could not source any price', () => {
    expect(assessValuation({
      underlyingValueUsd: 0,
      poolTvlUsd: 1_000_000,
      poolTvlUsdUntracked: 1_000_000,
      poolVolumeUsd: 5_000_000,
      poolTotalFeesUsd: 50_000,
      hasPriceSource: false,
      subgraphPriceable: true,
    })).toEqual({ accepted: false, reason: 'missing-price-source' });
  });

  it('rejects when subgraph explicitly marks the position unpriceable', () => {
    expect(assessValuation({
      underlyingValueUsd: 250_000,
      poolTvlUsd: 1_000_000,
      poolTvlUsdUntracked: 1_000_000,
      poolVolumeUsd: 5_000_000,
      poolTotalFeesUsd: 50_000,
      hasPriceSource: true,
      subgraphPriceable: false,
    })).toEqual({ accepted: false, reason: 'subgraph-unpriceable' });
  });

  it('accepts position values within a healthy pool TVL envelope', () => {
    expect(assessValuation({
      underlyingValueUsd: 100_000,
      poolTvlUsd: 1_000_000,
      poolTvlUsdUntracked: 1_000_000,
      poolVolumeUsd: 5_000_000,
      poolTotalFeesUsd: 50_000,
      hasPriceSource: true,
      subgraphPriceable: true,
    })).toEqual({ accepted: true });
  });

  it('computes pooled assets from token amounts and keeps performance pending before transaction sync', async () => {
    const position = await normalize(
      fakePricing({
        prices: { token0Usd: 1, token1Usd: 1, source: 'stable-anchor', usedFallback: false },
        amount0: 12_500,
        amount1: 7_500,
      }),
      rawPosition({
        tokenId: '267264',
        currentValueUSD: '999999999',
        apr: '42.5',
        feeAPR: '12.25',
        roi: '7.75',
        pnlUSD: '1550',
        pnlHODL: '1400',
        investedUSD: '18450',
        totalFeesUSD: '300',
      }),
    );

    expect(position.metrics).toMatchObject({
      underlyingValueUsd: 20_000,
      apr: 0,
      feeApr: 0,
      roi: 0,
      pnlUsd: 0,
      pnlHodl: 0,
      investedUsd: 0,
      totalFeesUsd: 0,
      isPriceable: true,
      performanceReady: false,
      performanceSource: 'pending-transactions',
    });
    expect(position.pricing).toMatchObject({ source: 'stable-anchor', usedFallback: false });
  });

  it('computes value from priced amounts even when subgraph reports zero pool TVL (v4 untracked-token case)', async () => {
    // Previously the guard rejected this scenario as `material-value-with-zero-pool-tvl`.
    // For v4 pools containing tokens the subgraph does not track, `tvlUsd` is
    // structurally undercounted; our orchestrator-priced amounts × USD give
    // the truth, so we now trust them.
    const position = await normalize(
      fakePricing({
        prices: { token0Usd: 1, token1Usd: 0.4275, source: 'external', usedFallback: false },
        amount0: 0,
        amount1: 1_768_067,
      }),
      rawPosition({
        currentValueUSD: '755000',
        pool: {
          ...(rawPosition().pool as Record<string, unknown>),
          totalValueLockedUSD: '0',
          totalValueLockedUSDUntracked: '0',
          volumeUSD: '0',
          totalFeesUSD: '0',
          token0: {
            id: '0xdac17f958d2ee523a2206206994597c13d831ec7',
            symbol: 'USDT',
            decimals: '6',
            verified: true,
          },
          token1: {
            id: '0xddf7d080c82b8048baae54e376a3406572429b4e',
            symbol: 'KNC',
            decimals: '18',
            verified: true,
          },
        },
      }),
    );

    // value = 0 * 1 + 1_768_067 * 0.4275 = 755,848.6425
    expect(position.metrics.underlyingValueUsd).toBeCloseTo(755_848.6425, 1);
    expect(position.metrics.isPriceable).toBe(true);
    expect(position.pricing).toMatchObject({ source: 'external', usedFallback: false });
  });

  it('does not use raw USD fallback when price APIs return no usable price', async () => {
    const position = await normalize(
      fakePricing({
        prices: { token0Usd: 0, token1Usd: 0, source: 'none', usedFallback: false },
        amount0: 0,
        amount1: 0,
      }),
      rawPosition({ currentValueUSD: '2500000', tvlUSD: '2500000' }),
    );

    expect(position.metrics.underlyingValueUsd).toBe(0);
    expect(position.metrics.isPriceable).toBe(false);
    expect(position.pricing).toMatchObject({ source: 'none', usedFallback: true });
  });

  it('marks positions unpriceable when the reference implementation marks the position unpriceable', async () => {
    const position = await normalize(
      fakePricing({
        prices: { token0Usd: 1, token1Usd: 0, source: 'stable-anchor', usedFallback: false },
        amount0: 0,
        amount1: 250_000,
      }),
      rawPosition({
        isPriceable: false,
        currentValueUSD: '250000',
        tvlUSD: '250000',
      }),
    );

    expect(position.metrics.underlyingValueUsd).toBe(0);
    expect(position.metrics.isPriceable).toBe(false);
    expect(position.pricing).toMatchObject({ source: 'none', usedFallback: true });
  });

  it('rejects when per-token confidence is suspect/weak (confidence-aware gating)', () => {
    expect(assessValuation({
      underlyingValueUsd: 50_000,
      poolTvlUsd: 1_000_000,
      poolTvlUsdUntracked: 1_000_000,
      poolVolumeUsd: 5_000_000,
      poolTotalFeesUsd: 50_000,
      hasPriceSource: true,
      subgraphPriceable: true,
      token0Confidence: 'anchor',
      token1Confidence: 'pool-derived-weak',
    })).toEqual({ accepted: false, reason: 'low-confidence-token1:pool-derived-weak' });
  });

  it('rejects (pends) when a circular-quoted leg could not be realizability-checked', () => {
    // USDC/RPC during a live-stats outage: the only check on the unverified
    // quote is realizability, and reserves are unknown → PEND, don't accept.
    expect(assessValuation({
      underlyingValueUsd: 9_838_968,
      poolTvlUsd: 0,
      poolTvlUsdUntracked: 0,
      poolVolumeUsd: 221_975,
      poolTotalFeesUsd: 665,
      hasPriceSource: true,
      subgraphPriceable: true,
      token0Confidence: 'anchor',
      token1Confidence: 'external-unverified',
      reservesPending: true,
    })).toEqual({ accepted: false, reason: 'pending-reserves' });
  });

  it('accepts when both confidence labels are strong', () => {
    expect(assessValuation({
      underlyingValueUsd: 50_000,
      poolTvlUsd: 1_000_000,
      poolTvlUsdUntracked: 1_000_000,
      poolVolumeUsd: 5_000_000,
      poolTotalFeesUsd: 50_000,
      hasPriceSource: true,
      subgraphPriceable: true,
      token0Confidence: 'external-verified',
      token1Confidence: 'pool-derived-strong',
    })).toEqual({ accepted: true });
  });

  const base = {
    poolTvlUsd: 1_000_000,
    poolTvlUsdUntracked: 1_000_000,
    poolVolumeUsd: 5_000_000,
    poolTotalFeesUsd: 50_000,
    hasPriceSource: true,
    subgraphPriceable: true,
  };

  it('does NOT cap large well-priced positions (no absolute value ceiling)', () => {
    // Trust model is "real external market + pool consistency", not a magic
    // dollar ceiling — a legitimately large, consistent position is never hidden.
    expect(assessValuation({ ...base, underlyingValueUsd: 11_000_000 })).toEqual({ accepted: true });
    expect(assessValuation({ ...base, underlyingValueUsd: 5_000_000_000 })).toEqual({ accepted: true });
  });

  it('keeps stablecoin-only positions priceable in healthy pools', async () => {
    const position = await normalize(
      fakePricing({
        prices: { token0Usd: 1, token1Usd: 1, source: 'stable-anchor', usedFallback: false },
        amount0: 12_500,
        amount1: 7_500,
      }),
      rawPosition({ currentValueUSD: '20000' }),
    );

    expect(position.metrics.underlyingValueUsd).toBe(20_000);
    expect(position.metrics.isPriceable).toBe(true);
    expect(position.pricing).toMatchObject({ source: 'stable-anchor', usedFallback: false });
  });
});

describe('enforcePoolConsistency (trust-tiered pool-truth per leg)', () => {
  // Args: (vp0, vp1, trust0, trust1, ratio=token1-per-token0). Against a priced
  // REFERENCE leg (anchor/verified), a strictly-lower-trust leg is kept when
  // within MAX_POOL_PRICE_DIVERGENCE of the pool-implied price and corrected
  // DOWNWARD to the implied price when its quote is inflated vs the pool. The
  // pool ratio alone never creates value: no quote → $0, and an implied price
  // above the market quote is never adopted.

  it('replaces a stale lower-trust price with the pool-implied price (MAPO/USDT 31x)', () => {
    // MAPO(unverified) $0.000953 vs pool-implied $0.0000305 (USDT anchor × ratio) = 31x
    // → MAPO leg becomes the pool-truth price, not $0.
    expect(enforcePoolConsistency(0.000953, 1, 'unverified', 'anchor', 0.0000305))
      .toEqual({ vp0: 0.0000305, vp1: 1, derived0: true, derived1: false });
  });

  it('replaces a garbage aggregator quote on a verified-stable pair (stkGHO/GHO)', () => {
    // GHO(verified, $1) is the reference; stkGHO(unverified) quoted $47 by an
    // aggregator vs pool-implied 0.148361 × $1 → ~317x divergence → stkGHO leg
    // is DERIVED to pool-truth $0.148361 (the fix for the $60M-fees inflation).
    const result = enforcePoolConsistency(47, 1, 'unverified', 'verified', 0.148361);
    expect(result.vp0).toBeCloseTo(0.148361, 6);
    expect(result).toMatchObject({ vp1: 1, derived0: true, derived1: false });
  });

  it('never fabricates value for a leg with no external market (AU/USDT-class)', () => {
    // token0 has no quote anywhere → the pool ratio alone must NOT mint a price
    // (real case: 490k quoteless AU at a fantasy 189-USDT ratio ⇒ $93M from thin air).
    expect(enforcePoolConsistency(0, 1, 'none', 'anchor', 189.83))
      .toEqual({ vp0: 0, vp1: 1, derived0: false, derived1: false });
  });

  it('checks a verified leg against an anchor reference (anchor outranks verified)', () => {
    const result = enforcePoolConsistency(47, 1, 'verified', 'anchor', 0.148361);
    expect(result.vp0).toBeCloseTo(0.148361, 6);
    expect(result.derived0).toBe(true);
  });

  it('keeps both legs when consistent (BTC.b/WBTC ~1:1)', () => {
    // WBTC(anchor) $63500, BTC.b(unverified) $63700, ratio 0.9986 → implied BTC.b $63589, ~1.0x.
    expect(enforcePoolConsistency(63_500, 63_700, 'anchor', 'unverified', 0.9986))
      .toEqual({ vp0: 63_500, vp1: 63_700, derived0: false, derived1: false });
  });

  it('keeps a consistent anchor-paired long-tail token (PRISM/ETH ~1.05x)', () => {
    // ETH(anchor) $1687, PRISM(unverified) $891, ratio 1.804 → implied PRISM $935, ~1.05x.
    expect(enforcePoolConsistency(1687, 891, 'anchor', 'unverified', 1.804))
      .toEqual({ vp0: 1687, vp1: 891, derived0: false, derived1: false });
  });

  it('zeroes uncorroborated unverified quotes when the pool has no reference leg', () => {
    // unverified/unverified (fwUSDC/fwDAI, BLOTIX/SAFEMONEY class): a non-listed
    // token's quotes are circular DEX-derived; without an anchor/verified
    // counterparty nothing corroborates them → both legs $0.
    expect(enforcePoolConsistency(1.28, 1.2, 'unverified', 'unverified', 0.0001))
      .toEqual({ vp0: 0, vp1: 0, derived0: false, derived1: false });
    expect(enforcePoolConsistency(41.35, 2.17, 'unverified', 'unverified', 5.4275))
      .toEqual({ vp0: 0, vp1: 0, derived0: false, derived1: false });
  });

  it('does NOT cross-check equal-trust reference pairs', () => {
    // verified/verified at a divergent ratio: both are real listed markets →
    // equal trust, can't pick the wrong leg; left as-is.
    expect(enforcePoolConsistency(47, 1, 'verified', 'verified', 0.148361))
      .toEqual({ vp0: 47, vp1: 1, derived0: false, derived1: false });
  });

  it('keeps a verified leg even when its counterparty is unpriced (real listing survives)', () => {
    // token0 verified and priced, token1 has nothing: no candidate to check, no
    // uncorroborated quote to drop — the verified leg keeps its market price.
    expect(enforcePoolConsistency(63_500, 0, 'verified', 'none', 0.9986))
      .toEqual({ vp0: 63_500, vp1: 0, derived0: false, derived1: false });
  });

  it('never values or derives a suspect (symbol-spoof) leg', () => {
    expect(enforcePoolConsistency(0, 1, 'suspect', 'anchor', 0.5))
      .toEqual({ vp0: 0, vp1: 1, derived0: false, derived1: false });
    // Even a priced suspect leg is forced to $0 — spoofs never gain value.
    expect(enforcePoolConsistency(5, 1, 'suspect', 'anchor', 0.5))
      .toEqual({ vp0: 0, vp1: 1, derived0: false, derived1: false });
  });

  it('zeroes the lower-trust leg when the pool gives no usable signal', () => {
    // ratio 0 (e.g. BigInt underflow) → cannot cross-check OR derive while the
    // external claims value → drop it (do NOT silently keep an inflated price).
    expect(enforcePoolConsistency(0.000823, 1, 'unverified', 'anchor', 0))
      .toEqual({ vp0: 0, vp1: 1, derived0: false, derived1: false });
    expect(enforcePoolConsistency(1, 0.000823, 'anchor', 'unverified', Number.NaN))
      .toEqual({ vp0: 1, vp1: 0, derived0: false, derived1: false });
    // No reference counterparty AND no pool signal → unverified quotes are
    // uncorroborated → both $0.
    expect(enforcePoolConsistency(1.28, 1.2, 'unverified', 'unverified', Number.NaN))
      .toEqual({ vp0: 0, vp1: 0, derived0: false, derived1: false });
    // Reference leg itself unpriced (transient anchor miss) → no reference →
    // the unverified quote is uncorroborated this cycle → $0.
    expect(enforcePoolConsistency(0.000823, 0, 'unverified', 'anchor', 0))
      .toEqual({ vp0: 0, vp1: 0, derived0: false, derived1: false });
  });

  it('corrects downward only — a fantasy pool ratio never inflates a leg above its market quote', () => {
    // Pool implies token0 = $100 but its real market quote is $1 (100x divergent):
    // the LOWER side wins → keep the $1 market price, never adopt the inflated implied.
    expect(enforcePoolConsistency(1, 1, 'unverified', 'anchor', 100))
      .toEqual({ vp0: 1, vp1: 1, derived0: false, derived1: false });
    // No absolute price cap: a legit ultra-high-priced token consistent with its
    // pool is untouched (e.g. a $1M/token blue chip vs an anchor reference).
    expect(enforcePoolConsistency(1_000_000, 1, 'unverified', 'anchor', 1_050_000))
      .toEqual({ vp0: 1_000_000, vp1: 1, derived0: false, derived1: false });
  });

  it('enforceRealizability: zeroes a PRICED lower-trust leg whose claim exceeds real backing', () => {
    // Real ETH/PNKSTR launch LP: 1B PNKSTR (full supply) at a genuine $0.0076
    // quote claims $7.6M against 318 ETH ≈ $517k actually in the pool → $0.
    expect(enforceRealizability(0.0076, 1_000_000_000, 517_000)).toBe(0);
    // Balanced pool: claim within reference-side reserves → quote kept.
    expect(enforceRealizability(61_163, 50, 4_900_000_000)).toBe(61_163);
    // Known-thin/negative-accounting reference side (mUSD/USDC: USDC reserves
    // negative → clamped 0 upstream) → claimed value unbacked → $0.
    expect(enforceRealizability(0.9997, 5_000_077, 0)).toBe(0);
    // Unpriced leg passes through untouched.
    expect(enforceRealizability(0, 1_000, 0)).toBe(0);
  });

  it('deriveQuotelessLeg: prices a quoteless leg only when really backed by reference reserves', () => {
    // Real AU/USDT numbers: 490k AU at implied $189.68 claims $93M against only
    // $11.2k of real USDT in the pool → unbacked → $0.
    expect(deriveQuotelessLeg(189.68, 490_000, 11_217)).toBe(0);
    // Modest position in a genuinely-backed pool (e.g. $3.29M USDT reserves):
    // 10k tokens at implied $0.50 claims $5k ≤ $3.29M → derived.
    expect(deriveQuotelessLeg(0.5, 10_000, 3_290_000)).toBe(0.5);
    // Exact boundary is allowed; just past it is not.
    expect(deriveQuotelessLeg(1, 1_000, 1_000)).toBe(1);
    expect(deriveQuotelessLeg(1, 1_001, 1_000)).toBe(0);
    // No real backing / unusable implied → never derive.
    expect(deriveQuotelessLeg(0.5, 10, 0)).toBe(0);
    expect(deriveQuotelessLeg(0.5, 10, -5)).toBe(0); // negative subgraph accounting
    expect(deriveQuotelessLeg(0, 10, 1_000)).toBe(0);
    expect(deriveQuotelessLeg(Number.NaN, 10, 1_000)).toBe(0);
  });

  it('derives the worthless leg to pool-truth for the real PORT3/USDT pool (end-to-end with poolRatio)', () => {
    // Real PORT3/USDT sqrtPriceX96. poolRatio must NOT underflow to 0 (the bug);
    // PORT3's $0.000823 quote contradicts the pool by many orders of magnitude →
    // replaced by the (near-zero) pool-implied price.
    const ratio = poolRatio('12828914291496', 18, 6); // PORT3(18) / USDT(6)
    expect(ratio).toBeGreaterThan(0);
    expect(enforcePoolConsistency(0.000823, 1, 'unverified', 'anchor', ratio))
      .toEqual({ vp0: ratio, vp1: 1, derived0: true, derived1: false });
  });
});

describe('meetsMarketBackingFloor (Layer 1 — pool market-existence)', () => {
  // Floor on the POOL's reference-side reserves (does a market exist), NOT on the
  // position's value. Probed live 2026-06-17: GPCG/USDC $24.84, USDC/RPC $11,048,
  // DHN/USDT $11,579, Knicks/ETH $67,464. A $1000 floor separates them cleanly.
  it('passes a genuinely-backed pool (≥ floor)', () => {
    expect(meetsMarketBackingFloor(11_048, 1000)).toBe(true); // USDC/RPC
    expect(meetsMarketBackingFloor(67_464, 1000)).toBe(true); // Knicks/ETH
  });
  it('fails a seeded fantasy pool (< floor)', () => {
    expect(meetsMarketBackingFloor(24.84, 1000)).toBe(false); // USDC/GPCG
    expect(meetsMarketBackingFloor(0, 1000)).toBe(false);
  });
  it('fails CLOSED on unknown/corrupt backing (non-finite/negative)', () => {
    expect(meetsMarketBackingFloor(Number.NaN, 1000)).toBe(false);
    expect(meetsMarketBackingFloor(-5, 1000)).toBe(false);
  });
  it('is disabled (always true) when the floor is 0 or negative', () => {
    expect(meetsMarketBackingFloor(0, 0)).toBe(true);
    expect(meetsMarketBackingFloor(24.84, 0)).toBe(true);
    expect(meetsMarketBackingFloor(Number.NaN, 0)).toBe(true);
  });
});
