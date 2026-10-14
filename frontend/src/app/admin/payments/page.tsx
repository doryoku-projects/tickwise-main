'use client';

import { AlertTriangle } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';

import { Pagination, usePagination } from '@/components/admin/Pagination';
import { EmptyState, InlineError, SkeletonRows } from '@/components/DataState';
import {
  adminApi,
  type AdminInvoice,
  type AdminInvoiceStatus,
  type AdminPayment,
  type AdminPaymentStatus,
} from '@/lib/admin-api';
import { formatMoneyMinor, formatUtcDate } from '@/lib/format';

/*
 * The money ledger: `GET /admin/payments` and `GET /admin/invoices`.
 *
 * THE ONE NUMBER THIS PAGE EXISTS FOR is `unappliedPayments` — a payment that is
 * `succeeded` with no `appliedAt` is money taken from a customer that has
 * granted them nothing. It is read from `GET /admin/revenue` rather than counted
 * from the rows below, because the rows are a server-capped page and a count of
 * a page is not a count.
 *
 * Read-only, deliberately: `mark-paid` runs the same entitlement fold a webhook
 * does and `resync` re-drives the reconcile. Neither is wired here.
 */

const LIMITS = [50, 100, 200];

const INVOICE_STATUS_OPTIONS = [
  { value: '', label: 'All invoices' },
  { value: 'open', label: 'Open' },
  { value: 'paid', label: 'Paid' },
  { value: 'draft', label: 'Draft' },
  { value: 'void', label: 'Void' },
  { value: 'uncollectible', label: 'Uncollectible' },
];

export default function AdminPaymentsPage() {
  const [unappliedOnly, setUnappliedOnly] = useState(false);
  const [limit, setLimit] = useState(50);
  const [invoiceStatus, setInvoiceStatus] = useState('open');

  // The authoritative unapplied count, over every payment ever taken.
  const revenue = useLoad('revenue', () => adminApi.getRevenue(), 'Could not load the payment summary.');
  const payments = useLoad(
    `${unappliedOnly}:${limit}`,
    () => adminApi.listPayments({ unapplied: unappliedOnly, limit }),
    'Could not load payments.',
  );
  const invoices = useLoad(
    `${invoiceStatus}:${limit}`,
    () => adminApi.listInvoices({ status: invoiceStatus || undefined, limit }),
    'Could not load invoices.',
  );

  const unappliedCount = revenue.data?.unappliedPayments ?? 0;

  /*
   * A pager per table, keyed on that table's OWN filters.
   *
   * `limit` is in both keys because it is shared by both fetches; `unappliedOnly`
   * is only in the payments key and `invoiceStatus` only in the invoices key, so
   * narrowing one table does not throw the other back to its first page.
   */
  const paymentsRef = useRef<HTMLDivElement>(null);
  const invoicesRef = useRef<HTMLDivElement>(null);
  const pagedPayments = usePagination(payments.data ?? [], {
    resetKey: `${unappliedOnly}:${limit}`,
  });
  const pagedInvoices = usePagination(invoices.data ?? [], {
    resetKey: `${invoiceStatus}:${limit}`,
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl font-semibold">Payments</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every settlement attempt and the invoices they settle. Read-only —{' '}
          <span className="font-mono text-xs">mark-paid</span>,{' '}
          <span className="font-mono text-xs">resync</span> and{' '}
          <span className="font-mono text-xs">sweep</span> are irreversible financial writes and are
          not wired into this panel.
        </p>
      </div>

      {revenue.status === 'ready' && unappliedCount > 0 && (
        <div
          role="alert"
          className="flex flex-col gap-3 rounded-xl border border-destructive/40 bg-destructive/10 p-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <div className="text-sm">
              <div className="font-medium">
                {unappliedCount} payment{unappliedCount === 1 ? '' : 's'} not applied
              </div>
              <p className="mt-1 text-muted-foreground">
                Money that has been collected and has granted nothing. Each one is a customer who
                paid and does not have what they paid for.
              </p>
            </div>
          </div>
          {!unappliedOnly && (
            <button
              type="button"
              className="shrink-0 self-start rounded-md border border-destructive/40 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/10 sm:self-auto"
              onClick={() => setUnappliedOnly(true)}
            >
              Show only these
            </button>
          )}
        </div>
      )}

      {revenue.status === 'ready' && unappliedCount === 0 && (
        <div className="rounded-xl border border-success/40 bg-success/10 p-4 text-sm">
          <span className="font-medium">Nothing unapplied.</span>{' '}
          <span className="text-muted-foreground">
            Every payment recorded has been folded into an invoice and an entitlement.
          </span>
        </div>
      )}

      {revenue.status === 'error' && (
        <InlineError message={revenue.error} onRetry={revenue.retry} />
      )}

      {/* ── Payments ─────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xs uppercase tracking-widest text-muted-foreground">
            Payments {unappliedOnly ? '· unapplied only' : ''}
          </h2>
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={unappliedOnly}
                onChange={(e) => setUnappliedOnly(e.target.checked)}
              />
              Unapplied only
            </label>
            <select
              className="h-8 rounded-md border border-input bg-surface px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              aria-label="Rows to fetch"
              title="How many rows to fetch — applies to both tables on this page"
            >
              {LIMITS.map((n) => (
                <option key={n} value={n}>
                  Last {n}
                </option>
              ))}
            </select>
          </div>
        </div>

        {payments.status === 'error' ? (
          <InlineError message={payments.error} onRetry={payments.retry} />
        ) : (
          <div className="overflow-hidden rounded-xl border border-border/60 bg-surface shadow-card">
            <div className="overflow-x-auto" ref={paymentsRef}>
              <table className="w-full min-w-[72rem] text-sm">
                <thead className="text-left text-[0.625rem] uppercase tracking-widest text-muted-foreground">
                  <tr className="border-b border-border/60">
                    <th className="px-4 py-3">Received</th>
                    <th className="px-4 py-3">Customer</th>
                    <th className="px-4 py-3">Rail · charge</th>
                    <th className="px-4 py-3">Amount</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Applied</th>
                    <th className="px-4 py-3">On chain</th>
                    <th className="px-4 py-3">Entered by</th>
                  </tr>
                </thead>
                {payments.status === 'ready' && (payments.data ?? []).length > 0 && (
                  <tbody className="divide-y divide-border/60">
                    {pagedPayments.pageItems.map((p) => (
                      <PaymentRow key={p._id} payment={p} />
                    ))}
                  </tbody>
                )}
              </table>
            </div>

            {payments.status === 'ready' && (
              <Pagination state={pagedPayments} label="payments" scrollTo={paymentsRef} />
            )}

            {payments.status === 'loading' && (
              <div className="px-4">
                <SkeletonRows rows={5} lines={2} />
              </div>
            )}

            {payments.status === 'ready' && (payments.data ?? []).length === 0 && (
              <EmptyState
                title={unappliedOnly ? 'Nothing unapplied' : 'No payments recorded'}
                body={
                  unappliedOnly
                    ? 'Every payment on record has been applied to an invoice.'
                    : 'A row appears here the moment a rail reports a charge, before it is applied.'
                }
                action={
                  unappliedOnly ? (
                    <button
                      type="button"
                      className="text-xs text-primary hover:underline"
                      onClick={() => setUnappliedOnly(false)}
                    >
                      Show all payments
                    </button>
                  ) : undefined
                }
              />
            )}
          </div>
        )}
      </section>

      {/* ── Invoices ─────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-xs uppercase tracking-widest text-muted-foreground">Invoices</h2>
          <select
            className="h-8 rounded-md border border-input bg-surface px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            value={invoiceStatus}
            onChange={(e) => setInvoiceStatus(e.target.value)}
            aria-label="Filter invoices by status"
          >
            {INVOICE_STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        {invoices.status === 'error' ? (
          <InlineError message={invoices.error} onRetry={invoices.retry} />
        ) : (
          <div className="overflow-hidden rounded-xl border border-border/60 bg-surface shadow-card">
            <div className="overflow-x-auto" ref={invoicesRef}>
              <table className="w-full min-w-[64rem] text-sm">
                <thead className="text-left text-[0.625rem] uppercase tracking-widest text-muted-foreground">
                  <tr className="border-b border-border/60">
                    <th className="px-4 py-3">No.</th>
                    <th className="px-4 py-3">Customer</th>
                    <th className="px-4 py-3">Plan</th>
                    <th className="px-4 py-3">Period</th>
                    <th className="px-4 py-3">Subtotal</th>
                    <th className="px-4 py-3">Credit</th>
                    <th className="px-4 py-3">Due</th>
                    <th className="px-4 py-3">Paid</th>
                    <th className="px-4 py-3">Status</th>
                  </tr>
                </thead>
                {invoices.status === 'ready' && (invoices.data ?? []).length > 0 && (
                  <tbody className="divide-y divide-border/60">
                    {pagedInvoices.pageItems.map((i) => (
                      <InvoiceRow key={i._id} invoice={i} />
                    ))}
                  </tbody>
                )}
              </table>
            </div>

            {invoices.status === 'ready' && (
              <Pagination state={pagedInvoices} label="invoices" scrollTo={invoicesRef} />
            )}

            {invoices.status === 'loading' && (
              <div className="px-4">
                <SkeletonRows rows={4} lines={1} />
              </div>
            )}

            {invoices.status === 'ready' && (invoices.data ?? []).length === 0 && (
              <EmptyState
                title="No invoices match"
                body={
                  invoiceStatus
                    ? 'Nothing is in this status — widen the filter to see the rest.'
                    : 'Nothing has been billed yet.'
                }
                action={
                  invoiceStatus ? (
                    <button
                      type="button"
                      className="text-xs text-primary hover:underline"
                      onClick={() => setInvoiceStatus('')}
                    >
                      Show every status
                    </button>
                  ) : undefined
                }
              />
            )}
          </div>
        )}
      </section>

      <p className="text-xs text-muted-foreground">
        Every amount is the document&apos;s own integer minor-unit field rendered in its own{' '}
        <span className="font-mono">currency</span>. A fetch is capped at 200 rows by the server —
        the pager under each table walks the rows fetched, not past that cap.
      </p>
    </div>
  );
}

function PaymentRow({ payment: p }: { payment: AdminPayment }) {
  return (
    <tr className={`align-top ${!p.appliedAt ? 'bg-warning/5' : ''}`}>
      <td className="px-4 py-3 font-mono text-xs">{formatUtcDate(p.receivedAt)}</td>
      <td className="px-4 py-3">
        <Link
          href={`/admin/clients/${p.customerId}`}
          className="font-mono text-xs text-primary hover:underline"
          title={p.customerId}
        >
          {shortId(p.customerId)}
        </Link>
      </td>
      <td className="px-4 py-3">
        <div className="text-xs">{p.provider}</div>
        <div className="font-mono text-[0.625rem] text-muted-foreground" title={p.providerPaymentId}>
          {shortId(p.providerPaymentId)}
        </div>
      </td>
      <td className="px-4 py-3 font-mono">
        {formatMoneyMinor(p.amountMinor, p.currency)}
        {p.overpaidMinor > 0 && (
          <div className="text-[0.625rem] text-muted-foreground">
            +{formatMoneyMinor(p.overpaidMinor, p.currency)} over
            {p.creditedAt ? ' · credited' : ' · not credited'}
          </div>
        )}
        {p.asset && p.assetAmount && (
          <div className="text-[0.625rem] text-muted-foreground">
            {p.assetAmount} {p.asset}
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
      <td className="px-4 py-3 text-xs text-muted-foreground">
        {p.reconciledBy ?? '—'}
        {p.note && <div className="text-[0.625rem]">{p.note}</div>}
      </td>
    </tr>
  );
}

function InvoiceRow({ invoice: i }: { invoice: AdminInvoice }) {
  return (
    <tr className="align-top">
      <td className="px-4 py-3 font-mono text-xs">#{i.number}</td>
      <td className="px-4 py-3">
        <Link
          href={`/admin/clients/${i.customerId}`}
          className="font-mono text-xs text-primary hover:underline"
          title={i.customerId}
        >
          {shortId(i.customerId)}
        </Link>
      </td>
      <td className="px-4 py-3">
        <Link
          href={`/admin/subscriptions/${i.subscriptionId}`}
          className="text-primary hover:underline"
        >
          {i.planKey}
        </Link>
        <div className="font-mono text-[0.625rem] text-muted-foreground">
          {i.interval === 'year' ? 'annual' : 'monthly'}
        </div>
      </td>
      <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
        {formatUtcDate(i.periodStart)}
        <div>→ {formatUtcDate(i.periodEnd)}</div>
      </td>
      <td className="px-4 py-3 font-mono">{formatMoneyMinor(i.subtotalMinor, i.currency)}</td>
      <td className="px-4 py-3 font-mono text-muted-foreground">
        {i.creditAppliedMinor > 0 ? formatMoneyMinor(i.creditAppliedMinor, i.currency) : '—'}
      </td>
      <td className="px-4 py-3 font-mono">{formatMoneyMinor(i.amountDueMinor, i.currency)}</td>
      <td className="px-4 py-3 font-mono">{formatMoneyMinor(i.amountPaidMinor, i.currency)}</td>
      <td className="px-4 py-3">
        <InvoiceStatusPill status={i.status} />
      </td>
    </tr>
  );
}

// ─── Local atoms (see the note in ../subscriptions/page.tsx) ─────────────────

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
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

/** Loading / error / ready for one request. See the note in ../subscriptions/page.tsx. */
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
