import { describe, expect, it, vi } from 'vitest';
import { TransactionSyncService } from '../src/sync/transaction-sync.service.js';

const INTEGRATION = { chainId: 1, protocol: 'uniswap-v4', subgraphUrl: 'http://x' } as never;

function positionDoc(positionId: string) {
  return {
    chainId: 1,
    protocol: 'uniswap-v4',
    positionId,
    tokenId: positionId,
    isActive: true,
    poolId: '0xpool',
    token0: { address: '0xtoken0', symbol: 'T0', decimals: 18, verified: true, priceUsd: 1 },
    token1: { address: '0xtoken1', symbol: 'T1', decimals: 18, verified: true, priceUsd: 1 },
    txSyncStatus: 'pending',
    txSyncedTransactionCount: 0,
    amounts: { amount0: '0', amount1: '0' },
    metrics: {
      pendingFeesUsd: 0,
      underlyingValueUsd: 0,
      ageSeconds: 0,
      unclaimedRewardsUsd: 0,
      claimedRewardsUsd: 0,
    },
  };
}

function txRow(positionId: string, timestamp: number) {
  return {
    chainId: 1,
    protocol: 'uniswap-v4',
    positionId,
    tokenId: positionId,
    transactionId: `${positionId}-${timestamp}`,
    txHash: `0x${timestamp}`,
    type: 'DEPOSIT',
    timestamp,
    amount0: '1',
    amount1: '0',
    amount0PriceUsd: 1,
    amount1PriceUsd: 0,
    amount0PriceUsdUntracked: 1,
    amount1PriceUsdUntracked: 0,
    amount0HistoricalPriceUsd: 0,
    amount1HistoricalPriceUsd: 0,
    historicalValueUsd: 0,
    historicalPricingSource: 'none',
    gasCostEth: 0,
    gasCostUsd: 0,
    sender: '0x',
    logIndex: 0,
    rawSubgraph: {},
  };
}

function build(opts: { foundPositions?: ReturnType<typeof positionDoc>[] } = {}) {
  const fetchAllPositionTransactions = vi.fn(
    async (o: {
      cursorTimestamp: number;
      maxTimestamp?: number;
      onFlush: (txs: unknown[], cursor: { maxTimestamp: number; maxTransactionId: string }) => Promise<number>;
    }) => {
      // Emit one tx inside this bucket's slice, then return empty residual.
      await o.onFlush([txRow('40', o.cursorTimestamp + 1)], {
        maxTimestamp: o.maxTimestamp ?? 0,
        maxTransactionId: `tx-${o.maxTimestamp}`,
      });
      return { transactions: [], maxTimestamp: o.maxTimestamp ?? 0, maxTransactionId: '', hasMore: false, flushedCount: 1 };
    },
  );
  const adapter = {
    fetchTransactionTimestampRange: vi.fn(async () => ({ minTimestamp: 1000, maxTimestamp: 2000 })),
    fetchAllPositionTransactions,
  };
  const positions = {
    findManyByPositionIds: vi.fn(async () => opts.foundPositions ?? [positionDoc('40')]),
    markTransactionSyncSuccess: vi.fn(async () => undefined),
    updatePerformanceMetrics: vi.fn(async () => 0),
  };
  const positionTransactions = {
    upsertMany: vi.fn(async (rows: unknown[]) => rows.length),
    countByPositionId: vi.fn(async () => new Map([['40', 1]])),
    findForPositions: vi.fn(async () => []),
  };
  const pricing = {
    historicalTokenPricesUsdMany: vi.fn(async () => new Map()),
    currentNativeUsd: vi.fn(async () => 0),
    findStaleDerivedCacheKeys: vi.fn(async () => new Set()),
  };
  const syncRepo = { markTxCursorSuccess: vi.fn(async () => undefined) };
  const providerRegistry = { hasAnyAvailableHistoricalProvider: () => false };
  const config = {
    transactionsSyncEnabled: true,
    transactionsBackfillBuckets: 2,
    txSyncGlobalConcurrency: 8,
    // ON globally — fastIngest must still bypass external pricing during backfill.
    transactionsHistoricalPricingEnabled: true,
  };
  const service = new TransactionSyncService(
    config as never,
    { resolve: () => adapter } as never,
    positions as never,
    positionTransactions as never,
    pricing as never,
    syncRepo as never,
    providerRegistry as never,
  );
  return { service, adapter, positions, positionTransactions, syncRepo, pricing, fetchAllPositionTransactions };
}

describe('TransactionSyncService.runTxBackfillBuckets', () => {
  it('splits the tx timestamp range into N non-overlapping buckets with maxTimestamp bounds', async () => {
    const { service, fetchAllPositionTransactions } = build();
    await service.runTxBackfillBuckets(INTEGRATION);

    expect(fetchAllPositionTransactions).toHaveBeenCalledTimes(2);
    const maxes = fetchAllPositionTransactions.mock.calls
      .map((c) => (c[0] as { maxTimestamp?: number }).maxTimestamp)
      .sort((a, b) => (a ?? 0) - (b ?? 0));
    // span=1001, step=ceil(1001/2)=501 → bucket0 max=1501, bucket1 max=2000+1=2001.
    expect(maxes).toEqual([1501, 2001]);
  });

  it('fastIngest: prices from subgraph values, never calls the external pricing chain', async () => {
    const { service, pricing } = build();
    await service.runTxBackfillBuckets(INTEGRATION);
    // Even with TRANSACTIONS_HISTORICAL_PRICING_ENABLED=true, the bulk backfill
    // uses subgraph tx-time prices → the external historical pricing chain is
    // never invoked (that's what made flushes take 100s+).
    expect(pricing.historicalTokenPricesUsdMany).not.toHaveBeenCalled();
  });

  it('prices + upserts + recomputes each flush and advances the tx cursor to the global max', async () => {
    const { service, positions, positionTransactions, syncRepo } = build();
    const result = await service.runTxBackfillBuckets(INTEGRATION);

    expect(positionTransactions.upsertMany).toHaveBeenCalled();
    expect(positions.markTransactionSyncSuccess).toHaveBeenCalled();
    expect(syncRepo.markTxCursorSuccess).toHaveBeenCalledWith(1, 'uniswap-v4', {
      txLastTimestamp: 2001,
      txLastTransactionId: 'tx-2001',
    });
    expect(result.upserted).toBeGreaterThan(0);
  });

  it('resolves position context per flush and tolerates positions missing from Mongo', async () => {
    const { service, positions, positionTransactions } = build({ foundPositions: [] });
    await service.runTxBackfillBuckets(INTEGRATION);

    // Missing positions → still upserts the txns (priced with subgraph values),
    // no crash.
    expect(positions.findManyByPositionIds).toHaveBeenCalledWith(1, 'uniswap-v4', ['40']);
    expect(positionTransactions.upsertMany).toHaveBeenCalled();
  });

  it('refine is upgrade-only: re-pricing a revert-subgraph row keeps its trusted subgraph price when externals have no data', async () => {
    // The background reprice scan re-prices fastIngest `revert-subgraph` rows
    // through the FULL pricing path. When the external/pool-ratio chain returns
    // nothing (empty map), a trusted subgraph price must be PRESERVED (settles
    // as `historical-fallback`) — never zeroed back to `none`.
    const { service, pricing } = build();
    const tx = { ...txRow('40', 1500), historicalPricingSource: 'revert-subgraph' };

    const [refined] = await service.withTransactionPrices([tx as never], [positionDoc('40') as never]);

    expect(pricing.historicalTokenPricesUsdMany).toHaveBeenCalled(); // full path, not fast path
    expect(refined.historicalPricingSource).toBe('historical-fallback');
    expect(refined.amount0HistoricalPriceUsd).toBe(1);
    expect(refined.historicalValueUsd).toBe(1); // amount0(1) * subgraph price(1), preserved
  });

  it('no-ops when transaction sync is disabled', async () => {
    const { service, fetchAllPositionTransactions } = build();
    (service as unknown as { config: { transactionsSyncEnabled: boolean } }).config.transactionsSyncEnabled = false;
    const result = await service.runTxBackfillBuckets(INTEGRATION);
    expect(fetchAllPositionTransactions).not.toHaveBeenCalled();
    expect(result.upserted).toBe(0);
  });
});
