import { describe, expect, it, vi } from 'vitest';
import type { GraphQLClient } from 'graphql-request';
import { EnvioAdapter } from '../src/subgraph/adapters/envio.adapter.js';
import { requestWithRetry } from '../src/subgraph/request-retry.js';

/*
 * The classification that matters here is the SHAPE, not the wording: an upstream
 * failure that arrives as HTTP **200** carrying a GraphQL `errors[]` body, which
 * every status-code check misses. Two literals are pinned because two upstreams
 * produce it — the legacy Graph-gateway cohort flap, and the indexer's own
 * rate limiter.
 */
function transientUpstreamError(message: string): Error {
  const err = new Error(message);
  (err as unknown as { response: { status: number } }).response = { status: 200 };
  return err;
}

const BAD_INDEXERS =
  'bad indexers: {0x2f09092aacd80196fc984908c5a9a7ab3ee4f1ce: BadResponse(400), 0xedca8740873152ff30a2696add66d1ab41882beb: Unavailable(too far behind)}';

function clientThatRequests(request: ReturnType<typeof vi.fn>): GraphQLClient {
  return { request } as unknown as GraphQLClient;
}

describe('requestWithRetry — transient upstream classification', () => {
  it('retries an HTTP-200 transient error and succeeds on a later attempt', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(transientUpstreamError(BAD_INDEXERS))
      .mockRejectedValueOnce(transientUpstreamError(BAD_INDEXERS))
      .mockResolvedValueOnce({ pools: [] });

    const result = await requestWithRetry(clientThatRequests(request), 'query {}');

    expect(request).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ pools: [] });
  });

  /*
   * Rate limiting is retried on its STATUS (429) and not on its message.
   *
   * The indexer returns it as a real 429, so the status test already covers it.
   * Matching the literal as well would also catch a 200-bodied variant — and this
   * helper sits on the metered /v1 detail route via `fetchPositionTransactions`,
   * where it would turn a sub-second degrade into ~3.5s of backoff and add load
   * to an endpoint that is already shedding.
   */
  it('retries a 429 rate limit, but does NOT retry the same wording at HTTP 200', async () => {
    const rateLimited = new Error('indexer is rate limiting');
    (rateLimited as unknown as { response: { status: number } }).response = { status: 429 };
    const onStatus = vi.fn().mockRejectedValueOnce(rateLimited).mockResolvedValueOnce({ pools: [] });
    await requestWithRetry(clientThatRequests(onStatus), 'query {}');
    expect(onStatus).toHaveBeenCalledTimes(2);

    const onBody = vi.fn().mockRejectedValue(transientUpstreamError('indexer is rate limiting'));
    await expect(requestWithRetry(clientThatRequests(onBody), 'query {}')).rejects.toThrow(
      /rate limiting/,
    );
    expect(onBody).toHaveBeenCalledTimes(1);
  });

  it('gives up after the attempt cap when the upstream never recovers', async () => {
    const request = vi.fn().mockRejectedValue(transientUpstreamError(BAD_INDEXERS));

    await expect(requestWithRetry(clientThatRequests(request), 'query {}')).rejects.toThrow(
      /bad indexers/,
    );
    // Default INDEXER_RETRY_ATTEMPTS = 4.
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('does not retry a genuine (non-transient) GraphQL error', async () => {
    const request = vi.fn().mockRejectedValue(new Error('Cannot query field "foo" on type "Pool"'));

    await expect(requestWithRetry(clientThatRequests(request), 'query {}')).rejects.toThrow(
      /Cannot query field/,
    );
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('fetchPoolStats — last-good fallback', () => {
  const POOL_ID = '0xABCDEF0000000000000000000000000000000000000000000000000000000001';
  const cachedPool = {
    poolId: POOL_ID.toLowerCase(),
    metrics: {
      tvlUsd: 12345.6,
      tvlToken0: 4000,
      tvlToken1: 8345.6,
      volumeUsd24h: 789,
      feesUsd24h: 12,
      volumeUsdTotal: 555000,
      feesUsdTotal: 1200,
    },
  };

  function makeAdapter(findByIds: ReturnType<typeof vi.fn>) {
    const adapter = new EnvioAdapter(
      {} as never, // PricingService — unused by this method
      { findByIds } as never, // PoolsRepository
      { minRealMarketBackingUsd: 1000 } as never, // AppConfigService
    );
    const warn = vi.spyOn((adapter as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => {});
    const debug = vi
      .spyOn((adapter as unknown as { logger: { debug: () => void } }).logger, 'debug')
      .mockImplementation(() => {});
    return { adapter, warn, debug };
  }

  type FetchFn = (
    client: GraphQLClient,
    ids: string[],
    chainId: number,
    protocol: string,
  ) => Promise<Map<string, { totalValueLockedUSD?: string; volumeUSD?: string; feesUSD?: string }>>;

  function callFetch(adapter: EnvioAdapter, client: GraphQLClient) {
    return (adapter as unknown as { fetchPoolStats: FetchFn }).fetchPoolStats(
      client,
      [POOL_ID],
      1,
      'uniswap-v4',
    );
  }

  // The client used to be nullable (positions on Ponder, stats on a separate
  // subgraph that a chain might not have). With one indexer it is always present,
  // so the "no stats available live" case is now a SUCCESSFUL fetch that simply
  // does not cover the pool — which must still fall through to the cache, and
  // must NOT warn, because nothing failed.
  it('synthesizes stats from the pools collection when the live fetch does not cover the pool', async () => {
    const findByIds = vi.fn().mockResolvedValue([cachedPool]);
    const { adapter, warn, debug } = makeAdapter(findByIds);
    const client = clientThatRequests(vi.fn().mockResolvedValue({ pools: [] }));

    const out = await callFetch(adapter, client);

    expect(findByIds).toHaveBeenCalledWith(1, 'uniswap-v4', [POOL_ID]);
    expect(out.get(POOL_ID.toLowerCase())).toEqual({
      id: cachedPool.poolId,
      totalValueLockedUSD: '12345.6',
      totalValueLockedUSDUntracked: '0',
      // Reserves ride along so the quoteless-leg realizability backing stays
      // alive during a live-fetch outage (pre-2026-06 rows lack them → '0').
      totalValueLockedToken0: '4000',
      totalValueLockedToken1: '8345.6',
      // Lifetime-cumulative totals — NOT the 24h window (which silently
      // shrank volume/fees ~1000x while a fallback was active).
      volumeUSD: '555000',
      feesUSD: '1200',
    });
    expect(warn).not.toHaveBeenCalled();
    expect(debug).not.toHaveBeenCalled();
  });

  it('omits volume/fees (not the 24h window) for legacy cached rows without lifetime totals', async () => {
    const legacyPool = {
      poolId: POOL_ID.toLowerCase(),
      metrics: { tvlUsd: 12345.6, tvlToken0: 4000, tvlToken1: 8345.6, volumeUsd24h: 789, feesUsd24h: 12 },
    };
    const findByIds = vi.fn().mockResolvedValue([legacyPool]);
    const { adapter } = makeAdapter(findByIds);
    const client = clientThatRequests(vi.fn().mockResolvedValue({ pools: [] }));

    const out = await callFetch(adapter, client);

    const stats = out.get(POOL_ID.toLowerCase());
    expect(stats?.volumeUSD).toBeUndefined();
    expect(stats?.feesUSD).toBeUndefined();
    expect(stats?.totalValueLockedUSD).toBe('12345.6');
  });

  it('warns once when the live fetch fails AND the fallback is empty', async () => {
    const findByIds = vi.fn().mockResolvedValue([]);
    const { adapter, warn } = makeAdapter(findByIds);
    // Non-retriable error → fails immediately (no retry delay), liveErr is set.
    const client = clientThatRequests(vi.fn().mockRejectedValue(new Error('boom')));

    const out = await callFetch(adapter, client);

    expect(out.size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/missing from last-good cache/);
  });

  it('serves cache without a WARN when the live fetch fails but the fallback covers', async () => {
    const findByIds = vi.fn().mockResolvedValue([cachedPool]);
    const { adapter, warn, debug } = makeAdapter(findByIds);
    const client = clientThatRequests(vi.fn().mockRejectedValue(new Error('boom')));

    const out = await callFetch(adapter, client);

    expect(out.get(POOL_ID.toLowerCase())?.totalValueLockedUSD).toBe('12345.6');
    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledTimes(1);
  });
});
