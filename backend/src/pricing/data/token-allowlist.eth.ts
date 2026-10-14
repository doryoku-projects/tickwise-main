// This file is almost empty in the public repository.
//
// It is a snapshot of data from the CoinGecko API, and CoinGecko's terms restrict copying and
// redistributing their data, so the snapshot is not published here. Generate it yourself with your own
// CoinGecko access:   node scripts/refresh-token-allowlist.mjs
//
// Only the few well-known contract addresses that the code or the test suite itself already names are kept, so the tests
// run. Everything else is absent, so a token outside the configured anchors and this short list does not count
// as a listed, real-market token and is valued at $0. Data powered by CoinGecko (https://www.coingecko.com).
export const ALLOWLIST_META = {
  source: 'not included',
  platform: 'ethereum',
  count: 27,
  generatedAt: 'not included',
} as const;

/** Lowercased Ethereum contract addresses. */
export const ETH_ALLOWLIST: ReadonlySet<string> = new Set([
  '0x000000000000012def132e61759048be5b5c6033',
  '0x0000000000085d4780b73119b644ae5ecd22b376',
  '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
  '0x40d16fc0246ad3160ccc09b8d0d3a2cd28ae6c2f',
  '0x4c9edd5852cd905f086c759e8383e09bff1e68b3',
  '0x4fabb145d64652a948d72533023f6e7a623c7c53',
  '0x514910771af9ca656af840dff83e8264ecf986ca',
  '0x6b175474e89094c44da98b954eedeac495271d0f',
  '0x6c3ea9036406852006290770bedfcaba0e23a0e8',
  '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0',
  '0x808507121b80c02388fad14726482e061b8da827',
  '0x853d955acef822db058eb8505911ed77f175b99e',
  '0x8947da500eb47f82df21143d0c01a29862a8c3c5',
  '0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359',
  '0x91af0fbb28aba7e31403cb457106ce79397fd4e6',
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  '0xae78736cd615f374d3085123a210448e74fc6393',
  '0xae7ab96520de3a18e5e111b5eaab095312d7fe84',
  '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
  '0xc5f0f7b66764f6ec8c8dff7ba683102295e16409',
  '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf',
  '0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee',
  '0xdac17f958d2ee523a2206206994597c13d831ec7',
  '0xdc035d45d973e3ec169d2276ddab16f1e407384f',
  '0xe33fbe7584eb79e2673abe576b7ac8c0de62565c',
  '0xe343167631d89b6ffc58b88d6b7fb0228795491d',
  '0xf939e0a03fb07f59a73314e73794be0e57ac1b4e',
]);
