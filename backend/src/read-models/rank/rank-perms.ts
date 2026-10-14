import { compareNumCells, NC_NUM, writeSortKey } from '../core/bson-order.js';
import { newBitset, setBit, testBit } from '../core/bitset.js';
import type { CkeyView } from '../core/ckey.js';
import { radixSortSlots } from '../pools/pool-perms.js';
import {
  ACTIVE_COL,
  BV_TRUE,
  OWNER_COL,
  PC_PID,
  PID_COL,
  POOL_COL,
  RANK_PERMS,
  VALUE_COL,
  type RankColumnArrays,
  type RankOverlay,
} from './rank-columns.js';

/**
 * The rank engine's derived structures (design §6.1–§6.2, §6.6), built in a
 * pass worker into the A/B buffers the current generation does not use:
 *
 *  - PERMUTATIONS (`RANK_PERMS`): per numeric sort the live slots (A+ only for
 *    the rate sorts) in (leaf in BSON order, descending; positionId u32
 *    ascending) order; the pid permutation in positionId order.
 *      BUILD: live slots radix-sorted by pid (2 passes), then per sort a
 *      stable LSD radix on the 64-bit BSON key (pid order kept inside ties).
 *      UPDATE: the old order minus the changed slots, plus the changed slots
 *      that now belong (live; A+ for the rate sorts — so a row whose value goes
 *      0 → 5 ENTERS the apr permutation: the membership rule of §4.6), sorted
 *      and binary-inserted. Equal to a full build (spec).
 *  - CSRs: the live slots grouped by POOL (binary dictionary id + 1; 0 = null)
 *    and by OWNER COLLATION CLASS (`ckey.ts` class id + 1; 0 = null or
 *    outside the domain), slot order inside a group — what the `pool` and
 *    `owner` shapes and the holder counts read. Rebuilt by a counting sort,
 *    O(rows + keys), only in a generation where some row's (live, pool,
 *    owner class) changed (a recorded deviation: design §6.1 merge-updates them).
 *  - HOLDER COUNTS per pool (design §6.6, `countsByPoolIds`' `$group`):
 *    `isActive: true` rows, and the distinct owners among them, BINARY
 *    (the aggregation has no collation). An active row whose owner is
 *    null / missing marks the pool AMBIGUOUS — `$addToSet` adds an explicit
 *    null but skips a missing field, and R1 stores both as one class — and
 *    such a pool is counted by Mongo instead. Recomputed for the pools whose
 *    rows' (live, pool, isActive, owner) changed.
 * Pure functions over shared arrays: a pass worker or the main thread runs them.
 */

export interface RankCsr {
  /** Live slots grouped by key, slot order inside a group (valid prefix: the live count). */
  order: Uint32Array;
  /** `order[start[k] .. start[k + 1])` holds key k; length ≥ keys + 2. */
  start: Uint32Array;
  /**
   * Keys covered (start[0 .. keys + 1] valid). The arrays are shared memory,
   * this field is not: a worker sets it on its own copy, and the engine sets
   * the owner's at the swap from the key count it requested.
   */
  keys: number;
}

/** Where a build / update writes (the "next" A/B set). */
export interface RankBuildOut {
  perms: Uint32Array[];
  pool: RankCsr;
  owner: RankCsr;
}

export interface HolderCountsDelta {
  /** Pool keys (dictionary id + 1). */
  pools: Uint32Array;
  positions: Uint32Array;
  holders: Uint32Array;
  /** 1: an active row of the pool has a null / missing owner (served by Mongo). */
  ambiguous: Uint8Array;
}

export interface RankBuildTask {
  cols: RankColumnArrays;
  ckeys: CkeyView;
  slots: number;
  /** Pool keys = dictionary size + 1 (dictionary id + 1, and 0). */
  poolKeys: number;
  /** Owner keys = collation classes + 1. */
  ownerKeys: number;
  out: RankBuildOut;
}

export interface RankBuildResult {
  permLen: number[];
  live: number;
  holders: HolderCountsDelta;
}

export interface RankUpdateTask {
  cols: RankColumnArrays;
  ckeys: CkeyView;
  overlay: RankOverlay;
  prev: RankBuildOut;
  prevLen: number[];
  /** Slots in use before the overlay. */
  slots: number;
  poolKeys: number;
  ownerKeys: number;
  out: RankBuildOut;
}

export interface RankUpdateResult {
  permLen: number[];
  /** The CSRs were rebuilt into `out` (else `prev` stays current). */
  csrRebuilt: boolean;
  holders: HolderCountsDelta;
}

const DIGITS = 1 << 16;

/**
 * The changed rows of a generation, ordered by slot, so a linear scan of the
 * slots can read each row's G+1 state — the overlay's for a changed slot, the
 * columns' otherwise — with a moving cursor instead of a per-slot lookup.
 */
interface SortedOverlay {
  overlay?: RankOverlay;
  /** Overlay indexes in slot order. */
  order: Int32Array;
}

function sortOverlay(overlay?: RankOverlay): SortedOverlay {
  if (!overlay) return { order: new Int32Array(0) };
  const order = Int32Array.from({ length: overlay.n }, (_, i) => i);
  order.sort((a, b) => overlay.slots[a] - overlay.slots[b]);
  return { overlay, order };
}

/** The owner CSR key of an owner dictionary id + 1: its collation class + 1, 0 for none. */
function ownerKey(ckeys: CkeyView, ownerSid: number): number {
  return ownerSid === 0 || ownerSid - 1 >= ckeys.size ? 0 : ckeys.classOf[ownerSid - 1];
}

/** Is a column row in A+ (isActive true, value a number > 0)? */
export function inAplus(cols: RankColumnArrays, slot: number): boolean {
  return cols.live[slot] === 1 && cols.bv[ACTIVE_COL][slot] === BV_TRUE && cols.nc[VALUE_COL][slot] === NC_NUM && cols.nv[VALUE_COL][slot] > 0;
}

function overlayInAplus(overlay: RankOverlay, i: number): boolean {
  return overlay.live[i] === 1 && overlay.bv[ACTIVE_COL][i] === BV_TRUE && overlay.nc[VALUE_COL][i] === NC_NUM && overlay.nv[VALUE_COL][i] > 0;
}

/** Live slots sorted by positionId (u32). */
function pidOrder(cols: RankColumnArrays, slots: number, counts: Uint32Array): Uint32Array {
  let n = 0;
  for (let s = 0; s < slots; s++) if (cols.live[s] === 1) n++;
  const order = new Uint32Array(n);
  let k = 0;
  for (let s = 0; s < slots; s++) if (cols.live[s] === 1) order[k++] = s;
  const zeros = new Uint32Array(Math.max(1, slots));
  return radixSortSlots(order, new Uint32Array(n), n, zeros, cols.pv[PID_COL], counts);
}

/** Full build: every permutation, both CSRs and every pool's holder counts. */
export function buildRank(task: RankBuildTask): RankBuildResult {
  const { cols, slots, out } = task;
  const counts = new Uint32Array(DIGITS);
  const byPid = pidOrder(cols, slots, counts);
  const n = byPid.length;
  const hi = new Uint32Array(Math.max(1, slots));
  const lo = new Uint32Array(Math.max(1, slots));
  const order = new Uint32Array(n);
  const tmp = new Uint32Array(n);
  const permLen: number[] = [];
  RANK_PERMS.forEach((perm, p) => {
    if (perm.numPos < 0) {
      out.perms[p].set(byPid);
      permLen.push(n);
      return;
    }
    let m = 0;
    for (let i = 0; i < n; i++) {
      const s = byPid[i];
      if (perm.aplus && !inAplus(cols, s)) continue;
      order[m++] = s;
      writeSortKey(cols.nc[perm.numPos][s], cols.nv[perm.numPos][s], perm.descending, hi, lo, s);
    }
    const sorted = radixSortSlots(order, tmp, m, hi, lo, counts);
    out.perms[p].set(sorted.subarray(0, m));
    permLen.push(m);
  });
  buildCsrs(cols, sortOverlay(), task.ckeys, slots, task.poolKeys, task.ownerKeys, out);
  const holders = countPools(out.pool, cols, new Map(), undefined, allPools(out.pool));
  return { permLen, live: n, holders };
}

/**
 * Counting sort of the live slots (as of G+1) by pool key and by owner key into
 * `out.pool` / `out.owner`, in two linear passes over the slots — each row's
 * state read from the columns or, for a changed slot, the overlay (a cursor
 * over the slot-sorted overlay; no per-slot lookup).
 */
function buildCsrs(cols: RankColumnArrays, sorted: SortedOverlay, ckeys: CkeyView, slots: number, poolKeys: number, ownerKeys: number, out: RankBuildOut): void {
  for (const [csr, keys] of [
    [out.pool, poolKeys],
    [out.owner, ownerKeys],
  ] as const) {
    if (csr.start.length < keys + 2) throw new Error(`rank CSR start buffer ${csr.start.length} < keys ${keys} + 2`);
    csr.start.fill(0, 0, keys + 2);
  }
  const ps = out.pool.start;
  const os = out.owner.start;
  const live = cols.live;
  const pool = cols.sid[POOL_COL];
  const owner = cols.sid[OWNER_COL];
  const classOf = ckeys.classOf;
  const classified = ckeys.size;
  const { overlay, order } = sorted;
  const keyOfOwner = (sid: number) => (sid === 0 || sid - 1 >= classified ? 0 : classOf[sid - 1]);
  const scan = (visit: (slot: number, poolKey: number, ownerKey: number) => void) => {
    let p = 0;
    let nextChanged = order.length > 0 ? overlay!.slots[order[0]] : -1;
    for (let s = 0; s < slots; s++) {
      if (s === nextChanged) {
        const i = order[p++];
        nextChanged = p < order.length ? overlay!.slots[order[p]] : -1;
        if (overlay!.live[i] !== 1) continue;
        visit(s, overlay!.sid[POOL_COL][i], keyOfOwner(overlay!.sid[OWNER_COL][i]));
        continue;
      }
      if (live[s] !== 1) continue;
      visit(s, pool[s], keyOfOwner(owner[s]));
    }
  };
  scan((_, pk, ok) => {
    if (pk >= poolKeys || ok >= ownerKeys) throw new Error(`rank CSR key ${pk}/${ok} ≥ ${poolKeys}/${ownerKeys}`);
    ps[pk + 1]++;
    os[ok + 1]++;
  });
  for (let k = 0; k < poolKeys; k++) ps[k + 1] += ps[k];
  for (let k = 0; k < ownerKeys; k++) os[k + 1] += os[k];
  // Cursors (start[k] is the first index of key k).
  const pc = ps.slice(0, poolKeys + 1);
  const oc = os.slice(0, ownerKeys + 1);
  const po = out.pool.order;
  const oo = out.owner.order;
  scan((s, pk, ok) => {
    po[pc[pk]++] = s;
    oo[oc[ok]++] = s;
  });
  ps[poolKeys + 1] = ps[poolKeys];
  os[ownerKeys + 1] = os[ownerKeys];
  out.pool.keys = poolKeys;
  out.owner.keys = ownerKeys;
}

function allPools(csr: RankCsr): number[] {
  const out: number[] = [];
  for (let k = 1; k < csr.keys; k++) if (csr.start[k + 1] > csr.start[k]) out.push(k);
  return out;
}

/** Holder counts of `pools` over a pool CSR (rows as of G+1: the overlay's for a changed slot). */
function countPools(csr: RankCsr, cols: RankColumnArrays, at: Map<number, number>, overlay: RankOverlay | undefined, pools: readonly number[]): HolderCountsDelta {
  const n = pools.length;
  const out: HolderCountsDelta = { pools: Uint32Array.from(pools), positions: new Uint32Array(n), holders: new Uint32Array(n), ambiguous: new Uint8Array(n) };
  const owners = new Set<number>();
  const active = cols.bv[ACTIVE_COL];
  const owner = cols.sid[OWNER_COL];
  for (let i = 0; i < n; i++) {
    const key = pools[i];
    owners.clear();
    let positions = 0;
    let ambiguous = 0;
    if (key < csr.keys) {
      for (let j = csr.start[key], end = csr.start[key + 1]; j < end; j++) {
        const s = csr.order[j];
        const o = at.size > 0 ? at.get(s) : undefined;
        const a = o === undefined ? active[s] : overlay!.bv[ACTIVE_COL][o];
        if (a !== BV_TRUE) continue;
        positions++;
        const sid = o === undefined ? owner[s] : overlay!.sid[OWNER_COL][o];
        if (sid === 0) ambiguous = 1;
        else owners.add(sid);
      }
    }
    out.positions[i] = positions;
    out.holders[i] = owners.size;
    out.ambiguous[i] = ambiguous;
  }
  return out;
}

/**
 * Generation update: from G's structures (`prev`, over the columns as of G)
 * and the captured overlay, G+1's into `out`. The columns are NOT yet updated
 * (passes on G still read them): changed rows are read through the overlay,
 * unchanged rows through the columns — their values are the same in G and G+1.
 */
export function updateRank(task: RankUpdateTask): RankUpdateResult {
  const { cols, overlay, prev, prevLen, out } = task;
  const changed = newBitset(cols.capacity);
  const at = new Map<number, number>();
  let slots = task.slots;
  for (let i = 0; i < overlay.n; i++) {
    const s = overlay.slots[i];
    setBit(changed, s);
    at.set(s, i);
    if (s + 1 > slots) slots = s + 1;
  }
  const pv = cols.pv[PID_COL];
  const opv = overlay.pv[PID_COL];
  const permLen: number[] = [];
  RANK_PERMS.forEach((perm, p) => {
    const incoming: number[] = [];
    for (let i = 0; i < overlay.n; i++) {
      if (overlay.live[i] !== 1) continue;
      if (perm.aplus && !overlayInAplus(overlay, i)) continue;
      incoming.push(i);
    }
    let cmpOO: (i: number, j: number) => number;
    let cmpOC: (i: number, s: number) => number;
    if (perm.numPos < 0) {
      cmpOO = (i, j) => (opv[i] < opv[j] ? -1 : opv[i] > opv[j] ? 1 : 0);
      cmpOC = (i, s) => (opv[i] < pv[s] ? -1 : opv[i] > pv[s] ? 1 : 0);
    } else {
      const nc = cols.nc[perm.numPos];
      const nv = cols.nv[perm.numPos];
      const onc = overlay.nc[perm.numPos];
      const onv = overlay.nv[perm.numPos];
      const dir = perm.descending ? -1 : 1;
      cmpOO = (i, j) => compareNumCells(onc[i], onv[i], onc[j], onv[j]) * dir || (opv[i] < opv[j] ? -1 : opv[i] > opv[j] ? 1 : 0);
      cmpOC = (i, s) => compareNumCells(onc[i], onv[i], nc[s], nv[s]) * dir || (opv[i] < pv[s] ? -1 : opv[i] > pv[s] ? 1 : 0);
    }
    const target = out.perms[p];
    const source = prev.perms[p];
    let m = 0;
    for (let k = 0; k < prevLen[p]; k++) {
      const slot = source[k];
      if (!testBit(changed, slot)) target[m++] = slot;
    }
    const add = incoming.sort(cmpOO);
    const insertAt = new Int32Array(add.length);
    for (let j = 0; j < add.length; j++) {
      let lo = j > 0 ? insertAt[j - 1] : 0;
      let hi = m;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (cmpOC(add[j], target[mid]) > 0) lo = mid + 1;
        else hi = mid;
      }
      insertAt[j] = lo;
    }
    let end = m;
    for (let j = add.length - 1; j >= 0; j--) {
      const from = insertAt[j];
      if (end > from) target.copyWithin(from + j + 1, from, end);
      target[from + j] = overlay.slots[add[j]];
      end = from;
    }
    permLen.push(m + add.length);
  });

  // CSR membership and holder-count relevance per changed slot.
  let membership = false;
  const dirty = new Set<number>();
  for (let i = 0; i < overlay.n; i++) {
    const s = overlay.slots[i];
    const wasLive = s < task.slots && cols.live[s] === 1;
    const oldPool = wasLive ? cols.sid[POOL_COL][s] : 0;
    const newPool = overlay.live[i] === 1 ? overlay.sid[POOL_COL][i] : 0;
    const oldOwnerKey = wasLive ? ownerKey(task.ckeys, cols.sid[OWNER_COL][s]) : 0;
    const newOwnerKey = overlay.live[i] === 1 ? ownerKey(task.ckeys, overlay.sid[OWNER_COL][i]) : 0;
    if (wasLive !== (overlay.live[i] === 1) || oldPool !== newPool || oldOwnerKey !== newOwnerKey) membership = true;
    const oldActive = wasLive ? cols.bv[ACTIVE_COL][s] : 0;
    const newActive = overlay.live[i] === 1 ? overlay.bv[ACTIVE_COL][i] : 0;
    const oldOwner = wasLive ? cols.sid[OWNER_COL][s] : 0;
    const newOwner = overlay.live[i] === 1 ? overlay.sid[OWNER_COL][i] : 0;
    if (oldPool !== newPool || oldActive !== newActive || oldOwner !== newOwner || wasLive !== (overlay.live[i] === 1)) {
      if (wasLive && oldPool !== 0) dirty.add(oldPool);
      if (overlay.live[i] === 1 && newPool !== 0) dirty.add(newPool);
    }
  }
  if (membership) buildCsrs(cols, sortOverlay(overlay), task.ckeys, slots, task.poolKeys, task.ownerKeys, out);
  const pools = membership ? out.pool : prev.pool;
  const holders = countPools(pools, cols, at, overlay, [...dirty].sort((a, b) => a - b));
  return { permLen, csrRebuilt: membership, holders };
}

/** The live slots of a CSR group (copy). */
export function csrGroup(csr: RankCsr, key: number): Uint32Array {
  if (key <= 0 || key >= csr.keys) return new Uint32Array(0);
  return csr.order.slice(csr.start[key], csr.start[key + 1]);
}

/** The slot holding positionId `pid` (binary search of the pid permutation), or -1. */
export function slotOfPid(cols: RankColumnArrays, pidPerm: Uint32Array, len: number, pid: number): number {
  const pv = cols.pv[PID_COL];
  const pc = cols.pc[PID_COL];
  let lo = 0;
  let hi = len;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (pv[pidPerm[mid]] < pid) lo = mid + 1;
    else hi = mid;
  }
  if (lo < len && pv[pidPerm[lo]] === pid && pc[pidPerm[lo]] === PC_PID) return pidPerm[lo];
  return -1;
}
