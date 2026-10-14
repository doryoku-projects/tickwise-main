// This file is almost empty in the public repository.
//
// It is a snapshot of data from the CoinGecko API, and CoinGecko's terms restrict copying and
// redistributing their data, so the snapshot is not published here. Generate it yourself with your own
// CoinGecko access:   node scripts/refresh-tokenized-equities.mjs
//
// The single entry is a SYNTHETIC placeholder (not a real token): the equity filter needs a non-empty list to be
// well-formed, so the tests run. Everything else is absent, so a token outside the configured anchors and this short list does not count
// as a listed, real-market token and is valued at $0. Data powered by CoinGecko (https://www.coingecko.com).
export const EQUITY_META = {
  source: 'not included',
  platform: 'robinhood',
  chainId: 4663,
  count: 1,
  generatedAt: 'not included',
} as const;

/** Lowercased contract address -> equity ticker, for Robinhood Chain. */
export const ROBINHOOD_EQUITIES: ReadonlyMap<string, string> = new Map([
  ['0x0000000000000000000000000000000000000e01', 'EQTY'], // synthetic placeholder, see the note at the top
]);
