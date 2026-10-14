import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Param,
  ParseIntPipe,
  Query,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ROUTE_KEYS } from '../billing/endpoint-costs.seed.js';
import { ChartsService, type ChartRange } from '../charts/charts.service.js';
import { withReadHeaders, type HeaderTarget } from '../common/cache/read-headers.js';
import { V1_COUNT_WAIT_MS } from '../leaderboard/count-cache.js';
import { TopPoolsQueryDto } from '../pools/dto/top-pools-query.dto.js';
import { PoolsService } from '../pools/pools.service.js';
import { ApiKeyGuard } from './api-key.guard.js';
import { MeteringGuard } from './metering.guard.js';
import { MeteringInterceptor } from './metering.interceptor.js';
import { UnitCost } from './unit-cost.decorator.js';

const POOL_CHART_RANGES = ['30d', '60d', '90d', '180d', 'all'];
// v4 pool ids are 32-byte hashes (0x + 64 hex); v3 pools are 40-char
// addresses. Reject anything else BEFORE fanning out to the external subgraph
// (mirrors the internal pools controller).
const POOL_ID_RE = /^0x[0-9a-fA-F]{40}$|^0x[0-9a-fA-F]{64}$/;

function assertPoolId(poolId: string): void {
  if (!POOL_ID_RE.test(poolId)) {
    throw new BadRequestException({ error: 'Invalid poolId', poolId });
  }
}

/**
 * Public, metered pools API. Reuses the internal pools + charts services
 * verbatim, so the same TVL/volume/fee leaderboard, pool detail, and pool
 * charts the dashboard uses are available to API-key clients.
 */
@Controller('v1/pools')
@UseGuards(ApiKeyGuard, MeteringGuard)
@UseInterceptors(MeteringInterceptor)
export class V1PoolsController {
  constructor(
    @Inject(PoolsService) private readonly pools: PoolsService,
    @Inject(ChartsService) private readonly charts: ChartsService,
  ) {}

  /** As `/api/top-pools`, waiting up to `V1_COUNT_WAIT_MS` for an uncached count (else a flagged floor). */
  @Get()
  @UnitCost(ROUTE_KEYS.poolsList)
  list(@Query() query: TopPoolsQueryDto, @Res({ passthrough: true }) res: HeaderTarget) {
    return withReadHeaders(res, (meta) => this.pools.getTopPools(query, { meta, countWaitMs: V1_COUNT_WAIT_MS }));
  }

  @Get(':chainId/:protocol/:poolId')
  @UnitCost(ROUTE_KEYS.poolsDetail)
  detail(
    @Param('chainId', ParseIntPipe) chainId: number,
    @Param('protocol') protocol: string,
    @Param('poolId') poolId: string,
    @Res({ passthrough: true }) res: HeaderTarget,
  ) {
    assertPoolId(poolId);
    return withReadHeaders(res, (meta) => this.pools.getPool(chainId, protocol, poolId, meta));
  }

  @Get(':chainId/:protocol/:poolId/charts')
  @UnitCost(ROUTE_KEYS.poolsCharts)
  poolCharts(
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
