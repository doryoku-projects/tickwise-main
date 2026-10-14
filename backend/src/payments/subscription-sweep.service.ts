import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Customer } from '../billing/customer.schema.js';
import { MeteringService } from '../billing/metering.service.js';
import { isActivePrice, type PlanPrice } from '../billing/plan.schema.js';
import { PlansService } from '../billing/plans.service.js';
import { DEFAULT_PLAN_KEY } from '../billing/plans.seed.js';
import { SettingsCacheService } from '../billing/settings-cache.service.js';
import { InvalidationBus } from '../common/invalidation-bus.js';
import { AppConfigService } from '../config/app-config.service.js';
import { BillingMailService } from './billing-mail.service.js';
import { addDays, addInterval, daysBetween } from './entitlement-fold.js';
import { PaymentProviderRegistry } from './provider-registry.js';
import { Invoice } from './schemas/invoice.schema.js';
import type { InFlightMode } from './payment-provider.interface.js';
import { Subscription, LIVE_SUBSCRIPTION_STATUSES } from './schemas/subscription.schema.js';
import {
  monthlyEquivalentMinor,
  SubscriptionsService,
  toInvoiceCheckout,
} from './subscriptions.service.js';

/**
 * The invoice fields `mintRenewalCheckout` needs, structurally.
 *
 * A precise shape rather than the hydrated document type, so the helper can be
 * handed either a freshly-created invoice or a `.lean()` row read back from the
 * renew pass's existence check without a cast to something broader than it uses.
 */
type RenewalInvoice = {
  _id: unknown;
  amountDueMinor: number;
  currency: string;
  returnToken?: string;
};

/** What one sweep tick did. Returned so the admin trigger can report it. */
export interface SweepReport {
  renewalsRaised: number;
  lapsed: number;
  graceExpired: number;
  planChangesApplied: number;
  ended: number;
  healed: number;
  /** Open invoices retired because their subscription is over. */
  orphansRetired: number;
  errors: number;
}

/** How many documents one pass will touch. A tick must always terminate. */
const SWEEP_BATCH = 200;

/**
 * How long an `incomplete` subscription may sit before it is treated as an
 * abandoned checkout. Comfortably longer than any pay link's own life
 * (`RADOM_CHECKOUT_TTL_MS`, 1h by default), so a customer who is slowly
 * arranging a transfer is never expired out from under a live link.
 */
const ABANDONED_CHECKOUT_MS = 24 * 60 * 60 * 1000;

/**
 * The subscription lifecycle clock.
 *
 * NOTHING ON THE RAIL SIDE RENEWS ANYTHING. Radom's pay-link rail has
 * `recurring: false`, so this sweep is the only thing in the system that will
 * ever bill a second period, notice a lapse, or cut access when grace runs out.
 * If it stops running, subscriptions silently continue forever, free.
 *
 * FIVE PASSES, in dependency order — each one's output is the next one's input,
 * so a subscription can move renewal → lapse → grace-expiry across three ticks
 * without any pass having to know about the others:
 *
 *   1. RENEW      active, ending within the lead time  → raise the next invoice
 *   2. LAPSE      period ended, unpaid                 → past_due + graceEndsAt
 *   3. EXPIRE     grace ran out                        → unpaid + drop to Free
 *   4. CHANGE     a scheduled downgrade came due       → apply it
 *   5. HEAL       plan pointer disagrees with reality  → fix the pointer
 *
 * EVERY PASS IS IDEMPOTENT. A doubled tick (two pods, a retry after a timeout,
 * an admin pressing the button) must be a no-op, so each pass either filters on
 * the state it is about to leave — `status: 'active'` → `past_due` cannot match
 * twice — or relies on a unique index, as the renewal pass does through
 * `{subscriptionId, periodStart}`.
 *
 * ERRORS ARE PER-SUBSCRIPTION. One customer whose plan was deleted must not
 * stop the sweep for everyone else, so each document is wrapped and a failure
 * increments `errors` and moves on.
 */
@Injectable()
export class SubscriptionSweepService {
  private readonly logger = new Logger(SubscriptionSweepService.name);
  /**
   * Coalescing guard. The sweep can be triggered by cron AND by an admin at the
   * same moment; two concurrent passes would both see the same lapsed
   * subscriptions and both send the grace-warning email.
   */
  private inFlight?: Promise<SweepReport>;

  constructor(
    @InjectModel(Subscription.name) private readonly subscriptions: Model<Subscription>,
    @InjectModel(Invoice.name) private readonly invoices: Model<Invoice>,
    @InjectModel(Customer.name) private readonly customers: Model<Customer>,
    @Inject(SubscriptionsService) private readonly subs: SubscriptionsService,
    @Inject(PlansService) private readonly plans: PlansService,
    @Inject(SettingsCacheService) private readonly settings: SettingsCacheService,
    @Inject(MeteringService) private readonly metering: MeteringService,
    @Inject(BillingMailService) private readonly mail: BillingMailService,
    @Inject(PaymentProviderRegistry) private readonly registry: PaymentProviderRegistry,
    @Inject(AppConfigService) private readonly config: AppConfigService,
    /**
     * APPENDED and optional (P2.2): every plan move this sweep writes reaches
     * the API-key resolve caches at once (here and on the other replicas)
     * instead of within their 30 s TTL. Absent / CACHE_INVALIDATION=off = today.
     */
    @Optional() @Inject(InvalidationBus) private readonly bus?: InvalidationBus,
  ) {}

  /** Run one tick, or join the one already running. */
  async sweep(now: Date = new Date()): Promise<SweepReport> {
    if (this.inFlight) {
      this.logger.log('Sweep already in flight — joining it');
      return this.inFlight;
    }
    this.inFlight = this.runSweep(now).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async runSweep(now: Date): Promise<SweepReport> {
    const report: SweepReport = {
      renewalsRaised: 0,
      lapsed: 0,
      graceExpired: 0,
      planChangesApplied: 0,
      ended: 0,
      healed: 0,
      orphansRetired: 0,
      errors: 0,
    };
    await this.expireAbandonedCheckoutsPass(now, report);
    await this.retireOrphanedInvoicesPass(report);
    await this.renewPass(now, report);
    await this.lapsePass(now, report);
    await this.graceExpiryPass(now, report);
    await this.scheduledChangePass(now, report);
    await this.healPass(now, report);

    const touched =
      report.renewalsRaised + report.lapsed + report.graceExpired + report.planChangesApplied + report.ended + report.healed;
    if (touched > 0 || report.errors > 0) {
      this.logger.log(`Subscription sweep: ${JSON.stringify(report)}`);
    }
    if (report.errors > 0) {
      this.logger.error(`[alert] payments.sweep_errors count=${report.errors}`);
    }
    return report;
  }

  /**
   * PASS 0 — age out a checkout nobody ever paid.
   *
   * WHY IT HAS TO EXIST. `incomplete` is a LIVE status, backing the partial
   * unique `{customerId}` index, which is what stops a second subscription
   * being raised beside a purchase in flight. But a customer who opens checkout
   * and closes the tab leaves that row behind forever — and `startCheckout`
   * then finds a live subscription for every subsequent attempt, so they could
   * never buy anything again. The block was permanent and repairable only by
   * hand.
   *
   * The window is the PAY LINK's own lifetime plus a margin, not an arbitrary
   * timeout: while the link is live the customer may still legitimately pay it,
   * and expiring underneath them would strand a real payment. Anything older
   * moves to `incomplete_expired` — a terminal status, out of the live set —
   * and its invoice is voided, releasing the index.
   */
  private async expireAbandonedCheckoutsPass(now: Date, report: SweepReport): Promise<void> {
    const cutoff = new Date(now.getTime() - ABANDONED_CHECKOUT_MS);
    const abandoned = await this.subscriptions
      .find({ status: 'incomplete', startedAt: { $lte: cutoff } })
      .limit(SWEEP_BATCH)
      .exec();

    for (const subscription of abandoned) {
      try {
        const moved = await this.subscriptions
          .updateOne(
            { _id: subscription._id, status: 'incomplete' },
            { $set: { status: 'incomplete_expired', endedAt: now } },
          )
          .exec();
        if (moved.modifiedCount === 0) continue;

        // Only invoices with nothing attached. One that took a part payment or
        // consumed credit has real money against it — see `voidUnfundedInvoices`.
        await this.voidUnfundedInvoices(subscription._id as Types.ObjectId);
        report.ended += 1;
        this.logger.log(
          `Expired an abandoned checkout for customer ${String(subscription.customerId)} — they can subscribe again`,
        );
      } catch (err) {
        report.errors += 1;
        this.logger.error(
          `Expiring abandoned checkout ${String(subscription._id)} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * PASS 1 — raise the next period's invoice, `SUBSCRIPTION_RENEWAL_LEAD_DAYS`
   * before it starts.
   *
   * The lead time is the customer's ENTIRE window to pay, because nothing
   * charges them automatically. It has to cover arranging a crypto transfer,
   * not merely confirming one.
   *
   * A subscription set to `cancelAtPeriodEnd` is skipped: raising an invoice
   * for a period the customer has said they do not want is a bill for something
   * nobody agreed to buy. Pass 3's sibling below is what actually ends it.
   */
  /**
   * Pass 0b — open invoices whose subscription is already over.
   *
   * WHY THIS EXISTS. `expireAbandonedCheckoutsPass` above filters on
   * `status: 'incomplete'`, so it only ever sees a subscription on its way OUT.
   * Anything already `incomplete_expired` — because `cancel` abandoned it on
   * demand — is invisible to it, and so are that subscription's invoices.
   *
   * That was harmless until `voidUnfundedInvoices` started (correctly) DECLINING
   * to void an invoice with a payment in flight. Now an abandoned checkout can
   * legitimately leave an open invoice behind, and with no pass revisiting it
   * the customer keeps an "Awaiting payment" row in their invoice list forever,
   * for a plan they cancelled. Seen exactly that way on 2026-08-14: invoice #15
   * spared by the guard, its subscription abandoned, and nothing left that
   * would ever tidy it.
   *
   * The deferral is the whole design: skip it while money can still arrive, and
   * retire it on a later tick once the authorization has expired.
   * `voidUnfundedInvoices` re-checks that itself, so this pass does not need to
   * — it only has to keep ASKING, which is what nothing else was doing.
   */
  private async retireOrphanedInvoicesPass(report: SweepReport): Promise<void> {
    const open = await this.invoices
      .find({ status: 'open', amountPaidMinor: { $lte: 0 } })
      .select({ subscriptionId: 1 })
      .limit(SWEEP_BATCH)
      .lean()
      .exec();
    if (open.length === 0) return;

    // One void call per SUBSCRIPTION, not per invoice — `voidUnfundedInvoices`
    // already walks every open invoice on the one it is given.
    const subscriptionIds = [...new Set(open.map((i) => String(i.subscriptionId)))];

    for (const id of subscriptionIds) {
      try {
        const subscription = await this.subscriptions
          .findById(id)
          .select({ status: 1 })
          .lean()
          .exec();
        // No subscription at all is ALSO orphaned — a broken document should not
        // leave a payable invoice standing.
        if (subscription && LIVE_SUBSCRIPTION_STATUSES.includes(subscription.status)) continue;

        // `'signed'`: the subscription is already over, so nothing can be
        // granted and voiding only tidies. Holding an orphan open for a payload
        // that may never be signed leaves the customer staring at "Awaiting
        // payment" for a plan they cancelled — and if a signature does land
        // later, the apply path credits it.
        await this.voidUnfundedInvoices(new Types.ObjectId(id), 'signed');
        report.orphansRetired += 1;
      } catch (err) {
        report.errors += 1;
        this.logger.error(
          `Orphaned-invoice retire failed for subscription ${id}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
  }

  private async renewPass(now: Date, report: SweepReport): Promise<void> {
    const horizon = addDays(now, this.config.subscriptionRenewalLeadDays);
    const due = await this.subscriptions
      .find({ status: 'active', cancelAtPeriodEnd: false, currentPeriodEnd: { $lte: horizon } })
      .limit(SWEEP_BATCH)
      .exec();

    for (const subscription of due) {
      try {
        // The plan/price for the NEXT period: a scheduled change that comes due
        // at this boundary is what should be billed, not what is running now.
        const target = await this.resolveNextPrice(subscription);
        if (!target) {
          // A plan or price that has vanished cannot be billed. Left ACTIVE
          // deliberately — the customer did nothing wrong, and letting the
          // period lapse into grace and then to Free would punish them for an
          // admin's edit. Loud instead.
          this.logger.error(
            `[alert] payments.renewal_unpriceable subscription=${String(subscription._id)} ` +
              `plan=${subscription.pendingPlanKey ?? subscription.planKey}`,
          );
          report.errors += 1;
          continue;
        }

        const periodStart = subscription.currentPeriodEnd;
        const periodEnd = addInterval(periodStart, target.price.interval, target.price.intervalCount);
        const existing = await this.invoices
          .findOne({ subscriptionId: subscription._id, periodStart })
          .lean()
          .exec();
        // The unique index makes `raiseInvoice` safe to call blind, but this
        // read keeps the sweep from re-sending the renewal email every tick for
        // the whole lead window.
        //
        // WITH ONE EXCEPTION: an OPEN renewal invoice that has no payment
        // instructions at all. A bare `continue` here meant a single failure
        // inside the mint below — an RPC blip on a crypto rail, a rail briefly
        // unconfigured, a provider 500 — left that invoice permanently unpayable,
        // because the invoice row exists so no later tick ever revisits it, and
        // it had already CONSUMED the customer's credit balance. The customer's
        // only signal was silence, then a grace expiry. Re-minting is safe and
        // idempotent (a rail keys off the invoice id), and `mintOnly` suppresses
        // the renewal email so a repaired invoice does not re-notify every tick.
        if (existing) {
          if (existing.status !== 'open' || existing.checkout) continue;
          this.logger.warn(
            `[alert] payments.renewal_missing_checkout invoice ${String(existing._id)} — ` +
              're-minting payment instructions for an open renewal that has none',
          );
          await this.mintRenewalCheckout(subscription, existing as RenewalInvoice, target, {
            mintOnly: true,
            periodStart,
          });
          continue;
        }

        const invoice = await this.subs.raiseInvoice({
          subscription: { _id: subscription._id as Types.ObjectId },
          customerId: String(subscription.customerId),
          planKey: target.planKey,
          price: target.price,
          periodStart,
          periodEnd,
          applyCustomerCredit: true,
        });

        // CREDIT COVERED IT ENTIRELY — settle now, do not mint a pay link.
        // `raiseInvoice` has already DEDUCTED the customer's balance, so
        // falling through to the `amountDueMinor > 0` branch below would leave
        // the credit spent, the invoice `open` at zero and the subscription
        // lapsing at period end. Same path a zero-due checkout takes.
        if (invoice.amountDueMinor <= 0) {
          await this.subs.settleFromCredit(invoice, now);
          report.renewalsRaised += 1;
          continue;
        }

        // Mint the pay link through the same path a checkout uses, so a
        // renewal invoice and a first invoice are indistinguishable downstream.
        // Either rail SHAPE can carry a renewal: a hosted rail returns a pay
        // link, the x402 rail returns a fresh authorization quote for
        // this period. The `hostedCheckout || onChainDirect` test is what lets a
        // renewal work on both without this pass knowing which is configured —
        // it used to check `hostedCheckout` alone, which would silently skip
        // minting anything at all on the native rail and leave the customer a
        // renewal invoice with no way to pay it.
        await this.mintRenewalCheckout(subscription, invoice, target, { periodStart });

        await this.subscriptions
          .updateOne({ _id: subscription._id }, { $set: { latestInvoiceId: invoice._id } })
          .exec();
        report.renewalsRaised += 1;
      } catch (err) {
        report.errors += 1;
        this.logger.error(
          `Renewal failed for subscription ${String(subscription._id)}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * PASS 2 — the period ended and the invoice for it is unpaid.
   *
   * `graceEndsAt` is computed from THE DOCUMENT'S OWN `currentPeriodEnd`, not
   * from `now`. That matters whenever the sweep is late: a tick that fires two
   * days after a period ended must not hand out two extra days of grace, and a
   * sweep that has been down for a week must not hand out a week. The deadline
   * is a property of the subscription, not of when we got round to noticing.
   *
   * `graceDays` likewise comes from the SUBSCRIPTION, snapshotted at signup, so
   * changing the global default never retroactively moves an existing customer's
   * deadline in either direction.
   *
   * A subscription set to `cancelAtPeriodEnd` takes the other exit: it ENDS,
   * cleanly, with no dunning for money nobody owes.
   */
  private async lapsePass(now: Date, report: SweepReport): Promise<void> {
    const overdue = await this.subscriptions
      .find({ status: 'active', currentPeriodEnd: { $lte: now } })
      .limit(SWEEP_BATCH)
      .exec();

    for (const subscription of overdue) {
      try {
        if (subscription.cancelAtPeriodEnd) {
          await this.endSubscription(subscription, now, 'cancelled at period end');
          report.ended += 1;
          continue;
        }

        const graceEndsAt = addDays(subscription.currentPeriodEnd, subscription.graceDays);
        // Filtered on `status: 'active'` — the state this pass is leaving — so
        // a doubled tick matches nothing the second time and the warning email
        // is sent once.
        const moved = await this.subscriptions
          .updateOne(
            { _id: subscription._id, status: 'active' },
            {
              $set: {
                status: 'past_due',
                graceEndsAt,
                lateByDays: daysBetween(subscription.currentPeriodEnd, now),
              },
            },
          )
          .exec();
        if (moved.modifiedCount === 0) continue;

        report.lapsed += 1;
        // ONLY warn if there is still a window to warn about.
        //
        // Pass 3 runs in the SAME tick and will expire any grace that has
        // already elapsed — which is correct when the sweep is running late
        // (down for a week, a deploy gap, a first boot after an outage): the
        // seven days really did pass, so access really should be cut. But it
        // means a late tick would otherwise send "pay by the 8th to keep your
        // plan" and "your account has moved to Free" within the same second,
        // the first of them a statement that was already untrue when it was
        // written. The downgrade notice is the honest one; send that alone.
        if (graceEndsAt.getTime() > now.getTime()) {
          await this.notifyGrace(subscription, graceEndsAt);
        } else {
          this.logger.warn(
            `[alert] payments.grace_already_elapsed subscription=${String(subscription._id)} ` +
              `graceEndsAt=${graceEndsAt.toISOString()} — sweep ran late; skipping the warning email`,
          );
        }
      } catch (err) {
        report.errors += 1;
        this.logger.error(
          `Lapse failed for subscription ${String(subscription._id)}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * PASS 3 — grace ran out. Access drops to Free.
   *
   * THE ONE THING THIS MUST NOT DO is touch `Customer.status`. That field is a
   * hard kill switch — `ClientsService.resolveByRawKey` returns null for a
   * suspended customer, so every `/v1` request 401s. Writing `'suspended'` on
   * expiry would hard-suspend the API instead of downgrading it, and the
   * customer's keys would stop working entirely rather than dropping to Free
   * limits. Only `planKey` moves.
   *
   * `resetQuotaPeriod` is why this pass cannot be a one-line `$set`: the quota
   * limiter rejects whenever consumed > the plan's allowance, and the Redis key
   * is SHARED across plan-specific limiter instances (which is what makes a
   * mid-period upgrade correct). A customer downgraded after burning 3M units
   * would otherwise 429 on every request for the rest of the calendar month,
   * with a `Retry-After` measured in weeks.
   */
  private async graceExpiryPass(now: Date, report: SweepReport): Promise<void> {
    const expired = await this.subscriptions
      .find({ status: 'past_due', graceEndsAt: { $lte: now } })
      .limit(SWEEP_BATCH)
      .exec();

    for (const subscription of expired) {
      try {
        const moved = await this.subscriptions
          .updateOne(
            { _id: subscription._id, status: 'past_due' },
            {
              $set: {
                // Stripe's name for "we gave up collecting". The row stays as
                // history; the entitlement does not.
                status: 'unpaid',
                endedAt: now,
                lateByDays: daysBetween(subscription.currentPeriodEnd, now),
              },
            },
          )
          .exec();
        if (moved.modifiedCount === 0) continue;

        await this.invoices
          .updateMany(
            { subscriptionId: subscription._id, status: 'open' },
            { $set: { status: 'uncollectible' }, $unset: { checkout: '' } },
          )
          .exec();

        const previousPlanName =
          this.settings.getPlan(subscription.planKey)?.name ?? subscription.planKey;
        await this.dropToFree(subscription, report);
        report.graceExpired += 1;

        const customer = await this.customers.findById(subscription.customerId).lean().exec();
        if (customer?.email) {
          await this.mail.downgraded({
            to: customer.email,
            previousPlanName,
            billingUrl: `${this.config.portalBaseUrl}/portal/billing`,
          });
        }
      } catch (err) {
        report.errors += 1;
        this.logger.error(
          `Grace expiry failed for subscription ${String(subscription._id)}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * PASS 4 — a scheduled plan change (a downgrade, or an interval switch to a
   * cheaper cadence) has come due.
   *
   * Only fires for a change that is NOT more expensive: an upgrade's pending
   * fields are set alongside an invoice and are promoted by the apply path when
   * that invoice settles, never here. Applying an upgrade on a timer would hand
   * out a dearer plan nobody paid for.
   */
  private async scheduledChangePass(now: Date, report: SweepReport): Promise<void> {
    const dueChanges = await this.subscriptions
      .find({
        status: { $in: LIVE_SUBSCRIPTION_STATUSES },
        pendingEffectiveAt: { $lte: now },
        pendingPlanKey: { $type: 'string' },
      })
      .limit(SWEEP_BATCH)
      .exec();

    for (const subscription of dueChanges) {
      try {
        const target = await this.resolvePendingPrice(subscription);
        if (!target) {
          this.logger.error(
            `[alert] payments.pending_change_unpriceable subscription=${String(subscription._id)} ` +
              `plan=${subscription.pendingPlanKey}`,
          );
          report.errors += 1;
          continue;
        }

        // SECOND GATE, and it is not redundant. `SubscriptionsService.changePlan`
        // leaves `pendingEffectiveAt` UNSET for an upgrade precisely so this
        // pass never sees one — but that is an invariant maintained by another
        // file, and the cost of it being broken is a customer holding a plan
        // nobody paid for. So the price is compared here too: a pending change
        // that is MORE expensive is an upgrade awaiting payment, and the apply
        // path owns it. Refusing loudly beats granting quietly.
        const pendingMonthly = monthlyEquivalentMinor(target.price);
        const currentMonthly = monthlyEquivalentMinor({
          unitAmountMinor: subscription.unitAmountMinor,
          interval: subscription.interval,
          intervalCount: 1,
        });
        if (pendingMonthly > currentMonthly) {
          this.logger.error(
            `[alert] payments.pending_upgrade_not_applied subscription=${String(subscription._id)} ` +
              `plan=${subscription.pendingPlanKey} — an upgrade must be granted by a settled invoice, never by the sweep`,
          );
          report.errors += 1;
          continue;
        }

        // Filtered on the pending key still being the one we resolved, so a
        // concurrent change request cannot be silently overwritten by a stale
        // read from this tick.
        const applied = await this.subscriptions
          .updateOne(
            { _id: subscription._id, pendingPlanKey: subscription.pendingPlanKey },
            {
              $set: {
                planKey: target.planKey,
                priceId: target.price.id,
                interval: target.price.interval,
                unitAmountMinor: target.price.unitAmountMinor,
              },
              $unset: { pendingPlanKey: '', pendingPriceId: '', pendingEffectiveAt: '' },
            },
          )
          .exec();
        if (applied.modifiedCount === 0) continue;

        // The customer's entitlement follows only for a subscription that is
        // actually entitling anything. A `past_due` one is inside grace on the
        // OLD plan and keeps it until grace decides otherwise.
        if (subscription.status === 'active') {
          await this.customers
            .updateOne(
              { _id: subscription.customerId, planSource: { $ne: 'admin' } },
              { $set: { planKey: target.planKey, planSource: 'subscription' } },
            )
            .exec();
          this.forgetCustomerKeys(subscription.customerId);
          // A downgrade is INVOLUNTARY from the quota's point of view even
          // though the customer asked for it: they may already have consumed
          // more than the smaller plan allows.
          await this.metering.resetQuotaPeriod(String(subscription.customerId));
        }
        report.planChangesApplied += 1;
      } catch (err) {
        report.errors += 1;
        this.logger.error(
          `Scheduled change failed for subscription ${String(subscription._id)}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * PASS 5 — the self-heal.
   *
   * `Customer.planKey` is what metering reads on every single request, and the
   * subscription is what justifies it. Those two can drift: a process that died
   * between the subscription write and the customer write, a hand-edited
   * document, a restored backup. The drift is invisible — nothing errors — and
   * it is expensive in exactly one direction, so that is the direction this
   * heals: a customer holding a PAID plan with nothing live to justify it.
   *
   * It deliberately does NOT heal upward. Granting a plan because a
   * subscription document says so, without an invoice to point at, would make
   * this sweep a second entitlement-granting path — and the whole design is
   * that there is one, and it is downstream of money.
   *
   * `planSource: 'admin'` is untouchable. An operator who put a customer on Pro
   * by hand did so deliberately, and that is exactly what the field records.
   */
  private async healPass(now: Date, report: SweepReport): Promise<void> {
    const suspects = await this.customers
      .find({
        planKey: { $ne: DEFAULT_PLAN_KEY },
        planSource: 'subscription',
      })
      .limit(SWEEP_BATCH)
      .lean()
      .exec();

    for (const customer of suspects) {
      try {
        const live = await this.subscriptions
          .findOne({ customerId: customer._id, status: { $in: LIVE_SUBSCRIPTION_STATUSES } })
          .lean()
          .exec();
        // A live subscription on the same plan is the healthy case. A live one
        // on a DIFFERENT plan is left alone too: it is either an upgrade in
        // flight (customer still on the old plan, correctly) or a `past_due`
        // subscription inside grace, and both are states the other passes own.
        if (live) continue;

        this.logger.warn(
          `[alert] payments.entitlement_drift customer=${String(customer._id)} plan=${customer.planKey} ` +
            '— no live subscription; dropping to free',
        );
        await this.customers
          .updateOne(
            { _id: customer._id, planSource: 'subscription' },
            { $set: { planKey: DEFAULT_PLAN_KEY }, $unset: { currentSubscriptionId: '' } },
          )
          .exec();
        this.forgetCustomerKeys(customer._id);
        await this.metering.resetQuotaPeriod(String(customer._id));
        report.healed += 1;
      } catch (err) {
        report.errors += 1;
        this.logger.error(
          `Heal failed for customer ${String(customer._id)}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // ─── helpers ───────────────────────────────────────────────────────────────

  /**
   * A customer's plan moved: drop every cached API-key resolution of theirs,
   * in this process (`local`) and on the other replicas (P2.2). A no-op while
   * CACHE_INVALIDATION=off — the resolve cache's 30 s TTL applies, as before.
   */
  private forgetCustomerKeys(customerId: unknown): void {
    this.bus?.publish({ t: 'apikey', customerId: String(customerId) }, { local: true });
  }

  /**
   * Void this subscription's open, unfunded invoices — RETURNING any account
   * credit they consumed.
   *
   * Delegates to `SubscriptionsService` rather than repeating the query: the
   * credit-refund half is the bug this exists for (see that method), and a
   * second copy is the one that would not get the fix next time.
   */
  private async voidUnfundedInvoices(
    subscriptionId: Types.ObjectId,
    mode: InFlightMode = 'any',
  ): Promise<void> {
    await this.subs.voidUnfundedInvoices(subscriptionId, mode);
  }

  /** End a cancelled subscription cleanly at its period boundary. */
  private async endSubscription(
    subscription: SubscriptionDoc,
    now: Date,
    reason: string,
  ): Promise<void> {
    const moved = await this.subscriptions
      .updateOne(
        { _id: subscription._id, status: 'active' },
        { $set: { status: 'canceled', endedAt: now, cancellationReason: reason } },
      )
      .exec();
    if (moved.modifiedCount === 0) return;

    await this.voidUnfundedInvoices(subscription._id as Types.ObjectId);

    const previousPlanName = this.settings.getPlan(subscription.planKey)?.name ?? subscription.planKey;
    await this.dropToFree(subscription, undefined);
    const customer = await this.customers.findById(subscription.customerId).lean().exec();
    if (customer?.email) {
      await this.mail.downgraded({
        to: customer.email,
        previousPlanName,
        billingUrl: `${this.config.portalBaseUrl}/portal/billing`,
      });
    }
  }

  /**
   * Move a customer to Free and give them their month back.
   *
   * `planSource: {$ne: 'admin'}` in the filter is the whole safety of this: an
   * operator's manual grant outranks the lifecycle, and a subscription lapsing
   * must not silently revoke it.
   */
  private async dropToFree(subscription: SubscriptionDoc, report: SweepReport | undefined): Promise<void> {
    const moved = await this.customers
      .updateOne(
        { _id: subscription.customerId, planSource: { $ne: 'admin' } },
        { $set: { planKey: DEFAULT_PLAN_KEY }, $unset: { currentSubscriptionId: '' } },
      )
      .exec();
    if (moved.matchedCount === 0) {
      this.logger.log(
        `Customer ${String(subscription.customerId)} kept an admin-set plan through a lapse — not downgraded`,
      );
      return;
    }
    this.forgetCustomerKeys(subscription.customerId);
    await this.metering.resetQuotaPeriod(String(subscription.customerId));
    if (report) report.healed += 0; // counted by the calling pass, not here
  }

  /**
   * Mint payment instructions onto a renewal invoice, and (unless `mintOnly`)
   * email the customer that it is due.
   *
   * Extracted so the renew pass can also REPAIR an open renewal invoice that has
   * no instructions — the case a bare `if (existing) continue` used to leave
   * permanently unpayable after a single transient mint failure. `mintOnly`
   * suppresses the email on that repair path, because the customer has already
   * been told the renewal is due and telling them again every tick would be its
   * own bug.
   *
   * Either rail SHAPE can carry a renewal: a hosted rail returns a pay link, a
   * self-custody rail returns an address or an authorization quote for this
   * period. The `hostedCheckout || onChainDirect` test is what lets a renewal
   * work on both without this pass knowing which is configured — it used to check
   * `hostedCheckout` alone, which silently minted nothing on a crypto rail and
   * left the customer a renewal invoice with no way to pay it.
   */
  private async mintRenewalCheckout(
    subscription: SubscriptionDoc,
    invoice: RenewalInvoice,
    target: { planName: string },
    opts: { periodStart: Date; mintOnly?: boolean },
  ): Promise<void> {
    const provider = this.registry.find(subscription.provider);
    if (!provider) return;
    if (!provider.capabilities.hostedCheckout && !provider.capabilities.onChainDirect) return;

    const customer = await this.customers.findById(subscription.customerId).lean().exec();
    const checkout = await provider.createCheckout({
      reference: String(invoice._id),
      // Required by the self-custody rails' own rows — see the same note in
      // `SubscriptionsService.finishInvoice`.
      customerId: String(subscription.customerId),
      amountMinor: invoice.amountDueMinor,
      currency: invoice.currency,
      description: `${target.planName} renewal`,
      ...(customer?.email ? { customerEmail: customer.email } : {}),
      successUrl: this.subs.checkoutReturnUrl(invoice),
      cancelUrl: `${this.config.portalBaseUrl}/portal/billing`,
    });
    await this.invoices
      .updateOne({ _id: invoice._id }, { $set: { checkout: toInvoiceCheckout(provider.key, checkout) } })
      .exec();

    if (opts.mintOnly) return;

    // The renewal email needs somewhere to send them. A hosted rail has a link;
    // a self-custody rail's "link" is the portal's own billing page, which
    // renders the address — an email must never carry a payment address, because
    // an address in an email is the phishing primitive.
    await this.notifyRenewal(
      subscription,
      invoice,
      target.planName,
      checkout.hostedUrl ?? `${this.config.portalBaseUrl}/portal/billing`,
      opts.periodStart,
    );
  }

  private async notifyRenewal(
    subscription: SubscriptionDoc,
    invoice: { amountDueMinor: number; currency: string },
    planName: string,
    payUrl: string,
    dueBy: Date,
  ): Promise<void> {
    const customer = await this.customers.findById(subscription.customerId).lean().exec();
    if (!customer?.email) return;
    await this.mail.renewalDue({
      to: customer.email,
      planName,
      amountMinor: invoice.amountDueMinor,
      currency: invoice.currency,
      dueBy,
      payUrl,
    });
  }

  private async notifyGrace(subscription: SubscriptionDoc, graceEndsAt: Date): Promise<void> {
    const [customer, invoice] = await Promise.all([
      this.customers.findById(subscription.customerId).lean().exec(),
      this.invoices
        .findOne({ subscriptionId: subscription._id, status: 'open' })
        .sort({ periodStart: -1 })
        .lean()
        .exec(),
    ]);
    if (!customer?.email || !invoice) return;
    await this.mail.graceWarning({
      to: customer.email,
      planName: this.settings.getPlan(subscription.planKey)?.name ?? subscription.planKey,
      amountMinor: Math.max(0, invoice.amountDueMinor - invoice.amountPaidMinor),
      currency: invoice.currency,
      graceEndsAt,
      payUrl: invoice.checkout?.hostedUrl ?? `${this.config.portalBaseUrl}/portal/billing`,
    });
  }

  /**
   * The plan + price the NEXT period should be billed at.
   *
   * **AN UNCHANGED RENEWAL IS BILLED AT THE SUBSCRIPTION'S OWN LOCKED
   * `unitAmountMinor`, not at the plan's current price.** `lookupPrice` reads
   * the plan live from Mongo, so without this override an admin repricing a
   * plan would silently reprice every existing subscriber on their next
   * renewal — which is exactly what `Subscription.unitAmountMinor`'s own
   * comment says must not happen ("LOCKED at subscribe time … every renewal
   * invoice is drawn from THIS value, not from the current `Plan.prices[]`").
   * The stored price row is still needed for its cadence and currency; only
   * the amount comes from the subscription.
   *
   * A scheduled CHANGE is different and correctly uses the new plan's current
   * price — the customer is buying something they have not bought before, so
   * there is no locked amount to honour.
   */
  private async resolveNextPrice(subscription: SubscriptionDoc) {
    if (
      subscription.pendingPlanKey &&
      subscription.pendingEffectiveAt &&
      subscription.pendingEffectiveAt.getTime() <= subscription.currentPeriodEnd.getTime()
    ) {
      const pending = await this.lookupPrice(subscription.pendingPlanKey, subscription.pendingPriceId);
      if (pending) return pending;
    }

    const current = await this.lookupPrice(subscription.planKey, subscription.priceId);
    if (!current) return null;
    return {
      ...current,
      price: { ...current.price, unitAmountMinor: subscription.unitAmountMinor },
    };
  }

  private async resolvePendingPrice(subscription: SubscriptionDoc) {
    if (!subscription.pendingPlanKey) return null;
    return this.lookupPrice(subscription.pendingPlanKey, subscription.pendingPriceId);
  }

  /**
   * Look a stored `(planKey, priceId)` pair back up.
   *
   * A DEACTIVATED price still resolves, and that is deliberate: `active: false`
   * means "not on sale to new customers", not "existing subscribers are
   * cancelled". Withdrawing a price from the pricing page must not lapse
   * everybody who is on it. A price that has been DELETED outright cannot be
   * billed, and that returns null so the caller can shout instead of guessing.
   */
  private async lookupPrice(
    planKey: string,
    priceId?: string,
  ): Promise<{ planKey: string; planName: string; price: PlanPrice } | null> {
    const plan = await this.plans.getByKey(planKey);
    if (!plan) return null;
    const prices = (plan.prices ?? []) as PlanPrice[];
    const exact = priceId ? prices.find((p) => p.id === priceId) : undefined;
    const price = exact ?? prices.find((p) => isActivePrice(p) && p.interval === 'month');
    if (!price || price.unitAmountMinor <= 0) return null;
    return {
      planKey: plan.key,
      planName: plan.name,
      price: { ...price, intervalCount: price.intervalCount || 1 },
    };
  }
}

/** The hydrated subscription shape the passes work with. */
type SubscriptionDoc = Subscription & { _id: Types.ObjectId };
