import { describe, expect, it, vi } from 'vitest';
import {
  evaluateEarnedTrust,
  parseDenyList,
  poolPriceAgrees,
  resolveTokenTrust,
  summarizeDexPools,
  trustPolicyOf,
  type EarnedTrustEvidence,
} from '../../src/pricing/token-trust.js';
import { TokenTrustService } from '../../src/pricing/token-trust.service.js';
import { isAllowlisted } from '../../src/pricing/token-allowlist.js';
import { isAnchorTokenStandalone } from '../../src/pricing/pricing-policy.js';

/**
 * Fix 4: EARNED trust instead of a hand-kept allowlist. `TOKEN_TRUST_MODE`
 * defaults to `allowlist`, which must answer exactly today's
 * `isAnchorTokenStandalone || isAllowlisted`.
 */

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'; // stable anchor
const CBBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf'; // allowlisted, not an anchor
const BTCB = '0xb0f70c0bd6fd87dbeb7c10dc692a2a6106817072'; // BTC.b on Ethereum: neither
const NOW = Date.UTC(2026, 9, 5, 12);
const fresh = new Date(NOW - 10 * 60_000);

describe('trustPolicyOf', () => {
  it('defaults reproduce today: allowlist mode, no shadow, no guard, empty deny list', () => {
    const p = trustPolicyOf({});
    expect(p.mode).toBe('allowlist');
    expect(p.shadow).toBe(false);
    expect(p.quoteGuard).toBe(false);
    expect(p.deny.size).toBe(0);
    expect(p.quoteMaxAgeMs).toBe(86_400_000);
  });
  it('reads the getters (any case)', () => {
    const p = trustPolicyOf({ tokenTrustMode: 'EARNED', tokenTrustShadow: 'on', priceQuoteGuard: true, tokenTrustDeny: `1:${BTCB}` });
    expect(p.mode).toBe('earned');
    expect(p.shadow).toBe(true);
    expect(p.quoteGuard).toBe(true);
    expect([...p.deny]).toEqual([`1:${BTCB}`]);
  });
});

describe('parseDenyList', () => {
  it('accepts chain-scoped and every-chain entries, lowercased; ignores garbage', () => {
    const set = parseDenyList(` 1:${BTCB.toUpperCase().replace('0X', '0x')}, ${CBBTC}  nope 7:0x12 `);
    expect([...set].sort()).toEqual([`*:${CBBTC}`, `1:${BTCB}`].sort());
  });
});

describe('resolveTokenTrust — allowlist mode (default) is today\'s rule exactly', () => {
  const policy = trustPolicyOf({});
  it('matches isAnchorTokenStandalone || isAllowlisted on anchors, listed and unlisted tokens', () => {
    for (const a of [USDC, CBBTC, BTCB, '0x000000000000000000000000000000000000dead']) {
      expect(resolveTokenTrust(1, a, undefined, policy).trusted).toBe(isAnchorTokenStandalone(1, a) || isAllowlisted(1, a));
    }
    expect(resolveTokenTrust(1, CBBTC, undefined, policy).reason).toBe('allowlist');
    expect(resolveTokenTrust(1, BTCB, undefined, policy).reason).toBe('not-allowlisted');
    expect(resolveTokenTrust(1, USDC, undefined, policy).reason).toBe('anchor');
  });
  it('ignores stored earned verdicts in allowlist mode', () => {
    expect(resolveTokenTrust(1, BTCB, { trustEarned: true, trustEvaluatedAt: fresh }, policy, NOW).trusted).toBe(false);
  });
  it('the EMERGENCY DENY list (env) removes trust from a listed token, never from an anchor; the Mongo flag is earned-mode only', () => {
    const denied = trustPolicyOf({ tokenTrustDeny: `${CBBTC},${USDC}` });
    expect(resolveTokenTrust(1, CBBTC, undefined, denied)).toMatchObject({ trusted: false, reason: 'denied' });
    expect(resolveTokenTrust(1, USDC, undefined, denied)).toMatchObject({ trusted: true, reason: 'anchor' });
    // allowlist mode does not load token documents for trust anywhere but the
    // exclusion scan, so the Mongo flag is ignored everywhere (one answer).
    expect(resolveTokenTrust(1, CBBTC, { trustDenied: true }, policy)).toMatchObject({ trusted: true, reason: 'allowlist' });
    expect(resolveTokenTrust(1, CBBTC, { trustDenied: true }, trustPolicyOf({ tokenTrustMode: 'earned' }))).toMatchObject({
      trusted: false,
      reason: 'denied',
    });
    expect(resolveTokenTrust(43114, CBBTC, undefined, trustPolicyOf({ tokenTrustDeny: `1:${CBBTC}` })).reason).not.toBe('denied');
  });
});

describe('resolveTokenTrust — earned mode', () => {
  const policy = trustPolicyOf({ tokenTrustMode: 'earned' });
  it('anchors stay trusted with no evidence at all', () => {
    expect(resolveTokenTrust(1, USDC, undefined, policy, NOW)).toMatchObject({ trusted: true, reason: 'anchor' });
  });
  it('the committed allowlist alone no longer confers trust', () => {
    expect(resolveTokenTrust(1, CBBTC, undefined, policy, NOW)).toMatchObject({ trusted: false, reason: 'no-evidence' });
  });
  it('a fresh positive verdict is trusted (BTC.b, not on any list)', () => {
    expect(resolveTokenTrust(1, BTCB, { trustEarned: true, trustReason: 'earned', trustEvaluatedAt: fresh }, policy, NOW)).toMatchObject({
      trusted: true,
      reason: 'earned',
    });
  });
  it('a verdict the sweep has not re-derived within the quote window is revoked', () => {
    const old = new Date(NOW - 86_400_000 - 1);
    expect(resolveTokenTrust(1, BTCB, { trustEarned: true, trustEvaluatedAt: old }, policy, NOW).reason).toBe('stale-verdict');
  });
  it('a negative verdict carries its failed criterion', () => {
    expect(resolveTokenTrust(1, BTCB, { trustEarned: false, trustReason: 'single-pool', trustEvaluatedAt: fresh }, policy, NOW).reason).toBe('single-pool');
  });
  it('deny beats an earned verdict', () => {
    expect(resolveTokenTrust(1, BTCB, { trustEarned: true, trustEvaluatedAt: fresh, trustDenied: true }, policy, NOW).reason).toBe('denied');
  });
});

describe('evaluateEarnedTrust — the four criteria', () => {
  const policy = trustPolicyOf({ tokenTrustMode: 'earned' });
  const ok: EarnedTrustEvidence = {
    freshConsensus: true,
    consensusNeedsStale: false,
    dexActive: true,
    dexPoolCount: 3,
    dexOutsideLiquidityUsd: 400_000,
    dexTopCounterUsd: 1_000_000,
    dexTopCounterShare: 0.5,
    hasNonDexSource: true,
  };
  it('all hold → earned', () => expect(evaluateEarnedTrust(ok, policy)).toEqual({ earned: true, reason: 'earned' }));
  it('(a) one source → single-source; consensus only with a stale quote → stale-quote', () => {
    expect(evaluateEarnedTrust({ ...ok, freshConsensus: false }, policy).reason).toBe('single-source');
    expect(evaluateEarnedTrust({ ...ok, freshConsensus: false, consensusNeedsStale: true }, policy).reason).toBe('stale-quote');
  });
  it('(b) no real DEX market (MOW: counter side ~$300 → dexActive false) → no-dex-market', () => {
    expect(evaluateEarnedTrust({ ...ok, dexActive: false }, policy).reason).toBe('no-dex-market');
    expect(evaluateEarnedTrust({ ...ok, dexActive: undefined }, policy).reason).toBe('no-dex-market');
  });
  it('(c) one pool, thin outside it, no deep balanced pool → single-pool', () => {
    expect(
      evaluateEarnedTrust({ ...ok, dexPoolCount: 1, dexOutsideLiquidityUsd: 0, dexTopCounterUsd: 20_000, dexTopCounterShare: 0.5 }, policy).reason,
    ).toBe('single-pool');
  });
  it('(c) two real pools pass; so does enough counter liquidity outside the deepest', () => {
    expect(evaluateEarnedTrust({ ...ok, dexPoolCount: 2, dexOutsideLiquidityUsd: 1_000, dexTopCounterUsd: 0 }, policy).earned).toBe(true);
    expect(evaluateEarnedTrust({ ...ok, dexPoolCount: 1, dexOutsideLiquidityUsd: 60_000, dexTopCounterUsd: 0 }, policy).earned).toBe(true);
  });
  it('(c) single-pool exception: BTC.b/cbBTC — one deep, balanced pool and a non-DEX source agreeing', () => {
    const btcb = { ...ok, dexPoolCount: 1, dexOutsideLiquidityUsd: 0, dexTopCounterUsd: 4_190_000, dexTopCounterShare: 0.49, hasNonDexSource: true };
    expect(evaluateEarnedTrust(btcb, policy).earned).toBe(true);
    // A single-sided seed (100M tokens against a sliver of counter) is not balanced → single-pool.
    expect(evaluateEarnedTrust({ ...btcb, dexTopCounterShare: 0.02 }, policy).reason).toBe('single-pool');
    // Priced only by DEX sources reading that same pool → one on-chain source → single-source (a).
    expect(evaluateEarnedTrust({ ...btcb, hasNonDexSource: false }, policy).reason).toBe('single-source');
    // The exception can be switched off (TOKEN_TRUST_DEEP_POOL_LIQUIDITY_USD=0).
    expect(evaluateEarnedTrust(btcb, trustPolicyOf({ tokenTrustMode: 'earned', tokenTrustDeepPoolLiquidityUsd: 0 })).reason).toBe('single-pool');
  });
});

describe('summarizeDexPools', () => {
  it('counts pools over the per-pool floor and measures liquidity outside the deepest', () => {
    const s = summarizeDexPools(
      [
        { id: '0xA', counterUsd: 4_000_000, liquidityUsd: 8_500_000 },
        { id: '0xb', counterUsd: 50_000, liquidityUsd: 90_000 },
        { id: '0xc', counterUsd: 500, liquidityUsd: 1_000 },
        { id: '0xa', counterUsd: 4_000_000, liquidityUsd: 8_500_000 }, // duplicate id
      ],
      1_000,
    );
    expect(s.dexPoolCount).toBe(2);
    // Only pools that COUNT (≥ the floor, balanced) are liquidity outside the deepest.
    expect(s.dexOutsideLiquidityUsd).toBe(50_000);
    expect(s.dexTopCounterUsd).toBe(4_000_000);
    expect(s.dexTopCounterShare).toBeCloseTo(4 / 8.5, 6);
    expect(s.dexTopPoolId).toBe('0xa');
  });
  it('a single-sided seed or an unknown headline does not count, however much counter it has', () => {
    const s = summarizeDexPools(
      [
        { id: '0xseed', counterUsd: 60_000, liquidityUsd: 11_900_000 }, // 0.5% counter share
        { id: '0xnohead', counterUsd: 60_000, liquidityUsd: 0 },
      ],
      10_000,
    );
    expect(s.dexPoolCount).toBe(0);
    expect(s.dexOutsideLiquidityUsd).toBe(0);
  });
  it('defaults: a pool needs $10,000 of counter side (TOKEN_TRUST_MIN_POOL_LIQUIDITY_USD) and a 25% counter share', () => {
    const p = trustPolicyOf({});
    expect(p.perPoolCounterUsd).toBe(10_000);
    expect(p.deepPoolMinCounterShare).toBe(0.25);
    expect(trustPolicyOf({ tokenTrustMinPoolLiquidityUsd: 2_500 }).perPoolCounterUsd).toBe(2_500);
    // Not the DEX-market floor any more (that one gates dexActive only).
    expect(trustPolicyOf({ dexMarketMinCounterLiquidityUsd: 1_000 }).perPoolCounterUsd).toBe(10_000);
  });
  it('no pools → zeros', () => {
    expect(summarizeDexPools([], 1_000)).toMatchObject({ dexPoolCount: 0, dexOutsideLiquidityUsd: 0, dexTopCounterUsd: 0, dexTopCounterShare: 0 });
  });
});

describe('poolPriceAgrees (pool cross-check, 10%)', () => {
  it('agrees within 10%, disagrees beyond', () => {
    expect(poolPriceAgrees(85_000, 85_500, 1.0)).toBe(true);
    expect(poolPriceAgrees(100, 1, 109)).toBe(true);
    expect(poolPriceAgrees(100, 1, 120)).toBe(false);
    // HPP/AERGO: the stale quote $31,374 vs a pool pricing HPP at ~8e-6 AERGO.
    expect(poolPriceAgrees(31_374, 0.05, 8e-6)).toBe(false);
  });
  it('unknown inputs are not a disagreement', () => {
    expect(poolPriceAgrees(0, 1, 1)).toBe(true);
    expect(poolPriceAgrees(1, 1, 0)).toBe(true);
    expect(poolPriceAgrees(1, 1, Number.NaN)).toBe(true);
  });
});

describe('TokenTrustService', () => {
  it('allowlist mode reads nothing (warm is a no-op)', async () => {
    const findTrustState = vi.fn(async () => new Map());
    const svc = new TokenTrustService({} as never, { findTrustState } as never);
    await svc.warm(1, [BTCB, CBBTC]);
    expect(findTrustState).not.toHaveBeenCalled();
    expect(svc.isTrusted(1, CBBTC)).toBe(true);
    expect(svc.isTrusted(1, BTCB)).toBe(false);
  });
  it('earned mode: warmed verdicts answer synchronously; an unwarmed token fails closed', async () => {
    const findTrustState = vi.fn(async () => new Map([[BTCB, { trustEarned: true, trustEvaluatedAt: new Date() }]]));
    const svc = new TokenTrustService({ tokenTrustMode: 'earned' } as never, { findTrustState } as never);
    expect(svc.trust(1, BTCB).reason).toBe('no-evidence');
    await svc.warm(1, [BTCB, CBBTC]);
    expect(svc.trust(1, BTCB)).toMatchObject({ trusted: true, reason: 'earned' });
    expect(svc.trust(1, CBBTC).reason).toBe('no-evidence'); // listed, but no verdict → not trusted
    await svc.warm(1, [BTCB, CBBTC]);
    expect(findTrustState).toHaveBeenCalledTimes(1); // cached
  });
  it('earned mode: a failed read leaves addresses unloaded (fail closed)', async () => {
    const svc = new TokenTrustService({ tokenTrustMode: 'earned' } as never, { findTrustState: async () => { throw new Error('down'); } } as never);
    await svc.warm(1, [BTCB]);
    expect(svc.isTrusted(1, BTCB)).toBe(false);
  });
});
