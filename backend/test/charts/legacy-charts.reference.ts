/*
 * LEGACY REFERENCE — a verbatim copy of `src/charts/charts.service.ts` as it was
 * before the W6 chart-inputs rewrite (working tree on top of 551349e, with W1's
 * projected read and W3's shared retry already applied).
 *
 * It exists ONLY so `charts-fixture-equality.spec.ts` can assert that the new
 * implementation reproduces the old series on fixtures. The only edits from the
 * original are mechanical: Nest decorators removed, imports re-pointed at `src/`,
 * and the two `new GraphQLClient(url, subgraphFetch(integration))` constructions
 * routed through `clientFor()` so the spec can hand both implementations the
 * same in-memory subgraph. Do not "fix" anything in here — a bug in this file is
 * part of the baseline being compared against.
 */
import { Logger, NotFoundException } from '@nestjs/common';
import { GraphQLClient, gql } from 'graphql-request';
import type { AppConfigService } from '../../src/config/app-config.service.js';
import { CHARTS_PROJECTION, type PositionsRepository } from '../../src/database/positions.repository.js';
import type { AdapterRegistryService } from '../../src/subgraph/adapter-registry.service.js';
import type { NormalizedPositionTransaction } from '../../src/subgraph/normalized-position.js';
import { requestWithRetry } from '../../src/subgraph/request-retry.js';
import { amountsForLiquidity, liquidityForAmounts, tickLockedAmounts } from '../../src/charts/series-math.js';

// Position-detail charts. Vanilla-direct series: pool price (OHLC), pool-overview
// sparklines (TVL/volume/fees/feesTVL/price), the liquidity-distribution
// histogram (ticks), AND the backend-computed position PnL/assets/APR/feeApr/
// div-loss curves (per-tx cashflows × daily USD prices, valued each day at that
// day's price = vs-HODL basis). Pool/price data and cashflows both come from the
// Envio indexer, through the subgraph-dialect converter. The position-series
// final point lands at ≈ the position's current `metrics.pnlHodl`.

export type ChartRange = '30d' | '60d' | '90d' | '180d' | 'all';
const RANGE_DAYS: Record<string, number> = { '30d': 30, '60d': 60, '90d': 90, '180d': 180 };
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
export interface PositionCharts {
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
  poolOverviewCurrent: { tvl: number; volume: number; fees: number; feesTvl: number } | null;
}

export interface PoolCharts {
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
  poolOverviewCurrent: { tvl: number; volume: number; fees: number; feesTvl: number } | null;
}

const POOL_DAY_QUERY = gql`
  query PoolDay($pool: String!, $fromDate: Int!) {
    poolDayDatas(
      where: { pool: $pool, date_gte: $fromDate }
      orderBy: date
      orderDirection: asc
      first: 1000
    ) {
      date
      tick
      token0Price
      token1Price
      open
      high
      low
      close
      tvlUSD
      volumeUSD
      feesUSD
    }
  }
`;

const TOKEN_DAY_QUERY = gql`
  query TokenDay($token: String!, $fromDate: Int!) {
    tokenDayDatas(
      where: { token: $token, date_gte: $fromDate }
      orderBy: date
      orderDirection: asc
      first: 1000
    ) {
      date
      priceUSD
    }
  }
`;

const TICKS_QUERY = gql`
  query Ticks($pool: String!) {
    ticks(
      where: { pool: $pool, liquidityGross_gt: "0" }
      orderBy: tickIdx
      orderDirection: asc
      first: 1000
    ) {
      tickIdx
      liquidityGross
      liquidityNet
      price0
      price1
    }
  }
`;

const POOL_STATE_QUERY = gql`
  query PoolState($pool: String!) {
    pool(id: $pool) {
      tick
      sqrtPrice
      tickSpacing
      token0 {
        decimals
      }
      token1 {
        decimals
      }
    }
  }
`;

interface PoolDayRow {
  date: number;
  tick: string | null;
  token0Price: string;
  token1Price: string;
  open: string;
  high: string;
  low: string;
  close: string;
  tvlUSD: string;
  volumeUSD: string;
  feesUSD: string;
}
interface TokenDayRow {
  date: number;
  priceUSD: string;
}
interface TickRow {
  tickIdx: string;
  liquidityGross: string;
  liquidityNet: string;
  price0: string;
  price1: string;
}

export class LegacyChartsService {
  private readonly logger = new Logger('LegacyChartsService');

  constructor(
    private readonly config: AppConfigService,
    private readonly positions: PositionsRepository,
    private readonly adapters: AdapterRegistryService,
    private readonly clientFor: (integration: { subgraphUrl?: string }) => GraphQLClient,
  ) {}

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

    const out: PositionCharts = {
      range,
      poolPrice: [],
      poolOverview: { tvl: [], volume: [], fees: [], feesTvl: [], price0: [], price1: [], divergence: [] },
      liquidityDistribution: {
        currentTick: num(position.currentTick),
        tickLower: num(position.tickLower),
        tickUpper: num(position.tickUpper),
        ticks: [],
      },
      positionSeries: null,
      poolOverviewCurrent: null,
    };

    const integration = this.config.getIntegration(chainId, protocol);
    if (!integration?.subgraphUrl) {
      this.logger.warn(`No vanilla subgraphUrl for ${chainId}:${protocol} — charts empty`);
      return out;
    }

    const client = this.clientFor(integration);
    const poolId = String(position.poolId).toLowerCase();
    const nowSec = Math.floor(Date.now() / 1000);
    const createdAt = num(position.createdAtTimestamp);
    const createdAtDay = createdAt > 0 ? dayStart(createdAt) : nowSec - 180 * DAY;
    // `all` → full position lifetime (the default for the PnL series). Other
    // ranges window the last N days. The series is cumulative either way, so we
    // always fetch pool/token day data back to creation and slice to `rangeFrom`.
    const days = RANGE_DAYS[range];
    const rangeFrom = range === 'all' || !days ? createdAtDay : nowSec - days * DAY;
    const seriesFrom = Math.min(rangeFrom, createdAtDay);

    // Pool price + overview (one poolDayDatas walk back to seriesFrom; sliced per series).
    let poolRows: PoolDayRow[] = [];
    try {
      const dd: { poolDayDatas?: PoolDayRow[] } = await requestWithRetry(client, POOL_DAY_QUERY, {
        pool: poolId,
        fromDate: seriesFrom,
      });
      poolRows = dd.poolDayDatas ?? [];
      const inRange = poolRows.filter((d) => num(d.date) >= rangeFrom);
      out.poolPrice = inRange.map((d) => ({
        t: num(d.date),
        token0Price: num(d.token0Price),
        token1Price: num(d.token1Price),
        open: num(d.open),
        high: num(d.high),
        low: num(d.low),
        close: num(d.close),
      }));
      out.poolOverview = {
        tvl: inRange.map((d) => ({ t: num(d.date), value: num(d.tvlUSD) })),
        volume: inRange.map((d) => ({ t: num(d.date), value: num(d.volumeUSD) })),
        fees: inRange.map((d) => ({ t: num(d.date), value: num(d.feesUSD) })),
        feesTvl: inRange.map((d) => ({
          t: num(d.date),
          value: num(d.tvlUSD) > 0 ? num(d.feesUSD) / num(d.tvlUSD) : 0,
        })),
        price0: inRange.map((d) => ({ t: num(d.date), value: num(d.token0Price) })),
        price1: inRange.map((d) => ({ t: num(d.date), value: num(d.token1Price) })),
        divergence: [],
      };
      // Current pool stats = latest day-data point (rows are date-asc). Reliable
      // because this on-demand walk works even when the backfill `poolStats` fetch
      // was rate-limited to 0. Per-day (24h) volume/fees match the sparkline.
      const latest = poolRows[poolRows.length - 1];
      out.poolOverviewCurrent = latest
        ? {
            tvl: num(latest.tvlUSD),
            volume: num(latest.volumeUSD),
            fees: num(latest.feesUSD),
            feesTvl: num(latest.tvlUSD) > 0 ? num(latest.feesUSD) / num(latest.tvlUSD) : 0,
          }
        : null;
    } catch (err) {
      this.logger.warn(`poolDayDatas fetch failed for ${poolId}: ${(err as Error)?.message ?? String(err)}`);
    }

    // Liquidity distribution (ticks with non-zero liquidity). Each bin is
    // enriched with the token amounts it locks (tick-math) so the UI tooltip can
    // show the locked-token USD value.
    try {
      const tk: { ticks?: TickRow[] } = await requestWithRetry(client, TICKS_QUERY, { pool: poolId });
      const dec0 = num(position.token0?.decimals) || 18;
      const dec1 = num(position.token1?.decimals) || 18;
      const tickSpacing = num(position.tickSpacing) || 1;
      out.liquidityDistribution.ticks = mapLiquidityTicks(tk.ticks ?? [], {
        dec0,
        dec1,
        tickSpacing,
      });
    } catch (err) {
      this.logger.warn(`ticks fetch failed for ${poolId}: ${(err as Error)?.message ?? String(err)}`);
    }

    // Position-level computed series (PnL/assets/APR/feeApr/div-loss).
    try {
      out.positionSeries = await this.computePositionSeries(
        position,
        protocol,
        integration,
        client,
        poolRows,
        seriesFrom,
        rangeFrom,
        nowSec,
      );
    } catch (err) {
      this.logger.warn(
        `position series failed for ${chainId}:${protocol}:${positionId}: ${(err as Error)?.message ?? String(err)}`,
      );
    }

    return out;
  }

  /**
   * Reconstruct the position's daily PnL/assets/APR/feeApr/div-loss curve from
   * indexed per-tx cashflows valued at each day's USD prices. Liquidity is
   * reconstructed from the deposit/withdraw amounts (inverse tick-math) and
   * normalised so the final day matches the position's real current liquidity —
   * making the last point land at ≈ `metrics.pnlHodl`.
   */
  private async computePositionSeries(
    position: Awaited<ReturnType<PositionsRepository['findOne']>>,
    protocol: string,
    integration: ReturnType<AppConfigService['getIntegration']>,
    client: GraphQLClient,
    poolRows: PoolDayRow[],
    seriesFrom: number,
    rangeFrom: number,
    nowSec: number,
  ): Promise<PositionSeries | null> {
    if (!position || !integration) return null;
    const adapter = this.adapters.resolve(protocol);
    if (!adapter.fetchPositionTransactions) return null;

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
    const [t0Usd, t1Usd] = await Promise.all([
      this.fetchTokenDayUsd(client, position.token0?.address, seriesFrom),
      this.fetchTokenDayUsd(client, position.token1?.address, seriesFrom),
    ]);

    // All cashflows for the position (full history → correct cumulative at range start).
    const { transactions } = await adapter.fetchPositionTransactions({
      integration,
      positionIds: [String(position.positionId)],
      cursorTimestamp: 0,
      pageSize: 1000,
      maxPages: 1000,
    });
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
      const mag = this.txLiquidityDelta(tx, tickByDay, tickLower, tickUpper, dec0, dec1);
      reconstructedNow += kind === 'deposit' ? mag : -mag;
    }
    let liqFactor =
      actualLiquidityNow > 0 && reconstructedNow > 0 ? actualLiquidityNow / reconstructedNow : 1;
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
          cumLiq += this.txLiquidityDelta(tx, tickByDay, tickLower, tickUpper, dec0, dec1);
        } else if (kind === 'withdraw') {
          wd0 += a0;
          wd1 += a1;
          cumLiq -= this.txLiquidityDelta(tx, tickByDay, tickLower, tickUpper, dec0, dec1);
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
      if (day >= rangeFrom && saneUsd(divLossRaw) && saneUsd(depositedUsd) && saneUsd(feesAccrued)) {
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
    // exactly on the live divergence at the last point.
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

  private txLiquidityDelta(
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

  async getPoolCharts(
    chainId: number,
    protocol: string,
    poolId: string,
    range: ChartRange = '30d',
  ): Promise<PoolCharts> {
    const out: PoolCharts = {
      range,
      poolPrice: [],
      poolOverview: { tvl: [], volume: [], fees: [], feesTvl: [], price0: [], price1: [], divergence: [] },
      liquidityDistribution: { currentTick: 0, ticks: [] },
      poolSeries: { volume: [], tvl: [], fees: [], feeApr: [] },
      poolOverviewCurrent: null,
    };

    const integration = this.config.getIntegration(chainId, protocol);
    if (!integration?.subgraphUrl) {
      this.logger.warn(`No subgraphUrl for ${chainId}:${protocol} — pool charts empty`);
      return out;
    }

    const client = this.clientFor(integration);
    const poolIdLower = poolId.toLowerCase();
    const nowSec = Math.floor(Date.now() / 1000);
    const days = RANGE_DAYS[range];
    const rangeFrom = range === 'all' || !days ? nowSec - 365 * DAY : nowSec - days * DAY;

    // Pool state (current tick + decimals for liquidity histogram)
    let currentTick = 0;
    let dec0 = 18;
    let dec1 = 18;
    let tickSpacing = 60;
    try {
      const state: { pool: { tick: string | null; sqrtPrice: string; tickSpacing: string; token0: { decimals: string }; token1: { decimals: string } } | null } =
        await requestWithRetry(client, POOL_STATE_QUERY, { pool: poolIdLower });
      if (state.pool) {
        currentTick = state.pool.tick !== null ? num(state.pool.tick) : 0;
        dec0 = num(state.pool.token0.decimals) || 18;
        dec1 = num(state.pool.token1.decimals) || 18;
        tickSpacing = num(state.pool.tickSpacing) || 60;
        out.liquidityDistribution.currentTick = currentTick;
      }
    } catch (err) {
      this.logger.warn(`Pool state fetch failed for ${poolIdLower}: ${(err as Error)?.message}`);
    }

    // Pool daily data → price + overview + series
    try {
      const dd: { poolDayDatas?: PoolDayRow[] } = await requestWithRetry(client, POOL_DAY_QUERY, {
        pool: poolIdLower,
        fromDate: rangeFrom,
      });
      const rows = dd.poolDayDatas ?? [];
      out.poolPrice = rows.map((d) => ({
        t: num(d.date),
        token0Price: num(d.token0Price),
        token1Price: num(d.token1Price),
        open: num(d.open),
        high: num(d.high),
        low: num(d.low),
        close: num(d.close),
      }));
      out.poolOverview = {
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
      const latest = rows[rows.length - 1];
      out.poolOverviewCurrent = latest
        ? {
            tvl: num(latest.tvlUSD),
            volume: num(latest.volumeUSD),
            fees: num(latest.feesUSD),
            feesTvl: num(latest.tvlUSD) > 0 ? num(latest.feesUSD) / num(latest.tvlUSD) : 0,
          }
        : null;
    } catch (err) {
      this.logger.warn(`Pool day data fetch failed for ${poolIdLower}: ${(err as Error)?.message}`);
    }

    // Liquidity distribution
    try {
      const tk: { ticks?: TickRow[] } = await requestWithRetry(client, TICKS_QUERY, { pool: poolIdLower });
      out.liquidityDistribution.ticks = mapLiquidityTicks(tk.ticks ?? [], {
        dec0,
        dec1,
        tickSpacing,
      });
    } catch (err) {
      this.logger.warn(`Ticks fetch failed for pool ${poolIdLower}: ${(err as Error)?.message}`);
    }

    return out;
  }

  private async fetchTokenDayUsd(
    client: GraphQLClient,
    address: string | undefined,
    fromDate: number,
  ): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    const token = (address ?? '').toLowerCase();
    if (!token) return out;
    try {
      const data: { tokenDayDatas?: TokenDayRow[] } = await requestWithRetry(client, TOKEN_DAY_QUERY, {
        token,
        fromDate,
      });
      for (const r of data.tokenDayDatas ?? []) {
        const v = num(r.priceUSD);
        if (v > 0) out.set(dayStart(num(r.date)), v);
      }
    } catch (err) {
      this.logger.warn(`tokenDayDatas fetch failed for ${token}: ${(err as Error)?.message ?? String(err)}`);
    }
    return out;
  }
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
 * The running sum is only valid because `TICKS_QUERY` orders ascending with no
 * lower bound — it is exact for pools with ≤1000 initialised ticks and
 * correct-from-the-bottom (truncated at the top) past that. Do not add a
 * `tickIdx_gte` filter without revisiting this.
 */
function mapLiquidityTicks(
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
