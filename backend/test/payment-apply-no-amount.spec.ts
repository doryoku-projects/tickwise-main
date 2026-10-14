import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { PaymentApplyService } from '../src/payments/payment-apply.service.js';

/**
 * `PaymentApplyService` refuses a payment that carries NO AMOUNT.
 *
 * WHY THIS FILE EXISTS, and it is not a hypothetical. `ProviderPayment.amountMinor`
 * is optional because a self-custody rail genuinely cannot report what settled —
 * only what it expected — so the caller must supply the figure from its own
 * record. Both crypto rails previously reported a literal `0` instead of omitting
 * it, and `PaymentReconcileService`'s drift repair consumed that: it releases the
 * `appliedAt` claim, re-fetches, and re-applies. Its `fresh ?? { …stored }`
 * fallback only fires when the re-fetch returns NULL, and a non-null object
 * carrying `0` won that merge — so the repair re-applied a real payment as zero,
 * and because the invoice total is RECOMPUTED as the sum of applied payments, the
 * money vanished off an invoice that was already paid. A paying customer then sat
 * on an "unpaid" invoice heading for a grace expiry.
 *
 * The guard was added with the fix, and MUTATION TESTING IS WHY THIS SPEC EXISTS:
 * regressing the guard to `Math.round(amountMinor ?? 0)` — i.e. exactly the old
 * behaviour — left the entire 881-test suite green. A surviving mutation is the
 * only cheap way to find out you never tested something.
 */

const VALID_INVOICE_ID = '507f1f77bcf86cd799439022';

/**
 * The guard runs BEFORE any collection is touched, so every dependency is a
 * tripwire: if the refusal ever stops short-circuiting, one of these throws and
 * the test says so rather than passing on a coincidence.
 */
function buildApplyService() {
  const findById = vi.fn(() => {
    throw new Error('invoices.findById must NOT be reached — the guard refuses first');
  });
  const findOneAndUpdate = vi.fn(() => {
    throw new Error('payments.findOneAndUpdate must NOT be reached — nothing may be claimed');
  });

  const service = new PaymentApplyService(
    { findOneAndUpdate } as never, // payments
    { findById } as never, // invoices
    {} as never, // subscriptions
    {} as never, // customers
    {} as never, // settings
    {} as never, // metering
    {} as never, // mail
    { underpayToleranceMinor: 100 } as never, // config
  );
  return { service, findById, findOneAndUpdate };
}

describe('PaymentApplyService — a payment with no amount', () => {
  it('REFUSES with reason no-amount, before reading the invoice or claiming anything', async () => {
    const { service, findById, findOneAndUpdate } = buildApplyService();

    const outcome = await service.apply({
      provider: 'x402',
      invoiceId: VALID_INVOICE_ID,
      payment: {
        providerPaymentId: `0x${'ab'.repeat(32)}`,
        status: 'succeeded',
        // No `amountMinor` — what a self-custody rail's `getPayment` returns.
        currency: 'USD',
      },
    });

    expect(outcome).toMatchObject({ applied: false, reason: 'no-amount', invoiceId: VALID_INVOICE_ID });
    // The whole point: refusing costs nothing and writes nothing.
    expect(findById).not.toHaveBeenCalled();
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });

  it('REFUSES a NaN amount too — a rail returning garbage must not settle anything', async () => {
    const { service, findById } = buildApplyService();

    const outcome = await service.apply({
      provider: 'x402',
      invoiceId: VALID_INVOICE_ID,
      payment: {
        providerPaymentId: 'p1',
        status: 'succeeded',
        amountMinor: Number.NaN,
        currency: 'USD',
      },
    });

    expect(outcome.reason).toBe('no-amount');
    expect(findById).not.toHaveBeenCalled();
  });

  it('does NOT refuse a legitimate ZERO — a credit-covered invoice settles at 0', async () => {
    // The distinction the optional field exists for: `0` is a real amount (the
    // synthetic `manual` payment behind a zero-due, credit-covered invoice), while
    // ABSENT means "unknown". Collapsing them is the bug; refusing a real zero
    // would break the credit path.
    const { service, findById } = buildApplyService();

    await expect(
      service.apply({
        provider: 'manual',
        invoiceId: VALID_INVOICE_ID,
        payment: { providerPaymentId: 'p0', status: 'succeeded', amountMinor: 0, currency: 'USD' },
      }),
    ).rejects.toThrow(/findById must NOT be reached/);
    // It got PAST the guard and tried to read the invoice — which is the correct
    // behaviour for a real zero, and is what the tripwire proves.
    expect(findById).toHaveBeenCalled();
  });
});
