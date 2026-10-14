import { describe, expect, it, vi } from 'vitest';
import { PoolsSyncService, buildRiskyPoolUpsert, evaluatePoolTvl, plausibleFeesUsd } from '../src/sync/pools-sync.service.js';

describe('evaluatePoolTvl (trust-tiered pool TVL + spam flags)', () => {
  it('counts both legs for a trusted pair (WBTC/USDT-class)', () => {
    const v = evaluatePoolTvl({
      reserve0: 79.756, reserve1: 3_291_050,
      price0: 61_440, price1: 1,
      confidence0: 'anchor', confidence1: 'anchor',
      feeTier: 3000,
    });
    expect(v.risky).toBe(false);
    expect(v.tvlUsd).toBeCloseTo(79.756 * 61_440 + 3_291_050, 0);
  });

  it('zeroes + flags a pool whose value comes from an untrusted leg (USDC/AMKT real case)', () => {
    // Pool holds −0.50 USDC (negative accounting) + 5.19 AMKT priced $10.4M by
    // a seeded derivedETH (pool-derived confidence) → headline must be 0/risky,
    // not $54M.
    const v = evaluatePoolTvl({
      reserve0: -0.502545, reserve1: 5.195848,
      price0: 1, price1: 10_400_000,
      confidence0: 'anchor', confidence1: 'pool-derived-strong',
      feeTier: 999890,
    });
    expect(v.tvlUsd).toBe(0);
    expect(v.risky).toBe(true);
    expect(v.tvlToken0).toBe(0); // negative reserve clamped
  });

  it('clamps negative reserves before valuation (H/USDT $31B case)', () => {
    const v = evaluatePoolTvl({
      reserve0: 4_948_974, reserve1: -46_432,
      price0: 6_263, price1: 1,
      confidence0: 'pool-derived-strong', confidence1: 'anchor',
      feeTier: 999990,
    });
    expect(v.tvlToken1).toBe(0);
    expect(v.tvlUsd).toBe(0); // untrusted leg0 + honeypot fee → flagged
    expect(v.risky).toBe(true);
  });

  it('flags honeypot static fee tiers (≥5%) but exempts the dynamic-fee sentinel', () => {
    const base = {
      reserve0: 1_000, reserve1: 1_000,
      price0: 1, price1: 1,
      confidence0: 'anchor', confidence1: 'anchor',
    };
    // Garbage sits deliberately just under round gates: USDR/USDT at 99,993
    // (9.9993% — SEVEN pips under the old 10% threshold) and fake-DOT/USDT at
    // 60,001 (6.0001%). Real v4 tiers top out at 1%.
    expect(evaluatePoolTvl({ ...base, feeTier: 99_993 }).risky).toBe(true);
    expect(evaluatePoolTvl({ ...base, feeTier: 60_001 }).risky).toBe(true);
    expect(evaluatePoolTvl({ ...base, feeTier: 50_000 }).risky).toBe(true);
    expect(evaluatePoolTvl({ ...base, feeTier: 49_999 }).risky).toBe(false);
    expect(evaluatePoolTvl({ ...base, feeTier: 10_000 }).risky).toBe(false); // 1% real tier
    // 0x800000 = dynamic-fee sentinel — hook-controlled, not a honeypot.
    expect(evaluatePoolTvl({ ...base, feeTier: 0x800000 }).risky).toBe(false);
  });

  it('flags a corrupt-reserve pool (negative leg) instead of laundering the positive leg (USDC/USDT −1.49B/+1.47B real case)', () => {
    // DiYP v4 flash-accounting drift is symmetric: token0 = −1.49B USDC,
    // token1 = +1.47B USDT on a pool whose own totalValueLockedUSD reads
    // −$17.8M while ALL of v4 mainnet holds ~$469M. Clamping the negative leg
    // and trusting the positive anchor leg produced a fake "$1.47B" trusted
    // leaderboard #1 — the positive leg is exactly as untrustworthy.
    const v = evaluatePoolTvl({
      reserve0: -1_492_303_108, reserve1: 1_474_509_939,
      price0: 1, price1: 1,
      confidence0: 'anchor', confidence1: 'anchor',
      feeTier: 10,
    });
    expect(v.reserveCorrupt).toBe(true);
    expect(v.risky).toBe(true);
    expect(v.tvlUsd).toBe(0);
  });

  it('tolerates an immaterial untrusted leg (dust) without flagging', () => {
    // $2 of unverified dust against $2M trusted → headline is honest.
    const v = evaluatePoolTvl({
      reserve0: 2_000_000, reserve1: 4,
      price0: 1, price1: 0.5,
      confidence0: 'anchor', confidence1: 'external-unverified',
      feeTier: 500,
    });
    expect(v.risky).toBe(false);
    expect(v.tvlUsd).toBe(2_000_000);
  });

  it('treats aggregator-verified legs as trusted (syrupUSDC/USDC-class)', () => {
    const v = evaluatePoolTvl({
      reserve0: 7_000_000, reserve1: 8_000_000,
      price0: 1.09, price1: 1,
      confidence0: 'external-verified', confidence1: 'anchor',
      feeTier: 800,
    });
    expect(v.risky).toBe(false);
    expect(v.tvlUsd).toBeCloseTo(7_000_000 * 1.09 + 8_000_000, 0);
  });
});

describe('buildRiskyPoolUpsert (non-allowlisted pools persist as risky docs)', () => {
  const row = {
    id: '0xD8442C1D563BA9B7DC1BBA16430F6F999C0F8DD26914CA757D43CE88D416EBC7',
    token0: { id: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: '6' },
    token1: { id: '0xED025A9Fe4b30bcd68460BCA42583090c2266468', symbol: 'RPC', decimals: '18' },
    feeTier: '3000',
    tickSpacing: '60',
    tick: '43820',
    sqrtPrice: '708573509531925032708083695616',
    liquidity: '123456789',
    createdAtTimestamp: '1768000000',
    totalValueLockedToken0: '10576.6',
    totalValueLockedToken1: '1000888126.7',
    totalValueLockedUSD: '9858057.39', // fabricated headline — must NOT persist
    volumeUSD: '221975.94',
    feesUSD: '665.92',
    txCount: '42',
    token0Price: '0.0125',
    token1Price: '80',
    poolDayData: [
      { date: '1768000000', volumeUSD: '458.39', feesUSD: '1.37', tvlUSD: '9858057' },
      { date: '1767913600', volumeUSD: '100', feesUSD: '0.3', tvlUSD: '9858057' },
    ],
  };

  it('omits reserves entirely when a leg is negative (corrupt accounting — no fabricated backing)', () => {
    const corrupt = { ...row, totalValueLockedToken0: '-1492303108', totalValueLockedToken1: '1474509939' };
    const doc = buildRiskyPoolUpsert(1, 'uniswap-v4', corrupt);
    expect(doc.metrics.tvlToken0).toBeUndefined();
    expect(doc.metrics.tvlToken1).toBeUndefined();
  });

  it('persists zero trusted TVL + risky flag, but REAL reserves and lifetime volume/fees', () => {
    const doc = buildRiskyPoolUpsert(1, 'uniswap-v4', row);
    expect(doc.poolId).toBe(row.id.toLowerCase());
    expect(doc.metrics.tvlUsd).toBe(0); // never the fabricated $9.86M
    expect(doc.pricing).toEqual({ source: 'none', usedFallback: true });
    // Real reserves survive (clamped) — the position adapter's last-good
    // fallback feeds these to the realizability gate during outages.
    expect(doc.metrics.tvlToken0).toBeCloseTo(10576.6, 1);
    expect(doc.metrics.tvlToken1).toBeCloseTo(1000888126.7, 0);
    // Lifetime cumulative totals, same semantics as the live vanilla query.
    expect(doc.metrics.volumeUsdTotal).toBeCloseTo(221975.94, 2);
    expect(doc.metrics.feesUsdTotal).toBeCloseTo(665.92, 2);
    expect(doc.metrics.volumeUsd24h).toBeCloseTo(458.39, 2);
    expect(doc.metrics.volumeUsd7d).toBeCloseTo(558.39, 2);
    expect(doc.token0.address).toBe(row.token0.id.toLowerCase());
    expect(doc.token1.symbol).toBe('RPC');
  });

  it('drops fee figures above their volume (sentinel-priced dynamic-fee swaps), keeps the rest', () => {
    const sentinel = {
      ...row,
      feeTier: String(0x800000),
      volumeUSD: '1580000000',
      feesUSD: '13260000000', // $13.26B on $1.58B — volume × 8.39
      poolDayData: [
        { date: '1768000000', volumeUSD: '1070000', feesUSD: '8970000', tvlUSD: '1' }, // impossible
        { date: '1767913600', volumeUSD: '100', feesUSD: '0.3', tvlUSD: '1' }, // a real 0.3%
      ],
    };
    const doc = buildRiskyPoolUpsert(1, 'uniswap-v4', sentinel);
    expect(doc.metrics.feesUsdTotal).toBeUndefined();
    expect(doc.metrics.feesUsd24h).toBe(0);
    expect(doc.metrics.feesUsd7d).toBeCloseTo(0.3, 9);
    expect(doc.metrics.volumeUsd24h).toBe(1070000); // volume stays real
  });
});

describe('plausibleFeesUsd (a v4 swap charges at most 100% of its input)', () => {
  it('keeps any fee figure up to its volume, dynamic-fee pools included', () => {
    expect(plausibleFeesUsd(0.0474, 23.72)).toBe(0.0474); // AVAX/PMIR dynamic, priced per swap
    expect(plausibleFeesUsd(100, 100)).toBe(100); // a 100% fee is allowed (MAX_SWAP_FEE, exact-in)
    expect(plausibleFeesUsd(0, 0)).toBe(0);
  });

  it('rejects fees above volume — the 0x800000 sentinel read as an 838.8608% fee', () => {
    expect(plausibleFeesUsd(8_970_000, 1_070_000)).toBeUndefined();
    expect(plausibleFeesUsd(100.01, 100)).toBeUndefined();
    expect(plausibleFeesUsd(1, 0)).toBeUndefined(); // fees without volume
  });

  it('treats a non-finite figure as 0', () => {
    expect(plausibleFeesUsd(Number.NaN, 10)).toBe(0);
  });
});

describe('PoolsSyncService.syncPools coalescing', () => {
  function service() {
    const svc = new PoolsSyncService({} as never, {} as never, {} as never);
    const runs: Array<{ chainId: number; resolve: (v: { upserted: number; skipped: number }) => void }> = [];
    const runSync = vi
      .spyOn(svc as unknown as { runSync: (c: number, p: string) => Promise<unknown> }, 'runSync')
      .mockImplementation(
        (chainId: number) =>
          new Promise((resolve) => {
            runs.push({ chainId, resolve });
          }),
      );
    return { svc, runs, runSync };
  }

  it('returns { upserted: 0, skipped: 0 } at once while a walk for the same chain is in flight', async () => {
    const { svc, runs, runSync } = service();
    const first = svc.syncPools(1, 'uniswap-v4');

    // Resolves without the first walk finishing: a coalesced BullMQ job frees
    // its slot instead of holding it for the whole walk.
    await expect(svc.syncPools(1, 'uniswap-v4')).resolves.toEqual({ upserted: 0, skipped: 0 });
    expect(runSync).toHaveBeenCalledTimes(1);

    runs[0]!.resolve({ upserted: 7, skipped: 2 });
    await expect(first).resolves.toEqual({ upserted: 7, skipped: 2 });
  });

  it('starts a fresh walk once the previous one settled, and never coalesces across chains', async () => {
    const { svc, runs, runSync } = service();
    const a = svc.syncPools(1, 'uniswap-v4');
    const b = svc.syncPools(4663, 'uniswap-v4');
    expect(runSync).toHaveBeenCalledTimes(2);

    runs[0]!.resolve({ upserted: 1, skipped: 0 });
    runs[1]!.resolve({ upserted: 2, skipped: 0 });
    await Promise.all([a, b]);

    const again = svc.syncPools(1, 'uniswap-v4');
    expect(runSync).toHaveBeenCalledTimes(3);
    runs[2]!.resolve({ upserted: 3, skipped: 0 });
    await expect(again).resolves.toEqual({ upserted: 3, skipped: 0 });
  });
});
