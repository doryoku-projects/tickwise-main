import { describe, expect, it } from 'vitest';
import {
  formatTokenAmount,
  parseAcceptedTokens,
  usdMinorToTokenBaseUnits,
  PAYMENT_TOKEN_REGISTRY,
  baseUnitsToUsdMinor,
} from '../src/config/payment-tokens.config.js';


/**
 * The money-correctness core of the crypto rail. A wrong answer here is
 * not a bad number on a screen — it is a payment that is invisible, mis-sized by
 * orders of magnitude, or settled at the wrong amount. Every assertion is
 * mutation-tested (see the shell block in the session), because "it passes" is
 * not evidence when the failure mode is silent.
 */

describe('parseAcceptedTokens — the accept-list', () => {
  it('resolves a registry ref by symbol+chain', () => {
    const [t] = parseAcceptedTokens('USDC:8453');
    expect(t).toMatchObject({ chainId: 8453, symbol: 'USDC', decimals: 6, stable: true });
    expect(t.address).toBe(PAYMENT_TOKEN_REGISTRY['USDC:8453'].address);
  });

  it('accepts a fully-specified custom token', () => {
    const [t] = parseAcceptedTokens('MYUSD:8453:0x1111111111111111111111111111111111111111:6');
    expect(t).toMatchObject({ chainId: 8453, symbol: 'MYUSD', decimals: 6, stable: true });
    expect(t.address).toBe('0x1111111111111111111111111111111111111111');
  });

  it('marks a `volatile` custom token as non-stable', () => {
    const [t] = parseAcceptedTokens('WETH:1:0x2222222222222222222222222222222222222222:18:volatile');
    expect(t.stable).toBe(false);
  });

  it('THROWS on a custom token with no decimals — there is no safe default', () => {
    // MUTATION: default decimals to 18 → this stops throwing, and a 6-decimal
    // token silently becomes invisible (we look for 10^12× the real amount).
    expect(() => parseAcceptedTokens('MYUSD:8453:0x1111111111111111111111111111111111111111')).toThrow(
      /decimals/i,
    );
  });

  it('THROWS on an unknown registry ref rather than skipping it', () => {
    // A silently-dropped payment method is discovered by a customer, not by us.
    expect(() => parseAcceptedTokens('NOPE:8453')).toThrow(/registry|not in/i);
  });

  it('THROWS on a malformed address', () => {
    expect(() => parseAcceptedTokens('MYUSD:8453:0xnothex:6')).toThrow(/address/i);
  });

  it('THROWS on a duplicate contract rather than silently de-duping', () => {
    expect(() => parseAcceptedTokens('USDC:8453,USDC:8453')).toThrow(/duplicate/i);
  });

  it('parses a multi-entry list and lowercases addresses', () => {
    const list = parseAcceptedTokens('USDC:1,USDC:8453,USDC:42161');
    expect(list).toHaveLength(3);
    expect(list.every((t) => t.address === t.address.toLowerCase())).toBe(true);
  });
});

describe('usdMinorToTokenBaseUnits — cents → token base units', () => {
  it('shifts a 6-decimal token by 4 places', () => {
    // $19.00 = 1900 cents → 19_000000 base units (6 decimals).
    expect(usdMinorToTokenBaseUnits(1900, 6)).toBe(19_000000n);
  });

  it('shifts an 18-decimal token without float overflow', () => {
    // MUTATION: `BigInt(amountMinor / 100 * 10**decimals)` → this loses the low
    // digits the instant decimals exceeds ~16. $19.00 in DAI is 19e18.
    expect(usdMinorToTokenBaseUnits(1900, 18)).toBe(19_000000000000000000n);
    // And it is EXACT, not approximate — the whole point of BigInt.
    expect(usdMinorToTokenBaseUnits(1, 18)).toBe(10_000_000_000_000_000n); // one cent
  });

  it('refuses a sub-2-decimal token rather than rounding a price to fit', () => {
    // MUTATION: divide instead of guarding → a $19 invoice becomes 0 base units.
    expect(() => usdMinorToTokenBaseUnits(1900, 0)).toThrow(/cannot represent cents/i);
    expect(() => usdMinorToTokenBaseUnits(1900, 1)).toThrow();
  });

  it('refuses a non-integer or negative amount', () => {
    expect(() => usdMinorToTokenBaseUnits(19.5, 6)).toThrow();
    expect(() => usdMinorToTokenBaseUnits(-100, 6)).toThrow();
  });
});

describe('baseUnitsToUsdMinor — token base units → cents (the settlement inverse)', () => {
  it('round-trips with usdMinorToTokenBaseUnits at 6 and 18 decimals', () => {
    // The two are used on opposite ends of one payment: we quote an amount in
    // base units, the watcher reads a Transfer and converts back to cents to
    // hand the fold. A round-trip that did not close would settle the wrong
    // amount.
    for (const cents of [1, 100, 1900, 79000, 5_000_000]) {
      for (const decimals of [6, 18]) {
        expect(baseUnitsToUsdMinor(usdMinorToTokenBaseUnits(cents, decimals), decimals)).toBe(cents);
      }
    }
  });

  it('floors a dust overpayment to whole cents rather than inventing fractions', () => {
    // 19_000001 base units of a 6-decimal token = $19.000001 → 1900 cents.
    expect(baseUnitsToUsdMinor(19_000001n, 6)).toBe(1900);
  });

  it('clamps an absurd value instead of overflowing to Infinity', () => {
    const huge = 10n ** 40n;
    const out = baseUnitsToUsdMinor(huge, 6);
    expect(Number.isFinite(out)).toBe(true);
    expect(out).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('formatTokenAmount — display only', () => {
  it('renders whole and fractional amounts', () => {
    expect(formatTokenAmount(19_000000n, 6)).toBe('19');
    expect(formatTokenAmount(19_500000n, 6)).toBe('19.5');
    expect(formatTokenAmount(1n, 6)).toBe('0.000001');
    expect(formatTokenAmount(19_000000000000000000n, 18)).toBe('19');
  });
});
