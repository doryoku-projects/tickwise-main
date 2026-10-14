import { Controller, Get, Inject, Param, ParseIntPipe, Query, Res, UseGuards, UseInterceptors } from '@nestjs/common';
import { ROUTE_KEYS } from '../billing/endpoint-costs.seed.js';
import { ChartsService, type ChartRange } from '../charts/charts.service.js';
import { withReadHeaders, type HeaderTarget } from '../common/cache/read-headers.js';
import { V1_COUNT_WAIT_MS } from '../leaderboard/count-cache.js';
import { TopPositionsQueryDto } from '../leaderboard/dto/top-positions-query.dto.js';
import { LeaderboardService } from '../leaderboard/leaderboard.service.js';
import { ApiKeyGuard } from './api-key.guard.js';
import { MeteringGuard } from './metering.guard.js';
import { MeteringInterceptor } from './metering.interceptor.js';
import { UnitCost } from './unit-cost.decorator.js';

// Mirrors the internal charts controller — clamp to a known range so a junk
// value can't fan out unbounded queries against the paid Graph endpoint.
const CHART_RANGES = ['30d', '60d', '90d', '180d', 'all'];

/**
 * Public, metered positions API. Reuses the existing leaderboard + charts
 * services + query DTO verbatim, so every filter and sort is available to
 * every client.
 */
@Controller('v1/positions')
@UseGuards(ApiKeyGuard, MeteringGuard)
@UseInterceptors(MeteringInterceptor)
export class V1PositionsController {
  constructor(
    @Inject(LeaderboardService) private readonly leaderboard: LeaderboardService,
    @Inject(ChartsService) private readonly charts: ChartsService,
  ) {}

  /**
   * Same page as `/api/top-positions`, except that an uncached count is waited
   * for up to `V1_COUNT_WAIT_MS`; past that `pagination.total` is the floor the
   * page proves, flagged `totalCapped` (additive).
   */
  @Get()
  @UnitCost(ROUTE_KEYS.positionsList)
  list(@Query() query: TopPositionsQueryDto, @Res({ passthrough: true }) res: HeaderTarget) {
    return withReadHeaders(res, (meta) =>
      this.leaderboard.getTopPositions(query, { meta, countWaitMs: V1_COUNT_WAIT_MS }),
    );
  }

  @Get(':chainId/:protocol/:positionId')
  @UnitCost(ROUTE_KEYS.positionsDetail)
  detail(
    @Param('chainId', ParseIntPipe) chainId: number,
    @Param('protocol') protocol: string,
    @Param('positionId') positionId: string,
    @Res({ passthrough: true }) res: HeaderTarget,
  ) {
    return withReadHeaders(res, (meta) => this.leaderboard.getPosition(chainId, protocol, positionId, meta));
  }

  @Get(':chainId/:protocol/:positionId/charts')
  @UnitCost(ROUTE_KEYS.positionsCharts)
  positionCharts(
    @Param('chainId', ParseIntPipe) chainId: number,
    @Param('protocol') protocol: string,
    @Param('positionId') positionId: string,
    @Res({ passthrough: true }) res: HeaderTarget,
    @Query('range') range?: string,
  ) {
    const r = (CHART_RANGES.includes(range ?? '') ? range : '30d') as ChartRange;
    return withReadHeaders(res, () => this.charts.getPositionCharts(chainId, protocol, positionId, r));
  }
}
