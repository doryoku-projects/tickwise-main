/**
 * An off-heap string dictionary (design §4.4): one per (model, shard), the id
 * space of every string leaf of that shard's rows (token addresses and
 * symbols, owners, pool ids, protocol, pricing source).
 *
 * Memory is three growable typed arrays — the UTF-8 bytes of every entry, a
 * `Uint32Array` of offsets (entry `id` is `bytes[offsets[id] .. offsets[id+1])`)
 * and an open-addressing `Int32Array` hash of `id + 1` — not a JS `Map`: at
 * full Robinhood (1.5 M owners + 1.1 M pool ids) a `Map<string, …>` is
 * ~460 MB of GC-managed heap (F15); this is ~80 B per entry and invisible to
 * the GC.
 *
 * Ids are dense and assigned in insertion order, which makes them part of the
 * delta protocol: a dictionary-add record carries its explicit id and every
 * replica must assign the same one (`addAt`). Entries are immutable; there is
 * no removal (a reset shard keeps its dictionary, so ids in flight stay valid).
 *
 * Strings from MongoDB are valid UTF-8, so the UTF-8 bytes identify a string
 * exactly. Single writer (the main thread).
 *
 * The bytes and offsets live on SharedArrayBuffers (R2): the engines' worker
 * threads read entries by id with no copy (`sharedView`). That is safe
 * because entries are immutable and appended past `used` — a reader that only
 * looks at ids below the size it was handed never sees a write — and a
 * growth allocates NEW buffers, leaving the old ones intact for whoever still
 * holds them.
 */

import { sharedBuffer } from './shared-memory.js';
import { LOAD_SLICE_ROWS, runSteps, runStepsAsync } from './yield-steps.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnv1a(bytes: Uint8Array, start: number, end: number): number {
  let h = FNV_OFFSET;
  for (let i = start; i < end; i++) {
    h ^= bytes[i];
    h = Math.imul(h, FNV_PRIME);
  }
  // fmix32: spreads FNV's low-bit clustering over the table's mask
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export class Dictionary {
  private bytes: Uint8Array;
  private used = 0;
  private offsets: Uint32Array;
  private table: Int32Array;
  private count = 0;
  private scratch = new Uint8Array(256);
  /** Per id: 0 unknown, 1 printable ASCII (0x20–0x7E) only, 2 not. Computed on demand. */
  private printable: Uint8Array;

  constructor(initialEntries = 1024, initialBytes = 64 * 1024) {
    const entries = Math.max(16, initialEntries);
    this.bytes = new Uint8Array(sharedBuffer(Math.max(1024, initialBytes)));
    this.offsets = new Uint32Array(sharedBuffer((entries + 1) * 4));
    this.printable = new Uint8Array(entries);
    this.table = new Int32Array(tableSizeFor(entries));
  }

  /** Number of entries (= the next id). */
  get size(): number {
    return this.count;
  }

  /** Bytes held by this dictionary's arrays (for the status block). */
  get memoryBytes(): number {
    return this.bytes.byteLength + this.offsets.byteLength + this.table.byteLength + this.printable.byteLength;
  }

  /** The id of `value`, or -1. */
  find(value: string): number {
    const len = this.encode(value);
    return this.lookup(this.scratch, 0, len);
  }

  /** The id of the entry whose UTF-8 bytes are `src[start, start + len)`, adding it when absent (no string round trip). */
  internBytes(src: Uint8Array, start: number, len: number): number {
    const found = this.lookup(src, start, len);
    return found >= 0 ? found : this.insert(src, start, len);
  }

  /** The id of `value`, adding it when absent. */
  intern(value: string): number {
    const len = this.encode(value);
    const found = this.lookup(this.scratch, 0, len);
    return found >= 0 ? found : this.insert(this.scratch, 0, len);
  }

  /**
   * Add `value` as entry `id` — a replica applying a dictionary-add record.
   * The id must be the next one and the value new: anything else means this
   * replica's dictionary diverged from the holder's (the caller reloads).
   */
  addAt(id: number, value: string): void {
    if (id !== this.count) throw new DictionaryMismatchError(`dictionary add id ${id}, expected ${this.count}`);
    const len = this.encode(value);
    if (this.lookup(this.scratch, 0, len) >= 0) {
      throw new DictionaryMismatchError(`dictionary add id ${id}: value already present`);
    }
    this.insert(this.scratch, 0, len);
  }

  /** The string of entry `id`. */
  get(id: number): string {
    if (id < 0 || id >= this.count) throw new RangeError(`dictionary id ${id} out of range (size ${this.count})`);
    return decoder.decode(this.bytes.subarray(this.offsets[id], this.offsets[id + 1]));
  }

  /** True when entry `id` is printable ASCII only (the collation-key domain, design §4.4 / F12). */
  isPrintableAscii(id: number): boolean {
    let flag = this.printable[id];
    if (flag === 0) {
      flag = 1;
      for (let i = this.offsets[id]; i < this.offsets[id + 1]; i++) {
        const b = this.bytes[i];
        if (b < 0x20 || b > 0x7e) {
          flag = 2;
          break;
        }
      }
      this.printable[id] = flag;
    }
    return flag === 1;
  }

  /**
   * The current backing arrays (shared memory) and the entry count: what a
   * worker needs to read entries `0 .. size − 1` (`DictView`). Valid for those
   * ids for as long as the caller holds them, whatever the dictionary does next.
   */
  sharedView(): { bytes: Uint8Array; offsets: Uint32Array; size: number } {
    return { bytes: this.bytes, offsets: this.offsets, size: this.count };
  }

  /** The snapshot form: `offsets` (size + 1 entries) and the used bytes. Views, not copies. */
  exportColumns(): { offsets: Uint32Array; bytes: Uint8Array } {
    return { offsets: this.offsets.subarray(0, this.count + 1), bytes: this.bytes.subarray(0, this.used) };
  }

  /** Rebuild from the snapshot form (ids preserved). */
  static fromColumns(offsets: Uint32Array, bytes: Uint8Array, headroom = 1.25): Dictionary {
    return runSteps(Dictionary.fromColumnsSteps(offsets, bytes, headroom));
  }

  /**
   * `fromColumns` with an event-loop turn every `slice` entries — for a load
   * on a replica already serving (the hash of a 1.7M-entry dictionary is
   * ~150 ms in one block otherwise).
   */
  static fromColumnsAsync(offsets: Uint32Array, bytes: Uint8Array, headroom = 1.25, slice = LOAD_SLICE_ROWS): Promise<Dictionary> {
    return runStepsAsync(Dictionary.fromColumnsSteps(offsets, bytes, headroom, slice));
  }

  private static *fromColumnsSteps(offsets: Uint32Array, bytes: Uint8Array, headroom: number, slice = LOAD_SLICE_ROWS): Generator<void, Dictionary, void> {
    const count = Math.max(0, offsets.length - 1);
    const dict = new Dictionary(Math.ceil(count * headroom) + 16, Math.ceil(bytes.length * headroom) + 1024);
    dict.bytes.set(bytes);
    dict.used = bytes.length;
    dict.offsets.set(offsets);
    dict.count = count;
    for (let id = 0; id < count; id++) {
      const start = offsets[id];
      const end = offsets[id + 1];
      if (end < start || end > bytes.length) throw new DictionaryMismatchError(`dictionary column corrupt at id ${id}`);
      dict.place(fnv1a(dict.bytes, start, end), id);
      if ((id + 1) % slice === 0 && id + 1 < count) yield;
    }
    return dict;
  }

  private encode(value: string): number {
    // UTF-8 is at most 3 bytes per UTF-16 unit.
    const need = value.length * 3;
    if (need > this.scratch.length) this.scratch = new Uint8Array(Math.max(need, this.scratch.length * 2));
    return encoder.encodeInto(value, this.scratch).written ?? 0;
  }

  private lookup(src: Uint8Array, start: number, len: number): number {
    const mask = this.table.length - 1;
    let at = fnv1a(src, start, start + len) & mask;
    for (;;) {
      const entry = this.table[at];
      if (entry === 0) return -1;
      const id = entry - 1;
      const from = this.offsets[id];
      if (this.offsets[id + 1] - from === len && this.sameBytes(src, start, from, len)) return id;
      at = (at + 1) & mask;
    }
  }

  private sameBytes(src: Uint8Array, start: number, from: number, len: number): boolean {
    for (let i = 0; i < len; i++) if (this.bytes[from + i] !== src[start + i]) return false;
    return true;
  }

  private insert(src: Uint8Array, start: number, len: number): number {
    const id = this.count;
    if (id + 2 > this.offsets.length) this.growEntries();
    if (this.used + len > this.bytes.length) this.growBytes(this.used + len);
    this.bytes.set(src.subarray(start, start + len), this.used);
    this.offsets[id] = this.used;
    this.used += len;
    this.offsets[id + 1] = this.used;
    this.count = id + 1;
    if (this.count * 2 > this.table.length) this.rehash(this.table.length * 2);
    else this.place(fnv1a(this.bytes, this.offsets[id], this.used), id);
    return id;
  }

  private place(hash: number, id: number): void {
    const mask = this.table.length - 1;
    let at = hash & mask;
    while (this.table[at] !== 0) at = (at + 1) & mask;
    this.table[at] = id + 1;
  }

  private rehash(size: number): void {
    this.table = new Int32Array(size);
    for (let id = 0; id < this.count; id++) this.place(fnv1a(this.bytes, this.offsets[id], this.offsets[id + 1]), id);
  }

  private growEntries(): void {
    const next = new Uint32Array(sharedBuffer(this.offsets.length * 2 * 4));
    next.set(this.offsets);
    this.offsets = next;
    const printable = new Uint8Array(next.length);
    printable.set(this.printable);
    this.printable = printable;
  }

  private growBytes(min: number): void {
    const next = new Uint8Array(sharedBuffer(Math.max(min, this.bytes.length * 2)));
    next.set(this.bytes.subarray(0, this.used));
    this.bytes = next;
  }
}

function tableSizeFor(entries: number): number {
  let size = 64;
  while (size < entries * 2) size *= 2;
  return size;
}

/** A replica's dictionary disagrees with the holder's: the caller must reload from a snapshot. */
export class DictionaryMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DictionaryMismatchError';
  }
}
