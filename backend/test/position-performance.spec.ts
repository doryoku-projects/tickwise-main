import { describe, expect, it } from 'vitest';
import type { Position } from '../src/database/schemas/position.schema.js';
import { computePerformanceUpdate } from '../src/positions/position-performance.js';
import type { NormalizedPositionTransaction } from '../src/subgraph/normalized-position.js';

const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;
const START = 1_741_638_311;

describe('position performance (historical-price cost-basis model)', () => {
  it('1-year hold, $10k deposit at $1/token, $1k pending fees, no IL → APR = 10%, feeApr = 10%', () => {
    const update = computePerformanceUpdate(
      position({
        token0Price: 1,
        token1Price: 1,
        metrics: {
          ...baseMetrics(),
          underlyingValueUsd: 10_000,
          pendingFeesUsd: 1_000,
          ageSeconds: SECONDS_PER_YEAR,
        },
      }),
      [depositTx('40', 5_000, 5_000, START)],
    );

    expect(update.metrics.performanceReady).toBe(true);
    expect(update.metrics.depositedUsd).toBeCloseTo(10_000, 6);
    expect(update.metrics.pnlUsd).toBeCloseTo(1_000, 6);
    expect(update.metrics.apr).toBeCloseTo(10, 6);
    expect(update.metrics.aprExGas).toBeCloseTo(10, 6);
    expect(update.metrics.feeApr).toBeCloseTo(10, 6);
    expect(update.metrics.roi).toBeCloseTo(10, 6);
  });

  it('6-month hold, $10k deposit, $500 fees, $500 IL gain → APR ≈ 20%', () => {
    const update = computePerformanceUpdate(
      position({
        token0Price: 1,
        token1Price: 1,
        metrics: {
          ...baseMetrics(),
          underlyingValueUsd: 10_500,
          pendingFeesUsd: 500,
          ageSeconds: SECONDS_PER_YEAR / 2,
        },
      }),
      [depositTx('40', 5_000, 5_000, START)],
    );

    expect(update.metrics.performanceReady).toBe(true);
    expect(update.metrics.pnlUsd).toBeCloseTo(1_000, 6);
    expect(update.metrics.apr).toBeCloseTo((1_000 / 10_000) * 2 * 100, 4);
    expect(update.metrics.aprExGas).toBeCloseTo((1_000 / 10_000) * 2 * 100, 4);
    expect(update.metrics.poolApr).toBeCloseTo(update.metrics.aprExGas ?? 0, 4);
    expect(update.metrics.feeApr).toBeCloseTo((500 / 10_000) * 2 * 100, 4);
  });

  it('gas reduces APR but not aprExGas or feeApr', () => {
    const update = computePerformanceUpdate(
      position({
        token0Price: 1,
        token1Price: 1,
        metrics: {
          ...baseMetrics(),
          underlyingValueUsd: 10_000,
          pendingFeesUsd: 1_000,
          ageSeconds: SECONDS_PER_YEAR,
        },
      }),
      [depositTx('40', 5_000, 5_000, START, 100)],
    );

    expect(update.metrics.totalGasCostUsd).toBeCloseTo(100, 6);
    expect(update.metrics.pnlUsd).toBeCloseTo(900, 6);
    expect(update.metrics.apr).toBeCloseTo(9, 6);
    expect(update.metrics.aprExGas).toBeCloseTo(10, 6);
    expect(update.metrics.feeApr).toBeCloseTo(10, 6);
  });

  it('multi-deposit + partial withdrawal at historical prices', () => {
    const update = computePerformanceUpdate(
      position({
        token0Price: 2,
        token1Price: 1,
        metrics: {
          ...baseMetrics(),
          underlyingValueUsd: 12_000,
          pendingFeesUsd: 0,
          ageSeconds: SECONDS_PER_YEAR,
        },
      }),
      [
        depositTx('40', 2_500, 5_000, START, 0, { price0: 2, price1: 1 }),
        depositTx('40', 2_500, 0, START + 1, 0, { price0: 2, price1: 1 }),
        withdrawTx('40', 0, 1_000, START + 2, { price0: 2, price1: 1 }),
        collectTx('40', 50, 100, START + 3, 0, { price0: 2, price1: 1 }),
      ],
    );

    expect(update.metrics.performanceReady).toBe(true);
    expect(update.metrics.depositedUsd).toBeCloseTo(2_500 * 2 + 5_000 + 2_500 * 2, 6);
    expect(update.metrics.withdrawnUsd).toBeCloseTo(1_000, 6);
    expect(update.metrics.collectedFeesUsd).toBeCloseTo(50 * 2 + 100, 6);
    const expectedPnl = 12_000 + 1_000 - (2_500 * 2 + 5_000 + 2_500 * 2) + (50 * 2 + 100);
    expect(update.metrics.pnlUsd).toBeCloseTo(expectedPnl, 6);
  });

  it('marks performance incomplete when historicalPricingSource is none and amounts are non-zero', () => {
    const noHistorical = depositTx('40', 10, 100, START);
    noHistorical.amount0HistoricalPriceUsd = 0;
    noHistorical.amount1HistoricalPriceUsd = 0;
    noHistorical.historicalPricingSource = 'none';

    const update = computePerformanceUpdate(
      position({
        token0Price: 1,
        token1Price: 1,
        metrics: {
          ...baseMetrics(),
          underlyingValueUsd: 1_000,
          ageSeconds: SECONDS_PER_YEAR,
        },
      }),
      [noHistorical],
    );

    expect(update.metrics.performanceReady).toBe(false);
    expect(update.metrics.pnlUsd).toBe(0);
    expect(update.metrics.apr).toBe(0);
  });

  it('incomplete-performance partial preserves current-state metrics by omitting them from the patch', () => {
    const noHistorical = depositTx('40', 10, 100, START);
    noHistorical.amount0HistoricalPriceUsd = 0;
    noHistorical.amount1HistoricalPriceUsd = 0;
    noHistorical.historicalPricingSource = 'none';

    const update = computePerformanceUpdate(
      position({
        token0Price: 1,
        token1Price: 1,
        metrics: {
          ...baseMetrics(),
          underlyingValueUsd: 1_234,
          pendingFeesUsd: 5,
          collectedFeesUsd: 7,
          inRange: true,
          isPriceable: true,
          ageSeconds: SECONDS_PER_YEAR,
        },
      }),
      [noHistorical],
    );

    // performanceReady stays false; cashflow-derived metrics get zeroed.
    expect(update.metrics.performanceReady).toBe(false);
    expect(update.metrics.pnlUsd).toBe(0);
    expect(update.metrics.apr).toBe(0);

    // Current-state metrics MUST NOT be present in the partial — the partial $set
    // would otherwise overwrite the adapter-populated values in mongo.
    expect(Object.prototype.hasOwnProperty.call(update.metrics, 'underlyingValueUsd')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(update.metrics, 'pendingFeesUsd')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(update.metrics, 'collectedFeesUsd')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(update.metrics, 'inRange')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(update.metrics, 'isPriceable')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(update.metrics, 'unclaimedRewardsUsd')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(update.metrics, 'claimedRewardsUsd')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(update.metrics, 'ageSeconds')).toBe(false);
  });

  it('marks performance incomplete when no deposits', () => {
    const update = computePerformanceUpdate(
      position({
        token0Price: 1,
        token1Price: 1,
        metrics: { ...baseMetrics(), underlyingValueUsd: 1_000 },
      }),
      [],
    );

    expect(update.metrics.performanceReady).toBe(false);
  });

  it('mirrors metrics into amounts string fields', () => {
    const update = computePerformanceUpdate(
      position({
        token0Price: 1,
        token1Price: 1,
        metrics: {
          ...baseMetrics(),
          underlyingValueUsd: 1_500,
          pendingFeesUsd: 100,
          ageSeconds: SECONDS_PER_YEAR,
        },
      }),
      [depositTx('40', 500, 500, START), collectTx('40', 25, 25, START + 1, 5)],
    );

    expect(update.amounts.depositedUsd).toBe('1000');
    expect(update.amounts.totalFeesCollectedUsd).toBe('50');
    expect(update.amounts.totalFeesUncollectedUsd).toBe('100');
    expect(update.amounts.totalGasCostUsd).toBe('5');
  });

  it('single-sided drift: deposit 4M token1 @ $1, current $0.9975, no swap → HODL divergence ≈ 0, vs-USD captures the price drop', () => {
    const update = computePerformanceUpdate(
      position({
        // Position never rebalanced — still holds 4M token1, now worth 0.9975 each.
        token0Price: 1,
        token1Price: 0.9975,
        metrics: {
          ...baseMetrics(),
          underlyingValueUsd: 4_000_000 * 0.9975,
          pendingFeesUsd: 148,
          ageSeconds: SECONDS_PER_YEAR / 365 / 2,
        },
      }),
      [depositTx('40', 0, 4_000_000, START, 0, { price0: 1, price1: 1 })],
    );

    expect(update.metrics.performanceReady).toBe(true);
    // vs-HODL: deposited re-valued at CURRENT price (the HODL benchmark) → 3,990,000.
    expect(update.metrics.depositedUsd).toBeCloseTo(4_000_000 * 0.9975, 4);
    // No token rebalance → holding the deposited tokens gives the same value → divergence ≈ 0.
    expect(update.metrics.divergenceLossUsd).toBeCloseTo(0, 4);
    // Pool PnL (HODL) is just the fees; price drop affects position and HODL equally.
    expect(update.metrics.poolPnlUsd).toBeCloseTo(148, 4);
    expect(update.metrics.pnlHodl).toBeCloseTo(148, 4);
    // vs-USD still books the −$10k mark-to-market drop (deposited at $1, now $0.9975) + fees.
    expect(update.metrics.pnlUsd).toBeCloseTo((4_000_000 * 0.9975 - 4_000_000) + 148, 4);
  });

  it('vs-HODL vs vs-USD on a 2× price move: held value neutral, USD value doubled', () => {
    // Deposit 100 token0 @ $1 (cost $100). token0 now $2, no swaps → still 100 token0 = $200.
    const update = computePerformanceUpdate(
      position({
        token0Price: 2,
        token1Price: 1,
        metrics: {
          ...baseMetrics(),
          underlyingValueUsd: 200,
          ageSeconds: SECONDS_PER_YEAR,
        },
      }),
      [depositTx('40', 100, 0, START, 0, { price0: 1, price1: 1 })],
    );

    expect(update.metrics.performanceReady).toBe(true);
    expect(update.metrics.depositedUsd).toBeCloseTo(200, 6); // deposited re-valued at current $2
    expect(update.metrics.divergenceLossUsd).toBeCloseTo(0, 6); // HODL-neutral (no rebalance)
    expect(update.metrics.pnlHodl).toBeCloseTo(0, 6);
    expect(update.metrics.pnlUsd).toBeCloseTo(100, 6); // vs-USD: $100 → $200
  });

  it('diffUsd equals divergence (not PnL) — regression for the old diffUsd=pnl bug', () => {
    const update = computePerformanceUpdate(
      position({
        token0Price: 1,
        token1Price: 1,
        metrics: {
          ...baseMetrics(),
          underlyingValueUsd: 1_100,
          pendingFeesUsd: 200,
          ageSeconds: SECONDS_PER_YEAR,
        },
      }),
      [depositTx('40', 1_000, 0, START)],
    );

    // divergence = 1100 − 1000 = 100 ; poolPnl = 100 + 200 fees = 300.
    expect(update.metrics.divergenceLossUsd).toBeCloseTo(100, 6);
    expect(update.metrics.diffUsd).toBeCloseTo(100, 6); // diffs, NOT pnl
    expect(update.metrics.poolPnlUsd).toBeCloseTo(300, 6);
    expect(update.amounts.diffUsd).toBe('100');
  });

  it('claimed + unclaimed staking rewards flow into pnlHodl, pnlUsd and APR', () => {
    const update = computePerformanceUpdate(
      position({
        token0Price: 1,
        token1Price: 1,
        metrics: {
          ...baseMetrics(),
          underlyingValueUsd: 1_000,
          unclaimedRewardsUsd: 30,
          claimedRewardsUsd: 20,
          ageSeconds: SECONDS_PER_YEAR,
        },
      }),
      [depositTx('40', 1_000, 0, START)],
    );

    // No IL, no fees → PnL is purely the $50 rewards.
    expect(update.metrics.pnlHodl).toBeCloseTo(50, 6);
    expect(update.metrics.pnlUsd).toBeCloseTo(50, 6);
    expect(update.metrics.apr).toBeCloseTo((50 / 1_000) * 100, 6);
    expect(update.metrics.unclaimedRewardsUsd).toBe(30);
    expect(update.metrics.claimedRewardsUsd).toBe(20);
  });

  it('missing current token price gates the position to pending-prices (cannot value HODL)', () => {
    const update = computePerformanceUpdate(
      position({
        token0Price: 0, // current price unavailable this tick
        token1Price: 1,
        metrics: {
          ...baseMetrics(),
          underlyingValueUsd: 1_000,
          ageSeconds: SECONDS_PER_YEAR,
        },
      }),
      [depositTx('40', 1_000, 0, START)],
    );

    expect(update.metrics.performanceReady).toBe(false);
    expect(update.metrics.performanceSource).toBe('pending-prices');
  });

  it('aggregates token amounts and re-values deposits at the current price', () => {
    // Two token0 deposits (600 + 400 = 1000 token0) @ historical $1; current price $3.
    const update = computePerformanceUpdate(
      position({
        token0Price: 3,
        token1Price: 1,
        metrics: {
          ...baseMetrics(),
          underlyingValueUsd: 3_000,
          ageSeconds: SECONDS_PER_YEAR,
        },
      }),
      [
        depositTx('40', 600, 0, START, 0, { price0: 1, price1: 1 }),
        depositTx('40', 400, 0, START + 1, 0, { price0: 1, price1: 1 }),
      ],
    );

    expect(update.amounts.depositedToken0).toBe('1000');
    expect(update.metrics.depositedUsd).toBeCloseTo(1_000 * 3, 6); // 1000 token0 × $3
    expect(update.metrics.investedUsd).toBeCloseTo(1_000 * 3, 6);
  });

  it('populates metrics.usd vs-USD companion: USD basis books the price move, HODL stays neutral', () => {
    // Deposit 100 token0 @ $1 (cost $100). token0 now $2, no swaps → still 100 token0 = $200.
    const update = computePerformanceUpdate(
      position({
        token0Price: 2,
        token1Price: 1,
        metrics: {
          ...baseMetrics(),
          underlyingValueUsd: 200,
          ageSeconds: SECONDS_PER_YEAR,
        },
      }),
      [depositTx('40', 100, 0, START, 0, { price0: 1, price1: 1 })],
    );

    // Top-level (vs-HODL) is neutral; the vs-USD companion books the +$100.
    expect(update.metrics.pnlHodl).toBeCloseTo(0, 6);
    expect(update.metrics.usd?.pnlUsd).toBeCloseTo(100, 6);
    expect(update.metrics.usd?.poolPnlUsd).toBeCloseTo(100, 6); // divergenceHist (200−100) + 0 fees
    expect(update.metrics.usd?.divergenceLossUsd).toBeCloseTo(100, 6);
    // USD ROI uses the cost basis ($100): 100/100 = 100%.
    expect(update.metrics.usd?.roi).toBeCloseTo(100, 6);
    expect(update.metrics.usd?.apr).toBeCloseTo(100, 6);
  });

  it('zeroes metrics.usd when performance is incomplete', () => {
    const noHistorical = depositTx('40', 10, 100, START);
    noHistorical.amount0HistoricalPriceUsd = 0;
    noHistorical.amount1HistoricalPriceUsd = 0;
    noHistorical.historicalPricingSource = 'none';
    const update = computePerformanceUpdate(
      position({
        token0Price: 1,
        token1Price: 1,
        metrics: { ...baseMetrics(), underlyingValueUsd: 1_000, ageSeconds: SECONDS_PER_YEAR },
      }),
      [noHistorical],
    );

    expect(update.metrics.performanceReady).toBe(false);
    expect(update.metrics.usd?.pnlUsd).toBe(0);
    expect(update.metrics.usd?.aprExGas).toBe(0);
  });

  it('gas at current ETH price for HODL when ctx.ethPriceNow is supplied', () => {
    const dep = depositTx('40', 1_000, 0, START);
    dep.gasCostEth = 0.01; // 0.01 ETH gas
    dep.gasCostUsd = 20; // tx-time USD
    const update = computePerformanceUpdate(
      position({
        token0Price: 1,
        token1Price: 1,
        metrics: { ...baseMetrics(), underlyingValueUsd: 1_000, ageSeconds: SECONDS_PER_YEAR },
      }),
      [dep],
      { ethPriceNow: 4_000 }, // 0.01 ETH × $4000 = $40 HODL gas
    );

    expect(update.metrics.totalGasCostUsd).toBeCloseTo(40, 6); // current-ETH gas
    expect(update.metrics.pnlHodl).toBeCloseTo(-40, 6); // no IL/fees → −gas
    expect(update.metrics.pnlUsd).toBeCloseTo(-20, 6); // vs-USD uses tx-price gas
  });

  it('poolPnlUsd equals fees + divergence (PnL excluding gas)', () => {
    const update = computePerformanceUpdate(
      position({
        token0Price: 1,
        token1Price: 1,
        metrics: {
          ...baseMetrics(),
          underlyingValueUsd: 10_500,
          pendingFeesUsd: 500,
          ageSeconds: SECONDS_PER_YEAR / 2,
        },
      }),
      [depositTx('40', 5_000, 5_000, START, 25)],
    );

    expect(update.metrics.poolPnlUsd).toBeCloseTo(1_000, 6);
    expect(update.metrics.poolPnlUsd).toBeCloseTo(
      (update.metrics.pnlUsd ?? 0) + (update.metrics.totalGasCostUsd ?? 0),
      6,
    );
  });

  it('zero-amount txn with historicalPricingSource=none does NOT mark unpriced', () => {
    const gasOnly = depositTx('40', 0, 0, START, 1);
    gasOnly.amount0HistoricalPriceUsd = 0;
    gasOnly.amount1HistoricalPriceUsd = 0;
    gasOnly.historicalPricingSource = 'none';

    const update = computePerformanceUpdate(
      position({
        token0Price: 1,
        token1Price: 1,
        metrics: {
          ...baseMetrics(),
          underlyingValueUsd: 5_000,
          pendingFeesUsd: 50,
          ageSeconds: SECONDS_PER_YEAR,
        },
      }),
      [depositTx('40', 5_000, 0, START - 1), gasOnly],
    );

    expect(update.metrics.performanceReady).toBe(true);
  });

  it('young position (age 2 min) flags aprWarmup and annualizes against 24h floor', () => {
    const update = computePerformanceUpdate(
      position({
        token0Price: 1,
        token1Price: 1,
        metrics: {
          ...baseMetrics(),
          underlyingValueUsd: 6_025,
          pendingFeesUsd: 0,
          ageSeconds: 120,
        },
      }),
      [depositTx('40', 6_025, 0, START, 0.39)],
    );

    expect(update.metrics.aprWarmup).toBe(true);
    // gas-only pnl of -$0.39 over $6,025 deposit, annualized against 1 day, not 2 min.
    const expectedApr = (-0.39 / 6_025) * 365 * 100;
    expect(update.metrics.apr).toBeCloseTo(expectedApr, 3);
    // ROI must be unaffected by the floor.
    expect(update.metrics.roi).toBeCloseTo((-0.39 / 6_025) * 100, 6);
  });

  it('history-incomplete gate: txSyncStatus pending blocks performanceReady (pending-history)', () => {
    const update = computePerformanceUpdate(
      position({
        token0Price: 1,
        token1Price: 1,
        metrics: {
          ...baseMetrics(),
          underlyingValueUsd: 10_000,
          pendingFeesUsd: 100,
          ageSeconds: SECONDS_PER_YEAR,
        },
        txSyncStatus: 'pending',
        txSyncedTransactionCount: 0,
      } as never),
      [depositTx('40', 5_000, 5_000, START)],
    );

    expect(update.metrics.performanceReady).toBe(false);
    expect(update.metrics.performanceSource).toBe('pending-history');
    expect(update.metrics.pnlUsd).toBe(0);
    expect(update.metrics.apr).toBe(0);
  });

  it('history-incomplete gate: closed position without txFinalizedAt blocks performanceReady', () => {
    const update = computePerformanceUpdate(
      position({
        token0Price: 1,
        token1Price: 1,
        metrics: {
          ...baseMetrics(),
          underlyingValueUsd: 10_000,
          pendingFeesUsd: 100,
          ageSeconds: SECONDS_PER_YEAR,
        },
        isActive: false,
        txSyncStatus: 'success',
        txSyncedTransactionCount: 3,
        // txFinalizedAt deliberately missing
      } as never),
      [depositTx('40', 5_000, 5_000, START)],
    );

    expect(update.metrics.performanceReady).toBe(false);
    expect(update.metrics.performanceSource).toBe('pending-history');
  });

  it('history-incomplete gate: closed position with txFinalizedAt clears the gate', () => {
    const update = computePerformanceUpdate(
      position({
        token0Price: 1,
        token1Price: 1,
        metrics: {
          ...baseMetrics(),
          underlyingValueUsd: 10_000,
          pendingFeesUsd: 100,
          ageSeconds: SECONDS_PER_YEAR,
        },
        isActive: false,
        txSyncStatus: 'success',
        txSyncedTransactionCount: 3,
        txFinalizedAt: new Date(),
      } as never),
      [depositTx('40', 5_000, 5_000, START)],
    );

    expect(update.metrics.performanceReady).toBe(true);
    expect(update.metrics.performanceSource).toBe('internal-cashflows');
  });

  it('pending-prices source surfaces when a cashflow tx is unpriced', () => {
    const noHistorical = depositTx('40', 10, 100, START);
    noHistorical.amount0HistoricalPriceUsd = 0;
    noHistorical.amount1HistoricalPriceUsd = 0;
    noHistorical.historicalPricingSource = 'none';
    const priced = depositTx('40', 50, 50, START + 1, 0, { price0: 1, price1: 1 });

    const update = computePerformanceUpdate(
      position({
        token0Price: 1,
        token1Price: 1,
        metrics: {
          ...baseMetrics(),
          underlyingValueUsd: 200,
          ageSeconds: SECONDS_PER_YEAR,
        },
      }),
      [priced, noHistorical],
    );

    expect(update.metrics.performanceReady).toBe(false);
    expect(update.metrics.performanceSource).toBe('pending-prices');
  });

  it('mature position (age 30 days) does not set aprWarmup and uses real age', () => {
    const days = 30 * 24 * 60 * 60;
    const update = computePerformanceUpdate(
      position({
        token0Price: 1,
        token1Price: 1,
        metrics: {
          ...baseMetrics(),
          underlyingValueUsd: 10_500,
          pendingFeesUsd: 500,
          ageSeconds: days,
        },
      }),
      [depositTx('40', 10_000, 0, START)],
    );

    expect(update.metrics.aprWarmup).toBe(false);
    expect(update.metrics.apr).toBeCloseTo((1_000 / 10_000) * (365 / 30) * 100, 4);
  });
});

interface TxPriceOpts {
  price0?: number;
  price1?: number;
}

function depositTx(
  positionId: string,
  amount0: number,
  amount1: number,
  timestamp: number,
  gasCostUsd = 0,
  prices: TxPriceOpts = {},
): NormalizedPositionTransaction {
  return tx({
    positionId,
    tokenId: positionId,
    transactionId: `${positionId}-DEPOSIT-${timestamp}`,
    txHash: `${positionId}-DEPOSIT-${timestamp}`,
    type: 'DEPOSIT',
    timestamp,
    amount0: String(amount0),
    amount1: String(amount1),
    gasCostUsd,
    amount0HistoricalPriceUsd: prices.price0 ?? 1,
    amount1HistoricalPriceUsd: prices.price1 ?? 1,
    historicalPricingSource: 'historical',
  });
}

function withdrawTx(
  positionId: string,
  amount0: number,
  amount1: number,
  timestamp: number,
  prices: TxPriceOpts = {},
): NormalizedPositionTransaction {
  return tx({
    positionId,
    tokenId: positionId,
    transactionId: `${positionId}-WITHDRAW-${timestamp}`,
    txHash: `${positionId}-WITHDRAW-${timestamp}`,
    type: 'WITHDRAW',
    timestamp,
    amount0: String(amount0),
    amount1: String(amount1),
    amount0HistoricalPriceUsd: prices.price0 ?? 1,
    amount1HistoricalPriceUsd: prices.price1 ?? 1,
    historicalPricingSource: 'historical',
  });
}

function collectTx(
  positionId: string,
  amount0: number,
  amount1: number,
  timestamp: number,
  gasCostUsd = 0,
  prices: TxPriceOpts = {},
): NormalizedPositionTransaction {
  return tx({
    positionId,
    tokenId: positionId,
    transactionId: `${positionId}-COLLECT_FEES-${timestamp}`,
    txHash: `${positionId}-COLLECT_FEES-${timestamp}`,
    type: 'COLLECT_FEES',
    timestamp,
    amount0: String(amount0),
    amount1: String(amount1),
    gasCostUsd,
    amount0HistoricalPriceUsd: prices.price0 ?? 1,
    amount1HistoricalPriceUsd: prices.price1 ?? 1,
    historicalPricingSource: 'historical',
  });
}

function tx(overrides: Partial<NormalizedPositionTransaction>): NormalizedPositionTransaction {
  return {
    chainId: 1,
    protocol: 'uniswap-v4',
    positionId: '40',
    tokenId: '40',
    transactionId: 'tx',
    txHash: '0xtx',
    type: 'DEPOSIT',
    timestamp: START,
    amount0: '0',
    amount1: '0',
    amount0PriceUsd: 0,
    amount1PriceUsd: 0,
    amount0PriceUsdUntracked: 0,
    amount1PriceUsdUntracked: 0,
    amount0HistoricalPriceUsd: 1,
    amount1HistoricalPriceUsd: 1,
    historicalValueUsd: 0,
    historicalPricingSource: 'historical',
    gasCostEth: 0,
    gasCostUsd: 0,
    sender: '0xsender',
    logIndex: 0,
    rawSubgraph: {},
    ...overrides,
  };
}

function position(
  overrides: { token0Price?: number; token1Price?: number; metrics?: Position['metrics'] } &
    Partial<Position> = {},
): Position {
  const { token0Price = 1, token1Price = 1, metrics, ...rest } = overrides;
  return {
    chainId: 1,
    protocol: 'uniswap-v4',
    positionId: '40',
    tokenId: '40',
    owner: '0xowner',
    poolId: '0xpool',
    token0: {
      address: '0xtoken0',
      symbol: 'TOKEN0',
      decimals: 18,
      verified: true,
      priceUsd: token0Price,
    },
    token1: {
      address: '0xtoken1',
      symbol: 'TOKEN1',
      decimals: 18,
      verified: true,
      priceUsd: token1Price,
    },
    fee: 3000,
    tickSpacing: 60,
    tickLower: -100,
    tickUpper: 100,
    currentTick: 0,
    sqrtPriceX96: '0',
    liquidity: '0',
    isActive: true,
    createdAtTimestamp: START,
    closedAtTimestamp: null,
    amounts: {
      amount0: '0',
      amount1: '0',
      depositedToken0: '0',
      depositedToken1: '0',
      depositedUsd: '0',
      withdrawnToken0: '0',
      withdrawnToken1: '0',
      withdrawnUsd: '0',
      totalFeesCollected0: '0',
      totalFeesCollected1: '0',
      totalFeesCollectedUsd: '0',
      totalFeesUncollected0: '0',
      totalFeesUncollected1: '0',
      totalFeesUncollectedUsd: '0',
      totalGasCostEth: '0',
      totalGasCostUsd: '0',
      diffToken0: '0',
      diffToken1: '0',
      diffUsd: '0',
    },
    metrics: metrics ?? baseMetrics(),
    poolStats: {
      tvlUsd: 0,
      tvlUsdUntracked: 0,
      volumeUsd: 0,
      totalFeesUsd: 0,
      priceDivergence: 0,
    },
    pricing: {
      source: 'none',
      usedFallback: false,
      pricedAt: new Date(0),
    },
    rawSubgraph: {},
    // Performance tests model fully synced positions; gate in
    // computePerformanceUpdate expects txSyncStatus='success' + a stored
    // count > 0 (and txFinalizedAt for closed positions).
    txSyncStatus: 'success',
    txSyncedTransactionCount: 1,
    ...rest,
  } as Position;
}

function baseMetrics(): Position['metrics'] {
  return {
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
    underlyingValueUsd: 0,
    pendingFeesUsd: 0,
    collectedFeesUsd: 0,
    totalFeesUsd: 0,
    totalGasCostUsd: 0,
    investedUsd: 0,
    depositedUsd: 0,
    withdrawnUsd: 0,
    diffUsd: 0,
    unclaimedRewardsUsd: 0,
    claimedRewardsUsd: 0,
    ageSeconds: 0,
    inRange: true,
    isPriceable: true,
    performanceReady: false,
    performanceSource: 'pending-transactions',
  };
}
