/**
 * Deep list pages with no depth cap: a STREAMING k-way merge over per-shard
 * cursors, started from the nearest page-ladder rung.
 *
 * The window path (`listWindowRows`) serves every page within the top 1,000
 * rows from cached windows. Deeper, the all-chains merge used to read each
 * shard's top `page × limit` WHOLE documents (25k per shard at page 250 × 100:
 * ~40 MB on the wire, an event-loop block over a second, an OOM risk) and a
 * single-chain page used a Mongo `skip`. Here instead:
 *
 *  - each shard streams only its SORT KEYS (`{id, sortField}`), in its own
 *    Mongo order, in batches;
 *  - the k heads are merged in Node by the shard comparator then `chainId` —
 *    exactly the order the window merge produces;
 *  - rows before the page are COUNTED and dropped, never held; the page's
 *    `limit + 1` keys are kept and the caller fetches only those documents by
 *    id;
 *  - a walk can START from a recorded boundary (`seekSegments`), so a page
 *    near one already walked costs the distance from that boundary, not its
 *    offset;
 *  - the walk yields to the event loop every `yieldEvery` rows and reserves
 *    the global read budget before every `slice` rows.
 *
 * Exactness rests on two facts verified against MongoDB 8.0.32 (`$documents`
 * + `$sort` / `$match` on the M10 rig): the BSON order of mixed values in one
 * field is `null = missing < NaN < numbers (−∞ … +∞) < strings`
 * (`compareSortValue`), and the comparison operators are type-bracketed —
 * `{$lt: 5}` matches neither null nor NaN, `{$gte: -Infinity}` every number
 * but NaN, `{f: null}` null AND missing, `{f: NaN}` NaN. `seekSegments`
 * spells "strictly after the boundary" out of those brackets, one cursor per
 * bracket, so no row is skipped or repeated whatever mix the field holds.
 */
import { compareNumericString, compareSortValue, valueAtPath } from './shard-merge.js';

/** One shard's sort, as its Mongo query runs it. */
export interface SortSpec {
  /** Dotted path of the primary sort field. */
  field: string;
  direction: 1 | -1;
  /** The unique-per-shard id that breaks ties (`positionId` / `poolId`). */
  tieField: string;
  tieDirection: 1 | -1;
  /**
   * Strings compare like the leaderboard's `numericOrdering` collation (the
   * positions query) — or plain lexicographically (the uncollated pools one).
   */
  collated: boolean;
}

/** A merge boundary: the sort key of the LAST row before an offset, and its chain. */
export interface SortBoundary {
  value: unknown;
  id: string;
  chainId: number;
}

/**
 * The merged order of two rows on the same or different shards: the shard
 * comparator (field in BSON order × direction, then the id tie-break), then
 * `chainId` ascending — the same order the window merge sorts by.
 */
export function sortSpecComparator(spec: SortSpec): (a: unknown, b: unknown) => number {
  return (a, b) => {
    const byField = compareSortValue(valueAtPath(a, spec.field), valueAtPath(b, spec.field), spec.collated);
    if (byField !== 0) return byField * spec.direction;
    return compareIds(valueAtPath(a, spec.tieField), valueAtPath(b, spec.tieField), spec.collated) * spec.tieDirection;
  };
}

function compareIds(a: unknown, b: unknown, collated: boolean): number {
  if (collated) return Math.sign(compareNumericString(a, b));
  const as = String(a ?? '');
  const bs = String(b ?? '');
  return as < bs ? -1 : as > bs ? 1 : 0;
}

/** The value brackets of BSON order a sort field can hold, ascending. */
const BRACKETS = ['null', 'nan', 'number', 'string'] as const;
type Bracket = (typeof BRACKETS)[number];

/** The bracket of a boundary value; undefined for one no seek can express (an object, a boolean). */
export function sortBracket(value: unknown): Bracket | undefined {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isNaN(value) ? 'nan' : 'number';
  if (typeof value === 'string') return 'string';
  return undefined;
}

/**
 * Matches NaN and nothing else: NaN is a number but fails every comparison,
 * `$gte: -Infinity` included. Written this way because MongoDB accepts
 * `{field: NaN}` but Mongoose's Number caster REJECTS NaN ("Cast to Number
 * failed for value NaN") — a deep page seeking past a stored NaN (43114 has
 * rows with `metrics.poolPnlUsd: NaN`) answered HTTP 500 on the M10 rig.
 */
export const NAN_PREDICATE: Readonly<Record<string, unknown>> = Object.freeze({
  $type: 'number',
  $not: { $gte: -Infinity },
});

/** Every value of one bracket — each predicate type-bracketed exactly as MongoDB evaluates it. */
function bracketPredicate(field: string, bracket: Bracket): Record<string, unknown> {
  switch (bracket) {
    case 'null':
      return { [field]: null }; // null AND missing: they sort as one value
    case 'nan':
      return { [field]: { ...NAN_PREDICATE } };
    case 'number':
      return { [field]: { $gte: -Infinity } }; // ±Infinity included, NaN not
    case 'string':
      return { [field]: { $type: 'string' } };
  }
}

/**
 * The extra filters (each ANDed onto the shard's own filter, one cursor
 * each, run in this order) that list — in the shard's sort order — every row of
 * shard `chainId` strictly AFTER `boundary` in the merged order. `[undefined]`
 * (no extra filter) from the top.
 *
 * After a boundary `(v, id, cK)` come, in order:
 *  1. the rows with the SAME value and a later id. On a chain after `cK` the
 *     boundary's own `(v, id)` is after it too (the merge breaks that tie on
 *     `chainId`), so the id bound is inclusive there and strict everywhere
 *     else;
 *  2. the rows of v's bracket past v (`$gt` ascending, `$lt` descending —
 *     both type-bracketed, so this never reaches into another bracket);
 *  3. every later bracket whole, in sort order (ascending: the ones above v's,
 *     descending: the ones below, so a descending walk ends with NaN, then
 *     null/missing).
 * Throws for a boundary value outside every bracket — the ladder never
 * records one (`sortBracket`).
 */
export function seekSegments(
  spec: SortSpec,
  boundary: SortBoundary | null,
  chainId: number,
): Array<Record<string, unknown> | undefined> {
  if (!boundary) return [undefined];
  const bracket = sortBracket(boundary.value);
  if (!bracket) throw new Error(`seekSegments: unsupported boundary value for ${spec.field}`);
  const { field, tieField } = spec;
  const inclusive = chainId > boundary.chainId;
  const tieOp = spec.tieDirection > 0 ? (inclusive ? '$gte' : '$gt') : inclusive ? '$lte' : '$lt';
  const equal = bracket === 'null' ? null : bracket === 'nan' ? { ...NAN_PREDICATE } : boundary.value;
  const segments: Array<Record<string, unknown> | undefined> = [
    { [field]: equal, [tieField]: { [tieOp]: boundary.id } },
  ];
  if (bracket === 'number' || bracket === 'string') {
    segments.push({ [field]: { [spec.direction > 0 ? '$gt' : '$lt']: boundary.value } });
  }
  const at = BRACKETS.indexOf(bracket);
  const later = spec.direction > 0 ? BRACKETS.slice(at + 1) : BRACKETS.slice(0, at).reverse();
  for (const next of later) segments.push(bracketPredicate(field, next));
  return segments;
}

/** One shard's rows in its own sort order, one at a time. */
export interface MergeSource<R> {
  readonly chainId: number;
  /** The next row, or null once the shard has no more. */
  next(): Promise<R | null>;
  /** Releases the server cursor (idempotent). */
  close(): Promise<void>;
}

/** Where a walk starts: rows of the merged order before the sources' first row. */
export interface MergeStart {
  offset: number;
  /** Of those, per chain (absent = 0). */
  counts: Readonly<Record<number, number>>;
}

/** A boundary the walk passed: the row at index `offset − 1` and how many rows each chain had up to it. */
export interface MergeRung<R> {
  offset: number;
  row: R;
  chainId: number;
  counts: Record<number, number>;
}

export interface StreamMergeResult<R> {
  /** Rows `[skip, skip + take)` of the merged order (fewer at the end). */
  rows: Array<{ chainId: number; row: R }>;
  /** Shards that failed (dropped); the rows describe the merged order of the rest. */
  missingChains: number[];
  errors: Array<{ chainId: number; error: unknown }>;
  /** Every remaining shard ran dry before `take` rows were kept. */
  exhausted: boolean;
  /** Rows of the remaining shards up to and including the last one consumed. */
  position: number;
  /** Rows consumed by this walk. */
  walked: number;
}

/** Rows between budget reservations, and between event-loop yields. */
export const STREAM_SLICE_ROWS = 2_000;
export const STREAM_YIELD_ROWS = 1_000;
/** A rung is recorded every this many merged rows. */
export const LADDER_RUNG_EVERY = 1_000;

const yieldToLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * Merge `sources` (each already positioned after the start boundary) and keep
 * rows `[skip, skip + take)` of the merged order, counting and dropping every
 * row before `skip`.
 *
 * A source that throws — opening or mid-walk — is DROPPED (all-chains pages
 * answer `partial` rather than fail): its rows leave the count and the kept
 * page, the page re-anchors at `skip` of the remaining shards' order, and no
 * rung is recorded from then on (they would describe a different shard set).
 * Only when every source has failed does this throw (the first error).
 */
export async function streamMergePage<R>(args: {
  sources: Array<MergeSource<R>>;
  compare: (a: R, b: R) => number;
  start: MergeStart;
  skip: number;
  take: number;
  rungEvery?: number;
  /** Extra offsets to record a rung at (the served page's boundaries). */
  rungAt?: ReadonlySet<number>;
  onRung?: (rung: MergeRung<R>) => void;
  /** Awaited before the sources open and before every further `slice` rows consumed. */
  reserve?: (rows: number) => Promise<void>;
  /**
   * The database time this walk cost, settled against what it reserved:
   * called before every further reservation and once when the walk ends
   * (however it ends) with the milliseconds spent waiting on the sources since
   * the last call (summed per source, so shards read in parallel each count)
   * and the rows consumed meanwhile. A walk whose filter rejects most of what
   * the index hands it is cheap in rows and expensive in keys and documents
   * examined; time is what that costs, and what `ReadBudgetService.chargeTime`
   * repays.
   */
  charge?: (mongoMs: number, rows: number) => void;
  slice?: number;
  yieldEvery?: number;
  now?: () => number;
}): Promise<StreamMergeResult<R>> {
  const rungEvery = args.rungEvery ?? LADDER_RUNG_EVERY;
  const slice = Math.max(1, args.slice ?? STREAM_SLICE_ROWS);
  const yieldEvery = Math.max(1, args.yieldEvery ?? STREAM_YIELD_ROWS);
  const needed = Math.max(0, args.skip - args.start.offset) + args.take;
  const clock = args.now ?? Date.now;

  interface Live {
    source: MergeSource<R>;
    head: R | null;
    base: number;
    consumed: number;
  }
  const live: Live[] = [];
  const missingChains: number[] = [];
  const errors: Array<{ chainId: number; error: unknown }> = [];
  let kept: Array<{ chainId: number; row: R }> = [];
  let recording = true;
  let position = 0;
  let walked = 0;
  let exhausted = false;

  // Database time since the last settlement, and the rows consumed meanwhile.
  let mongoMs = 0;
  let chargedRows = 0;
  const timedNext = async (source: MergeSource<R>): Promise<R | null> => {
    const started = clock();
    try {
      return await source.next();
    } finally {
      mongoMs += Math.max(0, clock() - started);
    }
  };
  const settle = () => {
    if (!args.charge) return;
    const ms = mongoMs;
    const rows = walked - chargedRows;
    mongoMs = 0;
    chargedRows = walked;
    if (ms > 0 || rows > 0) args.charge(ms, rows);
  };

  let reserved = Math.min(slice, needed);
  await args.reserve?.(reserved);

  const drop = (entry: Live, error: unknown) => {
    const at = live.indexOf(entry);
    if (at >= 0) live.splice(at, 1);
    position -= entry.base + entry.consumed;
    missingChains.push(entry.source.chainId);
    errors.push({ chainId: entry.source.chainId, error });
    recording = false;
    kept = kept.filter((k) => k.chainId !== entry.source.chainId);
    // The kept rows sit at [position − kept, position) of the remaining
    // order; any now before `skip` belong to the counted prefix.
    const keptStart = position - kept.length;
    if (keptStart < args.skip) kept.splice(0, Math.min(kept.length, args.skip - keptStart));
    void entry.source.close().catch(() => undefined);
  };

  try {
    const heads = await Promise.allSettled(args.sources.map((source) => timedNext(source)));
    heads.forEach((head, i) => {
      const source = args.sources[i]!;
      const base = args.start.counts[source.chainId] ?? 0;
      if (head.status === 'fulfilled') {
        live.push({ source, head: head.value, base, consumed: 0 });
        position += base;
      } else {
        missingChains.push(source.chainId);
        errors.push({ chainId: source.chainId, error: head.reason });
        recording = false;
        void source.close().catch(() => undefined);
      }
    });
    if (live.length === 0) throw errors[0]?.error ?? new Error('streamMergePage: no sources');
    const ordered = (a: Live, b: Live) => args.compare(a.head!, b.head!) || a.source.chainId - b.source.chainId;

    while (kept.length < args.take) {
      // k is the number of enabled chains (a handful): a linear scan of the
      // heads is cheaper than keeping a heap.
      let min: Live | undefined;
      for (const entry of live) {
        if (entry.head !== null && (!min || ordered(entry, min) < 0)) min = entry;
      }
      if (!min) {
        exhausted = true;
        break;
      }
      const row = min.head!;
      const chainId = min.source.chainId;
      min.consumed++;
      position++;
      walked++;
      const index = position - 1;
      if (index >= args.skip) kept.push({ chainId, row });
      if (recording && args.onRung) {
        const offset = index + 1;
        if (offset % rungEvery === 0 || args.rungAt?.has(offset)) {
          const counts: Record<number, number> = {};
          for (const entry of live) counts[entry.source.chainId] = entry.base + entry.consumed;
          args.onRung({ offset, row, chainId, counts });
        }
      }
      if (args.reserve && walked >= reserved && walked < needed) {
        // What the last slice really cost first: a debt it ran up delays this reservation.
        settle();
        const more = Math.min(slice, needed - walked);
        await args.reserve(more);
        reserved += more;
      }
      if (walked % yieldEvery === 0) await yieldToLoop();
      try {
        min.head = await timedNext(min.source);
      } catch (err) {
        drop(min, err);
        if (live.length === 0) throw err;
      }
    }
    return { rows: kept, missingChains, errors, exhausted, position, walked };
  } finally {
    settle();
    await Promise.allSettled(live.map((entry) => entry.source.close()));
  }
}

/** A server cursor as the sources read it (Mongoose's `QueryCursor` fits). */
export interface RowCursor<T> {
  next(): Promise<T | null>;
  close(): Promise<unknown>;
}

/**
 * A shard source over `segments` (from `seekSegments`): one cursor per
 * segment, opened only once the previous ran dry, never reading more than
 * `needed` rows in total (no shard can contribute more to the page). `open`
 * returns the cursor with its first row already read, so a caller can retry
 * the open (e.g. without a missing hint) on the error that first read raises.
 */
export function segmentedSource<R>(
  chainId: number,
  segments: Array<Record<string, unknown> | undefined>,
  needed: number,
  open: (segment: Record<string, unknown> | undefined, limit: number) => Promise<{ cursor: RowCursor<R>; first: R | null }>,
): MergeSource<R> {
  let index = 0;
  let cursor: RowCursor<R> | undefined;
  let pending: { row: R | null } | undefined;
  let read = 0;
  let closed = false;
  const release = async () => {
    const current = cursor;
    cursor = undefined;
    if (current) await current.close().catch(() => undefined);
  };
  const close = async () => {
    closed = true;
    await release();
  };
  return {
    chainId,
    async next() {
      while (!closed) {
        if (read >= needed) {
          await close();
          return null;
        }
        if (!cursor) {
          if (index >= segments.length) {
            closed = true;
            return null;
          }
          const opened = await open(segments[index++], needed - read);
          cursor = opened.cursor;
          pending = { row: opened.first };
        }
        let row: R | null;
        if (pending) {
          row = pending.row;
          pending = undefined;
        } else {
          row = await cursor.next();
        }
        if (row === null) {
          await release();
          continue;
        }
        read++;
        return row;
      }
      return null;
    },
    close,
  };
}

/** A shard source over rows already sorted in memory (the uncollated shapes read every key anyway). */
export function arraySource<R>(chainId: number, rows: readonly R[]): MergeSource<R> {
  let index = 0;
  return {
    chainId,
    next: async () => (index < rows.length ? rows[index++]! : null),
    close: async () => {
      index = rows.length;
    },
  };
}

/** The rows of `sorted` strictly after `boundary` in the merged order (the in-memory twin of `seekSegments`). */
export function rowsAfter<R>(
  spec: SortSpec,
  sorted: readonly R[],
  boundary: SortBoundary | null,
  chainId: number,
): R[] {
  if (!boundary) return [...sorted];
  const compare = sortSpecComparator(spec);
  const pivot = { [spec.tieField]: boundary.id } as Record<string, unknown>;
  setAtPath(pivot, spec.field, boundary.value);
  return sorted.filter((row) => {
    const order = compare(row, pivot);
    return order > 0 || (order === 0 && chainId > boundary.chainId);
  });
}

function setAtPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let current = target;
  for (const key of keys.slice(0, -1)) {
    const next = (current[key] ?? {}) as Record<string, unknown>;
    current[key] = next;
    current = next;
  }
  current[keys[keys.length - 1]!] = value;
}

/** What a deep walk needs of the page ladder (`PageLadderService`). */
export interface LadderStore {
  /**
   * The deepest rung at or before `offset` anchored at most `maxAgeMs` ago —
   * by default the store's trust window (the staleness budget).
   */
  nearest(key: string, offset: number, maxAgeMs?: number): Promise<LadderRungLike | undefined>;
  record(key: string, rungs: LadderRungLike[]): void;
}

export interface LadderRungLike {
  offset: number;
  /**
   * When the row count before this rung was MEASURED (epoch ms): the start of
   * the walk from the top that counted it, INHERITED by every rung a later walk
   * derives from it — a rung is only as fresh as the prefix count it carries.
   * (Stamping a derived rung with the time it was recorded would renew a count
   * measured minutes ago on every sequential page.)
   */
  at: number;
  value: unknown;
  id: string;
  chainId: number;
  counts: Record<number, number>;
}

/** One shard of a deep walk. */
export interface DeepShard<R> {
  chainId: number;
  /** This shard's rows strictly after `boundary` (null: from the top), at most `needed` of them. */
  open(boundary: SortBoundary | null, needed: number): MergeSource<R>;
}

export interface DeepWalkResult<R> extends StreamMergeResult<R> {
  /** The offset the walk started from (0, or a rung's). */
  from: number;
  /**
   * When the page's offsets were measured (epoch ms): the start rung's anchor,
   * or this walk's own start when it walked from the top. Older than the
   * staleness budget only when the walk started from an AGED rung
   * (`agedMaxMs`); the caller then flags the page `stale` + `dataAsOf`.
   */
  anchorAt: number;
}

/**
 * Rungs buffered before they are written: a long walk publishes its progress
 * as it goes, so a retry — or a request arriving while a background walk is
 * still running — starts from where it has got to.
 */
export const LADDER_FLUSH_RUNGS = 16;

/**
 * One deep page: the nearest usable rung at or before `skip` (when a ladder is
 * given), a streaming merge from there, and the rungs it passes recorded for
 * the next walk (every `LADDER_RUNG_EVERY` rows and both edges of the served
 * page, so next/previous paging starts where this one ended).
 *
 *  - START: the deepest TRUSTED rung (the store's window, the staleness
 *    budget) or the top. When that is more than `freshReach` rows short of the
 *    page and `agedMaxMs` is given, a deeper rung up to `agedMaxMs` old is
 *    used instead and the result's `anchorAt` says how old its offsets are.
 *  - RECORDING: a rung is reported only while every shard is answering
 *    (`streamMergePage` stops at the first drop), so each one describes the
 *    full shard set exactly — and is recorded even when the walk later fails
 *    or runs out of its deadline. A walk that cannot reach a page within one
 *    deadline therefore still moves the ladder forward, and the retry starts
 *    from where it stopped instead of from the same place.
 *  - AGE: every rung inherits `anchorAt` (see `LadderRungLike.at`).
 */
export async function walkDeepPage<R>(args: {
  shards: Array<DeepShard<R>>;
  spec: SortSpec;
  skip: number;
  limit: number;
  ladder?: { store: LadderStore; key: string };
  reserve?: (rows: number) => Promise<void>;
  /** The walk's database time, settled against its reservations (see `streamMergePage`). */
  charge?: (mongoMs: number, rows: number) => void;
  /** Wraps the walk once its length (`needed` rows) is known — the caller's long-walk slot. */
  slot?: <T>(needed: number, run: () => Promise<T>) => Promise<T>;
  /**
   * Rows a walk from a trusted start may take before a deeper AGED rung is
   * preferred (only with `agedMaxMs`). Default: no limit.
   */
  freshReach?: number;
  /** How old a rung may be when no trusted start is within `freshReach`. Default: trusted rungs only. */
  agedMaxMs?: number;
  now?: () => number;
}): Promise<DeepWalkResult<R>> {
  const now = args.now ?? Date.now;
  const startedAt = now();
  const take = args.limit + 1;
  const chains = new Set(args.shards.map((shard) => shard.chainId));
  // A rung must lie at or before the page, describe exactly this shard set and
  // hold a boundary a seek can express: a store answering otherwise is ignored.
  const usable = (r: LadderRungLike | undefined): LadderRungLike | undefined =>
    r && r.offset <= args.skip && sameChains(r.counts, chains) && sortBracket(r.value) !== undefined ? r : undefined;
  const lookup = async (maxAgeMs?: number): Promise<LadderRungLike | undefined> => {
    try {
      return usable(await args.ladder!.store.nearest(args.ladder!.key, args.skip, maxAgeMs));
    } catch {
      return undefined; // an accelerator, never a dependency
    }
  };
  let rung: LadderRungLike | undefined;
  if (args.ladder) {
    rung = await lookup();
    const trustedFrom = rung?.offset ?? 0;
    if (args.agedMaxMs !== undefined && args.skip - trustedFrom > (args.freshReach ?? Infinity)) {
      const aged = await lookup(args.agedMaxMs);
      if (aged && aged.offset > trustedFrom) rung = aged;
    }
  }
  const anchorAt = rung ? Math.min(rung.at, startedAt) : startedAt;
  const start: MergeStart = rung ? { offset: rung.offset, counts: rung.counts } : { offset: 0, counts: {} };
  const boundary: SortBoundary | null = rung ? { value: rung.value, id: rung.id, chainId: rung.chainId } : null;
  const needed = args.skip - start.offset + take;
  const rungs: LadderRungLike[] = [];
  const flush = () => {
    if (!args.ladder || rungs.length === 0) return;
    const batch = rungs.splice(0, rungs.length);
    try {
      args.ladder.store.record(args.ladder.key, batch);
    } catch {
      // fire-and-forget
    }
  };
  const compare = sortSpecComparator(args.spec) as (a: R, b: R) => number;
  const firstWalk = () =>
    streamMergePage<R>({
      sources: args.shards.map((shard) => shard.open(boundary, needed)),
      compare,
      start,
      skip: args.skip,
      take,
      rungAt: new Set([args.skip, args.skip + args.limit].filter((offset) => offset > start.offset)),
      onRung: args.ladder
        ? (passed) => {
            const value = valueAtPath(passed.row, args.spec.field);
            if (!sortBracket(value)) return;
            rungs.push({
              offset: passed.offset,
              at: anchorAt,
              value: value ?? null,
              id: String(valueAtPath(passed.row, args.spec.tieField)),
              chainId: passed.chainId,
              counts: passed.counts,
            });
            if (rungs.length >= LADDER_FLUSH_RUNGS) flush();
          }
        : undefined,
      reserve: args.reserve,
      charge: args.charge,
      now,
    });
  const merge = async (): Promise<DeepWalkResult<R>> => {
    const result = await firstWalk();
    if (result.missingChains.length === 0 || start.offset === 0) return { ...result, from: start.offset, anchorAt };
    // A shard dropped on a walk that started from a rung: the page is now
    // `skip` of the OTHER shards' order, which starts below the rung (the
    // dropped shard's rows before it no longer count) — further than the
    // sources were capped to read. Walk the shards still answering again,
    // from the top. (From the top, `streamMergePage` re-anchors in place: no
    // single shard needs more than `skip + take` rows to reach the page.)
    const live = args.shards.filter((shard) => !result.missingChains.includes(shard.chainId));
    const again = await streamMergePage<R>({
      sources: live.map((shard) => shard.open(null, args.skip + take)),
      compare,
      start: { offset: 0, counts: {} },
      skip: args.skip,
      take,
      reserve: args.reserve,
      charge: args.charge,
      now,
    });
    return {
      ...again,
      missingChains: [...result.missingChains, ...again.missingChains],
      errors: [...result.errors, ...again.errors],
      walked: result.walked + again.walked,
      from: 0,
      anchorAt: startedAt,
    };
  };
  try {
    return args.slot ? await args.slot(needed, merge) : await merge();
  } finally {
    flush();
  }
}

/** The documents of a deep page's rows, as one shard set's fetch reports them. */
export interface DeepPageDocs<D> {
  docs: D[];
  missingChains: number[];
  errors: Array<{ chainId: number; error: unknown }>;
}

/**
 * The documents of a walked deep page, keeping the page the merged order of
 * exactly the chains it shows. A chain whose by-id fetch fails is asked once
 * more (a by-id read of ≤ 101 rows is cheap); if it fails again it is dropped
 * and the remaining chains are WALKED AGAIN from the top (`rewalk`), so the
 * page re-anchors on them — as a walk-time drop does — instead of keeping
 * holes: ranks numbered by position stay right, and `hasMore` / an exhausted
 * walk's total describe only the chains on the page. Throws only when no
 * chain is left.
 */
export async function fetchDeepPageDocs<R, D>(args: {
  walk: DeepWalkResult<R>;
  limit: number;
  /** The chains the walk spanned (before any of its own drops). */
  chains: number[];
  fetch: (rows: Array<{ chainId: number; row: R }>) => Promise<DeepPageDocs<D>>;
  rewalk: (chains: number[]) => Promise<DeepWalkResult<R>>;
}): Promise<{ docs: D[]; walk: DeepWalkResult<R>; missingChains: number[]; errors: Array<{ chainId: number; error: unknown }> }> {
  let walk = args.walk;
  const missing = new Set(walk.missingChains);
  const errors = [...walk.errors];
  for (;;) {
    const rows = walk.rows.slice(0, args.limit);
    let fetched = await args.fetch(rows);
    if (fetched.missingChains.length > 0) fetched = await args.fetch(rows);
    if (fetched.missingChains.length === 0) return { docs: fetched.docs, walk, missingChains: [...missing], errors };
    errors.push(...fetched.errors);
    for (const chainId of fetched.missingChains) missing.add(chainId);
    const live = args.chains.filter((chainId) => !missing.has(chainId));
    if (live.length === 0) throw errors[0]?.error ?? new Error('deep page: no chain left');
    walk = await args.rewalk(live);
    for (const chainId of walk.missingChains) missing.add(chainId);
    errors.push(...walk.errors);
  }
}

function sameChains(counts: Record<number, number>, chains: ReadonlySet<number>): boolean {
  const keys = Object.keys(counts);
  return keys.length === chains.size && keys.every((key) => chains.has(Number(key)));
}
