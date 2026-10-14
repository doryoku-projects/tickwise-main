import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import { PositionsRepository } from '../database/positions.repository.js';
import { AdapterRegistryService } from '../subgraph/adapter-registry.service.js';
import { TransactionSyncService } from './transaction-sync.service.js';
import { AggregateRecomputeService } from './aggregate-recompute.service.js';

export interface LiveRefreshRequest {
  chainId: number;
  protocol: string;
  tokenId: string;
  blockNumber: number;
}

export interface LiveRefreshResult {
  chainId: number;
  protocol: string;
  tokenId: string;
  positionsUpserted: number;
  transactionsUpserted: number;
}

interface PendingItem {
  req: LiveRefreshRequest;
  resolve: (result: LiveRefreshResult) => void;
  reject: (err: Error) => void;
}

@Injectable()
export class PositionLiveRefreshService {
  private readonly logger = new Logger(PositionLiveRefreshService.name);
  /**
   * In-process scheduler that coalesces per-token live-refresh requests into
   * a single batched subgraph call. Each public `refreshPosition` enqueues
   * into the pending list and awaits the resolved result; the scheduler
   * flushes when the batch hits `liveRefreshBatchSize` OR when
   * `liveRefreshFlushMs` elapses since the first enqueue, whichever first.
   *
   * Keyed by `${chainId}:${protocol}` so different integrations batch
   * independently (different subgraph URLs).
   */
  private readonly pendingByIntegration = new Map<string, PendingItem[]>();
  private readonly flushTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(AdapterRegistryService)
    private readonly adapters: AdapterRegistryService,
    @Inject(PositionsRepository) private readonly positions: PositionsRepository,
    @Inject(TransactionSyncService)
    private readonly transactionSync: TransactionSyncService,
    @Inject(AggregateRecomputeService)
    private readonly aggregateRecompute: AggregateRecomputeService,
  ) {}

  async refreshPosition(request: LiveRefreshRequest): Promise<LiveRefreshResult> {
    const integrationKey = `${request.chainId}:${request.protocol}`;
    return new Promise<LiveRefreshResult>((resolve, reject) => {
      const list = this.pendingByIntegration.get(integrationKey) ?? [];
      list.push({ req: request, resolve, reject });
      this.pendingByIntegration.set(integrationKey, list);

      if (list.length >= this.config.liveRefreshBatchSize) {
        this.flush(integrationKey);
        return;
      }
      if (!this.flushTimers.has(integrationKey)) {
        const timer = setTimeout(() => this.flush(integrationKey), this.config.liveRefreshFlushMs);
        this.flushTimers.set(integrationKey, timer);
      }
    });
  }

  private flush(integrationKey: string): void {
    const timer = this.flushTimers.get(integrationKey);
    if (timer) {
      clearTimeout(timer);
      this.flushTimers.delete(integrationKey);
    }
    const batch = this.pendingByIntegration.get(integrationKey);
    if (!batch || batch.length === 0) {
      this.pendingByIntegration.delete(integrationKey);
      return;
    }
    this.pendingByIntegration.delete(integrationKey);

    void (async () => {
      try {
        const results = await this.refreshPositionsBatch(batch.map((item) => item.req));
        const byTokenId = new Map<string, LiveRefreshResult>();
        for (const r of results) byTokenId.set(r.tokenId, r);
        for (const item of batch) {
          const result = byTokenId.get(item.req.tokenId) ?? {
            chainId: item.req.chainId,
            protocol: item.req.protocol,
            tokenId: item.req.tokenId,
            positionsUpserted: 0,
            transactionsUpserted: 0,
          };
          item.resolve(result);
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        for (const item of batch) item.reject(error);
      }
    })();
  }

  /**
   * Execute a batched refresh for the pending requests of a single
   * `(chainId, protocol)` group. Issues ONE `fetchPositions` for state across
   * every tokenId in the batch, then upserts it. Aggregates mode (v4) computes
   * the performance metrics inside that upsert — one write per position, no
   * re-read; transaction mode re-reads the rows and runs the per-token tx sync.
   */
  private async refreshPositionsBatch(requests: LiveRefreshRequest[]): Promise<LiveRefreshResult[]> {
    if (requests.length === 0) return [];
    const { chainId, protocol } = requests[0]!;
    const integration = this.config.getIntegration(chainId, protocol);
    if (!integration) {
      throw new Error(`No enabled integration for ${chainId}:${protocol}`);
    }
    const adapter = this.adapters.resolve(protocol);
    const aggregates = adapter.recomputeMode === 'aggregates';

    const tokenIds = [...new Set(requests.map((r) => r.tokenId))];

    // Single state pull for the whole batch.
    const stateResult = await adapter.fetchPositions({
      integration,
      cursorTimestamp: 0,
      pageSize: tokenIds.length,
      maxPages: 1,
      mode: 'refresh',
      positionIds: tokenIds,
    });
    let positionsUpsertedAcrossBatch = 0;
    if (stateResult.positions.length > 0) {
      // Aggregates mode: the upsert carries the cashflow aggregates + current
      // prices, and computes the vs-HODL metrics from them in the same write.
      // It used to be followed by `AggregateRecomputeService.recompute`, which
      // re-read every row and wrote it a second time. (Detail-view vs-USD + tx
      // list come on-demand from the indexer.)
      const opts = aggregates
        ? { aggregates: { ethPriceNow: await this.aggregateRecompute.ethPriceNow(chainId) } }
        : {};
      positionsUpsertedAcrossBatch = await this.positions.upsertMany(stateResult.positions, opts);
    }

    if (aggregates) {
      this.logger.log(
        `Live refresh (aggregates) flushed: ${chainId}:${protocol} tokenIds=${requests.length} positionsUpserted=${positionsUpsertedAcrossBatch}`,
      );
      // Every row the indexer returned now exists (upsert), so it answers the
      // per-token result without the full-document re-read it used to need.
      const upserted = new Set(stateResult.positions.map((p) => p.tokenId));
      return requests.map((req) => ({
        chainId: req.chainId,
        protocol: req.protocol,
        tokenId: req.tokenId,
        positionsUpserted: upserted.has(req.tokenId) ? 1 : 0,
        transactionsUpserted: 0,
      }));
    }

    const refreshed = await this.positions.findManyByPositionIds(chainId, protocol, tokenIds);
    const refreshedByTokenId = new Map(refreshed.map((p) => [p.tokenId, p]));
    if (!adapter.fetchPositionTransactions) {
      throw new Error(`Adapter ${protocol} does not support transaction fetch`);
    }
    // Delegate per-position tx fetch + enrichment + upsert + recompute +
    // status marking to the shared helper. Helper picks mode per position
    // (full-from-zero for new positions; incremental from max stored tx
    // timestamp for already-synced ones).
    const txSummary = refreshed.length > 0
      ? await this.transactionSync.syncTokenIdsFromPositionSync(integration, {
          positionIds: refreshed.map((p) => p.positionId),
          fromZero: false,
          origin: 'live-refresh',
        })
      : { transactionsUpserted: 0, positionsScanned: 0, positionsSucceeded: 0, positionsFailed: 0, transactionsFetched: 0, durationMs: 0 };

    this.logger.log(
      `Live refresh batch flushed: ${chainId}:${protocol} tokenIds=${requests.length} positionsUpserted=${positionsUpsertedAcrossBatch} txsUpsertedTotal=${txSummary.transactionsUpserted}`,
    );

    return requests.map((req) => ({
      chainId: req.chainId,
      protocol: req.protocol,
      tokenId: req.tokenId,
      positionsUpserted: refreshedByTokenId.has(req.tokenId) ? 1 : 0,
      transactionsUpserted: 0,
    }));
  }
}
