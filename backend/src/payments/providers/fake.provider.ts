import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { AppConfigService } from '../../config/app-config.service.js';
import type {
  CreateCheckoutArgs,
  PaymentProvider,
  ProviderCapabilities,
  ProviderCheckout,
  ProviderPayment,
  WebhookEnvelope,
  WebhookHeaders,
} from '../payment-provider.interface.js';

export const FAKE_PROVIDER_KEY = 'fake';

/** How long a fake pay link stays valid — long enough to click, short enough to expire in a test. */
const FAKE_CHECKOUT_TTL_MS = 30 * 60_000;

/**
 * The in-development rail.
 *
 * WHY IT EXISTS: Radom needs an account, sandbox credentials and a human, and
 * that is the one dependency in this milestone no amount of work removes.
 * Everything downstream of "a payment settled" — the fold, the apply path, the
 * invoice/subscription writes, the sweep, the four emails, the portal states —
 * is independent of WHICH rail settled it, and this provider is what lets all
 * of it be built and exercised end to end before the account exists.
 *
 * It is a REAL provider, not a mock: checkout mints a link, the link is clicked,
 * a settlement is produced, and it flows through `PaymentApplyService` exactly
 * as a Radom webhook would. A test double that shortcut the apply path would
 * verify nothing about the code that will actually take money.
 *
 * SAFETY. `isConfigured` is false in production, unconditionally, and not
 * merely "unless the flag is set". This rail hands out entitlement for free;
 * the flag is a dev convenience, and a flag left on in a `.env` promoted to
 * prod must not be the only thing between a stranger and a Pro plan. It is also
 * off by default in development.
 *
 * STATE. Payments live in a process-local Map, so a restart forgets them and a
 * second pod never sees them. Correct for a dev rail and stated so nobody
 * debugs it: the durable record is the `payments` collection the apply path
 * writes, which survives fine.
 */
@Injectable()
export class FakePaymentProvider implements PaymentProvider {
  private readonly logger = new Logger(FakePaymentProvider.name);
  readonly key = FAKE_PROVIDER_KEY;

  readonly capabilities: ProviderCapabilities = {
    hostedCheckout: true,
    // Mirrors a hosted rail, not the native one — the dev rail exists to
    // exercise the redirect shape without an account.
    onChainDirect: false,
    // Same as Radom's pay-link rail: no auto-renewal, so the sweep is what
    // bills a second period. Mirroring Radom is the point — a dry run on this
    // rail must exercise the same lifecycle code the real one will.
    recurring: false,
    webhooks: false,
    bodySignature: false,
    variableSettlement: true,
  };

  private readonly payments = new Map<string, ProviderPayment>();

  constructor(@Inject(AppConfigService) private readonly config: AppConfigService) {}

  isConfigured(): boolean {
    // Production first, and as a hard gate rather than part of a conjunction a
    // future edit could reorder into irrelevance.
    if (this.config.isProduction) return false;
    return this.config.fakePaymentsEnabled;
  }

  async createCheckout(args: CreateCheckoutArgs): Promise<ProviderCheckout> {
    const ref = `fake_${randomBytes(9).toString('hex')}`;
    this.payments.set(ref, {
      providerPaymentId: ref,
      status: 'pending',
      amountMinor: args.amountMinor,
      currency: args.currency,
      reference: args.reference,
    });
    this.logger.log(`Fake checkout minted for invoice ${args.reference} (${ref})`);
    return {
      ref,
      // Points at THIS backend's dev-only settle route, which redirects on to
      // `successUrl` afterwards — so the browser journey matches a real rail's.
      hostedUrl: `${this.config.oauthCallbackBaseUrl}/billing/fake-checkout/${ref}?return=${encodeURIComponent(args.successUrl)}`,
      expiresAt: new Date(Date.now() + FAKE_CHECKOUT_TTL_MS),
    };
  }

  async getPayment(providerPaymentId: string): Promise<ProviderPayment | null> {
    return this.payments.get(providerPaymentId) ?? null;
  }

  /**
   * Mark a fake checkout settled. The dev-only route calls this, then hands the
   * result to the SAME `PaymentApplyService` a webhook would.
   *
   * `amountMinor` is overridable so the underpay / overpay / tolerance branches
   * of the fold are reachable from a browser, not only from a spec.
   */
  settle(ref: string, amountMinor?: number): ProviderPayment | null {
    const pending = this.payments.get(ref);
    if (!pending) return null;
    const settledPayment: ProviderPayment = {
      ...pending,
      status: 'succeeded',
      amountMinor: amountMinor ?? pending.amountMinor,
      asset: 'USDC',
      chainId: 1,
      txHash: `0xfake${randomBytes(30).toString('hex')}`,
      receivedAt: new Date(),
    };
    this.payments.set(ref, settledPayment);
    return settledPayment;
  }

  /** No webhook. Same reasoning as `ManualPaymentProvider`: fail closed. */
  verifyWebhook(_raw: Buffer, _headers: WebhookHeaders): boolean {
    return false;
  }

  parseWebhook(_raw: Buffer): WebhookEnvelope | null {
    return null;
  }
}
