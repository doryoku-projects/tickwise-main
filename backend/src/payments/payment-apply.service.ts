import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Customer } from '../billing/customer.schema.js';
import { MeteringService } from '../billing/metering.service.js';
import { SettingsCacheService } from '../billing/settings-cache.service.js';
import { InvalidationBus } from '../common/invalidation-bus.js';
import { AppConfigService } from '../config/app-config.service.js';
import { BillingMailService } from './billing-mail.service.js';
import { foldPayment, type FoldRefusal } from './entitlement-fold.js';
import type { ProviderPayment } from './payment-provider.interface.js';
import { Invoice } from './schemas/invoice.schema.js';
import { Payment } from './schemas/payment.schema.js';
import { Subscription } from './schemas/subscription.schema.js';

/** Why an apply did not change anything. Every one of these answers 200. */
export type ApplyReason =
  | 'applied'
  | 'duplicate'
  | 'not-succeeded'
  | 'unknown-invoice'
  /**
   * The payment carried no amount. `ProviderPayment.amountMinor` is OPTIONAL
   * because a self-custody rail genuinely cannot report what settled — only what
   * it expected — and the caller must then supply the figure from its own record.
   * Reaching this path means nobody did, and the ONLY safe response is to refuse:
   * coercing an absent amount to 0 is precisely the bug the optional field
   * exists to prevent (the invoice total is RECOMPUTED from applied payments, so
   * a zero here silently erases real money from a paid invoice).
   */
  | 'no-amount'
  | 'refused';

export interface ApplyOutcome {
  applied: boolean;
  reason: ApplyReason;
  refusal?: FoldRefusal;
  invoiceId?: string;
  subscriptionId?: string;
  /** Money. Still owed after this payment. Reported even on a settled invoice. */
  shortfallMinor?: number;
}

export interface ApplyInput {
  provider: string;
  /**
   * The rail's own account of the payment — RE-FETCHED, never taken from a
   * webhook body. On the admin path it is synthesised from what the operator
   * typed, which is why that route demands a `note` and stamps `reconciledBy`.
   */
  payment: ProviderPayment;
  /** Which invoice this settles. Falls back to `payment.reference`. */
  invoiceId?: string;
  /** Admin identity, when a human entered this rather than a rail reporting it. */
  reconciledBy?: string;
  note?: string;
}

/**
 * THE APPLY PATH. Every route to "a payment settled" comes through here:
 * the Radom webhook, the admin `mark-paid`, the `payment-reconcile` sweep and
 * the dev fake rail. One entitlement fold, one set of writes, one place a bug
 * about money can live.
 *
 * ── SAFE TO INTERRUPT ──────────────────────────────────────────────────────
 *
 * The process can die between any two awaits below and a later reconcile lands
 * on the same state. Three mechanisms, each covering a different write:
 *
 *  1. **The payment row is claimed atomically.** `findOneAndUpdate` filtered on
 *     `appliedAt: {$exists: false}` with `upsert: true` — the FILTER is the
 *     guard, so two concurrent callers cannot both own the same charge, and
 *     E11000 on the unique `{provider, providerPaymentId}` index IS the
 *     "already applied" answer. No read-then-write window.
 *
 *  2. **The invoice total is RECOMPUTED, not `$inc`'d.** `amountPaidMinor` is
 *     written as the absolute sum of that invoice's applied, succeeded
 *     payments. An `$inc` that ran twice would over-credit an invoice with no
 *     way to tell afterwards; a `$set` of a recomputed sum is the same number
 *     however many times it runs. This is also what lets the reconcile job
 *     REPAIR an invoice, rather than only finish one.
 *
 *  3. **The credit balance gets its OWN claim.** It is the one write that is
 *     genuinely a running total on another document, so it cannot be made
 *     idempotent by recomputation — `Payment.creditedAt` is stamped by a
 *     filtered update, and the `$inc` only happens when that claim matched.
 *
 * ── NEVER A 500 FOR A BUSINESS OUTCOME ─────────────────────────────────────
 *
 * Nothing here throws for a payment that is short, in the wrong currency, aimed
 * at a settled invoice or already seen. Those return an `ApplyOutcome` and the
 * caller answers 200. A 5xx tells the rail to retry, and a retry of a decision
 * cannot change it — it just re-delivers forever. Only infrastructure failure
 * (Mongo unreachable) is allowed to propagate.
 */
@Injectable()
export class PaymentApplyService {
  private readonly logger = new Logger(PaymentApplyService.name);

  constructor(
    @InjectModel(Payment.name) private readonly payments: Model<Payment>,
    @InjectModel(Invoice.name) private readonly invoices: Model<Invoice>,
    @InjectModel(Subscription.name) private readonly subscriptions: Model<Subscription>,
    @InjectModel(Customer.name) private readonly customers: Model<Customer>,
    @Inject(SettingsCacheService) private readonly settings: SettingsCacheService,
    @Inject(MeteringService) private readonly metering: MeteringService,
    @Inject(BillingMailService) private readonly mail: BillingMailService,
    @Inject(AppConfigService) private readonly config: AppConfigService,
    /**
     * APPENDED and optional (P2.2): a granted plan reaches every replica's
     * API-key resolve cache at once instead of within its 30 s TTL. Absent /
     * CACHE_INVALIDATION=off = today.
     */
    @Optional() @Inject(InvalidationBus) private readonly bus?: InvalidationBus,
  ) {}

  async apply(input: ApplyInput): Promise<ApplyOutcome> {
    const invoiceId = (input.invoiceId ?? input.payment.reference ?? '').trim();
    if (!Types.ObjectId.isValid(invoiceId)) {
      // Money arrived that we cannot attribute. LOUD, because it is real money
      // sitting unallocated, and there is nothing an automatic retry can do
      // about it — a human has to look.
      this.logger.error(
        `[alert] payments.unattributable provider=${input.provider} payment=${input.payment.providerPaymentId} ` +
          `reference=${invoiceId || '(none)'} — no invoice id on the payment`,
      );
      return { applied: false, reason: 'unknown-invoice' };
    }

    // NO AMOUNT, NO APPLY — checked before anything is claimed or written.
    //
    // `ProviderPayment.amountMinor` is optional because a self-custody rail knows
    // only what it EXPECTED, not what settled. Every caller that applies a
    // payment must therefore supply the figure from its own record (the reconcile
    // merges it from the stored `Payment` row). If one does not, refusing is the
    // only safe answer: the invoice total is RECOMPUTED as the sum of applied
    // payments, so treating an absent amount as 0 does not "apply nothing" — it
    // ERASES money from an invoice that was already paid.
    if (input.payment.amountMinor === undefined || !Number.isFinite(input.payment.amountMinor)) {
      this.logger.error(
        `[alert] payments.no_amount provider=${input.provider} payment=${input.payment.providerPaymentId} ` +
          `invoice=${invoiceId} — the rail reported no settled amount and the caller supplied none; ` +
          'refusing rather than applying zero',
      );
      return { applied: false, reason: 'no-amount', invoiceId };
    }
    const amountMinor = Math.max(0, Math.round(input.payment.amountMinor));

    const invoice = await this.invoices.findById(invoiceId).exec();
    if (!invoice) {
      this.logger.error(
        `[alert] payments.unattributable provider=${input.provider} payment=${input.payment.providerPaymentId} ` +
          `invoice=${invoiceId} — no such invoice`,
      );
      return { applied: false, reason: 'unknown-invoice' };
    }

    const subscription = await this.subscriptions.findById(invoice.subscriptionId).exec();
    if (!subscription) {
      // An invoice without its subscription is a broken document, not a
      // business outcome — but it is still not something a rail retry fixes.
      this.logger.error(
        `[alert] payments.orphan_invoice invoice=${invoiceId} subscription=${String(invoice.subscriptionId)}`,
      );
      return { applied: false, reason: 'unknown-invoice' };
    }

    const claim = await this.claimPayment(input, invoice, subscription, amountMinor);
    if (!claim.owned) return { applied: false, reason: 'duplicate', invoiceId };

    // A pending or failed payment is RECORDED and does nothing else. `appliedAt`
    // stays unset, so it remains in the reconcile queue and a later re-fetch
    // that finds it succeeded will claim it properly.
    if (input.payment.status !== 'succeeded') {
      return { applied: false, reason: 'not-succeeded', invoiceId };
    }

    // Everything already applied against this invoice, INCLUDING the row just
    // claimed. Recomputed rather than read off the invoice — mechanism 2.
    // Scoped to the invoice's OWN currency: see `sumAppliedPayments`.
    const totalPaid = await this.sumAppliedPayments(invoice._id as Types.ObjectId, invoice.currency);
    const thisAmount = amountMinor;

    const decision = foldPayment({
      invoice: {
        subtotalMinor: invoice.subtotalMinor,
        amountDueMinor: invoice.amountDueMinor,
        // The fold adds `payment.amountMinor` to this, and their sum is the
        // recomputed total — so the prior figure is the total minus this one,
        // not whatever happens to be stored on the invoice document.
        amountPaidMinor: Math.max(0, totalPaid - thisAmount),
        currency: invoice.currency,
        status: invoice.status,
        periodStart: invoice.periodStart,
        periodEnd: invoice.periodEnd,
        planKey: invoice.planKey,
        priceId: invoice.priceId,
        interval: invoice.interval,
      },
      subscription: {
        status: subscription.status,
        currentPeriodEnd: subscription.currentPeriodEnd,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      },
      payment: { amountMinor: thisAmount, currency: input.payment.currency },
      // Deployment-wide, so a small-value live test can tighten it. See
      // `UNDERPAY_TOLERANCE_MINOR` for why a flat $1 is wrong on a $2 plan.
      toleranceMinor: this.config.underpayToleranceMinor,
    });

    if (!decision.settled && decision.refusal === 'currency-mismatch') {
      this.logger.error(
        `[alert] payments.currency_mismatch invoice=${invoiceId} expected=${invoice.currency} ` +
          `received=${input.payment.currency} payment=${input.payment.providerPaymentId}`,
      );
    }

    // The invoice is written on EVERY non-refusal outcome, settled or not: a
    // part payment that leaves the invoice open still moved the total, and the
    // customer needs to see how much is left.
    if (
      decision.refusal !== 'currency-mismatch' &&
      decision.refusal !== 'invoice-not-payable' &&
      // `subscription-not-live` joins them: the money went to the customer's
      // BALANCE, not onto this invoice, so recording it here would double-count
      // it. `sumAppliedPayments` totals every succeeded row carrying
      // `appliedAt` — and the claim stamps `appliedAt` before the fold judges —
      // so a credited payment is already visible to that sum. Leaving the
      // invoice untouched is what keeps the two ledgers from both claiming it.
      // (The orphaned invoice is then retired by the sweep's
      // `retireOrphanedInvoicesPass` once nothing is in flight against it.)
      decision.refusal !== 'subscription-not-live'
    ) {
      await this.invoices
        .updateOne(
          { _id: invoice._id },
          {
            $set: {
              amountPaidMinor: decision.invoicePaidMinor,
              status: decision.invoiceStatus,
            },
            // A settled invoice's pay link is dead. Clearing it stops the
            // portal offering "pay now" on something already paid, which is how
            // a customer pays twice.
            //
            // `$unset`, NOT `$set: { checkout: undefined }` — Mongoose STRIPS
            // undefined keys from an update before the driver sees it, so the
            // `$set` form was a silent no-op and the live pay link survived on
            // every paid invoice.
            ...(decision.settled ? { $unset: { checkout: '' } } : {}),
          },
        )
        .exec();
    }

    if (!decision.settled) {
      /*
       * MONEY THAT ARRIVED FOR AN INVOICE THAT CAN NEVER TAKE IT IS CREDITED,
       * NOT DROPPED. This is the invariant the rest of the subsystem rests on.
       *
       * `invoice-not-payable` means the invoice is `paid`, `void` or `draft`, so
       * no amount of retrying attaches this payment to it — and the block above
       * deliberately does not even write the invoice for this refusal. Until
       * now that combination meant a settled on-chain transfer left NO trace
       * beyond a `Payment` row whose `appliedAt` (stamped in the claim, before
       * the fold judged) made it look applied. It was the ONE refusal with no
       * alert, so nobody found out either.
       *
       * Observed for real: a customer picked a plan, switched plan 270ms later
       * — `changePlan` voids unfunded invoices — and then paid the signature
       * they were already holding for the FIRST invoice. The money landed, the
       * fold refused here, and they stayed on Free while the portal asked them
       * to pay again.
       *
       * Credit rather than refund because this rail cannot send money back, and
       * because credit is spent automatically by the next invoice raised
       * (`spendCustomerCredit`), so the customer is made whole without anyone
       * having to act. `creditToBalance` carries the at-most-once claim, so a
       * reconcile re-running this cannot credit twice.
       *
       * Deliberately NOT extended to the other two refusals. `currency-mismatch`
       * would mean converting between currencies at an implied rate we have not
       * chosen — that one stays a human decision, and it already alerts.
       * `short-paid` is not stranded at all: the invoice IS written with the
       * part payment and stays open, so the money is already attached and the
       * customer can top it up.
       */
      const strandable =
        decision.refusal === 'invoice-not-payable' || decision.refusal === 'subscription-not-live';
      if (strandable && thisAmount > 0) {
        this.logger.error(
          `[alert] payments.credited_unapplied invoice=${invoiceId} refusal=${decision.refusal} ` +
            `invoiceStatus=${invoice.status} subscriptionStatus=${subscription.status} ` +
            `amount=${thisAmount} ${invoice.currency} ` +
            `payment=${input.payment.providerPaymentId} — credited to the customer's balance`,
        );
        await this.creditToBalance(
          claim.paymentDocId,
          invoice.customerId,
          thisAmount,
          'unapplied',
        );
      }

      return {
        applied: false,
        reason: 'refused',
        refusal: decision.refusal,
        invoiceId,
        subscriptionId: String(subscription._id),
        shortfallMinor: decision.shortfallMinor,
      };
    }

    await this.grantEntitlement({
      subscription,
      invoice,
      decision,
      paymentDocId: claim.paymentDocId,
      overpaidMinor: decision.creditMinor,
    });

    this.logger.log(
      `Payment applied: invoice=${invoiceId} subscription=${String(subscription._id)} ` +
        `amount=${thisAmount} plan=${subscription.planKey}` +
        (decision.shortfallMinor > 0 ? ` (tolerated shortfall ${decision.shortfallMinor})` : ''),
    );

    return {
      applied: true,
      reason: 'applied',
      invoiceId,
      subscriptionId: String(subscription._id),
      shortfallMinor: decision.shortfallMinor,
    };
  }

  /**
   * Mechanism 1: take exclusive ownership of this charge, or discover somebody
   * else already has it.
   *
   * `$setOnInsert` carries the immutable identity of the payment; `$set`
   * carries what a re-fetch may legitimately have updated (a pending payment
   * that has since confirmed). `appliedAt` is set here, in the SAME atomic
   * operation as the claim, for a succeeded payment — a claim that stamped it
   * afterwards would leave a window in which a concurrent caller also claimed.
   */
  private async claimPayment(
    input: ApplyInput,
    invoice: InvoiceLike,
    subscription: SubscriptionLike,
    /**
     * The VALIDATED amount, passed in rather than re-derived from
     * `input.payment.amountMinor`. `apply()` has already refused an absent one
     * (`reason: 'no-amount'`), and re-deriving here would reintroduce the exact
     * coercion that guard exists to prevent.
     */
    amountMinor: number,
  ): Promise<{ owned: boolean; paymentDocId?: Types.ObjectId }> {
    const succeeded = input.payment.status === 'succeeded';
    try {
      const claimed = await this.payments
        .findOneAndUpdate(
          {
            provider: input.provider,
            providerPaymentId: input.payment.providerPaymentId,
            appliedAt: { $exists: false },
          },
          {
            // Every declared field written explicitly. An upsert applies no
            // Mongoose defaults to paths the update does not mention.
            $setOnInsert: {
              invoiceId: invoice._id,
              subscriptionId: subscription._id,
              customerId: invoice.customerId,
              provider: input.provider,
              providerPaymentId: input.payment.providerPaymentId,
              receivedAt: input.payment.receivedAt ?? new Date(),
              overpaidMinor: 0,
              ...(input.reconciledBy ? { reconciledBy: input.reconciledBy } : {}),
              ...(input.note ? { note: input.note } : {}),
            },
            $set: {
              status: input.payment.status,
              amountMinor,
              currency: input.payment.currency.toUpperCase(),
              ...(input.payment.asset ? { asset: input.payment.asset } : {}),
              ...(input.payment.assetAmount ? { assetAmount: input.payment.assetAmount } : {}),
              ...(input.payment.chainId ? { chainId: input.payment.chainId } : {}),
              ...(input.payment.txHash ? { txHash: input.payment.txHash } : {}),
              ...(succeeded ? { appliedAt: new Date() } : {}),
            },
          },
          { upsert: true, new: true },
        )
        .exec();
      return { owned: true, paymentDocId: claimed?._id as Types.ObjectId | undefined };
    } catch (err) {
      if (isDuplicateKey(err)) {
        // A row exists WITH `appliedAt`, so the filter missed and the upsert
        // collided. That is the answer, not an error: somebody already applied
        // this charge. This is the path a replayed webhook takes.
        return { owned: false };
      }
      throw err;
    }
  }

  /**
   * The absolute paid total for one invoice — mechanism 2.
   *
   * **MATCHED ON CURRENCY**, and that is not defensive tidying. `claimPayment`
   * stamps `appliedAt` in the same atomic operation as the claim, BEFORE the
   * fold has decided anything — it has to, or two callers could both claim the
   * same charge. So a payment the fold then REFUSES for a currency mismatch is
   * still a `succeeded` row carrying `appliedAt` and its foreign amount. Without
   * this filter, 50 EUR against a USD invoice would be summed at 1:1 on the
   * NEXT payment's recompute and could settle it — which is precisely the
   * outcome `foldPayment`'s currency check exists to prevent, arriving one
   * request later by a side door.
   */
  private async sumAppliedPayments(invoiceId: Types.ObjectId, currency: string): Promise<number> {
    const rows = await this.payments
      .aggregate<{ total: number }>([
        {
          $match: {
            invoiceId,
            status: 'succeeded',
            appliedAt: { $exists: true },
            currency: currency.toUpperCase(),
            // A payment DIVERTED to the credit balance settled nothing here.
            // `appliedAt` is stamped in the claim, before the fold judges, so
            // without this a diverted payment counts as having paid the invoice
            // AND sits on the customer's balance — the same money twice.
            divertedToCredit: { $ne: true },
          },
        },
        { $group: { _id: null, total: { $sum: '$amountMinor' } } },
      ])
      .exec();
    return Math.max(0, Math.round(rows[0]?.total ?? 0));
  }

  /**
   * Everything that follows from "the invoice is settled": the subscription's
   * period and status, the customer's plan, the credit, the receipt.
   *
   * Order matters. The PLAN GRANT happens before the credit and the mail: it is
   * the thing the customer paid for, and if the process dies after it they have
   * what they bought. The credit is next (its own claim), and the mail last —
   * it is the only step whose failure costs nothing.
   */
  private async grantEntitlement(args: {
    subscription: SubscriptionLike;
    invoice: InvoiceLike;
    decision: ReturnType<typeof foldPayment>;
    paymentDocId?: Types.ObjectId;
    overpaidMinor: number;
  }): Promise<void> {
    const { subscription, invoice, decision } = args;

    const subscriptionSet: Record<string, unknown> = {
      status: decision.subscriptionStatus,
      latestInvoiceId: invoice._id,
    };
    const subscriptionUnset: Record<string, unknown> = {};
    if (decision.advanceTo) {
      subscriptionSet.currentPeriodStart = decision.advanceTo.periodStart;
      subscriptionSet.currentPeriodEnd = decision.advanceTo.periodEnd;
      subscriptionSet.lateByDays = 0;
      // The subscription is current again, so the deadline that would have cut
      // it off is meaningless. Left in place it would fire on the next sweep.
      subscriptionUnset.graceEndsAt = '';
    }
    if (decision.grant) {
      // The invoice says what was bought, so an upgrade lands here — and lands
      // ONLY here, at the moment the money did. Any pending change this invoice
      // realised is cleared so the sweep does not apply it a second time.
      subscriptionSet.planKey = decision.grant.planKey;
      subscriptionSet.priceId = decision.grant.priceId;
      subscriptionSet.interval = decision.grant.interval;
      subscriptionSet.unitAmountMinor = decision.grant.unitAmountMinor;
      if (subscription.pendingPlanKey === decision.grant.planKey) {
        subscriptionUnset.pendingPlanKey = '';
        subscriptionUnset.pendingPriceId = '';
        subscriptionUnset.pendingEffectiveAt = '';
      }
    }
    await this.subscriptions
      .updateOne(
        { _id: subscription._id },
        {
          $set: subscriptionSet,
          ...(Object.keys(subscriptionUnset).length > 0 ? { $unset: subscriptionUnset } : {}),
        },
      )
      .exec();

    // THE PLAN GRANT. `planKey` and `planSource` only — never `status`.
    // `Customer.status` is a hard kill switch (`resolveByRawKey` 401s a
    // suspended customer), and the billing lifecycle may not touch it in either
    // direction: writing 'active' here would silently un-suspend an account an
    // operator had banned, just because someone paid an old invoice.
    if (decision.grant) {
      await this.customers
        .updateOne(
          { _id: invoice.customerId },
          {
            $set: {
              planKey: decision.grant.planKey,
              planSource: 'subscription',
              currentSubscriptionId: subscription._id,
            },
            // The customer has what they asked for, so the intent is spent.
            // Left behind it makes the portal keep nagging them to check out.
            $unset: { intendedPlanKey: '' },
          },
        )
        .exec();
      // Every cached API-key resolution of this customer carries the OLD
      // plan; drop them here (`local`) and on the other replicas.
      this.bus?.publish({ t: 'apikey', customerId: String(invoice.customerId) }, { local: true });
    }

    await this.creditToBalance(
      args.paymentDocId,
      invoice.customerId,
      args.overpaidMinor,
      'overpayment',
    );
    await this.sendReceipt(invoice, subscription, decision);
  }

  /**
   * Mechanism 3: move money onto the customer's credit balance AT MOST ONCE,
   * however many times this apply is re-run.
   *
   * TWO callers, one claim. An OVERPAYMENT is the surplus over a settled
   * invoice; an UNAPPLIED credit is the whole payment, arriving for an invoice
   * that can never take it or a subscription that is no longer live (see the
   * refusal branch in `apply`). They
   * share `Payment.creditedAt` deliberately — a payment is credited once or not
   * at all, and two claim fields would be two ways to credit the same money.
   *
   * Skipped entirely without a payment row id — a credit that cannot be stamped
   * cannot be bounded, and silently granting an unbounded one is worse than not
   * granting it. That case is logged rather than swallowed.
   */
  private async creditToBalance(
    paymentDocId: Types.ObjectId | undefined,
    customerId: unknown,
    amountMinor: number,
    reason: 'overpayment' | 'unapplied',
  ): Promise<void> {
    if (amountMinor <= 0) return;
    if (!paymentDocId) {
      this.logger.error(
        `[alert] payments.credit_unstampable customer=${String(customerId)} amount=${amountMinor} ` +
          `reason=${reason} — not credited`,
      );
      return;
    }
    const claim = await this.payments
      .updateOne(
        { _id: paymentDocId, creditedAt: { $exists: false } },
        {
          $set: {
            creditedAt: new Date(),
            overpaidMinor: amountMinor,
            // Only a whole-payment diversion is excluded from the invoice's
            // total; an overpayment's payment DID settle it.
            ...(reason === 'overpayment' ? {} : { divertedToCredit: true }),
          },
        },
      )
      .exec();
    // No upsert, and the matched count IS the guard — exactly the shape of
    // `resetQuotaPeriod`'s claim. It is also what makes ONE claim field safe to
    // share between the two callers: whichever reason fires first wins, and the
    // other cannot double-credit the same payment.
    if (claim.matchedCount === 0) return;

    await this.customers
      .updateOne({ _id: customerId }, { $inc: { creditBalanceMinor: amountMinor } })
      .exec();
    this.logger.log(`Credited ${amountMinor} to customer ${String(customerId)} (${reason})`);
  }

  private async sendReceipt(
    invoice: InvoiceLike,
    subscription: SubscriptionLike,
    decision: ReturnType<typeof foldPayment>,
  ): Promise<void> {
    const customer = await this.customers.findById(invoice.customerId).lean().exec();
    if (!customer?.email) return;
    await this.mail.paymentReceived({
      to: customer.email,
      // The plan the INVOICE bought — after an upgrade the subscription in hand
      // is the pre-update copy, and naming the old plan on the receipt for the
      // new one is the kind of detail that generates a support ticket.
      planName: this.settings.getPlan(invoice.planKey)?.name ?? invoice.planKey,
      amountMinor: decision.invoicePaidMinor,
      currency: invoice.currency,
      periodEnd: decision.advanceTo?.periodEnd ?? subscription.currentPeriodEnd,
      invoiceNumber: invoice.number,
      creditMinor: decision.creditMinor,
      billingUrl: `${this.config.portalBaseUrl}/portal/billing`,
    });
  }

  /**
   * Reverse an involuntary downgrade's quota reset side effect is NOT needed —
   * but the reverse direction is: a customer who pays after being downgraded
   * gets their plan back mid-month, and the quota counter is shared across
   * plans by design (that sharing is what makes an UPGRADE correct). So nothing
   * is reset here. Documented because its absence looks like an omission.
   *
   * The method is kept as the single place that comment lives, and is called by
   * the sweep on the downgrade direction only.
   */
  async resetQuotaForInvoluntaryDowngrade(customerId: string): Promise<void> {
    await this.metering.resetQuotaPeriod(customerId);
  }
}

/** The subset of an `Invoice` document this service touches. */
interface InvoiceLike {
  _id: unknown;
  customerId: unknown;
  subscriptionId: unknown;
  number: number;
  subtotalMinor: number;
  amountDueMinor: number;
  currency: string;
  status: Invoice['status'];
  periodStart: Date;
  periodEnd: Date;
  planKey: string;
  priceId: string;
  interval: 'month' | 'year';
}

/** The subset of a `Subscription` document this service touches. */
interface SubscriptionLike {
  _id: unknown;
  planKey: string;
  status: Subscription['status'];
  currentPeriodEnd: Date;
  cancelAtPeriodEnd: boolean;
  pendingPlanKey?: string;
}

/**
 * Mongo duplicate-key detection. Checked by CODE, never by matching the message
 * text — the driver's wording is not part of its contract and has changed
 * between majors, and a string match that silently stops matching turns "this
 * webhook is a replay" into an unhandled 500 that the rail then retries.
 */
export function isDuplicateKey(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: number }).code === 11000);
}
