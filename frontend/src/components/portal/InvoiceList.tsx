'use client';

import { formatMoneyMinor, formatUtcRange } from '../../lib/format';
import { EmptyState } from '../StateViews';
import type { BillingInvoice } from '../../lib/portal-api';

/**
 * The customer's invoice history.
 *
 * A LIST OF ROWS, NOT A TABLE, and that is the whole change. An invoice is read
 * for two things — what it cost and whether it is settled — and a six-column
 * table gave those exactly the same weight as its number and its period. Below
 * 720px `.stackTable` then turned each one into five labelled blocks plus an
 * empty sixth for the actions cell, ~660px per invoice: a year of monthly
 * billing was eight screens of scrolling, and the trailing blank block read as a
 * rendering fault rather than as an empty column.
 *
 * One row each instead, ~64px. Amount and plan lead; number and period are
 * metadata underneath in the muted mono; status is a coloured chip, because
 * "is this settled" is the thing people actually scan a history for. The row
 * wraps to one line on a wide screen, so there is no second markup path to keep
 * correct — unlike the plan catalogue, which reflows into a grid because its
 * items are choices to compare rather than records to scan.
 *
 * Extracted from `/portal/billing` so it can be rendered against fixture data
 * without a session: the page it lives on is behind auth, and "it builds" is not
 * evidence that a layout works.
 */
export function InvoiceList({
  invoices,
  payableInvoiceId,
  onPay,
}: {
  invoices: BillingInvoice[];
  /**
   * The ONE invoice that has live on-chain instructions behind it, or null.
   *
   * Passed as an id rather than a boolean because an older `open` invoice —
   * superseded, waiting on a sweep — has nothing payable attached to it, and a
   * Pay button that cannot work is worse than no button at all.
   */
  payableInvoiceId?: string | null;
  /** Opens the parent's pay dialog. Absent when there is nothing to pay with. */
  onPay?: () => void;
}) {
  if (invoices.length === 0) {
    return (
      <EmptyState
        title="No invoices yet"
        hint="An invoice appears here as soon as you subscribe to a paid plan."
      />
    );
  }

  return (
    <ul className="divide-y divide-border/60">
      {invoices.map((invoice) => {
        const status = invoiceStatus(invoice);
        return (
          <li
            key={invoice.id}
            className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 first:pt-0 last:pb-0"
          >
            <div className="min-w-0 flex-1 basis-48">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-sm font-semibold">
                  {formatMoneyMinor(invoice.amountDueMinor, invoice.currency)}
                </span>
                <span className="truncate text-sm text-muted-foreground">{invoice.planName}</span>
              </div>
              {/* WRAPS, not truncates. The credit clause is the last thing on
                  this line and the first thing an ellipsis eats — "after $0.…"
                  hides the amount that explains why the invoice is smaller than
                  the plan price. The plan name above truncates instead, because
                  a long plan name has nothing hiding behind it. */}
              <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                #{invoice.number} · {formatUtcRange(invoice.periodStart, invoice.periodEnd)}
                {invoice.creditAppliedMinor > 0 ? (
                  <>
                    {' · after '}
                    {formatMoneyMinor(invoice.creditAppliedMinor, invoice.currency)} credit
                  </>
                ) : null}
              </div>
            </div>

            {/* `ml-auto` so the status sits right whether it shares the row or
                wraps below it. Without it a wrapped row started its chip at the
                left margin while unwrapped rows had theirs at the right, and a
                history you scan for "is this settled" should keep that answer in
                one place down the list. */}
            <div className="ml-auto flex items-center gap-3">
              <span className={`rounded-md px-2 py-1 text-xs font-medium ${STATUS_TONE[status.tone]}`}>
                {status.label}
              </span>
              {/* Part-paid says how much is LEFT, outside the chip. A chip wide
                  enough to carry it stops being scannable, and this is the one
                  number that stops somebody sending the full amount a second
                  time on a rail that cannot refund. */}
              {status.detail ? (
                <span className="font-mono text-xs text-warning">{status.detail}</span>
              ) : null}

              {/* THREE cases, and the third is why this is not just the
                  `hostedUrl` link it used to be. A redirect rail has a pay URL;
                  the on-chain rail has none at all, so on this deployment the
                  column was permanently empty and the one open invoice looked
                  unpayable. */}
              {invoice.status !== 'open' ? null : invoice.hostedUrl ? (
                <a className="admin-btn" href={invoice.hostedUrl}>
                  Pay
                </a>
              ) : onPay && invoice.id === payableInvoiceId ? (
                <button className="admin-btn" type="button" onClick={onPay}>
                  Pay
                </button>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

type InvoiceTone = 'success' | 'warning' | 'danger' | 'muted';

/**
 * The chip colours. Whole class strings rather than built from a template,
 * because Tailwind's scanner reads SOURCE TEXT — `bg-${tone}/10` is never
 * generated and the chip ships transparent.
 */
const STATUS_TONE: Record<InvoiceTone, string> = {
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/10 text-warning',
  danger: 'bg-destructive/10 text-destructive',
  muted: 'bg-muted/40 text-muted-foreground',
};

/**
 * The invoice status as a customer reads it, plus the colour it earns.
 *
 * A PART-PAID open invoice is called out specifically. Left as a bare "Open" it
 * looks identical to one nobody has touched, and the customer's most likely next
 * action — sending the full amount again — is the expensive mistake on a rail
 * that cannot refund. It is the one status that returns a `detail`.
 *
 * `void` is deliberately MUTED, not red. A cancelled invoice is the normal end of
 * an abandoned checkout — nothing is owed and nothing went wrong — and colouring
 * it like a failure sends people to support. `uncollectible` is the one that
 * actually costs them the plan.
 */
export function invoiceStatus(invoice: BillingInvoice): {
  label: string;
  tone: InvoiceTone;
  detail?: string;
} {
  if (invoice.status === 'open' && invoice.amountPaidMinor > 0) {
    const owed = invoice.amountDueMinor - invoice.amountPaidMinor;
    return {
      label: 'Part paid',
      tone: 'warning',
      detail: `${formatMoneyMinor(owed, invoice.currency)} still due`,
    };
  }
  switch (invoice.status) {
    case 'paid':
      return { label: 'Paid', tone: 'success' };
    case 'open':
      return { label: 'Awaiting payment', tone: 'warning' };
    case 'void':
      return { label: 'Cancelled', tone: 'muted' };
    case 'uncollectible':
      return { label: 'Unpaid', tone: 'danger' };
    default:
      return { label: invoice.status, tone: 'muted' };
  }
}
