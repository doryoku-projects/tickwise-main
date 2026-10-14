"use client";

import { useEffect, useState } from "react";
import { Check, Copy, Zap } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { QUICKSTART_BASE } from "@/lib/api";

/*
 * A REAL CALL AGAINST OUR OWN HOST.
 *
 * Both lines arrived from the reference design as `api.tickwise.io` with
 * `?chain=ethereum` — a host that does not answer, and a parameter this API does
 * not have (it is `chainId`, an integer; see /docs/endpoints/pools). Someone
 * copying the hero would get a DNS failure, then a 400. `QUICKSTART_BASE` is the
 * same origin the docs print, so a staging or self-hosted build shows its own
 * host rather than ours.
 */
const CMD = `curl "${QUICKSTART_BASE}/v1/pools?chainId=1&limit=5" \\
  -H "KC-APIKey: kc_live_xxxxxxxx…"`;

/*
 * The response is trimmed, but its SHAPE is the one the endpoint returns:
 * `{ pools: [...], pagination: {...} }`. It previously read
 * `{ "pools": 1284, "chain": "ethereum", "lag_s": 42 }` — three keys the API has
 * never sent, one of them a latency figure, which §8 bans and which no
 * monitoring here could source anyway.
 */
const RESPONSE = `{ "pools": [ … ], "pagination": { "total": 1284, "page": 1 } }`;

/*
 * Shared by each live panel and by the invisible sizer that reserves its height,
 * so the two can never drift apart and start reserving the wrong box.
 */
const CARET_CLASS = "ml-0.5 inline-block h-[1.05em] w-[7px] translate-y-[2px] bg-primary-glow";
const RESPONSE_PRE_CLASS =
  "overflow-x-auto rounded-lg border border-border/60 bg-background/60 p-3 text-[0.75rem] text-foreground/80";
const OK_BADGE_CLASS =
  "inline-flex items-center gap-1 rounded-full border border-success/40 bg-success/10 px-2 py-0.5 text-success";
const UNITS_BADGE_CLASS =
  "inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-primary-glow";

/**
 * Every phase panel is laid into the same grid cell as its sizer.
 *
 * `min-w-0` for the same reason as the quickstart card's cells: a grid item is
 * floored at its own min-content width unless told otherwise, so the response
 * `pre` held this cell open at 472px inside a 375px phone and the terminal's
 * right-hand side ran off the screen instead of scrolling inside its own box.
 */
const CELL = "col-start-1 row-start-1 min-w-0";

type Phase = "typing" | "sending" | "loading" | "response" | "success" | "units" | "idle";

/** Interactive terminal that loops the full request lifecycle. */
export function APITerminal({
  reduce = false,
  units,
}: {
  reduce?: boolean;
  /**
   * What `GET /v1/pools` charges, read live from `/v1/pricing/units` by the
   * page. Undefined when the pricing table is unreachable — the badge is then
   * omitted rather than guessed, because the number the hero prints is the one
   * people budget against, and it is admin-editable.
   */
  units?: number;
}) {
  const [typed, setTyped] = useState(reduce ? CMD : "");
  const [phase, setPhase] = useState<Phase>(reduce ? "units" : "typing");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (reduce) return;
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const at = (fn: () => void, ms: number) => timers.push(setTimeout(fn, ms));

    const run = () => {
      let i = 0;
      setPhase("typing");
      setTyped("");
      const type = () => {
        if (cancelled) return;
        i += 1;
        setTyped(CMD.slice(0, i));
        if (i < CMD.length) at(type, 24);
        else {
          at(() => setPhase("sending"), 520);
          at(() => setPhase("loading"), 1100);
          at(() => setPhase("response"), 2000);
          at(() => setPhase("success"), 2700);
          at(() => setPhase("units"), 3400);
          at(() => setPhase("idle"), 7200);
          at(run, 8000);
        }
      };
      at(type, 420);
    };
    run();
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [reduce]);

  const showResponse = phase === "response" || phase === "success" || phase === "units";

  /*
   * Which panel the phase slot is showing. Naming it once is what lets the three
   * panels share a single `AnimatePresence mode="wait"`, and they have to share
   * one: stacked in the same box, an outgoing panel that is still fading would
   * otherwise be painted under the one replacing it — the idle line sitting on
   * top of the JSON. `mode="wait"` finishes the exit before the next mounts.
   * "response" is one key across three phases so the block stays mounted while
   * its badges arrive.
   */
  const panel = showResponse
    ? "response"
    : phase === "sending" || phase === "loading"
      ? "inflight"
      : phase === "idle"
        ? "idle"
        : null;

  /* Brisk enough that the handoff reads as a replacement, not a pause. */
  const EXIT = { opacity: 0, transition: { duration: 0.18 } };

  return (
    <div className="group relative overflow-hidden rounded-2xl border border-border/70 bg-surface/50 shadow-card backdrop-blur-xl">
      <div className="pointer-events-none absolute inset-x-0 -top-px h-px bg-gradient-to-r from-transparent via-primary/70 to-transparent" />
      <div className="flex items-center justify-between border-b border-border/60 px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="h-2 w-2 shrink-0 rounded-full bg-destructive/70" />
          <span className="h-2 w-2 shrink-0 rounded-full bg-warning/70" />
          <span className="h-2 w-2 shrink-0 rounded-full bg-success/70" />
          <span className="ml-2 truncate font-mono text-[0.625rem] uppercase tracking-[0.2em] text-muted-foreground">
            bash — tickwise
          </span>
        </div>
        <button
          onClick={async () => {
            await navigator.clipboard.writeText(CMD);
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          }}
          className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 font-mono text-[0.6875rem] text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {copied ? (
            <Check className="h-3.5 w-3.5 text-success" />
          ) : (
            <Copy className="h-3.5 w-3.5" />
          )}
          {copied ? "copied" : "copy"}
        </button>
      </div>

      {/*
       * EVERY PHASE OCCUPIES THE SAME BOX.
       *
       * These panels are mutually exclusive, but they used to stack in normal
       * flow, so the card grew and shrank as the loop ran: 188px while typing,
       * 227px once the response landed, at a 1512px viewport. This terminal sits
       * in the hero's left column, and that column is what sets the height of
       * the hero grid row — so all ~39px of the swing was handed to the rest of
       * the landing page, every eight seconds, forever. The page visibly bounced.
       *
       * Reserving the tallest state is the fix, and it has to be reserved from
       * the real markup rather than guessed as a taller `min-h`: both the command
       * and the badge row rewrap as the column narrows, so no single pixel value
       * is correct at every width. Two invisible sizers do it — one holding the
       * full command so typing cannot add a line, one holding the response block
       * with every badge it can ever show — each sharing a grid cell with the
       * live panels it covers. The box is then always exactly as tall as its
       * tallest possible content, and nothing below it moves.
       */}
      <div className="min-h-[188px] p-4 font-mono text-[12.5px] leading-relaxed md:text-sm">
        <div className="grid">
          {/* The caret is part of the sizer because it is still on screen when
              the last character has been typed, and at that point it is what
              would tip the command onto one more line. */}
          <pre aria-hidden className={`${CELL} invisible whitespace-pre-wrap break-all`}>
            <span>$ </span>
            {CMD}
            <span className={CARET_CLASS} />
          </pre>
          <pre className={`${CELL} whitespace-pre-wrap break-all text-foreground/90`}>
            <span className="text-primary-glow">$ </span>
            {typed}
            {phase === "typing" && !reduce && <span className={`${CARET_CLASS} animate-caret`} />}
          </pre>
        </div>

        <div className="mt-3 grid">
          <div aria-hidden className={`${CELL} invisible space-y-2`}>
            <pre className={RESPONSE_PRE_CLASS}>{RESPONSE}</pre>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className={OK_BADGE_CLASS}>
                <Check className="h-3 w-3" /> 200 OK
              </span>
              {units !== undefined && (
                <span className={UNITS_BADGE_CLASS}>
                  <Zap className="h-3 w-3" /> {units} {units === 1 ? "unit" : "units"} consumed
                </span>
              )}
            </div>
          </div>

          <AnimatePresence mode="wait">
            {panel === "inflight" && (
              <motion.div
                key="inflight"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={EXIT}
                className={`${CELL} flex h-fit items-center gap-2 text-xs text-muted-foreground`}
              >
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                </span>
                {phase === "sending" ? "request sent · opening stream" : "loading · resolving pools"}
              </motion.div>
            )}

            {panel === "response" && (
              <motion.div
                key="response"
                initial={reduce ? false : { opacity: 0, y: 8, filter: "blur(6px)" }}
                animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
                exit={EXIT}
                transition={{ duration: 0.5 }}
                className={`${CELL} h-fit space-y-2`}
              >
                <pre className={RESPONSE_PRE_CLASS}>{RESPONSE}</pre>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <AnimatePresence>
                    {(phase === "success" || phase === "units") && (
                      <motion.span
                        key="ok"
                        initial={reduce ? false : { opacity: 0, scale: 0.9 }}
                        animate={{ opacity: 1, scale: 1 }}
                        className={OK_BADGE_CLASS}
                      >
                        <Check className="h-3 w-3" /> 200 OK
                      </motion.span>
                    )}
                    {phase === "units" && units !== undefined && (
                      <motion.span
                        key="units"
                        initial={reduce ? false : { opacity: 0, y: 6 }}
                        animate={{ opacity: 1, y: 0 }}
                        className={UNITS_BADGE_CLASS}
                      >
                        <Zap className="h-3 w-3" /> {units} {units === 1 ? "unit" : "units"} consumed
                      </motion.span>
                    )}
                  </AnimatePresence>
                  {/* No response-time figure here: §8 bans latency numbers, and
                      there is no monitoring to source a real one from. The unit
                      cost is true and is the point the terminal is making. */}
                </div>
              </motion.div>
            )}

            {panel === "idle" && (
              <motion.div
                key="idle"
                initial={reduce ? false : { opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={EXIT}
                className={`${CELL} h-fit font-mono text-[0.6875rem] text-muted-foreground/70`}
              >
                idle · awaiting next call
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
