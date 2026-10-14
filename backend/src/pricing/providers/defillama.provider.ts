import { Inject, Injectable } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service.js';
import { getChainConfig, isWrappedNative } from '../../config/chains.config.js';
import { BaseProvider } from './base-provider.js';
import type {
  HistoricalReq,
  PriceQuote,
} from './price-provider.interface.js';
import { providerAddressKey, providerHistoricalKey } from './price-provider.interface.js';

const CURRENT_URL = 'https://coins.llama.fi/prices/current';
const HISTORICAL_URL = 'https://coins.llama.fi/prices/historical';
const BATCH_HISTORICAL_URL = 'https://coins.llama.fi/batchHistorical';
const MIN_CONFIDENCE = 0.7;
const SEARCH_WIDTH = '4h';

interface DefillamaResponse {
  coins?: Record<string, { price?: number; confidence?: number; timestamp?: number }>;
}

/** DeFiLlama's per-coin `timestamp` (seconds) → ms, when it is a real date. */
function llamaQuotedAtMs(timestamp: unknown): number | undefined {
  const t = Number(timestamp);
  return Number.isFinite(t) && t > 0 ? t * 1000 : undefined;
}

interface DefillamaBatchHistoricalResponse {
  coins?: Record<
    string,
    { prices?: Array<{ timestamp?: number; price?: number; confidence?: number }> }
  >;
}

/**
 * DeFiLlama price provider — free, no auth required.
 *
 * Supports batched current prices via comma-separated `{chain}:{address}` list,
 * and batched historical prices via the `batchHistorical` endpoint
 * (`coins={"chain:addr":[ts,…]}`) — one HTTP call per ≤100-request chunk instead
 * of one call per (token, timestamp). The orchestrator auto-routes through
 * `getHistoricalBatch` because `supportsHistoricalBatch=true`.
 *
 * Wrapped native (e.g. WETH) is rewritten to the native zero-address token
 * because DeFiLlama indexes the native asset, not the wrapper, for some price
 * series.
 */
@Injectable()
export class DefillamaProvider extends BaseProvider {
  readonly name = 'defillama';
  readonly supportsCurrentBatch = true;
  readonly supportsHistoricalBatch = true;
  readonly maxBatchSize = 100;
  readonly singleConcurrency: number;
  readonly defaultBackoffMs = 30_000;

  constructor(@Inject(AppConfigService) config: AppConfigService) {
    super({
      name: 'DefillamaProvider',
      maxConcurrency: Math.max(1, config.pricingProviderMaxConcurrency),
      defaultBackoffMs: 30_000,
    });
    this.singleConcurrency = Math.max(1, config.pricingHistoricalSingleConcurrency);
  }

  isEnabled(): boolean {
    return true;
  }

  async getCurrentBatch(
    chainId: number,
    addresses: string[],
  ): Promise<Map<string, PriceQuote>> {
    const result = new Map<string, PriceQuote>();
    const chain = getChainConfig(chainId);
    if (!chain || addresses.length === 0) return result;
    if (!this.isAvailable()) {
      this.recordOutcome('skip');
      return result;
    }

    const llamaCoins = addresses.map((addr) => this.llamaCoinFor(chainId, addr.toLowerCase()));
    const lookup = new Map<string, string>(); // coin -> original lower address
    addresses.forEach((addr, i) => {
      const coin = llamaCoins[i];
      if (coin) lookup.set(coin, addr.toLowerCase());
    });

    const url = `${CURRENT_URL}/${[...lookup.keys()].join(',')}`;
    await this.acquireSlot();
    try {
      const res = await this.httpJson<DefillamaResponse>(url, {
        bodyTimeoutMs: 10_000,
        headersTimeoutMs: 10_000,
      });
      if (res.statusCode === 429 || res.statusCode >= 500) {
        this.markRateLimited(res.retryAfterMs, res.statusCode);
        return result;
      }
      if (res.statusCode !== 200 || !res.data) {
        this.logger.warn(`batch returned ${res.statusCode} for ${addresses.length} tokens`);
        this.recordOutcome('error');
        return result;
      }
      for (const [coin, original] of lookup) {
        const entry = res.data.coins?.[coin];
        const price = Number(entry?.price ?? 0);
        const confidence = Number(entry?.confidence ?? 0);
        if (Number.isFinite(price) && price > 0 && confidence >= MIN_CONFIDENCE) {
          // `timestamp` = when DeFiLlama last priced the coin; a long-dead coin
          // keeps its last price, so it travels with the quote for the guard.
          result.set(providerAddressKey(chainId, original), { priceUsd: price, confidence, quotedAtMs: llamaQuotedAtMs(entry?.timestamp) });
          this.recordOutcome('success');
        } else {
          this.recordOutcome('miss');
        }
      }
      return result;
    } catch (error) {
      this.logger.error(`batch prefetch failed for ${addresses.length} tokens: ${error}`);
      this.recordOutcome('error');
      return result;
    } finally {
      this.releaseSlot();
    }
  }

  async getCurrentSingle(chainId: number, address: string): Promise<PriceQuote | null> {
    return this.fetchSingle(chainId, address.toLowerCase());
  }

  async getHistoricalSingle(request: HistoricalReq): Promise<PriceQuote | null> {
    return this.fetchSingle(request.chainId, request.address.toLowerCase(), request.timestamp);
  }

  /**
   * Batched historical prices. One `batchHistorical` HTTP call resolves every
   * (token, timestamp) in the chunk (the orchestrator pre-chunks to
   * `maxBatchSize` requests). Groups requests by DeFiLlama coin → set of
   * timestamps; for each request picks the returned price nearest its
   * timestamp. Result keyed by `providerHistoricalKey` so the orchestrator
   * merges it (request `timestamp` is already bucket-aligned). Missing coins
   * simply aren't set → they fall through to the next provider.
   */
  async getHistoricalBatch(requests: HistoricalReq[]): Promise<Map<string, PriceQuote>> {
    const result = new Map<string, PriceQuote>();
    if (requests.length === 0) return result;
    if (!this.isAvailable()) {
      this.recordOutcome('skip');
      return result;
    }

    const coinToTimestamps = new Map<string, Set<number>>();
    for (const req of requests) {
      const coin = this.llamaCoinFor(req.chainId, req.address.toLowerCase());
      if (!coin || !req.timestamp) continue;
      const set = coinToTimestamps.get(coin) ?? new Set<number>();
      set.add(req.timestamp);
      coinToTimestamps.set(coin, set);
    }
    if (coinToTimestamps.size === 0) return result;

    const coinsParam: Record<string, number[]> = {};
    for (const [coin, timestamps] of coinToTimestamps) coinsParam[coin] = [...timestamps];
    const url = `${BATCH_HISTORICAL_URL}?coins=${encodeURIComponent(
      JSON.stringify(coinsParam),
    )}&searchWidth=${SEARCH_WIDTH}`;

    await this.acquireSlot();
    try {
      const res = await this.httpJson<DefillamaBatchHistoricalResponse>(url, {
        bodyTimeoutMs: 15_000,
        headersTimeoutMs: 10_000,
      });
      if (res.statusCode === 429 || res.statusCode >= 500) {
        this.markRateLimited(res.retryAfterMs, res.statusCode);
        return result;
      }
      if (res.statusCode !== 200 || !res.data) {
        this.logger.warn(`batchHistorical returned ${res.statusCode} for ${requests.length} reqs`);
        this.recordOutcome('error');
        return result;
      }
      for (const req of requests) {
        const coin = this.llamaCoinFor(req.chainId, req.address.toLowerCase());
        if (!coin) continue;
        const series = res.data.coins?.[coin]?.prices ?? [];
        if (series.length === 0) {
          this.recordOutcome('miss');
          continue;
        }
        // Pick the returned price closest to the requested (bucket) timestamp.
        let best = series[0];
        let bestDiff = Math.abs(Number(best?.timestamp ?? 0) - req.timestamp);
        for (const point of series) {
          const diff = Math.abs(Number(point?.timestamp ?? 0) - req.timestamp);
          if (diff < bestDiff) {
            best = point;
            bestDiff = diff;
          }
        }
        const price = Number(best?.price ?? 0);
        const confidence = Number(best?.confidence ?? 0);
        if (Number.isFinite(price) && price > 0 && confidence >= MIN_CONFIDENCE) {
          result.set(providerHistoricalKey(req), { priceUsd: price, confidence });
          this.recordOutcome('success');
        } else {
          this.recordOutcome('miss');
        }
      }
      return result;
    } catch (error) {
      this.logger.error(`batchHistorical failed for ${requests.length} reqs: ${error}`);
      this.recordOutcome('error');
      return result;
    } finally {
      this.releaseSlot();
    }
  }

  private async fetchSingle(
    chainId: number,
    address: string,
    timestamp?: number,
  ): Promise<PriceQuote | null> {
    if (!this.isAvailable()) {
      this.recordOutcome('skip');
      return null;
    }
    const chain = getChainConfig(chainId);
    if (!chain) {
      this.recordOutcome('error');
      return null;
    }
    const coin = this.llamaCoinFor(chainId, address);
    if (!coin) return null;

    const url = timestamp
      ? `${HISTORICAL_URL}/${timestamp}/${coin}?searchWidth=${SEARCH_WIDTH}`
      : `${CURRENT_URL}/${coin}`;

    await this.acquireSlot();
    try {
      const res = await this.httpJson<DefillamaResponse>(url, {
        bodyTimeoutMs: 5000,
        headersTimeoutMs: 5000,
      });
      if (res.statusCode === 429 || res.statusCode >= 500) {
        this.markRateLimited(res.retryAfterMs, res.statusCode);
        return null;
      }
      if (res.statusCode !== 200 || !res.data) {
        this.recordOutcome('error');
        return null;
      }
      const entry = res.data.coins?.[coin];
      const price = Number(entry?.price ?? 0);
      const confidence = Number(entry?.confidence ?? 0);
      if (Number.isFinite(price) && price > 0 && confidence >= MIN_CONFIDENCE) {
        this.recordOutcome('success');
        // Use providerHistoricalKey shape only if caller cares; for singles we
        // simply return the quote.
        void providerHistoricalKey;
        // Current lookups carry the quote date (the quote guard reads it); a
        // historical one is dated by its request, not by staleness.
        return timestamp ? { priceUsd: price, confidence } : { priceUsd: price, confidence, quotedAtMs: llamaQuotedAtMs(entry?.timestamp) };
      }
      this.recordOutcome('miss');
      return null;
    } catch (error) {
      this.logger.error(`price fetch failed for ${coin}: ${error}`);
      this.recordOutcome('error');
      return null;
    } finally {
      this.releaseSlot();
    }
  }

  private llamaCoinFor(chainId: number, lowerAddress: string): string {
    const chain = getChainConfig(chainId);
    if (!chain) return '';
    const llamaAddress = isWrappedNative(chainId, lowerAddress)
      ? chain.wrappedNativeToken.address.toLowerCase()
      : lowerAddress;
    return `${chain.slug}:${llamaAddress}`;
  }
}
