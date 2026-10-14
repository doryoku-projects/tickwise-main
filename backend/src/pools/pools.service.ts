import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { readPathMeter } from '../common/cache/read-path-meter.js';
import {
  combineCacheStatus,
  LIST_CACHE_JITTER,
  listCacheTtl,
  listWindowRows,
  staleSince,
  stalenessBudgetMs,
  SwrCache,
  type CacheStatus,
  type ReadMeta,
} from '../common/cache/swr-cache.js';
import { hookFields } from '../common/pool-hooks.js';
import { compareSortValue, valueAtPath } from '../common/shard-merge.js';
import { AppConfigService } from '../config/app-config.service.js';
import { resolveTokenLogo, resolveTokenSymbol } from '../constants/token-logos.js';
import { PoolsRepository, type PoolsLeaderboardQuery, type PoolsPlan } from '../database/pools.repository.js';
import type { Pool } from '../database/schemas/pool.schema.js';
import { PositionsRepository, type PoolCountsMeta, type PoolPositionCounts } from '../database/positions.repository.js';
import { userReadLagMs } from '../database/replication-lag.js';
import { TokensRepository } from '../database/token.repository.js';
import { QueryTimeoutException } from '../database/user-read.js';
import {
  LeaderboardCountService,
  resolveCountRoute,
  resolveListPagination,
  type CountResult,
  type ListCountResponse,
} from '../leaderboard/count-cache.js';
import type { ListReadOptions } from '../leaderboard/leaderboard.service.js';
import { PoolCatalogService, type CachedPoolsAnswer, type PoolsAccess } from '../read-models/pools/pool-catalog.service.js';
import { RankEngineService, type PositionsAccess } from '../read-models/rank/rank-engine.service.js';
import { exclusionSetOf, rowRisk } from '../security/token-identity.js';
import type { TopPoolsQueryDto } from './dto/top-pools-query.dto.js';
import { TokenPriceCache } from './token-price-cache.js';

/** A pool detail older than its stale age is kept this long, only to answer a database timeout (flagged). */
const POOL_DETAIL_FALLBACK_MS = 30 * 60_000;

/** A cached pool detail: the response, and how old its oldest input already was. */
type PoolDetailEntry = Awaited<ReturnType<PoolsService['loadPool']>>;

@Injectable()
export class PoolsService {
  private readonly logger = new Logger(PoolsService.name);
  private readonly counts: LeaderboardCountService;
  /**
   * Pool detail (with its holder counts): fresh 15 s, stale 30 s — the list
   * staleness budget (`listCacheTtl`; it was 60 s / 120 s) — counted from its
   * OLDEST input, so the detail cache does not stack on the counts and price
   * caches it is built from.
   */
  private readonly details: SwrCache<PoolDetailEntry>;
  /** Leg prices for pool responses (fresh 30 s + 15 s SWR, batched, secondary). */
  private readonly prices: TokenPriceCache;

  /** What the pool catalog (P-R R2) reads through this service's repository. */
  private readonly access: PoolsAccess;
  /** What the rank engine's holder-count lane A (P-R R3) reads through the positions repository. */
  private readonly positionsAccess: PositionsAccess;

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(PoolsRepository) private readonly pools: PoolsRepository,
    @Inject(PositionsRepository) private readonly positions: PositionsRepository,
    @Inject(TokensRepository) private readonly tokens: TokensRepository,
    // APPENDED and optional: specs construct this service positionally.
    @Optional() @Inject(LeaderboardCountService) counts?: LeaderboardCountService,
    /**
     * The pool catalog (Phase P-R R2), APPENDED and optional. With the pools
     * model `off` (the default) it is inert and every path below is today's.
     */
    @Optional() @Inject(PoolCatalogService) private readonly catalog?: PoolCatalogService,
    /**
     * The positions rank engine (Phase P-R R3), APPENDED and optional: in
     * `serve` it answers the holder counts (design §6.6, §8.3); `off` /
     * `shadow` keep `countsByPoolIds`, byte for byte.
     */
    @Optional() @Inject(RankEngineService) private readonly rank?: RankEngineService,
  ) {
    this.counts = counts ?? new LeaderboardCountService();
    this.access = {
      cast: (chainId, protocol, filter) => this.pools.castFilter(chainId, protocol, filter),
      rows: (chainId, protocol, poolIds, opts) => this.pools.findRowsByPoolIds(chainId, protocol, poolIds, opts),
      reference: (chainId, protocol, args) => this.pools.snapshotReference(chainId, protocol, args),
    };
    this.positionsAccess = {
      cast: (chainId, protocol, filter) => this.positions.castFilter(chainId, protocol, filter),
      rows: (chainId, protocol, positionIds, opts) => this.positions.findListRowsByIds(chainId, protocol, positionIds, opts),
      reference: (chainId, protocol, args) => this.positions.snapshotReference(chainId, protocol, args),
      poolCounts: (chainId, protocol, poolIds, args) => this.positions.snapshotPoolCounts(chainId, protocol, poolIds, args),
    };
    this.prices = new TokenPriceCache(this.tokens);
    this.details = new SwrCache<PoolDetailEntry>({
      name: 'pool-detail',
      maxBytes: 8 * 1024 * 1024,
      ...listCacheTtl(config),
      jitter: LIST_CACHE_JITTER,
      fallbackMs: POOL_DETAIL_FALLBACK_MS,
      onBackgroundError: (key, err) =>
        this.logger.warn(`pool detail refresh failed key=${key}: ${(err as Error)?.message ?? String(err)}`),
    });
    // Serve only (the catalog calls it only then): a pool whose row changed in
    // a catalog generation loses its cached detail (design §3.8). Shadow and
    // off never evict — their responses stay exactly today's.
    this.catalog?.onChangedPools((keys) => {
      for (const key of keys) this.details.delete(key);
    });
    // Serve only, likewise: a pool whose holder counts a rank-engine generation
    // changed loses its cached detail (design §3.8).
    this.rank?.onChangedHolders((keys) => {
      for (const key of keys) this.details.delete(key);
    });
  }

  /**
   * One pools page, from the per-shard window caches; never waits on a count.
   * All chains: a shard that fails is dropped (`partial: true` +
   * `missingChains`, refunded on /v1, never cached); a page deeper than the
   * windows is one streaming walk over every shard. Rows or holder counts older
   * than the staleness budget (a timeout fallback) are flagged `stale: true` +
   * `dataAsOf`.
   */
  async getTopPools(query: TopPoolsQueryDto, options: ListReadOptions = {}) {
    this.assertSupported(query.chainId, query.protocol);

    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const sort = query.sort ?? 'tvl';
    const baseArgs = this.baseArgs(query);
    const chainIds = this.chainIdsFor(query);

    let pools: Pool[];
    let hasMore: boolean;
    let cache: CacheStatus;
    let exactTotal: number | undefined;
    let missingChains: number[] = [];
    const stale: number[] = [];
    let countTasks = (chains: number[]) => Promise.all(chains.map((chainId) => this.countTask({ ...baseArgs, chainId, page: 1, limit })));
    // Only in `serve` is the catalog even asked; `off` / `shadow` run today's path untouched.
    const engine = this.catalog?.mode() === 'serve' ? await this.engineList(query, page, limit, baseArgs, chainIds) : undefined;
    if (engine) {
      // Answered by the pool catalog (P-R R2, `serve`): the same rows, order,
      // totals and flags the Mongo path below produces, without its reads.
      ({ pools, hasMore, cache, missingChains } = engine);
      exactTotal = engine.exactTotal;
      if (engine.dataAsOf !== undefined) stale.push(engine.dataAsOf);
      if (engine.countTasks) {
        // One task per chain on the page (the chains `countChains` lists, in
        // order) — counted by the catalog, cached under the same keys as Mongo's.
        const tasks = engine.countTasks;
        countTasks = async () => tasks;
      }
      this.logPartial(engine.errors);
    } else if (query.chainId !== undefined) {
      const shard = await this.pools.findPoolsLeaderboard({ ...baseArgs, chainId: query.chainId, page, limit });
      ({ pools, hasMore, cache } = shard);
      exactTotal = shard.total;
      if (shard.dataAsOf !== undefined) stale.push(shard.dataAsOf);
    } else if (listWindowRows(page, limit) === null) {
      const deep = await this.pools.findPoolsLeaderboardDeep(
        chainIds.map((chainId) => ({ ...baseArgs, chainId, page, limit })),
      );
      ({ pools, hasMore, cache } = deep);
      exactTotal = deep.total;
      missingChains = deep.missingChains;
      if (deep.dataAsOf !== undefined) stale.push(deep.dataAsOf);
      this.logPartial(deep.errors);
    } else {
      // All-chains scatter-gather: pools are sharded per (chainId, protocol) —
      // fetch each enabled integration's top `page × limit` rows (skip 0),
      // merge with a comparator replicating the Mongo sort spec (field +
      // direction + poolId asc tie-break — plain lexicographic, this
      // collection deliberately has NO numeric collation), slice the page.
      const settled = await Promise.allSettled(
        chainIds.map((chainId) =>
          this.pools.findPoolsLeaderboard({ ...baseArgs, chainId, page: 1, limit: page * limit }),
        ),
      );
      const shards = settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
      const failed = settled.flatMap((result, i) =>
        result.status === 'rejected' ? [{ chainId: chainIds[i]!, error: result.reason as unknown }] : [],
      );
      if (shards.length === 0) throw failed[0]?.error ?? new Error('no shard answered');
      missingChains = failed.map((entry) => entry.chainId);
      this.logPartial(failed);
      cache = combineCacheStatus(shards.map((shard) => shard.cache));
      for (const shard of shards) if (shard.dataAsOf !== undefined) stale.push(shard.dataAsOf);
      const field = this.pools.sortFieldFor(sort);
      const direction = this.pools.sortDirectionFor(sort);
      const merged = shards
        .flatMap((shard) => shard.pools)
        .sort((a, b) => {
          // BSON order, uncollated (`compareSortValue`) — this collection has no collation.
          const primary = compareSortValue(valueAtPath(a, field), valueAtPath(b, field), false) * direction;
          if (primary !== 0) return primary;
          const tie = a.poolId < b.poolId ? -1 : a.poolId > b.poolId ? 1 : 0;
          if (tie !== 0) return tie;
          return a.chainId - b.chainId;
        });
      hasMore = merged.length > page * limit || shards.some((shard) => shard.hasMore);
      pools = merged.slice((page - 1) * limit, page * limit);
    }
    if (missingChains.length > 0) readPathMeter.partialServed('pools');

    const countChains = chainIds.filter((chainId) => !missingChains.includes(chainId));
    const countsMeta: PoolCountsMeta = {};
    const [pagination, counts, prices] = await Promise.all([
      resolveListPagination({
        page,
        limit,
        rowsOnPage: pools.length,
        hasMore,
        exactTotal,
        counts: this.counts,
        countWaitMs: options.countWaitMs,
        tasks: () => countTasks(countChains),
      }),
      this.countsForPools(pools, countsMeta),
      this.pricesForPools(pools),
    ]);
    if (countsMeta.dataAsOf !== undefined) {
      stale.push(countsMeta.dataAsOf);
      readPathMeter.staleServed('pool-counts', Date.now() - countsMeta.dataAsOf);
    }
    const dataAsOf = stale.length > 0 ? Math.min(...stale) : undefined;
    if (options.meta) {
      options.meta.cache = cache;
      if (missingChains.length > 0 || dataAsOf !== undefined) options.meta.noStore = true;
    }
    let countsPending = false;
    const rows = pools.map((pool, index) => {
      const c = counts.get(`${pool.chainId}:${pool.protocol}:${pool.poolId.toLowerCase()}`);
      if (c === null) countsPending = true;
      return {
        ...enrichPool(pool, prices, (page - 1) * limit + index + 1),
        ...countFields(c),
        ...poolRiskFields(pool, this.exclusionSetFor(pool.chainId)),
      };
    });
    const response = {
      pools: rows,
      pagination,
      // Additive: some pools' counts are still being computed (they are null).
      ...(countsPending ? { countsPending: true as const } : {}),
      ...(missingChains.length > 0 ? { partial: true as const, missingChains } : {}),
      ...(dataAsOf !== undefined ? { stale: true as const, dataAsOf: new Date(dataAsOf).toISOString() } : {}),
    };
    // Lane A (shadow AND serve): sampled, after the response, never altering it.
    this.offerShadow(query, chainIds, page, limit, baseArgs, 'list', engine?.answer);
    return response;
  }

  /**
   * The pool catalog's answer for a list request (P-R R2), or undefined —
   * then the Mongo path answers, exactly as today. Only in `serve`, on the
   * ramp's share of requests, for a filter the catalog compiles and shards it
   * holds ready.
   */
  private async engineList(
    query: TopPoolsQueryDto,
    page: number,
    limit: number,
    baseArgs: ReturnType<PoolsService['baseArgs']>,
    chainIds: number[],
  ): Promise<
    | {
        pools: Pool[];
        hasMore: boolean;
        cache: CacheStatus;
        exactTotal?: number;
        missingChains: number[];
        errors: Array<{ chainId: number; error: unknown }>;
        dataAsOf?: number;
        countTasks?: Array<{ key: string; run: () => Promise<CountResult> }>;
        answer: CachedPoolsAnswer;
      }
    | undefined
  > {
    const catalog = this.catalog;
    if (!catalog || chainIds.length === 0) return undefined;
    if (!catalog.route(chainIds, query.protocol).serve) return undefined;
    let plans: PoolsPlan[];
    try {
      plans = await Promise.all(chainIds.map((chainId) => this.pools.poolsPlan({ ...baseArgs, chainId, page, limit })));
    } catch {
      return undefined;
    }
    const outcome = await catalog.list({ plans, page, limit }, this.access);
    if (outcome.kind !== 'ok') return undefined;
    const skip = (page - 1) * limit;
    // The deep path's past-the-end rule (count-cache.ts / deep-page.ts): beyond
    // the windows, a walk that ran out reports its exact, UNCAPPED total.
    const exactTotal = listWindowRows(page, limit) === null && outcome.total <= skip + limit ? outcome.total : undefined;
    const dataAsOf = staleSince(outcome.dataAt, stalenessBudgetMs(this.config));
    if (dataAsOf !== undefined) readPathMeter.staleServed('pools', Date.now() - dataAsOf);
    const countPlans = plans.filter((plan) => !outcome.missingChains.includes(plan.chainId));
    const countTasks = catalog.countTasks(countPlans, this.access, this.config.leaderboardCountCap);
    return {
      pools: outcome.pools,
      hasMore: outcome.hasMore,
      cache: outcome.cache,
      ...(exactTotal !== undefined ? { exactTotal } : {}),
      missingChains: outcome.missingChains,
      errors: outcome.errors,
      ...(dataAsOf !== undefined ? { dataAsOf } : {}),
      // One per chain still on the page, in `chainIds` order (= the caller's `countChains`).
      ...(countTasks ? { countTasks } : {}),
      answer: outcome.answer,
    };
  }

  /** Offer a request to the catalog's lane A (a no-op unless the pools model is shadow / serve). */
  private offerShadow(
    query: TopPoolsQueryDto,
    chainIds: number[],
    page: number,
    limit: number,
    baseArgs: ReturnType<PoolsService['baseArgs']>,
    kind: 'list' | 'count',
    served?: CachedPoolsAnswer,
  ): void {
    const catalog = this.catalog;
    if (!catalog || catalog.mode() === 'off' || chainIds.length === 0) return;
    catalog.offer(
      {
        plans: () => Promise.all(chainIds.map((chainId) => this.pools.poolsPlan({ ...baseArgs, chainId, page, limit }))),
        page,
        limit,
        sort: baseArgs.sort,
        search: baseArgs.search,
        minTvlUsd: baseArgs.minTvlUsd,
        kind,
        served,
      },
      this.access,
    );
  }

  /**
   * `GET /api/top-pools/count`: the capped total for the list's filters,
   * across shards — or `{total: null, capped: false, pending: true}`, never a
   * 5xx (see `resolveCountRoute`).
   */
  async getTopPoolsCount(query: TopPoolsQueryDto, meta?: ReadMeta): Promise<ListCountResponse> {
    this.assertSupported(query.chainId, query.protocol);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const chainIds = this.chainIdsFor(query);
    const baseArgs = this.baseArgs(query);
    const catalog = this.catalog;
    if (catalog && chainIds.length > 0 && catalog.route(chainIds, query.protocol).serve) {
      // Counted by the pool catalog (P-R R2, `serve`): the same capped totals,
      // the same /count contract, no Mongo count.
      try {
        const plans = await Promise.all(chainIds.map((chainId) => this.pools.poolsPlan({ ...baseArgs, chainId, page: 1, limit })));
        const tasks = catalog.countTasks(plans, this.access, this.config.leaderboardCountCap);
        if (tasks) {
          const result = await resolveCountRoute({ route: 'pools', counts: this.counts, meta, tasks: async () => tasks });
          this.offerShadow(query, chainIds, 1, limit, baseArgs, 'count');
          return result;
        }
      } catch {
        // fall through to the Mongo path
      }
    }
    const result = await resolveCountRoute({
      route: 'pools',
      counts: this.counts,
      meta,
      tasks: () => Promise.all(chainIds.map((chainId) => this.countTask({ ...baseArgs, chainId, page: 1, limit }))),
    });
    this.offerShadow(query, chainIds, 1, limit, baseArgs, 'count');
    return result;
  }

  /** One warn per partial all-chains read, naming each dropped chain and why. */
  private logPartial(errors: Array<{ chainId: number; error: unknown }>): void {
    if (errors.length === 0) return;
    this.logger.warn(
      `[alert] pools.partial missing=${errors
        .map(({ chainId, error }) => `${chainId}(${(error as Error)?.message ?? String(error)})`)
        .join(',')} — served the other chains`,
    );
  }

  /**
   * Pool detail with its open-position / holder counts, cached per pool
   * (fresh 15 s, stale 30 s, counted from the OLDEST of its inputs — the pool
   * read, its holder counts, its leg prices — so the caches do not stack: a
   * detail built from a 25 s old count is 25 s old when it is stored, not
   * new). Flagged `stale: true` + `dataAsOf` (no-store) whenever its DATA is
   * older than the staleness budget — a holder count kept long past its stale
   * age, or a read from a secondary lagging past the budget (`dataAt` is the
   * oldest of them). On a read timeout a retained detail is served flagged the
   * same way rather than a 503, like the list routes; only with nothing
   * retained is it a 503.
   */
  async getPool(chainId: number, protocol: string, poolId: string, meta?: ReadMeta) {
    this.assertSupported(chainId, protocol);
    const key = `${chainId}:${protocol}:${poolId.toLowerCase()}`;
    try {
      const { value, status, dataAt } = await this.details.get(key, () => this.loadPool(chainId, protocol, poolId), {
        // A detail whose counts are still being computed is served, not stored.
        shouldStore: (entry) => entry.detail.positionsCount !== null,
        // Its age starts at its oldest input (and so does its data's): an
        // entry built from an old count is born old, not new.
        times: (entry) => ({ storedAt: entry.storedAt, dataAt: entry.dataAt }),
      });
      if (meta) meta.cache = status;
      const asOf = staleSince(dataAt, stalenessBudgetMs(this.config));
      if (asOf === undefined) return value.detail;
      readPathMeter.staleServed('pool-detail', Date.now() - asOf);
      if (meta) meta.noStore = true;
      return { ...value.detail, stale: true as const, dataAsOf: new Date(asOf).toISOString() };
    } catch (err) {
      if (!(err instanceof QueryTimeoutException)) throw err;
      const retained = this.details.peekRetained(key);
      if (!retained) throw err;
      const ageMs = Date.now() - retained.dataAt;
      this.logger.warn(`[alert] pools.detail_timeout_served_stale chain=${chainId} protocol=${protocol} ageMs=${ageMs}`);
      readPathMeter.staleServed('pool-detail', ageMs);
      if (meta) {
        meta.cache = 'stale';
        meta.noStore = true;
      }
      return { ...retained.value.detail, stale: true as const, dataAsOf: new Date(retained.dataAt).toISOString() };
    }
  }

  private async loadPool(chainId: number, protocol: string, poolId: string) {
    const pool = await this.pools.findPoolById(chainId, protocol, poolId);
    if (!pool) {
      throw new NotFoundException({ error: 'Pool not found', chainId, protocol, poolId });
    }
    const readAt = Date.now();
    const countsMeta: PoolCountsMeta = {};
    const priceMeta: { oldestLoadedAt?: number } = {};
    const [counts, prices] = await Promise.all([
      this.holderCounts(chainId, protocol, [poolId], countsMeta),
      this.pricesForPools([pool], priceMeta),
    ]);
    this.rank?.offerHolderCounts(chainId, protocol, [poolId], 'detail', this.positionsAccess);
    return {
      detail: {
        ...enrichPool(pool, prices),
        ...countFields(counts.get(poolId.toLowerCase())),
        ...poolRiskFields(pool, this.exclusionSetFor(chainId)),
      },
      /** The oldest input's load time: the cache entry's age starts there. */
      storedAt: Math.min(readAt, countsMeta.storedAt ?? Infinity, priceMeta.oldestLoadedAt ?? Infinity),
      /**
       * The oldest DATA time (load less replication lag) of the pool read and
       * its counts — a count kept past the budget makes the detail older than
       * the budget too, so the one `staleSince` test flags both. The leg
       * prices are not in it: their own cache bounds them (≤ 45 s) and their
       * store is re-priced every ~5 min anyway.
       */
      dataAt: Math.min(readAt - userReadLagMs(readAt), countsMeta.dataAt ?? Infinity),
    };
  }

  /**
   * The chain's ranked-list exclusion set, for the per-row `risk` flags —
   * synchronously, from memory (`leaderboardExclusions`): a request never
   * waits on it. Undefined before the chain's first build (no
   * `excluded-token` flag on that one answer) or on a spec double without it.
   */
  private exclusionSetFor(chainId: number): ReadonlySet<string> | undefined {
    const tokens = this.tokens as Partial<Pick<TokensRepository, 'leaderboardExclusions'>> | undefined;
    if (typeof tokens?.leaderboardExclusions !== 'function') return undefined;
    return exclusionSetOf(tokens.leaderboardExclusions(chainId)?.addresses);
  }

  private async countTask(query: PoolsLeaderboardQuery) {
    const plan = await this.pools.poolsPlan(query);
    const cap = this.config.leaderboardCountCap;
    return { key: plan.countKey, run: (): Promise<CountResult> => this.pools.countPoolsLeaderboard(plan, cap) };
  }

  private baseArgs(query: TopPoolsQueryDto) {
    return {
      protocol: query.protocol,
      sort: query.sort ?? 'tvl',
      minTvlUsd: query.minTvlUsd ?? 0,
      search: query.search,
      includeRisky: query.includeRisky ?? false,
      assetClass: query.assetClass,
    };
  }

  /** The shards a list request spans: the one asked for, or every enabled one. */
  private chainIdsFor(query: { chainId?: number; protocol: string }): number[] {
    if (query.chainId !== undefined) return [query.chainId];
    return this.config.enabledIntegrations
      .filter((integration) => integration.protocol === query.protocol)
      .map((integration) => integration.chainId);
  }

  /**
   * `priceUsd` per leg for a page of pools, grouped by chain because the
   * `tokens` collection is sharded per chain and a merged page can span
   * several — from `TokenPriceCache` (fresh 30 s, stale 15 s more, batched
   * single-flight secondary reads). It used to be an uncached `$in` on the
   * PRIMARY per chain per request, cache hits included. A pricing outage never
   * fails the response: an unpriced leg degrades to 0, as it always did.
   */
  private async pricesForPools(pools: Pool[], meta?: { oldestLoadedAt?: number }): Promise<Map<string, number>> {
    if (pools.length === 0) return new Map();
    const byChain = new Map<number, Set<string>>();
    for (const pool of pools) {
      let set = byChain.get(pool.chainId);
      if (!set) byChain.set(pool.chainId, (set = new Set()));
      set.add(pool.token0.address.toLowerCase());
      set.add(pool.token1.address.toLowerCase());
    }
    try {
      return await this.prices.prices(byChain, meta);
    } catch {
      return new Map();
    }
  }

  /**
   * Open-position + distinct-holder counts for a page of pools, one
   * aggregation per shard. A shard whose counts fail leaves its pools `null`
   * (`countsPending`), never the whole page a 5xx; counts served past their
   * stale age set `meta.dataAsOf`.
   */
  private async countsForPools(
    pools: Pool[],
    meta: PoolCountsMeta = {},
  ): Promise<Map<string, PoolPositionCounts | null>> {
    const byShard = new Map<string, { chainId: number; protocol: string; ids: string[] }>();
    for (const p of pools) {
      const key = `${p.chainId}:${p.protocol}`;
      const entry = byShard.get(key) ?? { chainId: p.chainId, protocol: p.protocol, ids: [] };
      entry.ids.push(p.poolId);
      byShard.set(key, entry);
    }
    const merged = new Map<string, PoolPositionCounts | null>();
    await Promise.all(
      [...byShard.values()].map(async ({ chainId, protocol, ids }) => {
        try {
          const counts = await this.holderCounts(chainId, protocol, ids, meta);
          for (const [poolId, c] of counts) merged.set(`${chainId}:${protocol}:${poolId}`, c);
          this.rank?.offerHolderCounts(chainId, protocol, ids, 'list', this.positionsAccess);
        } catch (err) {
          this.logger.warn(
            `[alert] pools.counts_failed chain=${chainId} pools=${ids.length} — served as null: ` +
              `${(err as Error)?.message ?? String(err)}`,
          );
          for (const id of ids) merged.set(`${chainId}:${protocol}:${id.toLowerCase()}`, null);
        }
      }),
    );
    return merged;
  }

  /**
   * Open-position / holder counts of `poolIds` on one shard: the rank engine's
   * (P-R R3, `serve` and servable — design §6.6) for every pool it can count
   * exactly, `countsByPoolIds` for the rest (and for everything in `off` /
   * `shadow`). Same map contract either way: lowercased poolId → counts,
   * absent = 0/0, `null` = still being counted (Mongo only). The engine's
   * counts are as old as its generation (`dataAt` = the feeder's confirm
   * time), flagged through `meta` past the staleness budget like any count.
   */
  private async holderCounts(
    chainId: number,
    protocol: string,
    poolIds: string[],
    meta: PoolCountsMeta,
  ): Promise<Map<string, PoolPositionCounts | null>> {
    const engine = this.rank?.holderCounts(chainId, protocol, poolIds);
    if (!engine) return this.positions.countsByPoolIds(chainId, protocol, poolIds, meta);
    const out = new Map<string, PoolPositionCounts | null>(engine.counts);
    meta.storedAt = Math.min(meta.storedAt ?? Infinity, engine.storedAt);
    meta.dataAt = Math.min(meta.dataAt ?? Infinity, engine.dataAt);
    if (staleSince(engine.dataAt, stalenessBudgetMs(this.config)) !== undefined) meta.dataAsOf = Math.min(meta.dataAsOf ?? Infinity, engine.dataAt);
    if (engine.fallback.length > 0) {
      for (const [poolId, c] of await this.positions.countsByPoolIds(chainId, protocol, engine.fallback, meta)) out.set(poolId, c);
    }
    return out;
  }

  /** chainId undefined = all-chains mode — only the protocol is asserted. */
  private assertSupported(chainId: number | undefined, protocol: string): void {
    if (chainId !== undefined && !this.config.isSupportedChain(chainId)) {
      throw new BadRequestException({ error: 'Unsupported chainId', chainId });
    }
    if (!this.config.isSupportedProtocol(protocol)) {
      throw new BadRequestException({ error: 'Unsupported protocol', protocol });
    }
  }
}

/**
 * The two count fields of a pool response: absent from the map = no open
 * positions (0/0); `null` = not known yet (its aggregation is running in the
 * background) — never a fabricated 0/0.
 */
function countFields(c: PoolPositionCounts | null | undefined): {
  positionsCount: number | null;
  holdersCount: number | null;
} {
  if (c === null) return { positionsCount: null, holdersCount: null };
  return { positionsCount: c?.positionsCount ?? 0, holdersCount: c?.holdersCount ?? 0 };
}

/**
 * The additive per-row `risk: { flags }` (2026-10-06; present only when a flag
 * applies — `security/token-identity.ts` `rowRisk`): a leg whose own symbol is
 * a major's spoof or a phishing link, a leg in the chain's exclusion set, or a
 * pool the Pools page itself treats as risky (`pricing.source` none or
 * `usedFallback` — exactly what the risky toggle hides). Ranked lists already
 * drop excluded legs and, with the toggle off, risky pools; SEARCH keeps both
 * (a searched $0 spam pool stays findable) and the flag is what labels it.
 */
function poolRiskFields(pool: Pool, excluded: ReadonlySet<string> | undefined): { risk?: ReturnType<typeof rowRisk> } {
  const riskyPool = pool.pricing?.source === 'none' || pool.pricing?.usedFallback === true;
  const risk = rowRisk(pool.chainId, [pool.token0, pool.token1], excluded, riskyPool);
  return risk ? { risk } : {};
}

// v4 dynamic-fee pools carry the sentinel fee 0x800000 (8388608); the real fee
// is set per-swap by a hook, so there's no static tier to show.
const DYNAMIC_FEE_FLAG = 0x800000;
// feeApr is derived from the v4 subgraph's `feesUSD`, which is known-unreliable
// (can read in the hundreds-of-thousands of %). Clamp at read time so stale
// docs render sanely without a re-sync.
const FEE_APR_DISPLAY_CAP = 100_000;


/**
 * `priceUsd` per (chainId, lowercased address).
 *
 * Pool documents carry no price of their own — prices live in the per-chain
 * `tokens` collection, which the positions path already reads. Without this the
 * pools response omitted `priceUsd` entirely, so anything multiplying by it (the
 * liquidity-histogram tooltip) produced NaN and rendered as "-".
 */
type TokenPrices = Map<string, number>;

function priceKey(chainId: number, address: string): string {
  return `${chainId}:${address.toLowerCase()}`;
}

function withPrice(chainId: number, token: Pool['token0'], prices: TokenPrices) {
  return {
    ...token,
    symbol: resolveTokenSymbol(chainId, token.address, token.symbol),
    priceUsd: prices.get(priceKey(chainId, token.address)) ?? 0,
    logoURI: resolveTokenLogo(chainId, token.address),
  };
}

function enrichPool(pool: Pool, prices: TokenPrices, rank?: number) {
  const isDynamicFee = pool.fee >= DYNAMIC_FEE_FLAG;
  const feeAprRaw = Number(pool.metrics?.feeApr) || 0;
  const metrics = {
    ...pool.metrics,
    feeApr: Math.max(-FEE_APR_DISPLAY_CAP, Math.min(FEE_APR_DISPLAY_CAP, feeAprRaw)),
  };
  return {
    ...(rank !== undefined ? { rank } : {}),
    poolId: pool.poolId,
    chainId: pool.chainId,
    protocol: pool.protocol,
    token0: withPrice(pool.chainId, pool.token0, prices),
    token1: withPrice(pool.chainId, pool.token1, prices),
    fee: pool.fee,
    isDynamicFee,
    // Additive, only on a hooked pool: `hooks` (lower-case address) and
    // `customAccounting` (the hook address sets a `*_RETURNS_DELTA` flag — it
    // can take or redirect value the swap events do not show).
    ...hookFields(pool.hooks),
    tickSpacing: pool.tickSpacing,
    currentTick: pool.currentTick,
    sqrtPriceX96: pool.sqrtPriceX96,
    liquidity: pool.liquidity,
    createdAtTimestamp: pool.createdAtTimestamp,
    metrics,
    pricing: pool.pricing,
    updatedAt: pool.updatedAt,
  };
}
