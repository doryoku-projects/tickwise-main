import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service.js';
import { AlchemyProvider } from './alchemy.provider.js';
import { ChainbaseProvider } from './chainbase.provider.js';
import { CoinGeckoProvider } from './coingecko.provider.js';
import { DefillamaProvider } from './defillama.provider.js';
import { DexScreenerProvider } from './dexscreener.provider.js';
import { DiaProvider } from './dia.provider.js';
import { GeckoTerminalProvider } from './geckoterminal.provider.js';
import { MoralisProvider } from './moralis.provider.js';
import { PoolRatioProvider } from './pool-ratio.provider.js';
import type { PriceMetrics, PriceProvider } from './price-provider.interface.js';
import { SubgraphCurrentProvider } from './subgraph-current.provider.js';
import { SubgraphHistoricalProvider } from './subgraph-historical.provider.js';

const KNOWN_PROVIDERS = [
  'defillama',
  'geckoterminal',
  'dexscreener',
  'coingecko',
  'dia',
  'alchemy',
  'moralis',
  'chainbase',
  'subgraph-current',
  'subgraph-historical',
  'subgraph-pool-ratio',
] as const;
type KnownProviderName = (typeof KNOWN_PROVIDERS)[number];

/**
 * Registry of price providers, ordered by `PRICING_PROVIDERS` env (csv).
 *
 * Each call to `currentProviders()` / `historicalProviders()` returns the
 * configured providers in order, filtered to those that are currently enabled.
 * Availability (rate-limit window) is checked by the orchestrator, not here,
 * so that a rate-limited provider doesn't get permanently dropped — it's
 * still listed but skipped in the per-call walk.
 *
 * PR1 wires DeFiLlama + CoinGecko only. Additional providers (GeckoTerminal,
 * Alchemy, Moralis, Chainbase, Uniswap TWAP) will plug in via the same
 * mechanism in subsequent PRs.
 */
@Injectable()
export class ProviderRegistry {
  private readonly logger = new Logger(ProviderRegistry.name);
  private readonly orderedProviders: PriceProvider[];

  constructor(
    @Inject(AppConfigService) config: AppConfigService,
    @Inject(DefillamaProvider) defillama: DefillamaProvider,
    @Inject(DexScreenerProvider) dexscreener: DexScreenerProvider,
    @Inject(GeckoTerminalProvider) geckoterminal: GeckoTerminalProvider,
    @Inject(CoinGeckoProvider) coingecko: CoinGeckoProvider,
    @Inject(DiaProvider) dia: DiaProvider,
    @Inject(AlchemyProvider) alchemy: AlchemyProvider,
    @Inject(MoralisProvider) moralis: MoralisProvider,
    @Inject(ChainbaseProvider) chainbase: ChainbaseProvider,
    @Inject(SubgraphCurrentProvider) subgraphCurrent: SubgraphCurrentProvider,
    @Inject(SubgraphHistoricalProvider) subgraphHistorical: SubgraphHistoricalProvider,
    @Inject(PoolRatioProvider) poolRatio: PoolRatioProvider,
  ) {
    const byName: Record<KnownProviderName, PriceProvider> = {
      defillama,
      dexscreener,
      geckoterminal,
      coingecko,
      dia,
      alchemy,
      moralis,
      chainbase,
      'subgraph-current': subgraphCurrent,
      'subgraph-historical': subgraphHistorical,
      'subgraph-pool-ratio': poolRatio,
    };
    const order = parseProviderList(config.pricingProviders);
    const seen = new Set<string>();
    const result: PriceProvider[] = [];
    for (const name of order) {
      if (seen.has(name)) continue;
      const provider = byName[name as KnownProviderName];
      if (!provider) {
        this.logger.warn(`unknown pricing provider in PRICING_PROVIDERS: '${name}' — skipping`);
        continue;
      }
      if (!provider.isEnabled()) {
        this.logger.log(`pricing provider '${name}' disabled at config — skipping`);
        continue;
      }
      seen.add(name);
      result.push(provider);
    }
    if (result.length === 0) {
      this.logger.warn('no pricing providers enabled — all external price lookups will return 0');
    } else {
      this.logger.log(`pricing providers enabled (in order): ${result.map((p) => p.name).join(', ')}`);
      const lastIndex = result.length - 1;
      const poolRatioIndex = result.findIndex((p) => p.name === 'subgraph-pool-ratio');
      if (poolRatioIndex >= 0 && poolRatioIndex !== lastIndex) {
        this.logger.warn(
          `pool-ratio provider should be configured last in PRICING_PROVIDERS (currently at index ${poolRatioIndex} of ${lastIndex}) — derivation needs anchor prices from earlier providers`,
        );
      }
    }
    this.orderedProviders = result;
  }

  /** Providers capable of serving current-price lookups, in configured order. */
  currentProviders(): PriceProvider[] {
    return this.orderedProviders;
  }

  /** Providers capable of serving historical lookups, in configured order. */
  historicalProviders(): PriceProvider[] {
    return this.orderedProviders;
  }

  /** Per-provider outcome counters for admin/observability surfaces. */
  getMetricsSnapshot(): Record<string, PriceMetrics> {
    const snapshot: Record<string, PriceMetrics> = {};
    for (const provider of this.orderedProviders) {
      snapshot[provider.name] = provider.getMetrics();
    }
    return snapshot;
  }

  /**
   * Returns true if at least one historical-price provider is currently
   * available (not in a rate-limit back-off). Used by callers like the
   * recompute self-heal to skip optimistic re-pricing attempts that would
   * just bounce off 429s and waste cycles. Excludes context-aware providers
   * like `subgraph-pool-ratio` because those need anchor prices from an
   * external provider — when every external is benched, TWAP can't help.
   */
  hasAnyAvailableHistoricalProvider(): boolean {
    for (const provider of this.orderedProviders) {
      if (provider.name === 'subgraph-pool-ratio') continue;
      if (provider.isAvailable()) return true;
    }
    return false;
  }
}

export function parseProviderList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}
