import { createCapacity, loadCapacity, reservedRows, describeCapacity, type PositionsCapacity } from '../capacity.js';
import { DeltaConsumer } from '../consumer/delta-consumer.js';
import { type ReadModelName, shardKey } from '../core/fields.js';
import { ModelStore, type StreamPosition } from '../core/model-store.js';
import { activeModels, isFeederCandidate, keepsModels, type ReadModelMode, type ReadModelsRole } from '../flags.js';
import type { RmKeys } from '../keys.js';
import { FeederMeter, processMemory, type AlertLog } from '../status.js';
import type { Lease, ModelsTransport, StateTransport } from '../transport.js';
import type { FeederHost } from './feeder-host.js';
import { HolderSession, type HolderConfig, type HolderEnd, type HolderStart } from './holder.js';
import { sweepModels } from './janitor.js';
import type { ShardCollection } from './messages.js';
import type { SnapshotSink } from './snapshot-sink.js';
import { loadSnapshotSet, type Manifest } from './snapshot-store.js';

/**
 * One process's read models (design §2.4–§2.5, §3.6): a consumer of the
 * delta stream, and — when its role allows — a candidate for the feeder lease.
 *
 * Lease (redis-state, TTL 15 s, renewed every 5 s; a non-holder retries every
 * 5 s). TAKEOVER ORDER, for a replica that wins it:
 *  1. take a new fence from the authority (redis-state `INCR`), renew, seed it
 *     into redis-models ("only if missing or greater");
 *  2. `XRANGE` from its last applied entry to the tail and apply everything
 *     (after step 1 no older-fence append can land);
 *  3. check that the cursor's (epoch, s) equals its last applied entry's
 *     (else reload from the manifest and try once more; still not → cold);
 *  4. (generations arrive with the engine core: nothing to swap in R1);
 *  5. start the feeder worker, resuming the change stream after the last
 *     entry's `rt`; `s` and the dictionary ids continue from the applied
 *     entries (apply-after-append keeps them identical on every replica).
 * A candidate with no model loads the newest manifest first; with none at all
 * it loads the durable copy (new epoch continuing it), else cold-starts. A
 * redis-models that was lost while this replica holds a model is continued
 * from memory (new incarnation, new epoch, `continues`) — no cold scan.
 *
 * DEMOTION (lease lost, fenced out): the holder session ends, its unappended
 * batch and tentative dictionary ids are discarded, and the replica carries
 * on as a consumer from its last applied entry — nothing to rebuild.
 */

export interface RuntimeConfig {
  role: ReadModelsRole;
  /** Every served shard collection of BOTH models (filtered by the active models). */
  shards: ShardCollection[];
  holder: HolderConfig;
  maxLagMs: number;
  /**
   * Positions rows reserved per table (`READ_MODELS_POSITIONS_CAPACITY`, see
   * `capacity.ts`): 0 = none (1.5 × loaded), a number = every positions
   * table, `{ perChain }` = only the listed chains' tables.
   */
  positionsCapacity: PositionsCapacity;
  leaseTtlMs: number;
  leaseRetryMs: number;
  /** After `oplog_too_short` the lease is not taken again for this long. */
  oplogRetryMs: number;
}

export interface RuntimeDeps {
  transport: ModelsTransport;
  state: StateTransport;
  keys: RmKeys;
  sink: SnapshotSink;
  createHost: () => FeederHost;
  alerts: AlertLog;
  pressure?: () => boolean;
  popCommand?: () => Promise<string | null>;
  onCommandDone?: (record: Record<string, unknown>) => Promise<void>;
  log?: (message: string) => void;
  now?: () => number;
  /** Lease owner id (specs). */
  owner?: string;
  /**
   * May this replica take the feeder lease now? False while it has dropped a
   * model's rows locally (the memory guard on a consumer): a holder feeds the
   * whole fleet, so it must hold every model the kill switch has on.
   */
  canHold?: () => boolean;
}

export type RuntimePhase = 'off' | 'consumer' | 'taking_over' | 'holder' | 'stopped';

export interface ModelReadiness {
  mode: ReadModelMode;
  ready: boolean;
  reason?: string;
  /**
   * The replica has applied the stream's tail (consumer) / has nothing
   * pending and confirmed recently (holder) — independent of the shards, so an
   * engine can still serve the shards that ARE ready while another scans.
   */
  caughtUp: boolean;
  /**
   * The engines can answer SOME of the model's shards (§7.2's fleet circuit
   * counts this, not `ready`): ready, or only some shards not ready (a
   * rescan) while the replica is caught up, fresh and holds at least one
   * ready shard — the engines serve the ready ones (`notServable`).
   */
  canServe: boolean;
  dataAt: number | null;
  lagMs: number | null;
  shards: Record<string, { state: string; rows: number; ready: boolean; quarantine: Record<string, number>; missingLeaves: string[] }>;
}

export class ReadModelsRuntime {
  phase: RuntimePhase = 'off';
  readonly store: ModelStore;
  readonly meter = new FeederMeter();
  readonly lease: Lease;
  consumer?: DeltaConsumer;
  holder?: HolderSession;
  modes: Record<ReadModelName, ReadModelMode>;
  takeovers = 0;
  lastTakeoverAt = 0;
  lastEnd?: HolderEnd & { at: number };
  private leaseTimer?: ReturnType<typeof setInterval>;
  private oplogRetryAt = 0;
  private stopped = false;
  private busy = false;
  private readonly now: () => number;
  readonly startedAt: number;

  constructor(
    private readonly deps: RuntimeDeps,
    private readonly config: RuntimeConfig,
    modes: Record<ReadModelName, ReadModelMode>,
  ) {
    this.now = deps.now ?? Date.now;
    this.modes = modes;
    this.startedAt = this.now();
    this.store = new ModelStore(activeModels(modes), {
      capacityFor: (model, shard) => createCapacity(config.positionsCapacity, model, shard),
      onQuarantine: (model, shard, leaf) =>
        deps.alerts.alert('read_models.quarantine', `${model} ${shard}: first row the engines cannot reproduce Mongo's semantics for in field ${leaf} — queries reading it there will go to Mongo`),
    });
    this.lease = deps.state.lease(deps.keys.lease, config.leaseTtlMs, deps.owner);
  }

  get role(): ReadModelsRole {
    return this.config.role;
  }

  /** The shard collections of the active models. */
  activeShards(): ShardCollection[] {
    return this.config.shards.filter((shard) => this.store.models.has(shard.model));
  }

  async start(): Promise<void> {
    this.stopped = false;
    if (this.store.models.size === 0 || !keepsModels(this.config.role)) {
      this.phase = 'off';
      return;
    }
    this.phase = 'consumer';
    this.consumer = this.newConsumer();
    if (isFeederCandidate(this.config.role)) {
      await this.tryLease();
      // Not the holder (or a takeover that failed already started one): follow the stream.
      if (!this.stopped && this.phase === 'consumer' && this.consumer && !this.consumer.running) this.consumer.start(this.store.pos.epoch > 0);
      this.leaseTimer = setInterval(() => void this.tryLease(), this.config.leaseRetryMs);
      this.leaseTimer.unref?.();
    } else {
      this.consumer.start(false);
    }
  }

  /** Shutdown: the holder appends what is pending and releases the lease; the consumer stops. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.leaseTimer = undefined;
    const holder = this.holder;
    this.holder = undefined;
    await holder?.stop({ flush: true });
    await this.lease.release().catch(() => undefined);
    await this.consumer?.stop();
    this.phase = 'stopped';
  }

  private newConsumer(): DeltaConsumer {
    return new DeltaConsumer({
      store: this.store,
      transport: this.deps.transport,
      load: (manifest) => this.loadManifest(manifest, this.deps.transport),
      alert: (name, detail) => this.deps.alerts.alert(name, detail),
      log: this.deps.log,
      now: this.now,
    });
  }

  // ── the lease ──

  private async tryLease(): Promise<void> {
    if (this.stopped || this.busy || this.phase === 'holder' || this.phase === 'taking_over' || this.phase === 'off') return;
    if (this.now() < this.oplogRetryAt) return;
    if (this.deps.canHold && !this.deps.canHold()) return;
    this.busy = true;
    try {
      const got = await this.lease.acquire();
      if (got !== 'acquired') return;
      this.phase = 'taking_over';
      await this.consumer?.stop();
      try {
        await this.takeover();
      } catch (err) {
        this.deps.alerts.alert('read_models.takeover_failed', `${(err as Error)?.message ?? String(err)} — releasing the lease`);
        this.holder = undefined;
        await this.lease.release().catch(() => undefined);
        this.becomeConsumer(this.store.pos.epoch > 0);
      }
    } finally {
      this.busy = false;
    }
  }

  private becomeConsumer(loaded: boolean): void {
    if (this.stopped) return;
    this.phase = 'consumer';
    this.consumer = this.newConsumer();
    this.consumer.start(loaded);
  }

  private async takeover(): Promise<void> {
    const { transport, state } = this.deps;
    const ttl = this.config.holder.liveTtlMs;
    const fence = await state.nextFence(this.now());
    if (!(await this.lease.renew())) throw new Error('lease lost during takeover');
    const { inc, created } = await transport.ensureIncarnation(ttl);
    if (!(await transport.seedFence(fence, ttl))) throw new Error(`a greater fence than ${fence} is on redis-models`);
    this.takeovers++;
    this.lastTakeoverAt = this.now();
    // Every replica's sweep is idempotent; the holder runs it when it takes the lease.
    void sweepModels(transport, this.deps.keys, { writingTtlMs: this.config.holder.writingTtlMs }).catch(() => undefined);

    let start: HolderStart | undefined;
    const hasModel = this.store.pos.epoch > 0;
    if (hasModel && !created && inc === this.store.pos.inc) {
      start = (await this.catchUpAndCheck()) ? { kind: 'resume' } : undefined;
      if (!start) {
        const manifest = await transport.manifest();
        if (manifest) {
          await this.loadManifest(manifest, transport);
          start = (await this.catchUpAndCheck()) ? { kind: 'resume' } : { kind: 'cold' };
        } else start = { kind: 'cold' };
      }
    } else if (hasModel) {
      this.store.pos = { ...this.store.pos, inc };
      start = { kind: 'continue', why: created ? 'redis-models was empty' : 'the redis-models incarnation changed' };
    } else {
      const manifest = created ? null : await transport.manifest();
      if (manifest) {
        await this.loadManifest(manifest, transport);
        start = (await this.catchUpAndCheck()) ? { kind: 'resume' } : { kind: 'cold' };
      } else {
        const durable = await this.deps.sink.latest().catch(() => null);
        if (durable) {
          await this.loadManifest(durable, this.deps.sink);
          this.store.pos = { ...this.store.pos, inc };
          start = { kind: 'continue', why: 'loaded the durable snapshot copy (redis-models had no manifest)' };
        } else start = { kind: 'cold' };
      }
    }
    this.deps.log?.(`feeder lease taken: fence ${fence}, start ${start.kind}`);
    await this.startHolder(fence, inc, start);
  }

  /** Steps 2–3 of the takeover order: apply the stream tail, then check the cursor. */
  private async catchUpAndCheck(): Promise<boolean> {
    const consumer = this.consumer ?? this.newConsumer();
    for (;;) {
      const entries = await this.deps.transport.range(this.store.pos.id, 1_000);
      if (entries.length === 0) break;
      if (!(await consumer.applyAll(entries))) return false;
    }
    const cursor = await this.deps.transport.cursor();
    return !cursor || (cursor.epoch === this.store.pos.epoch && cursor.s === this.store.pos.s);
  }

  private async startHolder(fence: number, inc: string, start: HolderStart): Promise<void> {
    const holder = new HolderSession({
      store: this.store,
      transport: this.deps.transport,
      keys: this.deps.keys,
      lease: this.lease,
      fence,
      inc,
      shards: this.activeShards(),
      createHost: this.deps.createHost,
      sink: this.deps.sink,
      alerts: this.deps.alerts,
      meter: this.meter,
      config: this.config.holder,
      pressure: this.deps.pressure,
      popCommand: this.deps.popCommand,
      onCommandDone: this.deps.onCommandDone,
      log: this.deps.log,
      now: this.now,
      onEnd: (end) => void this.onHolderEnd(holder, fence, inc, end),
    });
    this.holder = holder;
    this.phase = 'holder';
    await holder.start(start);
  }

  private async onHolderEnd(holder: HolderSession, fence: number, inc: string, end: HolderEnd): Promise<void> {
    if (this.holder !== holder) return;
    this.holder = undefined;
    this.lastEnd = { ...end, at: this.now() };
    if (this.stopped || end.kind === 'stopped') return;
    switch (end.kind) {
      case 'lease_lost':
      case 'fenced_out':
        this.deps.alerts.alert('read_models.lease_lost', `${end.kind}${'detail' in end ? `: ${end.detail}` : ''} — continuing as a consumer`);
        await this.lease.release().catch(() => undefined);
        this.becomeConsumer(this.store.pos.epoch > 0);
        return;
      case 'diverged':
        this.deps.alerts.alert('read_models.diverged', `${end.detail} — reloading from the newest manifest`);
        await this.lease.release().catch(() => undefined);
        this.becomeConsumer(false);
        return;
      case 'oplog_too_short':
        await this.lease.release().catch(() => undefined);
        this.oplogRetryAt = this.now() + this.config.oplogRetryMs;
        this.becomeConsumer(this.store.pos.epoch > 0);
        return;
      case 'new_epoch':
        // Keep the lease: a fresh cold scan into a new epoch (§3.6). The session's
        // CURRENT incarnation (a recovery inside it may have re-created it), never
        // the one captured at the takeover: a stale one makes the new epoch's
        // first manifest refused (inc_mismatch) and forces a recovery mid-snapshot.
        await this.startHolder(fence, (await this.deps.transport.incarnation().catch(() => null)) ?? holder.inc, { kind: 'cold' });
        return;
      case 'worker_failed':
        this.deps.alerts.alert('read_models.worker_failed', `${end.detail} — restarting the feeder in 5 s`);
        await sleep(5_000);
        if (this.stopped || this.holder) return;
        if (!(await this.lease.renew())) {
          this.becomeConsumer(this.store.pos.epoch > 0);
          return;
        }
        await this.startHolder(fence, (await this.deps.transport.incarnation().catch(() => null)) ?? inc, this.store.pos.epoch > 0 && this.store.pos.rt ? { kind: 'resume' } : { kind: 'cold' });
        return;
    }
  }

  /** Replace the store's tables and position with a manifest's snapshot (from redis-models or the durable sink). */
  async loadManifest(manifest: Manifest, from: { getChunk(key: string): Promise<Uint8Array | null> }): Promise<void> {
    // Drop the old tables BEFORE building the new ones: holding both doubles the
    // off-heap peak of a reload (every replica reloads at once on a new epoch).
    // The model is NOT READY meanwhile (position epoch 0 ⇒ `not_loaded`); a
    // failed load leaves it empty, and the caller reloads / cold-starts.
    this.store.clear();
    const loaded = await loadSnapshotSet({
      transport: from,
      keys: this.deps.keys,
      manifest,
      models: this.store.models,
      capacityFor: (model, shard, rows) => loadCapacity(this.config.positionsCapacity, model, shard, rows),
      onQuarantine: this.store.onQuarantine,
    });
    this.store.clear();
    for (const table of loaded.tables) this.store.setTable(table);
    const pos: StreamPosition = {
      fence: manifest.fence,
      epoch: manifest.epoch,
      s: manifest.s,
      id: manifest.streamId,
      rt: manifest.rt,
      ct: manifest.ct,
      ca: manifest.ca,
      inc: manifest.inc,
      ...(manifest.frozen ? { frozen: true } : {}),
    };
    this.store.pos = pos;
    for (const missing of loaded.missing) {
      this.deps.alerts.alert('read_models.field_backfill', `${missing.model} ${missing.shard}: the snapshot lacks ${missing.leaves.join(', ')} — the holder rescans the shard`);
    }
  }

  /** The kill switch (or the env) changed the modes: drop / add models (§2.2). */
  async applyModes(modes: Record<ReadModelName, ReadModelMode>): Promise<void> {
    const before = activeModels(this.modes);
    const after = activeModels(modes);
    this.modes = modes;
    const removed = [...before].filter((m) => !after.has(m));
    const added = [...after].filter((m) => !before.has(m));
    if (removed.length === 0 && added.length === 0) return;
    if (after.size === 0) {
      await this.stop();
      this.store.clear();
      this.store.models = new Set();
      this.phase = 'off';
      return;
    }
    if (before.size === 0) {
      this.store.models = after;
      await this.start();
      return;
    }
    for (const model of removed) {
      this.store.models.delete(model);
      this.store.dropModel(model);
    }
    for (const model of added) this.store.models.add(model);
    if (this.holder) {
      // Restart the feeder with the new shard set: removed models' shards stop
      // flowing; added models' shards (no table yet) get in-epoch shard scans.
      const holder = this.holder;
      const fence = holder.fence;
      const inc = holder.inc;
      this.holder = undefined;
      await holder.stop({ flush: true });
      await this.startHolder(fence, inc, { kind: 'resume' });
    } else if (added.length > 0) {
      this.consumer?.requestReload(`model ${added.join(', ')} turned on`);
    }
  }

  /** Readiness per model (§6.7), checked per request by the engines. */
  readiness(now = this.now()): Record<ReadModelName, ModelReadiness> {
    const out = {} as Record<ReadModelName, ModelReadiness>;
    const holder = this.holder;
    const caughtUp = holder ? holder.caughtUp(now) : (this.consumer?.caughtUp(now) ?? false);
    const dataAt = holder ? holder.lastCa || null : this.store.pos.ca || null;
    for (const model of ['rank', 'pools'] as const) {
      const mode = this.modes[model];
      const shards: ModelReadiness['shards'] = {};
      let shardsReady = true;
      let anyReady = false;
      for (const shard of this.config.shards.filter((s) => s.model === model)) {
        const key = shardKey(shard.chainId, shard.protocol);
        const table = this.store.table(model, key);
        const ready = Boolean(table && table.state === 'ready' && table.missingLeaves.size === 0);
        if (!ready && table?.state !== 'unsupported') shardsReady = false;
        if (ready) anyReady = true;
        shards[key] = {
          state: table?.state ?? 'absent',
          rows: table?.live ?? 0,
          ready,
          quarantine: table?.quarantineCounts() ?? {},
          missingLeaves: table ? [...table.missingLeaves].map((l) => table.leaves[l].name) : [],
        };
      }
      let reason: string | undefined;
      if (mode === 'off') reason = 'off';
      else if (this.phase === 'off' || this.phase === 'stopped') reason = 'not_running';
      else if (this.store.pos.epoch === 0 && !holder) reason = 'not_loaded';
      else if (holder && holder.phase !== 'running') reason = `holder_${holder.phase}`;
      else if (!shardsReady) reason = 'shard_not_ready';
      else if (!caughtUp) reason = 'not_caught_up';
      else if (dataAt === null || now - dataAt >= this.config.maxLagMs) reason = 'lag';
      const fresh = dataAt !== null && now - dataAt < this.config.maxLagMs;
      const canServe = reason === undefined || (reason === 'shard_not_ready' && anyReady && caughtUp && fresh);
      out[model] = { mode, ready: reason === undefined, ...(reason ? { reason } : {}), caughtUp, canServe, dataAt, lagMs: dataAt === null ? null : now - dataAt, shards };
    }
    return out;
  }

  /** `/admin/sync/status` → `readModels`. */
  status(now = this.now()) {
    const holder = this.holder;
    const consumer = this.consumer;
    const pos = this.store.pos;
    return {
      phase: this.phase,
      role: this.config.role,
      modes: this.modes,
      models: [...this.store.models],
      replica: this.lease.owner,
      holder: holder
        ? {
            phase: holder.phase,
            fence: holder.fence,
            epoch: holder.epoch,
            inc: holder.inc,
            appendedS: holder.appended.s,
            pendingRows: holder.pendingRows,
            blockedRows: holder.blockedRows,
            lastConfirmAgoMs: holder.lastConfirmAt ? now - holder.lastConfirmAt : null,
            lastAppendAgoMs: holder.lastAppendAt ? now - holder.lastAppendAt : null,
            resumeToken: holder.latestRt,
            resumeCt: holder.latestCt,
            worker: holder.workerStats ?? null,
            caughtUp: holder.caughtUp(now),
          }
        : null,
      consumer: consumer
        ? {
            phase: consumer.phase,
            floor: consumer.floor,
            applied: consumer.applied,
            skipped: consumer.skipped,
            reloads: consumer.reloads,
            lastReloadReason: consumer.lastReloadReason ?? null,
            caughtUp: consumer.caughtUp(now),
          }
        : null,
      position: { fence: pos.fence, epoch: pos.epoch, s: pos.s, streamId: pos.id, ct: pos.ct, inc: pos.inc },
      dataAt: (holder ? holder.lastCa : pos.ca) ? new Date(holder ? holder.lastCa : pos.ca).toISOString() : null,
      lagMs: (holder ? holder.lastCa : pos.ca) ? now - (holder ? holder.lastCa : pos.ca) : null,
      takeovers: this.takeovers,
      lastTakeoverAt: this.lastTakeoverAt ? new Date(this.lastTakeoverAt).toISOString() : null,
      lastHolderEnd: this.lastEnd ? { ...this.lastEnd, at: new Date(this.lastEnd.at).toISOString() } : null,
      feeder: this.meter.snapshot(now),
      readiness: this.readiness(now),
      store: { bytes: this.store.memoryBytes, tables: this.store.stats() },
      positionsCapacity: this.capacityStatus(),
      memory: processMemory(),
      alerts: this.deps.alerts.snapshot(),
    };
  }

  /** The reservation per positions table: configured rows next to the table's actual capacity (C-cap). */
  private capacityStatus() {
    const shards: Record<string, { reservedRows: number; capacity: number | null; rows: number | null; bytes: number | null }> = {};
    for (const shard of this.config.shards) {
      if (shard.model !== 'rank') continue;
      const key = shardKey(shard.chainId, shard.protocol);
      const table = this.store.table('rank', key);
      shards[key] = { reservedRows: reservedRows(this.config.positionsCapacity, key), capacity: table?.capacity ?? null, rows: table?.live ?? null, bytes: table?.memoryBytes ?? null };
    }
    return { configured: describeCapacity(this.config.positionsCapacity), shards };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
