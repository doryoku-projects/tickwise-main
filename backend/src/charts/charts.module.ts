import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module.js';
import { SubgraphModule } from '../subgraph/subgraph.module.js';
import { ChartInputsService } from './chart-inputs.service.js';
import { ChartsController } from './charts.controller.js';
import { ChartsService } from './charts.service.js';

@Module({
  imports: [SubgraphModule, CommonModule],
  controllers: [ChartsController],
  // `ChartInputsService` is exported so position detail (LeaderboardModule)
  // shares the charts' transaction cache and single-flight: one instance, one
  // walk for a detail + charts pair.
  providers: [ChartsService, ChartInputsService],
  exports: [ChartsService, ChartInputsService],
})
export class ChartsModule {}
