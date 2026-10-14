import { Module } from '@nestjs/common';
import { ChartsModule } from '../charts/charts.module.js';
import { CommonModule } from '../common/common.module.js';
import { ReadModelsModule } from '../read-models/read-models.module.js';
import { SubgraphModule } from '../subgraph/subgraph.module.js';
import { SyncModule } from '../sync/sync.module.js';
import { LeaderboardCountService } from './count-cache.js';
import { LeaderboardWarmupService } from './leaderboard-warmup.service.js';
import { LeaderboardController } from './leaderboard.controller.js';
import { LeaderboardService } from './leaderboard.service.js';

@Module({
  // ChartsModule for `ChartInputsService`: position detail reads its transaction
  // list through the charts' cache, so a detail + charts pair is one walk.
  // SyncModule for `PositionFeeRefreshService` (exported there): opening an
  // active position queues an on-chain fee re-read. No cycle — SyncModule
  // imports only SubgraphModule and PricingModule, neither of which reaches back
  // here, and its providers are the same singletons AppModule already builds.
  // ReadModelsModule for the positions rank engine (P-R R3 — inert while the
  // rank model is off); it imports nothing that reaches back here.
  imports: [SubgraphModule, CommonModule, ChartsModule, SyncModule, ReadModelsModule],
  controllers: [LeaderboardController],
  providers: [LeaderboardService, LeaderboardCountService, LeaderboardWarmupService],
  // `LeaderboardCountService` is shared with `PoolsModule`, so both lists'
  // counts run on the same two count slots.
  exports: [LeaderboardService, LeaderboardCountService],
})
export class LeaderboardModule {}
