import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queues: [] as Array<Record<string, ReturnType<typeof vi.fn>>>,
  workers: [] as unknown[],
}));

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(() => ({ on: vi.fn(), quit: vi.fn(async () => undefined) })),
}));

vi.mock('bullmq', () => ({
  Job: class {},
  Queue: vi.fn().mockImplementation(() => {
    const q = {
      add: vi.fn(async () => ({ id: 'x' })),
      close: vi.fn(async () => undefined),
      getRepeatableJobs: vi.fn(async () => []),
      removeRepeatableByKey: vi.fn(async () => undefined),
      setGlobalConcurrency: vi.fn(async () => undefined),
      getJobCounts: vi.fn(async () => ({})),
    };
    mocks.queues.push(q);
    return q;
  }),
  Worker: vi.fn().mockImplementation(() => {
    const w = { on: vi.fn(), close: vi.fn(async () => undefined) };
    mocks.workers.push(w);
    return w;
  }),
}));

import { PaymentsQueueService } from '../../src/payments/payments-queue.service.js';
import { configureProcessRole, resetProcessRoleForTests } from '../../src/common/process-role.js';

beforeEach(() => {
  mocks.queues.length = 0;
  mocks.workers.length = 0;
});
afterEach(() => resetProcessRoleForTests());

function make() {
  return new PaymentsQueueService(
    {
      redisUrl: 'redis://x',
      subscriptionSweepEnabled: true,
      subscriptionSweepIntervalMs: 3_600_000,
      paymentReconcileIntervalMs: 900_000,
      paymentWatchIntervalMs: 30_000,
      x402PaymentsConfigured: false,
      evmRpcUrlWarnings: () => undefined,
    } as never,
    {} as never,
    {} as never,
    { watchedChainIds: () => [] } as never,
  );
}

describe('PaymentsQueueService × role (P2.1)', () => {
  it('all + leases off (default): Worker, repeatables, boot kick — and NO global concurrency (today)', async () => {
    await make().onModuleInit();
    expect(mocks.workers).toHaveLength(1);
    expect(mocks.queues[0]!.add).toHaveBeenCalled();
    expect(mocks.queues[0]!.setGlobalConcurrency).not.toHaveBeenCalled();
  });

  it('sync (leases on): Worker + repeatables, and the queue concurrency 1 becomes fleet-wide', async () => {
    configureProcessRole({ processRole: 'sync' });
    await make().onModuleInit();
    expect(mocks.workers).toHaveLength(1);
    expect(mocks.queues[0]!.setGlobalConcurrency).toHaveBeenCalledWith(1);
    expect(mocks.queues[0]!.add).toHaveBeenCalled();
  });

  it.each(['api', 'fee', 'feeder'] as const)('%s: producer only — no Worker, no repeatables, no boot kick', async (role) => {
    configureProcessRole({ processRole: role });
    const svc = make();
    await svc.onModuleInit();
    expect(mocks.workers).toHaveLength(0);
    expect(mocks.queues[0]!.add).not.toHaveBeenCalled();
    expect(mocks.queues[0]!.getRepeatableJobs).not.toHaveBeenCalled();
    // The admin enqueue still works from an api process.
    await svc.enqueueSweep();
    expect(mocks.queues[0]!.add).toHaveBeenCalledTimes(1);
  });
});
