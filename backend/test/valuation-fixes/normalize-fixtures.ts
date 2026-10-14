/*
 * Fixtures for the valuation-fixes specs: one EnvioAdapter `normalize` call per
 * case, with a fake pricing decision, an indexer pool/token/stats triple and a
 * raw indexer position. The cases cover every branch of the position-path
 * valuation the valuation flags can touch (pool consistency, the backing floor,
 * quoteless derivation, closed rows, corrupt reserves, honeypot and dynamic
 * fees, frozen indexer amounts, two allowlisted legs with a single-source quote).
 */
import type { PriceResult, PricingService } from '../../src/pricing/pricing.service.js';
import { PricingService as RealPricingService } from '../../src/pricing/pricing.service.js';
import { getSqrtRatioAtTick } from '../../src/pricing/tick-math.js';
import { EnvioAdapter } from '../../src/subgraph/adapters/envio.adapter.js';
import type { IntegrationConfig } from '../../src/config/integrations.config.js';
import type { NormalizedPosition } from '../../src/subgraph/normalized-position.js';

export const INTEGRATION: IntegrationConfig = {
  chainId: 1,
  protocol: 'uniswap-v4',
  enabled: true,
  subgraphUrl: 'https://example.com/subgraph',
};

/** A fixed clock: `ageSeconds` and `pricedAt` read `Date.now()`. */
export const FIXED_NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const RPC = '0xed025a9fe4b30bcd68460bca42583090c2266468';
const AERGO = '0x91af0fbb28aba7e31403cb457106ce79397fd4e6';
const HPP = '0x0000000000000000000000000000000000004890';
const BTCB = '0xb0f70c0bd6fd87dbeb7c10dc692a2a6106817072';
const CBBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf';
const QUOTELESS = '0x1111111111111111111111111111111111111111';

export interface NormalizeCase {
  name: string;
  prices: PriceResult;
  pool: { id: string; fee: number; tick: number; sqrtPriceX96?: string; token0Id: string; token1Id: string };
  tokens: Array<{ id: string; symbol: string; decimals: number; verified: boolean }>;
  stats?: Record<string, unknown>;
  raw: Record<string, unknown>;
}

function sqrtAt(tick: number): string {
  return getSqrtRatioAtTick(tick).toString();
}

function raw(over: Record<string, unknown>): Record<string, unknown> {
  return {
    chainId: 1,
    tokenId: '1',
    owner: '0x1234567890abcdef1234567890abcdef12345678',
    tickLower: -600,
    tickUpper: 600,
    liquidity: '1000000000000000000',
    isActive: true,
    isPriceable: true,
    createdAtTimestamp: '1768000000',
    createdAtBlockNumber: '21000000',
    closedAtTimestamp: null,
    depositedToken0: 1,
    depositedToken1: 1,
    withdrawnToken0: 0,
    withdrawnToken1: 0,
    totalFeesCollected0: 0.01,
    totalFeesCollected1: 0.02,
    amount0: 1,
    amount1: 1,
    totalGasCostETH: 0.0001,
    lastModifyBlock: '21000001',
    updatedAtBlock: '21000001',
    updatedAtTimestamp: '1768000001',
    ...over,
  };
}

const prices = (over: Partial<PriceResult>): PriceResult => ({
  token0Usd: 1,
  token1Usd: 1,
  source: 'external',
  usedFallback: false,
  token0Confidence: 'external-verified',
  token1Confidence: 'external-verified',
  ...over,
});

const pid = (n: number) => `0x${n.toString(16).padStart(64, '0')}`;

export const NORMALIZE_CASES: NormalizeCase[] = [
  {
    name: 'anchor / unverified, backed pool (USDC/RPC market value)',
    prices: prices({ token0Usd: 0.9998, token1Usd: 0.0098, token0Confidence: 'anchor', token1Confidence: 'external-unverified' }),
    pool: { id: pid(1), fee: 3000, tick: 43820, token0Id: USDC, token1Id: RPC },
    tokens: [
      { id: USDC, symbol: 'USDC', decimals: 6, verified: true },
      { id: RPC, symbol: 'RPC', decimals: 18, verified: false },
    ],
    stats: { totalValueLockedToken0: 10_576, totalValueLockedToken1: 1_100_000_000, totalValueLockedUSD: 9_860_000, volumeUSD: 1000, feesUSD: 3 },
    raw: raw({ tokenId: '133302', tickLower: -23040, tickUpper: 43200, amount0: 0, amount1: 1_000_000_000, depositedToken0: 0, depositedToken1: 1_000_000_000 }),
  },
  {
    name: 'anchor / unverified, seeded pool under the backing floor',
    prices: prices({ token0Usd: 1, token1Usd: 0.5, token0Confidence: 'anchor', token1Confidence: 'external-unverified' }),
    pool: { id: pid(2), fee: 10_000, tick: 6931, token0Id: USDC, token1Id: RPC },
    tokens: [
      { id: USDC, symbol: 'USDC', decimals: 6, verified: true },
      { id: RPC, symbol: 'GPCG', decimals: 18, verified: false },
    ],
    stats: { totalValueLockedToken0: 24.84, totalValueLockedToken1: 5_000_000 },
    raw: raw({ tokenId: '2', amount0: 10, amount1: 4_000_000 }),
  },
  {
    name: 'two allowlisted legs, single-source inflated quote, honeypot fee (AERGO/HPP)',
    prices: prices({ token0Usd: 0.0512, token1Usd: 31_374.54 }),
    pool: { id: pid(3), fee: 999_900, tick: 115_000, token0Id: AERGO, token1Id: HPP },
    tokens: [
      { id: AERGO, symbol: 'AERGO', decimals: 18, verified: false },
      { id: HPP, symbol: 'HPP', decimals: 18, verified: false },
    ],
    stats: { totalValueLockedToken0: 0.0418, totalValueLockedToken1: 5200 },
    raw: raw({ tokenId: '366810', tickLower: 100_000, tickUpper: 120_000, amount0: 0.0418, amount1: 4740, depositedToken0: 0.0418, depositedToken1: 5200 }),
  },
  {
    name: 'two allowlisted legs, consistent pool (BTC.b/cbBTC)',
    prices: prices({ token0Usd: 86_300, token1Usd: 86_310 }),
    pool: { id: pid(4), fee: 100, tick: 1, token0Id: BTCB, token1Id: CBBTC },
    tokens: [
      { id: BTCB, symbol: 'BTC.b', decimals: 8, verified: false },
      { id: CBBTC, symbol: 'cbBTC', decimals: 8, verified: true },
    ],
    stats: { totalValueLockedToken0: 54, totalValueLockedToken1: 46 },
    raw: raw({ tokenId: '371154', tickLower: -50, tickUpper: 50, liquidity: '17000000000000', amount0: 53.96, amount1: 46.04, depositedToken0: 53.96, depositedToken1: 46.04 }),
  },
  {
    name: 'anchor / quoteless leg derived from the pool ratio',
    prices: prices({ token0Usd: 3000, token1Usd: 0, token0Confidence: 'anchor', token1Confidence: 'missing', token1Source: 'miss' }),
    pool: { id: pid(5), fee: 3000, tick: -69_078, token0Id: WETH, token1Id: QUOTELESS },
    tokens: [
      { id: WETH, symbol: 'WETH', decimals: 18, verified: true },
      { id: QUOTELESS, symbol: 'NEW', decimals: 18, verified: false },
    ],
    stats: { totalValueLockedToken0: 50, totalValueLockedToken1: 100_000 },
    raw: raw({ tokenId: '5', tickLower: -70_000, tickUpper: -68_000, amount0: 0.2, amount1: 900 }),
  },
  {
    name: 'closed position (indexer amounts kept)',
    prices: prices({ token0Usd: 3000, token1Usd: 1, token0Confidence: 'anchor', token1Confidence: 'anchor' }),
    pool: { id: pid(6), fee: 500, tick: -196_000, token0Id: WETH, token1Id: USDC },
    tokens: [
      { id: WETH, symbol: 'WETH', decimals: 18, verified: true },
      { id: USDC, symbol: 'USDC', decimals: 6, verified: true },
    ],
    stats: { totalValueLockedToken0: 1000, totalValueLockedToken1: 3_000_000 },
    raw: raw({ tokenId: '6', liquidity: '0', isActive: false, closedAtTimestamp: '1769000000', amount0: 0, amount1: 0, withdrawnToken0: 1.2, withdrawnToken1: 3100 }),
  },
  {
    name: 'dynamic-fee pool, open and in range',
    prices: prices({ token0Usd: 3000, token1Usd: 1, token0Confidence: 'anchor', token1Confidence: 'anchor' }),
    pool: { id: pid(7), fee: 0x800000, tick: -196_000, token0Id: WETH, token1Id: USDC },
    tokens: [
      { id: WETH, symbol: 'WETH', decimals: 18, verified: true },
      { id: USDC, symbol: 'USDC', decimals: 6, verified: true },
    ],
    stats: { totalValueLockedToken0: 1000, totalValueLockedToken1: 3_000_000 },
    raw: raw({ tokenId: '7', tickLower: -197_000, tickUpper: -195_000, liquidity: '2000000000000000', amount0: 0.4, amount1: 1500 }),
  },
  {
    name: 'corrupt (negative) reserves',
    prices: prices({ token0Usd: 1, token1Usd: 1, token0Confidence: 'anchor', token1Confidence: 'external-unverified' }),
    pool: { id: pid(8), fee: 100, tick: 0, token0Id: USDC, token1Id: RPC },
    tokens: [
      { id: USDC, symbol: 'USDC', decimals: 18, verified: true },
      { id: RPC, symbol: 'DIYP', decimals: 18, verified: false },
    ],
    stats: { totalValueLockedToken0: -1_490_000_000, totalValueLockedToken1: 1_470_000_000 },
    raw: raw({ tokenId: '8', amount0: 100, amount1: 100 }),
  },
  {
    name: 'out of range, frozen indexer amounts (launchpad LP)',
    prices: prices({ token0Usd: 3000, token1Usd: 0.002, token0Confidence: 'anchor', token1Confidence: 'external-verified' }),
    pool: { id: pid(9), fee: 10_000, tick: -140_000, token0Id: WETH, token1Id: RPC },
    tokens: [
      { id: WETH, symbol: 'WETH', decimals: 18, verified: true },
      { id: RPC, symbol: 'ORBIO', decimals: 18, verified: false },
    ],
    stats: { totalValueLockedToken0: 400, totalValueLockedToken1: 900_000_000 },
    raw: raw({ tokenId: '1357156', tickLower: -120_000, tickUpper: -100_000, liquidity: '30000000000000000000000', amount0: 10, amount1: 8_000_000_000 }),
  },
  {
    name: 'missing sqrtPrice (tick only), static fee just under the honeypot floor',
    prices: prices({ token0Usd: 3000, token1Usd: 1, token0Confidence: 'anchor', token1Confidence: 'anchor' }),
    pool: { id: pid(10), fee: 49_999, tick: -196_000, sqrtPriceX96: '0', token0Id: WETH, token1Id: USDC },
    tokens: [
      { id: WETH, symbol: 'WETH', decimals: 18, verified: true },
      { id: USDC, symbol: 'USDC', decimals: 6, verified: true },
    ],
    stats: { totalValueLockedToken0: 10, totalValueLockedToken1: 30_000 },
    raw: raw({ tokenId: '10', tickLower: -197_000, tickUpper: -195_000, liquidity: '2000000000000000', amount0: 0.4, amount1: 1500 }),
  },
];

export interface FakePricing {
  pricing: PricingService;
}

/** A pricing double: the case's decision, and the REAL tick math for amounts. */
export function fakePricing(result: PriceResult): PricingService {
  return {
    pricePool: async () => result,
    prefetchPrices: async () => undefined,
    positionAmounts: (input: Parameters<RealPricingService['positionAmounts']>[0]) =>
      RealPricingService.prototype.positionAmounts.call(undefined, input),
  } as unknown as PricingService;
}

/**
 * The uncollected fees every case carries. The indexer no longer has an
 * uncollected-fee figure (the old raw row's 0.001 / 0.002), so the same amounts
 * now arrive as the on-chain measurement the fee job stored, taken at the
 * position's own last-modify block — which keeps the fee terms of every
 * valuation case (pendingFeesUsd, totalFeesUsd, APR) exercised.
 */
const ONCHAIN_FEES = { fees0: 0.001, fees1: 0.002 };

export async function normalizeCase(
  c: NormalizeCase,
  config: Record<string, unknown> = {},
  integration: IntegrationConfig = INTEGRATION,
): Promise<NormalizedPosition> {
  const adapter = new EnvioAdapter(fakePricing(c.prices), { findByIds: async () => [] } as never, { minRealMarketBackingUsd: 1000, ...config } as never);
  const pools = new Map([
    [c.pool.id, { name: 'P', tickSpacing: 60, ...c.pool, sqrtPriceX96: c.pool.sqrtPriceX96 ?? sqrtAt(c.pool.tick) }],
  ]);
  const tokens = new Map(c.tokens.map((t) => [t.id, { name: t.symbol, ...t }]));
  const poolStats = new Map(c.stats ? [[c.pool.id, { id: c.pool.id, ...c.stats }]] : []);
  return (adapter as unknown as {
    normalize: (
      raw: Record<string, unknown>,
      integration: IntegrationConfig,
      pools: Map<string, unknown>,
      tokens: Map<string, unknown>,
      poolStats: Map<string, unknown>,
      rpcFees: Map<string, unknown>,
    ) => Promise<NormalizedPosition>;
  }).normalize(
    { ...c.raw, poolId: c.pool.id },
    integration,
    pools,
    tokens,
    poolStats,
    new Map([[String(c.raw.tokenId), { ...ONCHAIN_FEES, block: Number(c.raw.lastModifyBlock) }]]),
  );
}

/** A normalized row as plain JSON (Dates as ISO strings) — what a byte comparison reads. */
export function asJson(position: NormalizedPosition | null): unknown {
  return JSON.parse(JSON.stringify(position));
}
