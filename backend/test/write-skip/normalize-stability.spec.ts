/*
 * Design §4.5: "two normalizes of identical indexer + price input (different
 * `now`) give equal hashes for every section". Runs the REAL
 * `EnvioAdapter.normalize` twice, 30 minutes apart, on the same raw row and
 * prices: every section hash must match (only `lastSyncedAt`,
 * `pricing.pricedAt`, `metrics.ageSeconds` and `rawSubgraph` may differ, and
 * none of them is hashed). Then through the repository: with skip `on` the
 * second walk of a CLOSED row writes nothing, and an ACTIVE row whose APR
 * annualises over its age writes `metrics` only.
 */
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { declaredLeavesOf, diffSections, SECTIONS, sectionValues } from '../../src/database/position-write-hash.js';
import { PositionSchema } from '../../src/database/schemas/position.schema.js';
import type { IntegrationConfig } from '../../src/config/integrations.config.js';
import type { PriceResult, PricingService } from '../../src/pricing/pricing.service.js';
import { EnvioAdapter } from '../../src/subgraph/adapters/envio.adapter.js';
import type { NormalizedPosition } from '../../src/subgraph/normalized-position.js';
import { repoOver } from './support/fixtures.js';
import { PositionSim, type Doc } from './support/position-sim.js';

const DECLARED = declaredLeavesOf(PositionSchema);
const T1 = new Date('2026-10-04T10:00:00Z');
const INTEGRATION: IntegrationConfig = { chainId: 1, protocol: 'uniswap-v4', enabled: true, subgraphUrl: 'https://example.com/subgraph' };
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const POOL_ID = '0x21c67e77068de97969ba93d4aab21826d33ca12bb9f565d8496e8fda8a82ca27';

beforeEach(() => {
  vi.useFakeTimers({ now: T1, toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

const PRICES: PriceResult = {
  token0Usd: 1,
  token1Usd: 3000,
  source: 'orchestrated' as PriceResult['source'],
  usedFallback: false,
  token0Confidence: 'anchor',
  token1Confidence: 'anchor',
};

function adapter(): EnvioAdapter {
  const pricing = { pricePool: async () => PRICES, prefetchPrices: async () => undefined } as unknown as PricingService;
  return new EnvioAdapter(pricing, { findByIds: async () => [] } as never, { minRealMarketBackingUsd: 1000 } as never);
}

function maps() {
  const pools = new Map([
    [POOL_ID, { id: POOL_ID, name: 'USDC/WETH', fee: 500, tickSpacing: 10, tick: -196_000, sqrtPriceX96: '4400000000000000000000000', token0Id: USDC, token1Id: WETH }],
  ]);
  const tokens = new Map([
    [USDC, { id: USDC, symbol: 'USDC', name: 'USD Coin', decimals: 6, verified: true }],
    [WETH, { id: WETH, symbol: 'WETH', name: 'Wrapped Ether', decimals: 18, verified: true }],
  ]);
  const poolStats = new Map([
    [POOL_ID, { id: POOL_ID, totalValueLockedUSD: '150000000', totalValueLockedUSDUntracked: '0', totalValueLockedToken0: '60000000', totalValueLockedToken1: '30000', volumeUSD: '1000000000', feesUSD: '500000' }],
  ]);
  return { pools, tokens, poolStats };
}

function raw(over: Record<string, unknown> = {}) {
  return {
    chainId: 1,
    tokenId: '55555',
    owner: '0x1234567890abcdef1234567890abcdef12345678',
    poolId: POOL_ID,
    tickLower: -197_000,
    tickUpper: -195_000,
    liquidity: '1234567890123',
    isActive: true,
    isPriceable: true,
    createdAtTimestamp: String(Math.floor(T1.getTime() / 1000) - 40 * 86_400),
    createdAtBlockNumber: '21000000',
    closedAtTimestamp: null,
    depositedToken0: 5000,
    depositedToken1: 2,
    withdrawnToken0: 0,
    withdrawnToken1: 0,
    totalFeesCollected0: 12,
    totalFeesCollected1: 0.004,
    totalFeesUncollected0: 3,
    totalFeesUncollected1: 0.001,
    amount0: 4800,
    amount1: 2.05,
    totalGasCostETH: 0.0042,
    updatedAtBlock: '23000001',
    updatedAtTimestamp: String(Math.floor(T1.getTime() / 1000) - 3600),
    lastModifyBlock: '23000000',
    ...over,
  };
}

async function normalize(row: Record<string, unknown>): Promise<NormalizedPosition> {
  const { pools, tokens, poolStats } = maps();
  const out = await (adapter() as unknown as {
    normalize: (r: unknown, i: IntegrationConfig, p: Map<string, unknown>, t: Map<string, unknown>, s: Map<string, unknown>) => Promise<NormalizedPosition | null>;
  }).normalize(row, INTEGRATION, pools, tokens, poolStats);
  expect(out).not.toBeNull();
  return out!;
}

describe('normalize at two times → equal section hashes', () => {
  for (const [name, over] of [
    ['open', {}],
    ['closed', { isActive: false, liquidity: '0', closedAtTimestamp: String(Math.floor(T1.getTime() / 1000) - 86_400) }],
  ] as const) {
    it(`${name} position`, async () => {
      const first = await normalize(raw(over));
      vi.setSystemTime(T1.getTime() + 30 * 60_000);
      const second = await normalize(raw(over));
      // The clock-driven fields really did move…
      expect(second.pricing.pricedAt.getTime()).toBeGreaterThan(first.pricing.pricedAt.getTime());
      if (name === 'open') expect(second.metrics.ageSeconds).toBe(first.metrics.ageSeconds + 1800);
      // …and no section hash did.
      const a = diffSections(sectionValues(first as unknown as Record<string, unknown>, DECLARED).values, null);
      const b = diffSections(sectionValues(second as unknown as Record<string, unknown>, DECLARED).values, a.slots);
      expect(b.changed).toEqual([]);
      expect(a.present).toEqual(SECTIONS.filter((s) => s !== 'f'));
    });
  }

  it('through the repository (skip on): the closed row is not written again; the open one writes `metrics` only (its APR annualises over its age)', async () => {
    const sim = new PositionSim();
    const repo = repoOver(sim, { positionsWriteSkip: 'on' });
    const closedOver = { tokenId: '55556', isActive: false, liquidity: '0', closedAtTimestamp: String(Math.floor(T1.getTime() / 1000) - 86_400) };
    const opts = { aggregates: { ethPriceNow: 3000 } };
    for (let i = 0; i < 2; i++) await repo.upsertMany([await normalize(raw()), await normalize(raw(closedOver))], opts);
    vi.setSystemTime(T1.getTime() + 30 * 60_000);
    const before = sim.ops.length;
    await repo.upsertMany([await normalize(raw()), await normalize(raw(closedOver))], opts);
    const sent = sim.ops.slice(before).map((o) => o.op as { filter: Doc; update: { $set: Doc } });
    expect(sent.map((o) => o.filter.positionId)).toEqual(['55555']);
    const tops = new Set(Object.keys(sent[0]!.update.$set).map((k) => k.split('.')[0]));
    expect([...tops].sort()).toEqual(['lastSyncedAt', 'metrics', 'updatedAt', 'wh']);
  });
});
