/*
 * The per-chain token whitelist, and the `verified` hint derived from it.
 *
 * WHY THIS EXISTS IN THE BACKEND
 *
 * The Envio indexer has no `Token.verified` column, and neither did the Ponder
 * one in any meaningful sense: its schema called the column a "hint only —
 * backend owns trust" and computed it as `whitelistTokens.has(id)` from a static
 * per-chain list in `networks.json`, never from chain data. So the value was
 * always the consumer's to own. Holding the same static list here gives the same
 * answer without the indexer knowing about it.
 *
 * WHY IT MATTERS THAT THEY AGREE
 *
 * `verified === true` is what promotes a token's price to the `verified` trust
 * rank. Reading the Envio path with the field simply absent would silently
 * demote EVERY token to `unverified`, which changes the >5x inflation guard and
 * whether a low-trust leg counts toward position value. That is a wrong number
 * that still looks like a number — the failure mode the trust ranking exists to
 * prevent — so the list is ported rather than defaulted.
 *
 * Addresses are lowercase, copied from the indexer's `networks.json`
 * (`chains.<name>.whitelistTokens`). The zero address is v4's native currency.
 */

const WHITELIST: Readonly<Record<number, readonly string[]>> = {
  // mainnet — WETH, DAI, USDC, USDT, WBTC, USDe, FRAX, ENA, LDO, deUSD,
  // wstETH, cbBTC, rETH, weETH, stETH, native ETH
  1: [
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    '0x6b175474e89094c44da98b954eedeac495271d0f',
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    '0xdac17f958d2ee523a2206206994597c13d831ec7',
    '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599',
    '0x4c9edd5852cd905f086c759e8383e09bff1e68b3',
    '0x853d955acef822db058eb8505911ed77f175b99e',
    '0xf939e0a03fb07f59a73314e73794be0e57ac1b4e',
    '0x6c3ea9036406852006290770bedfcaba0e23a0e8',
    '0xdc035d45d973e3ec169d2276ddab16f1e407384f',
    '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0',
    '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf',
    '0xae78736cd615f374d3085123a210448e74fc6393',
    '0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee',
    '0xae7ab96520de3a18e5e111b5eaab095312d7fe84',
    '0x0000000000000000000000000000000000000000',
  ],
  // optimism
  10: [
    '0x4200000000000000000000000000000000000006',
    '0x0b2c639c533813f4aa9d7837caf62653d097ff85',
    '0x7f5c764cbc14f9669b88837ca1490cca17c31607',
    '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58',
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1',
    '0x68f180fcce6836688e9084f035309e29bf0a2095',
    '0x1f32b1c2345538c0c6f582fcb022739c4a194ebb',
    '0x9bcef72be871e61ed4fbbc7630889bee758eb81d',
    '0x0000000000000000000000000000000000000000',
  ],
  // arbitrum one
  42161: [
    '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1',
    '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
    '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8',
    '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
    '0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34',
    '0x17fc002b466eec40dae837fc4be5c67993ddbd6f',
    '0x498bf2b1e120fed3ad3d42ea2165e9b73f99c1e5',
    '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f',
    '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf',
    '0x6c84a8f1c29108f47a79964b5fe888d4f4d0de40',
    '0x5979d7b546e38e414f7e9822514be443a4800529',
    '0xec70dcb4a1efa46b8f2d97c310c9c4790ba5ffa8',
    '0x35751007a407ca6feffe80b3cb397736d2cf4dbe',
    '0x912ce59144191c1204e64559fe8253a0e49e6548',
    '0xf97f4df75117a78c1a5a0dbb814af92458539fb4',
    '0x0000000000000000000000000000000000000000',
  ],
  // avalanche
  43114: [
    '0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7',
    '0x49d5c2bdffac6ce2bfdb6640f4f80f226bc10bab',
    '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e',
    '0xa7d7079b0fead91f3e65f86e8915cb59c1a4c664',
    '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7',
    '0xc7198437980c041c805a1edcba50c1ce5db95118',
    '0xd586e7f844cea2f87f50152665bcbc2c279d8d70',
    '0x152b9d0fdc40c096757f570a51e494bd4b943e50',
    '0x2b2c81e08f1af8835a78bb2a90ae924ace0ea4be',
    '0x0000000000000000000000000000000000000000',
  ],
  // robinhood chain
  4663: [
    '0x40858070814a57fdf33a613ae84fe0a8b4a874f7',
    '0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34',
    '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
    '0x1755c2910c126ee1b0cf1e08a307dc9e787285a0',
    '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
    '0x0000000000000000000000000000000000000000',
  ],
};

const SETS = new Map<number, ReadonlySet<string>>(
  Object.entries(WHITELIST).map(([chainId, list]) => [Number(chainId), new Set(list)]),
);

/**
 * Is this token on the chain's whitelist?
 *
 * A chain with no list answers `false` for everything, which is the same answer
 * an indexer gives for a chain whose `networks.json` entry omits `whitelistTokens`.
 */
export function isWhitelistedToken(chainId: number, address: string): boolean {
  return SETS.get(chainId)?.has(address.toLowerCase()) === true;
}
