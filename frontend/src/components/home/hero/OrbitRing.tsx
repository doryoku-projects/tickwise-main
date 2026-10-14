import { motion } from "motion/react";
import { EASE } from "./primitives";

/** Concentric holographic rings orbiting the liquidity core. */
export function OrbitRing({
  size,
  duration = 40,
  reverse = false,
  dashed = false,
  opacity = 0.5,
  delay = 0,
  reduce = false,
}: {
  size: number;
  duration?: number;
  reverse?: boolean;
  dashed?: boolean;
  opacity?: number;
  delay?: number;
  reduce?: boolean;
}) {
  return (
    <motion.div
      className="absolute left-1/2 top-1/2 rounded-full border border-primary/25"
      style={{
        width: size,
        height: size,
        marginLeft: -size / 2,
        marginTop: -size / 2,
        borderStyle: dashed ? "dashed" : "solid",
        opacity,
        willChange: "transform",
      }}
      initial={reduce ? false : { scale: 0.6, opacity: 0 }}
      animate={
        reduce
          ? { scale: 1, opacity }
          : { scale: 1, opacity, rotate: reverse ? [0, -360] : [0, 360] }
      }
      transition={{
        scale: { duration: 1.4, delay, ease: EASE },
        opacity: { duration: 1.4, delay, ease: EASE },
        rotate: { duration, repeat: Infinity, ease: "linear" },
      }}
    >
      <span
        className="absolute h-1.5 w-1.5 rounded-full bg-primary-glow shadow-glow"
        style={{ top: -3, left: "50%", marginLeft: -3 }}
      />
    </motion.div>
  );
}
