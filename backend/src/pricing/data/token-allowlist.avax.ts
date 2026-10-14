// This file is almost empty in the public repository.
//
// It is a snapshot of data from the CoinGecko API, and CoinGecko's terms restrict copying and
// redistributing their data, so the snapshot is not published here. Generate it yourself with your own
// CoinGecko access:   node scripts/refresh-token-allowlist.mjs avalanche
//
// Only the few well-known contract addresses that the code or the test suite itself already names are kept, so the tests
// run. Everything else is absent, so a token outside the configured anchors and this short list does not count
// as a listed, real-market token and is valued at $0. Data powered by CoinGecko (https://www.coingecko.com).
export const ALLOWLIST_META = {
  source: 'not included',
  platform: 'avalanche',
  count: 11,
  generatedAt: 'not included',
} as const;

/** Lowercased Avalanche C-Chain contract addresses. */
export const AVAX_ALLOWLIST: ReadonlySet<string> = new Set([
  '0x000000000000012def132e61759048be5b5c6033',
  '0x152b9d0fdc40c096757f570a51e494bd4b943e50',
  '0x2b2c81e08f1af8835a78bb2a90ae924ace0ea4be',
  '0x49d5c2bdffac6ce2bfdb6640f4f80f226bc10bab',
  '0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34',
  '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7',
  '0xa7d7079b0fead91f3e65f86e8915cb59c1a4c664',
  '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7',
  '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e',
  '0xc7198437980c041c805a1edcba50c1ce5db95118',
  '0xd586e7f844cea2f87f50152665bcbc2c279d8d70',
]);
