"use client";

import { useSafeReducedMotion } from "./hero/primitives";
import { seeded } from "./motion-primitives";

const r = (n: number) => Math.round(n * 100) / 100;

/**
 * Operating-system-like environment behind the page: volumetric light,
 * perspective floor grid, light streaks, fog and drifting particles.
 */
export function AmbientBackground() {
  const reduce = useSafeReducedMotion();
  const stars = Array.from({ length: 46 }, (_, i) => ({
    left: r(seeded(i, 1) * 100),
    top: r(seeded(i, 2) * 100),
    size: r(1 + seeded(i, 3) * 1.6),
    delay: r(seeded(i, 4) * 12),
    dur: r(7 + seeded(i, 5) * 11),
  }));
  const streaks = Array.from({ length: 4 }, (_, i) => ({
    top: r(12 + seeded(i, 21) * 60),
    delay: r(seeded(i, 22) * 14),
    dur: r(14 + seeded(i, 23) * 12),
    w: r(24 + seeded(i, 24) * 26),
  }));

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <div className="absolute inset-0 bg-background" />

      {/* volumetric lights */}
      <div
        className={`ambient-orb absolute -top-[28vh] left-1/2 h-[85vh] w-[95vw] -translate-x-1/2 rounded-full ${reduce ? "" : "animate-drift-a"}`}
      />
      <div
        className={`ambient-orb-2 absolute top-[40vh] -left-[20vw] h-[60vh] w-[60vw] rounded-full ${reduce ? "" : "animate-drift-b"}`}
      />
      <div
        className={`ambient-orb-3 absolute top-[95vh] -right-[15vw] h-[55vh] w-[55vw] rounded-full ${reduce ? "" : "animate-drift-c"}`}
      />

      {/*
        Perspective floor grid.

        TWO elements where there was one, and the split is purely a rendering
        concern — the pixels are unchanged. The outer div keeps everything that
        defines the surface (the 3D transform, the mask, the opacity) and adds
        `overflow-hidden`; the inner div carries the tiling and does the moving.
        That is what lets the animation be a `transform` instead of a
        `background-position`, i.e. a composited layer instead of a full repaint
        of a masked, 3D-transformed surface every frame. `-inset-y-[96px]`
        oversizes the tiling by the exact travel distance so the slide never
        exposes an edge, and 96px is two whole 48px tiles so the pattern lands
        congruent with where it started. See the `grid-run` keyframes in app.css.
      */}
      <div className="absolute inset-x-0 bottom-0 h-[62vh] [perspective:640px] [perspective-origin:50%_0%]">
        <div className="absolute inset-0 origin-top overflow-hidden [transform:rotateX(72deg)_scale(2.4)] opacity-40 mask-fade-floor">
          <div
            className={`absolute inset-x-0 -inset-y-[96px] grid-lines ${reduce ? "" : "animate-grid-run"}`}
          />
        </div>
      </div>

      {/* upper depth grid — same two-element split, see above */}
      <div className="absolute inset-0 overflow-hidden opacity-[0.35] mask-fade">
        <div
          className={`absolute -inset-[48px] grid-lines ${reduce ? "" : "animate-grid-pan"}`}
        />
      </div>

      {/* light streaks */}
      {streaks.map((s, i) => (
        <span
          key={i}
          className={`absolute h-px bg-gradient-to-r from-transparent via-primary-glow/50 to-transparent ${reduce ? "opacity-10" : "animate-streak"}`}
          style={{
            top: `${s.top}%`,
            width: `${s.w}vw`,
            animationDelay: `${s.delay}s`,
            animationDuration: `${s.dur}s`,
          }}
        />
      ))}

      {/* soft particles */}
      {stars.map((s, i) => (
        <span
          key={i}
          className={`absolute rounded-full bg-foreground/50 ${reduce ? "opacity-20" : "animate-twinkle"}`}
          style={{
            left: `${s.left}%`,
            top: `${s.top}%`,
            width: `${s.size}px`,
            height: `${s.size}px`,
            animationDelay: `${s.delay}s`,
            animationDuration: `${s.dur}s`,
          }}
        />
      ))}

      {/* depth fog */}
      <div className="absolute inset-x-0 bottom-0 h-[45vh] bg-fog" />
      <div className="absolute inset-0 bg-vignette" />
    </div>
  );
}
