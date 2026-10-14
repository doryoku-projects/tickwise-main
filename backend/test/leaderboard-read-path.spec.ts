import { describe, expect, it, vi } from 'vitest';
import {
  CHARTS_PROJECTION,
  DETAIL_PROJECTION,
  LIST_PROJECTION,
  PositionsRepository,
  type LeaderboardQuery,
} from '../src/database/positions.repository.js';
import { QueryTimeoutException, USER_READ_PREFERENCE } from '../src/database/user-read.js';

/** One recorded Mongoose call: the filter plus every chained option. */
interface Call {
  op: 'find' | 'findOne' | 'count' | 'aggregate';
  filter: Record<string, unknown>;
  arg?: unknown;
  opts: Record<string, unknown>;
}

type Handler = (call: Call) => unknown;

/** A fake shard model that records the query shape of every call it gets. */
function fakeModel(handlers: Partial<Record<Call['op'], Handler>> = {}) {
  const calls: Call[] = [];
  const query = (op: Call['op'], filter: Record<string, unknown>, arg?: unknown) => {
    const call: Call = { op, filter, arg, opts: {} };
    calls.push(call);
    const run = async () => (handlers[op] ? handlers[op]!(call) : op === 'count' ? 0 : []);
    const q: Record<string, unknown> = {};
    for (const method of ['select', 'sort', 'collation', 'hint', 'skip', 'limit', 'read', 'maxTimeMS', 'option', 'batchSize']) {
      q[method] = (value: unknown) => {
        call.opts[method] = value;
        return q;
      };
    }
    // `.lean()` both runs the query (awaited) and chains into `.cursor()` (a deep walk).
    q.lean = () => {
      const pending = run();
      return Object.assign(pending, {
        cursor: () => {
          let rows: unknown[] | undefined;
          let at = 0;
          return {
            next: async () => {
              rows ??= (await pending) as unknown[];
              return at < rows.length ? rows[at++] : null;
            },
            close: async () => undefined,
          };
        },
      });
    };
    q.exec = run;
    q.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => run().then(resolve, reject);
    return q;
  };
  const model = {
    find: (filter: Record<string, unknown>, projection?: unknown) => query('find', filter, projection),
    findOne: (filter: Record<string, unknown>) => query('findOne', filter),
    countDocuments: (filter: Record<string, unknown>, options?: unknown) => query('count', filter, options),
    aggregate: (pipeline: unknown) => query('aggregate', {}, pipeline),
  };
  return { model, calls };
}

function makeRepo(
  handlers: Partial<Record<Call['op'], Handler>> = {},
  exclusions: { addresses: string[]; ok: boolean } = { addresses: [], ok: true },
) {
  const { model, calls } = fakeModel(handlers);
  const tokens = { readyLeaderboardExclusions: vi.fn(async () => exclusions) };
  const repo = new PositionsRepository({ positionModel: () => model } as never, tokens as never);
  return { repo, calls, tokens };
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
    range: 'in',
    minValueUsd: 500,
    minPoolTvl: 1000,
    includeRisky: true,
    ...over,
  };
}

const row = (positionId: string, extra: Record<string, unknown> = {}) => ({
  chainId: 1,
  protocol: 'uniswap-v4',
  positionId,
  tokenId: positionId,
  metrics: { aprExGas: 0, underlyingValueUsd: 0 },
  ...extra,
});

const OWNER = '0x1111111111111111111111111111111111111111';
const POOL = '0x' + 'ab'.repeat(32);
const COLLATION = { locale: 'en', numericOrdering: true };

describe('query shape is chosen before the collation', () => {
  it('ranked view: collated, hinted to its Set R index, projected, secondary-preferred, 5 s budget', async () => {
    const { repo, calls } = makeRepo();
    await repo.findLeaderboard(query());
    const [find] = calls;
    expect(find.opts.collation).toEqual(COLLATION);
    expect(find.opts.hint).toBe('lbr_apr_active');
    expect(find.opts.sort).toEqual({ 'metrics.aprExGas': -1, positionId: 1 });
    expect(find.opts.select).toBe(LIST_PROJECTION);
    expect(find.opts.read).toBe(USER_READ_PREFERENCE);
    expect(find.opts.maxTimeMS).toBe(5_000);
    expect((USER_READ_PREFERENCE as unknown as { mode: string; maxStalenessSeconds: number }).mode).toBe(
      'secondaryPreferred',
    );
    expect((USER_READ_PREFERENCE as unknown as { maxStalenessSeconds: number }).maxStalenessSeconds).toBe(120);
  });

  it('id lookup: NO collation and NO hint (the planner ORs the positionId and tokenId indexes)', async () => {
    const { repo, calls } = makeRepo();
    await repo.findLeaderboard(query({ positionId: '3468131' }));
    expect(calls).toHaveLength(1);
    expect(calls[0].opts.collation).toBeUndefined();
    expect(calls[0].opts.hint).toBeUndefined();
    expect(calls[0].opts.sort).toBeUndefined(); // ordered in Node
  });

  it('pool scope: no collation; open positions read the partial active-pool index, other statuses the poolId index', async () => {
    const { repo, calls } = makeRepo({
      find: (call) => (call.arg ? [{ positionId: '1', tokenId: '1' }] : [row('1')]),
    });
    await repo.findLeaderboard(query({ poolId: POOL }));
    expect(calls[0].filter.poolId).toBe(POOL);
    expect(calls[0].filter.isActive).toBe(true);
    expect(calls[0].opts.collation).toBeUndefined();
    expect(calls[0].opts.hint).toBe('bg_active_pool_owner');
    // phase 2: the window's rows, by the unique positionId index
    expect(calls[1].filter).toEqual({ chainId: 1, protocol: 'uniswap-v4', positionId: { $in: ['1'] } });
    expect(calls[1].opts.hint).toBe('chainId_1_protocol_1_positionId_1');
    expect(calls[1].opts.select).toBe(LIST_PROJECTION);

    for (const status of ['all', 'inactive'] as const) {
      const other = makeRepo({ find: (call) => (call.arg ? [{ positionId: '1', tokenId: '1' }] : [row('1')]) });
      await other.repo.findLeaderboard(query({ poolId: POOL, status, activeOnly: false, sort: 'pnl' }));
      expect(other.calls[0].opts.hint, status).toBe('chainId_1_protocol_1_poolId_1');
    }
  });

  it('owner: keeps the collation and hints the collated owner index (also when a pool is given)', async () => {
    const { repo, calls } = makeRepo();
    await repo.findLeaderboard(query({ owner: OWNER, poolId: POOL }));
    expect(calls[0].opts.collation).toEqual(COLLATION);
    expect(calls[0].opts.hint).toBe('chainId_1_protocol_1_owner_1');
  });

  it('countDocuments makes the SAME collation choice and its own hint, capped, 8 s budget', async () => {
    for (const [over, collated, hint] of [
      // ranked: a count serves no sort — the value bound picks lbr_value
      [{}, true, 'lbr_value'],
      [{ owner: OWNER }, true, 'chainId_1_protocol_1_owner_1'],
      [{ poolId: POOL }, false, 'bg_active_pool_owner'],
      [{ positionId: '7' }, false, undefined],
    ] as const) {
      const { repo, calls } = makeRepo({ count: () => 25_000 });
      const plan = await repo.leaderboardPlan(query(over));
      expect(await repo.countLeaderboard(plan, 25_000)).toEqual({ count: 25_000, capped: true });
      const [count] = calls;
      expect(count.op).toBe('count');
      expect(count.arg).toEqual({ limit: 25_000 });
      expect(count.opts.collation).toEqual(collated ? COLLATION : undefined);
      expect(count.opts.hint).toBe(hint);
      expect(count.opts.maxTimeMS).toBe(8_000);
      expect(count.opts.read).toBe(USER_READ_PREFERENCE);
    }
  });
});

describe('a timed-out count', () => {
  it('is a 503 (the /count route answers Retry-After), not a raw MongoServerError', async () => {
    const { repo } = makeRepo({
      count: () => {
        throw Object.assign(new Error('x'), { code: 50 });
      },
    });
    const plan = await repo.leaderboardPlan(query());
    await expect(repo.countLeaderboard(plan, 25_000)).rejects.toBeInstanceOf(QueryTimeoutException);
  });
});

describe('uncollated shapes order rows exactly like the collated query', () => {
  it('pool scope + nft sort: numeric tokenId order, not lexicographic', async () => {
    const keys = ['10', '9', '100', '2'].map((id) => ({ positionId: id, tokenId: id }));
    const { repo } = makeRepo({
      find: (call) => {
        if (call.arg) return keys; // phase 1: sort keys only
        const ids = (call.filter.positionId as { $in: string[] }).$in;
        return [...ids].reverse().map((id) => row(id)); // arrive in any order
      },
    });
    const page = await repo.findLeaderboard(query({ poolId: POOL, sort: 'nft_id_asc', limit: 3 }));
    expect(page.positions.map((p) => p.positionId)).toEqual(['2', '9', '10']);
    expect(page.hasMore).toBe(true);
    expect(page.total).toBe(4); // the pool shape learns the exact count for free
  });

  it('metric ties break on numeric positionId, like numericOrdering', async () => {
    const keys = [
      { positionId: '100', metrics: { underlyingValueUsd: 5 } },
      { positionId: '99', metrics: { underlyingValueUsd: 5 } },
      { positionId: '7', metrics: { underlyingValueUsd: 9 } },
    ];
    const { repo } = makeRepo({
      find: (call) =>
        call.arg ? keys : (call.filter.positionId as { $in: string[] }).$in.map((id) => row(id)),
    });
    const page = await repo.findLeaderboard(query({ poolId: POOL, sort: 'underlying_value' }));
    expect(page.positions.map((p) => p.positionId)).toEqual(['7', '99', '100']);
  });
});

describe('hasMore and the window cache', () => {
  it('reads one row past the 50-row window, so hasMore is exact', async () => {
    const rows = Array.from({ length: 51 }, (_, i) => row(String(i)));
    const { repo, calls } = makeRepo({ find: () => rows });
    const page2 = await repo.findLeaderboard(query({ page: 2 }));
    expect(calls[0].opts.skip).toBe(0);
    expect(calls[0].opts.limit).toBe(51);
    expect(page2.positions.map((p) => p.positionId)).toEqual(rows.slice(25, 50).map((r) => r.positionId));
    expect(page2.hasMore).toBe(true);

    const short = makeRepo({ find: () => rows.slice(0, 50) });
    expect((await short.repo.findLeaderboard(query({ page: 2 }))).hasMore).toBe(false);
  });

  it('serves page 1 and page 2 of the same view from ONE cached window', async () => {
    const { repo, calls } = makeRepo({ find: () => [row('1'), row('2')] });
    expect((await repo.findLeaderboard(query())).cache).toBe('miss');
    expect((await repo.findLeaderboard(query({ page: 2 }))).cache).toBe('hit');
    expect(calls).toHaveLength(1);
  });

  it('does not cache a result computed while the exclusion set has never loaded', async () => {
    const { repo, calls } = makeRepo({ find: () => [row('1')] }, { addresses: [], ok: false });
    await repo.findLeaderboard(query());
    await repo.findLeaderboard(query());
    expect(calls).toHaveLength(2);
  });

  it('walks a page too deep for a window: sort keys only, no skip, bounded by the page; then the page by id', async () => {
    const keys = Array.from({ length: 1300 }, (_, i) => ({ positionId: String(i + 1), metrics: { aprExGas: 5000 - i } }));
    const { repo, calls } = makeRepo({
      find: (call) => {
        if (call.opts.select && (call.opts.select as Record<string, number>).positionId === 1 && !('owner' in (call.opts.select as object))) {
          return keys.slice(0, call.opts.limit as number);
        }
        return (call.filter.positionId as { $in: string[] }).$in.map((id) => row(id));
      },
    });
    const page = await repo.findLeaderboard(query({ page: 50, limit: 25 }));
    const [walk, fetch] = calls;
    // ONE streaming read of the sort keys from the top (no ladder here) — no Mongo skip,
    // and never more rows than the page needs: 1,225 counted and dropped + 26 kept.
    expect(walk.opts.select).toEqual({ _id: 0, positionId: 1, 'metrics.aprExGas': 1 });
    expect(walk.opts.skip).toBeUndefined();
    expect(walk.opts.limit).toBe(1225 + 26);
    expect(walk.opts.batchSize).toBe(1225 + 26);
    expect(walk.opts.sort).toEqual({ 'metrics.aprExGas': -1, positionId: 1 });
    expect(walk.opts.collation).toEqual(COLLATION);
    expect(walk.opts.hint).toBe('lbr_apr_active');
    expect(walk.opts.read).toBe(USER_READ_PREFERENCE);
    // Then only the page's documents, by the unique positionId index, in the walk's order.
    expect(fetch.filter).toEqual({
      chainId: 1,
      protocol: 'uniswap-v4',
      positionId: { $in: keys.slice(1225, 1250).map((k) => k.positionId) },
    });
    expect(fetch.opts.select).toBe(LIST_PROJECTION);
    expect(page.positions.map((p) => p.positionId)).toEqual(keys.slice(1225, 1250).map((k) => k.positionId));
    expect(page.hasMore).toBe(true);
    expect(page.cache).toBe('miss');
  });
});

describe('a Mongo maxTimeMS expiry (code 50)', () => {
  const timeout = Object.assign(new Error('operation exceeded time limit'), { code: 50, codeName: 'MaxTimeMSExpired' });

  it('serves the retained window as stale when one exists', async () => {
    const { repo } = makeRepo({
      find: () => {
        throw timeout;
      },
    });
    const key = await repo.leaderboardWindowKey(query());
    // Older than the 5-min stale age (so `get` would reload), inside the fallback.
    repo.primeLeaderboardWindow(key!, [row('42') as never], Date.now() - 10 * 60_000);
    const page = await repo.findLeaderboard(query());
    expect(page.cache).toBe('stale');
    expect(page.positions.map((p) => p.positionId)).toEqual(['42']);
  });

  it('serving the retained window also refreshes it with the longer budget, before the retention runs out', async () => {
    const { repo, calls } = makeRepo({
      find: (call) => {
        if (call.opts.maxTimeMS === 5_000) throw timeout;
        return [row('43')];
      },
    });
    const key = await repo.leaderboardWindowKey(query());
    repo.primeLeaderboardWindow(key!, [row('42') as never], Date.now() - 10 * 60_000);
    expect((await repo.findLeaderboard(query())).positions.map((p) => p.positionId)).toEqual(['42']);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.map((c) => c.opts.maxTimeMS)).toEqual([5_000, 30_000]);
    const next = await repo.findLeaderboard(query());
    expect(next.cache).toBe('hit');
    expect(next.positions.map((p) => p.positionId)).toEqual(['43']);
  });

  it('is a 503 QueryTimeoutException when nothing is retained', async () => {
    const { repo } = makeRepo({
      find: () => {
        throw timeout;
      },
    });
    await expect(repo.findLeaderboard(query())).rejects.toBeInstanceOf(QueryTimeoutException);
  });

  it('nothing retained: the 503 starts ONE background rescue read with a longer budget; the next request is a hit', async () => {
    const { repo, calls } = makeRepo({
      find: (call) => {
        if (call.opts.maxTimeMS === 5_000) throw timeout;
        return [row('7')];
      },
    });
    const err = await repo.findLeaderboard(query()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QueryTimeoutException);
    expect((err as QueryTimeoutException).retryAfterSeconds).toBe(15);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.map((c) => c.opts.maxTimeMS)).toEqual([5_000, 30_000]);
    const page = await repo.findLeaderboard(query());
    expect(page.cache).toBe('hit');
    expect(page.positions.map((p) => p.positionId)).toEqual(['7']);
    expect(calls).toHaveLength(2);
  });

  it('a rescue that times out too is not retried for a while, and the 503 says so', async () => {
    const { repo, calls } = makeRepo({
      find: () => {
        throw timeout;
      },
    });
    await expect(repo.findLeaderboard(query())).rejects.toBeInstanceOf(QueryTimeoutException);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toHaveLength(2); // the request read, then the rescue
    const again = await repo.findLeaderboard(query()).catch((e: unknown) => e);
    expect((again as QueryTimeoutException).retryAfterSeconds).toBe(60);
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toHaveLength(3); // the request read only: no second rescue
  });

  it('is not swallowed when it is some other error', async () => {
    const boom = new Error('connection reset');
    const { repo } = makeRepo({
      find: () => {
        throw boom;
      },
    });
    await expect(repo.findLeaderboard(query())).rejects.toBe(boom);
  });
});

describe('cache keys come from the query that runs', () => {
  /**
   * One variant per LeaderboardQuery field that can change a result. Typed as a
   * Record over the interface's keys, so adding a field to LeaderboardQuery
   * without a variant here is a compile error — and the assertion below proves
   * each one reaches the key.
   */
  // On a NON-rate sort: a rate sort makes every non-Closed view the Active
  // view (same query, same key — see the next test), so status/activeOnly only
  // change a rate-sort key via the Closed tab.
  const VARIANTS: Record<Exclude<keyof LeaderboardQuery, 'page' | 'limit'>, Partial<LeaderboardQuery>> = {
    chainId: { chainId: 42161 },
    protocol: { protocol: 'uniswap-v3' },
    sort: { sort: 'age' },
    activeOnly: { status: undefined, activeOnly: false },
    status: { status: 'all' },
    range: { range: 'out' },
    minValueUsd: { minValueUsd: 0 },
    minPoolTvl: { minPoolTvl: 0 },
    includeRisky: { includeRisky: false },
    positionId: { positionId: '7' },
    poolId: { poolId: POOL },
    owner: { owner: OWNER },
    assetClass: { assetClass: 'equity' },
  };

  it('every filter parameter changes the window key', async () => {
    const { repo } = makeRepo();
    const base = (await repo.leaderboardPlan(query({ sort: 'pnl' }))).key;
    for (const [field, variant] of Object.entries(VARIANTS)) {
      const key = (await repo.leaderboardPlan(query({ sort: 'pnl', ...variant }))).key;
      expect(key, `${field} must be part of the cache key`).not.toBe(base);
    }
  });

  it('a rate sort runs the Active filter on the All tab (and activeOnly=false), so they share a window', async () => {
    const { repo } = makeRepo();
    for (const sort of ['apr', 'fee_apr', 'roi']) {
      const active = await repo.leaderboardPlan(query({ sort }));
      const all = await repo.leaderboardPlan(query({ sort, status: 'all', activeOnly: false }));
      const loose = await repo.leaderboardPlan(query({ sort, status: undefined, activeOnly: false }));
      expect(all.filter, sort).toEqual(active.filter);
      expect(loose.filter, sort).toEqual(active.filter);
      expect(all.key).toBe(active.key);
      const closed = await repo.leaderboardPlan(query({ sort, status: 'inactive', activeOnly: false }));
      expect(closed.key).not.toBe(active.key);
    }
  });

  it('page and limit do not (they select a window, they do not change the query)', async () => {
    const { repo } = makeRepo();
    const a = await repo.leaderboardPlan(query({ page: 1, limit: 25 }));
    const b = await repo.leaderboardPlan(query({ page: 3, limit: 10 }));
    expect(a.key).toBe(b.key);
  });

  it('a count key ignores the sort but not the filter the sort implies', async () => {
    const { repo } = makeRepo();
    const apr = await repo.leaderboardPlan(query({ sort: 'apr' }));
    const roi = await repo.leaderboardPlan(query({ sort: 'roi' }));
    const value = await repo.leaderboardPlan(query({ sort: 'underlying_value', includeRisky: false }));
    const aprSafe = await repo.leaderboardPlan(query({ sort: 'apr', includeRisky: false }));
    expect(apr.countKey).toBe(roi.countKey); // same rate-sort filter
    expect(apr.key).not.toBe(roi.key);
    expect(value.countKey).not.toBe(aprSafe.countKey); // performanceReady only on performance sorts
  });

  it('the exclusion list is ONE merged $nin per leg', async () => {
    const { repo } = makeRepo({}, { addresses: ['0xbad', '0xdead'], ok: true });
    const plan = await repo.leaderboardPlan(query());
    const clauses = (plan.filter.$and as Array<Record<string, unknown>>).filter((c) => 'token0.address' in c);
    expect(clauses).toEqual([
      { 'token0.address': { $nin: ['0xbad', '0xdead'] }, 'token1.address': { $nin: ['0xbad', '0xdead'] } },
    ]);
  });
});

describe('findOneForRead (detail and charts)', () => {
  it('projects, reads secondary-preferred with a 2 s budget', async () => {
    const { repo, calls } = makeRepo({ findOne: () => row('9') });
    await repo.findOneForRead(1, 'uniswap-v4', '9', CHARTS_PROJECTION);
    expect(calls[0].filter).toEqual({ chainId: 1, protocol: 'uniswap-v4', positionId: '9' });
    expect(calls[0].opts.select).toEqual(CHARTS_PROJECTION);
    expect(calls[0].opts.read).toBe(USER_READ_PREFERENCE);
    expect(calls[0].opts.maxTimeMS).toBe(2_000);
  });

  it('defaults to the detail projection, which drops every internal field', async () => {
    const { repo, calls } = makeRepo({ findOne: () => row('9') });
    await repo.findOneForRead(1, 'uniswap-v4', '9');
    const projection = calls[0].opts.select as Record<string, number>;
    expect(projection).toEqual(DETAIL_PROJECTION);
    for (const internal of ['rawSubgraph', 'staleMisses', 'lastVerifiedAt', 'txSyncStatus', 'rpcFeesBlock', '__v']) {
      expect(projection[internal]).toBeUndefined();
    }
    expect(projection._id).toBe(0);
  });

  it('turns a timeout into a 503', async () => {
    const { repo } = makeRepo({
      findOne: () => {
        throw Object.assign(new Error('x'), { code: 50 });
      },
    });
    await expect(repo.findOneForRead(1, 'uniswap-v4', '9')).rejects.toBeInstanceOf(QueryTimeoutException);
  });
});

describe('countsByPoolIds', () => {
  it('aggregates only pools it has not counted in the last 60 s, with a 3 s budget', async () => {
    const { repo, calls } = makeRepo({
      aggregate: () => [{ _id: '0xaaa', positionsCount: 3, holdersCount: 2 }],
    });
    const first = await repo.countsByPoolIds(1, 'uniswap-v4', ['0xAAA', '0xbbb']);
    expect(first.get('0xaaa')).toEqual({ positionsCount: 3, holdersCount: 2 });
    expect(first.has('0xbbb')).toBe(false);
    expect(calls[0].opts.read).toBe(USER_READ_PREFERENCE);
    expect(calls[0].opts.option).toEqual({ maxTimeMS: 3_000 });
    expect(calls[0].opts.hint).toBe('bg_active_pool_owner');

    const again = await repo.countsByPoolIds(1, 'uniswap-v4', ['0xaaa', '0xbbb']);
    expect(again.get('0xaaa')).toEqual({ positionsCount: 3, holdersCount: 2 });
    expect(calls).toHaveLength(1); // both answered from cache, the zero included
  });

  it('a timeout with nothing retained is null ("not known yet"), never a 503 or a fabricated 0/0', async () => {
    let fail = true;
    const { repo, calls } = makeRepo({
      aggregate: (call) => {
        if (fail && (call.opts.option as { maxTimeMS: number }).maxTimeMS === 3_000) {
          throw Object.assign(new Error('x'), { code: 50 });
        }
        return [{ _id: '0xaaa', positionsCount: 9, holdersCount: 4 }];
      },
    });
    const first = await repo.countsByPoolIds(1, 'uniswap-v4', ['0xaaa']);
    expect(first.get('0xaaa')).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    // …and it was counted off the request path with the long budget.
    expect(calls).toHaveLength(2);
    expect(calls[1].opts.option).toEqual({ maxTimeMS: 20_000 });
    fail = false;
    const next = await repo.countsByPoolIds(1, 'uniswap-v4', ['0xaaa']);
    expect(next.get('0xaaa')).toEqual({ positionsCount: 9, holdersCount: 4 });
    expect(calls).toHaveLength(2); // the background count is what answered
  });

  it('a stale count is served at once and recounted in the background', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      let n = 1;
      const { repo, calls } = makeRepo({
        aggregate: () => [{ _id: '0xaaa', positionsCount: n, holdersCount: 1 }],
      });
      await repo.countsByPoolIds(1, 'uniswap-v4', ['0xaaa']);
      n = 2;
      vi.setSystemTime(Date.now() + 10 * 60_000); // past the 2-min stale age, inside retention
      const served = await repo.countsByPoolIds(1, 'uniswap-v4', ['0xaaa']);
      expect(served.get('0xaaa')).toEqual({ positionsCount: 1, holdersCount: 1 }); // no inline wait
      await vi.waitFor(() => expect(calls).toHaveLength(2));
      expect(calls[1].opts.option).toEqual({ maxTimeMS: 20_000 });
      await new Promise((r) => setTimeout(r, 0)); // let the background count land
      const fresh = await repo.countsByPoolIds(1, 'uniswap-v4', ['0xaaa']);
      expect(fresh.get('0xaaa')).toEqual({ positionsCount: 2, holdersCount: 1 });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a hinted index the shard does not have', () => {
  const missingHint = Object.assign(
    new Error('error processing query: … planner returned error :: caused by :: hint provided does not correspond to an existing index'),
    { code: 2, codeName: 'BadValue' },
  );

  it('retries once unhinted, alerts once, and skips the hint on the next queries', async () => {
    const { repo, calls } = makeRepo({
      find: (call) => {
        if (call.opts.hint) throw missingHint;
        return [row('1')];
      },
    });
    const warn = vi.spyOn((repo as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn');
    const page = await repo.findLeaderboard(query({ owner: OWNER }));
    expect(page.positions.map((p) => p.positionId)).toEqual(['1']);
    expect(calls.map((c) => c.opts.hint)).toEqual(['chainId_1_protocol_1_owner_1', undefined]);
    // Another owner (a different window): straight to the unhinted plan, no new alert.
    await repo.findLeaderboard(query({ owner: '0x2222222222222222222222222222222222222222' }));
    expect(calls.map((c) => c.opts.hint)).toEqual(['chainId_1_protocol_1_owner_1', undefined, undefined]);
    expect(warn.mock.calls.filter(([m]) => String(m).includes('[alert] positions.hint_missing'))).toHaveLength(1);
  });

  it('covers the count, the pool-scope reads and the pool-count aggregation too', async () => {
    const throwIfHinted = (call: Call, value: unknown) => {
      if (call.opts.hint) throw missingHint;
      return value;
    };
    const { repo } = makeRepo({
      count: (call) => throwIfHinted(call, 3),
      find: (call) => throwIfHinted(call, call.arg ? [{ positionId: '1', tokenId: '1' }] : [row('1')]),
      aggregate: (call) => throwIfHinted(call, [{ _id: '0xaaa', positionsCount: 1, holdersCount: 1 }]),
    });
    const plan = await repo.leaderboardPlan(query({ owner: OWNER }));
    expect(await repo.countLeaderboard(plan, 25_000)).toEqual({ count: 3, capped: false });
    expect((await repo.findLeaderboard(query({ poolId: POOL }))).positions).toHaveLength(1);
    expect((await repo.countsByPoolIds(1, 'uniswap-v4', ['0xaaa'])).get('0xaaa')).toEqual({
      positionsCount: 1,
      holdersCount: 1,
    });
  });

  it('any other planner error is not swallowed', async () => {
    const other = Object.assign(new Error('bad $in'), { code: 2, codeName: 'BadValue' });
    const { repo } = makeRepo({
      find: () => {
        throw other;
      },
    });
    await expect(repo.findLeaderboard(query({ owner: OWNER }))).rejects.toBe(other);
  });
});

describe('what the warmup reads off the repository', () => {
  it('a user read stamps the demand signal; a warmup read does not', async () => {
    const { repo } = makeRepo({ find: () => [row('1')] });
    expect(repo.lastLeaderboardReadAt).toBe(0);
    await repo.warmLeaderboardWindow(query(), 15_000);
    expect(repo.lastLeaderboardReadAt).toBe(0);
    await repo.findLeaderboard(query());
    expect(repo.lastLeaderboardReadAt).toBeGreaterThan(0);
  });

  it('a window age is known once it is cached, and gone past its stale age', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { repo } = makeRepo({ find: () => [row('1')] });
      expect(await repo.leaderboardWindowAgeMs(query())).toBeUndefined();
      await repo.warmLeaderboardWindow(query(), 15_000);
      vi.setSystemTime(Date.now() + 10_000);
      expect(await repo.leaderboardWindowAgeMs(query())).toBe(10_000);
      // Past the 30 s stale age (33 s at the longest jitter) it is no longer servable.
      vi.setSystemTime(Date.now() + 24_000);
      expect(await repo.leaderboardWindowAgeMs(query())).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('peekLeaderboardWindow: the cached window with its storedAt, with NO read; gone past its stale age', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const { repo, calls } = makeRepo({ find: () => [row('1')] });
      expect(await repo.peekLeaderboardWindow(query())).toBeUndefined();
      await repo.warmLeaderboardWindow(query(), 15_000);
      const storedAt = Date.now();
      const reads = calls.length;
      vi.setSystemTime(storedAt + 10_000);
      const peeked = await repo.peekLeaderboardWindow(query());
      expect(peeked).toMatchObject({ key: await repo.leaderboardWindowKey(query()), storedAt });
      expect(peeked?.rows.map((r) => r.positionId)).toEqual(['1']);
      expect(calls.length).toBe(reads); // a peek never reads
      // Past the 30 s stale age (33 s at the longest jitter): not servable, not peeked.
      vi.setSystemTime(storedAt + 34_000);
      expect(await repo.peekLeaderboardWindow(query())).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('peekLeaderboardWindow: nothing for a plan that is not cacheable (no exclusion set yet)', async () => {
    const { repo } = makeRepo({ find: () => [row('1')] }, { addresses: [], ok: false });
    const key = await repo.leaderboardWindowKey(query());
    repo.primeLeaderboardWindow(key!, [row('1') as never], Date.now());
    expect(await repo.peekLeaderboardWindow(query())).toBeUndefined();
  });
});
