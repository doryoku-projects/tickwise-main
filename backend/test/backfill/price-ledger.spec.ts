/*
 * The external-price miss ledger (`PRICE_MISS_LEDGER=on`, design §6.2-3, D-8)
 * and the cache-only pricing the backfill pipeline normalizes with.
 *
 * What must hold, each pinned below:
 *  - the ladder is 30 min → 1 h → 2 h → 6 h (cap), reset by any positive;
 *  - only a HEALTHY "no price" is a miss: a provider in backoff, rate limited
 *    mid-walk (GeckoTerminal's 429-as-HTTP-200 lands here), erroring or refused
 *    by a budget makes the token UNKNOWN — no entry, asked again as today;
 *  - a held token skips the aggregators ONLY: the pool-derived source
 *    (`subgraph-current`) is still asked, so a token that gains a v4 market is
 *    priced exactly as today;
 *  - entries persist (another process sees them) and a store failure fails open;
 *  - with the flag off nothing changes;
 *  - `cacheOnly` never calls a provider or reads Mongo; `seedLastKnown` reads
 *    the last-known-good ONCE for a range, never per leg.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PRICE_MISS_LADDER_MS,
  PriceMissLedger,
  definiteMisses,
  isPriceMissHeld,
  priceMissHoldMs,
} from '../../src/pricing/price-ledger.js';
import { PricingService } from '../../src/pricing/pricing.service.js';
import { providerAddressKey } from '../../src/pricing/providers/price-provider.interface.js';

const MIN = 60_000;
const CHAIN = 1;
const NOPRICE = '0x00000000000000000000000000000000000000aa';
const PRICED = '0x00000000000000000000000000000000000000bb';
const LATER = '0x00000000000000000000000000000000000000cc';

function memStore() {
  const rows = new Map<string, { at: Date; streak: number }>();
  const store = {
    findPriceMisses: vi.fn(async (chainId: number, addrs: string[]) => {
      const out = new Map<string, { at: Date; streak: number }>();
      for (const a of addrs) {
        const r = rows.get(`${chainId}:${a}`);
        if (r) out.set(a, r);
      }
      return out;
    }),
    // Mirrors `TokensRepository.recordPriceMisses`: the streak climbs only
    // on a row with no live hold at `at` (once per miss episode).
    recordPriceMisses: vi.fn(async (chainId: number, addrs: string[], at: Date) => {
      for (const a of addrs) {
        const k = `${chainId}:${a}`;
        const prev = rows.get(k);
        if (prev && isPriceMissHeld({ missAtMs: prev.at.getTime(), streak: prev.streak }, at.getTime())) continue;
        rows.set(k, { at, streak: (prev?.streak ?? 0) + 1 });
      }
    }),
    clearPriceMisses: vi.fn(async (chainId: number, addrs: string[]) => {
      for (const a of addrs) rows.delete(`${chainId}:${a}`);
    }),
  };
  return { rows, store };
}

describe('the ladder', () => {
  it('is 30 min → 1 h → 2 h → 6 h and caps at 6 h', () => {
    expect(PRICE_MISS_LADDER_MS).toEqual([30 * MIN, 60 * MIN, 120 * MIN, 360 * MIN]);
    expect(priceMissHoldMs(0)).toBe(0);
    expect(priceMissHoldMs(1)).toBe(30 * MIN);
    expect(priceMissHoldMs(2)).toBe(60 * MIN);
    expect(priceMissHoldMs(3)).toBe(120 * MIN);
    expect(priceMissHoldMs(4)).toBe(360 * MIN);
    expect(priceMissHoldMs(40)).toBe(360 * MIN);
  });

  it('holds strictly inside the window', () => {
    const e = { missAtMs: 1_000, streak: 1 };
    expect(isPriceMissHeld(e, 1_000 + 30 * MIN - 1)).toBe(true);
    expect(isPriceMissHeld(e, 1_000 + 30 * MIN)).toBe(false);
    expect(isPriceMissHeld(undefined, 0)).toBe(false);
  });
});

describe('PriceMissLedger', () => {
  it('records a miss, holds it, climbs on the next miss, and a positive clears it', async () => {
    let now = 10 * MIN;
    const { rows, store } = memStore();
    const ledger = new PriceMissLedger(store, () => now);

    await ledger.recordMisses(CHAIN, [NOPRICE]);
    expect(rows.get(`${CHAIN}:${NOPRICE}`)?.streak).toBe(1);
    expect(await ledger.held(CHAIN, [NOPRICE])).toEqual(new Set([NOPRICE]));

    now += 31 * MIN; // past step 1
    expect((await ledger.held(CHAIN, [NOPRICE])).size).toBe(0);
    await ledger.recordMisses(CHAIN, [NOPRICE]);
    expect(rows.get(`${CHAIN}:${NOPRICE}`)?.streak).toBe(2);
    now += 45 * MIN; // inside step 2 (1 h)
    expect(await ledger.held(CHAIN, [NOPRICE])).toEqual(new Set([NOPRICE]));

    await ledger.recordPositives(CHAIN, [NOPRICE]);
    expect(store.clearPriceMisses).toHaveBeenCalledWith(CHAIN, [NOPRICE]);
    expect(rows.has(`${CHAIN}:${NOPRICE}`)).toBe(false);
    expect((await ledger.held(CHAIN, [NOPRICE])).size).toBe(0);
  });

  it('a positive is ALWAYS cleared in the store, even when the local copy says "no entry"', async () => {
    // Process B loaded "no entry" for X; process A then recorded a miss. B
    // prices X: the stored hold must go, or every process (B included, once
    // its 60 s copy lapses) keeps X away from the aggregators for the window.
    let now = 10 * MIN;
    const { rows, store } = memStore();
    const b = new PriceMissLedger(store, () => now);
    expect((await b.held(CHAIN, [NOPRICE])).size).toBe(0);
    await new PriceMissLedger(store, () => now).recordMisses(CHAIN, [NOPRICE]);
    expect(rows.has(`${CHAIN}:${NOPRICE}`)).toBe(true);
    now += 5_000;
    await b.recordPositives(CHAIN, [NOPRICE]);
    expect(store.clearPriceMisses).toHaveBeenCalledWith(CHAIN, [NOPRICE]);
    expect(rows.has(`${CHAIN}:${NOPRICE}`)).toBe(false);
    now += 2 * MIN; // past B's local TTL: a fresh read finds nothing held
    expect((await new PriceMissLedger(store, () => now).held(CHAIN, [NOPRICE])).size).toBe(0);
  });

  it('concurrent askers of one miss episode climb the ladder ONCE', async () => {
    let now = 10 * MIN;
    const { rows, store } = memStore();
    // Two processes, and two walks inside one of them, all see the same miss.
    const p1 = new PriceMissLedger(store, () => now);
    const p2 = new PriceMissLedger(store, () => now + 1_000);
    await p1.recordMisses(CHAIN, [NOPRICE]);
    await p1.recordMisses(CHAIN, [NOPRICE]);
    await p2.recordMisses(CHAIN, [NOPRICE]);
    expect(rows.get(`${CHAIN}:${NOPRICE}`)?.streak).toBe(1);
    expect(p1.isHeldLocally(CHAIN, NOPRICE)).toBe(true);
    now += 31 * MIN;
    // p1's local copy did not climb either: the 30-min step has elapsed.
    expect(p1.isHeldLocally(CHAIN, NOPRICE)).toBe(false);
    expect((await new PriceMissLedger(store, () => now).held(CHAIN, [NOPRICE])).size).toBe(0);
  });

  it('persists: another process (a new ledger on the same store) sees the hold', async () => {
    const now = 5 * MIN;
    const { store } = memStore();
    await new PriceMissLedger(store, () => now).recordMisses(CHAIN, [NOPRICE]);
    const other = new PriceMissLedger(store, () => now + MIN);
    expect(await other.held(CHAIN, [NOPRICE, PRICED])).toEqual(new Set([NOPRICE]));
    expect(store.findPriceMisses).toHaveBeenCalledTimes(1);
  });

  it('a store that throws fails OPEN (nothing held)', async () => {
    const store = {
      findPriceMisses: vi.fn(async () => {
        throw new Error('mongo down');
      }),
      recordPriceMisses: vi.fn(async () => undefined),
      clearPriceMisses: vi.fn(async () => undefined),
    };
    const ledger = new PriceMissLedger(store, () => 0);
    expect((await ledger.held(CHAIN, [NOPRICE])).size).toBe(0);
  });
});

describe('definiteMisses', () => {
  const base = {
    candidates: [NOPRICE, PRICED],
    priced: new Set([PRICED]),
    expectedProviders: ['a', 'b'],
    asked: new Map([
      ['a', new Set([NOPRICE, PRICED])],
      ['b', new Set([NOPRICE])],
    ]),
    unhealthy: new Set<string>(),
  };
  it('a token every expected provider answered healthily for, unpriced, is a miss', () => {
    expect(definiteMisses(base)).toEqual([NOPRICE]);
  });
  it('one unhealthy provider makes it unknown', () => {
    expect(definiteMisses({ ...base, unhealthy: new Set(['b']) })).toEqual([]);
  });
  it('a provider that was never asked about it makes it unknown', () => {
    expect(definiteMisses({ ...base, asked: new Map([['a', new Set([NOPRICE])]]) })).toEqual([]);
  });
  it('no expected provider → nothing is definite', () => {
    expect(definiteMisses({ ...base, expectedProviders: [] })).toEqual([]);
  });
});

// ─── PricingService integration ──────────────────────────────────────────────

type Metrics = { success: number; miss: number; ratelimit: number; error: number; skip: number };

function batchProvider(name: string, prices: Record<string, number>) {
  let available = true;
  let rateLimitOnCall = false;
  const metrics: Metrics = { success: 0, miss: 0, ratelimit: 0, error: 0, skip: 0 };
  const asked: string[][] = [];
  return {
    name,
    supportsCurrentBatch: true,
    supportsHistoricalBatch: false,
    maxBatchSize: 30,
    singleConcurrency: 1,
    defaultBackoffMs: 1_000,
    isEnabled: () => true,
    isAvailable: () => available,
    markBackoff: () => {
      available = false;
    },
    getCurrentBatch: vi.fn(async (chainId: number, addrs: string[]) => {
      asked.push([...addrs]);
      const out = new Map<string, { priceUsd: number }>();
      if (rateLimitOnCall) {
        // GeckoTerminal's 429-as-HTTP-200: an empty answer AND a backoff.
        metrics.ratelimit += 1;
        available = false;
        return out;
      }
      for (const a of addrs) {
        const p = prices[a];
        if (p) out.set(providerAddressKey(chainId, a), { priceUsd: p });
      }
      return out;
    }),
    getCurrentSingle: vi.fn(async () => null),
    getHistoricalSingle: vi.fn(async () => null),
    getMetrics: () => ({ ...metrics }),
    asked,
    setAvailable(v: boolean) {
      available = v;
    },
    rateLimitNext(v: boolean) {
      rateLimitOnCall = v;
    },
    bump(k: keyof Metrics) {
      metrics[k] += 1;
    },
    setPrice(a: string, p: number) {
      prices[a] = p;
    },
  };
}

function tokensStub(store: ReturnType<typeof memStore>['store'], lastKnown = new Map<string, { priceUsd: number; pricedAt: Date }>()) {
  return {
    ...store,
    findLatestPrices: vi.fn(async (_c: number, addrs: string[]) => {
      const out = new Map<string, { priceUsd: number; pricedAt: Date }>();
      for (const a of addrs) {
        const r = lastKnown.get(a);
        if (r) out.set(a, r);
      }
      return out;
    }),
    upsertPrices: vi.fn(async () => undefined),
    findDexMarketState: vi.fn(async () => new Map()),
  };
}

function service(opts: { ledger: 'on' | 'off'; providers: unknown[]; tokens: unknown }) {
  return new PricingService(
    {
      priceFallbackEnabled: true,
      pricingPrefetchChunkConcurrency: 2,
      priceMissLedger: opts.ledger,
      tokenListingGateEnabled: false,
      dexMarketGateEnabled: false,
    } as never,
    {
      findHistoricalNear: async () => null,
      findHistoricalNearMany: async () => new Map(),
      upsertHistorical: async () => undefined,
    } as never,
    {
      currentProviders: () => opts.providers,
      historicalProviders: () => opts.providers,
      getMetricsSnapshot: () => ({}),
    } as never,
    undefined,
    opts.tokens as never,
  );
}

describe('PricingService.prefetchPrices with the ledger', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-04T00:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it('records a healthy miss, then skips the aggregators for it — but still asks subgraph-current', async () => {
    const { rows, store } = memStore();
    const agg = batchProvider('defillama', { [PRICED]: 1 });
    const sub = batchProvider('subgraph-current', {});
    const svc = service({ ledger: 'on', providers: [agg, sub], tokens: tokensStub(store) });

    await svc.prefetchPrices(CHAIN, [NOPRICE, PRICED]);
    expect(rows.get(`${CHAIN}:${NOPRICE}`)?.streak).toBe(1);
    expect(rows.has(`${CHAIN}:${PRICED}`)).toBe(false);

    vi.advanceTimersByTime(MIN); // past the 45 s miss cache, inside the 30 min hold
    agg.asked.length = 0;
    sub.asked.length = 0;
    await svc.prefetchPrices(CHAIN, [NOPRICE]);
    expect(agg.asked.flat()).not.toContain(NOPRICE);
    // pass 2 (pool-derived) is never subject to the ledger
    expect(sub.asked.flat()).toContain(NOPRICE);
    expect(svc.pricingWalkStats().ledger.skips).toBe(1);
  });

  it('asks again once the step elapses; a second miss climbs the ladder', async () => {
    const { rows, store } = memStore();
    const agg = batchProvider('defillama', {});
    const svc = service({ ledger: 'on', providers: [agg], tokens: tokensStub(store) });
    await svc.prefetchPrices(CHAIN, [NOPRICE]);
    vi.advanceTimersByTime(31 * MIN);
    agg.asked.length = 0;
    await svc.prefetchPrices(CHAIN, [NOPRICE]);
    expect(agg.asked.flat()).toContain(NOPRICE);
    expect(rows.get(`${CHAIN}:${NOPRICE}`)?.streak).toBe(2);
  });

  it('a 429-as-200 (empty answer + backoff) is UNKNOWN: no ledger entry', async () => {
    const { store } = memStore();
    const agg = batchProvider('geckoterminal', {});
    agg.rateLimitNext(true);
    const svc = service({ ledger: 'on', providers: [agg], tokens: tokensStub(store) });
    await svc.prefetchPrices(CHAIN, [NOPRICE]);
    expect(store.recordPriceMisses).not.toHaveBeenCalled();
  });

  it('a rate limit whose backoff already lapsed still makes the walk UNKNOWN', async () => {
    const { store } = memStore();
    const agg = batchProvider('geckoterminal', {});
    agg.rateLimitNext(true);
    agg.getCurrentBatch.mockImplementationOnce(async () => {
      // the outcome is counted, but the (tiny) backoff is over by the time the walk looks
      agg.rateLimitNext(false);
      (agg as unknown as { bump: (k: keyof Metrics) => void }).bump('ratelimit');
      return new Map();
    });
    const svc = service({ ledger: 'on', providers: [agg], tokens: tokensStub(store) });
    await svc.prefetchPrices(CHAIN, [NOPRICE]);
    expect(agg.isAvailable()).toBe(true);
    expect(store.recordPriceMisses).not.toHaveBeenCalled();
  });

  it('a refused budget (skip) or an error answer makes the walk UNKNOWN', async () => {
    for (const kind of ['skip', 'error'] as const) {
      const { store } = memStore();
      const agg = batchProvider('geckoterminal', {});
      agg.getCurrentBatch.mockImplementationOnce(async () => {
        (agg as unknown as { bump: (k: keyof Metrics) => void }).bump(kind);
        return new Map();
      });
      const svc = service({ ledger: 'on', providers: [agg], tokens: tokensStub(store) });
      await svc.prefetchPrices(CHAIN, [NOPRICE]);
      expect(store.recordPriceMisses).not.toHaveBeenCalled();
    }
  });

  it('a provider in backoff at the start makes every unpriced token UNKNOWN', async () => {
    const { store } = memStore();
    const healthy = batchProvider('defillama', {});
    const limited = batchProvider('geckoterminal', {});
    limited.setAvailable(false);
    const svc = service({ ledger: 'on', providers: [healthy, limited], tokens: tokensStub(store) });
    await svc.prefetchPrices(CHAIN, [NOPRICE]);
    expect(store.recordPriceMisses).not.toHaveBeenCalled();
  });

  it('a positive clears the entry (the next window does not wait out the ladder)', async () => {
    const { rows, store } = memStore();
    const agg = batchProvider('defillama', {});
    const svc = service({ ledger: 'on', providers: [agg], tokens: tokensStub(store) });
    await svc.prefetchPrices(CHAIN, [LATER]);
    expect(rows.get(`${CHAIN}:${LATER}`)?.streak).toBe(1);
    vi.advanceTimersByTime(31 * MIN);
    agg.setPrice(LATER, 2.5);
    await svc.prefetchPrices(CHAIN, [LATER]);
    expect(store.clearPriceMisses).toHaveBeenCalledWith(CHAIN, [LATER]);
    expect(rows.has(`${CHAIN}:${LATER}`)).toBe(false);
  });

  it('a held token still asks single-only aggregators on the single-token path (they never voted)', async () => {
    const { store } = memStore();
    const agg = batchProvider('defillama', {});
    // DIA-like: no batch endpoint, so prefetchPrices never asks it and it has
    // no part in the miss verdict.
    const dia = {
      ...batchProvider('dia', {}),
      supportsCurrentBatch: false,
      getCurrentBatch: undefined,
      getCurrentSingle: vi.fn(async (_c: number, a: string) => (a === NOPRICE ? { priceUsd: 0.5 } : null)),
    };
    const svc = service({ ledger: 'on', providers: [agg, dia], tokens: tokensStub(store) });
    await svc.prefetchPrices(CHAIN, [NOPRICE]);
    vi.advanceTimersByTime(MIN); // miss cache lapsed, ledger hold live
    const r = await svc.pricePool({
      chainId: CHAIN,
      protocol: 'uniswap-v4',
      token0: { address: PRICED, decimals: 18, symbol: 'P' },
      token1: { address: NOPRICE, decimals: 18, symbol: 'N' },
      sqrtPriceX96: '79228162514264337593543950336',
      tick: 0,
    } as never);
    expect(dia.getCurrentSingle).toHaveBeenCalledWith(CHAIN, NOPRICE);
    // the batch aggregator that DID answer "no price" is not re-asked
    expect(agg.getCurrentSingle.mock.calls.map((c) => c[1])).not.toContain(NOPRICE);
    expect(r.token1Usd).toBe(0.5);
  });

  it('flag off: no ledger read or write, every expired miss is asked again (today)', async () => {
    const { store } = memStore();
    const agg = batchProvider('defillama', {});
    const svc = service({ ledger: 'off', providers: [agg], tokens: tokensStub(store) });
    await svc.prefetchPrices(CHAIN, [NOPRICE]);
    vi.advanceTimersByTime(MIN);
    await svc.prefetchPrices(CHAIN, [NOPRICE]);
    expect(agg.asked.flat().filter((a) => a === NOPRICE)).toHaveLength(2);
    expect(store.findPriceMisses).not.toHaveBeenCalled();
    expect(store.recordPriceMisses).not.toHaveBeenCalled();
  });
});

describe('cache-only pricing (the backfill pipeline)', () => {
  const POOL = {
    chainId: CHAIN,
    protocol: 'uniswap-v4',
    token0: { address: PRICED, decimals: 18, symbol: 'P' },
    token1: { address: NOPRICE, decimals: 18, symbol: 'N' },
    sqrtPriceX96: '79228162514264337593543950336',
    tick: 0,
  };

  it('never calls a provider or Mongo; an absent token prices 0 and is counted', async () => {
    const { store } = memStore();
    const tokens = tokensStub(store);
    const agg = batchProvider('defillama', { [PRICED]: 3 });
    const svc = service({ ledger: 'off', providers: [agg], tokens });
    const r = await svc.pricePool(POOL, { cacheOnly: true });
    expect(r.token0Usd).toBe(0);
    expect(agg.getCurrentSingle).not.toHaveBeenCalled();
    expect(agg.getCurrentBatch).not.toHaveBeenCalled();
    expect(tokens.findLatestPrices).not.toHaveBeenCalled();
    expect(svc.pricingWalkStats().cacheOnlyMisses).toBeGreaterThanOrEqual(2);
  });

  it('serves a prefetched price, even after its TTL', async () => {
    vi.useFakeTimers();
    try {
      const { store } = memStore();
      const agg = batchProvider('defillama', { [PRICED]: 3 });
      const svc = service({ ledger: 'off', providers: [agg], tokens: tokensStub(store) });
      await svc.prefetchPrices(CHAIN, [PRICED]);
      vi.advanceTimersByTime(10 * MIN); // the 5 min positive TTL has passed
      const r = await svc.pricePool(POOL, { cacheOnly: true });
      expect(r.token0Usd).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('seedLastKnown resolves the range with ONE read, and only for tokens without a price', async () => {
    const { store } = memStore();
    const fresh = new Date();
    const tokens = tokensStub(store, new Map([[NOPRICE, { priceUsd: 7, pricedAt: fresh }]]));
    const agg = batchProvider('defillama', { [PRICED]: 3 });
    const svc = service({ ledger: 'off', providers: [agg], tokens });
    await svc.prefetchPrices(CHAIN, [PRICED]);
    tokens.findLatestPrices.mockClear();
    expect(await svc.seedLastKnown(CHAIN, [PRICED, NOPRICE, NOPRICE])).toBe(1);
    expect(tokens.findLatestPrices).toHaveBeenCalledTimes(1);
    expect(tokens.findLatestPrices.mock.calls[0]?.[1]).toEqual([NOPRICE]);
    const r = await svc.pricePool(POOL, { cacheOnly: true });
    expect(r.token1Usd).toBe(7);
  });
});
