import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/**
 * Stripe's charge status set, verbatim (same no-translation-table reasoning as
 * `SubscriptionStatus`). A refund is a separate concern, not a status here.
 */
export const PAYMENT_STATUSES = ['pending', 'succeeded', 'failed'] as const;

export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * One attempt to settle an invoice. Deliberately separate from `Invoice`: an
 * invoice has 0..N attempts (an underpaid transfer topped up by a second one,
 * a failed charge followed by a good one), and that is the split the
 * invoice-centric webhook vocabulary requires.
 */
@Schema({
  collection: 'payments',
  timestamps: true,
})
export class Payment {
  @Prop({ type: Types.ObjectId, ref: 'Invoice', required: true })
  invoiceId!: Types.ObjectId;

  /** Denormalized from the invoice so a payment can be traced without a join. */
  @Prop({ type: Types.ObjectId, ref: 'Subscription', required: true })
  subscriptionId!: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Customer', required: true })
  customerId!: Types.ObjectId;

  /** Payment rail (e.g. `radom`). First key of the idempotency index. */
  @Prop({ type: String, required: true })
  provider!: string;

  /**
   * The provider's own id for this charge. REQUIRED — it is the idempotency
   * key (see the unique index below), so a manually reconciled payment must
   * carry a deterministic synthesized id rather than being left blank.
   */
  @Prop({ type: String, required: true })
  providerPaymentId!: string;

  @Prop({ type: String, enum: PAYMENT_STATUSES, required: true, default: 'pending' })
  status!: PaymentStatus;

  /**
   * Money. ALWAYS an integer in MINOR units (cents) — never a float.
   * What this attempt is worth against the invoice, in the invoice's currency.
   */
  @Prop({ type: Number, required: true })
  amountMinor!: number;

  /** ISO-4217 code the minor units are denominated in (e.g. `USD`). */
  @Prop({ type: String, required: true, default: 'USD' })
  currency!: string;

  /** On-chain asset actually transferred (e.g. `USDC`), when the rail is crypto. */
  @Prop({ type: String })
  asset?: string;

  /**
   * On-chain amount as a DECIMAL STRING, per this repo's convention for chain
   * amounts (see the position schemas) — NEVER a float: token amounts routinely
   * exceed 2^53 and a float silently loses the low digits.
   */
  @Prop({ type: String })
  assetAmount?: string;

  @Prop({ type: Number })
  chainId?: number;

  @Prop({ type: String })
  txHash?: string;

  /**
   * Money. ALWAYS an integer in MINOR units (cents) — never a float.
   * Amount received beyond `Invoice.amountDueMinor` (crypto transfers overpay
   * routinely). Recorded, not silently absorbed, so it can be credited later.
   */
  @Prop({ type: Number, default: 0 })
  overpaidMinor!: number;

  /** Admin identity when this row was entered by hand rather than by a webhook. */
  @Prop({ type: String })
  reconciledBy?: string;

  @Prop({ type: String })
  note?: string;

  @Prop({ type: Date, required: true, default: () => new Date() })
  receivedAt!: Date;

  /**
   * When this payment's effect on the invoice / subscription was carried out.
   *
   * ABSENT IS THE WORK QUEUE. `PaymentApplyService` claims a payment by
   * `findOneAndUpdate({..., appliedAt: {$exists: false}}, ..., {upsert: true})`
   * — the FILTER is the guard, so a doubled webhook and a concurrent reconcile
   * cannot both apply the same charge, and E11000 on the unique
   * `{provider, providerPaymentId}` index IS the "already applied" answer. Same
   * shape as `MeteringService.resetQuotaPeriod`'s `quotaResetAt` claim.
   *
   * A row that is `succeeded` with no `appliedAt` is money we have taken and
   * not yet honoured — `payment-reconcile` looks for exactly that, which is
   * what makes the apply safe to interrupt: the invoice total is RECOMPUTED
   * from the sum of applied payments rather than `$inc`'d, so re-running it
   * lands on the same number.
   */
  @Prop({ type: Date })
  appliedAt?: Date;

  /**
   * When `overpaidMinor` was added to `Customer.creditBalanceMinor`.
   *
   * A SECOND claim stamp, separate from `appliedAt` on purpose: the credit is
   * the one write in the apply path that is a `$inc` on a shared running total
   * rather than a `$set` of an absolute value, so it is the one write that
   * cannot be made idempotent by recomputation. It gets its own at-most-once
   * guard. Without it, a reconcile that re-ran an interrupted apply would credit
   * the same overpayment twice.
   */
  @Prop({ type: Date })
  creditedAt?: Date;

  /**
   * The WHOLE payment went to the credit balance instead of settling its
   * invoice — the refusal path in `PaymentApplyService.apply`.
   *
   * **`creditedAt` alone cannot answer this, and that is the point.** It is
   * stamped for TWO different things: the surplus of an OVERPAYMENT (where the
   * payment really did settle the invoice and only the excess moved), and a
   * whole-payment DIVERSION (where the invoice took nothing). `sumAppliedPayments`
   * totals every succeeded row carrying `appliedAt` — which the claim stamps
   * BEFORE the fold judges — so without this flag a diverted payment is counted
   * as having paid the invoice AND handed back as credit: the same money twice.
   *
   * Exactly the shape of the `creditAppliedMinor` bug fixed the same day: one
   * field standing for contributions with different provenance, and a consumer
   * that cannot tell which it is looking at.
   */
  @Prop({ type: Boolean })
  divertedToCredit?: boolean;
}

export type PaymentDocument = HydratedDocument<Payment>;
export const PaymentSchema = SchemaFactory.createForClass(Payment);

// ONE ROW PER PROVIDER CHARGE — a SECOND, INDEPENDENT idempotency layer from
// the `webhook_events` replay guard, because two different provider event ids
// can legitimately describe the same charge (created + confirmed, or the same
// charge re-announced on a different event type). Without it, that pair credits
// the invoice twice and a one-period payment settles two periods.
PaymentSchema.index({ provider: 1, providerPaymentId: 1 }, { unique: true });

// "All attempts on this invoice, newest first" — the reconciliation view, and
// how `amountPaidMinor` is audited. Without it, every invoice detail read scans
// the whole collection.
PaymentSchema.index({ invoiceId: 1, receivedAt: -1 });

// Portal + admin payment history per customer. Same scan problem without it.
PaymentSchema.index({ customerId: 1, receivedAt: -1 });

// THE RECONCILE QUEUE: "succeeded money we have not honoured yet". Partial
// rather than a plain compound index because the interesting set is tiny and
// short-lived — almost every payment is applied within a second of arriving, so
// a non-partial index would carry an entry for every payment ever taken in
// order to answer a query that matches a handful. `$exists: false` is correct
// here (and not the `$type` form used for `email`): the field is either absent
// or a Date, and an explicitly-stored null is not something any writer creates.
PaymentSchema.index(
  { status: 1, receivedAt: 1 },
  { partialFilterExpression: { appliedAt: { $exists: false } } },
);
