import { Inject, Injectable } from '@nestjs/common';
import { getChainConfig, isWrappedNative } from '../../config/chains.config.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { BaseProvider } from './base-provider.js';
import { KeyPool } from './key-pool.js';
import type { HistoricalReq, PriceQuote } from './price-provider.interface.js';

const BASE_URL = 'https://deep-index.moralis.io/api/v2.2';

/**
 * chainId → Moralis chain slug. Moralis uses `eth`/`polygon`/`bsc` etc.
 */
export const MORALIS_CHAIN_SLUG: Record<number, string> = {
  1: 'eth',
  43114: 'avalanche',
  42161: 'arbitrum',
};

interface MoralisPriceResponse {
  usdPrice?: number;
  tokenSymbol?: string;
}

/**
 * Moralis Web3 Data API — paid; gated on `MORALIS_API_KEY` env.
 *
 * Multi-key support: `MORALIS_API_KEY=key1,key2,key3` rotates round-robin
 * across keys with per-key backoff on 429. Provider stays available as long
 * as at least one key is not benched.
 *
 * Current-only in this PR: historical requires `to_block`, which means a
 * timestamp→block conversion. That capability arrives with PR 4 (RPC wiring
 * for on-chain TWAP).
 */
@Injectable()
export class MoralisProvider extends BaseProvider {
  readonly name = 'moralis';
  readonly supportsCurrentBatch = false;
  readonly supportsHistoricalBatch = false;
  readonly maxBatchSize = 1;
  readonly singleConcurrency = 4;
  readonly defaultBackoffMs = 5_000;

  private readonly keys: KeyPool;

  constructor(@Inject(AppConfigService) config: AppConfigService) {
    super({ name: 'MoralisProvider', maxConcurrency: 4, defaultBackoffMs: 5_000 });
    this.keys = new KeyPool(config.moralisApiKeys);
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
    const chainSlug = MORALIS_CHAIN_SLUG[chainId];
    const chain = getChainConfig(chainId);
    if (!chainSlug || !chain) return null;
    if (!this.isAvailable()) {
      this.recordOutcome('skip');
      return null;
    }

    const picked = this.keys.pickAvailable();
    if (!picked) {
      this.recordOutcome('skip');
      return null;
    }

    const lower = address.toLowerCase();
    const queryAddr = isWrappedNative(chainId, lower)
      ? chain.wrappedNativeToken.address.toLowerCase()
      : lower;
    const url = `${BASE_URL}/erc20/${queryAddr}/price?chain=${chainSlug}`;

    await this.acquireSlot();
    try {
      const res = await this.httpJson<MoralisPriceResponse>(url, {
        headers: { 'X-API-Key': picked.key },
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
      if (res.statusCode !== 200 || !res.data) {
        this.recordOutcome('error');
        return null;
      }
      const price = Number(res.data.usdPrice ?? 0);
      if (Number.isFinite(price) && price > 0) {
        this.recordOutcome('success');
        return { priceUsd: price };
      }
      this.recordOutcome('miss');
      return null;
    } catch (error) {
      this.logger.warn(`key=${picked.index + 1} current lookup failed for ${lower}: ${error}`);
      this.recordOutcome('error');
      return null;
    } finally {
      this.releaseSlot();
    }
  }

  /**
   * Historical pricing is deferred — see class doc.
   */
  async getHistoricalSingle(_req: HistoricalReq): Promise<PriceQuote | null> {
    this.recordOutcome('skip');
    return null;
  }
}
