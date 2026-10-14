/**
 * Process-local counters for the read path's degraded and paced answers — the
 * numbers the staleness and partial-response SLOs are measured against. Read
 * by `GET /admin/sync/status` (`readPath`); reset only by a restart.
 *
 *  - `staleServed`: a response flagged `stale: true` (data older than the
 *    staleness budget: a timeout fallback, a read from a secondary lagging
 *    past the budget, or a deep page started from an aged ladder rung), by
 *    route. The SLO is the share of list/count responses that carry it.
 *  - `partialServed`: an all-chains list that dropped a chain (`partial`).
 *  - `countPending`: a `/count` route that answered `pending: true`, by reason.
 *  - `budget`: the global read budget, per lane — reservations, the time spent
 *    waiting for one, and the ones that could not be had before the deadline.
 *  - `deepWalks`: deep-page walks, the rows they read, how many started from
 *    a ladder rung (`fromRung`) and from an AGED one (`fromAgedRung`, the page
 *    flagged stale), and the background walks (`background`: started,
 *    finished, failed) that carry a page past its request's deadline.
 *  - `readModelScans` (P-R): how often the read models' paced Mongo scans
 *    were told to yield because the user read budget was under pressure, and
 *    when that last happened — the scans never draw from the user lanes.
 */

export interface ReadBudgetLaneStats {
  reservations: number;
  rows: number;
  waits: number;
  waitMs: number;
  rejected: number;
  fallback: number;
}

const state = {
  since: Date.now(),
  staleServed: new Map<string, { count: number; maxAgeMs: number }>(),
  partialServed: new Map<string, number>(),
  countPending: new Map<string, number>(),
  budget: new Map<string, ReadBudgetLaneStats>(),
  deepWalks: { walks: 0, rows: 0, fromRung: 0, fromAgedRung: 0, partial: 0, maxRows: 0 },
  deepBackground: { started: 0, finished: 0, failed: 0 },
  readModelScans: { yielded: 0, lastYieldAt: 0 },
};

function lane(name: string): ReadBudgetLaneStats {
  let entry = state.budget.get(name);
  if (!entry) {
    entry = { reservations: 0, rows: 0, waits: 0, waitMs: 0, rejected: 0, fallback: 0 };
    state.budget.set(name, entry);
  }
  return entry;
}

export const readPathMeter = {
  staleServed(route: string, ageMs: number): void {
    const entry = state.staleServed.get(route) ?? { count: 0, maxAgeMs: 0 };
    entry.count++;
    entry.maxAgeMs = Math.max(entry.maxAgeMs, Math.max(0, Math.round(ageMs)));
    state.staleServed.set(route, entry);
  },
  partialServed(route: string): void {
    state.partialServed.set(route, (state.partialServed.get(route) ?? 0) + 1);
  },
  countPending(route: string, reason: string): void {
    const key = `${route}:${reason}`;
    state.countPending.set(key, (state.countPending.get(key) ?? 0) + 1);
  },
  budgetReserved(name: string, rows: number, waitMs: number, fallback: boolean): void {
    const entry = lane(name);
    entry.reservations++;
    entry.rows += rows;
    if (waitMs > 0) {
      entry.waits++;
      entry.waitMs += waitMs;
    }
    if (fallback) entry.fallback++;
  },
  budgetRejected(name: string): void {
    lane(name).rejected++;
  },
  deepWalk(rows: number, fromRung: boolean, partial: boolean, fromAgedRung = false): void {
    state.deepWalks.walks++;
    state.deepWalks.rows += rows;
    state.deepWalks.maxRows = Math.max(state.deepWalks.maxRows, rows);
    if (fromRung) state.deepWalks.fromRung++;
    if (fromAgedRung) state.deepWalks.fromAgedRung++;
    if (partial) state.deepWalks.partial++;
  },
  deepBackground(event: 'started' | 'finished' | 'failed'): void {
    state.deepBackground[event]++;
  },
  /** The read models' scans were told to pause for user-read pressure (P-R). */
  readModelScanYield(): void {
    state.readModelScans.yielded++;
    state.readModelScans.lastYieldAt = Date.now();
  },
};

/** The counters as plain JSON (for `/admin/sync/status`). */
export function readPathSnapshot() {
  return {
    since: new Date(state.since).toISOString(),
    staleServed: Object.fromEntries(state.staleServed),
    partialServed: Object.fromEntries(state.partialServed),
    countPending: Object.fromEntries(state.countPending),
    budget: Object.fromEntries(state.budget),
    deepWalks: { ...state.deepWalks, background: { ...state.deepBackground } },
    readModelScans: {
      yielded: state.readModelScans.yielded,
      lastYieldAt: state.readModelScans.lastYieldAt ? new Date(state.readModelScans.lastYieldAt).toISOString() : null,
    },
  };
}

/** Specs only. */
export function resetReadPathMeter(): void {
  state.since = Date.now();
  state.staleServed.clear();
  state.partialServed.clear();
  state.countPending.clear();
  state.budget.clear();
  state.deepWalks = { walks: 0, rows: 0, fromRung: 0, fromAgedRung: 0, partial: 0, maxRows: 0 };
  state.deepBackground = { started: 0, finished: 0, failed: 0 };
  state.readModelScans = { yielded: 0, lastYieldAt: 0 };
}
