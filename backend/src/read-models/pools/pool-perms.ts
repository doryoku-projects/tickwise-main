import { compareNumCells, writeSortKey } from '../core/bson-order.js';
import { newBitset, setBit, testBit } from '../core/bitset.js';
import { POOL_ID_COL, POOL_PERMS, type DictView, type PoolColumnArrays, type PoolOverlay } from './pool-columns.js';

/**
 * The catalog's sort permutations (design §4.6, §5.1): per shard, one list of
 * live slots per pools-list sort, ordered by the sort leaf in BSON order
 * (`bson-order.ts`; descending for tvl / volume / fees / fee_apr, ascending
 * for age) and then by `poolId` ascending, BINARY — MongoDB's order for the
 * uncollated pools query `{<metric>: dir, poolId: 1}`.
 *
 *  - BUILD (load, full rebuild): live slots → sorted by poolId (LSD radix on
 *    the 8-byte prefix, then any run of equal prefixes by a byte compare) →
 *    per sort a stable LSD radix on the 64-bit BSON key, which keeps the
 *    poolId order inside equal keys. O(n) per sort.
 *  - UPDATE (every generation): the old permutation minus the changed slots,
 *    merged with the changed slots that are live, sorted — O(n) copying plus
 *    O(c log n) comparisons. Exact: the result equals a full build (spec).
 * Pure functions over shared arrays: they run in a pass worker or in-thread.
 */

/** Binary (UTF-8 byte) order of two dictionary entries, the 8-byte prefixes first. Id + 1 encoding; 0 (null) sorts first. */
export function comparePoolIds(
  dictA: DictView,
  sidA: number,
  hiA: number,
  loA: number,
  dictB: DictView,
  sidB: number,
  hiB: number,
  loB: number,
): number {
  if (sidA === 0 || sidB === 0) return sidA === sidB ? 0 : sidA === 0 ? -1 : 1;
  if (hiA !== hiB) return hiA < hiB ? -1 : 1;
  if (loA !== loB) return loA < loB ? -1 : 1;
  if (dictA === dictB && sidA === sidB) return 0;
  return compareEntries(dictA, sidA - 1, dictB, sidB - 1);
}

/** memcmp of two dictionary entries, then length. */
export function compareEntries(dictA: DictView, idA: number, dictB: DictView, idB: number): number {
  let a = dictA.offsets[idA];
  const aEnd = dictA.offsets[idA + 1];
  let b = dictB.offsets[idB];
  const bEnd = dictB.offsets[idB + 1];
  const bytesA = dictA.bytes;
  const bytesB = dictB.bytes;
  while (a < aEnd && b < bEnd) {
    const x = bytesA[a++];
    const y = bytesB[b++];
    if (x !== y) return x < y ? -1 : 1;
  }
  const restA = aEnd - a;
  const restB = bEnd - b;
  return restA === restB ? 0 : restA < restB ? -1 : 1;
}

const DIGITS = 1 << 16;

/**
 * One stable counting pass on a 16-bit digit of `words[slot]` (shift 0 or
 * 16). Returns false (and writes nothing) when every element has the same
 * digit — the pass would not change the order.
 */
function radixPass(src: Uint32Array, dst: Uint32Array, n: number, words: Uint32Array, shift: number, counts: Uint32Array): boolean {
  counts.fill(0);
  for (let i = 0; i < n; i++) counts[(words[src[i]] >>> shift) & 0xffff]++;
  for (let d = 0; d < DIGITS; d++) if (counts[d] === n) return false;
  let sum = 0;
  for (let d = 0; d < DIGITS; d++) {
    const c = counts[d];
    counts[d] = sum;
    sum += c;
  }
  for (let i = 0; i < n; i++) {
    const slot = src[i];
    dst[counts[(words[slot] >>> shift) & 0xffff]++] = slot;
  }
  return true;
}

/**
 * Stable LSD radix sort of `order[0, n)` (slots) by the 64-bit key
 * `(hi[slot], lo[slot])`. Returns whichever of `order` / `tmp` holds the
 * result.
 */
export function radixSortSlots(order: Uint32Array, tmp: Uint32Array, n: number, hi: Uint32Array, lo: Uint32Array, counts: Uint32Array): Uint32Array {
  let src = order;
  let dst = tmp;
  for (const [words, shift] of [
    [lo, 0],
    [lo, 16],
    [hi, 0],
    [hi, 16],
  ] as const) {
    if (radixPass(src, dst, n, words, shift, counts)) {
      const t = src;
      src = dst;
      dst = t;
    }
  }
  return src;
}

/** Live slots of a shard sorted by poolId (binary). */
export function poolIdOrder(cols: PoolColumnArrays, dict: DictView, slots: number, counts: Uint32Array): Uint32Array {
  let n = 0;
  for (let s = 0; s < slots; s++) if (cols.live[s] === 1) n++;
  const order = new Uint32Array(n);
  let k = 0;
  for (let s = 0; s < slots; s++) if (cols.live[s] === 1) order[k++] = s;
  const sorted = radixSortSlots(order, new Uint32Array(n), n, cols.pkHi, cols.pkLo, counts);
  // Runs of equal 8-byte prefixes: order them by the whole id (tiny runs).
  const sid = cols.sid[POOL_ID_COL];
  let start = 0;
  while (start < n) {
    let end = start + 1;
    const hi = cols.pkHi[sorted[start]];
    const lo = cols.pkLo[sorted[start]];
    while (end < n && cols.pkHi[sorted[end]] === hi && cols.pkLo[sorted[end]] === lo) end++;
    if (end - start > 1) {
      for (let i = start + 1; i < end; i++) {
        const slot = sorted[i];
        let j = i - 1;
        while (j >= start && comparePoolIds(dict, sid[sorted[j]], hi, lo, dict, sid[slot], hi, lo) > 0) {
          sorted[j + 1] = sorted[j];
          j--;
        }
        sorted[j + 1] = slot;
      }
    }
    start = end;
  }
  return sorted;
}

/**
 * Full build: every permutation of `POOL_PERMS` into `out[p]` (each at least
 * `live` long). Returns the live count (every permutation's length).
 */
export function buildPoolPerms(cols: PoolColumnArrays, dict: DictView, slots: number, out: Uint32Array[]): number {
  const counts = new Uint32Array(DIGITS);
  const byId = poolIdOrder(cols, dict, slots, counts);
  const n = byId.length;
  const hi = new Uint32Array(Math.max(1, slots));
  const lo = new Uint32Array(Math.max(1, slots));
  const order = new Uint32Array(n);
  const tmp = new Uint32Array(n);
  POOL_PERMS.forEach((perm, p) => {
    const nc = cols.nc[perm.numPos];
    const nv = cols.nv[perm.numPos];
    for (let i = 0; i < n; i++) {
      const s = byId[i];
      writeSortKey(nc[s], nv[s], perm.descending, hi, lo, s);
    }
    order.set(byId);
    const sorted = radixSortSlots(order, tmp, n, hi, lo, counts);
    out[p].set(sorted.subarray(0, n));
  });
  return n;
}

/**
 * Generation update: from the permutations of generation G (`prev`, valid
 * prefix `prevLen`, over the columns as of G) and the captured overlay, the
 * permutations of G+1 into `out` (the other A/B buffers). The columns are
 * NOT yet updated (passes on G still read them): changed rows are compared
 * through the overlay, unchanged rows through the columns — their values are
 * the same in G and G+1. Returns the new length (the same for every sort).
 */
export function updatePoolPerms(
  cols: PoolColumnArrays,
  dict: DictView,
  overlay: PoolOverlay,
  prev: Uint32Array[],
  prevLen: number,
  out: Uint32Array[],
): number {
  const changed = newBitset(cols.capacity);
  for (let i = 0; i < overlay.n; i++) setBit(changed, overlay.slots[i]);
  const incoming: number[] = [];
  for (let i = 0; i < overlay.n; i++) if (overlay.live[i] === 1) incoming.push(i);
  const sid = cols.sid[POOL_ID_COL];
  const osid = overlay.sid[POOL_ID_COL];
  let length = 0;
  POOL_PERMS.forEach((perm, p) => {
    const nc = cols.nc[perm.numPos];
    const nv = cols.nv[perm.numPos];
    const onc = overlay.nc[perm.numPos];
    const onv = overlay.nv[perm.numPos];
    const dir = perm.descending ? -1 : 1;
    // overlay row i vs overlay row j
    const cmpOO = (i: number, j: number): number => {
      const c = compareNumCells(onc[i], onv[i], onc[j], onv[j]) * dir;
      if (c !== 0) return c;
      return comparePoolIds(dict, osid[i], overlay.pkHi[i], overlay.pkLo[i], dict, osid[j], overlay.pkHi[j], overlay.pkLo[j]);
    };
    // overlay row i vs column slot s
    const cmpOC = (i: number, s: number): number => {
      const c = compareNumCells(onc[i], onv[i], nc[s], nv[s]) * dir;
      if (c !== 0) return c;
      return comparePoolIds(dict, osid[i], overlay.pkHi[i], overlay.pkLo[i], dict, sid[s], cols.pkHi[s], cols.pkLo[s]);
    };
    const target = out[p];
    const source = prev[p];
    // 1. the old order minus every changed slot
    let m = 0;
    for (let k = 0; k < prevLen; k++) {
      const slot = source[k];
      if (!testBit(changed, slot)) target[m++] = slot;
    }
    // 2. the changed live rows, sorted
    const add = incoming.slice().sort(cmpOO);
    // 3. insertion points (first unchanged row that sorts after each), then a backward merge
    const at = new Int32Array(add.length);
    for (let j = 0; j < add.length; j++) {
      let lo = j > 0 ? at[j - 1] : 0;
      let hi = m;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (cmpOC(add[j], target[mid]) > 0) lo = mid + 1;
        else hi = mid;
      }
      at[j] = lo;
    }
    let end = m;
    for (let j = add.length - 1; j >= 0; j--) {
      const from = at[j];
      const shift = j + 1;
      if (end > from) target.copyWithin(from + shift, from, end);
      target[from + j] = overlay.slots[add[j]];
      end = from;
    }
    length = m + add.length;
  });
  return length;
}
