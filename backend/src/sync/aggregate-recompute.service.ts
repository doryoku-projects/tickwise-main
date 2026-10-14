import { Inject, Injectable, Logger } from '@nestjs/common';
import { PositionsRepository } from '../database/positions.repository.js';
import { PricingService } from '../pricing/pricing.service.js';
import { computePerformanceFromAggregates } from '../positions/position-performance.js';

/**
 * Recompute path for aggregates-mode (v4) positions. The indexer
 * accumulates per-position cashflow aggregates (deposited/withdrawn/collected/
 * gas) directly on the position row, so the vs-HODL metric set is derived from
 * those + current prices via `computePerformanceFromAggregates` — with NO
 * transaction history. This deliberately does NOT live in
 * `transaction-sync.service` (which Phase 7 removes); it persists through the
 * same `updatePerformanceMetrics` path so leaderboard sorts/filters are
 * unaffected. The vs-USD basis + per-tx detail list are served on-demand from
 * the indexer by the detail endpoint, not here.
 *
 * Since 2026-10-03 the sync paths (backfill flushes, the refresh and live
 * refresh) compute the same metrics INSIDE their upsert
 * (`PositionsRepository.upsertMany(…, { aggregates })`), one write per
 * position. `recompute` is now only the admin healer's second pass
 * (`SyncService.recomputeAllAggregates`, over rows no sync rewrites — closed
 * positions whose metrics predate a fix).
 */
@Injectable()
export class AggregateRecomputeService {
  private readonly logger = new Logger(AggregateRecomputeService.name);

  constructor(
    @Inject(PositionsRepository) private readonly positions: PositionsRepository,
    @Inject(PricingService) private readonly pricing: PricingService,
  ) {}

  /**
   * The current native (gas-token) USD price the recompute values gas at; 0
   * when it cannot be read, which makes `buildPerformancePatch` fall back to
   * the tx-time gas USD. Callers fetch it once per flush.
   */
  async ethPriceNow(chainId: number): Promise<number> {
    try {
      return await this.pricing.currentNativeUsd(chainId);
    } catch {
      return 0;
    }
  }

  async recompute(chainId: number, protocol: string, positionIds: string[]): Promise<number> {
    if (positionIds.length === 0) return 0;
    const positions = await this.positions.findManyByPositionIds(chainId, protocol, positionIds);
    if (positions.length === 0) return 0;
    // Value gas at the current ETH price (matches the tx-based recompute).
    const ethPriceNow = await this.ethPriceNow(chainId);
    const updates = positions.map((position) =>
      computePerformanceFromAggregates(position, { ethPriceNow }),
    );
    const updated = await this.positions.updatePerformanceMetrics(chainId, protocol, updates);
    this.logger.debug(
      `Aggregate recompute ${chainId}:${protocol} positions=${positions.length} updated=${updated}`,
    );
    return updated;
  }
}
