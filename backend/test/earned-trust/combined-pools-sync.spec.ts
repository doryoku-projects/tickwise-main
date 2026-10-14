import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `TOKEN_TRUST_MODE=combined` in the pools sync: a pool is priced when both
 * legs are anchor / allowlisted / earned, and — unlike allowlist mode — EVERY
 * non-anchor leg, allowlisted or earned, must pass the 10% pool-price
 * cross-check (`poolPriceAgrees`) or its value is not counted: a listing
 * proves a token exists, not that this pool prices it.
 */

const BTCB = '0xb0f70c0bd6fd87dbeb7c10dc692a2a6106817072'; // neither listed nor an anchor
const CBBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf'; // allowlisted
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'; // anchor
const POOL = '0x9c25d738109ff9ad10516f5f97ef24b9af51a9aa3db4b3b5728edf18a2d3f11c';
// sqrtPriceX96 for a 1:1 human ratio (both 8 decimals), and for 2:1.
const SQRT_1_1 = '79228162514264337593543950336';
const SQRT_2_1 = (BigInt(SQRT_1_1) * 1414213562n / 1000000000n).toString();
let sqrtPrice = SQRT_1_1;
let token0 = { id: USDC, symbol: 'USDC', decimals: '8' };
let reserve1 = '49.13';

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
          totalValueLockedToken1: reserve1,
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
  // Both legs at one market price, so the pool's own price (sqrtPrice) is
  // what decides whether the cross-check agrees.
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

const FULL_TVL = (50.86 + 49.13) * 85_300;

beforeEach(() => {
  sqrtPrice = SQRT_1_1;
  token0 = { id: USDC, symbol: 'USDC', decimals: '8' };
  reserve1 = '49.13';
});

describe('pools sync — combined mode', () => {
  it('USDC/cbBTC (anchor + allowlisted) at a price that agrees: priced and counted, as in allowlist mode; the page is warmed', async () => {
    const combined = makeService({ tokenTrustMode: 'combined' }, {});
    await combined.svc.syncPools(1, 'uniswap-v4');
    expect(combined.findTrustState).toHaveBeenCalledTimes(1);
    expect(combined.written[0]!.pricing.usedFallback).toBe(false);
    expect(combined.written[0]!.metrics.tvlUsd).toBeCloseTo(FULL_TVL, 0);
    const allowlist = makeService({}, {});
    await allowlist.svc.syncPools(1, 'uniswap-v4');
    expect(allowlist.findTrustState).not.toHaveBeenCalled(); // today: no trust I/O
    expect(allowlist.written[0]!.metrics.tvlUsd).toBeCloseTo(FULL_TVL, 0);
  });

  it('the cross-check applies to an ALLOWLISTED leg in combined mode, not in allowlist mode (pool 2:1 vs market 1:1)', async () => {
    sqrtPrice = SQRT_2_1;
    const allowlist = makeService({}, {});
    await allowlist.svc.syncPools(1, 'uniswap-v4');
    expect(allowlist.written[0]!.pricing.usedFallback).toBe(false);
    expect(allowlist.written[0]!.metrics.tvlUsd).toBeCloseTo(FULL_TVL, 0);

    const combined = makeService({ tokenTrustMode: 'combined' }, {});
    await combined.svc.syncPools(1, 'uniswap-v4');
    expect(combined.written[0]!.metrics.tvlUsd).toBe(0);
    expect(combined.written[0]!.pricing.usedFallback).toBe(true);
    // cbBTC's reserve no longer counts — ≈ half the pool, over the 20%
    // untrusted-share rule, so the pool is flagged. (The reserves are still
    // persisted; whether the USDC leg kept its trust is the next case.)
    expect(combined.written[0]!.metrics.tvlToken0).toBeGreaterThan(0);
  });

  it('the cross-check never downgrades an ANCHOR leg (combined and earned): cbBTC a small share at a disagreeing price → TVL is the USDC side', async () => {
    sqrtPrice = SQRT_2_1;
    // 0.5 cbBTC beside 50.86 "USDC": the untrusted leg is ~1% of the pool, under
    // the 20% rule, so the pool stays priced on its trusted (anchor) leg alone.
    reserve1 = '0.5';
    for (const [mode, verdicts] of [['combined', {}], ['earned', { [CBBTC]: true }]] as const) {
      const { svc, written, pricePool } = makeService({ tokenTrustMode: mode }, verdicts);
      await svc.syncPools(1, 'uniswap-v4');
      expect(pricePool, mode).toHaveBeenCalledTimes(1);
      expect(written[0]!.pricing.usedFallback, mode).toBe(false);
      expect(written[0]!.metrics.tvlUsd, mode).toBeCloseTo(50.86 * 85_300, 0);
    }
  });

  it('BTC.b (earned, unlisted) / cbBTC (allowlisted, no verdict): priced in combined; a risky stub in allowlist mode and in earned mode', async () => {
    token0 = { id: BTCB, symbol: 'BTC.b', decimals: '8' };
    const out: Record<string, number> = {};
    for (const mode of ['allowlist', 'earned', 'combined']) {
      const s = makeService({ tokenTrustMode: mode }, { [BTCB]: true });
      await s.svc.syncPools(1, 'uniswap-v4');
      out[mode] = s.pricePool.mock.calls.length;
    }
    expect(out).toEqual({ allowlist: 0, earned: 0, combined: 1 });
  });

  it('BTC.b earned + cbBTC listed at a disagreeing pool price: the earned leg is cross-checked too', async () => {
    token0 = { id: BTCB, symbol: 'BTC.b', decimals: '8' };
    sqrtPrice = SQRT_2_1;
    const { svc, written } = makeService({ tokenTrustMode: 'combined' }, { [BTCB]: true });
    await svc.syncPools(1, 'uniswap-v4');
    expect(written[0]!.metrics.tvlUsd).toBe(0);
    expect(written[0]!.pricing.usedFallback).toBe(true);
  });
});
