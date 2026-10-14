export interface NormalizedPosition {
  chainId: number;
  protocol: string;
  positionId: string;
  tokenId: string;
  owner: string;
  poolId: string;
  token0: {
    address: string;
    symbol: string;
    decimals: number;
    verified: boolean;
    priceUsd: number;
    /** Resolved price confidence tier for this leg (drives a UI trust badge). */
    priceConfidence?: string;
  };
  token1: {
    address: string;
    symbol: string;
    decimals: number;
    verified: boolean;
    priceUsd: number;
    /** Resolved price confidence tier for this leg (drives a UI trust badge). */
    priceConfidence?: string;
  };
  fee: number;
  tickSpacing: number;
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  sqrtPriceX96: string;
  liquidity: string;
  isActive: boolean;
  createdAtTimestamp: number;
  closedAtTimestamp: number | null;
  /** The indexer's last-ModifyLiquidity block — the on-chain fee freshness key. */
  lastModifyBlock?: number;
  /*
   * P3.1 — the on-chain fee reading taken INSIDE this backfill walk
   * (`BACKFILL_FEE_READ=on`, `PageFeeReader`). Present ONLY when the walk
   * measured the row itself and that reading is the one `chooseUncollected`
   * served (block ≥ `lastModifyBlock`, not older than a stored stamp). Absent
   * on every other path — a refresh, a backfill with the flag off, a row whose
   * read failed — so a writer that sees no stamp writes exactly what it wrote
   * before. Same names and units as the stored `rpcFees*` fields
   * (decimal-adjusted amounts as strings, block number, measured-at), so the
   * upsert can carry the stamp and the served fees in ONE write. The writer
   * must refuse to regress a NEWER stored stamp (design §4.2 rule 5).
   */
  rpcFeesUncollected0?: string;
  rpcFeesUncollected1?: string;
  rpcFeesBlock?: number;
  rpcFeesAt?: Date;
  amounts: {
    amount0: string;
    amount1: string;
    depositedToken0: string;
    depositedToken1: string;
    depositedUsd: string;
    withdrawnToken0: string;
    withdrawnToken1: string;
    withdrawnUsd: string;
    totalFeesCollected0: string;
    totalFeesCollected1: string;
    totalFeesCollectedUsd: string;
    totalFeesUncollected0: string;
    totalFeesUncollected1: string;
    totalFeesUncollectedUsd: string;
    totalGasCostEth: string;
    totalGasCostUsd: string;
    diffToken0: string;
    diffToken1: string;
    diffUsd: string;
  };
  metrics: {
    apr: number;
    aprExGas: number;
    feeApr: number;
    poolApr: number;
    roi: number;
    pnlUsd: number;
    pnlEth: number;
    pnlHodl: number;
    poolPnlUsd: number;
    divergenceLossUsd: number;
    underlyingValueUsd: number;
    /** Value at consistency-checked market quotes IGNORING realizability —
     * display-only companion to underlyingValueUsd (differs only when
     * unrealizableLeg). Never sorted/ranked on. */
    nominalValueUsd?: number;
    pendingFeesUsd: number;
    collectedFeesUsd: number;
    totalFeesUsd: number;
    totalGasCostUsd: number;
    investedUsd: number;
    depositedUsd: number;
    withdrawnUsd: number;
    diffUsd: number;
    unclaimedRewardsUsd: number;
    claimedRewardsUsd: number;
    ageSeconds: number;
    inRange: boolean;
    isPriceable: boolean;
    /** True → a quoted leg was valued $0 by the realizability gate (claim
     * exceeds the pool's real backing). The position is a VALID $0 valuation,
     * not a pricing failure. */
    unrealizableLeg?: boolean;
    /** True → a held leg had NO usable price and none could be derived
     * (data gap) — show "price unavailable", not a misleading $0. */
    priceUnavailable?: boolean;
    performanceReady: boolean;
    performanceSource: string;
    aprWarmup: boolean;
    /** Where the uncollected-fee figure came from (`chooseUncollected`). */
    feesSource?: 'onchain' | 'indexer' | 'settled' | 'unmeasured';
    /** When it was measured on-chain; null unless `onchain`. */
    feesMeasuredAt?: Date | null;
  };
  poolStats: {
    tvlUsd: number;
    tvlUsdUntracked: number;
    volumeUsd: number;
    totalFeesUsd: number;
    priceDivergence: number;
  };
  pricing: {
    source: string;
    usedFallback: boolean;
    pricedAt: Date;
  };
  // No `rawSubgraph` since 2026-10-06: the raw indexer row was stored on every
  // position (~0.7–0.8 KB of a ~3.1 KB document) and never read back. A
  // transaction still carries its own (`NormalizedPositionTransaction`).
}

export interface FetchPositionsResult {
  positions: NormalizedPosition[];
  /**
   * The ids a REFRESH walk returned (the stale sweep's seen set). Empty for a
   * backfill walk on the Envio adapter: nothing reads it there, and it held
   * every id the walk ever saw.
   */
  seenPositionIds: string[];
  maxTimestamp: number;
  maxPositionId: string;
  maxBlockNumber: number;
  hasMore: boolean;
  flushedCount: number;
}

export interface NormalizedPositionTransaction {
  chainId: number;
  protocol: string;
  positionId: string;
  tokenId: string;
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
  amount0HistoricalPriceUsd: number;
  amount1HistoricalPriceUsd: number;
  historicalValueUsd: number;
  historicalPricingSource: string;
  gasCostEth: number;
  gasCostUsd: number;
  sender: string;
  logIndex: number;
  rawSubgraph: Record<string, unknown>;
}

export interface FetchPositionTransactionsResult {
  transactions: NormalizedPositionTransaction[];
  /**
   * `true` = the list is empty because it could NOT be retrieved, not because
   * the position has none. Distinguishes a genuine empty history from an
   * adapter that has no source configured, so a caller never renders or stores
   * "no transactions" on the strength of a missing endpoint.
   */
  degraded?: boolean;
  /**
   * `true` = the walk stopped at the caller's `maxPages` on a full page, so the
   * NEWEST transactions may be missing (the walk is oldest-first) — or, for a
   * `newestFirst` read, the OLDEST ones.
   */
  truncated?: boolean;
}

/**
 * Cursor state advanced by a cursor-walk page. Mirrors the positions backfill
 * cursor shape (`maxTimestamp`, `maxPositionId`, `maxBlockNumber`) so the
 * transaction flush pipeline is structurally identical.
 */
export interface TransactionWalkCursor {
  maxTimestamp: number;
  maxTransactionId: string;
}

/**
 * Result envelope for `fetchAllPositionTransactions` — the cursor-walk
 * analogue of `fetchPositions`. `hasMore=true` means another run should
 * resume from the new cursor.
 */
export interface FetchAllPositionTransactionsResult {
  transactions: NormalizedPositionTransaction[];
  maxTimestamp: number;
  maxTransactionId: string;
  hasMore: boolean;
  flushedCount: number;
}
