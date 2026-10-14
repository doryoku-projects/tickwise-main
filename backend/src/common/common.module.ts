import { Module } from '@nestjs/common';
import { ApiLimitService } from './api-limit.service.js';
import { ApiRateLimitGuard } from './api-rate-limit.guard.js';
import { ClientIpEchoController } from './client-ip-echo.controller.js';
import { FirstPartyOriginGuard } from './first-party-origin.guard.js';

/**
 * Shared cross-cutting providers. Exports FirstPartyOriginGuard and
 * ApiRateLimitGuard so the open `/api/*` data modules (leaderboard, charts,
 * pools) can apply them via `@UseGuards`; `ApiLimitService` is the one
 * per-process holder of the per-IP budget's state. AppConfigService (their
 * dependency) is `@Global()`, as is the CoordinationModule that provides
 * `LimiterFactory`.
 */
@Module({
  controllers: [ClientIpEchoController],
  providers: [FirstPartyOriginGuard, ApiLimitService, ApiRateLimitGuard],
  exports: [FirstPartyOriginGuard, ApiLimitService, ApiRateLimitGuard],
})
export class CommonModule {}
