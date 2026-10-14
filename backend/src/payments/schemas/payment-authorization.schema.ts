import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/**
 * One EIP-3009 authorization: the x402 rail's answer to "which invoice did this
 * payment settle".
 *
 * ── THE NONCE IS THE INVOICE REFERENCE ─────────────────────────────────────
 *
 * A deposit-address rail (deleted 2026-08-11) solved attribution with a unique
 * derived address per invoice. This rail has ONE treasury address for everybody,
 * so the address cannot be the reference — the nonce is. We mint it,
 * we store it against this invoice before the customer ever sees it, and the
 * token emits it in `AuthorizationUsed` when the transfer lands. Attribution is
 * therefore known at ISSUE time rather than inferred from an anonymous transfer,
 * which is strictly stronger than matching by amount or by sender.
 *
 * ── THE TRAP THAT MUST NOT BE FORGOTTEN ────────────────────────────────────
 *
 * On-chain, an EIP-3009 nonce is unique only PER AUTHORIZER — the token stores
 * `authorizationState[authorizer][nonce]`. So a customer can legitimately spend
 * the SAME nonce value from a second wallet they control, and two different
 * `AuthorizationUsed` events can carry one nonce. Matching a settlement on nonce
 * ALONE would therefore let somebody settle this invoice with a transfer that
 * went somewhere else, or for a different amount.
 *
 * SETTLEMENT MUST CHECK, in the same transaction as the `AuthorizationUsed`
 * event: the paired `Transfer` has `to == treasuryAddress`, `from == authorizer`,
 * and `value == expectedBaseUnits`. Every one of those fields is stored on this
 * document precisely so the watcher can assert them rather than trust the event.
 *
 * ── NO SPEND KEY IS IMPLIED BY THIS DOCUMENT ────────────────────────────────
 *
 * Nothing here is derived from a seed — there is no seed in this system at all.
 * `treasuryAddress`
 * is a plain configured address whose key never touches this server, and the
 * signature stored below can only ever move funds TO it — the destination is
 * inside the signed struct. A full compromise of this collection leaks
 * authorizations that pay us, and nothing else.
 */
@Schema({ collection: 'payment_authorizations', timestamps: true })
export class PaymentAuthorization {
  @Prop({ type: Types.ObjectId, ref: 'Invoice', required: true })
  invoiceId!: Types.ObjectId;

  /**
   * REQUIRED, and it must actually be passed at every call site.
   *
   * The deleted deposit rail's equivalent field was required too, and neither
   * `SubscriptionsService.finishInvoice` nor the sweep's renewal pass supplied
   * it — so every single on-chain checkout threw on insert and the rail was
   * 100% broken until a review found it. Same field, same hazard: if you add a
   * caller, pass this.
   */
  @Prop({ type: Types.ObjectId, ref: 'Customer', required: true })
  customerId!: Types.ObjectId;

  @Prop({ type: Number, required: true })
  chainId!: number;

  /**
   * The 32-byte authorization nonce, lowercase hex. UNIQUE — this is the
   * invoice reference, so a collision is two invoices that cannot be told apart.
   */
  @Prop({ type: String, required: true, lowercase: true })
  nonce!: string;

  /** The ERC-20 being authorized. Also the EIP-712 `verifyingContract`. */
  @Prop({ type: String, required: true, lowercase: true })
  tokenAddress!: string;

  @Prop({ type: String, required: true })
  tokenSymbol!: string;

  @Prop({ type: Number, required: true })
  tokenDecimals!: number;

  /**
   * The treasury — the signed struct's `to`. STORED rather than read from config
   * at settlement time: if an operator rotates `X402_TREASURY_ADDRESS`, an
   * authorization already signed still pays the OLD address, and the watcher
   * must verify against the address that was actually signed for. Reading
   * current config there would reject perfectly valid in-flight payments.
   */
  @Prop({ type: String, required: true, lowercase: true })
  treasuryAddress!: string;

  /**
   * Money. The exact amount authorized, in the token's base units, as a DECIMAL
   * STRING. Compared with BigInt against the paired `Transfer` value — a float
   * loses the low digits of an 18-decimal amount.
   */
  @Prop({ type: String, required: true })
  expectedBaseUnits!: string;

  /**
   * The payer's wallet — the signed struct's `from`.
   *
   * ABSENT AT MINT TIME, and that is structural rather than lazy: `from` is one
   * of the six hashed fields, so the typed data cannot be composed until the
   * customer has connected a wallet, which happens long after the invoice is
   * raised. It is stamped when the authorization payload is first requested.
   */
  @Prop({ type: String, lowercase: true })
  fromAddress?: string;

  /**
   * The EIP-712 domain the payload was composed with, as VERIFIED against the
   * token's own `DOMAIN_SEPARATOR()` at that moment (`Eip3009DomainService`).
   *
   * Stored, not re-derived: a token upgrade that changed `version()` would
   * otherwise silently invalidate every in-flight authorization, and we would
   * verify signatures against a domain nobody signed.
   */
  @Prop({ type: String })
  domainName?: string;

  @Prop({ type: String })
  domainVersion?: string;

  /** Unix SECONDS. The authorization is invalid before this. Usually 0. */
  @Prop({ type: Number, required: true, default: 0 })
  validAfter!: number;

  /**
   * Unix SECONDS. The token itself refuses the authorization past this, which is
   * what makes an abandoned signature harmless — it becomes unspendable without
   * anybody having to revoke it.
   *
   * ABSENT UNTIL THE PAYLOAD IS SIGNED, in the same group as `fromAddress` and
   * the domain fields, and that grouping is load-bearing rather than tidy.
   *
   * It was originally stamped at MINT time, which made every renewal on this
   * rail structurally unpayable: the sweep raises a renewal invoice
   * `SUBSCRIPTION_RENEWAL_LEAD_DAYS` (7) ahead and mints the quote in the same
   * tick, so a 30-minute `validBefore` had elapsed roughly six days and 23 hours
   * before the period even started — and nothing re-mints it, because the quote
   * is a stored snapshot the portal renders verbatim. The customer would be shown
   * a payment panel whose authorization the token was guaranteed to reject.
   *
   * The signing window belongs to the SIGNATURE, not to the quote: it exists so
   * an abandoned signature expires, and it can only start when somebody actually
   * signs. `quoteExpiresAt` below is the quote's own, much longer, staleness
   * bound.
   */
  @Prop({ type: Number })
  validBefore?: number;

  /**
   * When the QUOTE goes stale — a different clock from `validBefore` above.
   *
   * Long (days, not minutes) because a renewal quote is minted a week before its
   * period begins. Past this, `createCheckout` ROTATES the row rather than
   * handing back the stale one: a new nonce, a fresh window, and the current
   * amount. Rotation is also what corrects an amount that moved after minting
   * (an upgrade proration, credit applied), since `expectedBaseUnits` is frozen
   * at mint.
   */
  @Prop({ type: Date, required: true })
  quoteExpiresAt!: Date;

  /**
   * The customer's signature, once verified. `select: false` — it is not a
   * secret that grants anything beyond paying us, but it is bearer-ish material
   * (anyone holding it can relay the payment, which is by design), and it has no
   * business appearing in an admin list or a portal response by default.
   */
  @Prop({ type: String, select: false })
  signature?: string;

  /**
   * `issued` — nonce minted, nothing signed yet. `authorized` — a verified
   * signature is held, awaiting relay. `submitted` — the relay transaction is
   * broadcast. `settled` — confirmed on chain and applied to the invoice.
   * `expired` — `validBefore` passed unspent. `failed` — the relay reverted.
   *
   * NEVER deleted: a settled authorization is the receipt, and an expired one is
   * how a late or duplicate `AuthorizationUsed` event is recognised rather than
   * treated as an unknown payment.
   */
  @Prop({
    type: String,
    enum: ['issued', 'authorized', 'submitted', 'settled', 'expired', 'failed'],
    required: true,
    default: 'issued',
  })
  status!: 'issued' | 'authorized' | 'submitted' | 'settled' | 'expired' | 'failed';

  /** The relay transaction hash, once broadcast. */
  @Prop({ type: String, lowercase: true })
  txHash?: string;

  /**
   * The block the watcher should start scanning from — stamped at mint from the
   * current head, so a fresh authorization has an EXACT floor rather than a
   * heuristic lookback. Best-effort: an unreachable node leaves it unset and the
   * watcher's bounded fallback takes over, because a checkout must never fail
   * because an RPC call did.
   */
  @Prop({ type: Number })
  lastScannedBlock?: number;

  /** Confirmations required before this is treated as settled. A reorg budget. */
  @Prop({ type: Number, required: true })
  minConfirmations!: number;
}

export type PaymentAuthorizationDocument = HydratedDocument<PaymentAuthorization>;
export const PaymentAuthorizationSchema = SchemaFactory.createForClass(PaymentAuthorization);

// THE ATTRIBUTION KEY. One nonce, one invoice — a duplicate is two invoices a
// settlement cannot be assigned between. Unique, and a mint treats E11000 as a
// bug worth surfacing rather than swallowing.
PaymentAuthorizationSchema.index({ nonce: 1 }, { unique: true });

// ONE AUTHORIZATION PER INVOICE. Full stop — not one per invoice PER CHAIN, which
// is what this index used to say.
//
// The chain is a PROPERTY of the quote, not part of its identity. Scoping
// uniqueness by chain meant that changing `PAYMENT_ACCEPTED_TOKENS` to a
// different network left the old row in place AND allowed a second row beside it,
// so one invoice had two live authorizations on two chains and paying either (or
// both) was an overpayment we had created ourselves. Keyed on the invoice alone,
// a chain switch ROTATES the single row instead — see `isQuoteUsable`.
//
// A customer reloading the billing page must still be handed the SAME nonce.
PaymentAuthorizationSchema.index({ invoiceId: 1 }, { unique: true });

// The watcher's query: "authorizations still worth scanning for on this chain".
// Partial so settled/expired/failed rows — the vast majority over time — carry
// no index entry.
PaymentAuthorizationSchema.index(
  { chainId: 1, status: 1 },
  { partialFilterExpression: { status: { $in: ['issued', 'authorized', 'submitted'] } } },
);

// Stale-quote lookups: "which authorizations are past their quote window".
// Read by the rotation path in `createCheckout`; a background expiry sweep that
// also flips them to `expired` lands with the watcher in Phase 3 — until then a
// stale row is rotated the next time the invoice is quoted, which is what keeps
// the invoice payable.
PaymentAuthorizationSchema.index({ status: 1, quoteExpiresAt: 1 });
