import { Dictionary } from './dictionary.js';
import { sharedU32, sharedU8 } from './shared-memory.js';
import type { DictView } from '../pools/pool-columns.js';

/**
 * Collation keys for the leaderboard's `{locale: 'en', numericOrdering: true}`
 * collation (design §4.4, facts F1 / F12; P-R R3).
 *
 * The collated positions shapes (`ranked`, `owner`) compare STRINGS under that
 * collation: the exclusion `$nin`, the equity `$in`, `owner` / `poolId`
 * equality, `pricing.source $ne 'none'`. Within the DOMAIN — printable ASCII
 * 0x20–0x7E, and no digit run longer than 254 digits — two strings are
 * collation-equal exactly when their collation keys are equal:
 *
 *     ckey(s) = s with every maximal digit run replaced by its value without
 *               leading zeros ('0' for an all-zero run); case is kept.
 *
 * (Maximal runs keep their boundaries after stripping — the character before
 * and after a run is not a digit — and a stripped run is never empty, so equal
 * keys mean equal token sequences.)
 *
 * Pinned on the M10 rig (8.0.32, read-only `$documents` + `$group` under the
 * collation, 2026-10-03): over 10,817 printable strings — every 1- and
 * 2-character one, 3- and 4-character strings over digit / letter / case /
 * punctuation alphabets, digit runs with 0–45 leading zeros, runs of 30–300
 * digits — the collation's partition equals the ckey partition exactly
 * (10,312 classes each, none mixed, none split): `'0x00a1' == '0x0a01'`,
 * `'01' == '1'`, `'0x00A1' != '0x00a1'`, `'none' != 'NONE'`.
 *
 * OUTSIDE the domain the rule breaks, so it is never applied there:
 *  - C0 controls, DEL and ZWSP are completely IGNORABLE (`'a\x01b' == 'ab'`,
 *    F12) — and so, presumably, are many other non-ASCII code points;
 *  - ICU compares digit runs in CHUNKS of 254 digits, so
 *    `'1' + '0'×254 + '5'` (256 digits) == `'1' + '0'×253 + '5'` (255) — the
 *    stripped values differ (measured on the rig).
 * A STORED string outside the domain in a collated field quarantines it
 * (R1 counts the non-printable ones; the rank engine also counts long runs,
 * `CkeyIndex.outside`), and a LITERAL outside it makes the query UNSUPPORTED —
 * never "no match".
 */

/** The longest digit run inside the domain (ICU's numeric chunk). */
export const MAX_DIGIT_RUN = 254;

/** Is `s` inside the ckey domain (printable ASCII, digit runs ≤ 254)? */
export function inCkeyDomain(s: string): boolean {
  let run = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) return false;
    if (c >= 0x30 && c <= 0x39) {
      if (++run > MAX_DIGIT_RUN) return false;
    } else run = 0;
  }
  return true;
}

/** The collation key of `s` (meaningful only inside the domain). Allocates only when a run has leading zeros. */
export function ckey(s: string): string {
  let out = '';
  let from = 0;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c < 0x30 || c > 0x39) {
      i++;
      continue;
    }
    let j = i;
    while (j < n && s.charCodeAt(j) === 0x30) j++;
    let k = j;
    while (k < n && s.charCodeAt(k) >= 0x30 && s.charCodeAt(k) <= 0x39) k++;
    // [i, j) leading zeros, [j, k) the rest of the run; an all-zero run becomes '0'.
    const strip = j === k ? k - i - 1 : j - i;
    if (strip > 0) {
      out += s.slice(from, i) + (j === k ? '0' : s.slice(j, k));
      from = k;
    }
    i = k;
  }
  return from === 0 ? s : out + s.slice(from);
}

/**
 * The collation key of the ASCII bytes `src[start, end)` into `out` (grown
 * when short); returns its length. The byte form of `ckey` for dictionary
 * entries (inside the domain they are ASCII, one byte per character).
 */
export function ckeyBytes(src: Uint8Array, start: number, end: number, out: { buf: Uint8Array }): number {
  if (out.buf.length < end - start) out.buf = new Uint8Array(Math.max(end - start, out.buf.length * 2));
  const buf = out.buf;
  let w = 0;
  let i = start;
  while (i < end) {
    const c = src[i];
    if (c < 0x30 || c > 0x39) {
      buf[w++] = c;
      i++;
      continue;
    }
    let j = i;
    while (j < end && src[j] === 0x30) j++;
    let k = j;
    while (k < end && src[k] >= 0x30 && src[k] <= 0x39) k++;
    if (j === k) buf[w++] = 0x30;
    else for (let x = j; x < k; x++) buf[w++] = src[x];
    i = k;
  }
  return w;
}

/** Bytes form of the domain check over a dictionary entry (UTF-8: ASCII bytes are the chars). */
function entryInDomain(bytes: Uint8Array, start: number, end: number): boolean {
  let run = 0;
  for (let i = start; i < end; i++) {
    const b = bytes[i];
    if (b < 0x20 || b > 0x7e) return false;
    if (b >= 0x30 && b <= 0x39) {
      if (++run > MAX_DIGIT_RUN) return false;
    } else run = 0;
  }
  return true;
}

/**
 * Per dictionary (one per rank shard): the collation CLASS of every entry —
 * entries with equal ckeys share a class id — as a shared `Uint32Array`
 * indexed by dictionary id (`classOf[id]` = class id + 1; 0 = OUTSIDE the
 * domain, which no collated literal ever matches). Classes are interned in an
 * off-heap `Dictionary` of ckeys (F15: no JS `Map` of millions of strings).
 *
 * Maintained by the main thread as the shard dictionary grows (`extend`),
 * append-only like the dictionary itself: a worker reading ids below the size
 * it was handed never races a write, and a growth allocates NEW buffers.
 */
export class CkeyIndex {
  private classOf: Uint32Array;
  private outsideFlag: Uint8Array;
  /** Entries classified so far (= the dictionary size at the last `extend`). */
  size = 0;
  /** The interned ckeys (class id = their id). */
  readonly classes = new Dictionary(1024, 64 * 1024);
  /** Entries outside the domain. */
  outsideEntries = 0;
  private readonly scratch = { buf: new Uint8Array(256) };

  constructor(initial = 1024) {
    this.classOf = sharedU32(Math.max(16, initial));
    this.outsideFlag = sharedU8(Math.max(16, initial));
  }

  /** Classify the dictionary's entries `[size, dict.size)`. */
  extend(dict: DictView): void {
    const to = dict.size;
    if (to <= this.size) return;
    if (to > this.classOf.length) {
      const capacity = Math.max(to, Math.ceil(this.classOf.length * 1.5));
      const next = sharedU32(capacity);
      next.set(this.classOf.subarray(0, this.size));
      this.classOf = next;
      const flags = sharedU8(capacity);
      flags.set(this.outsideFlag.subarray(0, this.size));
      this.outsideFlag = flags;
    }
    const scratch = this.scratch;
    for (let id = this.size; id < to; id++) {
      const start = dict.offsets[id];
      const end = dict.offsets[id + 1];
      if (!entryInDomain(dict.bytes, start, end)) {
        this.classOf[id] = 0;
        this.outsideFlag[id] = 1;
        this.outsideEntries++;
        continue;
      }
      const len = ckeyBytes(dict.bytes, start, end, scratch);
      this.classOf[id] = this.classes.internBytes(scratch.buf, 0, len) + 1;
    }
    this.size = to;
  }

  /** Class id + 1 of a dictionary entry (0 = outside the domain). */
  classOfId(id: number): number {
    return this.classOf[id];
  }

  /** Is the entry outside the domain? */
  outside(id: number): boolean {
    return this.outsideFlag[id] === 1;
  }

  /** Class id + 1 of a LITERAL: undefined when outside the domain (UNSUPPORTED), 0 when no entry has that class. */
  classOfLiteral(value: string): number | undefined {
    if (!inCkeyDomain(value)) return undefined;
    const id = this.classes.find(ckey(value));
    return id < 0 ? 0 : id + 1;
  }

  /** What a worker reads: `classOf` for ids below `size`. */
  view(): CkeyView {
    return { classOf: this.classOf, size: this.size, classes: this.classes.size };
  }

  get memoryBytes(): number {
    return this.classOf.byteLength + this.outsideFlag.byteLength + this.classes.memoryBytes;
  }
}

/** A `CkeyIndex` as a worker reads it. */
export interface CkeyView {
  classOf: Uint32Array;
  /** Dictionary ids classified. */
  size: number;
  /** Classes interned. */
  classes: number;
}
