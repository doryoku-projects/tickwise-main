import { createHash } from 'node:crypto';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { GraphQLClient } from 'graphql-request';
import { LIST_CACHE_JITTER, SwrCache, stableKey, type SwrTtl } from '../common/cache/swr-cache.js';
import { Semaphore } from '../common/semaphore.js';
import { AppConfigService } from '../config/app-config.service.js';
import type { IntegrationConfig } from '../config/integrations.config.js';
import {
  ENVIO_TX_SELECTION,
  EnvioAdapter,
  envioTxWhere,
  normalizeEnvioTransaction,
  oldestFirst,
  type IndexedTx,
} from '../subgraph/adapters/envio.adapter.js';
import { subgraphFetch } from '../subgraph/hyperindex/client.js';
import {
  currentIndexerContext,
  recordJoinWait,
  runInLane,
  type IndexerContext,
} from '../subgraph/hyperindex/indexer-context.js';
import type { FetchPositionTransactionsResult, NormalizedPositionTransaction } from '../subgraph/normalized-position.js';
import type { PositionAdapter } from '../subgraph/position-adapter.js';
// The shared, lane-aware policy: an interactive chart gets at most one retry
// inside its deadline.
import { requestWithRetry } from '../subgraph/request-retry.js';

/*
 * The indexer reads behind position detail and the position/pool charts.
 *
 * A chart used to cost at least five indexer requests in four serial rounds —
 * pool day data, then ticks, then two token-price walks, then the transaction
 * walk — the same five for every range, none of them cached, with detail walking
 * the same transaction history again in parallel. Here every input is a cache
 * entry of its own, and whatever is missing on a request goes out as ONE aliased
 * multi-root document: the translator turns several roots into a single
 * upstream query (`hyperindex/translate.ts`), so a cold open is one request and
 * one round trip, and a warm open or a range switch is none.
 *
 *   tx:{chain}:{protocol}:{position}:{fingerprint}  transaction list, fresh 24 h
 *   poolDay:{chain}:{protocol}:{pool}              pool day data, fresh 10 min
 *   tokenDay:{chain}:{protocol}:{token}            token day data, fresh 10 min
 *   ticks:{chain}:{protocol}:{pool}                ticks, fresh 60 s (pool charts share it)
 *   poolState:{chain}:{protocol}:{pool}            pool state, fresh 60 s
 *
 * The transaction key carries a fingerprint of the position's cash-flow fields,
 * so a deposit, withdrawal, collect or transfer moves it to a new key the moment
 * the stored position reflects it; the TTL only bounds a change the fingerprint
 * cannot see (an indexer correction), which is why it can be a day.
 *
 * THE TRANSACTION LIST IS READ NEWEST FIRST (2026-10-03). It used to be an
 * oldest-first walk of up to 100 serial pages that a user request waited on to
 * the end — and a request that JOINED somebody else's walk waited on it to its
 * own deadline (8 s − 250 ms) with no indexer calls of its own: 8 of the 12
 * slowest requests on the M10 rig were exactly that. Now the first read is the
 * position's NEWEST page (≤ 1000 rows). Short, it is the whole history. Full, it
 * is the head of a longer one: the full walk then runs in the background on the
 * `refresh` lane (at most `TX_WALK_CONCURRENCY` at once) and fills the cache,
 * while an interactive request waits for it at most `TX_WAIT_MS` and is then
 * answered with what is there — position detail with the newest page
 * (`transactionsPartial` + `transactionsDegraded`), charts without the position
 * series (`partial`, `missing: ['transactions']`: a running sum from creation
 * cannot start from the middle). Both clients ask once more a few seconds later.
 *
 * Day data is fetched as the pool's / token's NEWEST 1000 days, whatever the
 * range or the position's age. One entry then serves every position in the pool,
 * the pool charts and every range — and it is what keeps a cold open at one
 * request while the indexer lags: a window anchored to the newest day the
 * indexer holds can start long before "now − N days", and a fetch bounded by the
 * wall clock would need a second round trip to find it. (The old oldest-first
 * `first: 1000` walk also lost the NEWEST days past 1000; newest-first loses
 * only days older than that.)
 *
 * Loads are single-flight per key, so a detail request and a charts request for
 * the same position, arriving together, perform one transaction walk. A miss
 * still loading when the request's deadline answers keeps going and lands in the
 * cache for the next open. Time a request spends waiting on a load ANOTHER
 * request started is recorded apart from its own indexer time
 * (`recordJoinWait` → `Server-Timing: indexer-join`, `joined=` on `[slow]`).
 */

export interface PoolDayRow {
  date: number;
  tick: string | null;
  token0Price: string;
  token1Price: string;
  open: string;
  high: string;
  low: string;
  close: string;
  tvlUSD: string;
  volumeUSD: string;
  feesUSD: string;
}
export interface TokenDayRow {
  date: number;
  priceUSD: string;
}
export interface TickRow {
  tickIdx: string;
  liquidityGross: string;
  liquidityNet: string;
  price0: string;
  price1: string;
}
export interface PoolStateRow {
  tick: string | null;
  sqrtPrice: string;
  tickSpacing: string;
  token0: { decimals: string };
  token1: { decimals: string };
}

/** A pool's or token's day data: its newest ≤1000 days, oldest first. */
export interface DaySeries<R> {
  rows: R[];
  /** The fetch hit the 1000-row cap: days older than `rows[0]` exist and are not here. */
  truncated: boolean;
}

export interface PositionTransactions {
  transactions: NormalizedPositionTransaction[];
  /** Not retrieved (the adapter has no source) — never "this position has none". */
  degraded?: boolean;
  /** The walk stopped at its page cap; the NEWEST transactions may be missing. */
  truncated?: boolean;
  /**
   * Only the NEWEST page (oldest first, ≤ 1000 rows): the full history is still
   * loading in the background, or its walk failed. Never stored.
   */
  partial?: boolean;
}

/** The names a partial response lists in `missing`. */
export type ChartInput = 'poolDayData' | 'ticks' | 'token0DayData' | 'token1DayData' | 'poolState' | 'transactions';

export interface PositionChartInputs {
  poolDay?: DaySeries<PoolDayRow>;
  ticks?: TickRow[];
  token0Day?: DaySeries<TokenDayRow>;
  token1Day?: DaySeries<TokenDayRow>;
  transactions?: PositionTransactions;
  /** Inputs asked for and not here: failed upstream, or not ready by the request deadline. */
  missing: ChartInput[];
}

export interface PoolChartInputs {
  poolState?: PoolStateRow | null;
  poolDay?: DaySeries<PoolDayRow>;
  ticks?: TickRow[];
  missing: ChartInput[];
}

/** What the input builders and the fingerprint read off a stored position. */
export interface ChartPositionRef {
  chainId?: number;
  protocol?: string;
  positionId: string;
  poolId?: string;
  owner?: string;
  isActive?: boolean;
  liquidity?: unknown;
  token0?: { address?: string };
  token1?: { address?: string };
  amounts?: {
    depositedToken0?: unknown;
    depositedToken1?: unknown;
    withdrawnToken0?: unknown;
    withdrawnToken1?: unknown;
    totalFeesCollected0?: unknown;
    totalFeesCollected1?: unknown;
  };
}

/**
 * Raised by `positionTransactions` when nothing is ready by its deadline — not
 * the full list, and not even the newest page.
 */
export class ChartInputsDeadlineError extends Error {
  constructor(readonly missing: ChartInput[]) {
    super(`not ready by the request deadline: ${missing.join(', ')}`);
    this.name = 'ChartInputsDeadlineError';
  }
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/**
 * A day (it was 30 min). The key moves with the cash-flow fingerprint, so a
 * longer TTL cannot serve a list that misses a deposit, withdrawal, collect or
 * transfer the stored position already shows; it only stops re-walking an
 * unchanged history every half hour. Day data and live state have no
 * fingerprint, so their TTL IS their freshness. They keep their own TTLs —
 * 10 min / 30 min for day data, 60 s / 3 min for ticks and pool state — and do
 * NOT follow the lists' 45 s staleness budget (the user's accepted trade-off is
 * about LISTS). Tying them to it (fresh 15 s / stale 30 s, 2026-10-03) made
 * every chart re-read the indexer every ~20 s; on the M10 rig at 200 users
 * charts went from p50 7 ms / p99 1.9 s to p50 570 ms / p99 7.76 s (the
 * request deadline), with the indexer's 1,000/min budget the bottleneck.
 */
const TX_TTL: SwrTtl = { freshMs: 24 * HOUR, staleMs: 48 * HOUR };
const DAY_TTL: SwrTtl = { freshMs: 10 * MINUTE, staleMs: 30 * MINUTE };
const LIVE_TTL: SwrTtl = { freshMs: 60_000, staleMs: 3 * MINUTE };
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
/** Retention past the stale age for day data and live state: what a failed reload serves meanwhile. */
const CHART_FALLBACK_MS = 30 * MINUTE;

/** The dialect's page cap (`MAX_FIRST`), and so the size of every read here. */
const PAGE_ROWS = 1000;
/**
 * Transaction pages the full walk reads at most: 100k transactions. The walk is
 * oldest-first, so a capped list is missing its NEWEST rows; it comes back
 * `truncated`. (It used to be unbounded in practice — the adapter ignored
 * `maxPages` and stopped only at 1000 pages.)
 */
const TX_MAX_PAGES = 100;
/** Answer this long before the request's indexer deadline: room to compute and serialize. */
const DEADLINE_MARGIN_MS = 250;
/**
 * The most an interactive request waits for a transaction list: its own load or
 * one it joined. Past it, detail is answered with the newest page and charts
 * without the position series, and the load carries on into the cache. Never
 * later than the request's own deadline.
 */
export const TX_WAIT_MS = 1_500;
/**
 * Full transaction walks running at once, process-wide. A busy position is up
 * to 100 serial pages; a burst of opens must not turn into a burst of walks
 * against the shared indexer budget. Further walks queue (FIFO) — their heads
 * are already being served.
 */
export const TX_WALK_CONCURRENCY = 4;

/** Per-input deadlines of one request (epoch ms), or none outside an interactive request. */
interface InputDeadlines {
  /** Every input: the request's indexer deadline less the answer margin. */
  request?: number;
  /** The transaction list: `TX_WAIT_MS` from now, never past `request`. */
  transactions?: number;
}

const POOL_DAY_FIELDS = 'date tick token0Price token1Price open high low close tvlUSD volumeUSD feesUSD';

/** One input of a request: its cache entry, and the two ways of fetching it. */
export interface InputSpec<T> {
  readonly input: ChartInput;
  readonly key: string;
  readonly ttl: SwrTtl;
  /** This input's root in a combined document; absent when it can only be fetched alone. */
  readonly root?: RootSpec<T>;
  /** The input on its own: the path for a lone input, and the fallback when a combined request fails. */
  alone(client: GraphQLClient): Promise<T>;
  readonly shouldStore?: (value: T) => boolean;
}

export interface RootSpec<T> {
  /** The aliased root selection; its variables are named `$<alias>…`. */
  readonly text: string;
  readonly variables: ReadonlyArray<{ readonly name: string; readonly type: string; readonly value: unknown }>;
  read(data: Record<string, unknown>): Promise<T> | T;
}

export interface Waiting {
  readonly spec: InputSpec<unknown>;
  resolve(value: unknown): void;
  reject(err: unknown): void;
}

type Outcome = { ok: true; value: unknown } | { ok: false; err: unknown };

interface Resolved {
  values: Map<ChartInput, unknown>;
  errors: Map<ChartInput, unknown>;
  missing: ChartInput[];
}

@Injectable()
export class ChartInputsService {
  private readonly logger = new Logger(ChartInputsService.name);
  private readonly cache: SwrCache<unknown>;
  /**
   * The newest page of every transaction load whose full walk is still running,
   * by cache key — what a request answers with when its transaction deadline
   * passes. Set before the walk starts and deleted when it ends, so at any
   * moment a key has a head here, a value in the cache, or a failed load.
   */
  private readonly txHeads = new Map<string, PositionTransactions>();
  private readonly txWalks = new Semaphore(TX_WALK_CONCURRENCY);
  /** `TX_WAIT_MS`; a test seam, so a spec need not sleep 1.5 s. */
  protected readonly txWaitMs: number = TX_WAIT_MS;

  constructor(@Optional() @Inject(AppConfigService) config?: AppConfigService) {
    const maxBytes = typeof config?.chartCacheMaxBytes === 'number' ? config.chartCacheMaxBytes : DEFAULT_MAX_BYTES;
    this.cache = new SwrCache<unknown>({
      name: 'chart-inputs',
      maxBytes,
      // Every input passes its own TTL; this is only the type's default.
      ...LIVE_TTL,
      jitter: LIST_CACHE_JITTER,
      // A reload that fails serves the last value for this long (the TTL
      // used to double as this retention; at 30 s it no longer can).
      fallbackMs: CHART_FALLBACK_MS,
      // A stale open revalidates several inputs at once (one combined request).
      maxBackgroundRefreshes: 16,
      onBackgroundError: (key, err) =>
        this.logger.warn(`chart input revalidation failed for ${key}: ${message(err)}`),
    });
  }

  /** Everything a position chart reads from the indexer. */
  async positionInputs(
    position: ChartPositionRef,
    integration: IntegrationConfig,
    adapter: PositionAdapter,
  ): Promise<PositionChartInputs> {
    const scope = scopeOf(integration);
    const pool = String(position.poolId ?? '').toLowerCase();
    const specs: InputSpec<unknown>[] = [
      poolDaySpec(scope, pool, DAY_TTL),
      ticksSpec(scope, pool, LIVE_TTL),
    ] as InputSpec<unknown>[];
    const token0 = String(position.token0?.address ?? '').toLowerCase();
    const token1 = String(position.token1?.address ?? '').toLowerCase();
    // No address, no request — the series then prices that leg off the pool ratio.
    if (token0) specs.push(tokenDaySpec(scope, token0, 'token0DayData', 't0', DAY_TTL) as InputSpec<unknown>);
    if (token1) specs.push(tokenDaySpec(scope, token1, 'token1DayData', 't1', DAY_TTL) as InputSpec<unknown>);
    const tx = this.transactionsSpec(position, integration, adapter);
    if (tx) specs.push(tx as InputSpec<unknown>);

    const { values, missing } = await this.resolve(integration, specs, this.deadlines());
    let transactions = values.get('transactions') as PositionTransactions | undefined;
    // Only the newest page: the position series is a running sum from the
    // position's FIRST transaction, so a list without its start would draw a
    // confidently wrong curve. Left out and listed missing; the client asks
    // again once the background walk has filled the cache.
    if (transactions?.partial) {
      transactions = undefined;
      missing.push('transactions');
    }
    return {
      poolDay: values.get('poolDayData') as DaySeries<PoolDayRow> | undefined,
      ticks: values.get('ticks') as TickRow[] | undefined,
      token0Day: values.get('token0DayData') as DaySeries<TokenDayRow> | undefined,
      token1Day: values.get('token1DayData') as DaySeries<TokenDayRow> | undefined,
      transactions,
      missing,
    };
  }

  /** Everything a pool chart reads from the indexer. */
  async poolInputs(integration: IntegrationConfig, poolId: string): Promise<PoolChartInputs> {
    const scope = scopeOf(integration);
    const pool = poolId.toLowerCase();
    const specs = [
      poolStateSpec(scope, pool, LIVE_TTL),
      poolDaySpec(scope, pool, DAY_TTL),
      ticksSpec(scope, pool, LIVE_TTL),
    ] as InputSpec<unknown>[];
    const { values, missing } = await this.resolve(integration, specs, this.deadlines());
    return {
      poolState: values.get('poolState') as PoolStateRow | null | undefined,
      poolDay: values.get('poolDayData') as DaySeries<PoolDayRow> | undefined,
      ticks: values.get('ticks') as TickRow[] | undefined,
      missing,
    };
  }

  /**
   * The position's transaction list for position DETAIL — the same cache entry
   * and the same single-flight load as the charts, so a detail request and a
   * charts request arriving together perform one walk. An interactive request
   * waits for it at most `TX_WAIT_MS`; past that it gets the newest page,
   * flagged `partial`, when the load has one. Throws the upstream error when the
   * load failed, or `ChartInputsDeadlineError` when not even the newest page is
   * back (either way the load keeps going and warms the cache).
   */
  async positionTransactions(
    position: ChartPositionRef,
    integration: IntegrationConfig,
    adapter: PositionAdapter,
  ): Promise<PositionTransactions> {
    const spec = this.transactionsSpec(position, integration, adapter);
    if (!spec) return { transactions: [], degraded: true };
    const { values, errors } = await this.resolve(integration, [spec as InputSpec<unknown>], this.deadlines());
    if (values.has('transactions')) return values.get('transactions') as PositionTransactions;
    if (errors.has('transactions')) throw errors.get('transactions');
    throw new ChartInputsDeadlineError(['transactions']);
  }

  /** The client every chart input is read through. Overridable as a test seam. */
  protected clientFor(integration: IntegrationConfig): GraphQLClient {
    return new GraphQLClient(integration.subgraphUrl as string, subgraphFetch(integration));
  }

  /** When an interactive request must answer with what it has; none outside one. */
  private deadlines(): InputDeadlines {
    const ctx = currentIndexerContext();
    if (ctx.lane !== 'interactive' || ctx.deadlineAt === undefined) return {};
    const request = ctx.deadlineAt - DEADLINE_MARGIN_MS;
    return { request, transactions: Math.min(request, Date.now() + this.txWaitMs) };
  }

  private transactionsSpec(
    position: ChartPositionRef,
    integration: IntegrationConfig,
    adapter: PositionAdapter,
  ): InputSpec<PositionTransactions> | undefined {
    if (!adapter.fetchPositionTransactions) return undefined;
    const fetchTransactions = adapter.fetchPositionTransactions.bind(adapter);
    const positionId = String(position.positionId);
    const key = `tx:${scopeOf(integration)}:${positionId}:${positionHistoryFingerprint(position)}`;
    const read = (maxPages: number, newestFirst?: true) =>
      fetchTransactions({ integration, positionIds: [positionId], cursorTimestamp: 0, pageSize: PAGE_ROWS, maxPages, newestFirst });
    // The full history, oldest first: what the cache keeps.
    const fullWalk = async () => toTransactions(await read(TX_MAX_PAGES));
    // A list that could not be retrieved, or only its newest page, must not be
    // stored as the history.
    const shouldStore = (value: PositionTransactions) => value.degraded !== true && value.partial !== true;

    // Only the Envio adapter reads newest-first, and only its rows can ride in
    // the combined document: its query reads the same `subgraphUrl` this service
    // does, and its normalizer is exported, so a row read here is exactly the
    // row the adapter would return. Any other adapter is walked whole, as before.
    if (!(adapter instanceof EnvioAdapter)) {
      return { input: 'transactions', key, ttl: TX_TTL, alone: fullWalk, shouldStore };
    }

    // The newest page decides: short, it IS the history; full, it is the head of
    // a longer one, served while the full walk runs behind it.
    const fromHead = (head: NormalizedPositionTransaction[], more: boolean) =>
      more ? this.walkBehindHead(key, integration, positionId, head, fullWalk) : { transactions: head };
    return {
      input: 'transactions',
      key,
      ttl: TX_TTL,
      root: {
        text: `tx: positionTransactions(where: $txWhere, orderBy: timestamp, orderDirection: desc, first: ${PAGE_ROWS}) { ${ENVIO_TX_SELECTION} }`,
        variables: [
          { name: 'txWhere', type: 'PositionTransaction_filter', value: envioTxWhere(integration, [positionId]) },
        ],
        read: (data) => {
          const rows = (data.tx as IndexedTx[] | null | undefined) ?? [];
          // Same order as the ascending walk, ties included (`oldestFirst`).
          const head = oldestFirst(rows.map((raw) => normalizeEnvioTransaction(raw, integration)));
          return fromHead(head, rows.length >= PAGE_ROWS);
        },
      },
      alone: async () => {
        const head = await read(1, true);
        return head.degraded ? toTransactions(head) : fromHead(head.transactions, head.truncated === true);
      },
      shouldStore,
    };
  }

  /**
   * A newest page that is not the whole history. Published (`txHeads`) for the
   * requests that cannot wait, then the full walk runs on the `refresh` lane —
   * below every user request, never carrying a caller's stats, signal or
   * deadline, at most `TX_WALK_CONCURRENCY` at once — and its list is the
   * load's value, which the cache stores. A walk that FAILS resolves the load
   * with the head instead, flagged `partial`: the waiters get the newest page,
   * nothing is stored, and the next open walks again.
   */
  private async walkBehindHead(
    key: string,
    integration: IntegrationConfig,
    positionId: string,
    head: NormalizedPositionTransaction[],
    fullWalk: () => Promise<PositionTransactions>,
  ): Promise<PositionTransactions> {
    const partial: PositionTransactions = { transactions: head, partial: true };
    this.txHeads.set(key, partial);
    const walkCtx: IndexerContext = { lane: 'refresh', job: 'chart-inputs-tx-walk', chainId: integration.chainId };
    try {
      return await this.txWalks.run(() => runInLane(walkCtx, fullWalk));
    } catch (err) {
      this.logger.warn(
        `[alert] chart_inputs.tx_walk_failed chain=${integration.chainId} protocol=${integration.protocol} ` +
          `position=${positionId} served=newest ${head.length} err=${message(err)}`,
      );
      return partial;
    } finally {
      this.txHeads.delete(key);
    }
  }

  /**
   * Fresh entries are served; stale ones are served and revalidated in the
   * background; everything else is loaded — the missing inputs of this request
   * together, in one combined document. Returns what is ready by each input's
   * deadline (`InputDeadlines`).
   */
  private async resolve(
    integration: IntegrationConfig,
    specs: InputSpec<unknown>[],
    deadlines: InputDeadlines,
  ): Promise<Resolved> {
    const ctx = currentIndexerContext();
    const client = this.clientFor(integration);
    // A load outlives the response that started it (a miss still in flight at
    // the deadline should land in the cache for the next open), and it is SHARED:
    // any request for the same key joins it through single-flight. So it runs
    // without the starting request's deadline AND without its hang-up signal —
    // one client closing a modal must not fail the load another request (or a
    // /v1 caller) is waiting on, nor stop the per-input fallback below
    // (`IndexingStatusService` refreshes in its own lane for the same reason).
    // The gateway's own per-call timeout still bounds every fetch it makes.
    const loadCtx: IndexerContext = { lane: ctx.lane, job: ctx.job, chainId: ctx.chainId, stats: ctx.stats };
    // A revalidation nobody is waiting on, below every user request.
    const revalidateCtx: IndexerContext = {
      lane: 'refresh',
      job: 'chart-inputs-revalidate',
      chainId: integration.chainId,
    };
    const foreground = new InputBatch((items) => runInLane(loadCtx, () => this.send(client, items)));
    const background = new InputBatch((items) => runInLane(revalidateCtx, () => this.send(client, items)));

    const outcomes = new Map<ChartInput, Pending>();
    // Loads somebody else started, each stamped when it settles: the wait on
    // them is reported apart from this request's own indexer time.
    const joined: Array<{ settledAt?: number }> = [];
    const startedAt = performance.now();
    for (const spec of specs) {
      const options = { ttl: spec.ttl, shouldStore: spec.shouldStore };
      const deadlineAt = spec.input === 'transactions' ? deadlines.transactions : deadlines.request;
      const cached = this.cache.peek(spec.key);
      if (cached) {
        if (cached.status === 'stale') this.cache.refreshInBackground(spec.key, () => background.add(spec), options);
        outcomes.set(spec.input, { outcome: Promise.resolve({ ok: true, value: cached.value }), deadlineAt });
        continue;
      }
      // Single-flight: a key already loading (a parallel detail or chart request)
      // is joined, and its loader — `add` — is never called for this request.
      // `refresh` calls the loader synchronously when it starts a load, which is
      // how a join is told apart.
      let started = false;
      const outcome = this.cache
        .refresh(
          spec.key,
          () => {
            started = true;
            return foreground.add(spec);
          },
          options,
        )
        .then(
          (value): Outcome => ({ ok: true, value }),
          (err): Outcome => ({ ok: false, err }),
        );
      if (!started) {
        const mark: { settledAt?: number } = {};
        void outcome.then(() => {
          mark.settledAt = performance.now();
        });
        joined.push(mark);
      }
      outcomes.set(spec.input, { outcome, deadlineAt });
    }
    foreground.flush();
    background.flush();

    const settled = await settleBy(outcomes);
    if (joined.length > 0) {
      // Wall time, not a sum: joined loads are waited on together.
      const endedAt = performance.now();
      const waited = Math.max(...joined.map((mark) => Math.min(mark.settledAt ?? endedAt, endedAt))) - startedAt;
      recordJoinWait(ctx, waited, joined.length);
    }
    const values = new Map<ChartInput, unknown>();
    const errors = new Map<ChartInput, unknown>();
    const missing: ChartInput[] = [];
    for (const spec of specs) {
      const outcome = settled.get(spec.input);
      if (outcome?.ok) {
        values.set(spec.input, outcome.value);
        continue;
      }
      if (outcome) errors.set(spec.input, outcome.err);
      // An entry past its stale age is still retained for a while: older data
      // beats an empty chart section. (A complete list under the same
      // fingerprint also beats the newest page below.)
      const retained = this.cache.peekFallback(spec.key);
      if (retained !== undefined) {
        values.set(spec.input, retained);
        continue;
      }
      // A transaction load whose full walk is still running: its newest page.
      const head = this.txHeads.get(spec.key);
      if (head) {
        values.set(spec.input, head);
        continue;
      }
      missing.push(spec.input);
    }
    // One line per open, not one per input: a rate-limited open fails them all.
    if (errors.size > 0) {
      const first = errors.values().next().value;
      this.logger.warn(
        `chart inputs failed chain=${integration.chainId} protocol=${integration.protocol} ` +
          `inputs=${[...errors.keys()].join(',')} served=${missing.length === 0 ? 'all' : `missing ${missing.join(',')}`} ` +
          `err=${message(first)}`,
      );
    }
    return { values, errors, missing };
  }

  /**
   * One combined document for every input that can ride in one, each of the
   * rest alone. A combined request that fails is retried input by input (one
   * bad root must not blank the whole chart) — except on a rate limit, where
   * more requests only dig deeper.
   */
  private async send(client: GraphQLClient, items: Waiting[]): Promise<void> {
    const combinable = items.filter((item) => item.spec.root !== undefined);
    if (combinable.length <= 1) {
      for (const item of items) settle(item, item.spec.alone(client));
      return;
    }
    for (const item of items) if (item.spec.root === undefined) settle(item, item.spec.alone(client));

    const document = combinedDocument(combinable.map((item) => item.spec.root!));
    let data: Record<string, unknown>;
    try {
      data = await requestWithRetry<Record<string, unknown>>(client, document.query, document.variables);
    } catch (err) {
      if (!worthSplitting(err)) {
        for (const item of combinable) item.reject(err);
        return;
      }
      this.logger.warn(
        `chart inputs: combined request failed (${message(err)}); fetching ${combinable.length} inputs one by one`,
      );
      for (const item of combinable) settle(item, item.spec.alone(client));
      return;
    }
    for (const item of combinable) settle(item, Promise.resolve().then(() => item.spec.root!.read(data)));
  }
}

/**
 * The position's cash-flow fingerprint: anything that adds, removes or moves a
 * transaction changes at least one of these fields on the stored position.
 */
export function positionHistoryFingerprint(position: ChartPositionRef): string {
  const amounts = position.amounts ?? {};
  const material = [
    position.liquidity,
    position.isActive,
    typeof position.owner === 'string' ? position.owner.toLowerCase() : position.owner,
    amounts.depositedToken0,
    amounts.depositedToken1,
    amounts.withdrawnToken0,
    amounts.withdrawnToken1,
    amounts.totalFeesCollected0,
    amounts.totalFeesCollected1,
  ].map((value) =>
    value === undefined || value === null ? null : typeof value === 'boolean' ? value : String(value),
  );
  return createHash('sha1').update(stableKey(material)).digest('hex');
}

/** The aliased multi-root document for a set of roots. */
export function combinedDocument(roots: ReadonlyArray<RootSpec<unknown>>): {
  query: string;
  variables: Record<string, unknown>;
} {
  const declarations: string[] = [];
  const variables: Record<string, unknown> = {};
  for (const root of roots) {
    for (const variable of root.variables) {
      declarations.push(`$${variable.name}: ${variable.type}`);
      variables[variable.name] = variable.value;
    }
  }
  const header = declarations.length ? `(${declarations.join(', ')})` : '';
  return { query: `query ChartInputs${header} {\n  ${roots.map((root) => root.text).join('\n  ')}\n}`, variables };
}

function scopeOf(integration: Pick<IntegrationConfig, 'chainId' | 'protocol'>): string {
  return `${integration.chainId}:${integration.protocol}`;
}

/** A root fetched on its own: the same selection, in a document of its own. */
function aloneVia<T>(root: RootSpec<T>): (client: GraphQLClient) => Promise<T> {
  return async (client) => {
    const document = combinedDocument([root as RootSpec<unknown>]);
    const data = await requestWithRetry<Record<string, unknown>>(client, document.query, document.variables);
    return root.read(data);
  };
}

function poolDaySpec(scope: string, pool: string, ttl: SwrTtl): InputSpec<DaySeries<PoolDayRow>> {
  // Newest first, so the 1000-row cap drops the OLDEST days rather than today.
  const root: RootSpec<DaySeries<PoolDayRow>> = {
    text: `pd: poolDayDatas(where: { pool: $pdPool }, orderBy: date, orderDirection: desc, first: ${PAGE_ROWS}) { ${POOL_DAY_FIELDS} }`,
    variables: [{ name: 'pdPool', type: 'String!', value: pool }],
    read: (data) => daySeries(data.pd as PoolDayRow[] | null | undefined),
  };
  return { input: 'poolDayData', key: `poolDay:${scope}:${pool}`, ttl, root, alone: aloneVia(root) };
}

function tokenDaySpec(
  scope: string,
  token: string,
  input: 'token0DayData' | 'token1DayData',
  alias: 't0' | 't1',
  ttl: SwrTtl,
): InputSpec<DaySeries<TokenDayRow>> {
  const root: RootSpec<DaySeries<TokenDayRow>> = {
    text: `${alias}: tokenDayDatas(where: { token: $${alias}Token }, orderBy: date, orderDirection: desc, first: ${PAGE_ROWS}) { date priceUSD }`,
    variables: [{ name: `${alias}Token`, type: 'String!', value: token }],
    read: (data) => daySeries(data[alias] as TokenDayRow[] | null | undefined),
  };
  return { input, key: `tokenDay:${scope}:${token}`, ttl, root, alone: aloneVia(root) };
}

function ticksSpec(scope: string, pool: string, ttl: SwrTtl): InputSpec<TickRow[]> {
  // Ascending with no lower bound: `mapLiquidityTicks`' running sum depends on it.
  const root: RootSpec<TickRow[]> = {
    text: `tk: ticks(where: { pool: $tkPool, liquidityGross_gt: "0" }, orderBy: tickIdx, orderDirection: asc, first: ${PAGE_ROWS}) { tickIdx liquidityGross liquidityNet price0 price1 }`,
    variables: [{ name: 'tkPool', type: 'String!', value: pool }],
    read: (data) => (data.tk as TickRow[] | null | undefined) ?? [],
  };
  return { input: 'ticks', key: `ticks:${scope}:${pool}`, ttl, root, alone: aloneVia(root) };
}

function poolStateSpec(scope: string, pool: string, ttl: SwrTtl): InputSpec<PoolStateRow | null> {
  const root: RootSpec<PoolStateRow | null> = {
    text: 'ps: pool(id: $psId) { tick sqrtPrice tickSpacing token0 { decimals } token1 { decimals } }',
    variables: [{ name: 'psId', type: 'ID!', value: pool }],
    read: (data) => (data.ps as PoolStateRow | null | undefined) ?? null,
  };
  return { input: 'poolState', key: `poolState:${scope}:${pool}`, ttl, root, alone: aloneVia(root) };
}

/** Newest-first rows → oldest-first, flagged when the page cap cut older days off. */
function daySeries<R extends { date: number }>(rows: R[] | null | undefined): DaySeries<R> {
  const list = rows ?? [];
  return {
    rows: [...list].sort((a, b) => Number(a.date) - Number(b.date)),
    truncated: list.length >= PAGE_ROWS,
  };
}

function toTransactions(result: FetchPositionTransactionsResult): PositionTransactions {
  return {
    transactions: result.transactions,
    ...(result.degraded ? { degraded: true } : {}),
    ...(result.truncated ? { truncated: true } : {}),
  };
}

function settle(item: Waiting, value: Promise<unknown>): void {
  value.then(item.resolve, item.reject);
}

function worthSplitting(err: unknown): boolean {
  // Loads never carry a request's hang-up signal (see `resolve`), so there is no
  // "the client left" case to test here: a shared load is worth finishing.
  const status = (err as { response?: { status?: number } })?.response?.status;
  return status !== 429;
}

/** One input of a request: its outcome, and when the request stops waiting for it (none = until it settles). */
interface Pending {
  outcome: Promise<Outcome>;
  deadlineAt?: number;
}

/**
 * Waits for each outcome until it settles or its own deadline passes. Always
 * yields at least once, so outcomes that are already settled (cache hits) count
 * even when their deadline has passed; and an outcome that settles after its
 * own deadline, while another input is still being waited for, counts too.
 */
async function settleBy<K>(pending: Map<K, Pending>): Promise<Map<K, Outcome>> {
  const done = new Map<K, Outcome>();
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  await Promise.all(
    [...pending].map(([key, { outcome, deadlineAt }]) => {
      const settled = outcome.then((value) => {
        done.set(key, value);
      });
      if (deadlineAt === undefined) return settled;
      return Promise.race([
        settled,
        new Promise<void>((resolve) => {
          timers.push(setTimeout(resolve, Math.max(0, deadlineAt - Date.now())));
        }),
      ]);
    }),
  );
  for (const timer of timers) clearTimeout(timer);
  return done;
}

function message(err: unknown): string {
  return (err as Error)?.message ?? String(err);
}

/**
 * Collects the inputs one request is missing and sends them together on
 * `flush`. `SwrCache.refresh` calls its loader synchronously, so every `add`
 * of a request lands before that request's `flush`; an `add` arriving later
 * still goes out, on its own. Exported for its spec.
 */
export class InputBatch {
  private pending: Waiting[] = [];
  private flushed = false;

  constructor(private readonly sendItems: (items: Waiting[]) => Promise<void>) {}

  add(spec: InputSpec<unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.pending.push({ spec, resolve, reject });
      if (this.flushed) queueMicrotask(() => this.drain());
    });
  }

  flush(): void {
    this.flushed = true;
    this.drain();
  }

  private drain(): void {
    const items = this.pending.splice(0);
    if (items.length === 0) return;
    this.sendItems(items).catch((err) => {
      for (const item of items) item.reject(err);
    });
  }
}
