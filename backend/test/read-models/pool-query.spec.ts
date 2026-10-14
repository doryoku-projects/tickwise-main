import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { PoolsRepository, type PoolsLeaderboardQuery } from '../../src/database/pools.repository.js';
import { PoolSchema } from '../../src/database/schemas/pool.schema.js';
import { compileFilter } from '../../src/read-models/core/query-ast.js';
import { compilePoolFilter, EXCLUSION_PLACEHOLDER, poolLeafResolver } from '../../src/read-models/pools/pool-query.js';

/**
 * Compile the Mongo filter, never re-derive it (design §4.9): every filter
 * `buildPoolsFilter` emits, CAST through the real Mongoose pool schema,
 * compiles; anything outside the restricted grammar is UNSUPPORTED (the
 * request goes to Mongo); the exclusion placeholder binds to exactly the list
 * MongoDB would receive.
 */

const Model = mongoose.model('PoolCastSpec', PoolSchema, '4663_uniswap_v4_pools');
const EXCLUDED = ['0x00aa', '0x0bad', '0xdead'];

function repo(excluded: string[] = EXCLUDED) {
  const tokens = { readyLeaderboardExclusions: async () => ({ addresses: excluded, ok: true }) };
  return new PoolsRepository({ poolModel: () => Model } as never, tokens as never);
}

const query = (over: Partial<PoolsLeaderboardQuery>): PoolsLeaderboardQuery => ({
  chainId: 4663,
  protocol: 'uniswap-v4',
  sort: 'tvl',
  page: 1,
  limit: 20,
  minTvlUsd: 0,
  includeRisky: false,
  ...over,
});

describe('pools filter compiler', () => {
  it('compiles every filter the repository builds (cast through the real schema)', async () => {
    const r = repo();
    let n = 0;
    for (const sort of ['tvl', 'volume', 'fees', 'fee_apr', 'age']) {
      for (const minTvlUsd of [0, 0.5, 10_000, -3, '500' as unknown as number, Number.NaN]) {
        for (const includeRisky of [false, true]) {
          for (const search of [undefined, 'usd', 'a.b(c)', '0xAB', 'ſ', 'line\nbreak', 'x/y']) {
            for (const assetClass of [undefined, 'equity' as const]) {
              for (const excluded of [EXCLUDED, []]) {
                const plan = await repo(excluded).poolsPlan(query({ sort, minTvlUsd, includeRisky, search, assetClass }));
                const cast = r.castFilter(4663, 'uniswap-v4', plan.shapeFilter);
                const compiled = compilePoolFilter(cast, 4663, 'uniswap-v4');
                expect(compiled.ok, JSON.stringify({ sort, minTvlUsd, includeRisky, search, assetClass })).toBe(true);
                if (compiled.ok) expect(compiled.plan.placeholder).toBe(!search && excluded.length > 0);
                n++;
              }
            }
          }
        }
      }
    }
    expect(n).toBeGreaterThan(1_000);
  });

  it('binds the placeholder to exactly the list MongoDB receives (token legs are Mixed: not cast)', async () => {
    const r = repo();
    const plan = await r.poolsPlan(query({ assetClass: 'equity' }));
    const full = r.castFilter(4663, 'uniswap-v4', plan.filter);
    const shape = r.castFilter(4663, 'uniswap-v4', plan.shapeFilter);
    const substituted = JSON.parse(JSON.stringify(shape), (_key, value) => (Array.isArray(value) && value.length === 1 && value[0] === EXCLUSION_PLACEHOLDER ? plan.excluded : value));
    expect(JSON.parse(JSON.stringify(full))).toEqual(substituted);
    expect(plan.excluded).toBe(EXCLUDED);
  });

  it('the cast keeps the search RegExp and the numbers MongoDB gets', async () => {
    const plan = await repo().poolsPlan(query({ search: 'USD', minTvlUsd: '500' as unknown as number }));
    const cast = repo().castFilter(4663, 'uniswap-v4', plan.shapeFilter);
    expect(cast['metrics.tvlUsd']).toEqual({ $gte: 500, $lte: 5e10 });
    const or = (cast.$and as Array<{ $or: Array<Record<string, RegExp>> }>)[0].$or;
    expect(or[0]['token0.symbol']).toBeInstanceOf(RegExp);
    expect(or[0]['token0.symbol'].flags).toBe('i');
  });

  it('turns the shard identity into constants', () => {
    expect(compilePoolFilter({ chainId: 4663, protocol: 'uniswap-v4' }, 4663, 'uniswap-v4')).toEqual({ ok: true, plan: { clauses: [], leaves: [0, 1], placeholder: false } });
    const other = compilePoolFilter({ chainId: 1, protocol: 'uniswap-v4' }, 4663, 'uniswap-v4');
    expect(other.ok && other.plan.clauses).toEqual([[{ k: 'const', value: false }]]);
  });

  it('refuses anything outside the restricted grammar (UNSUPPORTED → Mongo)', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ 'metrics.tvlUsd': { $exists: true } }, 'op:$exists'],
      [{ $where: 'true' }, 'operator:$where'],
      [{ $nor: [{ poolId: 'x' }] }, 'operator:$nor'],
      [{ 'metrics.txCount': 1 }, 'field:metrics.txCount'],
      [{ token0: { address: 'x' } }, 'field:token0'],
      [{ $or: [{ poolId: 'a', 'token0.symbol': 'b' }, { poolId: 'c' }] }, 'or_conjunction'],
      [{ 'metrics.tvlUsd': { $gte: '5' } }, 'range_literal:metrics.tvlUsd'],
      [{ 'metrics.tvlUsd': { $gte: Number.NaN } }, 'range_literal:metrics.tvlUsd'],
      [{ poolId: { $gte: 'a' } }, 'range_kind:poolId'],
      [{ poolId: /a.b/i }, 'regex_not_literal'],
      [{ poolId: /ab/ }, 'regex_flags'],
      [{ 'token0.address': { $in: ['a', null] } }, 'in_literal:token0.address'],
      [{ poolId: ['a'] }, 'eq_literal:poolId'],
      [{ 'pricing.usedFallback': { $ne: 'true' } }, 'eq_literal:pricing.usedFallback'],
      [{ $and: [] }, 'and_shape'],
      [{ $or: [] }, 'or_shape'],
    ];
    for (const [filter, reason] of cases) expect(compileFilter(filter, poolLeafResolver), JSON.stringify(filter)).toEqual({ ok: false, reason });
  });

  it('folds empty $in / $nin and always-true $or branches like MongoDB evaluates them', () => {
    expect(compileFilter({ 'token0.address': { $in: [] } }, poolLeafResolver)).toEqual({ ok: true, filter: { clauses: [[{ k: 'const', value: false }]], leaves: [4] } });
    expect(compileFilter({ 'token0.address': { $nin: [] } }, poolLeafResolver)).toEqual({ ok: true, filter: { clauses: [], leaves: [4] } });
    expect(compileFilter({ $or: [{}, { poolId: 'x' }] }, poolLeafResolver)).toEqual({ ok: true, filter: { clauses: [], leaves: [2] } });
  });
});
