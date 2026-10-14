import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AppConfigService } from '../config/app-config.service.js';
import { LazyClient, ROLE_OPTIONS } from '../read-models/models-redis.js';
import { isShuttingDown, shutdownSignal } from './shutdown.js';
import {
  BURST_MS,
  CHUNK_SIZE_CLASSES,
  chunkSizeClass,
  effectiveChunkOps,
  htbAcquire,
  laneCapPerSec,
  MAX_BULK_WRITE_OPS,
  quantile,
  WRITE_BUDGET_OFF,
  type ChunkSizeClass,
  type HtbState,
  type WriteBudgetMode,
  type WriteBudgetSettings,
} from './write-budget-model.js';
import { currentWriteLane, isWriteLane, WRITE_LANES, type WriteLane } from './write-lane.js';

/*
 * P2.4 — ONE shared write budget for every Mongo writer (design §5).
 *
 * WHY: every writer paced itself alone — the fee job's `FeeWriteGate` (per
 * process), the refresh and the backfill not at all — so a refresh of 4663
 * and a backfill flush together sent 2.5–4k writes/s at the M10 primary
 * (95 % CPU, lag, 8–15 ms → 65–222 ms per write). Here every budgeted write,
 * in every process, draws from ONE rate R (u/s) kept in Redis:
 *
 *   - a hierarchical token bucket (ACQUIRE_SCRIPT, one Lua call per ≤ 500-op
 *     chunk): each lane (`write-lane.ts`) has a guaranteed minimum share and
 *     borrows the shared pool that idle lanes overflow into; what neither
 *     covers becomes the lane's DEBT and the caller sleeps `debt / (share×R)`
 *     — a lane can never be starved below its share, and callers of one lane
 *     queue in arrival order;
 *   - R comes from the AIMD controller (`write-budget-controller.ts`, one
 *     holder fleet-wide) with a 30 s TTL; while no controller writes it,
 *     every acquirer uses `WRITE_BUDGET_MIN`;
 *   - every take is added to a per-minute counter (the controller's hourly
 *     cap), and `budgetedBulkWrite` pushes each chunk's latency into one of
 *     three size-class lists (the controller's latency inputs).
 *
 * Modes (`WRITE_BUDGET_MODE`): `off` (default, today: nothing is acquired,
 * nothing is measured, nothing touches Redis), `observe` (take and report
 * the would-wait, never sleep — debts are kept ≤ 1 s so the would-wait stays
 * meaningful), `enforce`.
 *
 * Redis unreachable → a per-process bucket at `MIN / WRITE_BUDGET_LOCAL_DIVISOR`
 * (the same model, `write-budget-model.ts`): fail OPEN at a floor that N
 * processes together keep near MIN.
 *
 * On shutdown a sleeping acquire stops waiting and lets its (already charged)
 * write go: the backfill's SIGTERM path must flush within Railway's draining
 * window.
 */

/**
 * Redis source of the budget: the control client on `REDIS_URL` (redis-state)
 * and the deployment namespace. The integrator binds it to the coordination
 * client (`coordination-redis.ts`); unbound, the service opens its own lazy
 * control client on `REDIS_URL` the first time the budget is on.
 */
export interface WriteBudgetRedisSource {
  client(): Promise<Redis | undefined>;
  readonly namespace: string;
}

export const WRITE_BUDGET_REDIS = Symbol('WRITE_BUDGET_REDIS');

/**
 * What the budget reads from `AppConfigService` (the integrator adds the
 * `writeBudget` and `mongoMonitorUri` getters; the rest exist). Read
 * structurally so the service also runs from a partial spec config.
 */
export interface WriteBudgetConfigView {
  writeBudget?: WriteBudgetSettings;
  mongoMonitorUri?: string;
  leaderboardSnapshotNamespace?: string;
  redisUrl?: string;
}

/** Keys of one deployment's budget (all on redis-state, all with TTLs). */
export function writeBudgetKeys(ns: string) {
  const base = `tw:wb:v1:${ns}`;
  return {
    /** HTB state hash: `ts`, `g`, `b:<lane>`, `c:<lane>`. */
    state: base,
    /** R written by the controller (PX 30 s). */
    rate: `${base}:rate`,
    /** The controller's last decision (status for every process). */
    ctl: `${base}:ctl`,
    /** Units taken in one minute (`all` + per lane), kept 62 min. */
    minute: (epochMinute: number) => `${base}:m:${epochMinute}`,
    /** Latency samples of one chunk size class (`LPUSH`, trimmed to 512, PX 30 s). */
    latency: (cls: ChunkSizeClass) => `${base}:lat:${cls}`,
    /** The controller lease. */
    lease: `tw:lease:v1:${ns}:wb-controller`,
  };
}

/** The state hash outlives its longest debt by this much; an idle budget then forgets itself. */
export const STATE_TTL_MS = 60_000;
/** Minute counters are kept this long (the controller sums the last 60). */
export const MINUTE_TTL_SEC = 62 * 60;
/** Latency samples per size class (newest first). */
export const LATENCY_SAMPLES = 512;
/** A latency list expires this long after its last sample (an idle fleet reads green). */
export const LATENCY_TTL_MS = 30_000;
/** A single wait longer than this logs `[alert] write_budget.starved`. */
export const STARVED_WAIT_MS = 5 * 60_000;
/** No controller-written rate for this long logs `[alert] write_budget.controller_missing`. */
export const CONTROLLER_MISSING_MS = 30_000;
const ALERT_EVERY_MS = 60_000;

/**
 * One Lua call per acquire — mirrors `htbAcquire` (write-budget-model.ts)
 * step for step. KEYS: state, rate, minute counter. ARGV: lane, units,
 * maxWait (ms; < 0 = never refuse), fallback R (no rate key), lane cap
 * (u/s, 0 = none), observe ('1'), state TTL ms, minute TTL s, n, then n
 * pairs (lane, share). Returns {wait, R, ratePresent, laneBucketAfter}:
 * wait ≥ 0 = taken (sleep that long), < 0 = refused (nothing taken).
 */
export const ACQUIRE_SCRIPT = `
local stateKey = KEYS[1]
local rateKey = KEYS[2]
local minuteKey = KEYS[3]
local lane = ARGV[1]
local units = tonumber(ARGV[2])
local maxWait = tonumber(ARGV[3])
local fallback = tonumber(ARGV[4])
local laneCap = tonumber(ARGV[5])
local observe = ARGV[6] == '1'
local ttl = tonumber(ARGV[7])
local minuteTtl = tonumber(ARGV[8])
local n = tonumber(ARGV[9])
local names = {}
local shares = {}
for i = 1, n do
  names[i] = ARGV[8 + 2 * i]
  shares[i] = tonumber(ARGV[9 + 2 * i])
end
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local R = tonumber(redis.call('GET', rateKey))
local present = 1
if R == nil or R <= 0 then
  R = fallback
  present = 0
end
local burst = 1
local fields = {'ts', 'g', 'c:' .. lane}
for i = 1, n do fields[#fields + 1] = 'b:' .. names[i] end
local st = redis.call('HMGET', stateKey, unpack(fields))
local ts = tonumber(st[1])
if ts == nil then ts = now end
local dt = math.max(0, now - ts) / 1000
local overflow = 0
local b = {}
local mine = nil
local laneRate = 0
for i = 1, n do
  local lr = shares[i] * R
  local cap = lr * burst
  local cur = tonumber(st[3 + i])
  if cur == nil then cur = cap end
  local filled = cur + lr * dt
  if filled > cap then
    overflow = overflow + (filled - math.max(cap, cur))
    b[i] = cap
  else
    b[i] = filled
  end
  if names[i] == lane then
    mine = i
    laneRate = lr
  end
end
if mine == nil then return redis.error_reply('unknown lane ' .. lane) end
local debtShares = 0
for i = 1, n do
  if b[i] < 0 then debtShares = debtShares + shares[i] end
end
if overflow > 0 and debtShares > 0 then
  local left = 0
  for i = 1, n do
    if b[i] < 0 then
      local cap = shares[i] * R * burst
      local repaid = b[i] + (overflow * shares[i]) / debtShares
      if repaid > cap then
        left = left + (repaid - cap)
        b[i] = cap
      else
        b[i] = repaid
      end
    end
  end
  overflow = left
end
local g0 = tonumber(st[2])
if g0 == nil then g0 = R * burst end
local g = math.min(R * burst, math.max(0, g0) + overflow)
local capTokens = nil
if laneCap > 0 then
  local capCap = laneCap * burst
  local c0 = tonumber(st[3])
  if c0 == nil then c0 = capCap end
  capTokens = math.min(capCap, c0 + laneCap * dt)
end
local bl = b[mine]
local fromLane = 0
if bl > 0 then fromLane = math.min(bl, units) end
local rem = units - fromLane
local fromPool = math.min(g, rem)
rem = rem - fromPool
local nb = bl - fromLane - rem
local idleShares = 0
local otherDebtShares = 0
for i = 1, n do
  if i ~= mine then
    if b[i] >= shares[i] * R * burst then
      idleShares = idleShares + shares[i]
    elseif b[i] < 0 then
      otherDebtShares = otherDebtShares + shares[i]
    end
  end
end
local repayRate = 0
if laneRate > 0 then repayRate = laneRate + (idleShares * R * shares[mine]) / (shares[mine] + otherDebtShares) end
local wait = 0
if rem > 0 and repayRate > 0 then wait = math.ceil((-nb / repayRate) * 1000) end
local nc = capTokens
if nc ~= nil then
  nc = nc - units
  if nc < 0 then wait = math.max(wait, math.ceil((-nc / laneCap) * 1000)) end
end
local refused = maxWait >= 0 and wait > maxWait
if not refused then
  if observe then
    nb = math.max(nb, -laneRate * burst)
    if nc ~= nil then nc = math.max(nc, -laneCap * burst) end
  end
  b[mine] = nb
  g = g - fromPool
  capTokens = nc
end
local out = {'ts', tostring(now), 'g', tostring(g)}
for i = 1, n do
  out[#out + 1] = 'b:' .. names[i]
  out[#out + 1] = tostring(b[i])
end
if capTokens ~= nil then
  out[#out + 1] = 'c:' .. lane
  out[#out + 1] = tostring(capTokens)
end
redis.call('HSET', stateKey, unpack(out))
local longest = 0
for i = 1, n do
  local lr = shares[i] * R
  if b[i] < 0 and lr > 0 then longest = math.max(longest, math.ceil((-b[i] / lr) * 1000)) end
end
redis.call('PEXPIRE', stateKey, ttl + longest)
if refused then return {-wait, tostring(R), present, tostring(b[mine])} end
redis.call('HINCRBYFLOAT', minuteKey, 'all', tostring(units))
redis.call('HINCRBYFLOAT', minuteKey, lane, tostring(units))
redis.call('EXPIRE', minuteKey, minuteTtl)
return {wait, tostring(R), present, tostring(b[mine])}
`;

/** The budget could not be had within the caller's `maxWaitMs` (enforce). Nothing was taken. */
export class WriteBudgetTimeoutError extends Error {
  constructor(
    readonly lane: WriteLane,
    readonly waitMs: number,
  ) {
    super(`write budget: lane ${lane} would wait ${Math.round(waitMs)} ms, past its limit`);
    this.name = 'WriteBudgetTimeoutError';
  }
}

export interface WriteBudgetAcquireOptions {
  /** Default: the async context's lane (`currentWriteLane()`). */
  lane?: WriteLane;
  /** enforce: refuse (throw `WriteBudgetTimeoutError`) rather than wait longer. Default: no limit. */
  maxWaitMs?: number;
  /** Aborting it rejects a waiting acquire with the signal's reason (the units stay charged). */
  signal?: AbortSignal;
}

export interface WriteBudgetGrant {
  lane: WriteLane;
  units: number;
  mode: WriteBudgetMode;
  /** How long this call slept (enforce only). */
  waitedMs: number;
  /** The wait the bucket asked for (observe: what enforce would have slept). */
  wouldWaitMs: number;
  /** R in force at the take (u/s). */
  rate: number;
  /** Where the take happened. */
  source: 'off' | 'redis' | 'local';
}

/** One measured `bulkWrite` chunk. */
export interface WriteChunkSample {
  /** Wall time of the `bulkWrite`. */
  ms: number;
  /** WRITE units of the chunk (read units excluded: the read is not in `ms`). */
  units: number;
  ops: number;
  lane?: WriteLane;
}

interface LaneMeter {
  takes: Array<{ at: number; units: number }>;
  waits: number[];
  acquires: number;
  refused: number;
  lastBucket: number | null;
  /** Σ granted waits under `enforce` (ms, monotonic) — `laneWaitTotalMs`. */
  waitTotalMs: number;
}

/** Per-lane rows of `snapshot().perLane`. */
export interface WriteBudgetLaneStatus {
  unitsPerSec: number;
  acquires: number;
  refused: number;
  waitP50Ms: number | null;
  waitP95Ms: number | null;
  /** The lane bucket after this process's last take (< 0 = debt, units). */
  lastBucket: number | null;
}

export interface WriteBudgetSnapshot {
  mode: WriteBudgetMode;
  rate: number | null;
  ratePresent: boolean | null;
  source: 'off' | 'redis' | 'local' | null;
  hourlyCap: number;
  hourlyClamped: boolean;
  monitor: boolean;
  backfillCapNoMonitor: number;
  perLane: Record<WriteLane, WriteBudgetLaneStatus>;
  chunks: { total: number; oversize: number; byClass: Record<ChunkSizeClass, { count: number; p95Ms: number | null; p95MsPerUnit: number | null }> };
  localFallbacks: number;
}

/** Sleep `ms`; resolve early on shutdown; reject with the reason when `signal` aborts. */
function waitFor(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const stop = shutdownSignal();
    const done = () => {
      clearTimeout(timer);
      stop.removeEventListener('abort', onStop);
      signal?.removeEventListener('abort', onAbort);
    };
    const onStop = () => {
      done();
      resolve();
    };
    const onAbort = () => {
      done();
      reject(signal?.reason ?? new Error('aborted'));
    };
    const timer = setTimeout(() => {
      done();
      resolve();
    }, ms);
    if (signal?.aborted) return onAbort();
    if (stop.aborted) return onStop();
    stop.addEventListener('abort', onStop, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

@Injectable()
export class WriteBudgetService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WriteBudgetService.name);
  private readonly settingsValue: WriteBudgetSettings;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private ownClient?: LazyClient;
  private local?: HtbState;
  private readonly meters = new Map<WriteLane, LaneMeter>();
  private readonly chunkSamples: Record<ChunkSizeClass, Array<{ ms: number; perUnit: number }>> = { s: [], m: [], l: [] };
  private chunkTotal = 0;
  private oversize = 0;
  private localFallbacks = 0;
  private lastRate: number | null = null;
  private lastRatePresent: boolean | null = null;
  private lastSource: 'off' | 'redis' | 'local' | null = null;
  private rateMissingSince: number | null = null;
  private readonly alertedAt = new Map<string, number>();
  private redisErrorAt = 0;

  constructor(
    @Optional() @Inject(AppConfigService) private readonly config?: AppConfigService,
    @Optional() @Inject(WRITE_BUDGET_REDIS) private readonly redis?: WriteBudgetRedisSource,
    // Specs only (a fake clock); Nest finds nothing to inject and passes undefined.
    @Optional() clock?: { now?: () => number; sleep?: (ms: number) => Promise<void> },
  ) {
    const view = config as unknown as WriteBudgetConfigView | undefined;
    this.settingsValue = view?.writeBudget ?? WRITE_BUDGET_OFF;
    this.now = clock?.now ?? Date.now;
    this.sleep = clock?.sleep ? (ms) => clock.sleep!(ms) : waitFor;
    if (this.settingsValue.mode !== 'off') registerProcessWriteBudget(this);
  }

  get settings(): WriteBudgetSettings {
    return this.settingsValue;
  }

  get mode(): WriteBudgetMode {
    return this.settingsValue.mode;
  }

  /** observe or enforce. */
  get enabled(): boolean {
    return this.settingsValue.mode !== 'off';
  }

  get namespace(): string {
    return this.redis?.namespace ?? (this.config as unknown as WriteBudgetConfigView | undefined)?.leaderboardSnapshotNamespace ?? 'local';
  }

  get keys() {
    return writeBudgetKeys(this.namespace);
  }

  /** Ops per `bulkWrite` chunk for a caller whose own cap is `callerMax` (`effectiveChunkOps`). */
  chunkOps(callerMax?: number): number {
    return effectiveChunkOps(this.settingsValue, callerMax);
  }

  /** Units for `docs` documents read on the primary to decide a write (`WRITE_BUDGET_READ_UNIT` each). */
  readUnits(docs: number): number {
    return Math.max(0, docs) * this.settingsValue.readUnit;
  }

  /** The Redis client (undefined while off, connecting or unreachable). Never throws. */
  async redisClient(): Promise<Redis | undefined> {
    if (!this.enabled) return undefined;
    try {
      if (this.redis) return await this.redis.client();
      const url = (this.config as unknown as WriteBudgetConfigView | undefined)?.redisUrl;
      if (!url) return undefined;
      this.ownClient ??= new LazyClient(() => url, ROLE_OPTIONS.control, 'tw-write-budget', this.logger);
      return await this.ownClient.get();
    } catch {
      return undefined;
    }
  }

  /**
   * Take `units` for the current (or given) lane. `off`: nothing. `observe`:
   * take, record the would-wait, return at once. `enforce`: take and sleep
   * the wait (a wait past `maxWaitMs` takes nothing and throws
   * `WriteBudgetTimeoutError`).
   */
  async acquire(units: number, opts: WriteBudgetAcquireOptions = {}): Promise<WriteBudgetGrant> {
    const lane = opts.lane && isWriteLane(opts.lane) ? opts.lane : currentWriteLane();
    const cost = Number.isFinite(units) && units > 0 ? units : 0;
    const mode = this.settingsValue.mode;
    if (mode === 'off' || cost === 0) {
      return { lane, units: cost, mode, waitedMs: 0, wouldWaitMs: 0, rate: this.lastRate ?? 0, source: 'off' };
    }
    const enforce = mode === 'enforce';
    const maxWait = enforce && opts.maxWaitMs !== undefined && Number.isFinite(opts.maxWaitMs) ? Math.max(0, opts.maxWaitMs) : -1;
    const { wait, rate, source } = await this.take(lane, cost, maxWait, !enforce);
    const meter = this.meter(lane);
    if (wait < 0) {
      meter.refused++;
      throw new WriteBudgetTimeoutError(lane, -wait);
    }
    meter.acquires++;
    meter.takes.push({ at: this.now(), units: cost });
    meter.waits.push(wait);
    if (meter.waits.length > LATENCY_SAMPLES) meter.waits.splice(0, meter.waits.length - LATENCY_SAMPLES);
    this.trimTakes(meter);
    if (wait > STARVED_WAIT_MS) {
      this.alert(`starved:${lane}`, `[alert] write_budget.starved lane=${lane} waitMs=${wait} units=${cost} rate=${rate} mode=${mode}`);
    }
    // Booked when GRANTED (before the sleep), so a long wait shows while it
    // runs — the backfill profile's `backfill.slow` check reads it as "the
    // budget is what holds the walk back".
    if (enforce && wait > 0) meter.waitTotalMs += wait;
    let waitedMs = 0;
    if (enforce && wait > 0 && !isShuttingDown()) {
      const started = this.now();
      await this.sleep(wait, opts.signal);
      waitedMs = Math.max(0, this.now() - started);
    }
    return { lane, units: cost, mode, waitedMs, wouldWaitMs: wait, rate, source };
  }

  /**
   * Charge `units` without waiting (a primary read whose write was skipped):
   * the debt delays the lane's NEXT acquires instead. Fire-and-forget.
   */
  charge(units: number, lane: WriteLane = currentWriteLane()): void {
    if (!this.enabled || !(units > 0)) return;
    void this.take(lane, units, -1, this.mode !== 'enforce')
      .then(() => {
        const meter = this.meter(lane);
        meter.takes.push({ at: this.now(), units });
        this.trimTakes(meter);
      })
      .catch(() => undefined);
  }

  /**
   * Record one chunk's latency (observe/enforce): this process's own window,
   * and the fleet's size-class list in Redis that the controller reads.
   * Fire-and-forget; never throws.
   */
  recordChunk(sample: WriteChunkSample): void {
    if (!this.enabled) return;
    const ops = Math.max(0, Math.floor(sample.ops));
    const ms = Math.max(0, sample.ms);
    const units = Math.max(0, sample.units);
    if (ops === 0) return;
    const cls = chunkSizeClass(ops);
    this.chunkTotal++;
    const list = this.chunkSamples[cls];
    list.push({ ms, perUnit: units > 0 ? ms / units : ms });
    if (list.length > LATENCY_SAMPLES) list.splice(0, list.length - LATENCY_SAMPLES);
    if (ops > MAX_BULK_WRITE_OPS) {
      this.oversize++;
      this.alert(
        'oversize_chunk',
        `[alert] write_budget.oversize_chunk ops=${ops} lane=${sample.lane ?? currentWriteLane()} ms=${Math.round(ms)} — ` +
          `a bulkWrite above ${MAX_BULK_WRITE_OPS} ops went out while the budget is ${this.mode}`,
      );
    }
    const at = this.now();
    void this.redisClient()
      .then(async (client) => {
        if (!client) return;
        const key = this.keys.latency(cls);
        await client
          .pipeline()
          .lpush(key, `${ms.toFixed(2)}:${units.toFixed(3)}:${ops}:${at}`)
          .ltrim(key, 0, LATENCY_SAMPLES - 1)
          .pexpire(key, LATENCY_TTL_MS)
          .exec();
      })
      .catch((err) => this.logRedisError(err));
  }

  /**
   * The ms this process's `lane` has been told to sleep under `enforce`
   * (monotonic, counted when granted). `observe` never sleeps and counts 0;
   * `off` counts 0. Read as deltas (the backfill profile's budget-wait share).
   */
  laneWaitTotalMs(lane: WriteLane): number {
    return this.meters.get(lane)?.waitTotalMs ?? 0;
  }

  /** This process's view, for the status fan-in and `GET /admin/sync/status`. */
  snapshot(): WriteBudgetSnapshot {
    const perLane = {} as Record<WriteLane, WriteBudgetLaneStatus>;
    for (const lane of WRITE_LANES) {
      const meter = this.meter(lane);
      this.trimTakes(meter);
      const units = meter.takes.reduce((sum, take) => sum + take.units, 0);
      perLane[lane] = {
        unitsPerSec: Math.round((units / 60) * 100) / 100,
        acquires: meter.acquires,
        refused: meter.refused,
        waitP50Ms: quantile(meter.waits, 0.5),
        waitP95Ms: quantile(meter.waits, 0.95),
        lastBucket: meter.lastBucket === null ? null : Math.round(meter.lastBucket * 100) / 100,
      };
    }
    const byClass = {} as WriteBudgetSnapshot['chunks']['byClass'];
    for (const cls of CHUNK_SIZE_CLASSES) {
      const samples = this.chunkSamples[cls];
      const p95 = quantile(samples.map((s) => s.ms), 0.95);
      const p95u = quantile(samples.map((s) => s.perUnit), 0.95);
      byClass[cls] = {
        count: samples.length,
        p95Ms: p95 === null ? null : Math.round(p95 * 10) / 10,
        p95MsPerUnit: p95u === null ? null : Math.round(p95u * 1000) / 1000,
      };
    }
    const s = this.settingsValue;
    return {
      mode: s.mode,
      rate: this.lastRate,
      ratePresent: this.lastRatePresent,
      source: this.lastSource,
      hourlyCap: s.hourlyPerSec,
      hourlyClamped: s.hourlyClamped,
      monitor: s.monitorConfigured,
      backfillCapNoMonitor: laneCapPerSec(s, 'backfill'),
      perLane,
      chunks: { total: this.chunkTotal, oversize: this.oversize, byClass },
      localFallbacks: this.localFallbacks,
    };
  }

  /**
   * The Nest-built service is THE process budget in every mode (integrator,
   * I1): with the mode `off` it is inert — `acquire` never waits, nothing is
   * measured or sent to Redis — but its settings carry
   * `MONGO_BULK_WRITE_MAX_OPS`, which every `budgetedBulkWrite` caller that
   * passes no budget then honours too (it used to see `WRITE_BUDGET_OFF`, i.e.
   * unbounded, whenever the mode was off). Specs that construct the service
   * directly keep the constructor's rule (registered only when on).
   */
  onModuleInit(): void {
    registerProcessWriteBudget(this);
  }

  async onModuleDestroy(): Promise<void> {
    if (processWriteBudget() === this) registerProcessWriteBudget(undefined);
    await this.ownClient?.quit();
  }

  /** Lane share × R etc. for one take, through Redis or the local floor. */
  private async take(lane: WriteLane, units: number, maxWait: number, observe: boolean): Promise<{ wait: number; rate: number; source: 'redis' | 'local' }> {
    const s = this.settingsValue;
    const laneCap = laneCapPerSec(s, lane);
    const client = await this.redisClient();
    if (client) {
      try {
        const keys = this.keys;
        const args: string[] = [
          lane,
          String(units),
          String(maxWait),
          String(s.minPerSec),
          String(laneCap),
          observe ? '1' : '0',
          String(STATE_TTL_MS),
          String(MINUTE_TTL_SEC),
          String(WRITE_LANES.length),
        ];
        for (const l of WRITE_LANES) args.push(l, String(s.shares[l]));
        const reply = (await client.eval(
          ACQUIRE_SCRIPT,
          3,
          keys.state,
          keys.rate,
          keys.minute(Math.floor(this.now() / 60_000)),
          ...args,
        )) as [number, string, number, string];
        const wait = Number(reply[0]);
        const rate = Number(reply[1]);
        const present = Number(reply[2]) === 1;
        this.meter(lane).lastBucket = Number(reply[3]);
        this.noteRate(rate, present, 'redis');
        return { wait, rate, source: 'redis' };
      } catch (err) {
        this.logRedisError(err);
      }
    }
    // Redis off or unreachable: this process alone, at a floor.
    this.localFallbacks++;
    const rate = s.minPerSec / s.localDivisor;
    const { state, wait } = htbAcquire(this.local, this.now(), lane, units, maxWait, { rate, shares: s.shares, laneCap, observe });
    this.local = state;
    this.meter(lane).lastBucket = state.lanes[lane];
    this.noteRate(rate, null, 'local');
    return { wait, rate, source: 'local' };
  }

  private noteRate(rate: number, present: boolean | null, source: 'redis' | 'local'): void {
    this.lastRate = rate;
    this.lastRatePresent = present;
    this.lastSource = source;
    if (present === false) {
      const now = this.now();
      this.rateMissingSince ??= now;
      if (now - this.rateMissingSince > CONTROLLER_MISSING_MS) {
        this.alert(
          'controller_missing',
          `[alert] write_budget.controller_missing forMs=${now - this.rateMissingSince} — no wb-controller holder wrote R; ` +
            `every acquirer runs at WRITE_BUDGET_MIN=${this.settingsValue.minPerSec}`,
        );
      }
    } else if (present === true) {
      this.rateMissingSince = null;
    }
  }

  private meter(lane: WriteLane): LaneMeter {
    let meter = this.meters.get(lane);
    if (!meter) {
      meter = { takes: [], waits: [], acquires: 0, refused: 0, lastBucket: null, waitTotalMs: 0 };
      this.meters.set(lane, meter);
    }
    return meter;
  }

  private trimTakes(meter: LaneMeter): void {
    const cutoff = this.now() - 60_000;
    let drop = 0;
    while (drop < meter.takes.length && meter.takes[drop]!.at < cutoff) drop++;
    if (drop > 0) meter.takes.splice(0, drop);
  }

  private alert(key: string, line: string): void {
    const now = this.now();
    if (now - (this.alertedAt.get(key) ?? Number.NEGATIVE_INFINITY) < ALERT_EVERY_MS) return;
    this.alertedAt.set(key, now);
    this.logger.warn(line);
  }

  private logRedisError(err: unknown): void {
    const now = Date.now();
    if (now - this.redisErrorAt < ALERT_EVERY_MS) return;
    this.redisErrorAt = now;
    this.logger.warn(
      `write budget: Redis unavailable, per-process floor ${this.settingsValue.minPerSec / this.settingsValue.localDivisor} u/s: ` +
        `${(err as Error)?.message ?? String(err)}`,
    );
  }
}

/** One second of R: the most a lane plus the pool can bank (for specs and docs). */
export const WRITE_BUDGET_BURST_MS = BURST_MS;

let processBudget: WriteBudgetService | undefined;

/**
 * The process's budget, for `budgetedBulkWrite` callers that do not inject it.
 * Registered by the Nest-constructed `WriteBudgetService` when the budget is
 * on; undefined while it is off (every write then goes out as today).
 */
export function processWriteBudget(): WriteBudgetService | undefined {
  return processBudget;
}

export function registerProcessWriteBudget(budget: WriteBudgetService | undefined): void {
  processBudget = budget;
}
