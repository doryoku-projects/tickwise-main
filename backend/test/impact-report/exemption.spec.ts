/**
 * HONEYPOT_FEE_ANCHOR_EXEMPT in the impact report: what the exemption KEEPS
 * (anchor/anchor rows and pools with a static fee ≥ 5%), counted whether or
 * not it is on, and — read from the same env the backend reads — which rule
 * the fix 2 counts and the "after" columns apply.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { honeypotAnchorExemptOf, honeypotExemptionPool, parseArgs, renderMarkdown, resolveThresholds } from '../../scripts/valuation-impact-report.mjs';
import { getSqrtRatioAtTick } from '../../src/pricing/tick-math.js';
import { AERGO, ETH, HPP, USDC, openRow, run, tok } from './fixtures.js';

const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const POOL_EX = '0x' + 'f'.repeat(64); // ETH/USDC at 6% — a real (if unusual) anchor/anchor pool
const POOL_EX_THIN = '0x' + '6'.repeat(64); // WETH/USDC at 21%, too small for the Pools page
const exemptPools = [
  {
    chainId: 1, protocol: 'uniswap-v4', poolId: POOL_EX, fee: 60_000,
    token0: { address: ETH, symbol: 'ETH', decimals: 18 }, token1: { address: USDC, symbol: 'USDC', decimals: 6 },
    sqrtPriceX96: getSqrtRatioAtTick(0).toString(), currentTick: 0,
    metrics: { tvlUsd: 0, tvlToken0: 100, tvlToken1: 270_000 }, pricing: { source: 'none', usedFallback: true },
  },
  {
    chainId: 1, protocol: 'uniswap-v4', poolId: POOL_EX_THIN, fee: 210_790,
    token0: { address: USDC, symbol: 'USDC', decimals: 6 }, token1: { address: WETH, symbol: 'WETH', decimals: 18 },
    sqrtPriceX96: getSqrtRatioAtTick(0).toString(), currentTick: 0,
    metrics: { tvlUsd: 0, tvlToken0: 500, tvlToken1: 1 }, pricing: { source: 'none', usedFallback: true },
  },
];
const exemptRows = [
  openRow('900020', {
    poolId: POOL_EX, fee: 60_000, token0: tok(ETH, 'ETH', 18, 2700), token1: tok(USDC, 'USDC', 6, 1),
    amounts: { amount0: '1', amount1: '2700' }, metrics: { underlyingValueUsd: 5400, inRange: true },
  }),
  // A stored address in another case is not an `$in` member: the Mongo clause does not keep it.
  openRow('900021', {
    poolId: POOL_EX, fee: 60_000, token0: tok(ETH, 'ETH', 18, 2700), token1: tok('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'USDC', 6, 1),
    amounts: { amount0: '1', amount1: '0' }, metrics: { underlyingValueUsd: 2700, inRange: true },
  }),
  { ...openRow('5000', { poolId: POOL_EX, fee: 60_000, token0: tok(ETH, 'ETH', 18, 0), token1: tok(USDC, 'USDC', 6, 0), amounts: {}, metrics: {} }), isActive: false },
];

describe('HONEYPOT_FEE_ANCHOR_EXEMPT from the env', () => {
  it('reads it like the backend’s Zod entry (blank = off, any case, trimmed) and refuses anything else', () => {
    expect(honeypotAnchorExemptOf({} as NodeJS.ProcessEnv)).toBe(false);
    expect(honeypotAnchorExemptOf({ HONEYPOT_FEE_ANCHOR_EXEMPT: '' } as NodeJS.ProcessEnv)).toBe(false);
    expect(honeypotAnchorExemptOf({ HONEYPOT_FEE_ANCHOR_EXEMPT: ' OFF ' } as NodeJS.ProcessEnv)).toBe(false);
    expect(honeypotAnchorExemptOf({ HONEYPOT_FEE_ANCHOR_EXEMPT: ' On' } as NodeJS.ProcessEnv)).toBe(true);
    expect(() => honeypotAnchorExemptOf({ HONEYPOT_FEE_ANCHOR_EXEMPT: 'true' } as NodeJS.ProcessEnv)).toThrow(/off or on/);
    expect(resolveThresholds(parseArgs([]), {} as NodeJS.ProcessEnv).honeypotAnchorExempt).toBe(false);
    expect(resolveThresholds(parseArgs([]), { HONEYPOT_FEE_ANCHOR_EXEMPT: 'on' } as NodeJS.ProcessEnv).honeypotAnchorExempt).toBe(true);
  });
});

describe('honeypotExemptionPool', () => {
  const th = resolveThresholds(parseArgs([]), {} as NodeJS.ProcessEnv);
  const ctx = {
    th,
    tokens: new Map<string, Record<string, unknown>>([[ETH, { priceUsd: 2700 }], [USDC, { priceUsd: 1 }], [WETH, { priceUsd: 2700 }], [HPP, { priceUsd: 5 }], [AERGO, { priceUsd: 1 }]]),
    nativeUsd: 2700,
    excludedToday: () => false,
  };
  it('null unless BOTH legs are anchors and the static fee is a honeypot fee', () => {
    expect(honeypotExemptionPool(1, { ...exemptPools[0], fee: 3000 }, ctx)).toBeNull();
    expect(honeypotExemptionPool(1, { ...exemptPools[0], fee: 0x800000 }, ctx)).toBeNull(); // the dynamic-fee flag is not a fee
    expect(honeypotExemptionPool(1, { ...exemptPools[0], token1: { address: HPP } }, ctx)).toBeNull();
    expect(honeypotExemptionPool(1, { ...exemptPools[0], token0: { address: AERGO } }, ctx)).toBeNull();
  });
  it('re-values the pool through evaluatePoolTvl with the exemption; corrupt reserves and unknown reserves stay out', () => {
    expect(honeypotExemptionPool(1, exemptPools[0], ctx)).toMatchObject({ tvlExempt: 100 * 2700 + 270_000, visibleExempt: true, visibleToday: false, reason: undefined });
    expect(honeypotExemptionPool(1, exemptPools[1], ctx)).toMatchObject({ tvlExempt: 500 + 2700, visibleExempt: false });
    expect(honeypotExemptionPool(1, { ...exemptPools[0], metrics: { tvlUsd: 0, tvlToken0: -5, tvlToken1: 270_000 } }, ctx)).toMatchObject({ tvlExempt: 0, visibleExempt: false, reason: 'reserve-corrupt' });
    expect(honeypotExemptionPool(1, { ...exemptPools[0], metrics: { tvlUsd: 0 } }, ctx)).toMatchObject({ visibleExempt: false, reason: 'reserves-unknown' });
    expect(honeypotExemptionPool(1, exemptPools[0], { ...ctx, excludedToday: () => true })).toMatchObject({ visibleExempt: false });
  });
});

describe('the exemption, end to end', () => {
  it('off (default): fix 2 still counts the anchor/anchor rows, and the report says what the exemption would keep', async () => {
    const { summary } = await run(['--pace-ms=0', '--include-closed'], { extraPools: exemptPools, extraPositions: exemptRows });
    const c = summary.chains[0];
    expect(c.feeExcluded.rows).toBe(3); // 366810 (AERGO/HPP) + 900020 + 900021
    expect(c.feeExcluded.closedRows).toBe(2); // the fixture's HPP closed row + 5000
    expect(c.honeypotExempt).toMatchObject({ rows: 1, valueUsd: 5400, landingRows: 1, landingValueUsd: 5400, closedRows: 1 });
    expect(c.honeypotExempt).toMatchObject({ pools: 2, poolsVisible: 1, poolsVisibleToday: 0, poolsReservesUnknown: 0, poolsRisky: 0 });
    expect(c.honeypotExempt.poolsTvlUsd).toBeCloseTo(540_000 + 3200, 6);
    expect(c.honeypotExempt.poolsVisibleTvlUsd).toBeCloseTo(540_000, 6);
    expect(summary.top.honeypotExemptRows.map((r: { positionId: string }) => r.positionId)).toEqual(['900020']);
    expect(summary.top.honeypotExemptPools.map((r: { poolId: string }) => r.poolId).sort()).toEqual([POOL_EX, POOL_EX_THIN].sort());
    // Fix 4's projection keeps the pools-sync rule as configured: the 6% pool stays risky with the exemption off.
    expect(summary.top.poolsAppear.map((r: { poolId: string }) => r.poolId)).not.toContain(POOL_EX);
    const md = renderMarkdown(summary);
    expect(md).toContain('### What `HONEYPOT_FEE_ANCHOR_EXEMPT=on` keeps (off in this env — counted, not applied)');
    expect(md).toContain('Open rows kept: 1 ($5.4k; 1 on the landing view today, $5.4k); closed rows kept: 1.');
    expect(md).toContain('| 1 | 900020 | ETH/USDC | 6.00% | $5.4k | yes |');
  });

  it('counts the exempt pools that stay out for another reason (corrupt reserves, none stored)', async () => {
    const corrupt = { ...exemptPools[0], poolId: '0x' + '4'.repeat(64), metrics: { tvlUsd: 0, tvlToken0: -1, tvlToken1: 270_000 } };
    const unknown = { ...exemptPools[0], poolId: '0x' + '3'.repeat(64), metrics: { tvlUsd: 0 } };
    const { summary } = await run(['--pace-ms=0'], { extraPools: [...exemptPools, corrupt, unknown] });
    expect(summary.chains[0].honeypotExempt).toMatchObject({ pools: 4, poolsVisible: 1, poolsRisky: 1, poolsReservesUnknown: 1 });
    const notes = Object.fromEntries(summary.top.honeypotExemptPools.map((r: { poolId: string; reason?: string }) => [r.poolId, r.reason]));
    expect(notes).toMatchObject({ [corrupt.poolId]: 'reserve-corrupt', [unknown.poolId]: 'reserves-unknown' });
  });

  it('on, pool already valued (stored with the exemption): no fix 4 change, but the pool still gets its CSV row', async () => {
    const valued = { ...exemptPools[0], metrics: { tvlUsd: 540_000, tvlToken0: 100, tvlToken1: 270_000 }, pricing: { source: 'native-anchor', usedFallback: false } };
    const outDir = mkdtempSync(path.join(os.tmpdir(), 'impact-exempt-'));
    const { summary } = await run(['--pace-ms=0'], { outDir, extraPools: [valued], env: { HONEYPOT_FEE_ANCHOR_EXEMPT: 'on' } });
    expect(summary.chains[0].honeypotExempt).toMatchObject({ pools: 1, poolsVisible: 1, poolsVisibleToday: 1 });
    expect(summary.top.poolsAppear.map((r: { poolId: string }) => r.poolId)).not.toContain(POOL_EX);
    expect(summary.top.poolsDisappear.map((r: { poolId: string }) => r.poolId)).not.toContain(POOL_EX);
    const row = readFileSync(path.join(outDir, 'pools.csv'), 'utf8').split('\n').find((l) => l.includes(POOL_EX));
    expect(row).toMatch(/,none,.*,540000,true$/);
  });

  it('off, pool already valued (stored while the exemption was on): the projection applies the fee rule — it is risky after (lose), not kept', async () => {
    const valued = { ...exemptPools[0], metrics: { tvlUsd: 540_000, tvlToken0: 100, tvlToken1: 270_000 }, pricing: { source: 'native-anchor', usedFallback: false } };
    const outDir = mkdtempSync(path.join(os.tmpdir(), 'impact-exempt-off-'));
    const { summary } = await run(['--pace-ms=0'], { outDir, extraPools: [valued] });
    expect(summary.thresholds.honeypotAnchorExempt).toBe(false);
    // Counted as what the exemption would keep, visible today…
    expect(summary.chains[0].honeypotExempt).toMatchObject({ pools: 1, poolsVisible: 1, poolsVisibleToday: 1 });
    // …but with the exemption off the pools sync's fee rule makes it risky: it leaves the Pools page, in both trust projections.
    expect(summary.top.poolsDisappear.map((r: { poolId: string }) => r.poolId)).toContain(POOL_EX);
    expect(summary.top.poolsDisappearCombined.map((r: { poolId: string }) => r.poolId)).toContain(POOL_EX);
    const csv = readFileSync(path.join(outDir, 'pools.csv'), 'utf8').split('\n');
    const header = csv[0]!.split(',');
    const row = csv.find((l) => l.includes(POOL_EX))!.split(',');
    const col = (name: string) => row[header.indexOf(name)];
    expect(col('change')).toBe('disappear');
    expect(col('tvlAfterUsd')).toBe('0');
    expect(col('visibleAfter')).toBe('false');
    expect(col('changeCombined')).toBe('disappear');
    expect(col('honeypotExemptTvlUsd')).toBe('540000'); // what the exemption WOULD keep
  });

  it('on: fix 2 stops counting the rows it keeps; the pools it re-values are the exemption section\'s, not a trust-mode effect', async () => {
    const { summary } = await run(['--pace-ms=0', '--include-closed'], { extraPools: exemptPools, extraPositions: exemptRows, env: { HONEYPOT_FEE_ANCHOR_EXEMPT: 'on' } });
    const c = summary.chains[0];
    expect(c.feeExcluded.rows).toBe(2); // 900020 is kept; 900021's mixed-case address is not an `$in` member
    expect(c.feeExcluded.closedRows).toBe(1);
    expect(c.honeypotExempt.rows).toBe(1); // what it keeps is counted the same either way
    // ETH/USDC: both legs anchors, trusted in every mode — the trust modes change
    // nothing about it (no double count under fix 4); the exemption section
    // reports it on the Pools page.
    expect(summary.top.poolsAppear.map((r: { poolId: string }) => r.poolId)).not.toContain(POOL_EX);
    expect(summary.top.poolsAppearCombined.map((r: { poolId: string }) => r.poolId)).not.toContain(POOL_EX);
    expect(c.honeypotExempt).toMatchObject({ pools: 2, poolsVisible: 1 });
    // The kept row is on the landing view after fixes 2 + 3 + 4 (it was hidden by fix 2 with the exemption off).
    expect(summary.top.landingAfter.map((r: { positionId: string }) => r.positionId)).toContain('900020');
    const off = await run(['--pace-ms=0'], { extraPools: exemptPools, extraPositions: exemptRows });
    expect(off.summary.top.landingAfter.map((r: { positionId: string }) => r.positionId)).not.toContain('900020');
    expect(renderMarkdown(summary)).toContain('(on in this env — applied to fix 2 above; the pools it re-values are counted here, not under fix 4)');
    expect(summary.thresholds.honeypotAnchorExempt).toBe(true);
  });
});
