import { processWriteBudget, type WriteBudgetService } from '../common/write-budget.js';
import { effectiveChunkOps, WRITE_BUDGET_OFF, WRITE_UNITS } from '../common/write-budget-model.js';
import { currentWriteLane, type WriteLane } from '../common/write-lane.js';

/*
 * Every budgeted Mongo bulk write goes out through here (P2.4, design §5.2):
 *
 *   split into chunks of ≤ `effectiveChunkOps` (the caller's cap,
 *   `MONGO_BULK_WRITE_MAX_OPS`, and 500 whenever the budget is on)
 *     → acquire Σ units of the chunk (+ the batch's primary-read units, with
 *       the FIRST chunk) for the current lane
 *     → `bulkWrite` (with the driver's `timeoutMS` while the budget is on)
 *     → record `{ms, units, ops}` in the chunk's size class (the controller's
 *       latency inputs) → `onChunk`.
 *
 * With the budget off (`WRITE_BUDGET_MODE=off`, the default) and
 * `MONGO_BULK_WRITE_MAX_OPS` unset this is exactly `model.bulkWrite(ops, bulkOptions)`
 * per caller chunk: no acquire, no measurement, no Redis, no extra option.
 */

/** The driver's per-chunk timeout while the budget is on (a hung write must not hold a lane forever). */
export const BUDGETED_CHUNK_TIMEOUT_MS = 60_000;

/** The part of a Mongoose model this needs (specs pass a fake). */
export interface BulkWritable<TOp> {
  bulkWrite(ops: TOp[], options?: Record<string, unknown>): Promise<unknown>;
}

export interface BudgetedBulkWriteOptions<TOp> {
  /** The budget; default the process's (`processWriteBudget()`, undefined while off). */
  budget?: WriteBudgetService;
  /** Units of one op (default `unitsPerOp`). */
  unitsOf?: (op: TOp, index: number) => number;
  /** Units of every op when `unitsOf` is not given (default `WRITE_UNITS.other`). */
  unitsPerOp?: number;
  /** Documents this batch READ on the primary to decide the writes (charged × `WRITE_BUDGET_READ_UNIT` with the first chunk). */
  readDocs?: number;
  /** Read units already computed (added to `readDocs`'s). */
  readUnits?: number;
  /** The caller's own chunk cap (today's chunking, e.g. pools 500, fee writes 100). */
  maxOps?: number;
  /** Lane to charge; default the async context's (`currentWriteLane()`). */
  lane?: WriteLane;
  /** Driver options, passed as given (today's `{ ordered: false }`). */
  bulkOptions?: Record<string, unknown>;
  /** enforce: refuse a chunk whose wait would pass this (throws `WriteBudgetTimeoutError`). Default: no limit. */
  maxWaitMs?: number;
  signal?: AbortSignal;
  /** After each chunk's write succeeded (callers that remember per-chunk state). */
  onChunk?: (result: BulkChunkResult, chunk: TOp[], offset: number) => void | Promise<void>;
  /** Clock for specs. */
  now?: () => number;
}

/** The counts of one chunk's `bulkWrite` result (any field the driver did not report reads 0). */
export interface BulkChunkResult {
  insertedCount: number;
  matchedCount: number;
  modifiedCount: number;
  deletedCount: number;
  upsertedCount: number;
  /** Index (in the CHUNK) → upserted `_id`. */
  upsertedIds: Record<number, unknown>;
  raw: unknown;
}

export interface BudgetedBulkWriteResult {
  chunks: number;
  ops: number;
  /** Units acquired (write + read). */
  units: number;
  /** Time spent waiting for the budget (enforce). */
  waitedMs: number;
  insertedCount: number;
  matchedCount: number;
  modifiedCount: number;
  deletedCount: number;
  upsertedCount: number;
  /** Index (in `ops`) → upserted `_id`. */
  upsertedIds: Record<number, unknown>;
}

function count(raw: unknown, field: string): number {
  const value = (raw as Record<string, unknown> | null | undefined)?.[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function chunkResult(raw: unknown): BulkChunkResult {
  const ids = (raw as { upsertedIds?: Record<string, unknown> } | null | undefined)?.upsertedIds;
  const upsertedIds: Record<number, unknown> = {};
  if (ids && typeof ids === 'object') for (const [k, v] of Object.entries(ids)) upsertedIds[Number(k)] = v;
  return {
    insertedCount: count(raw, 'insertedCount'),
    matchedCount: count(raw, 'matchedCount'),
    modifiedCount: count(raw, 'modifiedCount'),
    deletedCount: count(raw, 'deletedCount'),
    upsertedCount: count(raw, 'upsertedCount'),
    upsertedIds,
    raw,
  };
}

/**
 * Write `ops` through the shared write budget, in chunks (see the file
 * comment). A chunk that throws is recorded (its latency is a real signal)
 * and the error propagates — chunks before it stay written, as with today's
 * caller-side chunking; `onChunk` has seen exactly those.
 */
export async function budgetedBulkWrite<TOp>(
  model: BulkWritable<TOp>,
  ops: TOp[],
  opts: BudgetedBulkWriteOptions<TOp> = {},
): Promise<BudgetedBulkWriteResult> {
  const budget = opts.budget ?? processWriteBudget();
  const settings = budget?.settings ?? WRITE_BUDGET_OFF;
  const on = budget !== undefined && settings.mode !== 'off';
  const now = opts.now ?? Date.now;
  const size = effectiveChunkOps(settings, opts.maxOps);
  const lane = opts.lane ?? currentWriteLane();
  const unitsPerOp = opts.unitsPerOp !== undefined && opts.unitsPerOp >= 0 ? opts.unitsPerOp : WRITE_UNITS.other;
  const unitsOf = opts.unitsOf ?? (() => unitsPerOp);
  let readUnits = Math.max(0, opts.readUnits ?? 0) + (on ? budget!.readUnits(opts.readDocs ?? 0) : 0);
  const out: BudgetedBulkWriteResult = {
    chunks: 0,
    ops: 0,
    units: 0,
    waitedMs: 0,
    insertedCount: 0,
    matchedCount: 0,
    modifiedCount: 0,
    deletedCount: 0,
    upsertedCount: 0,
    upsertedIds: {},
  };
  if (ops.length === 0) {
    // A read that decided "nothing to write" still cost the primary.
    if (on && readUnits > 0) budget!.charge(readUnits, lane);
    return out;
  }
  for (let offset = 0; offset < ops.length; offset += size) {
    const chunk = ops.slice(offset, offset + size);
    let writeUnits = 0;
    if (on) for (let i = 0; i < chunk.length; i++) writeUnits += Math.max(0, unitsOf(chunk[i]!, offset + i));
    const units = writeUnits + readUnits;
    readUnits = 0;
    if (on) {
      const grant = await budget!.acquire(units, { lane, maxWaitMs: opts.maxWaitMs, signal: opts.signal });
      out.waitedMs += grant.waitedMs;
    }
    const options = on ? { ...(opts.bulkOptions ?? {}), timeoutMS: BUDGETED_CHUNK_TIMEOUT_MS } : opts.bulkOptions;
    const started = now();
    let raw: unknown;
    try {
      raw = options === undefined ? await model.bulkWrite(chunk) : await model.bulkWrite(chunk, options);
    } catch (err) {
      if (on) budget!.recordChunk({ ms: now() - started, units: writeUnits, ops: chunk.length, lane });
      throw err;
    }
    if (on) budget!.recordChunk({ ms: now() - started, units: writeUnits, ops: chunk.length, lane });
    const result = chunkResult(raw);
    out.chunks++;
    out.ops += chunk.length;
    out.units += units;
    out.insertedCount += result.insertedCount;
    out.matchedCount += result.matchedCount;
    out.modifiedCount += result.modifiedCount;
    out.deletedCount += result.deletedCount;
    out.upsertedCount += result.upsertedCount;
    for (const [index, id] of Object.entries(result.upsertedIds)) out.upsertedIds[offset + Number(index)] = id;
    await opts.onChunk?.(result, chunk, offset);
  }
  return out;
}

/**
 * Budget ONE write that is not a `bulkWrite` (`updateMany` of a stale-sweep
 * chunk, a `findOneAndUpdate`): acquire `units` for the lane, run `write`,
 * record its latency as a chunk of `ops` documents. `ops` decides the size
 * class, so a 500-document `updateMany` is measured like a 500-op bulkWrite.
 * Off → `write()` exactly, nothing else.
 */
export async function budgetedWrite<T>(
  write: () => Promise<T>,
  opts: { units: number; ops: number; budget?: WriteBudgetService; lane?: WriteLane; maxWaitMs?: number; signal?: AbortSignal; now?: () => number },
): Promise<T> {
  const budget = opts.budget ?? processWriteBudget();
  if (!budget?.enabled) return write();
  const lane = opts.lane ?? currentWriteLane();
  const now = opts.now ?? Date.now;
  await budget.acquire(opts.units, { lane, maxWaitMs: opts.maxWaitMs, signal: opts.signal });
  const started = now();
  try {
    return await write();
  } finally {
    budget.recordChunk({ ms: now() - started, units: opts.units, ops: opts.ops, lane });
  }
}

/**
 * Charge a primary read that is NOT followed by a budgeted write (or whose
 * write goes out elsewhere): `docs × WRITE_BUDGET_READ_UNIT` to the lane,
 * never waiting. No-op while the budget is off.
 */
export function chargePrimaryRead(docs: number, opts: { budget?: WriteBudgetService; lane?: WriteLane } = {}): void {
  const budget = opts.budget ?? processWriteBudget();
  if (!budget?.enabled || !(docs > 0)) return;
  budget.charge(budget.readUnits(docs), opts.lane ?? currentWriteLane());
}
