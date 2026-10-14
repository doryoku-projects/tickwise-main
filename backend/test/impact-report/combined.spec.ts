/**
 * TOKEN_TRUST_MODE=combined (anchor || allowlisted || a fresh earned verdict)
 * in the impact report: per token through the REAL `resolveTokenTrust` with
 * `trustPolicyOf({tokenTrustMode: 'combined'})`, and end to end over the
 * shared fixture — the third column next to today (allowlist) and earned.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs, projectedReason, projectedTrusted, renderMarkdown, resolveThresholds, tokenTrust, trustChange } from '../../scripts/valuation-impact-report.mjs';
import { resolveTokenTrust } from '../../src/pricing/token-trust.js';
import { getSqrtRatioAtTick } from '../../src/pricing/tick-math.js';
import { prng } from '../support/mini-mongo.js';
import { BTCB, CBBTC, DAY, HPP, LISTED_NOMKT, NOW, POOL_BTC, POOL_LISTED, POOL_THALES, THALES, USDC, fresh, openRow, run, tok } from './fixtures.js';

const th = resolveThresholds(parseArgs([]), {} as NodeJS.ProcessEnv);
const UNLISTED = '0x000000000000000000000000000000000000beef';
const stale = new Date(NOW - 3 * DAY);

describe('combined trust, per token (the real rule)', () => {
  it('the policy is trustPolicyOf in combined mode, with exactly earned mode’s thresholds', () => {
    expect(th.combined.mode).toBe('combined');
    expect({ ...th.combined, mode: 'earned' }).toEqual(th.earned);
  });

  it('a listed token with no verdict: trusted by the allowlist (earned cannot decide it yet)', () => {
    const t = { address: CBBTC, priceUsd: 86_300, dexActive: true, priceSources: ['defillama', 'dexscreener'], priceConfidence: 'external-verified' };
    const tr = tokenTrust(1, CBBTC, t, th, NOW);
    expect(tr.combined).toEqual(resolveTokenTrust(1, CBBTC, {}, th.combined, NOW));
    expect(tr.combined).toMatchObject({ trusted: true, reason: 'allowlist', mode: 'combined' });
    expect(projectedTrusted(tr, 'combined')).toBe(true);
    expect(projectedTrusted(tr, 'earned')).toBeNull();
  });

  it('a listed token that has earned trust reports earned (the evidence-backed fact first)', () => {
    const tr = tokenTrust(1, CBBTC, { trustEarned: true, trustReason: 'earned', trustEvaluatedAt: fresh }, th, NOW);
    expect(tr.combined.reason).toBe('earned');
    expect(projectedReason(tr, 'combined')).toBe('earned');
  });

  it('a listed token that FAILED earned trust keeps the allowlist (combined only adds trust)', () => {
    const tr = tokenTrust(1, THALES, { dexActive: false, trustEarned: false, trustReason: 'no-dex-market', trustEvaluatedAt: fresh }, th, NOW);
    expect(projectedTrusted(tr, 'earned')).toBe(false);
    expect(projectedTrusted(tr, 'combined')).toBe(true);
    expect(trustChange(tr.today.trusted, projectedTrusted(tr, 'combined'), false)).toBe('none');
    expect(trustChange(tr.today.trusted, projectedTrusted(tr, 'earned'), false)).toBe('lose');
  });

  it('an unlisted token: combined is earned (BTC.b gains; no verdict + no DEX market is a predicted failure)', () => {
    const earned = tokenTrust(1, BTCB, { trustEarned: true, trustReason: 'earned', trustEvaluatedAt: fresh }, th, NOW);
    expect(projectedTrusted(earned, 'combined')).toBe(true);
    expect(trustChange(earned.today.trusted, projectedTrusted(earned, 'combined'), false)).toBe('gain');
    const dead = tokenTrust(1, UNLISTED, { address: UNLISTED, priceUsd: 1, dexActive: false }, th, NOW);
    expect(dead.combined.reason).toBe('no-evidence');
    expect(projectedTrusted(dead, 'combined')).toBe(false);
    expect(projectedReason(dead, 'combined')).toBe('no-dex-market (predicted)');
    const unknown = tokenTrust(1, UNLISTED, { address: UNLISTED, priceUsd: 1, dexActive: true, priceSources: ['defillama', 'dexscreener'], priceConfidence: 'external-verified' }, th, NOW);
    expect(projectedTrusted(unknown, 'combined')).toBeNull(); // (c)/(d) need the sweep's own evidence
  });

  it('a stale verdict is read as of its sweep for an unlisted token; for a listed one the allowlist stands', () => {
    const unlisted = tokenTrust(1, BTCB, { trustEarned: true, trustReason: 'earned', trustEvaluatedAt: stale }, th, NOW);
    expect(unlisted.combined.reason).toBe('stale-verdict');
    expect(unlisted.combinedStale).toBe(true);
    expect(projectedTrusted(unlisted, 'combined')).toBe(true); // as of its sweep
    const listed = tokenTrust(1, CBBTC, { trustEarned: false, trustReason: 'single-source', trustEvaluatedAt: stale }, th, NOW);
    expect(listed.combined.reason).toBe('allowlist');
    expect(listed.combinedStale).toBe(false);
    expect(projectedTrusted(listed, 'combined')).toBe(true);
  });

  it('the hand-set trustDenied flag removes a listed token’s trust in combined (today ignores the flag)', () => {
    const tr = tokenTrust(1, CBBTC, { trustDenied: true }, th, NOW);
    expect(tr.today.trusted).toBe(true);
    expect(tr.combined.reason).toBe('denied');
    expect(trustChange(tr.today.trusted, projectedTrusted(tr, 'combined'), false)).toBe('lose');
    expect(tr.combinedUnswept.reason).toBe('denied'); // no sweep clears the flag
  });

  it('a leg no sweep evaluates keeps exactly its allowlist trust (its verdict ages out)', () => {
    expect(tokenTrust(1, LISTED_NOMKT, {}, th, NOW).combinedUnswept).toMatchObject({ trusted: true, reason: 'allowlist' });
    expect(tokenTrust(1, BTCB, { trustEarned: true, trustReason: 'earned', trustEvaluatedAt: fresh }, th, NOW).combinedUnswept).toMatchObject({ trusted: false, reason: 'no-evidence' });
  });

  it('over 2,000 random tokens: combined trusts what today or earned trusts, and only that (the hand-set deny flag aside)', () => {
    const rnd = prng(31);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
    const addrs = [CBBTC, HPP, THALES, LISTED_NOMKT, BTCB, UNLISTED, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'];
    let gains = 0;
    for (let i = 0; i < 2000; i++) {
      const address = pick(addrs);
      const t: Record<string, unknown> = { address };
      if (rnd() < 0.7) t.dexActive = pick([true, false]);
      if (rnd() < 0.7) t.priceConfidence = pick(['external-verified', 'external-unverified']);
      if (rnd() < 0.7) t.priceSources = pick([['defillama', 'dexscreener'], ['dexscreener'], ['dia']]);
      if (rnd() < 0.6) {
        t.trustEarned = rnd() < 0.5;
        t.trustReason = t.trustEarned ? 'earned' : pick(['single-source', 'no-dex-market', 'single-pool', 'stale-quote']);
        if (rnd() < 0.9) t.trustEvaluatedAt = new Date(NOW - Math.floor(rnd() * 3 * DAY));
      }
      if (rnd() < 0.05) t.trustDenied = true;
      const tr = tokenTrust(1, address, t, th, NOW);
      const today = tr.today.trusted;
      const earned = projectedTrusted(tr, 'earned');
      const combined = projectedTrusted(tr, 'combined');
      if (t.trustDenied === true && tr.combined.reason === 'denied') {
        expect(combined).toBe(false);
        continue;
      }
      if (today || earned === true) expect(combined, JSON.stringify(t)).toBe(true);
      if (combined === true) expect(today || earned === true, JSON.stringify(t)).toBe(true);
      if (!today) expect(combined, JSON.stringify(t)).toBe(earned);
      if (combined === true && !today) gains++;
    }
    expect(gains).toBeGreaterThan(20);
  });
});

// Two allowlisted, non-anchor legs whose pool trades far from their market
// prices (pool at tick 0 = 1:1; cbBTC $86,300 vs HPP $31,375): combined runs
// the pools sync's 10% pool-price check on LISTED legs too.
const POOL_CROSS = '0x' + '9'.repeat(64);
const crossPool = {
  chainId: 1, protocol: 'uniswap-v4', poolId: POOL_CROSS, fee: 3000,
  token0: { address: CBBTC, symbol: 'cbBTC', decimals: 8 }, token1: { address: HPP, symbol: 'HPP', decimals: 8 },
  sqrtPriceX96: getSqrtRatioAtTick(0).toString(), currentTick: 0,
  metrics: { tvlUsd: 5_000_000, tvlToken0: 10, tvlToken1: 10 }, pricing: { source: 'external', usedFallback: false },
};

describe('combined trust, end to end', () => {
  it('THALES and the never-swept listed LST keep their pools and rows; BTC.b/cbBTC still appears', async () => {
    const { summary } = await run(['--pace-ms=0']);
    const c = summary.chains[0];
    const tc = c.trustCombined;
    expect(tc.poolsAppear).toBe(1);
    expect(summary.top.poolsAppearCombined.map((r: { poolId: string }) => r.poolId)).toEqual([POOL_BTC]);
    expect(tc.poolsDisappear).toBe(0); // earned loses POOL_LISTED + POOL_THALES (report.spec)
    expect(c.trust.poolsDisappear).toBe(2);
    expect(tc.poolsLoseNeverSwept).toBe(0);
    expect(tc.positionsNewlyExcluded).toBe(0); // earned: 108486 (THALES) + 366810 (HPP)
    expect(c.trust.positionsNewlyExcluded).toBe(2);
    expect(tc.tokensGain).toBe(1);
    expect(tc.tokensLose).toBe(0);
    expect(summary.top.trustGainCombined.map((r: { address: string }) => r.address)).toEqual([BTCB]);
    // Pools page: today 3 (ETH, LST, THALES), earned 2, combined 4 (+ BTC.b/cbBTC).
    expect([c.trust.poolsVisibleToday, c.trust.poolsVisibleAfter, tc.poolsVisibleAfter]).toEqual([3, 2, 4]);
    // Held non-anchor tokens trusted, by mode.
    expect(c.trust.heldToday).toBe(4);
    expect(c.trust.heldCombined).toBe(5);
  });

  it('a listed pair whose pool diverges from its legs’ prices leaves the Pools page under combined only through the pool-price check', async () => {
    const { summary } = await run(['--pace-ms=0'], { extraPools: [crossPool] });
    const gone = (rows: Array<{ poolId: string; reason?: string }>) => Object.fromEntries(rows.map((r) => [r.poolId, r.reason]));
    expect(gone(summary.top.poolsDisappearCombined)[POOL_CROSS]).toBe('pool-price-diverges');
    expect(gone(summary.top.poolsDisappear)[POOL_CROSS]).toBe('token1-single-source (predicted)'); // earned: HPP is a single DIA source
    expect(gone(summary.top.poolsDisappearCombined)[POOL_THALES]).toBeUndefined();
    expect(gone(summary.top.poolsDisappearCombined)[POOL_LISTED]).toBeUndefined();
  });

  it('a never-swept listed leg keeps its pool under combined — unless someone flagged it by hand', async () => {
    const { summary } = await run(['--pace-ms=0'], { tokenPatch: { [LISTED_NOMKT]: { trustDenied: true } } });
    const gone = Object.fromEntries(summary.top.poolsDisappearCombined.map((r: { poolId: string; reason?: string }) => [r.poolId, r.reason]));
    expect(gone[POOL_LISTED]).toBe('token0-denied');
    expect(summary.chains[0].trustCombined.poolsLoseNeverSwept).toBe(1);
  });

  it('a hand-flagged listed token is denied under combined: its pool goes, its rows enter the exclusion', async () => {
    const { summary } = await run(['--pace-ms=0'], { tokenPatch: { [CBBTC]: { trustDenied: true } } });
    const c = summary.chains[0];
    expect(summary.top.trustLoseCombined.map((r: { address: string; reason: string }) => [r.address, r.reason])).toEqual([[CBBTC, 'denied']]);
    expect(summary.top.newlyExcludedCombined.map((r: { positionId: string }) => r.positionId)).toEqual(['371154']);
    expect(c.trustCombined.poolsAppear).toBe(0); // BTC.b/cbBTC no longer appears
    expect(c.trust.positionsNewlyExcluded).toBe(3); // earned honours the flag too
  });

  it('the landing view after fixes 2 + 3 + 4 has its combined column (THALES rows stay excluded only under earned)', async () => {
    const { summary } = await run(['--pace-ms=0', '--landing-min-value=0']);
    const c = summary.chains[0];
    const ids = (rows: Array<{ positionId: string }>) => rows.map((r) => r.positionId).sort();
    expect(ids(summary.top.landingAfter)).not.toContain('108486');
    expect(ids(summary.top.landingAfterCombined)).toContain('108486');
    expect(c.afterCombined.landingRows).toBe(c.after.landingRows + 1);
    expect(summary.landingTopCombined.n).toBe(summary.landingTop.n);
  });

  it('a listed leg the earned sweep has failed keeps showing but loses the exemption under earned only', async () => {
    // cbBTC: a fresh FAILED verdict, but a real DEX market (not excluded) — earned untrusts it, combined keeps the listing.
    const { summary } = await run(['--pace-ms=0'], { tokenPatch: { [CBBTC]: { trustEarned: false, trustReason: 'single-pool', trustEvaluatedAt: fresh } } });
    const c = summary.chains[0];
    expect(c.trust.positionsExemptionLost).toBe(1); // 371154 (BTC.b/cbBTC)
    expect(c.trustCombined.positionsExemptionLost).toBe(0);
  });

  it('a pool only combined moves gets its own CSV row (earned: no verdict, no change; combined: earned BTC.b + listed cbBTC → priced → appears)', async () => {
    // cbBTC with no verdict: earned cannot decide the BTC.b/cbBTC pool, combined
    // trusts cbBTC by the listing and BTC.b by its earned verdict — BTC.b is
    // untrusted TODAY, so this pool really is newly priceable under combined.
    const outDir = mkdtempSync(path.join(os.tmpdir(), 'impact-combined-only-'));
    const { summary } = await run(['--pace-ms=0'], {
      outDir,
      tokenPatch: { [CBBTC]: { trustEarned: undefined, trustReason: undefined, trustEvaluatedAt: undefined } },
    });
    expect(summary.top.poolsAppear.map((r: { poolId: string }) => r.poolId)).not.toContain(POOL_BTC);
    const appeared = summary.top.poolsAppearCombined.find((r: { poolId: string }) => r.poolId === POOL_BTC);
    expect(appeared?.tvlAfterUsd).toBeCloseTo(50 * 86_000 + 50 * 86_300, 0);
    const row = readFileSync(path.join(outDir, 'pools.csv'), 'utf8').split('\n').find((l) => l.includes(POOL_BTC));
    // earned: no change (cbBTC has no verdict; BTC.b was untrusted today, so nothing to undo); combined: appears.
    expect(row).toMatch(/,none,no-verdict,.*,appear,/);
  });

  it('a pool whose legs are trusted today AND under combined, left unpriced by the sync, does NOT appear: the mode changes nothing about it', async () => {
    // cbBTC (listed) / USDC (anchor), stored `usedFallback: true`: risky for a
    // reason trust does not touch (a pricePool fallback). The real pools sync
    // values it under combined exactly as today (combined only ADDS the
    // pool-price check, which can only remove TVL). It used to be re-valued at
    // optimistic confidences and counted as a combined gain.
    const POOL_ONLY = '0x' + '5'.repeat(64);
    const tick = Math.round(Math.log(86_300 / 100) / Math.log(1.0001)); // USDC per cbBTC, decimals 8 vs 6
    const pool = {
      chainId: 1, protocol: 'uniswap-v4', poolId: POOL_ONLY, fee: 3000,
      token0: { address: CBBTC, symbol: 'cbBTC', decimals: 8 }, token1: { address: USDC, symbol: 'USDC', decimals: 6 },
      sqrtPriceX96: getSqrtRatioAtTick(tick).toString(), currentTick: tick,
      metrics: { tvlUsd: 0, tvlToken0: 1, tvlToken1: 86_300 }, pricing: { source: 'external', usedFallback: true },
    };
    const base = await run(['--pace-ms=0']);
    const { summary } = await run(['--pace-ms=0'], { extraPools: [pool] });
    const ids = (rows: Array<{ poolId: string }>) => rows.map((r) => r.poolId);
    expect(ids(summary.top.poolsAppearCombined)).not.toContain(POOL_ONLY);
    expect(ids(summary.top.poolsAppear)).not.toContain(POOL_ONLY);
    expect(summary.chains[0].trustCombined.poolsAppear).toBe(base.summary.chains[0].trustCombined.poolsAppear);
    expect(summary.chains[0].trust.poolsAppear).toBe(base.summary.chains[0].trust.poolsAppear);
  });

  it('TOKEN_TRUST_DENY (env) excludes in every mode — a denied leg with no token row stays off the combined landing view too', async () => {
    const DENIED = '0x00000000000000000000000000000000000dead1';
    const row = openRow('900040', {
      poolId: '0x' + '8'.repeat(64), token0: tok(DENIED, 'DND', 18, 10), token1: tok(USDC, 'USDC', 6, 1),
      amounts: { amount0: '100', amount1: '0' }, metrics: { underlyingValueUsd: 1000, inRange: true },
    });
    const { summary } = await run(['--pace-ms=0'], { extraPositions: [row], env: { TOKEN_TRUST_DENY: `1:${DENIED}` } });
    const ids = (rows: Array<{ positionId: string }>) => rows.map((r) => r.positionId);
    expect(ids(summary.top.landingToday)).not.toContain('900040');
    expect(ids(summary.top.landingAfter)).not.toContain('900040');
    expect(ids(summary.top.landingAfterCombined)).not.toContain('900040');
    const clean = await run(['--pace-ms=0'], { extraPositions: [row] });
    expect(ids(clean.summary.top.landingToday)).toContain('900040'); // the deny is what hides it
  });

  it('Markdown: a today / earned / combined table and a combined section; CSVs carry the combined verdicts', async () => {
    const outDir = mkdtempSync(path.join(os.tmpdir(), 'impact-combined-'));
    const { summary } = await run(['--pace-ms=0'], { outDir });
    const md = renderMarkdown(summary);
    expect(md).toContain('| Today (`allowlist`) | `earned` | `combined` |');
    expect(md).toContain('| Pools on the Pools page (TVL ≥ $10.0k) | 3 | 2 | 4 |');
    expect(md).toContain('### Combined (`TOKEN_TRUST_MODE=combined`)');
    expect(md).toContain('After fixes 2 + 3 + 4, combined trust');
    const tokensCsv = readFileSync(path.join(outDir, 'tokens.csv'), 'utf8').trim().split('\n');
    const header = tokensCsv[0]!.split(',');
    const col = (name: string) => header.indexOf(name);
    expect(header.slice(0, 26)).toEqual(['chainId', 'address', 'symbol', 'priceUsd', 'priceConfidence', 'priceSources', 'pricedAt', 'anchor', 'allowlisted', 'trustToday', 'trustTodayReason', 'trustEarned', 'trustEarnedReason', 'trustEarnedNow', 'trustEvaluatedAt', 'trustChange', 'quoteStatus', 'quoteReason', 'guardUsd', 'diaStatus', 'diaAgeDays', 'diaVolumeUsd', 'openPositions', 'exposureUsd', 'landingPositions', 'landingExposureUsd']);
    const thales = tokensCsv.find((l) => l.includes(THALES))!.split(',');
    expect([thales[col('trustEarned')], thales[col('trustCombined')], thales[col('trustCombinedReason')], thales[col('trustChange')], thales[col('trustCombinedChange')]]).toEqual(['false', 'true', 'allowlist', 'lose', 'none']);
    const poolsCsv = readFileSync(path.join(outDir, 'pools.csv'), 'utf8');
    expect(poolsCsv.split('\n')[0]).toContain(',changeCombined,reasonCombined,tvlAfterCombinedUsd,visibleAfterCombined,');
    expect(poolsCsv).toMatch(new RegExp(`${POOL_BTC},BTC.b/cbBTC,100,appear,.*,appear,`));
  });
});
