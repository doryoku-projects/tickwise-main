import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { PositionsRepository, type LeaderboardQuery } from '../../src/database/positions.repository.js';
import { PositionSchema } from '../../src/database/schemas/position.schema.js';
import { CkeyIndex } from '../../src/read-models/core/ckey.js';
import { Dictionary } from '../../src/read-models/core/dictionary.js';
import { ShardListFlags } from '../../src/read-models/pools/pool-query.js';
import { RANK_LEAF } from '../../src/read-models/rank/rank-columns.js';
import { bindRankQuery, ClassListFlags, compileRankFilter, impliesAplus, RANK_EXCLUSION_PLACEHOLDER } from '../../src/read-models/rank/rank-query.js';
import { SORTS } from './rank-support.js';

/**
 * Compile, never re-derive (design §4.9): EVERY filter `buildLeaderboardFilter`
 * emits over the full matrix, CAST through the real `PositionSchema` (what
 * MongoDB receives — dev's `$gte: '500'` strings become numbers), compiles
 * for its shape; a rate sort's ranked filter implies A+; the cast of the real
 * exclusion list is the list itself; anything outside the grammar is
 * UNSUPPORTED with a reason, never a silent different answer.
 */

const Model = mongoose.models.RankQuerySpec ?? mongoose.model('RankQuerySpec', PositionSchema, '1_uniswap_v4_positions');
const EXCLUDED = ['0xabc', '0x00a1ffff', '0xDEF'];

function repo(excluded: string[] = EXCLUDED) {
  return new PositionsRepository(
    { positionModel: () => Model } as never,
    { readyLeaderboardExclusions: async () => ({ addresses: excluded, ok: true }) } as never,
  );
}

const STATUSES = [undefined, 'active', 'inactive', 'all'] as const;
const RANGES = [undefined, 'in', 'out', 'all'];
const VALUE_FLOORS: unknown[] = [0, 0.5, 500, 1_000, 10_000, 123.45, '500'];
const TVL_FLOORS: unknown[] = [0, 1_000, 777];
const SHAPES: Array<Partial<LeaderboardQuery>> = [
  {},
  { owner: '0xAbCdef0000000000000000000000000000000001' },
  { owner: '0xabc', poolId: '0xPOOL' },
  { poolId: '0x00A1cccc' },
  { positionId: '123' },
  { positionId: '007', owner: '0xabc', poolId: '0xdef' },
];

describe('rank query compiler', () => {
  it('compiles every cast filter of the full matrix, with A+ on every ranked rate sort', async () => {
    const r = repo();
    let compiled = 0;
    for (const sort of SORTS)
      for (const status of STATUSES)
        for (const activeOnly of [true, false])
          for (const range of RANGES)
            for (const minValueUsd of VALUE_FLOORS)
              for (const minPoolTvl of TVL_FLOORS)
                for (const includeRisky of [true, false])
                  for (const assetClass of [undefined, 'equity'] as const)
                    for (const shape of SHAPES) {
                      const query = { chainId: 4663, protocol: 'uniswap-v4', sort, page: 1, limit: 20, status, activeOnly, range, minValueUsd, minPoolTvl, includeRisky, assetClass, ...shape } as LeaderboardQuery;
                      const plan = await r.leaderboardPlan(query);
                      const cast = r.castFilter(4663, 'uniswap-v4', plan.shapeFilter);
                      const result = compileRankFilter(cast, 4663, 'uniswap-v4', plan.shape);
                      expect(result.ok, `${JSON.stringify(query)} → ${result.ok ? '' : result.reason}`).toBe(true);
                      if (!result.ok) continue;
                      compiled++;
                      const rate = ['apr', 'fee_apr', 'roi'].includes(sort) && status !== 'inactive';
                      if (rate && plan.shape !== 'lookup') expect(result.plan.aplus, JSON.stringify(query)).toBe(true);
                      if (plan.shape !== 'ranked') expect(result.plan.scopeLiteral, JSON.stringify(query)).toBeDefined();
                      expect(result.plan.collated).toBe(plan.collated);
                      expect(result.plan.placeholder).toBe(plan.shape !== 'lookup');
                    }
    expect(compiled).toBe(SORTS.length * 4 * 2 * 4 * VALUE_FLOORS.length * 3 * 2 * 2 * SHAPES.length);
  }, 120_000);

  it('the cast of the real exclusion list is the list itself (String paths cast strings to themselves)', async () => {
    const r = repo();
    const plan = await r.leaderboardPlan({ chainId: 1, protocol: 'uniswap-v4', sort: 'pnl', page: 1, limit: 20, activeOnly: false, status: 'all', minValueUsd: 0, minPoolTvl: 0, includeRisky: true });
    expect(plan.excluded).toBe(EXCLUDED);
    const cast = r.castFilter(1, 'uniswap-v4', plan.filter);
    const result = compileRankFilter(cast, 1, 'uniswap-v4', plan.shape);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lists = result.plan.clauses.flat().filter((a) => a.k === 'in');
    expect(lists).toHaveLength(2);
    for (const atom of lists) expect(atom.k === 'in' && atom.values).toEqual(EXCLUDED);
    const shape = compileRankFilter(r.castFilter(1, 'uniswap-v4', plan.shapeFilter), 1, 'uniswap-v4', plan.shape);
    expect(shape.ok && shape.plan.clauses.flat().filter((a) => a.k === 'in').every((a) => a.k === 'in' && a.values.length === 1 && a.values[0] === RANK_EXCLUSION_PLACEHOLDER)).toBe(true);
  });

  it('refuses what is outside the grammar, with a reason', () => {
    const base = { chainId: 1, protocol: 'uniswap-v4' };
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...base, 'metrics.someOther': 5 }, 'field:'],
      [{ ...base, closedAtTimestamp: { $gt: 5 } }, 'field:'],
      [{ ...base, isActive: { $exists: true } }, 'op:$exists'],
      [{ ...base, $nor: [{ isActive: true }] }, 'operator:$nor'],
      [{ ...base, owner: /abc/i }, 'regex:'],
      [{ ...base, positionId: { $in: ['1'] } }, 'in_kind:'],
      [{ ...base, chainId: 2 }, 'identity_literal:'],
      [{ ...base, 'metrics.underlyingValueUsd': { $gte: NaN } }, 'range_literal:'],
    ];
    for (const [filter, reason] of cases) {
      const result = compileRankFilter(filter, 1, 'uniswap-v4', 'ranked');
      expect(result.ok, JSON.stringify(filter)).toBe(false);
      if (!result.ok) expect(result.reason.startsWith(reason), `${result.reason} vs ${reason}`).toBe(true);
    }
    // positionId equality in a collated shape (it never happens: lookups are uncollated).
    const collatedPid = compileRankFilter({ ...base, owner: 'x', positionId: '1' }, 1, 'uniswap-v4', 'owner');
    expect(collatedPid.ok).toBe(false);
  });

  it('knows when a filter implies A+', () => {
    const atoms = (filter: Record<string, unknown>) => {
      const r = compileRankFilter({ chainId: 1, protocol: 'p', ...filter }, 1, 'p', 'ranked');
      if (!r.ok) throw new Error(r.reason);
      return r.plan.clauses;
    };
    expect(impliesAplus(atoms({ isActive: true, 'metrics.underlyingValueUsd': { $gt: 0 } }))).toBe(true);
    expect(impliesAplus(atoms({ isActive: true, 'metrics.underlyingValueUsd': { $gte: 500, $gt: 0 } }))).toBe(true);
    expect(impliesAplus(atoms({ isActive: true, 'metrics.underlyingValueUsd': { $gte: 0 } }))).toBe(false);
    expect(impliesAplus(atoms({ isActive: false, 'metrics.underlyingValueUsd': { $gt: 0 } }))).toBe(false);
    expect(impliesAplus(atoms({ 'metrics.underlyingValueUsd': { $gt: 0 } }))).toBe(false);
    expect(impliesAplus(atoms({ $or: [{ isActive: true }, { isActive: false }], 'metrics.underlyingValueUsd': { $gt: 0 } }))).toBe(false);
  });

  it('binds collated literals through classes, refuses literals outside the domain, binds binary literals through ids', () => {
    const dict = new Dictionary();
    for (const s of ['0x00a1', 'none', '0x0a01', 'NONE']) dict.intern(s);
    const ckeys = new CkeyIndex();
    ckeys.extend(dict.sharedView());
    const target = { dict, dictSize: dict.size, ckeys, lists: new ShardListFlags(), classLists: new ClassListFlags() };
    const compile = (filter: Record<string, unknown>, shape: 'ranked' | 'owner' | 'pool') => {
      const r = compileRankFilter({ chainId: 1, protocol: 'p', ...filter }, 1, 'p', shape);
      if (!r.ok) throw new Error(r.reason);
      return r.plan;
    };
    const owner = bindRankQuery(compile({ owner: '0x000a1' }, 'owner'), target, []);
    expect(owner.ok && owner.scope).toEqual({ kind: 'owner', key: ckeys.classOfId(0) });
    expect(owner.ok && owner.query.clauses.flat().some((a) => a.k === 'clsEq')).toBe(true);
    const outside = bindRankQuery(compile({ owner: 'no\u0001ne' }, 'owner'), target, []);
    expect(outside).toEqual({ ok: false, reason: 'literal_domain:owner' });
    const pool = bindRankQuery(compile({ poolId: '0x0a01' }, 'pool'), target, []);
    expect(pool.ok && pool.scope).toEqual({ kind: 'pool', key: dict.find('0x0a01') + 1 });
    const outsideEq = bindRankQuery(compile({ 'pricing.source': { $ne: 'no\u0001ne' } }, 'ranked'), target, []);
    expect(outsideEq).toEqual({ ok: false, reason: 'literal_domain:pricing.source' });
    const source = bindRankQuery(compile({ 'pricing.source': { $ne: 'none' } }, 'ranked'), target, []);
    expect(source.ok && source.query.clauses[0]![0]).toMatchObject({ k: 'clsEq', neg: true });
    const list = bindRankQuery(compile({ 'token0.address': { $nin: ['0xabc', 'bad\u0001'] } }, 'ranked'), target, []);
    expect(list).toEqual({ ok: false, reason: `list_domain:token0.address` });
    const binaryList = bindRankQuery(compile({ poolId: '0x00a1', 'token0.address': { $nin: ['bad\u0001'] } }, 'pool'), target, []);
    expect(binaryList.ok).toBe(true);
    expect(RANK_LEAF.owner).toBeGreaterThanOrEqual(0);
  });
});
