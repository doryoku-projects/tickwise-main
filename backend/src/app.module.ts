import { Module } from '@nestjs/common';
import { AdminModule } from './admin/admin.module.js';
import { AuthModule } from './auth/auth.module.js';
import { BillingModule } from './billing/billing.module.js';
import { ChartsModule } from './charts/charts.module.js';
import { AppConfigModule } from './config/app-config.module.js';
import { CoordinationModule } from './common/coordination.module.js';
import { DatabaseModule } from './database/database.module.js';
import { HealthModule } from './health/health.module.js';
import { IdentityModule } from './identity/identity.module.js';
import { LeaderboardModule } from './leaderboard/leaderboard.module.js';
import { PaymentsModule } from './payments/payments.module.js';
import { PoolsModule } from './pools/pools.module.js';
import { PortalModule } from './portal/portal.module.js';
import { PositionsModule } from './positions/positions.module.js';
import { PricingModule } from './pricing/pricing.module.js';
import { QueuesModule } from './queues/queues.module.js';
import { ReadModelsModule } from './read-models/read-models.module.js';
import { SubgraphModule } from './subgraph/subgraph.module.js';
import { SyncModule } from './sync/sync.module.js';
import { V1Module } from './v1/v1.module.js';

import { SecurityModule } from './security/security.module.js';

@Module({
  imports: [
    AppConfigModule,
    // P2/P3 coordination (global): leases, flow locks, status fan-in, shared
    // limiters / invalidation / RPC budget, fee coordination. Inert with the
    // defaults (`PROCESS_ROLE=all`, `PROCESS_LEASES=auto`, every flag off).
    CoordinationModule,
    DatabaseModule,
    SecurityModule,
    PricingModule,
    SubgraphModule,
    PositionsModule,
    LeaderboardModule,
    PoolsModule,
    // Phase P-R read models (R1: the feeder). Inert while every model is `off`
    // (the default): no Redis connection, no key, no worker, no Mongo read.
    ReadModelsModule,
    ChartsModule,
    SyncModule,
    QueuesModule,
    AdminModule,
    AuthModule,
    BillingModule,
    PortalModule,
    // Customer SSO (/account/auth/oauth/*, /account/auth/wallet/*,
    // /account/identities). AFTER PortalModule: both mount on `/account/auth`,
    // and keeping the password routes first makes the registration order match
    // how the two read.
    IdentityModule,
    // Self-serve subscriptions (`/account/billing/*`, `/webhooks/payments/*`,
    // `/admin/{subscriptions,payments,revenue}`). AFTER the two `/account`
    // modules above: it depends on both, and the registration order matches the
    // order a customer meets the routes — sign in, keys, then billing.
    PaymentsModule,
    V1Module,
    HealthModule,
  ],
})
export class AppModule {}
