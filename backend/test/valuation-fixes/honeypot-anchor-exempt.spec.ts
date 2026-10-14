import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `HONEYPOT_FEE_ANCHOR_EXEMPT` (default off): a pool whose BOTH legs are
 * config anchors is never a honeypot-fee pool — real pools exist above 5%
 * (42161 ETH/USDC at 60,940 pips, 1 ETH/USDT at 210,790, ~$50k each). Pinned
 * here: the shared rule (common/pool-fee.ts) and its anchor list agreeing with
 * `isAnchorTokenStandalone` on every chain, the pools sync's verdict and page
 * loop, and the positions clause — today's object exactly with the flag off,
 * MongoDB's answer with it on. The rank engine side is
 * `honeypot-anchor-exempt-rank.spec.ts`.
 */

// The pools sync's indexer reads, for the page-loop cases below (one page).
let pagePool: Record<string, unknown> = {};
vi.mock('../../src/subgraph/request-retry.js', () => ({
  requestWithRetry: async (_client: unknown, query: unknown, vars: Record<string, unknown>) => {
    const text = String(query);
    if (text.includes('PoolDayMax') || text.includes('PoolDayBatch')) return { poolDayDatas: [] };
    if ((vars.where as { id_gt?: string } | undefined)?.id_gt) return { pools: [] };
    return { pools: [pagePool] };
  },
}));

import {
  CHAINS as CHAIN_CONFIGS,
  PAYMENT_TOKEN_REGISTRY,
  PROTECTED_MAJOR_ADDRESSES,
  ZERO_ADDRESS,
} from '../../src/config/chains.config.js';
import {
  anchorAddresses,
  DYNAMIC_FEE_FLAG,
  HONEYPOT_FEE_MIN_PIPS,
  isAnchorPair,
  isHoneypotStaticFee,
} from '../../src/common/pool-fee.js';
import { honeypotFeeClause } from '../../src/database/positions.repository.js';
import type { PoolUpsert } from '../../src/database/pools.repository.js';
import { isAnchorTokenStandalone } from '../../src/pricing/pricing-policy.js';
import { isAllowlisted } from '../../src/pricing/token-allowlist.js';
import { ARBITRUM_ALLOWLIST } from '../../src/pricing/data/token-allowlist.arbitrum.js';
import { evaluatePoolTvl, PoolsSyncService } from '../../src/sync/pools-sync.service.js';
import { matches, prng, type Doc } from '../support/mini-mongo.js';
import { makeRankConfig, positionsRepo, PROTO } from '../read-models/rank-support.js';

const ARB = 42161;
const ARB_USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const ARB_WETH = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
const ETH_USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7';
const SPAM = '0x1111111111111111111111111111111111111111';
/** Today's clause, written out — the object every off-path must still equal. */
const TODAY = { $or: [{ fee: { $lt: 50_000 } }, { fee: { $gte: 0x800000 } }, { fee: null }] };

describe('common/pool-fee — the one rule', () => {
  it("isHoneypotStaticFee is today's expression on every number", () => {
    const today = (fee: number) => fee >= HONEYPOT_FEE_MIN_PIPS && fee < DYNAMIC_FEE_FLAG;
    const fees = [0, -0, 100, 500, 3000, 10_000, 49_999, 50_000, 60_940, 99_993, 210_790, 999_900, 0x7fffff, 0x800000, 0x800001, NaN, Infinity, -Infinity];
    for (const fee of fees) expect(isHoneypotStaticFee(fee), String(fee)).toBe(today(fee));
    expect(isHoneypotStaticFee(60_940)).toBe(true);
    expect(isHoneypotStaticFee(NaN)).toBe(false);
  });

  it('anchorAddresses agrees with isAnchorTokenStandalone on every chain in CHAINS', () => {
    const chainIds = Object.keys(CHAIN_CONFIGS).map(Number);
    expect(chainIds.length).toBeGreaterThanOrEqual(4);
    // Every address chains.config knows about, on any chain, plus one that is no token at all.
    const universe = new Set<string>([SPAM]);
    for (const chain of Object.values(CHAIN_CONFIGS)) {
      for (const a of [...chain.stablecoins, chain.wrappedNativeToken.address, chain.nativeToken.address, ...(chain.trustedTokens ?? [])]) universe.add(a);
    }
    for (const bySymbol of Object.values(PROTECTED_MAJOR_ADDRESSES)) for (const list of Object.values(bySymbol)) for (const a of list) universe.add(a);
    for (const token of Object.values(PAYMENT_TOKEN_REGISTRY)) universe.add(token.address);

    for (const chainId of chainIds) {
      const chain = CHAIN_CONFIGS[chainId]!;
      const list = anchorAddresses(chainId);
      expect(list.length, `chain ${chainId}`).toBeGreaterThan(0);
      expect(new Set(list).size, `chain ${chainId} de-duplicated`).toBe(list.length);
      for (const a of list) {
        expect(a, `chain ${chainId} lowercased`).toBe(a.toLowerCase());
        expect(isAnchorTokenStandalone(chainId, a), `chain ${chainId} ${a} is an anchor`).toBe(true);
      }
      // Spot checks: every config anchor class is listed, the zero pseudo-address included.
      for (const a of chain.stablecoins) expect(list, `chain ${chainId} stable ${a}`).toContain(a.toLowerCase());
      for (const a of chain.trustedTokens ?? []) expect(list, `chain ${chainId} trusted ${a}`).toContain(a.toLowerCase());
      expect(list).toContain(chain.wrappedNativeToken.address.toLowerCase());
      expect(list).toContain(chain.nativeToken.address.toLowerCase());
      expect(list).toContain(ZERO_ADDRESS);
      // And both ways over the universe, in either case: listed ⇔ anchor.
      for (const a of universe) {
        for (const form of [a, a.toLowerCase(), a.toUpperCase().replace('0X', '0x')]) {
          expect(list.includes(form.toLowerCase()), `chain ${chainId} ${form}`).toBe(isAnchorTokenStandalone(chainId, form));
        }
      }
    }
  });

  it('anchorAddresses returns a fresh array per call, and nothing for an unknown chain', () => {
    expect(anchorAddresses(ARB)).not.toBe(anchorAddresses(ARB));
    expect(anchorAddresses(ARB)).toEqual(anchorAddresses(ARB));
    expect(anchorAddresses(999_999)).toEqual([]);
    expect(isAnchorPair(999_999, ZERO_ADDRESS, ARB_USDC)).toBe(false);
  });

  it('isAnchorPair: both legs anchors (any case), never one', () => {
    expect(isAnchorPair(ARB, ZERO_ADDRESS, ARB_USDC)).toBe(true); // ETH/USDC, 60,940 pips in prod data
    expect(isAnchorPair(1, ZERO_ADDRESS, ETH_USDT)).toBe(true); // ETH/USDT, 210,790 pips
    expect(isAnchorPair(ARB, ARB_WETH.toUpperCase().replace('0X', '0x'), ARB_USDC)).toBe(true);
    expect(isAnchorPair(ARB, ZERO_ADDRESS, SPAM)).toBe(false);
    expect(isAnchorPair(ARB, SPAM, ARB_USDC)).toBe(false);
    // Anchors are per chain: Ethereum's USDT is no anchor on Arbitrum.
    expect(isAnchorPair(ARB, ZERO_ADDRESS, ETH_USDT)).toBe(false);
  });
});

describe('evaluatePoolTvl — honeypotExempt', () => {
  const base = { reserve0: 10, reserve1: 25_000, price0: 2_500, price1: 1, confidence0: 'anchor', confidence1: 'anchor' };

  it('an exempt pool at 6.094% is not risky and keeps its trusted TVL; not exempt, it is flagged (today)', () => {
    expect(evaluatePoolTvl({ ...base, feeTier: 60_940 })).toMatchObject({ risky: true, tvlUsd: 0 });
    expect(evaluatePoolTvl({ ...base, feeTier: 60_940, honeypotExempt: false })).toMatchObject({ risky: true, tvlUsd: 0 });
    expect(evaluatePoolTvl({ ...base, feeTier: 60_940, honeypotExempt: true })).toMatchObject({ risky: false, tvlUsd: 50_000 });
    expect(evaluatePoolTvl({ ...base, feeTier: 210_790, honeypotExempt: true }).risky).toBe(false);
  });

  it('the exemption covers the fee ONLY: fabrication and corrupt reserves still flag', () => {
    const fabricated = { ...base, confidence1: 'external-unverified', price1: 10, feeTier: 60_940, honeypotExempt: true };
    expect(evaluatePoolTvl(fabricated).risky).toBe(true);
    const corrupt = { ...base, reserve0: -1, feeTier: 60_940, honeypotExempt: true };
    expect(evaluatePoolTvl(corrupt)).toMatchObject({ risky: true, reserveCorrupt: true });
  });

  it('absent and false are byte-identical to today on random pools', () => {
    const rand = prng(17);
    const confs = ['anchor', 'external-verified', 'external-unverified', 'missing', undefined];
    const fees = [100, 3000, 10_000, 49_999, 50_000, 60_940, 210_790, 0x800000];
    const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)]!;
    for (let i = 0; i < 2_000; i++) {
      const input = {
        reserve0: rand() < 0.1 ? -rand() * 10 : rand() * 1e6,
        reserve1: rand() * 1e6,
        price0: rand() * 3_000,
        price1: rand() * 2,
        confidence0: pick(confs),
        confidence1: pick(confs),
        feeTier: pick(fees),
      };
      const today = evaluatePoolTvl(input);
      expect(evaluatePoolTvl({ ...input, honeypotExempt: false })).toEqual(today);
      expect(evaluatePoolTvl({ ...input, honeypotExempt: undefined })).toEqual(today);
      // On, it can only ever UN-flag a pool, and only for the fee.
      const exempt = evaluatePoolTvl({ ...input, honeypotExempt: true });
      if (!today.risky) expect(exempt).toEqual(today);
      if (exempt.risky !== today.risky) expect(isHoneypotStaticFee(input.feeTier)).toBe(true);
    }
  });
});

describe('pools sync — the page loop passes the exemption', () => {
  const POOL = '0x9c25d738109ff9ad10516f5f97ef24b9af51a9aa3db4b3b5728edf18a2d3f11c';
  // 1:1 sqrtPrice; the pool's own ratio is never checked in allowlist mode.
  const SQRT_1_1 = '79228162514264337593543950336';
  const ALLOWLISTED = [...ARBITRUM_ALLOWLIST].find((a) => !isAnchorTokenStandalone(ARB, a))!;

  function row(token0: string, token1: string, feeTier: number): Record<string, unknown> {
    return {
      id: POOL,
      token0: { id: token0, symbol: 'T0', decimals: '18' },
      token1: { id: token1, symbol: 'T1', decimals: '6' },
      feeTier: String(feeTier),
      tickSpacing: '60',
      tick: '0',
      sqrtPrice: SQRT_1_1,
      liquidity: '1000',
      createdAtTimestamp: '1700000000',
      totalValueLockedToken0: '10',
      totalValueLockedToken1: '25000',
      totalValueLockedUSD: '0',
      volumeUSD: '5',
      feesUSD: '0.01',
      txCount: '3',
      token0Price: '1',
      token1Price: '1',
    };
  }

  function makeService(config: Record<string, unknown>) {
    const written: PoolUpsert[] = [];
    const repo = {
      upsertMany: async (pools: PoolUpsert[]) => {
        written.push(...pools);
        return { written: pools.length, unchanged: 0, hashReads: 0 };
      },
    };
    const fullConfig = {
      getIntegration: () => ({ chainId: ARB, protocol: 'uniswap-v4', subgraphUrl: 'http://indexer.test/graphql' }),
      poolsSyncIntervalMs: 3_600_000,
      ...config,
    };
    const pricePool = vi.fn(async () => ({ token0Usd: 2_500, token1Usd: 1, source: 'external', usedFallback: false, token0Confidence: 'anchor', token1Confidence: 'anchor' }));
    const svc = new PoolsSyncService(fullConfig as never, repo as never, { pricePool } as never);
    (svc as unknown as { logger: unknown }).logger = { log: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
    return { svc, written, pricePool };
  }

  beforeEach(() => {
    pagePool = row(ZERO_ADDRESS, ARB_USDC, 60_940);
  });

  it('off (default / absent / explicit): the ETH/USDC 6.094% pool stays a risky $0 pool (today)', async () => {
    for (const config of [{}, { honeypotFeeAnchorExempt: 'off' }]) {
      const { svc, written, pricePool } = makeService(config);
      await svc.syncPools(ARB, 'uniswap-v4');
      expect(pricePool).toHaveBeenCalledTimes(1);
      expect(written[0]).toMatchObject({ poolId: POOL, metrics: { tvlUsd: 0 }, pricing: { usedFallback: true } });
    }
  });

  it('on: the same pool is not risky and carries its real TVL', async () => {
    const { svc, written } = makeService({ honeypotFeeAnchorExempt: 'on' });
    await svc.syncPools(ARB, 'uniswap-v4');
    expect(written[0]!.pricing.usedFallback).toBe(false);
    expect(written[0]!.metrics.tvlUsd).toBeCloseTo(10 * 2_500 + 25_000, 6);
  });

  it('on: a priced pool with one non-anchor leg is still flagged by its fee', async () => {
    expect(isAllowlisted(ARB, ALLOWLISTED)).toBe(true);
    pagePool = row(ALLOWLISTED, ARB_USDC, 60_940);
    const { svc, written, pricePool } = makeService({ honeypotFeeAnchorExempt: 'on' });
    await svc.syncPools(ARB, 'uniswap-v4');
    expect(pricePool).toHaveBeenCalledTimes(1);
    expect(written[0]).toMatchObject({ metrics: { tvlUsd: 0 }, pricing: { usedFallback: true } });
  });
});

describe('positions — honeypotFeeClause(chainId, exempt)', () => {
  it("is today's object, exactly, whenever the exemption is off or has nothing to exempt", () => {
    expect(honeypotFeeClause()).toEqual(TODAY);
    expect(honeypotFeeClause(ARB)).toEqual(TODAY);
    expect(honeypotFeeClause(ARB, false)).toEqual(TODAY);
    expect(honeypotFeeClause(undefined, true)).toEqual(TODAY);
    expect(honeypotFeeClause(999_999, true)).toEqual(TODAY);
    expect(JSON.stringify(honeypotFeeClause(ARB, false))).toBe(JSON.stringify(TODAY));
  });

  it('on: a fourth branch, both legs in the chain\'s anchor list', () => {
    const anchors = anchorAddresses(ARB);
    expect(honeypotFeeClause(ARB, true)).toEqual({
      $or: [...TODAY.$or, { 'token0.address': { $in: anchors }, 'token1.address': { $in: anchors } }],
    });
  });

  it('on: keeps anchor/anchor at any fee, drops anchor/spam at 5%+, keeps dynamic / low / absent fees (MongoDB semantics)', () => {
    const clause = honeypotFeeClause(ARB, true);
    const keep = (doc: Doc, collated = false) => matches(doc, clause, collated);
    const pos = (fee: unknown, t0?: string, t1?: string): Doc => {
      const doc: Doc = {};
      if (fee !== undefined) doc.fee = fee;
      if (t0 !== undefined) doc.token0 = { address: t0 };
      if (t1 !== undefined) doc.token1 = { address: t1 };
      return doc;
    };
    for (const collated of [false, true]) {
      expect(keep(pos(60_940, ZERO_ADDRESS, ARB_USDC), collated)).toBe(true);
      expect(keep(pos(210_790, ARB_WETH, ARB_USDC), collated)).toBe(true);
      expect(keep(pos(999_900, ZERO_ADDRESS, SPAM), collated)).toBe(false);
      expect(keep(pos(999_900, SPAM, ARB_USDC), collated)).toBe(false);
      expect(keep(pos(60_940, ZERO_ADDRESS), collated)).toBe(false); // a missing leg is never an anchor
      expect(keep(pos(60_940, ZERO_ADDRESS, ETH_USDT), collated)).toBe(false); // another chain's anchor
      expect(keep(pos(DYNAMIC_FEE_FLAG, SPAM, SPAM), collated)).toBe(true);
      expect(keep(pos(3000, SPAM, SPAM), collated)).toBe(true);
      expect(keep(pos(null, SPAM, SPAM), collated)).toBe(true);
      expect(keep(pos(undefined, SPAM, SPAM), collated)).toBe(true);
    }
  });

  it('on: equals the pure rule (fee is no honeypot, or both legs are anchors) on random positions', () => {
    const clause = honeypotFeeClause(ARB, true);
    const anchors = anchorAddresses(ARB);
    const tokens = [...anchors, SPAM, ETH_USDT, '0x2222222222222222222222222222222222222222', undefined];
    const fees: unknown[] = [0, 100, 3000, 49_999, 50_000, 60_940, 210_790, 999_900, DYNAMIC_FEE_FLAG - 1, DYNAMIC_FEE_FLAG, DYNAMIC_FEE_FLAG + 1, null, undefined];
    const rand = prng(23);
    const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
    let exempted = 0;
    for (let i = 0; i < 3_000; i++) {
      const fee = pick(fees);
      const t0 = pick(tokens);
      const t1 = pick(tokens);
      const doc: Doc = {};
      if (fee !== undefined) doc.fee = fee;
      if (t0 !== undefined) doc.token0 = { address: t0 };
      if (t1 !== undefined) doc.token1 = { address: t1 };
      const honeypot = typeof fee === 'number' && isHoneypotStaticFee(fee);
      const pair = t0 !== undefined && t1 !== undefined && isAnchorPair(ARB, t0, t1);
      if (honeypot && pair) exempted++;
      expect(matches(doc, clause, false), JSON.stringify(doc)).toBe(!honeypot || pair);
    }
    expect(exempted).toBeGreaterThan(0);
  });

  it('reaches the leaderboard filter only with the honeypot filter on; off keeps every plan and count key identical', async () => {
    const shards = new Map([[ARB, [] as Doc[]], [1, [] as Doc[]], [4663, [] as Doc[]]]);
    const base = { chainId: ARB, protocol: PROTO, sort: 'underlying_value', page: 1, limit: 20, activeOnly: false, status: 'all', minValueUsd: 0, minPoolTvl: 0, includeRisky: true };
    const plan = async (config: Record<string, unknown>, query: Record<string, unknown> = base) =>
      positionsRepo(shards, makeRankConfig(config)).repo.leaderboardPlan(query as never);
    const strip = (p: Awaited<ReturnType<typeof plan>>) => ({ filter: p.filter, shapeFilter: p.shapeFilter, countKey: p.countKey, key: p.key });
    for (const query of [base, { ...base, poolId: '0x' + 'd'.repeat(64) }, { ...base, status: 'active', includeRisky: false }]) {
      const filterOn = await plan({ honeypotFeeFilter: 'on' }, query);
      // The exemption off — absent or explicit — is today's plan, byte for byte.
      expect(strip(await plan({ honeypotFeeFilter: 'on', honeypotFeeAnchorExempt: 'off' }, query))).toEqual(strip(filterOn));
      // The exemption alone does nothing: the honeypot filter is what adds a clause.
      expect(strip(await plan({ honeypotFeeAnchorExempt: 'on' }, query))).toEqual(strip(await plan({}, query)));
      const exempt = await plan({ honeypotFeeFilter: 'on', honeypotFeeAnchorExempt: 'on' }, query);
      expect(JSON.stringify(exempt.filter)).toContain(ARB_USDC);
      // On and off never share a cached count or window.
      expect(exempt.countKey).not.toBe(filterOn.countKey);
    }
    // An owner's list and an id lookup never carry the honeypot clause, exempt or not.
    const exemptOn = { honeypotFeeFilter: 'on', honeypotFeeAnchorExempt: 'on' };
    expect(JSON.stringify((await plan(exemptOn, { ...base, owner: '0x' + 'e'.repeat(40) })).filter)).not.toContain('"fee"');
    expect(JSON.stringify((await plan(exemptOn, { ...base, positionId: '3' })).filter)).not.toContain('"fee"');
  });
});
