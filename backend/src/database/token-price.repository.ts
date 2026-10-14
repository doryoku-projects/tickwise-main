import { Inject, Injectable } from '@nestjs/common';
import type { Model } from 'mongoose';
import {
  TokenPriceHistorical,
  type TokenPriceHistoricalDocument,
} from './schemas/token-price-historical.schema.js';
import { CollectionResolver } from './collection-resolver.js';

export interface HistoricalPriceRecord {
  chainId: number;
  address: string;
  bucketTs: number;
  priceUsd: number;
  source: string;
}

export interface HistoricalPriceLookup {
  chainId: number;
  address: string;
  bucketTs: number;
  windowBuckets: number;
}

@Injectable()
export class TokenPriceRepository {
  constructor(
    @Inject(CollectionResolver) private readonly resolver: CollectionResolver,
  ) {}

  private model(chainId: number): Model<TokenPriceHistoricalDocument> {
    return this.resolver.priceModel(chainId);
  }

  async findHistoricalNear(
    chainId: number,
    address: string,
    bucketTs: number,
    windowBuckets: number,
  ): Promise<TokenPriceHistorical | null> {
    const rows = await this.model(chainId)
      .find({
        chainId,
        address: address.toLowerCase(),
        bucketTs: { $gte: bucketTs - windowBuckets, $lte: bucketTs + windowBuckets },
      })
      .sort({ bucketTs: 1 })
      .lean<TokenPriceHistorical[]>();
    if (rows.length === 0) return null;
    return nearestHistorical(rows, bucketTs);
  }

  async findHistoricalNearMany(
    lookups: HistoricalPriceLookup[],
  ): Promise<Map<string, TokenPriceHistorical>> {
    const result = new Map<string, TokenPriceHistorical>();
    if (lookups.length === 0) return result;

    const normalized = lookups.map((lookup) => ({
      ...lookup,
      address: lookup.address.toLowerCase(),
    }));
    // Group lookups by chainId so each Mongo round-trip hits exactly one
    // shard collection. Within a chain, merge overlapping address windows
    // into one $or query just like the legacy single-collection path.
    const byChain = new Map<number, typeof normalized>();
    for (const lookup of normalized) {
      const list = byChain.get(lookup.chainId);
      if (list) {
        list.push(lookup);
      } else {
        byChain.set(lookup.chainId, [lookup]);
      }
    }

    await Promise.all(
      [...byChain.entries()].map(async ([chainId, chainLookups]) => {
        const ranges = new Map<string, { chainId: number; address: string; minBucket: number; maxBucket: number }>();
        for (const lookup of chainLookups) {
          const key = `${lookup.chainId}:${lookup.address}`;
          const minBucket = lookup.bucketTs - lookup.windowBuckets;
          const maxBucket = lookup.bucketTs + lookup.windowBuckets;
          const existing = ranges.get(key);
          if (existing) {
            existing.minBucket = Math.min(existing.minBucket, minBucket);
            existing.maxBucket = Math.max(existing.maxBucket, maxBucket);
          } else {
            ranges.set(key, { chainId: lookup.chainId, address: lookup.address, minBucket, maxBucket });
          }
        }

        const rows = await this.model(chainId)
          .find({
            $or: [...ranges.values()].map((range) => ({
              chainId: range.chainId,
              address: range.address,
              bucketTs: { $gte: range.minBucket, $lte: range.maxBucket },
            })),
          })
          .sort({ bucketTs: 1 })
          .lean<TokenPriceHistorical[]>();

        for (const lookup of chainLookups) {
          const matches = rows.filter(
            (candidate) =>
              candidate.chainId === lookup.chainId &&
              candidate.address === lookup.address &&
              candidate.bucketTs >= lookup.bucketTs - lookup.windowBuckets &&
              candidate.bucketTs <= lookup.bucketTs + lookup.windowBuckets,
          );
          const row = nearestHistorical(matches, lookup.bucketTs);
          if (row) result.set(historicalLookupKey(lookup), row);
        }
      }),
    );

    return result;
  }

  /**
   * Most-recent POSITIVE-price row per token (newest `bucketTs`). Used as the
   * "last-known-good" current-price fallback when live providers transiently
   * miss/rate-limit — so a real-market token never flips to $0. Returns only
   * tokens that have at least one stored positive price (no-market tokens are
   * absent → caller treats as $0). Caller applies the freshness window.
   */
  async findLatestByTokens(
    chainId: number,
    addresses: string[],
  ): Promise<Map<string, { priceUsd: number; bucketTs: number; source?: string }>> {
    const out = new Map<string, { priceUsd: number; bucketTs: number; source?: string }>();
    const addrs = [...new Set(addresses.map((a) => a.toLowerCase()))];
    if (addrs.length === 0) return out;
    const rows = await this.model(chainId).aggregate<{ _id: string; priceUsd: number; bucketTs: number; source?: string }>([
      { $match: { chainId, address: { $in: addrs }, priceUsd: { $gt: 0 } } },
      { $sort: { bucketTs: -1 } },
      { $group: { _id: '$address', priceUsd: { $first: '$priceUsd' }, bucketTs: { $first: '$bucketTs' }, source: { $first: '$source' } } },
    ]);
    for (const row of rows) {
      out.set(String(row._id), { priceUsd: row.priceUsd, bucketTs: row.bucketTs, source: row.source });
    }
    return out;
  }

  async upsertHistorical(record: HistoricalPriceRecord): Promise<void> {
    await this.model(record.chainId).updateOne(
      {
        chainId: record.chainId,
        address: record.address.toLowerCase(),
        bucketTs: record.bucketTs,
      },
      {
        $set: {
          priceUsd: record.priceUsd,
          source: record.source,
          fetchedAt: new Date(),
        },
      },
      { upsert: true },
    );
  }

  async upsertManyHistorical(records: HistoricalPriceRecord[]): Promise<void> {
    if (records.length === 0) return;
    // Group by chainId — each shard collection gets its own bulkWrite.
    const byChain = new Map<number, HistoricalPriceRecord[]>();
    for (const record of records) {
      const list = byChain.get(record.chainId);
      if (list) {
        list.push(record);
      } else {
        byChain.set(record.chainId, [record]);
      }
    }

    await Promise.all(
      [...byChain.entries()].map(async ([chainId, chainRecords]) => {
        await this.model(chainId).bulkWrite(
          chainRecords.map((record) => ({
            updateOne: {
              filter: {
                chainId: record.chainId,
                address: record.address.toLowerCase(),
                bucketTs: record.bucketTs,
              },
              update: {
                $set: {
                  priceUsd: record.priceUsd,
                  source: record.source,
                  fetchedAt: new Date(),
                },
              },
              upsert: true,
            },
          })),
          { ordered: false },
        );
      }),
    );
  }

}

export function historicalLookupKey(lookup: Pick<HistoricalPriceLookup, 'chainId' | 'address' | 'bucketTs'>): string {
  return [lookup.chainId, lookup.address.toLowerCase(), lookup.bucketTs].join(':');
}

function nearestHistorical<T extends { bucketTs: number }>(rows: T[], targetBucketTs: number): T | null {
  let best: T | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const delta = Math.abs(row.bucketTs - targetBucketTs);
    if (delta < bestDelta) {
      best = row;
      bestDelta = delta;
    }
  }
  return best;
}
