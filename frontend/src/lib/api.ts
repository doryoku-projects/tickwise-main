/**
 * Where the browser fetches the backend. The dev fallback is `3010` — the
 * backend's own `PORT` default — and it read `3000`, where nothing in this repo
 * listens (this frontend is 3011), so a checkout with no `.env.local` pointed
 * every request at a closed port.
 */
export const API_BASE_URL =
  process.env.NEXT_PUBLIC_POSITIONS_API_URL?.replace(/\/$/, '') ?? 'http://localhost:3010';

/** Loopback shapes of `API_BASE_URL` — see `QUICKSTART_BASE`. */
const LOOPBACK_BASE = /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?$/i;

/**
 * The origin printed in copy-pasteable examples, everywhere one is shown — the
 * docs, the landing hero terminal, the quickstart snippet.
 *
 * Separate from `API_BASE_URL` because the two uses disagree exactly once: a
 * checkout with no `.env.local` resolves the base to `http://localhost:3010`,
 * which is the right thing for the app to FETCH and the worst possible thing to
 * bake into a `curl` line somebody copies out of the page. Otherwise it prefers
 * whatever this deployment is configured to call, so a self-hosted or staging
 * build documents its own host instead of ours.
 *
 * Lives here rather than beside the docs pages so the marketing components share
 * it: they shipped with a literal `api.tickwise.io` from the reference design,
 * which is a hostname nobody here can call.
 *
 * This is the ONE place the public host is written down. Every curl line in the
 * docs and both marketing panels read it, so changing the host is this constant
 * plus the deployment's `NEXT_PUBLIC_POSITIONS_API_URL` — never a search-and-
 * replace across the pages.
 */
export const QUICKSTART_BASE = LOOPBACK_BASE.test(API_BASE_URL)
  ? 'https://api.tickwise.xyz'
  : API_BASE_URL;

export type SortKey =
  | 'apr'
  | 'fee_apr'
  | 'roi'
  | 'age'
  | 'pnl'
  | 'underlying_value'
  | 'nft_id_asc'
  | 'nft_id_desc';
export type ProtocolKey = 'uniswap-v3' | 'uniswap-v4';
export type PositionStatus = 'active' | 'inactive' | 'all';
export type RangeFilter = 'all' | 'in' | 'out';

export interface TokenSnapshot {
  address: string;
  symbol: string;
  decimals: number;
  verified: boolean;
  priceUsd: number;
  /** Resolved price-confidence tier (anchor/external-verified = trusted;
   * external-unverified/pool-derived/last-known = lower trust → UI badge). */
  priceConfidence?: string;
  logoURI?: string | null;
}

export interface PositionMetrics {
  apr: number;
  aprExGas?: number;
  feeApr: number;
  poolApr?: number;
  roi: number;
  pnlUsd: number;
  pnlEth?: number;
  pnlHodl?: number;
  poolPnlUsd?: number;
  divergenceLossUsd?: number;
  underlyingValueUsd: number;
  /** Value at quoted market prices IGNORING realizability — differs from
   * underlyingValueUsd only when unrealizableLeg (display-only). */
  nominalValueUsd?: number;
  pendingFeesUsd: number;
  collectedFeesUsd?: number;
  totalFeesUsd?: number;
  totalGasCostUsd?: number;
  investedUsd: number;
  depositedUsd?: number;
  withdrawnUsd?: number;
  diffUsd?: number;
  unclaimedRewardsUsd?: number;
  claimedRewardsUsd?: number;
  /** vs-USD basis companion for the `ref USD` toggle (top-level fields are vs-HODL). */
  usd?: {
    pnlUsd: number;
    poolPnlUsd: number;
    divergenceLossUsd: number;
    apr: number;
    aprExGas: number;
    feeApr: number;
    roi: number;
  };
  ageSeconds: number;
  inRange: boolean;
  isPriceable?: boolean;
  /** True → a quoted leg was valued $0 because its claim exceeds the pool's
   * real exit liquidity (issuer-seeded spam-pool class). */
  unrealizableLeg?: boolean;
  /** True → a held leg had no usable price (data gap); show "price unavailable". */
  priceUnavailable?: boolean;
  performanceReady?: boolean;
  performanceSource?: string;
  aprWarmup?: boolean;
  /** Where the uncollected-fee figure came from. `unmeasured` = not read
   * on-chain since the position last settled fees: render "Pending", not $0. */
  feesSource?: FeesSource;
  /** ISO time of the on-chain measurement behind it; null unless `onchain`. */
  feesMeasuredAt?: string | null;
}

/**
 * `settled` = the position holds no liquidity: 0 owed, exactly (not a placeholder).
 * `indexer` is no longer returned — the figure comes from the on-chain reading
 * alone — but stays in the union so an older stored row, or a client switching
 * over the four values, keeps compiling.
 */
export type FeesSource = "onchain" | "indexer" | "settled" | "unmeasured";

/**
 * True when the uncollected-fee figure is a placeholder rather than a reading:
 * the backend says `unmeasured` (never read on-chain, or last read before the
 * position's most recent modify, which settled the fees it saw). Absent — a
 * row not re-synced since the field shipped — renders as before.
 */
export function feesPending(metrics: Pick<PositionMetrics, "feesSource">): boolean {
  return metrics.feesSource === "unmeasured";
}

export interface PositionAmounts {
  amount0: string;
  amount1: string;
  depositedToken0: string;
  depositedToken1: string;
  depositedUsd?: string;
  withdrawnToken0: string;
  withdrawnToken1: string;
  withdrawnUsd?: string;
  totalFeesCollected0: string;
  totalFeesCollected1: string;
  totalFeesCollectedUsd?: string;
  totalFeesUncollected0: string;
  totalFeesUncollected1: string;
  totalFeesUncollectedUsd?: string;
  totalGasCostEth?: string;
  totalGasCostUsd?: string;
  diffToken0?: string;
  diffToken1?: string;
  diffUsd?: string;
}

export interface PoolStats {
  tvlUsd: number;
  tvlUsdUntracked: number;
  volumeUsd: number;
  totalFeesUsd: number;
  priceDivergence: number;
}

/**
 * Why the backend labels a pool or position row (2026-10-06). `risk` is
 * present only when at least one flag applies:
 *  - `symbol-spoof`: a leg uses a major's symbol (USDT, WETH…) at another contract;
 *  - `phishing-symbol`: a leg's symbol carries a link or "visit";
 *  - `excluded-token`: a leg is on the chain's exclusion list (security flags,
 *    a fake token, no real market) — only lookups and search show such rows;
 *  - `risky-pool`: the pool is one the Pools page treats as risky.
 * Unknown future flags must be ignored, not guessed at.
 */
export type RiskFlag = 'symbol-spoof' | 'phishing-symbol' | 'excluded-token' | 'risky-pool';

export interface RowRisk {
  flags: RiskFlag[];
}

/**
 * A v4 pool's hook, on pool and position rows (2026-10-06). BOTH fields are
 * present only on a pool that has a hook — a pool without one carries neither.
 * `hooks` is the hook contract, lower-case. `customAccounting` is true when
 * that address sets one of the four `*_RETURNS_DELTA` permission bits, i.e. the
 * hook can take or redirect value the pool's swap and liquidity events do not
 * show (read off the address itself; it says nothing about intent).
 */
export interface RowHook {
  hooks?: string;
  customAccounting?: boolean;
}

export interface PositionTransaction {
  transactionId: string;
  txHash: string;
  type: string;
  timestamp: number;
  amount0: string;
  amount1: string;
  amount0PriceUsd: number;
  amount1PriceUsd: number;
  amount0PriceUsdUntracked: number;
  amount1PriceUsdUntracked: number;
  amount0HistoricalPriceUsd?: number;
  amount1HistoricalPriceUsd?: number;
  historicalValueUsd?: number;
  historicalPricingSource?: string;
  gasCostEth: number;
  gasCostUsd: number;
  sender: string;
  logIndex: number;
}

export interface LeaderboardPosition {
  rank: number;
  positionId: string;
  tokenId: string;
  chainId: number;
  protocol: ProtocolKey | string;
  owner: string;
  poolId: string;
  token0: TokenSnapshot;
  token1: TokenSnapshot;
  fee: number;
  tickSpacing: number;
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  liquidity: string;
  isActive: boolean;
  createdAtTimestamp: number;
  closedAtTimestamp: number | null;
  amounts?: PositionAmounts;
  metrics: PositionMetrics;
  poolStats?: PoolStats;
  pricing: {
    source: string;
    usedFallback: boolean;
    pricedAt?: string;
  };
  txSyncStatus?: 'pending' | 'success' | 'failed';
  txSyncedTransactionCount?: number;
  txLastSuccessAt?: string;
  lastSyncedAt?: string;
  /** Present only when a flag applies (`RowRisk`). */
  risk?: RowRisk;
  /** Present only when the position's pool has a hook (`RowHook`). */
  hooks?: string;
  customAccounting?: boolean;
}

export interface PositionDetail extends Omit<LeaderboardPosition, 'rank'> {
  rank?: number;
  transactions: PositionTransaction[];
  /**
   * `true` = the transaction list could NOT be loaded (upstream indexer timeout
   * or outage), and `transactions` is empty for that reason rather than because
   * the position has no history. The endpoint returns 200 in that case instead
   * of the 500 it used to, so this flag is the only way to tell the two apart —
   * never render an empty `transactions` as "no history" without checking it.
   */
  transactionsDegraded?: boolean;
  /**
   * `true` = `transactions` holds only the position's NEWEST page (≤ 1000
   * rows, oldest first): older history was still loading in the backend when
   * it answered (`transactionsDegraded` is `true` alongside it). Absent
   * otherwise. Re-asked once after `DEGRADED_DETAIL_RETRY_MS`.
   */
  transactionsPartial?: true;
  /** `true` = the backend's walk hit its 100k-transaction cap; the newest are missing. */
  transactionsTruncated?: true;
  /**
   * The position was read from a database replica lagging past the 45 s
   * staleness budget: `dataAsOf` (ISO) is when its data was current. Absent
   * otherwise.
   */
  stale?: true;
  dataAsOf?: string;
}

/**
 * A detail whose transaction list came back incomplete (`transactionsDegraded`
 * / `transactionsPartial`) is fetched ONCE more after this delay: the backend
 * finishes the list into its cache behind the answer, so the second response
 * is normally complete.
 */
export const DEGRADED_DETAIL_RETRY_MS = 3_500;

/**
 * The `pagination` block both list routes (`/api/top-positions`,
 * `/api/top-pools`) return.
 *
 * The page no longer waits on a count. `hasMore` is always exact — the backend
 * reads `limit + 1` rows — so it is what decides whether a next page exists.
 * `total` / `totalPages` are `null` with `totalPending: true` when the backend
 * has not counted this filter yet; the matching `/count` route
 * (`fetchLeaderboardCount` / `fetchTopPoolsCount`) answers it. `totalCapped`
 * means the count stopped at the backend's cap (LEADERBOARD_COUNT_CAP, 25,000),
 * so `total` is a floor and is rendered "N+", never as the size.
 */
export interface ListPagination {
  page: number;
  limit: number;
  total: number | null;
  totalPages: number | null;
  hasMore: boolean;
  totalPending?: true;
  totalCapped?: true;
}

/**
 * `GET /api/top-positions/count` and `GET /api/top-pools/count`. Never a 5xx:
 * a count the backend has not finished (still running, queued, or out of its
 * read budget) answers `{total: null, capped: false, pending: true}` — ask
 * again shortly (`useListTotal` re-polls).
 */
export interface ListCount {
  total: number | null;
  /** True when the count hit the backend cap — `total` is then a floor. */
  capped: boolean;
  /** Not counted yet: `total` is null. */
  pending?: true;
  /** Counted on a database replica lagging past the 45 s staleness budget: `dataAsOf` (ISO) is when its data was current. */
  stale?: true;
  dataAsOf?: string;
}

/**
 * Additive flags on both list responses (positions and pools), each present
 * only when it applies:
 *  - `partial` + `missingChains`: an all-chains page served without the chains
 *    whose data was unavailable — the rows are the other chains' merged order;
 *  - `stale` + `dataAsOf`: data older than the backend's 45 s freshness
 *    budget — served because the database answered too slowly, because the
 *    replica it was read from lagged past the budget, or (a very deep page)
 *    because its offsets were counted from a page-ladder boundary older than
 *    the budget. `dataAsOf` is when the data was current.
 */
export interface ListDegradation {
  partial?: true;
  missingChains?: number[];
  stale?: true;
  dataAsOf?: string;
}

export interface LeaderboardResponse extends ListDegradation {
  positions: LeaderboardPosition[];
  pagination: ListPagination;
}

export interface HealthResponse {
  status: string;
  service: string;
  integrations: Array<{
    chainId: number;
    protocol: string;
    enabled: boolean;
    /** Indexer head (epoch seconds) — how fresh the served on-chain data is. */
    indexedUpToTimestamp?: number | null;
    /** Latest block the indexer has processed (synced block). */
    indexedBlock?: number | null;
    /** Latest block on the chain (current block); null when no RPC source. */
    chainHeadBlock?: number | null;
    /**
     * True when chainHeadBlock (and lagBlocks / lagSeconds with it) is a
     * time-based estimate from the last good head reading (up to 15 min old),
     * not a live reading; indexedUpToTimestamp is then null. Absent on an
     * older backend — read it as false.
     */
    chainHeadEstimated?: boolean;
    /** max(0, chainHead - indexed); null when either side is unknown. */
    lagBlocks?: number | null;
    /**
     * lagBlocks × the chain's average block time, in seconds (an estimate).
     * Present whenever lagBlocks is — unlike `indexedUpToTimestamp`.
     */
    lagSeconds?: number | null;
    /** indexed exists and lag is within the healthy threshold. */
    synced?: boolean;
    status?: "healthy" | "degraded" | "unhealthy" | "not_deployed";
  }>;
  timestamp: string;
}

export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  return requestJson<HealthResponse>('/health', signal);
}

/**
 * Platform-wide totals. TRUE UNFILTERED counts — unlike the leaderboard's
 * `pagination.total`, which is whatever survived the spam / no-market / min-TVL
 * gates for one particular query and is therefore NOT a corpus size.
 */
export interface PlatformStats {
  pools: number;
  positions: number;
  /** ISO timestamp of the indexer head, or null when nothing is indexed yet. */
  indexedTo: string | null;
}

// Public and unmetered — no API key, same as /v1/chains.
export async function fetchPlatformStats(): Promise<PlatformStats> {
  return requestJson<PlatformStats>('/v1/stats');
}

export interface ChainMeta {
  chainId: number;
  slug: string;
  name: string;
  /** Short label for tight UI (table chips): "ETH", "AVAX". */
  shortName: string;
  /** Block-explorer base URL — append /tx/{hash}, /address/{addr}. */
  explorerUrl: string;
  nativeToken?: { symbol: string; address: string; decimals: number };
  /** Protocols with an ENABLED integration on this chain (empty = chain is dark). */
  protocols: string[];
}

// Enabled-chain metadata (free, unmetered /v1 route — no API key). Feeds the
// dashboard chain picker; chains whose integration env is unset come back with
// `protocols: []` and are hidden.
export async function fetchChains(signal?: AbortSignal): Promise<ChainMeta[]> {
  return requestJson<ChainMeta[]>('/v1/chains', signal);
}

export interface LeaderboardParams {
  /** Omit (null) for ALL enabled chains — the backend merges across shards. */
  chainId: number | null;
  protocol: ProtocolKey;
  sort: SortKey;
  page: number;
  limit: number;
  activeOnly: boolean;
  status?: PositionStatus;
  range?: RangeFilter;
  minValueUsd: number;
  minPoolTvl?: number;
  includeRisky: boolean;
  positionId?: string;
  poolId?: string;
  /** `equity` restricts to positions in tokenized-equity pools (Robinhood Chain only). */
  assetClass?: 'equity';
  /** Lowercased 0x + 40-hex wallet. Exact match, applied across every page. */
  owner?: string;
}

/**
 * ONE builder for the list and its count, so the two can never be asked
 * about different filters — a count for a filter the table is not showing is
 * a wrong number with nothing to say so.
 */
function leaderboardQuery(params: LeaderboardParams): URLSearchParams {
  const query = new URLSearchParams({
    protocol: params.protocol,
    sort: params.sort,
    page: String(params.page),
    limit: String(params.limit),
    activeOnly: String(params.activeOnly),
    status: params.status ?? (params.activeOnly ? 'active' : 'all'),
    range: params.range ?? 'all',
    minValueUsd: String(params.minValueUsd),
    minPoolTvl: String(params.minPoolTvl ?? 1000),
    includeRisky: String(params.includeRisky),
  });
  if (params.chainId !== null) query.set('chainId', String(params.chainId));
  if (params.positionId) query.set('positionId', params.positionId);
  if (params.poolId) query.set('poolId', params.poolId);
  if (params.assetClass) query.set('assetClass', params.assetClass);
  if (params.owner) query.set('owner', params.owner);
  return query;
}

export async function fetchLeaderboard(
  params: LeaderboardParams,
  signal?: AbortSignal,
): Promise<LeaderboardResponse> {
  return requestJson<LeaderboardResponse>(
    `/api/top-positions?${leaderboardQuery(params).toString()}`,
    signal,
  );
}

/**
 * The count behind a `totalPending` page. Same query as the list (page and
 * limit included — the backend ignores them for the count); the backend
 * single-flights it per filter, so this may take as long as the count does.
 */
export async function fetchLeaderboardCount(
  params: LeaderboardParams,
  signal?: AbortSignal,
): Promise<ListCount> {
  return requestJson<ListCount>(
    `/api/top-positions/count?${leaderboardQuery(params).toString()}`,
    signal,
  );
}

export async function fetchPositionDetail(
  params: {
    chainId: number;
    protocol: ProtocolKey;
    positionId: string;
  },
  signal?: AbortSignal,
): Promise<PositionDetail> {
  return requestJson<PositionDetail>(
    `/api/top-positions/${params.chainId}/${params.protocol}/${params.positionId}`,
    signal,
  );
}

export type ChartRange = '30d' | '60d' | '90d' | '180d' | 'all';

export interface ChartSeriesPoint {
  t: number;
  value: number;
}

export interface ChartPricePoint {
  t: number;
  token0Price: number;
  token1Price: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface PositionCharts {
  range: ChartRange;
  poolPrice: ChartPricePoint[];
  poolOverview: {
    tvl: ChartSeriesPoint[];
    volume: ChartSeriesPoint[];
    fees: ChartSeriesPoint[];
    feesTvl: ChartSeriesPoint[];
    price0: ChartSeriesPoint[];
    price1: ChartSeriesPoint[];
    divergence: ChartSeriesPoint[];
  };
  liquidityDistribution: {
    currentTick: number;
    tickLower: number;
    tickUpper: number;
    ticks: Array<{
      tickIdx: number;
      liquidityGross: string;
      liquidityNet: string;
      /**
       * Liquidity active across this bin (running sum of `liquidityNet`). This is
       * what a depth chart plots — `liquidityGross` only counts positions bounded
       * at the tick, so it spikes at range edges and reads 0 mid-range.
       */
      activeLiquidity: number;
      /** Decimal-adjusted by the backend; safe to display as-is. */
      price0: number;
      price1: number;
      amount0: number;
      amount1: number;
    }>;
  };
  positionSeries: PositionSeries | null;
  poolOverviewCurrent: { tvl: number; volume: number; fees: number; feesTvl: number } | null;
  /** Present when some inputs were not ready by the backend's deadline (their sections are empty). */
  partial?: true;
  missing?: string[];
}

export interface PositionSeries {
  pnl: ChartSeriesPoint[];
  assetsValue: ChartSeriesPoint[];
  apr: ChartSeriesPoint[];
  feeApr: ChartSeriesPoint[];
  divLoss: ChartSeriesPoint[];
}

export async function fetchPositionCharts(
  params: {
    chainId: number;
    protocol: ProtocolKey;
    positionId: string;
    range?: ChartRange;
  },
  signal?: AbortSignal,
): Promise<PositionCharts> {
  const range = params.range ?? 'all';
  return requestJson<PositionCharts>(
    `/api/top-positions/${params.chainId}/${params.protocol}/${params.positionId}/charts?range=${range}`,
    signal,
  );
}

// ─── Pools ──────────────────────────────────────────────────────────────────

export type PoolSortKey = 'tvl' | 'volume' | 'fees' | 'fee_apr' | 'age';

export interface LeaderboardPool {
  rank?: number;
  poolId: string;
  chainId: number;
  protocol: ProtocolKey | string;
  token0: TokenSnapshot;
  token1: TokenSnapshot;
  fee: number;
  isDynamicFee?: boolean;
  tickSpacing: number;
  currentTick: number;
  sqrtPriceX96: string;
  liquidity: string;
  createdAtTimestamp: number;
  metrics: {
    tvlUsd: number;
    volumeUsd24h: number;
    volumeUsd7d: number;
    feesUsd24h: number;
    feesUsd7d: number;
    feeApr: number;
    txCount: number;
    currentPrice: number;
  };
  pricing: {
    source: string;
    usedFallback: boolean;
  };
  updatedAt?: string;
  /** Present only when a flag applies (`RowRisk`) — search keeps spam pools and labels them. */
  risk?: RowRisk;
  /** Present only on a pool that has a hook (`RowHook`). */
  hooks?: string;
  customAccounting?: boolean;
}

export interface PoolDetail extends LeaderboardPool {
  /** Open positions; null while the backend is still counting a heavy pool. */
  positionsCount: number | null;
}

export interface PoolsResponse extends ListDegradation {
  pools: LeaderboardPool[];
  pagination: ListPagination;
  /** Some pools' open-position counts are still being computed (null for now). */
  countsPending?: true;
}

export interface PoolCharts {
  range: ChartRange;
  poolPrice: ChartPricePoint[];
  poolOverview: {
    tvl: ChartSeriesPoint[];
    volume: ChartSeriesPoint[];
    fees: ChartSeriesPoint[];
    feesTvl: ChartSeriesPoint[];
    price0: ChartSeriesPoint[];
    price1: ChartSeriesPoint[];
    divergence: ChartSeriesPoint[];
  };
  liquidityDistribution: {
    currentTick: number;
    ticks: Array<{
      tickIdx: number;
      liquidityGross: string;
      liquidityNet: string;
      /**
       * Liquidity active across this bin (running sum of `liquidityNet`). This is
       * what a depth chart plots — `liquidityGross` only counts positions bounded
       * at the tick, so it spikes at range edges and reads 0 mid-range.
       */
      activeLiquidity: number;
      /** Decimal-adjusted by the backend; safe to display as-is. */
      price0: number;
      price1: number;
      amount0: number;
      amount1: number;
    }>;
  };
  poolSeries: {
    volume: ChartSeriesPoint[];
    tvl: ChartSeriesPoint[];
    fees: ChartSeriesPoint[];
    feeApr: ChartSeriesPoint[];
  };
  poolOverviewCurrent: { tvl: number; volume: number; fees: number; feesTvl: number } | null;
  /** Present when some inputs were not ready by the backend's deadline (their sections are empty). */
  partial?: true;
  missing?: string[];
}

export interface TopPoolsParams {
  /** Omit (null) for ALL enabled chains — the backend merges across shards. */
  chainId: number | null;
  protocol: ProtocolKey;
  sort: PoolSortKey;
  page: number;
  limit: number;
  minTvlUsd?: number;
  includeRisky?: boolean;
  search?: string;
  /** `equity` restricts to tokenized-equity pools (Robinhood Chain only). */
  assetClass?: 'equity';
}

/** Shared by the pools list and its count — see `leaderboardQuery`. */
function topPoolsQuery(params: TopPoolsParams): URLSearchParams {
  const query = new URLSearchParams({
    protocol: params.protocol,
    sort: params.sort,
    page: String(params.page),
    limit: String(params.limit),
    minTvlUsd: String(params.minTvlUsd ?? 0),
    includeRisky: String(params.includeRisky ?? false),
  });
  if (params.chainId !== null) query.set('chainId', String(params.chainId));
  if (params.search) query.set('search', params.search);
  if (params.assetClass) query.set('assetClass', params.assetClass);
  return query;
}

export async function fetchTopPools(
  params: TopPoolsParams,
  signal?: AbortSignal,
): Promise<PoolsResponse> {
  return requestJson<PoolsResponse>(`/api/top-pools?${topPoolsQuery(params).toString()}`, signal);
}

/** The count behind a `totalPending` pools page — see `fetchLeaderboardCount`. */
export async function fetchTopPoolsCount(
  params: TopPoolsParams,
  signal?: AbortSignal,
): Promise<ListCount> {
  return requestJson<ListCount>(
    `/api/top-pools/count?${topPoolsQuery(params).toString()}`,
    signal,
  );
}

export async function fetchPoolDetail(params: {
  chainId: number;
  protocol: ProtocolKey;
  poolId: string;
}): Promise<PoolDetail> {
  return requestJson<PoolDetail>(
    `/api/top-pools/${params.chainId}/${params.protocol}/${params.poolId}`,
  );
}

export async function fetchPoolCharts(
  params: {
    chainId: number;
    protocol: ProtocolKey;
    poolId: string;
    range?: ChartRange;
  },
  signal?: AbortSignal,
): Promise<PoolCharts> {
  const range = params.range ?? '30d';
  return requestJson<PoolCharts>(
    `/api/top-pools/${params.chainId}/${params.protocol}/${params.poolId}/charts?range=${range}`,
    signal,
  );
}

// NOTE: there is no admin helper here. Admin actions (sync included) go through
// `adminApi` in lib/admin-api.ts, which authenticates with the admin JWT. Never
// put a shared secret in this file — it ships to the browser.

/**
 * True for the rejection an aborted request produces. A superseded request is
 * aborted on purpose (a filter changed, a panel closed), so callers drop it
 * silently — it is not an error and must never reach an error banner.
 *
 * Checked by name, not `instanceof DOMException`: `fetch` rejects with a
 * DOMException, but a body read cut short (`response.json()` mid-stream) and
 * some runtimes surface a plain Error carrying the same name.
 */
export function isAbortError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'AbortError'
  );
}

/**
 * The keyless `/api` answered 429: this visitor (or the network behind this
 * address) went over the per-address budget. Typed so a caller can tell it from
 * a failure and so what reaches the page is OUR wording — the response body
 * names the paid API and is written for scripts, never for a visitor.
 */
export class RateLimitedError extends Error {
  constructor(readonly retryAfterMs: number) {
    super('The service is busy right now. Try again in a few seconds.');
    this.name = 'RateLimitedError';
  }
}

/** By name, like `isAbortError`: the class can be duplicated by a bundler, the name cannot. */
export function isRateLimitedError(err: unknown): err is RateLimitedError {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'RateLimitedError';
}

/** The longest a 429's `Retry-After` is waited out silently; past it the visitor is told instead. */
const RATE_LIMIT_RETRY_MAX_MS = 10_000;
/** `Retry-After` when the response carries none (or an unreadable one). */
const RATE_LIMIT_RETRY_DEFAULT_MS = 2_000;

function retryAfterMs(response: Response): number {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : RATE_LIMIT_RETRY_DEFAULT_MS;
}

/** Resolve after `ms`, or reject with an AbortError the moment `signal` aborts. */
function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * `signal` is optional. The status page's poll passes one as a deadline (a
 * request that never answers would stop its loop scheduling the next tick),
 * and the dashboards pass one per effect so a superseded request is CANCELLED
 * rather than left running on the server — every filter click used to leave
 * the previous leaderboard query running, sometimes for a minute.
 *
 * A 429 is retried ONCE, silently, after the `Retry-After` the server asked for
 * (a landing view is several requests at once and a shared network can tip the
 * budget for a second); a second 429, or a wait longer than
 * `RATE_LIMIT_RETRY_MAX_MS`, throws `RateLimitedError`. The body is never read.
 */
async function requestJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      cache: 'no-store',
      ...(signal ? { signal } : {}),
    });
    if (response.status === 429) {
      const wait = retryAfterMs(response);
      if (attempt === 0 && wait <= RATE_LIMIT_RETRY_MAX_MS) {
        await sleepAbortable(wait, signal);
        continue;
      }
      throw new RateLimitedError(wait);
    }
    if (!response.ok) {
      throw new Error(await response.text());
    }
    return response.json() as Promise<T>;
  }
}

/**
 * This view as a call to the paid `/v1` API — the same filters, so what comes
 * back is the same list, with room for a page of up to 100. A person who wants
 * the data in a script is pointed at a free key, not left to copy requests the
 * site makes for itself.
 */
function v1Command(route: 'positions' | 'pools', query: URLSearchParams): string {
  return `curl -s "${QUICKSTART_BASE}/v1/${route}?${query.toString()}" \\\n  -H "KC-APIKey: YOUR_API_KEY"`;
}

export function leaderboardV1Command(params: LeaderboardParams): string {
  return v1Command('positions', leaderboardQuery(params));
}

export function topPoolsV1Command(params: TopPoolsParams): string {
  return v1Command('pools', topPoolsQuery(params));
}
