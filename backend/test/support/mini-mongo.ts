/**
 * A tiny in-memory stand-in for a Mongoose model, for the deep-page exactness
 * specs. It implements ONLY what the read path sends, with MongoDB's own
 * semantics as measured on the M10 rig (MongoDB 8.0.32, `$documents` +
 * `$sort` / `$match`, 2026-10-03) — written independently of
 * `src/common/shard-merge.ts`, so a spec comparing the two is not comparing
 * the code with itself:
 *
 *  - sort order of mixed values: null = missing < NaN < numbers (−∞ … +∞) <
 *    strings < everything else;
 *  - `{f: null}` matches null AND missing; `{f: NaN}` matches NaN;
 *  - `$gt/$gte/$lt/$lte` are TYPE-BRACKETED: a number bound matches only
 *    non-NaN numbers, a string bound only strings, a NaN bound nothing
 *    (`{$lt: NaN}` and `{$gt: NaN}` matched nothing; `{$gte: -Infinity}`
 *    excluded NaN; `{$lt: 5}` excluded null and NaN);
 *  - `$ne: v` is NOT(eq), so missing matches `{$ne: 'none'}`;
 *  - under the `numericOrdering` collation digit strings compare by
 *    magnitude (`{p: {$gt: '9'}}` matched '10' and '100'); uncollated,
 *    binary (`{p: {$gt: '9'}}` matched nothing among digit strings) — UTF-8
 *    byte order, i.e. code-point order (not JavaScript's UTF-16 `<`);
 *  - (P-R R2) a `$regex` with flag `i` matches like JavaScript's `iu`
 *    (PCRE2 in UTF mode, simple case folding — design F3), NOT plain `i`;
 *    a pattern holding a `\u` escape (js-bson sends `\u2028` for U+2028)
 *    is REJECTED by PCRE2 (error 51091), and a NUL byte by js-bson — both
 *    throw here;
 *  - `countDocuments(filter, {limit})` counts at most `limit` (the 25k cap).
 *  - (P-R R3) string EQUALITY under the `numericOrdering` collation (`$eq`,
 *    `$ne`, `$in`, `$nin`, a literal), as measured on the rig with
 *    `$documents` + `$group` under the collation: C0 controls, DEL and ZWSP
 *    are ignorable (`'a\x01b' == 'ab'`); every maximal digit run compares by
 *    its NUMERIC value — leading zeros dropped, then chunked into 254-digit
 *    pieces (`'0x00a1' == '0x0a01'`, `'1' + '0'×254 + '5' == '1' + '0'×253 + '5'`,
 *    `'x' + '0'×254 + '1' == 'x1'`); case and every other character count
 *    (`'0x00A1' != '0x00a1'`, `'none' != 'NONE'`). Implemented here by
 *    tokenising with BigInt values — independently of the engine's ckey.
 */

export type Doc = Record<string, unknown>;

export interface MiniCall {
  op: 'find' | 'count';
  filter: Doc;
  opts: Record<string, unknown>;
}

function at(doc: unknown, path: string): unknown {
  let current: unknown = doc;
  for (const key of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function bracket(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number') return Number.isNaN(value) ? 1 : 2;
  if (typeof value === 'string') return 3;
  return 4;
}

function compareStrings(a: string, b: string, collated: boolean): number {
  if (collated && /^\d+$/.test(a) && /^\d+$/.test(b)) {
    // numericOrdering: by magnitude (leading-zero-free canonical decimals here)
    if (a.length !== b.length) return a.length < b.length ? -1 : 1;
  }
  if (!collated) return compareCodePoints(a, b);
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Binary (UTF-8 byte) order = code-point order. */
function compareCodePoints(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done || y.done) return x.done && y.done ? 0 : x.done ? -1 : 1;
    const cx = x.value.codePointAt(0)!;
    const cy = y.value.codePointAt(0)!;
    if (cx !== cy) return cx < cy ? -1 : 1;
  }
}

/** MongoDB's `$regex` on one value (PCRE2, UTF mode). */
export function mongoRegexTest(re: RegExp, value: unknown): boolean {
  if (/\\u/.test(re.source.replace(/\\\\/g, ''))) {
    throw Object.assign(new Error('Regular expression is invalid: PCRE2 does not support \\u'), { code: 51091 });
  }
  if (re.source.includes('\0')) throw new Error('value must not contain null bytes (js-bson)');
  if (typeof value !== 'string') return false;
  const flags = re.flags.includes('u') ? re.flags : `${re.flags}u`;
  return new RegExp(re.source, flags.replace('g', '')).test(value);
}

/** MongoDB's sort comparison of two values of one field. */
export function mongoCompare(a: unknown, b: unknown, collated: boolean): number {
  const ba = bracket(a);
  const bb = bracket(b);
  if (ba !== bb) return ba < bb ? -1 : 1;
  if (ba === 2) return (a as number) < (b as number) ? -1 : (a as number) > (b as number) ? 1 : 0;
  if (ba === 3) return compareStrings(a as string, b as string, collated);
  return 0;
}

/** Characters the collation ignores completely (rig: C0 controls, DEL, ZWSP). */
function icuIgnorable(code: number): boolean {
  return code < 0x20 || code === 0x7f || code === 0x200b;
}

/** The collation's comparison units of a string: single characters, and digit runs as numeric chunks. */
function icuTokens(s: string): Array<string | bigint> {
  const chars = [...s].filter((c) => !icuIgnorable(c.codePointAt(0)!));
  const out: Array<string | bigint> = [];
  for (let i = 0; i < chars.length; ) {
    if (!/[0-9]/.test(chars[i]!)) {
      out.push(chars[i]!);
      i++;
      continue;
    }
    let j = i;
    while (j < chars.length && /[0-9]/.test(chars[j]!)) j++;
    const run = chars.slice(i, j).join('').replace(/^0+/, '');
    if (run === '') out.push(0n);
    for (let k = 0; k < run.length; k += 254) out.push(BigInt(run.slice(k, k + 254)));
    i = j;
  }
  return out;
}

/** String equality under the leaderboard collation (`{locale: 'en', numericOrdering: true}`, tertiary). */
export function collatedEqual(a: string, b: string): boolean {
  const ta = icuTokens(a);
  const tb = icuTokens(b);
  if (ta.length !== tb.length) return false;
  return ta.every((t, i) => t === tb[i]);
}

function equal(value: unknown, expected: unknown, collated: boolean): boolean {
  if (expected === null) return value === null || value === undefined;
  if (typeof expected === 'number' && Number.isNaN(expected)) return typeof value === 'number' && Number.isNaN(value);
  if (typeof expected === 'string') {
    if (typeof value !== 'string') return false;
    return collated ? collatedEqual(value, expected) : compareStrings(value, expected, false) === 0;
  }
  if (expected instanceof Date) return value instanceof Date && value.getTime() === expected.getTime();
  return value === expected;
}

function compareBracketed(value: unknown, bound: unknown, collated: boolean): number | undefined {
  if (typeof bound === 'number') {
    if (Number.isNaN(bound)) return undefined;
    if (typeof value !== 'number' || Number.isNaN(value)) return undefined;
    return value < bound ? -1 : value > bound ? 1 : 0;
  }
  if (typeof bound === 'string') {
    if (typeof value !== 'string') return undefined;
    return compareStrings(value, bound, collated);
  }
  if (bound instanceof Date) {
    // Dates compare only with dates (their own BSON bracket).
    if (!(value instanceof Date)) return undefined;
    return value.getTime() < bound.getTime() ? -1 : value.getTime() > bound.getTime() ? 1 : 0;
  }
  return undefined;
}

function isOperatorObject(cond: unknown): cond is Record<string, unknown> {
  return (
    cond !== null &&
    typeof cond === 'object' &&
    !(cond instanceof RegExp) &&
    !Array.isArray(cond) &&
    Object.keys(cond).length > 0 &&
    Object.keys(cond).every((key) => key.startsWith('$'))
  );
}

function matchField(value: unknown, cond: unknown, collated: boolean): boolean {
  if (cond instanceof RegExp) return mongoRegexTest(cond, value);
  if (!isOperatorObject(cond)) return equal(value, cond, collated);
  for (const [op, arg] of Object.entries(cond)) {
    switch (op) {
      case '$eq':
        if (!equal(value, arg, collated)) return false;
        break;
      case '$ne':
        if (equal(value, arg, collated)) return false;
        break;
      case '$gt': {
        const c = compareBracketed(value, arg, collated);
        if (c === undefined || c <= 0) return false;
        break;
      }
      case '$gte': {
        const c = compareBracketed(value, arg, collated);
        if (c === undefined || c < 0) return false;
        break;
      }
      case '$lt': {
        const c = compareBracketed(value, arg, collated);
        if (c === undefined || c >= 0) return false;
        break;
      }
      case '$lte': {
        const c = compareBracketed(value, arg, collated);
        if (c === undefined || c > 0) return false;
        break;
      }
      case '$in':
        if (!(arg as unknown[]).some((v) => equal(value, v, collated))) return false;
        break;
      case '$nin':
        if ((arg as unknown[]).some((v) => equal(value, v, collated))) return false;
        break;
      case '$type':
        if (arg === 'string' ? typeof value !== 'string' : arg === 'number' ? typeof value !== 'number' : true) return false;
        break;
      case '$exists':
        // A field holding null EXISTS; only an absent one does not.
        if ((value !== undefined) !== Boolean(arg)) return false;
        break;
      case '$not':
        // MongoDB: true when the inner operator expression does NOT match (a missing field matches $not).
        if (matchField(value, arg, collated)) return false;
        break;
      default:
        throw new Error(`mini-mongo: unsupported operator ${op}`);
    }
  }
  return true;
}

export function matches(doc: Doc, filter: Doc, collated: boolean): boolean {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === '$and') {
      if (!(cond as Doc[]).every((clause) => matches(doc, clause, collated))) return false;
    } else if (key === '$or') {
      if (!(cond as Doc[]).some((clause) => matches(doc, clause, collated))) return false;
    } else if (!matchField(at(doc, key), cond, collated)) {
      return false;
    }
  }
  return true;
}

export function mongoSort(docs: Doc[], spec: Record<string, 1 | -1>, collated: boolean): Doc[] {
  const keys = Object.entries(spec);
  return [...docs].sort((a, b) => {
    for (const [key, dir] of keys) {
      const c = mongoCompare(at(a, key), at(b, key), collated);
      if (c !== 0) return c * dir;
    }
    return 0;
  });
}

function project(doc: Doc, projection: unknown): Doc {
  if (!projection || typeof projection !== 'object') return { ...doc };
  const spec = projection as Record<string, number>;
  const include = Object.entries(spec).filter(([key, v]) => v === 1 && key !== '_id');
  if (include.length === 0) return { ...doc };
  const out: Doc = {};
  for (const [path] of include) {
    const value = at(doc, path);
    if (value === undefined) continue;
    const keys = path.split('.');
    let target = out;
    for (const key of keys.slice(0, -1)) {
      target[key] = (target[key] as Doc | undefined) ?? {};
      target = target[key] as Doc;
    }
    target[keys[keys.length - 1]!] = value;
  }
  return out;
}

/**
 * A model over `docs`. `fail(call)` may return an error to throw for a call
 * (whole query), or `failAfter(call)` a row count after which the cursor's
 * next read throws (a getMore failure).
 */
export function miniModel(
  docs: Doc[],
  hooks: { fail?: (call: MiniCall) => unknown; failAfter?: (call: MiniCall) => number | undefined } = {},
) {
  const calls: MiniCall[] = [];
  const run = (call: MiniCall): Doc[] => {
    const error = hooks.fail?.(call);
    if (error) throw error;
    const collated = Boolean(call.opts.collation);
    let rows = docs.filter((doc) => matches(doc, call.filter, collated));
    if (call.opts.sort) rows = mongoSort(rows, call.opts.sort as Record<string, 1 | -1>, collated);
    const skip = (call.opts.skip as number | undefined) ?? 0;
    const limit = call.opts.limit as number | undefined;
    rows = rows.slice(skip, limit !== undefined ? skip + limit : undefined);
    return rows.map((doc) => project(doc, call.opts.select));
  };
  const query = (filter: Doc, projection?: unknown) => {
    const call: MiniCall = { op: 'find', filter, opts: projection ? { select: projection } : {} };
    calls.push(call);
    const q: Record<string, unknown> = {};
    for (const method of ['select', 'sort', 'collation', 'hint', 'skip', 'limit', 'read', 'maxTimeMS', 'batchSize']) {
      q[method] = (value: unknown) => {
        call.opts[method] = value;
        return q;
      };
    }
    q.lean = () => {
      const pending = Promise.resolve().then(() => run(call));
      return Object.assign(pending, {
        cursor: () => {
          let rows: Doc[] | undefined;
          let index = 0;
          const failAfter = hooks.failAfter?.(call);
          return {
            next: async () => {
              rows ??= await pending;
              if (failAfter !== undefined && index >= failAfter) {
                throw Object.assign(new Error('getMore failed'), { code: 50, codeName: 'MaxTimeMSExpired' });
              }
              return index < rows.length ? rows[index++]! : null;
            },
            close: async () => undefined,
          };
        },
      });
    };
    q.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve()
        .then(() => run(call))
        .then(resolve, reject);
    return q;
  };
  return {
    calls,
    model: {
      find: (filter: Doc, projection?: unknown) => query(filter, projection),
      countDocuments: (filter: Doc, options?: { limit?: number }) => {
        const call: MiniCall = { op: 'count', filter, opts: options?.limit !== undefined ? { limit: options.limit } : {} };
        calls.push(call);
        const q: Record<string, unknown> = {};
        for (const method of ['collation', 'hint', 'read', 'maxTimeMS']) {
          q[method] = (value: unknown) => {
            call.opts[method] = value;
            return q;
          };
        }
        q.exec = async () => {
          const error = hooks.fail?.(call);
          if (error) throw error;
          const n = docs.filter((doc) => matches(doc, filter, Boolean(call.opts.collation))).length;
          return options?.limit !== undefined && options.limit > 0 ? Math.min(n, options.limit) : n;
        };
        return q;
      },
    },
  };
}

/** A deterministic PRNG (mulberry32) for the property specs. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
