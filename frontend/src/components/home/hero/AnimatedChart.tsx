import { motion } from "motion/react";
import { rnd } from "./primitives";

/**
 * Continuous scrolling sparkline: two tiled copies of the same seeded series
 * translate left forever, so the line never appears to restart.
 */
export function AnimatedChart({
  seed = 1,
  color = "var(--primary-glow)",
  height = 34,
  duration = 14,
  fill = true,
  reduce = false,
}: {
  seed?: number;
  color?: string;
  height?: number;
  duration?: number;
  fill?: boolean;
  reduce?: boolean;
}) {
  const N = 24;
  const pts = Array.from({ length: N }, (_, i) => rnd(i, seed));
  const step = 100 / (N - 1);
  const toY = (p: number) => (28 - p * 22 - 2).toFixed(2);
  const series = (offset: number) =>
    pts.map((p, i) => `${(offset + i * step).toFixed(2)},${toY(p)}`).join(" ");
  const line = `${series(0)} ${series(100 + step)}`;

  return (
    <div className="relative overflow-hidden" style={{ height }}>
      <motion.svg
        viewBox="0 0 200 30"
        preserveAspectRatio="none"
        className="h-full"
        style={{ width: "200%", willChange: "transform" }}
        animate={reduce ? undefined : { x: ["0%", "-50%"] }}
        transition={{ duration, ease: "linear", repeat: Infinity }}
      >
        <defs>
          <linearGradient id={`chart-fill-${seed}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {fill && <polygon points={`0,30 ${line} 200,30`} fill={`url(#chart-fill-${seed})`} />}
        <polyline
          points={line}
          fill="none"
          stroke={color}
          strokeWidth="1.4"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </motion.svg>
    </div>
  );
}
