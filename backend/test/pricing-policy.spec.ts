import { describe, expect, it } from 'vitest';
import {
  classifyAnchor,
  getPricingPolicy,
  isAnchorToken,
  isAnchorTokenStandalone,
} from '../src/pricing/pricing-policy.js';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const WBTC = '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599';
const RANDOM = '0x1234567890123456789012345678901234567890';
const NATIVE = '0x0000000000000000000000000000000000000000';

describe('getPricingPolicy', () => {
  it('returns undefined for unknown chain', () => {
    expect(getPricingPolicy(999_999)).toBeUndefined();
  });

  it('returns policy with normalized anchors for Ethereum', () => {
    const policy = getPricingPolicy(1);
    expect(policy).toBeDefined();
    expect(policy?.anchors.wrappedNative).toBe(WETH);
    expect(policy?.anchors.native).toBe(NATIVE);
    expect(policy?.anchors.stablecoins).toContain(USDC);
    expect(policy?.anchors.trustedTokens).toContain(WBTC);
  });

  it('enables derivation for known protocol with pool-ratio support', () => {
    const policy = getPricingPolicy(1, 'uniswap-v4');
    expect(policy?.derivation.enabled).toBe(true);
  });

  it('disables derivation for unknown protocol on a known chain', () => {
    const policy = getPricingPolicy(1, 'made-up-amm');
    expect(policy?.derivation.enabled).toBe(false);
  });

  it('keeps derivation enabled at chain-level when protocol is omitted', () => {
    const policy = getPricingPolicy(1);
    expect(policy?.derivation.enabled).toBe(true);
  });

  it('never allows current quotes to flow into the historical cache', () => {
    const policy = getPricingPolicy(1, 'uniswap-v4');
    expect(policy?.cache.allowCurrentToHistorical).toBe(false);
  });

  it('uses stricter override-verified threshold than fill-missing threshold', () => {
    const policy = getPricingPolicy(1, 'uniswap-v4');
    if (!policy) throw new Error('policy missing');
    expect(policy.derivation.minTvlUsdOverrideVerified).toBeGreaterThan(
      policy.derivation.minTvlUsdOverrideUnverified,
    );
    expect(policy.derivation.minTvlUsdOverrideUnverified).toBeGreaterThan(
      policy.derivation.minTvlUsdFillMissing,
    );
  });
});

describe('classifyAnchor / isAnchorToken', () => {
  const policy = getPricingPolicy(1, 'uniswap-v4');
  if (!policy) throw new Error('policy missing for Ethereum');

  it('classifies USDC as stable', () => {
    expect(classifyAnchor(policy, USDC)).toBe('stable');
    expect(isAnchorToken(policy, USDC)).toBe(true);
  });

  it('classifies WETH as native', () => {
    expect(classifyAnchor(policy, WETH)).toBe('native');
    expect(isAnchorToken(policy, WETH)).toBe(true);
  });

  it('classifies native zero address as native', () => {
    expect(classifyAnchor(policy, NATIVE)).toBe('native');
  });

  it('classifies WBTC as trusted', () => {
    expect(classifyAnchor(policy, WBTC)).toBe('trusted');
    expect(isAnchorToken(policy, WBTC)).toBe(true);
  });

  it('returns none for a random address', () => {
    expect(classifyAnchor(policy, RANDOM)).toBe('none');
    expect(isAnchorToken(policy, RANDOM)).toBe(false);
  });

  it('classification is case-insensitive', () => {
    expect(classifyAnchor(policy, WETH.toUpperCase())).toBe('native');
    expect(classifyAnchor(policy, USDC.toUpperCase())).toBe('stable');
  });
});

describe('isAnchorTokenStandalone', () => {
  it('agrees with policy-based classification', () => {
    expect(isAnchorTokenStandalone(1, USDC)).toBe(true);
    expect(isAnchorTokenStandalone(1, WETH)).toBe(true);
    expect(isAnchorTokenStandalone(1, WBTC)).toBe(true);
    expect(isAnchorTokenStandalone(1, RANDOM)).toBe(false);
  });

  it('returns false for unknown chain', () => {
    expect(isAnchorTokenStandalone(999_999, USDC)).toBe(false);
  });
});
