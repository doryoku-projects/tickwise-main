import { Global, Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AppConfigModule } from '../config/app-config.module.js';
import { AppConfigService } from '../config/app-config.service.js';
import { PageLadderService } from '../common/cache/page-ladder.js';
import { ReadPathRedis } from '../common/cache/read-path-redis.js';
import { ReadBudgetService } from '../common/read-budget.js';
import { RuntimeMetricsService } from '../common/runtime-metrics.js';
import { SyncCursor, SyncCursorSchema } from './schemas/sync-cursor.schema.js';
import { SyncRun, SyncRunSchema } from './schemas/sync-run.schema.js';
import { CollectionResolver } from './collection-resolver.js';
import { PoolsRepository } from './pools.repository.js';
import { PositionTransactionsRepository } from './position-transactions.repository.js';
import { PositionsRepository } from './positions.repository.js';
import { ReplicationLagMonitor } from './replication-lag.js';
import { SyncRepository } from './sync.repository.js';
import { TokenPriceRepository } from './token-price.repository.js';
import { TokensRepository } from './token.repository.js';
import { WriteBudgetService } from '../common/write-budget.js';
import { WriteBudgetController } from '../common/write-budget-controller.js';
import { MongoMonitor } from './mongo-monitor.js';
import { POSITION_WRITE_OBSERVER } from './positions.repository.js';
import { FeeRowHintPublisher } from '../sync/fee-row-hint-publisher.js';

/** The Mongoose connection options (see the comment on `forRootAsync` below). */
export function mongoConnectionOptions(
  config: Pick<AppConfigService, 'mongodbUri' | 'mongoAppName' | 'mongoMaxPoolSize' | 'mongoWaitQueueTimeoutMs'>,
) {
  return {
    uri: config.mongodbUri,
    appName: config.mongoAppName,
    maxPoolSize: config.mongoMaxPoolSize,
    waitQueueTimeoutMS: config.mongoWaitQueueTimeoutMs,
  };
}

@Global()
@Module({
  imports: [
    MongooseModule.forRootAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      // Client limits (scale plan 1.8, 2026-10-03). The pool was the driver's
      // default 100 connections per member with an UNBOUNDED wait queue: on
      // 2026-10-01 unindexed scans filled it and every API read queued 25–55 s
      // behind them. Now a named client (`appName`, visible in the server log,
      // `currentOp` and Atlas), `maxPoolSize` per member, and a wait-queue
      // limit after which an operation fails (`MongoWaitQueueTimeoutError`; a
      // user read answers it like a `maxTimeMS` timeout — `isMaxTimeMSExpired`).
      // Read preference stays per query (`USER_READ_PREFERENCE`,
      // maxStalenessSeconds 120) and the write concern stays the URI's /
      // server default (`w: majority`). Checkout waits are metered by
      // `RuntimeMetricsService` (`GET /admin/sync/status` → `runtime`).
      // autoIndex is decided per SHARD schema, not here (`CollectionResolver`).
      useFactory: (config: AppConfigService) => mongoConnectionOptions(config),
    }),
    // Singleton (un-sharded) registrations for SyncCursor + SyncRun. The
    // sharded schemas (Position, PositionTransaction, TokenPriceHistorical,
    // TokenSecurity) are registered per (chainId[, protocol]) by
    // `CollectionResolver` at boot and reach callers through the repositories —
    // never via `@InjectModel`.
    MongooseModule.forFeature([
      { name: SyncCursor.name, schema: SyncCursorSchema },
      { name: SyncRun.name, schema: SyncRunSchema },
    ]),
  ],
  // The read path's shared pieces live here because the repositories (this
  // module) are their main users and this module is global: the Redis client
  // for the global read budget and the deep-page ladder, the budget itself
  // (also used by the leaderboard count service) and the ladder.
  providers: [
    ReadPathRedis,
    ReadBudgetService,
    PageLadderService,
    ReplicationLagMonitor,
    // Event-loop delay + Mongo pool checkout wait (`/admin/sync/status` → `runtime`).
    RuntimeMetricsService,
    // P2.4: the ONE shared write budget (its Redis is `WRITE_BUDGET_REDIS` =
    // CoordinationRedis, CoordinationModule), the Mongo monitor and the AIMD
    // controller. The repositories, the fee service and the admin share it;
    // `WRITE_BUDGET_MODE=off` (default) = inert (`processWriteBudget()` still
    // carries MONGO_BULK_WRITE_MAX_OPS).
    WriteBudgetService,
    MongoMonitor,
    WriteBudgetController,
    // P3.3: every position write is told to the fee candidate store
    // (`PositionWriteObserver`). With leases off it hands rows straight to the
    // fee service in this process; nothing is published unless the RAM store
    // is on (POSITION_FEE_CANDIDATES=memory). Never injects a repository: no
    // DI cycle with PositionFeeRefreshService.
    FeeRowHintPublisher,
    { provide: POSITION_WRITE_OBSERVER, useExisting: FeeRowHintPublisher },
    CollectionResolver,
    PoolsRepository,
    PositionsRepository,
    PositionTransactionsRepository,
    SyncRepository,
    TokenPriceRepository,
    TokensRepository,
  ],
  exports: [
    MongooseModule,
    ReadPathRedis,
    ReadBudgetService,
    PageLadderService,
    CollectionResolver,
    PoolsRepository,
    PositionsRepository,
    PositionTransactionsRepository,
    SyncRepository,
    TokenPriceRepository,
    TokensRepository,
    WriteBudgetService,
    WriteBudgetController,
    MongoMonitor,
    FeeRowHintPublisher,
    POSITION_WRITE_OBSERVER,
  ],
})
export class DatabaseModule {}
