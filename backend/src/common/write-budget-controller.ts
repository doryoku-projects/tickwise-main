import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { MongoMonitor, type MongoMonitorReading } from '../database/mongo-monitor.js';
import { writeLagMs } from '../database/replication-lag.js';
import { RedisLease } from './redis-lease.js';
import { can } from './process-role.js';
import { registerStatusContributor, unregisterStatusContributor } from './process-status.js';
import { LATENCY_TTL_MS, WriteBudgetService } from './write-budget.js';
import {
  BACKFILL_ACTIVE_WINDOW_MS,
  CHUNK_SIZE_CLASSES,
  DIRTY_RED_PCT,
  OPLOG_BACKFILL_RED_SEC,
  OPLOG_RED_SEC,
  quantile,
  type ChunkSizeClass,
  type WriteBudgetSettings,
} from './write-budget-model.js';

/*
 * The write budget's AIMD controller (P2.4, design §5.3). ONE holder
 * fleet-wide (Redis lease `wb-controller`, 15 s TTL, renewed every 5 s tick)
 * computes R every 5 s and writes it with a 30 s TTL; every acquirer reads it
 * inside its Lua call. No holder → the rate key expires → acquirers run at
 * `WRITE_BUDGET_MIN` (and log `write_budget.controller_missing`).
 *
 *   input                 source                                      red when
 *   per-unit latency      p95 of ms/units, chunk classes ≤500 + >500  > UNIT_LATENCY_RED_MS (2.0)
 *   small-chunk latency   p95 ms of the ≤100-op class                 > LATENCY_RED_MS (150)
 *   lag                   primary majority lag + worst secondary      > LAG_RED_MS (5 s)
 *   dirty %, oplog        MONGO_MONITOR_URI (`mongo-monitor.ts`)      dirty > 10 %; window < 2 h,
 *                                                                     or < 3 h while backfill consumed (5 min)
 *   hourly use            Σ minute counters, last 60 min              > H × 3600
 *
 * Any red but hourly → R = max(MIN, R/2). Hourly red → R = max(MIN, min(R, H)).
 * All green for 60 s → R = min(MAX, R × 1.1) (then another 60 s).
 *
 * WHY per-unit latency and size classes: a whole-chunk p95 of 150 ms made
 * every idle 500-op chunk red (~250 ms at ~0.5 ms/op on M10); the per-unit
 * figure is flat across sizes, and the small-chunk class keeps an absolute
 * latency check where a per-unit figure is noisy.
 *
 * Runs in every role but `feeder` (`settings.runController`), only while the
 * budget is on. Not gated on PROCESS_LEASES: the rate key is shared by every
 * process on the Redis, so its writer must be single whatever the role mode.
 */

export const CONTROLLER_TICK_MS = 5_000;
export const CONTROLLER_LEASE_TTL_MS = 15_000;
/**
 * The longest a tick waits for the Mongo monitor's sample (serverStatus + two
 * oplog reads have no server-side time limit); past it the tick uses the
 * monitor's last reading. Keeps every tick well inside the lease TTL, so a
 * saturated primary (the case the budget exists for) cannot hang the
 * controller — or let a deposed holder write a stale R after another took over.
 */
export const MONITOR_SAMPLE_DEADLINE_MS = 4_000;
/** R (and the status hash) expire this long after the holder's last tick. */
export const RATE_TTL_MS = 30_000;
/** All inputs green this long → one +10 % step. */
export const GREEN_HOLD_MS = 60_000;
export const INCREASE_FACTOR = 1.1;
/** Time at MIN within the trailing hour above this share → `[alert] write_budget.floor`. */
export const FLOOR_ALERT_SHARE = 0.2;
const HOUR_MS = 3_600_000;
const FLOOR_ALERT_EVERY_MS = 10 * 60_000;
const OVERRIDE_ALERT_EVERY_MS = HOUR_MS;

export type RedReason = 'unit_latency' | 'small_latency' | 'lag' | 'dirty' | 'oplog' | 'oplog_backfill' | 'hourly';

export interface ControllerInputs {
  /** p95 of ms/unit over the ≤500 and >500 classes; null = no samples. */
  unitP95MsPerUnit: number | null;
  /** p95 ms of the ≤100 class; null = no samples. */
  smallP95Ms: number | null;
  lagMs: number | null;
  dirtyPct: number | null;
  oplogWindowSec: number | null;
  /** The backfill lane took units in the last 5 min. */
  backfillActive: boolean;
  /** Units taken in the last 60 min, fleet-wide; null = unknown. */
  hourlyUnits: number | null;
}

export interface ControllerState {
  rate: number;
  /** Start of the current all-green stretch (null after a red tick). */
  greenSince: number | null;
}

export type ControllerAction = 'halve' | 'cap' | 'increase' | 'hold';

/** Which inputs are red. Absent inputs are never red. */
export function redReasons(inputs: ControllerInputs, settings: WriteBudgetSettings): RedReason[] {
  const reasons: RedReason[] = [];
  if (inputs.unitP95MsPerUnit !== null && inputs.unitP95MsPerUnit > settings.unitLatencyRedMs) reasons.push('unit_latency');
  if (inputs.smallP95Ms !== null && inputs.smallP95Ms > settings.latencyRedMs) reasons.push('small_latency');
  if (inputs.lagMs !== null && inputs.lagMs > settings.lagRedMs) reasons.push('lag');
  if (inputs.dirtyPct !== null && inputs.dirtyPct > DIRTY_RED_PCT) reasons.push('dirty');
  if (inputs.oplogWindowSec !== null) {
    if (inputs.oplogWindowSec < OPLOG_RED_SEC) reasons.push('oplog');
    else if (inputs.backfillActive && inputs.oplogWindowSec < OPLOG_BACKFILL_RED_SEC) reasons.push('oplog_backfill');
  }
  if (inputs.hourlyUnits !== null && inputs.hourlyUnits > settings.hourlyPerSec * 3600) reasons.push('hourly');
  return reasons;
}

/** One AIMD step (pure). */
export function controllerStep(
  state: ControllerState,
  inputs: ControllerInputs,
  settings: WriteBudgetSettings,
  now: number,
  /**
   * Reasons still red ONLY on evidence a previous halving already acted on
   * (latency samples older than the last halving, still inside the 30 s
   * window). They block the green clock (no increase) but never halve again:
   * one burst of slow chunks halves R once, not once per 5 s tick for 30 s.
   */
  heldRed: readonly RedReason[] = [],
): { state: ControllerState; reasons: RedReason[]; action: ControllerAction } {
  const fresh = redReasons(inputs, settings);
  const reasons = [...fresh, ...heldRed.filter((r) => !fresh.includes(r))];
  const clamp = (r: number) => Math.min(settings.maxPerSec, Math.max(settings.minPerSec, r));
  let rate = clamp(state.rate);
  let greenSince = state.greenSince;
  let action: ControllerAction = 'hold';
  if (fresh.some((reason) => reason !== 'hourly')) {
    rate = clamp(rate / 2);
    greenSince = null;
    action = 'halve';
  } else if (heldRed.length > 0) {
    greenSince = null;
  }
  if (fresh.includes('hourly')) {
    const capped = Math.max(settings.minPerSec, Math.min(rate, settings.hourlyPerSec));
    if (action !== 'halve' && capped < rate) action = 'cap';
    rate = capped;
    greenSince = null;
  }
  if (reasons.length === 0) {
    if (greenSince === null) {
      greenSince = now;
    } else if (now - greenSince >= GREEN_HOLD_MS) {
      const next = clamp(rate * INCREASE_FACTOR);
      if (next > rate) action = 'increase';
      rate = next;
      greenSince = now;
    }
  }
  return { state: { rate, greenSince }, reasons, action };
}

/** One latency sample as pushed by `WriteBudgetService.recordChunk`: `ms:units:ops:at`. */
export function parseLatencySample(raw: string): { ms: number; units: number; ops: number; at: number } | null {
  const [ms, units, ops, at] = raw.split(':').map(Number);
  if (![ms, units, ops, at].every((v) => Number.isFinite(v))) return null;
  return { ms: ms!, units: units!, ops: ops!, at: at! };
}

/** The two latency inputs from the three class lists (samples newer than `since`). */
export function latencyInputs(
  lists: Record<ChunkSizeClass, readonly string[]>,
  since: number,
): { unitP95MsPerUnit: number | null; smallP95Ms: number | null; samples: Record<ChunkSizeClass, number> } {
  const perUnit: number[] = [];
  const small: number[] = [];
  const samples = { s: 0, m: 0, l: 0 } as Record<ChunkSizeClass, number>;
  for (const cls of CHUNK_SIZE_CLASSES) {
    for (const raw of lists[cls] ?? []) {
      const sample = parseLatencySample(raw);
      if (!sample || sample.at < since) continue;
      samples[cls]++;
      if (cls === 's') small.push(sample.ms);
      else if (sample.units > 0) perUnit.push(sample.ms / sample.units);
    }
  }
  return { unitP95MsPerUnit: quantile(perUnit, 0.95), smallP95Ms: quantile(small, 0.95), samples };
}

export interface ControllerSnapshot {
  enabled: boolean;
  holder: boolean;
  rate: number | null;
  reasons: RedReason[];
  action: ControllerAction | null;
  inputs: ControllerInputs | null;
  lastTickAt: number | null;
  /** Share of the trailing hour this holder kept R at MIN. */
  floorShareLastHour: number;
}

@Injectable()
export class WriteBudgetController implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WriteBudgetController.name);
  private timer?: ReturnType<typeof setInterval>;
  private lease?: RedisLease;
  private holder = false;
  private state: ControllerState | null = null;
  private running = false;
  private lastReasons: RedReason[] = [];
  private lastAction: ControllerAction | null = null;
  private lastInputs: ControllerInputs | null = null;
  private lastTickAt: number | null = null;
  /** Ticks of the trailing hour while holder: when, and whether R sat at MIN since the previous one. */
  private ticks: Array<{ at: number; atMinMs: number; spanMs: number }> = [];
  private readonly alertedAt = new Map<string, number>();
  private readonly now: () => number;
  /** When this holder last halved R (latency samples up to then are acted-on evidence). */
  private lastHalvedAt: number | null = null;
  /** A monitor sample still running from an earlier tick (never two at once). */
  private monitorInFlight?: Promise<MongoMonitorReading>;

  constructor(
    @Inject(WriteBudgetService) private readonly budget: WriteBudgetService,
    @Optional() @Inject(MongoMonitor) private readonly monitor?: MongoMonitor,
    // Specs only: a fake clock and lag source.
    @Optional() private readonly hooks?: { now?: () => number; lag?: () => { lagMs: number | null } },
  ) {
    this.now = hooks?.now ?? Date.now;
  }

  private get settings(): WriteBudgetSettings {
    return this.budget.settings;
  }

  /** Runs here at all (budget on, role allows it: every role but `feeder`, design §2.2). */
  get enabled(): boolean {
    return this.budget.enabled && this.settings.runController && can('write-budget-controller');
  }

  onModuleInit(): void {
    // Status fan-in (design §2.1): this process's budget view, every role.
    registerStatusContributor('writeBudget', () => this.budget.snapshot());
    if (!this.enabled) return;
    const s = this.settings;
    if (s.hourlyClamped) {
      this.logger.warn(
        `write budget: WRITE_BUDGET_HOURLY_UNITS_PER_SEC=${s.hourlyRequestedPerSec} needs MONGO_MONITOR_URI above ` +
          `0.5 × MAX = ${0.5 * s.maxPerSec}; clamped to H=${s.hourlyPerSec} (decision D-6)`,
      );
    }
    // Background, never awaited (an awaited wait in onModuleInit blocks listen() and the healthcheck).
    this.timer = setInterval(() => void this.tick().catch(() => undefined), CONTROLLER_TICK_MS);
    this.timer.unref?.();
    setImmediate(() => void this.tick().catch(() => undefined));
  }

  async onModuleDestroy(): Promise<void> {
    unregisterStatusContributor('writeBudget');
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.holder) await this.lease?.release();
    this.holder = false;
  }

  /**
   * One controller tick: take/renew the lease; as holder, read the inputs,
   * step R and write it. Public for specs. Never throws; overlapping ticks
   * are skipped.
   */
  async tick(): Promise<{ holder: boolean; rate: number | null; reasons: RedReason[]; action: ControllerAction | null }> {
    if (!this.enabled || this.running) return { holder: this.holder, rate: this.state?.rate ?? null, reasons: this.lastReasons, action: null };
    this.running = true;
    try {
      const client = await this.budget.redisClient();
      if (!client) {
        this.holder = false;
        return { holder: false, rate: null, reasons: [], action: null };
      }
      this.lease ??= new RedisLease(() => this.budget.redisClient(), this.budget.keys.lease, CONTROLLER_LEASE_TTL_MS);
      const got = await this.lease.acquire();
      if (got !== 'acquired') {
        if (this.holder) this.logger.warn(`write budget: wb-controller lease lost (${got}); another process steers R`);
        this.holder = false;
        this.state = null;
        return { holder: false, rate: null, reasons: [], action: null };
      }
      const keys = this.budget.keys;
      const now = this.now();
      if (!this.holder || !this.state) {
        // Fresh holder: continue from the fleet's R if one is still live, else start.
        const stored = Number(await client.get(keys.rate).catch(() => null));
        const start = Number.isFinite(stored) && stored > 0 ? stored : this.settings.startPerSec;
        this.state = { rate: Math.min(this.settings.maxPerSec, Math.max(this.settings.minPerSec, start)), greenSince: null };
        this.holder = true;
        this.ticks = [];
        this.lastHalvedAt = null;
        this.logger.log(`write budget: wb-controller acquired, R=${this.state.rate} u/s`);
      }
      const { inputs, heldRed } = await this.readInputs(client, now);
      // Still ours? The inputs took time (a saturated primary's serverStatus);
      // a holder deposed meanwhile must not overwrite the new holder's R.
      if (!(await this.lease.renew())) {
        this.logger.warn('write budget: wb-controller lease lost during the tick; R not written');
        this.holder = false;
        this.state = null;
        return { holder: false, rate: null, reasons: [], action: null };
      }
      const prevRate = this.state.rate;
      const step = controllerStep(this.state, inputs, this.settings, now, heldRed);
      if (step.action === 'halve') this.lastHalvedAt = now;
      this.state = step.state;
      this.lastReasons = step.reasons;
      this.lastAction = step.action;
      this.lastInputs = inputs;
      this.noteTick(now, prevRate);
      this.lastTickAt = now;
      await client
        .pipeline()
        .set(keys.rate, String(step.state.rate), 'PX', RATE_TTL_MS)
        .hset(keys.ctl, {
          rate: String(step.state.rate),
          reasons: step.reasons.join(','),
          action: step.action,
          at: String(now),
          holder: this.lease.owner,
          inputs: JSON.stringify(inputs),
        })
        .pexpire(keys.ctl, RATE_TTL_MS)
        .exec();
      this.alerts(now);
      return { holder: true, rate: step.state.rate, reasons: step.reasons, action: step.action };
    } catch (err) {
      this.logger.warn(`write budget controller tick failed: ${(err as Error)?.message ?? String(err)}`);
      return { holder: this.holder, rate: this.state?.rate ?? null, reasons: this.lastReasons, action: null };
    } finally {
      this.running = false;
    }
  }

  snapshot(): ControllerSnapshot {
    const now = this.now();
    const ticks = this.ticks.filter((t) => t.at >= now - HOUR_MS);
    const atMin = ticks.reduce((sum, t) => sum + t.atMinMs, 0);
    return {
      enabled: this.enabled,
      holder: this.holder,
      rate: this.state?.rate ?? null,
      reasons: this.lastReasons,
      action: this.lastAction,
      inputs: this.lastInputs,
      lastTickAt: this.lastTickAt,
      floorShareLastHour: Math.round((atMin / HOUR_MS) * 1000) / 1000,
    };
  }

  /**
   * Everything `GET /admin/sync/status` → `writeBudget` shows, from any
   * process: this process's budget view, this controller, and the fleet's
   * last decision (`hourlyPct` = last hour's units / (H × 3600)).
   */
  async status(): Promise<
    ReturnType<WriteBudgetService['snapshot']> & {
      controller: ControllerSnapshot;
      fleet: Awaited<ReturnType<WriteBudgetController['fleetStatus']>>;
      hourlyPct: number | null;
    }
  > {
    const fleet = this.budget.enabled ? await this.fleetStatus() : null;
    const inputs = (this.lastInputs ?? (fleet?.inputs as ControllerInputs | null | undefined)) ?? null;
    const hourly = inputs?.hourlyUnits ?? null;
    return {
      ...this.budget.snapshot(),
      controller: this.snapshot(),
      fleet,
      hourlyPct: hourly === null ? null : Math.round((hourly / (this.settings.hourlyPerSec * 3600)) * 1000) / 10,
    };
  }

  /** The fleet's controller state as the holder last wrote it (any process). */
  async fleetStatus(): Promise<{ rate: number | null; reasons: string[]; action: string | null; at: number | null; holder: string | null; inputs: unknown } | null> {
    const client = await this.budget.redisClient();
    if (!client) return null;
    try {
      const ctl = await client.hgetall(this.budget.keys.ctl);
      if (!ctl || Object.keys(ctl).length === 0) return { rate: null, reasons: [], action: null, at: null, holder: null, inputs: null };
      let inputs: unknown = null;
      try {
        inputs = ctl.inputs ? JSON.parse(ctl.inputs) : null;
      } catch {
        inputs = null;
      }
      return {
        rate: Number(ctl.rate) || null,
        reasons: ctl.reasons ? ctl.reasons.split(',') : [],
        action: ctl.action ?? null,
        at: Number(ctl.at) || null,
        holder: ctl.holder ?? null,
        inputs,
      };
    } catch {
      return null;
    }
  }

  /**
   * The inputs for one tick, plus the reasons red only on latency evidence a
   * previous halving already acted on (`heldRed`, see `controllerStep`).
   */
  private async readInputs(
    client: NonNullable<Awaited<ReturnType<WriteBudgetService['redisClient']>>>,
    now: number,
  ): Promise<{ inputs: ControllerInputs; heldRed: RedReason[] }> {
    const keys = this.budget.keys;
    const minute = Math.floor(now / 60_000);
    const pipe = client.pipeline();
    for (const cls of CHUNK_SIZE_CLASSES) pipe.lrange(keys.latency(cls), 0, -1);
    for (let i = 0; i < 60; i++) pipe.hmget(keys.minute(minute - i), 'all', 'backfill');
    const replies = (await pipe.exec()) ?? [];
    const lists = { s: [], m: [], l: [] } as Record<ChunkSizeClass, string[]>;
    CHUNK_SIZE_CLASSES.forEach((cls, i) => {
      const [err, value] = replies[i] ?? [null, []];
      lists[cls] = !err && Array.isArray(value) ? (value as string[]) : [];
    });
    let hourly = 0;
    let backfillUnits = 0;
    const backfillMinutes = Math.ceil(BACKFILL_ACTIVE_WINDOW_MS / 60_000);
    for (let i = 0; i < 60; i++) {
      const [err, value] = replies[CHUNK_SIZE_CLASSES.length + i] ?? [null, null];
      if (err || !Array.isArray(value)) continue;
      hourly += Number(value[0]) || 0;
      if (i < backfillMinutes) backfillUnits += Number(value[1]) || 0;
    }
    const windowStart = now - LATENCY_TTL_MS;
    const freshStart = this.lastHalvedAt === null ? windowStart : Math.max(windowStart, this.lastHalvedAt + 1);
    const latency = latencyInputs(lists, freshStart);
    const lag = this.hooks?.lag?.() ?? writeLagMs(now);
    let monitor: MongoMonitorReading | null = null;
    if (this.monitor?.configured) monitor = await this.sampleMonitor(this.monitor);
    const inputs: ControllerInputs = {
      unitP95MsPerUnit: latency.unitP95MsPerUnit,
      smallP95Ms: latency.smallP95Ms,
      lagMs: lag.lagMs,
      dirtyPct: monitor?.dirtyPct ?? null,
      oplogWindowSec: monitor?.oplogWindowSec ?? null,
      backfillActive: backfillUnits > 0,
      hourlyUnits: hourly,
    };
    let heldRed: RedReason[] = [];
    if (freshStart > windowStart) {
      const whole = latencyInputs(lists, windowStart);
      const fresh = redReasons(inputs, this.settings);
      heldRed = redReasons({ ...inputs, unitP95MsPerUnit: whole.unitP95MsPerUnit, smallP95Ms: whole.smallP95Ms }, this.settings).filter(
        (r) => (r === 'unit_latency' || r === 'small_latency') && !fresh.includes(r),
      );
    }
    return { inputs, heldRed };
  }

  /**
   * The monitor's sample, bounded by `MONITOR_SAMPLE_DEADLINE_MS`: past it the
   * last reading (`current()`) stands in, and the slow sample keeps running in
   * the background — the next tick reuses it rather than starting a second.
   */
  private async sampleMonitor(monitor: MongoMonitor): Promise<MongoMonitorReading> {
    const sample = (this.monitorInFlight ??= monitor.sample().finally(() => {
      this.monitorInFlight = undefined;
    }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<MongoMonitorReading>((resolve) => {
      timer = setTimeout(() => resolve(monitor.current()), MONITOR_SAMPLE_DEADLINE_MS);
      timer.unref?.();
    });
    try {
      return await Promise.race([sample, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Book the span since the previous tick as "at MIN" when R sat there. */
  private noteTick(now: number, prevRate: number): void {
    const last = this.ticks[this.ticks.length - 1];
    const span = last ? Math.min(now - last.at, CONTROLLER_TICK_MS * 3) : 0;
    this.ticks.push({ at: now, spanMs: span, atMinMs: prevRate <= this.settings.minPerSec ? span : 0 });
    const cutoff = now - HOUR_MS;
    while (this.ticks.length > 0 && this.ticks[0]!.at < cutoff) this.ticks.shift();
  }

  private alerts(now: number): void {
    const s = this.settings;
    const atMin = this.ticks.reduce((sum, t) => sum + t.atMinMs, 0);
    if (atMin > FLOOR_ALERT_SHARE * HOUR_MS) {
      this.alert(
        'floor',
        FLOOR_ALERT_EVERY_MS,
        now,
        `[alert] write_budget.floor atMinMs=${atMin} of the last hour (> ${FLOOR_ALERT_SHARE * 100} %) R=${this.state?.rate} ` +
          `MIN=${s.minPerSec} reasons=${this.lastReasons.join(',') || 'none'} — runbook: pause the backfill first`,
      );
    }
    if (s.hourlyPerSec > 0.5 * s.maxPerSec) {
      this.alert(
        'hourly_override',
        OVERRIDE_ALERT_EVERY_MS,
        now,
        `[alert] write_budget.hourly_override H=${s.hourlyPerSec} > 0.5 × MAX=${0.5 * s.maxPerSec} (MONGO_MONITOR_URI set; decision D-6)`,
      );
    }
  }

  private alert(key: string, everyMs: number, now: number, line: string): void {
    if (now - (this.alertedAt.get(key) ?? Number.NEGATIVE_INFINITY) < everyMs) return;
    this.alertedAt.set(key, now);
    this.logger.warn(line);
  }
}
