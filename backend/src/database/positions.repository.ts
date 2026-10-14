import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import mongoose, { type Model, type PipelineStage } from 'mongoose';
import { PageLadderService } from '../common/cache/page-ladder.js';
import { readPathMeter } from '../common/cache/read-path-meter.js';
import { ReadPathRedis } from '../common/cache/read-path-redis.js';
import {
  LIST_CACHE_JITTER,
  listCacheTtl,
  listWindowRows,
  stableKey,
  staleSince,
  stalenessBudgetMs,
  SwrCache,
  type CacheStatus,
} from '../common/cache/swr-cache.js';
import { deepReadError, serveDeepPage } from '../common/deep-page.js';
import { ReadBudgetService, ReadBudgetTimeoutError } from '../common/read-budget.js';
import { compareNumericString, compareSortValue, valueAtPath } from '../common/shard-merge.js';
import {
  arraySource,
  rowsAfter,
  seekSegments,
  segmentedSource,
  type DeepShard,
  type MergeSource,
  type SortBoundary,
  type SortSpec,
} from '../common/shard-stream-merge.js';
import { AppConfigService } from '../config/app-config.service.js';
import { processWriteBudget, type WriteBudgetConfigView } from '../common/write-budget.js';
import { effectiveChunkOps, WRITE_BUDGET_OFF, WRITE_UNITS, type WriteBudgetSettings } from '../common/write-budget-model.js';
import { explicitWriteLane } from '../common/write-lane.js';
import { BUDGETED_CHUNK_TIMEOUT_MS, budgetedBulkWrite, budgetedWrite, chargePrimaryRead } from './budgeted-write.js';
import {
  bucketAgeSeconds,
  changeReasons,
  declaredLeavesOf,
  decodeWh,
  diffSections,
  encodeWh,
  fullWriteReason,
  IDENTITY_FIELDS,
  SECTIONS,
  sectionOfField,
  sectionUpdateParts,
  sectionValue,
  sectionValues,
  SKIP_CHUNK_OPS,
  STAMP_FIELDS,
  storedImpliedEthPrice,
  SUBDOC_FIELDS,
  valueBucket,
  writeSkipSettings,
  type FullWriteReason,
  type NextWriteState,
  type Section,
  type StoredWriteState,
  type SubdocField,
  type WriteSkipConfigSource,
  type WriteSkipMode,
  type WriteSkipSettings,
} from './position-write-hash.js';
import {
  Position,
  PositionSchema,
  type PositionDocument,
  type PositionTxSyncStatus,
} from './schemas/position.schema.js';
import {
  clusterTimestamp,
  isMaxTimeMSExpired,
  isMissingHintError,
  isSnapshotReadError,
  isUnsupportedHintError,
  QUERY_TIMEOUT_RETRY_AFTER_SECONDS,
  QueryTimeoutException,
  READ_MAX_TIME_MS,
  SECONDARY_ONLY_READ_PREFERENCE,
  SnapshotUnavailableError,
  USER_READ_PREFERENCE,
} from './user-read.js';
import type { NormalizedPosition } from '../subgraph/normalized-position.js';
import {
  computePerformanceFromAggregates,
  refreshPerformanceFromStoredCashFlows,
  type PositionPerformanceUpdate,
} from '../positions/position-performance.js';
import type { FeeServedState, RpcFees } from '../sync/position-fee-math.js';
import { resolveTokenTrust, trustPolicyOf, usesStoredVerdicts, type TrustPolicy } from '../pricing/token-trust.js';
import { anchorAddresses, DYNAMIC_FEE_FLAG, HONEYPOT_FEE_MIN_PIPS } from '../common/pool-fee.js';
import { CollectionResolver } from './collection-resolver.js';
import { userReadLagMs } from './replication-lag.js';
import { TokensRepository } from './token.repository.js';
import { equityAddresses } from '../pricing/tokenized-equities.js';
import { RANK_EXCLUSION_PLACEHOLDER } from '../read-models/rank/rank-query.js';

export interface LeaderboardQuery {
  chainId: number;
  protocol: string;
  sort: string;
  page: number;
  limit: number;
  activeOnly: boolean;
  status?: 'active' | 'inactive' | 'all';
  range?: string;
  minValueUsd: number;
  minPoolTvl: number;
  includeRisky: boolean;
  positionId?: string;
  poolId?: string;
  owner?: string;
  /** `equity` restricts to positions whose pool has a tokenized-equity leg. */
  assetClass?: 'equity';
}

const SORT_FIELD_MAP: Record<string, string> = {
  apr: 'metrics.aprExGas',
  fee_apr: 'metrics.feeApr',
  roi: 'metrics.roi',
  // Newest first, on every status (product decision, 2026-10-02). It used to
  // be `metrics.ageSeconds` ascending — the same order for open rows, but
  // `ageSeconds` is re-stamped on every write (so an index on it is rewritten on
  // every reprice) and a CLOSED row's age stops at its close, which ordered the
  // Closed/All tabs by holding period rather than by age. `createdAtTimestamp`
  // never changes, and `lbr_created` serves it. `metrics.ageSeconds` is still
  // returned in every response.
  age: 'createdAtTimestamp',
  pnl: 'metrics.poolPnlUsd',
  underlying_value: 'metrics.underlyingValueUsd',
  nft_id_asc: 'tokenId',
  nft_id_desc: 'tokenId',
};

/**
 * The Set R index each ranked sort walks (built by
 * `scripts/positions-index-migration.mjs`, declared in `position.schema.ts`).
 * Every one is `{chainId, protocol, <sort field>, positionId, …}` under the
 * leaderboard collation, so the planner reads the page straight off the index
 * in order — no SORT stage — and applies `isActive` / `metrics.inRange` /
 * `metrics.underlyingValueUsd` to index keys before fetching. The rate-sort
 * indexes are PARTIAL on `{isActive: true}`, so they are hinted only when the
 * filter carries that exact equality (see `rankedHint`).
 */
const RATE_SORT_INDEX: Record<string, string> = {
  apr: 'lbr_apr_active',
  fee_apr: 'lbr_feeapr_active',
  roi: 'lbr_roi_active',
};
const FULL_SORT_INDEX: Record<string, string> = {
  pnl: 'lbr_pnl',
  underlying_value: 'lbr_value',
  age: 'lbr_created',
  // `lbr_tokenid` is `{tokenId: 1, positionId: 1}`: read forwards for asc,
  // backwards for desc — which is why the nft tie-break follows the primary
  // direction (`tieDirectionFor`).
  nft_id_asc: 'lbr_tokenid',
  nft_id_desc: 'lbr_tokenid',
};
/** The count's index when the filter bounds the value (see `countHint`). */
const VALUE_INDEX = 'lbr_value';
/**
 * The full-sort indexes whose KEY carries `metrics.underlyingValueUsd`, so a
 * value floor is checked on index keys without a fetch. `lbr_created` and
 * `lbr_tokenid` deliberately do not carry it — the value changes on every
 * reprice, and those two are otherwise never rewritten — so on them a floor
 * costs one FETCH per walked row (see `rankedHint`).
 */
const VALUE_KEYED_SORT_INDEXES: ReadonlySet<string> = new Set(['lbr_pnl', 'lbr_value']);

/** Background-reader indexes (partial on `{isActive: true}`, simple collation). */
export const BG_ACTIVE_WALK_INDEX = 'bg_active_walk';
const BG_ACTIVE_TOKEN_INDEX = { token0: 'bg_active_token0', token1: 'bg_active_token1' } as const;
/**
 * `{chainId, protocol, isActive, poolId, owner}`, partial on actives: every
 * read of a pool's OPEN positions — the pool modal (status Active) and the
 * pools list's holder counts. Locally its predecessor `bg_active_pool`
 * (`{…, poolId}`) read 870 keys for the 870 open positions of the largest
 * chain-1 pool where the full `poolId` index read 12,053 (and 1,758 vs 67,602
 * on 42161). `owner` is in the key since 2026-10-03 (scale plan 1.10) so the
 * holder count's `$group` (`$addToSet: '$owner'`) reads index keys only: on
 * the M10 rig the 25 largest chain-1 pools' counts fetched 7,228 documents
 * (469 ms) through `bg_active_pool`; the same shape over an index carrying
 * both grouped fields reads keys and fetches 0.
 */
const BG_ACTIVE_POOL_INDEX = 'bg_active_pool_owner';
/**
 * The pool index before 2026-10-03, `{chainId, protocol, isActive, poolId}`:
 * no longer declared, and dropped by the migration's `--drop-legacy` once
 * `$indexStats` shows it unused. Still the first fallback while it exists (a
 * shard where `--apply` has not built `bg_active_pool_owner` yet).
 */
const LEGACY_BG_ACTIVE_POOL_INDEX = 'bg_active_pool';

/** Ids per stale-sweep `updateMany` (`markMissingStale`): a bounded `$in`, never a 16 MB `$nin`. */
export const STALE_SWEEP_CHUNK = 500;
/** Index keys per batch of the stale sweep's covered active-id walk. */
const STALE_SWEEP_BATCH = 5_000;

const PERFORMANCE_SORTS = new Set(['apr', 'fee_apr', 'roi', 'pnl']);
// RATE sorts rank by an annualized/relative rate that only exists while a
// position is open and holding value. Closed / no-current-value rows have no
// meaningful rate (the UI dashes them), so they are excluded from these sorts
// rather than ranked at the top by a stale stored rate. PnL is intentionally
// NOT here — closed positions carry realized PnL and belong in a PnL sort.
const RATE_SORTS = new Set(['apr', 'fee_apr', 'roi']);

/**
 * The sort a list request is actually served with. The Closed tab
 * (`status=inactive`) asked for a rate sort is served as `pnl`: a closed
 * position has no current rate (the dashboard renders "–" in all three
 * columns), so ranking by one orders rows by stale stored figures, and it was
 * the one ranked shape with no usable index — the rate-sort indexes are
 * partial on `{isActive: true}` and may not be hinted for `isActive: false`
 * (see `rankedHint`), so it ran a blocking SORT (14 s on chain 1 locally) and
 * answered 503. `pnl` is the closed rows' own ranking and walks `lbr_pnl`.
 * Applied ONCE, at the service entry, so the shard reads, the all-chains merge
 * and the count key all see the same sort.
 */
export function effectiveLeaderboardSort(status: string | undefined, sort: string): string {
  return status === 'inactive' && RATE_SORTS.has(sort) ? 'pnl' : sort;
}

/**
 * The honeypot-fee rule (`HONEYPOT_FEE_FILTER=on`): a pool whose STATIC LP fee
 * is ≥ 5% (50,000 pips) — the spam pools sit at 99.99% / 99.5% (AERGO/HPP
 * 366810 and 338786) — has its positions leave every ranked list and count.
 * `0x800000` and above is v4's dynamic-fee FLAG, not a fee, and is exempt. The
 * constants live in common/pool-fee.ts, shared with `pools-sync`'s
 * `evaluatePoolTvl` (see there for the few real pools above 5%). Read off the
 * position's own stored `fee` (written on every normalize), so it needs no
 * re-sync and no index: a residual predicate on whatever index the shape
 * already reads.
 */
export { HONEYPOT_FEE_MIN_PIPS, DYNAMIC_FEE_FLAG };

/**
 * The clause that KEEPS a row: a fee below the floor, the dynamic-fee flag, or
 * no fee stored at all (null / missing — never excluded on absent evidence).
 * Three single-atom branches, so the rank engine compiles it as one clause.
 *
 * `anchorExempt` (`HONEYPOT_FEE_ANCHOR_EXEMPT=on`) adds a fourth branch: both
 * legs in the chain's config anchors (`anchorAddresses`, the list
 * `isAnchorTokenStandalone` accepts — the pools sync's `isAnchorPair`), so a
 * real ETH/USDC pool at 6% keeps its positions. The `$in` shape mirrors the
 * equity filter's (stored addresses are lowercased); a missing / null address
 * is never a member, so that branch cannot keep a row on absent evidence. The
 * rank engine distributes it into two clauses (`rank-query.ts`). Without the
 * exemption — or on a chain with no anchors — the object is EXACTLY today's:
 * the count keys and the read models' compiled plans are built from it.
 */
export function honeypotFeeClause(chainId?: number, anchorExempt = false): Record<string, unknown> {
  const keep: Record<string, unknown>[] = [{ fee: { $lt: HONEYPOT_FEE_MIN_PIPS } }, { fee: { $gte: DYNAMIC_FEE_FLAG } }, { fee: null }];
  const anchors = anchorExempt && chainId !== undefined ? anchorAddresses(chainId) : [];
  if (anchors.length > 0) keep.push({ 'token0.address': { $in: anchors }, 'token1.address': { $in: anchors } });
  return { $or: keep };
}

/** `HONEYPOT_FEE_FILTER`, read structurally: a config without the getter is today's behaviour (off). */
function honeypotFeeFilterOn(config: unknown): boolean {
  return (config as { honeypotFeeFilter?: unknown } | undefined)?.honeypotFeeFilter === 'on';
}

/** `HONEYPOT_FEE_ANCHOR_EXEMPT`, read the same way (absent = off = today). */
function honeypotFeeAnchorExemptOn(config: unknown): boolean {
  return (config as { honeypotFeeAnchorExempt?: unknown } | undefined)?.honeypotFeeAnchorExempt === 'on';
}

/**
 * Exactly the fields the leaderboard row mapper and `sanitizeStoredPosition`
 * read (plus every sort key, which the all-chains merge compares). Everything
 * else on the document — `rawSubgraph` (~714 B), `tx*`, `rpcFees*`,
 * `staleMisses`, `lastVerifiedAt`, `_id`, `__v` — never leaves Mongo on a list
 * read.
 */
export const LIST_PROJECTION = {
  _id: 0,
  chainId: 1,
  protocol: 1,
  positionId: 1,
  tokenId: 1,
  owner: 1,
  poolId: 1,
  token0: 1,
  token1: 1,
  fee: 1,
  tickSpacing: 1,
  tickLower: 1,
  tickUpper: 1,
  currentTick: 1,
  liquidity: 1,
  isActive: 1,
  createdAtTimestamp: 1,
  closedAtTimestamp: 1,
  amounts: 1,
  metrics: 1,
  poolStats: 1,
  pricing: 1,
  lastSyncedAt: 1,
} as const;

/**
 * The top-level fields a position DETAIL response may carry: the stored
 * document minus its internal bookkeeping. An ALLOW-list on purpose — a field
 * added to the schema later stays internal until somebody lists it here. The
 * detail mapper picks exactly these, so the projection is an efficiency and
 * the mapper is the guarantee.
 */
export const DETAIL_FIELDS = [
  ...(Object.keys(LIST_PROJECTION).filter((key) => key !== '_id') as Array<keyof typeof LIST_PROJECTION>),
  'sqrtPriceX96',
  'createdAt',
  'updatedAt',
] as const;

export const DETAIL_PROJECTION: Record<string, 0 | 1> = {
  _id: 0,
  ...Object.fromEntries(DETAIL_FIELDS.map((field) => [field, 1])),
};

/**
 * `LIST_PROJECTION` / `DETAIL_PROJECTION` plus `staleMisses`, used ONLY while
 * `POSITIONS_WRITE_SKIP=on` (`PositionsRepository.listProjection` /
 * `detailProjection`): the read-time overlay (`positions/served-clock-overlay.ts`)
 * overlays `lastSyncedAt` / `pricing.pricedAt` only on active rows with
 * `staleMisses == 0`, and strips the field before the row is served.
 */
export const LIST_OVERLAY_PROJECTION = { ...LIST_PROJECTION, staleMisses: 1 } as const;
export const DETAIL_OVERLAY_PROJECTION: Record<string, 0 | 1> = { ...DETAIL_PROJECTION, staleMisses: 1 };

/**
 * What a position write tells the on-chain fee store (P3.3, design §9.2
 * "Writer hints"): the fee-relevant fields of each row a write stored. A
 * closure hint (`markMissingStale`) carries only `positionId`, `isActive:
 * false` and `wAt`. `rpc` is set only when this write stored a P3.1 stamp.
 */
export interface FeeRowHint {
  positionId: string;
  isActive: boolean;
  /** Writer time (ms): newer-wins against a store row. */
  wAt: number;
  tokenId?: string;
  poolId?: string;
  tickLower?: number;
  tickUpper?: number;
  lastModifyBlock?: number;
  decimals0?: number;
  decimals1?: number;
  price0?: number;
  price1?: number;
  isPriceable?: boolean;
  feesSource?: string;
  pendingFeesUsd?: number;
  rpc?: { fees0: string; fees1: string; block: number; at?: Date };
}

/**
 * Receives the position writes (bound by the integrator to the fee package's
 * hint publisher; absent = nobody listens). Called synchronously after a write
 * resolved; must not throw (a throw is logged and ignored) and must not block.
 */
export interface PositionWriteObserver {
  /** After each `upsertMany` chunk (rows written, not skipped) and each stale-sweep closure. */
  onWritten(chainId: number, protocol: string, rows: readonly FeeRowHint[]): void;
  /**
   * Rows whose carried P3.1 reading was NOT newer than the stored stamp (the
   * stamp was not written, design §4.2 rule 5): re-read them on the BACKFILL
   * lane (`markDirty(…, {lane:'backfill'})` with no block = always re-read).
   */
  onFeeReread?(chainId: number, protocol: string, positionIds: readonly string[]): void;
}

/** Injection token of the `PositionWriteObserver` (a string, like `PAGE_FEE_READER`). */
export const POSITION_WRITE_OBSERVER = 'POSITION_WRITE_OBSERVER';

/**
 * What `ChartsService.getPositionCharts` reads off the position: range, ticks,
 * pool, token addresses/decimals/prices, liquidity, gas and pending fees — plus
 * identity, ownership and the cash-flow amounts a charts input cache can
 * fingerprint the position by.
 */
export const CHARTS_PROJECTION = {
  _id: 0,
  chainId: 1,
  protocol: 1,
  positionId: 1,
  tokenId: 1,
  owner: 1,
  poolId: 1,
  isActive: 1,
  liquidity: 1,
  currentTick: 1,
  tickLower: 1,
  tickUpper: 1,
  tickSpacing: 1,
  createdAtTimestamp: 1,
  'token0.address': 1,
  'token0.decimals': 1,
  'token0.priceUsd': 1,
  'token1.address': 1,
  'token1.decimals': 1,
  'token1.priceUsd': 1,
  amounts: 1,
  'metrics.totalGasCostUsd': 1,
  'metrics.pendingFeesUsd': 1,
} as const;

/** Index names, as Mongoose derives them from `position.schema.ts`. */
const POOL_ID_INDEX = 'chainId_1_protocol_1_poolId_1';
const OWNER_INDEX = 'chainId_1_protocol_1_owner_1';
const POSITION_ID_INDEX = 'chainId_1_protocol_1_positionId_1';

/** The numericOrdering collation every ranked leaderboard query runs with. */
export const LEADERBOARD_COLLATION = { locale: 'en', numericOrdering: true } as const;

/** The part of the driver's `Db` the raw snapshot reads use (P-R R3). */
interface NativeDb {
  command(command: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
}

/** A rank engine lane-A reference read (P-R R3): one shard's first rows `{positionId, value}` and its count, at a clusterTime. */
export interface PositionsSnapshotReference {
  rows: Array<{ positionId: unknown; tokenId?: unknown; value: unknown }>;
  /** Capped like `countDocuments({limit: cap})` for a collated shape; the exact match count for an uncollated one. */
  count: number;
}

/**
 * Per-shard window cache: fresh 15 s, served stale up to 30 s while refreshing
 * (`listCacheTtl` — the staleness budget; it was 30 s / 5 min).
 *
 * A window kept past its stale age only to answer a database timeout — and
 * then served FLAGGED (`dataAsOf` on the page → `stale: true` + `dataAsOf` in
 * the response), because it is older than the budget allows unflagged.
 */
const WINDOW_FALLBACK_MS = 30 * 60_000;
const DEFAULT_WINDOW_CACHE_BYTES = 64 * 1024 * 1024;

/** Retained past the stale age, so a timed-out aggregation answers from it (flagged, like a window). */
const POOL_COUNTS_FALLBACK_MS = 30 * 60_000;
/**
 * Read budget a pool-count aggregation on the REQUEST path may wait for: a
 * page whose rows are in hand does not wait on a holder count — past this it
 * answers null and counts in the background, as on a timeout.
 */
const POOL_COUNTS_BUDGET_WAIT_MS = 1_000;
/** Rows reserved per pool with no count known yet. */
const POOL_COUNTS_DEFAULT_COST = 100;

/** Sort-key rows per batch of a deep-page cursor (`walkDeepPage`). */
const DEEP_BATCH_ROWS = 5_000;
/**
 * The budget of a pool-counts aggregation run OFF the request path (a stale or
 * timed-out pool's refresh): long enough for the heaviest pools on the largest
 * shard, which can never answer inside the request's 3 s.
 */
const POOL_COUNTS_BACKGROUND_MAX_TIME_MS = 20_000;
/** Background pool-count batches in flight at once, per process. */
const MAX_POOL_COUNT_REFRESHES = 2;

/**
 * A ranked window whose request-path read timed out with nothing retained is
 * read ONCE more in the background with this budget, so the next request is a
 * hit instead of the same doomed 5 s read and the same 503 forever (before the
 * Set R indexes, the ranked landing query measured 6.5–8 s in prod).
 */
const WINDOW_RESCUE_MAX_TIME_MS = 30_000;
/** Rescue reads in flight at once, per process: each is one heavy secondary query. */
const MAX_WINDOW_RESCUES = 2;
/** A window whose rescue also timed out is not rescued again for this long. */
const WINDOW_RESCUE_FAILED_MS = 10 * 60_000;
/** While a rescue is under way, the 503 tells the client to come back about when it lands. */
const RESCUE_RETRY_AFTER_SECONDS = 15;
/** After a rescue failed too, the timeout is deterministic for now: a longer wait. */
const RESCUE_FAILED_RETRY_AFTER_SECONDS = 60;

/** A shard found missing a hinted index is queried unhinted, and rechecked after this long. */
const MISSING_HINT_RECHECK_MS = 10 * 60_000;

/**
 * The index a hint falls back to when the shard lacks it, before giving up and
 * running unhinted. Left to the planner, the active pool-scope shapes have
 * been seen winning on the `isActive` index and walking every active position
 * of the shard — so without `bg_active_pool` they keep the `poolId` hint they
 * had before it existed.
 */
const HINT_FALLBACK: Readonly<Record<string, string>> = {
  [BG_ACTIVE_POOL_INDEX]: LEGACY_BG_ACTIVE_POOL_INDEX,
  [LEGACY_BG_ACTIVE_POOL_INDEX]: POOL_ID_INDEX,
};

/**
 * Which query a leaderboard request runs, chosen BEFORE the collation:
 *  - `lookup`: an exact position/NFT id. Uncollated so the planner can OR the
 *    simple-collation `positionId` and `tokenId` indexes: 1 key / 1 ms on the
 *    local 430k-doc shard, against 70,832 keys / 19.6 s collated (it walked
 *    every active position). Deliberately NOT hinted: hinting one index forces
 *    the `tokenId` branch of the `$or` onto it — 430,000 keys / 2 s.
 *  - `pool`: one pool's positions (the pool modal). Uncollated and hinted to the
 *    simple `poolId` index — collated, the equality could not use it (19.8 s
 *    vs 26 ms end to end locally) — or, when the filter is `isActive: true`
 *    (the modal's own status), to the partial `bg_active_pool`, which reads
 *    only the open positions (falling back to `poolId` when it is missing).
 *  - `owner`: one wallet. Collated and hinted to the owner index, which carries
 *    the same collation precisely so this query can use it.
 *  - `ranked`: everything else. Collated and hinted to the sort's Set R index
 *    (`rankedHint`) — except a rate sort on the Closed tab and the tokenized-
 *    equity filter, which stay unhinted, and a minimum-value floor on the
 *    Closed tab (hinted to `lbr_value`) or the All tab (unhinted unless the
 *    sort's index carries the value).
 * The uncollated shapes cannot ORDER numeric-string ids the way the collated
 * query does, so they sort in Node with the comparator the all-chains merge
 * already uses (`leaderboardRowComparator`), keeping the order identical.
 */
export type LeaderboardShape = 'lookup' | 'pool' | 'owner' | 'ranked';

export interface LeaderboardPlan {
  chainId: number;
  protocol: string;
  shape: LeaderboardShape;
  filter: Record<string, unknown>;
  sortField: string;
  sortDirection: 1 | -1;
  /** The `positionId` tie-break's direction (`tieDirectionFor`). */
  tieDirection: 1 | -1;
  collated: boolean;
  /** The find's index. */
  hint?: string;
  /** The count's index — it has no sort to serve, so it can differ (`countHint`). */
  countHint?: string;
  /** Window cache key prefix: shard + the query actually run (never the request params). */
  key: string;
  /** Count cache key: as `key`, without the sort (a count does not depend on it). */
  countKey: string;
  /** False while the exclusion set has never loaded — results must not be cached. */
  cacheable: boolean;
  /**
   * The same filter with the exclusion list replaced by `'<excluded>'` (what
   * `countKey` is derived from): the rank engine casts and compiles THIS once
   * per key and binds the placeholder to `excluded` (P-R R3).
   */
  shapeFilter: Record<string, unknown>;
  /** The exclusion list `filter` carries (empty when the plan has none). */
  excluded: readonly string[];
}

/** A shared holder count as `publishPoolCounts` writes it; undefined when unreadable. */
function decodeSharedPoolCounts(
  raw: string | null | undefined,
): { counts: PoolPositionCounts; computedAt: number; dataAt: number } | undefined {
  if (!raw) return undefined;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const p = Number(v.p);
    const h = Number(v.h);
    const t = Number(v.t);
    const d = Number(v.d);
    if (![p, h, t].every((n) => Number.isFinite(n) && n >= 0)) return undefined;
    return {
      counts: { positionsCount: p, holdersCount: h },
      computedAt: t,
      dataAt: Number.isFinite(d) ? Math.min(d, t) : t,
    };
  } catch {
    return undefined;
  }
}

/** At most one write-invariant alert per shard this often. */
const INVARIANT_ALERT_EVERY_MS = 60_000;
/** A canonical decimal: digits only, no sign, no leading zero (but "0"). */
const CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)$/;
/**
 * The numeric fields the leaderboard RANKS on (`SORT_FIELD_MAP`, less the
 * string `tokenId`): each must be a finite number on every stored row.
 */
export const RANKED_NUMERIC_FIELDS = [
  'metrics.aprExGas',
  'metrics.feeApr',
  'metrics.roi',
  'metrics.poolPnlUsd',
  'metrics.underlyingValueUsd',
  'createdAtTimestamp',
] as const;

/**
 * The write-time invariants the read path's exactness rests on (scale plan
 * 1.10): the deep-page seek (`seekSegments`) and every future replacement for
 * `buildLeaderboardFilter` (rank engine, pool catalog) are exact for null,
 * NaN, ±Infinity and odd types only because they copy MongoDB's handling of
 * them — but those values should never be STORED in the first place:
 *  - every ranked numeric field is a finite number;
 *  - `isActive` is a boolean (the rate sorts and every `bg_*` reader match
 *    `isActive: true` exactly, so anything else silently drops the row);
 *  - `positionId` is a canonical decimal and `tokenId` equals it (the nft
 *    sorts, the lookup shape and the `$or` over both indexes assume one id).
 * Returns the rules a document to be written breaks (empty = none).
 */
export function positionWriteInvariantViolations(doc: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const field of RANKED_NUMERIC_FIELDS) {
    const value = valueAtPath(doc, field);
    if (typeof value !== 'number' || !Number.isFinite(value)) out.push(`${field}:${describeValue(value)}`);
  }
  if (typeof doc.isActive !== 'boolean') out.push(`isActive:${describeValue(doc.isActive)}`);
  if (typeof doc.positionId !== 'string' || !CANONICAL_DECIMAL.test(doc.positionId)) {
    out.push(`positionId:${describeValue(doc.positionId)}`);
  }
  if (doc.tokenId !== doc.positionId) out.push('tokenId≠positionId');
  return out;
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isNaN(value) ? 'NaN' : Number.isFinite(value) ? `number(${value})` : String(value);
  if (typeof value === 'string') return `string(${value.length > 12 ? `${value.slice(0, 12)}…` : value})`;
  return typeof value;
}

function tallyInvariantViolations(doc: Record<string, unknown>, into: Map<string, { count: number; sample: string }>): void {
  for (const rule of positionWriteInvariantViolations(doc)) {
    const entry = into.get(rule);
    if (entry) entry.count++;
    else into.set(rule, { count: 1, sample: String(doc.positionId) });
  }
}

/** One page of a leaderboard shard. */
export interface LeaderboardPage {
  positions: Position[];
  /** Exact: the read fetched one row past the page. */
  hasMore: boolean;
  /**
   * Set when the read already knows the exact match count (pool/lookup
   * shapes, and a deep walk that reached the end).
   */
  total?: number;
  cache: CacheStatus;
  /**
   * Epoch ms the rows were current at, set ONLY when they are older than the
   * staleness budget allows unflagged: the retained window served on a
   * database timeout, a window read from a secondary lagging past the budget,
   * or a deep page started from an aged ladder rung. The response then says
   * `stale: true` + `dataAsOf`.
   */
  dataAsOf?: number;
}

/** A deep page (`findLeaderboardDeep`): one shard, or the all-chains merge. */
export interface DeepLeaderboardPage extends LeaderboardPage {
  /** Chains whose shard failed and were left out (the page is the others' merged order). */
  missingChains: number[];
  /** Their errors, for the caller's log line. */
  errors: Array<{ chainId: number; error: unknown }>;
}

/** What a deep walk reads per position: the sort key and the id. */
type SortKeyRow = Record<string, unknown>;

/** A pool's OPEN positions and their distinct owners. */
export interface PoolPositionCounts {
  positionsCount: number;
  holdersCount: number;
}

/** What `countsByPoolIds` reports about the age of the counts it served. */
export interface PoolCountsMeta {
  /** Set only when a count served is older than the staleness budget. */
  dataAsOf?: number;
  /** The oldest load time among the counts served. */
  storedAt?: number;
  /** The oldest data time (load time less replication lag) among them. */
  dataAt?: number;
}

export interface LeaderboardCount {
  count: number;
  /** The count stopped at the cap, so `count` is a floor. */
  capped: boolean;
}

/** A cached window: the first N(+1) rows of a shard for one query. */
interface LeaderboardWindow {
  rows: Position[];
  total?: number;
}

export interface PositionRef {
  positionId: string;
  tokenId: string;
}

export interface PositionRefWithTokens extends PositionRef {
  token0Address: string;
  token0Symbol?: string;
  token1Address: string;
  token1Symbol?: string;
}

export interface UpsertManyOptions {
  /**
   * Aggregates-mode adapters (v4): compute `computePerformanceFromAggregates`
   * on the merged document inside the upsert (one write per position).
   * `ethPriceNow` values gas at the current native price; the caller fetches it
   * once per flush (0 when it is unknown — gas then falls back to its tx-time
   * USD, exactly as the separate recompute did).
   */
  aggregates?: { ethPriceNow: number };
}

/** An active position as the on-chain fee refresh needs it. */
export interface FeeRefreshCandidate {
  positionId: string;
  tokenId: string;
  poolId: string;
  tickLower: number;
  tickUpper: number;
  decimals0: number;
  decimals1: number;
  /** The indexer's last fee-settling block as stored (0 = not yet re-synced). */
  lastModifyBlock: number;
  /** The served state a fresh measurement is revalued against. */
  stored: FeeServedState;
  /**
   * The on-chain measurement already stored (absent = never measured), so an
   * identical re-read need not be written again — see `PositionFeeRefreshService.persist`.
   */
  rpc?: { fees0: string; fees1: string; block: number; at?: Date };
  /**
   * The document's `updatedAt` when `stored` was read — the version a served
   * write is computed from. Undefined for a document that has none.
   */
  version?: Date;
}

/** Most ops one `writeRpcFees` bulkWrite carries (the fee job's write-bucket unit). */
export const FEE_WRITE_CHUNK = 100;

/** How `writeRpcFees` sends its bulkWrites. */
export interface RpcFeeWriteOptions {
  /** Driver-side (CSOT `timeoutMS`) timeout on each bulkWrite; unset = none. */
  timeoutMs?: number;
  /** Awaited with the expected write count before the stamp-only fallback is sent (the fee job's write gate). */
  beforeFallback?: (writes: number) => Promise<void>;
  /**
   * Shared write budget, enforce only: refuse (throw `WriteBudgetTimeoutError`)
   * a chunk whose budget wait would pass this, instead of sleeping past the
   * caller's own backstop and sending the write later, outside its pacing.
   * Unset = no limit.
   */
  maxBudgetWaitMs?: number;
  /**
   * Shared write budget, enforce only: aborting it rejects a chunk still
   * waiting for budget (the fee tick aborts it when the tick ends), so a write
   * is never sent after its tick — or its lease — has moved on.
   */
  signal?: AbortSignal;
}

/** One on-chain fee measurement, decimal-adjusted, as the refresh job writes it. */
export interface RpcFeeWrite {
  positionId: string;
  fees0: string;
  fees1: string;
  /** The block its batch's state was read at. */
  block: number;
  /** Served-field `$set` paths (`revalueServedFees`), written in the same op. */
  served?: Record<string, unknown>;
  /**
   * The `updatedAt` the served paths were computed from (`FeeRefreshCandidate.version`).
   * They are written only while the document still carries it; see `writeRpcFees`.
   */
  version?: Date;
}

/**
 * What the fee refresh reads off a position: the StateView call inputs, the
 * freshness watermark, and the served state it revalues (`amounts` + `metrics`
 * + the gated leg prices) — one read per page, no second fetch for the rows
 * that turn out to need a revalue.
 */
const FEE_CANDIDATE_PROJECTION = {
  _id: 0,
  positionId: 1,
  tokenId: 1,
  poolId: 1,
  isActive: 1,
  tickLower: 1,
  tickUpper: 1,
  lastModifyBlock: 1,
  'token0.decimals': 1,
  'token1.decimals': 1,
  'token0.priceUsd': 1,
  'token1.priceUsd': 1,
  amounts: 1,
  metrics: 1,
  updatedAt: 1,
  rpcFeesUncollected0: 1,
  rpcFeesUncollected1: 1,
  rpcFeesBlock: 1,
  rpcFeesAt: 1,
} as const;

interface FeeCandidateRow {
  positionId: string;
  tokenId: string;
  poolId?: string;
  isActive?: boolean;
  tickLower: number;
  tickUpper: number;
  lastModifyBlock?: number;
  token0?: { decimals?: number; priceUsd?: number };
  token1?: { decimals?: number; priceUsd?: number };
  amounts?: Partial<Position['amounts']>;
  metrics?: Partial<Position['metrics']>;
  updatedAt?: Date;
  rpcFeesUncollected0?: string;
  rpcFeesUncollected1?: string;
  rpcFeesBlock?: number;
  rpcFeesAt?: Date;
}

export interface TransactionSyncCandidate extends PositionRef {
  chainId: number;
  protocol: string;
  isActive: boolean;
  poolId: string;
  token0: Position['token0'];
  token1: Position['token1'];
  txSyncStatus?: PositionTxSyncStatus;
  txLastSuccessAt?: Date;
  txSyncedTransactionCount?: number;
  txFinalizedAt?: Date;
}

@Injectable()
export class PositionsRepository {
  private readonly logger = new Logger(PositionsRepository.name);
  /** Per-shard leaderboard windows (see `findLeaderboard`). */
  private readonly windows: SwrCache<LeaderboardWindow>;
  /** Per-(shard, pool) open-position / holder counts. */
  private readonly poolCounts: SwrCache<PoolPositionCounts>;
  /** Pool-count keys a background batch is counting right now. */
  private readonly poolCountsInFlight = new Set<string>();
  private poolCountRefreshes = 0;
  /** `shard:index` → until when the shard is queried WITHOUT that hint (see `withHint`). */
  private readonly missingHints = new Map<string, number>();
  /**
   * Set once the server refused `hint` on a `distinct` (MongoDB < 7.1, see
   * `distinctActiveTokenAddresses`). Process-wide and permanent: a server's
   * version is a property of the deployment, re-learned at the next boot.
   */
  private distinctHintUnsupported = false;
  /** Window keys whose background rescue read failed, until when (see `rescueWindow`). */
  private readonly rescueFailedUntil = new Map<string, number>();
  private rescuesInFlight = 0;
  /** When a user request last read a leaderboard page — the warmup's demand signal. */
  private lastUserReadAt = 0;
  /** Deep pages being walked right now: identical requests share one walk. */
  private readonly deepInFlight = new Map<string, Promise<DeepLeaderboardPage>>();
  /** Per shard: when the last write-invariant alert was logged. */
  private readonly invariantAlertedAt = new Map<string, number>();
  /** `POSITIONS_WRITE_SKIP` & co., read once (`skipSettings`). */
  private writeSkip?: WriteSkipSettings;
  /** Per shard: the skip counters (P2.3) — the current window and everything before it. */
  private readonly skipStats = new Map<string, ShardSkipStats>();
  /** `$set` fields no section knows, already warned about. */
  private readonly unknownFieldsWarned = new Set<string>();
  /** When the observer last threw (one warning a minute). */
  private observerFailedAt = 0;

  constructor(
    @Inject(CollectionResolver) private readonly resolver: CollectionResolver,
    @Inject(TokensRepository) private readonly tokens: TokensRepository,
    // APPENDED and optional: specs construct this repository positionally.
    @Optional() @Inject(AppConfigService) private readonly config?: AppConfigService,
    // APPENDED and optional: the deep-page ladder and the global read budget
    // (counts, deep walks, rescues, holder counts). Absent, deep pages walk
    // from the top and nothing is paced.
    @Optional() @Inject(PageLadderService) private readonly ladder?: PageLadderService,
    @Optional() @Inject(ReadBudgetService) private readonly budget?: ReadBudgetService,
    // APPENDED and optional: holder counts are shared through Redis (see
    // `adoptSharedPoolCounts`); absent, each process counts for itself.
    @Optional() @Inject(ReadPathRedis) private readonly redis?: ReadPathRedis,
    // APPENDED and optional (P3.3): told about every position write so the
    // fee store follows without reading Mongo. Absent, nobody listens.
    @Optional() @Inject(POSITION_WRITE_OBSERVER) private readonly writeObserver?: PositionWriteObserver,
  ) {
    const ttl = listCacheTtl(this.config);
    this.windows = new SwrCache<LeaderboardWindow>({
      name: 'leaderboard-windows',
      maxBytes: this.config?.leaderboardCacheMaxBytes ?? DEFAULT_WINDOW_CACHE_BYTES,
      ...ttl,
      jitter: LIST_CACHE_JITTER,
      fallbackMs: WINDOW_FALLBACK_MS,
      // Windows are read from secondaries: their data is as old as the lag.
      dataLag: () => userReadLagMs(),
      onBackgroundError: (key, err) => this.logBackgroundError('leaderboard window', key, err),
    });
    this.poolCounts = new SwrCache({
      name: 'pool-position-counts',
      maxBytes: 4 * 1024 * 1024,
      ...ttl,
      jitter: LIST_CACHE_JITTER,
      fallbackMs: POOL_COUNTS_FALLBACK_MS,
      dataLag: () => userReadLagMs(),
      onBackgroundError: (key, err) => this.logBackgroundError('pool counts', key, err),
    });
  }

  /**
   * Run a query hinted to `index`, falling back to the planner's own choice
   * when the shard has no such index. MongoDB refuses a hint naming a missing
   * index with BadValue — not a timeout — so a shard whose autoIndex build
   * failed (failures are swallowed at boot) or has not finished (a newly
   * enabled chain) would otherwise answer every request with an uncached 500.
   * The miss is remembered for `MISSING_HINT_RECHECK_MS`, so the next queries
   * go straight to the unhinted plan, with ONE `[alert]` per shard and index.
   * An index with a `HINT_FALLBACK` is replaced by that one (itself handled the
   * same way) rather than by no hint at all.
   *
   * An index that EXISTS with a different spec than declared is never hinted
   * at all (`CollectionResolver.hintUnusable`, learned by the boot pre-flight,
   * which also raised the alert): MongoDB would obey the hint, and no error
   * would say the answer came off the wrong index.
   */
  private async withHint<T>(
    chainId: number,
    protocol: string,
    index: string | undefined,
    run: (hint: string | undefined) => PromiseLike<T>,
  ): Promise<T> {
    if (!index) return await run(undefined);
    const fallback = HINT_FALLBACK[index];
    const instead = () => (fallback ? this.withHint(chainId, protocol, fallback, run) : run(undefined));
    if (this.resolver.hintUnusable?.(chainId, protocol, index)) return await instead();
    const key = `${chainId}:${protocol}:${index}`;
    const missingUntil = this.missingHints.get(key);
    if (missingUntil !== undefined && missingUntil > Date.now()) return await instead();
    let out: T;
    try {
      out = await run(index);
    } catch (err) {
      if (!isMissingHintError(err)) throw err;
      if (missingUntil === undefined) {
        this.logger.warn(
          `[alert] positions.hint_missing chain=${chainId} protocol=${protocol} index=${index} — ` +
            `querying ${fallback ? `hinted to ${fallback}` : 'unhinted'} until it exists ` +
            `(run scripts/positions-index-migration.mjs)`,
        );
      }
      this.missingHints.set(key, Date.now() + MISSING_HINT_RECHECK_MS);
      return await instead();
    }
    if (missingUntil !== undefined) this.missingHints.delete(key); // it exists again
    return out;
  }

  private logBackgroundError(what: string, key: string, err: unknown): void {
    const timedOut = isMaxTimeMSExpired(err);
    this.logger.warn(
      `${what} refresh ${timedOut ? 'timed out' : 'failed'} (stale value kept) key=${key.slice(0, 120)}: ` +
        `${(err as Error)?.message ?? String(err)}`,
    );
  }

  /**
   * Returns the Position model for a given (chainId, protocol). In legacy
   * mode this is always the singleton `positions` collection; in sharded
   * mode it's a per-(chain, protocol) collection.
   */
  private model(chainId: number, protocol: string): Model<PositionDocument> {
    return this.resolver.positionModel(chainId, protocol);
  }

  /**
   * One bulk upsert per shard. With `opts.aggregates` (aggregates-mode
   * adapters, v4) each row's performance metrics are computed INSIDE this
   * write — see `positionUpdate` — so a position costs one write per sync, not
   * two (this upsert, then `AggregateRecomputeService` re-reading it and writing
   * `updatePerformanceMetrics`).
   *
   * P2.3 / P2.4 (design §4.2): per CHUNK — read the stored state → decide →
   * acquire write-budget units (the writes + the primary read) → write — so no
   * decision acts on a read older than its own chunk. Chunks are ≤ 500 rows
   * while `POSITIONS_WRITE_SKIP` is shadow/on or the write budget is on (or
   * `MONGO_BULK_WRITE_MAX_OPS`); with everything off a shard's rows are ONE
   * read and ONE bulkWrite, exactly as before. With skip `on` a row is written
   * whole, as its changed sections only, or not at all (`planRow`). Returns
   * the documents inserted + modified.
   */
  async upsertMany(positions: NormalizedPosition[], opts: UpsertManyOptions = {}): Promise<number> {
    if (positions.length === 0) return 0;

    const skip = this.skipSettings();
    const chunkSize = effectiveChunkOps(this.budgetSettings(), skip.mode === 'off' ? undefined : SKIP_CHUNK_OPS);

    // Dispatch per (chainId, protocol) so each bulkWrite targets the right
    // shard collection.
    const grouped = groupByCollection(skip.mode === 'off' ? positions : lastOccurrences(positions));
    let total = 0;
    await Promise.all(
      [...grouped.values()].map(async (group) => {
        for (let i = 0; i < group.positions.length; i += chunkSize) {
          const chunk = Number.isFinite(chunkSize) ? group.positions.slice(i, i + chunkSize) : group.positions;
          total += await this.writeChunk(group.chainId, group.protocol, chunk, opts, skip);
        }
      }),
    );
    return total;
  }

  /**
   * The write-budget settings in force: the registered budget's, else the
   * configured ones. The process budget registers itself only while its mode
   * is not `off`, and `MONGO_BULK_WRITE_MAX_OPS` must cap these writers'
   * chunks with the budget off too (as it does the pool upserts').
   */
  private budgetSettings(): WriteBudgetSettings {
    return (
      processWriteBudget()?.settings ??
      (this.config as unknown as WriteBudgetConfigView | undefined)?.writeBudget ??
      WRITE_BUDGET_OFF
    );
  }

  /** `POSITIONS_WRITE_SKIP` & co., read once (no config = `off`: every row written). */
  private skipSettings(): WriteSkipSettings {
    this.writeSkip ??= writeSkipSettings(this.config as unknown as WriteSkipConfigSource | undefined);
    return this.writeSkip;
  }

  /**
   * The list projection: today's, plus `staleMisses` while skip is `on` — the
   * read-time overlay (`positions/served-clock-overlay.ts`) needs it and strips
   * it before serving. Identical object to `LIST_PROJECTION` otherwise.
   */
  listProjection(): Readonly<Record<string, 0 | 1>> {
    return this.skipSettings().mode === 'on' ? LIST_OVERLAY_PROJECTION : LIST_PROJECTION;
  }

  /** The detail projection, `staleMisses` added while skip is `on` (the detail mapper's allow-list drops it). */
  detailProjection(): Readonly<Record<string, 0 | 1>> {
    return this.skipSettings().mode === 'on' ? DETAIL_OVERLAY_PROJECTION : DETAIL_PROJECTION;
  }

  /**
   * One chunk of one shard: read → decide → write → re-issue → notify. Every
   * mode goes through here; `off` decides "today's full update" for every row.
   */
  private async writeChunk(
    chainId: number,
    protocol: string,
    positions: NormalizedPosition[],
    opts: UpsertManyOptions,
    skip: WriteSkipSettings,
  ): Promise<number> {
    const now = new Date();
    const model = this.model(chainId, protocol);
    const carriesStamp = positions.some((p) => carriedStampBlock(p) !== undefined);
    const existing = await this.findExistingStates(chainId, protocol, positions, skip.mode, carriesStamp);
    const denied = await this.carryForwardDenied(chainId, positions, existing);
    const stats = skip.mode === 'off' ? undefined : this.shardStats(chainId, protocol, skip.mode);

    const violations = new Map<string, { count: number; sample: string }>();
    const plans: RowPlan[] = [];
    const reread: string[] = [];
    for (const raw of positions) {
      const previous = existing.get(raw.positionId);
      const position = this.stampGuard(raw, previous);
      if (position !== raw) {
        reread.push(raw.positionId);
        if (stats) stats.stampDropped++;
      }
      const plan = this.planRow(position, previous, now, opts.aggregates, skip, stats, denied);
      plan.raw = raw;
      tallyInvariantViolations(plan.full.$set as Record<string, unknown>, violations);
      plans.push(plan);
    }
    this.alertInvariantViolations(chainId, protocol, violations);

    const written = plans.filter((p) => p.op !== undefined);
    const ops = written.map((p) => p.op!);
    const units = written.map((p) => p.units);
    let total = 0;
    let reissue: RowPlan[] = [];
    if (ops.length === 0) {
      // Nothing to write: the read still cost the primary.
      chargePrimaryRead(existing.size);
    } else {
      const sections = written.filter((p) => p.kind === 'section');
      try {
        const result = await budgetedBulkWrite(model, ops, {
          unitsOf: (_op, index) => units[index] ?? WRITE_UNITS.fullUpdate,
          readDocs: existing.size,
          maxOps: ops.length,
          bulkOptions: { ordered: false },
        });
        total += result.upsertedCount + result.modifiedCount;
        if (sections.length > 0) {
          reissue = await this.unmatchedSections(model, chainId, protocol, written, result, new Set());
        }
      } catch (err) {
        // Two failures are repaired by re-issuing the row whole from a fresh
        // read: a SECTION op the server refused (a leaf `$set` under a stored
        // non-object, code 28), and a stamp-guarded upsert that lost to a
        // NEWER stored stamp (its filter matched nothing, so the upsert tried
        // an insert: E11000 on the positionId index — `stampGuardFilter`).
        // Any other failure is today's — the flush fails.
        const failed = bulkWriteFailures(err);
        if (!failed || failed.size === 0 || [...failed].some(([i, code]) => !repairableFailure(written[i], code))) throw err;
        const partial = (err as { result?: unknown }).result;
        total += countOf(partial, 'upsertedCount') + countOf(partial, 'modifiedCount');
        for (const i of failed.keys()) {
          const plan = written[i]!;
          if (plan.kind === 'section') {
            plan.reissue = 'failed';
            if (stats) stats.sectionErrors++;
          } else {
            plan.reissue = 'conflict';
          }
        }
        reissue = [
          ...[...failed.keys()].map((i) => written[i]!),
          ...(await this.unmatchedSections(model, chainId, protocol, written, partial, new Set(failed.keys()))),
        ];
      }
    }
    // A re-issue can itself lose to a fee write that lands between its fresh
    // read and its write: it is re-read and re-issued again, at most
    // `MAX_REISSUE_ROUNDS` times in all (the last round's failure fails the flush).
    for (let round = 1; reissue.length > 0; round++) {
      const again = await this.reissueWhole(model, chainId, protocol, reissue, now, opts.aggregates, skip, stats, round >= MAX_REISSUE_ROUNDS);
      total += again.total;
      reread.push(...again.reread);
      reissue = again.retry;
    }

    if (stats) this.reportShard(chainId, protocol, skip.mode);
    this.notifyWritten(chainId, protocol, written, now);
    if (reread.length > 0) this.notifyReread(chainId, protocol, reread);
    return total;
  }

  /**
   * P3.1 stamp guard (design §4.2 rule 5), in every mode: a carried on-chain
   * fee reading OLDER than the stored one is not written — the stored stamp
   * stays, and the row is handed back for a fee re-read (`notifyReread`) so the
   * fee job re-serves it from the newer reading. A reading at the SAME block is
   * the same measurement (the indexer's `mergeFeeReadings` gives that tie to
   * the fresh reading too): it is written, nothing to re-read.
   *
   * The carried reading also fed the row's SERVED fee leaves (normalize served
   * it as `onchain`). Those are re-served from the stored, newer reading — at
   * this row's own prices — so the write never puts an older figure beside a
   * newer stamp, whether or not anything acts on the re-read hint. (The stored
   * reading is valid to serve: its block ≥ the carried one ≥ `lastModifyBlock`.)
   */
  private stampGuard(position: NormalizedPosition, previous: ExistingPositionState | undefined): NormalizedPosition {
    const carried = carriedStampBlock(position);
    if (carried === undefined || !previous) return position;
    const stored = Number(previous.rpcFeesBlock);
    if (!Number.isFinite(stored) || stored <= carried) return position;
    const out = { ...position };
    for (const field of STAMP_FIELDS) delete (out as Record<string, unknown>)[field];
    if (position.metrics?.feesSource !== 'onchain') return out;
    const reading = storedFeeReading(previous);
    return reading ? reserveFromReading(out, reading) : out;
  }

  /**
   * Today's full update, and — with skip shadow/on — the decision (§4.2):
   * a full write (rule 2), a section write of the changed sections, or none.
   * `shadow` writes the full update (+ `wh`/`wAt`) and only COUNTS the decision.
   */
  private planRow(
    position: NormalizedPosition,
    previous: ExistingPositionState | undefined,
    now: Date,
    aggregates: UpsertManyOptions['aggregates'],
    skip: WriteSkipSettings,
    stats: ShardWriteStats | undefined,
    denied?: CarryForwardDenied,
  ): RowPlan {
    const filter = { chainId: position.chainId, protocol: position.protocol, positionId: position.positionId };
    const insertUnits = position.isActive ? WRITE_UNITS.insertActive : WRITE_UNITS.insertClosed;
    if (skip.mode === 'off') {
      const full = this.positionUpdate(position, previous, now, aggregates, {}, denied);
      // No row carries `wh` while skip is off; one written in an earlier
      // shadow/on period is dropped, so it can never vouch for this write.
      (full.$unset as Record<string, ''>).wh = '';
      return {
        position,
        previous,
        kind: previous ? 'full' : 'insert',
        full,
        op: { updateOne: { filter: stampGuardFilter(filter, full), update: full, upsert: true } },
        stampGuarded: carriesStampSet(full),
        units: previous ? WRITE_UNITS.fullUpdate : insertUnits,
      };
    }

    const nowMs = now.getTime();
    const stored = storedWriteState(previous, skip.mode);
    const next: NextWriteState = {
      positionId: position.positionId,
      isActive: position.isActive,
      underlyingValueUsd: Number(position.metrics?.underlyingValueUsd ?? 0),
      set: position as unknown as Record<string, unknown>,
      unknownFields: unknownUpsertFields(position),
    };
    if (next.unknownFields.length > 0) this.noteUnknownFields(next.unknownFields);
    const reason = fullWriteReason(stored, next, nowMs, skip);
    const on = skip.mode === 'on';
    // D-1b: a non-full write values gas at the ETH price the stored row implies.
    const impliedEth =
      aggregates && reason === null
        ? storedImpliedEthPrice(previous?.metrics?.totalGasCostUsd, previous?.amounts?.totalGasCostEth)
        : undefined;
    const gasAtStored = on && skip.gas === 'full-write' && impliedEth !== undefined;
    const full = this.positionUpdate(
      position,
      previous,
      now,
      gasAtStored ? { ethPriceNow: impliedEth } : aggregates,
      { bucketAge: on && skip.age === 'bucket' },
      denied,
    );
    const fullSet = full.$set as Record<string, unknown>;
    const values = sectionValues(fullSet, DECLARED_LEAVES).values;
    const previousSlots = previous ? decodeWh(previous.wh) : null;
    const diff = diffSections(values, previousSlots, skip.tolerance);
    const wh = encodeWh(diff.slots);
    const kind: RowPlan['kind'] =
      reason === null ? (diff.changed.length === 0 ? 'skip' : 'section') : previous ? 'full' : 'insert';

    // The whole update with `wh`/`wAt`: a full write in `on`, EVERY write in `shadow`.
    const wholeUpdate: Record<string, unknown> = { ...full, $set: { ...fullSet, wh, wAt: now } };
    let sectionUpdate: Record<string, unknown> | undefined;
    if (kind === 'section') {
      const parts = sectionUpdateParts(fullSet, diff.changed, DECLARED_LEAVES);
      sectionUpdate = { $set: { ...parts.set, wh, lastSyncedAt: now } };
      if (Object.keys(parts.unset).length > 0) sectionUpdate.$unset = parts.unset;
    }

    if (stats) {
      stats.rows++;
      stats.decisions[kind]++;
      if (reason) stats.fullReasons[reason] = (stats.fullReasons[reason] ?? 0) + 1;
      const bucket = (stats.buckets[valueBucket(next.underlyingValueUsd)] ??= { rows: 0, skipped: 0, sectioned: 0 });
      bucket.rows++;
      if (kind === 'skip') bucket.skipped++;
      if (kind === 'section') {
        bucket.sectioned++;
        for (const section of diff.changed) stats.sections[section] = (stats.sections[section] ?? 0) + 1;
      }
      const fullBytes = bsonBytes(wholeUpdate.$set);
      stats.fullBytes += fullBytes;
      stats.setBytes += kind === 'skip' ? 0 : kind === 'section' ? bsonBytes(sectionUpdate!.$set) : fullBytes;
      if (!on) this.shadowDetail(stats, kind, diff.changed, values, previous, position, now, aggregates, impliedEth, previousSlots, skip, denied);
    }

    if (!on || kind === 'insert' || kind === 'full') {
      return {
        position,
        previous,
        kind: previous ? 'full' : 'insert',
        reason,
        full,
        op: { updateOne: { filter: stampGuardFilter(filter, wholeUpdate), update: wholeUpdate, upsert: true } },
        stampGuarded: carriesStampSet(wholeUpdate),
        units: previous ? WRITE_UNITS.fullUpdate : insertUnits,
      };
    }
    if (kind === 'skip') return { position, previous, kind, reason, full };
    return {
      position,
      previous,
      kind,
      reason,
      full,
      changed: diff.changed,
      writtenWh: wh,
      // upsert:false — a row deleted since the read must not come back as a
      // stub of a few leaves. And only while the row still carries the `wh`
      // this decision was taken against: a writer that changed it in between
      // (the fee job's served write `$unset`s it) would otherwise have its
      // invalidation overwritten by this `$set wh`. And, when it writes the
      // stamp section, only while the stored stamp is not newer (a stamp-only
      // fee write leaves `wh` alone). Any miss is re-issued whole
      // (`unmatchedSections`).
      op: {
        updateOne: {
          filter: stampGuardFilter({ ...filter, wh: whBytes(previous!.wh) }, sectionUpdate!),
          update: sectionUpdate!,
          upsert: false,
        },
      },
      units: WRITE_UNITS.sectionUpdate,
    };
  }

  /**
   * Shadow's evidence: WHY each would-be section write is one (the leaves that
   * moved, by reason tag — `changeReasons`), and what D-1b (`full-write` gas)
   * would decide for the same row.
   */
  private shadowDetail(
    stats: ShardWriteStats,
    kind: RowPlan['kind'],
    changed: readonly Section[],
    values: Partial<Record<Section, unknown>>,
    previous: ExistingPositionState | undefined,
    position: NormalizedPosition,
    now: Date,
    aggregates: UpsertManyOptions['aggregates'],
    impliedEth: number | undefined,
    previousSlots: ReadonlyArray<Buffer | null> | null,
    skip: WriteSkipSettings,
    denied?: CarryForwardDenied,
  ): void {
    if (kind === 'section' && previous) {
      const storedSet = previous as unknown as Record<string, unknown>;
      for (const section of changed) {
        const storedValue = sectionValue(storedSet, section, DECLARED_LEAVES);
        for (const tag of changeReasons(section, storedValue, values[section])) {
          const key = `${section}:${tag}`;
          stats.reasons[key] = (stats.reasons[key] ?? 0) + 1;
          const samples = (stats.reasonSamples[key] ??= []);
          if (samples.length < REASON_SAMPLES) samples.push(position.positionId);
        }
      }
    }
    if (kind === 'insert' || kind === 'full' || !aggregates) return;
    stats.gasFullWrite.rows++;
    if (kind === 'skip' || impliedEth === undefined) {
      stats.gasFullWrite[kind === 'skip' ? 'skipped' : 'sectioned']++;
      return;
    }
    const alt = this.positionUpdate(position, previous, now, { ethPriceNow: impliedEth }, {}, denied);
    const altValues = sectionValues(alt.$set as Record<string, unknown>, DECLARED_LEAVES).values;
    const altDiff = diffSections(altValues, previousSlots, skip.tolerance);
    stats.gasFullWrite[altDiff.changed.length === 0 ? 'skipped' : 'sectioned']++;
  }

  /**
   * Section ops that matched nothing — the row was deleted since the read
   * (`reissue: 'vanished'`) or another writer changed its `wh` (`'conflict'`) —
   * from the bulkWrite counts and, only when some missed, one read of their ids.
   * A row whose stored `wh` is the one ITS op wrote was matched: the counts say
   * only how many missed, not which, and a successful section op has replaced
   * the `wh` it was guarded on — so comparing with the `wh` READ would call
   * every successful op of the chunk a conflict.
   */
  private async unmatchedSections(
    model: Model<PositionDocument>,
    chainId: number,
    protocol: string,
    written: RowPlan[],
    result: unknown,
    failed: ReadonlySet<number>,
  ): Promise<RowPlan[]> {
    const sectionIdx = written.map((p, i) => (p.kind === 'section' && !failed.has(i) ? i : -1)).filter((i) => i >= 0);
    if (sectionIdx.length === 0) return [];
    // Every upsert op that did not fail counts once in matched + upserted.
    const upserts = written.filter((p, i) => p.kind !== 'section' && !failed.has(i)).length;
    const sectionMatched = countOf(result, 'matchedCount') + countOf(result, 'upsertedCount') - upserts;
    if (sectionMatched >= sectionIdx.length) return [];
    const ids = sectionIdx.map((i) => written[i]!.position.positionId);
    const rows = await model
      .find({ chainId, protocol, positionId: { $in: ids } }, { _id: 0, positionId: 1, wh: 1 })
      .lean<Array<{ positionId?: unknown; wh?: unknown }>>();
    chargePrimaryRead(rows.length);
    const stored = new Map(rows.map((r) => [String(r.positionId), r.wh]));
    const missed: RowPlan[] = [];
    for (const i of sectionIdx) {
      const plan = written[i]!;
      const id = plan.position.positionId;
      if (!stored.has(id)) plan.reissue = 'vanished';
      else if (sameBytes(stored.get(id), plan.writtenWh)) continue; // matched: its write landed
      else plan.reissue = 'conflict';
      missed.push(plan);
    }
    return missed;
  }

  /**
   * Re-issue rows whole (counted `reupserted`): a section op whose row
   * vanished (written as an INSERT — there is no stored row to carry prices
   * or metrics from), or that conflicted or failed (written as today's full
   * update). A conflicted or failed row is decided again from a FRESH read of
   * its stored state, not the one taken before the write: the other writer's
   * change (typically a fee served write with a newer stamp) is what the
   * guards must see — the stamp guard above all — and the read may be as old
   * as the budget wait. A row the fresh read no longer finds is inserted.
   * Every op that writes a stamp carries the in-write guard
   * (`stampGuardFilter`); a row that loses to a newer stamp AGAIN comes back
   * in `retry` for another round, unless this is the `final` one (then the
   * flush fails). Returns the rows written, the rows the re-applied stamp
   * guard refused (`reread`) and those to retry.
   */
  private async reissueWhole(
    model: Model<PositionDocument>,
    chainId: number,
    protocol: string,
    plans: RowPlan[],
    now: Date,
    aggregates: UpsertManyOptions['aggregates'],
    skip: WriteSkipSettings,
    stats: ShardWriteStats | undefined,
    final = true,
  ): Promise<{ total: number; reread: string[]; retry: RowPlan[] }> {
    const rereadPlans = plans.filter((p) => p.reissue !== 'vanished');
    const fresh =
      rereadPlans.length > 0
        ? await this.findExistingStates(
            chainId,
            protocol,
            rereadPlans.map((p) => p.raw ?? p.position),
            skip.mode,
            rereadPlans.some((p) => carriedStampBlock(p.raw ?? p.position) !== undefined),
          )
        : new Map<string, ExistingPositionState>();
    // The fresh stored prices may carry forward legs the first read did not.
    const denied = await this.carryForwardDenied(chainId, rereadPlans.map((p) => p.raw ?? p.position), fresh);
    const ops: Array<Record<string, unknown>> = [];
    const units: number[] = [];
    const reread: string[] = [];
    for (const plan of plans) {
      const raw = plan.raw ?? plan.position;
      const previous = plan.reissue === 'vanished' ? undefined : fresh.get(raw.positionId);
      const guarded = this.stampGuard(raw, previous);
      // Re-read only when THIS guard refused what the first one let through.
      if (guarded !== raw && plan.position === raw) {
        reread.push(raw.positionId);
        if (stats) stats.stampDropped++;
      }
      const update = this.positionUpdate(guarded, previous, now, aggregates, {}, denied);
      const values = sectionValues(update.$set as Record<string, unknown>, DECLARED_LEAVES).values;
      // A section this update lacks is UNKNOWN in the new wh: another writer may
      // have changed it since the read (its next appearance is written).
      const slots = diffSections(values, null, skip.tolerance).slots;
      (update.$set as Record<string, unknown>).wh = encodeWh(slots);
      (update.$set as Record<string, unknown>).wAt = now;
      // What is written now (the writer hint reports it).
      plan.position = guarded;
      plan.full = update;
      plan.stampGuarded = carriesStampSet(update);
      ops.push({
        updateOne: {
          filter: stampGuardFilter({ chainId: guarded.chainId, protocol: guarded.protocol, positionId: guarded.positionId }, update),
          update,
          upsert: true,
        },
      });
      units.push(previous ? WRITE_UNITS.fullUpdate : guarded.isActive ? WRITE_UNITS.insertActive : WRITE_UNITS.insertClosed);
    }
    if (stats) {
      stats.reupserted += ops.length;
      stats.conflicts += plans.filter((p) => p.reissue === 'conflict').length;
    }
    try {
      const result = await budgetedBulkWrite(model, ops, {
        unitsOf: (_op, index) => units[index] ?? WRITE_UNITS.fullUpdate,
        readDocs: fresh.size,
        maxOps: ops.length,
        bulkOptions: { ordered: false },
      });
      return { total: result.upsertedCount + result.modifiedCount, reread, retry: [] };
    } catch (err) {
      // Only a stamp-guarded row that lost to a newer stamp AGAIN is retried
      // (a fresh read next round); anything else — and any failure of the
      // last round — fails the flush.
      const failed = bulkWriteFailures(err);
      if (final || !failed || failed.size === 0 || [...failed].some(([i, code]) => !isStampConflict(plans[i], code))) throw err;
      const partial = (err as { result?: unknown }).result;
      // (A retried op carried its stamp, so its plan still holds the row as
      // received: the next round's re-read detection works unchanged.)
      const retry = [...failed.keys()].map((i) => {
        const plan = plans[i]!;
        plan.reissue = 'conflict';
        return plan;
      });
      return { total: countOf(partial, 'upsertedCount') + countOf(partial, 'modifiedCount'), reread, retry };
    }
  }

  // ── P2.3 reporting + P3.3 notifications ──────────────────────────────────

  /**
   * The write-skip counters per shard (`/admin/sync/status` → `writeSkip`, wired
   * by the integrator): `total` since boot (closed windows) and the open
   * `window`. In `shadow` the decisions are what `on` WOULD do; bytes are the
   * `$set` sent (on) / that would be sent (shadow) vs a full write's.
   */
  writeSkipStatus(): WriteSkipStatus {
    const skip = this.skipSettings();
    const shards: WriteSkipStatus['shards'] = {};
    for (const [key, entry] of this.skipStats) {
      shards[key] = { total: cloneStats(entry.total), window: cloneStats(entry.window), windowStartedAt: new Date(entry.windowStartedAt) };
    }
    return { settings: { ...skip }, shards };
  }

  private shardStats(chainId: number, protocol: string, mode: WriteSkipMode): ShardWriteStats {
    const key = `${chainId}:${protocol}`;
    let entry = this.skipStats.get(key);
    if (!entry) {
      entry = { total: emptyStats(mode), window: emptyStats(mode), windowStartedAt: Date.now(), lowStrikes: 0, alertedAt: 0 };
      this.skipStats.set(key, entry);
    }
    return entry.window;
  }

  /**
   * Closes a shard's window every `SKIP_WINDOW_MS`: one `[write-skip]` line
   * (counts, skip rate, bytes, reasons, value buckets, D-1b evaluation), and in
   * `on` the `positions.skip_rate_low` alert (< 30 % of updates skipped for 3
   * windows of ≥ 1,000 updates in a row; once an hour).
   */
  private reportShard(chainId: number, protocol: string, mode: WriteSkipMode): void {
    const key = `${chainId}:${protocol}`;
    const entry = this.skipStats.get(key);
    if (!entry) return;
    const now = Date.now();
    if (now - entry.windowStartedAt < SKIP_WINDOW_MS) return;
    const w = entry.window;
    if (w.rows > 0) {
      const updates = w.rows - w.decisions.insert;
      const rate = updates > 0 ? w.decisions.skip / updates : 0;
      this.logger.log(
        `[write-skip] chain=${chainId} protocol=${protocol} mode=${mode} window=${Math.round((now - entry.windowStartedAt) / 60_000)}m ` +
          `rows=${w.rows} insert=${w.decisions.insert} full=${w.decisions.full} section=${w.decisions.section} ` +
          `skip=${w.decisions.skip} (${(rate * 100).toFixed(1)}% of updates) reupserted=${w.reupserted} conflicts=${w.conflicts} ` +
          `sectionErrors=${w.sectionErrors} stampDropped=${w.stampDropped} ` +
          `setMB=${(w.setBytes / 1e6).toFixed(2)}/${(w.fullBytes / 1e6).toFixed(2)} ` +
          `fullReasons${formatCounts(w.fullReasons)} sections${formatCounts(w.sections)} reasons${formatCounts(w.reasons)} ` +
          `buckets{${Object.entries(w.buckets).map(([b, c]) => `${b}:${c.rows}/${c.skipped}/${c.sectioned}`).join(' ')}}` +
          (w.gasFullWrite.rows > 0 ? ` gasFullWrite{rows:${w.gasFullWrite.rows} skip:${w.gasFullWrite.skipped} section:${w.gasFullWrite.sectioned}}` : ''),
      );
      if (mode === 'on' && updates >= SKIP_ALERT_MIN_UPDATES) {
        entry.lowStrikes = rate < SKIP_RATE_ALERT ? entry.lowStrikes + 1 : 0;
        if (entry.lowStrikes >= SKIP_ALERT_WINDOWS && now - entry.alertedAt >= 3_600_000) {
          entry.alertedAt = now;
          this.logger.warn(
            `[alert] positions.skip_rate_low chain=${chainId} protocol=${protocol} skip=${(rate * 100).toFixed(1)}% ` +
              `of ${updates} updates, below ${SKIP_RATE_ALERT * 100}% for ${entry.lowStrikes} windows — ` +
              `reasons${formatCounts(w.sections)} (D-1b POSITIONS_GAS_REVALUE=${this.skipSettings().gas})`,
          );
        }
      }
    }
    addStats(entry.total, w);
    entry.window = emptyStats(mode);
    entry.windowStartedAt = now;
  }

  private noteUnknownFields(fields: readonly string[]): void {
    for (const field of fields) {
      if (this.unknownFieldsWarned.has(field)) continue;
      this.unknownFieldsWarned.add(field);
      this.logger.warn(
        `[write-skip] $set field "${field}" belongs to no section — every row carrying it is written whole ` +
          `(add it to a section in database/position-write-hash.ts)`,
      );
    }
  }

  private notifyWritten(chainId: number, protocol: string, plans: readonly RowPlan[], now: Date): void {
    if (!this.writeObserver || plans.length === 0) return;
    const wAt = now.getTime();
    const rows = plans.map((p) => feeRowHint(p.full.$set as Record<string, unknown>, wAt));
    this.callObserver(() => this.writeObserver!.onWritten(chainId, protocol, rows));
  }

  private notifyReread(chainId: number, protocol: string, positionIds: readonly string[]): void {
    const observer = this.writeObserver;
    if (!observer?.onFeeReread || positionIds.length === 0) return;
    this.callObserver(() => observer.onFeeReread!(chainId, protocol, positionIds));
  }

  private callObserver(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      const now = Date.now();
      if (now - this.observerFailedAt < 60_000) return;
      this.observerFailedAt = now;
      this.logger.warn(`position write observer threw (ignored): ${(err as Error)?.message ?? String(err)}`);
    }
  }

  /**
   * One `[alert] positions.write_invariant` line per shard per minute at most,
   * naming each violated rule, how many rows of the flush broke it and one
   * sample id. Alert only: the row is written as it is — the stored value is
   * what every reader already sees, and changing it here would hide the bug
   * upstream.
   */
  private alertInvariantViolations(
    chainId: number,
    protocol: string,
    violations: Map<string, { count: number; sample: string }>,
  ): void {
    if (violations.size === 0) return;
    const key = `${chainId}:${protocol}`;
    const now = Date.now();
    if (now - (this.invariantAlertedAt.get(key) ?? 0) < INVARIANT_ALERT_EVERY_MS) return;
    this.invariantAlertedAt.set(key, now);
    this.logger.warn(
      `[alert] positions.write_invariant chain=${chainId} protocol=${protocol} ` +
        [...violations].map(([rule, { count, sample }]) => `${rule}×${count}(e.g. ${sample})`).join(' ') +
        ' — the leaderboard order, seek and every replacement for buildLeaderboardFilter assume these hold',
    );
  }

  /**
   * The keep-last-known-price guard's view of the hand-set `trustDenied` flag
   * (`preserveTokenPrice`). In the modes that honour it (`usesStoredVerdicts`:
   * earned / combined) the guard must not carry a flagged token's previous
   * price forward — combined mode would otherwise write a flagged LISTED
   * token's pre-flag price back on every sync, right after the hot path (which
   * does load the flag) priced it 0. Only the legs the guard would carry
   * forward without the token's document are looked up: incoming price 0, a
   * positive stored one, trusted by the rule with no document, not an anchor
   * (anchors are never denied) — in earned mode that is none, so no read.
   * ONE `findTrustState` per chunk; undefined = nothing to look up (allowlist
   * mode always). A failed read fails closed ('unreadable': no non-anchor leg
   * carries forward this write, as in earned mode).
   */
  private async carryForwardDenied(
    chainId: number,
    positions: readonly NormalizedPosition[],
    existing: ReadonlyMap<string, ExistingPositionState>,
  ): Promise<CarryForwardDenied> {
    const policy = trustPolicyOf(this.config);
    if (!usesStoredVerdicts(policy)) return undefined;
    const need = new Set<string>();
    for (const p of positions) {
      const prev = existing.get(p.positionId);
      for (const [leg, stored] of [
        [p.token0, prev?.token0?.priceUsd],
        [p.token1, prev?.token1?.priceUsd],
      ] as const) {
        if (!leg?.address || leg.priceUsd > 0 || typeof stored !== 'number' || stored <= 0) continue;
        const verdict = resolveTokenTrust(chainId, leg.address, undefined, policy);
        if (verdict.trusted && verdict.reason !== 'anchor') need.add(leg.address.toLowerCase());
      }
    }
    if (need.size === 0) return undefined;
    try {
      const rows = await this.tokens.findTrustState(chainId, [...need]);
      return new Set([...need].filter((a) => rows.get(a)?.trustDenied === true));
    } catch (err) {
      this.logger.warn(`trust-flag read for ${need.size} carry-forward tokens failed on chain ${chainId} (not carried forward): ${(err as Error)?.message}`);
      return 'unreadable';
    }
  }

  private positionUpdate(
    position: NormalizedPosition,
    previous: ExistingPositionState | undefined,
    now: Date,
    aggregates?: UpsertManyOptions['aggregates'],
    clock: { bucketAge?: boolean } = {},
    denied?: CarryForwardDenied,
  ): Record<string, unknown> {
    // Keep-last-known-price guard. Preserve a stored positive priceUsd when:
    //   - the token is a configured anchor (stable/native/trusted) — those
    //     are always high-trust regardless of `verified` metadata quality;
    //   - OR the token is `verified` per the source data.
    // Do NOT preserve unverified non-anchor prices: long-tail external
    // quotes are the main source of poisoned current valuations, and
    // carrying them forward after a miss keeps bad rows alive.
    //
    // Transitional: a future schema change will persist per-token source +
    // confidence; once that lands, this guard can switch to a strict
    // confidence threshold without the `verified` fallback.
    const trustPolicy = trustPolicyOf(this.config);
    const token0 = preserveTokenPrice(position.chainId, position.token0, previous?.token0?.priceUsd, trustPolicy, denied);
    const token1 = preserveTokenPrice(position.chainId, position.token1, previous?.token1?.priceUsd, trustPolicy, denied);
    const guarded: NormalizedPosition = position.token0 === token0 && position.token1 === token1
      ? position
      : { ...position, token0, token1 };

    const set: Record<string, unknown> = {
      ...guarded,
      lastSyncedAt: now,
      lastVerifiedAt: now,
      staleMisses: 0,
    };
    // The raw indexer row is no longer stored (2026-10-06; nothing read it).
    // Never `$set` it, whoever built the object, and `$unset` it below so a row
    // still carrying one loses it on its next full write. Both in one update
    // would be a server error (conflicting paths), hence the delete.
    delete set.rawSubgraph;
    // D-1 (`POSITIONS_WRITE_SKIP_AGE=bucket`, skip `on` only): the annualised
    // fields are computed from a bucketed age; the stored `ageSeconds` stays
    // exact (and is served at read time anyway, `served-clock-overlay.ts`).
    const realAge = position.metrics?.ageSeconds;
    const aprAge = clock.bucketAge && typeof realAge === 'number' ? bucketAgeSeconds(realAge) : realAge;
    const ageShifted = aprAge !== realAge;
    const metricsIn = ageShifted ? { ...position.metrics, ageSeconds: aprAge as number } : position.metrics;
    if (ageShifted) set.metrics = metricsIn;
    if (previous?.metrics) {
      const metrics = refreshPerformanceFromStoredCashFlows(metricsIn, previous.metrics);
      set.metrics = metrics;
      const m = metrics;
      set.amounts = {
        ...position.amounts,
        depositedUsd: String(m.depositedUsd ?? position.metrics.depositedUsd),
        withdrawnUsd: String(m.withdrawnUsd ?? position.metrics.withdrawnUsd),
        totalFeesCollectedUsd: String(m.collectedFeesUsd ?? position.metrics.collectedFeesUsd),
        totalFeesUncollectedUsd: String(m.pendingFeesUsd ?? position.metrics.pendingFeesUsd),
        totalGasCostUsd: String(m.totalGasCostUsd ?? position.metrics.totalGasCostUsd),
        diffUsd: String(m.diffUsd ?? position.metrics.diffUsd),
      };
    }
    if (aggregates) {
      // One write per position. This used to be a second write:
      // `AggregateRecomputeService` re-read the document this update produced
      // (~3.4 KB each) and `$set` `computePerformanceFromAggregates(doc)` onto it
      // dotted, path by path. Every input that computation reads — the token
      // prices (after `preserveTokenPrice`), `amounts` and `metrics` (after
      // `refreshPerformanceFromStoredCashFlows`) — is replaced WHOLESALE by this
      // `$set`, so `set` IS the document the re-read returned, and laying the
      // result over `set.metrics` / `set.amounts` key by key is exactly the
      // dotted `$set` that followed. `test/position-single-write-parity.spec.ts`
      // pins the equality against the old two passes. The fee job's version
      // guard is unchanged: this write moves `updatedAt` once instead of twice.
      // (Today the recompute overwrites every key the stored-cash-flow overlay
      // above writes, so that overlay changes nothing here; it stays so the
      // composition IS the old one, whichever of the two functions changes next.)
      const perf = computePerformanceFromAggregates(set as unknown as Position, {
        ethPriceNow: aggregates.ethPriceNow,
      });
      set.metrics = { ...(set.metrics as Record<string, unknown>), ...perf.metrics };
      set.amounts = { ...(set.amounts as Record<string, unknown>), ...perf.amounts };
    }
    if (ageShifted) set.metrics = { ...(set.metrics as Record<string, unknown>), ageSeconds: realAge };
    const setOnInsert: Record<string, unknown> = {};
    // `rawSubgraph` is DECLARED in the schema for exactly this `$unset` (strict
    // mode drops an undeclared one, as it does `revertMetrics`).
    const unset: Record<string, ''> = { revertMetrics: '', rawSubgraph: '' };

    if (previous?.isActive === true && position.isActive === false) {
      set.txSyncStatus = 'pending';
      unset.txFinalizedAt = '';
      unset.txLastError = '';
    } else if (position.isActive) {
      unset.txFinalizedAt = '';
    }

    if (!Object.hasOwn(set, 'txSyncStatus')) {
      setOnInsert.txSyncStatus = 'pending';
    }

    const update: Record<string, unknown> = { $set: set };
    if (Object.keys(setOnInsert).length > 0) update.$setOnInsert = setOnInsert;
    update.$unset = unset;
    return update;
  }

  /**
   * The stored state the chunk's decisions read, from the PRIMARY (one `$in`
   * by the unique `{chainId, protocol, positionId}` index). Off = today's
   * projection (+ `rpcFeesBlock` when a P3.1 stamp is carried, for the stamp
   * guard). On adds the skip inputs: `wh`, `wAt`, `staleMisses`,
   * `rpcFeesBlock`, the stored gas ETH (D-1b) and each subdocument's BSON
   * `$type` (`_wt`, the legacy-shape guard). Shadow reads the sections whole
   * (minus `rawSubgraph` / `tx*`) so it can say WHICH leaves moved.
   */
  private async findExistingStates(
    chainId: number,
    protocol: string,
    positions: readonly NormalizedPosition[],
    mode: WriteSkipMode = 'off',
    carriesStamp = false,
  ): Promise<Map<string, ExistingPositionState>> {
    const projection: Record<string, unknown> =
      mode === 'shadow' ? { ...SHADOW_STATE_PROJECTION } : mode === 'on' ? { ...ON_STATE_PROJECTION } : { ...TODAY_STATE_PROJECTION };
    // The stamp guard compares the stored block and, on refusal, re-serves
    // the row's fee leaves from the stored reading.
    if (carriesStamp) for (const field of STAMP_FIELDS) projection[field] = 1;
    const rows = await this.model(chainId, protocol)
      .find({ chainId, protocol, positionId: { $in: positions.map((p) => p.positionId) } }, projection)
      .lean<ExistingPositionState[]>();
    const existing = new Map<string, ExistingPositionState>();
    for (const row of rows) existing.set(String(row.positionId), row);
    return existing;
  }

  /**
   * The leaderboard's visibility filter for one shard. Pure: `excluded` is the
   * chain's merged spam + no-real-market set, read before this is called.
   */
  private buildLeaderboardFilter(query: LeaderboardQuery, excluded: readonly string[]): Record<string, unknown> {
    const filter: Record<string, unknown> = {
      chainId: query.chainId,
      protocol: query.protocol,
    };
    // Direct id lookup short-circuit. When a positionId (= tokenId for v4) is
    // supplied, find that exact position regardless of pagination. Other
    // filters (status / range / minValueUsd / risky guard) still apply so
    // the result respects the same visibility rules as the rest of the
    // leaderboard. Match on both `positionId` and `tokenId` so the search
    // works for protocols where the two diverge.
    // `typeof === 'string'` guards belt-and-suspenders against a non-string
    // value reaching here (e.g. `?poolId[$ne]=` / `?owner[$ne]=` parsed into an
    // object): in prod the ValidationPipe rejects it 400, but under tsx dev the
    // @Query pipe is inert, so without the guard `.toLowerCase()` would throw a
    // 500. It never becomes a Mongo-operator injection either way (a plain
    // equality value, not an object, is assigned).
    if (typeof query.poolId === 'string' && query.poolId) {
      filter.poolId = query.poolId.toLowerCase();
    }
    // Owner filter: fetch every position held by a wallet. Owners are stored
    // lowercased by the adapters, so match lowercased. Applied unconditionally
    // (like poolId) — composes with a positionId lookup too (ownership check).
    if (typeof query.owner === 'string' && query.owner) {
      filter.owner = query.owner.toLowerCase();
    }
    const andClauses: Record<string, unknown>[] = [];
    // Searching an exact position/NFT id is a DIRECT LOOKUP: the user wants
    // that row regardless of value floors and anti-spam guards (a valid $0
    // unrealizable-leg row like USDC/RPC 133302 must be findable by id even
    // though the default ranked views hide it).
    const directLookup = Boolean(query.positionId);
    if (query.positionId) {
      andClauses.push({
        $or: [{ positionId: query.positionId }, { tokenId: query.positionId }],
      });
    }

    // Scam filtering: exclude positions whose either leg is a GoPlus-flagged
    // spam token (hard-flag rule over {chainId}_tokens signals), regardless of
    // the 'risky' toggle or open/closed. Unchecked/unknown tokens still show
    // (subject to the pricing + realizability gates). Read-time via a cached
    // spam-address set — no per-position stamp. Skipped for a direct id lookup.
    //
    // The same clause also carries the no-real-active-market exclusion (replaces
    // the removed value cap): positions whose value-leg has no real active DEX
    // market — symbol/FX fabrications with no DEX pair (GOLDX/EUR/DTC) and dead
    // seeded pools (BT77: $240M one-sided, ~$8/day). Read-time so STALE stored
    // rows clear without a re-normalize, no cap. Anchors/allowlisted are never in
    // the set. Both sets arrive MERGED and de-duplicated from TokensRepository,
    // so each leg is one `$nin`, not two copies of overlapping lists.
    if (!directLookup && excluded.length > 0) {
      andClauses.push({ 'token0.address': { $nin: excluded }, 'token1.address': { $nin: excluded } });
    }
    // Honeypot fees (flag, default off): out of every ranked and pool list and
    // count; an id lookup and an owner's own list still show the row.
    const shape = leaderboardShape(query);
    if (honeypotFeeFilterOn(this.config) && shape !== 'lookup' && shape !== 'owner') {
      andClauses.push(honeypotFeeClause(query.chainId, honeypotFeeAnchorExemptOn(this.config)));
    }
    const wantsClosedOnly = query.status === 'inactive';
    // Rate sorts (APR / fee-APR / ROI) rank by a rate that only exists while a
    // position is open AND holds current value — a closed or empty position has
    // no current rate (the UI dashes it), so it is excluded from these sorts
    // instead of letting its stale stored rate float to the top. Applies
    // REGARDLESS of the "risky" toggle (the spam guards below are risky-gated;
    // this is not). The closed-only view is exempt — surfacing closed rows is
    // its whole purpose — and so is a direct id lookup.
    //
    // Expressed as the EXACT equality `isActive: true`, never `{$ne: false}`:
    // the rate-sort indexes are partial on `{isActive: true}`, and the planner
    // may use a partial index only for a filter that implies its expression.
    // Same rows — every shard holds only `true`/`false` (the migration script
    // reports any other value). Since this makes the view active-only, the
    // All tab runs exactly the Active tab's filter for these sorts.
    const rateSortOpenOnly = RATE_SORTS.has(query.sort) && !wantsClosedOnly && !directLookup;
    const wantsAll = query.status === 'all' && !rateSortOpenOnly;
    if (rateSortOpenOnly || query.status === 'active' || (!query.status && query.activeOnly)) {
      filter.isActive = true;
    } else if (wantsClosedOnly) {
      filter.isActive = false;
    }
    // status === 'all' → no isActive filter; return open + closed together.
    if (query.range === 'in') {
      filter['metrics.inRange'] = true;
    } else if (query.range === 'out') {
      filter['metrics.inRange'] = false;
    }
    if (query.minValueUsd > 0 && !directLookup) {
      filter['metrics.underlyingValueUsd'] = { $gte: query.minValueUsd };
    }
    if (query.minPoolTvl > 0 && !directLookup) {
      // Only exclude pools with a KNOWN TVL below the floor. v4 pool TVL comes
      // from the vanilla subgraph and is frequently 0/missing (untracked tokens,
      // pool-id mismatches) — treating "unknown" (≤0) as below-floor wrongly
      // hides legitimate open positions (e.g. NFT 40: live $99k underlying, but
      // poolTvlUsd 0). Let unknown-TVL rows through; the open guards + minValue
      // floor still filter junk.
      andClauses.push({
        $or: [{ 'poolStats.tvlUsd': { $gte: query.minPoolTvl } }, { 'poolStats.tvlUsd': { $lte: 0 } }],
      });
    }
    // …and holding current value (the open half is `isActive: true` above).
    // Merged into the top-level bound, so it is a bound on the index key.
    if (rateSortOpenOnly) {
      const existingUnderlying =
        (filter['metrics.underlyingValueUsd'] as Record<string, number> | undefined) ?? {};
      filter['metrics.underlyingValueUsd'] = { ...existingUnderlying, $gt: 0 };
    }

    if (!query.includeRisky && !directLookup) {
      // Open-only anti-spam / ghost-active guards.
      //
      // The pool-TVL ceiling ($metrics.underlyingValueUsd <= tvlUsd ×
      // MAX_POSITION_POOL_TVL_RATIO) was removed here in tandem with the
      // adapter-side clamp in `assessValuation`. v4 pools with untracked
      // tokens report a heavily-undercounted `tvlUsd`, falsely flagging
      // legitimate positions as risky.
      //
      // Subgraph data quality issues (inflated COLLECT_FEES amounts, runaway
      // price spikes for thin-liquidity unverified tokens) leak through the
      // pricing.source / usedFallback / performanceReady gates because the
      // affected rows still have a `source` and the pricing decision still
      // chose an external quote. Reject anything with a missing/zero current
      // value or metrics outside a sanity envelope so the FE never surfaces a
      // "10,000,000% APR" row.
      //
      // CLOSED positions are EXEMPT: they are historical, carry ~0 current
      // value, and are ranked by realized metrics — applying `underlyingValue
      // > 0` (et al.) to them hides every closed row from the Closed / All
      // views. So the open-only guards are applied only to open rows.
      const openGuards: Record<string, unknown> = {
        'pricing.source': { $ne: 'none' },
        'pricing.usedFallback': { $ne: true },
        'metrics.underlyingValueUsd': { $gt: 0 },
        'metrics.aprExGas': { $gte: -10_000, $lte: 10_000 },
        'metrics.roi': { $gte: -1_000, $lte: 1_000 },
      };
      if (PERFORMANCE_SORTS.has(query.sort)) {
        openGuards['metrics.performanceReady'] = true;
      }

      if (wantsClosedOnly) {
        // closed-only view: no open-only guards
      } else if (wantsAll) {
        // mixed view: guards constrain open rows; closed rows pass through (a
        // rate sort never gets here — it made the view active-only above).
        andClauses.push({ $or: [{ isActive: false }, openGuards] });
      } else {
        // active-only (default) — identical to the previous behavior: the
        // open guards apply to every (active) row, merged with any minValue floor.
        const existingUnderlying =
          (filter['metrics.underlyingValueUsd'] as Record<string, number> | undefined) ?? {};
        Object.assign(filter, openGuards);
        filter['metrics.underlyingValueUsd'] = { ...existingUnderlying, $gt: 0 };
      }
    }
    if (query.assetClass === 'equity') {
      // Positions whose pool has a tokenized-equity leg. An INCLUSION, so an
      // empty set must match nothing — `{ $in: [] }` does exactly that, and a
      // chain with no tokenized equities correctly returns zero rows rather
      // than every row.
      const equities = equityAddresses(query.chainId);
      andClauses.push({
        $or: [
          { 'token0.address': { $in: equities } },
          { 'token1.address': { $in: equities } },
        ],
      });
    }

    if (andClauses.length > 0) {
      filter.$and = andClauses;
    }

    return filter;
  }

  /**
   * The query a leaderboard request runs — filter, sort, collation and hint —
   * and the cache keys derived from it. Waits only for a chain's first-ever
   * exclusion-set build; in steady state it does no I/O.
   *
   * The keys come from the FILTER, not from the request parameters, so a
   * parameter that changes the result cannot be missing from the key, and two
   * requests that run the same query share an entry. The exclusion list is
   * represented by a marker (it changes on its own 60 s cycle, well inside the
   * window TTLs) so the keys stay short.
   */
  async leaderboardPlan(query: LeaderboardQuery): Promise<LeaderboardPlan> {
    const shape = leaderboardShape(query);
    const exclusions =
      shape === 'lookup'
        ? { addresses: [] as string[], ok: true }
        : await this.tokens.readyLeaderboardExclusions(query.chainId);
    const filter = this.buildLeaderboardFilter(query, exclusions.addresses);
    const keyFilter = this.buildLeaderboardFilter(query, exclusions.addresses.length > 0 ? [RANK_EXCLUSION_PLACEHOLDER] : []);
    const collated = shape === 'owner' || shape === 'ranked';
    const { field: sortField, direction: sortDirection, tieDirection } = leaderboardSortSpec(query.sort);
    const countKey = `pos|${query.chainId}:${query.protocol}|${shape}|${stableKey(keyFilter)}`;
    // A pool's OPEN positions (the pool modal) read the partial active-pool
    // index; any other status keeps the full poolId index.
    const poolHint = filter.isActive === true ? BG_ACTIVE_POOL_INDEX : POOL_ID_INDEX;
    const scopeHint = shape === 'pool' ? poolHint : shape === 'owner' ? OWNER_INDEX : undefined;
    return {
      chainId: query.chainId,
      protocol: query.protocol,
      shape,
      filter,
      sortField,
      sortDirection,
      tieDirection,
      collated,
      hint: shape === 'ranked' ? rankedHint(query, filter) : scopeHint,
      countHint: shape === 'ranked' ? countHint(query, filter) : scopeHint,
      key: `${countKey}|${sortField}:${sortDirection}:${tieDirection}`,
      countKey,
      cacheable: exclusions.ok,
      shapeFilter: keyFilter,
      excluded: exclusions.addresses,
    };
  }

  /**
   * One page of one shard, served from a per-shard WINDOW cache: the first
   * `ceil(page × limit / 50) × 50` rows (plus one, so `hasMore` is exact) for
   * the query, fresh 15 s and served stale up to 30 s while one background
   * read refreshes it. The all-chains merge asks each shard for its top
   * `page × limit` rows, which lands on the same windows as the single-chain
   * views. No count runs here — see `countLeaderboard`.
   *
   * Deeper than the windows (> 1,000 rows) a collated page is a streaming walk
   * (`findLeaderboardDeep`), started from the nearest page-ladder rung; the
   * uncollated shapes read every key anyway and slice in Node.
   *
   * On a server-side timeout (code 50) the last window for the key is served if
   * one is retained — status `stale`, and `dataAsOf` set, because it is older
   * than the staleness budget; with none, a 503 (`QueryTimeoutException`). A
   * window whose DATA is older than the budget — read from a secondary that
   * lags — is served with `dataAsOf` too (`staleSince`).
   */
  async findLeaderboard(query: LeaderboardQuery, options: { maxTimeMS?: number } = {}): Promise<LeaderboardPage> {
    this.lastUserReadAt = Date.now();
    const plan = await this.leaderboardPlan(query);
    const maxTimeMS = options.maxTimeMS ?? READ_MAX_TIME_MS.find;
    const skip = (query.page - 1) * query.limit;
    const windowRows = listWindowRows(query.page, query.limit);

    if (windowRows === null && plan.collated) {
      const deep = await this.findLeaderboardDeep([query], { maxTimeMS });
      return {
        positions: deep.positions,
        hasMore: deep.hasMore,
        total: deep.total,
        cache: 'miss',
        ...(deep.dataAsOf !== undefined ? { dataAsOf: deep.dataAsOf } : {}),
      };
    }

    if (windowRows === null) {
      // Too deep to be worth caching: read just this page, plus one row.
      let deep: LeaderboardWindow;
      try {
        deep = await this.readLeaderboardRows(plan, skip, query.limit + 1, maxTimeMS);
      } catch (err) {
        throw isMaxTimeMSExpired(err) ? new QueryTimeoutException() : err;
      }
      return {
        positions: deep.rows.slice(0, query.limit),
        hasMore: deep.rows.length > query.limit,
        total: deep.total,
        cache: 'miss',
      };
    }

    const key = `${plan.key}|w${windowRows}`;
    let window: LeaderboardWindow;
    let cache: CacheStatus;
    let dataAsOf: number | undefined;
    try {
      let dataAt: number;
      ({ value: window, status: cache, dataAt } = await this.windows.get(
        key,
        () => this.readLeaderboardRows(plan, 0, windowRows + 1, maxTimeMS),
        { shouldStore: () => plan.cacheable },
      ));
      // Inside its cache window but read from a secondary lagging past the budget.
      dataAsOf = staleSince(dataAt, stalenessBudgetMs(this.config));
      if (dataAsOf !== undefined) readPathMeter.staleServed('positions', Date.now() - dataAsOf);
    } catch (err) {
      if (!isMaxTimeMSExpired(err)) throw err;
      const retained = this.windows.peekRetained(key);
      if (!retained) throw new QueryTimeoutException(this.rescueWindow(key, plan, windowRows));
      // Served from the retained window — and refreshed with the longer budget,
      // or the retention would run out and leave this filter a 503. It is past
      // its stale age, i.e. older than the staleness budget: flagged.
      this.rescueWindow(key, plan, windowRows);
      this.logger.warn(
        `[alert] leaderboard.timeout_served_stale chain=${plan.chainId} shape=${plan.shape} ` +
          `ageMs=${Date.now() - retained.dataAt}`,
      );
      readPathMeter.staleServed('positions', Date.now() - retained.dataAt);
      window = retained.value;
      cache = 'stale';
      dataAsOf = retained.dataAt;
    }
    return {
      positions: window.rows.slice(skip, skip + query.limit),
      hasMore: window.rows.length > skip + query.limit,
      total: window.total,
      cache,
      ...(dataAsOf !== undefined ? { dataAsOf } : {}),
    };
  }

  /**
   * A page deeper than the windows (> 1,000 rows) over one shard or several
   * (the all-chains merge): a streaming k-way merge of each shard's SORT KEYS
   * from the nearest trusted page-ladder rung (`walkDeepPage`), then only the
   * page's documents, by positionId. No depth cap and no depth-based refusal.
   *
   *  - The walk holds the page's keys and nothing else; rows before it are
   *    counted and dropped. It yields to the event loop every 1,000 rows and
   *    reserves the global read budget before every 2,000 (lane `deep`),
   *    waiting for it up to the page's deadline (`maxTimeMS`, default 5 s).
   *    A walk of more than 1,000 rows also holds one of this process's long-
   *    walk slots. Running out of the deadline — Mongo's `maxTimeMS` or the
   *    budget — is a 503 + Retry-After, exactly like a timed-out page.
   *  - A shard that fails is DROPPED (`missingChains`) and the page is the
   *    merged order of the others; only when every shard fails does it throw.
   *  - Rungs are recorded only for a walk over every shard of a cacheable,
   *    collated query (the uncollated shapes read every key in Node anyway).
   *  - Identical concurrent requests share one walk.
   */
  async findLeaderboardDeep(
    queries: LeaderboardQuery[],
    options: { maxTimeMS?: number } = {},
  ): Promise<DeepLeaderboardPage> {
    this.lastUserReadAt = Date.now();
    const first = queries[0];
    if (!first) return { positions: [], hasMore: false, cache: 'miss', missingChains: [], errors: [] };
    const settled = await Promise.allSettled(queries.map((query) => this.leaderboardPlan(query)));
    const plans: LeaderboardPlan[] = [];
    const missingChains: number[] = [];
    const errors: Array<{ chainId: number; error: unknown }> = [];
    settled.forEach((result, i) => {
      if (result.status === 'fulfilled') plans.push(result.value);
      else {
        missingChains.push(queries[i]!.chainId);
        errors.push({ chainId: queries[i]!.chainId, error: result.reason });
      }
    });
    if (plans.length === 0) throw deepReadError(errors[0]?.error);

    const skip = (first.page - 1) * first.limit;
    const flightKey = `${plans.map((plan) => plan.key).join('||')}|${skip}|${first.limit}`;
    let flight = this.deepInFlight.get(flightKey);
    if (!flight) {
      flight = this.walkLeaderboard(plans, skip, first.limit, options.maxTimeMS ?? READ_MAX_TIME_MS.find).finally(
        () => this.deepInFlight.delete(flightKey),
      );
      this.deepInFlight.set(flightKey, flight);
    }
    const page = await flight;
    if (missingChains.length === 0) return page;
    return {
      ...page,
      missingChains: [...missingChains, ...page.missingChains],
      errors: [...errors, ...page.errors],
    };
  }

  private async walkLeaderboard(
    plans: LeaderboardPlan[],
    skip: number,
    limit: number,
    maxTimeMS: number,
  ): Promise<DeepLeaderboardPage> {
    const head = plans[0]!;
    const spec: SortSpec = {
      field: head.sortField,
      direction: head.sortDirection,
      tieField: 'positionId',
      tieDirection: head.tieDirection,
      collated: true,
    };
    const ladderable = this.ladder && plans.every((plan) => plan.collated && plan.cacheable);
    const page = await serveDeepPage<SortKeyRow, Position>({
      shards: (chains, deadlineAt) =>
        plans.filter((plan) => chains.includes(plan.chainId)).map((plan) => this.deepShard(plan, spec, deadlineAt)),
      chains: plans.map((plan) => plan.chainId),
      spec,
      skip,
      limit,
      maxTimeMS,
      ladder: ladderable ? { store: this.ladder!, key: `pos|${plans.map((plan) => plan.key).join('||')}` } : undefined,
      budget: this.budget,
      config: this.config,
      fetch: (rows, deadlineAt) => this.fetchPageDocs(plans, rows, deadlineAt),
      route: 'positions-deep',
    });
    return {
      positions: page.docs,
      hasMore: page.hasMore,
      ...(page.total !== undefined ? { total: page.total } : {}),
      cache: 'miss',
      missingChains: page.missingChains,
      errors: page.errors,
      ...(page.dataAsOf !== undefined ? { dataAsOf: page.dataAsOf } : {}),
    };
  }

  /** One shard of a deep walk: a seek from the boundary (collated), or its sorted keys (uncollated). */
  private deepShard(plan: LeaderboardPlan, spec: SortSpec, deadlineAt: number): DeepShard<SortKeyRow> {
    const model = this.model(plan.chainId, plan.protocol);
    return {
      chainId: plan.chainId,
      open: (boundary: SortBoundary | null, needed: number): MergeSource<SortKeyRow> => {
        if (!plan.collated) {
          return lazySource(plan.chainId, async () =>
            rowsAfter(spec, await this.readSortedKeys(plan, remainingMs(deadlineAt)), boundary, plan.chainId),
          );
        }
        const projection = { _id: 0, positionId: 1, [plan.sortField]: 1 };
        return segmentedSource<SortKeyRow>(plan.chainId, seekSegments(spec, boundary, plan.chainId), needed, (segment, limit) =>
          this.withHint(plan.chainId, plan.protocol, plan.hint, async (hint) => {
            let q = model
              .find(segment ? withClause(plan.filter, segment) : plan.filter)
              .select(projection)
              .sort({ [plan.sortField]: plan.sortDirection, positionId: plan.tieDirection })
              .collation(LEADERBOARD_COLLATION);
            if (hint) q = q.hint(hint);
            const cursor = q
              .limit(limit)
              .batchSize(Math.min(DEEP_BATCH_ROWS, limit))
              .read(USER_READ_PREFERENCE)
              .maxTimeMS(remainingMs(deadlineAt))
              .lean<SortKeyRow[]>()
              .cursor();
            try {
              const firstRow = (await cursor.next()) as SortKeyRow | null;
              return { cursor: cursor as unknown as { next(): Promise<SortKeyRow | null>; close(): Promise<unknown> }, first: firstRow ?? null };
            } catch (err) {
              await cursor.close().catch(() => undefined);
              throw err;
            }
          }),
        );
      },
    };
  }

  /**
   * The documents of a deep page's keys, one `positionId $in` per shard (the
   * unique index), in the walk's order. A shard whose read fails is reported
   * missing; its rows leave the page.
   */
  private async fetchPageDocs(
    plans: LeaderboardPlan[],
    rows: Array<{ chainId: number; row: SortKeyRow }>,
    deadlineAt: number,
  ): Promise<{ docs: Position[]; missingChains: number[]; errors: Array<{ chainId: number; error: unknown }> }> {
    const byChain = new Map<number, string[]>();
    for (const { chainId, row } of rows) {
      const ids = byChain.get(chainId) ?? [];
      ids.push(String(row.positionId));
      byChain.set(chainId, ids);
    }
    const protocolOf = new Map(plans.map((plan) => [plan.chainId, plan.protocol]));
    const found = new Map<string, Position>();
    const missingChains: number[] = [];
    const errors: Array<{ chainId: number; error: unknown }> = [];
    await Promise.all(
      [...byChain].map(async ([chainId, ids]) => {
        const protocol = protocolOf.get(chainId)!;
        try {
          const docs = await this.withHint(chainId, protocol, POSITION_ID_INDEX, (hint) => {
            let q = this.model(chainId, protocol)
              .find({ chainId, protocol, positionId: { $in: ids } })
              .select(this.listProjection());
            if (hint) q = q.hint(hint);
            return q.read(USER_READ_PREFERENCE).maxTimeMS(remainingMs(deadlineAt)).lean<Position[]>();
          });
          for (const doc of docs) found.set(`${chainId}:${String(doc.positionId)}`, doc);
        } catch (error) {
          missingChains.push(chainId);
          errors.push({ chainId, error });
        }
      }),
    );
    const docs = rows
      .map(({ chainId, row }) => found.get(`${chainId}:${String(row.positionId)}`))
      .filter((doc): doc is Position => doc !== undefined);
    return { docs, missingChains, errors };
  }

  /**
   * A window whose request-path read hit its `maxTimeMS` with nothing retained:
   * read it once more in the background with `WINDOW_RESCUE_MAX_TIME_MS`, so it
   * lands in the cache and the next request is a hit. Without this a filter
   * slower than the request budget (any ranked filter the warmup does not
   * cover, before the Set R indexes) is a 503 on every request forever — each
   * retry runs the same doomed read and is killed the same way.
   *
   * Bounded: single-flight per window (the cache's in-flight load), at most
   * `MAX_WINDOW_RESCUES` per process, and a window whose rescue ALSO timed out
   * is not rescued again for `WINDOW_RESCUE_FAILED_MS`. Returns the
   * `Retry-After` the 503 should carry.
   */
  private rescueWindow(key: string, plan: LeaderboardPlan, windowRows: number): number {
    const failedUntil = this.rescueFailedUntil.get(key);
    if (failedUntil !== undefined) {
      if (failedUntil > Date.now()) return RESCUE_FAILED_RETRY_AFTER_SECONDS;
      this.rescueFailedUntil.delete(key);
    }
    if (!plan.cacheable || this.rescuesInFlight >= MAX_WINDOW_RESCUES) return QUERY_TIMEOUT_RETRY_AFTER_SECONDS;
    this.rescuesInFlight++;
    const started = this.windows.refreshInBackground(
      key,
      async () => {
        try {
          // A rescue is a non-page read: it waits its turn in the global read
          // budget (an exhausted budget is not the query's failure — the next
          // timed-out request starts another).
          await this.budget?.reserve(windowRows + 1, {
            deadlineAt: Date.now() + WINDOW_RESCUE_MAX_TIME_MS,
            lane: 'rescue',
          });
          const startedAt = Date.now();
          try {
            return await this.readLeaderboardRows(plan, 0, windowRows + 1, WINDOW_RESCUE_MAX_TIME_MS);
          } finally {
            // A rescue is by definition a SLOW read: its database time, not its 1,001 rows, is its cost.
            this.budget?.chargeTime(Date.now() - startedAt, windowRows + 1, 'rescue');
          }
        } catch (err) {
          if (isMaxTimeMSExpired(err)) {
            if (this.rescueFailedUntil.size >= 1_000) this.rescueFailedUntil.clear();
            this.rescueFailedUntil.set(key, Date.now() + WINDOW_RESCUE_FAILED_MS);
            this.logger.warn(
              `[alert] leaderboard.rescue_timed_out chain=${plan.chainId} shape=${plan.shape} ` +
                `budget=${WINDOW_RESCUE_MAX_TIME_MS}ms — this filter answers 503 until an index serves it`,
            );
          }
          throw err;
        } finally {
          this.rescuesInFlight--;
        }
      },
      { shouldStore: () => plan.cacheable },
    );
    // Not started: a read for this window is already in flight, or the cache's
    // background slots are full. The loader never ran, so release the slot here.
    if (!started) this.rescuesInFlight--;
    return started ? RESCUE_RETRY_AFTER_SECONDS : QUERY_TIMEOUT_RETRY_AFTER_SECONDS;
  }

  /**
   * Refresh the window a query's page lives in NOW (the warmup timer), with its
   * own time budget, and return it so it can be snapshotted. Shares an
   * in-flight read with any request for the same window.
   */
  async warmLeaderboardWindow(
    query: LeaderboardQuery,
    maxTimeMS: number,
  ): Promise<{ key: string; rows: Position[]; total?: number } | null> {
    const windowRows = listWindowRows(query.page, query.limit);
    if (windowRows === null) return null;
    const plan = await this.leaderboardPlan(query);
    if (!plan.cacheable) return null;
    const key = `${plan.key}|w${windowRows}`;
    const window = await this.windows.refresh(key, () => this.readLeaderboardRows(plan, 0, windowRows + 1, maxTimeMS));
    return { key, rows: window.rows, total: window.total };
  }

  /** Epoch ms of the last user leaderboard read in this process (0 = none yet). */
  get lastLeaderboardReadAt(): number {
    return this.lastUserReadAt;
  }

  /**
   * How old the cached window a query's page lives in is, or undefined when
   * there is none still servable (missing, or past its stale age).
   */
  async leaderboardWindowAgeMs(query: LeaderboardQuery): Promise<number | undefined> {
    const windowRows = listWindowRows(query.page, query.limit);
    if (windowRows === null) return undefined;
    const plan = await this.leaderboardPlan(query);
    return this.windows.peek(`${plan.key}|w${windowRows}`)?.ageMs;
  }

  /**
   * The cached window a query's page lives in, while still servable (not past
   * its stale age), with when it was stored. NO read: with leases on, the
   * leaderboard warmup's holder snapshots a window a request here refreshed,
   * so the followers' copies do not expire (`LeaderboardWarmupService`).
   */
  async peekLeaderboardWindow(
    query: LeaderboardQuery,
  ): Promise<{ key: string; rows: Position[]; total?: number; storedAt: number } | undefined> {
    const windowRows = listWindowRows(query.page, query.limit);
    if (windowRows === null) return undefined;
    const plan = await this.leaderboardPlan(query);
    if (!plan.cacheable) return undefined;
    const key = `${plan.key}|w${windowRows}`;
    const entry = this.windows.peekRetained(key);
    if (!entry || entry.pastStale) return undefined;
    return { key, rows: entry.value.rows, total: entry.value.total, storedAt: entry.storedAt };
  }

  /** The window cache key a query's page lives under (for snapshot loading). */
  async leaderboardWindowKey(query: LeaderboardQuery): Promise<string | null> {
    const windowRows = listWindowRows(query.page, query.limit);
    if (windowRows === null) return null;
    return `${(await this.leaderboardPlan(query)).key}|w${windowRows}`;
  }

  /** Seed a window from a snapshot computed elsewhere, aged from when it was computed. */
  primeLeaderboardWindow(key: string, rows: Position[], storedAt: number, total?: number): boolean {
    return this.windows.set(key, { rows, total }, { storedAt });
  }

  /**
   * The match count for a query, capped at `cap` (`countDocuments` stops there,
   * so a broad filter costs at most `cap` index entries). Same filter and same
   * collation choice as the find — the uncollated count the page used to await
   * picked bad plans (10.5 s on a 430k-document shard) — but its OWN index,
   * `plan.countHint`: a count serves no sort, so a ranked count is hinted by
   * what bounds the scan rather than by the sort (see `countHint`). Never on a
   * page's critical path: `LeaderboardCountService` caches it.
   */
  async countLeaderboard(
    plan: LeaderboardPlan,
    cap: number,
    maxTimeMS: number = READ_MAX_TIME_MS.count,
  ): Promise<LeaderboardCount> {
    try {
      const count = await this.withHint(plan.chainId, plan.protocol, plan.countHint, (hint) => {
        let q = this.model(plan.chainId, plan.protocol).countDocuments(plan.filter, { limit: cap });
        if (plan.collated) q = q.collation(LEADERBOARD_COLLATION);
        if (hint) q = q.hint(hint);
        return q.read(USER_READ_PREFERENCE).maxTimeMS(maxTimeMS).exec();
      });
      return { count, capped: count >= cap };
    } catch (err) {
      throw isMaxTimeMSExpired(err) ? new QueryTimeoutException() : err;
    }
  }

  /**
   * Read rows `[skip, skip + n)` for a plan. Collated shapes sort in Mongo; the
   * uncollated ones (`lookup`, `pool`) sort in Node with the merge comparator,
   * because without the collation Mongo would order the numeric-string ids
   * lexicographically ("10" < "9") — and they also learn the exact match count
   * for free.
   */
  private async readLeaderboardRows(
    plan: LeaderboardPlan,
    skip: number,
    n: number,
    maxTimeMS: number,
  ): Promise<LeaderboardWindow> {
    const model = this.model(plan.chainId, plan.protocol);

    if (plan.collated) {
      const rows = await this.withHint(plan.chainId, plan.protocol, plan.hint, (hint) => {
        let q = model
          .find(plan.filter)
          .select(this.listProjection())
          .sort({ [plan.sortField]: plan.sortDirection, positionId: plan.tieDirection })
          .collation(LEADERBOARD_COLLATION);
        if (hint) q = q.hint(hint);
        return q.skip(skip).limit(n).read(USER_READ_PREFERENCE).maxTimeMS(maxTimeMS).lean<Position[]>();
      });
      return { rows };
    }

    if (plan.shape === 'lookup') {
      // An exact id matches at most a couple of rows: read them whole.
      const rows = (await this.readSortedKeys(plan, maxTimeMS)) as unknown as Position[];
      return { rows: rows.slice(skip, skip + n), total: rows.length };
    }

    // Pool scope: rank the pool's matches on their sort keys alone, then read
    // only the window's rows whole. Mongo would have fetched and sorted every
    // match in memory anyway — no index serves this sort — so this moves the
    // same work into Node and ships a fraction of the bytes.
    const keys = await this.readSortedKeys(plan, maxTimeMS);
    const wanted = keys.slice(skip, skip + n).map((row) => String(row.positionId));
    if (wanted.length === 0) return { rows: [], total: keys.length };
    const docs = await this.withHint(plan.chainId, plan.protocol, POSITION_ID_INDEX, (hint) => {
      let docsQuery = model
        .find({ chainId: plan.chainId, protocol: plan.protocol, positionId: { $in: wanted } })
        .select(this.listProjection());
      if (hint) docsQuery = docsQuery.hint(hint);
      return docsQuery.read(USER_READ_PREFERENCE).maxTimeMS(maxTimeMS).lean<Position[]>();
    });
    const byId = new Map(docs.map((doc) => [String(doc.positionId), doc]));
    const rows = wanted.map((id) => byId.get(id)).filter((doc): doc is Position => doc !== undefined);
    return { rows, total: keys.length };
  }

  /**
   * Every match of an UNCOLLATED plan (`lookup`, `pool`), in the shard's order
   * (`leaderboardRowComparator` — Mongo cannot order the digit-string ids
   * without the collation): whole rows for a lookup (a couple at most), sort
   * keys for a pool (bounded by the pool's positions).
   */
  private async readSortedKeys(plan: LeaderboardPlan, maxTimeMS: number): Promise<SortKeyRow[]> {
    const model = this.model(plan.chainId, plan.protocol);
    const compare = leaderboardRowComparator(plan.sortField, plan.sortDirection, plan.tieDirection);
    let rows: SortKeyRow[];
    if (plan.shape === 'lookup') {
      rows = await model
        .find(plan.filter)
        .select(this.listProjection())
        .read(USER_READ_PREFERENCE)
        .maxTimeMS(maxTimeMS)
        .lean<SortKeyRow[]>();
    } else {
      rows = await this.withHint(plan.chainId, plan.protocol, plan.hint, (hint) => {
        let keysQuery = model.find(plan.filter, { _id: 0, positionId: 1, tokenId: 1, [plan.sortField]: 1 });
        if (hint) keysQuery = keysQuery.hint(hint);
        return keysQuery.read(USER_READ_PREFERENCE).maxTimeMS(maxTimeMS).lean<SortKeyRow[]>();
      });
    }
    rows.sort(compare);
    return rows;
  }

  /**
   * `filter` as MongoDB receives it: cast through the shard's Mongoose model
   * (P-R R3 compiles the CAST filter, never a re-derivation). A model without
   * `cast` (spec doubles) returns the filter as is; a cast that throws throws
   * — the Mongo path would fail the same way.
   */
  castFilter(chainId: number, protocol: string, filter: Record<string, unknown>): Record<string, unknown> {
    const query = this.model(chainId, protocol).find(filter) as unknown as { cast?: () => Record<string, unknown> };
    return typeof query?.cast === 'function' ? query.cast() : filter;
  }

  /** The native handle a raw command needs (absent on spec doubles). */
  private nativeOf(chainId: number, protocol: string): { db: NativeDb; collection: string } | undefined {
    const model = this.model(chainId, protocol) as unknown as { db?: { db?: NativeDb }; collection?: { collectionName?: string } };
    const db = model.db?.db;
    const collection = model.collection?.collectionName;
    return db && typeof db.command === 'function' && collection ? { db, collection } : undefined;
  }

  /**
   * A page's documents by `positionId` (the unique index), for a page the rank
   * engine ordered (P-R R3, design §6.7): `LIST_PROJECTION`, `secondaryPreferred`,
   * and with `atClusterTime` a `readConcern: snapshot` at that clusterTime — the
   * page's rows as of the same instant as its order and filter. A RAW command:
   * the driver's find helpers drop `atClusterTime` from a readConcern (R2,
   * verified on the rig). A snapshot the server cannot serve (older than its
   * history window, ahead of its clusterTime, a standalone) falls back to a
   * plain read — today's deep-page behaviour — and `meta.snapshotFallback`
   * says so; a shard without the positionId index is read unhinted. Order is
   * the caller's; a missing document is simply absent.
   */
  async findListRowsByIds(
    chainId: number,
    protocol: string,
    positionIds: readonly string[],
    options: { atClusterTime?: { t: number; i: number }; maxTimeMS?: number; meta?: { snapshotFallback?: boolean } } = {},
  ): Promise<Position[]> {
    if (positionIds.length === 0) return [];
    const filter = { chainId, protocol, positionId: { $in: [...positionIds] } };
    const maxTimeMS = options.maxTimeMS ?? READ_MAX_TIME_MS.find;
    const native = options.atClusterTime ? this.nativeOf(chainId, protocol) : undefined;
    if (native && options.atClusterTime) {
      const atClusterTime = options.atClusterTime;
      try {
        const reply = await this.withHint(chainId, protocol, POSITION_ID_INDEX, (hint) =>
          native.db.command(
            {
              find: native.collection,
              filter,
              projection: this.listProjection(),
              ...(hint ? { hint } : {}),
              batchSize: positionIds.length + 1,
              singleBatch: true,
              readConcern: { level: 'snapshot', atClusterTime: clusterTimestamp(atClusterTime) },
              maxTimeMS,
            },
            { readPreference: USER_READ_PREFERENCE },
          ),
        );
        return ((reply as { cursor?: { firstBatch?: Position[] } }).cursor?.firstBatch ?? []) as Position[];
      } catch (err) {
        if (isMaxTimeMSExpired(err)) throw new QueryTimeoutException();
        if (!isSnapshotReadError(err)) throw err;
        if (options.meta) options.meta.snapshotFallback = true;
      }
    }
    try {
      return await this.withHint(chainId, protocol, POSITION_ID_INDEX, (hint) => {
        let q = this.model(chainId, protocol).find(filter).select(this.listProjection());
        if (hint) q = q.hint(hint);
        return q.read(USER_READ_PREFERENCE).maxTimeMS(maxTimeMS).lean<Position[]>();
      });
    } catch (err) {
      throw isMaxTimeMSExpired(err) ? new QueryTimeoutException() : err;
    }
  }

  /**
   * The rank engine's lane-A reference (P-R R3, design §7.1): one shard's
   * answer to the CAST filter at `atClusterTime` (`readConcern: snapshot`), on
   * a SECONDARY (it fails rather than loads the primary).
   *  - collated shapes (`ranked`, `owner`): `{positionId, <field>}` of rows
   *    `[skip, skip + limit)` in the leaderboard sort under the collation, and
   *    the count capped at `cap` (`countDocuments({limit})` semantics);
   *  - uncollated shapes (`pool`, `lookup`): every match's sort key, ordered in
   *    Node with `leaderboardRowComparator` (exactly `readSortedKeys` — a
   *    `$sort` without the collation would order '10' before '9'), sliced, and
   *    the EXACT match count (those shapes' pages carry their total).
   * Throws `SnapshotUnavailableError` when the server cannot read at that time.
   */
  async snapshotReference(
    chainId: number,
    protocol: string,
    args: {
      filter: Record<string, unknown>;
      collated: boolean;
      sortField: string;
      sortDirection: 1 | -1;
      tieDirection: 1 | -1;
      skip: number;
      limit: number;
      cap: number;
      atClusterTime: { t: number; i: number };
      maxTimeMS: number;
    },
  ): Promise<PositionsSnapshotReference> {
    const native = this.nativeOf(chainId, protocol);
    if (!native) throw new SnapshotUnavailableError(new Error('no native handle'));
    const readConcern = { level: 'snapshot', atClusterTime: clusterTimestamp(args.atClusterTime) };
    const options = { readPreference: SECONDARY_ONLY_READ_PREFERENCE };
    try {
      if (!args.collated) {
        const reply = await native.db.command(
          {
            find: native.collection,
            filter: args.filter,
            projection: { _id: 0, positionId: 1, tokenId: 1, [args.sortField]: 1 },
            batchSize: 100_000,
            singleBatch: true,
            readConcern,
            maxTimeMS: args.maxTimeMS,
          },
          options,
        );
        const rows = ((reply as { cursor?: { firstBatch?: Array<Record<string, unknown>> } }).cursor?.firstBatch ?? []).sort(
          leaderboardRowComparator(args.sortField, args.sortDirection, args.tieDirection),
        );
        return {
          rows: rows.slice(args.skip, args.skip + args.limit).map((row) => ({ positionId: row.positionId, tokenId: row.tokenId, value: valueAtPath(row, args.sortField) })),
          count: rows.length,
        };
      }
      const [found, counted] = await Promise.all([
        native.db.command(
          {
            find: native.collection,
            filter: args.filter,
            sort: { [args.sortField]: args.sortDirection, positionId: args.tieDirection },
            collation: LEADERBOARD_COLLATION,
            projection: { _id: 0, positionId: 1, [args.sortField]: 1 },
            ...(args.skip > 0 ? { skip: args.skip } : {}),
            limit: Math.max(1, args.limit),
            batchSize: Math.max(1, args.limit),
            singleBatch: true,
            readConcern,
            maxTimeMS: args.maxTimeMS,
          },
          options,
        ),
        native.db.command(
          {
            aggregate: native.collection,
            pipeline: [{ $match: args.filter }, { $limit: args.cap }, { $count: 'n' }],
            collation: LEADERBOARD_COLLATION,
            cursor: {},
            readConcern,
            maxTimeMS: args.maxTimeMS,
          },
          options,
        ),
      ]);
      const rows = ((found as { cursor?: { firstBatch?: Array<Record<string, unknown>> } }).cursor?.firstBatch ?? []).map((row) => ({
        positionId: row.positionId,
        value: valueAtPath(row, args.sortField),
      }));
      const first = (counted as { cursor?: { firstBatch?: Array<{ n?: number }> } }).cursor?.firstBatch?.[0];
      return { rows: args.limit > 0 ? rows : [], count: Number(first?.n ?? 0) };
    } catch (err) {
      if (isSnapshotReadError(err)) throw new SnapshotUnavailableError(err);
      throw err;
    }
  }

  /**
   * Holder counts of `poolIds` at `atClusterTime` (the rank engine's lane A,
   * P-R R3): exactly `aggregatePoolCounts`' pipeline — open positions per
   * pool and the distinct owners among them, binary — as a raw snapshot read
   * on a SECONDARY. Absent = 0/0, as `countsByPoolIds`.
   */
  async snapshotPoolCounts(
    chainId: number,
    protocol: string,
    poolIds: readonly string[],
    args: { atClusterTime: { t: number; i: number }; maxTimeMS: number },
  ): Promise<Map<string, PoolPositionCounts>> {
    const native = this.nativeOf(chainId, protocol);
    if (!native) throw new SnapshotUnavailableError(new Error('no native handle'));
    const ids = Array.from(new Set(poolIds.map((p) => p.toLowerCase())));
    try {
      const reply = await native.db.command(
        {
          aggregate: native.collection,
          pipeline: [
            { $match: { chainId, protocol, poolId: { $in: ids }, isActive: true } },
            { $group: { _id: '$poolId', positionsCount: { $sum: 1 }, owners: { $addToSet: '$owner' } } },
            { $project: { positionsCount: 1, holdersCount: { $size: '$owners' } } },
          ],
          cursor: {},
          readConcern: { level: 'snapshot', atClusterTime: clusterTimestamp(args.atClusterTime) },
          maxTimeMS: args.maxTimeMS,
        },
        { readPreference: SECONDARY_ONLY_READ_PREFERENCE },
      );
      const out = new Map<string, PoolPositionCounts>();
      for (const row of (reply as { cursor?: { firstBatch?: Array<{ _id: unknown; positionsCount: number; holdersCount: number }> } }).cursor?.firstBatch ?? []) {
        const counts = { positionsCount: row.positionsCount ?? 0, holdersCount: row.holdersCount ?? 0 };
        if (counts.positionsCount > 0 || counts.holdersCount > 0) out.set(String(row._id).toLowerCase(), counts);
      }
      return out;
    } catch (err) {
      if (isSnapshotReadError(err)) throw new SnapshotUnavailableError(err);
      throw err;
    }
  }

  async findOne(chainId: number, protocol: string, positionId: string): Promise<Position | null> {
    return this.model(chainId, protocol)
      .findOne({ chainId, protocol, positionId })
      .lean<Position | null>();
  }

  /**
   * `findOne` for the USER read path (position detail and charts): projected,
   * secondary-preferred, 2 s budget, a timeout surfacing as a 503. Workers keep
   * `findOne` above — primary reads, full document, no time limit.
   */
  async findOneForRead(
    chainId: number,
    protocol: string,
    positionId: string,
    projection: Readonly<Record<string, 0 | 1>> = DETAIL_PROJECTION,
  ): Promise<Position | null> {
    try {
      return await this.model(chainId, protocol)
        .findOne({ chainId, protocol, positionId })
        .select({ ...projection })
        .read(USER_READ_PREFERENCE)
        .maxTimeMS(READ_MAX_TIME_MS.findOne)
        .lean<Position | null>();
    } catch (err) {
      throw isMaxTimeMSExpired(err) ? new QueryTimeoutException() : err;
    }
  }

  async countByPoolId(chainId: number, protocol: string, poolId: string): Promise<number> {
    return this.model(chainId, protocol).countDocuments({
      chainId,
      protocol,
      poolId: poolId.toLowerCase(),
    });
  }

  /**
   * OPEN-position count + distinct-owner ("holder") count for many pools in a
   * single aggregation (per shard) — used to enrich the pools list/detail.
   * Keyed by lowercased poolId; pools with no open positions are simply absent
   * (callers default to 0/0). Only `isActive: true` positions count, so the
   * numbers reflect live LP participation, not historical churn.
   *
   * Cached per pool (a zero is cached too). A fresh value is served; a stale or
   * retained one (up to `POOL_COUNTS_FALLBACK_MS`) is served AND refreshed in
   * the background with `POOL_COUNTS_BACKGROUND_MAX_TIME_MS` — the heaviest
   * pools on the largest shard can never count inside the request's 3 s, and
   * they are exactly the top-TVL pools every landing view shows. Only a pool
   * with nothing retained is aggregated on the request path; if that times out
   * its entry is `null` — "not known yet" — and it is counted in the
   * background, so a pools list whose rows are already in hand is never a 503
   * (nor a fabricated 0/0) because of its counts.
   */
  async countsByPoolIds(
    chainId: number,
    protocol: string,
    poolIds: string[],
    // `dataAsOf`: the OLDEST data time of any count served older than the
    // staleness budget (kept past its stale age, or read from a lagging
    // secondary), so the response can say `stale`. `storedAt` / `dataAt`: the
    // oldest load time / data time of every count served — a value composed
    // from them (pool detail) is no younger than they are.
    meta?: PoolCountsMeta,
  ): Promise<Map<string, PoolPositionCounts | null>> {
    const out = new Map<string, PoolPositionCounts | null>();
    const ids = Array.from(new Set(poolIds.map((p) => p.toLowerCase())));
    if (ids.length === 0) return out;
    const put = (id: string, counts: PoolPositionCounts) => {
      if (counts.positionsCount > 0 || counts.holdersCount > 0) out.set(id, counts);
    };
    const budgetMs = stalenessBudgetMs(this.config);
    // The oldest count served whose DATA is older than the budget (a lagging
    // secondary, or a count kept past its stale age) — the response says so.
    const flag = (dataAt: number) => {
      if (meta) meta.dataAsOf = Math.min(meta.dataAsOf ?? Infinity, dataAt);
    };
    const served = (storedAt: number, dataAt: number) => {
      if (!meta) return;
      meta.storedAt = Math.min(meta.storedAt ?? Infinity, storedAt);
      meta.dataAt = Math.min(meta.dataAt ?? Infinity, dataAt);
    };

    // Counts another process computed within the stale age first: one MGET
    // instead of a `$group` per process per pool.
    await this.adoptSharedPoolCounts(chainId, protocol, ids);

    const missing: string[] = [];
    const revalidate: string[] = [];
    for (const id of ids) {
      const cached = this.poolCounts.peek(this.poolCountsKey(chainId, protocol, id));
      if (cached?.status === 'hit') {
        put(id, cached.value);
        served(Date.now() - cached.ageMs, cached.dataAt);
        if (staleSince(cached.dataAt, budgetMs) !== undefined) flag(cached.dataAt);
        continue;
      }
      // Stale, or past its stale age but still retained: served, and recounted.
      // Past the stale age it is older than the budget: flagged via `meta`.
      const retained = this.poolCounts.peekRetained(this.poolCountsKey(chainId, protocol, id));
      if (retained) {
        put(id, retained.value);
        served(retained.storedAt, retained.dataAt);
        if (retained.pastStale || staleSince(retained.dataAt, budgetMs) !== undefined) flag(retained.dataAt);
        revalidate.push(id);
        continue;
      }
      if (this.poolCountsInFlight.has(this.poolCountsKey(chainId, protocol, id))) {
        out.set(id, null); // being counted in the background right now
        continue;
      }
      missing.push(id);
    }
    if (revalidate.length > 0) this.refreshPoolCountsInBackground(chainId, protocol, revalidate);
    if (missing.length === 0) return out;

    try {
      const counted = await this.aggregatePoolCounts(
        chainId,
        protocol,
        missing,
        READ_MAX_TIME_MS.countsByPoolIds,
        POOL_COUNTS_BUDGET_WAIT_MS,
      );
      for (const id of missing) put(id, counted.get(id)!);
      // Counted just now — from a secondary as far behind as the lag.
      const countedAt = Date.now();
      const dataAt = countedAt - userReadLagMs(countedAt);
      served(countedAt, dataAt);
      if (staleSince(dataAt, budgetMs) !== undefined) flag(dataAt);
    } catch (err) {
      if (!isMaxTimeMSExpired(err) && !(err instanceof ReadBudgetTimeoutError)) throw err;
      this.logger.warn(
        `[alert] pools.counts_deferred chain=${chainId} pools=${missing.length} — counting in the background ` +
          `(${POOL_COUNTS_BACKGROUND_MAX_TIME_MS}ms budget); served as null meanwhile` +
          (err instanceof ReadBudgetTimeoutError ? ' (read budget busy)' : ''),
      );
      for (const id of missing) out.set(id, null);
      this.refreshPoolCountsInBackground(chainId, protocol, missing);
    }
    return out;
  }

  private poolCountsKey(chainId: number, protocol: string, poolId: string): string {
    return `${chainId}:${protocol}:${poolId}`;
  }

  /** The Redis key of a pool's shared holder counts (namespaced by deployment). */
  private sharedPoolCountsKey(chainId: number, protocol: string, poolId: string): string {
    return `tw:pc:v1:${this.redis?.namespace ?? 'local'}:${chainId}:${protocol}:${poolId}`;
  }

  /**
   * Scale plan 1.11 (interim, until the rank engine keeps per-pool counts):
   * holder counts are SHARED through Redis. Whichever process counts a pool
   * publishes `{counts, computedAt, dataAt}` with a TTL of the list stale age
   * (30 s — the plan's 45 s, tightened so an adopted count is never served
   * past the stale age it would have locally); every other process adopts it
   * here, BACKDATED to when it was computed, so its age keeps counting from
   * the count and not from the adoption. One MGET for the page's pools not
   * fresh locally; fail-open (Redis off or down = each process counts alone).
   * Phase 2's leases make the counting itself leader-only.
   */
  private async adoptSharedPoolCounts(chainId: number, protocol: string, ids: string[]): Promise<void> {
    const want = ids.filter((id) => this.poolCounts.peek(this.poolCountsKey(chainId, protocol, id))?.status !== 'hit');
    if (want.length === 0) return;
    const client = await this.redis?.client();
    if (!client) return;
    let raw: Array<string | null>;
    try {
      raw = await client.mget(...want.map((id) => this.sharedPoolCountsKey(chainId, protocol, id)));
    } catch (err) {
      this.redis?.logError(err);
      return;
    }
    const staleMs = listCacheTtl(this.config).staleMs;
    const now = Date.now();
    want.forEach((id, i) => {
      const shared = decodeSharedPoolCounts(raw[i]);
      if (!shared || shared.computedAt > now || now - shared.computedAt >= staleMs) return;
      const key = this.poolCountsKey(chainId, protocol, id);
      const local = this.poolCounts.peekRetained(key);
      if (local && local.storedAt >= shared.computedAt) return; // ours is as new
      this.poolCounts.set(key, shared.counts, { storedAt: shared.computedAt, dataAt: shared.dataAt });
    });
  }

  /** Publish freshly computed holder counts for the other processes (fire-and-forget). */
  private publishPoolCounts(
    chainId: number,
    protocol: string,
    counts: Map<string, PoolPositionCounts>,
    computedAt: number,
    dataAt: number,
  ): void {
    if (!this.redis || counts.size === 0) return;
    const ttlMs = listCacheTtl(this.config).staleMs;
    void (async () => {
      const client = await this.redis!.client();
      if (!client) return;
      try {
        const multi = client.multi();
        for (const [id, c] of counts) {
          multi.set(
            this.sharedPoolCountsKey(chainId, protocol, id),
            JSON.stringify({ p: c.positionsCount, h: c.holdersCount, t: computedAt, d: dataAt }),
            'PX',
            ttlMs,
          );
        }
        await multi.exec();
      } catch (err) {
        this.redis!.logError(err);
      }
    })();
  }

  /**
   * One grouped aggregation for `ids` (lowercased), every id stored — a pool
   * with no open position as 0/0. Hinted to the partial `bg_active_pool_owner`
   * index `{chainId, protocol, isActive, poolId, owner}`, so only OPEN
   * positions are read and — both grouped fields being in the key — none is
   * fetched (locally 5,189 keys for the 25 largest chain-1 pools, vs 92,346
   * through the full `poolId` index), falling back to the old `bg_active_pool`
   * (keys, then a fetch per open position), the `poolId` index and then no
   * hint: left to the planner the same `$in + isActive` shape has been seen
   * winning on the `isActive` index and walking every active position of the
   * shard.
   */
  private async aggregatePoolCounts(
    chainId: number,
    protocol: string,
    ids: string[],
    maxTimeMS: number,
    budgetWaitMs: number = maxTimeMS,
  ): Promise<Map<string, PoolPositionCounts>> {
    // A holder count is a non-page read: it reserves the open positions it is
    // expected to read (the last count of each pool, else a default) from the
    // global budget, and repays any surplus once it knows.
    const estimate = ids.reduce(
      (sum, id) =>
        sum + (this.poolCounts.peekRetained(this.poolCountsKey(chainId, protocol, id))?.value.positionsCount ?? POOL_COUNTS_DEFAULT_COST),
      0,
    );
    await this.budget?.reserve(estimate, { deadlineAt: Date.now() + budgetWaitMs, lane: 'pool-counts' });
    const startedAt = Date.now();
    const rows = await this.withHint(chainId, protocol, BG_ACTIVE_POOL_INDEX, (hint) => {
      let agg = this.model(chainId, protocol)
        .aggregate<{ _id: string; positionsCount: number; holdersCount: number }>([
          { $match: { chainId, protocol, poolId: { $in: ids }, isActive: true } },
          { $group: { _id: '$poolId', positionsCount: { $sum: 1 }, owners: { $addToSet: '$owner' } } },
          { $project: { positionsCount: 1, holdersCount: { $size: '$owners' } } },
        ])
        .read(USER_READ_PREFERENCE)
        .option({ maxTimeMS });
      if (hint) agg = agg.hint(hint);
      return agg;
    });
    const found = new Map(rows.map((r) => [String(r._id).toLowerCase(), r]));
    const read = rows.reduce((sum, r) => sum + (r.positionsCount ?? 0), 0);
    if (read > estimate) this.budget?.charge(read - estimate, 'pool-counts');
    // …and the database time beyond what the rows paid for (a FETCH per open
    // position until bg_active_pool_owner is built).
    this.budget?.chargeTime(Date.now() - startedAt, Math.max(read, estimate), 'pool-counts');
    const out = new Map<string, PoolPositionCounts>();
    const computedAt = Date.now();
    const dataAt = computedAt - userReadLagMs(computedAt);
    for (const id of ids) {
      const r = found.get(id);
      const counts = { positionsCount: r?.positionsCount ?? 0, holdersCount: r?.holdersCount ?? 0 };
      this.poolCounts.set(this.poolCountsKey(chainId, protocol, id), counts, { storedAt: computedAt, dataAt });
      out.set(id, counts);
    }
    this.publishPoolCounts(chainId, protocol, out, computedAt, dataAt);
    return out;
  }

  /**
   * Count `ids` off the request path, with the background budget. Pools already
   * being counted are skipped (single-flight per pool), and at most
   * `MAX_POOL_COUNT_REFRESHES` batches run at once; one skipped now is retried
   * by the next request that serves it.
   */
  private refreshPoolCountsInBackground(chainId: number, protocol: string, ids: string[]): void {
    if (this.poolCountRefreshes >= MAX_POOL_COUNT_REFRESHES) return;
    const batch = ids.filter((id) => !this.poolCountsInFlight.has(this.poolCountsKey(chainId, protocol, id)));
    if (batch.length === 0) return;
    const keys = batch.map((id) => this.poolCountsKey(chainId, protocol, id));
    for (const key of keys) this.poolCountsInFlight.add(key);
    this.poolCountRefreshes++;
    this.aggregatePoolCounts(chainId, protocol, batch, POOL_COUNTS_BACKGROUND_MAX_TIME_MS)
      .catch((err) => this.logBackgroundError('pool counts', keys[0]!, err))
      .finally(() => {
        this.poolCountRefreshes--;
        for (const key of keys) this.poolCountsInFlight.delete(key);
      });
  }

  async findManyByPositionIds(
    chainId: number,
    protocol: string,
    positionIds: string[],
  ): Promise<Position[]> {
    if (positionIds.length === 0) return [];
    return this.model(chainId, protocol)
      .find({ chainId, protocol, positionId: { $in: positionIds } })
      .lean<Position[]>();
  }

  async findTrackedTokenIds(
    chainId: number,
    protocol: string,
    tokenIds: string[],
  ): Promise<string[]> {
    if (tokenIds.length === 0) return [];
    const rows = await this.model(chainId, protocol)
      .find({ chainId, protocol, tokenId: { $in: tokenIds } }, { tokenId: 1 })
      .lean<{ tokenId: string }[]>();
    return rows.map((row) => row.tokenId);
  }

  /**
   * Distinct token addresses (token0 + token1, lowercased) across all ACTIVE
   * positions for a (chain, protocol). The token universe the price sweep keeps
   * fresh in `{chainId}_tokens` so position valuation never depends on a single
   * sync's provider luck.
   *
   * Two `distinct`s, one per leg, each hinted to its partial
   * `bg_active_token{0,1}` index `{chainId, protocol, isActive, tokenN.address}`
   * — a DISTINCT_SCAN that touches one key per distinct address and fetches no
   * document. It used to `find` every active document and dedupe in Node: 194k
   * documents on the largest shard, likely the 42 s GETMORE prod reported. The
   * filter is EXACTLY `{chainId, protocol, isActive: true}`, which is what lets
   * the partial indexes qualify — and it must stay so: a hint naming a partial
   * index is OBEYED for a filter that does not imply its expression, and
   * returns the incomplete result without an error (see `rankedHint`).
   *
   * Through the driver's `collection.distinct` on purpose: Mongoose's query
   * builder refuses `.hint()` on a distinct ("hint cannot be used with
   * distinct"), while the server and driver accept it (MongoDB ≥ 7.1).
   *
   * Below 7.1 the server has no such field and rejects the whole command
   * (`IDLUnknownField`, 40415) — not the missing-index BadValue `withHint`
   * handles. Left alone that is a throw on every price sweep, which the sweep
   * logs and answers `{priced: 0}`: prices and the DEX-market verdicts would go
   * stale on every chain with no error anywhere. So that refusal is retried
   * unhinted (the old unhinted read worked on any version), alerted ONCE, and
   * the hint is not sent again by this process.
   */
  async distinctActiveTokenAddresses(chainId: number, protocol: string): Promise<string[]> {
    const filter = { chainId, protocol, isActive: true };
    const collection = this.model(chainId, protocol).collection;
    const distinct = async (field: string, hint: string | undefined): Promise<unknown[]> => {
      if (!hint || this.distinctHintUnsupported) return (await collection.distinct(field, filter)) as unknown[];
      try {
        return (await collection.distinct(field, filter, { hint })) as unknown[];
      } catch (err) {
        if (!isUnsupportedHintError(err)) throw err;
        if (!this.distinctHintUnsupported) {
          this.distinctHintUnsupported = true;
          this.logger.warn(
            `[alert] positions.distinct_hint_unsupported chain=${chainId} protocol=${protocol} — the server ` +
              `rejects 'hint' on distinct (MongoDB < 7.1); the active-token universe runs unhinted from now on`,
          );
        }
        return (await collection.distinct(field, filter)) as unknown[];
      }
    };
    const legs = await Promise.all(
      (['token0', 'token1'] as const).map((leg) =>
        this.withHint(chainId, protocol, BG_ACTIVE_TOKEN_INDEX[leg], (hint) => distinct(`${leg}.address`, hint)),
      ),
    );
    const set = new Set<string>();
    for (const values of legs) {
      for (const value of values) if (typeof value === 'string' && value) set.add(value.toLowerCase());
    }
    return [...set];
  }

  /**
   * Every position document on the shard, open and closed — the collection's
   * metadata count (`estimatedDocumentCount`, the server's `count` with no
   * filter: RECORD_STORE_FAST_COUNT, no index or document read). For
   * `/v1/stats`; it used to be `countDocuments({})`, a COLLSCAN of the whole
   * shard (430k documents / 2.6 s for chain 1 on the M10 rig).
   */
  async estimatedTotal(chainId: number, protocol: string): Promise<number> {
    return this.model(chainId, protocol).estimatedDocumentCount().read(USER_READ_PREFERENCE).maxTimeMS(READ_MAX_TIME_MS.count).exec();
  }

  /**
   * Open positions on the shard, counted on the keys of the partial
   * `bg_active_walk` (a COUNT_SCAN, 0 documents — on the rig 122,524 keys /
   * 31 ms for 4663), on a secondary. The filter is EXACTLY
   * `{chainId, protocol, isActive: true}`, which is what lets the partial index
   * serve it. A shard without the index counts unhinted (`withHint`). For
   * `/v1/stats`, which used the legacy `{chainId, protocol, isActive}` index.
   */
  async countActive(chainId: number, protocol: string): Promise<number> {
    return this.withHint(chainId, protocol, BG_ACTIVE_WALK_INDEX, (hint) => {
      let q = this.model(chainId, protocol)
        .countDocuments({ chainId, protocol, isActive: true })
        .read(USER_READ_PREFERENCE)
        .maxTimeMS(READ_MAX_TIME_MS.count);
      if (hint) q = q.hint(hint);
      return q.exec();
    });
  }

  /**
   * Active positions with their token legs, cursor-paginated. Walks active
   * positions in stable `positionId` ascending order so a refresh tick can
   * cover EVERY active position without a batch cap. Pass the last returned
   * `positionId` as `afterPositionId` to fetch the next page; a page shorter
   * than `pageSize` signals the end. Ordering is byte-wise (no numericOrdering
   * collation) so the `$gt` cursor and the sort agree — every position is
   * visited exactly once even as docs are upserted concurrently.
   *
   * The active walk is hinted to the partial `bg_active_walk` index
   * `{chainId, protocol, isActive, positionId, metrics.performanceReady}`:
   * equality on the first three, the cursor range + sort on `positionId`, and
   * the pending split applied to index keys — so only returned rows are
   * fetched (it used to examine 66,488 documents to return 5,000). The
   * `includeClosed` walk has no `isActive` equality, so the partial index
   * cannot serve it; it stays on the unique `{chainId, protocol, positionId}`
   * index, unhinted.
   */
  async findActiveRefsWithTokensPage(
    chainId: number,
    protocol: string,
    pageSize: number,
    afterPositionId = '',
    options?: { pending?: boolean; includeClosed?: boolean },
  ): Promise<PositionRefWithTokens[]> {
    // includeClosed: the post-backfill recompute sweep walks EVERY row — closed
    // positions otherwise keep stale metrics from old syncs (pre-fix garbage
    // PnL survives forever; the cron's closed pass is far slower).
    const match: Record<string, unknown> = options?.includeClosed
      ? { chainId, protocol }
      : { chainId, protocol, isActive: true };
    if (afterPositionId) match.positionId = { $gt: afterPositionId };
    // Pending = shown as "pending" in the UI (metrics.performanceReady === false).
    // The cron refreshes this subset first; the complement ($ne: false, which
    // also matches docs where the flag is absent) covers all the rest.
    if (options?.pending === true) match['metrics.performanceReady'] = false;
    else if (options?.pending === false) match['metrics.performanceReady'] = { $ne: false };
    type Row = PositionRef & {
      token0?: { address?: string; symbol?: string };
      token1?: { address?: string; symbol?: string };
    };
    const rows = await this.withHint(
      chainId,
      protocol,
      options?.includeClosed ? undefined : BG_ACTIVE_WALK_INDEX,
      (hint) => {
        let q = this.model(chainId, protocol)
          .find(match, {
            positionId: 1,
            tokenId: 1,
            'token0.address': 1,
            'token0.symbol': 1,
            'token1.address': 1,
            'token1.symbol': 1,
          })
          .sort({ positionId: 1 })
          .limit(Math.max(1, pageSize));
        if (hint) q = q.hint(hint);
        return q.lean<Row[]>();
      },
    );
    return rows.map((row) => ({
      positionId: row.positionId,
      tokenId: row.tokenId,
      token0Address: String(row.token0?.address ?? ''),
      token0Symbol: row.token0?.symbol,
      token1Address: String(row.token1?.address ?? ''),
      token1Symbol: row.token1?.symbol,
    }));
  }

  /**
   * Cursor-paginated picker for CLOSED positions whose transaction sync hasn't
   * converged — the closed-position coverage the retired `sync-transactions`
   * cron used to provide, now folded into each refresh tick. Walks in stable
   * `positionId` ascending order (pass the last `positionId` as
   * `afterPositionId`); a page shorter than `pageSize` signals the end.
   *
   * Eligibility (closed + not-yet-synced) is evaluated from PERSISTED fields
   * only — no `$lookup` into the transactions collection — so it stays cheap
   * enough to run unbounded every tick. `txSyncedTransactionCount` is the
   * persisted proxy for "has stored transactions": it is written from the
   * actual collection count at mark-success time (see
   * `markTransactionSyncSuccess`), so a closed position that never stored a
   * row (count 0) is always re-picked until it converges. This also subsumes
   * the retired `/admin/transactions/reset-stuck` repair — a ghost-success
   * row (status=success, count 0) stays eligible automatically.
   */
  async findHotClosedCandidatesPage(
    chainId: number,
    protocol: string,
    pageSize: number,
    afterPositionId = '',
  ): Promise<TransactionSyncCandidate[]> {
    const match: Record<string, unknown> = {
      chainId,
      protocol,
      tokenId: { $regex: /^\d+$/ },
      isActive: false,
      $or: [
        { txFinalizedAt: { $exists: false } },
        { txSyncStatus: { $ne: 'success' } },
        { txLastSuccessAt: { $exists: false } },
        { txSyncedTransactionCount: { $lte: 0 } },
      ],
    };
    if (afterPositionId) match.positionId = { $gt: afterPositionId };
    return this.model(chainId, protocol)
      .find(match, {
        chainId: 1,
        protocol: 1,
        positionId: 1,
        tokenId: 1,
        isActive: 1,
        poolId: 1,
        token0: 1,
        token1: 1,
        txSyncStatus: 1,
        txLastSuccessAt: 1,
        txSyncedTransactionCount: 1,
        txFinalizedAt: 1,
      })
      .sort({ positionId: 1 })
      .limit(Math.max(1, pageSize))
      .lean<TransactionSyncCandidate[]>();
  }

  async markTransactionSyncAttempt(
    chainId: number,
    protocol: string,
    positionIds: string[],
  ): Promise<void> {
    if (positionIds.length === 0) return;

    await this.model(chainId, protocol).updateMany(
      { chainId, protocol, positionId: { $in: positionIds } },
      {
        $set: {
          txSyncStatus: 'pending',
          txLastAttemptAt: new Date(),
        },
        $unset: { txLastError: '' },
      },
    );
  }

  async markTransactionSyncSuccess(
    chainId: number,
    protocol: string,
    positionIds: string[],
    transactionCountsByPositionId?: ReadonlyMap<string, number>,
  ): Promise<void> {
    if (positionIds.length === 0) return;

    const now = new Date();
    const model = this.model(chainId, protocol);
    await Promise.all([
      model.updateMany(
        { chainId, protocol, positionId: { $in: positionIds }, isActive: true },
        {
          $set: {
            txSyncStatus: 'success',
            txLastSuccessAt: now,
          },
          $unset: {
            txFinalizedAt: '',
            txLastFailureAt: '',
            txLastError: '',
          },
        },
      ),
      model.updateMany(
        { chainId, protocol, positionId: { $in: positionIds }, isActive: false },
        {
          $set: {
            txSyncStatus: 'success',
            txLastSuccessAt: now,
            txFinalizedAt: now,
          },
          $unset: {
            txLastFailureAt: '',
            txLastError: '',
          },
        },
      ),
    ]);

    if (transactionCountsByPositionId) {
      await model.bulkWrite(
        positionIds.map((positionId) => ({
          updateOne: {
            filter: { chainId, protocol, positionId },
            update: {
              $set: {
                txSyncedTransactionCount: Math.max(
                  0,
                  transactionCountsByPositionId.get(positionId) ?? 0,
                ),
              },
            },
          },
        })),
        { ordered: false },
      );
    }
  }

  async markTransactionSyncFailure(
    chainId: number,
    protocol: string,
    positionIds: string[],
    error: string,
  ): Promise<void> {
    if (positionIds.length === 0) return;

    await this.model(chainId, protocol).updateMany(
      { chainId, protocol, positionId: { $in: positionIds } },
      {
        $set: {
          txSyncStatus: 'failed',
          txLastFailureAt: new Date(),
          txLastError: error,
        },
        $unset: { txFinalizedAt: '' },
      },
    );
  }

  async updatePerformanceMetrics(
    chainId: number,
    protocol: string,
    updates: PositionPerformanceUpdate[],
  ): Promise<number> {
    if (updates.length === 0) return 0;

    const ops = updates.map((update) => {
      const set: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(update.metrics)) {
        set[`metrics.${key}`] = value;
      }
      for (const [key, value] of Object.entries(update.amounts)) {
        set[`amounts.${key}`] = value;
      }
      return {
        updateOne: {
          filter: { chainId, protocol, positionId: update.positionId },
          // `$unset wh`: this rewrites hashed sections (`metrics`, `amounts`)
          // outside `upsertMany`, so the stored hashes no longer describe the
          // row — the next upsert writes it whole (P2.3, design §4.4).
          update: { $set: set, $unset: { wh: '' } },
        },
      };
    });

    const result = await budgetedBulkWrite(this.model(chainId, protocol), ops, {
      unitsPerOp: WRITE_UNITS.fullUpdate,
      maxOps: this.budgetSettings().maxOps,
      bulkOptions: { ordered: false },
    });
    return result.modifiedCount;
  }

  /**
   * The refresh's stale sweep (Phase E): every ACTIVE position the refresh did
   * not see gets one more `staleMisses`; one that reaches `maxMisses` is closed.
   * Returns how many were closed.
   *
   * Bounded at any shard size. It used to be ONE `updateMany` carrying every
   * seen id in a `$nin` — a command that passes MongoDB's 16 MB BSON limit at
   * ~800k actives (Robinhood heads for ~1.2M) and makes the server test every
   * active document against that list — followed by a `staleMisses >= max`
   * `updateMany` that fetched every active document again. Now:
   *  1. the active ids are STREAMED through a covered query on
   *     `bg_active_walk` (`{chainId, protocol, isActive, positionId, …}`,
   *     partial on actives; projection `positionId` only → index keys, no
   *     document fetch) and diffed in Node against `seen`;
   *  2. the misses are updated in `$in` chunks of `STALE_SWEEP_CHUNK`, and the
   *     close step runs on the same chunk: only a row whose counter this sweep
   *     just moved can newly reach the threshold (every row the refresh saw was
   *     upserted with `staleMisses: 0`).
   *
   * The walk reads a secondary (`USER_READ_PREFERENCE`, maxStaleness 120 s), and
   * that is safe here only because every error it can make is conservative: a
   * row the secondary does not have yet is not counted (it is missed next time
   * instead), and a row it still shows active that the primary has closed or
   * removed matches nothing, because every write filters on `isActive: true`.
   * A refresh that saw nothing sweeps nothing.
   */
  async markMissingStale(
    chainId: number,
    protocol: string,
    seen: ReadonlySet<string>,
    maxMisses: number,
  ): Promise<number> {
    if (seen.size === 0) return 0;

    const model = this.model(chainId, protocol);
    const missing = await this.withHint(chainId, protocol, BG_ACTIVE_WALK_INDEX, async (hint) => {
      // Rebuilt on every attempt: a missing hint fails on the FIRST batch and
      // `withHint` re-runs the walk unhinted.
      const out: string[] = [];
      let q = model.find({ chainId, protocol, isActive: true }, { _id: 0, positionId: 1 }).read(USER_READ_PREFERENCE);
      if (hint) q = q.hint(hint);
      for await (const row of q.lean<{ positionId?: unknown }>().cursor({ batchSize: STALE_SWEEP_BATCH })) {
        const id = String((row as { positionId?: unknown }).positionId ?? '');
        if (id && !seen.has(id)) out.push(id);
      }
      return out;
    });

    const now = new Date();
    let closed = 0;
    for (let i = 0; i < missing.length; i += STALE_SWEEP_CHUNK) {
      const chunk = missing.slice(i, i + STALE_SWEEP_CHUNK);
      // Both `updateMany`s go through the shared write budget (P2.4) like
      // every other budgeted write: each acquires its own units for the lane,
      // is recorded as a chunk of `chunk.length` documents (the controller's
      // latency inputs) and carries the driver's `timeoutMS` — all only while
      // the budget is on; off, they are exactly today's two calls. The closure
      // step is charged per document of the chunk too: it reads every one of
      // them to find the few at the threshold.
      // `$unset wh` on both (P2.3, design §4.4): a counted miss is a full write
      // next time anyway (rule 2), and a closure changes section `i`.
      const units = chunk.length * WRITE_UNITS.staleSweep;
      await budgetedWrite(
        () =>
          model.updateMany(
            { chainId, protocol, isActive: true, positionId: { $in: chunk } },
            { $inc: { staleMisses: 1 }, $set: { lastVerifiedAt: now }, $unset: { wh: '' } },
            ...budgetedTimeoutOptions(),
          ),
        { units, ops: chunk.length },
      );
      const result = await budgetedWrite(
        () =>
          model.updateMany(
            { chainId, protocol, isActive: true, positionId: { $in: chunk }, staleMisses: { $gte: maxMisses } },
            {
              $set: {
                isActive: false,
                closedAtTimestamp: Math.floor(Date.now() / 1000),
                lastVerifiedAt: now,
                txSyncStatus: 'pending',
              },
              $unset: { txFinalizedAt: '', txLastError: '', wh: '' },
            },
            ...budgetedTimeoutOptions(),
          ),
        { units, ops: chunk.length },
      );
      closed += result.modifiedCount;
      if (result.modifiedCount > 0) await this.notifyClosed(model, chainId, protocol, chunk, result.modifiedCount, now);
    }
    return closed;
  }

  /**
   * The stale sweep's closures → the fee store (P3.3 writer hints). When the
   * whole chunk closed, no read; otherwise one read by id finds the rows THIS
   * sweep closed (`isActive: false` + this sweep's `lastVerifiedAt`). Only with
   * an observer.
   */
  private async notifyClosed(
    model: Model<PositionDocument>,
    chainId: number,
    protocol: string,
    chunk: string[],
    closed: number,
    now: Date,
  ): Promise<void> {
    if (!this.writeObserver) return;
    let ids = chunk;
    if (closed < chunk.length) {
      try {
        const rows = await model
          .find({ chainId, protocol, positionId: { $in: chunk }, isActive: false, lastVerifiedAt: now }, { _id: 0, positionId: 1 })
          .lean<Array<{ positionId?: unknown }>>();
        // A primary read with no write behind it: charged, never waited for.
        chargePrimaryRead(rows.length);
        ids = rows.map((r) => String(r.positionId));
      } catch (err) {
        this.logger.warn(`stale-sweep closure hints skipped chain=${chainId} (${(err as Error)?.message ?? String(err)})`);
        return;
      }
    }
    if (ids.length === 0) return;
    const wAt = now.getTime();
    const rows: FeeRowHint[] = ids.map((positionId) => ({ positionId, isActive: false, wAt }));
    this.callObserver(() => this.writeObserver!.onWritten(chainId, protocol, rows));
  }

  sortFieldFor(sort: string): string {
    return leaderboardSortSpec(sort).field;
  }

  sortDirectionFor(sort: string): 1 | -1 {
    return leaderboardSortSpec(sort).direction;
  }

  sortTieDirectionFor(sort: string): 1 | -1 {
    return leaderboardSortSpec(sort).tieDirection;
  }

  requiresPerformanceForSort(sort: string): boolean {
    return PERFORMANCE_SORTS.has(sort);
  }

  /**
   * Active positions for one on-chain fee tier, KEYSET-paged on `tokenId`.
   *
   * Full tier (`hotMinUsd` unset): `{chainId, protocol, isActive: true}` — served
   * by the existing `{chainId, protocol, isActive, tokenId}` index, in index
   * order with no SORT stage.
   *
   * Hot tier (OFF by default, `POSITION_FEE_HOT_INTERVAL_MS=0`): additionally
   * `metrics.inRange: true` and `metrics.underlyingValueUsd >= hotMinUsd`, left
   * to the planner — the full-tier index with both extra predicates at FETCH,
   * or a value-keyed index. It was hinted to the partial `bg_fee_hot` until
   * 2026-10-03; that index is in the migration's `--drop-legacy` set (the hot
   * tier has been off since the 45-min full pass replaced it), so a hot tier
   * turned back on costs a full-tier walk per pass.
   *
   * No collation on purpose: those indexes have the default collation, and
   * MongoDB only uses an index on a string field when the collations match. The
   * order is therefore lexicographic ("10" < "2"), which is still a total order,
   * so a pass visits every row once. Keyset rather than offset because the set
   * changes while a pass runs.
   */
  async findFeeRefreshCandidates(
    chainId: number,
    protocol: string,
    afterTokenId: string,
    limit: number,
    opts: { hotMinUsd?: number } = {},
  ): Promise<FeeRefreshCandidate[]> {
    const filter: Record<string, unknown> = { chainId, protocol, isActive: true };
    if (opts.hotMinUsd !== undefined) {
      filter['metrics.inRange'] = true;
      filter['metrics.underlyingValueUsd'] = { $gte: opts.hotMinUsd };
    }
    if (afterTokenId) filter.tokenId = { $gt: afterTokenId };
    const rows = await this.model(chainId, protocol)
      .find(filter)
      .sort({ tokenId: 1 })
      .limit(limit)
      .select(FEE_CANDIDATE_PROJECTION)
      .lean<FeeCandidateRow[]>();
    return rows.map(toFeeCandidate);
  }

  /**
   * The ACTIVE positions among `positionIds` (the live listener's dirty set),
   * in the same shape as a tier page. HINTED to the unique
   * `{chainId, protocol, positionId}` index: left to the planner, the
   * `{chainId, protocol, isActive}` index won the trial on a 430k-doc shard and
   * scanned all 70,831 active keys for 200 ids (vs 385 keys hinted).
   */
  async findFeeRefreshCandidatesByIds(
    chainId: number,
    protocol: string,
    positionIds: string[],
  ): Promise<FeeRefreshCandidate[]> {
    if (positionIds.length === 0) return [];
    const rows = await this.withHint(chainId, protocol, POSITION_ID_INDEX, (hint) => {
      let q = this.model(chainId, protocol)
        .find({ chainId, protocol, positionId: { $in: positionIds }, isActive: true })
        .select(FEE_CANDIDATE_PROJECTION);
      if (hint) q = q.hint(hint);
      return q.lean<FeeCandidateRow[]>();
    });
    return rows.map(toFeeCandidate);
  }

  /**
   * Stores on-chain fee measurements: ALWAYS the `rpcFees*` stamp (even when
   * the values did not move — a stamp left at an old block reads as stale once
   * the position changes), plus the served-field paths when the job revalued
   * the row. One `updateOne` per position, so the stamp and the served figures
   * can never land apart.
   *
   * The filter refuses the write when the stored `lastModifyBlock` is NEWER
   * than the measurement: a modify that landed (and was re-normalized) while
   * the batch was in flight settled the fees this measurement saw, and writing
   * it would serve them stale-high. `$not: {$gt}` also matches a document with
   * no `lastModifyBlock` yet. No upsert: a position that disappeared between the
   * read and the write must not be resurrected as a fee-only stub.
   *
   * A row carrying served paths is also guarded on the document VERSION it was
   * computed from (`updatedAt` as read): those paths include the performance
   * block derived from the cash flows in that read, and the `lastModifyBlock`
   * guard practically never refuses (the block comes from the RPC head while
   * the indexer is far behind), so a normalize that landed between the read
   * and this write — a dirty position is exactly one with a normalize in
   * flight — would otherwise have its fresh PnL / APR reverted to the old
   * snapshot's. When the version moved, only the stamp is written, by a
   * second pass whose `rpcFeesAt: {$ne: at}` makes it a no-op for every row the
   * first pass already stamped.
   *
   * Rows go out in chunks of at most `FEE_WRITE_CHUNK`, one after another, so
   * no single bulkWrite carries more than that many ops — the fee job paces
   * those chunks against its per-second write bucket, and a 2000-op bulkWrite
   * would land as exactly the burst the bucket exists to prevent.
   *
   * `opts.timeoutMs` is a DRIVER-side operation timeout (CSOT `timeoutMS`) on
   * every bulkWrite: the operation is really abandoned, unlike a Promise.race
   * around it, which frees the caller while the write runs on (and sends its
   * fallback) outside the caller's pacing. `opts.beforeFallback` is awaited
   * with the number of rows the stamp-only fallback is expected to write,
   * BEFORE that bulkWrite is sent — the fee job passes its write gate here, so
   * the fallback is paced like every other write instead of charged after the
   * fact.
   */
  async writeRpcFees(
    chainId: number,
    protocol: string,
    rows: RpcFeeWrite[],
    at: Date = new Date(),
    opts: RpcFeeWriteOptions = {},
  ): Promise<{ matched: number; modified: number; served: number }> {
    const total = { matched: 0, modified: 0, served: 0 };
    for (let i = 0; i < rows.length; i += FEE_WRITE_CHUNK) {
      const part = await this.writeRpcFeesChunk(chainId, protocol, rows.slice(i, i + FEE_WRITE_CHUNK), at, opts);
      total.matched += part.matched;
      total.modified += part.modified;
      total.served += part.served;
    }
    return total;
  }

  private async writeRpcFeesChunk(
    chainId: number,
    protocol: string,
    rows: RpcFeeWrite[],
    at: Date,
    opts: RpcFeeWriteOptions,
  ): Promise<{ matched: number; modified: number; served: number }> {
    if (rows.length === 0) return { matched: 0, modified: 0, served: 0 };
    const stamp = (r: RpcFeeWrite) => ({
      rpcFeesUncollected0: r.fees0,
      rpcFeesUncollected1: r.fees1,
      rpcFeesBlock: r.block,
      rpcFeesAt: at,
    });
    const notOlder = (r: RpcFeeWrite) => ({
      chainId,
      protocol,
      positionId: r.positionId,
      lastModifyBlock: { $not: { $gt: r.block } },
    });
    const model = this.model(chainId, protocol);
    const bulkOptions = opts.timeoutMs !== undefined && opts.timeoutMs > 0 ? { ordered: false, timeoutMS: opts.timeoutMs } : { ordered: false };
    // Through the shared write budget (P2.4; identical to a plain bulkWrite while it is off).
    const write = async (
      ops: Array<{ filter: Record<string, unknown>; set: Record<string, unknown> }>,
      kind: { units: number; servedLeaves: boolean },
    ) => {
      if (ops.length === 0) return { matched: 0, modified: 0 };
      const res = await budgetedBulkWrite(
        model,
        ops.map((op) => ({
          updateOne: {
            filter: op.filter,
            // A served write rewrites hashed `amounts` / `metrics` leaves outside
            // `upsertMany`: `$unset wh` so the next upsert writes the row whole
            // (P2.3, design §4.4). A stamp-only write touches no hashed section.
            update: kind.servedLeaves ? { $set: op.set, $unset: { wh: '' } } : { $set: op.set },
          },
        })),
        {
          unitsPerOp: kind.units,
          maxOps: effectiveChunkOps(this.budgetSettings(), ops.length),
          // The fee job's writes are the `fee` lane's whoever calls this (a
          // wrapping scope may still name another); untagged they would be
          // charged to `other` and wait at its share.
          lane: explicitWriteLane() ?? 'fee',
          maxWaitMs: opts.maxBudgetWaitMs,
          signal: opts.signal,
          bulkOptions,
        },
      );
      return { matched: res.matchedCount, modified: res.modifiedCount };
    };
    const stampOnly = { units: WRITE_UNITS.feeStamp, servedLeaves: false };
    const plainRows = rows.filter((r) => !r.served);
    const servedRows = rows.filter((r) => r.served);
    const [plain, served] = await Promise.all([
      write(plainRows.map((r) => ({ filter: notOlder(r), set: stamp(r) })), stampOnly),
      write(
        servedRows.map((r) => ({
          filter: { ...notOlder(r), updatedAt: r.version ?? { $exists: false } },
          set: { ...stamp(r), ...r.served },
        })),
        { units: WRITE_UNITS.feeServed, servedLeaves: true },
      ),
    ]);
    // Stamp-only for the served rows whose version moved under them — paced
    // (`beforeFallback`) before it is sent, like every other write.
    let fallback = { matched: 0, modified: 0 };
    if (served.matched < servedRows.length) {
      await opts.beforeFallback?.(servedRows.length - served.matched);
      fallback = await write(
        servedRows.map((r) => ({ filter: { ...notOlder(r), rpcFeesAt: { $ne: at } }, set: stamp(r) })),
        stampOnly,
      );
    }
    return {
      matched: plain.matched + served.matched + fallback.matched,
      modified: plain.modified + served.modified + fallback.modified,
      served: served.matched,
    };
  }

  /**
   * The stored on-chain fee measurement for each of `positionIds` that has one.
   * Served by the unique `{chainId, protocol, positionId}` index.
   */
  async findRpcFees(chainId: number, protocol: string, positionIds: string[]): Promise<Map<string, RpcFees>> {
    const out = new Map<string, RpcFees>();
    if (positionIds.length === 0) return out;
    const rows = await this.model(chainId, protocol)
      .find({ chainId, protocol, positionId: { $in: positionIds }, rpcFeesBlock: { $gt: 0 } })
      .select({ _id: 0, positionId: 1, rpcFeesUncollected0: 1, rpcFeesUncollected1: 1, rpcFeesBlock: 1, rpcFeesAt: 1 })
      .lean<
        Array<{
          positionId: string;
          rpcFeesUncollected0?: string;
          rpcFeesUncollected1?: string;
          rpcFeesBlock?: number;
          rpcFeesAt?: Date;
        }>
      >();
    for (const r of rows) {
      const fees0 = Number(r.rpcFeesUncollected0);
      const fees1 = Number(r.rpcFeesUncollected1);
      const block = Number(r.rpcFeesBlock);
      if (Number.isFinite(fees0) && Number.isFinite(fees1) && Number.isFinite(block)) {
        out.set(String(r.positionId), {
          fees0,
          fees1,
          block,
          ...(r.rpcFeesAt instanceof Date ? { at: r.rpcFeesAt } : {}),
        });
      }
    }
    return out;
  }
}

function toFeeCandidate(r: FeeCandidateRow): FeeRefreshCandidate {
  const lastModify = Number(r.lastModifyBlock ?? 0);
  return {
    positionId: String(r.positionId),
    tokenId: String(r.tokenId),
    poolId: String(r.poolId ?? ''),
    tickLower: Number(r.tickLower),
    tickUpper: Number(r.tickUpper),
    decimals0: Number(r.token0?.decimals),
    decimals1: Number(r.token1?.decimals),
    lastModifyBlock: Number.isFinite(lastModify) ? lastModify : 0,
    stored: {
      positionId: String(r.positionId),
      isActive: r.isActive !== false,
      token0: { priceUsd: r.token0?.priceUsd },
      token1: { priceUsd: r.token1?.priceUsd },
      amounts: r.amounts ?? {},
      metrics: r.metrics ?? {},
    },
    ...(r.updatedAt instanceof Date ? { version: r.updatedAt } : {}),
    ...(Number(r.rpcFeesBlock) > 0 && r.rpcFeesUncollected0 !== undefined && r.rpcFeesUncollected1 !== undefined
      ? {
          rpc: {
            fees0: String(r.rpcFeesUncollected0),
            fees1: String(r.rpcFeesUncollected1),
            block: Number(r.rpcFeesBlock),
            ...(r.rpcFeesAt instanceof Date ? { at: r.rpcFeesAt } : {}),
          },
        }
      : {}),
  };
}

interface ExistingPositionState {
  chainId: number;
  protocol: string;
  positionId: string;
  isActive?: boolean;
  metrics?: Position['metrics'];
  token0?: { priceUsd?: number };
  token1?: { priceUsd?: number };
  /** skip on: the stored gas ETH (D-1b); shadow: the whole subdocument. */
  amounts?: Partial<Position['amounts']>;
  staleMisses?: number;
  wh?: unknown;
  wAt?: unknown;
  rpcFeesBlock?: number;
  /** When a P3.1 stamp is carried: the stored reading (the stamp guard re-serves from it). */
  rpcFeesUncollected0?: unknown;
  rpcFeesUncollected1?: unknown;
  rpcFeesAt?: unknown;
  /** skip on / shadow: set by every full write with `wAt`; a later one means a writer that left `wh` behind. */
  lastVerifiedAt?: unknown;
  /** skip on: each subdocument's BSON `$type` (the legacy-shape guard). */
  _wt?: Partial<Record<SubdocField, unknown>>;
}

/** Today's read (skip off). */
const TODAY_STATE_PROJECTION = {
  chainId: 1,
  protocol: 1,
  positionId: 1,
  isActive: 1,
  metrics: 1,
  'token0.priceUsd': 1,
  'token1.priceUsd': 1,
} as const;

/** skip `on`: today's + the decision inputs (design §4.2). */
const ON_STATE_PROJECTION = {
  ...TODAY_STATE_PROJECTION,
  staleMisses: 1,
  wh: 1,
  wAt: 1,
  lastVerifiedAt: 1,
  rpcFeesBlock: 1,
  'amounts.totalGasCostEth': 1,
  _wt: Object.fromEntries(SUBDOC_FIELDS.map((field) => [field, { $type: `$${field}` }])),
} as const;

/** skip `shadow`: every hashed section whole (for the reasons), still no `rawSubgraph` / `tx*`. */
const SHADOW_STATE_PROJECTION: Record<string, 1> = {
  ...Object.fromEntries(IDENTITY_FIELDS.map((field) => [field, 1 as const])),
  ...Object.fromEntries(SUBDOC_FIELDS.map((field) => [field, 1 as const])),
  ...Object.fromEntries(STAMP_FIELDS.map((field) => [field, 1 as const])),
  staleMisses: 1,
  wh: 1,
  wAt: 1,
  lastVerifiedAt: 1,
};

/** One row of a chunk: today's full update and what is actually sent. */
interface RowPlan {
  /** What is written (after the P3.1 stamp guard). */
  position: NormalizedPosition;
  /** The row as `upsertMany` received it (the re-issue re-applies the stamp guard to it). */
  raw?: NormalizedPosition;
  previous?: ExistingPositionState;
  /** insert / full = whole write (upsert); section = changed sections (no upsert); skip = nothing. */
  kind: 'insert' | 'full' | 'section' | 'skip';
  reason?: FullWriteReason | null;
  /** Today's update for this row (the source of every other form). */
  full: Record<string, unknown>;
  op?: { updateOne: { filter: Record<string, unknown>; update: Record<string, unknown>; upsert: boolean } };
  units?: number;
  changed?: Section[];
  /** A section op: the `wh` it writes (how a matched op is told from a conflicted one). */
  writtenWh?: Buffer;
  /** Why a section op is re-issued whole: its row vanished, another writer changed `wh`, or the server refused it. */
  reissue?: 'vanished' | 'conflict' | 'failed';
  /** The op writes a P3.1 stamp and carries `stampGuardFilter`'s condition (an upsert's miss is E11000). */
  stampGuarded?: boolean;
}

/** Counters of one shard (a window, or the total). */
interface ShardWriteStats {
  mode: WriteSkipMode;
  rows: number;
  decisions: Record<RowPlan['kind'], number>;
  fullReasons: Partial<Record<FullWriteReason, number>>;
  /** Section writes per section. */
  sections: Partial<Record<Section, number>>;
  /** shadow: `<section>:<reason tag>` → rows. */
  reasons: Record<string, number>;
  reasonSamples: Record<string, string[]>;
  /** `valueBucket` → rows / skipped / sectioned. */
  buckets: Record<string, { rows: number; skipped: number; sectioned: number }>;
  /** shadow: what D-1b (`POSITIONS_GAS_REVALUE=full-write`) would decide for the non-full rows. */
  gasFullWrite: { rows: number; skipped: number; sectioned: number };
  setBytes: number;
  fullBytes: number;
  reupserted: number;
  /** Section ops whose row's `wh` changed between the read and the write (re-issued whole). */
  conflicts: number;
  sectionErrors: number;
  stampDropped: number;
}

interface ShardSkipStats {
  total: ShardWriteStats;
  window: ShardWriteStats;
  windowStartedAt: number;
  lowStrikes: number;
  alertedAt: number;
}

export interface WriteSkipStatus {
  settings: WriteSkipSettings;
  shards: Record<string, { total: ShardWriteStats; window: ShardWriteStats; windowStartedAt: Date }>;
}

/** A `[write-skip]` line per shard at most this often. */
const SKIP_WINDOW_MS = 10 * 60_000;
/** `positions.skip_rate_low`: below this share of updates skipped … */
const SKIP_RATE_ALERT = 0.3;
/** … for this many windows in a row … */
const SKIP_ALERT_WINDOWS = 3;
/** … each with at least this many updates. */
const SKIP_ALERT_MIN_UPDATES = 1_000;
/** Sample positionIds kept per shadow reason. */
const REASON_SAMPLES = 5;

/** The schema's leaves under each subdocument section (defaults included). */
const DECLARED_LEAVES = declaredLeavesOf(PositionSchema);

function emptyStats(mode: WriteSkipMode): ShardWriteStats {
  return {
    mode,
    rows: 0,
    decisions: { insert: 0, full: 0, section: 0, skip: 0 },
    fullReasons: {},
    sections: {},
    reasons: {},
    reasonSamples: {},
    buckets: {},
    gasFullWrite: { rows: 0, skipped: 0, sectioned: 0 },
    setBytes: 0,
    fullBytes: 0,
    reupserted: 0,
    conflicts: 0,
    sectionErrors: 0,
    stampDropped: 0,
  };
}

function addCounts(into: Record<string, number>, from: Record<string, number>): void {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
}

function addStats(into: ShardWriteStats, from: ShardWriteStats): void {
  into.rows += from.rows;
  addCounts(into.decisions, from.decisions);
  addCounts(into.fullReasons as Record<string, number>, from.fullReasons as Record<string, number>);
  addCounts(into.sections as Record<string, number>, from.sections as Record<string, number>);
  addCounts(into.reasons, from.reasons);
  for (const [k, ids] of Object.entries(from.reasonSamples)) {
    const samples = (into.reasonSamples[k] ??= []);
    for (const id of ids) if (samples.length < REASON_SAMPLES && !samples.includes(id)) samples.push(id);
  }
  for (const [k, b] of Object.entries(from.buckets)) {
    const t = (into.buckets[k] ??= { rows: 0, skipped: 0, sectioned: 0 });
    t.rows += b.rows;
    t.skipped += b.skipped;
    t.sectioned += b.sectioned;
  }
  into.gasFullWrite.rows += from.gasFullWrite.rows;
  into.gasFullWrite.skipped += from.gasFullWrite.skipped;
  into.gasFullWrite.sectioned += from.gasFullWrite.sectioned;
  into.setBytes += from.setBytes;
  into.fullBytes += from.fullBytes;
  into.reupserted += from.reupserted;
  into.conflicts += from.conflicts;
  into.sectionErrors += from.sectionErrors;
  into.stampDropped += from.stampDropped;
  into.mode = from.mode;
}

function cloneStats(stats: ShardWriteStats): ShardWriteStats {
  const out = emptyStats(stats.mode);
  addStats(out, stats);
  return out;
}

function formatCounts(counts: Record<string, number | undefined>): string {
  const entries = Object.entries(counts).filter(([, v]) => (v ?? 0) > 0);
  return `{${entries.map(([k, v]) => `${k}:${v}`).join(' ')}}`;
}

/** BSON size of a `$set` (the bytes a write sends), 0 when it cannot be measured. */
function bsonBytes(value: unknown): number {
  try {
    return mongoose.mongo.BSON.calculateObjectSize(value as Record<string, unknown>);
  } catch {
    return 0;
  }
}

/** The P3.1 stamp block a normalized position carries (E: only when freshly measured in this walk). */
function carriedStampBlock(position: NormalizedPosition): number | undefined {
  const block = (position as { rpcFeesBlock?: unknown }).rpcFeesBlock;
  return typeof block === 'number' && Number.isFinite(block) && block > 0 ? block : undefined;
}

/** The stored P3.1 / fee-job reading (decimal-adjusted token units), or undefined when it is not whole. */
function storedFeeReading(previous: ExistingPositionState): { fees0: number; fees1: number; at?: Date } | undefined {
  const raw0 = previous.rpcFeesUncollected0;
  const raw1 = previous.rpcFeesUncollected1;
  if (raw0 === undefined || raw0 === null || raw1 === undefined || raw1 === null) return undefined;
  const fees0 = Number(raw0);
  const fees1 = Number(raw1);
  if (!Number.isFinite(fees0) || !Number.isFinite(fees1)) return undefined;
  return { fees0, fees1, ...(previous.rpcFeesAt instanceof Date ? { at: previous.rpcFeesAt } : {}) };
}

/**
 * `position` with its served fee leaves taken from `reading` instead of the
 * reading normalize carried — the same formulas normalize uses (`pending` at
 * the row's own gated leg prices, 0 when the valuation guard rejected it).
 * The aggregate recompute downstream (`positionUpdate`) derives the rest.
 */
function reserveFromReading(position: NormalizedPosition, reading: { fees0: number; fees1: number; at?: Date }): NormalizedPosition {
  const finite = (v: unknown) => {
    const n = typeof v === 'number' ? v : Number(v ?? 0);
    return Number.isFinite(n) ? n : 0;
  };
  const priceable = position.metrics?.isPriceable !== false;
  const pending = priceable
    ? finite(reading.fees0 * finite(position.token0?.priceUsd) + reading.fees1 * finite(position.token1?.priceUsd))
    : 0;
  const metrics = position.metrics;
  return {
    ...position,
    amounts: {
      ...position.amounts,
      totalFeesUncollected0: String(reading.fees0),
      totalFeesUncollected1: String(reading.fees1),
      totalFeesUncollectedUsd: String(pending),
    },
    metrics: {
      ...metrics,
      pendingFeesUsd: pending,
      totalFeesUsd: finite(finite(metrics?.totalFeesUsd) - finite(metrics?.pendingFeesUsd) + pending),
      feesSource: 'onchain',
      ...(reading.at ? { feesMeasuredAt: reading.at } : {}),
    },
  };
}

/** `position`'s top-level fields no section knows (each forces a full write). */
function unknownUpsertFields(position: NormalizedPosition): string[] {
  const out: string[] = [];
  for (const [field, value] of Object.entries(position)) {
    if (value !== undefined && sectionOfField(field) === null) out.push(field);
  }
  return out;
}

/** Duplicate rows of one flush → the LAST one (what today's in-order writes leave stored). */
function lastOccurrences(positions: NormalizedPosition[]): NormalizedPosition[] {
  const byKey = new Map<string, NormalizedPosition>();
  for (const position of positions) {
    const key = positionKey(position);
    byKey.delete(key);
    byKey.set(key, position);
  }
  return byKey.size === positions.length ? positions : [...byKey.values()];
}

function bsonTypeOf(value: unknown): string {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  if (typeof value === 'object') return 'object';
  return typeof value;
}

/** What `fullWriteReason` needs from the stored row. */
function storedWriteState(previous: ExistingPositionState | undefined, mode: WriteSkipMode): StoredWriteState | undefined {
  if (!previous) return undefined;
  const sectionTypes: Partial<Record<SubdocField, unknown>> = {};
  if (mode === 'shadow') {
    for (const field of SUBDOC_FIELDS) sectionTypes[field] = bsonTypeOf((previous as unknown as Record<string, unknown>)[field]);
  } else if (previous._wt && typeof previous._wt === 'object') {
    Object.assign(sectionTypes, previous._wt);
  }
  const value = previous.metrics?.underlyingValueUsd;
  return {
    isActive: previous.isActive,
    staleMisses: previous.staleMisses,
    wh: previous.wh,
    wAt: previous.wAt,
    lastVerifiedAt: previous.lastVerifiedAt,
    underlyingValueUsd: typeof value === 'number' && Number.isFinite(value) ? value : undefined,
    sectionTypes,
  };
}

/** A `MongoBulkWriteError`'s failed ops: index (in the bulkWrite) → error code; null = not such an error. */
function bulkWriteFailures(err: unknown): Map<number, number | undefined> | null {
  const raw = (err as { writeErrors?: unknown } | null | undefined)?.writeErrors;
  if (raw === undefined || raw === null) return null;
  const list = Array.isArray(raw) ? raw : [raw];
  const out = new Map<number, number | undefined>();
  for (const e of list) {
    const index = (e as { index?: unknown } | null)?.index;
    if (typeof index !== 'number' || !Number.isInteger(index)) return null;
    const code = (e as { code?: unknown }).code;
    out.set(index, typeof code === 'number' ? code : undefined);
  }
  return out;
}

/**
 * The options of a budgeted write that is not a `bulkWrite` (the stale sweep's
 * `updateMany`s): the driver's per-operation timeout while the write budget is
 * on, as every `budgetedBulkWrite` chunk has (a hung write must not hold its
 * lane forever); off, none at all — today's call exactly.
 */
function budgetedTimeoutOptions(): [] | [{ timeoutMS: number }] {
  return processWriteBudget()?.enabled ? [{ timeoutMS: BUDGETED_CHUNK_TIMEOUT_MS }] : [];
}

/** The server's duplicate-key error code. */
const DUPLICATE_KEY = 11000;

/**
 * Rounds of whole re-issues one chunk may take (the first write's misses →
 * round 1; a round's own stamp misses → the next). Each round re-reads, so a
 * row needs a fee write to land inside every read→write window to use them all.
 */
const MAX_REISSUE_ROUNDS = 3;

/** A stamp-guarded upsert whose guard refused the stored row: the insert it fell back to hit the positionId index. */
function isStampConflict(plan: RowPlan | undefined, code: number | undefined): boolean {
  return plan?.stampGuarded === true && code === DUPLICATE_KEY;
}

/** A failed op `writeChunk` repairs by a whole re-issue (see there). */
function repairableFailure(plan: RowPlan | undefined, code: number | undefined): boolean {
  return plan?.kind === 'section' || isStampConflict(plan, code);
}

/** The P3.1 stamp block an update `$set`s, if any. */
function setStampBlock(update: Record<string, unknown>): number | undefined {
  const block = (update.$set as Record<string, unknown> | undefined)?.rpcFeesBlock;
  return typeof block === 'number' && Number.isFinite(block) ? block : undefined;
}

function carriesStampSet(update: Record<string, unknown>): boolean {
  return setStampBlock(update) !== undefined;
}

/**
 * The P3.1 stamp guard IN THE WRITE: an op that `$set`s a stamp matches only a
 * row whose stored `rpcFeesBlock` is not newer. `stampGuard` decides on the
 * read, but the read can be seconds old by the write (the budget wait), and a
 * fee write landing in between would otherwise be regressed. `$not: {$gt}`
 * also matches a row with no (or a null / non-numeric) stamp; an equal block
 * is the same measurement and is written, as `stampGuard` does. An upsert
 * that the guard refuses tries an insert and fails E11000 on the unique
 * `{chainId, protocol, positionId}` index — the op `writeChunk` re-issues from
 * a fresh read; a section op (no upsert) simply matches nothing.
 */
function stampGuardFilter(filter: Record<string, unknown>, update: Record<string, unknown>): Record<string, unknown> {
  const block = setStampBlock(update);
  return block === undefined ? filter : { ...filter, rpcFeesBlock: { $not: { $gt: block } } };
}

/** A stored `wh` (Buffer, or the BSON Binary a lean read returns) as a Buffer — the section op's filter value. */
function whBytes(raw: unknown): Buffer | undefined {
  if (Buffer.isBuffer(raw)) return raw;
  const b = (raw as { buffer?: unknown; position?: unknown } | null | undefined)?.buffer;
  if (b instanceof Uint8Array) {
    const pos = (raw as { position?: unknown }).position;
    return Buffer.from(typeof pos === 'number' ? b.subarray(0, pos) : b);
  }
  return undefined;
}

function sameBytes(a: unknown, b: unknown): boolean {
  const x = whBytes(a);
  const y = whBytes(b);
  return x !== undefined && y !== undefined && x.equals(y);
}

function countOf(result: unknown, field: string): number {
  const value = (result as Record<string, unknown> | null | undefined)?.[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** The fee store's view of a row this write stored (from its full `$set`). */
function feeRowHint(set: Readonly<Record<string, unknown>>, wAt: number): FeeRowHint {
  const token0 = (set.token0 ?? {}) as Record<string, unknown>;
  const token1 = (set.token1 ?? {}) as Record<string, unknown>;
  const metrics = (set.metrics ?? {}) as Record<string, unknown>;
  const hint: FeeRowHint = {
    positionId: String(set.positionId),
    isActive: set.isActive === true,
    wAt,
    tokenId: set.tokenId === undefined ? undefined : String(set.tokenId),
    poolId: set.poolId === undefined ? undefined : String(set.poolId),
    tickLower: numberOrUndefined(set.tickLower),
    tickUpper: numberOrUndefined(set.tickUpper),
    lastModifyBlock: numberOrUndefined(set.lastModifyBlock),
    decimals0: numberOrUndefined(token0.decimals),
    decimals1: numberOrUndefined(token1.decimals),
    price0: numberOrUndefined(token0.priceUsd),
    price1: numberOrUndefined(token1.priceUsd),
    isPriceable: typeof metrics.isPriceable === 'boolean' ? metrics.isPriceable : undefined,
    feesSource: typeof metrics.feesSource === 'string' ? metrics.feesSource : undefined,
    pendingFeesUsd: numberOrUndefined(metrics.pendingFeesUsd),
  };
  const block = numberOrUndefined(set.rpcFeesBlock);
  if (block !== undefined && block > 0 && set.rpcFeesUncollected0 !== undefined && set.rpcFeesUncollected1 !== undefined) {
    hint.rpc = {
      fees0: String(set.rpcFeesUncollected0),
      fees1: String(set.rpcFeesUncollected1),
      block,
      ...(set.rpcFeesAt instanceof Date ? { at: set.rpcFeesAt } : {}),
    };
  }
  return hint;
}

interface PositionGroup {
  chainId: number;
  protocol: string;
  positions: NormalizedPosition[];
}

function groupByCollection(positions: NormalizedPosition[]): Map<string, PositionGroup> {
  const grouped = new Map<string, PositionGroup>();
  for (const position of positions) {
    const key = `${position.chainId}:${position.protocol}`;
    const group = grouped.get(key);
    if (group) {
      group.positions.push(position);
    } else {
      grouped.set(key, {
        chainId: position.chainId,
        protocol: position.protocol,
        positions: [position],
      });
    }
  }
  return grouped;
}

function positionKey(position: { chainId: number; protocol: string; positionId: string }): string {
  return `${position.chainId}:${position.protocol}:${position.positionId}`;
}

/**
 * If the incoming token snapshot has priceUsd=0 (failure mode) but a positive
 * value is already stored, return a clone with the stored value substituted.
 * Otherwise return the input unchanged (identity preserved so callers can
 * `=== ` check whether anything changed).
 *
 * Preservation policy:
 *   - Configured anchor tokens (stable / native / trusted per chain config)
 *     always preserve — those are reliable regardless of the upstream
 *     `verified` flag, which is known to be incomplete for some chains.
 *   - Verified tokens preserve their stored price.
 *   - Unverified non-anchor tokens do NOT preserve — a transient external
 *     miss is the most common cause and overwriting with stale long-tail
 *     prices is exactly the failure mode we want to avoid.
 */
/**
 * The hand-set `trustDenied` flags `PositionsRepository.carryForwardDenied`
 * read for one write: the flagged addresses (lowercased), 'unreadable' (the
 * read failed: treat every non-anchor leg as flagged), or undefined (nothing
 * looked up — allowlist mode, or no leg to carry forward).
 */
type CarryForwardDenied = ReadonlySet<string> | 'unreadable' | undefined;

function preserveTokenPrice<T extends { address: string; priceUsd: number; verified?: boolean }>(
  chainId: number,
  token: T,
  previous: number | undefined,
  policy: TrustPolicy,
  denied?: CarryForwardDenied,
): T {
  if (token.priceUsd > 0) return token;
  if (typeof previous !== 'number' || previous <= 0) return token;
  // Only carry a prior positive price forward for TRUSTED tokens — the ONE
  // trust rule (`resolveTokenTrust`). In `allowlist` mode (default) that is
  // today's anchor || CoinGecko-listed exactly (the env deny list, empty by
  // default, can only remove trust). In `earned` mode no earned verdict is
  // passed here, so only anchors carry forward (fail closed — the hot path's
  // last-known-good, which IS trust-gated with verdicts, still serves earned
  // tokens). In `combined` mode the same missing verdict leaves anchors and
  // allowlisted tokens — i.e. exactly allowlist mode's carry-forward — EXCEPT
  // a token whose stored `trustDenied` flag is set: the writer loads that flag
  // for exactly these legs (`carryForwardDenied`), so a flagged listed token
  // is not carried forward (it used to be: its pre-flag price came back on
  // every sync after the hot path, which honours the flag, priced it 0). Only
  // the flag is passed, never a verdict, so nothing else changes in any mode.
  // A spam/long-tail token must NOT resurrect a stale price: the
  // valuation gate deliberately zeroes it, and preserving the old value would
  // silently undo the gate (the PORT3 bug).
  const flagged = denied === 'unreadable' || denied?.has(token.address.toLowerCase()) === true;
  if (resolveTokenTrust(chainId, token.address, flagged ? { trustDenied: true } : undefined, policy).trusted) {
    return { ...token, priceUsd: previous };
  }
  return token;
}

/** Every sort descends except `nft_id_asc` — `age` included (newest first). */
function sortDirectionFor(sort: string): 1 | -1 {
  return sort === 'nft_id_asc' ? 1 : -1;
}

/**
 * The `positionId` tie-break's direction: ascending, except for the nft sorts,
 * where it FOLLOWS the primary direction. For v4 `tokenId === positionId`, so
 * the tie never decides anything there — but `{tokenId: -1, positionId: -1}` is
 * `lbr_tokenid {tokenId: 1, positionId: 1}` read backwards, while
 * `{tokenId: -1, positionId: 1}` matches no index order and would be a blocking
 * SORT over the whole shard.
 */
function tieDirectionFor(sort: string): 1 | -1 {
  return sort === 'nft_id_desc' ? -1 : 1;
}

/**
 * The full leaderboard sort for a public sort key: `{[field]: direction,
 * positionId: tieDirection}` under the numericOrdering collation. The ONE
 * definition — the repository's Mongo sort, its Node-side ordering of the
 * uncollated shapes and the all-chains merge all read it.
 */
export function leaderboardSortSpec(sort: string): { field: string; direction: 1 | -1; tieDirection: 1 | -1 } {
  return {
    field: SORT_FIELD_MAP[sort] ?? SORT_FIELD_MAP.apr,
    direction: sortDirectionFor(sort),
    tieDirection: tieDirectionFor(sort),
  };
}

/**
 * The Set R index a ranked find walks, or undefined to leave the plan to the
 * planner. Decided per shape:
 *  - rate sort (apr / fee_apr / roi): its partial index, ONLY when the filter
 *    carries `isActive: true` exactly (every view but Closed). That condition
 *    is about CORRECTNESS, not speed: MongoDB 8.0 obeys a hint naming a
 *    partial index even for a filter that does not imply its expression, and
 *    silently returns the incomplete result — verified locally, the Closed
 *    filter hinted to `lbr_apr_active` returned 0 rows, no error. The service
 *    serves the Closed tab's rate sorts as `pnl` (`effectiveLeaderboardSort`),
 *    so a rate sort reaching here with `isActive: false` comes only from a
 *    direct repository caller, and stays unhinted (7–14 s locally).
 *  - pnl / underlying_value / age / nft: the full index for that sort, on
 *    every status — `isActive` is an index key there, filtered before fetch —
 *    EXCEPT under a minimum-value floor on a closed or mixed view (below).
 *  - `assetClass=equity`: unhinted. Its `$or` over the two token-address
 *    indexes selects a handful of rows; forcing a walk of the sort index would
 *    examine the shard until enough rare equity rows turned up.
 *
 * A value floor (`minValueUsd > 0`) without `isActive: true`: the rows that
 * clear it are open rows (a closed position holds no current value — 0 of
 * every shard's closed rows locally), so a forced walk of the SORT index visits
 * every closed row in front of them, and on `lbr_created` / `lbr_tokenid`
 * (no value in the key) FETCHES each one to test the floor:
 *  - Closed tab: nothing can match, so the walk is the whole shard. Hinted
 *    `lbr_created`, chain 1, $500+: 429,679 keys / 352,834 docs / 2.1 s;
 *    `lbr_value` reads only the keys above the floor and rejects them on the
 *    key's `isActive`: 9,980 keys / 0 docs / 31 ms. So the Closed tab under a
 *    floor reads `lbr_value` for every non-rate sort (pnl included — its walk
 *    is keys-only but still the whole index: 429,679 keys / 319 ms).
 *  - All tab: the matches are the open rows above the floor, and whether the
 *    sort walk or `lbr_value` + a top-k SORT is cheaper depends on how they are
 *    spread in sort order (42161, $10K+, nft ↑: 146,611 docs hinted vs 380 on
 *    `lbr_value`; chain 1, $1+, age: 88 docs hinted vs 32,371). The planner's
 *    trial picks the right one in every measured case, so a sort index with no
 *    value in its key is NOT hinted there; `lbr_pnl` / `lbr_value` (value in
 *    the key, keys-only walk) still are.
 * The Active tab keeps the sort index: closed rows are skipped on the key's
 * `isActive` without a fetch, and the dashboard's floors are dense enough
 * among open rows (chain 1, $10K+, nft ↑: 5,907 docs / 79 ms).
 */
function rankedHint(query: LeaderboardQuery, filter: Record<string, unknown>): string | undefined {
  if (query.assetClass === 'equity') return undefined;
  if (RATE_SORTS.has(query.sort)) return filter.isActive === true ? RATE_SORT_INDEX[query.sort] : undefined;
  const index = FULL_SORT_INDEX[query.sort];
  if (filter.isActive === true || !hasValueFloor(filter)) return index;
  if (filter.isActive === false) return VALUE_INDEX;
  return index !== undefined && VALUE_KEYED_SORT_INDEXES.has(index) ? index : undefined;
}

/**
 * The `minValueUsd` floor: a top-level `$gte` on `metrics.underlyingValueUsd`,
 * which `buildLeaderboardFilter` writes only for `minValueUsd > 0`. A LOWER
 * bound only — an upper bound selects the zero-value closed rows, the opposite
 * of what makes `lbr_value` cheap. (The other bound the filter can carry, the
 * rate sorts' / open guards' `$gt: 0`, only ever comes with `isActive: true`.)
 */
export function hasValueFloor(filter: Record<string, unknown>): boolean {
  const value = filter['metrics.underlyingValueUsd'];
  return value !== null && typeof value === 'object' && typeof (value as { $gte?: unknown }).$gte === 'number';
}

/**
 * A ranked COUNT has no sort to serve, so its index is chosen by what bounds
 * the scan: `lbr_value` (`{chainId, protocol, underlyingValueUsd, positionId,
 * isActive, inRange}`, collated like the count) when the filter puts a
 * top-level bound on `metrics.underlyingValueUsd` — a minimum value, a rate
 * sort, or the risky-off guards on an active view — so the count reads only the
 * keys inside that bound and applies `isActive` / `inRange` to them before any
 * fetch. With no value bound (risky on with no floor, the All tab's `$or`, the
 * Closed tab without a floor) the planner's own choice is left alone. The
 * equity filter is unhinted for the same reason as its find.
 */
function countHint(query: LeaderboardQuery, filter: Record<string, unknown>): string | undefined {
  if (query.assetClass === 'equity') return undefined;
  const value = filter['metrics.underlyingValueUsd'];
  const bounded =
    value !== null && typeof value === 'object' && ('$gt' in value || '$gte' in value || '$lt' in value || '$lte' in value);
  return bounded ? VALUE_INDEX : undefined;
}

/** See `LeaderboardShape`. An id lookup wins over every scope it composes with. */
export function leaderboardShape(query: Pick<LeaderboardQuery, 'positionId' | 'poolId' | 'owner'>): LeaderboardShape {
  if (query.positionId) return 'lookup';
  if (typeof query.owner === 'string' && query.owner) return 'owner';
  if (typeof query.poolId === 'string' && query.poolId) return 'pool';
  return 'ranked';
}

/**
 * The collated Mongo sort `{ [field]: direction, positionId: tieDirection }`
 * with `numericOrdering`, replicated in Node: digit-string ids (`tokenId`,
 * `positionId`) by magnitude, metrics and `createdAtTimestamp` as numbers with
 * missing/null lowest. The uncollated shapes order with it, and the all-chains
 * merge (`LeaderboardService`) uses it before its own `chainId` tie-break, so
 * both reproduce the shard's Mongo order exactly.
 */
export function leaderboardRowComparator(field: string, direction: 1 | -1, tieDirection: 1 | -1) {
  return (a: unknown, b: unknown): number => {
    // BSON order for every field (`compareSortValue`): the digit-string
    // `tokenId` compares as a collated string, the metrics as numbers — with
    // null < NaN < numbers (±Infinity included, by value) < strings.
    const byField = compareSortValue(valueAtPath(a, field), valueAtPath(b, field), true) * direction;
    if (byField !== 0) return byField;
    return compareNumericString(valueAtPath(a, 'positionId'), valueAtPath(b, 'positionId')) * tieDirection;
  };
}

/** `filter` with one more clause ANDed on (never overwriting a field the filter already bounds). */
function withClause(filter: Record<string, unknown>, clause: Record<string, unknown>): Record<string, unknown> {
  const and = Array.isArray(filter.$and) ? (filter.$and as unknown[]) : [];
  return { ...filter, $and: [...and, clause] };
}

/** What is left of a deadline, as a `maxTimeMS` (at least 1 — 0 would mean "no limit"). */
function remainingMs(deadlineAt: number): number {
  return Math.max(1, Math.floor(deadlineAt - Date.now()));
}

/** A merge source whose rows are loaded on first use. */
function lazySource<R>(chainId: number, load: () => Promise<R[]>): MergeSource<R> {
  let inner: MergeSource<R> | undefined;
  let closed = false;
  return {
    chainId,
    async next() {
      if (closed) return null;
      inner ??= arraySource(chainId, await load());
      return inner.next();
    },
    async close() {
      closed = true;
      await inner?.close();
    },
  };
}
