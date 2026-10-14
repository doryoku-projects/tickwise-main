/*
 * P3.2 sizing (pure): the per-chain allotment formula (design §8:
 * clamp(⌈1.25 × N × 60 s / target⌉, 2,000, slots × batch × 60 s / L)), the
 * slot sizing rule, and the BY_CHAIN parser.
 */
import { describe, expect, it } from 'vitest';
import {
  FEE_CHAIN_BUDGET_FLOOR,
  parseChainMap,
  perChainAllotment,
  suggestedSlots,
} from '../../src/sync/position-fee-rpc.js';

describe('perChainAllotment', () => {
  it('one big chain and three small ones: the big one gets what its pass needs, the small ones the floor', () => {
    const target = 480_000;
    // 4663 at 1.2M actives, 32 slots × 500 at 5 s a batch: capacity 192k/min, need 187.5k/min.
    expect(perChainAllotment({ active: 1_200_000, passTargetMs: target, slots: 32, batch: 500, latencyMs: 5_000 })).toBe(187_500);
    for (const active of [77_358, 22_529, 2_915]) {
      const n = perChainAllotment({ active, passTargetMs: target, slots: 12, batch: 400, latencyMs: 2_000 });
      expect(n).toBe(Math.max(FEE_CHAIN_BUDGET_FLOOR, Math.ceil((1.25 * active * 60_000) / target)));
    }
    expect(perChainAllotment({ active: 2_915, passTargetMs: target, slots: 12, batch: 400 })).toBe(FEE_CHAIN_BUDGET_FLOOR);
  });

  it('a latency spike caps it at what the slots can push through (capacity beats the floor)', () => {
    expect(perChainAllotment({ active: 1_200_000, passTargetMs: 480_000, slots: 32, batch: 500, latencyMs: 20_000 })).toBe(48_000);
    expect(perChainAllotment({ active: 100, passTargetMs: 480_000, slots: 1, batch: 200, latencyMs: 60_000 })).toBe(200);
  });

  it('unknown latency (no batch measured yet) is not a bound', () => {
    expect(perChainAllotment({ active: 1_200_000, passTargetMs: 480_000, slots: 1, batch: 1, latencyMs: 0 })).toBe(187_500);
  });

  it('exact at the boundary: 1.25 × N × 60 s / target, rounded UP', () => {
    expect(perChainAllotment({ active: 51_201, passTargetMs: 480_000, slots: 8, batch: 200 })).toBe(Math.ceil(51_201 * 1.25 / 8));
  });
});

describe('suggestedSlots', () => {
  it('⌈rate × L / batch × 1.5⌉', () => {
    // 2,500 pos/s at batch 500 taking 5 s: 25 in flight, × 1.5 = 38.
    expect(suggestedSlots(2_500, 5_000, 500)).toBe(38);
    expect(suggestedSlots(610, 2_700, 200)).toBe(13);
    expect(suggestedSlots(100, 0, 500)).toBe(0);
  });
});

describe('parseChainMap', () => {
  it('"1:400,4663:32" with clamping; garbage skipped; a Map passes through', () => {
    expect([...parseChainMap('1:400, 4663:32', 500)]).toEqual([
      [1, 400],
      [4663, 32],
    ]);
    expect([...parseChainMap('1:9000,x:3,2:-1,3:,4:5:6,5:2', 64)]).toEqual([
      [1, 64],
      [5, 2],
    ]);
    expect([...parseChainMap(new Map([[1, 3]]), 64)]).toEqual([[1, 3]]);
    expect(parseChainMap(undefined, 64).size).toBe(0);
    expect(parseChainMap('', 64).size).toBe(0);
  });
});
