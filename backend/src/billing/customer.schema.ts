import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { DEFAULT_PLAN_KEY } from './plans.seed.js';

/** How the account came into existence. */
export type CustomerOrigin = 'admin' | 'self_serve';

/** What decides `planKey`: a paid subscription, or an admin override. */
export type PlanSource = 'subscription' | 'admin';

@Schema({
  collection: 'customers',
  timestamps: true,
})
export class Customer {
  @Prop({ type: String, required: true, trim: true })
  name!: string;

  @Prop({ type: String, trim: true, lowercase: true })
  email?: string;

  /**
   * `suspended` is a HARD kill switch: `ClientsService.resolveByRawKey` returns
   * null for it, so every `/v1` request 401s. Nothing in the billing lifecycle
   * may write it — an expired subscription downgrades `planKey` to `free` and
   * the customer's keys keep working at free limits. Only an operator suspends.
   */
  @Prop({ type: String, enum: ['active', 'suspended'], default: 'active' })
  status!: 'active' | 'suspended';

  /** References `Plan.key`. */
  @Prop({ type: String, required: true, default: DEFAULT_PLAN_KEY })
  planKey!: string;

  /**
   * scrypt `salt:hash` from `auth/password.util.ts` — NEVER the api-key SHA-256.
   *
   * `select: false` is the FAIL-SAFE, not the only guard: `listClients()` and
   * `getClient()` return the whole `.lean()` doc straight to the wire with no
   * serializer in between, so an un-projected secret would leak through
   * `GET /admin/clients`. Read it back explicitly (`.select('+passwordHash')`)
   * on the login path only. NOTE it does NOT protect `createClient`, which
   * returns `created.toObject()` — `select` is a query projection, and a
   * freshly-created document carries every path that was set.
   */
  @Prop({ type: String, select: false })
  passwordHash?: string;

  @Prop({ type: Date })
  emailVerifiedAt?: Date;

  /**
   * An address the customer has CLAIMED but not yet proved.
   *
   * Deliberately separate from `email`, and deliberately NOT unique-indexed.
   * Writing an unproven address straight into `email` would squat it: that field
   * carries a unique partial index, so anyone could claim `ceo@bigcorp.com`,
   * never verify, and permanently block the real owner from ever registering it
   * — denial-of-registration with no authentication required.
   *
   * The promotion to `email` happens only when the OTP verifies, and it is the
   * unique index — not the read before it — that arbitrates who wins if two
   * accounts race to verify the same address.
   */
  @Prop({ type: String, trim: true, lowercase: true })
  pendingEmail?: string;

  /**
   * NOT a bare digest, despite the name. Three colon-separated segments:
   *
   *     `<sha256-hex>:<wrong-attempts>:<target-address>`
   *
   * written and read ONLY by `encodeVerification` / `decodeVerification` in
   * `portal/customer-auth.service.ts` (both module-private — nothing else may
   * parse this value, and anything that starts to must use the same helpers).
   *
   *  - `<sha256-hex>` — the emailed code hashed with the existing `hashApiKey`
   *    helper. The raw code is delivered once and never stored, like an API key.
   *  - `<wrong-attempts>` — the per-code attempt counter behind
   *    `MAX_VERIFICATION_ATTEMPTS`. It is packed in here rather than given its
   *    own column because Mongoose `strict` SILENTLY DROPS an undeclared path
   *    from a `$set`, so a separate field would look like it worked and count
   *    nothing. An unparseable counter is read as EXHAUSTED, never as zero.
   *  - `<target-address>` — the address the code proves control of. Verification
   *    fails CLOSED when it does not match: a code minted for one address can
   *    never be spent to prove another, which is what stops a resend aimed at an
   *    attacker's inbox from stamping `emailVerifiedAt` on a victim's address
   *    (which rule (b) of `IdentityService.resolveLogin` then auto-links into).
   *
   * PARSE BY SPLITTING AND REJOINING THE TAIL, never `lastIndexOf(':')` — a
   * quoted email local part may legally contain a colon.
   *
   * THIS FIELD NOW CONTAINS PII. It holds a customer email address, so it is no
   * longer a safe thing to print: any log line, error payload, admin dump or
   * support export that echoes it echoes a customer's address. `select: false`
   * is the fail-safe for that as well as for the digest — same reasoning as
   * `passwordHash`, and it does NOT protect a freshly-created document.
   *
   * LEGACY / ROLLBACK: a 1-segment (pre-OTP token hash) or 2-segment
   * (`hash:attempts`) value still decodes, with the target read as absent — and
   * an absent target fails closed, so codes minted by an older build are dead
   * and must be re-requested. Rolling BACK is silently destructive in the same
   * direction: the old two-segment decoder parses the address as the counter,
   * gets NaN and treats every outstanding code as burnt out.
   */
  @Prop({ type: String, select: false })
  emailVerificationTokenHash?: string;

  @Prop({ type: Date })
  emailVerificationExpiresAt?: Date;

  /** SHA-256 of the reset token (`hashApiKey`), never the raw token. */
  @Prop({ type: String, select: false })
  passwordResetTokenHash?: string;

  @Prop({ type: Date })
  passwordResetExpiresAt?: Date;

  /**
   * Stamped on every password change. `CustomerJwtGuard` rejects customer tokens
   * issued before it, which is the "log out everywhere" primitive.
   *
   * SCOPE, because the name invites more than it delivers: `CustomerJwtGuard` is
   * the ONLY reader. It bounds PORTAL SESSIONS and nothing else — `/v1` resolves
   * a raw API key against that key's own status and never consults this field —
   * so stamping it does not revoke a single API key. See the note at the write in
   * `CustomerAuthService.resetPassword`.
   */
  @Prop({ type: Date })
  passwordChangedAt?: Date;

  @Prop({ type: Date })
  lastLoginAt?: Date;

  /**
   * `admin` (created through the panel) or `self_serve` (signed up).
   * DELIBERATELY no schema default — same reasoning as `ApiKey.keyType`: a
   * default would be applied to hydrated reads but not to `.lean()` ones, so
   * the two read paths would disagree about legacy rows. Absent = pre-dates
   * self-serve, i.e. admin-created; the migration backfills it explicitly.
   */
  @Prop({ type: String, enum: ['admin', 'self_serve'] })
  origin?: CustomerOrigin;

  /** The one live subscription, when there is one. Free is the ABSENCE of one. */
  @Prop({ type: Types.ObjectId, ref: 'Subscription' })
  currentSubscriptionId?: Types.ObjectId;

  /**
   * Money. ALWAYS an integer in MINOR units (cents) — never a float. Only ever
   * REDUCES an amount due (overpayment / payment on a voided invoice); money is
   * never sent back out, which is what makes it safe on a keyless crypto rail.
   */
  @Prop({ type: Number, required: true, default: 0 })
  creditBalanceMinor!: number;

  /** Whether `planKey` is owned by the subscription lifecycle or by an admin override. */
  @Prop({ type: String, enum: ['subscription', 'admin'] })
  planSource?: PlanSource;

  /**
   * A PAID plan the customer asked for at signup but has not paid for yet.
   * Entitlement is NEVER granted from this — it only drives the redirect to
   * checkout. `planKey` stays on the free tier until a payment confirms.
   */
  @Prop({ type: String })
  intendedPlanKey?: string;
}

export type CustomerDocument = HydratedDocument<Customer>;
export const CustomerSchema = SchemaFactory.createForClass(Customer);

// One account per email — the duplicate-signup race guard.
// `$type: 'string'` and NOT `$exists: true`: `$exists` also matches an
// explicitly-stored `email: null`, and Mongo treats several nulls as duplicate
// keys, so the index build would reject on any DB holding two null-email rows.
// Declared ONLY here (not as `unique` on the @Prop) — the @Prop shorthand can't
// express a partial filter and would add a second, non-partial index attempt.
CustomerSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $type: 'string' } } },
);

// "Which customers are on this plan" — the referential check that stops
// `PlansService.remove` deleting a plan out from under live API keys.
CustomerSchema.index({ planKey: 1 });

// Sparse: only subscribed customers carry the pointer, and Free is the absence
// of a subscription, so most rows have no value to index.
CustomerSchema.index({ currentSubscriptionId: 1 }, { sparse: true });

// The reset-confirm lookup, and it is a DoS control as much as a performance
// one. `CustomerAuthService.resetPassword` filters on this field from an
// ANONYMOUS route: without an index, every submission of a junk token — which
// is what an attacker sends, and it matches nothing — costs a full scan of
// `customers`, so an unauthenticated caller with a loop buys unbounded database
// work for free. Indexed, the same request is a key lookup that misses.
//
// Sparse because a live reset token is rare and short-lived (30 minutes): almost
// every document lacks the field entirely, and a non-sparse index would carry a
// null entry for each of them — a full-collection-sized index whose only useful
// entries are the handful of resets currently in flight.
//
// NOT unique. Two accounts sharing a digest is a 2^256 coincidence, but a unique
// index would also reject the null-vs-missing edge on any legacy row that ever
// stored an explicit null, turning a write failure into a reset nobody can start.
CustomerSchema.index({ passwordResetTokenHash: 1 }, { sparse: true });
