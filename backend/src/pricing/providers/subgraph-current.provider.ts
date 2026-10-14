import type { SubgraphTarget } from './base-provider.js';
import { Inject, Injectable } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service.js';
import { BaseProvider } from './base-provider.js';
import type { HistoricalReq, PriceQuote } from './price-provider.interface.js';
import { providerAddressKey } from './price-provider.interface.js';

interface CurrentPricesResponse {
  data?: {
    bundles?: Array<{ ethPriceUSD?: string }>;
    tokens?: Array<{ id: string; derivedETH?: string }>;
  };
  errors?: Array<{ message: string }>;
}

const CURRENT_PRICES_QUERY = `
  query CurrentPrices($ids: [ID!]!) {
    bundles(first: 1) { ethPriceUSD }
    tokens(where: { id_in: $ids }) { id derivedETH }
  }
`;

/**
 * Current-price provider backed by the vanilla Uniswap-style subgraph
 * (`integration.subgraphUrl`, the DiYP v4 deployment). Computes USD as
 * `Token.derivedETH × Bundle.ethPriceUSD` — the subgraph's on-chain-derived
 * price — for many addresses in ONE batched GraphQL call. Free, no external
 * rate limits (the gateway has generous quotas), and consistent with the
 * subgraph-sourced charts/pool-stats.
 *
 * Configured as a FALLBACK after DeFiLlama: it prices the liquid majority the
 * subgraph tracks; tokens with `derivedETH = 0` (thin/new, not in a whitelisted
 * pool) are left unset and fall through to the next provider / pool-ratio
 * derivation. Historical lookups stay with `subgraph-historical`.
 */
@Injectable()
export class SubgraphCurrentProvider extends BaseProvider {
  readonly name = 'subgraph-current';
  readonly supportsCurrentBatch = true;
  readonly supportsHistoricalBatch = false;
  readonly maxBatchSize = 100;
  readonly singleConcurrency = 4;
  readonly defaultBackoffMs = 30_000;

  /** chainId → subgraph URL (token price is chain-scoped, not protocol-scoped). */
  /**
   * Per chain: the endpoint AND the dialect it speaks. The dialect has to travel
   * with the URL because this provider drops AppConfigService after its
   * constructor, so it cannot look the integration up again later.
   */
  private readonly urls = new Map<number, SubgraphTarget>();

  constructor(@Inject(AppConfigService) config: AppConfigService) {
    super({
      name: 'SubgraphCurrentProvider',
      maxConcurrency: Math.max(1, config.pricingProviderMaxConcurrency),
      defaultBackoffMs: 30_000,
    });
    for (const integration of config.enabledIntegrations) {
      if (integration.subgraphUrl && !this.urls.has(integration.chainId)) {
        this.urls.set(integration.chainId, {
          chainId: integration.chainId,
          subgraphUrl: integration.subgraphUrl,
          dialect: integration.dialect,
          sources: integration.sources,
        });
      }
    }
    if (this.urls.size === 0) {
      this.logger.warn('no subgraphUrl configured for any integration — provider disabled');
    } else {
      this.logger.log(`initialized for chains: ${[...this.urls.keys()].join(', ')}`);
    }
  }

  isEnabled(): boolean {
    return this.urls.size > 0;
  }

  async getCurrentBatch(chainId: number, addresses: string[]): Promise<Map<string, PriceQuote>> {
    const result = new Map<string, PriceQuote>();
    const target = this.urls.get(chainId);
    if (!target || addresses.length === 0) return result;
    if (!this.isAvailable()) {
      this.recordOutcome('skip');
      return result;
    }

    const ids = addresses.map((a) => a.toLowerCase());
    await this.acquireSlot();
    try {
      const res = await this.graphqlJson<CurrentPricesResponse>(target.subgraphUrl, target, {
        query: CURRENT_PRICES_QUERY,
        variables: { ids },
        bodyTimeoutMs: 12_000,
        headersTimeoutMs: 10_000,
      });
      if (res.statusCode === 429 || res.statusCode >= 500) {
        this.markRateLimited(res.retryAfterMs, res.statusCode);
        return result;
      }
      if (res.statusCode !== 200 || !res.data?.data || res.data.errors?.length) {
        this.logger.warn(
          `batch returned ${res.statusCode}${res.data?.errors?.length ? ` errors=${res.data.errors[0]?.message}` : ''} for ${addresses.length} tokens`,
        );
        this.recordOutcome('error');
        return result;
      }
      const ethPriceUsd = Number(res.data.data.bundles?.[0]?.ethPriceUSD ?? 0);
      if (!Number.isFinite(ethPriceUsd) || ethPriceUsd <= 0) {
        this.recordOutcome('miss');
        return result;
      }
      for (const token of res.data.data.tokens ?? []) {
        const price = Number(token.derivedETH ?? 0) * ethPriceUsd;
        if (Number.isFinite(price) && price > 0) {
          result.set(providerAddressKey(chainId, token.id), {
            priceUsd: price,
            confidenceLevel: 'external-verified',
          });
          this.recordOutcome('success');
        } else {
          this.recordOutcome('miss');
        }
      }
      return result;
    } catch (error) {
      this.logger.error(`batch failed for ${addresses.length} tokens: ${error}`);
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

  // Historical pricing is served by `subgraph-historical`; this provider is current-only.
  async getHistoricalSingle(_request: HistoricalReq): Promise<PriceQuote | null> {
    void _request;
    return null;
  }
}
