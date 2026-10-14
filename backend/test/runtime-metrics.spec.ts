/*
 * The two stalls `GET /admin/sync/status` → `runtime` now shows (scale plan
 * 1.8): event-loop delay and the Mongo pool checkout wait, per 60 s window,
 * with an [alert] when a closed window's p99 passes 100 ms — and the read
 * path treating a pool wait-queue timeout like a `maxTimeMS` timeout.
 */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminController } from '../src/admin/admin.controller.js';
import {
  LOOP_RESOLUTION_MS,
  loopWindow,
  observeCheckout,
  observeCheckoutFailed,
  resetRuntimeMetrics,
  rollRuntimeWindows,
  RUNTIME_WARN_MS,
  RUNTIME_WINDOW_MS,
  runtimeAlerts,
  runtimeSnapshot,
  RuntimeMetricsService,
} from '../src/common/runtime-metrics.js';
import { PoolsRepository } from '../src/database/pools.repository.js';
import { isMaxTimeMSExpired, isWaitQueueTimeout, QueryTimeoutException } from '../src/database/user-read.js';

/** What the driver throws when no pooled connection came free in time (name only: the class is not exported). */
function waitQueueTimeout(): Error {
  const err = new Error('Timed out while checking out a connection from connection pool');
  Object.defineProperty(err, 'name', { value: 'MongoWaitQueueTimeoutError' });
  return err;
}

afterEach(() => {
  resetRuntimeMetrics();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('event-loop window', () => {
  /** A histogram stub in ns, like `monitorEventLoopDelay` reports. */
  const hist = (p50Ms: number, p99Ms: number, maxMs: number, count = 100) => ({
    count,
    max: maxMs * 1e6,
    percentile: (p: number) => (p === 50 ? p50Ms : p99Ms) * 1e6,
  });

  it('reports the DELAY: the sampling interval is subtracted (an idle loop reads ~0, not ~21 ms)', () => {
    expect(LOOP_RESOLUTION_MS).toBe(20);
    const idle = loopWindow(hist(21.1, 21.1, 25.8), 0, 60_000);
    expect(idle).toMatchObject({ p50Ms: 1.1, p99Ms: 1.1, maxMs: 5.8, durationMs: 60_000 });
    const blocked = loopWindow(hist(21.4, 215.2, 2015.4), 0, 60_000);
    expect(blocked).toMatchObject({ p50Ms: 1.4, p99Ms: 195.2, maxMs: 1995.4 });
  });

  it('never goes negative, and an empty histogram reports nulls', () => {
    expect(loopWindow(hist(19.6, 19.9, 19.9), 0, 1)).toMatchObject({ p50Ms: 0, p99Ms: 0, maxMs: 0 });
    expect(loopWindow(hist(0, 0, 0, 0), 0, 1)).toMatchObject({ p50Ms: null, p99Ms: null, maxMs: null });
  });
});

describe('pool checkout window', () => {
  it('counts checkouts, the ones that waited, percentiles, the max and failures by reason', () => {
    resetRuntimeMetrics(0);
    for (let i = 0; i < 98; i++) observeCheckout(0);
    observeCheckout(40);
    observeCheckout(250);
    observeCheckoutFailed('timeout', 10_000);
    const snap = runtimeSnapshot(30_000).mongoPool.current;
    expect(snap).toMatchObject({ checkouts: 100, waited: 2, p50Ms: 0, p99Ms: 40, maxMs: 10_000, failed: { timeout: 1 } });
    expect(snap.durationMs).toBe(30_000);
  });

  it('rolling closes the window into `last` and starts an empty one', () => {
    resetRuntimeMetrics(0);
    observeCheckout(5);
    const closed = rollRuntimeWindows(60_000);
    expect(closed.checkout.checkouts).toBe(1);
    const snap = runtimeSnapshot(61_000);
    expect(snap.mongoPool.last).toEqual(closed.checkout);
    expect(snap.mongoPool.current).toMatchObject({ checkouts: 0, waited: 0, p99Ms: null, maxMs: null, failed: {} });
  });
});

describe('runtime alerts', () => {
  const window = (over: Partial<ReturnType<typeof rollRuntimeWindows>['checkout']> = {}) => ({
    startedAt: '',
    durationMs: 60_000,
    checkouts: 100,
    waited: 0,
    p50Ms: 0,
    p99Ms: 0,
    maxMs: 0,
    failed: {},
    ...over,
  });
  const loop = (p99Ms: number | null) => ({ startedAt: '', durationMs: 60_000, p50Ms: 1, p99Ms, maxMs: p99Ms });

  it('alerts on a p99 OVER the threshold only — event loop and checkout alike', () => {
    expect(RUNTIME_WARN_MS).toBe(100);
    expect(runtimeAlerts({ loop: loop(100), checkout: window({ p99Ms: 100 }) })).toEqual([]);
    const lines = runtimeAlerts({ loop: loop(101), checkout: window({ p99Ms: 101 }) });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\[alert\] process\.event_loop_delay .*p99=101ms/);
    expect(lines[1]).toMatch(/^\[alert\] mongo\.pool_checkout_wait .*p99=101ms/);
  });

  it('a window with ANY wait-queue timeout alerts, whatever its p99', () => {
    const lines = runtimeAlerts({ loop: loop(null), checkout: window({ failed: { timeout: 1 } }) });
    expect(lines).toEqual([expect.stringMatching(/mongo\.pool_checkout_wait .*timeouts=1/)]);
  });
});

describe('RuntimeMetricsService', () => {
  it('subscribes to the driver checkout events, measures the event loop, and rolls + alerts every minute', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const client = new EventEmitter();
    const service = new RuntimeMetricsService(
      { getClient: () => client } as never,
      { mongoMaxPoolSize: 60, mongoWaitQueueTimeoutMs: 10_000 } as never,
    );
    const warn = vi.spyOn((service as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn').mockImplementation(() => {});
    service.onModuleInit();
    client.emit('connectionCheckedOut', { durationMS: 300 });
    client.emit('connectionCheckOutFailed', { reason: 'timeout', durationMS: 10_000 });
    let snap = runtimeSnapshot();
    expect(snap.mongoPool).toMatchObject({ maxPoolSize: 60, waitQueueTimeoutMs: 10_000, current: { checkouts: 1, failed: { timeout: 1 } } });
    expect(snap.eventLoop.current).not.toBeNull();
    vi.advanceTimersByTime(RUNTIME_WINDOW_MS);
    snap = runtimeSnapshot();
    expect(snap.mongoPool.last).toMatchObject({ checkouts: 1, p99Ms: 300 });
    expect(warn.mock.calls.map(([m]) => String(m)).filter((m) => m.includes('mongo.pool_checkout_wait'))).toHaveLength(1);
    service.onModuleDestroy();
  });

  it('a broken event payload never throws into the driver', () => {
    const client = new EventEmitter();
    const service = new RuntimeMetricsService({ getClient: () => client } as never, undefined);
    service.onModuleInit();
    expect(() => client.emit('connectionCheckedOut', null)).not.toThrow();
    expect(() => client.emit('connectionCheckOutFailed', undefined)).not.toThrow();
    service.onModuleDestroy();
  });
});

describe('GET /admin/sync/status carries the runtime block', () => {
  it('runtime: eventLoop + mongoPool + warnMs', async () => {
    const secret = 'a-strong-ops-secret-for-tests';
    const controller = new AdminController(
      { adminSecret: secret } as never,
      { status: async () => ({}) } as never,
      { status: async () => ({ cursors: [] }) } as never,
    );
    const res = (await controller.syncStatus(secret)) as { runtime: { warnMs: number; mongoPool: unknown; eventLoop: unknown } };
    expect(res.runtime.warnMs).toBe(100);
    expect(res.runtime).toHaveProperty('mongoPool.current.checkouts');
    expect(res.runtime).toHaveProperty('eventLoop.last');
  });
});

describe('a pool wait-queue timeout is a read timeout on the read path', () => {
  it('isMaxTimeMSExpired is true for MaxTimeMSExpired AND MongoWaitQueueTimeoutError (also as a cause), nothing else', () => {
    expect(isMaxTimeMSExpired({ code: 50 })).toBe(true);
    expect(isMaxTimeMSExpired(waitQueueTimeout())).toBe(true);
    expect(isMaxTimeMSExpired({ message: 'wrapped', cause: waitQueueTimeout() })).toBe(true);
    expect(isWaitQueueTimeout(waitQueueTimeout())).toBe(true);
    expect(isMaxTimeMSExpired(new Error('MongoWaitQueueTimeoutError'))).toBe(false);
    expect(isMaxTimeMSExpired({ name: 'MongoNetworkError' })).toBe(false);
  });

  it('pool detail answers it as the 503 + Retry-After timeout, not an uncached 500', async () => {
    const model = {
      findOne: () => ({ read: () => ({ maxTimeMS: () => ({ lean: () => Promise.reject(waitQueueTimeout()) }) }) }),
    };
    const repo = new PoolsRepository({ poolModel: () => model } as never, {} as never);
    await expect(repo.findPoolById(1, 'uniswap-v4', '0xpool')).rejects.toBeInstanceOf(QueryTimeoutException);
  });
});

describe('the Mongo client options', () => {
  it('name the client, bound the pool per member and its wait queue — and set nothing else (read preference stays per query, write concern the URI\'s)', async () => {
    const { mongoConnectionOptions } = await import('../src/database/database.module.js');
    expect(
      mongoConnectionOptions({ mongodbUri: 'mongodb://h/db', mongoAppName: 'tickwise-backend', mongoMaxPoolSize: 60, mongoWaitQueueTimeoutMs: 10_000 } as never),
    ).toEqual({ uri: 'mongodb://h/db', appName: 'tickwise-backend', maxPoolSize: 60, waitQueueTimeoutMS: 10_000 });
  });
});
