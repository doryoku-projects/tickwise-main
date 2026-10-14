import { poolsBucket } from './pools-lane-a.js';
import { rankBucket } from './rank-lane-a.js';

/**
 * The explicit lane-A bucket lists and their coverage (design §7.1, P-R R4).
 *
 * A bucket is one combination of the axes an engine BRANCHES on (sort class,
 * search class, chains, page kind, …); the rollout gate (§7.3) asks for every
 * Mongo-answerable bucket to reach `READ_MODELS_SHADOW_COVERAGE_MIN` (50)
 * checks with zero diffs. The lists are generated from the SAME functions
 * lane A labels its checks with (`poolsBucket`, `rankBucket`), so a renamed
 * axis cannot leave the list and the meter disagreeing silently — and a
 * checked bucket missing from the list is reported (`unlisted`) rather than
 * ignored. The minimum is `COVERAGE_MIN_CHECKS` (a constant, not an env var).
 *
 * Heavy buckets (> 20k documents examined — anything ranked over all chains,
 * 4663 pools lists, broad counts: the dashboard's landing view is one) are
 * skipped by lane A by design. A bucket lane A found too heavy at least
 * `COVERAGE_MIN_CHECKS` times (and checked fewer times than that) is EXEMPT:
 * the gate counts it as `covered ∪ exempt`, and it has NO answer-level shadow
 * verification — lane B (rows) plus the R2/R3 rig parity scripts are its
 * substitute until lane C exists (the internal design notes runbook).
 */

export const COVERAGE_MIN_CHECKS = 50;

const POOL_SORTS = ['tvl', 'age'] as const;
/** One representative needle per search class (`searchClass`). */
const POOL_SEARCHES: Array<string | undefined> = [undefined, 'eth', '0xab', 'a.b', 'é'];
const POOL_FLOORS = [0, 777];
const KINDS = ['shallow', 'deep', 'pastEnd', 'count'] as const;

/** Every pools bucket: sort class × search class × floor class × chains × kind (160). */
export function poolsBuckets(): string[] {
  const out = new Set<string>();
  for (const sort of POOL_SORTS)
    for (const search of POOL_SEARCHES)
      for (const minTvlUsd of POOL_FLOORS)
        for (const single of [true, false]) for (const kind of KINDS) out.add(poolsBucket({ sort, search, minTvlUsd, single, kind }));
  return [...out].sort();
}

const RANK_SHAPES = ['ranked', 'owner', 'pool', 'lookup'] as const;
/** One representative sort field per sort class (`rankBucket`: rate / numeric / pid). */
const RANK_SORT_FIELDS = ['metrics.aprExGas', 'metrics.underlyingValueUsd', 'tokenId'] as const;

/**
 * Every rank bucket: shape × sort class × chains × kind, minus the
 * combinations the served pipeline never produces — a lookup is one row (no
 * deep page, no count), a pool page carries its own exact total (no count).
 */
export function rankBuckets(): string[] {
  const out = new Set<string>();
  for (const shape of RANK_SHAPES)
    for (const sortField of RANK_SORT_FIELDS)
      for (const single of [true, false])
        for (const kind of KINDS) {
          if (shape === 'lookup' && (kind === 'deep' || kind === 'count')) continue;
          if (shape === 'pool' && kind === 'count') continue;
          out.add(rankBucket({ shape, sortField, single, kind }));
        }
  return [...out].sort();
}

export const HOLDER_BUCKETS = ['holders|detail', 'holders|list'];

export interface LaneSnapshot {
  checks?: number;
  diffs?: number;
  /** `heavy`: checks skipped as too heavy for lane A (> 20k docs). */
  buckets?: Record<string, { checks: number; diffs: number; heavy?: number }>;
}

export interface Coverage {
  total: number;
  covered: number;
  partial: number;
  uncovered: number;
  /** Buckets lane A cannot afford (≥ the minimum heavy skips, fewer checks): no answer-level verification. */
  exempt: number;
  exemptBuckets: string[];
  checks: number;
  diffs: number;
  /** Every bucket reached the minimum (or is exempt) with zero diffs. */
  gate: boolean;
  /** Buckets with diffs (any count). */
  diffBuckets: string[];
  /** The first 30 buckets still below the minimum. */
  short: Array<{ bucket: string; checks: number }>;
  /** Buckets lane A checked that the list does not know (a renamed axis). */
  unlisted: string[];
}

/** Coverage of `list` by a lane-A meter snapshot. */
export function coverage(list: readonly string[], lane: LaneSnapshot | undefined, minChecks = COVERAGE_MIN_CHECKS): Coverage {
  const buckets = lane?.buckets ?? {};
  const known = new Set(list);
  let covered = 0;
  let partial = 0;
  let exempt = 0;
  let checks = 0;
  let diffs = 0;
  const short: Coverage['short'] = [];
  const diffBuckets: string[] = [];
  const exemptBuckets: string[] = [];
  for (const bucket of list) {
    const b = buckets[bucket];
    const n = b?.checks ?? 0;
    checks += n;
    diffs += b?.diffs ?? 0;
    if (b?.diffs) diffBuckets.push(bucket);
    if (n >= minChecks) covered++;
    else if ((b?.heavy ?? 0) >= minChecks) {
      exempt++;
      exemptBuckets.push(bucket);
    } else {
      if (n > 0) partial++;
      short.push({ bucket, checks: n });
    }
  }
  const unlisted = Object.keys(buckets).filter((b) => !known.has(b));
  for (const b of unlisted) {
    checks += buckets[b].checks;
    diffs += buckets[b].diffs;
    if (buckets[b].diffs) diffBuckets.push(b);
  }
  short.sort((a, b) => a.checks - b.checks || a.bucket.localeCompare(b.bucket));
  return {
    total: list.length,
    covered,
    partial,
    uncovered: list.length - covered - partial - exempt,
    exempt,
    exemptBuckets: exemptBuckets.slice(0, 30),
    checks,
    diffs,
    gate: covered + exempt === list.length && diffs === 0,
    diffBuckets,
    short: short.slice(0, 30),
    unlisted,
  };
}
