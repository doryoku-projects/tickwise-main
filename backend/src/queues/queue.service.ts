import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { DelayedError, Job, Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { AppConfigService } from '../config/app-config.service.js';
import { LiveEventListenerService } from '../sync/live-event-listener.service.js';
import { PoolsSyncService } from '../sync/pools-sync.service.js';
import { PositionLiveRefreshService } from '../sync/position-live-refresh.service.js';
import { SyncService } from '../sync/sync.service.js';
import { TokenSecuritySyncService } from '../sync/token-security-sync.service.js';
import { TokenPriceSyncService } from '../sync/token-price-sync.service.js';
import { PositionFeeRefreshService } from '../sync/position-fee-refresh.service.js';
import { laneForJob, runInLane } from '../subgraph/hyperindex/indexer-context.js';
import { beginShutdown, closeWithin, isInterrupted, raceShutdown } from '../common/shutdown.js';
import { runInWriteLane, type WriteLane } from '../common/write-lane.js';
import { refreshQueueConcurrency, type WriteBudgetMode } from '../common/write-budget-model.js';
import { CoordinationRedis } from '../common/coordination-redis.js';
import { LeaseRunner, type LeaseWorkContext } from '../common/lease-runner.js';
import { can, currentProcessRole, leasesEnabled } from '../common/process-role.js';
import { sampleRedisMemory } from '../common/process-status.js';

/**
 * BullMQ job name → write lane of the shared write budget (P2.4,
 * `write-lane.ts`): backfill → `backfill`, refresh → `refresh`, live-refresh →
 * `live`, pool-sync → `pools`, the fee poke → `fee`, the admin aggregate
 * healer (`recompute-aggregates`) → `backfill`, everything else (token sweeps,
 * unknown names) → `other`. The healer rewrites a whole shard at a full-update
 * unit per row — a bulk rewrite like a backfill, visible to the same cap and
 * oplog rule; on `other` (5 %) it would run for a day under `enforce` and
 * starve every other `other` write meanwhile. Without this every
 * position write was charged to `other`, so the backfill cap and the 3 h
 * `oplog_backfill` rule never saw a backfill unit and the lanes' guaranteed
 * shares protected nothing.
 */
export function writeLaneForJob(name: string): WriteLane {
  switch (name) {
    case 'backfill':
    case 'recompute-aggregates':
      return 'backfill';
    case 'refresh':
      return 'refresh';
    case 'live-refresh':
      return 'live';
    case 'pool-sync':
      return 'pools';
    case 'position-fee-refresh':
      return 'fee';
    default:
      return 'other';
  }
}

/**
 * Runs a BullMQ processor inside its indexer lane (`laneForJob`): backfill and
 * refresh → `refresh`, live-refresh → `live`, everything else → `sweep`. Every
 * indexer request the job makes is metered — and, when the gateway enforces,
 * prioritised — under that lane and the job's name. Every Mongo write it sends
 * is charged to its write lane (`writeLaneForJob`).
 */
export function inJobLane<D extends { chainId?: number }, R>(
  processor: (job: Job<D>, token?: string) => Promise<R>,
): (job: Job<D>, token?: string) => Promise<R> {
  // The lock token is forwarded (P2.1): a backfill held elsewhere re-delays
  // itself with `job.moveToDelayed(ts, token)`, which needs it.
  return (job, token) =>
    runInLane({ lane: laneForJob(job.name), job: job.name, chainId: job.data?.chainId }, () =>
      runInWriteLane(writeLaneForJob(job.name), () => processor(job, token)),
    );
}

/**
 * P2.1 — the scheduler lease (design §2.3): repeatables, `QUEUE_CLEAR_ON_BOOT`,
 * boot kicks, the backfill resume, BullMQ global concurrency and the
 * redis-state memory sample run ONCE fleet-wide, in whichever `all`/`sync`
 * process holds it. Only with leases on; with leases off (`all` + `auto`, the
 * default) every step runs inline in `onModuleInit` exactly as before.
 */
export const SCHEDULER_LEASE = 'scheduler';
export const SCHEDULER_LEASE_TTL_MS = 30_000;
export const SCHEDULER_LEASE_RENEW_MS = 10_000;
/** How often the scheduler holder samples redis-state `INFO memory` (design §3.6). */
export const REDIS_MEMORY_SAMPLE_MS = 60_000;

/** A backfill held elsewhere is re-delayed by 60 s ± 10 s (design §2.1). */
export const BACKFILL_HELD_REDELAY_MS = 60_000;
export const BACKFILL_HELD_JITTER_MS = 10_000;
/** `BACKFILL_HELD_MAX_WAIT_MS` default: 45 min ≫ the 60 s flow-lock TTL. */
export const BACKFILL_HELD_MAX_WAIT_DEFAULT_MS = 2_700_000;

/**
 * `POSITIONS_REFRESH_QUEUE_CONCURRENCY` (design §12): > 1 ONLY under
 * `WRITE_BUDGET_MODE=enforce` — without the budget pacing their writes, two
 * refreshes at once are the 2.5–4k updates/s that took the M10 to 95 % CPU.
 * Anything else (unset, garbage, < 1, budget off/observe) = 1 = today.
 */
export function resolveRefreshQueueConcurrency(configured: unknown, writeBudgetMode: unknown): number {
  // ONE clamp (integrator, I1): the write-budget model's rule, capped at 64.
  const mode: WriteBudgetMode = writeBudgetMode === 'enforce' || writeBudgetMode === 'observe' ? writeBudgetMode : 'off';
  return Math.min(64, refreshQueueConcurrency(Number(configured), mode).value);
}

/** Re-delay (ms from now) for a backfill whose flow lock is held elsewhere; undefined = give up (waited too long). */
export function heldBackfillRedelayMs(
  jobCreatedAt: number | undefined,
  now: number,
  maxWaitMs: number,
  random: () => number = Math.random,
): number | undefined {
  const waited = now - (typeof jobCreatedAt === 'number' && Number.isFinite(jobCreatedAt) ? jobCreatedAt : now);
  if (waited >= maxWaitMs) return undefined;
  return BACKFILL_HELD_REDELAY_MS + Math.round((random() * 2 - 1) * BACKFILL_HELD_JITTER_MS);
}

/** The structural config view read for P2.1 (getters added by the integrator; absent = today). */
interface QueueRoleConfigView {
  positionsRefreshQueueConcurrency?: number;
  backfillHeldMaxWaitMs?: number;
  writeBudget?: { mode?: string };
}

export const POSITIONS_SYNC_QUEUE = 'positions-sync';
/**
 * How long a shutdown waits for each worker's jobs in flight. The long jobs
 * return at once (`raceShutdown`), so this is for the short ones (a live
 * refresh, a pool page). Docker gives 10 s; Railway gives
 * RAILWAY_DEPLOYMENT_DRAINING_SECONDS (0 unless set — then none of this runs).
 */
export const WORKER_CLOSE_GRACE_MS = 8_000;

/** Who re-starts a job a shutdown interrupted (for the log line). */
function restartedBy(name: string): string {
  if (name === 'backfill') return 'the next boot resumes it from its cursor (resumeInterruptedBackfills)';
  if (name === 'refresh') return "the chain's next refresh slot re-runs it";
  return 'the next boot kick or cron re-runs it';
}
export const POSITION_LIVE_REFRESH_QUEUE = 'position-live-refresh';
export const BACKGROUND_SWEEPS_QUEUE = 'background-sweeps';
/**
 * The cron `refresh` (2026-10-03), alone, at concurrency 1. It shared
 * positions-sync's 10 slots with backfill, every chain's repeat fired on the
 * same epoch multiple, and four refreshes ran at once: 2.5–4k position
 * updates/s and 95% primary CPU on the M10. Now chains refresh one at a time,
 * each starting at its own minute (`refreshRepeats`).
 */
export const POSITIONS_REFRESH_QUEUE = 'positions-refresh';

/**
 * Jobs that ride `background-sweeps` instead of `positions-sync`. They are long
 * (a 4663 pool walk outlasts its hourly tick; a token-security sweep is most of
 * an hour) and used to share positions-sync's 10 slots with refresh and
 * backfill — up to 20 long jobs competing, so refresh and admin backfills sat in
 * `waiting` behind them. positions-sync now carries only `backfill` (and the
 * admin `recompute-aggregates` healer); `refresh` rides `positions-refresh`.
 */
export const SWEEP_JOB_NAMES = [
  'pool-sync',
  'token-security-sync',
  'token-price-sync',
  'position-fee-refresh',
] as const;
export type SweepJobName = (typeof SWEEP_JOB_NAMES)[number];

/**
 * Enabled integrations the on-chain fee job CANNOT measure (no `EVM_RPC_URLS`
 * entry for their chain). Since 2026-10-05 that job is the only source of
 * uncollected fees, so every chain returned here serves `unmeasured` for every open
 * position. `feeRefreshChains` is its complement, so the two can never disagree.
 */
export function feeRefreshUncovered<I extends { chainId: number }>(
  integrations: readonly I[],
  rpcUrls: ReadonlyMap<number, string>,
): I[] {
  return integrations.filter((i) => !rpcUrls.has(i.chainId));
}

/** The queue a job name is produced onto (and so the worker that runs it). */
export function queueNameForJob(name: string): string {
  if ((SWEEP_JOB_NAMES as readonly string[]).includes(name)) return BACKGROUND_SWEEPS_QUEUE;
  if (name === 'refresh') return POSITIONS_REFRESH_QUEUE;
  return POSITIONS_SYNC_QUEUE;
}

const POSITIONS_QUEUE_CONCURRENCY = 10;
const SWEEPS_QUEUE_CONCURRENCY = 8;
// One refresh at a time across every chain (the refresh's writes are the M10's
// largest burst): `resolveRefreshQueueConcurrency` returns 1 unless
// POSITIONS_REFRESH_QUEUE_CONCURRENCY > 1 AND WRITE_BUDGET_MODE=enforce (P2.1).
const LIVE_REFRESH_PRIORITY = 1;

/** Boot kicks for chain i are delayed i × this, so a deploy does not start every chain at once. */
export const BOOT_KICK_STAGGER_MS = 2 * 60_000;
/** First minute of a chain's slot; chains are spread evenly across one interval from here. */
const STAGGER_BASE_MINUTE = 5;
/** The refresh's slots start at :00 — the sweeps' base (:05) is theirs. */
const REFRESH_STAGGER_BASE_MINUTE = 0;

/** A sweep's repeat: a per-chain cron when the interval allows one, else plain `every`. */
export type SweepRepeat = { pattern: string; tz: 'UTC' } | { every: number };

/** Whether cron can express `intervalMs` exactly, and in which shape. */
function cronShape(intervalMs: number): { minutes: number; hours: number; subHourly: boolean } | null {
  const minutes = intervalMs / 60_000;
  const hours = minutes / 60;
  const subHourly = Number.isInteger(minutes) && minutes >= 1 && minutes < 60 && 60 % minutes === 0;
  const multiHourly = Number.isInteger(hours) && hours >= 1 && 24 % hours === 0;
  return subHourly || multiHourly ? { minutes, hours, subHourly } : null;
}

/** The UTC cron for an interval cron can express, starting `offset` minutes into each interval. */
function repeatAtOffset(intervalMs: number, offset: number): SweepRepeat {
  const shape = cronShape(intervalMs);
  if (!shape) return { every: intervalMs };
  const { minutes, hours, subHourly } = shape;
  if (subHourly) {
    const marks: number[] = [];
    for (let m = offset; m < 60; m += minutes) marks.push(m);
    return { pattern: `${marks.join(',')} * * * *`, tz: 'UTC' };
  }
  const minute = offset % 60;
  const firstHour = Math.floor(offset / 60);
  const marks: number[] = [];
  for (let h = firstHour; h < 24; h += hours) marks.push(h);
  return { pattern: `${minute} ${hours === 1 ? '*' : marks.join(',')} * * *`, tz: 'UTC' };
}

/**
 * Per-chain staggered schedule for a sweep that repeats every `intervalMs`.
 *
 * `repeat: { every }` fires at epoch multiples of the interval, so every chain
 * ran at :00 together — the 4-chain burst that, with all walks in flight at
 * once, put the background indexer load at ~120–320 req/min. Instead chain
 * `index` of `count` gets its own offset, `baseMinute` (default
 * `STAGGER_BASE_MINUTE`, :05) plus an even share of the interval: hourly with 4
 * chains → :05 / :20 / :35 / :50; every 6h → 1.5h apart; every 5 min → one
 * minute apart.
 *
 * Only intervals cron can express exactly qualify — a whole number of minutes
 * dividing an hour, or of hours dividing a day. Anything else (7 min, 90 min)
 * keeps `every`, unstaggered, rather than silently running at a different rate
 * than configured.
 */
export function staggeredRepeat(
  intervalMs: number,
  index: number,
  count: number,
  baseMinute: number = STAGGER_BASE_MINUTE,
): SweepRepeat {
  const shape = cronShape(intervalMs);
  if (!shape) return { every: intervalMs };
  const offset = (baseMinute + Math.floor((index * shape.minutes) / Math.max(1, count))) % shape.minutes;
  return repeatAtOffset(intervalMs, offset);
}

/** Minutes past the hour a repeat starts at (an `every` repeat has none to name). */
export function repeatMinutes(repeat: SweepRepeat): number[] {
  if (!('pattern' in repeat)) return [];
  return repeat.pattern.split(' ')[0]!.split(',').map(Number);
}

/**
 * The refresh's per-chain schedule (2026-10-03): chain `i` of `count` (in
 * `enabledIntegrations` order) starts at an even share of the interval from
 * :00 — every 30 min with four chains, :00/:30, :07/:37, :15/:45, :22/:52 —
 * then moves forward to the first minute that no other chain's refresh and no
 * sweep (`reservedMinutes`: the minutes the registered sweep crons start at)
 * already starts at. When no such minute exists (a 5-min token-price sweep on
 * four chains claims 48 of every 60), it settles for a minute no other refresh
 * holds, then for the even share itself. Derived from the enabled integrations
 * and the sweep schedule, so a chain added or a sweep interval changed moves
 * the map with it. With the defaults (sweeps at :05/:35 and :05/:20/:35/:50,
 * token-price on minutes 0–3 of every five) it lands on :04/:34, :09/:39,
 * :19/:49, :24/:54.
 *
 * Concurrency 1 on `positions-refresh` is what guarantees two chains never
 * refresh at once; the slots decide when each one may start. An interval cron
 * cannot express keeps `every` for every chain (still serialised).
 */
export function refreshRepeats(intervalMs: number, count: number, reservedMinutes: ReadonlySet<number>): SweepRepeat[] {
  const shape = cronShape(intervalMs);
  if (!shape) return Array.from({ length: count }, () => ({ every: intervalMs }));
  const { minutes } = shape;
  const taken = new Set<number>();
  const out: SweepRepeat[] = [];
  for (let i = 0; i < count; i++) {
    const target = (REFRESH_STAGGER_BASE_MINUTE + Math.floor((i * minutes) / Math.max(1, count))) % minutes;
    const firstFree = (busy: (minute: number) => boolean): number | undefined => {
      for (let k = 0; k < minutes; k++) {
        const offset = (target + k) % minutes;
        if (!repeatMinutes(repeatAtOffset(intervalMs, offset)).some(busy)) return offset;
      }
      return undefined;
    };
    const offset =
      firstFree((m) => taken.has(m) || reservedMinutes.has(m)) ?? firstFree((m) => taken.has(m)) ?? target;
    const repeat = repeatAtOffset(intervalMs, offset);
    for (const m of repeatMinutes(repeat)) taken.add(m);
    out.push(repeat);
  }
  return out;
}

function describeRepeat(repeat: SweepRepeat): string {
  return 'pattern' in repeat ? `cron="${repeat.pattern}" (UTC)` : `every=${repeat.every}ms (unstaggered)`;
}

interface SyncJobData {
  chainId: number;
  protocol: string;
  /**
   * Distinguishes admin-triggered full rescan from a normal resume backfill.
   * Only consumed when the job name is 'backfill'.
   */
  fromStart?: boolean;
}

interface LiveRefreshJobData extends SyncJobData {
  tokenId: string;
  blockNumber: number;
}

interface EnqueueOptions {
  /** Delay before the job becomes runnable. */
  delayMs?: number;
  /**
   * A BOOT kick: de-duplicated per (job, chain) while one is still pending, so
   * a restart that keeps the queue (`QUEUE_CLEAR_ON_BOOT=false`, the default)
   * never stacks a second walk behind the previous boot's. Admin triggers are
   * never de-duplicated — an operator's "sync now" must not be swallowed.
   */
  bootKick?: boolean;
}

interface EnqueueAllOptions {
  /** Chain i (in `enabledIntegrations` order) is delayed i × staggerMs. */
  staggerMs?: number;
  /** See `EnqueueOptions.bootKick`. */
  bootKick?: boolean;
}

@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueService.name);
  private readonly connection: Redis;
  private readonly queue: Queue<SyncJobData>;
  private readonly liveRefreshQueue: Queue<LiveRefreshJobData>;
  private readonly sweepsQueue: Queue<SyncJobData>;
  private readonly refreshQueue: Queue<SyncJobData>;
  private worker?: Worker<SyncJobData>;
  private liveRefreshWorker?: Worker<LiveRefreshJobData>;
  private sweepsWorker?: Worker<SyncJobData>;
  private refreshWorker?: Worker<SyncJobData>;
  /**
   * Ref-count of in-flight backfill jobs across all (chainId, protocol) pairs.
   * Used to pause/resume the live-refresh queue so a manual admin backfill
   * always wins over background live refreshes. Multiple parallel backfills
   * keep the queue paused until the last one finishes.
   */
  private activeBackfills = 0;
  /** P2.1: the `scheduler` lease (leases on only). */
  private schedulerRunner?: LeaseRunner;
  private coordinationClient?: CoordinationRedis;
  /**
   * Leases on: `QUEUE_CLEAR_ON_BOOT` and the boot kicks are ONCE PER PROCESS,
   * not once per scheduler acquisition. A handover, a re-acquire after a lost
   * lease or a fail-open local session must never force-obliterate queues
   * whose jobs (a running backfill) are active in this or another process,
   * nor re-kick every full walk after each Redis blip.
   */
  private bootClearDone = false;
  private bootKicksDone = false;

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(SyncService) private readonly syncService: SyncService,
    @Inject(LiveEventListenerService) private readonly liveListener: LiveEventListenerService,
    @Inject(PositionLiveRefreshService) private readonly liveRefreshService: PositionLiveRefreshService,
    @Inject(PoolsSyncService) private readonly poolsSyncService: PoolsSyncService,
    @Inject(TokenSecuritySyncService) private readonly tokenSecuritySyncService: TokenSecuritySyncService,
    @Inject(TokenPriceSyncService) private readonly tokenPriceSyncService: TokenPriceSyncService,
    // Appended and @Optional: specs construct this service positionally.
    @Optional() @Inject(PositionFeeRefreshService) private readonly positionFeeRefresh?: PositionFeeRefreshService,
    // P2.1, appended and @Optional: the coordination client for the scheduler
    // lease. Absent (specs, or unbound) → a local one on REDIS_URL, lazily
    // connected and used only with leases on.
    @Optional() @Inject(CoordinationRedis) private readonly coordination?: CoordinationRedis,
  ) {
    this.connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
    this.connection.on('error', (error) => {
      this.logger.error(`Redis connection error: ${error.message}`);
    });
    this.queue = new Queue<SyncJobData>(POSITIONS_SYNC_QUEUE, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
      },
    });
    this.liveRefreshQueue = new Queue<LiveRefreshJobData>(POSITION_LIVE_REFRESH_QUEUE, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 500 },
      },
    });
    // Same retry/retention as positions-sync: these jobs used to live there.
    this.sweepsQueue = new Queue<SyncJobData>(BACKGROUND_SWEEPS_QUEUE, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
      },
    });
    // Created LAST so the other three keep their construction order (specs
    // index queues positionally). Same options: `refresh` lived on positions-sync.
    this.refreshQueue = new Queue<SyncJobData>(POSITIONS_REFRESH_QUEUE, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
      },
    });
  }

  /** `POSITIONS_REFRESH_QUEUE_CONCURRENCY`, honoured only under `WRITE_BUDGET_MODE=enforce` (else 1 = today). */
  get refreshConcurrency(): number {
    const view = this.config as unknown as QueueRoleConfigView;
    const value = resolveRefreshQueueConcurrency(view.positionsRefreshQueueConcurrency, view.writeBudget?.mode);
    const requested = Math.floor(Number(view.positionsRefreshQueueConcurrency));
    if (Number.isFinite(requested) && requested > value && !this.refreshClampWarned) {
      this.refreshClampWarned = true;
      this.logger.warn(
        `POSITIONS_REFRESH_QUEUE_CONCURRENCY=${requested} clamped to ${value}: > 1 only with WRITE_BUDGET_MODE=enforce (max 64)`,
      );
    }
    return value;
  }
  private refreshClampWarned = false;

  private get backfillHeldMaxWaitMs(): number {
    const v = Number((this.config as unknown as QueueRoleConfigView).backfillHeldMaxWaitMs);
    return Number.isFinite(v) && v > 0 ? v : BACKFILL_HELD_MAX_WAIT_DEFAULT_MS;
  }

  private coordinationRedis(): CoordinationRedis {
    if (this.coordination) return this.coordination;
    this.coordinationClient ??= new CoordinationRedis(this.config);
    return this.coordinationClient;
  }

  /** The scheduler lease runner (status / specs). */
  get scheduler(): LeaseRunner | undefined {
    return this.schedulerRunner;
  }

  async onModuleInit(): Promise<void> {
    const pong = await this.connection.ping();
    this.logger.log(`Redis ready (${pong}) at ${this.config.redisUrl} — started at ${new Date().toISOString()}`);

    // P2.1. `all` + leases off (the default): every step below runs inline,
    // in today's order. Leases on: Workers only where `queue-workers`, and the
    // scheduler steps only in the `scheduler` lease holder (in the background).
    const leases = leasesEnabled();
    const scheduler = can('scheduler');

    // QUEUE_CLEAR_ON_BOOT=true only (default false since 2026-10-03): wipe every
    // job + repeatable BEFORE creating any worker. Either way an interrupted
    // backfill survives — its cursor and flag live in Mongo, and
    // `resumeInterruptedBackfills` below re-enqueues it. With leases on the
    // clear runs inside the scheduler lease instead, in this process's FIRST
    // scheduler session only (`bootClearDone`) — after this process's workers
    // exist, so it is still a manual one-boot reset, but a later handover or
    // re-acquire never obliterates queues whose jobs are active.
    if (!leases && scheduler) await this.clearAllQueuesOnBoot();

    if (!can('queue-workers')) {
      // api / fee / feeder: producers only. Queue objects exist (enqueue,
      // status); no Worker takes a job here.
      this.logger.log(`Queue workers not started: role ${currentProcessRole()} is a producer only`);
    } else {
      this.startWorkers();
    }

    if (!scheduler) {
      this.logger.log(`Scheduler steps not run: role ${currentProcessRole()} does not hold the scheduler capability`);
      return;
    }
    if (!leases) {
      await this.runSchedulerSteps();
      return;
    }
    const coordination = this.coordinationRedis();
    this.schedulerRunner = new LeaseRunner({
      name: SCHEDULER_LEASE,
      redis: () => coordination.client(),
      namespace: coordination.namespace,
      ttlMs: SCHEDULER_LEASE_TTL_MS,
      renewMs: SCHEDULER_LEASE_RENEW_MS,
      failOpen: currentProcessRole() === 'all',
      // Fleet-wide BullMQ concurrency every time this process BECOMES the
      // holder — a fresh acquire (before the steps enqueue anything) and a
      // fail-open local → held upgrade, which does not re-run the work.
      onAcquired: () => this.applyGlobalConcurrency(),
      work: (ctx) => this.schedulerWork(ctx),
    });
    // NOT awaited (design §2.1, C19): a standby must pass its healthcheck while
    // the old holder is still alive.
    this.schedulerRunner.start();
    this.logger.log('Scheduler lease runner started in the background (leases on)');
  }

  /**
   * The scheduler lease's work (leases on): global concurrency is applied by
   * the runner's `onAcquired` (before this runs, and again on a local → held
   * upgrade), then today's boot steps in today's order, then the redis-state
   * memory sample every 60 s until the lease is lost or the process stops.
   *
   * Per acquisition: repeatables (idempotent) and the backfill resume (a
   * handover needs it). Once per PROCESS: `QUEUE_CLEAR_ON_BOOT` (taken only by
   * this process's first session; a later one never obliterates queues with
   * active jobs) and the boot kicks (`bootKicksDone`, set once every kick was
   * sent — an interrupted run is retried by the next session, and the kicks'
   * de-duplication covers a pending one).
   */
  private async schedulerWork(ctx: LeaseWorkContext): Promise<void> {
    if (!ctx.stillHeld()) return;
    if (!this.bootClearDone) {
      this.bootClearDone = true;
      await this.clearAllQueuesOnBoot();
    }
    await this.runSchedulerSteps(ctx);
    const coordination = this.coordinationRedis();
    while (ctx.stillHeld() && !ctx.signal.aborted) {
      const client = await coordination.client();
      if (client) await sampleRedisMemory(client, this.logger);
      await sleepUnlessAborted(REDIS_MEMORY_SAMPLE_MS, ctx.signal);
    }
  }

  /**
   * BullMQ global concurrency (design §2.1, leases on, scheduler holder): the
   * per-process constants become fleet-wide, so a deploy overlap or a mixed
   * `all` + `sync` fleet cannot run two refreshes at once. Same values as the
   * per-process ones, so it is harmless to an old image (runbook:
   * `removeGlobalConcurrency` when returning to one that never set it).
   * `payments` is set by `PaymentsQueueService` itself (its own queue/module).
   */
  async applyGlobalConcurrency(): Promise<void> {
    const targets: Array<[string, Queue, number]> = [
      [POSITIONS_SYNC_QUEUE, this.queue, POSITIONS_QUEUE_CONCURRENCY],
      [POSITIONS_REFRESH_QUEUE, this.refreshQueue, this.refreshConcurrency],
      [BACKGROUND_SWEEPS_QUEUE, this.sweepsQueue, SWEEPS_QUEUE_CONCURRENCY],
      [POSITION_LIVE_REFRESH_QUEUE, this.liveRefreshQueue, Math.max(1, this.config.liveRefreshConcurrency)],
    ];
    for (const [name, queue, concurrency] of targets) {
      try {
        await queue.setGlobalConcurrency(concurrency);
        this.logger.log(`Global concurrency set: ${name}=${concurrency}`);
      } catch (err) {
        this.logger.warn(`Failed to set global concurrency on ${name}: ${(err as Error)?.message ?? String(err)}`);
      }
    }
  }

  private startWorkers(): void {

    // positions-sync carries:
    //   - 'backfill' → admin-only manual full discovery walk. Runs alongside
    //                  refresh + live-refresh (no queue pause). Cross-flow
    //                  contention is handled by per-flow locks in SyncService
    //                  and idempotent Mongo upserts.
    //   - 'recompute-aggregates' → the admin aggregate healer.
    // The cron 'refresh' rides `positions-refresh` (concurrency 1) and the
    // sweeps (`SWEEP_JOB_NAMES`) `background-sweeps`, both below, so neither
    // can hold a slot a backfill is waiting for.
    this.worker = new Worker<SyncJobData>(
      POSITIONS_SYNC_QUEUE,
      inJobLane((job: Job<SyncJobData>, token?: string) => this.processSyncJob(job, token)),
      {
        connection: this.connection,
        concurrency: POSITIONS_QUEUE_CONCURRENCY,
        lockDuration: 30 * 60_000,
      },
    );
    this.logger.log(`Position sync worker started at ${new Date().toISOString()}`);
    this.worker.on('failed', (job, error) => {
      this.logger.error(
        `Position sync job failed: jobId=${job?.id ?? 'unknown'} name=${job?.name ?? 'unknown'} chainId=${job?.data.chainId ?? 'unknown'} protocol=${job?.data.protocol ?? 'unknown'} error=${error.message}`,
      );
    });

    if (this.config.liveRefreshEnabled) {
      const concurrency = Math.max(1, this.config.liveRefreshConcurrency);
      this.liveRefreshWorker = new Worker<LiveRefreshJobData>(
        POSITION_LIVE_REFRESH_QUEUE,
        inJobLane(async (job: Job<LiveRefreshJobData>) => {
          return this.liveRefreshService.refreshPosition({
            chainId: job.data.chainId,
            protocol: job.data.protocol,
            tokenId: job.data.tokenId,
            blockNumber: job.data.blockNumber,
          });
        }),
        {
          connection: this.connection,
          concurrency,
          lockDuration: 60_000,
        },
      );
      this.logger.log(`Position live-refresh worker started at ${new Date().toISOString()}`);
      this.liveRefreshWorker.on('failed', (job, error) => {
        this.logger.warn(
          `Live refresh job failed: jobId=${job?.id ?? 'unknown'} tokenId=${job?.data.tokenId ?? '?'} block=${job?.data.blockNumber ?? '?'} error=${error.message}`,
        );
      });

      this.liveListener.registerEnqueue(async ({ chainId, protocol, tokenId, blockNumber }) => {
        await this.liveRefreshQueue.add(
          'live-refresh',
          { chainId, protocol, tokenId, blockNumber },
          {
            /*
             * ONE pending refresh per position, not one per (position, block).
             *
             * The jobId used to carry the block number, so every poll that saw a
             * position change enqueued another job for it — nothing ever collapsed
             * them, and the queue is deliberately not cleared on boot. While the
             * indexer replayed Robinhood's 100ms blocks that grew to 4.6M waiting
             * jobs (7.8 GB of Redis, a multi-GB RDB snapshot every minute), and 25
             * workers grinding through it saturated Mongo until the positions page
             * and login timed out (2026-10-01). The block bought nothing:
             * `refreshPosition` reads the position's CURRENT state and never looks
             * at `blockNumber`.
             *
             * `keepLastIfActive`: a change that lands while this position's job is
             * already running queues exactly one follow-up (at most 1 active + 1
             * waiting per position), so no update is lost — unlike a fixed jobId,
             * which would also be swallowed by a COMPLETED job kept by
             * `removeOnComplete`.
             */
            deduplication: { id: `live-${chainId}-${protocol}-${tokenId}`, keepLastIfActive: true },
            priority: LIVE_REFRESH_PRIORITY,
          },
        );
      });
    } else {
      this.logger.log(`Position live-refresh worker disabled at ${new Date().toISOString()}`);
    }

    // Created after the live-refresh worker so the other two keep their
    // creation order (specs index workers positionally).
    this.sweepsWorker = new Worker<SyncJobData>(
      BACKGROUND_SWEEPS_QUEUE,
      inJobLane((job: Job<SyncJobData>, token?: string) => this.processSyncJob(job, token)),
      {
        connection: this.connection,
        concurrency: SWEEPS_QUEUE_CONCURRENCY,
        lockDuration: 30 * 60_000,
      },
    );
    this.logger.log(`Background sweeps worker started at ${new Date().toISOString()}`);
    this.sweepsWorker.on('failed', (job, error) => {
      this.logger.error(
        `Background sweep job failed: jobId=${job?.id ?? 'unknown'} name=${job?.name ?? 'unknown'} chainId=${job?.data.chainId ?? 'unknown'} protocol=${job?.data.protocol ?? 'unknown'} error=${error.message}`,
      );
    });

    // The cron refresh, one chain at a time (concurrency 1). Created last so
    // the other workers keep their creation order (specs index them).
    const refreshConcurrency = this.refreshConcurrency;
    this.refreshWorker = new Worker<SyncJobData>(
      POSITIONS_REFRESH_QUEUE,
      inJobLane((job: Job<SyncJobData>, token?: string) => this.processSyncJob(job, token)),
      {
        connection: this.connection,
        concurrency: refreshConcurrency,
        lockDuration: 30 * 60_000,
      },
    );
    this.logger.log(`Position refresh worker started at ${new Date().toISOString()} (concurrency ${refreshConcurrency})`);
    this.refreshWorker.on('failed', (job, error) => {
      this.logger.error(
        `Position refresh job failed: jobId=${job?.id ?? 'unknown'} chainId=${job?.data.chainId ?? 'unknown'} protocol=${job?.data.protocol ?? 'unknown'} error=${error.message}`,
      );
    });
  }

  /**
   * Today's boot steps, in today's order: repeatables, boot kicks, backfill
   * resume. Inline with leases off; inside the scheduler lease with leases on
   * (`ctx`), where `stillHeld()` is checked before each step.
   */
  private async runSchedulerSteps(ctx?: LeaseWorkContext): Promise<void> {
    const held = () => !ctx || ctx.stillHeld();
    if (!held()) return;
    await this.registerRepeatableJobs();
    if (!this.bootKicksDone) {
      if (!(await this.runBootKicks(held))) return;
    }

    if (!held()) return;
    await this.resumeInterruptedBackfills(ctx ? 'lease' : 'boot');
  }

  /**
   * The boot kicks (pool sync, token sweeps, fee). Returns false when the
   * lease lapsed part-way (the next session re-sends them; each kick is
   * de-duplicated). Sets `bootKicksDone` once every enabled kick was sent.
   */
  private async runBootKicks(held: () => boolean): Promise<boolean> {
    // The pool-sync repeatable's first iteration is delayed to the next
    // scheduled minute, and re-registering it removes the pending one (as did
    // clearAllQueuesOnBoot, when on) — so a restart cadence faster than
    // poolsSyncIntervalMs would perpetually re-arm the timer and the cron could
    // run effectively never. Kick one off on boot so a fresh start always syncs pools promptly.
    // PoolsSyncService's in-flight guard coalesces this with a near-simultaneous
    // cron tick. Every boot kick is staggered by chain (chain i waits
    // i × BOOT_KICK_STAGGER_MS) so a deploy does not start every chain's walk
    // in the same second, and de-duplicated, so a restart that kept the queue
    // does not stack a second kick behind the previous boot's pending one.
    const boot = { staggerMs: BOOT_KICK_STAGGER_MS, bootKick: true };
    if (!held()) return false;
    if (this.config.poolsSyncCronEnabled) {
      await this.enqueuePoolsSyncAll(boot);
      this.logger.log(`Pool sync kicked on boot at ${new Date().toISOString()} (staggered ${BOOT_KICK_STAGGER_MS}ms per chain)`);
    }

    // Same boot-kick rationale as pool-sync: the repeatable's first run is a
    // full interval out and re-registering removed the pending one, so a
    // restart cadence faster than the interval would starve the cron.
    if (!held()) return false;
    if (this.config.tokenSecuritySyncEnabled) {
      await this.enqueueTokenSecuritySyncAll(boot);
      this.logger.log(`Token-security sweep kicked on boot at ${new Date().toISOString()} (staggered ${BOOT_KICK_STAGGER_MS}ms per chain)`);
    }

    if (!held()) return false;
    if (this.config.tokenPriceSyncEnabled) {
      await this.enqueueTokenPriceSyncAll(boot);
      this.logger.log(`Token-price sweep kicked on boot at ${new Date().toISOString()} (staggered ${BOOT_KICK_STAGGER_MS}ms per chain)`);
    }

    // Kicked on boot so a deploy shows fees within minutes rather than after
    // the first full hour.
    if (!held()) return false;
    if (this.config.positionFeeRefreshEnabled) {
      for (const [index, integration] of this.feeRefreshChains().entries()) {
        await this.enqueueSweep('position-fee-refresh', integration.chainId, integration.protocol, {
          delayMs: index * BOOT_KICK_STAGGER_MS,
          bootKick: true,
        });
      }
      this.logger.log(`Position fee refresh kicked on boot at ${new Date().toISOString()} (staggered ${BOOT_KICK_STAGGER_MS}ms per chain)`);
    }
    this.bootKicksDone = true;
    return true;
  }

  /**
   * A deploy (or a crash) kills an in-flight backfill and leaves its
   * `backfillInProgress` flag set, with the cursor where its last flush put it.
   * Re-enqueue a cursor-based resume for each such chain, so a deploy loses at
   * most one flush (10k rows) instead of the walk — a 21 h Robinhood backfill
   * used to die with every deploy and wait for an operator. A chain that
   * already has a backfill job WAITING (the queue was kept) gets none: that job
   * resumes by itself. An ACTIVE one left by the dead process is stalled and
   * returns to `wait` only when its 30-min lock lapses, so the resume is
   * enqueued anyway; whichever runs second finds the first running
   * (`SyncService`'s per-chain guard) or the cursor at the end. Never fails boot.
   * `trigger` only words the log: `boot` (leases off, inline at boot) or
   * `lease` (each scheduler-lease acquisition — at boot, or a handover).
   */
  private async resumeInterruptedBackfills(trigger: 'boot' | 'lease' = 'boot'): Promise<void> {
    const found =
      trigger === 'lease'
        ? 'the backfill flag was set when this process took the scheduler lease (a deploy, crash or lease handover interrupted it)'
        : 'the backfill flag was set at boot (a deploy or crash interrupted it)';
    try {
      const interrupted = await this.syncService.interruptedBackfills();
      if (interrupted.length === 0) return;
      const pending = await this.queue.getJobs(['waiting', 'delayed', 'prioritized', 'paused']);
      for (const integration of interrupted) {
        const queued = pending.some(
          (job) =>
            job?.name === 'backfill' &&
            job.data?.chainId === integration.chainId &&
            job.data?.protocol === integration.protocol,
        );
        if (queued) {
          this.logger.log(
            `Backfill resume not needed: ${integration.chainId}:${integration.protocol} already has a backfill job waiting`,
          );
          continue;
        }
        const jobId = await this.enqueueBackfill(integration.chainId, integration.protocol, false);
        this.logger.warn(
          `[alert] sync.backfill_resumed ${integration.chainId}:${integration.protocol} — ${found}; resuming from its cursor, jobId=${jobId}`,
        );
      }
    } catch (err) {
      this.logger.warn(`Backfill resume check failed (${trigger === 'lease' ? 'scheduler lease acquired' : 'boot'}): ${(err as Error)?.message ?? String(err)}`);
    }
  }

  /**
   * One dispatcher for the three job queues, keyed by job name. Producers
   * decide the queue (`queueNameForJob`); dispatching on the name alone means a
   * job left on the "wrong" queue by an older deployment (a `refresh` on
   * positions-sync, a sweep there) still runs as itself rather than falling
   * through to a refresh.
   */
  private async processSyncJob(job: Job<SyncJobData>, token?: string): Promise<unknown> {
    const work = this.runSyncJob(job, token);
    // The admin aggregate healer is the one job nothing re-starts on its own,
    // so it keeps the old behaviour: on a kill BullMQ's stalled checker re-runs it.
    if (job.name === 'recompute-aggregates') return work;
    // Every other job returns as soon as the process starts stopping, so BullMQ
    // records it COMPLETED instead of leaving it `active` until its 30-min lock
    // lapses and failing it as "stalled more than allowable limit". The work
    // itself carries on until the process exits (a flush in progress still
    // lands); a backfill keeps its in-progress flag, so the next boot resumes it.
    const outcome = await raceShutdown(work, (err) =>
      this.logger.log(
        `Job ${job.name} (${job.id ?? '?'}) ended after the shutdown began: ${(err as Error)?.message ?? String(err)}`,
      ),
    );
    if (isInterrupted(outcome)) {
      this.logger.warn(
        `Job interrupted by shutdown: jobId=${job.id ?? 'unknown'} name=${job.name} chainId=${job.data?.chainId ?? 'unknown'} ` +
          `— completed as interrupted; ${restartedBy(job.name)}`,
      );
    }
    return outcome;
  }

  private async runSyncJob(job: Job<SyncJobData>, token?: string): Promise<unknown> {
    if (job.name === 'backfill') {
      this.activeBackfills += 1;
      let result: unknown;
      try {
        result = await this.syncService.backfillTarget(job.data.chainId, job.data.protocol, {
          fromStart: job.data.fromStart === true,
          // The job id survives a BullMQ retry and a stalled re-run, so a
          // fromStart job resets its cursor once and every later attempt
          // resumes from it (`SyncRepository.resetCursorForRun`).
          ...(job.id ? { runKey: job.id } : {}),
          // When the job was created: a fromStart job a run has already started
          // after (e.g. one left by older code across a deploy) resumes.
          ...(typeof job.timestamp === 'number' ? { runCreatedAt: job.timestamp } : {}),
        });
      } finally {
        this.activeBackfills = Math.max(0, this.activeBackfills - 1);
      }
      // P2.1: another process holds this chain's backfill flow lock (leases
      // on). The job is RE-DELAYED — never completed as skipped — so a resume
      // enqueued by a booting process runs once the old walker exits.
      if ((result as { heldElsewhere?: boolean } | undefined)?.heldElsewhere === true) {
        await this.redelayHeldBackfill(job, token);
      }
      return result;
    }
    // The admin aggregate healer (`SyncService.recomputeAllAggregates`).
    if (job.name === 'recompute-aggregates') {
      return this.syncService.recomputeAggregatesTarget(job.data.chainId, job.data.protocol);
    }
    // Pool sync (admin-triggered + hourly cron) — walks the vanilla subgraph
    // pools, gates on the allowlist, re-values TVL, and upserts to Mongo.
    // Independent of position discovery/refresh.
    if (job.name === 'pool-sync') {
      // `repeatJobKey` is set only on a repeatable's iterations: the cron. An
      // admin trigger or the boot kick always walks.
      return this.poolsSyncService.syncPools(job.data.chainId, job.data.protocol, {
        scheduled: typeof job.repeatJobKey === 'string',
      });
    }
    // Token-security sweep (boot kick + cron) — decoupled GoPlus check over
    // the indexer's token universe; never touches the resync path.
    if (job.name === 'token-security-sync') {
      return this.tokenSecuritySyncService.syncChain(
        job.data.chainId,
        this.config.getIntegration(job.data.chainId, job.data.protocol),
      );
    }
    // Token-price sweep (boot kick + cron) — keeps {chainId}_tokens current
    // prices fresh for the active-token universe; never on the resync path.
    if (job.name === 'token-price-sync') {
      return this.tokenPriceSyncService.syncChain(job.data.chainId, job.data.protocol);
    }
    // On-chain uncollected-fee refresh (hourly cron + boot kick). A poke of the
    // service's own 60 s tiered tick — single-flight, so it returns at once while
    // a tick is running. See position-fee-refresh.service.ts.
    if (job.name === 'position-fee-refresh') {
      return this.positionFeeRefresh?.refreshChain(job.data.chainId, job.data.protocol);
    }
    return this.syncService.refreshTarget(job.data.chainId, job.data.protocol);
  }

  /**
   * Re-delay a backfill whose flow lock another process holds: `moveToDelayed`
   * to now + 60 s ± 10 s, then `DelayedError` (BullMQ's "do not complete, do
   * not fail" signal). After `BACKFILL_HELD_MAX_WAIT_MS` (45 min ≫ the 60 s
   * lock TTL) the job completes with an alert instead — the next boot's
   * `resumeInterruptedBackfills` still finds the flag. Without a lock token
   * (an old caller) it completes the same way.
   */
  private async redelayHeldBackfill(job: Job<SyncJobData>, token: string | undefined): Promise<void> {
    const key = `${job.data.chainId}:${job.data.protocol}`;
    const delay = heldBackfillRedelayMs(job.timestamp, Date.now(), this.backfillHeldMaxWaitMs);
    if (delay === undefined || !token) {
      this.logger.warn(
        `[alert] sync.backfill_held_timeout ${key} jobId=${job.id ?? '?'} — the backfill flow lock was still held elsewhere ` +
          `${delay === undefined ? `after ${this.backfillHeldMaxWaitMs} ms` : '(no lock token to re-delay with)'}; completing the job. ` +
          `The in-progress flag is kept, so the next boot resumes it.`,
      );
      return;
    }
    await job.moveToDelayed(Date.now() + delay, token);
    this.logger.log(`Backfill ${key} held elsewhere — job ${job.id ?? '?'} re-delayed ${delay} ms`);
    throw new DelayedError();
  }

  /** The queue a job name is produced onto. */
  private queueFor(name: string): Queue<SyncJobData> {
    const queue = queueNameForJob(name);
    if (queue === BACKGROUND_SWEEPS_QUEUE) return this.sweepsQueue;
    if (queue === POSITIONS_REFRESH_QUEUE) return this.refreshQueue;
    return this.queue;
  }

  /** Enabled integrations that have an RPC url for the on-chain fee refresh. */
  private feeRefreshChains() {
    const uncovered = new Set(feeRefreshUncovered(this.config.enabledIntegrations, this.config.evmRpcUrls));
    return this.config.enabledIntegrations.filter((i) => !uncovered.has(i));
  }

  /**
   * Shutdown (Nest's hooks, enabled in `main.ts`). Signals the stop first, so
   * every long job returns `{ interrupted }` and is recorded COMPLETED, then
   * closes the workers — each waits at most `WORKER_CLOSE_GRACE_MS` for its
   * short jobs, in parallel — then the queues and the connection. A worker
   * still closing at the deadline is left to the process exit (its job goes to
   * the stalled checker, the old behaviour). Never throws: the shutdown must
   * reach `SyncRepository`'s hook, which closes this process's open runs.
   */
  async onModuleDestroy(): Promise<void> {
    beginShutdown('module-destroy');
    // P2.1: the scheduler lease is released (after the step in flight) so a
    // standby takes over within one renew instead of one TTL.
    if (this.schedulerRunner) await closeWithin(() => this.schedulerRunner!.stop(), WORKER_CLOSE_GRACE_MS);
    const workers: Array<[string, Worker | undefined]> = [
      [POSITIONS_SYNC_QUEUE, this.worker],
      [POSITION_LIVE_REFRESH_QUEUE, this.liveRefreshWorker],
      [BACKGROUND_SWEEPS_QUEUE, this.sweepsWorker],
      [POSITIONS_REFRESH_QUEUE, this.refreshWorker],
    ];
    const closed = await Promise.all(
      workers.map(async ([name, worker]) =>
        worker ? [name, await closeWithin(() => worker.close(), WORKER_CLOSE_GRACE_MS)] as const : [name, true] as const,
      ),
    );
    const late = closed.filter(([, ok]) => !ok).map(([name]) => name);
    if (late.length > 0) {
      this.logger.warn(
        `Worker(s) still busy after ${WORKER_CLOSE_GRACE_MS} ms at shutdown: ${late.join(', ')} — their jobs go to the stalled checker`,
      );
    }
    for (const queue of [this.queue, this.liveRefreshQueue, this.sweepsQueue, this.refreshQueue]) {
      await queue?.close().catch(() => undefined);
    }
    await this.connection?.quit().catch(() => undefined);
    await this.coordinationClient?.close().catch(() => undefined);
    // A producer-only role (api / fee / feeder) started no Worker: say so
    // rather than claim it closed some.
    const hadWorkers = workers.some(([, worker]) => worker !== undefined);
    this.logger.log(
      hadWorkers
        ? `Workers + queues closed at ${new Date().toISOString()}`
        : `Queues closed at ${new Date().toISOString()} (no workers in role ${currentProcessRole()})`,
    );
  }

  /**
   * `QUEUE_CLEAR_ON_BOOT=true` only — **off by default since 2026-10-03**.
   * Obliterates positions-sync, positions-refresh and background-sweeps: ALL
   * jobs (waiting, active, delayed, completed, failed) AND all repeatables.
   * Runs before any worker is created (a worker can't grab a job that's about
   * to be wiped); the crons are re-registered fresh by `registerRepeatableJobs`.
   * Each queue is cleared on its own, so one failure does not leave the others
   * uncleared.
   *
   * It was on by default, and it was what lost an in-flight backfill on every
   * deploy. The hygiene it bought no longer needs it: `registerRepeatableJobs`
   * removes stale repeatables by name (and BullMQ deletes each one's next
   * scheduled job with it), boot kicks are de-duplicated per (job, chain), and
   * the dispatcher runs a job left on an old queue as itself. Even when it IS
   * on, an interrupted backfill survives: its cursor and flag live in Mongo and
   * `resumeInterruptedBackfills` re-enqueues it.
   *
   * The **live-refresh queue is deliberately NOT cleared** — its jobs are
   * ephemeral per-position refreshes the live listener regenerates as new
   * blocks arrive, so wiping them on boot is pointless and would only interrupt
   * live updates.
   *
   * **THE `payments` QUEUE MUST NEVER BE ADDED HERE.** It is owned by
   * `PaymentsQueueService` in a different module precisely so it is out of
   * reach of this method. A wiped position sync costs a re-sync — the chain
   * still has the data. A wiped `payment-reconcile` job is a customer who has
   * paid, does not have their plan, and nothing left in the system that will
   * ever notice.
   */
  private async clearAllQueuesOnBoot(): Promise<void> {
    if (this.config.queueClearOnBoot !== true) {
      this.logger.log('Queue clear-on-boot off (QUEUE_CLEAR_ON_BOOT=false, the default): pending jobs survive the restart');
      return;
    }
    const targets: Array<[string, Queue]> = [
      [POSITIONS_SYNC_QUEUE, this.queue],
      [BACKGROUND_SWEEPS_QUEUE, this.sweepsQueue],
      [POSITIONS_REFRESH_QUEUE, this.refreshQueue],
    ];
    for (const [name, queue] of targets) {
      try {
        await queue.obliterate({ force: true });
        this.logger.log(`Queue cleared on boot: ${name}`);
      } catch (error) {
        this.logger.warn(`Failed to clear queue ${name} on boot: ${(error as Error).message}`);
      }
    }
  }

  /**
   * Enqueue an admin-triggered backfill. `fromStart=true` resets the cursor
   * to zero and rescans the whole subgraph (catches missed / back-dated
   * positions). Default is a resume from the persisted cursor.
   */
  async enqueueBackfill(
    chainId: number,
    protocol: string,
    fromStart = false,
  ): Promise<string | undefined> {
    const job = await this.queue.add(
      'backfill',
      { chainId, protocol, fromStart },
      { jobId: `backfill-${chainId}-${protocol}-${Date.now()}` },
    );
    return job.id;
  }

  async enqueueBackfillAll(
    fromStart = false,
  ): Promise<Array<{ chainId: number; protocol: string; jobId?: string }>> {
    const jobs = [];
    for (const integration of this.config.enabledIntegrations) {
      const jobId = await this.enqueueBackfill(integration.chainId, integration.protocol, fromStart);
      jobs.push({ chainId: integration.chainId, protocol: integration.protocol, jobId });
    }
    return jobs;
  }

  /**
   * Enqueue the admin aggregate healer (`SyncService.recomputeAllAggregates`)
   * for one integration, on positions-sync. It reads and rewrites EVERY row of
   * the shard, closed ones included — run it off-peak.
   */
  async enqueueRecomputeAggregates(chainId: number, protocol: string): Promise<string | undefined> {
    const job = await this.queue.add(
      'recompute-aggregates',
      { chainId, protocol },
      { jobId: `recompute-aggregates-${chainId}-${protocol}-${Date.now()}` },
    );
    return job.id;
  }

  async enqueueRecomputeAggregatesAll(): Promise<Array<{ chainId: number; protocol: string; jobId?: string }>> {
    const jobs = [];
    for (const integration of this.config.enabledIntegrations) {
      const jobId = await this.enqueueRecomputeAggregates(integration.chainId, integration.protocol);
      jobs.push({ chainId: integration.chainId, protocol: integration.protocol, jobId });
    }
    return jobs;
  }

  /**
   * Enqueue a one-off pool sync for a single (chainId, protocol). Rides the
   * background-sweeps queue under the 'pool-sync' job name; the worker
   * dispatches it to `PoolsSyncService.syncPools`.
   */
  async enqueuePoolsSync(
    chainId: number,
    protocol: string,
    options: EnqueueOptions = {},
  ): Promise<string | undefined> {
    return this.enqueueSweep('pool-sync', chainId, protocol, options);
  }

  /** `staggerMs` delays chain i by i × staggerMs (the boot kick); admin triggers run at once. */
  async enqueuePoolsSyncAll(
    options: EnqueueAllOptions = {},
  ): Promise<Array<{ chainId: number; protocol: string; jobId?: string }>> {
    return this.enqueueSweepAll('pool-sync', options);
  }

  /** Enqueue a one-off token-security sweep for a single (chainId, protocol). */
  async enqueueTokenSecuritySync(
    chainId: number,
    protocol: string,
    options: EnqueueOptions = {},
  ): Promise<string | undefined> {
    return this.enqueueSweep('token-security-sync', chainId, protocol, options);
  }

  async enqueueTokenSecuritySyncAll(
    options: EnqueueAllOptions = {},
  ): Promise<Array<{ chainId: number; protocol: string; jobId?: string }>> {
    return this.enqueueSweepAll('token-security-sync', options);
  }

  /** Enqueue a one-off token-price sweep for a single (chainId, protocol). */
  async enqueueTokenPriceSync(
    chainId: number,
    protocol: string,
    options: EnqueueOptions = {},
  ): Promise<string | undefined> {
    return this.enqueueSweep('token-price-sync', chainId, protocol, options);
  }

  async enqueueTokenPriceSyncAll(
    options: EnqueueAllOptions = {},
  ): Promise<Array<{ chainId: number; protocol: string; jobId?: string }>> {
    return this.enqueueSweepAll('token-price-sync', options);
  }

  private async enqueueSweep(
    name: SweepJobName,
    chainId: number,
    protocol: string,
    options: EnqueueOptions,
  ): Promise<string | undefined> {
    const delay = Math.max(0, options.delayMs ?? 0);
    const job = await this.queueFor(name).add(
      name,
      { chainId, protocol },
      {
        jobId: `${name}-${chainId}-${protocol}-${Date.now()}`,
        ...(delay > 0 ? { delay } : {}),
        // Simple-mode de-duplication: a second add while the first is still
        // waiting/delayed/active is ignored; once it completes or fails, the
        // next boot's kick is accepted again.
        ...(options.bootKick ? { deduplication: { id: `boot-${name}-${chainId}-${protocol}` } } : {}),
      },
    );
    return job.id;
  }

  private async enqueueSweepAll(
    name: SweepJobName,
    options: EnqueueAllOptions,
  ): Promise<Array<{ chainId: number; protocol: string; jobId?: string }>> {
    const jobs = [];
    for (const [index, integration] of this.config.enabledIntegrations.entries()) {
      const jobId = await this.enqueueSweep(name, integration.chainId, integration.protocol, {
        delayMs: index * Math.max(0, options.staggerMs ?? 0),
        bootKick: options.bootKick === true,
      });
      jobs.push({ chainId: integration.chainId, protocol: integration.protocol, jobId });
    }
    return jobs;
  }

  /**
   * Back-compat shim. Older code paths called `enqueueSync` expecting the
   * full sync flow (backfill + refresh). Now it routes to the admin-style
   * backfill — refresh is on its own cron.
   */
  async enqueueSync(chainId: number, protocol: string): Promise<string | undefined> {
    return this.enqueueBackfill(chainId, protocol, false);
  }

  async enqueueAll(): Promise<Array<{ chainId: number; protocol: string; jobId?: string }>> {
    return this.enqueueBackfillAll(false);
  }

  async status(): Promise<{
    positions: Record<string, number>;
    refresh: Record<string, number>;
    liveRefresh: Record<string, number>;
    sweeps: Record<string, number>;
  }> {
    const [positions, refresh, liveRefresh, sweeps] = await Promise.all([
      this.queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused'),
      this.refreshQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused'),
      this.liveRefreshQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused'),
      this.sweepsQueue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused'),
    ]);
    return { positions, refresh, liveRefresh, sweeps };
  }

  private async registerRepeatableJobs(): Promise<void> {
    const startedAt = new Date().toISOString();
    // Remove every stale repeatable, whatever its name and whether or not its
    // cron is enabled, so an old schedule never lingers after a knob is flipped
    // off or a job moves queue (BullMQ deletes each one's next scheduled job
    // with it). positions-sync holds no cron at all any more — it used to carry
    // 'refresh' (and the retired 'sync'), and before 2026-10-01 the sweeps;
    // positions-refresh holds only 'refresh'; background-sweeps only sweeps.
    await removeRepeatableJobs(this.queue);
    await removeRepeatableJobs(this.refreshQueue);
    await removeRepeatableJobs(this.sweepsQueue);

    // The minutes the sweeps start at — the refresh schedule steers around them.
    const sweepMinutes = new Set<number>();
    const reserve = (repeats: SweepRepeat[]) => {
      for (const r of repeats) for (const m of repeatMinutes(r)) sweepMinutes.add(m);
    };

    // Pool sync cron (hourly by default). Independent of the position refresh
    // cron — pools move slower, so they get their own cadence.
    if (this.config.poolsSyncCronEnabled) {
      reserve(
        await this.registerSweepCron('pool-sync', 'Pool sync', this.config.enabledIntegrations, this.config.poolsSyncIntervalMs, startedAt),
      );
    } else {
      this.logger.log(`Pool sync cron disabled at ${startedAt}`);
    }

    // Token-security sweep cron — its own (slow) cadence; decoupled from sync.
    if (this.config.tokenSecuritySyncEnabled) {
      reserve(
        await this.registerSweepCron(
          'token-security-sync',
          'Token-security sweep',
          this.config.enabledIntegrations,
          this.config.tokenSecuritySyncIntervalMs,
          startedAt,
        ),
      );
    } else {
      this.logger.log(`Token-security sweep cron disabled at ${startedAt}`);
    }

    // Token-price sweep cron — keeps {chainId}_tokens current prices fresh for
    // the active-token universe so position valuation reads a complete cache.
    if (this.config.tokenPriceSyncEnabled) {
      reserve(
        await this.registerSweepCron(
          'token-price-sync',
          'Token-price sweep',
          this.config.enabledIntegrations,
          this.config.tokenPriceSyncIntervalMs,
          startedAt,
        ),
      );
    } else {
      this.logger.log(`Token-price sweep cron disabled at ${startedAt}`);
    }

    // On-chain uncollected-fee refresh cron — only for chains with an RPC url.
    //
    // Since 2026-10-05 this job is the ONLY source of uncollected fees: the indexer
    // stopped computing them, and normalize hands chooseUncollected a zeroed figure.
    // So a chain this job cannot reach has no uncollected fees at all — every open
    // position on it reads `unmeasured` ("Pending") indefinitely. Both alerts below say
    // exactly that; neither used to (the old text claimed the indexer covered the gap).
    if (this.config.positionFeeRefreshEnabled) {
      reserve(
        await this.registerSweepCron(
          'position-fee-refresh',
          'Position fee refresh',
          this.feeRefreshChains(),
          this.config.positionFeeRefreshIntervalMs,
          startedAt,
        ),
      );
      for (const i of feeRefreshUncovered(this.config.enabledIntegrations, this.config.evmRpcUrls)) {
        this.logger.warn(
          `[alert] fees.no_rpc ${i.chainId}:${i.protocol} — no EVM_RPC_URLS entry; this chain has NO source of ` +
            `uncollected fees (the indexer no longer reports them), so every open position on it reads Pending`,
        );
      }
    } else {
      this.logger.log(`Position fee refresh cron disabled at ${startedAt}`);
      if (this.config.enabledIntegrations.length > 0) {
        this.logger.warn(
          `[alert] fees.refresh_disabled — POSITION_FEE_REFRESH_ENABLED=false; uncollected fees have NO source on ` +
            `any chain (the indexer no longer reports them), so every open position reads Pending`,
        );
      }
    }

    // The position refresh — registered LAST, on positions-refresh, because its
    // per-chain minutes steer around the sweeps' (`refreshRepeats`). Cron emits
    // 'refresh' jobs only — backfill is admin-triggered. The refresh tick is the
    // single scheduled-work primitive: it drives position re-fetch,
    // position-driven transaction sync (open + closed), reprice/heal recovery,
    // and the stale sweep.
    if (this.config.positionsSyncCronEnabled) {
      const integrations = this.config.enabledIntegrations;
      const repeats = refreshRepeats(this.config.positionsSyncIntervalMs, integrations.length, sweepMinutes);
      for (const [index, integration] of integrations.entries()) {
        const repeat = repeats[index]!;
        await this.refreshQueue.add(
          'refresh',
          { chainId: integration.chainId, protocol: integration.protocol },
          { jobId: `repeat-refresh-${integration.chainId}-${integration.protocol}`, repeat },
        );
        this.logger.log(
          `Position refresh cron started at ${startedAt}: chainId=${integration.chainId} protocol=${integration.protocol} interval=${this.config.positionsSyncIntervalMs}ms ${describeRepeat(repeat)} (queue ${POSITIONS_REFRESH_QUEUE}, one chain at a time)`,
        );
      }
      if (integrations.length > 0 && !('pattern' in (repeats[0] ?? { every: 0 }))) {
        this.logger.warn(
          `Position refresh interval ${this.config.positionsSyncIntervalMs}ms is not a whole number of minutes dividing an hour or of hours dividing a day; every chain is enqueued on the same aligned 'every' schedule (still run one at a time)`,
        );
      }
    } else {
      this.logger.log(`Position refresh cron disabled at ${startedAt}`);
    }
  }

  /**
   * One repeatable per chain on background-sweeps, each on its own staggered
   * schedule (`staggeredRepeat`), so the chains' walks never start together.
   * Returns the repeats it registered (the refresh schedule avoids their minutes).
   */
  private async registerSweepCron(
    name: SweepJobName,
    label: string,
    integrations: ReadonlyArray<{ chainId: number; protocol: string }>,
    intervalMs: number,
    startedAt: string,
  ): Promise<SweepRepeat[]> {
    const repeats: SweepRepeat[] = [];
    for (const [index, integration] of integrations.entries()) {
      const repeat = staggeredRepeat(intervalMs, index, integrations.length);
      await this.queueFor(name).add(
        name,
        { chainId: integration.chainId, protocol: integration.protocol },
        { jobId: `repeat-${name}-${integration.chainId}-${integration.protocol}`, repeat },
      );
      repeats.push(repeat);
      this.logger.log(
        `${label} cron started at ${startedAt}: chainId=${integration.chainId} protocol=${integration.protocol} interval=${intervalMs}ms ${describeRepeat(repeat)}`,
      );
    }
    if (integrations.length > 0 && !('pattern' in staggeredRepeat(intervalMs, 0, integrations.length))) {
      this.logger.warn(
        `${label} interval ${intervalMs}ms is not a whole number of minutes dividing an hour or of hours dividing a day; every chain runs on the same aligned 'every' schedule`,
      );
    }
    return repeats;
  }
}

function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    timer.unref?.();
    function done() {
      signal.removeEventListener('abort', done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

async function removeRepeatableJobs(queue: Queue, name?: string): Promise<void> {
  const repeatableJobs = await queue.getRepeatableJobs();
  const jobsToRemove = name
    ? repeatableJobs.filter((job) => job.name === name)
    : repeatableJobs;
  await Promise.all(jobsToRemove.map((job) => queue.removeRepeatableByKey(job.key)));
}
