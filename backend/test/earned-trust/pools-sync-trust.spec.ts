import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The Pools page and the Positions page used different trust rules for the
 * same token (BTC.b: priced on Positions, a $0 risky stub on Pools). The pools
 * sync now asks the SAME `TokenTrustService` the position path asks.
 */

const BTCB = '0xb0f70c0bd6fd87dbeb7c10dc692a2a6106817072';
const CBBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf';
const POOL = '0x9c25d738109ff9ad10516f5f97ef24b9af51a9aa3db4b3b5728edf18a2d3f11c';
// sqrtPriceX96 for a 1:1 human ratio (both 8 decimals).
const SQRT_1_1 = '79228162514264337593543950336';
let sqrtPrice = SQRT_1_1;
let token0 = { id: BTCB, symbol: 'BTC.b', decimals: '8' };
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

vi.mock('../../src/subgraph/request-retry.js', () => ({
  requestWithRetry: async (_client: unknown, query: unknown, vars: Record<string, unknown>) => {
    const text = String(query);
    if (text.includes('PoolDayMax')) return { poolDayDatas: [] };
    if (text.includes('PoolDayBatch')) return { poolDayDatas: [] };
    const where = (vars.where ?? {}) as { id_gt?: string };
    if (where.id_gt) return { pools: [] };
    return {
      pools: [
        {
          id: POOL,
          token0,
          token1: { id: CBBTC, symbol: 'cbBTC', decimals: '8' },
          feeTier: '100',
          tickSpacing: '1',
          tick: '0',
          sqrtPrice,
          liquidity: '1000',
          createdAtTimestamp: '1700000000',
          totalValueLockedToken0: '50.86',
          totalValueLockedToken1: '49.13',
          totalValueLockedUSD: '0',
          volumeUSD: '5',
          feesUSD: '0.01',
          txCount: '3',
          token0Price: '1',
          token1Price: '1',
        },
      ],
    };
  },
}));

import type { PoolUpsert } from '../../src/database/pools.repository.js';
import { PoolsSyncService } from '../../src/sync/pools-sync.service.js';
import { TokenTrustService } from '../../src/pricing/token-trust.service.js';

function makeService(config: Record<string, unknown>, verdicts: Record<string, boolean>) {
  const written: PoolUpsert[] = [];
  const repo = {
    upsertMany: async (pools: PoolUpsert[]) => {
      written.push(...pools);
      return { written: pools.length, unchanged: 0, hashReads: 0 };
    },
  };
  const fullConfig = {
    getIntegration: () => ({ chainId: 1, protocol: 'uniswap-v4', subgraphUrl: 'http://indexer.test/graphql' }),
    poolsSyncIntervalMs: 3_600_000,
    ...config,
  };
  const pricePool = vi.fn(async () => ({
    token0Usd: 85_300,
    token1Usd: 85_300,
    source: 'external',
    usedFallback: false,
    token0Confidence: 'external-verified',
    token1Confidence: 'external-verified',
  }));
  const findTrustState = vi.fn(async (_c: number, addrs: string[]) =>
    new Map(addrs.filter((a) => a in verdicts).map((a) => [a, { trustEarned: verdicts[a], trustEvaluatedAt: new Date() }])),
  );
  const trust = new TokenTrustService(fullConfig as never, { findTrustState } as never);
  const svc = new PoolsSyncService(fullConfig as never, repo as never, { pricePool } as never, undefined, undefined, trust);
  (svc as unknown as { logger: unknown }).logger = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
  return { svc, written, pricePool, findTrustState };
}

beforeEach(() => {
  sqrtPrice = SQRT_1_1;
  token0 = { id: BTCB, symbol: 'BTC.b', decimals: '8' };
});

describe('pools sync — the ONE trust rule', () => {
  it('allowlist mode (default): BTC.b is not allowlisted → risky stub, no pricing call, no trust read (today)', async () => {
    const { svc, written, pricePool, findTrustState } = makeService({}, { [BTCB]: true, [CBBTC]: true });
    await svc.syncPools(1, 'uniswap-v4');
    expect(pricePool).not.toHaveBeenCalled();
    expect(findTrustState).not.toHaveBeenCalled();
    expect(written[0]).toMatchObject({ poolId: POOL, metrics: { tvlUsd: 0 }, pricing: { source: 'none', usedFallback: true } });
  });

  it('earned mode: both legs earned → the pool is priced and gets its real TVL (~$8.5M)', async () => {
    const { svc, written, pricePool } = makeService({ tokenTrustMode: 'earned' }, { [BTCB]: true, [CBBTC]: true });
    await svc.syncPools(1, 'uniswap-v4');
    expect(pricePool).toHaveBeenCalledTimes(1);
    expect(written[0]!.pricing.usedFallback).toBe(false);
    expect(written[0]!.metrics.tvlUsd).toBeCloseTo((50.86 + 49.13) * 85_300, 0);
  });

  it('earned mode: a leg without an earned verdict keeps the pool a risky stub', async () => {
    const { svc, written, pricePool } = makeService({ tokenTrustMode: 'earned' }, { [BTCB]: false, [CBBTC]: true });
    await svc.syncPools(1, 'uniswap-v4');
    expect(pricePool).not.toHaveBeenCalled();
    expect(written[0]!.pricing.usedFallback).toBe(true);
  });

  it('earned mode: a pool whose own price is >10% off its legs\' market price is not counted (risky)', async () => {
    // sqrtPrice for a 2:1 ratio → the pool says BTC.b = 2 cbBTC, the market says 1.
    sqrtPrice = (BigInt(SQRT_1_1) * 1414213562n / 1000000000n).toString();
    const { svc, written } = makeService({ tokenTrustMode: 'earned' }, { [BTCB]: true, [CBBTC]: true });
    await svc.syncPools(1, 'uniswap-v4');
    expect(written[0]!.metrics.tvlUsd).toBe(0);
    expect(written[0]!.pricing.usedFallback).toBe(true);
  });

  it('the env deny list removes trust in allowlist mode too (USDC/cbBTC: priced, then stubbed once cbBTC is denied)', async () => {
    token0 = { id: USDC, symbol: 'USDC', decimals: '8' };
    const open = makeService({}, {});
    await open.svc.syncPools(1, 'uniswap-v4');
    expect(open.pricePool).toHaveBeenCalledTimes(1);
    const denied = makeService({ tokenTrustDeny: CBBTC }, {});
    await denied.svc.syncPools(1, 'uniswap-v4');
    expect(denied.pricePool).not.toHaveBeenCalled();
    expect(denied.written[0]!.pricing.usedFallback).toBe(true);
  });
});
