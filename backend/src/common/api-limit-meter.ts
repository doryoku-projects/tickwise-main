/**
 * What the `/api` budget saw, for sizing it. In observe mode this is the whole
 * point of the feature: the limits are set at 5–10× the heaviest real visitor,
 * and "heaviest real visitor" is only known from here.
 *
 * Pure (a clock is passed in) so the percentile arithmetic can be tested.
 * One instance per process; it keeps nothing but small counters and one map of
 * per-IP points, which is dropped every hour and capped at `MAX_IPS` entries.
 */

const MAX_IPS = 100_000;
const FIRST_MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const TOP_N = 10;

interface IpRecord {
  firstAt: number;
  /** Points in the first minute this IP was seen: the landing-view burst. */
  firstMinute: number;
  hour: number;
}

export interface MinuteSummary {
  requests: number;
  points: number;
  ips: number;
  maxIpPoints: number;
  limited: number;
  wouldLimit: Record<string, number>;
  maxInFlight: number;
  failOpen: number;
}

export interface HourSummary {
  ips: number;
  overflowIps: number;
  hour: Percentiles;
  firstMinute: Percentiles;
  top: Array<[string, number]>;
}

export interface Percentiles {
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export class ApiLimitMeter {
  private ips = new Map<string, IpRecord>();
  private overflowIps = 0;
  private hourStartedAt: number;
  private minute = ApiLimitMeter.emptyMinute();
  private minuteIps = new Map<string, number>();

  constructor(now: number) {
    this.hourStartedAt = now;
  }

  private static emptyMinute(): MinuteSummary {
    return { requests: 0, points: 0, ips: 0, maxIpPoints: 0, limited: 0, wouldLimit: {}, maxInFlight: 0, failOpen: 0 };
  }

  /** One admitted request charged `points`. */
  record(key: string, points: number, now: number): void {
    this.minute.requests += 1;
    this.minute.points += points;
    const inMinute = (this.minuteIps.get(key) ?? 0) + points;
    this.minuteIps.set(key, inMinute);
    if (inMinute > this.minute.maxIpPoints) this.minute.maxIpPoints = inMinute;
    let rec = this.ips.get(key);
    if (!rec) {
      if (this.ips.size >= MAX_IPS) {
        this.overflowIps += 1;
        return;
      }
      rec = { firstAt: now, firstMinute: 0, hour: 0 };
      this.ips.set(key, rec);
    }
    rec.hour += points;
    if (now - rec.firstAt < FIRST_MINUTE_MS) rec.firstMinute += points;
  }

  /** A request over a limit: refused in enforce mode, only counted in observe mode. */
  limit(reason: string, enforced: boolean): void {
    if (enforced) this.minute.limited += 1;
    else this.minute.wouldLimit[reason] = (this.minute.wouldLimit[reason] ?? 0) + 1;
  }

  /** A request nobody could be charged for (no usable address, or the store failed): let through. */
  failOpen(): void {
    this.minute.failOpen += 1;
  }

  inFlight(n: number): void {
    if (n > this.minute.maxInFlight) this.minute.maxInFlight = n;
  }

  /** The finished minute's summary (and a fresh one), or `undefined` when nothing happened. */
  takeMinute(): MinuteSummary | undefined {
    const out = this.minute;
    out.ips = this.minuteIps.size;
    this.minute = ApiLimitMeter.emptyMinute();
    this.minuteIps = new Map();
    const idle = out.requests === 0 && out.limited === 0 && out.failOpen === 0 && Object.keys(out.wouldLimit).length === 0;
    return idle ? undefined : out;
  }

  /** The finished hour's per-IP distribution once an hour has passed since the last one. */
  takeHour(now: number): HourSummary | undefined {
    if (now - this.hourStartedAt < HOUR_MS) return undefined;
    const records = [...this.ips.entries()];
    const out: HourSummary = {
      ips: records.length,
      overflowIps: this.overflowIps,
      hour: percentiles(records.map(([, r]) => r.hour)),
      firstMinute: percentiles(records.map(([, r]) => r.firstMinute)),
      top: records
        .sort((a, b) => b[1].hour - a[1].hour)
        .slice(0, TOP_N)
        .map(([key, r]) => [key, r.hour] as [string, number]),
    };
    this.ips = new Map();
    this.overflowIps = 0;
    this.hourStartedAt = now;
    return records.length === 0 ? undefined : out;
  }
}

/** Nearest-rank percentiles; zeros for an empty list. */
export function percentiles(values: number[]): Percentiles {
  if (values.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted[sorted.length - 1]! };
}

export function formatMinute(mode: string, s: MinuteSummary): string {
  const would = Object.entries(s.wouldLimit)
    .map(([reason, n]) => `${reason}:${n}`)
    .join(',');
  return (
    `[api-limit] mode=${mode} 60s requests=${s.requests} points=${s.points} ips=${s.ips} maxIpPoints=${s.maxIpPoints} ` +
    `maxInFlight=${s.maxInFlight} limited=${s.limited} wouldLimit{${would}} failOpen=${s.failOpen}`
  );
}

export function formatHour(mode: string, s: HourSummary): string {
  const p = (x: Percentiles) => `p50=${x.p50} p95=${x.p95} p99=${x.p99} max=${x.max}`;
  const top = s.top.map(([key, points]) => `${key}=${points}`).join(' ');
  return (
    `[api-limit] mode=${mode} hour ips=${s.ips}${s.overflowIps ? ` (+${s.overflowIps} not tracked)` : ''} ` +
    `pointsPerIpHour{${p(s.hour)}} firstMinutePoints{${p(s.firstMinute)}} top: ${top}`
  );
}
