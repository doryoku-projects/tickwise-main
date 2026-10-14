'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import UsageBarChart from '../../../components/charts/UsageBarChart';
import { EmptyState, ErrorNotice, SkeletonRows } from '../../../components/StateViews';
import { QuotaMeter } from '../../../components/portal/QuotaMeter';
import { formatPeriod } from '../../../lib/format';
import { RATE_LIMITED_LABEL, STATUS_COPY, rateLimitedRequests } from '../../../lib/usage-status';
import {
  portalApi,
  type AccountUsage,
  type UsageDetail,
  type UsageDetailParams,
} from '../../../lib/portal-api';

/** The windows the selector offers. */
const RANGES = [
  { id: 'month', label: 'This month' },
  { id: '30d', label: 'Last 30 days' },
  { id: '7d', label: 'Last 7 days' },
] as const;

type RangeId = (typeof RANGES)[number]['id'];

const DAY_MS = 86_400_000;

/** 'YYYY-MM-DD' in UTC — the bucket key's calendar, not the reader's. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The window to ask the server for.
 *
 * 'month' sends NO bounds at all and lets the server apply its own default of
 * the current calendar month to date. That is deliberate rather than lazy: the
 * server's clock decides which month a bucket was written under, and a browser
 * sitting in UTC+13 just after midnight on the 1st would otherwise ask for a
 * month the server has not started yet and get an empty report for it.
 */
function rangeParams(range: RangeId): UsageDetailParams {
  if (range === 'month') return {};
  const days = range === '30d' ? 30 : 7;
  const now = Date.now();
  // Inclusive on both ends, so "7 days" is today plus the six before it.
  return { from: utcDay(now - (days - 1) * DAY_MS), to: utcDay(now) };
}

/** '2026-08-01' → '1 Aug 2026'. Fixed locale, like `formatPeriod`, so SSR and the client agree. */
function formatDay(day: string): string {
  const ms = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(ms)) return day;
  return new Date(ms).toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export default function PortalUsagePage() {
  const [usage, setUsage] = useState<AccountUsage | null>(null);
  const [detail, setDetail] = useState<UsageDetail | null>(null);
  const [range, setRange] = useState<RangeId>('month');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  /**
   * Sequence number of the newest request in flight. A range switch on a slow
   * connection is easy to double-click, and without this the FIRST response to
   * arrive is not necessarily the one that was asked for last — the page would
   * settle on a window the customer is no longer looking at. Disabling the
   * buttons instead would be simpler and would read as the page being broken.
   */
  const reqId = useRef(0);

  const load = useCallback(async (next: RangeId, opts?: { silent?: boolean }) => {
    const id = (reqId.current += 1);
    // SILENT skips the skeleton, which is what a range switch needs: the
    // skeleton replaces the whole tree, so a switch would blank the quota meter
    // and the numbers the customer is comparing against. Same reasoning as the
    // billing page's background refresh.
    if (opts?.silent) setRefreshing(true);
    else setLoading(true);
    setError('');
    try {
      /*
       * The account snapshot is fetched on the FIRST load only. It takes no
       * window and always answers for the current calendar month, so a range
       * switch cannot change it — and asking for it there doubled the traffic on
       * a control people press three or four times in a row. A silent load IS
       * the range-switch case, and it can only run once a non-silent load has
       * already put a snapshot in state: `Promise.all` rejects as a unit, so a
       * first load that lost the snapshot has no detail to render either and
       * retries through the full-page notice, which is not silent.
       */
      const [breakdown, snapshot] = await Promise.all([
        portalApi.usageDetail(rangeParams(next)),
        opts?.silent ? null : portalApi.usage(),
      ]);
      if (id !== reqId.current) return;
      if (snapshot) setUsage(snapshot);
      setDetail(breakdown);
    } catch (err) {
      if (id !== reqId.current) return;
      /*
       * Surfaced even on a SILENT load, unlike the billing poll. A failed poll
       * there leaves valid data on screen; a failed range switch leaves the OLD
       * window's numbers under the NEW button, and saying nothing would let the
       * customer read one range's figures as another's. The window actually
       * shown is printed under the heading from `detail.range`, so the two
       * together can never be silently mismatched.
       */
      setError(err instanceof Error ? err.message : 'Failed to load your usage');
    } finally {
      if (id === reqId.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void load('month');
  }, [load]);

  const selectRange = (next: RangeId) => {
    if (next === range) return;
    setRange(next);
    void load(next, { silent: true });
  };

  // Newest month first; the API's order isn't guaranteed.
  const history = [...(usage?.history ?? [])].sort((a, b) => b.period.localeCompare(a.period));
  /*
   * The allowance IS the 100% mark whenever there is one, because that is what
   * the note under the table says the bars mean. Scaling to the biggest month
   * instead drew an at-allowance month at 40% for anyone who had ever burst past
   * it; the width is clamped, so a month that ran over simply reads as full.
   */
  const limit = usage?.current.limit ?? 0;
  const peak = limit > 0 ? limit : Math.max(...history.map((h) => h.units), 1);

  const totals = detail?.totals;
  const byStatus = detail?.byStatus ?? [];
  /*
   * 429s ONLY, and NOT "every non-2xx" — the definition and the label both come
   * from `lib/usage-status`, which the admin panel reads too, so the two surfaces
   * cannot end up meaning different things by the same tile. The refunded 4xx
   * and 5xx classes keep their own rows in "By response", which names each one
   * and says the units came back.
   */
  const throttledRequests = rateLimitedRequests(byStatus);

  return (
    <div>
      <div className="portalHead">
        <div>
          <h1>Usage</h1>
          <p>
            What you used, day by day, per endpoint and per key.{' '}
            <Link href="/pricing#units">See what each endpoint costs</Link>.
          </p>
        </div>
        <div className="admin-row" role="group" aria-label="Usage window">
          {RANGES.map((option) => (
            <button
              key={option.id}
              type="button"
              className={`admin-btn sm${option.id === range ? '' : ' ghost'}`}
              aria-pressed={option.id === range}
              onClick={() => selectRange(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="admin-card">
          <SkeletonRows rows={4} />
        </div>
      ) : error && !detail ? (
        <ErrorNotice message={error} onRetry={() => void load(range)} />
      ) : usage && detail && totals ? (
        <>
          {/* A failed range switch that still has data behind it: the notice
              sits above the numbers it failed to replace, and the window line
              below says which range those numbers actually belong to. */}
          {error && <ErrorNotice message={error} onRetry={() => void load(range, { silent: true })} />}

          {/* ABOVE the range line on purpose. This card is the only thing on the
              page that answers "am I about to get 429'd", it carries the
              over-quota alert, and it is range-INDEPENDENT — always the current
              calendar month, whatever the selector says. Sitting outside the
              range-scoped block, with its month named, is what keeps its figure
              from reading as a second, contradictory total for the window. The
              overview page leads with the same component. */}
          <div className="admin-card">
            <h2 className="admin-h">Allowance · {formatPeriod(usage.current.period)}</h2>
            <QuotaMeter usage={usage.current} />
          </div>

          <p className="admin-note" aria-live="polite">
            {formatDay(detail.range.from)} – {formatDay(detail.range.to)}, UTC
            {refreshing && ' · updating…'}
          </p>

          {totals.requests === 0 ? (
            /* ONE empty state for the whole range-scoped block. Rendered in
               full, the tiles, the chart and the three breakdowns each say their
               own version of "nothing here" — roughly three phone screens of
               apology before the first thing the reader can act on. The
               allowance card and History stay: both are outside the range and
               both still have something to say. */
            <div className="admin-card">
              <EmptyState
                title="No metered calls in this range"
                hint={`Nothing was metered between ${formatDay(detail.range.from)} and ${formatDay(detail.range.to)}. Call an endpoint with one of your keys and it shows up here the same day.`}
                action={
                  <div className="admin-row">
                    <Link className="admin-btn" href="/portal/playground">
                      Try an endpoint
                    </Link>
                    <Link className="admin-btn ghost" href="/portal/keys">
                      Create an API key
                    </Link>
                  </div>
                }
              />
            </div>
          ) : (
            <>
              {/* The tiles and the caveat under them are one block — 18px to match
                  the `.admin-card` rhythm the rest of the page is on. Four across at
                  every width, including 375px, so the customer is not scrolling four
                  near-empty cards to reach the chart. */}
              <div className="mb-[18px]">
                <div className="grid grid-cols-4 gap-2 sm:gap-4">
                  <Metric label="Units" value={totals.units.toLocaleString()} />
                  <Metric label="Requests" value={totals.requests.toLocaleString()} />
                  <Metric
                    label={
                      <>
                        {/* Same figure, shorter name where a tile is ~80px wide. */}
                        <span className="sm:hidden">Units/req</span>
                        <span className="hidden sm:inline">Units per request</span>
                      </>
                    }
                    value={(totals.units / totals.requests).toFixed(2)}
                  />
                  <Metric
                    label={RATE_LIMITED_LABEL}
                    value={`${((throttledRequests / totals.requests) * 100).toFixed(1)}%`}
                    note={
                      <>
                        {throttledRequests.toLocaleString()} of {totals.requests.toLocaleString()}
                        <span className="hidden sm:inline"> requests</span>
                      </>
                    }
                  />
                </div>

                {/* The two halves of the average are measured differently — net
                    units over gross requests — and the tile cannot show that on its
                    own. A refunded call gives its units back and still counts as a
                    request, so this reads low over a range with errors in it. */}
                {/* Word for word what the admin panel says under the same four
                    tiles, so a support call about this figure is not two people
                    reading two different explanations of it. */}
                <p className="admin-note">
                  Units per request is net units over gross requests: a refunded call still
                  counts as a request.
                </p>
              </div>

              <div className="admin-card">
                <h2 className="admin-h">Units per day</h2>
                {/* The window, not the extent of the data: one busy day inside a
                    month must read as one bar on a month-wide axis. */}
                <UsageBarChart data={detail.series} from={detail.range.from} to={detail.range.to} />
              </div>

              <div className="admin-card">
                <h2 className="admin-h">By endpoint</h2>
                {detail.byRoute.length === 0 ? (
                  <EmptyState
                    title="No metered calls in this range"
                    hint="Send a request with one of your keys and the endpoint it hit shows up here the same day."
                    action={
                      <Link className="admin-btn" href="/portal/playground">
                        Try an endpoint
                      </Link>
                    }
                  />
                ) : (
                  <div className="tableWrap stackTableWrap">
                    {/* The only breakdown here too wide to stay a table on a
                        phone: five columns need ~507px against the ~293px this
                        card leaves. `cardTable routeCards` turns each row into a
                        two-line card below 720px — name and units on the first
                        line, everything else joined on one 11px line under it —
                        and `data-cell` names the grid area each cell lands in.

                        `max-[721px]:`, not `max-[720px]:`, everywhere on this
                        page. Tailwind compiles `max-[N]` to `not all and
                        (min-width: N)`, i.e. width < N, while the card CSS is a
                        plain `max-width: 720px` — so at EXACTLY 720px the 720
                        variant is off while the cards are on, which put two
                        cells in one grid area on top of each other. 721 makes
                        the two agree. */}
                    <table className="admin-table cardTable routeCards">
                      <thead>
                        <tr>
                          <th>Endpoint</th>
                          <th>Cost</th>
                          <th>Requests</th>
                          {/* The bar restates the Units figure two cells along,
                              and it is the widest column that carries nothing of
                              its own — the first thing to go on a phone. */}
                          <th className="max-[721px]:hidden" style={{ width: '30%' }}>
                            Share of units
                          </th>
                          <th>Units</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detail.byRoute.map((row) => (
                          <tr key={row.routeKey}>
                            <td data-cell="identity" data-label="Endpoint">
                              <div className="max-[721px]:truncate max-[721px]:text-[0.8125rem]">
                                {row.label}
                              </div>
                              <div
                                className="mono max-[721px]:hidden"
                                style={{ fontSize: 11, opacity: 0.65 }}
                              >
                                {row.routeKey}
                              </div>
                            </td>
                            {/* Cost owns the card's second line, because that
                                line is one string: the request count, the cost
                                and the route key, which are three short values
                                that each cost a whole labelled row of their own
                                when stacked. The pill and the Requests cell are
                                the same figures at desktop width.

                                The two FIGURES lead and the route key trails,
                                because the line is wider than the card at both
                                real route keys (330px and 389px of mono against
                                287px) and the cell clips its tail. What clips has
                                to be the part the card can afford to lose: the
                                label directly above already names this endpoint,
                                while the request count and the cost appear
                                nowhere else below 720px. */}
                            <td data-cell="sub" data-label="Cost">
                              <span className="admin-pill max-[721px]:hidden">
                                {row.unitCost} {row.unitCost === 1 ? 'unit' : 'units'} / call
                              </span>
                              <span
                                className="mono hidden max-[721px]:inline"
                                style={{ fontSize: 11, opacity: 0.65 }}
                                title={`${row.requests.toLocaleString()} requests · ${row.unitCost} ${row.unitCost === 1 ? 'unit' : 'units'} per call · ${row.routeKey}`}
                              >
                                {row.requests.toLocaleString()} req · {row.unitCost}
                                {row.unitCost === 1 ? ' unit' : ' units'}/call · {row.routeKey}
                              </span>
                            </td>
                            <td
                              data-cell="sub"
                              data-label="Requests"
                              className="mono max-[721px]:hidden"
                            >
                              {row.requests.toLocaleString()}
                            </td>
                            <td data-label="Share of units" className="max-[721px]:hidden">
                              <div className="monthBar">
                                <div
                                  className="monthBarFill"
                                  style={{
                                    width: `${totals.units > 0 ? Math.min(100, (row.units / totals.units) * 100) : 0}%`,
                                  }}
                                />
                              </div>
                            </td>
                            <td
                              data-cell="figure"
                              data-label="Units"
                              className="mono max-[721px]:text-right max-[721px]:text-[0.8125rem]"
                            >
                              {row.units.toLocaleString()}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              {/* COLUMN gap only: `.admin-card` already carries `margin-bottom:
                  18px`, so a row gap would double the spacing below this pair and
                  between the two cards when they stack on mobile. */}
              <div className="grid md:grid-cols-2 md:gap-x-[18px]">
                <div className="admin-card">
                  <h2 className="admin-h">By API key</h2>
                  {detail.byKey.length === 0 ? (
                    <p className="admin-note">No key made a metered call in this range.</p>
                  ) : (
                    /* A real table at every width: a label and two numbers fit
                       the width a phone leaves inside this card, where stacked
                       they were three labelled blocks per key. The fit is thin
                       enough to need the padding trim below. */
                    <div className="tableWrap stackTableWrap">
                      <table className="admin-table">
                        <thead>
                          <tr>
                            <th>Key</th>
                            {/* Half the cell padding below 720px on the two
                                numeric columns. Untrimmed, this table's
                                min-content is 292.9px against the 293px a phone
                                leaves inside the card — it fits by a tenth of a
                                pixel, and `.tableWrap` has no scroll to fall back
                                on at that width. Trimming 6px a side off two
                                columns takes it to 268.9px, which is slack a font
                                metric can move around in. */}
                            <th className="max-[721px]:px-1.5">Requests</th>
                            <th className="max-[721px]:px-1.5">Units</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.byKey.map((row) => (
                            <tr key={row.apiKeyId}>
                              <td>
                                {/* Both are snapshotted per bucket, so a key that
                                    has since been deleted still names itself. */}
                                <div>{row.keyLabel || 'Unlabelled key'}</div>
                                {row.keyPrefix && (
                                  /* Clipped with an ellipsis rather than wrapped.
                                     A prefix is 16 characters by construction
                                     (`api-key.util.ts` slices it), which is what
                                     the width above is measured against; this is
                                     the guard for the day that changes, since a
                                     prefix has no break opportunity and would
                                     otherwise widen the column or escape into the
                                     body clip. */
                                  <div
                                    className="mono overflow-hidden text-ellipsis whitespace-nowrap"
                                    style={{ fontSize: 11, opacity: 0.65 }}
                                  >
                                    {row.keyPrefix}
                                  </div>
                                )}
                              </td>
                              <td className="mono max-[721px]:px-1.5">
                                {row.requests.toLocaleString()}
                              </td>
                              <td className="mono max-[721px]:px-1.5">
                                {row.units.toLocaleString()}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  <p className="admin-note">
                    The <Link href="/portal/playground">playground</Link> sends real requests with the
                    key you paste into it, from our server, so anything you try there lands on that key
                    here alongside your own traffic.
                  </p>
                </div>

                <div className="admin-card">
                  <h2 className="admin-h">By response</h2>
                  {byStatus.length === 0 ? (
                    <p className="admin-note">No responses in this range.</p>
                  ) : (
                    /* Also a real table on a phone. The widest thing in it is a
                       wrapping sentence, which costs height, not width. */
                    <div className="tableWrap stackTableWrap">
                      <table className="admin-table">
                        <thead>
                          <tr>
                            <th>Response</th>
                            <th>Requests</th>
                            <th>Units</th>
                          </tr>
                        </thead>
                        <tbody>
                          {/* Rendered in the order the server sent, which it sorts
                              deliberately — sorting the class strings here would put
                              429 between 2xx and 4xx and read as an error family. */}
                          {byStatus.map((row) => {
                            const copy = STATUS_COPY[row.statusClass];
                            return (
                              <tr key={row.statusClass}>
                                <td>
                                  <div>
                                    <span className="mono">{row.statusClass}</span>
                                    {copy && ` · ${copy.label}`}
                                  </div>
                                  {copy && (
                                    <div style={{ fontSize: 11, opacity: 0.65 }}>{copy.note}</div>
                                  )}
                                </td>
                                <td className="mono">{row.requests.toLocaleString()}</td>
                                <td className="mono">{row.units.toLocaleString()}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

          <div className="admin-card">
            <h2 className="admin-h">History</h2>
            {history.length === 0 ? (
              <EmptyState
                title="No usage recorded yet"
                hint="Once a request lands with one of your keys, the month it fell in shows up here."
                action={
                  <Link className="admin-btn" href="/portal/keys">
                    Create an API key
                  </Link>
                }
              />
            ) : (
              /* A real table on a phone once the bar column goes. All four
                 columns need ~325px against the ~293px this card leaves, and
                 `.tableWrap` has no scroll to fall back on at that width — but
                 the bar is 95px of that and says nothing the Units cell two
                 places to its left does not. */
              <div className="tableWrap stackTableWrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>Month</th>
                      <th>Requests</th>
                      <th>Units</th>
                      <th className="max-[721px]:hidden" style={{ width: '40%' }}>
                        Share of allowance
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((row) => (
                      <tr key={row.period}>
                        <td>{formatPeriod(row.period)}</td>
                        <td className="mono">{row.requests.toLocaleString()}</td>
                        <td className="mono">{row.units.toLocaleString()}</td>
                        <td className="max-[721px]:hidden">
                          <div className="monthBar">
                            <div
                              className="monthBarFill"
                              style={{ width: `${Math.min(100, (row.units / peak) * 100)}%` }}
                            />
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {/* The monthly rollup is kept alongside the breakdown because it
                reaches further back: the detail above is capped at a 92-day
                window and its buckets are dropped after ~13 months, while these
                snapshots are the whole life of the account. */}
            <p className="admin-note">
              Every month since you signed up.{' '}
              {/* Both wordings describe the bar column, which is not on screen
                  below 720px — printed there anyway, the note explains a thing
                  the reader cannot see. The allowance it names is on the
                  allowance card at the top of the page either way. */}
              <span className="max-[721px]:hidden">
                {limit > 0
                  ? `Bars are relative to your current monthly allowance (${limit.toLocaleString()} units), so a month that ran over reads as full.`
                  : 'Your plan has no monthly ceiling, so bars are relative to your biggest month.'}
              </span>
            </p>
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * One headline figure. Same treatment as the overview page's `Stat` from `sm`
 * up; below it, four of these share a 375px row, so type, padding and gaps all
 * step down.
 *
 * The label keeps a two-line box on the small step. Grid tracks already stretch
 * to equal height, so a label that wraps does not break the row — it drops that
 * tile's value a line below its neighbours', which on four adjacent figures
 * reads as a rendering fault. Reserving the second line everywhere keeps the
 * values on one baseline whatever the wording does.
 */
function Metric({ label, value, note }: { label: ReactNode; value: string; note?: ReactNode }) {
  return (
    <div className="rounded-lg border border-border/60 bg-surface-2/50 p-2 sm:p-4">
      <div className="min-h-[25px] text-[10px] uppercase leading-tight tracking-wide text-muted-foreground sm:min-h-0 sm:text-xs sm:tracking-widest">
        {label}
      </div>
      {/* `break-all` on the small step only: a seven-figure unit count is wider
          than an 80px tile, and a number wrapped onto a second line is a worse
          look but an honest one — painted over the tile beside it, or truncated
          to "1,284…", it stops being the figure. */}
      <div className="mt-1 break-all font-display text-sm font-semibold leading-tight sm:break-normal sm:text-xl">
        {value}
      </div>
      {note && (
        <div className="mt-1 text-[10px] leading-tight text-muted-foreground sm:text-xs">{note}</div>
      )}
    </div>
  );
}
