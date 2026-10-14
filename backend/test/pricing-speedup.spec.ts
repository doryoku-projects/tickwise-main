import { describe, expect, it, vi } from 'vitest';
import {
  historicalTokenPriceRequestKey,
  PricingService,
} from '../src/pricing/pricing.service.js';
import { DefillamaProvider } from '../src/pricing/providers/defillama.provider.js';

const TOKEN = '0xaaaa000000000000000000000000000000000001';
const TS = 1_700_000_000;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('DefillamaProvider.getHistoricalBatch', () => {
  function provider(): DefillamaProvider {
    return new DefillamaProvider({
      pricingProviderMaxConcurrency: 8,
      pricingHistoricalSingleConcurrency: 8,
    } as never);
  }

  it('parses a batchHistorical response and keys results by providerHistoricalKey', async () => {
    const p = provider();
    const coin = `ethereum:${TOKEN}`;
    vi.spyOn(p as never as { httpJson: unknown }, 'httpJson').mockResolvedValue({
      statusCode: 200,
      retryAfterMs: 0,
      data: { coins: { [coin]: { prices: [{ timestamp: TS, price: 5.5, confidence: 0.99 }] } } },
    } as never);

    const result = await p.getHistoricalBatch([{ chainId: 1, address: TOKEN, timestamp: TS }]);

    expect(result.get(`1:${TOKEN}:${TS}`)?.priceUsd).toBeCloseTo(5.5, 6);
  });

  it('picks the returned price nearest the requested timestamp', async () => {
    const p = provider();
    const coin = `ethereum:${TOKEN}`;
    vi.spyOn(p as never as { httpJson: unknown }, 'httpJson').mockResolvedValue({
      statusCode: 200,
      retryAfterMs: 0,
      data: {
        coins: {
          [coin]: {
            prices: [
              { timestamp: TS - 5000, price: 1, confidence: 0.99 },
              { timestamp: TS + 100, price: 9, confidence: 0.99 },
            ],
          },
        },
      },
    } as never);

    const result = await p.getHistoricalBatch([{ chainId: 1, address: TOKEN, timestamp: TS }]);
    expect(result.get(`1:${TOKEN}:${TS}`)?.priceUsd).toBeCloseTo(9, 6); // +100 is closer than -5000
  });

  it('drops low-confidence quotes (left for the next provider)', async () => {
    const p = provider();
    const coin = `ethereum:${TOKEN}`;
    vi.spyOn(p as never as { httpJson: unknown }, 'httpJson').mockResolvedValue({
      statusCode: 200,
      retryAfterMs: 0,
      data: { coins: { [coin]: { prices: [{ timestamp: TS, price: 5.5, confidence: 0.1 }] } } },
    } as never);

    const result = await p.getHistoricalBatch([{ chainId: 1, address: TOKEN, timestamp: TS }]);
    expect(result.has(`1:${TOKEN}:${TS}`)).toBe(false);
  });

  it('advertises historical batch support', () => {
    expect(provider().supportsHistoricalBatch).toBe(true);
  });
});

describe('PricingService cross-call single-flight', () => {
  function build(onHistorical: () => Promise<void>, counter: { calls: number }): PricingService {
    const provider = {
      name: 'mock-hist',
      tier: 'external' as const,
      supportsCurrentBatch: false,
      supportsHistoricalBatch: false,
      maxBatchSize: 1,
      singleConcurrency: 5,
      defaultBackoffMs: 0,
      isEnabled: () => true,
      isAvailable: () => true,
      markBackoff: () => undefined,
      getCurrentSingle: vi.fn(async () => null),
      getHistoricalSingle: vi.fn(async () => {
        counter.calls += 1;
        await onHistorical();
        return { priceUsd: 1234 };
      }),
      getMetrics: () => ({ success: 0, miss: 0, ratelimit: 0, error: 0, skip: 0 }),
    };
    return new PricingService(
      {
        priceFallbackEnabled: true,
        pricingMissTtlMs: 1_800_000,
        pricingProviderTimeoutMs: 30_000,
        pricingMissIndexingGraceMs: 0,
      } as never,
      {
        findHistoricalNear: async () => null,
        findHistoricalNearMany: async () => new Map(),
        upsertHistorical: async () => undefined,
        upsertManyHistorical: async () => undefined,
      } as never,
      {
        currentProviders: () => [provider],
        historicalProviders: () => [provider],
        getMetricsSnapshot: () => ({}),
      } as never,
    );
  }

  it('coalesces two concurrent identical lookups into ONE provider call', async () => {
    const counter = { calls: 0 };
    const svc = build(() => delay(10), counter);
    const req = { chainId: 1, address: TOKEN, timestamp: TS };

    const [a, b] = await Promise.all([
      svc.historicalTokenPricesUsdMany([req]),
      svc.historicalTokenPricesUsdMany([req]),
    ]);

    const key = historicalTokenPriceRequestKey(1, TOKEN, TS);
    expect(counter.calls).toBe(1); // second call borrowed the first's in-flight result
    expect(a.get(key)).toBeCloseTo(1234, 6);
    expect(b.get(key)).toBeCloseTo(1234, 6);
  });

  it('does not leak in-flight entries — a later call re-fetches after the first settles', async () => {
    const counter = { calls: 0 };
    const svc = build(() => delay(1), counter);
    const req = { chainId: 1, address: TOKEN, timestamp: TS };

    await svc.historicalTokenPricesUsdMany([req]);
    await svc.historicalTokenPricesUsdMany([req]);

    // Sequential (not concurrent) → no coalescing; entry cleared after each.
    // (Mongo cache is mocked empty, so both calls reach the provider.)
    expect(counter.calls).toBe(2);
  });
});

describe('PricingService divergence / ceiling guards (Tier 1)', () => {
  const KEY = historicalTokenPriceRequestKey(1, TOKEN, TS);
  const metrics = () => ({ success: 0, miss: 0, ratelimit: 0, error: 0, skip: 0 });

  function externalProvider(price: number) {
    return {
      name: 'ext',
      tier: 'external' as const,
      supportsCurrentBatch: false,
      supportsHistoricalBatch: false,
      maxBatchSize: 1,
      singleConcurrency: 5,
      defaultBackoffMs: 0,
      isEnabled: () => true,
      isAvailable: () => true,
      markBackoff: () => undefined,
      getCurrentSingle: vi.fn(async () => null),
      getHistoricalSingle: vi.fn(async () => (price > 0 ? { priceUsd: price } : null)),
      getMetrics: metrics,
    };
  }
  function poolRatioContextProvider(price: number) {
    return {
      name: 'pool-ratio',
      supportsCurrentBatch: false,
      supportsHistoricalBatch: false,
      maxBatchSize: 50,
      singleConcurrency: 5,
      defaultBackoffMs: 0,
      skipsOrchestratorTimeout: true,
      isEnabled: () => true,
      isAvailable: () => true,
      markBackoff: () => undefined,
      getCurrentSingle: vi.fn(async () => null),
      getHistoricalSingle: vi.fn(async () => null),
      getHistoricalBatchWithContext: vi.fn(async (reqs: Array<{ chainId: number; address: string; timestamp: number }>) => {
        const m = new Map<string, { priceUsd: number }>();
        for (const r of reqs) m.set(`${r.chainId}:${r.address.toLowerCase()}:${r.timestamp}`, { priceUsd: price });
        return m;
      }),
      getMetrics: metrics,
    };
  }
  function svcWith(providers: unknown[]): PricingService {
    return new PricingService(
      {
        priceFallbackEnabled: true,
        pricingMissTtlMs: 1_800_000,
        pricingProviderTimeoutMs: 30_000,
        pricingMissIndexingGraceMs: 0,
      } as never,
      {
        findHistoricalNear: async () => null,
        findHistoricalNearMany: async () => new Map(),
        upsertHistorical: async () => undefined,
        upsertManyHistorical: async () => undefined,
      } as never,
      {
        currentProviders: () => providers,
        historicalProviders: () => providers,
        getMetricsSnapshot: () => ({}),
      } as never,
    );
  }
  const unverifiedReq = {
    chainId: 1,
    address: TOKEN,
    timestamp: TS,
    unverified: true,
    poolHint: '0xpool',
    anchorAddress: '0xanchor000000000000000000000000000000beef',
    protocol: 'uniswap-v4',
    tokenDecimals: 18,
    anchorDecimals: 6,
    isToken0: true,
    symbol: 'DMT',
  };

  it('rejects an over-ceiling provider price → token left unpriced', async () => {
    const svc = svcWith([externalProvider(89_000_000_000)]);
    const res = await svc.historicalTokenPricesUsdMany([{ chainId: 1, address: TOKEN, timestamp: TS }]);
    expect(res.get(KEY) ?? 0).toBe(0);
  });

  it('accepts a normal provider price', async () => {
    const svc = svcWith([externalProvider(5)]);
    const res = await svc.historicalTokenPricesUsdMany([{ chainId: 1, address: TOKEN, timestamp: TS }]);
    expect(res.get(KEY)).toBeCloseTo(5, 6);
  });

  it('does NOT override the external price when the pool ratio diverges extremely (the $89B case)', async () => {
    const svc = svcWith([externalProvider(1), poolRatioContextProvider(89_000_000_000)]);
    const res = await svc.historicalTokenPricesUsdMany([unverifiedReq]);
    expect(res.get(KEY)).toBeCloseTo(1, 6); // external kept, pool-ratio distrusted
  });

  it('still overrides on a moderate suspect divergence (10×–100×)', async () => {
    const svc = svcWith([externalProvider(1), poolRatioContextProvider(20)]);
    const res = await svc.historicalTokenPricesUsdMany([unverifiedReq]);
    expect(res.get(KEY)).toBeCloseTo(20, 6); // pool-ratio wins for plausible divergence
  });
});
