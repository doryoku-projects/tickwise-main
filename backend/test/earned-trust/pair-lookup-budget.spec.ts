import { afterEach, describe, expect, it, vi } from 'vitest';
import { PricingService, type ConsensusSweepRun } from '../../src/pricing/pricing.service.js';
import {
  PAIR_LOOKUP_BURST,
  PAIR_LOOKUPS_PER_MIN,
  PairLookupBucket,
  RUN_SERVED_LOOKUPS_PER_CHAIN,
  RUN_VERDICT_LOOKUPS,
  batchPairLookupBudget,
  batchShare,
  chargePairLookup,
  processPairLookupBucket,
  runPairLookupBudget,
} from '../../src/pricing/pair-lookup-budget.js';
import { TokenPriceSyncService } from '../../src/sync/token-price-sync.service.js';
import type { TokenPriceRecord, TokenTrustRecord } from '../../src/database/token.repository.js';

/**
 * Prod, 2026-10-06, DEXSCREENER_BATCH_ENDPOINT=per-chain: the pair-lookup
 * budgets were PER 500-TOKEN BATCH (100 earned trust + 100 served re-check), so
 * a chain-1 sweep (~31,000 tokens, 63 batches) could send ~12,600 token-pairs
 * requests against DexScreener's ~300/min. Avalanche's sweeps took 500–990 s
 * with trust 0/…, chains 1 and 4663 never logged a sweep line in 13 h.
 * Now: budgets per sweep RUN, one process-wide token-pairs rate every chain's
 * run shares (an empty bucket = a spent budget, never a wait), and the sweep
 * line says how many requests the run sent.
 */

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'; // anchor (stable)
const tok = (i: number) => `0x${(0xe000 + i).toString(16).padStart(40, '0')}`;

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

const PER_CHAIN = { tokenTrustShadow: 'on', dexscreenerBatchEndpoint: 'per-chain' };
const LATEST = { tokenTrustShadow: 'on' };

function pricing(providers: unknown[], config: Record<string, unknown>) {
  const prices: TokenPriceRecord[] = [];
  const verdicts: TokenTrustRecord[] = [];
  const tokens = {
    findLatestPrices: vi.fn(async () => new Map()),
    upsertPrices: vi.fn(async (_c: number, r: TokenPriceRecord[]) => void prices.push(...r)),
    upsertTrustEvidence: async (_c: number, r: TokenTrustRecord[]) => void verdicts.push(...r),
    clearGuardedPrices: vi.fn(async () => 0),
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
    { isListed: () => false } as never,
    tokens as never,
  );
  return { svc, prices, verdicts };
}

/** A bucket on a frozen clock: what it holds is all a test gets. */
const frozen = (burst: number) => new PairLookupBucket(PAIR_LOOKUPS_PER_MIN, burst, () => 0);
function emptyBucket() {
  const b = frozen(PAIR_LOOKUP_BURST);
  while (b.tryTake());
  return b;
}
const huge = () => new PairLookupBucket(1e9, 1e9);

/**
 * `n` per-chain samples that fail the $50 volume floor on their one pair, with
 * DeFiLlama agreeing on the price ((a)/(d) hold): each one's served dexActive
 * is re-checked, and its verdict turns on (b) — the request the re-check made,
 * or one of earned trust's own once the served budget is out. Every request
 * answers null (failed), so nothing is cached.
 */
function floorFailing(n: number, from = 0) {
  const addrs = Array.from({ length: n }, (_, i) => tok(from + i));
  const getTokenPairs = vi.fn(async () => null);
  const ds = provider('dexscreener', Object.fromEntries(addrs.map((a) => [a, { priceUsd: 2, volume24hUsd: 10, dexPairsComplete: false }])), { getTokenPairs });
  const dl = provider('defillama', Object.fromEntries(addrs.map((a) => [a, { priceUsd: 2 }])));
  return { addrs, ds, dl, getTokenPairs };
}

function sweepService(svc: PricingService, byChain: Record<number, string[]>) {
  const positions = { distinctActiveTokenAddresses: vi.fn(async (chainId: number) => byChain[chainId] ?? []) };
  const sync = new TokenPriceSyncService({ enabledIntegrations: [] } as never, positions as never, svc);
  const log = vi.spyOn((sync as unknown as { logger: { log: (m: string) => void } }).logger, 'log').mockImplementation(() => {});
  const line = (chainId: number) => String(log.mock.calls.map((c) => c[0]).find((m) => String(m).startsWith(`Token-price sweep ${chainId}:`)));
  return { sync, line };
}

/** Every run this service starts draws from `bucket` instead of the process's. */
function withBucket(svc: PricingService, bucket: PairLookupBucket) {
  const start = svc.startConsensusSweep.bind(svc);
  const runs: ConsensusSweepRun[] = [];
  vi.spyOn(svc, 'startConsensusSweep').mockImplementation((opts) => {
    const run = start({ ...opts, bucket });
    runs.push(run);
    return run;
  });
  return runs;
}

const sentOf = (line: string) => Number(/ pairLookups=(\d+) pairDenied=\d+$/.exec(line)?.[1]);
const deniedOf = (line: string) => Number(/ pairDenied=(\d+)$/.exec(line)?.[1]);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('PairLookupBucket: a token bucket that never waits', () => {
  it('starts full at the burst, refills at the rate, never past the burst', () => {
    let now = 1_000_000;
    const b = new PairLookupBucket(60, 10, () => now);
    for (let i = 0; i < 10; i += 1) expect(b.tryTake()).toBe(true);
    expect(b.tryTake()).toBe(false);
    now += 999;
    expect(b.tryTake()).toBe(false); // 0.999 of a token
    now += 1;
    expect(b.tryTake()).toBe(true); // one a second
    expect(b.tryTake()).toBe(false);
    now += 3_600_000; // an idle hour refills the burst, not 3,600
    let taken = 0;
    while (b.tryTake()) taken += 1;
    expect(taken).toBe(10);
  });

  it('a clock that steps back neither refills nor drains it', () => {
    let now = 5_000_000;
    const b = new PairLookupBucket(60, 10, () => now);
    for (let i = 0; i < 5; i += 1) b.tryTake();
    now -= 10_000;
    let taken = 0;
    while (b.tryTake()) taken += 1;
    expect(taken).toBe(5);
    now += 10_000; // back where it was: no time passed for the bucket
    expect(b.tryTake()).toBe(false);
  });

  it('the numbers: 60/min with a burst of 10 — at most 70 lookups in any minute, process-wide (≤ ~23% of DexScreener\'s ~300/min)', () => {
    expect([PAIR_LOOKUPS_PER_MIN, PAIR_LOOKUP_BURST]).toEqual([60, 10]);
    let now = 0;
    const b = new PairLookupBucket(PAIR_LOOKUPS_PER_MIN, PAIR_LOOKUP_BURST, () => now);
    let taken = 0;
    for (; now < 60_000; now += 100) while (b.tryTake()) taken += 1; // asked 10× a second for a minute
    expect(taken).toBe(PAIR_LOOKUP_BURST + 59);
  });
});

describe('chargePairLookup', () => {
  it('a run: a request goes out only with a token of the shared rate AND DexScreener not benched; otherwise nothing is charged', () => {
    const b = frozen(1);
    const share = batchShare(runPairLookupBudget('per-chain', b), 500);
    expect(chargePairLookup(share, 'served', false)).toBe(false); // benched: no token taken either
    expect(share.budget).toMatchObject({ verdictLeft: 300, servedLeft: 300, sent: 0, denied: 1 });
    expect(chargePairLookup(share, 'served', true)).toBe(true);
    expect(share.budget).toMatchObject({ verdictLeft: 300, servedLeft: 299, sent: 1, denied: 1 });
    expect(share).toMatchObject({ verdictLeft: 300, servedLeft: 299 }); // the share is charged with its budget
    expect(chargePairLookup(share, 'verdict', true)).toBe(false); // bucket empty
    expect(share.budget).toMatchObject({ verdictLeft: 300, servedLeft: 299, sent: 1, denied: 2 });
  });

  it('a spent budget refuses without touching the shared rate', () => {
    const b = frozen(1);
    const share = batchShare({ ...runPairLookupBudget('latest', b), verdictLeft: 0 }, 500);
    expect(chargePairLookup(share, 'verdict', true)).toBe(false);
    expect(chargePairLookup(share, 'served', true)).toBe(false); // latest: no served budget
    expect(share.budget.denied).toBe(0);
    expect(b.tryTake()).toBe(true); // its one token is still there
  });

  it('a spent SHARE refuses though the run has budget left (the rest is for later batches)', () => {
    const budget = runPairLookupBudget('latest', huge(), 1000);
    const share = batchShare(budget, 500);
    expect(share.verdictLeft).toBe(150);
    for (let i = 0; i < 150; i += 1) expect(chargePairLookup(share, 'verdict', true)).toBe(true);
    expect(chargePairLookup(share, 'verdict', true)).toBe(false);
    expect(budget).toMatchObject({ verdictLeft: 150, sent: 150, denied: 0 });
  });

  it('a lone call keeps its old rule: charged whether or not the provider will send; only a sendable one counts as sent', () => {
    const budget = batchPairLookupBudget('per-chain');
    expect(budget).toMatchObject({ verdictLeft: 100, servedLeft: 100 });
    expect(budget.bucket).toBeUndefined(); // no shared rate
    const share = batchShare(budget, 500);
    expect(share).toMatchObject({ verdictLeft: 100, servedLeft: 100 }); // not spread: all of it
    expect(chargePairLookup(share, 'verdict', false)).toBe(true);
    expect(chargePairLookup(share, 'verdict', true)).toBe(true);
    expect(budget).toMatchObject({ verdictLeft: 98, sent: 1, denied: 0 });
    expect(batchPairLookupBudget('latest')).toMatchObject({ verdictLeft: 25, servedLeft: 0 });
  });
});

describe('batchShare: a run\'s budget is spread over the tokens its sweep feeds', () => {
  it('pro rata over what is left, rounded up; unspent share rolls on; the last batch may spend everything left', () => {
    const budget = runPairLookupBudget('per-chain', huge(), 1250);
    const first = batchShare(budget, 500);
    expect(first).toMatchObject({ verdictLeft: 120, servedLeft: 120 }); // 300 × 500 / 1250
    budget.verdictLeft -= 20; // the first batch spent 20 of its 120
    const second = batchShare(budget, 500);
    expect(second.verdictLeft).toBe(Math.ceil((280 * 500) / 750)); // 187: the unspent 100 moved on
    budget.verdictLeft -= 187;
    expect(batchShare(budget, 250)).toMatchObject({ verdictLeft: 93, servedLeft: 300 }); // the last batch: all that is left
    expect(budget.tokensLeft).toBe(0);
    // Never more than is left, whatever the rounding.
    const tiny = runPairLookupBudget('latest', huge(), 3);
    tiny.verdictLeft = 1;
    expect(batchShare(tiny, 1).verdictLeft).toBe(1);
    expect(batchShare(tiny, 1).verdictLeft).toBe(1);
  });

  it('more tokens fed than the run was told: a share is never more than is left (no Infinity once nothing is left to feed)', () => {
    const budget = runPairLookupBudget('per-chain', huge(), 500);
    expect(batchShare(budget, 500)).toMatchObject({ verdictLeft: 300, servedLeft: 300 }); // the last announced batch
    expect(batchShare(budget, 500)).toMatchObject({ verdictLeft: 300, servedLeft: 300 }); // one more, unannounced
    expect(batchShare(runPairLookupBudget('latest', huge(), 100), 500)).toMatchObject({ verdictLeft: 300, servedLeft: 0 }); // fed > told
  });

  it('a batch that returns early (nothing to sweep) still moves the run on: the next batch gets what that one did not use', async () => {
    const { addrs, ds, dl, getTokenPairs } = floorFailing(1000, 3000);
    const { svc } = pricing([ds, dl], LATEST);
    const run = svc.startConsensusSweep({ bucket: huge(), tokens: 1000 });
    await svc.prefetchConsensus(999_999, addrs.slice(0, 500), run); // no such chain: nothing swept
    await svc.prefetchConsensus(1, addrs.slice(500), run);
    expect(getTokenPairs).toHaveBeenCalledTimes(RUN_VERDICT_LOOKUPS); // all 300, not 150
  });

  it('a run not told its size is not spread (all one share)', () => {
    const budget = runPairLookupBudget('per-chain', huge());
    expect(budget.tokensLeft).toBeUndefined();
    expect(batchShare(budget, 500)).toMatchObject({ verdictLeft: 300, servedLeft: 300 });
  });
});

describe('startConsensusSweep: per-RUN budgets on ONE process-wide rate', () => {
  it('every run — of any chain, from any PricingService — draws from the same bucket; each has budgets of its own', () => {
    const a = pricing([], PER_CHAIN).svc;
    const b = pricing([], LATEST).svc;
    const [r1, r2, r3] = [a.startConsensusSweep({ tokens: 31_456 }), a.startConsensusSweep(), b.startConsensusSweep()];
    expect(r1.pairLookups.bucket).toBe(processPairLookupBucket());
    expect(r2.pairLookups.bucket).toBe(r1.pairLookups.bucket);
    expect(r3.pairLookups.bucket).toBe(r1.pairLookups.bucket);
    expect(r2.pairLookups).not.toBe(r1.pairLookups);
    // Chain 1 (31,456 tokens, 63 batches): earned trust's floor is latest mode's 25 per batch.
    expect(r1.pairLookups).toMatchObject({ verdictLeft: 25 * 63, servedLeft: RUN_SERVED_LOOKUPS_PER_CHAIN, sent: 0, tokensLeft: 31_456 });
    expect(r3.pairLookups).toMatchObject({ verdictLeft: RUN_VERDICT_LOOKUPS, servedLeft: 0, sent: 0 }); // not told its size
    expect([RUN_VERDICT_LOOKUPS, RUN_SERVED_LOOKUPS_PER_CHAIN]).toEqual([300, 300]);
    // Chain 1, per-chain: ~26 + 5 per 500-token batch.
    expect(batchShare(r1.pairLookups, 500)).toMatchObject({ verdictLeft: 26, servedLeft: 5 });
  });
});

describe('a 2,000-token per-chain sweep sends at most its RUN budget of token-pairs requests', () => {
  it(
    `600 (${RUN_VERDICT_LOOKUPS} earned trust + ${RUN_SERVED_LOOKUPS_PER_CHAIN} served re-check), spread 150 a batch, not 4 batches × 200 = 800; the sweep line says so`,
    async () => {
      const { addrs, ds, dl, getTokenPairs } = floorFailing(2000);
      const { svc } = pricing([ds, dl], PER_CHAIN);
      const runs = withBucket(svc, huge()); // the run's budget, not the rate, is what binds here
      const { sync, line } = sweepService(svc, { 1: addrs });
      await sync.syncChain(1, 'uniswap-v4');
      expect(runs).toHaveLength(1); // one run for the whole sweep
      expect(getTokenPairs).toHaveBeenCalledTimes(RUN_VERDICT_LOOKUPS + RUN_SERVED_LOOKUPS_PER_CHAIN);
      expect(runs[0]!.pairLookups).toMatchObject({ verdictLeft: 0, servedLeft: 0, sent: 600 });
      // Spread over the run: the LAST batch gets its share like the first.
      const perBatch = [0, 0, 0, 0];
      for (const c of getTokenPairs.mock.calls as unknown as Array<[number, string]>) perBatch[Math.floor(addrs.indexOf(c[1]) / 500)]! += 1;
      expect(perBatch).toEqual([150, 150, 150, 150]);
      expect(line(1)).toMatch(/^Token-price sweep 1:uniswap-v4 fed=2000\/2000 durationMs=\d+ trust=0\/0 unknown=2000 quoteGuard\{rejected=0 cleared=0\} pairLookups=600 pairDenied=0$/);

      // The same four batches as lone calls (no run): the old per-batch budgets.
      const old = floorFailing(2000);
      const lone = pricing([old.ds, old.dl], PER_CHAIN).svc;
      for (let i = 0; i < 2000; i += 500) await lone.prefetchConsensus(1, old.addrs.slice(i, i + 500));
      expect(old.getTokenPairs).toHaveBeenCalledTimes(800);
    },
    20_000,
  );
});

describe('the sweep line prints pairLookups= only when a batch could look pairs up', () => {
  for (const [mode, config, expected] of [
    ['every flag off', {}, /^Token-price sweep 1:uniswap-v4 fed=40\/40 durationMs=\d+$/],
    ['per-chain, trust evidence off (the served re-check looks up)', { dexscreenerBatchEndpoint: 'per-chain' }, /^Token-price sweep 1:uniswap-v4 fed=40\/40 durationMs=\d+ pairLookups=40 pairDenied=0$/],
  ] as const) {
    it(`${mode}`, async () => {
      const { addrs, ds, dl } = floorFailing(40, 7000);
      const { svc } = pricing([ds, dl], config);
      withBucket(svc, huge());
      const { sync, line } = sweepService(svc, { 1: addrs });
      await sync.syncChain(1, 'uniswap-v4');
      expect(line(1)).toMatch(expected);
    });
  }
});

describe('two chains sweeping concurrently share the rate', () => {
  it(
    'a bucket of 10 with no time passing: 10 requests between the two chains, not 10 each',
    async () => {
      const one = floorFailing(1000, 0);
      const avax = floorFailing(1000, 5000);
      const getTokenPairs = vi.fn(async () => null);
      const ds = provider('dexscreener', { ...Object.fromEntries([...one.addrs, ...avax.addrs].map((a) => [a, { priceUsd: 2, volume24hUsd: 10, dexPairsComplete: false }])) }, { getTokenPairs });
      const dl = provider('defillama', Object.fromEntries([...one.addrs, ...avax.addrs].map((a) => [a, { priceUsd: 2 }])));
      const { svc } = pricing([ds, dl], PER_CHAIN);
      const runs = withBucket(svc, frozen(PAIR_LOOKUP_BURST));
      const { sync, line } = sweepService(svc, { 1: one.addrs, 43114: avax.addrs });
      await Promise.all([sync.syncChain(1, 'uniswap-v4'), sync.syncChain(43114, 'uniswap-v4')]);
      expect(runs).toHaveLength(2);
      expect(getTokenPairs).toHaveBeenCalledTimes(PAIR_LOOKUP_BURST);
      const [s1, s2] = [sentOf(line(1)), sentOf(line(43114))];
      expect(s1 + s2).toBe(PAIR_LOOKUP_BURST);
      expect(s1).toBeGreaterThan(0);
      expect(s2).toBeGreaterThan(0);
      // Each run's own budget is barely touched: the shared rate was the limit.
      for (const r of runs) expect(r.pairLookups.denied).toBeGreaterThan(0);
      // …and the sweep line says so: pairDenied is what tells this starved run
      // from one whose answers were all cached (both small pairLookups).
      const deniedByChain = [deniedOf(line(1)), deniedOf(line(43114))];
      expect(deniedByChain.sort()).toEqual(runs.map((r) => r.pairLookups.denied).sort());
      for (const d of deniedByChain) expect(d).toBeGreaterThan(0);
    },
    20_000,
  );
});

describe('an empty bucket is a spent budget: no verdict, the sample\'s rule, never a wait', () => {
  const BTCB = '0xb0f70c0bd6fd87dbeb7c10dc692a2a6106817072';
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

  it('earned trust: a sample that passes on ONE weak pool needs its own pairs for (c) — empty bucket → no request, no verdict, and the call never waits on a timer', async () => {
    const setup = () => {
      const getTokenPairs = vi.fn(async () => twoPools);
      const ds = provider(
        'dexscreener',
        { [BTCB]: { priceUsd: 4, volume24hUsd: 9_000, counterLiquidity: 5_000, counterTokenAddress: USDC, dexPairs: [weak], dexPairsComplete: false } },
        { getTokenPairs },
      );
      return { getTokenPairs, ...pricing([ds, provider('defillama', { [BTCB]: { priceUsd: 4 } })], LATEST) };
    };
    const full = setup();
    await full.svc.prefetchConsensus(1, [BTCB], full.svc.startConsensusSweep({ bucket: frozen(PAIR_LOOKUP_BURST) }));
    expect(full.getTokenPairs).toHaveBeenCalledTimes(1);
    expect(full.verdicts).toEqual([expect.objectContaining({ address: BTCB, trustEarned: true, trustReason: 'earned' })]);

    const empty = setup();
    vi.useFakeTimers(); // any wait on a timer would never resolve
    const run = empty.svc.startConsensusSweep({ bucket: emptyBucket() });
    const stats = await empty.svc.prefetchConsensus(1, [BTCB], run);
    expect(empty.getTokenPairs).not.toHaveBeenCalled();
    expect(empty.verdicts).toEqual([]);
    expect(stats).toMatchObject({ trustVerdicts: 0, trustUnknown: 1 });
    expect(run.pairLookups).toMatchObject({ sent: 0, verdictLeft: RUN_VERDICT_LOOKUPS });
    expect(run.pairLookups.denied).toBeGreaterThan(0);
  });

  it('served re-check (per-chain): empty bucket → the sample\'s dexActive:false stands, exactly as with a spent budget; with a token, its own market rescues it', async () => {
    const T = tok(9000);
    const setup = () => {
      const getTokenPairs = vi.fn(async () => twoPools);
      const ds = provider('dexscreener', { [T]: { priceUsd: 2, volume24hUsd: 10, dexPairsComplete: false } }, { getTokenPairs });
      return { getTokenPairs, ...pricing([ds, provider('defillama', { [T]: { priceUsd: 2 } })], PER_CHAIN) };
    };
    const record = (s: ReturnType<typeof setup>) => s.prices.find((r) => r.address === T);

    const withToken = setup();
    await withToken.svc.prefetchConsensus(1, [T], withToken.svc.startConsensusSweep({ bucket: frozen(PAIR_LOOKUP_BURST) }));
    expect(record(withToken)).toMatchObject({ dexActive: true });

    const empty = setup();
    await empty.svc.prefetchConsensus(1, [T], empty.svc.startConsensusSweep({ bucket: emptyBucket() }));
    const spent = setup();
    const spentRun = spent.svc.startConsensusSweep({ bucket: frozen(PAIR_LOOKUP_BURST) });
    spentRun.pairLookups.verdictLeft = 0;
    spentRun.pairLookups.servedLeft = 0;
    await spent.svc.prefetchConsensus(1, [T], spentRun);
    expect(record(empty)).toMatchObject({ dexActive: false });
    expect(empty.prices).toEqual(spent.prices);
    expect(empty.verdicts).toEqual(spent.verdicts);
    expect(empty.getTokenPairs).not.toHaveBeenCalled();
    expect(spent.getTokenPairs).not.toHaveBeenCalled();
  });

  it('DexScreener benched (its batch call hit a 429): a run sends nothing and charges nothing; a lone call keeps today\'s flow (the provider is asked, and answers as it will)', async () => {
    const T = tok(9100);
    const setup = () => {
      let available = true;
      const getTokenPairs = vi.fn(async () => twoPools);
      const base = provider('dexscreener', { [T]: { priceUsd: 2, volume24hUsd: 10, dexPairsComplete: false } }, { getTokenPairs });
      const ds = {
        ...base,
        isAvailable: () => available,
        getCurrentBatch: vi.fn(async (chainId: number, addrs: string[]) => {
          const out = await base.getCurrentBatch(chainId, addrs);
          available = false;
          return out;
        }),
      };
      return { getTokenPairs, ...pricing([ds, provider('defillama', { [T]: { priceUsd: 2 } })], PER_CHAIN) };
    };
    const inRun = setup();
    const bucket = frozen(PAIR_LOOKUP_BURST);
    const run = inRun.svc.startConsensusSweep({ bucket });
    await inRun.svc.prefetchConsensus(1, [T], run);
    expect(inRun.getTokenPairs).not.toHaveBeenCalled();
    expect(run.pairLookups).toMatchObject({ sent: 0, verdictLeft: RUN_VERDICT_LOOKUPS, servedLeft: RUN_SERVED_LOOKUPS_PER_CHAIN });
    expect(run.pairLookups.denied).toBeGreaterThan(0);
    let left = 0;
    while (bucket.tryTake()) left += 1;
    expect(left).toBe(PAIR_LOOKUP_BURST); // no token spent on a request that could not go out

    const lone = setup();
    await lone.svc.prefetchConsensus(1, [T]);
    expect(lone.getTokenPairs).toHaveBeenCalledTimes(1);
  });
});

// Price records only. The VERDICTS do move with the lookups, and under
// TOKEN_TRUST_MODE=earned / combined (prod: combined) they are served — a
// non-allowlisted token is trusted only while it holds an earned verdict
// < 24 h old — so what the budget and the rate let through changes served
// trust there (`pair-request-order.spec.ts`). Only allowlist mode + shadow,
// this spec's config, keeps them shadow data.
describe('latest mode: served PRICE records are byte-identical whatever the lookups could do', () => {
  it('no run, a run with the rate, an empty rate, a spent budget → the same price records (the verdicts move: shadow here, served in earned / combined mode)', async () => {
    const P = tok(9200); // passes the floors on a capped sample with one weak pool: (c) needs its own pairs
    const F = tok(9201); // fails the $50 floor on a capped sample: (b) checks its own pairs
    const C = tok(9202); // a complete answer: no lookup at all
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
    const setup = () => {
      const getTokenPairs = vi.fn(async () => twoPools);
      const ds = provider(
        'dexscreener',
        {
          [P]: { priceUsd: 4, volume24hUsd: 9_000, counterLiquidity: 5_000, counterTokenAddress: USDC, dexPairs: [weak], dexPairsComplete: false },
          [F]: { priceUsd: 2, volume24hUsd: 10, dexPairs: [weak], dexPairsComplete: false },
          [C]: { priceUsd: 3, volume24hUsd: 9_000, counterLiquidity: 5_000, counterTokenAddress: USDC, dexPairs: twoPools.pairs, dexPairsComplete: true },
        },
        { getTokenPairs },
      );
      const dl = provider('defillama', { [P]: { priceUsd: 4 }, [F]: { priceUsd: 2 }, [C]: { priceUsd: 3 } });
      return { getTokenPairs, ...pricing([ds, dl], LATEST) };
    };
    const scenarios = {
      lone: async (s: ReturnType<typeof setup>) => s.svc.prefetchConsensus(1, [P, F, C]),
      rate: async (s: ReturnType<typeof setup>) => s.svc.prefetchConsensus(1, [P, F, C], s.svc.startConsensusSweep({ bucket: huge() })),
      empty: async (s: ReturnType<typeof setup>) => s.svc.prefetchConsensus(1, [P, F, C], s.svc.startConsensusSweep({ bucket: emptyBucket() })),
      spent: async (s: ReturnType<typeof setup>) => {
        const run = s.svc.startConsensusSweep({ bucket: huge() });
        run.pairLookups.verdictLeft = 0;
        return s.svc.prefetchConsensus(1, [P, F, C], run);
      },
    };
    const out: Record<string, ReturnType<typeof setup>> = {};
    for (const [name, go] of Object.entries(scenarios)) {
      const s = setup();
      await go(s);
      out[name] = s;
    }
    // The lookups really happened where they could, and the verdicts moved with them…
    expect(out.rate!.getTokenPairs).toHaveBeenCalledTimes(2);
    expect(out.lone!.getTokenPairs).toHaveBeenCalledTimes(2);
    expect(out.empty!.getTokenPairs).not.toHaveBeenCalled();
    expect(out.rate!.verdicts.map((v) => [v.address, v.trustReason]).sort()).toEqual([[C, 'earned'], [F, 'earned'], [P, 'earned']].sort());
    expect(out.empty!.verdicts.map((v) => v.address)).toEqual([C]);
    // …while every served record is the same, F's served dexActive:false (latest never re-checks served data) included.
    const served = (name: string) => [...out[name]!.prices].sort((a, b) => (a.address < b.address ? -1 : 1));
    expect(served('lone').find((r) => r.address === F)).toMatchObject({ dexActive: false });
    for (const name of ['rate', 'empty', 'spent']) expect(served(name)).toEqual(served('lone'));
  });
});
