'use client';

import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchChains, fetchHealth, type ChainMeta } from '@/lib/api';
import { buildCoverageRows, type CoverageRow } from '@/lib/site-data';

/**
 * How often to re-ask.
 *
 * 20s, and the ceiling that matters is the SERVER's: `IndexingStatusService`
 * caches its per-integration status for 15s and serves it stale-while-
 * revalidate, so polling faster than that buys nothing but re-serves the same
 * cached object. Slower than ~30s and a page left open stops feeling live,
 * which is the whole point of this page.
 */
const POLL_MS = 20_000;

/**
 * A single poll gives up after this long.
 *
 * Without a deadline a request that never answers leaves `poll` awaiting forever,
 * and because the next tick is only scheduled once the current poll settles, ONE
 * hung request stopped the page updating for good — no error, no stale marker,
 * just a "last checked" stamp that never moved again.
 */
const POLL_TIMEOUT_MS = 8_000;

/**
 * After a FAILED poll, try again sooner than the normal cadence. A blip should
 * cost a few seconds of staleness, not a full period — and with no rows at all it
 * is the difference between the page recovering while somebody is still looking
 * at it and not.
 */
const RETRY_MS = 5_000;

/**
 * The status rows, seeded by the server and kept live in the browser.
 *
 * The page is a server component so the rows are in the HTML a crawler reads
 * and the first paint carries real numbers — but a server component renders
 * once, so somebody watching the page saw a frozen block height until they
 * reloaded. On a page whose entire subject is freshness that is the worst
 * possible failure, so the initial rows come down as a prop and this component
 * re-fetches from there.
 *
 * It calls `/health` and `/v1/chains` DIRECTLY from the browser: both are
 * public and unmetered, and the reference dashboard has always read `/health`
 * this way. Rows are rebuilt with the same `buildCoverageRows` the server used,
 * so a poll cannot produce a different shape from the paint it replaces.
 */
/**
 * A lag in minutes as ONE rounded unit: "6 months", "4 weeks", "3 days".
 *
 * Raw minutes ("~277,812 min") are unreadable — the reader has to divide by 1440
 * in their head. Two units ("6mo 1w") were tried and are still noise: at six
 * months, one week is well inside the error bar of a month being "30 days", so
 * the extra precision is fake. Pick the largest unit that fits and round to it.
 *
 * Rounding, not truncation: 3w 4d is nearer four weeks than three, and reading
 * "3 weeks" there understates the lag. After rounding, a value that has grown
 * into the next unit is promoted — 1439 minutes reads "1 day", not "24 hours".
 *
 * Months and years are approximations (30 and 365 days), which is why callers
 * prefix this with "~". Sub-minute lag reads "< 1 minute", never "0 minutes",
 * because zero reads as "fully caught up" when it is not.
 */
const LAG_UNITS: ReadonlyArray<readonly [singular: string, minutes: number]> = [
  ['year', 525_600],
  ['month', 43_200],
  ['week', 10_080],
  ['day', 1_440],
  ['hour', 60],
  ['minute', 1],
];

export function formatLagDuration(totalMinutes: number): string {
  if (!Number.isFinite(totalMinutes) || totalMinutes < 0) return '—';
  if (totalMinutes < 1) return '< 1 minute';

  for (let i = 0; i < LAG_UNITS.length; i += 1) {
    const [singular, size] = LAG_UNITS[i];
    if (totalMinutes < size) continue;

    let count = Math.round(totalMinutes / size);
    let label = singular;

    // Rounding can land exactly on the next unit up (24 hours, 7 days, 12
    // months). Say that unit instead of the awkward multiple.
    const bigger = LAG_UNITS[i - 1];
    if (bigger && count * size >= bigger[1]) {
      count = Math.round((count * size) / bigger[1]);
      label = bigger[0];
    }

    return `${count} ${label}${count === 1 ? '' : 's'}`;
  }

  return '< 1 minute';
}

export function StatusRows({ initialRows }: { initialRows: CoverageRow[] }) {
  const [rows, setRows] = useState(initialRows);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  /**
   * A failed poll does NOT clear the rows. The numbers on screen were true when
   * they were fetched, and replacing them with an error because one request
   * timed out is less honest than leaving them with a stale-since stamp.
   */
  const [stale, setStale] = useState(false);
  /**
   * Whether the BROWSER has finished a poll of its own yet, whichever way it went.
   *
   * The server's render is one attempt against a 2.5s deadline and can come back
   * empty for reasons that have nothing to do with whether the API is up (a cold
   * start, a slow hop), so `rows.length === 0` on first paint means "the server
   * did not get an answer", not "there is no answer". Claiming "we can't reach the
   * API" on that evidence told people the API was down for the second or so the
   * browser's own request needed — and for as long as the page stayed on that
   * message if the browser's request then failed too.
   */
  const [hasPolled, setHasPolled] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * The chain list, kept across polls. It changes with a deploy, not with a
   * block, so one `/v1/chains` miss must not throw away a perfectly good `/health`
   * reading.
   */
  const chains = useRef<ChainMeta[] | null>(null);
  /**
   * The poll currently in flight, if any. Polls are SINGLE-FLIGHT: the interval
   * and every visibility change share one request rather than each starting
   * their own. A tab that flips between hidden and visible (a window manager, an
   * embedded browser pane, somebody alt-tabbing) fired a fresh poll per flip, and
   * against a slow API those piled up behind each other — measured: a new
   * `/health` every 2s, each held for the full 8s deadline, until the browser's
   * per-host connection limit queued them.
   */
  const inFlight = useRef<Promise<boolean> | null>(null);

  /** Resolves `true` when the poll produced a reading, `false` when it did not. */
  const poll = useCallback((signal: AbortSignal): Promise<boolean> => {
    if (inFlight.current) return inFlight.current;

    const run = async (): Promise<boolean> => {
      const attempt = new AbortController();
      const cancel = () => attempt.abort();
      signal.addEventListener('abort', cancel);
      const deadline = setTimeout(cancel, POLL_TIMEOUT_MS);
      try {
        // Settled, not `Promise.all`: one request failing must not discard the other.
        const [chainsResult, healthResult] = await Promise.allSettled([
          fetchChains(attempt.signal),
          fetchHealth(attempt.signal),
        ]);
        if (signal.aborted) return true; // unmounted — nothing left to update
        if (chainsResult.status === 'fulfilled') chains.current = chainsResult.value;

        const health = healthResult.status === 'fulfilled' ? healthResult.value : null;
        setHasPolled(true);
        if (!chains.current || !health) {
          setStale(true);
          return false;
        }
        setRows(buildCoverageRows(chains.current, health));
        setStale(false);
        setCheckedAt(new Date().toLocaleTimeString());
        return true;
      } catch {
        // A 200 whose body is not the shape we expect (a proxy's HTML notice
        // parsed as something, a field that changed type) makes the row builder
        // THROW. Unguarded, that rejection escaped `tick`, which never scheduled
        // its next run — one malformed response ended live updates for good, which
        // is the same failure as a hung request by another road. Treat it as a
        // failed poll: keep the rows, mark them stale, try again soon.
        if (signal.aborted) return true;
        setHasPolled(true);
        setStale(true);
        return false;
      } finally {
        clearTimeout(deadline);
        signal.removeEventListener('abort', cancel);
      }
    };

    const promise: Promise<boolean> = run().finally(() => {
      // Only release OUR slot: a newer poll may have taken it while this one was
      // winding down (the effect cleanup below frees it on purpose).
      if (inFlight.current === promise) inFlight.current = null;
    });
    inFlight.current = promise;
    return promise;
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    const tick = async () => {
      // Don't poll a page nobody is looking at — a background tab left open
      // overnight would otherwise spend ~4,000 requests proving nothing. The
      // visibilitychange listener below fires an immediate catch-up on return,
      // so coming back to the tab shows current data rather than the last
      // value from hours ago.
      const ok = document.visibilityState === 'visible' ? await poll(controller.signal) : true;
      if (!controller.signal.aborted) {
        timer.current = setTimeout(() => void tick(), ok ? POLL_MS : RETRY_MS);
      }
    };

    const onVisible = () => {
      if (document.visibilityState === 'visible') void poll(controller.signal);
    };

    /*
     * Fetch IMMEDIATELY, then settle into the interval — the same shape
     * /explore uses. The server-rendered rows come off an ISR cache that can be
     * up to `revalidate` seconds old, so waiting a full period before the first
     * client fetch means a reload can show a stale reading for 20s on the one
     * page whose subject is freshness.
     */
    void tick();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      controller.abort();
      // The poll in flight belongs to THIS effect's signal and is being aborted.
      // Free the slot so a remount (React Strict Mode does exactly this in dev)
      // starts a real poll instead of adopting one that will report nothing.
      inFlight.current = null;
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [poll]);

  const measured = rows.filter((r) => r.indexedBlock !== undefined).length;

  if (rows.length === 0) {
    // Nothing from the server AND the browser has not had its own try yet: that is
    // "loading", not "down". Only a poll that has actually failed earns the
    // warning.
    if (!hasPolled) {
      return (
        <div
          className="mt-8 rounded-md border border-border/60 bg-surface p-4 text-sm text-muted-foreground"
          role="status"
          aria-busy="true"
        >
          Checking the API…
        </div>
      );
    }
    return (
      <div
        className="mt-8 rounded-md border border-warning/40 bg-warning/10 p-4 text-sm text-muted-foreground"
        role="status"
      >
        We can’t reach the API from here, so there is nothing to report — not even which chains we
        serve. We’ll keep trying.
      </div>
    );
  }

  return (
    <>
      <div className="mt-8 overflow-hidden rounded-xl border border-border/60 bg-surface shadow-card">
        {rows.map((r) => (
          <div
            key={r.label}
            className="flex flex-col gap-3 border-b border-border/60 px-6 py-4 last:border-b-0 md:flex-row md:items-center md:justify-between"
          >
            <div className="flex items-center gap-3">
              <HealthDot health={r.health} servable={r.servable} />
              <div>
                <div className="font-medium">{r.label}</div>
                {/* The block pair, whichever halves resolved. The chain head
                    comes from DeFiLlama and the indexed block from the indexer,
                    so one is routinely available without the other — printing
                    the half we have beats printing nothing. */}
                <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                  {r.chainHeadBlock !== undefined
                    ? r.chainHeadEstimated
                      ? `chain head ~${r.chainHeadBlock.toLocaleString()} (estimated)`
                      : `chain head ${r.chainHeadBlock.toLocaleString()}`
                    : 'chain head unavailable'}
                  {' · '}
                  {r.indexedBlock !== undefined
                    ? `indexed ${r.indexedBlock.toLocaleString()}`
                    : 'indexed not reporting'}
                </div>
              </div>
            </div>
            <div className="text-left md:text-right">
              <div className="font-mono text-sm">
                {!r.servable ? (
                  <span className="text-muted-foreground">coming soon</span>
                ) : r.lagBlocks !== undefined ? (
                  <span className={r.lagBlocks > 0 ? 'text-warning' : 'text-success'}>
                    {/* An estimated head makes the lag an estimate too. */}
                    {r.chainHeadEstimated ? '~' : ''}
                    {r.lagBlocks.toLocaleString()} blocks behind
                  </span>
                ) : (
                  <span className="text-muted-foreground">lag unavailable</span>
                )}
              </div>
              {r.lagMinutes !== undefined && (
                <div
                  className="font-mono text-xs text-muted-foreground"
                  title={`~${r.lagMinutes.toLocaleString()} minutes`}
                >
                  ~{formatLagDuration(r.lagMinutes)}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <div
        className="mt-3 flex items-center gap-2 text-xs text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        {stale ? (
          <>
            <span className="h-1.5 w-1.5 rounded-full bg-warning" />
            Couldn’t refresh just now — showing the last reading
            {checkedAt && <span>, taken at {checkedAt}</span>}.
          </>
        ) : (
          <>
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-success" />
            </span>
            Refreshing every {POLL_MS / 1000}s
            {checkedAt && <span>· last checked {checkedAt}</span>}
          </>
        )}
      </div>

      {/* Only when the chain list resolved but NO indexed head did. A single
          missing figure already says so on its own row. */}
      {measured === 0 && (
        <div className="mt-6 rounded-md border border-warning/40 bg-warning/10 p-4 text-sm text-muted-foreground">
          The indexer isn’t reporting a head right now, so we can’t say how far behind it is. The
          chain heads above are live, and the chains listed are still the ones we serve — the data
          already indexed is being served normally.
        </div>
      )}
    </>
  );
}

/**
 * The per-row indicator, driven by the backend's OWN verdict rather than
 * re-derived here.
 *
 * `/health` already decides `healthy | degraded | unhealthy | not_deployed`
 * against a per-chain, time-scaled lag budget (Avalanche's ~1s blocks tolerate
 * far more blocks of lag than Ethereum's for the same wall-clock staleness).
 * Recomputing a threshold in the page would quietly disagree with the API the
 * moment that budget changed.
 */
function HealthDot({ health, servable }: { health?: string; servable: boolean }) {
  if (!servable) return <AlertCircle className="h-4 w-4 shrink-0 text-muted-foreground" />;
  if (health === 'healthy') return <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />;
  if (health === 'degraded') return <AlertCircle className="h-4 w-4 shrink-0 text-warning" />;
  if (health === 'unhealthy' || health === 'not_deployed')
    return <AlertCircle className="h-4 w-4 shrink-0 text-destructive" />;
  return <AlertCircle className="h-4 w-4 shrink-0 text-muted-foreground" />;
}
