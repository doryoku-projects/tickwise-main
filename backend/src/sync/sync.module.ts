import { Module } from '@nestjs/common';
import { PricingModule } from '../pricing/pricing.module.js';
import { SubgraphModule } from '../subgraph/subgraph.module.js';
import { LiveEventListenerService } from './live-event-listener.service.js';
import { PositionLiveRefreshService } from './position-live-refresh.service.js';
import { PoolsSyncService } from './pools-sync.service.js';
import { SyncService } from './sync.service.js';
import { TransactionSyncService } from './transaction-sync.service.js';
import { AggregateRecomputeService } from './aggregate-recompute.service.js';
import { TokenSecuritySyncService } from './token-security-sync.service.js';
import { TokenPriceSyncService } from './token-price-sync.service.js';
import { PositionFeeRefreshService } from './position-fee-refresh.service.js';

@Module({
  imports: [SubgraphModule, PricingModule],
  providers: [
    SyncService,
    TransactionSyncService,
    LiveEventListenerService,
    PositionLiveRefreshService,
    AggregateRecomputeService,
    PoolsSyncService,
    TokenSecuritySyncService,
    TokenPriceSyncService,
    PositionFeeRefreshService,
  ],
  exports: [
    SyncService,
    TransactionSyncService,
    LiveEventListenerService,
    PositionLiveRefreshService,
    PoolsSyncService,
    TokenSecuritySyncService,
    TokenPriceSyncService,
    PositionFeeRefreshService,
  ],
})
export class SyncModule {}
