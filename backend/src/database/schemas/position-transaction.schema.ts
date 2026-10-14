import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({
  collection: 'position_transactions',
  timestamps: true,
})
export class PositionTransaction {
  @Prop({ type: Number, required: true })
  chainId!: number;

  @Prop({ type: String, required: true })
  protocol!: string;

  @Prop({ type: String, required: true })
  positionId!: string;

  @Prop({ type: String, required: true })
  tokenId!: string;

  @Prop({ type: String, required: true })
  transactionId!: string;

  @Prop({ type: String, required: true })
  txHash!: string;

  @Prop({ type: String, required: true })
  type!: string;

  @Prop({ type: Number, default: 0 })
  timestamp!: number;

  @Prop({ type: String, default: '0' })
  amount0!: string;

  @Prop({ type: String, default: '0' })
  amount1!: string;

  @Prop({ type: Number, default: 0 })
  amount0PriceUsd!: number;

  @Prop({ type: Number, default: 0 })
  amount1PriceUsd!: number;

  @Prop({ type: Number, default: 0 })
  amount0PriceUsdUntracked!: number;

  @Prop({ type: Number, default: 0 })
  amount1PriceUsdUntracked!: number;

  @Prop({ type: Number, default: 0 })
  amount0HistoricalPriceUsd!: number;

  @Prop({ type: Number, default: 0 })
  amount1HistoricalPriceUsd!: number;

  @Prop({ type: Number, default: 0 })
  historicalValueUsd!: number;

  @Prop({ type: String, default: 'none' })
  historicalPricingSource!: string;

  @Prop({ type: Number, default: 0 })
  gasCostEth!: number;

  @Prop({ type: Number, default: 0 })
  gasCostUsd!: number;

  @Prop({ type: String, default: '' })
  sender!: string;

  @Prop({ type: Number, default: 0 })
  logIndex!: number;

  @Prop({ type: Object, default: {} })
  rawSubgraph!: Record<string, unknown>;

  @Prop({ type: Date, default: () => new Date() })
  lastSyncedAt!: Date;
}

export type PositionTransactionDocument = HydratedDocument<PositionTransaction>;
export const PositionTransactionSchema = SchemaFactory.createForClass(PositionTransaction);

PositionTransactionSchema.index(
  { chainId: 1, protocol: 1, positionId: 1, transactionId: 1 },
  { unique: true },
);
PositionTransactionSchema.index({ chainId: 1, protocol: 1, tokenId: 1, timestamp: -1 });
PositionTransactionSchema.index({ chainId: 1, protocol: 1, txHash: 1, logIndex: 1 });
