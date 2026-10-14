import { Inject, Injectable } from '@nestjs/common';
import { getChainConfig } from '../../config/chains.config.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { BaseProvider } from './base-provider.js';
import type { HistoricalReq, PriceQuote } from './price-provider.interface.js';

const BASE_URL = 'https://api.diadata.org/v1';

/**
 * chainId → DIA blockchain NAME (DIA keys by name, not chainId — like
 * DexScreener's chain map). Add chains as we enable them.
 */
export const DIA_CHAIN: Record<number, string> = {
  1: 'Ethereum',
  43114: 'Avalanche',
  // Capitalized and case-sensitive, like the others. Verified live: assetQuotation
  // for Arbitrum WETH returned a real price.
  42161: 'Arbitrum',
};

interface DiaQuote {
  Price?: number;
  PriceYesterday?: number;
  VolumeYesterdayUSD?: number;
  Symbol?: string;
  /** When DIA last quoted the asset (ISO-8601, e.g. `2026-10-05T09:39:49Z`). */
  Time?: string;
}

/**
 * DIA assetQuotation provider — FREE, no API key, no registration. Returns a
 * USD price + 24h volume directly by contract address (`GET /v1/assetQuotation/
 * {Blockchain}/{address}`), so no decimals plumbing is needed. Broad coverage
 * (3,000+ tokens incl. long-tail / LSTs / memecoins) across 65+ chains.
 *
 * An AGGREGATOR, NOT a DEX-market source: its quote counts toward consensus +
 * coverage but is deliberately NOT in `DEX_MARKET_SOURCES`, so a DIA price alone
 * never satisfies the active-market gate (the anti-fake reserve/counter floors
 * still decide whether a leg is valued).
 */
@Injectable()
export class DiaProvider extends BaseProvider {
  readonly name = 'dia';
  readonly supportsCurrentBatch = false;
  readonly supportsHistoricalBatch = false;
  readonly maxBatchSize = 1;
  readonly singleConcurrency = 4;
  // Free-tier rate limits are undocumented — keep concurrency low and back off
  // generously on 429/5xx (httpJson routes those to markRateLimited).
  readonly defaultBackoffMs = 15_000;

  constructor(@Inject(AppConfigService) _config: AppConfigService) {
    super({ name: 'DiaProvider', maxConcurrency: 4, defaultBackoffMs: 15_000 });
  }

  isEnabled(): boolean {
    return true; // no key required
  }

  async getCurrentSingle(chainId: number, address: string): Promise<PriceQuote | null> {
    const chainName = DIA_CHAIN[chainId];
    if (!chainName || !getChainConfig(chainId)) return null;
    if (!this.isAvailable()) {
      this.recordOutcome('skip');
      return null;
    }
    const lower = address.toLowerCase();
    const url = `${BASE_URL}/assetQuotation/${chainName}/${lower}`;

    await this.acquireSlot();
    try {
      const res = await this.httpJson<DiaQuote>(url, { bodyTimeoutMs: 8000, headersTimeoutMs: 8000 });
      if (res.statusCode === 429 || res.statusCode >= 500) {
        this.markRateLimited(res.retryAfterMs, res.statusCode);
        return null;
      }
      if (res.statusCode !== 200 || !res.data) {
        this.recordOutcome(res.statusCode === 404 ? 'miss' : 'error');
        return null;
      }
      const price = Number(res.data.Price ?? 0);
      if (Number.isFinite(price) && price > 0) {
        this.recordOutcome('success');
        const vol = Number(res.data.VolumeYesterdayUSD);
        // DIA dates every quotation (`Time`, ISO-8601). It keeps serving a
        // token's LAST quotation indefinitely — HPP's $31,374 was 4.5 months
        // old — so the date travels with the quote for the quote guard.
        const at = typeof res.data.Time === 'string' ? Date.parse(res.data.Time) : NaN;
        return {
          priceUsd: price,
          source: 'dia',
          volume24hUsd: Number.isFinite(vol) && vol > 0 ? vol : undefined,
          quotedAtMs: Number.isFinite(at) ? at : undefined,
        };
      }
      this.recordOutcome('miss');
      return null;
    } catch (error) {
      this.logger.warn(`current lookup failed for ${lower}: ${error}`);
      this.recordOutcome('error');
      return null;
    } finally {
      this.releaseSlot();
    }
  }

  // DIA has historical endpoints, but the v4 aggregates path is current-price only.
  async getHistoricalSingle(_req: HistoricalReq): Promise<PriceQuote | null> {
    this.recordOutcome('skip');
    return null;
  }
}
