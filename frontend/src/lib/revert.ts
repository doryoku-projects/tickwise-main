// Deep-links into revert.finance. Kept dynamic across chains/protocols so
// adding a new integration later is a one-line edit to the maps below.
//
// URL shapes (SPA hash routes, confirmed against revert.finance):
//   pool:     https://revert.finance/#/pool/<chain>/<protocol>/<poolId>
//   position: https://revert.finance/#/<protocol>-position/<chain>/<tokenId>

// Only chains revert.finance actually serves. A chain missing here (e.g.
// Avalanche 43114 — revert has no Avalanche support) must NOT fall back to
// "mainnet": that fabricates a link to the wrong chain's position. Callers
// gate on `revertSupportsChain` and hide the link instead.
const REVERT_CHAIN_SLUG: Record<number, string> = {
  1: "mainnet",
};

const REVERT_PROTOCOL_SLUG: Record<string, string> = {
  "uniswap-v4": "uniswapv4",
  "uniswap-v3": "uniswapv3",
};

export function revertSupportsChain(chainId: number): boolean {
  return chainId in REVERT_CHAIN_SLUG;
}

export function revertChainSlug(chainId: number): string {
  return REVERT_CHAIN_SLUG[chainId] ?? "mainnet";
}

export function revertProtocolSlug(protocol: string): string {
  return REVERT_PROTOCOL_SLUG[protocol] ?? protocol.replace(/-/g, "");
}

export function revertPoolUrl(chainId: number, protocol: string, poolId: string): string {
  return `https://revert.finance/#/pool/${revertChainSlug(chainId)}/${revertProtocolSlug(protocol)}/${poolId}`;
}

export function revertPositionUrl(chainId: number, protocol: string, tokenId: string): string {
  return `https://revert.finance/#/${revertProtocolSlug(protocol)}-position/${revertChainSlug(chainId)}/${tokenId}`;
}
