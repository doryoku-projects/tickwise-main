import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/**
 * Per-request detail companion to the monthly `usage` snapshot: one row per
 * (customer, day, route, key, status class), so the portal and the admin panel
 * can answer "what did I spend it on" instead of only "how much".
 *
 * `usage` stays the customer-per-period rollup and Redis stays the live source
 * of truth for enforcement — nothing here is consulted on the request hot-path
 * and nothing here gates a quota. The write is one upsert performed at response
 * finish from the access-log seam in `main.ts` (the only place that sees the
 * FINAL status code, and one that 429 rejections also reach), fire-and-forget
 * with the same discipline as `MeteringService.snapshotUsage`: it logs and
 * swallows, and never throws into the response path.
 *
 * Retention is the TTL index at the bottom of this file and NOTHING else —
 * there is no sweep, no archive job and no admin delete, so a row that the TTL
 * does not remove stays forever.
 */
@Schema({
  collection: 'usage_buckets',
  timestamps: true,
})
export class UsageBucket {
  /**
   * No `index: true` here: it is already the leading field of both compound
   * indexes below, and a standalone index on the prefix of your own compound
   * index is dead weight on every write (the mistake `usage.schema.ts:15`
   * makes against its own `{customerId, period}` index).
   */
  @Prop({ type: Types.ObjectId, ref: 'Customer', required: true })
  customerId!: Types.ObjectId;

  /**
   * Reserved for the multi-tenant plan, which
   * adds a nullable tenant FK to every billing collection. Declared now and
   * deliberately UNINDEXED — writing the field from day one means a later
   * rollout is a backfill of existing rows rather than a schema migration on a
   * collection this size, and an index nothing queries yet would only cost
   * writes.
   */
  @Prop({ type: Types.ObjectId })
  tenantId?: Types.ObjectId;

  /** Calendar day bucket, `YYYY-MM-DD` (UTC). */
  @Prop({ type: String, required: true })
  day!: string;

  /**
   * Calendar month bucket, `YYYY-MM` (UTC). Denormalised from `day` so a month
   * rollup is an equality match rather than a range over parsed dates.
   */
  @Prop({ type: String, required: true })
  period!: string;

  /** Matches the `@UnitCost(routeKey)` on the controller method. */
  @Prop({ type: String, required: true })
  routeKey!: string;

  @Prop({ type: Types.ObjectId, required: true })
  apiKeyId!: Types.ObjectId;

  /**
   * Denormalised, and NOT a `ref` to `api_keys`, because key deletion is a HARD
   * delete (`ClientsService` uses `findByIdAndDelete` / `findOneAndDelete`) —
   * the `apiKeyId` above goes dangling the moment a customer removes a key, and
   * a populate would then render a row with nothing to identify it by. The
   * prefix and label are captured at request time so history stays readable
   * after the key is gone.
   */
  @Prop({ type: String, default: '' })
  keyPrefix!: string;

  @Prop({ type: String, default: '' })
  keyLabel!: string;

  @Prop({ type: String, enum: ['2xx', '4xx', '5xx', '429'], required: true })
  statusClass!: '2xx' | '4xx' | '5xx' | '429';

  /**
   * NET units for this bucket: the guard records what it actually charged, and
   * the interceptor's refund path zeroes it, so a refunded request contributes
   * 0 here rather than a charge plus a compensating row.
   */
  @Prop({ type: Number, default: 0 })
  units!: number;

  @Prop({ type: Number, default: 0 })
  requests!: number;
}

export type UsageBucketDocument = HydratedDocument<UsageBucket>;
export const UsageBucketSchema = SchemaFactory.createForClass(UsageBucket);

/** The upsert key — the full identity of a bucket, so the writer needs no read. */
UsageBucketSchema.index(
  { customerId: 1, day: 1, routeKey: 1, apiKeyId: 1, statusClass: 1 },
  { unique: true },
);

/** The range read: every detail view is one customer over a window of days. */
UsageBucketSchema.index({ customerId: 1, day: -1 });

/**
 * ~13 months of history, which covers a year-over-year comparison plus the
 * current month. This is the only thing that ever removes a row — there is no
 * sweep, no archive job and no admin delete.
 *
 * The TTL hangs on `createdAt`, NOT on `day`. MongoDB's TTL monitor expires a
 * document only when the indexed field holds a BSON `Date`; `day` is a
 * `YYYY-MM-DD` STRING (every read groups on it as one), so a TTL declared
 * there builds without error, sorts and filters correctly, and expires
 * nothing — forever. `timestamps: true` already writes `createdAt` as a real
 * Date at the upsert that creates the bucket, and a bucket is created on the
 * day it covers, so the two are the same clock to within a day.
 */
UsageBucketSchema.index({ createdAt: 1 }, { expireAfterSeconds: 400 * 86400 });
