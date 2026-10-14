/*
 * `TokenPriceCache` (scale plan 1.6): the pools read path's leg prices, fresh
 * 30 s + 15 s stale-while-revalidate, batched single-flight secondary reads,
 * an LRU bound, and fail-open — replacing an uncached PRIMARY `$in` per pools
 * request.
 */
import { describe, expect, it, vi } from 'vitest';
import { PoolsService } from '../src/pools/pools.service.js';
import {
  TOKEN_PRICE_FAILURE_BACKOFF_MS,
  TOKEN_PRICE_FRESH_MS,
  TOKEN_PRICE_MAX_AGE_MS,
  TOKEN_PRICE_MAX_ENTRIES,
  TOKEN_PRICE_READ_MAX_TIME_MS,
  TokenPriceCache,
} from '../src/pools/token-price-cache.js';

function makeCache(prices: Record<string, number> = {}) {
  let now = 1_000_000;
  const reads: Array<{ chainId: number; addresses: string[]; maxTimeMS: number }> = [];
  const tokens = {
    findLatestPricesForRead: vi.fn(async (chainId: number, addresses: string[], maxTimeMS: number) => {
      reads.push({ chainId, addresses: [...addresses], maxTimeMS });
      const out = new Map<string, { priceUsd: number }>();
      for (const a of addresses) if (prices[a] !== undefined) out.set(a, { priceUsd: prices[a]! });
      return out;
    }),
  };
  const cache = new TokenPriceCache(tokens as never, () => now);
  (cache as unknown as { logger: unknown }).logger = { warn: () => {} };
  return { cache, tokens, reads, advance: (ms: number) => (now += ms) };
}

const ask = (entries: Array<[number, string[]]>) => new Map(entries.map(([c, a]) => [c, new Set(a)]));

describe('TokenPriceCache', () => {
  it('a miss is one batched read per chain, with the 1 s budget; the answer is keyed chain:address (lowercased)', async () => {
    const { cache, reads } = makeCache({ '0xa': 1, '0xb': 2, '0xc': 3 });
    const out = await cache.prices(ask([[1, ['0xA', '0xb']], [42161, ['0xc']]]));
    expect(out).toEqual(new Map([['1:0xa', 1], ['1:0xb', 2], ['42161:0xc', 3]]));
    expect(reads).toEqual([
      { chainId: 1, addresses: ['0xa', '0xb'], maxTimeMS: TOKEN_PRICE_READ_MAX_TIME_MS },
      { chainId: 42161, addresses: ['0xc'], maxTimeMS: TOKEN_PRICE_READ_MAX_TIME_MS },
    ]);
  });

  it('concurrent requests in the same tick share ONE read per chain (batched single-flight)', async () => {
    const { cache, reads } = makeCache({ '0xa': 1, '0xb': 2 });
    const [one, two] = await Promise.all([cache.prices(ask([[1, ['0xa']]])), cache.prices(ask([[1, ['0xa', '0xb']]]))]);
    expect(reads).toHaveLength(1);
    expect(reads[0]!.addresses.sort()).toEqual(['0xa', '0xb']);
    expect(one.get('1:0xa')).toBe(1);
    expect(two.get('1:0xb')).toBe(2);
  });

  it('a request for an address ALREADY being read waits for that read instead of starting another', async () => {
    const { cache, reads, tokens } = makeCache({ '0xa': 1 });
    let release!: () => void;
    tokens.findLatestPricesForRead.mockImplementationOnce(async (chainId: number, addresses: string[]) => {
      reads.push({ chainId, addresses, maxTimeMS: 0 });
      await new Promise<void>((r) => (release = r));
      return new Map([['0xa', { priceUsd: 1 }]]);
    });
    const first = cache.prices(ask([[1, ['0xa']]]));
    await Promise.resolve();
    await Promise.resolve();
    const second = cache.prices(ask([[1, ['0xa']]]));
    release();
    expect((await first).get('1:0xa')).toBe(1);
    expect((await second).get('1:0xa')).toBe(1);
    expect(reads).toHaveLength(1);
  });

  it('fresh for 30 s (no read), then served stale up to 45 s with ONE background read, then a miss', async () => {
    const { cache, reads, advance } = makeCache({ '0xa': 1 });
    await cache.prices(ask([[1, ['0xa']]]));
    advance(TOKEN_PRICE_FRESH_MS - 1);
    expect((await cache.prices(ask([[1, ['0xa']]]))).get('1:0xa')).toBe(1);
    expect(reads).toHaveLength(1);
    advance(1); // 30 s: stale
    const stale = await cache.prices(ask([[1, ['0xa']]]));
    expect(stale.get('1:0xa')).toBe(1); // served at once …
    await vi.waitFor(() => expect(reads).toHaveLength(2)); // … and refreshed in the background
    const loading = (cache as unknown as { loading: Map<string, unknown> }).loading;
    await vi.waitFor(() => expect(loading.size).toBe(0));
    advance(TOKEN_PRICE_MAX_AGE_MS); // older than the budget: a miss, waited for
    await cache.prices(ask([[1, ['0xa']]]));
    expect(reads).toHaveLength(3);
  });

  it('a STALE price is answered at once even while its refresh hangs (never waited on)', async () => {
    const { cache, tokens, advance } = makeCache({ '0xa': 1 });
    await cache.prices(ask([[1, ['0xa']]]));
    advance(TOKEN_PRICE_FRESH_MS + 1);
    tokens.findLatestPricesForRead.mockImplementationOnce(() => new Promise(() => {}));
    const answer = await Promise.race([
      cache.prices(ask([[1, ['0xa']]])),
      new Promise<'waited'>((r) => setTimeout(() => r('waited'), 50)),
    ]);
    expect(answer).toEqual(new Map([['1:0xa', 1]]));
  });

  it('a token with no stored price is cached as "none" (no read per request) and absent from the answer', async () => {
    const { cache, reads } = makeCache({});
    expect((await cache.prices(ask([[1, ['0xdead']]]))).size).toBe(0);
    expect((await cache.prices(ask([[1, ['0xdead']]]))).size).toBe(0);
    expect(reads).toHaveLength(1);
  });

  it('fails OPEN: a failed read leaves the misses unpriced and holds that chain back for 5 s', async () => {
    const { cache, tokens, reads, advance } = makeCache({ '0xa': 1 });
    tokens.findLatestPricesForRead.mockRejectedValueOnce(new Error('secondary down'));
    expect((await cache.prices(ask([[1, ['0xa']]]))).size).toBe(0);
    expect((await cache.prices(ask([[1, ['0xa']]]))).size).toBe(0);
    expect(tokens.findLatestPricesForRead).toHaveBeenCalledTimes(1);
    advance(TOKEN_PRICE_FAILURE_BACKOFF_MS);
    expect((await cache.prices(ask([[1, ['0xa']]]))).get('1:0xa')).toBe(1);
    expect(reads).toHaveLength(1); // the failed call threw before recording
    const none = new TokenPriceCache(undefined);
    (none as unknown as { logger: unknown }).logger = { warn: () => {} };
    await expect(none.prices(ask([[1, ['0xa']]]))).resolves.toEqual(new Map());
  });

  it(`keeps at most ${TOKEN_PRICE_MAX_ENTRIES} addresses, least recently used out first`, async () => {
    const { cache } = makeCache({});
    const entries = (cache as unknown as { entries: Map<string, unknown> }).entries;
    const many = Array.from({ length: TOKEN_PRICE_MAX_ENTRIES + 10 }, (_, i) => `0x${i.toString(16)}`);
    await cache.prices(ask([[1, many]]));
    expect(entries.size).toBe(TOKEN_PRICE_MAX_ENTRIES);
    expect(entries.has('1:0x0')).toBe(false);
    expect(entries.has(`1:${many.at(-1)}`)).toBe(true);
  });
});

describe('PoolsService prices pools through the cache', () => {
  it('two list requests within 30 s cost ONE secondary price read and none on the primary method', async () => {
    const pool = {
      chainId: 1,
      protocol: 'uniswap-v4',
      poolId: '0xpool',
      token0: { address: '0xA', symbol: 'A', decimals: 18 },
      token1: { address: '0xb', symbol: 'B', decimals: 6 },
      fee: 500,
      metrics: {},
      pricing: { source: 'x', usedFallback: false },
    };
    const config = { isSupportedChain: () => true, isSupportedProtocol: () => true, enabledIntegrations: [], leaderboardCountCap: 25_000 };
    const pools = { findPoolsLeaderboard: async () => ({ pools: [pool], hasMore: false, cache: 'hit', total: 1 }) };
    const positions = { countsByPoolIds: async () => new Map() };
    const tokens = {
      findLatestPrices: vi.fn(async () => new Map()),
      findLatestPricesForRead: vi.fn(async () => new Map([['0xa', { priceUsd: 2 }], ['0xb', { priceUsd: 1 }]])),
    };
    const svc = new PoolsService(config as never, pools as never, positions as never, tokens as never);
    const first = await svc.getTopPools({ chainId: 1, protocol: 'uniswap-v4' } as never);
    await svc.getTopPools({ chainId: 1, protocol: 'uniswap-v4' } as never);
    expect(tokens.findLatestPricesForRead).toHaveBeenCalledTimes(1);
    expect(tokens.findLatestPrices).not.toHaveBeenCalled();
    expect(first.pools[0]!.token0.priceUsd).toBe(2);
    expect(first.pools[0]!.token1.priceUsd).toBe(1);
  });
});
