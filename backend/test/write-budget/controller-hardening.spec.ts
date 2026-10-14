/*
 * The AIMD controller, hardened by the integrator (I1) on the round-1 review:
 *  - one burst of slow chunks halves R ONCE, not once per 5 s tick for the 30 s
 *    its samples stay in the window (it used to drive 300 → MIN in ~15 s and
 *    take ~12 min to recover);
 *  - a holder deposed while it read its inputs never writes its stale R;
 *  - a hung Mongo monitor cannot hang the tick (deadline, last reading);
 *  - the controller runs only where `can('write-budget-controller')`;
 *  - its budget view is a status-fan-in contributor.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  controllerStep,
  MONITOR_SAMPLE_DEADLINE_MS,
  WriteBudgetController,
  type ControllerInputs,
} from '../../src/common/write-budget-controller.js';
import { WriteBudgetService, writeBudgetKeys } from '../../src/common/write-budget.js';
import { resolveWriteBudgetSettings } from '../../src/common/write-budget-model.js';
import { configureProcessRole, resetProcessRoleForTests } from '../../src/common/process-role.js';
import { ProcessStatusService, resetProcessStatusForTests } from '../../src/common/process-status.js';
import type { MongoMonitor, MongoMonitorReading } from '../../src/database/mongo-monitor.js';
import { fakeClock, FakeRedis } from './fake-redis.js';

const S = resolveWriteBudgetSettings({ WRITE_BUDGET_MODE: 'enforce' });
const GREEN: ControllerInputs = {
  unitP95MsPerUnit: null,
  smallP95Ms: null,
  lagMs: null,
  dirtyPct: null,
  oplogWindowSec: null,
  backfillActive: false,
  hourlyUnits: null,
};

function rig(env: Record<string, unknown> = { WRITE_BUDGET_MODE: 'enforce' }, monitorOverride?: Partial<MongoMonitor>) {
  const clock = fakeClock();
  const redis = new FakeRedis(clock.now);
  const settings = resolveWriteBudgetSettings(env as never);
  const svc = new WriteBudgetService({ writeBudget: settings } as never, { client: async () => redis as never, namespace: 'ctl' }, {
    now: clock.now,
    sleep: clock.sleep,
  });
  const reading: MongoMonitorReading = { dirtyPct: null, oplogWindowSec: null, at: 0 };
  const monitor = { configured: settings.monitorConfigured, sample: async () => reading, current: () => reading, ...monitorOverride } as unknown as MongoMonitor;
  const ctl = new WriteBudgetController(svc, monitor, { now: clock.now, lag: () => ({ lagMs: null }) });
  const warns: string[] = [];
  (ctl as unknown as { logger: unknown }).logger = { warn: (l: string) => warns.push(l), log: () => {} };
  (svc as unknown as { logger: unknown }).logger = { warn: () => {}, log: () => {} };
  return { svc, ctl, redis, clock, warns, keys: writeBudgetKeys('ctl') };
}

const flush = () => new Promise((r) => setImmediate(r));

afterEach(() => {
  resetProcessRoleForTests();
  resetProcessStatusForTests();
  vi.useRealTimers();
});

describe('halve once per piece of evidence', () => {
  it('controllerStep: a held-only red blocks the green clock but never halves', () => {
    const held = controllerStep({ rate: 300, greenSince: 0 }, GREEN, S, 120_000, ['small_latency']);
    expect(held.state.rate).toBe(300);
    expect(held.action).toBe('hold');
    expect(held.state.greenSince).toBeNull();
    expect(held.reasons).toEqual(['small_latency']);
    // The same evidence FRESH halves.
    expect(controllerStep({ rate: 300, greenSince: 0 }, { ...GREEN, smallP95Ms: 999 }, S, 120_000).action).toBe('halve');
  });

  it('one slow burst halves R once; new slow evidence after the halving halves again; old evidence ages out to green', async () => {
    const a = rig();
    await a.ctl.tick(); // holder, R = 300
    a.svc.recordChunk({ ms: 400, units: 50, ops: 50 }); // one slow small chunk
    await flush();
    a.clock.advance(5_000);
    expect(await a.ctl.tick()).toMatchObject({ rate: 150, action: 'halve' });
    // The same sample is still inside the 30 s window for 5 more ticks: R stays.
    for (let i = 0; i < 4; i++) {
      a.clock.advance(5_000);
      const r = await a.ctl.tick();
      expect(r).toMatchObject({ rate: 150, action: 'hold', reasons: ['small_latency'] });
    }
    // Fresh slow evidence: one more halving (to MIN).
    a.svc.recordChunk({ ms: 400, units: 50, ops: 50 });
    await flush();
    a.clock.advance(1);
    expect(await a.ctl.tick()).toMatchObject({ rate: 100, action: 'halve' });
    // Past the 30 s window with nothing new: green again.
    a.clock.advance(31_000);
    expect((await a.ctl.tick()).reasons).toEqual([]);
  });
});

describe('a deposed holder never writes R', () => {
  it('the lease is taken by another process while this tick reads its inputs: R and ctl are not written', async () => {
    let steal: (() => Promise<void>) | undefined;
    const a = rig({ WRITE_BUDGET_MODE: 'enforce', MONGO_MONITOR_URI: 'mongodb://mon/' }, {
      sample: async () => {
        await steal?.();
        return { dirtyPct: 1, oplogWindowSec: 10 * 3600, at: 0 };
      },
    });
    await a.ctl.tick();
    expect(await a.redis.get(a.keys.rate)).toBe('300');
    await a.redis.set(a.keys.rate, '444', 'PX', 30_000); // a marker the deposed tick must not overwrite
    steal = async () => {
      await a.redis.set(a.keys.lease, 'someone-else', 'PX', 15_000);
    };
    a.clock.advance(5_000);
    const r = await a.ctl.tick();
    expect(r.holder).toBe(false);
    expect(await a.redis.get(a.keys.rate)).toBe('444');
    expect(a.warns.some((w) => w.includes('lease lost during the tick'))).toBe(true);
  });
});

describe('a hung Mongo monitor cannot hang the tick', () => {
  it('past MONITOR_SAMPLE_DEADLINE_MS the tick uses the last reading; the next tick reuses the sample still running', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const sample = vi.fn(() => new Promise<MongoMonitorReading>(() => undefined)); // never answers
    const current = vi.fn(() => ({ dirtyPct: 2, oplogWindowSec: 9 * 3600, at: 0 }));
    const a = rig({ WRITE_BUDGET_MODE: 'enforce', MONGO_MONITOR_URI: 'mongodb://mon/' }, { sample, current });
    const first = a.ctl.tick();
    await vi.advanceTimersByTimeAsync(MONITOR_SAMPLE_DEADLINE_MS);
    expect(await first).toMatchObject({ holder: true, rate: 300 });
    expect(current).toHaveBeenCalled();
    a.clock.advance(5_000);
    const second = a.ctl.tick();
    await vi.advanceTimersByTimeAsync(MONITOR_SAMPLE_DEADLINE_MS);
    await second;
    expect(sample).toHaveBeenCalledTimes(1); // never two serverStatus calls at once
  });
});

describe('role gate and status contributor', () => {
  it.each([
    ['all', true],
    ['api', true],
    ['sync', true],
    ['fee', true],
    ['feeder', false],
  ] as const)('role %s → controller enabled: %s (can(\'write-budget-controller\'))', (role, enabled) => {
    configureProcessRole({ processRole: role });
    // Settings built WITHOUT the role (runController true): the gate is can() itself.
    expect(rig().ctl.enabled).toBe(enabled);
  });

  it('registers `writeBudget` in the status record at init (every role, budget on or off) and removes it at destroy', async () => {
    const off = rig({});
    off.ctl.onModuleInit();
    const status = new ProcessStatusService(undefined, { namespace: 'ns', client: async () => undefined } as never);
    expect(status.record().writeBudget).toMatchObject({ mode: 'off' });
    await off.ctl.onModuleDestroy();
    expect(status.record()).not.toHaveProperty('writeBudget');
  });
});
