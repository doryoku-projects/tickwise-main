import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Model } from 'mongoose';
import { PageLadderService } from '../common/cache/page-ladder.js';
import { readPathMeter } from '../common/cache/read-path-meter.js';
import {
  LIST_CACHE_JITTER,
  listCacheTtl,
  listWindowRows,
  stableKey,
  staleSince,
  stalenessBudgetMs,
  SwrCache,
  type CacheStatus,
} from '../common/cache/swr-cache.js';
import { deepReadError, serveDeepPage } from '../common/deep-page.js';
import { ReadBudgetService } from '../common/read-budget.js';
import { WriteBudgetService } from '../common/write-budget.js';
import { WRITE_UNITS } from '../common/write-budget-model.js';
import { explicitWriteLane } from '../common/write-lane.js';
import {
  segmentedSource,
  seekSegments,
  type DeepShard,
  type MergeSource,
  type SortBoundary,
  type SortSpec,
} from '../common/shard-stream-merge.js';
import { stableJitter } from '../common/stable-jitter.js';
import { AppConfigService } from '../config/app-config.service.js';
import { budgetedBulkWrite } from './budgeted-write.js';
import { CollectionResolver } from './collection-resolver.js';
import { userReadLagMs } from './replication-lag.js';
import { TokensRepository } from './token.repository.js';
import type { Pool, PoolDocument, PoolMetrics, PoolPricing, PoolToken } from './schemas/pool.schema.js';
import {
  clusterTimestamp,
  isMaxTimeMSExpired,
  isMissingHintError,
  isSnapshotReadError,
  QueryTimeoutException,
  READ_MAX_TIME_MS,
  SECONDARY_ONLY_READ_PREFERENCE,
  SnapshotUnavailableError,
  USER_READ_PREFERENCE,
} from './user-read.js';
import { equityAddresses } from '../pricing/tokenized-equities.js';
import { EXCLUSION_PLACEHOLDER } from '../read-models/pools/pool-query.js';

/** The part of the driver's `Db` the raw snapshot reads use. */
interface NativeDb {
  command(command: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
}

function valueAt(doc: Record<string, unknown>, path: string): unknown {
  let current: unknown = doc;
  for (const key of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export interface PoolUpsert {
  chainId: number;
  protocol: string;
  poolId: string;
  token0: PoolToken;
  token1: PoolToken;
  fee: number;
  /** Lower-cased hook address; the key is OMITTED (not `undefined`) for a pool without one. */
  hooks?: string;
  tickSpacing: number;
  currentTick: number;
  sqrtPriceX96: string;
  liquidity: string;
  createdAtTimestamp: number;
  metrics: PoolMetrics;
  pricing: PoolPricing;
}

export interface PoolsLeaderboardQuery {
  chainId: number;
  protocol: string;
  sort: string;
  page: number;
  limit: number;
  minTvlUsd: number;
  search?: string;
  includeRisky: boolean;
  /** `equity` restricts to pools with a tokenized-equity leg. */
  assetClass?: 'equity';
}

/** The pools-list sorts → sort leaf (the pool catalog's permutations must cover every one, P-R R2). */
export const POOL_SORT_FIELD_MAP: Record<string, string> = {
  tvl: 'metrics.tvlUsd',
  volume: 'metrics.volumeUsd24h',
  fees: 'metrics.feesUsd24h',
  fee_apr: 'metrics.feeApr',
  age: 'createdAtTimestamp',
};

// Hard upper bound on re-valued TVL. Matches the sync-time ceiling; applied
// here too so any stale garbage doc (corrupt re-valuation written before the
// guard existed) never ranks at the top of the TVL sort, even in risky view.
export const TVL_CEILING_USD = 5e10;

interface GroupedPools {
  chainId: number;
  protocol: string;
  pools: PoolUpsert[];
}

function groupByChainProtocol(pools: PoolUpsert[]): Map<string, GroupedPools> {
  const map = new Map<string, GroupedPools>();
  for (const pool of pools) {
    const key = `${pool.chainId}:${pool.protocol}`;
    if (!map.has(key)) {
      map.set(key, { chainId: pool.chainId, protocol: pool.protocol, pools: [] });
    }
    map.get(key)!.pools.push(pool);
  }
  return map;
}

/**
 * An unchanged pool is still rewritten once its stored copy is this old —
 * ±`POOL_REWRITE_JITTER` per pool (`poolRewriteDueAt`), so `updatedAt` never
 * goes more than ~30 h stale and the rewrites of a refilled chain do not all
 * come due in the same walk a day later. `updatedAt` keeps its meaning: the
 * last time pool sync wrote the pool.
 */
export const POOL_REWRITE_MAX_AGE_MS = 24 * 60 * 60_000;
export const POOL_REWRITE_JITTER = 0.25;
/** Ops per pool `bulkWrite`: a 1,000-pool page is at most two bursts of 500. */
export const POOL_WRITE_CHUNK = 500;
/** The pool index `sumTvlUsd` reads (the TVL sort index, `pool.schema.ts`). */
const POOL_TVL_INDEX = 'chainId_1_protocol_1_metrics.tvlUsd_-1';

/** When an unchanged pool written at `updatedAtMs` is due for its forced rewrite. */
export function poolRewriteDueAt(poolId: string, updatedAtMs: number): number {
  return updatedAtMs + POOL_REWRITE_MAX_AGE_MS * stableJitter(poolId, POOL_REWRITE_JITTER);
}

const HOUR_MS = 3_600_000;
const MEMO_HOUR_SLOTS = 2 ** 21; // hours since 1970 → year 2209

/**
 * Pool sync's memory of one pool's last write, in ONE number (a Map of ~1M
 * pools on 4663 must stay small): the first 32 bits of its `contentHash` and
 * the HOUR its forced rewrite is due, rounded DOWN (a pool is rewritten up to
 * an hour early, never late) — `hash32 × 2^21 + hour`, below 2^53. Undefined
 * for a hash that is not hex (a row from before `contentHash`, or garbage):
 * such a pool is simply treated as changed.
 */
export function packPoolMemo(contentHash: string | undefined, dueAtMs: number): number | undefined {
  if (typeof contentHash !== 'string' || !/^[0-9a-f]{8}/i.test(contentHash) || !Number.isFinite(dueAtMs)) return undefined;
  const hash32 = parseInt(contentHash.slice(0, 8), 16);
  const hour = Math.min(MEMO_HOUR_SLOTS - 1, Math.max(0, Math.floor(dueAtMs / HOUR_MS)));
  return hash32 * MEMO_HOUR_SLOTS + hour;
}

export function unpackPoolMemo(memo: number): { hash32: number; dueAtMs: number } {
  const hour = memo % MEMO_HOUR_SLOTS;
  return { hash32: (memo - hour) / MEMO_HOUR_SLOTS, dueAtMs: hour * HOUR_MS };
}

/**
 * The content hash pool sync compares before writing: sha1 over every field of
 * the upsert (keys sorted, `undefined` dropped by `stableKey`), with numbers
 * rounded to 6 significant digits. The rounding is what lets a re-priced pool
 * whose TVL moved by a rounding error count as unchanged; integers below a
 * million (fee, tickSpacing, tick) and every string (sqrtPrice, liquidity,
 * addresses) stay exact, so a swap always reads as a change.
 */
export function poolContentHash(pool: PoolUpsert): string {
  return createHash('sha1').update(stableKey(roundForHash(pool))).digest('hex');
}

function roundForHash(value: unknown): unknown {
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0 ? Number(value.toPrecision(6)) : value;
  if (Array.isArray(value)) return value.map(roundForHash);
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, roundForHash(v)]));
  }
  return value;
}

/**
 * Pool pages: fresh 15 s, served stale up to 30 s while one read refreshes
 * (`listCacheTtl`, the staleness budget — it was 60 s / 10 min). Retained 30
 * min past that only to answer a database timeout, and then flagged.
 */
const POOL_WINDOW_FALLBACK_MS = 30 * 60_000;
const POOL_WINDOW_CACHE_BYTES = 16 * 1024 * 1024;
/** Sort-key rows per batch of a deep-page cursor. */
const DEEP_BATCH_ROWS = 5_000;

/** One page of one pools shard. */
export interface PoolsPage {
  pools: Pool[];
  /** Exact: the read fetched one row past the page. */
  hasMore: boolean;
  cache: CacheStatus;
  /** Set when a deep walk reached the end: the exact match count. */
  total?: number;
  /**
   * Epoch ms the rows were current at, set only when older than the staleness
   * budget (the timeout fallback, a secondary lagging past the budget, a deep
   * page from an aged ladder rung) — the response flags them.
   */
  dataAsOf?: number;
}

/** A deep pools page (`findPoolsLeaderboardDeep`): one shard, or the all-chains merge. */
export interface DeepPoolsPage extends PoolsPage {
  missingChains: number[];
  errors: Array<{ chainId: number; error: unknown }>;
}

type PoolKeyRow = Record<string, unknown>;

/** The query a pools-list request runs, and the cache keys derived from it. */
export interface PoolsPlan {
  chainId: number;
  protocol: string;
  filter: Record<string, unknown>;
  sortField: string;
  sortDirection: 1 | -1;
  key: string;
  countKey: string;
  /** False while the exclusion set has never loaded — results must not be cached. */
  cacheable: boolean;
  /**
   * The same filter with the exclusion list replaced by `EXCLUSION_PLACEHOLDER`
   * (what `countKey` is derived from): the pool catalog casts and compiles
   * THIS once per key and binds the placeholder to `excluded` (P-R R2).
   */
  shapeFilter: Record<string, unknown>;
  /** The exclusion list `filter` carries (empty when the plan has none). */
  excluded: readonly string[];
}

/** A pool catalog's lane-A reference read (P-R R2): one shard's rows and capped count at a clusterTime. */
export interface PoolsSnapshotReference {
  rows: Array<{ poolId: unknown; value: unknown }>;
  count: number;
}

/** Moved to `user-read.ts` (R3 shares it); re-exported for the R2 callers. */
export { SnapshotUnavailableError };

/** A failure of a snapshot read that a plain read at "now" can stand in for. */
function isSnapshotError(err: unknown): boolean {
  return isSnapshotReadError(err);
}

@Injectable()
export class PoolsRepository {
  private readonly logger = new Logger(PoolsRepository.name);
  /** Per-shard pool-list windows (see `findPoolsLeaderboard`). */
  private readonly windows: SwrCache<Pool[]>;
  /**
   * `chainId:protocol` → poolId → `packPoolMemo` of the pool's last write, in
   * the process that runs pool sync (filled by its first walk, then kept up
   * to date by every write) — so a warm walk decides "unchanged" without the
   * per-page `$in` read of stored hashes, which on 4663 read ~953k documents
   * from the primary every walk. ~120 B a pool (~115 MB for 953k). Lost on a
   * restart: the next walk re-reads cold pages once.
   */
  private readonly writeMemo = new Map<string, Map<string, number>>();
  /** Deep pages being walked right now: identical requests share one walk. */
  private readonly deepInFlight = new Map<string, Promise<DeepPoolsPage>>();

  constructor(
    @Inject(CollectionResolver) private readonly resolver: CollectionResolver,
    @Inject(TokensRepository) private readonly tokens: TokensRepository,
    // APPENDED and optional: specs construct this repository positionally.
    @Optional() @Inject(AppConfigService) private readonly config?: AppConfigService,
    @Optional() @Inject(PageLadderService) private readonly ladder?: PageLadderService,
    @Optional() @Inject(ReadBudgetService) private readonly budget?: ReadBudgetService,
    // P2.4: pool writes draw from the shared write budget (off by default = today).
    @Optional() @Inject(WriteBudgetService) private readonly writeBudget?: WriteBudgetService,
  ) {
    this.windows = new SwrCache<Pool[]>({
      name: 'pools-windows',
      maxBytes: POOL_WINDOW_CACHE_BYTES,
      ...listCacheTtl(config),
      jitter: LIST_CACHE_JITTER,
      fallbackMs: POOL_WINDOW_FALLBACK_MS,
      // Read from secondaries: the data is as old as their lag.
      dataLag: () => userReadLagMs(),
      onBackgroundError: (key, err) =>
        this.logger.warn(`pools window refresh failed (stale value kept) key=${key.slice(0, 120)}: ${(err as Error)?.message ?? err}`),
    });
  }

  private model(chainId: number, protocol: string): Model<PoolDocument> {
    return this.resolver.poolModel(chainId, protocol);
  }

  /**
   * Upsert a page of pools, SKIPPING every pool whose content is unchanged.
   *
   * Pool sync used to rewrite every pool on every run (`updatedAt: new Date()`
   * made each write a real modification) — ~75% of Atlas writes, almost all of
   * them risky stubs (tvl 0) whose reserves had not moved. Each pool now
   * carries a `contentHash` of its material fields (`poolContentHash`), and
   * only a changed pool — or one due for its forced rewrite
   * (`poolRewriteDueAt`: 24 h ±25% after its last write, so `updatedAt` never
   * goes more than ~30 h stale) — is written, in `bulkWrite`s of at most
   * `POOL_WRITE_CHUNK` ops.
   *
   * The stored hashes come from this process's memory (`writeMemo`); only
   * pools it has not seen yet are read — one `$in` of `{poolId, contentHash,
   * updatedAt}` per page, on the primary (read-your-writes for the job) — and
   * `hashReads` says how many. A pool is remembered only after its chunk's
   * write succeeded, so a chunk that fails is written again by the next walk.
   */
  async upsertMany(
    pools: PoolUpsert[],
    now: Date = new Date(),
  ): Promise<{ written: number; unchanged: number; hashReads: number }> {
    if (pools.length === 0) return { written: 0, unchanged: 0, hashReads: 0 };
    const grouped = groupByChainProtocol(pools);
    let written = 0;
    let unchanged = 0;
    let hashReads = 0;
    const nowMs = now.getTime();
    await Promise.all(
      [...grouped.values()].map(async (group) => {
        const model = this.model(group.chainId, group.protocol);
        const memo = this.memoFor(group.chainId, group.protocol);
        const hashed = group.pools.map((pool) => ({ pool, hash: poolContentHash(pool) }));
        const cold = hashed.filter(({ pool }) => !memo.has(pool.poolId));
        if (cold.length > 0) {
          hashReads += cold.length;
          const stored = await model
            .find(
              { chainId: group.chainId, protocol: group.protocol, poolId: { $in: cold.map(({ pool }) => pool.poolId) } },
              { _id: 0, poolId: 1, contentHash: 1, updatedAt: 1 },
            )
            .lean<Array<{ poolId: string; contentHash?: string; updatedAt?: Date }>>()
            .exec();
          for (const row of stored) {
            if (!(row.updatedAt instanceof Date)) continue;
            const packed = packPoolMemo(row.contentHash, poolRewriteDueAt(row.poolId, row.updatedAt.getTime()));
            if (packed !== undefined) memo.set(row.poolId, packed);
          }
        }
        const changed = hashed.filter(({ pool, hash }) => {
          const packed = memo.get(pool.poolId);
          if (packed === undefined) return true;
          const remembered = unpackPoolMemo(packed);
          return remembered.hash32 !== parseInt(hash.slice(0, 8), 16) || nowMs >= remembered.dueAtMs;
        });
        unchanged += hashed.length - changed.length;
        const ops = changed.map(({ pool, hash }) => ({
          updateOne: {
            filter: { chainId: pool.chainId, protocol: pool.protocol, poolId: pool.poolId },
            update: { $set: { ...pool, contentHash: hash, updatedAt: now } },
            upsert: true,
          },
        }));
        // Through the shared write budget (P2.4): lane `pools` unless a caller
        // set one, 0.5 u per pool, the `$in` hash read charged as primary-read
        // units with the first chunk (or alone when nothing changed). With the
        // budget off this is exactly today's ≤ POOL_WRITE_CHUNK-op bulkWrites.
        await budgetedBulkWrite(model, ops, {
          budget: this.writeBudget,
          lane: explicitWriteLane() ?? 'pools',
          unitsPerOp: WRITE_UNITS.poolUpdate,
          readDocs: cold.length,
          maxOps: POOL_WRITE_CHUNK,
          bulkOptions: { ordered: false },
          onChunk: (result, chunk, offset) => {
            written += result.upsertedCount + result.modifiedCount;
            // Remembered only once the write succeeded: a chunk that throws keeps
            // its old memory (or none), so its pools still read as changed / due
            // and the next walk writes them again.
            for (const { pool, hash } of changed.slice(offset, offset + chunk.length)) {
              const packed = packPoolMemo(hash, poolRewriteDueAt(pool.poolId, nowMs));
              if (packed !== undefined) memo.set(pool.poolId, packed);
            }
          },
        });
      }),
    );
    return { written, unchanged, hashReads };
  }

  /**
   * Called by pool sync when a walk starts from the top: if the shard now
   * holds FEWER pool documents than this process remembers writing (the
   * collection was dropped or pruned by hand), the memory would keep skipping
   * pools that no longer exist for up to a day — so it is forgotten and the
   * walk re-reads every page once. One metadata count (`estimatedDocumentCount`),
   * no document read.
   */
  async revalidateWriteMemo(chainId: number, protocol: string): Promise<{ remembered: number; stored: number; cleared: boolean }> {
    const memo = this.memoFor(chainId, protocol);
    const remembered = memo.size;
    if (remembered === 0) return { remembered, stored: 0, cleared: false };
    const stored = await this.model(chainId, protocol).estimatedDocumentCount().exec();
    if (stored >= remembered) return { remembered, stored, cleared: false };
    memo.clear();
    this.logger.warn(
      `pool write memory for ${chainId}:${protocol} forgotten: the shard holds ${stored} pools but ${remembered} were remembered ` +
        `(dropped or pruned?) — this walk re-reads every stored hash once`,
    );
    return { remembered, stored, cleared: true };
  }

  private memoFor(chainId: number, protocol: string): Map<string, number> {
    const key = `${chainId}:${protocol}`;
    let memo = this.writeMemo.get(key);
    if (!memo) this.writeMemo.set(key, (memo = new Map()));
    return memo;
  }

  /**
   * The pools-list filter for one shard. Pure: `excluded` is the chain's merged
   * spam + no-real-market set from `TokensRepository`.
   */
  private buildPoolsFilter(query: PoolsLeaderboardQuery, excluded: readonly string[]): Record<string, unknown> {
    const filter: Record<string, unknown> = {
      chainId: query.chainId,
      protocol: query.protocol,
    };

    // Bound TVL at BOTH ends. The v4 subgraph can report negative
    // `totalValueLockedToken*` (re-values to a negative TVL) and bad token
    // prices can blow it past any real pool — so floor at 0 and cap at the
    // ceiling. `minTvlUsd` is coerced defensively (query params can arrive as
    // strings; a string bound vs a numeric field matches nothing in Mongo).
    const minTvl = Number(query.minTvlUsd);
    const floor = Number.isFinite(minTvl) && minTvl > 0 ? minTvl : 0;
    filter['metrics.tvlUsd'] = { $gte: floor, $lte: TVL_CEILING_USD };

    if (!query.includeRisky) {
      filter['pricing.source'] = { $ne: 'none' };
      filter['pricing.usedFallback'] = { $ne: true };
    }

    const andClauses: Record<string, unknown>[] = [];
    if (query.search) {
      const escaped = query.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(escaped, 'i');
      andClauses.push({
        $or: [
          { 'token0.symbol': pattern },
          { 'token1.symbol': pattern },
          { 'token0.address': pattern },
          { 'token1.address': pattern },
          { poolId: pattern },
        ],
      });
    } else {
      // Bad-token exclusion (mirrors the positions leaderboard): drop pools
      // whose either leg is GoPlus-flagged spam OR a known no-active-DEX-market
      // token — clears stale fabricated rows (a re-priced fake leg) at READ
      // time, before the hourly re-sync rewrites the doc. Skipped on search
      // (direct lookup semantics — a searched spam pool stays findable, same
      // as findPoolById).
      if (excluded.length > 0) {
        andClauses.push({
          'token0.address': { $nin: excluded },
          'token1.address': { $nin: excluded },
        });
      }
    }
    if (query.assetClass === 'equity') {
      // Tokenized-equity pools: either leg is a known equity contract on this
      // chain. Resolved HERE rather than in the service, because the merged
      // all-chains path spreads one chain-agnostic baseArgs into every shard.
      //
      // Deliberately NOT wrapped in a `length > 0` guard the way the bad-token
      // exclusion above is. That one is an EXCLUSION, where an empty list means
      // "drop nothing"; this is an INCLUSION, where an empty list must mean
      // "match nothing". `{ $in: [] }` gives exactly that, so a chain with no
      // tokenized equities returns zero rows rather than every row.
      const equities = equityAddresses(query.chainId);
      andClauses.push({
        $or: [
          { 'token0.address': { $in: equities } },
          { 'token1.address': { $in: equities } },
        ],
      });
    }

    if (andClauses.length > 0) filter.$and = andClauses;

    return filter;
  }

  /**
   * The query a pools-list request runs plus its cache keys, derived from the
   * FILTER (a search RegExp included — `stableKey` gives it a distinct form) so
   * no parameter that changes the result can be missing from the key. Waits only
   * for a chain's first-ever exclusion build.
   */
  async poolsPlan(query: PoolsLeaderboardQuery): Promise<PoolsPlan> {
    const exclusions = query.search
      ? { addresses: [] as string[], ok: true }
      : await this.tokens.readyLeaderboardExclusions(query.chainId);
    const filter = this.buildPoolsFilter(query, exclusions.addresses);
    const keyFilter = this.buildPoolsFilter(query, exclusions.addresses.length > 0 ? [EXCLUSION_PLACEHOLDER] : []);
    const sortField = POOL_SORT_FIELD_MAP[query.sort] ?? POOL_SORT_FIELD_MAP.tvl;
    const sortDirection = this.sortDirectionFor(query.sort);
    const countKey = `pools|${query.chainId}:${query.protocol}|${stableKey(keyFilter)}`;
    return {
      chainId: query.chainId,
      protocol: query.protocol,
      filter,
      sortField,
      sortDirection,
      key: `${countKey}|${sortField}:${sortDirection}`,
      countKey,
      cacheable: exclusions.ok,
      shapeFilter: keyFilter,
      excluded: query.search ? [] : exclusions.addresses,
    };
  }

  /**
   * `filter` as MongoDB receives it: cast through the shard's Mongoose model
   * (P-R R2 compiles the CAST filter, never a re-derivation). A model without
   * `cast` (spec doubles) returns the filter as is; a cast that throws throws
   * — the Mongo path would fail the same way.
   */
  castFilter(chainId: number, protocol: string, filter: Record<string, unknown>): Record<string, unknown> {
    const query = this.model(chainId, protocol).find(filter) as unknown as { cast?: () => Record<string, unknown> };
    return typeof query?.cast === 'function' ? query.cast() : filter;
  }

  /** The native handle a raw command needs (absent on spec doubles). */
  private nativeOf(chainId: number, protocol: string): { db: NativeDb; collection: string } | undefined {
    const model = this.model(chainId, protocol) as unknown as { db?: { db?: NativeDb }; collection?: { collectionName?: string } };
    const db = model.db?.db;
    const collection = model.collection?.collectionName;
    return db && typeof db.command === 'function' && collection ? { db, collection } : undefined;
  }

  /**
   * Whole pool documents by `poolId` (the unique index), for a page the pool
   * catalog ordered (P-R R2, design §5.4). At `atClusterTime` the read is a
   * `readConcern: snapshot` at that clusterTime — the page's rows as of the
   * same instant as its order and filter. It must be a RAW command: the
   * driver's find / aggregate helpers drop `atClusterTime` from a readConcern
   * (verified on the rig, mongoose 9 / driver 7). A snapshot the server cannot
   * serve (older than its history window, ahead of its clusterTime, a
   * standalone) falls back to a plain read — today's deep-page behaviour —
   * and `meta.snapshotFallback` says so. Order is the caller's; a missing
   * document is simply absent.
   */
  async findRowsByPoolIds(
    chainId: number,
    protocol: string,
    poolIds: readonly string[],
    options: { atClusterTime?: { t: number; i: number }; maxTimeMS?: number; meta?: { snapshotFallback?: boolean } } = {},
  ): Promise<Pool[]> {
    if (poolIds.length === 0) return [];
    const filter = { chainId, protocol, poolId: { $in: [...poolIds] } };
    const maxTimeMS = options.maxTimeMS ?? READ_MAX_TIME_MS.pools;
    const native = options.atClusterTime ? this.nativeOf(chainId, protocol) : undefined;
    if (native && options.atClusterTime) {
      try {
        const reply = await native.db.command(
          {
            find: native.collection,
            filter,
            batchSize: poolIds.length + 1,
            singleBatch: true,
            readConcern: { level: 'snapshot', atClusterTime: clusterTimestamp(options.atClusterTime) },
            maxTimeMS,
          },
          { readPreference: USER_READ_PREFERENCE },
        );
        return ((reply as { cursor?: { firstBatch?: Pool[] } }).cursor?.firstBatch ?? []) as Pool[];
      } catch (err) {
        if (isMaxTimeMSExpired(err)) throw new QueryTimeoutException();
        if (!isSnapshotError(err)) throw err;
        if (options.meta) options.meta.snapshotFallback = true;
      }
    }
    try {
      return await this.model(chainId, protocol).find(filter).read(USER_READ_PREFERENCE).maxTimeMS(maxTimeMS).lean<Pool[]>();
    } catch (err) {
      throw isMaxTimeMSExpired(err) ? new QueryTimeoutException() : err;
    }
  }

  /**
   * The pool catalog's lane-A reference (P-R R2, design §7.1): one shard's
   * first rows `{poolId, sort value}` in the pools order and its capped count,
   * both at `atClusterTime` (`readConcern: snapshot`), on a SECONDARY (it fails
   * rather than loads the primary), from the CAST filter. Throws
   * `SnapshotUnavailableError` when the server cannot read at that time.
   */
  async snapshotReference(
    chainId: number,
    protocol: string,
    args: { filter: Record<string, unknown>; sortField: string; sortDirection: 1 | -1; skip: number; limit: number; cap: number; atClusterTime: { t: number; i: number }; maxTimeMS: number },
  ): Promise<PoolsSnapshotReference> {
    const native = this.nativeOf(chainId, protocol);
    if (!native) throw new SnapshotUnavailableError(new Error('no native handle'));
    const readConcern = { level: 'snapshot', atClusterTime: clusterTimestamp(args.atClusterTime) };
    try {
      const [found, counted] = await Promise.all([
        native.db.command(
          {
            find: native.collection,
            filter: args.filter,
            sort: { [args.sortField]: args.sortDirection, poolId: 1 },
            projection: { _id: 0, poolId: 1, [args.sortField]: 1 },
            ...(args.skip > 0 ? { skip: args.skip } : {}),
            limit: args.limit,
            batchSize: args.limit,
            singleBatch: true,
            readConcern,
            maxTimeMS: args.maxTimeMS,
          },
          { readPreference: SECONDARY_ONLY_READ_PREFERENCE },
        ),
        native.db.command(
          {
            aggregate: native.collection,
            pipeline: [{ $match: args.filter }, { $limit: args.cap }, { $count: 'n' }],
            cursor: {},
            readConcern,
            maxTimeMS: args.maxTimeMS,
          },
          { readPreference: SECONDARY_ONLY_READ_PREFERENCE },
        ),
      ]);
      const rows = ((found as { cursor?: { firstBatch?: Array<Record<string, unknown>> } }).cursor?.firstBatch ?? []).map((row) => ({
        poolId: row.poolId,
        value: valueAt(row, args.sortField),
      }));
      const first = (counted as { cursor?: { firstBatch?: Array<{ n?: number }> } }).cursor?.firstBatch?.[0];
      return { rows, count: Number(first?.n ?? 0) };
    } catch (err) {
      if (isSnapshotError(err)) throw new SnapshotUnavailableError(err);
      throw err;
    }
  }

  /**
   * One page of one shard from a per-shard window cache (fresh 15 s, stale up
   * to 30 s), reading one row past the window so `hasMore` is exact. No count
   * runs here — see `countPoolsLeaderboard`. Deeper than the windows a page is
   * a streaming walk (`findPoolsLeaderboardDeep`). A server-side timeout
   * serves the last retained window — flagged `dataAsOf`, it is older than the
   * staleness budget — else a 503.
   */
  async findPoolsLeaderboard(query: PoolsLeaderboardQuery): Promise<PoolsPage> {
    const windowRows = listWindowRows(query.page, query.limit);
    if (windowRows === null) {
      const deep = await this.findPoolsLeaderboardDeep([query]);
      return {
        pools: deep.pools,
        hasMore: deep.hasMore,
        total: deep.total,
        cache: 'miss',
        ...(deep.dataAsOf !== undefined ? { dataAsOf: deep.dataAsOf } : {}),
      };
    }

    const plan = await this.poolsPlan(query);
    const skip = (query.page - 1) * query.limit;
    const key = `${plan.key}|w${windowRows}`;
    let rows: Pool[];
    let cache: CacheStatus;
    let dataAsOf: number | undefined;
    try {
      let dataAt: number;
      ({ value: rows, status: cache, dataAt } = await this.windows.get(
        key,
        () => this.readPoolRows(plan, 0, windowRows + 1),
        { shouldStore: () => plan.cacheable },
      ));
      // Inside its cache window but read from a secondary lagging past the budget.
      dataAsOf = staleSince(dataAt, stalenessBudgetMs(this.config));
      if (dataAsOf !== undefined) readPathMeter.staleServed('pools', Date.now() - dataAsOf);
    } catch (err) {
      if (!isMaxTimeMSExpired(err)) throw err;
      const retained = this.windows.peekRetained(key);
      if (!retained) throw new QueryTimeoutException();
      this.logger.warn(`[alert] pools.timeout_served_stale chain=${plan.chainId} ageMs=${Date.now() - retained.dataAt}`);
      readPathMeter.staleServed('pools', Date.now() - retained.dataAt);
      rows = retained.value;
      cache = 'stale';
      dataAsOf = retained.dataAt;
    }
    return {
      pools: rows.slice(skip, skip + query.limit),
      hasMore: rows.length > skip + query.limit,
      cache,
      ...(dataAsOf !== undefined ? { dataAsOf } : {}),
    };
  }

  /**
   * A pools page deeper than the windows (> 1,000 rows), over one shard or the
   * all-chains merge: the same streaming walk as the positions one
   * (`PositionsRepository.findLeaderboardDeep` — sort keys only, from the
   * nearest page-ladder rung, the global read budget, failed shards dropped),
   * under the pools order `{<metric>: dir, poolId: 1}` with NO collation, so
   * the `poolId` tie is plain lexicographic, then only the page's documents
   * by `poolId`.
   */
  async findPoolsLeaderboardDeep(queries: PoolsLeaderboardQuery[]): Promise<DeepPoolsPage> {
    const first = queries[0];
    if (!first) return { pools: [], hasMore: false, cache: 'miss', missingChains: [], errors: [] };
    const settled = await Promise.allSettled(queries.map((query) => this.poolsPlan(query)));
    const plans: PoolsPlan[] = [];
    const missingChains: number[] = [];
    const errors: Array<{ chainId: number; error: unknown }> = [];
    settled.forEach((result, i) => {
      if (result.status === 'fulfilled') plans.push(result.value);
      else {
        missingChains.push(queries[i]!.chainId);
        errors.push({ chainId: queries[i]!.chainId, error: result.reason });
      }
    });
    if (plans.length === 0) throw deepReadError(errors[0]?.error);

    const skip = (first.page - 1) * first.limit;
    const flightKey = `${plans.map((plan) => plan.key).join('||')}|${skip}|${first.limit}`;
    let flight = this.deepInFlight.get(flightKey);
    if (!flight) {
      flight = this.walkPools(plans, skip, first.limit).finally(() => this.deepInFlight.delete(flightKey));
      this.deepInFlight.set(flightKey, flight);
    }
    const page = await flight;
    if (missingChains.length === 0) return page;
    return { ...page, missingChains: [...missingChains, ...page.missingChains], errors: [...errors, ...page.errors] };
  }

  private async walkPools(plans: PoolsPlan[], skip: number, limit: number): Promise<DeepPoolsPage> {
    const head = plans[0]!;
    const spec: SortSpec = {
      field: head.sortField,
      direction: head.sortDirection,
      tieField: 'poolId',
      tieDirection: 1,
      collated: false,
    };
    const ladderable = this.ladder && plans.every((plan) => plan.cacheable);
    const page = await serveDeepPage<PoolKeyRow, Pool>({
      shards: (chains, deadlineAt) =>
        plans.filter((plan) => chains.includes(plan.chainId)).map((plan) => this.deepShard(plan, spec, deadlineAt)),
      chains: plans.map((plan) => plan.chainId),
      spec,
      skip,
      limit,
      maxTimeMS: READ_MAX_TIME_MS.pools,
      ladder: ladderable ? { store: this.ladder!, key: `pools|${plans.map((plan) => plan.key).join('||')}` } : undefined,
      budget: this.budget,
      config: this.config,
      fetch: (rows, deadlineAt) => this.fetchPageDocs(plans, rows, deadlineAt),
      route: 'pools-deep',
    });
    return {
      pools: page.docs,
      hasMore: page.hasMore,
      ...(page.total !== undefined ? { total: page.total } : {}),
      cache: 'miss',
      missingChains: page.missingChains,
      errors: page.errors,
      ...(page.dataAsOf !== undefined ? { dataAsOf: page.dataAsOf } : {}),
    };
  }

  private deepShard(plan: PoolsPlan, spec: SortSpec, deadlineAt: number): DeepShard<PoolKeyRow> {
    const model = this.model(plan.chainId, plan.protocol);
    return {
      chainId: plan.chainId,
      open: (boundary: SortBoundary | null, needed: number): MergeSource<PoolKeyRow> =>
        segmentedSource<PoolKeyRow>(plan.chainId, seekSegments(spec, boundary, plan.chainId), needed, async (segment, limit) => {
          const filter = segment
            ? { ...plan.filter, $and: [...((plan.filter.$and as unknown[] | undefined) ?? []), segment] }
            : plan.filter;
          const cursor = model
            .find(filter)
            .select({ _id: 0, poolId: 1, [plan.sortField]: 1 })
            .sort({ [plan.sortField]: plan.sortDirection, poolId: 1 })
            .limit(limit)
            .batchSize(Math.min(DEEP_BATCH_ROWS, limit))
            .read(USER_READ_PREFERENCE)
            .maxTimeMS(Math.max(1, Math.floor(deadlineAt - Date.now())))
            .lean<PoolKeyRow[]>()
            .cursor();
          try {
            const firstRow = (await cursor.next()) as PoolKeyRow | null;
            return {
              cursor: cursor as unknown as { next(): Promise<PoolKeyRow | null>; close(): Promise<unknown> },
              first: firstRow ?? null,
            };
          } catch (err) {
            await cursor.close().catch(() => undefined);
            throw err;
          }
        }),
    };
  }

  /** A deep page's pool documents by `poolId` (the unique index), in the walk's order. */
  private async fetchPageDocs(
    plans: PoolsPlan[],
    rows: Array<{ chainId: number; row: PoolKeyRow }>,
    deadlineAt: number,
  ): Promise<{ docs: Pool[]; missingChains: number[]; errors: Array<{ chainId: number; error: unknown }> }> {
    const byChain = new Map<number, string[]>();
    for (const { chainId, row } of rows) {
      const ids = byChain.get(chainId) ?? [];
      ids.push(String(row.poolId));
      byChain.set(chainId, ids);
    }
    const protocolOf = new Map(plans.map((plan) => [plan.chainId, plan.protocol]));
    const found = new Map<string, Pool>();
    const missingChains: number[] = [];
    const errors: Array<{ chainId: number; error: unknown }> = [];
    await Promise.all(
      [...byChain].map(async ([chainId, ids]) => {
        const protocol = protocolOf.get(chainId)!;
        try {
          const docs = await this.model(chainId, protocol)
            .find({ chainId, protocol, poolId: { $in: ids } })
            .read(USER_READ_PREFERENCE)
            .maxTimeMS(Math.max(1, Math.floor(deadlineAt - Date.now())))
            .lean<Pool[]>();
          for (const doc of docs) found.set(`${chainId}:${doc.poolId}`, doc);
        } catch (error) {
          missingChains.push(chainId);
          errors.push({ chainId, error });
        }
      }),
    );
    const docs = rows
      .map(({ chainId, row }) => found.get(`${chainId}:${String(row.poolId)}`))
      .filter((doc): doc is Pool => doc !== undefined);
    return { docs, missingChains, errors };
  }

  /** The capped match count for a pools plan (same filter, no collation). */
  async countPoolsLeaderboard(
    plan: PoolsPlan,
    cap: number,
    maxTimeMS: number = READ_MAX_TIME_MS.count,
  ): Promise<{ count: number; capped: boolean }> {
    try {
      const count = await this.model(plan.chainId, plan.protocol)
        .countDocuments(plan.filter, { limit: cap })
        .read(USER_READ_PREFERENCE)
        .maxTimeMS(maxTimeMS)
        .exec();
      return { count, capped: count >= cap };
    } catch (err) {
      throw isMaxTimeMSExpired(err) ? new QueryTimeoutException() : err;
    }
  }

  private readPoolRows(plan: PoolsPlan, skip: number, n: number): Promise<Pool[]> {
    // No collation: pools sort by numeric metrics (+ hex poolId tiebreak), so
    // `numericOrdering` is unneeded — and it breaks numeric range filters
    // ($gte/$lte) on this collection, silently returning zero rows.
    return this.model(plan.chainId, plan.protocol)
      .find(plan.filter)
      .sort({ [plan.sortField]: plan.sortDirection, poolId: 1 })
      .skip(skip)
      .limit(n)
      .read(USER_READ_PREFERENCE)
      .maxTimeMS(READ_MAX_TIME_MS.pools)
      .lean<Pool[]>();
  }

  // Public mirrors of the Mongo sort spec above — the all-chains scatter-gather
  // merge comparator must replicate it exactly.
  sortFieldFor(sort: string): string {
    return POOL_SORT_FIELD_MAP[sort] ?? POOL_SORT_FIELD_MAP.tvl;
  }

  sortDirectionFor(sort: string): 1 | -1 {
    return sort === 'age' ? 1 : -1;
  }

  /** Pool detail (user read path): secondary-preferred, 5 s budget, timeout → 503. */
  async findPoolById(chainId: number, protocol: string, poolId: string): Promise<Pool | null> {
    try {
      return await this.model(chainId, protocol)
        .findOne({ chainId, protocol, poolId: poolId.toLowerCase() })
        .read(USER_READ_PREFERENCE)
        .maxTimeMS(READ_MAX_TIME_MS.pools)
        .lean<Pool | null>();
    } catch (err) {
      throw isMaxTimeMSExpired(err) ? new QueryTimeoutException() : err;
    }
  }

  /**
   * Every pool document on the shard — the collection's metadata count
   * (`estimatedDocumentCount`, RECORD_STORE_FAST_COUNT, nothing read), on a
   * secondary. For `/v1/stats`, which used `countDocuments({})` (a COLLSCAN:
   * 611k documents on 4663 on the M10 rig).
   */
  async estimatedTotal(chainId: number, protocol: string): Promise<number> {
    return this.model(chainId, protocol).estimatedDocumentCount().read(USER_READ_PREFERENCE).maxTimeMS(READ_MAX_TIME_MS.count).exec();
  }

  /**
   * The summed `metrics.tvlUsd` of the shard's pools with a positive TVL, read
   * from the keys of the TVL sort index alone (IXSCAN, 0 documents fetched —
   * on the rig 9,168 keys / 7 ms on 4663, where the old `$group` over every
   * document was a COLLSCAN of 611k / 743 ms; same total to the cent), on a
   * secondary. `/v1/stats`' fallback until pool sync has recorded a complete
   * walk (`SyncRepository.poolWalkStats`). A shard without that index sums
   * unhinted.
   */
  async sumTvlUsd(chainId: number, protocol: string): Promise<{ tvlUsd: number; pools: number }> {
    const run = async (hint: string | undefined) => {
      let agg = this.model(chainId, protocol)
        .aggregate<{ total: number; n: number }>([
          { $match: { chainId, protocol, 'metrics.tvlUsd': { $gt: 0 } } },
          { $group: { _id: null, total: { $sum: '$metrics.tvlUsd' }, n: { $sum: 1 } } },
        ])
        .read(USER_READ_PREFERENCE)
        .option({ maxTimeMS: READ_MAX_TIME_MS.count });
      if (hint) agg = agg.hint(hint);
      return agg.exec();
    };
    let rows: Array<{ total: number; n: number }>;
    try {
      rows = await run(POOL_TVL_INDEX);
    } catch (err) {
      if (!isMissingHintError(err)) throw err;
      rows = await run(undefined);
    }
    const total = Number(rows[0]?.total);
    return { tvlUsd: Number.isFinite(total) ? Math.max(0, total) : 0, pools: Number(rows[0]?.n) || 0 };
  }

  /**
   * The hook of each pool, by `poolId`, for the position rows a page serves
   * (they carry no hook of their own — see `PoolHooksCache`). One `$in` on the
   * unique `(chainId, protocol, poolId)` index with a two-field projection,
   * user read path (secondary-preferred, the pools budget). A pool the shard
   * does not hold is simply absent from the result; a pool without a hook
   * comes back with `hooks: undefined`. Never more than the page's pool count.
   */
  async findHooksByPoolIds(
    chainId: number,
    protocol: string,
    poolIds: readonly string[],
  ): Promise<Array<{ poolId: string; hooks?: string }>> {
    if (poolIds.length === 0) return [];
    try {
      return await this.model(chainId, protocol)
        .find({ chainId, protocol, poolId: { $in: poolIds.map((id) => id.toLowerCase()) } }, { _id: 0, poolId: 1, hooks: 1 })
        .read(USER_READ_PREFERENCE)
        .maxTimeMS(READ_MAX_TIME_MS.pools)
        .lean<Array<{ poolId: string; hooks?: string }>>();
    } catch (err) {
      throw isMaxTimeMSExpired(err) ? new QueryTimeoutException() : err;
    }
  }

  // Batch read for last-good pool stats — used as a fallback when the live
  // vanilla-subgraph fetch fails (transient "bad indexers" gateway flap), so
  // positions inherit the hourly-synced re-valued metrics instead of zeros.
  async findByIds(chainId: number, protocol: string, poolIds: string[]): Promise<Pool[]> {
    if (poolIds.length === 0) return [];
    return this.model(chainId, protocol)
      .find({ chainId, protocol, poolId: { $in: poolIds.map((id) => id.toLowerCase()) } })
      .lean<Pool[]>();
  }
}
