import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({
  collection: 'token_price_historical',
  timestamps: true,
})
export class TokenPriceHistorical {
  @Prop({ type: Number, required: true })
  chainId!: number;

  @Prop({ type: String, required: true })
  address!: string;

  @Prop({ type: Number, required: true })
  bucketTs!: number;

  @Prop({ type: Number, required: true })
  priceUsd!: number;

  @Prop({ type: String, required: true })
  source!: string;

  @Prop({ type: Date, default: () => new Date() })
  fetchedAt!: Date;
}

export type TokenPriceHistoricalDocument = HydratedDocument<TokenPriceHistorical>;
export const TokenPriceHistoricalSchema = SchemaFactory.createForClass(TokenPriceHistorical);
TokenPriceHistoricalSchema.index({ chainId: 1, address: 1, bucketTs: 1 }, { unique: true });
