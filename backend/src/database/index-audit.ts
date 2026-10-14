import type { Schema } from 'mongoose';

/**
 * Compares the indexes a shard ACTUALLY has against the hinted ones a schema
 * DECLARES (`lbr_*` / `bg_*` on `PositionSchema`), by name and full spec.
 *
 * Why the app checks this itself rather than trusting the migration script:
 *  - a hinted name that is MISSING at boot means `autoIndex` is about to build
 *    it on the primary (one collection scan per index per shard, during the
 *    deploy) — the migration's `--apply` did not run, or ran narrowed with
 *    `--shard` / `--skip-background`. Nothing can stop that from here, but it
 *    must not happen silently;
 *  - a hinted name that EXISTS WITH A DIFFERENT SPEC is worse: autoIndex's
 *    createIndex fails with IndexOptionsConflict (swallowed at boot), the wrong
 *    index stays, and every hint lands on it. A narrower partial filter returns
 *    incomplete pages with no error; a wrong collation turns a sort walk into a
 *    full scan. `withHint` cannot see either, so such an index is never hinted.
 *
 * The comparison mirrors `specDifferences` in
 * `scripts/positions-index-migration.mjs` (`test/index-audit.spec.ts` holds the
 * two to the same answers): key ORDER, collation after expanding ICU defaults,
 * partial filter, unique / sparse / TTL, and `hidden` (invisible to the planner
 * AND to hints, so for this purpose not present).
 */

export interface DeclaredIndex {
  name: string;
  key: Record<string, unknown>;
  collation?: Record<string, unknown>;
  partialFilterExpression?: Record<string, unknown>;
  unique?: boolean;
  sparse?: boolean;
}

/** One `listIndexes` entry, as the server reports it. */
export interface ExistingIndex {
  name: string;
  key: Record<string, unknown>;
  collation?: Record<string, unknown>;
  partialFilterExpression?: Record<string, unknown>;
  unique?: boolean;
  sparse?: boolean;
  expireAfterSeconds?: number;
  hidden?: boolean;
}

export interface IndexAudit {
  /** Declared hinted names the shard does not have. */
  missing: string[];
  /** Declared hinted names the shard has with a different spec — never hint these. */
  mismatched: Array<{ name: string; differences: string[] }>;
}

/** The hinted index names: Set R (`lbr_*`) and the background set (`bg_*`). */
export const HINTED_INDEX_NAME = /^(lbr|bg)_/;

/** Every NAMED index a schema declares whose name matches `pattern`. */
export function declaredNamedIndexes(schema: Schema, pattern: RegExp = HINTED_INDEX_NAME): DeclaredIndex[] {
  return declaredIndexes(schema)
    .filter((declared) => declared.named && pattern.test(declared.name))
    .map(({ named: _named, ...declared }) => declared);
}

/**
 * MongoDB's default name for an unnamed index: `<field>_<direction>` joined by
 * `_` (`{chainId: 1, protocol: 1, poolId: 1}` → `chainId_1_protocol_1_poolId_1`).
 */
export function generatedIndexName(key: Record<string, unknown>): string {
  return Object.entries(key)
    .map(([field, direction]) => `${field}_${String(direction)}`)
    .join('_');
}

/**
 * EVERY index a schema declares, named or not — an unnamed one under the name
 * MongoDB generates for it (`generatedIndexName`). `named` says which. With
 * autoIndex off on the shard collections (production), nothing builds a
 * declared index the shard lacks, so the boot pre-flight reports all of them,
 * not only the hinted ones.
 */
export function declaredIndexes(schema: Schema): Array<DeclaredIndex & { named: boolean }> {
  const out: Array<DeclaredIndex & { named: boolean }> = [];
  for (const [key, options] of schema.indexes() as Array<[Record<string, unknown>, Record<string, unknown> | undefined]>) {
    const explicit = options?.name;
    const named = typeof explicit === 'string';
    const declared: DeclaredIndex & { named: boolean } = { name: named ? explicit : generatedIndexName(key), key, named };
    if (options?.collation) declared.collation = options.collation as Record<string, unknown>;
    if (options?.partialFilterExpression) declared.partialFilterExpression = options.partialFilterExpression as Record<string, unknown>;
    if (options?.unique) declared.unique = true;
    if (options?.sparse) declared.sparse = true;
    out.push(declared);
  }
  return out;
}

const ICU_DEFAULTS = Object.freeze({
  caseLevel: false,
  caseFirst: 'off',
  strength: 3,
  numericOrdering: false,
  alternate: 'non-ignorable',
  maxVariable: 'punct',
  normalization: false,
  backwards: false,
});

/**
 * `listIndexes` reports the FULLY expanded collation plus a server `version`;
 * a declaration states two fields. Expand both the same way; simple → null.
 */
export function normalizeCollation(collation: Record<string, unknown> | undefined | null): Record<string, unknown> | null {
  if (!collation || collation.locale === 'simple') return null;
  const normalized: Record<string, unknown> = { locale: collation.locale };
  for (const [option, fallback] of Object.entries(ICU_DEFAULTS)) normalized[option] = collation[option] ?? fallback;
  return normalized;
}

/** Stable JSON with sorted object keys, for option objects whose key order carries no meaning. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

const keyDirection = (value: unknown): string => {
  const n = Number(value);
  return Number.isNaN(n) ? String(value) : String(n);
};

/** Key patterns are ORDERED: `{a:1,b:1}` and `{b:1,a:1}` are different indexes. */
export function sameKey(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): boolean {
  const ea = Object.entries(a ?? {});
  const eb = Object.entries(b ?? {});
  return ea.length === eb.length && ea.every(([field, dir], i) => eb[i]![0] === field && keyDirection(eb[i]![1]) === keyDirection(dir));
}

const formatKey = (key: Record<string, unknown> | undefined): string =>
  `{${Object.entries(key ?? {})
    .map(([field, dir]) => `${field}:${keyDirection(dir)}`)
    .join(', ')}}`;

/** How an existing index differs from its declaration; [] means identical. */
export function indexSpecDifferences(declared: DeclaredIndex, existing: ExistingIndex): string[] {
  const diffs: string[] = [];
  if (!sameKey(declared.key, existing.key)) diffs.push(`key ${formatKey(existing.key)} (want ${formatKey(declared.key)})`);
  const want = normalizeCollation(declared.collation);
  const have = normalizeCollation(existing.collation);
  if (canonical(want) !== canonical(have)) {
    diffs.push(`collation ${have ? canonical(have) : 'simple'} (want ${want ? canonical(want) : 'simple'})`);
  }
  if (canonical(existing.partialFilterExpression ?? null) !== canonical(declared.partialFilterExpression ?? null)) {
    diffs.push(
      `partialFilterExpression ${canonical(existing.partialFilterExpression ?? null)} (want ${canonical(declared.partialFilterExpression ?? null)})`,
    );
  }
  for (const option of ['unique', 'sparse'] as const) {
    if (Boolean(existing[option]) !== Boolean(declared[option])) diffs.push(`${option}=${Boolean(existing[option])}`);
  }
  if (existing.expireAfterSeconds !== undefined) diffs.push(`expireAfterSeconds=${existing.expireAfterSeconds}`);
  if (existing.hidden) diffs.push('hidden=true');
  return diffs;
}

/** Missing and mismatched declared indexes, by NAME (hints are by name). */
export function auditIndexes(declared: readonly DeclaredIndex[], existing: readonly ExistingIndex[]): IndexAudit {
  const audit: IndexAudit = { missing: [], mismatched: [] };
  for (const spec of declared) {
    const found = existing.find((ix) => ix.name === spec.name);
    if (!found) {
      audit.missing.push(spec.name);
      continue;
    }
    const differences = indexSpecDifferences(spec, found);
    if (differences.length > 0) audit.mismatched.push({ name: spec.name, differences });
  }
  return audit;
}
