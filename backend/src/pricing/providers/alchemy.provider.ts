import { Inject, Injectable } from '@nestjs/common';
import { getChainConfig, isWrappedNative } from '../../config/chains.config.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { BaseProvider } from './base-provider.js';
import { KeyPool } from './key-pool.js';
import type { HistoricalReq, PriceQuote } from './price-provider.interface.js';
import { providerAddressKey } from './price-provider.interface.js';

const BASE_URL = 'https://api.g.alchemy.com/prices/v1';
const MAX_BATCH = 25;
const HISTORICAL_INTERVAL: '5m' | '1h' | '1d' = '1h';
const HISTORICAL_WINDOW_SECONDS = 60 * 60; // ±1h around target

/**
 * Maps chainId to Alchemy's network slug. Alchemy uses `eth-mainnet`-style
 * keys rather than DeFiLlama's `ethereum` or GeckoTerminal's `eth`.
 */
export const ALCHEMY_NETWORK_SLUG: Record<number, string> = {
  1: 'eth-mainnet',
  43114: 'avax-mainnet',
  // Alchemy's data-API network naming: eth-mainnet / base-mainnet / arb-mainnet /
  // opt-mainnet. Prices API reuses the RPC network name.
  42161: 'arb-mainnet',
  // THE OUTLIER: the other four vendors take bare 'robinhood'; Alchemy needs the
  // <chain>-mainnet form, as Arbitrum needed 'arb-mainnet'. Probed 2026-09-02 with a
  // live key (USDG $1.000028, WETH $2381.82); a bogus network, an impostor address
  // and an Arbitrum-only token all return "Price not found", so it is not echoing.
  4663: 'robinhood-mainnet',
};

interface AlchemyCurrentResponse {
  data?: Array<{
    network: string;
    address: string;
    prices?: Array<{ currency: string; value: string }>;
    error?: string;
  }>;
}

interface AlchemyHistoricalResponse {
  data?: Array<{
    timestamp: string;
    value: string;
  }>;
}

/**
 * Alchemy Prices API — paid; gated on `ALCHEMY_API_KEY` env.
 *
 * Multi-key support: `ALCHEMY_API_KEY=key1,key2,key3` provisions a round-robin
 * pool. When one key gets 429 the pool benches it for `defaultBackoffMs` and
 * subsequent requests fall through to the next key. Provider reports
 * unavailable only when every key in the pool is benched.
 *
 * Auth is path-based (`/v1/{apiKey}/...`), not header-based; URLs are never
 * logged on warn paths to avoid leaking keys.
 */
@Injectable()
export class AlchemyProvider extends BaseProvider {
  readonly name = 'alchemy';
  readonly supportsCurrentBatch = true;
  readonly supportsHistoricalBatch = false;
  readonly maxBatchSize = MAX_BATCH;
  readonly singleConcurrency = 4;
  readonly defaultBackoffMs = 5_000;

  private readonly keys: KeyPool;

  constructor(@Inject(AppConfigService) config: AppConfigService) {
    super({ name: 'AlchemyProvider', maxConcurrency: 4, defaultBackoffMs: 5_000 });
    this.keys = new KeyPool(config.alchemyApiKeys);
    if (this.keys.size > 0) this.logger.log(`initialized with ${this.keys.size} key(s)`);
  }

  isEnabled(): boolean {
    return this.keys.size > 0;
  }

  isAvailable(): boolean {
    return super.isAvailable() && this.keys.hasAvailable();
  }

  async getCurrentBatch(
    chainId: number,
    addresses: string[],
  ): Promise<Map<string, PriceQuote>> {
    const result = new Map<string, PriceQuote>();
    if (!this.isEnabled()) return result;
    const network = ALCHEMY_NETWORK_SLUG[chainId];
    const chain = getChainConfig(chainId);
    if (!network || !chain || addresses.length === 0) return result;
    if (!this.isAvailable()) {
      this.recordOutcome('skip');
      return result;
    }

    const picked = this.keys.pickAvailable();
    if (!picked) {
      this.recordOutcome('skip');
      return result;
    }

    const lookup = new Map<string, string>();
    const payload: Array<{ network: string; address: string }> = [];
    for (const addr of addresses) {
      const lower = addr.toLowerCase();
      const queryAddr = isWrappedNative(chainId, lower)
        ? chain.wrappedNativeToken.address.toLowerCase()
        : lower;
      lookup.set(`${network}|${queryAddr}`, lower);
      payload.push({ network, address: queryAddr });
    }

    const url = `${BASE_URL}/${picked.key}/tokens/by-address`;
    await this.acquireSlot();
    try {
      const res = await this.httpJson<AlchemyCurrentResponse>(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        bodyTimeoutMs: 8000,
        headersTimeoutMs: 8000,
        body: JSON.stringify({ addresses: payload }),
      });
      if (res.statusCode === 429 || res.statusCode >= 500) {
        this.keys.markRateLimited(picked.index, res.retryAfterMs ?? this.defaultBackoffMs);
        if (this.keys.shouldLog(picked.index)) {
          this.logger.warn(`key=${picked.index + 1} rate limited (${res.statusCode})`);
        }
        return result;
      }
      if (res.statusCode !== 200 || !res.data) {
        this.logger.warn(`key=${picked.index + 1} batch returned ${res.statusCode} for ${addresses.length} tokens`);
        this.recordOutcome('error');
        return result;
      }
      for (const row of res.data.data ?? []) {
        const key = `${row.network}|${row.address.toLowerCase()}`;
        const original = lookup.get(key);
        if (!original) continue;
        const usd = row.prices?.find((p) => p.currency.toUpperCase() === 'USD');
        const price = usd ? Number(usd.value) : 0;
        if (Number.isFinite(price) && price > 0) {
          result.set(providerAddressKey(chainId, original), { priceUsd: price });
          this.recordOutcome('success');
        } else {
          this.recordOutcome('miss');
        }
      }
      return result;
    } catch (error) {
      this.logger.error(`key=${picked.index + 1} batch prefetch failed for ${addresses.length} tokens: ${error}`);
      this.recordOutcome('error');
      return result;
    } finally {
      this.releaseSlot();
    }
  }

  async getCurrentSingle(chainId: number, address: string): Promise<PriceQuote | null> {
    const batch = await this.getCurrentBatch(chainId, [address]);
    return batch.get(providerAddressKey(chainId, address)) ?? null;
  }

  async getHistoricalSingle(req: HistoricalReq): Promise<PriceQuote | null> {
    if (!this.isEnabled()) return null;
    const network = ALCHEMY_NETWORK_SLUG[req.chainId];
    const chain = getChainConfig(req.chainId);
    if (!network || !chain) return null;
    if (!this.isAvailable()) {
      this.recordOutcome('skip');
      return null;
    }

    const picked = this.keys.pickAvailable();
    if (!picked) {
      this.recordOutcome('skip');
      return null;
    }

    const lower = req.address.toLowerCase();
    const queryAddr = isWrappedNative(req.chainId, lower)
      ? chain.wrappedNativeToken.address.toLowerCase()
      : lower;
    const startTime = new Date((req.timestamp - HISTORICAL_WINDOW_SECONDS) * 1000).toISOString();
    const endTime = new Date((req.timestamp + HISTORICAL_WINDOW_SECONDS) * 1000).toISOString();

    const url = `${BASE_URL}/${picked.key}/tokens/historical`;
    await this.acquireSlot();
    try {
      const res = await this.httpJson<AlchemyHistoricalResponse>(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        bodyTimeoutMs: 8000,
        headersTimeoutMs: 8000,
        body: JSON.stringify({ network, address: queryAddr, startTime, endTime, interval: HISTORICAL_INTERVAL }),
      });
      if (res.statusCode === 429 || res.statusCode >= 500) {
        this.keys.markRateLimited(picked.index, res.retryAfterMs ?? this.defaultBackoffMs);
        if (this.keys.shouldLog(picked.index)) {
          this.logger.warn(`key=${picked.index + 1} rate limited (${res.statusCode})`);
        }
        return null;
      }
      if (res.statusCode !== 200 || !res.data) {
        this.recordOutcome('error');
        return null;
      }
      const samples = res.data.data ?? [];
      if (samples.length === 0) {
        this.recordOutcome('miss');
        return null;
      }
      const targetMs = req.timestamp * 1000;
      let bestPrice = 0;
      let bestDelta = Number.POSITIVE_INFINITY;
      for (const sample of samples) {
        const tsMs = Date.parse(sample.timestamp);
        const price = Number(sample.value);
        if (!Number.isFinite(tsMs) || !Number.isFinite(price) || price <= 0) continue;
        const delta = Math.abs(tsMs - targetMs);
        if (delta < bestDelta) {
          bestDelta = delta;
          bestPrice = price;
        }
      }
      if (bestPrice > 0) {
        this.recordOutcome('success');
        return { priceUsd: bestPrice };
      }
      this.recordOutcome('miss');
      return null;
    } catch (error) {
      this.logger.warn(`key=${picked.index + 1} historical lookup failed for ${lower}@${req.timestamp}: ${error}`);
      this.recordOutcome('error');
      return null;
    } finally {
      this.releaseSlot();
    }
  }
}
