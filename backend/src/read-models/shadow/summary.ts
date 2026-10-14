import { coverage, HOLDER_BUCKETS, poolsBuckets, rankBuckets, type Coverage, type LaneSnapshot } from './buckets.js';

/**
 * `GET /admin/sync/status` → `readModels.shadow` (design §7.1 "Metrics", P-R
 * R4): ONE place to read every verification lane and the rollout gate, built
 * from the engines' own lane-A meters (they register their status blocks with
 * `ReadModelsService.registerStatus`) and lane B's.
 *
 *  - `laneA.<model>`: checks, matches, diffs by kind, skips by reason, the
 *    last diffs — as the engine counted them;
 *  - `coverage.<model>`: the explicit bucket list against those checks
 *    (`buckets.ts`), with the gate "every bucket ≥ 50 checks, 0 diffs";
 *  - `laneB`: row samples, the verification scan per shard, confirmed diffs;
 *  - `gate.<model>`: lane A's coverage gate AND lane B clean AND at least one
 *    full verification pass of each of the model's ready shards. Lane C (an
 *    offline snapshot run) is not observable from a live process; the runbook
 *    asks for it separately.
 */

export interface LaneBStatus {
  checks: number;
  diffs: number;
  diffsByModel?: Partial<Record<'rank' | 'pools', number>>;
  kinds?: Record<string, number>;
  verify?: { shards?: Record<string, { passes: number }> };
}

function laneOf(engine: unknown, field: 'shadow' | 'holderShadow'): (LaneSnapshot & Record<string, unknown>) | undefined {
  if (!engine || typeof engine !== 'object') return undefined;
  const lane = (engine as Record<string, unknown>)[field];
  return lane && typeof lane === 'object' ? (lane as LaneSnapshot & Record<string, unknown>) : undefined;
}

/** Lane B's verdict for one model: no confirmed diffs, and every listed shard passed at least once. */
function laneBClean(model: 'rank' | 'pools', laneB: LaneBStatus | undefined, shards: readonly string[]): { clean: boolean; passedShards: number; shards: number; diffs: number } {
  const diffs = laneB?.diffsByModel?.[model] ?? laneB?.diffs ?? 0;
  const perShard = laneB?.verify?.shards ?? {};
  let passed = 0;
  for (const shard of shards) if ((perShard[`${model}|${shard}`]?.passes ?? 0) > 0) passed++;
  return { clean: diffs === 0 && shards.length > 0 && passed === shards.length, passedShards: passed, shards: shards.length, diffs };
}

export function shadowSummary(args: {
  engines: Record<string, unknown>;
  laneB?: LaneBStatus;
  /** Served shard keys per model (`chainId:protocol`). */
  shards: { rank: readonly string[]; pools: readonly string[] };
  minChecks?: number;
}) {
  const poolsLane = laneOf(args.engines.pools, 'shadow');
  const rankLane = laneOf(args.engines.rank, 'shadow');
  const holderLane = laneOf(args.engines.rank, 'holderShadow');
  const cov: Record<'pools' | 'rank' | 'holders', Coverage> = {
    pools: coverage(poolsBuckets(), poolsLane, args.minChecks),
    rank: coverage(rankBuckets(), rankLane, args.minChecks),
    holders: coverage(HOLDER_BUCKETS, holderLane, args.minChecks),
  };
  const laneBPools = laneBClean('pools', args.laneB, args.shards.pools);
  const laneBRank = laneBClean('rank', args.laneB, args.shards.rank);
  return {
    laneA: { pools: poolsLane ?? null, rank: rankLane ?? null, holders: holderLane ?? null },
    coverage: cov,
    laneB: args.laneB ?? null,
    gate: {
      pools: { laneA: cov.pools.gate, laneB: laneBPools, ready: cov.pools.gate && laneBPools.clean },
      rank: { laneA: cov.rank.gate && cov.holders.gate, laneB: laneBRank, ready: cov.rank.gate && cov.holders.gate && laneBRank.clean },
      note: 'lane C (offline snapshot run) is checked outside the process; see the internal design notes',
    },
  };
}

// ── coverage across replicas and restarts ──

/**
 * One replica's lane counters as published to redis-state (every minute,
 * `<prefix>:shadowcov:<replica>:<bootAt>`, TTL 4 days). The rollout gate is
 * "3 days of …", but every counter above is per process and resets on a
 * deploy; summing every record still alive answers it across replicas and
 * restarts. A record is the process's CUMULATIVE count, so a process's last
 * record supersedes its earlier ones (same key) and records of different
 * processes add.
 */
export interface CoverageRecord {
  replica: string;
  bootAt: number;
  at: number;
  lanes: { pools?: LaneSnapshot; rank?: LaneSnapshot; holders?: LaneSnapshot };
  laneB?: { diffsByModel?: Partial<Record<'rank' | 'pools', number>>; passes?: Record<string, number> };
}

export const COVERAGE_RECORD_TTL_MS = 4 * 24 * 3_600_000;

function compactLane(lane: (LaneSnapshot & Record<string, unknown>) | undefined): LaneSnapshot | undefined {
  if (!lane) return undefined;
  return { checks: lane.checks ?? 0, diffs: lane.diffs ?? 0, buckets: { ...(lane.buckets ?? {}) } };
}

/**
 * Records closer than this (one's start to the previous one's last publish)
 * belong to ONE continuous shadow period (a deploy overlaps; a model off for
 * longer starts a new period).
 */
export const COVERAGE_GAP_MS = 10 * 60_000;

export function coverageRecord(
  replica: string,
  bootAt: number,
  now: number,
  engines: Record<string, unknown>,
  laneB?: { diffsByModel?: Partial<Record<'rank' | 'pools', number>>; verify?: { shards?: Record<string, { passes: number }> } },
): CoverageRecord {
  const passes: Record<string, number> = {};
  for (const [id, shard] of Object.entries(laneB?.verify?.shards ?? {})) passes[id] = shard.passes;
  return {
    replica,
    bootAt,
    at: now,
    lanes: { pools: compactLane(laneOf(engines.pools, 'shadow')), rank: compactLane(laneOf(engines.rank, 'shadow')), holders: compactLane(laneOf(engines.rank, 'holderShadow')) },
    ...(laneB ? { laneB: { diffsByModel: { ...(laneB.diffsByModel ?? {}) }, passes } } : {}),
  };
}

function addLane(into: LaneSnapshot, lane: LaneSnapshot | undefined): void {
  if (!lane) return;
  into.checks = (into.checks ?? 0) + (lane.checks ?? 0);
  into.diffs = (into.diffs ?? 0) + (lane.diffs ?? 0);
  const buckets = (into.buckets ??= {});
  for (const [bucket, b] of Object.entries(lane.buckets ?? {})) {
    const sum = (buckets[bucket] ??= { checks: 0, diffs: 0 });
    sum.checks += b.checks;
    sum.diffs += b.diffs;
    if (b.heavy) sum.heavy = (sum.heavy ?? 0) + b.heavy;
  }
}

/**
 * Sum the live records of the CURRENT continuous shadow period (garbled ones
 * are skipped): records are merged into periods by `[bootAt, at]` with gaps
 * ≤ `COVERAGE_GAP_MS`; only the latest period counts, and `since` is its
 * start — "3 days of shadow" means 3 days without a gap, not the oldest
 * record still alive. `older` = records of earlier periods (not summed).
 */
export function aggregateCoverage(raw: ReadonlyArray<string>): { records: number; older: number; since: number | null; lanes: Required<CoverageRecord['lanes']>; laneB: LaneBStatus } {
  const lanes = { pools: { checks: 0, diffs: 0, buckets: {} }, rank: { checks: 0, diffs: 0, buckets: {} }, holders: { checks: 0, diffs: 0, buckets: {} } } as Required<CoverageRecord['lanes']>;
  const laneB: LaneBStatus & { diffsByModel: Record<'rank' | 'pools', number>; verify: { shards: Record<string, { passes: number }> } } = {
    checks: 0,
    diffs: 0,
    diffsByModel: { rank: 0, pools: 0 },
    verify: { shards: {} },
  };
  const parsed: CoverageRecord[] = [];
  for (const value of raw) {
    let record: CoverageRecord;
    try {
      record = JSON.parse(value) as CoverageRecord;
    } catch {
      continue;
    }
    if (!record || typeof record !== 'object' || !record.lanes || typeof record.bootAt !== 'number') continue;
    parsed.push(record);
  }
  // The latest continuous period: merge [bootAt, at] intervals, keep the last one.
  parsed.sort((a, b) => a.bootAt - b.bootAt);
  let periodStart: number | null = null;
  let periodEnd = -Infinity;
  for (const record of parsed) {
    const end = typeof record.at === 'number' ? Math.max(record.at, record.bootAt) : record.bootAt;
    if (periodStart === null || record.bootAt > periodEnd + COVERAGE_GAP_MS) periodStart = record.bootAt;
    periodEnd = Math.max(periodEnd, end);
  }
  let records = 0;
  let older = 0;
  for (const record of parsed) {
    if (periodStart === null || record.bootAt < periodStart) {
      older++;
      continue;
    }
    records++;
    addLane(lanes.pools, record.lanes.pools);
    addLane(lanes.rank, record.lanes.rank);
    addLane(lanes.holders, record.lanes.holders);
    for (const model of ['rank', 'pools'] as const) {
      const n = record.laneB?.diffsByModel?.[model] ?? 0;
      laneB.diffsByModel[model] += n;
      laneB.diffs += n;
    }
    // Passes are per holder: a shard verified by any holder counts.
    for (const [id, passes] of Object.entries(record.laneB?.passes ?? {})) {
      const shard = (laneB.verify.shards[id] ??= { passes: 0 });
      shard.passes += passes;
    }
  }
  return { records, older, since: periodStart, lanes, laneB };
}

/** The rollout gate across every live record (§7.3): lane A coverage + lane B clean, per model. */
export function fleetGate(agg: ReturnType<typeof aggregateCoverage>, shards: { rank: readonly string[]; pools: readonly string[] }, minChecks?: number) {
  const cov = {
    pools: coverage(poolsBuckets(), agg.lanes.pools, minChecks),
    rank: coverage(rankBuckets(), agg.lanes.rank, minChecks),
    holders: coverage(HOLDER_BUCKETS, agg.lanes.holders, minChecks),
  };
  const laneBPools = laneBClean('pools', agg.laneB, shards.pools);
  const laneBRank = laneBClean('rank', agg.laneB, shards.rank);
  return {
    records: agg.records,
    olderRecords: agg.older,
    since: agg.since ? new Date(agg.since).toISOString() : null,
    coverage: cov,
    laneB: agg.laneB,
    gate: {
      pools: { laneA: cov.pools.gate, laneB: laneBPools, ready: cov.pools.gate && laneBPools.clean },
      rank: { laneA: cov.rank.gate && cov.holders.gate, laneB: laneBRank, ready: cov.rank.gate && cov.holders.gate && laneBRank.clean },
    },
  };
}
