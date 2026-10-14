import { describe, expect, it } from 'vitest';
import { LeaderboardCountService } from '../src/leaderboard/count-cache.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { PoolsService } from '../src/pools/pools.service.js';

/**
 * The per-row `risk: { flags }` (2026-10-06): search and lookups keep a spam
 * row and LABEL it; a clean row carries no `risk` key at all (additive).
 */

const ETH = '0x0000000000000000000000000000000000000000';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const USDG = '0xe343167631d89b6ffc58b88d6b7fb0228795491d'; // not a protected symbol on chain 1
const FAKE_USDT = '0x3173dc3af3981c6e98bb63799b9cbeb5526ff752';
const URL_TOKEN = '0x9ca4254d31c23bb62edabad98c256f59966214b6';
const EXCLUDED = '0x0000000000000000000000000000000000005a11';

const config = { isSupportedChain: () => true, isSupportedProtocol: () => true, enabledIntegrations: [], leaderboardCountCap: 25_000 };

function pool(poolId: string, t0: [string, string], t1: [string, string], pricing: Record<string, unknown>, chainId = 1) {
  return {
    chainId,
    protocol: 'uniswap-v4',
    poolId,
    token0: { address: t0[0], symbol: t0[1], decimals: 18 },
    token1: { address: t1[0], symbol: t1[1], decimals: 6 },
    fee: 500,
    metrics: { tvlUsd: 0 },
    pricing,
  };
}

function tokensFake(excluded: string[]) {
  return {
    findLatestPrices: async () => new Map(),
    findLatestPricesForRead: async () => new Map(),
    leaderboardExclusions: () => ({ addresses: excluded, ok: true }),
  };
}

describe('PoolsService — risk flags on search rows and pool detail', () => {
  const rows = [
    pool('0xclean', [ETH, 'ETH'], [USDC, 'USDC'], { source: 'external', usedFallback: false }),
    pool('0xfakeusdt', [FAKE_USDT, 'USDT'], [USDG, 'USDG'], { source: 'none', usedFallback: true }),
    pool('0xphish', [ETH, 'ETH'], [URL_TOKEN, 'Visit usualget.pro to claim'], { source: 'none', usedFallback: true }, 42161),
    pool('0xexcluded', [EXCLUDED, 'SPAM'], [USDC, 'USDC'], { source: 'external', usedFallback: false }),
    // Priced, then flagged by the pools sync (`evaluatePoolTvl` risky → usedFallback): the risky toggle hides it.
    pool('0xfallback', [ETH, 'ETH'], [USDC, 'USDC'], { source: 'external', usedFallback: true }),
    // No price source at all: the other half of what the risky toggle hides.
    pool('0xunpriced', [ETH, 'ETH'], [USDC, 'USDC'], { source: 'none', usedFallback: false }),
  ];
  const pools = {
    findPoolsLeaderboard: async () => ({ pools: rows, hasMore: false, cache: 'miss', total: rows.length }),
    findPoolById: async (_c: number, _p: string, id: string) => rows.find((r) => r.poolId === id) ?? null,
  };
  const positions = { countsByPoolIds: async () => new Map() };

  it('labels each search row; a clean row has no risk key', async () => {
    const svc = new PoolsService(config as never, pools as never, positions as never, tokensFake([EXCLUDED]) as never);
    const res = await svc.getTopPools({ chainId: 1, protocol: 'uniswap-v4', search: 'U' } as never);
    const byId = new Map(res.pools.map((p) => [p.poolId, p as { risk?: { flags: string[] } }]));
    expect(Object.hasOwn(byId.get('0xclean')!, 'risk')).toBe(false);
    expect(byId.get('0xfakeusdt')!.risk).toEqual({ flags: ['symbol-spoof', 'risky-pool'] });
    expect(byId.get('0xphish')!.risk).toEqual({ flags: ['phishing-symbol', 'risky-pool'] });
    expect(byId.get('0xexcluded')!.risk).toEqual({ flags: ['excluded-token'] });
    expect(byId.get('0xfallback')!.risk).toEqual({ flags: ['risky-pool'] });
    expect(byId.get('0xunpriced')!.risk).toEqual({ flags: ['risky-pool'] });
  });

  it('pool detail carries the same flags', async () => {
    const svc = new PoolsService(config as never, pools as never, positions as never, tokensFake([]) as never);
    const detail = (await svc.getPool(1, 'uniswap-v4', '0xfakeusdt')) as { risk?: { flags: string[] } };
    expect(detail.risk).toEqual({ flags: ['symbol-spoof', 'risky-pool'] });
    const clean = (await svc.getPool(1, 'uniswap-v4', '0xclean')) as Record<string, unknown>;
    expect(Object.hasOwn(clean, 'risk')).toBe(false);
  });

  it('a tokens repository without the exclusion read (a spec double) still gives the identity flags', async () => {
    const svc = new PoolsService(config as never, pools as never, positions as never, { findLatestPricesForRead: async () => new Map() } as never);
    const res = await svc.getTopPools({ chainId: 1, protocol: 'uniswap-v4' } as never);
    expect((res.pools.find((p) => p.poolId === '0xexcluded') as { risk?: unknown }).risk).toBeUndefined();
    expect((res.pools.find((p) => p.poolId === '0xfakeusdt') as { risk?: unknown }).risk).toEqual({ flags: ['symbol-spoof', 'risky-pool'] });
  });
});

describe('LeaderboardService — risk flags on position rows and detail', () => {
  const position = (positionId: string, t0: [string, string], t1: [string, string], poolStats: Record<string, unknown> = {}) => ({
    chainId: 1,
    protocol: 'uniswap-v4',
    positionId,
    tokenId: positionId,
    token0: { address: t0[0], symbol: t0[1], priceUsd: 1 },
    token1: { address: t1[0], symbol: t1[1], priceUsd: 1 },
    amounts: {},
    metrics: { underlyingValueUsd: 1000, isPriceable: true },
    poolStats: { tvlUsd: 5_000_000, tvlUsdUntracked: 5_000_000, volumeUsd: 1, totalFeesUsd: 1, ...poolStats },
    pricing: { source: 'external' },
  });
  const rows = [
    position('1', [ETH, 'ETH'], [USDC, 'USDC']),
    position('2', [ETH, 'ETH'], [USDC, 'USDC'], { risky: true }),
    position('3', [FAKE_USDT, 'USDT'], [USDC, 'USDC']),
  ];
  const repo = {
    findLeaderboard: async () => ({ positions: rows, hasMore: false, cache: 'hit', total: rows.length }),
    findOneForRead: async (_c: number, _p: string, id: string) => (id === '9' ? position('9', [EXCLUDED, 'SPAM'], [USDC, 'USDC']) : null),
  };
  const svcWith = (tokens: unknown) =>
    new LeaderboardService(
      { ...config, getIntegration: () => undefined } as never,
      repo as never,
      { findForPosition: async () => [] } as never,
      { resolve: () => ({ recomputeMode: 'per-tx' }) } as never,
      new LeaderboardCountService(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      tokens as never,
    );

  it('labels a risky-pool row and a spoofed leg; a clean row has no risk key', async () => {
    const res = await svcWith(tokensFake([])).getTopPositions({ chainId: 1, protocol: 'uniswap-v4' } as never);
    const byId = new Map(res.positions.map((p) => [p.positionId, p as { risk?: { flags: string[] } }]));
    expect(Object.hasOwn(byId.get('1')!, 'risk')).toBe(false);
    expect(byId.get('2')!.risk).toEqual({ flags: ['risky-pool'] });
    expect(byId.get('3')!.risk).toEqual({ flags: ['symbol-spoof'] });
  });

  it('an id lookup of an excluded token is served and labelled', async () => {
    const detail = (await svcWith(tokensFake([EXCLUDED])).getPosition(1, 'uniswap-v4', '9')) as { risk?: { flags: string[] } };
    expect(detail.risk).toEqual({ flags: ['excluded-token'] });
    const without = (await svcWith(undefined).getPosition(1, 'uniswap-v4', '9')) as Record<string, unknown>;
    expect(Object.hasOwn(without, 'risk')).toBe(false);
  });
});
