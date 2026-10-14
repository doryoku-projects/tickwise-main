import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { createPublicClient, http, type PublicClient } from 'viem';
import { AppConfigService } from '../config/app-config.service.js';
import { can, leasesEnabled } from '../common/process-role.js';
import { registerStatusContributor, unregisterStatusContributor } from '../common/process-status.js';
import { stableJitter } from '../common/stable-jitter.js';
import { WriteBudgetTimeoutError } from '../common/write-budget.js';
import { runInWriteLane } from '../common/write-lane.js';
import { uniswapV4ContractsFor } from '../config/chains.config.js';
import { chargePrimaryRead } from '../database/budgeted-write.js';
import { CollectionResolver } from '../database/collection-resolver.js';
import {
  FEE_WRITE_CHUNK,
  PositionsRepository,
  type FeeRefreshCandidate,
  type FeeRowHint,
  type RpcFeeWrite,
  type RpcFeeWriteOptions,
} from '../database/positions.repository.js';
import {
  FEE_PASS_TALLY_KEYS,
  SyncRepository,
  emptyFeePassTally,
  type FeePassTally,
  type FeeTier,
  type FeeTierCursor,
} from '../database/sync.repository.js';
import {
  FeeCandidateFeed,
  candidateFromStore,
  mongoStoreSource,
  storeRowFromCandidate,
  type FeeStoreSource,
} from './fee-candidate-feed.js';
import type { FeeCandidateStore } from './fee-candidate-store.js';
import {
  FEE_RPC_FETCH,
  FeeMeasurer,
  batchSizeFor,
  checkedFetch,
  concurrencyFor,
  resolveFeeP3Settings,
  type FeeP3Settings,
  type FeeRpcFetchFactory,
  type MeasureOutcome as GenericMeasureOutcome,
  type MeasuredRow,
} from './fee-measurer.js';
import { FeeRowHintPublisher, type FeeHintSink } from './fee-row-hint-publisher.js';
import {
  BACKFILL_MAX_PER_CHAIN,
  DIRTY_LANES,
  DIRTY_MAX_PER_CHAIN,
  FEE_COORDINATION,
  FORCE_REREAD,
  MemoryFeeSignals,
  RedisFeeSignals,
  VIEW_QUEUE_MAX_PER_CHAIN,
  resolveSignalsTransport,
  type DirtyLane,
  type FeeCoordination,
  type FeeSignals,
} from './fee-signals.js';
import { FeeWriteGate, type FeeWriteLane } from './fee-write-gate.js';
import { needsServedWrite, revalueServedFees } from './position-fee-math.js';
import { FEE_CHAIN_BUDGET_HEADROOM, perChainAllotment, suggestedSlots } from './position-fee-rpc.js';

// Moved with P3 (fee-signals.ts / fee-measurer.ts); re-exported so existing importers keep working.
export {
  BACKFILL_MAX_PER_CHAIN,
  VIEW_COOLDOWN_MAX,
  VIEW_COOLDOWN_MS,
  VIEW_QUEUE_MAX_PER_CHAIN,
  type DirtyLane,
} from './fee-signals.js';
export { RPC_ALERT_INTERVAL_MS, RPC_RETRY_DELAY_MS } from './fee-measurer.js';

/*
 * On-chain read of every active position's uncollected fees.
 *
 * WHY THIS EXISTS: the indexer's own fee sweep cannot be relied on. On the
 * current deployment it has never committed on chains 1 and 4663 (its first
 * firing loads every position on the chain, ~428k / ~3.49M rows), it writes 0
 * for every out-of-range position although v4 still owes those fees, and it
 * clamps a wrapped fee-growth delta to 0. Reading StateView directly sidesteps
 * all three. The method was validated against the indexer's own swept rows:
 * 6,120 of them matched to the raw unit wherever the indexer's sweep was right.
 * The new indexer drops the sweep (and its `totalFeesUncollected0/1` columns)
 * outright, and the backend no longer selects them, so this read is now the ONLY
 * source of the served uncollected-fee figure (`chooseUncollected`).
 *
 * WORK, driven by a 60 s in-process tick per chain (single-flight; the BullMQ
 * `position-fee-refresh` job only pokes the same tick), in this order:
 *   - views: positions somebody just opened in the detail view (`markViewed`,
 *     5-min cooldown per position), at most POSITION_FEE_VIEW_PER_TICK per
 *     chain per tick. Never an RPC call on the request path.
 *   - live dirty: positions the live listener just saw change (`markDirty`).
 *     A modify settles fees, so a compounder is re-read on the next tick or
 *     two — within ~1–2 min of each compound — unless that chain's live set
 *     is itself full (50k).
 *   - backfill: the active rows of every backfill flush (`markDirty` with
 *     `lane: 'backfill'`), drained only once the live set is empty, with its
 *     own cap (100k) and, for its writes, at most half the write rate — so a
 *     large walk can neither delay nor drop a live change, nor take the write
 *     rate every chain's passes share. A newly backfilled position is read
 *     within minutes instead of at the next pass.
 *   Both side lanes skip, with no RPC call, a row whose stored reading already
 *   post-dates the change that queued it (`isFreshForChange`), keep draining
 *   while the tick has budget (≤ SIDE_READS_PER_TICK Mongo reads a tick, no
 *   drain started more than SIDE_DRAIN_WINDOW_MS into the tick), and while a
 *   tier pass is due get at most HALF the tick's reads AND no more wall time
 *   than the tier pages have had — the time share is what keeps a flood of
 *   never-measured rows (nearly all served writes, the slowest kind) from
 *   stalling the pass. With no pass due they may use the whole budget.
 *   - all:  every active position, one resumable pass per
 *     POSITION_FEE_FULL_INTERVAL_MS (45 min, start to start).
 *   - hot:  in-range positions worth ≥ POSITION_FEE_HOT_MIN_USD, one pass per
 *     POSITION_FEE_HOT_INTERVAL_MS — OFF by default (0): the 45-min full pass
 *     already re-reads every row inside the hour. Enabled, it goes first,
 *     except that an `all` pass in progress for more than half its interval
 *     goes before it.
 * Both passes are keyset walks over tokenId whose cursor — and the pass's
 * running counts — are persisted in `sync_cursors` after every page, so a
 * restart or a deploy resumes where it stopped and the end-of-pass line is
 * right across restarts. The next page is READ while the current one is
 * measured (its cursor is known as soon as the current page is read), and
 * MEASURED while the previous one is written (at most one page's writes
 * outstanding); a page's cursor is still saved only after that page is
 * measured AND persisted, in page order.
 *
 * SCHEDULE: one chain per timer slot, round robin, so every chain ticks once
 * per FEE_TICK_INTERVAL_MS at its own offset. A tick can outlast its minute
 * (writes wait for the gate); the slot that arrives meanwhile is not dropped —
 * the chain re-runs as soon as the tick ends. A chain's ticks never start less
 * than MIN_TICK_GAP_MS apart (a slot that comes sooner is deferred to it), so
 * each chain still starts at most one tick per minute.
 *
 * BUDGET: POSITION_FEE_MAX_PER_TICK bounds how many positions ONE 60 s ROUND
 * reads across EVERY chain, views and side lanes included (see `allotment`):
 * a tick may take at most what the other chains did not take in their latest
 * tick (or are holding in one in flight), so the reads of all chains in a
 * round add up to the budget, never more. Chains that want more split what the
 * idle ones leave equally; a chain that suddenly needs more gets its share by
 * its next tick. For POSITION_FEE_RAMP_MS (5 min) after boot the budget ramps up from a
 * quarter, so a deploy does not land as one burst. WRITES are paced
 * separately, per second, by `FeeWriteGate` (one per process, shared by every
 * chain, ramped the same way): bulkWrites of at most 100 ops, each waiting for
 * tokens from POSITION_FEE_MAX_WRITES_PER_SEC and — for the ones that rewrite
 * the served fields — POSITION_FEE_MAX_SERVED_WRITES_PER_SEC. A waiting write
 * stalls its page loop; nothing is dropped. The gate caps a pass's speed at
 * rate / (share of rows written) per second, so raising the read budget only
 * helps while the write rates keep up (see the env comments); a 10-minute line
 * reports how long writes waited, and warns when the gate is saturated.
 *
 * RPC FAILURES: with `allowFailure: true`, viem's multicall never throws on a
 * transport failure — every call of the rejected request comes back as a
 * failure carrying the same error. That used to be counted as N reverts and
 * the cursor moved on. Now (`position-fee-rpc.ts`): a WHOLE-REQUEST failure
 * raises a throttled `[alert] fees.rpc_batch_failed`, is retried once after
 * 1 s, and if it still fails its rows are UNANSWERED — the page is not
 * advanced and the next tick re-reads it (rows already measured read as
 * unchanged and cost no writes), for at most HOLD_BACK_MAX_TICKS ticks before
 * the pass moves on with `[alert] fees.page_unanswered`. Calls are interleaved
 * per position, so a gas cutoff fails only a TAIL; that tail alone is retried
 * at the same block, in halves. Scattered failures are real reverts: counted
 * failed, and a tier row gets one quick retry through the dirty set.
 *
 * BLOCK: each Multicall3 batch reads the chain head (eth_blockNumber) and runs
 * pinned to exactly that block, then stamps it on its rows — no run-start pin,
 * so no archive or pruned-state dependency however long a pass takes. NOT
 * Multicall3.getBlockNumber(): on Arbitrum and Orbit chains (42161, 4663)
 * `block.number` is the L1 block number, which is not comparable with the
 * indexer's L2 `lastModifyBlock`.
 *
 * WRITES: the `rpcFees*` stamp — except for an identical re-read whose stored
 * block is still valid and whose stamp is younger than POSITION_FEE_RESTAMP_MS
 * (24 h, ±25% per position; `isUnchangedMeasurement`; freshness is decided by
 * block, never by stamp age, so that write would buy nothing) — and, when the
 * served figure moved by at least max($0.25, 1%) — or, on a leg valued at $0
 * (unpriced token / rejected position), by 1% in token units — or was not
 * on-chain before (`needsServedWrite`), the SERVED fields directly: uncollected amounts, pending fees USD and the
 * aggregate performance, in the same op (`revalueServedFees`). Fees therefore
 * reach the API within one pass with zero indexer requests. `EnvioAdapter`
 * still overlays the stored measurement on every re-normalize
 * (`chooseUncollected`), so the two writers converge on the same figure.
 *
 * COST: two eth_calls per position plus one eth_blockNumber per batch, packed
 * into Multicall3 — `positionFeeBatchSize` positions per request. WITHOUT
 * Multicall3 it would be hundreds of millions of requests a month, over the
 * account-wide Dwellir allowance, so never unbatch this.
 *
 * This is the backend's SECOND on-chain read path (the first is the x402
 * payments rail). the internal design notes records the carve-out.
 *
 * P2/P3 (2026-10-04, every knob defaulting to the behaviour above):
 *   - MEASUREMENT lives in `fee-measurer.ts` (shared with the backfill's first
 *     reading, P3.1): per-chain batch/concurrency, a process-wide multicall
 *     ceiling, one head per page, `budgetedFetch` clients.
 *   - BUDGET `POSITION_FEE_BUDGET=per-chain` sizes each chain's tick from its
 *     active count, POSITION_FEE_PASS_TARGET_MS and its measured batch latency
 *     (`chainAllotment`).
 *   - CANDIDATES `POSITION_FEE_CANDIDATES=memory` take `all` pages from a RAM
 *     store (`fee-candidate-store.ts`, fed by a background secondary load, a
 *     reconcile and writer hints) and touch Mongo only for rows that changed.
 *   - SIGNALS go through `fee-signals.ts`: in-process, or redis-state with
 *     leases on (any process marks, the fee worker drains).
 *   - LEASE: with leases on only the `fee-worker` holder ticks (the BullMQ
 *     backstop elsewhere is a no-op), its ramp starts at acquisition, every page
 *     re-checks the lease and every cursor/tally write carries its fence.
 */

/**
 * Mongo page size for a tier walk. 2000 (was 1000, 2026-10-03): a page read is
 * ~20 ms either way, and 1000 rows in batches of 200 left half of a concurrency
 * of 8 idle.
 */
export const MONGO_PAGE = 2000;

/**
 * Rows per tier page taken from the RAM store (memory mode): `batch × slots`
 * (design §8), so one page keeps every one of the chain's multicall slots busy
 * at once — `measureRows` measures a page's batches concurrently, but the walk
 * measures one page at a time, so a page of MONGO_PAGE rows capped a chain at
 * ⌈2000 / batch⌉ multicalls in flight whatever POSITION_FEE_CONCURRENCY_BY_CHAIN
 * said (4 at batch 500). Mongo-sourced pages stay MONGO_PAGE: that cap is the
 * size of one primary read.
 */
export function storePageSize(s: FeeP3Settings, chainId: number): number {
  return Math.max(1, batchSizeFor(s, chainId) * concurrencyFor(s, chainId));
}
/**
 * Give up on a single Mongo call after this long. The connection pool is shared
 * with API reads and every worker and has no wait-queue timeout, so during a
 * pool stall an await here can hang indefinitely — while holding this chain's
 * single-flight slot. Abandoning the tick frees it; the persisted cursor means
 * nothing already measured is redone. Fee writes get it as a DRIVER-side
 * timeout per bulkWrite (the operation is really abandoned), never applied to
 * the time a chunk waits for write tokens.
 */
const MONGO_CALL_TIMEOUT_MS = 60_000;
/**
 * Backstop on one chunk's `writeRpcFees` call: its bulkWrites carry the driver
 * timeout above, but the call also contains the wait for the stamp-only
 * fallback's write tokens, so this only fires if the driver timeout did not.
 */
const FEE_WRITE_BACKSTOP_MS = 3 * MONGO_CALL_TIMEOUT_MS;
/**
 * The longest one fee chunk may wait for the SHARED write budget (P2.4, enforce
 * only) — well under the backstop above. A chunk that would wait longer is not
 * sent (`WriteBudgetTimeoutError`, nothing taken): the tick ends before its
 * cursor save ("write deferred"), the chunk's RAM rows are marked `verify`, and
 * the next tick re-measures. Without it a chunk slept past the backstop and
 * landed later, outside the gate's pacing and possibly after the lease moved.
 */
export const FEE_BUDGET_WAIT_MS = 60_000;
/** How often every chain's tick fires (the chains are staggered across it). */
export const FEE_TICK_INTERVAL_MS = 60_000;
/**
 * A chain's ticks start at least this far apart. Timer slots for one chain
 * come every `slots × floor(60 s / slots)` ms (never early), so they always
 * clear it; a re-run after an overrun, or a slot right after one, is deferred
 * to it — so each chain still starts at most one tick per minute and the
 * shared read budget stays a per-minute ceiling.
 */
export const MIN_TICK_GAP_MS = FEE_TICK_INTERVAL_MS - 1_000;
/**
 * After boot the shared budget (reads and the write gate) ramps linearly from
 * `FEE_RAMP_FLOOR` of itself to all of it over `POSITION_FEE_RAMP_MS` — this
 * default when the config does not say (5 min since 2026-10-03; it was a
 * 30-min constant, which cost ~11 budget-minutes on every boot).
 */
export const FEE_RAMP_MS = 5 * 60_000;
const FEE_RAMP_FLOOR = 0.25;
/**
 * Wall-clock backstop on one tick. Waiting for write tokens can stretch a tick
 * past its minute — that is the gate's backpressure, and the slot is re-run
 * rather than lost — so this only ends a tick that is stuck.
 */
const TICK_DEADLINE_MS = 5 * 60_000;
/** Side-lane positions measured per drain (one Mongo read). */
const DIRTY_PER_DRAIN = 1_000;
/** Mongo reads the side lanes (live dirty + backfill) may issue in one tick. */
export const SIDE_READS_PER_TICK = 20;
/**
 * No side-lane drain STARTS later than this into a tick. A backfill drain of
 * never-measured rows is paced at half the served-write rate (~80 s per 1000
 * at the defaults), so without it a tick with no pass due could drain for its
 * whole 5-min deadline while that chain's views and live changes wait behind
 * it; with it a tick ends within a minute plus one drain, and the next one
 * serves views and the live set first.
 */
export const SIDE_DRAIN_WINDOW_MS = FEE_TICK_INTERVAL_MS;
/** While a tier pass is due, the side lanes may use at most this share of a tick's reads. */
export const DIRTY_SHARE_WHEN_TIER_DUE = 0.5;
/** A page with unanswered rows is re-read on at most this many consecutive ticks, then the pass moves on. */
export const HOLD_BACK_MAX_TICKS = 3;
/** Throttle for the queue-full warnings (a backfill can overflow its lane on every flush). */
const QUEUE_FULL_WARN_MS = 10 * 60_000;
/** The write-gate wait report: one line per this, when any write waited. */
export const GATE_REPORT_MS = 10 * 60_000;
const TOKEN_ID = /^\d+$/;
const FEE_TIERS: readonly FeeTier[] = ['all', 'hot'];
/** The store feed loop's period (memory mode). */
const FEED_LOOP_MS = 1_000;


export interface FeeRefreshResult {
  chainId: number;
  protocol: string;
  /** Positions read, per source, this tick (side-lane rows skipped as already fresh excluded). */
  tiers: Record<'view' | 'dirty' | 'backfill' | FeeTier, number>;
  /** Tier passes that completed during this tick. */
  finished: FeeTier[];
  scanned: number;
  measured: number;
  /** `rpcFees*` stamps that landed. */
  written: number;
  /** Of those, how many also rewrote the served fields. */
  served: number;
  /** Measurements refused because the position changed after their block. */
  stale: number;
  /** Identical re-reads not written: the stored measurement is still valid and recent. */
  unchanged: number;
  /** Per-call reverts the split retries could not answer. */
  failed: number;
  /** Rows whose batch the RPC never answered — not measured, not failed. */
  unanswered: number;
  /** Rows whose stored inputs can never be read (bad poolId, ticks or decimals). */
  unreadable: number;
  /** Side-lane rows skipped: the stored reading already post-dates the change that queued them. */
  skippedFresh: number;
  /** Time this tick's writes spent waiting for the write gate. */
  writeWaitMs: number;
  /** The tier whose page was held back this tick because the RPC left rows unanswered. */
  heldBack?: FeeTier;
  skipped?: string;
  durationMs: number;
}

type Measured = MeasuredRow<FeeRefreshCandidate>;
type MeasureOutcome = GenericMeasureOutcome<FeeRefreshCandidate>;

/**
 * A tier page; `partial` = a RAM-store page cut short by what the boot load has
 * covered (not the end); `fromStore` = read from RAM (no Mongo read); `asked` =
 * the limit the read actually used when it is below the one the walk asked for
 * (a store page asked for, read from Mongo because the store became unusable
 * meanwhile: capped at MONGO_PAGE, so a full read is not the end of the pass).
 */
type TierPage = FeeRefreshCandidate[] & { partial?: boolean; fromStore?: boolean; asked?: number };

interface ChainTick {
  chainId: number;
  protocol: string;
  key: string;
  result: FeeRefreshResult;
  /** Tier rows that reverted even after the split retries: queued dirty when the tick ends. */
  retryNextTick: string[];
  /** Tier rows this tick read from the RAM store (no Mongo read). */
  storeRows: number;
  /** Per-chain budget over a RAM store: those rows are not charged to the round (`tickAllotment`). */
  storeExempt: boolean;
  /** Aborted when the tick ends: a write still waiting for the shared write budget is never sent late. */
  abort: AbortController;
}

/** What one tick may still spend. */
interface Budget {
  /** Reads left this tick. */
  left: number;
  /** Of those, reads the side lanes may still take. */
  dirtyLeft: number;
  /** A tier pass is due: the side lanes are held to their read share and to the tier pages' wall time. */
  tierDue: boolean;
  /** Wall time spent on tier pages and on side-lane drains so far this tick. */
  tierMs: number;
  sideMs: number;
  /** Side-lane Mongo reads issued this tick. */
  sideReads: number;
  /** No side-lane drain starts after this (SIDE_DRAIN_WINDOW_MS into the tick). */
  sideUntil: number;
  /** A side-lane drain left rows unanswered: the RPC is failing, drain no more this tick. */
  sideStalled: boolean;
  /**
   * Mongo reads views and side lanes may still take. A chain paging its tier
   * passes from the RAM store under POSITION_FEE_BUDGET=per-chain has a huge
   * `left` that is not a Mongo budget, so its by-id reads stay within its share
   * of the round (the Mongo read ceiling); every other tick: `left`.
   */
  mongoLeft: number;
}

/** The next tier page, read while the current one is measured. */
interface Prefetch {
  tier: FeeTier;
  after: string;
  limit: number;
  /** Budget still held for it: the limit until it resolves, then its row count. */
  reserved: number;
  discarded: boolean;
  promise: Promise<TierPage>;
}

type WorkSource = 'view' | 'dirty' | 'backfill' | FeeTier;

/** Adds one page's (or drain's) counts into the tick's result. */
function addCounts(r: FeeRefreshResult, counts: FeePassTally): void {
  for (const k of FEE_PASS_TALLY_KEYS) r[k] += counts[k];
}

function addTally(base: FeePassTally | undefined, add: FeePassTally): FeePassTally {
  const out = { ...(base ?? emptyFeePassTally()) };
  for (const k of FEE_PASS_TALLY_KEYS) out[k] += add[k];
  return out;
}

/** Restamp windows are spread ±this around POSITION_FEE_RESTAMP_MS, per position. */
export const RESTAMP_JITTER = 0.25;

/**
 * A deterministic factor in [1 − RESTAMP_JITTER, 1 + RESTAMP_JITTER) from a
 * hash (FNV-1a) of the positionId. Without it every row measured in the same
 * pass after a deploy would come due for its restamp in the same pass a day
 * later, and the write wave would repeat daily; per-position windows spread it
 * over a quarter of the interval either side. Deterministic, so a position's
 * window does not move between passes.
 */
export function restampJitter(positionId: string): number {
  return stableJitter(positionId, RESTAMP_JITTER);
}

/**
 * An identical re-read that need not be written. Correctness only ever asks
 * whether the stored measurement is at or after the last fee-settling event
 * (`rpcFeesBlock ≥ lastModifyBlock`, see `chooseUncollected`) — never how old
 * its stamp is — so re-writing the same figure with a newer block buys
 * nothing but a Mongo write. On a pass most positions are idle or out of
 * range, and with CPU pinned on the M10 that write is the cost that matters.
 * The stamp is still refreshed once it is `restampMs` old (× the position's
 * `restampJitter` when its id is known), so `metrics.feesMeasuredAt` never
 * drifts further than that. `restampMs` 0 restores the always-write behaviour
 * — a trap in production, where it makes every re-read a write.
 */
export function isUnchangedMeasurement(
  candidate: Pick<FeeRefreshCandidate, 'rpc' | 'lastModifyBlock'> & { positionId?: string },
  fees0: string,
  fees1: string,
  nowMs: number,
  restampMs: number,
): boolean {
  const rpc = candidate.rpc;
  if (!rpc || restampMs <= 0) return false;
  if (!withinRereadTolerance(rpc.fees0, fees0) || !withinRereadTolerance(rpc.fees1, fees1)) return false;
  if (!(rpc.block > 0) || rpc.block < candidate.lastModifyBlock) return false;
  if (!(rpc.at instanceof Date)) return false;
  const window = candidate.positionId === undefined ? restampMs : restampMs * restampJitter(candidate.positionId);
  return nowMs - rpc.at.getTime() < window;
}

/**
 * Whether a queued side-lane row needs no RPC call: its stored on-chain
 * reading was taken at or after the block of the change that queued it AND at
 * or after its last fee-settling modify, so that reading already shows the
 * post-change state. `changeBlock` is the indexer's `updatedAtBlock` the live
 * listener saw (or the row's `lastModifyBlock` for a backfill flush); unknown
 * (`FORCE_REREAD`, ≤ 0) is never skipped. Both blocks come from the chain the
 * reading was pinned to, so they compare.
 */
export function isFreshForChange(
  candidate: Pick<FeeRefreshCandidate, 'rpc' | 'lastModifyBlock'>,
  changeBlock: number,
): boolean {
  const rpc = candidate.rpc;
  if (!rpc || !(rpc.block > 0)) return false;
  if (!Number.isFinite(changeBlock) || !(changeBlock > 0)) return false;
  return rpc.block >= changeBlock && rpc.block >= candidate.lastModifyBlock;
}

/**
 * Relative move below which a re-read token amount counts as unchanged. An
 * in-range position accrues a little on every read, so exact equality would
 * write every one of them on every pass; the SERVED figure has its own
 * materiality gate (`needsServedWrite`), so skipping these stamps never leaves
 * the shown value more than this far behind.
 */
export const FEE_REREAD_TOLERANCE = 0.01;

function withinRereadTolerance(stored: string, next: string): boolean {
  if (stored === next) return true;
  const a = Number(stored);
  const b = Number(next);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (a === 0 || b === 0) return a === b;
  return Math.abs(b - a) <= FEE_REREAD_TOLERANCE * Math.abs(a);
}

/** A pass is in progress while its start is newer than its last finish. */
export function tierInProgress(c: FeeTierCursor): boolean {
  if (!(c.startedAt instanceof Date)) return false;
  return !(c.finishedAt instanceof Date && c.finishedAt.getTime() >= c.startedAt.getTime());
}

/** In progress, or its interval has elapsed since the last pass STARTED. */
export function tierDue(c: FeeTierCursor, intervalMs: number, nowMs: number): boolean {
  if (tierInProgress(c)) return true;
  return !(c.startedAt instanceof Date) || nowMs - c.startedAt.getTime() >= intervalMs;
}

/**
 * Which tier the next page comes from, null when none is due. A hot interval
 * of 0 (the default) disables the hot tier. With hot enabled it goes first —
 * except that an `all` pass already in progress for more than half its
 * interval goes before it, so hot can never starve the full pass.
 */
export function nextTier(
  cursors: Record<FeeTier, FeeTierCursor>,
  nowMs: number,
  intervals: Record<FeeTier, number>,
): FeeTier | null {
  const hotOn = intervals.hot > 0;
  const allDue = tierDue(cursors.all, intervals.all, nowMs);
  if (hotOn && allDue && tierInProgress(cursors.all)) {
    const runningMs = nowMs - (cursors.all.startedAt?.getTime() ?? nowMs);
    if (runningMs > intervals.all / 2) return 'all';
  }
  if (hotOn && tierDue(cursors.hot, intervals.hot, nowMs)) return 'hot';
  if (allDue) return 'all';
  return null;
}

@Injectable()
export class PositionFeeRefreshService implements OnModuleInit, OnModuleDestroy, FeeHintSink {
  private readonly logger = new Logger(PositionFeeRefreshService.name);
  /** The fee lane's viem clients per chain (specs inject fakes here). */
  private readonly clients = new Map<number, PublicClient>();
  /** Single-flight per (chain, protocol). */
  private readonly inFlight = new Set<string>();
  /** The signal queues (views, live dirty set, backfill lane): in-process, or Redis with leases on. */
  private readonly signals: FeeSignals;
  /** The in-process queues (the memory transport, or the Redis transport's local fallback). */
  private readonly memorySignals: MemoryFeeSignals;
  /**
   * MONGO reads each chain took in its last finished tick (what the round
   * budget is the ceiling of): views, side lanes and Mongo-sourced tier pages —
   * never RAM-store pages.
   */
  private readonly lastUsed = new Map<string, number>();
  /** What each chain was allotted for that tick (all reads; the status block's `allotment`). */
  private readonly lastAllotted = new Map<string, number>();
  /** Of that, its share of the round (Mongo reads) — equal to `lastAllotted` except for a RAM-store chain under per-chain. */
  private readonly lastRoundCap = new Map<string, number>();
  /**
   * Whether that tick wanted more than it was given: it used its whole
   * allotment and still had work left (a pass due, or anything queued). A chain
   * that was given nothing and had nothing to do is not counted as wanting.
   */
  private readonly wanted = new Map<string, boolean>();
  /** The round share (Mongo reads) a tick in flight holds (it may still read all of it). */
  private readonly holding = new Map<string, number>();
  /** `[alert] fees.lease_unbound` sent (leases on, no fee-worker lease bound). */
  private leaseUnboundAlerted = false;
  /** A FEE_RPC_FETCH factory that did not return a function was reported. */
  private badFetchWarned = false;
  /** When each chain's latest tick started. */
  private readonly lastStart = new Map<string, number>();
  /** A timer slot arrived while the chain's tick was running: re-run it when that tick ends. */
  private readonly rerunPending = new Set<string>();
  /** A slot deferred to MIN_TICK_GAP_MS after the chain's last start. */
  private readonly deferred = new Map<string, NodeJS.Timeout>();
  /** A tier page held back for unanswered rows: its cursor and how many ticks in a row. */
  private readonly heldBack = new Map<string, { cursor: string; count: number }>();
  /** `[alert] fees.pass_overdue` sent for this pass start (per chain:tier). */
  private readonly overdueAlerted = new Map<string, number>();
  /** Queue-full warnings (live set, backfill lane, view queue), throttled per chain. */
  private readonly queueFull = new Map<string, { lastAt: number; pending: number }>();
  /** Rows the last finished full pass scanned, per chain (the per-chain budget's N before a store exists). */
  private readonly lastPassActive = new Map<string, number>();
  /** Served-path primary reads per chain (memory mode: verify + served rows only). */
  private readonly hydrated = new Map<string, number>();
  /** Process-wide per-second write pacing, shared by every chain. */
  private readonly writeGate: FeeWriteGate;
  /** The on-chain measurement (shared with P3.1's page reader). */
  private readonly measurer: FeeMeasurer;
  /** P3.3 RAM store feeds (memory mode only; created on first use). */
  private feed?: FeeCandidateFeed;
  /** The write-gate wait report's window. */
  private gateReport = { at: 0, waitedMs: 0 };
  /** The wait before an RPC retry (replaceable in specs). */
  private delay: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));
  /** When the timer started; the budget ramps up from here. Unset (no timer) = no ramp. */
  private rampFrom?: number;
  /** Round-robin position of the staggered timer. */
  private nextChain = 0;
  private timer?: NodeJS.Timeout;
  /** The store feed's 1 s loop (memory mode). */
  private feedTimer?: NodeJS.Timeout;
  private feedBusy = false;
  /** Where the store loads from (the secondary through CollectionResolver; specs replace it). */
  private storeSource?: FeeStoreSource;

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(PositionsRepository) private readonly positions: PositionsRepository,
    // APPENDED: specs construct this service positionally.
    @Inject(SyncRepository) private readonly syncRepo: SyncRepository,
    // P2/P3 (all APPENDED, all optional; absent = today's single process).
    @Optional() @Inject(FEE_COORDINATION) private readonly coord?: FeeCoordination,
    @Optional() @Inject(FEE_RPC_FETCH) private readonly rpcFetch?: FeeRpcFetchFactory,
    @Optional() @Inject(FeeRowHintPublisher) publisher?: FeeRowHintPublisher,
    @Optional() @Inject(CollectionResolver) resolver?: CollectionResolver,
  ) {
    this.writeGate = new FeeWriteGate((now) => {
      const ramp = this.rampFactor(now);
      return {
        all: this.config.positionFeeMaxWritesPerSec * ramp,
        served: this.config.positionFeeMaxServedWritesPerSec * ramp,
      };
    });
    this.measurer = new FeeMeasurer(config, rpcFetch, {
      client: (chainId) => this.clientFor(chainId),
      delay: (ms) => this.delay(ms),
      logger: this.logger,
      settings: () => this.p3(),
    });
    const transport = resolveSignalsTransport(this.p3().signalsTransport, Boolean(coord?.leasesEnabled));
    if (transport === 'redis' && coord) {
      const redis = new RedisFeeSignals(() => coord.stateRedis(), coord.namespace, (line) => this.logger.warn(line));
      this.signals = redis;
      this.memorySignals = redis.local;
    } else {
      if (transport === 'redis') {
        this.logger.warn('FEE_SIGNALS_TRANSPORT=redis but no FEE_COORDINATION is bound: fee signals stay in-process');
      }
      this.memorySignals = new MemoryFeeSignals();
      this.signals = this.memorySignals;
    }
    if (resolver) this.storeSource = mongoStoreSource(resolver);
    publisher?.attach(this);
  }

  /** The P3 settings (read structurally; every default is today's behaviour). */
  private p3(): FeeP3Settings {
    return resolveFeeP3Settings(this.config);
  }

  // The in-process queues, under the names the specs reach for.
  private get dirty(): Map<string, Map<string, number>> {
    return (this.memorySignals as unknown as { dirty: Map<string, Map<string, number>> }).dirty;
  }
  private get backfill(): Map<string, Map<string, number>> {
    return (this.memorySignals as unknown as { backfill: Map<string, Map<string, number>> }).backfill;
  }
  private get viewed(): Map<string, Set<string>> {
    return (this.memorySignals as unknown as { viewed: Map<string, Set<string>> }).viewed;
  }
  private get viewCooldown(): Map<string, number> {
    return (this.memorySignals as unknown as { viewCooldown: Map<string, number> }).viewCooldown;
  }

  /** Leases resolved on for this process (package A's setting, or the coordination's). */
  private leasesOn(): boolean {
    return Boolean(this.coord?.leasesEnabled) || leasesEnabled();
  }

  /**
   * Whether this process is the fee worker. Fails SAFE in a split deployment:
   *   - a role without the `fee-worker` capability (api, sync, feeder) never is
   *     one — the service exists there only for `markViewed` / `markDirty`;
   *   - with leases on, only while the bound `fee-worker` lease says held
   *     (`stillHeld()`: true in the runner's fail-open local mode too); leases on
   *     with NO lease bound is not a worker (never a second, unfenced one —
   *     `[alert] fees.lease_unbound` at boot);
   *   - leases off (`all`, today): always.
   * Checked before every tick, every page and every cursor write.
   */
  private isWorker(): boolean {
    if (!can('fee-worker')) return false;
    const lease = this.coord?.lease;
    if (lease) return lease.held();
    return !this.leasesOn();
  }

  onModuleInit(): void {
    if (!this.config.positionFeeRefreshEnabled) return;
    // Status fan-in (design §2.1): every role that runs the fee service reports it
    // (`worker: false` outside the holder).
    registerStatusContributor('fee', () => this.feeStatus());
    if (!can('fee-worker')) {
      // markViewed / markDirty still queue (redis-state with leases on); the fee role drains.
      this.logger.log('Position fee refresh: this role has no fee-worker capability; marks only, no ticks');
      return;
    }
    if (this.leasesOn() && !this.coord?.lease && !this.leaseUnboundAlerted) {
      this.leaseUnboundAlerted = true;
      this.logger.warn(
        '[alert] fees.lease_unbound — leases are on but no fee-worker lease is bound (FEE_COORDINATION.lease): ' +
          'this process will NOT run fee ticks rather than run them unfenced beside the holder',
      );
    }
    this.rampFrom = Date.now();
    // One chain per slot, round robin: every chain still ticks once per
    // FEE_TICK_INTERVAL_MS, but at its own offset rather than all together.
    const slots = Math.max(1, this.readableChains().length);
    this.timer = setInterval(() => this.tickNext(), Math.floor(FEE_TICK_INTERVAL_MS / slots));
    this.timer.unref?.();
    if (this.p3().candidates === 'memory') {
      // The store loads in the BACKGROUND (C19): never awaited here.
      this.feedTimer = setInterval(() => void this.feedLoop(), FEED_LOOP_MS);
      this.feedTimer.unref?.();
    }
  }

  onModuleDestroy(): void {
    unregisterStatusContributor('fee');
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.feedTimer) clearInterval(this.feedTimer);
    this.feedTimer = undefined;
    this.feed?.stop();
    for (const t of this.deferred.values()) clearTimeout(t);
    this.deferred.clear();
    this.rerunPending.clear();
  }

  /** One tick for every chain this process can read (each subject to the slot rules). */
  tickAll(): void {
    for (const i of this.readableChains()) this.requestTick(i.chainId, i.protocol);
  }

  /** The staggered timer's slot: the next readable chain, round robin. */
  private tickNext(): void {
    const chains = this.readableChains();
    if (chains.length === 0) return;
    const i = chains[this.nextChain++ % chains.length]!;
    this.requestTick(i.chainId, i.protocol);
  }

  /**
   * A slot for one chain. A tick in flight is not interrupted and the slot is
   * not lost: the chain re-runs when that tick ends. A slot sooner than
   * MIN_TICK_GAP_MS after the chain's last start is deferred to it.
   */
  private requestTick(chainId: number, protocol: string): void {
    const key = `${chainId}:${protocol}`;
    if (this.inFlight.has(key)) {
      this.rerunPending.add(key);
      return;
    }
    if (this.deferred.has(key)) return;
    const last = this.lastStart.get(key);
    const waitMs = last === undefined ? 0 : last + MIN_TICK_GAP_MS - Date.now();
    if (waitMs > 0) {
      const t = setTimeout(() => {
        this.deferred.delete(key);
        if (this.timer) this.requestTick(chainId, protocol);
      }, waitMs);
      t.unref?.();
      this.deferred.set(key, t);
      return;
    }
    void this.refreshChain(chainId, protocol);
  }

  private readableChains(): Array<{ chainId: number; protocol: string }> {
    const urls = this.config.evmRpcUrls;
    return this.config.enabledIntegrations.filter((i) => urls.has(i.chainId) && uniswapV4ContractsFor(i.chainId));
  }

  private canRead(chainId: number): boolean {
    return this.config.evmRpcUrls.has(chainId) && Boolean(uniswapV4ContractsFor(chainId));
  }

  /**
   * How many positions THIS chain's tick may read (views, side lanes and tier
   * pages alike), out of the one round budget every chain shares.
   *
   * CEILING: at most the budget less what every OTHER chain took in its latest
   * tick (or holds in a tick still in flight; a chain that has not ticked yet
   * is assumed to need its fair share). Each chain starts at most one tick per
   * minute, so the reads of all chains in any round add up to the budget.
   * (It used to reserve each other chain at most its fair share, and a busy
   * chain took the rest — with three busy chains and one idle, 1.5× the budget
   * every round.)
   *
   * SHARE: the chains that want more (they used all they were given, or have
   * not ticked yet) split equally what the idle ones leave; so a chain alone
   * with a backlog gets nearly all of it, and chains that are all busy get an
   * equal share each. A chain that suddenly needs more gets what is left this
   * tick and its share from its next one, once the others have been cut back.
   */
  allotment(key: string, now: number = Date.now()): number {
    const total = Math.max(1, Math.floor(this.config.positionFeeMaxPerTick * this.rampFactor(now)));
    const others = this.readableChains()
      .map((i) => `${i.chainId}:${i.protocol}`)
      .filter((k) => k !== key);
    const fair = Math.ceil(total / (others.length + 1));
    let held = 0;
    let idleHeld = 0;
    let hungry = 1;
    for (const k of others) {
      const inFlight = this.holding.get(k);
      if (inFlight !== undefined) {
        held += inFlight;
        hungry++;
        continue;
      }
      const used = this.lastUsed.get(k);
      if (used === undefined) {
        held += fair;
        hungry++;
        continue;
      }
      held += used;
      if (this.wanted.get(k) ?? used >= (this.lastRoundCap.get(k) ?? fair)) hungry++;
      else idleHeld += used;
    }
    const share = Math.floor((total - idleHeld) / hungry);
    return Math.max(0, Math.min(share, total - held));
  }

  /**
   * P3.2 `POSITION_FEE_BUDGET=per-chain`: what this chain may measure in one
   * tick — enough to finish its pass inside POSITION_FEE_PASS_TARGET_MS
   * (`perChainAllotment`, sized from its active count and its measured batch
   * latency), ramped like the round budget. Pages from Mongo (no RAM store) stay
   * capped by the round budget too: it is the Mongo read ceiling. Default
   * `round` = `allotment`, exactly today.
   */
  chainAllotment(chainId: number, protocol: string, now: number = Date.now()): number {
    return this.tickAllotment(chainId, protocol, now).total;
  }

  /**
   * `total`: what the tick may read (`chainAllotment`). `roundCap`: its share of
   * the round — the Mongo reads it may take, what other chains' allotments are
   * charged with. Equal, except for a chain whose tier pages come from the RAM
   * store under per-chain: those pages read no Mongo, so only its views and side
   * lanes count against the round (charging its whole `total` would leave a
   * chain still on Mongo pages — a failed store, say — with nothing).
   */
  private tickAllotment(
    chainId: number,
    protocol: string,
    now: number,
  ): { total: number; roundCap: number; storeExempt: boolean } {
    const key = `${chainId}:${protocol}`;
    const round = this.allotment(key, now);
    const s = this.p3();
    // Round mode: the round IS this tick's whole budget, RAM pages included (today).
    if (s.budget !== 'per-chain') return { total: round, roundCap: round, storeExempt: false };
    const store = this.activeStore(chainId, protocol);
    const active = store?.complete ? store.size : this.lastPassActive.get(key);
    if (active === undefined) return { total: round, roundCap: round, storeExempt: false };
    const per = perChainAllotment({
      active,
      passTargetMs: s.passTargetMs,
      slots: concurrencyFor(s, chainId),
      batch: batchSizeFor(s, chainId),
      latencyMs: this.measurer.stats(chainId).latencyEwmaMs,
    });
    const ramped = Math.max(1, Math.floor(per * this.rampFactor(now)));
    if (store) return { total: ramped, roundCap: Math.min(ramped, round), storeExempt: true };
    const capped = Math.min(ramped, round);
    return { total: capped, roundCap: capped, storeExempt: false };
  }

  private rampFactor(now: number): number {
    // With leases on, the ramp starts when THIS process took the lease, not at
    // boot; no acquisition time (not held, or the runner's fail-open local mode)
    // falls back to the boot ramp.
    const from = this.coord?.lease?.acquiredAt() ?? this.rampFrom;
    if (from === undefined) return 1;
    const rampMs = this.config.positionFeeRampMs ?? FEE_RAMP_MS;
    if (rampMs <= 0) return 1;
    const elapsed = Math.max(0, now - from);
    return Math.min(1, FEE_RAMP_FLOOR + (1 - FEE_RAMP_FLOOR) * (elapsed / rampMs));
  }

  /**
   * Queue positions for a re-read — by the live listener for every position
   * whose `updatedAtBlock` moved (the LIVE set, the default), and by the
   * backfill for the active rows of every flush (`lane: 'backfill'`, drained
   * only once the live set is empty, with its own cap). `blocks` carries the
   * block of the change per id (the indexer's `updatedAtBlock`, or the row's
   * `lastModifyBlock`): a row whose stored reading is already at or after it is
   * then skipped at drain time without an RPC call. An id with no block is
   * always re-read. A live change to a position the backfill lane already holds
   * moves it to the live set; a backfill mark of one the live set holds leaves
   * it there. Re-marking keeps the LATER change block. A Transfer also moves
   * `updatedAtBlock`; re-reading one costs a single call and changes nothing.
   * With leases on the queues live in redis-state (`fee-signals.ts`), so any
   * process can mark and the fee worker drains.
   */
  markDirty(
    chainId: number,
    tokenIds: Iterable<string>,
    protocol: string,
    blocks?: ReadonlyMap<string, number>,
    opts: { lane?: DirtyLane } = {},
  ): void {
    if (!this.config.positionFeeRefreshEnabled) return;
    if (!this.canRead(chainId)) return;
    const lane = opts.lane ?? 'live';
    const key = `${chainId}:${protocol}`;
    const entries: Array<[string, number]> = [];
    for (const raw of tokenIds) {
      const id = String(raw);
      if (!TOKEN_ID.test(id)) continue;
      const b = blocks?.get(id);
      entries.push([id, typeof b === 'number' && Number.isFinite(b) && b > 0 ? b : FORCE_REREAD]);
    }
    if (entries.length === 0) return;
    const dropped = this.signals.markDirty(key, lane, entries);
    if (typeof dropped === 'number') {
      if (dropped > 0) this.warnFull(key, lane, dropped);
      return;
    }
    void dropped.then((n) => n > 0 && this.warnFull(key, lane, n)).catch(() => undefined);
  }

  /** One warning per queue per chain per QUEUE_FULL_WARN_MS: a backfill can overflow its lane on every flush. */
  private warnFull(key: string, queue: DirtyLane | 'view', dropped: number): void {
    const now = Date.now();
    const wk = `${queue}:${key}`;
    const s = this.queueFull.get(wk) ?? { lastAt: Number.NEGATIVE_INFINITY, pending: 0 };
    s.pending += dropped;
    if (now - s.lastAt >= QUEUE_FULL_WARN_MS) {
      const line =
        queue === 'live'
          ? `Position fee dirty set ${key} is full (${DIRTY_MAX_PER_CHAIN}); ${s.pending} changed positions left to the tier passes`
          : queue === 'backfill'
            ? `Position fee backfill queue ${key} is full (${BACKFILL_MAX_PER_CHAIN}); ${s.pending} backfilled positions left to the tier passes`
            : `Position fee view queue ${key} is full (${VIEW_QUEUE_MAX_PER_CHAIN}); ${s.pending} detail opens not queued — the next open of each can queue it`;
      this.logger.warn(line);
      s.lastAt = now;
      s.pending = 0;
    }
    this.queueFull.set(wk, s);
  }

  /** How many positions are waiting in this process's live dirty set (observability, specs). */
  dirtySize(chainId: number, protocol: string): number {
    return this.memorySignals.sizes(`${chainId}:${protocol}`).live;
  }

  /** How many positions are waiting in this process's backfill lane (observability, specs). */
  backfillSize(chainId: number, protocol: string): number {
    return this.memorySignals.sizes(`${chainId}:${protocol}`).backfill;
  }

  /**
   * A position was just opened in the detail view: re-read it on the next
   * tick. Synchronous, in-memory (or one Redis call with leases on, never
   * awaited), never an RPC call — the request path only queues. At most once
   * per position per VIEW_COOLDOWN_MS, and the queue has its own per-tick quota
   * (POSITION_FEE_VIEW_PER_TICK), so a burst of opens cannot crowd out the side
   * lanes or the passes. The cooldown starts only when the position is actually
   * queued: an open dropped because the queue is full leaves none, so the next
   * open can still queue it.
   */
  markViewed(chainId: number, protocol: string, positionId: string): void {
    if (!this.config.positionFeeRefreshEnabled) return;
    if (protocol !== 'uniswap-v4' || this.viewQuota() <= 0) return;
    if (!this.canRead(chainId)) return;
    const id = String(positionId);
    if (!TOKEN_ID.test(id)) return;
    const key = `${chainId}:${protocol}`;
    const res = this.signals.markViewed(key, id, Date.now());
    if (typeof res === 'string') {
      if (res === 'full') this.warnFull(key, 'view', 1);
      return;
    }
    void res.then((r) => r === 'full' && this.warnFull(key, 'view', 1)).catch(() => undefined);
  }

  /** How many viewed positions are waiting in this process (observability, specs). */
  viewedSize(chainId: number, protocol: string): number {
    return this.memorySignals.sizes(`${chainId}:${protocol}`).views;
  }

  /** Anything waiting for this chain in a view queue or a side lane. */
  private async hasQueued(key: string): Promise<boolean> {
    try {
      const s = await this.signals.sizes(key);
      return s.views + s.live + s.backfill > 0;
    } catch {
      return true;
    }
  }

  /** Whole-request RPC failures seen on `chainId` since boot (observability, specs). */
  rpcBatchFailures(chainId: number): number {
    return this.measurer.rpcBatchFailures(chainId);
  }

  private viewQuota(): number {
    const v = Number(this.config.positionFeeViewPerTick ?? 200);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
  }

  private passAlertMs(): number {
    const v = Number(this.config.positionFeePassAlertMs ?? 3_000_000);
    return Number.isFinite(v) && v > 0 ? v : 3_000_000;
  }

  // ─── P3.3: the RAM store ─────────────────────────────────────────────────────

  /** Replace where the store loads from (specs; production uses the secondary). */
  useStoreSource(source: FeeStoreSource): void {
    this.storeSource = source;
  }

  private feedFor(): FeeCandidateFeed | undefined {
    if (this.p3().candidates !== 'memory' || !this.storeSource) return undefined;
    this.feed ??= new FeeCandidateFeed({
      source: this.storeSource,
      settings: () => this.p3(),
      logger: this.logger,
      coord: this.coord,
    });
    return this.feed;
  }

  /** The chain's store when the pass may take its pages from it (memory mode, loading or ready). */
  private activeStore(chainId: number, protocol: string): FeeCandidateStore | undefined {
    const feed = this.p3().candidates === 'memory' ? this.feed : undefined;
    if (!feed || !feed.usable(chainId, protocol)) return undefined;
    return feed.store(chainId, protocol);
  }

  /**
   * The store's upkeep, once a second while this process is the fee worker:
   * start each chain's background load, run due/requested reconciles, and (leases
   * on) read the writer-hint streams.
   */
  async feedLoop(): Promise<void> {
    if (this.feedBusy || !this.isWorker()) return;
    const feed = this.feedFor();
    if (!feed) return;
    this.feedBusy = true;
    try {
      for (const i of this.readableChains()) {
        if (i.protocol !== 'uniswap-v4') continue;
        feed.start(i.chainId, i.protocol);
        feed.maintain(i.chainId, i.protocol);
      }
      await feed.consumeOnce();
    } catch (err) {
      this.logger.warn(`Fee store upkeep failed: ${(err as Error)?.message ?? String(err)}`);
    } finally {
      this.feedBusy = false;
    }
  }

  /** `FeeHintSink`: writer hints delivered in-process (leases off). */
  applyHints(chainId: number, protocol: string, rows: readonly FeeRowHint[]): void {
    if (!this.isWorker()) return;
    this.feedFor()?.applyHints(chainId, protocol, rows);
  }

  /** The fee block of `/admin/sync/status` (wired by the integrator). */
  feeStatus(): Record<string, unknown> {
    const s = this.p3();
    const chains: Record<string, unknown> = {};
    for (const i of this.readableChains()) {
      const key = `${i.chainId}:${i.protocol}`;
      const st = this.measurer.stats(i.chainId);
      const batch = batchSizeFor(s, i.chainId);
      const active = this.activeStore(i.chainId, i.protocol)?.size ?? this.lastPassActive.get(key);
      chains[key] = {
        batch,
        slots: concurrencyFor(s, i.chainId),
        suggestedSlots:
          active === undefined ? 0 : suggestedSlots((FEE_CHAIN_BUDGET_HEADROOM * active) / (s.passTargetMs / 1000), st.latencyEwmaMs, batch),
        latencyEwmaMs: st.latencyEwmaMs,
        latencyP95Ms: st.latencyP95Ms,
        batches: st.batches,
        heads: st.heads,
        gasSplits: st.gasSplits,
        rpcFailures: st.rpcFailures,
        servedHydrated: this.hydrated.get(key) ?? 0,
        allotment: this.lastAllotted.get(key),
      };
    }
    return {
      worker: this.isWorker(),
      candidates: s.candidates,
      signals: this.signals.kind,
      budget: s.budget,
      headPer: s.headPer,
      chains,
      store: this.feed?.status() ?? {},
    };
  }

  /**
   * One tick for one chain: views, then the side lanes, then pages of
   * whichever tier pass is due (draining the side lanes between pages),
   * persisting the tier's cursor and counts after every page. Never throws: a
   * failed tick costs one minute of freshness, and the next resumes. With
   * leases on it runs only in the `fee-worker` holder — the BullMQ backstop in
   * any other process is a no-op.
   */
  async refreshChain(chainId: number, protocol: string): Promise<FeeRefreshResult> {
    return runInWriteLane('fee', () => this.refreshChainInLane(chainId, protocol));
  }

  private async refreshChainInLane(chainId: number, protocol: string): Promise<FeeRefreshResult> {
    const startedAt = Date.now();
    const result: FeeRefreshResult = {
      chainId,
      protocol,
      tiers: { view: 0, dirty: 0, backfill: 0, hot: 0, all: 0 },
      finished: [],
      scanned: 0,
      measured: 0,
      written: 0,
      served: 0,
      stale: 0,
      unchanged: 0,
      failed: 0,
      unanswered: 0,
      unreadable: 0,
      skippedFresh: 0,
      writeWaitMs: 0,
      durationMs: 0,
    };
    const done = (skipped?: string): FeeRefreshResult => {
      result.durationMs = Date.now() - startedAt;
      if (skipped) result.skipped = skipped;
      return result;
    };

    if (protocol !== 'uniswap-v4') return done('not a Uniswap v4 integration');
    const url = this.config.evmRpcUrls.get(chainId);
    if (!url) return done('no RPC url for this chain in EVM_RPC_URLS');
    const contracts = uniswapV4ContractsFor(chainId);
    if (!contracts) return done('no UNISWAP_V4_CONTRACTS entry for this chain in chains.config');
    if (!this.isWorker()) return done('not the fee-worker lease holder');

    // A second tick while one is in progress returns IMMEDIATELY instead of
    // awaiting the first. Every awaiting BullMQ job (the backstop on the
    // background-sweeps queue) would hold a worker slot for the whole tick —
    // the failure that once starved admin backfills behind coalesced
    // token-price sweeps. (A timer slot that lands here instead is re-run when
    // the tick ends — see `requestTick`.)
    const key = `${chainId}:${protocol}`;
    if (this.inFlight.has(key)) return done('a run is already in progress');
    this.inFlight.add(key);
    this.lastStart.set(key, startedAt);
    const retryNextTick: string[] = [];
    const tick: ChainTick = {
      chainId,
      protocol,
      key,
      result,
      retryNextTick,
      storeRows: 0,
      storeExempt: false,
      abort: new AbortController(),
    };
    /** This tick's round share (Mongo reads); unset: the tick did not get that far. */
    let roundCap: number | undefined;
    /** A pass is still due when the tick ends (unset: the tick did not get that far). */
    let tierStillDue: boolean | undefined;

    try {
      // Inside the try: a client that cannot be built (malformed url) must still
      // release the single-flight slot, or the chain would never tick again.
      this.clientFor(chainId);
      if (this.p3().candidates === 'memory') {
        const feed = this.feedFor();
        feed?.start(chainId, protocol);
        feed?.maintain(chainId, protocol);
      }
      const cursors = await withTimeout(this.syncRepo.getFeeCursors(chainId, protocol), MONGO_CALL_TIMEOUT_MS, 'fee cursor read');
      const intervals = { hot: this.config.positionFeeHotIntervalMs, all: this.config.positionFeeFullIntervalMs };
      // Views and side-lane re-reads are charged against the same budget as
      // tier pages — and while a pass is due the side lanes get at most half of
      // it (and no more wall time than the pages), so a flood of changes (a
      // backfill, a busy hour) can never starve it.
      const { total: allotment, roundCap: cap, storeExempt } = this.tickAllotment(chainId, protocol, startedAt);
      roundCap = cap;
      tick.storeExempt = storeExempt;
      this.lastAllotted.set(key, allotment);
      this.lastRoundCap.set(key, cap);
      this.holding.set(key, cap);
      const tierDueNow = nextTier(cursors, startedAt, intervals) !== null;
      const budget: Budget = {
        left: allotment,
        dirtyLeft: tierDueNow ? Math.floor(allotment * DIRTY_SHARE_WHEN_TIER_DUE) : allotment,
        tierDue: tierDueNow,
        tierMs: 0,
        sideMs: 0,
        sideReads: 0,
        sideUntil: startedAt + SIDE_DRAIN_WINDOW_MS,
        sideStalled: false,
        mongoLeft: storeExempt ? cap : allotment,
      };
      const deadline = startedAt + TICK_DEADLINE_MS;
      this.alertOverdue(tick, cursors, intervals, startedAt);
      await this.drainViews(tick, budget);
      await this.drainSide(tick, budget, deadline);
      const tiersRanOut = await this.walkTiers(tick, cursors, intervals, budget, deadline);
      if (tiersRanOut && budget.tierDue) {
        // Every pass is done for now: the side lanes may use the rest of the tick.
        budget.tierDue = false;
        budget.dirtyLeft = budget.left;
        await this.drainSide(tick, budget, deadline);
      }
      tierStillDue = nextTier(cursors, Date.now(), intervals) !== null;
    } catch (err) {
      this.logger.warn(`Position fee refresh ${key} aborted: ${(err as Error)?.message ?? String(err)}`);
      return done(`aborted: ${(err as Error)?.message ?? String(err)}`);
    } finally {
      // A chunk still waiting for the shared write budget (a backstop fired, the
      // tick aborted) is refused rather than sent after the tick has moved on.
      tick.abort.abort(new Error('fee tick ended'));
      this.inFlight.delete(key);
      this.holding.delete(key);
      // Queued only now, so the retry lands on the NEXT tick (~60 s later, a new
      // block) instead of seconds later in this one's own dirty drains.
      if (retryNextTick.length > 0) this.markDirty(chainId, retryNextTick, protocol);
      const t = result.tiers;
      // Under per-chain, a RAM-store chain's pages are not the round's (Mongo reads) to count.
      const used = Math.max(0, t.view + t.dirty + t.backfill + t.hot + t.all - (tick.storeExempt ? tick.storeRows : 0));
      this.lastUsed.set(key, used);
      if (roundCap !== undefined) {
        // An aborted tick is assumed to have had work left.
        const backlog = (tierStillDue ?? true) || (await this.hasQueued(key));
        this.wanted.set(key, used >= roundCap && backlog);
      }
      this.reportGate();
      // A timer slot arrived while this tick ran: the chain gets it now.
      if (this.rerunPending.delete(key) && this.timer) this.requestTick(chainId, protocol);
    }

    if (result.scanned > 0 || result.skippedFresh > 0) {
      // Every minute per chain while a pass runs — debug unless something failed;
      // the per-pass line is the one to watch.
      const t = result.tiers;
      const line =
        `Position fee refresh ${key} view=${t.view} dirty=${t.dirty} backfill=${t.backfill} hot=${t.hot} ` +
        `all=${t.all} measured=${result.measured} written=${result.written} served=${result.served} ` +
        `stale=${result.stale} unchanged=${result.unchanged} failed=${result.failed} unanswered=${result.unanswered} ` +
        `unreadable=${result.unreadable} skippedFresh=${result.skippedFresh} writeWaitMs=${result.writeWaitMs}` +
        `${result.heldBack ? ` heldBack=${result.heldBack}` : ''} durationMs=${Date.now() - startedAt}`;
      if (result.failed > 0 || result.unanswered > 0) this.logger.warn(line);
      else this.logger.debug(line);
    }
    return done();
  }

  /**
   * Tier pages until the budget, the deadline or the due passes run out.
   * Returns true when it stopped because no pass is due.
   *
   * PIPELINE: the next page is READ while the current one is measured, and a
   * page is MEASURED while the previous page is written (at most one page's
   * writes outstanding). A page's cursor and counts are saved only once that
   * page has been persisted, in page order; a page the RPC left partly
   * unanswered is held back (not advanced, read-ahead discarded) so the next
   * tick re-reads it. The last page of a pass is settled before anything
   * else, so a new pass can never start while the old one's counts are being
   * written.
   *
   * Memory mode: an `all` page comes from the RAM store; a page cut short only
   * because the boot load has not covered further (`partial`) advances the
   * cursor and ends the tick WITHOUT finishing the pass. With leases on, the
   * walk stops before any page once this process no longer holds the lease.
   */
  private async walkTiers(
    tick: ChainTick,
    cursors: Record<FeeTier, FeeTierCursor>,
    intervals: Record<FeeTier, number>,
    budget: Budget,
    deadline: number,
  ): Promise<boolean> {
    const { result } = tick;
    let prefetch: Prefetch | undefined;
    /** The previous page's persist + cursor save, still running. */
    let pending: Promise<void> | undefined;
    const dropPrefetch = () => {
      if (prefetch) this.discardPrefetch(prefetch, budget);
      prefetch = undefined;
    };
    const settle = async () => {
      const p = pending;
      pending = undefined;
      if (p) await p;
    };
    let ranOut = false;
    try {
      while (Date.now() < deadline && (budget.left > 0 || prefetch)) {
        if (!this.isWorker()) break;
        const t0 = Date.now();
        const now = new Date(t0);
        const tier = nextTier(cursors, now.getTime(), intervals);
        if (!tier) {
          ranOut = true;
          break;
        }
        const c = cursors[tier];
        // The pass's first page REPLACES the persisted counts; later pages add.
        const firstPage = !tierInProgress(c);
        if (firstPage) {
          c.cursor = '';
          c.startedAt = now;
          c.tally = undefined;
        }

        let page: TierPage;
        let limit: number;
        if (prefetch && prefetch.tier === tier && prefetch.after === c.cursor) {
          limit = prefetch.limit;
          const ahead = prefetch;
          prefetch = undefined;
          page = await ahead.promise;
        } else {
          dropPrefetch();
          limit = this.pageLimit(tick, tier, budget.left);
          if (limit <= 0) break;
          page = await this.readPage(tick, tier, c.cursor, limit, budget);
        }
        // Not covered by the store's boot load yet: nothing to measure here this tick.
        if (page.partial && page.length === 0) break;
        // What the read really asked for (a store page read from Mongo is capped).
        const asked = Math.min(limit, page.asked ?? limit);
        // A full page may have more behind it, and its last tokenId is the next
        // page's cursor: start reading that while this one is measured.
        if (page.length === asked && page.length > 0 && budget.left > 0) {
          prefetch = this.prefetchPage(tick, tier, page[page.length - 1]!.tokenId, this.pageLimit(tick, tier, budget.left), budget);
        }

        result.tiers[tier] += page.length;
        if (page.fromStore) tick.storeRows += page.length;
        const counts = emptyFeePassTally();
        const outcome = await this.measureRows(tick, page, tier, counts);

        if (outcome.unanswered.length > 0 && this.holdBack(tick, tier, c.cursor, outcome.unanswered.length)) {
          // Not advanced and not saved: the next tick re-reads this page (rows
          // measured now are still written, and read as unchanged then), and
          // the page is counted on the attempt that advances past it. The page
          // read ahead of it is discarded (and its budget refunded) by the
          // finally; the previous page's save is let finish first.
          await settle();
          try {
            await this.persist(tick, outcome.rows, counts, tier);
          } finally {
            addCounts(result, counts);
          }
          result.heldBack = tier;
          break;
        }
        this.heldBack.delete(`${tick.key}:${tier}`);

        // Advance in memory now (the next page's cursor); saved once persisted.
        const short = page.length < asked;
        const finished = short && !page.partial;
        if (finished) {
          // A short page: nothing is left above the cursor, so the pass is done.
          c.cursor = '';
          c.finishedAt = new Date();
        } else {
          c.cursor = page[page.length - 1]!.tokenId;
        }
        const save: FeeTierCursor = { cursor: c.cursor, startedAt: c.startedAt, finishedAt: c.finishedAt };
        await settle();
        pending = this.persistPage(tick, tier, c, outcome.rows, counts, save, firstPage, finished);
        // Surfaced by `settle`; must not be an unhandled rejection meanwhile.
        pending.catch(() => undefined);
        if (finished) await settle();
        budget.tierMs += Date.now() - t0;
        // A partial page (the store has not covered further yet) falls through:
        // the next read is empty-and-partial, which ends the walk above.
        await this.drainSide(tick, budget, deadline);
      }
      await settle();
    } finally {
      dropPrefetch();
      // Aborting: a page still being written may finish (its save is still
      // right), but never masks the error that ended the tick.
      if (pending) await pending.catch(() => undefined);
    }
    return ranOut;
  }

  /** Write one measured tier page, then fold its counts into the pass and save its cursor. */
  private async persistPage(
    tick: ChainTick,
    tier: FeeTier,
    c: FeeTierCursor,
    rows: Measured[],
    counts: FeePassTally,
    save: FeeTierCursor,
    firstPage: boolean,
    finished: boolean,
  ): Promise<void> {
    try {
      await this.persist(tick, rows, counts, tier);
    } finally {
      addCounts(tick.result, counts);
    }
    c.tally = addTally(firstPage ? undefined : c.tally, counts);
    await this.saveCursor(tick, tier, save, { mode: firstPage ? 'set' : 'inc', counts });
    if (finished) {
      tick.result.finished.push(tier);
      this.logPass(tick, tier, c);
    }
  }

  /**
   * The cursor + tally write. With leases on it is FENCED: the fence of this
   * process's `fee-worker` holding goes with it, and a deposed holder (its
   * lease gone, or the repository refusing an older fence) writes nothing and
   * ends the tick — a GC pause past the TTL can never move a newer holder's
   * cursor backwards or double its counts.
   *
   * Held with NO fence = the lease runner's fail-open LOCAL mode (role `all`,
   * Redis unreachable: design §2.1 keeps `all`'s singletons running): the write
   * is today's unfenced 5-argument call, so the pass keeps advancing through a
   * Redis outage instead of re-measuring its first page every tick.
   */
  private async saveCursor(
    tick: ChainTick,
    tier: FeeTier,
    save: FeeTierCursor,
    tally: { mode: 'set' | 'inc'; counts: FeePassTally },
  ): Promise<void> {
    const lease = this.coord?.lease;
    let fence: number | undefined;
    if (lease) {
      if (!lease.held()) throw new Error(`fee-worker lease lost before the ${tier} cursor write; not saved`);
      fence = lease.fence();
    }
    // SyncRepository.saveFeeCursor gains `fence` as its 6th parameter (integrator, I0):
    // passed only with leases on, so today's 5-argument call is unchanged.
    const write = this.syncRepo.saveFeeCursor as unknown as (...args: unknown[]) => Promise<void | boolean>;
    const args: unknown[] = [tick.chainId, tick.protocol, tier, save, tally];
    if (fence !== undefined) args.push(fence);
    const ok = await withTimeout(write.apply(this.syncRepo, args), MONGO_CALL_TIMEOUT_MS, 'fee cursor write');
    if (ok === false) {
      this.logger.warn(
        `[alert] fees.fence_refused chain=${tick.chainId} tier=${tier} fence=${fence} — a newer fee-worker holds the cursor; this process stops`,
      );
      throw new Error(`fee cursor write refused: fence ${fence} deposed`);
    }
  }

  /**
   * The rows to ask for in one tier page: `storePageSize` (batch × slots) when
   * the page will come from the RAM store, MONGO_PAGE from Mongo; never more
   * than the tick has left.
   */
  private pageLimit(tick: ChainTick, tier: FeeTier, left: number): number {
    const fromStore = tier === 'all' && this.activeStore(tick.chainId, tick.protocol) !== undefined;
    return Math.min(fromStore ? storePageSize(this.p3(), tick.chainId) : MONGO_PAGE, left);
  }

  private async readPage(tick: ChainTick, tier: FeeTier, after: string, limit: number, budget: Budget): Promise<TierPage> {
    budget.left -= limit;
    const page = await withTimeout(this.findTierPage(tick, tier, after, limit), MONGO_CALL_TIMEOUT_MS, `${tier} page read`);
    budget.left += limit - page.length;
    return page;
  }

  private prefetchPage(tick: ChainTick, tier: FeeTier, after: string, limit: number, budget: Budget): Prefetch {
    // Reserved now, so a side-lane drain between pages cannot spend it twice.
    budget.left -= limit;
    const pf: Prefetch = { tier, after, limit, reserved: limit, discarded: false, promise: Promise.resolve([]) };
    pf.promise = withTimeout(this.findTierPage(tick, tier, after, limit), MONGO_CALL_TIMEOUT_MS, `${tier} page read`).then(
      (rows) => {
        if (!pf.discarded) {
          budget.left += limit - rows.length;
          pf.reserved = rows.length;
        }
        return rows;
      },
    );
    // Awaited (and rethrown) when used; a discarded prefetch's failure is moot,
    // and must not surface as an unhandled rejection meanwhile.
    pf.promise.catch(() => undefined);
    return pf;
  }

  private discardPrefetch(pf: Prefetch, budget: Budget): void {
    pf.discarded = true;
    budget.left += pf.reserved;
    pf.reserved = 0;
  }

  /**
   * One tier page: from the RAM store in memory mode (`all` tier, chain's store
   * usable), else the Mongo keyset as today. A store page is `partial` when it
   * stopped at what the boot load has covered rather than at the end.
   */
  private async findTierPage(tick: ChainTick, tier: FeeTier, after: string, limit: number): Promise<TierPage> {
    const store = tier === 'all' ? this.activeStore(tick.chainId, tick.protocol) : undefined;
    if (store) {
      const { rows, end } = store.page(after, limit);
      const page: TierPage = rows.map(candidateFromStore);
      page.fromStore = true;
      if (!end && rows.length < limit) page.partial = true;
      return page;
    }
    // A store-sized limit whose store stopped being usable since: still one
    // primary read of at most MONGO_PAGE, and `asked` says a full one is not the end.
    const capped = Math.min(limit, MONGO_PAGE);
    const page: TierPage = await this.positions.findFeeRefreshCandidates(
      tick.chainId,
      tick.protocol,
      after,
      capped,
      tier === 'hot' ? { hotMinUsd: this.config.positionFeeHotMinUsd } : {},
    );
    if (capped < limit) page.asked = capped;
    return page;
  }

  /**
   * Whether to hold this page back for another tick. A page is re-read on at
   * most HOLD_BACK_MAX_TICKS consecutive ticks; after that the pass moves on
   * (with an alert) rather than wedging on a chain whose RPC will not answer.
   */
  private holdBack(tick: ChainTick, tier: FeeTier, cursor: string, unanswered: number): boolean {
    const hk = `${tick.key}:${tier}`;
    const prev = this.heldBack.get(hk);
    const count = prev && prev.cursor === cursor ? prev.count + 1 : 1;
    const at = cursor === '' ? "''" : cursor;
    if (count <= HOLD_BACK_MAX_TICKS) {
      this.heldBack.set(hk, { cursor, count });
      this.logger.warn(
        `Position fee ${tier} page ${tick.key} after=${at} held back: ${unanswered} positions unanswered by the RPC ` +
          `(tick ${count}/${HOLD_BACK_MAX_TICKS}); re-read next tick`,
      );
      return true;
    }
    this.heldBack.delete(hk);
    this.logger.warn(
      `[alert] fees.page_unanswered chain=${tick.chainId} tier=${tier} after=${at} unanswered=${unanswered} — ` +
        `held back ${HOLD_BACK_MAX_TICKS} ticks, advancing; those positions wait for the next pass`,
    );
    return false;
  }

  /** `[alert] fees.pass_overdue` once per pass start, when a pass has run past POSITION_FEE_PASS_ALERT_MS. */
  private alertOverdue(
    tick: ChainTick,
    cursors: Record<FeeTier, FeeTierCursor>,
    intervals: Record<FeeTier, number>,
    nowMs: number,
  ): void {
    const limitMs = this.passAlertMs();
    for (const tier of FEE_TIERS) {
      if (tier === 'hot' && !(intervals.hot > 0)) continue;
      const c = cursors[tier];
      if (!tierInProgress(c) || !(c.startedAt instanceof Date)) continue;
      const elapsed = nowMs - c.startedAt.getTime();
      if (elapsed <= limitMs) continue;
      const ak = `${tick.key}:${tier}`;
      if (this.overdueAlerted.get(ak) === c.startedAt.getTime()) continue;
      this.overdueAlerted.set(ak, c.startedAt.getTime());
      this.logger.warn(
        `[alert] fees.pass_overdue chain=${tick.chainId} tier=${tier} elapsedMin=${Math.round(elapsed / 60_000)} ` +
          `cursor=${c.cursor === '' ? "''" : c.cursor} — still running past ${Math.round(limitMs / 60_000)} min; ` +
          `rows beyond the cursor are older than the interval promises`,
      );
    }
  }

  /** One line per completed pass, from the persisted counts (right across restarts). */
  private logPass(tick: ChainTick, tier: FeeTier, c: FeeTierCursor): void {
    const t = c.tally ?? emptyFeePassTally();
    if (tier === 'all') this.lastPassActive.set(tick.key, t.scanned);
    const secs = Math.round(((c.finishedAt?.getTime() ?? Date.now()) - (c.startedAt?.getTime() ?? Date.now())) / 1000);
    const line =
      `Position fee ${tier} pass ${tick.key} finished in ${secs}s ` +
      `scanned=${t.scanned} measured=${t.measured} written=${t.written} served=${t.served} ` +
      `stale=${t.stale} unchanged=${t.unchanged} failed=${t.failed} unanswered=${t.unanswered} unreadable=${t.unreadable}`;
    if (t.failed > 0 || t.unanswered > 0) {
      this.logger.warn(line);
      this.logger.warn(
        `[alert] fees.pass_failures chain=${tick.chainId} tier=${tier} failed=${t.failed} unanswered=${t.unanswered} ` +
          `scanned=${t.scanned}`,
      );
    } else {
      this.logger.log(line);
    }
  }

  /**
   * One line per GATE_REPORT_MS when any fee write waited for the gate: how
   * long chunks waited in total (summed across chains, so it can exceed wall
   * time). A warning when it does — the gate, not the read budget, is then
   * what limits the passes.
   */
  private reportGate(now: number = Date.now()): void {
    const r = this.gateReport;
    if (r.at === 0) {
      r.at = now;
      r.waitedMs = this.writeGate.waitedMs;
      return;
    }
    const span = now - r.at;
    if (span < GATE_REPORT_MS) return;
    const waited = this.writeGate.waitedMs - r.waitedMs;
    r.at = now;
    r.waitedMs = this.writeGate.waitedMs;
    if (!(waited > 0)) return;
    const ramp = this.rampFactor(now);
    const line =
      `Position fee write gate: chunks waited ${Math.round(waited / 1000)}s in total over the last ` +
      `${Math.round(span / 60_000)} min (${Math.round((waited / span) * 100)}% of wall time, summed across chains) ` +
      `at all=${+(this.config.positionFeeMaxWritesPerSec * ramp).toFixed(2)}/s ` +
      `served=${+(this.config.positionFeeMaxServedWritesPerSec * ramp).toFixed(2)}/s`;
    if (waited >= span) {
      this.logger.warn(
        `${line} — saturated: writes, not POSITION_FEE_MAX_PER_TICK, are limiting the passes ` +
          `(raise POSITION_FEE_MAX_WRITES_PER_SEC / …SERVED… only if Mongo has the headroom)`,
      );
    } else {
      this.logger.log(line);
    }
  }

  /**
   * Drain up to POSITION_FEE_VIEW_PER_TICK viewed positions, within the tick's
   * budget; what the RPC never answered goes back in, and so does the whole
   * batch when its read or write fails.
   */
  private async drainViews(tick: ChainTick, budget: Budget): Promise<void> {
    const max = Math.min(this.viewQuota(), budget.left, budget.mongoLeft);
    if (max <= 0) return;
    const ids = await this.signals.takeViews(tick.key, max);
    if (ids.length === 0) return;
    budget.left -= ids.length;
    budget.mongoLeft -= ids.length;
    try {
      const page = await withTimeout(
        this.positions.findFeeRefreshCandidatesByIds(tick.chainId, tick.protocol, ids),
        MONGO_CALL_TIMEOUT_MS,
        'view read',
      );
      budget.left += ids.length - page.length;
      budget.mongoLeft += ids.length - page.length;
      tick.result.tiers.view += page.length;
      this.refreshStore(tick, page);
      const { unanswered } = await this.measureAndWrite(tick, page, 'view');
      await this.signals.requeueViews(tick.key, unanswered.map((p) => p.positionId));
    } catch (err) {
      // Not (fully) measured or written: keep every one rather than lose the
      // view (their cooldowns are already running, so a re-open could not
      // queue them again). Rows already written re-read as unchanged.
      await this.signals.requeueViews(tick.key, ids);
      throw err;
    }
  }

  /**
   * The side lanes — the live dirty set, then the backfill lane — drained
   * while the tick has budget (and, while a tier pass is due, side share and
   * no more wall time than the tier pages have had), up to
   * SIDE_READS_PER_TICK Mongo reads a tick, starting no drain more than
   * SIDE_DRAIN_WINDOW_MS into the tick. Rows skipped as already fresh cost no
   * budget, so they do not end the drain. A drain that left rows unanswered
   * ends it for the tick: the RPC is failing.
   */
  private async drainSide(tick: ChainTick, budget: Budget, deadline: number): Promise<void> {
    for (const lane of DIRTY_LANES) {
      for (;;) {
        const sizes = await this.signals.sizes(tick.key);
        if ((lane === 'live' ? sizes.live : sizes.backfill) === 0) break;
        if (budget.sideStalled || budget.sideReads >= SIDE_READS_PER_TICK) return;
        if (Date.now() >= Math.min(deadline, budget.sideUntil)) return;
        // The rows these lanes write are mostly served writes, which the write
        // gate paces hardest; a share of READS alone let one drain of
        // never-measured rows hold the tick for ~40 s per 1000 rows.
        if (budget.tierDue && budget.sideMs > budget.tierMs) return;
        const max = Math.min(DIRTY_PER_DRAIN, budget.left, budget.dirtyLeft, budget.mongoLeft);
        if (max <= 0) return;
        const t0 = Date.now();
        budget.sideReads++;
        try {
          const unanswered = await this.drainLane(tick, budget, lane, max);
          if (unanswered === undefined) break;
          if (unanswered > 0) budget.sideStalled = true;
        } finally {
          budget.sideMs += Date.now() - t0;
        }
      }
    }
  }

  /**
   * Drain up to `max` queued positions from one side lane (one Mongo read),
   * within the tick's budget and the side share of it. Rows whose stored
   * reading already post-dates their change are skipped with no RPC call and
   * refunded; what the RPC never answered goes back in, and so does the whole
   * batch when the read or the write fails. Returns how many went unanswered
   * (undefined: the lane was empty after all).
   */
  private async drainLane(tick: ChainTick, budget: Budget, lane: DirtyLane, max: number): Promise<number | undefined> {
    const taken = await this.signals.takeDirty(tick.key, lane, max);
    if (taken.size === 0) return undefined;
    budget.left -= taken.size;
    budget.dirtyLeft -= taken.size;
    budget.mongoLeft -= taken.size;
    const requeue = (ids: Iterable<string>) => {
      const back = new Map<string, number>();
      for (const id of ids) back.set(id, taken.get(id) ?? FORCE_REREAD);
      this.markDirty(tick.chainId, back.keys(), tick.protocol, back, { lane });
    };
    try {
      const page = await withTimeout(
        this.positions.findFeeRefreshCandidatesByIds(tick.chainId, tick.protocol, [...taken.keys()]),
        MONGO_CALL_TIMEOUT_MS,
        `${lane === 'live' ? 'dirty' : 'backfill'} read`,
      );
      this.refreshStore(tick, page);
      const work = page.filter((c) => !isFreshForChange(c, taken.get(c.positionId) ?? FORCE_REREAD));
      tick.result.skippedFresh += page.length - work.length;
      // Rows not found (closed, gone) or already fresh cost no RPC: give their budget back.
      const refund = taken.size - work.length;
      budget.left += refund;
      budget.dirtyLeft += refund;
      budget.mongoLeft += refund;
      tick.result.tiers[lane === 'live' ? 'dirty' : 'backfill'] += work.length;
      const { unanswered } = await this.measureAndWrite(tick, work, lane === 'live' ? 'dirty' : 'backfill');
      if (unanswered.length > 0) requeue(unanswered.map((p) => p.positionId));
      return unanswered.length;
    } catch (err) {
      // Not (fully) measured or written: keep every one for the next tick
      // rather than lose the change. Rows already written are skipped as fresh
      // (their block is known) or re-read as unchanged.
      requeue(taken.keys());
      throw err;
    }
  }

  /**
   * Memory mode: docs a drain just read from the PRIMARY replace their RAM rows
   * (newer-wins) — a drained signal therefore refreshes RAM even when its
   * writer hint was lost, and its own write then lands on the fresh row.
   */
  private refreshStore(tick: ChainTick, page: FeeRefreshCandidate[]): void {
    const store = this.activeStore(tick.chainId, tick.protocol);
    if (!store || page.length === 0) return;
    store.upsert(page.map(storeRowFromCandidate));
  }

  /** Measure one batch of rows and write it (views and side lanes). */
  private async measureAndWrite(tick: ChainTick, page: FeeRefreshCandidate[], source: WorkSource): Promise<MeasureOutcome> {
    const counts = emptyFeePassTally();
    try {
      const out = await this.measureRows(tick, page, source, counts);
      await this.persist(tick, out.rows, counts, source);
      return out;
    } finally {
      addCounts(tick.result, counts);
    }
  }

  /** Measure one page. Returns what was measured, what failed per call and what the RPC never answered. */
  private async measureRows(
    tick: ChainTick,
    page: FeeRefreshCandidate[],
    source: WorkSource,
    counts: FeePassTally,
  ): Promise<MeasureOutcome> {
    counts.scanned += page.length;
    const out = await this.measurer.measureRows(tick.chainId, page, 'fee');
    counts.unreadable += out.unreadable.length;
    counts.measured += out.rows.length;
    counts.failed += out.failed.length;
    counts.unanswered += out.unanswered.length;
    // A tier row that reverted even after the split retries gets ONE quick
    // retry through the dirty set (always re-read) on the next tick. Not from
    // a side lane or view drain, so a row that keeps reverting is bounded to
    // that one retry and then waits for the next pass.
    if ((source === 'hot' || source === 'all') && out.failed.length > 0) {
      for (const p of out.failed) tick.retryNextTick.push(p.positionId);
    }
    return out;
  }

  /**
   * Write one measured batch. Mongo-sourced rows exactly as before. RAM-store
   * rows (memory mode) touch Mongo only when something changed: an unchanged
   * re-read costs no read and no write; a stamp-only write needs no read; a
   * row that needs its served fields rewritten — or is marked `verify` — is
   * re-read from the PRIMARY by id first (the served path: decisions and the
   * revalue come from that fresh doc, written under its `updatedAt` version
   * guard). What landed is applied back to RAM; a chunk the guards partly
   * refused marks its rows `verify` instead (the next pass re-reads them).
   */
  private async persist(tick: ChainTick, measured: Measured[], counts: FeePassTally, source: WorkSource): Promise<void> {
    const at = new Date();
    const store = this.activeStore(tick.chainId, tick.protocol);
    const ready: Measured[] = [];
    const hydrate: Measured[] = [];
    for (const m of measured) {
      // The stored row already knows of a modify AFTER this batch's block, so
      // what was read predates a settle. Not written; the next read replaces it.
      if (m.candidate.lastModifyBlock > m.block) {
        counts.stale++;
        continue;
      }
      if (store && isStoreCandidate(m.candidate)) {
        if (m.candidate.verify || needsServedWrite(m.candidate.stored, Number(m.fees0), Number(m.fees1), m.candidate.rpc)) {
          hydrate.push(m);
          continue;
        }
      }
      ready.push(m);
    }
    if (hydrate.length > 0) {
      // The served path: ONE primary read for the rows that need it.
      const fresh = await withTimeout(
        this.positions.findFeeRefreshCandidatesByIds(
          tick.chainId,
          tick.protocol,
          hydrate.map((m) => m.candidate.positionId),
        ),
        MONGO_CALL_TIMEOUT_MS,
        'served read',
      );
      // A primary read no budgeted write accounts for (design §5.1: fee served hydration).
      chargePrimaryRead(fresh.length, { lane: 'fee' });
      this.hydrated.set(tick.key, (this.hydrated.get(tick.key) ?? 0) + hydrate.length);
      const byId = new Map(fresh.map((f) => [f.positionId, f]));
      for (const m of hydrate) {
        const f = byId.get(m.candidate.positionId);
        if (!f) {
          // Closed or gone since RAM last heard: nothing to write.
          store?.remove(m.candidate.positionId);
          counts.stale++;
          continue;
        }
        store?.upsert([storeRowFromCandidate(f)]);
        if (f.lastModifyBlock > m.block) {
          counts.stale++;
          continue;
        }
        ready.push({ ...m, candidate: f });
      }
    }

    const writes: RpcFeeWrite[] = [];
    for (const m of ready) {
      const fees0 = Number(m.fees0);
      const fees1 = Number(m.fees1);
      const servedMoved = needsServedWrite(m.candidate.stored, fees0, fees1, m.candidate.rpc);
      if (!servedMoved && isUnchangedMeasurement(m.candidate, m.fees0, m.fees1, at.getTime(), this.config.positionFeeRestampMs)) {
        counts.unchanged++;
        if (store && !isStoreCandidate(m.candidate)) store.clearVerify(m.candidate.positionId);
        continue;
      }
      const write: RpcFeeWrite = { positionId: m.candidate.positionId, fees0: m.fees0, fees1: m.fees1, block: m.block };
      if (servedMoved) {
        write.served = revalueServedFees(m.candidate.stored, { fees0, fees1, measuredAt: at });
        // Written only while the document is still the one `stored` came from.
        if (m.candidate.version) write.version = m.candidate.version;
      }
      writes.push(write);
    }
    // Chunks of at most FEE_WRITE_CHUNK, each paced by the process-wide write
    // gate (shared with every other chain) BEFORE it is sent — the repository's
    // stamp-only fallback too (`beforeFallback`). The Mongo timeout is the
    // driver's, per bulkWrite, so the wait for tokens never counts against it.
    const lane: FeeWriteLane = source === 'backfill' ? 'backfill' : 'main';
    for (let i = 0; i < writes.length; i += FEE_WRITE_CHUNK) {
      const part = writes.slice(i, i + FEE_WRITE_CHUNK);
      const servedCount = part.filter((w) => w.served).length;
      tick.result.writeWaitMs += await this.writeGate.acquire(part.length, servedCount, lane);
      // `signal`: the repository forwards it to the write budget, so a chunk
      // still waiting there when the tick ends is refused, never sent late.
      const writeOpts: RpcFeeWriteOptions = {
        timeoutMs: MONGO_CALL_TIMEOUT_MS,
        maxBudgetWaitMs: FEE_BUDGET_WAIT_MS,
        signal: tick.abort.signal,
        beforeFallback: async (n) => {
          tick.result.writeWaitMs += await this.writeGate.acquire(n, 0, lane);
        },
      };
      let landed: { matched: number; served?: number };
      try {
        landed = await withTimeout(
          this.positions.writeRpcFees(tick.chainId, tick.protocol, part, at, writeOpts),
          FEE_WRITE_BACKSTOP_MS,
          'fee write',
        );
      } catch (err) {
        if (isWriteBudgetTimeout(err)) {
          // Write DEFERRED, not failed: the plain or served half of the chunk may
          // have landed before the other was refused, so RAM vouches for none of
          // it (the next pass takes the served path for those rows); the tick
          // ends before its cursor save and the next one re-measures.
          if (store) for (const w of part) store.markVerify(w.positionId);
          this.logger.warn(
            `Position fee writes deferred ${tick.key} source=${source}: the shared write budget's fee lane would wait past ` +
              `${FEE_BUDGET_WAIT_MS / 1000}s (${(err as Error).message}); ${writes.length - i} writes not sent, re-measured next tick`,
          );
        }
        throw err;
      }
      const { matched, served } = landed;
      counts.written += matched;
      // Unmatched = refused by the lastModifyBlock guard (or the position is gone).
      counts.stale += part.length - matched;
      // A served row whose document changed under it got the stamp only.
      counts.served += served ?? servedCount;
      if (store) applyWritesToStore(store, part, at, matched, served ?? servedCount, servedCount);
    }
  }

  /** The fee lane's viem client for a chain (cached; specs inject fakes into `clients`). */
  private clientFor(chainId: number): PublicClient | undefined {
    const url = this.config.evmRpcUrls.get(chainId);
    if (!url) return this.clients.get(chainId);
    return this.client(chainId, url);
  }

  private client(chainId: number, url: string): PublicClient {
    let c = this.clients.get(chainId);
    if (!c) {
      // Every attempt (retries included) through the RPC budget's `fee` lane when one is bound.
      const fetchFn = checkedFetch(this.rpcFetch?.(url, 'fee', chainId), () => {
        if (this.badFetchWarned) return;
        this.badFetchWarned = true;
        this.logger.warn('[alert] fees.rpc_fetch_invalid — FEE_RPC_FETCH returned a non-function; using plain fetch');
      });
      c = createPublicClient({ transport: http(url, { timeout: 30_000, retryCount: 1, ...(fetchFn ? { fetchFn } : {}) }) }) as PublicClient;
      this.clients.set(chainId, c);
    }
    return c;
  }
}

/** The shared write budget refused a chunk within FEE_BUDGET_WAIT_MS (enforce). */
function isWriteBudgetTimeout(err: unknown): boolean {
  return err instanceof WriteBudgetTimeoutError || (err as Error | undefined)?.name === 'WriteBudgetTimeoutError';
}

/** A candidate built from the RAM store (decisions only; never written from). */
function isStoreCandidate(c: FeeRefreshCandidate): c is FeeRefreshCandidate & { fromStore: true; verify?: boolean } {
  return (c as { fromStore?: unknown }).fromStore === true;
}

/**
 * What one written chunk did to RAM: every row's stamp (and a served row's
 * figure) applied when the whole chunk landed as sent; otherwise the rows the
 * guards may have refused are marked `verify` — the next pass re-reads them
 * on the served path instead of trusting a stamp Mongo may not hold.
 */
export function applyWritesToStore(
  store: FeeCandidateStore,
  part: readonly RpcFeeWrite[],
  at: Date,
  matched: number,
  servedLanded: number,
  servedSent: number,
): void {
  const allMatched = matched >= part.length;
  const allServed = servedLanded >= servedSent;
  for (const w of part) {
    if (!allMatched || (w.served && !allServed)) {
      store.markVerify(w.positionId);
      continue;
    }
    const stamp = { fees0: w.fees0, fees1: w.fees1, block: w.block, at };
    if (w.served) {
      const pending = Number(w.served['metrics.pendingFeesUsd']);
      store.applyOwnWrite(w.positionId, stamp, { pendingFeesUsd: Number.isFinite(pending) ? pending : 0 });
    } else {
      store.applyOwnWrite(w.positionId, stamp);
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s (Mongo pool stalled?)`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
