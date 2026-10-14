import {
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { isShuttingDown } from '../common/shutdown.js';
import { can } from '../common/process-role.js';
import { SyncCursor, type SyncCursorDocument } from './schemas/sync-cursor.schema.js';
import { SyncRun, type SyncRunDocument } from './schemas/sync-run.schema.js';

/** One shard's last COMPLETE pool-sync walk (`recordPoolWalk`). */
export interface PoolWalkStats {
  pools: number;
  tvlUsd: number;
  skipped: number;
  finishedAt: Date;
}

/** An open `sync_runs` row is stamped this often while its process lives. */
export const RUN_HEARTBEAT_INTERVAL_MS = 2 * 60_000;
/**
 * A `running` row whose stamp (or, for a row written before heartbeats
 * existed, whose start) is older than this belongs to a dead process.
 */
export const RUN_STALE_MS = 10 * 60_000;
/** The reaper runs on every Nth heartbeat tick (≈ every 10 min) and once shortly after boot. */
const REAP_EVERY_TICKS = 5;
const BOOT_REAP_DELAY_MS = 30_000;
/** How far back the reaper looks (the `{startedAt: 1}` TTL index bounds the scan). */
const REAP_LOOKBACK_MS = 30 * 24 * 60 * 60_000;

/** The run statuses `finishRun` may write. */
export type FinishedRunStatus = 'success' | 'partial' | 'failed' | 'interrupted';

@Injectable()
export class SyncRepository implements OnModuleInit, OnModuleDestroy, BeforeApplicationShutdown {
  private readonly logger = new Logger(SyncRepository.name);
  /**
   * The `sync_runs` rows THIS process opened and has not finished: what the
   * heartbeat stamps and what a shutdown closes as `interrupted`. A row opened
   * by another process is never touched here — only the reaper, after its
   * heartbeat has been quiet for `RUN_STALE_MS`.
   */
  private readonly openRuns = new Set<string>();
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private bootReapTimer?: ReturnType<typeof setTimeout>;
  private ticks = 0;

  constructor(
    @InjectModel(SyncCursor.name) private readonly cursorModel: Model<SyncCursorDocument>,
    @InjectModel(SyncRun.name) private readonly runModel: Model<SyncRunDocument>,
  ) {}

  onModuleInit(): void {
    // P2.1: the run heartbeat / reaper belong to the roles that open runs (all,
    // sync); api / fee / feeder stay idle (design §2.2). Shutdown still closes
    // this process's own open runs in every role (`beforeApplicationShutdown`).
    if (!can('run-reaper')) return;
    this.heartbeatTimer = setInterval(() => void this.heartbeatTick(), RUN_HEARTBEAT_INTERVAL_MS);
    this.heartbeatTimer.unref?.();
    this.bootReapTimer = setTimeout(() => void this.reapQuietly(), BOOT_REAP_DELAY_MS);
    this.bootReapTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.bootReapTimer) clearTimeout(this.bootReapTimer);
    this.heartbeatTimer = undefined;
    this.bootReapTimer = undefined;
  }

  /**
   * After every `onModuleDestroy` (so the queue workers have been told to stop
   * and given their grace) and before Mongoose closes its connection (that is
   * an `onApplicationShutdown` hook): close this process's open runs as
   * `interrupted`. A run that still finishes in the remaining moments
   * overwrites it with its real outcome.
   */
  async beforeApplicationShutdown(): Promise<void> {
    try {
      const closed = await this.closeOpenRuns('interrupted: the process stopped mid-run (deploy or restart)');
      if (closed > 0) this.logger.warn(`Closed ${closed} open sync run(s) as interrupted at shutdown`);
    } catch (err) {
      this.logger.warn(`Could not close open sync runs at shutdown: ${(err as Error)?.message ?? String(err)}`);
    }
  }

  private async heartbeatTick(): Promise<void> {
    this.ticks += 1;
    try {
      await this.beatOpenRuns();
    } catch (err) {
      this.logger.warn(`Sync run heartbeat failed: ${(err as Error)?.message ?? String(err)}`);
    }
    if (this.ticks % REAP_EVERY_TICKS === 0) await this.reapQuietly();
  }

  private async reapQuietly(): Promise<void> {
    try {
      const reaped = await this.reapStaleRuns();
      if (reaped > 0) {
        this.logger.warn(
          `Marked ${reaped} sync run(s) interrupted: still 'running' with no heartbeat for ${RUN_STALE_MS / 60_000} min (their process stopped)`,
        );
      }
    } catch (err) {
      this.logger.warn(`Sync run reaper failed: ${(err as Error)?.message ?? String(err)}`);
    }
  }

  /** Stamps `heartbeatAt` on this process's open runs. Returns how many it stamped. */
  async beatOpenRuns(now: Date = new Date()): Promise<number> {
    const ids = this.openRunIds();
    if (ids.length === 0) return 0;
    const res = await this.runModel.updateMany({ _id: { $in: ids }, status: 'running' }, { $set: { heartbeatAt: now } });
    return res?.modifiedCount ?? 0;
  }

  /**
   * Marks `running` rows whose heartbeat (or, lacking one, whose start) is
   * older than `staleMs` as `interrupted`. Safe against a live run: its next
   * heartbeat keeps it out, and if one were reaped anyway its `finishRun`
   * would overwrite the status with the real outcome.
   */
  async reapStaleRuns(now: Date = new Date(), staleMs: number = RUN_STALE_MS): Promise<number> {
    const cutoff = new Date(now.getTime() - staleMs);
    const res = await this.runModel.updateMany(
      {
        startedAt: { $gte: new Date(now.getTime() - REAP_LOOKBACK_MS), $lt: cutoff },
        status: 'running',
        $or: [{ heartbeatAt: { $lt: cutoff } }, { heartbeatAt: { $exists: false } }],
      },
      {
        $set: {
          status: 'interrupted',
          finishedAt: now,
          error: `interrupted: no heartbeat for ${Math.round(staleMs / 60_000)} min (the process running it stopped)`,
        },
      },
    );
    return res?.modifiedCount ?? 0;
  }

  /** Closes this process's open runs as `interrupted` (shutdown). Returns how many it closed. */
  async closeOpenRuns(error: string, now: Date = new Date()): Promise<number> {
    const ids = this.openRunIds();
    if (ids.length === 0) return 0;
    const res = await this.runModel.updateMany(
      { _id: { $in: ids }, status: 'running' },
      { $set: { status: 'interrupted', finishedAt: now, error } },
    );
    for (const id of ids) this.openRuns.delete(String(id));
    return res?.modifiedCount ?? 0;
  }

  private openRunIds(): Types.ObjectId[] {
    const out: Types.ObjectId[] = [];
    for (const id of this.openRuns) {
      if (Types.ObjectId.isValid(id)) out.push(new Types.ObjectId(id));
    }
    return out;
  }

  async getCursor(chainId: number, protocol: string): Promise<SyncCursor | null> {
    return this.cursorModel.findOne({ chainId, protocol }).lean<SyncCursor | null>();
  }

  async markCursorSuccess(
    chainId: number,
    protocol: string,
    values: { lastTimestamp: number; lastBlockNumber: number; lastPositionId?: string },
  ): Promise<void> {
    await this.cursorModel.updateOne(
      { chainId, protocol },
      {
        $set: {
          ...values,
          lastSuccessAt: new Date(),
          lastError: undefined,
        },
      },
      { upsert: true },
    );
  }

  async markCursorFailure(chainId: number, protocol: string, error: string): Promise<void> {
    // A failure caused by the process stopping (a closed client, an aborted
    // read) is not the cursor's last error — the next process resumes it.
    if (isShuttingDown()) return;
    await this.cursorModel.updateOne(
      { chainId, protocol },
      {
        $set: {
          lastFailureAt: new Date(),
          lastError: error,
        },
      },
      { upsert: true },
    );
  }

  async startRun(chainId: number, protocol: string): Promise<string> {
    const now = new Date();
    const run = await this.runModel.create({
      chainId,
      protocol,
      status: 'running',
      startedAt: now,
      heartbeatAt: now,
    });
    const id = run._id.toString();
    this.openRuns.add(id);
    return id;
  }

  async finishRun(
    runId: string,
    update: {
      status: FinishedRunStatus;
      fetched?: number;
      refreshed?: number;
      upserted?: number;
      transactionsUpserted?: number;
      markedClosed?: number;
      durationMs: number;
      error?: string;
    },
  ): Promise<void> {
    this.openRuns.delete(runId);
    // A run that fails while the process is stopping failed BECAUSE it is
    // stopping (closed client, abandoned job): record that, not a fault.
    const status = update.status === 'failed' && isShuttingDown() ? 'interrupted' : update.status;
    await this.runModel.findByIdAndUpdate(runId, {
      $set: {
        ...update,
        status,
        finishedAt: new Date(),
      },
    });
  }

  /**
   * Mark the (chainId, protocol) backfill as in progress. Consumed by the
   * refresh's stale sweep, which stands down while a backfill inserts rows its
   * walk never saw (see `isBackfillInProgress`). Idempotent — safe to call
   * repeatedly. Stamps the first heartbeat too.
   */
  /**
   * When the last backfill run on this chain STARTED (undefined if none was
   * recorded). Read BEFORE `markBackfillStarted` overwrites it: a `fromStart`
   * request that a run has already started after is served by that run, which
   * is how a job left behind by older code — it carries no reset run key —
   * resumes instead of resetting the cursor of a walk it already began.
   */
  async lastBackfillStartedAt(chainId: number, protocol: string): Promise<Date | undefined> {
    const row = await this.cursorModel
      .findOne({ chainId, protocol })
      .select({ backfillStartedAt: 1 })
      .lean<{ backfillStartedAt?: Date } | null>();
    return row?.backfillStartedAt instanceof Date ? row.backfillStartedAt : undefined;
  }

  async markBackfillStarted(chainId: number, protocol: string): Promise<void> {
    const now = new Date();
    await this.cursorModel.updateOne(
      { chainId, protocol },
      {
        $set: {
          backfillInProgress: true,
          backfillStartedAt: now,
          backfillHeartbeatAt: now,
        },
      },
      { upsert: true },
    );
  }

  /** The running backfill's sign of life (every flush, and a timer while it runs). */
  async touchBackfillHeartbeat(chainId: number, protocol: string): Promise<void> {
    await this.cursorModel.updateOne(
      { chainId, protocol },
      { $set: { backfillHeartbeatAt: new Date() } },
      { upsert: true },
    );
  }

  // ── Backfill pause lever (audit C-pause; SyncService's `SyncBackfillPauseOps`) ──

  /**
   * Pause `(chainId, protocol)`'s backfill: ONE update sets `backfillPausedAt`
   * + `backfillPausedBy`. The filter is the claim (same shape as
   * `resetCursorForRun`): it matches only a cursor that is not paused yet, so a
   * second pause keeps the FIRST one's time and note; with no cursor row the
   * upsert inserts one, and an already-paused row makes the upsert's insert
   * collide on the unique `{chainId, protocol}` index — that E11000 IS the
   * "already paused" answer. Returns the state now stored.
   */
  async pauseBackfill(
    chainId: number,
    protocol: string,
    by: string,
    at: Date = new Date(),
  ): Promise<{ pausedAt: Date; pausedBy: string; alreadyPaused: boolean }> {
    try {
      await this.cursorModel.updateOne(
        { chainId, protocol, backfillPausedAt: { $exists: false } },
        { $set: { backfillPausedAt: at, backfillPausedBy: by } },
        { upsert: true },
      );
      return { pausedAt: at, pausedBy: by, alreadyPaused: false };
    } catch (err) {
      if ((err as { code?: unknown })?.code !== 11000) throw err;
      const state = await this.backfillPauseState(chainId, protocol);
      return { pausedAt: state?.pausedAt ?? at, pausedBy: state?.pausedBy ?? by, alreadyPaused: true };
    }
  }

  /** Lift the pause: ONE `$unset` of both fields. True when it WAS paused. */
  async resumeBackfill(chainId: number, protocol: string): Promise<boolean> {
    const res = await this.cursorModel.updateOne(
      { chainId, protocol, backfillPausedAt: { $exists: true } },
      { $unset: { backfillPausedAt: '', backfillPausedBy: '' } },
    );
    return (res?.modifiedCount ?? 0) > 0;
  }

  /** The pause on `(chainId, protocol)`, or null when it is not paused (no row = not paused). */
  async backfillPauseState(chainId: number, protocol: string): Promise<BackfillPauseState | null> {
    const row = await this.cursorModel
      .findOne({ chainId, protocol })
      .select({ _id: 0, backfillPausedAt: 1, backfillPausedBy: 1, backfillInProgress: 1 })
      .lean<BackfillPauseRow | null>();
    return readPauseState(row);
  }

  /**
   * The running backfill's heartbeat AND its pause check in ONE round trip
   * (the same `$set` as `touchBackfillHeartbeat`, returning the row): this is
   * how a walk learns it was paused — on every flush and every heartbeat tick,
   * with no read added to a backfill nobody pauses.
   */
  async heartbeatBackfillReadPause(chainId: number, protocol: string): Promise<BackfillPauseState | null> {
    const row = await this.cursorModel
      .findOneAndUpdate(
        { chainId, protocol },
        { $set: { backfillHeartbeatAt: new Date() } },
        { upsert: true, returnDocument: 'after' },
      )
      .select({ _id: 0, backfillPausedAt: 1, backfillPausedBy: 1, backfillInProgress: 1 })
      .lean<BackfillPauseRow | null>();
    return readPauseState(row);
  }

  /** Every paused backfill (one small read of `sync_cursors`): `/admin/sync/status` and `sync/run {all}`. */
  async pausedBackfills(): Promise<PausedBackfill[]> {
    const rows = await this.cursorModel
      .find({ backfillPausedAt: { $exists: true } })
      .select({ _id: 0, chainId: 1, protocol: 1, backfillPausedAt: 1, backfillPausedBy: 1, backfillInProgress: 1 })
      .lean<Array<BackfillPauseRow & { chainId: number; protocol: string }>>();
    return pausedBackfillsOf(rows);
  }

  /** Clear the backfill-in-progress flag for this (chainId, protocol). */
  async markBackfillFinished(chainId: number, protocol: string): Promise<void> {
    await this.cursorModel.updateOne(
      { chainId, protocol },
      { $set: { backfillInProgress: false } },
      { upsert: true },
    );
  }

  /**
   * Advance the transaction-sync cursor for `(chainId, protocol)` after a
   * successful flush. Composite cursor uses both timestamp + transactionId so
   * same-timestamp rows don't get skipped between paginated requests.
   */
  async markTxCursorSuccess(
    chainId: number,
    protocol: string,
    values: { txLastTimestamp: number; txLastTransactionId: string },
  ): Promise<void> {
    await this.cursorModel.updateOne(
      { chainId, protocol },
      { $set: values },
      { upsert: true },
    );
  }

  /**
   * Reset the transaction-sync cursor back to the origin. Used by admin
   * `fromStart=true` on the tx endpoint to re-walk the entire subgraph
   * transaction history (catches back-dated rows; upserts existing as no-ops).
   */
  async resetTxCursor(chainId: number, protocol: string): Promise<void> {
    await this.cursorModel.updateOne(
      { chainId, protocol },
      { $set: { txLastTimestamp: 0, txLastTransactionId: '' } },
      { upsert: true },
    );
  }

  /**
   * Reset the cursor for `(chainId, protocol)` back to the origin — ONCE per
   * run. Used by the admin `fromStart=true` backfill to rescan the subgraph
   * from timestamp zero (catches back-dated or missed positions).
   *
   * `runKey` is the BullMQ job id, which a retry (`attempts: 3`) and a stalled
   * re-run keep. The reset used to run on every attempt, so a fromStart walk
   * that failed 20 h into a 21 h Robinhood backfill restarted from 0; now the
   * first attempt claims the reset (`backfillResetRunKey: runKey`, written in
   * the same update) and every later attempt of that job finds its own key,
   * resets nothing and resumes from the cursor its flushes advanced. Returns
   * whether THIS call reset the cursor.
   *
   * The filter is the claim: `$ne` matches a cursor not yet reset for this run.
   * With no cursor row at all the upsert inserts one; when the row exists and
   * already carries the key, the upsert's insert collides with the unique
   * `{chainId, protocol}` index — that E11000 IS the "already reset" answer.
   */
  async resetCursorForRun(chainId: number, protocol: string, runKey: string): Promise<boolean> {
    try {
      const res = await this.cursorModel.updateOne(
        { chainId, protocol, backfillResetRunKey: { $ne: runKey } },
        {
          $set: {
            lastTimestamp: 0,
            lastPositionId: '',
            lastBlockNumber: 0,
            backfillResetRunKey: runKey,
          },
        },
        { upsert: true },
      );
      return res.matchedCount + res.upsertedCount > 0;
    } catch (err) {
      if ((err as { code?: unknown })?.code === 11000) return false;
      throw err;
    }
  }

  /**
   * True when a backfill for (chainId, protocol) is RUNNING: the flag is set
   * AND its heartbeat is at most `BACKFILL_HEARTBEAT_STALE_MS` old. Gates the
   * refresh's stale sweep.
   *
   * The flag alone used to be the answer, and a deploy killing the backfill
   * left it set — suspending the stale sweep until somebody ran another
   * backfill to the end. A flag whose heartbeat has gone quiet is a dead
   * backfill; the worker's boot re-enqueues a resume for it (QueueService).
   */
  async isBackfillInProgress(chainId: number, protocol: string, now: number = Date.now()): Promise<boolean> {
    const row = await this.cursorModel
      .findOne({ chainId, protocol })
      .select({ backfillInProgress: 1, backfillHeartbeatAt: 1, backfillStartedAt: 1 })
      .lean<BackfillFlagState | null>();
    return backfillLooksAlive(row, now);
  }

  async markLiveCursor(
    chainId: number,
    protocol: string,
    liveBlockNumber: number,
    liveBlockTimestamp: number,
  ): Promise<void> {
    await this.cursorModel.updateOne(
      { chainId, protocol },
      {
        $set: {
          liveBlockNumber,
          liveBlockTimestamp,
          liveLastPollAt: new Date(),
        },
      },
      { upsert: true },
    );
  }

  /**
   * Record a COMPLETE pool-sync walk of `(chainId, protocol)`: the pools it saw
   * and their summed trusted TVL (`/v1/stats` reads these instead of counting
   * and summing the pools collection).
   */
  async recordPoolWalk(
    chainId: number,
    protocol: string,
    walk: { pools: number; tvlUsd: number; skipped: number; finishedAt?: Date },
  ): Promise<void> {
    await this.cursorModel.updateOne(
      { chainId, protocol },
      {
        $set: {
          poolWalkPools: walk.pools,
          poolWalkTvlUsd: walk.tvlUsd,
          poolWalkSkipped: walk.skipped,
          poolWalkFinishedAt: walk.finishedAt ?? new Date(),
        },
      },
      { upsert: true },
    );
  }

  /** The last complete pool walk per `chainId:protocol` (shards with none recorded are absent). */
  async poolWalkStats(): Promise<Map<string, PoolWalkStats>> {
    const rows = await this.cursorModel
      .find({ poolWalkFinishedAt: { $exists: true } })
      .select({ _id: 0, chainId: 1, protocol: 1, poolWalkPools: 1, poolWalkTvlUsd: 1, poolWalkSkipped: 1, poolWalkFinishedAt: 1 })
      .lean<Array<Pick<SyncCursor, 'chainId' | 'protocol' | 'poolWalkPools' | 'poolWalkTvlUsd' | 'poolWalkSkipped' | 'poolWalkFinishedAt'>>>();
    const out = new Map<string, PoolWalkStats>();
    for (const row of rows) {
      const pools = Number(row.poolWalkPools);
      const tvlUsd = Number(row.poolWalkTvlUsd);
      if (!Number.isFinite(pools) || !Number.isFinite(tvlUsd) || !(row.poolWalkFinishedAt instanceof Date)) continue;
      out.set(`${row.chainId}:${row.protocol}`, {
        pools,
        tvlUsd,
        skipped: Number(row.poolWalkSkipped) || 0,
        finishedAt: row.poolWalkFinishedAt,
      });
    }
    return out;
  }

  async status(): Promise<{ cursors: SyncCursor[]; latestRuns: SyncRun[] }> {
    const [cursors, latestRuns] = await Promise.all([
      this.cursorModel.find({}).sort({ chainId: 1, protocol: 1 }).lean<SyncCursor[]>(),
      this.runModel.find({}).sort({ startedAt: -1 }).limit(20).lean<SyncRun[]>(),
    ]);
    return { cursors, latestRuns };
  }

  /** Both on-chain fee tier cursors for `(chainId, protocol)`; absent reads as a never-run tier. */
  async getFeeCursors(chainId: number, protocol: string): Promise<Record<FeeTier, FeeTierCursor>> {
    const row = await this.cursorModel
      .findOne({ chainId, protocol })
      .select(FEE_CURSOR_PROJECTION)
      .lean<Record<string, unknown> | null>();
    const read = (tier: FeeTier): FeeTierCursor => {
      const f = FEE_CURSOR_FIELDS[tier];
      const cursor = row?.[f.cursor];
      const startedAt = row?.[f.startedAt];
      const finishedAt = row?.[f.finishedAt];
      const tally = row?.[f.tally];
      return {
        cursor: typeof cursor === 'string' ? cursor : '',
        startedAt: startedAt instanceof Date ? startedAt : undefined,
        finishedAt: finishedAt instanceof Date ? finishedAt : undefined,
        tally: tally && typeof tally === 'object' ? readFeePassTally(tally as Record<string, unknown>) : undefined,
      };
    };
    return { hot: read('hot'), all: read('all') };
  }

  /**
   * Persist one fee tier's cursor; called after every page so a restart resumes.
   * `tally` adds the page's counts to the pass's persisted tally — `set` (the
   * pass's first page) replaces it, `inc` adds to it. One update either way, so
   * the cursor and the counts that describe it never land apart.
   */
  async saveFeeCursor(
    chainId: number,
    protocol: string,
    tier: FeeTier,
    value: FeeTierCursor,
    tally?: { mode: 'set' | 'inc'; counts: FeePassTally },
    fence?: number,
  ): Promise<boolean> {
    const f = FEE_CURSOR_FIELDS[tier];
    const set: Record<string, unknown> = { [f.cursor]: value.cursor };
    const inc: Record<string, number> = {};
    if (value.startedAt) set[f.startedAt] = value.startedAt;
    if (value.finishedAt) set[f.finishedAt] = value.finishedAt;
    if (tally) {
      for (const k of FEE_PASS_TALLY_KEYS) {
        const n = finiteCount(tally.counts[k]);
        if (tally.mode === 'set') set[`${f.tally}.${k}`] = n;
        else if (n !== 0) inc[`${f.tally}.${k}`] = n;
      }
    }
    const update: Record<string, unknown> = { $set: set };
    if (Object.keys(inc).length > 0) update.$inc = inc;
    if (fence === undefined || !Number.isFinite(fence)) {
      // Leases off (today) or the lease runner's fail-open local mode: unfenced.
      await this.cursorModel.updateOne({ chainId, protocol }, update, { upsert: true });
      return true;
    }
    // P3 (design §9.5): FENCED. Only a holder whose fence is ≥ the stored one
    // writes, and it raises the stored fence to its own. A deposed holder's
    // filter matches nothing, so its upsert tries an INSERT and loses on the
    // unique {chainId, protocol} index (E11000): that is the refusal.
    set.feeFence = fence;
    try {
      await this.cursorModel.updateOne(
        { chainId, protocol, $or: [{ feeFence: { $exists: false } }, { feeFence: { $lte: fence } }] },
        update,
        { upsert: true },
      );
      return true;
    } catch (err) {
      if ((err as { code?: number })?.code === 11000) return false;
      throw err;
    }
  }

  // ── P2.5 tokenId range walk (SyncService's `SyncTokenIdCursorOps`) ──

  /** Start (or restart) a tokenId run: paging, cursor and run start in ONE update (a resume never sees a cursor without its start). */
  async saveBackfillTokenIdState(
    chainId: number,
    protocol: string,
    state: { tokenIdCursor: string; runStartTs: number },
  ): Promise<void> {
    await this.cursorModel.updateOne(
      { chainId, protocol },
      {
        $set: {
          backfillPaging: 'tokenid',
          backfillTokenIdCursor: String(state.tokenIdCursor),
          backfillRunStartTs: Math.floor(state.runStartTs),
        },
      },
      { upsert: true },
    );
  }

  /** Advance the contiguous cursor (after each written range). */
  async saveBackfillTokenIdCursor(chainId: number, protocol: string, tokenIdCursor: string): Promise<void> {
    await this.cursorModel.updateOne({ chainId, protocol }, { $set: { backfillTokenIdCursor: String(tokenIdCursor) } }, { upsert: true });
  }

  /** The run finished (or its state is unusable): `$unset` all three; the createdAt cursor is authoritative again. */
  async clearBackfillTokenIdState(chainId: number, protocol: string): Promise<void> {
    await this.cursorModel.updateOne(
      { chainId, protocol },
      { $unset: { backfillPaging: '', backfillTokenIdCursor: '', backfillRunStartTs: '' } },
    );
  }

  // ── P2.3 read overlay: lastCleanRefreshAt (SyncService's `SyncCleanRefreshOps`) ──

  private readonly cleanRefreshCache = new Map<string, { at: Date | undefined; readAt: number }>();

  /** Record the START of a refresh whose stale sweep ran (SyncService). */
  async setLastCleanRefreshAt(chainId: number, protocol: string, at: Date): Promise<void> {
    await this.cursorModel.updateOne({ chainId, protocol }, { $set: { lastCleanRefreshAt: at } }, { upsert: true });
    this.cleanRefreshCache.set(`${chainId}:${protocol}`, { at, readAt: Date.now() });
  }

  /**
   * The last clean refresh's start for the read overlay, cached
   * `LAST_CLEAN_REFRESH_CACHE_MS` per shard (one tiny read per shard per 30 s
   * on the serving path). A failed read answers the cached value, else
   * undefined (the overlay then leaves the stored clocks alone).
   */
  async lastCleanRefreshAt(chainId: number, protocol: string, now: number = Date.now()): Promise<Date | undefined> {
    const key = `${chainId}:${protocol}`;
    const hit = this.cleanRefreshCache.get(key);
    if (hit && now - hit.readAt < LAST_CLEAN_REFRESH_CACHE_MS) return hit.at;
    try {
      const row = await this.cursorModel
        .findOne({ chainId, protocol })
        .select({ _id: 0, lastCleanRefreshAt: 1 })
        .lean<{ lastCleanRefreshAt?: Date } | null>();
      const at = row?.lastCleanRefreshAt instanceof Date ? row.lastCleanRefreshAt : undefined;
      this.cleanRefreshCache.set(key, { at, readAt: now });
      return at;
    } catch {
      return hit?.at;
    }
  }

  // ── P2.4 refresh-overdue watch: lastRefreshOkAt (SyncService's `SyncRefreshOkOps`) ──

  /** Record the END of a refresh with no failed chunk (SyncService, write budget on only). */
  async setLastRefreshOkAt(chainId: number, protocol: string, at: Date): Promise<void> {
    await this.cursorModel.updateOne({ chainId, protocol }, { $set: { lastRefreshOkAt: at } }, { upsert: true });
  }

  /**
   * `chainId:protocol` → `lastRefreshOkAt`, every shard in ONE read
   * (`sync_cursors` holds one small row per shard). Throws on a failed read —
   * the caller then gives no verdict rather than a false alarm.
   */
  async lastRefreshOkTimes(): Promise<Map<string, Date>> {
    const rows = await this.cursorModel
      .find({ lastRefreshOkAt: { $exists: true } })
      .select({ _id: 0, chainId: 1, protocol: 1, lastRefreshOkAt: 1 })
      .lean<Array<{ chainId: number; protocol: string; lastRefreshOkAt?: Date }>>();
    const out = new Map<string, Date>();
    for (const row of rows) {
      if (row.lastRefreshOkAt instanceof Date) out.set(`${row.chainId}:${row.protocol}`, row.lastRefreshOkAt);
    }
    return out;
  }
}

/** How long `lastCleanRefreshAt` is cached per shard on the serving path. */
export const LAST_CLEAN_REFRESH_CACHE_MS = 30_000;

/**
 * A backfill whose last heartbeat is older than this is treated as dead. Its
 * heartbeat comes on every flush (~3.5 min at 47 pos/s and 10k rows) and every
 * `BACKFILL_HEARTBEAT_INTERVAL_MS` from a timer, so a live one is never close.
 */
export const BACKFILL_HEARTBEAT_STALE_MS = 10 * 60_000;

export interface BackfillFlagState {
  backfillInProgress?: boolean;
  backfillHeartbeatAt?: Date;
  backfillStartedAt?: Date;
}

/**
 * Flag set AND a heartbeat within `BACKFILL_HEARTBEAT_STALE_MS`. A flag
 * written by a build that predates the heartbeat falls back to
 * `backfillStartedAt`; with neither, it is stale.
 */
export function backfillLooksAlive(row: BackfillFlagState | null | undefined, now: number = Date.now()): boolean {
  if (row?.backfillInProgress !== true) return false;
  const beat = row.backfillHeartbeatAt ?? row.backfillStartedAt;
  if (!(beat instanceof Date) || !Number.isFinite(beat.getTime())) return false;
  return now - beat.getTime() <= BACKFILL_HEARTBEAT_STALE_MS;
}

/** A paused backfill (`sync_cursors.backfillPausedAt` set). */
export interface BackfillPauseState {
  pausedAt: Date;
  pausedBy: string;
  /** The backfill flag at read time: true = a walk was interrupted (or is stopping) and `/resume` re-enqueues it. */
  inProgress: boolean;
}

export interface PausedBackfill extends BackfillPauseState {
  chainId: number;
  protocol: string;
}

interface BackfillPauseRow {
  backfillPausedAt?: unknown;
  backfillPausedBy?: unknown;
  backfillInProgress?: unknown;
}

/** A row's pause, or null: only a real `Date` in `backfillPausedAt` is a pause. */
export function readPauseState(row: BackfillPauseRow | null | undefined): BackfillPauseState | null {
  const at = row?.backfillPausedAt;
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) return null;
  return {
    pausedAt: at,
    pausedBy: typeof row?.backfillPausedBy === 'string' && row.backfillPausedBy ? row.backfillPausedBy : 'admin',
    inProgress: row?.backfillInProgress === true,
  };
}

/** The paused rows of a `sync_cursors` read (status, `sync/run {all}`), ordered by chain then protocol. */
export function pausedBackfillsOf(rows: ReadonlyArray<unknown>): PausedBackfill[] {
  const out: PausedBackfill[] = [];
  for (const raw of rows) {
    const row = (raw ?? {}) as BackfillPauseRow & { chainId?: unknown; protocol?: unknown };
    const state = readPauseState(row);
    if (!state || typeof row.chainId !== 'number' || typeof row.protocol !== 'string') continue;
    out.push({ chainId: row.chainId, protocol: row.protocol, ...state });
  }
  return out.sort((a, b) => a.chainId - b.chainId || (a.protocol < b.protocol ? -1 : a.protocol > b.protocol ? 1 : 0));
}

/** The on-chain fee refresh's resumable tiers (the dirty set is in-memory). */
export type FeeTier = 'hot' | 'all';

/**
 * One tier pass's counts. `failed` is a per-call revert the split retries could
 * not answer; `unanswered` a row whose batch the RPC never answered at all
 * (transport, rate limit, timeout); `unreadable` a row whose stored inputs can
 * never be read (bad poolId, ticks or decimals) — kept apart so a pass that
 * merely holds a few broken rows does not raise a failure alert every time.
 */
export interface FeePassTally {
  scanned: number;
  measured: number;
  written: number;
  served: number;
  stale: number;
  unchanged: number;
  failed: number;
  unanswered: number;
  unreadable: number;
}

export const FEE_PASS_TALLY_KEYS = [
  'scanned',
  'measured',
  'written',
  'served',
  'stale',
  'unchanged',
  'failed',
  'unanswered',
  'unreadable',
] as const satisfies ReadonlyArray<keyof FeePassTally>;

export function emptyFeePassTally(): FeePassTally {
  return Object.fromEntries(FEE_PASS_TALLY_KEYS.map((k) => [k, 0])) as unknown as FeePassTally;
}

function finiteCount(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** A stored tally, with any missing or non-numeric counter read as 0. */
function readFeePassTally(raw: Record<string, unknown>): FeePassTally {
  const out = emptyFeePassTally();
  for (const k of FEE_PASS_TALLY_KEYS) out[k] = finiteCount(raw[k]);
  return out;
}

export interface FeeTierCursor {
  /** Last tokenId the current pass measured; '' = from the start. */
  cursor: string;
  startedAt?: Date;
  finishedAt?: Date;
  /** The pass's persisted running counts (absent before the first page of the first pass). */
  tally?: FeePassTally;
}

const FEE_CURSOR_FIELDS: Record<FeeTier, { cursor: string; startedAt: string; finishedAt: string; tally: string }> = {
  hot: { cursor: 'feeCursorHot', startedAt: 'feeHotStartedAt', finishedAt: 'feeHotFinishedAt', tally: 'feeHotTally' },
  all: { cursor: 'feeCursorAll', startedAt: 'feeAllStartedAt', finishedAt: 'feeAllFinishedAt', tally: 'feeAllTally' },
};

const FEE_CURSOR_PROJECTION: Record<string, 0 | 1> = {
  _id: 0,
  ...Object.fromEntries(
    Object.values(FEE_CURSOR_FIELDS).flatMap((f) =>
      [f.cursor, f.startedAt, f.finishedAt, f.tally].map((p) => [p, 1 as const]),
    ),
  ),
};
