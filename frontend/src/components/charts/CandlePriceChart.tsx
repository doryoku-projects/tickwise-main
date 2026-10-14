"use client";

import { useEffect, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type BarPrice,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { ChartPricePoint } from "../../lib/api";
import { type AxisTick, computeTimeAxis } from "./axis";
import { inLwcRange, readChartTheme } from "./theme";

interface Tooltip {
  x: number;
  y: number;
  date: string;
  o: string;
  h: string;
  l: string;
  c: string;
}

const inv = (x: number) => (Number.isFinite(x) && x > 0 ? 1 / x : 0);

function fmt(v: number): string {
  if (!Number.isFinite(v)) return "-";
  if (v === 0) return "0";
  const abs = Math.abs(v);
  const digits = abs >= 1000 ? 2 : abs >= 1 ? 4 : abs >= 0.0001 ? 6 : 8;
  return v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: digits });
}

function fmtDate(t: number): string {
  return new Date(t * 1000).toISOString().slice(0, 10);
}

// ── Collapse-proof price-axis formatting ───────────────────────────────────
// Token-pair prices span ~1e-50 … 1e50, often as a *narrow* band at a small
// magnitude. The hard constraint: adjacent y-axis ticks must never round to the
// same string (a dedup collision blanks the whole axis). A per-value formatter
// can't guarantee that — it never sees the gap between ticks. lightweight-charts
// v5 exposes `tickmarksPriceFormatter`, which receives ALL visible tick values
// at once, so we derive the needed precision from the smallest tick *step*.
const SCI_HI = 1e6; // ≥ this → scientific (huge)
const SCI_LO = 1e-4; // < this → scientific (tiny)

// Scientific with N mantissa decimals, trailing-zero trimmed: sci(3.6e6,1)→"3.6e6".
function sci(v: number, mantDec: number): string {
  const s = v.toExponential(Math.min(Math.max(mantDec, 0), 18));
  const [m, e] = s.split("e");
  return `${parseFloat(m).toString()}e${parseInt(e, 10)}`;
}

function fixed(v: number, dec: number): string {
  return v.toLocaleString("en-US", {
    minimumFractionDigits: Math.min(dec, 2),
    maximumFractionDigits: Math.min(Math.max(dec, 0), 18),
  });
}

function smallestStep(finite: number[]): number {
  const s = [...finite].sort((a, b) => a - b);
  let step = Infinity;
  for (let i = 1; i < s.length; i++) {
    const d = s[i] - s[i - 1];
    if (d > 0 && d < step) step = d;
  }
  return step;
}

function hasDup(arr: string[]): boolean {
  const seen = new Set<string>();
  for (const x of arr) {
    if (x === "") continue;
    if (seen.has(x)) return true;
    seen.add(x);
  }
  return false;
}

// ── The actual fix: data-derived series priceFormat ────────────────────────
// ROOT CAUSE of the blank axis is NOT label collisions — it's tick VALUES.
// lightweight-charts derives the price scale's minimum tick step from the
// series `minMove` (base = round(1/minMove); smallest step = 1/base). The
// default priceFormat is { precision:2, minMove:0.01 }, so the engine can
// never emit a step finer than 0.01. For a low-magnitude/narrow band (e.g. a
// ~0.0045 pair spanning ~0.001) that 0.01 floor is WIDER than the whole visible
// range → the tick generator yields 0–1 values inside it → the axis renders
// empty (the last-value pill is a separate path, so it still shows). We size
// minMove/precision from the displayed span so the native generator can make
// several fine-grained ticks. Returns null for true extremes (handled by the
// custom scientific tickmarks formatter instead, where a literal minMove would
// hit float-precision limits).
function deriveSeriesPriceFormat(
  values: number[],
): { precision: number; minMove: number } | null {
  const finite = values.filter((v) => Number.isFinite(v) && v !== 0);
  if (finite.length === 0) return null;
  const maxAbs = Math.max(...finite.map(Math.abs));
  // HUGE values keep the default minMove (0.01): 0.01 is already far finer than a
  // ≥1e6 range, so the native generator emits plenty of ticks (the tickmarks
  // formatter then labels them scientific). TINY values, however, MUST get a fine
  // minMove — the default 0.01 is COARSER than the whole range (e.g. ~1e-11), so
  // zero ticks generate → blank axis (the scientific formatter can't help when
  // there are no tick values to format).
  if (maxAbs >= SCI_HI) return null;

  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const span = max - min;
  // Decimals that put ~several ticks inside the span. For span s, the leading
  // tick step is ~10^floor(log10 s); we want minMove a couple orders finer.
  // span 0.001 → ~5 decimals; span 60 → 2 decimals (clamped floor). Capped at 15
  // so base=1/minMove stays ≤ ~1e15 (< MAX_SAFE_INTEGER) for sound tick math.
  const dec =
    span > 0 ? Math.min(15, Math.max(2, 2 - Math.floor(Math.log10(span)))) : 2;
  return { precision: dec, minMove: Math.pow(10, -dec) };
}

// Array formatter for the y-axis tick marks. Derives ONE precision for the whole
// tick set from the smallest gap, so by construction no two ticks collide; a
// while-loop is the belt-and-suspenders fallback for float edge cases.
function axisTickFormat(prices: readonly number[]): string[] {
  if (prices.length === 0) return [];
  const finite = prices.filter((p) => Number.isFinite(p)) as number[];
  if (finite.length === 0) return prices.map(() => "");

  const maxAbs = Math.max(...finite.map((v) => Math.abs(v)));
  const step = smallestStep(finite);
  const extreme = maxAbs >= SCI_HI || (maxAbs > 0 && maxAbs < SCI_LO);

  if (extreme) {
    // mantissa decimals ≈ magnitude(value) − magnitude(step): enough sig-figs to
    // separate adjacent ticks even for a razor-thin band at huge/tiny magnitude.
    const expVal = Math.floor(Math.log10(maxAbs));
    const expStep = Number.isFinite(step) ? Math.floor(Math.log10(step)) : expVal - 2;
    let mantDec = Math.max(1, expVal - expStep + 1);
    let out = prices.map((p) => (Number.isFinite(p) ? sci(p, mantDec) : ""));
    while (hasDup(out) && mantDec < 18) {
      mantDec++;
      out = prices.map((p) => (Number.isFinite(p) ? sci(p, mantDec) : ""));
    }
    return out;
  }

  // Normal range: decimals from the step magnitude (+1 guard digit), commas ok.
  let dec = Number.isFinite(step) ? Math.ceil(-Math.log10(step)) + 1 : 2;
  dec = Math.min(Math.max(dec, 0), 18);
  let out = prices.map((p) => (Number.isFinite(p) ? fixed(p, dec) : ""));
  while (hasDup(out) && dec < 18) {
    dec++;
    out = prices.map((p) => (Number.isFinite(p) ? fixed(p, dec) : ""));
  }
  return out;
}

// Single-value formatter for the last-value pill + crosshair label. No step is
// available here (one value), so a fixed ~5 sig-fig budget keeps the pill short;
// the tick-array formatter above is what guarantees the axis never collapses.
function axisPriceFormat(p: number): string {
  if (!Number.isFinite(p)) return "";
  const a = Math.abs(p);
  if (a === 0) return "0";
  if (a >= SCI_HI || a < SCI_LO) return sci(p, 2);
  if (a >= 1000) return fixed(p, 2);
  const dec = Math.min(Math.max(0, 4 - Math.floor(Math.log10(a))), 12);
  return parseFloat(p.toFixed(dec)).toLocaleString("en-US", { maximumFractionDigits: dec });
}

/**
 * Candlestick price chart (TradingView lightweight-charts):
 * OHLC candles, crosshair + OHLC tooltip, native drag-pan / wheel-zoom, dashed
 * MIN/MAX (position range) + current-price lines. `inverted` flips the quote.
 *
 * The built-in time axis is hidden and the month labels are rendered as HTML
 * below the canvas (synced via timeToCoordinate) — lightweight-charts' canvas
 * time-axis clips its labels in this app, so we draw them ourselves.
 */
export default function CandlePriceChart({
  points,
  inverted,
  token0Symbol,
  token1Symbol,
  minPrice,
  maxPrice,
  currentPrice,
}: {
  points: ChartPricePoint[];
  inverted: boolean;
  token0Symbol: string;
  token1Symbol: string;
  minPrice: number;
  maxPrice: number;
  currentPrice: number;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const [axis, setAxis] = useState<AxisTick[]>([]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const theme = readChartTheme(el);

    // DYNAMIC magnitude normalisation. lightweight-charts' price scale cannot
    // reliably generate ticks for arbitrary magnitudes — the smallest tick step
    // is bounded by minMove (= 1/base, base capped by integer math), so a tiny
    // price like 1.88e-11 (default minMove 0.01) yields ZERO ticks → blank axis,
    // and a huge price needs a different step. The robust, price-agnostic fix is
    // to PLOT everything multiplied by a scale factor that brings the median into
    // ~[1,10) — so the scale always works on normal numbers — and UN-SCALE in the
    // label formatters / tooltip to show the real value (scientific at extremes).
    // Works for any price we can't know ahead of time.
    const dispCloses = points
      .map((p) => (inverted ? inv(p.close) : p.close))
      .filter((v) => Number.isFinite(v) && v > 0)
      .sort((a, b) => a - b);
    const ref =
      dispCloses.length > 0
        ? dispCloses[Math.floor(dispCloses.length / 2)]
        : Number.isFinite(currentPrice) && currentPrice > 0
          ? inverted
            ? currentPrice
            : inv(currentPrice)
          : 1;
    const scaleExp = ref > 0 && Number.isFinite(ref) ? -Math.floor(Math.log10(ref)) : 0;
    const scale = Math.pow(10, scaleExp);
    const real = (scaled: number) => scaled / scale;

    const chart: IChartApi = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: theme.muted,
        attributionLogo: false,
        // Without this the library falls back to its own -apple-system/Trebuchet
        // stack — a third typeface, on every axis label. See ChartTheme.mono.
        fontFamily: theme.mono,
      },
      // Labels un-scale back to the real price. `tickmarksPriceFormatter` sees
      // every visible tick at once → derives precision from the tick step so
      // adjacent ticks never collide (no blank axis); `priceFormatter` handles
      // the single last-value pill + crosshair label. Both format the real value
      // (scientific at the extremes).
      localization: {
        priceFormatter: (p: number) => axisPriceFormat(real(p)),
        tickmarksPriceFormatter: (prices: BarPrice[]) => axisTickFormat(prices.map((p) => real(p))),
      },
      grid: {
        vertLines: { color: theme.lineSoft },
        horzLines: { color: theme.lineSoft },
      },
      rightPriceScale: { borderColor: theme.line },
      // Hide the built-in time axis — we render month labels as HTML below.
      /*
       * Clamp panning/zooming to the DATA extent: a position's series runs from
       * the day it was opened to the day it closed (or to the latest snapshot
       * while it is still open). Without these, zooming out scrolls off into
       * empty canvas on both sides, which reads as "no data for this period"
       * for a period the position did not exist in.
       */
      timeScale: {
        visible: false,
        borderVisible: false,
        fixLeftEdge: true,
        fixRightEdge: true,
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: theme.muted, width: 1, style: LineStyle.Solid, labelBackgroundColor: theme.panel },
        horzLine: { color: theme.muted, width: 1, style: LineStyle.Solid, labelBackgroundColor: theme.panel },
      },
    });

    const series: ISeriesApi<"Candlestick"> = chart.addSeries(CandlestickSeries, {
      upColor: theme.green,
      downColor: theme.red,
      borderUpColor: theme.green,
      borderDownColor: theme.red,
      wickUpColor: theme.green,
      wickDownColor: theme.red,
      priceLineVisible: false,
    });

    const seen = new Set<number>();
    const candles: CandlestickData[] = [];
    for (const p of points) {
      if (!Number.isFinite(p.close) || p.close <= 0) continue;
      if (seen.has(p.t)) continue;
      seen.add(p.t);
      // Real (oriented) OHLC; inverting swaps high/low.
      const rb = inverted
        ? { open: inv(p.open), high: inv(p.low), low: inv(p.high), close: inv(p.close) }
        : { open: p.open, high: p.high, low: p.low, close: p.close };
      if (![rb.open, rb.high, rb.low, rb.close].every((v) => Number.isFinite(v) && v > 0)) {
        seen.delete(p.t);
        continue;
      }
      // Plot SCALED so the price scale sees normal-range numbers. The LWC-range
      // guard runs on the SCALED values (real values can be ~1e19 / ~1e-19 and
      // would all be dropped pre-scaling → empty chart); scaling brings them in.
      const sb = {
        open: rb.open * scale,
        high: rb.high * scale,
        low: rb.low * scale,
        close: rb.close * scale,
      };
      if (![sb.open, sb.high, sb.low, sb.close].every(inLwcRange)) {
        seen.delete(p.t);
        continue;
      }
      candles.push({ time: p.t as UTCTimestamp, ...sb });
    }
    candles.sort((a, b) => (a.time as number) - (b.time as number));

    // Drop outlier candles (bad subgraph OHLC) that wreck the price scale.
    let clean = candles;
    const closes = candles.map((c) => c.close).filter((v) => v > 0).sort((a, b) => a - b);
    if (closes.length) {
      const med = closes[Math.floor(closes.length / 2)];
      if (med > 0) {
        const within = candles.filter((c) =>
          [c.open, c.high, c.low, c.close].every((v) => v > 0 && v < med * 50 && v > med / 50),
        );
        if (within.length >= 2) clean = within;
      }
    }
    series.setData(clean);

    const rangeMax = inverted ? maxPrice : inv(minPrice);
    const rangeMin = inverted ? minPrice : inv(maxPrice);
    const cur = inverted ? currentPrice : inv(currentPrice);
    const lo = Math.min(rangeMin, rangeMax);
    const hi = Math.max(rangeMin, rangeMax);
    // Scaled range-line values (same space as the plotted candles).
    const loS = lo * scale;
    const hiS = hi * scale;
    const curS = cur * scale;

    // Derive the native tick step from the SCALED displayed range. Because the
    // values are normalised to ~[1,10), this is always a normal magnitude → the
    // engine can always emit several distinct ticks (no blank axis), for any
    // real price.
    const displayedScaled = [
      ...clean.flatMap((c) => [c.high, c.low]),
      loS,
      hiS,
      curS,
    ].filter((v) => Number.isFinite(v) && v > 0);
    const pf = deriveSeriesPriceFormat(displayedScaled);
    if (pf) series.applyOptions({ priceFormat: { type: "price", ...pf } });
    if (hi > 0 && inLwcRange(hiS))
      series.createPriceLine({ price: hiS, color: theme.muted, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "MAX" });
    if (lo > 0 && inLwcRange(loS))
      series.createPriceLine({ price: loS, color: theme.muted, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "MIN" });
    if (cur > 0 && inLwcRange(curS))
      series.createPriceLine({ price: curS, color: theme.green, lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: "current" });

    chart.timeScale().fitContent();

    const times = clean.map((c) => c.time as Time);
    const refreshAxis = () => setAxis(computeTimeAxis(chart, times));
    refreshAxis();
    chart.timeScale().subscribeVisibleLogicalRangeChange(refreshAxis);
    // autoSize measures width async — recompute label coordinates once the real
    // width (and any later resize) lands, else they'd be pinned to a width-0 map.
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => refreshAxis()) : null;
    ro?.observe(el);

    chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.point || param.point.x < 0 || param.point.y < 0 || !el || param.point.x > el.clientWidth || param.point.y > el.clientHeight) {
        setTooltip(null);
        return;
      }
      const bar = param.seriesData.get(series) as CandlestickData | undefined;
      if (!bar) {
        setTooltip(null);
        return;
      }
      setTooltip({ x: param.point.x, y: param.point.y, date: fmtDate(param.time as number), o: fmt(real(bar.open)), h: fmt(real(bar.high)), l: fmt(real(bar.low)), c: fmt(real(bar.close)) });
    });

    return () => {
      ro?.disconnect();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(refreshAxis);
      chart.remove();
      setTooltip(null);
      setAxis([]);
    };
  }, [points, inverted, token0Symbol, token1Symbol, minPrice, maxPrice, currentPrice]);

  const pair = inverted ? `${token1Symbol}/${token0Symbol}` : `${token0Symbol}/${token1Symbol}`;

  return (
    <>
      <div className="tvCanvas" ref={wrapRef}>
        {tooltip && (
          <div className="tvTooltip" style={{ left: Math.min(tooltip.x + 14, (wrapRef.current?.clientWidth ?? 0) - 170), top: Math.max(tooltip.y - 10, 8) }}>
            <div className="tvTooltipDate">{tooltip.date}</div>
            <div className="tvTooltipRow">O: {tooltip.o}</div>
            <div className="tvTooltipRow">H: {tooltip.h}</div>
            <div className="tvTooltipRow">L: {tooltip.l}</div>
            <div className="tvTooltipRow">C: {tooltip.c}</div>
            <div className="tvTooltipPair">{pair}</div>
          </div>
        )}
      </div>
      <div className="tvAxis">
        {axis.map((a, i) => (
          <span
            key={i}
            style={{
              left: a.x,
              // Edge ticks anchor inwards; the stylesheet's translateX(-50%)
              // would clip them against the chart box.
              transform:
                a.anchor === "start"
                  ? "none"
                  : a.anchor === "end"
                    ? "translateX(-100%)"
                    : "translateX(-50%)",
            }}
          >
            {a.label}
          </span>
        ))}
      </div>
    </>
  );
}
