import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { MailModule } from '../mail/mail.module.js';
import { PortalModule } from '../portal/portal.module.js';
import { AdminPaymentsController } from './admin-payments.controller.js';
import { BillingMailService } from './billing-mail.service.js';
import { BillingViewService } from './billing-view.service.js';
import { FakeCheckoutController } from './fake-checkout.controller.js';
import { PaymentApplyService } from './payment-apply.service.js';
import { PaymentReconcileService } from './payment-reconcile.service.js';
import { PaymentsQueueService } from './payments-queue.service.js';
import { PaymentsWebhookController } from './payments-webhook.controller.js';
import { CheckoutReturnController, PortalBillingController } from './portal-billing.controller.js';
import { PaymentProviderRegistry } from './provider-registry.js';
import { FakePaymentProvider } from './providers/fake.provider.js';
import { ManualPaymentProvider } from './providers/manual.provider.js';
import { RadomPaymentProvider } from './providers/radom.provider.js';
import { AuthorizationService } from './providers/x402/authorization.service.js';
import { AuthorizationWatcherService } from './providers/x402/authorization-watcher.service.js';
import { Eip3009DomainService } from './providers/x402/eip3009-domain.service.js';
import { TreasurySubmitterService } from './providers/x402/treasury-submitter.service.js';
import { TokenVerificationService } from './providers/x402/token-verification.service.js';
import { X402PaymentProvider } from './providers/x402/x402.provider.js';
import {
  PaymentAuthorization,
  PaymentAuthorizationSchema,
} from './schemas/payment-authorization.schema.js';
import { Counter, CounterSchema } from './schemas/counter.schema.js';
import { Invoice, InvoiceSchema } from './schemas/invoice.schema.js';
import { Payment, PaymentSchema } from './schemas/payment.schema.js';
import { Subscription, SubscriptionSchema } from './schemas/subscription.schema.js';
import { WebhookEvent, WebhookEventSchema } from './schemas/webhook-event.schema.js';
import { SubscriptionSweepService } from './subscription-sweep.service.js';
import { SubscriptionsService } from './subscriptions.service.js';

/**
 * Self-serve subscriptions: rails, checkout, the entitlement fold, the
 * lifecycle sweep and the money surfaces.
 *
 * ── IMPORTS RUN ONE WAY ───────────────────────────────────────────────────
 *
 *   payments → { billing, portal, auth, mail }
 *
 * and nothing may be imported back. `BillingModule` re-exports its
 * `MongooseModule.forFeature`, so `Customer` and `Plan` are injectable here
 * with no second registration; `PortalModule` supplies `CustomerJwtGuard` for
 * the portal billing routes; `AuthModule` supplies `AdminJwtGuard`'s
 * dependencies for the admin ones. A reverse edge would be this repo's first DI
 * cycle — `BillingModule` already imports `AuthModule`.
 *
 * Registered LAST in `AppModule`, after `PortalModule` and `IdentityModule`, so
 * the `/account/*` namespace reads in the order the customer meets it: sign in,
 * then keys, then billing.
 *
 * ── ITS QUEUE IS NOT THE POSITIONS QUEUE ──────────────────────────────────
 *
 * `PaymentsQueueService` owns a separate BullMQ queue named `payments`, out of
 * reach of the `obliterate({force: true})` that `QueueService` runs on
 * `positions-sync` at boot (with `QUEUE_CLEAR_ON_BOOT=true`). A wiped position sync costs a re-sync; a
 * wiped money job is a customer who paid and has nothing. See that file.
 */
const PaymentsMongooseModule = MongooseModule.forFeature([
  { name: Subscription.name, schema: SubscriptionSchema },
  { name: Invoice.name, schema: InvoiceSchema },
  { name: Payment.name, schema: PaymentSchema },
  { name: WebhookEvent.name, schema: WebhookEventSchema },
  { name: Counter.name, schema: CounterSchema },
  { name: PaymentAuthorization.name, schema: PaymentAuthorizationSchema },
]);

@Module({
  imports: [BillingModule, PortalModule, AuthModule, MailModule, PaymentsMongooseModule],
  controllers: [
    PortalBillingController,
    // Open, capability-authenticated. A separate controller from the guarded
    // one above on purpose — see its comment.
    CheckoutReturnController,
    PaymentsWebhookController,
    AdminPaymentsController,
    // Registered unconditionally; the route itself 404s unless the fake rail is
    // configured, which it never is in production. A conditional `controllers`
    // array would make the module's shape depend on env at boot, which is
    // harder to reason about than one route that refuses.
    FakeCheckoutController,
  ],
  providers: [
    RadomPaymentProvider,
    ManualPaymentProvider,
    FakePaymentProvider,
    // The x402 / EIP-3009 rail: ONE treasury, no xpub, no sweep, no middleman.
    // `Eip3009DomainService` verifies each token's EIP-712 domain against the
    // chain at boot and is what stops a token that cannot actually be signed for
    // from being offered; `TokenVerificationService` checks its decimals the same
    // way. Both are the only things here that talk to a node (the internal design notes).
    X402PaymentProvider,
    Eip3009DomainService,
    TokenVerificationService,
    // The signing half: issue a payload, verify the signature, relay it, and
    // watch the chain for the settlement. `TreasurySubmitterService` holds the ONE
    // key in the system and it is GAS-ONLY — see its header.
    AuthorizationService,
    TreasurySubmitterService,
    AuthorizationWatcherService,
    PaymentProviderRegistry,
    BillingMailService,
    PaymentApplyService,
    SubscriptionsService,
    SubscriptionSweepService,
    PaymentReconcileService,
    BillingViewService,
    PaymentsQueueService,
  ],
  exports: [SubscriptionsService, PaymentApplyService, BillingViewService],
})
export class PaymentsModule {}
