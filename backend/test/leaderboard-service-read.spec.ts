import { describe, expect, it, vi } from 'vitest';
import { withReadHeaders } from '../src/common/cache/read-headers.js';
import { QueryTimeoutException } from '../src/database/user-read.js';
import { LeaderboardCountService } from '../src/leaderboard/count-cache.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';

const CHAIN = 1;
const PROTO = 'uniswap-v4';

/**
 * A stored position as Mongo holds it TODAY: every internal field, Mongoose's
 * subdocument `_id`s, and the figures that make the valuation guard accept it.
 */
function storedPosition() {
  return {
    _id: 'oid-doc',
    __v: 0,
    chainId: CHAIN,
    protocol: PROTO,
    positionId: '3468131',
    tokenId: '3468131',
    owner: '0xowner',
    poolId: '0xpool',
    token0: { _id: 'oid-t0', address: '0xaaa', symbol: 'USDG', decimals: 6, verified: true, priceUsd: 1 },
    token1: { _id: 'oid-t1', address: '0xbbb', symbol: 'AGI', decimals: 18, verified: false, priceUsd: 0.002 },
    fee: 3000,
    tickSpacing: 60,
    tickLower: 335000,
    tickUpper: 341000,
    currentTick: 339217,
    sqrtPriceX96: '123456789',
    liquidity: '50000000000000000',
    rpcFeesUncollected0: '1.5',
    rpcFeesUncollected1: '2',
    rpcFeesBlock: 77_309_508,
    rpcFeesAt: new Date('2026-10-01T10:00:00Z'),
    isActive: true,
    createdAtTimestamp: 1790770383,
    closedAtTimestamp: null,
    amounts: { _id: 'oid-am', amount0: '10', amount1: '20', totalGasCostEth: '0.0001' },
    metrics: {
      _id: 'oid-me',
      aprExGas: 12,
      underlyingValueUsd: 16_113,
      totalGasCostUsd: 0.25,
      isPriceable: true,
      usd: { _id: 'oid-usd', pnlUsd: 1 },
    },
    poolStats: { _id: 'oid-ps', tvlUsd: 5_000_000, tvlUsdUntracked: 5_000_000, volumeUsd: 1_000_000, totalFeesUsd: 10_000 },
    pricing: { _id: 'oid-pr', source: 'dex', usedFallback: false },
    rawSubgraph: { id: '4663_3468131', lastModifyBlock: '3468131' },
    lastSyncedAt: new Date('2026-10-01T09:00:00Z'),
    lastVerifiedAt: new Date('2026-10-01T09:00:00Z'),
    staleMisses: 0,
    txSyncStatus: 'pending',
    txLastAttemptAt: new Date(0),
    txLastSuccessAt: new Date(0),
    txSyncedTransactionCount: 0,
    txFinalizedAt: new Date(0),
    txLastFailureAt: new Date(0),
    txLastError: 'x',
    createdAt: new Date('2026-09-30T12:13:03Z'),
    updatedAt: new Date('2026-10-01T09:00:00Z'),
  };
}

const LEAKED = [
  '_id',
  '__v',
  'rawSubgraph',
  'staleMisses',
  'lastVerifiedAt',
  'rpcFeesUncollected0',
  'rpcFeesUncollected1',
  'rpcFeesBlock',
  'rpcFeesAt',
  'txSyncStatus',
  'txLastAttemptAt',
  'txLastSuccessAt',
  'txSyncedTransactionCount',
  'txFinalizedAt',
  'txLastFailureAt',
  'txLastError',
];

const config = {
  isSupportedChain: () => true,
  isSupportedProtocol: () => true,
  getIntegration: () => ({ chainId: CHAIN, protocol: PROTO }),
  leaderboardCountCap: 25_000,
  enabledIntegrations: [
    { chainId: 1, protocol: PROTO },
    { chainId: 42161, protocol: PROTO },
  ],
};

function makeService(positions: Record<string, unknown>, counts = new LeaderboardCountService()) {
  return new LeaderboardService(
    config as never,
    positions as never,
    { findForPosition: async () => [] } as never,
    { resolve: () => ({ recomputeMode: 'aggregates', fetchPositionTransactions: async () => ({ transactions: [] }) }) } as never,
    counts,
  );
}

describe('position detail no longer leaks internal fields', () => {
  it('golden: equals the old response minus exactly the internal fields and subdocument _ids', async () => {
    const stored = storedPosition();
    // The repository is asked for the detail projection; hand it the WHOLE
    // document anyway, so the mapper — not the projection — is what is proven.
    const findOneForRead = vi.fn(async () => stored);
    const svc = makeService({ findOneForRead });
    const detail = (await svc.getPosition(CHAIN, PROTO, '3468131')) as Record<string, unknown>;

    // What the endpoint used to return: `{ ...sanitized, token0/1 + logoURI, transactions, ... }`.
    const before: Record<string, unknown> = {
      ...stored,
      token0: { ...stored.token0, logoURI: (detail.token0 as { logoURI?: string }).logoURI },
      token1: { ...stored.token1, logoURI: (detail.token1 as { logoURI?: string }).logoURI },
      transactions: [],
      transactionsDegraded: false,
    };
    for (const key of LEAKED) delete before[key];
    const stripId = (sub: Record<string, unknown>) => {
      const { _id, ...rest } = sub;
      return rest;
    };
    for (const sub of ['token0', 'token1', 'amounts', 'poolStats', 'pricing']) {
      before[sub] = stripId(before[sub] as Record<string, unknown>);
    }
    const metrics = stripId(before.metrics as Record<string, unknown>);
    metrics.usd = stripId(metrics.usd as Record<string, unknown>);
    before.metrics = metrics;

    expect(detail).toEqual(before);
    for (const key of LEAKED) expect(detail, key).not.toHaveProperty(key);
    expect(Object.keys(detail).sort()).toEqual(
      [
        'amounts',
        'chainId',
        'closedAtTimestamp',
        'createdAt',
        'createdAtTimestamp',
        'currentTick',
        'fee',
        'isActive',
        'lastSyncedAt',
        'liquidity',
        'metrics',
        'owner',
        'poolId',
        'poolStats',
        'positionId',
        'pricing',
        'protocol',
        'sqrtPriceX96',
        'tickLower',
        'tickSpacing',
        'tickUpper',
        'token0',
        'token1',
        'tokenId',
        'transactions',
        'transactionsDegraded',
        'updatedAt',
      ].sort(),
    );
  });

  it('list rows carry no subdocument _id either', async () => {
    const stored = storedPosition();
    const svc = makeService({
      findLeaderboard: async () => ({ positions: [stored], hasMore: false, cache: 'hit' }),
    });
    const res = await svc.getTopPositions({ chainId: CHAIN, protocol: PROTO, page: 1, limit: 25 } as never);
    expect(JSON.stringify(res.positions)).not.toContain('oid-');
    expect(res.positions[0]).not.toHaveProperty('rawSubgraph');
  });
});

describe('list pagination is off the count path', () => {
  const page = Array.from({ length: 25 }, (_, i) => ({ ...storedPosition(), positionId: String(i), tokenId: String(i) }));

  it('/api: totalPending until the count is cached, then the /count route answers it', async () => {
    const countLeaderboard = vi.fn(async () => ({ count: 1234, capped: false }));
    const positions = {
      findLeaderboard: async () => ({ positions: page, hasMore: true, cache: 'miss' }),
      leaderboardPlan: async () => ({ countKey: 'k' }),
      countLeaderboard,
    };
    const counts = new LeaderboardCountService();
    const svc = makeService(positions, counts);
    const meta: { cache?: string } = {};
    const first = await svc.getTopPositions({ chainId: CHAIN, protocol: PROTO, page: 1, limit: 25 } as never, { meta });
    expect(first.pagination).toEqual({
      page: 1,
      limit: 25,
      total: null,
      totalPages: null,
      hasMore: true,
      totalPending: true,
    });
    expect(meta.cache).toBe('miss');

    expect(await svc.getTopPositionsCount({ chainId: CHAIN, protocol: PROTO } as never)).toEqual({
      total: 1234,
      capped: false,
    });
    expect(countLeaderboard).toHaveBeenCalledTimes(1); // the /count call joined the page's background count

    const second = await svc.getTopPositions({ chainId: CHAIN, protocol: PROTO, page: 1, limit: 25 } as never);
    expect(second.pagination).toMatchObject({ total: 1234, totalPages: 50, hasMore: true });
  });

  it('all chains: sums shard counts, and the cache status is the worst shard', async () => {
    const positions = {
      findLeaderboard: async ({ chainId }: { chainId: number }) => ({
        positions: page.map((p) => ({ ...p, chainId })),
        hasMore: true,
        cache: chainId === 1 ? 'hit' : 'stale',
      }),
      leaderboardPlan: async ({ chainId }: { chainId: number }) => ({ countKey: `k${chainId}` }),
      countLeaderboard: async () => ({ count: 100, capped: false }),
      sortFieldFor: () => 'metrics.aprExGas',
      sortDirectionFor: () => -1,
    };
    const svc = makeService(positions);
    const meta: { cache?: string } = {};
    await svc.getTopPositions({ protocol: PROTO, page: 1, limit: 25 } as never, { meta });
    expect(meta.cache).toBe('stale');
    expect(await svc.getTopPositionsCount({ protocol: PROTO } as never)).toEqual({ total: 200, capped: false });
  });

  it('/v1 waits up to countWaitMs, then answers a flagged floor', async () => {
    const positions = {
      findLeaderboard: async () => ({ positions: page, hasMore: true, cache: 'miss' }),
      leaderboardPlan: async () => ({ countKey: 'k' }),
      countLeaderboard: () => new Promise(() => undefined), // never finishes
    };
    const svc = makeService(positions);
    const res = await svc.getTopPositions({ chainId: CHAIN, protocol: PROTO, page: 1, limit: 25 } as never, {
      countWaitMs: 20,
    });
    expect(res.pagination).toEqual({ page: 1, limit: 25, total: 26, totalPages: 2, hasMore: true, totalCapped: true });
  });
});

describe('withReadHeaders', () => {
  it('sets X-Cache from the read, and Retry-After on a timed-out read', async () => {
    const headers: Record<string, string> = {};
    const res = { setHeader: (name: string, value: string) => (headers[name] = value) };
    await withReadHeaders(res, async (meta) => {
      meta.cache = 'stale';
      return 1;
    });
    expect(headers['X-Cache']).toBe('stale');

    await expect(
      withReadHeaders(res, async () => {
        throw new QueryTimeoutException();
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(headers['Retry-After']).toBe('5');
    // A 503 must never be stored by a cache in front of the API.
    expect(headers['Cache-Control']).toBe('no-store');
  });

  it('a successful read sends no Cache-Control unless it said noStore', async () => {
    const headers: Record<string, string> = {};
    const res = { setHeader: (name: string, value: string) => (headers[name] = value) };
    await withReadHeaders(res, async (meta) => {
      meta.cache = 'hit';
      return 1;
    });
    expect(headers['Cache-Control']).toBeUndefined();
    await withReadHeaders(res, async (meta) => {
      meta.noStore = true;
      return 1;
    });
    expect(headers['Cache-Control']).toBe('no-store');
  });
});
