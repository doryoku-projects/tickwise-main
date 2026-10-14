"use client";

import { useEffect, useState } from "react";
import { motion, AnimatePresence, useInView, useReducedMotion } from "motion/react";
import { useRef } from "react";
import { QUICKSTART_BASE } from "@/lib/api";

/*
 * OUR HOST, OUR PARAMETER NAMES. Both of these came from the reference design
 * pointed at `api.tickwise.io` — which does not resolve — with `?chain=ethereum`;
 * the parameter is `chainId` and takes an integer (`1`, `43114`), see
 * /docs/endpoints/pools. `QUICKSTART_BASE` is the same origin the docs print.
 */
const POOLS_CODE = `const res = await fetch(
  "${QUICKSTART_BASE}/v1/pools?chainId=1&sort=tvl&limit=25",
  { headers: { "KC-APIKey": process.env.TICKWISE_API_KEY! } }
);
const { pools, pagination } = await res.json();`;

/*
 * Trimmed, but the KEYS are the ones `/v1/pools` actually returns —
 * `{ pools: [ { poolId, chainId, protocol, token0, token1, fee, metrics, … } ],
 * pagination: { page, limit, total, totalPages, hasMore } }`. It previously
 * invented a flat `chain`, a `pair` string, a top-level `apr` and a
 * `units_charged` field, none of which exist; the unit cost is a response
 * HEADER, and a landing page that shows a shape the API does not send is a
 * support ticket from the first person who codes against it.
 */
const POOLS_RES = `{
  "pools": [
    {
      "poolId": "0x8f2a…",
      "chainId": 1,
      "protocol": "uniswap-v4",
      "token0": { "symbol": "USDC" },
      "token1": { "symbol": "WETH" },
      "metrics": { "tvlUsd": 184920331, "feeApr": 18.6 }
    }
  ],
  "pagination": { "page": 1, "limit": 25, "total": 1284 }
}`;

/*
 * The positions.ts tab was a DECORATION until now — a `span` beside pools.ts
 * that could be clicked forever without changing a character. Two file names
 * over a single hard-coded snippet reads as "here is the other endpoint", so
 * the panel was promising a second example it did not have.
 *
 * The call is the one /docs/endpoints/positions prints verbatim, down to
 * `sort=apr`, so the landing page and the docs cannot teach two different
 * requests. Same rule as the pools tab for the response: trimmed, but every key
 * is one `/v1/positions` really returns — `positions[]` rows carry `rank`,
 * `positionId`, `tokenId`, `chainId`, `protocol`, `owner`, `poolId`, the range
 * (`tickLower`…`isActive`) and the nested `amounts`, `metrics`, `poolStats` and
 * `pricing` groups; `metrics` is where `apr` and `underlyingValueUsd` live.
 * The VALUES are illustrative, exactly as the pools sample's are.
 */
const POSITIONS_CODE = `const res = await fetch(
  "${QUICKSTART_BASE}/v1/positions?chainId=1&sort=apr&limit=25",
  { headers: { "KC-APIKey": process.env.TICKWISE_API_KEY! } }
);
const { positions, pagination } = await res.json();`;

const POSITIONS_RES = `{
  "positions": [
    {
      "positionId": "0x3c7d…",
      "chainId": 1,
      "protocol": "uniswap-v4",
      "owner": "0x9a41…",
      "poolId": "0x8f2a…",
      "isActive": true,
      "metrics": { "apr": 24.8, "underlyingValueUsd": 18422.51 }
    }
  ],
  "pagination": { "page": 1, "limit": 25, "total": 3187 }
}`;

type TabId = "pools" | "positions";

/**
 * The two examples, and the metering key each one is charged against.
 *
 * `routeKey` is here rather than in the caller because the unit badge has to
 * quote what THIS tab's call costs — `/v1/positions` and `/v1/pools` are priced
 * separately, and a panel that shows the pools cost above a positions response
 * is quoting the wrong number at the exact moment somebody is budgeting.
 */
const TABS: ReadonlyArray<{
  id: TabId;
  file: string;
  routeKey: string;
  code: string;
  response: string;
}> = [
  { id: "pools", file: "pools.ts", routeKey: "v1.pools.list", code: POOLS_CODE, response: POOLS_RES },
  {
    id: "positions",
    file: "positions.ts",
    routeKey: "v1.positions.list",
    code: POSITIONS_CODE,
    response: POSITIONS_RES,
  },
];

const tabOf = (id: TabId) => TABS.find((t) => t.id === id) ?? TABS[0];

/*
 * Shared between each live element and the invisible sizer that reserves its
 * height, so the two cannot drift apart and start reserving the wrong box.
 */
const CARET_CLASS =
  "ml-0.5 inline-block h-[1.05em] w-[0.4375rem] translate-y-[0.125rem] bg-primary-glow";
const GUTTER_CLASS = "w-4 select-none text-right text-muted-foreground/50";
const CODE_LINE_CLASS = "whitespace-pre-wrap break-all text-foreground/90";
const BADGE_ROW_CLASS = "mb-2 flex flex-wrap items-center gap-3 text-[0.6875rem]";
const OK_BADGE_CLASS =
  "rounded-full border border-success/40 bg-success/10 px-2 py-0.5 text-success";
/*
 * `max-h-56` used to cap this and it cut the last line of JSON in half — the
 * closing `"pagination"` row was sliced across the card's bottom edge. The
 * snippet is fourteen short lines and `pre` does not wrap, so its height is the
 * same at every width; there is nothing to cap. Long lines still scroll
 * sideways on a narrow screen.
 */
const RESPONSE_PRE_CLASS = "overflow-x-auto text-[0.75rem] text-foreground/75";

/**
 * Every pane lays its live content into the same grid cell as its sizer.
 *
 * `min-w-0` is load-bearing, not tidying. A grid item's `min-width` defaults to
 * `auto`, which floors it at its own min-content width — for a cell holding the
 * response `pre`, that is the longest JSON line. The floor beat the track, the
 * track pushed the card out to 487px inside a 375px phone, and because the card
 * root is `overflow-hidden` the excess was CLIPPED rather than scrollable: the
 * request URL and half the response were simply unreachable. Worse, this column
 * shares its grid track with the section's prose, so the heading and paragraph
 * beside it were dragged to 487px and cut off mid-sentence too.
 *
 * Zeroing the floor lets the track shrink to the viewport, which is what finally
 * lets the `overflow-x-auto` on the `pre` below do its job.
 */
const CELL = "col-start-1 row-start-1 min-w-0";

/** naive syntax colouring for the demo snippet */
function highlight(line: string) {
  const parts = line.split(/("[^"]*")/g);
  return parts.map((p, i) => {
    if (p.startsWith('"'))
      return (
        <span key={i} className="text-success">
          {p}
        </span>
      );
    return (
      <span key={i}>
        {p.split(/\b(const|await|fetch|process|env|return)\b/g).map((w, j) =>
          ["const", "await", "return"].includes(w) ? (
            <span key={j} className="text-primary-glow">
              {w}
            </span>
          ) : ["fetch", "process", "env"].includes(w) ? (
            <span key={j} className="text-chart-5">
              {w}
            </span>
          ) : (
            <span key={j}>{w}</span>
          ),
        )}
      </span>
    );
  });
}

export function QuickstartEditor({ units }: { units?: Partial<Record<TabId, number>> }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, margin: "-20%" });
  const reduce = useReducedMotion();
  const [tab, setTab] = useState<TabId>("pools");
  const [typed, setTyped] = useState(reduce ? POOLS_CODE : "");
  const [phase, setPhase] = useState<"idle" | "typing" | "running" | "done">(
    reduce ? "done" : "idle",
  );

  /*
   * The running type-out's cancel, reachable from the click handler.
   *
   * Without it, clicking positions.ts mid-type leaves the pools timers running
   * and they keep writing slices of the POOLS snippet into a pane now labelled
   * positions.ts — the two examples interleaving character by character.
   */
  const cancelTyping = useRef<(() => void) | null>(null);
  /* The type-out is the panel's entrance, not something to replay on every
     click. `inView` is already `once: true`; this guards the second run that a
     re-render of the effect's deps would otherwise start. */
  const typedOnce = useRef(false);

  useEffect(() => {
    if (reduce || !inView || typedOnce.current) return;
    typedOnce.current = true;
    let i = 0;
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const stop = () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
    cancelTyping.current = stop;
    setPhase("typing");
    const type = () => {
      if (cancelled) return;
      i += 1;
      setTyped(POOLS_CODE.slice(0, i));
      if (i < POOLS_CODE.length) timers.push(setTimeout(type, 16));
      else {
        timers.push(
          setTimeout(() => {
            setPhase("running");
            timers.push(setTimeout(() => setPhase("done"), 1200));
          }, 500),
        );
      }
    };
    timers.push(setTimeout(type, 300));
    return stop;
  }, [inView, reduce]);

  /*
   * A click is a question — "what does the other endpoint return?" — so it gets
   * the answer, not three seconds of re-typing the reader did not ask for. The
   * entrance animation still plays once, on the first scroll into view.
   */
  const selectTab = (id: TabId) => {
    if (id === tab) return;
    /*
     * Both of these, and the second one matters even when nothing is typing.
     * `cancelTyping` stops a run already in flight; setting `typedOnce` retires
     * the entrance that has NOT started yet. On a tall screen this card can be
     * clicked before it crosses the `-20%` margin that arms `useInView`, and
     * without this the reveal fires afterwards and types the POOLS snippet into
     * a pane the reader had just switched to positions.ts.
     */
    cancelTyping.current?.();
    typedOnce.current = true;
    setTab(id);
    setTyped(tabOf(id).code);
    setPhase("done");
  };

  const current = tabOf(tab);
  const currentUnits = units?.[tab];
  const lines = typed.split("\n");

  return (
    <div
      ref={ref}
      className="overflow-hidden rounded-2xl border border-border/70 bg-surface/50 shadow-card backdrop-blur-xl"
    >
      <div className="flex items-center justify-between border-b border-border/60 px-4 py-2">
        <div className="flex gap-1.5">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={t.id === tab}
              onClick={() => selectTab(t.id)}
              className={`rounded-md px-2.5 py-1 font-mono text-[0.6875rem] transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none ${
                t.id === tab
                  ? "bg-surface-2 text-foreground"
                  : "text-muted-foreground hover:bg-surface-2/60 hover:text-foreground"
              }`}
            >
              {t.file}
            </button>
          ))}
        </div>
        <span className="font-mono text-[0.625rem] uppercase tracking-[0.2em] text-muted-foreground">
          node 22
        </span>
      </div>

      {/*
       * BOTH PANES ARE AS TALL AS THEY WILL EVER BE, FROM FIRST PAINT.
       *
       * This card used to grow from 148px to 482px as its animation ran — the
       * code pane one line at a time as the snippet typed (53→135px), then the
       * output pane all at once when the response replaced the status line
       * (50→302px). It is the taller column of an `lg:items-center` grid, so the
       * section went 446→683px and everything below the quickstart was shoved
       * down 237px. Worse than the hero's loop, in one way: `useInView` fires
       * this exactly once, as the reader scrolls it into view, so the jump lands
       * under their eyes at the moment they arrive.
       *
       * Each pane now holds an invisible sizer built from the same markup as the
       * live content — the full snippet for the code pane, the finished response
       * for the output pane — sharing one grid cell with it. A `min-h` guess
       * cannot do this: the snippet rewraps as the column narrows, so the number
       * would be wrong at every width but one.
       */}
      <div className="grid font-mono text-[12.5px] leading-relaxed">
        {/* Each pane is itself a grid item, so it needs the same `min-w-0`
            floor-removal its cells do — otherwise it re-inflates the card from
            one level up and the cells' own `min-w-0` achieves nothing. */}
        <div className="grid min-w-0 p-4">
          {/* One sizer PER TAB, all in the same cell, so the pane reserves the
              taller of the two snippets and switching tabs cannot resize the
              card either — `/v1/positions?…&sort=apr` is four characters longer
              than the pools call and wraps onto an extra line before it does.
              The caret is part of each: it is still on screen when the last
              character has been typed, and that is where it could wrap. */}
          {TABS.map((t) => {
            const codeLines = t.code.split("\n");
            return (
              <div key={t.id} aria-hidden className={`${CELL} invisible`}>
                {codeLines.map((l, i) => (
                  <div key={i} className="flex gap-4">
                    <span className={GUTTER_CLASS}>{i + 1}</span>
                    <span className={CODE_LINE_CLASS}>
                      {l}
                      {i === codeLines.length - 1 && <span className={CARET_CLASS} />}
                    </span>
                  </div>
                ))}
              </div>
            );
          })}

          <div className={`${CELL} h-fit`}>
            {lines.map((l, i) => (
              <div key={i} className="flex gap-4">
                <span className={GUTTER_CLASS}>{i + 1}</span>
                <span className={CODE_LINE_CLASS}>
                  {highlight(l)}
                  {phase === "typing" && i === lines.length - 1 && (
                    <span className={`${CARET_CLASS} animate-caret`} />
                  )}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="grid min-w-0 border-t border-border/60 bg-background/50 p-4">
          {/* Again one per tab in a shared cell: the two responses are different
              lengths, so the pane has to hold the taller of them or clicking a
              tab would resize the card. */}
          {TABS.map((t) => {
            const u = units?.[t.id];
            return (
              <div key={t.id} aria-hidden className={`${CELL} invisible`}>
                <div className={BADGE_ROW_CLASS}>
                  <span className={OK_BADGE_CLASS}>200 OK</span>
                  {u !== undefined && (
                    <span className="text-muted-foreground">
                      {u} {u === 1 ? "unit" : "units"} consumed
                    </span>
                  )}
                </div>
                <pre className={RESPONSE_PRE_CLASS}>{t.response}</pre>
              </div>
            );
          })}

          <AnimatePresence mode="wait">
            {phase !== "done" ? (
              <motion.div
                key="run"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className={`${CELL} flex h-fit items-center gap-2 text-xs text-muted-foreground`}
              >
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-70" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                </span>
                {phase === "running" ? "executing request…" : "waiting for input"}
              </motion.div>
            ) : (
              /* Keyed by TAB, so switching re-runs this entrance against the new
                 response instead of silently swapping the text under a block
                 that never moved — the click needs to look like it did
                 something. */
              <motion.div
                key={`res-${tab}`}
                initial={reduce ? false : { opacity: 0, y: 10, filter: "blur(6px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                transition={{ duration: 0.7 }}
                className={`${CELL} h-fit`}
              >
                <div className={BADGE_ROW_CLASS}>
                  <span className={OK_BADGE_CLASS}>200 OK</span>
                  {/* No response-time figure: §8 bans latency numbers.
                      And no "24,999 left" either — that was the shipped copy,
                      and it implies a 25,000 monthly allowance that no plan in
                      the catalogue has (Free is 50,000). The unit cost is read
                      live from the pricing table; the remaining balance is a
                      per-account fact this page cannot know. */}
                  {currentUnits !== undefined ? (
                    <motion.span
                      className="text-muted-foreground"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ delay: 0.5 }}
                    >
                      {currentUnits} {currentUnits === 1 ? "unit" : "units"} consumed
                    </motion.span>
                  ) : null}
                </div>
                <pre className={RESPONSE_PRE_CLASS}>{current.response}</pre>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
