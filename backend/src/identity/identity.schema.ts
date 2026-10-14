import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/**
 * Which external authority proved this identity. `wallet` is SIWE (EIP-4361) —
 * the proof is a signature instead of an OAuth round trip, but the row means the
 * same thing. Extensible by design: a new provider is one entry here plus one
 * file under `oauth/` (see `OauthProviderRegistry`).
 */
export type IdentityProvider = 'google' | 'github' | 'wallet';

/** Single list so the schema enum and any caller iterate the same values. */
export const IDENTITY_PROVIDERS: readonly IdentityProvider[] = ['google', 'github', 'wallet'];

@Schema({
  collection: 'identities',
  timestamps: true,
})
export class Identity {
  /** The customer this login resolves to. SSO mints the SAME `typ:'customer'` token. */
  @Prop({ type: Types.ObjectId, ref: 'Customer', required: true })
  customerId!: Types.ObjectId;

  @Prop({ type: String, required: true, enum: IDENTITY_PROVIDERS as IdentityProvider[] })
  provider!: IdentityProvider;

  /**
   * The provider's STABLE user id — Google's `sub` claim, GitHub's numeric
   * `user.id`, or the LOWERCASED `0x` address for `wallet`.
   *
   * NEVER the email address. Emails change hands: a Google Workspace address can
   * be deleted and re-issued to a different human, and a GitHub account can swap
   * its primary address at will — so an email-keyed identity silently hands the
   * next holder of that address the previous owner's customer account, API keys
   * and usage history. The email below is descriptive metadata only; THIS field
   * is the join key, and `{ provider, subject }` is unique for that reason.
   *
   * Not `lowercase: true`: Google/GitHub subjects are case-sensitive opaque ids.
   * The wallet path lowercases before writing (see `SiweService.verify`).
   */
  @Prop({ type: String, required: true, trim: true })
  subject!: string;

  /** Email as the provider reported it, when it reported one at all. */
  @Prop({ type: String, trim: true, lowercase: true })
  email?: string;

  /**
   * Whether THE PROVIDER asserted the address is verified — not whether WE
   * verified it (that lives on `Customer.emailVerifiedAt`). Defaults `false`:
   * this boolean is the single input the account-linking rules read, so an
   * absent/unparseable provider claim must read as UNVERIFIED, never as trusted.
   */
  @Prop({ type: Boolean, required: true, default: false })
  emailVerified!: boolean;

  /** Display name / handle from the provider, for the portal UI only. */
  @Prop({ type: String, trim: true })
  displayName?: string;

  /** When the customer granted this provider. Written explicitly on link. */
  @Prop({ type: Date, required: true, default: () => new Date() })
  linkedAt!: Date;

  @Prop({ type: Date })
  lastLoginAt?: Date;
}

export type IdentityDocument = HydratedDocument<Identity>;
export const IdentitySchema = SchemaFactory.createForClass(Identity);

// THE integrity guarantee of the whole SSO login path: one provider account maps
// to exactly one customer, so two customers can never claim the same Google/
// GitHub/wallet identity and a concurrent double-callback cannot fork an
// account (the second write gets E11000, which the linking layer treats as
// "already linked" and resolves to the existing row).
// Declared only here, never as `unique` on the @Prop — the shorthand would add a
// second index attempt for the same key.
IdentitySchema.index({ provider: 1, subject: 1 }, { unique: true });

// "Which providers has this customer linked" — the portal's connected-accounts
// list, and the unlink path's check that a customer keeps at least one credential.
IdentitySchema.index({ customerId: 1, provider: 1 });
