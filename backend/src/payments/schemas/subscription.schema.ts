import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/**
 * Stripe's OWN status vocabulary, verbatim — not a house dialect. Keeping their
 * names means a future `StripeProvider` needs no translation table.
 * - `incomplete` — created, first payment not confirmed yet.
 * - `incomplete_expired` — the first payment window lapsed; never activated.
 * - `trialing` — reserved now so introducing trials never needs an enum
 *   migration (nothing writes it today; see `trialEndsAt`).
 * - `active` — paid, inside the current period.
 * - `past_due` — period ended with an unpaid invoice; still inside grace, so
 *   access continues and the open invoice carries a live pay link.
 * - `unpaid` — Stripe's name for "we gave up collecting": the row stays, access
 *   is cut. Exactly our post-grace state.
 * - `canceled` — terminated (by the customer or by us).
 */
export const SUBSCRIPTION_STATUSES = [
  'incomplete',
  'incomplete_expired',
  'trialing',
  'active',
  'past_due',
  'unpaid',
  'canceled',
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

/**
 * The non-terminal statuses — a subscription in one of these is "live" and the
 * customer may not hold a second one. Backs the partial unique index below;
 * keep the two in sync (a status added here changes the index definition, which
 * means a drop + rebuild, not just a redeploy).
 *
 * **`unpaid` IS DELIBERATELY NOT IN THIS LIST**, despite being non-terminal in
 * Stripe's vocabulary. It is our post-grace state: access has already been cut
 * and the customer has been moved to Free, so the row entitles NOTHING — and
 * while it counted as live, the partial unique index below made it a permanent
 * block on ever subscribing again. A customer whose card-equivalent lapsed once
 * could never come back, and the only repair was editing the database by hand.
 * The row still exists as history; it just no longer stands in the doorway.
 *
 * `incomplete` DOES stay: it is a checkout in flight, and stopping a second one
 * being raised beside it is the point. An ABANDONED one is aged out to
 * `incomplete_expired` by the sweep rather than being excluded here, so the
 * double-charge guard keeps working for the case it exists for.
 */
export const LIVE_SUBSCRIPTION_STATUSES: SubscriptionStatus[] = [
  'incomplete',
  'trialing',
  'active',
  'past_due',
];

export const SUBSCRIPTION_INTERVALS = ['month', 'year'] as const;

export type SubscriptionInterval = (typeof SUBSCRIPTION_INTERVALS)[number];

@Schema({
  collection: 'subscriptions',
  timestamps: true,
})
export class Subscription {
  @Prop({ type: Types.ObjectId, ref: 'Customer', required: true })
  customerId!: Types.ObjectId;

  /** References `Plan.key` — the plan this subscription entitles. */
  @Prop({ type: String, required: true })
  planKey!: string;

  /** References the `Plan.prices[].id` that was picked at subscribe time. */
  @Prop({ type: String, required: true })
  priceId!: string;

  @Prop({ type: String, enum: SUBSCRIPTION_INTERVALS, required: true })
  interval!: SubscriptionInterval;

  /**
   * Money. ALWAYS an integer in MINOR units (cents) — never a float. Floats are
   * why the legacy `Plan.price` is a problem (0.1 + 0.2 arithmetic, and no
   * currency-safe rounding). LOCKED at subscribe time: a later admin edit to
   * the plan's price must not reprice a live subscriber, so every renewal
   * invoice is drawn from THIS value, not from the current `Plan.prices[]`.
   */
  @Prop({ type: Number, required: true })
  unitAmountMinor!: number;

  @Prop({ type: String, enum: SUBSCRIPTION_STATUSES, required: true, default: 'incomplete' })
  status!: SubscriptionStatus;

  @Prop({ type: Date, required: true })
  currentPeriodStart!: Date;

  @Prop({ type: Date, required: true })
  currentPeriodEnd!: Date;

  /**
   * Grace window in days, SNAPSHOTTED at create time from config. Changing the
   * global default must not retroactively shorten (or extend) the window a
   * customer already signed up under.
   */
  @Prop({ type: Number, required: true })
  graceDays!: number;

  /**
   * When grace expires and access is cut (`past_due` → `unpaid`). Absent while
   * the subscription has never lapsed; stamped when the period rolls over
   * unpaid so the sweep never has to recompute it from `graceDays`.
   */
  @Prop({ type: Date })
  graceEndsAt?: Date;

  @Prop({ type: Boolean, default: false })
  cancelAtPeriodEnd!: boolean;

  @Prop({ type: Date })
  canceledAt?: Date;

  @Prop({ type: String })
  cancellationReason?: string;

  /** When access actually ended (terminal). Distinct from `canceledAt`, which
   * is when the cancellation was REQUESTED — a `cancelAtPeriodEnd` cancellation
   * sets `canceledAt` immediately and `endedAt` a period later. */
  @Prop({ type: Date })
  endedAt?: Date;

  /** Scheduled plan change (downgrades / interval switches apply at period end
   * rather than mid-period). Applied by the sweep at `pendingEffectiveAt`. */
  @Prop({ type: String })
  pendingPlanKey?: string;

  @Prop({ type: String })
  pendingPriceId?: string;

  @Prop({ type: Date })
  pendingEffectiveAt?: Date;

  /** The most recent invoice, so the portal can show "amount due / pay now"
   * without a second query. References `Invoice._id`. */
  @Prop({ type: Types.ObjectId, ref: 'Invoice' })
  latestInvoiceId?: Types.ObjectId;

  /** Payment rail that owns this subscription (e.g. `radom`). Required so the
   * provider-id index has a stable first key. */
  @Prop({ type: String, required: true })
  provider!: string;

  /** The provider's own subscription id, when the rail has one. Radom's
   * pay-link rail does NOT auto-renew, so this stays absent there. */
  @Prop({ type: String })
  providerSubscriptionId?: string;

  @Prop({ type: Date, required: true, default: () => new Date() })
  startedAt!: Date;

  /** Reserved alongside the `trialing` status — nothing writes it today. */
  @Prop({ type: Date })
  trialEndsAt?: Date;

  /** Days past `currentPeriodEnd` with the renewal invoice still unpaid.
   * Maintained by the sweep for dunning copy ("payment is 3 days late"). */
  @Prop({ type: Number, default: 0 })
  lateByDays!: number;
}

export type SubscriptionDocument = HydratedDocument<Subscription>;
export const SubscriptionSchema = SchemaFactory.createForClass(Subscription);

// Portal "my subscriptions" list (newest first) and every per-customer lookup.
// Without it each read is a full collection scan sorted in memory.
SubscriptionSchema.index({ customerId: 1, createdAt: -1 });

// AT MOST ONE LIVE SUBSCRIPTION PER CUSTOMER. Partial so terminal rows
// (`canceled`, `incomplete_expired`) stay as history and don't block a
// re-subscribe. Without it, a double-clicked checkout or a duplicated webhook
// creates two overlapping paid subscriptions for one customer and the
// entitlement resolver has to guess which one wins.
// NOTE: `$in` inside a partialFilterExpression requires MongoDB >= 6.0.
SubscriptionSchema.index(
  { customerId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: LIVE_SUBSCRIPTION_STATUSES } },
  },
);

// Renewal sweep: "which active subscriptions end before <now + notice days>".
// Without it the sweep scans every subscription ever created, every tick.
SubscriptionSchema.index({ status: 1, currentPeriodEnd: 1 });

// Grace sweep: "which past_due subscriptions have run out of grace" — the
// transition that actually cuts access. Same scan problem without it.
SubscriptionSchema.index({ status: 1, graceEndsAt: 1 });

// One local subscription per provider subscription — the reconciliation guard
// when a provider replays a subscription-created event. PARTIAL rather than
// `sparse`, deliberately: a sparse COMPOUND index still indexes a document that
// has ANY of the keys, and `provider` is required — so every row would be
// indexed with a null `providerSubscriptionId` and the second Radom
// subscription would collide. `$type: 'string'` (not `$exists`) because
// `$exists` also matches an explicitly-stored null.
SubscriptionSchema.index(
  { provider: 1, providerSubscriptionId: 1 },
  {
    unique: true,
    partialFilterExpression: { providerSubscriptionId: { $type: 'string' } },
  },
);
