/*
 * The backfill pipeline's cap / deadline path (`BACKFILL_PIPELINE=on`): a
 * range whose price prefetch was skipped at the in-flight cap prices with
 * `seedLastKnown` + `pricePool(…, {cacheOnly})`. It must value a leg exactly
 * as today's path would with the same stored data:
 *  - the DEX-market verdict is loaded (fail-closed `unknown` zeroed a
 *    DEX-backed, non-listed leg that HAD a price);
 *  - an expired cached positive gives way to a newer stored price;
 *  - a cached positive is never served past the last-known freshness bound.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PricingService } from '../../src/pricing/pricing.service.js';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const RPC = '0xed025a9fe4b30bcd68460bca42583090c2266468'; // non-listed, DEX-backed
const MIN = 60_000;
const HOUR = 60 * MIN;

function svc(opts: { stored: () => { priceUsd: number; pricedAt: Date } | undefined; rpcQuote?: () => number | undefined }) {
  const provider = {
    name: 'defillama',
    supportsCurrentBatch: true,
    supportsHistoricalBatch: false,
    maxBatchSize: 50,
    singleConcurrency: 1,
    defaultBackoffMs: 0,
    isEnabled: () => true,
    isAvailable: () => true,
    getCurrentSingle: vi.fn(async () => null),
    getCurrentBatch: vi.fn(async (c: number, addrs: string[]) => {
      const out = new Map<string, { priceUsd: number }>();
      for (const a of addrs) {
        if (a === USDC) out.set(`${c}:${a}`, { priceUsd: 1 });
        const q = a === RPC ? opts.rpcQuote?.() : undefined;
        if (q) out.set(`${c}:${a}`, { priceUsd: q });
      }
      return out;
    }),
    getHistoricalSingle: vi.fn(async () => null),
    getMetrics: () => ({ success: 0, miss: 0, ratelimit: 0, error: 0, skip: 0 }),
  };
  const tokens = {
    upsertPrices: async () => {},
    findLatestPrices: vi.fn(async (_c: number, addrs: string[]) => {
      const out = new Map<string, { priceUsd: number; pricedAt: Date }>();
      const row = opts.stored();
      if (row && addrs.includes(RPC)) out.set(RPC, row);
      return out;
    }),
    findDexMarketState: vi.fn(async (_c: number, addrs: string[]) => new Map(addrs.filter((a) => a === RPC).map((a) => [a, true]))),
  };
  const s = new PricingService(
    {
      priceFallbackEnabled: true,
      tokenListingGateEnabled: true,
      dexMarketGateEnabled: true,
      dexMarketFailClosed: true,
      pricingPrefetchChunkConcurrency: 4,
    } as never,
    {
      findHistoricalNear: async () => null,
      findHistoricalNearMany: async () => new Map(),
      upsertHistorical: async () => {},
      upsertManyHistorical: async () => {},
    } as never,
    { currentProviders: () => [provider], historicalProviders: () => [], getMetricsSnapshot: () => ({}) } as never,
    { isListed: (_c: number, a: string) => a === USDC } as never,
    tokens as never,
  );
  return { s, tokens };
}

const POOL = {
  chainId: 1,
  protocol: 'uniswap-v4',
  token0: { address: USDC, decimals: 6, verified: true, symbol: 'USDC' },
  token1: { address: RPC, decimals: 18, verified: false, symbol: 'RPC' },
  poolTvlUsd: 0,
};

afterEach(() => vi.useRealTimers());

describe('cap path (prefetch skipped) prices like today', () => {
  it('today: prefetch then pricePool → RPC priced from last-known', async () => {
    const { s } = svc({ stored: () => ({ priceUsd: 0.0105, pricedAt: new Date() }) });
    await s.prefetchPrices(1, [USDC, RPC]);
    expect((await s.pricePool(POOL as never)).token1Usd).toBeCloseTo(0.0105);
  });

  it('pipeline cap path: seedLastKnown loads the DEX verdict → RPC priced, not zeroed', async () => {
    const { s, tokens } = svc({ stored: () => ({ priceUsd: 0.0105, pricedAt: new Date() }) });
    await s.prefetchPrices(1, [USDC]); // an earlier range cached USDC
    tokens.findDexMarketState.mockClear();
    await s.seedLastKnown(1, [USDC, RPC]);
    expect(tokens.findDexMarketState).toHaveBeenCalledTimes(1);
    const r = await s.pricePool(POOL as never, { cacheOnly: true });
    expect(r.token1Usd).toBeCloseTo(0.0105);
  });
});

describe('cache-only freshness', () => {
  it('an expired cached positive gives way to a NEWER stored price', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T00:00:00Z'));
    let stored: { priceUsd: number; pricedAt: Date } | undefined;
    const { s } = svc({ stored: () => stored, rpcQuote: () => 0.01 });
    await s.prefetchPrices(1, [USDC, RPC]); // RPC cached at 0.01
    vi.advanceTimersByTime(2 * HOUR);
    stored = { priceUsd: 0.02, pricedAt: new Date() }; // the consensus sweep, just now
    await s.seedLastKnown(1, [USDC, RPC]);
    expect((await s.pricePool(POOL as never, { cacheOnly: true })).token1Usd).toBeCloseTo(0.02);
  });

  it('an expired cached positive NEWER than the stored row is kept', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T00:00:00Z'));
    const old = new Date(Date.now() - HOUR);
    const { s } = svc({ stored: () => ({ priceUsd: 0.5, pricedAt: old }), rpcQuote: () => 0.01 });
    await s.prefetchPrices(1, [USDC, RPC]);
    vi.advanceTimersByTime(10 * MIN);
    await s.seedLastKnown(1, [USDC, RPC]);
    expect((await s.pricePool(POOL as never, { cacheOnly: true })).token1Usd).toBeCloseTo(0.01);
  });

  it('a cached positive older than the last-known bound (24 h) is not served', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T00:00:00Z'));
    const { s } = svc({ stored: () => undefined, rpcQuote: () => 0.01 });
    await s.prefetchPrices(1, [USDC, RPC]);
    vi.advanceTimersByTime(23 * HOUR);
    await s.seedLastKnown(1, [USDC, RPC]); // the range's verdicts; no stored row to swap in
    expect((await s.pricePool(POOL as never, { cacheOnly: true })).token1Usd).toBeCloseTo(0.01);
    vi.advanceTimersByTime(2 * HOUR);
    await s.seedLastKnown(1, [USDC, RPC]);
    expect((await s.pricePool(POOL as never, { cacheOnly: true })).token1Usd).toBe(0);
  });
});
