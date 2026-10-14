import { describe, expect, it } from 'vitest';
import { PoolsService } from '../src/pools/pools.service.js';

// Minimal pool doc shaped like what PoolsRepository returns (enough for enrichPool).
const poolDoc = (poolId: string, chainId = 1, protocol = 'uniswap-v4') => ({
  poolId,
  chainId,
  protocol,
  token0: { address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  token1: { address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
  fee: 3000,
  tickSpacing: 60,
  currentTick: 0,
  sqrtPriceX96: '0',
  liquidity: '0',
  createdAtTimestamp: 0,
  metrics: { tvlUsd: 0, feeApr: 0, txCount: 0 },
  pricing: { source: 'subgraph', usedFallback: false },
  updatedAt: new Date(0),
});

function build(overrides: { pools?: unknown; positions?: unknown } = {}) {
  const config = { isSupportedChain: () => true, isSupportedProtocol: () => true } as never;
  return new PoolsService(config, (overrides.pools ?? {}) as never, (overrides.positions ?? {}) as never);
}

describe('PoolsService positions/holders counts', () => {
  it('attaches open positionsCount + holdersCount to the list, defaulting 0/0', async () => {
    const svc = build({
      pools: { findPoolsLeaderboard: async () => ({ pools: [poolDoc('0xAbC'), poolDoc('0xDef')], hasMore: false, cache: 'hit' }) },
      positions: {
        // batched per shard; keyed by lowercased poolId. 0xDef is absent → 0/0.
        countsByPoolIds: async (_c: number, _p: string, ids: string[]) => {
          const m = new Map<string, { positionsCount: number; holdersCount: number }>();
          if (ids.map((i) => i.toLowerCase()).includes('0xabc')) {
            m.set('0xabc', { positionsCount: 3, holdersCount: 2 });
          }
          return m;
        },
      },
    });

    // chainId set = single-chain path (omitted now means ALL enabled chains).
    const res = await svc.getTopPools({ chainId: 1 } as never);
    expect(res.pools[0]).toMatchObject({ poolId: '0xAbC', positionsCount: 3, holdersCount: 2 });
    expect(res.pools[1]).toMatchObject({ poolId: '0xDef', positionsCount: 0, holdersCount: 0 });
  });

  it('omitted chainId fans out across enabled chains and merges by the sort spec', async () => {
    const config = {
      isSupportedChain: () => true,
      isSupportedProtocol: () => true,
      enabledIntegrations: [
        { chainId: 1, protocol: 'uniswap-v4' },
        { chainId: 43114, protocol: 'uniswap-v4' },
      ],
    } as never;
    // Each shard page reads one row past itself, so `hasMore: false` with these
    // rows means each shard holds exactly these — the merge proves total = 3.
    const byChain: Record<number, { pools: unknown[]; hasMore: boolean; cache: string }> = {
      1: {
        pools: [
          { ...poolDoc('0xa1', 1), metrics: { tvlUsd: 100, feeApr: 0, txCount: 0 } },
          { ...poolDoc('0xa2', 1), metrics: { tvlUsd: 10, feeApr: 0, txCount: 0 } },
        ],
        hasMore: false,
        cache: 'hit',
      },
      43114: {
        pools: [{ ...poolDoc('0xb1', 43114), metrics: { tvlUsd: 50, feeApr: 0, txCount: 0 } }],
        hasMore: false,
        cache: 'hit',
      },
    };
    const svc = new PoolsService(
      config,
      {
        findPoolsLeaderboard: async ({ chainId }: { chainId: number }) => byChain[chainId],
        sortFieldFor: () => 'metrics.tvlUsd',
        sortDirectionFor: () => -1,
      } as never,
      { countsByPoolIds: async () => new Map() } as never,
    );

    const res = await svc.getTopPools({ protocol: 'uniswap-v4', sort: 'tvl' } as never);
    // Merged desc by tvl across both shards; the merged page proves its total.
    expect(res.pools.map((p: { poolId: string }) => p.poolId)).toEqual(['0xa1', '0xb1', '0xa2']);
    expect(res.pools.map((p: { chainId: number }) => p.chainId)).toEqual([1, 43114, 1]);
    expect(res.pagination.total).toBe(3);
  });

  it('a pool whose count is not known yet is null — flagged countsPending — never a 503 or a fake 0/0', async () => {
    const svc = build({
      pools: { findPoolsLeaderboard: async () => ({ pools: [poolDoc('0xAbC'), poolDoc('0xDef')], hasMore: false, cache: 'hit' }) },
      positions: {
        countsByPoolIds: async () =>
          new Map<string, { positionsCount: number; holdersCount: number } | null>([
            ['0xabc', null],
            ['0xdef', { positionsCount: 1, holdersCount: 1 }],
          ]),
      },
    });
    const res = await svc.getTopPools({ chainId: 1 } as never);
    expect(res.pools[0]).toMatchObject({ poolId: '0xAbC', positionsCount: null, holdersCount: null });
    expect(res.pools[1]).toMatchObject({ positionsCount: 1, holdersCount: 1 });
    expect(res.countsPending).toBe(true);

    const known = build({
      pools: { findPoolsLeaderboard: async () => ({ pools: [poolDoc('0xAbC')], hasMore: false, cache: 'hit' }) },
      positions: { countsByPoolIds: async () => new Map() },
    });
    expect('countsPending' in (await known.getTopPools({ chainId: 1 } as never))).toBe(false);
  });

  it('detail returns open positionsCount + holdersCount (0/0 when none)', async () => {
    const withCounts = build({
      pools: { findPoolById: async () => poolDoc('0xAbC') },
      positions: { countsByPoolIds: async () => new Map([['0xabc', { positionsCount: 5, holdersCount: 4 }]]) },
    });
    expect(await withCounts.getPool(1, 'uniswap-v4', '0xAbC')).toMatchObject({ positionsCount: 5, holdersCount: 4 });

    const noPositions = build({
      pools: { findPoolById: async () => poolDoc('0xAbC') },
      positions: { countsByPoolIds: async () => new Map() },
    });
    expect(await noPositions.getPool(1, 'uniswap-v4', '0xAbC')).toMatchObject({ positionsCount: 0, holdersCount: 0 });
  });
});
