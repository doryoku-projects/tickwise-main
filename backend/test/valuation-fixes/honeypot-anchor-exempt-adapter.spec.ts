import { describe, expect, it, vi } from 'vitest';
import { AppConfigService } from '../../src/config/app-config.service.js';
import type { PriceResult, PricingService } from '../../src/pricing/pricing.service.js';
import { EnvioAdapter } from '../../src/subgraph/adapters/envio.adapter.js';
import type { IntegrationConfig } from '../../src/config/integrations.config.js';
import type { NormalizedPosition } from '../../src/subgraph/normalized-position.js';

/**
 * HONEYPOT_FEE_ANCHOR_EXEMPT on the POSITION side: the adapter re-values
 * `poolStats.tvlUsd` through the pools sync's `evaluatePoolTvl`, and must pass
 * the exemption the pools sync passes — or an anchor/anchor pool at a static
 * fee ≥ 5% (42161 ETH/USDC at 6.094%, ~$53k) is valued on the Pools page and
 * served at $0 pool TVL beside every one of its positions (`/api`, `/v1`, the
 * `poolTvl` rank column). Off (default, and any config without the getter):
 * today's fee rule, $0.
 */

const INTEGRATION: IntegrationConfig = { chainId: 1, protocol: 'uniswap-v4', enabled: true, subgraphUrl: 'https://example.com/subgraph' };
const ETH = '0x0000000000000000000000000000000000000000'; // native: anchor
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'; // stable: anchor
const RPC = '0xed025a9fe4b30bcd68460bca42583090c2266468'; // not an anchor
const POOL_ID = '0x' + 'e'.repeat(64);
const FEE = 60_940; // ≥ 5%: a honeypot-fee pool by the rule

async function poolTvl(config: Record<string, unknown> | AppConfigService, token1 = USDC, token1Usd = 1): Promise<NormalizedPosition['poolStats']> {
  const prices: PriceResult = {
    token0Usd: 2700,
    token1Usd,
    source: 'orchestrated' as PriceResult['source'],
    usedFallback: false,
    token0Confidence: 'anchor',
    token1Confidence: token1 === USDC ? 'anchor' : 'external-verified',
  };
  const adapter = new EnvioAdapter(
    { pricePool: async () => prices, prefetchPrices: async () => undefined } as unknown as PricingService,
    { findByIds: async () => [] } as never,
    (config instanceof AppConfigService ? config : { minRealMarketBackingUsd: 1000, ...config }) as never,
  );
  const pools = new Map([[POOL_ID, { id: POOL_ID, name: 'ETH/X', fee: FEE, tickSpacing: 60, tick: 0, sqrtPriceX96: String(2n ** 96n), token0Id: ETH, token1Id: token1 }]]);
  const tokens = new Map([
    [ETH, { id: ETH, symbol: 'ETH', name: 'Ether', decimals: 18, verified: true }],
    [token1, { id: token1, symbol: 'X', name: 'X', decimals: 18, verified: true }],
  ]);
  const poolStats = new Map([[POOL_ID, { id: POOL_ID, totalValueLockedToken0: '10', totalValueLockedToken1: '27000', totalValueLockedUSD: '54000', volumeUSD: '1', feesUSD: '1' }]]);
  const raw = {
    chainId: 1, tokenId: '777', owner: '0x1111111111111111111111111111111111111111', poolId: POOL_ID,
    tickLower: -600, tickUpper: 600, liquidity: '1000000', isActive: true, isPriceable: true,
    createdAtTimestamp: '1768000000', createdAtBlockNumber: '21000000', closedAtTimestamp: null,
    depositedToken0: 1, depositedToken1: 2700, withdrawnToken0: 0, withdrawnToken1: 0,
    totalFeesCollected0: 0, totalFeesCollected1: 0,
    amount0: 1, amount1: 2700, totalGasCostETH: 0, updatedAtBlock: '21000001', updatedAtTimestamp: '1768000001',
  };
  const pos = await (adapter as unknown as {
    normalize: (r: unknown, i: IntegrationConfig, p: unknown, t: unknown, s: unknown) => Promise<NormalizedPosition>;
  }).normalize(raw, INTEGRATION, pools, tokens, poolStats);
  return pos.poolStats;
}

describe('EnvioAdapter poolStats.tvlUsd — HONEYPOT_FEE_ANCHOR_EXEMPT', () => {
  it('off (unset, explicit) = today: the fee alone zeroes the anchor/anchor pool', async () => {
    expect((await poolTvl({})).tvlUsd).toBe(0);
    expect((await poolTvl({ honeypotFeeAnchorExempt: 'off' })).tvlUsd).toBe(0);
  });

  it('on: the anchor/anchor pool keeps its trusted TVL, exactly as the pools sync values it', async () => {
    expect((await poolTvl({ honeypotFeeAnchorExempt: 'on' })).tvlUsd).toBeCloseTo(10 * 2700 + 27_000, 6);
  });

  it('on: a pool with a non-anchor leg is still a honeypot-fee pool', async () => {
    expect((await poolTvl({ honeypotFeeAnchorExempt: 'on' }, RPC, 0.01)).tvlUsd).toBe(0);
  });

  it('through the real AppConfigService (the getter name the adapter reads structurally)', async () => {
    vi.stubEnv('HONEYPOT_FEE_ANCHOR_EXEMPT', 'On');
    try {
      expect((await poolTvl(new AppConfigService())).tvlUsd).toBeCloseTo(54_000, 6);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
