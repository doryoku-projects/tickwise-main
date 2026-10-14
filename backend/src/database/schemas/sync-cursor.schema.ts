import { Prop, Schema, SchemaFactory, raw } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * One fee pass's running counts (`FeePassTally` in sync.repository.ts). Every
 * counter is DECLARED: Mongoose strict mode silently drops an undeclared path
 * from a `$set`/`$inc`, so a counter missing here would read 0 forever.
 */
const FeePassTallyDef = raw({
  scanned: { type: Number },
  measured: { type: Number },
  written: { type: Number },
  served: { type: Number },
  stale: { type: Number },
  unchanged: { type: Number },
  failed: { type: Number },
  unanswered: { type: Number },
  unreadable: { type: Number },
});

@Schema({
  collection: 'sync_cursors',
  timestamps: true,
})
export class SyncCursor {
  @Prop({ type: Number, required: true })
  chainId!: number;

  @Prop({ type: String, required: true })
  protocol!: string;

  @Prop({ type: Number, default: 0 })
  lastTimestamp!: number;

  @Prop({ type: String, default: '' })
  lastPositionId!: string;

  @Prop({ type: Number, default: 0 })
  lastBlockNumber!: number;

  @Prop({ type: Date })
  lastSuccessAt?: Date;

  @Prop({ type: Date })
  lastFailureAt?: Date;

  @Prop({ type: String })
  lastError?: string;

  @Prop({ type: Number, default: 0 })
  liveBlockNumber!: number;

  @Prop({ type: Number, default: 0 })
  liveBlockTimestamp!: number;

  @Prop({ type: Date })
  liveLastPollAt?: Date;

  /**
   * Set to true while a position backfill is in progress for this
   * (chainId, protocol). Consumed by the live-event listener to decide
   * whether to enqueue per-token refresh jobs. Cleared once the backfill
   * has no more pages to fetch. See sync.service.ts.
   */
  @Prop({ type: Boolean, default: false })
  backfillInProgress?: boolean;

  /** Timestamp the current/last backfill window started. */
  @Prop({ type: Date })
  backfillStartedAt?: Date;

  /**
   * Last sign of life of the running backfill: stamped at start, on every
   * flush and by a timer while it runs. `isBackfillInProgress` reads the flag
   * as false once this is older than `BACKFILL_HEARTBEAT_STALE_MS`, so a
   * backfill killed by a deploy no longer suspends the stale sweep forever.
   */
  @Prop({ type: Date })
  backfillHeartbeatAt?: Date;

  /**
   * The run (BullMQ job id) whose `fromStart` cursor reset has been applied. A
   * retry or a stalled re-run of the SAME job finds its own key here and
   * resumes from the cursor instead of resetting it to 0 again.
   */
  @Prop({ type: String })
  backfillResetRunKey?: string;

  /**
   * The backfill PAUSE lever (`POST /admin/sync/backfill/pause`, audit
   * C-pause). Present = paused: a running walk stops at its next flush / page
   * / range like an interrupted run (flag and cursor KEPT, run row
   * `interrupted`), no boot or lease resume re-enqueues it, and a new backfill
   * of the chain is refused until `/resume` `$unset`s both. Absent (every
   * cursor today) = never paused. DECLARED: strict mode drops an undeclared
   * `$set` path, which would make the lever a silent no-op.
   */
  @Prop({ type: Date })
  backfillPausedAt?: Date;

  /** Who paused it and why (`admin` or `admin: <note>`). */
  @Prop({ type: String })
  backfillPausedBy?: string;

  /**
   * Transaction-sync cursor: ascending walk of `positionTransactions` from
   * the subgraph. Composite cursor `(txLastTimestamp, txLastTransactionId)`
   * so same-second rows don't get skipped between pages. Zero/empty means
   * "walk from the earliest known transaction".
   */
  @Prop({ type: Number, default: 0 })
  txLastTimestamp?: number;

  @Prop({ type: String, default: '' })
  txLastTransactionId?: string;

  /*
   * On-chain fee refresh (PositionFeeRefreshService) — one resumable keyset
   * walk per tier, over `tokenId` (lexicographic, the order of the index that
   * serves it). The cursor is the last tokenId the CURRENT pass measured; ''
   * means "from the start". A pass is in progress while `…StartedAt` is newer
   * than `…FinishedAt`. Persisted after every page so a restart resumes where
   * it stopped instead of starting over — the old hourly walk restarted at ''
   * every run and never reached the late tokenIds on the largest chain.
   */
  /** Hot tier: in-range positions worth ≥ POSITION_FEE_HOT_MIN_USD. */
  @Prop({ type: String, default: '' })
  feeCursorHot?: string;

  @Prop({ type: Date })
  feeHotStartedAt?: Date;

  @Prop({ type: Date })
  feeHotFinishedAt?: Date;

  /** Full tier: every active position. */
  @Prop({ type: String, default: '' })
  feeCursorAll?: string;

  @Prop({ type: Date })
  feeAllStartedAt?: Date;

  @Prop({ type: Date })
  feeAllFinishedAt?: Date;

  /*
   * The pass in progress's counts (or the last pass's, once finished): reset by
   * the pass's first page, `$inc`'d by every later one, so the end-of-pass line
   * and its alerts are right across restarts — the in-process tally they
   * replaced started at zero after every deploy. A page HELD BACK because the
   * RPC left rows unanswered is counted on the attempt that advances past it.
   */
  @Prop({ type: FeePassTallyDef })
  feeHotTally?: Record<string, number>;

  @Prop({ type: FeePassTallyDef })
  feeAllTally?: Record<string, number>;

  /*
   * The last COMPLETE pool-sync walk of this shard (2026-10-03): how many
   * pools it saw, their summed trusted TVL (`metrics.tvlUsd` as that walk
   * computed it; a pool whose pricing threw that walk counts 0 and is in
   * `poolWalkSkipped`), and when it finished. Written once per complete walk
   * (`SyncRepository.recordPoolWalk`), never by a partial one; read by
   * `/v1/stats` so its pool count and TVL cost no pools read at all. Every
   * field DECLARED — strict mode drops an undeclared `$set` path.
   */
  @Prop({ type: Number })
  poolWalkPools?: number;

  @Prop({ type: Number })
  poolWalkTvlUsd?: number;

  @Prop({ type: Number })
  poolWalkSkipped?: number;

  @Prop({ type: Date })
  poolWalkFinishedAt?: Date;

  /*
   * P2.5 tokenId range walk (`BACKFILL_PAGING=tokenid`; SyncService +
   * `SyncRepository.saveBackfillTokenId*`). Present only while a tokenId run is
   * in progress; `clearBackfillTokenIdState` unsets all three at run end.
   * `backfillTokenIdCursor` is a DECIMAL STRING — tokenIds are uint256 and a
   * Number would round them. Every field declared (strict mode).
   */
  @Prop({ type: String })
  backfillPaging?: string;

  @Prop({ type: String })
  backfillTokenIdCursor?: string;

  /** The tokenId run's start, unix SECONDS (the completeness tail walks createdAt ≥ this − 1 h). */
  @Prop({ type: Number })
  backfillRunStartTs?: number;

  /**
   * P2.3 read overlay (design §4.6): the START of the last refresh whose stale
   * sweep ran. With `POSITIONS_WRITE_SKIP=on` the served `lastSyncedAt` /
   * `pricing.pricedAt` of a clean active row is overlaid from this.
   */
  @Prop({ type: Date })
  lastCleanRefreshAt?: Date;

  /**
   * P2.4 (design §5.4): the END of the last refresh with no failed chunk —
   * the input of `[alert] positions.refresh_overdue`. Written only while the
   * write budget is on (`WRITE_BUDGET_MODE` observe / enforce).
   */
  @Prop({ type: Date })
  lastRefreshOkAt?: Date;

  /**
   * P3 fee-worker fence (design §9.5): the highest `fee-worker` lease fence
   * that wrote this shard's fee cursor / tally. A write carrying a LOWER fence
   * (a deposed holder) is refused (`SyncRepository.saveFeeCursor` → false).
   */
  @Prop({ type: Number })
  feeFence?: number;
}

export type SyncCursorDocument = HydratedDocument<SyncCursor>;
export const SyncCursorSchema = SchemaFactory.createForClass(SyncCursor);
SyncCursorSchema.index({ chainId: 1, protocol: 1 }, { unique: true });
