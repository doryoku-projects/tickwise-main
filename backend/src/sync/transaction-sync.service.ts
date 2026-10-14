import { Inject, Injectable, Logger } from "@nestjs/common";
import { Semaphore } from "../common/semaphore.js";
import { AppConfigService } from "../config/app-config.service.js";
import type { IntegrationConfig } from "../config/integrations.config.js";
import { PositionTransactionsRepository } from "../database/position-transactions.repository.js";
import {
  PositionsRepository,
  type TransactionSyncCandidate,
} from "../database/positions.repository.js";
import { SyncRepository } from "../database/sync.repository.js";
import {
  historicalTokenPriceRequestKey,
  PRICE_CACHE_BUCKET_SECONDS,
  PricingService,
  type HistoricalTokenPriceRequest,
  type PriceResult,
} from "../pricing/pricing.service.js";
import { historicalLookupKey } from "../database/token-price.repository.js";
import { ProviderRegistry } from "../pricing/providers/provider-registry.js";
import { PRICING_LOGIC_REVISION_AT } from "../pricing/pricing-revision.js";
import { computePerformanceUpdate } from "../positions/position-performance.js";
import { AdapterRegistryService } from "../subgraph/adapter-registry.service.js";
import type { NormalizedPositionTransaction, FetchPositionTransactionsResult } from "../subgraph/normalized-position.js";
import type { FetchPositionsOptions } from "../subgraph/position-adapter.js";

// Tunable via env with backfill-friendly defaults. Bumping these helps throughput
// but increases provider rate-limit pressure — back off if 429s spike.
const TRANSACTIONS_SUBGRAPH_PAGE_SIZE = 100;
const TRANSACTIONS_MAX_PAGES_PER_POSITION = 10;
const TRANSACTIONS_TOKENS_PER_QUERY = 1000;
// Bulk parallel-bucket tx backfill: page size + flush threshold for the
// `positionTransactions` cursor walk (subgraph caps `first` at 1000).
const TRANSACTIONS_WALK_PAGE_SIZE = numEnv('TRANSACTIONS_WALK_PAGE_SIZE', 1000);
const TRANSACTIONS_WALK_FLUSH_THRESHOLD = numEnv('TRANSACTIONS_WALK_FLUSH_THRESHOLD', 10000);
const TRANSACTIONS_SINCE_TIMESTAMP_BUFFER_S = 300;
const MAX_SUBGRAPH_FALLBACK_PRICE_MULTIPLIER = 5;
const TRANSACTIONS_REPRICE_CHUNK_SIZE = 200;
const TRANSACTIONS_REPRICE_WORKERS = 5;
/**
 * Absolute USD cap on a single COLLECT_FEES transaction's historical
 * value. The Uniswap v4 subgraph occasionally emits bogus `amount0` /
 * `amount1` values on collect events (cumulative fee growth × liquidity
 * rather than the actual delta), producing rows with $10M-$100M+ "fees"
 * on positions that only ever deposited a few dollars. No legitimate
 * single-tx LP fee collection exceeds this threshold; rows that do are
 * tagged `suspect-amount` and contribute zero to performance recompute.
 *
 * Tune via env `TRANSACTIONS_MAX_COLLECT_FEES_USD`; set 0 to disable.
 */
const TRANSACTIONS_MAX_COLLECT_FEES_USD = numEnv('TRANSACTIONS_MAX_COLLECT_FEES_USD', 10_000_000);

function numEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (!raw) return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

interface StoredRepriceOptions {
  chunkSize?: number;
  maxPositions?: number;
  workers?: number;
  skipActiveLock?: boolean;
  origin?: string;
  startAfterPositionId?: string;
  wrapScan?: boolean;
}

@Injectable()
export class TransactionSyncService {
  private readonly logger = new Logger(TransactionSyncService.name);
  private readonly activeIntegrations = new Set<string>();
  private readonly repriceScanCursors = new Map<string, string>();
  private readonly healSweepCursors = new Map<string, string>();
  private readonly selfHealDeferredLoggedAt = new Map<string, number>();
  private static readonly SELF_HEAL_DEFERRED_LOG_THROTTLE_MS = 60_000;
  /**
   * Global ceiling on concurrent tx-sync batch processing across ALL dispatches
   * (every backfill bucket + refresh + live-refresh share this one instance).
   * Without it, 20 backfill buckets × `positionDrivenTxSyncConcurrency` workers
   * fan out to ~400 simultaneous subgraph+pricing calls and trip provider rate
   * limits into 30–60s backoffs — bounding it lowers wall-clock by avoiding the
   * backoff storm.
   */
  private readonly txFetchSemaphore: Semaphore;

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(AdapterRegistryService)
    private readonly adapters: AdapterRegistryService,
    @Inject(PositionsRepository)
    private readonly positions: PositionsRepository,
    @Inject(PositionTransactionsRepository)
    private readonly positionTransactions: PositionTransactionsRepository,
    @Inject(PricingService) private readonly pricing: PricingService,
    @Inject(SyncRepository) private readonly syncRepo: SyncRepository,
    @Inject(ProviderRegistry) private readonly providerRegistry: ProviderRegistry,
  ) {
    this.txFetchSemaphore = new Semaphore(this.config.txSyncGlobalConcurrency);
  }

  /**
   * Public entry used by `SyncService.runRefresh()` once per refresh tick
   * (fire-and-forget). Bundles the two background recovery passes the retired
   * `sync-transactions` cron used to run at the tail of every tick:
   *
   *  - **Reprice scan** — re-enriches stored transactions still tagged
   *    `historicalPricingSource='none'`, picking up prices that external
   *    providers have since started serving. No subgraph re-fetch of the
   *    transactions themselves (they're already in Mongo); pool snapshots are
   *    fetched only where TWAP derivation needs them.
   *  - **Heal sweep** — cursor-walks all positions over many ticks calling
   *    `recomputePerformanceForPositions`, firing the cache-bridge probe so
   *    metrics converge even for positions with no `none` rows and no recent
   *    on-chain activity.
   *
   * Both passes are cursor-resumable and use `skipActiveLock:true`, so they
   * are safe to invoke every tick without an external lock and never block the
   * next refresh. Errors are swallowed by the caller's `.catch`.
   */
  async repriceAndHealForRefresh(integration: IntegrationConfig): Promise<void> {
    await this.repriceStoredTransactionsAfterSync(integration);
  }

  /**
   * Bulk parallel-bucket transaction backfill — the fast path for a full
   * (`fromStart`) rebuild. Walks the subgraph `positionTransactions` collection
   * directly in N disjoint time-buckets (mirrors `SyncService.runBackfillBuckets`
   * for positions) instead of fanning out 25 positions at a time. ~14× fewer
   * round-trips, and each 10k-row flush dedupes to a handful of unique tokens
   * for an efficient pricing batch. Positions must already be in Mongo (caller
   * runs this after the positions backfill) so each flush can resolve
   * token/pool context to price + recompute.
   */
  async runTxBackfillBuckets(
    integration: IntegrationConfig,
  ): Promise<{ fetched: number; upserted: number; durationMs: number }> {
    const integrationKey = `${integration.chainId}:${integration.protocol}`;
    const startedAt = Date.now();
    const empty = { fetched: 0, upserted: 0, durationMs: 0 };
    if (!this.config.transactionsSyncEnabled) return empty;
    const adapter = this.adapters.resolve(integration.protocol);
    if (!adapter.fetchAllPositionTransactions || !adapter.fetchTransactionTimestampRange) {
      this.logger.warn(`Tx bulk backfill unsupported by adapter: ${integrationKey} — skipping`);
      return empty;
    }
    if (this.activeIntegrations.has(integrationKey)) {
      this.logger.warn(`Skipping tx bulk backfill — tx sync already running: ${integrationKey}`);
      return empty;
    }
    this.activeIntegrations.add(integrationKey);
    const fetchAll = adapter.fetchAllPositionTransactions.bind(adapter);
    try {
      const range = await adapter.fetchTransactionTimestampRange(integration);
      if (range.minTimestamp <= 0 || range.maxTimestamp <= 0 || range.maxTimestamp < range.minTimestamp) {
        this.logger.warn(
          `Tx bulk backfill: empty/invalid range for ${integrationKey} (min=${range.minTimestamp} max=${range.maxTimestamp})`,
        );
        return { ...empty, durationMs: Date.now() - startedAt };
      }
      const bucketCount = Math.max(1, this.config.transactionsBackfillBuckets);
      const span = range.maxTimestamp - range.minTimestamp + 1;
      const step = Math.max(1, Math.ceil(span / bucketCount));
      this.logger.log(
        `Tx backfill (parallel): ${integrationKey} range=[${range.minTimestamp}, ${range.maxTimestamp}] buckets=${bucketCount} step=${step}s`,
      );

      let totalFetched = 0;
      let totalUpserted = 0;
      let globalMaxTimestamp = 0;
      let globalMaxTransactionId = '';
      const advance = (ts: number, id: string): void => {
        if (ts > globalMaxTimestamp || (ts === globalMaxTimestamp && id > globalMaxTransactionId)) {
          globalMaxTimestamp = ts;
          globalMaxTransactionId = id;
        }
      };

      // fastIngest: price the flush from the subgraph's own tx-time prices
      // (instant) and skip the inline external-pricing + self-heal — those blow
      // a 10k-row flush to 100s+ (`Pricing batch … durationMs=140187`) and
      // thrash the subgraph/Redis under load. Txns land immediately tagged
      // `revert-subgraph`; the background refresh-tick reprice/heal sweep
      // refines those rows to pool-ratio/external over the following ticks.
      const flush = async (transactions: NormalizedPositionTransaction[]): Promise<number> => {
        if (transactions.length === 0) return 0;
        await this.txFetchSemaphore.acquire();
        try {
          const positions = await this.collectPositionsForTxs(integration, transactions);
          const enriched = await this.withTransactionPrices(transactions, positions, {
            useSubgraphPrices: true,
          });
          const upserted = await this.positionTransactions.upsertMany(enriched);
          const touched = [...new Set(transactions.map((t) => t.positionId))];
          const counts = await this.positionTransactions.countByPositionId(
            integration.chainId,
            integration.protocol,
            touched,
          );
          await this.positions.markTransactionSyncSuccess(
            integration.chainId,
            integration.protocol,
            touched,
            counts,
          );
          await this.recomputePerformanceForPositions(integration.chainId, integration.protocol, touched, {
            skipSelfHeal: true,
          });
          return upserted;
        } finally {
          this.txFetchSemaphore.release();
        }
      };

      const tasks = Array.from({ length: bucketCount }, async (_unused, idx) => {
        const bucketMin = range.minTimestamp + idx * step;
        const bucketMax =
          idx === bucketCount - 1 ? range.maxTimestamp + 1 : range.minTimestamp + (idx + 1) * step;
        // Per-bucket try/catch: one bucket's subgraph error must not reject the
        // whole Promise.all — siblings continue, the gap is re-walked next tick.
        try {
          let flushNumber = 0;
          const result = await fetchAll({
            integration,
            // `_gt` semantic on cursorTimestamp → use bucketMin-1 to include bucketMin.
            cursorTimestamp: Math.max(0, bucketMin - 1),
            cursorTransactionId: '',
            maxTimestamp: bucketMax,
            pageSize: TRANSACTIONS_WALK_PAGE_SIZE,
            maxPages: 0,
            flushThreshold: TRANSACTIONS_WALK_FLUSH_THRESHOLD,
            onFlush: async (transactions, cursor) => {
              flushNumber += 1;
              totalFetched += transactions.length;
              const upserted = await flush(transactions);
              totalUpserted += upserted;
              advance(cursor.maxTimestamp, cursor.maxTransactionId);
              this.logger.log(
                `Tx flush: ${integrationKey} bucket=${idx + 1}/${bucketCount} #${flushNumber} fetched=${transactions.length} upserted=${upserted}`,
              );
              return upserted;
            },
          });
          // Drain the residual partial page below the flush threshold.
          if (result.transactions.length > 0) {
            totalFetched += result.transactions.length;
            totalUpserted += await flush(result.transactions);
            advance(result.maxTimestamp, result.maxTransactionId);
          }
        } catch (err) {
          this.logger.error(
            `Tx backfill bucket ${idx + 1}/${bucketCount} failed for ${integrationKey}: ${(err as Error).message}`,
          );
        }
      });
      await Promise.all(tasks);

      if (globalMaxTimestamp > 0) {
        await this.syncRepo.markTxCursorSuccess(integration.chainId, integration.protocol, {
          txLastTimestamp: globalMaxTimestamp,
          txLastTransactionId: globalMaxTransactionId,
        });
      }
      const durationMs = Date.now() - startedAt;
      this.logger.log(
        `Tx backfill finished (parallel): ${integrationKey} durationMs=${durationMs} fetched=${totalFetched} upserted=${totalUpserted} buckets=${bucketCount}`,
      );
      return { fetched: totalFetched, upserted: totalUpserted, durationMs };
    } finally {
      this.activeIntegrations.delete(integrationKey);
    }
  }

  /**
   * Resolve token/pool context for a flush of transactions so they can be
   * priced + recomputed. Looks up the position docs by the flush's positionIds;
   * positions not yet in Mongo are skipped (re-priced later by refresh).
   */
  private async collectPositionsForTxs(
    integration: IntegrationConfig,
    transactions: NormalizedPositionTransaction[],
  ): Promise<TransactionSyncCandidate[]> {
    const positionIds = [...new Set(transactions.map((t) => t.positionId))];
    if (positionIds.length === 0) return [];
    const docs = await this.positions.findManyByPositionIds(
      integration.chainId,
      integration.protocol,
      positionIds,
    );
    return docs.map((p) => ({
      chainId: p.chainId,
      protocol: p.protocol,
      positionId: p.positionId,
      tokenId: p.tokenId,
      isActive: p.isActive,
      poolId: p.poolId,
      token0: p.token0,
      token1: p.token1,
      txSyncStatus: p.txSyncStatus,
      txLastSuccessAt: p.txLastSuccessAt,
      txSyncedTransactionCount: p.txSyncedTransactionCount,
      txFinalizedAt: p.txFinalizedAt,
    }));
  }

  private async repriceStoredTransactionsAfterSync(
    integration: IntegrationConfig,
  ): Promise<{ positionsProcessed: number; txsUpdated: number; durationMs: number }> {
    const integrationKey = `${integration.chainId}:${integration.protocol}`;
    try {
      const result = await this.repriceStoredTransactionsCore(
        integration.chainId,
        integration.protocol,
        {
          chunkSize: TRANSACTIONS_REPRICE_CHUNK_SIZE,
          maxPositions: this.repriceMaxPositionsPerSyncTick(),
          workers: TRANSACTIONS_REPRICE_WORKERS,
          skipActiveLock: true,
          origin: 'tx-sync',
          startAfterPositionId: this.repriceScanCursors.get(integrationKey) ?? '',
          wrapScan: true,
        },
      );
      if (result.lastPositionId) {
        this.repriceScanCursors.set(integrationKey, result.lastPositionId);
      }
      // After the source='none' reprice scan, rotate through additional
      // positions via the heal sweep so positions whose txns are all already
      // tagged 'historical' still get recompute (→ cache-bridge heal) fired
      // on them. Errors are swallowed: sweep is best-effort.
      await this.runHealSweep(integration.chainId, integration.protocol).catch((err) =>
        this.logger.warn(
          `Heal sweep failed: ${integration.chainId}:${integration.protocol} ${(err as Error).message}`,
        ),
      );
      return result;
    } catch (err) {
      this.logger.warn(
        `Tx-sync reprice failed: ${integration.chainId}:${integration.protocol} ${(err as Error).message}`,
      );
      return { positionsProcessed: 0, txsUpdated: 0, durationMs: 0 };
    }
  }

  /**
   * Cursor-paginated sweep of all positionIds with stored txns. Each tx-sync
   * tick advances the cursor by `healSweepPerTick`, calling
   * `recomputePerformanceForPositions` in `healSweepChunkSize` batches so the
   * cache-bridge probe inside recompute fires on every position over time —
   * not just the ones with `source='none'` txns or recent on-chain activity.
   *
   * Convergence: with budget=500/tick and ~290k positions, one full pass
   * across the dataset takes ~580 ticks. At 20 min/tick that's ~8 days. Bump
   * `HEAL_SWEEP_PER_TICK` to drain faster.
   */
  private async runHealSweep(chainId: number, protocol: string): Promise<void> {
    const perTick = this.config.healSweepPerTick;
    if (perTick === 0) return;
    const integrationKey = `${chainId}:${protocol}`;
    const chunkSize = this.config.healSweepChunkSize;
    let cursor = this.healSweepCursors.get(integrationKey) ?? '';
    let processed = 0;
    let wrapped = false;
    const startedAt = Date.now();

    while (processed < perTick) {
      const remaining = perTick - processed;
      const pageSize = Math.min(chunkSize, remaining);
      const ids = await this.positionTransactions.findPositionIdsForHealSweep(
        chainId,
        protocol,
        cursor,
        pageSize,
      );
      if (ids.length === 0) {
        // End of collection — wrap cursor to start for next tick. Only do
        // this once per tick to avoid infinite loops on an empty collection.
        if (wrapped || !cursor) break;
        cursor = '';
        wrapped = true;
        continue;
      }
      try {
        await this.recomputePerformanceForPositions(chainId, protocol, ids);
      } catch (err) {
        this.logger.warn(
          `Heal sweep recompute failed: ${integrationKey} chunkSize=${ids.length} ${(err as Error).message}`,
        );
      }
      processed += ids.length;
      cursor = ids[ids.length - 1] ?? cursor;
      if (ids.length < pageSize) break;
    }

    this.healSweepCursors.set(integrationKey, cursor);
    if (processed > 0) {
      this.logger.log(
        `Heal sweep: ${integrationKey} processed=${processed} cursor=${cursor || '""'} wrapped=${wrapped} durationMs=${Date.now() - startedAt}`,
      );
    }
  }

  private async repriceStoredTransactionsCore(
    chainId: number,
    protocol: string,
    options: StoredRepriceOptions = {},
  ): Promise<{ positionsProcessed: number; txsUpdated: number; durationMs: number; lastPositionId?: string }> {
    const integrationKey = `${chainId}:${protocol}`;
    const integration = this.config.getIntegration(chainId, protocol);
    if (!integration) {
      throw new Error(`Unknown integration: ${integrationKey}`);
    }
    const useActiveLock = options.skipActiveLock !== true;
    if (useActiveLock && this.activeIntegrations.has(integrationKey)) {
      this.logger.warn(`Reprice skipped (already active): ${integrationKey}`);
      return { positionsProcessed: 0, txsUpdated: 0, durationMs: 0 };
    }
    // Storm guard: if every external historical provider is in rate-limit
    // back-off, every per-chunk re-enrichment would just bounce off 429s and
    // extend the back-off windows. Bail early; cron will retry on the next
    // tick once at least one provider is back.
    if (!this.providerRegistry.hasAnyAvailableHistoricalProvider()) {
      this.logger.warn(
        `Reprice skipped (${integrationKey}): every external historical provider is rate-limited`,
      );
      return { positionsProcessed: 0, txsUpdated: 0, durationMs: 0 };
    }
    if (useActiveLock) this.activeIntegrations.add(integrationKey);

    const chunkSize = Math.max(1, options.chunkSize ?? 200);
    const maxPositions = options.maxPositions ?? 0;
    const workers = Math.max(1, options.workers ?? 5);
    const startedAt = Date.now();
    const origin = options.origin ?? 'manual';

    this.logger.log(
      `Reprice started: ${integrationKey} origin=${origin} chunkSize=${chunkSize} workers=${workers} maxPositions=${maxPositions || 'unlimited'}`,
    );

    try {
      // Phase 1: scan all positionIds with unpriced txns upfront. Paginated by
      // chunks of 5000 to avoid loading the whole id list in one query.
      const SCAN_PAGE = 5000;
      const allPositionIds: string[] = [];
      const initialScanCursor = options.startAfterPositionId ?? '';
      let scanCursor = initialScanCursor;
      let wrappedScan = false;
      while (true) {
        const page = await this.positionTransactions.findPositionIdsWithUnpricedTransactions(
          chainId,
          protocol,
          scanCursor,
          SCAN_PAGE,
        );
        if (page.length === 0) {
          if (options.wrapScan === true && !wrappedScan && initialScanCursor) {
            scanCursor = '';
            wrappedScan = true;
            continue;
          }
          break;
        }
        allPositionIds.push(...page);
        scanCursor = page[page.length - 1] ?? scanCursor;
        if (maxPositions > 0 && allPositionIds.length >= maxPositions) {
          allPositionIds.length = maxPositions;
          break;
        }
        if (page.length < SCAN_PAGE) break;
      }

      if (allPositionIds.length === 0) {
        this.logger.log(`Reprice finished: ${integrationKey} positions=0 (nothing to do)`);
        return { positionsProcessed: 0, txsUpdated: 0, durationMs: Date.now() - startedAt };
      }
      const lastPositionId = allPositionIds[allPositionIds.length - 1];

      // Phase 1.5: bulk cache pre-warm. Build the union of (chainId, address,
      // bucketTs) tuples covering every unpriced txn across this run, then
      // call `historicalTokenPricesUsdMany` in batches to fill the in-memory
      // + Mongo price caches. Without this each per-chunk re-enrichment would
      // independently fan out provider calls for the same (token, bucket)
      // pairs, multiplying load on already-strained external APIs.
      await this.prewarmReprice(chainId, protocol, allPositionIds);

      // Phase 2: chunk into batches and fan out across `workers` async workers.
      // Each worker grabs the next available chunk via shared atomic index.
      const chunks: string[][] = [];
      for (let i = 0; i < allPositionIds.length; i += chunkSize) {
        chunks.push(allPositionIds.slice(i, i + chunkSize));
      }
      this.logger.log(
        `Reprice plan: ${integrationKey} positions=${allPositionIds.length} chunks=${chunks.length} chunkSize=${chunkSize} workers=${workers}`,
      );

      let totalPositions = 0;
      let totalTxs = 0;
      let nextChunkIndex = 0;

      const runWorker = async (workerId: number): Promise<void> => {
        while (true) {
          const i = nextChunkIndex++;
          if (i >= chunks.length) return;
          const positionIds = chunks[i];
          if (!positionIds || positionIds.length === 0) continue;

          try {
            const upserted = await this.repriceChunk(chainId, protocol, positionIds);
            totalTxs += upserted;
            totalPositions += positionIds.length;
            this.logger.log(
              `Reprice chunk: ${integrationKey} worker=${workerId} chunk=${i + 1}/${chunks.length} positions=${positionIds.length} txsUpdated=${upserted} totalPositions=${totalPositions}`,
            );
          } catch (err) {
            this.logger.error(
              `Reprice chunk failed: ${integrationKey} worker=${workerId} chunk=${i + 1}/${chunks.length} ${(err as Error).message}`,
            );
          }
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(workers, chunks.length) }, (_, idx) => runWorker(idx + 1)),
      );

      const durationMs = Date.now() - startedAt;
      this.logger.log(
        `Reprice finished: ${integrationKey} origin=${origin} positions=${totalPositions} txsUpdated=${totalTxs} durationMs=${durationMs}`,
      );
      return { positionsProcessed: totalPositions, txsUpdated: totalTxs, durationMs, lastPositionId };
    } finally {
      if (useActiveLock) this.activeIntegrations.delete(integrationKey);
    }
  }

  private repriceMaxPositionsPerSyncTick(): number {
    const configuredLimit = Math.max(0, this.config.transactionsSyncBatchSize);
    const baseLimit = configuredLimit > 0 ? configuredLimit : TRANSACTIONS_TOKENS_PER_QUERY;
    const testModeCap = this.config.testMode ? Math.max(0, this.config.testModePositionLimit) : 0;
    return testModeCap > 0 ? Math.min(baseLimit, testModeCap) : baseLimit;
  }

  /**
   * Bulk pre-warm the price cache for the upcoming reprice run. Joins
   * unpriced-txn timestamps with their position's token0/token1 addresses,
   * dedupes into a Set of `(chainId, address, bucketTs)` tuples (via
   * `historicalTokenPriceRequestKey`), then issues batched
   * `historicalTokenPricesUsdMany` calls (5k per batch) so the per-chunk
   * workers downstream piggyback on cache. Failures are warn-logged; cache
   * fills with whatever the providers can serve and chunks retry the rest.
   */
  private async prewarmReprice(
    chainId: number,
    protocol: string,
    positionIds: string[],
  ): Promise<void> {
    const integrationKey = `${chainId}:${protocol}`;
    const PRE_WARM_BATCH = 5000;
    const POSITIONS_BATCH = 1000;

    // Load all position metadata once (token addresses + decimals + pool for
    // pool-ratio TWAP context).
    const positions: TransactionSyncCandidate[] = [];
    for (let i = 0; i < positionIds.length; i += POSITIONS_BATCH) {
      const slice = positionIds.slice(i, i + POSITIONS_BATCH);
      const docs = await this.positions.findManyByPositionIds(chainId, protocol, slice);
      for (const p of docs) {
        positions.push({
          chainId: p.chainId,
          protocol: p.protocol,
          positionId: p.positionId,
          tokenId: p.tokenId,
          isActive: p.isActive,
          poolId: p.poolId,
          token0: p.token0,
          token1: p.token1,
          txSyncStatus: p.txSyncStatus,
          txLastSuccessAt: p.txLastSuccessAt,
          txSyncedTransactionCount: p.txSyncedTransactionCount,
          txFinalizedAt: p.txFinalizedAt,
        });
      }
    }
    const positionByPositionId = new Map(positions.map((p) => [p.positionId, p]));

    // Load all unpriced (positionId, timestamp) tuples in slices.
    const unpriced: Array<{ positionId: string; timestamp: number }> = [];
    for (let i = 0; i < positionIds.length; i += POSITIONS_BATCH) {
      const slice = positionIds.slice(i, i + POSITIONS_BATCH);
      const rows = await this.positionTransactions.findUnpricedTimestampsByPositions(
        chainId,
        protocol,
        slice,
      );
      unpriced.push(...rows);
    }

    if (unpriced.length === 0) return;

    // Build the dedup'd price-request list across the entire run.
    const seen = new Set<string>();
    const requests: HistoricalTokenPriceRequest[] = [];
    for (const { positionId, timestamp } of unpriced) {
      if (!timestamp || timestamp <= 0) continue;
      const position = positionByPositionId.get(positionId);
      if (!position) continue;
      const poolHint = position.poolId?.toLowerCase();
      const reqs: HistoricalTokenPriceRequest[] = [
        {
          chainId: position.chainId,
          address: position.token0.address,
          timestamp,
          symbol: position.token0.symbol,
          poolHint,
          anchorAddress: position.token1.address,
          protocol: position.protocol,
          tokenDecimals: position.token0.decimals,
          anchorDecimals: position.token1.decimals,
          isToken0: true,
          unverified: position.token0.verified === false,
        },
        {
          chainId: position.chainId,
          address: position.token1.address,
          timestamp,
          symbol: position.token1.symbol,
          poolHint,
          anchorAddress: position.token0.address,
          protocol: position.protocol,
          tokenDecimals: position.token1.decimals,
          anchorDecimals: position.token0.decimals,
          isToken0: false,
          unverified: position.token1.verified === false,
        },
      ];
      for (const r of reqs) {
        const key = historicalTokenPriceRequestKey(r.chainId, r.address, r.timestamp);
        if (seen.has(key)) continue;
        seen.add(key);
        requests.push(r);
      }
    }

    if (requests.length === 0) return;

    this.logger.log(
      `Reprice pre-warm: ${integrationKey} positions=${positionIds.length} uniqueRequests=${requests.length}`,
    );

    // Batch the pre-warm to bound memory and let provider rate-limit
    // back-offs trip mid-run without losing everything.
    for (let i = 0; i < requests.length; i += PRE_WARM_BATCH) {
      const batch = requests.slice(i, i + PRE_WARM_BATCH);
      try {
        await this.pricing.historicalTokenPricesUsdMany(batch);
      } catch (err) {
        this.logger.warn(
          `Reprice pre-warm batch failed: ${integrationKey} batch=${Math.floor(i / PRE_WARM_BATCH) + 1} ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * Single-chunk reprice: load → enrich (TWAP-aware) → upsert → recompute.
   * Returns count of upserted txns. Throws on Mongo/pricing errors so the
   * worker can log per-chunk failure without blowing up sibling chunks.
   */
  private async repriceChunk(
    chainId: number,
    protocol: string,
    positionIds: string[],
  ): Promise<number> {
    const [rawTxs, positionDocs] = await Promise.all([
      this.positionTransactions.findForPositions(chainId, protocol, positionIds),
      this.positions.findManyByPositionIds(chainId, protocol, positionIds),
    ]);
    if (rawTxs.length === 0 || positionDocs.length === 0) return 0;

    const candidates: TransactionSyncCandidate[] = positionDocs.map((p) => ({
      chainId: p.chainId,
      protocol: p.protocol,
      positionId: p.positionId,
      tokenId: p.tokenId,
      isActive: p.isActive,
      poolId: p.poolId,
      token0: p.token0,
      token1: p.token1,
      txSyncStatus: p.txSyncStatus,
      txLastSuccessAt: p.txLastSuccessAt,
      txSyncedTransactionCount: p.txSyncedTransactionCount,
      txFinalizedAt: p.txFinalizedAt,
    }));

    const txsForEnrichment: NormalizedPositionTransaction[] = rawTxs.map((tx) => ({
      chainId: tx.chainId,
      protocol: tx.protocol,
      positionId: tx.positionId,
      tokenId: tx.tokenId,
      transactionId: tx.transactionId,
      txHash: tx.txHash,
      type: tx.type,
      timestamp: tx.timestamp,
      amount0: tx.amount0,
      amount1: tx.amount1,
      amount0PriceUsd: tx.amount0PriceUsd,
      amount1PriceUsd: tx.amount1PriceUsd,
      amount0PriceUsdUntracked: tx.amount0PriceUsdUntracked,
      amount1PriceUsdUntracked: tx.amount1PriceUsdUntracked,
      amount0HistoricalPriceUsd: 0,
      amount1HistoricalPriceUsd: 0,
      historicalValueUsd: 0,
      historicalPricingSource: 'none',
      gasCostEth: tx.gasCostEth,
      gasCostUsd: tx.gasCostUsd,
      sender: tx.sender,
      logIndex: tx.logIndex,
      rawSubgraph: tx.rawSubgraph ?? {},
    }));

    const enriched = await this.withTransactionPrices(txsForEnrichment, candidates);
    const upserted = await this.positionTransactions.upsertMany(enriched);
    await this.recomputePerformanceForPositions(chainId, protocol, positionIds);
    return upserted;
  }

  async withTransactionPrices(
    transactions: NormalizedPositionTransaction[],
    positions: TransactionSyncCandidate[],
    opts: { useSubgraphPrices?: boolean } = {},
  ): Promise<NormalizedPositionTransaction[]> {
    // `useSubgraphPrices` forces the fast path regardless of the global flag —
    // used by the bulk backfill (fastIngest) so a flush is priced from the
    // subgraph's own tx-time prices instantly instead of blocking on the
    // external provider chain (which can take 100s+ per flush). The background
    // reprice/heal sweep later refines long-tail tokens to pool-ratio/external.
    if (opts.useSubgraphPrices || !this.config.transactionsHistoricalPricingEnabled) {
      return transactions.map((transaction) => {
        const amount0 = toNumber(transaction.amount0);
        const amount1 = toNumber(transaction.amount1);
        const historicalValueUsd = finite(
          amount0 * transaction.amount0PriceUsd + amount1 * transaction.amount1PriceUsd,
        );

        return {
          ...transaction,
          amount0HistoricalPriceUsd: finite(transaction.amount0PriceUsd),
          amount1HistoricalPriceUsd: finite(transaction.amount1PriceUsd),
          historicalValueUsd,
          historicalPricingSource: "revert-subgraph",
        };
      });
    }

    const positionById = new Map<string, TransactionSyncCandidate>();
    for (const position of positions) {
      positionById.set(position.positionId, position);
      positionById.set(position.tokenId, position);
    }

    // Build price requests with pool-context fields so the `subgraph-pool-ratio`
    // provider at the tail of the historical-pricing chain can derive USD for
    // long-tail tokens (RUBT, STRC, ...) paired with USDC/USDT/WETH that no
    // external API lists historically. Fields are no-ops for external providers.
    const priceRequests: HistoricalTokenPriceRequest[] = [];
    for (const transaction of transactions) {
      const position = positionById.get(transaction.positionId);
      if (!position || transaction.timestamp <= 0) continue;
      const amount0 = toNumber(transaction.amount0);
      const amount1 = toNumber(transaction.amount1);
      const poolId = position.poolId?.toLowerCase();
      if (Math.abs(amount0) > 0) {
        priceRequests.push({
          chainId: position.chainId,
          address: position.token0.address,
          timestamp: transaction.timestamp,
          symbol: position.token0.symbol,
          poolHint: poolId,
          anchorAddress: position.token1.address,
          protocol: position.protocol,
          tokenDecimals: position.token0.decimals,
          anchorDecimals: position.token1.decimals,
          isToken0: true,
          unverified: position.token0.verified === false,
        });
      }
      if (Math.abs(amount1) > 0) {
        priceRequests.push({
          chainId: position.chainId,
          address: position.token1.address,
          timestamp: transaction.timestamp,
          symbol: position.token1.symbol,
          poolHint: poolId,
          anchorAddress: position.token0.address,
          protocol: position.protocol,
          tokenDecimals: position.token1.decimals,
          anchorDecimals: position.token0.decimals,
          isToken0: false,
          unverified: position.token1.verified === false,
        });
      }
    }
    const historicalTokenPrices = await this.pricing.historicalTokenPricesUsdMany(priceRequests);

    return transactions.map((transaction) => {
      const position = positionById.get(transaction.positionId);
      if (!position || transaction.timestamp <= 0) {
        return {
          ...transaction,
          amount0HistoricalPriceUsd: 0,
          amount1HistoricalPriceUsd: 0,
          historicalValueUsd: 0,
          historicalPricingSource: "none",
        };
      }

      const amount0 = toNumber(transaction.amount0);
      const amount1 = toNumber(transaction.amount1);
      const prices: PriceResult = {
        token0Usd: historicalTokenPrices.get(
          historicalTokenPriceRequestKey(position.chainId, position.token0.address, transaction.timestamp),
        ) ?? 0,
        token1Usd: historicalTokenPrices.get(
          historicalTokenPriceRequestKey(position.chainId, position.token1.address, transaction.timestamp),
        ) ?? 0,
        source: "none",
        usedFallback: false,
      };
      prices.source = prices.token0Usd > 0 || prices.token1Usd > 0 ? "historical" : "none";
      const token0Price = historicalTokenPrice(
        prices.token0Usd,
        transaction.amount0PriceUsd,
        transaction.amount0PriceUsdUntracked,
        amount0,
        position.token0.priceUsd,
      );
      const token1Price = historicalTokenPrice(
        prices.token1Usd,
        transaction.amount1PriceUsd,
        transaction.amount1PriceUsdUntracked,
        amount1,
        position.token1.priceUsd,
      );
      const source = historicalPricingSource(prices, token0Price, token1Price, amount0, amount1);
      const historicalValueUsd = finite(
        amount0 * token0Price + amount1 * token1Price,
      );

      // Subgraph poisoning clamp: COLLECT_FEES rows whose computed USD
      // value exceeds the configured cap are upstream-bogus (see comment on
      // `TRANSACTIONS_MAX_COLLECT_FEES_USD`). Zero out their contribution so
      // performance recompute doesn't manufacture astronomical PnL/APR/ROI.
      if (
        TRANSACTIONS_MAX_COLLECT_FEES_USD > 0
        && transaction.type === 'COLLECT_FEES'
        && Math.abs(historicalValueUsd) > TRANSACTIONS_MAX_COLLECT_FEES_USD
      ) {
        return {
          ...transaction,
          amount0HistoricalPriceUsd: 0,
          amount1HistoricalPriceUsd: 0,
          historicalValueUsd: 0,
          historicalPricingSource: 'suspect-amount',
        };
      }

      return {
        ...transaction,
        amount0HistoricalPriceUsd: finite(token0Price),
        amount1HistoricalPriceUsd: finite(token1Price),
        historicalValueUsd: source === "none" ? 0 : historicalValueUsd,
        historicalPricingSource: source,
      };
    });
  }

  private async fetchBucket(
    fetcher: (options: FetchPositionsOptions) => Promise<FetchPositionTransactionsResult>,
    integration: IntegrationConfig,
    bucket: TransactionSyncCandidate[],
    sinceTimestamp: number,
  ): Promise<NormalizedPositionTransaction[]> {
    if (bucket.length === 0) return [];
    const tokenIds = bucket.map((position) => position.tokenId);
    const result = await fetcher({
      integration,
      cursorTimestamp: sinceTimestamp,
      pageSize: TRANSACTIONS_SUBGRAPH_PAGE_SIZE,
      maxPages: Math.max(1, TRANSACTIONS_MAX_PAGES_PER_POSITION * tokenIds.length),
      positionIds: tokenIds,
    });
    return result.transactions;
  }

  private computeIncrementalSinceTimestamp(bucket: TransactionSyncCandidate[]): number {
    let oldest = Number.POSITIVE_INFINITY;
    for (const position of bucket) {
      const ts = position.txLastSuccessAt instanceof Date
        ? Math.floor(position.txLastSuccessAt.getTime() / 1000)
        : 0;
      if (ts <= 0) return 0;
      if (ts < oldest) oldest = ts;
    }
    if (!Number.isFinite(oldest)) return 0;
    return Math.max(0, oldest - TRANSACTIONS_SINCE_TIMESTAMP_BUFFER_S);
  }

  async recomputePerformanceForPositions(
    chainId: number,
    protocol: string,
    positionIds: string[],
    opts: { skipSelfHeal?: boolean } = {},
  ): Promise<void> {
    return this.recomputeBatchPerformance(chainId, protocol, positionIds, opts);
  }

  /**
   * Position-driven transaction sync. Invoked from SyncService after each
   * position-backfill flush + each refresh chunk so tx fetch/price/recompute
   * ride directly on the position sync flow — no separate tx cron tick. Also
   * used by the closed-position catch-up tail of `runRefresh` and by
   * PositionLiveRefreshService.
   *
   * Mode resolution per position:
   *  - `fromZero=true`  → full-from-zero (initial empty-DB / fromStart=true).
   *  - else `auto`      → full-from-zero if the position has never tx-synced
   *                       successfully (txSyncStatus !== 'success'), has zero
   *                       stored txs, or — for active positions — has no
   *                       stored tx timestamp yet. Otherwise incremental from
   *                       the position's **max stored tx timestamp** minus a
   *                       small buffer. This is intentionally NOT keyed off
   *                       `txLastSuccessAt` wall-clock, because that drifts
   *                       when a sync attempt fired but stored zero rows.
   *
   * Batches are bounded by `positionDrivenTxSyncBatchSize` and dispatched
   * across `positionDrivenTxSyncConcurrency` workers so a 20k-position
   * refresh doesn't fire 20k simultaneous subgraph calls.
   */
  async syncTokenIdsFromPositionSync(
    integration: IntegrationConfig,
    options: {
      positionIds?: string[];
      tokenIds?: string[];
      fromZero?: boolean;
      origin?: string;
    },
  ): Promise<{
    positionsScanned: number;
    positionsSucceeded: number;
    positionsFailed: number;
    transactionsFetched: number;
    transactionsUpserted: number;
    durationMs: number;
  }> {
    const startedAt = Date.now();
    const empty = {
      positionsScanned: 0,
      positionsSucceeded: 0,
      positionsFailed: 0,
      transactionsFetched: 0,
      transactionsUpserted: 0,
      durationMs: 0,
    };
    if (!this.config.positionDrivenTxSyncEnabled || !this.config.transactionsSyncEnabled) {
      return empty;
    }
    const adapter = this.adapters.resolve(integration.protocol);
    if (!adapter.fetchPositionTransactions) {
      return empty;
    }

    const positionDocs = await this.resolvePositionDocs(integration, options);
    if (positionDocs.length === 0) {
      return { ...empty, durationMs: Date.now() - startedAt };
    }

    // Per-position max stored tx timestamp drives incremental cursor selection.
    const positionIds = positionDocs.map((p) => p.positionId);
    const maxTsByPositionId = await this.positionTransactions.findMaxTimestampByPositions(
      integration.chainId,
      integration.protocol,
      positionIds,
    );

    interface PositionPlan {
      candidate: TransactionSyncCandidate;
      since: number; // 0 = full-from-zero
    }
    const plans: PositionPlan[] = [];
    for (const p of positionDocs) {
      const candidate: TransactionSyncCandidate = {
        chainId: p.chainId,
        protocol: p.protocol,
        positionId: p.positionId,
        tokenId: p.tokenId,
        isActive: p.isActive,
        poolId: p.poolId,
        token0: p.token0,
        token1: p.token1,
        txSyncStatus: p.txSyncStatus,
        txLastSuccessAt: p.txLastSuccessAt,
        txSyncedTransactionCount: p.txSyncedTransactionCount,
        txFinalizedAt: p.txFinalizedAt,
      };
      const maxTs = maxTsByPositionId.get(p.positionId) ?? 0;
      const hasStored = (p.txSyncedTransactionCount ?? 0) > 0 && maxTs > 0;
      const historyComplete =
        p.txSyncStatus === 'success' && (p.isActive || p.txFinalizedAt instanceof Date);
      const needsFull = options.fromZero === true || !historyComplete || !hasStored;
      const since = needsFull
        ? 0
        : Math.max(0, maxTs - TRANSACTIONS_SINCE_TIMESTAMP_BUFFER_S);
      plans.push({ candidate, since });
    }

    // Group by `since` so positions sharing the same cursor (typically a
    // fromZero=0 cohort) fan out in a single batched subgraph call. Different
    // cursors still issue separate calls, but each call carries up to
    // `positionDrivenTxSyncBatchSize` positionIds.
    const batchSize = Math.max(1, this.config.positionDrivenTxSyncBatchSize);
    const groupedBySince = new Map<number, PositionPlan[]>();
    for (const plan of plans) {
      const bucket = groupedBySince.get(plan.since) ?? [];
      bucket.push(plan);
      groupedBySince.set(plan.since, bucket);
    }
    const batches: Array<{ since: number; group: PositionPlan[] }> = [];
    for (const [since, plansForSince] of groupedBySince) {
      for (let i = 0; i < plansForSince.length; i += batchSize) {
        batches.push({ since, group: plansForSince.slice(i, i + batchSize) });
      }
    }

    const origin = options.origin ?? 'position-sync';
    const integrationKey = `${integration.chainId}:${integration.protocol}`;
    let positionsSucceeded = 0;
    let positionsFailed = 0;
    let transactionsFetched = 0;
    let transactionsUpserted = 0;

    const fetchPositionTransactions = adapter.fetchPositionTransactions.bind(adapter);
    const workers = Math.max(1, this.config.positionDrivenTxSyncConcurrency);
    let nextBatch = 0;
    await Promise.all(
      Array.from({ length: Math.min(workers, batches.length || 1) }, async () => {
        while (nextBatch < batches.length) {
          const idx = nextBatch++;
          const batch = batches[idx];
          if (!batch) continue;
          const ids = batch.group.map((g) => g.candidate.positionId);
          const tokenIds = batch.group.map((g) => g.candidate.tokenId);
          // Global cap: bound concurrent batch work across every dispatch so
          // parallel backfill buckets don't thunder the subgraph/providers.
          await this.txFetchSemaphore.acquire();
          try {
            await this.positions.markTransactionSyncAttempt(
              integration.chainId,
              integration.protocol,
              ids,
            );
            const fetched = await this.fetchBucket(
              fetchPositionTransactions,
              integration,
              batch.group.map((g) => g.candidate),
              batch.since,
            );
            const enriched = await this.withTransactionPrices(
              fetched,
              batch.group.map((g) => g.candidate),
            );
            const upserted = await this.positionTransactions.upsertMany(enriched);
            const counts = await this.positionTransactions.countByPositionId(
              integration.chainId,
              integration.protocol,
              ids,
            );
            // Mark success BEFORE recompute. markTransactionSyncSuccess
            // stamps `txFinalizedAt` on closed positions; if we recomputed
            // first, the history-complete gate in computePerformanceUpdate
            // would see no finalizedAt and write `pending-history` even
            // though tx-sync just finished. Order: persist tx-sync state →
            // recompute reads it and clears the gate on the same tick.
            await this.positions.markTransactionSyncSuccess(
              integration.chainId,
              integration.protocol,
              ids,
              counts,
            );
            await this.recomputePerformanceForPositions(
              integration.chainId,
              integration.protocol,
              ids,
            );
            positionsSucceeded += batch.group.length;
            transactionsFetched += fetched.length;
            transactionsUpserted += upserted;
            void tokenIds;
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            positionsFailed += batch.group.length;
            try {
              await this.positions.markTransactionSyncFailure(
                integration.chainId,
                integration.protocol,
                ids,
                message,
              );
            } catch (markErr) {
              this.logger.warn(
                `Position-driven tx-sync failure mark failed: ${integrationKey} origin=${origin} ${(markErr as Error).message}`,
              );
            }
            this.logger.warn(
              `Position-driven tx-sync batch failed: ${integrationKey} origin=${origin} batch=${idx + 1}/${batches.length} positions=${batch.group.length} since=${batch.since} error=${message}`,
            );
          } finally {
            this.txFetchSemaphore.release();
          }
        }
      }),
    );

    const durationMs = Date.now() - startedAt;
    if (positionDocs.length > 0) {
      this.logger.log(
        `Position-driven tx-sync: ${integrationKey} origin=${origin} positions=${positionDocs.length} succeeded=${positionsSucceeded} failed=${positionsFailed} fetched=${transactionsFetched} upserted=${transactionsUpserted} durationMs=${durationMs}`,
      );
    }

    return {
      positionsScanned: positionDocs.length,
      positionsSucceeded,
      positionsFailed,
      transactionsFetched,
      transactionsUpserted,
      durationMs,
    };
  }

  /**
   * Resolve position docs from either explicit positionIds or tokenIds. Used
   * by `syncTokenIdsFromPositionSync` to support callers that only know one
   * side (e.g., backfill flush sees positionIds; live refresh sees tokenIds).
   * Dedupes across both inputs.
   */
  private async resolvePositionDocs(
    integration: IntegrationConfig,
    options: { positionIds?: string[]; tokenIds?: string[] },
  ): Promise<Awaited<ReturnType<PositionsRepository['findManyByPositionIds']>>> {
    const directIds = new Set<string>(options.positionIds ?? []);
    const tokenIds = options.tokenIds ?? [];
    if (directIds.size === 0 && tokenIds.length === 0) return [];

    // For uniswap-v3/v4 etc. tokenId === positionId, so a single lookup covers
    // both. We $in across the union; adapter that diverges the two needs its
    // own resolver but none currently do.
    const idUnion = new Set<string>([...directIds, ...tokenIds]);
    return this.positions.findManyByPositionIds(
      integration.chainId,
      integration.protocol,
      [...idUnion],
    );
  }

  private async recomputeBatchPerformance(
    chainId: number,
    protocol: string,
    positionIds: string[],
    opts: { skipSelfHeal?: boolean } = {},
  ): Promise<void> {
    const [positions, transactions] = await Promise.all([
      this.positions.findManyByPositionIds(chainId, protocol, positionIds),
      this.positionTransactions.findForPositions(chainId, protocol, positionIds),
    ]);

    // Self-heal stale or unpriced transactions. Three cases get re-priced:
    //   1. `historicalPricingSource='none'` — never successfully priced
    //      (provider 429 / cold cache at the time). Without this, the
    //      position stays `performanceReady=false` because cashflow compute
    //      reads stored prices and recompute never re-fetches pricing.
    //   2. The tx's token0/token1 historical-price-cache row at the tx's
    //      bucket is currently tagged with a DERIVED_HISTORICAL_SOURCES
    //      entry AND was fetched before PRICING_LOGIC_REVISION_AT. That cache
    //      row was produced by an older revision of pool-ratio derivation
    //      logic (which preferred subgraph USD over anchored ratio math).
    //   3. The tx itself was priced before PRICING_LOGIC_REVISION_AT
    //      (lastSyncedAt < cutoff) AND its source isn't 'none'. Even when
    //      the underlying cache row has since flipped to a non-derived
    //      source (e.g., a later read triggered an external refetch), the
    //      tx's stored `amount0HistoricalPriceUsd` / `historicalValueUsd`
    //      weren't touched in that flip. Re-running `withTransactionPrices`
    //      pulls the now-fresh cache value into the tx row so downstream
    //      cashflow math (depositedUsd / withdrawnUsd / pnlUsd) matches
    //      reality. Once a tx is repriced, `lastSyncedAt = now > cutoff`,
    //      so it falls out of this branch — convergent.
    //
    // Storm guard: if every external historical provider is rate-limited,
    // skip self-heal entirely. Each recompute fires for many positions ×
    // multiple stale txns; hammering benched providers just extends backoff.
    const repricedById = new Map<string, NormalizedPositionTransaction>();
    const providersAvailable = this.providerRegistry.hasAnyAvailableHistoricalProvider();
    if (
      !opts.skipSelfHeal
      && this.config.transactionsHistoricalPricingEnabled
      && positions.length > 0
      && providersAvailable
    ) {
      const positionByLookupId = new Map<string, typeof positions[number]>();
      for (const p of positions) {
        positionByLookupId.set(p.positionId, p);
        positionByLookupId.set(p.tokenId, p);
      }

      // Probe the historical-price cache for every (token, bucket) tuple this
      // batch's txns touch. Returns the subset whose cache row is currently
      // a stale derived-source entry — the keys txs need to be repriced for.
      const cacheLookups: Array<{ chainId: number; address: string; bucketTs: number }> = [];
      for (const t of transactions) {
        if (!t.timestamp || t.timestamp <= 0) continue;
        const pos = positionByLookupId.get(t.positionId);
        if (!pos) continue;
        const bucketTs = bucketTimestamp(t.timestamp);
        cacheLookups.push({ chainId, address: pos.token0.address.toLowerCase(), bucketTs });
        cacheLookups.push({ chainId, address: pos.token1.address.toLowerCase(), bucketTs });
      }
      const poisonedCacheKeys = await this.pricing.findStaleDerivedCacheKeys(
        cacheLookups,
        PRICING_LOGIC_REVISION_AT,
      );

      const stale = transactions.filter((t) => {
        const cast = t as NormalizedPositionTransaction & { lastSyncedAt?: Date };
        if (!cast.timestamp || cast.timestamp <= 0) return false;
        if (cast.historicalPricingSource === 'none') return true;
        // Pre-revision pricing guard. Any tx priced under the older pricing
        // logic (lastSyncedAt < PRICING_LOGIC_REVISION_AT) is suspect even
        // when its underlying cache row has since flipped to a non-derived
        // source — the cache may have been re-fetched in isolation by a
        // later call, but the tx's stored `amount0HistoricalPriceUsd` /
        // `historicalValueUsd` weren't touched in that flip. Re-running
        // `withTransactionPrices` here pulls the fresh cache value into
        // the tx row so downstream cashflow math (depositedUsd, withdrawnUsd,
        // pnlUsd) matches reality.
        const lastSynced = cast.lastSyncedAt instanceof Date ? cast.lastSyncedAt : null;
        if (lastSynced && lastSynced < PRICING_LOGIC_REVISION_AT) return true;
        const pos = positionByLookupId.get(cast.positionId);
        if (!pos) return false;
        const bucketTs = bucketTimestamp(cast.timestamp);
        const k0 = historicalLookupKey({ chainId, address: pos.token0.address.toLowerCase(), bucketTs });
        const k1 = historicalLookupKey({ chainId, address: pos.token1.address.toLowerCase(), bucketTs });
        return poisonedCacheKeys.has(k0) || poisonedCacheKeys.has(k1);
      }) as NormalizedPositionTransaction[];

      if (stale.length > 0) {
        const candidates: TransactionSyncCandidate[] = positions.map((p) => ({
          chainId: p.chainId,
          protocol: p.protocol,
          positionId: p.positionId,
          tokenId: p.tokenId,
          isActive: p.isActive,
          poolId: p.poolId,
          token0: p.token0,
          token1: p.token1,
          txSyncStatus: p.txSyncStatus,
          txLastSuccessAt: p.txLastSuccessAt,
          txSyncedTransactionCount: p.txSyncedTransactionCount,
          txFinalizedAt: p.txFinalizedAt,
        }));
        try {
          const repriced = await this.withTransactionPrices(stale, candidates);
          for (const t of repriced) {
            if (t.historicalPricingSource !== 'none') {
              repricedById.set(`${t.positionId}:${t.transactionId}`, t);
            }
          }
          if (repricedById.size > 0) {
            await this.positionTransactions.upsertMany([...repricedById.values()]);
            const repricedPositions = new Set<string>();
            for (const t of repricedById.values()) repricedPositions.add(t.positionId);
            this.logger.log(
              `Recompute self-heal: ${chainId}:${protocol} positionsScanned=${positions.length} positionsRepriced=${repricedPositions.size} txsRepriced=${repricedById.size} stillStale=${stale.length - repricedById.size} poisonedKeys=${poisonedCacheKeys.size}`,
            );
          }
        } catch (err) {
          this.logger.warn(
            `Recompute self-heal failed: ${chainId}:${protocol} ${(err as Error).message}`,
          );
        }
      }
    } else if (
      this.config.transactionsHistoricalPricingEnabled
      && positions.length > 0
      && !providersAvailable
    ) {
      // Cheap count — skip the cache probe when we can't reprice anyway.
      const unpricedCount = transactions.filter(
        (t) => (t as NormalizedPositionTransaction).historicalPricingSource === 'none' && t.timestamp > 0,
      ).length;
      if (unpricedCount > 0) {
        this.logSelfHealDeferred(chainId, protocol, unpricedCount);
      }
    }

    const transactionsByPositionId = new Map<string, NormalizedPositionTransaction[]>();
    for (const transaction of transactions) {
      const key = `${transaction.positionId}:${transaction.transactionId}`;
      const fresh = repricedById.get(key);
      const value = (fresh ?? (transaction as NormalizedPositionTransaction));
      const list = transactionsByPositionId.get(transaction.positionId) ?? [];
      list.push(value);
      transactionsByPositionId.set(transaction.positionId, list);
    }

    // Current ETH price values gas at the current ETH price for the vs-HODL
    // PnL/APR. One cached lookup per batch; 0 → buildPerformancePatch falls
    // back to tx-price gas.
    const ethPriceNow = await this.pricing.currentNativeUsd(chainId).catch(() => 0);
    const updates = positions.map((position) =>
      computePerformanceUpdate(
        position,
        transactionsByPositionId.get(position.positionId) ?? [],
        { ethPriceNow },
      ),
    );
    await this.positions.updatePerformanceMetrics(chainId, protocol, updates);
  }

  /**
   * Throttled warn — at most once per minute per `(chainId, protocol)` —
   * announcing that the self-heal pass was skipped because every external
   * historical provider is currently rate-limited. Without throttling this
   * line would fire from every recompute (every flush) and drown the logs
   * during a provider outage.
   */
  private logSelfHealDeferred(chainId: number, protocol: string, unpricedCount: number): void {
    const key = `${chainId}:${protocol}`;
    const now = Date.now();
    const last = this.selfHealDeferredLoggedAt.get(key) ?? 0;
    if (now - last < TransactionSyncService.SELF_HEAL_DEFERRED_LOG_THROTTLE_MS) return;
    this.selfHealDeferredLoggedAt.set(key, now);
    this.logger.warn(
      `Recompute self-heal deferred: ${key} unpricedTxs=${unpricedCount} — every external historical provider is rate-limited; retry on next recompute`,
    );
  }
}

function toNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function historicalTokenPrice(
  backendPrice: number,
  subgraphPrice: number,
  untrackedSubgraphPrice: number,
  amount: number,
  referencePrice: number,
): number {
  if (Math.abs(amount) <= 0) return 0;
  if (finite(backendPrice) > 0) return finite(backendPrice);
  if (trustedFallbackPrice(subgraphPrice, referencePrice)) return finite(subgraphPrice);
  if (trustedFallbackPrice(untrackedSubgraphPrice, referencePrice)) return finite(untrackedSubgraphPrice);
  return 0;
}

function trustedFallbackPrice(price: number, referencePrice: number): boolean {
  const candidate = finite(price);
  const reference = finite(referencePrice);
  if (candidate <= 0 || reference <= 0) return false;
  const ratio = Math.max(candidate / reference, reference / candidate);
  return ratio <= MAX_SUBGRAPH_FALLBACK_PRICE_MULTIPLIER;
}

function historicalPricingSource(
  backendPrices: PriceResult,
  token0Price: number,
  token1Price: number,
  amount0: number,
  amount1: number,
): string {
  const needsToken0 = Math.abs(amount0) > 0;
  const needsToken1 = Math.abs(amount1) > 0;
  if ((needsToken0 && token0Price <= 0) || (needsToken1 && token1Price <= 0)) {
    return "none";
  }
  if (!needsToken0 && !needsToken1) return "none";
  if (
    backendPrices.source === "historical" &&
    (!needsToken0 || backendPrices.token0Usd > 0) &&
    (!needsToken1 || backendPrices.token1Usd > 0)
  ) {
    return "historical";
  }
  return "historical-fallback";
}

function bucketTimestamp(timestamp: number): number {
  return Math.floor(timestamp / PRICE_CACHE_BUCKET_SECONDS) * PRICE_CACHE_BUCKET_SECONDS;
}
