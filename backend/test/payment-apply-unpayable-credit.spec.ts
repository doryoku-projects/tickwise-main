import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { PaymentApplyService } from '../src/payments/payment-apply.service.js';

/**
 * MONEY THAT ARRIVES FOR AN INVOICE THAT CAN NEVER TAKE IT IS CREDITED, NOT
 * DROPPED.
 *
 * WHY THIS FILE EXISTS, and it is not hypothetical — it cost a real customer a
 * real dollar on 2026-08-14. They picked Standard, switched to Pro **270ms
 * later**, and `changePlan` voided the unfunded Standard invoice. Eleven
 * seconds after that they signed and broadcast the authorization they were
 * already holding for the Standard invoice. The transfer settled on chain,
 * `apply()` claimed the payment — stamping `appliedAt`, which happens INSIDE
 * the claim and therefore BEFORE the fold judges anything — and the fold then
 * refused `invoice-not-payable`. The invoice write is skipped for that refusal,
 * so the only trace left was a `Payment` row that looked applied.
 *
 * It was also the ONE refusal in the whole apply path with no `[alert]`:
 * `unattributable`, `no_amount`, `orphan_invoice` and `currency_mismatch` all
 * shout. This one returned quietly, which is why nobody found out until the
 * customer asked why they were still being charged for a plan they had paid
 * for.
 *
 * Credit rather than refund because this rail cannot send money back, and
 * because `spendCustomerCredit` draws the balance down on the next invoice
 * raised — so the customer is made whole with nobody having to act.
 */

const INVOICE_ID = '507f1f77bcf86cd799439033';
const CUSTOMER_ID = '507f1f77bcf86cd799439044';
const PAYMENT_DOC_ID = '507f1f77bcf86cd799439055';

interface Harness {
  service: PaymentApplyService;
  customerIncs: Array<{ filter: unknown; update: Record<string, unknown> }>;
  paymentUpdates: Array<{ filter: Record<string, unknown>; update: Record<string, unknown> }>;
  errors: string[];
}

/**
 * The invoice is `void` — the state `changePlan` leaves behind. Everything else
 * is the minimum the apply path reads on the way to the fold.
 */
function buildHarness(opts: {
  invoiceStatus: string;
  subscriptionStatus?: string;
  creditClaimMatches?: boolean;
}): Harness {
  const customerIncs: Harness['customerIncs'] = [];
  const paymentUpdates: Harness['paymentUpdates'] = [];
  const errors: string[] = [];

  const invoice = {
    _id: INVOICE_ID,
    customerId: CUSTOMER_ID,
    subscriptionId: 'sub1',
    status: opts.invoiceStatus,
    currency: 'USD',
    subtotalMinor: 100,
    amountDueMinor: 100,
    amountPaidMinor: 0,
    creditAppliedMinor: 0,
    periodStart: new Date('2026-08-14T17:01:21.197Z'),
    periodEnd: new Date('2026-09-14T17:01:21.197Z'),
    planKey: 'standard',
    priceId: 'standard_monthly',
    interval: 'month',
    number: 7,
  };

  const subscription = {
    _id: 'sub1',
    status: opts.subscriptionStatus ?? 'incomplete',
    planKey: 'standard',
    currentPeriodEnd: invoice.periodEnd,
    cancelAtPeriodEnd: false,
  };

  const exec = <T>(value: T) => ({ exec: async () => value });

  const payments = {
    // The claim: this apply owns the payment row.
    findOneAndUpdate: vi.fn(() => exec({ _id: PAYMENT_DOC_ID })),
    updateOne: vi.fn((filter: Record<string, unknown>, update: Record<string, unknown>) => {
      paymentUpdates.push({ filter, update });
      return exec({ matchedCount: opts.creditClaimMatches === false ? 0 : 1 });
    }),
    // `sumAppliedPayments` — this payment and nothing else.
    aggregate: vi.fn(() => exec([{ total: 100 }])),
  };

  const invoices = {
    findById: vi.fn(() => exec(invoice)),
    updateOne: vi.fn(() => {
      throw new Error('the invoice must NOT be written for a stranding refusal — the money went to the balance');
    }),
  };

  const subscriptions = { findById: vi.fn(() => exec(subscription)) };

  const customers = {
    updateOne: vi.fn((filter: unknown, update: Record<string, unknown>) => {
      customerIncs.push({ filter, update });
      return exec({ matchedCount: 1 });
    }),
  };

  const service = new PaymentApplyService(
    payments as never,
    invoices as never,
    subscriptions as never,
    customers as never,
    {} as never, // settings — only reached on a settled apply
    {} as never, // metering
    {} as never, // mail
    { underpayToleranceMinor: 0 } as never,
  );

  // Capture the alert rather than letting it print through the run.
  (service as unknown as { logger: { error: (m: string) => void; log: (m: string) => void; warn: (m: string) => void } }).logger = {
    error: (m: string) => errors.push(m),
    log: () => {},
    warn: () => {},
  };

  return { service, customerIncs, paymentUpdates, errors };
}

function payment(amountMinor = 100) {
  return {
    provider: 'x402',
    invoiceId: INVOICE_ID,
    payment: {
      providerPaymentId: '0xcf85f5ca282875848b60e609b97d91c59389d874da7d19606d9d4e0baede754d:0x3',
      status: 'succeeded' as const,
      amountMinor,
      currency: 'USD',
    },
  };
}

describe('apply() — money for an invoice that can never take it', () => {
  it('credits the whole payment to the customer and alerts', async () => {
    const h = buildHarness({ invoiceStatus: 'void' });

    const outcome = await h.service.apply(payment() as never);

    expect(outcome.applied).toBe(false);
    expect(outcome.refusal).toBe('invoice-not-payable');

    // The money moved onto the balance, in full.
    expect(h.customerIncs).toHaveLength(1);
    expect(h.customerIncs[0].update).toEqual({ $inc: { creditBalanceMinor: 100 } });

    // And it is LOUD. This was the silent one.
    expect(h.errors.some((e) => e.includes('payments.credited_unapplied'))).toBe(true);
  });

  it('claims the credit at most once, so a reconcile re-run cannot double it', async () => {
    const h = buildHarness({ invoiceStatus: 'void' });

    await h.service.apply(payment() as never);

    // The `$inc` is gated on a filtered stamp of `creditedAt`, never an
    // unconditional write — the same shape the overpayment path uses.
    const claim = h.paymentUpdates.find((u) => 'creditedAt' in (u.filter as object));
    expect(claim).toBeDefined();
    expect(claim!.filter).toMatchObject({ creditedAt: { $exists: false } });
  });

  it('does not credit when the claim was already taken', async () => {
    // Second run of the same apply: `creditedAt` is set, the filtered update
    // matches nothing, and the balance must not move again.
    const h = buildHarness({ invoiceStatus: 'void', creditClaimMatches: false });

    await h.service.apply(payment() as never);

    expect(h.customerIncs).toHaveLength(0);
  });

  it('marks a diverted payment so it cannot also count toward the invoice total', async () => {
    /*
     * THE DOUBLE-COUNT. `sumAppliedPayments` totals every succeeded row with
     * `appliedAt`, and the claim stamps that BEFORE the fold judges — so a
     * payment handed back as credit was still summed as having paid the
     * invoice. `creditedAt` cannot discriminate, because it is also stamped for
     * an OVERPAYMENT, where the payment genuinely did settle. Hence the flag.
     */
    const h = buildHarness({ invoiceStatus: 'void' });

    await h.service.apply(payment() as never);

    const claim = h.paymentUpdates.find((u) => 'creditedAt' in (u.filter as object));
    expect((claim!.update as { $set: Record<string, unknown> }).$set).toMatchObject({
      divertedToCredit: true,
    });
  });

  it('does NOT mark an OVERPAYMENT as diverted — that payment really did settle', async () => {
    /*
     * The mirror-image regression, and the worse one. `creditedAt` is stamped
     * for both cases; if the flag followed it blindly, every overpaid invoice
     * would drop its own settling payment out of `sumAppliedPayments` and read
     * as unpaid — erasing real money from an invoice that was paid, which is
     * the exact failure the recompute design exists to prevent.
     *
     * Reached through the private helper because the settled path needs the
     * whole grant machinery; the discrimination lives here and nowhere else.
     */
    const h = buildHarness({ invoiceStatus: 'void' });
    await (
      h.service as unknown as {
        creditToBalance: (p: unknown, c: unknown, a: number, r: string) => Promise<void>;
      }
    ).creditToBalance(PAYMENT_DOC_ID, CUSTOMER_ID, 50, 'overpayment');

    const claim = h.paymentUpdates.find((u) => 'creditedAt' in (u.filter as object));
    expect(claim).toBeDefined();
    expect((claim!.update as { $set: Record<string, unknown> }).$set).not.toHaveProperty(
      'divertedToCredit',
    );
  });

  it('credits a payment aimed at an already PAID invoice too', async () => {
    // The other shape of the same mistake: a duplicate transfer, or a relay
    // landing after an admin marked the invoice paid by hand.
    const h = buildHarness({ invoiceStatus: 'paid' });

    const outcome = await h.service.apply(payment() as never);

    expect(outcome.refusal).toBe('invoice-not-payable');
    expect(h.customerIncs[0].update).toEqual({ $inc: { creditBalanceMinor: 100 } });
  });

  it('credits rather than resurrecting a subscription the customer abandoned', async () => {
    // The 2026-08-14 sequence, now that the void guard keeps the invoice
    // payable: cancel abandons the subscription, then the signed transfer the
    // customer could not recall lands anyway. Granting here would write
    // `active` back onto a terminal row — and since LIVE_SUBSCRIPTION_STATUSES
    // backs a partial UNIQUE index, a customer who had already started a new
    // checkout would collide with E11000 inside the apply path: a business
    // outcome thrown as a 500, retried by the watcher forever.
    const h = buildHarness({ invoiceStatus: 'open', subscriptionStatus: 'incomplete_expired' });

    const outcome = await h.service.apply(payment() as never);

    expect(outcome.applied).toBe(false);
    expect(outcome.refusal).toBe('subscription-not-live');
    // They asked to cancel, so they stay cancelled — but not out of pocket.
    expect(h.customerIncs[0].update).toEqual({ $inc: { creditBalanceMinor: 100 } });
    expect(h.errors.some((e) => e.includes('subscriptionStatus=incomplete_expired'))).toBe(true);
  });
});
