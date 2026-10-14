/*
 * Backfill throughput (design §6, P2.5): the flags, and the profile line that
 * says which bound a walk is actually running into.
 *
 * Every flag defaults to TODAY: `offset` paging, no pipeline, no lookahead, no
 * in-walk fee read. The values come from `AppConfigService` getters
 * (`backfillPaging`, `backfillPipeline`, `backfillLookaheadPages`,
 * `backfillPriceWaitMs`, `backfillFeeRead`); a getter that is absent, or a value
 * outside its domain, reads as the default — so a config without them is
 * exactly today's backfill.
 */

import type { Logger } from '@nestjs/common';
import type { TokenIdRangeStats } from '../subgraph/position-adapter.js';

export type BackfillPaging = 'offset' | 'tokenid';

export interface BackfillSettings {
  /** `BACKFILL_PAGING`: `offset` (today) | `tokenid` (range walk + tail). */
  paging: BackfillPaging;
  /** `BACKFILL_PIPELINE=on`: run token cache, one pool request per range, price deadline. */
  pipeline: boolean;
  /** `BACKFILL_LOOKAHEAD_PAGES` 0–8: ranges prepared ahead of the one being written. */
  lookaheadPages: number;
  /** `BACKFILL_PRICE_WAIT_MS`: the longest a range waits for its prices (pipeline on). */
  priceWaitMs: number;
  /** `BACKFILL_FEE_READ=on`: P3.1, the first fee reading inside the walk. */
  feeRead: boolean;
  /**
   * Set by `SyncService` when `BACKFILL_FEE_READ=on` but the adapter has no
   * page fee reader bound (`PAGE_FEE_READER`): `feeRead` is then forced off for
   * the run (every row reaches the fee job's backfill lane, as without the
   * flag) and the run's lines say `feeRead=unbound` instead of `true`.
   */
  feeReadUnbound?: boolean;
}

/** `feeRead` as the run's log lines print it: `true`, `false`, or `unbound`. */
export function feeReadLabel(settings: Pick<BackfillSettings, 'feeRead' | 'feeReadUnbound'>): string {
  return settings.feeReadUnbound ? 'unbound' : String(settings.feeRead);
}

export const BACKFILL_DEFAULTS: Readonly<BackfillSettings> = Object.freeze({
  paging: 'offset',
  pipeline: false,
  lookaheadPages: 0,
  priceWaitMs: 5_000,
  feeRead: false,
});

export const MAX_LOOKAHEAD_PAGES = 8;
export const MAX_PRICE_WAIT_MS = 60_000;

function onOff(value: unknown): boolean | undefined {
  if (value === true || value === 'on' || value === 'true') return true;
  if (value === false || value === 'off' || value === 'false') return false;
  return undefined;
}

function intIn(value: unknown, min: number, max: number): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/** The backfill flags from config, defaults (= today) for anything absent or invalid. */
export function readBackfillSettings(config: unknown): BackfillSettings {
  const c = (config ?? {}) as Record<string, unknown>;
  const paging = c.backfillPaging === 'tokenid' ? 'tokenid' : 'offset';
  return {
    paging,
    pipeline: onOff(c.backfillPipeline) ?? BACKFILL_DEFAULTS.pipeline,
    lookaheadPages: intIn(c.backfillLookaheadPages, 0, MAX_LOOKAHEAD_PAGES) ?? BACKFILL_DEFAULTS.lookaheadPages,
    priceWaitMs: intIn(c.backfillPriceWaitMs, 0, MAX_PRICE_WAIT_MS) ?? BACKFILL_DEFAULTS.priceWaitMs,
    feeRead: onOff(c.backfillFeeRead) ?? BACKFILL_DEFAULTS.feeRead,
  };
}

// ─── the profile ─────────────────────────────────────────────────────────────

/** Process-wide counters the profile reads as deltas (pricing, GeckoTerminal budget, write budget). */
export interface ProfileExternalCounters {
  providerCalls: Record<string, number>;
  ledgerSkips: number;
  lastKnownReads: number;
  cacheOnlyMisses: number;
  gtWaitMs: number;
  /**
   * The write budget's `backfill`-lane wait granted in this process (ms,
   * monotonic; `WriteBudgetService.laneWaitTotalMs`). Absent = 0 (budget off,
   * or a caller without it). Process-wide: two chains backfilling in one
   * process share it, which can only OVER-state a walk's budget share — the
   * slow alert then stays quiet, never fires falsely.
   */
  budgetWaitMs?: number;
}

/** `[alert] backfill.slow` (design §6.4, §13): below this many written positions per second… */
export const BACKFILL_SLOW_POS_PER_SEC = 30;
/** …sustained over this window… */
export const BACKFILL_SLOW_WINDOW_MS = 15 * 60_000;
/** …while the write budget held the walk for less than this share of it. */
export const BACKFILL_SLOW_BUDGET_SHARE = 0.5;
/** At most one line per run per minute. */
export const BACKFILL_SLOW_ALERT_EVERY_MS = 60_000;
/** SyncService checks a running walk this often even when no range lands (a stalled walk is slow too). */
export const BACKFILL_SLOW_CHECK_MS = 60_000;

export interface BackfillSlowVerdict {
  slow: boolean;
  /** Present once the walk has been observed for a full window. */
  posPerSec?: number;
  budgetWaitShare?: number;
  windowMs?: number;
}

export interface BackfillProfileSnapshot {
  chainId: number;
  protocol: string;
  paging: BackfillPaging;
  phase: 'walk' | 'tail' | 'done' | 'aborted';
  startedAt: string;
  updatedAt: string;
  ranges: number;
  rows: number;
  written: number;
  posPerSec: number;
  /** Sums over every range (stage wall times overlap with lookahead). */
  pageMs: number;
  dynMs: number;
  tokensMs: number;
  priceMs: number;
  priceWaitMs: number;
  priceDeadlineHits: number;
  feeReadMs: number;
  feesMeasured: number;
  normalizeMs: number;
  flushMs: number;
  budgetWaitMs: number;
  overflowPages: number;
  unpricedClosedInserts: number;
  /** The tokens behind most unpriced-closed inserts (address → count, top 5). */
  unpricedClosedTop: Array<{ address: string; count: number }>;
  priceCalls: Record<string, number>;
  ledgerSkips: number;
  lastKnownReads: number;
  cacheOnlyMisses: number;
  gtWaitMs: number;
  tailRows: number;
  cursor: string;
}

/** The latest snapshot per `chainId:protocol` in this process, for `/admin/sync/status` → `backfill`. */
const latest = new Map<string, BackfillProfileSnapshot>();

export function backfillProfiles(): BackfillProfileSnapshot[] {
  return [...latest.values()].map((s) => ({ ...s, priceCalls: { ...s.priceCalls }, unpricedClosedTop: [...s.unpricedClosedTop] }));
}

/** Specs only. */
export function resetBackfillProfiles(): void {
  latest.clear();
}

const UNPRICED_TRACK_CAP = 10_000;

/**
 * One run's profile. `addRange` after every written range; a
 * `[backfill-profile]` line every `every` ranges (and at the end) covering the
 * WINDOW since the previous line, so the numbers say what is binding now, not
 * averaged over hours.
 */
export class BackfillProfile {
  private readonly startedAtMs: number;
  private windowStartMs: number;
  private windowRanges = 0;
  private readonly total = emptyTotals();
  private window = emptyTotals();
  private externalAtWindowStart: ProfileExternalCounters;
  private readonly unpriced = new Map<string, number>();
  private phase: BackfillProfileSnapshot['phase'] = 'walk';
  private cursor = '';
  private tailRows = 0;
  private readonly budgetWaitAtStart: number;
  /** (time, written so far, budget wait so far) samples for the slow check; the oldest is the window's base. */
  private slowSamples: Array<{ at: number; written: number; budgetWaitMs: number }> = [];
  private slowAlertedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly chainId: number,
    private readonly protocol: string,
    private readonly paging: BackfillPaging,
    private readonly logger: Pick<Logger, 'log' | 'warn'>,
    private readonly external: () => ProfileExternalCounters,
    private readonly now: () => number = () => Date.now(),
    private readonly every = 10,
  ) {
    this.startedAtMs = this.now();
    this.windowStartMs = this.startedAtMs;
    this.externalAtWindowStart = this.external();
    this.budgetWaitAtStart = this.externalAtWindowStart.budgetWaitMs ?? 0;
    this.slowSamples.push({ at: this.startedAtMs, written: 0, budgetWaitMs: this.budgetWaitAtStart });
    this.publish();
  }

  /**
   * `[alert] backfill.slow`: the walk wrote fewer than
   * `BACKFILL_SLOW_POS_PER_SEC` positions/s over the trailing
   * `BACKFILL_SLOW_WINDOW_MS` while the write budget held it for less than
   * `BACKFILL_SLOW_BUDGET_SHARE` of that time — i.e. something other than the
   * budget binds (read the `[backfill-profile]` lines for which stage). Only
   * during the walk phase and only once a full window was observed. Called on
   * every range and once a minute by SyncService (a stalled walk lands no
   * range). At most one line per `BACKFILL_SLOW_ALERT_EVERY_MS`.
   */
  checkSlow(): BackfillSlowVerdict {
    const nowMs = this.now();
    const budgetWaitMs = this.external().budgetWaitMs ?? 0;
    this.slowSamples.push({ at: nowMs, written: this.total.written, budgetWaitMs });
    const cutoff = nowMs - BACKFILL_SLOW_WINDOW_MS;
    // Keep exactly one sample at or before the cutoff: the window's base.
    while (this.slowSamples.length > 1 && this.slowSamples[1]!.at <= cutoff) this.slowSamples.shift();
    const base = this.slowSamples[0]!;
    if (this.phase !== 'walk' || base.at > cutoff) return { slow: false };
    const windowMs = nowMs - base.at;
    const posPerSec = (this.total.written - base.written) / (windowMs / 1000);
    const budgetWaitShare = (budgetWaitMs - base.budgetWaitMs) / windowMs;
    const slow = posPerSec < BACKFILL_SLOW_POS_PER_SEC && budgetWaitShare < BACKFILL_SLOW_BUDGET_SHARE;
    if (slow && nowMs - this.slowAlertedAt >= BACKFILL_SLOW_ALERT_EVERY_MS) {
      this.slowAlertedAt = nowMs;
      this.logger.warn(
        `[alert] backfill.slow chain=${this.chainId} protocol=${this.protocol} paging=${this.paging} ` +
          `posPerSec=${posPerSec.toFixed(1)} windowMin=${(windowMs / 60_000).toFixed(1)} ` +
          `budgetWaitShare=${(budgetWaitShare * 100).toFixed(0)}% cursor=${this.cursor || '-'} — below ` +
          `${BACKFILL_SLOW_POS_PER_SEC} pos/s for ${BACKFILL_SLOW_WINDOW_MS / 60_000} min and the write budget is not what ` +
          `holds it back (see [backfill-profile] for the binding stage)`,
      );
    }
    return { slow, posPerSec, budgetWaitShare, windowMs };
  }

  addRange(stats: TokenIdRangeStats, extra: { written: number; flushMs: number; budgetWaitMs?: number; cursor?: string }): void {
    for (const t of [this.total, this.window]) {
      t.ranges += 1;
      t.rows += stats.rows;
      t.written += extra.written;
      t.pageMs += stats.pageMs;
      t.dynMs += stats.dynMs;
      t.tokensMs += stats.tokensMs;
      t.priceMs += stats.priceMs;
      t.priceWaitMs += stats.priceWaitMs;
      t.priceDeadlineHits += stats.priceDeadlineHit ? 1 : 0;
      t.feeReadMs += stats.feeReadMs;
      t.feesMeasured += stats.feesMeasured;
      t.normalizeMs += stats.normalizeMs;
      t.flushMs += extra.flushMs;
      t.budgetWaitMs += extra.budgetWaitMs ?? 0;
      t.overflowPages += stats.overflowPages;
      for (const n of stats.unpricedClosed.values()) t.unpricedClosed += n;
    }
    for (const [address, n] of stats.unpricedClosed) {
      const prev = this.unpriced.get(address);
      if (prev !== undefined) this.unpriced.set(address, prev + n);
      else if (this.unpriced.size < UNPRICED_TRACK_CAP) this.unpriced.set(address, n);
    }
    if (extra.cursor !== undefined) this.cursor = extra.cursor;
    this.windowRanges += 1;
    if (this.windowRanges >= this.every) this.flushLine();
    else this.publish();
    this.checkSlow();
  }

  /** Rows the completeness tail wrote (createdAt mode from run start − 1 h). */
  addTail(rows: number): void {
    this.tailRows += rows;
    this.publish();
  }

  setPhase(phase: BackfillProfileSnapshot['phase']): void {
    this.phase = phase;
    if (phase === 'done' || phase === 'aborted') {
      if (this.windowRanges > 0) this.flushLine();
      else this.publish();
    } else {
      this.publish();
    }
  }

  /** The `[backfill-profile]` line for the current window, then a new window. */
  flushLine(): void {
    const ext = this.external();
    const nowMs = this.now();
    const secs = Math.max(0.001, (nowMs - this.windowStartMs) / 1000);
    const w = this.window;
    const calls = diffRecord(ext.providerCalls, this.externalAtWindowStart.providerCalls);
    const callText = Object.entries(calls)
      .filter(([, n]) => n > 0)
      .map(([p, n]) => `${p}:${n}`)
      .join(',');
    this.logger.log(
      `[backfill-profile] chain=${this.chainId} protocol=${this.protocol} paging=${this.paging} ranges=${w.ranges} rows=${w.rows} ` +
        `written=${w.written} cursor=${this.cursor || '-'} pageMs=${avg(w.pageMs, w.ranges)} dynMs=${avg(w.dynMs, w.ranges)} ` +
        `tokensMs=${avg(w.tokensMs, w.ranges)} priceMs=${avg(w.priceMs, w.ranges)} priceWaitMs=${avg(w.priceWaitMs, w.ranges)} ` +
        `priceDeadlineHits=${w.priceDeadlineHits} priceCalls{${callText}} gtWaitMs=${Math.round(ext.gtWaitMs - this.externalAtWindowStart.gtWaitMs)} ` +
        `ledgerSkips=${ext.ledgerSkips - this.externalAtWindowStart.ledgerSkips} ` +
        `unpricedClosed=${w.unpricedClosed} lastKnownReads=${ext.lastKnownReads - this.externalAtWindowStart.lastKnownReads} ` +
        `cacheOnlyMisses=${ext.cacheOnlyMisses - this.externalAtWindowStart.cacheOnlyMisses} feeReadMs=${avg(w.feeReadMs, w.ranges)} ` +
        `feesMeasured=${w.feesMeasured} normalizeMs=${avg(w.normalizeMs, w.ranges)} flushMs=${avg(w.flushMs, w.ranges)} ` +
        `budgetWaitMs=${Math.round(w.budgetWaitMs + (ext.budgetWaitMs ?? 0) - (this.externalAtWindowStart.budgetWaitMs ?? 0))} ` +
        `overflowPages=${w.overflowPages} pos/s=${(w.written / secs).toFixed(1)}`,
    );
    this.window = emptyTotals();
    this.windowRanges = 0;
    this.windowStartMs = nowMs;
    this.externalAtWindowStart = ext;
    this.publish();
  }

  snapshot(): BackfillProfileSnapshot {
    const ext = this.external();
    const nowMs = this.now();
    const secs = Math.max(0.001, (nowMs - this.startedAtMs) / 1000);
    const t = this.total;
    const top = [...this.unpriced.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([address, count]) => ({ address, count }));
    return {
      chainId: this.chainId,
      protocol: this.protocol,
      paging: this.paging,
      phase: this.phase,
      startedAt: new Date(this.startedAtMs).toISOString(),
      updatedAt: new Date(nowMs).toISOString(),
      ranges: t.ranges,
      rows: t.rows,
      written: t.written,
      posPerSec: Number((t.written / secs).toFixed(1)),
      pageMs: Math.round(t.pageMs),
      dynMs: Math.round(t.dynMs),
      tokensMs: Math.round(t.tokensMs),
      priceMs: Math.round(t.priceMs),
      priceWaitMs: Math.round(t.priceWaitMs),
      priceDeadlineHits: t.priceDeadlineHits,
      feeReadMs: Math.round(t.feeReadMs),
      feesMeasured: t.feesMeasured,
      normalizeMs: Math.round(t.normalizeMs),
      flushMs: Math.round(t.flushMs),
      budgetWaitMs: Math.round(t.budgetWaitMs + (ext.budgetWaitMs ?? 0) - this.budgetWaitAtStart),
      overflowPages: t.overflowPages,
      unpricedClosedInserts: t.unpricedClosed,
      unpricedClosedTop: top,
      priceCalls: { ...ext.providerCalls },
      ledgerSkips: ext.ledgerSkips,
      lastKnownReads: ext.lastKnownReads,
      cacheOnlyMisses: ext.cacheOnlyMisses,
      gtWaitMs: Math.round(ext.gtWaitMs),
      tailRows: this.tailRows,
      cursor: this.cursor,
    };
  }

  private publish(): void {
    latest.set(`${this.chainId}:${this.protocol}`, this.snapshot());
  }
}

interface Totals {
  ranges: number;
  rows: number;
  written: number;
  pageMs: number;
  dynMs: number;
  tokensMs: number;
  priceMs: number;
  priceWaitMs: number;
  priceDeadlineHits: number;
  feeReadMs: number;
  feesMeasured: number;
  normalizeMs: number;
  flushMs: number;
  budgetWaitMs: number;
  overflowPages: number;
  unpricedClosed: number;
}

function emptyTotals(): Totals {
  return {
    ranges: 0,
    rows: 0,
    written: 0,
    pageMs: 0,
    dynMs: 0,
    tokensMs: 0,
    priceMs: 0,
    priceWaitMs: 0,
    priceDeadlineHits: 0,
    feeReadMs: 0,
    feesMeasured: 0,
    normalizeMs: 0,
    flushMs: 0,
    budgetWaitMs: 0,
    overflowPages: 0,
    unpricedClosed: 0,
  };
}

function avg(sum: number, n: number): number {
  return n > 0 ? Math.round(sum / n) : 0;
}

function diffRecord(now: Record<string, number>, then: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(now)) out[k] = v - (then[k] ?? 0);
  return out;
}
