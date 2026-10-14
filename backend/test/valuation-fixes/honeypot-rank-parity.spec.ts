import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// The rank model carries the `fee` leaf only under `HONEYPOT_FEE_FILTER=on`,
// decided when `core/fields.ts` is first imported: set before every import.
const priorFlag = vi.hoisted(() => {
  const prior = process.env.HONEYPOT_FEE_FILTER;
  process.env.HONEYPOT_FEE_FILTER = 'on';
  return prior;
});
afterAll(() => {
  if (priorFlag === undefined) delete process.env.HONEYPOT_FEE_FILTER;
  else process.env.HONEYPOT_FEE_FILTER = priorFlag;
});
import { DYNAMIC_FEE_FLAG, effectiveLeaderboardSort, HONEYPOT_FEE_MIN_PIPS, honeypotFeeClause } from '../../src/database/positions.repository.js';
import { InThreadEngine } from '../../src/read-models/core/engine-runner.js';
import { leafIndex, shardKey } from '../../src/read-models/core/fields.js';
import type { ModelStore } from '../../src/read-models/core/model-store.js';
import { rankPermFor } from '../../src/read-models/rank/rank-columns.js';
import { RankEngine } from '../../src/read-models/rank/rank-engine.js';
import type { RankEngineService } from '../../src/read-models/rank/rank-engine.service.js';
import { compileRankFilter } from '../../src/read-models/rank/rank-query.js';
import { matches, mongoCompare, prng, type Doc } from '../support/mini-mongo.js';
import {
  buildRankStore,
  CHAINS,
  leaderboardService,
  makeRankConfig,
  OWNERS,
  POOLS,
  positionsRepo,
  PROTO,
  rankFor,
  shardsFor,
  SORTS,
  touch,
} from '../read-models/rank-support.js';

/**
 * Fix 2 (honeypot fees) through BOTH read paths: with `HONEYPOT_FEE_FILTER=on`
 * the leaderboard filter gains the clause on the ranked and pool shapes, the
 * rank engine compiles it (the `fee` leaf) and serves every request with the
 * Mongo path's exact answer, and an id lookup / an owner's list still return
 * the row. Off (today) changes nothing.
 */

/** Fee values the shards carry: real tiers, the floor's edges, honeypots, the dynamic flag, and absent / odd numbers. */
const FEES: unknown[] = [100, 500, 3000, 3000, 10_000, 49_999, 50_000, 60_001, 99_993, 999_900, DYNAMIC_FEE_FLAG, DYNAMIC_FEE_FLAG + 1, null, undefined, NaN, 0, -0];

function withFees(seed: number, sizes: Record<number, number>): Map<number, Doc[]> {
  const shards = shardsFor(seed, sizes);
  const rand = prng(seed * 31);
  for (const docs of shards.values()) {
    for (const doc of docs) {
      const fee = FEES[Math.floor(rand() * FEES.length)];
      if (fee === undefined) delete doc.fee;
      else doc.fee = fee;
    }
  }
  return shards;
}

function at(doc: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((cur, key) => (cur && typeof cur === 'object' ? (cur as Doc)[key] : undefined), doc);
}

function isHoneypot(doc: Doc): boolean {
  const fee = doc.fee;
  return typeof fee === 'number' && fee >= HONEYPOT_FEE_MIN_PIPS && fee < DYNAMIC_FEE_FLAG;
}

function randomQuery(rand: () => number): Record<string, unknown> {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  const query: Record<string, unknown> = {
    protocol: PROTO,
    sort: pick(SORTS),
    page: 1 + Math.floor(rand() * 3),
    limit: pick([5, 20, 50]),
    activeOnly: rand() < 0.5,
    status: pick(['active', 'inactive', 'all', undefined]),
    range: pick(['in', 'out', undefined]),
    minValueUsd: pick([0, 0, 500, 0.5]),
    minPoolTvl: pick([0, 1_000, 777]),
    includeRisky: rand() < 0.5,
    assetClass: rand() < 0.08 ? 'equity' : undefined,
  };
  const shape = rand();
  if (shape < 0.15) query.owner = pick(OWNERS).toLowerCase();
  else if (shape < 0.3) query.poolId = pick(POOLS);
  else if (shape < 0.38) query.positionId = pick(['1', '3', '8', '13', '007', 'x']);
  query.sort = effectiveLeaderboardSort(query.status as string | undefined, query.sort as string);
  return query;
}

describe('honeypot-fee clause', () => {
  it('runs with the fee leaf in the rank model (HONEYPOT_FEE_FILTER=on)', () => {
    expect(leafIndex('rank', 'fee')).toBeGreaterThan(0);
  });

  it('keeps real tiers, the dynamic flag and an absent fee; drops 5%+ static fees', () => {
    const clause = honeypotFeeClause();
    const keep = (fee: unknown) => matches(fee === undefined ? {} : { fee }, clause, false);
    for (const fee of [100, 500, 3000, 10_000, 49_999, 0, DYNAMIC_FEE_FLAG, DYNAMIC_FEE_FLAG + 5, null, undefined]) expect(keep(fee), String(fee)).toBe(true);
    for (const fee of [50_000, 60_001, 99_993, 999_900, DYNAMIC_FEE_FLAG - 1]) expect(keep(fee), String(fee)).toBe(false);
  });

  it('is added for the ranked and pool shapes only, and only when the flag is on', async () => {
    const shards = withFees(5, { 1: 10, 42161: 10, 4663: 10 });
    const on = positionsRepo(shards, makeRankConfig({ honeypotFeeFilter: 'on' })).repo;
    const off = positionsRepo(shards, makeRankConfig()).repo;
    const base = { chainId: 1, protocol: PROTO, sort: 'underlying_value', page: 1, limit: 20, activeOnly: false, status: 'all', minValueUsd: 0, minPoolTvl: 0, includeRisky: true };
    const has = (filter: Record<string, unknown>) => JSON.stringify(filter).includes('"fee"');
    expect(has((await on.leaderboardPlan(base as never)).filter)).toBe(true);
    expect(has((await on.leaderboardPlan({ ...base, poolId: POOLS[0] } as never)).filter)).toBe(true);
    expect(has((await on.leaderboardPlan({ ...base, owner: OWNERS[3]!.toLowerCase() } as never)).filter)).toBe(false);
    expect(has((await on.leaderboardPlan({ ...base, owner: OWNERS[3]!.toLowerCase(), poolId: POOLS[0] } as never)).filter)).toBe(false);
    expect(has((await on.leaderboardPlan({ ...base, positionId: '3' } as never)).filter)).toBe(false);
    expect(has((await off.leaderboardPlan(base as never)).filter)).toBe(false);
    expect(has((await off.leaderboardPlan({ ...base, poolId: POOLS[0] } as never)).filter)).toBe(false);
    // The count key follows the filter: on and off never share a cached count.
    expect((await on.leaderboardPlan(base as never)).countKey).not.toBe((await off.leaderboardPlan(base as never)).countKey);
  });
});

describe('rank engine parity with the honeypot filter on', () => {
  const config = makeRankConfig({ honeypotFeeFilter: 'on' });
  let shards: Map<number, Doc[]>;
  let store: ModelStore;

  beforeAll(() => {
    shards = withFees(71, { 1: 500, 42161: 300, 4663: 600 });
    store = buildRankStore(shards);
  });

  it('compiles every filter and matches mini-mongo (sets, order, counts)', async () => {
    const engine = new RankEngine({ engine: new InThreadEngine(), source: () => ({ store, shards: CHAINS.map((chainId) => ({ chainId, protocol: PROTO })) }), alert: () => undefined });
    await engine.tick();
    const repo = positionsRepo(shards, config).repo;
    const rand = prng(72);
    let dropped = 0;
    for (let i = 0; i < 1_200; i++) {
      const query = randomQuery(rand);
      const chainIds = rand() < 0.5 ? [CHAINS[Math.floor(rand() * CHAINS.length)]!] : CHAINS;
      const plans = await Promise.all(chainIds.map((chainId) => repo.leaderboardPlan({ ...(query as never), chainId })));
      const sort = rankPermFor(plans[0]!.sortField, plans[0]!.sortDirection, plans[0]!.tieDirection)!;
      const inputs = plans.map((plan) => {
        const compiled = compileRankFilter(plan.shapeFilter, plan.chainId, plan.protocol, plan.shape);
        if (!compiled.ok) throw new Error(`${compiled.reason} ${JSON.stringify(query)}`);
        return { key: shardKey(plan.chainId, PROTO), plan: compiled.plan, excluded: plan.excluded };
      });
      const answer = await engine.answer(inputs, sort);
      const got = Array.from(answer.slots, (slot, k) => `${answer.shards[answer.shard ? answer.shard[k]! : 0]!.chainId}:${engine.pidOf(answer, answer.shard ? answer.shard[k]! : 0, slot)}`);
      const head = plans[0]!;
      const matched = plans.flatMap((plan) => shards.get(plan.chainId)!.filter((doc) => matches(doc, plan.filter, plan.collated)));
      const want = matched
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
      // The clause bites exactly where it is applied.
      const scoped = head.shape === 'lookup' || head.shape === 'owner';
      if (!scoped) expect(matched.some(isHoneypot), JSON.stringify(query)).toBe(false);
      else if (matched.some(isHoneypot)) dropped++;
    }
    // Lookups / owner lists did still reach honeypot rows somewhere in the run.
    expect(dropped).toBeGreaterThan(0);
  }, 120_000);

  it('answers list requests exactly like the Mongo path, every one served by the engine', async () => {
    let rank: RankEngineService;
    ({ rank } = await rankFor(store, config));
    const oracle = leaderboardService(positionsRepo(shards, config).repo, config);
    const engine = leaderboardService(positionsRepo(shards, config).repo, config, rank);
    const rand = prng(73);
    let confirmedAt = Date.now();
    for (let i = 0; i < 300; i++) {
      if (Date.now() - confirmedAt > 5_000) {
        touch(store);
        await rank.tick();
        confirmedAt = Date.now();
      }
      const q = randomQuery(rand);
      if (rand() < 0.5) q.chainId = CHAINS[Math.floor(rand() * CHAINS.length)];
      const before = (rank.status().requests as { served: number }).served;
      const [a, b] = await Promise.all([oracle.getTopPositions(q as never, { countWaitMs: 2_000 }), engine.getTopPositions(q as never, { countWaitMs: 2_000 })]);
      expect(b, JSON.stringify(q)).toEqual(a);
      expect((rank.status().requests as { served: number }).served - before, `served ${JSON.stringify(q)}`).toBe(1);
    }
  }, 120_000);
});
