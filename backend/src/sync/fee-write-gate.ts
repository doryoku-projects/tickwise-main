/*
 * The fee job's Mongo write pacing: token buckets refilled per SECOND and
 * shared by every chain in the process (PositionFeeRefreshService owns ONE).
 *
 * WHY: the per-minute read budget (POSITION_FEE_MAX_PER_TICK) bounds how many
 * positions a round measures, not how fast their writes land — a page's writes
 * went out as soon as the page was measured, so a 2000-row page whose rows all
 * moved arrived as one bulkWrite of 2000 updates on an M10 that serves the API
 * from the same primary. Here every chunk of writes waits for tokens first:
 *
 *   - `all`    — every fee write (stamp-only or served).
 *   - `served` — writes that also rewrite the served fields (`metrics.*`,
 *                `amounts.*`), which touch the indexed leaderboard paths and
 *                cost the most index maintenance.
 *   - the BACKFILL lane (`acquire(…, 'backfill')`) additionally draws on its
 *     own pair at BACKFILL_WRITE_SHARE of both rates. Rows a backfill flush
 *     queued have never been measured, so almost every one is a served write;
 *     a backfill flood on one chain could otherwise take the whole served rate
 *     and stall every chain's passes behind it. It still counts against the
 *     two shared buckets.
 *
 * PAY BEFORE SEND, ONE SCHEDULER. A chunk of n tokens at r/s is sent once the
 * bucket has paid for it — at most one second of credit is banked, so a chunk
 * of 100 against a 40/s bucket waits 1.5 s from cold — and a chunk drawing on
 * several buckets goes out when the SLOWEST of them has paid. Every bucket it
 * drew on is then booked up to that send time, not to the earlier moment it
 * alone would have allowed: otherwise a chunk held back by the served bucket
 * left credit behind in `all` that a later stamp-only chunk spent, and the two
 * went out together (100 + 60 ops in the same instant against a 40/s rate).
 * Waiters are booked in arrival order, so they queue rather than overtake.
 * Backpressure is the point: a waiting write stalls its page loop, which stalls
 * the reads behind it. Writes are never dropped or truncated.
 *
 * A rate that is not a positive number disables that bucket (positional spec
 * harnesses pass partial configs); the config getters never produce one.
 */

export interface FeeWriteRates {
  /** Fee writes per second. */
  all: number;
  /** Writes per second that also rewrite the served fields. */
  served: number;
}

/** Which writes a chunk belongs to: the backfill lane is held to a share of the rates. */
export type FeeWriteLane = 'main' | 'backfill';

/** The share of both write rates the backfill lane may use. */
export const BACKFILL_WRITE_SHARE = 0.5;

/** Most credit a bucket banks while idle, in ms of its rate. */
const BURST_MS = 1000;

interface Bucket {
  /** Every token granted so far is paid for at this time (−∞: never used). */
  paidAt: number;
}

export class FeeWriteGate {
  private readonly all: Bucket = { paidAt: Number.NEGATIVE_INFINITY };
  private readonly served: Bucket = { paidAt: Number.NEGATIVE_INFINITY };
  private readonly backfillAll: Bucket = { paidAt: Number.NEGATIVE_INFINITY };
  private readonly backfillServed: Bucket = { paidAt: Number.NEGATIVE_INFINITY };
  /** Total time callers spent waiting (observability, specs). */
  waitedMs = 0;

  constructor(
    private readonly rates: (nowMs: number) => FeeWriteRates,
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /**
   * Take `writes` tokens (and `served` of them from the served bucket, and for
   * the backfill lane from its own pair too), waiting until every bucket has
   * paid for them. Resolves with the wait in ms.
   */
  async acquire(writes: number, served: number, lane: FeeWriteLane = 'main'): Promise<number> {
    const now = this.now();
    const r = this.rates(now);
    const asks: Array<[Bucket, number, number]> = [
      [this.all, r.all, writes],
      [this.served, r.served, served],
    ];
    if (lane === 'backfill') {
      asks.push([this.backfillAll, r.all * BACKFILL_WRITE_SHARE, writes], [this.backfillServed, r.served * BACKFILL_WRITE_SHARE, served]);
    }
    let sendAt = now;
    for (const [b, rate, n] of asks) sendAt = Math.max(sendAt, paidTime(b, rate, n, now));
    // Booked to the moment the chunk actually goes out, in every bucket it drew on.
    for (const [b, rate, n] of asks) if (active(rate) && n > 0) b.paidAt = sendAt;
    const waitMs = Math.max(0, Math.ceil(sendAt - now));
    if (waitMs > 0) {
      this.waitedMs += waitMs;
      await this.sleep(waitMs);
    }
    return waitMs;
  }
}

function active(rate: number): boolean {
  return rate > 0 && Number.isFinite(rate);
}

/** When `b` has paid for `n` more tokens at `rate`/s, banking at most BURST_MS of credit. */
function paidTime(b: Bucket, rate: number, n: number, now: number): number {
  if (!active(rate) || !(n > 0)) return Number.NEGATIVE_INFINITY;
  return Math.max(b.paidAt, now - BURST_MS) + (n / rate) * 1000;
}
