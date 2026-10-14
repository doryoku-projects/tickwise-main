import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { X402PaymentProvider } from '../src/payments/providers/x402/x402.provider.js';

/**
 * `hasPaymentInFlight` — "can the customer still spend money against this
 * invoice without us doing anything?"
 *
 * It gates two things that both fail badly if it lies: `voidUnfundedInvoices`
 * (a wrong "no" strands a customer's transfer on a void invoice) and
 * `BillingOverview.paymentInFlight` (a wrong "yes" hides the Pay button).
 *
 * **THE TRAP THIS FILE EXISTS FOR.** The obvious implementation tests the
 * STATUS, because the watcher's partial index already calls
 * `['issued','authorized','submitted']` live. That is wrong here, and wrong in
 * the worst direction: `createCheckout` writes a fresh QUOTE as `issued` with
 * no `validBefore`, so a status-only test reports "in flight" for every open
 * invoice in the system — no customer could change plan, and none could pay
 * either, since the portal hides Pay on the same flag. The first cut of this
 * method had exactly that bug.
 *
 * `validBefore` is the real marker. It is stamped in `AuthorizationService.issue`
 * — the moment a signable payload is handed to a specific wallet — and nowhere
 * earlier.
 */

const INVOICE_ID = '507f1f77bcf86cd799439077';
const nowSec = () => Math.floor(Date.now() / 1000);

function providerWith(row: Record<string, unknown> | null): X402PaymentProvider {
  const authorizations = {
    findOne: () => ({ lean: () => ({ exec: async () => row }) }),
  };
  return new X402PaymentProvider(
    {} as never, // config
    {} as never, // domains
    authorizations as never,
  );
}

describe('X402PaymentProvider.hasPaymentInFlight', () => {
  it('is FALSE for a quote nobody has been handed yet — the outage case', async () => {
    // Exactly what `createCheckout` writes: status `issued`, no `validBefore`.
    // Every open invoice in the system looks like this until a wallet connects.
    const provider = providerWith({ status: 'issued', nonce: '0xab' });

    expect(await provider.hasPaymentInFlight(INVOICE_ID)).toBe(false);
  });

  it('is TRUE once a payload has been issued to a wallet and its window is open', async () => {
    // The signature is made client-side and we do not hear about it until
    // `confirm`, so from here this is indistinguishable from "already signed".
    const provider = providerWith({ status: 'issued', validBefore: nowSec() + 600 });

    expect(await provider.hasPaymentInFlight(INVOICE_ID)).toBe(true);
  });

  it('is FALSE once the signing window has passed — the block must not be permanent', async () => {
    // The token itself refuses a signature past `validBefore`, so nothing can
    // be spent. This is what bounds a plan-change refusal to minutes.
    const provider = providerWith({ status: 'issued', validBefore: nowSec() - 1 });

    expect(await provider.hasPaymentInFlight(INVOICE_ID)).toBe(false);
  });

  it('is TRUE for a signature we have actually seen, whatever the clock says', async () => {
    // Belt and braces: a verified signature or a relay already sent must never
    // be judged spent because a deadline drifted past.
    for (const status of ['authorized', 'submitted']) {
      const provider = providerWith({ status, validBefore: nowSec() - 5 });
      expect(await provider.hasPaymentInFlight(INVOICE_ID)).toBe(true);
    }
  });

  it('is FALSE when there is no live authorization at all', async () => {
    expect(await providerWith(null).hasPaymentInFlight(INVOICE_ID)).toBe(false);
  });

  it('is FALSE for an invoice id that is not an ObjectId, without touching Mongo', async () => {
    const provider = new X402PaymentProvider(
      {} as never,
      {} as never,
      {
        findOne: () => {
          throw new Error('must not query on a malformed id');
        },
      } as never,
    );

    expect(await provider.hasPaymentInFlight('not-an-id')).toBe(false);
  });

  it("mode 'signed' ignores a payload nobody has been seen to sign", async () => {
    // The customer opened a wallet and closed it. From here that is
    // indistinguishable from "about to sign", so `'any'` protects it — but an
    // EXPLICIT cancel must not be blocked by it, or clicking Pay once locks you
    // out of your own cancel button for the full 30-minute TTL. Safe because a
    // late signature is credited rather than lost.
    const provider = providerWith({ status: 'issued', validBefore: nowSec() + 1800 });

    expect(await provider.hasPaymentInFlight(INVOICE_ID, 'any')).toBe(true);
    expect(await provider.hasPaymentInFlight(INVOICE_ID, 'signed')).toBe(false);
  });

  it("mode 'signed' still reports a signature we have actually seen", async () => {
    for (const status of ['authorized', 'submitted']) {
      const provider = providerWith({ status, validBefore: nowSec() + 1800 });
      expect(await provider.hasPaymentInFlight(INVOICE_ID, 'signed')).toBe(true);
    }
  });
});
