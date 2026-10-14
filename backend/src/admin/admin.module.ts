import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module.js';
import { QueuesModule } from '../queues/queues.module.js';
import { ReadModelsModule } from '../read-models/read-models.module.js';
import { SyncModule } from '../sync/sync.module.js';
import { AdminController } from './admin.controller.js';

@Module({
  // BillingModule: `UsageFlushService` for the admin status (`usageWrites`).
  imports: [QueuesModule, SyncModule, ReadModelsModule, BillingModule],
  controllers: [AdminController],
})
export class AdminModule {}
