/**
 * The end-to-end fixture of the impact-report specs: a driver-shaped
 * in-memory database seeded with the cases from
 * docs/spam-and-pool-mismatch-2026-10-05.md (AERGO/HPP in a 99.99%-fee pool on
 * a stale single DIA quote, BTC.b/cbBTC — a real pool the allowlist hides —, a
 * THALES-class allowlisted token with no DEX market, a frozen indexer
 * amount), and `run`, which drives the REAL `runReport` over it. Shared by
 * report.spec.ts and the combined / coverage / exemption / probe specs.
 */
import { parseArgs, resolveThresholds, runReport, readOnlyDb } from '../../scripts/valuation-impact-report.mjs';
import { getSqrtRatioAtTick } from '../../src/pricing/tick-math.js';
import { fakeDb } from './fake-db.js';
import { sweepEvidence } from './sweep-evidence.js';

export const NOW = Date.UTC(2026, 9, 5, 12);
export const HOUR = 3_600_000;
export const ETH = '0x0000000000000000000000000000000000000000';
export const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
export const AERGO = '0x91af0fbb28aba7e31403cb457106ce79397fd4e6';
export const HPP = '0xe33fbe7584eb79e2673abe576b7ac8c0de62565c';
export const BTCB = '0xb0f70c0bd6fd87dbeb7c10dc692a2a6106817072';
export const CBBTC = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf';
export const THALES = '0x8947da500eb47f82df21143d0c01a29862a8c3c5';
export const DIAONLY = '0x00000000000000000000000000000000000d1a00';
export const SPAM = '0x0000000000000000000000000000000000005a11';
export const LISTED_NOMKT = '0x000000000000012def132e61759048be5b5c6033'; // allowlisted, no DEX source, no verdict

export const POOL_BTC = '0x' + 'b'.repeat(64);
export const POOL_HPP = '0x770366d7da36f544886dcdbebb1dfa21fb88eb6ab5b3fe548a2ac1f16ff866c7';
export const POOL_ETH = '0x' + 'e'.repeat(64);
export const POOL_THALES = '0x' + 'a'.repeat(64);
export const POOL_DIA = '0x' + 'd'.repeat(64);
export const POOL_LISTED = '0x' + 'c'.repeat(64);

export const fresh = new Date(NOW - HOUR);
export const DAY = 24 * HOUR;


export function tokens() {
  return [
    { chainId: 1, address: USDC, symbol: 'USDC', priceUsd: 1, dexActive: true, priceSources: ['defillama', 'dexscreener'], priceConfidence: 'external-verified', pricedAt: fresh },
    { chainId: 1, address: ETH, symbol: 'ETH', priceUsd: 2700, dexActive: true, priceSources: ['defillama', 'dexscreener'], priceConfidence: 'external-verified', pricedAt: fresh },
    // Stale single DIA quote; the guarded sweep found nothing it would accept.
    {
      chainId: 1, address: HPP, symbol: 'HPP', priceUsd: 31374.53717473271, priceSources: ['dia'], priceConfidence: 'external-unverified', pricedAt: fresh, priceEvidenceAt: fresh,
      ...sweepEvidence([{ source: 'dia', priceUsd: 31374.53717473271, quotedAtMs: NOW - 140 * DAY, rejected: true }], ['dia'], ['dia:stale']),
    },
    { chainId: 1, address: AERGO, symbol: 'AERGO', priceUsd: 0.0095, dexActive: true, priceSources: ['defillama', 'geckoterminal'], priceConfidence: 'external-verified', pricedAt: fresh, trustEarned: true, trustReason: 'earned', trustEvaluatedAt: fresh },
    // Not allowlisted, but earned: two sources + a real multi-pool market.
    { chainId: 1, address: BTCB, symbol: 'BTC.b', priceUsd: 86000, dexActive: true, priceSources: ['defillama', 'dexscreener'], priceConfidence: 'external-verified', pricedAt: fresh, trustEarned: true, trustReason: 'earned', trustEvaluatedAt: fresh },
    { chainId: 1, address: CBBTC, symbol: 'cbBTC', priceUsd: 86300, dexActive: true, priceSources: ['defillama', 'dexscreener'], priceConfidence: 'external-verified', pricedAt: fresh, trustEarned: true, trustReason: 'earned', trustEvaluatedAt: fresh },
    // Allowlisted, no DEX market at all: no verdict stored, but the evidence decides it.
    { chainId: 1, address: THALES, symbol: 'THALES', priceUsd: 479020, dexActive: false, priceSources: ['coingecko'], priceConfidence: 'external-unverified', pricedAt: fresh },
    { chainId: 1, address: DIAONLY, symbol: 'DIAX', priceUsd: 2.5, dexActive: true, priceSources: ['dia'], priceConfidence: 'external-unverified', pricedAt: fresh },
    { chainId: 1, address: LISTED_NOMKT, symbol: 'LST', priceUsd: 3, priceSources: ['coingecko'], pricedAt: fresh },
    { chainId: 1, address: SPAM, symbol: 'SCAM', priceUsd: 1, dexActive: true, priceSources: ['dexscreener'], isHoneypot: true, pricedAt: fresh },
  ];
}

export const tok = (address: string, symbol: string, decimals: number, priceUsd: number) => ({ address, symbol, decimals, priceUsd });
export const btcTick = -35; // 1.0001^-35 ≈ 86000 / 86300

export function pools() {
  return [
    {
      chainId: 1, protocol: 'uniswap-v4', poolId: POOL_BTC, fee: 100,
      token0: { address: BTCB, symbol: 'BTC.b', decimals: 8 }, token1: { address: CBBTC, symbol: 'cbBTC', decimals: 8 },
      sqrtPriceX96: getSqrtRatioAtTick(btcTick).toString(), currentTick: btcTick,
      metrics: { tvlUsd: 0, tvlToken0: 50, tvlToken1: 50 }, pricing: { source: 'none', usedFallback: true },
    },
    {
      chainId: 1, protocol: 'uniswap-v4', poolId: POOL_HPP, fee: 999_993,
      token0: { address: AERGO, symbol: 'AERGO', decimals: 18 }, token1: { address: HPP, symbol: 'HPP', decimals: 18 },
      sqrtPriceX96: getSqrtRatioAtTick(110374).toString(), currentTick: 110374,
      metrics: { tvlUsd: 0, tvlToken0: 0.05, tvlToken1: 4741 }, pricing: { source: 'external', usedFallback: true },
    },
    {
      chainId: 1, protocol: 'uniswap-v4', poolId: POOL_ETH, fee: 500,
      token0: { address: ETH, symbol: 'ETH', decimals: 18 }, token1: { address: USDC, symbol: 'USDC', decimals: 6 },
      sqrtPriceX96: '0', currentTick: 0,
      metrics: { tvlUsd: 20_000_000, tvlToken0: 3700, tvlToken1: 10_000_000 }, pricing: { source: 'native-anchor', usedFallback: false },
    },
    {
      chainId: 1, protocol: 'uniswap-v4', poolId: POOL_LISTED, fee: 3000,
      token0: { address: LISTED_NOMKT, symbol: 'LST', decimals: 18 }, token1: { address: USDC, symbol: 'USDC', decimals: 6 },
      sqrtPriceX96: '0', currentTick: 0,
      metrics: { tvlUsd: 2_000_000, tvlToken0: 1, tvlToken1: 1_000_000 }, pricing: { source: 'external', usedFallback: false },
    },
    {
      chainId: 1, protocol: 'uniswap-v4', poolId: POOL_THALES, fee: 3000,
      token0: { address: THALES, symbol: 'THALES', decimals: 18 }, token1: { address: USDC, symbol: 'USDC', decimals: 6 },
      sqrtPriceX96: '0', currentTick: 0,
      metrics: { tvlUsd: 1_000_000, tvlToken0: 1, tvlToken1: 500_000 }, pricing: { source: 'external', usedFallback: false },
    },
  ];
}

export function positions() {
  const base = { chainId: 1, protocol: 'uniswap-v4', isActive: true, closedAtTimestamp: null, owner: '0x' + '1'.repeat(40), poolStats: { tvlUsd: 0 } };
  const rows = [
    {
      ...base, positionId: '366810', poolId: POOL_HPP, fee: 999_993, tickLower: 110280, tickUpper: 110460, liquidity: '3483295279090671660867',
      currentTick: 110374, sqrtPriceX96: getSqrtRatioAtTick(110374).toString(),
      token0: tok(AERGO, 'AERGO', 18, 0.00954066052972166), token1: tok(HPP, 'HPP', 18, 31374.53717473271),
      amounts: { amount0: '0.0491760085507995', amount1: '4741.299632609254' },
      metrics: { underlyingValueUsd: 0.0491760085507995 * 0.00954066052972166 + 4741.299632609254 * 31374.53717473271, inRange: true },
    },
    {
      ...base, positionId: '371154', poolId: POOL_BTC, fee: 100, tickLower: -200, tickUpper: 200, liquidity: '200000000000',
      currentTick: 0, sqrtPriceX96: getSqrtRatioAtTick(0).toString(), // the row's own (older) snapshot
      token0: tok(BTCB, 'BTC.b', 8, 86000), token1: tok(CBBTC, 'cbBTC', 8, 86300),
      amounts: { amount0: '53.96', amount1: '46.04' },
      metrics: { underlyingValueUsd: 53.96 * 86000 + 46.04 * 86300, inRange: true },
    },
    {
      ...base, positionId: '108486', poolId: POOL_THALES, fee: 3000, tickLower: -887220, tickUpper: 887220, liquidity: '1000',
      currentTick: 0, sqrtPriceX96: '0',
      token0: tok(THALES, 'THALES', 18, 479020), token1: tok(USDC, 'USDC', 6, 1),
      amounts: { amount0: '250', amount1: '0' },
      metrics: { underlyingValueUsd: 250 * 479020, inRange: true },
    },
    {
      ...base, positionId: '900001', poolId: POOL_DIA, fee: 3000, tickLower: -600, tickUpper: 600, liquidity: '0',
      currentTick: 0, sqrtPriceX96: getSqrtRatioAtTick(0).toString(),
      token0: tok(DIAONLY, 'DIAX', 18, 2.5), token1: tok(USDC, 'USDC', 6, 1),
      amounts: { amount0: '1000', amount1: '0' },
      metrics: { underlyingValueUsd: 2500, inRange: true },
    },
    {
      ...base, positionId: '900002', poolId: POOL_ETH, fee: 500, tickLower: -600, tickUpper: 600, liquidity: '1000000000000000000',
      currentTick: 0, sqrtPriceX96: getSqrtRatioAtTick(0).toString(),
      token0: tok(SPAM, 'SCAM', 18, 1), token1: tok(USDC, 'USDC', 6, 1),
      amounts: { amount0: '1000', amount1: '0' },
      metrics: { underlyingValueUsd: 1000, inRange: true },
    },
    // Closed rows: never part of the open walk; one sits in a honeypot pool.
    { ...base, positionId: '5', isActive: false, poolId: POOL_HPP, fee: 999_993, liquidity: '0', token0: tok(AERGO, 'AERGO', 18, 0), token1: tok(HPP, 'HPP', 18, 0), amounts: {}, metrics: {} },
    { ...base, positionId: '6', isActive: false, poolId: POOL_ETH, fee: 500, liquidity: '0', token0: tok(ETH, 'ETH', 18, 0), token1: tok(USDC, 'USDC', 6, 0), amounts: {}, metrics: {} },
  ];
  // v4: the NFT tokenId is the positionId.
  return rows.map((r) => ({ ...r, tokenId: r.positionId }));
}

export interface SeedExtras {
  tokens?: Array<Record<string, unknown>>;
  pools?: Array<Record<string, unknown>>;
  /** Fields merged into a fixture token row, by address (`undefined` removes the field). */
  tokenPatch?: Record<string, Record<string, unknown>>;
}

export function seed(extraPositions: Array<Record<string, unknown>> = [], extra: SeedExtras = {}) {
  const patched = tokens().map((t) => {
    const patch = extra.tokenPatch?.[t.address];
    if (!patch) return t;
    const out: Record<string, unknown> = { ...t, ...patch };
    for (const [k, v] of Object.entries(patch)) if (v === undefined) delete out[k];
    return out;
  });
  return fakeDb(
    {
      '1_tokens': [...patched, ...(extra.tokens ?? [])],
      '1_uniswap_v4_pools': [...pools(), ...(extra.pools ?? [])],
      '1_uniswap_v4_positions': [...positions(), ...extraPositions],
      sync_cursors: [{ chainId: 1 }],
    },
    {
      '1_tokens': [{ name: 'chainId_1_address_1', key: { chainId: 1, address: 1 } }],
      '1_uniswap_v4_pools': [{ name: 'chainId_1_protocol_1_poolId_1', key: { chainId: 1, protocol: 1, poolId: 1 } }],
      '1_uniswap_v4_positions': [
        { name: 'chainId_1_protocol_1_positionId_1', key: { chainId: 1, protocol: 1, positionId: 1 } },
        { name: 'bg_active_walk', key: { chainId: 1, protocol: 1, isActive: 1, positionId: 1, 'metrics.performanceReady': 1 }, partialFilterExpression: { isActive: true } },
        { name: 'chainId_1_protocol_1_isActive_-1_tokenId_1', key: { chainId: 1, protocol: 1, isActive: -1, tokenId: 1 } },
      ],
    },
  );
}

export async function run(
  argv: string[],
  opts: {
    outDir?: string;
    fetchImpl?: typeof fetch;
    extraPositions?: Array<Record<string, unknown>>;
    extraTokens?: Array<Record<string, unknown>>;
    extraPools?: Array<Record<string, unknown>>;
    tokenPatch?: SeedExtras['tokenPatch'];
    env?: Record<string, string>;
    pacerNow?: () => number;
    pacerWait?: (ms: number) => Promise<void>;
    probeWait?: (ms: number) => Promise<void>;
  } = {},
) {
  const fake = seed(opts.extraPositions, { tokens: opts.extraTokens, pools: opts.extraPools, tokenPatch: opts.tokenPatch });
  const flags = parseArgs(argv);
  const summary = await runReport({
    db: readOnlyDb(fake.db as never),
    flags,
    thresholds: resolveThresholds(flags, (opts.env ?? {}) as NodeJS.ProcessEnv),
    now: NOW,
    outDir: opts.outDir,
    // No network in a spec: a probe that reaches the real fetch fails loudly.
    fetchImpl: opts.fetchImpl ?? ((async () => { throw new Error('spec: no network'); }) as unknown as typeof fetch),
    pacerNow: opts.pacerNow ?? (() => 0),
    pacerWait: opts.pacerWait ?? (async () => {}),
    probeWait: opts.probeWait ?? (async () => {}),
  });
  return { summary, fake };
}

export const openRow = (positionId: string, over: Record<string, unknown>) => ({
  chainId: 1, protocol: 'uniswap-v4', isActive: true, closedAtTimestamp: null, owner: '0x' + '2'.repeat(40), positionId, tokenId: positionId,
  fee: 3000, tickLower: -600, tickUpper: 600, liquidity: '0', currentTick: 0, sqrtPriceX96: '0', poolStats: { tvlUsd: 0 },
  ...over,
});
