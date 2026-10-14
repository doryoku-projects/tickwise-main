import { motion } from "motion/react";

/** A drifting light packet in free space (not bound to a path). */
export function DataPulse({
  x,
  y,
  dx,
  dy,
  duration,
  delay,
  size = 3,
  reduce = false,
}: {
  x: number;
  y: number;
  dx: number;
  dy: number;
  duration: number;
  delay: number;
  size?: number;
  reduce?: boolean;
}) {
  return (
    <motion.span
      className="absolute rounded-full bg-primary-glow"
      style={{
        left: `${x}%`,
        top: `${y}%`,
        width: size,
        height: size,
        boxShadow: "0 0 10px 2px color-mix(in oklab, var(--primary-glow) 55%, transparent)",
        willChange: "transform, opacity",
      }}
      animate={reduce ? { opacity: 0.35 } : { x: [0, dx, 0], y: [0, dy, 0], opacity: [0, 0.9, 0] }}
      transition={{ duration, delay, repeat: Infinity, ease: "easeInOut" }}
    />
  );
}
