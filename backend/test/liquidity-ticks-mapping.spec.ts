import { describe, expect, it } from 'vitest';
import { mapLiquidityTicks, type TickRow } from '../src/charts/charts.service.js';

/**
 * Guards the two corrections in `mapLiquidityTicks`. Both were live bugs the
 * frontend had been papering over: the liquidity histogram plotted
 * `liquidityGross` (spikes at range edges, gaps between) and tick prices came
 * through undecimalised, so a USDT/USDS pair the rest of the panel priced at
 * 0.9999 showed up in the tooltip as 9.99e+11.
 */
const row = (tickIdx: number, net: string, gross = '0', price0 = '1'): TickRow => ({
  tickIdx: String(tickIdx),
  liquidityGross: gross,
  liquidityNet: net,
  price0,
  price1: String(1 / Number(price0)),
});

describe('mapLiquidityTicks', () => {
  const opts = { dec0: 18, dec1: 18, tickSpacing: 10 };

  it('accumulates liquidityNet into active liquidity across the range', () => {
    // One position spanning [0, 30): +100 entering, -100 leaving.
    const out = mapLiquidityTicks([row(0, '100'), row(30, '-100')], opts);
    expect(out.map((t) => t.activeLiquidity)).toEqual([100, 0]);
  });

  it('holds liquidity flat through a plateau of overlapping positions', () => {
    const out = mapLiquidityTicks(
      [row(0, '100'), row(10, '50'), row(20, '-50'), row(30, '-100')],
      opts,
    );
    // Rising, plateau, falling — the shape a depth chart is supposed to draw.
    expect(out.map((t) => t.activeLiquidity)).toEqual([100, 150, 100, 0]);
  });

  it('sorts ascending before summing, so payload order cannot corrupt the sum', () => {
    const out = mapLiquidityTicks([row(30, '-100'), row(0, '100')], opts);
    expect(out.map((t) => t.tickIdx)).toEqual([0, 30]);
    expect(out.map((t) => t.activeLiquidity)).toEqual([100, 0]);
  });

  it('clamps a negative running sum from a truncated tick window', () => {
    // `first: 1000` can cut off the opening tick, leaving a lone close.
    const out = mapLiquidityTicks([row(30, '-100')], opts);
    expect(out[0].activeLiquidity).toBe(0);
    expect(out[0].amount0).toBe(0);
    expect(out[0].amount1).toBe(0);
  });

  it('decimal-adjusts price0 and derives price1 as its exact reciprocal', () => {
    // 18/6 decimals: the raw ratio is 10^12 out — the "9.99e+11" tooltip bug.
    // tickIdx 0 => 1.0001^0 = 1, so the whole value here IS the decimal scale.
    const out = mapLiquidityTicks([row(0, '100', '0', '1')], { ...opts, dec0: 18, dec1: 6 });
    expect(out[0].price0).toBeCloseTo(1e12, 0);
    expect(out[0].price1).toBeCloseTo(1e-12, 24);
  });

  it('leaves an equal-decimal pair unscaled', () => {
    // 1.0001^78232 ~= 2500. The fixture's own price0 is deliberately a LIE
    // (99) to prove the mapper derives from tickIdx and ignores the column.
    const out = mapLiquidityTicks([row(78_232, '100', '0', '99')], opts);
    expect(out[0].price0).toBeCloseTo(2500, -1);
    // The contract is exact reciprocity, not a round number: 1.0001^78232 is
    // 2500.309…, so pinning 1/2500 would be asserting the fixture's arithmetic.
    expect(out[0].price1).toBe(1 / out[0].price0);
  });

  /*
   * The indexer stores price0/price1 as fixed-scale decimals with 18 fractional
   * digits, so 1.0001^tickIdx rounds to a literal 0 below tick -414,486 — both
   * ends of a full-range position, and 18-33% of all plotted ticks live. A zero
   * reaches the frontend as `fmtPrice(<= 0)` => "-", blanking the entire price
   * axis and every tooltip on that pool. Deriving the price locally has no such
   * cliff (a double reaches ~1e-308), so the row's zero must be IGNORED.
   */
  it('recovers a price the indexer rounded to zero at an extreme tick', () => {
    const out = mapLiquidityTicks([row(-885_000, '100', '0', '0')], opts);
    expect(out[0].price0).toBeGreaterThan(0);
    expect(out[0].price0).toBeCloseTo(3.688586534912304e-39, 45);
    // price1 is the reciprocal and must NOT collapse to the `price0 > 0 ? … : 0` branch.
    expect(out[0].price1).toBeCloseTo(2.7110655817209257e38, -30);
  });

  it('keeps the upper bound finite too, where price1 is what the indexer zeroes', () => {
    const out = mapLiquidityTicks([row(885_000, '100', '0', '0')], opts);
    expect(out[0].price0).toBeCloseTo(2.7110655817209257e38, -30);
    expect(out[0].price1).toBeGreaterThan(0);
  });

  it('derives locked amounts from ACTIVE liquidity, not gross', () => {
    // gross 0 with net 100: gross-based amounts would be 0, active-based are not.
    const out = mapLiquidityTicks([row(0, '100', '0')], opts);
    expect(out[0].liquidityGross).toBe('0');
    expect(out[0].amount0 + out[0].amount1).toBeGreaterThan(0);
  });

  it('survives a malformed liquidityNet rather than dropping the distribution', () => {
    const out = mapLiquidityTicks([row(0, 'not-a-number'), row(10, '100')], opts);
    expect(out).toHaveLength(2);
    expect(out[0].activeLiquidity).toBe(0);
    expect(out[1].activeLiquidity).toBe(100);
  });

  it('preserves liquidityNet on the payload for API consumers', () => {
    const out = mapLiquidityTicks([row(0, '-42')], opts);
    expect(out[0].liquidityNet).toBe('-42');
  });
});
