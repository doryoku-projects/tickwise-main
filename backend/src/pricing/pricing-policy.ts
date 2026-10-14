import {
  getChainConfig,
  isStablecoin,
  isTrustedToken,
  isWrappedNative,
} from '../config/chains.config.js';
import { getProtocolConfig } from '../config/protocols.config.js';

/**
 * Anchor classification used by the pricing decision policy. Anchor tokens
 * are trusted enough to bootstrap pool-ratio derivation for their pair
 * counterparty.
 *
 *   stable        — chain.stablecoins membership
 *   native        — chain.wrappedNativeToken / native address
 *   trusted       — chain.trustedTokens membership (WBTC, stETH, ...)
 *   none          — everything else
 */
export type AnchorKind = 'stable' | 'native' | 'trusted' | 'none';

export interface PricingPolicy {
  chainId: number;
  protocol?: string;
  anchors: {
    native: string;
    wrappedNative: string;
    stablecoins: string[];
    trustedTokens: string[];
  };
  derivation: {
    /**
     * Master switch. `false` means pool-ratio derivation is disabled for
     * this (chain, protocol) pair entirely. When `protocol` is omitted on
     * the policy lookup, this defaults to `true` so the resolver can be
     * used for chain-level questions independent of protocol; pool-ratio
     * code paths must still pass `protocol` for the gate to take effect.
     */
    enabled: boolean;
    /** Minimum pool TVL/locked value to fill a missing external quote. */
    minTvlUsdFillMissing: number;
    /** Minimum pool TVL/locked value to override an unverified external quote. */
    minTvlUsdOverrideUnverified: number;
    /** Minimum pool TVL/locked value to override a verified external quote. */
    minTvlUsdOverrideVerified: number;
    /**
     * If `verified-external / derived` ratio (in either direction) is at
     * or above this multiplier AND pool confidence is strong, prefer
     * derived. Default high (5x) so a healthy pool with mild drift never
     * displaces a verified API quote.
     */
    maxVerifiedDivergence: number;
    /**
     * Same idea for unverified externals; lower threshold because
     * long-tail external quotes are the main poisoning source.
     */
    maxUnverifiedDivergence?: number;
    /** Current-pricing derivation requires at least one anchor side. */
    requireAnchorSideForCurrent: boolean;
    /** Historical pool-ratio derivation requires anchor counterparty price. */
    requireAnchorPriceForHistorical: boolean;
  };
  stablecoin: {
    /** Assumed peg price ($1) for stablecoins, never persisted. */
    assumedUsd: number;
    /** Reject the peg if a provider quote disagrees by more than this fraction. */
    maxPegDeviation: number;
  };
  cache: {
    /**
     * Hard invariant: current quotes must never flow into the historical
     * cache bucket. Type set to `false` literal so it cannot drift true.
     */
    allowCurrentToHistorical: false;
    lastKnownTtlMs?: number;
  };
}

/**
 * Defaults — conservative thresholds suitable for any new chain/protocol
 * we haven't tuned yet. Verified-override threshold is high so a known
 * external price wins on disagreement unless a deep pool says otherwise.
 */
const DEFAULT_DERIVATION = {
  enabled: true,
  minTvlUsdFillMissing: 500,
  minTvlUsdOverrideUnverified: 25_000,
  minTvlUsdOverrideVerified: 250_000,
  maxVerifiedDivergence: 5,
  maxUnverifiedDivergence: 2,
  requireAnchorSideForCurrent: true,
  requireAnchorPriceForHistorical: true,
} as const;

const DEFAULT_STABLECOIN = {
  assumedUsd: 1,
  maxPegDeviation: 0.05,
} as const;

const DEFAULT_CACHE = {
  allowCurrentToHistorical: false as const,
};

/**
 * Resolve the active pricing policy for a `(chainId, protocol?)` pair.
 *
 * Returns `undefined` only when the chain itself is unknown. An unknown
 * protocol still returns a policy — derivation is disabled in that case
 * because no protocol-specific adapter can supply pool snapshots.
 */
export function getPricingPolicy(chainId: number, protocol?: string): PricingPolicy | undefined {
  const chain = getChainConfig(chainId);
  if (!chain) return undefined;

  const protocolCfg = protocol ? getProtocolConfig(protocol) : undefined;
  const protocolSupports = protocol
    ? Boolean(protocolCfg?.supportsPoolRatioDerivation)
    : true; // chain-level lookup — leave protocol gate for the caller.

  return {
    chainId,
    protocol,
    anchors: {
      native: chain.nativeToken.address.toLowerCase(),
      wrappedNative: chain.wrappedNativeToken.address.toLowerCase(),
      stablecoins: chain.stablecoins.map((address) => address.toLowerCase()),
      trustedTokens: (chain.trustedTokens ?? []).map((address) => address.toLowerCase()),
    },
    derivation: {
      ...DEFAULT_DERIVATION,
      enabled: DEFAULT_DERIVATION.enabled && protocolSupports,
    },
    stablecoin: { ...DEFAULT_STABLECOIN },
    cache: { ...DEFAULT_CACHE },
  };
}

/**
 * Classify a token relative to a policy's anchor sets. Pool-ratio
 * derivation only kicks in when at least one side is non-`none`.
 */
export function classifyAnchor(policy: PricingPolicy, address: string): AnchorKind {
  const normalized = address.toLowerCase();
  if (policy.anchors.stablecoins.includes(normalized)) return 'stable';
  if (normalized === policy.anchors.native || normalized === policy.anchors.wrappedNative) {
    return 'native';
  }
  if (policy.anchors.trustedTokens.includes(normalized)) return 'trusted';
  return 'none';
}

/**
 * Convenience: legacy callers want a single boolean. `none` is the only
 * non-anchor class; everything else (stable/native/trusted) qualifies.
 */
export function isAnchorToken(policy: PricingPolicy, address: string): boolean {
  return classifyAnchor(policy, address) !== 'none';
}

/**
 * Standalone version usable without a policy in hand — for code paths
 * that don't have the chain config loaded yet. Matches `isAnchorToken`
 * exactly for the same `(chainId, address)`.
 */
export function isAnchorTokenStandalone(chainId: number, address: string): boolean {
  return (
    isStablecoin(chainId, address) ||
    isWrappedNative(chainId, address) ||
    isTrustedToken(chainId, address)
  );
}
