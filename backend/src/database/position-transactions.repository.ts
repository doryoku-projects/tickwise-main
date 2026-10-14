import { Inject, Injectable } from '@nestjs/common';
import type { Model } from 'mongoose';
import {
  PositionTransaction,
  type PositionTransactionDocument,
} from './schemas/position-transaction.schema.js';
import type { NormalizedPositionTransaction } from '../subgraph/normalized-position.js';
import { CollectionResolver } from './collection-resolver.js';

/**
 * `historicalPricingSource` values that the background reprice scan treats as
 * "not yet refined" and re-prices over refresh ticks:
 *   - `'none'`            — never successfully priced (provider 429 / cold cache).
 *   - `'revert-subgraph'` — fastIngest's instant subgraph tx-time price; a
 *                           placeholder to be upgraded to pool-ratio/external
 *                           (or settled as `historical-fallback`) later.
 * Once re-priced, a row moves to historical / historical-fallback / suspect-
 * amount and drops out of this set, so the scan is convergent (no churn).
 */
const UNREFINED_PRICING_SOURCES = ['none', 'revert-subgraph'] as const;

@Injectable()
export class PositionTransactionsRepository {
  constructor(
    @Inject(CollectionResolver) private readonly resolver: CollectionResolver,
  ) {}

  private model(chainId: number, protocol: string): Model<PositionTransactionDocument> {
    return this.resolver.transactionModel(chainId, protocol);
  }

  async upsertMany(transactions: NormalizedPositionTransaction[]): Promise<number> {
    if (transactions.length === 0) return 0;

    const now = new Date();
    // Group by (chainId, protocol) so each bulkWrite targets the right shard.
    const grouped = new Map<string, { chainId: number; protocol: string; txns: NormalizedPositionTransaction[] }>();
    for (const tx of transactions) {
      const key = `${tx.chainId}:${tx.protocol}`;
      const group = grouped.get(key);
      if (group) {
        group.txns.push(tx);
      } else {
        grouped.set(key, { chainId: tx.chainId, protocol: tx.protocol, txns: [tx] });
      }
    }

    let total = 0;
    await Promise.all(
      [...grouped.values()].map(async (group) => {
        const ops = group.txns.map((transaction) => ({
          updateOne: {
            filter: {
              chainId: transaction.chainId,
              protocol: transaction.protocol,
              positionId: transaction.positionId,
              transactionId: transaction.transactionId,
            },
            update: {
              $set: {
                ...transaction,
                lastSyncedAt: now,
              },
            },
            upsert: true,
          },
        }));
        const result = await this.model(group.chainId, group.protocol).bulkWrite(ops, { ordered: false });
        total += result.upsertedCount + result.modifiedCount;
      }),
    );
    return total;
  }

  async findForPosition(
    chainId: number,
    protocol: string,
    positionId: string,
    limit?: number,
  ): Promise<PositionTransaction[]> {
    const query = this.model(chainId, protocol)
      .find({ chainId, protocol, positionId })
      .sort({ timestamp: 1, logIndex: 1, transactionId: 1 });

    if (limit && limit > 0) query.limit(limit);
    return query.lean<PositionTransaction[]>();
  }

  async findForPositions(
    chainId: number,
    protocol: string,
    positionIds: string[],
  ): Promise<PositionTransaction[]> {
    if (positionIds.length === 0) return [];
    return this.model(chainId, protocol)
      .find({ chainId, protocol, positionId: { $in: positionIds } })
      .sort({ positionId: 1, timestamp: 1, logIndex: 1, transactionId: 1 })
      .lean<PositionTransaction[]>();
  }

  /**
   * Return distinct `positionId`s whose stored transactions include at least
   * one row needing a (re)price: `historicalPricingSource` in
   * {@link UNREFINED_PRICING_SOURCES}. Two cases:
   *   - `'none'` — never successfully priced (provider 429 / cold cache, or a
   *     token whose price wasn't available yet).
   *   - `'revert-subgraph'` — the fastIngest backfill priced the row instantly
   *     from the subgraph's own tx-time prices and deferred refinement. The
   *     reprice scan upgrades these long-tail rows to pool-ratio/external (or
   *     preserves them as `historical-fallback`) over the next refresh ticks.
   *
   * `afterPositionId` paginates: pass the largest id from the previous batch
   * to continue. Returns up to `limit` ids in ascending order.
   */
  async findPositionIdsWithUnpricedTransactions(
    chainId: number,
    protocol: string,
    afterPositionId: string,
    limit: number,
  ): Promise<string[]> {
    const match: Record<string, unknown> = {
      chainId,
      protocol,
      historicalPricingSource: { $in: UNREFINED_PRICING_SOURCES },
    };
    if (afterPositionId) match.positionId = { $gt: afterPositionId };
    const rows = await this.model(chainId, protocol).aggregate<{ _id: string }>([
      { $match: match },
      { $group: { _id: '$positionId' } },
      { $sort: { _id: 1 } },
      { $limit: Math.max(1, limit) },
    ]).collation({ locale: 'en', numericOrdering: true });
    return rows.map((row) => row._id);
  }

  /**
   * Cursor-paginated sweep of distinct `positionId`s that have any stored
   * transactions. Unlike `findPositionIdsWithUnpricedTransactions`, this does
   * NOT filter by `historicalPricingSource` — used by the heal sweep that
   * rotates through every position so the recompute cache-bridge can probe
   * its txns for stale pool-ratio cache entries.
   *
   * Pagination: pass the largest id from the previous batch as
   * `afterPositionId` to continue. Caller should wrap cursor back to '' when
   * an empty page is returned.
   */
  async findPositionIdsForHealSweep(
    chainId: number,
    protocol: string,
    afterPositionId: string,
    limit: number,
  ): Promise<string[]> {
    const match: Record<string, unknown> = { chainId, protocol };
    if (afterPositionId) match.positionId = { $gt: afterPositionId };
    const rows = await this.model(chainId, protocol).aggregate<{ _id: string }>([
      { $match: match },
      { $group: { _id: '$positionId' } },
      { $sort: { _id: 1 } },
      { $limit: Math.max(1, limit) },
    ]).collation({ locale: 'en', numericOrdering: true });
    return rows.map((row) => row._id);
  }

  /**
   * For each positionId in `positionIds`, return every `(positionId, timestamp)`
   * tuple whose corresponding stored txn needs a (re)price —
   * `historicalPricingSource` in {@link UNREFINED_PRICING_SOURCES} (`'none'` +
   * fastIngest `'revert-subgraph'`). Used by the reprice cron's bulk cache
   * pre-warm: caller joins these against the positions collection to resolve
   * token addresses, then issues one `historicalTokenPricesUsdMany` call
   * covering every (token, bucketTs) across the run. Without the pre-warm each
   * chunk worker would independently fan out provider calls and re-trip rate
   * limits.
   */
  async findUnpricedTimestampsByPositions(
    chainId: number,
    protocol: string,
    positionIds: string[],
  ): Promise<Array<{ positionId: string; timestamp: number }>> {
    if (positionIds.length === 0) return [];
    const rows = await this.model(chainId, protocol)
      .find(
        {
          chainId,
          protocol,
          positionId: { $in: positionIds },
          historicalPricingSource: { $in: UNREFINED_PRICING_SOURCES },
        },
        { positionId: 1, timestamp: 1, _id: 0 },
      )
      .lean<Array<{ positionId: string; timestamp: number }>>();
    return rows;
  }

  async countByPositionId(
    chainId: number,
    protocol: string,
    positionIds: string[],
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (positionIds.length === 0) return counts;
    for (const positionId of positionIds) counts.set(positionId, 0);

    const rows = await this.model(chainId, protocol).aggregate<{ _id: string; count: number }>([
      { $match: { chainId, protocol, positionId: { $in: positionIds } } },
      { $group: { _id: '$positionId', count: { $sum: 1 } } },
    ]);
    for (const row of rows) counts.set(row._id, row.count);
    return counts;
  }

  /**
   * Per-position max stored tx timestamp. Used by position-driven incremental
   * tx sync to pick a resume cursor that matches actual stored data, instead
   * of relying on wall-clock `txLastSuccessAt` which can drift if cron sync
   * fired but stored zero rows.
   *
   * Returns 0 for any positionId with no stored txs.
   */
  async findMaxTimestampByPositions(
    chainId: number,
    protocol: string,
    positionIds: string[],
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (positionIds.length === 0) return result;
    for (const positionId of positionIds) result.set(positionId, 0);

    const rows = await this.model(chainId, protocol).aggregate<{ _id: string; maxTs: number }>([
      { $match: { chainId, protocol, positionId: { $in: positionIds } } },
      { $group: { _id: '$positionId', maxTs: { $max: '$timestamp' } } },
    ]);
    for (const row of rows) result.set(row._id, Number(row.maxTs) || 0);
    return result;
  }
}
