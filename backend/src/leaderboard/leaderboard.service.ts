import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ChartInputsDeadlineError, ChartInputsService } from '../charts/chart-inputs.service.js';
import { readPathMeter } from '../common/cache/read-path-meter.js';
import {
  combineCacheStatus,
  listWindowRows,
  staleSince,
  stalenessBudgetMs,
  type CacheStatus,
  type ReadMeta,
} from '../common/cache/swr-cache.js';
import { AppConfigService } from '../config/app-config.service.js';
import { resolveTokenLogo, resolveTokenSymbol } from '../constants/token-logos.js';
import { PoolsRepository } from '../database/pools.repository.js';
import { PositionTransactionsRepository } from '../database/position-transactions.repository.js';
import {
  DETAIL_FIELDS,
  DETAIL_PROJECTION,
  effectiveLeaderboardSort,
  leaderboardRowComparator,
  leaderboardSortSpec,
  PositionsRepository,
  type LeaderboardPlan,
} from '../database/positions.repository.js';
import { userReadLagMs } from '../database/replication-lag.js';
import { SyncRepository } from '../database/sync.repository.js';
import { TokensRepository } from '../database/token.repository.js';
import { applyServedClockOverlay, applyServedClockOverlayAll } from '../positions/served-clock-overlay.js';
import type { Position } from '../database/schemas/position.schema.js';
import { RankEngineService, type CachedRankAnswer, type PositionsAccess } from '../read-models/rank/rank-engine.service.js';
import { exclusionSetOf, rowRisk } from '../security/token-identity.js';
import { hookFields } from '../common/pool-hooks.js';
import { PoolHooksCache } from '../pools/pool-hooks-cache.js';
import { AdapterRegistryService } from '../subgraph/adapter-registry.service.js';
import { PositionFeeRefreshService } from '../sync/position-fee-refresh.service.js';
import { assessValuation } from '../valuation/valuation-guard.js';
import {
  LeaderboardCountService,
  resolveCountRoute,
  resolveListPagination,
  type CountResult,
  type ListCountResponse,
} from './count-cache.js';
import type { TopPositionsQueryDto } from './dto/top-positions-query.dto.js';

/** How a list read is served. */
export interface ListReadOptions {
  /**
   * `/v1`: wait this long for an uncached count, then answer a floor flagged
   * `totalCapped`. Omitted (`/api`): never wait — `totalPending` instead.
   */
  countWaitMs?: number;
  /** Filled with the cache status for the `X-Cache` header. */
  meta?: ReadMeta;
}

@Injectable()
export class LeaderboardService {
  private readonly logger = new Logger(LeaderboardService.name);
  private readonly counts: LeaderboardCountService;
  private readonly chartInputs: ChartInputsService;
  /** What the rank engine (P-R R3) reads through this service's repository. */
  private readonly access: PositionsAccess;
  /**
   * The hook of each pool a page's rows belong to, read from the pools
   * collection at serve time (`PoolHooksCache` explains why not on the
   * position document). Absent without a pools repository (a spec double).
   */
  private readonly hooks?: PoolHooksCache;

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(PositionsRepository) private readonly positions: PositionsRepository,
    @Inject(PositionTransactionsRepository)
    private readonly positionTransactions: PositionTransactionsRepository,
    @Inject(AdapterRegistryService)
    private readonly adapters: AdapterRegistryService,
    // APPENDED and optional: specs construct this service positionally.
    @Optional() @Inject(LeaderboardCountService) counts?: LeaderboardCountService,
    // APPENDED and optional (W6): the charts' transaction cache, shared so a
    // detail + charts pair performs one walk.
    @Optional() @Inject(ChartInputsService) chartInputs?: ChartInputsService,
    // APPENDED and optional: opening an active position queues an on-chain fee
    // re-read for the fee job's next tick (`markViewed` — in memory, no RPC).
    @Optional() @Inject(PositionFeeRefreshService) private readonly feeRefresh?: PositionFeeRefreshService,
    /**
     * The positions rank engine (Phase P-R R3), APPENDED and optional. With the
     * rank model `off` (the default) it is inert and every path below is today's.
     */
    @Optional() @Inject(RankEngineService) private readonly rank?: RankEngineService,
    /**
     * P2.3 read overlay (integrator I1), APPENDED and optional: the shard's
     * `lastCleanRefreshAt` (cached 30 s) for `served-clock-overlay.ts`. Read
     * only while `POSITIONS_WRITE_SKIP=on`; absent, the overlay still computes
     * `metrics.ageSeconds` and leaves the stored clocks alone.
     */
    @Optional() @Inject(SyncRepository) private readonly syncRepo?: SyncRepository,
    /**
     * APPENDED and optional (2026-10-06): the pools repository, for the rows'
     * `hooks` / `customAccounting` (one `$in` per shard per page, remembered —
     * `PoolHooksCache`). Absent (a spec double), rows carry no hook fields.
     */
    @Optional() @Inject(PoolsRepository) pools?: PoolsRepository,
    /**
     * APPENDED and optional (2026-10-06): the chain's exclusion set, read from
     * memory for the per-row `risk` flags (`positionRiskFields`). Absent (a
     * spec double), rows carry only the flags their own symbols and pool stamp
     * give.
     */
    @Optional() @Inject(TokensRepository) private readonly tokens?: TokensRepository,
  ) {
    this.counts = counts ?? new LeaderboardCountService();
    const hooksLoader = (pools as Partial<Pick<PoolsRepository, 'findHooksByPoolIds'>> | undefined)?.findHooksByPoolIds;
    if (typeof hooksLoader === 'function') {
      this.hooks = new PoolHooksCache((chainId, protocol, poolIds) => hooksLoader.call(pools, chainId, protocol, poolIds));
    }
    this.chartInputs = chartInputs ?? new ChartInputsService(config);
    this.access = {
      cast: (chainId, protocol, filter) => this.positions.castFilter(chainId, protocol, filter),
      rows: (chainId, protocol, positionIds, opts) => this.positions.findListRowsByIds(chainId, protocol, positionIds, opts),
      reference: (chainId, protocol, args) => this.positions.snapshotReference(chainId, protocol, args),
      poolCounts: (chainId, protocol, poolIds, args) => this.positions.snapshotPoolCounts(chainId, protocol, poolIds, args),
    };
  }

  /**
   * One leaderboard page. Served from the per-shard window caches and NEVER
   * waiting on a count — see `resolveListPagination` for how `total` is filled.
   *
   * All chains (`chainId` omitted): every enabled shard is read and a shard
   * that fails is DROPPED — the page is the merged order of the others, with
   * `partial: true` + `missingChains` (refunded on /v1, never cached). Only
   * when every shard fails does the request fail. A page deeper than the
   * windows is one streaming walk over every shard (`findLeaderboardDeep`).
   * Rows older than the staleness budget (a timeout fallback) are flagged
   * `stale: true` + `dataAsOf`.
   */
  async getTopPositions(query: TopPositionsQueryDto, options: ListReadOptions = {}) {
    this.assertSupported(query.chainId, query.protocol);

    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const baseArgs = this.baseArgs(query);

    const chainIds = this.chainIdsFor(query);
    let positions: Position[];
    let hasMore: boolean;
    let exactTotal: number | undefined;
    let cache: CacheStatus;
    let dataAsOf: number | undefined;
    let missingChains: number[] = [];
    let countTasks = (chains: number[]) => Promise.all(chains.map((chainId) => this.countTask({ ...baseArgs, chainId, page: 1, limit })));
    // Only in `serve` is the engine even asked; `off` / `shadow` run today's path untouched.
    const engine = this.rank?.mode() === 'serve' ? await this.engineList(query, page, limit, baseArgs, chainIds) : undefined;
    if (engine) {
      // Answered by the rank engine (P-R R3, `serve`): the same rows, order,
      // totals and flags the Mongo path below produces, without its reads.
      ({ positions, hasMore, cache, missingChains } = engine);
      exactTotal = engine.exactTotal;
      dataAsOf = engine.dataAsOf;
      if (engine.countTasks) {
        // One task per chain on the page, in `chainIds` order (= the caller's `countChains`),
        // counted by the engine, cached under the same keys as Mongo's.
        const tasks = engine.countTasks;
        countTasks = async () => tasks;
      }
      this.logPartial(engine.errors);
    } else if (query.chainId !== undefined) {
      const shard = await this.positions.findLeaderboard({
        ...baseArgs,
        chainId: query.chainId,
        page,
        limit,
      });
      ({ positions, hasMore, cache } = shard);
      exactTotal = shard.total;
      dataAsOf = shard.dataAsOf;
    } else if (listWindowRows(page, limit) === null) {
      // Deeper than the windows: ONE streaming k-way merge over every shard's
      // sort keys (no page × limit read per shard), from the nearest ladder rung.
      const deep = await this.positions.findLeaderboardDeep(
        chainIds.map((chainId) => ({ ...baseArgs, chainId, page, limit })),
      );
      ({ positions, hasMore, cache } = deep);
      exactTotal = deep.total;
      missingChains = deep.missingChains;
      dataAsOf = deep.dataAsOf;
      this.logPartial(deep.errors);
    } else {
      // All-chains scatter-gather: collections are sharded per (chainId,
      // protocol), so query every enabled integration's shard for its own top
      // `page × limit` rows (skip 0 — any prefix of the merged order can come
      // from a single shard), merge with a comparator replicating the Mongo
      // sort spec, then slice the requested page. Each shard read is one of
      // the same cached windows the single-chain views use.
      const settled = await Promise.allSettled(
        chainIds.map((chainId) =>
          this.positions.findLeaderboard({ ...baseArgs, chainId, page: 1, limit: page * limit }),
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
      exactTotal = shards.every((shard) => shard.total !== undefined)
        ? shards.reduce((sum, shard) => sum + (shard.total ?? 0), 0)
        : undefined;
      const stale = shards.flatMap((shard) => (shard.dataAsOf !== undefined ? [shard.dataAsOf] : []));
      dataAsOf = stale.length > 0 ? Math.min(...stale) : undefined;
      // The shard's own sort, replicated (field, direction, AND the positionId
      // tie-break's direction — it follows the primary on the nft sorts), then
      // chainId for cross-chain determinism on identical ids.
      const { field, direction, tieDirection } = leaderboardSortSpec(baseArgs.sort);
      const shardOrder = leaderboardRowComparator(field, direction, tieDirection);
      const merged = shards
        .flatMap((shard) => shard.positions)
        .sort((a, b) => shardOrder(a, b) || a.chainId - b.chainId);
      // Exact: every shard read one row past its top page × limit, so a row
      // beyond this page exists iff the merge holds more, or a shard had more.
      hasMore = merged.length > page * limit || shards.some((shard) => shard.hasMore);
      positions = merged.slice((page - 1) * limit, page * limit);
    }
    if (options.meta) {
      options.meta.cache = cache;
      if (missingChains.length > 0 || dataAsOf !== undefined) options.meta.noStore = true;
    }
    if (missingChains.length > 0) readPathMeter.partialServed('positions');

    // The hook of each row's pool, started now and awaited after the count so
    // it overlaps it (it never rejects and never waits past its own deadline).
    const hookedPools = this.hooksFor(positions);

    // The total describes the chains on the page: a dropped chain's rows are not in it.
    const countChains = chainIds.filter((chainId) => !missingChains.includes(chainId));
    const pagination = await resolveListPagination({
      page,
      limit,
      rowsOnPage: positions.length,
      hasMore,
      exactTotal,
      counts: this.counts,
      countWaitMs: options.countWaitMs,
      tasks: () => countTasks(countChains),
    });

    // P2.3: with skip `on`, unchanged rows are not rewritten, so their age and
    // "verified at" clocks are served from the overlay (per request, AFTER the
    // window cache and the rank engine — both paths converge here). Off /
    // shadow: the same array, untouched (today).
    const served = this.writeSkipOn() ? await this.servedClocks(positions) : positions;
    const sanitizedPositions = served.map((position) => withoutSubdocIds(sanitizeStoredPosition(position)));
    const hooksByPool = await hookedPools;

    const response = {
      positions: sanitizedPositions.map((position, index) => {
        return {
        rank: (page - 1) * limit + index + 1,
        positionId: position.positionId,
        tokenId: position.tokenId,
        chainId: position.chainId,
        protocol: position.protocol,
        owner: position.owner,
        poolId: position.poolId,
        token0: {
          ...position.token0,
          symbol: resolveTokenSymbol(position.chainId, position.token0.address, position.token0.symbol),
          logoURI: resolveTokenLogo(position.chainId, position.token0.address),
        },
        token1: {
          ...position.token1,
          symbol: resolveTokenSymbol(position.chainId, position.token1.address, position.token1.symbol),
          logoURI: resolveTokenLogo(position.chainId, position.token1.address),
        },
        fee: position.fee,
        tickSpacing: position.tickSpacing,
        tickLower: position.tickLower,
        tickUpper: position.tickUpper,
        currentTick: position.currentTick,
        liquidity: position.liquidity,
        isActive: position.isActive,
        createdAtTimestamp: position.createdAtTimestamp,
        closedAtTimestamp: position.closedAtTimestamp,
        amounts: position.amounts,
        metrics: position.metrics,
        poolStats: position.poolStats,
        pricing: position.pricing,
        // Per-position tx sync metadata (`txSyncStatus`, `txSyncedTransactionCount`,
        // `txLastSuccessAt`, `txFinalizedAt`) is no longer authoritative under
        // the cursor-walk sync path. UI gets accurate counts from the
        // transactions array on the position detail endpoint. Schema fields
        // remain for back-compat but are intentionally NOT exposed here.
        lastSyncedAt: position.lastSyncedAt,
        ...positionRiskFields(position, this.exclusionSetFor(position.chainId)),
        ...hookFields(hooksByPool.get(PoolHooksCache.key(position.chainId, position.protocol, position.poolId))),
        };
      }),
      pagination,
      // Additive, each only when it applies. `partial` + `missingChains`: an
      // all-chains page without the chains whose shard failed (refunded on
      // /v1 — `partial` is a DEGRADED_PAYLOAD_FLAG). `stale` + `dataAsOf`: rows
      // older than the staleness budget, served because the database timed out.
      ...(missingChains.length > 0 ? { partial: true as const, missingChains } : {}),
      ...(dataAsOf !== undefined ? { stale: true as const, dataAsOf: new Date(dataAsOf).toISOString() } : {}),
    };
    // Lane A (shadow AND serve): sampled, after the response, never altering it.
    this.offerShadow(chainIds, page, limit, baseArgs, 'list', engine?.answer);
    return response;
  }

  /**
   * The rank engine's answer for a list request (P-R R3), or undefined — then
   * the Mongo path answers, exactly as today. Only in `serve`, on the ramp's
   * share of requests, for a filter the engine compiles and shards it holds
   * ready. `exactTotal` reproduces when each Mongo path knows its total
   * without a count (design §6.4): the uncollated shapes (`pool`, `lookup`)
   * always on one chain and within the windows on all chains; every shape on a
   * deep page that ran past its end (`n ≤ skip + limit`, the exhausted walk);
   * never otherwise (the count contract answers).
   */
  private async engineList(
    query: TopPositionsQueryDto,
    page: number,
    limit: number,
    baseArgs: ReturnType<LeaderboardService['baseArgs']>,
    chainIds: number[],
  ): Promise<
    | {
        positions: Position[];
        hasMore: boolean;
        cache: CacheStatus;
        exactTotal?: number;
        missingChains: number[];
        errors: Array<{ chainId: number; error: unknown }>;
        dataAsOf?: number;
        countTasks?: Array<{ key: string; run: () => Promise<CountResult> }>;
        answer: CachedRankAnswer;
      }
    | undefined
  > {
    const rank = this.rank;
    if (!rank || chainIds.length === 0) return undefined;
    if (!rank.route(chainIds, query.protocol).serve) return undefined;
    let plans: LeaderboardPlan[];
    try {
      plans = await Promise.all(chainIds.map((chainId) => this.positions.leaderboardPlan({ ...baseArgs, chainId, page, limit })));
    } catch {
      return undefined;
    }
    const outcome = await rank.list({ plans, page, limit }, this.access);
    if (outcome.kind !== 'ok') return undefined;
    const skip = (page - 1) * limit;
    const deep = listWindowRows(page, limit) === null;
    const single = query.chainId !== undefined;
    const n = outcome.total;
    let exactTotal: number | undefined;
    if (!plans[0]!.collated) exactTotal = single || !deep || n <= skip + limit ? n : undefined;
    else exactTotal = deep && n <= skip + limit ? n : undefined;
    const dataAsOf = staleSince(outcome.dataAt, stalenessBudgetMs(this.config));
    if (dataAsOf !== undefined) readPathMeter.staleServed('positions', Date.now() - dataAsOf);
    const countPlans = plans.filter((plan) => !outcome.missingChains.includes(plan.chainId));
    const countTasks = rank.countTasks(countPlans, this.access, this.config.leaderboardCountCap, this.mongoCount);
    return {
      positions: outcome.positions,
      hasMore: outcome.hasMore,
      cache: outcome.cache,
      ...(exactTotal !== undefined ? { exactTotal } : {}),
      missingChains: outcome.missingChains,
      errors: outcome.errors,
      ...(dataAsOf !== undefined ? { dataAsOf } : {}),
      ...(countTasks ? { countTasks } : {}),
      answer: outcome.answer,
    };
  }

  /** Offer a request to the rank engine's lane A (a no-op unless the rank model is shadow / serve). */
  private offerShadow(
    chainIds: number[],
    page: number,
    limit: number,
    baseArgs: ReturnType<LeaderboardService['baseArgs']>,
    kind: 'list' | 'count',
    served?: CachedRankAnswer,
  ): void {
    const rank = this.rank;
    if (!rank || rank.mode() === 'off' || chainIds.length === 0) return;
    rank.offer(
      {
        plans: () => Promise.all(chainIds.map((chainId) => this.positions.leaderboardPlan({ ...baseArgs, chainId, page, limit }))),
        page,
        limit,
        kind,
        served,
      },
      this.access,
    );
  }

  /** One warn per partial all-chains read, naming each dropped chain and why. */
  private logPartial(errors: Array<{ chainId: number; error: unknown }>): void {
    if (errors.length === 0) return;
    this.logger.warn(
      `[alert] leaderboard.partial missing=${errors
        .map(({ chainId, error }) => `${chainId}(${(error as Error)?.message ?? String(error)})`)
        .join(',')} — served the other chains`,
    );
  }

  /**
   * `GET /api/top-positions/count`: the capped total for the same filters as
   * the list, summed across shards — waiting up to `COUNT_ROUTE_WAIT_MS` for
   * it (single-flight with any background count a list request already
   * started). Never a 5xx: a count still running, queued, out of read budget,
   * timed out or failed answers `{total: null, capped: false, pending: true}`
   * and the dashboard asks again.
   */
  async getTopPositionsCount(query: TopPositionsQueryDto, meta?: ReadMeta): Promise<ListCountResponse> {
    this.assertSupported(query.chainId, query.protocol);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const chainIds = this.chainIdsFor(query);
    const baseArgs = this.baseArgs(query);
    const rank = this.rank;
    if (rank && chainIds.length > 0 && rank.route(chainIds, query.protocol).serve) {
      // Counted by the rank engine (P-R R3, `serve`): the same capped totals,
      // the same /count contract, no Mongo count.
      try {
        const plans = await Promise.all(chainIds.map((chainId) => this.positions.leaderboardPlan({ ...baseArgs, chainId, page: 1, limit })));
        const tasks = rank.countTasks(plans, this.access, this.config.leaderboardCountCap, this.mongoCount);
        if (tasks) {
          const result = await resolveCountRoute({ route: 'positions', counts: this.counts, meta, tasks: async () => tasks });
          this.offerShadow(chainIds, 1, limit, baseArgs, 'count');
          return result;
        }
      } catch {
        // fall through to the Mongo path
      }
    }
    const result = await resolveCountRoute({
      route: 'positions',
      counts: this.counts,
      meta,
      tasks: () => Promise.all(chainIds.map((chainId) => this.countTask({ ...baseArgs, chainId, page: 1, limit }))),
    });
    this.offerShadow(chainIds, 1, limit, baseArgs, 'count');
    return result;
  }

  /**
   * A plan's Mongo count, metered (a count slot + the read budget) — what the
   * rank engine's count task falls back to when the engine refuses it at run
   * time, so the refusal is counted by Mongo, never stored as the key's failure.
   */
  private readonly mongoCount = (plan: LeaderboardPlan) => (): Promise<CountResult> =>
    this.counts.metered(plan.countKey, () => this.positions.countLeaderboard(plan, this.config.leaderboardCountCap));

  private async countTask(query: Parameters<PositionsRepository['leaderboardPlan']>[0]) {
    const plan = await this.positions.leaderboardPlan(query);
    const cap = this.config.leaderboardCountCap;
    return { key: plan.countKey, run: (): Promise<CountResult> => this.positions.countLeaderboard(plan, cap) };
  }

  private baseArgs(query: TopPositionsQueryDto) {
    return {
      protocol: query.protocol,
      // Closed tab + APR / fee APR / ROI is served as PnL (see the helper).
      sort: effectiveLeaderboardSort(query.status, query.sort),
      activeOnly: query.activeOnly,
      status: query.status,
      range: query.range,
      minValueUsd: query.minValueUsd,
      minPoolTvl: query.minPoolTvl,
      includeRisky: query.includeRisky,
      positionId: query.positionId,
      poolId: query.poolId,
      owner: query.owner,
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

  /** The detail read's projection (P2.3; `DETAIL_PROJECTION` unless skip is `on`). */
  private detailProjection(): Readonly<Record<string, 0 | 1>> {
    const repo = this.positions as Partial<Pick<PositionsRepository, 'detailProjection'>>;
    return typeof repo.detailProjection === 'function' ? repo.detailProjection() : DETAIL_PROJECTION;
  }

  /**
   * P2.3 read-time overlay (`served-clock-overlay.ts`, design §4.6): with
   * `POSITIONS_WRITE_SKIP=on`, `metrics.ageSeconds` is computed at `now` and an
   * active, clean row's `lastSyncedAt` / `pricing.pricedAt` follow its shard's
   * last clean refresh. Any other mode returns `rows` itself — byte-identical
   * to today. Never throws: a failed `lastCleanRefreshAt` read only skips the
   * time overlay for that shard.
   */
  private writeSkipOn(): boolean {
    return (this.config as unknown as { positionsWriteSkip?: string }).positionsWriteSkip === 'on';
  }

  private async servedClocks(rows: Position[]): Promise<Position[]> {
    const mode = (this.config as unknown as { positionsWriteSkip?: string }).positionsWriteSkip ?? 'off';
    if (mode !== 'on' || rows.length === 0) return rows;
    const nowMs = Date.now();
    const shards = [...new Set(rows.map((row) => `${row.chainId}:${row.protocol}`))];
    const floors = new Map<string, Date | undefined>();
    await Promise.all(
      shards.map(async (key) => {
        const [chainId, protocol] = [Number(key.slice(0, key.indexOf(':'))), key.slice(key.indexOf(':') + 1)];
        const at = await this.syncRepo?.lastCleanRefreshAt(chainId, protocol).catch(() => undefined);
        floors.set(key, at);
      }),
    );
    if (shards.length === 1) {
      return applyServedClockOverlayAll(rows, { mode, nowMs, lastCleanRefreshAt: floors.get(shards[0]!) });
    }
    return rows.map((row) =>
      applyServedClockOverlay(row, { mode, nowMs, lastCleanRefreshAt: floors.get(`${row.chainId}:${row.protocol}`) }),
    );
  }

  async getPosition(chainId: number, protocol: string, positionId: string, meta?: ReadMeta) {
    this.assertSupported(chainId, protocol);
    // `detailProjection()` = DETAIL_PROJECTION, plus `staleMisses` only while
    // POSITIONS_WRITE_SKIP=on (the overlay reads it; `toPositionDetail`'s
    // allow-list drops it).
    const read = await this.positions.findOneForRead(chainId, protocol, positionId, this.detailProjection());
    // No extra await unless skip is on: the default path keeps today's timing
    // exactly (a detail racing a charts request must still start its tx walk first).
    const position = read && this.writeSkipOn() ? (await this.servedClocks([read]))[0]! : read;
    if (!position) {
      throw new NotFoundException({ error: 'Position not found', chainId, protocol, positionId });
    }
    // Read from a secondary: as old as its replication lag. Past the staleness
    // budget the detail says so (`stale` + `dataAsOf`, no-store), like a list.
    const readAt = Date.now();
    const dataAsOf = staleSince(readAt - userReadLagMs(readAt), stalenessBudgetMs(this.config), readAt);
    if (dataAsOf !== undefined) {
      readPathMeter.staleServed('position-detail', readAt - dataAsOf);
      if (meta) meta.noStore = true;
    }
    // Somebody is looking at this position: have the fee job re-read its
    // uncollected fees on-chain on its next tick (5-min cooldown per position,
    // own per-tick quota). Synchronous and in-memory — this request never waits
    // on an RPC, and nothing about the response changes; a failure here must
    // never fail the detail read.
    if (position.isActive === true) {
      try {
        this.feeRefresh?.markViewed(chainId, protocol, String(position.positionId ?? positionId));
      } catch (err) {
        this.logger.warn(`positions.fee_view_mark_failed position=${positionId} err=${(err as Error)?.message ?? String(err)}`);
      }
    }
    // Aggregates-mode protocols don't persist transactions to Mongo (the
    // aggregate recompute bypasses tx-sync) — fetch the detail tx-list on-demand
    // from the indexer. Others read the Mongo tx collection as before.
    const adapter = this.adapters.resolve(protocol);
    const integration = this.config.getIntegration(chainId, protocol);
    let transactions: unknown[] = [];
    // Surfaced so the client can tell 'no transactions' from 'we could not load them'.
    let transactionsDegraded = false;
    let transactionsTruncated = false;
    // Only the newest page made it in time; the full history is loading into
    // the cache behind it (`ChartInputsService.walkBehindHead`).
    let transactionsPartial = false;
    if (integration && adapter.recomputeMode === 'aggregates' && adapter.fetchPositionTransactions) {
      // The tx list is a SUPPLEMENT to the position doc, which is already loaded
      // and holds every headline figure the detail view renders. An upstream
      // failure here (an indexer statement timeout, 502 mid-deploy) — or a walk
      // still running at the request deadline — must therefore degrade to an
      // empty list, the same way charts degrade to partial data, never 500 the
      // whole position and blank the page.
      try {
        // The charts' cache entry and single-flight load (keyed by the
        // position's cash-flow fingerprint): a detail + charts pair opened
        // together performs ONE walk, and a reopen performs none.
        // Waits at most `TX_WAIT_MS` (interactive): a busy position's full walk
        // no longer holds the response, it is served its newest page instead.
        const fetched = await this.chartInputs.positionTransactions(position, integration, adapter);
        transactionsTruncated = fetched.truncated === true;
        transactionsPartial = fetched.partial === true;
        // Indexed tx carry no USD. Value each on the HODL basis (current token
        // prices) + per-tx gas at the implied current ETH price — all from the
        // position doc, so no extra pricing calls. (Per-tx tx-time / vs-USD pricing
        // is the deferred historical-pricing piece.)
        const p0 = num(position.token0?.priceUsd);
        const p1 = num(position.token1?.priceUsd);
        const gasEth = num(position.amounts?.totalGasCostEth);
        const ethUsd = gasEth > 0 ? num(position.metrics?.totalGasCostUsd) / gasEth : 0;
        // An adapter can also report degradation WITHOUT throwing — e.g. it was
        // selected for a chain that has no source URL configured. That is still
        // "could not load", not "has none". A newest-page-only list is degraded
        // too: it is not the history, and `transactionsDegraded` is what the
        // /v1 refund and every existing client already key on.
        transactionsDegraded = fetched.degraded === true || transactionsPartial;
        if (transactionsPartial) {
          // Not an outage (no `[alert]`): the walk is running, the next open is
          // complete. A FAILED walk behind a head alerts in ChartInputsService.
          this.logger.log(
            `positions.tx_partial chain=${chainId} protocol=${protocol} position=${positionId} ` +
              `rows=${fetched.transactions.length} (newest page; the full history is loading in the background)`,
          );
        }
        transactions = fetched.transactions.map((tx) => ({
          ...tx,
          amount0PriceUsd: p0,
          amount1PriceUsd: p1,
          historicalValueUsd: Math.abs(num(tx.amount0)) * p0 + Math.abs(num(tx.amount1)) * p1,
          gasCostUsd: num(tx.gasCostEth) * ethUsd,
        }));
      } catch (err) {
        // A walk still running at the request deadline is NOT an outage: the
        // shared load carries on and fills the cache, so the next open is a
        // hit. Logged without `[alert]` so the alert keeps meaning "the
        // upstream failed" (seen under a heavy backfill, where Envio is slow).
        if (err instanceof ChartInputsDeadlineError) {
          this.logger.log(
            `positions.tx_fetch_late chain=${chainId} protocol=${protocol} position=${positionId} ` +
              `(still loading; cached for the next open)`,
          );
        } else {
          // `[alert]`-prefixed: this is the ONLY trace a degraded response leaves.
          // Turning the old 500 into a 200 also removed it from the error log and
          // from the 5xx column of the customer's usage breakdown, so without a
          // deliberate alert line an upstream outage now looks like healthy
          // traffic serving empty transaction lists.
          this.logger.warn(
            `[alert] positions.tx_fetch_degraded chain=${chainId} protocol=${protocol} ` +
              `position=${positionId} err=${(err as Error)?.message ?? String(err)}`,
          );
        }
        transactionsDegraded = true;
      }
    } else {
      transactions = await this.positionTransactions.findForPosition(chainId, protocol, positionId);
    }
    const detail = toPositionDetail(position, chainId, transactions, transactionsDegraded);
    // Additive, and each only when it applies: `transactionsTruncated` — the
    // walk hit its page cap, so the NEWEST transactions are not in the list;
    // `transactionsPartial` — the list is ONLY the newest page (≤ 1000), older
    // ones still loading. Both are absent otherwise. `risk`: an id lookup is
    // never excluded, so a flagged position is labelled instead.
    const hooksByPool = await this.hooksFor([position]);
    return {
      ...detail,
      ...positionRiskFields(position, this.exclusionSetFor(chainId)),
      ...hookFields(hooksByPool.get(PoolHooksCache.key(position.chainId, position.protocol, position.poolId))),
      ...(transactionsTruncated ? { transactionsTruncated: true as const } : {}),
      ...(transactionsPartial ? { transactionsPartial: true as const } : {}),
      ...(dataAsOf !== undefined ? { stale: true as const, dataAsOf: new Date(dataAsOf).toISOString() } : {}),
    };
  }

  /**
   * `PoolHooksCache.key(chainId, protocol, poolId)` → hook address for the
   * hooked pools among `rows`. Empty without a pools repository; never rejects.
   */
  private async hooksFor(
    rows: ReadonlyArray<{ chainId: number; protocol: string; poolId: string }>,
  ): Promise<Map<string, string>> {
    if (!this.hooks || rows.length === 0) return new Map();
    try {
      return await this.hooks.hooksFor(rows);
    } catch {
      return new Map();
    }
  }

  /**
   * The chain's ranked-list exclusion set, for the per-row `risk` flags —
   * synchronously, from memory (`leaderboardExclusions`); a request never
   * waits on it. Undefined before the chain's first build or without the
   * repository.
   */
  private exclusionSetFor(chainId: number): ReadonlySet<string> | undefined {
    const tokens = this.tokens as Partial<Pick<TokensRepository, 'leaderboardExclusions'>> | undefined;
    if (typeof tokens?.leaderboardExclusions !== 'function') return undefined;
    return exclusionSetOf(tokens.leaderboardExclusions(chainId)?.addresses);
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

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * The additive per-row `risk: { flags }` on position rows and detail
 * (2026-10-06; present only when a flag applies — `security/token-identity.ts`
 * `rowRisk`): a leg whose own symbol is a major's spoof or a phishing link, a
 * leg in the chain's exclusion set (reachable only through an id lookup — every
 * list shape drops those rows), or a pool the pools sync flags risky
 * (`poolStats.risky`, stamped while `RISKY_POOL_FILTER=on`).
 */
function positionRiskFields(
  position: Pick<Position, 'chainId' | 'token0' | 'token1' | 'poolStats'>,
  excluded: ReadonlySet<string> | undefined,
): { risk?: ReturnType<typeof rowRisk> } {
  // `poolStats.risky` is stamped by the Envio adapter only under
  // `RISKY_POOL_FILTER=on` and is not on the stored-document type yet, so it is
  // read through a cast: until something writes it, no position gets the flag.
  const poolRisky = (position.poolStats as { risky?: unknown } | null | undefined)?.risky === true;
  const risk = rowRisk(position.chainId, [position.token0, position.token1], excluded, poolRisky);
  return risk ? { risk } : {};
}

/** Subdocuments Mongoose stamps with an internal ObjectId `_id`. */
const SUBDOCS = ['token0', 'token1', 'amounts', 'metrics', 'poolStats', 'pricing'] as const;

/**
 * Drop the ObjectId `_id` Mongoose writes into each embedded subdocument (and
 * `metrics.usd`) — storage bookkeeping, never part of the API.
 */
export function withoutSubdocIds<T extends object>(position: T): T {
  const out = { ...position } as Record<string, unknown>;
  for (const key of SUBDOCS) {
    const sub = out[key];
    if (!sub || typeof sub !== 'object' || Array.isArray(sub)) continue;
    const { _id: _drop, ...rest } = sub as Record<string, unknown>;
    if (key === 'metrics' && rest.usd && typeof rest.usd === 'object') {
      const { _id: _dropUsd, ...usd } = rest.usd as Record<string, unknown>;
      rest.usd = usd;
    }
    out[key] = rest;
  }
  return out as T;
}

/**
 * The position DETAIL response: the stored document reduced to
 * `DETAIL_FIELDS` — so `rawSubgraph`, `_id`, `__v`, `tx*`, `rpcFees*`,
 * `staleMisses`, `lastVerifiedAt` and anything added to the schema later never
 * reach `/api` or the metered `/v1` detail — then sanitized exactly as before,
 * with token logos and the transaction list attached. The repository projection
 * already excludes those fields; this mapper is what guarantees it.
 */
export function toPositionDetail(
  position: Position,
  chainId: number,
  transactions: unknown[],
  transactionsDegraded: boolean,
) {
  const sanitized = withoutSubdocIds(sanitizeStoredPosition(position)) as unknown as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const field of DETAIL_FIELDS) {
    if (Object.hasOwn(sanitized, field)) picked[field] = sanitized[field];
  }
  const detail = picked as unknown as Position;
  return {
    ...detail,
    token0: { ...detail.token0, logoURI: resolveTokenLogo(chainId, detail.token0.address) },
    token1: { ...detail.token1, logoURI: resolveTokenLogo(chainId, detail.token1.address) },
    transactions,
    transactionsDegraded,
  };
}

function sanitizeStoredPosition(position: Position): Position {
  const valuation = assessValuation({
    underlyingValueUsd: position.metrics.underlyingValueUsd,
    poolTvlUsd: position.poolStats.tvlUsd,
    poolTvlUsdUntracked: position.poolStats.tvlUsdUntracked,
    poolVolumeUsd: position.poolStats.volumeUsd,
    poolTotalFeesUsd: position.poolStats.totalFeesUsd,
    hasPriceSource: position.pricing.source !== 'none',
    subgraphPriceable: position.metrics.isPriceable !== false,
  });

  if (valuation.accepted) return position;

  return {
    ...position,
    metrics: {
      ...position.metrics,
      apr: 0,
      aprExGas: 0,
      poolApr: 0,
      feeApr: 0,
      roi: 0,
      pnlUsd: 0,
      pnlEth: 0,
      pnlHodl: 0,
      poolPnlUsd: 0,
      divergenceLossUsd: 0,
      underlyingValueUsd: 0,
      nominalValueUsd: 0,
      pendingFeesUsd: 0,
      collectedFeesUsd: 0,
      totalFeesUsd: 0,
      totalGasCostUsd: 0,
      investedUsd: 0,
      depositedUsd: 0,
      withdrawnUsd: 0,
      diffUsd: 0,
      unclaimedRewardsUsd: 0,
      claimedRewardsUsd: 0,
      usd: { pnlUsd: 0, poolPnlUsd: 0, divergenceLossUsd: 0, apr: 0, aprExGas: 0, feeApr: 0, roi: 0 },
      isPriceable: false,
      performanceReady: false,
      performanceSource: 'invalid-valuation',
    },
    pricing: {
      ...position.pricing,
      source: 'none',
      usedFallback: true,
    },
  };
}
