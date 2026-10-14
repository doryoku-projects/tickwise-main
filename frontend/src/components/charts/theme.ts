// lightweight-charts asserts every value is within ±(Number.MAX_SAFE_INTEGER/100)
// ≈ ±9.0072e13. Degenerate pools / inverted ~0 prices can exceed this — values
// outside the range (or non-finite) must be dropped before setData / price lines.
export const LWC_MAX = 90071992547409;
export function inLwcRange(v: number): boolean {
  return Number.isFinite(v) && Math.abs(v) < LWC_MAX;
}

// Reads the dashboard's CSS custom properties off a live element so the
// TradingView charts match the active (light/dark) theme. lightweight-charts
// needs concrete color strings, not `var(--x)`.
export interface ChartTheme {
  text: string;
  muted: string;
  line: string;
  lineSoft: string;
  green: string;
  red: string;
  panel: string;
  /**
   * The monospace stack, as a concrete string for canvas/SVG.
   *
   * lightweight-charts defaults to its OWN stack
   * (`-apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu`) when
   * `layout.fontFamily` is absent, which put a THIRD typeface on screen beside
   * Sora and Manrope — visible on every axis label. Numeric axes want tabular
   * mono, so both charts pass this.
   */
  mono: string;
}

/**
 * Converts any CSS color the BROWSER understands into a form
 * **lightweight-charts** understands.
 *
 * WHY THIS EXISTS — a real outage, not a hypothetical. The design-system port
 * moved the palette to `oklch()`, and lightweight-charts' color parser only
 * handles `#hex` and `rgb()/rgba()` (grep its dist: zero occurrences of `oklch`,
 * `oklab` or `color-mix`). Handing it a token value threw
 * `Error: Failed to parse color: oklch(68% .03 265)` from inside the chart
 * constructor, and that throw is UNCAUGHT — so it did not merely blank a chart,
 * it unwound the React tree and took `/explore` down with a client-side
 * exception.
 *
 * HOW, and the trap in the obvious version: reading `ctx.fillStyle` back is NOT
 * a conversion. Per CSS Color 4 serialisation, Chrome accepts
 * `fillStyle = 'oklch(0.97 0.01 260)'` and returns that same oklch string — so a
 * setter/getter round-trip changes nothing and the chart still throws. Verified
 * in-browser; do not "simplify" this back to reading the getter.
 *
 * What does work is RASTERISING: paint the color into a 1x1 canvas and read the
 * pixel, which is unavoidably sRGB bytes. That handles any color the browser can
 * paint — oklch, color-mix, lab, hwb — without this file owning color math.
 *
 * Validity is a separate question, because an UNPARSEABLE value is *silently
 * ignored* by the setter (the property keeps its previous value), which would
 * paint the wrong color rather than error. Assigning a sentinel first turns that
 * silence into a detectable failure.
 */
const SENTINEL = '#010203';
let cachedCtx: CanvasRenderingContext2D | null | undefined;

function probeCtx(): CanvasRenderingContext2D | null {
  if (cachedCtx !== undefined) return cachedCtx;
  if (typeof document === 'undefined') {
    cachedCtx = null;
    return cachedCtx;
  }
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  // `willReadFrequently` because we read a pixel back per token (7 per chart
  // mount) — without it Chrome logs a Canvas2D readback warning and may keep the
  // surface GPU-side, making each getImageData a sync readback.
  cachedCtx = canvas.getContext('2d', { willReadFrequently: true });
  return cachedCtx;
}

export function toChartColor(value: string, fallback: string): string {
  const ctx = probeCtx();
  if (!ctx || !value) return fallback;
  try {
    ctx.fillStyle = SENTINEL;
    ctx.fillStyle = value;
    const echoed = ctx.fillStyle;
    // Still the sentinel => the browser rejected `value` => use the known-good hex.
    if (typeof echoed !== 'string' || echoed.toLowerCase() === SENTINEL) {
      if (process.env.NODE_ENV !== 'production') {
        // Not a crash any more, but it does mean a chart is off-theme, and it is
        // exactly the signal that went unnoticed when the palette moved to oklch.
        console.warn(
          `[charts] could not resolve "${value}" to sRGB; falling back to ${fallback}. ` +
            'lightweight-charts accepts only #hex and rgb()/rgba().',
        );
      }
      return fallback;
    }
    // Accepted. Rasterise to get actual sRGB bytes — the getter above would just
    // hand back oklch again (see the docblock).
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return a === 255
      ? `rgb(${r}, ${g}, ${b})`
      : `rgba(${r}, ${g}, ${b}, ${Number((a / 255).toFixed(3))})`;
  } catch {
    return fallback;
  }
}

/**
 * Scales the alpha of an already-resolved sRGB color.
 *
 * Replaces the previous `color-mix(in oklab, ... 50%, transparent)`, which was a
 * second unparseable form on the same code path. Doing the arithmetic here keeps
 * grid lines a step lighter than axis lines without depending on `color-mix`
 * being supported by canvas.
 */
export function withAlpha(srgb: string, factor: number): string {
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  const fn = /^rgba?\(([^)]+)\)$/i.exec(srgb);
  if (fn) {
    const parts = fn[1].split(/[,\s/]+/).filter(Boolean);
    const [r, g, b] = parts;
    const raw = parts[3] === undefined ? 1 : Number.parseFloat(parts[3]);
    const a = Number.isFinite(raw) ? raw : 1;
    return `rgba(${r}, ${g}, ${b}, ${clamp(a * factor)})`;
  }
  const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(srgb);
  if (hex) {
    const n = Number.parseInt(hex[1], 16);
    const a = hex[2] === undefined ? 1 : Number.parseInt(hex[2], 16) / 255;
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${clamp(a * factor)})`;
  }
  return srgb;
}

/**
 * Reads the DESIGN-SYSTEM tokens, not the legacy Tickwise ones, and resolves
 * every one to sRGB before it reaches lightweight-charts.
 *
 * This is the one place the cascade cannot help. `app.css`'s `tw-bridge` layer
 * re-paints legacy CLASS NAMES onto the design tokens, but these values are
 * read in JavaScript and handed to lightweight-charts as concrete strings — so
 * a chart kept rendering `#e9eaf2` text on a `#14151d` panel inside an
 * otherwise-converted page, and no amount of CSS could reach it. Every token
 * below is a `--color-*` from the design system, which resolves correctly in
 * both light and dark because the theme redefines them.
 *
 * `--color-success`/`--color-destructive` rather than the design's chart ramp:
 * these two are the gain/loss semantics on a price series, and they must stay
 * green and red rather than becoming two arbitrary categorical hues.
 *
 * INVARIANT: every field of the returned object is `#hex` or `rgb()/rgba()`.
 * There is no test runner in this package, so the invariant is held by
 * construction instead: every value passes through `toChartColor`, which cannot
 * return anything else, and the `fallback` literals below are hand-checked hex.
 * `toChartColor` also warns in dev when it has to fall back, so a token changing
 * to a format canvas cannot parse is visible rather than silent.
 */
export function readChartTheme(el: HTMLElement | null): ChartTheme {
  /*
   * The dark palette, PRE-RESOLVED to sRGB. These are the oklch design tokens
   * converted once (e.g. `oklch(0.68 0.03 265)` -> `#8f98ab`) rather than left as
   * oklch: this path is taken during SSR and before mount, where there is no
   * element to read from and no canvas to convert with, so an oklch literal here
   * would be handed straight to the chart and throw.
   */
  const fallback: ChartTheme = {
    text: '#f1f5fc',
    muted: '#8f98ab',
    line: 'rgba(40, 44, 66, 0.6)',
    lineSoft: 'rgba(40, 44, 66, 0.3)',
    green: '#22c373',
    red: '#f51b3d',
    panel: '#0d1021',
    // Mirrors --font-mono's tail; the real value is read from the element below.
    mono: "ui-monospace, SFMono-Regular, Menlo, monospace",
  };
  if (!el || typeof window === 'undefined') return fallback;
  const cs = window.getComputedStyle(el);
  const get = (name: string, dflt: string) =>
    toChartColor(cs.getPropertyValue(name).trim(), dflt);

  const line = get('--color-border', fallback.line);
  return {
    text: get('--color-foreground', fallback.text),
    muted: get('--color-muted-foreground', fallback.muted),
    line,
    // No dedicated softer border in the design set — derive one so grid lines
    // stay a step lighter than axis lines instead of collapsing onto them.
    lineSoft: withAlpha(line, 0.5),
    green: get('--color-success', fallback.green),
    red: get('--color-destructive', fallback.red),
    panel: get('--color-card', fallback.panel),
    // NOT via `get` — that runs `toChartColor`, which is for colours only.
    mono: cs.getPropertyValue('--font-mono').trim() || fallback.mono,
  };
}
