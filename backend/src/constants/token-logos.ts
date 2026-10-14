import { equityTicker, knownSymbol } from '../pricing/tokenized-equities.js';

/**
 * Deterministic token logo URL. No network, no cache — just builds the llamao
 * CDN URL from the contract address. llamao aggregates Trust Wallet / CoinGecko
 * / 1inch by lowercase address and reliably serves webp. A token llamao doesn't
 * have returns 404, which the frontend handles by falling back to the symbol.
 *
 * Deterministic on purpose: every host (local + prod) produces the same URL, so
 * icons can never diverge between environments.
 */
export function resolveTokenLogo(chainId: number, address: string): string {
  return `https://token-icons.llamao.fi/icons/tokens/${chainId}/${address.toLowerCase()}?w=48&h=48`;
}

/**
 * Recover a token's display symbol when the indexer failed to read it.
 *
 * The Envio indexer's ERC-20 metadata read rate-limits on Robinhood Chain and
 * falls back to the literal "UNKNOWN" (uniswap-v4-indexer-envio
 * src/utils/tokenMetadata.ts). That string is written once and never revisited,
 * so 94 of the 97 indexed tokenized equities that have pools are stored unnamed.
 *
 * Applied at READ time rather than fixed at sync time deliberately: the stored
 * value can only be corrected by reindexing 53M blocks, and the authoritative
 * address -> ticker mapping is off-chain product metadata that changes on
 * CoinGecko's schedule, not the chain's.
 *
 * Only ever fills a GAP — a symbol the indexer did resolve always wins, so this
 * can never rename a token out from under the chain.
 */
export function resolveTokenSymbol(chainId: number, address: string, symbol?: string): string {
  const known = symbol?.trim();
  if (known && known !== 'UNKNOWN') return known;
  // Equity tickers first — they are the higher-confidence source, drawn from a
  // curated category rather than the whole CoinGecko index.
  return equityTicker(chainId, address) ?? knownSymbol(chainId, address) ?? known ?? 'UNKNOWN';
}
