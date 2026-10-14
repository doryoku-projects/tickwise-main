import { readPathMeter } from './cache/read-path-meter.js';
import { LIST_WINDOW_MAX_ROWS, staleSince, stalenessBudgetMs } from './cache/swr-cache.js';
import { ReadBudgetService, ReadBudgetTimeoutError } from './read-budget.js';
import {
  fetchDeepPageDocs,
  LADDER_RUNG_EVERY,
  walkDeepPage,
  type DeepPageDocs,
  type DeepShard,
  type DeepWalkResult,
  type LadderStore,
  type SortSpec,
} from './shard-stream-merge.js';
import { userReadLagMs } from '../database/replication-lag.js';
import { isMaxTimeMSExpired, QueryTimeoutException } from '../database/user-read.js';

/**
 * One deep list page (deeper than the cached windows), positions or pools,
 * end to end — the part the two repositories share:
 *
 *  1. WALK from the nearest ladder rung (`walkDeepPage`), paced by the global
 *     read budget (rows reserved, database time settled — `chargeTime`), long
 *     walks holding one of the process's slots. A trusted rung (≤ the
 *     staleness budget old) or the top is the start when it is within
 *     `deepFreshReach` rows of the page; otherwise an AGED rung (up to
 *     `LEADERBOARD_LADDER_MAX_AGE_MS`) may start it, and the page is flagged.
 *  2. A walk that runs out of its request deadline (Mongo's `maxTimeMS`, or
 *     the budget) is the usual 503 + Retry-After — but it has recorded every
 *     rung it passed, and a BACKGROUND walk (`ReadBudgetService
 *     .startBackgroundWalk`, one at a time across every process, no request
 *     deadline) carries on to the page, so the retry starts next to it. No
 *     page is ever refused for its depth: each attempt moves the ladder
 *     forward, and the background walk keeps moving it between attempts.
 *  3. FETCH the page's documents by id (`fetchDeepPageDocs`): a chain whose
 *     fetch fails twice is dropped and the others walked again, so the page is
 *     always the merged order of exactly the chains it shows.
 *  4. AGE: the page's offsets are as old as the walk's anchor, its rows as old
 *     as the secondary they were read from (`userReadLagMs`). Older than the
 *     staleness budget → `dataAsOf` (the caller flags `stale: true`, no-store).
 *     A page served from an aged rung also starts a background walk from the
 *     newest trusted start, so the ladder re-anchors for the next pages.
 */
export interface DeepPageResult<D> {
  docs: D[];
  hasMore: boolean;
  /** Exact: the walk reached the end (over the chains on the page). */
  total?: number;
  missingChains: number[];
  errors: Array<{ chainId: number; error: unknown }>;
  /** Set only when the page is older than the staleness budget (aged rung, lagging secondary). */
  dataAsOf?: number;
}

export async function serveDeepPage<R, D>(args: {
  /** The shards of `chains`, each reading under `deadlineAt`. */
  shards: (chains: number[], deadlineAt: number) => Array<DeepShard<R>>;
  chains: number[];
  spec: SortSpec;
  skip: number;
  limit: number;
  maxTimeMS: number;
  /** Absent: the walk is not ladder-recorded (uncollated shapes, uncacheable filters). */
  ladder?: { store: LadderStore; key: string };
  budget?: ReadBudgetService;
  config?: { readStalenessBudgetMs?: number; leaderboardLadderMaxAgeMs?: number };
  fetch: (rows: Array<{ chainId: number; row: R }>, deadlineAt: number) => Promise<DeepPageDocs<D>>;
  /** The meter's route name for a stale-flagged page. */
  route: string;
}): Promise<DeepPageResult<D>> {
  const startedAt = Date.now();
  const deadlineAt = startedAt + args.maxTimeMS;
  const trustMs = stalenessBudgetMs(args.config);
  const { budget, ladder, spec, skip, limit } = args;
  const pace = (until: number) =>
    budget
      ? {
          reserve: (rows: number) => budget.reserve(rows, { deadlineAt: until, lane: 'deep' }),
          charge: (mongoMs: number, rows: number) => budget.chargeTime(mongoMs, rows, 'deep'),
        }
      : {};
  const continueInBackground = () => {
    if (!budget || !ladder) return;
    budget.startBackgroundWalk(`${ladder.key}|${skip}|${limit}`, (until) =>
      // From the newest TRUSTED start (or the top): this walk re-anchors the
      // ladder as well as reaching the page. Paced at half the budget, so the
      // reads queued behind it are not starved for the length of the walk.
      walkDeepPage<R>({
        shards: args.shards(args.chains, until),
        spec,
        skip,
        limit,
        ladder,
        reserve: (rows) => budget.reserveBackground(rows, until),
        charge: (mongoMs, rows) => budget.chargeTime(mongoMs, rows, 'deep-background'),
      }),
    );
  };

  let walk: DeepWalkResult<R>;
  try {
    walk = await walkDeepPage<R>({
      shards: args.shards(args.chains, deadlineAt),
      spec,
      skip,
      limit,
      ladder,
      ...pace(deadlineAt),
      slot: (needed, run) => (budget && needed > LIST_WINDOW_MAX_ROWS ? budget.walkSlot(deadlineAt, run) : run()),
      freshReach: deepFreshReach(budget),
      agedMaxMs: ladder ? (args.config?.leaderboardLadderMaxAgeMs ?? 600_000) : undefined,
    });
  } catch (err) {
    // Out of its deadline: its rungs are recorded (`walkDeepPage`); walk on
    // in the background so the retry the 503 asks for starts next to the page.
    if (isDeadlineError(err)) continueInBackground();
    throw deepReadError(err);
  }
  const aged = startedAt - walk.anchorAt > trustMs;
  readPathMeter.deepWalk(walk.walked, walk.from > 0, walk.missingChains.length > 0, aged);

  let settled: Awaited<ReturnType<typeof fetchDeepPageDocs<R, D>>>;
  try {
    settled = await fetchDeepPageDocs<R, D>({
      walk,
      limit,
      chains: args.chains,
      fetch: (rows) => args.fetch(rows, deadlineAt),
      rewalk: (live) => walkDeepPage<R>({ shards: args.shards(live, deadlineAt), spec, skip, limit, ...pace(deadlineAt) }),
    });
  } catch (err) {
    throw deepReadError(err);
  }
  if (aged) continueInBackground();

  const now = Date.now();
  const dataAsOf = staleSince(Math.min(settled.walk.anchorAt, now - userReadLagMs(now)), trustMs, now);
  if (dataAsOf !== undefined) readPathMeter.staleServed(args.route, now - dataAsOf);
  return {
    docs: settled.docs,
    hasMore: settled.walk.rows.length > limit,
    ...(settled.walk.exhausted ? { total: settled.walk.position } : {}),
    missingChains: settled.missingChains,
    errors: settled.errors,
    ...(dataAsOf !== undefined ? { dataAsOf } : {}),
  };
}

/**
 * How far (rows) a request walks from a TRUSTED start before an aged deeper
 * rung is preferred: about two seconds of the read budget (40k rows at the
 * defaults), so a page a request can reach in time is served unflagged.
 * Budget off: 100k.
 */
export function deepFreshReach(budget?: ReadBudgetService): number {
  const rate = budget?.ratePerSec ?? 0;
  return rate > 0 ? Math.max(LADDER_RUNG_EVERY, rate * 2) : 100_000;
}

/** A read that ran out of its deadline: Mongo's `maxTimeMS`, the read budget, or already mapped. */
export function isDeadlineError(err: unknown): boolean {
  return isMaxTimeMSExpired(err) || err instanceof ReadBudgetTimeoutError || err instanceof QueryTimeoutException;
}

/**
 * A deep read that could not answer in time — Mongo's `maxTimeMS`, or the read
 * budget not available before the deadline — is the same 503 + Retry-After as
 * a timed-out page. Anything else surfaces as it is.
 */
export function deepReadError(err: unknown): unknown {
  if (isMaxTimeMSExpired(err) || err instanceof ReadBudgetTimeoutError) return new QueryTimeoutException();
  return err ?? new QueryTimeoutException();
}
