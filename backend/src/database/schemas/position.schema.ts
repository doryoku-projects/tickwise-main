import { Prop, raw, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

type TokenSnapshot = {
  address: string;
  symbol: string;
  decimals: number;
  verified: boolean;
  priceUsd: number;
  priceConfidence?: string;
};

type PositionAmounts = {
  amount0: string;
  amount1: string;
  depositedToken0: string;
  depositedToken1: string;
  depositedUsd: string;
  withdrawnToken0: string;
  withdrawnToken1: string;
  withdrawnUsd: string;
  totalFeesCollected0: string;
  totalFeesCollected1: string;
  totalFeesCollectedUsd: string;
  totalFeesUncollected0: string;
  totalFeesUncollected1: string;
  totalFeesUncollectedUsd: string;
  totalGasCostEth: string;
  totalGasCostUsd: string;
  diffToken0: string;
  diffToken1: string;
  diffUsd: string;
};

type PositionMetrics = {
  apr: number;
  aprExGas: number;
  feeApr: number;
  poolApr: number;
  roi: number;
  pnlUsd: number;
  pnlEth: number;
  pnlHodl: number;
  poolPnlUsd: number;
  divergenceLossUsd: number;
  underlyingValueUsd: number;
  /** Value at consistency-checked market quotes IGNORING realizability —
   * display-only (differs from underlyingValueUsd only when unrealizableLeg). */
  nominalValueUsd?: number;
  pendingFeesUsd: number;
  collectedFeesUsd: number;
  totalFeesUsd: number;
  totalGasCostUsd: number;
  investedUsd: number;
  depositedUsd: number;
  withdrawnUsd: number;
  diffUsd: number;
  unclaimedRewardsUsd: number;
  claimedRewardsUsd: number;
  /**
   * vs-USD basis companion of the headline (vs-HODL) metrics, for the
   * detail-view `ref USD` toggle. Top-level metrics stay vs-HODL (leaderboard
   * ranking). Computed in the same recompute pass; absent on positions not yet
   * recomputed.
   */
  usd?: {
    pnlUsd: number;
    poolPnlUsd: number;
    divergenceLossUsd: number;
    apr: number;
    aprExGas: number;
    feeApr: number;
    roi: number;
  };
  ageSeconds: number;
  inRange: boolean;
  isPriceable: boolean;
  /** True → a quoted leg was valued $0 by the realizability gate (claim exceeds
   * the pool's real backing) — a VALID $0 valuation, not a pricing failure. */
  unrealizableLeg?: boolean;
  /** True → a held leg had NO usable price (data gap); show "price unavailable". */
  priceUnavailable?: boolean;
  performanceReady: boolean;
  performanceSource: string;
  aprWarmup: boolean;
  /** Where the served uncollected-fee figure came from — see `FeesSource`.
   * Absent on a document not re-written since the field landed. */
  feesSource?: 'onchain' | 'indexer' | 'settled' | 'unmeasured';
  /** When the served figure was measured on-chain; null unless `onchain`. */
  feesMeasuredAt?: Date | null;
};

type PoolStats = {
  tvlUsd: number;
  tvlUsdUntracked: number;
  volumeUsd: number;
  totalFeesUsd: number;
  priceDivergence: number;
};

type PricingSnapshot = {
  source: string;
  usedFallback: boolean;
  pricedAt?: Date;
};

export type PositionTxSyncStatus = 'pending' | 'success' | 'failed';

const TokenSnapshotDef = raw({
  address: { type: String, required: true },
  symbol: { type: String, required: true },
  decimals: { type: Number, required: true },
  verified: { type: Boolean, default: false },
  priceUsd: { type: Number, default: 0 },
});

const PositionAmountsDef = raw({
  amount0: { type: String, default: '0' },
  amount1: { type: String, default: '0' },
  depositedToken0: { type: String, default: '0' },
  depositedToken1: { type: String, default: '0' },
  depositedUsd: { type: String, default: '0' },
  withdrawnToken0: { type: String, default: '0' },
  withdrawnToken1: { type: String, default: '0' },
  withdrawnUsd: { type: String, default: '0' },
  totalFeesCollected0: { type: String, default: '0' },
  totalFeesCollected1: { type: String, default: '0' },
  totalFeesCollectedUsd: { type: String, default: '0' },
  totalFeesUncollected0: { type: String, default: '0' },
  totalFeesUncollected1: { type: String, default: '0' },
  totalFeesUncollectedUsd: { type: String, default: '0' },
  totalGasCostEth: { type: String, default: '0' },
  totalGasCostUsd: { type: String, default: '0' },
  diffToken0: { type: String, default: '0' },
  diffToken1: { type: String, default: '0' },
  diffUsd: { type: String, default: '0' },
});

const PositionMetricsDef = raw({
  apr: { type: Number, default: 0 },
  aprExGas: { type: Number, default: 0 },
  feeApr: { type: Number, default: 0 },
  poolApr: { type: Number, default: 0 },
  roi: { type: Number, default: 0 },
  pnlUsd: { type: Number, default: 0 },
  pnlEth: { type: Number, default: 0 },
  pnlHodl: { type: Number, default: 0 },
  poolPnlUsd: { type: Number, default: 0 },
  divergenceLossUsd: { type: Number, default: 0 },
  underlyingValueUsd: { type: Number, default: 0 },
  nominalValueUsd: { type: Number, default: 0 },
  pendingFeesUsd: { type: Number, default: 0 },
  collectedFeesUsd: { type: Number, default: 0 },
  totalFeesUsd: { type: Number, default: 0 },
  totalGasCostUsd: { type: Number, default: 0 },
  investedUsd: { type: Number, default: 0 },
  depositedUsd: { type: Number, default: 0 },
  withdrawnUsd: { type: Number, default: 0 },
  diffUsd: { type: Number, default: 0 },
  unclaimedRewardsUsd: { type: Number, default: 0 },
  claimedRewardsUsd: { type: Number, default: 0 },
  usd: {
    type: raw({
      pnlUsd: { type: Number, default: 0 },
      poolPnlUsd: { type: Number, default: 0 },
      divergenceLossUsd: { type: Number, default: 0 },
      apr: { type: Number, default: 0 },
      aprExGas: { type: Number, default: 0 },
      feeApr: { type: Number, default: 0 },
      roi: { type: Number, default: 0 },
    }),
    default: {},
  },
  ageSeconds: { type: Number, default: 0 },
  inRange: { type: Boolean, default: false },
  isPriceable: { type: Boolean, default: true },
  unrealizableLeg: { type: Boolean, default: false },
  priceUnavailable: { type: Boolean, default: false },
  performanceReady: { type: Boolean, default: false },
  performanceSource: { type: String, default: 'pending-transactions' },
  aprWarmup: { type: Boolean, default: false },
  // Declared so a `$set` of them survives Mongoose's strict mode (an undeclared
  // subdocument path is dropped silently). No default: absent = not labelled yet.
  // 'indexer' is LEGACY — kept so documents written before 2026-10-05 still
  // validate; nothing writes it any more (see FeesSource in sync/position-fee-math).
  feesSource: { type: String, enum: ['onchain', 'indexer', 'settled', 'unmeasured'] },
  feesMeasuredAt: { type: Date },
});

const PoolStatsDef = raw({
  tvlUsd: { type: Number, default: 0 },
  tvlUsdUntracked: { type: Number, default: 0 },
  volumeUsd: { type: Number, default: 0 },
  totalFeesUsd: { type: Number, default: 0 },
  priceDivergence: { type: Number, default: 0 },
});

const PricingSnapshotDef = raw({
  source: { type: String, default: 'none' },
  usedFallback: { type: Boolean, default: false },
  pricedAt: { type: Date },
});

@Schema({
  collection: 'positions',
  timestamps: true,
})
export class Position {
  @Prop({ type: Number, required: true })
  chainId!: number;

  @Prop({ type: String, required: true })
  protocol!: string;

  @Prop({ type: String, required: true })
  positionId!: string;

  @Prop({ type: String, required: true })
  tokenId!: string;

  @Prop({ type: String, required: true })
  owner!: string;

  @Prop({ type: String, required: true })
  poolId!: string;

  @Prop({ type: TokenSnapshotDef, required: true })
  token0!: TokenSnapshot;

  @Prop({ type: TokenSnapshotDef, required: true })
  token1!: TokenSnapshot;

  @Prop({ type: Number, default: 0 })
  fee!: number;

  @Prop({ type: Number, default: 0 })
  tickSpacing!: number;

  @Prop({ type: Number, default: 0 })
  tickLower!: number;

  @Prop({ type: Number, default: 0 })
  tickUpper!: number;

  @Prop({ type: Number, default: 0 })
  currentTick!: number;

  @Prop({ type: String, default: '0' })
  sqrtPriceX96!: string;

  @Prop({ type: String, default: '0' })
  liquidity!: string;

  /*
   * On-chain uncollected fees, measured by PositionFeeRefreshService (StateView
   * via Multicall3), decimal-adjusted. Written ONLY by that job and never by the
   * indexer path, so neither can overwrite the other; EnvioAdapter serves this as
   * the ONLY uncollected-fee figure (the indexer no longer has one — see
   * chooseUncollected). No default
   * on purpose: absent means "never measured", which must stay distinguishable
   * from a measured 0.
   */
  @Prop({ type: String })
  rpcFeesUncollected0?: string;

  @Prop({ type: String })
  rpcFeesUncollected1?: string;

  /** The block the measurement's state was read at (each Multicall3 batch reads its own). */
  @Prop({ type: Number })
  rpcFeesBlock?: number;

  @Prop({ type: Date })
  rpcFeesAt?: Date;

  /**
   * The block of the position's last ModifyLiquidity, as the indexer reports it
   * (`Position.lastModifyBlock`, written ONLY by its modify handler — never by a
   * Transfer). A modify settles fees, so an on-chain fee
   * measurement is current only when taken at or after this block. No default:
   * absent means "not yet re-synced", which every comparison treats as 0.
   */
  @Prop({ type: Number })
  lastModifyBlock?: number;

  @Prop({ type: Boolean, default: true })
  isActive!: boolean;

  @Prop({ type: Number, default: 0 })
  createdAtTimestamp!: number;

  @Prop({ type: Number, default: null })
  closedAtTimestamp!: number | null;

  @Prop({ type: PositionAmountsDef, default: () => ({}) })
  amounts!: PositionAmounts;

  @Prop({ type: PositionMetricsDef, default: () => ({}) })
  metrics!: PositionMetrics;

  @Prop({ type: PoolStatsDef, default: () => ({}) })
  poolStats!: PoolStats;

  @Prop({ type: PricingSnapshotDef, default: () => ({}) })
  pricing!: PricingSnapshot;

  /*
   * LEGACY, no longer written (2026-10-06). The raw indexer row used to be
   * stored on every position and nothing ever read it back. It stays DECLARED,
   * with no default, for one reason: every full write `$unset`s it
   * (`PositionsRepository.positionUpdate`), and Mongoose's strict mode silently
   * drops the `$unset` of an undeclared path — so removing this line would
   * leave the field on every stored row. Rows no write reaches (closed
   * positions) are cleaned by `scripts/positions-raw-subgraph-cleanup.mjs`.
   */
  @Prop({ type: Object })
  rawSubgraph?: Record<string, unknown>;

  @Prop({ type: Date, default: () => new Date() })
  lastSyncedAt!: Date;

  @Prop({ type: Date, default: () => new Date() })
  lastVerifiedAt!: Date;

  @Prop({ type: Number, default: 0 })
  staleMisses!: number;

  /*
   * P2.3 (`POSITIONS_WRITE_SKIP`, `database/position-write-hash.ts`): the
   * section hashes of what the last write stored — BinData(0), 64 bytes =
   * 8 sections × 8 bytes, an all-zero slot = unknown — and when the last FULL
   * write happened. DECLARED because Mongoose's strict mode silently drops an
   * undeclared path from a `$set`. No default and no index: absent = "not
   * hashed" (the next write is a full one). Every other writer of a hashed
   * section `$unset`s `wh`. Never served (not in any projection or allow-list).
   */
  @Prop({ type: Buffer })
  wh?: Buffer;

  @Prop({ type: Date })
  wAt?: Date;

  @Prop({ type: String, enum: ['pending', 'success', 'failed'], default: 'pending' })
  txSyncStatus!: PositionTxSyncStatus;

  @Prop({ type: Date })
  txLastAttemptAt?: Date;

  @Prop({ type: Date })
  txLastSuccessAt?: Date;

  @Prop({ type: Number, default: 0 })
  txSyncedTransactionCount!: number;

  @Prop({ type: Date })
  txFinalizedAt?: Date;

  @Prop({ type: Date })
  txLastFailureAt?: Date;

  @Prop({ type: String })
  txLastError?: string;
}

export type PositionDocument = HydratedDocument<Position>;
export const PositionSchema = SchemaFactory.createForClass(Position);

PositionSchema.index({ chainId: 1, protocol: 1, positionId: 1 }, { unique: true });
PositionSchema.index({ chainId: 1, protocol: 1, poolId: 1 });
// The owner filter is served by this index. `findLeaderboard` ALWAYS runs with
// `.collation({ locale: 'en', numericOrdering: true })` (for the positionId
// tie-break / nft_id_* sorts), and MongoDB uses an index for a STRING field only
// when the index collation matches the query collation — so this index MUST
// carry the same collation, otherwise the owner equality can't use it and every
// wallet lookup degrades to a full per-shard scan (verified via explain:
// simple-collation index → 20k docs examined; collated → 1).
// NOTE: the poolId index above has the same latent mismatch (pre-existing); it
// needs a drop+recreate migration to fix in place, tracked separately.
PositionSchema.index(
  { chainId: 1, protocol: 1, owner: 1 },
  { collation: { locale: 'en', numericOrdering: true } },
);
// The fee job's full tier walks it (`findFeeRefreshCandidates`: isActive
// equality, keyset + sort on tokenId).
PositionSchema.index({ chainId: 1, protocol: 1, isActive: -1, tokenId: 1 });
/*
 * NO LONGER DECLARED since 2026-10-03 (scale plan 1.10 / D1): six unnamed
 * indexes no reader uses — `{…, isActive}` (its one reader, /v1/stats, counts
 * on `bg_active_walk` now), `{…, metrics.performanceReady}`,
 * `{…, createdAtTimestamp, positionId}` (an admin sample walk uses
 * `lbr_created` collated instead), `{…, lastVerifiedAt}` (its readers were two
 * dead methods, removed), `{…, isActive, txSyncStatus, txLastSuccessAt}` and
 * `{…, isActive, txFinalizedAt}` (the v3-only closed picker walks the positionId
 * index; v4 never reaches it) — plus the named `bg_fee_hot` and the old
 * `bg_active_pool`, below. They stay on the shards until
 * `scripts/positions-index-migration.mjs --drop-legacy --apply` drops them,
 * gated on `$indexStats` evidence (`LEGACY_UNUSED_INDEXES`).
 */

// Token-address lookups for the tokenized-equity filter (assetClass=equity),
// which is an $or across both legs — Mongo cannot use one compound index for
// both branches, so each leg gets its own. Leading with chainId+protocol keeps
// them consistent with every other index here and lets the equality prefix do
// the selective work before the address set is probed.
PositionSchema.index({ chainId: 1, protocol: 1, 'token0.address': 1 });
PositionSchema.index({ chainId: 1, protocol: 1, 'token1.address': 1 });

/*
 * ═══════════════════════════════════════════════════════════════════════════
 *  RUN `node scripts/positions-index-migration.mjs --apply` ON EVERY
 *  ENVIRONMENT BEFORE DEPLOYING THIS SCHEMA.
 * ═══════════════════════════════════════════════════════════════════════════
 * The eleven indexes below — the leaderboard "Set R" (`lbr_*`) and the
 * background-reader set (`bg_*`) — are BUILT by that script, off-peak, one
 * `createIndexes` per shard. They are declared here so Mongoose's `autoIndex`
 * (ON outside production; OFF on the shard collections in production since
 * 2026-10-03, `MONGO_SHARD_AUTO_INDEX`) sees them as already existing, and so
 * the boot pre-flight can check them: each declaration must match the script's
 * `SET_R_SPECS` / `BACKGROUND_SPECS` EXACTLY — name, key ORDER, collation,
 * partialFilterExpression — which `test/leaderboard-index-plan.spec.ts`
 * asserts. What goes wrong otherwise:
 *  - an index MISSING at boot is built by autoIndex on the primary during the
 *    deploy where autoIndex is on (a collection scan per index per shard, all
 *    shards at once), and is NOT built at all in production. Until it exists, a
 *    hint naming it is a BadValue and `withHint` runs the query on its
 *    fallback or unhinted (one `[alert] positions.hint_missing` per shard and
 *    index).
 *  - an index that EXISTS under one of these names with a DIFFERENT spec stays
 *    as it is: autoIndex's createIndex fails with IndexOptionsConflict, which
 *    `main.ts`'s `unhandledRejection` handler logs and SWALLOWS. A hint naming
 *    it raises no error at all — MongoDB obeys it, so a narrower partial filter
 *    returns incomplete pages and a wrong collation turns the sort walk into a
 *    full scan. `withHint` cannot see that; the boot pre-flight
 *    (`CollectionResolver.preflightPositionIndexes`, read-only, before autoIndex
 *    starts) compares every shard's `listIndexes` with these declarations,
 *    raises `[alert] positions.index_mismatch` / `positions.index_preflight`,
 *    and keeps every query off a mismatched index for the life of the process.
 *
 * The seven legacy simple-collation metric indexes (`metrics.apr`, `feeApr`,
 * `roi`, `pnlUsd`, `underlyingValueUsd`, `ageSeconds`, `aprExGas`) are no
 * longer declared: Set R supersedes them — and since 2026-10-03 neither are the
 * eight unused ones listed above the Set R block. autoIndex never drops
 * anything, so they stay on the shards until `--drop-legacy --apply` runs,
 * once `$indexStats` on EVERY member shows them unused for ≥ 48 h (the script
 * compares against a recorded snapshot). Since 2026-10-03 autoIndex is OFF on
 * the shard collections in production (`MONGO_SHARD_AUTO_INDEX`), so neither a
 * boot of this image nor of any later one builds an index; a missing declared
 * index is only reported (`[alert] positions.index_preflight`). ROLLBACK: an
 * image from BEFORE that change still declares the dropped indexes with
 * autoIndex on, so after the drop a rollback to it rebuilds them on the
 * primary at boot (one scan per index per shard, mid-incident). Drop them only
 * once rolling back past this schema is no longer an option.
 *
 * Collation: Set R carries the leaderboard query's `{locale:'en',
 * numericOrdering:true}`. The `bg_*` set is built with `{locale:'simple'}`,
 * which the server stores as NO collation, so it is declared with none — a
 * declared `{locale:'simple'}` would read as a mismatch to `diffIndexes`.
 */
const LEADERBOARD_COLLATION = { locale: 'en', numericOrdering: true } as const;
const ACTIVE_ONLY = { isActive: true } as const;

// Set R — partial on actives: the three rate sorts (active-only by construction).
PositionSchema.index(
  { chainId: 1, protocol: 1, 'metrics.aprExGas': -1, positionId: 1, 'metrics.inRange': 1, 'metrics.underlyingValueUsd': 1 },
  { name: 'lbr_apr_active', collation: { ...LEADERBOARD_COLLATION }, partialFilterExpression: { ...ACTIVE_ONLY } },
);
PositionSchema.index(
  { chainId: 1, protocol: 1, 'metrics.feeApr': -1, positionId: 1, 'metrics.inRange': 1, 'metrics.underlyingValueUsd': 1 },
  { name: 'lbr_feeapr_active', collation: { ...LEADERBOARD_COLLATION }, partialFilterExpression: { ...ACTIVE_ONLY } },
);
PositionSchema.index(
  { chainId: 1, protocol: 1, 'metrics.roi': -1, positionId: 1, 'metrics.inRange': 1, 'metrics.underlyingValueUsd': 1 },
  { name: 'lbr_roi_active', collation: { ...LEADERBOARD_COLLATION }, partialFilterExpression: { ...ACTIVE_ONLY } },
);
// Set R — full: sorts every status can ask for.
PositionSchema.index(
  { chainId: 1, protocol: 1, 'metrics.poolPnlUsd': -1, positionId: 1, isActive: 1, 'metrics.inRange': 1, 'metrics.underlyingValueUsd': 1 },
  { name: 'lbr_pnl', collation: { ...LEADERBOARD_COLLATION } },
);
PositionSchema.index(
  { chainId: 1, protocol: 1, 'metrics.underlyingValueUsd': -1, positionId: 1, isActive: 1, 'metrics.inRange': 1 },
  { name: 'lbr_value', collation: { ...LEADERBOARD_COLLATION } },
);
PositionSchema.index(
  { chainId: 1, protocol: 1, createdAtTimestamp: -1, positionId: 1, isActive: 1, 'metrics.inRange': 1 },
  { name: 'lbr_created', collation: { ...LEADERBOARD_COLLATION } },
);
PositionSchema.index(
  { chainId: 1, protocol: 1, tokenId: 1, positionId: 1, isActive: 1, 'metrics.inRange': 1 },
  { name: 'lbr_tokenid', collation: { ...LEADERBOARD_COLLATION } },
);

// Background readers — partial on actives, no collation (their queries carry none).
PositionSchema.index(
  { chainId: 1, protocol: 1, isActive: 1, positionId: 1, 'metrics.performanceReady': 1 },
  { name: 'bg_active_walk', partialFilterExpression: { ...ACTIVE_ONLY } },
);
PositionSchema.index(
  { chainId: 1, protocol: 1, isActive: 1, 'token0.address': 1 },
  { name: 'bg_active_token0', partialFilterExpression: { ...ACTIVE_ONLY } },
);
PositionSchema.index(
  { chainId: 1, protocol: 1, isActive: 1, 'token1.address': 1 },
  { name: 'bg_active_token1', partialFilterExpression: { ...ACTIVE_ONLY } },
);
// A pool's open positions with their owner IN THE KEY (2026-10-03; it was
// `bg_active_pool`, `{…, poolId}`): the pools list's holder count — a `$group`
// of `$addToSet: '$owner'` — reads keys only. A new NAME, not a rebuild in
// place, so the migration builds it beside the old one (no window without
// either) and the old one goes through the `$indexStats`-gated drop.
PositionSchema.index(
  { chainId: 1, protocol: 1, isActive: 1, poolId: 1, owner: 1 },
  { name: 'bg_active_pool_owner', partialFilterExpression: { ...ACTIVE_ONLY } },
);
