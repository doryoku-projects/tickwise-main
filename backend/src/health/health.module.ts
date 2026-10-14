import { Module } from '@nestjs/common';
import { HealthController } from './health.controller.js';
import { IndexingStatusService } from './indexing-status.service.js';

@Module({
  controllers: [HealthController],
  providers: [IndexingStatusService],
})
export class HealthModule {}
