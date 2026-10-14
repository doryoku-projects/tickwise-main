import { numClassOf } from '../core/bson-order.js';
import { CLS } from '../core/cells.js';
import { leafIndex } from '../core/fields.js';
import type { ShardTable } from '../core/row-store.js';
import { bufferBytes, sharedF64, sharedU32, sharedU8 } from '../core/shared-memory.js';

/**
 * The pool catalog's FROZEN copy of one pools shard (design §5.1): the leaves
 * the pools list reads, as SharedArrayBuffer columns the pass workers read
 * with no copy, at ONE generation of the catalog.
 *
 * R1's `ShardTable` changes with every applied delta entry; the catalog's
 * permutations must agree with the values they were sorted by, and an answer
 * with the stream position (clusterTime) it describes. So the catalog keeps
 * its own copy, advanced a generation at a time: the changed slots are
 * CAPTURED from the table at a freeze (`captureOverlay`), the permutations for
 * the next generation are built from (columns + overlay) while passes keep
 * reading generation G, and the overlay is APPLIED in place only at the swap,
 * once those passes drained (`applyOverlay`). Slots are the table's slots;
 * a table reset or replacement is a full rebuild (a new catalog instance).
 *
 * Per slot (~70 B): live; for each numeric leaf a numeric class
 * (null / NaN / number / odd, `bson-order.ts`) + f64; for each string leaf the
 * shard-dictionary id + 1 (0 = null or missing; odd values are 0 too, and
 * quarantined); for `usedFallback` 0 null / 1 true / 2 false / 3 odd; and the
 * first 8 bytes of the poolId, big-endian (`pkHi`, `pkLo`), which decide the
 * poolId tie-break without touching the dictionary in all but rare ties.
 *
 * chainId and protocol are not copied: R1 quarantines any row whose value is
 * not the shard's own, so on a servable shard they are constant.
 */

const L = (path: string) => leafIndex('pools', path);

export const POOL_LEAF = {
  chainId: L('chainId'),
  protocol: L('protocol'),
  poolId: L('poolId'),
  createdAt: L('createdAtTimestamp'),
  token0: L('token0.address'),
  symbol0: L('token0.symbol'),
  token1: L('token1.address'),
  symbol1: L('token1.symbol'),
  tvl: L('metrics.tvlUsd'),
  vol24: L('metrics.volumeUsd24h'),
  fees24: L('metrics.feesUsd24h'),
  feeApr: L('metrics.feeApr'),
  source: L('pricing.source'),
  usedFallback: L('pricing.usedFallback'),
} as const;

/** Numeric leaves held as columns, in column order. */
export const NUM_LEAVES: readonly number[] = [POOL_LEAF.createdAt, POOL_LEAF.tvl, POOL_LEAF.vol24, POOL_LEAF.fees24, POOL_LEAF.feeApr];
/** String leaves held as columns (dictionary ids), in column order. */
export const STR_LEAVES: readonly number[] = [POOL_LEAF.poolId, POOL_LEAF.token0, POOL_LEAF.symbol0, POOL_LEAF.token1, POOL_LEAF.symbol1, POOL_LEAF.source];
/** Boolean leaves held as columns. */
export const BOOL_LEAVES: readonly number[] = [POOL_LEAF.usedFallback];
/** Position of the poolId column among the string columns. */
export const POOL_ID_COL = STR_LEAVES.indexOf(POOL_LEAF.poolId);

/** Column position of a leaf: `{kind, pos}`, or undefined for an identity leaf (chainId / protocol). */
export function columnOf(leaf: number): { kind: 'num' | 'str' | 'bool'; pos: number } | undefined {
  let pos = NUM_LEAVES.indexOf(leaf);
  if (pos >= 0) return { kind: 'num', pos };
  pos = STR_LEAVES.indexOf(leaf);
  if (pos >= 0) return { kind: 'str', pos };
  pos = BOOL_LEAVES.indexOf(leaf);
  if (pos >= 0) return { kind: 'bool', pos };
  return undefined;
}

/**
 * The catalog's permutations: one per pools-list sort, `(leaf, descending)`,
 * each ordered by the leaf in BSON order then `poolId` ascending (binary).
 * Must cover `POOL_SORT_FIELD_MAP` × `sortDirectionFor` in the repository
 * (`pool-catalog-parity.spec` pins it): tvl, volume, fees, fee_apr ↓, age ↑.
 */
export const POOL_PERMS: ReadonlyArray<{ leaf: number; numPos: number; descending: boolean }> = [
  { leaf: POOL_LEAF.tvl, numPos: NUM_LEAVES.indexOf(POOL_LEAF.tvl), descending: true },
  { leaf: POOL_LEAF.vol24, numPos: NUM_LEAVES.indexOf(POOL_LEAF.vol24), descending: true },
  { leaf: POOL_LEAF.fees24, numPos: NUM_LEAVES.indexOf(POOL_LEAF.fees24), descending: true },
  { leaf: POOL_LEAF.feeApr, numPos: NUM_LEAVES.indexOf(POOL_LEAF.feeApr), descending: true },
  { leaf: POOL_LEAF.createdAt, numPos: NUM_LEAVES.indexOf(POOL_LEAF.createdAt), descending: false },
];

/** The permutation for a sort `(path, direction)`, or -1. */
export function permFor(path: string, direction: 1 | -1): number {
  const leaf = leafIndex('pools', path);
  return POOL_PERMS.findIndex((perm) => perm.leaf === leaf && perm.descending === (direction < 0));
}

/** A dictionary as a worker reads it: entries `0 .. size − 1`. */
export interface DictView {
  bytes: Uint8Array;
  offsets: Uint32Array;
  size: number;
}

/** The SharedArrayBuffer columns of one shard (structured-clone shares them). */
export interface PoolColumnArrays {
  capacity: number;
  live: Uint8Array;
  nc: Uint8Array[];
  nv: Float64Array[];
  sid: Uint32Array[];
  bv: Uint8Array[];
  pkHi: Uint32Array;
  pkLo: Uint32Array;
}

/** Everything a pass or a permutation build needs of one shard at one generation. */
export interface PoolShardRef {
  shard: string;
  chainId: number;
  instance: number;
  gen: number;
  /** Slots in use (live or tombstoned); every live slot is below it. */
  slots: number;
  cols: PoolColumnArrays;
  dict: DictView;
  /** Current permutations (each `capacity` long; valid prefix `permLen[i]`). */
  perms: Uint32Array[];
  permLen: number[];
}

/**
 * Changed slots captured at a freeze: their full catalog row state (plain
 * arrays: transferred to the worker that builds the next permutations, then
 * applied by the main thread at the swap).
 */
export interface PoolOverlay {
  n: number;
  slots: Uint32Array;
  live: Uint8Array;
  nc: Uint8Array[];
  nv: Float64Array[];
  sid: Uint32Array[];
  bv: Uint8Array[];
  pkHi: Uint32Array;
  pkLo: Uint32Array;
}

function boolCode(cls: number): number {
  return cls === CLS.NULL ? 0 : cls === CLS.TRUE ? 1 : cls === CLS.FALSE ? 2 : 3;
}

/** First 8 bytes of a dictionary entry, big-endian, zero-padded: `[hi, lo]`. */
export function prefixKey(dict: DictView, id: number): [number, number] {
  const start = dict.offsets[id];
  const end = dict.offsets[id + 1];
  let hi = 0;
  let lo = 0;
  for (let i = 0; i < 8; i++) {
    const b = start + i < end ? dict.bytes[start + i] : 0;
    if (i < 4) hi = (hi << 8) | b;
    else lo = (lo << 8) | b;
  }
  return [hi >>> 0, lo >>> 0];
}

/** Does the entry hold a character outside the BMP (a 4-byte UTF-8 sequence)? */
function hasAstral(dict: DictView, id: number): boolean {
  for (let i = dict.offsets[id]; i < dict.offsets[id + 1]; i++) if (dict.bytes[i] >= 0xf0) return true;
  return false;
}

/**
 * The catalog columns of one shard instance, owned by the main thread.
 */
export class PoolColumns {
  readonly arrays: PoolColumnArrays;
  /** Live rows. */
  live = 0;
  /** Slots in use. */
  slots = 0;
  /**
   * Live rows whose poolId the catalog cannot order like MongoDB AND the
   * merge comparators in Node: null / missing (UTF-8 byte order, MongoDB's,
   * and UTF-16 code-unit order, JavaScript's `<`, differ only for characters
   * outside the BMP) — quarantines the shard's poolId on top of R1's own.
   */
  poolIdQuarantine = 0;

  constructor(readonly capacity: number) {
    const cap = Math.max(16, capacity);
    this.arrays = {
      capacity: cap,
      live: sharedU8(cap),
      nc: NUM_LEAVES.map(() => sharedU8(cap)),
      nv: NUM_LEAVES.map(() => sharedF64(cap)),
      sid: STR_LEAVES.map(() => sharedU32(cap)),
      bv: BOOL_LEAVES.map(() => sharedU8(cap)),
      pkHi: sharedU32(cap),
      pkLo: sharedU32(cap),
    };
  }

  get memoryBytes(): number {
    const a = this.arrays;
    return bufferBytes([a.live, ...a.nc, ...a.nv, ...a.sid, ...a.bv, a.pkHi, a.pkLo]);
  }

  /** Copy every slot of `table` (live or not) — a full build. */
  copyFrom(table: ShardTable): void {
    if (table.slots > this.arrays.capacity) throw new Error(`catalog capacity ${this.arrays.capacity} < table slots ${table.slots}`);
    const dict = table.dict.sharedView();
    for (let slot = 0; slot < table.slots; slot++) this.writeFromTable(table, dict, slot);
    this.slots = table.slots;
  }

  /** Capture the current state of `slots` from `table` (a freeze). */
  captureOverlay(table: ShardTable, slots: readonly number[]): PoolOverlay {
    const n = slots.length;
    const overlay: PoolOverlay = {
      n,
      slots: Uint32Array.from(slots),
      live: new Uint8Array(n),
      nc: NUM_LEAVES.map(() => new Uint8Array(n)),
      nv: NUM_LEAVES.map(() => new Float64Array(n)),
      sid: STR_LEAVES.map(() => new Uint32Array(n)),
      bv: BOOL_LEAVES.map(() => new Uint8Array(n)),
      pkHi: new Uint32Array(n),
      pkLo: new Uint32Array(n),
    };
    const dict = table.dict.sharedView();
    for (let i = 0; i < n; i++) {
      const slot = slots[i];
      overlay.live[i] = table.alive[slot];
      NUM_LEAVES.forEach((leaf, c) => {
        const cls = table.cls[leaf][slot];
        const value = table.num[leaf]![slot];
        overlay.nc[c][i] = numClassOf(cls, value);
        overlay.nv[c][i] = cls === CLS.NUM ? value : 0;
      });
      STR_LEAVES.forEach((leaf, c) => {
        overlay.sid[c][i] = table.cls[leaf][slot] === CLS.STR ? table.ids[leaf]![slot] + 1 : 0;
      });
      BOOL_LEAVES.forEach((leaf, c) => {
        overlay.bv[c][i] = boolCode(table.cls[leaf][slot]);
      });
      const pid = overlay.sid[POOL_ID_COL][i];
      if (pid > 0) [overlay.pkHi[i], overlay.pkLo[i]] = prefixKey(dict, pid - 1);
    }
    return overlay;
  }

  /**
   * Would applying `overlay` change a slot's poolId? Slots → poolId must stay
   * stable within an instance (cached answers resolve slots to poolIds later);
   * a change forces a full rebuild instead. Never happens in practice: pool
   * sync upserts BY poolId.
   */
  changesPoolId(overlay: PoolOverlay): boolean {
    const sid = this.arrays.sid[POOL_ID_COL];
    for (let i = 0; i < overlay.n; i++) {
      const slot = overlay.slots[i];
      if (slot >= this.slots) continue;
      const before = sid[slot];
      if (before !== 0 && overlay.sid[POOL_ID_COL][i] !== 0 && before !== overlay.sid[POOL_ID_COL][i]) return true;
    }
    return false;
  }

  /** Apply a captured overlay in place (the swap: no pass is reading). */
  applyOverlay(overlay: PoolOverlay, dict: DictView): void {
    const a = this.arrays;
    for (let i = 0; i < overlay.n; i++) {
      const slot = overlay.slots[i];
      if (slot >= a.capacity) throw new Error(`overlay slot ${slot} past capacity ${a.capacity}`);
      if (slot < this.slots && a.live[slot] === 1) {
        this.live--;
        if (this.badPoolId(dict, a.sid[POOL_ID_COL][slot])) this.poolIdQuarantine--;
      }
      a.live[slot] = overlay.live[i];
      for (let c = 0; c < NUM_LEAVES.length; c++) {
        a.nc[c][slot] = overlay.nc[c][i];
        a.nv[c][slot] = overlay.nv[c][i];
      }
      for (let c = 0; c < STR_LEAVES.length; c++) a.sid[c][slot] = overlay.sid[c][i];
      for (let c = 0; c < BOOL_LEAVES.length; c++) a.bv[c][slot] = overlay.bv[c][i];
      a.pkHi[slot] = overlay.pkHi[i];
      a.pkLo[slot] = overlay.pkLo[i];
      if (overlay.live[i] === 1) {
        this.live++;
        if (this.badPoolId(dict, overlay.sid[POOL_ID_COL][i])) this.poolIdQuarantine++;
      }
      if (slot >= this.slots) this.slots = slot + 1;
    }
  }

  private writeFromTable(table: ShardTable, dict: DictView, slot: number): void {
    const a = this.arrays;
    const alive = table.alive[slot];
    a.live[slot] = alive;
    NUM_LEAVES.forEach((leaf, c) => {
      const cls = table.cls[leaf][slot];
      const value = table.num[leaf]![slot];
      a.nc[c][slot] = numClassOf(cls, value);
      a.nv[c][slot] = cls === CLS.NUM ? value : 0;
    });
    STR_LEAVES.forEach((leaf, c) => {
      a.sid[c][slot] = table.cls[leaf][slot] === CLS.STR ? table.ids[leaf]![slot] + 1 : 0;
    });
    BOOL_LEAVES.forEach((leaf, c) => {
      a.bv[c][slot] = boolCode(table.cls[leaf][slot]);
    });
    const pid = a.sid[POOL_ID_COL][slot];
    if (pid > 0) [a.pkHi[slot], a.pkLo[slot]] = prefixKey(dict, pid - 1);
    else {
      a.pkHi[slot] = 0;
      a.pkLo[slot] = 0;
    }
    if (alive === 1) {
      this.live++;
      if (this.badPoolId(dict, pid)) this.poolIdQuarantine++;
    }
  }

  private badPoolId(dict: DictView, sid: number): boolean {
    return sid === 0 || hasAstral(dict, sid - 1);
  }
}
