"use client";

import { useEffect, useRef, useState } from "react";
import {
  BaselineSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type BaselineData,
  type IChartApi,
  type ISeriesApi,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { ChartSeriesPoint } from "../../lib/api";
import { type AxisTick, computeTimeAxis } from "./axis";
import { inLwcRange, readChartTheme, withAlpha } from "./theme";

interface Tooltip {
  x: number;
  y: number;
  date: string;
  value: string;
}

export type SeriesKind = "currency" | "percent";

function fmtValue(v: number, kind: SeriesKind): string {
  if (!Number.isFinite(v)) return "-";
  if (kind === "percent") return `${v.toFixed(2)}%`;
  const sign = v < 0 ? "-" : "";
  const abs = Math.abs(v);
  return `${sign}$${abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtDate(t: number): string {
  return new Date(t * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * Chart for a backend-computed position series (PnL / Assets / APR / FeesAPR /
 * DivLoss). Crosshair value tooltip + native pan/zoom. The built-in time axis is
 * hidden; month labels are rendered as HTML below (see axis.ts).
 *
 * A BASELINE series split at zero, not an area series: the whole point of a PnL
 * chart is which side of zero you are on, and a single-colour area could only say
 * that via the final value's colour — a position that spent months underwater and
 * recovered rendered entirely green. Above zero is green, below is red, both fading
 * toward the baseline. For a series that never
 * crosses zero this is visually identical to the old area series.
 */
export default function SeriesAreaChart({
  points,
  kind,
}: {
  points: ChartSeriesPoint[];
  kind: SeriesKind;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const [axis, setAxis] = useState<AxisTick[]>([]);
  const [mint, setMint] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const theme = readChartTheme(el);

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
      grid: {
        vertLines: { color: theme.lineSoft },
        horzLines: { color: theme.lineSoft },
      },
      rightPriceScale: { borderColor: theme.line },
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
        mode: CrosshairMode.Magnet,
        vertLine: { color: theme.muted, width: 1, style: LineStyle.Solid, labelBackgroundColor: theme.panel },
        horzLine: { color: theme.muted, width: 1, style: LineStyle.Solid, labelBackgroundColor: theme.panel },
      },
    });

    /*
     * `fillColor1` is the edge FURTHEST from the baseline and `fillColor2` the edge
     * nearest it, for both halves — so the gradients have to be specified in
     * opposite orders to fade toward zero from each side.
     */
    const series: ISeriesApi<"Baseline"> = chart.addSeries(BaselineSeries, {
      baseValue: { type: "price", price: 0 },
      topLineColor: theme.green,
      topFillColor1: withAlpha(theme.green, 0.28),
      topFillColor2: withAlpha(theme.green, 0.02),
      bottomLineColor: theme.red,
      bottomFillColor1: withAlpha(theme.red, 0.02),
      bottomFillColor2: withAlpha(theme.red, 0.28),
      lineWidth: 2,
      priceLineVisible: false,
      crosshairMarkerVisible: true,
    });

    const seen = new Set<number>();
    const data: BaselineData[] = [];
    for (const p of points) {
      if (!inLwcRange(p.value) || seen.has(p.t)) continue;
      seen.add(p.t);
      data.push({ time: p.t as UTCTimestamp, value: p.value });
    }
    data.sort((a, b) => (a.time as number) - (b.time as number));
    series.setData(data);

    const hasNeg = data.some((d) => d.value < 0);
    const hasPos = data.some((d) => d.value > 0);
    if (hasNeg && hasPos) {
      series.createPriceLine({ price: 0, color: theme.line, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "" });
    }

    /*
     * "Mint" dot on the first point — every `positionSeries` starts at the mint, so
     * this anchors the curve to when the position actually opened instead of leaving
     * the reader to guess whether a flat lead-in is real history or padding. v5 moved
     * markers off the series object into `createSeriesMarkers`.
     *
     * The dot is a series marker but the LABEL is HTML. Marker text is centred on its
     * bar, and the mint is by definition the FIRST bar, which `fixLeftEdge` pins flush
     * to the left edge — so half the text fell outside the canvas and "Mint" rendered
     * as "int". Positioning it ourselves also lets it sit clear of the curve.
     */
    if (data.length) {
      createSeriesMarkers(series, [
        { time: data[0].time, position: "inBar", shape: "circle", color: theme.muted },
      ]);
    }

    chart.timeScale().fitContent();

    const times = data.map((d) => d.time as Time);
    const refreshAxis = () => {
      setAxis(computeTimeAxis(chart, times));
      const first = data[0];
      if (!first) {
        setMint(null);
        return;
      }
      const x = chart.timeScale().timeToCoordinate(first.time);
      const y = series.priceToCoordinate(first.value);
      // Either can be null when the point is scrolled out of view.
      setMint(x == null || y == null ? null : { x: Number(x), y: Number(y) });
    };
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
      const bar = param.seriesData.get(series) as BaselineData | undefined;
      if (!bar) {
        setTooltip(null);
        return;
      }
      setTooltip({ x: param.point.x, y: param.point.y, date: fmtDate(param.time as number), value: fmtValue(bar.value, kind) });
    });

    return () => {
      ro?.disconnect();
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(refreshAxis);
      chart.remove();
      setTooltip(null);
      setAxis([]);
      setMint(null);
    };
  }, [points, kind]);

  return (
    <>
      <div className="tvCanvas" ref={wrapRef}>
        {mint && <span className="tvMintLabel" style={{ left: mint.x + 9, top: mint.y - 20 }}>Mint</span>}
        {tooltip && (
          <div className="tvTooltip" style={{ left: Math.min(tooltip.x + 14, (wrapRef.current?.clientWidth ?? 0) - 150), top: Math.max(tooltip.y - 10, 8) }}>
            <div className="tvTooltipDate">{tooltip.date}</div>
            <div className="tvTooltipValue">{tooltip.value}</div>
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
