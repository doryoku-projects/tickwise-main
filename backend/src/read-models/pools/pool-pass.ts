import { compareNumCells, NC_NUM } from '../core/bson-order.js';
import { andInto, invertInto, newBitset, orInto, popcount, setBit, testBit, wordsFor } from '../core/bitset.js';
import { NeedleMatcher } from '../core/regex-literal.js';
import { POOL_ID_COL, POOL_PERMS, type DictView, type PoolShardRef } from './pool-columns.js';
import { comparePoolIds } from './pool-perms.js';

/**
 * One pools-list PASS over the catalog (design §4.10 two-phase pass, §5.2–5.4):
 *
 *  1. per atom of the compiled filter a bitset over the shard's slots
 *     (a column scan), each clause the OR of its atoms, the match set the AND
 *     of the clauses and the live bit — cached per (instance, generation,
 *     atom / query);
 *  2. n = popcount (EXACT: the count contract caps it later, §5.4);
 *  3. the sort permutation walked against the match set, MATERIALISING every
 *     matching slot in order — so any page of the answer is O(limit) and a
 *     cached answer is exact at its own generation;
 *  4. all chains: the shards' lists merged by the same comparator the Mongo
 *     path's merges use (sort leaf in BSON order × direction, poolId binary
 *     ascending, then chainId ascending).
 * Pure over shared arrays: a pass worker or the main thread runs it.
 */

/** A compiled filter atom bound to one shard at one generation (`pool-query.ts`). */
export type BoundAtom =
  | { k: 'const'; value: boolean; key: string }
  | { k: 'num'; pos: number; hasLo: boolean; lo: number; loIncl: boolean; hasHi: boolean; hi: number; hiIncl: boolean; neg: boolean; key: string }
  | { k: 'numEq'; pos: number; nc: number; v: number; neg: boolean; key: string }
  /** `sid`: the literal's dictionary id + 1 (0 = the null literal); `absent`: the literal is not in the dictionary at this generation. */
  | { k: 'strEq'; pos: number; sid: number; absent: boolean; neg: boolean; key: string }
  /** Membership of the row's string in a list, as a bitset over dictionary ids (null is never a member). */
  | { k: 'strIn'; pos: number; bits: Uint32Array; neg: boolean; key: string }
  | { k: 'boolEq'; pos: number; code: number; neg: boolean; key: string }
  | { k: 'regex'; pos: number; needle: string; key: string };

export interface BoundQuery {
  /** AND of clauses, each the OR of its atoms; no clause = every live row. */
  clauses: BoundAtom[][];
  /** A stable key of the whole filter (cache). */
  key: string;
}

export interface PoolPassShard {
  ref: PoolShardRef;
  query: BoundQuery;
}

export interface PoolPassTask {
  shards: PoolPassShard[];
  /** Index into `POOL_PERMS`. */
  perm: number;
  /** false: counts only. */
  materialize: boolean;
  /** Also count each atom's live matches (lane-A cost estimates). */
  atomCounts?: boolean;
}

export interface PoolPassResult {
  /** Exact matches per shard (task order). */
  n: number[];
  /** Per shard, per clause, per atom: live rows the atom matches (when asked). */
  atomCounts?: number[][][];
  /** The ordered matches: slots, and with several shards the shard index of each. */
  slots?: Uint32Array;
  shard?: Uint8Array;
}

/** Bitsets and needle results a pass engine keeps between passes (one per worker). */
/** Needle states per engine (two dictionary-sized bitsets each) before the least recently used go (bytes). */
export const DEFAULT_NEEDLE_BYTES = 8 * 1024 * 1024;

export class PoolPassCache {
  private readonly bits = new Map<string, Uint32Array>();
  private bitBytes = 0;
  private readonly needles = new Map<string, NeedleState>();
  private readonly plain = new Map<string, PlainIndex>();
  /** Per instance key, the generations whose bitsets may be cached (`seeGeneration`). */
  private readonly gens = new Map<string, Set<number>>();
  hits = 0;
  misses = 0;

  constructor(
    private readonly maxBitBytes = 64 * 1024 * 1024,
    private readonly maxNeedles = 64,
    private readonly maxNeedleBytes = DEFAULT_NEEDLE_BYTES,
  ) {}

  /**
   * A pass over generation `gen` of `instance`: forget the instance's older
   * generations' bitsets at once (a retired generation's bitsets would
   * otherwise sit in the LRU until evicted). Bitset keys are
   * `${instance}|${gen}|…`, so `dropInstance(`${instance}|${gen}`)` drops
   * exactly one generation's.
   */
  noteGeneration(instance: string, gen: number): void {
    let seen = this.gens.get(instance);
    if (!seen) this.gens.set(instance, (seen = new Set()));
    for (const old of seen) {
      if (old >= gen) continue;
      this.dropInstance(`${instance}|${old}`);
      seen.delete(old);
    }
    seen.add(gen);
  }

  /** Bytes the needle states hold (their two bitsets grow to the dictionary). */
  get needleBytes(): number {
    let total = 0;
    for (const state of this.needles.values()) total += state.known.byteLength + state.match.byteLength;
    return total;
  }

  getBits(key: string): Uint32Array | undefined {
    const found = this.bits.get(key);
    if (found) {
      this.bits.delete(key);
      this.bits.set(key, found);
      this.hits++;
    } else this.misses++;
    return found;
  }

  putBits(key: string, words: Uint32Array): void {
    const old = this.bits.get(key);
    if (old) this.bitBytes -= old.byteLength;
    this.bits.set(key, words);
    this.bitBytes += words.byteLength;
    for (const [k, v] of this.bits) {
      if (this.bitBytes <= this.maxBitBytes) break;
      this.bits.delete(k);
      this.bitBytes -= v.byteLength;
    }
  }

  needle(instanceKey: string, needle: string): NeedleState {
    const key = `${instanceKey}|${needle}`;
    let state = this.needles.get(key);
    if (state) {
      this.needles.delete(key);
      this.needles.set(key, state);
      return state;
    }
    state = new NeedleState(new NeedleMatcher(needle));
    this.needles.set(key, state);
    while (this.needles.size > this.maxNeedles) this.needles.delete(this.needles.keys().next().value!);
    // A byte cap too: each state's bitsets grow to the dictionary (millions of
    // entries at full size), so 64 of them are not a bounded amount of memory.
    let bytes = this.needleBytes;
    for (const [k, v] of this.needles) {
      if (bytes <= this.maxNeedleBytes || k === key) break;
      this.needles.delete(k);
      bytes -= v.known.byteLength + v.match.byteLength;
    }
    return state;
  }

  plainIndex(instanceKey: string): PlainIndex {
    let index = this.plain.get(instanceKey);
    if (!index) this.plain.set(instanceKey, (index = new PlainIndex()));
    return index;
  }

  /** Forget everything of an instance (rebuilt or dropped). */
  dropInstance(instanceKey: string): void {
    const prefix = `${instanceKey}|`;
    for (const [k, v] of this.bits) {
      if (!k.startsWith(prefix)) continue;
      this.bits.delete(k);
      this.bitBytes -= v.byteLength;
    }
    for (const k of this.needles.keys()) if (k.startsWith(prefix)) this.needles.delete(k);
    this.plain.delete(instanceKey);
    this.gens.delete(instanceKey);
  }

  get stats() {
    return { bitsets: this.bits.size, bitBytes: this.bitBytes, needles: this.needles.size, needleBytes: this.needleBytes, hits: this.hits, misses: this.misses };
  }
}

/**
 * One needle's per-dictionary-id results (§5.3's incremental search cache).
 * Entries are immutable, so an entry is tested once per catalog instance and
 * never again; a generation only adds the ids it minted.
 *
 *  - Needles of 3+ folded bytes: the whole dictionary range is scanned at once
 *    (`prefill`) — a native `Buffer.indexOf` of the folded needle over the
 *    entry bytes finds every match in a "plain" entry (ASCII with no
 *    upper-case letter, where the case-insensitive match IS the byte match:
 *    every pool id and token address), and only the other entries (symbols
 *    with capitals, non-ASCII) are tested one by one.
 *  - Shorter needles match almost everything: entries are tested lazily, as
 *    rows reach them, each test stopping at its first hit.
 */
export class NeedleState {
  known: Uint32Array = new Uint32Array(0);
  match: Uint32Array = new Uint32Array(0);
  /** Ids below this were all decided by `prefill`. */
  prefilled = 0;

  constructor(readonly matcher: NeedleMatcher) {}

  test(dict: DictView, id: number): boolean {
    if (id >= this.known.length * 32) this.grow(Math.max(dict.size, id + 1));
    if (testBit(this.known, id)) return testBit(this.match, id);
    const hit = this.matcher.matchBytes(dict.bytes, dict.offsets[id], dict.offsets[id + 1]);
    setBit(this.known, id);
    if (hit) setBit(this.match, id);
    return hit;
  }

  /** Should the whole dictionary be scanned at once for this needle? */
  get bulk(): boolean {
    const folded = this.matcher.folded;
    return folded === null || folded.length >= 3;
  }

  /** Decide every id in `[prefilled, dict.size)` in one pass (see the class comment). */
  prefill(dict: DictView, plain: PlainIndex): void {
    const from = this.prefilled;
    const to = dict.size;
    if (to <= from) return;
    this.grow(to);
    plain.ensure(dict, to);
    const flags = plain.flags;
    const folded = this.matcher.folded;
    if (folded !== null && folded.length > 0) {
      const start = dict.offsets[from];
      const end = dict.offsets[to];
      const hay = Buffer.from(dict.bytes.buffer, dict.bytes.byteOffset + start, end - start);
      const needle = Buffer.from(folded);
      let id = from;
      let at = hay.indexOf(needle, 0);
      while (at >= 0) {
        const pos = start + at;
        while (dict.offsets[id + 1] <= pos) id++;
        const entryEnd = dict.offsets[id + 1];
        if (pos + needle.length <= entryEnd && flags[id] === PLAIN) {
          setBit(this.known, id);
          setBit(this.match, id);
        }
        if (entryEnd >= end) break;
        at = hay.indexOf(needle, entryEnd - start);
      }
    }
    for (let id = from; id < to; id++) {
      if (testBit(this.known, id)) continue;
      // A plain entry the scan did not hit does not match (nor does any, for a
      // needle no ASCII string can hold); any other entry is tested.
      if (flags[id] === PLAIN) setBit(this.known, id);
      else this.test(dict, id);
    }
    this.prefilled = to;
  }

  private grow(ids: number): void {
    if (ids <= this.known.length * 32) return;
    const words = wordsFor(Math.max(ids, this.known.length * 64, 1024));
    const known = new Uint32Array(words);
    known.set(this.known);
    const match = new Uint32Array(words);
    match.set(this.match);
    this.known = known;
    this.match = match;
  }
}

const PLAIN = 1;
const MIXED = 2;

/**
 * Per catalog instance: which dictionary entries are "plain" — ASCII without
 * an upper-case letter — so a byte search of a folded needle decides them.
 */
export class PlainIndex {
  flags: Uint8Array = new Uint8Array(0);
  size = 0;

  ensure(dict: DictView, to: number): void {
    if (to <= this.size) return;
    if (to > this.flags.length) {
      const next = new Uint8Array(Math.max(to, this.flags.length * 2, 1024));
      next.set(this.flags);
      this.flags = next;
    }
    const bytes = dict.bytes;
    for (let id = this.size; id < to; id++) {
      let flag = PLAIN;
      for (let i = dict.offsets[id], end = dict.offsets[id + 1]; i < end; i++) {
        const b = bytes[i];
        if (b >= 0x80 || (b >= 0x41 && b <= 0x5a)) {
          flag = MIXED;
          break;
        }
      }
      this.flags[id] = flag;
    }
    this.size = to;
  }
}

function instanceKey(ref: PoolShardRef): string {
  return `${ref.shard}#${ref.instance}`;
}

function genKey(ref: PoolShardRef): string {
  return `${instanceKey(ref)}|${ref.gen}`;
}

/** Live slots of the shard at this generation. */
function liveBits(ref: PoolShardRef, cache: PoolPassCache): Uint32Array {
  const key = `${genKey(ref)}|live`;
  const hit = cache.getBits(key);
  if (hit) return hit;
  const words = newBitset(ref.slots);
  const live = ref.cols.live;
  for (let s = 0; s < ref.slots; s++) if (live[s] === 1) words[s >>> 5] |= 1 << (s & 31);
  cache.putBits(key, words);
  return words;
}

/** The slots one atom matches (dead slots included; the live AND removes them). */
function atomBits(ref: PoolShardRef, atom: BoundAtom, cache: PoolPassCache): Uint32Array {
  const key = `${genKey(ref)}|${atom.key}`;
  const hit = cache.getBits(key);
  if (hit) return hit;
  const n = ref.slots;
  const words = newBitset(n);
  const cols = ref.cols;
  switch (atom.k) {
    case 'const':
      if (atom.value) invertInto(words, n);
      break;
    case 'num': {
      const nc = cols.nc[atom.pos];
      const nv = cols.nv[atom.pos];
      const { hasLo, lo, loIncl, hasHi, hi, hiIncl } = atom;
      for (let s = 0; s < n; s++) {
        if (nc[s] !== NC_NUM) continue;
        const v = nv[s];
        if (hasLo && (loIncl ? !(v >= lo) : !(v > lo))) continue;
        if (hasHi && (hiIncl ? !(v <= hi) : !(v < hi))) continue;
        words[s >>> 5] |= 1 << (s & 31);
      }
      if (atom.neg) invertInto(words, n);
      break;
    }
    case 'numEq': {
      const nc = cols.nc[atom.pos];
      const nv = cols.nv[atom.pos];
      for (let s = 0; s < n; s++) {
        if (nc[s] !== atom.nc) continue;
        if (atom.nc === NC_NUM && nv[s] !== atom.v) continue;
        words[s >>> 5] |= 1 << (s & 31);
      }
      if (atom.neg) invertInto(words, n);
      break;
    }
    case 'strEq': {
      if (!atom.absent) {
        const sid = cols.sid[atom.pos];
        const want = atom.sid;
        for (let s = 0; s < n; s++) if (sid[s] === want) words[s >>> 5] |= 1 << (s & 31);
      }
      if (atom.neg) invertInto(words, n);
      break;
    }
    case 'strIn': {
      const sid = cols.sid[atom.pos];
      const bits = atom.bits;
      for (let s = 0; s < n; s++) {
        const id = sid[s];
        if (id !== 0 && (bits[(id - 1) >>> 5] & (1 << ((id - 1) & 31))) !== 0) words[s >>> 5] |= 1 << (s & 31);
      }
      if (atom.neg) invertInto(words, n);
      break;
    }
    case 'boolEq': {
      const bv = cols.bv[atom.pos];
      for (let s = 0; s < n; s++) if (bv[s] === atom.code) words[s >>> 5] |= 1 << (s & 31);
      if (atom.neg) invertInto(words, n);
      break;
    }
    case 'regex': {
      const sid = cols.sid[atom.pos];
      const live = cols.live;
      const state = cache.needle(instanceKey(ref), atom.needle);
      const dict = ref.dict;
      if (state.bulk) state.prefill(dict, cache.plainIndex(instanceKey(ref)));
      for (let s = 0; s < n; s++) {
        if (live[s] !== 1) continue;
        const id = sid[s];
        if (id !== 0 && state.test(dict, id - 1)) words[s >>> 5] |= 1 << (s & 31);
      }
      break;
    }
  }
  cache.putBits(key, words);
  return words;
}

/** The match set of a bound query on one shard (cached per generation and query). */
export function matchBits(ref: PoolShardRef, query: BoundQuery, cache: PoolPassCache): Uint32Array {
  const key = `${genKey(ref)}|q:${query.key}`;
  const hit = cache.getBits(key);
  if (hit) return hit;
  const match = liveBits(ref, cache).slice();
  for (const clause of query.clauses) {
    if (clause.length === 1) {
      andInto(match, atomBits(ref, clause[0], cache));
      continue;
    }
    const any = newBitset(ref.slots);
    for (const atom of clause) orInto(any, atomBits(ref, atom, cache));
    andInto(match, any);
  }
  cache.putBits(key, match);
  return match;
}

/** The matching slots of one shard in the order of permutation `perm`. */
function walk(ref: PoolShardRef, perm: number, match: Uint32Array, n: number): Uint32Array {
  const out = new Uint32Array(n);
  const order = ref.perms[perm];
  const len = ref.permLen[perm];
  let k = 0;
  for (let i = 0; i < len && k < n; i++) {
    const slot = order[i];
    if ((match[slot >>> 5] & (1 << (slot & 31))) !== 0) out[k++] = slot;
  }
  if (k !== n) throw new Error(`pool pass: permutation ${perm} of ${ref.shard} yielded ${k} of ${n} matches`);
  return out;
}

/** The merged order's comparator over two (shard, slot) pairs. */
export function mergedComparator(shards: readonly PoolShardRef[], perm: number): (sa: number, a: number, sb: number, b: number) => number {
  const spec = POOL_PERMS[perm];
  const dir = spec.descending ? -1 : 1;
  return (sa, a, sb, b) => {
    const A = shards[sa];
    const B = shards[sb];
    const c = compareNumCells(A.cols.nc[spec.numPos][a], A.cols.nv[spec.numPos][a], B.cols.nc[spec.numPos][b], B.cols.nv[spec.numPos][b]) * dir;
    if (c !== 0) return c;
    const t = comparePoolIds(
      A.dict,
      A.cols.sid[POOL_ID_COL][a],
      A.cols.pkHi[a],
      A.cols.pkLo[a],
      B.dict,
      B.cols.sid[POOL_ID_COL][b],
      B.cols.pkHi[b],
      B.cols.pkLo[b],
    );
    if (t !== 0) return t;
    return A.chainId - B.chainId;
  };
}

/** k-way merge of per-shard ordered slot lists (runs taken while the leader stays ahead). */
export function mergeShardLists(shards: readonly PoolShardRef[], perm: number, lists: readonly Uint32Array[]): { slots: Uint32Array; shard: Uint8Array } {
  const total = lists.reduce((sum, list) => sum + list.length, 0);
  const slots = new Uint32Array(total);
  const shard = new Uint8Array(total);
  const cmp = mergedComparator(shards, perm);
  const pos = lists.map(() => 0);
  let k = 0;
  while (k < total) {
    let best = -1;
    let second = -1;
    for (let s = 0; s < lists.length; s++) {
      if (pos[s] >= lists[s].length) continue;
      if (best < 0 || cmp(s, lists[s][pos[s]], best, lists[best][pos[best]]) < 0) {
        second = best;
        best = s;
      } else if (second < 0 || cmp(s, lists[s][pos[s]], second, lists[second][pos[second]]) < 0) second = s;
    }
    const list = lists[best];
    if (second < 0) {
      while (pos[best] < list.length) {
        slots[k] = list[pos[best]++];
        shard[k++] = best;
      }
      continue;
    }
    const rival = lists[second][pos[second]];
    do {
      slots[k] = list[pos[best]++];
      shard[k++] = best;
    } while (pos[best] < list.length && cmp(best, list[pos[best]], second, rival) < 0);
  }
  return { slots, shard };
}

/** Run one pass task. */
export function runPoolPass(task: PoolPassTask, cache: PoolPassCache): PoolPassResult {
  const n: number[] = [];
  const lists: Uint32Array[] = [];
  const atomCounts: number[][][] | undefined = task.atomCounts ? [] : undefined;
  for (const { ref, query } of task.shards) {
    cache.noteGeneration(instanceKey(ref), ref.gen);
    const match = matchBits(ref, query, cache);
    const count = popcount(match);
    n.push(count);
    if (atomCounts) {
      const live = liveBits(ref, cache);
      atomCounts.push(
        query.clauses.map((clause) =>
          clause.map((atom) => {
            const bits = atomBits(ref, atom, cache).slice();
            andInto(bits, live);
            return popcount(bits);
          }),
        ),
      );
    }
    if (task.materialize) lists.push(walk(ref, task.perm, match, count));
  }
  const result: PoolPassResult = { n, ...(atomCounts ? { atomCounts } : {}) };
  if (!task.materialize) return result;
  if (lists.length === 1) result.slots = lists[0];
  else {
    const merged = mergeShardLists(
      task.shards.map((s) => s.ref),
      task.perm,
      lists,
    );
    result.slots = merged.slots;
    result.shard = merged.shard;
  }
  return result;
}
