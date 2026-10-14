import { compareNumericString, compareSortValue } from '../../common/shard-merge.js';

/**
 * Lane A for the rank engine (design §7.1, P-R R3): an engine answer compared
 * with MongoDB's answer to the SAME cast filter, read with `readConcern:
 * snapshot` at the answer's own clusterTime (`PositionsRepository
 * .snapshotReference`) — a difference is a logic difference, never two reads
 * of different moments.
 *
 * Compared: the page's `(chainId, positionId)` in order, `hasMore`, and each
 * shard's count — capped like `countDocuments({limit: cap})` for the collated
 * shapes, the exact match count for the uncollated ones (whose pages carry
 * it). All chains: each shard's first `skip + limit + 1` rows merged exactly as
 * the Mongo path merges them (`leaderboardRowComparator` + chainId).
 *
 * The sampling, caps, windows and skips are the pools lane's (`pools-lane-a.ts`
 * — `LaneAMeter` is shared): ≤ 20k estimated documents examined, ≤ 60 s old,
 * the read budget's `shadow` lane, one check per bucket per minute.
 */

export interface RankPageEntry {
  chainId: number;
  positionId: string;
}

export interface RankLaneAnswer {
  entries: RankPageEntry[];
  hasMore: boolean;
  counts: Array<{ chainId: number; count: number; capped: boolean }>;
}

export interface RankReferenceShard {
  chainId: number;
  rows: Array<{ positionId: unknown; value: unknown }>;
  count: number;
}

/** MongoDB's answer from per-shard reference reads (the Mongo path's merge, exactly). */
export function mongoRankLaneAnswer(
  shards: RankReferenceShard[],
  args: { skip: number; limit: number; cap: number; sortDirection: 1 | -1; tieDirection: 1 | -1; single: boolean; collated: boolean },
): RankLaneAnswer {
  const counts = shards.map((s) => ({ chainId: s.chainId, count: args.collated ? Math.min(s.count, args.cap) : s.count, capped: args.collated && s.count >= args.cap }));
  if (args.single) {
    const rows = shards[0]?.rows ?? [];
    return {
      entries: rows.slice(0, args.limit).map((row) => ({ chainId: shards[0].chainId, positionId: String(row.positionId) })),
      hasMore: rows.length > args.limit,
      counts,
    };
  }
  const merged = shards
    .flatMap((s) => s.rows.map((row) => ({ chainId: s.chainId, row })))
    .sort((a, b) => {
      const primary = compareSortValue(a.row.value, b.row.value, true) * args.sortDirection;
      if (primary !== 0) return primary;
      const tie = compareNumericString(a.row.positionId, b.row.positionId) * args.tieDirection;
      if (tie !== 0) return tie;
      return a.chainId - b.chainId;
    });
  return {
    entries: merged.slice(args.skip, args.skip + args.limit).map((m) => ({ chainId: m.chainId, positionId: String(m.row.positionId) })),
    hasMore: merged.length > args.skip + args.limit,
    counts,
  };
}

export interface RankLaneDiff {
  kind: 'ids' | 'order' | 'hasMore' | 'count';
  firstDiffIndex?: number;
  engine: unknown;
  mongo: unknown;
}

/** The first difference between two answers, or undefined. */
export function diffRankLaneAnswers(engine: RankLaneAnswer, mongo: RankLaneAnswer): RankLaneDiff | undefined {
  const key = (e: RankPageEntry) => `${e.chainId}:${e.positionId}`;
  const a = engine.entries.map(key);
  const b = mongo.entries.map(key);
  if (a.length !== b.length || a.some((id, i) => id !== b[i])) {
    const sortedA = [...a].sort();
    const sortedB = [...b].sort();
    const sameSet = a.length === b.length && sortedA.every((id, i) => id === sortedB[i]);
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

const RATE_FIELDS = new Set(['metrics.aprExGas', 'metrics.feeApr', 'metrics.roi']);

/** The bucket of a rank check (design §7.1): shape × sort class × chains × kind. */
export function rankBucket(args: { shape: string; sortField: string; single: boolean; kind: 'shallow' | 'deep' | 'pastEnd' | 'count' }): string {
  const sortClass = RATE_FIELDS.has(args.sortField) ? 'rate' : args.sortField === 'tokenId' ? 'pid' : 'numeric';
  return `${args.shape}|${sortClass}|${args.single ? 'single' : 'all'}|${args.kind}`;
}

/**
 * Documents a reference read would examine, from the engine's own numbers:
 * per shard, the find walks about `(skip + limit + 1) × offered / matches` rows
 * of its scope (a sort index rejects non-matching rows as it goes) and the
 * capped count about `min(matches, cap) × offered / matches`; an uncollated
 * shape reads its whole scope once (the pool's rows, a lookup's one row).
 */
export function estimateRankReferenceDocs(
  shards: Array<{ offered: number; matches: number }>,
  args: { skip: number; limit: number; cap: number; collated: boolean },
): number {
  let total = 0;
  for (const s of shards) {
    if (!args.collated) {
      total += s.offered;
      continue;
    }
    if (s.matches === 0) {
      // Nothing matches: both reads examine the whole scope to learn that.
      total += 2 * s.offered;
      continue;
    }
    const want = args.skip + args.limit + 1;
    const ratio = s.offered / s.matches;
    total += Math.min(s.offered, Math.ceil(want * ratio)) + Math.min(s.offered, Math.ceil(Math.min(s.matches, args.cap) * ratio));
  }
  return total;
}
