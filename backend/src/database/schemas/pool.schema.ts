import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';
import { Schema as MongooseSchema } from 'mongoose';

export interface PoolToken {
  address: string;
  symbol: string;
  decimals: number;
}

export interface PoolMetrics {
  tvlUsd: number;
  /** Raw per-token pool reserves (human units) from the subgraph — feed the
   * quoteless-leg derivation's realizability backing when the live vanilla
   * pool-stats fetch is down. Optional: rows written before 2026-06 lack them. */
  tvlToken0?: number;
  tvlToken1?: number;
  /** 24h volume / TVL utilization (Krystal-style organic-activity signal). */
  volumeTvl24h?: number;
  volumeUsd24h: number;
  volumeUsd7d: number;
  feesUsd24h: number;
  feesUsd7d: number;
  /** Lifetime-cumulative subgraph `volumeUSD`/`feesUSD` — same semantics as the
   * position-side poolStats, so the adapter's last-good fallback can serve them
   * without mixing 24h and lifetime numbers. Optional: rows written before
   * 2026-06-11 lack them. */
  volumeUsdTotal?: number;
  feesUsdTotal?: number;
  feeApr: number;
  txCount: number;
  currentPrice: number;
}

export interface PoolPricing {
  source: string;
  usedFallback: boolean;
}

@Schema({ timestamps: false, versionKey: false })
export class Pool {
  @Prop({ required: true, type: Number }) chainId: number;
  @Prop({ required: true, type: String }) protocol: string;
  @Prop({ required: true, type: String }) poolId: string;
  @Prop({ type: MongooseSchema.Types.Mixed, required: true }) token0: PoolToken;
  @Prop({ type: MongooseSchema.Types.Mixed, required: true }) token1: PoolToken;
  @Prop({ required: true, type: Number }) fee: number;
  /**
   * The pool's hook contract, lower-cased (`normalizeHooks`); ABSENT for a pool
   * without one (the zero address is never stored). Immutable: the hook is part
   * of the pool key, so it can never change for a `poolId`. MUST be declared —
   * `strict` mode silently drops an undeclared path from a `$set`. Written by
   * pool sync only, and only on a hooked pool, so a pool without one keeps the
   * `contentHash` it had before this field existed and is not rewritten.
   */
  @Prop({ type: String }) hooks?: string;
  @Prop({ required: true, type: Number }) tickSpacing: number;
  @Prop({ default: 0, type: Number }) currentTick: number;
  @Prop({ default: '0', type: String }) sqrtPriceX96: string;
  @Prop({ default: '0', type: String }) liquidity: string;
  @Prop({ default: 0, type: Number }) createdAtTimestamp: number;
  @Prop({ type: MongooseSchema.Types.Mixed, required: true }) metrics: PoolMetrics;
  @Prop({ type: MongooseSchema.Types.Mixed, required: true }) pricing: PoolPricing;
  @Prop({ required: true, type: Date }) updatedAt: Date;
  /**
   * sha1 of the material fields pool sync last wrote (`poolContentHash`), so an
   * unchanged pool is not rewritten. Internal. MUST be declared: `strict` mode
   * silently drops an undeclared path from a `$set`.
   */
  @Prop({ type: String }) contentHash?: string;
}

export type PoolDocument = HydratedDocument<Pool>;
export const PoolSchema = SchemaFactory.createForClass(Pool);

PoolSchema.index({ chainId: 1, protocol: 1, poolId: 1 }, { unique: true });
PoolSchema.index({ chainId: 1, protocol: 1, 'metrics.tvlUsd': -1 });
PoolSchema.index({ chainId: 1, protocol: 1, 'metrics.volumeUsd24h': -1 });
PoolSchema.index({ chainId: 1, protocol: 1, 'metrics.feesUsd24h': -1 });
PoolSchema.index({ chainId: 1, protocol: 1, 'metrics.feeApr': -1 });
PoolSchema.index({ chainId: 1, protocol: 1, createdAtTimestamp: 1 });

// Token-address lookups for the tokenized-equity filter (assetClass=equity),
// which is an $or across both legs — Mongo cannot use one compound index for
// both branches, so each leg gets its own. Leading with chainId+protocol keeps
// them consistent with every other index here and lets the equality prefix do
// the selective work before the address set is probed.
PoolSchema.index({ chainId: 1, protocol: 1, 'token0.address': 1 });
PoolSchema.index({ chainId: 1, protocol: 1, 'token1.address': 1 });
