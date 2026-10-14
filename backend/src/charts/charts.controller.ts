import { BadRequestException, Controller, Get, Inject, Param, ParseIntPipe, Query, Res, UseGuards } from '@nestjs/common';
import { AnonCost } from '../common/api-cost.js';
import { ApiRateLimitGuard } from '../common/api-rate-limit.guard.js';
import { withReadHeaders, type HeaderTarget } from '../common/cache/read-headers.js';
import { FirstPartyOriginGuard } from '../common/first-party-origin.guard.js';
import { ChartsService } from './charts.service.js';
import type { ChartRange } from './charts.service.js';

const RANGES = ['30d', '60d', '90d', '180d', 'all'];
// A position id is a tokenId: digits. Anything else cannot match a position,
// and this route would still spend a database lookup (and an indexer read)
// finding that out, per unauthenticated request.
const POSITION_ID_RE = /^[0-9]{1,30}$/;

// First-party only (CORS_ORIGINS allowlist) behind a per-address budget
// (`ApiRateLimitGuard`); keyed clients use /v1.
@Controller('api/top-positions')
@UseGuards(FirstPartyOriginGuard, ApiRateLimitGuard)
export class ChartsController {
  constructor(@Inject(ChartsService) private readonly charts: ChartsService) {}

  @Get(':chainId/:protocol/:positionId/charts')
  @AnonCost('chart')
  getCharts(
    @Param('chainId', ParseIntPipe) chainId: number,
    @Param('protocol') protocol: string,
    @Param('positionId') positionId: string,
    @Res({ passthrough: true }) res: HeaderTarget,
    @Query('range') range?: string,
  ) {
    if (!POSITION_ID_RE.test(positionId)) {
      throw new BadRequestException({ error: 'Invalid positionId', positionId: positionId.slice(0, 64) });
    }
    const r = (RANGES.includes(range ?? '') ? range : '30d') as ChartRange;
    // The position lookup is a user read (2 s budget): its timeout is a 503
    // that carries `Retry-After`, like every other user-read route.
    return withReadHeaders(res, () => this.charts.getPositionCharts(chainId, protocol, positionId, r));
  }
}
