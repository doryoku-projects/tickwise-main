/*
 * A sleeping enforce-mode acquire: a caller abort rejects it, and the
 * process stop signal ends the wait so the (already charged) write goes out —
 * the backfill's SIGTERM path must flush inside Railway's draining window.
 * Its own file: `beginShutdown` is process-wide and one-way.
 */
import { describe, expect, it } from 'vitest';
import { beginShutdown } from '../../src/common/shutdown.js';
import { WriteBudgetService } from '../../src/common/write-budget.js';
import { resolveWriteBudgetSettings } from '../../src/common/write-budget-model.js';
import { FakeRedis } from './fake-redis.js';

function enforce() {
  const redis = new FakeRedis(Date.now);
  const svc = new WriteBudgetService(
    { writeBudget: resolveWriteBudgetSettings({ WRITE_BUDGET_MODE: 'enforce' }) } as never,
    { client: async () => redis as never, namespace: 'sd' },
  );
  (svc as unknown as { logger: unknown }).logger = { warn: () => {}, log: () => {} };
  return svc;
}

describe('a waiting acquire', () => {
  it('rejects with the caller’s abort reason', async () => {
    const svc = enforce();
    svc.charge(10_000, 'pools');
    await new Promise((r) => setImmediate(r));
    const ac = new AbortController();
    const pending = svc.acquire(10, { lane: 'pools', signal: ac.signal });
    setTimeout(() => ac.abort(new Error('job cancelled')), 20);
    await expect(pending).rejects.toThrow('job cancelled');
  });

  it('stops waiting at shutdown and lets the write go', async () => {
    const svc = enforce();
    svc.charge(200_000, 'pools'); // ~2,000 s of debt at R = MIN 100 (the idle lanes repay it too)
    await new Promise((r) => setImmediate(r));
    const started = Date.now();
    const pending = svc.acquire(10, { lane: 'pools' });
    setTimeout(() => beginShutdown('spec'), 20);
    const grant = await pending;
    expect(grant.wouldWaitMs).toBeGreaterThan(1_000_000);
    expect(Date.now() - started).toBeLessThan(2_000);
    // after shutdown began, no acquire sleeps at all
    const after = await svc.acquire(10, { lane: 'pools' });
    expect(after.waitedMs).toBe(0);
  });
});
