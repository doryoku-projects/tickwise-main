import type { LeafKind } from './fields.js';
import { literalFromRegExp } from './regex-literal.js';

/**
 * Compile the Mongo filter, never re-derive it (design §4.9).
 *
 * The engines' input is the filter the Mongo path itself builds
 * (`PoolsRepository.poolsPlan`, later `PositionsRepository.leaderboardPlan`),
 * CAST through the Mongoose model — exactly what MongoDB receives. This turns
 * it into a conjunction of clauses, each a disjunction of single-leaf atoms
 * (CNF), under a deliberately RESTRICTED grammar:
 *
 *  - `$and` (non-empty) of filters; `$or` (non-empty) whose branches are each
 *    one atom or one disjunction (no conjunction inside a disjunction);
 *  - per field: a literal (equality), `$eq`, `$ne`, `$gt` `$gte` `$lt` `$lte`
 *    with a non-NaN number on a numeric leaf (type-bracketed: only numbers
 *    match, NaN never), `$in` / `$nin` of strings on a string leaf, or a
 *    RegExp that is an escaped literal with flag `i` on a string leaf
 *    (`regex-literal.ts`, which also refuses what PCRE2 / js-bson refuse);
 *  - fields: only the model's leaves (`resolve`).
 * ANYTHING else is UNSUPPORTED with a reason: the request goes to Mongo and
 * the reason is metered. So a clause someone adds to `buildPoolsFilter` /
 * `buildLeaderboardFilter` can never silently diverge — it falls back, and
 * the specs that compile every filter the builders emit fail.
 *
 * Equality is BINARY here (the pools query has no collation); the collated
 * positions shapes (R3) add collation keys on top, when they BIND the atoms
 * (`rank/rank-query.ts`).
 *
 * Options (R3, the positions filter; the pools compile keeps the defaults):
 *  - `distributeOr`: an `$or` whose branches are conjunctions is turned into
 *    CNF by the distributive law, exactly — `A ∨ (B ∧ C)` = `(A ∨ B) ∧
 *    (A ∨ C)` — refused past `maxClauses` (the positions filter's only such
 *    `$or`, `{$or: [{isActive: false}, openGuards]}`, gives 6–7 clauses);
 *  - `splitBounds`: a field bounded twice on one side (`{$gte: 500, $gt: 0}`,
 *    the value floor merged with a rate sort's / the open guards' `$gt: 0`)
 *    becomes two range atoms, ANDed (both must hold, as in MongoDB) instead of
 *    `range_twice`;
 *  - a string literal compared with a `pid` leaf (`positionId` / `tokenId`
 *    equality, the id lookup) is an `eq` atom; the binder decides it.
 */

export type Literal = null | number | string | boolean;

export type AstAtom =
  | { k: 'const'; value: boolean }
  /** Type-bracketed numeric range: a number (not NaN) within the bounds. */
  | { k: 'range'; path: string; leaf: number; hasLo: boolean; lo: number; loIncl: boolean; hasHi: boolean; hi: number; hiIncl: boolean }
  /** Equality to a literal (`neg`: `$ne`). null matches null and missing. */
  | { k: 'eq'; path: string; leaf: number; value: Literal; neg: boolean }
  /** Membership in a list of strings (`neg`: `$nin`; a missing / null value is never a member). */
  | { k: 'in'; path: string; leaf: number; values: readonly string[]; neg: boolean }
  /** Case-insensitive substring (`regex-literal.ts`). */
  | { k: 'regex'; path: string; leaf: number; needle: string };

export interface CompiledFilter {
  /** AND of clauses; each clause is the OR of its atoms. `[]` = every row. */
  clauses: AstAtom[][];
  /** Every leaf the filter reads (quarantine checks, §4.8). */
  leaves: number[];
}

export type CompileResult = { ok: true; filter: CompiledFilter } | { ok: false; reason: string };

export type LeafResolver = (path: string) => { leaf: number; kind: LeafKind } | undefined;

export interface CompileOptions {
  /** Distribute `$or` over conjunction branches (CNF), see the module comment. */
  distributeOr?: boolean;
  /** The most clauses a distributed `$or` may produce (default 256). */
  maxClauses?: number;
  /** Two bounds on one side of a field → two range atoms (default: `range_twice`). */
  splitBounds?: boolean;
}

class Unsupported extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value instanceof RegExp || value instanceof Date) return false;
  if ((value as { _bsontype?: unknown })._bsontype !== undefined) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function isOperatorObject(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((key) => key.startsWith('$'));
}

export function compileFilter(filter: unknown, resolve: LeafResolver, options: CompileOptions = {}): CompileResult {
  try {
    const leaves = new Set<number>();
    const clauses = fold(conjunction(filter, resolve, leaves, options));
    return { ok: true, filter: { clauses, leaves: [...leaves].sort((a, b) => a - b) } };
  } catch (err) {
    if (err instanceof Unsupported) return { ok: false, reason: err.reason };
    throw err;
  }
}

function conjunction(filter: unknown, resolve: LeafResolver, leaves: Set<number>, options: CompileOptions): AstAtom[][] {
  if (!isPlainObject(filter)) throw new Unsupported('filter_shape');
  const clauses: AstAtom[][] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined) throw new Unsupported(`undefined:${key}`);
    if (key === '$and') {
      if (!Array.isArray(value) || value.length === 0) throw new Unsupported('and_shape');
      for (const branch of value) clauses.push(...conjunction(branch, resolve, leaves, options));
    } else if (key === '$or') {
      if (!Array.isArray(value) || value.length === 0) throw new Unsupported('or_shape');
      if (options.distributeOr) {
        clauses.push(...distribute(value.map((branch) => fold(conjunction(branch, resolve, leaves, options))), options.maxClauses ?? 256));
        continue;
      }
      const atoms: AstAtom[] = [];
      let always = false;
      for (const branch of value) {
        const inner = conjunction(branch, resolve, leaves, options);
        if (inner.length === 0) always = true;
        else if (inner.length === 1) atoms.push(...inner[0]);
        else throw new Unsupported('or_conjunction');
      }
      clauses.push(always ? [{ k: 'const', value: true }] : atoms);
    } else if (key.startsWith('$')) {
      throw new Unsupported(`operator:${key}`);
    } else {
      const spec = resolve(key);
      if (!spec) throw new Unsupported(`field:${key}`);
      leaves.add(spec.leaf);
      for (const atom of fieldAtoms(key, spec.leaf, spec.kind, value, options)) clauses.push([atom]);
    }
  }
  return clauses;
}

/**
 * The OR of CNFs as one CNF (distributive law): `(C1 ∧ C2) ∨ (D1 ∧ D2)` =
 * `(C1 ∨ D1) ∧ (C1 ∨ D2) ∧ (C2 ∨ D1) ∧ (C2 ∨ D2)`. A branch with no clause
 * is always true (so is the OR); a branch that folded to false drops out.
 */
function distribute(branches: AstAtom[][][], maxClauses: number): AstAtom[][] {
  let product: AstAtom[][] | undefined;
  for (const branch of branches) {
    if (branch.length === 0) return [[{ k: 'const', value: true }]];
    if (branch.length === 1 && branch[0].length === 1 && branch[0][0].k === 'const' && !branch[0][0].value) continue;
    if (!product) {
      product = branch.map((clause) => [...clause]);
      continue;
    }
    if (product.length * branch.length > maxClauses) throw new Unsupported('or_size');
    const next: AstAtom[][] = [];
    for (const left of product) for (const right of branch) next.push([...left, ...right]);
    product = next;
  }
  return product ?? [[{ k: 'const', value: false }]];
}

function fieldAtoms(path: string, leaf: number, kind: LeafKind, cond: unknown, options: CompileOptions = {}): AstAtom[] {
  if (cond instanceof RegExp) {
    if (kind !== 'str') throw new Unsupported(`regex_kind:${path}`);
    const parsed = literalFromRegExp(cond);
    if ('unsupported' in parsed) throw new Unsupported(parsed.unsupported);
    return [{ k: 'regex', path, leaf, needle: parsed.needle }];
  }
  if (!isOperatorObject(cond)) return [eqAtom(path, leaf, kind, cond, false)];
  const out: AstAtom[] = [];
  const ranges: Array<Extract<AstAtom, { k: 'range' }>> = [];
  const bound = (op: string, arg: unknown) => {
    if (kind !== 'num') throw new Unsupported(`range_kind:${path}`);
    if (typeof arg !== 'number' || Number.isNaN(arg)) throw new Unsupported(`range_literal:${path}`);
    const lower = op === '$gt' || op === '$gte';
    // The first range with this side free; a second bound on one side is a second
    // range atom (both must hold) only with `splitBounds`.
    let range = ranges.find((r) => (lower ? !r.hasLo : !r.hasHi));
    if (!range) {
      if (ranges.length > 0 && !options.splitBounds) throw new Unsupported(`range_twice:${path}`);
      range = { k: 'range', path, leaf, hasLo: false, lo: 0, loIncl: false, hasHi: false, hi: 0, hiIncl: false };
      ranges.push(range);
    }
    if (lower) {
      range.hasLo = true;
      range.lo = arg;
      range.loIncl = op === '$gte';
    } else {
      range.hasHi = true;
      range.hi = arg;
      range.hiIncl = op === '$lte';
    }
  };
  for (const [op, arg] of Object.entries(cond)) {
    switch (op) {
      case '$eq':
        out.push(eqAtom(path, leaf, kind, arg, false));
        break;
      case '$ne':
        out.push(eqAtom(path, leaf, kind, arg, true));
        break;
      case '$gt':
      case '$gte':
      case '$lt':
      case '$lte':
        bound(op, arg);
        break;
      case '$in':
      case '$nin': {
        if (kind !== 'str') throw new Unsupported(`in_kind:${path}`);
        if (!Array.isArray(arg) || !arg.every((v) => typeof v === 'string')) throw new Unsupported(`in_literal:${path}`);
        const neg = op === '$nin';
        if (arg.length === 0) out.push({ k: 'const', value: neg });
        else out.push({ k: 'in', path, leaf, values: arg as string[], neg });
        break;
      }
      default:
        throw new Unsupported(`op:${op}`);
    }
  }
  out.push(...ranges);
  return out;
}

function eqAtom(path: string, leaf: number, kind: LeafKind, value: unknown, neg: boolean): AstAtom {
  if (value === null) return { k: 'eq', path, leaf, value: null, neg };
  switch (typeof value) {
    case 'number':
      if (kind !== 'num' || Number.isNaN(value)) throw new Unsupported(`eq_literal:${path}`);
      return { k: 'eq', path, leaf, value, neg };
    case 'string':
      if (kind !== 'str' && kind !== 'pid') throw new Unsupported(`eq_literal:${path}`);
      return { k: 'eq', path, leaf, value, neg };
    case 'boolean':
      if (kind !== 'bool') throw new Unsupported(`eq_literal:${path}`);
      return { k: 'eq', path, leaf, value, neg };
    default:
      throw new Unsupported(`eq_literal:${path}`);
  }
}

/** Constant folding: drop always-true clauses and always-false atoms; an empty clause makes the whole filter false. */
export function fold(clauses: AstAtom[][]): AstAtom[][] {
  const out: AstAtom[][] = [];
  for (const clause of clauses) {
    if (clause.some((atom) => atom.k === 'const' && atom.value)) continue;
    const kept = clause.filter((atom) => atom.k !== 'const');
    if (kept.length === 0) return [[{ k: 'const', value: false }]];
    out.push(kept);
  }
  return out;
}

/** A deterministic key for an atom (caches; never shown). */
export function atomKey(atom: AstAtom): string {
  switch (atom.k) {
    case 'const':
      return atom.value ? 'T' : 'F';
    case 'range':
      return `r:${atom.leaf}:${atom.hasLo ? `${atom.loIncl ? '[' : '('}${atom.lo}` : '-'}:${atom.hasHi ? `${atom.hi}${atom.hiIncl ? ']' : ')'}` : '-'}`;
    case 'eq':
      return `e:${atom.leaf}:${atom.neg ? '!' : '='}${JSON.stringify(atom.value)}`;
    case 'in':
      return `i:${atom.leaf}:${atom.neg ? '!' : '='}${atom.values.length}`;
    case 'regex':
      return `x:${atom.leaf}:${JSON.stringify(atom.needle)}`;
  }
}
