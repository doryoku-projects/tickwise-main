import { describe, expect, it } from 'vitest';
import {
  compareNumericField,
  compareNumericString,
  valueAtPath,
} from '../src/common/shard-merge.js';

describe('shard-merge helpers (all-chains scatter-gather comparator)', () => {
  it('valueAtPath resolves dotted paths and tolerates missing segments', () => {
    const doc = { metrics: { aprExGas: 12.5 }, tokenId: '42' };
    expect(valueAtPath(doc, 'metrics.aprExGas')).toBe(12.5);
    expect(valueAtPath(doc, 'tokenId')).toBe('42');
    expect(valueAtPath(doc, 'metrics.missing')).toBeUndefined();
    expect(valueAtPath(doc, 'nothere.deeper')).toBeUndefined();
  });

  it('compareNumericField ranks missing/null/NaN below every number (BSON ordering)', () => {
    expect(compareNumericField(undefined, 0)).toBe(-1);
    expect(compareNumericField(null, -5)).toBe(-1);
    expect(compareNumericField(NaN, -Infinity)).toBe(-1);
    // A string sorts ABOVE every number in BSON order (it used to be coerced to NaN and ranked last).
    expect(compareNumericField('garbage', 1)).toBe(1);
    expect(compareNumericField(3, 2)).toBe(1);
    expect(compareNumericField(2, 2)).toBe(0);
    // descending sort (× -1) puts missing LAST — matches Mongo desc.
    const rows = [{ v: undefined }, { v: 10 }, { v: 3 }];
    rows.sort((a, b) => compareNumericField(a.v, b.v) * -1);
    expect(rows.map((r) => r.v)).toEqual([10, 3, undefined]);
  });

  it('compareNumericString orders digit strings by magnitude (numericOrdering collation)', () => {
    expect(compareNumericString('9', '10')).toBeLessThan(0); // lexicographic would say '9' > '10'
    expect(compareNumericString('100', '99')).toBeGreaterThan(0);
    expect(compareNumericString('42', '42')).toBe(0);
    // beyond 2^53 — length-then-lexicographic stays exact
    expect(compareNumericString('99999999999999999998', '99999999999999999999')).toBeLessThan(0);
    // non-digit strings fall back to lexicographic
    expect(compareNumericString('0xabc', '0xabd')).toBeLessThan(0);
  });

  it('merged shard pages preserve the single-shard order (desc metric, id tie-break)', () => {
    // Two shards, each pre-sorted desc by value like a Mongo shard response.
    const shardA = [
      { chainId: 1, positionId: '9', metrics: { v: 50 } },
      { chainId: 1, positionId: '10', metrics: { v: 20 } },
    ];
    const shardB = [
      { chainId: 43114, positionId: '3', metrics: { v: 30 } },
      { chainId: 43114, positionId: '9', metrics: { v: 20 } },
    ];
    const merged = [...shardA, ...shardB].sort((a, b) => {
      const primary = compareNumericField(valueAtPath(a, 'metrics.v'), valueAtPath(b, 'metrics.v')) * -1;
      if (primary !== 0) return primary;
      const tie = compareNumericString(a.positionId, b.positionId);
      if (tie !== 0) return tie;
      return a.chainId - b.chainId;
    });
    expect(merged.map((r) => `${r.chainId}:${r.positionId}`)).toEqual([
      '1:9', // v=50
      '43114:3', // v=30
      '43114:9', // v=20 tie → positionId 9 < 10 under numeric collation
      '1:10', // v=20
    ]);
  });
});
