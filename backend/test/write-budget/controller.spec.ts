import { describe, expect, it } from 'vitest';
import {
  CONTROLLER_LEASE_TTL_MS,
  controllerStep,
  GREEN_HOLD_MS,
  latencyInputs,
  RATE_TTL_MS,
  redReasons,
  WriteBudgetController,
  type ControllerInputs,
} from '../../src/common/write-budget-controller.js';
import { WriteBudgetService, writeBudgetKeys } from '../../src/common/write-budget.js';
import { resolveWriteBudgetSettings } from '../../src/common/write-budget-model.js';
import type { MongoMonitor } from '../../src/database/mongo-monitor.js';
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
const sample = (ms: number, units: number, ops: number, at: number) => `${ms}:${units}:${ops}:${at}`;

describe('controller inputs — latency by size class', () => {
  it('an idle 500-op chunk at 250 ms stays GREEN (0.5 ms per unit)', () => {
    const lat = latencyInputs({ s: [], m: [sample(250, 500, 500, 1000)], l: [] }, 0);
    expect(lat.unitP95MsPerUnit).toBeCloseTo(0.5, 9);
    expect(lat.smallP95Ms).toBeNull();
    expect(redReasons({ ...GREEN, ...lat }, S)).toEqual([]);
  });

  it('a 100-op chunk at 200 ms is RED (small-chunk absolute latency)', () => {
    const lat = latencyInputs({ s: [sample(200, 100, 100, 1000)], m: [], l: [] }, 0);
    expect(lat.smallP95Ms).toBe(200);
    expect(lat.unitP95MsPerUnit).toBeNull();
    expect(redReasons({ ...GREEN, ...lat }, S)).toEqual(['small_latency']);
  });

  it('per-unit latency divides by UNITS, not ops (a costly chunk may take longer)', () => {
    const cheap = latencyInputs({ s: [], m: [sample(1500, 500, 500, 1)], l: [] }, 0);
    expect(redReasons({ ...GREEN, ...cheap }, S)).toEqual(['unit_latency']); // 3 ms/u
    const costly = latencyInputs({ s: [], m: [sample(1500, 1000, 500, 1)], l: [] }, 0);
    expect(redReasons({ ...GREEN, ...costly }, S)).toEqual([]); // 1.5 ms/u
  });

  it('the >500 class feeds the per-unit input; ≤100 never does', () => {
    const big = latencyInputs({ s: [sample(140, 1, 100, 1)], m: [], l: [sample(3000, 1000, 1000, 1)] }, 0);
    expect(big.unitP95MsPerUnit).toBeCloseTo(3, 9);
    expect(big.smallP95Ms).toBe(140);
  });

  it('a 101-op chunk at 200 ms is not in the small class (green at 1.98 ms/u)', () => {
    const lat = latencyInputs({ s: [], m: [sample(200, 101, 101, 1)], l: [] }, 0);
    expect(redReasons({ ...GREEN, ...lat }, S)).toEqual([]);
  });

  it('samples older than the window are ignored; garbage is skipped', () => {
    const lat = latencyInputs({ s: [sample(900, 10, 10, 5), 'garbage'], m: [], l: [] }, 100);
    expect(lat.smallP95Ms).toBeNull();
    expect(lat.samples.s).toBe(0);
  });
});

describe('controller inputs — lag, dirty, oplog, hourly', () => {
  it('lag above WRITE_BUDGET_LAG_RED_MS is red', () => {
    expect(redReasons({ ...GREEN, lagMs: 5000 }, S)).toEqual([]);
    expect(redReasons({ ...GREEN, lagMs: 5001 }, S)).toEqual(['lag']);
  });

  it('dirty above 10 % is red', () => {
    expect(redReasons({ ...GREEN, dirtyPct: 10 }, S)).toEqual([]);
    expect(redReasons({ ...GREEN, dirtyPct: 10.5 }, S)).toEqual(['dirty']);
  });

  it('oplog window under 2 h is red; under 3 h only while the backfill lane consumes', () => {
    expect(redReasons({ ...GREEN, oplogWindowSec: 7199 }, S)).toEqual(['oplog']);
    expect(redReasons({ ...GREEN, oplogWindowSec: 2.5 * 3600 }, S)).toEqual([]);
    expect(redReasons({ ...GREEN, oplogWindowSec: 2.5 * 3600, backfillActive: true }, S)).toEqual(['oplog_backfill']);
    expect(redReasons({ ...GREEN, oplogWindowSec: 3 * 3600, backfillActive: true }, S)).toEqual([]);
  });

  it('hourly use above H × 3600 is red', () => {
    expect(redReasons({ ...GREEN, hourlyUnits: 225 * 3600 }, S)).toEqual([]);
    expect(redReasons({ ...GREEN, hourlyUnits: 225 * 3600 + 1 }, S)).toEqual(['hourly']);
  });
});

describe('controller — the AIMD step', () => {
  it('any red halves R, never below MIN', () => {
    let st = { rate: 300, greenSince: null as number | null };
    st = controllerStep(st, { ...GREEN, lagMs: 9000 }, S, 0).state;
    expect(st.rate).toBe(150);
    st = controllerStep(st, { ...GREEN, lagMs: 9000 }, S, 5000).state;
    expect(st.rate).toBe(100);
    st = controllerStep(st, { ...GREEN, lagMs: 9000 }, S, 10_000).state;
    expect(st.rate).toBe(100);
  });

  it('all green for 60 s → +10 %, then another 60 s for the next step; never above MAX', () => {
    let st = { rate: 300, greenSince: null as number | null };
    let r = controllerStep(st, GREEN, S, 0);
    expect(r.action).toBe('hold');
    st = r.state;
    r = controllerStep(st, GREEN, S, GREEN_HOLD_MS - 1);
    expect(r.state.rate).toBe(300);
    st = r.state;
    r = controllerStep(st, GREEN, S, GREEN_HOLD_MS);
    expect(r.state.rate).toBeCloseTo(330, 9);
    expect(r.action).toBe('increase');
    st = r.state;
    r = controllerStep(st, GREEN, S, GREEN_HOLD_MS + 5000);
    expect(r.state.rate).toBeCloseTo(330, 9);
    let s2 = { rate: 440, greenSince: 0 as number | null };
    s2 = controllerStep(s2, GREEN, S, GREEN_HOLD_MS).state;
    expect(s2.rate).toBe(450);
  });

  it('a red tick restarts the green hold', () => {
    let st = controllerStep({ rate: 300, greenSince: null }, GREEN, S, 0).state;
    st = controllerStep(st, { ...GREEN, smallP95Ms: 999 }, S, 30_000).state;
    expect(st.rate).toBe(150);
    st = controllerStep(st, GREEN, S, 40_000).state;
    st = controllerStep(st, GREEN, S, 90_000).state; // only 50 s green
    expect(st.rate).toBe(150);
    st = controllerStep(st, GREEN, S, 100_000).state;
    expect(st.rate).toBeCloseTo(165, 9);
  });

  it('hourly red caps R at H (not a halving) and holds it there', () => {
    const r = controllerStep({ rate: 400, greenSince: 0 }, { ...GREEN, hourlyUnits: 1e9 }, S, GREEN_HOLD_MS * 2);
    expect(r.state.rate).toBe(225);
    expect(r.action).toBe('cap');
    expect(r.reasons).toEqual(['hourly']);
    const below = controllerStep({ rate: 200, greenSince: 0 }, { ...GREEN, hourlyUnits: 1e9 }, S, GREEN_HOLD_MS * 2);
    expect(below.state.rate).toBe(200); // no increase while hourly is red
  });

  it('hourly + another red: halve, then cap', () => {
    const r = controllerStep({ rate: 450, greenSince: null }, { ...GREEN, hourlyUnits: 1e9, lagMs: 1e5 }, S, 0);
    expect(r.state.rate).toBe(225);
    expect(r.action).toBe('halve');
  });
});

/** A WriteBudgetService on a fake Redis + clock, and a controller over it. */
function rig(env: Record<string, unknown> = { WRITE_BUDGET_MODE: 'enforce' }, shared?: { redis: FakeRedis; clock: ReturnType<typeof fakeClock> }) {
  const clock = shared?.clock ?? fakeClock();
  const redis = shared?.redis ?? new FakeRedis(clock.now);
  const settings = resolveWriteBudgetSettings(env as never);
  const svc = new WriteBudgetService({ writeBudget: settings } as never, { client: async () => redis as never, namespace: 'ctl' }, {
    now: clock.now,
    sleep: clock.sleep,
  });
  let lag: number | null = null;
  const monitorReading = { dirtyPct: null as number | null, oplogWindowSec: null as number | null, at: 0 };
  const monitor = { configured: settings.monitorConfigured, sample: async () => monitorReading } as unknown as MongoMonitor;
  const ctl = new WriteBudgetController(svc, monitor, { now: clock.now, lag: () => ({ lagMs: lag }) });
  const warns: string[] = [];
  (ctl as unknown as { logger: unknown }).logger = { warn: (l: string) => warns.push(l), log: () => {} };
  (svc as unknown as { logger: unknown }).logger = { warn: () => {}, log: () => {} };
  return { svc, ctl, redis, clock, warns, setLag: (v: number | null) => (lag = v), monitorReading, keys: writeBudgetKeys('ctl') };
}

describe('controller — the service (lease, inputs from Redis, rate key)', () => {
  it('does nothing while the budget is off or in the feeder role', async () => {
    const off = rig({});
    expect(off.ctl.enabled).toBe(false);
    expect((await off.ctl.tick()).holder).toBe(false);
    expect(off.redis.calls).toEqual([]);
    const feeder = rig({ WRITE_BUDGET_MODE: 'enforce', PROCESS_ROLE: 'feeder' });
    expect(feeder.ctl.enabled).toBe(false);
  });

  it('one holder fleet-wide writes R (start 300) with a 30 s TTL; a second controller stands by', async () => {
    const a = rig();
    const b = rig({ WRITE_BUDGET_MODE: 'enforce' }, { redis: a.redis, clock: a.clock });
    const ra = await a.ctl.tick();
    const rb = await b.ctl.tick();
    expect(ra).toMatchObject({ holder: true, rate: 300 });
    expect(rb.holder).toBe(false);
    expect(await a.redis.get(a.keys.rate)).toBe('300');
    expect(a.redis.expiry.get(a.keys.rate)).toBe(a.clock.now() + RATE_TTL_MS);
    expect(a.redis.expiry.get(a.keys.lease)).toBe(a.clock.now() + CONTROLLER_LEASE_TTL_MS);
    const fleet = await b.ctl.fleetStatus();
    expect(fleet).toMatchObject({ rate: 300, reasons: [], action: 'hold' });
  });

  it('halves on a slow small chunk recorded by ANY process, read from the shared list', async () => {
    const a = rig();
    const writer = rig({ WRITE_BUDGET_MODE: 'enforce' }, { redis: a.redis, clock: a.clock });
    await a.ctl.tick();
    writer.svc.recordChunk({ ms: 400, units: 50, ops: 50 });
    await new Promise((r) => setImmediate(r));
    a.clock.advance(5000);
    const r = await a.ctl.tick();
    expect(r).toMatchObject({ rate: 150, reasons: ['small_latency'], action: 'halve' });
  });

  it('an idle 500-op chunk at 250 ms keeps R where it is (green), then R grows after 60 s', async () => {
    const a = rig();
    await a.ctl.tick();
    a.svc.recordChunk({ ms: 250, units: 500, ops: 500 });
    await new Promise((r) => setImmediate(r));
    for (let i = 1; i <= 13; i++) {
      a.clock.advance(5000);
      if (i % 4 === 0) {
        a.svc.recordChunk({ ms: 250, units: 500, ops: 500 });
        await new Promise((r) => setImmediate(r));
      }
      const r = await a.ctl.tick();
      expect(r.reasons).toEqual([]);
    }
    expect(Number(await a.redis.get(a.keys.rate))).toBeCloseTo(330, 9);
  });

  it('lag from the driver’s heartbeats halves R', async () => {
    const a = rig();
    await a.ctl.tick();
    a.setLag(8000);
    a.clock.advance(5000);
    expect(await a.ctl.tick()).toMatchObject({ rate: 150, reasons: ['lag'] });
  });

  it('the oplog 3 h rule applies only while the backfill lane consumed in the last 5 min', async () => {
    const env = { WRITE_BUDGET_MODE: 'enforce', MONGO_MONITOR_URI: 'mongodb://mon/' };
    const a = rig(env);
    a.monitorReading.oplogWindowSec = 2.5 * 3600;
    a.monitorReading.dirtyPct = 3;
    expect((await a.ctl.tick()).reasons).toEqual([]);
    await a.svc.acquire(10, { lane: 'backfill' });
    a.clock.advance(5000);
    expect((await a.ctl.tick()).reasons).toEqual(['oplog_backfill']);
    a.clock.advance(6 * 60_000); // backfill idle > 5 min
    expect((await a.ctl.tick()).reasons).toEqual([]);
  });

  it('the hourly sum comes from the per-minute counters across processes and caps R at H', async () => {
    const a = rig();
    await a.ctl.tick();
    const minute = Math.floor(a.clock.now() / 60_000);
    for (let i = 0; i < 60; i++) {
      a.redis.run('hset', [a.keys.minute(minute - i), { all: String(230 * 60) }]);
    }
    a.clock.advance(5000);
    expect(await a.ctl.tick()).toMatchObject({ rate: 225, reasons: ['hourly'], action: 'cap' });
  });

  it('a new holder continues from the fleet’s live R instead of restarting at 300', async () => {
    const a = rig();
    await a.redis.set(a.keys.rate, '180', 'PX', 30_000);
    expect(await a.ctl.tick()).toMatchObject({ holder: true, rate: 180 });
  });

  it('a lost lease stops this process steering R', async () => {
    const a = rig();
    await a.ctl.tick();
    a.clock.advance(CONTROLLER_LEASE_TTL_MS + 1); // lease lapsed (no tick renewed it)
    await a.redis.set(a.keys.lease, 'someone-else', 'PX', 15_000);
    expect((await a.ctl.tick()).holder).toBe(false);
    expect(a.ctl.snapshot().holder).toBe(false);
  });

  it('Redis unavailable: no controller (acquirers use their local floor)', async () => {
    const a = rig();
    a.redis.failing = true;
    expect(await a.ctl.tick()).toMatchObject({ holder: false });
  });

  it('H above 0.5 × MAX with a monitor logs hourly_override (once an hour)', async () => {
    const a = rig({ WRITE_BUDGET_MODE: 'enforce', MONGO_MONITOR_URI: 'mongodb://m/', WRITE_BUDGET_HOURLY_UNITS_PER_SEC: 400 });
    await a.ctl.tick();
    a.clock.advance(5000);
    await a.ctl.tick();
    expect(a.warns.filter((w) => w.includes('[alert] write_budget.hourly_override'))).toHaveLength(1);
  });

  it('status(): budget view + controller + fleet decision + hourly use in % of H', async () => {
    const a = rig();
    const minute = Math.floor(a.clock.now() / 60_000);
    a.redis.run('hset', [a.keys.minute(minute), { all: String(225 * 3600 * 0.25) }]);
    await a.ctl.tick();
    const st = await a.ctl.status();
    expect(st.mode).toBe('enforce');
    expect(st.controller).toMatchObject({ holder: true, rate: 300 });
    expect(st.fleet).toMatchObject({ rate: 300 });
    expect(st.hourlyPct).toBe(25);
    expect(st.perLane.refresh).toBeDefined();
  });

  it('R held at MIN for > 20 % of the hour logs write_budget.floor', async () => {
    const a = rig();
    a.setLag(60_000);
    for (let i = 0; i < 200; i++) {
      await a.ctl.tick();
      a.clock.advance(5000);
    }
    expect(a.warns.some((w) => w.includes('[alert] write_budget.floor'))).toBe(true);
    expect(a.ctl.snapshot().floorShareLastHour).toBeGreaterThan(0.2);
  });
});
