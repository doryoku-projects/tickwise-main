import type { ChartRange, PoolCharts, PositionCharts } from './api';

/**
 * Client-side chart windows.
 *
 * Both detail panels fetch `range=all` ONCE per open and cut the 30d / 60d /
 * 90d / 180d views out of that payload here. A range button used to refetch
 * the whole history (the backend walks back to creation for every range
 * anyway — charts.service.ts), which cost ≥5 indexer requests per click; now a
 * range switch costs none.
 *
 * WHY THE WINDOW IS ANCHORED TO THE NEWEST POINT, NOT TO NOW
 *
 * The backend's own windows are wall-clock (`nowSec - days * DAY`), and the
 * indexer can be months behind head — so a server-side "30d" started after the
 * last data point and rendered EMPTY on every chain but one. Anchoring to the
 * series' own newest point shows the last N days of data that exist, which is
 * what "30d" can honestly mean when the data stops early. Each series is
 * anchored to ITSELF: a position's computed series runs to today while the
 * pool day data stops wherever the indexer is, and a shared anchor would put
 * one of them back outside its own window.
 *
 * `t` is epoch seconds, one point per UTC day. `t > newest - days * DAY` keeps
 * exactly `days` daily points, which matches the count the backend's window
 * returned when the data was current.
 */

const DAY = 86_400;

/**
 * A charts response flagged `partial` had inputs still loading when the
 * backend's request deadline answered; they finish into its cache. Since a
 * panel fetches once per open, it asks ONCE more after this delay instead of
 * leaving the empty sections up until a Refresh. 3.5 s (it was 2.5): a busy
 * position's charts now come back without the series after the backend's
 * 1.5 s transaction wait while its full history is walked in the background,
 * and that walk needs the extra second more often than not.
 */
export const PARTIAL_CHARTS_RETRY_MS = 3_500;

const RANGE_DAYS: Record<Exclude<ChartRange, 'all'>, number> = {
  '30d': 30,
  '60d': 60,
  '90d': 90,
  '180d': 180,
};

export function sliceToRange<T extends { t: number }>(points: T[], range: ChartRange): T[] {
  if (range === 'all' || points.length === 0) return points;
  let newest = -Infinity;
  for (const point of points) if (point.t > newest) newest = point.t;
  const from = newest - RANGE_DAYS[range] * DAY;
  return points.filter((point) => point.t > from);
}

/**
 * Liquidity distribution and `poolOverviewCurrent` are not time series (the
 * latest state, whatever the window), so they pass through untouched.
 */
export function slicePositionCharts(charts: PositionCharts, range: ChartRange): PositionCharts {
  if (range === 'all') return charts;
  const series = charts.positionSeries;
  return {
    ...charts,
    range,
    poolPrice: sliceToRange(charts.poolPrice, range),
    poolOverview: {
      tvl: sliceToRange(charts.poolOverview.tvl, range),
      volume: sliceToRange(charts.poolOverview.volume, range),
      fees: sliceToRange(charts.poolOverview.fees, range),
      feesTvl: sliceToRange(charts.poolOverview.feesTvl, range),
      price0: sliceToRange(charts.poolOverview.price0, range),
      price1: sliceToRange(charts.poolOverview.price1, range),
      divergence: sliceToRange(charts.poolOverview.divergence, range),
    },
    positionSeries: series
      ? {
          pnl: sliceToRange(series.pnl, range),
          assetsValue: sliceToRange(series.assetsValue, range),
          apr: sliceToRange(series.apr, range),
          feeApr: sliceToRange(series.feeApr, range),
          divLoss: sliceToRange(series.divLoss, range),
        }
      : null,
  };
}

export function slicePoolCharts(charts: PoolCharts, range: ChartRange): PoolCharts {
  if (range === 'all') return charts;
  return {
    ...charts,
    range,
    poolPrice: sliceToRange(charts.poolPrice, range),
    poolOverview: {
      tvl: sliceToRange(charts.poolOverview.tvl, range),
      volume: sliceToRange(charts.poolOverview.volume, range),
      fees: sliceToRange(charts.poolOverview.fees, range),
      feesTvl: sliceToRange(charts.poolOverview.feesTvl, range),
      price0: sliceToRange(charts.poolOverview.price0, range),
      price1: sliceToRange(charts.poolOverview.price1, range),
      divergence: sliceToRange(charts.poolOverview.divergence, range),
    },
    poolSeries: {
      volume: sliceToRange(charts.poolSeries.volume, range),
      tvl: sliceToRange(charts.poolSeries.tvl, range),
      fees: sliceToRange(charts.poolSeries.fees, range),
      feeApr: sliceToRange(charts.poolSeries.feeApr, range),
    },
  };
}
