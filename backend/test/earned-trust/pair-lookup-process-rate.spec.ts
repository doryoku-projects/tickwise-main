import { afterEach, describe, expect, it, vi } from 'vitest';
import { PricingService } from '../../src/pricing/pricing.service.js';
import { PAIR_LOOKUP_BURST } from '../../src/pricing/pair-lookup-budget.js';
import { TokenPriceSyncService } from '../../src/sync/token-price-sync.service.js';

/**
 * The DEFAULT path, end to end, in a file of its own so the process's bucket
 * starts fresh (vitest gives every file its own module state): two chains'
 * sweeps through `TokenPriceSyncService`, no bucket injected anywhere, share
 * ONE token-pairs rate. The clock is frozen, so no token refills mid-test.
 */

const tok = (i: number) => `0x${(0xf000 + i).toString(16).padStart(40, '0')}`;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the process-wide token-pairs rate (default, no bucket injected)', () => {
  it(
    'chain 1 and Avalanche sweeping at once get 10 requests between them; a minute later the burst is back — 10, not 60',
    async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-06T10:00:00Z'));
      const addrs = Array.from({ length: 2000 }, (_, i) => tok(i));
      const getTokenPairs = vi.fn(async () => null);
      // Per-chain samples failing the $50 volume floor, DeFiLlama agreeing:
      // every token wants its own pairs (served re-check, then (b)).
      const quotes = (q: Record<string, unknown>) => Object.fromEntries(addrs.map((a) => [a, q]));
      const provider = (name: string, q: Record<string, Record<string, unknown>>, extra: Record<string, unknown> = {}) => ({
        name,
        supportsCurrentBatch: true,
        supportsHistoricalBatch: false,
        maxBatchSize: 50,
        singleConcurrency: 1,
        defaultBackoffMs: 0,
        isEnabled: () => true,
        isAvailable: () => true,
        getCurrentSingle: vi.fn(async () => null),
        getCurrentBatch: vi.fn(async (chainId: number, list: string[]) => new Map(list.filter((a) => q[a]).map((a) => [`${chainId}:${a}`, q[a]!]))),
        getHistoricalSingle: vi.fn(async () => null),
        getMetrics: () => ({ success: 0, miss: 0, ratelimit: 0, error: 0, skip: 0 }),
        ...extra,
      });
      const providers = [
        provider('dexscreener', quotes({ priceUsd: 2, volume24hUsd: 10, dexPairsComplete: false }), { getTokenPairs }),
        provider('defillama', quotes({ priceUsd: 2 })),
      ];
      const tokens = {
        findLatestPrices: async () => new Map(),
        upsertPrices: async () => {},
        upsertTrustEvidence: async () => {},
        clearGuardedPrices: async () => 0,
        findTrustState: async () => new Map(),
        findDexMarketState: async () => new Map(),
      };
      const svc = new PricingService(
        {
          priceFallbackEnabled: true,
          tokenListingGateEnabled: true,
          dexMarketMinVolumeUsd: 50,
          dexMarketMinCounterLiquidityUsd: 1000,
          pricingPrefetchChunkConcurrency: 2,
          tokenTrustShadow: 'on',
          dexscreenerBatchEndpoint: 'per-chain',
        } as never,
        {} as never,
        { currentProviders: () => providers, historicalProviders: () => providers } as never,
        { isListed: () => false } as never,
        tokens as never,
      );
      const byChain: Record<number, string[]> = { 1: addrs.slice(0, 1000), 43114: addrs.slice(1000) };
      const positions = { distinctActiveTokenAddresses: async (chainId: number) => byChain[chainId] ?? [] };
      const sync = new TokenPriceSyncService({ enabledIntegrations: [] } as never, positions as never, svc);
      const log = vi.spyOn((sync as unknown as { logger: { log: (m: string) => void } }).logger, 'log').mockImplementation(() => {});
      const sent = () => log.mock.calls.map((c) => Number(/ pairLookups=(\d+) pairDenied=\d+$/.exec(String(c[0]))?.[1] ?? NaN));

      await Promise.all([sync.syncChain(1, 'uniswap-v4'), sync.syncChain(43114, 'uniswap-v4')]);
      expect(getTokenPairs).toHaveBeenCalledTimes(PAIR_LOOKUP_BURST);
      expect(sent().reduce((a, b) => a + b, 0)).toBe(PAIR_LOOKUP_BURST);

      vi.setSystemTime(new Date('2026-10-06T10:01:00Z'));
      await sync.syncChain(1, 'uniswap-v4');
      expect(getTokenPairs).toHaveBeenCalledTimes(2 * PAIR_LOOKUP_BURST);
      expect(sent().at(-1)).toBe(PAIR_LOOKUP_BURST);
    },
    20_000,
  );
});
