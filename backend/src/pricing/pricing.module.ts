import { Module } from '@nestjs/common';
import { PricingService } from './pricing.service.js';
import { AlchemyProvider } from './providers/alchemy.provider.js';
import { ChainbaseProvider } from './providers/chainbase.provider.js';
import { CoinGeckoProvider } from './providers/coingecko.provider.js';
import { DefillamaProvider } from './providers/defillama.provider.js';
import { DexScreenerProvider } from './providers/dexscreener.provider.js';
import { DiaProvider } from './providers/dia.provider.js';
import { GeckoTerminalProvider } from './providers/geckoterminal.provider.js';
import { MoralisProvider } from './providers/moralis.provider.js';
import { PoolRatioProvider } from './providers/pool-ratio.provider.js';
import { ProviderRegistry } from './providers/provider-registry.js';
import { SubgraphCurrentProvider } from './providers/subgraph-current.provider.js';
import { SubgraphHistoricalProvider } from './providers/subgraph-historical.provider.js';
import { TokenListingService } from './token-listing.service.js';
import { TokenTrustService } from './token-trust.service.js';
import { GECKOTERMINAL_GCRA } from './providers/geckoterminal.provider.js';
import { CoordinationRedis } from '../common/coordination-redis.js';
import { RedisGcra, geckoTerminalGcraBackend } from '../common/redis-gcra.js';

@Module({
  providers: [
    // P2.5: the fleet-wide GeckoTerminal bucket on redis-state, used only with
    // GECKOTERMINAL_BUDGET=shared (default off = today: no call is paced).
    {
      provide: GECKOTERMINAL_GCRA,
      inject: [CoordinationRedis],
      useFactory: (coordination: CoordinationRedis) => geckoTerminalGcraBackend(new RedisGcra(() => coordination.client())),
    },
    DefillamaProvider,
    DexScreenerProvider,
    GeckoTerminalProvider,
    CoinGeckoProvider,
    DiaProvider,
    AlchemyProvider,
    MoralisProvider,
    ChainbaseProvider,
    SubgraphCurrentProvider,
    SubgraphHistoricalProvider,
    PoolRatioProvider,
    ProviderRegistry,
    TokenListingService,
    // The ONE token-trust answer (TOKEN_TRUST_MODE), shared by the position
    // path (PricingService) and the pools sync so the two cannot disagree.
    TokenTrustService,
    PricingService,
  ],
  exports: [PricingService, ProviderRegistry, PoolRatioProvider, TokenListingService, TokenTrustService],
})
export class PricingModule {}
