/*
 * The valuation-fix env vars (docs/spam-and-pool-mismatch-2026-10-05.md):
 * Zod entry + typed getter with the exact getter NAME each consumer reads
 * structurally (`trustPolicyOf`, PositionsRepository, EnvioAdapter), and a
 * default that IS today. Blank (`KEY=` on Railway) reads as unset.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppConfigService } from '../../src/config/app-config.service.js';
import { trustPolicyOf } from '../../src/pricing/token-trust.js';
import { rankFeeLeafEnabled } from '../../src/read-models/core/fields.js';
import { DexScreenerProvider } from '../../src/pricing/providers/dexscreener.provider.js';

const ENVS = [
  'PRICE_QUOTE_GUARD',
  'PRICE_QUOTE_MAX_AGE_MS',
  'PRICE_DIA_MIN_VOLUME_USD',
  'TOKEN_TRUST_MODE',
  'TOKEN_TRUST_SHADOW',
  'TOKEN_TRUST_DENY',
  'TOKEN_TRUST_MIN_POOLS',
  'TOKEN_TRUST_MIN_POOL_LIQUIDITY_USD',
  'TOKEN_TRUST_MIN_OUTSIDE_LIQUIDITY_USD',
  'TOKEN_TRUST_DEEP_POOL_LIQUIDITY_USD',
  'HONEYPOT_FEE_FILTER',
  'HONEYPOT_FEE_ANCHOR_EXEMPT',
  'DEXSCREENER_BATCH_ENDPOINT',
  'POSITION_AMOUNTS_SOURCE',
] as const;

function config(env: Partial<Record<(typeof ENVS)[number], string>> = {}): AppConfigService {
  for (const name of ENVS) {
    vi.stubEnv(name, '');
    delete process.env[name];
  }
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v as string);
  return new AppConfigService();
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('valuation-fix config — every default is today', () => {
  it('unset: every flag off, every threshold at the code default', () => {
    const c = config();
    expect(c.priceQuoteGuard).toBe('off');
    expect(c.priceQuoteMaxAgeMs).toBe(86_400_000);
    expect(c.priceDiaMinVolumeUsd).toBe(1_000);
    expect(c.tokenTrustMode).toBe('allowlist');
    expect(c.tokenTrustShadow).toBe('off');
    expect(c.tokenTrustDeny).toBe('');
    expect(c.tokenTrustMinPools).toBe(2);
    expect(c.tokenTrustMinPoolLiquidityUsd).toBe(10_000);
    expect(c.tokenTrustMinOutsideLiquidityUsd).toBe(50_000);
    expect(c.tokenTrustDeepPoolLiquidityUsd).toBe(250_000);
    expect(c.honeypotFeeFilter).toBe('off');
    expect(c.positionAmountsSource).toBe('indexer');
  });

  it('the getters resolve to exactly the policy a config WITHOUT them resolves to (today)', () => {
    const p = trustPolicyOf(config());
    const bare = trustPolicyOf({});
    expect({ ...p, deny: [...p.deny] }).toEqual({ ...bare, deny: [...bare.deny] });
    expect(p.mode).toBe('allowlist');
    expect(p.quoteGuard).toBe(false);
    expect(p.shadow).toBe(false);
  });

  it('blank is unset (never 0 / "" / a boot failure)', () => {
    const c = config(Object.fromEntries(ENVS.map((n) => [n, ''])) as never);
    expect(c.priceQuoteGuard).toBe('off');
    expect(c.priceQuoteMaxAgeMs).toBe(86_400_000);
    expect(c.priceDiaMinVolumeUsd).toBe(1_000);
    expect(c.tokenTrustMode).toBe('allowlist');
    expect(c.tokenTrustMinPools).toBe(2);
    expect(c.honeypotFeeFilter).toBe('off');
    expect(c.positionAmountsSource).toBe('indexer');
  });

  it('switches are case-insensitive and reach the consumers', () => {
    const c = config({
      PRICE_QUOTE_GUARD: 'ON',
      TOKEN_TRUST_MODE: 'Earned',
      TOKEN_TRUST_SHADOW: 'on',
      HONEYPOT_FEE_FILTER: ' On ',
      POSITION_AMOUNTS_SOURCE: 'TickMath',
      TOKEN_TRUST_DENY: ' 1:0x000000000000000000000000000000000000dEaD ',
    });
    expect(c.priceQuoteGuard).toBe('on');
    expect(c.tokenTrustMode).toBe('earned');
    expect(c.honeypotFeeFilter).toBe('on');
    expect(c.positionAmountsSource).toBe('tickmath');
    const p = trustPolicyOf(c);
    expect(p.quoteGuard).toBe(true);
    expect(p.mode).toBe('earned');
    expect(p.shadow).toBe(true);
    expect([...p.deny]).toEqual(['1:0x000000000000000000000000000000000000dead']);
  });

  it('thresholds: garbage / out of range read as the default; the quote age has a 1-minute floor; 0 is honoured where it disables', () => {
    const c = config({
      PRICE_QUOTE_MAX_AGE_MS: '1000',
      PRICE_DIA_MIN_VOLUME_USD: '0',
      TOKEN_TRUST_MIN_POOLS: 'abc',
      TOKEN_TRUST_MIN_POOL_LIQUIDITY_USD: '-5',
      TOKEN_TRUST_MIN_OUTSIDE_LIQUIDITY_USD: '0',
      TOKEN_TRUST_DEEP_POOL_LIQUIDITY_USD: '0',
    });
    expect(c.priceQuoteMaxAgeMs).toBe(60_000);
    expect(c.priceDiaMinVolumeUsd).toBe(0);
    expect(c.tokenTrustMinPools).toBe(2);
    expect(c.tokenTrustMinPoolLiquidityUsd).toBe(10_000);
    expect(c.tokenTrustMinOutsideLiquidityUsd).toBe(0);
    expect(c.tokenTrustDeepPoolLiquidityUsd).toBe(0);
    expect(config({ PRICE_QUOTE_MAX_AGE_MS: '-1' }).priceQuoteMaxAgeMs).toBe(86_400_000);
    expect(config({ TOKEN_TRUST_MIN_POOLS: '3.7' }).tokenTrustMinPools).toBe(3);
    const p = trustPolicyOf(c);
    expect(p.quoteMaxAgeMs).toBe(60_000);
    expect(p.minOutsideCounterUsd).toBe(0);
    expect(p.deepPoolCounterUsd).toBe(0);
  });

  it('an unknown switch value fails the boot (never a silent default)', () => {
    expect(() => config({ TOKEN_TRUST_MODE: 'trusted' })).toThrow();
    expect(() => config({ PRICE_QUOTE_GUARD: 'true' })).toThrow();
    expect(() => config({ POSITION_AMOUNTS_SOURCE: 'chain' })).toThrow();
  });

  it('HONEYPOT_FEE_ANCHOR_EXEMPT, DEXSCREENER_BATCH_ENDPOINT, TOKEN_TRUST_MODE=combined: default = today, blank = unset, any case, garbage fails the boot', () => {
    // Unset and blank (`KEY=` on Railway): today.
    for (const c of [config(), config({ HONEYPOT_FEE_ANCHOR_EXEMPT: '', DEXSCREENER_BATCH_ENDPOINT: '' })]) {
      expect(c.honeypotFeeAnchorExempt).toBe('off');
      expect(c.dexscreenerBatchEndpoint).toBe('latest');
    }
    // Any case, trimmed — and the getter NAMES the consumers read (PositionsRepository
    // and EnvioAdapter read `honeypotFeeAnchorExempt` structurally: a renamed getter
    // would read as off with no type error there).
    const c = config({ HONEYPOT_FEE_ANCHOR_EXEMPT: ' ON ', DEXSCREENER_BATCH_ENDPOINT: ' Per-Chain ', TOKEN_TRUST_MODE: 'Combined' });
    expect((c as unknown as Record<string, unknown>).honeypotFeeAnchorExempt).toBe('on');
    expect((c as unknown as Record<string, unknown>).dexscreenerBatchEndpoint).toBe('per-chain');
    expect(c.tokenTrustMode).toBe('combined');
    expect(trustPolicyOf(c).mode).toBe('combined');
    expect(config({ HONEYPOT_FEE_ANCHOR_EXEMPT: 'off', DEXSCREENER_BATCH_ENDPOINT: 'LATEST' })).toMatchObject({ honeypotFeeAnchorExempt: 'off', dexscreenerBatchEndpoint: 'latest' });
    // A value the consumers would read as off / latest cannot boot at all.
    expect(() => config({ HONEYPOT_FEE_ANCHOR_EXEMPT: 'true' })).toThrow();
    expect(() => config({ DEXSCREENER_BATCH_ENDPOINT: 'per_chain' })).toThrow();
    expect(() => config({ TOKEN_TRUST_MODE: 'union' })).toThrow();
  });

  it('DEXSCREENER_BATCH_ENDPOINT reaches the provider through the real config (the request it sends)', async () => {
    const urls: string[] = [];
    for (const mode of [undefined, 'per-chain'] as const) {
      const p = new DexScreenerProvider(config(mode ? { DEXSCREENER_BATCH_ENDPOINT: mode } : {}));
      vi.spyOn(p as unknown as { httpJson: (u: string) => Promise<unknown> }, 'httpJson').mockImplementation(async (u: string) => {
        urls.push(u);
        return { statusCode: 200, data: mode ? [] : { pairs: [] } };
      });
      await p.getCurrentBatch(1, ['0x000000000000000000000000000000000000dead']);
    }
    expect(urls).toEqual([
      'https://api.dexscreener.com/latest/dex/tokens/0x000000000000000000000000000000000000dead',
      'https://api.dexscreener.com/tokens/v1/ethereum/0x000000000000000000000000000000000000dead',
    ]);
  });

  it('HONEYPOT_FEE_FILTER: every value that boots means the same to the config and to the rank layout', () => {
    for (const v of ['on', 'ON', ' on ', 'off', 'OFF', '']) {
      const c = config({ HONEYPOT_FEE_FILTER: v });
      expect(c.honeypotFeeFilter === 'on').toBe(rankFeeLeafEnabled({ HONEYPOT_FEE_FILTER: v }));
    }
    // An alias the rank layout would read as off cannot boot at all.
    for (const v of ['true', '1', 'yes']) expect(() => config({ HONEYPOT_FEE_FILTER: v })).toThrow();
  });
});
