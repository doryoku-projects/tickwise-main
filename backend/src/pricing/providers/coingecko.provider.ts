import { Inject, Injectable } from '@nestjs/common';
import { getChainConfig, isWrappedNative } from '../../config/chains.config.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { BaseProvider } from './base-provider.js';
import type { HistoricalReq, PriceQuote } from './price-provider.interface.js';

const BASE_URL = 'https://api.coingecko.com/api/v3';
const HISTORICAL_WINDOW_SECONDS = 24 * 60 * 60;

interface CoinGeckoMarketChartResponse {
  prices?: Array<[number, number]>;
}

/**
 * CoinGecko price provider — historical fallback only in PR1.
 *
 * Identifies tokens by `coingeckoPlatformId` + contract address. For wrapped
 * native (WETH) we use the native coin id (`coingeckoNativeId`) instead since
 * CoinGecko price feeds for the wrapper can be thin.
 *
 * The historical endpoint returns a series within `±24h` of the target; we
 * pick the sample nearest to the requested timestamp client-side. Wide window
 * because long-tail tokens may have hourly-or-sparser cadence on free tier.
 */
@Injectable()
export class CoinGeckoProvider extends BaseProvider {
  readonly name = 'coingecko';
  readonly supportsCurrentBatch = false;
  readonly supportsHistoricalBatch = false;
  readonly maxBatchSize = 1;
  readonly singleConcurrency = 2;
  readonly defaultBackoffMs = 30_000;

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
  ) {
    super({ name: 'CoinGeckoProvider', maxConcurrency: 2, defaultBackoffMs: 30_000 });
  }

  isEnabled(): boolean {
    return true;
  }

  async getCurrentSingle(_chainId: number, _address: string): Promise<PriceQuote | null> {
    // PR1: current pricing remains DeFiLlama-only. Extending to CoinGecko current
    // requires the /simple/token_price endpoint and is deferred to a follow-up.
    this.recordOutcome('skip');
    return null;
  }

  async getHistoricalSingle(req: HistoricalReq): Promise<PriceQuote | null> {
    if (!this.isAvailable()) {
      this.recordOutcome('skip');
      return null;
    }
    const chain = getChainConfig(req.chainId);
    if (!chain?.coingeckoPlatformId) {
      this.recordOutcome('skip');
      return null;
    }

    const lower = req.address.toLowerCase();
    const useNative = isWrappedNative(req.chainId, lower);
    if (useNative && !chain.coingeckoNativeId) {
      this.recordOutcome('skip');
      return null;
    }

    const from = Math.max(0, req.timestamp - HISTORICAL_WINDOW_SECONDS);
    const to = req.timestamp + HISTORICAL_WINDOW_SECONDS;
    const url = useNative && chain.coingeckoNativeId
      ? `${BASE_URL}/coins/${chain.coingeckoNativeId}/market_chart/range?vs_currency=usd&from=${from}&to=${to}`
      : `${BASE_URL}/coins/${chain.coingeckoPlatformId}/contract/${lower}/market_chart/range?vs_currency=usd&from=${from}&to=${to}`;

    const headers: Record<string, string> = {};
    if (this.config.coingeckoApiKey) headers['x-cg-pro-api-key'] = this.config.coingeckoApiKey;

    await this.acquireSlot();
    try {
      const res = await this.httpJson<CoinGeckoMarketChartResponse>(url, {
        headers,
        bodyTimeoutMs: 8000,
        headersTimeoutMs: 8000,
      });
      if (res.statusCode === 429 || res.statusCode >= 500) {
        this.markRateLimited(res.retryAfterMs, res.statusCode);
        return null;
      }
      if (res.statusCode !== 200 || !res.data) {
        this.recordOutcome('error');
        return null;
      }
      const samples = res.data.prices ?? [];
      if (samples.length === 0) {
        this.recordOutcome('miss');
        return null;
      }
      const targetMs = req.timestamp * 1000;
      let bestPrice = 0;
      let bestDelta = Number.POSITIVE_INFINITY;
      for (const [tsMs, price] of samples) {
        const delta = Math.abs(tsMs - targetMs);
        if (delta < bestDelta && Number.isFinite(price) && price > 0) {
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
      this.logger.warn(`historical lookup failed for ${lower}@${req.timestamp}: ${error}`);
      this.recordOutcome('error');
      return null;
    } finally {
      this.releaseSlot();
    }
  }
}
