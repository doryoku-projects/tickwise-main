import { describe, expect, it } from 'vitest';
import {
  chunkSizeClass,
  DEFAULT_WRITE_BUDGET_SHARES,
  effectiveChunkOps,
  htbAcquire,
  htbFresh,
  htbLongestDebtMs,
  laneCapPerSec,
  MAX_BULK_WRITE_OPS,
  parseWriteBudgetShares,
  quantile,
  refreshQueueConcurrency,
  resolveWriteBudgetSettings,
  WRITE_BUDGET_OFF,
  type HtbParams,
  type HtbState,
} from '../../src/common/write-budget-model.js';
import { WRITE_LANES, type WriteLane } from '../../src/common/write-lane.js';

const SHARES = parseWriteBudgetShares(undefined);
const params = (over: Partial<HtbParams> = {}): HtbParams => ({ rate: 300, shares: SHARES, laneCap: 0, observe: false, ...over });

/**
 * Drive the bucket like N writers that each wait their answer before asking
 * again (enforce): every lane in `demand` sends `chunk` units per acquire.
 * Returns the units each lane got over `seconds`.
 */
function simulate(demand: WriteLane[], seconds: number, p: HtbParams, chunk = 30, laneCaps: Partial<Record<WriteLane, number>> = {}) {
  let state: HtbState | undefined;
  const nextAt = new Map<WriteLane, number>(demand.map((l) => [l, 0]));
  const got = new Map<WriteLane, number>(demand.map((l) => [l, 0]));
  const end = seconds * 1000;
  let t = 0;
  while (t < end) {
    // the lane whose next request is due first
    let lane: WriteLane | undefined;
    for (const l of demand) if (lane === undefined || nextAt.get(l)! < nextAt.get(lane)!) lane = l;
    t = nextAt.get(lane!)!;
    if (t >= end) break;
    const r = htbAcquire(state, t, lane!, chunk, -1, { ...p, laneCap: laneCaps[lane!] ?? 0 });
    state = r.state;
    got.set(lane!, got.get(lane!)! + chunk);
    nextAt.set(lane!, t + Math.max(1, r.wait));
  }
  return got;
}

describe('write budget model — parsing and settings', () => {
  it('normalises the default shares to sum 1 in the design proportions', () => {
    const total = WRITE_LANES.reduce((s, l) => s + SHARES[l], 0);
    expect(total).toBeCloseTo(1, 12);
    expect(SHARES.refresh).toBeCloseTo(0.3, 12);
    expect(SHARES.fee).toBeCloseTo(0.25, 12);
    expect(SHARES.live).toBeCloseTo(0.1, 12);
  });

  it('keeps defaults for unnamed lanes, ignores unknown lanes and non-positive weights', () => {
    const s = parseWriteBudgetShares('backfill:50, nope:99, live:0, fee:abc');
    const weights = { ...DEFAULT_WRITE_BUDGET_SHARES, backfill: 50 };
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    expect(s.backfill).toBeCloseTo(50 / total, 12);
    expect(s.live).toBeCloseTo(DEFAULT_WRITE_BUDGET_SHARES.live / total, 12);
    expect(s.fee).toBeCloseTo(DEFAULT_WRITE_BUDGET_SHARES.fee / total, 12);
    for (const l of WRITE_LANES) expect(s[l]).toBeGreaterThan(0);
  });

  it('defaults to today: mode off, start 300, MIN 100, MAX 450, H = 0.5 × MAX, maxOps 0', () => {
    expect(WRITE_BUDGET_OFF).toMatchObject({
      mode: 'off',
      startPerSec: 300,
      minPerSec: 100,
      maxPerSec: 450,
      hourlyPerSec: 225,
      hourlyClamped: false,
      readUnit: 0.15,
      unitLatencyRedMs: 2,
      latencyRedMs: 150,
      lagRedMs: 5000,
      backfillMaxNoMonitor: 100,
      localDivisor: 3,
      monitorConfigured: false,
      maxOps: 0,
      runController: true,
    });
  });

  it('clamps H above 0.5 × MAX without MONGO_MONITOR_URI, and allows it with one', () => {
    const clamped = resolveWriteBudgetSettings({ WRITE_BUDGET_HOURLY_UNITS_PER_SEC: '480' });
    expect(clamped.hourlyPerSec).toBe(225);
    expect(clamped.hourlyRequestedPerSec).toBe(480);
    expect(clamped.hourlyClamped).toBe(true);
    const allowed = resolveWriteBudgetSettings({ WRITE_BUDGET_HOURLY_UNITS_PER_SEC: 480, MONGO_MONITOR_URI: 'mongodb://mon@x/' });
    expect(allowed.hourlyPerSec).toBe(480);
    expect(allowed.hourlyClamped).toBe(false);
    expect(allowed.monitorConfigured).toBe(true);
    // at or below half of MAX needs no monitor
    expect(resolveWriteBudgetSettings({ WRITE_BUDGET_HOURLY_UNITS_PER_SEC: '200' })).toMatchObject({ hourlyPerSec: 200, hourlyClamped: false });
  });

  it('clamps the range: MIN ≥ 1, MAX ≥ MIN, start within it, H ≥ MIN, maxOps ≤ 500; blanks read as defaults', () => {
    const s = resolveWriteBudgetSettings({
      WRITE_BUDGET_MODE: 'enforce',
      WRITE_BUDGET_MIN: '150',
      WRITE_BUDGET_MAX: '120',
      WRITE_BUDGET_UNITS_PER_SEC: '1000',
      MONGO_BULK_WRITE_MAX_OPS: '2000',
      WRITE_BUDGET_READ_UNIT: '',
    });
    expect(s.mode).toBe('enforce');
    expect(s.minPerSec).toBe(150);
    expect(s.maxPerSec).toBe(150);
    expect(s.startPerSec).toBe(150);
    expect(s.hourlyPerSec).toBe(150);
    expect(s.maxOps).toBe(MAX_BULK_WRITE_OPS);
    expect(s.readUnit).toBe(0.15);
    expect(resolveWriteBudgetSettings({ WRITE_BUDGET_MODE: 'garbage' }).mode).toBe('off');
  });

  it('feeder never runs the controller; every other role may', () => {
    expect(resolveWriteBudgetSettings({ PROCESS_ROLE: 'feeder' }).runController).toBe(false);
    for (const role of ['all', 'api', 'sync', 'fee']) expect(resolveWriteBudgetSettings({ PROCESS_ROLE: role }).runController).toBe(true);
  });

  it('caps the backfill lane only while no monitor is configured', () => {
    expect(laneCapPerSec(WRITE_BUDGET_OFF, 'backfill')).toBe(100);
    expect(laneCapPerSec(WRITE_BUDGET_OFF, 'refresh')).toBe(0);
    expect(laneCapPerSec(resolveWriteBudgetSettings({ MONGO_MONITOR_URI: 'mongodb://m/' }), 'backfill')).toBe(0);
  });
});

describe('refresh queue concurrency clamp (§5.2)', () => {
  it('> 1 only while the budget enforces; otherwise clamped to 1 and flagged', () => {
    expect(refreshQueueConcurrency(4, 'enforce')).toEqual({ value: 4, clamped: false });
    expect(refreshQueueConcurrency(4, 'observe')).toEqual({ value: 1, clamped: true });
    expect(refreshQueueConcurrency(4, 'off')).toEqual({ value: 1, clamped: true });
    expect(refreshQueueConcurrency(1, 'off')).toEqual({ value: 1, clamped: false });
    expect(refreshQueueConcurrency(Number.NaN, 'enforce')).toEqual({ value: 1, clamped: false });
    expect(refreshQueueConcurrency(2.7, 'enforce')).toEqual({ value: 2, clamped: false });
  });
});

describe('write budget model — chunk sizes', () => {
  it('size classes split at 100 and 500 ops', () => {
    expect(chunkSizeClass(1)).toBe('s');
    expect(chunkSizeClass(100)).toBe('s');
    expect(chunkSizeClass(101)).toBe('m');
    expect(chunkSizeClass(500)).toBe('m');
    expect(chunkSizeClass(501)).toBe('l');
  });

  it('off + MONGO_BULK_WRITE_MAX_OPS unset = the caller’s own chunking (today)', () => {
    expect(effectiveChunkOps(WRITE_BUDGET_OFF)).toBe(Number.POSITIVE_INFINITY);
    expect(effectiveChunkOps(WRITE_BUDGET_OFF, 500)).toBe(500);
    expect(effectiveChunkOps(WRITE_BUDGET_OFF, 10_000)).toBe(10_000);
  });

  it('never more than 500 ops per chunk while the budget is on', () => {
    for (const mode of ['observe', 'enforce']) {
      const s = resolveWriteBudgetSettings({ WRITE_BUDGET_MODE: mode });
      expect(effectiveChunkOps(s)).toBe(500);
      expect(effectiveChunkOps(s, 10_000)).toBe(500);
      expect(effectiveChunkOps(s, 100)).toBe(100);
    }
  });

  it('MONGO_BULK_WRITE_MAX_OPS applies in any mode', () => {
    expect(effectiveChunkOps(resolveWriteBudgetSettings({ MONGO_BULK_WRITE_MAX_OPS: '300' }), 10_000)).toBe(300);
    expect(effectiveChunkOps(resolveWriteBudgetSettings({ MONGO_BULK_WRITE_MAX_OPS: '300', WRITE_BUDGET_MODE: 'enforce' }))).toBe(300);
  });
});

describe('write budget model — the hierarchical token bucket', () => {
  it('a fresh bucket holds one second of every lane plus one second of R in the pool', () => {
    const s = htbFresh(0, params());
    expect(s.lanes.refresh).toBeCloseTo(90, 9);
    expect(s.lanes.live).toBeCloseTo(30, 9);
    expect(s.g).toBe(300);
  });

  it('takes from the lane, then the pool, and only then runs a debt, repaid at its share plus the idle lanes’ rates', () => {
    const p = params();
    // lane refresh: 90 in its bucket + 300 in the pool
    let r = htbAcquire(undefined, 0, 'refresh', 80, -1, p);
    expect(r.wait).toBe(0);
    expect(r.state.lanes.refresh).toBeCloseTo(10, 9);
    expect(r.state.g).toBeCloseTo(300, 9);
    r = htbAcquire(r.state, 0, 'refresh', 100, -1, p); // 10 from the lane, 90 from the pool
    expect(r.wait).toBe(0);
    expect(r.state.lanes.refresh).toBeCloseTo(0, 9);
    expect(r.state.g).toBeCloseTo(210, 9);
    r = htbAcquire(r.state, 0, 'refresh', 300, -1, p); // 210 from the pool, 90 of debt
    expect(r.state.g).toBeCloseTo(0, 9);
    expect(r.state.lanes.refresh).toBeCloseTo(-90, 9);
    // 90 / (0.3 × 300 + the idle lanes' 0.7 × 300) s — every other lane is full = idle
    expect(r.wait).toBe(300);
  });

  it('with every other lane busy (in debt) the wait is debt / (share × R) — no idle capacity to borrow', () => {
    const p = params();
    const lanes = Object.fromEntries(WRITE_LANES.map((l) => [l, -10])) as Record<WriteLane, number>;
    const state: HtbState = { ts: 0, g: 0, lanes, caps: {} }; // every lane drained, a small debt each
    const r = htbAcquire(state, 0, 'refresh', 90, -1, p);
    // refresh: −10 − 90 = −100 of debt, repaid at its own 90 u/s; the other lanes' debts are theirs
    expect(r.state.lanes.refresh).toBeCloseTo(-100, 9);
    expect(r.wait).toBe(Math.ceil((100 / 90) * 1000));
  });

  it('two lanes in debt split the idle lanes’ capacity by share (refill and wait estimate)', () => {
    const p = params();
    let state: HtbState | undefined = htbAcquire(undefined, 0, 'refresh', 90 + 300 + 90, -1, p).state; // refresh −90
    state = htbAcquire(state, 0, 'backfill', 75 + 75, -1, p).state; // backfill −75 (pool empty)
    expect(state.lanes.refresh).toBeCloseTo(-90, 9);
    expect(state.lanes.backfill).toBeCloseTo(-75, 9);
    // 100 ms later: own refills 9 / 7.5; the idle lanes (live, fee, pools, other = 0.45 × 300) overflow
    // 13.5 u, split 0.3 : 0.25 between refresh and backfill
    const after = htbAcquire(state, 100, 'live', 0, -1, p).state;
    expect(after.lanes.refresh).toBeCloseTo(-90 + 9 + (13.5 * 0.3) / 0.55, 9);
    expect(after.lanes.backfill).toBeCloseTo(-75 + 7.5 + (13.5 * 0.25) / 0.55, 9);
    expect(after.g).toBeCloseTo(0, 9);
    // The wait estimate splits the idle rate the same way: refresh's part of the
    // idle 0.45 × 300 is 0.3 / (0.3 + 0.25) — not all of it (backfill borrows too).
    const more = htbAcquire(state, 0, 'refresh', 10, -1, p); // refresh −100
    const repay = 90 + (0.45 * 300 * 0.3) / 0.55;
    expect(more.wait).toBe(Math.ceil((100 / repay) * 1000));
  });

  it('debt queues later callers of the SAME lane behind earlier ones (arrival order)', () => {
    const p = params();
    let state: HtbState | undefined = htbAcquire(undefined, 0, 'fee', 375, -1, p).state; // drains lane (75) + pool (300)
    const waits: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = htbAcquire(state, 0, 'fee', 75, -1, p);
      state = r.state;
      waits.push(r.wait);
    }
    // repaid at 75 + the idle 0.75 × 300 = 300 u/s
    expect(waits).toEqual([250, 500, 750, 1000]);
  });

  it('one lane’s debt never delays another lane while that lane has its own tokens', () => {
    const p = params();
    let state = htbAcquire(undefined, 0, 'backfill', 2000, -1, p).state;
    expect(state.lanes.backfill).toBeLessThan(0);
    const live = htbAcquire(state, 0, 'live', 20, -1, p);
    expect(live.wait).toBe(0);
    state = live.state;
    expect(state.lanes.live).toBeCloseTo(10, 9);
  });

  it('a lane in debt is repaid by its own refill AND the idle lanes’ overflow; only the rest reaches the pool', () => {
    const p = params();
    let state = htbAcquire(undefined, 0, 'backfill', 375 + 300, -1, p).state; // 300 u of debt (lane rate 75/s)
    expect(state.lanes.backfill).toBeCloseTo(-300, 9);
    state = htbAcquire(state, 500, 'live', 0, -1, p).state; // 0.5 s: own 37.5 + idle 0.75 × 300 × 0.5 = 112.5
    expect(state.lanes.backfill).toBeCloseTo(-150, 9);
    expect(state.g).toBeCloseTo(0, 9);
    state = htbAcquire(state, 1000, 'live', 0, -1, p).state; // another 150: repaid, the bucket ends at 0
    expect(state.lanes.backfill).toBeCloseTo(0, 9);
    state = htbAcquire(state, 2000, 'live', 0, -1, p).state; // 1 s more: the lane fills (75), 225 overflow to the pool
    expect(state.lanes.backfill).toBeCloseTo(75, 9);
    expect(state.g).toBeCloseTo(225, 9);
  });

  it('a refused acquire (wait > maxWait) takes nothing and answers −wait', () => {
    const p = params();
    const drained = htbAcquire(undefined, 0, 'pools', 15 + 300, -1, p).state;
    const r = htbAcquire(drained, 0, 'pools', 15, 20, p); // 15 u at 15 + 285 idle u/s = 50 ms > 20
    expect(r.wait).toBe(-50);
    expect(r.state.lanes.pools).toBeCloseTo(drained.lanes.pools, 9);
    expect(r.state.g).toBeCloseTo(drained.g, 9);
    const ok = htbAcquire(drained, 0, 'pools', 15, 50, p);
    expect(ok.wait).toBe(50);
  });

  it('observe keeps each debt within one second of its lane rate (the would-wait stays meaningful)', () => {
    const p = params({ observe: true });
    let state: HtbState | undefined;
    let last = 0;
    for (let i = 0; i < 20; i++) {
      const r = htbAcquire(state, 0, 'refresh', 500, -1, p);
      state = r.state;
      last = r.wait;
    }
    expect(state!.lanes.refresh).toBeGreaterThanOrEqual(-90 - 1e-9);
    expect(last).toBeGreaterThan(1000); // what enforce would have waited for that call
    // enforce does not clamp
    const enforce = htbAcquire(undefined, 0, 'refresh', 5000, -1, params());
    expect(enforce.state.lanes.refresh).toBeLessThan(-1000);
  });

  it('refill caps each lane at one second and overflows the rest into the pool, capped at one second of R', () => {
    const p = params();
    let state = htbAcquire(undefined, 0, 'refresh', 90 + 300, -1, p).state; // lane 0, pool 0
    state = htbAcquire(state, 10_000, 'live', 0, -1, p).state; // 10 s idle
    for (const l of WRITE_LANES) expect(state.lanes[l]).toBeCloseTo(SHARES[l] * 300, 9);
    expect(state.g).toBeCloseTo(300, 9);
  });

  it('when R falls, banked credit above the new caps is dropped, not moved to the pool', () => {
    let state = htbFresh(0, params({ rate: 400 }));
    state = htbAcquire(state, 0, 'live', 0, -1, params({ rate: 400 })).state;
    state = { ...state, g: 0 };
    const after = htbAcquire(state, 1, 'other', 0, -1, params({ rate: 100 })).state;
    expect(after.lanes.refresh).toBeCloseTo(30, 9);
    // only the 1 ms refill itself (R × dt = 0.1 u) overflows; the ~300 u banked above the new caps is gone
    expect(after.g).toBeCloseTo(0.1, 6);
  });

  it('under saturation every lane gets at least its share of R', () => {
    const got = simulate([...WRITE_LANES], 120, params());
    for (const l of WRITE_LANES) {
      const rate = got.get(l)! / 120;
      expect(rate).toBeGreaterThanOrEqual(SHARES[l] * 300 * 0.97);
    }
    const total = [...got.values()].reduce((a, b) => a + b, 0) / 120;
    expect(total).toBeLessThanOrEqual(300 * 1.03);
  });

  it('idle capacity is borrowed: a lane alone gets ~all of R, not just its share', () => {
    const got = simulate(['backfill'], 120, params());
    expect(got.get('backfill')! / 120).toBeGreaterThan(300 * 0.95);
  });

  it('…also with chunks larger than one second of R (500-op position chunks: backfill 825 u, refresh 575 u)', () => {
    // Round-1 review: with debt repaid from the lane's own share only, these got 39 % / 63 % of R.
    for (const [lane, chunk, rate] of [
      ['backfill', 825, 300],
      ['refresh', 575, 300],
      ['refresh', 575, 100],
      ['backfill', 825, 450],
    ] as const) {
      const got = simulate([lane], 600, params({ rate }), chunk);
      expect(got.get(lane)! / 600, `${lane} ${chunk} u at R=${rate}`).toBeGreaterThan(rate * 0.9);
      expect(got.get(lane)! / 600).toBeLessThanOrEqual(rate * 1.05);
    }
  });

  it('two lanes with big chunks still each keep their share and together use ~all of R', () => {
    const got = simulate(['backfill', 'refresh'], 600, params(), 575);
    const bf = got.get('backfill')! / 600;
    const rf = got.get('refresh')! / 600;
    expect(bf + rf).toBeGreaterThan(300 * 0.9);
    expect(bf + rf).toBeLessThanOrEqual(300 * 1.05);
    expect(bf).toBeGreaterThanOrEqual(75 * 0.95);
    expect(rf).toBeGreaterThanOrEqual(90 * 0.95);
  });

  it('a busy lane with big chunks never pushes a small lane below its share', () => {
    const got = simulate(['backfill', 'live'], 600, params(), 30);
    const big = simulate(['backfill'], 600, params(), 825);
    expect(big.get('backfill')! / 600).toBeGreaterThan(270);
    // live alone at 30 u per call with backfill saturating: live keeps ≥ its 30 u/s
    expect(got.get('live')! / 600).toBeGreaterThanOrEqual(30 * 0.95);
  });

  it('two busy lanes split the idle lanes’ capacity and each still keeps its own share', () => {
    const got = simulate(['backfill', 'refresh'], 120, params());
    const bf = got.get('backfill')! / 120;
    const rf = got.get('refresh')! / 120;
    expect(bf + rf).toBeGreaterThan(300 * 0.95);
    expect(bf).toBeGreaterThanOrEqual(75 * 0.97);
    expect(rf).toBeGreaterThanOrEqual(90 * 0.97);
  });

  it('a lane cap holds the backfill lane to it even when R and the pool would give more', () => {
    const got = simulate(['backfill'], 120, params({ rate: 450 }), 30, { backfill: 100 });
    expect(got.get('backfill')! / 120).toBeLessThanOrEqual(100 * 1.03);
    expect(got.get('backfill')! / 120).toBeGreaterThan(100 * 0.9);
  });

  it('the state outlives its longest debt', () => {
    const state = htbAcquire(undefined, 0, 'pools', 15 + 300 + 150, -1, params()).state;
    expect(htbLongestDebtMs(state, 300, SHARES)).toBe(10_000);
  });

  it('quantile is nearest-rank and unrounded', () => {
    expect(quantile([], 0.95)).toBeNull();
    expect(quantile([0.4, 0.5, 0.6], 0.95)).toBe(0.6);
    expect(quantile(Array.from({ length: 100 }, (_, i) => i + 1), 0.95)).toBe(95);
  });
});
