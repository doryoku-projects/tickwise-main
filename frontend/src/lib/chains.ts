import type { ChainMeta } from "./api";

/**
 * Per-chain display + explorer metadata for row chips, detail headers, and
 * tx/address links. The authoritative source is the backend's chain registry
 * (GET /v1/chains — call `registerChains` with its response once fetched); the
 * static fallback below mirrors backend `chains.config.ts` so links and labels
 * stay correct before that fetch resolves (or if it fails).
 */
export interface ChainInfo {
  chainId: number;
  name: string;
  /** Short label for tight UI: "ETH", "AVAX". */
  shortName: string;
  /** Explorer base URL (no trailing slash) — append /tx/{hash}, /address/{addr}. */
  explorerUrl: string | null;
  /** Native gas-token symbol ("ETH", "AVAX") — labels gas amounts. */
  nativeSymbol: string;
}

const FALLBACK: Record<number, ChainInfo> = {
  1: {
    chainId: 1,
    name: "Ethereum",
    shortName: "ETH",
    explorerUrl: "https://etherscan.io",
    nativeSymbol: "ETH",
  },
  43114: {
    chainId: 43114,
    name: "Avalanche C-Chain",
    shortName: "AVAX",
    explorerUrl: "https://snowtrace.io",
    nativeSymbol: "AVAX",
  },
  42161: {
    chainId: 42161,
    name: "Arbitrum One",
    shortName: "ARB",
    explorerUrl: "https://arbiscan.io",
    nativeSymbol: "ETH",
  },
  4663: {
    chainId: 4663,
    name: "Robinhood Chain",
    shortName: "HOOD",
    explorerUrl: "https://robinhoodchain.blockscout.com",
    nativeSymbol: "ETH",
  },
};

const registry = new Map<number, ChainInfo>();

/** Feed the /v1/chains response in so lookups reflect the live backend registry. */
export function registerChains(chains: ChainMeta[]): void {
  for (const c of chains) {
    registry.set(c.chainId, {
      chainId: c.chainId,
      name: c.name,
      shortName: c.shortName ?? FALLBACK[c.chainId]?.shortName ?? c.name,
      explorerUrl: c.explorerUrl ?? FALLBACK[c.chainId]?.explorerUrl ?? null,
      nativeSymbol:
        c.nativeToken?.symbol ?? FALLBACK[c.chainId]?.nativeSymbol ?? "ETH",
    });
  }
}

/**
 * The chains the public pages name, in the order the copy names them.
 *
 * There is one list because there used to be three. The footer strip still read
 * "Uniswap v4 · ETH · AVAX · near-real-time" long after Arbitrum shipped, while
 * the footer blurb beside it and the hero badge both named all three — the same
 * fact written out by hand in three files, and only two of them updated. Adding
 * a chain now means adding a line here.
 *
 * `label` is the bare marketing name rather than the registry's, because that is
 * what this copy has always printed: "Arbitrum", not the registry's "Arbitrum
 * One", and "Avalanche", not "Avalanche C-Chain". The short form is NOT repeated
 * — it is read from the registry above, so the two spellings of a chain cannot
 * drift apart either.
 */
export const MARKETED_CHAINS: ReadonlyArray<{ chainId: number; label: string }> = [
  { chainId: 1, label: "Ethereum" },
  { chainId: 42161, label: "Arbitrum" },
  { chainId: 43114, label: "Avalanche" },
  { chainId: 4663, label: "Robinhood" }
];

/** "ETH · ARB · AVAX" — the tight form, for the footer strip. */
export function marketedShortNames(): string[] {
  return MARKETED_CHAINS.map((c) => chainInfo(c.chainId).shortName);
}

/** "Ethereum, Arbitrum and Avalanche" — the prose form, for body copy. */
export function marketedChainsProse(): string {
  const names = MARKETED_CHAINS.map((c) => c.label);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export function chainInfo(chainId: number): ChainInfo {
  return (
    registry.get(chainId) ??
    FALLBACK[chainId] ?? {
      chainId,
      name: `Chain ${chainId}`,
      shortName: `#${chainId}`,
      explorerUrl: null,
      nativeSymbol: "ETH",
    }
  );
}

/**
 * The note an all-chains list shows when the backend served it without some
 * chains (`partial` + `missingChains`): which ones, by name. Null when nothing
 * is missing.
 */
export function missingChainsNote(missingChains: readonly number[] | undefined): string | null {
  if (!missingChains || missingChains.length === 0) return null;
  const names = missingChains.map((id) => chainInfo(id).name);
  const list = names.length <= 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Some chains are temporarily unavailable (${list}) — showing the others.`;
}

/** null when the chain has no known explorer — caller renders plain text. */
export function explorerTxUrl(chainId: number, txHash: string): string | null {
  const base = chainInfo(chainId).explorerUrl;
  return base ? `${base}/tx/${txHash}` : null;
}
