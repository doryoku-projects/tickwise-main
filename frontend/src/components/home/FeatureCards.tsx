"use client";

import { motion, useReducedMotion } from "motion/react";
import { Gauge, Layers, Shield, Terminal, Zap } from "lucide-react";
import { seeded } from "./motion-primitives";

const items = [
  {
    icon: Zap,
    title: "Near-real-time",
    body: "Positions re-price about every 5 minutes. On-chain fee state refreshes roughly hourly on Ethereum.",
    viz: "pulse" as const,
  },
  {
    icon: Gauge,
    title: "Metered, not throttled to death",
    body: "Per-endpoint unit costs and monthly quotas. Every response carries X-Quota-* and X-RateLimit-* headers.",
    viz: "meter" as const,
  },
  {
    icon: Shield,
    title: "Two key types",
    body: "Server keys are 403’d from browsers. Browser keys ship with allowed-origin lists. Both explained in the docs.",
    viz: "keys" as const,
  },
  {
    icon: Layers,
    title: "One shape across chains",
    body: "The same JSON on Ethereum, Arbitrum and Avalanche. Add a chain with one query param.",
    viz: "layers" as const,
  },
  {
    icon: Terminal,
    title: "curl-first",
    body: "One header of auth. Every endpoint is copy-pasteable from the docs. No SDK required.",
    viz: "curl" as const,
  },
  {
    icon: Zap,
    title: "Honest about what we don’t do",
    body: "No fake uptime, no invented accuracy scores. See the coverage page for the true footprint.",
    viz: "honest" as const,
  },
];

function Viz({ kind, seed }: { kind: (typeof items)[number]["viz"]; seed: number }) {
  const reduce = useReducedMotion();
  if (kind === "meter")
    return (
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-2">
        <motion.div
          className="h-full bg-gradient-primary"
          initial={{ width: "12%" }}
          animate={reduce ? { width: "62%" } : { width: ["12%", "62%", "44%", "62%"] }}
          transition={{ duration: 9, repeat: Infinity, ease: "easeInOut" }}
        />
      </div>
    );
  if (kind === "keys")
    return (
      <div className="flex gap-1.5 font-mono text-[0.5625rem]">
        <span className="rounded border border-success/40 bg-success/10 px-1.5 py-0.5 text-success">
          server
        </span>
        <span className="rounded border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-primary-glow">
          browser
        </span>
      </div>
    );
  if (kind === "layers")
    return (
      <div className="flex items-center gap-2 font-mono text-[0.5625rem] text-muted-foreground">
        {["ethereum", "avalanche"].map((c, i) => (
          <motion.span
            key={c}
            className="rounded border border-border/60 bg-surface-2/60 px-1.5 py-0.5"
            animate={reduce ? undefined : { opacity: [0.5, 1, 0.5] }}
            transition={{ duration: 5, repeat: Infinity, delay: i * 2.5 }}
          >
            ?chain={c}
          </motion.span>
        ))}
      </div>
    );
  if (kind === "curl")
    return (
      <div className="font-mono text-[0.625rem] text-muted-foreground">KC-APIKey: kc_live_•••</div>
    );
  if (kind === "honest")
    return (
      <div className="flex gap-1.5 font-mono text-[0.5625rem] text-muted-foreground">
        <span className="rounded border border-border/60 px-1.5 py-0.5">no fake SLA</span>
        <span className="rounded border border-border/60 px-1.5 py-0.5">real footprint</span>
      </div>
    );
  return (
    <svg viewBox="0 0 100 20" className="h-5 w-full">
      <polyline
        points={Array.from(
          { length: 16 },
          (_, i) => `${((i / 15) * 100).toFixed(2)},${(18 - seeded(i, seed) * 14).toFixed(2)}`,
        ).join(" ")}
        fill="none"
        stroke="var(--success)"
        strokeWidth="1.4"
      />
    </svg>
  );
}

export function FeatureCards() {
  const reduce = useReducedMotion();
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {items.map((it, i) => (
        <motion.div
          key={it.title}
          initial={reduce ? false : { opacity: 0, y: 28, filter: "blur(10px)" }}
          whileInView={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          viewport={{ once: true, margin: "-10%" }}
          transition={{
            duration: 0.95,
            delay: (i % 3) * 0.1 + Math.floor(i / 3) * 0.06,
            ease: [0.16, 1, 0.3, 1],
          }}
          className="group relative overflow-hidden rounded-2xl border border-border/60 bg-surface/50 p-6 shadow-card backdrop-blur-xl transition-all duration-500 hover:-translate-y-1.5 hover:border-primary/45 hover:shadow-glow"
        >
          {/* animated border light */}
          <div className="pointer-events-none absolute inset-x-6 -top-px h-px bg-gradient-to-r from-transparent via-primary/60 to-transparent opacity-0 transition-opacity duration-500 group-hover:opacity-100" />
          <div
            className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-700 group-hover:opacity-100"
            style={{
              background:
                "radial-gradient(70% 50% at 50% 0%, color-mix(in oklab, var(--primary) 18%, transparent), transparent 70%)",
            }}
          />
          <div className="relative">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-border/60 bg-surface-2/60 transition-transform duration-500 group-hover:scale-110">
              <it.icon className="h-5 w-5 text-primary" />
            </span>
            <div className="mt-4 font-display text-lg font-semibold">{it.title}</div>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{it.body}</p>
            <div className="mt-5">
              <Viz kind={it.viz} seed={i + 2} />
            </div>
          </div>
        </motion.div>
      ))}
    </div>
  );
}
