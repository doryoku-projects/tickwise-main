import type { ReactNode } from "react";
import { motion } from "motion/react";
import { EASE, mapRange, usePointerStyle, type Pointer } from "./primitives";

/**
 * A holographic panel floating in the hero scene.
 * Outer layer = pointer parallax + tilt. Inner layer = endless float/breathe.
 */
export function FloatingMetricCard({
  pointer,
  depth = 1,
  delay = 0,
  duration = 7,
  amplitude = 10,
  rotate = 2,
  className = "",
  reduce = false,
  children,
}: {
  pointer: Pointer;
  depth?: number;
  delay?: number;
  duration?: number;
  amplitude?: number;
  rotate?: number;
  className?: string;
  reduce?: boolean;
  children: ReactNode;
}) {
  // Pointer parallax + tilt, written straight to the node on each spring
  // frame. Property order matches what motion serialized, which matters
  // once rotation and translation are composed.
  const ref = usePointerStyle<HTMLDivElement>(pointer, (el, x, y) => {
    const px = mapRange(x, -1, 1, -18 * depth, 18 * depth);
    const py = mapRange(y, -1, 1, -14 * depth, 14 * depth);
    const ry = mapRange(x, -1, 1, 8 * depth, -8 * depth);
    const rx = mapRange(y, -1, 1, -6 * depth, 6 * depth);
    el.style.transform = `perspective(1200px) translateX(${px}px) translateY(${py}px) rotateX(${rx}deg) rotateY(${ry}deg)`;
  });

  return (
    <div ref={ref} className={`absolute ${className}`} style={{ willChange: "transform" }}>
      <motion.div
        initial={reduce ? false : { opacity: 0, scale: 0.82, filter: "blur(10px)" }}
        animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
        transition={{ duration: 1.1, delay: 0.5 + delay * 0.12, ease: EASE }}
      >
        <motion.div
          animate={
            reduce
              ? undefined
              : {
                  y: [0, -amplitude, 0, amplitude * 0.6, 0],
                  rotate: [0, rotate, 0, -rotate * 0.6, 0],
                  scale: [1, 1.015, 1, 0.99, 1],
                }
          }
          transition={{ duration, delay: delay * 0.7, repeat: Infinity, ease: "easeInOut" }}
          style={{ willChange: "transform" }}
          className="rounded-2xl border border-border/60 bg-surface/40 p-3.5 shadow-card backdrop-blur-xl"
        >
          <div className="pointer-events-none absolute inset-x-3 -top-px h-px bg-gradient-to-r from-transparent via-primary/60 to-transparent" />
          {children}
        </motion.div>
      </motion.div>
    </div>
  );
}

export function MetricHeader({ label, badge }: { label: string; badge?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </span>
      {badge}
    </div>
  );
}
