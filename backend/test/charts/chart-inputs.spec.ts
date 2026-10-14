/*
 * ChartInputsService: what a chart or detail open costs the indexer, and what it
 * returns when the indexer fails or is slow.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { InputBatch, positionHistoryFingerprint } from '../../src/charts/chart-inputs.service.js';
import { currentIndexerContext, runInLane, type IndexerContext } from '../../src/subgraph/hyperindex/indexer-context.js';
import { isDegradedPayload } from '../../src/v1/metering.interceptor.js';
import { CHAIN, NOW_MS, POOL, PROTO } from './chart-fixtures.js';
import type { FakeCall } from './fake-subgraph.js';
import { makeWorld, rootCount } from './world.js';

const ALL_POSITION_ROOTS = ['poolDayDatas', 'ticks', 'tokenDayDatas', 'tokenDayDatas', 'positionTransactions'];

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** A 429 the way graphql-request surfaces one. */
function rateLimited(): Error {
  return Object.assign(new Error('indexer is rate limiting'), { response: { status: 429 } });
}

function interactive(deadlineInMs: number, signal?: AbortSignal): IndexerContext {
  return { lane: 'interactive', job: '/api/top-positions/:id/charts', deadlineAt: Date.now() + deadlineInMs, signal };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('one combined request per cold open', () => {
  it('sends every missing position input in ONE document', async () => {
    const w = makeWorld();
    const charts = await w.charts.getPositionCharts(CHAIN, PROTO, '1001', 'all');
    expect(w.fake.calls).toHaveLength(1);
    expect(w.fake.calls[0]!.roots).toEqual(ALL_POSITION_ROOTS);
    expect(charts.positionSeries).not.toBeNull();
    expect(charts.partial).toBeUndefined();
  });

  it('a warm reopen and every range switch cost nothing', async () => {
    const w = makeWorld();
    await w.charts.getPositionCharts(CHAIN, PROTO, '1001', 'all');
    for (const range of ['30d', '60d', '90d', '180d', 'all'] as const) {
      await w.charts.getPositionCharts(CHAIN, PROTO, '1001', range);
    }
    expect(w.fake.calls).toHaveLength(1);
  });

  it('pool charts reuse the ticks and day data a position open cached; only pool state is read', async () => {
    const w = makeWorld();
    await w.charts.getPositionCharts(CHAIN, PROTO, '1001', 'all');
    const pool = await w.charts.getPoolCharts(CHAIN, PROTO, POOL, 'all');
    expect(w.fake.calls).toHaveLength(2);
    expect(w.fake.calls[1]!.roots).toEqual(['pool']);
    expect(pool.liquidityDistribution.ticks.length).toBeGreaterThan(0);
    expect(pool.liquidityDistribution.currentTick).toBe(198050);
  });

  it('a cold pool chart is one document too', async () => {
    const w = makeWorld();
    await w.charts.getPoolCharts(CHAIN, PROTO, POOL, '30d');
    expect(w.fake.calls).toHaveLength(1);
    expect(w.fake.calls[0]!.roots).toEqual(['pool', 'poolDayDatas', 'ticks']);
  });
});

describe('detail and charts share one transaction walk', () => {
  it('charts first: the newest page rides in the combined document, ONE full walk follows, detail joins it', async () => {
    const lanes: Array<{ query: string; skip: unknown; lane: string; job?: string }> = [];
    const w = makeWorld({
      subgraph: {
        onCall: (call) =>
          lanes.push({ query: call.query, skip: call.variables.skip, lane: currentIndexerContext().lane, job: currentIndexerContext().job }),
      },
    });
    const [charts, detail] = await Promise.all([
      w.charts.getPositionCharts(CHAIN, PROTO, '1003', 'all'),
      w.leaderboard.getPosition(CHAIN, PROTO, '1003'),
    ]);
    // Outside a request nothing is cut short: both wait for the full history.
    expect(charts.positionSeries).not.toBeNull();
    expect(charts.partial).toBeUndefined();
    expect((detail as unknown as { transactions: unknown[] }).transactions).toHaveLength(2346);
    // The combined document carries the NEWEST page (busy position: 1000 of
    // 2,346 rows, so it is only the head) …
    expect(w.fake.calls[0]!.roots).toEqual(ALL_POSITION_ROOTS);
    expect(w.fake.calls[0]!.query).toContain('orderDirection: desc');
    // … then ONE oldest-first walk of the whole history, on the refresh lane,
    // shared by both requests: three pages, each read once.
    const walk = lanes.filter((call) => call.query.includes('query Txns('));
    expect(walk.map((call) => call.skip)).toEqual([0, 1000, 2000]);
    expect(walk.every((call) => call.lane === 'refresh' && call.job === 'chart-inputs-tx-walk')).toBe(true);
    expect(rootCount(w.fake.calls, 'positionTransactions')).toBe(1 + 3);
  });

  it('detail first: charts join the walk and leave it out of their document', async () => {
    const w = makeWorld();
    const [detail] = await Promise.all([
      w.leaderboard.getPosition(CHAIN, PROTO, '1001'),
      w.charts.getPositionCharts(CHAIN, PROTO, '1001', 'all'),
    ]);
    expect((detail as unknown as { transactions: unknown[] }).transactions.length).toBeGreaterThan(5);
    expect(rootCount(w.fake.calls, 'positionTransactions')).toBe(1);
    const combined = w.fake.calls.find((call) => call.roots.length > 1)!;
    expect(combined.roots).toEqual(['poolDayDatas', 'ticks', 'tokenDayDatas', 'tokenDayDatas']);
  });

  it('a reopened detail reads the cached list', async () => {
    const w = makeWorld();
    await w.leaderboard.getPosition(CHAIN, PROTO, '1001');
    await w.leaderboard.getPosition(CHAIN, PROTO, '1001');
    expect(rootCount(w.fake.calls, 'positionTransactions')).toBe(1);
  });
});

describe('the transaction cache key follows the position', () => {
  const base = {
    positionId: '1',
    liquidity: '100',
    isActive: true,
    owner: '0xAbC',
    amounts: {
      depositedToken0: '1',
      depositedToken1: '2',
      withdrawnToken0: '3',
      withdrawnToken1: '4',
      totalFeesCollected0: '5',
      totalFeesCollected1: '6',
    },
  };

  it.each([
    ['liquidity', { liquidity: '101' }],
    ['isActive', { isActive: false }],
    ['owner', { owner: '0xdef' }],
    ['depositedToken0', { amounts: { ...base.amounts, depositedToken0: '1.5' } }],
    ['depositedToken1', { amounts: { ...base.amounts, depositedToken1: '2.5' } }],
    ['withdrawnToken0', { amounts: { ...base.amounts, withdrawnToken0: '3.5' } }],
    ['withdrawnToken1', { amounts: { ...base.amounts, withdrawnToken1: '4.5' } }],
    ['totalFeesCollected0', { amounts: { ...base.amounts, totalFeesCollected0: '5.5' } }],
    ['totalFeesCollected1', { amounts: { ...base.amounts, totalFeesCollected1: '6.5' } }],
  ])('a change to %s changes the fingerprint', (_field, change) => {
    expect(positionHistoryFingerprint({ ...base, ...change })).not.toBe(positionHistoryFingerprint(base));
  });

  it('ignores owner case and everything that is not a cash flow', () => {
    const same = positionHistoryFingerprint(base);
    expect(positionHistoryFingerprint({ ...base, owner: '0xabc' })).toBe(same);
    expect(
      positionHistoryFingerprint({ ...base, token0: { address: '0x1' }, poolId: '0xpool' } as typeof base),
    ).toBe(same);
  });

  it('a stored position that moved is walked again; one that only re-priced is not', async () => {
    const w = makeWorld();
    await w.leaderboard.getPosition(CHAIN, PROTO, '1001');
    w.fixture.positions['1001']!.metrics = { ...w.fixture.positions['1001']!.metrics, underlyingValueUsd: 7_000 };
    w.fixture.positions['1001']!.currentTick = 198_100;
    await w.leaderboard.getPosition(CHAIN, PROTO, '1001');
    expect(rootCount(w.fake.calls, 'positionTransactions')).toBe(1);
    w.fixture.positions['1001']!.amounts.totalFeesCollected0 = '121';
    await w.leaderboard.getPosition(CHAIN, PROTO, '1001');
    expect(rootCount(w.fake.calls, 'positionTransactions')).toBe(2);
  });
});

describe('stale inputs', () => {
  it('are served at once and revalidated in the background, below user requests', async () => {
    const lanes: Array<{ roots: string[]; lane: string }> = [];
    const w = makeWorld({
      subgraph: { onCall: (call: FakeCall) => lanes.push({ roots: call.roots, lane: currentIndexerContext().lane }) },
    });
    await w.charts.getPositionCharts(CHAIN, PROTO, '1001', 'all');
    // Ticks / pool state: fresh 60 s, stale 3 min; day data 10 / 30 min;
    // transactions a day (fingerprint-keyed). At 90 s ticks are stale (served,
    // revalidated in the background); day data is still fresh.
    vi.setSystemTime(NOW_MS + 90_000);
    const charts = await w.charts.getPositionCharts(CHAIN, PROTO, '1001', 'all');
    expect(charts.liquidityDistribution.ticks.length).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 0));
    expect(lanes).toHaveLength(2);
    expect(lanes[1]!.lane).toBe('refresh');
    expect(lanes[1]!.roots).toContain('ticks');
    expect(lanes[1]!.roots).not.toContain('poolDayDatas');
    expect(lanes[1]!.roots).not.toContain('positionTransactions');
  });

  it('an entry past its stale age is still used when the reload fails', async () => {
    let failTicks = false;
    const w = makeWorld({
      // Not a retriable failure (outside a request this runs on a background
      // lane, which retries a statement timeout with real backoff): the point
      // is only that the reload fails.
      subgraph: { fail: (call) => (failTicks && call.roots.includes('ticks') ? new Error('ticks: query rejected') : undefined) },
    });
    const first = await w.charts.getPositionCharts(CHAIN, PROTO, '1001', 'all');
    failTicks = true;
    vi.setSystemTime(NOW_MS + 4.5 * 60_000); // past ticks' stale age (3 min), within the 30-min retention
    const again = await w.charts.getPositionCharts(CHAIN, PROTO, '1001', 'all');
    expect(again.liquidityDistribution.ticks).toEqual(first.liquidityDistribution.ticks);
    expect(again.partial).toBeUndefined();
  });
});

describe('failures degrade per input', () => {
  it('a failed combined request is retried input by input; only the bad one is missing', async () => {
    const w = makeWorld({
      subgraph: {
        fail: (call) =>
          call.roots.length > 1 || call.roots[0] === 'ticks' ? new Error('canceling statement due to statement timeout') : undefined,
      },
    });
    // A user's open (interactive lane): a statement timeout is not retried there.
    const charts = await runInLane(interactive(5_000), () => w.charts.getPositionCharts(CHAIN, PROTO, '1001', 'all'));
    expect(charts.partial).toBe(true);
    expect(charts.missing).toEqual(['ticks']);
    expect(charts.liquidityDistribution.ticks).toEqual([]);
    expect(charts.poolPrice.length).toBeGreaterThan(0);
    expect(charts.positionSeries).not.toBeNull();
    // The combined request, then each input alone (a statement timeout is not
    // retried for an interactive caller, so exactly once each).
    expect(w.fake.calls[0]!.roots).toEqual(ALL_POSITION_ROOTS);
    expect(w.fake.calls.slice(1).map((call) => call.roots).sort()).toEqual(
      [['poolDayDatas'], ['positionTransactions'], ['ticks'], ['tokenDayDatas'], ['tokenDayDatas']].sort(),
    );
    // A partial chart is refunded on /v1 like a degraded detail.
    expect(isDegradedPayload(charts)).toBe(true);
  });

  it('a rate-limited combined request is NOT split into more requests', async () => {
    const w = makeWorld({ subgraph: { fail: () => rateLimited() } });
    const charts = await runInLane(interactive(5_000), () => w.charts.getPositionCharts(CHAIN, PROTO, '1001', 'all'));
    expect(charts.partial).toBe(true);
    expect(charts.missing!.sort()).toEqual(['poolDayData', 'ticks', 'token0DayData', 'token1DayData', 'transactions']);
    expect(w.fake.calls.every((call) => call.roots.length > 1)).toBe(true);
    expect(charts.positionSeries).toBeNull();
  });

  it('a shared load never carries the hang-up signal of the request that started it', async () => {
    const contexts: IndexerContext[] = [];
    const w = makeWorld({ subgraph: { onCall: () => contexts.push(currentIndexerContext()) } });
    const controller = new AbortController();
    await runInLane(interactive(5_000, controller.signal), () => w.charts.getPositionCharts(CHAIN, PROTO, '1001', 'all'));
    expect(contexts.length).toBeGreaterThan(0);
    for (const ctx of contexts) {
      expect(ctx.signal).toBeUndefined();
      expect(ctx.deadlineAt).toBeUndefined();
    }
    expect(contexts[0]!.lane).toBe('interactive');
  });

  it('one client hanging up does not fail the load another request joined', async () => {
    const gate = deferred();
    // Stands in for the gateway: a fetch made under an aborted signal fails.
    const w = makeWorld({
      subgraph: {
        delay: () => gate.promise,
        fail: () =>
          currentIndexerContext().signal?.aborted
            ? Object.assign(new Error('client closed the request'), { name: 'AbortError' })
            : undefined,
      },
    });
    const a = new AbortController();
    const b = new AbortController();
    const first = runInLane(interactive(5_000, a.signal), () => w.charts.getPositionCharts(CHAIN, PROTO, '1001', 'all'));
    const second = runInLane(interactive(5_000, b.signal), () => w.charts.getPositionCharts(CHAIN, PROTO, '1001', 'all'));
    await new Promise((r) => setTimeout(r, 0));
    a.abort(); // A closes the modal while the shared load is in flight.
    gate.release();
    const [, joined] = await Promise.all([first, second]);
    expect(joined.partial).toBeUndefined();
    expect(joined.positionSeries).not.toBeNull();
    // One combined document served both; nothing was split or re-sent.
    expect(w.fake.calls).toHaveLength(1);
  });

  it('a failed detail walk degrades the detail, with the alert line', async () => {
    const w = makeWorld({ subgraph: { fail: () => new Error('boom') } });
    const detail = (await w.leaderboard.getPosition(CHAIN, PROTO, '1001')) as unknown as {
      transactions: unknown[];
      transactionsDegraded: boolean;
    };
    expect(detail.transactionsDegraded).toBe(true);
    expect(detail.transactions).toEqual([]);
    expect(w.warn.some((line) => line.includes('[alert] positions.tx_fetch_degraded'))).toBe(true);
  });

  it('a degraded list (no source) is never cached', async () => {
    let calls = 0;
    const w = makeWorld({
      adapter: () => ({
        protocol: PROTO,
        recomputeMode: 'aggregates',
        fetchPositions: async () => ({}) as never,
        fetchPositionTransactions: async () => {
          calls++;
          return { transactions: [], degraded: true };
        },
      }),
    });
    await w.leaderboard.getPosition(CHAIN, PROTO, '1001');
    await w.leaderboard.getPosition(CHAIN, PROTO, '1001');
    expect(calls).toBe(2);
  });
});

describe('the interactive deadline', () => {
  it('answers with what is ready, flags the rest, and keeps loading into the cache', async () => {
    const gate = deferred();
    const contexts: IndexerContext[] = [];
    let hold = true;
    const w = makeWorld({
      subgraph: {
        onCall: () => contexts.push(currentIndexerContext()),
        delay: () => (hold ? gate.promise : undefined),
      },
    });
    const startedAt = performance.now();
    const charts = await runInLane(interactive(400), () => w.charts.getPositionCharts(CHAIN, PROTO, '1001', 'all'));
    const tookMs = performance.now() - startedAt;
    // Answered a margin BEFORE the 400 ms deadline (250 ms early), not at it.
    expect(tookMs).toBeLessThan(350);
    expect(charts.partial).toBe(true);
    expect(charts.missing!.sort()).toEqual(['poolDayData', 'ticks', 'token0DayData', 'token1DayData', 'transactions']);
    expect(charts.positionSeries).toBeNull();
    expect(charts.poolPrice).toEqual([]);

    // The load runs without the request's deadline (it outlives the response) …
    expect(contexts[0]!.lane).toBe('interactive');
    expect(contexts[0]!.deadlineAt).toBeUndefined();
    // … and lands in the cache: the next open is complete and costs nothing.
    hold = false;
    gate.release();
    await new Promise((r) => setTimeout(r, 10));
    const warm = await runInLane(interactive(400), () => w.charts.getPositionCharts(CHAIN, PROTO, '1001', 'all'));
    expect(warm.partial).toBeUndefined();
    expect(warm.positionSeries).not.toBeNull();
    expect(w.fake.calls).toHaveLength(1);
  });

  it('cached inputs still count when the deadline has already passed', async () => {
    const w = makeWorld();
    await w.charts.getPositionCharts(CHAIN, PROTO, '1001', 'all');
    const late = await runInLane(interactive(0), () => w.charts.getPositionCharts(CHAIN, PROTO, '1001', 'all'));
    expect(late.partial).toBeUndefined();
    expect(late.positionSeries).not.toBeNull();
  });

  it('a detail walk still running at the deadline degrades the detail, not the request', async () => {
    const gate = deferred();
    const w = makeWorld({ subgraph: { delay: () => gate.promise } });
    const detail = (await runInLane(interactive(300), () => w.leaderboard.getPosition(CHAIN, PROTO, '1001'))) as unknown as {
      transactionsDegraded: boolean;
    };
    gate.release();
    expect(detail.transactionsDegraded).toBe(true);
    // Late, not failed: logged without the [alert] a real upstream failure gets.
    expect(w.log.some((line) => line.includes('positions.tx_fetch_late'))).toBe(true);
    expect(w.warn.some((line) => line.includes('[alert]'))).toBe(false);
  });

  it('outside a request there is no deadline: everything is waited for', async () => {
    const w = makeWorld({ subgraph: { delay: () => new Promise((r) => setTimeout(r, 30)) } });
    const charts = await w.charts.getPositionCharts(CHAIN, PROTO, '1001', 'all');
    expect(charts.partial).toBeUndefined();
  });
});

describe('day data past the 1000-row page cap', () => {
  it('keeps the NEWEST days (today included) and flags the series truncated', async () => {
    const w = makeWorld();
    const today = Math.floor(NOW_MS / 1000 / 86_400) * 86_400;
    w.fixture.data.poolDayDatas = Array.from({ length: 1_100 }, (_, i) => ({
      ...w.fixture.data.poolDayDatas[0]!,
      date: today - i * 86_400,
    }));
    const inputs = await w.inputs.positionInputs(w.fixture.positions['1001']!, w.integration as never, w.adapter);
    expect(inputs.poolDay!.truncated).toBe(true);
    expect(inputs.poolDay!.rows).toHaveLength(1_000);
    expect(inputs.poolDay!.rows[999]!.date).toBe(today);
    expect(inputs.poolDay!.rows[0]!.date).toBe(today - 999 * 86_400);
  });

  it('token day data too', async () => {
    const w = makeWorld();
    const today = Math.floor(NOW_MS / 1000 / 86_400) * 86_400;
    const token = w.fixture.positions['1001']!.token1.address;
    w.fixture.data.tokenDayDatas = Array.from({ length: 1_100 }, (_, i) => ({
      token,
      date: today - i * 86_400,
      priceUSD: String(2_000 + i),
    }));
    const inputs = await w.inputs.positionInputs(w.fixture.positions['1001']!, w.integration as never, w.adapter);
    expect(inputs.token1Day!.truncated).toBe(true);
    expect(inputs.token1Day!.rows).toHaveLength(1_000);
    expect(inputs.token1Day!.rows[999]!.date).toBe(today);
  });
});

describe('InputBatch', () => {
  it('an input added after the flush still goes out, on its own', async () => {
    const sent: string[][] = [];
    const batch = new InputBatch(async (items) => {
      sent.push(items.map((item) => item.spec.key));
      for (const item of items) item.resolve(item.spec.key);
    });
    const spec = (key: string) => ({ key }) as never;
    const early = batch.add(spec('a'));
    batch.flush();
    const late = batch.add(spec('b'));
    await expect(early).resolves.toBe('a');
    await expect(late).resolves.toBe('b');
    expect(sent).toEqual([['a'], ['b']]);
  });

  it('a send that throws rejects every input it carried', async () => {
    const batch = new InputBatch(async () => {
      throw new Error('send failed');
    });
    const a = batch.add({ key: 'a' } as never);
    const b = batch.add({ key: 'b' } as never);
    batch.flush();
    await expect(a).rejects.toThrow('send failed');
    await expect(b).rejects.toThrow('send failed');
  });
});

describe('a capped transaction list', () => {
  it('flags the chart partial and the detail truncated', async () => {
    const w = makeWorld({
      adapter: (envio) => ({
        protocol: PROTO,
        recomputeMode: 'aggregates',
        fetchPositions: async () => ({}) as never,
        fetchPositionTransactions: async (options) => ({
          ...(await envio.fetchPositionTransactions({ ...options, maxPages: 1 })),
          truncated: true,
        }),
      }),
    });
    const charts = await w.charts.getPositionCharts(CHAIN, PROTO, '1001', 'all');
    expect(charts.partial).toBe(true);
    expect(charts.missing).toEqual(['transactions']);
    expect(charts.positionSeries).not.toBeNull();
    const detail = (await w.leaderboard.getPosition(CHAIN, PROTO, '1001')) as unknown as Record<string, unknown>;
    expect(detail.transactionsTruncated).toBe(true);
    expect(detail.transactionsDegraded).toBe(false);
  });

  it('an uncapped detail carries no truncation field at all', async () => {
    const w = makeWorld();
    const detail = (await w.leaderboard.getPosition(CHAIN, PROTO, '1001')) as unknown as Record<string, unknown>;
    expect('transactionsTruncated' in detail).toBe(false);
  });
});
