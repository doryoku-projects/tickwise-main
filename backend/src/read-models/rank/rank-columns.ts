import { NC_NAN, NC_NULL, NC_NUM, NC_ODD, numClassOf } from '../core/bson-order.js';
import { CLS } from '../core/cells.js';
import type { CkeyView } from '../core/ckey.js';
import { leafIndex } from '../core/fields.js';
import type { ShardTable } from '../core/row-store.js';
import { bufferBytes, sharedF64, sharedU32, sharedU8 } from '../core/shared-memory.js';
import type { DictView } from '../pools/pool-columns.js';

/**
 * The rank engine's FROZEN copy of one positions shard (Phase P-R R3, design
 * §6.1): the leaves the leaderboard filters and sorts on, as SharedArrayBuffer
 * columns the pass workers read with no copy, at ONE generation of the engine.
 *
 * Exactly the pool catalog's scheme (`pools/pool-columns.ts`): R1's
 * `ShardTable` changes with every applied delta entry, so the engine keeps its
 * own copy, advanced a generation at a time — changed slots CAPTURED at a
 * freeze (`captureOverlay`), the next permutations / CSRs / holder counts
 * built from (columns + overlay) while passes keep reading generation G, the
 * overlay APPLIED in place only at the swap. Slots are the table's slots; a
 * reset / replaced / outgrown table is a new INSTANCE (full rebuild).
 *
 * Per slot (~98 B; ~107 B with the `fee` leaf):
 *  - `live`;
 *  - 7 numeric leaves (value, pnl, aprExGas, feeApr, roi, createdAt, poolTvl),
 *    plus `fee` while `HONEYPOT_FEE_FILTER=on`:
 *    numeric class (null / NaN / number / odd, `bson-order.ts`) + f64;
 *  - 2 id leaves (positionId, tokenId): class (0 null-or-missing, 1 canonical
 *    u32, 3 odd) + u32;
 *  - 5 string leaves (owner, poolId, token0, token1, pricing.source):
 *    shard-dictionary id + 1 (0 = null / missing; odd values are 0 too and
 *    quarantined by R1);
 *  - 4 boolean leaves (isActive, inRange, performanceReady, usedFallback):
 *    0 null-or-missing / 1 true / 2 false / 3 odd.
 * chainId and protocol are not copied: R1 quarantines any row whose value is
 * not the shard's own, so on a servable shard they are constant.
 */

const L = (path: string) => leafIndex('rank', path);

export const RANK_LEAF = {
  chainId: L('chainId'),
  protocol: L('protocol'),
  positionId: L('positionId'),
  tokenId: L('tokenId'),
  owner: L('owner'),
  poolId: L('poolId'),
  isActive: L('isActive'),
  createdAt: L('createdAtTimestamp'),
  token0: L('token0.address'),
  token1: L('token1.address'),
  value: L('metrics.underlyingValueUsd'),
  pnl: L('metrics.poolPnlUsd'),
  aprExGas: L('metrics.aprExGas'),
  feeApr: L('metrics.feeApr'),
  roi: L('metrics.roi'),
  inRange: L('metrics.inRange'),
  perfReady: L('metrics.performanceReady'),
  poolTvl: L('poolStats.tvlUsd'),
  source: L('pricing.source'),
  usedFallback: L('pricing.usedFallback'),
  fee: L('fee'),
} as const;

/** Numeric leaves held as columns, in column order. */
// `fee` APPENDED (filter-only, no permutation) only when the model carries it
// (`HONEYPOT_FEE_FILTER=on`, `rankFeeLeafEnabled`; -1 otherwise): column
// positions are indexes into this list, so the 7 earlier columns never move.
export const RANK_NUM_LEAVES: readonly number[] = [
  RANK_LEAF.value,
  RANK_LEAF.pnl,
  RANK_LEAF.aprExGas,
  RANK_LEAF.feeApr,
  RANK_LEAF.roi,
  RANK_LEAF.createdAt,
  RANK_LEAF.poolTvl,
  ...(RANK_LEAF.fee >= 0 ? [RANK_LEAF.fee] : []),
];
/** Id (pid) leaves held as columns. */
export const RANK_PID_LEAVES: readonly number[] = [RANK_LEAF.positionId, RANK_LEAF.tokenId];
/** String leaves held as columns (dictionary ids). */
export const RANK_STR_LEAVES: readonly number[] = [RANK_LEAF.owner, RANK_LEAF.poolId, RANK_LEAF.token0, RANK_LEAF.token1, RANK_LEAF.source];
/** Boolean leaves held as columns. */
export const RANK_BOOL_LEAVES: readonly number[] = [RANK_LEAF.isActive, RANK_LEAF.inRange, RANK_LEAF.perfReady, RANK_LEAF.usedFallback];

export const VALUE_COL = RANK_NUM_LEAVES.indexOf(RANK_LEAF.value);
export const PID_COL = RANK_PID_LEAVES.indexOf(RANK_LEAF.positionId);
export const OWNER_COL = RANK_STR_LEAVES.indexOf(RANK_LEAF.owner);
export const POOL_COL = RANK_STR_LEAVES.indexOf(RANK_LEAF.poolId);
export const ACTIVE_COL = RANK_BOOL_LEAVES.indexOf(RANK_LEAF.isActive);

/** Pid class codes. */
export const PC_NULL = 0;
export const PC_PID = 1;
export const PC_ODD = 3;
/** Bool codes. */
export const BV_NULL = 0;
export const BV_TRUE = 1;
export const BV_FALSE = 2;
export const BV_ODD = 3;

/** Column position of a leaf, or undefined for an identity leaf (chainId / protocol). */
export function rankColumnOf(leaf: number): { kind: 'num' | 'pid' | 'str' | 'bool'; pos: number } | undefined {
  let pos = RANK_NUM_LEAVES.indexOf(leaf);
  if (pos >= 0) return { kind: 'num', pos };
  pos = RANK_PID_LEAVES.indexOf(leaf);
  if (pos >= 0) return { kind: 'pid', pos };
  pos = RANK_STR_LEAVES.indexOf(leaf);
  if (pos >= 0) return { kind: 'str', pos };
  pos = RANK_BOOL_LEAVES.indexOf(leaf);
  if (pos >= 0) return { kind: 'bool', pos };
  return undefined;
}

/**
 * The engine's permutations (design §6.2, 8 sorts → 7): per numeric sort its
 * leaf DESCENDING then `positionId` ascending (canonical u32 = the collation's
 * numeric order); the rate sorts over A+ only (`isActive: true` and a numeric
 * value > 0 — every rate-sort filter carries both, the compiler checks); and
 * the pid permutation (nft_id_asc forwards; nft_id_desc = `{tokenId: -1,
 * positionId: -1}` = the same list read BACKWARDS, since tokenId ===
 * positionId on every servable row). Must cover `leaderboardSortSpec` for
 * every sort (`rank-parity.spec` pins it).
 */
export interface RankPermSpec {
  name: string;
  /** Numeric column, or -1 for the pid permutation. */
  numPos: number;
  leaf: number;
  descending: boolean;
  /** Only A+ rows (isActive true, value a number > 0). */
  aplus: boolean;
}

export const RANK_PERMS: readonly RankPermSpec[] = [
  { name: 'apr', numPos: RANK_NUM_LEAVES.indexOf(RANK_LEAF.aprExGas), leaf: RANK_LEAF.aprExGas, descending: true, aplus: true },
  { name: 'fee_apr', numPos: RANK_NUM_LEAVES.indexOf(RANK_LEAF.feeApr), leaf: RANK_LEAF.feeApr, descending: true, aplus: true },
  { name: 'roi', numPos: RANK_NUM_LEAVES.indexOf(RANK_LEAF.roi), leaf: RANK_LEAF.roi, descending: true, aplus: true },
  { name: 'age', numPos: RANK_NUM_LEAVES.indexOf(RANK_LEAF.createdAt), leaf: RANK_LEAF.createdAt, descending: true, aplus: false },
  { name: 'pnl', numPos: RANK_NUM_LEAVES.indexOf(RANK_LEAF.pnl), leaf: RANK_LEAF.pnl, descending: true, aplus: false },
  { name: 'value', numPos: VALUE_COL, leaf: RANK_LEAF.value, descending: true, aplus: false },
  { name: 'pid', numPos: -1, leaf: RANK_LEAF.tokenId, descending: false, aplus: false },
];
export const PID_PERM = RANK_PERMS.length - 1;

/**
 * How a leaderboard sort `(field, direction, tieDirection)` is read: the
 * permutation and whether it is walked backwards; undefined = not served.
 */
export function rankPermFor(field: string, direction: 1 | -1, tieDirection: 1 | -1): { perm: number; reverse: boolean } | undefined {
  if (field === 'tokenId') {
    if (direction === 1 && tieDirection === 1) return { perm: PID_PERM, reverse: false };
    if (direction === -1 && tieDirection === -1) return { perm: PID_PERM, reverse: true };
    return undefined;
  }
  if (direction !== -1 || tieDirection !== 1) return undefined;
  const leaf = leafIndex('rank', field);
  const perm = RANK_PERMS.findIndex((p) => p.numPos >= 0 && p.leaf === leaf);
  return perm < 0 ? undefined : { perm, reverse: false };
}

/** The SharedArrayBuffer columns of one shard (structured-clone shares them). */
export interface RankColumnArrays {
  capacity: number;
  live: Uint8Array;
  nc: Uint8Array[];
  nv: Float64Array[];
  pc: Uint8Array[];
  pv: Uint32Array[];
  sid: Uint32Array[];
  bv: Uint8Array[];
}

/**
 * Changed slots captured at a freeze: their full engine row state (plain
 * arrays: transferred to the worker that builds the next generation, then
 * applied by the main thread at the swap).
 */
export interface RankOverlay {
  n: number;
  slots: Uint32Array;
  live: Uint8Array;
  nc: Uint8Array[];
  nv: Float64Array[];
  pc: Uint8Array[];
  pv: Uint32Array[];
  sid: Uint32Array[];
  bv: Uint8Array[];
}

function boolCode(cls: number): number {
  return cls === CLS.NULL ? BV_NULL : cls === CLS.TRUE ? BV_TRUE : cls === CLS.FALSE ? BV_FALSE : BV_ODD;
}

function pidCode(cls: number): number {
  return cls === CLS.NULL ? PC_NULL : cls === CLS.PID ? PC_PID : PC_ODD;
}

/** Per-leaf live rows the engine itself cannot reproduce MongoDB for (on top of R1's quarantine). */
export interface RankQuarantine {
  /** positionId not a canonical id (null / missing): the row cannot be ordered nor fetched by id. */
  pid: number;
  /** A collated string leaf holding a value outside the ckey domain (long digit runs; R1 counts the non-printable). */
  str: number[];
}

/**
 * The engine columns of one shard instance, owned by the main thread.
 */
export class RankColumns {
  readonly arrays: RankColumnArrays;
  live = 0;
  slots = 0;
  readonly quarantine: RankQuarantine = { pid: 0, str: RANK_STR_LEAVES.map(() => 0) };

  constructor(readonly capacity: number) {
    const cap = Math.max(16, capacity);
    this.arrays = {
      capacity: cap,
      live: sharedU8(cap),
      nc: RANK_NUM_LEAVES.map(() => sharedU8(cap)),
      nv: RANK_NUM_LEAVES.map(() => sharedF64(cap)),
      pc: RANK_PID_LEAVES.map(() => sharedU8(cap)),
      pv: RANK_PID_LEAVES.map(() => sharedU32(cap)),
      sid: RANK_STR_LEAVES.map(() => sharedU32(cap)),
      bv: RANK_BOOL_LEAVES.map(() => sharedU8(cap)),
    };
  }

  get memoryBytes(): number {
    const a = this.arrays;
    return bufferBytes([a.live, ...a.nc, ...a.nv, ...a.pc, ...a.pv, ...a.sid, ...a.bv]);
  }

  /**
   * Copy every slot of `table` (live or not) — a full build. Column by column
   * in tight loops (it runs on the main thread inside the synchronous freeze:
   * 4.25M rows in ~100 ms rather than ~500 ms row by row).
   */
  copyFrom(table: ShardTable, outside: (id: number) => boolean): void {
    if (table.slots > this.arrays.capacity) throw new Error(`rank capacity ${this.arrays.capacity} < table slots ${table.slots}`);
    const a = this.arrays;
    const n = table.slots;
    a.live.set(table.alive.subarray(0, n));
    for (let c = 0; c < RANK_NUM_LEAVES.length; c++) {
      const leaf = RANK_NUM_LEAVES[c];
      const cls = table.cls[leaf];
      const val = table.num[leaf]!;
      const nc = a.nc[c];
      const nv = a.nv[c];
      for (let s = 0; s < n; s++) {
        const k = cls[s];
        if (k === CLS.NUM) {
          const v = val[s];
          nc[s] = v !== v ? NC_NAN : NC_NUM;
          nv[s] = v;
        } else {
          nc[s] = k === CLS.NULL ? NC_NULL : NC_ODD;
          nv[s] = 0;
        }
      }
    }
    for (let c = 0; c < RANK_PID_LEAVES.length; c++) {
      const leaf = RANK_PID_LEAVES[c];
      const cls = table.cls[leaf];
      const ids = table.ids[leaf]!;
      const pc = a.pc[c];
      const pv = a.pv[c];
      for (let s = 0; s < n; s++) {
        const k = cls[s];
        pc[s] = k === CLS.NULL ? PC_NULL : k === CLS.PID ? PC_PID : PC_ODD;
        pv[s] = k === CLS.PID ? ids[s] : 0;
      }
    }
    for (let c = 0; c < RANK_STR_LEAVES.length; c++) {
      const leaf = RANK_STR_LEAVES[c];
      const cls = table.cls[leaf];
      const ids = table.ids[leaf]!;
      const sid = a.sid[c];
      for (let s = 0; s < n; s++) sid[s] = cls[s] === CLS.STR ? ids[s] + 1 : 0;
    }
    for (let c = 0; c < RANK_BOOL_LEAVES.length; c++) {
      const cls = table.cls[RANK_BOOL_LEAVES[c]];
      const bv = a.bv[c];
      for (let s = 0; s < n; s++) {
        const k = cls[s];
        bv[s] = k === CLS.NULL ? BV_NULL : k === CLS.TRUE ? BV_TRUE : k === CLS.FALSE ? BV_FALSE : BV_ODD;
      }
    }
    this.slots = n;
    for (let s = 0; s < n; s++) if (a.live[s] === 1) this.count(s, 1, outside);
  }

  /** Capture the current state of `slots` from `table` (a freeze). */
  captureOverlay(table: ShardTable, slots: readonly number[]): RankOverlay {
    const n = slots.length;
    const overlay: RankOverlay = {
      n,
      slots: Uint32Array.from(slots),
      live: new Uint8Array(n),
      nc: RANK_NUM_LEAVES.map(() => new Uint8Array(n)),
      nv: RANK_NUM_LEAVES.map(() => new Float64Array(n)),
      pc: RANK_PID_LEAVES.map(() => new Uint8Array(n)),
      pv: RANK_PID_LEAVES.map(() => new Uint32Array(n)),
      sid: RANK_STR_LEAVES.map(() => new Uint32Array(n)),
      bv: RANK_BOOL_LEAVES.map(() => new Uint8Array(n)),
    };
    for (let i = 0; i < n; i++) {
      const slot = slots[i];
      overlay.live[i] = table.alive[slot];
      this.writeRow(table, slot, overlay.nc, overlay.nv, overlay.pc, overlay.pv, overlay.sid, overlay.bv, i);
    }
    return overlay;
  }

  private writeRow(
    table: ShardTable,
    slot: number,
    nc: Uint8Array[],
    nv: Float64Array[],
    pc: Uint8Array[],
    pv: Uint32Array[],
    sid: Uint32Array[],
    bv: Uint8Array[],
    at: number,
  ): void {
    for (let c = 0; c < RANK_NUM_LEAVES.length; c++) {
      const leaf = RANK_NUM_LEAVES[c];
      const cls = table.cls[leaf][slot];
      const value = table.num[leaf]![slot];
      nc[c][at] = numClassOf(cls, value);
      nv[c][at] = cls === CLS.NUM ? value : 0;
    }
    for (let c = 0; c < RANK_PID_LEAVES.length; c++) {
      const leaf = RANK_PID_LEAVES[c];
      const cls = table.cls[leaf][slot];
      pc[c][at] = pidCode(cls);
      pv[c][at] = cls === CLS.PID ? table.ids[leaf]![slot] : 0;
    }
    for (let c = 0; c < RANK_STR_LEAVES.length; c++) {
      const leaf = RANK_STR_LEAVES[c];
      sid[c][at] = table.cls[leaf][slot] === CLS.STR ? table.ids[leaf]![slot] + 1 : 0;
    }
    for (let c = 0; c < RANK_BOOL_LEAVES.length; c++) bv[c][at] = boolCode(table.cls[RANK_BOOL_LEAVES[c]][slot]);
  }

  /** Apply a captured overlay in place (the swap: no pass is reading). */
  applyOverlay(overlay: RankOverlay, outside: (id: number) => boolean): void {
    const a = this.arrays;
    for (let i = 0; i < overlay.n; i++) {
      const slot = overlay.slots[i];
      if (slot >= a.capacity) throw new Error(`overlay slot ${slot} past capacity ${a.capacity}`);
      if (slot < this.slots && a.live[slot] === 1) this.count(slot, -1, outside);
      a.live[slot] = overlay.live[i];
      for (let c = 0; c < RANK_NUM_LEAVES.length; c++) {
        a.nc[c][slot] = overlay.nc[c][i];
        a.nv[c][slot] = overlay.nv[c][i];
      }
      for (let c = 0; c < RANK_PID_LEAVES.length; c++) {
        a.pc[c][slot] = overlay.pc[c][i];
        a.pv[c][slot] = overlay.pv[c][i];
      }
      for (let c = 0; c < RANK_STR_LEAVES.length; c++) a.sid[c][slot] = overlay.sid[c][i];
      for (let c = 0; c < RANK_BOOL_LEAVES.length; c++) a.bv[c][slot] = overlay.bv[c][i];
      if (overlay.live[i] === 1) this.count(slot, 1, outside);
      if (slot >= this.slots) this.slots = slot + 1;
    }
  }

  private count(slot: number, delta: 1 | -1, outside: (id: number) => boolean): void {
    const a = this.arrays;
    this.live += delta;
    if (a.pc[PID_COL][slot] !== PC_PID) this.quarantine.pid += delta;
    for (let c = 0; c < RANK_STR_LEAVES.length; c++) {
      const sid = a.sid[c][slot];
      if (sid !== 0 && outside(sid - 1)) this.quarantine.str[c] += delta;
    }
  }
}

/** The dictionary + collation classes of a shard at one generation, as a worker reads them. */
export interface RankDictRef {
  dict: DictView;
  ckeys: CkeyView;
}
