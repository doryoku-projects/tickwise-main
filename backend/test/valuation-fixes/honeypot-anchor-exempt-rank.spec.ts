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
import mongoose from 'mongoose';
import { anchorAddresses, DYNAMIC_FEE_FLAG, isAnchorPair, isHoneypotStaticFee } from '../../src/common/pool-fee.js';
import { ZERO_ADDRESS } from '../../src/config/chains.config.js';
import { effectiveLeaderboardSort, PositionsRepository } from '../../src/database/positions.repository.js';
import { PositionSchema } from '../../src/database/schemas/position.schema.js';
import { CkeyIndex } from '../../src/read-models/core/ckey.js';
import { Dictionary } from '../../src/read-models/core/dictionary.js';
import { InThreadEngine } from '../../src/read-models/core/engine-runner.js';
import { leafIndex, shardKey } from '../../src/read-models/core/fields.js';
import type { ModelStore } from '../../src/read-models/core/model-store.js';
import { ShardListFlags } from '../../src/read-models/pools/pool-query.js';
import { rankPermFor } from '../../src/read-models/rank/rank-columns.js';
import { RankEngine } from '../../src/read-models/rank/rank-engine.js';
import type { RankEngineService } from '../../src/read-models/rank/rank-engine.service.js';
import { bindRankQuery, ClassListFlags, compileRankFilter, internRankList, isAlwaysFalse, type RankShape } from '../../src/read-models/rank/rank-query.js';
import { collatedEqual, matches, mongoCompare, prng, type Doc } from '../support/mini-mongo.js';
import {
  ADDRESSES,
  buildRankStore,
  CHAINS,
  EXCLUDED,
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
 * `HONEYPOT_FEE_ANCHOR_EXEMPT=on` through the rank engine: the honeypot
 * clause's fourth branch (`{token0.address ∈ A, token1.address ∈ A}`, A = the
 * chain's config anchors) distributes into CNF (`distributeOr`) and the
 * engine answers every request exactly like MongoDB — including under the
 * ranked shapes' collation, where an address collation-equal to an anchor is
 * a member (mini-mongo's `collatedEqual`). The plan cache keys and today's
 * clause with the exemption off are pinned in `honeypot-anchor-exempt.spec.ts`.
 */

const CONFIG = makeRankConfig({ honeypotFeeFilter: 'on', honeypotFeeAnchorExempt: 'on' });

/** A collation-equal twin of an address: a leading zero added to its first in-hex digit run. */
function twin(address: string): string {
  const hex = address.slice(2);
  for (let i = 0; i < hex.length; i++) {
    if (/[0-9]/.test(hex[i]!) && (i === 0 || !/[0-9]/.test(hex[i - 1]!))) return `0x${hex.slice(0, i)}0${hex.slice(i)}`;
  }
  return `${address}0`;
}

/** Fees the shards carry: real tiers, honeypots incl. the two real anchor/anchor pools, the dynamic flag, absent. */
const FEES: unknown[] = [100, 500, 3000, 10_000, 49_999, 50_000, 60_940, 99_993, 210_790, 999_900, DYNAMIC_FEE_FLAG, DYNAMIC_FEE_FLAG + 1, null, undefined, NaN];

/** Per chain: its anchors (often), twins of a few anchors (sometimes), and rank-support's tokens. */
function legsFor(chainId: number): string[] {
  const anchors = anchorAddresses(chainId);
  return [...anchors, ...anchors, ...anchors.slice(0, 3).map(twin), ZERO_ADDRESS.toUpperCase().replace('0X', '0x'), ...ADDRESSES.slice(0, 12)];
}

/** Deterministic rows on 42161 (fees/legs fixed): the cases the exemption exists for. */
const FIXED = {
  anchorPair21: '900001', // ETH/USDC at 21.079%: kept
  anchorSpam99: '900003', // ETH/spam at 99.99%: dropped
  spamDynamic: '900005', // spam/spam, dynamic-fee flag: kept
  spamNull: '900007', // spam/spam, no fee stored: kept
  anchorPairLow: '900009', // ETH/USDC at 0.3%: kept
};

function withFeesAndLegs(seed: number, sizes: Record<number, number>): Map<number, Doc[]> {
  const shards = shardsFor(seed, sizes);
  const rand = prng(seed * 37);
  for (const [chainId, docs] of shards) {
    const legs = legsFor(chainId);
    for (const doc of docs) {
      const fee = FEES[Math.floor(rand() * FEES.length)];
      if (fee === undefined) delete doc.fee;
      else doc.fee = fee;
      (doc.token0 as Doc).address = legs[Math.floor(rand() * legs.length)];
      (doc.token1 as Doc).address = legs[Math.floor(rand() * legs.length)];
    }
  }
  const arb = shards.get(42161)!;
  const usdc = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
  const fixed = (id: string, fee: unknown, t0: string, t1: string): Doc => {
    const doc = { ...arb[0]!, _id: new mongoose.mongo.ObjectId(), positionId: id, tokenId: id, token0: { address: t0, symbol: 'T0', decimals: 18 }, token1: { address: t1, symbol: 'T1', decimals: 6 } } as Doc;
    if (fee === undefined) delete doc.fee;
    else doc.fee = fee;
    return doc;
  };
  arb.push(
    fixed(FIXED.anchorPair21, 210_790, ZERO_ADDRESS, usdc),
    fixed(FIXED.anchorSpam99, 999_900, ZERO_ADDRESS, ADDRESSES[5]!),
    fixed(FIXED.spamDynamic, DYNAMIC_FEE_FLAG, ADDRESSES[5]!, ADDRESSES[6]!),
    fixed(FIXED.spamNull, undefined, ADDRESSES[5]!, ADDRESSES[6]!),
    fixed(FIXED.anchorPairLow, 3000, ZERO_ADDRESS, usdc),
  );
  return shards;
}

function at(doc: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((cur, key) => (cur && typeof cur === 'object' ? (cur as Doc)[key] : undefined), doc);
}

/** A leg is an anchor as MongoDB sees it under this shape's collation (twins count when collated). */
function anchorLeg(chainId: number, address: unknown, collated: boolean): boolean {
  if (typeof address !== 'string') return false;
  return anchorAddresses(chainId).some((a) => (collated ? collatedEqual(address, a) : address === a));
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
  else if (shape < 0.38) query.positionId = pick(['1', '3', '8', '13', '900001', '900003', 'x']);
  query.sort = effectiveLeaderboardSort(query.status as string | undefined, query.sort as string);
  return query;
}

describe('honeypot anchor exemption — compile', () => {
  it('runs with the fee leaf in the rank model (HONEYPOT_FEE_FILTER=on)', () => {
    expect(leafIndex('rank', 'fee')).toBeGreaterThan(0);
  });

  it('compiles the CAST filter (real PositionSchema) of every shape, the branch distributed into two clauses', async () => {
    const Model = mongoose.models.HoneypotExemptSpec ?? mongoose.model('HoneypotExemptSpec', PositionSchema, '42161_uniswap_v4_positions');
    const repo = new PositionsRepository(
      { positionModel: () => Model } as never,
      { readyLeaderboardExclusions: async () => ({ addresses: ['0xabc', '0x00a1ffff'], ok: true }) } as never,
      CONFIG as never,
    );
    let compiled = 0;
    let withEquity = 0;
    // 42161 has no tokenized equities (`assetClass=equity` folds to "no row"); 4663 has them, so there the
    // equity `$in` and the anchor `$in` sit side by side on the same two leaves.
    for (const chainId of [42161, 4663])
    for (const sort of SORTS)
      for (const status of [undefined, 'active', 'inactive', 'all'])
        for (const includeRisky of [true, false])
          for (const assetClass of [undefined, 'equity'] as const)
            for (const shape of [{}, { poolId: POOLS[0] }, { owner: OWNERS[3]!.toLowerCase() }, { positionId: '3' }]) {
              const anchors = anchorAddresses(chainId);
              const query = { chainId, protocol: PROTO, sort: effectiveLeaderboardSort(status, sort), page: 1, limit: 20, status, activeOnly: false, minValueUsd: 500, minPoolTvl: 0, includeRisky, assetClass, ...shape };
              const plan = await repo.leaderboardPlan(query as never);
              const result = compileRankFilter(repo.castFilter(chainId, PROTO, plan.shapeFilter), chainId, PROTO, plan.shape);
              expect(result.ok, `${JSON.stringify(query)} → ${result.ok ? '' : result.reason}`).toBe(true);
              if (!result.ok) continue;
              compiled++;
              const anchorClauses = result.plan.clauses.filter((clause) => clause.some((a) => a.k === 'in' && !a.neg && a.values.length === anchors.length && a.values.every((v, i) => v === anchors[i])));
              const scoped = plan.shape === 'owner' || plan.shape === 'lookup';
              if (assetClass && !isAlwaysFalse(result.plan.clauses)) withEquity++;
              // (fee < 5% ∨ fee ≥ dyn ∨ fee = null ∨ t0 ∈ A) ∧ (… ∨ t1 ∈ A): one clause per leg — unless the
              // whole filter folded to "no row" (equity on a chain without equities).
              expect(anchorClauses.length, JSON.stringify(query)).toBe(scoped || isAlwaysFalse(result.plan.clauses) ? 0 : 2);
              for (const clause of anchorClauses) expect(clause.map((a) => a.k).sort()).toEqual(['eq', 'in', 'range', 'range']);
            }
    expect(compiled).toBe(2 * SORTS.length * 4 * 2 * 2 * 4);
    expect(withEquity).toBeGreaterThan(0);
  }, 60_000);

  it('interns small literal lists by content (one shared, frozen array), never the big ones', () => {
    const a = internRankList(['0xa', '0xb']);
    expect(internRankList(['0xa', '0xb'])).toBe(a);
    expect(Object.isFrozen(a)).toBe(true);
    expect(internRankList(['0xb', '0xa'])).not.toBe(a);
    const big = Array.from({ length: 2_000 }, (_, i) => `0x${i}`);
    expect(internRankList(big)).toBe(big);
  });

  it('every plan with the exemption shares ONE anchor list, so a shard builds its flags once (pool + ranked shapes)', async () => {
    const shards = withFeesAndLegs(3, { 42161: 40, 1: 10, 4663: 10 });
    const repo = positionsRepo(shards, CONFIG).repo;
    const dict = new Dictionary();
    for (const doc of shards.get(42161)!) {
      dict.intern((doc.token0 as Doc).address as string);
      dict.intern((doc.token1 as Doc).address as string);
    }
    const ckeys = new CkeyIndex();
    ckeys.extend(dict.sharedView());
    const target = { dict, dictSize: dict.size, ckeys, lists: new ShardListFlags(), classLists: new ClassListFlags() };
    const base = { chainId: 42161, protocol: PROTO, sort: 'pnl', page: 1, limit: 20, activeOnly: false, status: 'all', minPoolTvl: 0, includeRisky: true };
    const lists = new Set<unknown>();
    for (let i = 0; i < 20; i++) {
      for (const query of [{ ...base, minValueUsd: 0, poolId: POOLS[i % POOLS.length] }, { ...base, minValueUsd: i + 1 }]) {
        const plan = await repo.leaderboardPlan(query as never);
        const compiled = compileRankFilter(plan.shapeFilter, 42161, PROTO, plan.shape as RankShape);
        if (!compiled.ok) throw new Error(compiled.reason);
        for (const atom of compiled.plan.clauses.flat()) if (atom.k === 'in' && !atom.neg) lists.add(atom.values);
        const bound = bindRankQuery(compiled.plan, target, EXCLUDED.get(42161)!);
        expect(bound.ok).toBe(true);
      }
    }
    // 40 distinct plans, two legs each: one anchor array between them all.
    expect(lists.size).toBe(1);
    // Per shard: the exclusion list + the anchor list, binary (pool) and collated (ranked) — no churn.
    expect(target.lists.size).toBe(2);
    expect(target.classLists.size).toBe(2);
  });
});

describe('rank engine parity with the honeypot filter and its anchor exemption on', () => {
  let shards: Map<number, Doc[]>;
  let store: ModelStore;

  beforeAll(() => {
    shards = withFeesAndLegs(71, { 1: 400, 42161: 400, 4663: 400 });
    store = buildRankStore(shards);
  });

  it('keeps the anchor/anchor 21% pool, drops the anchor/spam 99% pool, keeps dynamic and absent fees (ranked + pool shapes)', async () => {
    const engine = new RankEngine({ engine: new InThreadEngine(), source: () => ({ store, shards: CHAINS.map((chainId) => ({ chainId, protocol: PROTO })) }), alert: () => undefined });
    await engine.tick();
    const repo = positionsRepo(shards, CONFIG).repo;
    const pool = (shards.get(42161)!.find((d) => d.positionId === FIXED.anchorPair21)!.poolId) as string;
    for (const extra of [{}, { poolId: pool }]) {
      const query = { chainId: 42161, protocol: PROTO, sort: 'pnl', page: 1, limit: 20, activeOnly: false, status: 'all', minValueUsd: 0, minPoolTvl: 0, includeRisky: true, ...extra };
      const plan = await repo.leaderboardPlan(query as never);
      const compiled = compileRankFilter(plan.shapeFilter, 42161, PROTO, plan.shape);
      if (!compiled.ok) throw new Error(compiled.reason);
      const sort = rankPermFor(plan.sortField, plan.sortDirection, plan.tieDirection)!;
      const answer = await engine.answer([{ key: shardKey(42161, PROTO), plan: compiled.plan, excluded: plan.excluded }], sort);
      const got = new Set(Array.from(answer.slots, (slot) => engine.pidOf(answer, 0, slot)));
      const mongo = new Set(shards.get(42161)!.filter((doc) => matches(doc, plan.filter, plan.collated)).map((doc) => doc.positionId));
      expect(got).toEqual(mongo);
      expect(got.has(FIXED.anchorPair21)).toBe(true);
      expect(got.has(FIXED.anchorPairLow)).toBe(true);
      if (!('poolId' in extra)) {
        expect(got.has(FIXED.anchorSpam99)).toBe(false);
        expect(got.has(FIXED.spamDynamic)).toBe(true);
        expect(got.has(FIXED.spamNull)).toBe(true);
      }
    }
  });

  it('compiles every filter and matches mini-mongo (sets, order, counts)', async () => {
    const engine = new RankEngine({ engine: new InThreadEngine(), source: () => ({ store, shards: CHAINS.map((chainId) => ({ chainId, protocol: PROTO })) }), alert: () => undefined });
    await engine.tick();
    const repo = positionsRepo(shards, CONFIG).repo;
    const rand = prng(72);
    let exempted = 0;
    let twins = 0;
    for (let i = 0; i < 1_000; i++) {
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
      const matched = plans.flatMap((plan) => shards.get(plan.chainId)!.filter((doc) => matches(doc, plan.filter, plan.collated)).map((doc) => ({ doc, plan })));
      const want = matched
        .map(({ doc }) => doc)
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
      // Where the clause applies, a 5%+ static fee survives only on an anchor/anchor pool.
      const scoped = head.shape === 'lookup' || head.shape === 'owner';
      if (scoped) continue;
      for (const { doc, plan } of matched) {
        if (typeof doc.fee !== 'number' || !isHoneypotStaticFee(doc.fee)) continue;
        const a0 = anchorLeg(plan.chainId, (doc.token0 as Doc).address, plan.collated);
        const a1 = anchorLeg(plan.chainId, (doc.token1 as Doc).address, plan.collated);
        expect(a0 && a1, JSON.stringify({ query, doc: doc.positionId })).toBe(true);
        exempted++;
        if (!isAnchorPair(plan.chainId, (doc.token0 as Doc).address as string, (doc.token1 as Doc).address as string)) twins++;
      }
    }
    // The exemption actually let rows through, and collated twins were among them.
    expect(exempted).toBeGreaterThan(0);
    expect(twins).toBeGreaterThan(0);
  }, 120_000);

  it('answers list requests exactly like the Mongo path, every one served by the engine', async () => {
    let rank: RankEngineService;
    ({ rank } = await rankFor(store, CONFIG));
    const oracle = leaderboardService(positionsRepo(shards, CONFIG).repo, CONFIG);
    const engine = leaderboardService(positionsRepo(shards, CONFIG).repo, CONFIG, rank);
    const rand = prng(73);
    let confirmedAt = Date.now();
    for (let i = 0; i < 250; i++) {
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
