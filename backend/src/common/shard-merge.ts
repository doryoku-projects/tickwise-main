/**
 * Merge helpers for scatter-gather "all chains" list queries. Collections are
 * sharded per (chainId, protocol), so an all-chains page is N per-shard
 * queries — each fetching its own correctly-sorted top `page × limit` rows —
 * merged in Node and re-sorted with a comparator that REPLICATES the shard's
 * Mongo sort spec (field + direction + tie-break). Any divergence between this
 * comparator and the Mongo sort would make the merged global order disagree
 * with the single-chain order for the same rows.
 */

/** Resolve a dotted path ("metrics.aprExGas") against a lean document. */
export function valueAtPath(doc: unknown, path: string): unknown {
  let current: unknown = doc;
  for (const key of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * The BSON sort order of a sort-key value, as MongoDB orders mixed values in
 * one field (verified on 8.0.32, `$documents` + `$sort`):
 *
 *   null = missing  <  NaN  <  -Infinity < … numbers … < +Infinity  <  strings  <  everything else
 *
 * `class` is that bracket; `n` the number inside the numeric one.
 */
function sortClass(value: unknown): { cls: 0 | 1 | 2 | 3 | 4; n?: number; s?: string } {
  if (value === null || value === undefined) return { cls: 0 };
  if (typeof value === 'number') return Number.isNaN(value) ? { cls: 1 } : { cls: 2, n: value };
  if (typeof value === 'bigint') return { cls: 2, n: Number(value) };
  if (typeof value === 'string') return { cls: 3, s: value };
  return { cls: 4 };
}

/**
 * Compare two sort-key values exactly as MongoDB sorts them (`sortClass`):
 * missing/null lowest, then NaN, then every number INCLUDING ±Infinity by
 * value — +Infinity is the HIGHEST number, never folded into the bottom
 * bracket — then strings. `collated` strings compare like the leaderboard's
 * `numericOrdering` collation (`compareNumericString`); uncollated ones
 * (the pools collection) plain lexicographically, which is MongoDB's binary
 * order for the ASCII ids and symbols stored there. Two values of the last
 * bracket (objects, booleans, dates — never written to a sort field) tie.
 */
export function compareSortValue(a: unknown, b: unknown, collated = true): number {
  const ca = sortClass(a);
  const cb = sortClass(b);
  if (ca.cls !== cb.cls) return ca.cls < cb.cls ? -1 : 1;
  if (ca.cls === 2) return ca.n! < cb.n! ? -1 : ca.n! > cb.n! ? 1 : 0;
  if (ca.cls === 3) {
    if (collated) return Math.sign(compareNumericString(ca.s, cb.s));
    return ca.s! < cb.s! ? -1 : ca.s! > cb.s! ? 1 : 0;
  }
  return 0;
}

/**
 * Numeric field compare in BSON order (`compareSortValue`, collated): missing
 * and null below NaN, NaN below every number, +Infinity above every finite
 * number — in both directions once the direction multiplier is applied
 * (first ascending, last descending for missing/null).
 */
export function compareNumericField(a: unknown, b: unknown): number {
  return compareSortValue(a, b, true);
}

/**
 * Numeric-aware string compare replicating Mongo's `numericOrdering: true`
 * collation for the digit-string ids (tokenId/positionId): pure-digit strings
 * compare by magnitude (shorter = smaller, then lexicographic — safe past
 * 2^53), everything else falls back to plain lexicographic.
 */
export function compareNumericString(a: unknown, b: unknown): number {
  const as = String(a ?? '');
  const bs = String(b ?? '');
  if (/^\d+$/.test(as) && /^\d+$/.test(bs) && as.length !== bs.length) {
    return as.length - bs.length;
  }
  return as < bs ? -1 : as > bs ? 1 : 0;
}
