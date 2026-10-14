/*
 * A GeckoTerminal call the fleet budget REFUSES (`GECKOTERMINAL_BUDGET`) inside
 * the consensus sweep: the provider returns empty and stays available (the
 * budget, not a 429, said no — a `skip`). `collectProviderQuotes` used to read
 * "empty + available" as a healthy answer, so the chunk counted as COVERED:
 * the sweep baked `dexActive:false` on a real token and, with the miss ledger
 * on, recorded a definite miss for an address GeckoTerminal never looked at.
 * A refused chunk is UNKNOWN: no DEX verdict, no ledger miss.
 */
import { describe, expect, it, vi } from 'vitest';
import { PricingService } from '../../src/pricing/pricing.service.js';
import { GeckoTerminalProvider } from '../../src/pricing/providers/geckoterminal.provider.js';
import { runInLane } from '../../src/subgraph/hyperindex/indexer-context.js';
import type { TokenPriceRecord } from '../../src/database/token.repository.js';

const TOKEN = '0xed025a9fe4b30bcd68460bca42583090c2266468';

function aggregator(name: string, price: number | null) {
  return {
    name,
    supportsCurrentBatch: true,
    supportsHistoricalBatch: false,
    maxBatchSize: 50,
    singleConcurrency: 1,
    defaultBackoffMs: 0,
    isEnabled: () => true,
    isAvailable: () => true,
    getCurrentSingle: vi.fn(async () => null),
    getCurrentBatch: vi.fn(async (c: number, addrs: string[]) =>
      price === null ? new Map() : new Map(addrs.map((a) => [`${c}:${a}`, { priceUsd: price }])),
    ),
    getHistoricalSingle: vi.fn(async () => null),
    getMetrics: () => ({ success: 0, miss: 0, ratelimit: 0, error: 0, skip: 0 }),
  };
}

function harness(opts: { ledger: 'on' | 'off'; gtTake: () => Promise<number>; otherPrice: number | null }) {
  const captured: TokenPriceRecord[] = [];
  const recordedMisses: string[] = [];
  const other = aggregator('defillama', opts.otherPrice);
  const gt = new GeckoTerminalProvider({ geckoterminalBudget: 'shared' } as never, { take: vi.fn(opts.gtTake) });
  const svc = new PricingService(
    {
      priceFallbackEnabled: true,
      dexMarketMinVolumeUsd: 50,
      dexMarketMinCounterLiquidityUsd: 0,
      priceMissLedger: opts.ledger,
      // The SAME config the GT provider reads (in production both inject the one AppConfigService).
      geckoterminalBudget: 'shared',
    } as never,
    {
      findHistoricalNear: async () => null,
      findHistoricalNearMany: async () => new Map(),
      upsertHistorical: async () => {},
      upsertManyHistorical: async () => {},
    } as never,
    { currentProviders: () => [other, gt], historicalProviders: () => [], getMetricsSnapshot: () => ({}) } as never,
    { isListed: () => false } as never,
    {
      upsertPrices: async (_c: number, recs: TokenPriceRecord[]) => {
        captured.push(...recs);
      },
      findLatestPrices: async () => new Map(),
      findPriceMisses: async () => new Map(),
      recordPriceMisses: async (_c: number, addrs: string[]) => {
        recordedMisses.push(...addrs);
      },
      clearPriceMisses: async () => {},
    } as never,
  );
  return { svc, gt, captured, recordedMisses };
}

describe('defaults (no ledger, no GT budget): coverage is today\'s rule', () => {
  it('an empty chunk whose provider recorded an ERROR but stayed available still counts as covered (today)', async () => {
    const captured: TokenPriceRecord[] = [];
    let errors = 0;
    const dex = {
      ...aggregator('dexscreener', null),
      getCurrentBatch: vi.fn(async () => {
        errors += 1; // a 4xx the provider logged as `error` without backing off
        return new Map();
      }),
      getMetrics: () => ({ success: 0, miss: 0, ratelimit: 0, error: errors, skip: 0 }),
    };
    const other = aggregator('defillama', 0.0105);
    const build = (config: Record<string, unknown>) =>
      new PricingService(
        { priceFallbackEnabled: true, dexMarketMinVolumeUsd: 50, dexMarketMinCounterLiquidityUsd: 0, ...config } as never,
        { findHistoricalNear: async () => null, findHistoricalNearMany: async () => new Map(), upsertHistorical: async () => {}, upsertManyHistorical: async () => {} } as never,
        { currentProviders: () => [other, dex], historicalProviders: () => [], getMetricsSnapshot: () => ({}) } as never,
        { isListed: () => false } as never,
        {
          upsertPrices: async (_c: number, recs: TokenPriceRecord[]) => {
            captured.push(...recs);
          },
          findLatestPrices: async () => new Map(),
          findPriceMisses: async () => new Map(),
          recordPriceMisses: async () => {},
          clearPriceMisses: async () => {},
        } as never,
      );
    await build({}).prefetchConsensus(1, [TOKEN]);
    // Today: "available" = covered, so the DEX verdict is baked (false: no market seen).
    expect(captured.find((r) => r.address === TOKEN)?.dexActive).toBe(false);
    captured.length = 0;
    await build({ priceMissLedger: 'on' }).prefetchConsensus(1, [TOKEN]);
    // E's rules on: the error voids the chunk's coverage — no verdict.
    expect(captured.find((r) => r.address === TOKEN)?.dexActive).toBeUndefined();
  });
});

describe('consensus sweep — a GeckoTerminal budget refusal is UNKNOWN, never covered', () => {
  it('leaves dexActive undefined for a token another aggregator prices', async () => {
    const h = harness({ ledger: 'off', gtTake: async () => -90_000, otherPrice: 0.0105 });
    await runInLane({ lane: 'sweep', job: 'token-price-sync' }, () => h.svc.prefetchConsensus(1, [TOKEN]));
    expect(h.gt.getMetrics().skip).toBe(1);
    expect(h.gt.isAvailable()).toBe(true);
    const rec = h.captured.find((r) => r.address === TOKEN);
    expect(rec?.priceUsd).toBe(0.0105);
    expect(rec?.dexActive).toBeUndefined();
  });

  it('records no ledger miss when the refusal was the only thing GeckoTerminal "said"', async () => {
    const h = harness({ ledger: 'on', gtTake: async () => -90_000, otherPrice: null });
    await runInLane({ lane: 'sweep', job: 'token-price-sync' }, () => h.svc.prefetchConsensus(1, [TOKEN]));
    expect(h.gt.getMetrics().skip).toBe(1);
    expect(h.recordedMisses).toEqual([]);
  });

  it('control: a healthy empty GeckoTerminal answer still covers (so the verdict and the miss are real)', async () => {
    // Budget off → the request goes out; undici is not mocked here, so stub the
    // HTTP call on the instance to a real "no price" body.
    const h = harness({ ledger: 'on', gtTake: async () => 0, otherPrice: null });
    (h.gt as unknown as { httpJson: unknown }).httpJson = vi.fn(async () => ({
      statusCode: 200,
      data: { data: { attributes: { token_prices: {} } } },
    }));
    await runInLane({ lane: 'sweep', job: 'token-price-sync' }, () => h.svc.prefetchConsensus(1, [TOKEN]));
    expect(h.gt.getMetrics().miss).toBe(1);
    expect(h.recordedMisses).toEqual([TOKEN]);
  });
});
