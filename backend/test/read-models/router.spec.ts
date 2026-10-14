/*
 * Degraded mode and the fleet circuit (design §7.2, P-R R4): per-request
 * reason families, model-level transitions (one alert per transition, a
 * deploy's first load is not one), the circuit's transition alerts, and the
 * degraded policy (`narrow` only while the circuit is open — and only once the
 * list services implement it).
 */
import { describe, expect, it } from 'vitest';
import type { FleetBeat } from '../../src/read-models/fleet.js';
import {
  CircuitWatcher,
  classifyFallback,
  decideRoute,
  degradedRoute,
  DegradedTracker,
  modelDegradedReason,
  NARROW_WIRED,
  splitFallbacks,
} from '../../src/read-models/router.js';
import { AlertLog } from '../../src/read-models/status.js';

function clockedAlerts() {
  let now = 1_000_000;
  const lines: string[] = [];
  const alerts = new AlertLog({ warn: (line: string) => lines.push(line) }, () => now);
  return { alerts, lines, tick: (ms: number) => (now += ms), now: () => now };
}

describe('per-request fallback reasons', () => {
  it('splits the engines’ reasons into policy / unsupported / degraded', () => {
    expect(classifyFallback('mode')).toBe('policy');
    expect(classifyFallback('percent')).toBe('policy');
    for (const r of ['unsupported:in-array', 'cast:CastError', 'sort', 'shape', 'no_plan']) expect(classifyFallback(r)).toBe('unsupported');
    for (const r of ['shard_not_ready', 'not_caught_up', 'engine_error', 'rows:MongoServerError', 'holder_scanning', 'catalog_lag', 'instance_changed']) {
      expect(classifyFallback(r)).toBe('degraded');
    }
    expect(splitFallbacks({ mode: 5, percent: 2, 'unsupported:x': 3, shard_not_ready: 4, engine_error: 1 })).toEqual({
      policy: { mode: 5, percent: 2 },
      unsupported: { 'unsupported:x': 3 },
      degraded: { shard_not_ready: 4, engine_error: 1 },
    });
    expect(splitFallbacks(undefined)).toEqual({ policy: {}, unsupported: {}, degraded: {} });
  });
});

describe('the degraded policy', () => {
  it('p1 always takes the P1 path; narrow only while the circuit is open AND the services implement it', () => {
    expect(NARROW_WIRED).toBe(false);
    expect(degradedRoute('p1', true)).toBe('p1');
    expect(degradedRoute('narrow', false, true)).toBe('p1');
    expect(degradedRoute('narrow', true, true)).toBe('narrow');
    // not wired yet: a configured narrow behaves exactly as p1
    expect(degradedRoute('narrow', true)).toBe('p1');
    expect(decideRoute({ serve: true }, 'narrow', true, true)).toBe('engine');
    expect(decideRoute({ serve: false }, 'narrow', true, true)).toBe('narrow');
    expect(decideRoute({ serve: false }, 'p1', true, true)).toBe('p1');
  });
});

describe('model-level degraded reason', () => {
  const ready = { ready: true };
  it('is undefined unless the model is configured to serve', () => {
    expect(modelDegradedReason({ configured: 'shadow', effective: 'shadow', shed: true, running: false, readiness: null })).toBeUndefined();
    expect(modelDegradedReason({ configured: 'off', effective: 'off', shed: false, running: false })).toBeUndefined();
  });
  it('names the operator’s levers first, then the runtime’s readiness', () => {
    expect(modelDegradedReason({ configured: 'serve', effective: 'serve', shed: true, running: true, readiness: ready })).toBe('memory');
    expect(modelDegradedReason({ configured: 'serve', effective: 'shadow', shed: false, running: true, readiness: ready })).toBe('killswitch');
    expect(modelDegradedReason({ configured: 'serve', effective: 'serve', shed: false, running: false, readiness: ready })).toBe('not_running');
    expect(modelDegradedReason({ configured: 'serve', effective: 'serve', shed: false, running: true, readiness: { ready: false, reason: 'lag' } })).toBe('lag');
    expect(modelDegradedReason({ configured: 'serve', effective: 'serve', shed: false, running: true, readiness: { ready: false } })).toBe('not_ready');
    expect(modelDegradedReason({ configured: 'serve', effective: 'serve', shed: false, running: true, readiness: ready })).toBeUndefined();
  });
});

describe('DegradedTracker', () => {
  it('a deploy’s first load is not a transition; becoming not-ready after being ready is, once', () => {
    const c = clockedAlerts();
    const logs: string[] = [];
    const t = new DegradedTracker(c.alerts, (m) => logs.push(m), c.now(), 300_000, c.now);
    t.observe('rank', 'not_loaded');
    t.observe('rank', 'not_caught_up');
    t.observe('rank', 'shard_not_ready');
    expect(c.lines).toEqual([]);
    t.observe('rank', undefined);
    expect(logs).toEqual(['read models: rank ready to serve 0 s after boot']); // first readiness: not a recovery
    c.tick(70_000);
    t.observe('rank', 'lag');
    t.observe('rank', 'lag');
    expect(c.lines).toEqual(['[alert] read_models.degraded model=rank reason=lag']);
    c.tick(70_000);
    t.observe('rank', undefined);
    expect(logs).toHaveLength(2);
    expect(logs[1]).toMatch(/rank serving again \(was degraded: lag/);
    expect(t.snapshot(c.now()).rank).toMatchObject({ degraded: false, transitions: 1, everReady: true });
  });

  it('a model still loading past the ready timeout alerts once', () => {
    const c = clockedAlerts();
    const t = new DegradedTracker(c.alerts, () => undefined, c.now(), 300_000, c.now);
    t.observe('pools', 'not_loaded');
    c.tick(299_999);
    t.observe('pools', 'not_loaded');
    expect(c.lines).toEqual([]);
    c.tick(1);
    t.observe('pools', 'not_loaded');
    c.tick(120_000);
    t.observe('pools', 'not_loaded');
    expect(c.lines).toEqual(['[alert] read_models.degraded model=pools reason=not_loaded (not ready 300 s after boot)']);
  });

  it('the kill switch and the memory guard are degradations from the first observation', () => {
    const c = clockedAlerts();
    const t = new DegradedTracker(c.alerts, () => undefined, c.now(), 300_000, c.now);
    t.observe('rank', 'killswitch');
    t.observe('pools', 'memory');
    expect(c.lines).toEqual(['[alert] read_models.degraded model=rank reason=killswitch', '[alert] read_models.degraded model=pools reason=memory']);
  });

  it('throttles per MODEL: a rank transition does not swallow a pools one in the same minute', () => {
    const c = clockedAlerts();
    const t = new DegradedTracker(c.alerts, () => undefined, c.now(), 300_000, c.now);
    t.observe('rank', undefined);
    t.observe('pools', undefined);
    t.observe('rank', 'lag');
    t.observe('pools', 'lag');
    expect(c.lines).toHaveLength(2);
    // a flapping model within the minute is counted, not logged again
    t.observe('rank', undefined);
    t.observe('rank', 'lag');
    expect(c.lines).toHaveLength(2);
    expect(c.alerts.snapshot().counts['read_models.degraded']).toBe(3);
  });

  it('a new reason while degraded is a transition', () => {
    const c = clockedAlerts();
    const t = new DegradedTracker(c.alerts, () => undefined, c.now(), 300_000, c.now);
    t.observe('rank', undefined);
    t.observe('rank', 'lag');
    c.tick(61_000);
    t.observe('rank', 'shard_not_ready');
    expect(c.lines[1]).toBe('[alert] read_models.degraded model=rank reason=shard_not_ready (was lag)');
  });
});

describe('CircuitWatcher', () => {
  const beat = (replica: string, ready: FleetBeat['ready'], lastAppendAt: number): FleetBeat => ({ replica, role: 'both', holder: false, ready, lastAppendAt, at: lastAppendAt });

  it('alerts when a model’s circuit opens, once, and logs when it closes', () => {
    const c = clockedAlerts();
    const logs: string[] = [];
    const w = new CircuitWatcher(c.alerts, (m) => logs.push(m), c.now);
    const t = c.now();
    w.update([beat('a', { rank: true, pools: true }, t), beat('b', { rank: true, pools: true }, t)], ['rank', 'pools']);
    expect(w.isOpen('rank')).toBe(false);
    w.update([beat('a', { rank: false, pools: true }, t), beat('b', { rank: true, pools: true }, t)], ['rank', 'pools']);
    expect(w.isOpen('rank')).toBe(true);
    expect(w.isOpen('pools')).toBe(false);
    w.update([beat('a', { rank: false, pools: true }, t), beat('b', { rank: true, pools: true }, t)], ['rank', 'pools']);
    expect(c.lines).toEqual(['[alert] read_models.fleet_degraded model=rank circuit OPEN: 1/2 replicas not ready (1/2 replicas not ready)']);
    c.tick(20_000);
    w.update([beat('a', { rank: true, pools: true }, c.now()), beat('b', { rank: true, pools: true }, c.now())], ['rank', 'pools']);
    expect(w.isOpen('rank')).toBe(false);
    expect(logs).toEqual(['read models: rank fleet circuit closed after 20 s']);
    expect(w.snapshot(c.now()).opened).toEqual({ rank: 1 });
  });

  it('a silent holder (no append for > 60 s) opens every model’s circuit', () => {
    const c = clockedAlerts();
    const w = new CircuitWatcher(c.alerts, () => undefined, c.now);
    const t = c.now();
    w.update([beat('a', { rank: true, pools: true }, t)], ['rank', 'pools']); // serving first
    c.tick(61_000);
    w.update([beat('a', { rank: true, pools: true }, t)], ['rank', 'pools']);
    expect(w.isOpen('rank') && w.isOpen('pools')).toBe(true);
    expect(c.lines.join('\n')).toMatch(/no append for > 60 s/);
  });

  it('a boot is not an incident: the first open before the model ever served is logged, and alerts once only past the ready timeout', () => {
    const c = clockedAlerts();
    const logs: string[] = [];
    const w = new CircuitWatcher(c.alerts, (m) => logs.push(m), c.now, c.now(), 300_000);
    w.update([beat('a', { rank: false, pools: false }, c.now())], ['rank', 'pools']);
    expect(w.isOpen('rank') && w.isOpen('pools')).toBe(true);
    expect(c.lines).toEqual([]);
    expect(logs.join('\n')).toMatch(/rank fleet circuit open while loading/);
    c.tick(200_000);
    w.update([beat('a', { rank: false, pools: true }, c.now())], ['rank', 'pools']); // pools serves
    expect(c.lines).toEqual([]);
    c.tick(101_000); // past the ready timeout, rank still loading
    w.update([beat('a', { rank: false, pools: true }, c.now())], ['rank', 'pools']);
    w.update([beat('a', { rank: false, pools: true }, c.now())], ['rank', 'pools']);
    expect(c.lines).toHaveLength(1);
    expect(c.lines[0]).toMatch(/model=rank circuit still OPEN 301 s after boot/);
    w.update([beat('a', { rank: false, pools: false }, c.now())], ['rank', 'pools']); // pools served, now degraded: alert at once
    expect(c.lines).toHaveLength(2);
    expect(c.lines[1]).toMatch(/model=pools circuit OPEN/);
  });

  it('keeps the last circuit when redis-state cannot be read (fail-static)', () => {
    const c = clockedAlerts();
    const w = new CircuitWatcher(c.alerts, () => undefined, c.now);
    w.update([beat('a', { rank: false }, c.now())], ['rank']);
    w.failed();
    expect(w.isOpen('rank')).toBe(true);
    expect(w.snapshot(c.now()).readFailures).toBe(1);
  });
});
