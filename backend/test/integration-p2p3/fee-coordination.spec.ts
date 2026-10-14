/*
 * I1 — the wiring between package A's coordination layer and package F's fee
 * pass: `FEE_COORDINATION` (undefined with leases off = today), the
 * `fee-worker` lease view (`held` = stillHeld, NOT the `held` getter), the
 * `FEE_RPC_FETCH` factory (`budgetedFetch(lane)`, never `(lane, url)`), and
 * the same through a real Nest context. Opt-in (`P2P3_TEST_REDIS_URL`): role
 * `fee` really takes the `fee-worker` lease on a real Redis, fenced.
 */
import 'reflect-metadata';
import { Inject, Injectable, Module, Optional } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Redis } from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CoordinationModule } from '../../src/common/coordination.module.js';
import {
  FEE_WORKER_LEASE,
  FEE_WORKER_LEASE_RENEW_MS,
  FEE_WORKER_LEASE_TTL_MS,
  FeeWorkerLeaseHolder,
  feeCoordination,
  feeRpcFetch,
  feeWorkerLeaseView,
} from '../../src/common/fee-coordination.js';
import { LeaseRunner, resetLeaseRunnersForTests } from '../../src/common/lease-runner.js';
import { configureProcessRole, resetProcessRoleForTests } from '../../src/common/process-role.js';
import { AppConfigModule } from '../../src/config/app-config.module.js';
import { FEE_RPC_FETCH } from '../../src/sync/fee-measurer.js';
import { FEE_COORDINATION, type FeeCoordination } from '../../src/sync/fee-signals.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  resetProcessRoleForTests();
  resetLeaseRunnersForTests();
});

const coordination = { client: vi.fn(async () => 'state-client' as never), namespace: 'ns-test' };
const models = { client: vi.fn(async () => 'models-client' as never) };

describe('feeCoordination (the FEE_COORDINATION value)', () => {
  it('leases off (role all + auto, the default): undefined — the fee pass, publisher and feed run as today', () => {
    expect(feeCoordination(coordination, models, { runner: undefined }, false)).toBeUndefined();
  });

  it('leases on, no fee-worker in this role: signals + streams, and NO lease (isWorker then says no via can())', async () => {
    const c = feeCoordination(coordination, models, { runner: undefined }, true)!;
    expect(c).toMatchObject({ leasesEnabled: true, namespace: 'ns-test' });
    expect(c.lease).toBeUndefined();
    expect(await c.stateRedis()).toBe('state-client');
    expect(await c.modelsRedis()).toBe('models-client');
  });

  it('leases on with the fee-worker runner: the lease view maps EXACTLY (held = stillHeld(), never the held getter)', () => {
    const runner = { stillHeld: vi.fn(() => true), fence: 7, acquiredAt: 1_234, held: false };
    const c = feeCoordination(coordination, models, { runner: runner as never }, true)!;
    // The runner's `held` getter is false in the fail-open LOCAL mode, where
    // stillHeld() is true: the fee pass must keep running there.
    expect(c.lease!.held()).toBe(true);
    expect(runner.stillHeld).toHaveBeenCalled();
    expect(c.lease!.fence()).toBe(7);
    expect(c.lease!.acquiredAt()).toBe(1_234);
  });

  it('feeWorkerLeaseView reads the runner live (a fence taken later is seen)', () => {
    const runner = { stillHeld: () => false, fence: undefined as number | undefined, acquiredAt: undefined as number | undefined };
    const view = feeWorkerLeaseView(runner);
    expect(view.held()).toBe(false);
    expect(view.fence()).toBeUndefined();
    runner.fence = 9;
    runner.acquiredAt = 5;
    expect(view.fence()).toBe(9);
    expect(view.acquiredAt()).toBe(5);
  });
});

describe('feeRpcFetch (the FEE_RPC_FETCH factory)', () => {
  it('asks budgetedFetch for the LANE only — the url is never passed as its second argument (a fetchImpl)', () => {
    const plain = (() => undefined) as unknown as typeof fetch;
    const budget = { budgetedFetch: vi.fn(() => plain) };
    const factory = feeRpcFetch(budget as never);
    expect(factory('https://rpc.example/key', 'backfill', 1)).toBe(plain);
    expect(budget.budgetedFetch).toHaveBeenCalledWith('backfill');
    expect(budget.budgetedFetch.mock.calls[0]).toHaveLength(1);
  });
});

describe('FeeWorkerLeaseHolder', () => {
  const holder = (env: Record<string, string>) => {
    configureProcessRole({ processRole: env.PROCESS_ROLE, processLeases: env.PROCESS_LEASES });
    return new FeeWorkerLeaseHolder({ positionFeeRefreshEnabled: env.REFRESH !== 'false', redisUrl: 'redis://127.0.0.1:1' } as never, undefined);
  };

  it.each([
    [{ PROCESS_ROLE: 'all' }, false], // leases off = today
    [{ PROCESS_ROLE: 'all', PROCESS_LEASES: 'on' }, true],
    [{ PROCESS_ROLE: 'fee' }, true],
    [{ PROCESS_ROLE: 'fee', REFRESH: 'false' }, false],
    [{ PROCESS_ROLE: 'api' }, false],
    [{ PROCESS_ROLE: 'sync' }, false],
    [{ PROCESS_ROLE: 'feeder' }, false],
  ] as const)('%o → takes part in the lease: %s', (env, applies) => {
    const h = holder(env as Record<string, string>);
    expect(h.applies).toBe(applies);
    expect(h.runner !== undefined).toBe(applies);
  });

  it('the runner is `fee-worker`, 30 s / 10 s, fail-open only in role all', () => {
    const fee = holder({ PROCESS_ROLE: 'fee' }).runner!;
    expect(fee.name).toBe(FEE_WORKER_LEASE);
    expect((fee as unknown as { ttlMs: number }).ttlMs).toBe(FEE_WORKER_LEASE_TTL_MS);
    expect(fee.renewMs).toBe(FEE_WORKER_LEASE_RENEW_MS);
    expect((fee as unknown as { options: { failOpen?: boolean } }).options.failOpen).toBe(false);
    resetProcessRoleForTests();
    const all = holder({ PROCESS_ROLE: 'all', PROCESS_LEASES: 'on' }).runner!;
    expect((all as unknown as { options: { failOpen?: boolean } }).options.failOpen).toBe(true);
  });

  it('onModuleInit starts the runner only where the lease applies, and never awaits it', () => {
    const start = vi.spyOn(LeaseRunner.prototype, 'start').mockImplementation(() => undefined);
    holder({ PROCESS_ROLE: 'api' }).onModuleInit();
    expect(start).not.toHaveBeenCalled();
    resetProcessRoleForTests();
    const result = holder({ PROCESS_ROLE: 'fee' }).onModuleInit() as unknown;
    expect(result).toBeUndefined();
    expect(start).toHaveBeenCalledTimes(1);
  });
});

@Injectable()
class FeeConsumer {
  constructor(
    @Optional() @Inject(FEE_COORDINATION) readonly coord?: FeeCoordination,
    @Optional() @Inject(FEE_RPC_FETCH) readonly fetchFactory?: unknown,
  ) {}
}

@Module({ imports: [AppConfigModule, CoordinationModule], providers: [FeeConsumer] })
class FeeConsumerModule {}

async function contextWith(env: Record<string, string>) {
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
  configureProcessRole({ processRole: env.PROCESS_ROLE, processLeases: env.PROCESS_LEASES });
  return NestFactory.createApplicationContext(FeeConsumerModule, { logger: false, abortOnError: false });
}

describe('through a real Nest context (factory providers that resolve to undefined)', () => {
  it('default (all, leases off): the consumer gets undefined FEE_COORDINATION and a function FEE_RPC_FETCH', async () => {
    const app = await contextWith({ PROCESS_ROLE: 'all', REDIS_URL: 'redis://127.0.0.1:1' });
    try {
      const consumer = app.get(FeeConsumer);
      expect(consumer.coord).toBeUndefined();
      expect(consumer.fetchFactory).toBeTypeOf('function');
    } finally {
      await app.close();
    }
  });

  it('role api (leases on): the consumer gets the coordination, with no lease', async () => {
    const app = await contextWith({ PROCESS_ROLE: 'api', PROCESS_STATUS_PUBLISH_MS: '0', REDIS_URL: 'redis://127.0.0.1:1' });
    try {
      const consumer = app.get(FeeConsumer);
      expect(consumer.coord).toMatchObject({ leasesEnabled: true });
      expect(consumer.coord!.lease).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});

const REDIS = process.env.P2P3_TEST_REDIS_URL;

describe.skipIf(!REDIS)('role fee on a REAL Redis (opt-in): the fee-worker lease is taken, fenced, and released at close', () => {
  it('acquires within the first acquire, exposes held/fence/acquiredAt, releases on close', async () => {
    // Its own logical db on the throwaway server, flushed at the end.
    const url = `${REDIS!.replace(/\/\d*$/, '')}/7`;
    const app = await contextWith({ PROCESS_ROLE: 'fee', PROCESS_STATUS_PUBLISH_MS: '0', REDIS_URL: url });
    const probe = new Redis(url);
    try {
      const consumer = app.get(FeeConsumer);
      const lease = consumer.coord!.lease!;
      expect(lease).toBeDefined();
      const deadline = Date.now() + 5_000;
      while (!lease.held() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(lease.held()).toBe(true);
      expect(lease.fence()).toBeGreaterThan(0);
      expect(lease.acquiredAt()).toBeTypeOf('number');
      const keys = await probe.keys('tw:lease:v1:*:fee-worker');
      expect(keys.length).toBeGreaterThan(0);
    } finally {
      await app.close();
      // Released at close (compare-and-delete): the lease key is gone; the fence stays (monotonic).
      expect(await probe.keys('tw:lease:v1:*:fee-worker')).toEqual([]);
      expect((await probe.keys('tw:lease:v1:*:fee-worker:fence')).length).toBe(1);
      await probe.flushdb();
      await probe.quit();
    }
  });
});
