import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queues: [] as Array<Record<string, ReturnType<typeof vi.fn>> & { name: string }>,
  workers: [] as Array<{
    name: string;
    processor: (job: unknown, token?: string) => Promise<unknown>;
    opts: { concurrency?: number };
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

import {
  BACKGROUND_SWEEPS_QUEUE,
  POSITIONS_REFRESH_QUEUE,
  POSITIONS_SYNC_QUEUE,
  POSITION_LIVE_REFRESH_QUEUE,
  QueueService,
  heldBackfillRedelayMs,
  resolveRefreshQueueConcurrency,
} from '../../src/queues/queue.service.js';
import { configureProcessRole, resetProcessRoleForTests } from '../../src/common/process-role.js';
import { leaseKey } from '../../src/common/coordination-redis.js';
import { resetLeaseRunnersForTests } from '../../src/common/lease-runner.js';
import { resetShutdownForTests } from '../../src/common/shutdown.js';
import { FakeLeaseRedis, flush } from './fakes.js';

const services: QueueService[] = [];

beforeEach(() => {
  mocks.queues.length = 0;
  mocks.workers.length = 0;
  vi.clearAllMocks();
});

afterEach(async () => {
  for (const s of services.splice(0)) await s.onModuleDestroy();
  resetProcessRoleForTests();
  resetLeaseRunnersForTests();
  resetShutdownForTests();
});

function chain(chainId: number) {
  return { chainId, protocol: 'uniswap-v4', enabled: true, subgraphUrl: 'https://indexer.test' };
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    redisUrl: 'redis://localhost:6379',
    positionsSyncCronEnabled: true,
    positionsSyncIntervalMs: 1_800_000,
    liveRefreshEnabled: true,
    liveRefreshConcurrency: 25,
    evmRpcUrls: new Map(),
    enabledIntegrations: [chain(1)],
    getIntegration: () => chain(1),
    ...overrides,
  };
}

function build(overrides: Record<string, unknown> = {}, redis?: FakeLeaseRedis) {
  const sync = {
    backfillTarget: vi.fn(async () => ({ upserted: 0 })),
    refreshTarget: vi.fn(),
    interruptedBackfills: vi.fn(async () => []),
  };
  const coordination = redis ? { client: async () => redis as never, namespace: 'spec' } : undefined;
  const service = new QueueService(
    config(overrides) as never,
    sync as never,
    { registerEnqueue: vi.fn() } as never,
    { refreshPosition: vi.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    undefined,
    coordination as never,
  );
  services.push(service);
  return { service, sync };
}

const repeatablesAdded = () => mocks.queues.flatMap((q) => q.add!.mock.calls.filter((c) => (c[2] as { repeat?: unknown })?.repeat));

describe('QueueService × PROCESS_ROLE (P2.1)', () => {
  it('all + leases off (default): 4 workers in today\'s order, repeatables inline, Redis coordination untouched, no global concurrency', async () => {
    const redis = new FakeLeaseRedis(Date.now);
    const { service, sync } = build({}, redis);
    await service.onModuleInit();
    expect(mocks.workers.map((w) => w.name)).toEqual([
      POSITIONS_SYNC_QUEUE,
      POSITION_LIVE_REFRESH_QUEUE,
      BACKGROUND_SWEEPS_QUEUE,
      POSITIONS_REFRESH_QUEUE,
    ]);
    expect(repeatablesAdded().length).toBe(1); // the refresh cron, registered before onModuleInit resolved
    expect(sync.interruptedBackfills).toHaveBeenCalledTimes(1);
    expect(redis.calls).toEqual([]);
    for (const q of mocks.queues) expect(q.setGlobalConcurrency).not.toHaveBeenCalled();
    expect(service.scheduler).toBeUndefined();
  });

  it('api: producers only — 0 Workers, 0 repeatables, no boot kicks, no resume, no clear', async () => {
    configureProcessRole({ processRole: 'api' });
    const redis = new FakeLeaseRedis(Date.now);
    const { service, sync } = build({ queueClearOnBoot: true, poolsSyncCronEnabled: true }, redis);
    await service.onModuleInit();
    await flush();
    expect(mocks.workers).toEqual([]);
    expect(repeatablesAdded()).toEqual([]);
    for (const q of mocks.queues) {
      expect(q.add).not.toHaveBeenCalled();
      expect(q.obliterate).not.toHaveBeenCalled();
      expect(q.setGlobalConcurrency).not.toHaveBeenCalled();
    }
    expect(sync.interruptedBackfills).not.toHaveBeenCalled();
    expect(service.scheduler).toBeUndefined();
  });

  it.each(['fee', 'feeder'] as const)('%s: no Workers and no scheduler', async (role) => {
    configureProcessRole({ processRole: role });
    const { service } = build({}, new FakeLeaseRedis(Date.now));
    await service.onModuleInit();
    expect(mocks.workers).toEqual([]);
    expect(service.scheduler).toBeUndefined();
  });

  it('sync + scheduler lease acquired: 4 Workers, the scheduler steps in the background, global concurrency at today\'s values', async () => {
    configureProcessRole({ processRole: 'sync' });
    const redis = new FakeLeaseRedis(Date.now);
    const { service, sync } = build({}, redis);
    await service.onModuleInit();
    expect(mocks.workers).toHaveLength(4);
    await flush(40);
    expect(service.scheduler?.held).toBe(true);
    expect(repeatablesAdded().length).toBe(1);
    expect(sync.interruptedBackfills).toHaveBeenCalledTimes(1);
    const [positions, live, sweeps, refresh] = mocks.queues;
    expect(positions!.setGlobalConcurrency).toHaveBeenCalledWith(10);
    expect(live!.setGlobalConcurrency).toHaveBeenCalledWith(25);
    expect(sweeps!.setGlobalConcurrency).toHaveBeenCalledWith(8);
    expect(refresh!.setGlobalConcurrency).toHaveBeenCalledWith(1);
    // Global concurrency is set BEFORE anything is enqueued.
    expect(positions!.setGlobalConcurrency.mock.invocationCallOrder[0]).toBeLessThan(refresh!.add!.mock.invocationCallOrder[0]!);
    expect(redis.kv.get(leaseKey('spec', 'scheduler'))?.v).toBe(service.scheduler?.owner);
  });

  it('sync with the scheduler held elsewhere: Workers yes, scheduler steps NO (onModuleInit never waits for the lease)', async () => {
    configureProcessRole({ processRole: 'sync' });
    const redis = new FakeLeaseRedis(Date.now);
    redis.steal(leaseKey('spec', 'scheduler'), 'old-sync', 600_000);
    const { service, sync } = build({}, redis);
    const raced = await Promise.race([
      service.onModuleInit().then(() => 'init'),
      new Promise((r) => setTimeout(() => r('timeout'), 200)),
    ]);
    expect(raced).toBe('init');
    await flush(40);
    expect(mocks.workers).toHaveLength(4);
    expect(repeatablesAdded()).toEqual([]);
    expect(sync.interruptedBackfills).not.toHaveBeenCalled();
    for (const q of mocks.queues) expect(q.setGlobalConcurrency).not.toHaveBeenCalled();
    expect(service.scheduler?.mode).toBe('standby');
  });

  it('all + PROCESS_LEASES=on: the scheduler runs under the lease (global concurrency set)', async () => {
    configureProcessRole({ processRole: 'all', processLeases: 'on' });
    const redis = new FakeLeaseRedis(Date.now);
    const { service } = build({}, redis);
    await service.onModuleInit();
    await flush(40);
    expect(service.scheduler?.held).toBe(true);
    expect(mocks.queues[0]!.setGlobalConcurrency).toHaveBeenCalledWith(10);
  });

  it('all + leases on + Redis down: fail-open — the steps still run (no fence → no global concurrency)', async () => {
    configureProcessRole({ processRole: 'all', processLeases: 'on' });
    const redis = new FakeLeaseRedis(Date.now);
    redis.failing = true;
    const { service, sync } = build({}, redis);
    await service.onModuleInit();
    await flush(40);
    expect(service.scheduler?.mode).toBe('local');
    expect(sync.interruptedBackfills).toHaveBeenCalledTimes(1);
    for (const q of mocks.queues) expect(q.setGlobalConcurrency).not.toHaveBeenCalled();
  });

  it('sync + Redis down: the scheduler does not run (split roles fail closed)', async () => {
    configureProcessRole({ processRole: 'sync' });
    const redis = new FakeLeaseRedis(Date.now);
    redis.failing = true;
    const { service, sync } = build({}, redis);
    await service.onModuleInit();
    await flush(40);
    expect(sync.interruptedBackfills).not.toHaveBeenCalled();
    expect(service.scheduler?.mode).toBe('standby');
  });
});

describe('scheduler steps check stillHeld() before each step', () => {
  it('a lease lost after the repeatables stops the boot kicks and the resume', async () => {
    const { service, sync } = build({ poolsSyncCronEnabled: true });
    let held = true;
    const ctx = { stillHeld: () => held, signal: new AbortController().signal, fence: 1, name: 'scheduler' };
    mocks.queues[3]!.add!.mockImplementation(async () => {
      held = false; // lost while registering the refresh cron
      return { id: 'x' };
    });
    await (service as unknown as { runSchedulerSteps(c: unknown): Promise<void> }).runSchedulerSteps(ctx);
    expect(mocks.queues[2]!.add!.mock.calls.filter((c) => !(c[2] as { repeat?: unknown })?.repeat)).toEqual([]); // no pool-sync boot kick
    expect(sync.interruptedBackfills).not.toHaveBeenCalled();
  });

  it('not held at all → nothing runs', async () => {
    const { service, sync } = build({});
    const ctx = { stillHeld: () => false, signal: new AbortController().signal, fence: 1, name: 'scheduler' };
    await (service as unknown as { runSchedulerSteps(c: unknown): Promise<void> }).runSchedulerSteps(ctx);
    for (const q of mocks.queues) expect(q.add).not.toHaveBeenCalled();
    expect(sync.interruptedBackfills).not.toHaveBeenCalled();
  });
});

describe('scheduler lease: per-acquisition vs once-per-process steps (review fixes)', () => {
  type Work = { schedulerWork(c: unknown): Promise<void> };
  const endedCtx = (held: () => boolean = () => true) => {
    const ac = new AbortController();
    ac.abort(); // the memory-sample loop exits at once
    return { stillHeld: held, signal: ac.signal, fence: 1, name: 'scheduler' };
  };
  const bootKicks = () =>
    mocks.queues[2]!.add!.mock.calls.filter((c) => (c[2] as { deduplication?: unknown })?.deduplication).length;

  it('QUEUE_CLEAR_ON_BOOT obliterates only in the FIRST session; boot kicks once; repeatables + backfill resume every acquisition', async () => {
    const { service, sync } = build({ queueClearOnBoot: true, poolsSyncCronEnabled: true });
    const work = service as unknown as Work;
    await work.schedulerWork(endedCtx());
    const obliterated = () => mocks.queues.reduce((n, q) => n + q.obliterate!.mock.calls.length, 0);
    expect(obliterated()).toBe(3);
    const kicks = bootKicks();
    expect(kicks).toBeGreaterThan(0);
    // A second acquisition (handover back, re-acquire after lease_lost/expired, a Redis blip):
    await work.schedulerWork(endedCtx());
    expect(obliterated()).toBe(3); // never again while jobs may be active
    expect(bootKicks()).toBe(kicks);
    expect(sync.interruptedBackfills).toHaveBeenCalledTimes(2);
    expect(repeatablesAdded().length).toBe(4); // refresh + pool-sync crons, registered twice
  });

  it('boot kicks cut short by a lost lease are sent by the next session', async () => {
    const { service } = build({ poolsSyncCronEnabled: true, tokenPriceSyncEnabled: true });
    const work = service as unknown as Work;
    let held = true;
    mocks.queues[2]!.add!.mockImplementation(async (_n: string, _d: unknown, o?: { jobId?: string; repeat?: unknown }) => {
      if (!o?.repeat) held = false; // lost right after the first boot kick
      return { id: o?.jobId };
    });
    await work.schedulerWork(endedCtx(() => held));
    const first = bootKicks();
    held = true;
    mocks.queues[2]!.add!.mockImplementation(async (_n: string, _d: unknown, o?: { jobId?: string }) => ({ id: o?.jobId }));
    await work.schedulerWork(endedCtx(() => held));
    expect(bootKicks()).toBeGreaterThan(first); // the pending kicks were re-sent
  });

  it('a fail-open local session upgraded to held applies BullMQ global concurrency', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    try {
      configureProcessRole({ processRole: 'all', processLeases: 'on' });
      const redis = new FakeLeaseRedis(Date.now);
      redis.failing = true;
      const { service } = build({}, redis);
      await service.onModuleInit();
      await flush(40);
      expect(service.scheduler?.mode).toBe('local');
      for (const q of mocks.queues) expect(q.setGlobalConcurrency).not.toHaveBeenCalled();
      redis.failing = false;
      await vi.advanceTimersByTimeAsync(10_000);
      await flush(40);
      expect(service.scheduler?.mode).toBe('held');
      expect(mocks.queues[0]!.setGlobalConcurrency).toHaveBeenCalledWith(10);
      expect(mocks.queues[3]!.setGlobalConcurrency).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('POSITIONS_REFRESH_QUEUE_CONCURRENCY (honoured only under enforce)', () => {
  it.each([
    [undefined, 'enforce', 1],
    [1, 'enforce', 1],
    [4, 'enforce', 4],
    [4, 'observe', 1],
    [4, 'off', 1],
    [4, undefined, 1],
    [0, 'enforce', 1],
    ['garbage', 'enforce', 1],
    [500, 'enforce', 64],
  ])('%s with mode %s → %s', (configured, mode, expected) => {
    expect(resolveRefreshQueueConcurrency(configured, mode)).toBe(expected);
  });

  it('the refresh Worker uses it', async () => {
    const { service } = build({ positionsRefreshQueueConcurrency: 4, writeBudget: { mode: 'enforce' } });
    await service.onModuleInit();
    expect(mocks.workers.find((w) => w.name === POSITIONS_REFRESH_QUEUE)?.opts.concurrency).toBe(4);
  });

  it('without enforce the refresh Worker stays at 1', async () => {
    const { service } = build({ positionsRefreshQueueConcurrency: 4, writeBudget: { mode: 'observe' } });
    await service.onModuleInit();
    expect(mocks.workers.find((w) => w.name === POSITIONS_REFRESH_QUEUE)?.opts.concurrency).toBe(1);
  });
});

describe('backfill held elsewhere → re-delayed, never completed (design §2.1)', () => {
  it('heldBackfillRedelayMs: 60 s ± 10 s while under the max wait, undefined after', () => {
    expect(heldBackfillRedelayMs(1_000, 1_000, 2_700_000, () => 0.5)).toBe(60_000);
    expect(heldBackfillRedelayMs(1_000, 1_000, 2_700_000, () => 0)).toBe(50_000);
    expect(heldBackfillRedelayMs(1_000, 1_000, 2_700_000, () => 1)).toBe(70_000);
    expect(heldBackfillRedelayMs(0, 2_699_999, 2_700_000)).toBeDefined();
    expect(heldBackfillRedelayMs(0, 2_700_000, 2_700_000)).toBeUndefined();
    expect(heldBackfillRedelayMs(undefined, 5, 2_700_000)).toBeDefined();
  });

  function backfillJob(timestamp = Date.now()) {
    return {
      id: 'backfill-1',
      name: 'backfill',
      data: { chainId: 4663, protocol: 'uniswap-v4' },
      timestamp,
      moveToDelayed: vi.fn(async () => undefined),
    };
  }

  it('a heldElsewhere result moves the job to delayed and throws DelayedError', async () => {
    const { service, sync } = build({ positionsSyncCronEnabled: false });
    sync.backfillTarget.mockResolvedValue({ upserted: 0, heldElsewhere: true } as never);
    await service.onModuleInit();
    const job = backfillJob();
    const before = Date.now();
    await expect(mocks.workers[0]!.processor(job, 'lock-token')).rejects.toMatchObject({ name: 'DelayedError' });
    expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
    const [ts, token] = job.moveToDelayed.mock.calls[0] as unknown as [number, string];
    expect(token).toBe('lock-token');
    expect(ts).toBeGreaterThanOrEqual(before + 50_000);
    expect(ts).toBeLessThanOrEqual(Date.now() + 70_000);
  });

  it('after BACKFILL_HELD_MAX_WAIT_MS the job completes (alert) instead of re-delaying forever', async () => {
    const { service, sync } = build({ positionsSyncCronEnabled: false, backfillHeldMaxWaitMs: 60_000 });
    sync.backfillTarget.mockResolvedValue({ upserted: 0, heldElsewhere: true } as never);
    await service.onModuleInit();
    const job = backfillJob(Date.now() - 61_000);
    await expect(mocks.workers[0]!.processor(job, 'lock-token')).resolves.toMatchObject({ heldElsewhere: true });
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });

  it('a normal backfill result completes as today', async () => {
    const { service } = build({ positionsSyncCronEnabled: false });
    await service.onModuleInit();
    const job = backfillJob();
    await expect(mocks.workers[0]!.processor(job, 'tok')).resolves.toEqual({ upserted: 0 });
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });

  it('a heldElsewhere refresh is skipped as today (no re-delay)', async () => {
    const { service, sync } = build({ positionsSyncCronEnabled: false });
    sync.refreshTarget.mockResolvedValue({ heldElsewhere: true } as never);
    await service.onModuleInit();
    const job = { ...backfillJob(), name: 'refresh' };
    await expect(mocks.workers[3]!.processor(job, 'tok')).resolves.toEqual({ heldElsewhere: true });
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });
});

describe('boot smoke findings: log wording (2026-10-04)', () => {
  type Work = { schedulerWork(c: unknown): Promise<void> };
  const quiet = (service: QueueService) => {
    const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    (service as unknown as { logger: unknown }).logger = logger;
    return logger;
  };

  it('the backfill resume says "at boot" only at boot; a scheduler-lease acquisition says so instead', async () => {
    const atBoot = build();
    atBoot.sync.interruptedBackfills.mockResolvedValue([chain(4663)] as never);
    const bootLog = quiet(atBoot.service);
    await atBoot.service.onModuleInit();
    const bootLine = bootLog.warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes('sync.backfill_resumed'));
    expect(bootLine).toMatch(/4663:uniswap-v4 — the backfill flag was set at boot \(a deploy or crash interrupted it\)/);

    const handover = build();
    handover.sync.interruptedBackfills.mockResolvedValue([chain(4663)] as never);
    const leaseLog = quiet(handover.service);
    const ac = new AbortController();
    ac.abort();
    await (handover.service as unknown as Work).schedulerWork({ stillHeld: () => true, signal: ac.signal, fence: 2, name: 'scheduler' });
    const leaseLine = leaseLog.warn.mock.calls.map((c) => String(c[0])).find((l) => l.includes('sync.backfill_resumed'));
    expect(leaseLine).toMatch(/when this process took the scheduler lease \(a deploy, crash or lease handover interrupted it\)/);
    expect(leaseLine).not.toMatch(/at boot/);
  });

  it('shutdown says "Workers + queues closed" only where workers ran; a producer-only role says it had none', async () => {
    const all = build();
    await all.service.onModuleInit();
    const allLog = quiet(all.service);
    await all.service.onModuleDestroy();
    expect(allLog.log.mock.calls.map((c) => String(c[0])).some((l) => l.startsWith('Workers + queues closed at '))).toBe(true);

    configureProcessRole({ processRole: 'api' });
    const api = build();
    await api.service.onModuleInit();
    const apiLog = quiet(api.service);
    await api.service.onModuleDestroy();
    const lines = apiLog.log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.startsWith('Workers + queues closed'))).toBe(false);
    expect(lines.some((l) => /^Queues closed at .* \(no workers in role api\)$/.test(l))).toBe(true);
  });
});
