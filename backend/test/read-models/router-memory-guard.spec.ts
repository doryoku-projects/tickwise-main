/*
 * The memory guard (design §4.11, P-R R4): staged shedding against the
 * container (80 / 85 caches, 90 rank, 95 pools), the off-heap cap, and the
 * 5-minute reload hysteresis.
 */
import { describe, expect, it } from 'vitest';
import { containerLimit, LATCH_AFTER, MemoryGuard, modelCapBytes, RELOAD_AFTER_MS, SHED_WINDOW_MS, stageFor } from '../../src/read-models/memory-guard.js';
import { AlertLog } from '../../src/read-models/status.js';

const MB = 1_048_576;
const GB = 1024 * MB;

function guard(limits: { containerBytes?: number; capBytes?: number }) {
  const lines: string[] = [];
  const logs: string[] = [];
  const stages: number[] = [];
  const g = new MemoryGuard(limits, new AlertLog({ warn: (l: string) => lines.push(l) }), (m) => logs.push(m), (s) => stages.push(s));
  return { g, lines, logs, stages };
}

describe('limits', () => {
  it('reads a real cgroup limit and ignores none / unconstrained / garbage', () => {
    expect(containerLimit(() => 3 * GB)).toBe(3 * GB);
    expect(containerLimit(() => 0)).toBeUndefined();
    expect(containerLimit(() => undefined)).toBeUndefined();
    expect(containerLimit(() => 2 ** 63)).toBeUndefined();
    expect(containerLimit(() => {
      throw new Error('x');
    })).toBeUndefined();
  });

  it('the cap is READ_MODELS_MAX_MB, else container − heap cap − 25%', () => {
    expect(modelCapBytes(512, 3 * GB, 1230 * MB)).toBe(512 * MB);
    expect(modelCapBytes(0, 3 * GB, 1230 * MB)).toBe(3 * GB - 1230 * MB - 0.75 * GB);
    expect(modelCapBytes(0, undefined, 1230 * MB)).toBeUndefined();
    expect(modelCapBytes(0, GB, 900 * MB)).toBeUndefined(); // nothing left
  });

  it('stages by share of the container', () => {
    expect(stageFor(GB, undefined)).toBe(0);
    expect(stageFor(0.79 * 10 * GB, 10 * GB)).toBe(0);
    expect(stageFor(0.8 * 10 * GB, 10 * GB)).toBe(80);
    expect(stageFor(0.86 * 10 * GB, 10 * GB)).toBe(85);
    expect(stageFor(0.9 * 10 * GB, 10 * GB)).toBe(90);
    expect(stageFor(0.99 * 10 * GB, 10 * GB)).toBe(95);
  });
});

describe('MemoryGuard', () => {
  const C = 10 * GB;

  it('is inactive without a container limit or a cap', () => {
    const { g } = guard({});
    expect(g.active).toBe(false);
    expect(g.check({ rss: 100 * GB, arrayBuffers: 100 * GB }, 0).shed.size).toBe(0);
  });

  it('80% and 85% drop caches (every check while there), and alert once per stage reached', () => {
    const { g, lines, stages } = guard({ containerBytes: C });
    g.check({ rss: 0.81 * C, arrayBuffers: 0 }, 0);
    g.check({ rss: 0.82 * C, arrayBuffers: 0 }, 5_000);
    expect(stages).toEqual([80, 80]);
    g.check({ rss: 0.86 * C, arrayBuffers: 0 }, 10_000);
    expect(stages).toEqual([80, 80, 85]);
    expect(lines.filter((l) => l.includes('stage'))).toHaveLength(2);
    expect(g.isShed('rank') || g.isShed('pools')).toBe(false);
  });

  it('a jump to 92% alerts every stage it passed and unloads rank only; 95% unloads pools too', () => {
    const { g, lines, stages } = guard({ containerBytes: C });
    const d = g.check({ rss: 0.92 * C, arrayBuffers: 0 }, 0);
    expect(stages).toEqual([80, 85]);
    expect(lines.filter((l) => /stage (80|85|90)%/.test(l))).toHaveLength(3);
    expect([...d.shed]).toEqual(['rank']);
    expect(g.check({ rss: 0.96 * C, arrayBuffers: 0 }, 5_000).shed).toEqual(new Set(['rank', 'pools']));
  });

  it('a shed model reloads only after 5 minutes under 70% — and the clock restarts on any excursion', () => {
    const { g, logs } = guard({ containerBytes: C });
    g.check({ rss: 0.91 * C, arrayBuffers: 0 }, 0);
    g.check({ rss: 0.6 * C, arrayBuffers: 0 }, 10_000);
    g.check({ rss: 0.6 * C, arrayBuffers: 0 }, 10_000 + RELOAD_AFTER_MS - 1);
    expect(g.isShed('rank')).toBe(true);
    // an excursion over 70% (but under 80%) restarts the hysteresis
    g.check({ rss: 0.75 * C, arrayBuffers: 0 }, 10_000 + RELOAD_AFTER_MS);
    g.check({ rss: 0.6 * C, arrayBuffers: 0 }, 20_000 + RELOAD_AFTER_MS);
    expect(g.isShed('rank')).toBe(true);
    g.check({ rss: 0.6 * C, arrayBuffers: 0 }, 20_000 + 2 * RELOAD_AFTER_MS);
    expect(g.isShed('rank')).toBe(false);
    expect(logs[0]).toMatch(/reloading rank/);
  });

  it('a model that keeps not fitting backs off (5, 10, 20 min) and is LATCHED at its 4th shed in 6 h', () => {
    const { g, lines } = guard({ containerBytes: C });
    let t = 0;
    const cycle = () => {
      g.check({ rss: 0.91 * C, arrayBuffers: 0 }, t); // shed
      t += 1_000;
      g.check({ rss: 0.6 * C, arrayBuffers: 0 }, t); // under 70%: the clock starts
      const wait = g.reloadAfterMs(t);
      g.check({ rss: 0.6 * C, arrayBuffers: 0 }, t + wait - 1);
      expect(g.isShed('rank')).toBe(true);
      g.check({ rss: 0.6 * C, arrayBuffers: 0 }, t + wait);
      t += wait + 1_000;
      return wait;
    };
    expect(cycle()).toBe(RELOAD_AFTER_MS);
    expect(g.isShed('rank')).toBe(false);
    expect(cycle()).toBe(2 * RELOAD_AFTER_MS);
    expect(cycle()).toBe(4 * RELOAD_AFTER_MS);
    expect(LATCH_AFTER).toBe(4);
    // The 4th shed in the window latches: memory back under 70% for an hour brings nothing back.
    g.check({ rss: 0.91 * C, arrayBuffers: 0 }, t);
    for (let m = 1; m <= 60; m++) g.check({ rss: 0.1 * C, arrayBuffers: 0 }, t + m * 60_000);
    expect(g.isShed('rank')).toBe(true);
    expect(g.status(t)).toMatchObject({ latched: ['rank'], reloadAfterMs: null });
    expect(lines.some((l) => /LATCHED/.test(l))).toBe(true);
  });

  it('sheds older than the 6 h window no longer count towards the backoff', () => {
    const { g } = guard({ containerBytes: C });
    g.check({ rss: 0.91 * C, arrayBuffers: 0 }, 0);
    g.check({ rss: 0.6 * C, arrayBuffers: 0 }, 1_000);
    g.check({ rss: 0.6 * C, arrayBuffers: 0 }, 1_000 + RELOAD_AFTER_MS);
    expect(g.isShed('rank')).toBe(false);
    const later = SHED_WINDOW_MS + 10_000;
    g.check({ rss: 0.91 * C, arrayBuffers: 0 }, later);
    expect(g.reloadAfterMs(later)).toBe(RELOAD_AFTER_MS);
  });

  it('over the off-heap cap unloads rank first, then pools', () => {
    const { g } = guard({ capBytes: GB });
    expect([...g.check({ rss: 0, arrayBuffers: 1.2 * GB }, 0).shed]).toEqual(['rank']);
    expect(g.check({ rss: 0, arrayBuffers: 1.1 * GB }, 5_000).shed).toEqual(new Set(['rank', 'pools']));
    expect(g.status(5_000)).toMatchObject({ active: true, capMb: 1024, overCap: true, shed: ['rank', 'pools'] });
  });
});
