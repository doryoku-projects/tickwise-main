import { useEffect, useRef, useState } from "react";

/**
 * A value that continuously eases from `from` to `to` and back,
 * so numbers always look live without ever restarting abruptly.
 */
export function CountingValue({
  from,
  to,
  decimals = 2,
  prefix = "",
  suffix = "",
  duration = 6,
  reduce = false,
}: {
  from: number;
  to: number;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  duration?: number;
  reduce?: boolean;
}) {
  const [v, setV] = useState(from);
  const raf = useRef(0);

  useEffect(() => {
    if (reduce) {
      setV(to);
      return;
    }
    const start = performance.now();
    // 2.2s intro ramp from 0, then endless ease in/out between from..to
    const intro = 2200;
    const period = duration * 1000;
    const tick = (t: number) => {
      const e = t - start;
      if (e < intro) {
        const p = 1 - Math.pow(1 - e / intro, 3);
        setV(from * p);
      } else {
        const phase = ((e - intro) % (period * 2)) / period;
        const k = phase < 1 ? phase : 2 - phase;
        const eased = k * k * (3 - 2 * k);
        setV(from + (to - from) * eased);
      }
      raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [from, to, duration, reduce]);

  return (
    <span className="tabular-nums">
      {prefix}
      {v.toLocaleString(undefined, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      })}
      {suffix}
    </span>
  );
}
