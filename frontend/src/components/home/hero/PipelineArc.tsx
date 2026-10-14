import { motion } from "motion/react";

/*
 * The fifth stage read "Rewards" until §8 was applied: rewards is one of the
 * four fields hardcoded to zero on the live path, and the spec forbids surfacing
 * it at all — a decorative label still implies we serve the data. "Fees" is the
 * truthful substitute; fee APR is real and already shown in /explore and on the
 * hero's yield card. Same five angles, so the arc geometry and the illumination
 * loop are untouched.
 */
const STAGES = [
  { label: "Capital in", angle: -90 },
  { label: "Indexed", angle: -18 },
  { label: "Strategy", angle: 54 },
  { label: "Yield", angle: 126 },
  { label: "Fees", angle: 198 },
];

/**
 * The value narrative rendered as an arc around the core:
 * capital in → indexed → strategy → yield → fees.
 * One stage illuminates at a time so the loop reads as a live pipeline.
 */
export function PipelineArc({
  radius = 132,
  reduce = false,
}: {
  radius?: number;
  reduce?: boolean;
}) {
  const cycle = STAGES.length * 1.8;

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute left-1/2 top-1/2 hidden -translate-x-1/2 -translate-y-1/2 sm:block"
    >
      {STAGES.map((s, i) => {
        const rad = (s.angle * Math.PI) / 180;
        const x = Math.cos(rad) * radius;
        const y = Math.sin(rad) * radius * 0.72;
        return (
          <motion.span
            key={s.label}
            className="absolute whitespace-nowrap rounded-full border border-primary/30 bg-surface/50 px-2 py-0.5 font-mono text-[0.5625rem] uppercase tracking-[0.18em] text-muted-foreground backdrop-blur-xl"
            style={{ left: x, top: y, translate: "-50% -50%", willChange: "opacity" }}
            animate={
              reduce
                ? { opacity: 0.6 }
                : {
                    opacity: [0.35, 1, 0.35],
                    color: [
                      "var(--muted-foreground)",
                      "var(--primary-glow)",
                      "var(--muted-foreground)",
                    ],
                    borderColor: [
                      "color-mix(in oklab, var(--primary) 30%, transparent)",
                      "color-mix(in oklab, var(--primary) 80%, transparent)",
                      "color-mix(in oklab, var(--primary) 30%, transparent)",
                    ],
                  }
            }
            transition={{
              duration: cycle,
              times: [0, 0.12, 0.3],
              delay: i * 1.8,
              repeat: Infinity,
              ease: "easeInOut",
            }}
          >
            {s.label}
          </motion.span>
        );
      })}
    </div>
  );
}
