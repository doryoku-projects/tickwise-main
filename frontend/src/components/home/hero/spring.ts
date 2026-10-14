"use client";

import { useEffect, useMemo, useRef } from "react";

export type SpringConfig = { stiffness: number; damping: number; mass: number };

/*
 * The analytical spring below is adapted from the `spring` generator in Motion
 * (https://github.com/motiondivision/motion), used under the MIT License:
 *
 *   The MIT License (MIT)
 *
 *   Copyright (c) 2024 Motion B.V.
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all
 *   copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *   SOFTWARE.
 */

/* ------------------------------------------------------------------ *
 * Analytical spring
 *
 * Ported from motion's `spring` generator (see `function spring` in
 * framer-motion/dist/framer-motion.dev.js) so the pointer springs behave
 * exactly as the `useSpring` they replace. The unit conventions are
 * motion's, not the obvious ones, and all three matter:
 *
 *   - `t` is in **milliseconds**
 *   - the undamped angular frequency is therefore **per millisecond**
 *     (`sqrt(k/m) / 1000`)
 *   - an incoming velocity is in **units per second** and is negated
 *     on the way in, because the closed form is written around
 *     `initialDelta = target - origin` and `target - envelope * (...)`
 *
 * Rest thresholds come from motion's `attachFollow`, which is what
 * `useSpring` actually uses — it overrides the granular defaults with
 * restDelta 0.001 / restSpeed 0.01.
 * ------------------------------------------------------------------ */

const REST_SPEED = 0.01;
const REST_DELTA = 0.001;

type Solver = {
  /** Position at `t` ms after the spring started. */
  position: (t: number) => number;
  /** Velocity at `t`, in units per millisecond. */
  velocity: (t: number) => number;
};

function createSolver(
  origin: number,
  target: number,
  velocityPerSecond: number,
  { stiffness, damping, mass }: SpringConfig,
): Solver {
  const initialVelocity = -velocityPerSecond / 1000;
  const initialDelta = target - origin;
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  const w0 = Math.sqrt(stiffness / mass) / 1000;

  if (zeta < 1) {
    // Underdamped — oscillates into place.
    const wd = w0 * Math.sqrt(1 - zeta * zeta);
    const A = (initialVelocity + zeta * w0 * initialDelta) / wd;
    const sinCoeff = zeta * w0 * A + initialDelta * wd;
    const cosCoeff = zeta * w0 * initialDelta - A * wd;
    return {
      position: (t) =>
        target -
        Math.exp(-zeta * w0 * t) * (A * Math.sin(wd * t) + initialDelta * Math.cos(wd * t)),
      velocity: (t) =>
        Math.exp(-zeta * w0 * t) * (sinCoeff * Math.sin(wd * t) + cosCoeff * Math.cos(wd * t)),
    };
  }

  if (zeta === 1) {
    // Critically damped.
    const C = initialVelocity + w0 * initialDelta;
    return {
      position: (t) => target - Math.exp(-w0 * t) * (initialDelta + C * t),
      velocity: (t) => Math.exp(-w0 * t) * (w0 * C * t - initialVelocity),
    };
  }

  // Overdamped — this is the branch both of this app's springs land in
  // (stiffness 60 / damping 20 gives zeta 1.67 at mass 0.6, 1.29 at mass 1).
  const wd = w0 * Math.sqrt(zeta * zeta - 1);
  const P = (initialVelocity + zeta * w0 * initialDelta) / wd;
  const sinhCoeff = zeta * w0 * P - initialDelta * wd;
  const coshCoeff = zeta * w0 * initialDelta - P * wd;
  return {
    position: (t) => {
      const envelope = Math.exp(-zeta * w0 * t);
      // sinh/cosh reach Infinity for large t; motion caps the argument at 300.
      const f = Math.min(wd * t, 300);
      return (
        target -
        (envelope *
          ((initialVelocity + zeta * w0 * initialDelta) * Math.sinh(f) +
            wd * initialDelta * Math.cosh(f))) /
          wd
      );
    },
    velocity: (t) => {
      const envelope = Math.exp(-zeta * w0 * t);
      const f = Math.min(wd * t, 300);
      return envelope * (sinhCoeff * Math.sinh(f) + coshCoeff * Math.cosh(f));
    },
  };
}

/* ------------------------------------------------------------------ *
 * One rAF loop for every live spring
 * ------------------------------------------------------------------ */

const running = new Set<SpringValue>();
let rafHandle = 0;

function tick(now: number) {
  rafHandle = 0;
  // Copy: stepping a spring can settle it and mutate the set.
  for (const spring of [...running]) spring.step(now);
  if (running.size) rafHandle = requestAnimationFrame(tick);
}

function ensureRunning() {
  if (!rafHandle && running.size) rafHandle = requestAnimationFrame(tick);
}

/**
 * A number that springs toward whatever it was last `set` to, and tells
 * subscribers on every frame it changes. Deliberately not React state —
 * pointer tracking at 60fps must not re-render, which is the same trade
 * motion's MotionValues made.
 */
export class SpringValue {
  private current: number;
  private target: number;
  private config: SpringConfig;
  private solver: Solver | null = null;
  // Latched when the target is set, not on the first frame — motion's
  // JSAnimation does the same (`this.startTime = now` in `play()`), so its
  // first tick already has a non-zero elapsed. Latching on the first tick
  // instead burns a whole frame at elapsed 0 and the spring visibly starts
  // late. `performance.now()` shares rAF's time origin, so the two are
  // directly comparable.
  private startTime = 0;
  private elapsed = 0;
  private listeners = new Set<(v: number) => void>();

  constructor(initial: number, config: SpringConfig) {
    this.current = initial;
    this.target = initial;
    this.config = config;
  }

  get() {
    return this.current;
  }

  subscribe(fn: (v: number) => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  set(target: number) {
    if (target === this.target) return;
    // Carry the in-flight velocity across the retarget rather than
    // restarting from rest, so redirecting mid-flight stays smooth.
    // motion reads the analytical velocity for exactly this reason.
    const velocity = this.solver ? this.solver.velocity(this.elapsed) * 1000 : 0;
    this.target = target;

    if (this.current === target) {
      this.solver = null;
      running.delete(this);
      return;
    }

    this.solver = createSolver(this.current, target, velocity, this.config);
    this.startTime = performance.now();
    this.elapsed = 0;
    running.add(this);
    ensureRunning();
  }

  /** Advance to `now`. Called by the shared frame loop. */
  step(now: number) {
    if (!this.solver) {
      running.delete(this);
      return;
    }
    this.elapsed = now - this.startTime;

    const value = this.solver.position(this.elapsed);
    const velocity = this.solver.velocity(this.elapsed) * 1000;
    const done = Math.abs(velocity) <= REST_SPEED && Math.abs(this.target - value) <= REST_DELTA;

    this.current = done ? this.target : value;
    if (done) {
      this.solver = null;
      running.delete(this);
    }
    for (const fn of this.listeners) fn(this.current);
  }

  destroy() {
    running.delete(this);
    this.listeners.clear();
  }
}

/** Linear map with the output clamped to `[outMin, outMax]`, as motion's `useTransform` does. */
export function mapRange(v: number, inMin: number, inMax: number, outMin: number, outMax: number) {
  const p = (v - inMin) / (inMax - inMin);
  return outMin + (p < 0 ? 0 : p > 1 ? 1 : p) * (outMax - outMin);
}

/* ------------------------------------------------------------------ *
 * Pointer tracking
 * ------------------------------------------------------------------ */

const POINTER_SPRING: SpringConfig = { stiffness: 60, damping: 20, mass: 0.6 };

export type Pointer = {
  /** -1 .. 1, spring-smoothed. */
  x: SpringValue;
  y: SpringValue;
  bind: {
    onMouseMove: (e: React.MouseEvent<HTMLElement>) => void;
    onMouseLeave: () => void;
  };
};

/** Normalized pointer position within an element, spring-smoothed. */
export function usePointer(): Pointer {
  const springs = useMemo(
    () => ({
      x: new SpringValue(0, POINTER_SPRING),
      y: new SpringValue(0, POINTER_SPRING),
    }),
    [],
  );

  useEffect(
    () => () => {
      springs.x.destroy();
      springs.y.destroy();
    },
    [springs],
  );

  return {
    x: springs.x,
    y: springs.y,
    bind: {
      onMouseMove: (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        springs.x.set(((e.clientX - r.left) / r.width) * 2 - 1);
        springs.y.set(((e.clientY - r.top) / r.height) * 2 - 1);
      },
      onMouseLeave: () => {
        springs.x.set(0);
        springs.y.set(0);
      },
    },
  };
}

/**
 * Write pointer-derived styles straight to a DOM node on every spring
 * frame. `apply` may be a fresh closure each render — only `pointer`
 * identity resubscribes.
 */
export function usePointerStyle<T extends HTMLElement>(
  pointer: Pointer,
  apply: (el: T, x: number, y: number) => void,
) {
  const ref = useRef<T | null>(null);
  const applyRef = useRef(apply);
  applyRef.current = apply;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // x and y notify separately within one frame; skip the duplicate.
    let lastX = NaN;
    let lastY = NaN;
    const run = () => {
      const x = pointer.x.get();
      const y = pointer.y.get();
      if (x === lastX && y === lastY) return;
      lastX = x;
      lastY = y;
      applyRef.current(el, x, y);
    };

    run();
    const offX = pointer.x.subscribe(run);
    const offY = pointer.y.subscribe(run);
    return () => {
      offX();
      offY();
    };
  }, [pointer]);

  return ref;
}
