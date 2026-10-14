"use client";

import { useEffect, useState } from "react";
import { useReducedMotion } from "motion/react";

// The pointer springs are hand-rolled (see ./spring). Re-exported here so the
// scene's import sites stay unchanged.
export { usePointer, usePointerStyle, mapRange, SpringValue } from "./spring";
export type { Pointer, SpringConfig } from "./spring";

/** Deterministic pseudo-random so SSR and client agree. */
export function rnd(i: number, salt = 1) {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453;
  return Math.round((x - Math.floor(x)) * 1e4) / 1e4;
}

export const EASE = [0.16, 1, 0.3, 1] as const;

/** True only after hydration — avoids SSR/client class mismatches. */
export function useHydrated() {
  const [h, setH] = useState(false);
  useEffect(() => setH(true), []);
  return h;
}

/** Reduced motion that is stable during SSR (always false until hydrated). */
export function useSafeReducedMotion() {
  const reduce = useReducedMotion();
  const hydrated = useHydrated();
  return hydrated ? !!reduce : false;
}
