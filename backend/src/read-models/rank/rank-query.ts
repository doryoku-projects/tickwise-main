import { NC_NULL, NC_NUM } from '../core/bson-order.js';
import { canonicalPid } from '../core/cells.js';
import { ckey, inCkeyDomain, type CkeyIndex } from '../core/ckey.js';
import { setBit, wordsFor } from '../core/bitset.js';
import type { Dictionary } from '../core/dictionary.js';
import { RANK_LEAVES, leafIndex, type LeafKind } from '../core/fields.js';
import { atomKey, compileFilter, fold, type AstAtom, type CompileResult } from '../core/query-ast.js';
import { sharedU32 } from '../core/shared-memory.js';
import { ShardListFlags } from '../pools/pool-query.js';
import { BV_FALSE, BV_NULL, BV_TRUE, PC_NULL, PC_PID, RANK_LEAF, rankColumnOf } from './rank-columns.js';
import type { RankBoundAtom, RankBoundQuery, RankScope } from './rank-pass.js';

/**
 * The leaderboard filter (`PositionsRepository.buildLeaderboardFilter`, CAST
 * through the shard's Mongoose model — exactly what MongoDB receives),
 * compiled for the rank engine (design §4.9, §6.3) and bound to one shard at
 * one generation.
 *
 *  | Mongo clause (positions.repository.ts)              | engine                                               |
 *  |-----------------------------------------------------|------------------------------------------------------|
 *  | `chainId`, `protocol` eq                            | the shard itself (R1 quarantines a foreign row)      |
 *  | `poolId` / `owner` eq (lowercased)                  | collated shapes: ckey class; pool / lookup: binary   |
 *  | `$or: [{positionId: X}, {tokenId: X}]` (lookup)     | canonical u32 X (anything else matches no row)       |
 *  | `isActive`, `metrics.inRange`, `performanceReady`   | boolean code (`$ne: true` lets false / null through) |
 *  | `metrics.underlyingValueUsd {$gte: m, $gt: 0}`      | two range atoms, type-bracketed (null / NaN out)     |
 *  | `$or: [{tvl ≥ t}, {tvl ≤ 0}]`                       | two range atoms ORed (−0 / −∞ pass ≤ 0)              |
 *  | `pricing.source {$ne: 'none'}`                      | ckey (collated) / binary; null / missing / 'NONE' pass |
 *  | `token0/1.address {$nin: excluded}`                 | membership flags, collated or binary; null passes    |
 *  | `$or: [{isActive: false}, openGuards]` (All, risky off) | CNF by distribution (`distributeOr`)            |
 *  | equity `$or` of `token0/1.address {$in: E}`         | membership flags; `E = []` matches nothing           |
 *  | honeypot `$or: [{fee < 5%}, {fee ≥ dyn}, {fee: null}]` | two range atoms + a null eq, ORed (NaN never passes); |
 *  |   (`HONEYPOT_FEE_FILTER=on` only)                    | without the `fee` leaf: `unsupported:field:fee`      |
 *  | + `{token0.address ∈ A, token1.address ∈ A}` branch  | CNF by distribution: the fee clause twice, once ORed |
 *  |   (`HONEYPOT_FEE_ANCHOR_EXEMPT=on`, A = anchors)     | with each leg's membership flags (null never ∈ A)    |
 *
 * Small literal lists (`$in` / `$nin` other than the exclusion placeholder —
 * the equity set, the anchor set) are INTERNED by content at compile time:
 * the cast gives every plan its own array, and the binder's list flags are
 * keyed by identity (8 per shard), so without it every new plan carrying the
 * same anchor list — every pool modal, every ranked filter with the exemption
 * on — would build its own bitsets and churn the shard's others out. Same
 * values, same bits: sharing the array can change no answer.
 *
 * The exclusion list (~88k addresses) is never cast per request: the plan's
 * SHAPE (`LeaderboardPlan.shapeFilter`, the list replaced by the
 * `'<excluded>'` placeholder its cache keys are built from) is cast and
 * compiled once per key, and the placeholder bound to `plan.excluded`. The
 * token legs are String paths, so the cast of a string list is the same list
 * (pinned by `rank-query.spec`).
 *
 * Collated comparisons (the `ranked` / `owner` shapes) need every LITERAL in
 * the ckey domain (`ckey.ts`): a literal outside it is UNSUPPORTED — never
 * "no match" — and a list holding one makes the whole list unsupported.
 */

/** The marker `leaderboardPlan` puts where the exclusion list goes in its shape filter. */
export const RANK_EXCLUSION_PLACEHOLDER = '<excluded>';

/** A literal list longer than this keeps its own identity (never a key this size). */
const INTERN_MAX_VALUES = 512;
/** Distinct interned lists kept (oldest dropped: a later compile just interns a fresh copy). */
const INTERN_MAX_LISTS = 64;
const internedLists = new Map<string, readonly string[]>();

/** One frozen array per distinct small list content (see the module comment). */
export function internRankList(values: readonly string[]): readonly string[] {
  if (values.length > INTERN_MAX_VALUES) return values;
  const key = JSON.stringify(values);
  const hit = internedLists.get(key);
  if (hit) return hit;
  const canonical = Object.freeze([...values]);
  internedLists.set(key, canonical);
  while (internedLists.size > INTERN_MAX_LISTS) internedLists.delete(internedLists.keys().next().value!);
  return canonical;
}

export function rankLeafResolver(path: string): { leaf: number; kind: LeafKind } | undefined {
  const leaf = leafIndex('rank', path);
  return leaf < 0 ? undefined : { leaf, kind: RANK_LEAVES[leaf].kind };
}

/** A compiled leaderboard filter for one shard. */
export interface RankQueryPlan {
  clauses: AstAtom[][];
  /** Every leaf the filter reads (quarantine checks, §4.8). */
  leaves: number[];
  /** Atoms whose list is the plan's exclusion list (bound per request). */
  placeholder: boolean;
  /** String comparisons run under the leaderboard collation (`ranked`, `owner`). */
  collated: boolean;
  /** The filter implies A+ (`isActive: true` and a numeric value > 0) at the top level. */
  aplus: boolean;
  /** The scope literal of a scoped shape, from the compiled filter itself. */
  scopeLiteral?: { kind: 'pool' | 'owner'; value: string } | { kind: 'pid'; value: string };
}

export type RankCompileResult = { ok: true; plan: RankQueryPlan } | { ok: false; reason: string };

export type RankShape = 'lookup' | 'pool' | 'owner' | 'ranked';

/**
 * Compile a cast leaderboard filter for the shard `(chainId, protocol)` and a
 * shape. The identity leaves become constants; every other leaf must have an
 * engine column; a positionId equality only in an uncollated shape.
 */
export function compileRankFilter(cast: unknown, chainId: number, protocol: string, shape: RankShape): RankCompileResult {
  const compiled: CompileResult = compileFilter(cast, rankLeafResolver, { distributeOr: true, splitBounds: true });
  if (!compiled.ok) return compiled;
  const collated = shape === 'ranked' || shape === 'owner';
  let placeholder = false;
  const clauses: AstAtom[][] = [];
  for (const clause of compiled.filter.clauses) {
    const atoms: AstAtom[] = [];
    for (const atom of clause) {
      if (atom.k === 'const') {
        atoms.push(atom);
        continue;
      }
      if (atom.leaf === RANK_LEAF.chainId || atom.leaf === RANK_LEAF.protocol) {
        if (atom.k !== 'eq') return { ok: false, reason: `identity_op:${atom.path}` };
        const own = atom.leaf === RANK_LEAF.chainId ? chainId : protocol;
        if (atom.value !== own) return { ok: false, reason: `identity_literal:${atom.path}` };
        atoms.push({ k: 'const', value: !atom.neg });
        continue;
      }
      const column = rankColumnOf(atom.leaf);
      if (!column) return { ok: false, reason: `leaf:${atom.path}` };
      if (column.kind === 'pid') {
        if (atom.k !== 'eq') return { ok: false, reason: `pid_op:${atom.path}` };
        if (collated && atom.value !== null) return { ok: false, reason: `collated_pid:${atom.path}` };
      }
      if (atom.k === 'regex') return { ok: false, reason: `regex:${atom.path}` };
      if (atom.k === 'in' && atom.values.length === 1 && atom.values[0] === RANK_EXCLUSION_PLACEHOLDER) {
        placeholder = true;
        atoms.push(atom);
        continue;
      }
      atoms.push(atom.k === 'in' ? { ...atom, values: internRankList(atom.values) } : atom);
    }
    clauses.push(atoms);
  }
  const folded = fold(clauses);
  // An always-false filter implies A+ vacuously (it matches no row at all).
  const plan: RankQueryPlan = { clauses: folded, leaves: compiled.filter.leaves, placeholder, collated, aplus: impliesAplus(folded) || isAlwaysFalse(folded) };
  if (shape !== 'ranked') {
    // A filter that folded to "always false" (e.g. `assetClass=equity` on a chain
    // with no equities: `$in: []`) matches nothing whatever its scope: an empty
    // literal binds to an empty candidate set.
    const scope = isAlwaysFalse(folded) ? emptyScope(shape) : scopeLiteral(folded, shape);
    if (!scope) return { ok: false, reason: `scope:${shape}` };
    plan.scopeLiteral = scope;
  }
  return { ok: true, plan };
}

/** `fold`'s form of a filter no row can match. */
export function isAlwaysFalse(clauses: AstAtom[][]): boolean {
  return clauses.length === 1 && clauses[0].length === 1 && clauses[0][0].k === 'const' && !clauses[0][0].value;
}

function emptyScope(shape: RankShape): RankQueryPlan['scopeLiteral'] {
  return shape === 'lookup' ? { kind: 'pid', value: '' } : { kind: shape as 'pool' | 'owner', value: '' };
}

/** A top-level clause holding exactly one non-negated atom. */
function single(clause: AstAtom[]): AstAtom | undefined {
  return clause.length === 1 ? clause[0] : undefined;
}

/**
 * Does the CNF require `isActive: true` AND a numeric `value > 0` at the top
 * level? (A rate sort walks the A+ permutation; a filter that does not imply
 * A+ would miss rows there — design §6.2: such a query is UNSUPPORTED.)
 */
export function impliesAplus(clauses: AstAtom[][]): boolean {
  let active = false;
  let positive = false;
  for (const clause of clauses) {
    const atom = single(clause);
    if (!atom) continue;
    if (atom.k === 'eq' && atom.leaf === RANK_LEAF.isActive && atom.value === true && !atom.neg) active = true;
    if (atom.k === 'range' && atom.leaf === RANK_LEAF.value && atom.hasLo && (atom.lo > 0 || (atom.lo === 0 && !atom.loIncl))) positive = true;
  }
  return active && positive;
}

/** The scope literal a scoped shape's filter carries (the candidate generator). */
function scopeLiteral(clauses: AstAtom[][], shape: RankShape): RankQueryPlan['scopeLiteral'] {
  if (shape === 'lookup') {
    for (const clause of clauses) {
      if (clause.length !== 2) continue;
      const [a, b] = clause;
      if (a.k !== 'eq' || b.k !== 'eq' || a.neg || b.neg) continue;
      const leaves = new Set([a.leaf, b.leaf]);
      if (!leaves.has(RANK_LEAF.positionId) || !leaves.has(RANK_LEAF.tokenId)) continue;
      if (typeof a.value === 'string' && a.value === b.value) return { kind: 'pid', value: a.value };
    }
    return undefined;
  }
  const leaf = shape === 'pool' ? RANK_LEAF.poolId : RANK_LEAF.owner;
  for (const clause of clauses) {
    const atom = single(clause);
    if (atom && atom.k === 'eq' && atom.leaf === leaf && !atom.neg && typeof atom.value === 'string') return { kind: shape as 'pool' | 'owner', value: atom.value };
  }
  return undefined;
}

/**
 * Membership flags of string lists over one shard instance's collation
 * CLASSES (the collated `$in` / `$nin`), keyed by the list's identity
 * (`TokensRepository` keeps the identity of an unchanged exclusion set).
 * A list holding any value outside the ckey domain is refused as a whole.
 */
export class ClassListFlags {
  private readonly lists = new Map<object, { members: Set<string>; bits: Uint32Array; size: number; key: string } | 'outside'>();
  private serial = 0;

  constructor(private readonly maxLists = 8) {}

  /** The class bitset of `values` over class ids `< classes`, or undefined when a value is outside the domain. */
  flags(values: readonly string[], index: CkeyIndex): { bits: Uint32Array; key: string } | undefined {
    const classes = index.classes.size;
    let entry = this.lists.get(values);
    if (entry === 'outside') return undefined;
    if (!entry) {
      const members = new Set<string>();
      for (const value of values) {
        if (!inCkeyDomain(value)) {
          this.remember(values, 'outside');
          return undefined;
        }
        members.add(ckey(value));
      }
      const bits = sharedU32(wordsFor(Math.max(1024, Math.ceil(classes * 1.25))));
      for (const member of members) {
        const id = index.classes.find(member);
        if (id >= 0 && id < classes) setBit(bits, id);
      }
      entry = { members, bits, size: classes, key: `C${++this.serial}` };
      this.remember(values, entry);
    } else {
      this.lists.delete(values);
      this.lists.set(values, entry);
    }
    if (classes > entry.size) {
      if (classes > entry.bits.length * 32) {
        const bits = sharedU32(wordsFor(Math.ceil(classes * 1.25)));
        bits.set(entry.bits);
        entry.bits = bits;
      }
      for (let id = entry.size; id < classes; id++) if (entry.members.has(index.classes.get(id))) entry.bits[id >>> 5] |= 1 << (id & 31);
      entry.size = classes;
    }
    return { bits: entry.bits, key: entry.key };
  }

  private remember(values: readonly string[], entry: { members: Set<string>; bits: Uint32Array; size: number; key: string } | 'outside'): void {
    this.lists.set(values, entry);
    while (this.lists.size > this.maxLists) this.lists.delete(this.lists.keys().next().value!);
  }

  get size(): number {
    return this.lists.size;
  }
}

/** What binding needs of one shard at one generation. */
export interface RankBindTarget {
  dict: Dictionary;
  /** Dictionary ids belonging to the generation. */
  dictSize: number;
  ckeys: CkeyIndex;
  lists: ShardListFlags;
  classLists: ClassListFlags;
}

export type RankBindResult = { ok: true; query: RankBoundQuery; scope: RankScope } | { ok: false; reason: string };

class BindUnsupported extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/**
 * Bind a compiled plan to one shard generation: string literals to
 * dictionary ids (binary) or collation classes (collated), lists to bitsets,
 * the pid literal to a canonical u32, the scope literal to a CSR key.
 */
export function bindRankQuery(plan: RankQueryPlan, target: RankBindTarget, excluded: readonly string[]): RankBindResult {
  try {
    const clauses: RankBoundAtom[][] = plan.clauses.map((clause) => clause.map((atom) => bindAtom(atom, plan, target, excluded)));
    const query: RankBoundQuery = { clauses, key: clauses.map((clause) => clause.map((atom) => atom.key).join('|')).join('&') };
    return { ok: true, query, scope: bindScope(plan, target) };
  } catch (err) {
    if (err instanceof BindUnsupported) return { ok: false, reason: err.reason };
    throw err;
  }
}

function binarySid(target: RankBindTarget, value: string): { sid: number; absent: boolean } {
  const id = target.dict.find(value);
  const absent = id < 0 || id >= target.dictSize;
  return { sid: absent ? -1 : id + 1, absent };
}

function bindScope(plan: RankQueryPlan, target: RankBindTarget): RankScope {
  const scope = plan.scopeLiteral;
  if (!scope) return { kind: 'all' };
  if (scope.kind === 'pid') {
    const pid = canonicalPid(scope.value);
    return { kind: 'pid', pid: pid === undefined ? -1 : pid };
  }
  if (scope.kind === 'pool') {
    // The pool CSR groups by BINARY dictionary id (the pool shape is uncollated).
    if (plan.collated) throw new BindUnsupported('collated_pool_scope');
    const { sid, absent } = binarySid(target, scope.value);
    return { kind: 'pool', key: absent ? 0 : sid };
  }
  // The owner CSR groups by collation class (the owner shape is collated).
  if (!plan.collated) throw new BindUnsupported('binary_owner_scope');
  const cls = target.ckeys.classOfLiteral(scope.value);
  if (cls === undefined) throw new BindUnsupported('literal_domain:owner');
  return { kind: 'owner', key: cls };
}

function bindAtom(atom: AstAtom, plan: RankQueryPlan, target: RankBindTarget, excluded: readonly string[]): RankBoundAtom {
  if (atom.k === 'const') return { k: 'const', value: atom.value, key: atom.value ? 'T' : 'F' };
  const column = rankColumnOf(atom.leaf);
  if (!column) throw new BindUnsupported(`leaf:${atom.path}`);
  const key = atomKey(atom);
  switch (atom.k) {
    case 'range':
      return { k: 'num', pos: column.pos, hasLo: atom.hasLo, lo: atom.lo, loIncl: atom.loIncl, hasHi: atom.hasHi, hi: atom.hi, hiIncl: atom.hiIncl, key };
    case 'eq': {
      if (column.kind === 'num') {
        return atom.value === null
          ? { k: 'numEq', pos: column.pos, nc: NC_NULL, v: 0, neg: atom.neg, key }
          : { k: 'numEq', pos: column.pos, nc: NC_NUM, v: atom.value as number, neg: atom.neg, key };
      }
      if (column.kind === 'bool') {
        const code = atom.value === null ? BV_NULL : atom.value === true ? BV_TRUE : BV_FALSE;
        return { k: 'boolEq', pos: column.pos, code, neg: atom.neg, key };
      }
      if (column.kind === 'pid') {
        if (atom.value === null) return { k: 'pidEq', pos: column.pos, pc: PC_NULL, v: 0, neg: atom.neg, key };
        const pid = canonicalPid(atom.value as string);
        // A non-canonical literal equals no canonical id (and a shard holding a
        // non-canonical stored id is quarantined: such a query never gets here).
        return pid === undefined ? { k: 'pidEq', pos: column.pos, pc: -1, v: 0, neg: atom.neg, key } : { k: 'pidEq', pos: column.pos, pc: PC_PID, v: pid, neg: atom.neg, key };
      }
      if (atom.value === null) return { k: 'strEq', pos: column.pos, sid: 0, absent: false, neg: atom.neg, key };
      if (plan.collated) {
        const cls = target.ckeys.classOfLiteral(atom.value as string);
        if (cls === undefined) throw new BindUnsupported(`literal_domain:${atom.path}`);
        return { k: 'clsEq', pos: column.pos, cls, neg: atom.neg, key: `c${key}` };
      }
      const { sid, absent } = binarySid(target, atom.value as string);
      return { k: 'strEq', pos: column.pos, sid, absent, neg: atom.neg, key };
    }
    case 'in': {
      const values = plan.placeholder && atom.values.length === 1 && atom.values[0] === RANK_EXCLUSION_PLACEHOLDER ? excluded : atom.values;
      if (values.length === 0) return { k: 'const', value: atom.neg, key: atom.neg ? 'T' : 'F' };
      if (plan.collated) {
        const flags = target.classLists.flags(values, target.ckeys);
        if (!flags) throw new BindUnsupported(`list_domain:${atom.path}`);
        return { k: 'clsIn', pos: column.pos, bits: flags.bits, neg: atom.neg, key: `ci:${atom.leaf}:${atom.neg ? '!' : '='}${flags.key}` };
      }
      const { bits, key: listKey } = target.lists.flags(values, target.dict, target.dictSize);
      return { k: 'strIn', pos: column.pos, bits, neg: atom.neg, key: `i:${atom.leaf}:${atom.neg ? '!' : '='}${listKey}` };
    }
    case 'regex':
      throw new BindUnsupported(`regex:${atom.path}`);
  }
}
