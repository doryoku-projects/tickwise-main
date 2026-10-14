import { describe, expect, it } from 'vitest';
import { effectiveLeaderboardSort } from '../../src/database/positions.repository.js';
import { InThreadEngine } from '../../src/read-models/core/engine-runner.js';
import { shardKey } from '../../src/read-models/core/fields.js';
import { rankPermFor } from '../../src/read-models/rank/rank-columns.js';
import { RankEngine } from '../../src/read-models/rank/rank-engine.js';
import { compileRankFilter } from '../../src/read-models/rank/rank-query.js';
import { matches, mongoCompare, prng, type Doc } from '../support/mini-mongo.js';
import { buildRankStore, CHAINS, EXCLUDED, makeRankConfig, OWNERS, POOLS, positionsRepo, PROTO, shardsFor, SORTS, TWIN_EXCLUDED, TWIN_HELD } from './rank-support.js';

/**
 * Filter-level parity on documents today's RESPONSE builder cannot render
 * (it calls `address.toLowerCase()` on every leg, on both paths), so the
 * whole-response parity spec cannot carry them: null / missing token
 * addresses (`$nin` lets them through, `$in` never matches them), `metrics` /
 * `poolStats` / `pricing` null or missing (every leaf null), sort keys missing
 * — the engine's match set, order and count equal mini-mongo's evaluation of
 * the SAME plan filter (collated for the ranked / owner shapes) and sort.
 */

function oddDocs(seed: number): Map<number, Doc[]> {
  const shards = shardsFor(seed, { 1: 500, 42161: 300, 4663: 600 });
  const rand = prng(seed);
  for (const docs of shards.values()) {
    for (const doc of docs) {
      const r = rand();
      if (r < 0.04) doc.token0 = {};
      else if (r < 0.08) doc.token1 = { address: null };
      else if (r < 0.1) doc.metrics = null;
      else if (r < 0.12) delete doc.metrics;
      else if (r < 0.14) doc.poolStats = null;
      else if (r < 0.16) doc.pricing = null;
      else if (r < 0.18) delete doc.createdAtTimestamp;
      else if (r < 0.2) doc.token0 = { address: TWIN_EXCLUDED };
      else if (r < 0.22) doc.token1 = { address: TWIN_HELD };
    }
  }
  return shards;
}

function at(doc: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((cur, key) => (cur && typeof cur === 'object' ? (cur as Doc)[key] : undefined), doc);
}

describe('rank engine filter parity on unrenderable documents', () => {
  it('match sets, orders and counts equal mini-mongo over the full query space', async () => {
    const shards = oddDocs(61);
    const store = buildRankStore(shards);
    const engine = new RankEngine({ engine: new InThreadEngine(), source: () => ({ store, shards: CHAINS.map((chainId) => ({ chainId, protocol: PROTO })) }), alert: () => undefined });
    await engine.tick();
    const repo = positionsRepo(shards, makeRankConfig()).repo;
    const rand = prng(62);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
    let checked = 0;
    for (let i = 0; i < 1_500; i++) {
      const query: Record<string, unknown> = {
        protocol: PROTO,
        sort: pick(SORTS),
        page: 1,
        limit: 20,
        activeOnly: rand() < 0.5,
        status: pick(['active', 'inactive', 'all', undefined]),
        range: pick(['in', 'out', undefined]),
        minValueUsd: pick([0, 0, 500, 0.5]),
        minPoolTvl: pick([0, 1_000, 777]),
        includeRisky: rand() < 0.5,
        assetClass: rand() < 0.1 ? 'equity' : undefined,
      };
      const shape = rand();
      if (shape < 0.15) query.owner = pick(OWNERS).toLowerCase();
      else if (shape < 0.3) query.poolId = pick(POOLS);
      else if (shape < 0.38) query.positionId = pick(['1', '3', '8', '007', '4294967296', 'x']);
      // The service's own remap (`LeaderboardService.baseArgs`): Closed + a rate sort is served as pnl.
      query.sort = effectiveLeaderboardSort(query.status as string | undefined, query.sort as string);
      const chainIds = rand() < 0.5 ? [pick(CHAINS)] : CHAINS;
      const plans = await Promise.all(chainIds.map((chainId) => repo.leaderboardPlan({ ...(query as never), chainId })));
      const sort = rankPermFor(plans[0]!.sortField, plans[0]!.sortDirection, plans[0]!.tieDirection)!;
      const inputs = plans.map((plan) => {
        const compiled = compileRankFilter(plan.shapeFilter, plan.chainId, plan.protocol, plan.shape);
        if (!compiled.ok) throw new Error(compiled.reason);
        return { key: shardKey(plan.chainId, PROTO), plan: compiled.plan, excluded: plan.excluded };
      });
      const answer = await engine.answer(inputs, sort);
      const got = Array.from(answer.slots, (slot, k) => `${answer.shards[answer.shard ? answer.shard[k]! : 0]!.chainId}:${engine.pidOf(answer, answer.shard ? answer.shard[k]! : 0, slot)}`);
      const head = plans[0]!;
      const want = plans
        .flatMap((plan) => shards.get(plan.chainId)!.filter((doc) => matches(doc, plan.filter, plan.collated)))
        .sort((a, b) => {
          const byField = mongoCompare(at(a, head.sortField), at(b, head.sortField), true) * head.sortDirection;
          if (byField !== 0) return byField;
          const byId = mongoCompare(a.positionId, b.positionId, true) * head.tieDirection;
          if (byId !== 0) return byId;
          return (a.chainId as number) - (b.chainId as number);
        })
        .map((doc) => `${doc.chainId}:${doc.positionId}`);
      expect(got, JSON.stringify({ query, chainIds })).toEqual(want);
      expect(answer.counts.reduce((x, y) => x + y, 0)).toBe(want.length);
      checked++;
    }
    expect(checked).toBe(1_500);
    expect(EXCLUDED.get(1)).toContain(TWIN_EXCLUDED);
  }, 120_000);
});

