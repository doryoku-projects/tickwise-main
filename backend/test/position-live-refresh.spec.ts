/*
 * Live refresh writes each position ONCE (2026-10-03). Aggregates mode (v4)
 * used to upsert the batch, re-read every row (`findManyByPositionIds`) and let
 * `AggregateRecomputeService.recompute` read them AGAIN and write each a second
 * time. Now the upsert computes the metrics itself, at a native price read
 * once per batch; transaction mode is unchanged.
 */
import { describe, expect, it, vi } from 'vitest';
import { PositionLiveRefreshService } from '../src/sync/position-live-refresh.service.js';

function makeService(recomputeMode: 'aggregates' | 'transactions', indexerRows: string[]) {
  const fetchPositions = vi.fn(async (opts: { positionIds: string[] }) => ({
    positions: indexerRows
      .filter((id) => opts.positionIds.includes(id))
      .map((id) => ({ chainId: 1, protocol: 'uniswap-v4', positionId: id, tokenId: id })),
    seenPositionIds: [],
    maxTimestamp: 0,
    maxPositionId: '',
    maxBlockNumber: 0,
    hasMore: false,
    flushedCount: 0,
  }));
  const positions = {
    upsertMany: vi.fn(async (rows: unknown[]) => rows.length),
    findManyByPositionIds: vi.fn(async (_c: number, _p: string, ids: string[]) =>
      ids.filter((id) => indexerRows.includes(id)).map((id) => ({ positionId: id, tokenId: id })),
    ),
  };
  const transactionSync = {
    syncTokenIdsFromPositionSync: vi.fn(async () => ({ transactionsUpserted: 3 })),
  };
  const aggregateRecompute = {
    recompute: vi.fn(async () => 0),
    ethPriceNow: vi.fn(async () => 3150),
  };
  const service = new PositionLiveRefreshService(
    {
      liveRefreshBatchSize: 2,
      liveRefreshFlushMs: 1,
      getIntegration: () => ({ chainId: 1, protocol: 'uniswap-v4', enabled: true }),
    } as never,
    {
      resolve: () => ({
        recomputeMode,
        fetchPositions,
        ...(recomputeMode === 'transactions' ? { fetchPositionTransactions: vi.fn() } : {}),
      }),
    } as never,
    positions as never,
    transactionSync as never,
    aggregateRecompute as never,
  );
  return { service, positions, transactionSync, aggregateRecompute, fetchPositions };
}

const req = (tokenId: string) => ({ chainId: 1, protocol: 'uniswap-v4', tokenId, blockNumber: 100 });

describe('PositionLiveRefreshService — one write per position', () => {
  it('aggregates mode: one upsert carrying the metrics, no re-read, no second write', async () => {
    const { service, positions, aggregateRecompute } = makeService('aggregates', ['7', '8']);

    const results = await Promise.all([service.refreshPosition(req('7')), service.refreshPosition(req('8'))]);

    expect(positions.upsertMany).toHaveBeenCalledTimes(1);
    expect(positions.upsertMany.mock.calls[0]![1]).toEqual({ aggregates: { ethPriceNow: 3150 } });
    expect(aggregateRecompute.ethPriceNow).toHaveBeenCalledTimes(1);
    expect(aggregateRecompute.recompute).not.toHaveBeenCalled();
    expect(positions.findManyByPositionIds).not.toHaveBeenCalled();
    expect(results.map((r) => [r.tokenId, r.positionsUpserted])).toEqual([
      ['7', 1],
      ['8', 1],
    ]);
  });

  it('aggregates mode: a token the indexer did not return reports 0 and nothing is written for it', async () => {
    const { service, positions, aggregateRecompute } = makeService('aggregates', ['7']);

    const results = await Promise.all([service.refreshPosition(req('7')), service.refreshPosition(req('9'))]);

    expect(positions.upsertMany.mock.calls[0]![0]).toHaveLength(1);
    expect(results.map((r) => [r.tokenId, r.positionsUpserted])).toEqual([
      ['7', 1],
      ['9', 0],
    ]);
    expect(aggregateRecompute.recompute).not.toHaveBeenCalled();
  });

  it('aggregates mode: nothing returned → no price read, no write', async () => {
    const { service, positions, aggregateRecompute } = makeService('aggregates', []);

    await Promise.all([service.refreshPosition(req('7')), service.refreshPosition(req('8'))]);

    expect(positions.upsertMany).not.toHaveBeenCalled();
    expect(aggregateRecompute.ethPriceNow).not.toHaveBeenCalled();
  });

  it('transaction mode: unchanged — plain upsert, re-read, tx sync', async () => {
    const { service, positions, transactionSync, aggregateRecompute } = makeService('transactions', ['7', '8']);

    await Promise.all([service.refreshPosition(req('7')), service.refreshPosition(req('8'))]);

    expect(positions.upsertMany.mock.calls[0]![1]).toEqual({});
    expect(positions.findManyByPositionIds).toHaveBeenCalledWith(1, 'uniswap-v4', ['7', '8']);
    expect(transactionSync.syncTokenIdsFromPositionSync).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 1 }),
      expect.objectContaining({ positionIds: ['7', '8'], origin: 'live-refresh' }),
    );
    expect(aggregateRecompute.ethPriceNow).not.toHaveBeenCalled();
  });
});
