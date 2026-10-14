"use client";

import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";

import type { ChainMetrics, ChainMetricsMap } from "@/lib/site-data";

/*
 * No `latency` field, deliberately. The brief (§8) forbids showing any uptime,
 * SLA or latency number because there is no status monitoring behind it — a
 * figure here would be invented.
 *
 * The same rule caught this panel's own numbers. It used to carry `tvl: "$1.02B"`,
 * `pools: "4,820"` and `indexing: "~5 min"` per chain and render them under a
 * heading reading "Coverage — kept honest" — three measurements per chain, none of
 * them measured. They come from `getChainMetrics()` now, threaded down from the
 * server component, and each cell reports itself unmeasured on its own.
 *
 * What stays here is what isn't a measurement: which chains exist, whether each is
 * servable, and the x/y coordinates its node sits at. Those are product facts and
 * layout, so the graph draws identically whether or not any figure resolved.
 */
type Chain = {
  name: string;
  state: "live" | "indexed";
  x: number;
  y: number;
};

/**
 * Node positions around the hub, by index.
 *
 * The chains themselves are DERIVED from what the API reports rather than
 * listed here. The design source hard-coded four — Ethereum and Avalanche as
 * live, Arbitrum and Optimism as "indexed, not servable" — and the last two are
 * a claim about chains this deployment does not index at all. Only the layout
 * is fixed; which nodes exist comes from `/v1/chains`.
 */
const SLOTS: Array<{ x: number; y: number }> = [
  { x: 26, y: 30 },
  { x: 72, y: 26 },
  { x: 22, y: 74 },
  { x: 76, y: 72 },
];

/**
 * Where node `i` of `total` sits.
 *
 * The hand-placed slots are used whenever they cover the whole set, so three or
 * four chains draw exactly the graph they always have. Past that the nodes go
 * onto an even ring instead — this used to `.slice(0, SLOTS.length)`, which
 * meant a fifth chain was dropped from the graph without a trace. A chain we
 * serve and do not draw is the one thing this panel is not allowed to do.
 */
function slotFor(i: number, total: number): { x: number; y: number } {
  if (total <= SLOTS.length) return SLOTS[i];
  const angle = (i / total) * 2 * Math.PI - Math.PI / 2;
  return { x: 50 + 30 * Math.cos(angle), y: 50 + 32 * Math.sin(angle) };
}

function chainsFrom(metrics: ChainMetricsMap | null): Chain[] {
  if (!metrics) return [];
  const names = Object.keys(metrics);
  return names.map((name, i) => ({
    name,
    // Everything the API lists as a chain it serves is live by definition —
    // `/v1/chains` only reports an integration that is enabled.
    state: "live" as const,
    ...slotFor(i, names.length),
  }));
}

/** Matches the "$1.02B" / "$264M" forms this panel has always printed, with a
 *  thousands step so a small chain doesn't collapse to "$0M". */
function formatTvl(usd: number): string {
  if (usd >= 1e9) return `$${(usd / 1e9).toFixed(2)}B`;
  if (usd >= 1e6) return `$${(usd / 1e6).toFixed(1)}M`;
  if (usd >= 1e3) return `$${Math.round(usd / 1e3)}k`;
  return `$${Math.round(usd)}`;
}

const UNMEASURED = "—";

/**
 * The four figures each chain reports, each degrading to a dash on its own.
 *
 * One list, read by both the card and nothing else — but it is worth naming,
 * because it is the contract between the labels and the values and it used to
 * be a literal buried inside the render.
 */
function metricsOf(m: ChainMetrics | undefined): Array<[string, string]> {
  return [
    ["TVL", m?.tvlUsd === undefined ? UNMEASURED : formatTvl(m.tvlUsd)],
    ["Pools", m?.pools === undefined ? UNMEASURED : m.pools.toLocaleString()],
    [
      "Open positions",
      m?.activePositions === undefined ? UNMEASURED : m.activePositions.toLocaleString(),
    ],
    [
      "Indexing",
      /* Blocks, not minutes. "~0 min" on a chain with 1-second blocks reads as
         a rounding artefact rather than a measurement, and the indexer works in
         blocks anyway. */
      m?.lagBlocks === undefined
        ? UNMEASURED
        : m.lagBlocks === 0
          ? "at head"
          : `${m.lagBlocks.toLocaleString()} blocks`,
    ],
  ];
}

/**
 * Largest by TVL first, so the deployment's headline chain leads the list and a
 * chain that reported no TVL sorts last rather than jumping the queue.
 *
 * This is where the old `defaultChain` went. It existed to preselect one chain
 * for a panel that could only show one at a time; with every chain on screen
 * there is nothing to select, and the only part worth keeping was its answer to
 * "which chain should the reader see first".
 */
function byTvlDesc(metrics: ChainMetricsMap | null) {
  return (a: Chain, b: Chain) =>
    (metrics?.[b.name]?.tvlUsd ?? -1) - (metrics?.[a.name]?.tvlUsd ?? -1);
}

export function CoverageNetwork({ metrics }: { metrics: ChainMetricsMap | null }) {
  const reduce = useReducedMotion();
  const chains = chainsFrom(metrics);
  const listed = [...chains].sort(byTvlDesc(metrics));
  /*
   * Highlight only. Hovering a node used to be what REVEALED a chain's figures,
   * which put every chain but one behind a gesture that does not exist on a
   * touch screen; the list below now carries all of them. What is left is the
   * cross-reference — hover a node to light its row, hover a row to light its
   * node — so the graph and the list can be read against each other.
   */
  const [active, setActive] = useState<string | null>(null);

  return (
    <div className="relative overflow-hidden rounded-3xl border border-border/60 bg-surface/40 shadow-card backdrop-blur-xl">
      <div
        className="pointer-events-none absolute inset-0 transition-opacity duration-700"
        style={{
          /* Keyed off `active` before, which was never null once a chain was
             preselected — so this read 1 in every state the panel could reach.
             Tied to coverage now, which is what it always rendered as. */
          opacity: chains.length > 0 ? 1 : 0.35,
          background:
            "radial-gradient(50% 50% at 50% 50%, color-mix(in oklab, var(--primary) 20%, transparent), transparent 72%)",
        }}
      />
      <div className="relative border-b border-border/60 p-6 md:p-8">
        <div className="text-xs uppercase tracking-widest text-primary">Coverage — kept honest</div>
        <h2 className="mt-2 font-display text-3xl font-semibold tracking-tight md:text-4xl">
          What’s actually live today
        </h2>
      </div>

      <div className="relative grid gap-6 p-6 md:grid-cols-[1.15fr_1fr] md:p-8">
        {/* network */}
        <div className="relative aspect-[4/3] w-full">
          <svg viewBox="0 0 100 100" className="absolute inset-0 h-full w-full" fill="none">
            {chains.map((c) => {
              const on = active === c.name;
              return (
                <g key={c.name}>
                  <line
                    x1="50"
                    y1="50"
                    x2={c.x}
                    y2={c.y}
                    stroke={c.state === "live" ? "var(--primary-glow)" : "var(--border)"}
                    strokeWidth={on ? 0.8 : 0.4}
                    strokeDasharray={c.state === "live" ? undefined : "2 2"}
                    opacity={on ? 0.95 : 0.5}
                    className="transition-all duration-500"
                  />
                  {c.state === "live" && !reduce && (
                    <circle r="0.9" fill="var(--primary-glow)">
                      <animateMotion
                        dur="3.6s"
                        repeatCount="indefinite"
                        path={`M50,50 L${c.x},${c.y}`}
                      />
                    </circle>
                  )}
                </g>
              );
            })}
          </svg>

          {/* hub */}
          <motion.div
            /* Opaque, and no `backdrop-blur` of its own. The panel around it is
               already `backdrop-blur-xl`, so a second backdrop filter nested
               inside the first only re-blurs an blurred surface — it compounds
               into haze and costs a re-sample of the whole panel on every
               repaint. See the chain nodes below for the same fix. */
            className="absolute left-1/2 top-1/2 flex h-16 w-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-2xl border border-primary/40 bg-surface-2 font-mono text-[0.625rem] uppercase tracking-widest text-muted-foreground"
            animate={
              reduce
                ? undefined
                : {
                    boxShadow: [
                      "0 0 0 0 rgba(0,0,0,0)",
                      "var(--shadow-glow)",
                      "0 0 0 0 rgba(0,0,0,0)",
                    ],
                  }
            }
            transition={{ duration: 6, repeat: Infinity, ease: "easeInOut" }}
          >
            api
          </motion.div>

          {chains.map((c) => (
            <button
              key={c.name}
              onMouseEnter={() => setActive(c.name)}
              onMouseLeave={() => setActive(null)}
              onFocus={() => setActive(c.name)}
              onBlur={() => setActive(null)}
              /* `backdrop-blur` removed, background made opaque. This node was
                 the worst case of the nested-backdrop-filter problem: a
                 translucent, backdrop-blurred chip inside a backdrop-blurred
                 panel, which ALSO moves on hover. A transform on a
                 backdrop-filtered element forces its backdrop to be sampled
                 again mid-transition, and with a second filter above it the
                 result reads as the whole node going soft exactly while the
                 pointer is on it. Nothing was gained by the inner blur — what
                 sits behind these chips is the panel's own blurred surface. */
              className="absolute -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border/60 bg-surface-2 px-3 py-2 text-left text-xs transition-all duration-500 hover:-translate-y-[55%] hover:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              style={{ left: `${c.x}%`, top: `${c.y}%` }}
            >
              <span className="flex items-center gap-1.5 font-medium">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${c.state === "live" ? "bg-success animate-ping-slow" : "bg-muted-foreground/60"}`}
                />
                {c.name}
              </span>
            </button>
          ))}
        </div>

        {/*
         * EVERY CHAIN, AND A FIXED BOX TO PUT THEM IN.
         *
         * This half used to render one chain — whichever was hovered — so the
         * figures for every other chain existed but could not be read without a
         * mouse and a guess about which node to point at.
         *
         * The height is the reason for the absolute positioning at `md`. Left in
         * normal flow, the list would set the grid row's height, so each chain
         * added to the deployment would make the whole panel taller; pinned to
         * `inset-0` it contributes no height at all, the row stays exactly as
         * tall as the network graph beside it, and a longer list scrolls inside
         * a box whose size never changes. Below `md` the columns stack and there
         * is no graph to take the height from, so it flows normally under a cap.
         */}
        <div className="relative min-h-0 rounded-2xl border border-border/60 bg-background/40">
          {chains.length === 0 ? (
            <div className="flex h-full min-h-40 flex-col justify-center p-5 text-sm text-muted-foreground">
              <div className="font-display text-lg text-foreground">Coverage unavailable</div>
              <p className="mt-1">
                We can’t reach the API from here, so there is nothing to report — not even which
                chains we serve.
              </p>
            </div>
          ) : (
            <ul className="flex max-h-[28rem] flex-col gap-3 overflow-y-auto p-4 md:absolute md:inset-0 md:max-h-none">
              {/* Plain `li`, no per-row entrance. These rows live inside a
                  `backdrop-blur-xl` panel, and animating opacity or transform on
                  a backdrop-filtered element's children makes the browser
                  re-sample that filter across the whole panel on every frame.
                  The section already fades itself in; staggering the rows on top
                  of it bought a flourish nobody asked for at the cost of the
                  most expensive repaint on the page. */}
              {listed.map((c) => {
                const m = metrics?.[c.name];
                const on = active === c.name;
                return (
                  <li
                    key={c.name}
                    onMouseEnter={() => setActive(c.name)}
                    onMouseLeave={() => setActive(null)}
                    className={`shrink-0 rounded-xl border p-4 transition-colors duration-300 ${
                      on ? "border-primary/50 bg-surface-2" : "border-border/60 bg-surface/20"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-display text-lg font-semibold">{c.name}</span>
                      <span
                        className={`shrink-0 rounded-full px-2.5 py-1 text-xs ${
                          c.state === "live"
                            ? "border border-success/40 bg-success/10 text-success"
                            : "border border-border/60 bg-surface-2 text-muted-foreground"
                        }`}
                      >
                        {c.state === "live" ? "live" : "coming soon"}
                      </span>
                    </div>

                    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3">
                      {metricsOf(m).map(([k, v]) => (
                        <div key={k}>
                          <dt className="text-[0.625rem] uppercase tracking-widest text-muted-foreground">
                            {k}
                          </dt>
                          <dd className="mt-0.5 font-display text-base tabular-nums">{v}</dd>
                        </div>
                      ))}
                    </dl>

                    {/* The block pair under the grid — the raw evidence behind
                        the lag figure, for anyone who wants to check it. */}
                    {m?.chainHeadBlock !== undefined && (
                      <div className="mt-3 border-t border-border/60 pt-2.5 font-mono text-[0.625rem] text-muted-foreground">
                        head {m.chainHeadEstimated ? '~' : ''}
                        {m.chainHeadBlock.toLocaleString()}
                        {m.chainHeadEstimated ? ' (estimated)' : ''}
                        {m.indexedBlock !== undefined &&
                          ` · indexed ${m.indexedBlock.toLocaleString()}`}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
