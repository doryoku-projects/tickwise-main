import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module.js';
import { QueuesModule } from '../queues/queues.module.js';
import { AdminBillingController } from './admin-billing.controller.js';
import { ApiKey, ApiKeySchema } from './api-key.schema.js';
import { ClientsService } from './clients.service.js';
import { Customer, CustomerSchema } from './customer.schema.js';
import { EndpointCost, EndpointCostSchema } from './endpoint-cost.schema.js';
import { EndpointCostsService } from './endpoint-costs.service.js';
import { MeteringService } from './metering.service.js';
import { Plan, PlanSchema } from './plan.schema.js';
import { PlansService } from './plans.service.js';
import { SettingsCacheService } from './settings-cache.service.js';
import { UsageBucket, UsageBucketSchema } from './usage-bucket.schema.js';
import { UsageBucketService } from './usage-bucket.service.js';
import { UsageFlushService } from './usage-flush.service.js';
import { Usage, UsageSchema } from './usage.schema.js';

/**
 * Held in a const so it can be RE-EXPORTED: a downstream module (payments,
 * portal) that needs the `Customer`/`Plan` models gets them by importing
 * `BillingModule`, instead of registering a second `forFeature` for the same
 * schemas.
 */
const BillingMongooseModule = MongooseModule.forFeature([
  { name: Plan.name, schema: PlanSchema },
  { name: EndpointCost.name, schema: EndpointCostSchema },
  { name: Customer.name, schema: CustomerSchema },
  { name: ApiKey.name, schema: ApiKeySchema },
  { name: Usage.name, schema: UsageSchema },
  { name: UsageBucket.name, schema: UsageBucketSchema },
]);

@Module({
  imports: [AuthModule, QueuesModule, BillingMongooseModule],
  controllers: [AdminBillingController],
  providers: [
    SettingsCacheService,
    MeteringService,
    ClientsService,
    PlansService,
    EndpointCostsService,
    UsageBucketService,
    // `USAGE_WRITE_MODE=batched` buffer + flusher; inert in `direct` (default).
    UsageFlushService,
  ],
  // `PlansService` is exported for the subscribe path, which must read the
  // authoritative plan document from Mongo rather than a 30s-stale cache when
  // it locks `unitAmountMinor` onto a subscription. Public/pricing reads should
  // still go through `SettingsCacheService.listPublicPlans()`.
  exports: [
    SettingsCacheService,
    MeteringService,
    ClientsService,
    PlansService,
    // Resolved out of the app container by the access-log middleware in
    // `main.ts` (`app.get`, which searches every module), so it needs no
    // importer — exported so the usage-detail read paths in `portal`/`payments`
    // can inject it the ordinary way when they land.
    UsageBucketService,
    // For the admin status (`metrics()`: buffered keys, last flush age, failures).
    UsageFlushService,
    BillingMongooseModule,
  ],
})
export class BillingModule {}
