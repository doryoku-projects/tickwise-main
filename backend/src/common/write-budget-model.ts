import { WRITE_LANES, type WriteLane } from './write-lane.js';

/*
 * The ONE shared write budget (P2.4) — the pure parts: settings, unit
 * weights, the lane-share parser, the chunk size classes, and the
 * hierarchical token bucket (`htbAcquire`) that is
 *   - the REFERENCE MODEL of the Lua script in `write-budget.ts` (the opt-in
 *     `test/write-budget/redis-contract.spec.ts` runs both on the same
 *     sequences), and
 *   - the per-process LOCAL bucket used while Redis is unreachable
 *     (`WRITE_BUDGET_MIN / WRITE_BUDGET_LOCAL_DIVISOR`).
 *
 * Nothing here does I/O.
 */

export type WriteBudgetMode = 'off' | 'observe' | 'enforce';

/**
 * What one write costs, in budget UNITS (1 u ≈ one full position update on
 * M10). Calibrated on the rig (design §14); the AIMD controller adjusts the
 * RATE, never these weights.
 */
export const WRITE_UNITS = {
  /** Insert of an ACTIVE position (its leaderboard index entries). */
  insertActive: 1.5,
  /** Insert of a closed position. */
  insertClosed: 1.0,
  /** Full position update (today's whole-subdoc `$set`). */
  fullUpdate: 1.0,
  /** Section update (dotted leaves of the changed sections only, P2.3). */
  sectionUpdate: 0.6,
  /** Fee stamp-only write (`rpcFees*` leaves, nothing served). */
  feeStamp: 0.3,
  /** Fee write that also rewrites served `amounts`/`metrics` leaves. */
  feeServed: 1.0,
  /** One document of the stale sweep's `updateMany`. */
  staleSweep: 0.3,
  /** Pool upsert. */
  poolUpdate: 0.5,
  /** Anything else. */
  other: 0.5,
} as const;

export type WriteUnitKind = keyof typeof WRITE_UNITS;

/** The most ops one budgeted `bulkWrite` sends whenever the budget is on (`observe`/`enforce`). */
export const MAX_BULK_WRITE_OPS = 500;

/** A lane bucket banks at most this much of its rate while idle (and the shared pool as much of R). */
export const BURST_MS = 1_000;

/** Chunk size classes of the latency lists: `s` ≤ 100 ops, `m` ≤ 500, `l` larger. */
export type ChunkSizeClass = 's' | 'm' | 'l';
export const CHUNK_SIZE_CLASSES: readonly ChunkSizeClass[] = ['s', 'm', 'l'];

export function chunkSizeClass(ops: number): ChunkSizeClass {
  if (ops <= 100) return 's';
  if (ops <= 500) return 'm';
  return 'l';
}

/** Lane minimum shares (`WRITE_BUDGET_SHARES`), before normalisation. */
export const DEFAULT_WRITE_BUDGET_SHARES: Readonly<Record<WriteLane, number>> = {
  live: 10,
  fee: 25,
  refresh: 30,
  backfill: 25,
  pools: 5,
  other: 5,
};

/**
 * `live:10,fee:25,…` → shares normalised to sum 1. Lanes the string does not
 * name keep their DEFAULT weight; a weight that is not a positive finite
 * number keeps the default too (every lane must keep a share > 0, or its debt
 * could never be repaid). Unknown lane names are ignored. Blank → defaults.
 */
export function parseWriteBudgetShares(raw: string | undefined | null): Record<WriteLane, number> {
  const weights: Record<WriteLane, number> = { ...DEFAULT_WRITE_BUDGET_SHARES };
  for (const part of (raw ?? '').split(',')) {
    const [name, value] = part.split(':').map((s) => s.trim());
    if (!name || value === undefined) continue;
    if (!(WRITE_LANES as readonly string[]).includes(name)) continue;
    const weight = Number(value);
    if (Number.isFinite(weight) && weight > 0) weights[name as WriteLane] = weight;
  }
  const total = WRITE_LANES.reduce((sum, lane) => sum + weights[lane], 0);
  const shares = {} as Record<WriteLane, number>;
  for (const lane of WRITE_LANES) shares[lane] = weights[lane] / total;
  return shares;
}

/** Everything the budget, its controller and `budgetedBulkWrite` read from config. */
export interface WriteBudgetSettings {
  /** `WRITE_BUDGET_MODE`: off (today) | observe (chunk + measure + would-wait) | enforce. */
  mode: WriteBudgetMode;
  /** `WRITE_BUDGET_UNITS_PER_SEC`: where the controller starts R when no rate is stored. */
  startPerSec: number;
  /** `WRITE_BUDGET_MIN`: AIMD floor; also R for every acquirer while no controller writes one. */
  minPerSec: number;
  /** `WRITE_BUDGET_MAX`: AIMD ceiling. */
  maxPerSec: number;
  /** The hourly cap `H` in force (after the no-monitor clamp, ≥ MIN). */
  hourlyPerSec: number;
  /** `WRITE_BUDGET_HOURLY_UNITS_PER_SEC` as configured (unset → 0.5 × MAX). */
  hourlyRequestedPerSec: number;
  /** True when H was asked above 0.5 × MAX without `MONGO_MONITOR_URI` and clamped down. */
  hourlyClamped: boolean;
  /** Lane minimum shares, normalised to sum 1. */
  shares: Record<WriteLane, number>;
  /** `WRITE_BUDGET_READ_UNIT`: units per document READ on the primary for a write decision. */
  readUnit: number;
  /** `WRITE_BUDGET_UNIT_LATENCY_RED_MS`: per-unit p95 (classes m + l) above this is red. */
  unitLatencyRedMs: number;
  /** `WRITE_BUDGET_LATENCY_RED_MS`: p95 of the ≤ 100-op class above this is red. */
  latencyRedMs: number;
  /** `WRITE_BUDGET_LAG_RED_MS`: majority / secondary lag above this is red. */
  lagRedMs: number;
  /** `WRITE_BUDGET_BACKFILL_MAX_NO_MONITOR`: backfill lane cap (u/s) while no monitor sees the oplog; 0 = none. */
  backfillMaxNoMonitor: number;
  /** `WRITE_BUDGET_LOCAL_DIVISOR`: Redis down → per-process bucket at MIN / this. */
  localDivisor: number;
  /** `MONGO_MONITOR_URI` is set (dirty % + oplog window are observed). */
  monitorConfigured: boolean;
  /** `MONGO_BULK_WRITE_MAX_OPS`: 0 = unbounded (today) while the budget is off. */
  maxOps: number;
  /** This process may run the AIMD controller (every role but `feeder`). */
  runController: boolean;
}

/** Dirty cache above this % is red (needs the monitor). */
export const DIRTY_RED_PCT = 10;
/** Oplog window below this is red (needs the monitor). */
export const OPLOG_RED_SEC = 2 * 3600;
/** … and below this while the backfill lane consumed in the last `BACKFILL_ACTIVE_WINDOW_MS`. */
export const OPLOG_BACKFILL_RED_SEC = 3 * 3600;
export const BACKFILL_ACTIVE_WINDOW_MS = 5 * 60_000;

/** The env defaults (= the design's §12 table). The integrator mirrors these in Zod. */
export const WRITE_BUDGET_ENV_DEFAULTS = {
  WRITE_BUDGET_MODE: 'off',
  WRITE_BUDGET_UNITS_PER_SEC: 300,
  WRITE_BUDGET_MIN: 100,
  WRITE_BUDGET_MAX: 450,
  /** Unset → 0.5 × MAX. */
  WRITE_BUDGET_HOURLY_UNITS_PER_SEC: undefined as number | undefined,
  WRITE_BUDGET_SHARES: 'live:10,fee:25,refresh:30,backfill:25,pools:5,other:5',
  WRITE_BUDGET_READ_UNIT: 0.15,
  WRITE_BUDGET_UNIT_LATENCY_RED_MS: 2.0,
  WRITE_BUDGET_LATENCY_RED_MS: 150,
  WRITE_BUDGET_LAG_RED_MS: 5_000,
  WRITE_BUDGET_BACKFILL_MAX_NO_MONITOR: 100,
  WRITE_BUDGET_LOCAL_DIVISOR: 3,
  MONGO_BULK_WRITE_MAX_OPS: 0,
} as const;

export type WriteBudgetEnvKey = keyof typeof WRITE_BUDGET_ENV_DEFAULTS | 'MONGO_MONITOR_URI' | 'PROCESS_ROLE';

function num(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw === 'string' && raw.trim() === '') return fallback;
  const value = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Resolve the settings from the env values (strings from `process.env` or
 * the numbers Zod already coerced). Defensive: a value that does not parse
 * keeps its default, so a partial config (specs) reads as today.
 *
 * Clamps: MIN ≥ 1; MAX ≥ MIN; start in [MIN, MAX]; H defaults to 0.5 × MAX
 * and may exceed it only with `MONGO_MONITOR_URI` (otherwise clamped back,
 * `hourlyClamped` — the integrator logs it at boot); H ≥ MIN; read unit ≥ 0;
 * divisor ≥ 1; MAX_OPS in [0, 500].
 */
export function resolveWriteBudgetSettings(raw: Partial<Record<WriteBudgetEnvKey, unknown>> = {}): WriteBudgetSettings {
  const d = WRITE_BUDGET_ENV_DEFAULTS;
  const modeRaw = typeof raw.WRITE_BUDGET_MODE === 'string' ? raw.WRITE_BUDGET_MODE.trim() : '';
  const mode: WriteBudgetMode = modeRaw === 'observe' || modeRaw === 'enforce' ? modeRaw : 'off';
  const minPerSec = Math.max(1, num(raw.WRITE_BUDGET_MIN, d.WRITE_BUDGET_MIN));
  const maxPerSec = Math.max(minPerSec, num(raw.WRITE_BUDGET_MAX, d.WRITE_BUDGET_MAX));
  const startPerSec = Math.min(maxPerSec, Math.max(minPerSec, num(raw.WRITE_BUDGET_UNITS_PER_SEC, d.WRITE_BUDGET_UNITS_PER_SEC)));
  const monitorUri = typeof raw.MONGO_MONITOR_URI === 'string' ? raw.MONGO_MONITOR_URI.trim() : '';
  const monitorConfigured = monitorUri.length > 0;
  const halfMax = 0.5 * maxPerSec;
  const hourlyRequestedPerSec = Math.max(0, num(raw.WRITE_BUDGET_HOURLY_UNITS_PER_SEC, halfMax)) || halfMax;
  const hourlyClamped = hourlyRequestedPerSec > halfMax && !monitorConfigured;
  const hourlyPerSec = Math.max(minPerSec, hourlyClamped ? halfMax : hourlyRequestedPerSec);
  const sharesRaw = typeof raw.WRITE_BUDGET_SHARES === 'string' ? raw.WRITE_BUDGET_SHARES : d.WRITE_BUDGET_SHARES;
  const role = typeof raw.PROCESS_ROLE === 'string' ? raw.PROCESS_ROLE.trim() : 'all';
  return {
    mode,
    startPerSec,
    minPerSec,
    maxPerSec,
    hourlyPerSec,
    hourlyRequestedPerSec,
    hourlyClamped,
    shares: parseWriteBudgetShares(sharesRaw),
    readUnit: Math.max(0, num(raw.WRITE_BUDGET_READ_UNIT, d.WRITE_BUDGET_READ_UNIT)),
    unitLatencyRedMs: Math.max(0.01, num(raw.WRITE_BUDGET_UNIT_LATENCY_RED_MS, d.WRITE_BUDGET_UNIT_LATENCY_RED_MS)),
    latencyRedMs: Math.max(1, num(raw.WRITE_BUDGET_LATENCY_RED_MS, d.WRITE_BUDGET_LATENCY_RED_MS)),
    lagRedMs: Math.max(1, num(raw.WRITE_BUDGET_LAG_RED_MS, d.WRITE_BUDGET_LAG_RED_MS)),
    backfillMaxNoMonitor: Math.max(0, num(raw.WRITE_BUDGET_BACKFILL_MAX_NO_MONITOR, d.WRITE_BUDGET_BACKFILL_MAX_NO_MONITOR)),
    localDivisor: Math.max(1, num(raw.WRITE_BUDGET_LOCAL_DIVISOR, d.WRITE_BUDGET_LOCAL_DIVISOR)),
    monitorConfigured,
    maxOps: Math.min(MAX_BULK_WRITE_OPS, Math.max(0, Math.floor(num(raw.MONGO_BULK_WRITE_MAX_OPS, d.MONGO_BULK_WRITE_MAX_OPS)))),
    runController: role !== 'feeder',
  };
}

/** Today's behaviour: the budget is off. */
export const WRITE_BUDGET_OFF: WriteBudgetSettings = resolveWriteBudgetSettings();

/**
 * The cap (u/s) on `lane` beyond its HTB share: the backfill lane while no
 * monitor observes the oplog window (`WRITE_BUDGET_BACKFILL_MAX_NO_MONITOR`).
 * 0 = no cap.
 */
export function laneCapPerSec(settings: WriteBudgetSettings, lane: WriteLane): number {
  return lane === 'backfill' && !settings.monitorConfigured ? settings.backfillMaxNoMonitor : 0;
}

/**
 * The ops per `bulkWrite` chunk: the caller's own cap, `MONGO_BULK_WRITE_MAX_OPS`
 * when set, and — whenever the budget is on — never more than 500. With the
 * budget off and the env unset this is the caller's cap alone (today).
 */
export function effectiveChunkOps(settings: WriteBudgetSettings, callerMax?: number): number {
  let size = Number.POSITIVE_INFINITY;
  if (callerMax !== undefined && Number.isFinite(callerMax) && callerMax > 0) size = Math.floor(callerMax);
  if (settings.maxOps > 0) size = Math.min(size, settings.maxOps);
  if (settings.mode !== 'off') size = Math.min(size, MAX_BULK_WRITE_OPS);
  return Math.max(1, size);
}

/**
 * `POSITIONS_REFRESH_QUEUE_CONCURRENCY` in force (design §5.2): more than one
 * refresh at a time only while the budget ENFORCES — the budget then bounds
 * the write burst that concurrency 1 used to. Otherwise clamped to 1 (the
 * caller logs the warning when `clamped`).
 */
export function refreshQueueConcurrency(requested: number, mode: WriteBudgetMode): { value: number; clamped: boolean } {
  const want = Number.isFinite(requested) && requested >= 1 ? Math.floor(requested) : 1;
  if (want > 1 && mode !== 'enforce') return { value: 1, clamped: true };
  return { value: want, clamped: false };
}

// ── The hierarchical token bucket (reference model of ACQUIRE_SCRIPT) ──

/** Bucket state: lane buckets (negative = DEBT), the shared pool `g`, lane cap buckets, refill time. */
export interface HtbState {
  /** Last refill time, ms. */
  ts: number;
  /** Shared pool (overflow of full lane buckets), ≥ 0. */
  g: number;
  /** Lane buckets; below 0 is the lane's debt. */
  lanes: Record<WriteLane, number>;
  /** Lane cap buckets (only lanes with a cap). */
  caps: Partial<Record<WriteLane, number>>;
}

export interface HtbParams {
  /** R, u/s. */
  rate: number;
  shares: Record<WriteLane, number>;
  /** Cap (u/s) of the acquiring lane beyond its share; 0 = none. */
  laneCap: number;
  /** `observe`: take, report the would-wait, but keep each debt ≤ one second of its rate. */
  observe: boolean;
}

export interface HtbResult {
  state: HtbState;
  /** ≥ 0: taken, sleep this long (ms). < 0: refused (the wait would pass `maxWait`), nothing taken. */
  wait: number;
}

/** A fresh state: every bucket full (one second of its rate). */
export function htbFresh(now: number, params: Pick<HtbParams, 'rate' | 'shares'>): HtbState {
  const lanes = {} as Record<WriteLane, number>;
  for (const lane of WRITE_LANES) lanes[lane] = params.shares[lane] * params.rate * (BURST_MS / 1000);
  return { ts: now, g: params.rate * (BURST_MS / 1000), lanes, caps: {} };
}

/**
 * Refill every bucket for the time elapsed since `state.ts`, then take
 * `units` for `lane`: from the lane bucket, then the shared pool `g`; the
 * remainder becomes the lane's DEBT — so a lane always gets at least its
 * share, idle capacity goes to whoever asks, and callers of one lane queue
 * behind its debt in arrival order. A lane with a cap also waits for its cap
 * bucket. A wait past `maxWait` (≥ 0) takes nothing and answers `-wait`;
 * `maxWait < 0` never refuses.
 *
 * Refill: lane += share × R × dt, capped at one second of its rate. What
 * overflows a full (idle) lane first REPAYS DEBT: it is split between the
 * lanes in debt in proportion to their shares (never past a lane's cap), and
 * only the rest goes to `g`, capped at one second of R. (Integrator fix,
 * 2026-10-04: the overflow used to go to the pool only, so a debt was repaid
 * at the lane's own share alone and a lane writing chunks larger than one
 * second of R — every 500-op position chunk — got ~its share plus one
 * pool-full per chunk even with every other lane idle: backfill 39 % of R,
 * refresh 63 %. Design §5.1: "idle capacity flows to whoever asks".)
 *
 * The wait is the debt over the rate it is repaid at while the idle lanes
 * stay idle: `share × R` plus this lane's part (by share, among the lanes in
 * debt) of the idle lanes' rates. If they wake up, the debt is repaid slower
 * than the wait assumed and the lane's NEXT caller waits for the rest — the
 * debt in the state, not the sleep, is what bounds the rate.
 *
 * Every arithmetic step here is mirrored line for line in ACQUIRE_SCRIPT.
 */
export function htbAcquire(
  prev: HtbState | undefined,
  now: number,
  lane: WriteLane,
  units: number,
  maxWait: number,
  params: HtbParams,
): HtbResult {
  const R = params.rate;
  const burst = BURST_MS / 1000;
  const base = prev ?? htbFresh(now, params);
  const dt = Math.max(0, now - base.ts) / 1000;
  const lanes = {} as Record<WriteLane, number>;
  let overflow = 0;
  for (const l of WRITE_LANES) {
    const laneRate = params.shares[l] * R;
    const cap = laneRate * burst;
    const b = base.lanes[l] ?? cap;
    const filled = b + laneRate * dt;
    if (filled > cap) {
      // Only what THIS refill pushed over the cap overflows; credit above a
      // cap that shrank (R fell) is dropped, not moved to the pool.
      overflow += filled - Math.max(cap, b);
      lanes[l] = cap;
    } else {
      lanes[l] = filled;
    }
  }
  // Idle capacity repays debt first, split by share among the lanes in debt.
  let debtShares = 0;
  for (const l of WRITE_LANES) if (lanes[l] < 0) debtShares += params.shares[l];
  if (overflow > 0 && debtShares > 0) {
    let left = 0;
    for (const l of WRITE_LANES) {
      if (lanes[l] >= 0) continue;
      const cap = params.shares[l] * R * burst;
      const repaid = lanes[l] + (overflow * params.shares[l]) / debtShares;
      if (repaid > cap) {
        left += repaid - cap;
        lanes[l] = cap;
      } else {
        lanes[l] = repaid;
      }
    }
    overflow = left;
  }
  const g = Math.min(R * burst, Math.max(0, base.g) + overflow);
  const caps: Partial<Record<WriteLane, number>> = { ...base.caps };
  let capTokens: number | undefined;
  if (params.laneCap > 0) {
    const capCap = params.laneCap * burst;
    capTokens = Math.min(capCap, (base.caps[lane] ?? capCap) + params.laneCap * dt);
  }

  const laneRate = params.shares[lane] * R;
  const b = lanes[lane];
  const fromLane = b > 0 ? Math.min(b, units) : 0;
  let rem = units - fromLane;
  const fromPool = Math.min(g, rem);
  rem -= fromPool;
  let nb = b - fromLane - rem;
  // The rate this debt is repaid at: the lane's share, plus its part (by share,
  // among the lanes in debt) of the lanes now full = idle.
  let idleShares = 0;
  let otherDebtShares = 0;
  for (const l of WRITE_LANES) {
    if (l === lane) continue;
    if (lanes[l] >= params.shares[l] * R * burst) idleShares += params.shares[l];
    else if (lanes[l] < 0) otherDebtShares += params.shares[l];
  }
  const repayRate = laneRate > 0 ? laneRate + (idleShares * R * params.shares[lane]) / (params.shares[lane] + otherDebtShares) : 0;
  let wait = rem > 0 && repayRate > 0 ? Math.ceil((-nb / repayRate) * 1000) : 0;
  let nc = capTokens;
  if (nc !== undefined) {
    nc -= units;
    if (nc < 0) wait = Math.max(wait, Math.ceil((-nc / params.laneCap) * 1000));
  }

  if (maxWait >= 0 && wait > maxWait) {
    const refused: HtbState = { ts: now, g, lanes, caps };
    if (capTokens !== undefined) refused.caps[lane] = capTokens;
    return { state: refused, wait: -wait };
  }
  if (params.observe) {
    nb = Math.max(nb, -laneRate * burst);
    if (nc !== undefined) nc = Math.max(nc, -params.laneCap * burst);
  }
  lanes[lane] = nb;
  if (nc !== undefined) caps[lane] = nc;
  return { state: { ts: now, g: g - fromPool, lanes, caps }, wait };
}

/** The longest any lane needs to repay its debt, ms (the state's TTL must outlive it). */
export function htbLongestDebtMs(state: HtbState, rate: number, shares: Record<WriteLane, number>): number {
  let longest = 0;
  for (const lane of WRITE_LANES) {
    const debt = -(state.lanes[lane] ?? 0);
    const laneRate = shares[lane] * rate;
    if (debt > 0 && laneRate > 0) longest = Math.max(longest, Math.ceil((debt / laneRate) * 1000));
  }
  return longest;
}

/** p-quantile (nearest rank) of `values`; null when empty. Not rounded (per-unit values are fractions of a ms). */
export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx]!;
}
