import { Module } from '@nestjs/common';
import { ChartsModule } from '../charts/charts.module.js';
import { CommonModule } from '../common/common.module.js';
import { LeaderboardModule } from '../leaderboard/leaderboard.module.js';
import { ReadModelsModule } from '../read-models/read-models.module.js';
import { PoolsController } from './pools.controller.js';
import { PoolsService } from './pools.service.js';

@Module({
  // LeaderboardModule for the shared `LeaderboardCountService`; ReadModelsModule
  // for the pool catalog (P-R R2 — inert while the pools model is off).
  imports: [ChartsModule, CommonModule, LeaderboardModule, ReadModelsModule],
  controllers: [PoolsController],
  providers: [PoolsService],
  exports: [PoolsService],
})
export class PoolsModule {}
