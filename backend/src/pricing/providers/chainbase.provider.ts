import { Inject, Injectable } from '@nestjs/common';
import { getChainConfig, isWrappedNative } from '../../config/chains.config.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { BaseProvider } from './base-provider.js';
import { KeyPool } from './key-pool.js';
import type { HistoricalReq, PriceQuote } from './price-provider.interface.js';

const BASE_URL = 'https://api.chainbase.online/v1';
const HISTORICAL_WINDOW_SECONDS = 24 * 60 * 60; // ±24h target window for thin tokens

interface ChainbaseCurrentResponse {
  code?: number;
  message?: string;
  data?: { price?: number; symbol?: string; decimals?: number; updated_at?: string };
}

interface ChainbaseHistoryResponse {
  code?: number;
  message?: string;
  data?: Array<{ price?: number; updated_at?: string }>;
}

/**
 * Chainbase token price API — paid; gated on `CHAINBASE_API_KEY` env.
 *
 * Multi-key support: `CHAINBASE_API_KEY=key1,key2,key3` rotates round-robin
 * with per-key backoff on 429.
 *
 * Both current and historical are single-token-only (no batch). Historical
 * endpoint takes a `from_timestamp`/`end_timestamp` range and returns an
 * array of price points; we pick the sample closest to the target.
 */
@Injectable()
export class ChainbaseProvider extends BaseProvider {
  readonly name = 'chainbase';
  readonly supportsCurrentBatch = false;
  readonly supportsHistoricalBatch = false;
  readonly maxBatchSize = 1;
  readonly singleConcurrency = 2;
  readonly defaultBackoffMs = 30_000;

  private readonly keys: KeyPool;

  constructor(@Inject(AppConfigService) config: AppConfigService) {
    super({ name: 'ChainbaseProvider', maxConcurrency: 2, defaultBackoffMs: 30_000 });
    this.keys = new KeyPool(config.chainbaseApiKeys);
    if (this.keys.size > 0) this.logger.log(`initialized with ${this.keys.size} key(s)`);
  }

  isEnabled(): boolean {
    return this.keys.size > 0;
  }

  isAvailable(): boolean {
    return super.isAvailable() && this.keys.hasAvailable();
  }

  async getCurrentSingle(chainId: number, address: string): Promise<PriceQuote | null> {
    if (!this.isEnabled()) return null;
    const chain = getChainConfig(chainId);
    if (!chain) return null;
    if (!this.isAvailable()) {
      this.recordOutcome('skip');
      return null;
    }

    const picked = this.keys.pickAvailable();
    if (!picked) {
      this.recordOutcome('skip');
      return null;
    }

    const queryAddr = this.resolveQueryAddress(chainId, address);
    const url = `${BASE_URL}/token/price?chain_id=${chainId}&contract_address=${queryAddr}`;
    await this.acquireSlot();
    try {
      const res = await this.httpJson<ChainbaseCurrentResponse>(url, {
        headers: { 'x-api-key': picked.key },
        bodyTimeoutMs: 8000,
        headersTimeoutMs: 8000,
      });
      if (res.statusCode === 429 || res.statusCode >= 500) {
        this.keys.markRateLimited(picked.index, res.retryAfterMs ?? this.defaultBackoffMs);
        if (this.keys.shouldLog(picked.index)) {
          this.logger.warn(`key=${picked.index + 1} rate limited (${res.statusCode})`);
        }
        return null;
      }
      if (res.statusCode !== 200 || !res.data || res.data.code !== 0) {
        this.recordOutcome('error');
        return null;
      }
      const price = Number(res.data.data?.price ?? 0);
      if (Number.isFinite(price) && price > 0) {
        this.recordOutcome('success');
        return { priceUsd: price };
      }
      this.recordOutcome('miss');
      return null;
    } catch (error) {
      this.logger.warn(`key=${picked.index + 1} current lookup failed for ${address.toLowerCase()}: ${error}`);
      this.recordOutcome('error');
      return null;
    } finally {
      this.releaseSlot();
    }
  }

  async getHistoricalSingle(req: HistoricalReq): Promise<PriceQuote | null> {
    if (!this.isEnabled()) return null;
    const chain = getChainConfig(req.chainId);
    if (!chain) return null;
    if (!this.isAvailable()) {
      this.recordOutcome('skip');
      return null;
    }

    const picked = this.keys.pickAvailable();
    if (!picked) {
      this.recordOutcome('skip');
      return null;
    }

    const queryAddr = this.resolveQueryAddress(req.chainId, req.address);
    const from = Math.max(0, req.timestamp - HISTORICAL_WINDOW_SECONDS);
    const to = req.timestamp + HISTORICAL_WINDOW_SECONDS;
    const url = `${BASE_URL}/token/price/history?chain_id=${req.chainId}&contract_address=${queryAddr}&from_timestamp=${from}&end_timestamp=${to}`;

    await this.acquireSlot();
    try {
      const res = await this.httpJson<ChainbaseHistoryResponse>(url, {
        headers: { 'x-api-key': picked.key },
        bodyTimeoutMs: 8000,
        headersTimeoutMs: 8000,
      });
      if (res.statusCode === 429 || res.statusCode >= 500) {
        this.keys.markRateLimited(picked.index, res.retryAfterMs ?? this.defaultBackoffMs);
        if (this.keys.shouldLog(picked.index)) {
          this.logger.warn(`key=${picked.index + 1} rate limited (${res.statusCode})`);
        }
        return null;
      }
      if (res.statusCode !== 200 || !res.data || res.data.code !== 0) {
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
        const tsMs = sample.updated_at ? Date.parse(sample.updated_at) : NaN;
        const price = Number(sample.price ?? 0);
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
      this.logger.warn(`key=${picked.index + 1} historical lookup failed for ${req.address.toLowerCase()}@${req.timestamp}: ${error}`);
      this.recordOutcome('error');
      return null;
    } finally {
      this.releaseSlot();
    }
  }

  private resolveQueryAddress(chainId: number, address: string): string {
    const chain = getChainConfig(chainId);
    const lower = address.toLowerCase();
    if (chain && isWrappedNative(chainId, lower)) return chain.wrappedNativeToken.address.toLowerCase();
    return lower;
  }
}
