import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The write lanes of the ONE shared write budget (P2.4, `write-budget.ts`).
 *
 * Every Mongo write a job sends is charged to the lane of the job that sent
 * it. The lane travels with the async context (AsyncLocalStorage), so a
 * repository deep under a BullMQ processor needs no extra argument:
 *
 *   QueueService      backfill → `backfill`, refresh → `refresh`,
 *                     live-refresh → `live`, pool sync → `pools`,
 *                     recompute-aggregates (admin healer) → `backfill`,
 *                     position-fee-refresh → `fee`, token sweeps → `other`
 *                     (`writeLaneForJob` in queue.service.ts)
 *   live listener     its poll loop → `live`
 *   fee service       every tick → `fee`
 *   anything else     `other` (the default)
 *
 * Borrowing (integrator fix 2026-10-04): an idle lane's refill repays the
 * busy lanes' DEBT first, so one lane alone gets ~all of R even with chunks
 * larger than one second of R (see `htbAcquire`).
 *
 * Each lane has a guaranteed minimum share of the budget
 * (`WRITE_BUDGET_SHARES`) and borrows whatever the others leave idle — so a
 * backfill flood can never take the fee or refresh lanes below their shares.
 *
 * With `WRITE_BUDGET_MODE=off` (the default) the lane is only a label: nothing
 * reads it on the write path.
 */
export type WriteLane = 'live' | 'fee' | 'refresh' | 'backfill' | 'pools' | 'other';

/** Every lane, in the fixed order the budget's Lua state uses. */
export const WRITE_LANES: readonly WriteLane[] = ['live', 'fee', 'refresh', 'backfill', 'pools', 'other'];

/** The lane of a write sent outside any `runInWriteLane` scope. */
export const DEFAULT_WRITE_LANE: WriteLane = 'other';

export function isWriteLane(value: unknown): value is WriteLane {
  return typeof value === 'string' && (WRITE_LANES as readonly string[]).includes(value);
}

const storage = new AsyncLocalStorage<WriteLane>();

/**
 * Run `fn` with every write it (transitively) sends charged to `lane`.
 * Nested scopes take the INNER lane. Returns whatever `fn` returns (a promise
 * stays a promise), so a processor wraps as `runInWriteLane('backfill', () => work(job))`.
 */
export function runInWriteLane<T>(lane: WriteLane, fn: () => T): T {
  return storage.run(isWriteLane(lane) ? lane : DEFAULT_WRITE_LANE, fn);
}

/** The lane of the current async context; `other` outside any scope. */
export function currentWriteLane(): WriteLane {
  return storage.getStore() ?? DEFAULT_WRITE_LANE;
}

/**
 * The lane set by an enclosing `runInWriteLane`, or undefined outside any
 * scope — for a writer whose writes belong to one lane whoever calls it
 * (pool upserts default to `pools`, not `other`).
 */
export function explicitWriteLane(): WriteLane | undefined {
  return storage.getStore();
}
