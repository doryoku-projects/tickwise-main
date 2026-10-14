import { compareSortValue } from '../../common/shard-merge.js';

/**
 * Lane A for the pool catalog (design §7.1): an engine answer compared with
 * MongoDB's answer to the SAME cast filter, read with `readConcern: snapshot`
 * at the answer's own clusterTime — so a difference is a logic difference,
 * never two reads of different moments.
 *
 * What is compared: the page's `(chainId, poolId)` in order, `hasMore`, and
 * each shard's capped count (`countDocuments({limit: cap})` semantics: the
 * count, and whether it reached the cap). All chains: each shard's first
 * `skip + limit + 1` rows merged exactly as the Mongo path merges them
 * (`compareSortValue` uncollated × direction, poolId, chainId).
 *
 * Sampled (`READ_MODELS_SHADOW_SAMPLE`), capped across processes
 * (`READ_MODELS_SHADOW_MAX_PER_MIN`), one check per bucket per minute, run
 * after the response, never altering it; reads held to their OWN budget
 * (`LaneABudget`, ≤ 2k docs/s — never the user read budget, and skipped while
 * that budget is under pressure), `maxTimeMS` 10 s, on a secondary; skipped (and counted) when
 * the server cannot read at the clusterTime, when it is more than 60 s old,
 * or when the estimated documents examined exceed 20k (the heavy buckets —
 * counted per bucket, EXEMPT from the rollout gate's lane-A coverage and
 * covered by lane B plus the rig parity scripts, `buckets.ts`).
 */

export const LANE_A_MAX_DOCS = 20_000;
export const LANE_A_MAX_AGE_MS = 60_000;
/** Lane A's own read rate (design §7.1 step 3, §15): documents examined per second. */
export const LANE_A_DOCS_PER_SEC = 2_000;

/**
 * Lane A's read budget: a token bucket of `LANE_A_DOCS_PER_SEC`, `burst` deep
 * (one heaviest check), refused rather than waited on. It takes NOTHING from
 * the user read budget (`ReadBudgetService`): a shadow check must never delay
 * a user's count or deep walk, or `shadow` would change responses.
 */
export class LaneABudget {
  private tokens: number;
  private at: number;

  constructor(
    readonly ratePerSec = LANE_A_DOCS_PER_SEC,
    readonly burst = LANE_A_MAX_DOCS,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.tokens = burst;
    this.at = this.now();
  }

  /** Take `docs` if the bucket holds them now; false (nothing taken) otherwise. */
  take(docs: number): boolean {
    const now = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.ratePerSec);
    this.at = now;
    if (docs > this.tokens) return false;
    this.tokens -= docs;
    return true;
  }
}

export interface PageEntry {
  chainId: number;
  poolId: string;
}

export interface LaneAnswer {
  entries: PageEntry[];
  hasMore: boolean;
  counts: Array<{ chainId: number; count: number; capped: boolean }>;
}

export interface ReferenceShard {
  chainId: number;
  rows: Array<{ poolId: unknown; value: unknown }>;
  count: number;
}

/** MongoDB's answer from per-shard reference reads (the Mongo path's merge, exactly). */
export function mongoLaneAnswer(
  shards: ReferenceShard[],
  args: { skip: number; limit: number; cap: number; sortDirection: 1 | -1; single: boolean },
): LaneAnswer {
  const counts = shards.map((s) => ({ chainId: s.chainId, count: s.count, capped: s.count >= args.cap }));
  if (args.single) {
    const rows = shards[0]?.rows ?? [];
    return {
      entries: rows.slice(0, args.limit).map((row) => ({ chainId: shards[0].chainId, poolId: String(row.poolId) })),
      hasMore: rows.length > args.limit,
      counts,
    };
  }
  const merged = shards
    .flatMap((s) => s.rows.map((row) => ({ chainId: s.chainId, row })))
    .sort((a, b) => {
      const primary = compareSortValue(a.row.value, b.row.value, false) * args.sortDirection;
      if (primary !== 0) return primary;
      const ap = a.row.poolId as string;
      const bp = b.row.poolId as string;
      const tie = ap < bp ? -1 : ap > bp ? 1 : 0;
      if (tie !== 0) return tie;
      return a.chainId - b.chainId;
    });
  return {
    entries: merged.slice(args.skip, args.skip + args.limit).map((m) => ({ chainId: m.chainId, poolId: String(m.row.poolId) })),
    hasMore: merged.length > args.skip + args.limit,
    counts,
  };
}

export interface LaneDiff {
  kind: 'ids' | 'order' | 'hasMore' | 'count';
  firstDiffIndex?: number;
  engine: unknown;
  mongo: unknown;
}

/** The first difference between two answers, or undefined. */
export function diffLaneAnswers(engine: LaneAnswer, mongo: LaneAnswer): LaneDiff | undefined {
  const key = (e: PageEntry) => `${e.chainId}:${e.poolId}`;
  const a = engine.entries.map(key);
  const b = mongo.entries.map(key);
  if (a.length !== b.length || a.some((id, i) => id !== b[i])) {
    const sameSet = a.length === b.length && [...a].sort().every((id, i) => id === [...b].sort()[i]);
    const first = a.findIndex((id, i) => id !== b[i]);
    const at = first < 0 ? Math.min(a.length, b.length) : first;
    return { kind: sameSet ? 'order' : 'ids', firstDiffIndex: at, engine: a.slice(at, at + 5), mongo: b.slice(at, at + 5) };
  }
  if (engine.hasMore !== mongo.hasMore) return { kind: 'hasMore', engine: engine.hasMore, mongo: mongo.hasMore };
  for (let i = 0; i < Math.max(engine.counts.length, mongo.counts.length); i++) {
    const e = engine.counts[i];
    const m = mongo.counts[i];
    if (!e || !m || e.chainId !== m.chainId || e.count !== m.count || e.capped !== m.capped) {
      return { kind: 'count', firstDiffIndex: i, engine: e ?? null, mongo: m ?? null };
    }
  }
  return undefined;
}

/** Search needle class for the bucket list (§7.1). */
export function searchClass(search: string | undefined): string {
  if (!search) return 'none';
  if (/[^\x00-\x7f]/.test(search)) return 'nonascii';
  if (/[.*+?^${}()|[\]\\]/.test(search)) return 'metachar';
  if (/^[0-9a-fx]+$/i.test(search)) return 'hex';
  return 'symbol';
}

const GRID_FLOORS = new Set([0, 10_000, 100_000, 1_000_000]);

/** The bucket of a pools check: sort class × search class × floor class × chains × kind. */
export function poolsBucket(args: { sort: string; search?: string; minTvlUsd: number; single: boolean; kind: 'shallow' | 'deep' | 'pastEnd' | 'count' }): string {
  const sortClass = args.sort === 'age' ? 'age' : 'numeric';
  const floor = Number(args.minTvlUsd);
  const floorClass = GRID_FLOORS.has(Number.isFinite(floor) && floor > 0 ? floor : 0) ? 'grid' : 'arbitrary';
  return `${sortClass}|${searchClass(args.search)}|${floorClass}|${args.single ? 'single' : 'all'}|${args.kind}`;
}

/** Documents a reference read would examine (find + count), from the engine's own counts. */
export function estimateReferenceDocs(
  shards: Array<{ live: number; matches: number; rangeRows: number }>,
  args: { skip: number; limit: number },
): number {
  let total = 0;
  for (const s of shards) {
    // Each shard's find reads its first skip + limit + 1 matches (a single
    // chain skips them server-side, all chains merge them here).
    const want = args.skip + args.limit + 1;
    const viaSort = s.matches > 0 ? Math.ceil((want * s.live) / s.matches) : s.live;
    total += Math.min(s.rangeRows, viaSort, s.live) + Math.min(s.rangeRows, s.live);
  }
  return total;
}

export class LaneAMeter {
  checks = 0;
  matches = 0;
  diffs = 0;
  readonly diffKinds: Record<string, number> = {};
  readonly skipped: Record<string, number> = {};
  readonly buckets = new Map<string, { checks: number; diffs: number; lastAt: number; heavy: number }>();
  readonly lastDiffs: Array<Record<string, unknown>> = [];

  /**
   * Count a skipped check. With `bucket`, a `heavy` skip is also counted on
   * the bucket: a bucket lane A keeps finding too heavy to check is EXEMPT
   * from the rollout gate's coverage (`buckets.ts`), not merely uncovered —
   * and, with `now`, it is not looked at again for a minute (`recent`), so a
   * heavy bucket costs at most one engine pass a minute.
   */
  skip(reason: string, bucket?: string, now?: number): void {
    this.skipped[reason] = (this.skipped[reason] ?? 0) + 1;
    if (bucket === undefined || reason !== 'heavy') return;
    const b = this.buckets.get(bucket) ?? { checks: 0, diffs: 0, lastAt: 0, heavy: 0 };
    b.heavy++;
    if (now !== undefined) b.lastAt = now;
    this.buckets.set(bucket, b);
  }

  record(bucket: string, diff: LaneDiff | undefined, detail: Record<string, unknown>, now: number): void {
    this.checks++;
    const b = this.buckets.get(bucket) ?? { checks: 0, diffs: 0, lastAt: 0, heavy: 0 };
    b.checks++;
    b.lastAt = now;
    if (diff) {
      this.diffs++;
      b.diffs++;
      this.diffKinds[diff.kind] = (this.diffKinds[diff.kind] ?? 0) + 1;
      this.lastDiffs.unshift({ at: new Date(now).toISOString(), bucket, ...detail, diff });
      if (this.lastDiffs.length > 20) this.lastDiffs.length = 20;
    } else this.matches++;
    this.buckets.set(bucket, b);
  }

  /** Was this bucket checked within `ms`? */
  recent(bucket: string, now: number, ms = 60_000): boolean {
    const b = this.buckets.get(bucket);
    return Boolean(b && now - b.lastAt < ms);
  }

  snapshot() {
    return {
      checks: this.checks,
      matches: this.matches,
      diffs: this.diffs,
      diffKinds: { ...this.diffKinds },
      skipped: { ...this.skipped },
      buckets: Object.fromEntries([...this.buckets].map(([k, v]) => [k, { checks: v.checks, diffs: v.diffs, ...(v.heavy > 0 ? { heavy: v.heavy } : {}) }])),
      lastDiffs: [...this.lastDiffs],
    };
  }
}
