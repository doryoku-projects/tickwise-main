import { Inject, Injectable } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service.js';
import {
  classifyAnchor,
  getPricingPolicy,
} from '../pricing-policy.js';
import {
  nearestSnapshotAtOrBefore,
  type PoolSnapshotFetcher,
} from '../pool-snapshot-helpers.js';
import type { PoolSnapshot } from '../../subgraph/position-adapter.js';
import { sqrtRatioX96ToToken1PerToken0 } from '../tick-math.js';
import { BaseProvider } from './base-provider.js';
import {
  providerHistoricalKey,
  type HistoricalBatchContext,
  type HistoricalReq,
  type PriceQuote,
} from './price-provider.interface.js';

const PRICE_CACHE_BUCKET_SECONDS = 1800;
const RANGE_PAD_SECONDS = 86400; // ±1d window so edge txns still resolve
// Cross-batch snapshot cache bound (number of pools). Each entry holds a pool's
// fetched snapshot array + its covered time range; LRU-evicted by pool.
const SNAPSHOT_CACHE_MAX_POOLS = 50_000;

interface PoolSnapshotCacheEntry {
  snapshots: PoolSnapshot[];
  coveredFrom: number;
  coveredTo: number;
}

interface PoolGroupRequest {
  req: HistoricalReq;
  bucketTs: number;
}

interface PoolGroup {
  chainId: number;
  protocol: string;
  poolId: string;
  minTs: number;
  maxTs: number;
  requests: PoolGroupRequest[];
}

/**
 * Subgraph pool-ratio derivation, exposed as a `PriceProvider`. Sits at the
 * tail of the historical-pricing fallback chain — runs only on requests
 * external providers couldn't resolve.
 *
 * Derives the USD price of a long-tail token from the pool's `sqrtPriceX96`
 * at-or-just-before the txn timestamp, anchored on the counterparty token's
 * already-known USD price (from earlier providers in the walk). Subgraph
 * pre-computed USD fields are only a last resort: they can drift badly on
 * high-value correlated pools while the on-chain ratio stays useful.
 *
 * Requires caller to populate `poolHint`, `anchorAddress`, `protocol`,
 * `tokenDecimals`, `anchorDecimals`, and `isToken0` on each `HistoricalReq`.
 * Requests without complete pool context are silently skipped; requests
 * whose counterparty has no anchor price in `context.anchorPrices` are also
 * skipped (no anchor, no derivation).
 *
 * Snapshot fetching is delegated to a `PoolSnapshotFetcher` registered by
 * the subgraph layer at module init via `setSnapshotFetcher` — keeps the
 * pricing module from importing the subgraph module (would cycle).
 */
@Injectable()
export class PoolRatioProvider extends BaseProvider {
  readonly name = 'subgraph-pool-ratio';
  readonly supportsCurrentBatch = false;
  readonly supportsHistoricalBatch = true;
  readonly maxBatchSize: number;
  readonly singleConcurrency = 1;
  readonly defaultBackoffMs = 5_000;

  private fetcher: PoolSnapshotFetcher | null = null;
  private readonly maxLagSeconds: number;
  private readonly snapshotConcurrency: number;
  private readonly enabled: boolean;
  private readonly missingAdapterWarned = new Set<string>();
  /**
   * Cross-batch cache of the resolved snapshot per `(chainId, poolId,
   * bucketTs)`. Snapshots are immutable historical data, so a (pool, bucket)
   * resolved once is reused for every later flush that touches it — this
   * collapses the dominant re-fetch cost during a bulk backfill (a popular
   * pool is otherwise re-fetched on every flush). `null` = resolved miss (no
   * snapshot for that bucket). LRU-bounded by insertion order.
   */
  private readonly snapshotCache = new Map<string, PoolSnapshotCacheEntry>();

  constructor(@Inject(AppConfigService) private readonly config: AppConfigService) {
    super({
      name: 'PoolRatioProvider',
      maxConcurrency: Math.max(1, config.pricingPoolRatioConcurrency),
      defaultBackoffMs: 5_000,
    });
    this.enabled = config.pricingPoolRatioProviderEnabled;
    this.maxBatchSize = Math.max(1, config.pricingPoolRatioBatchSize);
    this.maxLagSeconds = Math.max(0, config.pricingPoolRatioMaxLagSeconds);
    this.snapshotConcurrency = Math.max(1, config.pricingPoolRatioConcurrency);
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Wire the snapshot fetcher from the subgraph layer. Called once at module
   * init by `SubgraphModule`. Until called, the provider returns empty maps
   * (graceful no-op) so the orchestrator can fall through to negative cache.
   */
  setSnapshotFetcher(fetcher: PoolSnapshotFetcher): void {
    this.fetcher = fetcher;
  }

  async getCurrentSingle(): Promise<PriceQuote | null> {
    return null;
  }

  async getHistoricalSingle(): Promise<PriceQuote | null> {
    return null;
  }

  /**
   * Implemented for interface completeness, but the orchestrator should call
   * `getHistoricalBatchWithContext` instead (this provider needs the anchor
   * map). Returns empty when called without context.
   */
  async getHistoricalBatch(): Promise<Map<string, PriceQuote>> {
    return new Map();
  }

  async getHistoricalBatchWithContext(
    requests: HistoricalReq[],
    context: HistoricalBatchContext,
  ): Promise<Map<string, PriceQuote>> {
    const result = new Map<string, PriceQuote>();
    if (!this.enabled || !this.fetcher) return result;
    if (requests.length === 0) return result;

    const groups = this.groupByPool(requests);
    if (groups.length === 0) return result;

    const stats = { snapshotFetches: 0, policySkipped: 0 };
    await this.fetchAndDerive(groups, context, result, stats);
    this.logger.log(
      `Pool-ratio derived prices: requests=${requests.length} pools=${groups.length} fetched=${stats.snapshotFetches} derived=${result.size} policySkipped=${stats.policySkipped}`,
    );
    return result;
  }

  private groupByPool(requests: HistoricalReq[]): PoolGroup[] {
    const byKey = new Map<string, PoolGroup>();
    for (const req of requests) {
      if (!this.hasCompletePoolContext(req)) continue;
      // Policy gate: derivation is disabled for chains we don't recognise
      // and protocols that don't expose pool snapshots with sqrtPriceX96.
      const policy = getPricingPolicy(req.chainId, req.protocol);
      if (!policy || !policy.derivation.enabled) continue;
      // Anchor counterparty gate: long-tail / long-tail pools can't bootstrap
      // pool-ratio derivation safely (no trusted anchor to multiply through).
      if (policy.derivation.requireAnchorPriceForHistorical) {
        const anchorKind = classifyAnchor(policy, req.anchorAddress!);
        if (anchorKind === 'none') continue;
      }
      const bucketTs = bucketAlign(req.timestamp);
      if (bucketTs <= 0) continue;
      const poolId = req.poolHint!.toLowerCase();
      const key = `${req.chainId}:${req.protocol}:${poolId}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.minTs = Math.min(existing.minTs, req.timestamp);
        existing.maxTs = Math.max(existing.maxTs, req.timestamp);
        existing.requests.push({ req, bucketTs });
      } else {
        byKey.set(key, {
          chainId: req.chainId,
          protocol: req.protocol!,
          poolId,
          minTs: req.timestamp,
          maxTs: req.timestamp,
          requests: [{ req, bucketTs }],
        });
      }
    }
    return [...byKey.values()];
  }

  private hasCompletePoolContext(req: HistoricalReq): boolean {
    return Boolean(
      req.poolHint &&
        req.anchorAddress &&
        req.protocol &&
        req.timestamp > 0 &&
        typeof req.tokenDecimals === 'number' &&
        typeof req.anchorDecimals === 'number' &&
        typeof req.isToken0 === 'boolean',
    );
  }

  private async fetchAndDerive(
    groups: PoolGroup[],
    context: HistoricalBatchContext,
    result: Map<string, PriceQuote>,
    stats: { snapshotFetches: number; policySkipped: number },
  ): Promise<void> {
    let nextIndex = 0;
    const workers = Math.min(this.snapshotConcurrency, groups.length);
    await Promise.all(
      Array.from({ length: workers }, async () => {
        while (nextIndex < groups.length) {
          const i = nextIndex++;
          const group = groups[i];
          if (!group) continue;
          try {
            await this.deriveForGroup(group, context, result, stats);
          } catch (err) {
            this.logger.warn(
              `pool-snapshot fetch failed: ${group.chainId}:${group.protocol} pool=${group.poolId} ${(err as Error).message}`,
            );
            this.recordOutcome('error');
          }
        }
      }),
    );
  }

  private async deriveForGroup(
    group: PoolGroup,
    context: HistoricalBatchContext,
    result: Map<string, PriceQuote>,
    stats: { snapshotFetches: number; policySkipped: number },
  ): Promise<void> {
    if (!this.fetcher) return;

    const poolKey = `${group.chainId}:${group.protocol}:${group.poolId}`;
    const needFrom = Math.max(0, group.minTs - RANGE_PAD_SECONDS);
    const needTo = group.maxTs + RANGE_PAD_SECONDS;

    // Fetch only the time range we haven't already cached for this pool.
    // Snapshots are immutable, so once a pool's range is fetched it's reused
    // across every later flush touching it — this collapses the dominant
    // re-fetch cost during a bulk backfill. Resolution stays at the exact tx
    // timestamp (not the bucket), so prices are identical to the uncached path.
    let entry = this.snapshotCache.get(poolKey);
    const gaps: Array<[number, number]> = [];
    if (!entry) {
      gaps.push([needFrom, needTo]);
    } else {
      if (needFrom < entry.coveredFrom) gaps.push([needFrom, entry.coveredFrom]);
      if (needTo > entry.coveredTo) gaps.push([entry.coveredTo, needTo]);
    }

    if (gaps.length > 0) {
      const fetched: PoolSnapshot[] = [];
      for (const [from, to] of gaps) {
        const snaps = await this.fetcher.fetchSnapshots({
          chainId: group.chainId,
          protocol: group.protocol,
          poolId: group.poolId,
          fromTimestamp: from,
          toTimestamp: to,
        });
        if (snaps.length > 0) fetched.push(...snaps);
      }
      if (fetched.length > 0) stats.snapshotFetches += 1;
      if (!entry) {
        entry = { snapshots: [], coveredFrom: needFrom, coveredTo: needTo };
      }
      if (fetched.length > 0) {
        entry.snapshots.push(...fetched);
        entry.snapshots.sort((a, b) => a.timestamp - b.timestamp);
      }
      entry.coveredFrom = Math.min(entry.coveredFrom, needFrom);
      entry.coveredTo = Math.max(entry.coveredTo, needTo);
      this.cachePool(poolKey, entry);
    }

    const snapshots = entry?.snapshots ?? [];
    if (snapshots.length === 0) {
      const warnKey = `${group.chainId}:${group.protocol}`;
      if (!this.missingAdapterWarned.has(warnKey)) {
        this.missingAdapterWarned.add(warnKey);
        this.logger.warn(
          `no pool snapshots returned for ${warnKey} (adapter may not implement fetchPoolSnapshots) — skipping derivations for this chain/protocol`,
        );
      }
      return;
    }

    for (const { req, bucketTs } of group.requests) {
      const snap = nearestSnapshotAtOrBefore(snapshots, req.timestamp);
      if (!snap) continue;
      if (this.maxLagSeconds > 0 && req.timestamp - snap.timestamp > this.maxLagSeconds) continue;

      const anchorKey = buildAnchorKey(req.chainId, req.anchorAddress!, bucketTs);
      const anchorPrice = context.anchorPrices.get(anchorKey) ?? 0;
      if (anchorPrice <= 0) continue;

      const derived = this.derivePrice(req, snap, anchorPrice);
      if (derived <= 0) continue;

      result.set(providerHistoricalKey(req), {
        priceUsd: derived,
        confidenceLevel: 'pool-derived-strong',
      });
      this.recordOutcome('success');
    }
  }

  /** Insert/refresh a pool's snapshot entry with insertion-order LRU eviction. */
  private cachePool(poolKey: string, entry: PoolSnapshotCacheEntry): void {
    // Re-insert to mark most-recently-used (Map preserves insertion order).
    this.snapshotCache.delete(poolKey);
    if (this.snapshotCache.size >= SNAPSHOT_CACHE_MAX_POOLS) {
      const oldest = this.snapshotCache.keys().next().value;
      if (oldest !== undefined) this.snapshotCache.delete(oldest);
    }
    this.snapshotCache.set(poolKey, entry);
  }

  private derivePrice(
    req: HistoricalReq,
    snap: { sqrtPriceX96: string; token0PriceUsd: number; token1PriceUsd: number },
    anchorPrice: number,
  ): number {
    // Ratio math is anchored by an external/cache quote from an earlier
    // provider. Prefer it over subgraph USD fields, which are derived state
    // and can become wildly stale even when sqrtPriceX96 is correct.
    let ratio = 0;
    try {
      ratio = sqrtRatioX96ToToken1PerToken0(
        BigInt(snap.sqrtPriceX96 || '0'),
        req.isToken0 ? req.tokenDecimals! : req.anchorDecimals!,
        req.isToken0 ? req.anchorDecimals! : req.tokenDecimals!,
      );
    } catch {
      ratio = 0;
    }
    if (ratio > 0) {
      // value(1 t0) = value(ratio * t1)  =>  t0_usd = ratio * t1_usd
      // value(1 t1) = value(1/ratio * t0) => t1_usd = t0_usd / ratio
      const derived = req.isToken0 ? ratio * anchorPrice : anchorPrice / ratio;
      if (derived > 0) return derived;
    }

    // Last-resort fallback for legacy snapshots missing usable sqrtPriceX96.
    if (req.isToken0 && snap.token0PriceUsd > 0) return snap.token0PriceUsd;
    if (!req.isToken0 && snap.token1PriceUsd > 0) return snap.token1PriceUsd;
    return 0;
  }
}

function bucketAlign(timestamp: number): number {
  if (!timestamp || timestamp <= 0) return 0;
  return Math.floor(timestamp / PRICE_CACHE_BUCKET_SECONDS) * PRICE_CACHE_BUCKET_SECONDS;
}

export function buildAnchorKey(chainId: number, address: string, bucketTs: number): string {
  return `${chainId}:${address.toLowerCase()}:${bucketTs}`;
}
