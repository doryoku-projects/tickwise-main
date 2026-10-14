import { Inject, Injectable, Logger, Optional, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import { getHeapStatistics } from 'node:v8';
import type { Connection } from 'mongoose';
import { AppConfigService } from '../config/app-config.service.js';
import { SECONDARY_ONLY_READ_PREFERENCE, USER_READ_PREFERENCE } from '../database/user-read.js';
import { shutdownSignal } from '../common/shutdown.js';
import { ReadBudgetService } from '../common/read-budget.js';
import { AdminCommands, type AdminCommand } from './admin-commands.js';
import { capacityReport, type CapacityReport } from './capacity.js';
import { createEngineRunner, type EngineRunner } from './core/engine-runner.js';
import { READ_MODEL_NAMES, collectionOf, type ReadModelName } from './core/fields.js';
import type { ModelStore } from './core/model-store.js';
import { DEFAULT_HOLDER_CONFIG, type HolderConfig } from './feeder/holder.js';
import { InThreadFeederHost, WorkerFeederHost, type FeederHost } from './feeder/feeder-host.js';
import { ReadModelsRuntime } from './feeder/feeder.service.js';
import { inventoryModels, sweepModels } from './feeder/janitor.js';
import type { ShardCollection } from './feeder/messages.js';
import { snapshotSinkFor, type SnapshotSink } from './feeder/snapshot-sink.js';
import { MongoFeederSource } from './feeder/source.js';
import { Fleet, FLEET_EVERY_MS, fleetCircuit } from './fleet.js';
import { activeModels, configuredModes, effectiveModes, idleFeederReason, isFeederCandidate, keepsModels, lowerMode, resolveRole, type ReadModelMode } from './flags.js';
import { KillSwitch, lowers } from './killswitch.js';
import { rmKeys, type RmKeys } from './keys.js';
import { containerLimit, MemoryGuard, modelCapBytes } from './memory-guard.js';
import { healthReady, type HealthReadyResult } from './readiness.js';
import { CircuitWatcher, degradedRoute, DegradedTracker, modelDegradedReason, NARROW_WIRED, splitFallbacks } from './router.js';
import { DataParityLane, MongoDataParityReader } from './shadow/data-parity.js';
import { LaneABudget } from './shadow/pools-lane-a.js';
import { aggregateCoverage, COVERAGE_RECORD_TTL_MS, coverageRecord, fleetGate, shadowSummary } from './shadow/summary.js';
import { ModelsRedis } from './models-redis.js';
import { RedisModelsTransport, RedisStateTransport } from './redis-transport.js';
import { StateRedis } from './state-redis.js';
import { AlertLog } from './status.js';
import { MemoryModelsTransport, MemoryRedis, MemoryStateTransport, type ModelsTransport, type StateTransport } from './transport.js';

/** How often a replica re-reads the fleet heartbeats for the circuit (a SCAN of redis-state): the holder, everyone else. */
const CIRCUIT_EVERY_HOLDER_MS = 15_000;
const CIRCUIT_EVERY_OTHER_MS = 60_000;
/** How often a replica publishes its shadow-lane counters for the cross-replica gate. */
const COVERAGE_EVERY_MS = 60_000;

/**
 * The read models' Nest face (Phase P-R, R1): config → flags → transports →
 * `ReadModelsRuntime`, plus the kill switch poll, the fleet heartbeat, the
 * admin operations and the `/admin/sync/status` block.
 *
 * With every model `off` (the default) this does NOTHING: no Redis
 * connection, no key, no worker, no Mongo read — today's behaviour exactly.
 * The kill switch is read before any model loads (§2.2), and then every 5 s.
 *
 * No Redis: production keeps the models NOT READY and raises
 * `[alert] read_models.redis_unavailable` (N private feeders on M10 is never
 * the fallback, §2.4); anywhere else the process runs a private feeder on
 * in-memory transports (self-consistent, shared with nobody).
 */
@Injectable()
export class ReadModelsService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('ReadModels');
  readonly alerts = new AlertLog(this.logger);
  private runtime?: ReadModelsRuntime;
  private keysCache?: RmKeys;
  private models?: ModelsTransport;
  private state?: StateTransport;
  private killSwitch?: KillSwitch;
  private fleet?: Fleet;
  private commands?: AdminCommands;
  private sink?: SnapshotSink;
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private bootRetry?: ReturnType<typeof setTimeout>;
  private pressure = false;
  private transportKind: 'redis' | 'memory' | 'none' = 'none';
  private policy?: { policy?: string; maxmemory?: number; refused?: boolean };
  private stopping = false;
  /** The mode sync in progress (kill switch, memory guard, override — ONE at a time). */
  private syncing?: Promise<void>;
  private resync = false;
  /** The runtime finished its first start (mode changes wait for it). */
  private started = false;
  /** The modes an override just wrote (its own sync does not alert them as a kill-switch change). */
  private expectKill?: Record<ReadModelName, ReadModelMode>;
  private guardTimer?: ReturnType<typeof setInterval>;
  /** Lane B's sample reads: their own bucket, never the user read budget. */
  private readonly laneBBudget = new LaneABudget();
  /** When this process started (the `/health/ready` timeout and the degraded "still loading" window). */
  readonly bootAt = Date.now();
  /** R4: model-level degraded transitions, the fleet circuit, the memory guard, lane B. */
  readonly degraded: DegradedTracker;
  readonly circuit: CircuitWatcher;
  private memoryGuard?: MemoryGuard;
  /** The guard's off-heap cap (C-cap: what the positions reservation is checked against). */
  private guardCapBytes?: number;
  private capacityChecked = false;
  private laneB?: DataParityLane;
  private lastKill?: Record<ReadModelName, ReadModelMode>;
  private circuitAt = 0;
  private coverageAt = 0;
  private readonly shedders = new Map<string, (stage: 80 | 85) => void>();
  private observer?: ReturnType<typeof setInterval>;

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Optional() @Inject(ModelsRedis) private readonly modelsRedis?: ModelsRedis,
    @Optional() @Inject(StateRedis) private readonly stateRedis?: StateRedis,
    @Optional() @Inject(ReadBudgetService) private readonly readBudget?: ReadBudgetService,
    // R4 (lane B's snapshot reads): appended, @Optional — specs construct this positionally.
    @Optional() @Inject(getConnectionToken()) private readonly connection?: Connection,
  ) {
    const log = (message: string) => this.logger.log(message);
    this.degraded = new DegradedTracker(this.alerts, log, this.bootAt, this.readyTimeoutMs);
    this.circuit = new CircuitWatcher(this.alerts, log, Date.now, this.bootAt, this.readyTimeoutMs);
  }

  private get readyTimeoutMs(): number {
    const v = (this.config as { readModelsReadyTimeoutMs?: number }).readModelsReadyTimeoutMs;
    return typeof v === 'number' && v > 0 ? v : 300_000;
  }

  /** The env's modes (before the kill switch). */
  configuredModes(): Record<ReadModelName, ReadModelMode> {
    return configuredModes({
      readModelsMode: this.config.readModelsMode,
      poolCatalogMode: this.config.poolCatalogMode,
      rankEngineMode: this.config.rankEngineMode,
    });
  }

  /** Is any model configured on? (`off` everywhere = this service is inert.) */
  get enabled(): boolean {
    return activeModels(this.configuredModes()).size > 0;
  }

  get keys(): RmKeys {
    this.keysCache ??= rmKeys(this.config.leaderboardSnapshotNamespace);
    return this.keysCache;
  }

  onApplicationBootstrap(): void {
    this.warnIdleFeeder();
    if (!this.enabled) return;
    // Never on the boot path: listen() does not wait for a snapshot load.
    void this.boot();
    shutdownSignal().addEventListener('abort', () => void this.shutdown(), { once: true });
    // The degraded tracker watches from boot, runtime or not (production
    // without Redis never gets one, and that is exactly a state to alert on).
    this.observer = setInterval(() => this.observeDegraded(), 5_000);
    this.observer.unref?.();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.shutdown();
  }

  /**
   * `[alert] process_role.idle_feeder` once at boot when PROCESS_ROLE=feeder
   * has nothing to do (`idleFeederReason`): the process is healthy and idle,
   * which a deploy dashboard cannot tell from a working feeder.
   */
  private warnIdleFeeder(): void {
    const reason = idleFeederReason(this.config.processRole, this.config.readModelsRole, this.configuredModes());
    if (!reason) return;
    this.logger.warn(`[alert] process_role.idle_feeder PROCESS_ROLE=feeder but ${reason} — this process does no work (it only answers /health)`);
  }

  private async shutdown(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.bootRetry) clearTimeout(this.bootRetry);
    if (this.observer) clearInterval(this.observer);
    if (this.guardTimer) clearInterval(this.guardTimer);
    for (const timer of this.timers.splice(0)) clearInterval(timer);
    await this.runtime?.stop().catch(() => undefined);
  }

  /** The served shard collections of both models (enabled integrations). */
  servedShards(): ShardCollection[] {
    const out: ShardCollection[] = [];
    for (const { chainId, protocol } of this.config.enabledIntegrations) {
      for (const model of READ_MODEL_NAMES) out.push({ coll: collectionOf(model, chainId, protocol), model, chainId, protocol });
    }
    return out;
  }

  private holderConfig(): HolderConfig {
    const interval = this.config.readModelsSnapshotIntervalMs;
    const hint = this.config.readModelsOplogWindowHintMs;
    return {
      ...DEFAULT_HOLDER_CONFIG,
      // READ_MODELS_SNAPSHOT_ENCODE_TIMEOUT_MS (default 20 s = the former
      // hard-coded cap). A config without the getter (specs) reads undefined,
      // which `snapshotEncodeCapMs` turns into the same 20 s.
      maxEncodeMs: this.config.readModelsSnapshotEncodeTimeoutMs,
      snapshotIntervalMs: interval,
      liveTtlMs: Math.max(3 * interval, hint),
      feeder: {
        scanDocsPerSec: this.config.readModelsScanDocsPerSec,
        oplogWindowHintMs: hint,
        // Production scans fail rather than load the primary (§3.2).
        scanReadPreference: this.config.isProduction ? 'secondary' : 'secondaryPreferred',
      },
    };
  }

  private createHost = (): FeederHost => {
    const uri = this.config.mongodbUri;
    const scanReadPreference = this.config.isProduction ? 'secondary' : 'secondaryPreferred';
    if (this.config.readModelsWorkers === 0) {
      return new InThreadFeederHost(() => new MongoFeederSource({ uri, scanReadPreference }));
    }
    return new WorkerFeederHost({ uri, maxOldGenerationSizeMb: 256 });
  };

  /** Pick the transports: Redis when it answers; in-memory outside production; none (retry) in production. */
  private async transports(): Promise<boolean> {
    if (this.models && this.state) return true;
    const [control, state] = await Promise.all([this.modelsRedis?.control(), this.stateRedis?.get()]);
    if (control && state && this.modelsRedis && this.stateRedis) {
      const models = this.modelsRedis;
      this.models = new RedisModelsTransport({ control: () => models.control(), blocking: () => models.blocking(), bulk: () => models.bulk() }, this.keys);
      const stateRedis = this.stateRedis;
      this.state = new RedisStateTransport(() => stateRedis.get(), this.keys);
      this.transportKind = 'redis';
      const policy = await models.checkPolicy();
      this.policy = { policy: policy.policy, maxmemory: policy.maxmemory, refused: policy.refused };
      for (const alert of policy.alerts) {
        this.alerts.alert(alert, alert.endsWith('policy') ? `redis-models maxmemory-policy is ${this.policy.policy} (must be noeviction): an evicted chunk or stream entry is silent data loss` : 'redis-models maxmemory is 0 (unbounded): it would OOM instead of refusing writes');
      }
      if (!models.separate) this.logger.log('read models: REDIS_MODELS_URL unset — the models share REDIS_URL (dev / rig)');
      return true;
    }
    if (this.config.isProduction) {
      this.alerts.alert('read_models.redis_unavailable', 'no Redis answers: the read models stay NOT READY (retrying every 10 s)');
      return false;
    }
    const memory = new MemoryRedis();
    this.models = new MemoryModelsTransport(memory, this.keys);
    this.state = new MemoryStateTransport(memory, this.keys);
    this.transportKind = 'memory';
    this.logger.warn('read models: no Redis — running a PRIVATE feeder on in-memory transports (dev only; nothing is shared)');
    return true;
  }

  private async boot(): Promise<void> {
    if (this.stopping) return;
    if ((this.config as { readModelsServePercentValid?: boolean }).readModelsServePercentValid === false) {
      this.alerts.alert('read_models.config', 'READ_MODELS_SERVE_PERCENT is not a number: read as 0 (fail closed — every request goes to Mongo)');
    }
    try {
      if (!(await this.transports())) {
        this.bootRetry = setTimeout(() => void this.boot(), 10_000);
        this.bootRetry.unref?.();
        return;
      }
      const sink = snapshotSinkFor(this.config.readModelsDurableSnapshotUrl);
      if (sink.error) this.alerts.alert('read_models.durable_snapshot_unsupported', sink.error);
      this.sink = sink.sink;
      this.killSwitch = new KillSwitch(this.state!, this.keys);
      this.fleet = new Fleet(this.state!, this.keys);
      this.commands = new AdminCommands(this.state!, this.keys);
      // The kill switch is read BEFORE anything loads (§2.2) — and so is
      // memory (§4.11): a model the guard sheds does not load at all.
      const kill = effectiveModes(this.configuredModes(), await this.killSwitch.read());
      this.lastKill = kill;
      this.memoryGuard ??= this.createMemoryGuard();
      this.memoryGuard.check(readMemory(), Date.now());
      this.checkPositionsCapacity();
      // The guard runs on its OWN timer from here — before the first load (the
      // takeover's snapshot load is the biggest memory event) and whatever the
      // mode sync is doing.
      this.guardTimer ??= setInterval(() => this.guardTick(), 5_000);
      this.guardTimer.unref?.();
      const modes = this.applyShed(kill);
      const role = resolveRole(this.config.readModelsRole, this.config.processRole);
      const commands = this.commands;
      this.runtime = new ReadModelsRuntime(
        {
          transport: this.models!,
          state: this.state!,
          keys: this.keys,
          sink: this.sink,
          createHost: this.createHost,
          alerts: this.alerts,
          pressure: () => this.pressure,
          popCommand: () => this.popCommand(commands),
          onCommandDone: (record) => commands.recordDone(record),
          log: (message) => this.logger.log(message),
          canHold: () => this.holdsEveryModel(),
        },
        {
          role,
          shards: this.servedShards(),
          holder: this.holderConfig(),
          maxLagMs: this.config.readModelsMaxLagMs,
          positionsCapacity: this.config.readModelsPositionsCapacity,
          leaseTtlMs: 15_000,
          leaseRetryMs: 5_000,
          oplogRetryMs: 5 * 60_000,
        },
        modes,
      );
      this.logger.log(
        `read models: rank=${modes.rank} pools=${modes.pools} role=${role} redis=${this.transportKind}` +
          `${this.config.redisModelsSeparate ? ' (own instance)' : ''} workers=${this.config.readModelsWorkers}`,
      );
      await this.runtime.start();
      this.started = true;
      this.laneB ??= this.createLaneB();
      this.startTimers();
      // A shed or a kill-switch change that arrived during the first load.
      void this.syncModes().catch(() => undefined);
    } catch (err) {
      this.alerts.alert('read_models.boot_failed', `${(err as Error)?.message ?? String(err)} — retrying in 10 s`);
      this.bootRetry = setTimeout(() => void this.boot(), 10_000);
      this.bootRetry.unref?.();
    }
  }

  private startTimers(): void {
    const every = (ms: number, fn: () => Promise<unknown>) => {
      const timer = setInterval(() => void fn().catch(() => undefined), ms);
      timer.unref?.();
      this.timers.push(timer);
    };
    // The kill switch, every 5 s (it can only lower the env's modes; the memory guard has its own timer).
    every(5_000, () => this.syncModes());
    // Lane B (holder only; it does nothing on a consumer), every second.
    every(1_000, async () => {
      if (this.runtime?.phase === 'holder') await this.laneB?.tick();
    });
    // The cross-replica shadow counters (the rollout gate), every minute.
    every(COVERAGE_EVERY_MS, () => this.publishCoverage());
    // redis-models memory: the 70% alert (§2.3) also fires from this periodic check.
    every(30_000, async () => {
      this.memoryCache = undefined;
      await this.redisMemory();
    });
    // User-read pressure for the scans (this process, or the shared bucket).
    every(1_000, async () => {
      this.pressure = (await this.readBudget?.sharedPressure().catch(() => false)) ?? false;
    });
    // Fleet heartbeat (§7.2).
    every(FLEET_EVERY_MS, () => this.heartbeat());
  }

  // ── R4: degraded mode, memory guard, lane B, readiness ──

  /**
   * Apply the kill switch and the memory guard to the runtime — ONE sync at a
   * time (the 5 s poll, a guard transition, an override): a request that
   * arrives while one runs makes it run once more, so the last write wins and
   * no two `applyModes` ever overlap (an override racing a poll used to
   * re-apply the old modes over it and restart the holder twice).
   */
  syncModes(): Promise<void> {
    if (this.syncing) {
      this.resync = true;
      return this.syncing;
    }
    this.syncing = (async () => {
      try {
        do {
          this.resync = false;
          await this.applyModesNow();
        } while (this.resync && !this.stopping);
      } finally {
        this.syncing = undefined;
      }
    })();
    return this.syncing;
  }

  private async applyModesNow(): Promise<void> {
    if (!this.killSwitch || !this.runtime || !this.started || this.stopping) return;
    const kill = effectiveModes(this.configuredModes(), await this.killSwitch.read());
    const sameAs = (a?: Record<ReadModelName, ReadModelMode>) => Boolean(a && a.rank === kill.rank && a.pools === kill.pools);
    // This replica's own override (read back here, possibly on the next pass): not an alert.
    const own = sameAs(this.expectKill);
    if (own) this.expectKill = undefined;
    if (this.lastKill && !sameAs(this.lastKill) && !own) {
      this.alerts.alert('read_models.killswitch', `modes now rank=${kill.rank} pools=${kill.pools}`);
    }
    this.lastKill = kill;
    const modes = this.runtimeModes(kill);
    if (modes.rank !== this.runtime.modes.rank || modes.pools !== this.runtime.modes.pools) await this.runtime.applyModes(modes);
  }

  /**
   * The modes the RUNTIME (the R1 rows) runs with: the kill switch's — and on
   * a consumer, lowered for every model the memory guard shed (its rows are
   * this replica's own). The LEASE HOLDER keeps feeding every model the kill
   * switch has on: its rows are the fleet's delta stream, and dropping a model
   * there would freeze every consumer's copy of it (fresh `dataAt`, frozen
   * rows). A shed on the holder unloads only its engine (`effectiveMode`).
   */
  private runtimeModes(kill: Record<ReadModelName, ReadModelMode>): Record<ReadModelName, ReadModelMode> {
    return this.runtime?.phase === 'holder' || this.runtime?.phase === 'taking_over' ? kill : this.applyShed(kill);
  }

  /** May this replica take the feeder lease? Only while its runtime holds every model the kill switch has on. */
  private holdsEveryModel(): boolean {
    const runtime = this.runtime;
    const kill = this.lastKill;
    if (!runtime || !kill) return true;
    return READ_MODEL_NAMES.every((model) => kill[model] === 'off' || runtime.modes[model] !== 'off');
  }

  /** The memory guard's own 5 s check: a shed / reload transition syncs the modes at once. */
  private guardTick(now = Date.now()): void {
    const guard = this.memoryGuard;
    if (!guard || this.stopping) return;
    const before = READ_MODEL_NAMES.map((m) => guard.isShed(m)).join();
    guard.check(readMemory(), now);
    if (READ_MODEL_NAMES.map((m) => guard.isShed(m)).join() !== before) void this.syncModes().catch(() => undefined);
  }

  /** Does this process's role serve requests (both / server)? */
  private get serves(): boolean {
    const role = this.runtime?.role ?? resolveRole(this.config.readModelsRole, this.config.processRole);
    return role === 'both' || role === 'server';
  }

  /**
   * The models the fleet circuit is about: the ones the KILL SWITCH has on
   * (fleet-wide intent — an operator's kill to `off` is a rollback, not an
   * outage; a memory shed is local, so a shed replica still counts, as not
   * ready).
   */
  private circuitModels(): ReadModelName[] {
    const kill = this.lastKill ?? this.configuredModes();
    return READ_MODEL_NAMES.filter((m) => kill[m] !== 'off');
  }

  /** Fleet heartbeat (§7.2) every 5 s, and the circuit from everyone's heartbeats. */
  private async heartbeat(): Promise<void> {
    const runtime = this.runtime;
    if (!runtime || !this.fleet || !keepsModels(runtime.role)) return;
    const readiness = runtime.readiness();
    const ready: Partial<Record<ReadModelName, boolean>> = {};
    // A SERVING replica reports every model the kill switch has on: "can
    // serve" = the engines can answer some of its shards (a single shard's
    // rescan is not the model down), and a model this replica shed reports
    // NOT ready (absent replicas would not count, so a fleet that shed rank
    // everywhere would otherwise read as healthy). A role that serves nothing
    // reports nothing (it is not part of any model's capacity).
    const models = this.circuitModels();
    if (this.serves) for (const model of models) ready[model] = readiness[model].canServe && !this.isShed(model);
    await this.fleet.beat({
      replica: runtime.lease.owner,
      role: runtime.role,
      holder: runtime.phase === 'holder',
      ready,
      lastAppendAt: runtime.holder?.lastAppendAt ?? runtime.consumer?.lastAppliedAt ?? 0,
      at: Date.now(),
    });
    // The circuit (one read of redis-state): the holder every 15 s, the others every minute.
    const now = Date.now();
    if (now - this.circuitAt < (runtime.phase === 'holder' ? CIRCUIT_EVERY_HOLDER_MS : CIRCUIT_EVERY_OTHER_MS)) return;
    this.circuitAt = now;
    try {
      this.circuit.update(await this.fleet.members(), models);
    } catch {
      this.circuit.failed();
    }
  }

  /** The kill switch's modes, lowered to `off` for every model the memory guard shed. */
  private applyShed(modes: Record<ReadModelName, ReadModelMode>): Record<ReadModelName, ReadModelMode> {
    const guard = this.memoryGuard;
    if (!guard) return modes;
    return { rank: guard.isShed('rank') ? 'off' : modes.rank, pools: guard.isShed('pools') ? 'off' : modes.pools };
  }

  /** What READ_MODELS_POSITIONS_CAPACITY reserves on the served positions tables, against the guard's cap (C-cap). */
  private positionsReservation(): CapacityReport {
    return capacityReport(this.config.readModelsPositionsCapacity, this.shardKeys().rank, this.guardCapBytes, this.runsRankEngine());
  }

  /**
   * Does this process run the rank engine (`RankEngineService` starts only for
   * READ_MODELS_ROLE both / server with rank configured on)? Its frozen copy
   * is sized from the reserved capacity, so it doubles the reservation's cost.
   */
  private runsRankEngine(): boolean {
    if (this.configuredModes().rank === 'off') return false;
    const role = resolveRole(this.config.readModelsRole, this.config.processRole);
    return role === 'both' || role === 'server';
  }

  /**
   * Boot check (C-cap): log the per-table reservation, and alert when the
   * reservation alone — R1 tables plus, where it runs, the rank engine's copy
   * — would exceed the off-heap cap (the guard would unload rank the moment
   * the snapshot loads) or 70% of it (once shed, rank could never reload).
   * Never refuses the boot.
   */
  private checkPositionsCapacity(): void {
    if (this.capacityChecked) return; // once per process (a boot retry re-runs boot())
    this.capacityChecked = true;
    const report = this.positionsReservation();
    if (report.reservedRows === 0) return;
    const tables = Object.entries(report.shards).map(([shard, rows]) => `${shard}=${rows}`).join(' ');
    this.logger.log(
      `read models: positions reservation ${tables} (~${report.estimatedMb} MB off-heap: ${report.r1Mb} MB R1 tables + ${report.engineMb} MB rank engine copy${report.engine ? '' : ' — no engine on this replica'})`,
    );
    if (report.overCap || report.overReload) {
      const tableCount = Object.keys(report.shards).length;
      const consequence = report.overCap
        ? `over the ${report.capMb} MB off-heap cap — the memory guard will unload rank on load`
        : `over 70% of the ${report.capMb} MB off-heap cap — once the memory guard sheds rank it can never reload (it reloads only under 70%)`;
      this.alerts.alert(
        'read_models.capacity',
        `READ_MODELS_POSITIONS_CAPACITY reserves ~${report.estimatedMb} MB (${report.r1Mb} MB R1 + ${report.engineMb} MB rank engine) across ${tableCount} positions table(s), ${consequence}; reserve per chain (e.g. 4663:6000000) or raise READ_MODELS_MAX_MB`,
      );
    }
  }

  private createMemoryGuard(): MemoryGuard {
    const containerBytes = containerLimit();
    const capBytes = modelCapBytes(this.config.readModelsMaxMb ?? 0, containerBytes, getHeapStatistics().heap_size_limit);
    this.guardCapBytes = capBytes;
    return new MemoryGuard({ containerBytes, capBytes }, this.alerts, (message) => this.logger.log(message), (stage) => this.shed(stage));
  }

  /** An engine registers how it drops caches at the 80% / 85% memory stages (§4.11). */
  registerShedder(name: string, shed: (stage: 80 | 85) => void): void {
    this.shedders.set(name, shed);
  }

  private shed(stage: 80 | 85): void {
    for (const [name, shed] of this.shedders) {
      try {
        shed(stage);
      } catch (err) {
        this.logger.warn(`memory shedder ${name} failed: ${(err as Error)?.message ?? err}`);
      }
    }
  }

  /** Is `model` unloaded on this replica by the memory guard? */
  isShed(model: ReadModelName): boolean {
    return this.memoryGuard?.isShed(model) ?? false;
  }

  /** Model-level degraded state (§7.2), every 5 s from boot. */
  private observeDegraded(): void {
    const serves = this.serves;
    const configured = this.configuredModes();
    const kill = this.lastKill ?? configured;
    const runtime = this.runtime;
    const running = Boolean(runtime && runtime.phase !== 'off' && runtime.phase !== 'stopped');
    const readiness = running ? runtime!.readiness() : null;
    for (const model of READ_MODEL_NAMES) {
      this.degraded.observe(
        model,
        modelDegradedReason({ configured: configured[model], effective: kill[model], shed: this.isShed(model), running, readiness: readiness?.[model] ?? null, serves }),
      );
    }
  }

  /**
   * The route of a request the engine did not take (§7.2): today's P1 path,
   * or `narrow` while the fleet circuit is open and the policy says so (D-2;
   * not wired into the list services yet — `NARROW_WIRED`).
   */
  degradedRoute(model: ReadModelName): 'p1' | 'narrow' {
    return degradedRoute(this.config.readModelsDegradedPolicy ?? 'p1', this.circuit.isOpen(model));
  }

  /** `GET /health/ready` (§6.7 / §13). */
  healthReady(now = Date.now()): HealthReadyResult {
    const runtime = this.runtime;
    const modes = runtime ? this.servingModes() : this.enabled ? this.applyShed(this.lastKill ?? this.configuredModes()) : null;
    const role = runtime?.role ?? resolveRole(this.config.readModelsRole, this.config.processRole);
    return healthReady({ enabled: this.enabled, serves: this.serves, role, modes, readiness: runtime?.readiness(now) ?? null, bootAt: this.bootAt, now, timeoutMs: this.readyTimeoutMs });
  }

  /** The holder's command poll: a `scan` command also paces lane B's verification scan (§14). */
  private async popCommand(commands: AdminCommands): Promise<string | null> {
    const raw = await commands.pop();
    if (raw) {
      try {
        const command = JSON.parse(raw) as { type?: unknown; action?: unknown; docsPerSec?: unknown };
        if (command.type === 'scan') this.laneB?.applyScanCommand(command);
      } catch {
        // the holder reports an unparseable command
      }
    }
    return raw;
  }

  private createLaneB(): DataParityLane {
    const readPreference = this.config.isProduction ? SECONDARY_ONLY_READ_PREFERENCE : USER_READ_PREFERENCE;
    const connection = this.connection;
    return new DataParityLane({
      source: () => {
        const runtime = this.runtime;
        const holder = runtime?.holder;
        if (!runtime || runtime.phase !== 'holder' || !holder) return undefined;
        let scanning = false;
        for (const table of runtime.store.tables.values()) if (table.state === 'scanning') scanning = true;
        return { store: runtime.store, consistent: holder.blockedRows === 0, scanning, session: `${holder.fence}:${holder.startedAt}` };
      },
      shards: () => this.servedShards().filter((s) => (this.runtime?.modes[s.model] ?? 'off') !== 'off'),
      reader: new MongoDataParityReader(() => (connection?.db as never) ?? undefined, readPreference),
      alert: (name, detail, key) => this.alerts.alert(name, detail, key),
      evidence: (name, detail) => this.alerts.evidence(name, detail),
      rescan: async (model, shard) => {
        await this.commands?.push({ type: 'rescan', model, shard }, 'lane-b');
      },
      pressure: () => this.pressure,
      verifyDocsPerSec: () => this.config.readModelsVerifyDocsPerSec ?? 0,
      // Lane B's own bucket (never the user read budget), skipped under user pressure.
      reserve: async (docs) => !this.pressure && !this.readBudget?.underPressure() && this.laneBBudget.take(docs),
    });
  }

  /** Publish this process's cumulative lane counters (§7.3's gate is fleet-wide and spans deploys): one field of ONE hash. */
  private async publishCoverage(): Promise<void> {
    if (!this.state || !this.runtime) return;
    const now = Date.now();
    this.coverageAt = now;
    const record = coverageRecord(this.runtime.lease.owner, this.bootAt, now, this.engines(), this.laneB?.status());
    await this.state.hset(this.keys.shadowCoverage, `${this.runtime.lease.owner}:${this.bootAt}`, JSON.stringify(record), COVERAGE_RECORD_TTL_MS);
  }

  /** Every live coverage record (one `HGETALL`); records older than the TTL are dropped and deleted. */
  private async coverageRecords(): Promise<string[]> {
    const rows = await this.state!.hgetall(this.keys.shadowCoverage);
    const now = Date.now();
    const live: string[] = [];
    const stale: string[] = [];
    for (const [field, value] of Object.entries(rows)) {
      let at = 0;
      try {
        at = Number((JSON.parse(value) as { at?: unknown }).at) || 0;
      } catch {
        // garbled: dropped
      }
      if (now - at < COVERAGE_RECORD_TTL_MS) live.push(value);
      else stale.push(field);
    }
    if (stale.length > 0) await this.state!.hdel(this.keys.shadowCoverage, stale).catch(() => undefined);
    return live;
  }

  /** Served shard keys per model (`chainId:protocol`), for the gates. */
  private shardKeys(): { rank: string[]; pools: string[] } {
    const out = { rank: [] as string[], pools: [] as string[] };
    for (const shard of this.servedShards()) out[shard.model].push(`${shard.chainId}:${shard.protocol}`);
    return out;
  }

  /** Readiness per model (the R2/R3 per-request gate; null while off). */
  readiness() {
    return this.runtime?.readiness() ?? null;
  }

  /**
   * This process's SERVING mode for `model` — what the engines run with:
   * the runtime's mode, `off` while no runtime runs it or the memory guard
   * shed it here (on the lease holder the R1 rows keep feeding; only the
   * engine is unloaded).
   */
  effectiveMode(model: ReadModelName): ReadModelMode {
    if (this.isShed(model)) return 'off';
    return this.runtime?.modes[model] ?? 'off';
  }

  /** `effectiveMode` for both models. */
  servingModes(): Record<ReadModelName, ReadModelMode> {
    return { rank: this.effectiveMode('rank'), pools: this.effectiveMode('pools') };
  }

  /**
   * What the pool catalog (R2) builds from: this process's model store and
   * the served pools shards — undefined while the pools model is not held
   * here (off, booting, role without models).
   */
  catalogSource(): { store: ModelStore; shards: Array<{ chainId: number; protocol: string }> } | undefined {
    const runtime = this.runtime;
    if (!runtime || runtime.phase === 'off' || runtime.phase === 'stopped') return undefined;
    if (!runtime.store.models.has('pools')) return undefined;
    return { store: runtime.store, shards: this.servedShards().filter((shard) => shard.model === 'pools') };
  }

  /**
   * What the rank engine (R3) builds from: this process's model store and the
   * served positions shards — undefined while the rank model is not held here.
   */
  rankSource(): { store: ModelStore; shards: Array<{ chainId: number; protocol: string }> } | undefined {
    const runtime = this.runtime;
    if (!runtime || runtime.phase === 'off' || runtime.phase === 'stopped') return undefined;
    if (!runtime.store.models.has('rank')) return undefined;
    return { store: runtime.store, shards: this.servedShards().filter((shard) => shard.model === 'rank') };
  }

  private engineRunner?: EngineRunner;
  private readonly engineUsers = new Set<string>();

  /**
   * The ONE engine runner of this process (design §4.10: `READ_MODELS_WORKERS`
   * pass workers per process, shared by the pool catalog and the rank engine).
   * Created on the first acquire, stopped when its last user releases it.
   */
  acquireEngine(user: string): EngineRunner {
    this.engineRunner ??= createEngineRunner(this.config.readModelsWorkers, {
      onAlert: (name, detail) => this.alerts.alert(name, detail),
    });
    this.engineUsers.add(user);
    return this.engineRunner;
  }

  async releaseEngine(user: string): Promise<void> {
    this.engineUsers.delete(user);
    if (this.engineUsers.size > 0 || !this.engineRunner) return;
    const runner = this.engineRunner;
    this.engineRunner = undefined;
    await runner.stop();
  }

  /**
   * One lane-A shadow check may run now: at most `READ_MODELS_SHADOW_MAX_PER_MIN`
   * across processes (redis-state `INCR` per minute; this process alone when
   * there is no state transport).
   */
  async shadowTicket(maxPerMin: number): Promise<boolean> {
    if (maxPerMin <= 0) return false;
    const minute = Math.floor(Date.now() / 60_000);
    if (this.state) {
      try {
        return (await this.state.incr(this.keys.shadowCounter(minute), 120_000)) <= maxPerMin;
      } catch {
        return false;
      }
    }
    if (this.localShadow.minute !== minute) this.localShadow = { minute, count: 0 };
    return ++this.localShadow.count <= maxPerMin;
  }

  private localShadow = { minute: 0, count: 0 };

  private readonly engineStatus = new Map<string, () => unknown>();

  /** An engine (R2 pool catalog, R3 rank engine) adds its block to `readModels.engines`. */
  registerStatus(name: string, block: () => unknown): void {
    this.engineStatus.set(name, block);
  }

  private engines(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [name, block] of this.engineStatus) {
      try {
        out[name] = block();
      } catch (err) {
        out[name] = { error: (err as Error)?.message ?? String(err) };
      }
    }
    return out;
  }

  /** `/admin/sync/status` → `readModels`. */
  async status(): Promise<Record<string, unknown>> {
    const configured = this.configuredModes();
    if (!this.enabled) return { mode: 'off', configured };
    const memory = await this.redisMemory();
    const base: Record<string, unknown> = {
      configured,
      killSwitch: this.killSwitch?.current() ?? null,
      redis: {
        transport: this.transportKind,
        separate: this.config.redisModelsSeparate,
        policy: this.policy ?? null,
        usedMemory: memory?.used ?? null,
        maxMemory: memory?.max ?? null,
        usedShare: memory && memory.max > 0 ? Math.round((memory.used / memory.max) * 1000) / 1000 : null,
      },
      pressure: this.pressure,
    };
    const engines = this.engines();
    const r4 = this.r4Status(engines);
    if (!this.runtime) return { ...base, phase: 'booting', engines, ...r4, alerts: this.alerts.snapshot() };
    let fleet: unknown = null;
    try {
      const members = (await this.fleet?.members()) ?? [];
      fleet = { members, circuit: fleetCircuit(members, this.circuitModels()) };
    } catch {
      fleet = null;
    }
    const lastCommand = await this.commands?.last().catch(() => null);
    let shadowFleet: unknown = null;
    if (this.state) {
      try {
        shadowFleet = fleetGate(aggregateCoverage(await this.coverageRecords()), this.shardKeys());
      } catch {
        shadowFleet = { error: 'redis-state unavailable' };
      }
    }
    return {
      ...base,
      ...this.runtime.status(),
      engines,
      ...r4,
      shadow: { ...(r4.shadow as Record<string, unknown>), fleet: shadowFleet, publishedAgoMs: this.coverageAt ? Date.now() - this.coverageAt : null },
      fleet,
      lastCommand: lastCommand ?? null,
    };
  }

  /** The R4 blocks: router (degraded + circuit + per-request reasons), memory guard, readiness, shadow lanes. */
  private r4Status(engines: Record<string, unknown>): Record<string, unknown> {
    const policy = this.config.readModelsDegradedPolicy ?? 'p1';
    const requests: Record<string, unknown> = {};
    for (const model of READ_MODEL_NAMES) {
      const fallback = (engines[model] as { requests?: { fallback?: Record<string, number> } } | undefined)?.requests?.fallback;
      if (fallback) requests[model] = splitFallbacks(fallback);
    }
    return {
      router: {
        policy: {
          configured: policy,
          effective: policy === 'narrow' && !NARROW_WIRED ? 'p1' : policy,
          ...(policy === 'narrow' && !NARROW_WIRED ? { note: 'narrow is not wired into the list services yet (D-2): degraded requests take the P1 path' } : {}),
        },
        degraded: this.degraded.snapshot(),
        circuit: this.circuit.snapshot(),
        requests,
      },
      memoryGuard: this.memoryGuard ? { ...this.memoryGuard.status(Date.now()), positionsReservation: this.positionsReservation() } : null,
      ready: this.healthReady().body,
      shadow: shadowSummary({ engines, laneB: this.laneB?.status(), shards: this.shardKeys() }),
    };
  }

  private memoryCache?: { at: number; value: { used: number; max: number; policy?: string } | null };

  /** redis-models `INFO memory` (cached 5 s; `[alert] read_models.redis_memory` at ≥ 70% of maxmemory). */
  private async redisMemory(): Promise<{ used: number; max: number; policy?: string } | null> {
    const now = Date.now();
    if (this.memoryCache && now - this.memoryCache.at < 5_000) return this.memoryCache.value;
    const value = this.models ? await this.models.memory().catch(() => null) : null;
    this.memoryCache = { at: now, value };
    if (value && value.max > 0 && value.used >= value.max * DEFAULT_HOLDER_CONFIG.redisMemoryRatio) {
      this.alerts.alert('read_models.redis_memory', `redis-models used_memory ${value.used} is ${Math.round((value.used / value.max) * 100)}% of maxmemory ${value.max}`);
    }
    return value;
  }

  // ── admin operations (§14) ──

  private async ensureControl(): Promise<{ state: StateTransport; models: ModelsTransport }> {
    if (!(await this.transports())) throw new Error('Redis is unavailable');
    return { state: this.state!, models: this.models! };
  }

  /** The kill switch: lower one model's mode (`serve` clears the override). */
  async override(model: ReadModelName, mode: ReadModelMode, by: string): Promise<Record<string, unknown>> {
    const { state } = await this.ensureControl();
    this.killSwitch ??= new KillSwitch(state, this.keys);
    const stored = await this.killSwitch.write(model, mode, by);
    const configured = this.configuredModes();
    const effective = effectiveModes(configured, stored);
    // Applied through the ONE mode sync (never beside a poll in flight); this
    // replica's own write is not reported as a kill-switch change.
    this.expectKill = effective;
    if (this.runtime) await this.syncModes();
    else this.lastKill = effective;
    return {
      model,
      requested: mode,
      configured: configured[model],
      effective: effective[model],
      lowered: lowers(configured[model], mode),
      note: lowerMode(configured[model], mode) === configured[model] && mode !== configured[model] ? 'the kill switch only lowers: the env mode stands' : undefined,
      killSwitch: stored,
    };
  }

  /** Queue an admin command for the lease holder. */
  async command(command: AdminCommand, by: string): Promise<Record<string, unknown>> {
    const { state } = await this.ensureControl();
    this.commands ??= new AdminCommands(state, this.keys);
    const id = await this.commands.push(command, by);
    const holder = this.runtime?.phase === 'holder';
    return { queued: id, command, ...(this.runtime ? { thisReplicaHolds: holder } : { note: 'no read model is running in this process; the lease holder (if any) takes it' }) };
  }

  async inventory(): Promise<Record<string, unknown>> {
    const { models } = await this.ensureControl();
    return { ...(await inventoryModels(models, this.keys)), separate: this.config.redisModelsSeparate };
  }

  async sweep(): Promise<Record<string, unknown>> {
    const { models } = await this.ensureControl();
    return { ...(await sweepModels(models, this.keys, { writingTtlMs: DEFAULT_HOLDER_CONFIG.writingTtlMs })) };
  }

  /** Can this process hold the lease? (status / specs) */
  get candidate(): boolean {
    return isFeederCandidate(resolveRole(this.config.readModelsRole, this.config.processRole));
  }
}

/** RSS and off-heap bytes for the memory guard. */
function readMemory(): { rss: number; arrayBuffers: number } {
  const m = process.memoryUsage();
  return { rss: m.rss, arrayBuffers: m.arrayBuffers };
}
