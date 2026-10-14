import { getChainConfig } from '../config/chains.config.js';
import { ALLOWLIST_META as ETH_ALLOWLIST_META, ETH_ALLOWLIST } from './data/token-allowlist.eth.js';
import { ALLOWLIST_META as AVAX_ALLOWLIST_META, AVAX_ALLOWLIST } from './data/token-allowlist.avax.js';
import {
  ALLOWLIST_META as ARBITRUM_ALLOWLIST_META,
  ARBITRUM_ALLOWLIST,
} from './data/token-allowlist.arbitrum.js';
import {
  ALLOWLIST_META as ROBINHOOD_ALLOWLIST_META,
  ROBINHOOD_ALLOWLIST,
} from './data/token-allowlist.robinhood.js';

/**
 * Committed, deterministic token-trust gate. A token is "real-market" iff its
 * contract address is in the committed CoinGecko-listed snapshot for the chain's
 * platform — so an unlisted token is valued at $0, WITHOUT
 * any runtime network (the free CoinGecko endpoint IP-blocks cloud servers, which
 * made the previous fetch-based gate silently fail open). Regenerate the snapshot
 * with `node scripts/refresh-token-allowlist.mjs`.
 */
const BY_PLATFORM: Record<string, ReadonlySet<string>> = {
  [ETH_ALLOWLIST_META.platform]: ETH_ALLOWLIST,
  [AVAX_ALLOWLIST_META.platform]: AVAX_ALLOWLIST,
  [ARBITRUM_ALLOWLIST_META.platform]: ARBITRUM_ALLOWLIST,
  [ROBINHOOD_ALLOWLIST_META.platform]: ROBINHOOD_ALLOWLIST,
};

/**
 * True when the token should be trusted for USD valuation. FAIL-CLOSED where we
 * have an authoritative list (Ethereum → unlisted address returns false → $0);
 * FAIL-OPEN for a chain with no platform mapping or no committed list yet (returns
 * true) so a newly-added chain isn't silently zeroed before its snapshot exists.
 * Anchors (stable/native/trusted) bypass this gate upstream in `pricePool`.
 */
export function isAllowlisted(chainId: number, address: string): boolean {
  const platform = getChainConfig(chainId)?.coingeckoPlatformId;
  if (!platform) return true;
  const set = BY_PLATFORM[platform];
  if (!set || set.size === 0) return true;
  return set.has(address.toLowerCase());
}

/** Committed allowlist size for a chain's platform (0 if none). */
export function allowlistSize(chainId: number): number {
  const platform = getChainConfig(chainId)?.coingeckoPlatformId;
  return (platform && BY_PLATFORM[platform]?.size) || 0;
}
