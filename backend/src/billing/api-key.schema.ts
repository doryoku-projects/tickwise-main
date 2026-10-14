import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

@Schema({
  collection: 'api_keys',
  timestamps: true,
})
export class ApiKey {
  /** SHA-256 hex of the raw key. The raw key is shown to the admin once and never stored. */
  @Prop({ type: String, required: true, unique: true })
  keyHash!: string;

  /** Non-secret leading chars (e.g. `kc_live_AbCd…`) for display in the panel. */
  @Prop({ type: String, required: true })
  keyPrefix!: string;

  @Prop({ type: Types.ObjectId, ref: 'Customer', required: true, index: true })
  customerId!: Types.ObjectId;

  @Prop({ type: String, default: '' })
  label!: string;

  @Prop({ type: String, enum: ['active', 'revoked'], default: 'active' })
  status!: 'active' | 'revoked';

  /**
   * Trust context the key is meant for (Stripe-style key typing):
   * - `server` — backend-only. Carries NO origins and REJECTS any request that
   *   arrives with an `Origin` header (i.e. a browser): a server key pasted
   *   into frontend JS stops working. Server-to-server calls (no Origin) pass.
   * - `browser` — meant to ship in a customer's frontend. MUST have at least
   *   one `allowedOrigins` entry; only those origins may use it in a browser.
   * No field on a legacy row → inferred at resolve time: origins present →
   * `browser`, else `server` (see `ClientsService.resolveByRawKey`). New keys
   * always store it explicitly, so no schema default (a default would defeat
   * the legacy inference on hydrated reads).
   */
  @Prop({ type: String, enum: ['server', 'browser'] })
  keyType?: 'server' | 'browser';

  /**
   * Browser origins this key may be used from (`https://app.example.com` —
   * scheme://host[:port], normalized lowercase, no path). Drives BOTH the
   * dynamic CORS allowlist (registered origins get CORS headers) and the
   * per-request guard check (a browser call whose Origin header is outside
   * this list is rejected, so a leaked key is useless on other websites).
   * Non-empty ⟺ `keyType === 'browser'`; a `server` key keeps this empty.
   */
  @Prop({ type: [String], default: [] })
  allowedOrigins!: string[];

  @Prop({ type: Date })
  lastUsedAt?: Date;
}

export type ApiKeyDocument = HydratedDocument<ApiKey>;
export const ApiKeySchema = SchemaFactory.createForClass(ApiKey);
// The unique index on `keyHash` comes from `@Prop({ unique: true })` above. Declaring it a
// second time here made Mongoose warn "Duplicate schema index" at every boot (same index).
