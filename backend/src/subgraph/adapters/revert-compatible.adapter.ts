import { Inject, Injectable, Logger } from '@nestjs/common';
import { GraphQLClient, gql } from 'graphql-request';
import { subgraphFetch } from '../hyperindex/client.js';
import { PricingService } from '../../pricing/pricing.service.js';
import type { IntegrationConfig } from '../../config/integrations.config.js';
import { assessValuation } from '../../valuation/valuation-guard.js';
import type {
  FetchAllPositionTransactionsResult,
  FetchPositionTransactionsResult,
  FetchPositionsResult,
  NormalizedPosition,
  NormalizedPositionTransaction,
} from '../normalized-position.js';
import type {
  FetchAllPositionTransactionsOptions,
  FetchPoolSnapshotsOptions,
  FetchPositionsOptions,
  PoolSnapshot,
  PositionAdapter,
} from '../position-adapter.js';

interface RevertPosition {
  id?: string;
  tokenId?: string;
  owner?: string;
  liquidity?: string;
  isActive?: boolean;
  isPriceable?: boolean;
  tickLower?: string;
  tickUpper?: string;
  apr?: string;
  pnlUSD?: string;
  pnlETH?: string;
  pnlHODL?: string;
  poolPnL?: string;
  poolAPR?: string;
  divergenceLoss?: string;
  roi?: string;
  feeAPR?: string;
  tvlUSD?: string;
  currentValueUSD?: string;
  investedUSD?: string;
  depositedUSD?: string;
  withdrawnUSD?: string;
  depositedToken0?: string;
  depositedToken1?: string;
  withdrawnToken0?: string;
  withdrawnToken1?: string;
  totalFeesCollected0?: string;
  totalFeesCollected1?: string;
  totalFeesUncollected0?: string;
  totalFeesUncollected1?: string;
  totalGasCostETH?: string;
  totalGasCostUSD?: string;
  unclaimedRewardsUSD?: string;
  claimedRewardsUSD?: string;
  diffToken0?: string;
  diffToken1?: string;
  diffUSD?: string;
  amount0?: string;
  amount1?: string;
  createdAtTimestamp?: string;
  createdAtBlockNumber?: string;
  closedAtTimestamp?: string | null;
  pool?: {
    id?: string;
    fee?: number;
    tickSpacing?: number | string;
    tick?: number | string;
    sqrtPriceX96?: string;
    totalValueLockedUSD?: string;
    totalValueLockedUSDUntracked?: string;
    volumeUSD?: string;
    totalFeesUSD?: string;
    priceDivergence?: string;
    token0?: { id?: string; symbol?: string; decimals?: string; verified?: boolean; priceUSD?: string };
    token1?: { id?: string; symbol?: string; decimals?: string; verified?: boolean; priceUSD?: string };
  };
}

interface RevertPositionTx {
  id?: string;
  tokenId?: string;
  type?: string;
  amount0?: string;
  amount1?: string;
  amount0PriceUSD?: string;
  amount1PriceUSD?: string;
  amount0PriceUSDUntracked?: string;
  amount1PriceUSDUntracked?: string;
  gasCostETH?: string;
  gasCostUSD?: string;
  timestamp?: string;
  transaction?: string;
  sender?: string;
  logIndex?: string;
}

const POSITION_FIELDS = gql`
  fragment PositionFields on UniswapPosition {
    id
    tokenId
    owner
    liquidity
    isActive
    isPriceable
    tickLower
    tickUpper
    apr
    pnlUSD
    pnlETH
    pnlHODL
    poolPnL
    poolAPR
    divergenceLoss
    roi
    feeAPR
    tvlUSD
    currentValueUSD
    investedUSD
    depositedUSD
    withdrawnUSD
    depositedToken0
    depositedToken1
    withdrawnToken0
    withdrawnToken1
    totalFeesCollected0
    totalFeesCollected1
    totalFeesUncollected0
    totalFeesUncollected1
    totalGasCostETH
    totalGasCostUSD
    unclaimedRewardsUSD
    claimedRewardsUSD
    diffToken0
    diffToken1
    diffUSD
    amount0
    amount1
    createdAtTimestamp
    createdAtBlockNumber
    closedAtTimestamp
    pool {
      id
      fee
      tickSpacing
      tick
      sqrtPriceX96
      totalValueLockedUSD
      totalValueLockedUSDUntracked
      volumeUSD
      totalFeesUSD
      priceDivergence
      token0 { id symbol decimals verified priceUSD }
      token1 { id symbol decimals verified priceUSD }
    }
  }
`;

const BACKFILL_POSITIONS_QUERY = gql`
  ${POSITION_FIELDS}
  query Positions($first: Int!, $skip: Int!, $cursorTimestamp: BigInt!, $cursorPositionId: String!) {
    uniswapPositions(
      first: $first
      skip: $skip
      where: {
        or: [
          { createdAtTimestamp_gt: $cursorTimestamp }
          { createdAtTimestamp: $cursorTimestamp, tokenId_gt: $cursorPositionId }
        ]
      }
      orderBy: createdAtTimestamp
      orderDirection: asc
    ) {
      ...PositionFields
    }
  }
`;

const BACKFILL_POSITIONS_RANGE_QUERY = gql`
  ${POSITION_FIELDS}
  query PositionsRange(
    $first: Int!
    $cursorTimestamp: BigInt!
    $cursorPositionId: String!
    $maxTimestamp: BigInt!
  ) {
    uniswapPositions(
      first: $first
      where: {
        and: [
          { or: [
            { createdAtTimestamp_gt: $cursorTimestamp }
            { createdAtTimestamp: $cursorTimestamp, tokenId_gt: $cursorPositionId }
          ] }
          { createdAtTimestamp_lt: $maxTimestamp }
        ]
      }
      orderBy: createdAtTimestamp
      orderDirection: asc
    ) {
      ...PositionFields
    }
  }
`;

const POSITIONS_TIMESTAMP_RANGE_QUERY = gql`
  query TimestampRange {
    first: uniswapPositions(first: 1, orderBy: createdAtTimestamp, orderDirection: asc) {
      createdAtTimestamp
    }
    last: uniswapPositions(first: 1, orderBy: createdAtTimestamp, orderDirection: desc) {
      createdAtTimestamp
    }
  }
`;

const LATEST_POSITIONS_QUERY = gql`
  ${POSITION_FIELDS}
  query LatestPositions($first: Int!, $cursorTimestamp: BigInt!) {
    uniswapPositions(
      first: $first
      where: { createdAtTimestamp_lt: $cursorTimestamp }
      orderBy: createdAtTimestamp
      orderDirection: desc
    ) {
      ...PositionFields
    }
  }
`;

const POSITIONS_BY_TOKEN_IDS_QUERY = gql`
  ${POSITION_FIELDS}
  query PositionsByTokenIds($first: Int!, $skip: Int!, $positionIds: [String!]!) {
    uniswapPositions(
      first: $first
      skip: $skip
      where: { tokenId_in: $positionIds }
      orderBy: createdAtTimestamp
      orderDirection: desc
    ) {
      ...PositionFields
    }
  }
`;

const POSITION_TRANSACTIONS_QUERY = gql`
  query PositionTransactions($tokenIds: [String!]!, $first: Int!, $skip: Int!, $sinceTimestamp: BigInt!) {
    positionTransactions(
      where: { tokenId_in: $tokenIds, timestamp_gt: $sinceTimestamp }
      orderBy: timestamp
      orderDirection: asc
      first: $first
      skip: $skip
    ) {
      id
      tokenId
      type
      amount0
      amount1
      amount0PriceUSD
      amount1PriceUSD
      amount0PriceUSDUntracked
      amount1PriceUSDUntracked
      gasCostETH
      gasCostUSD
      timestamp
      transaction
      sender
      logIndex
    }
  }
`;

/**
 * Cursor-walk query: returns ALL position transactions ascending by
 * `(timestamp, id)`. The composite cursor ensures rows sharing a timestamp
 * are not skipped between pages. Mirrors the positions backfill `or` cursor
 * shape.
 */
const ALL_POSITION_TRANSACTIONS_QUERY = gql`
  query AllPositionTransactions($first: Int!, $cursorTimestamp: BigInt!, $cursorTransactionId: String!) {
    positionTransactions(
      where: {
        or: [
          { timestamp_gt: $cursorTimestamp }
          { timestamp: $cursorTimestamp, id_gt: $cursorTransactionId }
        ]
      }
      orderBy: timestamp
      orderDirection: asc
      first: $first
    ) {
      id
      tokenId
      type
      amount0
      amount1
      amount0PriceUSD
      amount1PriceUSD
      amount0PriceUSDUntracked
      amount1PriceUSDUntracked
      gasCostETH
      gasCostUSD
      timestamp
      transaction
      sender
      logIndex
    }
  }
`;

const ALL_POSITION_TRANSACTIONS_RANGE_QUERY = gql`
  query AllPositionTransactionsRange(
    $first: Int!
    $cursorTimestamp: BigInt!
    $cursorTransactionId: String!
    $maxTimestamp: BigInt!
  ) {
    positionTransactions(
      where: {
        and: [
          { or: [
            { timestamp_gt: $cursorTimestamp }
            { timestamp: $cursorTimestamp, id_gt: $cursorTransactionId }
          ] }
          { timestamp_lt: $maxTimestamp }
        ]
      }
      orderBy: timestamp
      orderDirection: asc
      first: $first
    ) {
      id
      tokenId
      type
      amount0
      amount1
      amount0PriceUSD
      amount1PriceUSD
      amount0PriceUSDUntracked
      amount1PriceUSDUntracked
      gasCostETH
      gasCostUSD
      timestamp
      transaction
      sender
      logIndex
    }
  }
`;

const POSITION_TRANSACTIONS_TIMESTAMP_RANGE_QUERY = gql`
  query TxTimestampRange {
    first: positionTransactions(first: 1, orderBy: timestamp, orderDirection: asc) {
      timestamp
    }
    last: positionTransactions(first: 1, orderBy: timestamp, orderDirection: desc) {
      timestamp
    }
  }
`;

/**
 * Pool snapshots in a `[fromTimestamp, toTimestamp]` range. Returns
 * `sqrtPriceX96`, `tick`, and subgraph-derived USD prices per side at each
 * snapshot. The historical pricing chain pairs this with the priced anchor
 * side (USDC/USDT/WETH from external providers) to derive a long-tail
 * token's USD via the pool ratio.
 */
const POOL_SNAPSHOTS_RANGE_QUERY = gql`
  query PoolSnapshotsRange(
    $poolId: String!
    $fromTimestamp: BigInt!
    $toTimestamp: BigInt!
    $first: Int!
    $skip: Int!
  ) {
    poolSnapshots(
      where: {
        pool: $poolId
        timestamp_gte: $fromTimestamp
        timestamp_lte: $toTimestamp
      }
      orderBy: timestamp
      orderDirection: asc
      first: $first
      skip: $skip
    ) {
      timestamp
      sqrtPriceX96
      tick
      token0PriceUSD
      token1PriceUSD
    }
  }
`;

@Injectable()
export class RevertCompatibleAdapter implements PositionAdapter {
  readonly protocol = '*';
  private readonly logger = new Logger(RevertCompatibleAdapter.name);

  constructor(@Inject(PricingService) private readonly pricing: PricingService) {}

  async fetchPositions(options: FetchPositionsOptions): Promise<FetchPositionsResult> {
    const integration = options.integration;
    if (!integration.subgraphUrl) {
      return {
        positions: [],
        seenPositionIds: [],
        maxTimestamp: options.cursorTimestamp,
        maxPositionId: options.cursorPositionId ?? '',
        maxBlockNumber: 0,
        hasMore: false,
        flushedCount: 0,
      };
    }

    const client = new GraphQLClient(integration.subgraphUrl, subgraphFetch(integration));
    const collected: NormalizedPosition[] = [];
    const latestOnlyLimit =
      options.mode === 'refresh' ? 0 : Math.max(0, options.latestOnlyLimit ?? 0);
    let maxTimestamp = options.cursorTimestamp;
    let maxPositionId = options.cursorPositionId ?? '';
    let maxBlockNumber = 0;
    let pageCursorTimestamp = latestOnlyLimit > 0 ? Number.MAX_SAFE_INTEGER : options.cursorTimestamp;
    let pageCursorPositionId = options.cursorPositionId ?? '';
    let hasMore = false;
    const maxPages = options.maxPages <= 0 ? Number.MAX_SAFE_INTEGER : options.maxPages;

    const startedAt = Date.now();
    const integrationKey = `${integration.chainId}:${integration.protocol}`;
    const normalizationConcurrency = Math.max(1, options.normalizationConcurrency ?? 10);
    const flushThreshold = options.flushThreshold ?? 0;
    let flushedCount = 0;
    const seenPositionIds: string[] = [];

    // Pipeline subgraph fetches: kick off page N+1's request as soon as page N
    // arrives, so the network round-trip overlaps with normalize + Mongo flush
    // on the current page. Cuts wall time roughly in half on subgraph-bound
    // backfills. Only active for the plain cursor walk; refresh/latestOnly
    // paths keep the simpler serial shape because their cursor strategy needs
    // post-normalize feedback to advance.
    const pipelineEnabled = options.mode !== 'refresh' && latestOnlyLimit <= 0;
    const rangeMode = options.mode !== 'refresh' && latestOnlyLimit <= 0 && typeof options.maxTimestamp === 'number';
    const query =
      options.mode === 'refresh'
        ? POSITIONS_BY_TOKEN_IDS_QUERY
        : latestOnlyLimit > 0
          ? LATEST_POSITIONS_QUERY
          : rangeMode
            ? BACKFILL_POSITIONS_RANGE_QUERY
            : BACKFILL_POSITIONS_QUERY;
    const fetchPage = (cursorTs: number, cursorPid: string, skipCount: number, pageSize: number) => {
      const promise = requestWithRetry<{ uniswapPositions: RevertPosition[] }>(
        client,
        query,
        {
          first: pageSize,
          skip: skipCount,
          cursorTimestamp: String(cursorTs),
          cursorPositionId: cursorPid,
          positionIds: options.positionIds ?? [],
          ...(rangeMode ? { maxTimestamp: String(options.maxTimestamp) } : {}),
        },
      );
      // Pipelined pages are kicked off before the loop awaits them. If the loop
      // exits (hasMore=false, page cap, or an upstream throw) while a page is
      // still in flight, that promise is abandoned — attach a swallow handler so
      // a later network rejection can't surface as an unhandled rejection and
      // crash the process. The awaiting `await pendingResult` still observes the
      // real error and routes it to the caller's try/catch.
      promise.catch(() => undefined);
      return promise;
    };
    let pendingResult: Promise<{ uniswapPositions: RevertPosition[] }> | null = null;
    if (pipelineEnabled) {
      pendingResult = fetchPage(pageCursorTimestamp, pageCursorPositionId, 0, options.pageSize);
    }

    for (let page = 0; page < maxPages; page++) {
      const remainingLatest = latestOnlyLimit > 0 ? latestOnlyLimit - seenPositionIds.length : Number.MAX_SAFE_INTEGER;
      if (remainingLatest <= 0) break;
      const pageSize =
        latestOnlyLimit > 0
          ? Math.min(options.pageSize, Math.max(remainingLatest, Math.min(options.pageSize, 100)))
          : options.pageSize;
      const pageStartedAt = Date.now();
      const queryStartedAt = Date.now();
      const result = pipelineEnabled && pendingResult
        ? await pendingResult
        : await fetchPage(
            pageCursorTimestamp,
            pageCursorPositionId,
            options.mode === 'refresh' ? page * options.pageSize : 0,
            pageSize,
          );
      const queryMs = Date.now() - queryStartedAt;
      const allRawPositions = result.uniswapPositions ?? [];

      // Kick off the next page's fetch immediately so it overlaps with
      // normalize+flush. Cursor for next page derived from the last raw row
      // (queries are sorted ascending by createdAtTimestamp+tokenId).
      if (pipelineEnabled) {
        if (allRawPositions.length >= options.pageSize) {
          const last = allRawPositions[allRawPositions.length - 1];
          const nextCursorTs = toNumber(last?.createdAtTimestamp);
          const nextCursorPid = String(last?.tokenId ?? last?.id ?? '');
          pendingResult = fetchPage(nextCursorTs, nextCursorPid, 0, options.pageSize);
        } else {
          pendingResult = null;
        }
      }
      if (latestOnlyLimit > 0 && allRawPositions.length > 0) {
        pageCursorTimestamp = toNumber(allRawPositions[allRawPositions.length - 1]?.createdAtTimestamp);
        pageCursorPositionId = String(
          allRawPositions[allRawPositions.length - 1]?.tokenId ??
            allRawPositions[allRawPositions.length - 1]?.id ??
            '',
        );
      }
      const rawPositions = allRawPositions.filter((position) => {
        if (latestOnlyLimit > 0) return true;
        if (options.mode === 'refresh') return true;
        const timestamp = toNumber(position.createdAtTimestamp);
        const id = String(position.tokenId ?? position.id ?? '');
        return timestamp > options.cursorTimestamp || id > (options.cursorPositionId ?? '');
      });

      const tokensByAddress = new Map<string, { address: string; symbol?: string }>();
      for (const raw of rawPositions) {
        const t0 = raw.pool?.token0;
        const t1 = raw.pool?.token1;
        if (t0?.id) {
          const addr = t0.id.toLowerCase();
          if (!tokensByAddress.has(addr)) tokensByAddress.set(addr, { address: addr, symbol: t0.symbol });
        }
        if (t1?.id) {
          const addr = t1.id.toLowerCase();
          if (!tokensByAddress.has(addr)) tokensByAddress.set(addr, { address: addr, symbol: t1.symbol });
        }
      }
      if (!options.skipPrefetch) {
        await this.pricing.prefetchPrices(integration.chainId, [...tokensByAddress.values()]);
      }

      const normalizeStartedAt = Date.now();
      const normalizedPositions = await mapConcurrent(
        rawPositions,
        normalizationConcurrency,
        (raw) => this.normalize(raw, integration, options.mode),
      );
      const normalizeMs = Date.now() - normalizeStartedAt;
      let normalizedCount = 0;

      for (const [index, normalized] of normalizedPositions.entries()) {
        if (!normalized) continue;
        if (latestOnlyLimit > 0 && seenPositionIds.length >= latestOnlyLimit) break;
        normalizedCount += 1;
        const raw = rawPositions[index];
        collected.push(normalized);
        seenPositionIds.push(normalized.positionId);
        if (
          normalized.createdAtTimestamp > maxTimestamp ||
          (normalized.createdAtTimestamp === maxTimestamp && normalized.positionId > maxPositionId)
        ) {
          maxTimestamp = normalized.createdAtTimestamp;
          maxPositionId = normalized.positionId;
        }
        if (latestOnlyLimit <= 0 && (
          normalized.createdAtTimestamp > pageCursorTimestamp ||
          (normalized.createdAtTimestamp === pageCursorTimestamp && normalized.positionId > pageCursorPositionId)
        )) {
          pageCursorTimestamp = normalized.createdAtTimestamp;
          pageCursorPositionId = normalized.positionId;
        }
        maxBlockNumber = Math.max(maxBlockNumber, toNumber(raw?.createdAtBlockNumber));
      }

      if (flushThreshold > 0 && options.onFlush && collected.length >= flushThreshold) {
        const flushed = await options.onFlush(collected, { maxTimestamp, maxPositionId, maxBlockNumber });
        flushedCount += flushed;
        collected.length = 0;
      }

      hasMore =
        latestOnlyLimit > 0
          ? seenPositionIds.length < latestOnlyLimit && allRawPositions.length >= pageSize
          : allRawPositions.length >= options.pageSize;
      if (!hasMore) break;
    }

    return {
      positions: collected,
      seenPositionIds,
      maxTimestamp,
      maxPositionId,
      maxBlockNumber,
      hasMore,
      flushedCount,
    };
  }

  async fetchPositionTransactions(
    options: FetchPositionsOptions,
  ): Promise<FetchPositionTransactionsResult> {
    const integration = options.integration;
    if (!integration.subgraphUrl || !options.positionIds?.length) {
      return { transactions: [] };
    }

    const client = new GraphQLClient(integration.subgraphUrl, subgraphFetch(integration));
    const transactions: NormalizedPositionTransaction[] = [];
    const sinceTimestamp = Math.max(0, Math.floor(options.cursorTimestamp ?? 0));

    for (let page = 0; page < options.maxPages; page++) {
      const result = await requestWithRetry<{ positionTransactions: RevertPositionTx[] }>(
        client,
        POSITION_TRANSACTIONS_QUERY,
        {
          tokenIds: options.positionIds,
          first: options.pageSize,
          skip: page * options.pageSize,
          sinceTimestamp: String(sinceTimestamp),
        },
      );
      const rawTransactions = result.positionTransactions ?? [];
      if (rawTransactions.length === 0) break;

      for (const raw of rawTransactions) {
        transactions.push(this.normalizeTransaction(raw, integration));
      }

      if (rawTransactions.length < options.pageSize) break;
    }

    return { transactions };
  }

  /**
   * Cursor-walk of ALL position transactions ascending by `(timestamp, id)`.
   * Mirrors `fetchPositions` backfill loop: paginates, accumulates, calls
   * `onFlush` every `flushThreshold` rows with the running cursor so the
   * caller can persist + advance atomically. `hasMore=true` means another
   * run should resume from the returned `(maxTimestamp, maxTransactionId)`.
   */
  async fetchAllPositionTransactions(
    options: FetchAllPositionTransactionsOptions,
  ): Promise<FetchAllPositionTransactionsResult> {
    const integration = options.integration;
    if (!integration.subgraphUrl) {
      return {
        transactions: [],
        maxTimestamp: options.cursorTimestamp,
        maxTransactionId: options.cursorTransactionId,
        hasMore: false,
        flushedCount: 0,
      };
    }

    const client = new GraphQLClient(integration.subgraphUrl, subgraphFetch(integration));
    const collected: NormalizedPositionTransaction[] = [];
    let maxTimestamp = options.cursorTimestamp;
    let maxTransactionId = options.cursorTransactionId;
    let pageCursorTimestamp = options.cursorTimestamp;
    let pageCursorTransactionId = options.cursorTransactionId;
    let hasMore = false;
    let flushedCount = 0;
    const maxPages = options.maxPages <= 0 ? Number.MAX_SAFE_INTEGER : options.maxPages;
    const flushThreshold = options.flushThreshold;

    const rangeMode = typeof options.maxTimestamp === 'number';
    const txQuery = rangeMode ? ALL_POSITION_TRANSACTIONS_RANGE_QUERY : ALL_POSITION_TRANSACTIONS_QUERY;

    for (let page = 0; page < maxPages; page++) {
      const result = await requestWithRetry<{ positionTransactions: RevertPositionTx[] }>(
        client,
        txQuery,
        {
          first: options.pageSize,
          cursorTimestamp: String(pageCursorTimestamp),
          cursorTransactionId: pageCursorTransactionId,
          ...(rangeMode ? { maxTimestamp: String(options.maxTimestamp) } : {}),
        },
      );
      const raws = result.positionTransactions ?? [];
      if (raws.length === 0) {
        hasMore = false;
        break;
      }

      for (const raw of raws) {
        const normalized = this.normalizeTransaction(raw, integration);
        collected.push(normalized);

        // Advance the running cursor monotonically: pick the largest
        // (timestamp, id) we've seen.
        const ts = normalized.timestamp;
        const id = normalized.transactionId;
        if (ts > maxTimestamp || (ts === maxTimestamp && id > maxTransactionId)) {
          maxTimestamp = ts;
          maxTransactionId = id;
        }
        if (ts > pageCursorTimestamp || (ts === pageCursorTimestamp && id > pageCursorTransactionId)) {
          pageCursorTimestamp = ts;
          pageCursorTransactionId = id;
        }
      }

      if (flushThreshold > 0 && collected.length >= flushThreshold) {
        const flushed = await options.onFlush(collected, {
          maxTimestamp,
          maxTransactionId,
        });
        flushedCount += flushed;
        collected.length = 0;
      }

      // Less than a full page → subgraph drained.
      if (raws.length < options.pageSize) {
        hasMore = false;
        break;
      }
      hasMore = true;
    }

    return {
      transactions: collected,
      maxTimestamp,
      maxTransactionId,
      hasMore,
      flushedCount,
    };
  }

  async fetchPoolSnapshots(options: FetchPoolSnapshotsOptions): Promise<PoolSnapshot[]> {
    const integration = options.integration;
    if (!integration.subgraphUrl) return [];

    const client = new GraphQLClient(integration.subgraphUrl, subgraphFetch(integration));
    const PAGE = 1000;
    const collected: PoolSnapshot[] = [];
    const poolId = options.poolId.toLowerCase();

    for (let skip = 0; skip < 5000; skip += PAGE) {
      const result = await requestWithRetry<{
        poolSnapshots: Array<{
          timestamp: string;
          sqrtPriceX96: string;
          tick: number | string;
          token0PriceUSD: string;
          token1PriceUSD: string;
        }>;
      }>(client, POOL_SNAPSHOTS_RANGE_QUERY, {
        poolId,
        fromTimestamp: String(options.fromTimestamp),
        toTimestamp: String(options.toTimestamp),
        first: PAGE,
        skip,
      });
      const snaps = result.poolSnapshots ?? [];
      if (snaps.length === 0) break;
      for (const snap of snaps) {
        collected.push({
          poolId,
          timestamp: toNumber(snap.timestamp),
          sqrtPriceX96: String(snap.sqrtPriceX96 ?? '0'),
          tick: toNumber(snap.tick),
          token0PriceUsd: toNumber(snap.token0PriceUSD),
          token1PriceUsd: toNumber(snap.token1PriceUSD),
        });
      }
      if (snaps.length < PAGE) break;
    }

    return collected;
  }

  async fetchPositionTimestampRange(
    integration: IntegrationConfig,
  ): Promise<{ minTimestamp: number; maxTimestamp: number }> {
    if (!integration.subgraphUrl) return { minTimestamp: 0, maxTimestamp: 0 };
    const client = new GraphQLClient(integration.subgraphUrl, subgraphFetch(integration));
    const result = await requestWithRetry<{
      first: Array<{ createdAtTimestamp: string }>;
      last: Array<{ createdAtTimestamp: string }>;
    }>(client, POSITIONS_TIMESTAMP_RANGE_QUERY);
    const minTimestamp = toNumber(result.first?.[0]?.createdAtTimestamp);
    const maxTimestamp = toNumber(result.last?.[0]?.createdAtTimestamp);
    return { minTimestamp, maxTimestamp };
  }

  async fetchTransactionTimestampRange(
    integration: IntegrationConfig,
  ): Promise<{ minTimestamp: number; maxTimestamp: number }> {
    if (!integration.subgraphUrl) return { minTimestamp: 0, maxTimestamp: 0 };
    const client = new GraphQLClient(integration.subgraphUrl, subgraphFetch(integration));
    const result = await requestWithRetry<{
      first: Array<{ timestamp: string }>;
      last: Array<{ timestamp: string }>;
    }>(client, POSITION_TRANSACTIONS_TIMESTAMP_RANGE_QUERY);
    const minTimestamp = toNumber(result.first?.[0]?.timestamp);
    const maxTimestamp = toNumber(result.last?.[0]?.timestamp);
    return { minTimestamp, maxTimestamp };
  }

  private async normalize(
    raw: RevertPosition,
    integration: IntegrationConfig,
    mode?: string,
  ): Promise<NormalizedPosition | null> {
    const tokenId = String(raw.tokenId ?? raw.id ?? '');
    if (!tokenId || !/^\d+$/.test(tokenId)) return null;
    const pool = raw.pool;
    const token0 = pool?.token0;
    const token1 = pool?.token1;
    if (!pool?.id || !token0?.id || !token1?.id) return null;

    const decimals0 = toNumber(token0.decimals, 18);
    const decimals1 = toNumber(token1.decimals, 18);
    const currentTick = toNumber(pool.tick);
    const sqrtPriceX96 = String(pool.sqrtPriceX96 ?? '0');
    const tickLower = toNumber(raw.tickLower);
    const tickUpper = toNumber(raw.tickUpper);
    const liquidity = String(raw.liquidity ?? '0');
    const poolTvlUsd = toNumber(pool.totalValueLockedUSD);
    const poolTvlUsdUntracked = toNumber(pool.totalValueLockedUSDUntracked);
    const poolVolumeUsd = toNumber(pool.volumeUSD);
    const poolTotalFeesUsd = toNumber(pool.totalFeesUSD);

    const createdAtTimestamp = toNumber(raw.createdAtTimestamp);
    const priceInput = {
      chainId: integration.chainId,
      token0: { address: token0.id, decimals: decimals0, verified: token0.verified === true, symbol: token0.symbol },
      token1: { address: token1.id, decimals: decimals1, verified: token1.verified === true, symbol: token1.symbol },
      sqrtPriceX96,
      tick: currentTick,
      poolTvlUsd,
      poolTvlUsdUntracked,
      poolVolumeUsd,
      poolTotalFeesUsd,
    };

    const prices = await this.pricing.pricePool(priceInput);

    const computedAmounts = this.pricing.positionAmounts({
      liquidity,
      tickLower,
      tickUpper,
      sqrtPriceX96,
      currentTick,
      decimals0,
      decimals1,
    });

    const amount0 = firstNumber(computedAmounts?.amount0, raw.amount0);
    const amount1 = firstNumber(computedAmounts?.amount1, raw.amount1);
    const deposited0 = toNumber(raw.depositedToken0);
    const deposited1 = toNumber(raw.depositedToken1);
    const withdrawn0 = toNumber(raw.withdrawnToken0);
    const withdrawn1 = toNumber(raw.withdrawnToken1);
    const computedPendingFeesUsd =
      toNumber(raw.totalFeesUncollected0) * prices.token0Usd +
      toNumber(raw.totalFeesUncollected1) * prices.token1Usd;
    const computedCollectedFeesUsd =
      toNumber(raw.totalFeesCollected0) * prices.token0Usd +
      toNumber(raw.totalFeesCollected1) * prices.token1Usd;
    const pendingFeesUsd = computedPendingFeesUsd;
    const collectedFeesUsd = computedCollectedFeesUsd;
    const totalFeesUsd = pendingFeesUsd + collectedFeesUsd;
    const computedUnderlyingValueUsd = amount0 * prices.token0Usd + amount1 * prices.token1Usd;
    const underlyingValueUsd = computedUnderlyingValueUsd;
    const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000) - createdAtTimestamp);
    const isActive = raw.isActive !== false && BigIntOrZero(liquidity) > 0n && !raw.closedAtTimestamp;
    const hasCompleteHeldAssetPricing =
      (amount0 <= 0 || prices.token0Usd > 0) &&
      (amount1 <= 0 || prices.token1Usd > 0);
    const valuation = assessValuation({
      underlyingValueUsd,
      poolTvlUsd,
      poolTvlUsdUntracked,
      poolVolumeUsd,
      poolTotalFeesUsd,
      hasPriceSource: prices.source !== 'none' && hasCompleteHeldAssetPricing,
      subgraphPriceable: raw.isPriceable !== false,
    });
    const hasReliablePricing = valuation.accepted;
    const pricingSource = hasReliablePricing ? prices.source : 'none';
    const pricingUsedFallback = prices.usedFallback || !hasReliablePricing;

    return {
      chainId: integration.chainId,
      protocol: integration.protocol,
      positionId: tokenId,
      tokenId,
      owner: String(raw.owner ?? '').toLowerCase(),
      poolId: String(pool.id).toLowerCase(),
      token0: {
        address: token0.id.toLowerCase(),
        symbol: token0.symbol ?? token0.id.slice(0, 6),
        decimals: decimals0,
        verified: token0.verified === true,
        priceUsd: prices.token0Usd,
      },
      token1: {
        address: token1.id.toLowerCase(),
        symbol: token1.symbol ?? token1.id.slice(0, 6),
        decimals: decimals1,
        verified: token1.verified === true,
        priceUsd: prices.token1Usd,
      },
      fee: toNumber(pool.fee),
      tickSpacing: toNumber(pool.tickSpacing),
      tickLower,
      tickUpper,
      currentTick,
      sqrtPriceX96,
      liquidity,
      isActive,
      createdAtTimestamp,
      closedAtTimestamp: raw.closedAtTimestamp ? toNumber(raw.closedAtTimestamp) : null,
      amounts: {
        amount0: String(amount0),
        amount1: String(amount1),
        depositedToken0: String(deposited0),
        depositedToken1: String(deposited1),
        depositedUsd: '0',
        withdrawnToken0: String(withdrawn0),
        withdrawnToken1: String(withdrawn1),
        withdrawnUsd: '0',
        totalFeesCollected0: String(toNumber(raw.totalFeesCollected0)),
        totalFeesCollected1: String(toNumber(raw.totalFeesCollected1)),
        totalFeesCollectedUsd: String(finite(hasReliablePricing ? collectedFeesUsd : 0)),
        totalFeesUncollected0: String(toNumber(raw.totalFeesUncollected0)),
        totalFeesUncollected1: String(toNumber(raw.totalFeesUncollected1)),
        totalFeesUncollectedUsd: String(finite(hasReliablePricing ? pendingFeesUsd : 0)),
        totalGasCostEth: String(toNumber(raw.totalGasCostETH)),
        totalGasCostUsd: '0',
        diffToken0: String(toNumber(raw.diffToken0)),
        diffToken1: String(toNumber(raw.diffToken1)),
        diffUsd: '0',
      },
      metrics: {
        apr: 0,
        aprExGas: 0,
        feeApr: 0,
        poolApr: finite(toNumber(raw.poolAPR)),
        roi: 0,
        pnlUsd: 0,
        pnlEth: 0,
        pnlHodl: 0,
        poolPnlUsd: 0,
        divergenceLossUsd: 0,
        underlyingValueUsd: finite(hasReliablePricing ? underlyingValueUsd : 0),
        pendingFeesUsd: finite(hasReliablePricing ? pendingFeesUsd : 0),
        collectedFeesUsd: finite(hasReliablePricing ? collectedFeesUsd : 0),
        totalFeesUsd: finite(hasReliablePricing ? totalFeesUsd : 0),
        totalGasCostUsd: 0,
        investedUsd: 0,
        depositedUsd: 0,
        withdrawnUsd: 0,
        diffUsd: 0,
        unclaimedRewardsUsd: finite(toNumber(raw.unclaimedRewardsUSD)),
        claimedRewardsUsd: finite(toNumber(raw.claimedRewardsUSD)),
        ageSeconds,
        inRange: currentTick >= tickLower && currentTick <= tickUpper,
        isPriceable: hasReliablePricing,
        performanceReady: false,
        performanceSource: 'pending-transactions',
        aprWarmup: false,
      },
      poolStats: {
        tvlUsd: finite(poolTvlUsd),
        tvlUsdUntracked: finite(poolTvlUsdUntracked),
        volumeUsd: finite(poolVolumeUsd),
        totalFeesUsd: finite(poolTotalFeesUsd),
        priceDivergence: finite(toNumber(pool.priceDivergence)),
      },
      pricing: {
        source: pricingSource,
        usedFallback: pricingUsedFallback,
        pricedAt: new Date(),
      },
    };
  }

  private normalizeTransaction(
    raw: RevertPositionTx,
    integration: IntegrationConfig,
  ): NormalizedPositionTransaction {
    const positionId = String(raw.tokenId ?? '');
    const txHash = String(raw.transaction ?? '').toLowerCase();
    const logIndex = toNumber(raw.logIndex);
    return {
      chainId: integration.chainId,
      protocol: integration.protocol,
      positionId,
      tokenId: String(raw.tokenId ?? positionId),
      transactionId: String(raw.id ?? `${txHash}-${logIndex}`),
      txHash,
      type: String(raw.type ?? 'UNKNOWN'),
      timestamp: toNumber(raw.timestamp),
      amount0: String(toNumber(raw.amount0)),
      amount1: String(toNumber(raw.amount1)),
      amount0PriceUsd: finite(toNumber(raw.amount0PriceUSD)),
      amount1PriceUsd: finite(toNumber(raw.amount1PriceUSD)),
      amount0PriceUsdUntracked: finite(toNumber(raw.amount0PriceUSDUntracked)),
      amount1PriceUsdUntracked: finite(toNumber(raw.amount1PriceUSDUntracked)),
      amount0HistoricalPriceUsd: 0,
      amount1HistoricalPriceUsd: 0,
      historicalValueUsd: 0,
      historicalPricingSource: 'none',
      gasCostEth: finite(toNumber(raw.gasCostETH)),
      gasCostUsd: finite(toNumber(raw.gasCostUSD)),
      sender: String(raw.sender ?? '').toLowerCase(),
      logIndex,
      rawSubgraph: raw as unknown as Record<string, unknown>,
    };
  }
}

function toNumber(value: unknown, fallback = 0): number {
  const parsed = typeof value === 'number' ? value : Number(value ?? fallback);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalNumber(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function firstNumber(...values: unknown[]): number {
  for (const value of values) {
    const parsed = optionalNumber(value);
    if (parsed !== undefined) return parsed;
  }
  return 0;
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function BigIntOrZero(value: string): bigint {
  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (values.length === 0) return [];

  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), values.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < values.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        const value = values[currentIndex];
        if (value === undefined) continue;
        results[currentIndex] = await mapper(value, currentIndex);
      }
    }),
  );

  return results;
}

/**
 * Retry wrapper around `GraphQLClient.request` for transient gateway
 * errors (5xx). The Graph gateway and many subgraph hosts surface short
 * Cloudflare/nginx outages as 5xx responses several times per hour; a
 * single attempt is not enough to survive a long backfill walk. Default
 * 4 attempts × exponential backoff (1s / 2s / 4s + jitter) covers up to
 * ~10s of upstream unavailability.
 *
 * Non-5xx errors (timeouts thrown as `Error`, parse errors, auth) bubble
 * up immediately — those are not transient and retrying just wastes the
 * provider's rate-limit budget.
 */
const REQUEST_RETRY_MAX_ATTEMPTS = Math.max(1, Number(process.env.SUBGRAPH_RETRY_ATTEMPTS) || 4);
const REQUEST_RETRY_BASE_MS = Math.max(100, Number(process.env.SUBGRAPH_RETRY_BASE_MS) || 1000);
const requestRetryLogger = new Logger('SubgraphRequestRetry');

async function requestWithRetry<T>(
  client: GraphQLClient,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= REQUEST_RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      return await client.request<T>(query, variables ?? {});
    } catch (err) {
      lastErr = err;
      const status = (err as { response?: { status?: number } })?.response?.status ?? 0;
      // Retry transient network failures too — not just HTTP 5xx. Under heavy
      // parallel load the Graph gateway drops sockets (UND_ERR_SOCKET / "other
      // side closed" / ECONNRESET) and rate-limits (429); these have no HTTP
      // status and previously threw immediately, escaping as unhandled
      // rejections. Treat them as retriable so a blip recovers silently.
      const code =
        (err as { code?: string })?.code ??
        (err as { cause?: { code?: string } })?.cause?.code ??
        '';
      const message = err instanceof Error ? err.message : String(err);
      const networkError =
        /fetch failed|other side closed|socket|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR/i.test(
          `${message} ${code}`,
        );
      const retriable = (status >= 500 && status < 600) || status === 429 || networkError;
      if (!retriable || attempt === REQUEST_RETRY_MAX_ATTEMPTS) throw err;
      const jitter = Math.floor(Math.random() * 250);
      const delay = REQUEST_RETRY_BASE_MS * Math.pow(2, attempt - 1) + jitter;
      requestRetryLogger.warn(
        `subgraph ${status || code || 'network-error'} on attempt ${attempt}/${REQUEST_RETRY_MAX_ATTEMPTS}, retrying in ${delay}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastErr;
}
