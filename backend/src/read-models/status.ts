import { Logger } from '@nestjs/common';

/**
 * Read-model alerts and counters (design §3.7). Every alert is a
 * `[alert] read_models.<name> …` line, at most once a minute per name (or per
 * name + key), and the last 20 are kept for `GET /admin/sync/status` →
 * `readModels.alerts`. Counters are per process, reset only by a restart.
 *
 * EVIDENCE lines (`evidence`: a confirmed lane-B `data_diff`, a lane-A
 * `shadow_diff`) are not throttled per minute — each one is a row or answer
 * an operator needs to see — but capped at `EVIDENCE_PER_MIN` per name per
 * minute, with one `… suppressed N` line when the next minute starts.
 */

export interface AlertRecord {
  name: string;
  detail: string;
  at: string;
  count: number;
}

const ALERT_EVERY_MS = 60_000;
const KEEP = 20;
/** Evidence lines per name per minute before they are counted instead of logged. */
export const EVIDENCE_PER_MIN = 100;
/** Throttle entries kept before old ones are pruned (keys can be per subject). */
const MAX_THROTTLE_KEYS = 5_000;

export class AlertLog {
  private readonly lastAt = new Map<string, number>();
  private readonly counts = new Map<string, number>();
  private readonly recent: AlertRecord[] = [];

  constructor(
    private readonly logger: Pick<Logger, 'warn'> = new Logger('ReadModels'),
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Log `[alert] <name> <detail>` unless the same name logged within the last
   * minute. Always counted. `key` narrows the once-a-minute throttle to one
   * subject (a transition alert per model: a rank transition must not swallow
   * a pools one); the count stays per name.
   */
  alert(name: string, detail: string, key?: string): void {
    const full = name.startsWith('read_models.') ? name : `read_models.${name}`;
    this.counts.set(full, (this.counts.get(full) ?? 0) + 1);
    const now = this.now();
    const throttle = key === undefined ? full : `${full}|${key}`;
    if (now - (this.lastAt.get(throttle) ?? -Infinity) < ALERT_EVERY_MS) return;
    this.lastAt.set(throttle, now);
    if (this.lastAt.size > MAX_THROTTLE_KEYS) {
      for (const [k, at] of this.lastAt) if (now - at >= ALERT_EVERY_MS) this.lastAt.delete(k);
    }
    this.emit(full, detail, now);
  }

  private readonly evidenceWindow = new Map<string, { minute: number; logged: number; suppressed: number }>();

  /**
   * Log an evidence line (`[alert] <name> <detail>`) EVERY time — a diff the
   * runbook asks operators to keep — up to `EVIDENCE_PER_MIN` per name per
   * minute; past that it is counted, and the first line of the next minute is
   * preceded by `[alert] <name> suppressed N line(s) in the previous minute`.
   */
  evidence(name: string, detail: string): void {
    const full = name.startsWith('read_models.') ? name : `read_models.${name}`;
    this.counts.set(full, (this.counts.get(full) ?? 0) + 1);
    const now = this.now();
    const minute = Math.floor(now / 60_000);
    let w = this.evidenceWindow.get(full);
    if (!w || w.minute !== minute) {
      if (w && w.suppressed > 0) this.logger.warn(`[alert] ${full} suppressed ${w.suppressed} line(s) in the previous minute (over ${EVIDENCE_PER_MIN}/min)`);
      w = { minute, logged: 0, suppressed: 0 };
      this.evidenceWindow.set(full, w);
    }
    if (w.logged >= EVIDENCE_PER_MIN) {
      w.suppressed++;
      return;
    }
    w.logged++;
    this.emit(full, detail, now);
  }

  private emit(full: string, detail: string, now: number): void {
    this.logger.warn(`[alert] ${full} ${detail}`);
    this.recent.unshift({ name: full, detail: detail.slice(0, 500), at: new Date(now).toISOString(), count: this.counts.get(full)! });
    if (this.recent.length > KEEP) this.recent.length = KEEP;
  }

  snapshot(): { recent: AlertRecord[]; counts: Record<string, number> } {
    return { recent: [...this.recent], counts: Object.fromEntries(this.counts) };
  }
}

/** Per-second rates over a sliding minute. */
export class RateMeter {
  private readonly buckets = new Map<number, number>();

  constructor(private readonly now: () => number = Date.now) {}

  add(n = 1): void {
    const second = Math.floor(this.now() / 1000);
    this.buckets.set(second, (this.buckets.get(second) ?? 0) + n);
    if (this.buckets.size > 120) {
      for (const key of this.buckets.keys()) if (key < second - 60) this.buckets.delete(key);
    }
  }

  /** Average per second over the last `seconds` complete seconds. */
  perSecond(seconds = 60): number {
    const now = Math.floor(this.now() / 1000);
    let total = 0;
    for (let s = now - seconds; s < now; s++) total += this.buckets.get(s) ?? 0;
    return Math.round((total / seconds) * 100) / 100;
  }
}

/** The holder's counters (the feeder's §3.7 metrics). */
export class FeederMeter {
  /** Totals since the process started. */
  readonly totals = { events: 0, rows: 0, noops: 0, batches: 0, batchRows: 0 };
  readonly events = new RateMeter();
  readonly rows = new RateMeter();
  readonly noops = new RateMeter();
  readonly batches = new RateMeter();
  readonly appendedBytes = new RateMeter();
  batchRowsLast = 0;
  appendMsLast = 0;
  appendFailures = 0;
  repairs = 0;
  heartbeats = 0;
  snapshots = { written: 0, failed: 0, lastAt: 0, lastBytes: 0, lastEncodeMs: 0, lastRows: 0 };

  snapshot(now = Date.now()) {
    return {
      totals: { ...this.totals },
      eventsPerSec: this.events.perSecond(),
      rowsPerSec: this.rows.perSecond(),
      noopsPerSec: this.noops.perSecond(),
      batchesPerSec: this.batches.perSecond(),
      appendedBytesPerSec: this.appendedBytes.perSecond(),
      batchRowsLast: this.batchRowsLast,
      appendMsLast: this.appendMsLast,
      appendFailures: this.appendFailures,
      repairs: this.repairs,
      heartbeats: this.heartbeats,
      snapshots: {
        ...this.snapshots,
        lastAgeMs: this.snapshots.lastAt ? now - this.snapshots.lastAt : null,
        lastAt: this.snapshots.lastAt ? new Date(this.snapshots.lastAt).toISOString() : null,
      },
    };
  }
}

/** Process memory, for the status block (RSS, heap, array buffers). */
export function processMemory() {
  const m = process.memoryUsage();
  return {
    rssMb: Math.round(m.rss / 1048576),
    heapUsedMb: Math.round(m.heapUsed / 1048576),
    heapTotalMb: Math.round(m.heapTotal / 1048576),
    arrayBuffersMb: Math.round(m.arrayBuffers / 1048576),
    externalMb: Math.round(m.external / 1048576),
  };
}
