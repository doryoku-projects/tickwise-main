import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageLadderService } from '../src/common/cache/page-ladder.js';
import { readPathSnapshot, resetReadPathMeter } from '../src/common/cache/read-path-meter.js';
import { serveDeepPage } from '../src/common/deep-page.js';
import { ReadBudgetService } from '../src/common/read-budget.js';
import {
  arraySource,
  fetchDeepPageDocs,
  rowsAfter,
  sortSpecComparator,
  walkDeepPage,
  type DeepShard,
  type SortSpec,
} from '../src/common/shard-stream-merge.js';
import { observeHeartbeat, resetReplicationLag } from '../src/database/replication-lag.js';
import { QueryTimeoutException } from '../src/database/user-read.js';

/**
 * Deep pages make PROGRESS: no page is refused for its depth (the binding
 * decision). A walk that runs out of its request deadline keeps the rungs it
 * passed and a background walk carries on to the page, so the retry the 503
 * asks for lands next to it; a page past what the budget can re-anchor within
 * the staleness budget is served from an aged rung, FLAGGED. And a rung is
 * only ever as fresh as the prefix count it carries.
 */

type Row = { v: number; positionId: string };
const spec: SortSpec = { field: 'v', direction: -1, tieField: 'positionId', tieDirection: 1, collated: true };

function sortedRows(n: number): Row[] {
  const rows = Array.from({ length: n }, (_, i) => ({ v: n - Math.floor(i / 3), positionId: String(i + 1) }));
  return rows.sort(sortSpecComparator(spec) as (a: Row, b: Row) => number);
}

let t = 1_000_000;

beforeEach(() => {
  t = 1_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => t);
  resetReadPathMeter();
  resetReplicationLag();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetReplicationLag();
});

/** The real budget on a clock its own waits advance (no real sleeping). */
function budget(ratePerSec: number) {
  return new ReadBudgetService(
    { readBudgetDocsPerSec: ratePerSec, readBudgetBurstDocs: ratePerSec, leaderboardDeepWalkConcurrency: 2 } as never,
    undefined,
    { now: () => t, sleep: async (ms) => void (t += ms) },
  );
}

function serve(args: { rows: Row[]; skip: number; ladder: PageLadderService; budget: ReadBudgetService }) {
  const shard = (): DeepShard<Row> => ({ chainId: 1, open: (boundary) => arraySource(1, rowsAfter(spec, args.rows, boundary, 1)) });
  return serveDeepPage<Row, Row>({
    shards: () => [shard()],
    chains: [1],
    spec,
    skip: args.skip,
    limit: 100,
    maxTimeMS: 5_000,
    ladder: { store: args.ladder, key: 'pos|q' },
    budget: args.budget,
    config: { readStalenessBudgetMs: 45_000, leaderboardLadderMaxAgeMs: 600_000 },
    fetch: async (rows) => ({ docs: rows.map((r) => r.row), missingChains: [], errors: [] }),
    route: 'spec',
  });
}

const settledBackground = (b: ReadBudgetService) => vi.waitFor(() => expect(b.backgroundWalks).toBe(0), { timeout: 20_000 });

describe('a cold page deeper than one deadline can walk (the review\'s depth ceiling)', () => {
  it('skip 150,000 at 20k rows/s and a 5 s deadline: the first ask is a 503, the retry after Retry-After succeeds, unflagged', async () => {
    const rows = sortedRows(300_000);
    const b = budget(20_000);
    const ladder = new PageLadderService(undefined, undefined, () => t);
    // burst 20k + 5 s × 20k = 120k rows at most: the old code failed here on EVERY retry, recording nothing.
    await expect(serve({ rows, skip: 150_000, ladder, budget: b })).rejects.toBeInstanceOf(QueryTimeoutException);
    // …but it kept its rungs, and the background walk carried on to the page.
    await settledBackground(b);
    expect(readPathSnapshot().deepWalks.background).toMatchObject({ started: 1, finished: 1, failed: 0 });
    t += 5_000; // Retry-After
    const page = await serve({ rows, skip: 150_000, ladder, budget: b });
    expect(page.docs.map((r) => r.positionId)).toEqual(rows.slice(150_000, 150_100).map((r) => r.positionId));
    expect(page.dataAsOf).toBeUndefined(); // the offsets are ~11 s old: inside the budget
  }, 60_000);

  it('a page the budget cannot re-anchor within 45 s is still served — from an AGED rung, flagged with how old its offsets are', async () => {
    const rows = sortedRows(300_000);
    // 2k rows/s: 150k rows take 75 s to walk, longer than the staleness budget.
    const b = budget(2_000);
    const ladder = new PageLadderService(
      { readStalenessBudgetMs: 45_000, leaderboardLadderMaxAgeMs: 600_000 } as never,
      undefined,
      () => t,
    );
    const firstAsk = t;
    await expect(serve({ rows, skip: 150_000, ladder, budget: b })).rejects.toBeInstanceOf(QueryTimeoutException);
    await settledBackground(b);
    t += 5_000;
    const page = await serve({ rows, skip: 150_000, ladder, budget: b });
    expect(page.docs.map((r) => r.positionId)).toEqual(rows.slice(150_000, 150_100).map((r) => r.positionId));
    // Its offsets were counted from the first ask's walk: older than 45 s, so the page says so.
    expect(page.dataAsOf).toBe(firstAsk);
    expect(readPathSnapshot().deepWalks.fromAgedRung).toBe(1);
    expect(readPathSnapshot().staleServed.spec?.count).toBe(1);
  }, 60_000);
});

describe('rung age is inherited, never laundered (the review\'s rung-age repro)', () => {
  it('sequential paging past 45 s with inserts at the top: every page equals a fresh walk', async () => {
    let rows = Array.from({ length: 3_000 }, (_, i) => ({ v: 3_000 - i, positionId: String(i + 1) }));
    const sorted = () => [...rows].sort(sortSpecComparator(spec) as (a: Row, b: Row) => number);
    const ladder = new PageLadderService(undefined, undefined, () => t);
    const page = (skip: number, useLadder = true) => {
      const data = sorted();
      return walkDeepPage<Row>({
        shards: [{ chainId: 1, open: (boundary) => arraySource(1, rowsAfter(spec, data, boundary, 1)) }],
        spec,
        skip,
        limit: 100,
        ladder: useLadder ? { store: ladder, key: 'k' } : undefined,
        now: () => t,
      });
    };
    await page(1_000); // t=0: from the top, rungs 1,000 / 1,100
    t += 30_000;
    // 500 rows land at the TOP of the order.
    rows = rows.concat(Array.from({ length: 500 }, (_, i) => ({ v: 10_000 + i, positionId: String(100_000 + i) })));
    await page(1_100); // from rung 1,100 (30 s old, trusted) → records 1,200 carrying t=0
    for (const step of [0, 1, 2]) {
      t = 1_000_000 + 60_000 + step * 30_000;
      const skip = 1_200 + step * 100;
      const viaLadder = await page(skip);
      const truth = await page(skip, false);
      expect(viaLadder.rows[0]?.row.positionId).toBe(truth.rows[0]?.row.positionId);
    }
  });
});

describe('fetchDeepPageDocs: a page is the merged order of exactly the chains it shows', () => {
  const merged = (chains: number[]) =>
    chains
      .flatMap((chainId) => Array.from({ length: 50 }, (_, i) => ({ chainId, row: { v: 1_000 - i * 3 - chainId, positionId: `${chainId}-${i}` } })))
      .sort((a, b) => b.row.v - a.row.v);
  const walkOf = (chains: number[], limit = 10) => {
    const rows = merged(chains).slice(20, 20 + limit + 1);
    return { rows, missingChains: [], errors: [], exhausted: false, position: 20 + rows.length, walked: 20 + rows.length, from: 0, anchorAt: 0 };
  };

  it('a by-id fetch that fails once is asked again: no chain is dropped for a blip', async () => {
    let calls = 0;
    const out = await fetchDeepPageDocs({
      walk: walkOf([1, 2, 3]),
      limit: 10,
      chains: [1, 2, 3],
      fetch: async (rows) => {
        calls++;
        return calls === 1
          ? { docs: rows.filter((r) => r.chainId !== 2).map((r) => r.row), missingChains: [2], errors: [{ chainId: 2, error: new Error('blip') }] }
          : { docs: rows.map((r) => r.row), missingChains: [], errors: [] };
      },
      rewalk: async () => {
        throw new Error('not needed');
      },
    });
    expect(calls).toBe(2);
    expect(out.missingChains).toEqual([]);
    expect(out.docs).toHaveLength(10);
  });

  it('a chain whose fetch fails twice is dropped and the others WALKED AGAIN: no holes, ranks by position stay right', async () => {
    const rewalked: number[][] = [];
    const out = await fetchDeepPageDocs({
      walk: walkOf([1, 2, 3]),
      limit: 10,
      chains: [1, 2, 3],
      fetch: async (rows) => {
        const bad = rows.some((r) => r.chainId === 2);
        return bad
          ? { docs: rows.filter((r) => r.chainId !== 2).map((r) => r.row), missingChains: [2], errors: [{ chainId: 2, error: new Error('down') }] }
          : { docs: rows.map((r) => r.row), missingChains: [], errors: [] };
      },
      rewalk: async (live) => {
        rewalked.push(live);
        return walkOf(live);
      },
    });
    expect(rewalked).toEqual([[1, 3]]);
    expect(out.missingChains).toEqual([2]);
    // A full page of the OTHER chains' merged order (offset 20 of it), not 10 minus chain 2's rows.
    expect(out.docs.map((d) => d.positionId)).toEqual(merged([1, 3]).slice(20, 30).map((r) => r.row.positionId));
    expect(out.walk.rows.every((r) => r.chainId !== 2)).toBe(true);
  });

  it('throws when no chain is left', async () => {
    await expect(
      fetchDeepPageDocs({
        walk: walkOf([1]),
        limit: 10,
        chains: [1],
        fetch: async () => ({ docs: [], missingChains: [1], errors: [{ chainId: 1, error: new Error('gone') }] }),
        rewalk: async () => walkOf([]),
      }),
    ).rejects.toThrow('gone');
  });
});

describe('a deep page read from a secondary lagging past the budget is flagged', () => {
  it('dataAsOf = when the data was current (now − lag)', async () => {
    // A secondary 60 s behind the primary.
    observeHeartbeat('p:27017', { isWritablePrimary: true, lastWrite: { lastWriteDate: t } }, t, 10_000);
    observeHeartbeat('s:27017', { secondary: true, lastWrite: { lastWriteDate: t - 60_000 } }, t, 10_000);
    const rows = sortedRows(5_000);
    const page = await serve({ rows, skip: 2_000, ladder: new PageLadderService(undefined, undefined, () => t), budget: budget(20_000) });
    expect(page.docs).toHaveLength(100);
    expect(page.dataAsOf).toBe(t - 60_000);
  });

  it('no flag within the budget', async () => {
    observeHeartbeat('p:27017', { isWritablePrimary: true, lastWrite: { lastWriteDate: t } }, t, 10_000);
    observeHeartbeat('s:27017', { secondary: true, lastWrite: { lastWriteDate: t - 3_000 } }, t, 10_000);
    const page = await serve({ rows: sortedRows(5_000), skip: 2_000, ladder: new PageLadderService(undefined, undefined, () => t), budget: budget(20_000) });
    expect(page.dataAsOf).toBeUndefined();
  });
});
