import { describe, expect, it, vi } from 'vitest';
import { PricingService } from '../src/pricing/pricing.service.js';
import { isDexBacked, DEX_MARKET_SOURCES } from '../src/pricing/quote-consensus.js';
import { PositionsRepository, type LeaderboardQuery } from '../src/database/positions.repository.js';
import type { TokenPriceRecord } from '../src/database/token.repository.js';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'; // config stable anchor
const EUR = '0xa3ec40cc9736ad0064630bfd60f2876d7762e3b2'; // scam "EUR" — fiat-matched, NO DEX pair
const RPC = '0xed025a9fe4b30bcd68460bca42583090c2266468'; // real DexScreener market

// ─── isDexBacked classification ───────────────────────────────────────────────
describe('isDexBacked (DEX-market source classification)', () => {
  it('treats dexscreener / geckoterminal as DEX-backed', () => {
    expect(isDexBacked(['dexscreener'])).toBe(true);
    expect(isDexBacked(['geckoterminal'])).toBe(true);
    expect(isDexBacked(['defillama', 'dexscreener'])).toBe(true);
  });
  it('treats non-DEX aggregators alone as NOT DEX-backed', () => {
    expect(isDexBacked(['defillama', 'coingecko'])).toBe(false);
    expect(isDexBacked(['alchemy'])).toBe(false);
    expect(isDexBacked([])).toBe(false);
    expect(isDexBacked(undefined)).toBe(false);
  });
  it('pins the DEX source set', () => {
    expect([...DEX_MARKET_SOURCES].sort()).toEqual(['dexscreener', 'geckoterminal']);
  });
});

// ─── DEX-market value gate (via pricePool) ────────────────────────────────────
/**
 * Build a PricingService with the DEX-market gate ON and a `{chainId}_tokens`
 * mock whose `findDexMarketState` returns the given verdicts. `prefetchPrices`
 * warms the in-memory dex-market cache (it calls `findDexMarketState`); pricePool
 * then reads it.
 */
function dexGatedService(opts: {
  quotes: Record<string, number>;
  listed?: string[];
  dexState: Record<string, boolean>; // address → DEX-backed (present = KNOWN)
  failClosed?: boolean;
}): PricingService {
  const quotes = new Map(Object.entries(opts.quotes).map(([a, p]) => [a.toLowerCase(), p]));
  const dexState = new Map(Object.entries(opts.dexState).map(([a, b]) => [a.toLowerCase(), b]));
  const listedSet = new Set((opts.listed ?? []).map((a) => a.toLowerCase()));
  const provider = {
    name: 'mock-current',
    supportsCurrentBatch: true,
    supportsHistoricalBatch: false,
    maxBatchSize: 50,
    singleConcurrency: 1,
    defaultBackoffMs: 0,
    isEnabled: () => true,
    isAvailable: () => true,
    getCurrentSingle: vi.fn(async (_c: number, address: string) => {
      const priceUsd = quotes.get(address.toLowerCase()) ?? 0;
      return priceUsd > 0 ? { priceUsd } : null;
    }),
    // Batch support so prefetchPrices caches the quotes positively (and warms
    // the dex-market cache) instead of negative-caching the page.
    getCurrentBatch: vi.fn(async (chainId: number, addrs: string[]) => {
      const out = new Map<string, { priceUsd: number }>();
      for (const a of addrs) {
        const p = quotes.get(a.toLowerCase()) ?? 0;
        if (p > 0) out.set(`${chainId}:${a.toLowerCase()}`, { priceUsd: p });
      }
      return out;
    }),
    getHistoricalSingle: vi.fn(async () => null),
    getMetrics: () => ({ success: 0, miss: 0, ratelimit: 0, error: 0, skip: 0 }),
  };
  return new PricingService(
    {
      priceFallbackEnabled: true,
      pricingMissTtlMs: SIX_HOURS_MS,
      tokenListingGateEnabled: true,
      dexMarketGateEnabled: true,
      dexMarketFailClosed: opts.failClosed ?? false,
      pricingPrefetchChunkConcurrency: 4,
    } as never,
    {
      findHistoricalNear: async () => null,
      findHistoricalNearMany: async () => new Map(),
      upsertHistorical: async () => {},
      upsertManyHistorical: async () => {},
    } as never,
    {
      currentProviders: () => [provider],
      historicalProviders: () => [provider],
      getMetricsSnapshot: () => ({}),
    } as never,
    { isListed: (_c: number, addr: string) => listedSet.has(addr.toLowerCase()) } as never,
    {
      findLatestPrices: async () => new Map(),
      upsertPrices: async () => {},
      // The gate reads this: present in the map = KNOWN verdict; absent = unknown.
      findDexMarketState: async (_c: number, addrs: string[]) =>
        new Map(addrs.map((a) => a.toLowerCase()).filter((a) => dexState.has(a)).map((a) => [a, dexState.get(a)!])),
    } as never,
  );
}

describe('DEX-market value gate (pricePool)', () => {
  const poolInput = (token1Addr: string, sym: string) => ({
    chainId: 1,
    protocol: 'uniswap-v4',
    token0: { address: USDC, symbol: 'USDC', decimals: 18, verified: true },
    token1: { address: token1Addr, symbol: sym, decimals: 18, verified: false },
    tick: 0,
    poolTvlUsd: 300_000,
    poolTvlUsdUntracked: 300_000,
  });

  it('ZEROES a non-listed leg with NO DEX market (symbol/FX-matched scam: EUR)', async () => {
    const service = dexGatedService({
      quotes: { [USDC]: 1, [EUR]: 1.15 }, // a non-DEX aggregator returns the fiat rate
      listed: [USDC],
      dexState: { [EUR]: false }, // consensus sweep: priced only by non-DEX sources
    });
    await service.prefetchPrices(1, [USDC, EUR]); // warm the dex-market cache
    const prices = await service.pricePool(poolInput(EUR, 'EUR'));
    expect(prices.token1Usd).toBe(0); // gated — no real market
    expect(prices.token1Confidence).toBe('missing');
  });

  // Pool kept 1:1-consistent (tick 0, equal decimals) so the DEX-gate is the
  // only thing under test — pool-consistency is exercised elsewhere.
  it('KEEPS a non-listed leg with a real DEX market (RPC-class)', async () => {
    const service = dexGatedService({
      quotes: { [USDC]: 1, [RPC]: 1 },
      listed: [USDC],
      dexState: { [RPC]: true }, // consensus sweep saw a DexScreener/GeckoTerminal source
    });
    await service.prefetchPrices(1, [USDC, RPC]);
    const prices = await service.pricePool(poolInput(RPC, 'RPC'));
    expect(prices.token1Usd).toBe(1); // real DEX market → valued
    expect(prices.token1Confidence).toBe('external-unverified');
  });

  it('FAILS OPEN for an unswept token (unknown DEX state) when DEX_MARKET_FAIL_CLOSED is off', async () => {
    const service = dexGatedService({
      quotes: { [USDC]: 1, [RPC]: 1 },
      listed: [USDC],
      dexState: {}, // no consensus record yet → unknown
      failClosed: false,
    });
    await service.prefetchPrices(1, [USDC, RPC]);
    const prices = await service.pricePool(poolInput(RPC, 'RPC'));
    expect(prices.token1Usd).toBe(1); // not gated when unknown + fail-open
  });

  it('FAILS CLOSED for an unswept token (unknown DEX state) when DEX_MARKET_FAIL_CLOSED is on', async () => {
    const service = dexGatedService({
      quotes: { [USDC]: 1, [RPC]: 1 },
      listed: [USDC],
      dexState: {}, // no consensus record yet → unknown
      failClosed: true,
    });
    await service.prefetchPrices(1, [USDC, RPC]);
    const prices = await service.pricePool(poolInput(RPC, 'RPC'));
    expect(prices.token1Usd).toBe(0); // unknown + fail-closed → $0 until a sweep confirms
    expect(prices.token1Confidence).toBe('missing');
  });

  it('still KEEPS an anchor/listed leg under fail-closed (never gated)', async () => {
    const service = dexGatedService({
      quotes: { [USDC]: 1, [RPC]: 1 },
      listed: [USDC, RPC], // RPC listed → exempt from the DEX gate entirely
      dexState: {},
      failClosed: true,
    });
    await service.prefetchPrices(1, [USDC, RPC]);
    const prices = await service.pricePool(poolInput(RPC, 'RPC'));
    expect(prices.token1Usd).toBe(1); // listed → not gated even with fail-closed + unknown
  });
});

// ─── Active-market verdict in the consensus sweep (volume floor) ───────────────
/**
 * Build a PricingService whose DexScreener-named provider returns priceUsd +
 * volume24hUsd, and capture the records the sweep persists, to assert the
 * `dexActive` verdict (DEX source + 24h volume ≥ floor).
 */
// `counter`/`counterToken` are the DexScreener counter-side signals (USDC quote
// here → 1:1 USD via the stable anchor). Omit `counter` to model a DEX source
// that supplies no counter (GeckoTerminal-only) → volume-only fallback.
function sweepService(
  quotes: Record<string, { price: number; vol: number; counter?: number; counterToken?: string }>,
  opts: { minVolume: number; minCounter?: number },
) {
  const norm = new Map(Object.entries(quotes).map(([a, v]) => [a.toLowerCase(), v]));
  const captured: TokenPriceRecord[] = [];
  const provider = {
    name: 'dexscreener', // a DEX market source
    supportsCurrentBatch: true,
    supportsHistoricalBatch: false,
    maxBatchSize: 50,
    singleConcurrency: 1,
    defaultBackoffMs: 0,
    isEnabled: () => true,
    isAvailable: () => true,
    getCurrentSingle: vi.fn(async () => null),
    getCurrentBatch: vi.fn(async (chainId: number, addrs: string[]) => {
      const out = new Map<string, { priceUsd: number; volume24hUsd: number; counterLiquidity?: number; counterTokenAddress?: string }>();
      for (const a of addrs) {
        const v = norm.get(a.toLowerCase());
        if (v && v.price > 0) {
          out.set(`${chainId}:${a.toLowerCase()}`, {
            priceUsd: v.price,
            volume24hUsd: v.vol,
            counterLiquidity: v.counter,
            counterTokenAddress: v.counterToken,
          });
        }
      }
      return out;
    }),
    getHistoricalSingle: vi.fn(async () => null),
    getMetrics: () => ({ success: 0, miss: 0, ratelimit: 0, error: 0, skip: 0 }),
  };
  const svc = new PricingService(
    { priceFallbackEnabled: true, pricingMissTtlMs: SIX_HOURS_MS, dexMarketMinVolumeUsd: opts.minVolume, dexMarketMinCounterLiquidityUsd: opts.minCounter ?? 0 } as never,
    {
      findHistoricalNear: async () => null,
      findHistoricalNearMany: async () => new Map(),
      upsertHistorical: async () => {},
      upsertManyHistorical: async () => {},
    } as never,
    {
      currentProviders: () => [provider],
      historicalProviders: () => [provider],
      getMetricsSnapshot: () => ({}),
    } as never,
    { isListed: () => false } as never,
    { upsertPrices: async (_c: number, recs: TokenPriceRecord[]) => { captured.push(...recs); }, findLatestPrices: async () => new Map() } as never,
  );
  return { svc, captured };
}

describe('consensus sweep — active-market verdict (dexActive)', () => {
  it('marks a traded DEX market ACTIVE (RPC: vol ≫ floor, counter ≫ floor)', async () => {
    const { svc, captured } = sweepService(
      { [RPC]: { price: 0.0105, vol: 1296, counter: 10980, counterToken: USDC } },
      { minVolume: 50, minCounter: 1000 },
    );
    await svc.prefetchConsensus(1, [RPC]);
    const rec = captured.find((r) => r.address === RPC);
    expect(rec?.dexActive).toBe(true);
    expect(rec?.dexVolume24h).toBe(1296);
    expect(rec?.dexCounterLiquidity).toBeCloseTo(10980, 0); // USDC counter → USD 1:1
  });

  it('marks a DEAD seeded pool INACTIVE (BT77-class: vol < floor)', async () => {
    const BT77 = '0x49dd1f5b37af4c2e8bca50df4b92e6b5b43d1607';
    const { svc, captured } = sweepService({ [BT77]: { price: 34.3, vol: 8, counter: 0.009, counterToken: USDC } }, { minVolume: 50, minCounter: 1000 });
    await svc.prefetchConsensus(1, [BT77]);
    const rec = captured.find((r) => r.address === BT77);
    expect(rec?.dexActive).toBe(false); // has a DEX pair but no real trading
    expect(rec?.dexVolume24h).toBe(8);
  });

  it('marks a WASH-traded seeded pool INACTIVE (GPCG: vol ≥ floor but counter ≪ floor)', async () => {
    const GPCG = '0xef66b719251750a245a81e4278f11942ec1852c6';
    const { svc, captured } = sweepService(
      { [GPCG]: { price: 1.02, vol: 61, counter: 9.52, counterToken: USDC } }, // $61 wash volume clears $50; $9.52 counter does NOT
      { minVolume: 50, minCounter: 1000 },
    );
    await svc.prefetchConsensus(1, [GPCG]);
    const rec = captured.find((r) => r.address === GPCG);
    expect(rec?.dexActive).toBe(false); // counter-side liquidity floor catches the wash
    expect(rec?.dexCounterLiquidity).toBeCloseTo(9.52, 2);
  });

  it('stays ACTIVE when the DEX source supplies NO counter signal (GeckoTerminal-only)', async () => {
    const { svc, captured } = sweepService(
      { [RPC]: { price: 0.0105, vol: 3000 } }, // counter undefined → volume-only fallback
      { minVolume: 50, minCounter: 1000 },
    );
    await svc.prefetchConsensus(1, [RPC]);
    const rec = captured.find((r) => r.address === RPC);
    expect(rec?.dexActive).toBe(true); // unknown counter is NOT treated as 0
    expect(rec?.dexCounterLiquidity).toBeUndefined();
  });
});

// ─── Read-time leaderboard exclusion of no-real-market tokens ─────────────────
function leaderboardRepo(noMarket: string[]) {
  let captured: Record<string, unknown> = {};
  const chain: Record<string, unknown> = {};
  for (const m of ['select', 'sort', 'collation', 'hint', 'skip', 'limit', 'read', 'maxTimeMS']) chain[m] = () => chain;
  chain.lean = async () => [];
  const model = {
    find: (filter: Record<string, unknown>) => { captured = filter; return chain; },
  };
  // TokensRepository serves spam + no-market as ONE merged exclusion set.
  const repo = new PositionsRepository(
    { positionModel: () => model } as never,
    { readyLeaderboardExclusions: async () => ({ addresses: noMarket, ok: true }) } as never,
  );
  return { repo, getFilter: () => captured };
}
function lbQuery(over: Partial<LeaderboardQuery> = {}): LeaderboardQuery {
  return {
    chainId: 1, protocol: 'uniswap-v4', sort: 'underlying_value', page: 1, limit: 25,
    activeOnly: true, status: 'active', range: 'all', minValueUsd: 0, minPoolTvl: 0,
    includeRisky: true, ...over,
  };
}

describe('leaderboard read-time no-market exclusion', () => {
  const BAD = '0xa3ec40cc9736ad0064630bfd60f2876d7762e3b2';

  it('adds a $nin on both legs — EVEN in the risky view', async () => {
    const { repo, getFilter } = leaderboardRepo([BAD]);
    await repo.findLeaderboard(lbQuery({ includeRisky: true }));
    const and = (getFilter().$and as Array<Record<string, unknown>>) ?? [];
    expect(and.some((c) => JSON.stringify(c).includes(BAD) && 'token0.address' in c)).toBe(true);
  });

  it('is bypassed for a direct id lookup (row stays findable)', async () => {
    const { repo, getFilter } = leaderboardRepo([BAD]);
    await repo.findLeaderboard(lbQuery({ positionId: '129344' }));
    const and = (getFilter().$and as Array<Record<string, unknown>>) ?? [];
    expect(and.some((c) => JSON.stringify(c).includes(BAD))).toBe(false);
  });

  it('adds no clause when nothing is no-market', async () => {
    const { repo, getFilter } = leaderboardRepo([]);
    await repo.findLeaderboard(lbQuery());
    const and = (getFilter().$and as Array<Record<string, unknown>>) ?? [];
    expect(and.some((c) => 'token0.address' in c)).toBe(false);
  });
});
