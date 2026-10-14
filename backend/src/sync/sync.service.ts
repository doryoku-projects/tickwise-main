import { Inject, Injectable, Logger, Optional, forwardRef, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import type { IntegrationConfig } from '../config/integrations.config.js';
import { writeSkipSettings, type WriteSkipConfigSource } from '../database/position-write-hash.js';
import { PositionsRepository, type UpsertManyOptions } from '../database/positions.repository.js';
import { SyncRepository, type BackfillPauseState } from '../database/sync.repository.js';
import { PricingService } from '../pricing/pricing.service.js';
import { AdapterRegistryService } from '../subgraph/adapter-registry.service.js';
import type { NormalizedPosition } from '../subgraph/normalized-position.js';
import type { PositionAdapter, TokenIdWalkResult } from '../subgraph/position-adapter.js';
import { isTokenIdEdgeQueryError } from '../subgraph/position-adapter.js';
import { indexerFallbackServes } from '../subgraph/indexer-failover.js';
import type { SyncCursor } from '../database/schemas/sync-cursor.schema.js';
import { geckoTerminalBudgetStats } from '../pricing/providers/geckoterminal.provider.js';
import { TransactionSyncService } from './transaction-sync.service.js';
import { AggregateRecomputeService } from './aggregate-recompute.service.js';
import { PositionFeeRefreshService } from './position-fee-refresh.service.js';
import { isShuttingDown, shutdownSignal } from '../common/shutdown.js';
import { can } from '../common/process-role.js';
import { processWriteBudget } from '../common/write-budget.js';
import {
  BACKFILL_SLOW_CHECK_MS,
  BackfillProfile,
  readBackfillSettings,
  feeReadLabel,
  type BackfillSettings,
  type ProfileExternalCounters,
} from './backfill-profile.js';

// Tunable via env (POSITIONS_PAGE_SIZE etc.) with sane defaults bumped for backfill throughput.
// Subgraph caps `first` at 1000 — don't go higher unless your indexer relaxes the cap.
const POSITIONS_SUBGRAPH_PAGE_SIZE = numEnv('POSITIONS_PAGE_SIZE', 1000);
const POSITIONS_MAX_PAGES_PER_RUN = numEnv('POSITIONS_MAX_PAGES_PER_RUN', 0);
const POSITIONS_NORMALIZATION_CONCURRENCY = numEnv('POSITIONS_NORMALIZATION_CONCURRENCY', 40);
// 2 (was 32): chunks run in parallel within a page, so a high value only
// produced bursts of ~100 indexer requests and ~200 concurrent normalizations.
const POSITIONS_REFRESH_CONCURRENCY = numEnv('POSITIONS_REFRESH_CONCURRENCY', 2);
const POSITIONS_FLUSH_THRESHOLD = numEnv('POSITIONS_FLUSH_THRESHOLD', 10000);
// Refresh walks every position one page at a time (no batch cap). These bound
// how many position refs / closed candidates are held in memory per page; each
// page is fully processed (fetch + tx-sync dispatch) before the next is read.
const POSITIONS_REFRESH_PAGE_SIZE = numEnv('POSITIONS_REFRESH_PAGE_SIZE', 5000);
const CLOSED_CANDIDATE_PAGE_SIZE = numEnv('CLOSED_TX_CANDIDATE_PAGE_SIZE', 5000);
const POSITIONS_STALE_MAX_MISSES = 3;
const POSITIONS_PROGRESS_LOG_EVERY = numEnv('POSITIONS_PROGRESS_LOG_EVERY', 10000);
/**
 * A running backfill stamps `backfillHeartbeatAt` this often (besides every
 * flush), well inside `BACKFILL_HEARTBEAT_STALE_MS` (10 min): a flush slowed by
 * provider back-offs must not make a live backfill read as dead.
 */
export const BACKFILL_HEARTBEAT_INTERVAL_MS = 2 * 60_000;

function numEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (!raw) return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

export interface SyncResult {
  chainId: number;
  protocol: string;
  fetched: number;
  refreshed: number;
  upserted: number;
  transactionsUpserted: number;
  markedClosed: number;
  durationMs: number;
  /** Refresh only: `partial` when some refresh chunks failed (stale sweep skipped). */
  status?: 'success' | 'partial';
  /** Refresh only: how many refresh chunks failed and were left for the next tick. */
  failedChunks?: number;
  /**
   * The flow's fleet-wide lock (`SYNC_FLOW_LOCKS`, leases on) is held by
   * ANOTHER process: nothing ran. For a backfill the `positions-sync`
   * processor re-delays the job instead of completing it (design §2.1), so a
   * resume enqueued by a booting process runs once the old walker exits.
   */
  heldElsewhere?: boolean;
  /**
   * Backfill only: the chain's backfill is PAUSED (`sync_cursors.backfillPausedAt`,
   * `POST /admin/sync/backfill/pause`). Either nothing ran (the pause was set
   * before the run started) or the walk stopped at a flush / page / range
   * boundary like an interrupted run: flag and cursor kept, run `interrupted`.
   */
  paused?: boolean;
}

/**
 * The backfill pause lever (`SyncRepository`; audit C-pause). Optional: a
 * repository without it (spec fakes) never pauses — today's behaviour.
 */
export interface SyncBackfillPauseOps {
  /** The pause on the chain, or null. Read once when a backfill starts. */
  backfillPauseState(chainId: number, protocol: string): Promise<BackfillPauseState | null>;
  /** The heartbeat `$set` that also returns the pause (flushes + the 2-min timer). */
  heartbeatBackfillReadPause(chainId: number, protocol: string): Promise<BackfillPauseState | null>;
}

export function hasBackfillPauseOps(repo: unknown): repo is SyncBackfillPauseOps {
  const r = repo as Partial<SyncBackfillPauseOps> | null | undefined;
  return typeof r?.backfillPauseState === 'function' && typeof r?.heartbeatBackfillReadPause === 'function';
}

/** The walk's stop signal: the shutdown signal OR the run's pause (whichever fires first). */
function eitherSignal(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) return a;
  if (b.aborted) return b;
  return AbortSignal.any([a, b]);
}

/**
 * Fleet-wide per-flow exclusivity (design §2.1), bound by the integrator to
 * `common/flow-lock.ts`. `run` executes `fn` under the lock `name` (heartbeat
 * while it runs, released in `finally`) and answers `{held: true}` WITHOUT
 * running it when another process holds the lock. With leases off the binding
 * is a pass-through, and with no binding at all only this process's in-memory
 * guard applies — today.
 */
export interface SyncFlowLocks {
  run<T>(name: string, fn: () => Promise<T>): Promise<{ held: true } | { held: false; value: T }>;
}
export const SYNC_FLOW_LOCKS = 'SYNC_FLOW_LOCKS';

/** The lock name of one flow on one integration: `flow:<flow>:<chainId>:<protocol>`. */
export function flowLockName(flow: 'backfill' | 'refresh', chainId: number, protocol: string): string {
  return `flow:${flow}:${chainId}:${protocol}`;
}

/*
 * `sync_cursors` state of a tokenId range walk (design §6.2-1; fields and
 * methods owned by `SyncRepository`). During the walk only these move:
 * `lastTimestamp/lastPositionId` keep their run-start values, so rolling back
 * to `BACKFILL_PAGING=offset` resumes safely from where the run began.
 */
export interface TokenIdCursorFields {
  /** `'tokenid'` while a tokenId run is in progress. */
  backfillPaging?: string;
  /** Exclusive end of the highest CONTIGUOUS written range = where a resume starts. */
  backfillTokenIdCursor?: string;
  /** The run's start (unix seconds): the completeness tail walks createdAt ≥ this − 1 h. */
  backfillRunStartTs?: number;
}

export interface SyncTokenIdCursorOps {
  /** Start (or restart) a tokenId run: paging `tokenid`, the cursor, the run start. */
  saveBackfillTokenIdState(chainId: number, protocol: string, state: { tokenIdCursor: string; runStartTs: number }): Promise<void>;
  /** Advance the contiguous cursor (after each written range). */
  saveBackfillTokenIdCursor(chainId: number, protocol: string, tokenIdCursor: string): Promise<void>;
  /** `$unset` all three fields (the run finished; the createdAt cursor is authoritative again). */
  clearBackfillTokenIdState(chainId: number, protocol: string): Promise<void>;
}

/** `lastCleanRefreshAt` recording (design §4.6; `SyncRepository`). */
export interface SyncCleanRefreshOps {
  setLastCleanRefreshAt(chainId: number, protocol: string, at: Date): Promise<void>;
}

/**
 * The last SUCCESSFUL refresh per shard (`sync_cursors.lastRefreshOkAt`;
 * `SyncRepository`), the input of `[alert] positions.refresh_overdue`
 * (design §5.4). A success is any refresh with no failed chunk — the stale
 * sweep deferred for a running backfill still counts, unlike
 * `lastCleanRefreshAt`, or every long backfill would read as an overdue refresh.
 */
export interface SyncRefreshOkOps {
  setLastRefreshOkAt(chainId: number, protocol: string, at: Date): Promise<void>;
  /** `chainId:protocol` → the last successful refresh's END. */
  lastRefreshOkTimes(): Promise<Map<string, Date>>;
}

/** The overdue check runs this often (design §13: each alert at most once a minute per key). */
export const REFRESH_OVERDUE_CHECK_MS = 60_000;
/** A refresh is overdue once its last success is older than this many refresh intervals. */
export const REFRESH_OVERDUE_INTERVALS = 2;

/**
 * Whether the refresh-overdue watch (and the `lastRefreshOkAt` stamp it
 * reads) is on: only with the write budget on (`WRITE_BUDGET_MODE` observe /
 * enforce) — the budget is what can slow a refresh to its floor (design
 * §5.4), and with it off nothing here reads, writes or alerts (today).
 */
export function refreshOverdueWatchOn(config: unknown): boolean {
  const mode = (config as { writeBudget?: { mode?: unknown } } | null | undefined)?.writeBudget?.mode;
  return mode === 'observe' || mode === 'enforce';
}

/**
 * How overdue a shard's refresh is (ms), or undefined when it is not. Age is
 * measured from the later of the last success and the moment this process
 * began watching, so a fresh boot (or a shard that never refreshed) gets a
 * full grace of `REFRESH_OVERDUE_INTERVALS × interval` before it can alert.
 */
export function refreshOverdueAgeMs(input: {
  nowMs: number;
  intervalMs: number;
  lastOkMs: number | undefined;
  watchStartedMs: number;
}): number | undefined {
  if (!(Number.isFinite(input.intervalMs) && input.intervalMs > 0)) return undefined;
  const last = input.lastOkMs !== undefined && Number.isFinite(input.lastOkMs) ? input.lastOkMs : Number.NEGATIVE_INFINITY;
  const ageMs = input.nowMs - Math.max(last, input.watchStartedMs);
  return ageMs > REFRESH_OVERDUE_INTERVALS * input.intervalMs ? ageMs : undefined;
}

/** The completeness tail starts this long before the run started (indexer lag, clock skew). */
export const TOKENID_TAIL_LOOKBACK_SEC = 3600;

export type TokenIdPlan =
  | { kind: 'fresh'; from: string; runStartTs: number }
  | { kind: 'resume'; from: string; runStartTs: number }
  | { kind: 'convert'; sinceTs: number; runStartTs: number };

/**
 * Which backfills take the tokenId walk (`BACKFILL_PAGING=tokenid`):
 *  - a FRESH `fromStart` (this attempt reset the cursor) → the whole chain from 0;
 *  - the RESUME of a tokenId run still in progress → from its contiguous cursor,
 *    keeping its run start (the tail must reach back to the ORIGINAL start);
 *  - an interrupted OFFSET run (flag set before this attempt, `lastTimestamp` > 0)
 *    → CONVERTED: from the lowest tokenId created at/after its cursor (rows below
 *    it with a later createdAt cannot exist — it is the minimum);
 *  - an interrupted run that never flushed (`lastTimestamp` 0) → fresh.
 * Everything else — an incremental run, a test-mode run, an adapter or
 * repository without the support — keeps today's createdAt + offset walk.
 * A tokenId state without its run start is treated as damaged → fresh: a
 * complete re-walk, never a tail that might start too late.
 */
export function planTokenIdBackfill(input: {
  supported: boolean;
  latestOnly: boolean;
  freshFromStart: boolean;
  prior: (Partial<Pick<SyncCursor, 'backfillInProgress' | 'lastTimestamp'>> & TokenIdCursorFields) | null;
  nowSec: number;
}): TokenIdPlan | null {
  if (!input.supported || input.latestOnly) return null;
  if (input.freshFromStart) return { kind: 'fresh', from: '0', runStartTs: input.nowSec };
  const prior = input.prior;
  if (!prior || prior.backfillInProgress !== true) return null;
  if (prior.backfillPaging === 'tokenid') {
    const cursor = String(prior.backfillTokenIdCursor ?? '');
    const runStartTs = Number(prior.backfillRunStartTs);
    if (/^\d+$/.test(cursor) && Number.isFinite(runStartTs) && runStartTs > 0) {
      return { kind: 'resume', from: cursor, runStartTs };
    }
    return { kind: 'fresh', from: '0', runStartTs: input.nowSec };
  }
  const last = Number(prior.lastTimestamp ?? 0);
  if (Number.isFinite(last) && last > 0) return { kind: 'convert', sinceTs: last, runStartTs: input.nowSec };
  return { kind: 'fresh', from: '0', runStartTs: input.nowSec };
}

/** max over `(createdAtTimestamp, positionId)` — the order the createdAt cursor uses. */
function laterCursor(
  a: { ts: number; id: string; block: number },
  b: { ts: number; id: string; block: number },
): { ts: number; id: string; block: number } {
  const later = b.ts > a.ts || (b.ts === a.ts && b.id > a.id) ? b : a;
  return { ts: later.ts, id: later.id, block: Math.max(a.block, b.block) };
}

export interface BackfillOptions {
  /**
   * If true, reset the cursor to zero before walking. Causes the backfill to
   * rescan the whole subgraph from the earliest position. Useful when
   * positions may have been missed (subgraph back-dating, prior run gaps,
   * etc.). Already-stored positions get upserted as no-ops.
   */
  fromStart?: boolean;
  /**
   * Identity of the run across retries: the BullMQ job id, which a retry and a
   * stalled re-run keep. A `fromStart` reset happens once per key (see
   * `SyncRepository.resetCursorForRun`), so attempt 2 resumes from the cursor
   * attempt 1 advanced. Absent (a direct call) → a fresh key, i.e. a reset.
   */
  runKey?: string;
  /**
   * When the run was REQUESTED (the BullMQ job's creation time, ms). A
   * `fromStart` request is already served when a backfill run started at or
   * after it: then the cursor is NOT reset. This covers a job created by code
   * older than the run-key claim — it survives a deploy with
   * QUEUE_CLEAR_ON_BOOT off, carries no recorded key, and would otherwise
   * restart from 0 a walk it was 400k positions into (seen on the M10 rig).
   */
  runCreatedAt?: number;
}

/**
 * Position sync orchestration.
 *
 * Two distinct flows:
 *
 * - **Backfill (`runBackfill`)** — admin-only, manual. Walks the subgraph
 *   `positions` query in ascending `createdAtTimestamp` order, resuming from
 *   the persisted cursor (or zero if `fromStart=true`, once per run). Upserts
 *   every page. While running, sets `SyncCursor.backfillInProgress=true` and
 *   keeps `backfillHeartbeatAt` fresh, so the refresh's stale sweep stands
 *   down; a flag whose heartbeat went quiet is a dead backfill, which the
 *   worker's boot resumes from its cursor (`interruptedBackfills`). Cleared
 *   when the subgraph reports `hasMore=false`.
 *
 * - **Refresh (`runRefresh`)** — cron-driven. Re-fetches already-tracked
 *   active positions in chunks to update pricing / metrics. Then runs a stale
 *   sweep marking positions not seen for `POSITIONS_STALE_MAX_MISSES` cycles
 *   as inactive. Does NOT discover new positions — those come from backfill.
 *
 * Per-flow re-entry guards: `activeBackfills` blocks two simultaneous
 * backfills on the same `(chainId, protocol)`, `activeRefreshes` does the
 * same for refreshes. Backfill + refresh on the same integration are allowed
 * to overlap — Mongo upserts are idempotent, no cursor field overlap. The
 * stale sweep inside refresh is gated separately so it doesn't run while a
 * backfill is in flight (would mis-flag newly discovered positions).
 */
@Injectable()
export class SyncService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SyncService.name);
  private readonly activeBackfills = new Set<string>();
  /**
   * The running backfill's PAUSE switch per `chainId:protocol` (one run per key
   * per process — `activeBackfills`). `beatBackfill` aborts it when the
   * heartbeat reads `backfillPausedAt`; the walk stops at its next boundary.
   */
  private readonly backfillPauses = new Map<string, { ctl: AbortController; by?: string }>();
  private readonly activeRefreshes = new Set<string>();
  /** `[alert] positions.refresh_overdue` (design §5.4): the once-a-minute check, when watched. */
  private overdueTimer?: ReturnType<typeof setInterval>;
  private overdueWatchStartedAt?: number;
  private readonly overdueAlertedAt = new Map<string, number>();

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(AdapterRegistryService) private readonly adapters: AdapterRegistryService,
    @Inject(PositionsRepository) private readonly positions: PositionsRepository,
    @Inject(SyncRepository) private readonly syncRepo: SyncRepository,
    @Inject(PricingService) private readonly pricing: PricingService,
    @Inject(forwardRef(() => TransactionSyncService))
    private readonly transactionSync: TransactionSyncService,
    @Inject(AggregateRecomputeService)
    private readonly aggregateRecompute: AggregateRecomputeService,
    // APPENDED and optional: specs construct this service positionally.
    @Optional() @Inject(PositionFeeRefreshService) private readonly feeRefresh?: PositionFeeRefreshService,
    // APPENDED and optional: fleet-wide flow locks (absent = this process's guard only, today).
    @Optional() @Inject(SYNC_FLOW_LOCKS) private readonly flowLocks?: SyncFlowLocks,
  ) {}

  /**
   * The refresh-overdue watch (design §5.4, `[alert] positions.refresh_overdue`):
   * a once-a-minute check in the roles that schedule refreshes
   * (`can('scheduler')`: all, sync), only with the write budget on and the
   * refresh cron enabled. Off (the default): no timer, no read, no alert.
   * In a fleet with two scheduling processes (a mixed `all` + `sync` rollout
   * step) both check and both may log the same alert — the input is shared
   * (`sync_cursors`), so they agree.
   */
  onModuleInit(): void {
    if (!this.refreshOverdueWatched()) return;
    this.overdueWatchStartedAt = Date.now();
    this.overdueTimer = setInterval(() => void this.checkRefreshOverdue().catch(() => undefined), REFRESH_OVERDUE_CHECK_MS);
    this.overdueTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.overdueTimer) clearInterval(this.overdueTimer);
    this.overdueTimer = undefined;
  }

  private refreshOverdueWatched(): boolean {
    return refreshOverdueWatchOn(this.config) && this.config.positionsSyncCronEnabled === true && can('scheduler');
  }

  /**
   * One overdue check over every enabled integration (public for specs).
   * Returns the overdue shards. Never throws: a failed read gives no verdict
   * (the next minute asks again) rather than a false alarm.
   */
  async checkRefreshOverdue(nowMs: number = Date.now()): Promise<Array<{ chainId: number; protocol: string; ageMs: number }>> {
    const repo = this.syncRepo as unknown as Partial<SyncRefreshOkOps>;
    if (typeof repo.lastRefreshOkTimes !== 'function') return [];
    const intervalMs = Number(this.config.positionsSyncIntervalMs);
    const watchStartedMs = (this.overdueWatchStartedAt ??= nowMs);
    let times: Map<string, Date>;
    try {
      times = await repo.lastRefreshOkTimes();
    } catch (err) {
      this.logger.warn(`refresh overdue check: read failed — ${(err as Error)?.message ?? String(err)}`);
      return [];
    }
    const overdue: Array<{ chainId: number; protocol: string; ageMs: number }> = [];
    for (const integration of this.config.enabledIntegrations) {
      const key = `${integration.chainId}:${integration.protocol}`;
      const last = times.get(key);
      const lastOkMs = last instanceof Date ? last.getTime() : undefined;
      const ageMs = refreshOverdueAgeMs({ nowMs, intervalMs, lastOkMs, watchStartedMs });
      if (ageMs === undefined) continue;
      overdue.push({ chainId: integration.chainId, protocol: integration.protocol, ageMs });
      if (nowMs - (this.overdueAlertedAt.get(key) ?? Number.NEGATIVE_INFINITY) < REFRESH_OVERDUE_CHECK_MS) continue;
      this.overdueAlertedAt.set(key, nowMs);
      this.logger.warn(
        `[alert] positions.refresh_overdue chain=${integration.chainId} protocol=${integration.protocol} ageMs=${ageMs} ` +
          `lastOkAt=${lastOkMs !== undefined ? new Date(lastOkMs).toISOString() : 'never'} limitMs=${REFRESH_OVERDUE_INTERVALS * intervalMs} ` +
          `runningHere=${this.activeRefreshes.has(key)} — no successful refresh within ${REFRESH_OVERDUE_INTERVALS} × ` +
          `POSITIONS_SYNC_INTERVAL_MS (at the write budget's floor a refresh slows; runbook: pause the backfill first)`,
      );
    }
    return overdue;
  }

  /**
   * Queue the ACTIVE rows of a backfill flush for an on-chain fee read. Without
   * this a backfilled position waited for the next full pass to reach its
   * tokenId — or forever, behind a pass that kept restarting — and served
   * "Pending" meanwhile (24,882 Robinhood actives had never been measured).
   * They go to the fee job's BACKFILL lane, not the live dirty set: a large
   * walk would otherwise fill the live set's cap and crowd out (or drop) the
   * compounds the live listener queues. Each row carries its `lastModifyBlock`,
   * so a re-run over rows whose stored reading is still valid costs a Mongo
   * read and no RPC call. Called only after the flush's upsert resolved, so a
   * failed upsert queues nothing. `markDirty` ignores chains without an RPC
   * url. Best-effort: a failure here must never fail the backfill.
   */
  private markBackfilledForFees(integration: IntegrationConfig, positions: NormalizedPosition[]): void {
    if (!this.feeRefresh) return;
    try {
      const blocks = new Map<string, number>();
      for (const p of positions) {
        if (p.isActive !== true) continue;
        // Measured inside the walk (P3.1): the upsert carries its reading. A
        // row the write guard refuses the stamp for is re-queued by the writer.
        if (p.rpcFeesBlock !== undefined) continue;
        const block = Number(p.lastModifyBlock);
        blocks.set(String(p.positionId), Number.isFinite(block) && block > 0 ? block : 0);
      }
      if (blocks.size === 0) return;
      this.feeRefresh.markDirty(integration.chainId, [...blocks.keys()], integration.protocol, blocks, { lane: 'backfill' });
    } catch (err) {
      this.logger.warn(
        `Backfill fee mark failed: ${integration.chainId}:${integration.protocol} ${(err as Error)?.message ?? String(err)}`,
      );
    }
  }

  /**
   * The upsert options for one flush of `integration`: aggregates-mode adapters
   * (v4) compute their performance metrics inside the upsert, valuing gas at a
   * native price read ONCE per flush (`AggregateRecomputeService` used to read
   * it per recompute call, then re-read and rewrite every row).
   */
  private async upsertOptions(integration: IntegrationConfig): Promise<UpsertManyOptions> {
    if (this.adapters.resolve(integration.protocol).recomputeMode !== 'aggregates') return {};
    let ethPriceNow = 0;
    try {
      ethPriceNow = await this.pricing.currentNativeUsd(integration.chainId);
    } catch {
      // 0 → gas falls back to its tx-time USD, as the separate recompute did.
    }
    return { aggregates: { ethPriceNow: Number.isFinite(ethPriceNow) ? ethPriceNow : 0 } };
  }

  /**
   * Fire-and-await position-driven tx sync for a freshly upserted batch.
   * Wraps the helper so backfill/refresh callers don't crash if tx sync hits
   * a transient error — position sync continues regardless.
   */
  private async dispatchPositionDrivenTxSync(
    integration: IntegrationConfig,
    positionIds: string[],
    options: { fromZero: boolean; origin: string },
  ): Promise<void> {
    if (positionIds.length === 0) return;
    try {
      // Aggregates-mode (v4): nothing to do. The vs-HODL metrics come from the
      // position-row aggregates and were computed INSIDE the upsert that just
      // ran (`upsertOptions`) — this used to call
      // `AggregateRecomputeService.recompute`, a second read + write of every
      // row. Transaction-sync is bypassed for this protocol either way.
      if (this.adapters.resolve(integration.protocol).recomputeMode === 'aggregates') return;
      await this.transactionSync.syncTokenIdsFromPositionSync(integration, {
        positionIds,
        fromZero: options.fromZero,
        origin: options.origin,
      });
    } catch (err) {
      this.logger.warn(
        `Position-driven tx-sync dispatch failed: ${integration.chainId}:${integration.protocol} origin=${options.origin} positions=${positionIds.length} ${(err as Error).message}`,
      );
    }
  }

  /**
   * ADMIN HEALER: full vs-HODL metrics sweep over EVERY position (active +
   * closed) from row aggregates, through `AggregateRecomputeService` (one read
   * + one `updatePerformanceMetrics` write per row). Closed rows are the point:
   * no sync rewrites them, so a closed position keeps whatever metrics it was
   * last written with (pre-fix astronomical PnL survives forever otherwise).
   *
   * It used to run automatically after every bucketed full backfill, whose
   * flushes only upserted. Since 2026-10-03 every flush computes the metrics
   * inside its upsert (`upsertOptions`), so the automatic pass would have been
   * a second write of every row the backfill had just written; it now runs only
   * when an operator asks (`POST /admin/sync/recompute-aggregates`, job
   * `recompute-aggregates`). Pages by positionId cursor; per-batch failures are
   * logged and skipped.
   */
  async recomputeAllAggregates(integration: IntegrationConfig): Promise<{ updated: number; durationMs: number }> {
    const PAGE = 500;
    let after = '';
    let total = 0;
    const startedAt = Date.now();
    for (;;) {
      const refs = await this.positions.findActiveRefsWithTokensPage(
        integration.chainId,
        integration.protocol,
        PAGE,
        after,
        // Closed rows too: they are what no sync rewrites, so stale closed
        // metrics (pre-fix astronomical PnL) are only ever healed here.
        { includeClosed: true },
      );
      if (refs.length === 0) break;
      after = refs[refs.length - 1]!.positionId;
      try {
        total += await this.aggregateRecompute.recompute(
          integration.chainId,
          integration.protocol,
          refs.map((r) => r.positionId),
        );
      } catch (err) {
        this.logger.warn(
          `Aggregate recompute batch failed (after=${after}): ${(err as Error).message}`,
        );
      }
      if (refs.length < PAGE) break;
    }
    const durationMs = Date.now() - startedAt;
    this.logger.log(
      `Aggregate recompute (admin healer): ${integration.chainId}:${integration.protocol} updated=${total} durationMs=${durationMs}`,
    );
    return { updated: total, durationMs };
  }

  /** `recomputeAllAggregates` for one enabled integration (the `recompute-aggregates` job). */
  async recomputeAggregatesTarget(chainId: number, protocol: string): Promise<{ updated: number; durationMs: number }> {
    const integration = this.config.getIntegration(chainId, protocol);
    if (!integration) {
      throw new Error(`No enabled integration for chainId=${chainId}, protocol=${protocol}`);
    }
    if (this.adapters.resolve(integration.protocol).recomputeMode !== 'aggregates') {
      throw new Error(`${chainId}:${protocol} does not recompute from row aggregates`);
    }
    return this.recomputeAllAggregates(integration);
  }

  /**
   * Enabled integrations whose `backfillInProgress` flag is set while no
   * backfill runs in this process: backfills a deploy or a crash killed. Read
   * by the worker's boot (`QueueService`), which enqueues a cursor-based resume
   * for each, so a deploy loses at most one flush. The raw flag on purpose, not
   * the heartbeat: right after a kill the heartbeat can still be fresh.
   */
  async interruptedBackfills(): Promise<IntegrationConfig[]> {
    const out: IntegrationConfig[] = [];
    for (const integration of this.config.enabledIntegrations) {
      if (this.activeBackfills.has(`${integration.chainId}:${integration.protocol}`)) continue;
      const cursor = await this.syncRepo.getCursor(integration.chainId, integration.protocol);
      if (cursor?.backfillInProgress !== true) continue;
      // PAUSED (audit C-pause): an operator stopped this walk on purpose — no
      // boot or lease acquisition may restart it. `/resume` re-enqueues it.
      const paused = (cursor as SyncCursor & { backfillPausedAt?: unknown }).backfillPausedAt;
      if (paused instanceof Date) {
        this.logger.log(
          `Backfill resume skipped: ${integration.chainId}:${integration.protocol} is PAUSED since ${paused.toISOString()} ` +
            `— POST /admin/sync/backfill/resume to continue from its cursor`,
        );
        continue;
      }
      out.push(integration);
    }
    return out;
  }

  /**
   * Keeps `backfillHeartbeatAt` fresh every `BACKFILL_HEARTBEAT_INTERVAL_MS`
   * while a backfill runs (flushes stamp it too); returns the stop function.
   * Best-effort: a failed stamp is logged, never thrown — at worst the flag
   * reads as stale and the stale sweep runs once during the backfill, which
   * costs a row one `staleMisses` that its next upsert resets.
   */
  private startBackfillHeartbeat(integration: IntegrationConfig): () => void {
    const timer = setInterval(() => void this.beatBackfill(integration), BACKFILL_HEARTBEAT_INTERVAL_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /**
   * A run that fails while the process is stopping failed BECAUSE it is
   * stopping (a closed client, an abandoned job): a warn, not an error line —
   * `SyncRepository` records the run `interrupted` and the cursor keeps no error.
   */
  private logRunFailure(line: string): void {
    if (isShuttingDown()) this.logger.warn(`${line} (during shutdown — recorded as interrupted)`);
    else this.logger.error(line);
  }

  private async beatBackfill(integration: IntegrationConfig): Promise<void> {
    try {
      const key = `${integration.chainId}:${integration.protocol}`;
      const pause = this.backfillPauses.get(key);
      if (pause && hasBackfillPauseOps(this.syncRepo)) {
        // The same heartbeat write, returning the row: a pause set since the
        // last beat stops the walk at its next boundary (no extra read).
        const state = await this.syncRepo.heartbeatBackfillReadPause(integration.chainId, integration.protocol);
        if (state && !pause.ctl.signal.aborted) {
          pause.by = state.pausedBy;
          pause.ctl.abort();
          this.logger.warn(
            `Backfill PAUSE seen: ${key} (paused ${state.pausedAt.toISOString()} by ${state.pausedBy}) — ` +
              `stopping at the next flush / page / range; flag and cursor kept`,
          );
        }
        return;
      }
      await this.syncRepo.touchBackfillHeartbeat(integration.chainId, integration.protocol);
    } catch (err) {
      this.logger.warn(
        `Backfill heartbeat failed: ${integration.chainId}:${integration.protocol} ${(err as Error)?.message ?? String(err)}`,
      );
    }
  }

  /**
   * Admin-triggered backfill for a single integration. Resumes from the
   * persisted cursor unless `options.fromStart=true` — and even then only the
   * FIRST attempt of a run resets it (`options.runKey`), so a retry or a stall
   * resumes where the last flush left off. Sets the backfill-in-progress flag
   * and keeps its heartbeat fresh while running.
   */
  async runBackfill(integration: IntegrationConfig, options: BackfillOptions = {}): Promise<SyncResult> {
    const integrationKey = `${integration.chainId}:${integration.protocol}`;
    // PAUSED (audit C-pause): nothing runs — no run row, no flag write, and
    // above all no `fromStart` cursor reset — until `/resume` lifts it. Every
    // path that starts a backfill (admin, boot / lease resume, a job left
    // waiting) ends here, so this is the one gate they all share.
    if (hasBackfillPauseOps(this.syncRepo)) {
      const pause = await this.syncRepo.backfillPauseState(integration.chainId, integration.protocol);
      if (pause) {
        this.logger.warn(
          `Backfill NOT started: ${integrationKey} is PAUSED since ${pause.pausedAt.toISOString()} (${pause.pausedBy})` +
            `${options.fromStart ? ' — the fromStart reset was NOT applied' : ''}; POST /admin/sync/backfill/resume first`,
        );
        return { ...emptyResult(integration), paused: true };
      }
    }
    if (this.activeBackfills.has(integrationKey)) {
      this.logger.warn(`Skipping backfill because one is already running: ${integrationKey}`);
      return emptyResult(integration);
    }

    // Claimed BEFORE the fleet lock is asked for, so a second call in this
    // process still answers "already running" (completed), never `heldElsewhere`
    // (which re-delays the job).
    this.activeBackfills.add(integrationKey);
    try {
      if (!this.flowLocks) return await this.runBackfillUnlocked(integration, options);
      const out = await this.flowLocks.run(flowLockName('backfill', integration.chainId, integration.protocol), () =>
        this.runBackfillUnlocked(integration, options),
      );
      if (out.held) {
        this.logger.log(`Backfill held elsewhere: ${integrationKey} — another process is walking it`);
        return { ...emptyResult(integration), heldElsewhere: true };
      }
      return out.value;
    } finally {
      this.activeBackfills.delete(integrationKey);
    }
  }

  /** The backfill itself (the caller holds this process's guard and the fleet lock). */
  private async runBackfillUnlocked(integration: IntegrationConfig, options: BackfillOptions): Promise<SyncResult> {
    const integrationKey = `${integration.chainId}:${integration.protocol}`;
    const startedAt = Date.now();
    const runKey = options.runKey ?? `${integrationKey}:${startedAt}`;
    // Inside the try: a throw here used to leave the key in `activeBackfills`
    // for the life of the process, skipping every later backfill of the chain.
    let runId: string | undefined;
    // The run's pause switch (audit C-pause), registered BEFORE the heartbeat
    // timer so every beat — timer or flush — can trip it.
    const pause = { ctl: new AbortController(), by: undefined as string | undefined };
    this.backfillPauses.set(integrationKey, pause);
    const stopHeartbeat = this.startBackfillHeartbeat(integration);

    try {
      runId = await this.syncRepo.startRun(integration.chainId, integration.protocol);
      const settings = readBackfillSettings(this.config);
      // tokenId mode only: the cursor as this attempt FOUND it — whether a run
      // was already in progress (resume / conversion) is lost once
      // `markBackfillStarted` sets the flag.
      const priorCursor =
        settings.paging === 'tokenid' ? await this.syncRepo.getCursor(integration.chainId, integration.protocol) : null;
      // Read before `markBackfillStarted` overwrites it (see `runCreatedAt`).
      const priorStart =
        options.fromStart && options.runCreatedAt !== undefined
          ? await this.syncRepo.lastBackfillStartedAt(integration.chainId, integration.protocol)
          : undefined;
      await this.syncRepo.markBackfillStarted(integration.chainId, integration.protocol);
      // True only for the attempt that actually reset the cursor: a retried or
      // re-run fromStart job resumes from the cursor its flushes advanced.
      let freshFromStart = false;
      if (options.fromStart) {
        const servedByRun =
          priorStart !== undefined && options.runCreatedAt !== undefined && priorStart.getTime() >= options.runCreatedAt;
        if (servedByRun) {
          this.logger.log(
            `Cursor NOT reset for ${integrationKey}: a backfill already started at ${priorStart.toISOString()}, ` +
              `after this request (${new Date(options.runCreatedAt!).toISOString()}) — resuming from the cursor`,
          );
        } else {
          freshFromStart = await this.syncRepo.resetCursorForRun(integration.chainId, integration.protocol, runKey);
          this.logger.log(
            freshFromStart
              ? `Cursor reset for ${integrationKey} (fromStart=true, run=${runKey})`
              : `Cursor NOT reset for ${integrationKey}: run ${runKey} already reset it — resuming from the cursor`,
          );
        }
      }

      const cursor = await this.syncRepo.getCursor(integration.chainId, integration.protocol);
      const latestOnlyLimit = this.config.testMode
        ? Math.max(0, this.config.testModePositionLimit)
        : 0;
      const latestOnlyMode = latestOnlyLimit > 0;
      this.logger.log(
        `Backfill started: ${integrationKey} at ${new Date(startedAt).toISOString()} fromStart=${Boolean(options.fromStart)}`,
      );

      const adapter = this.adapters.resolve(integration.protocol);
      // P2.1: the first fee reading belongs to the roles that run backfills
      // AND may spend RPC on it (all, sync). Only `can('queue-workers')` roles
      // run this method today, so this is belt-and-braces for the matrix.
      if (settings.feeRead && !can('backfill-fee-read')) settings.feeRead = false;
      if (settings.feeRead && adapter.pageFeeReaderBound?.() === false) {
        // P3.1 asked for with no reader to do it: say so, and run without it —
        // every active row then reaches the fee job's backfill lane (today).
        settings.feeRead = false;
        settings.feeReadUnbound = true;
        this.warnFeeReadUnboundOnce(integrationKey);
      }
      const tokenIdPlan =
        settings.paging === 'tokenid'
          ? planTokenIdBackfill({
              supported: this.tokenIdSupported(adapter),
              latestOnly: latestOnlyMode,
              freshFromStart,
              prior: priorCursor as (SyncCursor & TokenIdCursorFields) | null,
              nowSec: Math.floor(startedAt / 1000),
            })
          : null;
      if (settings.paging === 'tokenid' && !this.tokenIdSupported(adapter)) this.warnTokenIdUnsupportedOnce(integrationKey);
      if (tokenIdPlan) {
        try {
          return await this.runTokenIdBackfill(integration, adapter, runId, startedAt, tokenIdPlan, settings, cursor, pause);
        } catch (err) {
          // An edge read (first tokenId since T / highest tokenId) failed
          // before anything was walked. Retrying would fail the same way (no
          // `(chainId, tokenId)` index on the indexer), so this run takes the
          // offset walk — today's behaviour, from the createdAt cursor.
          if (!isTokenIdEdgeQueryError(err)) throw err;
          this.logger.warn(
            `[alert] backfill.tokenid_edge_failed ${integrationKey} plan=${tokenIdPlan.kind}: ${(err as Error).message} — ` +
              `backfilling with the offset walk this run`,
          );
          // A fresh run saved a tokenId state it never used: drop it, or the
          // next run would "resume" a tokenId walk from 0. A resume keeps its
          // state — the offset walk clears it when it finishes.
          if (tokenIdPlan.kind === 'fresh' && hasTokenIdCursorOps(this.syncRepo)) {
            await this.syncRepo.clearBackfillTokenIdState(integration.chainId, integration.protocol);
          }
        }
      }

      const bucketCount = this.config.positionsBackfillBuckets;
      // Only a FRESH fromStart (this attempt reset the cursor) takes the
      // buckets: they persist no cursor until the very end, so a retry of a
      // bucketed run cannot resume them — it walks serially from the cursor
      // instead, which advances on every flush from then on.
      const parallelEligible =
        freshFromStart &&
        bucketCount > 1 &&
        !latestOnlyMode &&
        typeof adapter.fetchPositionTimestampRange === 'function';

      if (parallelEligible) {
        const result = await this.runBackfillBuckets(
          integration,
          adapter,
          runId,
          startedAt,
          bucketCount,
          settings.feeRead,
          pause,
        );
        // Paused mid-walk: the run is recorded interrupted and the flag kept;
        // the bulk tx walk belongs to a COMPLETE bucketed run only.
        if (result.paused) return result;
        // Positions are now in Mongo — run the bulk bucketed transaction walk
        // (far faster than per-position fan-out for a full rebuild). It resolves
        // position context per flush, so positions must land first.
        // Aggregates-mode adapters (v4) need no follow-up at all: each bucket
        // flush computed their metrics inside its upsert. (A whole second pass,
        // `recomputeAllAggregates`, ran here until 2026-10-03 — one extra write
        // of every row; it is the admin healer now.)
        await this.transactionSync
          .runTxBackfillBuckets(integration)
          .catch((err) =>
            this.logger.error(
              `Tx bulk backfill failed: ${integrationKey} ${(err as Error).message}`,
            ),
          );
        return result;
      }

      let cumulativeUpserted = 0;
      let nextProgressMilestone = POSITIONS_PROGRESS_LOG_EVERY;
      const backfill = await adapter.fetchPositions({
        integration,
        cursorTimestamp: cursor?.lastTimestamp ?? 0,
        cursorPositionId: cursor?.lastPositionId ?? '',
        pageSize: POSITIONS_SUBGRAPH_PAGE_SIZE,
        maxPages: POSITIONS_MAX_PAGES_PER_RUN,
        normalizationConcurrency: POSITIONS_NORMALIZATION_CONCURRENCY,
        mode: 'backfill',
        latestOnlyLimit,
        flushThreshold: POSITIONS_FLUSH_THRESHOLD,
        // The PAUSE only — not the shutdown signal: a shutdown keeps today's
        // behaviour for this walk (it runs until the process exits). Never
        // aborted unless the chain is paused, so the default walk is today's.
        signal: pause.ctl.signal,
        ...(settings.feeRead ? { feeRead: true } : {}),
        onFlush: async (positions, flushedCursor) => {
          const count = await this.positions.upsertMany(positions, await this.upsertOptions(integration));
          this.markBackfilledForFees(integration, positions);
          if (latestOnlyLimit <= 0) {
            await this.syncRepo.markCursorSuccess(integration.chainId, integration.protocol, {
              lastTimestamp: flushedCursor.maxTimestamp,
              lastPositionId: flushedCursor.maxPositionId,
              lastBlockNumber: flushedCursor.maxBlockNumber,
            });
          }
          await this.beatBackfill(integration);
          cumulativeUpserted += count;
          // Position-driven tx sync: every flushed batch immediately runs
          // tx fetch + price + recompute for the just-upserted positionIds
          // (a no-op for aggregates mode, whose upsert computed them).
          // `fromStart=true` runs treat this as a full-from-zero pass; resume
          // runs let the helper decide per-position (full vs incremental from
          // max stored tx timestamp).
          await this.dispatchPositionDrivenTxSync(
            integration,
            positions.map((p) => p.positionId),
            { fromZero: options.fromStart === true, origin: 'backfill-flush' },
          );
          if (cumulativeUpserted >= nextProgressMilestone) {
            const elapsedMs = Date.now() - startedAt;
            this.logger.log(
              `Backfill progress: ${integrationKey} upserted=${cumulativeUpserted} elapsedMs=${elapsedMs} cursor=(ts=${flushedCursor.maxTimestamp}, id=${flushedCursor.maxPositionId})`,
            );
            while (cumulativeUpserted >= nextProgressMilestone) {
              nextProgressMilestone += POSITIONS_PROGRESS_LOG_EVERY;
            }
          }
          return count;
        },
      });

      const residualBackfill = dedupeByPositionId(backfill.positions);
      let residualUpserted = 0;
      if (residualBackfill.length > 0) {
        residualUpserted = await this.positions.upsertMany(residualBackfill, await this.upsertOptions(integration));
        this.markBackfilledForFees(integration, residualBackfill);
      }
      if (residualBackfill.length > 0) {
        await this.dispatchPositionDrivenTxSync(
          integration,
          residualBackfill.map((p) => p.positionId),
          { fromZero: options.fromStart === true, origin: 'backfill-residual' },
        );
      }
      const totalUpserted = residualUpserted + backfill.flushedCount;

      // PAUSED before the walk ran out (a walk that finished on the flush that
      // saw the pause is simply complete): stop exactly like an interrupted
      // run — the residual is written, the cursor covers it and nothing more,
      // the flag stays set, the run is `interrupted`.
      if (pause.ctl.signal.aborted && backfill.hasMore) {
        if (!latestOnlyMode && residualBackfill.length > 0) {
          await this.syncRepo.markCursorSuccess(integration.chainId, integration.protocol, {
            lastTimestamp: backfill.maxTimestamp,
            lastPositionId: backfill.maxPositionId,
            lastBlockNumber: backfill.maxBlockNumber,
          });
        }
        return await this.finishPausedRun(integration, runId, startedAt, pause.by, {
          fetched: backfill.positions.length,
          upserted: totalUpserted,
          where: `at createdAt cursor (ts=${backfill.maxTimestamp}, id=${backfill.maxPositionId})`,
        });
      }

      if (!latestOnlyMode) {
        await this.syncRepo.markCursorSuccess(integration.chainId, integration.protocol, {
          lastTimestamp: backfill.maxTimestamp,
          lastPositionId: backfill.maxPositionId,
          lastBlockNumber: backfill.maxBlockNumber,
        });
      }

      // Clear the flag only when the subgraph has nothing more to give. If
      // hasMore=true it stays set — its heartbeat stops with this run, so the
      // stale sweep resumes within 10 min, and the next worker boot resumes the
      // walk from the cursor.
      if (!backfill.hasMore) {
        await this.syncRepo.markBackfillFinished(integration.chainId, integration.protocol);
        // An offset run that finished over a tokenId state (paging rolled back
        // mid-run) leaves no stale tokenId cursor for a later run to resume.
        const fields = cursor as (SyncCursor & TokenIdCursorFields) | null;
        if (fields?.backfillPaging === 'tokenid' && hasTokenIdCursorOps(this.syncRepo)) {
          await this.syncRepo.clearBackfillTokenIdState(integration.chainId, integration.protocol);
        }
      }

      const durationMs = Date.now() - startedAt;
      await this.syncRepo.finishRun(runId, {
        status: 'success',
        fetched: backfill.positions.length,
        refreshed: 0,
        upserted: totalUpserted,
        transactionsUpserted: 0,
        markedClosed: 0,
        durationMs,
      });
      this.logger.log(
        `Backfill finished: ${integrationKey} durationMs=${durationMs} fetched=${backfill.positions.length} upserted=${totalUpserted} hasMore=${backfill.hasMore}`,
      );

      return {
        chainId: integration.chainId,
        protocol: integration.protocol,
        fetched: backfill.positions.length,
        refreshed: 0,
        upserted: totalUpserted,
        transactionsUpserted: 0,
        markedClosed: 0,
        durationMs,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const durationMs = Date.now() - startedAt;
      await Promise.all([
        this.syncRepo.markCursorFailure(integration.chainId, integration.protocol, message),
        runId
          ? this.syncRepo.finishRun(runId, {
              status: 'failed',
              durationMs,
              error: message,
            })
          : undefined,
      ]);
      this.logRunFailure(`Backfill failed: ${integrationKey} durationMs=${durationMs} error=${message}`);
      throw error;
    } finally {
      stopHeartbeat();
      if (this.backfillPauses.get(integrationKey) === pause) this.backfillPauses.delete(integrationKey);
    }
  }

  /**
   * A walk that stopped because its chain was PAUSED: recorded exactly like an
   * interrupted run (status `interrupted`, flag and cursor left as they are —
   * no `markBackfillFinished`, no cursor reset), so `/resume` continues it.
   */
  private async finishPausedRun(
    integration: IntegrationConfig,
    runId: string,
    startedAt: number,
    by: string | undefined,
    tally: { fetched: number; upserted: number; where: string },
  ): Promise<SyncResult> {
    const integrationKey = `${integration.chainId}:${integration.protocol}`;
    const durationMs = Date.now() - startedAt;
    await this.syncRepo.finishRun(runId, {
      status: 'interrupted',
      fetched: tally.fetched,
      refreshed: 0,
      upserted: tally.upserted,
      transactionsUpserted: 0,
      markedClosed: 0,
      durationMs,
      error: `paused by ${by ?? 'admin'} — POST /admin/sync/backfill/resume continues from the cursor`,
    });
    this.logger.warn(
      `Backfill PAUSED: ${integrationKey} stopped ${tally.where} upserted=${tally.upserted} durationMs=${durationMs} — ` +
        `flag and cursor kept; resume with POST /admin/sync/backfill/resume`,
    );
    return {
      chainId: integration.chainId,
      protocol: integration.protocol,
      fetched: tally.fetched,
      refreshed: 0,
      upserted: tally.upserted,
      transactionsUpserted: 0,
      markedClosed: 0,
      durationMs,
      paused: true,
    };
  }

  private readonly tokenIdUnsupportedWarned = new Set<string>();

  /** The adapter can walk tokenId ranges AND the repository can keep their cursor. */
  private tokenIdSupported(adapter: PositionAdapter): boolean {
    return (
      typeof adapter.walkTokenIdRanges === 'function' &&
      typeof adapter.findFirstTokenIdCreatedSince === 'function' &&
      hasTokenIdCursorOps(this.syncRepo)
    );
  }

  private readonly feeReadUnboundWarned = new Set<string>();

  private warnFeeReadUnboundOnce(integrationKey: string): void {
    if (this.feeReadUnboundWarned.has(integrationKey)) return;
    this.feeReadUnboundWarned.add(integrationKey);
    this.logger.warn(
      `[alert] backfill.fee_read_unbound BACKFILL_FEE_READ=on but no PAGE_FEE_READER is bound for ${integrationKey} — ` +
        `backfilling without the in-walk fee reading (rows go to the fee job's backfill lane)`,
    );
  }

  private warnTokenIdUnsupportedOnce(integrationKey: string): void {
    if (this.tokenIdUnsupportedWarned.has(integrationKey)) return;
    this.tokenIdUnsupportedWarned.add(integrationKey);
    this.logger.warn(
      `BACKFILL_PAGING=tokenid but ${integrationKey} cannot use it (adapter without walkTokenIdRanges, or a SyncRepository ` +
        `without the tokenId cursor) — backfilling with the offset walk`,
    );
  }

  /** Pricing / GeckoTerminal counters for the profile (guarded: specs stub pricing). */
  private profileCounters(): ProfileExternalCounters {
    const pricing = this.pricing as Partial<Pick<PricingService, 'pricingWalkStats'>>;
    const p = typeof pricing.pricingWalkStats === 'function' ? pricing.pricingWalkStats() : undefined;
    return {
      providerCalls: p?.providerCalls ?? {},
      ledgerSkips: p?.ledger.skips ?? 0,
      lastKnownReads: p?.lastKnownReads ?? 0,
      cacheOnlyMisses: p?.cacheOnlyMisses ?? 0,
      gtWaitMs: geckoTerminalBudgetStats().waitMs,
      budgetWaitMs: processWriteBudget()?.laneWaitTotalMs('backfill') ?? 0,
    };
  }

  /**
   * `BACKFILL_PAGING=tokenid` (design §6.2-1): the tokenId range walk, then the
   * completeness TAIL, then — and only then — the createdAt cursor.
   *
   *  1. The walk persists only the tokenId state (`backfillTokenIdCursor` = the
   *     end of the highest CONTIGUOUS written range, after every range), so a
   *     deploy loses at most the ranges in flight and a resume starts there.
   *  2. The tail is today's createdAt walk from the run start − 1 h: positions
   *     created during the walk at tokenIds it had already passed, and late
   *     first-liquidity rows. Small by construction (`[alert] backfill.tail_large`
   *     past 1 % of the walk).
   *  3. `lastTimestamp/lastPositionId` = max(createdAt, id) over the cursor the
   *     run started from, the walk and the tail — written at run END only, so
   *     later incremental runs (still createdAt mode) behave as today and a
   *     rollback to `offset` mid-run resumes from the run start.
   * A shutdown stops between ranges (or tail pages): the flag and the tokenId
   * state stay, and the run is recorded `interrupted`.
   */
  private async runTokenIdBackfill(
    integration: IntegrationConfig,
    adapter: PositionAdapter,
    runId: string,
    startedAt: number,
    plan: TokenIdPlan,
    settings: BackfillSettings,
    startCursor: SyncCursor | null,
    pause?: { ctl: AbortController; by?: string },
  ): Promise<SyncResult> {
    const { chainId, protocol } = integration;
    const integrationKey = `${chainId}:${protocol}`;

    let from: string | null;
    if (plan.kind === 'convert') {
      from = await adapter.findFirstTokenIdCreatedSince!(integration, plan.sinceTs);
      this.logger.log(
        `Backfill (tokenid): converting the interrupted offset run of ${integrationKey} at createdAt ≥ ${plan.sinceTs} → ` +
          (from === null ? 'nothing left to walk' : `tokenId ${from}`),
      );
    } else {
      from = plan.from;
    }
    const runStartTs = plan.runStartTs;
    this.logger.log(
      `Backfill (tokenid) ${plan.kind}: ${integrationKey} from=${from ?? '-'} runStartTs=${runStartTs} ` +
        `pipeline=${settings.pipeline} lookahead=${settings.lookaheadPages} feeRead=${feeReadLabel(settings)}`,
    );

    const profile = new BackfillProfile(chainId, protocol, 'tokenid', this.logger, () => this.profileCounters());
    // `[alert] backfill.slow` is also checked while no range lands (a stalled walk).
    const slowTimer = setInterval(() => profile.checkSlow(), BACKFILL_SLOW_CHECK_MS);
    slowTimer.unref?.();
    try {
      return await this.runTokenIdWalk(integration, adapter, runId, startedAt, plan, settings, startCursor, from, profile, pause);
    } finally {
      clearInterval(slowTimer);
    }
  }

  /** The body of `runTokenIdBackfill` once the start point is known (see there). */
  private async runTokenIdWalk(
    integration: IntegrationConfig,
    adapter: PositionAdapter,
    runId: string,
    startedAt: number,
    plan: TokenIdPlan,
    settings: BackfillSettings,
    startCursor: SyncCursor | null,
    from: string | null,
    profile: BackfillProfile,
    pause?: { ctl: AbortController; by?: string },
  ): Promise<SyncResult> {
    const { chainId, protocol } = integration;
    const integrationKey = `${chainId}:${protocol}`;
    const repo = this.syncRepo as unknown as SyncTokenIdCursorOps;
    // A shutdown OR a pause stops the walk between ranges (and the tail between
    // pages); which one decides how the stop is recorded below.
    const signal = pause ? eitherSignal(shutdownSignal(), pause.ctl.signal) : shutdownSignal();
    const pausedStop = (): boolean => pause?.ctl.signal.aborted === true;
    const runStartTs = plan.runStartTs;
    let upserted = 0;
    let fetched = 0;
    let end = {
      ts: Number(startCursor?.lastTimestamp ?? 0) || 0,
      id: String(startCursor?.lastPositionId ?? ''),
      block: Number(startCursor?.lastBlockNumber ?? 0) || 0,
    };
    const noteRows = (positions: NormalizedPosition[], blockHint = 0): void => {
      for (const p of positions) end = laterCursor(end, { ts: p.createdAtTimestamp, id: p.positionId, block: 0 });
      end.block = Math.max(end.block, blockHint);
    };
    const finishInterrupted = async (reason: string): Promise<SyncResult> => {
      profile.setPhase('aborted');
      // Paused (audit C-pause): the same stop — tokenId state, flag and
      // createdAt cursor all left as they are — recorded as a pause.
      if (pausedStop()) return this.finishPausedRun(integration, runId, startedAt, pause?.by, { fetched, upserted, where: reason });
      const durationMs = Date.now() - startedAt;
      await this.syncRepo.finishRun(runId, {
        status: 'interrupted',
        fetched,
        refreshed: 0,
        upserted,
        transactionsUpserted: 0,
        markedClosed: 0,
        durationMs,
        error: reason,
      });
      this.logger.warn(`Backfill (tokenid) stopped: ${integrationKey} ${reason} upserted=${upserted} durationMs=${durationMs}`);
      return { chainId, protocol, fetched, refreshed: 0, upserted, transactionsUpserted: 0, markedClosed: 0, durationMs };
    };

    let walk: TokenIdWalkResult | undefined;
    if (from !== null) {
      await repo.saveBackfillTokenIdState(chainId, protocol, { tokenIdCursor: from, runStartTs });
      walk = await adapter.walkTokenIdRanges!({
        integration,
        fromTokenId: from,
        lookahead: settings.lookaheadPages,
        normalizationConcurrency: POSITIONS_NORMALIZATION_CONCURRENCY,
        pipeline: settings.pipeline,
        priceWaitMs: settings.priceWaitMs,
        feeRead: settings.feeRead,
        signal,
        onRange: async (positions, range, stats) => {
          const t = Date.now();
          const count = positions.length > 0 ? await this.positions.upsertMany(positions, await this.upsertOptions(integration)) : 0;
          const flushMs = Date.now() - t;
          if (positions.length > 0) this.markBackfilledForFees(integration, positions);
          await this.beatBackfill(integration);
          upserted += count;
          fetched += stats.rows;
          noteRows(positions);
          // Same per-flush tx-sync as the offset walk (a no-op for aggregates
          // adapters, which compute their metrics inside the upsert).
          if (positions.length > 0) {
            await this.dispatchPositionDrivenTxSync(
              integration,
              positions.map((p) => p.positionId),
              { fromZero: plan.kind === 'fresh', origin: 'backfill-range' },
            );
          }
          profile.addRange(stats, { written: count, flushMs, cursor: range.to });
          return count;
        },
        onCursor: (next) => repo.saveBackfillTokenIdCursor(chainId, protocol, next),
      });
      end.block = Math.max(end.block, walk.maxBlockNumber);
      if (walk.aborted) {
        return finishInterrupted(
          pausedStop()
            ? `at tokenId ${walk.nextTokenId} (tokenId cursor kept)`
            : `at tokenId ${walk.nextTokenId} (shutdown) — resumes from the tokenId cursor`,
        );
      }
    }

    // The completeness tail (today's createdAt walk, no cursor writes: a crash
    // here resumes the walk at its end — one tokenIdMax read — and re-runs it).
    profile.setPhase('tail');
    let tailRows = 0;
    const tail = await adapter.fetchPositions({
      integration,
      cursorTimestamp: Math.max(0, runStartTs - TOKENID_TAIL_LOOKBACK_SEC),
      cursorPositionId: '',
      pageSize: POSITIONS_SUBGRAPH_PAGE_SIZE,
      // Never capped by POSITIONS_MAX_PAGES_PER_RUN: a capped tail would stop
      // with `hasMore` on every attempt and the run could never finish. It is
      // small by construction (rows created since run start − 1 h).
      maxPages: 0,
      normalizationConcurrency: POSITIONS_NORMALIZATION_CONCURRENCY,
      mode: 'backfill',
      flushThreshold: POSITIONS_FLUSH_THRESHOLD,
      paging: 'offset',
      signal,
      ...(settings.feeRead ? { feeRead: true } : {}),
      onFlush: async (positions, flushedCursor) => {
        const count = await this.positions.upsertMany(positions, await this.upsertOptions(integration));
        this.markBackfilledForFees(integration, positions);
        await this.beatBackfill(integration);
        upserted += count;
        tailRows += count;
        noteRows(positions, flushedCursor.maxBlockNumber);
        await this.dispatchPositionDrivenTxSync(
          integration,
          positions.map((p) => p.positionId),
          { fromZero: false, origin: 'backfill-tail' },
        );
        return count;
      },
    });
    const residual = dedupeByPositionId(tail.positions);
    if (residual.length > 0) {
      const count = await this.positions.upsertMany(residual, await this.upsertOptions(integration));
      this.markBackfilledForFees(integration, residual);
      upserted += count;
      tailRows += count;
      noteRows(residual, tail.maxBlockNumber);
    }
    fetched += tail.positions.length + tail.flushedCount;
    profile.addTail(tailRows);
    if (tail.hasMore) {
      return finishInterrupted(
        pausedStop()
          ? 'in the completeness tail (the resume re-runs the tail from the end of the tokenId walk)'
          : 'in the completeness tail (shutdown) — resumes at the end of the tokenId walk',
      );
    }

    const walkRows = walk?.rows ?? 0;
    if (walkRows > 0 && tailRows > walkRows * 0.01) {
      this.logger.warn(
        `[alert] backfill.tail_large chain=${chainId} protocol=${protocol} tailRows=${tailRows} walkRows=${walkRows} — ` +
          `more than 1% of the run was found only by the createdAt tail (late first liquidity, or tokenIds not dense?)`,
      );
    }

    // Only now: the createdAt cursor, then the run is over.
    await this.syncRepo.markCursorSuccess(chainId, protocol, {
      lastTimestamp: end.ts,
      lastPositionId: end.id,
      lastBlockNumber: end.block,
    });
    await repo.clearBackfillTokenIdState(chainId, protocol);
    await this.syncRepo.markBackfillFinished(chainId, protocol);
    profile.setPhase('done');

    const durationMs = Date.now() - startedAt;
    await this.syncRepo.finishRun(runId, {
      status: 'success',
      fetched,
      refreshed: 0,
      upserted,
      transactionsUpserted: 0,
      markedClosed: 0,
      durationMs,
    });
    this.logger.log(
      `Backfill finished (tokenid): ${integrationKey} durationMs=${durationMs} ranges=${walk?.ranges ?? 0} walkRows=${walkRows} ` +
        `tailRows=${tailRows} upserted=${upserted} cursor=(ts=${end.ts}, id=${end.id})`,
    );
    return { chainId, protocol, fetched, refreshed: 0, upserted, transactionsUpserted: 0, markedClosed: 0, durationMs };
  }

  /**
   * Parallel-bucket backfill — only fires on a FRESH `fromStart=true` run. Divides the
   * `[earliest, latest] createdAtTimestamp` span into `bucketCount` equal time
   * slices, runs one cursor walk per slice in parallel. Each walker has its own
   * pipelined fetch + own `onFlush` upsert, all sharing the same cumulative
   * counter and global-max cursor tracker. The persisted cursor + backfill-
   * finished flag are written only once at the very end, so an interrupted
   * parallel run cannot resume: its retry (or the boot's resume) walks
   * SERIALLY from the cursor the fresh run reset to 0 — every row again, but
   * resumable from then on (upserts are idempotent).
   */
  private async runBackfillBuckets(
    integration: IntegrationConfig,
    adapter: ReturnType<AdapterRegistryService['resolve']>,
    runId: string,
    startedAt: number,
    bucketCount: number,
    feeRead = false,
    pause?: { ctl: AbortController; by?: string },
  ): Promise<SyncResult> {
    const integrationKey = `${integration.chainId}:${integration.protocol}`;
    if (!adapter.fetchPositionTimestampRange) {
      throw new Error(`Adapter for ${integration.protocol} does not implement fetchPositionTimestampRange`);
    }

    try {
      const range = await adapter.fetchPositionTimestampRange(integration);
      if (range.minTimestamp <= 0 || range.maxTimestamp <= 0 || range.maxTimestamp < range.minTimestamp) {
        this.logger.warn(
          `Parallel backfill: empty or invalid range for ${integrationKey} (min=${range.minTimestamp} max=${range.maxTimestamp}) — nothing to do`,
        );
        await this.syncRepo.markBackfillFinished(integration.chainId, integration.protocol);
        await this.syncRepo.finishRun(runId, {
          status: 'success',
          fetched: 0,
          refreshed: 0,
          upserted: 0,
          transactionsUpserted: 0,
          markedClosed: 0,
          durationMs: Date.now() - startedAt,
        });
        return emptyResult(integration);
      }

      const span = range.maxTimestamp - range.minTimestamp + 1;
      const step = Math.max(1, Math.ceil(span / bucketCount));
      this.logger.log(
        `Backfill (parallel): ${integrationKey} range=[${range.minTimestamp}, ${range.maxTimestamp}] buckets=${bucketCount} step=${step}s`,
      );

      let cumulativeUpserted = 0;
      let cumulativeFetched = 0;
      let nextMilestone = POSITIONS_PROGRESS_LOG_EVERY;
      let globalMaxTimestamp = 0;
      let globalMaxPositionId = '';
      let globalMaxBlockNumber = 0;

      const advanceGlobalCursor = (ts: number, pid: string, blockNumber: number): void => {
        if (ts > globalMaxTimestamp || (ts === globalMaxTimestamp && pid > globalMaxPositionId)) {
          globalMaxTimestamp = ts;
          globalMaxPositionId = pid;
        }
        if (blockNumber > globalMaxBlockNumber) globalMaxBlockNumber = blockNumber;
      };

      const tasks = Array.from({ length: bucketCount }, async (_, idx) => {
        const bucketMin = range.minTimestamp + idx * step;
        const bucketMax =
          idx === bucketCount - 1 ? range.maxTimestamp + 1 : range.minTimestamp + (idx + 1) * step;
        // Per-bucket try/catch: a single subgraph 5xx or unhandled exception
        // inside one bucket must NOT reject `Promise.all(tasks)` and kill the
        // backfill. Sibling buckets keep running; the failed bucket's range
        // will be re-walked on the next backfill tick when the cursor resumes.
        try {
          const result = await adapter.fetchPositions({
            integration,
            // _gt semantic in the range query → use bucketMin - 1 to include bucketMin itself.
            cursorTimestamp: Math.max(0, bucketMin - 1),
            cursorPositionId: '',
            pageSize: POSITIONS_SUBGRAPH_PAGE_SIZE,
            maxPages: POSITIONS_MAX_PAGES_PER_RUN,
            normalizationConcurrency: POSITIONS_NORMALIZATION_CONCURRENCY,
            mode: 'backfill',
            flushThreshold: POSITIONS_FLUSH_THRESHOLD,
            maxTimestamp: bucketMax,
            // The PAUSE only (a shutdown keeps today's behaviour): every
            // walker stops before its next page once the chain is paused.
            ...(pause ? { signal: pause.ctl.signal } : {}),
            ...(feeRead ? { feeRead: true } : {}),
            onFlush: async (positions, flushedCursor) => {
              const count = await this.positions.upsertMany(positions, await this.upsertOptions(integration));
              this.markBackfilledForFees(integration, positions);
              await this.beatBackfill(integration);
              cumulativeUpserted += count;
              advanceGlobalCursor(flushedCursor.maxTimestamp, flushedCursor.maxPositionId, flushedCursor.maxBlockNumber);
              // No per-flush tx dispatch here: on `fromStart` the bulk
              // `runTxBackfillBuckets` walk runs after all positions land
              // (far fewer round-trips than per-position fan-out). Aggregates
              // mode needs none: the upsert computed the metrics.
              if (cumulativeUpserted >= nextMilestone) {
                const elapsedMs = Date.now() - startedAt;
                this.logger.log(
                  `Backfill progress (parallel): ${integrationKey} upserted=${cumulativeUpserted} elapsedMs=${elapsedMs} bucket=${idx + 1}/${bucketCount}`,
                );
                while (cumulativeUpserted >= nextMilestone) nextMilestone += POSITIONS_PROGRESS_LOG_EVERY;
              }
              return count;
            },
          });
          cumulativeFetched += result.positions.length;
          return result;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.error(
            `Backfill bucket ${idx + 1}/${bucketCount} failed for ${integrationKey} (range [${bucketMin}, ${bucketMax})): ${message}`,
          );
          return {
            positions: [],
            seenPositionIds: [],
            maxTimestamp: 0,
            maxPositionId: '',
            maxBlockNumber: 0,
            hasMore: true,
            flushedCount: 0,
          };
        }
      });

      const results = await Promise.all(tasks);

      // Drain per-bucket residuals (positions left below the flush threshold).
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (!r || r.positions.length === 0) continue;
        const deduped = dedupeByPositionId(r.positions);
        if (deduped.length > 0) {
          const count = await this.positions.upsertMany(deduped, await this.upsertOptions(integration));
          this.markBackfilledForFees(integration, deduped);
          cumulativeUpserted += count;
        }
        advanceGlobalCursor(r.maxTimestamp, r.maxPositionId, r.maxBlockNumber);
        // tx-sync handled by the bulk walk after positions complete (see above).
      }

      // PAUSED with a bucket still unfinished: buckets persist no cursor until
      // the end, so — exactly like an interrupted bucketed run — the cursor
      // stays where the fresh run reset it, the flag stays set, and the resume
      // walks serially from there (the rows written so far are idempotent upserts).
      if (pause?.ctl.signal.aborted && results.some((r) => r?.hasMore === true)) {
        return await this.finishPausedRun(integration, runId, startedAt, pause.by, {
          fetched: cumulativeFetched,
          upserted: cumulativeUpserted,
          where: `mid parallel walk (${bucketCount} buckets; the resume walks serially from the cursor)`,
        });
      }

      const persistedCursorTs = globalMaxTimestamp || range.maxTimestamp;
      await this.syncRepo.markCursorSuccess(integration.chainId, integration.protocol, {
        lastTimestamp: persistedCursorTs,
        lastPositionId: globalMaxPositionId,
        lastBlockNumber: globalMaxBlockNumber,
      });
      await this.syncRepo.markBackfillFinished(integration.chainId, integration.protocol);

      const durationMs = Date.now() - startedAt;
      await this.syncRepo.finishRun(runId, {
        status: 'success',
        fetched: cumulativeFetched,
        refreshed: 0,
        upserted: cumulativeUpserted,
        transactionsUpserted: 0,
        markedClosed: 0,
        durationMs,
      });
      this.logger.log(
        `Backfill finished (parallel): ${integrationKey} durationMs=${durationMs} fetched=${cumulativeFetched} upserted=${cumulativeUpserted} buckets=${bucketCount}`,
      );

      return {
        chainId: integration.chainId,
        protocol: integration.protocol,
        fetched: cumulativeFetched,
        refreshed: 0,
        upserted: cumulativeUpserted,
        transactionsUpserted: 0,
        markedClosed: 0,
        durationMs,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const durationMs = Date.now() - startedAt;
      await Promise.all([
        this.syncRepo.markCursorFailure(integration.chainId, integration.protocol, message),
        this.syncRepo.finishRun(runId, {
          status: 'failed',
          durationMs,
          error: message,
        }),
      ]);
      this.logRunFailure(`Backfill failed (parallel): ${integrationKey} durationMs=${durationMs} error=${message}`);
      throw error;
    }
  }

  /**
   * Refresh one slice of the active set page-by-page in stable positionId
   * order. `pending=true` selects positions whose `metrics.performanceReady ===
   * false` (shown as "pending" in the UI) so the cron resolves them before the
   * already-ready ones; `pending=false` covers the rest. Per page it warms the
   * current-price cache (so the chunked subgraph refreshes can skip reprime),
   * fans out the refreshes, upserts, and rides open-position tx-sync on each
   * chunk. Accumulates seen ids into the caller's set for the stale sweep (ONE
   * set: it was also pushed into an array, holding every active id twice —
   * ~1.2M of them at full Robinhood).
   *
   * A chunk that throws (an indexer 429/5xx after retries, a Mongo write
   * error) is logged and COUNTED, never rethrown. It used to reject
   * `mapConcurrent`, fail the whole run, and have BullMQ re-run every chunk from
   * scratch up to 3× — one bad chunk multiplied into thousands of indexer
   * requests. The caller reads `failedChunks` to skip the stale sweep, because
   * a failed chunk's ids never reached `seenActive`.
   */
  private async refreshActivePass(
    integration: IntegrationConfig,
    pending: boolean,
    seenActive: Set<string>,
  ): Promise<{ refreshed: number; upserted: number; chunks: number; failedChunks: number }> {
    const adapter = this.adapters.resolve(integration.protocol);
    const integrationKey = `${integration.chainId}:${integration.protocol}`;
    let refreshed = 0;
    let upserted = 0;
    let chunks = 0;
    let failedChunks = 0;
    let cursor = '';
    for (;;) {
      const activeRefs = await this.positions.findActiveRefsWithTokensPage(
        integration.chainId,
        integration.protocol,
        POSITIONS_REFRESH_PAGE_SIZE,
        cursor,
        { pending },
      );
      if (activeRefs.length === 0) break;

      const tokensByAddress = new Map<string, { address: string; symbol?: string }>();
      for (const ref of activeRefs) {
        if (ref.token0Address && !tokensByAddress.has(ref.token0Address)) {
          tokensByAddress.set(ref.token0Address, { address: ref.token0Address, symbol: ref.token0Symbol });
        }
        if (ref.token1Address && !tokensByAddress.has(ref.token1Address)) {
          tokensByAddress.set(ref.token1Address, { address: ref.token1Address, symbol: ref.token1Symbol });
        }
      }
      if (tokensByAddress.size > 0) {
        await this.pricing.prefetchPrices(integration.chainId, [...tokensByAddress.values()]);
      }

      const refreshChunks = chunkArray(
        activeRefs.map((position) => position.positionId),
        POSITIONS_SUBGRAPH_PAGE_SIZE,
      );
      chunks += refreshChunks.length;
      // One native-price read per page, shared by its chunks' upserts.
      const upsertOpts = await this.upsertOptions(integration);
      await mapConcurrent(
        refreshChunks,
        POSITIONS_REFRESH_CONCURRENCY,
        async (chunk) => {
          try {
            const result = await adapter.fetchPositions({
              integration,
              cursorTimestamp: 0,
              pageSize: chunk.length,
              maxPages: 1,
              normalizationConcurrency: POSITIONS_NORMALIZATION_CONCURRENCY,
              mode: 'refresh',
              positionIds: chunk,
              skipPrefetch: true,
            });
            for (const id of result.seenPositionIds) seenActive.add(id);
            refreshed += result.positions.length;
            if (result.positions.length === 0) return;
            // ONE write per position: aggregates mode computes its metrics
            // inside this upsert (it used to be followed by a recompute that
            // re-read and rewrote every row).
            const up = await this.positions.upsertMany(result.positions, upsertOpts);
            upserted += up;
            // Open-position tx sync rides on the refresh chunk: incremental
            // from each position's max stored tx timestamp (auto mode). A
            // no-op for aggregates mode.
            await this.dispatchPositionDrivenTxSync(
              integration,
              result.positions.map((p) => p.positionId),
              { fromZero: false, origin: 'refresh-open' },
            );
          } catch (err) {
            failedChunks += 1;
            this.logger.warn(
              `Refresh chunk failed: ${integrationKey} pending=${pending} positions=${chunk.length} ids=${chunk[0]}..${chunk[chunk.length - 1]} ${(err as Error)?.message ?? String(err)}`,
            );
          }
        },
      );

      cursor = activeRefs[activeRefs.length - 1]?.positionId ?? '';
      if (activeRefs.length < POSITIONS_REFRESH_PAGE_SIZE || !cursor) break;
    }
    return { refreshed, upserted, chunks, failedChunks };
  }

  /**
   * Cron-driven refresh: re-fetch already-tracked active positions, then run
   * the stale sweep. Does not discover new positions. Runs concurrently with
   * an in-flight backfill (Mongo upserts are idempotent). The stale sweep
   * inside is gated separately — it defers while a backfill is RUNNING (flag
   * set and heartbeat fresh), because backfill is inserting positions that
   * wouldn't be in `seenActive` and would get incorrectly counted as stale
   * misses.
   *
   * Aggregates-mode adapters (v4) run Phase B and E only. Phase C (closed
   * catch-up) never converges for them — their tx-sync state is never set, so
   * every closed position stays a candidate and was re-read and rewritten every
   * tick (~1.05M docs per cycle) — and Phase D's heal sweep recomputes metrics
   * with the transaction-based method they do not use. Closed positions'
   * vs-HODL figures therefore freeze at their last recompute;
   * `recomputeAllAggregates` stays the admin healer.
   *
   * A refresh whose chunks partly failed finishes `partial` instead of throwing
   * and skips the stale sweep (see `refreshActivePass`).
   */
  async runRefresh(integration: IntegrationConfig): Promise<SyncResult> {
    const integrationKey = `${integration.chainId}:${integration.protocol}`;
    if (this.activeRefreshes.has(integrationKey)) {
      this.logger.warn(`Skipping refresh because one is already running: ${integrationKey}`);
      return emptyResult(integration);
    }

    // Released in `finally` (it used to be added before `startRun`, outside
    // any try: a throwing `startRun` left the chain marked "running" for the
    // life of the process and every later refresh of it was skipped).
    this.activeRefreshes.add(integrationKey);
    try {
      if (!this.flowLocks) return await this.runRefreshUnlocked(integration);
      const out = await this.flowLocks.run(flowLockName('refresh', integration.chainId, integration.protocol), () =>
        this.runRefreshUnlocked(integration),
      );
      if (out.held) {
        // Skip as today: the next repeatable tick runs.
        this.logger.log(`Refresh held elsewhere: ${integrationKey} — skipped`);
        return { ...emptyResult(integration), heldElsewhere: true };
      }
      return out.value;
    } finally {
      this.activeRefreshes.delete(integrationKey);
    }
  }

  private async runRefreshUnlocked(integration: IntegrationConfig): Promise<SyncResult> {
    const integrationKey = `${integration.chainId}:${integration.protocol}`;
    const startedAt = Date.now();
    const runId = await this.syncRepo.startRun(integration.chainId, integration.protocol);
    // Read before the walk: if a FALLBACK indexer answers anything on this chain
    // during the pass, the counter moves and the stale sweep below stands down.
    const fallbackServesAtStart = indexerFallbackServes(integration.chainId);

    try {
      this.logger.log(`Refresh started: ${integrationKey} at ${new Date(startedAt).toISOString()}`);

      const aggregates = this.adapters.resolve(integration.protocol).recomputeMode === 'aggregates';
      let refreshedCount = 0;
      let refreshUpserted = 0;
      let totalChunks = 0;
      let failedChunks = 0;
      const seenActive = new Set<string>();

      // Phase B: refresh EVERY active position (no batch cap), in priority order:
      //   B1 — positions that show "pending" in the UI (metrics.performanceReady
      //        === false), so they resolve to real numbers soonest;
      //   B2 — the remaining (already-ready) active positions.
      // Each pass walks its subset in stable positionId order; together they
      // cover all active positions, so `seenActive` stays complete for the
      // stale sweep. Closed positions follow in Phase C — pending > open > closed.
      for (const pending of [true, false]) {
        const pass = await this.refreshActivePass(integration, pending, seenActive);
        refreshedCount += pass.refreshed;
        refreshUpserted += pass.upserted;
        totalChunks += pass.chunks;
        failedChunks += pass.failedChunks;
      }

      // Phase C: closed-position catch-up — cover EVERY closed position whose
      // tx-sync hasn't converged (no budget cap). The paginated picker reads
      // only persisted fields (no $lookup), so an unbounded walk stays cheap.
      // Skip ids already refreshed as active above (a position can flip
      // active→closed mid-tick). position-driven tx-sync decides per position
      // whether a full or incremental fetch is needed. Not for aggregates mode:
      // it never converges there (see the method comment).
      if (!aggregates) {
        let closedScanned = 0;
        let closedCursor = '';
        for (;;) {
          const closed = await this.positions.findHotClosedCandidatesPage(
            integration.chainId,
            integration.protocol,
            CLOSED_CANDIDATE_PAGE_SIZE,
            closedCursor,
          );
          if (closed.length === 0) break;
          const closedIds = closed
            .map((c) => c.positionId)
            .filter((id) => !seenActive.has(id));
          if (closedIds.length > 0) {
            closedScanned += closedIds.length;
            await this.dispatchPositionDrivenTxSync(
              integration,
              closedIds,
              { fromZero: false, origin: 'refresh-closed' },
            );
          }
          closedCursor = closed[closed.length - 1]?.positionId ?? '';
          if (closed.length < CLOSED_CANDIDATE_PAGE_SIZE || !closedCursor) break;
        }
        if (closedScanned > 0) {
          this.logger.log(`Refresh closed catch-up: ${integrationKey} positions=${closedScanned}`);
        }

        // Phase D: background recovery — reprice stored `none` rows + heal-sweep
        // recompute (cache-bridge probe). Fire-and-forget: both passes are
        // cursor-resumable + idempotent (skipActiveLock), so their multi-minute
        // duration must not extend the refresh lock or delay the next tick.
        // Not for aggregates mode: the heal sweep recomputes with the
        // transaction-based method, which would overwrite aggregates metrics.
        void this.transactionSync
          .repriceAndHealForRefresh(integration)
          .catch((err) =>
            this.logger.warn(
              `Refresh reprice+heal failed: ${integrationKey} ${(err as Error).message}`,
            ),
          );
      }

      // Phase E: stale sweep. We now always walk every active position, so
      // `seenActive` is a complete picture — unless a chunk failed (its ids
      // never reached the seen set, so live positions would be counted as
      // misses) or a backfill is running (it inserts positions not yet in the
      // seen set). Either way, defer to the next tick that walks cleanly. A
      // backfill FLAG whose heartbeat is older than 10 min is a dead backfill
      // (`isBackfillInProgress`) and no longer holds the sweep off.
      //
      // A fallback indexer answering is the third reason. It serves the same rows
      // but may be behind the primary, so a position it has not indexed yet would
      // be missing from `seenActive` and counted as a miss — and three misses close
      // a live position.
      let markedClosed = 0;
      const fallbackServed = indexerFallbackServes(integration.chainId) - fallbackServesAtStart;
      if (failedChunks > 0) {
        this.logger.warn(
          `Stale sweep skipped: ${failedChunks}/${totalChunks} refresh chunks failed for ${integrationKey}`,
        );
      } else if (fallbackServed > 0) {
        this.logger.warn(
          `Stale sweep skipped: the fallback indexer answered ${fallbackServed} request(s) on chain ` +
            `${integration.chainId} during this refresh of ${integrationKey}`,
        );
      } else {
        const backfillInFlight =
          this.activeBackfills.has(integrationKey) ||
          (await this.syncRepo.isBackfillInProgress(integration.chainId, integration.protocol));
        if (!backfillInFlight) {
          markedClosed = await this.positions.markMissingStale(
            integration.chainId,
            integration.protocol,
            seenActive,
            POSITIONS_STALE_MAX_MISSES,
          );
          // The sweep RAN to completion with no failed chunk: every active row
          // this refresh did not see now carries a stale miss, so every row
          // without one was verified by THIS refresh — its start is the shard's
          // `lastCleanRefreshAt` (design §4.6; the read overlay uses it).
          await this.recordCleanRefresh(integration, startedAt);
        } else {
          this.logger.log(`Stale sweep deferred: backfill in flight for ${integrationKey}`);
        }
      }

      // `partial`, not a throw: a throw re-runs every chunk from scratch (BullMQ
      // attempts: 3), and the failed chunks are retried by the next tick anyway.
      const status = failedChunks > 0 ? 'partial' : 'success';
      const durationMs = Date.now() - startedAt;
      await this.syncRepo.finishRun(runId, {
        status,
        fetched: 0,
        refreshed: refreshedCount,
        upserted: refreshUpserted,
        transactionsUpserted: 0,
        markedClosed,
        durationMs,
        ...(failedChunks > 0 ? { error: `${failedChunks}/${totalChunks} refresh chunks failed` } : {}),
      });
      if (status === 'success') await this.recordRefreshOk(integration);
      this.logger.log(
        `Refresh finished: ${integrationKey} status=${status} durationMs=${durationMs} refreshed=${refreshedCount} upserted=${refreshUpserted} markedClosed=${markedClosed} failedChunks=${failedChunks}/${totalChunks}`,
      );

      return {
        chainId: integration.chainId,
        protocol: integration.protocol,
        fetched: 0,
        refreshed: refreshedCount,
        upserted: refreshUpserted,
        transactionsUpserted: 0,
        markedClosed,
        durationMs,
        status,
        failedChunks,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const durationMs = Date.now() - startedAt;
      await this.syncRepo.finishRun(runId, {
        status: 'failed',
        durationMs,
        error: message,
      });
      this.logRunFailure(`Refresh failed: ${integrationKey} durationMs=${durationMs} error=${message}`);
      throw error;
    }
  }

  /**
   * Best-effort: a failed write only leaves the overlay on the previous clean
   * refresh (older, never wrong). Only with `POSITIONS_WRITE_SKIP` shadow / on:
   * the read overlay (its only reader) applies with `on`, and the rollout runs
   * `shadow` first, so the stamp exists before `on` serves from it. With skip
   * `off` (the default) the refresh writes nothing here — today. A direct
   * off → on switch serves the stored clocks until the first refresh under
   * `on` stamps it (the overlay treats "unknown" as "no time overlay").
   */
  private async recordCleanRefresh(integration: IntegrationConfig, startedAt: number): Promise<void> {
    if (writeSkipSettings(this.config as unknown as WriteSkipConfigSource).mode === 'off') return;
    const repo = this.syncRepo as unknown as Partial<SyncCleanRefreshOps>;
    if (typeof repo.setLastCleanRefreshAt !== 'function') return;
    try {
      await repo.setLastCleanRefreshAt(integration.chainId, integration.protocol, new Date(startedAt));
    } catch (err) {
      this.logger.warn(
        `lastCleanRefreshAt not recorded: ${integration.chainId}:${integration.protocol} ${(err as Error)?.message ?? String(err)}`,
      );
    }
  }

  /**
   * Stamp the END of a successful refresh (`lastRefreshOkAt`, the overdue
   * watch's input) — only while that watch is on (the write budget on), so
   * the default writes nothing new. Best-effort: a failed stamp can at worst
   * raise one overdue alert a refresh later than it should clear.
   */
  private async recordRefreshOk(integration: IntegrationConfig): Promise<void> {
    if (!refreshOverdueWatchOn(this.config)) return;
    const repo = this.syncRepo as unknown as Partial<SyncRefreshOkOps>;
    if (typeof repo.setLastRefreshOkAt !== 'function') return;
    try {
      await repo.setLastRefreshOkAt(integration.chainId, integration.protocol, new Date());
    } catch (err) {
      this.logger.warn(
        `lastRefreshOkAt not recorded: ${integration.chainId}:${integration.protocol} ${(err as Error)?.message ?? String(err)}`,
      );
    }
  }

  async backfillAll(options: BackfillOptions = {}): Promise<SyncResult[]> {
    const integrations = this.config.enabledIntegrations;
    return Promise.all(integrations.map((integration) => this.runBackfill(integration, options)));
  }

  async refreshAll(): Promise<SyncResult[]> {
    const integrations = this.config.enabledIntegrations;
    return Promise.all(integrations.map((integration) => this.runRefresh(integration)));
  }

  async backfillTarget(
    chainId: number,
    protocol: string,
    options: BackfillOptions = {},
  ): Promise<SyncResult> {
    const integration = this.config.getIntegration(chainId, protocol);
    if (!integration) {
      throw new Error(`No enabled integration for chainId=${chainId}, protocol=${protocol}`);
    }
    return this.runBackfill(integration, options);
  }

  async refreshTarget(chainId: number, protocol: string): Promise<SyncResult> {
    const integration = this.config.getIntegration(chainId, protocol);
    if (!integration) {
      throw new Error(`No enabled integration for chainId=${chainId}, protocol=${protocol}`);
    }
    return this.runRefresh(integration);
  }
}

/** The repository can keep a tokenId walk's cursor (`SyncTokenIdCursorOps`). */
function hasTokenIdCursorOps(repo: unknown): repo is SyncTokenIdCursorOps {
  const r = repo as Partial<SyncTokenIdCursorOps> | null;
  return (
    !!r &&
    typeof r.saveBackfillTokenIdState === 'function' &&
    typeof r.saveBackfillTokenIdCursor === 'function' &&
    typeof r.clearBackfillTokenIdState === 'function'
  );
}

function emptyResult(integration: IntegrationConfig): SyncResult {
  return {
    chainId: integration.chainId,
    protocol: integration.protocol,
    fetched: 0,
    refreshed: 0,
    upserted: 0,
    transactionsUpserted: 0,
    markedClosed: 0,
    durationMs: 0,
  };
}

function chunkArray<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  const chunkSize = Math.max(1, size);
  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }
  return chunks;
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (values.length === 0) return [];

  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), values.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < values.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        const value = values[currentIndex];
        if (value === undefined) continue;
        results[currentIndex] = await mapper(value, currentIndex);
      }
    }),
  );

  return results;
}

function dedupeByPositionId<T extends { chainId: number; protocol: string; positionId: string }>(values: T[]): T[] {
  const byKey = new Map<string, T>();
  for (const value of values) {
    byKey.set(`${value.chainId}:${value.protocol}:${value.positionId}`, value);
  }
  return [...byKey.values()];
}
