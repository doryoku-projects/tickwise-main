import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module.js';
import { ChartsModule } from '../charts/charts.module.js';
import { IndexingStatusService } from '../health/indexing-status.service.js';
import { LeaderboardModule } from '../leaderboard/leaderboard.module.js';
import { PoolsModule } from '../pools/pools.module.js';
import { ApiKeyGuard } from './api-key.guard.js';
import { MeteringGuard } from './metering.guard.js';
import { MeteringInterceptor } from './metering.interceptor.js';
import { V1MetadataController } from './v1-metadata.controller.js';
import { V1PlansController } from './v1-plans.controller.js';
import { V1PoolsController } from './v1-pools.controller.js';
import { V1PositionsController } from './v1-positions.controller.js';
import { V1StatsController } from './v1-stats.controller.js';
import { V1StatsService } from './v1-stats.service.js';

@Module({
  imports: [BillingModule, LeaderboardModule, PoolsModule, ChartsModule],
  // `V1MetadataController`, `V1PlansController` and `V1StatsController` are the
  // unguarded, unmetered ones — they share the bare `v1` prefix but no paths,
  // so order is irrelevant. Their lack of guard/interceptor/@UnitCost IS what
  // makes them free; see the comment on each.
  controllers: [
    V1PositionsController,
    V1PoolsController,
    V1MetadataController,
    V1PlansController,
    V1StatsController,
  ],
  providers: [
    ApiKeyGuard,
    MeteringGuard,
    MeteringInterceptor,
    // LOCAL provider, not an import of `HealthModule`: that module declares
    // `IndexingStatusService` without exporting it, and it is not a file this
    // change owns. Same precedent as `IdentityModule` re-declaring
    // `CustomerJwtGuard`. CONSEQUENCE, and it is why this is a follow-up rather
    // than the end state: unlike that stateless guard, this service holds the
    // indexer-head cache, so a second instance means a second 15s cache — up to
    // four indexer + two DeFiLlama fetches per integration per window instead of
    // two + one (a refresh is a block probe, a timestamp probe and a chain-head
    // fetch). Both are fail-soft and bounded; exporting it from `HealthModule` and
    // importing that here collapses them back to one.
    IndexingStatusService,
    // `/v1/stats`' cache, lease and reads (the controller only delegates).
    V1StatsService,
  ],
})
export class V1Module {}
