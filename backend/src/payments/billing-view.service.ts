import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { timingSafeEqual, createHash } from 'node:crypto';
import { Customer } from '../billing/customer.schema.js';
import { SettingsCacheService } from '../billing/settings-cache.service.js';
import type { PaymentProgress } from './payment-provider.interface.js';
import { PaymentProviderRegistry } from './provider-registry.js';
import { Invoice, type InvoiceCheckoutInstructions } from './schemas/invoice.schema.js';
import { Payment } from './schemas/payment.schema.js';
import { Subscription, LIVE_SUBSCRIPTION_STATUSES } from './schemas/subscription.schema.js';

/**
 * The lifecycle state the portal banner renders. FIVE, and they are not the raw
 * `SubscriptionStatus` — that vocabulary is Stripe's and is about billing
 * machinery, while these are about what the customer can do next.
 */
export type BillingState = 'free' | 'pending' | 'active' | 'past_due' | 'ended';

export interface BillingInvoiceView {
  id: string;
  number: number;
  status: Invoice['status'];
  planKey: string;
  /** Display name of the plan this invoice buys — the banner names the plan
   *  being PURCHASED, not the account's current one (they differ while a first
   *  payment is pending: current is Free, the invoice is Standard). */
  planName: string;
  periodStart: Date;
  periodEnd: Date;
  subtotalMinor: number;
  creditAppliedMinor: number;
  amountDueMinor: number;
  amountPaidMinor: number;
  currency: string;
  /** Hosted-redirect rails: the live pay link. Absent once settled or voided. */
  hostedUrl?: string;
  /** Crypto rail: what the customer must sign / send. See below. */
  instructions?: InvoiceCheckoutInstructions;
  createdAt?: Date;
}

export interface BillingOverview {
  state: BillingState;
  /**
   * A payment for the open invoice is already on its way and cannot be
   * recalled.
   *
   * Drives the portal's most important negative: do NOT offer "Pay" again. A
   * customer who refreshed during confirmation lands back on a `pending` page,
   * and the pay panel there invites a SECOND transfer for an invoice the first
   * one is about to settle. Refreshing never loses a payment — the watcher
   * settles server-side — it loses the knowledge that money is coming, and
   * this carries that knowledge across the reload.
   */
  paymentInFlight: boolean;
  /**
   * Confirmation progress for a broadcast payment, when there is one to
   * measure. Absent means "we cannot say" — not zero. See `PaymentProgress`.
   */
  paymentProgress?: PaymentProgress;
  planKey: string;
  planName: string;
  /** Money. Stored credit, applied automatically to the next invoice. */
  creditBalanceMinor: number;
  subscription: {
    id: string;
    status: Subscription['status'];
    planKey: string;
    interval: 'month' | 'year';
    unitAmountMinor: number;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
    cancelAtPeriodEnd: boolean;
    graceEndsAt?: Date;
    pendingPlanKey?: string;
    pendingEffectiveAt?: Date;
  } | null;
  /** The invoice the customer can act on right now, if any. */
  openInvoice: BillingInvoiceView | null;
}

/**
 * The five states the checkout return page must distinguish.
 *
 * `pending` IS THE IMPORTANT ONE. A crypto transfer is broadcast long before it
 * is confirmed, and the rail bounces the browser back the moment it is sent —
 * so the most common state on arrival is "we have seen something and it has not
 * settled". Rendering that as success is the single worst thing this page can
 * do: the customer closes the tab believing they are on Pro, the transfer then
 * fails or underpays, and they find out when their keys start 429ing.
 */
export type CheckoutReturnState = 'awaiting' | 'pending' | 'short' | 'paid' | 'closed';

export interface CheckoutReturnView {
  state: CheckoutReturnState;
  planName: string;
  amountDueMinor: number;
  amountPaidMinor: number;
  currency: string;
  /** Money. Still owed. Non-zero with `state: 'short'`. */
  shortfallMinor: number;
}

/**
 * Read models for the billing UI.
 *
 * Separate from `SubscriptionsService` because these are the only billing reads
 * that leave the building, and keeping them in one file makes "what does a
 * customer get to see" answerable by reading one file. Every projection is
 * built field by field — a column added to `Invoice` or `Subscription` cannot
 * leak by default.
 */
@Injectable()
export class BillingViewService {
  constructor(
    @InjectModel(Subscription.name) private readonly subscriptions: Model<Subscription>,
    @InjectModel(Invoice.name) private readonly invoices: Model<Invoice>,
    @InjectModel(Payment.name) private readonly payments: Model<Payment>,
    @InjectModel(Customer.name) private readonly customers: Model<Customer>,
    @Inject(SettingsCacheService) private readonly settings: SettingsCacheService,
    @Inject(PaymentProviderRegistry) private readonly registry: PaymentProviderRegistry,
  ) {}

  /**
   * Has the customer actually SENT a payment for this invoice?
   *
   * **`'signed'`, not `'any'`, and every consumer of this flag is why.** It
   * drives three things in the portal, and all three are claims about a
   * transfer that has really been broadcast:
   *
   *  - the banner says "your transfer has been sent" — a LIE if the customer
   *    opened a wallet and closed it, which `'any'` cannot tell apart;
   *  - the Pay button is suppressed — but somebody who never signed must be
   *    able to try again, and `'any'` locked them out for 30 minutes;
   *  - "Cancel the change to …" is disabled — the exact complaint, since the
   *    backend had already been relaxed to `'signed'` while the button was
   *    still reading the strict flag.
   *
   * The cautious reading belongs to the VOID paths, where the question is "can
   * money still arrive" rather than "has money been sent". Two different
   * questions; this one is the narrow one.
   *
   * FAILS OPEN here, which is the opposite of `SubscriptionsService`'s copy and
   * deliberately so — the two are answering different questions. There, a wrong
   * "no" voids an invoice and strands money. Here, a wrong "yes" hides the Pay
   * button from somebody who genuinely needs it, which is worse than showing it
   * to somebody who does not. Both choose the side whose failure is recoverable.
   */
  private async hasPaymentInFlight(invoiceId: string): Promise<boolean> {
    for (const provider of this.registry.all()) {
      if (!provider.hasPaymentInFlight) continue;
      try {
        if (await provider.hasPaymentInFlight(invoiceId, 'signed')) return true;
      } catch {
        // Logged nowhere on purpose: this runs on every billing page load and
        // on an 8-second poll, so a rail that is down would flood the log with
        // one line per tick for a purely cosmetic degradation.
        return false;
      }
    }
    return false;
  }

  /** First rail that can answer. Failures are silent — see `hasPaymentInFlight`. */
  private async paymentProgress(invoiceId: string): Promise<PaymentProgress | null> {
    for (const provider of this.registry.all()) {
      if (!provider.paymentProgress) continue;
      try {
        const progress = await provider.paymentProgress(invoiceId);
        if (progress) return progress;
      } catch {
        return null;
      }
    }
    return null;
  }

  async overview(customerId: string): Promise<BillingOverview> {
    const owner = new Types.ObjectId(customerId);
    const [customer, subscription] = await Promise.all([
      this.customers.findById(owner).lean().exec(),
      this.subscriptions
        .findOne({ customerId: owner, status: { $in: LIVE_SUBSCRIPTION_STATUSES } })
        .lean()
        .exec(),
    ]);

    const openInvoice = subscription
      ? await this.invoices
          .findOne({ subscriptionId: subscription._id, status: 'open' })
          .sort({ periodStart: -1 })
          .lean()
          .exec()
      : null;

    const planKey = customer?.planKey ?? 'free';
    // Asked of the rails rather than inferred from the invoice: only the rail
    // knows whether a signable payload is outstanding, and on a self-custody
    // rail that is the difference between "unpaid" and "paid, confirming".
    const paymentInFlight = openInvoice
      ? // `'signed'` — everything this flag drives in the portal is about a
        // transfer that HAS been sent. See the note on the method.
        await this.hasPaymentInFlight(String(openInvoice._id))
      : false;

    // Only when something is actually in flight: this costs two RPC calls, and
    // billing is polled every 8s by anyone sitting on the page.
    const paymentProgress =
      paymentInFlight && openInvoice
        ? await this.paymentProgress(String(openInvoice._id))
        : null;

    return {
      state: toBillingState(subscription),
      paymentInFlight,
      ...(paymentProgress ? { paymentProgress } : {}),
      planKey,
      planName: this.settings.getPlan(planKey)?.name ?? planKey,
      creditBalanceMinor: Math.max(0, customer?.creditBalanceMinor ?? 0),
      subscription: subscription
        ? {
            id: String(subscription._id),
            status: subscription.status,
            planKey: subscription.planKey,
            interval: subscription.interval,
            unitAmountMinor: subscription.unitAmountMinor,
            currentPeriodStart: subscription.currentPeriodStart,
            currentPeriodEnd: subscription.currentPeriodEnd,
            cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
            ...(subscription.graceEndsAt ? { graceEndsAt: subscription.graceEndsAt } : {}),
            ...(subscription.pendingPlanKey ? { pendingPlanKey: subscription.pendingPlanKey } : {}),
            ...(subscription.pendingEffectiveAt
              ? { pendingEffectiveAt: subscription.pendingEffectiveAt }
              : {}),
          }
        : null,
      openInvoice: openInvoice ? toInvoiceView(openInvoice, this.planName(openInvoice.planKey)) : null,
    };
  }

  /** Billing history, newest first. Backed by `{customerId, createdAt}`. */
  async invoices_(customerId: string, limit = 24): Promise<BillingInvoiceView[]> {
    const rows = await this.invoices
      .find({ customerId: new Types.ObjectId(customerId) })
      .sort({ createdAt: -1 })
      .limit(Math.min(100, Math.max(1, limit)))
      .lean()
      .exec();
    return rows.map((row) => toInvoiceView(row, this.planName(row.planKey)));
  }

  /** A plan key → its display name, falling back to the key. */
  private planName(planKey: string): string {
    return this.settings.getPlan(planKey)?.name ?? planKey;
  }

  /**
   * The checkout return page's status, read by CAPABILITY rather than by
   * session — see `Invoice.returnToken` for why the returning browser often has
   * no session at all.
   *
   * ONE generic 404 for a bad id, a bad token and an unknown invoice alike. The
   * id is enumerable (an ObjectId embeds an incrementing counter), so a
   * distinguishable "wrong token" would confirm which ids are real invoices.
   */
  async checkoutReturn(invoiceId: string, token: string): Promise<CheckoutReturnView> {
    const notFound = new NotFoundException({ error: 'That checkout link is not valid.' });
    if (!Types.ObjectId.isValid(invoiceId) || !token) throw notFound;

    const invoice = await this.invoices.findById(invoiceId).select('+returnToken').lean().exec();
    if (!invoice?.returnToken) throw notFound;
    // Hashed on both sides before comparing: `timingSafeEqual` THROWS on
    // unequal lengths, which would turn a wrong-length token into a 500 and
    // hand back a length oracle.
    if (!secretEquals(invoice.returnToken, token)) throw notFound;

    const paidSoFar = Math.max(0, invoice.amountPaidMinor);
    const shortfall = Math.max(0, invoice.amountDueMinor - paidSoFar);

    let state: CheckoutReturnState;
    if (invoice.status === 'paid') {
      state = 'paid';
    } else if (invoice.status === 'void' || invoice.status === 'uncollectible') {
      state = 'closed';
    } else if (paidSoFar > 0) {
      state = 'short';
    } else {
      // Nothing has settled. The discriminator between "we have seen a transfer
      // and it has not confirmed" and "nothing has arrived" is a payment row
      // that is not yet succeeded — and it must NEVER read as success.
      const inFlight = await this.payments
        .countDocuments({ invoiceId: invoice._id, status: 'pending' })
        .exec();
      state = inFlight > 0 ? 'pending' : 'awaiting';
    }

    return {
      state,
      planName: this.settings.getPlan(invoice.planKey)?.name ?? invoice.planKey,
      amountDueMinor: invoice.amountDueMinor,
      amountPaidMinor: paidSoFar,
      currency: invoice.currency,
      shortfallMinor: shortfall,
    };
  }
}

/**
 * `SubscriptionStatus` → the state the banner speaks.
 *
 * `incomplete` collapses to `pending` and NOT to `active`: it is a checkout
 * that has been started and not paid, and the customer holds nothing yet.
 */
function toBillingState(subscription: { status: Subscription['status'] } | null): BillingState {
  if (!subscription) return 'free';
  switch (subscription.status) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
      return 'past_due';
    case 'incomplete':
      return 'pending';
    default:
      // `unpaid`, `canceled`, `incomplete_expired` — all "it is over", and the
      // customer is on Free. One state, because the copy is the same.
      return 'ended';
  }
}

/** The one invoice projection. No `returnToken`, no `customerId`, no `__v`. */
function toInvoiceView(
  invoice: Invoice & { _id: unknown; createdAt?: Date },
  planName: string,
): BillingInvoiceView {
  return {
    id: String(invoice._id),
    number: invoice.number,
    status: invoice.status,
    planKey: invoice.planKey,
    planName,
    periodStart: invoice.periodStart,
    periodEnd: invoice.periodEnd,
    subtotalMinor: invoice.subtotalMinor,
    creditAppliedMinor: invoice.creditAppliedMinor,
    amountDueMinor: invoice.amountDueMinor,
    amountPaidMinor: invoice.amountPaidMinor,
    currency: invoice.currency,
    // Only the URL, never the provider's session ref.
    ...(invoice.checkout?.hostedUrl ? { hostedUrl: invoice.checkout.hostedUrl } : {}),
    // The on-chain deposit instructions, when this invoice is payable on the
    // native rail. Safe to expose: the address is public the moment it is shown
    // and grants nothing on its own.
    ...(invoice.checkout?.instructions ? { instructions: invoice.checkout.instructions } : {}),
    ...(invoice.createdAt ? { createdAt: invoice.createdAt } : {}),
  };
}

/** Constant-time comparison of two secrets of unknown, possibly unequal length. */
function secretEquals(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest();
  const right = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(left, right);
}
