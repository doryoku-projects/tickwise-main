import { describe, expect, it, vi } from 'vitest';
import {
  historicalTokenPriceRequestKey,
  PricingService,
} from '../src/pricing/pricing.service.js';
import { getSqrtRatioAtTick, sqrtRatioX96ToToken1PerToken0 } from '../src/pricing/tick-math.js';
import { historicalLookupKey } from '../src/database/token-price.repository.js';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const ETH_ZERO = '0x0000000000000000000000000000000000000000';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

function pricingServiceWithCurrentQuotes(quotes: Record<string, number>): PricingService {
  const normalized = new Map(
    Object.entries(quotes).map(([address, price]) => [address.toLowerCase(), price]),
  );
  const provider = {
    name: 'mock-current',
    supportsCurrentBatch: false,
    supportsHistoricalBatch: false,
    maxBatchSize: 1,
    singleConcurrency: 1,
    defaultBackoffMs: 0,
    isEnabled: () => true,
    isAvailable: () => true,
    getCurrentSingle: vi.fn(async (_chainId: number, address: string) => {
      const priceUsd = normalized.get(address.toLowerCase()) ?? 0;
      return priceUsd > 0 ? { priceUsd } : null;
    }),
    getHistoricalSingle: vi.fn(async () => null),
    getMetrics: () => ({ success: 0, miss: 0, ratelimit: 0, error: 0, skip: 0 }),
  };
  return new PricingService(
    { priceFallbackEnabled: true, pricingMissTtlMs: SIX_HOURS_MS } as never,
    {
      findHistoricalNear: async () => null,
      findHistoricalNearMany: async () => new Map(),
      findLatestByTokens: async () => new Map(),
      upsertHistorical: async () => {},
      upsertManyHistorical: async () => {},
    } as never,
    {
      currentProviders: () => [provider],
      historicalProviders: () => [provider],
      getMetricsSnapshot: () => ({}),
    } as never,
  );
}

// Real mainnet addresses for the confidence-gate cases.
const WBTC = '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599';
const BTCB = '0xb0f70c0bd6fd87dbeb7c10dc692a2a6106817072'; // bridged BTC, NOT on CoinGecko-eth list
const FAKE_USDC = '0xc93a59888e7e6f2849ba94acf767266299c4c415'; // symbol "USDC", wrong address

/**
 * Build a PricingService WITH a listing-service mock so the listing-trust gate
 * is exercised (the default helper omits it → fail-open). `listed` is the set of
 * allowlisted addresses; tokens absent from `quotes` have no external quote.
 */
function gatedService(opts: {
  quotes: Record<string, number>;
  listed?: string[];
}): PricingService {
  const normalized = new Map(
    Object.entries(opts.quotes).map(([address, price]) => [address.toLowerCase(), price]),
  );
  const listedSet = new Set((opts.listed ?? []).map((a) => a.toLowerCase()));
  const provider = {
    name: 'mock-current',
    supportsCurrentBatch: false,
    supportsHistoricalBatch: false,
    maxBatchSize: 1,
    singleConcurrency: 1,
    defaultBackoffMs: 0,
    isEnabled: () => true,
    isAvailable: () => true,
    getCurrentSingle: vi.fn(async (_chainId: number, address: string) => {
      const priceUsd = normalized.get(address.toLowerCase()) ?? 0;
      return priceUsd > 0 ? { priceUsd } : null;
    }),
    getHistoricalSingle: vi.fn(async () => null),
    getMetrics: () => ({ success: 0, miss: 0, ratelimit: 0, error: 0, skip: 0 }),
  };
  return new PricingService(
    { priceFallbackEnabled: true, pricingMissTtlMs: SIX_HOURS_MS, tokenListingGateEnabled: true } as never,
    {
      findHistoricalNear: async () => null,
      findHistoricalNearMany: async () => new Map(),
      findLatestByTokens: async () => new Map(),
      upsertHistorical: async () => {},
      upsertManyHistorical: async () => {},
    } as never,
    {
      currentProviders: () => [provider],
      historicalProviders: () => [provider],
      getMetricsSnapshot: () => ({}),
    } as never,
    { isListed: (_chainId: number, addr: string) => listedSet.has(addr.toLowerCase()) } as never,
  );
}

describe('PricingService listing trust (require external market)', () => {
  it('values a non-listed token that has a real external quote (BTC.b)', async () => {
    // WBTC is a trusted anchor; BTC.b is not allowlisted but has an aggregator
    // quote (DeFiLlama) consistent with the pool → kept as external-unverified.
    const service = gatedService({
      quotes: { [WBTC]: 63_500, [BTCB]: 63_700 },
      listed: [WBTC],
    });
    const prices = await service.pricePool({
      chainId: 1,
      protocol: 'uniswap-v4',
      token0: { address: WBTC, symbol: 'WBTC', decimals: 8, verified: true },
      token1: { address: BTCB, symbol: 'BTC.b', decimals: 8, verified: false },
      tick: 0,
      poolTvlUsd: 10_000_000,
      poolTvlUsdUntracked: 10_000_000,
    });
    expect(prices.token1Usd).toBe(63_700);
    expect(prices.token1Confidence).toBe('external-unverified');
  });

  it('values a non-listed token with any external quote in a consistent pool (RPC analog) — no confidence threshold', async () => {
    // TOK has a DEX (GeckoTerminal-style) quote + USDC anchor; the pool ratio
    // agrees with the quote (tick 0, equal decimals → 1:1) → trusted via its real
    // external quote, regardless of confidence. (An inconsistent pool would instead
    // be rejected by the valuation guard — see valuation-guard.spec.)
    const TOK = '0x2234562234562234562234562234562234562234';
    const service = gatedService({
      quotes: { [USDC]: 1, [TOK]: 1 },
      listed: [USDC],
    });
    const prices = await service.pricePool({
      chainId: 1,
      protocol: 'uniswap-v4',
      token0: { address: USDC, symbol: 'USDC', decimals: 6, verified: true },
      token1: { address: TOK, symbol: 'TOK', decimals: 6, verified: false },
      tick: 0,
      poolTvlUsd: 300_000,
      poolTvlUsdUntracked: 300_000,
    });
    expect(prices.token1Usd).toBe(1);
    expect(prices.token1Confidence).toBe('external-unverified');
  });

  it('upgrades a CoinGecko-listed token to external-verified (allowlist, not the indexer flag)', async () => {
    // PENDLE-class: allowlisted but the indexer's `verified` flag is false. The
    // tier must come from the allowlist so the leg can serve as a consistency
    // REFERENCE and listed/listed pools survive the no-reference rule.
    const PENDLE = '0x808507121b80c02388fad14726482e061b8da827';
    const service = gatedService({
      quotes: { [USDC]: 1, [PENDLE]: 3.4 },
      listed: [USDC, PENDLE],
    });
    const prices = await service.pricePool({
      chainId: 1,
      protocol: 'uniswap-v4',
      token0: { address: USDC, symbol: 'USDC', decimals: 6, verified: true },
      token1: { address: PENDLE, symbol: 'PENDLE', decimals: 18, verified: false },
      tick: 0,
      poolTvlUsd: 1_000_000,
      poolTvlUsdUntracked: 1_000_000,
    });
    expect(prices.token1Usd).toBe(3.4);
    expect(prices.token1Confidence).toBe('external-verified');
  });

  it('drops a non-listed token with NO external market — pool-derived only → $0 (USD analog)', async () => {
    // "USD"-style token: no aggregator quote anywhere. Even in a deep, anchored
    // pool it is only pool-derived → not a real market → contributes $0 (no cap).
    const NOMARKET = '0x3334563334563334563334563334563334563334';
    const service = gatedService({
      quotes: { [USDC]: 1 }, // NOMARKET deliberately absent → no external quote
      listed: [USDC],
    });
    const prices = await service.pricePool({
      chainId: 1,
      protocol: 'uniswap-v4',
      token0: { address: USDC, symbol: 'USDC', decimals: 6, verified: true },
      token1: { address: NOMARKET, symbol: 'USD', decimals: 6, verified: false },
      tick: 0,
      poolTvlUsd: 300_000, // deep pool — but a pool alone is not a market
      poolTvlUsdUntracked: 300_000,
    });
    expect(prices.token0Usd).toBe(1); // USDC anchor unaffected
    expect(prices.token1Usd).toBe(0); // no external market → $0
  });

  it('hard-rejects a symbol-spoof token (fake "USDC")', async () => {
    const service = gatedService({
      quotes: { [ETH_ZERO]: 2000, [FAKE_USDC]: 1 },
    });
    const prices = await service.pricePool({
      chainId: 1,
      protocol: 'uniswap-v4',
      token0: { address: ETH_ZERO, symbol: 'ETH', decimals: 18, verified: true },
      token1: { address: FAKE_USDC, symbol: 'USDC', decimals: 18, verified: false },
      tick: 0,
      poolTvlUsd: 500_000,
      poolTvlUsdUntracked: 500_000,
    });
    expect(prices.token0Usd).toBe(2000);
    expect(prices.token1Usd).toBe(0);
    expect(prices.token1Confidence).toBe('suspect');
  });
});

describe('PricingService pool-derived source gate (subgraph circularity)', () => {
  // The Uniswap subgraph prices via derivedETH — propagated through pool ratios —
  // so for a token with no trusted market its "quote" is just its own seeded
  // pool's ratio (real case: spam AU quoted $57.75 purely from its AU/USDT pool,
  // within 5x of that same pool's implied price → uncatchable downstream). The
  // walk must skip subgraph quotes for non-anchor, non-listed tokens and let an
  // independent aggregator speak instead.

  function twoProviderService(opts: {
    subgraphQuotes: Record<string, number>;
    aggregatorQuotes: Record<string, number>;
    listed: string[];
    /** Stored current price (last-known-good) per address. The `{chainId}_tokens`
     * store only ever holds NON-pool-derived quotes (write-side guarantee), so
     * there is no read-side provenance gate — a stored price is served if fresh. */
    lastKnown?: Record<string, number>;
  }): PricingService {
    const norm = (r: Record<string, number>) =>
      new Map(Object.entries(r).map(([a, p]) => [a.toLowerCase(), p]));
    const sub = norm(opts.subgraphQuotes);
    const agg = norm(opts.aggregatorQuotes);
    const last = norm(opts.lastKnown ?? {});
    const listedSet = new Set(opts.listed.map((a) => a.toLowerCase()));
    const mkProvider = (name: string, quotes: Map<string, number>) => ({
      name,
      supportsCurrentBatch: false,
      supportsHistoricalBatch: false,
      maxBatchSize: 1,
      singleConcurrency: 1,
      defaultBackoffMs: 0,
      isEnabled: () => true,
      isAvailable: () => true,
      getCurrentSingle: vi.fn(async (_chainId: number, address: string) => {
        const priceUsd = quotes.get(address.toLowerCase()) ?? 0;
        return priceUsd > 0 ? { priceUsd } : null;
      }),
      getHistoricalSingle: vi.fn(async () => null),
      getMetrics: () => ({ success: 0, miss: 0, ratelimit: 0, error: 0, skip: 0 }),
    });
    const providers = [mkProvider('subgraph-current', sub), mkProvider('defillama', agg)];
    return new PricingService(
      { priceFallbackEnabled: true, pricingMissTtlMs: SIX_HOURS_MS, tokenListingGateEnabled: true } as never,
      {
        findHistoricalNear: async () => null,
        findHistoricalNearMany: async () => new Map(),
        upsertHistorical: async () => {},
        upsertManyHistorical: async () => {},
      } as never,
      {
        currentProviders: () => providers,
        historicalProviders: () => providers,
        getMetricsSnapshot: () => ({}),
      } as never,
      { isListed: (_chainId: number, addr: string) => listedSet.has(addr.toLowerCase()) } as never,
      // 5th arg: the `{chainId}_tokens` last-known-good store.
      {
        findLatestPrices: async (_chainId: number, addrs: string[]) =>
          new Map(
            addrs
              .map((a) => a.toLowerCase())
              .filter((a) => (last.get(a) ?? 0) > 0)
              .map((a) => [a, { priceUsd: last.get(a)!, pricedAt: new Date() }]),
          ),
        upsertPrices: async () => {},
      } as never,
    );
  }

  const SPAM = '0xab94a15e2d1a47069f4c6c33326a242ba20abd9b'; // AU — non-listed, subgraph-only "price"
  const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7';

  it('ignores a subgraph quote for a non-listed token with no independent quote (AU/USDT)', async () => {
    const service = twoProviderService({
      subgraphQuotes: { [USDT]: 1, [SPAM]: 57.75 }, // derivedETH minted by its own pool
      aggregatorQuotes: { [USDT]: 1 },              // no aggregator knows the token
      listed: [USDT],
    });
    const prices = await service.pricePool({
      chainId: 1,
      protocol: 'uniswap-v4',
      token0: { address: SPAM, symbol: 'AU', decimals: 18, verified: false },
      token1: { address: USDT, symbol: 'USDT', decimals: 6, verified: true },
      tick: 0,
      poolTvlUsd: 300_000,
      poolTvlUsdUntracked: 300_000,
    });
    expect(prices.token0Usd).toBe(0); // pool-derived only → no real market
    expect(prices.token1Usd).toBe(1);
  });

  it('prefers an independent aggregator over a garbage subgraph quote even for an ANCHOR (BUSD-class)', async () => {
    // BUSD is a config stablecoin anchor, but it is dead/thin on v4 — a seeded
    // pool minted derivedETH = $9,155.85 for it. Anchors get NO pass-1
    // pool-derived quotes either; DeFiLlama's $1.00 must win.
    const BUSD = '0x4Fabb145d64652a948d72533023f6E7A623C7C53';
    const service = twoProviderService({
      subgraphQuotes: { [BUSD]: 9_155.85 },
      aggregatorQuotes: { [BUSD]: 1.0, [USDT]: 1 },
      listed: [USDT, BUSD],
    });
    const prices = await service.pricePool({
      chainId: 1,
      protocol: 'uniswap-v4',
      token0: { address: BUSD, symbol: 'BUSD', decimals: 18, verified: true },
      token1: { address: USDT, symbol: 'USDT', decimals: 6, verified: true },
      tick: 0,
      poolTvlUsd: 1_000_000,
      poolTvlUsdUntracked: 1_000_000,
    });
    expect(prices.token0Usd).toBe(1.0);
  });

  it('prefers an independent aggregator over a garbage subgraph quote for an ALLOWLISTED token (FDUSD-class)', async () => {
    // Real FDUSD is allowlisted, but the v4 subgraph minted $287 for it from a
    // seeded pool. The walk must let DeFiLlama ($0.997) speak first; the
    // subgraph is only a fallback when aggregators miss.
    const FDUSD = '0xc5f0f7b66764f6ec8c8dff7ba683102295e16409';
    const service = twoProviderService({
      subgraphQuotes: { [FDUSD]: 287.46 },
      aggregatorQuotes: { [FDUSD]: 0.997, [USDT]: 1 },
      listed: [USDT, FDUSD],
    });
    const prices = await service.pricePool({
      chainId: 1,
      protocol: 'uniswap-v4',
      token0: { address: FDUSD, symbol: 'FDUSD', decimals: 18, verified: false },
      token1: { address: USDT, symbol: 'USDT', decimals: 6, verified: true },
      tick: 0,
      poolTvlUsd: 1_000_000,
      poolTvlUsdUntracked: 1_000_000,
    });
    expect(prices.token0Usd).toBe(0.997);
  });

  it('falls back to the subgraph quote for a listed token the aggregators missed — DEMOTED to pool-derived (PENDLE/AMKT-class)', async () => {
    // The pass-2 fallback price is still served (3.4) but its confidence must
    // be pool-derived, NOT external-verified: derivedETH is seedable (real
    // allowlisted AMKT was minted $10.4M by a honeypot pool), so a fallback
    // quote can never act as a trust reference or count as a verified market.
    const LISTED_TOK = '0x808507121b80c02388fad14726482e061b8da827'; // PENDLE
    const service = twoProviderService({
      subgraphQuotes: { [USDT]: 1, [LISTED_TOK]: 3.4 },
      aggregatorQuotes: {},
      listed: [USDT, LISTED_TOK],
    });
    const prices = await service.pricePool({
      chainId: 1,
      protocol: 'uniswap-v4',
      token0: { address: LISTED_TOK, symbol: 'PENDLE', decimals: 18, verified: false },
      token1: { address: USDT, symbol: 'USDT', decimals: 6, verified: true },
      tick: 0,
      poolTvlUsd: 1_000_000,
      poolTvlUsdUntracked: 1_000_000,
    });
    expect(prices.token0Usd).toBe(3.4);
    expect(prices.token0Confidence).toBe('pool-derived-strong');
  });

  it('keeps anchor confidence for an ANCHOR priced via the pass-2 fallback', async () => {
    // USDT through pass-2 (aggregators down): the price is the subgraph's, but
    // the anchor assertion stands — anchors are config-trusted, not quote-rated.
    const service = twoProviderService({
      subgraphQuotes: { [USDT]: 1 },
      aggregatorQuotes: {},
      listed: [USDT],
    });
    const prices = await service.pricePool({
      chainId: 1,
      protocol: 'uniswap-v4',
      token0: { address: USDT, symbol: 'USDT', decimals: 6, verified: true },
      token1: { address: '0x9999999999999999999999999999999999999999', symbol: 'X', decimals: 18, verified: false },
      tick: 0,
      poolTvlUsd: 1_000_000,
      poolTvlUsdUntracked: 1_000_000,
    });
    expect(prices.token0Usd).toBe(1);
    expect(prices.token0Confidence).toBe('anchor');
  });

  it('falls through to an independent aggregator for a non-listed real token (BTC.b-class)', async () => {
    const BRIDGED = '0x2297aebd383787a160dd0d9f71508148769342e3'; // BTC.b — not on the eth allowlist
    const service = twoProviderService({
      subgraphQuotes: { [BRIDGED]: 61_000 }, // skipped: pool-derived for a non-listed token
      aggregatorQuotes: { [BRIDGED]: 61_163 }, // DeFiLlama's independent quote wins
      listed: [USDT],
    });
    const prices = await service.pricePool({
      chainId: 1,
      protocol: 'uniswap-v4',
      token0: { address: BRIDGED, symbol: 'BTC.b', decimals: 8, verified: false },
      token1: { address: USDT, symbol: 'USDT', decimals: 6, verified: true },
      tick: 0,
      poolTvlUsd: 1_000_000,
      poolTvlUsdUntracked: 1_000_000,
    });
    expect(prices.token0Usd).toBe(61_163);
    expect(prices.token0Confidence).toBe('external-unverified');
  });

  it('does NOT resurrect a non-listed token with no stored last-known (stays $0)', async () => {
    // No live quote + nothing in the `{chainId}_tokens` store for AU → $0. The
    // store can only ever hold NON-pool-derived quotes (write-side guarantee),
    // so a seeded derivedETH price can never be persisted, hence never resurfaces.
    const service = twoProviderService({
      subgraphQuotes: {},
      aggregatorQuotes: {},
      listed: [USDT],
      lastKnown: { [USDT]: 1 }, // only the anchor has a stored price
    });
    const prices = await service.pricePool({
      chainId: 1,
      protocol: 'uniswap-v4',
      token0: { address: SPAM, symbol: 'AU', decimals: 18, verified: false },
      token1: { address: USDT, symbol: 'USDT', decimals: 6, verified: true },
      tick: 0,
      poolTvlUsd: 300_000,
      poolTvlUsdUntracked: 300_000,
    });
    expect(prices.token0Usd).toBe(0); // nothing stored → no resurrection
    expect(prices.token1Usd).toBe(1); // anchor last-known served
  });

  it('serves an AGGREGATOR last-known row for a non-listed token (RPC-class — survives rate-limit gaps)', async () => {
    // Gecko quotes RPC only intermittently (rate limits); its stored real
    // aggregator quote must serve between hits so the position doesn't flap
    // pending↔valid every tick. What the quote is WORTH is still gated
    // downstream (consistency, realizability, pending-reserves).
    const service = twoProviderService({
      subgraphQuotes: {},
      aggregatorQuotes: {},
      listed: [USDT],
      lastKnown: { [SPAM]: 0.0107, [USDT]: 1 },
    });
    const prices = await service.pricePool({
      chainId: 1,
      protocol: 'uniswap-v4',
      token0: { address: SPAM, symbol: 'RPC', decimals: 18, verified: false },
      token1: { address: USDT, symbol: 'USDT', decimals: 6, verified: true },
      tick: 0,
      poolTvlUsd: 300_000,
      poolTvlUsdUntracked: 300_000,
    });
    expect(prices.token0Usd).toBeCloseTo(0.0107, 6);
    expect(prices.token1Usd).toBe(1);
  });
});

describe('PricingService current-price resilience (last-known-good)', () => {
  const TOK = '0x5555555555555555555555555555555555555555';

  // No listing service → gate off (fail-open), so a priced token's value flows
  // straight through; isolates the last-known fallback behavior.
  function resilientService(opts: {
    live: Record<string, number>;
    lastKnown?: Record<string, { priceUsd: number; ageMs: number }>;
    onPersist?: (records: Array<{ address: string; priceUsd: number }>) => void;
  }): PricingService {
    const live = new Map(Object.entries(opts.live).map(([a, p]) => [a.toLowerCase(), p]));
    const lk = new Map(
      Object.entries(opts.lastKnown ?? {}).map(([a, v]) => [
        a.toLowerCase(),
        { priceUsd: v.priceUsd, pricedAt: new Date(Date.now() - v.ageMs) },
      ]),
    );
    const provider = {
      name: 'mock-current',
      supportsCurrentBatch: false,
      supportsHistoricalBatch: false,
      maxBatchSize: 1,
      singleConcurrency: 1,
      defaultBackoffMs: 0,
      isEnabled: () => true,
      isAvailable: () => true,
      getCurrentSingle: vi.fn(async (_chainId: number, address: string) => {
        const p = live.get(address.toLowerCase()) ?? 0;
        return p > 0 ? { priceUsd: p } : null;
      }),
      getHistoricalSingle: vi.fn(async () => null),
      getMetrics: () => ({ success: 0, miss: 0, ratelimit: 0, error: 0, skip: 0 }),
    };
    const tokenPrices = {
      findHistoricalNear: async () => null,
      findHistoricalNearMany: async () => new Map(),
      upsertHistorical: async () => {},
      upsertManyHistorical: async () => {},
    };
    // The `{chainId}_tokens` last-known-good store (current-price cache).
    const tokens = {
      findLatestPrices: async (_chainId: number, addrs: string[]) => {
        const m = new Map<string, { priceUsd: number; pricedAt?: Date }>();
        for (const a of addrs) {
          const r = lk.get(a.toLowerCase());
          if (r) m.set(a.toLowerCase(), r);
        }
        return m;
      },
      upsertPrices: async (_chainId: number, recs: Array<{ address: string; priceUsd: number }>) => { opts.onPersist?.(recs); },
    };
    return new PricingService(
      { priceFallbackEnabled: true, pricingMissTtlMs: SIX_HOURS_MS } as never,
      tokenPrices as never,
      {
        currentProviders: () => [provider],
        historicalProviders: () => [provider],
        getMetricsSnapshot: () => ({}),
      } as never,
      undefined as never, // listing service (absent → gate off)
      tokens as never, // 5th: tokens last-known-good store
    );
  }

  async function token1Value(service: PricingService): Promise<number> {
    const prices = await service.pricePool({
      chainId: 1,
      protocol: 'uniswap-v4',
      token0: { address: USDC, symbol: 'USDC', decimals: 6, verified: true },
      token1: { address: TOK, symbol: 'TOK', decimals: 18, verified: false },
      tick: 0,
      poolTvlUsd: 0, // 0 → no pool-ratio fill/override; isolates the external/last-known price
      poolTvlUsdUntracked: 0,
    });
    return prices.token1Usd;
  }

  it('serves a recent last-known price when the live provider misses (no flip to $0)', async () => {
    const service = resilientService({ live: { [USDC]: 1 }, lastKnown: { [TOK]: { priceUsd: 5, ageMs: 60_000 } } });
    expect(await token1Value(service)).toBe(5);
  });

  it('returns $0 when the live provider misses and there is no last-known (no-market token)', async () => {
    const service = resilientService({ live: { [USDC]: 1 } });
    expect(await token1Value(service)).toBe(0);
  });

  it('ignores a stale last-known price beyond the freshness window', async () => {
    const service = resilientService({ live: { [USDC]: 1 }, lastKnown: { [TOK]: { priceUsd: 5, ageMs: 48 * 60 * 60 * 1000 } } });
    expect(await token1Value(service)).toBe(0);
  });

  it('a negative-cached miss does NOT mask a last-known-good that arrives later (iUSDC/RUBT bug)', async () => {
    // First call: provider misses + 1_tokens empty → negative-cached 0. Then a
    // price appears in 1_tokens (the price sweep / another sync wrote it). The
    // in-memory negative entry (still within its short TTL) must NOT keep
    // returning 0 — it must re-consult last-known and serve the real price.
    let lkPrice = 0;
    const provider = {
      name: 'mock-current', supportsCurrentBatch: false, supportsHistoricalBatch: false,
      maxBatchSize: 1, singleConcurrency: 1, defaultBackoffMs: 0,
      isEnabled: () => true, isAvailable: () => true,
      getCurrentSingle: vi.fn(async (_c: number, address: string) => (address.toLowerCase() === USDC ? { priceUsd: 1 } : null)),
      getHistoricalSingle: vi.fn(async () => null),
      getMetrics: () => ({ success: 0, miss: 0, ratelimit: 0, error: 0, skip: 0 }),
    };
    const tokens = {
      findLatestPrices: async (_c: number, addrs: string[]) => {
        const m = new Map<string, { priceUsd: number; pricedAt?: Date }>();
        if (lkPrice > 0) for (const a of addrs) m.set(a.toLowerCase(), { priceUsd: lkPrice, pricedAt: new Date() });
        return m;
      },
      upsertPrices: async () => {},
    };
    const service = new PricingService(
      { priceFallbackEnabled: true, pricingMissTtlMs: SIX_HOURS_MS } as never,
      { findHistoricalNear: async () => null, findHistoricalNearMany: async () => new Map(), upsertHistorical: async () => {}, upsertManyHistorical: async () => {} } as never,
      { currentProviders: () => [provider], historicalProviders: () => [provider], getMetricsSnapshot: () => ({}) } as never,
      undefined as never,
      tokens as never,
    );
    expect(await token1Value(service)).toBe(0); // negative-cached
    lkPrice = 9; // 1_tokens now has the price
    expect(await token1Value(service)).toBe(9); // negative cache must not mask it
  });

  it('persists a successful live price as last-known-good', async () => {
    const persisted: Array<{ address: string; priceUsd: number }> = [];
    const service = resilientService({ live: { [USDC]: 1, [TOK]: 7 }, onPersist: (r) => persisted.push(...r) });
    expect(await token1Value(service)).toBe(7);
    expect(persisted.some((r) => r.address.toLowerCase() === TOK && r.priceUsd === 7)).toBe(true);
  });
});

describe('tick math', () => {
  it('converts tick 0 to a 1:1 human ratio for matching decimals', () => {
    const sqrt = getSqrtRatioAtTick(0);
    expect(sqrtRatioX96ToToken1PerToken0(sqrt, 18, 18)).toBeCloseTo(1, 12);
  });

  it('applies token decimal differences', () => {
    const sqrt = getSqrtRatioAtTick(0);
    expect(sqrtRatioX96ToToken1PerToken0(sqrt, 6, 18)).toBeCloseTo(1e-12, 18);
  });

  it('returns a finite tiny ratio for extreme-low-price pools (no BigInt underflow to 0)', () => {
    // PORT3/USDT real sqrtPriceX96 — the prior BigInt form floored this to 0,
    // which silently disabled the pool-consistency guard. Must be > 0 now.
    const r = sqrtRatioX96ToToken1PerToken0(12828914291496n, 18, 6);
    expect(r).toBeGreaterThan(0);
    expect(r).toBeCloseTo(2.62e-20, 22);
  });
});

describe('PricingService historical bulk pricing', () => {
  it('dedupes token bucket lookups across timestamps and chains', async () => {
    const findHistoricalNearMany = vi.fn(async (lookups) => new Map(
      lookups.map((lookup) => [
        historicalLookupKey(lookup),
        {
          chainId: lookup.chainId,
          address: lookup.address,
          bucketTs: lookup.bucketTs,
          priceUsd: 2,
          source: 'defillama',
        },
      ]),
    ));
    const service = new PricingService(
      { priceFallbackEnabled: false, coingeckoApiKey: undefined, pricingMissTtlMs: SIX_HOURS_MS } as never,
      {
        findHistoricalNear: async () => null,
        findHistoricalNearMany,
        upsertHistorical: async () => {},
        upsertManyHistorical: async () => {},
      } as never,
    );
    const token = '0x0000000000000000000000000000000000000001';
    // USDC — no longer auto-anchored at $1, flows through cache + providers
    // like any other token.
    const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

    const prices = await service.historicalTokenPricesUsdMany([
      { chainId: 1, address: token, timestamp: 1_700_000_001 },
      { chainId: 1, address: token, timestamp: 1_700_000_100 },
      { chainId: 1, address: usdc, timestamp: 1_700_000_100 },
    ]);

    expect(findHistoricalNearMany).toHaveBeenCalledTimes(1);
    // Two unique (chainId, address, bucketTs) tuples: `token`@bucket + `usdc`@bucket
    expect(findHistoricalNearMany.mock.calls[0]?.[0]).toHaveLength(2);
    expect(findHistoricalNearMany.mock.calls[0]?.[0]?.[0].windowBuckets).toBe(14_400);
    expect(prices.get(historicalTokenPriceRequestKey(1, token, 1_700_000_001))).toBe(2);
    // USDC is no longer anchored; comes from cache row (priceUsd=2 in this mock).
    expect(prices.get(historicalTokenPriceRequestKey(1, usdc, 1_700_000_100))).toBe(2);
  });

  it('findStaleDerivedCacheKeys returns only keys whose source is derived AND fetchedAt < cutoff', async () => {
    const cutoff = new Date('2026-05-27T00:00:00Z');
    const findHistoricalNearMany = vi.fn(async (lookups) => {
      const out = new Map();
      for (const lookup of lookups) {
        const key = historicalLookupKey(lookup);
        const map: Record<string, { source: string; fetchedAt: Date }> = {
          // poisoned: derived + fetched before cutoff → included
          '1:0xpoisoned:1700000000': { source: 'subgraph-pool-ratio', fetchedAt: new Date('2026-05-01T00:00:00Z') },
          // fresh derived: derived but fetched after cutoff → excluded
          '1:0xfresh:1700000000': { source: 'subgraph-pool-ratio', fetchedAt: new Date('2026-06-01T00:00:00Z') },
          // external: not derived → excluded
          '1:0xexternal:1700000000': { source: 'defillama', fetchedAt: new Date('2026-05-01T00:00:00Z') },
        };
        const row = map[key];
        if (row) {
          out.set(key, {
            chainId: lookup.chainId,
            address: lookup.address,
            bucketTs: lookup.bucketTs,
            priceUsd: 1,
            source: row.source,
            fetchedAt: row.fetchedAt,
          });
        }
      }
      return out;
    });
    const service = new PricingService(
      { priceFallbackEnabled: false, coingeckoApiKey: undefined, pricingMissTtlMs: SIX_HOURS_MS } as never,
      {
        findHistoricalNear: async () => null,
        findHistoricalNearMany,
        upsertHistorical: async () => {},
        upsertManyHistorical: async () => {},
      } as never,
    );

    const poisoned = await service.findStaleDerivedCacheKeys(
      [
        { chainId: 1, address: '0xpoisoned', bucketTs: 1_700_000_000 },
        { chainId: 1, address: '0xfresh', bucketTs: 1_700_000_000 },
        { chainId: 1, address: '0xexternal', bucketTs: 1_700_000_000 },
        { chainId: 1, address: '0xmissing', bucketTs: 1_700_000_000 },
      ],
      cutoff,
    );

    expect(poisoned.size).toBe(1);
    expect(poisoned.has('1:0xpoisoned:1700000000')).toBe(true);
  });

  it('findStaleDerivedCacheKeys short-circuits on empty input without hitting Mongo', async () => {
    const findHistoricalNearMany = vi.fn(async () => new Map());
    const service = new PricingService(
      { priceFallbackEnabled: false, coingeckoApiKey: undefined, pricingMissTtlMs: SIX_HOURS_MS } as never,
      {
        findHistoricalNear: async () => null,
        findHistoricalNearMany,
        upsertHistorical: async () => {},
        upsertManyHistorical: async () => {},
      } as never,
    );

    const result = await service.findStaleDerivedCacheKeys([], new Date());

    expect(result.size).toBe(0);
    expect(findHistoricalNearMany).not.toHaveBeenCalled();
  });
});

describe('PricingService current pool pricing', () => {
  it('overrides a bad external quote for an unverified token paired with a strong native anchor', async () => {
    // TVL above the policy's override-unverified threshold (25k by default).
    const badToken = '0xc3761eb917cd790b30dad99f6cc5b4ff93c4f9ea';
    const service = pricingServiceWithCurrentQuotes({
      [ETH_ZERO]: 2000,
      [badToken]: 0.018,
    });

    const prices = await service.pricePool({
      chainId: 1,
      protocol: 'uniswap-v4',
      token0: { address: ETH_ZERO, symbol: 'ETH', decimals: 18, verified: true },
      token1: { address: badToken, symbol: 'ERC20', decimals: 18, verified: false },
      tick: 0,
      poolTvlUsd: 50_000,
      poolTvlUsdUntracked: 50_000,
    });

    expect(prices.token0Usd).toBe(2000);
    expect(prices.token1Usd).toBe(2000);
    expect(prices.usedFallback).toBe(true);
    expect(prices.token1Source).toBe('pool-ratio');
  });

  it('does NOT override a verified external quote when the pool is weak', async () => {
    const token = '0x1111111111111111111111111111111111111111';
    const service = pricingServiceWithCurrentQuotes({
      [USDC]: 1,
      [token]: 100,
    });

    const prices = await service.pricePool({
      chainId: 1,
      protocol: 'uniswap-v4',
      token0: { address: token, symbol: 'TOK', decimals: 18, verified: true },
      token1: { address: USDC, symbol: 'USDC', decimals: 6, verified: true },
      // Weak pool — TVL well below verified-override threshold (250k).
      tick: 0,
      poolTvlUsd: 1_000,
      poolTvlUsdUntracked: 1_000,
    });

    // Verified token keeps its external quote even though the on-chain
    // ratio implies a different price — this is the manipulation-safety
    // property the policy refactor protects.
    expect(prices.token0Usd).toBe(100);
    expect(prices.token1Usd).toBe(1);
    expect(prices.usedFallback).toBe(false);
    expect(prices.token0Source).toBe('external');
    expect(prices.token0Confidence).toBe('external-verified');
  });

  it('rejects an over-ceiling pool-ratio price even on a deep pool — keeps the external (sanity ceiling)', async () => {
    const token = '0x1111111111111111111111111111111111111111';
    const service = pricingServiceWithCurrentQuotes({
      [USDC]: 1,
      [token]: 100,
    });

    const prices = await service.pricePool({
      chainId: 1,
      protocol: 'uniswap-v4',
      token0: { address: token, symbol: 'TOK', decimals: 18, verified: true },
      token1: { address: USDC, symbol: 'USDC', decimals: 6, verified: true },
      tick: 0,
      // tick 0 + decimals 18/6 derives a $1e12/token ratio — absurd, above the
      // MAX_DERIVED_TOKEN_PRICE_USD ceiling. The override must be rejected and
      // the external quote kept (this is the $89B-poisoning guard).
      poolTvlUsd: 500_000,
      poolTvlUsdUntracked: 500_000,
    });

    expect(prices.token0Usd).toBe(100);
    expect(prices.token1Usd).toBe(1);
    expect(prices.usedFallback).toBe(false);
    expect(prices.token0Source).toBe('external');
  });

  it('keeps a verified external quote when it agrees with the anchor-derived price', async () => {
    const token = '0x2222222222222222222222222222222222222222';
    const service = pricingServiceWithCurrentQuotes({
      [USDC]: 1,
      [token]: 1e12,
    });

    const prices = await service.pricePool({
      chainId: 1,
      protocol: 'uniswap-v4',
      token0: { address: token, symbol: 'TOK', decimals: 18, verified: true },
      token1: { address: USDC, symbol: 'USDC', decimals: 6, verified: true },
      tick: 0,
      poolTvlUsd: 1_000,
      poolTvlUsdUntracked: 1_000,
    });

    expect(prices.token0Usd).toBe(1e12);
    expect(prices.token1Usd).toBe(1);
    expect(prices.usedFallback).toBe(false);
  });

  it('fills a missing external quote via pool-ratio when paired with a stable anchor', async () => {
    const token = '0x3333333333333333333333333333333333333333';
    // Anchor priced; unknown token missing from current providers.
    const service = pricingServiceWithCurrentQuotes({ [USDC]: 1 });

    const prices = await service.pricePool({
      chainId: 1,
      protocol: 'uniswap-v4',
      token0: { address: USDC, symbol: 'USDC', decimals: 6, verified: true },
      token1: { address: token, symbol: 'TOK', decimals: 6, verified: false },
      // Matching decimals, tick 0 → ratio is 1, so token1 derived = anchor / 1 = 1.
      tick: 0,
      poolTvlUsd: 5_000,
      poolTvlUsdUntracked: 5_000,
    });

    expect(prices.token0Usd).toBe(1);
    expect(prices.token1Usd).toBe(1);
    expect(prices.usedFallback).toBe(true);
    expect(prices.token1Source).toBe('pool-ratio');
  });

  it('disables pool-ratio derivation when protocol does not support it', async () => {
    const token = '0x4444444444444444444444444444444444444444';
    const service = pricingServiceWithCurrentQuotes({ [USDC]: 1 });

    const prices = await service.pricePool({
      chainId: 1,
      // Unknown protocol → policy sets derivation.enabled=false.
      protocol: 'unknown-protocol',
      token0: { address: USDC, symbol: 'USDC', decimals: 6, verified: true },
      token1: { address: token, symbol: 'TOK', decimals: 6, verified: false },
      tick: 0,
      poolTvlUsd: 100_000,
      poolTvlUsdUntracked: 100_000,
    });

    // Anchor still priced; unknown token stays at 0 because derivation is gated.
    expect(prices.token0Usd).toBe(1);
    expect(prices.token1Usd).toBe(0);
    expect(prices.usedFallback).toBe(false);
  });
});

describe('Paid provider key gating', () => {
  it('Alchemy isEnabled=false when no keys configured', async () => {
    const { AlchemyProvider } = await import('../src/pricing/providers/alchemy.provider.js');
    const provider = new AlchemyProvider({ alchemyApiKeys: [] } as never);
    expect(provider.isEnabled()).toBe(false);
  });

  it('Alchemy isEnabled=true when at least one key configured', async () => {
    const { AlchemyProvider } = await import('../src/pricing/providers/alchemy.provider.js');
    const provider = new AlchemyProvider({ alchemyApiKeys: ['k1'] } as never);
    expect(provider.isEnabled()).toBe(true);
  });

  it('Moralis isEnabled=false when no keys configured', async () => {
    const { MoralisProvider } = await import('../src/pricing/providers/moralis.provider.js');
    const provider = new MoralisProvider({ moralisApiKeys: [] } as never);
    expect(provider.isEnabled()).toBe(false);
  });

  it('Moralis isEnabled=true when at least one key configured', async () => {
    const { MoralisProvider } = await import('../src/pricing/providers/moralis.provider.js');
    const provider = new MoralisProvider({ moralisApiKeys: ['k1'] } as never);
    expect(provider.isEnabled()).toBe(true);
  });

  it('Chainbase isEnabled=false when no keys configured', async () => {
    const { ChainbaseProvider } = await import('../src/pricing/providers/chainbase.provider.js');
    const provider = new ChainbaseProvider({ chainbaseApiKeys: [] } as never);
    expect(provider.isEnabled()).toBe(false);
  });

  it('Chainbase isEnabled=true when at least one key configured', async () => {
    const { ChainbaseProvider } = await import('../src/pricing/providers/chainbase.provider.js');
    const provider = new ChainbaseProvider({ chainbaseApiKeys: ['k1'] } as never);
    expect(provider.isEnabled()).toBe(true);
  });
});

describe('KeyPool rotation', () => {
  it('rotates round-robin across keys', async () => {
    const { KeyPool } = await import('../src/pricing/providers/key-pool.js');
    const pool = new KeyPool(['k1', 'k2', 'k3']);
    expect(pool.pickAvailable()?.key).toBe('k1');
    expect(pool.pickAvailable()?.key).toBe('k2');
    expect(pool.pickAvailable()?.key).toBe('k3');
    expect(pool.pickAvailable()?.key).toBe('k1');
  });

  it('skips rate-limited keys but stays available', async () => {
    const { KeyPool } = await import('../src/pricing/providers/key-pool.js');
    const pool = new KeyPool(['k1', 'k2', 'k3']);
    const first = pool.pickAvailable();
    pool.markRateLimited(first!.index, 60_000);
    const second = pool.pickAvailable();
    expect(second?.key).toBe('k2');
    expect(pool.hasAvailable()).toBe(true);
  });

  it('returns null + reports unavailable when every key benched', async () => {
    const { KeyPool } = await import('../src/pricing/providers/key-pool.js');
    const pool = new KeyPool(['k1', 'k2']);
    pool.markRateLimited(0, 60_000);
    pool.markRateLimited(1, 60_000);
    expect(pool.pickAvailable()).toBeNull();
    expect(pool.hasAvailable()).toBe(false);
  });

  it('size=0 for empty key list', async () => {
    const { KeyPool } = await import('../src/pricing/providers/key-pool.js');
    const pool = new KeyPool([]);
    expect(pool.size).toBe(0);
    expect(pool.pickAvailable()).toBeNull();
  });
});

describe('PricingService miss cache', () => {
  function makeProvider(name: string, single: () => Promise<{ priceUsd: number } | null>) {
    return {
      name,
      supportsCurrentBatch: false,
      supportsHistoricalBatch: false,
      maxBatchSize: 1,
      singleConcurrency: 1,
      defaultBackoffMs: 0,
      isEnabled: () => true,
      isAvailable: () => true,
      getCurrentSingle: async () => null,
      getHistoricalSingle: single,
      getMetrics: () => ({ success: 0, miss: 0, ratelimit: 0, error: 0, skip: 0 }),
    };
  }

  it('persists a miss row when every provider fails', async () => {
    const upsertManyHistorical = vi.fn(async () => {});
    const registry = {
      currentProviders: () => [],
      historicalProviders: () => [makeProvider('p1', async () => null)],
      getMetricsSnapshot: () => ({}),
    };
    const service = new PricingService(
      { priceFallbackEnabled: false, coingeckoApiKey: undefined, pricingMissTtlMs: SIX_HOURS_MS } as never,
      {
        findHistoricalNear: async () => null,
        findHistoricalNearMany: async () => new Map(),
        upsertHistorical: async () => {},
        upsertManyHistorical,
      } as never,
      registry as never,
    );

    const token = '0x0000000000000000000000000000000000000099';
    const prices = await service.historicalTokenPricesUsdMany([
      { chainId: 1, address: token, timestamp: 1_700_000_001 },
    ]);

    expect(prices.get(historicalTokenPriceRequestKey(1, token, 1_700_000_001))).toBe(0);
    expect(upsertManyHistorical).toHaveBeenCalledTimes(1);
    const records = upsertManyHistorical.mock.calls[0]?.[0] as Array<{ source: string; priceUsd: number }>;
    expect(records).toHaveLength(1);
    expect(records[0]?.source).toBe('miss');
    expect(records[0]?.priceUsd).toBe(0);
  });

  it('honors a recent miss row without calling providers', async () => {
    const singleCall = vi.fn(async () => ({ priceUsd: 42 }));
    const registry = {
      currentProviders: () => [],
      historicalProviders: () => [makeProvider('p1', singleCall)],
      getMetricsSnapshot: () => ({}),
    };
    const findHistoricalNearMany = vi.fn(async (lookups) => new Map(
      lookups.map((lookup) => [
        historicalLookupKey(lookup),
        {
          chainId: lookup.chainId,
          address: lookup.address,
          bucketTs: lookup.bucketTs,
          priceUsd: 0,
          source: 'miss',
          fetchedAt: new Date(Date.now() - 60_000),
        },
      ]),
    ));
    const service = new PricingService(
      { priceFallbackEnabled: false, coingeckoApiKey: undefined, pricingMissTtlMs: SIX_HOURS_MS } as never,
      {
        findHistoricalNear: async () => null,
        findHistoricalNearMany,
        upsertHistorical: async () => {},
        upsertManyHistorical: async () => {},
      } as never,
      registry as never,
    );

    const token = '0x0000000000000000000000000000000000000abc';
    const prices = await service.historicalTokenPricesUsdMany([
      { chainId: 1, address: token, timestamp: 1_700_000_001 },
    ]);

    expect(prices.get(historicalTokenPriceRequestKey(1, token, 1_700_000_001))).toBe(0);
    expect(singleCall).not.toHaveBeenCalled();
  });

  it('re-tries providers when miss row is older than TTL', async () => {
    const singleCall = vi.fn(async () => ({ priceUsd: 7 }));
    const registry = {
      currentProviders: () => [],
      historicalProviders: () => [makeProvider('p1', singleCall)],
      getMetricsSnapshot: () => ({}),
    };
    const findHistoricalNearMany = vi.fn(async (lookups) => new Map(
      lookups.map((lookup) => [
        historicalLookupKey(lookup),
        {
          chainId: lookup.chainId,
          address: lookup.address,
          bucketTs: lookup.bucketTs,
          priceUsd: 0,
          source: 'miss',
          fetchedAt: new Date(Date.now() - (SIX_HOURS_MS + 60_000)),
        },
      ]),
    ));
    const service = new PricingService(
      { priceFallbackEnabled: false, coingeckoApiKey: undefined, pricingMissTtlMs: SIX_HOURS_MS } as never,
      {
        findHistoricalNear: async () => null,
        findHistoricalNearMany,
        upsertHistorical: async () => {},
        upsertManyHistorical: async () => {},
      } as never,
      registry as never,
    );

    const token = '0x0000000000000000000000000000000000000def';
    const prices = await service.historicalTokenPricesUsdMany([
      { chainId: 1, address: token, timestamp: 1_700_000_001 },
    ]);

    expect(prices.get(historicalTokenPriceRequestKey(1, token, 1_700_000_001))).toBe(7);
    expect(singleCall).toHaveBeenCalledTimes(1);
  });
});

describe('PoolRatioProvider', () => {
  const config = {
    pricingPoolRatioProviderEnabled: true,
    pricingPoolRatioBatchSize: 50,
    pricingPoolRatioConcurrency: 4,
    pricingPoolRatioMaxLagSeconds: 86_400,
  } as never;

  function makeProvider(snapshots: Array<Record<string, unknown>>) {
    return new (class {
      // dynamic import in test body — see top of `it` blocks
    })();
  }
  void makeProvider;

  const sqrtAt1 = '79228162514264337593543950336'; // 2^96 → ratio 1.0 for matching decimals

  it('derives unpriced token0 from anchor + pool snapshot ratio', async () => {
    const { PoolRatioProvider } = await import('../src/pricing/providers/pool-ratio.provider.js');
    const provider = new PoolRatioProvider(config);
    const fetchSnapshots = vi.fn(async () => [
      { poolId: '0xpool', timestamp: 1_700_000_000, sqrtPriceX96: sqrtAt1, tick: 0, token0PriceUsd: 0, token1PriceUsd: 0 },
    ]);
    provider.setSnapshotFetcher({ fetchSnapshots });

    const anchorPrices = new Map<string, number>([
      ['1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48:1699999200', 5],
    ]);

    const result = await provider.getHistoricalBatchWithContext(
      [
        {
          chainId: 1,
          address: '0xtoken',
          timestamp: 1_700_000_000,
          poolHint: '0xpool',
          // USDC — known stablecoin, qualifies as anchor under new policy.
          anchorAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          protocol: 'uniswap-v4',
          tokenDecimals: 18,
          anchorDecimals: 18,
          isToken0: true,
        },
      ],
      { anchorPrices },
    );

    // token0_usd = ratio * anchor_usd = 1.0 * 5 = 5
    const quote = result.get('1:0xtoken:1700000000');
    expect(quote?.priceUsd).toBe(5);
    expect(quote?.confidenceLevel).toBe('pool-derived-strong');
    expect(fetchSnapshots).toHaveBeenCalledTimes(1);
  });

  it('caches a pool’s snapshots across calls — same range fetched only once', async () => {
    const { PoolRatioProvider } = await import('../src/pricing/providers/pool-ratio.provider.js');
    const provider = new PoolRatioProvider(config);
    const fetchSnapshots = vi.fn(async () => [
      { poolId: '0xpool', timestamp: 1_700_000_000, sqrtPriceX96: sqrtAt1, tick: 0, token0PriceUsd: 0, token1PriceUsd: 0 },
    ]);
    provider.setSnapshotFetcher({ fetchSnapshots });
    const anchorPrices = new Map<string, number>([
      ['1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48:1699999200', 5],
    ]);
    const req = {
      chainId: 1,
      address: '0xtoken',
      timestamp: 1_700_000_000,
      poolHint: '0xpool',
      anchorAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      protocol: 'uniswap-v4',
      tokenDecimals: 18,
      anchorDecimals: 18,
      isToken0: true,
    };

    const r1 = await provider.getHistoricalBatchWithContext([req], { anchorPrices });
    const r2 = await provider.getHistoricalBatchWithContext([req], { anchorPrices });

    // Identical price both times; the second call is served from the snapshot
    // cache → the subgraph is hit only once.
    expect(r1.get('1:0xtoken:1700000000')?.priceUsd).toBe(5);
    expect(r2.get('1:0xtoken:1700000000')?.priceUsd).toBe(5);
    expect(fetchSnapshots).toHaveBeenCalledTimes(1);
  });

  it('derives unpriced token1 from anchor + pool snapshot ratio', async () => {
    const { PoolRatioProvider } = await import('../src/pricing/providers/pool-ratio.provider.js');
    const provider = new PoolRatioProvider(config);
    provider.setSnapshotFetcher({
      fetchSnapshots: async () => [
        { poolId: '0xpool', timestamp: 1_700_000_000, sqrtPriceX96: sqrtAt1, tick: 0, token0PriceUsd: 0, token1PriceUsd: 0 },
      ],
    });
    const anchorPrices = new Map<string, number>([['1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48:1699999200', 7]]);

    const result = await provider.getHistoricalBatchWithContext(
      [
        {
          chainId: 1,
          address: '0xtoken',
          timestamp: 1_700_000_000,
          poolHint: '0xpool',
          anchorAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          protocol: 'uniswap-v4',
          tokenDecimals: 18,
          anchorDecimals: 18,
          isToken0: false,
        },
      ],
      { anchorPrices },
    );

    // token1_usd = anchor_usd / ratio = 7 / 1.0 = 7
    expect(result.get('1:0xtoken:1700000000')?.priceUsd).toBe(7);
  });

  it('prefers anchor ratio math over subgraph-supplied snapshot USD when present', async () => {
    const { PoolRatioProvider } = await import('../src/pricing/providers/pool-ratio.provider.js');
    const provider = new PoolRatioProvider(config);
    provider.setSnapshotFetcher({
      fetchSnapshots: async () => [
        { poolId: '0xpool', timestamp: 1_700_000_000, sqrtPriceX96: sqrtAt1, tick: 0, token0PriceUsd: 99, token1PriceUsd: 0 },
      ],
    });
    const anchorPrices = new Map<string, number>([['1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48:1699999200', 5]]);

    const result = await provider.getHistoricalBatchWithContext(
      [
        {
          chainId: 1,
          address: '0xtoken',
          timestamp: 1_700_000_000,
          poolHint: '0xpool',
          anchorAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          protocol: 'uniswap-v4',
          tokenDecimals: 18,
          anchorDecimals: 18,
          isToken0: true,
        },
      ],
      { anchorPrices },
    );

    // anchor=5, ratio=1 → t0 = ratio*anchor = 5 (NOT 99). Subgraph USD is now
    // last-resort, only used when sqrtPriceX96 is unusable.
    expect(result.get('1:0xtoken:1700000000')?.priceUsd).toBe(5);
  });

  it('returns empty when poolHint is absent', async () => {
    const { PoolRatioProvider } = await import('../src/pricing/providers/pool-ratio.provider.js');
    const provider = new PoolRatioProvider(config);
    const fetchSnapshots = vi.fn(async () => []);
    provider.setSnapshotFetcher({ fetchSnapshots });

    const result = await provider.getHistoricalBatchWithContext(
      [
        {
          chainId: 1,
          address: '0xtoken',
          timestamp: 1_700_000_000,
          anchorAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          protocol: 'uniswap-v4',
          tokenDecimals: 18,
          anchorDecimals: 18,
          isToken0: true,
        },
      ],
      { anchorPrices: new Map() },
    );

    expect(result.size).toBe(0);
    expect(fetchSnapshots).not.toHaveBeenCalled();
  });

  it('skips a request whose anchor has no price in the context map', async () => {
    const { PoolRatioProvider } = await import('../src/pricing/providers/pool-ratio.provider.js');
    const provider = new PoolRatioProvider(config);
    provider.setSnapshotFetcher({
      fetchSnapshots: async () => [
        { poolId: '0xpool', timestamp: 1_700_000_000, sqrtPriceX96: sqrtAt1, tick: 0, token0PriceUsd: 0, token1PriceUsd: 0 },
      ],
    });

    const result = await provider.getHistoricalBatchWithContext(
      [
        {
          chainId: 1,
          address: '0xtoken',
          timestamp: 1_700_000_000,
          poolHint: '0xpool',
          anchorAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          protocol: 'uniswap-v4',
          tokenDecimals: 18,
          anchorDecimals: 18,
          isToken0: true,
        },
      ],
      { anchorPrices: new Map() },
    );

    expect(result.size).toBe(0);
  });

  it('skips when nearest snapshot is older than the configured max lag', async () => {
    const { PoolRatioProvider } = await import('../src/pricing/providers/pool-ratio.provider.js');
    const provider = new PoolRatioProvider({ ...config, pricingPoolRatioMaxLagSeconds: 60 } as never);
    provider.setSnapshotFetcher({
      fetchSnapshots: async () => [
        { poolId: '0xpool', timestamp: 1_700_000_000, sqrtPriceX96: sqrtAt1, tick: 0, token0PriceUsd: 0, token1PriceUsd: 0 },
      ],
    });
    const anchorPrices = new Map<string, number>([['1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48:1700003600', 5]]);

    const result = await provider.getHistoricalBatchWithContext(
      [
        {
          chainId: 1,
          address: '0xtoken',
          timestamp: 1_700_003_600, // 1h after the only snapshot
          poolHint: '0xpool',
          anchorAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          protocol: 'uniswap-v4',
          tokenDecimals: 18,
          anchorDecimals: 18,
          isToken0: true,
        },
      ],
      { anchorPrices },
    );

    expect(result.size).toBe(0);
  });

  it('returns empty when the provider is disabled', async () => {
    const { PoolRatioProvider } = await import('../src/pricing/providers/pool-ratio.provider.js');
    const provider = new PoolRatioProvider({ ...config, pricingPoolRatioProviderEnabled: false } as never);
    const fetchSnapshots = vi.fn(async () => []);
    provider.setSnapshotFetcher({ fetchSnapshots });

    const result = await provider.getHistoricalBatchWithContext(
      [
        {
          chainId: 1,
          address: '0xtoken',
          timestamp: 1_700_000_000,
          poolHint: '0xpool',
          anchorAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          protocol: 'uniswap-v4',
          tokenDecimals: 18,
          anchorDecimals: 18,
          isToken0: true,
        },
      ],
      { anchorPrices: new Map([['1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48:1699999200', 5]]) },
    );

    expect(result.size).toBe(0);
    expect(fetchSnapshots).not.toHaveBeenCalled();
  });

  it('skips a request whose counterparty is not a configured anchor', async () => {
    const { PoolRatioProvider } = await import('../src/pricing/providers/pool-ratio.provider.js');
    const provider = new PoolRatioProvider(config);
    const fetchSnapshots = vi.fn(async () => [
      { poolId: '0xpool', timestamp: 1_700_000_000, sqrtPriceX96: sqrtAt1, tick: 0, token0PriceUsd: 0, token1PriceUsd: 0 },
    ]);
    provider.setSnapshotFetcher({ fetchSnapshots });
    const longTail = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const anchorPrices = new Map<string, number>([[`1:${longTail}:1699999200`, 5]]);

    const result = await provider.getHistoricalBatchWithContext(
      [
        {
          chainId: 1,
          address: '0xtoken',
          timestamp: 1_700_000_000,
          poolHint: '0xpool',
          anchorAddress: longTail, // long-tail / long-tail pool — no trusted anchor
          protocol: 'uniswap-v4',
          tokenDecimals: 18,
          anchorDecimals: 18,
          isToken0: true,
        },
      ],
      { anchorPrices },
    );

    expect(result.size).toBe(0);
    expect(fetchSnapshots).not.toHaveBeenCalled();
  });

  it('skips a request for an unsupported protocol', async () => {
    const { PoolRatioProvider } = await import('../src/pricing/providers/pool-ratio.provider.js');
    const provider = new PoolRatioProvider(config);
    const fetchSnapshots = vi.fn(async () => []);
    provider.setSnapshotFetcher({ fetchSnapshots });
    const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

    const result = await provider.getHistoricalBatchWithContext(
      [
        {
          chainId: 1,
          address: '0xtoken',
          timestamp: 1_700_000_000,
          poolHint: '0xpool',
          anchorAddress: usdc,
          protocol: 'unsupported-protocol',
          tokenDecimals: 18,
          anchorDecimals: 18,
          isToken0: true,
        },
      ],
      { anchorPrices: new Map([[`1:${usdc}:1699999200`, 5]]) },
    );

    expect(result.size).toBe(0);
    expect(fetchSnapshots).not.toHaveBeenCalled();
  });

  it('returns empty when no snapshot fetcher has been registered yet', async () => {
    const { PoolRatioProvider } = await import('../src/pricing/providers/pool-ratio.provider.js');
    const provider = new PoolRatioProvider(config);
    // intentionally no setSnapshotFetcher

    const result = await provider.getHistoricalBatchWithContext(
      [
        {
          chainId: 1,
          address: '0xtoken',
          timestamp: 1_700_000_000,
          poolHint: '0xpool',
          anchorAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
          protocol: 'uniswap-v4',
          tokenDecimals: 18,
          anchorDecimals: 18,
          isToken0: true,
        },
      ],
      { anchorPrices: new Map([['1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48:1699999200', 5]]) },
    );

    expect(result.size).toBe(0);
  });
});

describe('PricingService orchestrator invokes pool-ratio last', () => {
  it('passes the partial anchor map to a context-aware provider after external providers run', async () => {
    const upsertManyHistorical = vi.fn(async () => {});
    const findHistoricalNearMany = vi.fn(async () => new Map());

    // External provider always misses for the unpriced token but returns
    // a price for the anchor. Records its invocation timestamp so we can
    // assert pool-ratio runs after it.
    const callOrder: string[] = [];
    const externalProvider = {
      name: 'external',
      supportsCurrentBatch: false,
      supportsHistoricalBatch: false,
      maxBatchSize: 1,
      singleConcurrency: 1,
      defaultBackoffMs: 0,
      isEnabled: () => true,
      isAvailable: () => true,
      getCurrentSingle: async () => null,
      getHistoricalSingle: vi.fn(async (req) => {
        callOrder.push(`external:${req.address}`);
        if (req.address === '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48') return { priceUsd: 9 };
        return null;
      }),
      getMetrics: () => ({ success: 0, miss: 0, ratelimit: 0, error: 0, skip: 0 }),
    };

    // Pool-ratio provider: records the anchor map it saw.
    let observedAnchor: number | undefined;
    const poolRatioProvider = {
      name: 'subgraph-pool-ratio',
      supportsCurrentBatch: false,
      supportsHistoricalBatch: true,
      maxBatchSize: 50,
      singleConcurrency: 1,
      defaultBackoffMs: 0,
      isEnabled: () => true,
      isAvailable: () => true,
      getCurrentSingle: async () => null,
      getHistoricalSingle: async () => null,
      getHistoricalBatch: async () => new Map(),
      getHistoricalBatchWithContext: vi.fn(async (reqs, context) => {
        callOrder.push('pool-ratio');
        observedAnchor = context.anchorPrices.get(`1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48:${reqs[0].timestamp}`);
        const m = new Map<string, { priceUsd: number }>();
        for (const req of reqs) {
          if (req.address === '0xtoken' && observedAnchor && observedAnchor > 0) {
            m.set(`${req.chainId}:${req.address}:${req.timestamp}`, { priceUsd: observedAnchor * 2 });
          }
        }
        return m;
      }),
      getMetrics: () => ({ success: 0, miss: 0, ratelimit: 0, error: 0, skip: 0 }),
    };

    const registry = {
      currentProviders: () => [],
      historicalProviders: () => [externalProvider, poolRatioProvider],
      getMetricsSnapshot: () => ({}),
    };
    const service = new PricingService(
      { priceFallbackEnabled: false, coingeckoApiKey: undefined, pricingMissTtlMs: SIX_HOURS_MS } as never,
      {
        findHistoricalNear: async () => null,
        findHistoricalNearMany,
        upsertHistorical: async () => {},
        upsertManyHistorical,
      } as never,
      registry as never,
    );

    const prices = await service.historicalTokenPricesUsdMany([
      { chainId: 1, address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', timestamp: 1_700_000_001 },
      { chainId: 1, address: '0xtoken', timestamp: 1_700_000_001 },
    ]);

    expect(prices.get(historicalTokenPriceRequestKey(1, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 1_700_000_001))).toBe(9);
    // Derived from anchor: pool-ratio multiplied anchor (9) by 2 → 18.
    expect(prices.get(historicalTokenPriceRequestKey(1, '0xtoken', 1_700_000_001))).toBe(18);
    expect(observedAnchor).toBe(9);
    // pool-ratio must run AFTER the external provider so its anchor map is hot.
    expect(callOrder.indexOf('pool-ratio')).toBeGreaterThan(callOrder.indexOf('external:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'));
    // Cache row written under the provider's name so re-runs short-circuit.
    // Mock provider doesn't tag `quote.source`, so the orchestrator falls back
    // to `provider.name` — that's still the canonical short name.
    const records = upsertManyHistorical.mock.calls[0]?.[0] as Array<{ address: string; source: string }>;
    const derivedRow = records.find((r) => r.address === '0xtoken');
    expect(derivedRow?.source).toBe('subgraph-pool-ratio');
  });
});

describe('PricingService pool-ratio derivation', () => {
  function service() {
    const tokenPrices = {
      findHistoricalNear: async () => null,
      findHistoricalNearMany: async () => new Map(),
      upsertHistorical: async () => {},
      upsertManyHistorical: async () => {},
    } as never;
    return new PricingService(
      { priceFallbackEnabled: false, coingeckoApiKey: undefined, pricingMissTtlMs: SIX_HOURS_MS } as never,
      tokenPrices,
    );
  }

  it('returns zeros when fallback disabled and neither side has a provider price', async () => {
    // With `priceFallbackEnabled: false`, no external lookups run. Stablecoins
    // are no longer auto-anchored at $1, so pricePool returns zeros and the
    // derivation branch can't bootstrap (no anchor → no ratio derivation).
    const result = await service().pricePool({
      chainId: 1,
      token0: {
        address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        decimals: 18,
      },
      token1: {
        address: '0x0000000000000000000000000000000000000001',
        decimals: 18,
      },
      tick: 0,
      poolTvlUsd: 500,
      poolTvlUsdUntracked: 500,
      poolVolumeUsd: 0,
      poolTotalFeesUsd: 0,
    });

    expect(result).toMatchObject({
      token0Usd: 0,
      token1Usd: 0,
      source: 'none',
      usedFallback: false,
    });
    expect(result.token0Confidence).toBe('missing');
    expect(result.token1Confidence).toBe('missing');
  });

  it('returns zeros for near-empty pools regardless of stablecoin pair', async () => {
    const result = await service().pricePool({
      chainId: 1,
      token0: {
        address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
        decimals: 18,
      },
      token1: {
        address: '0x0000000000000000000000000000000000000001',
        decimals: 18,
      },
      tick: 0,
      poolTvlUsd: 0,
      poolTvlUsdUntracked: 0,
      poolVolumeUsd: 0,
      poolTotalFeesUsd: 0,
    });

    expect(result).toMatchObject({
      token0Usd: 0,
      token1Usd: 0,
      source: 'none',
      usedFallback: false,
    });
  });
});
