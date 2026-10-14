import { CLS } from './cells.js';

/**
 * MongoDB's sort order for the values a numeric engine column holds (design
 * §4.3, measured on 8.0.32 — `shard-merge.ts` `compareSortValue` and the
 * mini-mongo spec double encode the same rule independently):
 *
 *     null = missing  <  NaN  <  −Infinity < … numbers … < +Infinity
 *
 * `-0` ties `+0` (R1 stores it as `+0`). Anything else in a numeric field
 * (a string, an array, a Decimal128 …) is an ODD cell: it quarantines the
 * (shard, field) and no engine query that reads the field is answered
 * (§4.8), so its key below only has to be deterministic.
 *
 * Engine columns keep a NUMERIC CLASS per row next to the f64:
 */
export const NC_NULL = 0;
export const NC_NAN = 1;
export const NC_NUM = 2;
export const NC_ODD = 3;

/** R1 cell class + value → numeric class. */
export function numClassOf(cls: number, value: number): number {
  if (cls === CLS.NULL) return NC_NULL;
  if (cls === CLS.NUM) return Number.isNaN(value) ? NC_NAN : NC_NUM;
  return NC_ODD;
}

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);
/** Index of the high word of `f64[0]` in `u32` (1 on little-endian hosts). */
const HI = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? 1 : 0;
const LO = 1 - HI;

/**
 * The 64-bit ascending sort key of a numeric cell, as two u32 words written
 * to `hi[i]` / `lo[i]`:
 *  - null → 0, NaN → 1;
 *  - a number → its IEEE bits, sign-flipped so unsigned order is numeric
 *    order (negative: all bits inverted; positive: the sign bit set).
 *    −Infinity becomes 0x000F_FFFF_FFFF_FFFF, which is > 1; +0 becomes
 *    0x8000_0000_0000_0000;
 *  - odd → all ones (after every number).
 * `descending` complements the key, which reverses the order and keeps equal
 * keys equal (so a stable sort keeps their tie order).
 */
export function writeSortKey(numClass: number, value: number, descending: boolean, hi: Uint32Array, lo: Uint32Array, i: number): void {
  let h: number;
  let l: number;
  if (numClass === NC_NUM) {
    f64[0] = value === 0 ? 0 : value;
    h = u32[HI];
    l = u32[LO];
    if (h & 0x80000000) {
      h = ~h >>> 0;
      l = ~l >>> 0;
    } else {
      h = (h | 0x80000000) >>> 0;
    }
  } else if (numClass === NC_NULL) {
    h = 0;
    l = 0;
  } else if (numClass === NC_NAN) {
    h = 0;
    l = 1;
  } else {
    h = 0xffffffff;
    l = 0xffffffff;
  }
  if (descending) {
    h = ~h >>> 0;
    l = ~l >>> 0;
  }
  hi[i] = h;
  lo[i] = l;
}

/** Ascending BSON comparison of two numeric cells (class + value). */
export function compareNumCells(classA: number, a: number, classB: number, b: number): number {
  if (classA !== classB) return classA < classB ? -1 : 1;
  if (classA !== NC_NUM) return 0;
  return a < b ? -1 : a > b ? 1 : 0;
}
