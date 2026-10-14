import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * - `received` — inserted, not processed yet (the insert IS the replay guard,
 *   so it happens before any work).
 * - `processed` — handled successfully; a replay is a no-op.
 * - `failed` — handler threw; retryable, `attempts`/`lastError` say how badly.
 * - `ignored` — a legitimate event type we do not act on.
 */
export const WEBHOOK_EVENT_STATUSES = ['received', 'processed', 'failed', 'ignored'] as const;

export type WebhookEventStatus = (typeof WEBHOOK_EVENT_STATUSES)[number];

/**
 * The provider event store. Insert-first: every inbound webhook is written here
 * before it is acted on, so the unique index below decides whether this is a
 * new event or a replay.
 */
@Schema({
  collection: 'webhook_events',
  timestamps: true,
})
export class WebhookEvent {
  /** Payment rail that sent the event (e.g. `radom`). */
  @Prop({ type: String, required: true })
  provider!: string;

  /** The provider's own event id — unique per provider, and what a retry
   * repeats verbatim. */
  @Prop({ type: String, required: true })
  providerEventId!: string;

  /** SHA-256 hex of the raw body. Lets a replay be distinguished from a
   * provider re-sending a MUTATED payload under the same event id. */
  @Prop({ type: String, required: true })
  payloadHash!: string;

  @Prop({ type: String, enum: WEBHOOK_EVENT_STATUSES, required: true, default: 'received' })
  status!: WebhookEventStatus;

  @Prop({ type: Number, default: 0 })
  attempts!: number;

  @Prop({ type: String })
  lastError?: string;

  @Prop({ type: Date, required: true, default: () => new Date() })
  receivedAt!: Date;

  @Prop({ type: Date })
  processedAt?: Date;
}

export type WebhookEventDocument = HydratedDocument<WebhookEvent>;
export const WebhookEventSchema = SchemaFactory.createForClass(WebhookEvent);

// REPLAY GUARD. The handler inserts first and treats E11000 as "already seen,
// return 200". Without it, a provider retry (which they do on any non-2xx, and
// on timeouts they never saw a response for) re-runs the handler and grants a
// second period of entitlement for one payment.
WebhookEventSchema.index({ provider: 1, providerEventId: 1 }, { unique: true });

// Retry sweep: "failed events, oldest first". Without it the sweep scans the
// whole event store on every tick.
WebhookEventSchema.index({ status: 1, receivedAt: 1 });

// TTL: Mongo auto-deletes webhook_events rows older than 180 days. This is an
// append-only log of every inbound event and would otherwise grow unbounded.
// 180 days comfortably outlives any provider's retry window, so expiry can
// never resurrect a replay.
WebhookEventSchema.index({ receivedAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });
