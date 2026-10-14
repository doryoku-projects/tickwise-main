import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({
  collection: 'endpoint_costs',
  timestamps: true,
})
export class EndpointCost {
  /** Matches the `@UnitCost(routeKey, ...)` on the controller method. */
  @Prop({ type: String, required: true, unique: true, trim: true })
  routeKey!: string;

  @Prop({ type: String, required: true })
  label!: string;

  /** Units charged per request. Editable from the admin panel. */
  @Prop({ type: Number, required: true, default: 1 })
  unitCost!: number;

  @Prop({ type: Boolean, default: true })
  enabled!: boolean;
}

export type EndpointCostDocument = HydratedDocument<EndpointCost>;
export const EndpointCostSchema = SchemaFactory.createForClass(EndpointCost);
// The unique index on `routeKey` comes from `@Prop({ unique: true })` above. Declaring it a
// second time here made Mongoose warn "Duplicate schema index" at every boot (same index).
