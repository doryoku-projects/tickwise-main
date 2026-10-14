"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { PositionCharts } from "../../lib/api";

const PURPLE = "#8b5cf6";
const H = 250;
const PAD_L = 10;
const PAD_R = 10;
const PAD_T = 16;
// Two rows below the baseline: axis labels AND the MIN/MAX/current pills. At 34
// they shared one 14px band and the pills (painted later) hid the labels.
const PAD_B = 48;
const MIN_BARS = 5;
/*
 * Ceiling on bars held in the array. Only the VISIBLE slice is rendered, so this
 * bounds the fully-zoomed-out DOM, not the default view.
 */
const MAX_BARS = 1200;
/** How much wider than the default view the array runs, for zoom-out headroom. */
const ZOOM_HEADROOM = 4;

/*
 * Default visible half-width in BARS — a heuristic fitted to measurements on both a v4 and a
 * v3 position.
 *
 * It is a multiple of the POSITION's span, not a fixed price band: `spanBars` covers
 * tickLower..tickUpper plus the current tick if it sits outside them, and the 5/4,
 * 5/6, 5/8 steps tighten the padding as the current tick drifts further outside the
 * range. The clamp to 15 is what decides a narrow position: an 11-tick range would
 * otherwise get a 12-bar window. The inline chart uses `half` and the expanded chart `3 * half`;
 * this is the wide panel, so it uses 3x.
 */
function defaultHalfBars(spanBars: number, rangeBars: number): number {
  const ratio = rangeBars > 0 ? spanBars / rangeBars : 1;
  const half = ratio <= 2 ? (5 * spanBars) / 4 : ratio <= 3 ? (5 * spanBars) / 6 : (5 * spanBars) / 8;
  return clamp(half, 15, 2000);
}
/*
 * Zoom sensitivity, applied to the NORMALISED pixel delta as exp(delta * SENS).
 * One mouse notch (~100px) gives ~1.22x, i.e. the old fixed step; a trackpad's
 * ~2px nudge gives ~1.004x instead of that same full step, which is what made
 * two-finger zoom shoot past the target.
 */
const ZOOM_SENS = 0.002;
/** Pinch (ctrl+wheel) reports far smaller deltas than a wheel notch. */
const PINCH_SENS = 0.01;
/*
 * Bar heights are LOG-scaled, and this is load-bearing rather than cosmetic.
 *
 * Active liquidity spans orders of magnitude. On a real USDT/USDS position the
 * plateau is ~5.0e22 while every tick outside it — one lone full-range position —
 * is ~7.4e16: a 670,000x cliff. Linearly that outer band is 0.0003px tall, so the
 * chart looked like liquidity simply STOPPED at the position's own bounds. sqrt is
 * not enough either; it gives 0.23px (measured, not estimated). Log across the
 * magnitudes actually present, floored so the smallest non-empty bin still reads,
 * is what makes the extent of liquidity visible.
 *
 * LOG_FLOOR is the height of the smallest non-empty bin as a fraction of the plot.
 * Raise it toward 1 for a flatter, more uniform band (a more uniform look, at
 * the cost of hiding how much smaller the outer liquidity is); lower it to
 * emphasise the plateau. An EMPTY bin is still drawn at zero height, so "no
 * liquidity" and "a little liquidity" stay visually distinct.
 */
const LOG_FLOOR = 0.45;

/**
 * Active liquidity for a bin, or 0. `?? liquidityGross` covers the rollout window
 * only: a backend older than the `activeLiquidity` field would otherwise render
 * every bar flat. (It fires on `undefined`, not on a real 0.)
 */
function liqOf(t: Tick): number {
  const v = t.activeLiquidity ?? Number(t.liquidityGross);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

type Dist = PositionCharts["liquidityDistribution"];
type Tick = Dist["ticks"][number];

function fmtPrice(v: number, digits?: number): string {
  if (!Number.isFinite(v) || v <= 0) return "-";
  const abs = Math.abs(v);
  /*
   * Prefer PLAIN GROUPED DIGITS, and fall back to exponential only where digits
   * would carry no information: past 1e15 a double has no integer precision left
   * to show, and below 1e-9 every rendered digit would be a leading zero.
   *
   * The old thresholds (1e7 / 1e-6) were far too tight and turned ordinary prices
   * into "9.99e+11", which read as a rendering quirk and hid a real bug — the tick
   * prices arrived undecimalised. That is fixed at source now (`mapLiquidityTicks`
   * in the backend), so anything exponential here is genuinely extreme.
   */
  if (abs >= 1e15 || abs < 1e-9) return v.toExponential(3);
  /*
   * Precision comes from the AXIS STEP when the caller knows it, not from the
   * value's own magnitude. Magnitude made precision discontinuous across 1.0, so
   * `0.99924209` (8dp) could sit beside `1.00092` (5dp) on one axis.
   */
  const d = digits ?? (abs >= 1000 ? 2 : abs >= 1 ? 5 : 8);
  return v.toLocaleString("en-US", {
    minimumFractionDigits: Math.min(2, d),
    maximumFractionDigits: d,
  });
}

/** Decimals that actually separate two adjacent axis labels `step` apart. */
function priceDigitsFor(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 6;
  return clamp(Math.ceil(-Math.log10(step)) + 2, 2, 8);
}

/**
 * Tick index, for the TOOLTIP. The axis shows price; the tick is the
 * pool's own coordinate and stays available on hover.
 *
 * The axis briefly showed ticks instead of price, because undecimalised tick
 * prices rendered as `9.99e+11` and an axis of exponentials tells you nothing.
 * That was a backend bug (`mapLiquidityTicks` now decimal-adjusts at source), so
 * price is viable again — but the degenerate +/-887272 bounds still price at
 * ~1e26/1e-51, which is why they are excluded from the plotted array rather than
 * merely hidden.
 */
function fmtTick(t: number): string {
  return Number.isFinite(t) ? t.toLocaleString("en-US", { maximumFractionDigits: 0 }) : "-";
}

function fmtUsd(v: number): string {
  if (!Number.isFinite(v)) return "-";
  return `$${Math.round(v).toLocaleString()}`;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Liquidity-distribution histogram (bespoke SVG): one bar per tick, x-axis in
 * PRICE, position range bounded by purple MIN/MAX lines, the current pool tick
 * marked with a green line + price pill, per-bar hover tooltip. Supports
 * drag-to-pan and wheel-to-zoom over the tick range (lightweight-charts can't do
 * a price-axis histogram with vertical range lines, so this is hand-rolled).
 */
export default function LiquidityChart({
  dist,
  inverted,
  token0Symbol,
  token1Symbol,
  token0PriceUsd,
  token1PriceUsd,
  tickSpacing,
  showRange = true,
}: {
  dist: Dist;
  inverted: boolean;
  token0Symbol: string;
  token1Symbol: string;
  token0PriceUsd: number;
  token1PriceUsd: number;
  /**
   * Pool tick spacing. Gaps between initialised ticks are filled at this stride so
   * the histogram is contiguous (see the densify block) instead of showing holes
   * wherever no position bound happens to sit.
   */
  tickSpacing: number;
  // Positions have a min/max range (purple MIN/MAX lines + range-focused
  // default zoom). Pools don't — pass false to drop the bounds and open on the
  // full distribution (still freely zoom/pan-able).
  showRange?: boolean;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null); // global index
  // Colons are stripped: useId() yields ":r1:", and `url(#:r1:)` is brittle.
  const clipId = `liqclip${useId().replace(/:/g, "")}`;

  /*
   * DENSIFY TO TICK SPACING.
   *
   * The payload only contains INITIALISED ticks — ones where some position's
   * bound sits. An uninitialised tick has no entry, yet it still carries the
   * active liquidity of whatever range encloses it. Plotting the raw array
   * therefore drew ~6 irregular bars with gaps of 4, 8 and 9 ticks and read as a
   * spiky, half-empty chart, where a depth chart for the same position is a
   * contiguous band. Filling the gaps at `tickSpacing` and carrying liquidity
   * forward from the nearest initialised tick at or below reproduces that.
   *
   * The two degenerate boundary ticks (+/-887272, the full-range bound) are
   * excluded first. They sit 610k-1.1M ticks from the cluster, so with bars laid
   * out per index they used to squeeze the region you actually care about into a
   * couple of pixels. They are still reachable by zooming out.
   *
   * Capped at MAX_DENSE bars: tickSpacing 1 over a wide band would otherwise
   * generate hundreds of thousands of entries.
   */
  const sorted = useMemo<Tick[]>(() => {
    const spacing = Math.max(1, tickSpacing || 1);
    // The degenerate +/-887,272 bounds are dropped, not hidden: they price at ~1e26
    // and ~1e-51, which a PRICE axis cannot render.
    const real = [...dist.ticks]
      .filter((t) => Math.abs(t.tickIdx) < 887000)
      .sort((a, b) => a.tickIdx - b.tickIdx);
    if (real.length === 0) return [];

    const centreLo = showRange ? Math.min(dist.tickLower, dist.currentTick) : dist.currentTick;
    const centreHi = showRange ? Math.max(dist.tickUpper, dist.currentTick) : dist.currentTick;
    const spanBars = Math.max(Math.round((centreHi - centreLo) / spacing), 0);
    const rangeBars = showRange ? Math.max(Math.round((dist.tickUpper - dist.tickLower) / spacing), 0) : 0;
    const viewHalf = Math.ceil(defaultHalfBars(spanBars, rangeBars) * 3);
    // Centre: the top of the span, back off half of it.
    const centre = centreHi - Math.ceil(spanBars / 2) * spacing;
    const windowHalf = Math.min(viewHalf * ZOOM_HEADROOM, Math.floor(MAX_BARS / 2));
    const bandLo = centre - windowHalf * spacing;
    const bandHi = centre + windowHalf * spacing;
    /*
     * One bar per tickSpacing bucket — the usual granularity. Binning is
     * a fallback for the pathological case only (a position so wide that even the
     * default view exceeds MAX_BARS); a bin boundary must stay on the spacing grid or
     * an initialised tick's bucket splits across two bars.
     */
    const binTicks = Math.max(
      spacing,
      Math.ceil((bandHi - bandLo) / MAX_BARS / spacing) * spacing,
    );

    /*
     * One bar per bin, carrying active liquidity forward.
     *
     * The payload holds only INITIALISED ticks; an uninitialised tick still carries
     * the active liquidity of the range enclosing it, so `carried` walks forward and
     * fills the gaps. Within a bin we take the MAX rather than a mean: this pool's
     * plateau is 670,000x its surroundings and only 20 ticks wide, and averaging it
     * against neighbours would erase exactly the feature the chart is for.
     */
    const bins: Tick[] = [];
    let i = 0;
    let carried: Tick | null = null;
    while (i < real.length && real[i].tickIdx <= bandLo) {
      carried = real[i];
      i += 1;
    }
    const ref = carried ?? real[0];
    const binScale = binTicks / spacing;

    for (let lo = bandLo; lo <= bandHi; lo += binTicks) {
      const hi = lo + binTicks;
      let best: Tick | null = carried;
      let bestLiq = carried ? liqOf(carried) : 0;
      while (i < real.length && real[i].tickIdx < hi) {
        carried = real[i];
        const v = liqOf(carried);
        if (v >= bestLiq) {
          bestLiq = v;
          best = carried;
        }
        i += 1;
      }
      const src = best ?? ref;
      // Amounts rescale exactly by 1.0001^(dt/2) at equal L and spacing (see the
      // backend's tick math), then by `binScale` because a bin spans that many
      // single-tick bins — which is what makes the tooltip's USD comparable.
      const shift = Math.pow(1.0001, (lo - src.tickIdx) / 2);
      bins.push({
        ...src,
        tickIdx: lo,
        activeLiquidity: bestLiq,
        amount0: (src.amount0 / shift) * binScale,
        amount1: src.amount1 * shift * binScale,
        price0: src.price0 * Math.pow(1.0001, lo - src.tickIdx),
        price1: src.price1 / Math.pow(1.0001, lo - src.tickIdx),
      });
    }
    return bins;
  }, [dist.ticks, dist.tickLower, dist.tickUpper, dist.currentTick, tickSpacing, showRange]);
  // Ticks covered by one bar, for the tooltip's range label.
  const binTicks = sorted.length > 1 ? sorted[1].tickIdx - sorted[0].tickIdx : Math.max(1, tickSpacing || 1);

  const n = sorted.length;

  /*
   * Open on the WHOLE densified band, for positions as well as pools.
   *
   * It used to open on the position range +/-50%, which for an 11-tick range is a
   * 22-bar window — so the chart could not show "where does liquidity actually
   * end", the question it exists to answer. The band is range +/-40 spacings
   * minimum, i.e. ~92 bars here, which is a comfortable opening width.
   * Zoom in for detail.
   */
  const defaultView = useMemo(() => {
    if (n === 0) return { start: 0, end: 0 };
    /*
     * Open on the default window (see `defaultHalfBars`), centred in the array, NOT on
     * the whole array: the array runs ZOOM_HEADROOM x wider so there is somewhere to
     * zoom out TO. Opening on everything was a previous overshoot — it put the chart
     * at a zoom level meant for scrolling out, which made the 20-tick
     * concentration a 3-bar spike.
     */
    const mid = (n - 1) / 2;
    const half = Math.max(Math.floor((n - 1) / (2 * ZOOM_HEADROOM)), MIN_BARS);
    const start = clamp(Math.round(mid - half), 0, n - 1);
    const end = clamp(Math.round(mid + half), start, n - 1);
    return { start, end };
  }, [n]);

  const [view, setView] = useState(defaultView);
  const viewRef = useRef(view);
  const widthRef = useRef(0);
  useEffect(() => {
    setView(defaultView);
  }, [defaultView]);
  useEffect(() => {
    viewRef.current = view;
  }, [view]);
  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  // Measure width (crisp 1:1 SVG, no aspect distortion).
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
  }, []);

  const setVp = useCallback((v: { start: number; end: number }) => {
    viewRef.current = v;
    setView(v);
  }, []);

  // Wheel-to-zoom (native, non-passive so preventDefault works).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || n === 0) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const w = widthRef.current;
      const plotW = Math.max(w - PAD_L - PAD_R, 1);
      const { start, end } = viewRef.current;
      const span = end - start + 1;
      const slot = plotW / span;

      /*
       * Normalise to pixels first: deltaMode 1 = lines, 2 = pages. Firefox reports
       * lines, so its deltaY of 3 is the same physical gesture as Chrome's 100.
       */
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? H : 1;
      const dy = e.deltaY * unit;
      const dx = e.deltaX * unit;

      /*
       * Horizontal intent PANS. A two-finger sideways swipe and shift+wheel pan
       * everywhere else on the web; this used to swallow both and zoom instead.
       * ctrl+wheel is a pinch, so it always means zoom.
       */
      const panDelta = e.ctrlKey ? 0 : e.shiftKey ? dy : Math.abs(dx) > Math.abs(dy) ? dx : 0;
      if (panDelta !== 0) {
        const panned = clamp(start + panDelta / slot, 0, Math.max(0, n - span));
        setVp({ start: panned, end: panned + span - 1 });
        return;
      }

      /*
       * Zoom scales with delta MAGNITUDE, not merely its sign. The old flat
       * 1.25x/0.8x per event meant a trackpad — which fires a stream of 1-3px
       * events — applied a full 25% zoom per nudge.
       */
      const sens = e.ctrlKey ? PINCH_SENS : ZOOM_SENS;
      const newSpan = clamp(span * Math.exp(dy * sens), MIN_BARS, n);
      // Hold the tick under the cursor still, so zoom pulls toward the pointer.
      const rect = el.getBoundingClientRect();
      const frac = clamp((e.clientX - rect.left - PAD_L) / plotW, 0, 1);
      const anchor = start + frac * span;
      const newStart = clamp(anchor - frac * newSpan, 0, Math.max(0, n - newSpan));
      setVp({ start: newStart, end: newStart + newSpan - 1 });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [n, setVp]);

  // Drag-to-pan + hover.
  const dragRef = useRef<{ x: number; start: number; end: number } | null>(null);
  const slotRef = useRef(1);

  const onPointerDown = (e: React.PointerEvent) => {
    dragRef.current = { x: e.clientX, start: view.start, end: view.end };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    const slot = slotRef.current;
    if (drag) {
      const span = drag.end - drag.start + 1;
      /*
       * Fractional, deliberately unrounded. Snapping to whole bars meant nothing
       * moved until the cursor crossed half a slot (~15px at 24 bars in view) and
       * then the whole chart jumped a slot — sticky, then jumpy. Panning now moves per
       * pixel.
       */
      const newStart = clamp(drag.start - (e.clientX - drag.x) / slot, 0, Math.max(0, n - span));
      setVp({ start: newStart, end: newStart + span - 1 });
      setHover(null);
      return;
    }
    const rect = (e.currentTarget as Element).getBoundingClientRect();
    const gi = Math.round(view.start + (e.clientX - rect.left - PAD_L) / slot - 0.5);
    const lo = Math.max(0, Math.floor(view.start));
    const hi = Math.min(n - 1, Math.ceil(view.end));
    setHover(gi >= lo && gi <= hi ? gi : null);
  };
  const endDrag = () => {
    dragRef.current = null;
  };

  if (n === 0 || width <= 0) {
    return <div className="tvChart liqChart" ref={wrapRef} />;
  }

  /*
   * The viewport is FRACTIONAL (see the pan handler), so the render window is the
   * integer bars it overlaps — one partial bar can hang off each edge, which the
   * clip path below trims. Bar width comes from `span`, not the window length,
   * or a partial edge bar would compress every other bar.
   */
  const span = view.end - view.start + 1;
  const i0 = Math.max(0, Math.floor(view.start));
  const i1 = Math.min(n - 1, Math.ceil(view.end));
  const visible = sorted.slice(i0, i1 + 1);
  const m = visible.length;
  /*
   * Bar height = ACTIVE liquidity in the bin, not `liquidityGross`.
   *
   * Gross counts every position merely *bounded* at a tick, so plotting it drew
   * isolated spikes at range edges with near-nothing between — which is why three
   * rounds of tuning here never produced a readable chart. Active liquidity (running sum of
   * liquidityNet, computed backend-side) is the quantity actually earning fees
   * across each bin, and it draws the plateau.
   */
  const liqs = visible.map(liqOf);
  /*
   * Normalise against the VISIBLE WINDOW, which is what a depth chart should do — zoomed into a
   * region 670,000x below the plateau the bars still fill the plot, and that is only
   * possible if the scale follows the view. Array-wide normalisation was tried and is
   * worse here: it pins the whole outer band flat at LOG_FLOOR forever, so zooming in
   * reveals no structure at all. The cost is that heights re-scale when a pan brings
   * the plateau into or out of view; log scaling keeps that gentle.
   */
  let liqMin = Infinity;
  let liqMax = 0;
  for (const v of liqs) {
    if (v <= 0) continue; // an EMPTY bin is not a small bin; it stays at zero.
    if (v < liqMin) liqMin = v;
    if (v > liqMax) liqMax = v;
  }
  if (!Number.isFinite(liqMin)) liqMin = 0;
  const heightRatio = (v: number) => {
    if (!(v > 0) || !(liqMax > 0)) return 0;
    const lo = Math.log(liqMin > 0 ? liqMin : liqMax);
    const hi = Math.log(liqMax);
    // Everything in one magnitude → nothing to spread; draw them equal.
    if (!(hi > lo)) return 1;
    return LOG_FLOOR + (1 - LOG_FLOOR) * clamp((Math.log(v) - lo) / (hi - lo), 0, 1);
  };
  const plotW = Math.max(width - PAD_L - PAD_R, 1);
  const plotH = H - PAD_T - PAD_B;
  const slot = plotW / span;
  slotRef.current = slot;
  /*
   * Bars sit almost edge to edge — ~88% of their slot with a
   * hairline gutter, so the band reads as a distribution rather than a row of
   * separate columns. Still capped, or a 5-bar zoom paints two giant blocks.
   */
  const barW = clamp(slot * 0.88, 1, 72);
  const xOfLocal = (i: number) => PAD_L + (i0 + i - view.start + 0.5) * slot;

  // Markers by nearest tick within the visible window.
  const localOfTick = (tick: number): number | null => {
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < m; i++) {
      const d = Math.abs(visible[i].tickIdx - tick);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  };
  const lowerLocal = showRange && dist.tickLower >= visible[0].tickIdx && dist.tickLower <= visible[m - 1].tickIdx ? localOfTick(dist.tickLower) : null;
  const upperLocal = showRange && dist.tickUpper >= visible[0].tickIdx && dist.tickUpper <= visible[m - 1].tickIdx ? localOfTick(dist.tickUpper) : null;
  const curLocal = dist.currentTick >= visible[0].tickIdx && dist.currentTick <= visible[m - 1].tickIdx ? localOfTick(dist.currentTick) : null;

  /*
   * `price0` is token1-per-token0 in HUMAN units — the backend decimal-adjusts it
   * now, so no correction belongs here. The inverse direction is taken as the
   * reciprocal rather than reading `price1`, so both directions agree exactly.
   */
  const priceOf = (t: Tick) => {
    const p0 = t.price0;
    if (!inverted) return p0;
    return Number.isFinite(p0) && p0 > 0 ? 1 / p0 : p0;
  };
  const lockedFor = (t: Tick) => {
    if (t.tickIdx < dist.currentTick) return { symbol: token1Symbol, usd: t.amount1 * token1PriceUsd };
    return { symbol: token0Symbol, usd: t.amount0 * token0PriceUsd };
  };

  /*
   * Price at an ARBITRARY tick, extrapolated from a real bar by the same law the
   * backend uses (`price0 = 1.0001^tick x 10^(dec0-dec1)`). The current tick
   * usually has no bar of its own, and reading the NEAREST bar's price put the
   * pill up to half a tick-spacing out.
   */
  const priceAtTick = (tick: number): number | null => {
    const ref = sorted[0];
    if (!ref || !(ref.price0 > 0)) return null;
    const p0 = ref.price0 * Math.pow(1.0001, tick - ref.tickIdx);
    if (!inverted) return p0;
    return p0 > 0 ? 1 / p0 : null;
  };

  const labelCount = Math.min(5, m);
  const labels = Array.from({ length: labelCount }, (_, k) => {
    const i = Math.round((k / (labelCount - 1 || 1)) * (m - 1));
    return { x: xOfLocal(i), tick: visible[i].tickIdx, price: priceOf(visible[i]) };
  });
  // Digits from the label STEP, so adjacent labels are actually distinguishable.
  const priceDigits = priceDigitsFor(
    labels.length > 1 ? Math.abs(labels[1].price - labels[0].price) : 0,
  );

  /*
   * A range bound is a bin EDGE, not a bin centre: `tickLower` is the left edge of
   * its own bin and `tickUpper` the right edge of its own. Drawing both at centres
   * rendered the purple band a full slot narrower than the position, so one
   * in-range bar at each end appeared to sit outside the lines.
   */
  const lowerX = lowerLocal != null ? xOfLocal(lowerLocal) - slot / 2 : null;
  const upperX = upperLocal != null ? xOfLocal(upperLocal) + slot / 2 : null;
  const curX = curLocal != null ? xOfLocal(curLocal) : null;

  const ht = hover != null && hover >= i0 && hover <= i1 ? visible[hover - i0] : null;
  const hoverLocal = hover != null ? hover - i0 : null;
  const hoverLocked = ht ? lockedFor(ht) : null;
  const curPrice = priceAtTick(dist.currentTick);

  return (
    <div
      className="tvChart liqChart"
      ref={wrapRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerLeave={() => {
        endDrag();
        setHover(null);
      }}
      style={{ cursor: dragRef.current ? "grabbing" : "grab", touchAction: "none" }}
    >
      <svg width={width} height={H} viewBox={`0 0 ${width} ${H}`}>
        <defs>
          <clipPath id={clipId}>
            <rect x={PAD_L} y={PAD_T - 6} width={plotW} height={plotH + 7} />
          </clipPath>
        </defs>
        <g clipPath={`url(#${clipId})`}>
        {visible.map((t, i) => {
          const ratio = heightRatio(liqs[i]);
          const h = ratio * plotH;
          const inRange = !showRange || (t.tickIdx >= dist.tickLower && t.tickIdx <= dist.tickUpper);
          const isCur = i === curLocal;
          const fill = isCur
            ? "color-mix(in oklab, var(--green-soft) 55%, white)"
            : inRange
              ? "var(--green-soft)"
              : "color-mix(in oklab, var(--green-soft) 26%, transparent)";
          /*
           * Depth is encoded TWICE — height and saturation — so the shape of the
           * distribution survives at a glance even when one tick dwarfs the rest
           * and every other bar is only a few pixels tall. Floor at 0.45 so a
           * shallow tick stays visible rather than fading to the background.
           */
          const depth = liqs[i] > 0 ? 0.45 + 0.55 * (Number.isFinite(ratio) ? ratio : 0) : 0.25;
          const dimmed = hoverLocal != null && hoverLocal !== i;
          return (
            <rect
              key={t.tickIdx}
              x={xOfLocal(i) - barW / 2}
              y={PAD_T + plotH - h}
              width={barW}
              height={Math.max(h, 0)}
              style={{
                fill,
                opacity: (dimmed ? 0.45 : 1) * depth,
                stroke: isCur ? "var(--green-soft)" : "none",
                strokeWidth: isCur ? 1 : 0,
              }}
            />
          );
        })}

        {/* position range markers */}
        {[lowerX, upperX].map((x, k) =>
          x == null ? null : (
            <line
              key={k}
              x1={x}
              y1={PAD_T - 4}
              x2={x}
              y2={PAD_T + plotH}
              strokeWidth={1.5}
              style={{ stroke: PURPLE }}
            />
          ),
        )}

        {/* current-tick marker */}
        {curX != null && (
          <line
            x1={curX}
            y1={PAD_T - 4}
            x2={curX}
            y2={PAD_T + plotH}
            strokeWidth={1.5}
            strokeDasharray="3 2"
            style={{ stroke: "var(--green-soft)" }}
          />
        )}

        </g>

        {/* baseline */}
        <line
          x1={PAD_L}
          y1={PAD_T + plotH}
          x2={width - PAD_R}
          y2={PAD_T + plotH}
          strokeWidth={1}
          strokeDasharray="3 3"
          style={{ stroke: "var(--line)" }}
        />

        {/* x-axis PRICE labels (the tick index is on the tooltip — see fmtTick) */}
        {labels.map((l, i) => (
          <text
            key={i}
            x={clamp(l.x, 34, width - 34)}
            y={H - 14}
            textAnchor="middle"
            style={{ fill: "var(--tk-muted)", fontSize: 10, fontFamily: "var(--font-mono)" }}
          >
            {fmtPrice(l.price, priceDigits)}
          </text>
        ))}

        {/* MIN / MAX / current pills */}
        {lowerX != null && (
          <g>
            <rect x={clamp(lowerX, 16, width - 16) - 16} y={H - PAD_B + 8} width={32} height={14} rx={3} style={{ fill: PURPLE }} />
            <text x={clamp(lowerX, 16, width - 16)} y={H - PAD_B + 18} textAnchor="middle" style={{ fill: "#fff", fontSize: 9, fontFamily: "var(--font-mono)" }}>
              MIN
            </text>
          </g>
        )}
        {upperX != null && (
          <g>
            <rect x={clamp(upperX, 16, width - 16) - 16} y={H - PAD_B + 8} width={32} height={14} rx={3} style={{ fill: PURPLE }} />
            <text x={clamp(upperX, 16, width - 16)} y={H - PAD_B + 18} textAnchor="middle" style={{ fill: "#fff", fontSize: 9, fontFamily: "var(--font-mono)" }}>
              MAX
            </text>
          </g>
        )}
        {curX != null && curPrice != null && (
          <g>
            <rect
              x={clamp(curX, 38, width - 38) - 36}
              y={H - PAD_B + 8}
              width={72}
              height={14}
              rx={3}
              style={{ fill: "var(--green-soft)" }}
            />
            <text
              x={clamp(curX, 38, width - 38)}
              y={H - PAD_B + 18}
              textAnchor="middle"
              style={{ fill: "var(--tk-accent-ink, #04110a)", fontSize: 9, fontWeight: 700, fontFamily: "var(--font-mono)" }}
            >
              {fmtPrice(curPrice, priceDigits)}
            </text>
          </g>
        )}
      </svg>

      {ht && hoverLocked && hoverLocal != null && (
        <div
          className="tvTooltip"
          style={{ left: clamp(xOfLocal(hoverLocal) + 12, 4, width - 160), top: 10 }}
        >
          <div className="tvTooltipDate">
            Tick {fmtTick(ht.tickIdx)}
            {binTicks > 1 ? `\u2013${fmtTick(ht.tickIdx + binTicks - 1)}` : ""}
            {/* i0, not view.start: local indices are relative to the integer
                render window, and a fractional view.start never matched. */}
            {hover === (curLocal != null ? i0 + curLocal : -1) ? (
              <span className="liqCurBadge">Current</span>
            ) : null}
          </div>
          <div className="tvTooltipRow">Tick price</div>
          <div className="tvTooltipValue">{fmtPrice(priceOf(ht))}</div>
          <div className="tvTooltipPair">
            {inverted ? `${token1Symbol}/${token0Symbol}` : `${token0Symbol}/${token1Symbol}`}
          </div>
          <div className="tvTooltipLocked">
            {hoverLocked.symbol}: {fmtUsd(hoverLocked.usd)}
          </div>
        </div>
      )}
    </div>
  );
}
