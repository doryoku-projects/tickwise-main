import { describe, expect, it } from 'vitest';
import { DYNAMIC_FEE_FLAG, HONEYPOT_FEE_MIN_PIPS, honeypotFeeClause } from '../../src/database/positions.repository.js';
import { leafIndex, RANK_FEE_LEAF, RANK_LEAVES, rankFeeLeafEnabled, rankLeavesFor } from '../../src/read-models/core/fields.js';
import { RANK_LEAF, RANK_NUM_LEAVES } from '../../src/read-models/rank/rank-columns.js';
import { compileRankFilter } from '../../src/read-models/rank/rank-query.js';

/**
 * Review finding (read models, defaults parity): the `fee` rank leaf was
 * appended unconditionally, so the FLAG-OFF deploy changed the snapshot /
 * delta layout — every positions snapshot loaded `fee` as missing, raised
 * `read_models.field_backfill` and the holder rescanned every positions shard.
 * The leaf now follows `HONEYPOT_FEE_FILTER` (this file runs with it unset):
 * off is the 20-leaf layout the read models had before the valuation fixes.
 */

/** The rank layout as it stood before the valuation fixes (names in wire order). */
const TODAY = [
  'chainId', 'protocol', 'positionId', 'tokenId', 'owner', 'poolId', 'isActive', 'createdAt', 'token0', 'token1',
  'value', 'pnl', 'aprExGas', 'feeApr', 'roi', 'inRange', 'perfReady', 'poolTvl', 'source', 'usedFallback',
];

describe('rank model layout with HONEYPOT_FEE_FILTER unset (the default)', () => {
  it('is today\'s 20 leaves exactly, and 7 numeric columns', () => {
    expect(process.env.HONEYPOT_FEE_FILTER).toBeUndefined();
    expect(RANK_LEAVES.map((l) => l.name)).toEqual(TODAY);
    expect(leafIndex('rank', 'fee')).toBe(-1);
    expect(RANK_LEAF.fee).toBe(-1);
    expect(RANK_NUM_LEAVES).toEqual([RANK_LEAF.value, RANK_LEAF.pnl, RANK_LEAF.aprExGas, RANK_LEAF.feeApr, RANK_LEAF.roi, RANK_LEAF.createdAt, RANK_LEAF.poolTvl]);
  });

  it('with the flag on, the leaf is APPENDED (no earlier leaf moves)', () => {
    const on = rankLeavesFor(true);
    expect(on.map((l) => l.name)).toEqual([...TODAY, 'fee']);
    expect(on[on.length - 1]).toBe(RANK_FEE_LEAF);
    expect(RANK_FEE_LEAF).toMatchObject({ name: 'fee', path: 'fee', top: 'fee', kind: 'num' });
    expect(rankLeavesFor(false)).toBe(RANK_LEAVES);
  });

  it('reads the flag the way the config enum spells it', () => {
    for (const v of ['on', 'ON', ' on ']) expect(rankFeeLeafEnabled({ HONEYPOT_FEE_FILTER: v }), v).toBe(true);
    for (const v of [undefined, '', 'off', 'OFF', 'true', '1', 'onn']) expect(rankFeeLeafEnabled({ HONEYPOT_FEE_FILTER: v }), String(v)).toBe(false);
    expect(rankFeeLeafEnabled({})).toBe(false);
  });

  it('a honeypot clause without the leaf is unsupported (Mongo answers), never "no match"', () => {
    const filter = { chainId: 1, protocol: 'uniswap-v4', isActive: true, ...honeypotFeeClause() };
    for (const shape of ['ranked', 'pool'] as const) {
      const compiled = compileRankFilter(filter, 1, 'uniswap-v4', shape);
      expect(compiled.ok, shape).toBe(false);
      expect(compiled.ok ? '' : compiled.reason, shape).toBe('field:fee');
    }
    expect(HONEYPOT_FEE_MIN_PIPS).toBe(50_000);
    expect(DYNAMIC_FEE_FLAG).toBe(0x800000);
  });
});
