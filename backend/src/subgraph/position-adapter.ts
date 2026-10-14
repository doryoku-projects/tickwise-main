import type { IntegrationConfig } from '../config/integrations.config.js';
import type {
  FetchAllPositionTransactionsResult,
  FetchPositionTransactionsResult,
  FetchPositionsResult,
  NormalizedPosition,
  NormalizedPositionTransaction,
  TransactionWalkCursor,
} from './normalized-position.js';

export interface FetchPositionsOptions {
  integration: IntegrationConfig;
  cursorTimestamp: number;
  cursorPositionId?: string;
  pageSize: number;
  maxPages: number;
  normalizationConcurrency?: number;
  mode?: 'backfill' | 'refresh';
  positionIds?: string[];
  latestOnlyLimit?: number;
  flushThreshold?: number;
  /**
   * When true, the adapter skips its per-page `prefetchPrices` call. The
   * caller is expected to have already warmed the in-memory pricing cache
   * with the full set of unique token addresses across all chunks. Used by
   * `runRefresh` to share a single prefetch across N parallel chunks.
   */
  skipPrefetch?: boolean;
  /**
   * Optional upper bound on `createdAtTimestamp` (exclusive). Set by the
   * parallel-bucket backfill path so each bucket walks a non-overlapping
   * time range. Adapter switches to a range-aware subgraph query when set.
   */
  maxTimestamp?: number;
  onFlush?: (positions: NormalizedPosition[], cursor: { maxTimestamp: number; maxPositionId: string; maxBlockNumber: number }) => Promise<number>;
  /**
   * Stops the walk between pages (the process-wide `shutdownSignal()`): no new
   * page is fetched, the rows already collected are returned unflushed (the
   * caller flushes its residual as usual) and `hasMore` is true, so the
   * backfill flag stays set and the next boot resumes. Unset = today (the walk
   * runs until the process dies).
   */
  signal?: AbortSignal;
  /**
   * How a BACKFILL walks the indexer (`BACKFILL_PAGING`). `offset` (default) =
   * today's `createdAtTimestamp_gte` + growing `skip`. `tokenid` is served by
   * `walkTokenIdRanges`, not by `fetchPositions`; the field exists so a caller
   * can say which mode a run is in (profile/status) without a second type.
   */
  paging?: 'offset' | 'tokenid';
  /**
   * P3.1 (`BACKFILL_FEE_READ=on`): take the first on-chain fee reading of each
   * page's ACTIVE rows inside the walk (`PageFeeReader`), so a freshly
   * backfilled position serves `onchain` fees instead of "Pending". Ignored by
   * a refresh walk and when the adapter has no reader.
   */
  feeRead?: boolean;
  /**
   * `fetchPositionTransactions` only: read the NEWEST transactions first, so a
   * one-page read is the position's latest activity rather than its oldest. The
   * list still comes back oldest-first, and `truncated` then means the OLDEST
   * rows may be missing. Meant for that one-page head read (the detail/charts
   * path in `chart-inputs.service.ts`); only `EnvioAdapter` implements it, and
   * an adapter that does not ignores it — callers must check the adapter.
   */
  newestFirst?: boolean;
}

/**
 * Per-range timings and counters a tokenId range walk hands its writer, for
 * the `[backfill-profile]` line (`sync/backfill-profile.ts`). Milliseconds are
 * wall time of that stage for THIS range; with lookahead the stages of
 * different ranges overlap, so they do not sum to the run's wall time.
 */
export interface TokenIdRangeStats {
  /** Positions page(s) for the range. */
  pageMs: number;
  /** Pools (static + tick/sqrtPrice + poolStats) for the range. */
  dynMs: number;
  /** Token metadata (run-cache misses only, with the pipeline on). */
  tokensMs: number;
  /** Price prefetch wall time (may outlive the range's wait deadline). */
  priceMs: number;
  /** How long normalize actually waited for prices (≤ BACKFILL_PRICE_WAIT_MS). */
  priceWaitMs: number;
  /** True when the range normalized at the deadline with the prefetch still running. */
  priceDeadlineHit: boolean;
  /** P3.1 on-chain fee read for the range's active rows. */
  feeReadMs: number;
  normalizeMs: number;
  /** Rows the indexer returned for the range. */
  rows: number;
  /** Extra pages fetched because a range came back full (`range_overflow`). */
  overflowPages: number;
  /** Closed rows inserted with an unpriced held leg, per token address. */
  unpricedClosed: Map<string, number>;
  /** Active rows the P3.1 read measured fresh (stamp carried). */
  feesMeasured: number;
}

/** One tokenId range `[from, to)` (decimal strings; tokenIds are uint256). */
export interface TokenIdRange {
  /** Inclusive start. */
  from: string;
  /** Exclusive end — also the contiguous cursor once this range is flushed. */
  to: string;
  /** 0-based position of the range in this walk. */
  index: number;
}

export interface TokenIdWalkOptions {
  integration: IntegrationConfig;
  /** Inclusive tokenId the first range starts at (decimal string, '0' = from the start). */
  fromTokenId: string;
  /**
   * Ids per range. Default `INDEXER_PAGE_MAX - 1` (999): with `first: 1000`
   * a FULL page then proves more rows than ids (`range_overflow`) without a
   * second request — a 1000-id range that is simply dense would come back
   * full too, and could only be told apart by asking again.
   */
  rangeSize?: number;
  /** Ranges prepared ahead of the one being written (`BACKFILL_LOOKAHEAD_PAGES`, 0 = serial). */
  lookahead: number;
  normalizationConcurrency?: number;
  /** Run-scoped entity caches + per-range combined pool request + price deadline (`BACKFILL_PIPELINE`). */
  pipeline: boolean;
  /** Price deadline per range with the pipeline on (`BACKFILL_PRICE_WAIT_MS`). */
  priceWaitMs: number;
  /** P3.1 fee read for the active rows (`BACKFILL_FEE_READ`). */
  feeRead: boolean;
  /** Checked between ranges: no new range starts once it is aborted. */
  signal?: AbortSignal;
  /**
   * THE ordered writer: called once per range, strictly in range order, never
   * concurrently. Returns the number of rows written.
   */
  onRange: (positions: NormalizedPosition[], range: TokenIdRange, stats: TokenIdRangeStats) => Promise<number>;
  /**
   * Called after `onRange` resolved, with the new CONTIGUOUS cursor: the
   * exclusive end of the highest range such that it and every range before it
   * were written. It never passes an unwritten range.
   */
  onCursor?: (nextTokenId: string) => Promise<void>;
}

/**
 * A tokenId EDGE read failed — the lowest tokenId created since T (the
 * conversion of an interrupted offset walk) or the highest tokenId (the walk's
 * end). Thrown BEFORE the walk writes anything, so the caller can fall back to
 * the offset walk for the run instead of failing every retry the same way:
 * neither edge query has a `(chainId, tokenId)` index on Envio's shared
 * multi-chain Position table, and a background timeout would otherwise strand
 * the run.
 */
export class TokenIdEdgeQueryError extends Error {
  readonly tokenIdEdge = true;
  constructor(which: 'first-since' | 'max', cause: unknown) {
    super(`tokenId edge query (${which}) failed: ${(cause as Error)?.message ?? String(cause)}`);
    this.name = 'TokenIdEdgeQueryError';
  }
}

export function isTokenIdEdgeQueryError(err: unknown): err is TokenIdEdgeQueryError {
  return err instanceof TokenIdEdgeQueryError || (err as { tokenIdEdge?: unknown } | null)?.tokenIdEdge === true;
}

export interface TokenIdWalkResult {
  /** Exclusive end of the last contiguous written range (= `fromTokenId` when nothing was written). */
  nextTokenId: string;
  /** Walked past the indexer's highest tokenId (re-read once at the end). False when aborted. */
  completed: boolean;
  /** Stopped by `signal`. */
  aborted: boolean;
  ranges: number;
  rows: number;
  written: number;
  /** max(createdAtTimestamp, positionId) over the written rows — the cursor the run ends on. */
  maxTimestamp: number;
  maxPositionId: string;
  maxBlockNumber: number;
}

/**
 * Total time range of the integration's position history. Used by the
 * parallel-bucket backfill path to divide work across N concurrent walkers.
 */
export interface PositionTimestampRange {
  minTimestamp: number;
  maxTimestamp: number;
}

/**
 * Options for the cursor-driven walk of all `positionTransactions` ascending
 * by `(timestamp, transactionId)`. Mirrors `FetchPositionsOptions` so the
 * transaction flush pipeline is structurally identical to positions backfill.
 */
export interface FetchAllPositionTransactionsOptions {
  integration: IntegrationConfig;
  cursorTimestamp: number;
  cursorTransactionId: string;
  pageSize: number;
  maxPages: number;
  flushThreshold: number;
  /**
   * Optional upper bound on transaction `timestamp` (exclusive). Set by the
   * parallel-bucket transaction backfill so each bucket walks a
   * non-overlapping time range. Adapter switches to a range-aware subgraph
   * query when set.
   */
  maxTimestamp?: number;
  onFlush: (
    transactions: NormalizedPositionTransaction[],
    cursor: TransactionWalkCursor,
  ) => Promise<number>;
}

/**
 * Pool snapshot at a specific timestamp. Used by historical pricing to derive
 * the USD price of a long-tail token from the pool ratio + the priced anchor
 * side (USDC/USDT/WETH).
 */
export interface PoolSnapshot {
  poolId: string;
  timestamp: number;
  sqrtPriceX96: string;
  tick: number;
  token0PriceUsd: number;
  token1PriceUsd: number;
}

export interface FetchPoolSnapshotsOptions {
  integration: IntegrationConfig;
  poolId: string;
  fromTimestamp: number;
  toTimestamp: number;
}

export interface PositionAdapter {
  readonly protocol: string;
  /**
   * How positions from this adapter get their performance metrics recomputed.
   * `'transactions'` (default) → re-derive from the per-tx history (vanilla
   * subgraph). `'aggregates'` → derive vs-HODL metrics from the position-row
   * cashflow aggregates the indexer already provides, needing no tx
   * history. The live-refresh / sync paths branch on this.
   */
  readonly recomputeMode?: 'transactions' | 'aggregates';
  fetchPositions(options: FetchPositionsOptions): Promise<FetchPositionsResult>;
  fetchPositionTransactions?(
    options: FetchPositionsOptions,
  ): Promise<FetchPositionTransactionsResult>;
  /**
   * Cursor-walk of ALL position transactions for the integration, ascending
   * by `(timestamp, transactionId)`. Optional — adapters that can't expose a
   * monotonic ascending feed should omit this and rely on the per-position
   * `fetchPositionTransactions` path.
   */
  fetchAllPositionTransactions?(
    options: FetchAllPositionTransactionsOptions,
  ): Promise<FetchAllPositionTransactionsResult>;
  /**
   * Pool snapshot range for historical price derivation. Returns snapshots
   * sorted ascending by timestamp within `[fromTimestamp, toTimestamp]`.
   * Used by the historical pricing chain to derive a long-tail token's USD
   * from the pool ratio + the anchored side. Optional — adapters that don't
   * expose pool snapshots should omit this.
   */
  fetchPoolSnapshots?(
    options: FetchPoolSnapshotsOptions,
  ): Promise<PoolSnapshot[]>;
  /**
   * Min + max `createdAtTimestamp` across all positions for this integration.
   * Powers parallel-bucket backfill: caller divides `[min, max]` into N
   * equal slices and walks each slice with its own cursor. Optional — adapters
   * that omit this fall back to the serial cursor walk.
   */
  fetchPositionTimestampRange?(
    integration: IntegrationConfig,
  ): Promise<PositionTimestampRange>;
  /**
   * `BACKFILL_PAGING=tokenid`: a full walk of the integration's positions in
   * fixed `tokenId` ranges, served by the indexer's single-column `tokenId`
   * index (no `skip` that grows with the run, no sort on an unindexed column).
   * Ranges may be prepared in parallel; they are written in order. Optional —
   * an adapter without it keeps the offset walk.
   */
  walkTokenIdRanges?(options: TokenIdWalkOptions): Promise<TokenIdWalkResult>;
  /**
   * P3.1 (`BACKFILL_FEE_READ`): whether a page fee reader is bound. `false` =
   * the flag would be a silent no-op, so the caller warns and runs without it.
   * Optional — an adapter without it never reads fees inside the walk.
   */
  pageFeeReaderBound?(): boolean;
  /**
   * The smallest tokenId among positions created at or after `timestamp`, or
   * `null` when none is. Starts the conversion of an interrupted OFFSET walk:
   * every row the offset walk had not reached has `createdAt ≥ timestamp`, so
   * none has a lower tokenId than this one.
   */
  findFirstTokenIdCreatedSince?(integration: IntegrationConfig, timestamp: number): Promise<string | null>;
  /**
   * Min + max `timestamp` across all positionTransactions. Powers
   * parallel-bucket transaction backfill: caller divides `[min, max]` into
   * N equal slices and walks each slice independently.
   */
  fetchTransactionTimestampRange?(
    integration: IntegrationConfig,
  ): Promise<PositionTimestampRange>;
}
