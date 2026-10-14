/**
 * The off-heap `_id` → slot table (design §4.4 `oid-map.ts`).
 *
 * Rows are keyed by their 12-byte ObjectId, held in the shard table's `oid`
 * column (`slot × 12`). This is an open-addressing `Int32Array` of `slot + 1`
 * (0 = empty), probed linearly and compared against the column, ~8–16 B per
 * row and nothing on the JS heap (a `Map` keyed by 24-char hex strings is
 * ~450 MB at 6 M rows, F15).
 *
 * There is no removal: a deleted row keeps its slot (tombstoned by the
 * table's live bit) and its entry here, so a delete-then-reinsert of the same
 * `_id` reuses the slot. Slots are compacted only by a snapshot load.
 */

import { LOAD_SLICE_ROWS, runSteps } from './yield-steps.js';

export const OID_BYTES = 12;

const HEX = '0123456789abcdef';

/** 24-hex → 12 bytes (into `out` at `offset`). False when `hex` is not an ObjectId hex string. */
export function oidToBytes(hex: string, out: Uint8Array, offset = 0): boolean {
  if (hex.length !== 24) return false;
  for (let i = 0; i < OID_BYTES; i++) {
    const hi = hexValue(hex.charCodeAt(i * 2));
    const lo = hexValue(hex.charCodeAt(i * 2 + 1));
    if (hi < 0 || lo < 0) return false;
    out[offset + i] = (hi << 4) | lo;
  }
  return true;
}

/** 12 bytes at `offset` → 24-hex. */
export function oidToHex(bytes: Uint8Array, offset = 0): string {
  let out = '';
  for (let i = 0; i < OID_BYTES; i++) {
    const b = bytes[offset + i];
    out += HEX[b >>> 4] + HEX[b & 15];
  }
  return out;
}

function hexValue(code: number): number {
  if (code >= 48 && code <= 57) return code - 48;
  if (code >= 97 && code <= 102) return code - 87;
  if (code >= 65 && code <= 70) return code - 55;
  return -1;
}

function readU32(bytes: Uint8Array, at: number): number {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

/** Hash of the 12 bytes at `at`: ObjectId = 4 B time + 5 B random + 3 B counter, mixed and finalised. */
export function oidHash(bytes: Uint8Array, at: number): number {
  let h = readU32(bytes, at + 8) ^ Math.imul(readU32(bytes, at + 4), 0x9e3779b1) ^ Math.imul(readU32(bytes, at), 0x85ebca77);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export class OidMap {
  private table: Int32Array;
  private count = 0;

  constructor(capacity: number) {
    this.table = new Int32Array(tableSizeFor(capacity));
  }

  get size(): number {
    return this.count;
  }

  get memoryBytes(): number {
    return this.table.byteLength;
  }

  /** The slot whose `oids` bytes equal `key[keyAt .. keyAt+12)`, or -1. */
  find(oids: Uint8Array, key: Uint8Array, keyAt = 0): number {
    const mask = this.table.length - 1;
    let at = oidHash(key, keyAt) & mask;
    for (;;) {
      const entry = this.table[at];
      if (entry === 0) return -1;
      const slot = entry - 1;
      if (sameOid(oids, slot * OID_BYTES, key, keyAt)) return slot;
      at = (at + 1) & mask;
    }
  }

  /** Index `slot` (its oid already written into `oids`). The oid must not be present. */
  add(oids: Uint8Array, slot: number): void {
    if ((this.count + 1) * 2 > this.table.length) this.rehash(oids, this.table.length * 2);
    this.place(oids, slot);
    this.count++;
  }

  /** Rebuild for slots `0 .. slots-1` (after a load or a capacity change). */
  rebuild(oids: Uint8Array, slots: number, capacity: number): void {
    runSteps(this.rebuildSteps(oids, slots, capacity));
  }

  /**
   * `rebuild` in slices of `slice` slots (a generator: `runStepsAsync` yields
   * to the event loop between slices). The map answers nothing useful until
   * it completes — only for a table nothing reads yet (a load).
   */
  *rebuildSteps(oids: Uint8Array, slots: number, capacity: number, slice = LOAD_SLICE_ROWS): Generator<void, void, void> {
    this.table = new Int32Array(tableSizeFor(Math.max(capacity, slots)));
    this.count = 0;
    for (let slot = 0; slot < slots; slot++) {
      this.place(oids, slot);
      this.count++;
      if ((slot + 1) % slice === 0 && slot + 1 < slots) yield;
    }
  }

  private place(oids: Uint8Array, slot: number): void {
    const mask = this.table.length - 1;
    let at = oidHash(oids, slot * OID_BYTES) & mask;
    while (this.table[at] !== 0) at = (at + 1) & mask;
    this.table[at] = slot + 1;
  }

  private rehash(oids: Uint8Array, size: number): void {
    const old = this.table;
    this.table = new Int32Array(size);
    for (let i = 0; i < old.length; i++) if (old[i] !== 0) this.place(oids, old[i] - 1);
  }
}

function sameOid(a: Uint8Array, at: number, b: Uint8Array, bt: number): boolean {
  for (let i = 0; i < OID_BYTES; i++) if (a[at + i] !== b[bt + i]) return false;
  return true;
}

function tableSizeFor(capacity: number): number {
  let size = 64;
  while (size < capacity * 2) size *= 2;
  return size;
}
