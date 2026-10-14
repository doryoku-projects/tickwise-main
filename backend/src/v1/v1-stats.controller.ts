import { Controller, Get, Inject } from '@nestjs/common';
import { V1StatsService, type PublicChainStats, type PublicStats } from './v1-stats.service.js';

export type { PublicChainStats, PublicStats };

/**
 * Public, unauthenticated corpus stats (no API key, no metering): the honest
 * headline numbers — every indexed row, no visibility filters.
 *
 * `positions`/`pools` are deliberately NOT the leaderboard's `pagination.total`:
 * that count runs through `findLeaderboard`'s visibility stack (GoPlus spam
 * `$nin`, the no-real-market exclusion, the open-position value guards), so it
 * answers "how many positions would we SHOW you", not "how many have we
 * indexed". Labelling the filtered number "positions indexed" understated the
 * corpus and was simply untrue; this route answers the question it is named for.
 *
 * FREE-ROUTE MECHANISM: exactly as `V1MetadataController` and
 * `V1PlansController` do it — this controller carries NO `@UseGuards`, NO
 * `@UseInterceptors` and NO `@UnitCost`. That omission IS how a `/v1` route is
 * made free in this codebase; there is no `@Public()` flag, and adding any of
 * those three decorators (or moving this handler onto one of the metered
 * controllers) would 401 every anonymous request. It shares the bare `v1`
 * prefix with those two but no path, so controller order is irrelevant.
 *
 * What it reads and how often (metadata counts, index-only counts, pool-sync's
 * recorded walk totals; one process computes per 45 s through a Redis lease)
 * lives in `V1StatsService`.
 */
@Controller('v1')
export class V1StatsController {
  constructor(@Inject(V1StatsService) private readonly statsService: V1StatsService) {}

  @Get('stats')
  stats(): Promise<PublicStats> {
    return this.statsService.read();
  }
}
