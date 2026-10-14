import { BadRequestException, Controller, Get, Inject, Param, ParseIntPipe, Query, Res, UseGuards } from '@nestjs/common';
import { AnonCost } from '../common/api-cost.js';
import { assertApiPageLimit } from '../common/api-page-limit.js';
import { ApiRateLimitGuard } from '../common/api-rate-limit.guard.js';
import { ChartsService, type ChartRange } from '../charts/charts.service.js';
import { withReadHeaders, type HeaderTarget } from '../common/cache/read-headers.js';
import { FirstPartyOriginGuard } from '../common/first-party-origin.guard.js';
import { TopPoolsQueryDto } from './dto/top-pools-query.dto.js';
import { PoolsService } from './pools.service.js';

const POOL_CHART_RANGES = ['30d', '60d', '90d', '180d', 'all'];
// v4 pool ids are 32-byte hashes (0x + 64 hex); v3 pools are 40-char
// addresses. Reject anything else BEFORE the charts route fans out to the
// external subgraph — a junk id would otherwise trigger several first:1000
// GraphQL queries against the paid Graph endpoint per unauthenticated request.
const POOL_ID_RE = /^0x[0-9a-fA-F]{40}$|^0x[0-9a-fA-F]{64}$/;

function assertPoolId(poolId: string): void {
  if (!POOL_ID_RE.test(poolId)) {
    throw new BadRequestException({ error: 'Invalid poolId', poolId });
  }
}

// First-party only (CORS_ORIGINS allowlist) behind a per-address budget
// (`ApiRateLimitGuard`); keyed clients use /v1. See `LeaderboardController`.
@Controller('api/top-pools')
@UseGuards(FirstPartyOriginGuard, ApiRateLimitGuard)
export class PoolsController {
  constructor(
    @Inject(PoolsService) private readonly pools: PoolsService,
    @Inject(ChartsService) private readonly charts: ChartsService,
  ) {}

  @Get()
  @AnonCost('list')
  getTopPools(@Query() query: TopPoolsQueryDto, @Res({ passthrough: true }) res: HeaderTarget) {
    assertApiPageLimit(query);
    return withReadHeaders(res, (meta) => this.pools.getTopPools(query, { meta }));
  }

  /**
   * The capped total for the list's filters (the list answers `totalPending`
   * until cached). Never a 5xx: not in yet → `{total: null, capped: false, pending: true}`.
   */
  @Get('count')
  @AnonCost('count')
  getTopPoolsCount(@Query() query: TopPoolsQueryDto, @Res({ passthrough: true }) res: HeaderTarget) {
    return withReadHeaders(res, (meta) => this.pools.getTopPoolsCount(query, meta));
  }

  @Get(':chainId/:protocol/:poolId')
  @AnonCost('detail')
  getPool(
    @Param('chainId', ParseIntPipe) chainId: number,
    @Param('protocol') protocol: string,
    @Param('poolId') poolId: string,
    @Res({ passthrough: true }) res: HeaderTarget,
  ) {
    assertPoolId(poolId);
    return withReadHeaders(res, (meta) => this.pools.getPool(chainId, protocol, poolId, meta));
  }

  @Get(':chainId/:protocol/:poolId/charts')
  @AnonCost('chart')
  getPoolCharts(
    @Param('chainId', ParseIntPipe) chainId: number,
    @Param('protocol') protocol: string,
    @Param('poolId') poolId: string,
    @Res({ passthrough: true }) res: HeaderTarget,
    @Query('range') range?: string,
  ) {
    assertPoolId(poolId);
    const r = (POOL_CHART_RANGES.includes(range ?? '') ? range : '30d') as ChartRange;
    return withReadHeaders(res, () => this.charts.getPoolCharts(chainId, protocol, poolId, r));
  }
}
