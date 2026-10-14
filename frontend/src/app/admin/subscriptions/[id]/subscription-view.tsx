'use client';

import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { EmptyState, InlineError, SkeletonBlock, SkeletonRows } from '@/components/DataState';
import {
  adminApi,
  type AdminInvoice,
  type AdminInvoiceStatus,
  type AdminPayment,
  type AdminPaymentStatus,
  type AdminSubscriptionDetail,
  type AdminSubscriptionStatus,
} from '@/lib/admin-api';
import { formatMoneyMinor, formatUtcDate } from '@/lib/format';

/*
 * `GET /admin/subscriptions/:id` → `{ subscription, invoices, payments }`.
 *
 * The three come back together because they are one story: what was sold, what
 * was billed for it, and what actually arrived. Money is rendered from each
 * document's OWN `currency` where it has one (invoices and payments do);
 * the subscription document carries no currency field, so its locked
 * `unitAmountMinor` is shown in the USD the invoices are drawn in.
 */
export function AdminSubscriptionDetailView({ id }: { id: string }) {
  const load = useLoad(
    id,
    () => adminApi.getSubscription(id),
    'Could not load this subscription.',
  );

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/subscriptions"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3 w-3" /> All subscriptions
        </Link>
        <h1 className="mt-2 font-display text-3xl font-semibold">Subscription</h1>
        <div className="mt-1 font-mono text-xs text-muted-foreground">{id}</div>
      </div>

      {load.status === 'error' ? (
        <InlineError message={load.error} onRetry={load.retry} />
      ) : load.status === 'loading' || !load.data ? (
        <>
          <div className="grid gap-4 md:grid-cols-4">
            {Array.from({ length: 4 }, (_, i) => (
              <SkeletonBlock key={i} className="h-24" />
            ))}
          </div>
          <SkeletonBlock className="h-48" />
          <Panel title="Invoices">
            <SkeletonRows rows={2} lines={1} />
          </Panel>
          <Panel title="Payments">
            <SkeletonRows rows={2} lines={1} />
          </Panel>
        </>
      ) : (
        <Populated detail={load.data} />
      )}
    </div>
  );
}

function Populated({ detail }: { detail: AdminSubscriptionDetail }) {
  const { subscription: s, invoices, payments } = detail;
  const unapplied = payments.filter((p) => !p.appliedAt);

  return (
    <>
      {unapplied.length > 0 && (
        <div
          role="alert"
          className="rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm"
        >
          <div className="font-medium">
            {unapplied.length} payment{unapplied.length === 1 ? '' : 's'} on this subscription
            {unapplied.length === 1 ? ' has' : ' have'} not been applied
          </div>
          <p className="mt-1 text-muted-foreground">
            Money recorded against this subscription that has granted nothing yet. The
            reconcile job normally clears this within its interval.
          </p>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-4">
        <Stat label="Plan" value={s.planKey} sub={s.priceId} />
        <Stat
          label="Amount"
          value={`${formatMoneyMinor(s.unitAmountMinor)}/${s.interval === 'year' ? 'yr' : 'mo'}`}
          sub="locked at subscribe time"
        />
        <Stat label="Status" value={s.status.replace(/_/g, ' ')} sub={`rail · ${s.provider}`} />
        <Stat
          label="Period ends"
          value={formatUtcDate(s.currentPeriodEnd)}
          sub={`from ${formatUtcDate(s.currentPeriodStart)}`}
        />
      </div>

      <div className="rounded-xl border border-border/60 bg-surface p-6 shadow-card">
        <div className="flex flex-wrap items-center gap-3">
          <SubscriptionStatusPill status={s.status} />
          {s.cancelAtPeriodEnd && (
            <span className="rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-[0.625rem] text-warning">
              cancels at period end
            </span>
          )}
        </div>
        <dl className="mt-4 grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Customer">
            <Link
              href={`/admin/clients/${s.customerId}`}
              className="font-mono text-xs text-primary hover:underline"
            >
              {s.customerId}
            </Link>
          </Field>
          <Field label="Rail">
            <span className="text-xs">
              {s.provider}
              {s.providerSubscriptionId ? ` · ${s.providerSubscriptionId}` : ''}
            </span>
          </Field>
          <Field label="Started">
            <Mono>{formatUtcDate(s.startedAt)}</Mono>
          </Field>
          <Field label="Grace">
            <span className="text-xs">
              {s.graceDays} day{s.graceDays === 1 ? '' : 's'}
              {s.graceEndsAt ? ` · ends ${formatUtcDate(s.graceEndsAt)}` : ''}
            </span>
          </Field>
          <Field label="Late by">
            <Mono>{s.lateByDays} days</Mono>
          </Field>
          {s.trialEndsAt && (
            <Field label="Trial ends">
              <Mono>{formatUtcDate(s.trialEndsAt)}</Mono>
            </Field>
          )}
          {s.pendingPlanKey && (
            <Field label="Scheduled change">
              <span className="text-xs">
                → {s.pendingPlanKey}
                {s.pendingPriceId ? ` (${s.pendingPriceId})` : ''}
                {s.pendingEffectiveAt
                  ? ` on ${formatUtcDate(s.pendingEffectiveAt)}`
                  : ' — awaiting payment'}
              </span>
            </Field>
          )}
          {s.canceledAt && (
            <Field label="Cancellation requested">
              <Mono>{formatUtcDate(s.canceledAt)}</Mono>
            </Field>
          )}
          {s.cancellationReason && (
            <Field label="Reason">
              <span className="text-xs">{s.cancellationReason}</span>
            </Field>
          )}
          {s.endedAt && (
            <Field label="Access ended">
              <Mono>{formatUtcDate(s.endedAt)}</Mono>
            </Field>
          )}
          {s.latestInvoiceId && (
            <Field label="Latest invoice">
              <Mono>{s.latestInvoiceId}</Mono>
            </Field>
          )}
        </dl>
        <p className="mt-4 text-xs text-muted-foreground">
          Read-only. <span className="font-mono">mark-status</span> writes this row&apos;s status and
          nothing else — it grants no plan — and it is not wired into this panel.
        </p>
      </div>

      <Panel title={`Invoices · ${invoices.length}`}>
        {invoices.length === 0 ? (
          <EmptyState
            title="No invoices"
            body="Nothing has been billed against this subscription yet."
          />
        ) : (
          <InvoiceTable invoices={invoices} />
        )}
      </Panel>

      <Panel title={`Payments · ${payments.length}`}>
        {payments.length === 0 ? (
          <EmptyState
            title="No payments"
            body="No attempt to settle any of these invoices has been recorded."
          />
        ) : (
          <PaymentTable payments={payments} />
        )}
      </Panel>
    </>
  );
}

function InvoiceTable({ invoices }: { invoices: AdminInvoice[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[52rem] text-sm">
        <thead className="text-left text-[0.625rem] uppercase tracking-widest text-muted-foreground">
          <tr className="border-b border-border/60">
            <th className="px-4 py-3">No.</th>
            <th className="px-4 py-3">Period</th>
            <th className="px-4 py-3">Plan</th>
            <th className="px-4 py-3">Subtotal</th>
            <th className="px-4 py-3">Credit</th>
            <th className="px-4 py-3">Due</th>
            <th className="px-4 py-3">Paid</th>
            <th className="px-4 py-3">Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {invoices.map((i) => (
            <tr key={i._id}>
              <td className="px-4 py-3 font-mono text-xs">#{i.number}</td>
              <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                {formatUtcDate(i.periodStart)}
                <div>→ {formatUtcDate(i.periodEnd)}</div>
              </td>
              <td className="px-4 py-3">{i.planKey}</td>
              <td className="px-4 py-3 font-mono">
                {formatMoneyMinor(i.subtotalMinor, i.currency)}
              </td>
              <td className="px-4 py-3 font-mono text-muted-foreground">
                {i.creditAppliedMinor > 0 ? formatMoneyMinor(i.creditAppliedMinor, i.currency) : '—'}
              </td>
              <td className="px-4 py-3 font-mono">
                {formatMoneyMinor(i.amountDueMinor, i.currency)}
              </td>
              <td className="px-4 py-3 font-mono">
                {formatMoneyMinor(i.amountPaidMinor, i.currency)}
              </td>
              <td className="px-4 py-3">
                <InvoiceStatusPill status={i.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PaymentTable({ payments }: { payments: AdminPayment[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[56rem] text-sm">
        <thead className="text-left text-[0.625rem] uppercase tracking-widest text-muted-foreground">
          <tr className="border-b border-border/60">
            <th className="px-4 py-3">Received</th>
            <th className="px-4 py-3">Rail · charge</th>
            <th className="px-4 py-3">Amount</th>
            <th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Applied</th>
            <th className="px-4 py-3">On chain</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60">
          {payments.map((p) => (
            <tr key={p._id} className="align-top">
              <td className="px-4 py-3 font-mono text-xs">{formatUtcDate(p.receivedAt)}</td>
              <td className="px-4 py-3">
                <div className="text-xs">{p.provider}</div>
                <div
                  className="font-mono text-[0.625rem] text-muted-foreground"
                  title={p.providerPaymentId}
                >
                  {shortId(p.providerPaymentId)}
                </div>
              </td>
              <td className="px-4 py-3 font-mono">
                {formatMoneyMinor(p.amountMinor, p.currency)}
                {p.overpaidMinor > 0 && (
                  <div className="text-[0.625rem] text-muted-foreground">
                    +{formatMoneyMinor(p.overpaidMinor, p.currency)} over
                  </div>
                )}
              </td>
              <td className="px-4 py-3">
                <PaymentStatusPill status={p.status} />
              </td>
              <td className="px-4 py-3">
                {p.appliedAt ? (
                  <span className="font-mono text-xs text-muted-foreground">
                    {formatUtcDate(p.appliedAt)}
                  </span>
                ) : (
                  <span className="rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-[0.625rem] text-warning">
                    not applied
                  </span>
                )}
              </td>
              <td className="px-4 py-3 font-mono text-[0.625rem] text-muted-foreground">
                {p.txHash ? (
                  <span title={p.txHash}>
                    {p.chainId ? `chain ${p.chainId} · ` : ''}
                    {shortId(p.txHash)}
                  </span>
                ) : (
                  '—'
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Local atoms (see the note in ../page.tsx) ───────────────────────────────

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

function Mono({ children }: { children: React.ReactNode }) {
  return <span className="font-mono text-xs">{children}</span>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[0.625rem] uppercase tracking-widest text-muted-foreground">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-xl border border-border/60 bg-surface p-6 shadow-card">
      <div className="text-xs uppercase tracking-widest text-muted-foreground">{label}</div>
      <div className="mt-1 font-display text-2xl font-semibold">{value}</div>
      {sub && <div className="mt-1 font-mono text-[0.625rem] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border/60 bg-surface shadow-card">
      <div className="border-b border-border/60 px-6 py-4 text-xs uppercase tracking-widest text-muted-foreground">
        {title}
      </div>
      <div className="px-2 py-1">{children}</div>
    </div>
  );
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

const INVOICE_TONES: Record<string, string> = {
  paid: 'border-success/40 bg-success/10 text-success',
  open: 'border-warning/40 bg-warning/10 text-warning',
  uncollectible: 'border-destructive/40 bg-destructive/10 text-destructive',
};

function InvoiceStatusPill({ status }: { status: AdminInvoiceStatus }) {
  const tone = INVOICE_TONES[status] ?? 'border-border/60 bg-surface-2 text-muted-foreground';
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-[0.625rem] ${tone}`}>
      {status}
    </span>
  );
}

const PAYMENT_TONES: Record<string, string> = {
  succeeded: 'border-success/40 bg-success/10 text-success',
  pending: 'border-warning/40 bg-warning/10 text-warning',
  failed: 'border-destructive/40 bg-destructive/10 text-destructive',
};

function PaymentStatusPill({ status }: { status: AdminPaymentStatus }) {
  const tone = PAYMENT_TONES[status] ?? 'border-border/60 bg-surface-2 text-muted-foreground';
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-[0.625rem] ${tone}`}>
      {status}
    </span>
  );
}

/** Loading / error / ready for one request. See the note in ../page.tsx. */
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
