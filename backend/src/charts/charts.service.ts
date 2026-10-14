import { Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import { CHARTS_PROJECTION, PositionsRepository } from '../database/positions.repository.js';
import type { Position } from '../database/schemas/position.schema.js';
import { AdapterRegistryService } from '../subgraph/adapter-registry.service.js';
import type { NormalizedPositionTransaction } from '../subgraph/normalized-position.js';
import {
  ChartInputsService,
  type ChartInput,
  type DaySeries,
  type PoolDayRow,
  type PositionChartInputs,
  type TickRow,
  type TokenDayRow,
} from './chart-inputs.service.js';
import { amountsForLiquidity, liquidityForAmounts, tickLockedAmounts } from './series-math.js';
import { poolObservationTick } from './pool-observation-tick.js';

export type { TickRow } from './chart-inputs.service.js';

// Position-detail charts. Vanilla-direct series: pool price (OHLC), pool-overview
// sparklines (TVL/volume/fees/feesTVL/price), the liquidity-distribution
// histogram (ticks), AND the backend-computed position PnL/assets/APR/feeApr/
// div-loss curves (per-tx cashflows × daily USD prices, valued each day at that
// day's price = vs-HODL basis). Pool/price data and cashflows both come from the
// Envio indexer, through the subgraph-dialect converter. The position-series
// final point lands at ≈ the position's current `metrics.pnlHodl`.
//
// The indexer reads live in `ChartInputsService` (cached, one combined request
// per open). This file computes the FULL series once per request and cuts the
// requested range out of it, so every range is served from the same inputs.
//
// RANGE WINDOWS ARE ANCHORED TO THE NEWEST DATA POINT, NOT TO NOW. The indexer
// can be months behind head, and a wall-clock `now − 30 days` window then starts
// after the last data point and renders EMPTY. `t > newest − N days` keeps the
// last N daily points that exist — exactly the N points the wall-clock window
// returned while the data was current. Each series is anchored to itself: the
// position series runs to today, pool day data stops wherever the indexer is.
// (The frontend's `lib/chart-range.ts` slices the `all` payload the same way.)

export type ChartRange = '30d' | '60d' | '90d' | '180d' | 'all';
const RANGE_DAYS: Record<string, number> = { '30d': 30, '60d': 60, '90d': 90, '180d': 180 };
/** A pool chart's `all` is the last year of the pool, not its whole history. */
const POOL_ALL_DAYS = 365;
const DAY = 86400;
const SECONDS_PER_YEAR = 365 * DAY;
const APR_MIN_AGE_SECONDS = DAY;
// Sanity ceilings for the reconstructed series. Degenerate pools (tick pinned at
// an extreme, a ~0-priced token) make constant-liquidity tick-math blow up to
// 1e40+ on intermediate days; real positions sit far below these. Out-of-bound
// days are dropped (not clamped) so a corrupt day never distorts the curve —
// and the chart lib (lightweight-charts) rejects values beyond ~9e13 anyway.
const VALUE_CAP = 1e9; // USD magnitude — no real position PnL/fees approaches $1B
const PCT_CAP = 1e6; // APR / fee-APR magnitude (%)

interface PricePoint {
  t: number; // unix seconds (day start)
  /** Additive on pool charts only; canonical daily tick, null when unavailable. */
  tick?: number | null;
  token0Price: number;
  token1Price: number;
  open: number;
  high: number;
  low: number;
  close: number;
}
interface SeriesPoint {
  t: number;
  value: number;
}
interface LiquidityTick {
  tickIdx: number;
  liquidityGross: string;
  /** Signed liquidity delta applied when price crosses this tick upward. */
  liquidityNet: string;
  /**
   * Liquidity active across the bin [tickIdx, tickIdx + tickSpacing) — the
   * running sum of `liquidityNet` from the lowest initialised tick upward. This
   * is the quantity a depth chart plots; see `mapLiquidityTicks`.
   */
  activeLiquidity: number;
  /** Decimal-adjusted token1-per-token0 (already `× 10^(dec0 - dec1)`). */
  price0: number;
  /** Decimal-adjusted token0-per-token1, i.e. `1 / price0`. */
  price1: number;
  // Token units locked in this tick bin (for the histogram tooltip): amount0
  // when price is below the bin, amount1 when above.
  amount0: number;
  amount1: number;
}
interface PoolOverview {
  tvl: SeriesPoint[];
  volume: SeriesPoint[];
  fees: SeriesPoint[];
  feesTvl: SeriesPoint[];
  price0: SeriesPoint[];
  price1: SeriesPoint[];
  divergence: SeriesPoint[]; // not in the vanilla schema → empty for now
}
interface PositionSeries {
  pnl: SeriesPoint[];
  assetsValue: SeriesPoint[];
  apr: SeriesPoint[];
  feeApr: SeriesPoint[];
  divLoss: SeriesPoint[];
}
interface PoolCurrent {
  tvl: number;
  volume: number;
  fees: number;
  feesTvl: number;
}

/**
 * Additive, and present only when something is missing: `partial: true` plus
 * the inputs that failed upstream or were not ready by the request deadline.
 * Every section built from a missing input is empty, exactly as before.
 */
interface PartialFlags {
  partial?: true;
  missing?: ChartInput[];
}

export interface PositionCharts extends PartialFlags {
  range: ChartRange;
  poolPrice: PricePoint[];
  poolOverview: PoolOverview;
  liquidityDistribution: {
    currentTick: number;
    tickLower: number;
    tickUpper: number;
    ticks: LiquidityTick[];
  };
  positionSeries: PositionSeries | null;
  /**
   * Current pool stats from the latest `poolDayDatas` point (on-demand, reliable) —
   * the per-day (24h) volume/fees that match the sparkline. Used for the "current"
   * TVL/volume/fees display instead of the stored `poolStats` aggregate, which the
   * batch backfill fetch leaves at 0 when it times out/rate-limits. Null when the
   * pool has no day data (or the fetch failed).
   */
  poolOverviewCurrent: PoolCurrent | null;
}

export interface PoolCharts extends PartialFlags {
  range: ChartRange;
  poolPrice: PricePoint[];
  poolOverview: PoolOverview;
  liquidityDistribution: {
    currentTick: number;
    ticks: LiquidityTick[];
  };
  poolSeries: {
    volume: SeriesPoint[];
    tvl: SeriesPoint[];
    fees: SeriesPoint[];
    feeApr: SeriesPoint[];
  };
  poolOverviewCurrent: PoolCurrent | null;
}

/** What the series math reads off the stored position (`CHARTS_PROJECTION`). */
type ChartPosition = Position;

@Injectable()
export class ChartsService {
  private readonly logger = new Logger(ChartsService.name);
  private readonly inputs: ChartInputsService;

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(PositionsRepository) private readonly positions: PositionsRepository,
    @Inject(AdapterRegistryService) private readonly adapters: AdapterRegistryService,
    // APPENDED and optional: specs construct this service positionally.
    @Optional() @Inject(ChartInputsService) inputs?: ChartInputsService,
  ) {
    this.inputs = inputs ?? new ChartInputsService(config);
  }

  async getPositionCharts(
    chainId: number,
    protocol: string,
    positionId: string,
    range: ChartRange = '30d',
  ): Promise<PositionCharts> {
    // User read path: projected, secondary-preferred, 2 s budget (W1).
    const position = await this.positions.findOneForRead(chainId, protocol, positionId, CHARTS_PROJECTION);
    if (!position) {
      throw new NotFoundException({ error: 'Position not found', chainId, protocol, positionId });
    }

    const integration = this.config.getIntegration(chainId, protocol);
    if (!integration?.subgraphUrl) {
      this.logger.warn(`No vanilla subgraphUrl for ${chainId}:${protocol} — charts empty`);
      return {
        range,
        poolPrice: [],
        poolOverview: emptyOverview(),
        liquidityDistribution: {
          currentTick: num(position.currentTick),
          tickLower: num(position.tickLower),
          tickUpper: num(position.tickUpper),
          ticks: [],
        },
        positionSeries: null,
        poolOverviewCurrent: null,
      };
    }

    const inputs = await this.inputs.positionInputs(position, integration, this.adapters.resolve(protocol));
    const nowSec = Math.floor(Date.now() / 1000);
    const createdAt = num(position.createdAtTimestamp);
    const createdAtDay = createdAt > 0 ? dayStart(createdAt) : nowSec - 180 * DAY;
    const poolRows = inputs.poolDay?.rows ?? [];

    // The FULL position series: every day from creation to today. A range is a
    // slice of it, so 30d shows the same values as `all` for the same days.
    let positionSeries: PositionSeries | null = null;
    try {
      positionSeries = computePositionSeries(
        position,
        // Pool rows from creation on, exactly as the `all` view always read them.
        poolRows.filter((d) => num(d.date) >= createdAtDay),
        inputs,
        nowSec,
      );
    } catch (err) {
      this.logger.warn(
        `position series failed for ${chainId}:${protocol}:${positionId}: ${(err as Error)?.message ?? String(err)}`,
      );
    }

    // Pool price + overview. `all` is the position's lifetime; a range is the
    // last N days of pool data, which for a young position reaches back before
    // it was created (as it always did).
    const days = RANGE_DAYS[range];
    const windowRows =
      range === 'all' || !days ? poolRows.filter((d) => num(d.date) >= createdAtDay) : lastDays(poolRows, days);

    // Liquidity distribution (ticks with non-zero liquidity). Each bin is
    // enriched with the token amounts it locks (tick-math) so the UI tooltip can
    // show the locked-token USD value.
    const ticks = mapLiquidityTicks(inputs.ticks ?? [], {
      dec0: num(position.token0?.decimals) || 18,
      dec1: num(position.token1?.decimals) || 18,
      tickSpacing: num(position.tickSpacing) || 1,
    });

    const out: PositionCharts = {
      range,
      poolPrice: pricePoints(windowRows),
      poolOverview: overviewOf(windowRows),
      liquidityDistribution: {
        currentTick: num(position.currentTick),
        tickLower: num(position.tickLower),
        tickUpper: num(position.tickUpper),
        ticks,
      },
      positionSeries: positionSeries && (range === 'all' || !days ? positionSeries : sliceSeries(positionSeries, days)),
      // Current pool stats = the latest day-data point (rows are date-asc).
      // Reliable because this on-demand read works even when the backfill
      // `poolStats` fetch was rate-limited to 0. Per-day (24h) volume/fees match
      // the sparkline.
      poolOverviewCurrent: currentOf(poolRows),
    };
    return withPartial(out, partialInputs(inputs));
  }

  async getPoolCharts(
    chainId: number,
    protocol: string,
    poolId: string,
    range: ChartRange = '30d',
  ): Promise<PoolCharts> {
    const out: PoolCharts = {
      range,
      poolPrice: [],
      poolOverview: emptyOverview(),
      liquidityDistribution: { currentTick: 0, ticks: [] },
      poolSeries: { volume: [], tvl: [], fees: [], feeApr: [] },
      poolOverviewCurrent: null,
    };

    const integration = this.config.getIntegration(chainId, protocol);
    if (!integration?.subgraphUrl) {
      this.logger.warn(`No subgraphUrl for ${chainId}:${protocol} — pool charts empty`);
      return out;
    }

    const inputs = await this.inputs.poolInputs(integration, poolId);

    // Pool state (current tick + decimals for the liquidity histogram).
    let dec0 = 18;
    let dec1 = 18;
    let tickSpacing = 60;
    const state = inputs.poolState;
    if (state) {
      out.liquidityDistribution.currentTick = state.tick !== null ? num(state.tick) : 0;
      dec0 = num(state.token0?.decimals) || 18;
      dec1 = num(state.token1?.decimals) || 18;
      tickSpacing = num(state.tickSpacing) || 60;
    }

    // Pool daily data → price + overview + series, the last N days the indexer has.
    const poolRows = inputs.poolDay?.rows ?? [];
    const rows = lastDays(poolRows, RANGE_DAYS[range] ?? POOL_ALL_DAYS);
    out.poolPrice = pricePoints(rows).map((point, index) => ({
      ...point,
      tick: poolObservationTick(rows[index]?.tick),
    }));
    out.poolOverview = overviewOf(rows);
    out.poolSeries = {
      volume: rows.map((d) => ({ t: num(d.date), value: num(d.volumeUSD) })),
      tvl: rows.map((d) => ({ t: num(d.date), value: num(d.tvlUSD) })),
      fees: rows.map((d) => ({ t: num(d.date), value: num(d.feesUSD) })),
      feeApr: rows.map((d) => {
        const tvl = num(d.tvlUSD);
        const fees = num(d.feesUSD);
        return { t: num(d.date), value: tvl > 0 ? (fees / tvl) * 365 * 100 : 0 };
      }),
    };
    out.poolOverviewCurrent = currentOf(poolRows);

    // Liquidity distribution
    out.liquidityDistribution.ticks = mapLiquidityTicks(inputs.ticks ?? [], { dec0, dec1, tickSpacing });

    return withPartial(out, inputs.missing);
  }
}

/**
 * Reconstruct the position's daily PnL/assets/APR/feeApr/div-loss curve from
 * indexed per-tx cashflows valued at each day's USD prices — every day from
 * creation to today. Liquidity is reconstructed from the deposit/withdraw
 * amounts (inverse tick-math) and normalised so the final day matches the
 * position's real current liquidity — making the last point land at ≈
 * `metrics.pnlHodl`.
 */
function computePositionSeries(
  position: ChartPosition,
  poolRows: PoolDayRow[],
  inputs: Pick<PositionChartInputs, 'token0Day' | 'token1Day' | 'transactions'>,
  nowSec: number,
): PositionSeries | null {
  const transactions = inputs.transactions?.transactions;
  if (!transactions) return null;

  const dec0 = num(position.token0?.decimals) || 18;
  const dec1 = num(position.token1?.decimals) || 18;
  const tickLower = num(position.tickLower);
  const tickUpper = num(position.tickUpper);
  const createdAt = num(position.createdAtTimestamp);
  if (!(tickUpper > tickLower) || createdAt <= 0) return null;

  // Daily pool tick + USD prices, forward-filled across gaps.
  const tickByDay = new Map<number, number>();
  const p0RatioByDay = new Map<number, number>(); // token0 priced in token1 (token0Price)
  const p1RatioByDay = new Map<number, number>();
  for (const d of poolRows) {
    const day = dayStart(num(d.date));
    if (d.tick !== null && d.tick !== undefined) tickByDay.set(day, num(d.tick));
    p0RatioByDay.set(day, num(d.token0Price));
    p1RatioByDay.set(day, num(d.token1Price));
  }

  // Per-token daily USD price (priceUSD). Native-token (0x0) often absent → we
  // fall back to the pool ratio against the priced side, below.
  const t0Usd = tokenDayUsd(inputs.token0Day);
  const t1Usd = tokenDayUsd(inputs.token1Day);

  // All cashflows for the position (full history → correct cumulative at range start).
  const txns = [...transactions].sort((a, b) => a.timestamp - b.timestamp);
  if (txns.length === 0) return null;

  // Gas → current ETH price (mirrors the metric's HODL-gas valuation).
  const gasEthTotal = num(position.amounts?.totalGasCostEth);
  const gasUsdTotal = num(position.metrics?.totalGasCostUsd);
  const ethPriceNow = gasEthTotal > 0 ? gasUsdTotal / gasEthTotal : 0;
  const pendingFeesUsd = num(position.metrics?.pendingFeesUsd);

  // Reconstruct NET per-tx liquidity (deposits add, withdrawals subtract) to
  // scale the curve; align the final net L to the real current liquidity.
  const actualLiquidityNow = num(position.liquidity);
  let reconstructedNow = 0;
  for (const tx of txns) {
    const kind = txKind(tx.type);
    if (kind !== 'deposit' && kind !== 'withdraw') continue;
    const mag = txLiquidityDelta(tx, tickByDay, tickLower, tickUpper, dec0, dec1);
    reconstructedNow += kind === 'deposit' ? mag : -mag;
  }
  let liqFactor = actualLiquidityNow > 0 && reconstructedNow > 0 ? actualLiquidityNow / reconstructedNow : 1;
  // A wildly off factor means the reconstruction is unreliable (degenerate
  // pool / bad tx tick) — trust the raw reconstruction (factor 1) rather than
  // amplifying the error across every day.
  if (!Number.isFinite(liqFactor) || liqFactor <= 0 || liqFactor > 1e6 || liqFactor < 1e-6) {
    liqFactor = 1;
  }

  // Walk days from creation → now, advancing the tx cursor and accumulating.
  const startDay = dayStart(createdAt);
  const endDay = dayStart(nowSec);
  let ti = 0;
  let cumLiq = 0;
  let dep0 = 0;
  let dep1 = 0;
  let wd0 = 0;
  let wd1 = 0;
  let col0 = 0;
  let col1 = 0;
  let gasEth = 0;
  const gasSeen = new Set<string>();
  let lastTick = firstTick(tickByDay, startDay);
  let lastP0Usd = 0;
  let lastP1Usd = 0;

  // First pass collects RAW daily samples; a second pass clamps the noisy
  // reconstructed divergence (see below) before emitting.
  const samples: Array<{
    t: number;
    divLossRaw: number;
    depositedUsd: number;
    withdrawnUsd: number;
    feesAccrued: number;
    gasUsd: number;
    ageAtDay: number;
  }> = [];

  for (let day = startDay; day <= endDay; day += DAY) {
    // Fold in every tx up to end-of-day.
    const dayEnd = day + DAY - 1;
    while (ti < txns.length && txns[ti]!.timestamp <= dayEnd) {
      const tx = txns[ti]!;
      ti++;
      const kind = txKind(tx.type);
      const a0 = Math.abs(num(tx.amount0));
      const a1 = Math.abs(num(tx.amount1));
      if (kind === 'deposit') {
        dep0 += a0;
        dep1 += a1;
        cumLiq += txLiquidityDelta(tx, tickByDay, tickLower, tickUpper, dec0, dec1);
      } else if (kind === 'withdraw') {
        wd0 += a0;
        wd1 += a1;
        cumLiq -= txLiquidityDelta(tx, tickByDay, tickLower, tickUpper, dec0, dec1);
      } else if (kind === 'collect') {
        col0 += a0;
        col1 += a1;
      }
      const gk = tx.txHash || `${tx.type}:${ti}`;
      if (!gasSeen.has(gk)) {
        gasEth += num(tx.gasCostEth);
        gasSeen.add(gk);
      }
    }

    if (tickByDay.has(day)) lastTick = tickByDay.get(day)!;
    // USD prices: priceUSD if present, else pool-ratio fallback against the
    // priced side, else carry forward.
    const r0 = p0RatioByDay.get(day); // token0 in token1 units
    const r1 = p1RatioByDay.get(day); // token1 in token0 units
    let p0 = t0Usd.get(day) ?? 0;
    let p1 = t1Usd.get(day) ?? 0;
    if (p0 <= 0 && p1 > 0 && r0 && r0 > 0) p0 = r0 * p1;
    if (p1 <= 0 && p0 > 0 && r1 && r1 > 0) p1 = r1 * p0;
    if (p0 > 0) lastP0Usd = p0;
    else p0 = lastP0Usd;
    if (p1 > 0) lastP1Usd = p1;
    else p1 = lastP1Usd;

    const isLast = day + DAY > endDay;
    // Anchor the final point to the live snapshot (current tick + current
    // prices) so it lands exactly on the headline metrics, instead of the
    // stale last daily close (which can sit on the wrong side of the range).
    let tickForDay = lastTick;
    if (isLast) {
      tickForDay = num(position.currentTick);
      const cp0 = num(position.token0?.priceUsd);
      const cp1 = num(position.token1?.priceUsd);
      if (cp0 > 0) p0 = cp0;
      if (cp1 > 0) p1 = cp1;
    }
    const liq = Math.max(0, cumLiq) * liqFactor;
    const { amount0Raw, amount1Raw } = amountsForLiquidity(liq, tickForDay, tickLower, tickUpper);
    let amt0 = amount0Raw / Math.pow(10, dec0);
    let amt1 = amount1Raw / Math.pow(10, dec1);
    if (isLast) {
      // Use the exact on-chain holdings the indexer recorded for the final point
      // so divLoss/pnl land precisely on the headline metrics, instead of the
      // ~sub-percent tick-math reconstruction error.
      amt0 = num(position.amounts?.amount0);
      amt1 = num(position.amounts?.amount1);
    }

    const assetsValue = amt0 * p0 + amt1 * p1;
    const depositedUsd = dep0 * p0 + dep1 * p1;
    const withdrawnUsd = wd0 * p0 + wd1 * p1;
    const collectedUsd = col0 * p0 + col1 * p1;
    const gasUsd = gasEth * ethPriceNow;
    const feesAccrued = collectedUsd + (isLast ? pendingFeesUsd : 0);
    const divLossRaw = assetsValue + withdrawnUsd - depositedUsd;
    const ageAtDay = Math.max(0, day + DAY - createdAt);

    // Drop only the truly corrupt (degenerate-pool) days here; the merely
    // noisy reconstruction is tamed by the divergence clamp in pass two.
    if (saneUsd(divLossRaw) && saneUsd(depositedUsd) && saneUsd(feesAccrued)) {
      samples.push({ t: day, divLossRaw, depositedUsd, withdrawnUsd, feesAccrued, gasUsd, ageAtDay });
    }
  }

  if (samples.length === 0) return null;

  // The reconstructed historical divergence (constant-liquidity tick-math) is
  // hypersensitive for concentrated/stable positions — a sub-percent tick
  // error becomes a large absolute swing that dwarfs the fee-driven PnL. The
  // FINAL sample is anchored to the live state (real current tick + prices), so
  // it is reliable; clamp every day's divergence to a band around it. This
  // keeps real IL for volatile positions (large final divergence → wide band)
  // while flattening reconstruction noise for stable ones (≈0 final → tight
  // band) → the smooth, fee-led curve.
  const finalDiv = samples[samples.length - 1]!.divLossRaw;
  // The divergence band RAMPS from tight (early, when the build-up
  // reconstruction is noisiest) up to the real anchored final magnitude — so
  // the curve starts near $0 and rises with fees yet still lands
  // exactly on the live divergence at the last point. The ramp spans the
  // position's whole life; a range is cut out of the finished curve, so 30d
  // shows the same values as `all` for the same days.
  const fullCap = Math.max(2 * Math.abs(finalDiv), 50);
  const t0 = samples[0]!.t;
  const tSpan = (samples[samples.length - 1]!.t - t0) || 1;

  const series: PositionSeries = { pnl: [], assetsValue: [], apr: [], feeApr: [], divLoss: [] };
  for (const s of samples) {
    const frac = Math.min(1, Math.max(0, (s.t - t0) / tSpan));
    const divCap = Math.max(50, fullCap * frac);
    const divLoss = Math.max(-divCap, Math.min(divCap, s.divLossRaw));
    // Keep assetsValue consistent with the clamped divergence.
    const assetsValue = divLoss + s.depositedUsd - s.withdrawnUsd;
    const pnl = divLoss + s.feesAccrued - s.gasUsd;
    const annualization =
      s.depositedUsd > 0 && s.ageAtDay > 0 ? SECONDS_PER_YEAR / Math.max(s.ageAtDay, APR_MIN_AGE_SECONDS) : 0;
    const apr = s.depositedUsd > 0 ? (pnl / s.depositedUsd) * annualization * 100 : 0;
    const feeApr = s.depositedUsd > 0 ? (s.feesAccrued / s.depositedUsd) * annualization * 100 : 0;
    series.pnl.push({ t: s.t, value: pnl });
    series.assetsValue.push({ t: s.t, value: assetsValue });
    series.apr.push({ t: s.t, value: clampPct(apr) });
    series.feeApr.push({ t: s.t, value: clampPct(feeApr) });
    series.divLoss.push({ t: s.t, value: divLoss });
  }
  return series;
}

function txLiquidityDelta(
  tx: NormalizedPositionTransaction,
  tickByDay: Map<number, number>,
  tickLower: number,
  tickUpper: number,
  dec0: number,
  dec1: number,
): number {
  const kind = txKind(tx.type);
  if (kind !== 'deposit' && kind !== 'withdraw') return 0;
  const day = dayStart(tx.timestamp);
  const tick = tickByDay.get(day) ?? firstTick(tickByDay, day);
  const a0Raw = Math.abs(num(tx.amount0)) * Math.pow(10, dec0);
  const a1Raw = Math.abs(num(tx.amount1)) * Math.pow(10, dec1);
  if (a0Raw <= 0 && a1Raw <= 0) return 0;
  return liquidityForAmounts(tick, tickLower, tickUpper, a0Raw, a1Raw);
}

/** Day → USD price from a token's day data (zero and missing prices are left out). */
function tokenDayUsd(series: DaySeries<TokenDayRow> | undefined): Map<number, number> {
  const out = new Map<number, number>();
  for (const r of series?.rows ?? []) {
    const v = num(r.priceUSD);
    if (v > 0) out.set(dayStart(num(r.date)), v);
  }
  return out;
}

function emptyOverview(): PoolOverview {
  return { tvl: [], volume: [], fees: [], feesTvl: [], price0: [], price1: [], divergence: [] };
}

function pricePoints(rows: PoolDayRow[]): PricePoint[] {
  return rows.map((d) => ({
    t: num(d.date),
    token0Price: num(d.token0Price),
    token1Price: num(d.token1Price),
    open: num(d.open),
    high: num(d.high),
    low: num(d.low),
    close: num(d.close),
  }));
}

function overviewOf(rows: PoolDayRow[]): PoolOverview {
  return {
    tvl: rows.map((d) => ({ t: num(d.date), value: num(d.tvlUSD) })),
    volume: rows.map((d) => ({ t: num(d.date), value: num(d.volumeUSD) })),
    fees: rows.map((d) => ({ t: num(d.date), value: num(d.feesUSD) })),
    feesTvl: rows.map((d) => ({
      t: num(d.date),
      value: num(d.tvlUSD) > 0 ? num(d.feesUSD) / num(d.tvlUSD) : 0,
    })),
    price0: rows.map((d) => ({ t: num(d.date), value: num(d.token0Price) })),
    price1: rows.map((d) => ({ t: num(d.date), value: num(d.token1Price) })),
    divergence: [],
  };
}

/** The latest day-data point as the "current" pool stats, or null with no day data. */
function currentOf(rows: PoolDayRow[]): PoolCurrent | null {
  const latest = rows[rows.length - 1];
  return latest
    ? {
        tvl: num(latest.tvlUSD),
        volume: num(latest.volumeUSD),
        fees: num(latest.feesUSD),
        feesTvl: num(latest.tvlUSD) > 0 ? num(latest.feesUSD) / num(latest.tvlUSD) : 0,
      }
    : null;
}

/** The last `days` daily rows that EXIST — anchored to the newest row, not to now. */
export function lastDays<T extends { date: number }>(rows: T[], days: number): T[] {
  if (rows.length === 0) return rows;
  let newest = -Infinity;
  for (const row of rows) newest = Math.max(newest, num(row.date));
  const from = newest - days * DAY;
  return rows.filter((row) => num(row.date) > from);
}

/** The same window over points: the last `days` of each series, anchored to its own newest point. */
export function lastDaysOf<T extends { t: number }>(points: T[], days: number): T[] {
  if (points.length === 0) return points;
  let newest = -Infinity;
  for (const point of points) newest = Math.max(newest, point.t);
  const from = newest - days * DAY;
  return points.filter((point) => point.t > from);
}

function sliceSeries(series: PositionSeries, days: number): PositionSeries {
  return {
    pnl: lastDaysOf(series.pnl, days),
    assetsValue: lastDaysOf(series.assetsValue, days),
    apr: lastDaysOf(series.apr, days),
    feeApr: lastDaysOf(series.feeApr, days),
    divLoss: lastDaysOf(series.divLoss, days),
  };
}

/**
 * The position inputs a response is missing — including a transaction list cut
 * at its page cap, since the series it feeds then stops short of today's flows.
 * (A newest-page-only list never gets this far: `positionInputs` already lists
 * it missing, because a series cannot start from the middle of a history.)
 */
function partialInputs(inputs: PositionChartInputs): ChartInput[] {
  const missing = [...inputs.missing];
  if (inputs.transactions?.truncated && !missing.includes('transactions')) missing.push('transactions');
  return missing;
}

function withPartial<T extends PartialFlags>(charts: T, missing: ChartInput[]): T {
  return missing.length > 0 ? { ...charts, partial: true, missing } : charts;
}

function dayStart(ts: number): number {
  return Math.floor(ts / DAY) * DAY;
}

// Nearest available tick at/after a day — used to seed the walk / price old txns.
function firstTick(tickByDay: Map<number, number>, day: number): number {
  if (tickByDay.has(day)) return tickByDay.get(day)!;
  let best = 0;
  let bestDelta = Infinity;
  for (const [d, t] of tickByDay) {
    const delta = Math.abs(d - day);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = t;
    }
  }
  return best;
}

function txKind(type: string): 'deposit' | 'withdraw' | 'collect' | 'ignore' {
  const n = type.toUpperCase();
  if (n.includes('DEPOSIT') || n.includes('INCREASE_LIQUIDITY') || n === 'MINT') return 'deposit';
  if (n.includes('WITHDRAW') || n.includes('DECREASE_LIQUIDITY') || n === 'BURN') return 'withdraw';
  if (n.includes('COLLECT') || n.includes('CLAIM_FEES')) return 'collect';
  return 'ignore';
}

/**
 * Map raw subgraph ticks into the chart payload. Two corrections happen here
 * that callers must not re-implement (the frontend used to approximate both):
 *
 * 1. **Active liquidity.** `liquidityGross` counts every position merely
 *    *bounded* at a tick, so plotting it draws spikes at range edges with gaps
 *    between — not a depth curve. Active liquidity is the running sum of the
 *    signed `liquidityNet` from the lowest initialised tick upward: the
 *    liquidity actually in play across each bin, and what depth charts
 *    conventionally show.
 * 2. **Decimal-adjusted prices, COMPUTED from `tickIdx` — not read from the row.**
 *    A tick price is `1.0001^tickIdx` (token1-per-token0 in *base* units), made
 *    human-readable by `× 10^(dec0 - dec1)`; skipping the scale makes an 18/6
 *    pair read 1e12 out (which is why tooltips showed `9.99e+11`).
 *
 *    We DERIVE it rather than trusting `Tick.price0`/`price1` because the indexer
 *    stores those as fixed-scale decimals with 18 fractional digits, so anything
 *    below 1e-18 ROUNDS TO ZERO — that is every tick under -414,486 for `price0`
 *    and every tick over +414,486 for `price1`, i.e. both ends of a full-range
 *    position. Measured on the live indexer: 18-33% of the ticks we plot have a
 *    zeroed `price0` and 36-62% a zeroed `price1`. A zero is not a small number
 *    here, it is a MISSING one: it propagates as `price0 * 1.0001^d === 0` through
 *    the frontend's binning, and `fmtPrice` renders any `<= 0` as "-", so the whole
 *    price axis and every tooltip on such a pool read as blank rather than extreme.
 *    A double reaches ~1e-308, so computing it locally has no such cliff, and it
 *    reproduces the indexer's own non-zero values to 0.000000%.
 *
 * The running sum is only valid because the ticks read (`ticksSpec` in
 * `chart-inputs.service.ts`) orders ascending with no lower bound — it is exact
 * for pools with ≤1000 initialised ticks and correct-from-the-bottom (truncated
 * at the top) past that. Do not add a `tickIdx_gte` filter without revisiting
 * this.
 */
export function mapLiquidityTicks(
  rows: TickRow[],
  opts: { dec0: number; dec1: number; tickSpacing: number },
): LiquidityTick[] {
  const { dec0, dec1, tickSpacing } = opts;
  const priceScale = Math.pow(10, dec0 - dec1);
  const ascending = [...rows].sort((a, b) => num(a.tickIdx) - num(b.tickIdx));
  let running = 0n;
  return ascending.map((t) => {
    const tickIdx = num(t.tickIdx);
    running += bigIntOrZero(t.liquidityNet);
    // Clamp: a truncated tick window can make the running sum dip below zero.
    const activeLiquidity = running > 0n ? Number(running) : 0;
    const { amount0Raw, amount1Raw } = tickLockedAmounts(activeLiquidity, tickIdx, tickSpacing);
    // Derived, never read off the row — see the header note on fixed-scale zeros.
    const price0 = Math.pow(1.0001, tickIdx) * priceScale;
    return {
      tickIdx,
      liquidityGross: String(t.liquidityGross ?? '0'),
      liquidityNet: String(t.liquidityNet ?? '0'),
      activeLiquidity,
      price0,
      price1: price0 > 0 ? 1 / price0 : 0,
      amount0: amount0Raw / Math.pow(10, dec0),
      amount1: amount1Raw / Math.pow(10, dec1),
    };
  });
}

/** Parse a subgraph `BigInt!` string; never throw on a malformed value. */
function bigIntOrZero(value: string | undefined | null): bigint {
  if (!value) return 0n;
  try {
    return BigInt(value);
  } catch {
    const n = Number(value);
    return Number.isFinite(n) ? BigInt(Math.trunc(n)) : 0n;
  }
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function saneUsd(value: number): boolean {
  return Number.isFinite(value) && Math.abs(value) <= VALUE_CAP;
}

function clampPct(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-PCT_CAP, Math.min(PCT_CAP, value));
}
