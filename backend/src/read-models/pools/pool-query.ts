import { NC_NULL, NC_NUM } from '../core/bson-order.js';
import { setBit, wordsFor } from '../core/bitset.js';
import type { Dictionary } from '../core/dictionary.js';
import { POOL_LEAVES, leafIndex } from '../core/fields.js';
import { atomKey, compileFilter, fold, type AstAtom, type CompileResult } from '../core/query-ast.js';
import { sharedU32 } from '../core/shared-memory.js';
import { POOL_LEAF, columnOf } from './pool-columns.js';
import type { BoundAtom, BoundQuery } from './pool-pass.js';

/**
 * The pools-list filter (`PoolsRepository.buildPoolsFilter`, CAST) compiled
 * for the catalog (design §5.2), and bound to one shard at one generation.
 *
 *  | Mongo clause                                  | catalog                                    |
 *  |-----------------------------------------------|--------------------------------------------|
 *  | `chainId`, `protocol` (eq)                    | the shard itself: true / false             |
 *  | `metrics.tvlUsd {$gte: floor, $lte: 5e10}`    | numeric class ∧ floor ≤ v ≤ 5e10 (NaN, null out; $0 stubs in at floor 0) |
 *  | `pricing.source {$ne: 'none'}`                | dictionary id ≠ id('none') (null / missing / 'NONE' pass) |
 *  | `pricing.usedFallback {$ne: true}`            | ≠ true (false, null, missing pass)         |
 *  | search `$or` of 5 × `$regex(escaped, 'i')`    | per dictionary entry, `regex-literal.ts`   |
 *  | `token0/1.address {$nin: excluded}`           | list bitset over dictionary ids; null / missing pass |
 *  | equity `$or` of `token0/1.address {$in: E}`   | list bitset; `E = []` matches nothing      |
 *
 * The exclusion list (~88k addresses) is NOT cast per request: the plan's
 * SHAPE (the same filter with the list replaced by `EXCLUSION_PLACEHOLDER`,
 * which is what its cache keys are built from) is cast and compiled once per
 * key, and the placeholder is bound to the plan's own list. Token addresses
 * sit under Mixed paths, which Mongoose does not cast, so the bound list is
 * exactly what MongoDB receives (pinned by `pool-catalog-parity.spec`).
 */

/** The marker `poolsPlan` puts where the exclusion list goes in its shape filter. */
export const EXCLUSION_PLACEHOLDER = '<excluded>';

export function poolLeafResolver(path: string): { leaf: number; kind: 'num' | 'str' | 'bool' | 'pid' } | undefined {
  const leaf = leafIndex('pools', path);
  return leaf < 0 ? undefined : { leaf, kind: POOL_LEAVES[leaf].kind };
}

/** A compiled pools filter for one shard: atoms over leaves, the leaves it reads. */
export interface PoolQueryPlan {
  clauses: AstAtom[][];
  leaves: number[];
  /** Atoms whose list is the plan's exclusion list (bound per request). */
  placeholder: boolean;
}

export type PoolCompileResult = { ok: true; plan: PoolQueryPlan } | { ok: false; reason: string };

/**
 * Compile a cast pools filter for the shard `(chainId, protocol)`. The
 * identity leaves become constants (R1 quarantines any row whose chainId /
 * protocol is not the shard's, and the catalog never answers a shard with
 * such a row).
 */
export function compilePoolFilter(cast: unknown, chainId: number, protocol: string): PoolCompileResult {
  const compiled: CompileResult = compileFilter(cast, poolLeafResolver);
  if (!compiled.ok) return compiled;
  let placeholder = false;
  const clauses: AstAtom[][] = [];
  for (const clause of compiled.filter.clauses) {
    const atoms: AstAtom[] = [];
    for (const atom of clause) {
      if (atom.k === 'const') {
        atoms.push(atom);
        continue;
      }
      if (atom.leaf === POOL_LEAF.chainId || atom.leaf === POOL_LEAF.protocol) {
        if (atom.k !== 'eq') return { ok: false, reason: `identity_op:${atom.path}` };
        const own = atom.leaf === POOL_LEAF.chainId ? chainId : protocol;
        atoms.push({ k: 'const', value: (atom.value === own) !== atom.neg });
        continue;
      }
      if (!columnOf(atom.leaf)) return { ok: false, reason: `leaf:${atom.path}` };
      if (atom.k === 'in' && atom.values.length === 1 && atom.values[0] === EXCLUSION_PLACEHOLDER) placeholder = true;
      atoms.push(atom);
    }
    clauses.push(atoms);
  }
  return { ok: true, plan: { clauses: fold(clauses), leaves: compiled.filter.leaves, placeholder } };
}

/** Membership bitsets of string lists over one shard instance's dictionary ids (main thread). */
export class ShardListFlags {
  private readonly lists = new Map<object, { members: Set<string>; bits: Uint32Array; size: number; key: string }>();
  private serial = 0;

  constructor(private readonly maxLists = 8) {}

  /**
   * The bitset of `values` over dictionary ids `< size` (built on first use:
   * one hash lookup per value; extended later by decoding only the new ids).
   * Keyed by the list's identity — `TokensRepository` keeps the identity of
   * an unchanged exclusion set, so it is built once per content change.
   */
  flags(values: readonly string[], dict: Dictionary, size: number): { bits: Uint32Array; key: string } {
    let entry = this.lists.get(values);
    if (!entry) {
      const bits = sharedU32(wordsFor(Math.max(1024, Math.ceil(size * 1.25))));
      entry = { members: new Set(values), bits, size: 0, key: `L${++this.serial}` };
      for (const value of values) {
        const id = dict.find(value);
        if (id >= 0 && id < size) setBit(entry.bits, id);
      }
      entry.size = size;
      this.lists.set(values, entry);
      while (this.lists.size > this.maxLists) this.lists.delete(this.lists.keys().next().value!);
    } else {
      this.lists.delete(values);
      this.lists.set(values, entry);
    }
    if (size > entry.size) {
      if (size > entry.bits.length * 32) {
        const bits = sharedU32(wordsFor(Math.ceil(size * 1.25)));
        bits.set(entry.bits);
        entry.bits = bits;
      }
      for (let id = entry.size; id < size; id++) if (entry.members.has(dict.get(id))) entry.bits[id >>> 5] |= 1 << (id & 31);
      entry.size = size;
    }
    return { bits: entry.bits, key: entry.key };
  }

  get size(): number {
    return this.lists.size;
  }
}

/** What binding needs of one shard at one generation. */
export interface BindTarget {
  /** The shard's live dictionary (ids are stable; only those below `dictSize` belong to the generation). */
  dict: Dictionary;
  dictSize: number;
  lists: ShardListFlags;
}

/**
 * Bind a compiled plan to one shard generation: string literals to
 * dictionary ids (a literal the generation's dictionary lacks matches no row),
 * lists to bitsets, leaves to columns.
 */
export function bindPoolQuery(plan: PoolQueryPlan, target: BindTarget, excluded: readonly string[]): BoundQuery {
  const clauses: BoundAtom[][] = [];
  for (const clause of plan.clauses) {
    clauses.push(
      clause.map((atom): BoundAtom => {
        if (atom.k === 'const') return { k: 'const', value: atom.value, key: atom.value ? 'T' : 'F' };
        const column = columnOf(atom.leaf)!;
        switch (atom.k) {
          case 'range':
            return { k: 'num', pos: column.pos, hasLo: atom.hasLo, lo: atom.lo, loIncl: atom.loIncl, hasHi: atom.hasHi, hi: atom.hi, hiIncl: atom.hiIncl, neg: false, key: atomKey(atom) };
          case 'eq': {
            const key = atomKey(atom);
            if (column.kind === 'num') {
              return atom.value === null
                ? { k: 'numEq', pos: column.pos, nc: NC_NULL, v: 0, neg: atom.neg, key }
                : { k: 'numEq', pos: column.pos, nc: NC_NUM, v: atom.value as number, neg: atom.neg, key };
            }
            if (column.kind === 'bool') {
              const code = atom.value === null ? 0 : atom.value === true ? 1 : 2;
              return { k: 'boolEq', pos: column.pos, code, neg: atom.neg, key };
            }
            if (atom.value === null) return { k: 'strEq', pos: column.pos, sid: 0, absent: false, neg: atom.neg, key };
            const id = target.dict.find(atom.value as string);
            const absent = id < 0 || id >= target.dictSize;
            return { k: 'strEq', pos: column.pos, sid: absent ? -1 : id + 1, absent, neg: atom.neg, key };
          }
          case 'in': {
            const values = plan.placeholder && atom.values.length === 1 && atom.values[0] === EXCLUSION_PLACEHOLDER ? excluded : atom.values;
            if (values.length === 0) return { k: 'const', value: atom.neg, key: atom.neg ? 'T' : 'F' };
            const { bits, key } = target.lists.flags(values, target.dict, target.dictSize);
            return { k: 'strIn', pos: column.pos, bits, neg: atom.neg, key: `i:${atom.leaf}:${atom.neg ? '!' : '='}${key}` };
          }
          case 'regex':
            return { k: 'regex', pos: column.pos, needle: atom.needle, key: atomKey(atom) };
        }
      }),
    );
  }
  return { clauses, key: clauses.map((clause) => clause.map((atom) => atom.key).join('|')).join('&') };
}
