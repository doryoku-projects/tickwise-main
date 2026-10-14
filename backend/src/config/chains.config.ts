export interface ChainConfig {
  chainId: number;
  slug: string;
  name: string;
  /** Short human label for tight UI (table chips): "ETH", "AVAX". */
  shortName: string;
  /**
   * Block-explorer base URL (no trailing slash). Consumers append the
   * conventional paths: `/tx/{hash}`, `/address/{addr}`, `/token/{addr}`.
   * Surfaced to the frontend via GET /v1/chains so links stay chain-correct.
   */
  explorerUrl: string;
  coingeckoPlatformId?: string;
  coingeckoNativeId?: string;
  nativeToken: {
    symbol: string;
    address: string;
    decimals: number;
  };
  wrappedNativeToken: {
    symbol: string;
    address: string;
    decimals: number;
  };
  stablecoins: string[];
  /**
   * Additional trusted high-quality tokens for this chain (e.g. WBTC, stETH).
   * Used as anchor counterparties for pool-ratio derivation when no
   * native/stable side is present. Addresses are case-insensitive.
   */
  trustedTokens?: string[];
  supportsSubgraphs: boolean;
  blockTimeMs: number;
}

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export const CHAINS: Record<number, ChainConfig> = {
  1: {
    chainId: 1,
    slug: 'ethereum',
    name: 'Ethereum Mainnet',
    shortName: 'ETH',
    explorerUrl: 'https://etherscan.io',
    coingeckoPlatformId: 'ethereum',
    coingeckoNativeId: 'ethereum',
    nativeToken: {
      symbol: 'ETH',
      address: ZERO_ADDRESS,
      decimals: 18,
    },
    wrappedNativeToken: {
      symbol: 'WETH',
      address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      decimals: 18,
    },
    stablecoins: [
      '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
      '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT
      '0x6B175474E89094C44Da98b954EedeAC495271d0F', // DAI
      '0x0000000000085d4780B73119b644AE5ecd22b376', // TUSD
      '0x4Fabb145d64652a948d72533023f6E7A623C7C53', // BUSD
      '0x853d955aCEf822Db058eb8505911ED77F175b99e', // FRAX
      '0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f', // GHO
    ],
    trustedTokens: [
      '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', // WBTC
      '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84', // stETH
      '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0', // wstETH
      '0xae78736Cd615f374D3085123A210448E74Fc6393', // rETH
    ],
    supportsSubgraphs: true,
    blockTimeMs: 12_000,
  },
  43114: {
    chainId: 43114,
    slug: 'avax',
    name: 'Avalanche C-Chain',
    shortName: 'AVAX',
    explorerUrl: 'https://snowtrace.io',
    coingeckoPlatformId: 'avalanche',
    // AVAX's CoinGecko coin id (NOT 'ethereum' — first chain where the native
    // asset isn't ETH). Used only for wrapped-native historical lookups.
    coingeckoNativeId: 'avalanche-2',
    nativeToken: {
      symbol: 'AVAX',
      address: ZERO_ADDRESS,
      decimals: 18,
    },
    wrappedNativeToken: {
      symbol: 'WAVAX',
      address: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
      decimals: 18,
    },
    stablecoins: [
      '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', // USDC (native Circle)
      '0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664', // USDC.e (bridged)
      '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', // USDt (native Tether)
      '0xc7198437980c041c805A1EDcbA50c1Ce5db95118', // USDT.e (bridged)
      '0xd586E7F844cEa2F87f50152665BCbc2C279D8d70', // DAI.e (bridged)
    ],
    trustedTokens: [
      '0x152b9d0FdC40C096757f570a51E494bd4b943E50', // BTC.b (native-bridged BTC)
      '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB', // WETH.e (bridged ETH)
      '0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE', // sAVAX (BENQI staked AVAX — native LST; no canonical wstETH on Avalanche)
    ],
    supportsSubgraphs: true,
    // Avalanche C-Chain sustains ~1s blocks post-Etna (measured ~1.0s over 50k
    // blocks); production is demand-driven so this is an activity-dependent mean.
    blockTimeMs: 1_000,
  },
  42161: {
    chainId: 42161,
    // DeFiLlama slug, probed live: `coins.llama.fi/prices/current/arbitrum:<addr>`
    // returns priced coins with correct decimals, and the block endpoint resolves.
    slug: 'arbitrum',
    name: 'Arbitrum One',
    shortName: 'ARB',
    explorerUrl: 'https://arbiscan.io',
    // NOTE: 'arbitrum-one', NOT 'arbitrum' — verified against CoinGecko's
    // asset_platforms (chain_identifier 42161, native_coin_id 'ethereum'). The
    // allowlist snapshot filename/platform key must match this exactly.
    coingeckoPlatformId: 'arbitrum-one',
    coingeckoNativeId: 'ethereum',
    nativeToken: {
      symbol: 'ETH',
      address: ZERO_ADDRESS,
      decimals: 18,
    },
    wrappedNativeToken: {
      symbol: 'WETH',
      address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
      decimals: 18,
    },
    // ONLY true $1 tokens: `classifyAnchor` → 'stable' makes `counterTokenUsd`
    // return a hard 1. Every address below was read on-chain for symbol+decimals.
    stablecoins: [
      '0xaf88d065e77C8cC2239327C5EDb3A432268e5831', // USDC (native Circle)
      '0xFF970A61a04b1cA14834A43f5dE4533eBDDB5CC8', // USDC.e (bridged; same "USDC" symbol)
      '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', // USD₮0 (Tether) — 6 dec
      '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', // DAI
      '0x17FC002b466eEc40DaE837Fc4bE5c67993ddBd6F', // FRAX
      '0x498Bf2B1e120FeD3ad3D42EA2165E9b73f99C1e5', // crvUSD
    ],
    // Non-$1 majors used as anchor counterparties. Shape mirrors mainnet (BTC
    // wrappers + ETH LSTs) plus two chain-specific additions:
    //   USDe — a dollar-ish SYNTHETIC that can depeg, so deliberately here and
    //          NOT in `stablecoins` (same call as on Robinhood 4663).
    //   ARB  — the chain's own governance token; deepest non-ETH/non-stable
    //          pairing on Arbitrum, and every price provider covers it.
    trustedTokens: [
      '0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f', // WBTC
      '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', // cbBTC
      '0x6c84a8f1c29108F47a79964b5Fe888D4f4D0dE40', // tBTC
      '0x5979D7b546E38E414F7E9822514be443A4800529', // wstETH
      '0xEC70Dcb4A1EFa46b8F2D97C310C9c4790ba5ffA8', // rETH
      '0x35751007a407ca6FEFfE80b3cB397736D2cf4dbe', // weETH
      '0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34', // USDe (synthetic dollar)
      '0x912CE59144191C1204E64559FE8253a0e49E6548', // ARB
    ],
    supportsSubgraphs: true,
    // 251.7ms measured over 2,000,000 blocks (503,478s) ⇒ ~3.97 blocks/sec.
    // 48x faster than mainnet, so the time-scaled lag budget is 48x its block
    // count (INDEXER_MAX_LAG_BLOCKS 250 ⇒ ~12,000 blocks here).
    blockTimeMs: 250,
  },
  4663: {
    chainId: 4663,
    // DeFiLlama coins slug — probed live 2026-09-02. `coins.llama.fi/prices/current/
    // robinhood:<addr>` returns WETH @18dec and USDG @6dec at confidence 0.99. A wrong
    // slug answers HTTP 200 `{"coins":{}}` SILENTLY, so the non-empty response IS the
    // proof; the block endpoint (which 400s loudly) corroborates the same string.
    slug: 'robinhood',
    name: 'Robinhood Chain',
    // Cosmetic table-chip label only. Frontend chain icon is name.charAt(0) = "R".
    shortName: 'HOOD',
    // Explorer of record: named as the default in viem's own chain def (with apiUrl),
    // listed EIP-3091-compliant by chainid.network, and the only explorer Robinhood's
    // docs link (subgraphs/copypools-subgraph/ponder/DEPLOY.md:219). Deliberately NOT
    // robinscan.io — a derivative, unattributed source with confusable siblings
    // robinscan.xyz/.to, and it renders a known impostor USDG at $2.29M unflagged.
    explorerUrl: 'https://robinhoodchain.blockscout.com',
    // Bare 'robinhood', NO suffix — verified against CoinGecko /asset_platforms:
    // {id:'robinhood', chain_identifier:4663, native_coin_id:'ethereum'}. Contrast
    // Arbitrum, which needs 'arbitrum-one'. This value must equal the TARGETS key in
    // scripts/refresh-token-allowlist.mjs AND the generated ALLOWLIST_META.platform,
    // or `isAllowlisted` fails OPEN with no error.
    coingeckoPlatformId: 'robinhood',
    // Arbitrum Orbit L2 running bridged ETH as gas, so the native coin id is ETH's.
    coingeckoNativeId: 'ethereum',
    nativeToken: {
      symbol: 'ETH',
      address: ZERO_ADDRESS,
      decimals: 18,
    },
    wrappedNativeToken: {
      symbol: 'WETH',
      // Agrees across four indexer trees (envio chains.ts:568, v4-subgraph, ponder
      // networks.json:184, substreams.yaml) AND is confirmed externally: DeFiLlama
      // returns symbol WETH/18dec, and CoinGecko lists it as
      // `robinhood-wrapped-eth-robinhood-chain`.
      address: '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73',
      decimals: 18,
    },
    // ONLY true $1 tokens: `classifyAnchor` → 'stable' hard-pegs `counterTokenUsd` to 1
    // (pricing.service.ts:1354). USDG is Paxos-issued NATIVELY on 4663 (it reverts
    // l1Address() with custom error 0x800ab12c — a bridge-provenance validator would
    // reject the chain's single most important token). 6 decimals, confirmed by
    // DeFiLlama, GeckoTerminal and CoinGecko (coin id `global-dollar`). The real
    // 6-decimal USDG is out-held by 18-decimal impostors, so decimals are the tell.
    stablecoins: [
      '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168', // USDG — Global Dollar, 6 dec
    ],
    // Non-$1 anchor counterparties. USDe is a SYNTHETIC dollar that can depeg, so it is
    // deliberately here and NOT in `stablecoins` — the same call as on Arbitrum
    // (chains.config.ts:148), and it is literally the same address, Ethena's canonical
    // same-address multichain deploy. ~$1.0M reserves with two-sided daily flow.
    //
    // cbBTC (0xCEC185…, $477k) and syrupUSDG (0x40858070…, $440k) are CoinGecko-listed
    // and priced fine WITHOUT being anchors; they are excluded on purpose because an
    // anchor bypasses both the allowlist and the DEX-market gate, and sub-$500k depth
    // does not earn that on a chain where DEPLOY.md documents $27.3B of forged reserves
    // bought for cents. Promote them only if real depth arrives.
    trustedTokens: [
      '0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34', // USDe (synthetic dollar)
    ],
    // A Graph-dialect endpoint exists (the Envio indexer serves The Graph's query
    // dialect in-process), even though The Graph itself publishes no subgraph service
    // for 4663. Declarative only — nothing reads this field; `buildIntegrations` keys
    // off URL presence.
    supportsSubgraphs: true,
    // 101.00 ms/block measured over 7 days (5,979,024 blocks / 603,901s) and 100.42 ms
    // over 30 days (25,803,740 / 2,591,101s) via the DeFiLlama block endpoint; viem's
    // own chain definition independently reports blockTime: 100. ~9.90 blocks/sec,
    // ~855k blocks/day. 120x faster than mainnet, so the time-scaled lag budget is 120x
    // its block count (INDEXER_MAX_LAG_BLOCKS 250 ⇒ 30,000 blocks here).
    blockTimeMs: 100,
  },
};

export function getChainConfig(chainId: number): ChainConfig | undefined {
  return CHAINS[chainId];
}

/**
 * Canonical contract address(es) for high-value "major" token symbols, per chain.
 * Used by the symbol-spoof guard: a token whose on-chain symbol impersonates one
 * of these majors but whose address is NOT canonical is a scam (e.g. a fake
 * "USDC" `0xc93a…` priced 3e-8 in a thin pool). Such a token must never receive a
 * trusted price, regardless of pool depth. Symbols are compared upper-cased/trimmed.
 *
 * Only the trusted-priced majors are protected — impersonating a long-tail token
 * gains a scammer nothing (it would be priced like any other long-tail token).
 */
export const PROTECTED_MAJOR_ADDRESSES: Record<number, Record<string, string[]>> = {
  1: {
    USDC: ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'],
    USDT: ['0xdAC17F958D2ee523a2206206994597C13D831ec7'],
    DAI: ['0x6B175474E89094C44Da98b954EedeAC495271d0F'],
    TUSD: ['0x0000000000085d4780B73119b644AE5ecd22b376'],
    BUSD: ['0x4Fabb145d64652a948d72533023f6E7A623C7C53'],
    FRAX: ['0x853d955aCEf822Db058eb8505911ED77F175b99e'],
    GHO: ['0x40D16FC0246aD3160Ccc09B8D0D3A2cD28aE6C2f'],
    WETH: ['0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'],
    ETH: [ZERO_ADDRESS, '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'],
    WBTC: ['0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599'],
    STETH: ['0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84'],
    WSTETH: ['0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0'],
    RETH: ['0xae78736Cd615f374D3085123A210448E74Fc6393'],
  },
  43114: {
    USDC: [
      '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', // native Circle USDC
      '0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664', // bridged USDC.e (same "USDC" symbol historically)
    ],
    USDT: [
      '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7', // native USDt
      '0xc7198437980c041c805A1EDcbA50c1Ce5db95118', // bridged USDT.e
    ],
    DAI: ['0xd586E7F844cEa2F87f50152665BCbc2C279D8d70'], // DAI.e
    // Native gas token is AVAX (NOT ETH) — protect AVAX/WAVAX, not ETH/WETH.
    AVAX: [ZERO_ADDRESS, '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7'],
    WAVAX: ['0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7'],
    WETH: ['0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB'], // WETH.e — a trusted-priced bridged major scammers impersonate
    BTC: ['0x152b9d0FdC40C096757f570a51E494bd4b943E50'], // BTC.b
    SAVAX: ['0x2b2C81e08f1Af8835a78Bb2A90AE924ACE0eA4bE'],
  },
  42161: {
    // Both native Circle USDC and bridged USDC.e legitimately report "USDC".
    USDC: [
      '0xaf88d065e77C8cC2239327C5EDb3A432268e5831',
      '0xFF970A61a04b1cA14834A43f5dE4533eBDDB5CC8',
    ],
    // Tether on Arbitrum now reports the rebranded symbol `USD₮0` (with U+20AE),
    // so BOTH spellings are protected against the one canonical address — a
    // spoofer will use the plain-ASCII "USDT" that users actually type.
    USDT: ['0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9'],
    'USD₮0': ['0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9'],
    DAI: ['0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1'],
    FRAX: ['0x17FC002b466eEc40DaE837Fc4bE5c67993ddBd6F'],
    CRVUSD: ['0x498Bf2B1e120FeD3ad3D42EA2165E9b73f99C1e5'],
    USDE: ['0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34'],
    // Native gas token is ETH, so protect ETH/WETH (as on mainnet).
    ETH: [ZERO_ADDRESS, '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'],
    WETH: ['0x82aF49447D8a07e3bd95BD0d56f35241523fBab1'],
    WBTC: ['0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f'],
    CBBTC: ['0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf'],
    TBTC: ['0x6c84a8f1c29108F47a79964b5Fe888D4f4D0dE40'],
    WSTETH: ['0x5979D7b546E38E414F7E9822514be443A4800529'],
    RETH: ['0xEC70Dcb4A1EFa46b8F2D97C310C9c4790ba5ffA8'],
    WEETH: ['0x35751007a407ca6FEFfE80b3cB397736D2cf4dbe'],
    ARB: ['0x912CE59144191C1204E64559FE8253a0e49E6548'],
    // Protected but NOT trusted: LINK is a heavily-impersonated major, and
    // protecting a symbol costs nothing even when it is not an anchor.
    LINK: ['0xf97f4df75117a78c1A5a0DBb814Af92458539FB4'],
  },
  4663: {
    // Native gas token is ETH (Arbitrum Orbit L2 on bridged ETH), so protect ETH/WETH
    // as on mainnet — NOT AVAX/WAVAX. Test 8 checks exactly this.
    ETH: [ZERO_ADDRESS, '0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'],
    WETH: ['0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73'],
    // The chain's only real dollar, natively issued by Paxos at 6 decimals. Known
    // impostors (DEPLOY.md, both showing reputation: ok on both explorers):
    // 0x2CE3E396E069Ac9FA62046F423267072E06E77af — 104k holders, 18 dec, 1e9 supply,
    // $2.06M displayed against 0.0019 WETH of real value — and 0x42B4FA90438eCB1A0C2676ff25A9F27355DD53c2.
    // Other fake USDGs reach 143k/118k/103k holders vs the real one's 74k, so holder
    // count actively picks the FAKE. This line is what catches them all.
    USDG: ['0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'],
    // Ethena's canonical same-address multichain deploy (same address we protect on
    // Arbitrum). Documented fake: 0x305522425559E870881088Dc349E76857507cbBA, ~$2.2B displayed.
    USDE: ['0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34'],
    // Yield-bearing USDG wrapper, 6 dec, CoinGecko `syrup-usdg`. Protected but NOT
    // trusted — protecting a symbol costs nothing even when it is not an anchor.
    SYRUPUSDG: ['0x40858070814a57FdF33a613ae84fE0a8b4a874f7'],
    // 8 dec, CoinGecko `coinbase-wrapped-btc`, ~$477k reserve. NOTE: ponder/DEPLOY.md
    // (2026-08-17) recorded cbBTC as 0 supply / 0 holders / 0 pools; that is now STALE —
    // it has since gained real liquidity. Protected, not trusted.
    CBBTC: ['0xCEC185eB182c47d1bA1EFc84e6959e18cd620Be4'],
    // Heavily-impersonated major; same protected-not-trusted treatment as Arbitrum's.
    LINK: ['0x492641F648a4986844848E0beFE66D14817bCE34'],
    //
    // ── Genuine bridged deployments with ~zero liquidity ──────────────────────────
    // Each round-trips to its Ethereum original via l1Address() (verified on-chain
    // 2026-08-17, ponder/DEPLOY.md), and I independently confirmed each carries the
    // CORRECT decimals for its asset via GeckoTerminal 2026-09-02 — which is the tell
    // that separates them from impostors. Reserves are ~$101 / $0.73 / $0.00 / $41, so
    // they are deliberately absent from `stablecoins` and `trustedTokens`: they can
    // never produce a quote. They are here because knowing the canonical address is
    // what makes every impostor of these symbols detectable. There is NO native
    // issuance on 4663 for any of them (Circle has no CCTP domain here, USDT is absent
    // from Tether's and USDT0's deployments, wstETH is absent from Lido's), so these
    // dead bridged versions are the ONLY versions.
    USDC: ['0x80e0e24718dbFcad49ECAA6F1e6C89A190586cA8'], // 6 dec — Circle NEVER ships 18
    USDT: ['0xE246BC49b0598d7Cd9f0eAD48B885034f1254380'], // 6 dec
    WBTC: ['0x6bac06600D220Ac5Ac281AD1f504D2Cf0F90F6e6'], // 8 dec
    WSTETH: ['0xcD26A6AA5BB008240A998E242F51232FE98B12Cb'], // 18 dec — a fake matches symbol, name AND decimals, so only the address separates them
    //
    // ── Symbols with NO canonical deployment on 4663 at all ───────────────────────
    // ZERO_ADDRESS, never `[]`: isSymbolSpoof returns FALSE when `!canonical`
    // (chains.config.ts:259), so an empty array would UN-protect the symbol instead of
    // universally flagging it. Safe because a scan of all 19,496 CoinGecko coins finds
    // no DAI, stETH or USDS contract on platform `robinhood`, and ZERO_ADDRESS is
    // native ETH, whose symbol is never one of these. DEPLOY.md records a fake DAI at
    // ~$2.3B displayed and a fake USDS at ~$4.97B against $0.30 of real quote token.
    DAI: [ZERO_ADDRESS],
    STETH: [ZERO_ADDRESS],
    USDS: [ZERO_ADDRESS],
  },
};

/**
 * True when `symbol` impersonates a protected major but `address` is not its
 * canonical contract — i.e. a symbol-spoofing scam token. False for the real
 * majors, for non-major symbols, and for unknown chains (fail-open: the deeper
 * pricing-confidence guards still apply).
 */
export function isSymbolSpoof(chainId: number, symbol: string | undefined, address: string): boolean {
  if (!symbol) return false;
  const protectedMap = PROTECTED_MAJOR_ADDRESSES[chainId];
  if (!protectedMap) return false;
  const key = symbol.trim().toUpperCase();
  const canonical = protectedMap[key];
  if (!canonical) return false;
  const normalized = address.toLowerCase();
  return !canonical.some((candidate) => candidate.toLowerCase() === normalized);
}

/**
 * The airdrop-phishing token class, read off the SYMBOL alone: a symbol that
 * carries a link — a URL scheme (`https://t.me/eth_launchpad_tokens`, chain 1),
 * `www.` + a host, a host followed by a path (`discord.gg/bankr`, `t.me/…`) —
 * or the call to action "visit" as a whole word (`Visit usualget.pro to claim`,
 * `Visit Aerocoin.xyz swap`, both 42161). Read by the ranked-list exclusion
 * (`TokensRepository.findSpamAddresses`) and the per-row flags
 * (`security/token-identity.ts`), never by pricing.
 *
 * Deliberately NARROW, calibrated on the live indexer's symbols (2026-10-06):
 *  - SYMBOL only, never the name — hundreds of real tokens carry a domain in
 *    their NAME (xFUND `unification.com/xfund`, `RWA.xyz`, `r00t.io`);
 *  - a bare domain-style ticker is NOT a signal: 1,562 dotted symbols there are
 *    overwhelmingly launchpad branding (`LEMON.FUN`, `si.gov`, `memecoin.ai`,
 *    `Sushi.com`, `SY SolvBTC.BERA`);
 *  - nor are the bare words CLAIM / AIRDROP / HTTPS / WWW (122 / 94 / 60 / 212
 *    symbols, almost all Robinhood memecoins — `CLAIMIT`, "Where is the
 *    airdrop?", "had to take profits sir"), so a bare `CLAIM` ticker is not
 *    caught (the chain-1 one is a 2-holder $0 stub the risky toggle hides);
 *  - ASCII only (no `u` flag, so no Unicode case folding): a non-ASCII
 *    character is never a signal (`USD₮0`, `𝕏Life` are real), and a homoglyph
 *    spoof (Cyrillic `USDС`) is not caught here — a known gap, not a false
 *    positive.
 */
const PHISHING_SYMBOL_PATTERNS: readonly RegExp[] = [
  /(?:https?|ftp):\/\//i,
  /\bwww\.[a-z0-9-]/i,
  /\b[a-z0-9][a-z0-9-]*\.[a-z]{2,24}\//i,
  /\bvisit\b/i,
];

export function isPhishingSymbol(symbol: string | null | undefined): boolean {
  if (typeof symbol !== 'string' || symbol.length === 0) return false;
  return PHISHING_SYMBOL_PATTERNS.some((pattern) => pattern.test(symbol));
}

/**
 * A MongoDB `$regex` SUPERSET of `isPhishingSymbol` (same alternatives with
 * their word boundaries dropped): a server-side pre-filter only, the JS rule
 * decides. Kept beside the rule it must cover; `token-identity.spec` checks
 * the cover on the calibration corpus.
 */
export const PHISHING_SYMBOL_PREFILTER_SOURCE = '(?:https?|ftp):\\/\\/|www\\.|\\.[a-z]{2,24}\\/|visit';

export function isStablecoin(chainId: number, address: string): boolean {
  const chain = getChainConfig(chainId);
  if (!chain) return false;
  const normalized = address.toLowerCase();
  return chain.stablecoins.some((candidate) => candidate.toLowerCase() === normalized);
}

export function isWrappedNative(chainId: number, address: string): boolean {
  const chain = getChainConfig(chainId);
  if (!chain) return false;
  const normalized = address.toLowerCase();
  return (
    normalized === chain.wrappedNativeToken.address.toLowerCase() ||
    normalized === chain.nativeToken.address.toLowerCase()
  );
}

export function isTrustedToken(chainId: number, address: string): boolean {
  const chain = getChainConfig(chainId);
  if (!chain || !chain.trustedTokens) return false;
  const normalized = address.toLowerCase();
  return chain.trustedTokens.some((candidate) => candidate.toLowerCase() === normalized);
}

// ─── Payment token registry (native on-chain rail) ──────────────────────────
//
// The DATA for which ERC-20s we accept as payment, on which chains, lives here
// with the rest of the chain knowledge. The parse/accept-list LOGIC and the
// USD⇄base-unit money conversions stay in `payment-tokens.config.ts`, which
// imports this — chain metadata here, money code there.
//
// IT IS A STANDALONE MAP, NOT PART OF THE `CHAINS` RECORD ABOVE, and that
// separation is deliberate and load-bearing:
//
//  - The payment chain set is DISJOINT from the indexed set. `CHAINS` holds the
//    chains we index positions on (Ethereum, Avalanche); we take payment on
//    Base / Arbitrum / Optimism / Polygon too, which have no `CHAINS` entry and
//    should not gain one just to hold a USDC address.
//  - `GET /v1/chains` maps over ALL of `CHAINS` and ~16 pricing providers
//    iterate it, so a payment-only chain added there would be advertised as a
//    supported DATA chain and fed to the pricing layer. Keying payment tokens
//    off their own map keeps that blast radius at zero.
//  - Trust here means "we will grant a plan when this contract pays us" — a
//    different question, and a different failure cost, from `stablecoins`
//    above ("we will price a position with this token"). Merging them would let
//    a pricing tweak change what we accept as money.
//
// DECIMALS is the field where an error is catastrophic (a 6-vs-18 slip makes
// every payment invisible or mis-sized), so `TokenVerificationService` checks
// each entry against the chain at boot — this table is the bootstrap, the chain
// is the authority.

/** One acceptable payment token on one chain. */
export interface PaymentToken {
  chainId: number;
  /** Uppercase ticker. The registry key, and what the UI shows. */
  symbol: string;
  /** ERC-20 contract, lowercased. Compared lowercased everywhere. */
  address: string;
  decimals: number;
  /**
   * USD stablecoin worth ~$1. Load-bearing: a stable token converts to an
   * invoice's USD amount by a fixed factor and needs no price feed; a non-stable
   * one needs a rate locked at checkout, which does not exist yet, so the
   * provider refuses it.
   */
  stable: boolean;
}

/** Keyed `SYMBOL:chainId`. Circle-native USDC / USDT / DAI on the paid chains. */
export const PAYMENT_TOKEN_REGISTRY: Record<string, PaymentToken> = Object.freeze({
  // ── EVERY ENTRY HERE MUST IMPLEMENT EIP-3009. ──
  //
  // This registry is no longer just a convenience table of addresses: with
  // `PAYMENT_ACCEPTED_TOKENS` left empty, `AppConfigService.acceptedPaymentTokens`
  // DERIVES what we accept as (every entry here) × (every chain in
  // `EVM_RPC_URLS`). So an entry that cannot be signed for is not a harmless
  // extra — it is a token the checkout will offer and the token contract will
  // then refuse, at the last step, after the customer has signed.
  //
  // `Eip3009DomainService` probes `authorizationState` at boot and refuses a token
  // that does not answer, so a mistake here is caught loudly rather than sold to a
  // customer. That is the safety net, not the plan: keep this list correct.
  //
  // DELIBERATELY ABSENT, and do not "helpfully" re-add them:
  //   USDT — Tether implements NO EIP-3009 on any chain. It was in this table
  //          while the rail was a plain-transfer deposit rail, where any ERC-20
  //          worked. On a signature rail it is unpayable.
  //   DAI  — has its own `permit` (EIP-2612), which is approve-then-pull and
  //          needs a contract to do the pulling. Not `transferWithAuthorization`.
  //
  // Circle's other FiatTokens (EURC) and the Paxos family (PYUSD, USDP) DO
  // implement EIP-3009, but are left out until someone verifies the exact address
  // and deployment they want — an unverified address in a money table is the one
  // mistake this file cannot afford, and the accept-list derivation would pick it
  // up automatically.
  'USDC:1': { chainId: 1, symbol: 'USDC', address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', decimals: 6, stable: true },
  'USDC:8453': { chainId: 8453, symbol: 'USDC', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', decimals: 6, stable: true },
  'USDC:42161': { chainId: 42161, symbol: 'USDC', address: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', decimals: 6, stable: true },
  'USDC:10': { chainId: 10, symbol: 'USDC', address: '0x0b2c639c533813f4aa9d7837caf62653d097ff85', decimals: 6, stable: true },
  'USDC:137': { chainId: 137, symbol: 'USDC', address: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', decimals: 6, stable: true },
  'USDC:43114': { chainId: 43114, symbol: 'USDC', address: '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e', decimals: 6, stable: true },
});

/**
 * Payment-network display names. A wrong network loses funds, so these are the
 * short, warning-appropriate names shown at checkout — deliberately not the
 * verbose `CHAINS[…].name` ("Ethereum Mainnet"), and defined for the paid
 * chains that have no `CHAINS` entry at all (Base, Arbitrum, …).
 */
export const PAYMENT_CHAIN_NAMES: Record<number, string> = Object.freeze({
  1: 'Ethereum',
  10: 'Optimism',
  137: 'Polygon',
  8453: 'Base',
  42161: 'Arbitrum One',
  43114: 'Avalanche C-Chain',
});

export function paymentChainName(chainId: number): string {
  return PAYMENT_CHAIN_NAMES[chainId] ?? `chain ${chainId}`;
}

/**
 * Block explorers for the PAID chains, so a customer can watch their own payment
 * confirm instead of taking our word for it.
 *
 * Separate from `ChainConfig.explorerUrl` for the same reason `PAYMENT_CHAIN_NAMES`
 * is separate from `CHAINS[…].name`: the paid chain set is disjoint from the
 * indexed one, and Base and Arbitrum have no `CHAINS` entry at all.
 */
export const PAYMENT_CHAIN_EXPLORERS: Record<number, string> = Object.freeze({
  1: 'https://etherscan.io',
  10: 'https://optimistic.etherscan.io',
  137: 'https://polygonscan.com',
  8453: 'https://basescan.org',
  42161: 'https://arbiscan.io',
  43114: 'https://snowtrace.io',
});

/** A transaction's explorer URL, or '' when the chain has no known explorer. */
export function paymentTxUrl(chainId: number, txHash: string): string {
  const base = PAYMENT_CHAIN_EXPLORERS[chainId];
  return base ? `${base}/tx/${txHash}` : '';
}

// ---------------------------------------------------------------------------
// Uniswap v4 read contracts — one entry per chain the Envio indexer supports.
//
// A STANDALONE map on purpose, not a field on `CHAINS`: `CHAINS` is consumed by
// every pricing provider and pinned by chain-registry-exhaustiveness.spec, so
// listing a chain there means "we price and serve it". This map only says
// "here are its v4 contracts" — so it can cover every chain Envio supports, and
// a chain added to `CHAINS` later picks its addresses up from here with no other
// change. The exhaustiveness spec asserts every `CHAINS` entry has one.
//
// Copied from the indexer's src/utils/v4Addresses.ts (doryoku/main), where each
// StateView was verified ON-CHAIN by checking StateView.poolManager() equals the
// same chain's PositionManager.poolManager(). A wrong address does not fail
// loudly — reads revert or return another deployment's state — so never edit one
// without repeating that check. `positionManager` is the OWNER argument to
// StateView.getPositionInfo: in v4 the PositionManager holds the pool position
// on the NFT holder's behalf.
// ---------------------------------------------------------------------------

/** Multicall3 at its canonical address (the indexer uses it on every chain below). */
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' as const;

export interface UniswapV4Contracts {
  readonly stateView: `0x${string}`;
  readonly positionManager: `0x${string}`;
}

export const UNISWAP_V4_CONTRACTS: Readonly<Record<number, UniswapV4Contracts>> = Object.freeze({
  1: { stateView: '0x7ffe42c4a5deea5b0fec41c94c136cf115597227', positionManager: '0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e' }, // ethereum
  10: { stateView: '0xc18a3169788f4f75a170290584eca6395c75ecdb', positionManager: '0x3c3ea4b57a46241e54610e5f022e5c45859a1017' }, // optimism
  56: { stateView: '0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4', positionManager: '0x7a4a5c919ae2541aed11041a1aeee68f1287f95b' }, // bnb chain
  130: { stateView: '0x86e8631a016f9068c3f085faf484ee3f5fdee8f2', positionManager: '0x4529a01c7a0410167c5740c487a8de60232617bf' }, // unichain
  137: { stateView: '0x5ea1bd7974c8a611cbab0bdcafcb1d9cc9b3ba5a', positionManager: '0x1ec2ebf4f37e7363fdfe3551602425af0b3ceef9' }, // polygon
  143: { stateView: '0x77395f3b2e73ae90843717371294fa97cc419d64', positionManager: '0x5b7ec4a94ff9bedb700fb82ab09d5846972f4016' }, // monad
  480: { stateView: '0x51d394718bc09297262e368c1a481217fdeb71eb', positionManager: '0xc585e0f504613b5fbf874f21af14c65260fb41fa' }, // world chain
  1868: { stateView: '0x76fd297e2d437cd7f76d50f01afe6160f86e9990', positionManager: '0x1b35d13a2e2528f192637f14b05f0dc0e7deb566' }, // soneium
  4326: { stateView: '0x726f84e1dfb8d375a365e0808282f40d52d3e4e8', positionManager: '0x9ae0921e981aaa7308f176f8d4f9129b9247c89d' }, // megaeth
  4663: { stateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b', positionManager: '0x58daec3116aae6d93017baaea7749052e8a04fa7' }, // robinhood
  8453: { stateView: '0xa3c0c9b65bad0b08107aa264b0f3db444b867a71', positionManager: '0x7c5f5a4bbd8fd63184577525326123b519429bdc' }, // base
  42161: { stateView: '0x76fd297e2d437cd7f76d50f01afe6160f86e9990', positionManager: '0xd88f38f930b7952f2db2432cb002e7abbf3dd869' }, // arbitrum one
  42220: { stateView: '0xbc21f8720babf4b20d195ee5c6e99c52b76f2bfb', positionManager: '0xf7965f3981e4d5bc383bfbcb61501763e9068ca9' }, // celo
  43114: { stateView: '0xc3c9e198c735a4b97e3e683f391ccbdd60b69286', positionManager: '0xb74b1f14d2754acfcbbe1a221023a5cf50ab8acd' }, // avalanche
  57073: { stateView: '0x76fd297e2d437cd7f76d50f01afe6160f86e9990', positionManager: '0x1b35d13a2e2528f192637f14b05f0dc0e7deb566' }, // ink
  59144: { stateView: '0xe861de206e460a8b936b05ad3816520b58ccdf9b', positionManager: '0xddcad5775b2816a87495f207731b3571d7ee3c76' }, // linea
  81457: { stateView: '0x12a88ae16f46dce4e8b15368008ab3380885df30', positionManager: '0x4ad2f4cca2682cbb5b950d660dd458a1d3f1baad' }, // blast
  7777777: { stateView: '0x385785af07d63b50d0a0ea57c4ff89d06adf7328', positionManager: '0xf66c7b99e2040f0d9b326b3b7c152e9663543d63' }, // zora
});

export function uniswapV4ContractsFor(chainId: number): UniswapV4Contracts | undefined {
  return UNISWAP_V4_CONTRACTS[chainId];
}
