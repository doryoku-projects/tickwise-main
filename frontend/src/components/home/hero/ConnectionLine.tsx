import { motion } from "motion/react";

export type Pt = { x: number; y: number };

/**
 * A drawn connection line (percentage viewBox 0-100) with a travelling
 * light pulse and optional data packet.
 */
export function ConnectionLine({
  from,
  to,
  bend = 12,
  delay = 0,
  duration = 3.6,
  packets = 1,
  reduce = false,
  id,
}: {
  from: Pt;
  to: Pt;
  bend?: number;
  delay?: number;
  duration?: number;
  packets?: number;
  reduce?: boolean;
  id: string;
}) {
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2 - bend;
  const d = `M ${from.x} ${from.y} Q ${mx} ${my} ${to.x} ${to.y}`;

  return (
    <>
      <defs>
        <linearGradient id={`grad-${id}`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.05" />
          <stop offset="50%" stopColor="var(--primary-glow)" stopOpacity="0.55" />
          <stop offset="100%" stopColor="var(--primary)" stopOpacity="0.05" />
        </linearGradient>
        <path id={`path-${id}`} d={d} />
      </defs>

      <motion.path
        d={d}
        fill="none"
        stroke={`url(#grad-${id})`}
        strokeWidth="0.35"
        vectorEffect="non-scaling-stroke"
        initial={reduce ? false : { pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: 1.2, delay: 0.4 + delay, ease: [0.16, 1, 0.3, 1] }}
      />

      {!reduce &&
        Array.from({ length: packets }, (_, i) => (
          <circle key={i} r="0.75" fill="var(--primary-glow)">
            <animateMotion
              dur={`${duration + i * 0.9}s`}
              begin={`${delay + i * 1.3}s`}
              repeatCount="indefinite"
              path={d}
              rotate="auto"
            />
            <animate
              attributeName="opacity"
              values="0;1;1;0"
              dur={`${duration + i * 0.9}s`}
              begin={`${delay + i * 1.3}s`}
              repeatCount="indefinite"
            />
          </circle>
        ))}
    </>
  );
}
