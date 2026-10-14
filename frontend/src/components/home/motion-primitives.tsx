"use client";

import { motion, type Variants } from "motion/react";
import { useSafeReducedMotion } from "./hero/primitives";
import type { ReactNode } from "react";

/** Deterministic pseudo-random so SSR and client agree. */
export function seeded(i: number, salt = 1) {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  // Round so SSR and client stringify identically (avoids hydration mismatch).
  return Math.round((x - Math.floor(x)) * 1e4) / 1e4;
}

export const EASE = [0.16, 1, 0.3, 1] as const;

/**
 * Section-level scroll reveal: fade + translate + blur + scale.
 * Children with `data-stagger` inherit the stagger timing via `RevealItem`.
 */
export function Reveal({
  children,
  className,
  delay = 0,
  y = 28,
  as = "div",
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  y?: number;
  as?: "div" | "section";
}) {
  const reduce = useSafeReducedMotion();
  const Comp = as === "section" ? motion.section : motion.div;
  return (
    <Comp
      className={className}
      initial={reduce ? false : { opacity: 0, y, filter: "blur(10px)", scale: 0.985 }}
      whileInView={{ opacity: 1, y: 0, filter: "blur(0px)", scale: 1 }}
      viewport={{ once: true, margin: "-12% 0px -8% 0px" }}
      transition={{ duration: 1.1, delay, ease: EASE }}
    >
      {children}
    </Comp>
  );
}

export const staggerParent: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.09, delayChildren: 0.05 } },
};

export const staggerChild: Variants = {
  hidden: { opacity: 0, y: 22, filter: "blur(8px)" },
  show: { opacity: 1, y: 0, filter: "blur(0px)", transition: { duration: 0.9, ease: EASE } },
};

export function StaggerGroup({ children, className }: { children: ReactNode; className?: string }) {
  const reduce = useSafeReducedMotion();
  return (
    <motion.div
      className={className}
      variants={staggerParent}
      initial={reduce ? false : "hidden"}
      whileInView="show"
      viewport={{ once: true, margin: "-10% 0px" }}
    >
      {children}
    </motion.div>
  );
}

export function StaggerItem({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div className={className} variants={staggerChild}>
      {children}
    </motion.div>
  );
}
