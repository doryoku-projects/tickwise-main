import { afterEach, describe, expect, it, vi } from 'vitest';
import { PricingService } from '../../src/pricing/pricing.service.js';
import { PairLookupBucket, batchShare, runPairLookupBudget, runVerdictLookups } from '../../src/pricing/pair-lookup-budget.js';
import type { TokenLookupPriority, TokenPriceRecord, TokenTrustRecord } from '../../src/database/token.repository.js';

/**
 * Package A review (2026-10-06): what a batch's token-pairs requests go to.
 *  - The per-RUN earned-trust budget (300) cut latest mode from 25 lookups per
 *    500-token batch to ~5 on chain 1. Under prod's TOKEN_TRUST_MODE=combined
 *    those verdicts are SERVED, so tokens whose (c) needs their own pairs
 *    lapsed to `stale-verdict` and lost trust: the run's budget is now never
 *    under 25 per batch fed.
 *  - (c)'s lookups ran inline in batch order and per-chain's served re-checks
 *    likewise: with the feed order fixed and answers cached 6 h, the same
 *    first tokens of a batch took the share every run and the rest never got
 *    one. Both now wait for the batch's request phase and go out in priority
 *    order (stored earned verdicts nearest `stale-verdict` / stored served
 *    `dexActive:true` first, then the never-judged, then the rest, taking
 *    turns by when this process last asked).
 *  - Both kinds draw from ONE process-wide rate: served re-checks first in
 *    batch order took the burst from earners. They take turns now.
 */

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'; // anchor (stable)
const LINK = '0x514910771af9ca656af840dff83e8264ecf986ca'; // CoinGecko-allowlisted, not an anchor
const HOUR = 3_600_000;
const tok = (i: number) => `0x${(0xd000 + i).toString(16).padStart(40, '0')}`;

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

const LATEST = { tokenTrustShadow: 'on' };
const PER_CHAIN_SERVED_ONLY = { dexscreenerBatchEndpoint: 'per-chain' };
const PER_CHAIN = { tokenTrustShadow: 'on', dexscreenerBatchEndpoint: 'per-chain' };

const weak = { id: '0xweak', liquidityUsd: 2_000_000, counterLiquidity: 500, counterTokenAddress: USDC };
const twoPools = {
  pairs: [
    { id: '0xp1', liquidityUsd: 100_000, counterLiquidity: 50_000, counterTokenAddress: USDC },
    { id: '0xp2', liquidityUsd: 80_000, counterLiquidity: 40_000, counterTokenAddress: USDC },
  ],
  complete: true,
  base: { volume24hUsd: 9_000, counterLiquidity: 50_000, counterTokenAddress: USDC },
  market: { volume24hUsd: 9_000, counterLiquidity: 50_000, counterTokenAddress: USDC },
};
/** A token whose capped / one-pair sample passes on ONE weak pool: (c) needs its own pairs to earn. */
const earner = (): Q => ({ priceUsd: 4, volume24hUsd: 9_000, counterLiquidity: 5_000, counterTokenAddress: USDC, dexPairs: [weak], dexPairsComplete: false });
/** A per-chain one-pair sample under the $50 volume floor: its served dexActive is re-checked against its own pairs. */
const floorFailing = (): Q => ({ priceUsd: 2, volume24hUsd: 10, dexPairsComplete: false });

function setup(opts: {
  earners?: string[];
  /** Like `earners`, but the DEX answer does not say it sampled them (no `dexPairsComplete`): (c) after the sample rule. */
  unsampled?: string[];
  floorFailing?: string[];
  config: Record<string, unknown>;
  stored?: Record<string, TokenLookupPriority>;
  answer?: (addr: string) => unknown;
}) {
  const quotes: Record<string, Q> = {};
  const agree: Record<string, Q> = {};
  for (const a of opts.earners ?? []) [quotes[a], agree[a]] = [earner(), { priceUsd: 4 }];
  for (const a of opts.unsampled ?? []) {
    const { dexPairsComplete: _sampled, ...q } = earner();
    [quotes[a], agree[a]] = [q as Q, { priceUsd: 4 }];
  }
  for (const a of opts.floorFailing ?? []) [quotes[a], agree[a]] = [floorFailing(), { priceUsd: 2 }];
  const asked: string[] = [];
  const getTokenPairs = vi.fn(async (_c: number, addr: string) => {
    asked.push(addr);
    return opts.answer ? opts.answer(addr) : twoPools;
  });
  const ds = provider('dexscreener', quotes, { getTokenPairs });
  const dl = provider('defillama', agree);
  const prices: TokenPriceRecord[] = [];
  const verdicts: TokenTrustRecord[] = [];
  const stored = opts.stored ?? {};
  const findLookupPriority = vi.fn(async (_c: number, addrs: string[]) => {
    const out = new Map<string, TokenLookupPriority>();
    for (const a of addrs) if (stored[a]) out.set(a, stored[a]!);
    return out;
  });
  const tokens = {
    findLatestPrices: vi.fn(async () => new Map()),
    upsertPrices: vi.fn(async (_c: number, r: TokenPriceRecord[]) => void prices.push(...r)),
    upsertTrustEvidence: async (_c: number, r: TokenTrustRecord[]) => void verdicts.push(...r),
    clearGuardedPrices: vi.fn(async () => 0),
    findTrustState: async () => new Map(),
    findDexMarketState: async () => new Map(),
    findLookupPriority,
  };
  const svc = new PricingService(
    {
      priceFallbackEnabled: true,
      tokenListingGateEnabled: true,
      dexMarketMinVolumeUsd: 50,
      dexMarketMinCounterLiquidityUsd: 1000,
      pricingPrefetchChunkConcurrency: 2,
      ...opts.config,
    } as never,
    {} as never,
    { currentProviders: () => [ds, dl], historicalProviders: () => [ds, dl] } as never,
    { isListed: () => false } as never,
    tokens as never,
  );
  const earned = () => verdicts.filter((v) => v.trustEarned).map((v) => v.address);
  const record = (a: string) => prices.filter((r) => r.address === a).at(-1);
  return { svc, asked, getTokenPairs, verdicts, prices, earned, record, findLookupPriority };
}

const huge = () => new PairLookupBucket(1e9, 1e9);
/** A run that is not spread (one batch spends it all) with these budgets, on an unlimited rate unless told. */
function run(svc: PricingService, budgets: { verdict?: number; served?: number }, bucket = huge()) {
  const r = svc.startConsensusSweep({ bucket });
  if (budgets.verdict !== undefined) r.pairLookups.verdictLeft = budgets.verdict;
  if (budgets.served !== undefined) r.pairLookups.servedLeft = budgets.served;
  return r;
}
const ago = (h: number) => new Date(Date.now() - h * HOUR);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a run's earned-trust budget is never under latest mode's 25 per 500-token batch", () => {
  it('runVerdictLookups: 25 per batch fed, at least 300; a run not told its size gets 300', () => {
    expect(runVerdictLookups(31_456)).toBe(25 * 63); // chain 1: 1,575 (was 300)
    expect(runVerdictLookups(1_074)).toBe(300); // Avalanche: 3 batches → the floor of 300
    expect(runVerdictLookups(12_001)).toBe(25 * 25);
    expect(runVerdictLookups(undefined)).toBe(300);
    expect(runVerdictLookups(Number.NaN)).toBe(300);
    expect(runVerdictLookups(0)).toBe(300);
    // Per batch on chain 1: ~26, not ~5; the served re-check keeps its 300 a run.
    const budget = runPairLookupBudget('per-chain', huge(), 31_456);
    expect(batchShare(budget, 500)).toMatchObject({ verdictLeft: 26, servedLeft: 5 });
  });

  it('latest mode, a chain-1-sized run: one 500-token batch with 30 tokens whose (c) needs its own pairs earns 26 of them, not 5', async () => {
    const earners = Array.from({ length: 30 }, (_, i) => tok(i));
    const filler = Array.from({ length: 470 }, (_, i) => tok(1000 + i)); // swept, nothing to look up
    const s = setup({ earners, config: LATEST });
    const r = s.svc.startConsensusSweep({ bucket: huge(), tokens: 31_456 });
    await s.svc.prefetchConsensus(1, [...earners, ...filler], r);
    // ceil(1,575 × 500 / 31,456) = 26 (a flat 300 a run: ceil(300 × 500 / 31,456) = 5).
    expect(s.getTokenPairs).toHaveBeenCalledTimes(26);
    expect(s.earned()).toHaveLength(26);
  });
});

describe("(c)'s lookups go out in priority order, not batch order", () => {
  it('stored EARNED verdicts first, the oldest first (nearest stale-verdict); then never judged; then stored failures', async () => {
    const P = Array.from({ length: 5 }, (_, i) => tok(100 + i));
    const s = setup({
      earners: P,
      config: LATEST,
      stored: {
        [P[0]!]: { trustEarned: false, trustEvaluatedAt: ago(40) }, // a stored failure, however old: last
        [P[2]!]: { trustEarned: true, trustEvaluatedAt: ago(5) },
        [P[3]!]: { trustEarned: true, trustEvaluatedAt: ago(22) }, // 2 h from stale-verdict: first
      },
    });
    await s.svc.prefetchConsensus(1, P, run(s.svc, { verdict: 4 }));
    expect(s.asked).toEqual([P[3], P[2], P[1], P[4]]);
    expect(s.earned().sort()).toEqual([P[1], P[2], P[3], P[4]].sort());
    expect(s.findLookupPriority).toHaveBeenCalledTimes(1); // one read for the batch
  });

  it('…where batch order gave the share to the first tokens of the batch and the earned ones at its end lapsed', async () => {
    const P = Array.from({ length: 10 }, (_, i) => tok(200 + i));
    const s = setup({
      earners: P,
      config: LATEST,
      stored: Object.fromEntries([7, 8, 9].map((i) => [P[i]!, { trustEarned: true, trustEvaluatedAt: ago(30 - i) }])),
    });
    await s.svc.prefetchConsensus(1, P, run(s.svc, { verdict: 3 }));
    expect(s.asked).toEqual([P[7], P[8], P[9]]);
    expect(s.earned().sort()).toEqual([P[7], P[8], P[9]].sort());
  });

  it('the same for a token with no sample whose evidence is incomplete ((c) after the sample rule, `tokenPairs`)', async () => {
    const T = Array.from({ length: 4 }, (_, i) => tok(250 + i));
    // No `dexPairsComplete` on the answer: not a sample, but its pairs are not known complete either.
    const s = setup({ unsampled: T, config: LATEST, stored: { [T[3]!]: { trustEarned: true, trustEvaluatedAt: ago(20) } } });
    await s.svc.prefetchConsensus(1, T, run(s.svc, { verdict: 2 }));
    expect(s.asked).toEqual([T[3], T[0]]);
    expect(s.earned().sort()).toEqual([T[0], T[3]].sort());
  });

  it('combined mode: an allowlisted token is trusted whatever its verdict, so its lookup waits behind an unlisted earned one; shadow mode asks the older first', async () => {
    const P = tok(300);
    const stored = { [LINK]: { trustEarned: true, trustEvaluatedAt: ago(23) }, [P]: { trustEarned: true, trustEvaluatedAt: ago(1) } };
    const combined = setup({ earners: [LINK, P], config: { ...LATEST, tokenTrustMode: 'combined' }, stored });
    await combined.svc.prefetchConsensus(1, [LINK, P], run(combined.svc, { verdict: 1 }));
    expect(combined.asked).toEqual([P]);
    const shadow = setup({ earners: [LINK, P], config: LATEST, stored });
    await shadow.svc.prefetchConsensus(1, [LINK, P], run(shadow.svc, { verdict: 1 }));
    expect(shadow.asked).toEqual([LINK]);
  });

  it('tokens the stored state cannot tell apart take turns from run to run (when this process last asked), not the same first ones every time', async () => {
    const P = Array.from({ length: 6 }, (_, i) => tok(400 + i));
    const s = setup({ earners: P, config: LATEST, answer: () => null }); // failed: nothing cached, nothing stored
    await s.svc.prefetchConsensus(1, P, run(s.svc, { verdict: 3 }));
    expect(s.asked).toEqual(P.slice(0, 3));
    await s.svc.prefetchConsensus(1, P, run(s.svc, { verdict: 3 }));
    expect(s.asked.slice(3)).toEqual(P.slice(3));
  });

  it('an unreadable priority state falls back to batch order (and a lone waiting request reads nothing)', async () => {
    const P = Array.from({ length: 3 }, (_, i) => tok(500 + i));
    const s = setup({ earners: P, config: LATEST });
    s.findLookupPriority.mockRejectedValueOnce(new Error('mongo down'));
    await s.svc.prefetchConsensus(1, P, run(s.svc, { verdict: 2 }));
    expect(s.asked).toEqual(P.slice(0, 2));
    const one = setup({ earners: [tok(510)], config: LATEST });
    await one.svc.prefetchConsensus(1, [tok(510)], run(one.svc, { verdict: 1 }));
    expect(one.findLookupPriority).not.toHaveBeenCalled();
    expect(one.earned()).toEqual([tok(510)]);
  });
});

describe("per-chain: the served re-checks go out in priority order", () => {
  it('a token an earlier re-check rescued (stored dexActive:true) is re-checked first, then one never judged; stored false last', async () => {
    const F = Array.from({ length: 6 }, (_, i) => tok(600 + i));
    const s = setup({
      floorFailing: F,
      config: PER_CHAIN_SERVED_ONLY,
      stored: { ...Object.fromEntries(F.slice(0, 4).map((a) => [a, { dexActive: false }])), [F[5]!]: { dexActive: true } },
    });
    await s.svc.prefetchConsensus(1, F, run(s.svc, { served: 2 }));
    expect(s.asked).toEqual([F[5], F[4]]);
    // The rescued token keeps its served true instead of having false baked over it every time its answer expired.
    expect(s.record(F[5]!)).toMatchObject({ dexActive: true, dexVolume24h: 9_000, dexCounterLiquidity: 50_000 });
    expect(s.record(F[4]!)).toMatchObject({ dexActive: true });
    for (const a of F.slice(0, 4)) expect(s.record(a)).toMatchObject({ dexActive: false });
  });

  it('stored false: they take turns run to run, so a real token among dead ones is reached', async () => {
    const F = Array.from({ length: 4 }, (_, i) => tok(700 + i));
    const s = setup({ floorFailing: F, config: PER_CHAIN_SERVED_ONLY, stored: Object.fromEntries(F.map((a) => [a, { dexActive: false }])), answer: () => null });
    await s.svc.prefetchConsensus(1, F, run(s.svc, { served: 2 }));
    await s.svc.prefetchConsensus(1, F, run(s.svc, { served: 2 }));
    expect(s.asked).toEqual([F[0], F[1], F[2], F[3]]);
  });
});

describe('the two kinds take turns on the shared rate', () => {
  it('a rate that binds before the shares: 6 floor-failing samples first in the batch, 4 earners behind them — 3 requests each, not 6 to the served re-checks', async () => {
    const F = Array.from({ length: 6 }, (_, i) => tok(800 + i));
    const P = Array.from({ length: 4 }, (_, i) => tok(900 + i));
    const s = setup({ floorFailing: F, earners: P, config: PER_CHAIN });
    const bucket = new PairLookupBucket(60, 6, () => 0); // a burst of 6, no refill
    const r = run(s.svc, {}, bucket); // 300 + 300: the shares never bind
    await s.svc.prefetchConsensus(1, [...F, ...P], r);
    expect(s.asked).toEqual([P[0], F[0], P[1], F[1], P[2], F[2]]);
    expect(s.earned()).toEqual(expect.arrayContaining([P[0], P[1], P[2]]));
    expect(s.earned()).not.toContain(P[3]);
    expect(r.pairLookups.sent).toBe(6);
    expect(r.pairLookups.denied).toBeGreaterThan(0);
  });
});
