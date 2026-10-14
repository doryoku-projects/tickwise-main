"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { EmptyState } from "../StateViews";
import { formatTick, pickGranularity, type AxisGranularity } from "./axis";

/** One day of the usage-detail `series`, as the detail endpoint returns it. */
export interface UsageDayPoint {
  /** 'YYYY-MM-DD', UTC — the bucket key, not a local calendar day. */
  day: string;
  units: number;
  requests: number;
}

const DAY_SEC = 86400;
const DEFAULT_H = 200;
// Room for the y-axis labels ("1.2M" in mono at 10px) and the tick row below.
const PAD_L = 46;
const PAD_R = 10;
const PAD_T = 12;
const PAD_B = 20;
/*
 * Ceiling on the gap-filling below. Buckets are deleted by a 400-day TTL, so a
 * densified range can never legitimately exceed this; the cap only protects
 * against a caller passing two rows a decade apart.
 */
const MAX_BARS = 400;
const TICK_COUNT = 6;
/** Distance from an edge at which a tick label anchors inwards instead of centring. */
const EDGE = 28;
const MIN_GAP = 40;
/*
 * A day that consumed units must be VISIBLE. Without a floor, a day 400x below
 * the month's peak renders at 0.4px and reads as "no traffic" — which on a
 * billing chart is the one thing it must never say by accident.
 */
const MIN_BAR_PX = 2;
const TOOLTIP_W = 170;

interface Bar {
  /** UTC seconds at midnight of `day`. */
  t: number;
  day: string;
  units: number;
  requests: number;
}

interface XTick {
  x: number;
  label: string;
  anchor: "start" | "middle" | "end";
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function daySeconds(day: string): number {
  const ms = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : NaN;
}

// Locale pinned, like `formatPeriod` and the pages' own `formatDay`: the axis
// and the tooltip sit inches from en-US dates and grouped numbers rendered by
// those helpers, and a browser set to de-DE would disagree with them on screen.
function fmtCompact(v: number): string {
  return v.toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 });
}

function fmtDay(day: string): string {
  const sec = daySeconds(day);
  if (!Number.isFinite(sec)) return day;
  return new Date(sec * 1000).toLocaleDateString("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Round the axis top up to 1/2/2.5/5 x a power of ten, so gridlines land on readable numbers. */
function niceCeil(v: number): number {
  if (!(v > 0)) return 0;
  const pow = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5]) {
    if (v <= m * pow) return m * pow;
  }
  return 10 * pow;
}

/**
 * Sorted, de-duplicated bars with the MISSING DAYS FILLED IN at zero.
 *
 * The endpoint only emits a bucket for a day that saw traffic, so plotting the
 * rows as given spaces bars by index and a fortnight of silence collapses into
 * one bar-width gap — which draws a busy week and a quiet month at identical
 * widths, and puts every axis label on the wrong bar. A zero day is real data
 * on a usage chart, so it gets its own slot.
 *
 * `from`/`to` are the WINDOW the caller was told it is looking at. Without them
 * the domain is the extent of the traffic, so a month range holding one busy day
 * drew a single bar across the whole plot under a heading naming the month —
 * which reads as a broken chart and quietly redefines the range. They are
 * UNIONED with the data rather than replacing it: a row outside the window is a
 * server-side surprise, and dropping it silently would be worse than drawing it.
 */
function densify(data: UsageDayPoint[], from?: string, to?: string): Bar[] {
  const byDay = new Map<string, Bar>();
  for (const row of data) {
    const t = daySeconds(row.day);
    if (!Number.isFinite(t)) continue;
    const prev = byDay.get(row.day);
    // Summed rather than replaced: one row per day is the contract, and if that
    // ever breaks, double-counting is a visible error where dropping is silent.
    if (prev) {
      prev.units += row.units;
      prev.requests += row.requests;
      continue;
    }
    byDay.set(row.day, { t, day: row.day, units: row.units, requests: row.requests });
  }

  const rows = [...byDay.values()].sort((a, b) => a.t - b.t);
  // No traffic at all stays EMPTY rather than becoming a month of zero bars: the
  // caller's empty state says "no usage in this range", which a flat axis does
  // not, and a chart of nothing is not worth the space.
  if (rows.length === 0) return rows;

  const fromSec = from ? daySeconds(from) : NaN;
  const toSec = to ? daySeconds(to) : NaN;
  let start = rows[0].t;
  let end = rows[rows.length - 1].t;
  if (Number.isFinite(fromSec)) start = Math.min(start, fromSec);
  if (Number.isFinite(toSec)) end = Math.max(end, toSec);

  const span = (end - start) / DAY_SEC + 1;
  if (span < 2 || span > MAX_BARS) return rows;

  const out: Bar[] = [];
  let next = 0;
  for (let t = start; t <= end; t += DAY_SEC) {
    if (next < rows.length && rows[next].t === t) {
      out.push(rows[next]);
      next += 1;
      continue;
    }
    out.push({ t, day: new Date(t * 1000).toISOString().slice(0, 10), units: 0, requests: 0 });
  }
  return out;
}

/** Whether a day opens a new period of `g` — i.e. whether it earns an axis label. */
function isBoundary(t: number, g: AxisGranularity): boolean {
  const d = new Date(t * 1000);
  if (g === "year") return d.getUTCMonth() === 0 && d.getUTCDate() === 1;
  if (g === "month") return d.getUTCDate() === 1;
  return true;
}

/**
 * Date ticks over the bar grid.
 *
 * `pickGranularity` and `formatTick` are the date logic and come from axis.ts;
 * `computeTimeAxis` does not fit here because it maps ticks through a
 * lightweight-charts `IChartApi` timeScale, and this chart has no chart object —
 * bars are laid out on a fixed grid, so x is arithmetic rather than a lookup.
 */
function buildTicks(bars: Bar[], xOf: (i: number) => number, width: number): XTick[] {
  if (bars.length === 0) return [];
  const first = bars[0].t;
  const last = bars[bars.length - 1].t;
  const raw = pickGranularity(Math.max(DAY_SEC, last - first), TICK_COUNT);
  /*
   * Buckets are whole UTC days, so the sub-day granularities have nothing to
   * say: a three-day range asks for hours and every label would read "00:00".
   */
  const g: AxisGranularity = raw === "minute" || raw === "hour" ? "day" : raw;
  // Month/day names repeat across years; without this a range straddling
  // January drops its second "Jan" as a duplicate and leaves that end unlabelled.
  const withYear =
    new Date(first * 1000).getUTCFullYear() !== new Date(last * 1000).getUTCFullYear();

  let marks: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (isBoundary(bars[i].t, g)) marks.push(i);
  }
  /*
   * A range can hold fewer than two boundaries — ten days inside one month at
   * month granularity has none, and two rows six years apart have only the one
   * that happens to fall on a 1 January. Fall back to the extremes so the axis
   * is never blank, and never a single lonely label on a chart with two ends.
   */
  if (marks.length < 2 && bars.length > 1) marks = [0, bars.length - 1];
  if (marks.length > TICK_COUNT) {
    const step = Math.ceil(marks.length / TICK_COUNT);
    marks = marks.filter((_, k) => k % step === 0);
  }

  const out: XTick[] = [];
  const used = new Set<string>();
  for (const i of marks) {
    const label = formatTick(bars[i].t, g, withYear);
    if (used.has(label)) continue;
    const x = xOf(i);
    if (out.length > 0 && Math.abs(x - out[out.length - 1].x) < MIN_GAP) continue;
    used.add(label);
    out.push({
      x,
      label,
      anchor: x < EDGE ? "start" : width > 0 && x > width - EDGE ? "end" : "middle",
    });
  }
  return out;
}

/**
 * Units consumed per day, as a bespoke SVG column chart.
 *
 * Bespoke rather than lightweight-charts (the app's only charting dep) because
 * a fixed grid of at most a few hundred non-negative columns needs none of what
 * that library is for — pan, zoom, a live time scale — and every colour handed
 * to it has to be pre-resolved to sRGB first (see charts/theme.ts, and the
 * oklch outage it documents). Reading the tokens straight from CSS keeps light
 * and dark working with no JS in the loop. `SeriesAreaChart` is not reusable
 * here either: it is a baseline series split green-above/red-below zero, which
 * is meaningless for a count that cannot go negative.
 *
 * The bar encodes UNITS, not requests, because units are what the plan is
 * metered and billed against; requests ride along in the tooltip rather than on
 * a second axis, which would double the ink to answer a question the byRoute
 * and byStatus tables answer better.
 */
export default function UsageBarChart({
  data,
  from,
  to,
  height = DEFAULT_H,
}: {
  data: UsageDayPoint[];
  /**
   * The window the caller is presenting, 'YYYY-MM-DD' UTC. Optional: without it
   * the axis spans the days that saw traffic, which is right for a caller that
   * has no window to name. Pass both when the surface prints a range next to the
   * chart, so the two agree.
   */
  from?: string;
  to?: string;
  /** Plot height in px, including the axis rows. */
  height?: number;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  const bars = useMemo(() => densify(data, from, to), [data, from, to]);

  /*
   * Measured, not viewBox-scaled: a stretched viewBox would distort the axis
   * text along with the bars.
   *
   * `bars.length` is a dependency because the empty state below replaces the
   * measured element entirely — with an `[]` dependency list the observer is
   * attached once, to nothing, and the chart stays at width 0 forever once data
   * finally arrives.
   */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    if (typeof ResizeObserver === "undefined") {
      setWidth(el.clientWidth);
      return;
    }
    const ro = new ResizeObserver((entries) => {
      setWidth(Math.max(0, Math.floor(entries[0]?.contentRect.width ?? el.clientWidth)));
    });
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, [bars.length]);

  if (bars.length === 0) {
    return (
      <EmptyState
        title="No usage in this range"
        hint="Calls to metered endpoints appear here the day they are made."
      />
    );
  }

  // First paint and SSR have no measurement yet; hold the space so the panel
  // does not jump when the real width lands.
  if (width <= 0) {
    return <div ref={wrapRef} className="relative w-full" style={{ height }} />;
  }

  const plotW = Math.max(width - PAD_L - PAD_R, 1);
  const plotH = Math.max(height - PAD_T - PAD_B, 1);
  const slot = plotW / bars.length;
  const barW = clamp(slot * 0.72, 1, 40);
  const xOf = (i: number) => PAD_L + (i + 0.5) * slot;

  const peak = bars.reduce((m, b) => (b.units > m ? b.units : m), 0);
  // `|| 1` keeps the scale finite when every day is free-route or fully
  // refunded; all bars then sit at zero against a 0-1 axis, which is honest —
  // a 0/0 scale would divide by zero and paint every day full height.
  const axisTop = niceCeil(peak) || 1;
  const yOf = (units: number) => PAD_T + plotH - (clamp(units / axisTop, 0, 1) * plotH);

  const ticks = buildTicks(bars, xOf, width);
  const gridlines = [0, 0.5, 1];
  const hovered = hover != null ? bars[hover] : null;

  const totalUnits = bars.reduce((sum, b) => sum + b.units, 0);

  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((e.clientX - rect.left - PAD_L) / slot);
    setHover(i >= 0 && i < bars.length ? i : null);
  };

  return (
    <div
      ref={wrapRef}
      className="relative w-full"
      style={{ height }}
      onPointerMove={onMove}
      /*
       * A tap selects a day too, because per-day units live ONLY in this tooltip
       * — no table on either surface repeats them — and hover does not exist on a
       * phone. Deliberately WITHOUT `touch-action: none`: this chart spans the
       * full column width, and taking the touch gesture would trap vertical
       * scrolling on the way past it.
       */
      onPointerDown={onMove}
      onPointerLeave={() => setHover(null)}
    >
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Units per day, ${bars[0].day} to ${bars[bars.length - 1].day}: ${totalUnits.toLocaleString()} units total`}
      >
        {gridlines.map((f) => {
          const y = PAD_T + plotH - f * plotH;
          return (
            <g key={f}>
              <line
                x1={PAD_L}
                y1={y}
                x2={width - PAD_R}
                y2={y}
                strokeWidth={1}
                strokeDasharray={f === 0 ? undefined : "3 3"}
                style={{ stroke: "var(--border)" }}
              />
              <text
                x={PAD_L - 8}
                y={y + 3}
                textAnchor="end"
                style={{ fill: "var(--muted-foreground)", fontSize: 10, fontFamily: "var(--font-mono)" }}
              >
                {fmtCompact(axisTop * f)}
              </text>
            </g>
          );
        })}

        {bars.map((b, i) => {
          const dimmed = hover != null && hover !== i;
          if (b.units <= 0) {
            /*
             * A day with requests but no billed units — free routes, refunded
             * calls, or a day of nothing but 429s — gets a hairline stub. Left
             * as a bare gap it is indistinguishable from a day the chart has no
             * data for, and the tooltip explaining which one it is only appears
             * once you already suspect there is something to hover.
             */
            if (b.requests <= 0) return null;
            return (
              <rect
                key={b.day}
                x={xOf(i) - barW / 2}
                y={PAD_T + plotH - 1.5}
                width={barW}
                height={1.5}
                style={{ fill: "var(--chart-1)", opacity: dimmed ? 0.25 : 0.5 }}
              />
            );
          }
          const y = Math.min(yOf(b.units), PAD_T + plotH - MIN_BAR_PX);
          return (
            <rect
              key={b.day}
              x={xOf(i) - barW / 2}
              y={y}
              width={barW}
              height={PAD_T + plotH - y}
              rx={barW >= 6 ? 2 : 0}
              style={{ fill: "var(--chart-1)", opacity: dimmed ? 0.45 : 1 }}
            />
          );
        })}

        {ticks.map((t) => (
          <text
            key={t.label}
            x={t.x}
            y={height - 6}
            textAnchor={t.anchor}
            style={{ fill: "var(--muted-foreground)", fontSize: 10, fontFamily: "var(--font-mono)" }}
          >
            {t.label}
          </text>
        ))}
      </svg>

      {hovered && hover != null && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border border-border bg-popover px-3 py-2 shadow-lg"
          style={{ left: clamp(xOf(hover) + 12, 4, Math.max(4, width - TOOLTIP_W)), top: PAD_T }}
        >
          <div className="font-mono text-xs text-muted-foreground">{fmtDay(hovered.day)}</div>
          <div className="mt-1 font-mono text-sm font-semibold">
            {hovered.units.toLocaleString()}
            <span className="ml-1 text-xs font-normal text-muted-foreground">units</span>
          </div>
          <div className="font-mono text-xs text-muted-foreground">
            {hovered.requests.toLocaleString()} requests
          </div>
        </div>
      )}
    </div>
  );
}
