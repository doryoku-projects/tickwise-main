import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PricingService } from '../../src/pricing/pricing.service.js';
import { DEXSCREENER_RESPONSE_PAIR_CAP, DexScreenerProvider } from '../../src/pricing/providers/dexscreener.provider.js';
import { DefillamaProvider } from '../../src/pricing/providers/defillama.provider.js';
import { GeckoTerminalProvider } from '../../src/pricing/providers/geckoterminal.provider.js';
import type { PriceProvider } from '../../src/pricing/providers/price-provider.interface.js';
import type { TokenPriceRecord, TokenTrustRecord } from '../../src/database/token.repository.js';

/**
 * Earned-trust evidence must come from answers that can vouch for a token.
 * Measured in prod (TOKEN_TRUST_SHADOW=on, Avalanche): trust=0/233, stored
 * reasons single-source 379 / no-dex-market 35 / stale-quote 2. Two causes:
 *  - DexScreener's /latest batch caps the WHOLE request at 30 pairs, so a
 *    token missing from a capped answer was counted as a definite "no pair";
 *  - a single-source / stale-quote failure was stored even when a provider
 *    that might hold the second source was skipped or could not vouch.
 * Latest mode keeps every SERVED value byte-identical; per-chain mode serves
 * the honest coverage too.
 */

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'; // anchor (stable)
const CBBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf'; // allowlisted
const BTCB = '0xb0f70c0bd6fd87dbeb7c10dc692a2a6106817072'; // not allowlisted
const POOL = '0x9c25d738109ff9ad10516f5f97ef24b9af51a9aa3db4b3b5728edf18a2d3f11c';
const X = '0x000000000000000000000000000000000000c0de'; // not listed, not an anchor
const DAY = 86_400_000;
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
type Stub = ReturnType<typeof provider>;

/** A DexScreener-like stub whose healthy answer cannot vouch for `uncertain` (a capped answer's absentees). */
function capped(p: Stub, uncertain: string[]): Stub {
  return {
    ...p,
    getCurrentBatchWithCoverage: vi.fn(async (chainId: number, addrs: string[]) => ({
      quotes: await p.getCurrentBatch(chainId, addrs),
      uncertain: new Set(addrs.map((a) => a.toLowerCase()).filter((a) => uncertain.includes(a))),
    })),
  };
}
const skipped = (p: Stub): Stub => ({ ...p, isAvailable: () => false });

/** The real provider with its HTTP stubbed: the request it sends and the answer it parses. */
function realDexScreener(mode: 'latest' | 'per-chain', answer: (url: string) => unknown) {
  const p = new DexScreenerProvider({ pricingProviderMaxConcurrency: 4, pricingHistoricalSingleConcurrency: 4, dexscreenerBatchEndpoint: mode } as never);
  const urls: string[] = [];
  vi.spyOn(p as unknown as { httpJson: (url: string) => Promise<unknown> }, 'httpJson').mockImplementation(async (url: string) => {
    urls.push(url);
    const out = answer(url);
    // `{ statusCode, data }` = that exact HTTP answer (a 429, a 404…); anything else is a 200 body.
    return out && typeof out === 'object' && 'statusCode' in out ? out : { statusCode: 200, data: out };
  });
  return { p, urls };
}
const dsPair = (base: string, i: number) => ({
  chainId: 'ethereum',
  pairAddress: `0x${(0xd000 + i).toString(16).padStart(40, '0')}`,
  priceUsd: '3',
  liquidity: { usd: 50_000, base: 1, quote: 25_000 },
  volume: { h24: 10_000 },
  baseToken: { address: base },
  quoteToken: { address: USDC },
});

function sweep(providers: unknown[], config: Record<string, unknown> = {}, stored: Record<string, number> = {}) {
  const prices: TokenPriceRecord[] = [];
  const verdicts: TokenTrustRecord[] = [];
  const tokens = {
    findLatestPrices: vi.fn(async (_c: number, addrs: string[]) =>
      new Map(addrs.filter((a) => a in stored).map((a) => [a, { priceUsd: stored[a]!, pricedAt: new Date() }])),
    ),
    upsertPrices: vi.fn(async (_c: number, r: TokenPriceRecord[]) => void prices.push(...r)),
    upsertTrustEvidence: async (_c: number, r: TokenTrustRecord[]) => void verdicts.push(...r),
    clearGuardedPrices: vi.fn(async (_c: number, rows: unknown[]) => rows.length),
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
    { isListed: (_c: number, a: string) => a === CBBTC } as never,
    tokens as never,
  );
  const record = (a: string) => prices.find((r) => r.address === a);
  const verdict = (a: string) => verdicts.find((v) => v.address === a);
  return { svc, prices, verdicts, tokens, record, verdict };
}

// X: two independent aggregators agree (a fresh consensus with a non-DEX
// source), so the only thing left to judge is its DEX market.
const aggregatorsOnX = () => [provider('defillama', { [X]: { priceUsd: 2 } }), provider('coingecko', { [X]: { priceUsd: 2.01 } })];

const M = tok(23);
// DexScreener's quote of a real two-pool market for `addr`: (b) and (c) hold
// (each pool $40k+ of USDC on a balanced counter side), so a DexScreener-only
// price leaves (a)/(d) as the only possible failure.
const dsMarket = (addr: string, priceUsd = 3) =>
  provider('dexscreener', {
    [addr]: {
      priceUsd,
      volume24hUsd: 9_000,
      counterLiquidity: 50_000,
      counterTokenAddress: USDC,
      dexPairs: [
        { id: '0xm1', liquidityUsd: 100_000, counterLiquidity: 50_000, counterTokenAddress: USDC },
        { id: '0xm2', liquidityUsd: 80_000, counterLiquidity: 40_000, counterTokenAddress: USDC },
      ],
      dexPairsComplete: true,
    },
  });

describe('latest mode (default): served data unchanged, no verdict on non-evidence', () => {
  it('a token a capped /latest answer left out keeps today\'s dexActive:false, and NO trust verdict is recorded for it', async () => {
    const popular = [0, 1, 2, 3, 4].map(tok);
    // The live shape: 30 pairs over 5 popular tokens, X crowded out.
    const pairs = Array.from({ length: DEXSCREENER_RESPONSE_PAIR_CAP }, (_, i) => dsPair(popular[i % 5]!, i));
    const ds = realDexScreener('latest', () => ({ pairs }));
    const s = sweep([ds.p, ...aggregatorsOnX()], { tokenTrustShadow: 'on' });
    const stats = await s.svc.prefetchConsensus(1, [...popular, X]);
    expect(ds.urls).toEqual([`https://api.dexscreener.com/latest/dex/tokens/${[...popular, X].join(',')}`]);
    expect(s.record(X)).toMatchObject({ priceUsd: 2.005, dexActive: false }); // today's served value
    // Before: `no-dex-market` on an answer that never looked at X.
    expect(s.verdict(X)).toBeUndefined();
    // The 5 popular tokens were answered (DexScreener-only → definite single-source).
    for (const a of popular) expect(s.verdict(a)).toMatchObject({ trustEarned: false, trustReason: 'single-source' });
    expect(stats).toMatchObject({ trustVerdicts: 5, trustUnknown: 1 });
  });

  it('per-chain mode does not bake dexActive:false for a token the DEX answer could not vouch for; latest still does', async () => {
    const latest = sweep([capped(provider('dexscreener', {}), [X]), ...aggregatorsOnX()], { tokenTrustShadow: 'on' });
    await latest.svc.prefetchConsensus(1, [X]);
    expect(latest.record(X)?.dexActive).toBe(false);
    const perChain = sweep([capped(provider('dexscreener', {}), [X]), ...aggregatorsOnX()], {
      tokenTrustShadow: 'on',
      dexscreenerBatchEndpoint: 'per-chain',
    });
    const stats = await perChain.svc.prefetchConsensus(1, [X]);
    expect(perChain.record(X)).toBeDefined();
    expect(perChain.record(X)!.dexActive).toBeUndefined(); // omitted: the previous verdict stays
    expect(perChain.verdict(X)).toBeUndefined();
    expect(stats.trustUnknown).toBe(1);
  });

  it('per-chain end to end: /tokens/v1/{chain}; a token absent from an UNCAPPED answer is a definite miss', async () => {
    const P = tok(0);
    const ds = realDexScreener('per-chain', () => [dsPair(P, 0)]);
    const s = sweep([ds.p, ...aggregatorsOnX()], { tokenTrustShadow: 'on', dexscreenerBatchEndpoint: 'per-chain' });
    await s.svc.prefetchConsensus(1, [P, X]);
    expect(ds.urls).toEqual([`https://api.dexscreener.com/tokens/v1/ethereum/${P},${X}`]);
    expect(s.record(X)?.dexActive).toBe(false);
    expect(s.verdict(X)).toMatchObject({ trustEarned: false, trustReason: 'no-dex-market' });
  });

  it('the guard\'s clear of a saved price needs a definite answer: latest counts an uncertain DEX answer (today), per-chain does not', async () => {
    const Z = tok(7);
    const stale = () => provider('dia', { [Z]: { priceUsd: 5, quotedAtMs: Date.now() - 40 * DAY, volume24hUsd: 1e6 } });
    const latest = sweep([stale(), capped(provider('dexscreener', {}), [Z])], { priceQuoteGuard: 'on' });
    await latest.svc.prefetchConsensus(1, [Z]);
    expect(latest.tokens.clearGuardedPrices).toHaveBeenCalledWith(1, [{ address: Z, rejectedSources: ['dia'] }], 'quote-guard');
    const perChain = sweep([stale(), capped(provider('dexscreener', {}), [Z])], { priceQuoteGuard: 'on', dexscreenerBatchEndpoint: 'per-chain' });
    await perChain.svc.prefetchConsensus(1, [Z]);
    expect(perChain.tokens.clearGuardedPrices).not.toHaveBeenCalled();
  });

  it('a miss-ledger entry needs a definite answer: latest counts an uncertain DEX answer (today), per-chain does not', async () => {
    const W = tok(8);
    const run = async (config: Record<string, unknown>) => {
      const s = sweep([capped(provider('dexscreener', {}), [W]), provider('defillama', {})], { priceMissLedger: 'on', ...config });
      await s.svc.prefetchConsensus(1, [W]);
      return s.tokens.recordPriceMisses;
    };
    expect(await run({})).toHaveBeenCalledWith(1, [W], expect.any(Date));
    expect(await run({ dexscreenerBatchEndpoint: 'per-chain' })).not.toHaveBeenCalled();
  });
});

describe('definite-only failures: single-source / stale-quote are stored only on a definite answer', () => {
  const S = tok(20);
  // S: priced by DeFiLlama alone; DexScreener answered (no pair); CoinGecko answered (nothing).
  const sources = () => [provider('dexscreener', {}), provider('defillama', { [S]: { priceUsd: 3 } }), provider('coingecko', {})];

  it('every provider ran and vouched for the token → single-source is stored', async () => {
    const s = sweep(sources(), { tokenTrustShadow: 'on' });
    const stats = await s.svc.prefetchConsensus(1, [S]);
    expect(s.verdict(S)).toMatchObject({ trustEarned: false, trustReason: 'single-source' });
    expect(stats).toMatchObject({ trustVerdicts: 1, trustUnknown: 0 });
  });

  it('a skipped (rate-limited) aggregator → no single-source verdict, counted unknown', async () => {
    // M: a real two-pool DEX market, priced by DexScreener alone — (b) and (c)
    // hold, so (a)/(d) is the only failure, and the skip makes it non-definite.
    const s = sweep([dsMarket(M), provider('defillama', {}), skipped(provider('coingecko', {}))], { tokenTrustShadow: 'on' });
    const stats = await s.svc.prefetchConsensus(1, [M]);
    expect(s.verdict(M)).toBeUndefined();
    expect(stats).toMatchObject({ trustVerdicts: 0, trustUnknown: 1 });
    expect(s.record(M)).toMatchObject({ priceUsd: 3, dexActive: true }); // the price itself is served as before
  });

  it('a skipped aggregator does NOT hide a definite (b) failure: the DEX answered with no live pair (a rug) → no-dex-market', async () => {
    // S: DeFiLlama alone, DexScreener answered healthily with no pair. (b)
    // comes from the DEX answers only; a missing aggregator could only have
    // added (a)/(d) support. Before: no verdict, and a stored `earned` row kept
    // its trust until it aged out (24 h).
    const [ds, llama, cg] = sources();
    const s = sweep([ds, llama, skipped(cg!)], { tokenTrustShadow: 'on' });
    const stats = await s.svc.prefetchConsensus(1, [S]);
    expect(s.verdict(S)).toMatchObject({ trustEarned: false, trustReason: 'no-dex-market', trustSources: [] });
    expect(stats).toMatchObject({ trustVerdicts: 1, trustUnknown: 0 });
    expect(s.record(S)).toMatchObject({ priceUsd: 3, dexActive: false });
  });

  it('… nor a definite (c) failure: one complete pool (a seeded single-sided launch) → single-pool', async () => {
    const seed = { id: '0xseed', liquidityUsd: 2_000_000, counterLiquidity: 2_000, counterTokenAddress: USDC };
    const ds = provider('dexscreener', {
      [M]: { priceUsd: 3, volume24hUsd: 9_000, counterLiquidity: 2_000, counterTokenAddress: USDC, dexPairs: [seed], dexPairsComplete: true },
    });
    const s = sweep([ds, provider('defillama', {}), skipped(provider('coingecko', {}))], { tokenTrustShadow: 'on' });
    await s.svc.prefetchConsensus(1, [M]);
    expect(s.verdict(M)).toMatchObject({ trustEarned: false, trustReason: 'single-pool', dexPoolCount: 0 });
  });

  it('a provider that ran but could not vouch (capped DexScreener answer) → no single-source verdict, and GeckoTerminal\'s certain "no pool" alone is no (b) failure either', async () => {
    const [ds, llama, cg] = sources();
    const s = sweep([capped(ds!, [S]), provider('geckoterminal', {}), llama, cg], { tokenTrustShadow: 'on' });
    const stats = await s.svc.prefetchConsensus(1, [S]);
    // Not `single-source` (DexScreener might hold the second source), and not
    // `no-dex-market` (DexScreener might hold the market): one DEX that looked
    // and found nothing is not every DEX market. Withheld.
    expect(s.verdict(S)).toBeUndefined();
    expect(stats).toMatchObject({ trustVerdicts: 0, trustUnknown: 1 });
    expect(s.record(S)).toMatchObject({ priceUsd: 3, dexActive: false }); // latest mode serves today's verdict
  });

  it('fresh quotes that DISAGREE are definite: a previously earned token loses trust on this sweep even with an aggregator skipped', async () => {
    // DexScreener $100 (a real market), DeFiLlama $1: sources that answered
    // contradict each other — contrary evidence, not missing evidence.
    const ds = dsMarket(M, 100);
    const s = sweep([ds, provider('defillama', { [M]: { priceUsd: 1 } }), skipped(provider('coingecko', {}))], { tokenTrustShadow: 'on' });
    const stats = await s.svc.prefetchConsensus(1, [M]);
    expect(s.verdict(M)).toMatchObject({ trustEarned: false, trustReason: 'single-source' });
    expect(stats).toMatchObject({ trustVerdicts: 1, trustUnknown: 0 });
    // …while ONE source with a skipped aggregator is missing evidence: withheld.
    const lone = sweep([dsMarket(M, 100), provider('defillama', {}), skipped(provider('coingecko', {}))], { tokenTrustShadow: 'on' });
    await lone.svc.prefetchConsensus(1, [M]);
    expect(lone.verdict(M)).toBeUndefined();
  });

  it('stale-quote follows the same rule', async () => {
    const T = tok(21);
    const make = () => [
      provider('dia', { [T]: { priceUsd: 2, quotedAtMs: Date.now() - 40 * DAY, volume24hUsd: 1e6 } }),
      provider('dexscreener', { [T]: { priceUsd: 2, volume24hUsd: 9_000, dexPairs: [] } }),
      provider('coingecko', {}),
    ];
    const ok = sweep(make(), { tokenTrustShadow: 'on' });
    await ok.svc.prefetchConsensus(1, [T]);
    expect(ok.verdict(T)).toMatchObject({ trustEarned: false, trustReason: 'stale-quote' });
    const [dia, ds, cg] = make();
    const notOk = sweep([dia, ds, skipped(cg!)], { tokenTrustShadow: 'on' });
    const stats = await notOk.svc.prefetchConsensus(1, [T]);
    expect(notOk.verdict(T)).toBeUndefined();
    expect(stats.trustUnknown).toBe(1);
  });

  it('a positive verdict is still stored when a provider was skipped (missing sources only take trust away)', async () => {
    const s = sweep(
      [
        provider('defillama', { [BTCB]: { priceUsd: 85_852, quotedAtMs: Date.now() - 600_000 } }),
        provider('dexscreener', {
          [BTCB]: {
            priceUsd: 85_300,
            volume24hUsd: 60_866,
            counterLiquidity: 49.1352,
            counterTokenAddress: CBBTC,
            dexPairs: [{ id: POOL, liquidityUsd: 8_530_070, counterLiquidity: 49.1352, counterTokenAddress: CBBTC }],
            dexPairsComplete: true,
          },
        }),
        skipped(provider('coingecko', {})),
      ],
      { tokenTrustShadow: 'on' },
      { [CBBTC]: 85_300 },
    );
    const stats = await s.svc.prefetchConsensus(1, [BTCB]);
    expect(s.verdict(BTCB)).toMatchObject({ trustEarned: true, trustReason: 'earned' });
    expect(stats).toMatchObject({ trustVerdicts: 1, trustEarned: 1, trustUnknown: 0 });
  });

  it('no-dex-market keeps its own rule (a definite DEX answer) when an unrelated provider was skipped', async () => {
    const s = sweep([provider('dexscreener', {}), ...aggregatorsOnX(), skipped(provider('dia', {}))], { tokenTrustShadow: 'on' });
    await s.svc.prefetchConsensus(1, [X]);
    expect(s.verdict(X)).toMatchObject({ trustEarned: false, trustReason: 'no-dex-market' });
  });

  it('"single pool" on a sample stores nothing and is counted unknown', async () => {
    const T = tok(22);
    const weak = { id: '0xweak', liquidityUsd: 2_000_000, counterLiquidity: 500, counterTokenAddress: USDC };
    const s = sweep(
      [
        provider('defillama', { [T]: { priceUsd: 4 } }),
        provider('dexscreener', { [T]: { priceUsd: 4, volume24hUsd: 9_000, counterLiquidity: 5_000, counterTokenAddress: USDC, dexPairs: [weak], dexPairsComplete: false } }),
      ],
      { tokenTrustShadow: 'on' },
    );
    const stats = await s.svc.prefetchConsensus(1, [T]);
    expect(s.verdict(T)).toBeUndefined();
    expect(stats).toMatchObject({ trustVerdicts: 0, trustUnknown: 1 });
  });

  it('trust evidence off: nothing is counted', async () => {
    const s = sweep(sources());
    expect(await s.svc.prefetchConsensus(1, [S])).toMatchObject({ trustVerdicts: 0, trustUnknown: 0 });
  });
});

describe('collectProviderQuotes coverage', () => {
  type Collect = (p: unknown, chainId: number, addrs: string[], opts?: unknown) => Promise<{ quotes: Map<string, unknown>; covered: Set<string>; uncertain: Set<string> }>;
  const collect = (svc: PricingService): Collect => (svc as unknown as { collectProviderQuotes: Collect }).collectProviderQuotes.bind(svc);
  const [A, B, C] = [tok(30), tok(31), tok(32)];

  it('uncertain ⊆ covered, never a quoted address, and an unhealthy chunk is neither', async () => {
    let healthy = true;
    const base = provider('dexscreener', { [A]: { priceUsd: 1 } }, { maxBatchSize: 2, isAvailable: () => healthy });
    const p = {
      ...base,
      getCurrentBatchWithCoverage: vi.fn(async (chainId: number, addrs: string[]) => {
        if (addrs.includes(C)) {
          healthy = false; // a 429 on the second chunk: empty answer, provider down
          return { quotes: new Map(), uncertain: new Set(addrs) };
        }
        // A provider bug claiming a QUOTED address is uncertain must not leak through.
        return { quotes: await base.getCurrentBatch(chainId, addrs), uncertain: new Set([A, B]) };
      }),
    };
    const { svc } = sweep([]);
    const out = await collect(svc)(p, 1, [A, B, C]);
    expect([...out.quotes.keys()]).toEqual([A]);
    expect([...out.covered].sort()).toEqual([A, B].sort());
    expect([...out.uncertain]).toEqual([B]);
    expect(base.getCurrentBatch).toHaveBeenCalledTimes(1); // only through the coverage form's own delegate
  });

  it('a provider without the coverage form vouches for every address of a healthy answer (today)', async () => {
    const p = provider('defillama', { [A]: { priceUsd: 1 } });
    const { svc } = sweep([]);
    const out = await collect(svc)(p, 1, [A, B]);
    expect([...out.covered].sort()).toEqual([A, B].sort());
    expect(out.uncertain.size).toBe(0);
  });

  it('an empty chunk whose error count rose is covered (today) but uncertain; strict health keeps it out of covered', async () => {
    const metrics = { success: 0, miss: 0, ratelimit: 0, error: 0, skip: 0 };
    const p = provider('defillama', {}, {
      getMetrics: () => ({ ...metrics }),
      getCurrentBatch: vi.fn(async () => {
        metrics.error += 1; // a thrown request: empty answer, provider still available
        return new Map();
      }),
    });
    const out = await collect(sweep([]).svc)(p, 1, [A, B]);
    expect([...out.covered].sort()).toEqual([A, B].sort());
    expect([...out.uncertain].sort()).toEqual([A, B].sort());
    const strict = await collect(sweep([], { priceMissLedger: 'on' }).svc)(p, 1, [A, B]);
    expect(strict.covered.size).toBe(0);
  });

  it('singles: a failed lookup (error) is covered but uncertain; a `skip` alone (CoinGecko\'s current no-op) still vouches', async () => {
    const single = (outcome: 'error' | 'skip') => {
      const metrics = { success: 0, miss: 0, ratelimit: 0, error: 0, skip: 0 };
      return provider(outcome === 'error' ? 'dia' : 'coingecko', {}, {
        supportsCurrentBatch: false,
        getMetrics: () => ({ ...metrics }),
        getCurrentSingle: vi.fn(async () => {
          metrics[outcome] += 1;
          return null;
        }),
      });
    };
    const { svc } = sweep([]);
    const failed = await collect(svc)(single('error'), 1, [A]);
    expect([...failed.covered]).toEqual([A]);
    expect([...failed.uncertain]).toEqual([A]);
    const skipped = await collect(svc)(single('skip'), 1, [A]);
    expect([...skipped.covered]).toEqual([A]);
    expect(skipped.uncertain.size).toBe(0);
  });
});

describe('per-token pair lookups per sweep, by endpoint', () => {
  // Every token passes (a)/(b)/(d) and has no pool evidence → each needs its own pairs.
  const run = async (n: number, config: Record<string, unknown>) => {
    const many = Array.from({ length: n }, (_, i) => tok(100 + i));
    const q = Object.fromEntries(many.map((a) => [a, { priceUsd: 2, volume24hUsd: 9_000 }]));
    const getTokenPairs = vi.fn(async () => null);
    const s = sweep([provider('dexscreener', {}, { getTokenPairs }), provider('defillama', q), provider('geckoterminal', q)], {
      tokenTrustShadow: 'on',
      ...config,
    });
    const stats = await s.svc.prefetchConsensus(1, many);
    return { calls: getTokenPairs.mock.calls.length, stats };
  };

  it('latest: 25; per-chain: 100 (every batch answer is a one-pair sample)', async () => {
    expect((await run(120, {})).calls).toBe(25);
    const perChain = await run(120, { dexscreenerBatchEndpoint: 'per-chain' });
    expect(perChain.calls).toBe(100);
    expect(perChain.stats).toMatchObject({ trustVerdicts: 0, trustUnknown: 120 });
  });
});

describe('the pair-lookup budget charges requests, not cache hits', () => {
  it('per-chain: 120 tokens that all need their own pairs — the 20 the first sweep could not ask get verdicts on the second (warm cache)', async () => {
    const many = Array.from({ length: 120 }, (_, i) => tok(200 + i));
    let pairRequests = 0;
    const ds = realDexScreener('per-chain', (url) => {
      const tail = url.slice(url.lastIndexOf('/') + 1);
      if (url.includes('/token-pairs/v1/')) {
        pairRequests += 1;
        return [dsPair(tail, 1), dsPair(tail, 2)]; // two real pools: (c) holds
      }
      return tail.split(',').map((a, i) => dsPair(a, i)); // per-chain: one pair per token, a sample
    });
    const s = sweep([ds.p, provider('defillama', Object.fromEntries(many.map((a) => [a, { priceUsd: 3 }])))], {
      tokenTrustShadow: 'on',
      dexscreenerBatchEndpoint: 'per-chain',
    });
    const first = await s.svc.prefetchConsensus(1, many);
    expect(pairRequests).toBe(100);
    expect(first).toMatchObject({ trustVerdicts: 100, trustEarned: 100, trustUnknown: 20 });
    s.verdicts.length = 0;
    const second = await s.svc.prefetchConsensus(1, many);
    // The 100 cached answers cost nothing, so the budget reaches the last 20.
    expect(pairRequests).toBe(120);
    expect(second).toMatchObject({ trustVerdicts: 120, trustEarned: 120, trustUnknown: 0 });
    for (const a of many.slice(100)) expect(s.verdict(a)).toMatchObject({ trustEarned: true });
  });
});

describe("per-chain: a floor failure on DexScreener's ONE pair is checked against the token's own pairs", () => {
  const T = tok(400);
  // DexScreener's pick (busiest, not deepest): $200 of USDC on its counter side.
  const dust = { ...dsPair(T, 1), liquidity: { usd: 400, base: 1, quote: 200 }, volume: { h24: 10_000 } };
  const deep = { ...dsPair(T, 2), liquidity: { usd: 100_000, base: 1, quote: 50_000 }, volume: { h24: 500 } };
  const run = async (mode: 'latest' | 'per-chain', tokenPairs: () => unknown) => {
    const ds = realDexScreener(mode, (url) => (url.includes('/token-pairs/') ? tokenPairs() : mode === 'per-chain' ? [dust] : { pairs: [dust] }));
    const s = sweep([ds.p], mode === 'per-chain' ? { dexscreenerBatchEndpoint: 'per-chain' } : {});
    await s.svc.prefetchConsensus(1, [T]);
    return { record: s.record(T), pairLookups: ds.urls.filter((u) => u.includes('/token-pairs/')).length };
  };

  it("the token's own deeper pair clears the floor → served dexActive:true, with its own market's counter / volume (no trust flag needed)", async () => {
    const r = await run('per-chain', () => [dust, deep]);
    expect(r.record).toMatchObject({ dexActive: true, dexCounterLiquidity: 50_000, dexVolume24h: 10_500 });
    expect(r.pairLookups).toBe(1);
  });

  it("its own pairs fail too, or none can be had (429) → the sample's dexActive:false stands", async () => {
    expect((await run('per-chain', () => [dust])).record).toMatchObject({ dexActive: false, dexCounterLiquidity: 200 });
    expect((await run('per-chain', () => ({ statusCode: 429, data: null }))).record).toMatchObject({ dexActive: false });
  });

  it('latest mode never asks (today: the deepest pair of its answer decides)', async () => {
    const r = await run('latest', () => [dust, deep]);
    expect(r.record).toMatchObject({ dexActive: false });
    expect(r.pairLookups).toBe(0);
  });
});

describe('a failed call from a provider that stays available does not vouch (strict health off, the default)', () => {
  it('a thrown / 404 / 200-null DeFiLlama batch: no stored single-source for a DexScreener-only token', async () => {
    for (const fail of ['throw', 404, 'null'] as const) {
      const llama = new DefillamaProvider({ pricingProviderMaxConcurrency: 4, pricingHistoricalSingleConcurrency: 4 } as never);
      vi.spyOn(llama as unknown as { httpJson: () => Promise<unknown> }, 'httpJson').mockImplementation(async () => {
        if (fail === 'throw') throw new Error('socket hang up');
        return { statusCode: fail === 404 ? 404 : 200, data: null };
      });
      const s = sweep([dsMarket(M), llama], { tokenTrustShadow: 'on' });
      const stats = await s.svc.prefetchConsensus(1, [M]);
      expect(llama.isAvailable(), String(fail)).toBe(true); // no backoff: it "ran"
      expect(s.verdict(M), String(fail)).toBeUndefined();
      expect(stats, String(fail)).toMatchObject({ trustVerdicts: 0, trustUnknown: 1 });
      expect(s.record(M), String(fail)).toMatchObject({ priceUsd: 3 }); // served as before
    }
  });

  it('a GeckoTerminal 4xx next to a capped DexScreener answer: no no-dex-market verdict (no DEX looked); served latest data unchanged', async () => {
    const gt = new GeckoTerminalProvider();
    vi.spyOn(gt as unknown as { httpJson: () => Promise<unknown> }, 'httpJson').mockResolvedValue({ statusCode: 404, data: null });
    const s = sweep([capped(provider('dexscreener', {}), [X]), gt, ...aggregatorsOnX()], { tokenTrustShadow: 'on' });
    const stats = await s.svc.prefetchConsensus(1, [X]);
    expect(gt.isAvailable()).toBe(true);
    expect(s.verdict(X)).toBeUndefined();
    expect(stats.trustUnknown).toBe(1);
    expect(s.record(X)?.dexActive).toBe(false); // latest mode serves today's verdict
  });
});

/**
 * (b) — "no DEX market" — is a claim about every DEX market, so a stored
 * `no-dex-market` needs every DEX-market provider that RAN to have vouched for
 * the token. Live, latest mode on 4663: WETH ($263M of 24h volume on
 * DexScreener) and MJ were stored `no-dex-market` because DexScreener's capped
 * /latest answer left them out while GeckoTerminal answered "no pool" with
 * certainty — `dexCertain` was a union. Served `dexActive` is untouched.
 */
describe('no-dex-market needs every DEX-market provider that ran to vouch (trust verdict only)', () => {
  const W = tok(600);
  // W: two aggregators agree (a)/(d) hold; no DEX quotes it.
  const aggs = () => [provider('defillama', { [W]: { priceUsd: 2 } }), provider('coingecko', { [W]: { priceUsd: 2.01 } })];

  it('latest end to end: a capped DexScreener answer left W out, GeckoTerminal is certain → withheld; served dexActive:false as today', async () => {
    const popular = [0, 1, 2, 3, 4].map((i) => tok(610 + i));
    const pairs = Array.from({ length: DEXSCREENER_RESPONSE_PAIR_CAP }, (_, i) => dsPair(popular[i % 5]!, i));
    const ds = realDexScreener('latest', () => ({ pairs }));
    const s = sweep([ds.p, provider('geckoterminal', {}), ...aggs()], { tokenTrustShadow: 'on' });
    const stats = await s.svc.prefetchConsensus(1, [...popular, W]);
    expect(s.verdict(W)).toBeUndefined();
    expect(stats.trustUnknown).toBe(1);
    expect(s.record(W)).toMatchObject({ priceUsd: 2.005, dexActive: false }); // byte-identical served value
  });

  it('every DEX that ran answered with certainty (no pair, no pool) → no-dex-market is stored', async () => {
    const s = sweep([provider('dexscreener', {}), provider('geckoterminal', {}), ...aggs()], { tokenTrustShadow: 'on' });
    const stats = await s.svc.prefetchConsensus(1, [W]);
    expect(s.verdict(W)).toMatchObject({ trustEarned: false, trustReason: 'no-dex-market' });
    expect(stats).toMatchObject({ trustVerdicts: 1, trustUnknown: 0 });
  });

  it('a SKIPPED DEX provider does not block: DexScreener certain, GeckoTerminal rate-limited → no-dex-market is stored', async () => {
    // A DEX provider is waited out (≤ 3 min) before it counts as skipped: let the clock run.
    vi.useFakeTimers();
    try {
      const gt = skipped(provider('geckoterminal', {}));
      const s = sweep([provider('dexscreener', {}), gt, ...aggs()], { tokenTrustShadow: 'on' });
      const done = s.svc.prefetchConsensus(1, [W]);
      await vi.advanceTimersByTimeAsync(200_000);
      const stats = await done;
      expect(gt.getCurrentBatch).not.toHaveBeenCalled(); // really skipped
      expect(s.verdict(W)).toMatchObject({ trustEarned: false, trustReason: 'no-dex-market' });
      expect(stats).toMatchObject({ trustVerdicts: 1, trustUnknown: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('… but a SKIPPED DexScreener (the pair-evidence source) blocks it: GeckoTerminal\'s certain "no pool" alone → withheld; served as today', async () => {
    // Live probe P1b: the WETH-on-4663 failure (GeckoTerminal sure there is
    // no pool, DexScreener never looked), reached through a skip, not a cap.
    vi.useFakeTimers();
    try {
      const ds = skipped(provider('dexscreener', {}, { getTokenPairs: vi.fn(async () => null) }));
      const s = sweep([ds, provider('geckoterminal', {}), ...aggs()], { tokenTrustShadow: 'on' });
      const done = s.svc.prefetchConsensus(1, [W]);
      await vi.advanceTimersByTimeAsync(200_000);
      const stats = await done;
      expect(ds.getCurrentBatch).not.toHaveBeenCalled(); // really skipped
      expect(s.verdict(W)).toBeUndefined();
      expect(stats).toMatchObject({ trustVerdicts: 0, trustUnknown: 1 });
      expect(s.record(W)?.dexActive).toBe(false); // GeckoTerminal's certain answer, as served today
    } finally {
      vi.useRealTimers();
    }
  });

  it('a DEX provider that ran and failed outright did not vouch → withheld', async () => {
    const broken = provider('geckoterminal', {}, { getCurrentBatch: vi.fn(async () => { throw new Error('socket hang up'); }) });
    const s = sweep([provider('dexscreener', {}), broken, ...aggs()], { tokenTrustShadow: 'on' });
    const stats = await s.svc.prefetchConsensus(1, [W]);
    expect(s.verdict(W)).toBeUndefined();
    expect(stats.trustUnknown).toBe(1);
  });

  it('the sources-assumed re-judge (rug path) follows it: a lone DeFiLlama price, an aggregator skipped, DexScreener capped, GeckoTerminal certain → withheld', async () => {
    const R = tok(620);
    const run = async (dexes: Stub[]) => {
      const s = sweep([...dexes, provider('defillama', { [R]: { priceUsd: 3 } }), skipped(provider('coingecko', {}))], { tokenTrustShadow: 'on' });
      await s.svc.prefetchConsensus(1, [R]);
      return s;
    };
    expect((await run([capped(provider('dexscreener', {}), [R]), provider('geckoterminal', {})])).verdict(R)).toBeUndefined();
    // Every DEX that ran certain: the rug is still revoked.
    expect((await run([provider('dexscreener', {}), provider('geckoterminal', {})])).verdict(R)).toMatchObject({ trustReason: 'no-dex-market' });
  });

  it('per-chain mode: the same rule for the verdict (served dexActive keeps per-chain\'s own rule)', async () => {
    const s = sweep([capped(provider('dexscreener', {}), [W]), provider('geckoterminal', {}), ...aggs()], {
      tokenTrustShadow: 'on',
      dexscreenerBatchEndpoint: 'per-chain',
    });
    await s.svc.prefetchConsensus(1, [W]);
    expect(s.verdict(W)).toBeUndefined();
    expect(s.record(W)?.dexActive).toBe(false); // GeckoTerminal's certain answer, as per-chain served it before
  });
});

/**
 * Live, 4663 latest mode: 18 verdicts earned where origin/main earned 21. A
 * token whose (a)/(d) failure was withheld (sources ASSUMED) spent the
 * per-sweep lookup budget on its single-pool re-check — whose best outcome is a
 * stored `single-pool` — so tokens later in the list that could earn (PLTR,
 * USO, INJOH) got no lookup. The assumed path reads cached evidence only.
 */
describe('the sources-assumed re-judge never spends the pair-lookup budget', () => {
  const weak = { id: '0xweak', liquidityUsd: 2_000_000, counterLiquidity: 500, counterTokenAddress: USDC };
  const twoPools = {
    pairs: [
      { id: '0xp1', liquidityUsd: 100_000, counterLiquidity: 50_000, counterTokenAddress: USDC },
      { id: '0xp2', liquidityUsd: 80_000, counterLiquidity: 40_000, counterTokenAddress: USDC },
    ],
    complete: true,
  };
  // A sampled one-weak-pool DEX market: (b) holds, (c) needs the token's own pairs.
  const sampled = { priceUsd: 4, volume24hUsd: 9_000, counterLiquidity: 5_000, counterTokenAddress: USDC, dexPairs: [weak], dexPairsComplete: false };

  for (const [mode, budget] of [['latest', 25], ['per-chain', 100]] as const) {
    it(`${mode}: ${budget} assumed-path tokens first, then a token that can earn → it gets its lookup and earns; the assumed ones make no request`, async () => {
      const assumed = Array.from({ length: budget }, (_, i) => tok(800 + i));
      const E = tok(990);
      const cachedOne = assumed[0]!;
      const getTokenPairs = vi.fn(async () => twoPools);
      const ds = provider('dexscreener', Object.fromEntries([...assumed, E].map((a) => [a, sampled])), {
        getTokenPairs,
        // A cached answer is still read on the assumed path (no request, no budget).
        cachedTokenPairs: (_c: number, a: string) => (a === cachedOne ? { pairs: [weak], complete: true } : undefined),
      });
      // Only E has a second (non-DEX) source; CoinGecko is skipped, so the
      // assumed tokens' lone DexScreener price is a withheld (a)/(d) failure.
      const s = sweep([ds, provider('defillama', { [E]: { priceUsd: 4 } }), skipped(provider('coingecko', {}))], {
        tokenTrustShadow: 'on',
        ...(mode === 'per-chain' ? { dexscreenerBatchEndpoint: 'per-chain' } : {}),
      });
      const stats = await s.svc.prefetchConsensus(1, [...assumed, E]);
      expect(getTokenPairs.mock.calls).toEqual([[1, E]]);
      expect(s.verdict(E)).toMatchObject({ trustEarned: true, trustReason: 'earned' });
      // The cached complete single pool is stored as such; the rest are unknown.
      expect(s.verdict(cachedOne)).toMatchObject({ trustEarned: false, trustReason: 'single-pool' });
      expect(stats).toMatchObject({ trustVerdicts: 2, trustEarned: 1, trustUnknown: budget - 1 });
    });
  }
});

describe('a cached pair answer is read after the budget is spent', () => {
  for (const [mode, budget] of [['latest', 25], ['per-chain', 100]] as const) {
    it(`${mode}: ${budget} lookups spend the budget; a later token whose pairs are cached still gets its verdict with no request`, async () => {
      const many = Array.from({ length: budget }, (_, i) => tok(1100 + i));
      const C = tok(1300);
      const q = Object.fromEntries([...many, C].map((a) => [a, { priceUsd: 2, volume24hUsd: 9_000 }]));
      const getTokenPairs = vi.fn(async () => null);
      const cached = {
        pairs: [
          { id: '0xc1', liquidityUsd: 100_000, counterLiquidity: 50_000, counterTokenAddress: USDC },
          { id: '0xc2', liquidityUsd: 80_000, counterLiquidity: 40_000, counterTokenAddress: USDC },
        ],
        complete: true,
      };
      const ds = provider('dexscreener', {}, { getTokenPairs, cachedTokenPairs: (_c: number, a: string) => (a === C ? cached : undefined) });
      const s = sweep([ds, provider('defillama', q), provider('geckoterminal', q)], {
        tokenTrustShadow: 'on',
        ...(mode === 'per-chain' ? { dexscreenerBatchEndpoint: 'per-chain' } : {}),
      });
      const stats = await s.svc.prefetchConsensus(1, [...many, C]);
      expect(getTokenPairs).toHaveBeenCalledTimes(budget);
      expect(getTokenPairs.mock.calls.some(([, a]) => a === C)).toBe(false);
      expect(s.verdict(C)).toMatchObject({ trustEarned: true, trustReason: 'earned', dexPoolCount: 2 });
      expect(stats).toMatchObject({ trustVerdicts: 1, trustUnknown: budget });
    });
  }
});

/**
 * (b) read off a SAMPLE of a token's pairs flipped with the tokens sharing its
 * batch, both ways (live probes P2b / P4, latest mode): its only sampled pair a
 * $500-counter pool → `no-dex-market` every sweep (Mongo `distinct` is sorted,
 * so the batch, and the verdict, repeat) where the full answer earns; a sample
 * that left out its deepest pair, a single-sided seed → `earned`, where the
 * full answer says `no-dex-market`. Served data is never re-checked in latest
 * mode; the verdict reads the token's own pairs.
 */
describe('latest mode: a capped sample is never re-checked for SERVED data; the verdict reads the token\'s own pairs', () => {
  const popular = [0, 1, 2, 3, 4].map((i) => tok(1410 + i));
  // DexScreener-only popular tokens: definite single-source, no pair lookup.
  const fill = (n: number) => Array.from({ length: n }, (_, i) => dsPair(popular[i % 5]!, i));
  const T = tok(1400);
  const pool = (i: number, usd: number, counter: number, h24: number) => ({ ...dsPair(T, 100 + i), liquidity: { usd, base: 1, quote: counter }, volume: { h24 } });
  // Four sources agree on $3; GeckoTerminal carries $90k of volume (no counter side).
  const sources = () => [provider('defillama', { [T]: { priceUsd: 3 } }), provider('coingecko', { [T]: { priceUsd: 3 } }), provider('geckoterminal', { [T]: { priceUsd: 3, volume24hUsd: 90_000 } })];
  /** One sweep of `[…popular, T]` with T's batch pairs `inBatch` (capped: `fill` makes the answer 30 pairs) and its own pairs `own`. */
  const run = async (inBatch: unknown[], own: () => unknown, opts: { capped: boolean; shadow?: boolean }) => {
    const pairs = [...fill(opts.capped ? DEXSCREENER_RESPONSE_PAIR_CAP - inBatch.length : 5), ...inBatch];
    const ds = realDexScreener('latest', (url) => (url.includes('/token-pairs/') ? own() : { pairs }));
    const s = sweep([ds.p, ...sources()], opts.shadow === false ? {} : { tokenTrustShadow: 'on' });
    const stats = await s.svc.prefetchConsensus(1, [...popular, T]);
    return { s, stats, pairLookups: ds.urls.filter((u) => u.includes('/token-pairs/')) };
  };

  it('P2b: its only sampled pair is a $500-counter pool → served dexActive:false as today, and the verdict is the one an uncapped answer gets (earned), not no-dex-market', async () => {
    const small = pool(0, 1_000, 500, 10);
    const deep = [pool(1, 100_000, 50_000, 40_000), pool(2, 80_000, 40_000, 30_000)];
    const capped = await run([small], () => [small, ...deep], { capped: true });
    expect(capped.s.record(T)).toMatchObject({ dexActive: false, dexCounterLiquidity: 500, dexVolume24h: 90_000 }); // byte-identical served value
    expect(capped.pairLookups).toEqual([`https://api.dexscreener.com/token-pairs/v1/ethereum/${T}`]); // one request: (b) and (c) share it
    expect(capped.s.verdict(T)).toMatchObject({ trustEarned: true, trustReason: 'earned' });
    const uncapped = await run([small, ...deep], () => [small, ...deep], { capped: false });
    expect(uncapped.s.record(T)).toMatchObject({ dexActive: true });
    expect(uncapped.pairLookups).toEqual([]);
    expect(uncapped.s.verdict(T)).toMatchObject({ trustEarned: true, trustReason: 'earned' });
  });

  it('P2b on a SECOND sweep: the own answer the first one cached is in reach, and served data is still never re-checked (latest\'s served budget is 0 — only the mode guard stops a cached read)', async () => {
    const small = pool(0, 1_000, 500, 10);
    const deep = [pool(1, 100_000, 50_000, 40_000), pool(2, 80_000, 40_000, 30_000)];
    const pairs = [...fill(DEXSCREENER_RESPONSE_PAIR_CAP - 1), small];
    const ds = realDexScreener('latest', (url) => (url.includes('/token-pairs/') ? [small, ...deep] : { pairs }));
    const s = sweep([ds.p, ...sources()], { tokenTrustShadow: 'on' });
    await s.svc.prefetchConsensus(1, [...popular, T]);
    expect(ds.p.cachedTokenPairs(1, T)).toBeDefined(); // the verdict's answer, cached
    await s.svc.prefetchConsensus(1, [...popular, T]);
    const served = s.prices.filter((r) => r.address === T);
    expect(served).toHaveLength(2);
    for (const r of served) expect(r).toMatchObject({ dexActive: false, dexCounterLiquidity: 500, dexVolume24h: 90_000 }); // byte-identical, both sweeps
  });

  it('P4: a sample that left out its deepest pair, a single-sided seed → the verdict is the uncapped one (no-dex-market), not earned; served as today', async () => {
    const seed = pool(0, 11_900_000, 500, 100);
    const real = [pool(1, 100_000, 50_000, 40_000), pool(2, 80_000, 40_000, 30_000)];
    const capped = await run(real, () => [seed, ...real], { capped: true });
    expect(capped.s.record(T)).toMatchObject({ dexActive: true, dexCounterLiquidity: 50_000 }); // the sample's served value, as today
    expect(capped.s.verdict(T)).toMatchObject({ trustEarned: false, trustReason: 'no-dex-market' });
    const uncapped = await run([seed, ...real], () => [seed, ...real], { capped: false });
    expect(uncapped.s.record(T)).toMatchObject({ dexActive: false, dexCounterLiquidity: 500 });
    expect(uncapped.s.verdict(T)).toMatchObject({ trustEarned: false, trustReason: 'no-dex-market' });
  });

  it('no own answer (429): a failure on the sample is no verdict (unknown); a pass on it stands', async () => {
    const limited = () => ({ statusCode: 429, data: null });
    const fail = await run([pool(0, 1_000, 500, 10)], limited, { capped: true });
    expect(fail.s.verdict(T)).toBeUndefined();
    expect(fail.stats.trustUnknown).toBe(1);
    const pass = await run([pool(1, 100_000, 50_000, 40_000), pool(2, 80_000, 40_000, 30_000)], limited, { capped: true });
    expect(pass.s.verdict(T)).toMatchObject({ trustEarned: true, trustReason: 'earned' });
  });

  it('an own answer that is itself capped (30 pairs) cannot confirm a failure, and its pass stands', async () => {
    const small = pool(0, 1_000, 500, 10);
    const crowd = Array.from({ length: DEXSCREENER_RESPONSE_PAIR_CAP - 1 }, (_, i) => pool(10 + i, 900, 450, 1));
    expect((await run([small], () => [small, ...crowd], { capped: true })).s.verdict(T)).toBeUndefined();
    const deep = pool(1, 100_000, 50_000, 40_000);
    const deep2 = pool(2, 80_000, 40_000, 30_000);
    const passes = await run([small], () => [small, deep, deep2, ...crowd.slice(2)], { capped: true });
    // (b) passes on its own (capped) pairs — a pair that clears both floors is a real market.
    expect(passes.s.verdict(T)).toMatchObject({ trustEarned: true, trustReason: 'earned' });
  });

  it('trust evidence off: latest mode asks for no pairs at all (served path unchanged)', async () => {
    const small = pool(0, 1_000, 500, 10);
    const off = await run([small], () => [small], { capped: true, shadow: false });
    expect(off.pairLookups).toEqual([]);
    expect(off.s.record(T)).toMatchObject({ dexActive: false, dexCounterLiquidity: 500 });
  });
});

describe('a capped answer that left the token out, with DISAGREEING aggregator quotes (latest)', () => {
  it('no DEX answer vouched for it → no verdict, even though the disagreement is definite evidence', async () => {
    const D = tok(1500);
    const s = sweep([capped(provider('dexscreener', {}), [D]), provider('defillama', { [D]: { priceUsd: 1 } }), provider('coingecko', { [D]: { priceUsd: 3 } })], {
      tokenTrustShadow: 'on',
    });
    const stats = await s.svc.prefetchConsensus(1, [D]);
    expect(s.verdict(D)).toBeUndefined();
    expect(stats).toMatchObject({ trustVerdicts: 0, trustUnknown: 1 });
    expect(s.record(D)).toMatchObject({ priceUsd: 1, dexActive: false }); // served as today
  });
});

describe('per-chain served re-check reads the token\'s own market', () => {
  it('the volume is at least what the batch saw: GeckoTerminal\'s $5,000 counts though the own pairs hold $30', async () => {
    const T = tok(1510);
    // DexScreener's one pair: $200 of USDC on its counter side (fails the $1,000 floor).
    const pick = { ...dsPair(T, 1), liquidity: { usd: 400, base: 1, quote: 200 }, volume: { h24: 10 } };
    // Its own pairs pass the counter floor with $30 of 24h volume between them.
    const deep = { ...dsPair(T, 2), liquidity: { usd: 100_000, base: 1, quote: 50_000 }, volume: { h24: 20 } };
    const ds = realDexScreener('per-chain', (url) => (url.includes('/token-pairs/') ? [pick, deep] : [pick]));
    const s = sweep([ds.p, provider('geckoterminal', { [T]: { priceUsd: 3, volume24hUsd: 5_000 } })], { dexscreenerBatchEndpoint: 'per-chain' });
    await s.svc.prefetchConsensus(1, [T]);
    expect(s.record(T)).toMatchObject({ dexActive: true, dexVolume24h: 5_000, dexCounterLiquidity: 50_000 });
  });

  it('an own market whose deepest pair is against a non-anchor token has an UNKNOWN counter side: not gated (never read as 0), as for a batch pair', async () => {
    const T = tok(1515);
    const pick = { ...dsPair(T, 1), volume: { h24: 10 } }; // fails the $50 volume floor
    const deep = { ...dsPair(T, 2), liquidity: { usd: 500_000, base: 1, quote: 3 }, volume: { h24: 40_000 }, quoteToken: { address: X } };
    const ds = realDexScreener('per-chain', (url) => (url.includes('/token-pairs/') ? [pick, deep] : [pick]));
    const s = sweep([ds.p], { dexscreenerBatchEndpoint: 'per-chain' });
    await s.svc.prefetchConsensus(1, [T]);
    expect(s.record(T)).toMatchObject({ dexActive: true, dexVolume24h: 40_010 });
    expect(s.record(T)!.dexCounterLiquidity).toBeUndefined();
  });

  it('a token whose depth is as the QUOTE side (USDT.e on Avalanche) reads as that market: served dexActive:true; latest\'s base-side rule is untouched', async () => {
    const T = tok(1520);
    // Its one base-side pair holds $568 of USDC; the deep pair has T as the QUOTE token ($306k of USDC on the other side).
    const thin = { ...dsPair(T, 1), liquidity: { usd: 46_955, base: 46_000, quote: 568 }, volume: { h24: 900 } };
    const asQuote = {
      ...dsPair(USDC, 2),
      liquidity: { usd: 613_815, base: 306_900, quote: 306_900 },
      volume: { h24: 250_000 },
      baseToken: { address: USDC },
      quoteToken: { address: T },
    };
    const run = async (mode: 'latest' | 'per-chain') => {
      const ds = realDexScreener(mode, (url) =>
        url.includes('/token-pairs/') ? [thin, asQuote] : mode === 'per-chain' ? [thin] : { pairs: [thin, asQuote] },
      );
      const s = sweep([ds.p], mode === 'per-chain' ? { dexscreenerBatchEndpoint: 'per-chain' } : {});
      await s.svc.prefetchConsensus(1, [T]);
      return s.record(T);
    };
    expect(await run('per-chain')).toMatchObject({ dexActive: true, dexCounterLiquidity: 306_900, dexVolume24h: 250_900 });
    expect(await run('latest')).toMatchObject({ dexActive: false, dexCounterLiquidity: 568 }); // today's base-side reading
  });

  it("latest: a capped sample's VERDICT reads the token's own BASE side, as an uncapped batch answer does — USDT.e is no-dex-market either way (its quote-side depth is per-chain's reading only)", async () => {
    const T = tok(1521);
    const popular = [0, 1, 2, 3, 4].map((i) => tok(1530 + i)); // DexScreener-only: single-source, no lookup
    const fill = (n: number) => Array.from({ length: n }, (_, i) => dsPair(popular[i % 5]!, i));
    const thin = { ...dsPair(T, 1), liquidity: { usd: 46_955, base: 46_000, quote: 568 }, volume: { h24: 900 } };
    const asQuote = { ...dsPair(USDC, 2), liquidity: { usd: 613_815, base: 306_900, quote: 306_900 }, volume: { h24: 250_000 }, baseToken: { address: USDC }, quoteToken: { address: T } };
    const run = async (batch: unknown) => {
      const ds = realDexScreener('latest', (url) => (url.includes('/token-pairs/') ? [thin, asQuote] : batch));
      const s = sweep([ds.p, provider('defillama', { [T]: { priceUsd: 1 } }), provider('coingecko', { [T]: { priceUsd: 1 } })], { tokenTrustShadow: 'on' });
      await s.svc.prefetchConsensus(1, [...popular, T]);
      return { verdict: s.verdict(T), pairLookups: ds.urls.filter((u) => u.includes('/token-pairs/')).length };
    };
    const uncapped = await run({ pairs: [thin, asQuote] });
    expect(uncapped).toMatchObject({ verdict: { trustEarned: false, trustReason: 'no-dex-market' }, pairLookups: 0 });
    const capped = await run({ pairs: [...fill(DEXSCREENER_RESPONSE_PAIR_CAP - 1), thin] });
    expect(capped.pairLookups).toBe(1); // the sample's failure is checked against T's own pairs…
    expect(capped.verdict).toMatchObject({ trustEarned: false, trustReason: 'no-dex-market' }); // …read base side: the uncapped verdict
  });
});

/** Live P3: the served re-check (per-chain) and earned trust used to share one lookup budget. */
describe('per-chain: the served re-check has its own pair-lookup budget', () => {
  it('100 floor-failing single-source tokens ahead of a token that can earn take no lookup from it', async () => {
    const spam = Array.from({ length: 100 }, (_, i) => tok(1600 + i));
    const E = tok(1800);
    const weak = { id: '0xweak', liquidityUsd: 2_000_000, counterLiquidity: 500, counterTokenAddress: USDC };
    const twoPools = {
      pairs: [
        { id: '0xp1', liquidityUsd: 100_000, counterLiquidity: 50_000, counterTokenAddress: USDC },
        { id: '0xp2', liquidityUsd: 80_000, counterLiquidity: 40_000, counterTokenAddress: USDC },
      ],
      complete: true,
    };
    const getTokenPairs = vi.fn(async (_c: number, a: string) => (a === E ? twoPools : null));
    const ds = provider(
      'dexscreener',
      {
        // $10 of volume < the $50 floor: each one's served dexActive is re-checked.
        ...Object.fromEntries(spam.map((a) => [a, { priceUsd: 2, volume24hUsd: 10, dexPairsComplete: false }])),
        [E]: { priceUsd: 4, volume24hUsd: 9_000, counterLiquidity: 5_000, counterTokenAddress: USDC, dexPairs: [weak], dexPairsComplete: false },
      },
      { getTokenPairs },
    );
    const s = sweep([ds, provider('defillama', { [E]: { priceUsd: 4 } })], { tokenTrustShadow: 'on', dexscreenerBatchEndpoint: 'per-chain' });
    const stats = await s.svc.prefetchConsensus(1, [...spam, E]);
    expect(getTokenPairs).toHaveBeenCalledTimes(101);
    expect(s.verdict(E)).toMatchObject({ trustEarned: true, trustReason: 'earned' });
    for (const a of spam) expect(s.verdict(a)).toMatchObject({ trustReason: 'single-source' }); // definite without any pairs
    expect(stats).toMatchObject({ trustVerdicts: 101, trustEarned: 1, trustUnknown: 0 });
  });
});

describe('the pair-lookup budgets are ceilings, and a failed request is not repeated in its sweep', () => {
  it('the served re-check stops at exactly 100 requests (101 floor-failing samples)', async () => {
    const spam = Array.from({ length: 101 }, (_, i) => tok(2000 + i));
    const getTokenPairs = vi.fn(async () => null);
    const ds = provider('dexscreener', Object.fromEntries(spam.map((a) => [a, { priceUsd: 2, volume24hUsd: 10, dexPairsComplete: false }])), { getTokenPairs });
    const s = sweep([ds, provider('defillama', {})], { dexscreenerBatchEndpoint: 'per-chain' });
    await s.svc.prefetchConsensus(1, spam);
    expect(getTokenPairs).toHaveBeenCalledTimes(100);
    for (const a of spam) expect(s.record(a)).toMatchObject({ dexActive: false });
  });

  for (const how of ['null', 'throw'] as const) {
    it(`a request that failed (${how}) for the served re-check is not asked again for (b) in the same sweep`, async () => {
      // DexScreener + DeFiLlama agree: (a)/(d) hold, so the verdict turns on
      // (b) — the sample fails the $50 volume floor.
      const T = tok(1900);
      const getTokenPairs = vi.fn(async () => {
        if (how === 'throw') throw new Error('boom');
        return null;
      });
      const ds = provider('dexscreener', { [T]: { priceUsd: 2, volume24hUsd: 10, dexPairsComplete: false } }, { getTokenPairs });
      const s = sweep([ds, provider('defillama', { [T]: { priceUsd: 2 } })], { tokenTrustShadow: 'on', dexscreenerBatchEndpoint: 'per-chain' });
      const stats = await s.svc.prefetchConsensus(1, [T]);
      expect(getTokenPairs).toHaveBeenCalledTimes(1);
      expect(s.verdict(T)).toBeUndefined(); // a failure on the sample alone
      expect(stats).toMatchObject({ trustVerdicts: 0, trustUnknown: 1 });
    });

    it(`latest: the request (b) and (c) share, failed (${how}), is not asked again for (c)`, async () => {
      // A sample that passes on ONE weak pool: (c) needs S's own pairs, and
      // that request also confirms (b). It fails; the pass stands, (c) has
      // nothing more to be had → no verdict, one request.
      const S = tok(1901);
      const weak = { id: '0xweak', liquidityUsd: 2_000_000, counterLiquidity: 500, counterTokenAddress: USDC };
      const getTokenPairs = vi.fn(async () => {
        if (how === 'throw') throw new Error('boom');
        return null;
      });
      const ds = provider(
        'dexscreener',
        { [S]: { priceUsd: 2, volume24hUsd: 9_000, counterLiquidity: 50_000, counterTokenAddress: USDC, dexPairs: [weak], dexPairsComplete: false } },
        { getTokenPairs },
      );
      const s = sweep([ds, provider('defillama', { [S]: { priceUsd: 2 } })], { tokenTrustShadow: 'on' });
      const stats = await s.svc.prefetchConsensus(1, [S]);
      expect(getTokenPairs).toHaveBeenCalledTimes(1);
      expect(s.verdict(S)).toBeUndefined();
      expect(stats).toMatchObject({ trustVerdicts: 0, trustUnknown: 1 });
    });
  }
});

/**
 * (b) on a sample read a CACHED own answer (kept for a quarter of the quote
 * window, 6 h by default) as a decision. Live probes c2/c3/c4, latest mode: a
 * token's pools drained inside the TTL, every fresh capped sample showing it,
 * and `earned` was stored again at +0.5 h, +1 h and +5.9 h with no request;
 * liquidity added inside the TTL, and a cached thin answer stored
 * `no-dex-market` beside a fresh deep sample. A cached answer may confirm the
 * sample; overturning it takes a request this sweep.
 */
describe('(b) on a sample: a cached own answer may confirm the sample, never overturn it', () => {
  // The clock (Date only): a cached answer under RECENT_PAIR_ANSWER_MS (15 min)
  // that contradicts the sample is neither re-asked nor read (no verdict), so a
  // re-ask is shown one sweep-gap of 16 minutes later.
  beforeEach(() => vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-06T00:00:00Z') }));
  afterEach(() => vi.useRealTimers());
  const age = (minutes = 16) => vi.setSystemTime(Date.now() + minutes * 60_000);
  const popular = [0, 1, 2, 3, 4].map((i) => tok(2210 + i)); // DexScreener-only: single-source, no lookup
  const fill = (n: number) => Array.from({ length: n }, (_, i) => dsPair(popular[i % 5]!, i));
  const T = tok(2200);
  const pool = (i: number, usd: number, counter: number, h24: number) => ({ ...dsPair(T, 300 + i), liquidity: { usd, base: 1, quote: counter }, volume: { h24 } });
  const healthy = [pool(1, 100_000, 50_000, 40_000), pool(2, 80_000, 40_000, 30_000), pool(3, 60_000, 30_000, 20_000)];
  const drained = [pool(1, 120, 60, 5), pool(2, 80, 40, 3), pool(3, 60, 30, 2)];
  const aggregators = () => [provider('defillama', { [T]: { priceUsd: 3 } }), provider('coingecko', { [T]: { priceUsd: 3 } })];
  /** A capped /latest answer whose sample of T is its first pair; T's own pairs `world()`, or `own()` when given. */
  const dexScreener = (world: () => typeof healthy, own?: () => unknown) =>
    realDexScreener('latest', (url) => (url.includes('/token-pairs/') ? (own ?? world)() : { pairs: [...fill(DEXSCREENER_RESPONSE_PAIR_CAP - 1), world()[0]] }));
  const sweepOnce = async (ds: ReturnType<typeof realDexScreener>, config: Record<string, unknown> = { tokenTrustShadow: 'on' }) => {
    const before = ds.urls.filter((u) => u.includes('/token-pairs/')).length;
    const s = sweep([ds.p, ...aggregators()], config);
    const stats = await s.svc.prefetchConsensus(1, [...popular, T]);
    return { verdict: s.verdict(T), served: s.record(T), stats, requests: ds.urls.filter((u) => u.includes('/token-pairs/')).length - before };
  };

  it('a rug inside the cache TTL: the fresh sample shows the pools drained, the cached answer still calls them healthy → a request this sweep decides (no-dex-market); then the drained answer confirms with no request', async () => {
    let world = healthy;
    const ds = dexScreener(() => world);
    expect(await sweepOnce(ds)).toMatchObject({ verdict: { trustEarned: true, trustReason: 'earned' }, requests: 1 });
    world = drained;
    age();
    const rug = await sweepOnce(ds);
    expect(rug).toMatchObject({ verdict: { trustEarned: false, trustReason: 'no-dex-market' }, requests: 1 });
    expect(rug.served).toMatchObject({ dexActive: false, dexCounterLiquidity: 60 }); // served as today: the sample
    expect(await sweepOnce(ds)).toMatchObject({ verdict: { trustEarned: false, trustReason: 'no-dex-market' }, requests: 0 });
  });

  it('the same in combined mode (the verdicts it serves)', async () => {
    let world = healthy;
    const ds = dexScreener(() => world);
    await sweepOnce(ds, { tokenTrustMode: 'combined' });
    world = drained;
    age();
    expect(await sweepOnce(ds, { tokenTrustMode: 'combined' })).toMatchObject({ verdict: { trustEarned: false, trustReason: 'no-dex-market' }, requests: 1 });
  });

  it('liquidity added inside the TTL: a cached thin answer cannot overturn a fresh deep sample → a request this sweep decides (earned)', async () => {
    const thin = [pool(1, 1_000, 500, 10)];
    let world = thin;
    const ds = dexScreener(() => world);
    expect(await sweepOnce(ds)).toMatchObject({ verdict: { trustEarned: false, trustReason: 'no-dex-market' }, requests: 1 });
    world = healthy;
    age();
    expect(await sweepOnce(ds)).toMatchObject({ verdict: { trustEarned: true, trustReason: 'earned' }, requests: 1 });
  });

  it('with no answer this sweep to settle it (the request is rate-limited), a contradicted sample stores NO verdict — the cached answer decides nothing', async () => {
    let world = healthy;
    let limited = false;
    const ds = dexScreener(() => world, () => (limited ? { statusCode: 429, data: null } : world));
    await sweepOnce(ds);
    world = drained;
    limited = true;
    age();
    const rug = await sweepOnce(ds);
    expect(rug.verdict).toBeUndefined();
    expect(rug.stats).toMatchObject({ trustUnknown: 1 });
    expect(rug.requests).toBe(1);
  });

  it('a contradiction with an answer under 15 minutes old: no verdict and NO request (a lasting contradiction costs one request per 15 minutes, not one per sweep); older, the re-ask decides', async () => {
    let world = healthy;
    const ds = dexScreener(() => world);
    expect(await sweepOnce(ds)).toMatchObject({ verdict: { trustEarned: true }, requests: 1 });
    world = drained;
    age(5); // the next sweep: the healthy answer is 5 minutes old
    const early = await sweepOnce(ds);
    expect(early).toMatchObject({ requests: 0, stats: { trustVerdicts: 5, trustUnknown: 1 } }); // the 5 popular tokens: single-source, definite
    expect(early.verdict).toBeUndefined(); // the earned verdict of the first sweep stands, unrefreshed
    expect(early.served).toMatchObject({ dexActive: false }); // served data reads the sample, as today
    age(5); // 10 minutes
    expect(await sweepOnce(ds)).toMatchObject({ verdict: undefined, requests: 0 });
    age(6); // 16 minutes: old enough to re-ask
    expect(await sweepOnce(ds)).toMatchObject({ verdict: { trustEarned: false, trustReason: 'no-dex-market' }, requests: 1 });
  });

  it('the same for a sample that PASSES: a complete cached answer contradicts it and the re-ask fails → no verdict, never `earned` off the sample', async () => {
    // P4's shape: the sample holds two strong pools, so (b) and (c) both pass
    // on it alone; T's full answer (cached) is complete and its deepest pair
    // is a single-sided seed whose base side fails ($100 of counter). With the
    // re-ask rate-limited, the sample's pass must not stand in for it, or a
    // seeded token earns trust whenever its refresh is refused.
    const strong = [
      { id: '0xs1', liquidityUsd: 100_000, counterLiquidity: 50_000, counterTokenAddress: USDC },
      { id: '0xs2', liquidityUsd: 80_000, counterLiquidity: 40_000, counterTokenAddress: USDC },
    ];
    const seed = { id: '0xseed', liquidityUsd: 11_900_000, counterLiquidity: 100, counterTokenAddress: USDC };
    const cached = { pairs: [seed, ...strong], complete: true, base: { volume24hUsd: 9_000, counterLiquidity: 100, counterTokenAddress: USDC }, fetchedAt: 1 };
    const getTokenPairs = vi.fn(async () => null);
    const ds = provider(
      'dexscreener',
      { [T]: { priceUsd: 3, volume24hUsd: 9_000, counterLiquidity: 50_000, counterTokenAddress: USDC, dexPairs: strong, dexPairsComplete: false } },
      { getTokenPairs, cachedTokenPairs: (_c: number, a: string) => (a === T ? cached : undefined) },
    );
    const s = sweep([ds, ...aggregators()], { tokenTrustShadow: 'on' });
    const stats = await s.svc.prefetchConsensus(1, [T]);
    expect(getTokenPairs.mock.calls).toEqual([[1, T, { refresh: true }]]);
    expect(s.verdict(T)).toBeUndefined();
    expect(stats).toMatchObject({ trustVerdicts: 0, trustUnknown: 1 });
  });

  it('the sources-assumed path (no request ever) does not let a contradicting cached answer stand in either: no verdict', async () => {
    // A lone DexScreener price with CoinGecko skipped: (a)/(d) withheld, (b)
    // and (c) judged alone, on cached evidence only. The sample passes on one
    // weak pool; T's cached answer is complete — one single-sided seed whose
    // base side fails. Read as a decision it would store a "single-pool" off
    // pairs hours old.
    const seed = { id: '0xseed', liquidityUsd: 11_900_000, counterLiquidity: 500, counterTokenAddress: USDC };
    const weak = { id: '0xweak', liquidityUsd: 2_000_000, counterLiquidity: 500, counterTokenAddress: USDC };
    const cached = { pairs: [seed], complete: true, base: { volume24hUsd: 100, counterLiquidity: 500, counterTokenAddress: USDC }, fetchedAt: 1 };
    const getTokenPairs = vi.fn(async () => null);
    const ds = provider(
      'dexscreener',
      { [T]: { priceUsd: 3, volume24hUsd: 9_000, counterLiquidity: 50_000, counterTokenAddress: USDC, dexPairs: [weak], dexPairsComplete: false } },
      { getTokenPairs, cachedTokenPairs: (_c: number, a: string) => (a === T ? cached : undefined) },
    );
    const s = sweep([ds, skipped(provider('coingecko', {}))], { tokenTrustShadow: 'on' });
    await s.svc.prefetchConsensus(1, [T]);
    expect(getTokenPairs).not.toHaveBeenCalled();
    expect(s.verdict(T)).toBeUndefined();
  });

  it('per-chain: a served re-check that read a cached answer does not decide the verdict either', async () => {
    // T's one batch pair fails the counter floor; its own pairs passed an hour
    // ago and are drained now. The served re-check reads the cached answer
    // (per-chain's served data, flag-gated); the verdict asks again.
    const pick = { ...dsPair(T, 1), liquidity: { usd: 400, base: 1, quote: 200 }, volume: { h24: 10 } };
    let world = healthy;
    const ds = realDexScreener('per-chain', (url) => (url.includes('/token-pairs/') ? [pick, ...world] : [pick]));
    const once = async () => {
      const before = ds.urls.filter((u) => u.includes('/token-pairs/')).length;
      const s = sweep([ds.p, ...aggregators()], { tokenTrustShadow: 'on', dexscreenerBatchEndpoint: 'per-chain' });
      await s.svc.prefetchConsensus(1, [T]);
      return { verdict: s.verdict(T), requests: ds.urls.filter((u) => u.includes('/token-pairs/')).length - before };
    };
    expect(await once()).toMatchObject({ verdict: { trustEarned: true, trustReason: 'earned' }, requests: 1 }); // the re-check's request serves both
    world = drained;
    age();
    expect(await once()).toMatchObject({ verdict: { trustEarned: false, trustReason: 'no-dex-market' }, requests: 1 });
  });

  it('per-chain, sources assumed: an answer the served re-check fetched THIS sweep decides — it is not a cached one', async () => {
    // A lone DexScreener price with CoinGecko skipped: (a)/(d) withheld, the
    // verdict judged on evidence already to hand. T's one batch pair fails
    // the floors; the served re-check asks for T's own pairs this sweep and
    // finds [pick, a deep pair with $5k of counter]: a real market, one pool
    // short of (c). That answer is this sweep's, so it decides (single-pool)
    // instead of being withheld like a contradicting cached one.
    const pick = { ...dsPair(T, 1), liquidity: { usd: 400, base: 1, quote: 200 }, volume: { h24: 10 } };
    const deep = { ...dsPair(T, 2), liquidity: { usd: 10_000, base: 1, quote: 5_000 }, volume: { h24: 40_000 } };
    const ds = realDexScreener('per-chain', (url) => (url.includes('/token-pairs/') ? [pick, deep] : [pick]));
    const s = sweep([ds.p, skipped(provider('coingecko', {}))], { tokenTrustShadow: 'on', dexscreenerBatchEndpoint: 'per-chain' });
    await s.svc.prefetchConsensus(1, [T]);
    expect(ds.urls.filter((u) => u.includes('/token-pairs/'))).toHaveLength(1); // the served re-check's
    expect(s.record(T)).toMatchObject({ dexActive: true });
    expect(s.verdict(T)).toMatchObject({ trustEarned: false, trustReason: 'single-pool' });
  });
});

/**
 * Live, Robinhood, latest + shadow, first sweep: (b)'s requests to confirm a
 * sample's PASS were spent inline, in batch order — 7 of the 25 lookups on
 * tokens main earned without one (and still earned) — and INJOH (#47, earned on
 * main) and SEAL (#48, single-pool on main) got no verdict: earned 21 → 20.
 * The (c) lookups the rule before (b)-on-a-sample made come first; then (b)'s
 * requests for a failing sample, then for a passing one.
 */
describe("(b)'s own requests wait for the ones the rule before it made", () => {
  // The clock (Date only), as above: a re-ask of a contradicted cached answer
  // needs it to be RECENT_PAIR_ANSWER_MS (15 min) old.
  beforeEach(() => vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-06T00:00:00Z') }));
  afterEach(() => vi.useRealTimers());
  const age = (minutes = 16) => vi.setSystemTime(Date.now() + minutes * 60_000);
  const strong = (i: number) => [
    { id: `0xs${i}a`, liquidityUsd: 100_000, counterLiquidity: 50_000, counterTokenAddress: USDC },
    { id: `0xs${i}b`, liquidityUsd: 80_000, counterLiquidity: 40_000, counterTokenAddress: USDC },
  ];
  const weak = { id: '0xweak', liquidityUsd: 2_000_000, counterLiquidity: 500, counterTokenAddress: USDC };
  const ownPairs = (pass: boolean) => ({
    pairs: strong(99),
    complete: true,
    base: pass ? { volume24hUsd: 9_000, counterLiquidity: 50_000, counterTokenAddress: USDC } : { volume24hUsd: 9_000, counterLiquidity: 100, counterTokenAddress: USDC },
  });

  it('25 sample passes ahead of a single-pool sample and a failing sample: the (c) lookup, then the failure\'s request; the passes share what is left, and a pass with none stands', async () => {
    const passes = Array.from({ length: 25 }, (_, i) => tok(2300 + i));
    const S = tok(2400); // single-pool on its sample: (c) needs its own pairs
    const F = tok(2401); // its sample fails the volume floor
    const quotes: Record<string, Q> = {
      ...Object.fromEntries(passes.map((a, i) => [a, { priceUsd: 2, volume24hUsd: 9_000, counterLiquidity: 50_000, counterTokenAddress: USDC, dexPairs: strong(i), dexPairsComplete: false }])),
      [S]: { priceUsd: 2, volume24hUsd: 9_000, counterLiquidity: 50_000, counterTokenAddress: USDC, dexPairs: [weak], dexPairsComplete: false },
      [F]: { priceUsd: 2, volume24hUsd: 10, dexPairsComplete: false },
    };
    const getTokenPairs = vi.fn(async () => ownPairs(true));
    const ds = provider('dexscreener', quotes, { getTokenPairs });
    const all = [...passes, S, F];
    const s = sweep([ds, provider('defillama', Object.fromEntries(all.map((a) => [a, { priceUsd: 2 }])))], { tokenTrustShadow: 'on' });
    const stats = await s.svc.prefetchConsensus(1, all);
    const asked = getTokenPairs.mock.calls.map(([, a]) => a);
    expect(asked).toHaveLength(25);
    expect(asked.slice(0, 2)).toEqual([S, F]);
    expect(asked.slice(2)).toEqual(passes.slice(0, 23));
    expect(s.verdict(S)).toMatchObject({ trustEarned: true, trustReason: 'earned' });
    expect(s.verdict(F)).toMatchObject({ trustEarned: true, trustReason: 'earned' }); // its own market passes
    expect(stats).toMatchObject({ trustVerdicts: 27, trustEarned: 27, trustUnknown: 0 });
  });

  it('a pass confirmation can still revoke: a complete own answer that fails, once every earlier request is served', async () => {
    const P = tok(2402);
    const getTokenPairs = vi.fn(async () => ownPairs(false));
    const ds = provider('dexscreener', { [P]: { priceUsd: 2, volume24hUsd: 9_000, counterLiquidity: 50_000, counterTokenAddress: USDC, dexPairs: strong(0), dexPairsComplete: false } }, { getTokenPairs });
    const s = sweep([ds, provider('defillama', { [P]: { priceUsd: 2 } })], { tokenTrustShadow: 'on' });
    await s.svc.prefetchConsensus(1, [P]);
    expect(getTokenPairs).toHaveBeenCalledTimes(1);
    expect(s.verdict(P)).toMatchObject({ trustEarned: false, trustReason: 'no-dex-market' });
  });

  it('per-chain: a served re-check that passed on a CACHED answer does not turn the verdict\'s re-ask into a (c) request — it waits with the other failures', async () => {
    // X's one batch pair fails the volume floor; the served re-check passes it
    // on a cached answer. Its verdict needs that answer asked again — after
    // the 100 (c) lookups of tokens whose samples pass on one weak pool.
    const X = tok(2403);
    const weak1 = { id: '0xw', liquidityUsd: 2_000_000, counterLiquidity: 500, counterTokenAddress: USDC };
    const cs = Array.from({ length: 100 }, (_, i) => tok(2600 + i));
    const cachedPass = { ...ownPairs(true), market: ownPairs(true).base };
    const getTokenPairs = vi.fn(async () => cachedPass);
    const ds = provider(
      'dexscreener',
      {
        [X]: { priceUsd: 2, volume24hUsd: 10, counterLiquidity: 50_000, counterTokenAddress: USDC, dexPairs: [weak1], dexPairsComplete: false },
        ...Object.fromEntries(cs.map((a) => [a, { priceUsd: 2, volume24hUsd: 9_000, counterLiquidity: 50_000, counterTokenAddress: USDC, dexPairs: [weak1], dexPairsComplete: false }])),
      },
      { getTokenPairs, cachedTokenPairs: (_c: number, a: string) => (a === X ? { ...cachedPass, fetchedAt: 1 } : undefined) },
    );
    const all = [X, ...cs];
    const s = sweep([ds, provider('defillama', Object.fromEntries(all.map((a) => [a, { priceUsd: 2 }])))], { tokenTrustShadow: 'on', dexscreenerBatchEndpoint: 'per-chain' });
    const stats = await s.svc.prefetchConsensus(1, all);
    expect(s.record(X)).toMatchObject({ dexActive: true }); // per-chain's served re-check (a cached answer)
    expect(getTokenPairs.mock.calls.map(([, a]) => a)).toEqual(cs);
    for (const a of cs) expect(s.verdict(a)).toMatchObject({ trustEarned: true });
    expect(s.verdict(X)).toBeUndefined(); // its re-ask found the budget spent
    expect(stats).toMatchObject({ trustVerdicts: 100, trustUnknown: 1 });
  });

  it('more failing samples than the budget: the oldest answer asks first, so the ones a sweep could not ask get theirs on the next', async () => {
    const many = Array.from({ length: DEXSCREENER_RESPONSE_PAIR_CAP }, (_, i) => tok(2500 + i));
    // One thin pair per token ($500 of USDC: fails the counter floor) — a
    // capped 30-pair answer; each token's own pairs are a real market.
    const thin = (a: string, i: number) => ({ ...dsPair(a, 600 + i), liquidity: { usd: 1_000, base: 1, quote: 500 }, volume: { h24: 10 } });
    const deep = (a: string, i: number) => [
      { ...dsPair(a, 700 + i), liquidity: { usd: 100_000, base: 1, quote: 50_000 }, volume: { h24: 40_000 } },
      { ...dsPair(a, 800 + i), liquidity: { usd: 80_000, base: 1, quote: 40_000 }, volume: { h24: 30_000 } },
    ];
    const ds = realDexScreener('latest', (url) => {
      if (!url.includes('/token-pairs/')) return { pairs: many.map(thin) };
      const a = url.slice(url.lastIndexOf('/') + 1);
      const i = many.indexOf(a);
      return [thin(a, i), ...deep(a, i)];
    });
    const q = Object.fromEntries(many.map((a) => [a, { priceUsd: 3 }]));
    const s = sweep([ds.p, provider('defillama', q), provider('coingecko', q)], { tokenTrustShadow: 'on' });
    const first = await s.svc.prefetchConsensus(1, many);
    expect(first).toMatchObject({ trustVerdicts: 25, trustEarned: 25, trustUnknown: 5 });
    const last = many.slice(25);
    for (const a of last) expect(s.verdict(a)).toBeUndefined();
    s.verdicts.length = 0;
    // The next sweep, 5 minutes on: the five never asked get their requests;
    // the 25 answered ones still contradict their samples, but their answers
    // are recent — no request, no verdict (one per 15 minutes, not per sweep).
    age(5);
    const second = await s.svc.prefetchConsensus(1, many);
    expect(second).toMatchObject({ trustVerdicts: 5, trustEarned: 5, trustUnknown: 25 });
    for (const a of last) expect(s.verdict(a)).toMatchObject({ trustEarned: true, trustReason: 'earned' });
    s.verdicts.length = 0;
    // 16 minutes after the first answers: the 25 re-ask, oldest answer first —
    // the budget covers them exactly; the five answered 11 minutes ago wait.
    age(11);
    const third = await s.svc.prefetchConsensus(1, many);
    expect(third).toMatchObject({ trustVerdicts: 25, trustEarned: 25, trustUnknown: 5 });
    for (const a of many.slice(0, 25)) expect(s.verdict(a)).toMatchObject({ trustEarned: true });
  });

  /**
   * A passing ONE-pool sample whose CACHED own answer is complete and fails
   * it. The rule before this one read that cached answer for (c) at no cost,
   * so its re-ask is a request of (b)'s own: it waits with the other passes,
   * never inline in batch order. Spent inline, a lasting contradiction (each
   * sweep's refreshed answer is the cache the next one doubts) took the whole
   * budget every sweep, ahead of the (c) lookups the old rule made and of a
   * rug's re-ask.
   */
  const onePoolPass = { priceUsd: 2, volume24hUsd: 9_000, counterLiquidity: 50_000, counterTokenAddress: USDC, dexPairs: [weak], dexPairsComplete: false };
  const quotesOf = (addrs: string[]) => provider('defillama', Object.fromEntries(addrs.map((a) => [a, { priceUsd: 2 }])));

  it('25 one-pool passes a cached answer contradicts, ahead of a rug: the rug is re-asked first and revoked; the passes share what is left, oldest answer first', async () => {
    const Cs = Array.from({ length: 25 }, (_, i) => tok(2700 + i));
    const R = tok(2404); // its fresh sample shows the pools drained; its cached answer still calls them healthy
    const cache = new Map<string, unknown>([...Cs.map((a, i) => [a, { ...ownPairs(false), fetchedAt: 1_000 + i }] as const), [R, { ...ownPairs(true), fetchedAt: 2_000 }]]);
    const getTokenPairs = vi.fn(async () => ownPairs(false)); // the contradictions last; R's pools are drained
    const ds = provider(
      'dexscreener',
      { ...Object.fromEntries(Cs.map((a) => [a, onePoolPass])), [R]: { priceUsd: 2, volume24hUsd: 10, dexPairsComplete: false } },
      { getTokenPairs, cachedTokenPairs: (_c: number, a: string) => cache.get(a) },
    );
    const all = [...Cs, R];
    const s = sweep([ds, quotesOf(all)], { tokenTrustShadow: 'on' });
    const stats = await s.svc.prefetchConsensus(1, all);
    const calls = getTokenPairs.mock.calls as unknown[][];
    expect(calls).toHaveLength(25);
    expect(calls[0]).toEqual([1, R, { refresh: true }]);
    expect(s.verdict(R)).toMatchObject({ trustEarned: false, trustReason: 'no-dex-market' });
    expect(calls.slice(1).map((c) => c[1])).toEqual(Cs.slice(0, 24));
    for (const a of Cs.slice(0, 24)) expect(s.verdict(a)).toMatchObject({ trustEarned: false, trustReason: 'no-dex-market' });
    expect(s.verdict(Cs[24]!)).toBeUndefined(); // its contradiction found the budget spent: no verdict
    expect(stats).toMatchObject({ trustVerdicts: 25, trustUnknown: 1 });
  });

  it('such a token first in the batch: the (c) lookups behind it come first, and its re-ask decides once a request is to be had', async () => {
    const S = tok(2405);
    const cs = [tok(2730), tok(2731)]; // one-pool passes with nothing cached: (c) asks, as the old rule did
    const getTokenPairs = vi.fn(async (_c: number, a: string) => ownPairs(a !== S));
    const ds = provider('dexscreener', Object.fromEntries([S, ...cs].map((a) => [a, onePoolPass])), {
      getTokenPairs,
      cachedTokenPairs: (_c: number, a: string) => (a === S ? { ...ownPairs(false), fetchedAt: 1 } : undefined),
    });
    const s = sweep([ds, quotesOf([S, ...cs])], { tokenTrustShadow: 'on' });
    await s.svc.prefetchConsensus(1, [S, ...cs]);
    expect(getTokenPairs.mock.calls).toEqual([[1, cs[0]], [1, cs[1]], [1, S, { refresh: true }]]);
    for (const a of cs) expect(s.verdict(a)).toMatchObject({ trustEarned: true, trustReason: 'earned' });
    expect(s.verdict(S)).toMatchObject({ trustEarned: false, trustReason: 'no-dex-market' });
  });

  it('…and when the (c) lookups take the whole budget, it is the one left without a verdict, not the last of them', async () => {
    const S = tok(2406);
    const cs = Array.from({ length: 25 }, (_, i) => tok(2740 + i));
    const getTokenPairs = vi.fn(async () => ownPairs(true));
    const ds = provider('dexscreener', Object.fromEntries([S, ...cs].map((a) => [a, onePoolPass])), {
      getTokenPairs,
      cachedTokenPairs: (_c: number, a: string) => (a === S ? { ...ownPairs(false), fetchedAt: 1 } : undefined),
    });
    const s = sweep([ds, quotesOf([S, ...cs])], { tokenTrustShadow: 'on' });
    const stats = await s.svc.prefetchConsensus(1, [S, ...cs]);
    expect((getTokenPairs.mock.calls as unknown[][]).map((c) => c[1])).toEqual(cs);
    for (const a of cs) expect(s.verdict(a)).toMatchObject({ trustEarned: true, trustReason: 'earned' });
    expect(s.verdict(S)).toBeUndefined();
    expect(stats).toMatchObject({ trustVerdicts: 25, trustUnknown: 1 });
  });

  const pairOf = (a: string, i: number, usd: number, counter: number, h24: number) => ({ ...dsPair(a, i), liquidity: { usd, base: 1, quote: counter }, volume: { h24 } });
  const later = () => age(); // a sweep-gap past RECENT_PAIR_ANSWER_MS: answers from different sweeps carry different fetchedAt, all old enough to re-ask

  it('a seeded token whose re-ask finds the budget spent never earns off its passing sample', async () => {
    // P's sample holds two strong pools; its full answer is complete, and its
    // deepest pair a single-sided seed whose base side fails. On sweep 2 the
    // (c) lookups of 25 one-pool samples take the budget before P's re-ask.
    const P = tok(3900);
    const Ss = Array.from({ length: 25 }, (_, i) => tok(3950 + i));
    const popular = [0, 1, 2].map((i) => tok(3910 + i));
    const fill = (n: number) => Array.from({ length: n }, (_, i) => dsPair(popular[i % 3]!, i));
    const pSample = [pairOf(P, 901, 100_000, 50_000, 10_000), pairOf(P, 902, 80_000, 40_000, 10_000)];
    const seed = pairOf(P, 903, 11_900_000, 500, 10);
    const sPair = (a: string, i: number) => pairOf(a, 950 + i, 2_000_000, 50_000, 10_000);
    let withSs = false;
    const ds = realDexScreener('latest', (url) => {
      if (url.includes('/token-pairs/')) {
        const a = url.slice(url.lastIndexOf('/') + 1);
        return a === P ? [...pSample, seed] : [sPair(a, Ss.indexOf(a))];
      }
      return { pairs: withSs ? [...Ss.map(sPair), ...pSample, ...fill(3)] : [...fill(28), ...pSample] };
    });
    const all = [...popular, P, ...Ss];
    const q = Object.fromEntries(all.map((a) => [a, { priceUsd: 3 }]));
    const run = async () => {
      const s = sweep([ds.p, provider('defillama', q), provider('coingecko', q)], { tokenTrustShadow: 'on' });
      const before = ds.urls.filter((u) => u.includes('/token-pairs/')).length;
      await s.svc.prefetchConsensus(1, withSs ? all : [...popular, P]);
      return { s, asked: ds.urls.filter((u) => u.includes('/token-pairs/')).length - before };
    };
    expect((await run()).s.verdict(P)).toMatchObject({ trustEarned: false, trustReason: 'no-dex-market' });
    withSs = true;
    age(); // P's answer is old enough to re-ask
    const two = await run();
    expect(two.asked).toBe(25); // the 25 (c) lookups
    expect(two.s.verdict(P)).toBeUndefined();
  });

  it('among answers that have a date, the oldest re-asks first: a rug late in batch order, behind 25 lasting contradictions with newer answers, is revoked on the first sweep after it', async () => {
    const T = tok(4100);
    const Us = Array.from({ length: 25 }, (_, i) => tok(4200 + i));
    const popular = [0, 1, 2, 3, 4].map((i) => tok(4110 + i));
    const fill = (n: number) => Array.from({ length: n }, (_, i) => dsPair(popular[i % 5]!, i));
    const healthy = [pairOf(T, 301, 100_000, 50_000, 40_000), pairOf(T, 302, 80_000, 40_000, 30_000), pairOf(T, 303, 60_000, 30_000, 20_000)];
    const drained = [pairOf(T, 301, 120, 60, 5), pairOf(T, 302, 80, 40, 3), pairOf(T, 303, 60, 30, 2)];
    const thin = (a: string, i: number) => pairOf(a, 600 + i, 1_000, 500, 10);
    const deep = (a: string, i: number) => [pairOf(a, 700 + i, 100_000, 50_000, 40_000), pairOf(a, 800 + i, 80_000, 40_000, 30_000)];
    let world = healthy;
    let withUs = false;
    const ds = realDexScreener('latest', (url) => {
      if (url.includes('/token-pairs/')) {
        const a = url.slice(url.lastIndexOf('/') + 1);
        if (a === T) return world;
        const i = Us.indexOf(a);
        return [thin(a, i), ...deep(a, i)];
      }
      return { pairs: withUs ? [...Us.map(thin), ...world, ...fill(2)] : [...fill(27), ...world] };
    });
    const all = [...popular, ...Us, T];
    const q = Object.fromEntries(all.map((a) => [a, { priceUsd: 3 }]));
    const run = async (addrs: string[]) => {
      const s = sweep([ds.p, provider('defillama', q), provider('coingecko', q)], { tokenTrustShadow: 'on' });
      await s.svc.prefetchConsensus(1, addrs);
      return s.verdict(T);
    };
    expect(await run([...popular, T])).toMatchObject({ trustEarned: true }); // T's own answer: the oldest
    later();
    withUs = true;
    expect(await run(all)).toMatchObject({ trustEarned: true }); // the 25 Us asked: newer answers
    later();
    world = drained;
    expect(await run(all)).toMatchObject({ trustEarned: false, trustReason: 'no-dex-market' });
  });
});

// Typed use of the optional capability (compile-time check of the interface).
const _typed: Pick<PriceProvider, 'getCurrentBatchWithCoverage'> = {
  getCurrentBatchWithCoverage: async () => ({ quotes: new Map(), uncertain: new Set<string>() }),
};
void _typed;
