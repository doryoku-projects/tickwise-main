import { Controller, Get, Inject, Param, ParseIntPipe, Query, Res, UseGuards } from '@nestjs/common';
import { AnonCost } from '../common/api-cost.js';
import { assertApiPageLimit } from '../common/api-page-limit.js';
import { ApiRateLimitGuard } from '../common/api-rate-limit.guard.js';
import { withReadHeaders, type HeaderTarget } from '../common/cache/read-headers.js';
import { FirstPartyOriginGuard } from '../common/first-party-origin.guard.js';
import { TopPositionsQueryDto } from './dto/top-positions-query.dto.js';
import { LeaderboardService } from './leaderboard.service.js';

// First-party only: keyless access restricted to the CORS_ORIGINS allowlist;
// everyone else uses the metered /v1 API with a key. The Origin check is only
// a cheap first filter (a script can forge the header), so the budget behind it
// (`ApiRateLimitGuard`, per client address, priced by `@AnonCost`) is what
// bounds one caller; `limit` is capped at 25 here, never in the DTO /v1 shares.
//
// `@Res({ passthrough: true })` only to set `X-Cache` / `Retry-After`; Nest
// still serialises the returned body.
@Controller('api/top-positions')
@UseGuards(FirstPartyOriginGuard, ApiRateLimitGuard)
export class LeaderboardController {
  constructor(@Inject(LeaderboardService) private readonly leaderboard: LeaderboardService) {}

  @Get()
  @AnonCost('list')
  getTopPositions(@Query() query: TopPositionsQueryDto, @Res({ passthrough: true }) res: HeaderTarget) {
    assertApiPageLimit(query);
    return withReadHeaders(res, (meta) => this.leaderboard.getTopPositions(query, { meta }));
  }

  /**
   * The capped total for the same filters as the list — the list itself never
   * waits on a count and answers `totalPending` until one is cached. Never a
   * 5xx: a count not in yet answers `{total: null, capped: false, pending: true}`.
   */
  @Get('count')
  @AnonCost('count')
  getTopPositionsCount(@Query() query: TopPositionsQueryDto, @Res({ passthrough: true }) res: HeaderTarget) {
    return withReadHeaders(res, (meta) => this.leaderboard.getTopPositionsCount(query, meta));
  }

  @Get(':chainId/:protocol/:positionId')
  @AnonCost('detail')
  getPosition(
    @Param('chainId', ParseIntPipe) chainId: number,
    @Param('protocol') protocol: string,
    @Param('positionId') positionId: string,
    @Res({ passthrough: true }) res: HeaderTarget,
  ) {
    return withReadHeaders(res, (meta) => this.leaderboard.getPosition(chainId, protocol, positionId, meta));
  }
}
