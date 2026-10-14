import type { ReadModelName } from './core/fields.js';
import type { AlertLog } from './status.js';

/**
 * The read models' memory guard (design §4.11, P-R R4).
 *
 * Two limits, both checked every 5 s (and the cap before a model loads):
 *
 *  - **RSS against the container** (`process.constrainedMemory()`, the cgroup
 *    limit), in stages with an alert at each:
 *      80% → drop the engines' answer caches;
 *      85% → drop their search and match-bitset caches;
 *      90% → unload the rank model on this replica;
 *      95% → unload the pool catalog too.
 *    The first two go through shedders the engines register
 *    (`ReadModelsService.registerShedder`); the last two LOWER the model's
 *    mode to `off` on this replica only, exactly like a local kill switch (the
 *    runtime drops the model's rows, the engine tears its buffers down).
 *  - **Off-heap model bytes against the cap** (`READ_MODELS_MAX_MB`, or when 0
 *    `constrainedMemory − heap cap − 25%`): over the cap the rank model is
 *    unloaded first, then the catalog.
 *
 * A shed model comes back once RSS (and the off-heap bytes) have stayed under
 * 70% for 5 minutes — SharedArrayBuffers are freed by GC, not by the unload
 * (F15), so the hysteresis has to outlast a collection or it flaps. The wait
 * DOUBLES with every shed in the last 6 h (5, 10, 20 min), and a model shed
 * `LATCH_AFTER` (4) times in 6 h is LATCHED: it stays unloaded on this replica
 * until the process restarts (`[alert] read_models.memory … latched`) — a
 * model that does not fit must not load, shed and reload forever.
 *
 * What "unload" means depends on the replica (`ReadModelsService`): the
 * engine's copy always; the R1 rows only on a consumer — the lease holder
 * keeps feeding every model (its rows are the fleet's delta stream), so a
 * memory shed there never changes what other replicas receive.
 *
 * Without a known container limit (dev, macOS) and without
 * `READ_MODELS_MAX_MB`, the guard is inactive and says so in the status.
 */

export type ShedStage = 0 | 80 | 85 | 90 | 95;
export const SHED_STAGES: readonly Exclude<ShedStage, 0>[] = [80, 85, 90, 95];
export const RELOAD_SHARE = 0.7;
export const RELOAD_AFTER_MS = 5 * 60_000;
/** Sheds of one model within this window count towards the backoff and the latch. */
export const SHED_WINDOW_MS = 6 * 3_600_000;
/** The shed that latches a model (stays unloaded until a restart). */
export const LATCH_AFTER = 4;

export interface MemoryReading {
  rss: number;
  /** Off-heap bytes the models hold (`process.memoryUsage().arrayBuffers`). */
  arrayBuffers: number;
}

export interface MemoryLimits {
  /** The container's limit in bytes, or undefined when unknown. */
  containerBytes?: number;
  /** The off-heap model cap in bytes, or undefined (no cap). */
  capBytes?: number;
}

/** A cgroup "limit" this large is no limit (cgroup v1 reports ~2^63 when unconstrained). */
const UNCONSTRAINED = 2 ** 52;

/** The container limit from `process.constrainedMemory()`, or undefined when there is none. */
export function containerLimit(read: () => number | undefined = () => (process as { constrainedMemory?: () => number | undefined }).constrainedMemory?.()): number | undefined {
  try {
    const value = read();
    return typeof value === 'number' && Number.isFinite(value) && value > 0 && value < UNCONSTRAINED ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The off-heap cap (§4.11): `READ_MODELS_MAX_MB` when set, else the container
 * minus the V8 heap cap minus 25% of the container; undefined when neither is
 * known (or the derivation leaves nothing).
 */
export function modelCapBytes(maxMb: number, containerBytes: number | undefined, heapLimitBytes: number): number | undefined {
  if (maxMb > 0) return maxMb * 1_048_576;
  if (!containerBytes) return undefined;
  const cap = containerBytes - heapLimitBytes - containerBytes * 0.25;
  return cap > 0 ? cap : undefined;
}

/** The RSS stage reached (0 = none). */
export function stageFor(rss: number, containerBytes: number | undefined): ShedStage {
  if (!containerBytes) return 0;
  const share = rss / containerBytes;
  for (let i = SHED_STAGES.length - 1; i >= 0; i--) if (share >= SHED_STAGES[i] / 100) return SHED_STAGES[i];
  return 0;
}

export interface GuardDecision {
  stage: ShedStage;
  /** Models unloaded on this replica (their effective mode is `off`). */
  shed: Set<ReadModelName>;
  /** Over the off-heap cap right now. */
  overCap: boolean;
}

/** The memory guard's state machine (pure: readings and time in, decisions out). */
export class MemoryGuard {
  private readonly shedModels = new Set<ReadModelName>();
  /** When each model was shed, within `SHED_WINDOW_MS` (the backoff and the latch). */
  private readonly history = new Map<ReadModelName, number[]>();
  private readonly latched = new Set<ReadModelName>();
  private stage: ShedStage = 0;
  private underSince: number | null = null;
  private readonly stageHits: Record<number, number> = {};
  private last?: MemoryReading;
  private lastOverCap = false;

  constructor(
    private readonly limits: MemoryLimits,
    private readonly alerts: Pick<AlertLog, 'alert'>,
    private readonly log: (message: string) => void,
    private readonly onCacheStage: (stage: 80 | 85) => void = () => undefined,
  ) {}

  get active(): boolean {
    return Boolean(this.limits.containerBytes || this.limits.capBytes);
  }

  /** Is `model` shed on this replica? */
  isShed(model: ReadModelName): boolean {
    return this.shedModels.has(model);
  }

  /** Is any model shed on this replica? */
  get anyShed(): boolean {
    return this.shedModels.size > 0;
  }

  /** Sheds of `model` within the window ending `now`. */
  private recentSheds(model: ReadModelName, now: number): number {
    const list = (this.history.get(model) ?? []).filter((at) => now - at < SHED_WINDOW_MS);
    this.history.set(model, list);
    return list.length;
  }

  /** How long memory must stay under 70% before the shed (unlatched) models reload: 5 min, doubled per earlier shed in the window. */
  reloadAfterMs(now: number): number {
    let n = 1;
    for (const model of this.shedModels) if (!this.latched.has(model)) n = Math.max(n, this.recentSheds(model, now));
    return RELOAD_AFTER_MS * 2 ** Math.min(n - 1, LATCH_AFTER - 2);
  }

  /** One 5 s check. */
  check(reading: MemoryReading, now: number): GuardDecision {
    this.last = reading;
    const { containerBytes, capBytes } = this.limits;
    const stage = stageFor(reading.rss, containerBytes);
    const overCap = capBytes !== undefined && reading.arrayBuffers > capBytes;
    this.lastOverCap = overCap;
    if (stage > this.stage) {
      for (const s of SHED_STAGES) {
        if (s > this.stage && s <= stage) {
          this.stageHits[s] = (this.stageHits[s] ?? 0) + 1;
          this.alerts.alert('read_models.memory', `stage ${s}%: RSS ${mb(reading.rss)} MB of ${mb(containerBytes ?? 0)} MB — ${STAGE_ACTION[s]}`, `stage${s}`);
          if (s === 80 || s === 85) this.onCacheStage(s);
        }
      }
    } else if (stage === this.stage && (stage === 80 || stage === 85)) {
      // Still at a cache stage: keep the caches small (they refill between checks).
      this.onCacheStage(stage);
    }
    this.stage = stage;
    if (stage >= 90) this.shed('rank', `RSS at ${stage}% of the container`, now);
    if (stage >= 95) this.shed('pools', `RSS at ${stage}% of the container`, now);
    if (overCap) {
      if (!this.shedModels.has('rank')) this.shed('rank', `off-heap ${mb(reading.arrayBuffers)} MB over the ${mb(capBytes!)} MB cap`, now);
      else if (!this.shedModels.has('pools')) this.shed('pools', `off-heap ${mb(reading.arrayBuffers)} MB still over the ${mb(capBytes!)} MB cap with rank unloaded`, now);
    }
    // Reload hysteresis: everything under 70% for 5 minutes.
    const under =
      (containerBytes === undefined || reading.rss < containerBytes * RELOAD_SHARE) && (capBytes === undefined || reading.arrayBuffers < capBytes * RELOAD_SHARE);
    const reloadable = [...this.shedModels].filter((model) => !this.latched.has(model));
    if (reloadable.length > 0 && under && stage === 0 && !overCap) {
      this.underSince ??= now;
      const wait = this.reloadAfterMs(now);
      if (now - this.underSince >= wait) {
        for (const model of reloadable) this.shedModels.delete(model);
        this.underSince = null;
        this.log(`read models: memory back under ${RELOAD_SHARE * 100}% for ${Math.round(wait / 60_000)} min — reloading ${reloadable.join(', ')}`);
      }
    } else {
      this.underSince = null;
    }
    return { stage, shed: new Set(this.shedModels), overCap };
  }

  private shed(model: ReadModelName, why: string, now: number): void {
    if (this.shedModels.has(model)) return;
    this.shedModels.add(model);
    this.underSince = null;
    const n = this.recentSheds(model, now) + 1;
    this.history.get(model)!.push(now);
    if (n >= LATCH_AFTER) {
      this.latched.add(model);
      this.alerts.alert('read_models.memory', `unloading ${model} on this replica: ${why} — shed ${n} times in ${SHED_WINDOW_MS / 3_600_000} h: LATCHED, it stays unloaded until this process restarts (raise the container or READ_MODELS_MAX_MB, or turn the model off)`, `latch-${model}`);
      return;
    }
    this.alerts.alert('read_models.memory', `unloading ${model} on this replica: ${why} (shed ${n}× in ${SHED_WINDOW_MS / 3_600_000} h; it reloads after ${Math.round(this.reloadAfterMs(now) / 60_000)} min under ${RELOAD_SHARE * 100}%)`, `shed-${model}`);
  }

  status(now: number) {
    return {
      active: this.active,
      containerMb: this.limits.containerBytes ? mb(this.limits.containerBytes) : null,
      capMb: this.limits.capBytes ? mb(this.limits.capBytes) : null,
      stage: this.stage,
      shed: [...this.shedModels],
      latched: [...this.latched],
      overCap: this.lastOverCap,
      reloadAfterMs: this.shedModels.size > this.latched.size ? this.reloadAfterMs(now) : null,
      reloadInMs: this.underSince === null ? null : Math.max(0, this.reloadAfterMs(now) - (now - this.underSince)),
      stageHits: { ...this.stageHits },
      last: this.last ? { rssMb: mb(this.last.rss), arrayBuffersMb: mb(this.last.arrayBuffers) } : null,
    };
  }
}

const STAGE_ACTION: Record<number, string> = {
  80: 'dropping answer caches',
  85: 'dropping search and match-bitset caches',
  90: 'unloading the rank model',
  95: 'unloading the pool catalog',
};

function mb(bytes: number): number {
  return Math.round(bytes / 1_048_576);
}
