import { compareNumCells, NC_NUM } from '../core/bson-order.js';
import { andInto, invertInto, newBitset, orInto, popcount } from '../core/bitset.js';
import type { CkeyView } from '../core/ckey.js';
import { PoolPassCache } from '../pools/pool-pass.js';
import { PC_PID, PID_COL, PID_PERM, RANK_PERMS, type RankColumnArrays } from './rank-columns.js';
import { slotOfPid, type RankCsr } from './rank-perms.js';

/**
 * One leaderboard PASS over the rank engine (design §4.10 two-phase pass,
 * §6.3–§6.5), per shard by SHAPE:
 *
 *  - `ranked`: per atom of the compiled filter a bitset over the slots (a
 *    column scan), a clause the OR of its atoms, the match set the AND of the
 *    clauses and `live` — cached per (instance, generation, atom / query); the
 *    sort permutation (A+ for the rate sorts — the filter implies A+, the
 *    compiler checks) walked against it, forwards or BACKWARDS (nft_id_desc),
 *    MATERIALISING every match;
 *  - `owner` / `pool` / `lookup`: the candidate rows of the scope (the owner
 *    collation class's CSR group, the pool's binary CSR group, the slot of the
 *    canonical positionId — a binary search of the pid permutation), each
 *    tested against the whole compiled filter, sorted by the leaderboard order;
 *  - n = the exact match count (the count contract caps it later);
 *  - all chains: the shards' lists merged by the Mongo path's comparator —
 *    the sort key in BSON order × direction, positionId × tie direction, then
 *    chainId ascending.
 * Pure over shared arrays: a pass worker or the main thread runs it.
 */

/** A compiled filter atom bound to one shard at one generation (`rank-query.ts`). */
export type RankBoundAtom =
  | { k: 'const'; value: boolean; key: string }
  | { k: 'num'; pos: number; hasLo: boolean; lo: number; loIncl: boolean; hasHi: boolean; hi: number; hiIncl: boolean; key: string }
  | { k: 'numEq'; pos: number; nc: number; v: number; neg: boolean; key: string }
  /** positionId / tokenId equality (binary): `pc` the class to match (PC_PID with `v`, PC_NULL), or -1 = nothing matches. */
  | { k: 'pidEq'; pos: number; pc: number; v: number; neg: boolean; key: string }
  /** Binary string equality: `sid` = dictionary id + 1 (0 = the null literal); `absent`: not in the dictionary. */
  | { k: 'strEq'; pos: number; sid: number; absent: boolean; neg: boolean; key: string }
  /** Binary membership: a bitset over dictionary ids (null never a member). */
  | { k: 'strIn'; pos: number; bits: Uint32Array; neg: boolean; key: string }
  /** Collated equality: the literal's collation class + 1 (0 = no entry has it). */
  | { k: 'clsEq'; pos: number; cls: number; neg: boolean; key: string }
  /** Collated membership: a bitset over collation class ids (null never a member). */
  | { k: 'clsIn'; pos: number; bits: Uint32Array; neg: boolean; key: string }
  | { k: 'boolEq'; pos: number; code: number; neg: boolean; key: string };

export interface RankBoundQuery {
  clauses: RankBoundAtom[][];
  key: string;
}

/** Where a shard's candidates come from. */
export type RankScope =
  | { kind: 'all' }
  /** The pool CSR group (dictionary id + 1). 0 = no such pool: no candidate. */
  | { kind: 'pool'; key: number }
  /** The owner CSR group (collation class + 1). 0 = no such class: no candidate. */
  | { kind: 'owner'; key: number }
  /** The row with this canonical positionId; -1 = none. */
  | { kind: 'pid'; pid: number };

/** Everything a pass needs of one shard at one generation. */
export interface RankShardRef {
  shard: string;
  chainId: number;
  instance: number;
  gen: number;
  slots: number;
  /** Live rows at this generation. */
  live: number;
  cols: RankColumnArrays;
  ckeys: CkeyView;
  perms: Uint32Array[];
  permLen: number[];
  pool: RankCsr;
  owner: RankCsr;
}

export interface RankPassShard {
  ref: RankShardRef;
  query: RankBoundQuery;
  scope: RankScope;
}

export interface RankPassTask {
  shards: RankPassShard[];
  /** Index into `RANK_PERMS`. */
  perm: number;
  /** Walk the permutation backwards (nft_id_desc). */
  reverse: boolean;
  /** false: counts only. */
  materialize: boolean;
}

export interface RankPassResult {
  /** Exact matches per shard (task order). */
  n: number[];
  /** Rows the scope offered per shard (the live rows for `all`) — lane-A cost estimates. */
  scope: number[];
  slots?: Uint32Array;
  shard?: Uint8Array;
}

/**
 * The rank engine's per-worker caches (bitsets; the needle part of the pool
 * cache is unused). Bitsets are keyed by generation (`genKey`), and a busy
 * shard advances a generation every couple of seconds: the moment a pass sees
 * a NEWER generation of an instance, that instance's older generations are
 * dropped — answers are only ever computed on the current generation, so they
 * can never be read again, and leaving them to the LRU byte cap would keep the
 * cache full of dead bitsets.
 */
export class RankPassCache extends PoolPassCache {
  /** A pass over `ref`: forget the instance's generations older than `ref.gen` (`noteGeneration`). */
  seeGeneration(ref: Pick<RankShardRef, 'shard' | 'instance' | 'gen'>): void {
    this.noteGeneration(instanceKey(ref as RankShardRef), ref.gen);
  }
}

function instanceKey(ref: RankShardRef): string {
  return `rank:${ref.shard}#${ref.instance}`;
}

function genKey(ref: RankShardRef): string {
  return `${instanceKey(ref)}|${ref.gen}`;
}

function liveBits(ref: RankShardRef, cache: RankPassCache): Uint32Array {
  const key = `${genKey(ref)}|live`;
  const hit = cache.getBits(key);
  if (hit) return hit;
  const words = newBitset(ref.slots);
  const live = ref.cols.live;
  for (let s = 0; s < ref.slots; s++) if (live[s] === 1) words[s >>> 5] |= 1 << (s & 31);
  cache.putBits(key, words);
  return words;
}

/** Does slot `s` satisfy `atom`? (Dead slots are answered too; callers filter on live.) */
export function rankAtomTest(cols: RankColumnArrays, ckeys: CkeyView, atom: RankBoundAtom, s: number): boolean {
  switch (atom.k) {
    case 'const':
      return atom.value;
    case 'num': {
      if (cols.nc[atom.pos][s] !== NC_NUM) return false;
      const v = cols.nv[atom.pos][s];
      if (atom.hasLo && (atom.loIncl ? !(v >= atom.lo) : !(v > atom.lo))) return false;
      if (atom.hasHi && (atom.hiIncl ? !(v <= atom.hi) : !(v < atom.hi))) return false;
      return true;
    }
    case 'numEq': {
      const hit = cols.nc[atom.pos][s] === atom.nc && (atom.nc !== NC_NUM || cols.nv[atom.pos][s] === atom.v);
      return hit !== atom.neg;
    }
    case 'pidEq': {
      const pc = cols.pc[atom.pos][s];
      const hit = atom.pc >= 0 && pc === atom.pc && (pc !== PC_PID || cols.pv[atom.pos][s] === atom.v);
      return hit !== atom.neg;
    }
    case 'strEq': {
      const hit = !atom.absent && cols.sid[atom.pos][s] === atom.sid;
      return hit !== atom.neg;
    }
    case 'strIn': {
      const id = cols.sid[atom.pos][s];
      const hit = id !== 0 && (atom.bits[(id - 1) >>> 5] & (1 << ((id - 1) & 31))) !== 0;
      return hit !== atom.neg;
    }
    case 'clsEq': {
      const id = cols.sid[atom.pos][s];
      const hit = atom.cls !== 0 && id !== 0 && id - 1 < ckeys.size && ckeys.classOf[id - 1] === atom.cls;
      return hit !== atom.neg;
    }
    case 'clsIn': {
      const id = cols.sid[atom.pos][s];
      let hit = false;
      if (id !== 0 && id - 1 < ckeys.size) {
        const c = ckeys.classOf[id - 1];
        hit = c !== 0 && (atom.bits[(c - 1) >>> 5] & (1 << ((c - 1) & 31))) !== 0;
      }
      return hit !== atom.neg;
    }
    case 'boolEq': {
      const hit = cols.bv[atom.pos][s] === atom.code;
      return hit !== atom.neg;
    }
  }
}

/** One atom over every slot (cached per generation). */
function atomBits(ref: RankShardRef, atom: RankBoundAtom, cache: RankPassCache): Uint32Array {
  const key = `${genKey(ref)}|${atom.key}`;
  const hit = cache.getBits(key);
  if (hit) return hit;
  const n = ref.slots;
  const words = newBitset(n);
  if (atom.k === 'const') {
    if (atom.value) invertInto(words, n);
  } else if (atom.k === 'num') {
    const nc = ref.cols.nc[atom.pos];
    const nv = ref.cols.nv[atom.pos];
    const { hasLo, lo, loIncl, hasHi, hi, hiIncl } = atom;
    for (let s = 0; s < n; s++) {
      if (nc[s] !== NC_NUM) continue;
      const v = nv[s];
      if (hasLo && (loIncl ? !(v >= lo) : !(v > lo))) continue;
      if (hasHi && (hiIncl ? !(v <= hi) : !(v < hi))) continue;
      words[s >>> 5] |= 1 << (s & 31);
    }
  } else {
    // The other kinds are cheap per row and carry their own negation.
    for (let s = 0; s < n; s++) if (rankAtomTest(ref.cols, ref.ckeys, atom, s)) words[s >>> 5] |= 1 << (s & 31);
  }
  cache.putBits(key, words);
  return words;
}

/** The match set of a bound query over the whole shard (cached per generation and query). */
export function rankMatchBits(ref: RankShardRef, query: RankBoundQuery, cache: RankPassCache): Uint32Array {
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

/** Does the live slot `s` satisfy the whole query? */
export function rankRowMatches(ref: RankShardRef, query: RankBoundQuery, s: number): boolean {
  if (ref.cols.live[s] !== 1) return false;
  for (const clause of query.clauses) {
    let any = false;
    for (const atom of clause) {
      if (rankAtomTest(ref.cols, ref.ckeys, atom, s)) {
        any = true;
        break;
      }
    }
    if (!any) return false;
  }
  return true;
}

/**
 * The leaderboard order of two slots of (possibly different) shards: the
 * permutation's key in BSON order × its direction, then positionId — ascending
 * for every numeric sort, and with the walk's direction for the pid order.
 */
export function rankSlotComparator(perm: number, reverse: boolean): (a: RankShardRef, sa: number, b: RankShardRef, sb: number) => number {
  const spec = RANK_PERMS[perm];
  const pidDir = perm === PID_PERM && reverse ? -1 : 1;
  if (spec.numPos < 0) {
    return (A, a, B, b) => {
      const x = A.cols.pv[PID_COL][a];
      const y = B.cols.pv[PID_COL][b];
      return (x < y ? -1 : x > y ? 1 : 0) * pidDir;
    };
  }
  const dir = spec.descending ? -1 : 1;
  const pos = spec.numPos;
  return (A, a, B, b) => {
    const c = compareNumCells(A.cols.nc[pos][a], A.cols.nv[pos][a], B.cols.nc[pos][b], B.cols.nv[pos][b]) * dir;
    if (c !== 0) return c;
    const x = A.cols.pv[PID_COL][a];
    const y = B.cols.pv[PID_COL][b];
    return x < y ? -1 : x > y ? 1 : 0;
  };
}

/** The matching slots of a ranked shard in the walk's order. */
function walk(ref: RankShardRef, perm: number, reverse: boolean, match: Uint32Array, n: number): Uint32Array {
  const out = new Uint32Array(n);
  const order = ref.perms[perm];
  const len = ref.permLen[perm];
  let k = 0;
  if (reverse) {
    for (let i = len - 1; i >= 0 && k < n; i--) {
      const slot = order[i];
      if ((match[slot >>> 5] & (1 << (slot & 31))) !== 0) out[k++] = slot;
    }
  } else {
    for (let i = 0; i < len && k < n; i++) {
      const slot = order[i];
      if ((match[slot >>> 5] & (1 << (slot & 31))) !== 0) out[k++] = slot;
    }
  }
  if (k !== n) throw new Error(`rank pass: permutation ${RANK_PERMS[perm].name} of ${ref.shard} yielded ${k} of ${n} matches`);
  return out;
}

/** A scoped shard's candidates (copy). */
function candidates(ref: RankShardRef, scope: RankScope): Uint32Array {
  switch (scope.kind) {
    case 'pool': {
      const csr = ref.pool;
      if (scope.key <= 0 || scope.key >= csr.keys) return new Uint32Array(0);
      return csr.order.slice(csr.start[scope.key], csr.start[scope.key + 1]);
    }
    case 'owner': {
      const csr = ref.owner;
      if (scope.key <= 0 || scope.key >= csr.keys) return new Uint32Array(0);
      return csr.order.slice(csr.start[scope.key], csr.start[scope.key + 1]);
    }
    case 'pid': {
      if (scope.pid < 0) return new Uint32Array(0);
      const slot = slotOfPid(ref.cols, ref.perms[PID_PERM], ref.permLen[PID_PERM], scope.pid);
      return slot < 0 ? new Uint32Array(0) : Uint32Array.of(slot);
    }
    case 'all':
      throw new Error('rank pass: the all scope has no candidate list');
  }
}

/** k-way merge of per-shard ordered slot lists (runs taken while the leader stays ahead), chainId last. */
export function mergeRankLists(shards: readonly RankShardRef[], cmp: (a: RankShardRef, sa: number, b: RankShardRef, sb: number) => number, lists: readonly Uint32Array[]): { slots: Uint32Array; shard: Uint8Array } {
  const total = lists.reduce((sum, list) => sum + list.length, 0);
  const slots = new Uint32Array(total);
  const shard = new Uint8Array(total);
  const order = (sa: number, a: number, sb: number, b: number) => cmp(shards[sa], a, shards[sb], b) || shards[sa].chainId - shards[sb].chainId;
  const pos = lists.map(() => 0);
  let k = 0;
  while (k < total) {
    let best = -1;
    let second = -1;
    for (let s = 0; s < lists.length; s++) {
      if (pos[s] >= lists[s].length) continue;
      if (best < 0 || order(s, lists[s][pos[s]], best, lists[best][pos[best]]) < 0) {
        second = best;
        best = s;
      } else if (second < 0 || order(s, lists[s][pos[s]], second, lists[second][pos[second]]) < 0) second = s;
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
    } while (pos[best] < list.length && order(best, list[pos[best]], second, rival) < 0);
  }
  return { slots, shard };
}

/** Run one pass task. */
export function runRankPass(task: RankPassTask, cache: RankPassCache): RankPassResult {
  const n: number[] = [];
  const scopeRows: number[] = [];
  const lists: Uint32Array[] = [];
  const cmp = rankSlotComparator(task.perm, task.reverse);
  for (const { ref, query, scope } of task.shards) {
    cache.seeGeneration(ref);
    if (scope.kind === 'all') {
      const match = rankMatchBits(ref, query, cache);
      const count = popcount(match);
      n.push(count);
      scopeRows.push(ref.live);
      if (task.materialize) lists.push(walk(ref, task.perm, task.reverse, match, count));
      continue;
    }
    const offered = candidates(ref, scope);
    scopeRows.push(offered.length);
    const kept: number[] = [];
    for (let i = 0; i < offered.length; i++) if (rankRowMatches(ref, query, offered[i])) kept.push(offered[i]);
    n.push(kept.length);
    if (task.materialize) {
      kept.sort((a, b) => cmp(ref, a, ref, b));
      lists.push(Uint32Array.from(kept));
    }
  }
  const result: RankPassResult = { n, scope: scopeRows };
  if (!task.materialize) return result;
  if (lists.length === 1) result.slots = lists[0];
  else {
    const merged = mergeRankLists(
      task.shards.map((s) => s.ref),
      cmp,
      lists,
    );
    result.slots = merged.slots;
    result.shard = merged.shard;
  }
  return result;
}
