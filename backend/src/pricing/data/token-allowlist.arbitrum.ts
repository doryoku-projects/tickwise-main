// This file is almost empty in the public repository.
//
// It is a snapshot of data from the CoinGecko API, and CoinGecko's terms restrict copying and
// redistributing their data, so the snapshot is not published here. Generate it yourself with your own
// CoinGecko access:   node scripts/refresh-token-allowlist.mjs arbitrum-one
//
// Only the few well-known contract addresses that the code or the test suite itself already names are kept, so the tests
// run. Everything else is absent, so a token outside the configured anchors and this short list does not count
// as a listed, real-market token and is valued at $0. Data powered by CoinGecko (https://www.coingecko.com).
export const ALLOWLIST_META = {
  source: 'not included',
  platform: 'arbitrum-one',
  count: 18,
  generatedAt: 'not included',
} as const;

/** Lowercased Arbitrum One contract addresses. */
export const ARBITRUM_ALLOWLIST: ReadonlySet<string> = new Set([
  '0x000000000000012def132e61759048be5b5c6033',
  '0x17fc002b466eec40dae837fc4be5c67993ddbd6f',
  '0x2297aebd383787a160dd0d9f71508148769342e3',
  '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f',
  '0x35751007a407ca6feffe80b3cb397736d2cf4dbe',
  '0x498bf2b1e120fed3ad3d42ea2165e9b73f99c1e5',
  '0x5979d7b546e38e414f7e9822514be443a4800529',
  '0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34',
  '0x6c84a8f1c29108f47a79964b5fe888d4f4d0de40',
  '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
  '0x912ce59144191c1204e64559fe8253a0e49e6548',
  '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
  '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf',
  '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1',
  '0xec70dcb4a1efa46b8f2d97c310c9c4790ba5ffa8',
  '0xf97f4df75117a78c1a5a0dbb814af92458539fb4',
  '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
  '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8',
]);
