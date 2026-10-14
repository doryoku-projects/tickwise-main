/*
 * I1 cross-package (design §4.6, §17): the P2.3 read overlay gives the SAME
 * served rows whether a list page came from the Mongo path or from the P-R
 * rank engine (`RANK_ENGINE_MODE=serve`). The overlay lives in
 * `LeaderboardService`'s one row mapper, AFTER both paths converge, so the
 * same stored rows must serve byte-identically either way — in skip `on`
 * (overlaid) and in `off` / `shadow` (today's rows).
 *
 * The rank engine is a stub that answers with the rows the Mongo path would
 * have read (its own parity with Mongo is the P-R `rank-parity` suite); what
 * is pinned here is that nothing on the engine path bypasses, doubles or
 * changes the overlay.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LeaderboardCountService } from '../../src/leaderboard/count-cache.js';
import { LeaderboardService } from '../../src/leaderboard/leaderboard.service.js';

const PROTO = 'uniswap-v4';
const NOW = Date.parse('2026-10-04T12:00:00Z');
const FLOORS: Record<number, Date> = {
  1: new Date('2026-10-04T11:55:00Z'),
  42161: new Date('2026-10-04T11:40:00Z'),
};
const STORED = new Date('2026-10-04T06:00:00Z');

function row(chainId: number, id: string, apr: number, over: Record<string, unknown> = {}) {
  return {
    chainId,
    protocol: PROTO,
    positionId: id,
    tokenId: id,
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
    metrics: { apr, ageSeconds: 3_600, underlyingValueUsd: 2_001, isPriceable: true },
    poolStats: { tvlUsd: 5_000_000, tvlUsdUntracked: 5_000_000, volumeUsd: 1, totalFeesUsd: 1 },
    pricing: { source: 'dex', usedFallback: false, pricedAt: STORED },
    lastSyncedAt: STORED,
    staleMisses: 0,
    ...over,
  };
}

/** Rows as a shard stores them: an active clean row, an active row the last refresh did not see, a closed row. */
function shardRows(chainId: number) {
  return [
    row(chainId, `${chainId}01`, 30),
    row(chainId, `${chainId}02`, 20, { staleMisses: 2 }),
    row(chainId, `${chainId}03`, 10, { isActive: false, closedAtTimestamp: Math.floor(NOW / 1000) - 600 }),
  ];
}

function service(
  mode: string,
  opts: { engine: boolean; chains: number[]; rows: (chainId: number) => ReturnType<typeof row>[]; order?: string[] },
) {
  const integrations = opts.chains.map((chainId) => ({ chainId, protocol: PROTO }));
  const config = {
    isSupportedChain: () => true,
    isSupportedProtocol: () => true,
    getIntegration: (chainId: number) => ({ chainId, protocol: PROTO }),
    leaderboardCountCap: 25_000,
    enabledIntegrations: integrations,
    positionsWriteSkip: mode,
  };
  const findLeaderboard = vi.fn(async (args: { chainId: number }) => ({
    positions: opts.rows(args.chainId),
    hasMore: false,
    cache: 'hit',
    total: opts.rows(args.chainId).length,
  }));
  const positions = {
    findLeaderboard,
    leaderboardPlan: vi.fn(async (args: { chainId: number }) => ({ chainId: args.chainId, collated: false })),
  };
  // The engine answers with the same stored rows in the page order the Mongo
  // path produced (row ORDER parity is the P-R rank-parity suite's job).
  const engineRows = () => {
    const all = opts.chains.flatMap((c) => opts.rows(c));
    const order = opts.order ?? all.map((r) => r.positionId);
    return order.map((id) => all.find((r) => r.positionId === id)!);
  };
  const rank = opts.engine
    ? {
        mode: () => 'serve',
        route: () => ({ serve: true }),
        list: vi.fn(async () => {
          const rows = engineRows();
          return { kind: 'ok', positions: rows, hasMore: false, cache: 'hit', total: rows.length, missingChains: [], errors: [], dataAt: Date.now(), answer: {} };
        }),
        countTasks: () => undefined,
        offer: vi.fn(),
      }
    : undefined;
  const lastCleanRefreshAt = vi.fn(async (chainId: number) => FLOORS[chainId]);
  const svc = new LeaderboardService(
    config as never,
    positions as never,
    { findForPosition: async () => [] } as never,
    { resolve: () => ({ recomputeMode: 'aggregates', fetchPositionTransactions: async () => ({ transactions: [] }) }) } as never,
    new LeaderboardCountService(),
    undefined,
    undefined,
    rank as never,
    { lastCleanRefreshAt } as never,
  );
  return { svc, findLeaderboard, rank, lastCleanRefreshAt };
}

async function page(
  mode: string,
  engine: boolean,
  chains: number[],
  rows: (c: number) => ReturnType<typeof row>[] = shardRows,
  order?: string[],
) {
  const h = service(mode, { engine, chains, rows, ...(order ? { order } : {}) });
  const query = { ...(chains.length === 1 ? { chainId: chains[0] } : {}), protocol: PROTO, page: 1, limit: 25, sort: 'apr' };
  const res = await h.svc.getTopPositions(query as never);
  return { res, ...h };
}

const idsOf = (res: { positions: unknown[] }) => (res.positions as Array<{ positionId: string }>).map((p) => p.positionId);

afterEach(() => vi.useRealTimers());

describe('overlay parity: Mongo path vs rank engine', () => {
  it.each([
    ['one chain', [1]],
    ['all chains (each row its own shard floor)', [1, 42161]],
  ])('skip ON, %s: identical served rows, and the overlay really applied on both', async (_label, chains) => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const mongo = await page('on', false, chains);
    const engine = await page('on', true, chains, shardRows, idsOf(mongo.res));
    expect(mongo.findLeaderboard).toHaveBeenCalled();
    expect(engine.rank!.list).toHaveBeenCalledTimes(1);
    expect(engine.findLeaderboard).not.toHaveBeenCalled(); // really the engine path
    expect(engine.res.positions).toEqual(mongo.res.positions);
    expect(JSON.stringify(engine.res.positions)).toBe(JSON.stringify(mongo.res.positions));
    // Not vacuous: the clean active rows were raised to their OWN shard's floor,
    // the unseen one kept its stored clock, every age is computed at now.
    for (const res of [mongo.res, engine.res]) {
      for (const p of res.positions as Array<Record<string, unknown>>) {
        const id = String(p.positionId);
        const chainId = p.chainId as number;
        const synced = new Date(p.lastSyncedAt as Date).getTime();
        if (id.endsWith('01')) expect(synced).toBe(FLOORS[chainId]!.getTime());
        else expect(synced).toBe(STORED.getTime());
        expect(p).not.toHaveProperty('staleMisses');
      }
      const open = (res.positions as Array<{ positionId: string; metrics: { ageSeconds: number } }>).find((p) => p.positionId.endsWith('01'))!;
      expect(open.metrics.ageSeconds).toBe(86_400);
    }
    // One floor read per shard on each path, never per row.
    expect(engine.lastCleanRefreshAt.mock.calls.map((c) => c[0]).sort()).toEqual([...chains].sort());
  });

  it.each(['off', 'shadow'])('skip %s: identical rows on both paths, and they are today\'s (no overlay, no floor read)', async (mode) => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    // staleMisses is projected only with `on`.
    const rows = (c: number) => shardRows(c).map(({ staleMisses: _s, ...rest }) => rest as ReturnType<typeof row>);
    const mongo = await page(mode, false, [1, 42161], rows);
    const engine = await page(mode, true, [1, 42161], rows, idsOf(mongo.res));
    expect(engine.res.positions).toEqual(mongo.res.positions);
    for (const p of engine.res.positions as Array<{ lastSyncedAt: Date; metrics: { ageSeconds: number } }>) {
      expect(p.lastSyncedAt).toEqual(STORED);
      expect(p.metrics.ageSeconds).toBe(3_600);
    }
    expect(engine.lastCleanRefreshAt).not.toHaveBeenCalled();
    expect(mongo.lastCleanRefreshAt).not.toHaveBeenCalled();
  });

  it('rows reloaded from a Redis snapshot (ISO strings) serve the same on both paths, strings stay strings', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const iso = (c: number) =>
      shardRows(c).map((r) => ({ ...r, lastSyncedAt: STORED.toISOString(), pricing: { ...r.pricing, pricedAt: STORED.toISOString() } })) as never;
    const mongo = await page('on', false, [1], iso);
    const engine = await page('on', true, [1], iso, idsOf(mongo.res));
    expect(JSON.stringify(engine.res.positions)).toBe(JSON.stringify(mongo.res.positions));
    const clean = (engine.res.positions as Array<{ positionId: string; lastSyncedAt: unknown }>).find((p) => p.positionId === '101')!;
    expect(clean.lastSyncedAt).toBe(FLOORS[1]!.toISOString());
  });
});
