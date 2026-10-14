import { afterEach, describe, expect, it, vi } from 'vitest';
import { PricingService } from '../../src/pricing/pricing.service.js';
import { DEXSCREENER_RESPONSE_PAIR_CAP, DexScreenerProvider } from '../../src/pricing/providers/dexscreener.provider.js';
import type { TokenPriceRecord, TokenTrustRecord } from '../../src/database/token.repository.js';

/**
 * DexScreener does not index Arbitrum's Uniswap v4 pools (probed 2026-10-08:
 * 0 of 32 pool ids). Once it joined PRICING_PROVIDERS it answered every
 * Arbitrum batch healthily and empty, `collectProviderQuotes` counted that as
 * "covered", and `dexActive = hasActiveMarket ? true : covered ? false : unknown`
 * turned "GeckoTerminal did not vouch this sweep" into "no real market" — the
 * no-real-market exclusion then hid clean Arbitrum tokens (USDG, RHUB, SPACEL)
 * and the flag flapped from sweep to sweep. A source that cannot see a chain's
 * venue (`DEXSCREENER_BLIND_CHAINS`, default 42161) must say nothing about it.
 */

const ARB = 42161;
const X = '0x000000000000000000000000000000000000c0de';
const P = '0x000000000000000000000000000000000000beef';
const USDC_ARB = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const tok = (i: number) => `0x${(0xa000 + i).toString(16).padStart(40, '0')}`;

type Q = Record<string, unknown> & { priceUsd: number };
function provider(name: string, quotes: Record<string, Q>, extra: Record<string, unknown> = {}) {
  return {
    name,
    supportsCurrentBatch: true,
    supportsHistoricalBatch: false,
    maxBatchSize: 50,
    singleConcurrency: 1,
    defaultBackoffMs: 0,
    isEnabled: () => true,
    isAvailable: () => true,
    getCurrentSingle: vi.fn(async (_c: number, a: string) => quotes[a.toLowerCase()] ?? null),
    getCurrentBatch: vi.fn(async (chainId: number, addrs: string[]) => {
      const out = new Map<string, Q>();
      for (const a of addrs) if (quotes[a.toLowerCase()]) out.set(`${chainId}:${a.toLowerCase()}`, quotes[a.toLowerCase()]!);
      return out;
    }),
    getHistoricalSingle: vi.fn(async () => null),
    getMetrics: () => ({ success: 0, miss: 0, ratelimit: 0, error: 0, skip: 0 }),
    ...extra,
  };
}

/** The real provider with its HTTP stubbed. */
function realDexScreener(config: Record<string, unknown>, answer: (url: string) => unknown) {
  const p = new DexScreenerProvider({
    pricingProviderMaxConcurrency: 4,
    pricingHistoricalSingleConcurrency: 4,
    dexscreenerBatchEndpoint: 'latest',
    ...config,
  } as never);
  const urls: string[] = [];
  vi.spyOn(p as unknown as { httpJson: (url: string) => Promise<unknown> }, 'httpJson').mockImplementation(async (url: string) => {
    urls.push(url);
    return { statusCode: 200, data: answer(url) };
  });
  return { p, urls };
}
const dsPair = (chain: string, base: string, i: number) => ({
  chainId: chain,
  pairAddress: `0x${(0xd000 + i).toString(16).padStart(40, '0')}`,
  priceUsd: '3',
  liquidity: { usd: 50_000, base: 1, quote: 25_000 },
  volume: { h24: 10_000 },
  baseToken: { address: base },
  quoteToken: { address: USDC_ARB },
});

const BLIND = { dexscreenerBlindChains: new Set([ARB]) };

afterEach(() => vi.restoreAllMocks());

describe('DexScreenerProvider on a blind chain', () => {
  it('a healthy answer without a pair for X marks X unseen — not covered, not uncertain — and P keeps its quote', async () => {
    const { p } = realDexScreener(BLIND, () => ({ pairs: [dsPair('arbitrum', P, 1)] }));
    const out = await p.getCurrentBatchWithCoverage(ARB, [P, X]);
    expect([...out.quotes.keys()]).toEqual([`${ARB}:${P}`]);
    expect([...(out.unseen ?? [])]).toEqual([X]);
    expect(out.uncertain.size).toBe(0);
  });

  it('a CAPPED answer on a blind chain is unseen too (nothing is "crowded out" evidence)', async () => {
    const pairs = Array.from({ length: DEXSCREENER_RESPONSE_PAIR_CAP }, (_, i) => dsPair('arbitrum', P, i));
    const { p } = realDexScreener(BLIND, () => ({ pairs }));
    const out = await p.getCurrentBatchWithCoverage(ARB, [P, X]);
    expect([...(out.unseen ?? [])]).toEqual([X]);
    expect(out.uncertain.size).toBe(0);
  });

  it('on a chain it can see, the same answer is a definite miss exactly as before (no unseen)', async () => {
    const { p } = realDexScreener(BLIND, () => ({ pairs: [dsPair('ethereum', P, 1)] }));
    const out = await p.getCurrentBatchWithCoverage(1, [P, X]);
    expect(out.unseen).toBeUndefined();
    expect(out.uncertain.size).toBe(0);
    expect(out.quotes.has(`1:${P}`)).toBe(true);
  });

  it('a config without the getter (every older spec, and "none") is today\'s behaviour on Arbitrum too', async () => {
    const { p } = realDexScreener({}, () => ({ pairs: [dsPair('arbitrum', P, 1)] }));
    const out = await p.getCurrentBatchWithCoverage(ARB, [P, X]);
    expect(out.unseen).toBeUndefined();
    const none = realDexScreener({ dexscreenerBlindChains: new Set<number>() }, () => ({ pairs: [dsPair('arbitrum', P, 1)] }));
    expect((await none.p.getCurrentBatchWithCoverage(ARB, [P, X])).unseen).toBeUndefined();
  });

  it('getTokenPairs sends nothing on a blind chain and answers null (no verdict), and still asks on a seen chain', async () => {
    const blind = realDexScreener(BLIND, () => []);
    expect(await blind.p.getTokenPairs(ARB, X)).toBeNull();
    expect(blind.urls).toEqual([]);
    const seen = realDexScreener(BLIND, () => [dsPair('ethereum', X, 1)]);
    expect(await seen.p.getTokenPairs(1, X)).not.toBeNull();
    expect(seen.urls).toHaveLength(1);
  });
});

// X: two independent aggregators agree, so the only thing left to judge is its DEX market.
const aggregatorsOnX = () => [provider('defillama', { [X]: { priceUsd: 2 } }), provider('coingecko', { [X]: { priceUsd: 2.01 } })];

function sweep(providers: unknown[], config: Record<string, unknown> = {}) {
  const prices: TokenPriceRecord[] = [];
  const verdicts: TokenTrustRecord[] = [];
  const tokens = {
    findLatestPrices: vi.fn(async () => new Map()),
    upsertPrices: vi.fn(async (_c: number, r: TokenPriceRecord[]) => void prices.push(...r)),
    upsertTrustEvidence: async (_c: number, r: TokenTrustRecord[]) => void verdicts.push(...r),
    clearGuardedPrices: vi.fn(async () => 0),
    findTrustState: async () => new Map(),
    findDexMarketState: async () => new Map(),
    findPriceMisses: vi.fn(async () => new Map()),
    recordPriceMisses: vi.fn(async () => {}),
    clearPriceMisses: vi.fn(async () => {}),
  };
  const svc = new PricingService(
    {
      priceFallbackEnabled: true,
      tokenListingGateEnabled: true,
      dexMarketMinVolumeUsd: 50,
      dexMarketMinCounterLiquidityUsd: 1000,
      pricingPrefetchChunkConcurrency: 2,
      ...config,
    } as never,
    {} as never,
    { currentProviders: () => providers, historicalProviders: () => providers } as never,
    { isListed: () => false } as never,
    tokens as never,
  );
  return { svc, record: (a: string) => prices.find((r) => r.address === a), verdict: (a: string) => verdicts.find((v) => v.address === a) };
}

describe('the sweep on a blind chain', () => {
  it('DexScreener\'s empty answer does not bake dexActive:false for X on Arbitrum (the omitted verdict keeps the previous one)', async () => {
    const ds = realDexScreener(BLIND, () => ({ pairs: [] }));
    const s = sweep([ds.p, ...aggregatorsOnX()], { tokenTrustShadow: 'on', dexscreenerBlindChains: new Set([ARB]) });
    await s.svc.prefetchConsensus(ARB, [X]);
    expect(s.record(X)).toBeDefined();
    expect(s.record(X)!.dexActive).toBeUndefined();
    expect(s.verdict(X)).toBeUndefined(); // and no "no-dex-market" verdict from a source that never looked
  });

  it('the SAME answer on a chain DexScreener sees stays a definite no-market (dexActive:false), as before', async () => {
    const ds = realDexScreener(BLIND, () => ({ pairs: [] }));
    const s = sweep([ds.p, ...aggregatorsOnX()], { tokenTrustShadow: 'on', dexscreenerBlindChains: new Set([ARB]) });
    await s.svc.prefetchConsensus(1, [X]);
    expect(s.record(X)?.dexActive).toBe(false);
  });

  it('a DEX source that CAN see the chain still vouches: GeckoTerminal\'s active market wins, its empty healthy answer still means no market', async () => {
    const ds = realDexScreener(BLIND, () => ({ pairs: [] }));
    const active = sweep(
      [ds.p, provider('geckoterminal', { [X]: { priceUsd: 2, volume24hUsd: 5_000 } }), ...aggregatorsOnX()],
      { tokenTrustShadow: 'on', dexscreenerBlindChains: new Set([ARB]) },
    );
    await active.svc.prefetchConsensus(ARB, [X]);
    expect(active.record(X)?.dexActive).toBe(true);
    const dead = sweep([ds.p, provider('geckoterminal', {}), ...aggregatorsOnX()], { tokenTrustShadow: 'on', dexscreenerBlindChains: new Set([ARB]) });
    await dead.svc.prefetchConsensus(ARB, [X]);
    expect(dead.record(X)?.dexActive).toBe(false); // GeckoTerminal looked and found nothing: that stays definite
  });

  it('a token DexScreener DOES price on a blind chain (a v3 pair) is still positive evidence', async () => {
    const ds = realDexScreener(BLIND, () => ({ pairs: [dsPair('arbitrum', X, 1)] }));
    const s = sweep([ds.p, ...aggregatorsOnX()], { tokenTrustShadow: 'on', dexscreenerBlindChains: new Set([ARB]) });
    await s.svc.prefetchConsensus(ARB, [X]);
    expect(s.record(X)?.dexActive).toBe(true);
  });

  it('with the blind list cleared ("none"), Arbitrum behaves exactly as it did before the knob', async () => {
    const ds = realDexScreener({ dexscreenerBlindChains: new Set<number>() }, () => ({ pairs: [] }));
    const s = sweep([ds.p, ...aggregatorsOnX()], { tokenTrustShadow: 'on', dexscreenerBlindChains: new Set<number>() });
    await s.svc.prefetchConsensus(ARB, [tok(1), X]);
    expect(s.record(X)?.dexActive).toBe(false);
  });
});
