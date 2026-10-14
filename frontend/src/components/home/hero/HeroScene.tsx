import { useRef } from "react";
import { motion, useScroll, useTransform } from "motion/react";
import { mapRange, rnd, usePointer, usePointerStyle, useSafeReducedMotion } from "./primitives";
import { YieldStream } from "./YieldStream";
import { PipelineArc } from "./PipelineArc";
import { FloatingMetricCard, MetricHeader } from "./FloatingMetricCard";
import { HolographicCore } from "./HolographicCore";
import { OrbitRing } from "./OrbitRing";
import { ConnectionLine } from "./ConnectionLine";
import { AnimatedChart } from "./AnimatedChart";
import { TokenNode } from "./TokenNode";
import { DataPulse } from "./DataPulse";
import { CountingValue } from "./CountingValue";
import type { PublicStats } from "@/lib/site-data";

/**
 * A hero panel's number: the measured value, eased up from zero, or an em-dash.
 *
 * `from` and `to` are deliberately the same value, and that is what keeps the
 * existing animation intact without touching CountingValue. Read its loop: for the
 * first 2200ms it renders `from * p` on a cubic ease-out — the intro ramp from zero
 * — and only afterwards does it oscillate on `from + (to - from) * eased`. With the
 * two equal, the ramp plays exactly as it always did and the trailing oscillation
 * evaluates to the value itself, so the number settles and stays put. `reduce` still
 * short-circuits to `to`.
 *
 * The oscillation had to go rather than be re-pointed at live data, because it was
 * the fabrication. A single measurement of "$4.81B" animated endlessly between 4.81
 * and 4.94 spends almost all of its time displaying a figure nobody measured — the
 * same §8 problem as the fixture it came from, just moving. One measurement is one
 * number.
 */
function Readout({
  value,
  decimals,
  prefix = "",
  suffix = "",
  duration,
  reduce,
}: {
  value: number | undefined;
  decimals: number;
  prefix?: string;
  suffix?: string;
  duration: number;
  reduce: boolean;
}) {
  if (value === undefined) {
    // Same placeholder the landing statistic cards use when unmeasured.
    return <span className="tabular-nums text-muted-foreground/50">—</span>;
  }
  return (
    <CountingValue
      from={value}
      to={value}
      decimals={decimals}
      prefix={prefix}
      suffix={suffix}
      duration={duration}
      reduce={reduce}
    />
  );
}

/**
 * The DeFi Intelligence Engine: a live holographic scene of floating
 * metric panels, chain nodes and data flow orbiting a liquidity core.
 *
 * Every figure on these panels used to be a literal — "$4.81B TVL indexed across
 * 1,284 v4 pools", "38,412 positions", "~38s indexing lag", an APR and a fee APR.
 * They now come from the same `getPublicStats()` the landing cards read, threaded
 * down from the server component in src/app/page.tsx, and each panel reports itself
 * unmeasured rather than inventing a figure. Nothing about the float, tilt,
 * parallax, scroll transform or entrance timing changed.
 */
export function HeroScene({ stats }: { stats: PublicStats | null }) {
  const reduce = useSafeReducedMotion();
  const pointer = usePointer();
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end start"] });

  // cinematic scroll: the camera pushes in slightly and layers separate
  const scrollScale = useTransform(scrollYProgress, [0, 1], [1, 1.14]);
  const scrollY = useTransform(scrollYProgress, [0, 1], [0, -70]);
  const scrollFade = useTransform(scrollYProgress, [0, 0.85], [1, 0.15]);

  // pointer-tracked lighting position, as CSS custom properties
  const glowRef = usePointerStyle<HTMLDivElement>(pointer, (el, x, y) => {
    el.style.setProperty("--gx", `${mapRange(x, -1, 1, 35, 65)}%`);
    el.style.setProperty("--gy", `${mapRange(y, -1, 1, 35, 65)}%`);
  });

  // whole-scene parallax
  const sceneRef = usePointerStyle<HTMLDivElement>(pointer, (el, x, y) => {
    const sceneX = mapRange(x, -1, 1, 10, -10);
    const sceneY = mapRange(y, -1, 1, 8, -8);
    el.style.transform = `translateX(${sceneX}px) translateY(${sceneY}px)`;
  });

  const pulses = Array.from({ length: 14 }, (_, i) => ({
    x: rnd(i, 11) * 100,
    y: rnd(i, 12) * 100,
    dx: rnd(i, 13) * 60 - 30,
    dy: rnd(i, 14) * 60 - 30,
    duration: 7 + rnd(i, 15) * 9,
    delay: rnd(i, 16) * 8,
    size: 2 + Math.round(rnd(i, 17) * 2),
  }));

  return (
    <motion.div
      ref={ref}
      {...pointer.bind}
      className="relative mx-auto aspect-[3/4.2] w-full max-w-[820px] select-none sm:aspect-[4/3.1] lg:aspect-[4/2.9]"
      style={{
        perspective: 1400,
        scale: reduce ? 1 : scrollScale,
        y: reduce ? 0 : scrollY,
        opacity: reduce ? 1 : scrollFade,
      }}
    >
      {/* pointer-tracked lighting */}
      <div
        ref={glowRef}
        aria-hidden
        className="pointer-events-none absolute -inset-16 rounded-[40%]"
        style={{
          background:
            "radial-gradient(38% 38% at var(--gx, 50%) var(--gy, 50%), color-mix(in oklab, var(--primary) 24%, transparent), transparent 70%)",
          filter: "blur(30px)",
        }}
      />

      <div ref={sceneRef} className="absolute inset-0" style={{ willChange: "transform" }}>
        {/* rings + core */}

        <OrbitRing size={520} duration={70} opacity={0.28} dashed delay={0.15} reduce={reduce} />
        <OrbitRing size={380} duration={48} reverse opacity={0.4} delay={0.3} reduce={reduce} />
        <OrbitRing size={250} duration={34} opacity={0.55} delay={0.45} reduce={reduce} />
        <YieldStream reduce={reduce} />
        <HolographicCore reduce={reduce} />
        <PipelineArc reduce={reduce} />

        {/* connection mesh */}
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 h-full w-full"
        >
          <ConnectionLine
            id="a"
            from={{ x: 18, y: 26 }}
            to={{ x: 50, y: 50 }}
            bend={10}
            delay={0.1}
            reduce={reduce}
          />
          <ConnectionLine
            id="b"
            from={{ x: 84, y: 20 }}
            to={{ x: 50, y: 50 }}
            bend={-8}
            delay={0.35}
            packets={2}
            reduce={reduce}
          />
          <ConnectionLine
            id="c"
            from={{ x: 14, y: 74 }}
            to={{ x: 50, y: 50 }}
            bend={-14}
            delay={0.6}
            reduce={reduce}
          />
          <ConnectionLine
            id="d"
            from={{ x: 86, y: 78 }}
            to={{ x: 50, y: 50 }}
            bend={12}
            delay={0.85}
            packets={2}
            reduce={reduce}
          />
          <ConnectionLine
            id="e"
            from={{ x: 50, y: 8 }}
            to={{ x: 50, y: 50 }}
            bend={16}
            delay={1.05}
            reduce={reduce}
          />
          <ConnectionLine
            id="f"
            from={{ x: 50, y: 50 }}
            to={{ x: 50, y: 96 }}
            bend={-16}
            delay={1.2}
            reduce={reduce}
          />
        </svg>

        {/* floating panels */}
        <FloatingMetricCard
          pointer={pointer}
          className="left-[0%] top-[8%] w-[46%] max-w-[240px]"
          depth={1.15}
          delay={0}
          duration={7.4}
          amplitude={11}
          rotate={3}
          reduce={reduce}
        >
          <MetricHeader
            label="APR · ETH/USDC 0.05%"
            badge={
              /* The pulsing green dot is this panel's claim to be live, so it only
                 earns it when there is a measured number under it. */
              stats?.aprEthUsdcPct === undefined ? (
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
              ) : (
                <span className="h-1.5 w-1.5 animate-ping-slow rounded-full bg-success" />
              )
            }
          />
          <div className="mt-2 font-display text-2xl font-semibold tracking-tight">
            <Readout
              value={stats?.aprEthUsdcPct}
              decimals={2}
              suffix="%"
              duration={6.5}
              reduce={reduce}
            />
          </div>
          <AnimatedChart seed={3} duration={16} height={36} reduce={reduce} />
        </FloatingMetricCard>

        <FloatingMetricCard
          pointer={pointer}
          className="right-[1%] top-[2%] w-[42%] max-w-[220px]"
          depth={0.8}
          delay={1}
          duration={9.1}
          amplitude={8}
          rotate={-2.4}
          reduce={reduce}
        >
          <MetricHeader label="TVL indexed" />
          <div className="mt-2 font-display text-2xl font-semibold tracking-tight">
            <Readout
              value={stats?.tvlIndexedUsd === undefined ? undefined : stats.tvlIndexedUsd / 1e9}
              decimals={2}
              prefix="$"
              suffix="B"
              duration={8}
              reduce={reduce}
            />
          </div>
          {/* The pool count keeps its line whether or not it has a number, so the
              panel's height is the same either way. Tested per FIELD rather than
              on `stats` as a whole: the response carries a pool count but no TVL
              rollup, so the two halves of this panel resolve independently. */}
          <div className="mt-1 text-[11px] text-muted-foreground">
            across {stats?.poolsTracked?.toLocaleString() ?? "—"} v4 pools
          </div>
        </FloatingMetricCard>

        <FloatingMetricCard
          pointer={pointer}
          className="left-[2%] bottom-[10%] w-[40%] max-w-[214px]"
          depth={0.95}
          delay={2}
          duration={8.3}
          amplitude={13}
          rotate={2.2}
          reduce={reduce}
        >
          <MetricHeader label="Yield · fee APR" />
          <div className="mt-2 font-display text-2xl font-semibold tracking-tight text-success">
            <Readout
              value={stats?.feeAprPct}
              decimals={2}
              suffix="%"
              duration={7}
              reduce={reduce}
            />
          </div>
          <AnimatedChart
            seed={7}
            color="var(--success)"
            duration={21}
            height={30}
            reduce={reduce}
          />
        </FloatingMetricCard>

        <FloatingMetricCard
          pointer={pointer}
          className="right-[0%] bottom-[6%] w-[44%] max-w-[236px]"
          depth={1.25}
          delay={3}
          duration={6.6}
          amplitude={9}
          rotate={-3}
          reduce={reduce}
        >
          <MetricHeader
            label="GET /v1/positions"
            badge={
              <span className="rounded-full border border-success/40 bg-success/10 px-1.5 text-[9px] text-success">
                200
              </span>
            }
          />
          {/* Wraps because neither child can give: this card is `w-[44%]`, which
              on a 375px screen is 121px of content box, and a seven-figure count
              at `text-2xl` (100px) plus the gap plus the label needs 166px. With
              the row locked to one line the label was pushed 30px past the card
              and 14px off the right of the screen — the only text on the landing
              page that was. On a narrow phone it now sits under the number. */}
          <div className="mt-2 flex flex-wrap items-end justify-between gap-x-3 gap-y-1">
            <div className="font-display text-2xl font-semibold tracking-tight">
              <Readout value={stats?.positionsTracked} decimals={0} duration={9} reduce={reduce} />
            </div>
            <div className="font-mono text-[10px] text-muted-foreground">positions</div>
          </div>
          <div className="mt-2 flex items-center gap-2 font-mono text-[10px] text-muted-foreground">
            {/* A response-time chip used to sit here. Removed: §8 bans latency
                numbers, and there is no monitoring to source a real one from. */}
            <span className="rounded border border-border/60 px-1">1 unit</span>
          </div>
        </FloatingMetricCard>

        <FloatingMetricCard
          pointer={pointer}
          className="left-1/2 top-[0%] hidden w-[32%] max-w-[176px] -translate-x-1/2 sm:block"
          depth={0.55}
          delay={4}
          duration={10.4}
          amplitude={7}
          rotate={1.6}
          reduce={reduce}
        >
          <MetricHeader label="Indexing lag" />
          <div className="mt-1.5 font-display text-lg font-semibold tracking-tight">
            {/* Minutes, not the seconds this used to print. The measurement we
                actually have is `indexingLagMinutes` — the same field the landing
                card renders as "~5 min" — and inventing a seconds figure from it
                would be the fabrication all over again. The `~` sits outside the
                readout so an unmeasured panel shows "—" rather than "~—". */}
            {stats?.indexingLagMinutes === undefined ? (
              <span className="tabular-nums text-muted-foreground/50">—</span>
            ) : (
              <>
                ~
                <Readout
                  value={stats.indexingLagMinutes}
                  decimals={0}
                  suffix=" min"
                  duration={5.5}
                  reduce={reduce}
                />
              </>
            )}
          </div>
        </FloatingMetricCard>

        <FloatingMetricCard
          pointer={pointer}
          className="left-1/2 bottom-[0%] hidden w-[38%] max-w-[210px] -translate-x-1/2 sm:block"
          depth={0.7}
          delay={5}
          duration={11.2}
          amplitude={6}
          rotate={-1.8}
          reduce={reduce}
        >
          <MetricHeader label="Pool metrics · 24h vol" />
          <div className="mt-1.5 font-display text-lg font-semibold tracking-tight">
            <Readout
              value={stats?.volume24hUsd === undefined ? undefined : stats.volume24hUsd / 1e6}
              decimals={1}
              prefix="$"
              suffix="M"
              duration={9.5}
              reduce={reduce}
            />
          </div>
          <AnimatedChart
            seed={12}
            color="var(--chart-5)"
            duration={26}
            height={26}
            fill={false}
            reduce={reduce}
          />
        </FloatingMetricCard>

        {/* chain nodes */}
        <TokenNode
          pointer={pointer}
          label="Ethereum"
          symbol="ETH"
          className="left-[2%] top-[38%] sm:top-[46%]"
          delay={0.15}
          duration={9.6}
          reduce={reduce}
        />
        <TokenNode
          pointer={pointer}
          label="Avalanche"
          symbol="AVX"
          className="right-[2%] top-[34%] sm:top-[40%]"
          delay={0.45}
          duration={8.2}
          reduce={reduce}
        />

        {/* free-floating data pulses */}
        {pulses.map((p, i) => (
          <DataPulse key={i} {...p} reduce={reduce} />
        ))}
      </div>
    </motion.div>
  );
}
