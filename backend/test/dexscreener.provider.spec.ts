import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEXSCREENER_RESPONSE_PAIR_CAP, DexScreenerProvider, marketOfToken } from '../src/pricing/providers/dexscreener.provider.js';

const RPC = '0xed025a9fe4b30bcd68460bca42583090c2266468';

function provider() {
  const config = { pricingProviderMaxConcurrency: 4, pricingHistoricalSingleConcurrency: 4 };
  return new DexScreenerProvider(config as never);
}

function mockHttp(p: DexScreenerProvider, data: unknown, statusCode = 200) {
  vi.spyOn(p as unknown as { httpJson: () => unknown }, 'httpJson').mockResolvedValue({ statusCode, data } as never);
}

afterEach(() => vi.restoreAllMocks());

describe('DexScreenerProvider', () => {
  it('picks the highest-liquidity ETH pair price', async () => {
    const p = provider();
    mockHttp(p, {
      pairs: [
        { chainId: 'ethereum', baseToken: { address: RPC }, priceUsd: '0.009', liquidity: { usd: 1000 } },
        { chainId: 'ethereum', baseToken: { address: RPC }, priceUsd: '0.0105', liquidity: { usd: 10_500_000 } },
        { chainId: 'base', baseToken: { address: RPC }, priceUsd: '99', liquidity: { usd: 999 } }, // wrong chain, ignored
      ],
    });
    const q = await p.getCurrentSingle(1, RPC);
    expect(q?.priceUsd).toBeCloseTo(0.0105, 6);
    expect(q?.source).toBe('dexscreener');
  });

  it('returns null when no ETH pair exists', async () => {
    const p = provider();
    mockHttp(p, { pairs: [{ chainId: 'base', baseToken: { address: RPC }, priceUsd: '1', liquidity: { usd: 1 } }] });
    expect(await p.getCurrentSingle(1, RPC)).toBeNull();
  });

  it('returns null for an unsupported chain', async () => {
    const p = provider();
    const spy = vi.spyOn(p as unknown as { httpJson: () => unknown }, 'httpJson');
    expect(await p.getCurrentSingle(999, RPC)).toBeNull();
    expect(spy).not.toHaveBeenCalled(); // no network for unknown chain
  });
});

/**
 * DEXSCREENER_BATCH_ENDPOINT + honest coverage. The /latest batch endpoint caps
 * the WHOLE request at 30 pairs (live 2026-10-05: 30 Avalanche tokens → 30
 * pairs over 5 tokens), so a token missing from a capped answer was never
 * looked at; the per-chain endpoint answers one base-side pair per token.
 */
describe('DexScreenerProvider batch endpoint + coverage', () => {
  const WAVAX = '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7';
  const USDC = '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e';
  const USDT = '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7';
  const DAIE = '0xd586e7f844cea2f87f50152665bcbc2c279d8d70';
  const ABSENT = '0x000000000000000000000000000000000000dead';
  const LATEST = 'https://api.dexscreener.com/latest/dex/tokens';
  const PER_CHAIN = 'https://api.dexscreener.com/tokens/v1/avalanche';
  const HTTP_OPTS = { bodyTimeoutMs: 10_000, headersTimeoutMs: 10_000 };

  const withMode = (mode?: 'latest' | 'per-chain') =>
    new DexScreenerProvider({
      pricingProviderMaxConcurrency: 4,
      pricingHistoricalSingleConcurrency: 4,
      ...(mode ? { dexscreenerBatchEndpoint: mode } : {}),
    } as never);
  const http = (p: DexScreenerProvider) => vi.spyOn(p as unknown as { httpJson: () => unknown }, 'httpJson');
  // The live pair shape (2026-10-05 probe of /tokens/v1/avalanche): checksummed addresses, extra fields.
  const pair = (base: string, quote: string, id: string, priceUsd: string, usd: number, quoteReserve: number, h24: number, chainId = 'avalanche') => ({
    chainId,
    dexId: 'uniswap',
    pairAddress: id,
    priceUsd,
    priceNative: '1',
    liquidity: { usd, base: 1, quote: quoteReserve },
    volume: { h24 },
    baseToken: { address: base.replace(/^0x/, '0x').toUpperCase().replace('0X', '0x'), symbol: 'B' },
    quoteToken: { address: quote, symbol: 'Q' },
    labels: ['v4'],
    fdv: 1,
  });
  const latestFixture = () => ({
    pairs: [
      pair(WAVAX, USDC, '0xAAA1', '10.98', 9_007_411, 1_493_459, 51_140_098),
      pair(WAVAX, USDT, '0xAAA2', '10.97', 120_000, 60_000, 1_000),
      pair(USDC, DAIE, '0xAAA3', '0.998', 36_341, 4_337, 1_001),
      pair(DAIE, USDC, '0xAAA4', '1.001', 50_000, 25_000, 77), // USDC as the QUOTE: not a USDC price
      pair(WAVAX, USDC, '0xAAA5', '99', 99_999_999, 1, 1, 'ethereum'), // another chain: ignored
    ],
  });

  it('latest (default and explicit): today\'s URL, parsing and quotes, unchanged', async () => {
    for (const mode of [undefined, 'latest'] as const) {
      const p = withMode(mode);
      const spy = http(p).mockResolvedValue({ statusCode: 200, data: latestFixture() } as never);
      const out = await p.getCurrentBatch(43114, [WAVAX.toUpperCase().replace('0X', '0x'), USDC, ABSENT]);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(`${LATEST}/${WAVAX},${USDC},${ABSENT}`, HTTP_OPTS);
      expect(out).toEqual(
        new Map([
          [
            `43114:${WAVAX}`,
            {
              priceUsd: 10.98,
              source: 'dexscreener',
              volume24hUsd: 51_141_098, // summed over the token's pairs on this chain
              counterLiquidity: 1_493_459,
              counterTokenAddress: USDC,
              dexPairs: [
                { id: '0xaaa1', liquidityUsd: 9_007_411, counterLiquidity: 1_493_459, counterTokenAddress: USDC },
                { id: '0xaaa2', liquidityUsd: 120_000, counterLiquidity: 60_000, counterTokenAddress: USDT },
              ],
              dexPairsComplete: true,
            },
          ],
          [
            `43114:${USDC}`,
            {
              priceUsd: 0.998,
              source: 'dexscreener',
              volume24hUsd: 1_001,
              counterLiquidity: 4_337,
              counterTokenAddress: DAIE,
              dexPairs: [{ id: '0xaaa3', liquidityUsd: 36_341, counterLiquidity: 4_337, counterTokenAddress: DAIE }],
              dexPairsComplete: true,
            },
          ],
        ]),
      );
      vi.restoreAllMocks();
    }
  });

  it('latest: the coverage form makes the same request and returns the same quotes; uncapped → nothing uncertain', async () => {
    const a = withMode('latest');
    http(a).mockResolvedValue({ statusCode: 200, data: latestFixture() } as never);
    const plain = await a.getCurrentBatch(43114, [WAVAX, USDC, ABSENT]);
    const b = withMode('latest');
    const spy = http(b).mockResolvedValue({ statusCode: 200, data: latestFixture() } as never);
    const cov = await b.getCurrentBatchWithCoverage(43114, [WAVAX, USDC, ABSENT]);
    expect(spy).toHaveBeenCalledWith(`${LATEST}/${WAVAX},${USDC},${ABSENT}`, HTTP_OPTS);
    expect(cov.quotes).toEqual(plain);
    // 5 pairs < 30: ABSENT really has no base-side pair here.
    expect([...cov.uncertain]).toEqual([]);
    expect(a.getMetrics()).toEqual(b.getMetrics());
  });

  it('per-chain: /tokens/v1/{chain}/{addrs}, a JSON array, one pair per token, never complete', async () => {
    const p = withMode('per-chain');
    const spy = http(p).mockResolvedValue({
      statusCode: 200,
      // The live answer: one base-side pair each for WAVAX and USDC (DexScreener's pick, not necessarily the deepest), ABSENT absent.
      data: [pair(WAVAX, USDC, '0xAAA1', '10.98', 9_007_411, 1_493_459, 51_140_098), pair(USDC, DAIE, '0xAAA3', '0.998', 36_341, 4_337, 1_001)],
    } as never);
    const cov = await p.getCurrentBatchWithCoverage(43114, [WAVAX.toUpperCase().replace('0X', '0x'), USDC, ABSENT]);
    expect(spy).toHaveBeenCalledWith(`${PER_CHAIN}/${WAVAX},${USDC},${ABSENT}`, HTTP_OPTS);
    expect(cov.quotes.get(`43114:${WAVAX}`)).toEqual({
      priceUsd: 10.98,
      source: 'dexscreener',
      volume24hUsd: 51_140_098,
      counterLiquidity: 1_493_459,
      counterTokenAddress: USDC,
      dexPairs: [{ id: '0xaaa1', liquidityUsd: 9_007_411, counterLiquidity: 1_493_459, counterTokenAddress: USDC }],
      dexPairsComplete: false, // one pair is a sample: earned trust looks the token's own pairs up
    });
    expect(cov.quotes.get(`43114:${USDC}`)).toMatchObject({ priceUsd: 0.998, dexPairsComplete: false });
    expect(cov.quotes.has(`43114:${ABSENT}`)).toBe(false);
    // An uncapped per-chain answer covers every requested token: ABSENT is a definite miss.
    expect([...cov.uncertain]).toEqual([]);
    // getCurrentBatch reads the same endpoint.
    spy.mockClear();
    await p.getCurrentBatch(43114, [WAVAX]);
    expect(spy).toHaveBeenCalledWith(`${PER_CHAIN}/${WAVAX}`, HTTP_OPTS);
  });

  it('per-chain: a `{pairs}` object instead of an array is an error (nothing quoted, nothing vouched for)', async () => {
    const p = withMode('per-chain');
    http(p).mockResolvedValue({ statusCode: 200, data: latestFixture() } as never);
    const cov = await p.getCurrentBatchWithCoverage(43114, [WAVAX, USDC]);
    expect(cov.quotes.size).toBe(0);
    expect([...cov.uncertain].sort()).toEqual([USDC, WAVAX].sort());
    expect(p.getMetrics().error).toBe(1);
  });

  it('per-chain: a 200 whose parsed body is a JSON STRING (or another non-array) is an error — every address uncertain, no definite miss', async () => {
    // A string is iterable: read as pairs, its characters drop out and the
    // answer would look like a healthy, uncapped "no pair for anyone" — 30
    // characters or more and it would even look capped. Neither is an answer.
    for (const body of ['Too Many Requests', 'x'.repeat(DEXSCREENER_RESPONSE_PAIR_CAP + 5), 42, true]) {
      const p = withMode('per-chain');
      http(p).mockResolvedValue({ statusCode: 200, data: body } as never);
      const cov = await p.getCurrentBatchWithCoverage(43114, [WAVAX, USDC]);
      expect(cov.quotes.size, String(body)).toBe(0);
      expect([...cov.uncertain].sort(), String(body)).toEqual([USDC, WAVAX].sort());
      expect(p.getMetrics(), String(body)).toMatchObject({ error: 1, miss: 0 });
    }
  });

  const token = (i: number) => `0x${(0xc000 + i).toString(16).padStart(40, '0')}`;

  it('latest, capped: 30 pairs over 5 tokens → the 5 other requested tokens are uncertain; the quoted ones never are', async () => {
    const p = withMode('latest');
    const requested = Array.from({ length: 10 }, (_, i) => token(i));
    const pairs = Array.from({ length: DEXSCREENER_RESPONSE_PAIR_CAP }, (_, i) =>
      pair(token(i % 5), USDC, `0x${(0xe000 + i).toString(16)}`, '2', 1_000 + i, 10, 5),
    );
    http(p).mockResolvedValue({ statusCode: 200, data: { pairs } } as never);
    const cov = await p.getCurrentBatchWithCoverage(43114, requested);
    expect([...cov.quotes.keys()].sort()).toEqual(requested.slice(0, 5).map((a) => `43114:${a}`).sort());
    for (const q of cov.quotes.values()) expect(q.dexPairsComplete).toBe(false);
    expect([...cov.uncertain].sort()).toEqual(requested.slice(5).sort());
  });

  it('per-chain, capped: 30 requested, 30 pairs → only a token the answer left out is uncertain', async () => {
    const p = withMode('per-chain');
    const requested = Array.from({ length: 30 }, (_, i) => token(i));
    // One pair per token for all 30: capped by count, but nobody is missing.
    const full = requested.map((a, i) => pair(a, USDC, `0x${(0xf000 + i).toString(16)}`, '2', 1_000, 10, 5));
    http(p).mockResolvedValueOnce({ statusCode: 200, data: full } as never);
    const all = await p.getCurrentBatchWithCoverage(43114, requested);
    expect(all.quotes.size).toBe(30);
    expect([...all.uncertain]).toEqual([]);
    // 30 pairs that leave token 29 out (token 0 got two): token 29 proves nothing.
    const skewed = [pair(token(0), USDT, '0xf0ff', '2', 500, 10, 5), ...full.slice(0, 29)];
    http(p).mockResolvedValueOnce({ statusCode: 200, data: skewed } as never);
    const one = await p.getCurrentBatchWithCoverage(43114, requested);
    expect(one.quotes.size).toBe(29);
    expect([...one.uncertain]).toEqual([token(29)]);
    // 29 pairs for 30 tokens: below the cap → token 29 is a definite miss.
    http(p).mockResolvedValueOnce({ statusCode: 200, data: full.slice(0, 29) } as never);
    expect([...(await p.getCurrentBatchWithCoverage(43114, requested)).uncertain]).toEqual([]);
  });

  it('no healthy answer (rate limit, failure, unavailable, unsupported chain) vouches for nobody', async () => {
    const p = withMode('latest');
    const spy = http(p);
    spy.mockRejectedValueOnce(new Error('socket hang up'));
    expect([...(await p.getCurrentBatchWithCoverage(43114, [WAVAX, USDC])).uncertain].sort()).toEqual([USDC, WAVAX].sort());
    spy.mockResolvedValueOnce({ statusCode: 404, data: null } as never);
    expect([...(await p.getCurrentBatchWithCoverage(43114, [WAVAX])).uncertain]).toEqual([WAVAX]);
    spy.mockResolvedValueOnce({ statusCode: 429, data: null } as never);
    expect([...(await p.getCurrentBatchWithCoverage(43114, [WAVAX])).uncertain]).toEqual([WAVAX]);
    expect(p.isAvailable()).toBe(false);
    const calls = spy.mock.calls.length;
    expect([...(await p.getCurrentBatchWithCoverage(43114, [WAVAX])).uncertain]).toEqual([WAVAX]); // skipped
    expect(spy.mock.calls.length).toBe(calls);
    expect([...(await withMode().getCurrentBatchWithCoverage(999, [WAVAX])).uncertain]).toEqual([WAVAX]);
  });
});

/**
 * Live 2026-10-05: /tokens/v1/robinhood/{USDG},{AI} answers TWO entries, both
 * the same AI/USDG pair — USDG has no base-side pair, so it is answered with
 * the pair it is the QUOTE of, which is also AI's own answer.
 */
describe('DexScreenerProvider per-chain: a pair answered twice is counted once', () => {
  const USDG = `0x${'5fc5'.padEnd(36, '0')}d168`; // stand-ins for the live addresses (0x5fc5…d168, 0x2e8c…1e18)
  const AI = `0x${'2e8c'.padEnd(36, '0')}1e18`;
  const aiUsdg = {
    chainId: 'robinhood',
    pairAddress: '0x7AEB000000000000000000000000000000005995',
    priceUsd: '0.5',
    liquidity: { usd: 60_000, base: 60_000, quote: 30_000 },
    volume: { h24: 30 },
    baseToken: { address: AI },
    quoteToken: { address: USDG },
  };
  const mk = (mode: 'latest' | 'per-chain') => {
    const p = new DexScreenerProvider({ pricingProviderMaxConcurrency: 4, pricingHistoricalSingleConcurrency: 4, dexscreenerBatchEndpoint: mode } as never);
    vi.spyOn(p as unknown as { httpJson: () => unknown }, 'httpJson').mockResolvedValue({ statusCode: 200, data: [aiUsdg, { ...aiUsdg }] } as never);
    return p;
  };

  it('AI\'s 24h volume and pool list hold the pair ONCE; USDG (quote-only) gets no quote and, uncapped, is a definite miss', async () => {
    const cov = await mk('per-chain').getCurrentBatchWithCoverage(4663, [USDG, AI]);
    const q = cov.quotes.get(`4663:${AI}`);
    expect(q).toMatchObject({ priceUsd: 0.5, volume24hUsd: 30, counterLiquidity: 30_000, counterTokenAddress: USDG });
    expect(q?.dexPairs).toHaveLength(1);
    expect(cov.quotes.has(`4663:${USDG}`)).toBe(false);
    expect([...cov.uncertain]).toEqual([]);
  });

  it('a null entry in a per-chain answer is dropped: the other pair is quoted, nothing is recorded as an error', async () => {
    const p = new DexScreenerProvider({ pricingProviderMaxConcurrency: 4, pricingHistoricalSingleConcurrency: 4, dexscreenerBatchEndpoint: 'per-chain' } as never);
    vi.spyOn(p as unknown as { httpJson: () => unknown }, 'httpJson').mockResolvedValue({ statusCode: 200, data: [null, aiUsdg] } as never);
    const cov = await p.getCurrentBatchWithCoverage(4663, [AI]);
    expect(cov.quotes.get(`4663:${AI}`)).toMatchObject({ priceUsd: 0.5, volume24hUsd: 30 });
    expect([...cov.uncertain]).toEqual([]);
    expect(p.getMetrics()).toMatchObject({ error: 0, success: 1 });
    // The per-token lookup reads the same parse.
    expect((await p.getTokenPairs(4663, AI))?.base).toEqual({ volume24hUsd: 30, counterLiquidity: 30_000, counterTokenAddress: USDG });
    expect(p.getMetrics().error).toBe(0);
  });

  it('the cap is judged on the RAW answer: 30 entries with a repeat are still a capped sample', async () => {
    const p = new DexScreenerProvider({ pricingProviderMaxConcurrency: 4, pricingHistoricalSingleConcurrency: 4, dexscreenerBatchEndpoint: 'per-chain' } as never);
    const tok = (i: number) => `0x${(0xb000 + i).toString(16).padStart(40, '0')}`;
    const pairs = Array.from({ length: 29 }, (_, i) => ({ ...aiUsdg, pairAddress: `0x${(0xa100 + i).toString(16)}`, baseToken: { address: tok(i) } }));
    vi.spyOn(p as unknown as { httpJson: () => unknown }, 'httpJson').mockResolvedValue({ statusCode: 200, data: [...pairs, { ...pairs[0]! }] } as never);
    const requested = [...Array.from({ length: 29 }, (_, i) => tok(i)), tok(99)];
    const cov = await p.getCurrentBatchWithCoverage(4663, requested);
    expect(cov.quotes.size).toBe(29);
    expect([...cov.uncertain]).toEqual([tok(99)]); // crowded out of a 30-entry answer: proves nothing
  });

  it('getTokenPairs: a cached answer expires after its TTL (a quarter of the quote window, 6 h by default) and is then asked for again', async () => {
    vi.useFakeTimers();
    try {
      const p = mk('per-chain');
      const spy = vi.mocked((p as unknown as { httpJson: () => unknown }).httpJson);
      await p.getTokenPairs(4663, AI);
      expect(spy).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(6 * 60 * 60_000 - 1);
      expect(p.cachedTokenPairs(4663, AI)).toBeDefined(); // still fresh
      await p.getTokenPairs(4663, AI);
      expect(spy).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(2);
      expect(p.cachedTokenPairs(4663, AI)).toBeUndefined();
      await p.getTokenPairs(4663, AI);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('getTokenPairs: `market` reads every pair of the token in EITHER orientation (volume summed, the deepest pair\'s other-side reserve); `base` only its base side', async () => {
    const p = new DexScreenerProvider({ pricingProviderMaxConcurrency: 4, pricingHistoricalSingleConcurrency: 4, dexscreenerBatchEndpoint: 'per-chain' } as never);
    // USDT.e on Avalanche, live shape: its deepest base-side pair holds $568 of
    // USDC; its real depth is as the QUOTE token of WAVAX/USDT.e.
    const USDTE = '0xc7198437980c041c805a1edcba50c1ce5db95118';
    const WAVAX = '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7';
    const USDC = '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e';
    const asBase = { chainId: 'avalanche', pairAddress: '0xa1', priceUsd: '1', liquidity: { usd: 46_955, base: 46_000, quote: 568 }, volume: { h24: 900 }, baseToken: { address: USDTE }, quoteToken: { address: USDC } };
    const asQuote = { chainId: 'avalanche', pairAddress: '0xa2', priceUsd: '10.9', liquidity: { usd: 613_815, base: 28_150, quote: 306_900 }, volume: { h24: 250_000 }, baseToken: { address: WAVAX }, quoteToken: { address: USDTE } };
    const elsewhere = { ...asQuote, chainId: 'ethereum', pairAddress: '0xa3', liquidity: { usd: 9e9, base: 1, quote: 1 } };
    vi.spyOn(p as unknown as { httpJson: () => unknown }, 'httpJson').mockResolvedValue({ statusCode: 200, data: [asBase, asQuote, { ...asQuote }, elsewhere] } as never);
    const own = await p.getTokenPairs(43114, USDTE);
    expect(own?.base).toEqual({ volume24hUsd: 900, counterLiquidity: 568, counterTokenAddress: USDC });
    // The repeated pair counts once; another chain's pair not at all.
    expect(own?.market).toEqual({ volume24hUsd: 250_900, counterLiquidity: 28_150, counterTokenAddress: WAVAX });
  });

  it('getTokenPairs: `base` reads the token\'s market the way a batch answer does (base side, volume summed once); cachedTokenPairs peeks without a request', async () => {
    const p = mk('per-chain');
    expect(p.cachedTokenPairs(4663, AI)).toBeUndefined();
    const own = await p.getTokenPairs(4663, AI);
    expect(own?.base).toEqual({ volume24hUsd: 30, counterLiquidity: 30_000, counterTokenAddress: USDG });
    expect((await p.getTokenPairs(4663, USDG))?.base).toBeUndefined(); // no base-side pair of its own
    const spy = vi.mocked((p as unknown as { httpJson: () => unknown }).httpJson);
    const calls = spy.mock.calls.length;
    expect(p.cachedTokenPairs(4663, AI.toUpperCase().replace('0X', '0x'))).toEqual(own);
    expect(spy.mock.calls.length).toBe(calls);
  });
});

/**
 * `marketOfToken` (per-chain's own-market reading) is documented as the batch
 * parse over both orientations: positive-price pairs only, the first pair on a
 * liquidity tie, and malformed numbers read as 0 rather than poisoning the
 * whole reading.
 */
describe('marketOfToken', () => {
  const T = '0x000000000000000000000000000000000000c0de';
  const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
  const pair = (o: Record<string, unknown>) => ({
    chainId: 'ethereum',
    pairAddress: '0x1',
    priceUsd: '1',
    liquidity: { usd: 100, base: 1, quote: 1 },
    volume: { h24: 1 },
    baseToken: { address: T },
    quoteToken: { address: USDC },
    ...o,
  });

  it('a pair with no positive price ($0, or none) counts for nothing — not its volume, not as the deepest', () => {
    const priced = pair({ pairAddress: '0xa', liquidity: { usd: 100, base: 1, quote: 11 }, volume: { h24: 5 } });
    for (const unpriced of [
      pair({ pairAddress: '0xb', priceUsd: '0', liquidity: { usd: 9_999, base: 1, quote: 22 }, volume: { h24: 1_000 } }),
      pair({ pairAddress: '0xc', priceUsd: undefined, liquidity: { usd: 9_999, base: 1, quote: 33 }, volume: { h24: 1_000 } }),
    ]) {
      expect(marketOfToken([priced, unpriced] as never, 'ethereum', T)).toEqual({ volume24hUsd: 5, counterLiquidity: 11, counterTokenAddress: USDC });
    }
  });

  it('a tie on headline liquidity keeps the FIRST pair (as `pickBestPairs` does)', () => {
    const first = pair({ pairAddress: '0xa', liquidity: { usd: 100, base: 1, quote: 11 } });
    const second = pair({ pairAddress: '0xb', liquidity: { usd: 100, base: 1, quote: 22 } });
    expect(marketOfToken([first, second] as never, 'ethereum', T)?.counterLiquidity).toBe(11);
    expect(marketOfToken([second, first] as never, 'ethereum', T)?.counterLiquidity).toBe(22);
  });

  it("a non-numeric 24h volume is 0: it does not wipe the other pairs' volume", () => {
    const m = marketOfToken([pair({ pairAddress: '0xa', volume: { h24: 'n/a' } }), pair({ pairAddress: '0xb', volume: { h24: 7 } })] as never, 'ethereum', T);
    expect(m?.volume24hUsd).toBe(7);
  });

  it('a non-numeric headline liquidity is 0, not a deepest pair no later pair can displace', () => {
    const m = marketOfToken(
      [pair({ pairAddress: '0xa', liquidity: { usd: 'n/a', base: 1, quote: 11 } }), pair({ pairAddress: '0xb', liquidity: { usd: 50, base: 1, quote: 22 } })] as never,
      'ethereum',
      T,
    );
    expect(m?.counterLiquidity).toBe(22);
  });
});

describe('getTokenPairs: refresh, and when the answer was fetched', () => {
  const T = '0x000000000000000000000000000000000000c0de';
  const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
  const body = (counter: number) => [
    { chainId: 'ethereum', pairAddress: '0xa', priceUsd: '1', liquidity: { usd: 100, base: 1, quote: counter }, volume: { h24: 1 }, baseToken: { address: T }, quoteToken: { address: USDC } },
  ];

  it('`refresh` asks again past a fresh cached answer and replaces it; a failed refresh keeps the cached one; `fetchedAt` dates each', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(1_000_000);
      const p = provider();
      const http = vi.spyOn(p as unknown as { httpJson: () => unknown }, 'httpJson').mockResolvedValue({ statusCode: 200, data: body(11) } as never);
      const first = await p.getTokenPairs(1, T);
      expect(first).toMatchObject({ fetchedAt: 1_000_000, base: { counterLiquidity: 11 } });
      vi.setSystemTime(2_000_000);
      expect(await p.getTokenPairs(1, T)).toBe(first); // cached: no request
      expect(http).toHaveBeenCalledTimes(1);
      http.mockResolvedValue({ statusCode: 200, data: body(22) } as never);
      const again = await p.getTokenPairs(1, T, { refresh: true });
      expect(http).toHaveBeenCalledTimes(2);
      expect(again).toMatchObject({ fetchedAt: 2_000_000, base: { counterLiquidity: 22 } });
      expect(p.cachedTokenPairs(1, T)).toBe(again);
      http.mockResolvedValue({ statusCode: 500, data: null } as never);
      expect(await p.getTokenPairs(1, T, { refresh: true })).toBeNull();
      expect(p.cachedTokenPairs(1, T)).toBe(again);
    } finally {
      vi.useRealTimers();
    }
  });
});
