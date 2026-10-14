'use client';

import { AlertTriangle } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { EmptyState, InlineError, SkeletonBlock } from '@/components/DataState';
import { adminApi, type AdminPaymentRail, type AdminRevenue } from '@/lib/admin-api';
import { formatMoneyMinor } from '@/lib/format';

/*
 * `GET /admin/revenue`.
 *
 * WHAT IS DELIBERATELY ABSENT, because the endpoint does not return it:
 *
 *  - A monthly paid-vs-pending BAR SERIES. There is no time series in this
 *    response at all — `last30Days` is a single ROLLING window (rolling and not
 *    a calendar month on purpose: the calendar version reads as a collapse on
 *    the 1st of every month and nobody can tell it from a real one). A chart
 *    here would have to be generated, and a generated chart on a revenue screen
 *    is a lie with axes on it.
 *  - Period-over-period DELTAS (`+12%`, `-1`). Nothing in the response describes
 *    a previous period, so every one of them would be invented.
 *
 * What IS here is everything the endpoint returns: MRR, ARR, the live count, the
 * 30-day window, the by-plan split, the unapplied-payment count and the live rails.
 */
export default function AdminRevenuePage() {
  const load = useLoad(() => adminApi.getRevenue(), 'Could not load revenue.');

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl font-semibold">Revenue</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Computed from live subscriptions&apos; own locked amounts — not from the plans&apos;
          current prices, so repricing a plan does not move this number.
        </p>
      </div>

      {load.status === 'error' ? (
        <InlineError message={load.error} onRetry={load.retry} />
      ) : load.status === 'loading' || !load.data ? (
        <>
          <SkeletonBlock className="h-20" />
          <div className="grid gap-4 md:grid-cols-3">
            {Array.from({ length: 3 }, (_, i) => (
              <SkeletonBlock key={i} className="h-28" />
            ))}
          </div>
          <SkeletonBlock className="h-40" />
          <SkeletonBlock className="h-56" />
        </>
      ) : (
        <Populated data={load.data} />
      )}
    </div>
  );
}

function Populated({ data }: { data: AdminRevenue }) {
  const { last30Days, byPlan, rails, unappliedPayments } = data;

  return (
    <>
      {/*
       * Unapplied payments sit ABOVE the KPIs, not in a footnote. MRR being up is
       * not the most important thing on this screen if there is money sitting
       * collected that nobody has been given anything for.
       */}
      {unappliedPayments > 0 ? (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-xl border border-destructive/40 bg-destructive/10 p-5 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
            <div>
              <div className="font-display text-xl font-semibold">
                {unappliedPayments} payment{unappliedPayments === 1 ? '' : 's'} collected and not
                honoured
              </div>
              <p className="mt-1 text-sm text-muted-foreground">
                A payment with no <span className="font-mono text-xs">appliedAt</span> is money we
                have taken that has granted the customer nothing. This is the number to act on
                before any of the ones below.
              </p>
            </div>
          </div>
          <Link
            href="/admin/payments"
            className="shrink-0 self-start rounded-md border border-destructive/40 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/10 sm:self-auto"
          >
            Open the ledger
          </Link>
        </div>
      ) : (
        <div className="rounded-xl border border-success/40 bg-success/10 p-4 text-sm">
          <span className="font-medium">No unapplied payments.</span>{' '}
          <span className="text-muted-foreground">
            Everything collected has been folded into an invoice and an entitlement.
          </span>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <Kpi label="MRR" value={formatMoneyMinor(data.mrrMinor)} note="annuals divided to monthly" />
        <Kpi label="ARR" value={formatMoneyMinor(data.arrMinor)} note="12 × MRR, not a separate measure" />
        <Kpi
          label="Live subscriptions"
          value={String(data.liveSubscriptions)}
          note="active · past due · trialing"
        />
      </div>

      <div className="rounded-xl border border-border/60 bg-surface p-6 shadow-card">
        <div className="text-xs uppercase tracking-widest text-muted-foreground">
          Last 30 days · rolling
        </div>
        <div className="mt-4 grid gap-6 sm:grid-cols-3">
          <Figure label="New subscriptions" value={String(last30Days.newSubscriptions)} />
          <Figure label="Churned" value={String(last30Days.churnedSubscriptions)} />
          <Figure label="Collected" value={formatMoneyMinor(last30Days.collectedMinor)} />
        </div>
        <p className="mt-4 text-xs text-muted-foreground">
          A rolling window, not a calendar month, and the endpoint returns no earlier window to
          compare it against — so there is no trend line or percentage change here to show.
        </p>
      </div>

      <div className="overflow-hidden rounded-xl border border-border/60 bg-surface shadow-card">
        <div className="border-b border-border/60 px-6 py-4 text-xs uppercase tracking-widest text-muted-foreground">
          By plan
        </div>
        {byPlan.length === 0 ? (
          <EmptyState
            title="No paid plans live"
            body="Every account is on a free plan, so there is no MRR to split."
          />
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-[0.625rem] uppercase tracking-widest text-muted-foreground">
              <tr className="border-b border-border/60">
                <th className="px-6 py-3">Plan</th>
                <th className="px-6 py-3">Subscriptions</th>
                <th className="px-6 py-3">MRR</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {byPlan.map((p) => (
                <tr key={p.planKey}>
                  <td className="px-6 py-3">
                    {p.planName}
                    <span className="ml-2 font-mono text-[0.625rem] text-muted-foreground">
                      {p.planKey}
                    </span>
                  </td>
                  <td className="px-6 py-3 font-mono">{p.subscriptions}</td>
                  <td className="px-6 py-3 font-mono">{formatMoneyMinor(p.mrrMinor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="rounded-xl border border-border/60 bg-surface p-6 shadow-card">
        <div className="text-xs uppercase tracking-widest text-muted-foreground">
          Live payment rails
        </div>
        {rails.length === 0 ? (
          <EmptyState
            title="No rail is configured"
            body="Nothing can be bought: every self-serve upgrade is refused until a rail is live."
          />
        ) : (
          <div className="mt-4 flex flex-wrap gap-3">
            {rails.map((rail) => (
              <RailCard key={rail.key} rail={rail} />
            ))}
          </div>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        Money is stored as integer minor units and divided by 100 once, here at the render site.{' '}
        <span className="font-mono">/admin/revenue</span> carries no currency of its own —
        subscriptions bill in the invoice currency, USD.
      </p>
    </>
  );
}

/**
 * A rail and what it can do. Rendered because the capability set is what decides
 * whether anything auto-renews, whether a webhook body can be trusted, and
 * whether settlement can differ from the amount asked for — all of which change
 * how the numbers above should be read.
 */
function RailCard({ rail }: { rail: AdminPaymentRail }) {
  const caps = [
    rail.capabilities.hostedCheckout && 'hosted checkout',
    rail.capabilities.onChainDirect && 'on-chain direct',
    rail.capabilities.recurring ? 'auto-renews' : 'renewed by the sweep',
    rail.capabilities.webhooks ? 'webhooks' : 'no webhook',
    rail.capabilities.webhooks && !rail.capabilities.bodySignature && 'unsigned body',
    rail.capabilities.variableSettlement && 'variable settlement',
  ].filter((c): c is string => typeof c === 'string');

  return (
    <div className="rounded-lg border border-border/60 bg-surface-2 px-4 py-3">
      <div className="font-mono text-sm">{rail.key}</div>
      <div className="mt-2 flex flex-wrap gap-1">
        {caps.map((c) => (
          <span
            key={c}
            className="rounded-full border border-border/60 px-2 py-0.5 text-[0.625rem] text-muted-foreground"
          >
            {c}
          </span>
        ))}
      </div>
    </div>
  );
}

function Kpi({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-xl border border-border/60 bg-surface p-6 shadow-card">
      <div className="text-xs uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="mt-1 font-display text-2xl font-semibold">{value}</div>
      <div className="mt-1 text-[0.625rem] text-muted-foreground">{note}</div>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[0.625rem] uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="mt-1 font-display text-xl font-semibold">{value}</div>
    </div>
  );
}

// ─── Local atoms (see the note in ../subscriptions/page.tsx) ─────────────────

/** Loading / error / ready for one request that takes no parameters. */
function useLoad<T>(fetcher: () => Promise<T>, fallback: string) {
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
  }, [attempt, fallback]);

  return { ...state, retry: () => setAttempt((a) => a + 1) };
}
