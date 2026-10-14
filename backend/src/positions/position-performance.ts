import type { Position } from '../database/schemas/position.schema.js';
import type { NormalizedPositionTransaction } from '../subgraph/normalized-position.js';

const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;
const APR_MIN_AGE_SECONDS = 24 * 60 * 60; // 24h floor: positions younger than this annualize against the floor, not real age

export interface PositionPerformanceUpdate {
  positionId: string;
  metrics: Partial<Position['metrics']>;
  amounts: Partial<Position['amounts']>;
}

type TransactionLike = Pick<
  NormalizedPositionTransaction,
  | 'type'
  | 'txHash'
  | 'timestamp'
  | 'amount0'
  | 'amount1'
  | 'amount0HistoricalPriceUsd'
  | 'amount1HistoricalPriceUsd'
  | 'historicalValueUsd'
  | 'historicalPricingSource'
  | 'gasCostUsd'
  | 'gasCostEth'
>;

/**
 * Per-recompute context the caller threads in. `ethPriceNow` is the current
 * native (WETH) USD price, used to value gas at the current ETH price for the
 * vs-HODL PnL / APR (HODL gas is valued at the current ETH price). Fetched
 * once per batch by `recomputeBatchPerformance`.
 */
export interface RecomputeContext {
  ethPriceNow?: number;
}

export function computePerformanceUpdate(
  position: Position,
  transactions: TransactionLike[],
  ctx: RecomputeContext = {},
): PositionPerformanceUpdate {
  const cashFlows = cashFlowsAtHistoricalPrices(transactions);
  const pendingFeesUsd = finite(position.metrics.pendingFeesUsd);
  const underlyingNowUsd = finite(position.metrics.underlyingValueUsd);
  const ageSeconds = Math.max(0, finite(position.metrics.ageSeconds));
  const pendingRewardsUsd = finite(position.metrics.unclaimedRewardsUsd);
  const claimedRewardsUsd = finite(position.metrics.claimedRewardsUsd);
  // Current token prices (refreshed on every position fetch) drive the
  // vs-HODL basis: deposits/withdrawals/fees re-valued at current price.
  const p0Now = finite(position.token0?.priceUsd);
  const p1Now = finite(position.token1?.priceUsd);
  const ethPriceNow = finite(ctx.ethPriceNow ?? 0);
  // Current underlying token amounts (human units) for token-level diffs.
  const currentToken0 = Math.abs(toNumber(position.amounts?.amount0));
  const currentToken1 = Math.abs(toNumber(position.amounts?.amount1));

  // History-complete gate. Without this, a position with partial tx history
  // (e.g., subgraph cursor walk hasn't reached the earliest deposit yet) can
  // produce a "valid-looking" PnL/APR from whichever cashflows happen to be
  // priced — and that nonsense gets pinned via performanceReady=true.
  //
  // We treat history as complete only when tx sync succeeded for this
  // position AND, for closed positions, the finalizer ran (txFinalizedAt set).
  // Active positions can rank as soon as tx sync reports success because new
  // deposits are caught by the next refresh tick's tx-sync dispatch.
  const txSyncStatus = position.txSyncStatus;
  const txSyncedCount = position.txSyncedTransactionCount ?? 0;
  const finalizedAt = position.txFinalizedAt;
  const historyComplete =
    txSyncStatus === 'success' &&
    txSyncedCount >= 0 &&
    (position.isActive ? true : finalizedAt instanceof Date);

  if (!historyComplete) {
    return incompletePerformanceUpdate(
      position.positionId,
      position.metrics,
      pendingFeesUsd,
      'pending-history',
    );
  }

  if (!cashFlows.hasDeposit) {
    return incompletePerformanceUpdate(
      position.positionId,
      position.metrics,
      pendingFeesUsd,
      'pending-transactions',
    );
  }

  if (cashFlows.hasUnpricedCashFlow) {
    return incompletePerformanceUpdate(
      position.positionId,
      position.metrics,
      pendingFeesUsd,
      'pending-prices',
    );
  }

  // vs-HODL basis re-values deposits/withdrawals/fees at CURRENT price. Without
  // current token prices we can't value the HODL benchmark — hold pending until
  // the next refresh re-prefetches them.
  if (p0Now <= 0 || p1Now <= 0) {
    return incompletePerformanceUpdate(
      position.positionId,
      position.metrics,
      pendingFeesUsd,
      'pending-prices',
    );
  }

  return {
    positionId: position.positionId,
    ...buildPerformancePatch({
      underlyingNowUsd,
      pendingFeesUsd,
      ageSeconds,
      pendingRewardsUsd,
      claimedRewardsUsd,
      p0Now,
      p1Now,
      ethPriceNow,
      currentToken0,
      currentToken1,
      cashFlows,
      performanceReady: true,
      performanceSource: 'internal-cashflows',
    }),
  };
}

/**
 * Aggregates recompute. Computes the vs-HODL metrics (the leaderboard's
 * headline set: pnlHodl/roi/apr/aprExGas/feeApr/poolPnl/divergenceLoss) from the
 * position-row AGGREGATES that the indexer accumulates
 * (`depositedToken0/1`, `withdrawnToken0/1`, `totalFeesCollected0/1`,
 * `totalGasCostEth`) re-valued at the CURRENT token price — so it needs **no
 * transaction history at all**. The vs-USD (tx-time) basis is left zero here; it
 * requires per-tx historical prices and is computed on-demand for the detail
 * view from the indexer's `positionTransaction`. This is the path that lets the
 * leaderboard run without the Mongo `position_transactions` collection (Phase 7).
 *
 * Same `buildPerformancePatch` math as the tx-based `computePerformanceUpdate`,
 * so the two paths produce identical vs-HODL numbers given the same aggregates.
 */
export function computePerformanceFromAggregates(
  position: Position,
  ctx: RecomputeContext = {},
): PositionPerformanceUpdate {
  const a = position.amounts;
  const cashFlows: CashFlows = {
    depositedToken0: toNumber(a?.depositedToken0),
    depositedToken1: toNumber(a?.depositedToken1),
    withdrawnToken0: toNumber(a?.withdrawnToken0),
    withdrawnToken1: toNumber(a?.withdrawnToken1),
    collectedToken0: toNumber(a?.totalFeesCollected0),
    collectedToken1: toNumber(a?.totalFeesCollected1),
    // vs-USD (tx-time) basis is unavailable from aggregates — detail-only.
    depositedUsdHist: 0,
    withdrawnUsdHist: 0,
    collectedFeesUsdHist: 0,
    gasCostUsd: 0, // gas valued at current ETH price via ethPriceNow below
    gasCostEth: toNumber(a?.totalGasCostEth),
    hasDeposit: toNumber(a?.depositedToken0) > 0 || toNumber(a?.depositedToken1) > 0,
    hasUnpricedCashFlow: false,
  };

  const pendingFeesUsd = finite(position.metrics.pendingFeesUsd);
  const underlyingNowUsd = finite(position.metrics.underlyingValueUsd);
  const ageSeconds = Math.max(0, finite(position.metrics.ageSeconds));
  const pendingRewardsUsd = finite(position.metrics.unclaimedRewardsUsd);
  const claimedRewardsUsd = finite(position.metrics.claimedRewardsUsd);
  const p0Now = finite(position.token0?.priceUsd);
  const p1Now = finite(position.token1?.priceUsd);
  const ethPriceNow = finite(ctx.ethPriceNow ?? 0);
  const currentToken0 = Math.abs(toNumber(position.amounts?.amount0));
  const currentToken1 = Math.abs(toNumber(position.amounts?.amount1));

  // Valuation-rejected rows (isPriceable=false) must not get performance
  // metrics: their stored token prices can be quotes the valuation guard
  // already refused to value (PNKSTR's genuine-but-unrealizable $0.008 × 1B
  // deposited would otherwise mint a −$8M PnL onto a $0 position and top the
  // loss-sorted views).
  if (position.metrics?.isPriceable === false) {
    return incompletePerformanceUpdate(position.positionId, position.metrics, 0, 'invalid-valuation');
  }
  if (!cashFlows.hasDeposit) {
    return incompletePerformanceUpdate(position.positionId, position.metrics, pendingFeesUsd, 'pending-aggregates');
  }
  // vs-HODL re-values flows at current price — need both current token prices.
  if (p0Now <= 0 || p1Now <= 0) {
    return incompletePerformanceUpdate(position.positionId, position.metrics, pendingFeesUsd, 'pending-prices');
  }

  return {
    positionId: position.positionId,
    ...buildPerformancePatch({
      underlyingNowUsd,
      pendingFeesUsd,
      ageSeconds,
      pendingRewardsUsd,
      claimedRewardsUsd,
      p0Now,
      p1Now,
      ethPriceNow,
      currentToken0,
      currentToken1,
      cashFlows,
      performanceReady: true,
      // KEPT verbatim through the Envio cutover, deliberately. This string is
      // stored on every position document and SERVED on the metered /v1 detail
      // route, so renaming it is a breaking change to a published field for a
      // purely cosmetic gain — and it would need a migration to avoid two
      // spellings coexisting in Mongo. It means "recomputed from row
      // aggregates", which is still exactly what happened.
      performanceSource: 'ponder-aggregates',
    }),
  };
}

/**
 * Lightweight refresh used during a plain position upsert (no transaction
 * re-read). Re-derives the HODL-basis metrics from the previously-stored
 * current-price aggregates (`depositedUsd`/`withdrawnUsd`/`collectedFeesUsd`,
 * already current-price from the last full recompute) plus the fresh
 * underlying / pending-fees / rewards snapshot. Deposits/withdrawals stay at
 * the last full-recompute's prices until the next tx-sync recompute re-prices
 * them — accurate enough between ticks since the full recompute runs each
 * refresh for active positions. `pnlUsd` (vs-USD) is carried forward unchanged
 * (its tx-time inputs aren't stored separately).
 */
export function refreshPerformanceFromStoredCashFlows(
  current: Position['metrics'],
  previous: Position['metrics'] | undefined,
): Partial<Position['metrics']> {
  const depositedUsdNow = finite(previous?.depositedUsd ?? 0);
  if (!previous?.performanceReady || depositedUsdNow <= 0) {
    return {
      ...current,
      performanceReady: false,
      performanceSource: current.performanceSource ?? 'pending-transactions',
    };
  }

  const withdrawnUsdNow = finite(previous.withdrawnUsd);
  const collectedFeesNow = finite(previous.collectedFeesUsd);
  const pendingFeesUsd = finite(current.pendingFeesUsd);
  const underlyingNowUsd = finite(current.underlyingValueUsd);
  const rewardsUsd = finite(current.unclaimedRewardsUsd) + finite(current.claimedRewardsUsd);
  const gasUsdNow = finite(previous.totalGasCostUsd);
  const ageSeconds = Math.max(0, finite(current.ageSeconds));

  const divergenceNow = underlyingNowUsd + withdrawnUsdNow - depositedUsdNow;
  const feesAccruedNow = collectedFeesNow + pendingFeesUsd;
  const poolPnlUsd = divergenceNow + feesAccruedNow;
  const pnlHodl = poolPnlUsd + rewardsUsd - gasUsdNow;

  const denom = depositedUsdNow;
  const aprWarmup = ageSeconds > 0 && ageSeconds < APR_MIN_AGE_SECONDS;
  const annualization = ageSeconds > 0 ? SECONDS_PER_YEAR / Math.max(ageSeconds, APR_MIN_AGE_SECONDS) : 0;

  return {
    ...current,
    apr: finite((pnlHodl / denom) * annualization * 100),
    aprExGas: finite((poolPnlUsd / denom) * annualization * 100),
    poolApr: finite((poolPnlUsd / denom) * annualization * 100),
    feeApr: finite((feesAccruedNow / denom) * annualization * 100),
    roi: finite((pnlHodl / denom) * 100),
    pnlHodl: finite(pnlHodl),
    poolPnlUsd: finite(poolPnlUsd),
    divergenceLossUsd: finite(divergenceNow),
    diffUsd: finite(divergenceNow),
    totalFeesUsd: finite(feesAccruedNow),
    // vs-USD set can't be re-derived without the tx-time aggregates; carry the
    // last full recompute's value forward (full recompute refreshes it).
    usd: previous.usd ?? current.usd,
    performanceReady: true,
    performanceSource: previous.performanceSource ?? 'internal-cashflows',
    aprWarmup,
  };
}

interface CashFlows {
  // Token-unit aggregates (human units — subgraph amounts are decimal-adjusted)
  // used to re-value flows at CURRENT price for the vs-HODL basis.
  depositedToken0: number;
  depositedToken1: number;
  withdrawnToken0: number;
  withdrawnToken1: number;
  collectedToken0: number;
  collectedToken1: number;
  // USD at tx-time (historical) price — the vs-USD basis.
  depositedUsdHist: number;
  withdrawnUsdHist: number;
  collectedFeesUsdHist: number;
  // Gas in both bases (per-txHash deduped).
  gasCostUsd: number;
  gasCostEth: number;
  hasDeposit: boolean;
  hasUnpricedCashFlow: boolean;
}

function cashFlowsAtHistoricalPrices(transactions: TransactionLike[]): CashFlows {
  let depositedToken0 = 0;
  let depositedToken1 = 0;
  let withdrawnToken0 = 0;
  let withdrawnToken1 = 0;
  let collectedToken0 = 0;
  let collectedToken1 = 0;
  let depositedUsdHist = 0;
  let withdrawnUsdHist = 0;
  let collectedFeesUsdHist = 0;
  let gasCostUsd = 0;
  let gasCostEth = 0;
  let hasDeposit = false;
  let hasUnpricedCashFlow = false;
  const gasTxHashes = new Set<string>();

  for (let index = 0; index < transactions.length; index++) {
    const transaction = transactions[index];
    if (!transaction) continue;
    const kind = transactionKind(transaction.type);
    if (kind === 'ignore') continue;

    // Gas is paid per on-chain tx regardless of leg pricing — dedup by txHash
    // and count it before the unpriced-leg skip below.
    const gasKey = transaction.txHash || `${transaction.type}:${index}`;
    if (!gasTxHashes.has(gasKey)) {
      gasCostUsd += finite(transaction.gasCostUsd);
      gasCostEth += finite(transaction.gasCostEth);
      gasTxHashes.add(gasKey);
    }

    const amount0 = Math.abs(toNumber(transaction.amount0));
    const amount1 = Math.abs(toNumber(transaction.amount1));
    const needs0 = amount0 > 0;
    const needs1 = amount1 > 0;
    if (!needs0 && !needs1) continue;

    const price0 = finite(transaction.amount0HistoricalPriceUsd);
    const price1 = finite(transaction.amount1HistoricalPriceUsd);
    const source = transaction.historicalPricingSource ?? 'none';
    if (source === 'none' || (needs0 && price0 <= 0) || (needs1 && price1 <= 0)) {
      hasUnpricedCashFlow = true;
      continue;
    }

    const valueUsd = amount0 * price0 + amount1 * price1;

    if (kind === 'deposit') {
      depositedToken0 += amount0;
      depositedToken1 += amount1;
      depositedUsdHist += valueUsd;
      if (valueUsd > 0) hasDeposit = true;
    } else if (kind === 'withdraw') {
      withdrawnToken0 += amount0;
      withdrawnToken1 += amount1;
      withdrawnUsdHist += valueUsd;
    } else if (kind === 'collect') {
      collectedToken0 += amount0;
      collectedToken1 += amount1;
      collectedFeesUsdHist += valueUsd;
    }
  }

  return {
    depositedToken0,
    depositedToken1,
    withdrawnToken0,
    withdrawnToken1,
    collectedToken0,
    collectedToken1,
    depositedUsdHist,
    withdrawnUsdHist,
    collectedFeesUsdHist,
    gasCostUsd,
    gasCostEth,
    hasDeposit,
    hasUnpricedCashFlow,
  };
}

/**
 * Compute the full metric set. Metrics are on the **vs-HODL
 * (current-price)** basis — deposits/withdrawals/collected-fees re-valued at the
 * current token price — which is what the leaderboard ranks by (pool PnL + APR-ex-gas).
 * `pnlUsd` is the one cross-basis number: the **vs-USD** total, using
 * tx-time (deposit/withdrawal/claim) prices. `pnlEth` is deferred (0).
 */
function buildPerformancePatch(input: {
  underlyingNowUsd: number;
  pendingFeesUsd: number;
  ageSeconds: number;
  pendingRewardsUsd: number;
  claimedRewardsUsd: number;
  p0Now: number;
  p1Now: number;
  ethPriceNow: number;
  currentToken0: number;
  currentToken1: number;
  cashFlows: CashFlows;
  performanceReady: boolean;
  performanceSource: string;
}): Omit<PositionPerformanceUpdate, 'positionId'> {
  const cf = input.cashFlows;
  const rewardsUsd = input.pendingRewardsUsd + input.claimedRewardsUsd;

  // ── vs-HODL basis: re-value every flow at the CURRENT token price ──
  const depositedUsdNow = cf.depositedToken0 * input.p0Now + cf.depositedToken1 * input.p1Now;
  const withdrawnUsdNow = cf.withdrawnToken0 * input.p0Now + cf.withdrawnToken1 * input.p1Now;
  const collectedFeesNow = cf.collectedToken0 * input.p0Now + cf.collectedToken1 * input.p1Now;
  // Principal-only impermanent loss/gain at current price (= canonical "diffs").
  const divergenceNow = input.underlyingNowUsd + withdrawnUsdNow - depositedUsdNow;
  const feesAccruedNow = collectedFeesNow + input.pendingFeesUsd;
  // Pool PnL = fees accrued + price divergence (current price).
  const poolPnlUsd = divergenceNow + feesAccruedNow;
  // HODL gas at the CURRENT ETH price (fall back to tx-price gas if ETH price
  // is unavailable this tick).
  const gasUsdNow = input.ethPriceNow > 0 ? cf.gasCostEth * input.ethPriceNow : cf.gasCostUsd;
  const pnlHodl = poolPnlUsd + rewardsUsd - gasUsdNow;

  // ── vs-USD basis: flows at tx-time (deposit/withdrawal/claim) price ──
  const divergenceHist = input.underlyingNowUsd + cf.withdrawnUsdHist - cf.depositedUsdHist;
  const feesAccruedHist = cf.collectedFeesUsdHist + input.pendingFeesUsd;
  const pnlUsd = divergenceHist + feesAccruedHist + rewardsUsd - cf.gasCostUsd;

  // Denominator = current value of deposited tokens (the HODL benchmark).
  // Single lever per the plan — flip to depositedUsdHist if a comparison with an
  // external reference shows a systematic offset.
  const denom = depositedUsdNow;
  const aprWarmup = input.ageSeconds > 0 && input.ageSeconds < APR_MIN_AGE_SECONDS;
  const aprAgeSeconds = Math.max(input.ageSeconds, APR_MIN_AGE_SECONDS);
  const annualization = input.ageSeconds > 0 && denom > 0 ? SECONDS_PER_YEAR / aprAgeSeconds : 0;

  const roi = denom > 0 ? (pnlHodl / denom) * 100 : 0;
  const apr = denom > 0 ? (pnlHodl / denom) * annualization * 100 : 0;
  const aprExGas = denom > 0 ? (poolPnlUsd / denom) * annualization * 100 : 0;
  const feeApr = denom > 0 ? (feesAccruedNow / denom) * annualization * 100 : 0;

  const diffToken0 = input.currentToken0 - cf.depositedToken0 + cf.withdrawnToken0;
  const diffToken1 = input.currentToken1 - cf.depositedToken1 + cf.withdrawnToken1;

  // vs-USD companion set for the detail-view `ref USD` toggle. Same shape as the
  // headline metrics but on the tx-time basis, denominated against the cost
  // basis (depositedUsdHist). Top-level metrics remain vs-HODL.
  const poolPnlUsdVsUsd = divergenceHist + feesAccruedHist;
  const denomUsd = cf.depositedUsdHist;
  const usdAnnualization = input.ageSeconds > 0 && denomUsd > 0 ? SECONDS_PER_YEAR / aprAgeSeconds : 0;
  const usd = {
    pnlUsd: finite(pnlUsd),
    poolPnlUsd: finite(poolPnlUsdVsUsd),
    divergenceLossUsd: finite(divergenceHist),
    apr: finite(denomUsd > 0 ? (pnlUsd / denomUsd) * usdAnnualization * 100 : 0),
    aprExGas: finite(denomUsd > 0 ? (poolPnlUsdVsUsd / denomUsd) * usdAnnualization * 100 : 0),
    feeApr: finite(denomUsd > 0 ? (feesAccruedHist / denomUsd) * usdAnnualization * 100 : 0),
    roi: finite(denomUsd > 0 ? (pnlUsd / denomUsd) * 100 : 0),
  };

  return {
    metrics: {
      apr: finite(apr),
      aprExGas: finite(aprExGas),
      feeApr: finite(feeApr),
      poolApr: finite(aprExGas),
      roi: finite(roi),
      pnlUsd: finite(pnlUsd),
      pnlEth: 0,
      pnlHodl: finite(pnlHodl),
      poolPnlUsd: finite(poolPnlUsd),
      divergenceLossUsd: finite(divergenceNow),
      collectedFeesUsd: finite(collectedFeesNow),
      totalFeesUsd: finite(feesAccruedNow),
      totalGasCostUsd: finite(gasUsdNow),
      investedUsd: finite(depositedUsdNow),
      depositedUsd: finite(depositedUsdNow),
      withdrawnUsd: finite(withdrawnUsdNow),
      diffUsd: finite(divergenceNow),
      unclaimedRewardsUsd: finite(input.pendingRewardsUsd),
      claimedRewardsUsd: finite(input.claimedRewardsUsd),
      usd,
      performanceReady: input.performanceReady,
      performanceSource: input.performanceSource,
      aprWarmup,
    },
    amounts: {
      depositedToken0: String(finite(cf.depositedToken0)),
      depositedToken1: String(finite(cf.depositedToken1)),
      depositedUsd: String(finite(depositedUsdNow)),
      withdrawnToken0: String(finite(cf.withdrawnToken0)),
      withdrawnToken1: String(finite(cf.withdrawnToken1)),
      withdrawnUsd: String(finite(withdrawnUsdNow)),
      totalFeesCollected0: String(finite(cf.collectedToken0)),
      totalFeesCollected1: String(finite(cf.collectedToken1)),
      totalFeesCollectedUsd: String(finite(collectedFeesNow)),
      totalFeesUncollectedUsd: String(finite(input.pendingFeesUsd)),
      totalGasCostEth: String(finite(cf.gasCostEth)),
      totalGasCostUsd: String(finite(gasUsdNow)),
      diffToken0: String(finite(diffToken0)),
      diffToken1: String(finite(diffToken1)),
      diffUsd: String(finite(divergenceNow)),
    },
  };
}

function incompletePerformanceUpdate(
  positionId: string,
  metrics: Position['metrics'],
  pendingFeesUsd: number,
  source?: string,
): PositionPerformanceUpdate {
  // Only clear cashflow-derived metrics. Adapter-populated current-state metrics
  // (underlyingValueUsd, pendingFeesUsd, collectedFeesUsd, inRange, isPriceable,
  // unclaimedRewardsUsd, claimedRewardsUsd, ageSeconds) stay intact via the
  // partial $set semantics in updatePerformanceMetrics.
  return {
    positionId,
    metrics: {
      apr: 0,
      aprExGas: 0,
      feeApr: 0,
      poolApr: 0,
      roi: 0,
      pnlUsd: 0,
      pnlEth: 0,
      pnlHodl: 0,
      poolPnlUsd: 0,
      divergenceLossUsd: 0,
      totalFeesUsd: finite(pendingFeesUsd),
      totalGasCostUsd: 0,
      investedUsd: 0,
      depositedUsd: 0,
      withdrawnUsd: 0,
      diffUsd: 0,
      usd: { pnlUsd: 0, poolPnlUsd: 0, divergenceLossUsd: 0, apr: 0, aprExGas: 0, feeApr: 0, roi: 0 },
      performanceReady: false,
      performanceSource: source ?? metrics.performanceSource ?? 'pending-transactions',
      aprWarmup: false,
    },
    amounts: {
      depositedUsd: '0',
      withdrawnUsd: '0',
      totalFeesCollectedUsd: '0',
      totalFeesUncollectedUsd: String(finite(pendingFeesUsd)),
      totalGasCostUsd: '0',
      diffUsd: '0',
    },
  };
}

function transactionKind(type: string): 'deposit' | 'withdraw' | 'collect' | 'ignore' {
  const normalized = type.toUpperCase();
  if (
    normalized.includes('DEPOSIT') ||
    normalized.includes('INCREASE_LIQUIDITY') ||
    normalized === 'MINT'
  ) {
    return 'deposit';
  }
  if (
    normalized.includes('WITHDRAW') ||
    normalized.includes('DECREASE_LIQUIDITY') ||
    normalized === 'BURN'
  ) {
    return 'withdraw';
  }
  if (normalized.includes('COLLECT') || normalized.includes('CLAIM_FEES')) {
    return 'collect';
  }
  return 'ignore';
}

function toNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
