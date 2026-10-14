import { describe, expect, it, vi } from 'vitest';
import { PricingService } from '../../src/pricing/pricing.service.js';
import { TokensRepository, type TokenPriceRecord, type TokenTrustRecord } from '../../src/database/token.repository.js';

/**
 * Fix 4 wiring: the consensus sweep computes + stores the earned verdict
 * (shadow: while the mode stays `allowlist`), the position path reads it in
 * `earned` mode, and the leaderboard exclusion uses the same rule.
 */

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const CBBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf'; // allowlisted
const BTCB = '0xb0f70c0bd6fd87dbeb7c10dc692a2a6106817072'; // not allowlisted
const MOW = '0x000000000000000000000000000000000000a0a2';
const POOL = '0x9c25d738109ff9ad10516f5f97ef24b9af51a9aa3db4b3b5728edf18a2d3f11c';

type Q = Record<string, unknown> & { priceUsd: number };
function provider(name: string, quotes: Record<string, Q>) {
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
  };
}

// cbBTC's stored last-known-good: the pool evidence prices a trusted counter
// token from the sweep's own quotes, the cache or this — never a provider walk.
const storedPrices = () => new Map([[CBBTC, { priceUsd: 85_300, pricedAt: new Date() }]]);

function sweepService(providers: ReturnType<typeof provider>[], config: Record<string, unknown>) {
  const prices: TokenPriceRecord[] = [];
  const verdicts: TokenTrustRecord[] = [];
  const tokens = {
    findLatestPrices: vi.fn(async (_c: number, addrs: string[]) => {
      const all = storedPrices();
      return new Map(addrs.filter((a) => all.has(a)).map((a) => [a, all.get(a)!]));
    }),
    upsertPrices: async (_c: number, r: TokenPriceRecord[]) => void prices.push(...r),
    upsertTrustEvidence: async (_c: number, r: TokenTrustRecord[]) => void verdicts.push(...r),
    clearGuardedPrices: async () => {},
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
      ...config,
    } as never,
    {} as never,
    { currentProviders: () => providers, historicalProviders: () => providers } as never,
    { isListed: (_c: number, a: string) => a === CBBTC } as never,
    tokens as never,
  );
  return { svc, prices, verdicts, tokens };
}

// BTC.b on Ethereum today: one v4 pool (8.53M headline, 49.1 cbBTC counter),
// priced by DeFiLlama + DexScreener in agreement.
const btcbQuotes = () => [
  provider('defillama', { [BTCB]: { priceUsd: 85_852, quotedAtMs: Date.now() - 600_000 }, [CBBTC]: { priceUsd: 85_300 } }),
  provider('dexscreener', {
    [BTCB]: {
      priceUsd: 85_300,
      volume24hUsd: 60_866,
      counterLiquidity: 49.1352,
      counterTokenAddress: CBBTC,
      dexPairs: [{ id: POOL, liquidityUsd: 8_530_070, counterLiquidity: 49.1352, counterTokenAddress: CBBTC }],
      dexPairsComplete: true,
    },
    [CBBTC]: { priceUsd: 85_300 },
  }),
];

describe('consensus sweep — earned-trust verdicts', () => {
  it('default config: no verdict is computed or written', async () => {
    const { svc, verdicts } = sweepService(btcbQuotes(), {});
    await svc.prefetchConsensus(1, [BTCB]);
    expect(verdicts).toEqual([]);
  });

  it('TOKEN_TRUST_SHADOW=on: BTC.b earns trust (fresh consensus + active market + one deep balanced pool + non-DEX source)', async () => {
    const { svc, verdicts } = sweepService(btcbQuotes(), { tokenTrustShadow: 'on' });
    const stats = await svc.prefetchConsensus(1, [BTCB]);
    const v = verdicts.find((r) => r.address === BTCB)!;
    expect(v).toMatchObject({ trustEarned: true, trustReason: 'earned', dexPoolCount: 1, dexTopPoolId: POOL });
    expect(v.dexTopCounterUsd).toBeGreaterThan(4_000_000); // 49.1 cbBTC × cbBTC's own (allowlisted) price
    expect(v.trustSources.sort()).toEqual(['defillama', 'dexscreener']);
    expect(stats).toMatchObject({ trustVerdicts: 1, trustEarned: 1 });
  });

  it('MOW-class launch token: DEX-only agreement is ONE on-chain source → single-source (a); its ~$300 counter fails (b) too', async () => {
    const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
    const mow = { priceUsd: 0.1186, volume24hUsd: 50_000, counterLiquidity: 0.11, counterTokenAddress: WETH,
      dexPairs: [{ id: '0xmow', liquidityUsd: 11_860_000, counterLiquidity: 0.11, counterTokenAddress: WETH }] };
    const { svc, verdicts } = sweepService(
      [provider('dexscreener', { [MOW]: mow, [WETH]: { priceUsd: 2700 } }), provider('geckoterminal', { [MOW]: { priceUsd: 0.1186 }, [WETH]: { priceUsd: 2700 } })],
      { tokenTrustShadow: 'on' },
    );
    await svc.prefetchConsensus(1, [MOW]);
    expect(verdicts.find((r) => r.address === MOW)).toMatchObject({ trustEarned: false, trustReason: 'single-source' });
    // With a non-DEX aggregator agreeing, the dead market is what fails it.
    const withAgg = sweepService(
      [
        provider('dexscreener', { [MOW]: mow, [WETH]: { priceUsd: 2700 } }),
        provider('defillama', { [MOW]: { priceUsd: 0.1186 }, [WETH]: { priceUsd: 2700 } }),
      ],
      { tokenTrustShadow: 'on' },
    );
    await withAgg.svc.prefetchConsensus(1, [MOW]);
    expect(withAgg.verdicts.find((r) => r.address === MOW)).toMatchObject({ trustEarned: false, trustReason: 'no-dex-market' });
  });

  it('a stale quote cannot make consensus: (d) → stale-quote', async () => {
    const T = '0x000000000000000000000000000000000000a0a3';
    const { svc, verdicts } = sweepService(
      [
        provider('dia', { [T]: { priceUsd: 2, quotedAtMs: Date.now() - 40 * 86_400_000, volume24hUsd: 1e6 } }),
        provider('dexscreener', { [T]: { priceUsd: 2, volume24hUsd: 9_000, dexPairs: [] } }),
      ],
      { tokenTrustShadow: 'on' },
    );
    await svc.prefetchConsensus(1, [T]);
    expect(verdicts.find((r) => r.address === T)).toMatchObject({ trustEarned: false, trustReason: 'stale-quote' });
  });

  it('a pool quoted against an UNTRUSTED counter token proves nothing (its counter side is not priced)', async () => {
    const SPAM = '0x000000000000000000000000000000000000beef';
    const quotes = btcbQuotes();
    // Every provider prices the spam counter — the rule, not a missing price, must keep it out.
    quotes[0] = provider('defillama', { [BTCB]: { priceUsd: 85_852, quotedAtMs: Date.now() - 600_000 }, [CBBTC]: { priceUsd: 85_300 }, [SPAM]: { priceUsd: 85_300 } });
    // Same deep BTC.b pool, but quoted against a spam token every provider prices at $85k.
    const ds = quotes[1]!.getCurrentBatch;
    quotes[1]!.getCurrentBatch = vi.fn(async (chainId: number, addrs: string[]) => {
      const out = await ds(chainId, addrs);
      const q = out.get(`${chainId}:${BTCB}`);
      if (q) out.set(`${chainId}:${BTCB}`, { ...q, counterTokenAddress: SPAM, dexPairsComplete: true, dexPairs: [{ id: POOL, liquidityUsd: 8_530_070, counterLiquidity: 49.1352, counterTokenAddress: SPAM }] });
      out.set(`${chainId}:${SPAM}`, { priceUsd: 85_300 });
      return out;
    });
    const { svc, verdicts } = sweepService(quotes, { tokenTrustShadow: 'on' });
    // SPAM is swept too, so the sweep itself holds a consensus price for it.
    await svc.prefetchConsensus(1, [BTCB, SPAM]);
    expect(verdicts.find((r) => r.address === BTCB)).toMatchObject({ trustEarned: false, trustReason: 'single-pool', dexTopCounterUsd: 0 });
  });

  it('no verdict for a token no healthy DEX provider covered (keeps the previous one)', async () => {
    const T = '0x000000000000000000000000000000000000a0a4';
    const { svc, verdicts } = sweepService([provider('defillama', { [T]: { priceUsd: 1 } })], { tokenTrustShadow: 'on' });
    await svc.prefetchConsensus(1, [T]);
    expect(verdicts).toEqual([]);
  });
});

describe('position path (pricePool) in earned mode', () => {
  function pricing(config: Record<string, unknown>, trust: Record<string, { trustEarned: boolean }>) {
    const quotes = { [USDC]: { priceUsd: 1 }, [BTCB]: { priceUsd: 85_000 }, [CBBTC]: { priceUsd: 85_000 } };
    const p = provider('mock', quotes);
    const findMarketState = vi.fn(async (_c: number, addrs: string[]) =>
      new Map(addrs.filter((a) => a in trust).map((a) => [a, { trust: { ...trust[a], trustEvaluatedAt: new Date() } }])),
    );
    const svc = new PricingService(
      { priceFallbackEnabled: true, tokenListingGateEnabled: true, dexMarketGateEnabled: true, dexMarketFailClosed: true, pricingPrefetchChunkConcurrency: 2, ...config } as never,
      {} as never,
      { currentProviders: () => [p], historicalProviders: () => [p] } as never,
      { isListed: (_c: number, a: string) => a === CBBTC } as never,
      { findLatestPrices: async () => new Map(), upsertPrices: async () => {}, findDexMarketState: async () => new Map(), findMarketState } as never,
    );
    return { svc, findMarketState };
  }
  const pool = { chainId: 1, token0: { address: BTCB, decimals: 8, verified: false }, token1: { address: CBBTC, decimals: 8, verified: false } };

  it('allowlist mode (default): BTC.b is not listed → DEX gate fails closed → $0 (today)', async () => {
    const { svc, findMarketState } = pricing({}, {});
    await svc.prefetchPrices(1, [BTCB, CBBTC]);
    const r = await svc.pricePool(pool);
    expect(r.token0Usd).toBe(0);
    expect(r.token1Usd).toBe(85_000);
    expect(findMarketState).not.toHaveBeenCalled(); // today's read path
  });

  it('allowlist mode + TOKEN_TRUST_DENY: a denied listed leg loses its listing exemption', async () => {
    const open = pricing({}, {});
    await open.svc.prefetchPrices(1, [BTCB, CBBTC]);
    expect((await open.svc.pricePool(pool)).token1Usd).toBe(85_000);
    const denied = pricing({ tokenTrustDeny: CBBTC }, {});
    await denied.svc.prefetchPrices(1, [BTCB, CBBTC]);
    expect((await denied.svc.pricePool(pool)).token1Usd).toBe(0); // not listed → DEX gate, fail-closed
  });

  it('earned mode: an earned BTC.b is trusted like a listed token; a listed-but-unearned cbBTC is not', async () => {
    const { svc } = pricing({ tokenTrustMode: 'earned' }, { [BTCB]: { trustEarned: true } });
    await svc.prefetchPrices(1, [BTCB, CBBTC]);
    const r = await svc.pricePool(pool);
    expect(r.token0Usd).toBe(85_000);
    expect(r.token0Confidence).toBe('external-verified');
    expect(r.token1Usd).toBe(0); // no verdict + DEX state unknown + fail-closed
  });
});

describe('leaderboard exclusion uses the same rule', () => {
  function repo(rows: Array<Record<string, unknown>>, config: Record<string, unknown> = {}) {
    const filters: unknown[] = [];
    const model = {
      find: (f: unknown) => {
        filters.push(f);
        const c: Record<string, unknown> = { select: () => c, read: () => c, maxTimeMS: () => c, lean: async () => rows };
        return c;
      },
    };
    return { repo: new TokensRepository({ tokenModel: () => model } as never, config as never), filters };
  }
  const noMarket = (address: string, extra: Record<string, unknown> = {}) => ({ address, priceSources: ['defillama'], dexActive: false, ...extra });

  it('allowlist mode: anchors and allowlisted tokens are exempt, others excluded (today)', async () => {
    const { repo: r } = repo([noMarket(USDC), noMarket(CBBTC), noMarket(BTCB)]);
    expect(await r.findNoRealMarketAddresses(1)).toEqual([BTCB]);
  });

  it('earned mode: the listing no longer exempts — only anchors and fresh earned verdicts do', async () => {
    const { repo: r } = repo(
      [noMarket(USDC), noMarket(CBBTC), noMarket(BTCB, { trustEarned: true, trustEvaluatedAt: new Date() })],
      { tokenTrustMode: 'earned' },
    );
    expect((await r.findNoRealMarketAddresses(1)).sort()).toEqual([CBBTC]);
  });

  it('EMERGENCY DENY excludes a token outright: env in any mode; the Mongo flag in earned mode only', async () => {
    const env = repo([noMarket(USDC)], { tokenTrustDeny: `1:${CBBTC}` });
    expect(await env.repo.findNoRealMarketAddresses(1)).toEqual([CBBTC]);
    const row = { address: CBBTC, priceSources: ['dexscreener'], dexActive: true, trustDenied: true };
    const earned = repo([row], { tokenTrustMode: 'earned' });
    expect(await earned.repo.findNoRealMarketAddresses(1)).toEqual([CBBTC]);
    // allowlist mode: the flag is ignored here exactly as the position path
    // and the pools sync ignore it (one trust answer per mode).
    const allowlist = repo([row]);
    expect(await allowlist.repo.findNoRealMarketAddresses(1)).toEqual([]);
  });

  it('a price the quote guard cleared (pricePurgedAt) stays in the scan', async () => {
    const { repo: r, filters } = repo([{ address: BTCB, priceUsd: 0, pricePurgedAt: new Date(), priceSources: ['dia'] }]);
    expect(await r.findNoRealMarketAddresses(1)).toEqual([BTCB]);
    expect(JSON.stringify(filters[0])).toContain('pricePurgedAt');
  });
});
