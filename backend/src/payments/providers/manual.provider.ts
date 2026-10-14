import { BadRequestException, Injectable } from '@nestjs/common';
import type {
  CreateCheckoutArgs,
  PaymentProvider,
  ProviderCapabilities,
  ProviderCheckout,
  ProviderPayment,
  WebhookEnvelope,
  WebhookHeaders,
} from '../payment-provider.interface.js';

export const MANUAL_PROVIDER_KEY = 'manual';

/**
 * The off-rail provider: money that arrived somewhere we do not integrate with
 * — a bank transfer, an invoice paid by wire, a comped account, a sandbox
 * payment being reconciled by hand.
 *
 * It is a real `PaymentProvider` rather than a special case inside the apply
 * path on purpose. `Payment.provider` and `Payment.providerPaymentId` are
 * REQUIRED and carry the unique idempotency index, so a hand-entered payment
 * needs a provider key and a deterministic id like every other one. Giving it a
 * rail makes `/admin/payments/mark-paid` walk the identical
 * `PaymentApplyService` code path as a webhook — one entitlement fold, one set
 * of writes, one place a bug can live.
 *
 * Everything else it refuses, loudly:
 *  - `createCheckout` throws. There is no page to send anyone to, and returning
 *    a fake URL would put a dead link in `Invoice.checkout` that the portal
 *    would happily render as "pay now".
 *  - `getPayment` returns `null`, which the apply path reads as "this rail
 *    cannot corroborate anything". That is exactly right: the corroboration for
 *    a manual payment is the admin's `note` and the `reconciledBy` stamp, which
 *    is why `mark-paid` requires both and why it takes the amount explicitly.
 *  - `verifyWebhook` returns FALSE unconditionally. Nothing may post to
 *    `/webhooks/payments/manual` and be believed; the only writer is an
 *    authenticated admin route.
 */
@Injectable()
export class ManualPaymentProvider implements PaymentProvider {
  readonly key = MANUAL_PROVIDER_KEY;

  readonly capabilities: ProviderCapabilities = {
    hostedCheckout: false,
    // Neither shape: money arrived somewhere we do not integrate with at all.
    onChainDirect: false,
    recurring: false,
    webhooks: false,
    // Vacuously false — there is no webhook at all. Stated rather than left to
    // inference, because a reader checking "can I trust the body?" must get an
    // answer and not a shrug.
    bodySignature: false,
    // An operator can enter any amount, so the fold's tolerance and credit
    // rules apply here exactly as they do to a crypto rail.
    variableSettlement: true,
  };

  /** Always available: it needs no credentials, only an authenticated admin. */
  isConfigured(): boolean {
    return true;
  }

  createCheckout(_args: CreateCheckoutArgs): Promise<ProviderCheckout> {
    throw new BadRequestException({
      error: 'The manual rail has no checkout page — record the payment with POST /admin/payments/mark-paid.',
    });
  }

  /** Nothing to re-fetch. See the class comment: the admin IS the source. */
  async getPayment(_providerPaymentId: string): Promise<ProviderPayment | null> {
    return null;
  }

  verifyWebhook(_raw: Buffer, _headers: WebhookHeaders): boolean {
    return false;
  }

  parseWebhook(_raw: Buffer): WebhookEnvelope | null {
    return null;
  }
}

/**
 * The deterministic `providerPaymentId` for a hand-entered payment.
 *
 * Deterministic because `{provider, providerPaymentId}` is unique and IS the
 * idempotency guard: a double-clicked "mark paid" must collide rather than
 * credit an invoice twice. Keyed on the invoice plus the admin's own
 * `reference` so one invoice CAN legitimately take two manual payments (a part
 * payment topped up later) as long as the operator names them differently.
 */
export function manualPaymentId(invoiceId: string, reference: string): string {
  const suffix = reference.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `manual:${invoiceId}:${suffix || 'default'}`;
}
