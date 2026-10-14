import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/** `Counter._id` for the monotonic `Invoice.number` sequence. */
export const INVOICE_NUMBER_COUNTER_KEY = 'invoice_number';


/**
 * Atomic sequence generator — one document per named counter, bumped with
 * `findOneAndUpdate({ _id }, { $inc: { seq: 1 } }, { upsert: true, new: true })`.
 * `$inc` is atomic server-side, so two concurrent invoice creations can never
 * draw the same number (a read-then-write "max + 1" can, and would then collide
 * on nothing — `Invoice.number` has no unique index of its own).
 */
@Schema({
  collection: 'counters',
  timestamps: true,
})
export class Counter {
  /**
   * The counter's name (e.g. `invoice_number`) used AS the `_id`, overriding
   * the default ObjectId. Deliberate: `_id` is unique by definition, so the
   * upsert needs no second unique index and cannot race into duplicates.
   */
  @Prop({ type: String, required: true })
  _id!: string;

  /** Last value handed out. The first `$inc` upsert yields `1`. */
  @Prop({ type: Number, required: true, default: 0 })
  seq!: number;
}

export type CounterDocument = HydratedDocument<Counter>;
export const CounterSchema = SchemaFactory.createForClass(Counter);
// No index declarations: `_id` is the natural key here and Mongo always indexes
// it uniquely. Adding an explicit one would only duplicate that index.
