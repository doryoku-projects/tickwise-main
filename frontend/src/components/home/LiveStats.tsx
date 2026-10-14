"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { motion, useInView, useReducedMotion } from "motion/react";
import { useRef } from "react";
import { Coins, Database, Layers, Timer, type LucideIcon } from "lucide-react";
import type { PublicStats } from "@/lib/site-data";
import { seeded } from "./motion-primitives";

function Counter({
  value,
  decimals = 0,
  prefix = "",
  suffix = "",
}: {
  value: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.1 });
  const reduce = useReducedMotion();
  const [v, setV] = useState(0);
  useEffect(() => {
    if (reduce) return setV(value);
    if (!inView) return;
    let raf = 0;
    const start = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - start) / 1800);
      setV(value * (1 - Math.pow(1 - p, 3)));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [inView, value, reduce]);
  return (
    <span ref={ref} className="tabular-nums">
      {prefix}
      {v.toLocaleString(undefined, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })}
      {suffix}
    </span>
  );
}

function MicroChart({ seed }: { seed: number }) {
  const pts = Array.from({ length: 20 }, (_, i) => seeded(i, seed));
  const d = pts
    .map((p, i) => `${((i / 19) * 100).toFixed(2)},${(24 - p * 18 - 2).toFixed(2)}`)
    .join(" ");
  return (
    <svg viewBox="0 0 100 24" className="h-full w-full">
      <polyline
        points={d}
        fill="none"
        stroke="var(--primary-glow)"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

type Stat = {
  icon: LucideIcon;
  label: string;
  value: number | null;
  prefix?: string;
  suffix?: string;
  decimals?: number;
};

/*
 * The four cards, and what is behind each one.
 *
 * The fourth card was "Chains live: 2". §8 prohibits a chain count outright, so
 * it is now TVL indexed — a real metric derivable from GET /v1/pools, and one the
 * hero already surfaces. Four cards either way, so the grid and the connection
 * lines drawn down from the hero scene are unchanged.
 *
 * The values arrive as a prop from the server component that owns this route,
 * and each card stands or falls on its own. Pools, positions and indexing lag
 * come from GET /v1/stats; TVL indexed has no endpoint behind it — the API
 * totals no corpus-wide TVL, and summing a page of /api/top-pools would
 * understate it while presenting itself as a total — so that one card reports
 * itself unmeasured while the other three show real figures. Withholding all
 * four because one cannot be measured would hide data we actually have.
 */
function statsFor(live: PublicStats | null): Stat[] {
  const tvl = live?.tvlIndexedUsd;
  return [
    { icon: Database, label: "Pools tracked", value: live?.poolsTracked ?? null },
    { icon: Layers, label: "Positions tracked", value: live?.positionsTracked ?? null },
    {
      icon: Timer,
      label: "Indexing lag",
      value: live?.indexingLagMinutes ?? null,
      prefix: "~",
      suffix: " min",
    },
    {
      icon: Coins,
      label: "TVL indexed",
      // Undefined rather than zero when the API has no corpus-wide TVL rollup:
      // `undefined / 1e9` is NaN, which would have rendered as "$NaNB".
      value: tvl === undefined ? null : tvl / 1e9,
      prefix: "$",
      suffix: "B",
      decimals: 2,
    },
  ];
}

export function LiveStats({ stats: live }: { stats: PublicStats | null }) {
  const reduce = useReducedMotion();
  const stats = statsFor(live);
  return (
    <div className="relative">
      {/* connection lines travelling down from the hero scene into the cards */}
      <svg
        aria-hidden
        viewBox="0 0 100 10"
        preserveAspectRatio="none"
        className="pointer-events-none absolute -top-10 left-0 h-10 w-full opacity-70"
      >
        <defs>
          <linearGradient id="stats-feed" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--primary)" stopOpacity="0" />
            <stop offset="100%" stopColor="var(--primary-glow)" stopOpacity="0.6" />
          </linearGradient>
        </defs>
        {[12.5, 37.5, 62.5, 87.5].map((x, i) => {
          const d = `M 50 0 Q ${(50 + x) / 2} 6 ${x} 10`;
          return (
            <g key={x}>
              <motion.path
                d={d}
                fill="none"
                stroke="url(#stats-feed)"
                strokeWidth="0.4"
                vectorEffect="non-scaling-stroke"
                initial={reduce ? false : { pathLength: 0 }}
                whileInView={{ pathLength: 1 }}
                viewport={{ once: true }}
                transition={{ duration: 1.1, delay: i * 0.1, ease: [0.16, 1, 0.3, 1] }}
              />
              {!reduce && (
                <circle r="0.6" fill="var(--primary-glow)">
                  <animateMotion
                    dur={`${2.6 + i * 0.4}s`}
                    begin={`${i * 0.5}s`}
                    repeatCount="indefinite"
                    path={d}
                  />
                  <animate
                    attributeName="opacity"
                    values="0;1;0"
                    dur={`${2.6 + i * 0.4}s`}
                    begin={`${i * 0.5}s`}
                    repeatCount="indefinite"
                  />
                </circle>
              )}
            </g>
          );
        })}
      </svg>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((s, i) => (
          <motion.div
            key={s.label}
            initial={reduce ? false : { opacity: 0, y: 24, filter: "blur(8px)" }}
            whileInView={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            viewport={{ once: true, margin: "-10%" }}
            transition={{ duration: 0.9, delay: i * 0.09, ease: [0.16, 1, 0.3, 1] }}
            className="group relative overflow-hidden rounded-2xl border border-border/60 bg-surface/50 p-5 shadow-card backdrop-blur-xl transition-all duration-500 hover:-translate-y-1 hover:border-primary/40"
          >
            <div
              className="pointer-events-none absolute -inset-px opacity-0 transition-opacity duration-500 group-hover:opacity-100"
              style={{
                background:
                  "radial-gradient(60% 60% at 50% 0%, color-mix(in oklab, var(--primary) 22%, transparent), transparent 70%)",
              }}
            />
            <div className="relative flex items-start justify-between">
              <s.icon className="h-5 w-5 text-primary transition-transform duration-700 group-hover:rotate-12" />
              {/* The pulsing green dot is the card's claim to be live. It only
                  earns that when there is a measured number under it. */}
              {s.value === null ? (
                <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
              ) : (
                <span className="h-1.5 w-1.5 animate-ping-slow rounded-full bg-success" />
              )}
            </div>
            <div className="relative mt-6 font-display text-3xl font-semibold tracking-tight md:text-4xl">
              {s.value === null ? (
                <span className="tabular-nums text-muted-foreground/50">—</span>
              ) : (
                <Counter
                  value={s.value}
                  prefix={s.prefix}
                  suffix={s.suffix}
                  decimals={s.decimals}
                />
              )}
            </div>
            <div className="relative mt-1 text-xs uppercase tracking-widest text-muted-foreground">
              {s.label}
            </div>
            <div className="relative mt-3 h-6 opacity-0 transition-opacity duration-500 group-hover:opacity-100">
              <MicroChart seed={i + 3} />
            </div>
          </motion.div>
        ))}
      </div>
      {/* Only when NOTHING resolved. A single unmeasured card says so on its own
          face with a dash; repeating it in a page-wide note would read as the
          whole section being down. */}
      {stats.every((s) => s.value === null) && (
        <p className="mt-4 text-center text-xs text-muted-foreground">
          Live counts are unavailable right now — we’d rather show nothing than a number we haven’t
          measured. See{" "}
          <Link href="/status" className="text-primary hover:underline">
            status
          </Link>
          .
        </p>
      )}
    </div>
  );
}
