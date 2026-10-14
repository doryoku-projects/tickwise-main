// This file is almost empty in the public repository.
//
// It is a snapshot of data from the CoinGecko API, and CoinGecko's terms restrict copying and
// redistributing their data, so the snapshot is not published here. Generate it yourself with your own
// CoinGecko access:   node scripts/refresh-token-allowlist.mjs robinhood
//
// Only the few well-known contract addresses that the code or the test suite itself already names are kept, so the tests
// run. Everything else is absent, so a token outside the configured anchors and this short list does not count
// as a listed, real-market token and is valued at $0. Data powered by CoinGecko (https://www.coingecko.com).
export const ALLOWLIST_META = {
  source: 'not included',
  platform: 'robinhood',
  count: 7,
  generatedAt: 'not included',
} as const;

/** Lowercased Robinhood Chain contract addresses. */
export const ROBINHOOD_ALLOWLIST: ReadonlySet<string> = new Set([
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
  '0x1755c2910c126ee1b0cf1e08a307dc9e787285a0',
  '0x40858070814a57fdf33a613ae84fe0a8b4a874f7',
  '0x492641f648a4986844848e0befe66d14817bce34',
  '0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34',
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
  '0xcec185eb182c47d1ba1efc84e6959e18cd620be4',
]);
