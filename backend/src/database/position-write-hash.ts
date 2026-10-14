import { createHash } from 'node:crypto';
import { stableJitter } from '../common/stable-jitter.js';

/*
 * P2.3 — skip unchanged position writes; write only the sections that moved.
 * Pure: no Nest, no Mongo, no clock (callers pass `nowMs`).
 *
 * A position's `$set` is split into SECTIONS. Each section gets a 64-bit hash
 * (the first 8 bytes of sha1 over a canonical JSON, below); the eight hashes
 * are stored together as `wh` (BinData, 8 × 8 bytes, an all-zero slot =
 * "unknown"), beside `wAt` (the last FULL write). On the next upsert a section
 * whose hash is unchanged is not written at all, a changed one is written as
 * leaves (today's whole-subdoc semantics, see `sectionLeafWrites`), and a row
 * with nothing changed is not written (`PositionsRepository.upsertMany`).
 *
 * What makes it safe:
 *  - the hash covers what MongoDB would STORE (declared leaves, defaults for
 *    the absent ones), so equal hashes mean an equal stored section;
 *  - every guard of design §4.2 rule 2 forces a full write (`fullWriteReason`);
 *  - a full write is forced every `POSITIONS_FORCED_REWRITE_MS` (6 h ± 25 %
 *    per position), so anything that slipped through (a writer that forgot to
 *    invalidate, a 2⁻⁶⁴ collision) is bounded;
 *  - every other writer of a hashed section `$unset`s `wh`.
 */

// ── Settings ─────────────────────────────────────────────────────────────────

/** `POSITIONS_WRITE_SKIP`: off = every row written on every upsert; shadow = decide + count, write as off (+ `wh`/`wAt`); on = skip (the configured default since 2026-10-07). */
export type WriteSkipMode = 'off' | 'shadow' | 'on';
/** `POSITIONS_WRITE_SKIP_AGE` (D-1): refresh = APR from the exact age; bucket = age in ≤ 1 % / ≤ 6 h steps (the configured default). */
export type WriteSkipAgeMode = 'refresh' | 'bucket';
/** `POSITIONS_WRITE_SKIP_TOLERANCE` (D-2): exact = any change writes; material = numbers hashed at 6 significant digits. */
export type WriteSkipTolerance = 'exact' | 'material';
/** `POSITIONS_GAS_REVALUE` (D-1b): always = gas re-valued at the current ETH price on every write; full-write = only on full writes (the configured default). */
export type GasRevalueMode = 'always' | 'full-write';

export interface WriteSkipSettings {
  mode: WriteSkipMode;
  age: WriteSkipAgeMode;
  tolerance: WriteSkipTolerance;
  gas: GasRevalueMode;
  /** Full-write interval (± `FORCED_REWRITE_JITTER` per position). */
  forcedRewriteMs: number;
  /** The same for a row whose stored and new value are both $0. */
  forcedRewriteZeroMs: number;
}

/**
 * The `AppConfigService` getters this package reads. Typed `unknown` and read
 * through `writeSkipSettings`, so a missing or garbage value is skip `off`
 * (every row written), never a crash. Names are the contract with the integrator's Zod
 * entries (`POSITIONS_WRITE_SKIP`, `…_AGE`, `…_TOLERANCE`,
 * `POSITIONS_GAS_REVALUE`, `POSITIONS_FORCED_REWRITE_MS`, `…_ZERO_MS`).
 */
export interface WriteSkipConfigSource {
  readonly positionsWriteSkip?: unknown;
  readonly positionsWriteSkipAge?: unknown;
  readonly positionsWriteSkipTolerance?: unknown;
  readonly positionsGasRevalue?: unknown;
  readonly positionsForcedRewriteMs?: unknown;
  readonly positionsForcedRewriteZeroMs?: unknown;
}

export const DEFAULT_FORCED_REWRITE_MS = 21_600_000;
export const DEFAULT_FORCED_REWRITE_ZERO_MS = 86_400_000;
/** ± spread of the forced-rewrite interval per position (`stableJitter`). */
export const FORCED_REWRITE_JITTER = 0.25;
/** Rows per read → decide → acquire → write chunk while skip is shadow/on. */
export const SKIP_CHUNK_OPS = 500;
/** Forced-rewrite floor: a configured interval below this reads as the default (a 0 would full-write every row). */
const MIN_FORCED_REWRITE_MS = 60_000;

export const WRITE_SKIP_OFF: WriteSkipSettings = Object.freeze({
  mode: 'off',
  age: 'refresh',
  tolerance: 'exact',
  gas: 'always',
  forcedRewriteMs: DEFAULT_FORCED_REWRITE_MS,
  forcedRewriteZeroMs: DEFAULT_FORCED_REWRITE_ZERO_MS,
});

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  if (typeof value !== 'string') return fallback;
  const v = value.trim().toLowerCase();
  return (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function interval(value: unknown, fallback: number): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= MIN_FORCED_REWRITE_MS ? Math.floor(n) : fallback;
}

/**
 * The settings. No source, or a value outside the allowed ones, reads as
 * `off` / `refresh` / `exact` / `always`: every row written, the safe side.
 * The shipped defaults (`on`, `bucket`, `full-write` since 2026-10-07) are the
 * Zod entries' in `AppConfigService`, which never hands a garbage value here.
 */
export function writeSkipSettings(src?: WriteSkipConfigSource | null): WriteSkipSettings {
  if (!src) return WRITE_SKIP_OFF;
  return {
    mode: oneOf(src.positionsWriteSkip, ['off', 'shadow', 'on'], 'off'),
    age: oneOf(src.positionsWriteSkipAge, ['refresh', 'bucket'], 'refresh'),
    tolerance: oneOf(src.positionsWriteSkipTolerance, ['exact', 'material'], 'exact'),
    gas: oneOf(src.positionsGasRevalue, ['always', 'full-write'], 'always'),
    forcedRewriteMs: interval(src.positionsForcedRewriteMs, DEFAULT_FORCED_REWRITE_MS),
    forcedRewriteZeroMs: interval(src.positionsForcedRewriteZeroMs, DEFAULT_FORCED_REWRITE_ZERO_MS),
  };
}

// ── Sections ─────────────────────────────────────────────────────────────────

/** Slot order in `wh`. Never reorder: stored hashes are read by index. */
export const SECTIONS = ['i', 'a', 'm', 't0', 't1', 'p', 'r', 'f'] as const;
export type Section = (typeof SECTIONS)[number];
export const SLOT_BYTES = 8;
export const WH_BYTES = SECTIONS.length * SLOT_BYTES; // 64

/** The subdocument behind each subdocument section. */
export const SUBDOC_OF = {
  a: 'amounts',
  m: 'metrics',
  t0: 'token0',
  t1: 'token1',
  p: 'poolStats',
  r: 'pricing',
} as const;
export type SubdocSection = keyof typeof SUBDOC_OF;
export type SubdocField = (typeof SUBDOC_OF)[SubdocSection];
export const SUBDOC_SECTIONS = Object.keys(SUBDOC_OF) as SubdocSection[];
export const SUBDOC_FIELDS = Object.values(SUBDOC_OF) as SubdocField[];

/** Section `i`: the top-level scalars, listed explicitly (a field added to `NormalizedPosition` is NOT silently hashed). */
export const IDENTITY_FIELDS = [
  'chainId',
  'protocol',
  'positionId',
  'tokenId',
  'owner',
  'poolId',
  'fee',
  'tickSpacing',
  'tickLower',
  'tickUpper',
  'currentTick',
  'sqrtPriceX96',
  'liquidity',
  'isActive',
  'createdAtTimestamp',
  'closedAtTimestamp',
  'lastModifyBlock',
] as const;

/** Section `f`: the P3.1 on-chain fee stamp — present only when a fresh reading is carried. */
export const STAMP_FIELDS = ['rpcFeesUncollected0', 'rpcFeesUncollected1', 'rpcFeesBlock', 'rpcFeesAt'] as const;

/**
 * Leaves left out of their section's hash: they move on every normalize and
 * are served through the read-time overlay instead (`served-clock-overlay.ts`).
 * They are still WRITTEN whenever their section is.
 */
export const HASH_EXCLUDED_LEAVES: Readonly<Partial<Record<SubdocField, readonly string[]>>> = {
  metrics: ['ageSeconds'],
  pricing: ['pricedAt'],
};

/**
 * Top-level `$set` fields outside every section: never hashed. `lastSyncedAt`
 * is written on every write; the rest only on full writes (`rawSubgraph` is
 * legacy — no longer written since 2026-10-06, `$unset` by every full write,
 * listed here so an object still carrying one is not an "unknown field";
 * `lastVerifiedAt` is write-only; `staleMisses` is 0 on every row
 * a section write may touch — rule 2; `tx*` belong to transaction sync).
 */
export const UNHASHED_FIELDS: ReadonlySet<string> = new Set([
  'lastSyncedAt',
  'lastVerifiedAt',
  'staleMisses',
  'rawSubgraph',
  'wh',
  'wAt',
  'createdAt',
  'updatedAt',
  'revertMetrics',
  'txSyncStatus',
  'txLastAttemptAt',
  'txLastSuccessAt',
  'txSyncedTransactionCount',
  'txFinalizedAt',
  'txLastFailureAt',
  'txLastError',
]);

const IDENTITY_SET: ReadonlySet<string> = new Set(IDENTITY_FIELDS);
const STAMP_SET: ReadonlySet<string> = new Set(STAMP_FIELDS);
const SUBDOC_SECTION_OF: ReadonlyMap<string, SubdocSection> = new Map(
  SUBDOC_SECTIONS.map((s) => [SUBDOC_OF[s], s] as const),
);

/** Which section a top-level `$set` field belongs to; `unhashed`; or `null` = unknown (forces a full write). */
export function sectionOfField(field: string): Section | 'unhashed' | null {
  if (IDENTITY_SET.has(field)) return 'i';
  if (STAMP_SET.has(field)) return 'f';
  const sub = SUBDOC_SECTION_OF.get(field);
  if (sub) return sub;
  if (UNHASHED_FIELDS.has(field)) return 'unhashed';
  return null;
}

// ── Declared leaves (the schema's view of each subdocument) ─────────────────

export interface DeclaredLeaf {
  name: string;
  /** Present when the schema declares a default (absent leaf → this value, as a whole-subdoc `$set` would store). */
  defaultValue?: () => unknown;
}
export type DeclaredLeaves = Readonly<Record<SubdocField, readonly DeclaredLeaf[]>>;

/** The part of a Mongoose `Schema` / `SchemaType` this reads (specs pass the real `PositionSchema`). */
interface SchemaLike {
  path(name: string): unknown;
}

/**
 * The first-level leaves the schema declares under each subdocument section,
 * with their defaults. A nested subdocument (`metrics.usd`) is ONE leaf:
 * written whole, cast by Mongoose exactly as today. `_id` is never a leaf.
 */
export function declaredLeavesOf(schema: SchemaLike): DeclaredLeaves {
  const out = {} as Record<SubdocField, DeclaredLeaf[]>;
  for (const field of SUBDOC_FIELDS) {
    const sub = (schema.path(field) as { schema?: { paths?: Record<string, unknown> } } | undefined)?.schema;
    const paths = sub?.paths ?? {};
    const seen = new Set<string>();
    const leaves: DeclaredLeaf[] = [];
    for (const key of Object.keys(paths)) {
      const name = key.split('.')[0]!;
      if (name === '_id' || seen.has(name)) continue;
      seen.add(name);
      const type = paths[name] as { defaultValue?: unknown } | undefined;
      const def = type?.defaultValue;
      leaves.push(
        def === undefined
          ? { name }
          : { name, defaultValue: typeof def === 'function' ? (def as () => unknown) : () => cloneDefault(def) },
      );
    }
    out[field] = leaves;
  }
  return out;
}

function cloneDefault(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(cloneDefault);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = cloneDefault(v);
  return out;
}

// ── Canonical JSON + hash ────────────────────────────────────────────────────

export interface HashOptions {
  /** D-2: numbers at 6 significant digits. */
  material?: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function numberToken(n: number, material: boolean): string {
  if (Number.isNaN(n)) return 'NaN';
  if (n === Number.POSITIVE_INFINITY) return 'Inf';
  if (n === Number.NEGATIVE_INFINITY) return '-Inf';
  if (Object.is(n, -0) || n === 0) return '0';
  return material ? Number(n.toPrecision(6)).toString() : n.toString();
}

function bytesOf(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (value && typeof value === 'object') {
    // BSON `Binary` (what a `.lean()` read returns): `buffer` + `position`.
    const b = (value as { buffer?: unknown }).buffer;
    if (b instanceof Uint8Array && (value as { _bsontype?: unknown })._bsontype === 'Binary') {
      const pos = (value as { position?: unknown }).position;
      return typeof pos === 'number' && pos >= 0 && pos <= b.length ? b.subarray(0, pos) : b;
    }
  }
  return null;
}

/**
 * A stable text form: object keys sorted, `undefined` dropped (a key that
 * MongoDB would not store), `null` kept, `-0` = `0`, NaN / ±Infinity as bare
 * tokens (a string is always quoted, so nothing collides), a Date as `D<ms>`,
 * bytes as `B<hex>`, numbers via `Number.prototype.toString`.
 */
export function canonicalJson(value: unknown, opts: HashOptions = {}): string {
  const material = opts.material === true;
  const walk = (v: unknown): string => {
    if (v === null || v === undefined) return 'null';
    switch (typeof v) {
      case 'number':
        return numberToken(v, material);
      case 'string':
        return JSON.stringify(v);
      case 'boolean':
        return v ? 'true' : 'false';
      case 'bigint':
        return `${v.toString()}n`;
      default:
        break;
    }
    if (v instanceof Date) {
      const ms = v.getTime();
      return Number.isFinite(ms) ? `D${ms}` : 'Dnull';
    }
    const bytes = bytesOf(v);
    if (bytes) return `B${Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('hex')}`;
    if (Array.isArray(v)) return `[${v.map(walk).join(',')}]`;
    const hex = (v as { toHexString?: unknown }).toHexString;
    if (typeof hex === 'function') return `O${String((hex as () => string).call(v))}`;
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${walk(obj[k])}`).join(',')}}`;
  };
  return walk(value);
}

const ZERO_SLOT = Buffer.alloc(SLOT_BYTES);

/** First 8 bytes of sha1(canonical). Never all-zero (that pattern means "unknown slot"). */
export function sectionHash(value: unknown, opts: HashOptions = {}): Buffer {
  const out = Buffer.from(createHash('sha1').update(canonicalJson(value, opts)).digest().subarray(0, SLOT_BYTES));
  if (out.equals(ZERO_SLOT)) out[SLOT_BYTES - 1] = 1;
  return out;
}

/** 64 bytes, a missing / null slot written as zeros. */
export function encodeWh(slots: ReadonlyArray<Buffer | null | undefined>): Buffer {
  const out = Buffer.alloc(WH_BYTES);
  SECTIONS.forEach((_, i) => {
    const slot = slots[i];
    if (slot && slot.length === SLOT_BYTES) slot.copy(out, i * SLOT_BYTES);
  });
  return out;
}

/**
 * The stored `wh` as slots (null = unknown), or `null` when it is missing or
 * not exactly 64 bytes (a value this build did not write: treat the row as
 * unhashed). Accepts a Buffer / Uint8Array or the BSON `Binary` a lean read returns.
 */
export function decodeWh(raw: unknown): Array<Buffer | null> | null {
  const bytes = bytesOf(raw);
  if (!bytes || bytes.byteLength !== WH_BYTES) return null;
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return SECTIONS.map((_, i) => {
    const slot = Buffer.from(buf.subarray(i * SLOT_BYTES, (i + 1) * SLOT_BYTES));
    return slot.equals(ZERO_SLOT) ? null : slot;
  });
}

// ── Section values ───────────────────────────────────────────────────────────

/**
 * The value a section's hash is taken over, as MongoDB would STORE it:
 *  - `i` / `f`: the present (not `undefined`) top-level fields of the section;
 *  - a subdocument: its declared leaves — present ones as given, absent ones
 *    with a default as that default, the rest absent — minus
 *    `HASH_EXCLUDED_LEAVES`. Undeclared keys are left out: Mongoose's strict
 *    mode drops them on write (`token*.priceConfidence` is not declared).
 *    A section value that is not a plain object (null, …) is hashed as is.
 * `undefined` = the section is absent from this update (not written, today
 * keeps the stored value).
 */
export function sectionValue(
  set: Readonly<Record<string, unknown>>,
  section: Section,
  declared?: DeclaredLeaves,
): unknown {
  if (section === 'i' || section === 'f') {
    const fields = section === 'i' ? IDENTITY_FIELDS : STAMP_FIELDS;
    const out: Record<string, unknown> = {};
    let any = false;
    for (const field of fields) {
      if (set[field] === undefined) continue;
      out[field] = set[field];
      any = true;
    }
    return any ? out : undefined;
  }
  const field = SUBDOC_OF[section];
  const value = set[field];
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) return value;
  const excluded = HASH_EXCLUDED_LEAVES[field] ?? [];
  const leaves = declared?.[field];
  const out: Record<string, unknown> = {};
  if (!leaves) {
    for (const [k, v] of Object.entries(value)) if (!excluded.includes(k) && v !== undefined) out[k] = v;
    return out;
  }
  for (const leaf of leaves) {
    if (excluded.includes(leaf.name)) continue;
    const v = value[leaf.name];
    if (v !== undefined) out[leaf.name] = v;
    else if (leaf.defaultValue) out[leaf.name] = leaf.defaultValue();
  }
  return out;
}

/** Every section's value (see `sectionValue`) plus the top-level fields no section knows. */
export function sectionValues(
  set: Readonly<Record<string, unknown>>,
  declared?: DeclaredLeaves,
): { values: Partial<Record<Section, unknown>>; unknownFields: string[] } {
  const values: Partial<Record<Section, unknown>> = {};
  for (const section of SECTIONS) {
    const v = sectionValue(set, section, declared);
    if (v !== undefined) values[section] = v;
  }
  const unknownFields: string[] = [];
  for (const [field, v] of Object.entries(set)) {
    if (v === undefined) continue;
    if (sectionOfField(field) === null) unknownFields.push(field);
  }
  return { values, unknownFields };
}

/** Hash options per section: `material` never applies to identity/ticks/blocks or the fee stamp. */
function optsFor(section: Section, tolerance: WriteSkipTolerance): HashOptions {
  return { material: tolerance === 'material' && section !== 'i' && section !== 'f' && section !== 'r' };
}

export interface SectionDiff {
  /** The `wh` to store after this write: new hashes for present sections, the stored slot for absent ones. */
  slots: Array<Buffer | null>;
  /** Present sections whose hash differs from the stored slot (all present ones when `previous` is null). */
  changed: Section[];
  /** Sections present in this update. */
  present: Section[];
}

/** Hash every present section and compare with the stored slots (`previous` null = nothing known). */
export function diffSections(
  values: Partial<Record<Section, unknown>>,
  previous: ReadonlyArray<Buffer | null> | null,
  tolerance: WriteSkipTolerance = 'exact',
): SectionDiff {
  const slots: Array<Buffer | null> = [];
  const changed: Section[] = [];
  const present: Section[] = [];
  SECTIONS.forEach((section, i) => {
    const prev = previous?.[i] ?? null;
    if (!(section in values)) {
      slots.push(prev);
      return;
    }
    present.push(section);
    const hash = sectionHash(values[section], optsFor(section, tolerance));
    slots.push(hash);
    if (!prev || !prev.equals(hash)) changed.push(section);
  });
  return { slots, changed, present };
}

// ── Decision (design §4.2 rule 2) ────────────────────────────────────────────

export type FullWriteReason =
  | 'insert'
  | 'stale-misses'
  | 'active-flip'
  | 'no-hash'
  | 'forced'
  | 'legacy-shape'
  | 'unknown-field';

/** What upsertMany read about the stored row (`findExistingStates`). */
export interface StoredWriteState {
  isActive?: boolean;
  staleMisses?: number;
  wh?: unknown;
  wAt?: unknown;
  /**
   * Stored `lastVerifiedAt`. Every hashed full write sets it and `wAt` from the
   * same clock; section writes set neither; the stale sweep sets it and drops
   * `wh`. Later than `wAt` = a full write by a writer that does not know `wh`
   * (a rollback to a pre-P2.3 image) changed the row and left `wh` describing
   * what it overwrote.
   */
  lastVerifiedAt?: unknown;
  /** Stored `metrics.underlyingValueUsd`. */
  underlyingValueUsd?: number;
  /** BSON `$type` of each stored subdocument ('object', 'null', 'missing', …), when the read asked for it. */
  sectionTypes?: Partial<Record<SubdocField, unknown>>;
}

export interface NextWriteState {
  positionId: string;
  isActive: boolean;
  underlyingValueUsd: number;
  /** The new update's subdocument values (only whether each is a plain object matters). */
  set: Readonly<Record<string, unknown>>;
  unknownFields: readonly string[];
}

/** The per-position forced-rewrite interval (`stableJitter`, salted so it does not move in step with the fee restamp). */
export function forcedRewriteIntervalMs(positionId: string, bothZero: boolean, settings: WriteSkipSettings): number {
  const base = bothZero ? settings.forcedRewriteZeroMs : settings.forcedRewriteMs;
  return base * stableJitter(`wskip:${positionId}`, FORCED_REWRITE_JITTER);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function timeOf(value: unknown): number | undefined {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
}

/**
 * The reason this row must be written WHOLE (today's update + `wh` + `wAt`,
 * upsert), or `null` when sections may be compared (design §4.2 rules 1–2).
 */
export function fullWriteReason(
  previous: StoredWriteState | undefined,
  next: NextWriteState,
  nowMs: number,
  settings: WriteSkipSettings,
): FullWriteReason | null {
  if (!previous) return 'insert';
  if ((finiteNumber(previous.staleMisses) ?? 0) > 0) return 'stale-misses';
  if (previous.isActive !== next.isActive) return 'active-flip';
  if (next.unknownFields.length > 0) return 'unknown-field';
  if (!decodeWh(previous.wh)) return 'no-hash';
  const wAt = timeOf(previous.wAt);
  if (wAt === undefined) return 'no-hash';
  const verifiedAt = timeOf(previous.lastVerifiedAt);
  if (verifiedAt !== undefined && verifiedAt > wAt) return 'no-hash';
  const bothZero = previous.underlyingValueUsd === 0 && next.underlyingValueUsd === 0;
  if (nowMs - wAt >= forcedRewriteIntervalMs(next.positionId, bothZero, settings)) return 'forced';
  for (const field of SUBDOC_FIELDS) {
    if (!isPlainObject(next.set[field])) continue;
    const stored = previous.sectionTypes?.[field];
    // Unknown (not read) or an object / no field at all: a leaf `$set` works.
    // Anything else (null, an array, a scalar) would refuse it (code 28).
    if (stored === undefined || stored === 'object' || stored === 'missing') continue;
    return 'legacy-shape';
  }
  return null;
}

// ── Leaf writes ──────────────────────────────────────────────────────────────

/**
 * Today's whole-subdoc `$set` of `field`, expressed as leaves. Mongoose casts
 * a whole-subdoc `$set` (`raw()` subdocuments are single-nested): every
 * declared leaf the value lacks is stored as its DEFAULT, or removed when it
 * has none, and undeclared keys are dropped. So: every present leaf is `$set`;
 * a declared leaf it lacks is `$set` to its default, else `$unset`. A nested
 * subdocument (`metrics.usd`) is one leaf, cast whole. A value that is not a
 * plain object is written whole (`$set: {field: value}`).
 */
export function sectionLeafWrites(
  field: SubdocField,
  value: unknown,
  declared: DeclaredLeaves,
  set: Record<string, unknown>,
  unset: Record<string, ''>,
): void {
  if (!isPlainObject(value)) {
    set[field] = value;
    return;
  }
  const leaves = declared[field] ?? [];
  const known = new Set<string>();
  for (const leaf of leaves) {
    known.add(leaf.name);
    const v = value[leaf.name];
    if (v !== undefined) set[`${field}.${leaf.name}`] = v;
    else if (leaf.defaultValue) set[`${field}.${leaf.name}`] = leaf.defaultValue();
    else unset[`${field}.${leaf.name}`] = '';
  }
  // Undeclared keys go out as given: strict mode drops them on this write
  // exactly as it does on a whole-subdoc one.
  for (const [k, v] of Object.entries(value)) {
    if (!known.has(k) && v !== undefined && k !== '_id') set[`${field}.${k}`] = v;
  }
}

/** The `$set` / `$unset` of a section write: the changed sections' leaves. */
export function sectionUpdateParts(
  fullSet: Readonly<Record<string, unknown>>,
  changed: readonly Section[],
  declared: DeclaredLeaves,
): { set: Record<string, unknown>; unset: Record<string, ''> } {
  const set: Record<string, unknown> = {};
  const unset: Record<string, ''> = {};
  for (const section of changed) {
    if (section === 'i' || section === 'f') {
      for (const field of section === 'i' ? IDENTITY_FIELDS : STAMP_FIELDS) {
        if (fullSet[field] !== undefined) set[field] = fullSet[field];
      }
      continue;
    }
    const field = SUBDOC_OF[section];
    if (fullSet[field] === undefined) continue;
    sectionLeafWrites(field, fullSet[field], declared, set, unset);
  }
  return { set, unset };
}

// ── Clock inputs (design §4.3) ───────────────────────────────────────────────

/** Largest step `bucketAgeSeconds` moves in (6 h). */
export const AGE_BUCKET_MAX_STEP_SEC = 21_600;

/**
 * D-1 (`POSITIONS_WRITE_SKIP_AGE=bucket`): the age the annualised fields are
 * computed from, rounded DOWN to a power-of-two step ≤ 1 % of the age and
 * ≤ 6 h — so APR is ≤ 1 % relative / ≤ 6 h behind, and moves (rewriting `m`)
 * once per step instead of on every refresh.
 */
export function bucketAgeSeconds(ageSeconds: number): number {
  if (!Number.isFinite(ageSeconds) || ageSeconds <= 0) return ageSeconds;
  const target = ageSeconds / 100;
  let step = 1;
  while (step * 2 <= target && step * 2 <= AGE_BUCKET_MAX_STEP_SEC) step *= 2;
  return Math.floor(ageSeconds / step) * step;
}

// ── Gas (D-1b) ───────────────────────────────────────────────────────────────

/**
 * The ETH price implied by the stored gas valuation (`metrics.totalGasCostUsd`
 * ÷ `amounts.totalGasCostEth`), or undefined when either is not positive. With
 * `POSITIONS_GAS_REVALUE=full-write` a non-full write values gas at this, so
 * the gas leaves (and `pnlHodl`/`roi`/`apr` through them) move only when a
 * full write re-values them. For an unchanged `totalGasCostEth`,
 * `eth × (usd ÷ eth)` reproduces the stored USD bit for bit.
 */
export function storedImpliedEthPrice(storedGasUsd: unknown, storedGasEth: unknown): number | undefined {
  const usd = typeof storedGasUsd === 'number' ? storedGasUsd : Number(storedGasUsd);
  const eth = typeof storedGasEth === 'number' ? storedGasEth : Number(storedGasEth);
  // eth ≤ 0 is refused here (−usd ÷ −eth would read positive); usd ≤ 0 by the `price > 0` below.
  if (!Number.isFinite(usd) || !Number.isFinite(eth) || eth <= 0) return undefined;
  const price = usd / eth;
  return Number.isFinite(price) && price > 0 ? price : undefined;
}

// ── Reporting ────────────────────────────────────────────────────────────────

/** `metrics.underlyingValueUsd` bucket for the skip-rate breakdown. */
export function valueBucket(usd: unknown): string {
  const v = typeof usd === 'number' && Number.isFinite(usd) ? usd : 0;
  if (v <= 0) return '0';
  if (v < 100) return '<100';
  if (v < 1_000) return '<1k';
  if (v < 10_000) return '<10k';
  if (v < 100_000) return '<100k';
  return '>=100k';
}

const POOL_STATE_I = new Set(['currentTick', 'sqrtPriceX96', 'liquidity']);
const FEE_M = new Set(['pendingFeesUsd', 'totalFeesUsd', 'feesSource', 'feesMeasuredAt', 'feeApr']);
const GAS_M = new Set(['totalGasCostUsd']);
const AGE_M = new Set(['apr', 'aprExGas', 'poolApr', 'aprWarmup']);
const FEE_A = new Set(['totalFeesUncollected0', 'totalFeesUncollected1', 'totalFeesUncollectedUsd']);
const GAS_A = new Set(['totalGasCostUsd']);

/**
 * Shadow's "why was this section written": the reason tags of the leaves that
 * differ between the stored section and the new one (both as `sectionValue`
 * would hash them). Tags: `pool-state` (i.currentTick/sqrtPriceX96/liquidity,
 * m.inRange), `identity`, `fees`, `gas`, `apr-age`, `value` (other metrics),
 * `amounts`, `token-price`, `token-meta`, `pool-stats`, `pricing` (pricedAt
 * excluded), `fee-stamp`.
 */
export function changeReasons(section: Section, stored: unknown, next: unknown): string[] {
  if (section === 'f') return ['fee-stamp'];
  if (section === 'p') return ['pool-stats'];
  if (section === 'r') return ['pricing'];
  if (!isPlainObject(stored) || !isPlainObject(next)) return [section === 'i' ? 'identity' : sectionTag(section)];
  const tags = new Set<string>();
  const keys = new Set([...Object.keys(stored), ...Object.keys(next)]);
  for (const key of keys) {
    if (canonicalJson(stored[key]) === canonicalJson(next[key])) continue;
    tags.add(leafTag(section, key));
  }
  return tags.size > 0 ? [...tags] : [sectionTag(section)];
}

function sectionTag(section: Section): string {
  switch (section) {
    case 'a':
      return 'amounts';
    case 'm':
      return 'value';
    case 't0':
    case 't1':
      return 'token-meta';
    default:
      return 'identity';
  }
}

function leafTag(section: Section, key: string): string {
  switch (section) {
    case 'i':
      return POOL_STATE_I.has(key) ? 'pool-state' : 'identity';
    case 'm':
      if (key === 'inRange') return 'pool-state';
      if (FEE_M.has(key)) return 'fees';
      if (GAS_M.has(key)) return 'gas';
      if (AGE_M.has(key)) return 'apr-age';
      return 'value';
    case 'a':
      if (FEE_A.has(key)) return 'fees';
      if (GAS_A.has(key)) return 'gas';
      return 'amounts';
    case 't0':
    case 't1':
      return key === 'priceUsd' ? 'token-price' : 'token-meta';
    default:
      return sectionTag(section);
  }
}
