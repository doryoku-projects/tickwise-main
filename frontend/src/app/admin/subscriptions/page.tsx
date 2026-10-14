'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { Pagination, usePagination } from '@/components/admin/Pagination';
import { EmptyState, InlineError, SkeletonRows } from '@/components/DataState';
import { adminApi, type AdminSubscription, type AdminSubscriptionStatus } from '@/lib/admin-api';
import { formatMoneyMinor, formatUtcDate } from '@/lib/format';

/*
 * `GET /admin/subscriptions` — the raw Subscription documents, filtered by the
 * server on `status` / `customerId` / `limit`.
 *
 * Every column below is a field the endpoint actually returns. There is no
 * summary row of MRR/ARR here even though the Tickwise reference has one: this
 * response is a PAGE (server-capped at 200), so any total computed from it
 * would be a total of whatever happened to be fetched. MRR lives on /admin/revenue,
 * which computes it over every live subscription.
 */

/** The statuses the picker offers. `live` is the server's own alias for the non-terminal set. */
const STATUS_OPTIONS = [
  { value: '', label: 'All statuses' },
  { value: 'live', label: 'Live (incomplete · trialing · active · past due)' },
  { value: 'active', label: 'Active' },
  { value: 'trialing', label: 'Trialing' },
  { value: 'past_due', label: 'Past due' },
  { value: 'incomplete', label: 'Incomplete' },
  { value: 'unpaid', label: 'Unpaid (grace expired)' },
  { value: 'canceled', label: 'Canceled' },
  { value: 'incomplete_expired', label: 'Incomplete · expired' },
];

const LIMITS = [50, 100, 200];

export default function AdminSubscriptionsPage() {
  const [status, setStatus] = useState('live');
  const [limit, setLimit] = useState(50);
  /** The table's own top, so turning the page lands there and not at its foot. */
  const tableRef = useRef<HTMLDivElement>(null);

  const load = useLoad(
    `${status}:${limit}`,
    () => adminApi.listSubscriptions({ status: status || undefined, limit }),
    'Could not load subscriptions.',
  );

  const rows = load.data ?? [];
  // Keyed on the same string as the fetch, so changing either filter is page 1.
  const paged = usePagination(rows, { resetKey: `${status}:${limit}` });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="font-display text-3xl font-semibold">Subscriptions</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Every subscription row as the billing core stores it. Read-only — status changes go
            through <span className="font-mono text-xs">mark-status</span>, which is not wired here.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select
            className="h-8 rounded-md border border-input bg-surface px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
            aria-label="Filter by status"
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <select
            className="h-8 rounded-md border border-input bg-surface px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            aria-label="Rows to fetch"
          >
            {LIMITS.map((n) => (
              <option key={n} value={n}>
                Last {n}
              </option>
            ))}
          </select>
        </div>
      </div>

      {load.status === 'error' ? (
        <InlineError message={load.error} onRetry={load.retry} />
      ) : (
        <div className="overflow-hidden rounded-xl border border-border/60 bg-surface shadow-card">
          <div className="overflow-x-auto" ref={tableRef}>
            <table className="w-full min-w-[64rem] text-sm">
              <thead className="text-left text-[0.625rem] uppercase tracking-widest text-muted-foreground">
                <tr className="border-b border-border/60">
                  <th className="px-4 py-3">Subscription</th>
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3">Plan</th>
                  <th className="px-4 py-3">Amount</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Current period</th>
                  <th className="px-4 py-3">Rail</th>
                </tr>
              </thead>
              {load.status === 'ready' && rows.length > 0 && (
                <tbody className="divide-y divide-border/60">
                  {paged.pageItems.map((s) => (
                    <tr key={s._id} className="align-top">
                      <td className="px-4 py-3">
                        <Link
                          href={`/admin/subscriptions/${s._id}`}
                          className="font-mono text-xs text-primary hover:underline"
                          title={s._id}
                        >
                          {shortId(s._id)}
                        </Link>
                        <div className="mt-0.5 text-[0.625rem] text-muted-foreground">
                          started {formatUtcDate(s.startedAt)}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          href={`/admin/clients/${s.customerId}`}
                          className="font-mono text-xs text-primary hover:underline"
                          title={s.customerId}
                        >
                          {shortId(s.customerId)}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        <div>{s.planKey}</div>
                        <div className="font-mono text-[0.625rem] text-muted-foreground">
                          {s.priceId}
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono">
                        {formatMoneyMinor(s.unitAmountMinor)}
                        <span className="text-muted-foreground">
                          /{s.interval === 'year' ? 'yr' : 'mo'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <SubscriptionStatusPill status={s.status} />
                        <SubscriptionFlags subscription={s} />
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                        {formatUtcDate(s.currentPeriodStart)}
                        <div>→ {formatUtcDate(s.currentPeriodEnd)}</div>
                      </td>
                      <td className="px-4 py-3 text-xs text-muted-foreground">{s.provider}</td>
                    </tr>
                  ))}
                </tbody>
              )}
            </table>
          </div>

          {/* Inside the card, under the table it belongs to — the border-top it
              draws is the table's own bottom rule. */}
          {load.status === 'ready' && (
            <Pagination state={paged} label="subscriptions" scrollTo={tableRef} />
          )}

          {load.status === 'loading' && (
            <div className="px-4">
              <SkeletonRows rows={5} lines={2} />
            </div>
          )}

          {load.status === 'ready' && rows.length === 0 && (
            <EmptyState
              title="No subscriptions match"
              body={
                status
                  ? 'Nothing is in this status right now — widen the filter to see the rest.'
                  : 'Nothing has ever subscribed. A row appears here the moment a checkout is raised, before any money arrives.'
              }
              action={
                status ? (
                  <button
                    type="button"
                    className="text-xs text-primary hover:underline"
                    onClick={() => setStatus('')}
                  >
                    Show every status
                  </button>
                ) : undefined
              }
            />
          )}
        </div>
      )}

      {/* "fetched", not "page": the pager under the table now owns the word
          "page", and the 200 is a ceiling on how many rows exist HERE at all —
          paging through them does not reach past it. */}
      {load.status === 'ready' && rows.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {rows.length} row{rows.length === 1 ? '' : 's'} fetched, newest first — the server caps a
          fetch at 200, so nothing older is reachable from this screen whichever page you are on.
          Amounts are the subscription&apos;s own locked{' '}
          <span className="font-mono">unitAmountMinor</span> in USD, not the plan&apos;s current
          price.
        </p>
      )}
    </div>
  );
}

/**
 * The states this row is in beyond its status word: a scheduled cancellation, a
 * live grace window, a scheduled plan change, an overdue renewal. Each one is a
 * field the endpoint returns and each one changes what an operator should do.
 */
function SubscriptionFlags({ subscription }: { subscription: AdminSubscription }) {
  const notes: string[] = [];
  if (subscription.cancelAtPeriodEnd) notes.push('cancels at period end');
  if (subscription.graceEndsAt) notes.push(`grace ends ${formatUtcDate(subscription.graceEndsAt)}`);
  if (subscription.lateByDays > 0) notes.push(`${subscription.lateByDays}d late`);
  if (subscription.pendingPlanKey) {
    notes.push(
      `→ ${subscription.pendingPlanKey}${
        subscription.pendingEffectiveAt
          ? ` on ${formatUtcDate(subscription.pendingEffectiveAt)}`
          : ' (awaiting payment)'
      }`,
    );
  }
  if (notes.length === 0) return null;
  return (
    <div className="mt-1 space-y-0.5 text-[0.625rem] text-muted-foreground">
      {notes.map((n) => (
        <div key={n}>{n}</div>
      ))}
    </div>
  );
}

// ─── Local atoms ─────────────────────────────────────────────────────────────
//
// NOT exported, and each billing view carries its own copy. Two reasons: this
// repo has no shared admin-view module (the existing panel pages each hand-roll
// their loading), and a `page.tsx` may only export the default component plus
// Next's own config fields — an exported helper here is a build error, not a
// style question.

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

const SUBSCRIPTION_TONES: Record<string, string> = {
  active: 'border-success/40 bg-success/10 text-success',
  trialing: 'border-success/40 bg-success/10 text-success',
  past_due: 'border-warning/40 bg-warning/10 text-warning',
  incomplete: 'border-warning/40 bg-warning/10 text-warning',
  unpaid: 'border-destructive/40 bg-destructive/10 text-destructive',
};

function SubscriptionStatusPill({ status }: { status: AdminSubscriptionStatus }) {
  const tone = SUBSCRIPTION_TONES[status] ?? 'border-border/60 bg-surface-2 text-muted-foreground';
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-[0.625rem] ${tone}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

/**
 * Loading / error / ready for one request, re-run whenever `key` changes.
 *
 * `key` rather than a dependency array so a filter change is a re-fetch by
 * construction: the fetcher is an inline arrow (new every render) and is held
 * in a ref, which is what stops it re-fetching forever.
 */
function useLoad<T>(key: string, fetcher: () => Promise<T>, fallback: string) {
  const [state, setState] = useState<{
    status: 'loading' | 'error' | 'ready';
    data: T | null;
    error: string;
  }>({ status: 'loading', data: null, error: '' });
  const [attempt, setAttempt] = useState(0);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    let active = true;
    setState({ status: 'loading', data: null, error: '' });
    fetcherRef
      .current()
      .then((data) => {
        if (active) setState({ status: 'ready', data, error: '' });
      })
      .catch((err: unknown) => {
        if (!active) return;
        setState({
          status: 'error',
          data: null,
          error: err instanceof Error ? err.message : fallback,
        });
      });
    return () => {
      active = false;
    };
  }, [key, attempt, fallback]);

  return { ...state, retry: () => setAttempt((a) => a + 1) };
}
