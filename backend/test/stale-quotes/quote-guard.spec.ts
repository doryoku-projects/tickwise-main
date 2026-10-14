import { describe, expect, it, vi } from 'vitest';
import { DiaProvider } from '../../src/pricing/providers/dia.provider.js';
import { DefillamaProvider } from '../../src/pricing/providers/defillama.provider.js';
import { PricingService } from '../../src/pricing/pricing.service.js';
import { quoteRejection, trustPolicyOf } from '../../src/pricing/token-trust.js';
import { enforcePoolConsistency } from '../../src/pricing/pool-consistency.js';
import type { GuardedPriceClear, TokenPriceRecord } from '../../src/database/token.repository.js';

/**
 * Fix 1 (docs/spam-and-pool-mismatch-2026-10-05.md): DIA served HPP at
 * $31,374 from a 4.5-month-old quotation with $0.098 of daily volume, the
 * first-positive walk took it and `{chainId}_tokens` kept it as last-known
 * good. `PRICE_QUOTE_GUARD=on` rejects such quotes everywhere a quote can win;
 * OFF (the default) every path behaves exactly as before.
 */

const NOW = Date.UTC(2026, 9, 5, 12);
const DAY = 24 * 60 * 60 * 1000;
const HPP = '0x000000000000000000000000000000000000a0a1';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const GUARD = { priceQuoteGuard: 'on' };

describe('quoteRejection', () => {
  const policy = trustPolicyOf({ ...GUARD });
  it('rejects a quote the provider dated past the max age (24 h default)', () => {
    expect(quoteRejection({ quotedAtMs: NOW - 140 * DAY, volume24hUsd: 1e9 }, 'defillama', policy, NOW)).toBe('stale');
    expect(quoteRejection({ quotedAtMs: NOW - DAY - 1, volume24hUsd: 1e9 }, 'defillama', policy, NOW)).toBe('stale');
  });
  it('accepts a fresh dated quote and an undated (live) one', () => {
    expect(quoteRejection({ quotedAtMs: NOW - DAY }, 'defillama', policy, NOW)).toBeNull();
    expect(quoteRejection({}, 'dexscreener', policy, NOW)).toBeNull();
  });
  it('rejects a DIA quote with under $1,000 of 24 h volume (and one with no volume at all)', () => {
    expect(quoteRejection({ quotedAtMs: NOW, volume24hUsd: 0.098 }, 'dia', policy, NOW)).toBe('thin');
    expect(quoteRejection({ quotedAtMs: NOW }, 'dia', policy, NOW)).toBe('thin');
    expect(quoteRejection({ quotedAtMs: NOW, volume24hUsd: 60_860 }, 'dia', policy, NOW)).toBeNull();
  });
  it('the volume floor is DIA-only', () => {
    expect(quoteRejection({ volume24hUsd: 0 }, 'geckoterminal', policy, NOW)).toBeNull();
  });
  it('honours PRICE_QUOTE_MAX_AGE_MS / PRICE_DIA_MIN_VOLUME_USD', () => {
    const p = trustPolicyOf({ priceQuoteGuard: 'on', priceQuoteMaxAgeMs: 60_000, priceDiaMinVolumeUsd: 0 });
    expect(quoteRejection({ quotedAtMs: NOW - 61_000 }, 'defillama', p, NOW)).toBe('stale');
    expect(quoteRejection({ quotedAtMs: NOW }, 'dia', p, NOW)).toBeNull();
  });
});

describe('providers date their quotes', () => {
  it('DIA: `Time` → quotedAtMs', async () => {
    const p = new DiaProvider({} as never);
    vi.spyOn(p as unknown as { httpJson: () => unknown }, 'httpJson').mockResolvedValue({
      statusCode: 200,
      data: { Price: 31374.54, VolumeYesterdayUSD: 0.098, Time: '2026-05-22T08:00:00Z' },
    } as never);
    const q = await p.getCurrentSingle(1, HPP);
    expect(q?.quotedAtMs).toBe(Date.parse('2026-05-22T08:00:00Z'));
  });
  it('DeFiLlama: current `timestamp` (s) → quotedAtMs, batch and single', async () => {
    const p = new DefillamaProvider({ pricingProviderMaxConcurrency: 1, pricingHistoricalSingleConcurrency: 1 } as never);
    vi.spyOn(p as unknown as { httpJson: () => unknown }, 'httpJson').mockResolvedValue({
      statusCode: 200,
      data: { coins: { [`ethereum:${HPP}`]: { price: 0.0062, confidence: 0.99, timestamp: 1_791_193_130 } } },
    } as never);
    const batch = await p.getCurrentBatch(1, [HPP]);
    expect(batch.get(`1:${HPP}`)?.quotedAtMs).toBe(1_791_193_130_000);
    const single = await p.getCurrentSingle(1, HPP);
    expect(single?.quotedAtMs).toBe(1_791_193_130_000);
  });
});

// ─── PricingService ──────────────────────────────────────────────────────────

type Q = { priceUsd: number; quotedAtMs?: number; volume24hUsd?: number };
function provider(name: string, quotes: Record<string, Q>, batch: boolean, available = true) {
  const get = (a: string) => quotes[a.toLowerCase()];
  return {
    name,
    supportsCurrentBatch: batch,
    supportsHistoricalBatch: false,
    maxBatchSize: 50,
    singleConcurrency: 1,
    defaultBackoffMs: 0,
    isEnabled: () => true,
    isAvailable: () => available,
    getCurrentSingle: vi.fn(async (_c: number, a: string) => get(a) ?? null),
    getCurrentBatch: batch
      ? vi.fn(async (chainId: number, addrs: string[]) => {
          const out = new Map<string, Q>();
          for (const a of addrs) if (get(a)) out.set(`${chainId}:${a.toLowerCase()}`, get(a)!);
          return out;
        })
      : undefined,
    getHistoricalSingle: vi.fn(async () => null),
    getMetrics: () => ({ success: 0, miss: 0, ratelimit: 0, error: 0, skip: 0 }),
  };
}

function service(providers: ReturnType<typeof provider>[], config: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  const persisted: TokenPriceRecord[] = [];
  const cleared: GuardedPriceClear[] = [];
  const tokens = {
    findLatestPrices: async () => new Map(),
    upsertPrices: async (_c: number, recs: TokenPriceRecord[]) => {
      persisted.push(...recs);
    },
    findDexMarketState: async () => new Map(),
    findMarketState: async () => new Map(),
    upsertTrustEvidence: vi.fn(async () => {}),
    clearGuardedPrices: vi.fn(async (_c: number, entries: GuardedPriceClear[]) => {
      cleared.push(...entries);
      return entries.length;
    }),
    ...extra,
  };
  const svc = new PricingService(
    {
      priceFallbackEnabled: true,
      tokenListingGateEnabled: true,
      dexMarketGateEnabled: false,
      pricingPrefetchChunkConcurrency: 2,
      dexMarketMinVolumeUsd: 50,
      dexMarketMinCounterLiquidityUsd: 1000,
      ...config,
    } as never,
    {} as never,
    { currentProviders: () => providers, historicalProviders: () => providers } as never,
    { isListed: () => true } as never,
    tokens as never,
  );
  return { svc, persisted, cleared, tokens };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('hot path (single walk)', () => {
  const stale: Q = { priceUsd: 31_374.54, quotedAtMs: Date.now() - 140 * DAY, volume24hUsd: 0.098 };
  const real: Q = { priceUsd: 0.0062, quotedAtMs: Date.now() - 60_000 };

  it('guard OFF (default): the stale DIA quote wins the first-positive walk, as today', async () => {
    const { svc, persisted } = service([provider('dia', { [HPP]: stale }, false), provider('defillama', { [HPP]: real }, false)]);
    const r = await svc.pricePool({ chainId: 1, token0: { address: HPP, decimals: 18 }, token1: { address: USDC, decimals: 6 } });
    expect(r.token0Usd).toBe(31_374.54);
    await flush();
    // Today's persist: price only, no provenance fields at all.
    expect(persisted.find((p) => p.address === HPP)).toEqual({ address: HPP, priceUsd: 31_374.54 });
  });

  it('guard ON: the stale quote is skipped — the next provider prices it and is what gets persisted', async () => {
    const { svc, persisted } = service([provider('dia', { [HPP]: stale }, false), provider('defillama', { [HPP]: real }, false)], GUARD);
    const r = await svc.pricePool({ chainId: 1, token0: { address: HPP, decimals: 18 }, token1: { address: USDC, decimals: 6 } });
    expect(r.token0Usd).toBe(0.0062);
    await flush();
    const rec = persisted.find((p) => p.address === HPP);
    expect(rec?.priceUsd).toBe(0.0062);
    expect(rec?.priceQuoteSource).toBe('defillama');
    expect(rec?.priceQuotedAt).toBeInstanceOf(Date);
    expect(persisted.some((p) => p.priceUsd === 31_374.54)).toBe(false);
  });

  it('guard ON: a thin DIA quote (fresh but ~$0 volume) is skipped too', async () => {
    const thin: Q = { priceUsd: 5, quotedAtMs: Date.now(), volume24hUsd: 0.5 };
    const { svc } = service([provider('dia', { [HPP]: thin }, false), provider('defillama', { [HPP]: real }, false)], GUARD);
    const r = await svc.pricePool({ chainId: 1, token0: { address: HPP, decimals: 18 }, token1: { address: USDC, decimals: 6 } });
    expect(r.token0Usd).toBe(0.0062);
  });
});

describe('page prefetch (batch walk)', () => {
  const stale: Q = { priceUsd: 9, quotedAtMs: Date.now() - 30 * DAY };
  const real: Q = { priceUsd: 1.5 };
  it('guard ON: a stale batch quote is a miss — the next batch provider answers and is persisted', async () => {
    const { svc, persisted } = service([provider('defillama', { [HPP]: stale }, true), provider('dexscreener', { [HPP]: real }, true)], GUARD);
    await svc.prefetchPrices(1, [HPP]);
    expect(persisted.map((p) => p.priceUsd)).toEqual([1.5]);
  });
  it('guard OFF: the stale batch quote wins and nothing extra is written', async () => {
    const { svc, persisted } = service([provider('defillama', { [HPP]: stale }, true), provider('dexscreener', { [HPP]: real }, true)]);
    await svc.prefetchPrices(1, [HPP]);
    expect(persisted).toEqual([{ address: HPP, priceUsd: 9, symbol: undefined }]);
  });
});

describe('consensus sweep', () => {
  const stale: Q = { priceUsd: 31_374.54, quotedAtMs: Date.now() - 140 * DAY, volume24hUsd: 0.098 };

  it('guard OFF: the stale quote votes and the stored record has exactly today\'s fields', async () => {
    const { svc, persisted, tokens } = service([provider('dia', { [HPP]: stale }, false)]);
    await svc.prefetchConsensus(1, [HPP]);
    expect(Object.keys(persisted[0]!).sort()).toEqual(
      ['address', 'dexActive', 'dexCounterLiquidity', 'dexVolume24h', 'priceConfidence', 'priceSources', 'priceUsd'].sort(),
    );
    expect(persisted[0]!.priceUsd).toBe(31_374.54);
    expect(tokens.upsertTrustEvidence).not.toHaveBeenCalled();
    expect(tokens.clearGuardedPrices).not.toHaveBeenCalled();
  });

  it('guard ON: a token whose EVERY quote is rejected has its saved price cleared (re-priced, not served)', async () => {
    const { svc, persisted, cleared } = service([provider('dia', { [HPP]: stale }, false)], GUARD);
    const stats = await svc.prefetchConsensus(1, [HPP]);
    expect(persisted).toEqual([]);
    // With the providers whose quotes were rejected: the repository clears the
    // saved price only if it came from them.
    expect(cleared).toEqual([{ address: HPP, rejectedSources: ['dia'] }]);
    expect(stats.guardCleared).toBe(1);
  });

  it('guard ON: NOT cleared when a provider was skipped this sweep (a rate-limited DeFiLlama may hold the real price)', async () => {
    const NVDA = '0x000000000000000000000000000000000000a0b1';
    const thinDia: Q = { priceUsd: 233.1, quotedAtMs: Date.now(), volume24hUsd: 120 };
    const { svc, cleared, tokens } = service(
      [provider('defillama', { [NVDA]: { priceUsd: 232.97 } }, true, /*available*/ false), provider('dia', { [NVDA]: thinDia }, false)],
      GUARD,
    );
    const stats = await svc.prefetchConsensus(1, [NVDA]);
    expect(stats.guardRejected).toBe(1);
    expect(cleared).toEqual([]);
    expect(tokens.clearGuardedPrices).not.toHaveBeenCalled();
  });

  it('guard ON: NOT cleared when a provider that ran did not cover the token (no definite answer)', async () => {
    const T = '0x000000000000000000000000000000000000a0b2';
    // A batch provider whose call failed for this chunk (empty + unavailable afterwards).
    const flaky = provider('defillama', {}, true);
    let healthy = true;
    flaky.isAvailable = () => healthy;
    flaky.getCurrentBatch = vi.fn(async () => {
      healthy = false;
      return new Map();
    });
    const { svc, cleared } = service([provider('dia', { [T]: stale }, false), flaky], GUARD);
    await svc.prefetchConsensus(1, [T]);
    expect(cleared).toEqual([]);
  });

  it('guard ON: the stale quote does not vote — the fresh ones decide, with the rejection recorded', async () => {
    const { svc, persisted, cleared } = service(
      [
        provider('dia', { [HPP]: stale }, false),
        provider('defillama', { [HPP]: { priceUsd: 0.0062, quotedAtMs: Date.now() } }, true),
        provider('coingecko', { [HPP]: { priceUsd: 0.0061 } }, true),
      ],
      GUARD,
    );
    await svc.prefetchConsensus(1, [HPP]);
    const rec = persisted.find((p) => p.address === HPP)!;
    expect(rec.priceSources?.sort()).toEqual(['coingecko', 'defillama']);
    expect(rec.priceConfidence).toBe('external-verified');
    expect(rec.priceQuoteRejected).toEqual(['dia:stale']);
    expect(rec.priceGuardUsd).toBeCloseTo(0.00615, 6);
    expect(cleared).toEqual([]);
  });

  it('shadow (TOKEN_TRUST_SHADOW=on, guard off): the stale quote still votes, but the would-be guard price is recorded', async () => {
    const { svc, persisted, cleared } = service(
      [provider('dia', { [HPP]: stale }, false), provider('defillama', { [HPP]: { priceUsd: 0.0062, quotedAtMs: Date.now() } }, true)],
      { tokenTrustShadow: 'on' },
    );
    await svc.prefetchConsensus(1, [HPP]);
    const rec = persisted.find((p) => p.address === HPP)!;
    expect(rec.priceUsd).toBe(0.0062); // disagreement → conservative MIN, as today
    expect(rec.priceQuoteRejected).toEqual(['dia:stale']);
    expect(rec.priceGuardUsd).toBe(0.0062);
    expect(rec.priceSourcesDisagreed).toBe(false); // ONE accepted quote is not a disagreement
    expect(cleared).toEqual([]);
  });

  it('shadow: a fresh consensus that a stale quote sits within 10% of is dated by its ACCEPTED sources', async () => {
    const freshAt = Date.now() - 60_000;
    const staleAt = Date.now() - 140 * DAY;
    const { svc, persisted } = service(
      [
        provider('dia', { [USDC]: { priceUsd: 1.0, quotedAtMs: staleAt, volume24hUsd: 1e9 } }, false),
        provider('defillama', { [USDC]: { priceUsd: 1.0, quotedAtMs: freshAt } }, true),
        provider('coingecko', { [USDC]: { priceUsd: 1.001 } }, true),
      ],
      { tokenTrustShadow: 'on' },
    );
    await svc.prefetchConsensus(1, [USDC]);
    const rec = persisted.find((p) => p.address === USDC)!;
    expect(rec.priceSources?.sort()).toEqual(['coingecko', 'defillama', 'dia']); // the stale quote voted (shadow)
    expect(rec.priceQuotedAt?.getTime()).toBe(freshAt); // …but is not the price's date
    expect(rec.priceGuardUsd).toBeCloseTo(1.0005, 6);
  });

  it('shadow: a price ONLY rejected quotes back keeps their (stale) date', async () => {
    const staleAt = Date.now() - 140 * DAY;
    const { svc, persisted } = service([provider('dia', { [HPP]: { ...stale, quotedAtMs: staleAt } }, false)], { tokenTrustShadow: 'on' });
    await svc.prefetchConsensus(1, [HPP]);
    expect(persisted[0]!.priceQuotedAt?.getTime()).toBe(staleAt);
    expect(persisted[0]!.priceGuardUsd).toBe(0);
  });

  it('records whether ≥ 2 ACCEPTED quotes disagreed (single source = no disagreement)', async () => {
    const A = '0x000000000000000000000000000000000000a0c1';
    const B = '0x000000000000000000000000000000000000a0c2';
    const C = '0x000000000000000000000000000000000000a0c3';
    const { svc, persisted } = service(
      [
        provider('defillama', { [A]: { priceUsd: 1 }, [B]: { priceUsd: 1 }, [C]: { priceUsd: 1 } }, true),
        provider('coingecko', { [A]: { priceUsd: 5 }, [B]: { priceUsd: 1.01 } }, true),
        // A stale disagreeing quote is rejected under the guard: it is no disagreement.
        provider('dia', { [C]: { priceUsd: 9, quotedAtMs: Date.now() - 40 * DAY, volume24hUsd: 1e9 } }, false),
      ],
      GUARD,
    );
    await svc.prefetchConsensus(1, [A, B, C]);
    const by = (a: string) => persisted.find((p) => p.address === a)!;
    expect(by(A).priceSourcesDisagreed).toBe(true);
    expect(by(B).priceSourcesDisagreed).toBe(false);
    expect(by(C).priceSourcesDisagreed).toBe(false);
  });
});

describe('listed single-source quotes are cross-checked under the guard', () => {
  const AERGO = '0x91af0fbb28aba7e31403cb457106ce79397fd4e6';
  function listedService(config: Record<string, unknown>, disagreed: Record<string, boolean>) {
    const p = provider('mock', { [HPP]: { priceUsd: 2 }, [AERGO]: { priceUsd: 0.05 } }, true);
    return service([p], config, {
      findMarketState: async (_c: number, addrs: string[]) =>
        new Map(addrs.filter((a) => a in disagreed).map((a) => [a, { disagreed: disagreed[a], trust: {} }])),
    }).svc;
  }
  const input = { chainId: 1, token0: { address: HPP, decimals: 18, verified: false }, token1: { address: AERGO, decimals: 18, verified: false } };

  it('guard OFF: a listed leg is upgraded to external-verified on its listing (today)', async () => {
    const svc = listedService({}, { [HPP]: true });
    await svc.prefetchPrices(1, [HPP, AERGO]);
    const r = await svc.pricePool(input);
    expect(r.token0Confidence).toBe('external-verified');
  });

  it('guard ON: a listed leg whose sweep recorded DISAGREEING sources stays external-unverified', async () => {
    const svc = listedService(GUARD, { [HPP]: true, [AERGO]: false });
    await svc.prefetchPrices(1, [HPP, AERGO]);
    const r = await svc.pricePool(input);
    expect(r.token0Confidence).toBe('external-unverified'); // → pool cross-check + backing floor apply downstream
    expect(r.token1Confidence).toBe('external-verified'); // a real consensus keeps its upgrade
  });

  it('guard ON: an unswept listed token (no stored flag) keeps today\'s upgrade', async () => {
    const svc = listedService(GUARD, {});
    await svc.prefetchPrices(1, [HPP, AERGO]);
    const r = await svc.pricePool(input);
    expect(r.token0Confidence).toBe('external-verified');
  });
});

describe('regression: a real listed/listed pair with ONE source per leg keeps its value under the guard (SPY/NVDA on 4663)', () => {
  // Both legs allowlisted, each priced by a single provider (GeckoTerminal-only
  // SPY, DefiLlama-only NVDA): a single-source quote is NOT a disagreement, so
  // the listing upgrade stands, both legs stay references, and the
  // no-reference rule cannot zero them.
  const SPY = '0x000000000000000000000000000000000000a5b1';
  const NVDA = '0x000000000000000000000000000000000000a5b2';
  const input = { chainId: 1, token0: { address: SPY, decimals: 18, verified: false }, token1: { address: NVDA, decimals: 18, verified: false } };
  async function run(config: Record<string, unknown>) {
    const p = provider('mock', { [SPY]: { priceUsd: 769.72 }, [NVDA]: { priceUsd: 232.97 } }, true);
    const { svc } = service([p], config, {
      // What a guard-on sweep stores for a single-source token: priceConfidence
      // external-unverified, priceSourcesDisagreed false.
      findMarketState: async (_c: number, addrs: string[]) => new Map(addrs.map((a) => [a, { disagreed: false, trust: {} }])),
    });
    await svc.prefetchPrices(1, [SPY, NVDA]);
    return svc.pricePool(input);
  }
  it('guard OFF and guard ON give the same verified/verified prices', async () => {
    const off = await run({});
    const on = await run(GUARD);
    for (const r of [off, on]) {
      expect(r.token0Confidence).toBe('external-verified');
      expect(r.token1Confidence).toBe('external-verified');
      expect(r.token0Usd).toBe(769.72);
      expect(r.token1Usd).toBe(232.97);
      // …so the pool cross-check keeps both legs (a pool ratio matching the market).
      const c = enforcePoolConsistency(r.token0Usd, r.token1Usd, 'verified', 'verified', 769.72 / 232.97);
      expect([c.vp0, c.vp1]).toEqual([769.72, 232.97]);
    }
    // The failure this pins: unverified/unverified with no reference → both zeroed.
    const zeroed = enforcePoolConsistency(769.72, 232.97, 'unverified', 'unverified', 769.72 / 232.97);
    expect([zeroed.vp0, zeroed.vp1]).toEqual([0, 0]);
  });
});

describe('guard evidence: per-leg corroboration for the adapter\'s listed-pair cross-check', () => {
  // `PriceResult.token{0,1}Corroborated` is what envio.adapter.ts's
  // `crossCheckAllowlistedPair` reads: only an explicit `false` subjects a
  // verified leg to the pool-ratio / backing-floor check; absent = left alone.
  const AERGO = '0x91af0fbb28aba7e31403cb457106ce79397fd4e6';
  const input = { chainId: 1, token0: { address: HPP, decimals: 18, verified: false }, token1: { address: AERGO, decimals: 18, verified: false } };
  type Row = { disagreed?: boolean; consensus?: boolean; trust?: Record<string, unknown> };
  async function run(config: Record<string, unknown>, rows: Record<string, Row>) {
    const p = provider('mock', { [HPP]: { priceUsd: 2 }, [AERGO]: { priceUsd: 0.05 } }, true);
    const findMarketState = vi.fn(async (_c: number, addrs: string[]) =>
      new Map(addrs.filter((a) => a in rows).map((a) => [a, { trust: {}, ...rows[a] }])),
    );
    const { svc } = service([p], config, { findMarketState });
    await svc.prefetchPrices(1, [HPP, AERGO]);
    return { r: await svc.pricePool(input), findMarketState };
  }

  it('guard OFF: no evidence is attached, whatever is stored (today\'s PriceResult shape)', async () => {
    const { r, findMarketState } = await run({}, { [HPP]: { consensus: false }, [AERGO]: { consensus: true } });
    expect('token0Corroborated' in r).toBe(false);
    expect('token1Corroborated' in r).toBe(false);
    expect(findMarketState).not.toHaveBeenCalled();
  });

  it('guard OFF in earned mode (the market state IS read there): still no evidence attached', async () => {
    const earned = { trustEarned: true, trustReason: 'earned', trustEvaluatedAt: new Date() };
    const { r, findMarketState } = await run({ tokenTrustMode: 'earned' }, { [HPP]: { consensus: false, trust: earned }, [AERGO]: { consensus: true } });
    expect(findMarketState).toHaveBeenCalled();
    expect('token0Corroborated' in r).toBe(false);
    expect('token1Corroborated' in r).toBe(false);
  });

  it('guard ON: stored consensus → true, stored single-source → false', async () => {
    const { r } = await run(GUARD, { [HPP]: { consensus: false }, [AERGO]: { consensus: true } });
    expect(r.token0Corroborated).toBe(false);
    expect(r.token1Corroborated).toBe(true);
    // A single-source listed leg keeps its listing upgrade: it reaches the
    // adapter as `verified`, where the cross-check (not a blanket demotion) runs.
    expect(r.token0Confidence).toBe('external-verified');
  });

  it('guard ON: no stored verdict → the field is ABSENT (the adapter leaves the leg alone)', async () => {
    const { r } = await run(GUARD, { [AERGO]: { consensus: true } });
    expect('token0Corroborated' in r).toBe(false);
    expect(r.token1Corroborated).toBe(true);
  });

  it('guard ON: sources that DISAGREED are never corroborated, whatever the consensus flag says', async () => {
    const { r } = await run(GUARD, { [HPP]: { disagreed: true, consensus: true } });
    expect(r.token0Corroborated).toBe(false);
    expect(r.token0Confidence).toBe('external-unverified'); // and the leg stays unverified (enforcePoolConsistency)
  });

  it('earned mode + guard: a fresh EARNED verdict corroborates a leg with no consensus flag', async () => {
    const earned = { trustEarned: true, trustReason: 'earned', trustEvaluatedAt: new Date() };
    const { r } = await run({ ...GUARD, tokenTrustMode: 'earned' }, { [HPP]: { trust: earned } });
    expect(r.token0Corroborated).toBe(true);
    expect('token1Corroborated' in r).toBe(false); // AERGO: no verdict at all
  });
});
