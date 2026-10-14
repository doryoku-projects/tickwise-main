import { canonicalNumber, canonicalPid, oddCell, type Cell, type OddType } from '../core/cells.js';
import { leafIndex, leavesOf, leavesUnder, type LeafKind, type ReadModelName } from '../core/fields.js';

/**
 * Mongo document / update description → read-model row state (design §3.3).
 *
 * Input is what the change stream's shape-preserving trim (`change-stream.ts`)
 * or the scan projection (the same expressions, so both paths agree) hands
 * over: top-level leaves as stored, and each engine subtree (`metrics`,
 * `token0`, …) reduced to
 *   - an object of the needed leaves (a missing leaf stays missing),
 *   - `null` / missing, as stored,
 *   - `{ __odd: <$type> }` for anything else (an array, a string, …).
 * Raw, untrimmed documents are accepted too (the trim's fallback, specs): an
 * array or scalar where an object belongs is classified the same way.
 *
 * Classification (§4.3, §4.8): a value outside its leaf's native classes is
 * an ODD cell, which quarantines that (shard, field). null, missing, NaN and
 * ±Infinity are native; -0 becomes +0.
 */

export type LeafSet = [leaf: number, cell: Cell];

/** The update description of an `update` event (the parts read here). */
export interface UpdateDescriptionLike {
  updatedFields?: Record<string, unknown> | null;
  removedFields?: readonly string[] | null;
  truncatedArrays?: ReadonlyArray<{ field?: string; newSize?: number }> | null;
}

/** BSON `$type` names (as the trim's `{ __odd: <$type> }` carries them) → odd types. */
const BSON_TYPE_TO_ODD: Record<string, OddType> = {
  array: 'array',
  object: 'object',
  string: 'string',
  double: 'number',
  int: 'number',
  long: 'long',
  decimal: 'decimal',
  bool: 'bool',
  date: 'date',
  timestamp: 'date',
  objectId: 'objectId',
  binData: 'binary',
};

/** The trim's marker for a non-object where an engine subtree belongs. */
export function oddMarkerType(value: unknown): OddType | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const type = record.__odd;
  if (typeof type !== 'string') return undefined;
  for (const key in record) if (key !== '__odd') return undefined;
  return BSON_TYPE_TO_ODD[type] ?? 'other';
}

/** The odd type of a JS value the driver produced (for a value that is not native to its leaf). */
function oddTypeOf(value: unknown): OddType {
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  switch (typeof value) {
    case 'string':
      return 'string';
    case 'number':
    case 'bigint':
      return typeof value === 'bigint' ? 'long' : 'number';
    case 'boolean':
      return 'bool';
    case 'object': {
      const bsontype = (value as { _bsontype?: unknown })._bsontype;
      switch (bsontype) {
        case 'Long':
          return 'long';
        case 'Decimal128':
          return 'decimal';
        case 'ObjectId':
        case 'ObjectID':
          return 'objectId';
        case 'Binary':
          return 'binary';
        case 'Timestamp':
          return 'date';
        case 'Double':
        case 'Int32':
          return 'number';
        case undefined:
          return oddMarkerType(value) ?? 'object';
        default:
          return 'other';
      }
    }
    default:
      return 'other';
  }
}

/** Is this a document (an object whose leaves can be read), not a BSON value or a date? */
function isDocument(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    (value as { _bsontype?: unknown })._bsontype === undefined
  );
}

/** One stored value → its cell for a leaf of `kind`. */
export function classify(value: unknown, kind: LeafKind): Cell {
  if (value === undefined || value === null) return null;
  const marker = oddMarkerType(value);
  if (marker) return oddCell(marker);
  switch (kind) {
    case 'num':
      return typeof value === 'number' ? canonicalNumber(value) : oddCell(oddTypeOf(value));
    case 'str':
      return typeof value === 'string' ? value : oddCell(oddTypeOf(value));
    case 'bool':
      return typeof value === 'boolean' ? value : oddCell(oddTypeOf(value));
    case 'pid': {
      if (typeof value !== 'string') return oddCell(oddTypeOf(value));
      const pid = canonicalPid(value);
      return pid === undefined ? oddCell('pid') : pid;
    }
  }
}

/** A leaf under a subtree whose stored value is `ancestor`. */
function classifyUnder(ancestor: unknown, sub: string, kind: LeafKind): Cell {
  if (ancestor === undefined || ancestor === null) return null;
  const marker = oddMarkerType(ancestor);
  if (marker) return oddCell(marker);
  if (!isDocument(ancestor)) return oddCell(oddTypeOf(ancestor));
  return classify(ancestor[sub], kind);
}

/** A (trimmed or raw) document → the full row state of `model`. */
export function normalizeDoc(model: ReadModelName, doc: Record<string, unknown>): Cell[] {
  const leaves = leavesOf(model);
  const out: Cell[] = new Array(leaves.length);
  for (let i = 0; i < leaves.length; i++) {
    const spec = leaves[i];
    out[i] = spec.sub ? classifyUnder(doc[spec.top], spec.sub, spec.kind) : classify(doc[spec.top], spec.kind);
  }
  return out;
}

const NUMERIC_SEGMENT = /^\d+$/;

/**
 * An update description → the leaf assignments it makes, in order (a later
 * assignment to the same leaf wins; the result holds each leaf once).
 *
 *  - a TOP-LEVEL key (`metrics: {…}`) REPLACES its subtree: every leaf under
 *    it takes the new object's value, a leaf absent from it becomes missing;
 *  - a dotted key sets that leaf (`metrics.aprExGas`); a key BELOW a leaf
 *    (`metrics.aprExGas.x`) makes the leaf a container (odd); a numeric
 *    component under a subtree (`metrics.0…`) means the subtree is an array:
 *    every leaf under it is odd;
 *  - `removedFields`: a removed leaf or subtree becomes missing;
 *  - `truncatedArrays` on a subtree or a leaf: odd (it is an array).
 * Keys that touch no leaf of `model` are ignored.
 */
export function normalizeUpdate(model: ReadModelName, update: UpdateDescriptionLike): LeafSet[] {
  const leaves = leavesOf(model);
  const sets = new Map<number, Cell>();
  const set = (leaf: number, cell: Cell) => {
    sets.delete(leaf); // re-insert so the iteration order is the order of the last assignment
    sets.set(leaf, cell);
  };
  const oddAllUnder = (top: string, type: OddType) => {
    for (const leaf of leavesUnder(model, top)) set(leaf, oddCell(type));
  };

  const updated = update.updatedFields ?? {};
  for (const key of Object.keys(updated)) {
    const value = updated[key];
    const segs = key.split('.');
    const top = segs[0];
    const topLeaf = leafIndex(model, top);
    if (segs.length === 1) {
      if (topLeaf >= 0) set(topLeaf, classify(value, leaves[topLeaf].kind));
      for (const leaf of leavesUnder(model, top)) set(leaf, classifyUnder(value, leaves[leaf].sub!, leaves[leaf].kind));
      continue;
    }
    if (topLeaf >= 0) {
      // `owner.x` / `owner.0`: the leaf itself is now a container.
      set(topLeaf, oddCell(NUMERIC_SEGMENT.test(segs[1]) ? 'array' : 'object'));
      continue;
    }
    if (leavesUnder(model, top).length === 0) continue;
    if (NUMERIC_SEGMENT.test(segs[1])) {
      oddAllUnder(top, 'array');
      continue;
    }
    const leaf = leafIndex(model, `${top}.${segs[1]}`);
    if (leaf < 0) continue;
    set(leaf, segs.length === 2 ? classify(value, leaves[leaf].kind) : oddCell(NUMERIC_SEGMENT.test(segs[2]) ? 'array' : 'object'));
  }

  for (const key of update.removedFields ?? []) {
    const segs = key.split('.');
    const top = segs[0];
    const topLeaf = leafIndex(model, top);
    if (segs.length === 1) {
      if (topLeaf >= 0) set(topLeaf, null);
      for (const leaf of leavesUnder(model, top)) set(leaf, null);
      continue;
    }
    // Removing something INSIDE a leaf or an array element leaves the
    // container a container: whatever made it odd still holds.
    if (topLeaf >= 0 || NUMERIC_SEGMENT.test(segs[1])) continue;
    const leaf = leafIndex(model, `${top}.${segs[1]}`);
    if (leaf >= 0 && segs.length === 2) set(leaf, null);
  }

  for (const truncated of update.truncatedArrays ?? []) {
    const field = typeof truncated?.field === 'string' ? truncated.field : '';
    if (!field) continue;
    const segs = field.split('.');
    const top = segs[0];
    const topLeaf = leafIndex(model, top);
    if (topLeaf >= 0) {
      set(topLeaf, oddCell('array'));
      continue;
    }
    if (segs.length === 1 || NUMERIC_SEGMENT.test(segs[1])) {
      oddAllUnder(top, 'array');
      continue;
    }
    const leaf = leafIndex(model, `${top}.${segs[1]}`);
    if (leaf >= 0) set(leaf, oddCell('array'));
  }

  return [...sets];
}

/** `state` with `sets` applied (a new array). */
export function applySets(state: readonly Cell[], sets: readonly LeafSet[]): Cell[] {
  const out = state.slice();
  for (const [leaf, cell] of sets) out[leaf] = cell;
  return out;
}

/** The 24-hex form of an ObjectId `_id`, or undefined for any other `_id` type. */
export function oidHex(id: unknown): string | undefined {
  if (!id || typeof id !== 'object') return undefined;
  const record = id as { _bsontype?: unknown; toHexString?: () => string };
  if ((record._bsontype === 'ObjectId' || record._bsontype === 'ObjectID') && typeof record.toHexString === 'function') {
    const hex = record.toHexString();
    return /^[0-9a-f]{24}$/.test(hex) ? hex : undefined;
  }
  return undefined;
}
