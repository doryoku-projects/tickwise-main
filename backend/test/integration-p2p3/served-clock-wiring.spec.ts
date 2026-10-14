/*
 * I1 — the P2.3 read-time overlay wired into the ONE shared row mapper
 * (`LeaderboardService`: list, after the window cache and the rank engine, and
 * detail). With `POSITIONS_WRITE_SKIP=on` an unchanged row is not rewritten,
 * so `metrics.ageSeconds` is computed per request and an active, clean row's
 * `lastSyncedAt` / `pricing.pricedAt` follow its shard's last clean refresh.
 * Off / shadow: the response is exactly today's.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LeaderboardCountService } from '../../src/leaderboard/count-cache.js';
import { LeaderboardService } from '../../src/leaderboard/leaderboard.service.js';
import { DETAIL_PROJECTION, DETAIL_OVERLAY_PROJECTION } from '../../src/database/positions.repository.js';

const PROTO = 'uniswap-v4';
const NOW = Date.parse('2026-10-04T12:00:00Z');
const CLEAN = new Date('2026-10-04T11:55:00Z');
const STORED_SYNC = new Date('2026-10-04T06:00:00Z');

function row(over: Record<string, unknown> = {}) {
  return {
    chainId: 1,
    protocol: PROTO,
    positionId: '7',
    tokenId: '7',
    owner: '0xowner',
    poolId: '0xpool',
    token0: { address: '0xaaa', symbol: 'USDC', decimals: 6, verified: true, priceUsd: 1 },
    token1: { address: '0xbbb', symbol: 'WETH', decimals: 18, verified: true, priceUsd: 2_000 },
    fee: 500,
    tickSpacing: 10,
    tickLower: -10,
    tickUpper: 10,
    currentTick: 0,
    liquidity: '1',
    isActive: true,
    createdAtTimestamp: Math.floor(NOW / 1000) - 86_400,
    closedAtTimestamp: null,
    amounts: { amount0: '1', amount1: '1' },
    metrics: { ageSeconds: 3_600, underlyingValueUsd: 2_001, isPriceable: true },
    poolStats: { tvlUsd: 5_000_000, tvlUsdUntracked: 5_000_000, volumeUsd: 1, totalFeesUsd: 1 },
    pricing: { source: 'dex', usedFallback: false, pricedAt: STORED_SYNC },
    lastSyncedAt: STORED_SYNC,
    staleMisses: 0,
    ...over,
  };
}

function service(mode: string, positions: Record<string, unknown>, syncRepo?: unknown) {
  const config = {
    isSupportedChain: () => true,
    isSupportedProtocol: () => true,
    getIntegration: () => ({ chainId: 1, protocol: PROTO }),
    leaderboardCountCap: 25_000,
    enabledIntegrations: [{ chainId: 1, protocol: PROTO }],
    positionsWriteSkip: mode,
  };
  return new LeaderboardService(
    config as never,
    positions as never,
    { findForPosition: async () => [] } as never,
    { resolve: () => ({ recomputeMode: 'aggregates', fetchPositionTransactions: async () => ({ transactions: [] }) }) } as never,
    new LeaderboardCountService(),
    undefined,
    undefined,
    undefined,
    syncRepo as never,
  );
}

afterEach(() => vi.useRealTimers());

describe('list: the overlay runs per request in the shared mapper', () => {
  it('skip ON: age computed at now, lastSyncedAt / pricedAt raised to the shard\'s last clean refresh, staleMisses never served', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const lastCleanRefreshAt = vi.fn(async () => CLEAN);
    const svc = service('on', { findLeaderboard: async () => ({ positions: [row()], hasMore: false, cache: 'hit', total: 1 }) }, { lastCleanRefreshAt });
    const res = await svc.getTopPositions({ chainId: 1, protocol: PROTO, page: 1, limit: 25 } as never);
    const p = res.positions[0] as Record<string, unknown>;
    expect((p.metrics as { ageSeconds: number }).ageSeconds).toBe(86_400);
    expect(p.lastSyncedAt).toEqual(CLEAN);
    expect((p.pricing as { pricedAt: Date }).pricedAt).toEqual(CLEAN);
    expect(p).not.toHaveProperty('staleMisses');
    expect(lastCleanRefreshAt).toHaveBeenCalledWith(1, PROTO);
  });

  it('skip ON: a row the last refresh did NOT see (staleMisses > 0) keeps its stored clocks', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const svc = service('on', { findLeaderboard: async () => ({ positions: [row({ staleMisses: 2 })], hasMore: false, cache: 'hit', total: 1 }) }, { lastCleanRefreshAt: async () => CLEAN });
    const p = (await svc.getTopPositions({ chainId: 1, protocol: PROTO, page: 1, limit: 25 } as never)).positions[0] as Record<string, unknown>;
    expect(p.lastSyncedAt).toEqual(STORED_SYNC);
  });

  it.each(['off', 'shadow'])('skip %s: the stored clocks are served untouched (today) and lastCleanRefreshAt is never read', async (mode) => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const lastCleanRefreshAt = vi.fn(async () => CLEAN);
    const stored = row();
    delete (stored as Record<string, unknown>).staleMisses; // not projected outside `on`
    const svc = service(mode, { findLeaderboard: async () => ({ positions: [stored], hasMore: false, cache: 'hit', total: 1 }) }, { lastCleanRefreshAt });
    const p = (await svc.getTopPositions({ chainId: 1, protocol: PROTO, page: 1, limit: 25 } as never)).positions[0] as Record<string, unknown>;
    expect((p.metrics as { ageSeconds: number }).ageSeconds).toBe(3_600);
    expect(p.lastSyncedAt).toEqual(STORED_SYNC);
    expect(lastCleanRefreshAt).not.toHaveBeenCalled();
  });

  it('skip ON without a SyncRepository bound: age is still computed, the clocks stay stored', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const svc = service('on', { findLeaderboard: async () => ({ positions: [row()], hasMore: false, cache: 'hit', total: 1 }) });
    const p = (await svc.getTopPositions({ chainId: 1, protocol: PROTO, page: 1, limit: 25 } as never)).positions[0] as Record<string, unknown>;
    expect((p.metrics as { ageSeconds: number }).ageSeconds).toBe(86_400);
    expect(p.lastSyncedAt).toEqual(STORED_SYNC);
  });

  it('all chains: each row gets ITS shard\'s floor', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const floors: Record<number, Date> = { 1: CLEAN, 42161: new Date('2026-10-04T11:00:00Z') };
    const svc = service(
      'on',
      {
        findLeaderboard: async (args: { chainId: number }) => ({
          positions: [row({ chainId: args.chainId, positionId: String(args.chainId) })],
          hasMore: false,
          cache: 'hit',
          total: 1,
        }),
      },
      { lastCleanRefreshAt: async (chainId: number) => floors[chainId] },
    );
    (svc as unknown as { config: { enabledIntegrations: unknown[] } }).config.enabledIntegrations = [
      { chainId: 1, protocol: PROTO },
      { chainId: 42161, protocol: PROTO },
    ];
    const res = await svc.getTopPositions({ protocol: PROTO, page: 1, limit: 25 } as never);
    const byChain = new Map(res.positions.map((p) => [(p as { chainId: number }).chainId, p as Record<string, unknown>]));
    expect(byChain.get(1)!.lastSyncedAt).toEqual(CLEAN);
    expect(byChain.get(42161)!.lastSyncedAt).toEqual(floors[42161]);
  });
});

describe('detail: the overlay projection and mapper', () => {
  it('skip ON: asks for the overlay projection (staleMisses) and serves the overlaid clocks without it', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const findOneForRead = vi.fn(async () => row());
    const svc = service('on', { findOneForRead, detailProjection: () => DETAIL_OVERLAY_PROJECTION }, { lastCleanRefreshAt: async () => CLEAN });
    const detail = (await svc.getPosition(1, PROTO, '7')) as Record<string, unknown>;
    expect((findOneForRead.mock.calls[0] as unknown[])[3]).toBe(DETAIL_OVERLAY_PROJECTION);
    expect(detail.lastSyncedAt).toEqual(CLEAN);
    expect((detail.metrics as { ageSeconds: number }).ageSeconds).toBe(86_400);
    expect(detail).not.toHaveProperty('staleMisses');
  });

  it('skip OFF: today\'s projection and today\'s clocks', async () => {
    const findOneForRead = vi.fn(async () => row());
    const svc = service('off', { findOneForRead, detailProjection: () => DETAIL_PROJECTION }, { lastCleanRefreshAt: async () => CLEAN });
    const detail = (await svc.getPosition(1, PROTO, '7')) as Record<string, unknown>;
    expect((findOneForRead.mock.calls[0] as unknown[])[3]).toBe(DETAIL_PROJECTION);
    expect(detail.lastSyncedAt).toEqual(STORED_SYNC);
  });
});
