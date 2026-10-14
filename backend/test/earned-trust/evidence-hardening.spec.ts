import { describe, expect, it, vi } from 'vitest';
import { PricingService } from '../../src/pricing/pricing.service.js';
import { DexScreenerProvider, DEXSCREENER_RESPONSE_PAIR_CAP, pairsOfToken } from '../../src/pricing/providers/dexscreener.provider.js';
import { reconcileQuotes } from '../../src/pricing/quote-consensus.js';
import { evaluateEarnedTrust, summarizeDexPools, trustPolicyOf } from '../../src/pricing/token-trust.js';
import type { TokenPriceRecord, TokenTrustRecord } from '../../src/database/token.repository.js';

/**
 * Review fixes to earned trust (fix 4):
 *  - (c) must not come from a CAPPED DexScreener batch answer (30 pairs for the
 *    whole request): BTC.b's one Ethereum pool was crowded out whenever cbBTC
 *    shared its batch, and the sweep stored a definite "single-pool".
 *  - trust must not be buyable with two self-seeded $1k pools and DEX-only
 *    quotes (DexScreener + GeckoTerminal read the same pools).
 *  - shadow must not walk providers or persist prices for counter tokens.
 */

const CBBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf'; // allowlisted
const BTCB = '0xb0f70c0bd6fd87dbeb7c10dc692a2a6106817072'; // not allowlisted
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const POOL = '0x9c25d738109ff9ad10516f5f97ef24b9af51a9aa3db4b3b5728edf18a2d3f11c';

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

function sweep(providers: ReturnType<typeof provider>[], stored: Record<string, number> = {}) {
  const prices: TokenPriceRecord[] = [];
  const verdicts: TokenTrustRecord[] = [];
  const tokens = {
    findLatestPrices: vi.fn(async (_c: number, addrs: string[]) =>
      new Map(addrs.filter((a) => a in stored).map((a) => [a, { priceUsd: stored[a]!, pricedAt: new Date() }])),
    ),
    upsertPrices: vi.fn(async (_c: number, r: TokenPriceRecord[]) => void prices.push(...r)),
    upsertTrustEvidence: async (_c: number, r: TokenTrustRecord[]) => void verdicts.push(...r),
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
    } as never,
    {} as never,
    { currentProviders: () => providers, historicalProviders: () => providers } as never,
    { isListed: (_c: number, a: string) => a === CBBTC } as never,
    tokens as never,
  );
  return { svc, prices, verdicts, tokens };
}

const btcbPool = { id: POOL, liquidityUsd: 8_530_070, counterLiquidity: 49.1352, counterTokenAddress: CBBTC };

// The live 2026-10-05 shape of /tokens/BTC.b,cbBTC: a capped answer with
// cbBTC pairs only — no BTC.b pair at all.
function cappedDexScreener(extra: Record<string, unknown> = {}) {
  return provider(
    'dexscreener',
    { [CBBTC]: { priceUsd: 85_300, volume24hUsd: 9e6, dexPairs: [{ id: '0xcb', liquidityUsd: 9e6, counterLiquidity: 1e6, counterTokenAddress: USDC }], dexPairsComplete: false } },
    extra,
  );
}
const otherSources = () => [
  provider('defillama', { [BTCB]: { priceUsd: 85_852, quotedAtMs: Date.now() - 600_000 }, [CBBTC]: { priceUsd: 85_310 } }),
  provider('geckoterminal', { [BTCB]: { priceUsd: 85_300, volume24hUsd: 60_866 }, [CBBTC]: { priceUsd: 85_300, volume24hUsd: 9e6 } }),
];

describe('(c) from a capped DexScreener batch answer', () => {
  it('stores NO negative verdict for a token the capped answer left out (no per-token lookup available)', async () => {
    const { svc, verdicts } = sweep([cappedDexScreener(), ...otherSources()]);
    await svc.prefetchConsensus(1, [BTCB, CBBTC]);
    expect(verdicts.find((v) => v.address === BTCB)).toBeUndefined();
  });

  it('looks the token\'s own pairs up and stores the verdict they support (BTC.b earns trust)', async () => {
    const getTokenPairs = vi.fn(async (_c: number, a: string) => (a === BTCB ? { pairs: [btcbPool], complete: true } : null));
    const { svc, verdicts } = sweep([cappedDexScreener({ getTokenPairs }), ...otherSources()]);
    await svc.prefetchConsensus(1, [BTCB, CBBTC]);
    expect(verdicts.find((v) => v.address === BTCB)).toMatchObject({ trustEarned: true, trustReason: 'earned', dexTopPoolId: POOL });
    expect(getTokenPairs).toHaveBeenCalledWith(1, BTCB);
  });

  it('complete evidence of one single-sided pool IS stored as single-pool', async () => {
    const seed = { id: POOL, liquidityUsd: 8_530_070, counterLiquidity: 0.5, counterTokenAddress: CBBTC };
    const getTokenPairs = vi.fn(async (_c: number, a: string) => (a === BTCB ? { pairs: [seed], complete: true } : null));
    const { svc, verdicts } = sweep([cappedDexScreener({ getTokenPairs }), ...otherSources()]);
    await svc.prefetchConsensus(1, [BTCB, CBBTC]);
    expect(verdicts.find((v) => v.address === BTCB)).toMatchObject({ trustEarned: false, trustReason: 'single-pool' });
  });

  it('a per-token answer that is itself capped cannot make a negative verdict either', async () => {
    const getTokenPairs = vi.fn(async () => ({ pairs: [], complete: false }));
    const { svc, verdicts } = sweep([cappedDexScreener({ getTokenPairs }), ...otherSources()]);
    await svc.prefetchConsensus(1, [BTCB, CBBTC]);
    expect(verdicts.find((v) => v.address === BTCB)).toBeUndefined();
  });

  it('per-token lookups are budgeted per sweep (25)', async () => {
    const many = Array.from({ length: 40 }, (_, i) => `0x${(0xb000 + i).toString(16).padStart(40, '0')}`);
    const q = Object.fromEntries(many.map((a) => [a, { priceUsd: 2, volume24hUsd: 9_000 }]));
    const getTokenPairs = vi.fn(async () => null);
    const ds = provider('dexscreener', {}, { getTokenPairs });
    const { svc } = sweep([ds, provider('defillama', q), provider('geckoterminal', q)]);
    await svc.prefetchConsensus(1, many);
    expect(getTokenPairs).toHaveBeenCalledTimes(25);
  });

  it('a positive verdict from an incomplete sample: (b) asks for the token\'s own pairs (a sample can hide a deeper single-sided pair); with no answer the sample\'s pass stands', async () => {
    // A sample only under-counts POOLS ((c)); the market (b) reads off it —
    // the deepest pair's counter side — can be wrong either way.
    const getTokenPairs = vi.fn(async () => null);
    const ds = provider('dexscreener', { [BTCB]: { priceUsd: 85_300, volume24hUsd: 60_866, dexPairs: [btcbPool], dexPairsComplete: false } }, { getTokenPairs });
    const { svc, verdicts } = sweep([ds, ...otherSources()], { [CBBTC]: 85_300 });
    await svc.prefetchConsensus(1, [BTCB]);
    expect(verdicts.find((v) => v.address === BTCB)).toMatchObject({ trustEarned: true });
    expect(getTokenPairs.mock.calls).toEqual([[1, BTCB]]); // one request; a failed one is not repeated in the sweep
  });
});

describe('counter tokens are priced without a provider walk or a persist (shadow changes nothing served)', () => {
  it('a counter outside the sweep is priced from its STORED price; no provider is asked for it, nothing is written for it', async () => {
    const ds = provider('dexscreener', { [BTCB]: { priceUsd: 85_300, volume24hUsd: 60_866, dexPairs: [btcbPool], dexPairsComplete: true } });
    const others = otherSources();
    const { svc, verdicts, tokens } = sweep([ds, ...others], { [CBBTC]: 85_300 });
    await svc.prefetchConsensus(1, [BTCB]);
    expect(verdicts.find((v) => v.address === BTCB)).toMatchObject({ trustEarned: true });
    expect(verdicts.find((v) => v.address === BTCB)!.dexTopCounterUsd).toBeCloseTo(49.1352 * 85_300, 0);
    for (const p of [ds, ...others]) {
      expect(p.getCurrentSingle).not.toHaveBeenCalled();
      for (const call of p.getCurrentBatch.mock.calls) expect(call[1]).not.toContain(CBBTC);
    }
    const written = tokens.upsertPrices.mock.calls.flatMap((c) => c[1] as TokenPriceRecord[]).map((r) => r.address);
    expect(written).not.toContain(CBBTC);
  });

  it('no stored, cached or swept price → the counter is unknown (the pool proves nothing)', async () => {
    const ds = provider('dexscreener', { [BTCB]: { priceUsd: 85_300, volume24hUsd: 60_866, dexPairs: [btcbPool], dexPairsComplete: true } });
    const { svc, verdicts } = sweep([ds, ...otherSources()], {});
    await svc.prefetchConsensus(1, [BTCB]);
    expect(verdicts.find((v) => v.address === BTCB)).toMatchObject({ trustEarned: false, trustReason: 'single-pool', dexTopCounterUsd: 0 });
  });
});

describe('adversarial: trust cannot be bought with two self-seeded $1k pools and DEX-only quotes', () => {
  const policy = trustPolicyOf({ tokenTrustMode: 'earned' });
  // A MOW-style single-sided launch pool plus two balanced $1k seeds.
  const pools = [
    { id: '0xmow', counterUsd: 1_050, liquidityUsd: 11_900_000 },
    { id: '0xseed1', counterUsd: 1_020, liquidityUsd: 2_040 },
    { id: '0xseed2', counterUsd: 1_010, liquidityUsd: 2_020 },
  ];
  it('DexScreener + GeckoTerminal agreeing is one on-chain source → single-source', () => {
    const r = reconcileQuotes([{ source: 'dexscreener', priceUsd: 0.1186 }, { source: 'geckoterminal', priceUsd: 0.1187 }]);
    expect(r.confidence).toBe('consensus');
    const summary = summarizeDexPools(pools, policy.perPoolCounterUsd, policy.deepPoolMinCounterShare);
    const v = evaluateEarnedTrust(
      { freshConsensus: true, consensusNeedsStale: false, dexActive: true, ...summary, hasNonDexSource: r.sources.some((s) => s !== 'dexscreener' && s !== 'geckoterminal') },
      policy,
    );
    expect(v).toEqual({ earned: false, reason: 'single-source' });
  });
  it('even with a non-DEX aggregator agreeing, $1k pools and a single-sided seed do not make a market', () => {
    const summary = summarizeDexPools(pools, policy.perPoolCounterUsd, policy.deepPoolMinCounterShare);
    expect(summary.dexPoolCount).toBe(0);
    const v = evaluateEarnedTrust({ freshConsensus: true, consensusNeedsStale: false, dexActive: true, ...summary, hasNonDexSource: true }, policy);
    expect(v).toEqual({ earned: false, reason: 'single-pool' });
  });
  it('two real balanced pools with ≥ $10k of counter each do', () => {
    const real = [
      { id: '0xa', counterUsd: 40_000, liquidityUsd: 80_000 },
      { id: '0xb', counterUsd: 15_000, liquidityUsd: 30_000 },
    ];
    const summary = summarizeDexPools(real, policy.perPoolCounterUsd, policy.deepPoolMinCounterShare);
    expect(summary.dexPoolCount).toBe(2);
    const v = evaluateEarnedTrust({ freshConsensus: true, consensusNeedsStale: false, dexActive: true, ...summary, hasNonDexSource: true }, policy);
    expect(v.earned).toBe(true);
  });
});

describe('DexScreenerProvider', () => {
  const cfg = { pricingProviderMaxConcurrency: 1, pricingHistoricalSingleConcurrency: 1 } as never;
  const pair = (base: string, quote: string, i: number, chainId = 'ethereum') => ({
    chainId,
    pairAddress: `0x${i.toString(16).padStart(40, '0')}`,
    priceUsd: '2',
    liquidity: { usd: 1_000 + i, base: 10, quote: 20 },
    volume: { h24: 5 },
    baseToken: { address: base },
    quoteToken: { address: quote },
  });

  it('a batch answer below the cap is complete; one AT the cap is a sample', async () => {
    const p = new DexScreenerProvider(cfg);
    const spy = vi.spyOn(p as unknown as { httpJson: () => unknown }, 'httpJson');
    spy.mockResolvedValueOnce({ statusCode: 200, data: { pairs: [pair(BTCB, CBBTC, 1)] } } as never);
    expect((await p.getCurrentBatch(1, [BTCB])).get(`1:${BTCB}`)?.dexPairsComplete).toBe(true);
    const capped = Array.from({ length: DEXSCREENER_RESPONSE_PAIR_CAP }, (_, i) => pair(i === 0 ? BTCB : CBBTC, USDC, i + 10, i % 2 ? 'base' : 'ethereum'));
    spy.mockResolvedValueOnce({ statusCode: 200, data: { pairs: capped } } as never);
    expect((await p.getCurrentBatch(1, [BTCB, CBBTC])).get(`1:${BTCB}`)?.dexPairsComplete).toBe(false);
  });

  it('getTokenPairs: both orientations on this chain only, complete below the cap, cached, null on a rate limit', async () => {
    const p = new DexScreenerProvider(cfg);
    const spy = vi.spyOn(p as unknown as { httpJson: () => unknown }, 'httpJson');
    spy.mockResolvedValueOnce({
      statusCode: 200,
      data: [pair(BTCB, CBBTC, 1), pair(WETH, BTCB, 2), pair(BTCB, USDC, 3, 'base'), pair(CBBTC, USDC, 4)],
    } as never);
    const r = await p.getTokenPairs(1, BTCB.toUpperCase().replace('0X', '0x'));
    expect(r?.complete).toBe(true);
    expect(r?.pairs.map((x) => [x.counterTokenAddress, x.counterLiquidity])).toEqual([
      [WETH, 10], // BTC.b is the QUOTE here → counter is the base side
      [CBBTC, 20],
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
    await p.getTokenPairs(1, BTCB);
    expect(spy).toHaveBeenCalledTimes(1); // cached
    const thirty = Array.from({ length: DEXSCREENER_RESPONSE_PAIR_CAP }, (_, i) => pair(WETH, USDC, i + 100));
    spy.mockResolvedValueOnce({ statusCode: 200, data: [pair(USDC, WETH, 99), ...thirty.slice(1)] } as never);
    expect((await p.getTokenPairs(1, USDC))?.complete).toBe(false); // a capped per-token answer
    spy.mockResolvedValueOnce({ statusCode: 429, data: null } as never);
    expect(await p.getTokenPairs(1, CBBTC)).toBeNull();
    expect(p.isAvailable()).toBe(false);
  });

  it('pairsOfToken: a capped per-token answer is marked incomplete by its caller; ids de-duplicated, deepest first', () => {
    const out = pairsOfToken([pair(BTCB, CBBTC, 1), pair(BTCB, CBBTC, 1), pair(BTCB, USDC, 9)] as never, 'ethereum', BTCB);
    expect(out.map((x) => x.liquidityUsd)).toEqual([1_009, 1_001]);
  });
});
