import { Module } from '@nestjs/common';
import { ReadModelsReadyController } from './health-ready.controller.js';
import { ModelsRedis } from './models-redis.js';
import { PoolCatalogService } from './pools/pool-catalog.service.js';
import { RankEngineService } from './rank/rank-engine.service.js';
import { ReadModelsService } from './read-models.service.js';
import { StateRedis } from './state-redis.js';

/**
 * Phase P-R read models (design `tickwise-pr-design-2026-10-03`; R1 the
 * feeder and its infrastructure, R2 the pool catalog, R3 the positions rank
 * engine). Imports nothing app-level beyond the global `DatabaseModule` (read
 * budget) and `AppConfigModule`; `AdminModule` imports it for the
 * `/admin/read-models/*` routes and the status block, `PoolsModule` for the
 * catalog and the engine holder counts, `LeaderboardModule` for the rank
 * engine. With every model `off` (the default) nothing here connects, reads
 * or writes. R4 adds `GET /health/ready` (the deploy readiness gate; always
 * 200 while every model is off), lane B, the degraded tracker, the fleet
 * circuit and the memory guard — all inside `ReadModelsService`.
 */
@Module({
  controllers: [ReadModelsReadyController],
  providers: [ModelsRedis, StateRedis, ReadModelsService, PoolCatalogService, RankEngineService],
  exports: [ReadModelsService, PoolCatalogService, RankEngineService],
})
export class ReadModelsModule {}
