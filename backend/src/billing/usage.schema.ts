import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

/**
 * Mongo snapshot of consumption per customer per billing period, for the admin
 * panel. Redis (via rate-limiter-flexible) is the live source of truth for
 * enforcement; this collection is updated best-effort and is not consulted on
 * the request hot-path.
 */
@Schema({
  collection: 'usage',
  timestamps: true,
})
export class Usage {
  @Prop({ type: Types.ObjectId, ref: 'Customer', required: true, index: true })
  customerId!: Types.ObjectId;

  /** Calendar month bucket, `YYYY-MM` (UTC). */
  @Prop({ type: String, required: true })
  period!: string;

  @Prop({ type: Number, default: 0 })
  unitsConsumed!: number;

  @Prop({ type: Number, default: 0 })
  requestCount!: number;
}

export type UsageDocument = HydratedDocument<Usage>;
export const UsageSchema = SchemaFactory.createForClass(Usage);
UsageSchema.index({ customerId: 1, period: 1 }, { unique: true });
