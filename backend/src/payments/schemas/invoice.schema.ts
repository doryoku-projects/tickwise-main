import { Prop, raw, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/**
 * Stripe's exact invoice status set — same reasoning as `SubscriptionStatus`:
 * a future `StripeProvider` maps 1:1 with no translation table.
 * - `draft` — being assembled, not yet payable.
 * - `open` — payable; the live pay link lives in `checkout`.
 * - `paid` — settled (`amountPaidMinor >= amountDueMinor`).
 * - `void` — cancelled before payment; never owed.
 * - `uncollectible` — written off after grace expired.
 */
export const INVOICE_STATUSES = ['draft', 'open', 'paid', 'void', 'uncollectible'] as const;

export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

/**
 * How the customer pays this invoice — whichever form the rail deals in.
 *
 * EXACTLY ONE of `hostedUrl` / `instructions` is set. A hosted-redirect rail
 * (Radom now, a fiat provider later) gives a URL; the x402 rail gives an
 * authorization to sign. Both live on one embedded document so
 * the invoice has a single "how to pay" slot and the portal branches on which
 * arrived, rather than two nullable columns nobody can keep in sync.
 */
export type InvoiceCheckout = {
  provider: string;
  ref: string;
  hostedUrl?: string;
  instructions?: InvoiceCheckoutInstructions;
  expiresAt?: Date;
};

/**
 * The on-chain half. A STORED SNAPSHOT, not something recomputed on read.
 *
 * `amountBaseUnits` is the exact integer the chain watcher matches an incoming
 * `Transfer` against, so it has to be frozen at the moment the customer was
 * quoted. Recomputing it at render time would mean a customer sending an amount
 * we are no longer looking for the instant a price or a decimals value moved.
 *
 * TWO SHAPES, mirroring `OnChainInstructions` in `payment-provider.interface.ts`
 * — an `authorization` to sign (the only one anything mints), or a LEGACY
 * `deposit` address from the rail deleted on 2026-08-11, kept read-only so
 * stored rows remain readable. `kind` is ABSENT on rows written before the union
 * existed, so absent MUST read as `deposit`; every field either variant uses is
 * declared in the Mongoose definition below, because `strict` mode SILENTLY DROPS
 * an undeclared path and an authorization would have been stored with no nonce.
 */
export type InvoiceCheckoutInstructions =
  | InvoiceDepositInstructions
  | InvoiceAuthorizationInstructions;

/** LEGACY, READ-ONLY — the deleted deposit rail's shape. Nothing writes it. */
export type InvoiceDepositInstructions = {
  kind?: 'deposit';
  chainId: number;
  chainName: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  payToAddress: string;
  /** DECIMAL STRING — an 18-decimal amount exceeds 2^53. Parsed with BigInt. */
  amountBaseUnits: string;
  amountDisplay: string;
  minConfirmations: number;
};

export type InvoiceAuthorizationInstructions = {
  kind: 'authorization';
  chainId: number;
  chainName: string;
  tokenAddress: string;
  tokenSymbol: string;
  tokenDecimals: number;
  /** Where the authorization pays. The binding copy is inside the signed struct. */
  treasuryAddress: string;
  /** DECIMAL STRING — the exact `value` that will be signed for. */
  amountBaseUnits: string;
  amountDisplay: string;
  /** The 32-byte nonce. THE INVOICE REFERENCE on this rail. */
  nonce: string;
  minConfirmations: number;
};

const InvoiceCheckoutDef = raw({
  /** Payment rail that minted this (e.g. `x402`, `radom`). */
  provider: { type: String, required: true },
  /** The rail's id for the checkout session / deposit. */
  ref: { type: String, required: true },
  /** Hosted-redirect rails only. */
  hostedUrl: { type: String },
  /**
   * Direct on-chain rails only — a `deposit` address or an `authorization`.
   *
   * EVERY FIELD OF BOTH VARIANTS IS DECLARED HERE. Mongoose runs `strict` by
   * default and SILENTLY DROPS an undeclared path from a write, so an
   * authorization stored against a deposit-only definition would have persisted
   * with no `nonce` — i.e. an invoice whose payments could never be attributed,
   * with no error anywhere. This repo has already been bitten by exactly that
   * (the packed verification-attempt counter in `Customer`).
   *
   * The variant-specific fields use a FUNCTION for `required` so each shape
   * keeps its own guard rather than both collapsing to optional: a deposit row
   * still cannot be written without `payToAddress` (the thing that makes it
   * payable), and an authorization row still cannot be written without the
   * `nonce` and `treasuryAddress` that make it attributable. `this` is the
   * instructions subdocument, so it sees `kind`; absent `kind` means `deposit`,
   * which is what keeps historical rows valid.
   */
  instructions: {
    type: {
      kind: { type: String, enum: ['deposit', 'authorization'] },
      chainId: { type: Number, required: true },
      chainName: { type: String, required: true },
      tokenAddress: { type: String, required: true },
      tokenSymbol: { type: String, required: true },
      tokenDecimals: { type: Number, required: true },
      payToAddress: {
        type: String,
        required: function (this: { kind?: string }) {
          return this?.kind !== 'authorization';
        },
      },
      treasuryAddress: {
        type: String,
        required: function (this: { kind?: string }) {
          return this?.kind === 'authorization';
        },
      },
      nonce: {
        type: String,
        required: function (this: { kind?: string }) {
          return this?.kind === 'authorization';
        },
      },
      amountBaseUnits: { type: String, required: true },
      amountDisplay: { type: String, required: true },
      minConfirmations: { type: Number, required: true },
    },
    required: false,
    _id: false,
  },
  /** Pay links and quotes both expire; past this the portal mints a fresh one. */
  expiresAt: { type: Date },
});

@Schema({
  collection: 'invoices',
  timestamps: true,
})
export class Invoice {
  /**
   * Monotonic human-facing invoice number, drawn from the `counters` doc via a
   * `$inc` (see `counter.schema.ts`). Not the `_id` — accountants need a gapless
   * sequence, ObjectIds are neither sequential nor readable.
   */
  @Prop({ type: Number, required: true })
  number!: number;

  @Prop({ type: Types.ObjectId, ref: 'Subscription', required: true })
  subscriptionId!: Types.ObjectId;

  /** Denormalized from the subscription so portal/admin listings never need a
   * join to answer "this customer's invoices". */
  @Prop({ type: Types.ObjectId, ref: 'Customer', required: true })
  customerId!: Types.ObjectId;

  /**
   * WHAT THIS INVOICE BUYS. The plan, price and cadence are recorded on the
   * invoice, not merely on the subscription, and that is what makes one settle
   * path cover renewals, upgrades and interval switches alike.
   *
   * The alternative — reading the plan off the subscription when a payment
   * lands — cannot express "this invoice is for the plan you are MOVING TO":
   * either the subscription is changed before the money arrives (the customer
   * holds a plan they have not paid for) or it is changed after (and nothing
   * says which plan the payment was for). Snapshotting it here removes the
   * question: `PaymentApplyService` grants exactly what the invoice says.
   *
   * It is also immutable history. An admin repricing a plan next month must not
   * retroactively change what a customer was charged for, and a plan deleted
   * later must still be readable on the invoice that sold it.
   */
  @Prop({ type: String, required: true })
  planKey!: string;

  /** The `Plan.prices[].id` this invoice was drawn from. */
  @Prop({ type: String, required: true })
  priceId!: string;

  /** Cadence bought. Drives the NEXT period's length once this one settles. */
  @Prop({ type: String, enum: ['month', 'year'], required: true })
  interval!: 'month' | 'year';

  /** The billing period this invoice covers. `periodStart` is also half of the
   * idempotency key — see the unique index below. */
  @Prop({ type: Date, required: true })
  periodStart!: Date;

  @Prop({ type: Date, required: true })
  periodEnd!: Date;

  /**
   * Money. ALWAYS an integer in MINOR units (cents) — never a float.
   * List price for the period, before any credit.
   */
  @Prop({ type: Number, required: true })
  subtotalMinor!: number;

  /**
   * Money. ALWAYS an integer in MINOR units (cents) — never a float.
   * Proration / goodwill credit applied to this invoice.
   *
   * THE TOTAL DISCOUNT, from two sources that behave differently when this
   * invoice is voided — see `creditFromBalanceMinor`. Display reads this one;
   * anything that MOVES money must not.
   */
  @Prop({ type: Number, required: true, default: 0 })
  creditAppliedMinor!: number;

  /**
   * Money. The part of `creditAppliedMinor` that was taken from
   * `Customer.creditBalanceMinor`, and therefore the only part that may ever be
   * returned to it.
   *
   * **THIS FIELD EXISTS BECAUSE REFUNDING THE TOTAL MINTED MONEY.** An upgrade
   * invoice's discount is the sum of a PRORATION — the unused value of the plan
   * being left, which was never in the balance — and a SPEND of the stored
   * balance. `voidUnfundedInvoices` returned `creditAppliedMinor` in full, so
   * cancelling an upgrade credited the customer with the proration as real,
   * spendable balance. Worse, it COMPOUNDED: the next upgrade prorated again
   * and also spent the phantom balance, so a customer riding upgrade→cancel
   * went $0.99 → $1.98 → $2.97, and the balance is spendable on genuine plans.
   *
   * Not refunding the proration is correct, not merely safe: voiding the
   * upgrade leaves the customer on the plan they already have, so the unused
   * period they were being credited for is still theirs.
   *
   * Absent on rows written before this field existed. `?? 0` therefore
   * under-refunds a legacy invoice that really did spend balance, which is the
   * safe direction — the failure is a customer asking where their credit went,
   * not the system inventing money.
   */
  @Prop({ type: Number, required: true, default: 0 })
  creditFromBalanceMinor!: number;

  /**
   * Money. ALWAYS an integer in MINOR units (cents) — never a float.
   * `subtotalMinor - creditAppliedMinor`, stored rather than derived so the
   * amount the customer was actually asked for is immutable history.
   */
  @Prop({ type: Number, required: true })
  amountDueMinor!: number;

  /**
   * Money. ALWAYS an integer in MINOR units (cents) — never a float.
   * ACCUMULATES across attempts: one invoice has 0..N payments (an underpaid
   * crypto transfer topped up by a second one still settles the invoice), so
   * each confirmed payment `$inc`s this rather than overwriting it.
   */
  @Prop({ type: Number, required: true, default: 0 })
  amountPaidMinor!: number;

  /** ISO-4217 code the minor units are denominated in (e.g. `USD`). */
  @Prop({ type: String, required: true, default: 'USD' })
  currency!: string;

  @Prop({ type: String, enum: INVOICE_STATUSES, required: true, default: 'draft' })
  status!: InvoiceStatus;

  /** Present while the invoice is payable; replaced when a link expires. */
  @Prop({ type: InvoiceCheckoutDef })
  checkout?: InvoiceCheckout;

  /**
   * A read-only CAPABILITY for this invoice's payment status, carried in the
   * checkout return URL.
   *
   * WHY IT EXISTS: the customer comes back from the rail into whatever browser
   * the rail sent them to, and for a crypto rail that is very often a wallet's
   * in-app browser — a different browsing context with NO portal session. A
   * return page that needs a login shows a login form to somebody who has just
   * paid, which reads as the payment having failed.
   *
   * WHY IT IS NOT JUST THE INVOICE ID: an ObjectId is a timestamp, a
   * per-process random and an INCREMENTING COUNTER. Anyone holding one of their
   * own invoice ids can walk the counter, so treating the id as a secret would
   * expose every other customer's plan and amount. This is 32 random bytes.
   *
   * WHAT IT GRANTS: status, plan name and amount for ONE invoice, and nothing
   * else — no email, no name, no key. It is deliberately not an authentication
   * token and must never be accepted as one.
   */
  @Prop({ type: String, select: false })
  returnToken?: string;
}

export type InvoiceDocument = HydratedDocument<Invoice>;
export const InvoiceSchema = SchemaFactory.createForClass(Invoice);

// ONE INVOICE PER SUBSCRIPTION PERIOD — the idempotency guard for renewal-
// invoice creation. Without it a doubled sweep tick (two pods, or a retry after
// a timeout) bills the same period twice and mints two pay links. The caller
// creates unconditionally and treats E11000 as success, which is race-free in a
// way a read-then-write check is not.
InvoiceSchema.index({ subscriptionId: 1, periodStart: 1 }, { unique: true });

// Portal + admin "this customer's invoices, newest first". Without it every
// billing-history page scans the whole collection and sorts in memory.
InvoiceSchema.index({ customerId: 1, createdAt: -1 });

// Dunning sweep: "open invoices whose period has ended". Without it the sweep
// scans every invoice ever issued on every tick.
InvoiceSchema.index({ status: 1, periodEnd: 1 });
