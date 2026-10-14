import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { GraphQLClient, gql } from 'graphql-request';
import { subgraphFetch } from '../hyperindex/client.js';
import { requestWithRetry } from '../request-retry.js';
import { isWhitelistedToken } from './whitelist-tokens.js';
import { PricingService, type AmountInput, type PriceConfidence, type PriceResult } from '../../pricing/pricing.service.js';
import {
  crossCheckAllowlistedPair,
  deriveQuotelessLeg,
  enforcePoolConsistency,
  enforceRealizability,
  isReferenceLeg,
  meetsMarketBackingFloor,
  poolRatio,
  trustRank,
  type LegTrust,
} from '../../pricing/pool-consistency.js';
import { AppConfigService } from '../../config/app-config.service.js';
import { isAnchorTokenStandalone } from '../../pricing/pricing-policy.js';
import { trustPolicyOf } from '../../pricing/token-trust.js';
import { evaluatePoolTvl } from '../../sync/pools-sync.service.js';
import { isAnchorPair } from '../../common/pool-fee.js';
import { PoolsRepository } from '../../database/pools.repository.js';
import { PositionsRepository } from '../../database/positions.repository.js';
import { chooseUncollected, type RpcFees } from '../../sync/position-fee-math.js';
import type { IntegrationConfig } from '../../config/integrations.config.js';
import { assessValuation } from '../../valuation/valuation-guard.js';
import type {
  FetchPositionTransactionsResult,
  FetchPositionsResult,
  NormalizedPosition,
  NormalizedPositionTransaction,
} from '../normalized-position.js';
import type {
  FetchPositionsOptions,
  PositionAdapter,
  PositionTimestampRange,
  TokenIdRange,
  TokenIdRangeStats,
  TokenIdWalkOptions,
  TokenIdWalkResult,
} from '../position-adapter.js';
import { TokenIdEdgeQueryError } from '../position-adapter.js';
import { IndexerEntityCache } from './indexer-entity-cache.js';

// ─── P3.1: the first fee reading inside the backfill (`BACKFILL_FEE_READ`) ────
/**
 * One active row of a backfill page, as the fee reader measures it — the same
 * fields as the fee job's candidate (`FeeRefreshCandidate`), so its measurer
 * serves both.
 */
export interface PageFeeRow {
  positionId: string;
  tokenId: string;
  poolId: string;
  tickLower: number;
  tickUpper: number;
  decimals0: number;
  decimals1: number;
  lastModifyBlock: number;
}

/**
 * Measures uncollected fees on-chain for a page's ACTIVE rows (implemented by
 * the fee package's `FeeMeasurer`: the fee job's multicall, head pin and
 * gas-split, on the RPC budget's `backfill` lane). Returns a reading per row it
 * could measure, keyed by positionId; a row it could not is simply absent (the
 * backfill then queues it for the fee job, as before). Must not throw for a
 * per-row failure; a whole-call failure may reject (treated as "nothing read").
 *
 * The walk waits for the answer at most `PAGE_FEE_READ_DEADLINE_MS` (one RPC
 * timeout, design §7); a later answer is discarded as "nothing read" and
 * `signal` is aborted, so a reader that honours it can stop issuing calls for a
 * range nobody is waiting for.
 */
export interface PageFeeReader {
  measure(
    chainId: number,
    protocol: string,
    rows: PageFeeRow[],
    opts?: { signal?: AbortSignal },
  ): Promise<Map<string, PageFeeReading>>;
}

/**
 * A P3.1 reading. `fees0Exact`/`fees1Exact` are the reader's exact decimal
 * strings (`formatUnits`), stamped verbatim when present: the numbers are
 * lossy past ~17 significant digits and `String(number)` turns exponent-form
 * below 1e-6 / at 1e21 (`'1.2e-7'`), which the fee job's stamp never is and
 * the fee candidate store refuses as unreadable.
 */
export interface PageFeeReading extends RpcFees {
  readonly fees0Exact?: string;
  readonly fees1Exact?: string;
}

/** Injection token for the reader (bound by the integrator; absent = P3.1 off). */
export const PAGE_FEE_READER = 'PAGE_FEE_READER';

/**
 * How long a range waits for its P3.1 reading: ONE RPC timeout (the measurer's
 * clients use 30 s). The reader's own retries (viem retries a timeout; the
 * head read is attempted twice) would otherwise hold a range for ~2-4 minutes
 * against a hanging RPC, and the ordered writer stalls behind it.
 */
export const PAGE_FEE_READ_DEADLINE_MS = 30_000;

const PLAIN_DECIMAL = /^\d+(\.\d+)?$/;

/**
 * A non-negative finite number as a plain decimal string — never exponent form
 * (`1.2e-7` → `'0.00000012'`, `1e21` → `'1000000000000000000000'`). The digits
 * are the number's shortest round-trip form, so `Number(result) === n`.
 */
export function plainDecimal(n: number): string {
  const s = String(n);
  const m = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/i.exec(s);
  if (!m) return s;
  const [, sign, intPart, frac = '', expStr] = m;
  const digits = `${intPart}${frac}`;
  const point = intPart!.length + Number(expStr);
  let out: string;
  if (point <= 0) out = `0.${'0'.repeat(-point)}${digits}`;
  else if (point >= digits.length) out = `${digits}${'0'.repeat(point - digits.length)}`;
  else out = `${digits.slice(0, point)}.${digits.slice(point)}`;
  if (out.includes('.')) out = out.replace(/0+$/, '').replace(/\.$/, '');
  out = out.replace(/^0+(?=\d)/, '');
  return `${sign}${out}`;
}

/**
 * The stamp string for one leg of a P3.1 reading: the reader's exact decimal
 * when it is a plain decimal that agrees with the served number, else the
 * number in plain decimal form (never `String(number)`'s exponent form).
 */
export function feeStampString(exact: string | undefined, n: number): string {
  if (typeof exact === 'string' && PLAIN_DECIMAL.test(exact) && Number(exact) === n) return exact;
  return plainDecimal(n);
}

/**
 * Stored readings with this walk's fresh ones merged over them: the HIGHER
 * block wins (a tie goes to the fresh reading, taken later — the repository's
 * stamp guard accepts the same tie). `freshIds` = the rows whose winning
 * reading is the fresh one — the only rows that may carry the `rpcFees*` stamp
 * into the upsert. A stored reading newer than the fresh one (the fee job got
 * there first) stays, and the row carries no stamp.
 *
 * A fresh reading without `at` (optional in `RpcFees`) gets `now` HERE, once,
 * before normalize: the served `metrics.feesMeasuredAt` and the stored
 * `rpcFeesAt` stamp then name the same instant (normalize used to serve `null`
 * beside a stamp of `new Date()`).
 */
export function mergeFeeReadings(
  stored: ReadonlyMap<string, RpcFees>,
  fresh: ReadonlyMap<string, RpcFees>,
  now: Date = new Date(),
): { fees: Map<string, RpcFees>; freshIds: Set<string> } {
  const fees = new Map(stored);
  const freshIds = new Set<string>();
  for (const [id, reading] of fresh) {
    if (!Number.isFinite(reading.block) || !Number.isFinite(reading.fees0) || !Number.isFinite(reading.fees1)) continue;
    const prev = stored.get(id);
    if (!prev || reading.block >= prev.block) {
      fees.set(id, reading.at instanceof Date ? reading : { ...reading, at: now });
      freshIds.add(id);
    }
  }
  return { fees, freshIds };
}

/**
 * The ordered writer of a range walk. Up to `lookahead + 1` ranges are being
 * prepared (fetched, priced, measured, normalized) at once; `write` is called
 * for them strictly in the order `next` produced them, one at a time, so a
 * caller that persists a cursor after each `write` can never record a range as
 * done while an earlier one is not. Stops — without starting a new range or
 * writing a prepared one — once `signal` is aborted; a range already being
 * written finishes. A failed prepare or write rejects the walk; prepares still
 * in flight are abandoned (their rejections are swallowed here).
 */
export async function runRangePipeline<R, P>(opts: {
  next: () => Promise<R | null>;
  prepare: (range: R) => Promise<P>;
  write: (range: R, prepared: P) => Promise<void>;
  lookahead: number;
  signal?: AbortSignal;
}): Promise<{ aborted: boolean; written: number }> {
  const depth = Math.max(0, Math.floor(Number.isFinite(opts.lookahead) ? opts.lookahead : 0)) + 1;
  const queue: Array<{ range: R; prepared: Promise<P> }> = [];
  let exhausted = false;
  let written = 0;
  for (;;) {
    // No new range once aborted (the fill stops); an empty queue then ends the
    // walk below, a prepared head is dropped by the check before its write.
    while (!exhausted && queue.length < depth && !opts.signal?.aborted) {
      const range = await opts.next();
      if (range === null) {
        exhausted = true;
        break;
      }
      const prepared = opts.prepare(range);
      // Observed at the head; an abandoned one must not become an unhandled rejection.
      prepared.catch(() => undefined);
      queue.push({ range, prepared });
    }
    const head = queue.shift();
    if (!head) return { aborted: opts.signal?.aborted === true, written };
    const prepared = await head.prepared;
    // Fetched but not written: re-fetched on resume (the cursor never passed it).
    if (opts.signal?.aborted) return { aborted: true, written };
    await opts.write(head.range, prepared);
    written += 1;
  }
}

// ─── Indexer row shapes ──────────────────────────────────────────────────────
// The indexer declares no relations on the position table (poolId/token ids are
// plain text), so there is NO nested `pool {}` — pools + tokens are fetched in
// batches by id. Amounts arrive as human-readable numbers; bigint fields
// (timestamps, liquidity) arrive as strings.
interface IndexedPosition {
  chainId: number;
  tokenId: string;
  owner: string;
  poolId: string;
  tickLower: number;
  tickUpper: number;
  liquidity: string;
  isActive: boolean;
  isPriceable: boolean;
  createdAtTimestamp: string;
  createdAtBlockNumber: string;
  closedAtTimestamp: string | null;
  depositedToken0: number;
  depositedToken1: number;
  withdrawnToken0: number;
  withdrawnToken1: number;
  totalFeesCollected0: number;
  totalFeesCollected1: number;
  // No uncollected-fee figure and no fee-sweep watermark here: the indexer no
  // longer carries `totalFeesUncollected0/1` / `feesUpdatedAtBlock` (its fee
  // sweep is gone), and the query below must not select them — Hasura rejects
  // the WHOLE query when one selected field does not exist. The served figure
  // is the on-chain measurement alone (see chooseUncollected).
  amount0: number;
  amount1: number;
  totalGasCostETH: number;
  updatedAtBlock: string;
  /**
   * Block of the last ModifyLiquidity — written only by the modify handler, so
   * unlike `updatedAtBlock` a Transfer does not move it. The freshness key for
   * an on-chain fee measurement (see chooseUncollected).
   */
  lastModifyBlock?: string;
  updatedAtTimestamp: string;
  // NO totalFeesUncollected0/1 and no feesUpdatedAtBlock: the indexer stopped
  // computing uncollected fees (its sweep stalled indexing on a StateView
  // multicall, and we already preferred our own on-chain reading over its figure).
  // `PositionFeeRefreshService` is the only source now — see the chooseUncollected
  // call below.
}
interface IndexedPool {
  id: string;
  name: string;
  fee: number;
  tickSpacing: number;
  tick: number;
  sqrtPriceX96: string;
  token0Id: string;
  token1Id: string;
}
interface IndexedToken {
  id: string;
  symbol: string;
  name: string;
  decimals: number;
  verified: boolean;
}
export interface IndexedTx {
  chainId: number;
  txHash: string;
  logIndex: number;
  type: string;
  tokenId: string;
  amount0: number;
  amount1: number;
  gasCostETH: number;
  timestamp: string;
  blockNumber: string;
  sender: string;
}
// Pool stats (TVL/volume/fees) come from the same indexer's Pool entity, queried
// in a batch per page by poolId. The per-token reserves feed
// the quoteless-leg derivation's realizability check (real reference-side
// backing, NOT the USD TVL — which is itself priced via derivedETH and can be
// fabricated by a seeded pool).
interface PoolStatsRow {
  id: string;
  totalValueLockedUSD?: string;
  totalValueLockedUSDUntracked?: string;
  totalValueLockedToken0?: string;
  totalValueLockedToken1?: string;
  volumeUSD?: string;
  feesUSD?: string;
}

const POSITION_FIELDS = `
  chainId tokenId owner poolId tickLower tickUpper liquidity
  isActive isPriceable createdAtTimestamp createdAtBlockNumber closedAtTimestamp
  depositedToken0 depositedToken1 withdrawnToken0 withdrawnToken1
  totalFeesCollected0 totalFeesCollected1
  amount0 amount1 totalGasCostETH updatedAtBlock updatedAtTimestamp
  lastModifyBlock
`;

/*
 * Every query below is in THE SUBGRAPH DIALECT, and goes out through
 * `subgraphFetch`, which translates it to Hasura in `src/subgraph/hyperindex/`.
 *
 * There used to be a second set of these in Ponder's dialect — cursor paging
 * (`limit`/`after`), `{ items, pageInfo }` envelopes, quoted `orderBy` strings —
 * switched on at runtime by whether `ponderUrl` was set. Both sets existed so the
 * two indexers could be diffed field by field through one normalization path
 * during the migration. That comparison is done, and the Ponder half is gone.
 *
 * Doing the translation here rather than in the indexer means ONE converter for
 * every entity — the same one already serving pools, tokens and the interval
 * snapshots.
 */
const SG_POSITIONS_QUERY = gql`
  query Positions($where: Position_filter, $orderDirection: String!, $first: Int!, $skip: Int!) {
    positions(where: $where, orderBy: createdAtTimestamp, orderDirection: $orderDirection, first: $first, skip: $skip) {
      ${POSITION_FIELDS}
    }
  }
`;

/*
 * Three columns are ALIASED rather than renamed downstream: `normalize` reads
 * `fee`/`sqrtPriceX96`/`token0Id`, and a missing property there is `undefined`,
 * which prices a position at ZERO instead of failing. Aliasing in the query keeps
 * the response shape stable so nothing below has to know the column names.
 */
const SG_POOLS_QUERY = gql`
  query Pools($where: Pool_filter, $first: Int!) {
    pools(where: $where, first: $first) {
      id
      name
      fee: feeTier
      tickSpacing
      tick
      sqrtPriceX96: sqrtPrice
      token0Id: token0
      token1Id: token1
    }
  }
`;

/*
 * No `verified`: the indexer does not carry that column, and it was never indexed
 * from chain data on the Ponder side either — it was computed there from a static
 * per-chain whitelist. The same list lives in `whitelist-tokens.ts` and is applied
 * to these rows below, so the field means exactly what it always meant. See that
 * file for why the DEFAULT matters: `verified` feeds `legTrust`, so letting it
 * fall to `false` would demote every token a tier and change what counts as value.
 */
const SG_TOKENS_QUERY = gql`
  query Tokens($where: Token_filter, $first: Int!) {
    tokens(where: $where, first: $first) { id symbol name decimals }
  }
`;

/**
 * The PositionTransaction columns every transaction read selects. Exported, with
 * `envioTxWhere` and `normalizeEnvioTransaction`, for the charts input batch
 * (`charts/chart-inputs.service.ts`), which puts the first transaction page into
 * the same document as the chart's other roots: one definition, so a row read
 * there normalizes to exactly what this adapter returns.
 */
export const ENVIO_TX_SELECTION = 'chainId txHash logIndex type tokenId amount0 amount1 gasCostETH timestamp blockNumber sender';

const SG_TXNS_QUERY = gql`
  query Txns($where: PositionTransaction_filter, $first: Int!, $skip: Int!) {
    positionTransactions(where: $where, orderBy: timestamp, orderDirection: asc, first: $first, skip: $skip) {
      ${ENVIO_TX_SELECTION}
    }
  }
`;

/**
 * The same read, newest first (`newestFirst`). A separate document rather than a
 * direction variable so the ascending walk every other caller makes stays
 * byte-identical. The translator appends `id asc` to the ORDER BY either way,
 * so ties come back id-ascending inside each timestamp.
 */
const SG_TXNS_NEWEST_QUERY = gql`
  query TxnsNewest($where: PositionTransaction_filter, $first: Int!, $skip: Int!) {
    positionTransactions(where: $where, orderBy: timestamp, orderDirection: desc, first: $first, skip: $skip) {
      ${ENVIO_TX_SELECTION}
    }
  }
`;

const SG_RANGE_QUERY = gql`
  query Range($where: Position_filter) {
    min: positions(where: $where, orderBy: createdAtTimestamp, orderDirection: asc, first: 1) { createdAtTimestamp }
    max: positions(where: $where, orderBy: createdAtTimestamp, orderDirection: desc, first: 1) { createdAtTimestamp }
  }
`;

/*
 * BACKFILL_PAGING=tokenid. A range `[a, b)` of tokenIds, ordered by tokenId —
 * served by the indexer's single-column `tokenId` index, so the cost of a page
 * does not grow with how far the walk has got (the createdAt walk's `skip` and
 * its sort on an UNINDEXED `createdAtTimestamp` did). The converter appends
 * `id asc` to the ORDER BY; tokenIds are unique per chain, so it never decides.
 */
const SG_POSITIONS_BY_TOKENID_QUERY = gql`
  query PositionsByTokenId($where: Position_filter, $first: Int!, $skip: Int!) {
    positions(where: $where, orderBy: tokenId, orderDirection: asc, first: $first, skip: $skip) {
      ${POSITION_FIELDS}
    }
  }
`;

/** The lowest / highest tokenId matching `where` (one index scan step). */
const SG_TOKENID_EDGE_QUERY = gql`
  query TokenIdEdge($where: Position_filter, $orderDirection: String!) {
    positions(where: $where, orderBy: tokenId, orderDirection: $orderDirection, first: 1) {
      tokenId
    }
  }
`;

/*
 * The pools of ONE range in ONE request: the static columns, the DYNAMIC ones
 * (`tick`, `sqrtPrice` — never cached across ranges, they move with every
 * swap) and the poolStats columns. With the pipeline on this replaces the
 * separate pools + poolStats requests per page. Same aliases as
 * `SG_POOLS_QUERY` (normalize reads `fee`/`sqrtPriceX96`/`token0Id`).
 */
const SG_RANGE_POOLS_QUERY = gql`
  query RangePools($where: Pool_filter, $first: Int!) {
    pools(where: $where, first: $first) {
      id
      name
      fee: feeTier
      tickSpacing
      tick
      sqrtPriceX96: sqrtPrice
      token0Id: token0
      token1Id: token1
      totalValueLockedUSD
      totalValueLockedUSDUntracked
      totalValueLockedToken0
      totalValueLockedToken1
      volumeUSD
      feesUSD
    }
  }
`;

const POOL_STATS_QUERY = gql`
  query PoolStats($ids: [ID!]!) {
    # first: 1000 is LOAD-BEARING, not tidiness. The subgraph dialect defaults to
    # 100 rows when \`first\` is omitted (DEFAULT_FIRST in schema-map.ts, which the
    # converter honours), and a positions page can touch far more unique pools.
    # Silently-missing stats DISABLE the realizability check for those pools —
    # which is how an $8M full-supply launch LP once slipped through into stored
    # position values. 1000 is also the hard cap (MAX_FIRST); above it the
    # converter refuses the query rather than truncating.
    pools(where: { id_in: $ids }, first: 1000) {
      id
      totalValueLockedUSD
      totalValueLockedUSDUntracked
      totalValueLockedToken0
      totalValueLockedToken1
      volumeUSD
      feesUSD
    }
  }
`;

const INDEXER_PAGE_MAX = 1000;

/**
 * The most pages a transaction walk reads however many it is asked for — the
 * loop bound `fetchPositionTransactions` always had, kept so `maxPages <= 0`
 * ("no limit") still terminates.
 */
const TX_WALK_MAX_PAGES = 1000;

/** The `where` of a transaction read: these positions on this chain, optionally after a timestamp. */
export function envioTxWhere(
  integration: Pick<IntegrationConfig, 'chainId'>,
  positionIds: string[],
  sinceTimestamp = 0,
): Record<string, unknown> {
  const where: Record<string, unknown> = { chainId: integration.chainId, tokenId_in: positionIds };
  if (sinceTimestamp > 0) where.timestamp_gt = String(sinceTimestamp);
  return where;
}

/**
 * A newest-first page put back into the order an ascending walk returns.
 * The upstream order is `timestamp desc, id asc`; a STABLE sort on timestamp
 * alone gives `timestamp asc, id asc` — exactly the ascending walk's order,
 * ties included — without the indexer id, which no tx read selects.
 */
export function oldestFirst<T extends { timestamp: number }>(newestFirstRows: T[]): T[] {
  return [...newestFirstRows].sort((a, b) => a.timestamp - b.timestamp);
}

/** First occurrence of each `transactionId`, in order. */
function uniqueTransactions(rows: NormalizedPositionTransaction[]): NormalizedPositionTransaction[] {
  const seen = new Set<string>();
  return rows.filter((tx) => (seen.has(tx.transactionId) ? false : (seen.add(tx.transactionId), true)));
}

/** One indexed PositionTransaction row → the normalized transaction every caller receives. */
export function normalizeEnvioTransaction(
  raw: IndexedTx,
  integration: Pick<IntegrationConfig, 'chainId' | 'protocol'>,
): NormalizedPositionTransaction {
  const tokenId = String(raw.tokenId);
  const txHash = String(raw.txHash ?? '').toLowerCase();
  const logIndex = toNumber(raw.logIndex);
  return {
    chainId: integration.chainId,
    protocol: integration.protocol,
    positionId: tokenId,
    tokenId,
    transactionId: `${txHash}-${logIndex}-${raw.type}`,
    txHash,
    type: String(raw.type),
    timestamp: toNumber(raw.timestamp),
    amount0: String(toNumber(raw.amount0)),
    amount1: String(toNumber(raw.amount1)),
    amount0PriceUsd: 0,
    amount1PriceUsd: 0,
    amount0PriceUsdUntracked: 0,
    amount1PriceUsdUntracked: 0,
    amount0HistoricalPriceUsd: 0,
    amount1HistoricalPriceUsd: 0,
    historicalValueUsd: 0,
    historicalPricingSource: 'none',
    gasCostEth: toNumber(raw.gasCostETH),
    gasCostUsd: 0,
    sender: String(raw.sender ?? '').toLowerCase(),
    logIndex,
    rawSubgraph: raw as unknown as Record<string, unknown>,
  };
}

/**
 * Position adapter sourcing from the Ponder indexer (the post-cutover source for
 * Uniswap v4). Mirrors `RevertCompatibleAdapter`'s `PositionAdapter` contract so
 * the rest of the sync pipeline (normalize → upsert → recompute → leaderboard)
 * is unchanged. Differences from the vanilla subgraph:
 *   - amounts arrive HUMAN-readable (no tick-math recompute needed);
 *   - pool TVL/volume/fees come from the vanilla subgraph (Ponder lacks them);
 *   - token USD prices come from the pricing service (Ponder lacks them).
 * Metrics are left zero on normalize — the existing recompute fills them from
 * the position-row aggregates + current prices (vs-HODL), exactly as today.
 *
 * NOTE: the cursor walk uses `createdAtTimestamp_gte` + a post-filter on
 * `(createdAtTimestamp, tokenId)` (same strategy as the revert adapter) so it is
 * robust to Ponder's single-field ordering. Runtime cursor/where behaviour is to
 * be validated against a live Ponder during Phase-8 cutover.
 */
@Injectable()
export class EnvioAdapter implements PositionAdapter {
  readonly protocol = 'uniswap-v4';
  // Ponder accumulates cashflow aggregates on the position row → vs-HODL metrics
  // recompute without tx history (see AggregateRecomputeService).
  readonly recomputeMode: 'aggregates' = 'aggregates';
  private readonly logger = new Logger(EnvioAdapter.name);

  constructor(
    @Inject(PricingService) private readonly pricing: PricingService,
    @Inject(PoolsRepository) private readonly poolsRepo: PoolsRepository,
    @Inject(AppConfigService) private readonly config: AppConfigService,
    // Appended and @Optional: specs construct this adapter positionally, and a
    // missing repository only means no on-chain fee overlay (indexer figures).
    @Optional() @Inject(PositionsRepository) private readonly positionsRepo?: PositionsRepository,
    // APPENDED and optional: P3.1's reader. Absent = no fee read in the walk
    // (the backfill lane of the fee job measures the rows, as before).
    @Optional() @Inject(PAGE_FEE_READER) private readonly feeReader?: PageFeeReader,
  ) {}

  /** How long a range waits for its P3.1 reading (a field so specs can shorten it). */
  pageFeeReadDeadlineMs = PAGE_FEE_READ_DEADLINE_MS;

  private emptyResult(options: FetchPositionsOptions): FetchPositionsResult {
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

  async fetchPositions(options: FetchPositionsOptions): Promise<FetchPositionsResult> {
    const integration = options.integration;

    // A chain with no configured source returns zero positions, and a bare
    // `emptyResult` made that indistinguishable from "nothing new to sync" —
    // the run is recorded `status: success, fetched: 0` either way. That is how
    // an Ethereum integration sat empty for five days: two sync runs finished in
    // 39ms reporting success, and nothing anywhere said why. Same alert the
    // transactions path already raises, for the same reason.
    const src = this.positionSource(integration);
    if (!src) {
      this.warnMissingSourceOnce(integration.chainId, integration.protocol);
      return this.emptyResult(options);
    }
    // Pool stats (TVL/volume/fees) come from the SAME client now. They used to
    // need a separate one because positions were on Ponder and stats on the
    // vanilla subgraph; both are the Envio indexer today.
    const chainId = integration.chainId;

    const refresh = options.mode === 'refresh';
    const latestOnlyLimit = refresh ? 0 : Math.max(0, options.latestOnlyLimit ?? 0);
    const orderDirection = latestOnlyLimit > 0 ? 'desc' : 'asc';
    const maxPages = options.maxPages <= 0 ? Number.MAX_SAFE_INTEGER : options.maxPages;
    const flushThreshold = options.flushThreshold ?? 0;
    const concurrency = Math.max(1, options.normalizationConcurrency ?? 10);

    const collected: NormalizedPosition[] = [];
    /*
     * Ids of the positions this walk returned — needed ONLY by the refresh,
     * whose stale sweep diffs the active set against them. A backfill walk
     * returns `[]`: it used to accumulate every id it ever saw (3.5M strings
     * on a full Robinhood walk) for a caller that never read them. `kept`
     * counts what `latestOnlyLimit` needs instead.
     */
    const seenPositionIds: string[] = [];
    let kept = 0;
    let maxTimestamp = options.cursorTimestamp;
    let maxPositionId = options.cursorPositionId ?? '';
    let maxBlockNumber = 0;
    let flushedCount = 0;
    let hasMore = false;
    /*
     * Rows the SERVER has returned so far in this walk — and therefore the ONLY
     * correct offset for the next page.
     *
     * It is deliberately not derived from anything downstream. `baseWhere` is
     * built once and never narrows, so page N+1 must skip exactly the rows
     * pages 0..N were handed, INCLUDING the ones we then discarded: the
     * post-filter's boundary dupes and any row `normalize` returned null for.
     * Both were still counted by the server when it built the page.
     */
    let fetchedCount = 0;

    // Build the `where` filter for the active mode.
    const baseWhere: Record<string, unknown> = { chainId };
    if (refresh) {
      const ids = options.positionIds ?? [];
      if (ids.length === 0) return this.emptyResult(options);
      baseWhere.tokenId_in = ids;
    } else if (latestOnlyLimit <= 0) {
      // Backfill: gte the cursor (post-filter removes the boundary dupes), with
      // an optional exclusive ceiling for parallel-bucket range walks.
      baseWhere.createdAtTimestamp_gte = String(options.cursorTimestamp);
      if (typeof options.maxTimestamp === 'number') {
        baseWhere.createdAtTimestamp_lt = String(options.maxTimestamp);
      }
    }

    for (let page = 0; page < maxPages; page++) {
      // Stopping (the shutdown signal): fetch nothing more. What is collected
      // is returned for the caller's residual flush, and `hasMore` keeps the
      // backfill flag set so the next boot resumes from the cursor.
      if (options.signal?.aborted) {
        hasMore = true;
        break;
      }
      const remainingLatest = latestOnlyLimit > 0 ? latestOnlyLimit - kept : Number.MAX_SAFE_INTEGER;
      if (remainingLatest <= 0) break;
      const limit = Math.min(INDEXER_PAGE_MAX, Math.max(1, refresh ? options.pageSize : Math.min(options.pageSize, remainingLatest === Number.MAX_SAFE_INTEGER ? options.pageSize : remainingLatest)));

      const pageResult = await this.fetchPositionsPage(src, {
        where: baseWhere,
        orderDirection,
        limit,
        // The offset is `fetchedCount` — rows the SERVER returned — and NOTHING
        // else.
        //
        // This WAS `seenPositionIds.length + flushedCount`, which double-counted
        // every flushed row: `seenPositionIds` was never trimmed on flush, so the
        // flushed rows stayed in it AND were added again via `flushedCount`. The
        // offset then advanced at ~2x the rate the server was consuming rows and
        // the walk skipped roughly half of them — measured 202,622 of 403,622
        // mainnet positions, in scattered chunks rather than one clean tail.
        // Invisible on Ponder (cursor paging ignored `skip`), which is why it
        // only became reachable with the Envio cutover.
        //
        // Do not derive it from `seenPositionIds`, `collected`, `rows` or
        // `normalized`: each of those has already dropped something the server
        // counted — boundary dupes from the post-filter below, and rows
        // `normalize` returned null for.
        skip: fetchedCount,
      });
      const items = pageResult.items;
      fetchedCount += items.length;

      // Post-filter: drop rows at/below the resume cursor (backfill only), so a
      // `_gte` boundary never re-emits already-seen positions.
      const rows = items.filter((p) => {
        if (refresh || latestOnlyLimit > 0) return true;
        const ts = toNumber(p.createdAtTimestamp);
        const id = String(p.tokenId);
        return ts > options.cursorTimestamp || (ts === options.cursorTimestamp && id > (options.cursorPositionId ?? ''));
      });

      if (rows.length > 0) {
        // Per-page fetches, parallelised to cut serial round-trips:
        //   stage 1 — pool keys + pool stats (both keyed by poolId);
        //   stage 2 — tokens + pricing prefetch (both keyed by the token ids the
        //   pools carry). Independent calls run concurrently instead of awaiting
        //   one another (5 serial → 2 stages).
        const poolIds = [...new Set(rows.map((r) => r.poolId.toLowerCase()))];
        const [pools, poolStats] = await Promise.all([
          this.fetchPools(src, chainId, poolIds),
          this.fetchPoolStats(src, poolIds, chainId, integration.protocol),
        ]);
        const tokenIds = [...new Set([...pools.values()].flatMap((p) => [p.token0Id.toLowerCase(), p.token1Id.toLowerCase()]))];
        // Prefetch warms the pricing cache for this page's tokens (batched by the
        // pricing layer) so per-position `pricePool` is cache-only — without it each
        // position walks the provider chain individually (the throughput killer).
        // Runs concurrently with the token fetch; keyed by address (symbols are only
        // used for dev-only price-miss logs).
        const prefetch =
          !options.skipPrefetch && tokenIds.length > 0
            ? this.pricing.prefetchPrices(chainId, tokenIds).catch((err) => {
                this.logger.warn(`price prefetch failed for ${tokenIds.length} tokens: ${(err as Error)?.message ?? String(err)}`);
              })
            : Promise.resolve();
        const tokens = await this.fetchTokens(src, chainId, tokenIds);
        // P3.1: the first on-chain fee reading of the page's ACTIVE rows, taken
        // while the prices finish (backfill only; nothing without a reader).
        const freshFees =
          options.feeRead === true && !refresh ? this.readPageFees(integration, rows, pools, tokens) : undefined;
        await prefetch;

        const stored = await this.loadRpcFees(integration, rows);
        const { fees: rpcFees, freshIds } = freshFees ? mergeFeeReadings(stored, await freshFees) : { fees: stored, freshIds: undefined };
        const extras = freshIds && freshIds.size > 0 ? { freshFeeIds: freshIds } : undefined;
        const normalized = await mapConcurrent(rows, concurrency, (raw) =>
          extras
            ? this.normalize(raw, integration, pools, tokens, poolStats, rpcFees, extras)
            : this.normalize(raw, integration, pools, tokens, poolStats, rpcFees),
        );
        for (const [i, pos] of normalized.entries()) {
          if (!pos) continue;
          if (latestOnlyLimit > 0 && kept >= latestOnlyLimit) break;
          collected.push(pos);
          kept += 1;
          if (refresh) seenPositionIds.push(pos.positionId);
          if (pos.createdAtTimestamp > maxTimestamp || (pos.createdAtTimestamp === maxTimestamp && pos.positionId > maxPositionId)) {
            maxTimestamp = pos.createdAtTimestamp;
            maxPositionId = pos.positionId;
          }
          maxBlockNumber = Math.max(maxBlockNumber, toNumber(rows[i]?.createdAtBlockNumber));
        }
      }

      if (flushThreshold > 0 && options.onFlush && collected.length >= flushThreshold) {
        flushedCount += await options.onFlush(collected, { maxTimestamp, maxPositionId, maxBlockNumber });
        collected.length = 0;
      }

      // `hasNextPage` is SYNTHESISED in `fetchPositionsPage` as
      // `items.length === limit`, compared against THIS page's limit rather than
      // the constant — `limit` shrinks page to page once `latestOnlyLimit` is in
      // play, and comparing against PAGE_MAX there would never terminate.
      hasMore = refresh
        ? false
        : pageResult.hasNextPage && (latestOnlyLimit <= 0 || kept < latestOnlyLimit);
      if (!hasMore) break;
    }

    return { positions: collected, seenPositionIds, maxTimestamp, maxPositionId, maxBlockNumber, hasMore, flushedCount };
  }

  /**
   * One line per (chainId, protocol) for the lifetime of the process. This
   * fires on every position read for an affected chain, so an unthrottled log
   * would bury the signal it exists to raise.
   */
  private readonly missingSourceWarned = new Set<string>();

  private warnMissingSourceOnce(chainId: number, protocol: string): void {
    const key = `${chainId}:${protocol}`;
    if (this.missingSourceWarned.has(key)) return;
    this.missingSourceWarned.add(key);
    this.logger.warn(
      `[alert] indexer.missing_url chain=${chainId} protocol=${protocol} — this integration has ` +
        `no indexer URL, so positions AND transaction lists for this chain are EMPTY (transactions ` +
        `are flagged degraded). Set the chain's <CHAIN>_${protocol === 'uniswap-v4' ? 'UNISWAP_V4_' : ''}SUBGRAPH_URL ` +
        `to the Envio indexer endpoint, or remove the integration.`,
    );
  }

  async fetchPositionTransactions(options: FetchPositionsOptions): Promise<FetchPositionTransactionsResult> {
    const integration = options.integration;
    const ids = options.positionIds ?? [];
    // Nothing asked for is a genuinely empty answer.
    if (ids.length === 0) return { transactions: [] };
    // No configured source is NOT. Every uniswap-v4 chain resolves to this
    // adapter (adapter-registry resolves on protocol alone and cannot see
    // chainId), so a chain whose subgraph URL is unset lands here with nowhere to
    // read from. Returning a bare empty list made that indistinguishable from
    // "this position has no transactions" — the read path then reported it as
    // fact and the sync path would persist it. Flag it, once per integration.
    const src = this.positionSource(integration);
    if (!src) {
      this.warnMissingSourceOnce(integration.chainId, integration.protocol);
      return { transactions: [], degraded: true };
    }
    const where = envioTxWhere(integration, ids, options.cursorTimestamp ?? 0);

    // `maxPages` is honoured — it used to be ignored, so position detail (which
    // asks for one page) walked the whole history anyway. Pages are always
    // INDEXER_PAGE_MAX rows (`pageSize` is not consulted); `<= 0` means no limit,
    // still bounded by TX_WALK_MAX_PAGES.
    const maxPages = options.maxPages > 0 ? Math.min(options.maxPages, TX_WALK_MAX_PAGES) : TX_WALK_MAX_PAGES;
    // Newest first: one page is the position's LATEST activity (what position
    // detail shows first), and a capped read is missing its OLDEST rows.
    const newestFirst = options.newestFirst === true;
    const transactions: NormalizedPositionTransaction[] = [];
    // Set when the walk stopped at `maxPages` on a FULL page: more rows may
    // exist (exactly a multiple of the page size also reads as truncated — the
    // dialect caps `first` at 1000, so one more row cannot be asked for).
    let truncated = false;
    for (let page = 0; page < maxPages; page++) {
      const data: { positionTransactions: IndexedTx[] } = await requestWithRetry(src, newestFirst ? SG_TXNS_NEWEST_QUERY : SG_TXNS_QUERY, {
        where,
        first: INDEXER_PAGE_MAX,
        // `page * INDEXER_PAGE_MAX` is a correct offset HERE and only here,
        // because nothing is discarded before the count and the walk stops at the
        // first short page — so every earlier page was exactly full. The
        // positions walk cannot use this rule (it post-filters and normalizes
        // rows away) and keeps its own `fetchedCount`. Do not unify the two.
        skip: page * INDEXER_PAGE_MAX,
      });
      const items = data.positionTransactions ?? [];
      for (const raw of items) transactions.push(this.normalizeTransaction(raw, integration));
      // A short page ends an offset walk.
      if (items.length < INDEXER_PAGE_MAX) break;
      if (page === maxPages - 1) truncated = true;
    }
    // A newest-first walk is offset-paged on a sort that grows at its FRONT: a
    // transaction indexed mid-walk shifts every later page down a row, so a
    // row can come back twice (never skipped). Dropped by id, then put back
    // oldest-first so every caller sees one order whichever way it read.
    const rows = newestFirst ? oldestFirst(uniqueTransactions(transactions)) : transactions;
    return truncated ? { transactions: rows, truncated: true } : { transactions: rows };
  }

  /*
   * The client that serves positions for this integration, or `undefined` when
   * the integration has no indexer URL at all.
   *
   * Every query in this file goes out in the subgraph dialect and is translated
   * to Hasura by `subgraphFetch`. There used to be a second branch returning a
   * bare-`fetch` Ponder client, with the two tagged by a `kind` so a single read
   * could not accidentally mix dialects; with one source that discriminator is
   * gone.
   *
   * Offset paging is weaker than cursor paging — a row inserted mid-walk can
   * shift the window — but the positions walk is ordered by `createdAtTimestamp`,
   * and a position's creation timestamp never changes, so new rows only ever
   * append beyond a walk already in progress. The one real exposure is a tie at a
   * page boundary, which the converter closes by appending the primary key to
   * every ORDER BY. (This argument does NOT hold for a MUTABLE sort key — see the
   * live listener, which keyset-walks `updatedAtBlock` for exactly that reason.)
   */
  private positionSource(integration: IntegrationConfig): GraphQLClient | undefined {
    if (!integration.subgraphUrl) return undefined;
    return new GraphQLClient(integration.subgraphUrl, subgraphFetch(integration));
  }

  /** One page of positions, offset-paged. */
  private async fetchPositionsPage(
    src: GraphQLClient,
    args: {
      where: Record<string, unknown>;
      orderDirection: string;
      limit: number;
      skip: number;
    },
  ): Promise<{ items: IndexedPosition[]; hasNextPage: boolean }> {
    const data: { positions: IndexedPosition[] } = await requestWithRetry(src, SG_POSITIONS_QUERY, {
      where: args.where,
      orderDirection: args.orderDirection,
      first: args.limit,
      skip: args.skip,
    });
    const items = data.positions ?? [];
    return {
      items,
      // A full page means there is probably another; the walk stops on a short
      // page. The dialect gives no `hasNextPage`, so this is the same inference
      // `pools-sync` already makes. Compared against THIS page's limit, never
      // against the constant — see the caller.
      hasNextPage: items.length === args.limit,
    };
  }

  async fetchPositionTimestampRange(integration: IntegrationConfig): Promise<PositionTimestampRange> {
    const src = this.positionSource(integration);
    if (!src) {
      this.warnMissingSourceOnce(integration.chainId, integration.protocol);
      return { minTimestamp: 0, maxTimestamp: 0 };
    }
    const where = { chainId: integration.chainId };
    const data: {
      min: Array<{ createdAtTimestamp: string }>;
      max: Array<{ createdAtTimestamp: string }>;
    } = await requestWithRetry(src, SG_RANGE_QUERY, { where });
    return {
      minTimestamp: toNumber(data.min?.[0]?.createdAtTimestamp),
      maxTimestamp: toNumber(data.max?.[0]?.createdAtTimestamp),
    };
  }

  // ─── BACKFILL_PAGING=tokenid ────────────────────────────────────────────────
  /*
   * The full backfill walk in tokenId ranges (design §6.2-1). Why tokenId:
   * v4 tokenIds are dense and unique per chain, the indexer serves
   * `tokenId_gte/_lt` + `orderBy: tokenId` from its existing single-column
   * index, and a range is a fixed, independent slice — so a page costs the
   * same at the end of a 3.5M walk as at the start (the createdAt walk paid a
   * growing `skip` AND a sort on an unindexed column), and ranges can be
   * prepared in parallel.
   *
   * COMPLETENESS. A range `[a, a+W)` with W = 999 holds at most 999 rows, so a
   * full page of 1000 proves more rows than ids (`[alert] backfill.range_overflow`)
   * and the range is paged with `skip` until short — nothing is dropped. The
   * end is the indexer's highest tokenId, read at the start and re-read ONCE
   * when the walk passes it (positions minted during the walk). Rows the walk
   * cannot see by construction — a position created during the walk at a
   * tokenId it had already passed, or one whose first liquidity came long
   * after its mint — are the CALLER's tail walk (createdAt mode from the run
   * start − 1 h, `SyncService`).
   */
  async walkTokenIdRanges(options: TokenIdWalkOptions): Promise<TokenIdWalkResult> {
    const integration = options.integration;
    const result: TokenIdWalkResult = {
      nextTokenId: normalizeTokenIdString(options.fromTokenId),
      completed: false,
      aborted: false,
      ranges: 0,
      rows: 0,
      written: 0,
      maxTimestamp: 0,
      maxPositionId: '',
      maxBlockNumber: 0,
    };
    const src = this.positionSource(integration);
    if (!src) {
      this.warnMissingSourceOnce(integration.chainId, integration.protocol);
      result.completed = true;
      return result;
    }
    const chainId = integration.chainId;
    const width = BigInt(clampRangeSize(options.rangeSize));
    let start = BigInt(result.nextTokenId);
    let max: bigint | null;
    try {
      max = await this.fetchTokenIdEdge(src, { chainId }, 'desc');
    } catch (err) {
      throw new TokenIdEdgeQueryError('max', err);
    }
    let reread = false;
    let index = 0;
    const next = async (): Promise<TokenIdRange | null> => {
      for (;;) {
        if (max !== null && start <= max) {
          const range: TokenIdRange = { from: start.toString(), to: (start + width).toString(), index: index++ };
          start += width;
          return range;
        }
        if (reread) return null;
        // Past the end: re-read the highest tokenId ONCE — positions minted
        // while the walk ran — and carry on if it grew.
        reread = true;
        // A failed re-read ends the walk: the completeness tail (createdAt from
        // the run start − 1 h) covers every position minted while it ran.
        const grown = await this.fetchTokenIdEdge(src, { chainId }, 'desc').catch((err) => {
          this.logger.warn(
            `tokenId walk ${integration.chainId}:${integration.protocol}: end re-read failed (${(err as Error)?.message ?? String(err)}) — ` +
              `ending the walk; the tail covers positions minted meanwhile`,
          );
          return null;
        });
        if (grown === null || (max !== null && grown <= max)) return null;
        max = grown;
      }
    };
    const ctx: RangeContext = {
      cache: options.pipeline ? new IndexerEntityCache() : undefined,
      pipeline: options.pipeline,
      priceWaitMs: Math.max(0, options.priceWaitMs),
      feeRead: options.feeRead,
      concurrency: Math.max(1, options.normalizationConcurrency ?? 10),
      inflightPrefetches: 0,
      maxInflightPrefetches: MAX_BACKGROUND_PREFETCHES + Math.max(0, Math.floor(options.lookahead)),
    };
    const outcome = await runRangePipeline<TokenIdRange, PreparedRange>({
      next,
      prepare: (range) => this.prepareTokenIdRange(src, integration, range, ctx),
      write: async (range, prepared) => {
        const written = await options.onRange(prepared.positions, range, prepared.stats);
        result.written += written;
        result.rows += prepared.stats.rows;
        result.ranges += 1;
        for (const p of prepared.positions) {
          if (
            p.createdAtTimestamp > result.maxTimestamp ||
            (p.createdAtTimestamp === result.maxTimestamp && p.positionId > result.maxPositionId)
          ) {
            result.maxTimestamp = p.createdAtTimestamp;
            result.maxPositionId = p.positionId;
          }
        }
        result.maxBlockNumber = Math.max(result.maxBlockNumber, prepared.maxBlockNumber);
        // The contiguous cursor: every range up to and including this one is
        // written (the pipeline writes strictly in order).
        result.nextTokenId = range.to;
        if (options.onCursor) await options.onCursor(range.to);
      },
      lookahead: options.lookahead,
      signal: options.signal,
    });
    result.aborted = outcome.aborted;
    result.completed = !outcome.aborted;
    return result;
  }

  /** P3.1: `false` while no `PAGE_FEE_READER` is bound (the flag would read nothing). */
  pageFeeReaderBound(): boolean {
    return !!this.feeReader;
  }

  async findFirstTokenIdCreatedSince(integration: IntegrationConfig, timestamp: number): Promise<string | null> {
    const src = this.positionSource(integration);
    if (!src) {
      this.warnMissingSourceOnce(integration.chainId, integration.protocol);
      return null;
    }
    let first: bigint | null;
    try {
      first = await this.fetchTokenIdEdge(
        src,
        { chainId: integration.chainId, createdAtTimestamp_gte: String(Math.max(0, Math.floor(timestamp))) },
        'asc',
      );
    } catch (err) {
      throw new TokenIdEdgeQueryError('first-since', err);
    }
    return first === null ? null : first.toString();
  }

  /** The lowest (`asc`) or highest (`desc`) tokenId matching `where`, or null. */
  private async fetchTokenIdEdge(
    src: GraphQLClient,
    where: Record<string, unknown>,
    orderDirection: 'asc' | 'desc',
  ): Promise<bigint | null> {
    const data: { positions?: Array<{ tokenId?: string | number }> } = await requestWithRetry(src, SG_TOKENID_EDGE_QUERY, {
      where,
      orderDirection,
    });
    const raw = data.positions?.[0]?.tokenId;
    if (raw === undefined || raw === null) return null;
    const text = String(raw);
    return /^\d+$/.test(text) ? BigInt(text) : null;
  }

  /**
   * Every row of one range. A short first page is the whole range; a FULL one
   * means more rows than the range has ids (W ≤ 999 < `first`), which v4's
   * unique tokenIds cannot produce — alert, and page on with `skip` until a
   * short page so nothing is dropped.
   */
  private async fetchTokenIdRangeRows(
    src: GraphQLClient,
    chainId: number,
    range: TokenIdRange,
  ): Promise<{ rows: IndexedPosition[]; overflowPages: number }> {
    const where = { chainId, tokenId_gte: range.from, tokenId_lt: range.to };
    const rows: IndexedPosition[] = [];
    let overflowPages = 0;
    for (let page = 0; page < TX_WALK_MAX_PAGES; page++) {
      const data: { positions: IndexedPosition[] } = await requestWithRetry(src, SG_POSITIONS_BY_TOKENID_QUERY, {
        where,
        first: INDEXER_PAGE_MAX,
        skip: page * INDEXER_PAGE_MAX,
      });
      const items = data.positions ?? [];
      rows.push(...items);
      if (items.length < INDEXER_PAGE_MAX) break;
      overflowPages += 1;
      if (overflowPages === 1) {
        this.logger.warn(
          `[alert] backfill.range_overflow chain=${chainId} range=[${range.from},${range.to}) — a full page for a range ` +
            `of ${BigInt(range.to) - BigInt(range.from)} ids (tokenIds not unique/dense?): paging the range with skip`,
        );
      }
    }
    // A row can come back twice when paging an overflowing range under writes.
    if (overflowPages === 0) return { rows, overflowPages };
    const seen = new Set<string>();
    return {
      rows: rows.filter((r) => {
        const key = `${r.tokenId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
      overflowPages,
    };
  }

  /**
   * Fetch, price, measure and normalize one range — everything but the write.
   * Runs for up to `lookahead + 1` ranges at once.
   */
  private async prepareTokenIdRange(
    src: GraphQLClient,
    integration: IntegrationConfig,
    range: TokenIdRange,
    ctx: RangeContext,
  ): Promise<PreparedRange> {
    const chainId = integration.chainId;
    const stats = emptyRangeStats();
    let t = Date.now();
    const { rows, overflowPages } = await this.fetchTokenIdRangeRows(src, chainId, range);
    stats.pageMs = Date.now() - t;
    stats.rows = rows.length;
    stats.overflowPages = overflowPages;
    if (rows.length === 0) return { positions: [], stats, maxBlockNumber: 0 };

    const poolIds = [...new Set(rows.map((r) => r.poolId.toLowerCase()))];
    let pools: Map<string, IndexedPool>;
    let poolStats: Map<string, PoolStatsRow>;
    t = Date.now();
    if (ctx.pipeline) {
      ({ pools, poolStats } = await this.fetchRangePools(src, chainId, poolIds));
    } else {
      [pools, poolStats] = await Promise.all([
        this.fetchPools(src, chainId, poolIds),
        this.fetchPoolStats(src, poolIds, chainId, integration.protocol),
      ]);
    }
    stats.dynMs = Date.now() - t;

    const tokenIds = [...new Set([...pools.values()].flatMap((p) => [p.token0Id.toLowerCase(), p.token1Id.toLowerCase()]))];
    const priceStart = Date.now();
    let prefetchDone = false;
    // A prefetch that misses its range's deadline keeps running for later
    // ranges; on a slow provider those would pile up (and re-ask overlapping
    // tokens). Past the cap a range starts none and prices from the cache —
    // the unpriced-at-insert backlog the design accepts, never a wait.
    const startPrefetch = tokenIds.length > 0 && (!ctx.pipeline || ctx.inflightPrefetches < ctx.maxInflightPrefetches);
    if (startPrefetch && ctx.pipeline) ctx.inflightPrefetches += 1;
    const prefetch = (startPrefetch ? this.pricing.prefetchPrices(chainId, tokenIds) : Promise.resolve())
      .catch((err) => {
        this.logger.warn(`price prefetch failed for ${tokenIds.length} tokens: ${(err as Error)?.message ?? String(err)}`);
      })
      .finally(() => {
        prefetchDone = startPrefetch || tokenIds.length === 0;
        if (startPrefetch && ctx.pipeline) ctx.inflightPrefetches -= 1;
        stats.priceMs = Date.now() - priceStart;
      });
    t = Date.now();
    const tokens = ctx.cache
      ? await this.fetchTokensCached(src, chainId, tokenIds, ctx.cache)
      : await this.fetchTokens(src, chainId, tokenIds);
    stats.tokensMs = Date.now() - t;

    // P3.1 — measured while the prices finish.
    const feeStart = Date.now();
    const freshFees = ctx.feeRead
      ? this.readPageFees(integration, rows, pools, tokens).finally(() => {
          stats.feeReadMs = Date.now() - feeStart;
        })
      : undefined;

    if (ctx.pipeline) {
      // Never block normalize on a price fetch: wait at most the deadline,
      // then serve what the cache holds (+ ONE last-known-good read for the
      // range's tokens, never one per leg) and record the rest as misses.
      await waitAtMost(prefetch, ctx.priceWaitMs);
      stats.priceWaitMs = Date.now() - priceStart;
      if (!prefetchDone) {
        stats.priceDeadlineHit = true;
        await this.pricing.seedLastKnown(chainId, tokenIds).catch(() => 0);
      }
    } else {
      await prefetch;
      stats.priceWaitMs = Date.now() - priceStart;
    }

    const stored = await this.loadRpcFees(integration, rows);
    const { fees: rpcFees, freshIds } = freshFees ? mergeFeeReadings(stored, await freshFees) : { fees: stored, freshIds: undefined };
    t = Date.now();
    const extras = { cacheOnly: ctx.pipeline, freshFeeIds: freshIds };
    const normalized = await mapConcurrent(rows, ctx.concurrency, (raw) =>
      this.normalize(raw, integration, pools, tokens, poolStats, rpcFees, extras),
    );
    stats.normalizeMs = Date.now() - t;

    const positions: NormalizedPosition[] = [];
    let maxBlockNumber = 0;
    for (const [i, pos] of normalized.entries()) {
      if (!pos) continue;
      positions.push(pos);
      maxBlockNumber = Math.max(maxBlockNumber, toNumber(rows[i]?.createdAtBlockNumber));
      if (pos.rpcFeesBlock !== undefined) stats.feesMeasured += 1;
      if (!pos.isActive) {
        for (const leg of [pos.token0, pos.token1]) {
          if (!(leg.priceUsd > 0)) bumpCapped(stats.unpricedClosed, leg.address);
        }
      }
    }
    return { positions, stats, maxBlockNumber };
  }

  /**
   * One request for a range's pools: static + dynamic + poolStats columns.
   * Ids are chunked to the row cap like every batch lookup. Pools the indexer
   * did not return get no stats (their positions normalize to null anyway).
   */
  private async fetchRangePools(
    src: GraphQLClient,
    chainId: number,
    ids: string[],
  ): Promise<{ pools: Map<string, IndexedPool>; poolStats: Map<string, PoolStatsRow> }> {
    const pools = new Map<string, IndexedPool>();
    const poolStats = new Map<string, PoolStatsRow>();
    if (ids.length === 0) return { pools, poolStats };
    const rows = await this.fetchInChunks<IndexedPool & PoolStatsRow>(src, SG_RANGE_POOLS_QUERY, 'pools', chainId, ids);
    for (const r of rows) {
      const id = r.id.toLowerCase();
      pools.set(id, {
        id: r.id,
        name: r.name,
        fee: r.fee,
        tickSpacing: r.tickSpacing,
        tick: r.tick,
        sqrtPriceX96: r.sqrtPriceX96,
        token0Id: r.token0Id,
        token1Id: r.token1Id,
      });
      poolStats.set(id, {
        id: r.id,
        totalValueLockedUSD: r.totalValueLockedUSD,
        totalValueLockedUSDUntracked: r.totalValueLockedUSDUntracked,
        totalValueLockedToken0: r.totalValueLockedToken0,
        totalValueLockedToken1: r.totalValueLockedToken1,
        volumeUSD: r.volumeUSD,
        feesUSD: r.feesUSD,
      });
    }
    return { pools, poolStats };
  }

  /** `fetchTokens` through the run's token cache: only ids the run has not seen are requested. */
  private async fetchTokensCached(
    src: GraphQLClient,
    chainId: number,
    ids: string[],
    cache: IndexerEntityCache,
  ): Promise<Map<string, IndexedToken>> {
    const { hit, miss } = cache.lookupTokens(ids);
    const out = new Map<string, IndexedToken>();
    for (const [id, t] of hit) out.set(id, { ...t });
    if (miss.length > 0) {
      const fetched = await this.fetchTokens(src, chainId, miss);
      cache.putTokens(
        [...fetched.values()].map((t) => ({
          id: t.id,
          symbol: t.symbol,
          name: t.name,
          decimals: t.decimals,
          verified: t.verified === true,
        })),
      );
      for (const [id, t] of fetched) out.set(id, t);
    }
    return out;
  }

  /**
   * P3.1 — the on-chain reading of a page's ACTIVE rows (open, liquidity > 0;
   * a closed row owes nothing and is never measured). Fail-SOFT: no reader, or
   * a failed read, is an empty map — those rows then reach the fee job's
   * backfill lane exactly as without the flag.
   */
  private async readPageFees(
    integration: IntegrationConfig,
    rows: IndexedPosition[],
    pools: Map<string, IndexedPool>,
    tokens: Map<string, IndexedToken>,
  ): Promise<Map<string, RpcFees>> {
    if (!this.feeReader) return new Map();
    const input: PageFeeRow[] = [];
    for (const raw of rows) {
      if (!isOpenRow(raw)) continue;
      const pool = pools.get(raw.poolId.toLowerCase());
      if (!pool) continue;
      const t0 = tokens.get(pool.token0Id.toLowerCase());
      const t1 = tokens.get(pool.token1Id.toLowerCase());
      if (!t0 || !t1) continue;
      const tokenId = String(raw.tokenId);
      input.push({
        positionId: tokenId,
        tokenId,
        poolId: raw.poolId.toLowerCase(),
        tickLower: toNumber(raw.tickLower),
        tickUpper: toNumber(raw.tickUpper),
        decimals0: toNumber(t0.decimals, 18),
        decimals1: toNumber(t1.decimals, 18),
        lastModifyBlock: toNumber(raw.lastModifyBlock),
      });
    }
    if (input.length === 0) return new Map();
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadlineMs = this.pageFeeReadDeadlineMs;
    try {
      const read = this.feeReader.measure(integration.chainId, integration.protocol, input, { signal: ctl.signal });
      // A late answer (or rejection) is dropped: the race below has already
      // subscribed to `read`, so a rejection after the deadline is handled.
      const late = new Promise<'late'>((resolve) => {
        timer = setTimeout(() => resolve('late'), deadlineMs);
        timer.unref?.();
      });
      const answer = await Promise.race([read, late]);
      if (answer === 'late') {
        ctl.abort();
        this.logger.warn(
          `backfill fee read for ${input.length} positions on ${integration.chainId}:${integration.protocol} ` +
            `exceeded ${deadlineMs} ms; the range goes on without it (the fee job's backfill lane measures those rows)`,
        );
        return new Map();
      }
      return answer;
    } catch (err) {
      this.logger.warn(
        `backfill fee read failed for ${input.length} positions on ${integration.chainId}:${integration.protocol}: ${(err as Error)?.message ?? String(err)}`,
      );
      return new Map();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ─── batch lookups ──────────────────────────────────────────────────────────
  /*
   * An `id_in` batch MUST be chunked to `INDEXER_PAGE_MAX`, and this is not
   * tidiness — it is the difference between a complete corpus and a silently
   * incomplete one.
   *
   * `first` is a ROW cap, not an id cap, so asking for 1,050 ids with
   * `first: 1000` returns the first 1,000 with no error and no flag. The missing
   * tokens are then simply absent from the Map, `normalize` hits
   * `if (!token0 || !token1) return null`, and those positions are dropped from
   * the page — never upserted, and never retried, because `fetchedCount` has
   * already counted them so the walk moves on. A backfill page of 1,000 positions
   * can easily span ~950 pools and therefore MORE than 1,000 distinct token ids.
   * (`fetchPools` is bounded by the page's row count so it cannot exceed the cap
   * today, but it is chunked through the same helper so a future page-size change
   * cannot make it the next silent truncation.)
   */
  private async fetchInChunks<T>(
    src: GraphQLClient,
    query: string,
    root: 'pools' | 'tokens',
    chainId: number,
    ids: string[],
  ): Promise<T[]> {
    const rows: T[] = [];
    for (let i = 0; i < ids.length; i += INDEXER_PAGE_MAX) {
      const batch = ids.slice(i, i + INDEXER_PAGE_MAX);
      const data: Record<string, T[] | undefined> = await requestWithRetry(src, query, {
        where: { chainId, id_in: batch },
        first: INDEXER_PAGE_MAX,
      });
      rows.push(...(data[root] ?? []));
    }
    return rows;
  }

  private async fetchPools(src: GraphQLClient, chainId: number, ids: string[]): Promise<Map<string, IndexedPool>> {
    const out = new Map<string, IndexedPool>();
    if (ids.length === 0) return out;
    const pools = await this.fetchInChunks<IndexedPool>(src, SG_POOLS_QUERY, 'pools', chainId, ids);
    for (const p of pools) out.set(p.id.toLowerCase(), p);
    return out;
  }

  private async fetchTokens(src: GraphQLClient, chainId: number, ids: string[]): Promise<Map<string, IndexedToken>> {
    const out = new Map<string, IndexedToken>();
    if (ids.length === 0) return out;
    const tokens = await this.fetchInChunks<IndexedToken>(src, SG_TOKENS_QUERY, 'tokens', chainId, ids);
    for (const t of tokens) {
      // The indexer has no `verified` column, so it comes from the same static
      // whitelist the old indexer computed it from. NOT optional: `verified`
      // feeds `legTrust`, and defaulting it to false demotes every token a trust
      // tier, which changes which legs contribute value.
      const verified = isWhitelistedToken(chainId, t.id);
      out.set(t.id.toLowerCase(), { ...t, verified });
    }
    return out;
  }

  private async fetchPoolStats(
    src: GraphQLClient,
    ids: string[],
    chainId: number,
    protocol: string,
  ): Promise<Map<string, PoolStatsRow>> {
    const out = new Map<string, PoolStatsRow>();
    if (ids.length === 0) return out;

    let liveErr: unknown;
    try {
      const data: { pools: PoolStatsRow[] } = await requestWithRetry(src, POOL_STATS_QUERY, { ids });
      for (const p of data.pools ?? []) out.set(p.id.toLowerCase(), p);
    } catch (err) {
      // Transient upstream failures are already retried in `requestWithRetry`;
      // fall through to the last-good cache rather than blanking the stats.
      liveErr = err;
    }

    // Last-good fallback: any id the live fetch didn't cover is backfilled from
    // the hourly-synced `pools` collection. metrics.tvlUsd is the re-valued,
    // bounded TVL — better data than the subgraph's raw (often negative/inflated)
    // USD. Pool stats are a leaderboard FILTER input (minPoolTvl) + a pricing-
    // confidence + chart input — degrade gracefully rather than blanking to 0.
    const missing = ids.filter((id) => !out.has(id.toLowerCase()));
    if (missing.length > 0) {
      try {
        const cached = await this.poolsRepo.findByIds(chainId, protocol, missing);
        for (const pool of cached) {
          out.set(pool.poolId.toLowerCase(), {
            id: pool.poolId,
            totalValueLockedUSD: String(pool.metrics.tvlUsd),
            totalValueLockedUSDUntracked: '0', // not stored in PoolMetrics
            // Reserves keep the realizability backing alive during a live-fetch
            // outage. OMIT when the cached row predates reserve storage —
            // `undefined` means "unknown" downstream (priced legs are then NOT
            // zeroed on missing data; derivation pauses).
            totalValueLockedToken0: pool.metrics.tvlToken0 !== undefined ? String(pool.metrics.tvlToken0) : undefined,
            totalValueLockedToken1: pool.metrics.tvlToken1 !== undefined ? String(pool.metrics.tvlToken1) : undefined,
            // Lifetime-cumulative totals, matching the live query's semantics.
            // Serving the 24h numbers here silently shrank volume/fees ~1000x
            // during an outage. OMIT on legacy rows (pre-2026-06-11) rather
            // than substitute the wrong window.
            volumeUSD: pool.metrics.volumeUsdTotal !== undefined ? String(pool.metrics.volumeUsdTotal) : undefined,
            feesUSD: pool.metrics.feesUsdTotal !== undefined ? String(pool.metrics.feesUsdTotal) : undefined,
          });
        }
      } catch (err) {
        this.logger.warn(`vanilla pool-stats last-good fallback failed: ${(err as Error)?.message ?? String(err)}`);
      }
    }

    const stillMissing = ids.filter((id) => !out.has(id.toLowerCase()));
    if (liveErr && stillMissing.length > 0) {
      this.logger.warn(
        `vanilla pool-stats fetch failed (${stillMissing.length}/${ids.length} pools missing from last-good cache): ${(liveErr as Error)?.message ?? String(liveErr)}`,
      );
    } else if (liveErr) {
      this.logger.debug(`vanilla pool-stats: live fetch failed, served ${ids.length} pools from last-good cache`);
    }
    return out;
  }

  // ─── normalize ────────────────────────────────────────────────────────────────
  /**
   * Stored on-chain fee measurements for one page of positions. Fail-SOFT: a
   * lookup failure only means this page serves the indexer's figures, which is
   * exactly the pre-overlay behaviour — never a reason to fail the sync.
   */
  private async loadRpcFees(integration: IntegrationConfig, rows: IndexedPosition[]): Promise<Map<string, RpcFees>> {
    if (!this.positionsRepo || rows.length === 0) return new Map();
    try {
      return await this.positionsRepo.findRpcFees(
        integration.chainId,
        integration.protocol,
        rows.map((r) => String(r.tokenId)),
      );
    } catch (err) {
      this.logger.warn(`on-chain fee overlay lookup failed: ${(err as Error)?.message ?? String(err)}`);
      return new Map();
    }
  }

  private async normalize(
    raw: IndexedPosition,
    integration: IntegrationConfig,
    pools: Map<string, IndexedPool>,
    tokens: Map<string, IndexedToken>,
    poolStats: Map<string, PoolStatsRow>,
    rpcFees?: Map<string, RpcFees>,
    /**
     * `cacheOnly`: price from the cache only (the backfill pipeline, see
     * `PricePoolOptions`). `freshFeeIds`: rows whose winning fee reading was
     * taken by THIS walk (P3.1) — the only rows that carry the `rpcFees*` stamp.
     */
    extras?: { cacheOnly?: boolean; freshFeeIds?: ReadonlySet<string> },
  ): Promise<NormalizedPosition | null> {
    const tokenId = String(raw.tokenId);
    if (!tokenId || !/^\d+$/.test(tokenId)) return null;
    const pool = pools.get(raw.poolId.toLowerCase());
    if (!pool) return null;
    const token0 = tokens.get(pool.token0Id.toLowerCase());
    const token1 = tokens.get(pool.token1Id.toLowerCase());
    if (!token0 || !token1) return null;

    const decimals0 = toNumber(token0.decimals, 18);
    const decimals1 = toNumber(token1.decimals, 18);
    const currentTick = toNumber(pool.tick);
    const sqrtPriceX96 = String(pool.sqrtPriceX96 ?? '0');
    const liquidity = String(raw.liquidity ?? '0');
    const stats = poolStats.get(raw.poolId.toLowerCase());
    const poolTvlUsd = toNumber(stats?.totalValueLockedUSD);
    const poolTvlUsdUntracked = toNumber(stats?.totalValueLockedUSDUntracked);
    const poolVolumeUsd = toNumber(stats?.volumeUSD);
    const poolTotalFeesUsd = toNumber(stats?.feesUSD);

    const priceInput = {
      chainId: integration.chainId,
      protocol: integration.protocol,
      token0: { address: token0.id, decimals: decimals0, verified: token0.verified === true, symbol: token0.symbol },
      token1: { address: token1.id, decimals: decimals1, verified: token1.verified === true, symbol: token1.symbol },
      sqrtPriceX96,
      tick: currentTick,
      poolTvlUsd,
      poolTvlUsdUntracked,
      poolVolumeUsd,
      poolTotalFeesUsd,
    };
    // The second argument only when it says something: every existing caller
    // (and spec) sees the one-argument call it always did.
    const prices = extras?.cacheOnly
      ? await this.pricing.pricePool(priceInput, { cacheOnly: true })
      : await this.pricing.pricePool(priceInput);

    const flags = valuationFlags(this.config);
    // Open = still holds liquidity (an emptied or closed row is not).
    const positionOpen = raw.isActive !== false && BigIntOrZero(liquidity) > 0n && !raw.closedAtTimestamp;
    // Amounts are HUMAN-readable from the indexer. They are the amounts as of
    // the position's last liquidity change (the indexer's old fee sweep was the
    // only thing that refreshed them, never completed on the largest chains, and
    // is gone from the new indexer), so `POSITION_AMOUNTS_SOURCE=tickmath` recomputes an OPEN row's
    // amounts from its liquidity, range and the pool's current price instead.
    // Closed rows, a range the tick math cannot read, and a row the indexer marked
    // unpriceable (a pool pinned at the tick domain edge, where the tick math returns
    // impossible amounts) keep the indexer's.
    const indexerAmount0 = toNumber(raw.amount0);
    const indexerAmount1 = toNumber(raw.amount1);
    const tickMath =
      flags.positionAmountsSource === 'tickmath' && positionOpen && raw.isPriceable !== false
        ? tickMathAmounts(this.pricing, {
            liquidity,
            tickLower: toNumber(raw.tickLower),
            tickUpper: toNumber(raw.tickUpper),
            sqrtPriceX96,
            // The pool's REAL tick or nothing: `currentTick` above defaults a
            // missing column to 0, and tick 0 is a price (1.0 in raw units) —
            // a pool row with neither sqrtPrice nor tick must keep the
            // indexer's amounts, not be valued at tick 0.
            currentTick: optionalTick(pool.tick),
            decimals0,
            decimals1,
          })
        : null;
    const amount0 = tickMath ? tickMath.amount0 : indexerAmount0;
    const amount1 = tickMath ? tickMath.amount1 : indexerAmount1;
    const deposited0 = toNumber(raw.depositedToken0);
    const deposited1 = toNumber(raw.depositedToken1);
    const withdrawn0 = toNumber(raw.withdrawnToken0);
    const withdrawn1 = toNumber(raw.withdrawnToken1);
    const collected0 = toNumber(raw.totalFeesCollected0);
    const collected1 = toNumber(raw.totalFeesCollected1);
    // The indexer carries no uncollected-fee figure (its fee sweep is gone), so
    // the on-chain measurement is the only source: served when it post-dates the
    // last settle, otherwise 0 labelled `unmeasured` — see chooseUncollected —
    // so the API can say "Pending" instead of $0.
    const lastModifyBlock = toNumber(raw.lastModifyBlock);
    const {
      fees0: uncollected0,
      fees1: uncollected1,
      source: feesSource,
      measuredAt: feesMeasuredAt,
    } = chooseUncollected(
      {
        lastModifyBlock,
        // Emptied: the closing modify settled every fee, and nothing accrues.
        settled: BigIntOrZero(liquidity) <= 0n,
      },
      rpcFees?.get(tokenId),
    );
    // P3.1 stamp: only a reading this walk took AND served (`onchain` = block
    // at or after the last settle). A refused or a stored-newer reading carries
    // nothing — the writer then writes exactly what it wrote before.
    const freshReading =
      extras?.freshFeeIds?.has(tokenId) === true && feesSource === 'onchain' ? rpcFees?.get(tokenId) : undefined;

    // Per-leg valuation: start from external-aggregator/anchor prices only.
    // On-chain/derived prices (subgraph derivedETH, pool-ratio derivation) and
    // unpriced legs contribute $0 — value requires a real external market.
    const rawVp0 = isTrustedExternal(prices.token0Confidence) ? prices.token0Usd : 0;
    const rawVp1 = isTrustedExternal(prices.token1Confidence) ? prices.token1Usd : 0;
    // Trust-tiered pool-consistency: against a priced reference leg
    // (anchor/verified), a lower-trust leg whose external quote is inflated >5x
    // vs the pool-implied price is corrected DOWN to pool-truth (e.g. stkGHO
    // quoted $47 vs pool-implied $0.148). Downward-only — the pool ratio never
    // mints value for a quoteless leg. Suspect (symbol-spoof) legs stay $0.
    const trust0 = legTrust(isAnchorTokenStandalone(integration.chainId, token0.id), prices.token0Confidence);
    const trust1 = legTrust(isAnchorTokenStandalone(integration.chainId, token1.id), prices.token1Confidence);
    const ratio = poolRatio(sqrtPriceX96, decimals0, decimals1);
    let { vp0, vp1, derived0, derived1 } = enforcePoolConsistency(rawVp0, rawVp1, trust0, trust1, ratio);
    // Two allowlisted legs are an equal-trust pair, which the consistency check
    // above (and the backing floor below) leaves alone. Under the quote guard
    // (`PRICE_QUOTE_GUARD=on`, fix 1), a leg the pricing layer marks as NOT
    // corroborated by a second independent source (`token{0,1}Corroborated:
    // false`) is still checked against the pool ratio and the other leg's
    // reserves (AERGO/HPP: a 4.5-month-old single DIA quote put HPP at
    // $31,374, five million times its market). `PricingService.pricePool`
    // attaches that evidence under the guard from the sweep's stored consensus
    // (`priceConfidence`), and keeps a single-source listed leg
    // `external-verified` (only legs whose sources DISAGREED stay unverified,
    // and those go through `enforcePoolConsistency` above instead).
    let pairUnrealizable0 = false;
    let pairUnrealizable1 = false;
    if (trustPolicyOf(this.config).quoteGuard) {
      const evidence: PriceResultWithEvidence = prices;
      const reservesBad =
        toNumber(stats?.totalValueLockedToken0) < 0 || toNumber(stats?.totalValueLockedToken1) < 0;
      const checked = crossCheckAllowlistedPair({
        vp0,
        vp1,
        trust0,
        trust1,
        ratio,
        // Only an EXPLICIT `false` (the sweep's stored consensus: one source,
        // or sources that disagree) makes a leg single-source here. No
        // evidence (unswept, or a pricing layer that does not attach it) is
        // today's behaviour — the leg is left alone, never zeroed on a guess.
        corroborated0: evidence.token0Corroborated !== false,
        corroborated1: evidence.token1Corroborated !== false,
        open: positionOpen,
        reserve0: reservesBad ? undefined : finiteOrUndefined(stats?.totalValueLockedToken0),
        reserve1: reservesBad ? undefined : finiteOrUndefined(stats?.totalValueLockedToken1),
        floorUsd: this.config.minRealMarketBackingUsd,
      });
      vp0 = checked.vp0;
      vp1 = checked.vp1;
      derived0 = derived0 || checked.derived0;
      derived1 = derived1 || checked.derived1;
      pairUnrealizable0 = checked.unrealizable0;
      pairUnrealizable1 = checked.unrealizable1;
    }
    // Candidate-leg backing — OPEN positions only, against a priced higher-trust
    // reference. ONE rule still mutates the value: a QUOTELESS leg (trust 'none',
    // no external market) is derived from the pool ratio, gated by economic
    // realizability (the claim covers held+uncollected+collected+withdrawn+
    // deposited — a near-empty leg with flow history would otherwise mint a
    // dead-pool extreme-tick price, e.g. Zebec 5.5e32). A PRICED lower-trust leg
    // is NO LONGER zeroed on realizability (see the market-value note below) —
    // its claim-vs-backing check now only sets an informational `unrealizable*`
    // flag. CLOSED positions skip this block (dead pool corroborates nothing).
    const lifetimeClaim0 = amount0 + uncollected0 + collected0 + withdrawn0 + deposited0;
    const lifetimeClaim1 = amount1 + uncollected1 + collected1 + withdrawn1 + deposited1;
    // MARKET-VALUE display (product decision — overrides the realizable-$0
    // default): a PRICED leg keeps its consistency-checked market quote even
    // when its claim exceeds the pool's realizable backing (Krystal/Etherscan-
    // style: quantity × market price). RPC's 1B-token LP therefore shows
    // ~$10.4M, not $0. Realizability is NO LONGER applied to the value — it is
    // computed only as an informational `unrealizable*` flag (carried on the API
    // for observability, NOT subtracted from the headline number, NOT shown as a
    // badge). Unverified priced legs likewise keep their quote (open and closed),
    // so the recompute re-values withdrawn/deposited history at market too.
    //
    // Anti-fabrication is RETAINED: a QUOTELESS leg (trust 'none' — no external
    // market at all) is still ONLY derived from the pool ratio against a higher-
    // trust priced reference, gated by real reference-side backing, so a token
    // "priced" solely by its own seeded pool never mints a value. Cross-source
    // consensus + the downward pool-consistency correction (above) still apply.
    let unrealizable0 = pairUnrealizable0;
    let unrealizable1 = pairUnrealizable1;
    // Either reserve negative pre-clamp → the pool's reserve accounting is
    // broken (DiYP v4 flash-accounting drift is symmetric: −1.49B USDC /
    // +1.47B USDT) → treat reserves as UNKNOWN. Trusting the clamped positive
    // leg would fabricate realizability backing for the derivation / flag.
    const reservesCorrupt =
      toNumber(stats?.totalValueLockedToken0) < 0 || toNumber(stats?.totalValueLockedToken1) < 0;
    // Layer 1 — pool market-EXISTENCE floor (provider-independent, no value cap).
    // A priced LOWER-TRUST (unverified/none) candidate leg counts as value only
    // when the pool's REAL on-chain reference-side reserves ≥ this floor; a
    // seeded fantasy pool (USDC/GPCG: $24.84 of real USDC) → leg $0, while a
    // genuinely-backed pool (USDC/RPC ~$11k, Knicks/ETH ~$67k) keeps its full
    // market value. Applies only when reserves are KNOWN (GPCG's $24.84 is) —
    // unknown/corrupt reserves leave the market-value quote intact (outage
    // tolerance; the DEX-market gate at the price layer is the other guard).
    // Verified/listed legs keep their real-market quote even in a thin pool
    // (a CoinGecko listing IS an independent market).
    const minBackingFloor = this.config.minRealMarketBackingUsd;
    const isLowTrust = (t: LegTrust) => t === 'unverified' || t === 'none';
    if (positionOpen && isReferenceLeg(vp1, trust1) && trustRank(trust0) < trustRank(trust1)) {
      const reservesKnown =
        !reservesCorrupt && stats?.totalValueLockedToken1 !== undefined && stats?.totalValueLockedToken1 !== null;
      const backingUsd = reservesCorrupt ? 0 : Math.max(0, toNumber(stats?.totalValueLockedToken1)) * vp1;
      if (vp0 <= 0 && trust0 === 'none') {
        const derived = deriveQuotelessLeg(ratio * vp1, lifetimeClaim0, backingUsd);
        if (derived > 0) { vp0 = derived; derived0 = true; }
      } else if (vp0 > 0 && reservesKnown && isLowTrust(trust0) && !meetsMarketBackingFloor(backingUsd, minBackingFloor)) {
        vp0 = 0; // no real reference-side market backs this leg
        unrealizable0 = true;
      } else if (vp0 > 0 && reservesKnown) {
        // Informational flag only — the value keeps the market quote.
        unrealizable0 = enforceRealizability(vp0, amount0 + uncollected0, backingUsd) <= 0;
      }
    } else if (positionOpen && isReferenceLeg(vp0, trust0) && trustRank(trust1) < trustRank(trust0)) {
      const reservesKnown =
        !reservesCorrupt && stats?.totalValueLockedToken0 !== undefined && stats?.totalValueLockedToken0 !== null;
      const backingUsd = reservesCorrupt ? 0 : Math.max(0, toNumber(stats?.totalValueLockedToken0)) * vp0;
      if (vp1 <= 0 && trust1 === 'none') {
        const derived = deriveQuotelessLeg(vp0 / ratio, lifetimeClaim1, backingUsd);
        if (derived > 0) { vp1 = derived; derived1 = true; }
      } else if (vp1 > 0 && reservesKnown && isLowTrust(trust1) && !meetsMarketBackingFloor(backingUsd, minBackingFloor)) {
        vp1 = 0; // no real reference-side market backs this leg
        unrealizable1 = true;
      } else if (vp1 > 0 && reservesKnown) {
        unrealizable1 = enforceRealizability(vp1, amount1 + uncollected1, backingUsd) <= 0;
      }
    }
    const conf0 = derived0 ? 'pool-derived-strong' : prices.token0Confidence;
    const conf1 = derived1 ? 'pool-derived-strong' : prices.token1Confidence;
    const pendingFeesUsd = uncollected0 * vp0 + uncollected1 * vp1;
    const collectedFeesUsd = collected0 * vp0 + collected1 * vp1;
    const totalFeesUsd = pendingFeesUsd + collectedFeesUsd;
    const underlyingValueUsd = amount0 * vp0 + amount1 * vp1;
    // Market-value display: the headline value IS the market valuation, so
    // nominal == underlying. Retained as a distinct field for API back-compat /
    // easy revert to the realizable-$0 model.
    const nominalValueUsd = underlyingValueUsd;
    const createdAtTimestamp = toNumber(raw.createdAtTimestamp);
    // Age = active HOLDING window. For closed positions this is created→closed so
    // APR annualizes over the period actually held (and stays stable as wall-clock
    // advances) rather than decaying over created→now; open positions use →now.
    const closedAtSec = raw.closedAtTimestamp ? toNumber(raw.closedAtTimestamp) : null;
    const ageEndSec =
      closedAtSec && closedAtSec > createdAtTimestamp ? closedAtSec : Math.floor(Date.now() / 1000);
    const ageSeconds = Math.max(0, ageEndSec - createdAtTimestamp);
    const isActive = positionOpen;
    // A held leg is priced when it has a positive market/derived price. A leg
    // with no price at all (AU-class: no external market, not derivable) keeps
    // vp 0 → the position rejects as missing-price-source (priceUnavailable).
    const hasCompleteHeldAssetPricing =
      (amount0 <= 0 || vp0 > 0) && (amount1 <= 0 || vp1 > 0);
    // Position-side pool stats: re-value TVL from reserves × trusted-leg prices
    // (same trust model as pools-sync's evaluatePoolTvl) instead of persisting
    // the subgraph's derivedETH-priced totalValueLockedUSD verbatim — a seeded
    // spam pool fabricates that headline (USDC/RPC reported $9.86M against
    // ~$10.6k of real USDC), and the raw number otherwise feeds the
    // leaderboard's minPoolTvl filter and the UI's pool-TVL display. The
    // anchor/anchor honeypot-fee exemption is passed exactly as the pools sync
    // passes it, or a pool the Pools page values (42161 ETH/USDC at 6.094%)
    // would serve $0 pool TVL on every one of its positions.
    const poolTvlVerdict = evaluatePoolTvl({
      reserve0: toNumber(stats?.totalValueLockedToken0),
      reserve1: toNumber(stats?.totalValueLockedToken1),
      price0: vp0,
      price1: vp1,
      confidence0: conf0,
      confidence1: conf1,
      feeTier: toNumber(pool.fee),
      honeypotExempt:
        flags.honeypotFeeAnchorExempt === true &&
        isAnchorPair(integration.chainId, token0.id.toLowerCase(), token1.id.toLowerCase()),
    });
    const valuation = assessValuation({
      underlyingValueUsd,
      poolTvlUsd: poolTvlVerdict.tvlUsd,
      poolTvlUsdUntracked,
      poolVolumeUsd,
      poolTotalFeesUsd,
      hasPriceSource: prices.source !== 'none' && hasCompleteHeldAssetPricing,
      subgraphPriceable: raw.isPriceable !== false,
      // Confidence is only meaningful for HELD legs — an un-held leg's 'missing'
      // must not reject an otherwise fully-priced single-sided position.
      token0Confidence: amount0 > 0 ? conf0 : undefined,
      token1Confidence: amount1 > 0 ? conf1 : undefined,
    });
    const reliable = valuation.accepted;
    // Distinguish a genuine "we couldn't get a price" (data gap) from a valid $0
    // (unrealizable leg) or a worthless/empty position: `missing-price-source`
    // means a held leg had no usable quote and none could be derived. The UI
    // shows "price unavailable" rather than a misleading "$0.000". (Transient
    // `pending-reserves` and `subgraph-unpriceable` are their own states.)
    const priceUnavailable = !reliable && valuation.reason === 'missing-price-source';

    return {
      chainId: integration.chainId,
      protocol: integration.protocol,
      positionId: tokenId,
      tokenId,
      owner: String(raw.owner ?? '').toLowerCase(),
      poolId: String(pool.id).toLowerCase(),
      token0: { address: token0.id.toLowerCase(), symbol: token0.symbol ?? token0.id.slice(0, 6), decimals: decimals0, verified: token0.verified === true, priceUsd: vp0, priceConfidence: conf0 },
      token1: { address: token1.id.toLowerCase(), symbol: token1.symbol ?? token1.id.slice(0, 6), decimals: decimals1, verified: token1.verified === true, priceUsd: vp1, priceConfidence: conf1 },
      fee: toNumber(pool.fee),
      tickSpacing: toNumber(pool.tickSpacing),
      tickLower: toNumber(raw.tickLower),
      tickUpper: toNumber(raw.tickUpper),
      currentTick,
      sqrtPriceX96,
      liquidity,
      isActive,
      createdAtTimestamp,
      closedAtTimestamp: raw.closedAtTimestamp ? toNumber(raw.closedAtTimestamp) : null,
      // Stored so the fee refresh can refuse a measurement older than the last
      // settle without asking the indexer (PositionsRepository.writeRpcFees).
      lastModifyBlock,
      ...(freshReading
        ? {
            rpcFeesUncollected0: feeStampString((freshReading as PageFeeReading).fees0Exact, freshReading.fees0),
            rpcFeesUncollected1: feeStampString((freshReading as PageFeeReading).fees1Exact, freshReading.fees1),
            rpcFeesBlock: freshReading.block,
            rpcFeesAt: freshReading.at ?? new Date(),
          }
        : {}),
      amounts: {
        amount0: String(amount0),
        amount1: String(amount1),
        depositedToken0: String(deposited0),
        depositedToken1: String(deposited1),
        depositedUsd: '0',
        withdrawnToken0: String(withdrawn0),
        withdrawnToken1: String(withdrawn1),
        withdrawnUsd: '0',
        totalFeesCollected0: String(collected0),
        totalFeesCollected1: String(collected1),
        totalFeesCollectedUsd: String(finite(reliable ? collectedFeesUsd : 0)),
        totalFeesUncollected0: String(uncollected0),
        totalFeesUncollected1: String(uncollected1),
        totalFeesUncollectedUsd: String(finite(reliable ? pendingFeesUsd : 0)),
        totalGasCostEth: String(toNumber(raw.totalGasCostETH)),
        totalGasCostUsd: '0',
        diffToken0: String(deposited0 - withdrawn0),
        diffToken1: String(deposited1 - withdrawn1),
        diffUsd: '0',
      },
      metrics: {
        apr: 0,
        aprExGas: 0,
        feeApr: 0,
        poolApr: 0,
        roi: 0,
        pnlUsd: 0,
        pnlEth: 0,
        pnlHodl: 0,
        poolPnlUsd: 0,
        divergenceLossUsd: 0,
        underlyingValueUsd: finite(reliable ? underlyingValueUsd : 0),
        nominalValueUsd: finite(reliable ? nominalValueUsd : 0),
        pendingFeesUsd: finite(reliable ? pendingFeesUsd : 0),
        collectedFeesUsd: finite(reliable ? collectedFeesUsd : 0),
        totalFeesUsd: finite(reliable ? totalFeesUsd : 0),
        totalGasCostUsd: 0,
        investedUsd: 0,
        depositedUsd: 0,
        withdrawnUsd: 0,
        diffUsd: 0,
        unclaimedRewardsUsd: 0,
        claimedRewardsUsd: 0,
        ageSeconds,
        inRange: currentTick >= toNumber(raw.tickLower) && currentTick <= toNumber(raw.tickUpper),
        isPriceable: reliable,
        // Marker for "valued at $0 because a quoted leg's claim exceeds the
        // pool's real backing" — lets the API/UI present the row as a valid
        // $0 position instead of an unpriceable one.
        unrealizableLeg: unrealizable0 || unrealizable1,
        priceUnavailable,
        performanceReady: false,
        performanceSource: 'pending-transactions',
        aprWarmup: false,
        // Additive on /api and /v1: lets a consumer tell "measured 0" from
        // "not measured yet" (the dashboard's "Pending").
        feesSource,
        feesMeasuredAt,
      },
      poolStats: {
        tvlUsd: finite(poolTvlVerdict.tvlUsd),
        tvlUsdUntracked: finite(poolTvlUsdUntracked),
        volumeUsd: finite(poolVolumeUsd),
        totalFeesUsd: finite(poolTotalFeesUsd),
        priceDivergence: 0, // not exposed by the v4-subgraph-main schema (display-only)
      },
      pricing: {
        source: reliable ? prices.source : 'none',
        usedFallback: prices.usedFallback || !reliable,
        pricedAt: new Date(),
      },
    };
  }

  private normalizeTransaction(raw: IndexedTx, integration: IntegrationConfig): NormalizedPositionTransaction {
    return normalizeEnvioTransaction(raw, integration);
  }
}

// ─── tokenId walk helpers ──────────────────────────────────────────────────────
interface RangeContext {
  /** Run-scoped token cache — only with the pipeline on. */
  cache?: IndexerEntityCache;
  pipeline: boolean;
  priceWaitMs: number;
  feeRead: boolean;
  concurrency: number;
  /** Price prefetches of this walk still running (pipeline on). */
  inflightPrefetches: number;
  maxInflightPrefetches: number;
}

/** Prefetches a pipeline walk lets run past their range's deadline, beyond its lookahead. */
const MAX_BACKGROUND_PREFETCHES = 4;

interface PreparedRange {
  positions: NormalizedPosition[];
  stats: TokenIdRangeStats;
  maxBlockNumber: number;
}

/** ≤ 999 so a full 1000-row page PROVES an overflow (see `walkTokenIdRanges`). */
export const DEFAULT_TOKENID_RANGE = INDEXER_PAGE_MAX - 1;

export function clampRangeSize(size: number | undefined): number {
  const n = Math.floor(Number(size));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_TOKENID_RANGE;
  return Math.min(DEFAULT_TOKENID_RANGE, n);
}

/** A tokenId cursor as a canonical non-negative decimal string ('0' for anything else). */
export function normalizeTokenIdString(value: string | undefined | null): string {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) return '0';
  return BigInt(text).toString();
}

function emptyRangeStats(): TokenIdRangeStats {
  return {
    pageMs: 0,
    dynMs: 0,
    tokensMs: 0,
    priceMs: 0,
    priceWaitMs: 0,
    priceDeadlineHit: false,
    feeReadMs: 0,
    normalizeMs: 0,
    rows: 0,
    overflowPages: 0,
    unpricedClosed: new Map(),
    feesMeasured: 0,
  };
}

/** Open = active, liquidity > 0, never closed (the same rule normalize applies). */
function isOpenRow(raw: IndexedPosition): boolean {
  return raw.isActive !== false && BigIntOrZero(String(raw.liquidity ?? '0')) > 0n && !raw.closedAtTimestamp;
}

/** Resolves when `p` settles or after `ms`, whichever is first (never rejects). */
function waitAtMost(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    p.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

const UNPRICED_TOKEN_CAP = 1_000;
function bumpCapped(map: Map<string, number>, key: string): void {
  const prev = map.get(key);
  if (prev !== undefined) map.set(key, prev + 1);
  else if (map.size < UNPRICED_TOKEN_CAP) map.set(key, 1);
}

// ─── local helpers (mirrors revert-compatible.adapter.ts) ─────────────────────
function toNumber(value: unknown, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/**
 * True when a token price reflects a real external market and is trusted to
 * contribute USD value: a stable/native anchor, or a real external
 * aggregator/DEX quote (`external-verified`/`external-unverified`). A pool-only
 * derived price (`pool-derived-*`) means NO real market for the token (it's
 * "priced" solely by a pool's own ratio, which is self-referential and
 * manipulable) → that leg is valued at $0. Stale cache (`last-known-*`),
 * `missing`, and `suspect` (symbol-spoof scams) are likewise untrusted. This is
 * the field-standard trust anchor (CoinGecko/DeFiLlama): require an
 * external quote; never fabricate value from a pool alone. Per-position
 * pool-vs-market consistency is enforced separately via `isPoolPriceConsistent`.
 */
function isTrustedExternal(confidence?: PriceConfidence): boolean {
  return (
    confidence === 'anchor' ||
    confidence === 'external-verified' ||
    confidence === 'external-unverified'
  );
}

/**
 * Map a leg's pricing decision to its pool-consistency trust tier. Config
 * anchors rank highest, then CoinGecko-listed (`external-verified`) markets,
 * then bare external quotes; anything pool-derived/missing is `none` and a
 * symbol-spoof is `suspect` (never valued, never derived).
 */
function legTrust(configAnchor: boolean, confidence?: PriceConfidence): LegTrust {
  if (confidence === 'suspect') return 'suspect';
  if (configAnchor || confidence === 'anchor') return 'anchor';
  if (confidence === 'external-verified') return 'verified';
  if (confidence === 'external-unverified') return 'unverified';
  return 'none';
}

// ─── valuation flags (spam-and-pool-mismatch fixes 1 and 3) ───────────────────
/**
 * The valuation flags the adapter reads itself: the `AppConfigService` getters
 * for `POSITION_AMOUNTS_SOURCE` and `HONEYPOT_FEE_ANCHOR_EXEMPT`, read
 * structurally so a config without them (every existing spec, and the
 * default) is today's behaviour — indexer amounts, the fee rule with no
 * exemption. (The allowlisted-pair cross-check rides the trust package's
 * `PRICE_QUOTE_GUARD`, read through `trustPolicyOf`.)
 */
export interface EnvioValuationFlags {
  positionAmountsSource?: 'indexer' | 'tickmath';
  /** `HONEYPOT_FEE_ANCHOR_EXEMPT=on`: an anchor/anchor pool is never a honeypot-fee pool (`poolStats.tvlUsd`, as the pools sync). */
  honeypotFeeAnchorExempt?: boolean;
}

function valuationFlags(config: unknown): EnvioValuationFlags {
  const c = (config ?? {}) as { positionAmountsSource?: unknown; honeypotFeeAnchorExempt?: unknown };
  return {
    positionAmountsSource: c.positionAmountsSource === 'tickmath' ? 'tickmath' : 'indexer',
    honeypotFeeAnchorExempt: c.honeypotFeeAnchorExempt === 'on',
  };
}

/**
 * Per-leg price evidence the pricing layer may attach under the quote guard:
 * `true` when the leg's stored consensus verdict has at least two independent
 * fresh sources agreeing, `false` when the stored verdict says it does not
 * (one source, or sources that disagree). Only `false` subjects the leg to the
 * allowlisted-pair cross-check (it only ever lowers a price, or zeroes a leg
 * the pool cannot back); absent = no evidence = left alone, as today.
 * The fields (`token{0,1}Corroborated`) live on `PriceResult` itself; this
 * alias is kept for the specs that import it.
 */
export type PriceResultWithEvidence = PriceResult;

/**
 * An open position's current amounts from its liquidity, range and the pool's
 * current price (`PricingService.positionAmounts`, the Revert-compatible
 * adapter's rule). Null — keep the indexer's amounts — when the range is not a
 * readable pair of ticks, the tick math throws or returns a non-finite number.
 */
export function tickMathAmounts(
  pricing: Pick<PricingService, 'positionAmounts'>,
  input: AmountInput,
): { amount0: number; amount1: number } | null {
  if (!Number.isInteger(input.tickLower) || !Number.isInteger(input.tickUpper) || input.tickLower >= input.tickUpper) return null;
  let out: { amount0: number; amount1: number } | null;
  try {
    out = pricing.positionAmounts(input);
  } catch {
    return null;
  }
  if (!out || !Number.isFinite(out.amount0) || !Number.isFinite(out.amount1) || out.amount0 < 0 || out.amount1 < 0) return null;
  return out;
}

/** A pool's current tick as stored, or undefined when the column is missing / empty / not a finite number. */
function optionalTick(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function finiteOrUndefined(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

// `crossCheckAllowlistedPair` (+ its input / result types) moved to
// src/pricing/pool-consistency.ts beside `enforcePoolConsistency` (pure, so the
// impact report runs the real rule); re-exported here for existing importers.
export { crossCheckAllowlistedPair, type AllowlistedPairInput, type AllowlistedPairResult } from '../../pricing/pool-consistency.js';

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
