/*
 * I1 cross-package (design §17): SPLIT ROLES over ONE Redis, and DEPLOY OVERLAP.
 *
 * Each "process" below is its own module graph (`vi.resetModules()` before its
 * imports), so `PROCESS_ROLE`, the lease runners and the shutdown signal are
 * per process exactly as in a real fleet — one graph would share them. Every
 * process builds the real QueueService, LiveEventListenerService,
 * SyncService (+ the real FlowLocks), FeeWorkerLeaseHolder and
 * PositionFeeRefreshService, all over one shared FakeLeaseRedis (leases,
 * flow locks, the scheduler) — BullMQ, the indexer and Mongo are fakes.
 *
 *  - role `all` + leases off (the default) = today: four Workers, the
 *    scheduler steps inline, the live loop without a lease, the fee pass
 *    ticking unfenced, and NOT ONE Redis call on the coordination client;
 *  - api ×1 + sync + fee ×2: 0 Workers on api and fee, the scheduler and the
 *    live loop held by sync only, exactly one `fee-worker` holder, handoff on
 *    stop within one retry;
 *  - deploy overlap (a new sync boots while the old one walks a backfill): the
 *    resume job is RE-DELAYED (never completed) while the old walk holds the
 *    flow lock, runs once it is released, and the scheduler + live lease move
 *    to the new process when the old one stops.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeFeeRedis } from '../fee-p3/fake-redis.js';
import { CHAIN as FEE_CHAIN, PROTO as FEE_PROTO } from '../fee-p3/service-harness.js';
import { FakeLeaseRedis, flush } from '../process-roles/fakes.js';

const mocks = vi.hoisted(() => ({
  queues: [] as Array<Record<string, ReturnType<typeof vi.fn>> & { name: string }>,
  workers: [] as Array<{
    name: string;
    processor: (job: unknown, token?: string) => Promise<unknown>;
    opts: { concurrency?: number };
    close: ReturnType<typeof vi.fn>;
  }>,
  gqlRequest: vi.fn(async () => ({ positions: [] })),
}));

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(() => ({ on: vi.fn(), ping: vi.fn(async () => 'PONG'), quit: vi.fn(async () => undefined) })),
}));

vi.mock('graphql-request', () => ({
  GraphQLClient: vi.fn().mockImplementation(() => ({ request: mocks.gqlRequest })),
  gql: (strings: TemplateStringsArray) => strings.join(''),
}));

vi.mock('bullmq', () => {
  class DelayedError extends Error {
    constructor(message = 'bullmq:movedToDelayed') {
      super(message);
      this.name = 'DelayedError';
    }
  }
  return {
    Job: class {},
    DelayedError,
    Queue: vi.fn().mockImplementation((name: string) => {
      const queue = {
        name,
        add: vi.fn(async (_n: string, _d: unknown, o?: { jobId?: string }) => ({ id: o?.jobId })),
        close: vi.fn(async () => undefined),
        getJobCounts: vi.fn(async () => ({})),
        getRepeatableJobs: vi.fn(async () => []),
        removeRepeatableByKey: vi.fn(async () => undefined),
        obliterate: vi.fn(async () => undefined),
        getJobs: vi.fn(async () => []),
        setGlobalConcurrency: vi.fn(async () => undefined),
      };
      mocks.queues.push(queue as never);
      return queue;
    }),
    Worker: vi.fn().mockImplementation((name: string, processor: (job: unknown) => Promise<unknown>, opts: { concurrency?: number }) => {
      const worker = { name, processor, opts, close: vi.fn(async () => undefined), on: vi.fn() };
      mocks.workers.push(worker);
      return worker;
    }),
  };
});

const NS = 'split';
const CHAIN = 1;
const PROTO = 'uniswap-v4';
const integration = { chainId: CHAIN, protocol: PROTO, enabled: true, subgraphUrl: 'https://indexer.test/v1/graphql' };
const leaseKeyOf = (name: string) => `tw:lease:v1:${NS}:${name}`;

type Role = 'all' | 'api' | 'sync' | 'fee';

interface Proc {
  role: Role;
  queue: { onModuleInit(): Promise<void>; onModuleDestroy(): Promise<void>; scheduler?: { held: boolean; owner: string; mode: string } };
  live: { onModuleInit(): Promise<void>; onModuleDestroy(): Promise<void> };
  holder: { applies: boolean; runner?: { held: boolean; owner: string; fence?: number; stillHeld(): boolean }; onModuleInit(): void; onModuleDestroy(): Promise<void> };
  fee: { service: { refreshChain(c: number, p: string): Promise<{ skipped?: string; finished?: string[] }> } };
  workers: typeof mocks.workers;
  queues: typeof mocks.queues;
  /** The positions-sync processor of this process (undefined where no Workers run). */
  positionsWorker?: (typeof mocks.workers)[number];
  adapter: { fetchPositions: ReturnType<typeof vi.fn> };
  syncRepo: Record<string, ReturnType<typeof vi.fn>>;
  stop(): Promise<void>;
}

/** Let fake timers and promise chains run together (a stop awaits a 100 ms poll sleep). */
async function settle(ms = 0): Promise<void> {
  await flush(30);
  if (ms > 0) await vi.advanceTimersByTimeAsync(ms);
  await flush(30);
}

async function boot(
  role: Role,
  redis: FakeLeaseRedis,
  feeRedis: FakeFeeRedis,
  opts: { leases?: 'on' | 'off'; startRunGate?: Promise<void> } = {},
): Promise<Proc> {
  vi.resetModules();
  const roles = await import('../../src/common/process-role.js');
  roles.configureProcessRole({ processRole: role, ...(opts.leases ? { processLeases: opts.leases } : {}) });
  const { QueueService } = await import('../../src/queues/queue.service.js');
  const { LiveEventListenerService } = await import('../../src/sync/live-event-listener.service.js');
  const { SyncService } = await import('../../src/sync/sync.service.js');
  const { FlowLocks } = await import('../../src/common/flow-lock.js');
  const { FeeWorkerLeaseHolder, feeWorkerLeaseView } = await import('../../src/common/fee-coordination.js');
  const { makeP3Harness } = await import('../fee-p3/service-harness.js');

  const coordination = { client: async () => redis as never, namespace: NS, close: async () => undefined };
  const config = {
    redisUrl: 'redis://localhost:6379',
    positionsSyncCronEnabled: true,
    positionsSyncIntervalMs: 1_800_000,
    liveRefreshEnabled: true,
    liveRefreshConcurrency: 25,
    livePollMinMs: 1_000,
    livePollIntervalFallbackMs: 1_000,
    positionFeeRefreshEnabled: true,
    evmRpcUrls: new Map(),
    testMode: false,
    testModePositionLimit: 0,
    positionsBackfillBuckets: 1,
    enabledIntegrations: [integration],
    getIntegration: () => integration,
  };
  const cursor = { chainId: CHAIN, protocol: PROTO, lastTimestamp: 0, lastPositionId: '', lastBlockNumber: 0, liveBlockNumber: 100 };
  const syncRepo = {
    startRun: vi.fn(async () => {
      if (opts.startRunGate) await opts.startRunGate;
      return `run-${role}`;
    }),
    finishRun: vi.fn(async () => undefined),
    getCursor: vi.fn(async () => ({ ...cursor })),
    markCursorSuccess: vi.fn(async () => undefined),
    markCursorFailure: vi.fn(async () => undefined),
    markBackfillStarted: vi.fn(async () => undefined),
    markBackfillFinished: vi.fn(async () => undefined),
    touchBackfillHeartbeat: vi.fn(async () => undefined),
    isBackfillInProgress: vi.fn(async () => false),
    resetCursorForRun: vi.fn(async () => true),
    lastBackfillStartedAt: vi.fn(async () => undefined),
    markLiveCursor: vi.fn(async () => undefined),
  };
  const adapter = {
    recomputeMode: 'aggregates',
    fetchPositions: vi.fn(async () => ({
      positions: [],
      seenPositionIds: [],
      maxTimestamp: 0,
      maxPositionId: '',
      maxBlockNumber: 0,
      hasMore: false,
      flushedCount: 0,
    })),
  };
  const sync = new SyncService(
    config as never,
    { resolve: () => adapter } as never,
    { upsertMany: vi.fn(async () => 0), findActiveRefsWithTokensPage: vi.fn(async () => []), findHotClosedCandidatesPage: vi.fn(async () => []), markMissingStale: vi.fn(async () => 0) } as never,
    syncRepo as never,
    { prefetchPrices: vi.fn(async () => undefined), currentNativeUsd: vi.fn(async () => 2500) } as never,
    { repriceAndHealForRefresh: vi.fn(async () => undefined) } as never,
    { recompute: vi.fn() } as never,
    undefined,
    new FlowLocks(coordination as never),
  );
  const live = new LiveEventListenerService(
    config as never,
    syncRepo as never,
    { resolve: () => ({ recomputeMode: 'aggregates' }) } as never,
    undefined,
    coordination as never,
  );
  const holder = new FeeWorkerLeaseHolder(config as never, coordination as never);
  // FEE_COORDINATION as the factory builds it (leases on), with redis-state on
  // the fee fake (signal scripts) and the lease view on this role's runner.
  const leasesOn = roles.leasesEnabled();
  const coord = leasesOn
    ? {
        leasesEnabled: true,
        namespace: NS,
        stateRedis: async () => feeRedis,
        modelsRedis: async () => feeRedis,
        ...(holder.runner ? { lease: feeWorkerLeaseView(holder.runner) } : {}),
      }
    : undefined;
  const fee = makeP3Harness({ coord: coord as never });

  const workersBefore = mocks.workers.length;
  const queuesBefore = mocks.queues.length;
  const queue = new QueueService(
    config as never,
    sync,
    live,
    { refreshPosition: vi.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    undefined,
    coordination as never,
  );
  const queues = mocks.queues.slice(queuesBefore);
  holder.onModuleInit();
  await queue.onModuleInit();
  await live.onModuleInit();
  await settle();
  const workers = mocks.workers.slice(workersBefore);
  return {
    role,
    queue: queue as never,
    live,
    holder: holder as never,
    fee: fee as never,
    workers,
    queues,
    positionsWorker: workers.find((w) => w.name === 'positions-sync'),
    adapter,
    syncRepo,
    async stop() {
      const done = Promise.all([queue.onModuleDestroy(), live.onModuleDestroy(), holder.onModuleDestroy()]);
      await settle(500);
      await done;
    },
  };
}

/** The process's live-loop lease runner for the chain (undefined where no loop runs). */
function liveRunner(p: Proc): { owner: string; held: boolean } | undefined {
  return (p.live as unknown as { runners: Map<string, { owner: string; held: boolean }> }).runners.get(`${CHAIN}:${PROTO}`);
}

function backfillJob(id = 'resume-1') {
  return {
    id,
    name: 'backfill',
    data: { chainId: CHAIN, protocol: PROTO },
    timestamp: Date.now(),
    moveToDelayed: vi.fn(async () => undefined),
  };
}

let procs: Proc[] = [];

beforeEach(() => {
  mocks.queues.length = 0;
  mocks.workers.length = 0;
  procs = [];
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
});

afterEach(async () => {
  for (const p of procs.splice(0)) await p.stop().catch(() => undefined);
  vi.useRealTimers();
  vi.resetModules();
});

async function start(role: Role, redis: FakeLeaseRedis, feeRedis: FakeFeeRedis, opts: Parameters<typeof boot>[3] = {}) {
  const p = await boot(role, redis, feeRedis, opts);
  procs.push(p);
  return p;
}

describe('role all + leases off (the default) = today, end to end', () => {
  it('four Workers, scheduler steps inline, live loop unleased, fee pass ticking — and not one Redis call', async () => {
    const redis = new FakeLeaseRedis(() => Date.now());
    const all = await start('all', redis, new FakeFeeRedis());
    expect(all.workers.map((w) => w.name)).toEqual(['positions-sync', 'position-live-refresh', 'background-sweeps', 'positions-refresh']);
    expect(all.queue.scheduler).toBeUndefined();
    for (const q of all.queues) expect(q.setGlobalConcurrency).not.toHaveBeenCalled();
    expect(all.queues.some((q) => q.add.mock.calls.some((c) => (c[2] as { repeat?: unknown })?.repeat))).toBe(true); // crons inline
    expect(all.holder.applies).toBe(false);
    expect((await all.fee.service.refreshChain(FEE_CHAIN, FEE_PROTO)).skipped).toBeUndefined(); // leases off → the worker, unfenced
    // A backfill through the real Worker processor runs (FlowLocks pass through).
    await expect(all.positionsWorker!.processor(backfillJob('all-1'), 'tok')).resolves.toMatchObject({ chainId: CHAIN });
    expect(all.adapter.fetchPositions).toHaveBeenCalledTimes(1);
    await settle(2_000); // the live loop polled without any lease
    expect(mocks.gqlRequest).toHaveBeenCalled();
    expect(redis.calls).toEqual([]); // no lease, no flow lock, no status, no memory sample: today
  });
});

describe('split roles over ONE Redis: api + sync + fee ×2', () => {
  it('Workers only on sync; scheduler + live lease on sync; exactly one fee-worker; handoff on stop', async () => {
    const redis = new FakeLeaseRedis(() => Date.now());
    const feeRedis = new FakeFeeRedis();
    const api = await start('api', redis, feeRedis);
    const sync = await start('sync', redis, feeRedis);
    const feeA = await start('fee', redis, feeRedis);
    const feeB = await start('fee', redis, feeRedis);
    await settle();

    // Workers: 0 on api and fee, the four on sync.
    expect(api.workers).toEqual([]);
    expect(feeA.workers).toEqual([]);
    expect(feeB.workers).toEqual([]);
    expect(sync.workers).toHaveLength(4);
    // Scheduler: sync only, and held; global concurrency applied there only.
    expect(api.queue.scheduler).toBeUndefined();
    expect(feeA.queue.scheduler).toBeUndefined();
    expect(sync.queue.scheduler?.held).toBe(true);
    expect(redis.kv.get(leaseKeyOf('scheduler'))?.v).toBe(sync.queue.scheduler?.owner);
    expect(sync.queues.find((q) => q.name === 'positions-refresh')!.setGlobalConcurrency).toHaveBeenCalledWith(1);
    for (const q of [...api.queues, ...feeA.queues]) expect(q.setGlobalConcurrency).not.toHaveBeenCalled();
    // The live loop: one lease for the chain, held by sync; api / fee start no loop at all.
    expect(redis.kv.get(leaseKeyOf(`live:${CHAIN}:${PROTO}`))?.v).toBe(liveRunner(sync)?.owner);
    for (const p of [api, feeA, feeB]) expect(liveRunner(p)).toBeUndefined();
    // fee-worker: exactly one holder among the fee processes; api / sync never take part.
    expect(api.holder.applies).toBe(false);
    expect(sync.holder.applies).toBe(false);
    const held = [feeA, feeB].filter((p) => p.holder.runner!.held);
    expect(held).toHaveLength(1);
    const [holder, standby] = held[0] === feeA ? [feeA, feeB] : [feeB, feeA];
    expect(redis.kv.get(leaseKeyOf('fee-worker'))?.v).toBe(holder.holder.runner!.owner);
    // Only the holder ticks; api / sync / the standby skip (the BullMQ backstop is a no-op there).
    expect((await holder.fee.service.refreshChain(FEE_CHAIN, FEE_PROTO)).skipped).toBeUndefined();
    for (const p of [api, sync, standby]) {
      expect((await p.fee.service.refreshChain(FEE_CHAIN, FEE_PROTO)).skipped).toBe('not the fee-worker lease holder');
    }
    const firstFence = holder.holder.runner!.fence!;

    // Handoff: the holder stops (releases), the standby takes over within one retry.
    await holder.stop();
    procs = procs.filter((p) => p !== holder);
    await settle(10_000);
    expect(standby.holder.runner!.held).toBe(true);
    expect(standby.holder.runner!.fence).toBeGreaterThan(firstFence);
    expect((await standby.fee.service.refreshChain(FEE_CHAIN, FEE_PROTO)).skipped).toBeUndefined();
  });
});

describe('deploy overlap: a new sync boots while the old one walks a backfill', () => {
  it('the resume job is re-delayed (never completed) while the old walk holds the flow lock; one walk at a time; leases move on stop', async () => {
    const redis = new FakeLeaseRedis(() => Date.now());
    const feeRedis = new FakeFeeRedis();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const oldSync = await start('sync', redis, feeRedis, { startRunGate: gate });
    // The old process starts walking (blocked inside its walk, holding the flow lock).
    const oldWalk = oldSync.positionsWorker!.processor(backfillJob('walk-old'), 'tok-old');
    await settle();
    expect(redis.kv.get(leaseKeyOf(`flow:backfill:${CHAIN}:${PROTO}`))).toBeDefined();

    // The new process boots beside it: Workers yes, the scheduler / live lease stay with the old one.
    const newSync = await start('sync', redis, feeRedis);
    expect(newSync.workers).toHaveLength(4);
    expect(newSync.queue.scheduler?.held).toBe(false);
    expect(oldSync.queue.scheduler?.held).toBe(true);

    // Its boot resume of the same chain: held elsewhere → RE-DELAYED, nothing walked.
    const resume = backfillJob('resume-new');
    await expect(newSync.positionsWorker!.processor(resume, 'tok-new')).rejects.toMatchObject({ name: 'DelayedError' });
    expect(resume.moveToDelayed).toHaveBeenCalledTimes(1);
    expect(newSync.syncRepo.startRun).not.toHaveBeenCalled();
    expect(newSync.adapter.fetchPositions).not.toHaveBeenCalled();

    // The old walk finishes and releases the lock; the re-delayed job then runs, once.
    release();
    await expect(oldWalk).resolves.toMatchObject({ chainId: CHAIN });
    expect(oldSync.adapter.fetchPositions).toHaveBeenCalledTimes(1);
    expect(redis.kv.get(leaseKeyOf(`flow:backfill:${CHAIN}:${PROTO}`))).toBeUndefined();
    await expect(newSync.positionsWorker!.processor(backfillJob('resume-new'), 'tok-new-2')).resolves.toMatchObject({ chainId: CHAIN });
    expect(newSync.adapter.fetchPositions).toHaveBeenCalledTimes(1);

    // The old process stops: the scheduler and the live loop move to the new one within one retry.
    const liveKey = leaseKeyOf(`live:${CHAIN}:${PROTO}`);
    expect(redis.kv.get(liveKey)?.v).toBe(liveRunner(oldSync)?.owner);
    expect(liveRunner(newSync)?.held).toBe(false); // standby
    await oldSync.stop();
    procs = procs.filter((p) => p !== oldSync);
    await settle(10_000);
    expect(newSync.queue.scheduler?.held).toBe(true);
    expect(redis.kv.get(leaseKeyOf('scheduler'))?.v).toBe(newSync.queue.scheduler?.owner);
    expect(liveRunner(newSync)?.held).toBe(true);
    expect(redis.kv.get(liveKey)?.v).toBe(liveRunner(newSync)?.owner);
    expect(newSync.queues.find((q) => q.name === 'positions-sync')!.setGlobalConcurrency).toHaveBeenCalledWith(10);
  });
});
