// The honeypot static-fee rule, in ONE place: read by the pools sync
// (`evaluatePoolTvl` flags such a pool risky) and by the positions repository
// (`HONEYPOT_FEE_FILTER=on` drops its positions from ranked lists and counts),
// so the Pools page and the Positions page cannot drift apart.
//
// A pool whose STATIC LP fee is ≥ 5% (50,000 pips) keeps the bulk of every
// swap — the observed spam sits at 99.99% / 99.5% / 9.9993% / 6.0001%, just
// under round gates. NOTE: real pools exist above 5% too (stored data,
// 2026-10-05: 42161 ETH/USDC at 60,940, 1 ETH/USDT at 210,790 — ~$50k each),
// so the rule hides a few genuine anchor/anchor positions as well; that is a
// recorded product decision for whoever switches the flag on. `0x800000` and
// above is v4's dynamic-fee FLAG, not a fee, and is exempt.
//
// `HONEYPOT_FEE_ANCHOR_EXEMPT=on` (default off) narrows it: a pool whose BOTH
// legs are config anchors (`isAnchorTokenStandalone` — stables, native incl.
// the zero pseudo-address, wrapped native, trusted majors) is never a
// honeypot-fee pool. A honeypot needs a token nobody can price elsewhere; two
// anchors are priced everywhere, so a high fee there is an LP's (bad) choice,
// not a trap, and those real pools come back on both pages.

import { getChainConfig } from '../config/chains.config.js';
import { isAnchorTokenStandalone } from '../pricing/pricing-policy.js';

/** Static fee at or above this (pips) is a honeypot fee. */
export const HONEYPOT_FEE_MIN_PIPS = 50_000;
/** v4's dynamic-fee flag: a fee field at or above it is not a static fee. */
export const DYNAMIC_FEE_FLAG = 0x800000;

/**
 * Today's rule, as a predicate (the pools sync's): a STATIC fee at or above the
 * floor. The dynamic-fee flag and above is not a fee, and NaN compares false
 * both ways. The positions repository's Mongo clause is this rule's KEEP side
 * written for stored documents (null / missing kept; type-bracketed, so a
 * stored NaN or string fee matches no branch there).
 */
export function isHoneypotStaticFee(fee: number): boolean {
  return fee >= HONEYPOT_FEE_MIN_PIPS && fee < DYNAMIC_FEE_FLAG;
}

/** Both legs are config anchors on `chainId` (the exemption's test). */
export function isAnchorPair(chainId: number, token0: string, token1: string): boolean {
  return isAnchorTokenStandalone(chainId, token0) && isAnchorTokenStandalone(chainId, token1);
}

/**
 * Every address `isAnchorTokenStandalone(chainId, ·)` accepts, lowercased and
 * de-duplicated — the `$in` list of the positions clause's exemption branch.
 * Read from the SAME chain config fields the predicate reads (stablecoins,
 * wrapped native, the native address — the zero pseudo-address on every chain
 * today — and trusted tokens), so the Mongo clause and the pools sync cannot
 * disagree about what an anchor is (pinned per chain by a spec). Stored token
 * addresses are lowercased by the adapters, so this matches them byte for
 * byte. A fresh array per call: the caller hands it to Mongoose, which may
 * rewrite what it is given. An unknown chain has no anchors.
 */
export function anchorAddresses(chainId: number): string[] {
  const chain = getChainConfig(chainId);
  if (!chain) return [];
  const all = [...chain.stablecoins, chain.wrappedNativeToken.address, chain.nativeToken.address, ...(chain.trustedTokens ?? [])];
  return [...new Set(all.map((address) => address.toLowerCase()))];
}

