/*
 * New charts vs the legacy implementation, on fixtures.
 *
 * `legacy-charts.reference.ts` is the charts service as it was before the
 * chart-inputs rewrite. Both read the SAME in-memory subgraph (the legacy one
 * through its five single-root queries and the adapter's paged walk, the new one
 * through the combined document and its caches), so any difference below is a
 * difference in what the two compute.
 *
 * What must be identical, and what changed on purpose:
 *  - `all` (the range the dashboard asks for): the WHOLE response, identical.
 *  - a range while the data is current: every pool section identical; the
 *    position series is now the matching slice of the `all` series (the old code
 *    restarted its divergence-clamp ramp at each window's start — accepted by the
 *    plan, and what the dashboard's client-side slicing already shows).
 *  - a range while the indexer LAGS: the old wall-clock window was EMPTY; the new
 *    one is the last N days of data that exist.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ChartInputsService } from '../../src/charts/chart-inputs.service.js';
import { ChartsService, lastDaysOf, type ChartRange, type PositionCharts } from '../../src/charts/charts.service.js';
import { LeaderboardService } from '../../src/leaderboard/leaderboard.service.js';
import { EnvioAdapter } from '../../src/subgraph/adapters/envio.adapter.js';
import { CHAIN, DAY, LAG_POOL, NOW_MS, POOL, PROTO, buildFixture } from './chart-fixtures.js';
import { fakeSubgraph } from './fake-subgraph.js';
import { LegacyChartsService } from './legacy-charts.reference.js';

const RANGE_DAYS = { '30d': 30, '60d': 60, '90d': 90, '180d': 180 } as const;
const RANGES = Object.keys(RANGE_DAYS) as Array<keyof typeof RANGE_DAYS>;
/** Positions on the pool whose day data runs to today. */
const CURRENT = ['1001', '1002', '1003', '1005', '1006'];
/** How far behind today LAG_POOL's day data stops (chart-fixtures.ts). */
const LAG_DAYS = 150;

function world() {
  const fixture = buildFixture();
  const fake = fakeSubgraph(fixture.data);
  const integration = {
    chainId: CHAIN,
    protocol: PROTO,
    dialect: 'hyperindex',
    enabled: true,
    subgraphUrl: 'http://fake.local/graphql',
  };
  const config = {
    getIntegration: () => integration,
    isSupportedChain: () => true,
    isSupportedProtocol: () => true,
    chartCacheMaxBytes: 64 * 1024 * 1024,
  };
  const positions = {
    findOneForRead: async (_chainId: number, _protocol: string, id: string) =>
      structuredClone(fixture.positions[id] ?? null),
  };
  // The real adapter, reading the fake through its own paged walk.
  const adapter = new EnvioAdapter({} as never, {} as never, {} as never);
  (adapter as unknown as { positionSource: () => unknown }).positionSource = () => fake.client;
  const adapters = { resolve: () => adapter };
  class Inputs extends ChartInputsService {
    protected override clientFor() {
      return fake.client;
    }
  }
  const inputs = new Inputs(config as never);
  return {
    fixture,
    fake,
    adapter,
    integration,
    charts: new ChartsService(config as never, positions as never, adapters as never, inputs),
    legacy: new LegacyChartsService(config as never, positions as never, adapters as never, () => fake.client),
    leaderboard: new LeaderboardService(
      config as never,
      positions as never,
      { findForPosition: async () => [] } as never,
      adapters as never,
      undefined,
      inputs,
    ),
  };
}

function sliceSeries(series: NonNullable<PositionCharts['positionSeries']>, days: number) {
  return {
    pnl: lastDaysOf(series.pnl, days),
    assetsValue: lastDaysOf(series.assetsValue, days),
    apr: lastDaysOf(series.apr, days),
    feeApr: lastDaysOf(series.feeApr, days),
    divLoss: lastDaysOf(series.divLoss, days),
  };
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
});
afterAll(() => {
  vi.useRealTimers();
});

describe('position charts — new vs legacy', () => {
  it.each(CURRENT)('position %s, range all: the whole response is identical', async (id) => {
    const w = world();
    const legacy = await w.legacy.getPositionCharts(CHAIN, PROTO, id, 'all');
    const fresh = await w.charts.getPositionCharts(CHAIN, PROTO, id, 'all');
    // The fixture really exercises every section.
    expect(legacy.positionSeries?.pnl.length).toBeGreaterThan(5);
    expect(legacy.poolPrice.length).toBeGreaterThan(5);
    expect(legacy.liquidityDistribution.ticks.length).toBeGreaterThan(5);
    expect(fresh).toEqual(legacy);
    expect(fresh.partial).toBeUndefined();
  });

  it.each(CURRENT)('position %s, every range: pool sections identical, series = slice of all', async (id) => {
    const w = world();
    const legacyAll = await w.legacy.getPositionCharts(CHAIN, PROTO, id, 'all');
    for (const range of RANGES) {
      const legacy = await w.legacy.getPositionCharts(CHAIN, PROTO, id, range);
      const fresh = await w.charts.getPositionCharts(CHAIN, PROTO, id, range);
      expect({ ...fresh, positionSeries: null }).toEqual({ ...legacy, positionSeries: null });
      expect(fresh.positionSeries).toEqual(sliceSeries(legacyAll.positionSeries!, RANGE_DAYS[range]));
      expect(fresh.poolPrice.length).toBeGreaterThan(0);
    }
  });

  it('a range on a position older than it ends today and holds exactly N daily points', async () => {
    const w = world();
    const fresh = await w.charts.getPositionCharts(CHAIN, PROTO, '1001', '30d');
    const pnl = fresh.positionSeries!.pnl;
    expect(pnl).toHaveLength(30);
    expect(pnl[pnl.length - 1]!.t).toBe(Math.floor(NOW_MS / 1000 / DAY) * DAY);
  });

  it('the busy position (2,346 transactions, page boundary inside a timestamp tie) matches', async () => {
    const w = world();
    const legacy = await w.legacy.getPositionCharts(CHAIN, PROTO, '1003', 'all');
    const fresh = await w.charts.getPositionCharts(CHAIN, PROTO, '1003', 'all');
    expect(fresh).toEqual(legacy);
    // One combined request + the remainder walk (from the tie's timestamp).
    const txReads = w.fake.calls.filter((call) => call.roots.includes('positionTransactions'));
    expect(txReads.length).toBeGreaterThanOrEqual(2);
  });
});

describe('fixture sanity', () => {
  it('position 1006 really was created on a day the pool has no row, between two that do', () => {
    const { data, positions } = buildFixture();
    const day = Math.floor(positions['1006']!.createdAtTimestamp / DAY) * DAY;
    const dates = new Set(data.poolDayDatas.filter((r) => r.pool === POOL && r.tick !== null).map((r) => r.date));
    expect(dates.has(day)).toBe(false);
    expect(dates.has(day - DAY)).toBe(true);
    expect(dates.has(day + DAY)).toBe(true);
  });
});

describe('the lagging indexer (day data stops 150 days ago)', () => {
  it('range all is identical', async () => {
    const w = world();
    expect(await w.charts.getPositionCharts(CHAIN, PROTO, '1004', 'all')).toEqual(
      await w.legacy.getPositionCharts(CHAIN, PROTO, '1004', 'all'),
    );
  });

  it.each(RANGES)('position %s window: empty or short before, the last N days that exist now', async (range) => {
    const w = world();
    const legacy = await w.legacy.getPositionCharts(CHAIN, PROTO, '1004', range);
    const fresh = await w.charts.getPositionCharts(CHAIN, PROTO, '1004', range);
    // The bug being fixed: a wall-clock window that starts after the last point
    // is empty, and one reaching back past the lag holds only its oldest days.
    if (RANGE_DAYS[range] <= LAG_DAYS) expect(legacy.poolPrice).toEqual([]);
    else expect(legacy.poolPrice.length).toBeLessThan(fresh.poolPrice.length);
    const rows = w.fixture.data.poolDayDatas.filter((r) => r.pool === LAG_POOL);
    const newest = Math.max(...rows.map((r) => r.date));
    const expected = rows.filter((r) => r.date > newest - RANGE_DAYS[range] * DAY).map((r) => r.date);
    expect(expected.length).toBeGreaterThan(0);
    expect(fresh.poolPrice.map((p) => p.t)).toEqual(expected);
    expect(fresh.poolOverview.tvl.map((p) => p.t)).toEqual(expected);
    // The position series is computed to today regardless — never empty.
    expect(fresh.positionSeries!.pnl.length).toBe(RANGE_DAYS[range]);
  });

  it.each(RANGES)('pool chart %s: empty or short before, the last N days that exist now', async (range) => {
    const w = world();
    const legacy = await w.legacy.getPoolCharts(CHAIN, PROTO, LAG_POOL, range);
    const fresh = await w.charts.getPoolCharts(CHAIN, PROTO, LAG_POOL, range);
    const rows = w.fixture.data.poolDayDatas.filter((r) => r.pool === LAG_POOL);
    const newest = Math.max(...rows.map((r) => r.date));
    const expected = rows.filter((r) => r.date > newest - RANGE_DAYS[range] * DAY).map((r) => r.date);
    expect(fresh.poolSeries.volume.map((p) => p.t)).toEqual(expected);
    if (RANGE_DAYS[range] <= LAG_DAYS) {
      expect(legacy.poolSeries.volume).toEqual([]);
      // "Current" stats came from the empty window, so they were null too.
      expect(legacy.poolOverviewCurrent).toBeNull();
    } else {
      expect(legacy.poolSeries.volume.length).toBeLessThan(expected.length);
    }
    // Now the latest point the indexer holds.
    expect(fresh.poolOverviewCurrent).not.toBeNull();
  });
});

describe('pool charts — new vs legacy', () => {
  it.each(['all', ...RANGES] as ChartRange[])('range %s: existing fields are identical and canonical ticks are additive', async (range) => {
    const w = world();
    const legacy = await w.legacy.getPoolCharts(CHAIN, PROTO, POOL, range);
    const fresh = await w.charts.getPoolCharts(CHAIN, PROTO, POOL, range);
    expect(legacy.poolSeries.volume.length).toBeGreaterThan(5);
    const withoutAddedTicks = { ...fresh, poolPrice: fresh.poolPrice.map(({ tick, ...point }) => point) };
    expect(withoutAddedTicks).toEqual(legacy);
    for (const point of fresh.poolPrice) {
      const row = w.fixture.data.poolDayDatas.find((r) => r.pool === POOL && r.date === point.t);
      expect(point.tick).toBe(row?.tick === null || row?.tick === undefined ? null : Number(row.tick));
    }
  });
});

describe('position detail — the transaction list', () => {
  it('is the full history, as the old detail walk returned it (busy position)', async () => {
    const w = world();
    const full = await w.adapter.fetchPositionTransactions({
      integration: w.integration as never,
      positionIds: ['1003'],
      cursorTimestamp: 0,
      pageSize: 1000,
      maxPages: 1000,
    });
    const detail = (await w.leaderboard.getPosition(CHAIN, PROTO, '1003')) as unknown as {
      transactions: Array<{ transactionId: string }>;
      transactionsDegraded: boolean;
    };
    expect(detail.transactionsDegraded).toBe(false);
    expect(detail.transactions.map((t) => t.transactionId)).toEqual(full.transactions.map((t) => t.transactionId));
    expect(detail.transactions).toHaveLength(2346);
  });

  it('is the same list whether the charts or the detail loaded it first', async () => {
    const chartsFirst = world();
    await chartsFirst.charts.getPositionCharts(CHAIN, PROTO, '1003', 'all');
    const fromCharts = (await chartsFirst.leaderboard.getPosition(CHAIN, PROTO, '1003')) as unknown as {
      transactions: unknown[];
    };
    const detailFirst = world();
    const fromWalk = (await detailFirst.leaderboard.getPosition(CHAIN, PROTO, '1003')) as unknown as {
      transactions: unknown[];
    };
    expect(fromCharts.transactions).toEqual(fromWalk.transactions);
  });
});
