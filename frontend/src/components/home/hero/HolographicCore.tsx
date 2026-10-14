import { motion } from "motion/react";
import { EASE } from "./primitives";

/** Rotating latitude/longitude wireframe that reads as a glass sphere. */
function SphereWire({ reduce }: { reduce: boolean }) {
  return (
    <svg
      viewBox="0 0 100 100"
      className="absolute left-1/2 top-1/2 h-40 w-40 -translate-x-1/2 -translate-y-1/2 overflow-visible"
    >
      <circle
        cx="50"
        cy="50"
        r="34"
        fill="none"
        stroke="var(--primary)"
        strokeOpacity="0.35"
        strokeWidth="0.4"
      />
      {[8, 18, 27, 34].map((r, i) => (
        <ellipse
          key={`lat-${i}`}
          cx="50"
          cy="50"
          rx="34"
          ry={r * 0.55}
          fill="none"
          stroke="var(--primary-glow)"
          strokeOpacity={0.18}
          strokeWidth="0.35"
        />
      ))}
      {[0, 1, 2, 3].map((i) => (
        <motion.ellipse
          key={`lon-${i}`}
          cx="50"
          cy="50"
          rx={34}
          ry={34}
          fill="none"
          stroke="var(--primary-glow)"
          strokeOpacity={0.16}
          strokeWidth="0.35"
          style={{ transformOrigin: "50px 50px", willChange: "transform" }}
          animate={reduce ? { scaleX: 0.25 + i * 0.25 } : { scaleX: [0.06, 1, 0.06] }}
          transition={{ duration: 18, delay: i * 4.5, repeat: Infinity, ease: "easeInOut" }}
        />
      ))}
    </svg>
  );
}

/** Glowing liquidity core: layered pulses, refraction sheen, inner rotation. */
export function HolographicCore({ reduce = false }: { reduce?: boolean }) {
  return (
    <motion.div
      className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
      initial={reduce ? false : { opacity: 0, scale: 0.5 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 1.3, delay: 0.25, ease: EASE }}
    >
      {/* outer bloom */}
      <motion.div
        className="absolute left-1/2 top-1/2 h-64 w-64 -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{
          background:
            "radial-gradient(closest-side, color-mix(in oklab, var(--primary) 45%, transparent), transparent 70%)",
          filter: "blur(24px)",
          willChange: "transform, opacity",
        }}
        animate={reduce ? undefined : { scale: [1, 1.16, 1], opacity: [0.6, 0.95, 0.6] }}
        transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
      />

      <SphereWire reduce={reduce} />

      {/* scan sweep across the sphere */}
      {!reduce && (
        <motion.span
          className="absolute left-1/2 top-1/2 h-40 w-40 -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-full"
          style={{ maskImage: "radial-gradient(closest-side, #000 96%, transparent)" }}
        >
          <motion.span
            className="absolute inset-x-0 h-10"
            style={{
              background:
                "linear-gradient(to bottom, transparent, color-mix(in oklab, var(--primary-glow) 30%, transparent), transparent)",
              willChange: "transform",
            }}
            animate={{ y: ["-20%", "420%"] }}
            transition={{ duration: 6.5, repeat: Infinity, ease: "easeInOut" }}
          />
        </motion.span>
      )}

      {/* pulse ripple */}
      {!reduce &&
        [0, 1.6].map((d) => (
          <motion.span
            key={d}
            className="absolute left-1/2 top-1/2 h-24 w-24 -translate-x-1/2 -translate-y-1/2 rounded-full border border-primary/40"
            style={{ willChange: "transform, opacity" }}
            animate={{ scale: [0.7, 2.4], opacity: [0.55, 0] }}
            transition={{ duration: 4, delay: d, repeat: Infinity, ease: "easeOut" }}
          />
        ))}

      {/* orbiting validation nodes */}
      {!reduce &&
        [0, 1, 2].map((i) => (
          <motion.div
            key={`orb-${i}`}
            className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
            style={{
              width: 150 + i * 26,
              height: 150 + i * 26,
              marginLeft: -(75 + i * 13),
              marginTop: -(75 + i * 13),
              willChange: "transform",
            }}
            animate={{ rotate: i % 2 === 0 ? 360 : -360 }}
            transition={{ duration: 22 + i * 9, repeat: Infinity, ease: "linear" }}
          >
            <span
              className="absolute left-1/2 top-0 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-primary-glow"
              style={{
                boxShadow: "0 0 10px 2px color-mix(in oklab, var(--primary-glow) 60%, transparent)",
              }}
            />
          </motion.div>
        ))}

      {/* core body */}
      <motion.div
        className="relative grid h-24 w-24 place-items-center rounded-full border border-primary/50"
        style={{
          background:
            "conic-gradient(from 0deg, color-mix(in oklab, var(--primary) 70%, transparent), color-mix(in oklab, var(--chart-5) 55%, transparent), color-mix(in oklab, var(--primary-glow) 75%, transparent), color-mix(in oklab, var(--primary) 70%, transparent))",
          boxShadow: "var(--shadow-glow)",
          willChange: "transform",
        }}
        animate={reduce ? undefined : { rotate: 360 }}
        transition={{ duration: 26, repeat: Infinity, ease: "linear" }}
      >
        <div className="absolute inset-1.5 rounded-full bg-background/70 backdrop-blur-xl" />
        <motion.div
          className="absolute inset-3 rounded-full"
          style={{
            background:
              "radial-gradient(closest-side, color-mix(in oklab, var(--primary-glow) 60%, transparent), transparent 75%)",
          }}
          animate={reduce ? undefined : { opacity: [0.5, 1, 0.5], scale: [0.92, 1.05, 0.92] }}
          transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
        />
      </motion.div>
      <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-center">
        <div className="font-mono text-[0.5625rem] uppercase tracking-[0.22em] text-foreground/80">
          liquidity
        </div>
        <div className="font-display text-xs font-semibold tracking-tight text-foreground">
          core
        </div>
      </div>
    </motion.div>
  );
}
