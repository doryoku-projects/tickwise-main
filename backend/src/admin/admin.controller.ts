import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Inject,
  Optional,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import { SyncRepository, pausedBackfillsOf } from '../database/sync.repository.js';
import { QueueService } from '../queues/queue.service.js';
import { indexerBudgetSnapshot } from '../subgraph/hyperindex/indexer-gateway.js';
import { readPathSnapshot } from '../common/cache/read-path-meter.js';
import { replicationLagSnapshot } from '../database/replication-lag.js';
import { runtimeSnapshot } from '../common/runtime-metrics.js';
import { ReadModelsService } from '../read-models/read-models.service.js';
import { isMode, isModelName } from '../read-models/flags.js';
import {
  BackfillPauseDto,
  ReadModelsOverrideDto,
  ReadModelsRescanDto,
  ReadModelsScanDto,
  RunSyncDto,
} from './admin.dto.js';
import { ProcessStatusService, lastRedisMemorySample } from '../common/process-status.js';
import { activeLeaseRunners } from '../common/lease-runner.js';
import { processRoleSettings } from '../common/process-role.js';
import { roleGateSummary } from '../common/role-gate.middleware.js';
import { WriteBudgetController } from '../common/write-budget-controller.js';
import { PositionsRepository } from '../database/positions.repository.js';
import { LimiterFactory } from '../common/limiter-factory.js';
import { InvalidationBus } from '../common/invalidation-bus.js';
import { RpcBudget } from '../common/rpc-budget.js';
import { PositionFeeRefreshService } from '../sync/position-fee-refresh.service.js';
import { backfillProfiles } from '../sync/backfill-profile.js';
import { enqueueBackfillAllUnlessPaused, enqueueBackfillUnlessPaused, pausedView } from './backfill-run.js';
import { UsageFlushService } from '../billing/usage-flush.service.js';


@Controller('admin')
export class AdminController {
  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(QueueService) private readonly queues: QueueService,
    @Inject(SyncRepository) private readonly syncRepo: SyncRepository,
    // P-R read models (appended + optional: specs construct this positionally).
    @Optional() @Inject(ReadModelsService) private readonly readModels?: ReadModelsService,
    // P2/P3 status blocks (all appended + optional, integrator I1).
    @Optional() @Inject(ProcessStatusService) private readonly processStatus?: ProcessStatusService,
    @Optional() @Inject(WriteBudgetController) private readonly writeBudget?: WriteBudgetController,
    @Optional() @Inject(PositionsRepository) private readonly positions?: PositionsRepository,
    @Optional() @Inject(LimiterFactory) private readonly limiters?: LimiterFactory,
    @Optional() @Inject(InvalidationBus) private readonly invalidation?: InvalidationBus,
    @Optional() @Inject(RpcBudget) private readonly rpcBudget?: RpcBudget,
    @Optional() @Inject(PositionFeeRefreshService) private readonly feeRefresh?: PositionFeeRefreshService,
    // Usage write batching (appended + optional; BillingModule exports it).
    @Optional() @Inject(UsageFlushService) private readonly usageFlush?: UsageFlushService,
  ) {}

  /**
   * Admin-triggered backfill. The position-sync cron only runs refresh on
   * already-tracked positions; new-position discovery is gated here so
   * operators decide when to scan the subgraph from scratch (potentially
   * tens of thousands of rows).
   *
   * `fromStart=true` resets the cursor to zero so the whole subgraph is
   * rescanned ascending — useful to fill gaps from missed / back-dated
   * positions. Default `false` resumes from the persisted cursor.
   */
  @Post('sync/run')
  async runSync(
    @Headers('x-admin-secret') adminSecret: string | undefined,
    @Body() body: RunSyncDto,
  ) {
    this.assertAdmin(adminSecret);
    const fromStart = body.fromStart === true;
    // A PAUSED chain is skipped (and named) by `{all}` and refused (409) on
    // its own; with nothing paused both are today's calls, unchanged. Shared
    // with the admin panel's POST /admin/ops/sync (`backfill-run.ts`).
    if (body.all) {
      return enqueueBackfillAllUnlessPaused(this.queues, this.syncRepo, this.config.enabledIntegrations, fromStart);
    }
    if (!body.chainId || !body.protocol) {
      return { error: 'chainId and protocol are required unless all=true' };
    }
    return enqueueBackfillUnlessPaused(this.queues, this.syncRepo, body.chainId, body.protocol, fromStart);
  }

  /**
   * The admin aggregate healer (2026-10-03): re-derive every row's vs-HODL
   * metrics from its stored aggregates — closed rows included, which no sync
   * rewrites. Queued (`recompute-aggregates` on positions-sync), because it
   * reads and rewrites the whole shard. It used to run after every bucketed
   * full backfill; the flushes compute those metrics inside their upsert now.
   * `fromStart` is ignored.
   */
  @Post('sync/recompute-aggregates')
  async recomputeAggregates(
    @Headers('x-admin-secret') adminSecret: string | undefined,
    @Body() body: RunSyncDto,
  ) {
    this.assertAdmin(adminSecret);
    if (body.all) {
      return { jobs: await this.queues.enqueueRecomputeAggregatesAll() };
    }
    if (!body.chainId || !body.protocol) {
      return { error: 'chainId and protocol are required unless all=true' };
    }
    return {
      jobId: await this.queues.enqueueRecomputeAggregates(body.chainId, body.protocol),
      chainId: body.chainId,
      protocol: body.protocol,
    };
  }

  @Get('sync/status')
  async syncStatus(@Headers('x-admin-secret') adminSecret: string | undefined) {
    this.assertAdmin(adminSecret);
    const [queue, sync] = await Promise.all([
      this.queues.status(),
      this.syncRepo.status(),
    ]);
    // Indexer requests per URL: the last full minute and the one filling now, by
    // lane, job and outcome, plus the gateway's queue/bucket state. Absent until
    // this process has made its first indexer call (nothing to report yet).
    const indexer = indexerBudgetSnapshot();
    return {
      queue,
      ...sync,
      // Audit C-pause: every chain whose backfill is paused (empty = none).
      backfillPaused: pausedBackfillsOf((sync as { cursors?: unknown[] }).cursors ?? []).map(pausedView),
      ...(indexer.length > 0 ? { indexer } : {}),
      // The read path's degraded and paced answers (stale fallbacks, partial
      // all-chains pages, pending counts, the global read budget per lane, deep
      // walks) and the replication lag per member, from the driver's heartbeats.
      readPath: { ...readPathSnapshot(), replication: replicationLagSnapshot() },
      // This process's event-loop delay and Mongo pool checkout wait, per
      // 60 s window (the last closed one and the one filling now); a window
      // with a p99 over 100 ms logged an [alert] when it closed.
      runtime: runtimeSnapshot(),
      // P-R read models: modes, lease / fence / epoch / incarnation / s, lag
      // and dataAt, per-shard state and quarantine, scans, snapshots, Redis,
      // memory, fleet circuit, recent alerts. `{mode: 'off'}` while off.
      readModels: this.readModels ? await this.readModels.status().catch((err) => ({ error: String((err as Error)?.message ?? err) })) : { mode: 'off' },
      ...(await this.p2p3Status()),
    };
  }

  /**
   * The backfill PAUSE lever (audit C-pause; runbook "pause the backfill").
   * Sets `sync_cursors.backfillPausedAt` (+ `backfillPausedBy`) atomically for
   * one chain or every enabled one. A running walk sees it on its next
   * heartbeat (every flush, and every 2 min) and stops at the next flush /
   * page / range like an interrupted run: flag and cursor KEPT, run row
   * `interrupted`. While paused: no boot / lease resume, and `sync/run` is
   * refused for the chain. Pausing twice keeps the first pause.
   */
  @Post('sync/backfill/pause')
  async pauseBackfill(@Headers('x-admin-secret') adminSecret: string | undefined, @Body() body: BackfillPauseDto) {
    this.assertAdmin(adminSecret);
    const targets = this.pauseTargets(body);
    const repo = this.pauseRepo();
    const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 200) : '';
    const by = note ? `admin: ${note}` : 'admin';
    const out = [];
    for (const t of targets) {
      const res = await repo.pauseBackfill(t.chainId, t.protocol, by);
      out.push({ chainId: t.chainId, protocol: t.protocol, pausedAt: res.pausedAt.toISOString(), pausedBy: res.pausedBy, alreadyPaused: res.alreadyPaused });
    }
    return {
      paused: out,
      note: 'a running walk stops at its next flush / page / range (within ~2 min); flag and cursor are kept. Watch GET /admin/sync/status → backfillPaused and latestRuns',
    };
  }

  /**
   * Lift the pause. `enqueue` (default true) re-enqueues a cursor-based resume
   * for a chain whose backfill flag is still set (the walk the pause stopped),
   * exactly what the boot resume would have done.
   */
  @Post('sync/backfill/resume')
  async resumeBackfill(@Headers('x-admin-secret') adminSecret: string | undefined, @Body() body: BackfillPauseDto) {
    this.assertAdmin(adminSecret);
    const targets = this.pauseTargets(body);
    const repo = this.pauseRepo();
    const enqueue = body?.enqueue !== false;
    const out = [];
    for (const t of targets) {
      const wasPaused = await repo.resumeBackfill(t.chainId, t.protocol);
      const cursor = wasPaused && enqueue ? await this.syncRepo.getCursor(t.chainId, t.protocol) : null;
      const jobId = cursor?.backfillInProgress === true ? await this.queues.enqueueBackfill(t.chainId, t.protocol, false) : undefined;
      out.push({ chainId: t.chainId, protocol: t.protocol, wasPaused, ...(jobId !== undefined ? { jobId } : {}) });
    }
    return {
      resumed: out,
      note:
        'a jobId = the interrupted walk continues from its cursor. If the old walk was still stopping, that job can answer ' +
        '"already running" / be re-delayed — check GET /admin/sync/status and re-run POST /admin/sync/run (fromStart:false) if the flag is still set',
    };
  }

  /** Validated targets of a pause / resume: every enabled integration, or one enabled one. */
  private pauseTargets(body: BackfillPauseDto | undefined): Array<{ chainId: number; protocol: string }> {
    const enabled = (this.config.enabledIntegrations ?? []).map((i) => ({ chainId: i.chainId, protocol: i.protocol }));
    if (body?.all === true) return enabled;
    const chainId = Number(body?.chainId);
    const protocol = body?.protocol;
    if (!Number.isInteger(chainId) || chainId < 1 || typeof protocol !== 'string' || !protocol) {
      throw new BadRequestException({ error: 'chainId and protocol are required unless all=true' });
    }
    if (!enabled.some((i) => i.chainId === chainId && i.protocol === protocol)) {
      throw new BadRequestException({ error: `${chainId}:${protocol} is not an enabled integration` });
    }
    return [{ chainId, protocol }];
  }

  private pauseRepo(): Pick<SyncRepository, 'pauseBackfill' | 'resumeBackfill'> {
    const repo = this.syncRepo as Partial<SyncRepository> | undefined;
    if (typeof repo?.pauseBackfill !== 'function' || typeof repo?.resumeBackfill !== 'function') {
      throw new ServiceUnavailableException({ error: 'the backfill pause lever is not wired in this process' });
    }
    return repo as SyncRepository;
  }

  /**
   * P2/P3 (integrator I1, design §2.1 / §3.5 / §4.5 / §5.4 / §6.4 / §8): this
   * process's role and leases, the fleet's status records, the redis-state
   * memory sample, the write budget, write-skip, the backfill profile, the fee
   * pass and the shared-state counters. Nothing here opens a Redis connection
   * a default deployment (`all`, leases off, every flag off) would not
   * already have: the fleet is read only where status is published, and the
   * write budget's fleet view only while the budget is on.
   */
  private async p2p3Status(): Promise<Record<string, unknown>> {
    const settings = processRoleSettings();
    const publishing = (this.processStatus?.publishMs ?? 0) > 0;
    const safe = async <T>(fn: () => T | Promise<T>): Promise<T | { error: string }> => {
      try {
        return await fn();
      } catch (err) {
        return { error: String((err as Error)?.message ?? err) };
      }
    };
    return {
      process: { role: settings.role, leases: settings.leases, leasesSetting: settings.leasesSetting, http: roleGateSummary(settings.role) },
      leases: activeLeaseRunners().map((runner) => runner.status()),
      processes: publishing && this.processStatus ? await this.processStatus.readFleet() : [],
      redis: lastRedisMemorySample() ?? null,
      writeBudget: this.writeBudget ? await safe(() => this.writeBudget!.status()) : null,
      writeSkip: this.positions ? await safe(() => this.positions!.writeSkipStatus()) : null,
      backfill: backfillProfiles(),
      fee: this.feeRefresh ? await safe(() => this.feeRefresh!.feeStatus()) : null,
      // USAGE_WRITE_MODE: mode, flusher, last flush age, failures; in batched /
      // drain also the SHARED buffer (bufferedKeys, pendingClaims) and `drained`
      // — the signal the rollback (batched → drain → direct) waits for. In
      // direct (default) no Redis call is made: the counts read null.
      usageWrites: this.usageFlush ? await safe(() => this.usageFlush!.metrics()) : null,
      sharedState: {
        rateLimit: this.limiters ? this.limiters.stats() : null,
        invalidation: this.invalidation ? this.invalidation.stats() : null,
        rpc: this.rpcBudget ? this.rpcBudget.status() : null,
      },
    };
  }

  /**
   * The read models' KILL SWITCH (P-R §2.2): lower one model's mode at run
   * time — `off` stops the feeder for it, unloads it and frees its memory on
   * every replica within 5 s, without a redeploy. It can only LOWER the env's
   * mode; `serve` clears the override.
   */
  @Post('read-models/override')
  async readModelsOverride(@Headers('x-admin-secret') adminSecret: string | undefined, @Body() body: ReadModelsOverrideDto) {
    this.assertAdmin(adminSecret);
    if (!isModelName(body?.model) || !isMode(body?.mode)) throw new BadRequestException({ error: 'model must be rank|pools and mode off|shadow|serve' });
    return this.readModelsOrFail().override(body.model, body.mode, 'admin');
  }

  /** Rescan one shard (in-epoch shard scan) or, with no shard, everything (a new epoch with a cold scan). */
  @Post('read-models/rescan')
  async readModelsRescan(@Headers('x-admin-secret') adminSecret: string | undefined, @Body() body: ReadModelsRescanDto) {
    this.assertAdmin(adminSecret);
    if (!isModelName(body?.model)) throw new BadRequestException({ error: 'model must be rank or pools' });
    const shard = typeof body.shard === 'string' && body.shard.trim() ? body.shard.trim() : undefined;
    return this.readModelsOrFail().command({ type: 'rescan', model: body.model, ...(shard ? { shard } : {}) }, 'admin');
  }

  /**
   * Pause / resume / re-pace the feeder's running scan or field backfill
   * (`target: feeder`, the default) or lane B's verification scan (`target:
   * verify`) — ≤ 5k docs/s; one command never reaches both.
   */
  @Post('read-models/scan')
  async readModelsScan(@Headers('x-admin-secret') adminSecret: string | undefined, @Body() body: ReadModelsScanDto) {
    this.assertAdmin(adminSecret);
    const action = body?.action;
    if (action !== 'pause' && action !== 'resume' && action !== 'pace') throw new BadRequestException({ error: 'action must be pause, resume or pace' });
    const docsPerSec = body.docsPerSec === undefined ? undefined : Number(body.docsPerSec);
    if (docsPerSec !== undefined && !(docsPerSec > 0 && docsPerSec <= 5_000)) throw new BadRequestException({ error: 'docsPerSec must be 1–5000' });
    const target = body.target ?? 'feeder';
    if (target !== 'feeder' && target !== 'verify') throw new BadRequestException({ error: 'target must be feeder or verify' });
    return this.readModelsOrFail().command({ type: 'scan', action, target, ...(docsPerSec ? { docsPerSec } : {}) }, 'admin');
  }

  /** Write a snapshot now (the lease holder does it). */
  @Post('read-models/snapshot')
  async readModelsSnapshot(@Headers('x-admin-secret') adminSecret: string | undefined) {
    this.assertAdmin(adminSecret);
    return this.readModelsOrFail().command({ type: 'snapshot' }, 'admin');
  }

  /** redis-models inventory: snapshot sets, sizes, TTLs, used_memory. */
  @Get('read-models/redis')
  async readModelsRedis(@Headers('x-admin-secret') adminSecret: string | undefined) {
    this.assertAdmin(adminSecret);
    return this.readModelsOrFail().inventory();
  }

  /** Run the redis-models janitor now (orphaned sets older than 2 min, old layouts). */
  @Post('read-models/redis/sweep')
  async readModelsSweep(@Headers('x-admin-secret') adminSecret: string | undefined) {
    this.assertAdmin(adminSecret);
    return this.readModelsOrFail().sweep();
  }

  private readModelsOrFail(): ReadModelsService {
    if (!this.readModels) throw new ServiceUnavailableException({ error: 'read models are not wired in this process' });
    return this.readModels;
  }

  /**
   * The ONLY gate on these legacy `x-admin-secret` ops routes (there is no
   * `@UseGuards` here on purpose — an `AdminJwtGuard` would break every
   * operator script that posts the header).
   *
   * FAILS CLOSED: an unset/empty `ADMIN_SECRET` used to `return` here, which
   * left `POST /admin/sync/run {"all":true,"fromStart":true}` reachable with no
   * credential at all — a cursor reset + full from-scratch rescan of every
   * enabled chain, loopable for unbounded RPC/subgraph spend. The repo's own
   * Dockerfile sets `NODE_ENV=production` and no `ADMIN_SECRET`, so that was
   * the shipped image's default posture. Production boots now refuse a missing
   * secret outright (`AppConfigService.validateSecurity`); this 401 is the
   * belt-and-braces for every other environment.
   */
  private assertAdmin(adminSecret: string | undefined): void {
    const expected = this.config.adminSecret;
    if (!expected) {
      throw new UnauthorizedException({ error: 'Admin routes are disabled — ADMIN_SECRET is not configured' });
    }
    if (adminSecret !== expected) {
      throw new ForbiddenException({ error: 'Invalid admin secret' });
    }
  }
}
