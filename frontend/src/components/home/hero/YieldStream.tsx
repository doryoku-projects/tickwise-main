import { motion } from "motion/react";
import { rnd } from "./primitives";

/**
 * Capital → yield visualisation: fine particles rise through the core and
 * bloom outward, so the scene reads as "value is being generated right now".
 */
export function YieldStream({ reduce = false, count = 18 }: { reduce?: boolean; count?: number }) {
  const particles = Array.from({ length: count }, (_, i) => ({
    x: 42 + rnd(i, 31) * 16,
    delay: rnd(i, 32) * 9,
    duration: 6 + rnd(i, 33) * 6,
    drift: rnd(i, 34) * 26 - 13,
    size: 1.5 + rnd(i, 35) * 2,
    green: rnd(i, 36) > 0.55,
  }));

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      {/* upward liquidity column */}
      <div
        className="absolute left-1/2 top-1/2 h-[52%] w-[16%] -translate-x-1/2 -translate-y-1/2"
        style={{
          background:
            "linear-gradient(to top, transparent, color-mix(in oklab, var(--primary) 16%, transparent), transparent)",
          filter: "blur(14px)",
        }}
      />
      {particles.map((p, i) => (
        <motion.span
          key={i}
          className="absolute rounded-full"
          style={{
            left: `${p.x}%`,
            top: "68%",
            width: p.size,
            height: p.size,
            background: p.green ? "var(--success)" : "var(--primary-glow)",
            boxShadow: `0 0 8px 1px color-mix(in oklab, ${
              p.green ? "var(--success)" : "var(--primary-glow)"
            } 55%, transparent)`,
            willChange: "transform, opacity",
          }}
          animate={
            reduce
              ? { opacity: 0.3 }
              : {
                  y: [0, -170],
                  x: [0, p.drift],
                  opacity: [0, 0.95, 0.9, 0],
                  scale: [0.6, 1, 0.8],
                }
          }
          transition={{ duration: p.duration, delay: p.delay, repeat: Infinity, ease: "easeOut" }}
        />
      ))}
    </div>
  );
}
