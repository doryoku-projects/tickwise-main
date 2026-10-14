import type { InvoiceStatus } from './schemas/invoice.schema.js';
import { LIVE_SUBSCRIPTION_STATUSES, type SubscriptionStatus } from './schemas/subscription.schema.js';

/**
 * THE MONEY DECISION, as a pure function.
 *
 * Everything about "did this payment settle the invoice, and what does the
 * customer get" lives here and nowhere else. `PaymentApplyService` translates
 * the answer into Mongo writes and sends the mail; it makes no decisions of its
 * own. The webhook and the admin `mark-paid` path both go through that one
 * service, so they cannot diverge.
 *
 * Pure because this is the part that must be exhaustively testable with zero
 * infrastructure: no Mongo, no Redis, no rail. Every branch below is reachable
 * from a plain object literal in a spec.
 */

/**
 * Default underpay tolerance: $1.00, in minor units.
 *
 * OVERRIDABLE PER CALL, and the reason is a real one rather than flexibility
 * for its own sake. A FLAT tolerance is wrong at both ends of a price range:
 * on a $790 plan a dollar is noise, but on a $2 plan it is HALF THE PRICE — and
 * on a $1 plan it is the entire price, so a payment of one cent (or of nothing
 * at all) settles the invoice and grants the plan. That makes a small-value
 * live test worthless: it goes green without proving anything about amounts.
 *
 * `PAYMENTS_UNDERPAY_TOLERANCE_MINOR` sets it deployment-wide; the fold itself
 * stays PURE by taking it as an input with this default, so no spec has to
 * stand up a config to exercise the boundary.
 */
export const UNDERPAY_TOLERANCE_MINOR = 100;

/** The invoice as the fold needs to see it. A subset of `Invoice`. */
export interface FoldInvoice {
  /**
   * Money. Integer minor units. LIST price for the period, before any credit —
   * so this, not `amountDueMinor`, is what the next renewal is drawn at. An
   * upgrade invoice reduced to $4 by proration must not reprice the plan to $4.
   */
  subtotalMinor: number;
  /** Money. Integer minor units. What the customer was asked for. */
  amountDueMinor: number;
  /** Money. Integer minor units. Accumulated across PRIOR attempts. */
  amountPaidMinor: number;
  currency: string;
  status: InvoiceStatus;
  periodStart: Date;
  periodEnd: Date;
  /**
   * The plan this invoice BUYS — see `Invoice.planKey`. Entitlement is granted
   * from here and never from the subscription's current plan, so an upgrade
   * invoice grants the plan the customer moved to, at the moment they pay for
   * it and not before.
   */
  planKey: string;
  priceId: string;
  interval: 'month' | 'year';
}

/**
 * The subscription as the fold needs to see it. A subset of `Subscription`.
 *
 * Note what is ABSENT: the current `planKey`. Entitlement comes from the
 * invoice — see `FoldInvoice.planKey` — so the fold physically cannot grant the
 * plan a customer is on instead of the one they just bought.
 */
export interface FoldSubscription {
  status: SubscriptionStatus;
  currentPeriodEnd: Date;
  /** Whether the customer asked to stop at the end of this period. */
  cancelAtPeriodEnd: boolean;
}

/** One confirmed settlement, already re-fetched from the rail. */
export interface FoldPayment {
  /** Money. Integer minor units, in `currency`. What actually arrived. */
  amountMinor: number;
  currency: string;
}

export interface FoldInput {
  invoice: FoldInvoice;
  subscription: FoldSubscription;
  payment: FoldPayment;
  /**
   * Money. How far SHORT a payment may fall and still settle. Defaults to
   * `UNDERPAY_TOLERANCE_MINOR` — see there for why it is not a constant.
   *
   * A negative value is clamped to 0 (exact payment required) rather than
   * inverted into a surcharge.
   */
  toleranceMinor?: number;
}

/**
 * Why a payment did NOT settle its invoice. Every one of these is a BUSINESS
 * outcome — recorded, answered 200, never a 500. A 500 tells the rail to retry
 * something that will fail identically forever.
 */
export type FoldRefusal =
  | 'currency-mismatch'
  | 'invoice-not-payable'
  | 'subscription-not-live'
  | 'short-paid';

export interface FoldDecision {
  /** Whether the invoice is settled by this payment (tolerance included). */
  settled: boolean;
  /** Set when `settled` is false and the reason is not simply "not enough yet". */
  refusal?: FoldRefusal;

  /** Money. New accumulated total to STORE on the invoice. */
  invoicePaidMinor: number;
  invoiceStatus: InvoiceStatus;
  /**
   * Money. What is still owed after this payment, floored at 0. Non-zero on a
   * tolerated underpay too — the customer is entitled, and we are still short.
   * Kept so dunning copy and the admin view can say how short.
   */
  shortfallMinor: number;
  /**
   * Money. Amount received BEYOND `amountDueMinor`, to add to
   * `Customer.creditBalanceMinor`. Only ever REDUCES a future amount due —
   * money is never sent back out, which is what makes it safe on a keyless
   * crypto rail.
   */
  creditMinor: number;

  /** The status to write on the subscription. Unchanged unless settled. */
  subscriptionStatus: SubscriptionStatus;
  /**
   * When set, the subscription's period ADVANCES to the invoice's period and
   * `graceEndsAt` / `lateByDays` are cleared. Absent means leave them alone.
   */
  advanceTo?: { periodStart: Date; periodEnd: Date };
  /**
   * What the subscription and the customer should now hold — taken from the
   * INVOICE, so an upgrade grants the new plan and a renewal re-grants the old
   * one through the identical code path. Absent when nothing settled.
   */
  grant?: {
    planKey: string;
    priceId: string;
    interval: 'month' | 'year';
    /** Money. What the next renewal invoice is drawn at. */
    unitAmountMinor: number;
  };
}

/**
 * Money amounts arrive from a rail, so they are validated rather than trusted:
 * a NaN or a float would propagate into `$inc` and corrupt an invoice
 * permanently, and there is no way to tell afterwards what it should have been.
 */
function safeMinor(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value);
}

/** Currency comparison is case-insensitive; ISO-4217 codes are case-blind. */
function sameCurrency(a: string, b: string): boolean {
  return a.trim().toUpperCase() === b.trim().toUpperCase();
}

/**
 * Fold one confirmed payment into the invoice + subscription state.
 *
 * THE RULES, in the order they are applied:
 *
 *  1. CURRENCY MISMATCH refuses outright. Adding 50 of something else to a USD
 *     invoice is not a partial payment, it is a units error, and the one thing
 *     worse than not crediting it is crediting it at 1:1. The payment row is
 *     still written (the money exists and must be traceable); the invoice is
 *     untouched and a human reconciles it.
 *
 *  2. A NON-PAYABLE invoice (`paid`, `void`) takes no further money. A `draft`
 *     is not payable either — nothing has asked for it yet. `uncollectible` IS
 *     accepted: it means grace expired, and a customer paying a written-off
 *     invoice is precisely the case we want to honour.
 *
 *  3. UNDERPAY WITHIN $1 SETTLES. Crypto senders round, and a network fee
 *     deducted at source arrives a few cents light. Refusing entitlement over
 *     4 cents is a support ticket that costs more than the shortfall. Beyond
 *     the tolerance the payment accumulates and the invoice stays `open`, so a
 *     second transfer tops it up.
 *
 *  4. OVERPAY CREDITS. The excess over `amountDueMinor` goes to the customer's
 *     credit balance, computed against the TOTAL received rather than this
 *     payment alone — two payments of 60 against a 100 invoice credit 20 once,
 *     not twice.
 *
 *  5. THE PERIOD NEVER MOVES BACKWARDS. A late payment on a superseded invoice
 *     settles the invoice but must not SHORTEN a subscription that has already
 *     rolled forward. `advanceTo` is emitted only when the invoice's period
 *     genuinely extends the subscription.
 *
 *  6. A CANCELLED-AT-PERIOD-END subscription still activates for the period it
 *     just paid for. They paid; they get it. The cancellation applies at the
 *     end of the period they bought, which is what `cancelAtPeriodEnd` means.
 */
export function foldPayment(input: FoldInput): FoldDecision {
  const { invoice, subscription, payment } = input;
  const tolerance = Math.max(0, safeMinor(input.toleranceMinor ?? UNDERPAY_TOLERANCE_MINOR));

  const alreadyPaid = Math.max(0, safeMinor(invoice.amountPaidMinor));
  const due = Math.max(0, safeMinor(invoice.amountDueMinor));

  // Rule 1 — currency mismatch. Nothing is added; the invoice is left exactly
  // as it was so a human can reconcile against an untouched record.
  if (!sameCurrency(payment.currency, invoice.currency)) {
    return {
      settled: false,
      refusal: 'currency-mismatch',
      invoicePaidMinor: alreadyPaid,
      invoiceStatus: invoice.status,
      shortfallMinor: Math.max(0, due - alreadyPaid),
      creditMinor: 0,
      subscriptionStatus: subscription.status,
    };
  }

  // Rule 2 — is this invoice still able to take money?
  if (!isPayable(invoice.status)) {
    return {
      settled: false,
      refusal: 'invoice-not-payable',
      invoicePaidMinor: alreadyPaid,
      invoiceStatus: invoice.status,
      shortfallMinor: 0,
      creditMinor: 0,
      subscriptionStatus: subscription.status,
    };
  }

  /*
   * Rule 2b — is there still a subscription to grant?
   *
   * A SETTLED PAYMENT MUST NEVER RESURRECT AN ABANDONED SUBSCRIPTION, and the
   * reason is sharper than tidiness. `grantEntitlement` writes the subscription
   * unfiltered, so without this an `incomplete_expired` row goes back to
   * `active` — carrying the `endedAt`/`canceledAt` stamps from its own
   * abandonment — and `LIVE_SUBSCRIPTION_STATUSES` backs a PARTIAL UNIQUE INDEX
   * on `customerId`. A customer who cancels a checkout and immediately starts a
   * new one therefore has two live rows the moment the old payment lands:
   * E11000 inside the apply path, which is a business outcome thrown as a 500,
   * which the watcher then retries forever.
   *
   * The window is real and short. `voidUnfundedInvoices` now (correctly) leaves
   * the old invoice payable while an authorization is live, so an abandoned
   * checkout keeps a live pay target — exactly the state this rule catches.
   *
   * Refusing here is NOT losing the money: `PaymentApplyService` credits an
   * `invoice-not-payable` or `subscription-not-live` refusal to the customer's
   * balance, and `spendCustomerCredit` draws it down on their next invoice. So
   * a customer who cancelled and paid anyway ends up on Free, as they asked,
   * with their money waiting for them — rather than on a plan they cancelled,
   * or stuck behind a 500 loop.
   */
  if (!LIVE_SUBSCRIPTION_STATUSES.includes(subscription.status)) {
    return {
      settled: false,
      refusal: 'subscription-not-live',
      invoicePaidMinor: alreadyPaid,
      invoiceStatus: invoice.status,
      shortfallMinor: 0,
      creditMinor: 0,
      subscriptionStatus: subscription.status,
    };
  }

  // A negative amount is not a refund — this subsystem has no refund path — so
  // it is floored rather than allowed to REDUCE what the customer has paid.
  const received = Math.max(0, safeMinor(payment.amountMinor));
  const totalPaid = alreadyPaid + received;

  // Rule 3 — the tolerance. Compared against the TOTAL, so a $0.98 first
  // transfer plus a $0.01 second one still settles at $0.99 of a $1.00 invoice.
  const shortfall = Math.max(0, due - totalPaid);
  const settled = shortfall <= tolerance;

  if (!settled) {
    return {
      settled: false,
      refusal: 'short-paid',
      invoicePaidMinor: totalPaid,
      // Stays `open`: the pay link is still live and a top-up settles it.
      invoiceStatus: 'open',
      shortfallMinor: shortfall,
      creditMinor: 0,
      subscriptionStatus: subscription.status,
    };
  }

  // Rule 4 — overpay. Against the total, so it can only ever be credited once.
  const creditMinor = Math.max(0, totalPaid - due);

  // Rule 5 — advance only forwards.
  const advances = invoice.periodEnd.getTime() > subscription.currentPeriodEnd.getTime();

  return {
    settled: true,
    invoicePaidMinor: totalPaid,
    invoiceStatus: 'paid',
    // Reported even when settled: the tolerance forgave it, it did not arrive.
    shortfallMinor: shortfall,
    creditMinor,
    // Rule 6 — `active` regardless of `cancelAtPeriodEnd`. The sweep ends it at
    // `currentPeriodEnd`, which is the period they have now paid for.
    subscriptionStatus: 'active',
    ...(advances
      ? { advanceTo: { periodStart: invoice.periodStart, periodEnd: invoice.periodEnd } }
      : {}),
    grant: {
      planKey: invoice.planKey,
      priceId: invoice.priceId,
      interval: invoice.interval,
      // The LIST price, not `amountDueMinor`: a proration credit is a one-off
      // discount on this invoice, and carrying it into the subscription would
      // make every future renewal cheaper by the same accident.
      unitAmountMinor: Math.max(0, safeMinor(invoice.subtotalMinor)),
    },
  };
}

/**
 * Which invoice statuses may still receive money.
 *
 * `uncollectible` is deliberately IN the set: it is the post-grace write-off,
 * and someone paying it is a customer coming back. `draft` is deliberately OUT:
 * nothing has asked for it, so money against it is unattributable. `paid` is
 * out because the accumulation is already complete — a further payment against
 * a settled invoice is an overpayment the RAIL created, and it lands as
 * `invoice-not-payable` so a human decides whether to credit it.
 */
function isPayable(status: InvoiceStatus): boolean {
  return status === 'open' || status === 'uncollectible';
}

// ─── Period arithmetic ───────────────────────────────────────────────────────

/**
 * Add one billing interval to a date, in UTC.
 *
 * CLAMPS the day of month, which is the whole reason this is not a one-liner:
 * `setUTCMonth(+1)` on the 31st of January yields the 2nd or 3rd of MARCH,
 * because JavaScript overflows rather than clamping. A subscription started on
 * the 31st would then skip February entirely and bill a period the customer
 * never had. Clamped, Jan 31 → Feb 28/29 → Mar 28/29: the day drifts down and
 * stays there, which is the same thing every card processor does.
 */
export function addInterval(from: Date, interval: 'month' | 'year', count = 1): Date {
  const n = Math.max(1, Math.round(count));
  const year = from.getUTCFullYear() + (interval === 'year' ? n : 0);
  const month = from.getUTCMonth() + (interval === 'month' ? n : 0);
  const day = from.getUTCDate();

  // Day 0 of the FOLLOWING month is the last day of the target month.
  const daysInTarget = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(day, daysInTarget),
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
      from.getUTCMilliseconds(),
    ),
  );
}

/** Whole days added to a date, UTC. Used for `graceEndsAt`. */
export function addDays(from: Date, days: number): Date {
  return new Date(from.getTime() + Math.round(days) * 24 * 60 * 60 * 1000);
}

/** Whole days between two instants, floored at 0. Used for `lateByDays`. */
export function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000)));
}

/**
 * Unused value of the current period, as a proration credit in minor units.
 *
 * Used by upgrade-now: the customer has already paid `paidAmountMinor` for
 * `[periodStart, periodEnd)`, and switching mid-period should not charge twice
 * for the overlap. Straight-line by elapsed time, which is what Stripe does and
 * what a customer expects when they read "prorated".
 *
 * FLOORED, never rounded up: the credit reduces what we invoice, so rounding in
 * the customer's favour on every upgrade is a slow leak, and rounding against
 * them is a complaint. Floor is the conservative, explainable choice.
 *
 * Guards, each for a real case:
 *  - a zero-or-negative-length period (clock skew, a hand-edited document)
 *    yields 0 rather than a division by zero;
 *  - `now` before the period starts credits the whole amount, not more than it;
 *  - `now` after it ends credits nothing.
 */
export function prorationCreditMinor(args: {
  paidAmountMinor: number;
  periodStart: Date;
  periodEnd: Date;
  now: Date;
}): number {
  const paid = Math.max(0, safeMinor(args.paidAmountMinor));
  const total = args.periodEnd.getTime() - args.periodStart.getTime();
  if (total <= 0) return 0;

  const remaining = args.periodEnd.getTime() - args.now.getTime();
  if (remaining <= 0) return 0;
  if (remaining >= total) return paid;

  return Math.floor((paid * remaining) / total);
}
