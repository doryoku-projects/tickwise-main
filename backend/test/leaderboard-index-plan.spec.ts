/*
 * Which index every positions read uses, and why it can: the ranked
 * leaderboard's Set R hints (8 sorts × 3 statuses × risky on/off), the exact
 * `isActive: true` the partial indexes need, the sort each index serves (the
 * nft tie-break following the primary, age = newest first), the count's own
 * hint, the Node-side orderings that must reproduce the Mongo order, the
 * schema declarations that must equal the migration script's specs, and the
 * background readers' hints. Explain numbers for these shapes on the local
 * shards are in the internal design notes.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  BACKGROUND_SPECS,
  LEGACY_INDEXES,
  LEGACY_METRIC_INDEXES,
  LEGACY_UNUSED_INDEXES,
  SET_R_SPECS,
  legacyDeclarationsInSource,
  normalizeCollation,
  sameKey,
} from '../scripts/positions-index-migration.mjs';
import {
  effectiveLeaderboardSort,
  hasValueFloor,
  leaderboardRowComparator,
  leaderboardSortSpec,
  PositionsRepository,
  type LeaderboardQuery,
} from '../src/database/positions.repository.js';
import { PositionSchema } from '../src/database/schemas/position.schema.js';
import { isUnsupportedHintError } from '../src/database/user-read.js';
import { LeaderboardCountService } from '../src/leaderboard/count-cache.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';

type Spec = { name: string; key: Record<string, number>; collation?: Record<string, unknown>; partialFilterExpression?: Record<string, unknown> };

const COLLATION = { locale: 'en', numericOrdering: true };
const SORTS = ['apr', 'fee_apr', 'roi', 'age', 'pnl', 'underlying_value', 'nft_id_asc', 'nft_id_desc'] as const;
const STATUSES = ['active', 'inactive', 'all'] as const;
const RATE = new Set(['apr', 'fee_apr', 'roi']);
const MISSING_HINT = Object.assign(
  new Error('planner returned error :: caused by :: hint provided does not correspond to an existing index'),
  { code: 2, codeName: 'BadValue' },
);

/** Expected per sort: the Mongo sort and the Set R index that serves it. */
const EXPECTED: Record<(typeof SORTS)[number], { sort: Record<string, 1 | -1>; index: string }> = {
  apr: { sort: { 'metrics.aprExGas': -1, positionId: 1 }, index: 'lbr_apr_active' },
  fee_apr: { sort: { 'metrics.feeApr': -1, positionId: 1 }, index: 'lbr_feeapr_active' },
  roi: { sort: { 'metrics.roi': -1, positionId: 1 }, index: 'lbr_roi_active' },
  age: { sort: { createdAtTimestamp: -1, positionId: 1 }, index: 'lbr_created' },
  pnl: { sort: { 'metrics.poolPnlUsd': -1, positionId: 1 }, index: 'lbr_pnl' },
  underlying_value: { sort: { 'metrics.underlyingValueUsd': -1, positionId: 1 }, index: 'lbr_value' },
  nft_id_asc: { sort: { tokenId: 1, positionId: 1 }, index: 'lbr_tokenid' },
  nft_id_desc: { sort: { tokenId: -1, positionId: -1 }, index: 'lbr_tokenid' },
};

interface Call {
  op: 'find' | 'count' | 'distinct' | 'aggregate';
  filter: Record<string, unknown>;
  arg?: unknown;
  opts: Record<string, unknown>;
}

/** A fake shard model recording every query's filter and chained options. */
function fakeModel(handlers: Partial<Record<Call['op'], (call: Call) => unknown>> = {}) {
  const calls: Call[] = [];
  const query = (op: Call['op'], filter: Record<string, unknown>, arg?: unknown) => {
    const call: Call = { op, filter, arg, opts: {} };
    calls.push(call);
    const run = async () => (handlers[op] ? handlers[op]!(call) : op === 'count' ? 0 : []);
    const q: Record<string, unknown> = {};
    for (const method of ['select', 'sort', 'collation', 'hint', 'skip', 'limit', 'read', 'maxTimeMS', 'option']) {
      q[method] = (value: unknown) => {
        call.opts[method] = value;
        return q;
      };
    }
    q.lean = run;
    q.exec = run;
    q.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => run().then(resolve, reject);
    return q;
  };
  const model = {
    find: (filter: Record<string, unknown>, projection?: unknown) => query('find', filter, projection),
    countDocuments: (filter: Record<string, unknown>, options?: unknown) => query('count', filter, options),
    aggregate: (pipeline: unknown) => query('aggregate', {}, pipeline),
    // The driver collection: Mongoose's query builder refuses .hint() on a distinct.
    collection: {
      distinct: async (field: string, filter: Record<string, unknown>, options: { hint?: string } = {}) => {
        const call: Call = { op: 'distinct', filter, arg: field, opts: { ...options } };
        calls.push(call);
        return handlers.distinct ? handlers.distinct(call) : [];
      },
    },
  };
  return { model, calls };
}

function makeRepo(
  handlers: Partial<Record<Call['op'], (call: Call) => unknown>> = {},
  unusable: Record<string, string> = {},
) {
  const { model, calls } = fakeModel(handlers);
  const tokens = { readyLeaderboardExclusions: async () => ({ addresses: ['0xbad'], ok: true }) };
  const resolver = { positionModel: () => model, hintUnusable: (_c: number, _p: string, index: string) => unusable[index] };
  const repo = new PositionsRepository(resolver as never, tokens as never);
  return { repo, calls };
}

function query(over: Partial<LeaderboardQuery> = {}): LeaderboardQuery {
  return {
    chainId: 1,
    protocol: 'uniswap-v4',
    sort: 'apr',
    page: 1,
    limit: 25,
    activeOnly: true,
    status: 'active',
    range: 'all',
    minValueUsd: 0,
    minPoolTvl: 0,
    includeRisky: true,
    ...over,
  };
}

/** Every `isActive` value anywhere in a filter, `$and`/`$or` included. */
function isActiveValues(node: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(node)) node.forEach((n) => isActiveValues(n, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'isActive') out.push(v);
      isActiveValues(v, out);
    }
  }
  return out;
}

/** Set R indexes whose key carries the value field, read off the migration's specs. */
const VALUE_KEYED = new Set(
  (SET_R_SPECS as Spec[]).filter((s) => 'metrics.underlyingValueUsd' in s.key).map((s) => s.name),
);

/**
 * The hint a ranked find must carry. A minimum-value floor without
 * `isActive: true` matches only open rows, so a walk of the SORT index would
 * visit (and, without the value on its key, fetch) every closed row in front
 * of them: the Closed tab reads `lbr_value`, the All tab leaves a sort index
 * without the value in its key to the planner.
 */
function expectedHint(sort: (typeof SORTS)[number], status: (typeof STATUSES)[number], minValueUsd: number): string | undefined {
  if (RATE.has(sort)) return status === 'inactive' ? undefined : EXPECTED[sort].index;
  if (minValueUsd > 0 && status === 'inactive') return 'lbr_value';
  if (minValueUsd > 0 && status === 'all') return VALUE_KEYED.has(EXPECTED[sort].index) ? EXPECTED[sort].index : undefined;
  return EXPECTED[sort].index;
}

describe('ranked leaderboard: 8 sorts × 3 statuses × risky on/off × value floor', () => {
  const cases = SORTS.flatMap((sort) =>
    STATUSES.flatMap((status) =>
      [true, false].flatMap((includeRisky) => [0, 500].map((minValueUsd) => ({ sort, status, includeRisky, minValueUsd }))),
    ),
  );

  it.each(cases)('$sort · $status · includeRisky=$includeRisky · min $$minValueUsd', async ({ sort, status, includeRisky, minValueUsd }) => {
    const { repo, calls } = makeRepo();
    const q = query({ sort, status, activeOnly: status === 'active', includeRisky, minValueUsd });
    const plan = await repo.leaderboardPlan(q);
    const rate = RATE.has(sort);
    const activeOnly = status === 'active' || (rate && status !== 'inactive');

    // isActive exactness: a boolean wherever it appears, never `{$ne: false}`,
    // and the TOP-LEVEL equality a partial index needs.
    for (const value of isActiveValues(plan.filter)) expect(typeof value).toBe('boolean');
    expect(plan.filter.isActive).toBe(status === 'inactive' ? false : activeOnly ? true : undefined);
    if (rate && status !== 'inactive') {
      // …and holding value, as a top-level bound on the index key.
      expect(plan.filter['metrics.underlyingValueUsd']).toMatchObject({ $gt: 0 });
    }

    // Sort, collation, hint — on the plan AND on the query actually sent.
    expect(plan.shape).toBe('ranked');
    expect(plan.collated).toBe(true);
    const wantHint = expectedHint(sort, status, minValueUsd);
    expect(plan.hint).toBe(wantHint);
    if (plan.hint === 'lbr_apr_active' || plan.hint === 'lbr_feeapr_active' || plan.hint === 'lbr_roi_active') {
      expect(plan.filter.isActive).toBe(true); // a partial index only qualifies on this exact equality
    }
    await repo.findLeaderboard(q);
    const [find] = calls;
    expect(find.opts.sort).toEqual(EXPECTED[sort].sort);
    expect(Object.keys(find.opts.sort as object)).toEqual(Object.keys(EXPECTED[sort].sort)); // key ORDER
    expect(find.opts.collation).toEqual(COLLATION);
    expect(find.opts.hint).toBe(wantHint);

    // The count's own index: lbr_value exactly when the filter bounds the value.
    const valueBounded = (rate && status !== 'inactive') || (!includeRisky && status === 'active') || minValueUsd > 0;
    expect(plan.countHint).toBe(valueBounded ? 'lbr_value' : undefined);
  });

  it('under a value floor, a sort index WITHOUT the value in its key is hinted only for an isActive: true filter', async () => {
    // The regression this guards: Closed + $500+ + age hinted to lbr_created
    // fetched every closed document of the shard (chain 1: 352,834 docs).
    const valueless = new Set((SET_R_SPECS as Spec[]).filter((s) => !VALUE_KEYED.has(s.name) && !s.partialFilterExpression).map((s) => s.name));
    expect([...valueless].sort()).toEqual(['lbr_created', 'lbr_tokenid']);
    const { repo } = makeRepo();
    for (const sort of SORTS) {
      for (const status of [...STATUSES, undefined]) {
        for (const activeOnly of [true, false]) {
          for (const includeRisky of [true, false]) {
            for (const minValueUsd of [1, 500, 10_000]) {
              const plan = await repo.leaderboardPlan(query({ sort, status, activeOnly, includeRisky, minValueUsd }));
              if (plan.hint && valueless.has(plan.hint)) expect(plan.filter.isActive, `${plan.hint} ${sort}/${status}/${activeOnly}`).toBe(true);
            }
          }
        }
      }
    }
  });

  it('Closed tab + value floor: every non-rate sort reads lbr_value (find AND count); the rate sorts stay unhinted', async () => {
    const { repo, calls } = makeRepo();
    for (const sort of SORTS) {
      const plan = await repo.leaderboardPlan(query({ sort, status: 'inactive', activeOnly: false, minValueUsd: 500 }));
      expect(plan.filter).toMatchObject({ isActive: false, 'metrics.underlyingValueUsd': { $gte: 500 } });
      expect([plan.hint, plan.countHint], sort).toEqual([RATE.has(sort) ? undefined : 'lbr_value', 'lbr_value']);
      // The sort itself is unchanged — only the index that serves it moved.
      expect({ [plan.sortField]: plan.sortDirection, positionId: plan.tieDirection }).toEqual(EXPECTED[sort].sort);
    }
    await repo.findLeaderboard(query({ sort: 'age', status: 'inactive', activeOnly: false, minValueUsd: 500 }));
    expect([calls[0].opts.hint, calls[0].opts.sort, calls[0].opts.collation]).toEqual(['lbr_value', EXPECTED.age.sort, COLLATION]);
  });

  it('hasValueFloor: a top-level $gte lower bound only — never a $gt-only, an upper bound or a nested bound', () => {
    const v = 'metrics.underlyingValueUsd';
    expect(hasValueFloor({ [v]: { $gte: 500 } })).toBe(true);
    expect(hasValueFloor({ [v]: { $gte: 500, $gt: 0 } })).toBe(true);
    expect(hasValueFloor({ [v]: { $gt: 0 } })).toBe(false);
    expect(hasValueFloor({ [v]: { $lte: 500 } })).toBe(false);
    expect(hasValueFloor({ [v]: 500 })).toBe(false);
    expect(hasValueFloor({ [v]: null })).toBe(false);
    expect(hasValueFloor({ $and: [{ [v]: { $gte: 500 } }] })).toBe(false);
  });

  it('a non-positive floor is not a floor: Closed / All keep their sort index', async () => {
    const { repo } = makeRepo();
    for (const status of ['inactive', 'all'] as const) {
      for (const minValueUsd of [0, -5]) {
        const plan = await repo.leaderboardPlan(query({ sort: 'age', status, activeOnly: false, minValueUsd }));
        expect(plan.hint, `${status} ${minValueUsd}`).toBe('lbr_created');
      }
    }
  });

  it('the hinted index is always the one whose leading sort key IS the sort field (no SORT stage possible)', () => {
    const specs = new Map((SET_R_SPECS as Spec[]).map((s) => [s.name, s]));
    for (const sort of SORTS) {
      const { field, direction, tieDirection } = leaderboardSortSpec(sort);
      const keys = Object.entries(specs.get(EXPECTED[sort].index)!.key);
      expect(keys.slice(0, 2)).toEqual([['chainId', 1], ['protocol', 1]]);
      const [[indexField, indexDir], [tieField, tieDir]] = keys.slice(2, 4);
      expect(indexField).toBe(field);
      expect(tieField).toBe('positionId');
      // Forwards (same directions) or backwards (both flipped) — never mixed.
      expect(direction * Number(indexDir)).toBe(tieDirection * Number(tieDir));
    }
  });

  it('a minimum value bounds the count on every status', async () => {
    const { repo } = makeRepo();
    for (const status of STATUSES) {
      const plan = await repo.leaderboardPlan(query({ sort: 'pnl', status, activeOnly: status === 'active', minValueUsd: 500 }));
      expect(plan.countHint, status).toBe('lbr_value');
    }
  });

  it('assetClass=equity stays unhinted (find and count): its $or over the address indexes is the selective plan', async () => {
    const { repo } = makeRepo();
    for (const sort of SORTS) {
      for (const status of STATUSES) {
        const plan = await repo.leaderboardPlan(query({ sort, status, assetClass: 'equity', minValueUsd: 500 }));
        expect(plan.hint, `${sort}/${status}`).toBeUndefined();
        expect(plan.countHint, `${sort}/${status}`).toBeUndefined();
      }
    }
  });

  it('the scoped shapes keep their own index for find AND count', async () => {
    const { repo } = makeRepo();
    const owner = await repo.leaderboardPlan(query({ owner: '0x1111111111111111111111111111111111111111' }));
    expect([owner.hint, owner.countHint, owner.collated]).toEqual(['chainId_1_protocol_1_owner_1', 'chainId_1_protocol_1_owner_1', true]);
    const pool = await repo.leaderboardPlan(query({ poolId: '0xpool' }));
    expect([pool.hint, pool.countHint, pool.collated]).toEqual(['bg_active_pool_owner', 'bg_active_pool_owner', false]);
    const lookup = await repo.leaderboardPlan(query({ positionId: '7' }));
    expect([lookup.hint, lookup.countHint, lookup.collated]).toEqual([undefined, undefined, false]);
  });

  it('a Closed-tab rate sort keeps today\'s filter exactly: isActive false, no value exclusion, unhinted', async () => {
    const { repo } = makeRepo();
    for (const sort of ['apr', 'fee_apr', 'roi']) {
      const plan = await repo.leaderboardPlan(query({ sort, status: 'inactive', activeOnly: false }));
      expect(plan.filter).toEqual({
        chainId: 1,
        protocol: 'uniswap-v4',
        isActive: false,
        $and: [{ 'token0.address': { $nin: ['0xbad'] }, 'token1.address': { $nin: ['0xbad'] } }],
      });
      expect(plan.hint).toBeUndefined();
      expect({ [plan.sortField]: plan.sortDirection, positionId: plan.tieDirection }).toEqual(EXPECTED[sort as 'apr'].sort);
    }
  });

  it('a partial (isActive:true) index is NEVER hinted for a filter that does not carry isActive: true', async () => {
    // Not just a speed rule: MongoDB obeys such a hint and silently returns the
    // incomplete result (verified on 8.0 — the Closed filter hinted to
    // lbr_apr_active returned 0 rows, no error).
    const partial = new Set(
      [...(SET_R_SPECS as Spec[]), ...(BACKGROUND_SPECS as Spec[])].filter((s) => s.partialFilterExpression).map((s) => s.name),
    );
    const { repo } = makeRepo();
    for (const sort of SORTS) {
      for (const status of [...STATUSES, undefined]) {
        for (const activeOnly of [true, false]) {
          for (const scope of [{}, { poolId: '0xpool' }, { owner: '0x1111111111111111111111111111111111111111' }, { assetClass: 'equity' as const }]) {
            for (const includeRisky of [true, false]) {
              const plan = await repo.leaderboardPlan(query({ sort, status, activeOnly, includeRisky, minValueUsd: 500, ...scope }));
              for (const hint of [plan.hint, plan.countHint]) {
                if (hint && partial.has(hint)) expect(plan.filter.isActive, `${hint} ${sort}/${status}/${JSON.stringify(scope)}`).toBe(true);
              }
            }
          }
        }
      }
    }
  });

  it('an index the boot pre-flight found with a DIFFERENT spec is never hinted (find, count, and through its fallback)', async () => {
    const { repo, calls } = makeRepo({}, { lbr_apr_active: 'partialFilterExpression {"isActive":true,"metrics.inRange":true}', bg_active_pool_owner: 'hidden=true' });
    const apr = query({ sort: 'apr', status: 'active' });
    await repo.findLeaderboard(apr);
    await repo.countLeaderboard(await repo.leaderboardPlan(query({ sort: 'apr', status: 'active', minValueUsd: 500 })), 100);
    await repo.countsByPoolIds(1, 'uniswap-v4', ['0xa']);
    expect(calls.map((c) => [c.op, c.opts.hint])).toEqual([
      ['find', undefined], // lbr_apr_active skipped: planner
      ['count', 'lbr_value'], // a usable index is unaffected
      ['aggregate', 'bg_active_pool'], // bg_active_pool_owner skipped: its HINT_FALLBACK, the old pool index
    ]);
  });

  it('a hinted Set R index the shard lacks falls back to the planner, once alerted', async () => {
    const { repo, calls } = makeRepo({
      find: (call) => {
        if (call.opts.hint) throw MISSING_HINT;
        return [];
      },
    });
    await repo.findLeaderboard(query({ sort: 'pnl' }));
    expect(calls.map((c) => c.opts.hint)).toEqual(['lbr_pnl', undefined]);
  });
});

describe('Node-side orderings reproduce the Mongo sort exactly', () => {
  const r = (chainId: number, positionId: string, extra: Record<string, unknown> = {}) => ({
    chainId,
    protocol: 'uniswap-v4',
    positionId,
    tokenId: positionId,
    createdAtTimestamp: 0,
    token0: { address: '0xa' },
    token1: { address: '0xb' },
    metrics: { underlyingValueUsd: 1 },
    poolStats: { tvlUsd: 0, tvlUsdUntracked: 0, volumeUsd: 0, totalFeesUsd: 0 },
    pricing: { source: 'dex', usedFallback: false },
    ...extra,
  });
  const order = (sort: string, rows: Array<ReturnType<typeof r>>) => {
    const { field, direction, tieDirection } = leaderboardSortSpec(sort);
    const cmp = leaderboardRowComparator(field, direction, tieDirection);
    return [...rows].sort((a, b) => cmp(a, b) || a.chainId - b.chainId).map((x) => `${x.chainId}:${x.positionId}`);
  };

  it('age: newest first; equal timestamps break on numeric positionId ascending, then chainId', () => {
    const rows = [
      r(1, '10', { createdAtTimestamp: 100 }),
      r(1, '9', { createdAtTimestamp: 100 }),
      r(42161, '9', { createdAtTimestamp: 100 }),
      r(1, '2', { createdAtTimestamp: 300 }),
      r(1, '1', { createdAtTimestamp: 50 }),
    ];
    expect(order('age', rows)).toEqual(['1:2', '1:9', '42161:9', '1:10', '1:1']);
  });

  it('nft asc / desc: numeric tokenId order (not lexicographic), the tie-break following the primary', () => {
    const rows = [r(1, '10'), r(1, '9'), r(1, '100'), r(43114, '9'), r(1, '99999999999999999999')];
    expect(order('nft_id_asc', rows)).toEqual(['1:9', '43114:9', '1:10', '1:100', '1:99999999999999999999']);
    expect(order('nft_id_desc', rows)).toEqual(['1:99999999999999999999', '1:100', '1:10', '1:9', '43114:9']);
  });

  it('a non-v4 tie (same tokenId, different positionId) descends on the nft desc sort, ascends elsewhere', () => {
    const a = { positionId: '20', tokenId: '5', metrics: { poolPnlUsd: 1 } };
    const b = { positionId: '3', tokenId: '5', metrics: { poolPnlUsd: 1 } };
    const desc = leaderboardSortSpec('nft_id_desc');
    expect([a, b].sort(leaderboardRowComparator(desc.field, desc.direction, desc.tieDirection))).toEqual([a, b]);
    const pnl = leaderboardSortSpec('pnl');
    expect([a, b].sort(leaderboardRowComparator(pnl.field, pnl.direction, pnl.tieDirection))).toEqual([b, a]);
  });

  it('the all-chains merge orders shards with the same comparator (age, nft desc)', async () => {
    const shards: Record<number, Array<ReturnType<typeof r>>> = {
      1: [r(1, '10', { createdAtTimestamp: 200 }), r(1, '9', { createdAtTimestamp: 100 })],
      42161: [r(42161, '100', { createdAtTimestamp: 150 }), r(42161, '9', { createdAtTimestamp: 100 })],
    };
    const positions = {
      findLeaderboard: async ({ chainId }: { chainId: number }) => ({ positions: shards[chainId], hasMore: false, cache: 'hit', total: 2 }),
      leaderboardPlan: async ({ chainId }: { chainId: number }) => ({ countKey: `k${chainId}` }),
      countLeaderboard: async () => ({ count: 2, capped: false }),
    };
    const config = {
      isSupportedChain: () => true,
      isSupportedProtocol: () => true,
      leaderboardCountCap: 25_000,
      enabledIntegrations: [{ chainId: 1, protocol: 'uniswap-v4' }, { chainId: 42161, protocol: 'uniswap-v4' }],
    };
    const svc = new LeaderboardService(config as never, positions as never, {} as never, {} as never, new LeaderboardCountService());
    const ids = async (sort: string) =>
      (await svc.getTopPositions({ protocol: 'uniswap-v4', sort, page: 1, limit: 10 } as never)).positions.map(
        (p) => `${p.chainId}:${p.positionId}`,
      );
    expect(await ids('age')).toEqual(['1:10', '42161:100', '1:9', '42161:9']);
    expect(await ids('nft_id_desc')).toEqual(['42161:100', '1:10', '1:9', '42161:9']);
    expect(await ids('nft_id_asc')).toEqual(['1:9', '42161:9', '1:10', '42161:100']);

    // A tokenId tie with different positionIds (not v4, but the merge must not
    // assume v4): the tie-break follows the primary on the nft sorts.
    shards[1] = [r(1, '20', { tokenId: '5' })];
    shards[42161] = [r(42161, '3', { tokenId: '5' })];
    expect(await ids('nft_id_desc')).toEqual(['1:20', '42161:3']);
    expect(await ids('nft_id_asc')).toEqual(['42161:3', '1:20']);
  });

  it('the Closed tab asked for a rate sort is served as pnl: shard read, merge order and count key alike', async () => {
    expect(effectiveLeaderboardSort('inactive', 'apr')).toBe('pnl');
    expect(effectiveLeaderboardSort('inactive', 'fee_apr')).toBe('pnl');
    expect(effectiveLeaderboardSort('inactive', 'roi')).toBe('pnl');
    // Only the Closed tab, and only the three rate sorts.
    expect(effectiveLeaderboardSort('inactive', 'age')).toBe('age');
    expect(effectiveLeaderboardSort('inactive', 'pnl')).toBe('pnl');
    expect(effectiveLeaderboardSort('active', 'apr')).toBe('apr');
    expect(effectiveLeaderboardSort('all', 'roi')).toBe('roi');
    expect(effectiveLeaderboardSort(undefined, 'apr')).toBe('apr');

    const seen: string[] = [];
    const planned: string[] = [];
    const shards: Record<number, Array<ReturnType<typeof r>>> = {
      // aprExGas would order these 1:A, 42161:B; poolPnlUsd orders 42161:B first.
      1: [r(1, '1', { metrics: { aprExGas: 900, poolPnlUsd: 10 } })],
      42161: [r(42161, '2', { metrics: { aprExGas: 5, poolPnlUsd: 50 } })],
    };
    const positions = {
      findLeaderboard: async ({ chainId, sort }: { chainId: number; sort: string }) => {
        seen.push(sort);
        return { positions: shards[chainId], hasMore: false, cache: 'hit', total: 1 };
      },
      leaderboardPlan: async ({ chainId, sort }: { chainId: number; sort: string }) => {
        planned.push(sort);
        return { countKey: `k${chainId}` };
      },
      countLeaderboard: async () => ({ count: 1, capped: false }),
    };
    const config = {
      isSupportedChain: () => true,
      isSupportedProtocol: () => true,
      leaderboardCountCap: 25_000,
      enabledIntegrations: [{ chainId: 1, protocol: 'uniswap-v4' }, { chainId: 42161, protocol: 'uniswap-v4' }],
    };
    const svc = new LeaderboardService(config as never, positions as never, {} as never, {} as never, new LeaderboardCountService());
    const res = await svc.getTopPositions({ protocol: 'uniswap-v4', status: 'inactive', sort: 'apr', page: 1, limit: 10 } as never);
    expect(res.positions.map((p) => `${p.chainId}:${p.positionId}`)).toEqual(['42161:2', '1:1']);
    expect(new Set(seen)).toEqual(new Set(['pnl']));
    await svc.getTopPositionsCount({ protocol: 'uniswap-v4', status: 'inactive', sort: 'roi', limit: 10 } as never);
    expect(new Set(planned)).toEqual(new Set(['pnl']));
  });

  it('the uncollated pool shape orders nft desc and age exactly like the collated query', async () => {
    const keys = ['10', '9', '100', '2'].map((id, i) => ({ positionId: id, tokenId: id, createdAtTimestamp: [5, 9, 9, 1][i] }));
    const make = () =>
      makeRepo({
        find: (call) =>
          call.arg ? keys : (call.filter.positionId as { $in: string[] }).$in.map((id) => r(1, id)),
      });
    const desc = make();
    const page = await desc.repo.findLeaderboard(query({ poolId: '0xpool', sort: 'nft_id_desc' }));
    expect(page.positions.map((p) => p.positionId)).toEqual(['100', '10', '9', '2']);
    const age = make();
    const byAge = await age.repo.findLeaderboard(query({ poolId: '0xpool', sort: 'age' }));
    expect(byAge.positions.map((p) => p.positionId)).toEqual(['9', '100', '10', '2']);

    // tokenId ties (not v4): the positionId tie-break follows the primary.
    const tied = [{ positionId: '4', tokenId: '7' }, { positionId: '30', tokenId: '7' }, { positionId: '8', tokenId: '8' }];
    const tie = makeRepo({
      find: (call) => (call.arg ? tied : (call.filter.positionId as { $in: string[] }).$in.map((id) => r(1, id))),
    });
    const tiePage = await tie.repo.findLeaderboard(query({ poolId: '0xpool', sort: 'nft_id_desc' }));
    expect(tiePage.positions.map((p) => p.positionId)).toEqual(['8', '30', '4']);
  });
});

describe('position.schema.ts declares Set R and the background set EXACTLY as the migration builds them', () => {
  const declared = PositionSchema.indexes() as Array<[Record<string, number>, Record<string, unknown>]>;
  const byName = new Map(declared.filter(([, o]) => typeof o.name === 'string').map(([k, o]) => [o.name as string, { key: k, options: o }]));

  it.each([...(SET_R_SPECS as Spec[]), ...(BACKGROUND_SPECS as Spec[])].map((s) => [s.name, s] as const))('%s', (_name, spec) => {
    const decl = byName.get(spec.name);
    expect(decl, `${spec.name} must be declared`).toBeDefined();
    expect(Object.entries(decl!.key)).toEqual(Object.entries(spec.key)); // key ORDER included
    expect(normalizeCollation(decl!.options.collation as never)).toEqual(normalizeCollation(spec.collation as never));
    expect(decl!.options.partialFilterExpression ?? null).toEqual(spec.partialFilterExpression ?? null);
    expect(Object.keys(decl!.options).sort()).toEqual(
      ['name', ...(normalizeCollation(spec.collation as never) ? ['collation'] : []), ...(spec.partialFilterExpression ? ['partialFilterExpression'] : [])].sort(),
    );
  });

  it('the simple-collation set carries NO collation option (the server stores `simple` as none; diffIndexes would flag it)', () => {
    for (const spec of BACKGROUND_SPECS as Spec[]) expect(byName.get(spec.name)!.options).not.toHaveProperty('collation');
  });

  it('no lbr_/bg_ name is declared that the script does not build', () => {
    const planned = new Set([...(SET_R_SPECS as Spec[]), ...(BACKGROUND_SPECS as Spec[])].map((s) => s.name));
    const extra = [...byName.keys()].filter((name) => /^(lbr|bg)_/.test(name) && !planned.has(name));
    expect(extra).toEqual([]);
  });

  it('no legacy index is declared any more — the metric seven and the unused eight (by key, by name, and by the script\'s own source check)', () => {
    expect(LEGACY_INDEXES).toHaveLength(LEGACY_METRIC_INDEXES.length + LEGACY_UNUSED_INDEXES.length);
    for (const legacy of LEGACY_INDEXES as Array<{ name: string; key: Record<string, number> }>) {
      expect(declared.some(([key]) => sameKey(key, legacy.key)), legacy.name).toBe(false);
      expect(byName.has(legacy.name), legacy.name).toBe(false);
    }
    const source = readFileSync(new URL('../src/database/schemas/position.schema.ts', import.meta.url), 'utf8');
    expect(legacyDeclarationsInSource(source)).toEqual([]);
  });

  it('every unused legacy index names a replacement that IS declared (or none — its readers are gone)', () => {
    for (const legacy of LEGACY_UNUSED_INDEXES as Array<{ name: string; replacedBy: string | null }>) {
      if (legacy.replacedBy !== null) expect(byName.has(legacy.replacedBy), `${legacy.name} → ${legacy.replacedBy}`).toBe(true);
    }
  });
});

describe('background readers', () => {
  it('distinctActiveTokenAddresses: one hinted distinct per leg on exactly {chainId, protocol, isActive: true}', async () => {
    const { repo, calls } = makeRepo({
      distinct: (call) => (call.arg === 'token0.address' ? ['0xAAA', '0xbbb', ''] : ['0xBBB', '0xccc', null]),
    });
    const out = await repo.distinctActiveTokenAddresses(42161, 'uniswap-v4');
    expect(calls.map((c) => [c.op, c.arg, c.opts.hint])).toEqual([
      ['distinct', 'token0.address', 'bg_active_token0'],
      ['distinct', 'token1.address', 'bg_active_token1'],
    ]);
    for (const c of calls) expect(c.filter).toEqual({ chainId: 42161, protocol: 'uniswap-v4', isActive: true });
    expect(out.sort()).toEqual(['0xaaa', '0xbbb', '0xccc']); // lowercased, de-duplicated across legs
  });

  it('distinctActiveTokenAddresses falls back unhinted when the shard lacks the index', async () => {
    const { repo, calls } = makeRepo({
      distinct: (call) => {
        if (call.opts.hint) throw MISSING_HINT;
        return ['0xaaa'];
      },
    });
    expect(await repo.distinctActiveTokenAddresses(1, 'uniswap-v4')).toEqual(['0xaaa']);
    expect(calls.map((c) => c.opts.hint).sort()).toEqual([undefined, undefined, 'bg_active_token0', 'bg_active_token1'].sort());
  });

  it('distinctActiveTokenAddresses on a server without distinct.hint (< 7.1): retried unhinted, alerted once, hint never sent again', async () => {
    // The shape MongoDB 7.0 answers (verified on 8.0.32 with a made-up field: same code, same wording).
    const unknownHint = Object.assign(new Error("BSON field 'distinctCommandRequest.hint' is an unknown field."), {
      code: 40415,
      codeName: 'IDLUnknownField',
    });
    const { repo, calls } = makeRepo({
      distinct: (call) => {
        if (call.opts.hint) throw unknownHint;
        return call.arg === 'token0.address' ? ['0xA'] : ['0xb'];
      },
    });
    const warn = vi.spyOn((repo as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn');
    expect((await repo.distinctActiveTokenAddresses(1, 'uniswap-v4')).sort()).toEqual(['0xa', '0xb']);
    expect(calls.map((c) => c.opts.hint ?? null).sort()).toEqual([null, null, 'bg_active_token0', 'bg_active_token1'].sort());
    const alerts = () => warn.mock.calls.map(([m]) => String(m)).filter((m) => m.includes('[alert]'));
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]).toContain('positions.distinct_hint_unsupported');
    // Not mistaken for a missing index: no "run the migration" alert.
    expect(alerts()[0]).not.toContain('hint_missing');
    // Later sweeps (any chain) go straight to the unhinted read.
    calls.length = 0;
    expect((await repo.distinctActiveTokenAddresses(42161, 'uniswap-v4')).sort()).toEqual(['0xa', '0xb']);
    expect(calls.map((c) => c.opts.hint ?? null)).toEqual([null, null]);
    for (const c of calls) expect(c.filter).toEqual({ chainId: 42161, protocol: 'uniswap-v4', isActive: true });
    expect(alerts()).toHaveLength(1);
  });

  it('distinctActiveTokenAddresses rethrows any OTHER unknown-field or server error (only `hint` is tolerated)', async () => {
    const otherField = Object.assign(new Error("BSON field 'distinctCommandRequest.readConcernX' is an unknown field."), {
      code: 40415,
      codeName: 'IDLUnknownField',
    });
    const other = makeRepo({ distinct: () => { throw otherField; } });
    await expect(other.repo.distinctActiveTokenAddresses(1, 'uniswap-v4')).rejects.toBe(otherField);
    const timeout = Object.assign(new Error('operation exceeded time limit'), { code: 50, codeName: 'MaxTimeMSExpired' });
    const slow = makeRepo({ distinct: () => { throw timeout; } });
    await expect(slow.repo.distinctActiveTokenAddresses(1, 'uniswap-v4')).rejects.toBe(timeout);
  });

  it('isUnsupportedHintError: 40415 naming hint (also wrapped in a cause); not another field, not BadValue', () => {
    const shape = (message: string, extra: Record<string, unknown> = { code: 40415, codeName: 'IDLUnknownField' }) =>
      Object.assign(new Error(message), extra);
    expect(isUnsupportedHintError(shape("BSON field 'distinctCommandRequest.hint' is an unknown field."))).toBe(true);
    expect(isUnsupportedHintError(shape("BSON field 'distinct.hint' is an unknown field."))).toBe(true);
    expect(isUnsupportedHintError(shape("BSON field 'hint' is an unknown field.", { code: 40415 }))).toBe(true);
    expect(isUnsupportedHintError(shape("BSON field 'distinct.hint' is an unknown field.", { codeName: 'IDLUnknownField' }))).toBe(true);
    expect(isUnsupportedHintError({ cause: shape("BSON field 'distinct.hint' is an unknown field.") })).toBe(true);
    expect(isUnsupportedHintError(shape("BSON field 'distinct.notahint' is an unknown field."))).toBe(false);
    expect(isUnsupportedHintError(shape("BSON field 'distinct.hintX' is an unknown field."))).toBe(false);
    expect(isUnsupportedHintError(shape("BSON field 'distinct.hint' is an unknown field.", { code: 2, codeName: 'BadValue' }))).toBe(false);
    expect(isUnsupportedHintError(MISSING_HINT)).toBe(false);
    expect(isUnsupportedHintError(null)).toBe(false);
  });

  it('Phase B walk: hinted to bg_active_walk for the active walk (both pending splits), unhinted with includeClosed', async () => {
    for (const pending of [undefined, true, false]) {
      const { repo, calls } = makeRepo();
      await repo.findActiveRefsWithTokensPage(1, 'uniswap-v4', 500, '42', { pending });
      expect(calls[0].filter).toMatchObject({ chainId: 1, protocol: 'uniswap-v4', isActive: true, positionId: { $gt: '42' } });
      expect(calls[0].opts.hint, String(pending)).toBe('bg_active_walk');
      expect(calls[0].opts.sort).toEqual({ positionId: 1 });
      expect(calls[0].opts.collation).toBeUndefined();
    }
    const { repo, calls } = makeRepo();
    await repo.findActiveRefsWithTokensPage(1, 'uniswap-v4', 500, '', { includeClosed: true });
    expect(calls[0].filter).toEqual({ chainId: 1, protocol: 'uniswap-v4' });
    expect(calls[0].opts.hint).toBeUndefined();
  });

  it('fee hot tier (off by default): unhinted since bg_fee_hot joined the drop set; the full tier keeps the planner on its isActive/tokenId index', async () => {
    const hot = makeRepo();
    await hot.repo.findFeeRefreshCandidates(1, 'uniswap-v4', '7', 200, { hotMinUsd: 50 });
    expect(hot.calls[0].opts.hint).toBeUndefined();
    expect(hot.calls[0].filter).toMatchObject({ isActive: true, 'metrics.inRange': true });
    expect(hot.calls[0].opts.sort).toEqual({ tokenId: 1 });
    const full = makeRepo();
    await full.repo.findFeeRefreshCandidates(1, 'uniswap-v4', '7', 200);
    expect(full.calls[0].opts.hint).toBeUndefined();
  });

  it('pool holder counts read bg_active_pool_owner, then the old bg_active_pool, then the poolId index, then no hint — one alert per missing index', async () => {
    const missing = new Set(['bg_active_pool_owner', 'bg_active_pool']);
    const { repo, calls } = makeRepo({
      aggregate: (call) => {
        if (missing.has(call.opts.hint as string)) throw MISSING_HINT;
        return [];
      },
    });
    const warn = vi.spyOn((repo as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn');
    await repo.countsByPoolIds(1, 'uniswap-v4', ['0xa']);
    expect(calls.map((c) => c.opts.hint)).toEqual(['bg_active_pool_owner', 'bg_active_pool', 'chainId_1_protocol_1_poolId_1']);
    // The SAME $match on every index: open positions only, whichever index the
    // shard has. Without `isActive: true` the partial index would still count
    // only open rows while the poolId / unhinted fallbacks counted closed ones
    // too — the counts would depend on which index a shard happens to have.
    for (const c of calls) {
      expect((c.arg as unknown[])[0]).toEqual({ $match: { chainId: 1, protocol: 'uniswap-v4', poolId: { $in: ['0xa'] }, isActive: true } });
    }
    missing.add('chainId_1_protocol_1_poolId_1');
    await repo.countsByPoolIds(1, 'uniswap-v4', ['0xb']);
    // Both pool indexes are remembered missing (skipped); poolId is tried, missing, then unhinted.
    expect(calls.map((c) => c.opts.hint)).toEqual([
      'bg_active_pool_owner',
      'bg_active_pool',
      'chainId_1_protocol_1_poolId_1',
      'chainId_1_protocol_1_poolId_1',
      undefined,
    ]);
    const alerts = warn.mock.calls.map(([m]) => String(m)).filter((m) => m.includes('[alert] positions.hint_missing'));
    expect(alerts).toHaveLength(3);
    expect(alerts[0]).toContain('index=bg_active_pool_owner');
    expect(alerts[0]).toContain('hinted to bg_active_pool');
    expect(alerts[1]).toContain('index=bg_active_pool ');
    expect(alerts[1]).toContain('hinted to chainId_1_protocol_1_poolId_1');
    expect(alerts[2]).toContain('querying unhinted');
  });

  it('every partial-index hint ANY reader sends carries a top-level isActive: true (find, count, distinct, aggregate)', async () => {
    // A hint naming a partial index is obeyed for a filter that does not imply
    // its expression and silently returns only the index's rows — so the
    // filter must say `isActive: true` itself, never rely on the index for it.
    // The legacy partial ones too: `bg_active_pool` is still a fallback hint.
    const partial = new Set(
      [...(SET_R_SPECS as Spec[]), ...(BACKGROUND_SPECS as Spec[]), ...(LEGACY_UNUSED_INDEXES as Spec[])]
        .filter((s) => s.partialFilterExpression)
        .map((s) => s.name),
    );
    const { repo, calls } = makeRepo();
    await repo.countsByPoolIds(1, 'uniswap-v4', ['0xA', '0xb']);
    await repo.findFeeRefreshCandidates(1, 'uniswap-v4', '7', 200, { hotMinUsd: 50 });
    await repo.findFeeRefreshCandidates(1, 'uniswap-v4', '', 200);
    for (const pending of [undefined, true, false]) await repo.findActiveRefsWithTokensPage(1, 'uniswap-v4', 500, '42', { pending });
    await repo.findActiveRefsWithTokensPage(1, 'uniswap-v4', 500, '', { includeClosed: true });
    await repo.distinctActiveTokenAddresses(1, 'uniswap-v4');
    for (const status of STATUSES) {
      const q = query({ poolId: '0xpool', status, activeOnly: status === 'active' });
      await repo.findLeaderboard(q);
      await repo.countLeaderboard(await repo.leaderboardPlan(q), 100);
    }
    const hinted = calls.filter((c) => typeof c.opts.hint === 'string' && partial.has(c.opts.hint as string));
    expect(new Set(hinted.map((c) => c.opts.hint))).toEqual(
      new Set(['bg_active_pool_owner', 'bg_active_walk', 'bg_active_token0', 'bg_active_token1']),
    );
    for (const c of hinted) {
      const filter = c.op === 'aggregate' ? (c.arg as Array<{ $match?: Record<string, unknown> }>)[0].$match : c.filter;
      expect(filter?.isActive, `${c.op} hinted ${String(c.opts.hint)}`).toBe(true);
    }
  });
});
