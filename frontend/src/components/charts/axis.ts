import type { IChartApi, Time } from "lightweight-charts";

export interface AxisTick {
  x: number;
  label: string;
  /**
   * Where the label sits relative to `x`. Edge ticks anchor inwards so they are
   * not half-clipped by the chart's box — `.tvAxis span` centres by default,
   * which cut "Feb" to "eb" at x≈0.
   */
  anchor: "start" | "center" | "end";
}

/** Unit whose natural calendar boundaries the ticks land on. */
export type AxisGranularity = "minute" | "hour" | "day" | "month" | "year";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Picks the unit that yields roughly `count` labels for a visible span, so the
 * axis re-scales itself as you zoom instead of repeating one format.
 *
 * The old axis formatted EVERY tick as a month name at every zoom level, so a
 * range inside one month rendered "Jun Jun Jun Jun Jun" — six ticks, one
 * distinguishable value. Zoom into a month and you now get days; zoom out to
 * years and you get months carrying a year marker.
 */
export function pickGranularity(spanSec: number, count = 6): AxisGranularity {
  const per = spanSec / Math.max(1, count);
  if (per <= 30 * MINUTE) return "minute";
  if (per <= 12 * HOUR) return "hour";
  // ~8 days per tick => spans up to ~7 weeks get DATE labels. Tuned so that
  // "zoomed into a month" reads as days, and anything wider falls back to month
  // names (which carry a year marker each January).
  if (per <= 8 * DAY) return "day";
  // ~200 days per tick => spans up to ~3.3 years stay on months, so a
  // multi-year view reads as "Aug / Jan '26 / Jun" rather than two bare years.
  if (per <= 200 * DAY) return "month";
  return "year";
}

/**
 * Label for one tick. All UTC — chart times are UTC seconds.
 *
 * `withYear` MUST be set when the visible range crosses a calendar year, or
 * month/day labels repeat across years and the de-duplication below silently
 * drops the later ones. That is a real bug this code shipped with: a 19-month
 * span thins to every 4th month => Feb, Jun, Oct, Feb, Jun, and the second Feb
 * and Jun were discarded as duplicates, leaving the right half of a long
 * position's axis completely unlabelled.
 */
export function formatTick(tSec: number, g: AxisGranularity, withYear = false): string {
  const d = new Date(tSec * 1000);
  const mon = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  const yy = `'${String(d.getUTCFullYear()).slice(2)}`;
  switch (g) {
    case "minute":
    case "hour": {
      // Spans reaching this granularity are sub-day, so a year is never needed.
      const hh = String(d.getUTCHours()).padStart(2, "0");
      const mm = String(d.getUTCMinutes()).padStart(2, "0");
      return `${hh}:${mm}`;
    }
    case "day":
      return withYear ? `${d.getUTCDate()} ${mon} ${yy}` : `${d.getUTCDate()} ${mon}`;
    case "month":
      // Always carry the year across a multi-year span; otherwise mark January
      // only, which keeps a single-year axis uncluttered.
      return withYear || d.getUTCMonth() === 0 ? `${mon} ${yy}` : mon;
    case "year":
      return String(d.getUTCFullYear());
  }
}

/**
 * Every natural boundary of `g` inside [fromSec, toSec], oldest first.
 *
 * Boundaries rather than evenly-spaced DATA INDICES, which is what produced
 * "Feb Mar May Jun Jul Aug" — April had fewer samples, so no index landed in it
 * and the month silently vanished from the axis.
 */
function boundaries(fromSec: number, toSec: number, g: AxisGranularity): number[] {
  const out: number[] = [];
  const start = new Date(fromSec * 1000);
  const y = start.getUTCFullYear();
  const m = start.getUTCMonth();
  const d = start.getUTCDate();
  const h = start.getUTCHours();

  let cursor: number;
  switch (g) {
    case "year":
      cursor = Date.UTC(y, 0, 1);
      break;
    case "month":
      cursor = Date.UTC(y, m, 1);
      break;
    case "day":
      cursor = Date.UTC(y, m, d);
      break;
    case "hour":
      cursor = Date.UTC(y, m, d, h);
      break;
    case "minute":
      cursor = Math.floor(fromSec / MINUTE) * MINUTE * 1000;
      break;
  }

  // Hard cap: a wide span at a fine unit could otherwise loop for a very long
  // time before the thinning step below ever runs.
  const LIMIT = 2000;
  for (let i = 0; i < LIMIT && cursor / 1000 <= toSec; i++) {
    const sec = cursor / 1000;
    if (sec >= fromSec) out.push(sec);
    const c = new Date(cursor);
    switch (g) {
      case "year":
        cursor = Date.UTC(c.getUTCFullYear() + 1, 0, 1);
        break;
      case "month":
        cursor = Date.UTC(c.getUTCFullYear(), c.getUTCMonth() + 1, 1);
        break;
      case "day":
        cursor += DAY * 1000;
        break;
      case "hour":
        cursor += HOUR * 1000;
        break;
      case "minute":
        cursor += MINUTE * 1000;
        break;
    }
  }
  return out;
}

/** Index of the entry in sorted `times` closest to `target`. */
function nearestIndex(times: number[], target: number): number {
  let lo = 0;
  let hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(times[lo - 1] - target) <= Math.abs(times[lo] - target)) return lo - 1;
  return lo;
}

/** How far a data point may sit from a boundary and still carry its label. */
function tolerance(g: AxisGranularity): number {
  switch (g) {
    case "minute":
      return MINUTE;
    case "hour":
      return HOUR;
    case "day":
      return DAY;
    case "month":
      return 16 * DAY;
    case "year":
      return 200 * DAY;
  }
}

/**
 * Build a date axis for the CURRENTLY VISIBLE range, mapping each tick to an x
 * pixel. Rendered as HTML below the chart because lightweight-charts' own canvas
 * axis clips its labels in this app. Re-run on visible-range changes so it stays
 * synced to pan and zoom.
 *
 * Ticks land on calendar boundaries and are mapped through the NEAREST DATA
 * POINT rather than by interpolating time to pixels. That is deliberate:
 * lightweight-charts spaces bars by logical index, not by elapsed time, so with
 * irregular samples equal time gaps are NOT equal pixel gaps and interpolation
 * would drift the labels away from the data they describe. A boundary whose
 * nearest sample is further away than `tolerance` is dropped instead of being
 * mislabelled — a genuine gap in the data shows as a gap in the axis.
 */
export function computeTimeAxis(chart: IChartApi, times: Time[], count = 6): AxisTick[] {
  if (times.length === 0) return [];
  const ts = chart.timeScale();
  const all = times.map((t) => t as number);

  const range = ts.getVisibleRange();
  const from = range ? (range.from as number) : all[0];
  const to = range ? (range.to as number) : all[all.length - 1];
  const span = Math.max(1, to - from);

  const g = pickGranularity(span, count);
  // Disambiguate repeated month/day names when the window straddles a year.
  const withYear =
    new Date(from * 1000).getUTCFullYear() !== new Date(to * 1000).getUTCFullYear();
  let marks = boundaries(from, to, g);

  // Thin to ~count, keeping boundary alignment (every Nth boundary).
  if (marks.length > count) {
    const step = Math.ceil(marks.length / count);
    marks = marks.filter((_, i) => i % step === 0);
  }

  // A very short span can contain no boundary at all (e.g. 40 minutes of data
  // at hour granularity). Fall back to the visible extremes so the axis is never
  // blank.
  if (marks.length === 0) marks = [from, to];

  const width = typeof ts.width === "function" ? ts.width() : 0;
  const EDGE = 28;
  const MIN_GAP = 34;

  const out: AxisTick[] = [];
  const usedLabels = new Set<string>();
  const tol = tolerance(g);

  for (const mark of marks) {
    const idx = nearestIndex(all, mark);
    const t = all[idx];
    if (Math.abs(t - mark) > tol) continue;

    const label = formatTick(mark, g, withYear);
    if (usedLabels.has(label)) continue;

    const x = ts.timeToCoordinate(times[idx]);
    if (x == null || !Number.isFinite(x)) continue;
    // Drop labels that would collide with the one before them.
    if (out.length > 0 && Math.abs(x - out[out.length - 1].x) < MIN_GAP) continue;

    usedLabels.add(label);
    const anchor: AxisTick["anchor"] =
      x < EDGE ? "start" : width > 0 && x > width - EDGE ? "end" : "center";
    out.push({ x, label, anchor });
  }

  return out;
}
