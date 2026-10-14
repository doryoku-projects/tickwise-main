/*
 * I1 — GET /admin/sync/status carries the P2/P3 blocks (design §2.1 processes,
 * redis; §3.5 shared state; §4.5 writeSkip; §5.4 writeBudget; §6.4 backfill;
 * §8 fee) and, in a default deployment, opens no Redis connection to do it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdminController } from '../../src/admin/admin.controller.js';
import { configureProcessRole, resetProcessRoleForTests } from '../../src/common/process-role.js';
import { UsageFlushService } from '../../src/billing/usage-flush.service.js';

const SECRET = 'a-very-long-admin-secret';

function controller(extra: { publishMs?: number; readFleet?: () => Promise<unknown[]>; usageFlush?: unknown } = {}) {
  const readFleet = vi.fn(extra.readFleet ?? (async () => [{ role: 'sync' }]));
  // The REAL service in direct mode (the default config view), with a Redis
  // source that fails the spec if anything asks for it.
  const redis = vi.fn(async () => {
    throw new Error('direct mode must not touch Redis');
  });
  const usageFlush = extra.usageFlush ?? new UsageFlushService({} as never, {} as never, {} as never, undefined, { redis, timer: false });
  const c = new AdminController(
    { adminSecret: SECRET } as never,
    { status: async () => ({}) } as never,
    { status: async () => ({ cursors: [], latestRuns: [] }) } as never,
    undefined,
    { publishMs: extra.publishMs ?? 0, readFleet } as never,
    { status: async () => ({ mode: 'off', controller: { enabled: false } }) } as never,
    { writeSkipStatus: () => ({ mode: 'off' }) } as never,
    { stats: () => ({ store: 'memory' }) } as never,
    { stats: () => ({ published: 0 }) } as never,
    { status: () => ({ enabled: false }) } as never,
    { feeStatus: () => ({ worker: true }) } as never,
    usageFlush as never,
  );
  return { c, readFleet, redis };
}

afterEach(() => resetProcessRoleForTests());

describe('/admin/sync/status — P2/P3 blocks', () => {
  it('default deployment: role all, leases off, every block present, and the fleet is NOT read (no Redis)', async () => {
    const { c, readFleet } = controller();
    const status = (await c.syncStatus(SECRET)) as Record<string, unknown>;
    expect(status.process).toEqual({ role: 'all', leases: false, leasesSetting: 'auto', http: 'http=full' });
    expect(status.processes).toEqual([]);
    expect(readFleet).not.toHaveBeenCalled();
    expect(status.leases).toEqual([]);
    expect(status.redis).toBeNull();
    expect(status.writeBudget).toEqual({ mode: 'off', controller: { enabled: false } });
    expect(status.writeSkip).toEqual({ mode: 'off' });
    expect(status.backfill).toEqual([]);
    expect(status.fee).toEqual({ worker: true });
    expect(status.sharedState).toEqual({ rateLimit: { store: 'memory' }, invalidation: { published: 0 }, rpc: { enabled: false } });
  });

  it('usageWrites: direct (default) reports the mode with null counts and makes NO Redis call', async () => {
    const { c, redis } = controller();
    const status = (await c.syncStatus(SECRET)) as { usageWrites: Record<string, unknown> };
    expect(status.usageWrites).toMatchObject({ mode: 'direct', flusher: 'off', bufferedKeys: null, pendingClaims: null, drained: null });
    expect(redis).not.toHaveBeenCalled();
  });

  it('usageWrites: the drain signal is what the rollback reads; a failing metrics() reports its error', async () => {
    const drained = controller({ usageFlush: { metrics: async () => ({ mode: 'drain', bufferedKeys: 0, pendingClaims: 0, drained: true }) } });
    expect(((await drained.c.syncStatus(SECRET)) as { usageWrites: unknown }).usageWrites).toMatchObject({ mode: 'drain', drained: true });
    const failing = controller({ usageFlush: { metrics: async () => {
      throw new Error('redis gone');
    } } });
    expect(((await failing.c.syncStatus(SECRET)) as { usageWrites: unknown }).usageWrites).toEqual({ error: 'redis gone' });
  });

  it('a publishing process (leases on / PROCESS_STATUS_PUBLISH_MS) reads the fleet', async () => {
    configureProcessRole({ processRole: 'api' });
    const { c, readFleet } = controller({ publishMs: 10_000 });
    const status = (await c.syncStatus(SECRET)) as Record<string, unknown>;
    expect(readFleet).toHaveBeenCalledTimes(1);
    expect(status.processes).toEqual([{ role: 'sync' }]);
    expect(status.process).toMatchObject({ role: 'api', leases: true, http: 'http=full' });
  });

  it('a failing block reports its error instead of failing the route', async () => {
    const c = new AdminController(
      { adminSecret: SECRET } as never,
      { status: async () => ({}) } as never,
      { status: async () => ({ cursors: [], latestRuns: [] }) } as never,
      undefined,
      undefined,
      { status: async () => {
        throw new Error('redis gone');
      } } as never,
    );
    const status = (await c.syncStatus(SECRET)) as Record<string, unknown>;
    expect(status.writeBudget).toEqual({ error: 'redis gone' });
    expect(status.writeSkip).toBeNull();
    expect(status.usageWrites).toBeNull();
    expect(status.sharedState).toEqual({ rateLimit: null, invalidation: null, rpc: null });
  });
});
