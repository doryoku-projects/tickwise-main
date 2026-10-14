import { describe, expect, it } from 'vitest';
import {
  CHAINS,
  PROTECTED_MAJOR_ADDRESSES,
  UNISWAP_V4_CONTRACTS,
  ZERO_ADDRESS,
  isStablecoin,
  isSymbolSpoof,
  isWrappedNative,
} from '../src/config/chains.config.js';
import { LLAMA_CHAIN_SLUG } from '../src/health/indexing-status.service.js';
import { GT_NETWORK_SLUG } from '../src/pricing/providers/geckoterminal.provider.js';
import { DEXSCREENER_CHAIN } from '../src/pricing/providers/dexscreener.provider.js';
import { DIA_CHAIN } from '../src/pricing/providers/dia.provider.js';
import { ALCHEMY_NETWORK_SLUG } from '../src/pricing/providers/alchemy.provider.js';
import { MORALIS_CHAIN_SLUG } from '../src/pricing/providers/moralis.provider.js';
import { allowlistSize } from '../src/pricing/token-allowlist.js';

/**
 * Adding a chain to `CHAINS` is only half the job: ~10 further per-chain maps
 * must gain an entry, and NONE of them is a type error when missed — they return
 * undefined/null and the chain degrades silently, in two opposite directions:
 *
 *   FAILS CLOSED — the DEX/price provider slug maps. No slug ⇒ no DEX source ⇒
 *     with DEX_MARKET_FAIL_CLOSED=true (the default) every non-anchor leg values
 *     at $0 and those positions drop out of every ranked view.
 *   FAILS OPEN  — `PROTECTED_MAJOR_ADDRESSES` (symbol-spoof guard returns false
 *     for an unknown chain) and the CoinGecko allowlist (`isAllowlisted` returns
 *     true when there is no snapshot). On a chain with symbol squatting that is
 *     the whole defence.
 *
 * This spec is the cheapest mitigation for both. It is deliberately a hard
 * assertion over `Object.keys(CHAINS)` rather than a per-chain list, so a NEW
 * chain fails the build until every map is filled in.
 *
 * A map that genuinely does not cover a chain must be opted out EXPLICITLY below,
 * with a reason — silence is what this test exists to prevent.
 */

const CHAIN_IDS = Object.keys(CHAINS).map(Number);

/**
 * Vendors that verifiably do not cover a chain. An entry here is a claim that the
 * vendor was checked and came back negative — not a TODO. Keep the reason current.
 */
const VENDOR_COVERAGE_EXEMPTIONS: Record<string, { chainId: number; reason: string }[]> = {
  dia: [
    {
      chainId: 4663,
      reason:
        "Probed 2026-09-02: DIA's own GET /v1/blockchains returns 121 chains and Robinhood " +
        "is not among them (Ethereum/Avalanche/Arbitrum are). Note the per-asset 404 is " +
        "NOT evidence — assetQuotation/<unknown chain>/<addr> and " +
        "assetQuotation/Robinhood/<real USDG> return the identical 404 'no rows in result " +
        "set', so the registry endpoint is the only discriminating probe. Capitalisation " +
        'variants and the native 0x0/WETH addresses were also swept: all 404.',
    },
  ],
  moralis: [
    {
      chainId: 4663,
      reason:
        "Probed 2026-09-02 KEYLESSLY, because both MORALIS_API_KEY values 401 with 'Free " +
        "usage is paused' on every chain incl. the known-good `arbitrum` control, so no " +
        'key-based probe is informative. Moralis’ own OpenAPI spec at ' +
        'deep-index.moralis.io/api-docs-2.2/v2.2/swagger.json enumerates exactly 52 ' +
        'accepted `chain` values in components.schemas.chainList; neither \'robinhood\', ' +
        "'4663' nor hex '0x1237' appears, while 'arbitrum'/'avalanche'/'eth' do.",
    },
  ],
};

function exempt(vendor: string, chainId: number): boolean {
  return (VENDOR_COVERAGE_EXEMPTIONS[vendor] ?? []).some((e) => e.chainId === chainId);
}

describe('chain registry exhaustiveness', () => {
  it('has at least the chains we ship', () => {
    expect(CHAIN_IDS.length).toBeGreaterThanOrEqual(2);
  });

  it('keys every CHAINS entry by its own chainId', () => {
    for (const id of CHAIN_IDS) {
      expect(CHAINS[id].chainId, `CHAINS[${id}].chainId must equal its key`).toBe(id);
    }
  });

  // `slug` is the DeFiLlama vendor namespace AND the price/DEX-market cache
  // namespace. A duplicate cross-contaminates two chains' price caches by
  // address, which is silent and very hard to trace back.
  it('gives every chain a unique, non-empty slug', () => {
    const slugs = CHAIN_IDS.map((id) => CHAINS[id].slug);
    expect(slugs.every((s) => typeof s === 'string' && s.length > 0)).toBe(true);
    expect(new Set(slugs).size, `slugs must be unique, got ${slugs.join(', ')}`).toBe(slugs.length);
  });

  it('gives every chain a plausible blockTimeMs', () => {
    for (const id of CHAIN_IDS) {
      const ms = CHAINS[id].blockTimeMs;
      expect(typeof ms, `CHAINS[${id}].blockTimeMs`).toBe('number');
      // 50ms..60s — catches a seconds-vs-ms slip, which silently scales the
      // indexer lag budget by 1000x in whichever direction is wrong.
      expect(ms, `CHAINS[${id}].blockTimeMs looks wrong: ${ms}`).toBeGreaterThanOrEqual(50);
      expect(ms, `CHAINS[${id}].blockTimeMs looks wrong: ${ms}`).toBeLessThanOrEqual(60_000);
    }
  });

  it('gives every chain an explorer URL with no trailing slash', () => {
    for (const id of CHAIN_IDS) {
      const url = CHAINS[id].explorerUrl;
      expect(url, `CHAINS[${id}].explorerUrl`).toMatch(/^https:\/\//);
      expect(url.endsWith('/'), `CHAINS[${id}].explorerUrl must not end in '/'`).toBe(false);
    }
  });

  // The on-chain fee refresh reads StateView per chain. A chain added to CHAINS
  // without its v4 contracts would silently serve indexer-only fees — fail here
  // instead. Addresses must be copied from the indexer's on-chain-verified table.
  it('gives every chain its Uniswap v4 StateView and PositionManager', () => {
    for (const id of CHAIN_IDS) {
      const c = UNISWAP_V4_CONTRACTS[id];
      expect(c, `UNISWAP_V4_CONTRACTS[${id}] missing in chains.config.ts`).toBeDefined();
      expect(c.stateView, `UNISWAP_V4_CONTRACTS[${id}].stateView`).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(c.positionManager, `UNISWAP_V4_CONTRACTS[${id}].positionManager`).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  it('uses ZERO_ADDRESS for every native token', () => {
    for (const id of CHAIN_IDS) {
      expect(CHAINS[id].nativeToken.address, `CHAINS[${id}].nativeToken`).toBe(ZERO_ADDRESS);
    }
  });

  // ─── the silent-failure maps ───────────────────────────────────────────────

  // FAILS OPEN. `isSymbolSpoof` returns false for a chain with no entry, so a
  // fake "USDG"/"USDC" would be priced like the real one.
  it('protects majors on every chain (symbol-spoof guard fails OPEN without it)', () => {
    for (const id of CHAIN_IDS) {
      const majors = PROTECTED_MAJOR_ADDRESSES[id];
      expect(majors, `PROTECTED_MAJOR_ADDRESSES[${id}] missing — spoof guard fails open`).toBeDefined();
      expect(Object.keys(majors).length, `PROTECTED_MAJOR_ADDRESSES[${id}] is empty`).toBeGreaterThan(0);
    }
  });

  // The guard must protect the chain's OWN native/wrapped symbols, not ETH's.
  it('protects each chain native + wrapped-native symbol', () => {
    for (const id of CHAIN_IDS) {
      const chain = CHAINS[id];
      const majors = PROTECTED_MAJOR_ADDRESSES[id];
      for (const symbol of [chain.nativeToken.symbol, chain.wrappedNativeToken.symbol]) {
        expect(
          majors[symbol.toUpperCase()],
          `PROTECTED_MAJOR_ADDRESSES[${id}] must protect '${symbol}'`,
        ).toBeDefined();
      }
    }
  });

  // Every protected symbol must actually catch an impostor, and clear the real one.
  it('flags an impostor and clears the canonical address for every protected major', () => {
    const impostor = '0xdead000000000000000000000000000000000000';
    for (const id of CHAIN_IDS) {
      for (const [symbol, canonical] of Object.entries(PROTECTED_MAJOR_ADDRESSES[id])) {
        expect(isSymbolSpoof(id, symbol, impostor), `${id}/${symbol} must flag an impostor`).toBe(true);
        for (const addr of canonical) {
          expect(isSymbolSpoof(id, symbol, addr), `${id}/${symbol} must clear ${addr}`).toBe(false);
          expect(
            isSymbolSpoof(id, symbol, addr.toUpperCase().replace('0X', '0x')),
            `${id}/${symbol} must be case-insensitive`,
          ).toBe(false);
        }
      }
    }
  });

  // FAILS SILENT. No slug ⇒ chain head unknown ⇒ `synced` stays true and lag
  // stops being measured entirely.
  it('maps every chain for the DeFiLlama block endpoint', () => {
    for (const id of CHAIN_IDS) {
      expect(LLAMA_CHAIN_SLUG[id], `LLAMA_CHAIN_SLUG[${id}] missing — indexer lag goes unmeasured`).toBeTruthy();
    }
  });

  // FAILS CLOSED, and this pair is load-bearing: DEX_MARKET_SOURCES is exactly
  // {dexscreener, geckoterminal}, so if NEITHER covers a chain then with
  // DEX_MARKET_FAIL_CLOSED=true every non-anchor token on it values at $0.
  it('covers every chain with at least one DEX market source', () => {
    for (const id of CHAIN_IDS) {
      const covered = Boolean(DEXSCREENER_CHAIN[id]) || Boolean(GT_NETWORK_SLUG[id]);
      expect(
        covered || exempt('dex-market', id),
        `chain ${id} has neither a DexScreener nor a GeckoTerminal slug — every non-anchor token prices at $0 under DEX_MARKET_FAIL_CLOSED`,
      ).toBe(true);
    }
  });

  it.each([
    ['geckoterminal', GT_NETWORK_SLUG],
    ['dexscreener', DEXSCREENER_CHAIN],
    ['dia', DIA_CHAIN],
    ['alchemy', ALCHEMY_NETWORK_SLUG],
    ['moralis', MORALIS_CHAIN_SLUG],
  ] as const)('maps every chain for %s (or exempts it explicitly)', (vendor, map) => {
    for (const id of CHAIN_IDS) {
      expect(
        Boolean(map[id]) || exempt(vendor, id),
        `${vendor} has no slug for chain ${id}; add one, or add an explicit VENDOR_COVERAGE_EXEMPTIONS['${vendor}'] entry with a reason`,
      ).toBe(true);
    }
  });

  // Vendor slugs are per-vendor vocabularies with no derivable rule, so a
  // duplicate almost always means a copy-paste from the neighbouring chain.
  it.each([
    ['geckoterminal', GT_NETWORK_SLUG],
    ['dexscreener', DEXSCREENER_CHAIN],
    ['dia', DIA_CHAIN],
    ['alchemy', ALCHEMY_NETWORK_SLUG],
    ['moralis', MORALIS_CHAIN_SLUG],
    ['defillama-block', LLAMA_CHAIN_SLUG],
  ] as const)('never reuses one %s slug for two chains', (vendor, map) => {
    const present = CHAIN_IDS.map((id) => map[id]).filter(Boolean);
    expect(new Set(present).size, `${vendor} slugs must be unique, got ${present.join(', ')}`).toBe(present.length);
  });

  // FAILS OPEN. `isAllowlisted` returns true when a chain has no committed
  // snapshot, so every token on it is trusted for USD valuation.
  it('reports allowlist coverage per chain (fails OPEN when absent)', () => {
    const uncovered = CHAIN_IDS.filter((id) => CHAINS[id].coingeckoPlatformId && allowlistSize(id) === 0);
    expect(
      uncovered,
      `these chains declare a coingeckoPlatformId but have an EMPTY committed allowlist, so every token on them is trusted: ${uncovered.join(', ')}. Run: node scripts/refresh-token-allowlist.mjs <platform>`,
    ).toEqual([]);
  });

  // ─── anchors must be self-consistent ──────────────────────────────────────

  it('recognises its own declared stablecoins and wrapped native', () => {
    for (const id of CHAIN_IDS) {
      const chain = CHAINS[id];
      for (const stable of chain.stablecoins) {
        expect(isStablecoin(id, stable), `CHAINS[${id}] must recognise its own stablecoin ${stable}`).toBe(true);
        expect(isStablecoin(id, stable.toLowerCase()), 'isStablecoin must be case-insensitive').toBe(true);
      }
      expect(isWrappedNative(id, chain.wrappedNativeToken.address)).toBe(true);
      expect(isWrappedNative(id, chain.nativeToken.address)).toBe(true);
    }
  });

  it('never lists the same address twice within one chain anchor set', () => {
    for (const id of CHAIN_IDS) {
      const chain = CHAINS[id];
      const all = [...chain.stablecoins, ...(chain.trustedTokens ?? [])].map((a) => a.toLowerCase());
      expect(new Set(all).size, `CHAINS[${id}] repeats an anchor address`).toBe(all.length);
    }
  });

  it('uses checksum-shaped, well-formed addresses throughout', () => {
    for (const id of CHAIN_IDS) {
      const chain = CHAINS[id];
      const addrs = [
        chain.wrappedNativeToken.address,
        ...chain.stablecoins,
        ...(chain.trustedTokens ?? []),
        ...Object.values(PROTECTED_MAJOR_ADDRESSES[id] ?? {}).flat(),
      ];
      for (const a of addrs) {
        expect(a, `CHAINS[${id}] has a malformed address: ${a}`).toMatch(/^0x[0-9a-fA-F]{40}$/);
      }
    }
  });
});
