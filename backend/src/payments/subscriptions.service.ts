import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { randomBytes } from 'node:crypto';
import { Customer } from '../billing/customer.schema.js';
import { isActivePrice, type PlanPrice } from '../billing/plan.schema.js';
import { PlansService } from '../billing/plans.service.js';
import { AppConfigService } from '../config/app-config.service.js';
import { addInterval, prorationCreditMinor } from './entitlement-fold.js';
import { isDuplicateKey, PaymentApplyService } from './payment-apply.service.js';
import type {
  InFlightMode,
  OnChainInstructions,
  PaymentProvider,
  ProviderCheckout,
} from './payment-provider.interface.js';
import { PaymentProviderRegistry } from './provider-registry.js';
import { manualPaymentId, MANUAL_PROVIDER_KEY } from './providers/manual.provider.js';
import { Counter, INVOICE_NUMBER_COUNTER_KEY } from './schemas/counter.schema.js';
import { Invoice, type InvoiceCheckout } from './schemas/invoice.schema.js';
import { Subscription, LIVE_SUBSCRIPTION_STATUSES } from './schemas/subscription.schema.js';

/** What a checkout attempt hands back to the portal. */
export interface CheckoutResult {
  /** `checkout` — go pay. `scheduled` — nothing to pay now. `granted` — credit covered it. */
  outcome: 'checkout' | 'scheduled' | 'granted';
  invoiceId?: string;
  /** Hosted-redirect rails: send the browser here. */
  hostedUrl?: string;
  /** Direct on-chain rails: render an address and an exact amount. */
  instructions?: OnChainInstructions;
  /** Money. What the customer is being asked for, after credit. */
  amountDueMinor?: number;
  currency?: string;
  /** Set on `scheduled`: when the change takes effect. */
  effectiveAt?: Date;
  planKey: string;
}

/**
 * Subscription lifecycle: buying one, changing one, stopping one.
 *
 * The one thing this service never does is grant entitlement. Every plan change
 * a customer PAYS for lands through `PaymentApplyService`, driven by what the
 * invoice says was bought — so there is exactly one place in the codebase where
 * `Customer.planKey` moves upward, and it is downstream of money having
 * actually arrived. What happens here is the creation of the obligation.
 */
@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  constructor(
    @InjectModel(Subscription.name) private readonly subscriptions: Model<Subscription>,
    @InjectModel(Invoice.name) private readonly invoices: Model<Invoice>,
    @InjectModel(Counter.name) private readonly counters: Model<Counter>,
    @InjectModel(Customer.name) private readonly customers: Model<Customer>,
    @Inject(PlansService) private readonly plans: PlansService,
    @Inject(PaymentProviderRegistry) private readonly registry: PaymentProviderRegistry,
    @Inject(PaymentApplyService) private readonly applyService: PaymentApplyService,
    @Inject(AppConfigService) private readonly config: AppConfigService,
  ) {}

  /** The one live subscription a customer may hold, if any. */
  async findLive(customerId: string): Promise<(Subscription & { _id: Types.ObjectId }) | null> {
    return this.subscriptions
      .findOne({ customerId: new Types.ObjectId(customerId), status: { $in: LIVE_SUBSCRIPTION_STATUSES } })
      .exec() as Promise<(Subscription & { _id: Types.ObjectId }) | null>;
  }

  /**
   * Start — or resume — a purchase.
   *
   * THE DOUBLE-CHARGE GUARD is the first branch that matters. A customer who
   * double-clicks, or who comes back tomorrow to a checkout they abandoned,
   * must be handed THE SAME pay link, not a second invoice. So an existing open
   * invoice for the same plan and price wins over minting anything new, and it
   * is returned as a 409 carrying that link rather than as a bare error: the
   * portal can act on it, and the customer sees "you already have one, here it
   * is" instead of an unexplained refusal.
   */
  async startCheckout(args: {
    customerId: string;
    planKey: string;
    priceId?: string;
    now?: Date;
  }): Promise<CheckoutResult> {
    const now = args.now ?? new Date();
    const { plan, price } = await this.resolvePurchasable(args.planKey, args.priceId);
    const live = await this.findLive(args.customerId);

    if (live) {
      // Same plan AND same price — this is a repeat of a purchase in flight.
      if (live.planKey === plan.key && live.priceId === price.id) {
        const open = await this.findResumableInvoice(live._id, plan.key, price.id, now);
        if (open) {
          throw new ConflictException({
            error: 'You already have a payment in progress for this plan.',
            invoiceId: String(open._id),
            hostedUrl: open.checkout?.hostedUrl,
            // Carried for the same reason `hostedUrl` is: the portal must be able
            // to ACT on this 409 by showing the customer the payment they already
            // started. Omitting it left a crypto-rail customer a bare error with
            // no address and no way back to their own pending payment.
            instructions: open.checkout?.instructions,
            amountDueMinor: open.amountDueMinor,
            currency: open.currency,
          });
        }
        if (live.status === 'active') {
          throw new ConflictException({ error: `You are already subscribed to ${plan.name}.` });
        }
      }
      return this.changePlan({ live, plan, price, customerId: args.customerId, now });
    }

    return this.openNewSubscription({ customerId: args.customerId, plan, price, now });
  }

  /**
   * Stop a subscription.
   *
   * TWO shapes, and the discriminator is whether money has EVER landed:
   *
   *  - A PAID subscription (`active` / `trialing` / `past_due`) stops at the end
   *    of the period the customer paid for — never immediate, never a refund.
   *    They bought the period, so they keep it; `SubscriptionSweepService` ends
   *    it at `currentPeriodEnd`, and `resume` reverses it while it still runs.
   *
   *  - An `incomplete` subscription has NEVER been paid, so it entitles nothing
   *    and there is no period to "keep". Scheduling a cancel-at-period-end there
   *    is a lie the portal renders verbatim — "your subscription will end on
   *    <a month from now>" beside a still-open PAY panel, for a plan the customer
   *    does not have. Cancelling an unpaid checkout is ABANDONING it, which is
   *    exactly what the sweep does to one left untouched (`incomplete_expired` +
   *    `voidUnfundedInvoices`), so do the same thing now, on demand: the customer
   *    lands cleanly back on Free with no pending banner and no pay panel.
   *
   * `immediate` tells the portal which happened, so it can say "you are back on
   * Free" rather than name an end date that has no meaning.
   */
  async cancel(customerId: string, reason?: string): Promise<{ endsAt: Date; immediate: boolean }> {
    const live = await this.findLive(customerId);
    if (!live) throw new NotFoundException({ error: 'You do not have an active subscription.' });

    if (live.status === 'incomplete') {
      /*
       * REFUSED once the customer has actually SIGNED, because abandoning here
       * is worse than a no-op — it is a downgrade of their own payment.
       *
       * The transfer cannot be recalled. `voidUnfundedInvoices('signed')`
       * already declines to void the invoice, so the money still lands; but the
       * SUBSCRIPTION would be `incomplete_expired` by then, the fold would
       * refuse `subscription-not-live`, and the payment would become CREDIT
       * instead of the plan they were paying for. They asked for Standard,
       * broadcast $1, and would end up on Free holding $1 of balance.
       *
       * `'signed'` and not `'any'`: somebody who opened a wallet and closed it
       * has sent nothing and must still be able to abandon — that distinction is
       * the whole point of `InFlightMode`.
       */
      if (await this.hasPaymentInFlightForSubscription(live._id, 'signed')) {
        throw new ConflictException({
          error:
            'Your payment is already on its way and cannot be called back. It will apply shortly — there is nothing to cancel.',
          code: 'payment-in-flight',
        });
      }

      const now = new Date();
      // Guarded on `status: 'incomplete'` so a payment landing between the read
      // and this write cannot be trampled: the atomic transition to `active`
      // (or the sweep's own expiry) makes this match nothing, `modifiedCount` is
      // 0, and we re-read rather than expiring a subscription that just went
      // live. A matched write ALWAYS modifies (the status value changes), so a
      // 0 here means and only means "status is no longer incomplete".
      const abandoned = await this.subscriptions
        .updateOne(
          { _id: live._id, status: 'incomplete' },
          {
            $set: {
              status: 'incomplete_expired',
              endedAt: now,
              canceledAt: now,
              ...(reason ? { cancellationReason: reason.slice(0, 500) } : {}),
            },
          },
        )
        .exec();
      if (abandoned.modifiedCount > 0) {
        // Drops the open invoice (and its pay panel / authorization) and
        // returns any credit it had consumed.
        await this.voidUnfundedInvoices(live._id);
        this.logger.log(`Abandoned an unpaid checkout for customer ${customerId} on cancel`);
        return { endsAt: now, immediate: true };
      }
      // It moved out of `incomplete` under us. If a payment made it live, cancel
      // it the paid way; anything else (already abandoned) is already Free.
      const relive = await this.findLive(customerId);
      if (!relive || relive.status === 'incomplete') return { endsAt: now, immediate: true };
      return this.scheduleCancelAtPeriodEnd(relive, reason);
    }

    return this.scheduleCancelAtPeriodEnd(live, reason);
  }

  /** Flag a PAID subscription to stop at the end of the current period. */
  private async scheduleCancelAtPeriodEnd(
    live: Subscription & { _id: Types.ObjectId },
    reason?: string,
  ): Promise<{ endsAt: Date; immediate: boolean }> {
    await this.subscriptions
      .updateOne(
        { _id: live._id },
        {
          $set: {
            cancelAtPeriodEnd: true,
            canceledAt: new Date(),
            ...(reason ? { cancellationReason: reason.slice(0, 500) } : {}),
          },
          // A pending downgrade is moot once the whole thing is ending, and
          // leaving it would have the sweep apply a plan change to a
          // subscription it is about to terminate.
          $unset: { pendingPlanKey: '', pendingPriceId: '', pendingEffectiveAt: '' },
        },
      )
      .exec();
    return { endsAt: live.currentPeriodEnd, immediate: false };
  }

  /** Undo a `cancelAtPeriodEnd` while the period is still running. */
  async resume(customerId: string): Promise<{ renewsAt: Date }> {
    const live = await this.findLive(customerId);
    if (!live) throw new NotFoundException({ error: 'You do not have an active subscription.' });
    if (!live.cancelAtPeriodEnd) {
      throw new BadRequestException({ error: 'That subscription is not scheduled to end.' });
    }
    await this.subscriptions
      .updateOne(
        { _id: live._id },
        { $set: { cancelAtPeriodEnd: false }, $unset: { canceledAt: '', cancellationReason: '' } },
      )
      .exec();
    return { renewsAt: live.currentPeriodEnd };
  }

  // ─── purchase paths ────────────────────────────────────────────────────────

  /** First purchase: no live subscription exists. */
  private async openNewSubscription(args: {
    customerId: string;
    plan: PlanDoc;
    price: PlanPrice;
    now: Date;
  }): Promise<CheckoutResult> {
    const { customerId, plan, price, now } = args;
    const provider = this.registry.resolveCheckoutProvider();
    const periodEnd = addInterval(now, price.interval, price.intervalCount);

    let subscription: Subscription & { _id: Types.ObjectId };
    try {
      const created = await this.subscriptions.create({
        customerId: new Types.ObjectId(customerId),
        planKey: plan.key,
        priceId: price.id,
        interval: price.interval,
        unitAmountMinor: price.unitAmountMinor,
        // `incomplete` until money lands. THIS is what stops a checkout that is
        // merely started from granting anything: the guard reads
        // `Customer.planKey`, which no path here writes.
        status: 'incomplete',
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        // SNAPSHOTTED from config, never read live — changing the global default
        // must not retroactively shorten a window somebody signed up under.
        graceDays: this.config.subscriptionGraceDays,
        cancelAtPeriodEnd: false,
        provider: provider.key,
        startedAt: now,
        lateByDays: 0,
      });
      subscription = created as Subscription & { _id: Types.ObjectId };
    } catch (err) {
      if (isDuplicateKey(err)) {
        // The partial-unique `{customerId}` index on live statuses fired: a
        // concurrent request created one between our read and our write. That
        // index existing is precisely so this is a 409 and not two overlapping
        // paid subscriptions the entitlement resolver has to choose between.
        throw new ConflictException({
          error: 'A subscription was just created for this account — reload and try again.',
        });
      }
      throw err;
    }

    const invoice = await this.raiseInvoice({
      subscription,
      customerId,
      planKey: plan.key,
      price,
      periodStart: now,
      periodEnd,
      applyCustomerCredit: true,
    });
    return this.finishInvoice({ invoice, provider, plan, customerId, now });
  }

  /**
   * A customer who already has a live subscription asking for a different plan
   * or cadence.
   *
   * UPGRADE IS IMMEDIATE, DOWNGRADE IS SCHEDULED, and the discriminator is the
   * MONTHLY-EQUIVALENT price rather than the raw amount. Comparing raw amounts
   * would call a $790/yr Pro annual an "upgrade" over a $99/mo Standard monthly
   * on the strength of the bigger number, and — worse — call the reverse a
   * downgrade and schedule it, quietly leaving the customer on the dearer plan
   * for the rest of the year.
   *
   * The asymmetry is deliberate and standard: paying more should take effect
   * when you pay, and paying less should take effect when what you already paid
   * for runs out. Downgrading immediately would mean refunding, and this rail
   * cannot send money back.
   */
  private async changePlan(args: {
    live: Subscription & { _id: Types.ObjectId };
    plan: PlanDoc;
    price: PlanPrice;
    customerId: string;
    now: Date;
  }): Promise<CheckoutResult> {
    const { live, plan, price, customerId, now } = args;

    /*
     * REFUSED WHILE A PAYMENT IS IN FLIGHT, before anything is written.
     *
     * The upgrade branch below voids the old unfunded invoices and raises a new
     * one. If the customer is already holding a signed authorization for the
     * old invoice, that void strands their money — the transfer is broadcast by
     * their own wallet and no state here can stop it, so it lands on an invoice
     * that can no longer take it. `voidUnfundedInvoices` now declines to void
     * such an invoice, but declining THERE would leave a half-applied change:
     * a new invoice raised beside an old one still payable, two live pay
     * targets for one subscription.
     *
     * So the refusal belongs here, at the top, where nothing has happened yet.
     * It is a 409 carrying the same shape `startCheckout`'s double-charge guard
     * uses, so the portal can act on it rather than showing a bare error, and
     * it is SHORT — bounded by the signature's own `validBefore`, minutes not
     * hours. The customer's way out is the one they already have: finish the
     * payment, or abandon the checkout.
     */
    if (await this.hasPaymentInFlightForSubscription(live._id)) {
      throw new ConflictException({
        error:
          'You have a payment in progress. Finish it, or cancel the checkout, before changing plan.',
        code: 'payment-in-flight',
      });
    }

    const currentMonthly = monthlyEquivalentMinor({
      unitAmountMinor: live.unitAmountMinor,
      interval: live.interval,
      intervalCount: 1,
    });
    const targetMonthly = monthlyEquivalentMinor(price);

    if (targetMonthly <= currentMonthly) {
      const effectiveAt = live.currentPeriodEnd;
      await this.subscriptions
        .updateOne(
          { _id: live._id },
          {
            $set: {
              pendingPlanKey: plan.key,
              pendingPriceId: price.id,
              pendingEffectiveAt: effectiveAt,
              // Choosing a different plan is choosing to continue, so it
              // implicitly retracts a pending cancellation.
              cancelAtPeriodEnd: false,
            },
            $unset: { canceledAt: '', cancellationReason: '' },
          },
        )
        .exec();
      this.logger.log(
        `Scheduled plan change for ${customerId}: ${live.planKey} → ${plan.key} at ${effectiveAt.toISOString()}`,
      );
      return { outcome: 'scheduled', planKey: plan.key, effectiveAt };
    }

    // ── Upgrade. A NEW period starts now, on the new plan, with the unused
    // value of the current one credited against it.
    const provider = this.registry.resolveCheckoutProvider();
    const periodEnd = addInterval(now, price.interval, price.intervalCount);
    const proration = prorationCreditMinor({
      paidAmountMinor: live.status === 'active' ? live.unitAmountMinor : 0,
      periodStart: live.currentPeriodStart,
      periodEnd: live.currentPeriodEnd,
      now,
    });

    // Supersede anything unpaid on the old plan. Only invoices that have
    // received NOTHING: a part-paid invoice has real money attached to it and
    // voiding that silently strands it, so those are left for a human.
    //
    // Credit is RETURNED rather than lost. `spendCustomerCredit` deducts the
    // balance when the invoice is RAISED and books it as `creditAppliedMinor`,
    // leaving `amountPaidMinor` at zero — so an invoice part-funded by credit
    // looks untouched to the filter above. Voiding it without refunding
    // deducted the customer and attached the money to a dead document.
    await this.voidUnfundedInvoices(live._id);

    const invoice = await this.raiseInvoice({
      subscription: live,
      customerId,
      planKey: plan.key,
      price,
      periodStart: now,
      periodEnd,
      prorationCreditMinor: proration,
      applyCustomerCredit: true,
    });
    // Recorded on the subscription so the portal can say what is being bought
    // while the payment is in flight. It grants NOTHING — the apply path reads
    // the invoice, and clears this when the invoice that realises it settles.
    //
    // **`pendingEffectiveAt` IS DELIBERATELY NOT SET HERE**, and that omission
    // is load-bearing rather than tidy. `SubscriptionSweepService.scheduledChangePass`
    // selects on `pendingEffectiveAt <= now`; this branch used to stamp it to
    // `now`, so the very next sweep tick promoted the pending plan onto the
    // subscription AND onto `Customer.planKey` — an UNPAID upgrade, granted by
    // a timer, which is a second entitlement path with no money behind it. The
    // pass's own comment already said it must never fire for an upgrade; only
    // the query disagreed.
    //
    // A pending change with NO effective date therefore means exactly one
    // thing: "bought, not yet paid for — the apply path owns this." The
    // scheduled-downgrade branch above sets a real future date, which is the
    // only shape pass 4 acts on. It also keeps `resolveNextPrice` honest, since
    // that too gates on `pendingEffectiveAt`: a renewal must not be billed at a
    // plan the customer has not bought.
    await this.subscriptions
      .updateOne(
        { _id: live._id },
        { $set: { pendingPlanKey: plan.key, pendingPriceId: price.id } },
        // Any previously-scheduled downgrade is superseded by this purchase.
      )
      .exec();
    await this.subscriptions.updateOne({ _id: live._id }, { $unset: { pendingEffectiveAt: '' } }).exec();

    return this.finishInvoice({ invoice, provider, plan, customerId, now });
  }

  // ─── invoicing ─────────────────────────────────────────────────────────────

  /**
   * Raise one invoice for one period, idempotently.
   *
   * The unique `{subscriptionId, periodStart}` index is the guard, and it is
   * used the race-free way round: CREATE unconditionally and treat E11000 as
   * "somebody already raised this one, use theirs". A read-then-write check
   * leaves a window in which a doubled sweep tick bills the same period twice
   * and mints two pay links.
   */
  async raiseInvoice(args: {
    subscription: { _id: Types.ObjectId; };
    customerId: string;
    planKey: string;
    price: PlanPrice;
    periodStart: Date;
    periodEnd: Date;
    /** Money. Unused value of a period being replaced (upgrade only). */
    prorationCreditMinor?: number;
    /** Whether to spend the customer's stored credit balance on this invoice. */
    applyCustomerCredit?: boolean;
  }): Promise<InvoiceDoc> {
    const subtotal = Math.max(0, Math.round(args.price.unitAmountMinor));
    const proration = Math.min(subtotal, Math.max(0, Math.round(args.prorationCreditMinor ?? 0)));

    let invoice: InvoiceDoc;
    try {
      const created = await this.invoices.create({
        number: await this.nextInvoiceNumber(),
        // Minted with the invoice so the return URL always has one. 32 bytes
        // from `randomBytes`, never `Math.random` — see `Invoice.returnToken`.
        returnToken: randomBytes(32).toString('base64url'),
        subscriptionId: args.subscription._id,
        customerId: new Types.ObjectId(args.customerId),
        planKey: args.planKey,
        priceId: args.price.id,
        interval: args.price.interval,
        periodStart: args.periodStart,
        periodEnd: args.periodEnd,
        subtotalMinor: subtotal,
        creditAppliedMinor: proration,
        amountDueMinor: subtotal - proration,
        amountPaidMinor: 0,
        currency: args.price.currency,
        // `open` immediately: there is no assembly step in this product, and a
        // `draft` invoice is not payable (see `isPayable` in the fold), so
        // leaving it draft would silently reject the payment it is asking for.
        status: 'open',
      });
      invoice = created as InvoiceDoc;
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      const existing = await this.invoices
        .findOne({ subscriptionId: args.subscription._id, periodStart: args.periodStart })
        // `returnToken` is `select: false`, so it has to be asked for — without
        // this the reused invoice would build a return URL with no capability
        // on it and the return page would refuse its own customer.
        .select('+returnToken')
        .exec();
      if (!existing) throw err;
      this.logger.log(`Invoice for period ${args.periodStart.toISOString()} already existed — reusing #${existing.number}`);
      return existing as InvoiceDoc;
    }

    if (args.applyCustomerCredit) await this.spendCustomerCredit(args.customerId, invoice);
    return invoice;
  }

  /**
   * Spend the customer's stored credit balance against a freshly raised
   * invoice.
   *
   * ORDER IS THE WHOLE POINT: the invoice exists BEFORE any credit is taken, so
   * credit can never be deducted from a customer with nothing to show for it.
   * The deduction is a conditional `$inc` guarded by the balance we read — if a
   * concurrent write moved it, the update matches nothing and the invoice
   * simply keeps its full amount rather than the balance going negative.
   */
  private async spendCustomerCredit(customerId: string, invoice: InvoiceDoc): Promise<void> {
    if (invoice.amountDueMinor <= 0) return;
    const customer = await this.customers.findById(customerId).lean().exec();
    const available = Math.max(0, Math.round(customer?.creditBalanceMinor ?? 0));
    const spend = Math.min(available, invoice.amountDueMinor);
    if (spend <= 0) return;

    const claim = await this.customers
      .updateOne(
        { _id: new Types.ObjectId(customerId), creditBalanceMinor: { $gte: spend } },
        { $inc: { creditBalanceMinor: -spend } },
      )
      .exec();
    if (claim.matchedCount === 0) return;

    // `creditFromBalanceMinor` alongside: this is the ONLY writer of it, and it
    // is what makes the spend distinguishable from a proration when the invoice
    // is later voided. See the field's note in `invoice.schema.ts`.
    await this.invoices
      .updateOne(
        { _id: invoice._id },
        {
          $inc: {
            creditAppliedMinor: spend,
            creditFromBalanceMinor: spend,
            amountDueMinor: -spend,
          },
        },
      )
      .exec();
    invoice.creditAppliedMinor += spend;
    invoice.creditFromBalanceMinor = (invoice.creditFromBalanceMinor ?? 0) + spend;
    invoice.amountDueMinor -= spend;
    this.logger.log(`Applied ${spend} of account credit to invoice #${invoice.number}`);
  }

  /**
   * Turn a raised invoice into something the customer can act on: either a pay
   * link, or — when credit already covers it — an immediate settlement.
   *
   * The zero-due case goes through `PaymentApplyService` with a synthetic
   * `manual` payment of 0 rather than granting the plan inline. It costs one
   * more write and buys the property that matters: there is ONE place
   * entitlement is granted, so the receipt, the period advance, the pending-
   * change promotion and the `planSource` stamp cannot drift between "paid with
   * money" and "paid with credit".
   */
  private async finishInvoice(args: {
    invoice: InvoiceDoc;
    provider: PaymentProvider;
    plan: PlanDoc;
    customerId: string;
    now: Date;
  }): Promise<CheckoutResult> {
    const { invoice, provider, plan, customerId } = args;

    if (invoice.amountDueMinor <= 0) {
      await this.settleFromCredit(invoice, args.now);
      return {
        outcome: 'granted',
        planKey: plan.key,
        invoiceId: String(invoice._id),
        amountDueMinor: 0,
        currency: invoice.currency,
      };
    }

    const customer = await this.customers.findById(customerId).lean().exec();
    const checkout = await provider.createCheckout({
      reference: String(invoice._id),
      // Load-bearing for the crypto rail: `PaymentAuthorization.customerId` is
      // required, so a checkout that omitted this threw on insert and the
      // on-chain rail could not mint a single address. A hosted rail ignores it.
      customerId,
      amountMinor: invoice.amountDueMinor,
      currency: invoice.currency,
      description: `${plan.name} — ${formatPeriod(invoice.periodStart, invoice.periodEnd)}`,
      ...(customer?.email ? { customerEmail: customer.email } : {}),
      successUrl: this.checkoutReturnUrl(invoice),
      cancelUrl: `${this.config.portalBaseUrl}/portal/billing?checkout=cancelled`,
    });

    // A rail must hand back ONE of the two payable forms. Neither means the
    // adapter is broken, and rendering a checkout with nothing on it would send
    // the customer to a dead end that looks like a product bug — so it fails
    // here, loudly, where the rail can be named.
    if (!checkout.hostedUrl && !checkout.instructions) {
      throw new ServiceUnavailableException({
        error: 'The payment rail returned no way to pay. Try again in a moment.',
      });
    }

    await this.invoices
      .updateOne(
        { _id: invoice._id },
        {
          $set: {
            checkout: toInvoiceCheckout(provider.key, checkout),
          },
        },
      )
      .exec();

    return {
      outcome: 'checkout',
      planKey: plan.key,
      invoiceId: String(invoice._id),
      ...(checkout.hostedUrl ? { hostedUrl: checkout.hostedUrl } : {}),
      ...(checkout.instructions ? { instructions: checkout.instructions } : {}),
      amountDueMinor: invoice.amountDueMinor,
      currency: invoice.currency,
    };
  }

  /**
   * Abandon a plan change that was started and never paid for, WITHOUT touching
   * the subscription the customer is actually on.
   *
   * THE GAP THIS FILLS. An upgrade raises an invoice for the new plan and
   * stamps `pendingPlanKey`; nothing clears either except a settled payment. So
   * a customer who clicked Pro and thought better of it had no way out — the
   * only visible control is "Cancel subscription", which cancels the STANDARD
   * plan they are happily paying for, and leaves the Pro invoice sitting in
   * their list with a Pay button on it forever. Observed exactly that way: an
   * `active` Standard subscription flagged cancel-at-period-end by somebody
   * trying to cancel a Pro upgrade, with the Pro invoice still open.
   *
   * The credit matters as much as the invoice. An upgrade CONSUMES the
   * proration credit at the moment it raises the invoice — `$1.01 after $0.99
   * credit` — so simply forgetting the pending change would strand that credit
   * on a document nobody will ever pay. `voidUnfundedInvoices` returns it, and
   * it also carries the in-flight guard, so an upgrade the customer has already
   * signed for is left alone rather than being cancelled out from under a
   * transfer that cannot be recalled.
   *
   * Refuses when there is nothing pending, rather than reporting a cheerful
   * success for a no-op: the portal only offers this when it can see a pending
   * change, so reaching it with none means the two disagree.
   */
  async cancelPendingChange(customerId: string): Promise<{ planKey: string }> {
    const live = await this.findLive(customerId);
    if (!live) throw new NotFoundException({ error: 'You do not have an active subscription.' });
    if (!live.pendingPlanKey) {
      throw new NotFoundException({ error: 'You have no pending plan change to cancel.' });
    }
    // `'signed'` — the customer is telling us they are not paying this. A
    // payload they were merely HANDED must not lock them out of their own
    // cancel button for the full 30-minute authorization TTL, which is what
    // happens to anyone who opens a wallet and closes it. Safe because a
    // signature we never saw, landing later, is credited rather than lost.
    if (await this.hasPaymentInFlightForSubscription(live._id, 'signed')) {
      throw new ConflictException({
        error: 'That payment is already on its way and cannot be cancelled. It will apply shortly.',
        code: 'payment-in-flight',
      });
    }

    // Returns the consumed proration credit and drops the pay panel.
    await this.voidUnfundedInvoices(live._id, 'signed');

    await this.subscriptions
      .updateOne(
        { _id: live._id },
        { $unset: { pendingPlanKey: '', pendingEffectiveAt: '' } },
      )
      .exec();

    this.logger.log(
      `Cancelled pending change to ${live.pendingPlanKey} for customer ${customerId} — staying on ${live.planKey}`,
    );
    return { planKey: live.planKey };
  }

  /**
   * Does any rail still have a completable payment for this invoice?
   *
   * Asked of EVERY configured rail rather than the invoice's own, because the
   * question is "can money still arrive", and a rail that has been switched
   * away from since checkout can still be holding a live authorization. Rails
   * that cannot have the problem simply do not implement it.
   *
   * FAILS CLOSED. If a rail throws — Mongo blip, RPC timeout — this reports
   * "in flight" and the invoice is left alone. The cost of being wrong that way
   * is a stale open invoice that the next pass retires; the cost of being wrong
   * the other way is a customer's money landing on a void invoice.
   */
  private async hasPaymentInFlight(
    invoiceId: Types.ObjectId,
    mode: InFlightMode = 'any',
  ): Promise<boolean> {
    for (const provider of this.registry.all()) {
      if (!provider.hasPaymentInFlight) continue;
      try {
        if (await provider.hasPaymentInFlight(String(invoiceId), mode)) return true;
      } catch (err) {
        this.logger.error(
          `[alert] payments.in_flight_check_failed provider=${provider.key} invoice=${String(invoiceId)} ` +
            `— treating as in flight. ${err instanceof Error ? err.message : String(err)}`,
        );
        return true;
      }
    }
    return false;
  }

  /**
   * The same question for a whole subscription, for callers that must refuse
   * BEFORE changing anything — `changePlan`, which would otherwise raise the
   * new invoice and then discover it cannot retire the old one.
   */
  async hasPaymentInFlightForSubscription(
    subscriptionId: Types.ObjectId,
    mode: InFlightMode = 'any',
  ): Promise<boolean> {
    // No projection: this returns at most a couple of open invoices per
    // subscription, and a `.select()` here bought nothing while adding a
    // query-builder method the in-memory test model does not implement.
    const open = await this.invoices
      .find({ subscriptionId, status: 'open', amountPaidMinor: { $lte: 0 } })
      .lean()
      .exec();
    for (const invoice of open) {
      if (await this.hasPaymentInFlight(invoice._id as Types.ObjectId, mode)) return true;
    }
    return false;
  }

  /**
   * Void this subscription's open invoices that have nothing attached, and
   * RETURN any account credit they consumed.
   *
   * Shared with `SubscriptionSweepService`, which has the same problem in three
   * more places (grace expiry, cancellation, abandoned checkout). See the note
   * at the call site above for why the credit half is not optional.
   */
  async voidUnfundedInvoices(
    subscriptionId: Types.ObjectId,
    /**
     * `'signed'` when the customer has explicitly said they are not paying —
     * see `InFlightMode`. Defaults to the cautious reading, so an implicit void
     * (a plan change) still protects a payload that might yet be signed.
     */
    mode: InFlightMode = 'any',
  ): Promise<void> {
    const open = await this.invoices
      .find({ subscriptionId, status: 'open', amountPaidMinor: { $lte: 0 } })
      .lean()
      .exec();
    for (const invoice of open) {
      /*
       * `amountPaidMinor: 0` MEANS "NO MONEY HAS ARRIVED", NOT "NO MONEY IS
       * COMING", and on a self-custody rail those are different facts.
       *
       * Once a payload has been issued to a wallet the customer holds a
       * signable instrument, and on the self-submit path their own wallet
       * broadcasts it — nothing here can stop that transfer. Voiding the
       * invoice underneath it produced the worst outcome available: the money
       * settled against an invoice that could no longer take it, the fold
       * refused `invoice-not-payable`, and the customer stayed on Free while
       * the portal asked them to pay again. Observed with a plan switch 270ms
       * after the first choice.
       *
       * So the invoice stays open while an authorization is live. It is not
       * indefinite: `hasPaymentInFlight` is bounded by the signature's own
       * `validBefore`, so this defers the void by minutes, and the next attempt
       * (a later plan change, the sweep) voids it once the window has passed.
       * Callers that offer the customer a choice should ask
       * `hasPaymentInFlightForSubscription` FIRST and refuse up front, rather
       * than half-applying a change whose old invoice cannot be retired.
       */
      if (await this.hasPaymentInFlight(invoice._id as Types.ObjectId, mode)) {
        this.logger.warn(
          `Not voiding invoice #${invoice.number} — a payment is in flight against it. ` +
            'It stays payable until the authorization expires or settles.',
        );
        continue;
      }

      /*
       * ONLY the part that came OUT of the balance goes back into it.
       *
       * This read `creditAppliedMinor` — the total — and that MINTED MONEY. An
       * upgrade invoice's discount is a proration (the unused value of the plan
       * being left, never in the balance) plus any balance spend, so voiding
       * one credited the customer with the proration as real, spendable
       * balance. It compounded: each upgrade→cancel cycle prorated again AND
       * spent the phantom balance, so a customer went $0.99 → $1.98 → $2.97
       * with nothing paid, and that balance settles genuine invoices.
       *
       * Not returning the proration is correct rather than merely cautious —
       * voiding the upgrade leaves them on the plan they already have, so the
       * unused period is still theirs.
       */
      const refund = Math.max(0, Math.round(invoice.creditFromBalanceMinor ?? 0));
      // Void first; refund only when the write actually moved the row, so a
      // concurrent caller cannot return the same credit twice.
      const voided = await this.invoices
        .updateOne(
          { _id: invoice._id, status: 'open' },
          { $set: { status: 'void' }, $unset: { checkout: '' } },
        )
        .exec();
      if (voided.modifiedCount === 0) continue;
      if (refund > 0) {
        await this.customers
          .updateOne({ _id: invoice.customerId }, { $inc: { creditBalanceMinor: refund } })
          .exec();
        this.logger.log(
          `Returned ${refund} of credit to customer ${String(invoice.customerId)} from voided invoice #${invoice.number}`,
        );
      }
    }
  }

  /**
   * Settle an invoice that account credit has already covered in full.
   *
   * PUBLIC because the renewal sweep needs it too, and that is the bug it was
   * extracted for: `renewPass` raises the renewal invoice with
   * `applyCustomerCredit: true`, which DEDUCTS the customer's balance — and
   * then only minted a checkout when `amountDueMinor > 0`. A renewal fully
   * covered by credit therefore had the credit spent, no pay link, no email,
   * and an invoice left `open` at zero, so the subscription lapsed to Free at
   * period end. The customer had paid (in credit) and got nothing.
   *
   * Routed through `PaymentApplyService` with a synthetic zero-amount `manual`
   * payment rather than flipping the invoice inline: one extra write buys the
   * property that the receipt, the period advance, the pending-change promotion
   * and the `planSource` stamp cannot drift between "paid with money" and "paid
   * with credit". The payment id is deterministic, so a doubled call collides
   * on the unique index instead of settling twice.
   */
  async settleFromCredit(invoice: { _id: unknown; currency: string }, now: Date): Promise<void> {
    await this.applyService.apply({
      provider: MANUAL_PROVIDER_KEY,
      invoiceId: String(invoice._id),
      note: 'Covered in full by account credit',
      payment: {
        providerPaymentId: manualPaymentId(String(invoice._id), 'account-credit'),
        status: 'succeeded',
        amountMinor: 0,
        currency: invoice.currency,
        reference: String(invoice._id),
        receivedAt: now,
      },
    });
  }

  /**
   * Where the rail sends the browser after a successful payment.
   *
   * Carries the invoice id AND its `returnToken`, because the browser arriving
   * here very often has no portal session — see `Invoice.returnToken`. Built in
   * one place so the checkout path and the sweep's renewal path cannot produce
   * different URLs, one of which works.
   */
  checkoutReturnUrl(invoice: { _id: unknown; returnToken?: string }): string {
    const base = `${this.config.portalBaseUrl}/portal/checkout/return?invoice=${String(invoice._id)}`;
    return invoice.returnToken ? `${base}&t=${invoice.returnToken}` : base;
  }

  /**
   * The open invoice a repeat checkout should be handed back, if there is one.
   *
   * An EXPIRED pay link does not count: handing back a dead URL is worse than
   * minting a fresh one, because the customer clicks it, fails, and concludes
   * the product is broken. Falling through re-raises against the same
   * `{subscriptionId, periodStart}`, so E11000 reuses the same invoice row and
   * only the link is replaced — no second bill.
   */
  private async findResumableInvoice(
    subscriptionId: Types.ObjectId,
    planKey: string,
    priceId: string,
    now: Date,
  ): Promise<InvoiceDoc | null> {
    const open = await this.invoices
      .findOne({ subscriptionId, planKey, priceId, status: 'open' })
      .sort({ createdAt: -1 })
      .exec();
    // EITHER RAIL SHAPE COUNTS. This used to require `hostedUrl`, which no
    // crypto rail ever sets — so on the self-custody rails it always returned
    // null, `startCheckout` fell through to `changePlan`, and asking to pay the
    // invoice you already have was answered by comparing the plan against
    // ITSELF: `targetMonthly <= currentMonthly` is true for an identical plan, so
    // the customer got `outcome: 'scheduled'` — "your plan will change at period
    // end" — for a payment that was sitting there unpaid. Same bug, same shape,
    // as the renewal pass that once checked `hostedCheckout` alone.
    const payable = open?.checkout?.hostedUrl ?? open?.checkout?.instructions;
    if (!payable) return null;
    const expiresAt = open?.checkout?.expiresAt;
    if (expiresAt && expiresAt.getTime() <= now.getTime()) return null;
    return open as InvoiceDoc;
  }

  /**
   * The next human-facing invoice number.
   *
   * `$inc` on a single counter document, which is atomic server-side. A
   * read-then-write "max + 1" can hand the same number to two concurrent
   * creations, and `Invoice.number` carries no unique index of its own, so
   * nothing downstream would notice — two invoices, one number, in an
   * accountant's sequence.
   */
  private async nextInvoiceNumber(): Promise<number> {
    const counter = await this.counters
      .findOneAndUpdate(
        { _id: INVOICE_NUMBER_COUNTER_KEY },
        { $inc: { seq: 1 } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      )
      .lean()
      .exec();
    return counter?.seq ?? 1;
  }

  /**
   * The plan + price a customer is allowed to buy, or a 400 saying why not.
   *
   * Read from Mongo through `PlansService.getByKey`, never from the settings
   * cache — see that method. Every gate is re-checked here rather than trusted
   * from the pricing page, because the pricing page is a public read and the
   * request is a purchase.
   */
  private async resolvePurchasable(
    planKey: string,
    priceId?: string,
  ): Promise<{ plan: PlanDoc; price: PlanPrice }> {
    const plan = (await this.plans.getByKey(planKey)) as PlanDoc | null;
    if (!plan) throw new NotFoundException({ error: `No plan '${planKey}'.` });
    if (!plan.enabled) throw new BadRequestException({ error: `${plan.name} is no longer available.` });
    if (!plan.selfServe) {
      throw new BadRequestException({
        error: `${plan.name} is not self-serve — contact us and we will set it up.`,
      });
    }

    const prices = (plan.prices ?? []).filter((p) => isActivePrice(p) && p.unitAmountMinor > 0);
    const price = priceId ? prices.find((p) => p.id === priceId) : prices.find((p) => p.interval === 'month');
    if (!price) {
      throw new BadRequestException({
        error: priceId
          ? `Price '${priceId}' is not available on ${plan.name}.`
          : `${plan.name} has no purchasable price.`,
      });
    }
    return { plan, price: { ...price, intervalCount: price.intervalCount || 1 } };
  }
}

/** The lean plan document shape this service reads. */
interface PlanDoc {
  key: string;
  name: string;
  enabled: boolean;
  selfServe: boolean;
  prices?: PlanPrice[];
}

/** A hydrated invoice document with the fields this service writes back. */
type InvoiceDoc = Invoice & { _id: Types.ObjectId };

/**
 * `ProviderCheckout` → the embedded `Invoice.checkout` document.
 *
 * ONE place does this translation, shared with the sweep's renewal path.
 * Spreading only the key that is present matters: Mongoose strips `undefined`
 * from an update, so a literal `{ hostedUrl: undefined }` is merely a no-op
 * today — but the moment this is used with `$set` on an EXISTING checkout, an
 * absent key leaves the previous rail's value in place, and a stale pay link
 * beside fresh on-chain instructions is two contradictory ways to pay one
 * invoice.
 */
export function toInvoiceCheckout(providerKey: string, checkout: ProviderCheckout): InvoiceCheckout {
  return {
    provider: providerKey,
    ref: checkout.ref,
    ...(checkout.hostedUrl ? { hostedUrl: checkout.hostedUrl } : {}),
    ...(checkout.instructions ? { instructions: { ...checkout.instructions } } : {}),
    ...(checkout.expiresAt ? { expiresAt: checkout.expiresAt } : {}),
  };
}

/**
 * A price expressed as minor units PER MONTH, so cadences are comparable.
 *
 * This is the upgrade/downgrade discriminator. Comparing raw `unitAmountMinor`
 * would rank a $790 annual plan above a $99 monthly one on the strength of the
 * number alone and get the direction wrong in both directions at once.
 */
export function monthlyEquivalentMinor(price: {
  unitAmountMinor: number;
  interval: 'month' | 'year';
  intervalCount?: number;
}): number {
  const count = Math.max(1, Math.round(price.intervalCount ?? 1));
  const months = price.interval === 'year' ? 12 * count : count;
  return price.unitAmountMinor / months;
}

/** `1 Sep – 1 Oct 2026`, for the line the rail shows on its checkout page. */
function formatPeriod(start: Date, end: Date): string {
  const fmt = (d: Date) =>
    d.toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' });
  return `${fmt(start)} – ${fmt(end)}`;
}
