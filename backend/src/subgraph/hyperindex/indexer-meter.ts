/*
 * Counts every indexer request, per upstream URL, by lane and by job.
 *
 * Every Envio number before this was an ESTIMATE (background jobs were put at
 * ~565-1,020 req/min against a 1000/min deployment limit). The meter replaces
 * them with measurements, and is the baseline the gateway's budget is sized
 * against and every later "this cut N req/min" claim is checked against.
 *
 * Keyed by URL, not by chain: `HyperindexUpstream` is built per (chainId, url),
 * but the limit is per DEPLOYMENT, and all chains can share one.
 *
 * Counters only. Recording never throws and never awaits, so a meter bug cannot
 * fail an indexer call.
 */

import { Logger } from '@nestjs/common';
import { INDEXER_LANES, type IndexerLane } from './indexer-context.js';

export type IndexerOutcome = '2xx' | '4xx' | '429' | '5xx' | 'network' | 'timeout' | 'abort';

const OUTCOMES: readonly IndexerOutcome[] = ['2xx', '4xx', '429', '5xx', 'network', 'timeout', 'abort'];

export interface IndexerCallRecord {
  lane: IndexerLane;
  job?: string;
  outcome: IndexerOutcome;
  latencyMs: number;
  /** Time spent queued in the gateway before dispatch (0 in observe mode). */
  queuedMs?: number;
}

export interface IndexerWindowSnapshot {
  startedAt: string;
  durationMs: number;
  total: number;
  lanes: Record<IndexerLane, number>;
  jobs: Record<string, number>;
  outcomes: Record<IndexerOutcome, number>;
  p50Ms: number | null;
  p95Ms: number | null;
  /** p95 of the gateway queue wait for the interactive lane — the user-facing cost. */
  interactiveQueueP95Ms: number | null;
}

export interface IndexerMeterSnapshot {
  url: string;
  /** The last COMPLETED one-minute window, or null before the first roll. */
  lastMinute: IndexerWindowSnapshot | null;
  /** The window being filled now. */
  current: IndexerWindowSnapshot;
  sinceBoot: { total: number; lanes: Record<IndexerLane, number>; outcomes: Record<IndexerOutcome, number> };
}

/** One row per job name at most this many; the rest fold into `other`. */
const MAX_JOBS = 64;
/** Latency samples kept per window for the percentiles. */
const MAX_SAMPLES = 4096;
export const METER_WINDOW_MS = 60_000;

function zeroLanes(): Record<IndexerLane, number> {
  return Object.fromEntries(INDEXER_LANES.map((l) => [l, 0])) as Record<IndexerLane, number>;
}
function zeroOutcomes(): Record<IndexerOutcome, number> {
  return Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<IndexerOutcome, number>;
}

class MeterWindow {
  total = 0;
  readonly lanes = zeroLanes();
  readonly jobs = new Map<string, number>();
  readonly outcomes = zeroOutcomes();
  private readonly latencies: number[] = [];
  private readonly interactiveWaits: number[] = [];

  constructor(readonly startedAt: number) {}

  add(r: IndexerCallRecord): void {
    this.total += 1;
    this.lanes[r.lane] += 1;
    this.outcomes[r.outcome] += 1;
    const job = r.job ?? 'untagged';
    const key = this.jobs.has(job) || this.jobs.size < MAX_JOBS ? job : 'other';
    this.jobs.set(key, (this.jobs.get(key) ?? 0) + 1);
    // Bounded: past the cap the percentiles describe the first MAX_SAMPLES calls
    // of the minute, which is plenty to see a p95 move.
    if (this.latencies.length < MAX_SAMPLES) this.latencies.push(r.latencyMs);
    if (r.lane === 'interactive' && this.interactiveWaits.length < MAX_SAMPLES) {
      this.interactiveWaits.push(r.queuedMs ?? 0);
    }
  }

  snapshot(now: number): IndexerWindowSnapshot {
    return {
      startedAt: new Date(this.startedAt).toISOString(),
      durationMs: Math.max(0, now - this.startedAt),
      total: this.total,
      lanes: { ...this.lanes },
      jobs: Object.fromEntries([...this.jobs.entries()].sort((a, b) => b[1] - a[1])),
      outcomes: { ...this.outcomes },
      p50Ms: percentile(this.latencies, 0.5),
      p95Ms: percentile(this.latencies, 0.95),
      interactiveQueueP95Ms: percentile(this.interactiveWaits, 0.95),
    };
  }
}

export function percentile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return Math.round(sorted[idx]);
}

/**
 * The URL as it may appear in a log line or an admin response: no query string
 * and no userinfo, in case a provider ever puts a key in either.
 */
export function displayUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return url.split('?')[0] ?? url;
  }
}

export class IndexerMeter {
  private window: MeterWindow;
  private last: IndexerWindowSnapshot | null = null;
  private bootTotal = 0;
  private readonly bootLanes = zeroLanes();
  private readonly bootOutcomes = zeroOutcomes();

  constructor(readonly url: string, now: number = Date.now()) {
    this.window = new MeterWindow(now);
  }

  record(r: IndexerCallRecord): void {
    try {
      this.window.add(r);
      this.bootTotal += 1;
      this.bootLanes[r.lane] += 1;
      this.bootOutcomes[r.outcome] += 1;
    } catch {
      // Counters must never fail the call they describe.
    }
  }

  /** Close the current window and start a new one. Returns the closed window. */
  roll(now: number = Date.now()): IndexerWindowSnapshot {
    const closed = this.window.snapshot(now);
    this.last = closed;
    this.window = new MeterWindow(now);
    return closed;
  }

  snapshot(now: number = Date.now()): IndexerMeterSnapshot {
    return {
      url: displayUrl(this.url),
      lastMinute: this.last,
      current: this.window.snapshot(now),
      sinceBoot: { total: this.bootTotal, lanes: { ...this.bootLanes }, outcomes: { ...this.bootOutcomes } },
    };
  }
}

/** `[indexer-budget] url=… total=… lanes{…} jobs{…} 429=… p50/p95ms=…` */
export function formatBudgetLine(url: string, w: IndexerWindowSnapshot): string {
  const kv = (o: Record<string, number>) =>
    Object.entries(o)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k}=${n}`)
      .join(' ');
  const pct = (v: number | null) => (v === null ? '-' : String(v));
  return (
    `[indexer-budget] url=${displayUrl(url)} total=${w.total} ` +
    `lanes{${kv(w.lanes)}} jobs{${kv(w.jobs)}} 429=${w.outcomes['429']} ` +
    `outcomes{${kv(w.outcomes)}} p50/p95ms=${pct(w.p50Ms)}/${pct(w.p95Ms)} ` +
    `interactiveQueueP95ms=${pct(w.interactiveQueueP95Ms)}`
  );
}

const meters = new Map<string, IndexerMeter>();
const logger = new Logger('IndexerBudget');
let ticker: NodeJS.Timeout | undefined;
/**
 * P2.2: an optional suffix per URL for the minute line (the gateway's shared
 * budget counters). Set by `indexer-gateway.ts`; absent = today's line.
 */
let lineSuffix: ((url: string) => string | undefined) | undefined;

/** Register the per-URL suffix of the `[indexer-budget]` line (undefined clears it). */
export function setIndexerBudgetLineSuffix(fn: ((url: string) => string | undefined) | undefined): void {
  lineSuffix = fn;
}

function ensureTicker(): void {
  if (ticker) return;
  ticker = setInterval(() => rollAndLogIndexerMeters(), METER_WINDOW_MS);
  // Never hold the process open (or a test run) for a log line.
  ticker.unref?.();
}

export function meterForUrl(url: string): IndexerMeter {
  let m = meters.get(url);
  if (!m) {
    m = new IndexerMeter(url);
    meters.set(url, m);
    ensureTicker();
  }
  return m;
}

/**
 * Roll every meter's window and log it. A URL with no traffic in the minute logs
 * nothing — silence is the answer, and a line per idle URL every minute is noise.
 * Exported so the spec can drive it without waiting a minute.
 */
export function rollAndLogIndexerMeters(now: number = Date.now()): string[] {
  const lines: string[] = [];
  for (const [url, m] of meters) {
    const w = m.roll(now);
    if (w.total === 0) continue;
    let suffix: string | undefined;
    try {
      suffix = lineSuffix?.(url);
    } catch {
      suffix = undefined; // a status suffix must never cost the line itself
    }
    const line = suffix ? `${formatBudgetLine(url, w)} ${suffix}` : formatBudgetLine(url, w);
    lines.push(line);
    logger.log(line);
  }
  return lines;
}

/** Every meter's snapshot, for `GET /admin/sync/status`. Empty before the first indexer call. */
export function indexerMeterSnapshots(now: number = Date.now()): IndexerMeterSnapshot[] {
  return [...meters.values()].map((m) => m.snapshot(now));
}

/** Test seam. */
export function __resetIndexerMeters(): void {
  meters.clear();
  if (ticker) clearInterval(ticker);
  ticker = undefined;
}
