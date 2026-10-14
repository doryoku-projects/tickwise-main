/*
 * The backfill flags (every default = today) and the `[backfill-profile]`
 * line / status snapshot (design §6.2-7).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BACKFILL_DEFAULTS,
  BACKFILL_SLOW_WINDOW_MS,
  BackfillProfile,
  backfillProfiles,
  readBackfillSettings,
  resetBackfillProfiles,
} from '../../src/sync/backfill-profile.js';

describe('readBackfillSettings', () => {
  it('no getters at all = today', () => {
    expect(readBackfillSettings({})).toEqual(BACKFILL_DEFAULTS);
    expect(readBackfillSettings(undefined)).toEqual(BACKFILL_DEFAULTS);
    expect(BACKFILL_DEFAULTS).toEqual({ paging: 'offset', pipeline: false, lookaheadPages: 0, priceWaitMs: 5_000, feeRead: false });
  });

  it('reads the flags and clamps the numbers', () => {
    expect(
      readBackfillSettings({
        backfillPaging: 'tokenid',
        backfillPipeline: 'on',
        backfillLookaheadPages: 40,
        backfillPriceWaitMs: -5,
        backfillFeeRead: true,
      }),
    ).toEqual({ paging: 'tokenid', pipeline: true, lookaheadPages: 8, priceWaitMs: 0, feeRead: true });
  });

  it('anything outside a flag’s domain reads as the default', () => {
    expect(
      readBackfillSettings({ backfillPaging: 'TOKENID', backfillPipeline: 'yes', backfillLookaheadPages: 'x', backfillFeeRead: 1 }),
    ).toEqual(BACKFILL_DEFAULTS);
  });
});

describe('BackfillProfile', () => {
  beforeEach(() => resetBackfillProfiles());

  function stats(rows: number, extra: Partial<Record<string, unknown>> = {}) {
    return {
      pageMs: 100,
      dynMs: 20,
      tokensMs: 10,
      priceMs: 50,
      priceWaitMs: 40,
      priceDeadlineHit: false,
      feeReadMs: 5,
      normalizeMs: 30,
      rows,
      overflowPages: 0,
      unpricedClosed: new Map<string, number>(),
      feesMeasured: 0,
      ...extra,
    } as never;
  }

  it('one line per `every` ranges with the WINDOW’s counters, external counters as deltas', () => {
    const lines: string[] = [];
    let now = 0;
    const ext = { providerCalls: { geckoterminal: 3 }, ledgerSkips: 5, lastKnownReads: 1, cacheOnlyMisses: 0, gtWaitMs: 0 };
    const profile = new BackfillProfile(
      4663,
      'uniswap-v4',
      'tokenid',
      { log: (m: string) => lines.push(m), warn: () => undefined } as never,
      () => ({ ...ext, providerCalls: { ...ext.providerCalls } }),
      () => now,
      2,
    );
    now = 1_000;
    profile.addRange(stats(999), { written: 999, flushMs: 200, cursor: '999' });
    expect(lines).toHaveLength(0);
    ext.providerCalls.geckoterminal = 7;
    ext.ledgerSkips = 9;
    ext.gtWaitMs = 1_500;
    now = 2_000;
    profile.addRange(stats(500, { priceDeadlineHit: true, unpricedClosed: new Map([['0xabc', 4]]) }), {
      written: 500,
      flushMs: 100,
      cursor: '1998',
    });
    expect(lines).toHaveLength(1);
    const line = lines[0]!;
    expect(line).toContain('[backfill-profile] chain=4663');
    expect(line).toContain('ranges=2 rows=1499');
    expect(line).toContain('cursor=1998');
    expect(line).toContain('priceCalls{geckoterminal:4}');
    expect(line).toContain('ledgerSkips=4');
    expect(line).toContain('gtWaitMs=1500');
    expect(line).toContain('priceDeadlineHits=1');
    expect(line).toContain('unpricedClosed=4');
    expect(line).toContain('pos/s=749.5');
    const [snap] = backfillProfiles();
    expect(snap).toMatchObject({ chainId: 4663, ranges: 2, written: 1499, unpricedClosedInserts: 4, cursor: '1998' });
    expect(snap?.unpricedClosedTop).toEqual([{ address: '0xabc', count: 4 }]);
  });

  it('done flushes the partial window and the snapshot says so', () => {
    const lines: string[] = [];
    const profile = new BackfillProfile(
      1,
      'uniswap-v4',
      'tokenid',
      { log: (m: string) => lines.push(m), warn: () => undefined } as never,
      () => ({ providerCalls: {}, ledgerSkips: 0, lastKnownReads: 0, cacheOnlyMisses: 0, gtWaitMs: 0 }),
      () => 0,
      10,
    );
    profile.addRange(stats(10), { written: 10, flushMs: 1 });
    profile.addTail(3);
    profile.setPhase('done');
    expect(lines).toHaveLength(1);
    expect(backfillProfiles()[0]).toMatchObject({ phase: 'done', tailRows: 3, written: 10 });
  });
});

describe('[alert] backfill.slow (< 30 pos/s for 15 min while budget wait < 50 %)', () => {
  beforeEach(() => resetBackfillProfiles());

  const MIN = 60_000;
  function stats(rows: number) {
    return {
      pageMs: 1, dynMs: 1, tokensMs: 1, priceMs: 1, priceWaitMs: 0, priceDeadlineHit: false, feeReadMs: 0,
      normalizeMs: 1, rows, overflowPages: 0, unpricedClosed: new Map<string, number>(), feesMeasured: 0,
    } as never;
  }
  function harness() {
    const warns: string[] = [];
    const lines: string[] = [];
    let now = 0;
    const ext = { providerCalls: {}, ledgerSkips: 0, lastKnownReads: 0, cacheOnlyMisses: 0, gtWaitMs: 0, budgetWaitMs: 0 };
    const profile = new BackfillProfile(
      4663,
      'uniswap-v4',
      'tokenid',
      { log: (m: string) => lines.push(m), warn: (m: string) => warns.push(m) } as never,
      () => ({ ...ext }),
      () => now,
      1_000, // no window lines in the way
    );
    return {
      profile,
      ext,
      lines,
      slowLines: () => warns.filter((w) => w.includes('[alert] backfill.slow')),
      at: (ms: number) => {
        now = ms;
      },
      range: (ms: number, written: number) => {
        now = ms;
        profile.addRange(stats(written), { written, flushMs: 1 });
      },
    };
  }

  it('no verdict before a full window was observed, even at 0 pos/s', () => {
    const h = harness();
    h.at(BACKFILL_SLOW_WINDOW_MS - 1);
    expect(h.profile.checkSlow()).toEqual({ slow: false });
    expect(h.slowLines()).toEqual([]);
  });

  it('a stalled walk (no range at all for 15 min) alerts, with evidence', () => {
    const h = harness();
    h.at(BACKFILL_SLOW_WINDOW_MS);
    const v = h.profile.checkSlow();
    expect(v).toMatchObject({ slow: true, posPerSec: 0, budgetWaitShare: 0, windowMs: BACKFILL_SLOW_WINDOW_MS });
    expect(h.slowLines()).toHaveLength(1);
    expect(h.slowLines()[0]).toContain('chain=4663 protocol=uniswap-v4 paging=tokenid posPerSec=0.0 windowMin=15.0 budgetWaitShare=0%');
  });

  it('exactly 30 pos/s is not slow; just under is', () => {
    const fast = harness();
    fast.range(BACKFILL_SLOW_WINDOW_MS, 30 * (BACKFILL_SLOW_WINDOW_MS / 1000));
    expect(fast.slowLines()).toEqual([]);
    const slow = harness();
    slow.range(BACKFILL_SLOW_WINDOW_MS, 30 * (BACKFILL_SLOW_WINDOW_MS / 1000) - 1);
    expect(slow.slowLines()).toHaveLength(1);
  });

  it('budget-bound (≥ 50 % of the window waiting in the write budget) is not "slow": the budget is doing its job', () => {
    const h = harness();
    h.ext.budgetWaitMs = BACKFILL_SLOW_WINDOW_MS / 2;
    h.range(BACKFILL_SLOW_WINDOW_MS, 10);
    expect(h.slowLines()).toEqual([]);
    const h2 = harness();
    h2.ext.budgetWaitMs = BACKFILL_SLOW_WINDOW_MS / 2 - 1;
    h2.range(BACKFILL_SLOW_WINDOW_MS, 10);
    expect(h2.slowLines()).toHaveLength(1);
  });

  it('the window SLIDES: a long slow start followed by a fast last 15 min is not slow (the run average would be)', () => {
    const h = harness();
    h.range(60 * MIN, 1_000); // an hour at ~0.3 pos/s…
    expect(h.slowLines()).toHaveLength(1);
    // …then 15 fast minutes at 100 pos/s: the run average is ~20 pos/s, the window's 100.
    for (let m = 61; m <= 75; m++) h.range(m * MIN, 100 * 60);
    const v = h.profile.checkSlow();
    expect(v.slow).toBe(false);
    expect(v.posPerSec).toBeCloseTo(100, 0);
    expect(v.windowMs).toBe(BACKFILL_SLOW_WINDOW_MS);
  });

  it('…and a fast start followed by a stalled last 15 min IS slow (the run average would hide it)', () => {
    const h = harness();
    for (let m = 1; m <= 30; m++) h.range(m * MIN, 100 * 60); // 30 min at 100 pos/s
    expect(h.slowLines()).toEqual([]);
    h.at(45 * MIN); // then nothing for 15 min
    const v = h.profile.checkSlow();
    expect(v).toMatchObject({ slow: true, posPerSec: 0 });
    expect(h.slowLines()).toHaveLength(1);
  });

  it('at most one line a minute; again after', () => {
    const h = harness();
    h.at(BACKFILL_SLOW_WINDOW_MS);
    h.profile.checkSlow();
    h.at(BACKFILL_SLOW_WINDOW_MS + MIN - 1);
    h.profile.checkSlow();
    expect(h.slowLines()).toHaveLength(1);
    h.at(BACKFILL_SLOW_WINDOW_MS + MIN);
    h.profile.checkSlow();
    expect(h.slowLines()).toHaveLength(2);
  });

  it('only during the walk: the tail and a finished run never alert', () => {
    const h = harness();
    h.profile.setPhase('tail');
    h.at(BACKFILL_SLOW_WINDOW_MS * 2);
    expect(h.profile.checkSlow().slow).toBe(false);
    expect(h.slowLines()).toEqual([]);
  });

  it('the profile line and snapshot report the write budget\'s backfill-lane wait (external delta)', () => {
    const h = harness();
    h.ext.budgetWaitMs = 4_000;
    h.range(MIN, 999);
    h.profile.flushLine();
    expect(h.lines.at(-1)).toContain('budgetWaitMs=4000');
    expect(backfillProfiles()[0]!.budgetWaitMs).toBe(4_000);
  });
});
