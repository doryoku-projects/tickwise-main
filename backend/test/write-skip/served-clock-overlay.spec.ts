import { describe, expect, it } from 'vitest';
import {
  applyServedClockOverlay,
  applyServedClockOverlayAll,
  servedAgeSeconds,
} from '../../src/positions/served-clock-overlay.js';

const NOW = Date.parse('2026-10-04T12:00:00Z');
const NOW_SEC = Math.floor(NOW / 1000);
const CLEAN = new Date('2026-10-04T11:30:00Z');

function row(over: Record<string, unknown> = {}) {
  return {
    positionId: '7',
    isActive: true,
    createdAtTimestamp: NOW_SEC - 86_400,
    closedAtTimestamp: null,
    staleMisses: 0,
    lastSyncedAt: new Date('2026-10-04T08:00:00Z'),
    metrics: { ageSeconds: 1, apr: 3 },
    pricing: { source: 'orchestrated', usedFallback: false, pricedAt: new Date('2026-10-04T08:00:00Z') },
    ...over,
  };
}

describe('servedAgeSeconds = the adapter\'s age rule', () => {
  it('open: now − createdAt; closed: closedAt − createdAt; never negative; a closedAt not after createdAt reads as open', () => {
    expect(servedAgeSeconds(NOW_SEC - 100, null, NOW)).toBe(100);
    expect(servedAgeSeconds(NOW_SEC - 100, NOW_SEC - 40, NOW)).toBe(60);
    expect(servedAgeSeconds(NOW_SEC + 50, null, NOW)).toBe(0);
    expect(servedAgeSeconds(NOW_SEC - 100, NOW_SEC - 200, NOW)).toBe(100);
    expect(servedAgeSeconds(NOW_SEC - 100, 0, NOW)).toBe(100);
    expect(servedAgeSeconds(undefined, null, NOW)).toBeUndefined();
  });
});

describe('applyServedClockOverlay', () => {
  it('skip on: age exact at read time; lastSyncedAt / pricedAt lifted to the clean refresh for an active, unmissed row; staleMisses stripped', () => {
    const input = row();
    const out = applyServedClockOverlay(input, { mode: 'on', nowMs: NOW, lastCleanRefreshAt: CLEAN });
    expect(out.metrics.ageSeconds).toBe(86_400);
    expect(out.metrics.apr).toBe(3);
    expect(out.lastSyncedAt).toEqual(CLEAN);
    expect(out.pricing.pricedAt).toEqual(CLEAN);
    expect(out.pricing.source).toBe('orchestrated');
    expect(out).not.toHaveProperty('staleMisses');
    // The cached row is never mutated.
    expect(input.metrics.ageSeconds).toBe(1);
    expect(input.lastSyncedAt).toEqual(new Date('2026-10-04T08:00:00Z'));
    expect(input).toHaveProperty('staleMisses', 0);
  });

  it('never moves a time backwards', () => {
    const later = new Date('2026-10-04T11:45:00Z');
    const out = applyServedClockOverlay(row({ lastSyncedAt: later, pricing: { pricedAt: later } }), { mode: 'on', nowMs: NOW, lastCleanRefreshAt: CLEAN });
    expect(out.lastSyncedAt).toBe(later);
    expect(out.pricing.pricedAt).toBe(later);
  });

  it('no time overlay for a row the refresh missed, a closed row, or an unknown clean refresh', () => {
    for (const [over, clean] of [
      [{ staleMisses: 1 }, CLEAN],
      [{ isActive: false, closedAtTimestamp: NOW_SEC - 10 }, CLEAN],
      [{}, undefined],
      [{}, null],
    ] as const) {
      const out = applyServedClockOverlay(row(over), { mode: 'on', nowMs: NOW, lastCleanRefreshAt: clean });
      expect(out.lastSyncedAt).toEqual(new Date('2026-10-04T08:00:00Z'));
      expect(out.pricing.pricedAt).toEqual(new Date('2026-10-04T08:00:00Z'));
    }
  });

  it('a missing stored time is not invented; ISO strings (rows reloaded from a Redis snapshot) stay strings', () => {
    const out = applyServedClockOverlay(
      row({ lastSyncedAt: '2026-10-04T08:00:00.000Z', pricing: { source: 'x' } }),
      { mode: 'on', nowMs: NOW, lastCleanRefreshAt: CLEAN },
    );
    expect(out.lastSyncedAt).toBe(CLEAN.toISOString());
    expect(out.pricing).toEqual({ source: 'x' });
  });

  it('closed rows: the overlaid age equals the stored one (created → closed)', () => {
    const closedAt = NOW_SEC - 3600;
    const created = closedAt - 5000;
    const out = applyServedClockOverlay(
      row({ isActive: false, createdAtTimestamp: created, closedAtTimestamp: closedAt, metrics: { ageSeconds: 5000 } }),
      { mode: 'on', nowMs: NOW, lastCleanRefreshAt: CLEAN },
    );
    expect(out.metrics.ageSeconds).toBe(5000);
  });

  it('skip off / shadow: rows as stored (only staleMisses stripped); the same object when there is nothing to strip', () => {
    for (const mode of ['off', 'shadow']) {
      const input = row();
      const out = applyServedClockOverlay(input, { mode, nowMs: NOW, lastCleanRefreshAt: CLEAN });
      expect(out).not.toHaveProperty('staleMisses');
      expect(out.metrics).toBe(input.metrics);
      expect(out.lastSyncedAt).toBe(input.lastSyncedAt);
      const { staleMisses: _drop, ...plain } = input;
      expect(applyServedClockOverlay(plain, { mode, nowMs: NOW })).toBe(plain);
    }
  });

  it('on, nothing to change: the same object', () => {
    const { staleMisses: _drop, ...input } = row({ metrics: { ageSeconds: 86_400 }, lastSyncedAt: CLEAN, pricing: { pricedAt: CLEAN } });
    expect(applyServedClockOverlay(input, { mode: 'on', nowMs: NOW, lastCleanRefreshAt: CLEAN })).toBe(input);
  });

  it('applyServedClockOverlayAll returns the same array when no row changed', () => {
    const rows = [{ positionId: '1' }, { positionId: '2' }];
    expect(applyServedClockOverlayAll(rows, { mode: 'off', nowMs: NOW })).toBe(rows);
    const changed = applyServedClockOverlayAll([row()], { mode: 'on', nowMs: NOW, lastCleanRefreshAt: CLEAN });
    expect(changed[0]!.metrics.ageSeconds).toBe(86_400);
  });
});
