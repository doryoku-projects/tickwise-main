export type PriceOutcome = 'success' | 'miss' | 'ratelimit' | 'error' | 'skip';

export interface PriceQuote {
  priceUsd: number;
  /**
   * Legacy numeric confidence (0..1). Kept for any external provider that
   * still emits it; the orchestrator does not act on it today.
   */
  confidence?: number;
  /**
   * Optional source tag for observability — providers populate when they
   * want to distinguish quote quality beyond their `name`. The orchestrator
   * persists `provider.name` as the cache row source regardless.
   */
  source?: string;
  /**
   * Optional structured confidence — preferred over the numeric variant.
   * String values mirror `PriceConfidence` from `pricing.service` so a
   * future caller can flow them through to valuation gating.
   */
  confidenceLevel?:
    | 'anchor'
    | 'external-verified'
    | 'external-unverified'
    | 'pool-derived-strong'
    | 'pool-derived-weak'
    | 'last-known-strong'
    | 'last-known-weak'
    | 'missing'
    | 'suspect';
  /**
   * Optional DEX-market activity signals (DexScreener-style providers populate
   * these for the chosen pair). Used by the consensus sweep to decide whether a
   * token has a REAL ACTIVE on-chain market (volume / counter-side liquidity) vs
   * a dead seeded pool — the discriminator that keeps a thin-but-traded token
   * (RPC) while dropping a $240M one-sided seeded pool (BT77). USD-denominated.
   */
  volume24hUsd?: number;
  /** Counter-side (quote-token) reserve of the chosen pair, in its token units. */
  counterLiquidity?: number;
  /**
   * Quote-token contract address of the chosen pair (lowercased). The consensus
   * sweep converts `counterLiquidity` (quote-token units) → USD via this token's
   * own price; without it the counter reserve can't be compared to a USD floor.
   */
  counterTokenAddress?: string;
  /**
   * When the PROVIDER dated this quote (ms since epoch) — DIA's `Time`,
   * DeFiLlama's `timestamp`. Absent = a live answer with no date (DexScreener,
   * GeckoTerminal). Read by the quote guard (`PRICE_QUOTE_GUARD`): DIA kept
   * serving HPP's 4.5-month-old $31,374 as current.
   */
  quotedAtMs?: number;
  /**
   * DexScreener: the token's pairs on this chain (deepest first, at most
   * `DEX_PAIRS_MAX`), for the earned-trust "not one pool" evidence. Counter
   * side in QUOTE-TOKEN units like `counterLiquidity`.
   */
  dexPairs?: DexPairSummary[];
  /**
   * DexScreener: `true` when `dexPairs` is EVERY pair the API knows for the
   * token on this chain. The batch endpoint returns at most 30 pairs for the
   * whole request (all addresses, all chains), so a capped response carries
   * `false`: its pairs are a sample, and a token can be missing from it
   * entirely. The per-chain batch endpoint (`DEXSCREENER_BATCH_ENDPOINT=
   * per-chain`) answers ONE pair per token, so it always carries `false`.
   * Earned trust stores a "single pool" verdict only from complete evidence.
   */
  dexPairsComplete?: boolean;
}

/**
 * A current-price batch answer plus the requested addresses it cannot vouch
 * for (`PriceProvider.getCurrentBatchWithCoverage`). `uncertain` holds
 * LOWERCASED requested addresses that got no quote AND whose absence proves
 * nothing — e.g. DexScreener answered with its 30-pair cap, so a token missing
 * from the answer may simply have been crowded out. A requested address with
 * no quote that is NOT uncertain is a definite "this source has nothing for
 * it". Never holds an address that has a quote.
 */
export interface CurrentBatchCoverage {
  quotes: Map<string, PriceQuote>;
  uncertain: Set<string>;
  /**
   * LOWERCASED requested addresses with no quote whose absence says NOTHING,
   * because this source cannot see the venue the token trades on for this
   * chain (DexScreener indexes no Arbitrum v4 pool: `DEXSCREENER_BLIND_CHAINS`).
   * Unlike `uncertain` (which latest mode still counts as covered, to keep
   * served data byte-identical) these are NEVER covered: a healthy empty answer
   * from a blind source must not turn "no DEX provider looked" into "no DEX
   * market" (`dexActive:false`). Absent = none.
   */
  unseen?: Set<string>;
}

/** A token's DEX pairs on one chain, from a per-token lookup (`PriceProvider.getTokenPairs`). */
export interface TokenPairEvidence {
  pairs: DexPairSummary[];
  /** false when the venue capped the answer (some pairs may be missing). */
  complete: boolean;
  /**
   * The token's DEX market as a batch answer holding these pairs reads it:
   * its BASE-side pairs only (the batch parse keys on the base token), 24h
   * volume summed over them, the counter side (quote-token units) and quote
   * token of the deepest one by headline liquidity. Absent = no base-side pair
   * with a price in the answer, or a venue that does not say.
   */
  base?: { volume24hUsd: number; counterLiquidity: number; counterTokenAddress?: string };
  /**
   * The token's DEX market over EVERY pair it is in, either orientation: 24h
   * volume summed over them, and the deepest one's (headline liquidity)
   * counter side — the OTHER token's reserve, in that token's units, and that
   * token. A token whose depth is as the QUOTE side (USDT.e on Avalanche: its
   * deepest base-side pair holds $568 of USDC, while WAVAX/USDT.e holds
   * $613k) reads as the market it is here, not as its thinnest orientation.
   * Read by per-chain mode only (`DEXSCREENER_BATCH_ENDPOINT=per-chain`);
   * latest mode reads `base`, the same reading as its batch answers. Absent =
   * no priced pair of the token in the answer, or a venue that does not say.
   */
  market?: { volume24hUsd: number; counterLiquidity: number; counterTokenAddress?: string };
  /**
   * When the venue answered (epoch ms). A cached answer can be hours old
   * (DexScreener keeps it for a quarter of the quote window): earned trust
   * asks first for the requests whose answer is oldest. Absent = unknown, read
   * as older than any dated answer.
   */
  fetchedAt?: number;
}

export interface DexPairSummary {
  /** Pair / pool id as the venue reports it (v4: the pool id), lowercased. */
  id: string;
  /** Headline liquidity (both sides, USD) — fabricatable, used only as the denominator of the counter share. */
  liquidityUsd: number;
  /** Counter-side (quote-token) reserve, in quote-token units. */
  counterLiquidity: number;
  counterTokenAddress?: string;
}

export interface HistoricalReq {
  chainId: number;
  address: string;
  /** Bucket-aligned timestamp in seconds (orchestrator aligns before calling). */
  timestamp: number;
  /** Optional pool address hint for providers that derive via pool ratio (Uniswap TWAP). */
  poolHint?: string;
  /** Counterparty token address in the pool. Required for pool-ratio providers; ignored by external APIs. */
  anchorAddress?: string;
  /** Protocol identifier (e.g. 'uniswap-v3'). Required by pool-ratio providers to resolve the right adapter. */
  protocol?: string;
  /** Decimals of `address`. Required by pool-ratio providers for sqrtPriceX96 derivation. */
  tokenDecimals?: number;
  /** Decimals of `anchorAddress`. Required by pool-ratio providers for sqrtPriceX96 derivation. */
  anchorDecimals?: number;
  /** Whether `address` is token0 in the pool. Required by pool-ratio providers to orient the ratio. */
  isToken0?: boolean;
  /**
   * Caller-supplied "this token is unverified" hint. Drives the orchestrator's
   * suspect-price cross-check: when an unverified token has both an external
   * quote AND a pool-ratio-derivable quote and they disagree wildly, the
   * pool-ratio result wins (subgraph tokenHourData is known to spike for
   * thin-liquidity unverified tokens).
   */
  unverified?: boolean;
}

export type PriceMetrics = Record<PriceOutcome, number>;

/**
 * Optional context supplied to providers via `getHistoricalBatchWithContext`.
 * The orchestrator builds the `anchorPrices` map from earlier providers in the
 * walk, so a derivation provider can look up the counterparty USD price.
 *
 * Keys use the same `(chainId, address, bucketTs)` shape as the orchestrator's
 * own result map — see `historicalTokenPriceRequestKey` in pricing.service.
 */
export interface HistoricalBatchContext {
  anchorPrices: Map<string, number>;
}

export interface PriceProvider {
  /** Stable identifier; persisted in TokenPriceHistorical.source. */
  readonly name: string;

  /** Whether the provider supports a single HTTP call for many current-price addresses. */
  readonly supportsCurrentBatch: boolean;

  /** Whether the provider supports a single HTTP call for many historical-price requests. */
  readonly supportsHistoricalBatch: boolean;

  /** Max addresses (or requests) per batch call. Ignored when batch not supported. */
  readonly maxBatchSize: number;

  /** Worker count when orchestrator falls back to per-request fan-out. */
  readonly singleConcurrency: number;

  /** Backoff applied when the provider self-marks rate-limited and no Retry-After is present. */
  readonly defaultBackoffMs: number;

  isEnabled(): boolean;
  isAvailable(): boolean;
  markBackoff(ms?: number, reason?: string): void;
  /**
   * If true, the orchestrator does NOT wrap this provider's calls in the
   * `PRICING_PROVIDER_TIMEOUT_MS` race. Use for providers with internal
   * pagination/parallelism that can legitimately take longer than the
   * external-API budget (e.g. `subgraph-historical`).
   */
  readonly skipsOrchestratorTimeout?: boolean;

  /**
   * Orchestrator tier. Drives the 3-stage pipeline:
   * - `primary`   → run sequentially first (e.g. subgraph-historical).
   * - `external`  → race in parallel on survivors after primary stage.
   * - undefined   → defaults to `external`.
   * Context-aware providers (with `getHistoricalBatchWithContext`) run
   * last regardless of this flag, since they need anchor prices.
   */
  readonly tier?: 'primary' | 'external';

  getCurrentBatch?(
    chainId: number,
    addresses: string[],
  ): Promise<Map<string, PriceQuote>>;

  /**
   * Optional (DexScreener): `getCurrentBatch`'s answer (same request, same
   * quotes) plus the requested addresses that answer cannot vouch for — see
   * `CurrentBatchCoverage`. The consensus sweep prefers it so a token a capped
   * answer left out is not read as a definite "no market". A provider without
   * it vouches for every address of a healthy answer (today's rule).
   */
  getCurrentBatchWithCoverage?(
    chainId: number,
    addresses: string[],
  ): Promise<CurrentBatchCoverage>;

  getHistoricalBatch?(
    requests: HistoricalReq[],
  ): Promise<Map<string, PriceQuote>>;

  /**
   * Context-aware historical batch. Implemented by derivation providers that
   * need partial results (e.g. a counterparty USD price) from earlier providers
   * in the orchestrator walk. When present, the orchestrator prefers this over
   * `getHistoricalBatch` and supplies the partial-result anchor map.
   */
  getHistoricalBatchWithContext?(
    requests: HistoricalReq[],
    context: HistoricalBatchContext,
  ): Promise<Map<string, PriceQuote>>;

  getCurrentSingle(chainId: number, address: string): Promise<PriceQuote | null>;
  getHistoricalSingle(request: HistoricalReq): Promise<PriceQuote | null>;

  /**
   * Optional (DexScreener): every DEX pair of ONE token on one chain, both
   * orientations, for earned trust's "not one pool" evidence. null = no answer
   * (rate-limited, failed, unsupported chain) — never "no pairs".
   * `refresh`: ask the venue even when a cached answer is still fresh (the
   * new answer replaces it; a failed request leaves it in place) — earned
   * trust's (b) never lets an answer from an earlier sweep overturn this
   * sweep's batch reading.
   */
  getTokenPairs?(chainId: number, address: string, opts?: { refresh?: boolean }): Promise<TokenPairEvidence | null>;

  /**
   * Optional (DexScreener): `getTokenPairs`'s still-fresh cached answer, or
   * undefined — synchronous, no request, no outcome recorded. Lets a caller
   * with a per-sweep lookup budget charge only the lookups that go to the
   * network.
   */
  cachedTokenPairs?(chainId: number, address: string): TokenPairEvidence | undefined;

  getMetrics(): PriceMetrics;
}

/**
 * Build a stable lookup key for a (chainId, address) tuple — used by providers and
 * orchestrator to keep result maps consistent.
 */
export function providerAddressKey(chainId: number, address: string): string {
  return `${chainId}:${address.toLowerCase()}`;
}

/**
 * Build a stable lookup key for a historical request — same shape as
 * `historicalTokenPriceRequestKey` in pricing.service so orchestrator results
 * merge into the caller's expected map.
 */
export function providerHistoricalKey(req: HistoricalReq): string {
  return `${req.chainId}:${req.address.toLowerCase()}:${req.timestamp}`;
}
