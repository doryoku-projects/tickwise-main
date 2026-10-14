import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queues: [] as Array<{
    name: string;
    add: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    getJobCounts: ReturnType<typeof vi.fn>;
    getRepeatableJobs: ReturnType<typeof vi.fn>;
    removeRepeatableByKey: ReturnType<typeof vi.fn>;
    obliterate: ReturnType<typeof vi.fn>;
    getJobs: ReturnType<typeof vi.fn>;
  }>,
  workers: [] as Array<{
    name: string;
    processor: (job: unknown) => Promise<unknown>;
    opts: { concurrency?: number; lockDuration?: number };
    close: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    ping: vi.fn(async () => 'PONG'),
    quit: vi.fn(async () => undefined),
  })),
}));

vi.mock('bullmq', () => ({
  Job: class {},
  Queue: vi.fn().mockImplementation((name: string) => {
    const queue = {
      name,
      add: vi.fn(async (_name: string, _data: unknown, options?: { jobId?: string }) => ({ id: options?.jobId })),
      close: vi.fn(async () => undefined),
      getJobCounts: vi.fn(async () => ({})),
      getRepeatableJobs: vi.fn(async () => []),
      removeRepeatableByKey: vi.fn(async () => undefined),
      obliterate: vi.fn(async () => undefined),
      getJobs: vi.fn(async () => [] as Array<{ name: string; data: { chainId: number; protocol: string } }>),
    };
    mocks.queues.push(queue);
    return queue;
  }),
  Worker: vi.fn().mockImplementation(
    (name: string, processor: (job: unknown) => Promise<unknown>, opts: { concurrency?: number; lockDuration?: number }) => {
      const worker = {
        name,
        processor,
        opts,
        close: vi.fn(async () => undefined),
        on: vi.fn(),
      };
      mocks.workers.push(worker);
      return worker;
    },
  ),
}));

import {
  BACKGROUND_SWEEPS_QUEUE,
  BOOT_KICK_STAGGER_MS,
  POSITIONS_REFRESH_QUEUE,
  POSITIONS_SYNC_QUEUE,
  QueueService,
  SWEEP_JOB_NAMES,
  queueNameForJob,
  refreshRepeats,
  repeatMinutes,
  staggeredRepeat,
} from '../src/queues/queue.service.js';
import { currentIndexerContext } from '../src/subgraph/hyperindex/indexer-context.js';
import { isShuttingDown, resetShutdownForTests } from '../src/common/shutdown.js';

// Queues are created in constructor order: [0] positions-sync, [1] live-refresh,
// [2] background-sweeps, [3] positions-refresh.
describe('QueueService — transaction cron retired', () => {
  beforeEach(() => {
    mocks.queues.length = 0;
    mocks.workers.length = 0;
    vi.clearAllMocks();
  });

  it('registers the position refresh repeatable on positions-refresh, never on positions-sync', async () => {
    const service = queueService({ positionsSyncCronEnabled: true, positionsSyncIntervalMs: 1_800_000 });

    await service.onModuleInit();

    const [positionsQueue, , , refreshQueue] = mocks.queues;
    expect(refreshQueue!.name).toBe(POSITIONS_REFRESH_QUEUE);
    // One chain, no sweep crons registered here: its slot is the base, :00/:30.
    expect(refreshQueue!.add).toHaveBeenCalledWith(
      'refresh',
      { chainId: 1, protocol: 'uniswap-v4' },
      { jobId: 'repeat-refresh-1-uniswap-v4', repeat: { pattern: '0,30 * * * *', tz: 'UTC' } },
    );
    expect(positionsQueue!.add.mock.calls.filter((c) => c[0] === 'refresh')).toEqual([]);
  });

  it('never registers any transaction repeatable (no sync-transactions* jobs)', async () => {
    const service = queueService({ positionsSyncCronEnabled: true });

    await service.onModuleInit();

    for (const queue of mocks.queues) {
      const names = queue.add.mock.calls.map((call) => call[0]);
      expect(names).not.toContain('sync-transactions');
      expect(names).not.toContain('sync-transactions-full');
    }
  });

  it('clears the positions-sync queue on boot (jobs + crons) when QUEUE_CLEAR_ON_BOOT=true, but leaves live-refresh alone', async () => {
    const service = queueService({ queueClearOnBoot: true });

    await service.onModuleInit();

    const positionsQueue = mocks.queues[0];
    const liveRefreshQueue = mocks.queues[1];
    expect(positionsQueue.obliterate).toHaveBeenCalledWith({ force: true });
    // Live-refresh jobs are ephemeral (one per position) — not wiped on boot.
    expect(liveRefreshQueue.obliterate).not.toHaveBeenCalled();
  });

  // 2026-10-03: the clear is OFF by default — it was what lost an in-flight
  // backfill on every deploy (the BullMQ job, not the cursor).
  it('does not clear any queue by default, nor with QUEUE_CLEAR_ON_BOOT=false', async () => {
    for (const overrides of [{}, { queueClearOnBoot: false }]) {
      mocks.queues.length = 0;
      const service = queueService(overrides);
      await service.onModuleInit();
      for (const queue of mocks.queues) expect(queue.obliterate).not.toHaveBeenCalled();
    }
  });

  // 2026-10-01: the jobId carried the block number, so a position changing across
  // many polls queued a job per block. While the indexer replayed Robinhood that
  // reached 4.6M waiting jobs (7.8 GB of Redis) and the workers saturated Mongo.
  it('enqueues ONE pending live refresh per position, never one per block', async () => {
    let enqueue: ((job: { chainId: number; protocol: string; tokenId: string; blockNumber: number }) => Promise<void>) | undefined;
    const service = new QueueService(
      {
        redisUrl: 'redis://localhost:6379',
        positionsSyncCronEnabled: false,
        positionsSyncIntervalMs: 300_000,
        transactionsSyncEnabled: true,
        liveRefreshEnabled: true,
        liveRefreshConcurrency: 8,
        enabledIntegrations: [],
      } as never,
      { backfillTarget: vi.fn(), refreshTarget: vi.fn() } as never,
      { registerEnqueue: vi.fn((fn) => (enqueue = fn)) } as never,
      { refreshPosition: vi.fn() } as never,
    );
    await service.onModuleInit();
    expect(enqueue).toBeDefined();

    await enqueue!({ chainId: 4663, protocol: 'uniswap-v4', tokenId: '42', blockNumber: 100 });
    await enqueue!({ chainId: 4663, protocol: 'uniswap-v4', tokenId: '42', blockNumber: 101 });

    const live = mocks.queues[1];
    expect(live.add).toHaveBeenCalledTimes(2);
    for (const [, , options] of live.add.mock.calls) {
      // Same dedup id for both blocks, so BullMQ keeps one job (plus at most one
      // follow-up while a job for this position is running).
      expect(options.deduplication).toEqual({ id: 'live-4663-uniswap-v4-42', keepLastIfActive: true });
      // No block-keyed jobId: that is what defeated de-duplication before.
      expect(options.jobId).toBeUndefined();
    }
  });

  it('creates the position-sync, background-sweeps and positions-refresh workers when live refresh is disabled (no tx worker)', async () => {
    const service = queueService({ liveRefreshEnabled: false });

    await service.onModuleInit();

    // Previously: positions + transactions (+ live). Now positions + sweeps + refresh.
    expect(mocks.workers.map((w) => w.name)).toEqual([
      POSITIONS_SYNC_QUEUE,
      BACKGROUND_SWEEPS_QUEUE,
      POSITIONS_REFRESH_QUEUE,
    ]);
  });
});

describe('QueueService — background-sweeps queue', () => {
  beforeEach(() => {
    mocks.queues.length = 0;
    mocks.workers.length = 0;
    vi.clearAllMocks();
  });

  const positionsQueue = () => mocks.queues.find((q) => q.name === POSITIONS_SYNC_QUEUE)!;
  const sweepsQueue = () => mocks.queues.find((q) => q.name === BACKGROUND_SWEEPS_QUEUE)!;
  const refreshQueue = () => mocks.queues.find((q) => q.name === POSITIONS_REFRESH_QUEUE)!;
  const addedNames = (queue: { add: ReturnType<typeof vi.fn> }) => queue.add.mock.calls.map((c) => c[0] as string);

  it('routes sweeps to background-sweeps, refresh to positions-refresh, backfill and the healer to positions-sync', () => {
    expect([...SWEEP_JOB_NAMES].sort()).toEqual(
      ['pool-sync', 'position-fee-refresh', 'token-price-sync', 'token-security-sync'],
    );
    for (const name of SWEEP_JOB_NAMES) expect(queueNameForJob(name)).toBe(BACKGROUND_SWEEPS_QUEUE);
    expect(queueNameForJob('refresh')).toBe(POSITIONS_REFRESH_QUEUE);
    expect(queueNameForJob('backfill')).toBe(POSITIONS_SYNC_QUEUE);
    expect(queueNameForJob('recompute-aggregates')).toBe(POSITIONS_SYNC_QUEUE);
  });

  it('runs the sweeps worker at concurrency 8 and the refresh worker at concurrency 1, both with a 30 min lock', async () => {
    const service = queueService({ liveRefreshEnabled: true });
    await service.onModuleInit();

    // Created after the live worker, so the earlier ones keep their positions.
    expect(mocks.workers.map((w) => w.name)).toEqual([
      POSITIONS_SYNC_QUEUE,
      'position-live-refresh',
      BACKGROUND_SWEEPS_QUEUE,
      POSITIONS_REFRESH_QUEUE,
    ]);
    const sweeps = mocks.workers[2]!;
    expect(sweeps.opts.concurrency).toBe(8);
    expect(sweeps.opts.lockDuration).toBe(30 * 60_000);
    // One chain's refresh at a time: four at once was 2.5–4k updates/s on the M10.
    const refresh = mocks.workers[3]!;
    expect(refresh.opts.concurrency).toBe(1);
    expect(refresh.opts.lockDuration).toBe(30 * 60_000);
  });

  it('enqueues admin-triggered sweeps onto background-sweeps, immediately, and backfills onto positions-sync', async () => {
    const service = queueService({ enabledIntegrations: [chain(1), chain(42161)] });

    await service.enqueuePoolsSync(1, 'uniswap-v4');
    await service.enqueueTokenSecuritySync(1, 'uniswap-v4');
    await service.enqueueTokenPriceSync(1, 'uniswap-v4');
    await service.enqueuePoolsSyncAll();
    await service.enqueueBackfill(1, 'uniswap-v4');

    expect(addedNames(sweepsQueue())).toEqual([
      'pool-sync',
      'token-security-sync',
      'token-price-sync',
      'pool-sync',
      'pool-sync',
    ]);
    // An admin "sync now" is not staggered.
    for (const [, , options] of sweepsQueue().add.mock.calls) expect(options.delay).toBeUndefined();
    expect(addedNames(positionsQueue())).toEqual(['backfill']);
    // Admin triggers are never de-duplicated: an operator's "sync now" must run.
    for (const [, , options] of sweepsQueue().add.mock.calls) expect(options.deduplication).toBeUndefined();
  });

  it('registers sweep crons on background-sweeps, staggered per chain, and refresh crons on positions-refresh around them', async () => {
    const service = queueService({
      positionsSyncCronEnabled: true,
      positionsSyncIntervalMs: 1_800_000,
      poolsSyncCronEnabled: true,
      poolsSyncIntervalMs: 3_600_000,
      tokenSecuritySyncEnabled: true,
      tokenSecuritySyncIntervalMs: 21_600_000,
      tokenPriceSyncEnabled: true,
      tokenPriceSyncIntervalMs: 300_000,
      positionFeeRefreshEnabled: true,
      positionFeeRefreshIntervalMs: 3_600_000,
      evmRpcUrls: new Map([[1, 'https://rpc.example'], [43114, 'https://rpc.example'], [42161, 'https://rpc.example'], [4663, 'https://rpc.example']]),
      enabledIntegrations: [chain(1), chain(43114), chain(42161), chain(4663)],
    });
    await service.onModuleInit();

    const repeats = (queue: { add: ReturnType<typeof vi.fn> }, name: string) =>
      queue.add.mock.calls.filter((c) => c[0] === name && c[2]?.repeat).map((c) => c[2]);

    // positions-sync holds no cron at all any more.
    expect(positionsQueue().add.mock.calls.filter((c) => c[2]?.repeat)).toEqual([]);
    expect(refreshQueue().add.mock.calls.filter((c) => c[2]?.repeat).map((c) => c[0])).toEqual([
      'refresh',
      'refresh',
      'refresh',
      'refresh',
    ]);

    // Hourly pool sync: 1 → :05, 43114 → :20, 42161 → :35, 4663 → :50 (UTC).
    expect(repeats(sweepsQueue(), 'pool-sync')).toEqual([
      { jobId: 'repeat-pool-sync-1-uniswap-v4', repeat: { pattern: '5 * * * *', tz: 'UTC' } },
      { jobId: 'repeat-pool-sync-43114-uniswap-v4', repeat: { pattern: '20 * * * *', tz: 'UTC' } },
      { jobId: 'repeat-pool-sync-42161-uniswap-v4', repeat: { pattern: '35 * * * *', tz: 'UTC' } },
      { jobId: 'repeat-pool-sync-4663-uniswap-v4', repeat: { pattern: '50 * * * *', tz: 'UTC' } },
    ]);
    expect(repeats(sweepsQueue(), 'token-security-sync').map((o) => o.repeat.pattern)).toEqual([
      '5 0,6,12,18 * * *',
      '35 1,7,13,19 * * *',
      '5 3,9,15,21 * * *',
      '35 4,10,16,22 * * *',
    ]);
    expect(repeats(sweepsQueue(), 'token-price-sync').map((o) => o.repeat.pattern.split(' ')[0]!.split(',')[0])).toEqual([
      '0',
      '1',
      '2',
      '3',
    ]);
    expect(repeats(sweepsQueue(), 'position-fee-refresh')).toHaveLength(4);
    // No sweep is left on the aligned `every` schedule that fired every chain at :00.
    for (const name of SWEEP_JOB_NAMES) {
      for (const o of repeats(sweepsQueue(), name)) expect(o.repeat.every).toBeUndefined();
    }

    // Refresh, every 30 min: the even shares :00/:07/:15/:22 move forward to
    // the first minutes no sweep starts at (token-price claims minutes 0–3 of
    // every five; pool-sync and the fee backstop :05/:20/:35/:50).
    const refreshes = repeats(refreshQueue(), 'refresh');
    expect(refreshes).toEqual([
      { jobId: 'repeat-refresh-1-uniswap-v4', repeat: { pattern: '4,34 * * * *', tz: 'UTC' } },
      { jobId: 'repeat-refresh-43114-uniswap-v4', repeat: { pattern: '9,39 * * * *', tz: 'UTC' } },
      { jobId: 'repeat-refresh-42161-uniswap-v4', repeat: { pattern: '19,49 * * * *', tz: 'UTC' } },
      { jobId: 'repeat-refresh-4663-uniswap-v4', repeat: { pattern: '24,54 * * * *', tz: 'UTC' } },
    ]);
    const sweepMinutes = new Set(
      SWEEP_JOB_NAMES.flatMap((name) => repeats(sweepsQueue(), name).flatMap((o) => repeatMinutes(o.repeat))),
    );
    const refreshMinutes = refreshes.flatMap((o) => repeatMinutes(o.repeat));
    // Never the same minute as a sweep, never the same minute as another chain.
    for (const m of refreshMinutes) expect(sweepMinutes.has(m)).toBe(false);
    expect(new Set(refreshMinutes).size).toBe(refreshMinutes.length);
  });

  it('staggers boot kicks by chain (i × 2 min) on background-sweeps', async () => {
    const service = queueService({
      poolsSyncCronEnabled: true,
      poolsSyncIntervalMs: 3_600_000,
      tokenSecuritySyncEnabled: true,
      tokenSecuritySyncIntervalMs: 21_600_000,
      tokenPriceSyncEnabled: true,
      tokenPriceSyncIntervalMs: 300_000,
      positionFeeRefreshEnabled: true,
      positionFeeRefreshIntervalMs: 3_600_000,
      evmRpcUrls: new Map([[1, 'https://rpc.example'], [42161, 'https://rpc.example'], [4663, 'https://rpc.example']]),
      enabledIntegrations: [chain(1), chain(42161), chain(4663)],
    });
    await service.onModuleInit();

    expect(BOOT_KICK_STAGGER_MS).toBe(120_000);
    for (const name of SWEEP_JOB_NAMES) {
      const kicks = sweepsQueue().add.mock.calls.filter((c) => c[0] === name && !c[2]?.repeat);
      expect(kicks.map((c) => (c[1] as { chainId: number }).chainId)).toEqual([1, 42161, 4663]);
      expect(kicks.map((c) => c[2].delay)).toEqual([undefined, 120_000, 240_000]);
      // De-duplicated per (job, chain): a restart that KEPT the queue (the
      // default since 2026-10-03) must not stack a second walk behind the
      // previous boot's still-pending kick.
      expect(kicks.map((c) => c[2].deduplication)).toEqual([
        { id: `boot-${name}-1-uniswap-v4` },
        { id: `boot-${name}-42161-uniswap-v4` },
        { id: `boot-${name}-4663-uniswap-v4` },
      ]);
    }
    expect(positionsQueue().add.mock.calls.filter((c) => !c[2]?.repeat)).toEqual([]);
  });

  it('with QUEUE_CLEAR_ON_BOOT=true clears positions-sync, positions-refresh AND background-sweeps, each on its own, never live-refresh or payments', async () => {
    const service = queueService({ queueClearOnBoot: true });
    positionsQueue().obliterate.mockRejectedValueOnce(new Error('redis blip'));

    await service.onModuleInit();

    expect(positionsQueue().obliterate).toHaveBeenCalledWith({ force: true });
    // A failed positions clear does not leave the other queues uncleared.
    expect(sweepsQueue().obliterate).toHaveBeenCalledWith({ force: true });
    expect(refreshQueue().obliterate).toHaveBeenCalledWith({ force: true });
    expect(mocks.queues.find((q) => q.name === 'position-live-refresh')!.obliterate).not.toHaveBeenCalled();
    // This service never even constructs the payments queue.
    expect(mocks.queues.map((q) => q.name).sort()).toEqual(
      [BACKGROUND_SWEEPS_QUEUE, 'position-live-refresh', POSITIONS_REFRESH_QUEUE, POSITIONS_SYNC_QUEUE].sort(),
    );
  });

  it('keeps the sweeps and refresh queues by default too', async () => {
    const service = queueService({});
    await service.onModuleInit();
    expect(sweepsQueue().obliterate).not.toHaveBeenCalled();
    expect(refreshQueue().obliterate).not.toHaveBeenCalled();
  });

  it('removes every stale repeatable from all three queues — positions-sync holds no cron any more', async () => {
    const service = queueService({ positionsSyncCronEnabled: true });
    positionsQueue().getRepeatableJobs.mockResolvedValue([
      { name: 'pool-sync', key: 'legacy-pool' },
      { name: 'token-price-sync', key: 'legacy-price' },
      { name: 'refresh', key: 'old-refresh' },
    ]);
    sweepsQueue().getRepeatableJobs.mockResolvedValue([{ name: 'token-security-sync', key: 'old-security' }]);
    refreshQueue().getRepeatableJobs.mockResolvedValue([{ name: 'refresh', key: 'refresh-old-schedule' }]);

    await service.onModuleInit();

    const removed = (q: { removeRepeatableByKey: ReturnType<typeof vi.fn> }) =>
      q.removeRepeatableByKey.mock.calls.map((c) => c[0]);
    expect(removed(positionsQueue()).sort()).toEqual(['legacy-pool', 'legacy-price', 'old-refresh']);
    expect(removed(sweepsQueue())).toEqual(['old-security']);
    expect(removed(refreshQueue())).toEqual(['refresh-old-schedule']);
  });

  it('dispatches by job name on either worker, in the sweep lane', async () => {
    const seen: Array<{ method: string; lane: string; job: string | undefined }> = [];
    const record = (method: string) =>
      vi.fn(async () => {
        const ctx = currentIndexerContext();
        seen.push({ method, lane: ctx.lane, job: ctx.job });
        return { ok: true };
      });
    const syncService = {
      backfillTarget: record('backfill'),
      refreshTarget: record('refresh'),
      recomputeAggregatesTarget: record('recompute-aggregates'),
      interruptedBackfills: vi.fn(async () => []),
    };
    const service = new QueueService(
      baseConfig({ getIntegration: () => chain(1) }) as never,
      syncService as never,
      { registerEnqueue: vi.fn() } as never,
      { refreshPosition: vi.fn() } as never,
      { syncPools: record('pool-sync') } as never,
      { syncChain: record('token-security-sync') } as never,
      { syncChain: record('token-price-sync') } as never,
      { refreshChain: record('position-fee-refresh') } as never,
    );
    await service.onModuleInit();
    const [positionsWorker, sweepsWorker, refreshWorker] = mocks.workers;
    expect(sweepsWorker!.name).toBe(BACKGROUND_SWEEPS_QUEUE);
    expect(refreshWorker!.name).toBe(POSITIONS_REFRESH_QUEUE);

    for (const name of SWEEP_JOB_NAMES) {
      await sweepsWorker!.processor({ name, data: { chainId: 1, protocol: 'uniswap-v4' } });
    }
    // A sweep job an older deployment left on positions-sync runs as itself,
    // not as a refresh.
    await positionsWorker!.processor({ name: 'pool-sync', data: { chainId: 1, protocol: 'uniswap-v4' } });
    // …and a 'refresh' an older deployment left on positions-sync still refreshes.
    await positionsWorker!.processor({ name: 'refresh', data: { chainId: 1, protocol: 'uniswap-v4' } });
    await positionsWorker!.processor({ name: 'recompute-aggregates', data: { chainId: 1, protocol: 'uniswap-v4' } });
    await refreshWorker!.processor({ name: 'refresh', data: { chainId: 1, protocol: 'uniswap-v4' } });

    expect(seen.map((s) => s.method)).toEqual([
      ...SWEEP_JOB_NAMES,
      'pool-sync',
      'refresh',
      'recompute-aggregates',
      'refresh',
    ]);
    for (const s of seen.slice(0, SWEEP_JOB_NAMES.length)) expect(s.lane).toBe('sweep');
    expect(seen.at(-1)).toMatchObject({ lane: 'refresh', job: 'refresh' });
    expect(syncService.recomputeAggregatesTarget).toHaveBeenCalledWith(1, 'uniswap-v4');
  });

  it('passes the BullMQ job id to a backfill as its run key (a retry resumes instead of resetting)', async () => {
    const backfillTarget = vi.fn(async () => ({}));
    const service = new QueueService(
      baseConfig() as never,
      { backfillTarget, refreshTarget: vi.fn(), interruptedBackfills: vi.fn(async () => []) } as never,
      { registerEnqueue: vi.fn() } as never,
      { refreshPosition: vi.fn() } as never,
    );
    await service.onModuleInit();

    await mocks.workers[0]!.processor({
      name: 'backfill',
      id: 'backfill-4663-uniswap-v4-1700000000000',
      data: { chainId: 4663, protocol: 'uniswap-v4', fromStart: true },
    });

    expect(backfillTarget).toHaveBeenCalledWith(4663, 'uniswap-v4', {
      fromStart: true,
      runKey: 'backfill-4663-uniswap-v4-1700000000000',
    });
  });

  it('reports the sweeps and refresh queues in status()', async () => {
    const service = queueService({});
    sweepsQueue().getJobCounts.mockResolvedValue({ waiting: 3, active: 1 });
    refreshQueue().getJobCounts.mockResolvedValue({ waiting: 2, active: 1 });
    const status = await service.status();
    expect(status.sweeps).toEqual({ waiting: 3, active: 1 });
    expect(status.refresh).toEqual({ waiting: 2, active: 1 });
    expect(Object.keys(status).sort()).toEqual(['liveRefresh', 'positions', 'refresh', 'sweeps']);
  });
});

describe('QueueService — resuming an interrupted backfill at boot', () => {
  beforeEach(() => {
    mocks.queues.length = 0;
    mocks.workers.length = 0;
    vi.clearAllMocks();
  });

  const positionsQueue = () => mocks.queues.find((q) => q.name === POSITIONS_SYNC_QUEUE)!;
  const backfillAdds = () => positionsQueue().add.mock.calls.filter((c) => c[0] === 'backfill');

  function boot(interrupted: unknown[] | (() => Promise<unknown[]>), overrides: Record<string, unknown> = {}) {
    return new QueueService(
      baseConfig({ enabledIntegrations: [chain(1), chain(42161), chain(4663)], ...overrides }) as never,
      {
        backfillTarget: vi.fn(),
        refreshTarget: vi.fn(),
        interruptedBackfills: vi.fn(typeof interrupted === 'function' ? interrupted : async () => interrupted),
      } as never,
      { registerEnqueue: vi.fn() } as never,
      { refreshPosition: vi.fn() } as never,
    );
  }

  it('enqueues a cursor-based resume (fromStart=false) for every chain whose flag was left set', async () => {
    const service = boot([chain(1), chain(4663)]);
    await service.onModuleInit();

    expect(backfillAdds().map((c) => c[1])).toEqual([
      { chainId: 1, protocol: 'uniswap-v4', fromStart: false },
      { chainId: 4663, protocol: 'uniswap-v4', fromStart: false },
    ]);
  });

  it('skips a chain that already has a backfill job waiting (the kept queue resumes it)', async () => {
    const service = boot([chain(1), chain(4663)]);
    positionsQueue().getJobs.mockResolvedValue([
      { name: 'backfill', data: { chainId: 4663, protocol: 'uniswap-v4' } },
      { name: 'recompute-aggregates', data: { chainId: 1, protocol: 'uniswap-v4' } },
    ]);
    await service.onModuleInit();

    expect(backfillAdds().map((c) => (c[1] as { chainId: number }).chainId)).toEqual([1]);
    // Only the not-yet-running states count as "already queued".
    expect(positionsQueue().getJobs).toHaveBeenCalledWith(['waiting', 'delayed', 'prioritized', 'paused']);
  });

  it('enqueues nothing when no flag is set', async () => {
    const service = boot([]);
    await service.onModuleInit();
    expect(backfillAdds()).toEqual([]);
    expect(positionsQueue().getJobs).not.toHaveBeenCalled();
  });

  // The wipe discards the BullMQ job, never the resumability: cursor + flag
  // live in Mongo, and the resume is enqueued AFTER the clear.
  it('still resumes after QUEUE_CLEAR_ON_BOOT=true wiped the queue', async () => {
    const service = boot([chain(4663)], { queueClearOnBoot: true });
    await service.onModuleInit();

    expect(positionsQueue().obliterate).toHaveBeenCalledWith({ force: true });
    expect(backfillAdds().map((c) => c[1])).toEqual([{ chainId: 4663, protocol: 'uniswap-v4', fromStart: false }]);
    const backfillAddOrder = positionsQueue().add.mock.invocationCallOrder[
      positionsQueue().add.mock.calls.findIndex((c) => c[0] === 'backfill')
    ]!;
    expect(positionsQueue().obliterate.mock.invocationCallOrder[0]).toBeLessThan(backfillAddOrder);
  });

  it('never fails boot when the check itself fails', async () => {
    const service = boot(async () => {
      throw new Error('mongo down');
    });
    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(backfillAdds()).toEqual([]);
  });
});

describe('staggeredRepeat', () => {
  it('spreads hourly chains to :05/:20/:35/:50', () => {
    expect([0, 1, 2, 3].map((i) => staggeredRepeat(3_600_000, i, 4))).toEqual([
      { pattern: '5 * * * *', tz: 'UTC' },
      { pattern: '20 * * * *', tz: 'UTC' },
      { pattern: '35 * * * *', tz: 'UTC' },
      { pattern: '50 * * * *', tz: 'UTC' },
    ]);
  });

  it('keeps one chain at :05 every hour', () => {
    expect(staggeredRepeat(3_600_000, 0, 1)).toEqual({ pattern: '5 * * * *', tz: 'UTC' });
  });

  it('spreads multi-hour intervals across the whole interval, at the same rate', () => {
    // 6h: 90 min apart, each still exactly 4 runs a day.
    expect(staggeredRepeat(21_600_000, 0, 4)).toEqual({ pattern: '5 0,6,12,18 * * *', tz: 'UTC' });
    expect(staggeredRepeat(21_600_000, 1, 4)).toEqual({ pattern: '35 1,7,13,19 * * *', tz: 'UTC' });
    expect(staggeredRepeat(86_400_000, 2, 4)).toEqual({ pattern: '5 12 * * *', tz: 'UTC' });
  });

  it('spreads sub-hourly intervals within one interval, at the same rate', () => {
    // 5 min: one minute apart, 12 runs an hour each.
    const five = [0, 1, 2, 3].map((i) => staggeredRepeat(300_000, i, 4));
    expect(five[1]).toEqual({ pattern: '1,6,11,16,21,26,31,36,41,46,51,56 * * * *', tz: 'UTC' });
    for (const r of five) expect(('pattern' in r ? r.pattern : '').split(' ')[0]!.split(',')).toHaveLength(12);
    // 15 min (the Phase 0 token-price setting).
    expect([0, 1, 2, 3].map((i) => (staggeredRepeat(900_000, i, 4) as { pattern: string }).pattern)).toEqual([
      '5,20,35,50 * * * *',
      '8,23,38,53 * * * *',
      '12,27,42,57 * * * *',
      '1,16,31,46 * * * *',
    ]);
  });

  it('keeps `every` for intervals cron cannot express exactly', () => {
    expect(staggeredRepeat(7 * 60_000, 1, 4)).toEqual({ every: 7 * 60_000 });
    expect(staggeredRepeat(90 * 60_000, 1, 4)).toEqual({ every: 90 * 60_000 });
    expect(staggeredRepeat(5 * 3_600_000, 1, 4)).toEqual({ every: 5 * 3_600_000 });
    expect(staggeredRepeat(30_000, 0, 1)).toEqual({ every: 30_000 });
  });

  it('takes an explicit base minute', () => {
    expect([0, 1, 2, 3].map((i) => (staggeredRepeat(1_800_000, i, 4, 0) as { pattern: string }).pattern)).toEqual([
      '0,30 * * * *',
      '7,37 * * * *',
      '15,45 * * * *',
      '22,52 * * * *',
    ]);
  });
});

describe('refreshRepeats', () => {
  const patterns = (rs: ReturnType<typeof refreshRepeats>) => rs.map((r) => ('pattern' in r ? r.pattern : r));

  it('spreads chains evenly from :00 when nothing else is scheduled', () => {
    expect(patterns(refreshRepeats(1_800_000, 4, new Set()))).toEqual([
      '0,30 * * * *',
      '7,37 * * * *',
      '15,45 * * * *',
      '22,52 * * * *',
    ]);
  });

  it('moves a chain forward past a minute a sweep starts at, never onto another chain', () => {
    // :07 and :08 are taken by sweeps, so chain 1 lands on :09.
    expect(patterns(refreshRepeats(1_800_000, 4, new Set([7, 8, 37, 38])))).toEqual([
      '0,30 * * * *',
      '9,39 * * * *',
      '15,45 * * * *',
      '22,52 * * * *',
    ]);
    // A chain pushed onto the next one's even share pushes that one on in turn.
    const early = new Set([0, 1, 2, 3, 4, 5, 6, 30, 31, 32, 33, 34, 35, 36]);
    expect(patterns(refreshRepeats(1_800_000, 4, early))).toEqual([
      '7,37 * * * *',
      '8,38 * * * *',
      '15,45 * * * *',
      '22,52 * * * *',
    ]);
  });

  it('settles for a minute no other refresh holds when every free minute is a sweep\'s', () => {
    const everyMinute = new Set(Array.from({ length: 60 }, (_, m) => m));
    const minutes = refreshRepeats(1_800_000, 4, everyMinute).flatMap(repeatMinutes);
    expect(new Set(minutes).size).toBe(minutes.length);
    expect(patterns(refreshRepeats(1_800_000, 4, everyMinute))).toEqual(
      patterns(refreshRepeats(1_800_000, 4, new Set())),
    );
  });

  it('keeps `every` for every chain when cron cannot express the interval', () => {
    expect(refreshRepeats(7 * 60_000, 3, new Set())).toEqual([
      { every: 7 * 60_000 },
      { every: 7 * 60_000 },
      { every: 7 * 60_000 },
    ]);
  });
});

function chain(chainId: number) {
  return { chainId, protocol: 'uniswap-v4', subgraphUrl: 'https://example.com/subgraph', enabled: true };
}

describe('QueueService — shutdown', () => {
  beforeEach(() => {
    mocks.queues.length = 0;
    mocks.workers.length = 0;
    vi.clearAllMocks();
  });
  afterEach(() => {
    resetShutdownForTests();
    vi.useRealTimers();
  });

  const never = () => new Promise<never>(() => undefined);
  const data = { chainId: 4663, protocol: 'uniswap-v4' };

  it('long jobs return { interrupted } the moment the shutdown begins (BullMQ records them completed, not stalled); the healer is left to the stalled checker', async () => {
    const syncService = {
      backfillTarget: vi.fn(never),
      refreshTarget: vi.fn(never),
      recomputeAggregatesTarget: vi.fn(never),
      interruptedBackfills: vi.fn(async () => []),
    };
    const service = new QueueService(
      baseConfig() as never,
      syncService as never,
      { registerEnqueue: vi.fn() } as never,
      { refreshPosition: vi.fn() } as never,
      { syncPools: vi.fn(never) } as never,
    );
    await service.onModuleInit();
    const [positionsWorker, sweepsWorker, refreshWorker] = mocks.workers;

    const backfill = positionsWorker!.processor({ name: 'backfill', id: 'b1', data });
    const refresh = refreshWorker!.processor({ name: 'refresh', id: 'r1', data });
    const poolSync = sweepsWorker!.processor({ name: 'pool-sync', id: 'p1', data });
    let healerSettled = false;
    void positionsWorker!.processor({ name: 'recompute-aggregates', id: 'h1', data }).finally(() => {
      healerSettled = true;
    });

    await service.onModuleDestroy();

    expect(isShuttingDown()).toBe(true);
    await expect(backfill).resolves.toEqual({ interrupted: 'shutdown' });
    await expect(refresh).resolves.toEqual({ interrupted: 'shutdown' });
    await expect(poolSync).resolves.toEqual({ interrupted: 'shutdown' });
    await new Promise((r) => setTimeout(r, 0));
    expect(healerSettled).toBe(false);
    for (const worker of mocks.workers) expect(worker.close).toHaveBeenCalledTimes(1);
    for (const queue of mocks.queues) expect(queue.close).toHaveBeenCalledTimes(1);
  });

  it('a job that finishes before the shutdown returns its own result', async () => {
    const service = new QueueService(
      baseConfig() as never,
      { backfillTarget: vi.fn(async () => ({ upserted: 7 })), refreshTarget: vi.fn(), interruptedBackfills: vi.fn(async () => []) } as never,
      { registerEnqueue: vi.fn() } as never,
      { refreshPosition: vi.fn() } as never,
    );
    await service.onModuleInit();
    await expect(mocks.workers[0]!.processor({ name: 'backfill', id: 'b2', data })).resolves.toEqual({ upserted: 7 });
  });

  it('a worker that will not close holds the shutdown no longer than its grace, and the rest still closes', async () => {
    vi.useFakeTimers();
    const service = queueService();
    await service.onModuleInit();
    mocks.workers[0]!.close.mockImplementation(never);
    const done = service.onModuleDestroy();
    let finished = false;
    void done.then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(7_999);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(finished).toBe(true);
    for (const queue of mocks.queues) expect(queue.close).toHaveBeenCalledTimes(1);
  });
});

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    redisUrl: 'redis://localhost:6379',
    positionsSyncCronEnabled: false,
    positionsSyncIntervalMs: 300_000,
    transactionsSyncEnabled: true,
    liveRefreshEnabled: false,
    liveRefreshConcurrency: 8,
    evmRpcUrls: new Map(),
    enabledIntegrations: [chain(1)],
    ...overrides,
  };
}

function queueService(overrides: Record<string, unknown> = {}): QueueService {
  return new QueueService(
    baseConfig(overrides) as never,
    { backfillTarget: vi.fn(), refreshTarget: vi.fn(), interruptedBackfills: vi.fn(async () => []) } as never,
    { registerEnqueue: vi.fn() } as never,
    { refreshPosition: vi.fn() } as never,
  );
}
