'use client';

import { useEffect, useRef, useState } from 'react';

import { PANEL_PAGE_SIZES, Pagination, usePagination } from '@/components/admin/Pagination';
import UsageBarChart from '@/components/charts/UsageBarChart';
import { InlineError, SkeletonBlock } from '@/components/DataState';
import { adminApi, type UsageDetail, type UsageDetailParams } from '@/lib/admin-api';
import { formatUtcDate } from '@/lib/format';
import { RATE_LIMITED_LABEL, STATUS_COPY, rateLimitedRequests } from '@/lib/usage-status';

/*
 * The metered detail for one customer — `GET /admin/clients/:id/usage/detail`,
 * the `usage_buckets` read model — as ONE component, because two admin surfaces
 * ask the same question about the same customer: the standalone client page and
 * the Manage panel that expands under a row on the clients list.
 *
 * It fetches for itself rather than taking the payload as a prop. The two call
 * sites have nothing else in common — one has a seven-endpoint bundle around it,
 * the other has a row — so an `initial` prop would only be satisfiable by one of
 * them, and the range selector needs its own fetch regardless.
 *
 * This is also the SAME report the customer sees in their own portal, from the
 * same endpoint and the same aggregation, so a support conversation about a bill
 * cannot turn into an argument about whose figures are right.
 */

type RangeKey = 'mtd' | 'prev' | '7d' | '30d' | '90d';

/*
 * Nothing wider than 90 days is offered: the server caps a detail read at 92
 * and REJECTS a longer window rather than clamping it, so a "1 year" option
 * would be a button that returns a 400. A longer look-back is the monthly
 * rollup's question, and `GET /admin/clients/:id/usage` still answers it.
 */
const RANGE_OPTIONS: Array<{ key: RangeKey; label: string }> = [
  { key: 'mtd', label: 'Month to date' },
  { key: 'prev', label: 'Previous month' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: '90d', label: 'Last 90 days' },
];

const DAY_MS = 86_400_000;

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

function rangeParams(key: RangeKey): UsageDetailParams {
  /*
   * 'mtd' sends NO bounds on purpose. The server's default already is the
   * current calendar month to date in UTC — the month the quota resets on —
   * and deriving it here from the operator's clock would ask for a different
   * window than the one the plan is metered against.
   */
  if (key === 'mtd') return {};
  const now = new Date();
  if (key === 'prev') {
    // Day 0 of this month is the last day of the previous one.
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
    const start = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
    return { from: isoDay(start), to: isoDay(end) };
  }
  const days = key === '7d' ? 7 : key === '30d' ? 30 : 90;
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // Both bounds are inclusive server-side, so N days reaches back N-1.
  return { from: isoDay(new Date(to.getTime() - (days - 1) * DAY_MS)), to: isoDay(to) };
}

const STATUS_CLASS_TONES: Record<string, string> = {
  '2xx': 'border-success/40 bg-success/10 text-success',
  '4xx': 'border-warning/40 bg-warning/10 text-warning',
  '429': 'border-warning/40 bg-warning/10 text-warning',
  '5xx': 'border-destructive/40 bg-destructive/10 text-destructive',
};

/** Units per day, then the same numbers split by endpoint, by key and by response class. */
export function UsageDetailPanel({ clientId }: { clientId: string }) {
  const [range, setRange] = useState<RangeKey>('mtd');
  const [detail, setDetail] = useState<UsageDetail | null>(null);
  const [pending, setPending] = useState(true);
  const [error, setError] = useState('');
  /* Bumping this re-runs the effect, which is all Retry has to do. */
  const [attempt, setAttempt] = useState(0);
  /*
   * Whose numbers are currently on screen. A refetch keeps the previous window
   * visible while the next one loads, which is right for a range change and
   * wrong for a change of customer — those figures belong to someone else and
   * have to go on the spot, not when the request lands.
   */
  const shownFor = useRef(clientId);

  /*
   * The two long breakdowns get a pager; `byStatus` does not, because it is at
   * most five rows by construction (one per response class).
   *
   * `resetKey` carries the CUSTOMER as well as the range — this component is
   * mounted once per clients-list row and reused across customers (see
   * `shownFor` above), so without the id a page-3 position would survive into
   * someone else's numbers. Both breakdowns are keyed the same and reset
   * together, since one fetch replaces both.
   *
   * Sizes are `PANEL_PAGE_SIZES` starting at 10: inside an expanded clients row
   * this panel is ~240px wide.
   */
  const detailKey = `${clientId}:${range}`;
  const pagedRoutes = usePagination(detail?.byRoute ?? [], {
    defaultPageSize: 10,
    pageSizes: PANEL_PAGE_SIZES,
    resetKey: detailKey,
  });
  const pagedKeys = usePagination(detail?.byKey ?? [], {
    defaultPageSize: 10,
    pageSizes: PANEL_PAGE_SIZES,
    resetKey: detailKey,
  });

  useEffect(() => {
    let active = true;
    if (shownFor.current !== clientId) {
      shownFor.current = clientId;
      setDetail(null);
    }
    setPending(true);
    setError('');
    adminApi
      .usageDetail(clientId, rangeParams(range))
      .then((next) => {
        if (active) setDetail(next);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : 'Could not load usage detail.');
      })
      .finally(() => {
        if (active) setPending(false);
      });
    return () => {
      active = false;
    };
  }, [clientId, range, attempt]);

  /*
   * The selector is deliberately NOT disabled while a refetch is in flight: the
   * effect already drops a stale response, so a disable buys no correctness and
   * costs the keyboard user the control they are standing on. `aria-busy` and
   * the dimmed body below are the pending signal — same call the portal makes.
   */
  const header = (
    <select
      className="h-8 rounded-md border border-input bg-surface px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      value={range}
      onChange={(e) => setRange(e.target.value as RangeKey)}
      aria-label="Usage range"
    >
      {RANGE_OPTIONS.map((o) => (
        <option key={o.key} value={o.key}>
          {o.label}
        </option>
      ))}
    </select>
  );

  if (!detail) {
    return (
      <Panel title="Usage detail" actions={header}>
        {error ? (
          <div className="px-4 py-4">
            <InlineError message={error} onRetry={() => setAttempt((a) => a + 1)} />
          </div>
        ) : (
          <SkeletonBlock className="m-4 h-52" />
        )}
      </Panel>
    );
  }

  /*
   * The body describes `detail.range` — what the server SERVED — not the
   * selected preset. A failed refetch leaves the previous window on screen, and
   * it must not be labelled with the range that failed to load.
   */
  const currentPeriod = new Date().toISOString().slice(0, 7);
  // The marker the monthly table used to carry, kept: a window whose upper bound
  // falls in the open period is a total still going up, not a closed one.
  const openPeriod = detail.range.to.slice(0, 7) === currentPeriod;
  const rateLimited = rateLimitedRequests(detail.byStatus);

  return (
    <Panel title="Usage detail" actions={header}>
      <div
        className={
          pending
            ? 'space-y-6 px-2 py-4 opacity-50 transition-opacity sm:px-4'
            : 'space-y-6 px-2 py-4 transition-opacity sm:px-4'
        }
        aria-busy={pending}
      >
        {error && <InlineError message={error} onRetry={() => setAttempt((a) => a + 1)} />}

        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="font-mono">
            {formatUtcDate(detail.range.from)} → {formatUtcDate(detail.range.to)}
          </span>
          {openPeriod && <span>current period · still accruing</span>}
        </div>

        {/*
          Four tiles, one row, every width — the same four the customer sees in
          their own portal. Never a column count that follows the data: a tile
          that comes and goes leaves a ragged gap in the row and cannot line up
          with a fixed grid at any breakpoint.
        */}
        <div className="grid grid-cols-4 gap-1.5 sm:gap-4">
          <MiniStat
            label="Units in range"
            shortLabel="Units"
            value={detail.totals.units.toLocaleString()}
          />
          {/* "Reqs" on the phone: the stacked clients row leaves the panel with
              `overflow-wrap: anywhere` inherited, so the full word broke as
              "REQUEST / S" rather than overflowing the 56px tile. */}
          <MiniStat
            label="Requests"
            shortLabel="Reqs"
            value={detail.totals.requests.toLocaleString()}
          />
          <MiniStat
            label="Units per request"
            shortLabel="Units/req"
            value={
              detail.totals.requests > 0
                ? (detail.totals.units / detail.totals.requests).toFixed(2)
                : '—'
            }
          />
          {/*
            429s ONLY, and labelled as such. The tile used to read "Not 2xx",
            which counted the refunded 4xx and 5xx classes too — two refunded
            calls out of six presented as a 33% failure rate for calls the
            customer was never charged for. A 429 is the one non-2xx class the
            guard turns away before the charge, so it is the only one that
            represents traffic the account could not get served. What the
            refunded classes cost — nothing — is spelled out in the
            by-response-class breakdown below.
          */}
          <MiniStat
            label={RATE_LIMITED_LABEL}
            value={
              detail.totals.requests > 0
                ? `${((rateLimited / detail.totals.requests) * 100).toFixed(1)}%`
                : '—'
            }
            sub={
              detail.totals.requests > 0 ? (
                <>
                  {rateLimited.toLocaleString()} of {detail.totals.requests.toLocaleString()}
                  <span className="hidden sm:inline"> requests</span>
                </>
              ) : undefined
            }
          />
        </div>

        {/* The two halves of the average are measured differently and the tile
            cannot show that on its own: units are net of refunds, requests are
            not, so a window with refunded calls in it reads low. */}
        {detail.totals.requests > 0 && (
          <p className="text-[0.625rem] text-muted-foreground">
            Units per request is net units over gross requests: a refunded call still counts
            as a request.
          </p>
        )}

        {/* The window this panel just printed above, not the extent of the
            traffic: one busy day inside a 90-day range has to read as one bar on
            a 90-day axis, and the customer's own page passes the same two so the
            axis under a given range is the same axis on both surfaces. */}
        <UsageBarChart data={detail.series} from={detail.range.from} to={detail.range.to} />

        {detail.byRoute.length > 0 && (
          <Breakdown title={`By endpoint · ${detail.byRoute.length}`}>
            {/*
              Below `sm` the four columns become one row per endpoint: what the
              call is on the left, what it cost on the right. The table needs
              439px of min-content even with the padding cut to `px-2`, against
              241px in the Manage panel and 317px on the client page — so the
              scroller it used to be hid 58% of itself behind an affordance iOS
              draws no scrollbar for. The `sm:` table below is the same table it
              always was; this component renders on both admin surfaces and they
              switch at the same width.
            */}
            {/* This card list and the `sm:` table below share one pager — two
                slices of one array at two widths would disagree on resize. */}
            <div className="sm:hidden">
              {pagedRoutes.pageItems.map((r) => (
                <div
                  key={r.routeKey}
                  className="flex items-baseline justify-between gap-2 border-b border-border/60 px-1 py-1.5"
                >
                  <div className="min-w-0">
                    <div className="truncate text-[0.8125rem]">{r.label}</div>
                    <div className="truncate font-mono text-[0.625rem] text-muted-foreground">
                      {r.routeKey} · {r.unitCost === 0 ? 'free' : `${r.unitCost}/call`}
                    </div>
                  </div>
                  <div className="shrink-0 text-right font-mono">
                    <div className="text-[0.8125rem]">{r.units.toLocaleString()}</div>
                    <div className="text-[0.625rem] text-muted-foreground">
                      {r.requests.toLocaleString()} req
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <table className="hidden w-full text-sm sm:table sm:min-w-[36rem]">
              <thead className="text-left text-[0.625rem] uppercase tracking-widest text-muted-foreground">
                <tr className="border-b border-border/60">
                  <th className="px-2 py-2 sm:px-4">Endpoint</th>
                  <th className="px-2 py-2 sm:px-4">Unit cost</th>
                  <th className="px-2 py-2 sm:px-4">Units</th>
                  <th className="px-2 py-2 sm:px-4">Requests</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {pagedRoutes.pageItems.map((r) => (
                  <tr key={r.routeKey}>
                    <td className="px-2 py-2 sm:px-4">
                      {r.label}
                      <div className="font-mono text-[0.625rem] text-muted-foreground">
                        {r.routeKey}
                      </div>
                    </td>
                    <td className="px-2 py-2 font-mono text-xs sm:px-4">
                      {r.unitCost === 0 ? 'free' : `${r.unitCost}/call`}
                    </td>
                    <td className="px-2 py-2 font-mono sm:px-4">{r.units.toLocaleString()}</td>
                    <td className="px-2 py-2 font-mono sm:px-4">{r.requests.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination state={pagedRoutes} label="endpoints" />
          </Breakdown>
        )}

        {detail.byKey.length > 0 && (
          <Breakdown
            title={`By API key · ${detail.byKey.length}`}
            /* Buckets outlive the key: a delete is a hard delete server-side,
               so a prefix here may belong to a key that no longer exists and
               will not appear in the API keys panel alongside. */
            note="Includes keys that have since been deleted — the prefix is recorded on each bucket, not looked up."
          >
            {/* Same shape as By endpoint above, and deliberately so: the two sit
                one under the other and differ only in what names the row. */}
            <div className="sm:hidden">
              {pagedKeys.pageItems.map((k) => (
                <div
                  key={k.apiKeyId}
                  className="flex items-baseline justify-between gap-2 border-b border-border/60 px-1 py-1.5"
                >
                  <div className="min-w-0">
                    <div className="truncate text-[0.8125rem]">{k.keyLabel || '—'}</div>
                    <div className="truncate font-mono text-[0.625rem] text-muted-foreground">
                      {k.keyPrefix || shortId(k.apiKeyId)}
                    </div>
                  </div>
                  <div className="shrink-0 text-right font-mono">
                    <div className="text-[0.8125rem]">{k.units.toLocaleString()}</div>
                    <div className="text-[0.625rem] text-muted-foreground">
                      {k.requests.toLocaleString()} req
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <table className="hidden w-full text-sm sm:table sm:min-w-[36rem]">
              <thead className="text-left text-[0.625rem] uppercase tracking-widest text-muted-foreground">
                <tr className="border-b border-border/60">
                  <th className="px-2 py-2 sm:px-4">Key</th>
                  <th className="px-2 py-2 sm:px-4">Label</th>
                  <th className="px-2 py-2 sm:px-4">Units</th>
                  <th className="px-2 py-2 sm:px-4">Requests</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {pagedKeys.pageItems.map((k) => (
                  <tr key={k.apiKeyId}>
                    <td className="px-2 py-2 font-mono text-xs text-muted-foreground sm:px-4">
                      {k.keyPrefix || shortId(k.apiKeyId)}
                    </td>
                    <td className="px-2 py-2 sm:px-4">{k.keyLabel || '—'}</td>
                    <td className="px-2 py-2 font-mono sm:px-4">{k.units.toLocaleString()}</td>
                    <td className="px-2 py-2 font-mono sm:px-4">{k.requests.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination state={pagedKeys} label="keys" />
          </Breakdown>
        )}

        {detail.byStatus.length > 0 && (
          <Breakdown title="By response class">
            {/* Three columns — a badge and two numbers — so this one stays a
                real table at every width. Its content needs 213px once the cells
                drop to `px-2`, and the 22rem floor that made it scroll was only
                ever there because `px-4` starved the class column in the ~240px
                the panel gets inside a clients row. The floor is kept from `sm`
                up, where the copy has room to matter. */}
            <table className="w-full text-sm sm:min-w-[22rem]">
              <thead className="text-left text-[0.625rem] uppercase tracking-widest text-muted-foreground">
                <tr className="border-b border-border/60">
                  <th className="px-2 py-2 sm:px-4">Class</th>
                  <th className="px-2 py-2 sm:px-4">Requests</th>
                  <th className="px-2 py-2 sm:px-4">Units</th>
                </tr>
              </thead>
              {/* Rendered in the order the server sent, which it sorts
                  deliberately — sorting the class strings here would put 429
                  between 2xx and 4xx and read as an error family, which is the
                  misreading the tile above exists to remove. */}
              <tbody className="divide-y divide-border/60">
                {detail.byStatus.map((s) => {
                  const copy = STATUS_COPY[s.statusClass];
                  return (
                    <tr key={s.statusClass}>
                      <td className="px-2 py-2 sm:px-4">
                        <span
                          className={`inline-block rounded-full border px-2 py-0.5 text-[0.625rem] ${
                            STATUS_CLASS_TONES[s.statusClass] ??
                            'border-border/60 bg-surface-2 text-muted-foreground'
                          }`}
                        >
                          {s.statusClass}
                        </span>
                        {/* What this class cost, on screen for every class and
                            not just 429 — the tile above no longer counts the
                            refunded ones, so this is where a reader learns that
                            those calls failed and were given back. */}
                        {copy && (
                          <span className="ml-2 text-[0.625rem] text-muted-foreground">
                            {copy.label} · {copy.note.toLowerCase()}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-2 font-mono sm:px-4">{s.requests.toLocaleString()}</td>
                      <td className="px-2 py-2 font-mono sm:px-4">{s.units.toLocaleString()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Breakdown>
        )}
      </div>
    </Panel>
  );
}

/*
 * The title and the footnote sit OUTSIDE the scroller and only the table goes
 * inside it: both stretch to the table's `sm:min-w-[36rem]` otherwise, so at the
 * widths where the scroll actually engages the section's own name slides out of
 * view with the data and the footnote wraps at 36rem instead of at panel width.
 * Below `sm` the floors are gone and the wrapper has nothing to scroll.
 */
function Breakdown({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="px-4 pb-1 font-sans text-[0.625rem] uppercase tracking-widest text-muted-foreground">
        {title}
      </h3>
      <div className="overflow-x-auto">{children}</div>
      {note && <p className="px-4 pt-2 text-[0.625rem] text-muted-foreground">{note}</p>}
    </div>
  );
}

/*
 * FOUR ACROSS AT EVERY WIDTH, including 375px — where this panel also renders
 * inside a `<td>` of the clients table, several levels of card padding in. Type
 * and padding step down at the small breakpoint rather than the grid re-flowing:
 * four one-per-row tiles is four screens of near-empty card before the chart.
 * Grid items stretch, so a label that wraps to two lines keeps the row level.
 */
function MiniStat({
  label,
  shortLabel,
  value,
  sub,
}: {
  label: string;
  /*
   * The phone wording, where a tile is ~56px wide. "Units per request" wraps to
   * three lines there against everything else's two, and the grid's stretch then
   * keeps the row level by dropping that tile's figure 12px below its
   * neighbours'. Same measured width the desktop label keeps in full.
   */
  shortLabel?: string;
  value: string;
  sub?: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-surface-2 px-1.5 py-2 sm:px-4 sm:py-3">
      {/* Two lines reserved on mobile: at 56px every label but "Requests" takes
          two, and a one-line label would lift that tile's figure off the line
          the other three sit on. Released at `sm`, where all four fit on one. */}
      <div className="min-h-[1.5rem] text-[0.5rem] uppercase tracking-wide text-muted-foreground sm:min-h-0 sm:text-[0.625rem] sm:tracking-widest">
        {shortLabel ? (
          <>
            <span className="sm:hidden">{shortLabel}</span>
            <span className="hidden sm:inline">{label}</span>
          </>
        ) : (
          label
        )}
      </div>
      <div className="mt-0.5 break-words font-mono text-xs tabular-nums sm:text-lg">{value}</div>
      {sub && (
        <div className="text-[0.5rem] text-muted-foreground tabular-nums sm:text-[0.625rem]">
          {sub}
        </div>
      )}
    </div>
  );
}

// ─── Local atoms ─────────────────────────────────────────────────────────────
//
// Own copies, matching the admin views: there is no shared admin-view module in
// this repo, and these are three lines each. `Panel` is the frame the client
// detail page gives every one of its sections, repeated here so the panel is
// self-framing at both call sites — the clients list has no `Panel` of its own.

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

/** `actions` is the panel's own control slot — a filter that governs only its body. */
function Panel({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-border/60 bg-surface shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-4 py-4 text-xs uppercase tracking-widest text-muted-foreground sm:px-6">
        {/* A real heading, not a styled span: this and the `Breakdown` titles
            are the only section names on a very long page, and a heading list is
            the one keyboard way to move between them. */}
        <h2 className="font-sans text-xs uppercase tracking-widest">{title}</h2>
        {actions}
      </div>
      <div className="px-1 py-1 sm:px-2">{children}</div>
    </div>
  );
}
