import { isOdd, type Cell } from '../core/cells.js';
import type { LeafSet } from './normalize.js';
import type { RowChange } from './messages.js';

/**
 * The scan buffer (design §3.2 step 2): while a shard is being scanned, its
 * change-stream events are held here, COALESCED per `_id` into
 *   base op (none | full state | delete) followed by the leaf sets after it,
 * which applied on top of the scanned row equals replaying the events in
 * order:
 *   - insert / replace       → base = that state, earlier sets dropped;
 *   - delete                 → base = delete, earlier sets dropped;
 *   - update on base `state` → the sets fold into the state;
 *   - update on base `none`  → the sets merge (a later set of a leaf wins);
 *   - update on base `delete`→ cannot happen without an insert in between
 *                              (counted, ignored).
 * Per field the result is the LAST event's value if any (equal to the
 * scanned value when that event preceded the scan's snapshot), else the
 * scanned value — the correctness argument of §3.2 step 6.
 *
 * Bounded: past `capBytes` (an estimate of the records' heap size) `add`
 * refuses and the buffer is `overflowed`; the caller then stops reading the
 * stream and replays it after `lastRt`, the token of the last event that WAS
 * buffered (cold start), or restarts the shard scan (in-epoch shard scans).
 *
 * R1: the records live on the worker's JS heap (estimated, capped well below
 * the worker's heap limit) rather than off-heap as the design sketches; the
 * replay mode covers a cluster too busy to fit.
 */

interface BufferRecord {
  coll: string;
  oid: string;
  base: 'none' | 'state' | 'delete';
  state?: Cell[];
  sets?: Map<number, Cell>;
  rt?: string;
  ct?: string;
  bytes: number;
}

export class ScanBuffer {
  private readonly records = new Map<string, BufferRecord>();
  private bytesUsed = 0;
  overflowed = false;
  /** Token / time of the last event buffered (the replay point after an overflow). */
  lastRt?: string;
  lastCt?: string;
  /** Updates that arrived after a delete with no insert between (should not happen; counted). */
  orphanUpdates = 0;

  constructor(readonly capBytes: number) {}

  get size(): number {
    return this.records.size;
  }

  get bytes(): number {
    return this.bytesUsed;
  }

  /** Buffer one change; false (and `overflowed`) when it does not fit. */
  add(change: RowChange): boolean {
    if (this.overflowed) return false;
    const key = `${change.coll}|${change.oid}`;
    const existing = this.records.get(key);
    const before = existing?.bytes ?? 0;
    const next = coalesce(existing, change);
    next.bytes = estimate(next);
    if (this.bytesUsed - before + next.bytes > this.capBytes) {
      this.overflowed = true;
      return false;
    }
    this.records.set(key, next);
    this.bytesUsed += next.bytes - before;
    if (change.rt) this.lastRt = change.rt;
    if (change.ct) this.lastCt = change.ct;
    if (next.base === 'delete' && change.base === 'none') this.orphanUpdates++;
    return true;
  }

  /** Remove and return the coalesced records of `coll` (or of every collection), in first-seen order. */
  drain(coll?: string): RowChange[] {
    const out: RowChange[] = [];
    for (const [key, record] of this.records) {
      if (coll !== undefined && record.coll !== coll) continue;
      this.records.delete(key);
      this.bytesUsed -= record.bytes;
      out.push(toChange(record));
    }
    return out;
  }

  /** Forget everything (an aborted scan). */
  clear(): void {
    this.records.clear();
    this.bytesUsed = 0;
    this.overflowed = false;
    this.lastRt = undefined;
    this.lastCt = undefined;
  }
}

function coalesce(existing: BufferRecord | undefined, change: RowChange): BufferRecord {
  const stamp = { rt: change.rt ?? existing?.rt, ct: change.ct ?? existing?.ct };
  if (change.base === 'state') {
    const state = (change.state ?? []).slice();
    for (const [leaf, cell] of change.sets ?? []) state[leaf] = cell;
    return { coll: change.coll, oid: change.oid, base: 'state', state, ...stamp, bytes: 0 };
  }
  if (change.base === 'delete') return { coll: change.coll, oid: change.oid, base: 'delete', ...stamp, bytes: 0 };
  // An update.
  if (!existing) {
    return { coll: change.coll, oid: change.oid, base: 'none', sets: new Map(change.sets ?? []), ...stamp, bytes: 0 };
  }
  if (existing.base === 'state') {
    const state = existing.state!.slice();
    for (const [leaf, cell] of change.sets ?? []) state[leaf] = cell;
    return { ...existing, state, ...stamp };
  }
  if (existing.base === 'delete') return { ...existing, ...stamp };
  const sets = new Map(existing.sets);
  for (const [leaf, cell] of change.sets ?? []) {
    sets.delete(leaf);
    sets.set(leaf, cell);
  }
  return { ...existing, sets, ...stamp };
}

function toChange(record: BufferRecord): RowChange {
  const change: RowChange = { coll: record.coll, oid: record.oid, base: record.base };
  if (record.state) change.state = record.state;
  if (record.sets && record.sets.size > 0) change.sets = [...record.sets] as LeafSet[];
  if (record.rt) change.rt = record.rt;
  if (record.ct) change.ct = record.ct;
  return change;
}

function cellBytes(cell: Cell): number {
  if (typeof cell === 'string') return 24 + cell.length * 2;
  if (isOdd(cell)) return 8;
  return 16;
}

/** A rough heap-size estimate of one record (Map/array/object overheads included). */
function estimate(record: BufferRecord): number {
  let bytes = 160 + (record.coll.length + record.oid.length) * 2 + (record.rt?.length ?? 0) * 2;
  if (record.state) for (const cell of record.state) bytes += cellBytes(cell);
  if (record.sets) for (const cell of record.sets.values()) bytes += 40 + cellBytes(cell);
  return bytes;
}
