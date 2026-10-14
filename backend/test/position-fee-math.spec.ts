import { describe, expect, it } from 'vitest';
import {
  FEE_WRITE_MIN_RATIO,
  FEE_WRITE_MIN_USD,
  chooseUncollected,
  isMaterialFeeChange,
  isMaterialTokenChange,
  needsServedWrite,
  owedFeesRaw,
  pendingFeesUsd,
  positionSalt,
  revalueServedFees,
  type FeeServedState,
} from '../src/sync/position-fee-math.js';
import { computePerformanceFromAggregates } from '../src/positions/position-performance.js';
import type { Position } from '../src/database/schemas/position.schema.js';

const Q128 = 1n << 128n;
const MAX_UINT256 = (1n << 256n) - 1n;

describe('owedFeesRaw', () => {
  it('is fee growth times liquidity over 2^128', () => {
    expect(owedFeesRaw(3n * Q128, Q128, 5n)).toBe(10n);
  });

  // v4 subtracts in an unchecked block. The indexer's calculateUncollectedFees
  // clamps this case to 0, which zeroes real fees — the defect this code avoids.
  it('wraps a negative fee-growth difference mod 2^256 instead of clamping it to 0', () => {
    // last checkpoint just below the wrap, current value just past it: real growth = 2 * 2^128
    const last = MAX_UINT256 - Q128 + 1n;
    const inside = Q128;
    expect(owedFeesRaw(inside, last, 1n)).toBe(2n);
    expect(owedFeesRaw(inside, last, 1n)).not.toBe(0n);
  });

  it('owes nothing when liquidity is zero', () => {
    expect(owedFeesRaw(10n * Q128, 0n, 0n)).toBe(0n);
  });

  it('owes nothing when no fee has grown since the checkpoint', () => {
    expect(owedFeesRaw(7n * Q128, 7n * Q128, 1_000_000n)).toBe(0n);
  });
});

describe('positionSalt', () => {
  it('left-pads the tokenId to bytes32', () => {
    expect(positionSalt('255')).toBe(`0x${'0'.repeat(62)}ff`);
    expect(positionSalt(1n)).toHaveLength(66);
  });

  it('rejects a negative tokenId', () => {
    expect(() => positionSalt(-1n)).toThrow(RangeError);
  });
});

describe('chooseUncollected', () => {
  const at = new Date('2026-10-01T10:00:00Z');
  // A position minted (its last modify) at block 100. The indexer carries no
  // uncollected-fee figure any more, so the only inputs are the settle block, the
  // emptied flag and the on-chain reading.
  const position = { lastModifyBlock: 100 };

  it('serves the on-chain figure, labelled onchain with its time, when it post-dates the last modify', () => {
    expect(chooseUncollected(position, { fees0: 1.5, fees1: 2, block: 200, at })).toEqual({
      fees0: 1.5,
      fees1: 2,
      source: 'onchain',
      measuredAt: at,
    });
  });

  it('accepts a measurement taken in the very block of the last modify (state AFTER that block)', () => {
    expect(chooseUncollected(position, { fees0: 0.1, fees1: 0, block: 100, at }).source).toBe('onchain');
    // …and refuses one block earlier: it may describe fees that modify paid out.
    expect(chooseUncollected(position, { fees0: 0.1, fees1: 0, block: 99, at }).source).toBe('unmeasured');
  });

  // THE TRANSFER CASE. An NFT Transfer bumps `updatedAtBlock` but settles no
  // fees, and the indexer writes `lastModifyBlock` from the modify handler
  // only. Keyed on `updatedAtBlock` (the old rule), this position served 0
  // forever: its idle fees never changed, so the job never rewrote the
  // measurement and its block stayed below the Transfer.
  it('keeps the on-chain figure after a Transfer: updatedAtBlock moved, lastModifyBlock did not', () => {
    const afterTransfer = { ...position, updatedAtBlock: 300 };
    const chosen = chooseUncollected(afterTransfer, { fees0: 9, fees1: 9, block: 200, at });
    expect(chosen).toEqual({ fees0: 9, fees1: 9, source: 'onchain', measuredAt: at });
  });

  it('falls back to 0 when a modify settled the fees after the measurement, and calls it unmeasured', () => {
    // a modifyLiquidity at block 300 settled the fees the block-200 read saw
    const modified = { ...position, lastModifyBlock: 300 };
    expect(chooseUncollected(modified, { fees0: 9, fees1: 9, block: 200, at })).toEqual({
      fees0: 0,
      fees1: 0,
      source: 'unmeasured',
      measuredAt: null,
    });
  });

  // The indexer used to supply a figure here (its fee sweep) and was labelled
  // `indexer`. That source is gone: with no reading there is nothing to serve but
  // the placeholder 0, and `indexer` must never come back out of this function.
  it('serves 0 as unmeasured when there is no reading at all — and never labels anything `indexer`', () => {
    expect(chooseUncollected(position, undefined)).toEqual({ fees0: 0, fees1: 0, source: 'unmeasured', measuredAt: null });
    // …even when the last modify is unknown (0): an absent reading is not a measurement.
    expect(chooseUncollected({ lastModifyBlock: 0 }, undefined).source).toBe('unmeasured');
    const sources = new Set<string>();
    for (const lastModifyBlock of [0, 100, Number.NaN])
      for (const settled of [undefined, false, true])
        for (const rpc of [undefined, { fees0: 1, fees1: 1, block: 50 }, { fees0: 1, fees1: 1, block: 500, at }, { fees0: Number.NaN, fees1: 1, block: 500 }])
          sources.add(chooseUncollected({ lastModifyBlock, settled }, rpc).source);
    expect(sources.has('indexer')).toBe(false);
    expect([...sources].sort()).toEqual(['onchain', 'settled', 'unmeasured']);
  });

  it('ignores a non-finite measurement', () => {
    expect(chooseUncollected(position, { fees0: Number.NaN, fees1: 1, block: 200 }).source).toBe('unmeasured');
    expect(chooseUncollected(position, { fees0: 1, fees1: Number.POSITIVE_INFINITY, block: 200 }).source).toBe('unmeasured');
    expect(chooseUncollected(position, { fees0: 1, fees1: 1, block: Number.NaN }).source).toBe('unmeasured');
    // an infinite block would satisfy `>=` against any settle block: refused on its own
    expect(chooseUncollected(position, { fees0: 1, fees1: 1, block: Number.POSITIVE_INFINITY }).source).toBe('unmeasured');
    // the refused reading's own numbers are never served
    expect(chooseUncollected(position, { fees0: Number.NaN, fees1: 1, block: 200 })).toMatchObject({ fees0: 0, fees1: 0 });
  });

  it('an emptied position (no liquidity) is settled at exactly 0, whatever the reading says', () => {
    const closed = { lastModifyBlock: 100, settled: true };
    expect(chooseUncollected(closed, { fees0: 9, fees1: 9, block: 200, at })).toEqual({
      fees0: 0,
      fees1: 0,
      source: 'settled',
      measuredAt: null,
    });
    expect(chooseUncollected(closed, undefined).source).toBe('settled');
    // `settled: false` is an ordinary open position: no reading → unmeasured, not settled.
    expect(chooseUncollected({ ...closed, settled: false }, undefined).source).toBe('unmeasured');
  });

  it('treats an unknown lastModifyBlock as 0, and a measurement without a time as measuredAt null', () => {
    expect(chooseUncollected({ lastModifyBlock: Number.NaN }, { fees0: 1, fees1: 1, block: 1 })).toEqual({
      fees0: 1,
      fees1: 1,
      source: 'onchain',
      measuredAt: null,
    });
  });
});

describe('isMaterialFeeChange — max($0.25, 1%)', () => {
  it('pins the constants', () => {
    expect(FEE_WRITE_MIN_USD).toBe(0.25);
    expect(FEE_WRITE_MIN_RATIO).toBe(0.01);
  });

  it('uses the $0.25 floor on small figures', () => {
    expect(isMaterialFeeChange(1, 1.24)).toBe(false);
    expect(isMaterialFeeChange(1, 1.25)).toBe(true);
    expect(isMaterialFeeChange(0, 0.25)).toBe(true);
    expect(isMaterialFeeChange(0.3, 0.05)).toBe(true);
  });

  it('uses 1% of the larger figure once that is above the floor', () => {
    expect(isMaterialFeeChange(1000, 1009)).toBe(false);
    // 1% of the LARGER figure: 10.101 > a 10.1 move, 10.11 < an 11 move
    expect(isMaterialFeeChange(1000, 1010.1)).toBe(false);
    expect(isMaterialFeeChange(1000, 1011)).toBe(true);
    expect(isMaterialFeeChange(1011, 1000)).toBe(true);
  });

  it('treats non-finite stored values as 0', () => {
    expect(isMaterialFeeChange(Number.NaN, 0.1)).toBe(false);
    expect(isMaterialFeeChange(Number.NaN, 5)).toBe(true);
  });
});

describe('pendingFeesUsd', () => {
  it('is fees x the stored gated leg prices', () => {
    expect(pendingFeesUsd(2, 3, 10, 0.5, true)).toBe(21.5);
  });

  it('is 0 for a position the valuation guard rejected, as normalize serves it', () => {
    expect(pendingFeesUsd(2, 3, 10, 0.5, false)).toBe(0);
  });
});

/** A performance-ready aggregates position: $4k deposited, 30 days old, gas paid. */
function stored(over: { metrics?: Partial<Position['metrics']>; amounts?: Partial<Position['amounts']> } = {}): FeeServedState {
  const base: FeeServedState = {
    positionId: '3468131',
    isActive: true,
    token0: { priceUsd: 1 },
    token1: { priceUsd: 2 },
    amounts: {
      amount0: '1000',
      amount1: '500',
      depositedToken0: '2000',
      depositedToken1: '1000',
      withdrawnToken0: '0',
      withdrawnToken1: '0',
      totalFeesCollected0: '10',
      totalFeesCollected1: '5',
      totalFeesUncollected0: '0',
      totalFeesUncollected1: '0',
      totalGasCostEth: '0.01',
    },
    metrics: {
      isPriceable: true,
      underlyingValueUsd: 2000,
      pendingFeesUsd: 0,
      collectedFeesUsd: 20,
      totalFeesUsd: 20,
      totalGasCostUsd: 25, // 0.01 ETH at $2,500 — the last recompute's ETH price
      ageSeconds: 30 * 86_400,
      unclaimedRewardsUsd: 0,
      claimedRewardsUsd: 0,
      feesSource: 'unmeasured',
      performanceReady: true,
    },
  };
  return {
    ...base,
    amounts: { ...base.amounts, ...over.amounts },
    metrics: { ...base.metrics, ...over.metrics },
  };
}

describe('needsServedWrite', () => {
  it('always rewrites a figure that is not on-chain yet, even when the reading is 0 (Pending must clear)', () => {
    expect(needsServedWrite(stored({ metrics: { feesSource: 'unmeasured' } }), 0, 0)).toBe(true);
    expect(needsServedWrite(stored({ metrics: { feesSource: 'indexer' } }), 0, 0)).toBe(true);
    expect(needsServedWrite(stored({ metrics: { feesSource: undefined } }), 0, 0)).toBe(true);
  });

  it('skips an immaterial move of an on-chain figure', () => {
    // stored $10; new 10.1 x $1 + 0 x $2 = $10.10, under the $0.25 floor
    expect(needsServedWrite(stored({ metrics: { feesSource: 'onchain', pendingFeesUsd: 10 } }), 10.1, 0)).toBe(false);
  });

  it('rewrites a material move of an on-chain figure, valued at the stored leg prices', () => {
    // stored $10; new 10 x $1 + 0.2 x $2 = $10.40
    expect(needsServedWrite(stored({ metrics: { feesSource: 'onchain', pendingFeesUsd: 10 } }), 10, 0.2)).toBe(true);
  });

  // Avalanche position 10045 (AVAX/HOOK, HOOK unpriced): served 0 HOOK while the
  // chain owed 2,361.26 HOOK — a $0 move, so the USD gate never rewrote it.
  it('rewrites an unpriced leg that moved in token units, which the USD test cannot see', () => {
    const s = stored({
      metrics: { feesSource: 'onchain', pendingFeesUsd: 0, isPriceable: false },
      amounts: { totalFeesUncollected0: '0', totalFeesUncollected1: '0' },
    });
    expect(needsServedWrite(s, 0, 2361.264893536450429522)).toBe(true);
  });

  it('tests a $0-priced leg of a priceable position in token units, and only that leg', () => {
    const s = stored({
      metrics: { feesSource: 'onchain', pendingFeesUsd: 1 },
      amounts: { totalFeesUncollected0: '1', totalFeesUncollected1: '500' },
    });
    s.token1 = { priceUsd: 0 };
    expect(needsServedWrite(s, 1, 510)).toBe(true); // +2% of an unpriced leg
    expect(needsServedWrite(s, 1, 502)).toBe(false); // +0.4%: dust, like the USD floor
    expect(needsServedWrite(s, 1.1, 500)).toBe(false); // priced leg: $0.10 move stays under $0.25
  });

  it('still skips an unpriced leg that did not move', () => {
    const s = stored({
      metrics: { feesSource: 'onchain', pendingFeesUsd: 0, isPriceable: false },
      amounts: { totalFeesUncollected0: '3', totalFeesUncollected1: '2361.264893536450429522' },
    });
    expect(needsServedWrite(s, 3, 2361.264893536450429522)).toBe(false);
  });

  it('compares a RAM-store candidate (no served amounts) with its previous on-chain reading', () => {
    const s = stored({ metrics: { feesSource: 'onchain', pendingFeesUsd: 0, isPriceable: false } });
    s.amounts = {};
    expect(needsServedWrite(s, 0, 2361.26, { fees0: '0', fees1: '0' })).toBe(true);
    expect(needsServedWrite(s, 0, 2361.26, { fees0: '0', fees1: '2361.26' })).toBe(false);
    expect(needsServedWrite(s, 0, 2361.26)).toBe(false); // nothing to compare with
  });
});

describe('isMaterialTokenChange', () => {
  it('is a 1% move of the larger amount, and any move off or onto 0', () => {
    expect(isMaterialTokenChange(0, 1e-18)).toBe(true);
    expect(isMaterialTokenChange(5, 0)).toBe(true);
    expect(isMaterialTokenChange(100, 102)).toBe(true);
    expect(isMaterialTokenChange(100, 101)).toBe(false); // 1 < 1% of 101
    expect(isMaterialTokenChange(100, 100.5)).toBe(false);
    expect(isMaterialTokenChange(7, 7)).toBe(false);
    expect(isMaterialTokenChange(Number.NaN, 0)).toBe(false);
  });
});

describe('revalueServedFees — served fields from a fresh measurement', () => {
  const measuredAt = new Date('2026-10-01T10:00:00Z');
  const CASH_FLOW_INPUTS = [
    'depositedToken0',
    'depositedToken1',
    'withdrawnToken0',
    'withdrawnToken1',
    'totalFeesCollected0',
    'totalFeesCollected1',
    'totalGasCostEth',
  ];

  it('writes the uncollected amounts, pending fees, the label and measurement time', () => {
    const set = revalueServedFees(stored(), { fees0: 4, fees1: 3, measuredAt });
    expect(set['amounts.totalFeesUncollected0']).toBe('4');
    expect(set['amounts.totalFeesUncollected1']).toBe('3');
    expect(set['metrics.pendingFeesUsd']).toBe(10); // 4 x $1 + 3 x $2
    expect(set['amounts.totalFeesUncollectedUsd']).toBe('10');
    expect(set['metrics.feesSource']).toBe('onchain');
    expect(set['metrics.feesMeasuredAt']).toBe(measuredAt);
  });

  it('recomputes the aggregate performance exactly as the recompute would, gas at the stored ETH price', () => {
    const s = stored();
    const set = revalueServedFees(s, { fees0: 4, fees1: 3, measuredAt });
    const expected = computePerformanceFromAggregates(
      { ...s, metrics: { ...s.metrics, pendingFeesUsd: 10 } } as unknown as Position,
      { ethPriceNow: 2500 },
    );
    for (const [key, value] of Object.entries(expected.metrics)) expect(set[`metrics.${key}`], key).toEqual(value);
    for (const [key, value] of Object.entries(expected.amounts)) {
      if (CASH_FLOW_INPUTS.includes(key)) continue; // never written back (next case)
      expect(set[`amounts.${key}`], key).toEqual(value);
    }
    // totalFeesUsd = collected (current price) + pending, and feeApr moved with it.
    expect(set['metrics.totalFeesUsd']).toBe(30);
    expect(set['metrics.totalGasCostUsd']).toBe(25);
    const before = computePerformanceFromAggregates(s as unknown as Position, { ethPriceNow: 2500 });
    expect(set['metrics.feeApr'] as number).toBeGreaterThan(before.metrics.feeApr as number);
  });

  it('never re-$sets the token-unit cash flows it read — only the indexer writes those', () => {
    // The recompute echoes these inputs; writing the snapshot's copies back
    // would revert a normalize that landed between the read and the write.
    const set = revalueServedFees(stored(), { fees0: 4, fees1: 3, measuredAt });
    for (const key of CASH_FLOW_INPUTS) expect(set, key).not.toHaveProperty(`amounts.${key}`);
    // …while what IS derived from them at current prices still moves.
    expect(set).toHaveProperty('amounts.totalFeesCollectedUsd');
    expect(set).toHaveProperty('metrics.poolPnlUsd');
  });

  it('serves 0 pending for a rejected valuation and leaves performance as invalid-valuation', () => {
    const set = revalueServedFees(stored({ metrics: { isPriceable: false } }), { fees0: 4, fees1: 3, measuredAt });
    expect(set['metrics.pendingFeesUsd']).toBe(0);
    expect(set['amounts.totalFeesUncollected0']).toBe('4');
    expect(set['metrics.performanceSource']).toBe('invalid-valuation');
  });

  it('does not recompute APR with gas at $0 when the stored ETH price is unknown — moves totalFeesUsd by the delta', () => {
    const s = stored({ metrics: { totalGasCostUsd: 0, pendingFeesUsd: 2, totalFeesUsd: 22, apr: 7 } });
    const set = revalueServedFees(s, { fees0: 4, fees1: 3, measuredAt });
    expect(set['metrics.totalFeesUsd']).toBe(30); // 22 − 2 + 10
    expect(set).not.toHaveProperty('metrics.apr');
    expect(set).not.toHaveProperty('metrics.feeApr');
  });

  it('recomputes with no gas term when the position paid no gas', () => {
    const s = stored({ amounts: { totalGasCostEth: '0' }, metrics: { totalGasCostUsd: 0 } });
    const set = revalueServedFees(s, { fees0: 4, fees1: 3, measuredAt });
    expect(set).toHaveProperty('metrics.apr');
    expect(set['metrics.totalGasCostUsd']).toBe(0);
  });
});
