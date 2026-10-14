import { describe, expect, it, vi } from 'vitest';
import { LeaderboardCountService } from '../../src/leaderboard/count-cache.js';
import { LeaderboardWarmupService } from '../../src/leaderboard/leaderboard-warmup.service.js';
import { RankEngineService } from '../../src/read-models/rank/rank-engine.service.js';
import { RankUnsupported } from '../../src/read-models/rank/rank-engine.js';
import { buildRankStore, fakeRankReadModels, leaderboardService, makeRankConfig, positionsRepo, shardsFor } from './rank-support.js';

/**
 * Design §3.8: while the rank engine answers every request of a shard (serve,
 * 100%, servable), the warmup keeps only its REDUCED cycle there — the default
 * sort's landing window — and returns to the full cycle the moment the engine
 * would not: a ramp below 100%, a kill switch below the env's mode, a model or
 * shard not ready.
 */

function fakePositions() {
  return {
    warmed: [] as Array<{ chainId: number; sort: string }>,
    lastLeaderboardReadAt: Date.now(),
    leaderboardWindowAgeMs: vi.fn(async () => undefined),
    warmLeaderboardWindow: vi.fn(async function (this: { warmed: unknown[] }, q: { chainId: number; sort: string }) {
      (this.warmed as Array<{ chainId: number; sort: string }>).push({ chainId: q.chainId, sort: q.sort });
      return { key: `${q.chainId}|${q.sort}`, rows: [] };
    }),
    leaderboardPlan: vi.fn(async (q: { chainId: number; sort: string }) => ({ countKey: `c|${q.chainId}|${q.sort}` })),
    countLeaderboard: vi.fn(async () => ({ count: 1, capped: false })),
  };
}

const WARMUP_CONFIG = {
  leaderboardWarmupEnabled: true,
  leaderboardSnapshotRedisEnabled: false,
  leaderboardCountCap: 25_000,
  leaderboardSnapshotNamespace: 'spec',
  redisUrl: 'redis://127.0.0.1:1',
  enabledIntegrations: [
    { chainId: 1, protocol: 'uniswap-v4' },
    { chainId: 42161, protocol: 'uniswap-v4' },
  ],
};

describe('warmup in serve (design §3.8)', () => {
  it('reads only the default sort where the engine serves, every landing sort where it does not', async () => {
    const positions = fakePositions();
    const rank = { warmupReduced: (chainIds: number[]) => chainIds[0] === 1 };
    const svc = new LeaderboardWarmupService(WARMUP_CONFIG as never, positions as never, new LeaderboardCountService(), rank as never);
    await svc.runCycle();
    expect(positions.warmed.filter((w) => w.chainId === 1).map((w) => w.sort)).toEqual(['apr']);
    expect(new Set(positions.warmed.filter((w) => w.chainId === 42161).map((w) => w.sort)).size).toBe(8);
  });

  it('without an engine (or with it off) the cycle is today’s', async () => {
    const positions = fakePositions();
    const svc = new LeaderboardWarmupService(WARMUP_CONFIG as never, positions as never, new LeaderboardCountService());
    await svc.runCycle();
    expect(positions.warmed).toHaveLength(16);
  });

  it('the engine asks for the reduced cycle only when it would answer every request', async () => {
    const shards = shardsFor(51, { 1: 50, 42161: 30, 4663: 40 });
    const store = buildRankStore(shards);
    const make = async (over: Record<string, unknown>, mode: 'serve' | 'shadow' = 'serve') => {
      const config = makeRankConfig(over);
      const readModels = fakeRankReadModels(store, [1, 42161, 4663], mode);
      const rank = new RankEngineService(config as never, readModels as never);
      await rank.tick();
      return { rank, readModels };
    };
    const serving = await make({});
    expect(serving.rank.warmupReduced([1], 'uniswap-v4')).toBe(true);
    // a ramp below 100%
    expect((await make({ readModelsServePercent: 50 })).rank.warmupReduced([1], 'uniswap-v4')).toBe(false);
    // shadow
    expect((await make({}, 'shadow')).rank.warmupReduced([1], 'uniswap-v4')).toBe(false);
    // a kill switch below the env's serve (effective mode lowered)
    const killed = await make({});
    killed.readModels.effectiveMode = () => 'shadow';
    expect(killed.rank.warmupReduced([1], 'uniswap-v4')).toBe(false);
    // a shard not ready
    const notReady = await make({});
    const readiness = notReady.readModels.readiness();
    notReady.readModels.readiness = () => ({ rank: { ...readiness.rank, ready: false, reason: 'not_caught_up' } });
    expect(notReady.rank.warmupReduced([1], 'uniswap-v4')).toBe(false);
  });

  it('a quarantined leaf on a shard keeps its full cycle (the queries reading it go to Mongo); other shards stay reduced', async () => {
    const shards = shardsFor(52, { 1: 50, 42161: 30, 4663: 40 });
    (shards.get(1)![3]! as Record<string, unknown>).metrics = { ...((shards.get(1)![3]! as { metrics?: object }).metrics ?? {}), roi: 'odd' };
    const store = buildRankStore(shards);
    const readModels = fakeRankReadModels(store, [1, 42161, 4663], 'serve');
    const rank = new RankEngineService(makeRankConfig() as never, readModels as never);
    await rank.tick();
    expect(rank.engine!.quarantineActive('1:uniswap-v4' as never)).toBe(true);
    expect(rank.warmupReduced([1], 'uniswap-v4')).toBe(false);
    expect(rank.warmupReduced([42161], 'uniswap-v4')).toBe(true);
  });

  it('the engine’s own quarantine (a non-canonical positionId) also keeps the full cycle', async () => {
    const shards = shardsFor(52, { 1: 50, 42161: 30, 4663: 40 });
    const d = shards.get(4663)![2]! as Record<string, unknown>;
    d.positionId = `00${String(d.positionId)}`;
    d.tokenId = d.positionId;
    const store = buildRankStore(shards);
    const rank = new RankEngineService(makeRankConfig() as never, fakeRankReadModels(store, [1, 42161, 4663], 'serve') as never);
    await rank.tick();
    const shard = rank.engine!.current!.shards.get('4663:uniswap-v4' as never)!;
    shard.quarantine.fill(0); // only the engine's pid quarantine is left
    expect(shard.cols.quarantine.pid).toBeGreaterThan(0);
    expect(rank.warmupReduced([4663], 'uniswap-v4')).toBe(false);
    expect(rank.warmupReduced([42161], 'uniswap-v4')).toBe(true);
    // a collated string outside the ckey domain counts the same way
    const other = rank.engine!.current!.shards.get('42161:uniswap-v4' as never)!;
    (other.cols.quarantine as { str: number[] }).str[0] = 1;
    expect(rank.warmupReduced([42161], 'uniswap-v4')).toBe(false);
    (other.cols.quarantine as { str: number[] }).str[0] = 0;
  });

  it('an answer the engine refused on a shard keeps its full cycle for a while', async () => {
    const shards = shardsFor(53, { 1: 50, 42161: 30, 4663: 40 });
    const store = buildRankStore(shards);
    const config = makeRankConfig({ readModelsMaxLagMs: 3_600_000 });
    const readModels = fakeRankReadModels(store, [1, 42161, 4663], 'serve');
    const rank = new RankEngineService(config as never, readModels as never);
    await rank.tick();
    expect(rank.warmupReduced([42161], 'uniswap-v4')).toBe(true);
    // a list request on 42161 the engine refuses at answer time (a bind refusal, say)
    vi.spyOn(rank.engine!, 'answer').mockImplementationOnce(async () => {
      throw new RankUnsupported('literal_domain:owner');
    });
    const svc = leaderboardService(positionsRepo(shards, config).repo, config, rank);
    await svc.getTopPositions({ protocol: 'uniswap-v4', chainId: 42161, page: 1, limit: 20, activeOnly: false, status: 'all', minValueUsd: 0, minPoolTvl: 0, includeRisky: true, sort: 'pnl' } as never);
    const now = Date.now();
    expect(rank.warmupReduced([42161], 'uniswap-v4', now)).toBe(false);
    expect(rank.warmupReduced([1], 'uniswap-v4', now)).toBe(true);
    expect(rank.warmupReduced([42161], 'uniswap-v4', now + 11 * 60_000)).toBe(true);
  });
});
