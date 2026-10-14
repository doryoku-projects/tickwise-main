import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { ReadPathRedis } from '../common/cache/read-path-redis.js';
import { RedisLease } from '../common/redis-lease.js';
import { AppConfigService } from '../config/app-config.service.js';
import { PoolsRepository } from '../database/pools.repository.js';
import { PositionsRepository } from '../database/positions.repository.js';
import { SyncRepository, type PoolWalkStats } from '../database/sync.repository.js';
import { IndexingStatusService } from '../health/indexing-status.service.js';

/**
 * One enabled (chainId, protocol) shard's slice of the corpus.
 *
 * Added 2026-08-14 so the marketing coverage panel can name a per-chain figure
 * instead of a dash.
 */
export interface PublicChainStats {
  chainId: number;
  protocol: string;
  /** Pool documents on this shard (as of the last complete pool-sync walk; see `V1StatsService.compute`). */
  pools: number;
  /** Every position document on this shard — open AND closed. */
  positions: number;
  /** Open positions only (`isActive: true`) — what a coverage panel means. */
  activePositions: number;
  /**
   * Summed `metrics.tvlUsd` across this shard's pools.
   *
   * ALREADY GATED, and that is what makes it publishable: `pools-sync` values a
   * pool through `evaluatePoolTvl`, which zeroes a corrupt-reserve pool and
   * refuses to price an untrusted leg, so this is the sum of TVL we are willing
   * to stand behind rather than the sum of what the subgraph claims. It is
   * therefore a LOWER bound on real TVL, which is the right direction for a
   * number printed on a marketing page.
   */
  tvlUsd: number;
  /** Indexer head for this shard, epoch SECONDS, or null. */
  indexedUpToTimestamp: number | null;
}

export interface PublicStats {
  /** Pool documents across every enabled (chainId, protocol) shard. */
  pools: number;
  /** Every position document across every enabled shard — open AND closed. */
  positions: number;
  /** Open positions across every enabled shard. */
  activePositions: number;
  /** Summed gated pool TVL across every enabled shard. See `PublicChainStats`. */
  tvlUsd: number;
  /** Indexer head as an ISO timestamp, or null when no shard reports one. */
  indexedTo: string | null;
  /** The same figures, per shard. Additive — existing readers ignore it. */
  byChain: PublicChainStats[];
}

/**
 * Cache window — fresh this long in every process, and the TTL of the shared
 * Redis copy. Counting is per shard on an UNAUTHENTICATED route, so the cache
 * is the rate limiter here (the route carries no key and no metering).
 */
export const STATS_TTL_MS = 45_000;
/** How long the computing process holds the lease (a compute takes well under a second on the rig). */
export const STATS_LEASE_TTL_MS = 30_000;
/** A process with NOTHING to serve waits this long for the lease holder's result before computing itself. */
export const STATS_COLD_WAIT_MS = 5_000;
const STATS_COLD_POLL_MS = 250;
/** A process with a stale value whose refresh found the lease held asks again after this long. */
export const STATS_HELD_RETRY_MS = 1_000;

interface StatsCache {
  value: PublicStats;
  /** epoch ms the value was COMPUTED (by this process or the lease holder); 0 = cold. */
  fetchedAt: number;
  /** true once a real (non-sentinel) value has been computed at least once. */
  hasValue: boolean;
  /** No refresh is started before this (the lease was held elsewhere a moment ago). */
  nextAttemptAt: number;
  /** in-flight refresh, if any — concurrent callers dedup onto it. */
  inflight?: Promise<PublicStats>;
}

interface SharedStats {
  computedAt: number;
  value: PublicStats;
}

/**
 * `GET /v1/stats` — the honest headline numbers: every indexed row, no
 * visibility filters (deliberately NOT the leaderboard's `pagination.total`,
 * which runs the whole visibility stack).
 *
 * WHAT IT READS (scale plan 1.3, 2026-10-03). It used to run, per shard and
 * every 45 s IN EVERY PROCESS, `countDocuments({})` on positions and pools and
 * a `$group` sum over every pool — full collection scans on the PRIMARY
 * (measured on the M10 rig: chain 1 positions 430k documents / 2.6 s, 4663
 * pools 611k / 743 ms). Now, per shard:
 *  - positions: `estimatedDocumentCount` — collection metadata, O(1);
 *  - active positions: a COUNT_SCAN of the partial `bg_active_walk` index on a
 *    secondary (0 documents; it was the legacy `{chainId, protocol, isActive}`
 *    index, now in the migration's drop set);
 *  - pools + TVL: the totals pool sync records at the end of every COMPLETE
 *    walk (`sync_cursors.poolWalk*` — 0 extra reads; the walk holds every
 *    pool's TVL anyway). Until a shard has one — or when its last walk SKIPPED
 *    pools (their pricing threw: left out of the walk's totals, yet their
 *    stored rows still serve) — `estimatedDocumentCount` + a covered sum over
 *    the TVL index's positive keys (0 documents), i.e. the stored rows.
 *
 * ONE PROCESS COMPUTES. The result is kept in Redis (`tw:stats:v1:<deployment>`,
 * PX 45 s) and recomputed by whichever process takes the lease
 * (`tw:lease:v1:<deployment>:v1-stats`); the others adopt it. Per process it
 * stays stale-while-revalidate + single-flight: fresh → serve; stale → serve
 * last-good and refresh in the background; cold → wait for the shared value
 * (up to 5 s), else compute. Without Redis (off, or unreachable) every process
 * computes for itself, as before. A cold failure RE-THROWS rather than
 * publishing "0 positions indexed", which would read as a factual claim.
 */
@Injectable()
export class V1StatsService {
  private readonly logger = new Logger(V1StatsService.name);
  private readonly cache: StatsCache = {
    value: { pools: 0, positions: 0, activePositions: 0, tvlUsd: 0, indexedTo: null, byChain: [] },
    fetchedAt: 0,
    hasValue: false,
    nextAttemptAt: 0,
  };
  private lease?: RedisLease;

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(PositionsRepository) private readonly positions: PositionsRepository,
    @Inject(PoolsRepository) private readonly pools: PoolsRepository,
    @Inject(SyncRepository) private readonly syncRepo: SyncRepository,
    @Inject(IndexingStatusService) private readonly indexingStatus: IndexingStatusService,
    // APPENDED and optional: without it (specs, or no Redis module) each process computes alone.
    @Optional() @Inject(ReadPathRedis) private readonly redis?: ReadPathRedis,
  ) {}

  /** The cold-wait poll's sleep (replaceable in specs). */
  private sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));

  read(): Promise<PublicStats> {
    const entry = this.cache;
    const now = Date.now();
    if (entry.hasValue && now - entry.fetchedAt < STATS_TTL_MS) return Promise.resolve(entry.value);
    if (!entry.inflight && (!entry.hasValue || now >= entry.nextAttemptAt)) {
      entry.inflight = this.refresh(entry).finally(() => {
        entry.inflight = undefined;
      });
    }
    if (entry.hasValue) {
      // Nobody awaits the background refresh, so swallow its rejection here or
      // a Mongo blip becomes an unhandledRejection (which `main.ts` logs and
      // swallows, but only after the damage of an unattributed error).
      void entry.inflight?.catch(() => undefined);
      return Promise.resolve(entry.value);
    }
    return entry.inflight!;
  }

  private async refresh(entry: StatsCache): Promise<PublicStats> {
    try {
      const redis = await this.redis?.client().catch(() => undefined);
      if (redis) {
        const shared = await this.readShared(redis);
        if (shared && Date.now() - shared.computedAt < STATS_TTL_MS) return this.adopt(entry, shared);
        const lease = this.statsLease();
        const got = await lease.acquire();
        if (got === 'acquired') {
          try {
            const value = await this.compute();
            const computed = { computedAt: Date.now(), value };
            await this.publish(redis, computed);
            return this.adopt(entry, computed);
          } finally {
            await lease.release();
          }
        }
        if (got === 'held') {
          // Another process is computing right now.
          if (entry.hasValue) {
            entry.nextAttemptAt = Date.now() + STATS_HELD_RETRY_MS;
            return entry.value;
          }
          const awaited = await this.waitForShared(redis);
          if (awaited) return this.adopt(entry, awaited);
          // Nothing arrived in time: compute here rather than answer nothing.
        }
      }
      const value = await this.compute();
      return this.adopt(entry, { computedAt: Date.now(), value });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`/v1/stats refresh failed: ${message}`);
      // With a last-good value, stamp anyway so a persistent outage backs off
      // one TTL instead of hot-looping a count on every request. With NO value
      // we surface the failure rather than publishing "0 positions indexed" —
      // a zero here would read as a factual claim about the corpus.
      if (!entry.hasValue) throw err;
      entry.fetchedAt = Date.now();
      return entry.value;
    }
  }

  private adopt(entry: StatsCache, shared: SharedStats): PublicStats {
    entry.value = shared.value;
    entry.hasValue = true;
    entry.fetchedAt = shared.computedAt;
    entry.nextAttemptAt = 0;
    return entry.value;
  }

  private statsLease(): RedisLease {
    if (!this.lease) {
      this.lease = new RedisLease(
        () => this.redis!.client(),
        `tw:lease:v1:${this.redis!.namespace}:v1-stats`,
        STATS_LEASE_TTL_MS,
      );
    }
    return this.lease;
  }

  private sharedKey(): string {
    return `tw:stats:v1:${this.redis?.namespace ?? 'local'}`;
  }

  private async readShared(redis: Redis): Promise<SharedStats | null> {
    try {
      const raw = await redis.get(this.sharedKey());
      if (!raw) return null;
      const parsed = JSON.parse(raw) as Partial<SharedStats>;
      if (typeof parsed?.computedAt !== 'number' || !parsed.value || !Array.isArray(parsed.value.byChain)) return null;
      return { computedAt: parsed.computedAt, value: parsed.value as PublicStats };
    } catch {
      return null;
    }
  }

  private async publish(redis: Redis, shared: SharedStats): Promise<void> {
    try {
      await redis.set(this.sharedKey(), JSON.stringify(shared), 'PX', STATS_TTL_MS);
    } catch (err) {
      this.redis?.logError(err);
    }
  }

  /** A cold process waits for the lease holder's value (fresh, i.e. newer than a TTL). */
  private async waitForShared(redis: Redis): Promise<SharedStats | null> {
    const until = Date.now() + STATS_COLD_WAIT_MS;
    while (Date.now() < until) {
      await this.sleep(STATS_COLD_POLL_MS);
      const shared = await this.readShared(redis);
      if (shared && Date.now() - shared.computedAt < STATS_TTL_MS) return shared;
    }
    return null;
  }

  private async compute(): Promise<PublicStats> {
    const integrations = this.config.enabledIntegrations;
    // One small read of sync_cursors for every shard's last complete pool walk.
    // A failure only means every shard takes the fallback below.
    let walks: Map<string, PoolWalkStats>;
    try {
      walks = await this.syncRepo.poolWalkStats();
    } catch (err) {
      this.logger.warn(`/v1/stats: pool walk totals unavailable, counting pools instead: ${(err as Error)?.message ?? err}`);
      walks = new Map();
    }
    const shards = await Promise.all(
      integrations.map(async (integration) => {
        const { chainId, protocol } = integration;
        const walk = walks.get(`${chainId}:${protocol}`);
        const [positions, activePositions, pools, status] = await Promise.all([
          this.positions.estimatedTotal(chainId, protocol),
          this.positions.countActive(chainId, protocol),
          // A walk that skipped pools (their pricing threw) left them out of
          // its totals while their last stored rows still serve — and are
          // still in the lists. Its TVL would then UNDER-state what is
          // indexed, so such a shard reads the stored rows instead (the same
          // covered, document-free fallback as a shard with no walk yet).
          walk && walk.skipped === 0
            ? Promise.resolve({ pools: walk.pools, tvlUsd: walk.tvlUsd })
            : this.poolsFallback(chainId, protocol),
          // Reuses `/health`'s own computation (cached + fail-soft inside the
          // service) rather than re-deriving a head from the indexer here.
          this.indexingStatus.getStatus(integration),
        ]);
        return {
          chainId,
          protocol,
          positions,
          activePositions,
          pools: pools.pools,
          tvlUsd: Math.max(0, pools.tvlUsd),
          indexedUpToTimestamp: status.indexedUpToTimestamp,
        };
      }),
    );

    // The freshest head across shards. A chain that is behind must not drag the
    // headline backwards, and a shard with no head at all contributes nothing.
    let latestSeconds: number | null = null;
    for (const shard of shards) {
      const seconds = shard.indexedUpToTimestamp;
      if (typeof seconds !== 'number' || seconds <= 0) continue;
      if (latestSeconds === null || seconds > latestSeconds) latestSeconds = seconds;
    }

    return {
      pools: shards.reduce((sum, shard) => sum + shard.pools, 0),
      positions: shards.reduce((sum, shard) => sum + shard.positions, 0),
      activePositions: shards.reduce((sum, shard) => sum + shard.activePositions, 0),
      tvlUsd: shards.reduce((sum, shard) => sum + shard.tvlUsd, 0),
      indexedTo: latestSeconds === null ? null : new Date(latestSeconds * 1000).toISOString(),
      byChain: shards,
    };
  }

  /** A shard with no recorded complete pool walk yet: metadata count + covered TVL sum (no document read). */
  private async poolsFallback(chainId: number, protocol: string): Promise<{ pools: number; tvlUsd: number }> {
    const [pools, tvl] = await Promise.all([this.pools.estimatedTotal(chainId, protocol), this.pools.sumTvlUsd(chainId, protocol)]);
    return { pools, tvlUsd: tvl.tvlUsd };
  }
}
