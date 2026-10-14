import { Module } from '@nestjs/common';
import { SyncModule } from '../sync/sync.module.js';
import { QueueService } from './queue.service.js';

@Module({
  imports: [SyncModule],
  providers: [QueueService],
  exports: [QueueService],
})
export class QueuesModule {}
