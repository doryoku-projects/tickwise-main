import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { getChainConfig, isSymbolSpoof } from '../config/chains.config.js';
import { AppConfigService } from '../config/app-config.service.js';
import {
  historicalLookupKey,
  TokenPriceRepository,
  type HistoricalPriceRecord,
} from '../database/token-price.repository.js';
import { ProviderRegistry } from './providers/provider-registry.js';
import {
  providerAddressKey,
  type HistoricalReq,
  type DexPairSummary,
  type PriceProvider,
  type PriceQuote,
  type TokenPairEvidence,
} from './providers/price-provider.interface.js';
import {
  classifyAnchor,
  getPricingPolicy,
  isAnchorTokenStandalone,
  type AnchorKind,
  type PricingPolicy,
} from './pricing-policy.js';
import {
  getSqrtRatioAtTick,
  positionAmountsAtPrice,
  sqrtRatioX96ToToken1PerToken0,
} from './tick-math.js';
import { isDerivedHistoricalSource } from './pricing-revision.js';
import { TokenListingService } from './token-listing.service.js';
import {
  TokensRepository,
  type GuardedPriceClear,
  type TokenLookupPriority,
  type TokenPriceRecord,
  type TokenTrustRecord,
} from '../database/token.repository.js';
import { reconcileQuotes, consensusToConfidence, DEX_MARKET_SOURCES, type SourceQuote } from './quote-consensus.js';
import { PriceMissLedger, definiteMisses, type PriceMissLedgerStats, type PriceMissStore } from './price-ledger.js';
import { strictProviderHealthOf } from './providers/geckoterminal.provider.js';
import { isAllowlisted } from './token-allowlist.js';
import { TokenTrustService } from './token-trust.service.js';
import {
  batchPairLookupBudget,
  batchShare,
  chargePairLookup,
  processPairLookupBucket,
  runPairLookupBudget,
  type PairLookupBucket,
  type PairLookupBudget,
  type PairLookupShare,
} from './pair-lookup-budget.js';
import {
  evaluateEarnedTrust,
  quoteEvidenceOn,
  quoteRejection,
  summarizeDexPools,
  trustEvidenceOn,
  trustPolicyOf,
  isDenied,
  usesStoredVerdicts,
  type DexPoolLiquidity,
  type StoredTokenTrust,
  type TrustPolicy,
} from './token-trust.js';

export type PricingSource = 'stable-anchor' | 'native-anchor' | 'external' | 'historical' | 'none';

/**
 * Per-token internal source. Records WHERE the chosen price came from
 * so downstream code can reason about trust (e.g. valuation guard,
 * preservation guard). External providers collapse to `external` here;
 * the provider name lives on the historical cache row instead.
 */
export type PriceSourceKind =
  | 'stable-anchor'
  | 'native-anchor'
  | 'external'
  | 'historical'
  | 'pool-ratio'
  | 'last-known'
  | 'miss'
  | 'none';

/**
 * Per-token internal confidence. Coarser than source: a single ordering
 * scale callers can compare against. `anchor` is the highest trust
 * (assumed peg / native), `suspect` lowest. `missing` means no price.
 */
export type PriceConfidence =
  | 'anchor'
  | 'external-verified'
  | 'external-unverified'
  | 'pool-derived-strong'
  | 'pool-derived-weak'
  | 'last-known-strong'
  | 'last-known-weak'
  | 'missing'
  | 'suspect';

export const PRICE_CACHE_BUCKET_SECONDS = 1800;
const HISTORICAL_CACHE_WINDOW_SECONDS = 4 * 60 * 60;
const CURRENT_CACHE_TTL_MS = 300_000; // 5 minutes (positive prices)
// Negative (miss) in-memory entries expire fast so a token that missed (e.g.
// gecko 429) re-attempts soon and picks up a freshly-cached `1_tokens` price —
// a long negative TTL otherwise masks the last-known-good for minutes.
const MISS_CACHE_TTL_MS = Math.max(5_000, Number(process.env.PRICING_MISS_MEMORY_TTL_MS) || 45_000);
const HISTORICAL_CACHE_TTL_MS = 24 * 60 * 60_000;

// Absolute sanity ceiling on any derived / overridden token price. No
// legitimate ERC-20 unit price exceeds this — a pool ratio that derives more
// (a real case hit $89B/token from a thin/broken pool) is garbage. Such prices
// are never adopted in an override, never written to the cache, and ignored on
// read, so a pre-existing poisoned row self-heals without a migration. High
// divergence alone is deliberately NOT a reject signal: for long-tail tokens
// the external quote is often the wrong (near-zero) one and the pool ratio is
// the truth — that's what the override exists for. Env-tunable.
const MAX_DERIVED_TOKEN_PRICE_USD = Math.max(0, Number(process.env.MAX_DERIVED_TOKEN_PRICE_USD) || 1_000_000);

// How long a previously-fetched ("last-known-good") current price stays usable
// when live providers transiently miss/rate-limit. Real-market tokens are
// re-priced every sync, so this only kicks in during a provider gap and keeps a
// position from flipping to $0. Env-tunable; 0 disables the fallback.
const LAST_KNOWN_MAX_AGE_MS = Math.max(0, Number(process.env.PRICING_LAST_KNOWN_MAX_AGE_MS) || 24 * 60 * 60 * 1000);
/**
 * The oldest cached positive price the backfill pipeline's cache-only pricing
 * serves: the stored last-known-good's freshness bound (the positive TTL when
 * last-known-good is disabled). Measured from when the price was fetched.
 */
const CACHE_ONLY_MAX_AGE_MS = Math.max(CURRENT_CACHE_TTL_MS, LAST_KNOWN_MAX_AGE_MS);
/** When a positive `externalCache` entry was fetched (every positive is set with the positive TTL). */
function cachedPositiveAtMs(entry: { expiresAt: number }): number {
  return entry.expiresAt - CURRENT_CACHE_TTL_MS;
}

export interface TokenMeta {
  address: string;
  decimals: number;
  symbol?: string;
  verified?: boolean;
}

export interface PriceInput {
  chainId: number;
  /**
   * Optional protocol key (e.g. 'uniswap-v4'). When present, the pricing
   * policy resolver consults `protocols.config` to decide whether pool-
   * ratio derivation is supported. Callers without protocol context fall
   * through to chain-level policy.
   */
  protocol?: string;
  token0: TokenMeta;
  token1: TokenMeta;
  sqrtPriceX96?: string | null;
  tick?: number | null;
  poolTvlUsd?: number;
  poolTvlUsdUntracked?: number;
  poolVolumeUsd?: number;
  poolTotalFeesUsd?: number;
}

export interface PriceResult {
  token0Usd: number;
  token1Usd: number;
  source: PricingSource;
  usedFallback: boolean;
  /**
   * Optional per-token observability. Populated by `pricePool` when the
   * new policy-driven decision runs; legacy callers ignore them. Kept
   * optional so downstream consumers that destructure `{ token0Usd,
   * token1Usd, source, usedFallback }` remain compile-clean.
   */
  token0Source?: PriceSourceKind;
  token1Source?: PriceSourceKind;
  token0Confidence?: PriceConfidence;
  token1Confidence?: PriceConfidence;
  /**
   * Quote guard (`PRICE_QUOTE_GUARD=on`) only: is the leg's quote corroborated
   * by ≥ 2 independent sources? `true` = the sweep's stored consensus agreed
   * (or, in earned mode, the token earned trust, which requires it); `false`
   * = the stored verdict says one source / disagreeing sources; ABSENT = no
   * evidence (unswept, not warmed, or the guard is off) — the adapter then
   * leaves the leg alone, as today. Read by envio.adapter.ts's allowlisted-pair
   * cross-check (`crossCheckAllowlistedPair`).
   */
  token0Corroborated?: boolean;
  token1Corroborated?: boolean;
}

/**
 * Pure decision-policy result for one side of a pool. Internal — the
 * `pricePool` orchestrator unpacks two of these into the public
 * `PriceResult` shape.
 */
interface TokenDecision {
  priceUsd: number;
  source: PriceSourceKind;
  confidence: PriceConfidence;
  /** True if pool-ratio derivation contributed to the final price. */
  derived: boolean;
}

export interface HistoricalTokenPriceRequest {
  chainId: number;
  address: string;
  timestamp: number;
  /** Optional symbol for logging only — has no effect on lookup or caching. */
  symbol?: string;
  /**
   * Optional pool context for the derivation provider (subgraph-pool-ratio).
   * `poolHint` is the pool address, `anchorAddress` is the counterparty token,
   * `protocol` selects the adapter that can fetch pool snapshots. Decimals
   * and `isToken0` orient the sqrtPriceX96 ratio. All must be present for the
   * derivation provider to attempt a quote.
   */
  poolHint?: string;
  anchorAddress?: string;
  protocol?: string;
  tokenDecimals?: number;
  anchorDecimals?: number;
  isToken0?: boolean;
  /** Pass-through to provider — see HistoricalReq.unverified. */
  unverified?: boolean;
}

/**
 * Options of one `pricePool` call. `cacheOnly` is the backfill pipeline's
 * contract (`BACKFILL_PIPELINE=on`): a range normalizes with whatever its price
 * prefetch put in the cache by the deadline, and pricing NEVER calls a provider
 * or reads Mongo for it — a token the cache does not hold prices at $0 for that
 * row (counted, `cacheOnlyMisses`). An EXPIRED positive entry still serves its
 * price (stale-but-real beats $0 for a row that may never be revisited).
 */
export interface PricePoolOptions {
  cacheOnly?: boolean;
}

/** Process-wide price-walk counters, read as deltas by the backfill profile. */
export interface PricingWalkStats {
  /** `findLatestPrices` reads (last-known-good), all paths. */
  lastKnownReads: number;
  /** `cacheOnly` lookups the cache could not answer (priced $0). */
  cacheOnlyMisses: number;
  /** Batch calls per provider made by `prefetchPrices`. */
  providerCalls: Record<string, number>;
  ledger: PriceMissLedgerStats;
}

/** What one consensus sweep batch did beyond pricing (all 0 with the guard / trust evidence off). */
export interface ConsensusSweepStats {
  /** Earned-trust verdicts stored (shadow or live). */
  trustVerdicts: number;
  trustEarned: number;
  /**
   * Swept tokens (trust evidence on) for which NO verdict could be stored: no
   * DEX provider answered for them with certainty, a single-source /
   * stale-quote failure on an answer that was not definite (a provider skipped,
   * or one that ran could not vouch for the token), a "no DEX market" failure
   * when a DEX-market provider that ran could not vouch for it or DexScreener
   * was skipped, a DEX market judged on a SAMPLE of the token's pairs that
   * failed with no complete reading of its own pairs to confirm it, or "single
   * pool" from a sample. Their previous verdict stays and ages out to
   * `stale-verdict`.
   * `trustVerdicts + trustUnknown` = the tokens swept (de-duplicated; tokens
   * the miss ledger holds are not swept).
   */
  trustUnknown: number;
  /** Tokens with ≥ 1 quote the guard rejects / would reject. */
  guardRejected: number;
  /** Saved prices the guard cleared (a definite answer, every quote rejected, the saved price from the rejected providers). */
  guardCleared: number;
}

/**
 * One token-price sweep RUN of a chain (`PricingService.startConsensusSweep`),
 * threaded through every `prefetchConsensus` batch of it: the pair-lookup
 * budgets are the RUN's, not each 500-token batch's, and they draw from the
 * process-wide DexScreener token-pairs rate (`pair-lookup-budget.ts`).
 */
export interface ConsensusSweepRun {
  /** The run's pair-lookup budgets and what it sent (`pairLookups.sent`). */
  readonly pairLookups: PairLookupBudget;
  /**
   * A batch of the run could look pairs up (trust evidence on, or per-chain
   * mode, with a pair source running): the sweep line then prints
   * `pairLookups=`, so with every flag off it stays as it was.
   */
  lookupsPossible: boolean;
}

export interface AmountInput {
  liquidity: string;
  tickLower: number;
  tickUpper: number;
  sqrtPriceX96?: string | null;
  currentTick?: number | null;
  decimals0: number;
  decimals1: number;
}

@Injectable()
export class PricingService {
  private readonly logger = new Logger(PricingService.name);
  /**
   * In-memory cache for current-price lookups (5min) and historical lookups
   * (24h). Keyed by `chainSlug:address[@timestamp]`. Survives across calls but
   * not across process restarts.
   */
  private readonly externalCache = new Map<string, { price: number; expiresAt: number; poolDerived?: boolean }>();
  /**
   * DEX-market state per token (`chainSlug:address` → does a real on-chain DEX
   * market price it, per the consensus sweep's stored `priceSources`). Warmed
   * per page by `prefetchPrices`/`loadDexMarketState`; read by the pricePool
   * value gate. ABSENT key = UNKNOWN (not yet swept) → the gate fails OPEN.
   */
  private readonly dexMarketCache = new Map<string, { backed: boolean; expiresAt: number }>();
  /**
   * Cross-call single-flight for historical lookups. Concurrent
   * `historicalTokenPricesUsdMany` calls that need the same
   * (chainId, address, bucketTs) await one shared in-flight resolution instead
   * of each walking the provider chain — kills the thundering herd during
   * parallel backfill. Resolves to the looked-up USD price (0 if unpriced);
   * the owning call removes the entry when it settles.
   */
  private readonly inflightHistorical = new Map<string, Promise<number>>();
  /** The external-price miss ledger (`PRICE_MISS_LEDGER`), process-wide. */
  private readonly ledger: PriceMissLedger;
  private lastKnownReads = 0;
  private cacheOnlyMisses = 0;
  private readonly providerCalls = new Map<string, number>();

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(TokenPriceRepository) private readonly tokenPrices: TokenPriceRepository,
    /**
     * Optional so unit tests can construct the service without wiring the full
     * provider DI graph. When undefined, all external lookups short-circuit
     * to 0; cache reads continue to function.
     */
    @Optional() @Inject(ProviderRegistry) private readonly registry?: ProviderRegistry,
    /**
     * Optional so unit tests can construct without the listing service — when
     * absent the listing gate is skipped (fail-open).
     */
    @Optional() @Inject(TokenListingService) private readonly listing?: TokenListingService,
    /**
     * Current-price last-known-good store (`{chainId}_tokens`). Optional + LAST
     * so positional unit-test construction (config, tokenPrices, registry,
     * listing) is unaffected; when absent last-known-good short-circuits.
     */
    @Optional() @Inject(TokensRepository) private readonly tokens?: TokensRepository,
    /**
     * The ONE token-trust answer (`pricing/token-trust.ts`), shared with the
     * pools sync. APPENDED and optional: specs construct positionally; absent,
     * a private instance over the same config + store gives the same answers.
     */
    @Optional() @Inject(TokenTrustService) private readonly trustService?: TokenTrustService,
  ) {
    this.ledger = new PriceMissLedger(this.tokens as PriceMissStore | undefined);
  }

  private trustFallback?: TokenTrustService;
  /** Stored consensus flag per token (`chainSlug:address`), warmed with the DEX-market state when the guard is on. */
  private readonly disagreedCache = new Map<string, { disagreed: boolean; expiresAt: number }>();
  /** Stored sweep consensus verdict per token (`priceConfidence`), warmed in the same read; guard only. */
  private readonly consensusCache = new Map<string, { consensus: boolean; expiresAt: number }>();
  /**
   * When this process last SENT a token-pairs request for a token
   * (`chainId:address` → ms; `pairLookup`), either kind: the last key of a
   * batch's request order (`orderPairRequests`), so tokens the stored state
   * cannot tell apart take turns from run to run instead of the same first
   * ones of the batch asking every time. Kept in insertion (= ask) order and
   * capped at `PAIR_ASKED_MAX` by dropping the least recently asked (which
   * then reads "never asked" — first in line, where it already was).
   */
  private readonly pairAskedAt = new Map<string, number>();

  /** The token-trust service (injected, or a private one over the same config + store). */
  private trust(): TokenTrustService {
    return this.trustService ?? (this.trustFallback ??= new TokenTrustService(this.config, this.tokens));
  }

  /** `PRICE_MISS_LEDGER=on` (config getter `priceMissLedger`: `'on'` or `true`); anything else = off (today). */
  private ledgerOn(): boolean {
    const v = (this.config as unknown as { priceMissLedger?: unknown }).priceMissLedger;
    return v === 'on' || v === true;
  }

  /** Counters for the backfill profile / status (copies). */
  pricingWalkStats(): PricingWalkStats {
    return {
      lastKnownReads: this.lastKnownReads,
      cacheOnlyMisses: this.cacheOnlyMisses,
      providerCalls: Object.fromEntries(this.providerCalls),
      ledger: this.ledger.stats(),
    };
  }

  async pricePool(input: PriceInput, opts?: PricePoolOptions): Promise<PriceResult> {
    const cacheOnly = opts?.cacheOnly === true;
    const policy = getPricingPolicy(input.chainId, input.protocol);
    const token0Address = input.token0.address.toLowerCase();
    const token1Address = input.token1.address.toLowerCase();

    const token0Anchor: AnchorKind = policy ? classifyAnchor(policy, token0Address) : 'none';
    const token1Anchor: AnchorKind = policy ? classifyAnchor(policy, token1Address) : 'none';

    // Stage 1: external + native anchor lookups. Stablecoin assumed peg
    // is not auto-applied here — external providers usually quote
    // USDC/USDT close to $1 anyway, and the assumed-peg fallback is
    // reserved for the historical path where API gaps are common.
    let t0Decision: TokenDecision = { priceUsd: 0, source: 'none', confidence: 'missing', derived: false };
    let t1Decision: TokenDecision = { priceUsd: 0, source: 'none', confidence: 'missing', derived: false };

    if (this.config.priceFallbackEnabled) {
      const [ext0, ext1] = await Promise.all([
        this.externalTokenUsd(input.chainId, token0Address, input.token0.symbol, cacheOnly),
        this.externalTokenUsd(input.chainId, token1Address, input.token1.symbol, cacheOnly),
      ]);
      // Pass-2 subgraph-fallback quotes are pool-derived, not independent
      // markets — demote a NON-anchor leg's confidence so it can never serve
      // as a trust reference or count as a verified market downstream (seeded
      // derivedETH priced allowlisted AMKT at $10.4M; anchors keep their
      // anchor confidence — they are asserted, not quote-derived).
      if (ext0 > 0) {
        t0Decision = this.quoteWasPoolDerived(input.chainId, token0Address) && token0Anchor === 'none'
          ? { priceUsd: ext0, source: 'pool-ratio', confidence: 'pool-derived-strong', derived: true }
          : externalDecision(input.token0, token0Anchor, ext0);
      }
      if (ext1 > 0) {
        t1Decision = this.quoteWasPoolDerived(input.chainId, token1Address) && token1Anchor === 'none'
          ? { priceUsd: ext1, source: 'pool-ratio', confidence: 'pool-derived-strong', derived: true }
          : externalDecision(input.token1, token1Anchor, ext1);
      }
    }

    if (t0Decision.priceUsd === 0 && token0Anchor === 'native') {
      const nativePrice = await this.nativeUsd(input.chainId, undefined, cacheOnly);
      if (nativePrice > 0) {
        t0Decision = { priceUsd: nativePrice, source: 'native-anchor', confidence: 'anchor', derived: false };
      }
    }
    if (t1Decision.priceUsd === 0 && token1Anchor === 'native') {
      const nativePrice = await this.nativeUsd(input.chainId, undefined, cacheOnly);
      if (nativePrice > 0) {
        t1Decision = { priceUsd: nativePrice, source: 'native-anchor', confidence: 'anchor', derived: false };
      }
    }

    // Listing-trust gate state (applied after pool-ratio). Anchors and allowlisted
    // tokens are always trusted; a non-listed token is trusted only if it carries a
    // real external aggregator/DEX quote (`external-*`) — a pool-only derived price
    // means no real market and contributes $0. Pool-vs-market consistency is then
    // enforced per-position by the valuation guard. Symbol-spoofs are forced suspect.
    const gateOn = this.config.tokenListingGateEnabled && !!this.listing;
    const listed0 = this.listedFor(input.chainId, token0Address);
    const listed1 = this.listedFor(input.chainId, token1Address);
    // Quote guard: a listed token's quote is NOT upgraded to
    // `external-verified` when the sweep recorded that ≥ 2 of its accepted
    // quotes DISAGREED (the stored price is their conservative MIN) — so the
    // pool cross-check and backing floor apply to it. A token with only ONE
    // source is not a disagreement: it keeps today's upgrade (SPY/NVDA on 4663
    // are single-source, and denying them the upgrade zeroed real listed/listed
    // pairs through the no-reference rule). AERGO/HPP needs no lever here: the
    // guard rejects HPP's stale DIA quote and DeFiLlama's $0.0062 wins.
    const guard = trustPolicyOf(this.config).quoteGuard;
    const noUpgrade0 = guard && this.storedDisagreement(input.chainId, token0Address) === true;
    const noUpgrade1 = guard && this.storedDisagreement(input.chainId, token1Address) === true;
    const spoof0 = isSymbolSpoof(input.chainId, input.token0.symbol, token0Address);
    const spoof1 = isSymbolSpoof(input.chainId, input.token1.symbol, token1Address);
    // DEX-market value gate: a non-anchor/non-listed leg's price is trusted for
    // value ONLY when a real on-chain DEX market corroborates it ('backed').
    // 'no-market' (priced solely by non-DEX aggregators — a symbol/FX match for
    // a scam token with no DEX pair: EUR=fiat, GOLDX=gold, DTC=$1) → zeroed.
    // 'unknown' (not yet swept) → fail OPEN (the magnitude backstop still caps
    // any egregious value). RPC keeps its real DexScreener-backed $0.0105.
    const dexState0 = this.config.dexMarketGateEnabled ? this.dexMarketState(input.chainId, token0Address) : 'unknown';
    const dexState1 = this.config.dexMarketGateEnabled ? this.dexMarketState(input.chainId, token1Address) : 'unknown';

    // Stage 2: policy-gated pool-ratio derivation. Three branches:
    //   - Fill-missing  → unknown side, anchor on the other side, low TVL ok
    //   - Override-unverified → externals returned a low-quality quote
    //   - Override-verified  → only for severe divergence on deep pools
    const ratio = this.ratio(input);
    if (policy && policy.derivation.enabled && ratio > 0) {
      const tvl = pickPoolTvl(input);
      const requireAnchor = policy.derivation.requireAnchorSideForCurrent;
      const anyAnchor = token0Anchor !== 'none' || token1Anchor !== 'none';
      if (!requireAnchor || anyAnchor) {
        // Token0 missing, token1 known anchor → derive token0.
        if (t0Decision.priceUsd === 0 && t1Decision.priceUsd > 0 && token1Anchor !== 'none'
          && tvl >= policy.derivation.minTvlUsdFillMissing) {
          const derived = ratio * t1Decision.priceUsd;
          if (derived > 0 && derived <= MAX_DERIVED_TOKEN_PRICE_USD) {
            t0Decision = poolDerivedDecision(derived, tvl, policy, /*strong=*/ tvl >= policy.derivation.minTvlUsdOverrideVerified);
          }
        }
        // Token1 missing, token0 known anchor → derive token1.
        if (t1Decision.priceUsd === 0 && t0Decision.priceUsd > 0 && token0Anchor !== 'none'
          && tvl >= policy.derivation.minTvlUsdFillMissing) {
          const derived = t0Decision.priceUsd / ratio;
          if (derived > 0 && derived <= MAX_DERIVED_TOKEN_PRICE_USD) {
            t1Decision = poolDerivedDecision(derived, tvl, policy, /*strong=*/ tvl >= policy.derivation.minTvlUsdOverrideVerified);
          }
        }
        // Both sides priced, one side an anchor — consider override.
        if (t0Decision.priceUsd > 0 && t1Decision.priceUsd > 0) {
          if (token0Anchor !== 'none' && token1Anchor === 'none') {
            const derived = t0Decision.priceUsd / ratio;
            const override = decideOverride(t1Decision, derived, tvl, policy);
            if (override) t1Decision = override;
          } else if (token1Anchor !== 'none' && token0Anchor === 'none') {
            const derived = ratio * t1Decision.priceUsd;
            const override = decideOverride(t0Decision, derived, tvl, policy);
            if (override) t0Decision = override;
          }
        }
      }
    }

    // Trust gate: a non-listed, non-anchor leg is kept only if it has a real
    // external quote (`external-*`); a pool-only derived/missing price → $0 (no
    // real market); symbol-spoofs → suspect. Per-position pool-vs-market
    // consistency is enforced downstream by the valuation guard.
    if (gateOn) {
      const failClosed = this.config.dexMarketFailClosed;
      t0Decision = applyTrustGate(t0Decision, token0Anchor, listed0, spoof0, dexState0, failClosed, noUpgrade0);
      t1Decision = applyTrustGate(t1Decision, token1Anchor, listed1, spoof1, dexState1, failClosed, noUpgrade1);
    }

    const result = buildPriceResult(t0Decision, t1Decision);
    // Quote guard: attach per-leg corroboration evidence for the adapter's
    // allowlisted-pair cross-check. Only a definite answer is attached — no
    // evidence leaves the field absent, which the adapter reads as "leave the
    // leg alone" (today's behaviour). Guard off: nothing is added.
    if (guard) {
      const c0 = this.legCorroborated(input.chainId, token0Address);
      const c1 = this.legCorroborated(input.chainId, token1Address);
      if (c0 !== undefined) result.token0Corroborated = c0;
      if (c1 !== undefined) result.token1Corroborated = c1;
    }
    return result;
  }

  /**
   * Kept as a method for the v3 adapter, which already holds a PricingService.
   * The math is pure and lives in `tick-math.ts` — call `positionAmountsAtPrice`
   * directly where there is no service to hand (it needs no prices or config).
   */
  positionAmounts(input: AmountInput): { amount0: number; amount1: number } | null {
    return positionAmountsAtPrice(input);
  }

  ratio(input: PriceInput): number {
    try {
      if (input.sqrtPriceX96) {
        return sqrtRatioX96ToToken1PerToken0(
          BigInt(input.sqrtPriceX96),
          input.token0.decimals,
          input.token1.decimals,
        );
      }
      if (input.tick != null && Number.isFinite(input.tick)) {
        return sqrtRatioX96ToToken1PerToken0(
          getSqrtRatioAtTick(Math.trunc(input.tick)),
          input.token0.decimals,
          input.token1.decimals,
        );
      }
    } catch {
      return 0;
    }
    return 0;
  }

  async historicalPricePool(input: PriceInput & { timestamp: number }): Promise<PriceResult> {
    const chain = getChainConfig(input.chainId);
    if (!chain) return { token0Usd: 0, token1Usd: 0, source: 'none', usedFallback: false };

    const token0Address = input.token0.address.toLowerCase();
    const token1Address = input.token1.address.toLowerCase();

    const [t0Usd, t1Usd] = await Promise.all([
      this.historicalTokenPriceUsd(input.chainId, token0Address, input.timestamp),
      this.historicalTokenPriceUsd(input.chainId, token1Address, input.timestamp),
    ]);

    const source: PricingSource = t0Usd > 0 || t1Usd > 0 ? 'historical' : 'none';
    return { token0Usd: t0Usd, token1Usd: t1Usd, source, usedFallback: false };
  }

  /**
   * Single-token historical price. Implemented as a thin wrapper over the
   * batched orchestrator so all callers exercise the same fallback chain.
   */
  async historicalTokenPriceUsd(
    chainId: number,
    address: string,
    timestamp: number,
  ): Promise<number> {
    if (!timestamp || timestamp <= 0) return 0;
    const map = await this.historicalTokenPricesUsdMany([{ chainId, address, timestamp }]);
    return map.get(historicalTokenPriceRequestKey(chainId, address, timestamp)) ?? 0;
  }

  /**
   * Side-channel cache inspection used by the recompute self-heal block.
   * Returns the subset of `lookups` whose cached row is tagged with a
   * derived source AND was written before `before` — i.e. cache entries that
   * may have been produced by a pre-fix pricing-logic revision.
   *
   * Keys in the returned Set use the same `historicalLookupKey` format used
   * elsewhere in this module so the caller can probe with `Set.has(key)`.
   */
  async findStaleDerivedCacheKeys(
    lookups: Array<{ chainId: number; address: string; bucketTs: number }>,
    before: Date,
  ): Promise<Set<string>> {
    const result = new Set<string>();
    if (lookups.length === 0) return result;
    const rows = await this.tokenPrices.findHistoricalNearMany(
      lookups.map((l) => ({ ...l, address: l.address.toLowerCase(), windowBuckets: 0 })),
    );
    for (const [key, row] of rows) {
      if (!isDerivedHistoricalSource(row.source)) continue;
      const fetchedAt = row.fetchedAt instanceof Date ? row.fetchedAt : null;
      if (fetchedAt && fetchedAt < before) result.add(key);
    }
    return result;
  }

  /**
   * Batched historical pricing. Dedupes by `(chainId, address, bucketTs)`,
   * serves cache hits without external calls, then walks the provider
   * registry in order: batched call (when supported) first, single-token
   * concurrent fan-out for the remainder. Rate-limited providers are skipped
   * immediately; on outage every provider downgrades cleanly to `null`.
   */
  async historicalTokenPricesUsdMany(
    requests: HistoricalTokenPriceRequest[],
  ): Promise<Map<string, number>> {
    const prices = new Map<string, number>();
    if (requests.length === 0) return prices;
    const batchStartedAt = Date.now();

    const bucketSeconds = PRICE_CACHE_BUCKET_SECONDS;
    const unique = new Map<string, HistoricalTokenPriceRequest & { bucketTs: number }>();
    for (const req of requests) {
      const chain = getChainConfig(req.chainId);
      if (!chain || !req.timestamp || req.timestamp <= 0) continue;
      const address = req.address.toLowerCase();
      const bucketTs = Math.floor(req.timestamp / bucketSeconds) * bucketSeconds;
      const key = historicalTokenPriceRequestKey(req.chainId, address, req.timestamp);
      unique.set(key, { ...req, address, bucketTs });
    }
    if (unique.size === 0) return prices;

    const cacheLookups = [...unique.values()].map((req) => ({
      chainId: req.chainId,
      address: req.address,
      bucketTs: req.bucketTs,
      windowBuckets: HISTORICAL_CACHE_WINDOW_SECONDS,
    }));
    const cached = await this.tokenPrices.findHistoricalNearMany(cacheLookups);

    const symbolByAddress = new Map<string, string | undefined>();
    for (const req of unique.values()) {
      if (req.symbol && !symbolByAddress.has(req.address)) symbolByAddress.set(req.address, req.symbol);
    }
    await this.warmHistoricalTrust(unique.values());

    const nowMs = Date.now();
    const missTtlMs = this.config.pricingMissTtlMs;
    const missing: Array<HistoricalTokenPriceRequest & { bucketTs: number }> = [];
    let cacheHits = 0;
    let missCacheHits = 0;
    for (const [key, req] of unique) {
      const cachedRow = cached.get(historicalLookupKey(req));
      // Positive-price cache hit from a non-derived source: serve directly.
      // Over-ceiling rows are treated as a non-hit (re-resolved / left unpriced)
      // so any pre-existing poisoned $-billion row self-heals.
      if (
        cachedRow
        && cachedRow.priceUsd > 0
        && cachedRow.priceUsd <= MAX_DERIVED_TOKEN_PRICE_USD
        && !isDerivedHistoricalSource(cachedRow.source)
        // Pool-derived rows (the subgraph family — persisted by older builds,
        // or by the trusted-market path below) are believed only for tokens
        // that HAVE a trusted market: a spam token's self-minted derivedETH
        // row (RPC at $0.0107 from its own seeded pool) must not keep serving
        // from cache after the write-side gates stopped refreshing it.
        && (!isPoolDerivedSource(cachedRow.source ?? '') || this.hasTrustedMarket(req.chainId, req.address))
      ) {
        prices.set(key, cachedRow.priceUsd);
        cacheHits += 1;
        continue;
      }
      // Recent miss row: short-circuit. TTL is short (default 30 min) so
      // any token that becomes priceable later gets retried soon. The
      // alternative — walking 6+ providers for every known-impossible
      // token on every batch — is what blew batch times to 30s+.
      if (
        cachedRow
        && cachedRow.source === 'miss'
        && isMissStillValid(cachedRow.fetchedAt, missTtlMs, nowMs)
      ) {
        prices.set(key, 0);
        missCacheHits += 1;
        continue;
      }
      missing.push(req);
    }

    if (missing.length === 0) return prices;

    // Single-flight: split `missing` into keys this call owns (register an
    // in-flight promise) vs keys already being resolved by a concurrent call
    // (await + merge below, don't re-fetch). The resolution path that follows
    // cannot throw — every provider stage catches internally and the cache
    // upsert uses `.catch` — so owned promises are always settled before
    // return (no try/finally needed).
    const ownedResolvers = new Map<string, (price: number) => void>();
    const borrowedKeys: Array<{ key: string; promise: Promise<number> }> = [];
    const ownedMissing: Array<HistoricalTokenPriceRequest & { bucketTs: number }> = [];
    for (const req of missing) {
      const key = historicalTokenPriceRequestKey(req.chainId, req.address, req.timestamp);
      const inflight = this.inflightHistorical.get(key);
      if (inflight) {
        borrowedKeys.push({ key, promise: inflight });
        continue;
      }
      let resolveOwned!: (price: number) => void;
      const promise = new Promise<number>((resolve) => {
        resolveOwned = resolve;
      });
      this.inflightHistorical.set(key, promise);
      ownedResolvers.set(key, resolveOwned);
      ownedMissing.push(req);
    }
    // Provider stages run only for owned keys; borrowed keys are filled from
    // their owner's result after the stages complete.
    missing.length = 0;
    missing.push(...ownedMissing);

    const fetchedRecords: HistoricalPriceRecord[] = [];
    const providers = this.registry?.historicalProviders() ?? [];
    const providerTimeoutMs = this.config.pricingProviderTimeoutMs;

    // 3-stage pipeline:
    //   Stage 1 (primary)   → sequential, e.g. subgraph-historical. Cheap +
    //                         covers majority of tokens.
    //   Stage 2 (externals) → parallel race on survivors. Each external runs
    //                         concurrently; first positive price (preserved
    //                         in PRICING_PROVIDERS env order on tie) wins per
    //                         token. Wall-clock = slowest external, not sum.
    //   Stage 3 (context)   → sequential pool-ratio derivation. Needs anchor
    //                         prices from stages 1+2, so must run last.
    const primaryProviders = providers.filter(
      (p) => p.tier === 'primary' && !p.getHistoricalBatchWithContext,
    );
    const externalProviders = providers.filter(
      (p) =>
        p.tier !== 'primary'
        && !p.getHistoricalBatchWithContext,
    );
    const contextProviders = providers.filter((p) => !!p.getHistoricalBatchWithContext);

    // Stage 1: primary providers, sequential. Pool-derived primaries (the
    // subgraph family — `tokenHourData.priceUSD` is derivedETH, seedable by a
    // token's own pool) only quote tokens with a trusted market, mirroring the
    // current-price pass-2 gate: a no-market token must never get a
    // pool-minted price persisted into the historical cache (RPC's $0.0107
    // "subgraph-current" rows came from exactly this hole).
    for (const provider of primaryProviders) {
      if (missing.length === 0) break;
      if (!provider.isAvailable()) continue;
      const eligible = isPoolDerivedSource(provider.name)
        ? missing.filter((req) => this.hasTrustedMarket(req.chainId, req.address))
        : missing;
      if (eligible.length === 0) continue;
      await this.invokeProviderInto(
        provider,
        eligible,
        prices,
        fetchedRecords,
        symbolByAddress,
        providerTimeoutMs,
      );
      this.dropSatisfied(missing, prices);
    }

    // Stage 2: external providers race in parallel on the surviving missing.
    if (missing.length > 0 && externalProviders.length > 0) {
      const availableExternals = externalProviders.filter((p) => p.isAvailable());
      if (availableExternals.length > 0) {
        const missingSnapshot = [...missing];
        const localResults = await Promise.all(
          availableExternals.map(async (provider) => ({
            provider,
            map: await this.callProviderLocal(provider, missingSnapshot, prices, providerTimeoutMs),
          })),
        );
        // Merge in env order (preserves provider preference on ties).
        for (const req of missingSnapshot) {
          const key = historicalTokenPriceRequestKey(req.chainId, req.address, req.timestamp);
          if (prices.has(key)) continue;
          for (const { provider, map } of localResults) {
            const quote = map.get(key);
            if (!quote || quote.priceUsd <= 0 || quote.priceUsd > MAX_DERIVED_TOKEN_PRICE_USD) continue;
            prices.set(key, quote.priceUsd);
            fetchedRecords.push({
              chainId: req.chainId,
              address: req.address,
              bucketTs: req.bucketTs,
              priceUsd: quote.priceUsd,
              source: quote.source ?? provider.name,
            });
            this.logTokenPrice(req.chainId, provider.name, symbolByAddress.get(req.address), req.address, quote.priceUsd, req.bucketTs);
            break;
          }
        }
        this.dropSatisfied(missing, prices);
      }
    }

    // Stage 3: context-aware (pool-ratio) — runs last with anchors.
    for (const provider of contextProviders) {
      if (missing.length === 0) break;
      if (!provider.isAvailable()) continue;
      await this.invokeProviderInto(
        provider,
        missing,
        prices,
        fetchedRecords,
        symbolByAddress,
        providerTimeoutMs,
      );
      this.dropSatisfied(missing, prices);
    }

    // Stage 3b: suspect-price cross-check. For unverified tokens that
    // received an external quote in Stage 1/2 AND have full pool-ratio
    // context, ask the pool-ratio provider for a second opinion. If the
    // two disagree by >SUSPECT_DIVERGENCE_X, prefer the pool-ratio result
    // — the Messari v4 subgraph's `tokenHourData.priceUSD` is known to
    // spike for thin-liquidity unverified tokens (sNUSD at $73 vs real
    // $1, etc) and that bad price ends up in the cache otherwise.
    const overrideOverrides = await this.crossCheckUnverified(
      unique,
      prices,
      fetchedRecords,
      symbolByAddress,
      contextProviders,
      providerTimeoutMs,
    );
    void overrideOverrides;

    // Surviving requests — no provider in the chain could price them. Logged
    // individually so callers can see exactly which tokens went unpriced.
    for (const req of missing) {
      this.logTokenPrice(req.chainId, 'none', symbolByAddress.get(req.address), req.address, 0, req.bucketTs);
    }

    // Survivors: persist a miss row so the next call (within `pricingMissTtlMs`)
    // short-circuits without hitting any provider. Negative cache.
    //
    // Skip the miss-write when the bucket is within `pricingMissIndexingGraceMs`
    // of `now` — subgraph indexing lag means a token that just traded may not
    // have a `tokenHourData` row yet. Without this grace, recent buckets get
    // permanently miss-cached and never retry.
    const missRecords: HistoricalPriceRecord[] = [];
    const indexingGraceMs = this.config.pricingMissIndexingGraceMs;
    for (const req of missing) {
      const key = historicalTokenPriceRequestKey(req.chainId, req.address, req.timestamp);
      prices.set(key, 0);
      const bucketAgeMs = nowMs - req.bucketTs * 1000;
      if (bucketAgeMs < indexingGraceMs) continue;
      missRecords.push({
        chainId: req.chainId,
        address: req.address,
        bucketTs: req.bucketTs,
        priceUsd: 0,
        source: 'miss',
      });
    }

    const allRecords = [...fetchedRecords, ...missRecords];
    if (allRecords.length > 0) {
      await this.tokenPrices
        .upsertManyHistorical(allRecords)
        .catch((err) => this.logger.warn(`historical cache bulk upsert failed: ${err}`));
    }

    const providerHits = fetchedRecords.length;
    const finalMissed = missing.length;
    const durationMs = Date.now() - batchStartedAt;
    const derivedHits = fetchedRecords.filter((r) => isDerivedHistoricalSource(r.source)).length;
    const externalHits = providerHits - derivedHits;
    this.logger.log(
      `Pricing batch: reqs=${requests.length} unique=${unique.size} cacheHits=${cacheHits} missCacheHits=${missCacheHits} externalHits=${externalHits} derivedHits=${derivedHits} missed=${finalMissed} durationMs=${durationMs}`,
    );

    // Resolve the in-flight promises for keys we owned (freeing any concurrent
    // caller awaiting them), then merge in results for keys we borrowed from
    // other in-flight calls. Owned resolved BEFORE awaiting borrowed so two
    // calls that own each other's keys can't deadlock.
    for (const [key, resolveOwned] of ownedResolvers) {
      resolveOwned(prices.get(key) ?? 0);
      this.inflightHistorical.delete(key);
    }
    if (borrowedKeys.length > 0) {
      await Promise.all(
        borrowedKeys.map(async ({ key, promise }) => {
          const price = await promise.catch(() => 0);
          if (price > 0 && !prices.has(key)) prices.set(key, price);
        }),
      );
    }

    return prices;
  }

  /**
   * Best-effort current-price prefetch. Walks the registry's current-batch
   * providers in order; the first batch response wins per token. Results are
   * kept in the short-lived in-memory current cache only; historical pricing
   * has its own cache so a bad current quote cannot poison tx cashflows.
   */
  async prefetchPrices(
    chainId: number,
    tokens: Array<string | { address: string; symbol?: string }>,
  ): Promise<void> {
    const chain = getChainConfig(chainId);
    if (!chain) return;
    if (!this.registry) return;

    // Normalize input shape (back-compat: bare strings allowed) and build
    // address→symbol lookup for the log line further down.
    const normalized = tokens.map((entry) =>
      typeof entry === 'string'
        ? { address: entry.toLowerCase(), symbol: undefined as string | undefined }
        : { address: entry.address.toLowerCase(), symbol: entry.symbol },
    );
    const symbolByAddress = new Map<string, string | undefined>();
    for (const { address, symbol } of normalized) {
      if (!symbolByAddress.has(address)) symbolByAddress.set(address, symbol);
    }

    // Warm the DEX-market gate cache for the whole page in ONE batched read
    // (independent of the price cache — a token can be price-cached but still
    // need its DEX-market verdict for the value gate). Best-effort.
    await this.loadDexMarketState(chainId, [...new Set(normalized.map((t) => t.address))]);

    const now = Date.now();
    const uncached = [...new Set(normalized.map((t) => t.address))].filter((addr) => {
      const cached = this.externalCache.get(currentCacheKey(chain.slug, addr));
      return !cached || cached.expiresAt <= now;
    });
    if (uncached.length === 0) return;

    // Miss ledger (`PRICE_MISS_LEDGER=on`): tokens inside their ladder window
    // are NOT asked of the aggregators (pass 1). Pass 2 (pool-derived sources,
    // trusted-market tokens only) and the last-known-good below still run for
    // them, so a held token prices exactly as a miss did before.
    const ledgerOn = this.ledgerOn();
    const held = ledgerOn ? await this.ledger.held(chainId, uncached) : new Set<string>();
    // Which aggregators were meant to answer, which addresses each was asked,
    // and which answered unhealthily — a miss is DEFINITE only when every
    // expected aggregator answered healthily (see `definiteMisses`).
    const expectedProviders: string[] = [];
    const askedByProvider = new Map<string, Set<string>>();
    const unhealthyProviders = new Set<string>();
    const pricedByAggregator = new Set<string>();

    const remaining = new Set(uncached);
    const toPersist: HistoricalPriceRecord[] = [];
    const guardPolicy = trustPolicyOf(this.config);
    const provenanceByAddr = new Map<string, { provider: string; quote: PriceQuote }>();
    const bucketTs = currentBucketTs();
    // Two-pass walk (mirrors externalTokenUsd). Pass 1: independent
    // aggregators ONLY — pool-derived sources (subgraph derivedETH) are
    // skipped for every token, anchors included (seeded v4 pools minted $287
    // for real FDUSD and $9,155.85 for the BUSD config-anchor). Pass 2:
    // addresses the aggregators missed retry the pool-derived sources IF
    // anchor/allowlisted.
    for (const allowPoolDerivedFallback of [false, true]) {
      for (const provider of this.registry.currentProviders()) {
        if (remaining.size === 0) break;
        const poolDerived = isPoolDerivedSource(provider.name);
        const batchCapable = provider.supportsCurrentBatch && !!provider.getCurrentBatch;
        const pass1Aggregator = !allowPoolDerivedFallback && !poolDerived && batchCapable;
        if (ledgerOn && pass1Aggregator) expectedProviders.push(provider.name);
        // In backoff: not asked, so its share of this walk is UNKNOWN — never
        // a miss (`definiteMisses` requires every expected provider to have
        // been asked).
        if (!provider.isAvailable()) continue;
        if (!provider.supportsCurrentBatch || !provider.getCurrentBatch) continue;
        if (allowPoolDerivedFallback ? !poolDerived : false) continue; // pass 2 retries pool-derived only

        const addrs = [...remaining].filter((addr) => {
          // Aggregators run in pass 1 only, and never for a ledger-held token.
          if (!poolDerived) return !allowPoolDerivedFallback && !held.has(addr);
          if (!allowPoolDerivedFallback) return false; // pool-derived never quotes in pass 1
          return this.hasTrustedMarket(chainId, addr);
        });
        if (addrs.length === 0) continue;
        const MAX = provider.maxBatchSize;
        const chunks: string[][] = [];
        for (let i = 0; i < addrs.length; i += MAX) chunks.push(addrs.slice(i, i + MAX));
        const metricsBefore = ledgerOn && pass1Aggregator ? provider.getMetrics() : undefined;

        // Chunks fired in parallel up to PRICING_PREFETCH_CHUNK_CONCURRENCY.
        // Provider's own `acquireSlot` semaphore caps concurrent HTTP requests;
        // chunk-level parallelism mainly hides RTT between sequential network
        // round-trips that previously serialised here.
        await mapConcurrent(chunks, this.config.pricingPrefetchChunkConcurrency, async (batch) => {
          if (!provider.isAvailable() || !provider.getCurrentBatch) return;
          this.providerCalls.set(provider.name, (this.providerCalls.get(provider.name) ?? 0) + 1);
          const result = await provider.getCurrentBatch(chainId, batch);
          for (const addr of batch) {
            const quote = result.get(providerAddressKey(chainId, addr));
            // Quote guard: a stale / thin quote is a miss here (the next
            // provider is asked; it is never cached or persisted).
            if (quote && quote.priceUsd > 0 && guardPolicy.quoteGuard && quoteRejection(quote, provider.name, guardPolicy)) continue;
            if (quote && quote.priceUsd > 0) {
              if (!poolDerived) pricedByAggregator.add(addr);
              this.externalCache.set(currentCacheKey(chain.slug, addr), {
                price: quote.priceUsd,
                expiresAt: Date.now() + CURRENT_CACHE_TTL_MS,
                // Provenance marker: a pass-2 subgraph quote is pool-derived, not
                // an independent market — pricePool demotes its confidence.
                poolDerived: poolDerived || undefined,
              });
              // Never persist pool-derived quotes as last-known-good — a seeded
              // derivedETH must not resurrect later as a "real" price.
              if (!poolDerived) {
                toPersist.push({ chainId, address: addr, bucketTs, priceUsd: quote.priceUsd, source: quote.source ?? provider.name });
                if (quoteEvidenceOn(guardPolicy)) provenanceByAddr.set(addr, { provider: provider.name, quote });
              }
              remaining.delete(addr);
              this.logTokenPrice(chainId, provider.name, symbolByAddress.get(addr), addr, quote.priceUsd, 0);
            }
            // Do NOT negative-cache a miss here: a transient batch failure (429 →
            // empty result) would otherwise pin EVERY address in the batch at $0
            // for the cache TTL. Unresolved addresses are handled once below, with
            // a last-known-good fallback first.
          }
        });
        if (metricsBefore) {
          askedByProvider.set(provider.name, new Set(addrs));
          // Any rate limit, error or skip during this provider's share (a
          // 429-as-200 is a rate limit; a refused budget is a skip) makes the
          // share UNKNOWN. Conservative under concurrent walks: another walk's
          // error on the same provider also counts — fewer ledger entries,
          // never a wrong one.
          const after = provider.getMetrics();
          if (
            after.error > metricsBefore.error ||
            after.ratelimit > metricsBefore.ratelimit ||
            after.skip > metricsBefore.skip ||
            !provider.isAvailable()
          ) {
            unhealthyProviders.add(provider.name);
          }
        }
      }
    }

    if (ledgerOn) {
      const misses = definiteMisses({
        candidates: uncached.filter((a) => !held.has(a)),
        priced: pricedByAggregator,
        expectedProviders,
        asked: askedByProvider,
        unhealthy: unhealthyProviders,
      });
      await this.ledger.recordMisses(chainId, misses);
      await this.ledger.recordPositives(chainId, pricedByAggregator);
    }

    // Persist successful current prices into `{chainId}_tokens` as durable
    // last-known-good (so a future provider gap can serve them instead of $0).
    // Only NON-pool-derived quotes reach `toPersist` (gated at the push above),
    // so every stored price is a trusted aggregator/anchor quote — safe to
    // serve back without a provenance check. Best-effort.
    if (toPersist.length > 0 && this.tokens) {
      await this.tokens
        .upsertPrices(
          chainId,
          toPersist.map((r) => ({
            address: r.address,
            priceUsd: r.priceUsd,
            symbol: symbolByAddress.get(r.address),
            ...provenanceFields(provenanceByAddr.get(r.address)),
          })),
        )
        .catch((err) => this.logger.warn(`current-price persist failed for ${toPersist.length} tokens: ${(err as Error)?.message ?? String(err)}`));
    }

    // For addresses no live provider priced: serve a recent last-known-good
    // price from `{chainId}_tokens` so a transient gap never zeroes a
    // real-market token (only the residue with no fresh last-known gets the
    // short negative cache). Freshness via `pricedAt` within LAST_KNOWN_MAX_AGE.
    if (remaining.size > 0) {
      const lastKnown =
        this.tokens && LAST_KNOWN_MAX_AGE_MS > 0
          ? await this.readLastKnown(chainId, [...remaining]).catch(() => new Map<string, { priceUsd: number; pricedAt?: Date }>())
          : new Map<string, { priceUsd: number; pricedAt?: Date }>();
      const nowMs = Date.now();
      for (const addr of [...remaining]) {
        const row = lastKnown.get(addr);
        const fresh = Boolean(row && row.priceUsd > 0 && row.pricedAt && nowMs - row.pricedAt.getTime() <= LAST_KNOWN_MAX_AGE_MS);
        // Positive last-known → full TTL; a genuine miss → SHORT negative TTL so
        // it re-attempts soon (and picks up a freshly-cached price) instead of
        // being pinned at $0 for 5 minutes.
        this.externalCache.set(currentCacheKey(chain.slug, addr), {
          price: fresh ? row!.priceUsd : 0,
          expiresAt: nowMs + (fresh ? CURRENT_CACHE_TTL_MS : MISS_CACHE_TTL_MS),
        });
      }
    }
  }

  /**
   * Start one token-price sweep RUN of a chain (`TokenPriceSyncService`): its
   * pair-lookup budgets (`runPairLookupBudget` — earned trust 25 per 500
   * tokens fed and at least 300, + 300 served re-check in per-chain mode, for
   * the WHOLE run, spread over the `tokens` the sweep will feed) and the
   * process-wide DexScreener token-pairs
   * rate every chain's run shares (`processPairLookupBucket`; `bucket`
   * replaces it, for specs). Pass the run to every `prefetchConsensus` batch
   * of the sweep. The budgets used to be per 500-token batch: ~12,600 extra
   * requests per chain-1 sweep in per-chain mode, which benched DexScreener
   * (module doc of `pair-lookup-budget.ts`).
   */
  startConsensusSweep(opts?: { bucket?: PairLookupBucket; tokens?: number }): ConsensusSweepRun {
    return {
      pairLookups: runPairLookupBudget(this.config.dexscreenerBatchEndpoint, opts?.bucket ?? processPairLookupBucket(), opts?.tokens),
      lookupsPossible: false,
    };
  }

  /**
   * CONSENSUS pricing for the background sweep (`TokenPriceSyncService`). Unlike
   * the hot path's first-positive-wins walk, this gathers quotes from EVERY
   * independent (non-pool-derived) aggregator that responds, reconciles them
   * via `reconcileQuotes` (median + outlier rejection → a lone 10,000x quote
   * can't win), and persists `{ priceUsd, priceConfidence, priceSources }` to
   * `{chainId}_tokens`. The hot path then reads that consensus price + its
   * confidence as last-known-good. Best-effort; only positive results persist.
   * Pool-derived sources (`subgraph-*`) are excluded — they're the gated
   * derivedETH fallback, never a consensus vote.
   * `run` (`startConsensusSweep`): this batch spends its share of the sweep
   * run's pair-lookup budgets (`batchShare`) and the shared rate. Without one,
   * the call has its own per-call budgets and no shared rate
   * (`batchPairLookupBudget` — what every call had before runs existed).
   */
  async prefetchConsensus(chainId: number, addresses: string[], run?: ConsensusSweepRun): Promise<ConsensusSweepStats> {
    const stats: ConsensusSweepStats = { trustVerdicts: 0, trustEarned: 0, trustUnknown: 0, guardRejected: 0, guardCleared: 0 };
    // Taken before any early return: a batch that sends nothing still moves
    // the run on, so the run's budget is spread over the batches still to come.
    const lookups = batchShare(run?.pairLookups ?? batchPairLookupBudget(this.config.dexscreenerBatchEndpoint), addresses.length);
    const chain = getChainConfig(chainId);
    if (!chain || !this.registry || addresses.length === 0) return stats;
    let lowers = [...new Set(addresses.map((a) => a.toLowerCase()))];
    // Miss ledger: a held token is not re-asked by the sweep either (its stored
    // verdicts stay as they are until its ladder step elapses).
    const ledgerOn = this.ledgerOn();
    if (ledgerOn) {
      const held = await this.ledger.held(chainId, lowers);
      if (held.size > 0) lowers = lowers.filter((a) => !held.has(a));
      if (lowers.length === 0) return stats;
    }
    // Quote guard / earned trust (`pricing/token-trust.ts`). All off by default:
    // then every quote votes exactly as before and nothing extra is written.
    const policy = trustPolicyOf(this.config);
    const guardOn = policy.quoteGuard;
    const quoteEvidence = quoteEvidenceOn(policy);
    const trustEvidence = trustEvidenceOn(policy);
    const sweepNow = Date.now();
    // Per address: how many of the providers this sweep ran answered healthily
    // for it. A definite miss = no quote AND every provider that ran covered it
    // AND none was skipped.
    const coveredBy = new Map<string, number>();
    // The same, counting only answers that can VOUCH for the address: a capped
    // DexScreener answer (30 pairs for the whole request) covers the tokens it
    // left out without saying anything about them (`uncertain`). Trust
    // verdicts always read this; served results only in per-chain mode (below).
    const certainBy = new Map<string, number>();
    let providersRun = 0;
    let providersSkipped = 0;
    const byAddr = new Map<string, SourceQuote[]>();
    // Quotes the guard rejects (guard on: they do not vote) / would reject
    // (shadow: recorded only), and every quote with its date, for the evidence.
    const rejectedByAddr = new Map<string, string[]>();
    const datedByAddr = new Map<string, DatedQuote[]>();
    // DEX pools seen per address (earned-trust criterion c), from DexScreener,
    // and whether that answer held EVERY pair (an uncapped batch response).
    const dexPairsByAddr = new Map<string, { pairs: DexPairSummary[]; complete: boolean }>();
    // Activity signals from DEX-market sources, for the active-market verdict:
    // did ANY DEX source price this token, the best 24h volume seen, and which
    // addresses a HEALTHY DEX provider actually covered. Coverage matters:
    // baking `dexActive:false` for a token a rate-limited provider never looked
    // at mis-killed thousands of real tokens (18 true / 3,541 false) — a false
    // verdict requires a definite "provider answered, no pair / no volume".
    const dexPresent = new Set<string>();
    const dexVolByAddr = new Map<string, number>();
    const dexCovered = new Set<string>();
    // ⊆ dexCovered: a healthy DEX answer that could vouch for the address.
    const dexCertain = new Set<string>();
    // Per address: how many of the DEX-market providers that RAN this sweep
    // vouched for it (`dexProvidersRun` = that denominator; a skipped one is
    // not counted). Earned trust's (b) failure is definite only when they all
    // did — `dexCertain` alone is a union, so ONE certain miss (a GeckoTerminal
    // "no pool") read as "no DEX market" while DexScreener's capped answer had
    // not looked at the token (WETH on 4663: $263M of 24h volume).
    const dexCertainBy = new Map<string, number>();
    let dexProvidersRun = 0;
    // The DEX source that answers per-pair evidence (`getTokenPairs`:
    // DexScreener) was skipped — rate-limited past the wait. Then no (b)
    // failure is definite: that source never looked, and GeckoTerminal's
    // certain "no pool" on its own is the WETH-on-4663 miss.
    let pairDexSkipped = false;
    // Counter-side reserve of the deepest DEX pair, in QUOTE-TOKEN units, plus
    // the quote token (to convert → USD below). Seeded fantasy pools hold ~$10
    // of the quote token even when wash volume clears the volume floor.
    const dexCounterByAddr = new Map<string, { counter: number; counterToken?: string }>();
    // Tokens a DEX quote priced from a SAMPLE of their pairs (`dexPairsComplete:
    // false` — per-chain mode: always, one pair per token).
    const dexSampled = new Set<string>();

    for (const provider of this.registry.currentProviders()) {
      if (isPoolDerivedSource(provider.name)) continue;
      const providerIsDex = DEX_MARKET_SOURCES.has(provider.name);
      // DEX coverage is load-bearing for the active-market verdict, so the
      // background sweep WAITS OUT a rate limit (GT free tier = 30 calls/min)
      // instead of skipping; aggregators are plentiful → skip when limited.
      if (!provider.isAvailable() && !(providerIsDex && (await waitForProvider(provider)))) {
        providersSkipped += 1;
        if (providerIsDex && typeof provider.getTokenPairs === 'function') pairDexSkipped = true;
        continue;
      }
      providersRun += 1;
      if (providerIsDex) dexProvidersRun += 1;
      try {
        const { quotes, covered, uncertain } = await this.collectProviderQuotes(provider, chainId, lowers, {
          waitForAvailability: providerIsDex,
        });
        for (const addr of covered) {
          coveredBy.set(addr, (coveredBy.get(addr) ?? 0) + 1);
          if (!uncertain.has(addr)) certainBy.set(addr, (certainBy.get(addr) ?? 0) + 1);
        }
        for (const [addr, q] of quotes) {
          const rejection = quoteEvidence ? quoteRejection(q, provider.name, policy, sweepNow) : null;
          if (rejection) {
            const list = rejectedByAddr.get(addr);
            const tag = `${provider.name}:${rejection}`;
            if (list) list.push(tag);
            else rejectedByAddr.set(addr, [tag]);
          }
          if (quoteEvidence) {
            const dated = { source: provider.name, priceUsd: q.priceUsd, quotedAtMs: q.quotedAtMs, rejected: rejection !== null };
            const list = datedByAddr.get(addr);
            if (list) list.push(dated);
            else datedByAddr.set(addr, [dated]);
          }
          if (trustEvidence && providerIsDex && (Array.isArray(q.dexPairs) || q.dexPairsComplete !== undefined)) {
            dexPairsByAddr.set(addr, { pairs: q.dexPairs ?? [], complete: q.dexPairsComplete === true });
          }
          // Guard ON: a rejected quote does not vote and is not a market signal
          // (a stale price must not win, be persisted, or mark a market active).
          if (guardOn && rejection) continue;
          const list = byAddr.get(addr);
          if (list) list.push({ source: provider.name, priceUsd: q.priceUsd });
          else byAddr.set(addr, [{ source: provider.name, priceUsd: q.priceUsd }]);
          if (providerIsDex) {
            dexPresent.add(addr);
            const vol = typeof q.volume24hUsd === 'number' && Number.isFinite(q.volume24hUsd) ? q.volume24hUsd : 0;
            dexVolByAddr.set(addr, Math.max(dexVolByAddr.get(addr) ?? 0, vol));
            const counter = typeof q.counterLiquidity === 'number' && Number.isFinite(q.counterLiquidity) ? q.counterLiquidity : undefined;
            if (counter !== undefined && counter > (dexCounterByAddr.get(addr)?.counter ?? -1)) {
              dexCounterByAddr.set(addr, { counter, counterToken: q.counterTokenAddress });
            }
            if (q.dexPairsComplete === false) dexSampled.add(addr);
          }
        }
        if (providerIsDex) {
          for (const addr of covered) {
            dexCovered.add(addr);
            if (!uncertain.has(addr)) {
              dexCertain.add(addr);
              dexCertainBy.set(addr, (dexCertainBy.get(addr) ?? 0) + 1);
            }
          }
        }
      } catch (err) {
        this.logger.debug(`consensus: provider ${provider.name} failed: ${(err as Error)?.message}`);
      }
    }

    // Which coverage the SERVED results read (`dexActive`, the guard's clear,
    // the miss ledger). latest (default): today's — a token a capped
    // DexScreener answer left out counts as covered, so served data is
    // byte-identical. per-chain: only answers that could vouch for the token.
    // Trust verdicts (evidence the default mode does not serve) always read the
    // certain coverage: a verdict recorded on non-evidence is what made
    // "single-source" the commonest stored reason.
    const dexEndpoint = this.config.dexscreenerBatchEndpoint;
    const perChain = dexEndpoint === 'per-chain';
    const servedCoveredBy = perChain ? certainBy : coveredBy;
    const servedDexCovered = perChain ? dexCertain : dexCovered;
    const minVol = this.config.dexMarketMinVolumeUsd;
    const minCounter = this.config.dexMarketMinCounterLiquidityUsd;
    // Earned-trust pool evidence (shadow or live): a counter token is priced
    // only when it is trusted, and only from this sweep's own quotes, the
    // in-memory cache or its stored price — never a provider walk or a persist
    // (shadow must not change what is served). Its stored verdicts and prices
    // are loaded once for the batch; per-token pair lookups (a sampled batch
    // answer) are budgeted per sweep RUN, this batch spending its share
    // (`lookups`, above; a lone call: per call). per-chain mode also looks a
    // token's own pairs up before a floor failure on its one batch pair
    // becomes a definite `dexActive:false` (below) — same lookups, same
    // cache, but its OWN budget: sharing one let a run of floor-failing tokens
    // whose verdict needs no pairs (single-source either way) spend every
    // lookup before a token that could earn reached its turn. Both budgets
    // draw from one process-wide rate in a run (`pair-lookup-budget.ts`).
    const trustCtx: TrustEvidenceContext = {
      byAddr,
      counterPx: new Map(),
      pairSource: trustEvidence || perChain
        ? this.registry.currentProviders().find((p) => typeof p.getTokenPairs === 'function' && !isPoolDerivedSource(p.name))
        : undefined,
      lookups,
      pairAnswers: new Map(),
      perChain,
    };
    if (run && trustCtx.pairSource) run.lookupsPossible = true;
    if (trustEvidence && dexPairsByAddr.size > 0) {
      const counters = new Set<string>();
      for (const e of dexPairsByAddr.values()) for (const p of e.pairs) if (p.counterTokenAddress) counters.add(p.counterTokenAddress);
      await this.loadTrustCounters(chainId, [...counters], trustCtx);
    }
    const records: TokenPriceRecord[] = [];
    const trustRecords: TokenTrustRecord[] = [];
    // Verdicts whose (b) needs a pair request the pre-sample rule never made
    // (`earnedTrustRecord`): judged after every token has had the requests that
    // rule did make, failures first, oldest answer first (below).
    const deferred: Array<VerdictDeferral & { job: VerdictJob }> = [];
    // The requests that rule did make — (c)'s lookup of a token with nothing
    // to hand (phase `c`) — and per-chain's served re-checks that need a
    // request: none goes out inline in batch order; they go out after the
    // inline pass, each kind in priority order, taking turns (below).
    const cWaiting: Array<VerdictDeferral & { job: VerdictJob }> = [];
    const servedWaiting: ServedRecheck[] = [];
    const settle = (verdict: TokenTrustRecord | VerdictDeferral | null, job: VerdictJob) => {
      if (isVerdictDeferral(verdict)) (verdict.deferred === 'c' ? cWaiting : deferred).push({ ...verdict, job });
      else if (verdict) trustRecords.push(verdict);
    };
    const guardCleared: GuardedPriceClear[] = [];
    const nowMs = Date.now();
    for (const addr of lowers) {
      const r = reconcileQuotes(byAddr.get(addr) ?? []);
      const priced = !(r.confidence === 'none' || r.priceUsd <= 0);
      // Earned-trust verdict (shadow or live). Only on a DEFINITE DEX answer —
      // like `dexActive`, a token no healthy DEX provider covered keeps its
      // previous verdict (which ages out on its own) — and, in BOTH modes, one
      // that could vouch for the token: a token a capped DexScreener answer
      // left out has no DEX evidence at all, whatever latest mode serves.
      const needVerdict = trustEvidence && dexCertain.has(addr);
      if (!priced) {
        // Guard ON and every quote this sweep had was rejected: clear the saved
        // price rather than serve it as last-known-good for another day — but
        // only on a DEFINITE answer (every provider that runs ran, and covered
        // the token: a rate-limited DeFiLlama skipped this sweep may hold the
        // real price) and only when the saved price came from the rejected
        // providers (`clearGuardedPrices` checks the stored provenance).
        const rejected = rejectedByAddr.get(addr);
        const definite = providersSkipped === 0 && providersRun > 0 && (servedCoveredBy.get(addr) ?? 0) === providersRun;
        if (guardOn && rejected && rejected.length > 0 && definite) {
          guardCleared.push({ address: addr, rejectedSources: rejected.map(rejectedProviderOf) });
        }
        if (!needVerdict) continue;
      }
      let dexVol = dexVolByAddr.get(addr);
      const raw = dexCounterByAddr.get(addr);
      let counterUsd: number | undefined;
      if (raw && raw.counter > 0) {
        const quotePrice = await this.counterTokenUsd(chainId, raw.counterToken);
        if (quotePrice !== undefined && quotePrice > 0) counterUsd = raw.counter * quotePrice;
      }
      const counterOk = counterUsd === undefined || counterUsd >= minCounter;
      let hasActiveMarket = dexPresent.has(addr) && (dexVol ?? 0) >= minVol && counterOk;
      // DexScreener priced it from a SAMPLE of its pairs: earned trust judges
      // (b) from the sample's OWN reading plus the token's own pairs
      // (`earnedTrustRecord`) — never from per-chain's served re-check below,
      // which may read an answer cached hours ago.
      const sample = dexSampled.has(addr) ? { seenVolume: dexVol, active: hasActiveMarket } : undefined;
      // per-chain: DexScreener answered ONE pair for this token — its own,
      // activity-weighted pick, not necessarily the deepest (WETH: a $7.1M pool
      // beside a $111M one). A volume / counter floor failure on that one pair
      // is a sample's, so before it is baked as a definite "no real market"
      // (served `dexActive:false`) the token's own pairs are read — every
      // pair it is in, EITHER orientation (24h volume summed, the deepest
      // pair's counter side: `TokenPairEvidence.market`), so a token whose
      // depth is as the quote side (USDT.e: $568 of USDC on its deepest
      // base-side pair, $613k in WAVAX/USDT.e) is read as that market —
      // through the sweep's cached lookup, on the served re-check's own
      // budget. Only ever turns a failure into a pass on the token's own
      // market; no lookup to be had → the sample's verdict stands. latest
      // mode never asks for served data — `perChain` is what keeps latest's
      // served values byte-identical, with the pair answers its trust verdicts
      // cache in reach from the second sweep on. (Earned trust's (b) shares a
      // request made here this sweep, but not a cached answer: `sample` above.)
      // An answer to hand is read now (no cost); one that needs a REQUEST
      // waits for the batch's request phase (`servedWaiting`, below) — and so
      // does the token's verdict, which shares that request — so the batch's
      // share goes to the tokens whose served value it protects first
      // (`orderPairRequests`), not to the first floor-failing ones of the
      // batch every run. Only for a priced token: the re-check corrects its
      // price record, and an unpriced token has none to correct.
      let servedWaits = false;
      if (perChain && priced && !hasActiveMarket && dexSampled.has(addr)) {
        if (this.pairRequestNeeded(chainId, addr, trustCtx)) {
          servedWaits = true;
        } else {
          const own = await this.ownMarket(chainId, addr, trustCtx, dexVol, 'served');
          if (own && passesDexFloors(own.volume, own.counterUsd, minVol, minCounter)) {
            hasActiveMarket = true;
            dexVol = own.volume;
            counterUsd = own.counterUsd;
          }
        }
      }
      const dexActive = hasActiveMarket ? true : servedDexCovered.has(addr) ? false : undefined;
      let job: VerdictJob | undefined;
      if (needVerdict) {
        // `dexActive` is the certain coverage's answer here in both modes: a
        // verdict is only computed for a token in `dexCertain` ⊆ either set.
        // A failure on (a) / (d) — fewer than two fresh agreeing sources, or
        // no non-DEX one — is a verdict about sources that did NOT answer, so
        // it is only evidence when the answer was DEFINITE: every provider
        // that runs ran, and each one vouched for this token. A skipped
        // (rate-limited) DeFiLlama, or a capped DexScreener answer that left
        // the token out, may hold exactly the second source. (Quotes that
        // answered and DISAGREE, and a (b) / (c) failure, are evidence either
        // way — `earnedTrustRecord`.)
        const failureDefinite = providersSkipped === 0 && providersRun > 0 && (certainBy.get(addr) ?? 0) === providersRun;
        // A (b) failure ("no DEX market") is a claim about EVERY DEX market,
        // so it is definite only when every DEX-market provider that ran
        // vouched for the token, and DexScreener — the DEX source that
        // answers per-pair evidence — was not skipped. Another DEX provider
        // skipped does not block (it is not a DEX answer that failed to
        // vouch, and the rug case — DexScreener looked and found no live pair
        // with GeckoTerminal rate-limited — must still revoke); DexScreener
        // skipped does, or GeckoTerminal's certain "no pool" alone would read
        // as "no DEX market" for a token DexScreener never looked at. Trust
        // verdict only: the served `dexActive` above keeps its own rule
        // (latest mode: today's).
        const dexFailureDefinite = !pairDexSkipped && dexProvidersRun > 0 && (dexCertainBy.get(addr) ?? 0) === dexProvidersRun;
        job = {
          addr,
          dated: datedByAddr.get(addr) ?? [],
          dexActive,
          evidence: dexPairsByAddr.get(addr),
          failureDefinite,
          dexFailureDefinite,
          sample,
        };
        // A token whose served re-check waits is judged once it has had it.
        if (!servedWaits) settle(await this.earnedTrustRecord(chainId, job, policy, nowMs, trustCtx, 'main'), job);
      }
      if (!priced) continue;
      const confidence = consensusToConfidence(r.confidence);
      // Active market = a DEX source priced it AND that market has real trading
      // (24h volume ≥ floor) AND real counter-side liquidity (≥ floor). Volume is
      // cheap to wash (GPCG: $61 across a few buys clears the $50 floor); the
      // counter-side reserve is not — GPCG holds $9.52 of USDC vs RPC's $10,980.
      // Counter UNKNOWN (no DEX source supplied it — e.g. GeckoTerminal-only) →
      // not gated (volume-only fallback); absent is NEVER treated as 0.
      // TRI-STATE: `false` is only baked when a healthy DEX provider actually
      // covered the address (definite no-pair/dead answer; per-chain mode: and
      // could vouch for it — not a token a capped answer left out); if every
      // DEX provider was down/limited for it, OMIT the verdict (keep any
      // previous one) rather than poison real tokens.
      const record: TokenPriceRecord = {
        address: addr,
        priceUsd: r.priceUsd,
        priceConfidence: confidence,
        priceSources: r.sources,
        dexVolume24h: dexVol,
        dexCounterLiquidity: counterUsd,
        dexActive,
      };
      if (quoteEvidence) Object.assign(record, this.guardEvidence(datedByAddr.get(addr) ?? [], r.sources, rejectedByAddr.get(addr)));
      records.push(record);
      if (servedWaits) servedWaiting.push({ addr, record, seenVolume: dexVol, job });
      // Warm the in-memory cache so the hot path benefits immediately.
      this.externalCache.set(currentCacheKey(chain.slug, addr), { price: r.priceUsd, expiresAt: nowMs + CURRENT_CACHE_TTL_MS });
    }
    // The batch's request phase: (c)'s lookups (`cWaiting`) and per-chain's
    // served re-checks (`servedWaiting`), each on its own share, each kind in
    // priority order (`orderPairRequests`), TAKING TURNS. Its own share keeps
    // either kind from spending the other's budget, but not from spending the
    // shared RATE ahead of it: where the rate binds before the shares do (a
    // short run — Avalanche per-chain: ~140 + 140 a batch, ~15 from the rate),
    // floor-failing samples first in batch order took 9 of every 10 requests
    // and the (c) lookups of tokens that could earn got denied. Turns give
    // each kind half of what the rate grants while both wait, all of it once
    // one is done. A served re-check's answer completes its price record and
    // then its verdict is judged (`main`, with that answer to hand).
    await this.orderPairRequests(chainId, cWaiting, servedWaiting, policy);
    for (let c = 0, s = 0; c < cWaiting.length || s < servedWaiting.length; ) {
      const d = cWaiting[c];
      if (d) {
        c += 1;
        settle(await this.earnedTrustRecord(chainId, d.job, policy, nowMs, trustCtx, 'c'), d.job);
      }
      const w = servedWaiting[s];
      if (w) {
        s += 1;
        const own = await this.ownMarket(chainId, w.addr, trustCtx, w.seenVolume, 'served');
        if (own && passesDexFloors(own.volume, own.counterUsd, minVol, minCounter)) {
          w.record.dexActive = true;
          w.record.dexVolume24h = own.volume;
          w.record.dexCounterLiquidity = own.counterUsd;
          if (w.job) w.job.dexActive = true;
        }
        if (w.job) settle(await this.earnedTrustRecord(chainId, w.job, policy, nowMs, trustCtx, 'main'), w.job);
      }
    }
    // The pair requests (b) on a sample added, on what the budget has left
    // after every token had the requests the rule before it made ((c)'s, in
    // the request phase above): confirming a sample's FAILURE first (it can
    // earn the token, or revoke a rug a cached answer still calls healthy),
    // then a sample's PASS (it can only catch a pair the sample left out). Spent
    // in batch order, pass confirmations took 7 of Robinhood's 25 lookups for
    // tokens already earned without one, and two tokens main earned or judged
    // single-pool got no verdict. Within each, the token whose answer is oldest
    // asks first (never asked = oldest), so a budget smaller than the tokens
    // needing a request moves through them from sweep to sweep instead of
    // serving the same first ones every time.
    for (const phase of ['fail', 'pass'] as const) {
      const queue = deferred.filter((d) => d.deferred === phase).sort((a, b) => (a.answerAt === b.answerAt ? 0 : a.answerAt < b.answerAt ? -1 : 1));
      for (const d of queue) {
        const verdict = await this.earnedTrustRecord(chainId, d.job, policy, nowMs, trustCtx, phase);
        if (verdict && !isVerdictDeferral(verdict)) trustRecords.push(verdict);
      }
    }
    if (records.length > 0 && this.tokens) {
      await this.tokens
        .upsertPrices(chainId, records)
        .catch((err) => this.logger.warn(`consensus persist failed for ${records.length} tokens: ${(err as Error)?.message}`));
    }
    if (trustRecords.length > 0 && this.tokens) await this.tokens.upsertTrustEvidence(chainId, trustRecords);
    let clearedCount = 0;
    if (guardCleared.length > 0 && this.tokens) {
      const n = await this.tokens.clearGuardedPrices(chainId, guardCleared, 'quote-guard');
      clearedCount = typeof n === 'number' ? n : 0;
      for (const c of guardCleared) this.externalCache.delete(currentCacheKey(chain.slug, c.address));
    }
    if (ledgerOn) {
      const priced = new Set(byAddr.keys());
      const misses =
        providersSkipped === 0 && providersRun > 0
          ? lowers.filter((a) => !priced.has(a) && (servedCoveredBy.get(a) ?? 0) === providersRun)
          : [];
      await this.ledger.recordMisses(chainId, misses);
      await this.ledger.recordPositives(chainId, priced);
    }
    stats.trustVerdicts = trustRecords.length;
    stats.trustEarned = trustRecords.filter((r) => r.trustEarned).length;
    // One verdict at most per (de-duplicated) swept token, so the rest are the
    // tokens this sweep could not judge (`ConsensusSweepStats.trustUnknown`).
    stats.trustUnknown = trustEvidence ? lowers.length - trustRecords.length : 0;
    stats.guardRejected = rejectedByAddr.size;
    stats.guardCleared = clearedCount;
    return stats;
  }

  /**
   * Quote-guard evidence for one swept token — `guardEvidenceOf` (module
   * level, pure). Kept as a method: the impact report's specs drive the
   * sweep's REAL evidence shape through it.
   */
  private guardEvidence(dated: ReadonlyArray<DatedQuote>, chosenSources: readonly string[], rejected: string[] | undefined) {
    return guardEvidenceOf(dated, chosenSources, rejected);
  }

  /**
   * The earned-trust verdict + evidence for one swept token
   * (`evaluateEarnedTrust`): fresh consensus over the quotes the guard accepts,
   * the active-market verdict, and the DEX-pool evidence (counter sides in USD
   * through `trustCounterUsd`). The pool evidence from the batch endpoint can
   * be a capped sample (`complete: false`, or no pair at all for a token the
   * capped answer left out): a token that would fail (c) on such a sample has
   * its own pairs looked up (budgeted), and when they cannot be had NO verdict
   * is stored — the previous one ages out (`stale-verdict`) rather than a
   * definite "single pool" depending on which tokens shared a batch. Likewise
   * a "single-source" / "stale-quote" failure is stored only when
   * `failureDefinite` (no provider skipped, every one that ran vouched for the
   * token): a missing second source proves nothing when a source that might
   * hold it never answered. Two things are definite whatever was skipped:
   *  - fresh quotes that DISAGREE (`reconcileQuotes` outliers): sources that
   *    answered contradict each other — contrary evidence, not missing
   *    evidence — so the (a)/(d) failure is stored and a previously earned
   *    verdict is revoked on this sweep instead of being trusted for up to
   *    `PRICE_QUOTE_MAX_AGE_MS` more;
   *  - a failure on (b) or (c): those come from the DEX answers alone (the
   *    verdict is only computed on a certain one), and a missing aggregator
   *    can only ever ADD (a)/(d) support. So a withheld (a)/(d) failure is
   *    re-judged with (a)/(d) assumed to hold: `no-dex-market` (a rugged
   *    token's pools gone) or a complete `single-pool` is stored, and only an
   *    `earned` re-judgement — (a)/(d) were the only failure — stores nothing.
   *    That re-judgement reads pair evidence the provider already holds
   *    (`cachedTokenPairs`) and never spends the sweep's lookup budget: its
   *    best outcome is a stored `single-pool` (an `earned` one is withheld),
   *    and every request it made was one a token that COULD earn did not get
   *    (live, 4663: 18 verdicts earned where 21 were).
   * A (b) failure itself (`no-dex-market`) is stored only when
   * `dexFailureDefinite` — every DEX-market provider that ran vouched for the
   * token, and DexScreener was not skipped. One certain miss next to a
   * DexScreener answer that could not vouch (a capped /latest answer) or did
   * not come says nothing about the market DexScreener did not look at.
   * (b) on a SAMPLE (`sample`: DexScreener priced the token from part of its
   * pairs — a capped /latest answer, or per-chain's one pair): the market
   * read off a sample depends on which pairs it held, so one token's verdict
   * flipped with the tokens sharing its batch, both ways — its only sampled
   * pair a $500-counter pool → `no-dex-market` every sweep, where the full
   * answer earns; a sample that left out its deepest pair, a single-sided
   * seed → `earned`, where the full answer says `no-dex-market`. So (b) also
   * reads the token's own pairs (`sampleMarket`: the same reading as a full
   * batch answer of the mode; one budgeted request that (c) reuses). Its rules,
   * each one a live finding:
   *  - an answer from THIS sweep decides when it is conclusive (a pass, or a
   *    complete answer that fails); otherwise a pass on the sample stands (a
   *    pair that clears both floors is a real market whatever else exists)
   *    and a failure on samples alone is no verdict;
   *  - an answer the provider CACHED (up to a quarter of the quote window
   *    old) may confirm the sample's reading but never overturn it: read as a
   *    decision, a healthy answer cached before a rug re-stored `earned` all
   *    afternoon beside fresh samples of the drained pools, and a thin one
   *    cached before liquidity arrived stored `no-dex-market` beside a fresh
   *    deep sample. Overturning takes a request this sweep; with none to be
   *    had, no verdict;
   *  - those requests come AFTER the ones the rule before it made (`phase`):
   *    in phase `main` (inline, batch order) only an answer to hand is read;
   *    the request (c) makes anyway (a token with nothing to hand — a
   *    contradicted cached answer's re-ask is (b)'s own) is made in phase `c`,
   *    once every token has been through `main`, in priority order
   *    (`orderPairRequests`: the stored earned verdicts nearest
   *    `stale-verdict` first — in batch order, with answers cached 6 h, the
   *    same first tokens of a batch took the share every run and the rest of
   *    it lapsed); a token needing a request of its own for (b) returns a
   *    `VerdictDeferral` and is judged in phase `fail` (its sample fails) or
   *    `pass` (its sample passes) after phase `c` (`prefetchConsensus`).
   *    Spent inline, pass confirmations starved (c) lookups the old rule made
   *    (Robinhood: 21 → 20 earned on a first sweep).
   * Missing SOURCES can only take trust away, so a positive verdict needs no
   * source guard; missing PAIRS can do both, hence this one.
   * null = no verdict (counted `trustUnknown`).
   */
  private async earnedTrustRecord(
    chainId: number,
    job: VerdictJob,
    policy: TrustPolicy,
    nowMs: number,
    ctx: TrustEvidenceContext,
    phase: VerdictPhase,
  ): Promise<TokenTrustRecord | VerdictDeferral | null> {
    const { addr, dated, evidence, failureDefinite, dexFailureDefinite, sample } = job;
    const all = reconcileQuotes(dated.map(({ source, priceUsd }) => ({ source, priceUsd })));
    const fresh = reconcileQuotes(dated.filter((q) => !q.rejected).map(({ source, priceUsd }) => ({ source, priceUsd })));
    const freshConsensus = fresh.confidence === 'consensus';
    let market = {
      freshConsensus,
      consensusNeedsStale: !freshConsensus && all.confidence === 'consensus',
      // A sampled token: the sample's own reading (latest: what is served;
      // per-chain: before the served re-check, whose answer may be cached).
      dexActive: sample ? sample.active : job.dexActive,
      hasNonDexSource: freshConsensus && fresh.sources.some((s) => !DEX_MARKET_SOURCES.has(s)),
    };
    // Fresh quotes that answered and disagree are evidence in themselves.
    const disputed = fresh.outliers.length > 0;
    let pairs = evidence?.pairs ?? [];
    let complete = evidence?.complete === true;
    let summary = await this.poolEvidence(chainId, pairs, policy, ctx);
    let verdict = evaluateEarnedTrust({ ...market, ...summary }, policy);
    // A withheld (a)/(d) failure: judge (b) and (c) alone (see the doc).
    let sourcesAssumed = false;
    if ((verdict.reason === 'single-source' || verdict.reason === 'stale-quote') && !failureDefinite && !disputed) {
      market = { ...market, freshConsensus: true, consensusNeedsStale: false, hasNonDexSource: true };
      sourcesAssumed = true;
      verdict = evaluateEarnedTrust({ ...market, ...summary }, policy);
    }
    // (b) on a sample: the token's own pairs (see the doc). Only when the
    // verdict depends on (b) — a definite (a)/(d) failure needs no lookup.
    if (sample && verdict.reason !== 'single-source' && verdict.reason !== 'stale-quote') {
      const active = await this.sampleMarket(chainId, addr, ctx, sample, {
        phase,
        // Sources assumed: cached evidence only — the budget is for tokens
        // whose real consensus passed (see the doc).
        cacheOnly: sourcesAssumed,
        // (c) needs the token's pairs anyway (a sample's pass on one pool).
        // With nothing cached for it, that is the request the rule before
        // this one made, and one request serves both; with a cached answer,
        // that rule read the cache for free, so `sampleMarket`'s re-ask is
        // (b)'s own and waits (`sampleMarket`).
        neededForC: verdict.reason === 'single-pool' && !complete,
      });
      if (active === null || isVerdictDeferral(active)) return active;
      if (active !== (market.dexActive === true)) {
        market = { ...market, dexActive: active };
        verdict = evaluateEarnedTrust({ ...market, ...summary }, policy);
      }
    }
    // A (b) failure on DEX answers that did not all vouch for the token.
    if (verdict.reason === 'no-dex-market' && !dexFailureDefinite) return null;
    if (verdict.reason === 'single-pool' && !complete) {
      // (c)'s own request waits for phase `c` (see the doc); an answer to
      // hand is read now, at no cost.
      if (phase === 'main' && !sourcesAssumed && this.pairRequestNeeded(chainId, addr, ctx)) {
        return { deferred: 'c', answerAt: Number.NEGATIVE_INFINITY };
      }
      // Sources assumed: cached evidence only (as above).
      const own = await this.tokenPairs(chainId, addr, ctx, { cacheOnly: sourcesAssumed });
      if (own) {
        pairs = [...pairs, ...own.pairs];
        complete = own.complete;
        summary = await this.poolEvidence(chainId, pairs, policy, ctx);
        verdict = evaluateEarnedTrust({ ...market, ...summary }, policy);
      }
      // A sample can only under-count pools: never store "single pool" from one.
      if (verdict.reason === 'single-pool' && !complete) return null;
    }
    // (a)/(d) failed on an answer that was not definite and nothing else did.
    if (sourcesAssumed && verdict.earned) return null;
    return {
      address: addr,
      trustEarned: verdict.earned,
      trustReason: verdict.reason,
      trustEvaluatedAt: new Date(nowMs),
      trustSources: freshConsensus ? fresh.sources : [],
      dexPoolCount: summary.dexPoolCount,
      dexOutsideLiquidityUsd: summary.dexOutsideLiquidityUsd,
      dexTopCounterUsd: summary.dexTopCounterUsd,
      dexTopCounterShare: summary.dexTopCounterShare,
      dexTopPoolId: summary.dexTopPoolId,
    };
  }

  /**
   * (b) for a token DexScreener priced from a SAMPLE of its pairs
   * (`earnedTrustRecord` has the rules): the sample's reading (`sample.active`)
   * checked against the token's own pairs. true / false = the market reading
   * the verdict takes; null = no verdict; a `VerdictDeferral` = a request is
   * needed that phase `main` does not make. What the own pairs say: a pass on
   * both floors, a failure only on a COMPLETE answer, nothing otherwise.
   */
  private async sampleMarket(
    chainId: number,
    addr: string,
    ctx: TrustEvidenceContext,
    sample: { seenVolume?: number; active: boolean },
    opts: { phase: VerdictPhase; cacheOnly: boolean; neededForC: boolean },
  ): Promise<boolean | VerdictDeferral | null> {
    const minVol = this.config.dexMarketMinVolumeUsd;
    const minCounter = this.config.dexMarketMinCounterLiquidityUsd;
    const says = async (answer: TokenPairEvidence | null): Promise<boolean | undefined> => {
      const own = answer ? await this.ownMarketOf(chainId, answer, ctx, sample.seenVolume) : null;
      if (!own) return undefined;
      if (passesDexFloors(own.volume, own.counterUsd, minVol, minCounter)) return true;
      return own.complete ? false : undefined;
    };
    // What the sample alone allows: its pass stands, its failure is no verdict.
    const sampleOnly = sample.active ? true : null;
    const hand = this.pairsToHand(chainId, addr, ctx);
    let reading = hand ? await says(hand.answer) : undefined;
    // A cached answer that contradicts the sample: it may be hours old.
    const stale = hand !== undefined && !hand.fresh && reading !== undefined && reading !== sample.active;
    // ...unless it was fetched within `RECENT_PAIR_ANSWER_MS`: then no verdict
    // and no request. Re-asked every sweep, a LASTING contradiction (a token
    // whose thin sampled pair always disagrees with its own market) cost a
    // request per token per sweep — the whole budget, steady state, on
    // DexScreener's shared slots and 429 backoff, which the served hot path
    // uses too. A rug is then revoked at most this much later.
    if (stale && hand.recent) return null;
    if (hand === undefined || stale) {
      if (opts.cacheOnly || typeof ctx.pairSource?.getTokenPairs !== 'function') return stale ? null : sampleOnly;
      const tier: 'fail' | 'pass' = sample.active ? 'pass' : 'fail';
      // The request the rule before this one made — (c)'s lookup of a token
      // with nothing cached — goes out in phase `c`, ahead of (b)'s own; a
      // stale answer's re-ask is (b)'s own (that rule read the cache for (c)
      // at no cost), so it waits in its tier; spent ahead of them, a lasting
      // contradiction took the budget every sweep ahead of (c)'s lookups and
      // of a rug's re-ask.
      const forC = opts.neededForC && !stale;
      if (!(opts.phase === tier || (forC && opts.phase === 'c'))) {
        return { deferred: forC && opts.phase === 'main' ? 'c' : tier, answerAt: hand?.answer?.fetchedAt ?? Number.NEGATIVE_INFINITY };
      }
      const answer = await this.pairLookup(chainId, addr, ctx, 'verdict', { refresh: stale });
      // Nothing to be had (budget spent, rate-limited, failed): a stale
      // contradiction is no verdict; otherwise the sample's own rule.
      if (!answer) return stale ? null : sampleOnly;
      reading = await says(answer);
    }
    return reading ?? sampleOnly;
  }

  /** Fold DEX pairs into the (c) numbers, counter sides priced by `trustCounterUsd`. */
  private async poolEvidence(chainId: number, pairs: readonly DexPairSummary[], policy: TrustPolicy, ctx: TrustEvidenceContext) {
    const pools: DexPoolLiquidity[] = [];
    for (const p of pairs) {
      const px = await this.trustCounterUsd(chainId, p.counterTokenAddress, ctx);
      pools.push({ id: p.id, counterUsd: px !== undefined && px > 0 ? p.counterLiquidity * px : 0, liquidityUsd: p.liquidityUsd });
    }
    return summarizeDexPools(pools, policy.perPoolCounterUsd, policy.deepPoolMinCounterShare);
  }

  /**
   * One token's own pairs (`PriceProvider.getTokenPairs`), within one of the
   * sweep's two lookup budgets (`budget`: earned trust's, or per-chain's
   * served re-check's); null = none to be had. A budget counts REQUESTS: an
   * answer the provider still holds (`cachedTokenPairs`) costs none, and
   * neither does an answer — or a failed request — this sweep already had for
   * the token (`pairAnswers`: (b), (c) and the served re-check of one token
   * share one request; a failed one is not repeated). Charging cache hits
   * spent the whole budget on the same first tokens of a batch every sweep
   * (fixed order, answers cached for hours) and starved the rest — no lookup,
   * so no verdict, ever.
   * `cacheOnly`: an answer already had or nothing — never a request, never the
   * budget. `refresh`: skip the provider's cache and ask (earned trust's (b),
   * whose cached answer contradicted this sweep's sample).
   * In a sweep RUN the budgets are the run's, and a request also needs the
   * process-wide token-pairs rate and DexScreener not benched
   * (`chargePairLookup`): without them it is exactly a spent budget — null,
   * never a wait, nothing charged or recorded (a later lookup of the token
   * may still be sent).
   */
  private async pairLookup(
    chainId: number,
    addr: string,
    ctx: TrustEvidenceContext,
    budget: 'verdict' | 'served',
    opts?: { cacheOnly?: boolean; refresh?: boolean },
  ): Promise<TokenPairEvidence | null> {
    const source = ctx.pairSource;
    if (!source?.getTokenPairs) return null;
    const had = ctx.pairAnswers.get(addr);
    if (had !== undefined) return had;
    if (!opts?.refresh) {
      const cached = source.cachedTokenPairs?.(chainId, addr);
      if (cached) return cached;
    }
    if (opts?.cacheOnly) return null;
    if (!chargePairLookup(ctx.lookups, budget, source.isAvailable())) return null;
    this.notePairAsked(chainId, addr);
    let answer: TokenPairEvidence | null;
    try {
      answer = (await (opts?.refresh ? source.getTokenPairs(chainId, addr, { refresh: true }) : source.getTokenPairs(chainId, addr))) ?? null;
    } catch {
      answer = null;
    }
    ctx.pairAnswers.set(addr, answer);
    return answer;
  }

  /**
   * The token's own pair answer already to hand — no request, no budget: one
   * this sweep had (`pairAnswers`; `fresh`, and `answer: null` for a request
   * that failed), else the provider's cached one (`fresh: false` — up to a
   * quarter of the quote window old). undefined = neither.
   */
  private pairsToHand(
    chainId: number,
    addr: string,
    ctx: TrustEvidenceContext,
  ): { answer: TokenPairEvidence | null; fresh: boolean; recent: boolean } | undefined {
    const source = ctx.pairSource;
    if (!source?.getTokenPairs) return undefined;
    if (ctx.pairAnswers.has(addr)) return { answer: ctx.pairAnswers.get(addr) ?? null, fresh: true, recent: true };
    const cached = source.cachedTokenPairs?.(chainId, addr);
    if (!cached) return undefined;
    // `recent`: fetched within `RECENT_PAIR_ANSWER_MS` (an undated answer is not).
    const at = cached.fetchedAt;
    const recent = typeof at === 'number' && Number.isFinite(at) && Date.now() - at < RECENT_PAIR_ANSWER_MS;
    return { answer: cached, fresh: false, recent };
  }

  /** Reading this token's own pairs now would take a REQUEST: a pair source runs and nothing is to hand (`pairsToHand`). */
  private pairRequestNeeded(chainId: number, addr: string, ctx: TrustEvidenceContext): boolean {
    return typeof ctx.pairSource?.getTokenPairs === 'function' && this.pairsToHand(chainId, addr, ctx) === undefined;
  }

  /** `pairAskedAt`: this token was just asked for (moved to the end — the most recently asked). */
  private notePairAsked(chainId: number, addr: string): void {
    const key = `${chainId}:${addr}`;
    this.pairAskedAt.delete(key);
    this.pairAskedAt.set(key, Date.now());
    if (this.pairAskedAt.size > PAIR_ASKED_MAX) {
      const oldest = this.pairAskedAt.keys().next();
      if (!oldest.done) this.pairAskedAt.delete(oldest.value);
    }
  }

  /**
   * The order a batch's waiting token-pairs requests go out in
   * (`prefetchConsensus`'s request phase), in place, each kind on its own:
   * only the first ones get a request once the batch's share or the shared
   * rate runs out, and the feed order is the same every run — so batch order
   * gave the same first tokens of every batch the share each time their
   * answer (cached 6 h) expired and the rest never got one. Live state from
   * one read per batch (`TokensRepository.findLookupPriority`, only when two
   * or more wait; unreadable → batch order), then when this process last
   * asked (`pairAskedAt`, never = first), then batch order:
   *  - (c)'s lookups: a stored EARNED verdict first, the oldest first — in
   *    earned / combined mode that verdict is served and lapses to
   *    `stale-verdict` 24 h after it was stored; then tokens with no stored
   *    verdict (never judged — the ones batch order starved); then the rest
   *    (a stored failure, or — combined — an allowlisted token, trusted
   *    whatever its verdict), oldest first. A token whose cached answer let
   *    this sweep re-store its verdict at no cost reads as just judged, so
   *    the requests rotate to the verdicts that are actually ageing.
   *  - per-chain's served re-checks: a token whose stored `dexActive` is
   *    TRUE first — an earlier re-check rescued it (its one batch pair is
   *    thin; its own market is not: the USDT.e class), and without one now
   *    this sweep bakes `false` over it, hiding it every time its answer
   *    expired — or it rugged, and this is what revokes it; then tokens with
   *    none stored; then stored `false` (mostly dead tokens), taking turns by
   *    when they were last asked so a real one among them is reached.
   */
  private async orderPairRequests(
    chainId: number,
    cWaiting: Array<VerdictDeferral & { job: VerdictJob }>,
    servedWaiting: ServedRecheck[],
    policy: TrustPolicy,
  ): Promise<void> {
    if (cWaiting.length < 2 && servedWaiting.length < 2) return;
    let stored = new Map<string, TokenLookupPriority>();
    const tokens = this.tokens;
    if (tokens && typeof tokens.findLookupPriority === 'function') {
      const addrs = [...new Set([...cWaiting.map((d) => d.job.addr), ...servedWaiting.map((w) => w.addr)])];
      try {
        stored = await tokens.findLookupPriority(chainId, addrs);
      } catch {
        /* unreadable: the last-asked turns and batch order still apply */
      }
    }
    const asked = (addr: string) => this.pairAskedAt.get(`${chainId}:${addr}`) ?? Number.NEGATIVE_INFINITY;
    const listedTrusted = policy.mode === 'combined';
    sortByKeys(cWaiting, (d) => {
      const s = stored.get(d.job.addr);
      const at = s?.trustEvaluatedAt ? s.trustEvaluatedAt.getTime() : Number.NEGATIVE_INFINITY;
      const tier = s?.trustEarned === true && !(listedTrusted && isAllowlisted(chainId, d.job.addr)) ? 0 : s?.trustEvaluatedAt ? 2 : 1;
      return [tier, at, asked(d.job.addr)];
    });
    sortByKeys(servedWaiting, (w) => {
      const v = stored.get(w.addr)?.dexActive;
      return [v === true ? 0 : v === undefined ? 1 : 2, asked(w.addr)];
    });
  }

  /** `pairLookup` (earned trust's budget), plus the trusted counter tokens its pairs need priced for (c). */
  private async tokenPairs(chainId: number, addr: string, ctx: TrustEvidenceContext, opts?: { cacheOnly?: boolean }) {
    const own = await this.pairLookup(chainId, addr, ctx, 'verdict', opts);
    if (!own) return null;
    const counters = own.pairs.map((p) => p.counterTokenAddress).filter((a): a is string => typeof a === 'string');
    if (counters.length > 0) await this.loadTrustCounters(chainId, counters, ctx);
    return own;
  }

  /** `ownMarketOf` the token's own pairs (`pairLookup`, on `budget`); null = no answer, or nothing to read in it. */
  private async ownMarket(
    chainId: number,
    addr: string,
    ctx: TrustEvidenceContext,
    seenVolume: number | undefined,
    budget: 'verdict' | 'served',
    opts?: { cacheOnly?: boolean },
  ): Promise<{ volume: number; counterUsd?: number; complete: boolean } | null> {
    const answer = await this.pairLookup(chainId, addr, ctx, budget, opts);
    return answer ? this.ownMarketOf(chainId, answer, ctx, seenVolume) : null;
  }

  /**
   * A token's own DEX market, read off its own pairs the way the mode reads a
   * full batch answer: latest — its BASE-side pairs (`TokenPairEvidence.base`,
   * the reading its /latest batch answers get, so a capped answer's verdict
   * matches an uncapped one's); per-chain — every pair it is in, either
   * orientation (`TokenPairEvidence.market`; every per-chain token is read
   * this way, so the mode is consistent with itself). 24h volume summed, at
   * least what the batch already saw (GeckoTerminal's counts too); the deepest
   * pair's counter side, in USD only when that token is an anchor
   * (`counterTokenUsd`, as for the batch pair) — undefined = unknown, never 0.
   * `complete` = the answer held every pair of the token. null = none of its
   * pairs to read.
   */
  private async ownMarketOf(
    chainId: number,
    answer: TokenPairEvidence,
    ctx: TrustEvidenceContext,
    seenVolume: number | undefined,
  ): Promise<{ volume: number; counterUsd?: number; complete: boolean } | null> {
    const reading = ctx.perChain ? answer.market : answer.base;
    if (!reading) return null;
    const vol = Number.isFinite(reading.volume24hUsd) ? reading.volume24hUsd : 0;
    let counterUsd: number | undefined;
    if (Number.isFinite(reading.counterLiquidity) && reading.counterLiquidity > 0) {
      const px = await this.counterTokenUsd(chainId, reading.counterTokenAddress);
      if (px !== undefined && px > 0) counterUsd = reading.counterLiquidity * px;
    }
    return { volume: Math.max(seenVolume ?? 0, vol), counterUsd, complete: answer.complete === true };
  }

  /**
   * Load what `trustCounterUsd` needs for these counter tokens: their stored
   * trust verdicts (the modes that read them — earned / combined,
   * `usesStoredVerdicts`; `warm` is a no-op otherwise) and, for the trusted
   * ones, a price from this
   * sweep's own quotes, the in-memory cache, or the stored last-known-good
   * (one read) — in that order. No provider call, no write.
   */
  private async loadTrustCounters(chainId: number, addresses: string[], ctx: TrustEvidenceContext): Promise<void> {
    const chain = getChainConfig(chainId);
    if (!chain) return;
    const lowers = [...new Set(addresses.map((a) => a.toLowerCase()))].filter((a) => !ctx.counterPx.has(a));
    if (lowers.length === 0) return;
    await this.trust().warm(chainId, lowers);
    const need: string[] = [];
    const now = Date.now();
    for (const a of lowers) {
      if (!(isAllowlisted(chainId, a) || this.trust().isTrusted(chainId, a))) continue;
      const own = reconcileQuotes(ctx.byAddr.get(a) ?? []);
      if (own.confidence !== 'none' && own.priceUsd > 0) {
        ctx.counterPx.set(a, own.priceUsd);
        continue;
      }
      const cached = this.externalCache.get(currentCacheKey(chain.slug, a));
      if (cached && cached.price > 0 && cached.expiresAt > now) {
        ctx.counterPx.set(a, cached.price);
        continue;
      }
      need.push(a);
    }
    if (need.length === 0 || !this.tokens || LAST_KNOWN_MAX_AGE_MS <= 0) return;
    try {
      const stored = await this.tokens.findLatestPrices(chainId, need);
      for (const a of need) {
        const row = stored.get(a);
        if (row && row.priceUsd > 0 && row.pricedAt && now - row.pricedAt.getTime() <= LAST_KNOWN_MAX_AGE_MS) ctx.counterPx.set(a, row.priceUsd);
      }
    } catch {
      /* unknown counter price → the pool proves nothing (fails closed) */
    }
  }

  /**
   * USD price of a DEX pair's counter token for the earned-trust POOL evidence
   * only (never for `dexActive`, whose anchors-only rule stays as it is): an
   * anchor as in `counterTokenUsd`, or a token trusted on the committed
   * allowlist or by its own earned verdict (cbBTC for BTC.b), priced from what
   * `loadTrustCounters` loaded. Anything else is UNKNOWN — a pool quoted
   * against an untrusted (or unpriced) token proves nothing about a market.
   */
  private async trustCounterUsd(chainId: number, address: string | undefined, ctx: TrustEvidenceContext): Promise<number | undefined> {
    if (!address) return undefined;
    const anchor = await this.counterTokenUsd(chainId, address);
    if (anchor !== undefined) return anchor;
    // Only trusted counters are in the map (`loadTrustCounters` gates them).
    const p = ctx.counterPx.get(address.toLowerCase());
    return p !== undefined && p > 0 ? p : undefined;
  }

  /** Collect address(lower)→full quote from one provider (batch where supported,
   * else singles). The full quote carries DEX activity signals (`volume24hUsd`)
   * the consensus sweep needs for the active-market verdict. Also reports which
   * addresses the provider covered: a chunk the provider answered while
   * available — a chunk served right before a 429 still counts; a skipped one
   * (provider unavailable, the walk broken off) does not. A call that FAILED
   * while the provider stayed available (DeFiLlama / GeckoTerminal answer a
   * thrown request, a 4xx or a 200 with no data with an `error` outcome and no
   * backoff) is excluded from `covered` only with strict provider health on
   * (`strictProviderHealthOf`); with it off (the default) it is `covered`, as
   * today, and `uncertain`. With `waitForAvailability` the walk sleeps through
   * a rate-limit window (background sweep) instead of dropping the rest of the
   * list.
   * `uncertain` (⊆ `covered`, never quoted) = covered addresses the answer
   * could not vouch for: from `getCurrentBatchWithCoverage` (DexScreener: a
   * capped or unanswered request's absentees), and every address of an empty
   * chunk / single lookup whose provider recorded a failure during the call.
   * The caller decides which reads may count an uncertain address as covered
   * (served data in latest mode: all of them — today's rule). */
  private async collectProviderQuotes(
    provider: PriceProvider,
    chainId: number,
    addresses: string[],
    opts?: { waitForAvailability?: boolean },
  ): Promise<{ quotes: Map<string, PriceQuote>; covered: Set<string>; uncertain: Set<string> }> {
    const quotes = new Map<string, PriceQuote>();
    const covered = new Set<string>();
    const uncertain = new Set<string>();
    const strictHealth = strictProviderHealthOf(this.config);
    if (provider.supportsCurrentBatch && provider.getCurrentBatch) {
      const max = Math.max(1, provider.maxBatchSize);
      for (let i = 0; i < addresses.length; i += max) {
        if (!provider.isAvailable()) {
          if (!opts?.waitForAvailability || !(await waitForProvider(provider))) break;
        }
        const chunk = addresses.slice(i, i + max);
        const before = metricsOf(provider);
        // Same request and quotes either way; the coverage form also says
        // which addresses its answer cannot vouch for.
        const answer = provider.getCurrentBatchWithCoverage
          ? await provider.getCurrentBatchWithCoverage(chainId, chunk)
          : { quotes: await provider.getCurrentBatch(chainId, chunk), uncertain: undefined, unseen: undefined };
        const res = answer.quotes;
        // A rate-limited/errored call returns empty AND flips availability off;
        // a healthy 200 (even with zero matches) keeps the provider available.
        // A call the fleet budget REFUSED (`GECKOTERMINAL_BUDGET`) also returns
        // empty but leaves the provider available — it is recorded as a
        // `skip`, so an empty chunk whose skip/ratelimit/error count rose is
        // UNKNOWN, never covered (else the sweep bakes `dexActive:false` and a
        // ledger miss for tokens nobody looked at). Conservative under
        // concurrent walks: another caller's skip on the same provider also
        // voids an empty chunk's coverage — no verdict, never a wrong one.
        // Only with E's pricing flags on (`strictProviderHealthOf`): with them
        // off the budget cannot refuse a call and coverage is today's rule.
        const after = metricsOf(provider);
        const rose = after.skip > before.skip || after.ratelimit > before.ratelimit || after.error > before.error;
        const unhealthy = strictHealth && rose;
        const chunkOk = res.size > 0 || (provider.isAvailable() && !unhealthy);
        // An EMPTY chunk whose skip / rate-limit / error count rose said
        // nothing about any of its addresses, whatever strict health says: it
        // stays `covered` (served data unchanged) but cannot vouch, so a trust
        // verdict never rests on it (a thrown DeFiLlama batch used to make a
        // DexScreener-only token a stored "single-source"; a GeckoTerminal 4xx
        // made a token no DEX looked at a stored "no-dex-market"). Same
        // conservative bias as above under concurrent walks.
        const silent = res.size === 0 && rose;
        for (const addr of chunk) {
          const q = res.get(providerAddressKey(chainId, addr));
          // `unseen`: a source blind to this chain's venue said nothing about
          // the address — neither covered nor uncertain (`CurrentBatchCoverage`).
          if (chunkOk && !answer.unseen?.has(addr.toLowerCase())) {
            covered.add(addr);
            if (!q && (silent || answer.uncertain?.has(addr.toLowerCase()))) uncertain.add(addr);
          }
          if (q && q.priceUsd > 0) quotes.set(addr, q);
        }
      }
    } else {
      for (const addr of addresses) {
        if (!provider.isAvailable()) {
          if (!opts?.waitForAvailability || !(await waitForProvider(provider))) break;
        }
        const before = metricsOf(provider);
        const q = await provider.getCurrentSingle(chainId, addr);
        if (q && q.priceUsd > 0) {
          quotes.set(addr, q);
          covered.add(addr);
        } else if (provider.isAvailable()) {
          covered.add(addr);
          // A lookup that FAILED (error / rate limit) while the provider stayed
          // available: covered as today, but no vouching (see the batch path).
          // A `skip` alone does not count here: CoinGecko records one on EVERY
          // current lookup (it serves no current prices), so it can never hold
          // the second source a failure would be waiting for.
          const after = metricsOf(provider);
          if (after.error > before.error || after.ratelimit > before.ratelimit) uncertain.add(addr);
        }
      }
    }
    return { quotes, covered, uncertain };
  }

  /**
   * Stage 1 / Stage 3 helper: invoke a single provider and merge its results
   * directly into the shared `prices` + `fetchedRecords`. Context-aware
   * providers get the partial-result `prices` map as anchors. Wraps the call
   * in `withProviderTimeout` unless the provider opts out.
   */
  private async invokeProviderInto(
    provider: PriceProvider,
    missing: Array<HistoricalTokenPriceRequest & { bucketTs: number }>,
    prices: Map<string, number>,
    fetchedRecords: HistoricalPriceRecord[],
    symbolByAddress: Map<string, string | undefined>,
    providerTimeoutMs: number,
  ): Promise<void> {
    const callWithBudget = <T>(fn: () => Promise<T>): Promise<T> =>
      provider.skipsOrchestratorTimeout
        ? fn()
        : withProviderTimeout(provider, providerTimeoutMs, fn);
    try {
      if (provider.getHistoricalBatchWithContext) {
        const result = await callWithBudget(
          () => provider.getHistoricalBatchWithContext!(
            missing.map(toProviderRequest),
            { anchorPrices: prices },
          ),
        );
        for (const req of missing) {
          const key = historicalTokenPriceRequestKey(req.chainId, req.address, req.timestamp);
          if (prices.has(key)) continue;
          const quote = result.get(key);
          if (!quote || quote.priceUsd <= 0 || quote.priceUsd > MAX_DERIVED_TOKEN_PRICE_USD) continue;
          prices.set(key, quote.priceUsd);
          fetchedRecords.push({
            chainId: req.chainId,
            address: req.address,
            bucketTs: req.bucketTs,
            priceUsd: quote.priceUsd,
            source: quote.source ?? provider.name,
          });
          this.logTokenPrice(req.chainId, provider.name, symbolByAddress.get(req.address), req.address, quote.priceUsd, req.bucketTs);
        }
        return;
      }
      const beforeKeys = new Set(prices.keys());
      if (provider.supportsHistoricalBatch && provider.getHistoricalBatch && missing.length > 1) {
        await callWithBudget(() => this.walkHistoricalBatch(provider, missing, prices, fetchedRecords));
      } else {
        await callWithBudget(() => this.walkHistoricalSingles(provider, missing, prices, fetchedRecords));
      }
      for (const req of missing) {
        const key = historicalTokenPriceRequestKey(req.chainId, req.address, req.timestamp);
        if (!beforeKeys.has(key) && prices.has(key)) {
          const p = prices.get(key) ?? 0;
          if (p > 0) {
            this.logTokenPrice(req.chainId, provider.name, symbolByAddress.get(req.address), req.address, p, req.bucketTs);
          }
        }
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`provider ${provider.name} skipped: ${reason}`);
      provider.markBackoff(undefined, reason);
    }
  }

  /**
   * Stage 2 helper: call provider in isolation and return a local result
   * map (keyed by `historicalTokenPriceRequestKey`) without mutating shared
   * state. Caller merges across providers in env order so we preserve
   * preference even though calls fire concurrently.
   */
  private async callProviderLocal(
    provider: PriceProvider,
    missing: Array<HistoricalTokenPriceRequest & { bucketTs: number }>,
    anchorPrices: Map<string, number>,
    providerTimeoutMs: number,
  ): Promise<Map<string, PriceQuote>> {
    const local = new Map<string, PriceQuote>();
    if (missing.length === 0) return local;
    const callWithBudget = <T>(fn: () => Promise<T>): Promise<T> =>
      provider.skipsOrchestratorTimeout
        ? fn()
        : withProviderTimeout(provider, providerTimeoutMs, fn);
    try {
      if (provider.getHistoricalBatchWithContext) {
        const result = await callWithBudget(
          () => provider.getHistoricalBatchWithContext!(
            missing.map(toProviderRequest),
            { anchorPrices },
          ),
        );
        for (const [k, q] of result) {
          if (q.priceUsd > 0) local.set(k, q);
        }
        return local;
      }
      if (provider.supportsHistoricalBatch && provider.getHistoricalBatch && missing.length > 1) {
        // Re-use the batched call directly to fill `local` (the helper
        // walkHistoricalBatch is written to mutate the shared map, so we
        // run it against a scratch prices map and harvest the diff).
        const scratchPrices = new Map<string, number>();
        const scratchRecords: HistoricalPriceRecord[] = [];
        await callWithBudget(
          () => this.walkHistoricalBatch(provider, missing, scratchPrices, scratchRecords),
        );
        for (const [k, p] of scratchPrices) {
          if (p > 0) local.set(k, { priceUsd: p });
        }
        return local;
      }
      const scratchPrices = new Map<string, number>();
      const scratchRecords: HistoricalPriceRecord[] = [];
      await callWithBudget(
        () => this.walkHistoricalSingles(provider, missing, scratchPrices, scratchRecords),
      );
      for (const [k, p] of scratchPrices) {
        if (p > 0) local.set(k, { priceUsd: p });
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.logger.warn(`provider ${provider.name} skipped: ${reason}`);
      provider.markBackoff(undefined, reason);
    }
    return local;
  }

  private dropSatisfied(
    missing: Array<HistoricalTokenPriceRequest & { bucketTs: number }>,
    prices: Map<string, number>,
  ): void {
    for (let i = missing.length - 1; i >= 0; i -= 1) {
      const req = missing[i];
      if (!req) continue;
      const key = historicalTokenPriceRequestKey(req.chainId, req.address, req.timestamp);
      if (prices.has(key)) missing.splice(i, 1);
    }
  }

  /**
   * Stage 3b. For each priced unverified token that has full pool context,
   * ask the pool-ratio provider for an independent second opinion. If the
   * external price disagrees with the pool-ratio price by more than the
   * configured factor, replace the external price with the pool-ratio
   * result and update the cache row's source so the next read knows the
   * row was healed.
   */
  private async crossCheckUnverified(
    unique: Map<string, HistoricalTokenPriceRequest & { bucketTs: number }>,
    prices: Map<string, number>,
    fetchedRecords: HistoricalPriceRecord[],
    symbolByAddress: Map<string, string | undefined>,
    contextProviders: PriceProvider[],
    providerTimeoutMs: number,
  ): Promise<number> {
    if (contextProviders.length === 0) return 0;
    const SUSPECT_DIVERGENCE_X = 10;

    // Gather priced unverified tokens with full context.
    const candidates: Array<HistoricalTokenPriceRequest & { bucketTs: number }> = [];
    for (const req of unique.values()) {
      if (!req.unverified) continue;
      if (!req.poolHint || !req.anchorAddress || !req.protocol) continue;
      if (typeof req.tokenDecimals !== 'number' || typeof req.anchorDecimals !== 'number') continue;
      if (typeof req.isToken0 !== 'boolean') continue;
      const key = historicalTokenPriceRequestKey(req.chainId, req.address, req.timestamp);
      const existing = prices.get(key);
      if (!existing || existing <= 0) continue;
      candidates.push(req);
    }
    if (candidates.length === 0) return 0;

    let overrides = 0;
    for (const provider of contextProviders) {
      if (!provider.isAvailable() || !provider.getHistoricalBatchWithContext) continue;
      const callWithBudget = <T>(fn: () => Promise<T>): Promise<T> =>
        provider.skipsOrchestratorTimeout
          ? fn()
          : withProviderTimeout(provider, providerTimeoutMs, fn);
      try {
        const result = await callWithBudget(
          () => provider.getHistoricalBatchWithContext!(
            candidates.map(toProviderRequest),
            { anchorPrices: prices },
          ),
        );
        for (const req of candidates) {
          const key = historicalTokenPriceRequestKey(req.chainId, req.address, req.timestamp);
          const existing = prices.get(key);
          if (!existing || existing <= 0) continue;
          const quote = result.get(key);
          if (!quote || quote.priceUsd <= 0) continue;
          const divergence = Math.max(existing, quote.priceUsd) / Math.min(existing, quote.priceUsd);
          if (divergence < SUSPECT_DIVERGENCE_X) continue;
          // An over-ceiling derived price means the pool ratio itself is garbage
          // (thin/broken pool — the $89B case), not the external. Do NOT
          // override: keep the external quote and skip.
          if (quote.priceUsd > MAX_DERIVED_TOKEN_PRICE_USD) {
            this.logger.warn(
              `Suspect-price override SKIPPED (pool-ratio over ceiling): chain=${req.chainId} ${symbolByAddress.get(req.address) ?? '?'}(${req.address}) external=$${existing.toFixed(4)} pool-ratio=$${quote.priceUsd.toFixed(2)} divergence=${divergence.toFixed(1)}x`,
            );
            continue;
          }
          // Override — pool-ratio wins.
          prices.set(key, quote.priceUsd);
          fetchedRecords.push({
            chainId: req.chainId,
            address: req.address,
            bucketTs: req.bucketTs,
            priceUsd: quote.priceUsd,
            source: `${quote.source ?? provider.name}-overrode-suspect`,
          });
          overrides += 1;
          this.logger.warn(
            `Suspect-price override: chain=${req.chainId} ${symbolByAddress.get(req.address) ?? '?'}(${req.address}) external=$${existing.toFixed(4)} → pool-ratio=$${quote.priceUsd.toFixed(4)} divergence=${divergence.toFixed(1)}x`,
          );
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.warn(`cross-check provider ${provider.name} skipped: ${reason}`);
      }
    }
    return overrides;
  }

  private async walkHistoricalBatch(
    provider: PriceProvider,
    missing: Array<HistoricalTokenPriceRequest & { bucketTs: number }>,
    prices: Map<string, number>,
    fetchedRecords: HistoricalPriceRecord[],
  ): Promise<void> {
    if (!provider.getHistoricalBatch) return;
    for (let i = 0; i < missing.length; i += provider.maxBatchSize) {
      if (!provider.isAvailable()) break;
      const chunk = missing.slice(i, i + provider.maxBatchSize);
      const reqs: HistoricalReq[] = chunk.map(toProviderRequest);
      const result = await provider.getHistoricalBatch(reqs);
      for (const req of chunk) {
        const innerKey = `${req.chainId}:${req.address}:${req.bucketTs}`;
        const quote = result.get(innerKey);
        if (quote && quote.priceUsd > 0) {
          this.recordHistoricalSuccess(provider, req, quote, prices, fetchedRecords);
        }
      }
    }
  }

  private async walkHistoricalSingles(
    provider: PriceProvider,
    missing: Array<HistoricalTokenPriceRequest & { bucketTs: number }>,
    prices: Map<string, number>,
    fetchedRecords: HistoricalPriceRecord[],
  ): Promise<void> {
    await mapConcurrent(missing, provider.singleConcurrency, async (req) => {
      if (!provider.isAvailable()) return;
      const key = historicalTokenPriceRequestKey(req.chainId, req.address, req.timestamp);
      if (prices.has(key)) return;
      const quote = await provider.getHistoricalSingle(toProviderRequest(req));
      if (quote && quote.priceUsd > 0) {
        this.recordHistoricalSuccess(provider, req, quote, prices, fetchedRecords);
      }
    });
  }

  private recordHistoricalSuccess(
    provider: PriceProvider,
    req: HistoricalTokenPriceRequest & { bucketTs: number },
    quote: PriceQuote,
    prices: Map<string, number>,
    fetchedRecords: HistoricalPriceRecord[],
  ): void {
    // Never accept an over-ceiling price (broken pool ratio); leave unpriced.
    if (quote.priceUsd > MAX_DERIVED_TOKEN_PRICE_USD) return;
    const key = historicalTokenPriceRequestKey(req.chainId, req.address, req.timestamp);
    prices.set(key, quote.priceUsd);
    const cacheKey = `${getChainSlug(req.chainId)}:${req.address}@${req.bucketTs}`;
    this.externalCache.set(cacheKey, {
      price: quote.priceUsd,
      expiresAt: Date.now() + HISTORICAL_CACHE_TTL_MS,
    });
    fetchedRecords.push({
      chainId: req.chainId,
      address: req.address,
      bucketTs: req.bucketTs,
      priceUsd: quote.priceUsd,
      source: quote.source ?? provider.name,
    });
  }

  private async nativeUsd(chainId: number, symbol?: string, cacheOnly = false): Promise<number> {
    const chain = getChainConfig(chainId);
    if (!chain) return 0;
    return this.externalTokenUsd(chainId, chain.wrappedNativeToken.address, symbol ?? chain.wrappedNativeToken.symbol, cacheOnly);
  }

  /** `findLatestPrices`, counted (`lastKnownReads`). */
  private readLastKnown(chainId: number, addresses: string[]): Promise<Map<string, { priceUsd: number; pricedAt?: Date }>> {
    if (!this.tokens) return Promise.resolve(new Map());
    this.lastKnownReads += 1;
    return this.tokens.findLatestPrices(chainId, addresses);
  }

  /**
   * The backfill pipeline's price deadline hit before its prefetch finished:
   * resolve the last-known-good of the range's tokens ONCE (one read for all of
   * them) into the cache, so `pricePool(…, {cacheOnly})` can serve it — instead
   * of one read per leg, which is what a negative cache hit costs on the normal
   * path. Tokens without a positive cache entry are read, and so are tokens
   * whose positive entry has EXPIRED — a newer stored price (the consensus
   * sweep's, another process's) then wins over the old cached one. A stale
   * stored price is not used (same freshness rule as everywhere else).
   *
   * It also loads the range's DEX-market verdicts (one indexed read, cached),
   * which only `prefetchPrices` did before: a range whose prefetch was skipped
   * at the in-flight cap otherwise priced every non-listed leg against an
   * `unknown` verdict — $0 under `DEX_MARKET_FAIL_CLOSED` even with a price in
   * hand. Returns how many tokens it priced. Best-effort.
   */
  async seedLastKnown(chainId: number, addresses: string[]): Promise<number> {
    const chain = getChainConfig(chainId);
    if (!chain || !this.tokens) return 0;
    const lowers = [...new Set(addresses.map((a) => a.toLowerCase()))];
    await this.loadDexMarketState(chainId, lowers);
    if (LAST_KNOWN_MAX_AGE_MS <= 0) return 0;
    const nowMs = Date.now();
    const need = lowers.filter((addr) => {
      const c = this.externalCache.get(currentCacheKey(chain.slug, addr));
      return !c || !(c.price > 0) || c.expiresAt <= nowMs;
    });
    if (need.length === 0) return 0;
    let rows: Map<string, { priceUsd: number; pricedAt?: Date }>;
    try {
      rows = await this.readLastKnown(chainId, need);
    } catch {
      return 0;
    }
    let seeded = 0;
    for (const addr of need) {
      const row = rows.get(addr);
      if (!(row && row.priceUsd > 0 && row.pricedAt && nowMs - row.pricedAt.getTime() <= LAST_KNOWN_MAX_AGE_MS)) continue;
      const key = currentCacheKey(chain.slug, addr);
      const cached = this.externalCache.get(key);
      // An expired positive keeps its place only if it is NEWER than the stored row.
      if (cached && cached.price > 0 && cachedPositiveAtMs(cached) > row.pricedAt.getTime()) continue;
      this.externalCache.set(key, { price: row.priceUsd, expiresAt: nowMs + CURRENT_CACHE_TTL_MS });
      seeded += 1;
    }
    return seeded;
  }

  /**
   * USD price of a DEX pair's COUNTER (quote) token, to convert a raw
   * counter-side reserve into USD for the active-market gate. Resolved cheaply
   * from anchors only: a stablecoin → $1, native/wrapped-native → current native
   * price. Any other quote token (a non-anchor) returns `undefined` =
   * UNKNOWN — the gate then falls back to volume-only and never under-values a
   * real token off an unpriceable counter. Never compares raw token units to a
   * USD floor (a WETH-quoted pair's ETH reserve must be ×ETH-price, not ×1).
   */
  private async counterTokenUsd(chainId: number, address?: string): Promise<number | undefined> {
    if (!address) return undefined;
    const policy = getPricingPolicy(chainId, 'uniswap-v4');
    if (!policy) return undefined;
    const kind = classifyAnchor(policy, address);
    if (kind === 'stable') return 1;
    if (kind === 'native') {
      const n = await this.nativeUsd(chainId);
      return n > 0 ? n : undefined;
    }
    return undefined; // non-anchor counter token → can't price cheaply → don't gate
  }

  /**
   * Public current native (ETH/WETH) USD price. Used by performance recompute
   * to value gas at the current ETH price for the vs-HODL PnL/APR. Shares the
   * 5-minute current-price cache, so calling it once per recompute batch is
   * cheap.
   */
  async currentNativeUsd(chainId: number): Promise<number> {
    return this.nativeUsd(chainId);
  }

  /**
   * Current-price lookup for a single token via the provider registry. Walks
   * the configured order until a provider returns a positive quote. A quote
   * from a pool-derived source (subgraph derivedETH) only counts for tokens
   * with a trusted market (anchor/listed) — see `hasTrustedMarket`.
   */
  private async externalTokenUsd(chainId: number, tokenAddress: string, symbol?: string, cacheOnly = false): Promise<number> {
    const chain = getChainConfig(chainId);
    if (!chain || !this.registry) return 0;
    const lower = tokenAddress.toLowerCase();
    const cacheKey = currentCacheKey(chain.slug, lower);
    const cached = this.externalCache.get(cacheKey);
    if (cacheOnly) {
      // The backfill pipeline: no provider call, no Mongo read — ever. A
      // positive entry serves past its TTL (a real price, minutes old, beats
      // $0 on a closed row nothing will revisit) — but only within the same
      // freshness bound as a stored last-known-good, never at any age (the
      // cache lives as long as the process). `seedLastKnown` replaces an
      // expired entry with a newer stored price first. Anything else is $0.
      if (cached && cached.price > 0 && Date.now() - cachedPositiveAtMs(cached) <= CACHE_ONLY_MAX_AGE_MS) {
        return cached.price;
      }
      this.cacheOnlyMisses += 1;
      return 0;
    }
    if (cached && cached.expiresAt > Date.now()) {
      // A POSITIVE cached price is trusted for its full TTL. A negative (miss)
      // entry must NOT short-circuit to $0 and mask a `1_tokens` last-known-good
      // that may have been populated since (the bug that left iUSDC/RUBT at $0
      // for minutes): re-consult last-known on a negative hit (cheap, no
      // provider re-hammer), so a freshly-cached real price rescues it.
      if (cached.price > 0) return cached.price;
      const lk = await this.lastKnownPrice(chainId, lower);
      if (lk > 0) {
        this.externalCache.set(cacheKey, { price: lk, expiresAt: Date.now() + CURRENT_CACHE_TTL_MS });
        return lk;
      }
      return 0;
    }

    // Two-pass walk. Pass 1: independent aggregators ONLY — pool-derived
    // sources (subgraph derivedETH) are skipped for EVERY token, anchors
    // included: derivedETH is seedable for any token (real FDUSD was quoted
    // $287, cmETH $173M — and the BUSD config-ANCHOR $9,155.85 from a seeded
    // pool, turning a real −$2.3M closed position into +$24.7M). Pass 2:
    // tokens the aggregators missed fall back to the subgraph IF they have a
    // trusted market (anchor/allowlisted) — a real listed token with no
    // aggregator coverage still prices; no-market tokens never get a
    // pool-minted price.
    // A ledger-held token (`PRICE_MISS_LEDGER=on`) skips the aggregators here
    // too — local copy only, no I/O on the single-token path. Only the
    // BATCH-capable ones: those are exactly the providers whose answers made
    // the miss definite (`prefetchPrices`' expected set). A single-only
    // aggregator (DIA; Moralis / Chainbase when keyed) was never asked, so it
    // has no say in the verdict and keeps being asked — a token only it
    // prices still prices, as a miss did before.
    const ledgerHeld = this.ledgerOn() && this.ledger.isHeldLocally(chainId, lower);
    const guardPolicy = trustPolicyOf(this.config);
    for (const allowPoolDerivedFallback of [false, true]) {
      for (const provider of this.registry.currentProviders()) {
        if (!provider.isAvailable()) continue;
        if (isPoolDerivedSource(provider.name)) {
          if (!allowPoolDerivedFallback) continue;
          if (!this.hasTrustedMarket(chainId, lower)) continue;
        } else if (allowPoolDerivedFallback) {
          continue; // pass 2 retries pool-derived sources only
        } else if (ledgerHeld && provider.supportsCurrentBatch && !!provider.getCurrentBatch) {
          continue; // held: the batch aggregators already answered "no price"
        }
        const quote = await provider.getCurrentSingle(chainId, lower);
        if (quote && quote.priceUsd > 0) {
          // Quote guard (`PRICE_QUOTE_GUARD=on`): a stale or thin quote never
          // wins the first-positive walk — the walk moves on to the next
          // provider as if this one had missed (and it is never persisted).
          if (guardPolicy.quoteGuard && quoteRejection(quote, provider.name, guardPolicy)) continue;
          const poolDerived = isPoolDerivedSource(provider.name);
          if (!poolDerived && this.ledgerOn()) void this.ledger.recordPositives(chainId, [lower]);
          this.externalCache.set(cacheKey, {
            price: quote.priceUsd,
            expiresAt: Date.now() + CURRENT_CACHE_TTL_MS,
            // Provenance marker: a pass-2 subgraph quote is pool-derived, not an
            // independent market — pricePool demotes its confidence accordingly.
            poolDerived: poolDerived || undefined,
          });
          // Never persist pool-derived quotes as last-known-good — a seeded
          // derivedETH ($10.4M AMKT) must not resurrect later as a "real" price.
          if (!poolDerived) {
            void this.persistCurrentPrice(chainId, lower, quote.priceUsd, quoteEvidenceOn(guardPolicy) ? { provider: provider.name, quote } : undefined);
          }
          return quote.priceUsd;
        }
      }
    }

    // Live providers had no positive quote (genuine miss OR transient
    // rate-limit/outage). Fall back to a recent last-known-good price — a real
    // prior quote — so a transient provider gap never zeroes a token that has a
    // real market. Gated by row PROVENANCE, not token listing (2026-06-11): a
    // pool-derived row (subgraph derivedETH spam persisted by an older build)
    // never resurrects, but a genuine aggregator quote for a non-listed token
    // (gecko's RPC) survives gecko's rate-limit gaps — without it the
    // USDC/RPC position flapped pending↔valid every refresh tick. Downstream
    // valuation still gates what such a quote is WORTH (consistency,
    // realizability, pending-reserves).
    const lastKnown = await this.lastKnownPrice(chainId, lower);
    if (lastKnown > 0) {
      this.externalCache.set(cacheKey, { price: lastKnown, expiresAt: Date.now() + CURRENT_CACHE_TTL_MS });
      return lastKnown;
    }
    // No live price and no recent last-known → genuine miss. Negative-cache
    // BRIEFLY (MISS_CACHE_TTL_MS) so the token re-attempts soon and picks up a
    // freshly-cached price rather than being pinned at $0 for the full 5-min TTL.
    this.externalCache.set(cacheKey, { price: 0, expiresAt: Date.now() + MISS_CACHE_TTL_MS });
    return 0;
  }

  /** True when the freshest cached quote for this token came from a pool-derived source (pass-2 subgraph fallback). */
  private quoteWasPoolDerived(chainId: number, address: string): boolean {
    const chain = getChainConfig(chainId);
    if (!chain) return false;
    return this.externalCache.get(currentCacheKey(chain.slug, address.toLowerCase()))?.poolDerived === true;
  }

  /**
   * True when a token has an independently-trusted market: a config anchor or a
   * CoinGecko-listed token. Pool-derived price sources (the Uniswap subgraph's
   * `derivedETH` — itself computed from pool ratios) and the last-known-good
   * store are only believed for these tokens; for anything else they are
   * circular (a seeded spam pool mints its own derivedETH, e.g. AU quoted
   * $57.75 purely from its own AU/USDT pool) and an independent aggregator
   * quote is required instead. Fail-open when the listing gate/service is off,
   * matching the trust-gate behavior.
   */
  private hasTrustedMarket(chainId: number, address: string): boolean {
    if (!this.config.tokenListingGateEnabled || !this.listing) return true;
    return isAnchorTokenStandalone(chainId, address) || this.listedFor(chainId, address);
  }

  /**
   * The historical walk's `hasTrustedMarket` gates (pool-derived cache rows,
   * the pool-derived primary) read the trust rule synchronously, and nothing
   * on that path loaded the stored verdicts — so in `combined` mode a flagged
   * (`trustDenied`) listed token read as listed there and kept its
   * pool-derived rows, and in `earned` mode an earned token read as unknown.
   * One read per chain of the requested non-anchor tokens (`warm` skips fresh
   * ones); nothing in `allowlist` mode (today's rule reads no verdict) or with
   * the listing gate off (the gates pass everything).
   */
  private async warmHistoricalTrust(requests: Iterable<HistoricalTokenPriceRequest>): Promise<void> {
    if (!this.config.tokenListingGateEnabled || !this.listing || !usesStoredVerdicts(trustPolicyOf(this.config))) return;
    const byChain = new Map<number, string[]>();
    for (const req of requests) {
      if (isAnchorTokenStandalone(req.chainId, req.address)) continue;
      const list = byChain.get(req.chainId);
      if (list) list.push(req.address);
      else byChain.set(req.chainId, [req.address]);
    }
    for (const [chainId, addresses] of byChain) await this.trust().warm(chainId, addresses);
  }

  /**
   * "Listed" for the trust gate = the ONE trust rule (`TokenTrustService`).
   * `allowlist` mode (default) is today's listing check exactly (the env deny
   * list, empty by default, can only remove trust); `earned` mode reads the
   * stored earned verdict warmed with the page's DEX-market state.
   * `combined` mode ORs the two: today's listing check, read through the SAME
   * listing service as allowlist mode (so it can never drop a token allowlist
   * mode keeps, whatever the service answers — fail-open when absent
   * included), or the trust rule. A denial — env, or the stored flag this
   * mode honours — beats both.
   */
  private listedFor(chainId: number, address: string): boolean {
    const policy = trustPolicyOf(this.config);
    if (policy.mode === 'earned') return this.trust().isTrusted(chainId, address);
    const listed = this.listing ? this.listing.isListed(chainId, address) : true;
    if (policy.mode === 'combined') {
      const verdict = this.trust().trust(chainId, address);
      if (verdict.reason === 'denied') return false;
      return listed || verdict.trusted;
    }
    return listed && !isDenied(policy, chainId, address);
  }

  /**
   * Is this leg's quote corroborated by ≥ 2 independent sources (quote guard
   * evidence)? `false` when the sweep recorded that its accepted quotes
   * disagreed, or that only one source priced it; `true` when the stored
   * consensus agreed, or — earned / combined mode (`usesStoredVerdicts`) — the
   * token holds a fresh EARNED verdict (criterion (a) requires ≥ 2 agreeing
   * fresh sources incl. a non-DEX aggregator; combined mode reports `earned`
   * ahead of `allowlist` for a listed token that has one); `undefined` = no
   * evidence warmed for this token.
   */
  private legCorroborated(chainId: number, address: string): boolean | undefined {
    if (this.storedDisagreement(chainId, address) === true) return false;
    const chain = getChainConfig(chainId);
    if (!chain) return undefined;
    const c = this.consensusCache.get(currentCacheKey(chain.slug, address.toLowerCase()));
    const consensus = c && c.expiresAt > Date.now() ? c.consensus : undefined;
    if (consensus === true) return true;
    if (usesStoredVerdicts(trustPolicyOf(this.config)) && this.trust().trust(chainId, address).reason === 'earned') return true;
    return consensus;
  }

  /** The sweep's stored "accepted quotes disagreed" flag for a token (undefined = not loaded / unswept / no current evidence). */
  private storedDisagreement(chainId: number, address: string): boolean | undefined {
    const chain = getChainConfig(chainId);
    if (!chain) return undefined;
    const c = this.disagreedCache.get(currentCacheKey(chain.slug, address.toLowerCase()));
    if (!c || c.expiresAt <= Date.now()) return undefined;
    return c.disagreed;
  }

  /**
   * Batch-load DEX-market state for the page's tokens from `{chainId}_tokens`
   * (the consensus sweep's `priceSources`) into the in-memory cache. Best-effort
   * — a read failure leaves entries UNKNOWN (gate fails open).
   */
  private async loadDexMarketState(chainId: number, addresses: string[]): Promise<void> {
    if (!this.tokens || addresses.length === 0) return;
    const chain = getChainConfig(chainId);
    if (!chain) return;
    const now = Date.now();
    const fresh = addresses.filter((a) => {
      const c = this.dexMarketCache.get(currentCacheKey(chain.slug, a.toLowerCase()));
      return !c || c.expiresAt <= now;
    });
    if (fresh.length === 0) return;
    const policy = trustPolicyOf(this.config);
    if (policy.quoteGuard || usesStoredVerdicts(policy)) {
      // ONE read for the DEX-market verdict, the stored disagreement flag
      // (quote guard) and the trust evidence (earned / combined mode).
      try {
        const state = await this.tokens.findMarketState(chainId, fresh);
        const expiresAt = Date.now() + CURRENT_CACHE_TTL_MS;
        const trustRows = new Map<string, StoredTokenTrust>();
        for (const addr of fresh) {
          const lower = addr.toLowerCase();
          const row = state.get(lower);
          if (!row) continue;
          if (row.dexBacked !== undefined) this.dexMarketCache.set(currentCacheKey(chain.slug, lower), { backed: row.dexBacked, expiresAt });
          if (row.disagreed !== undefined) this.disagreedCache.set(currentCacheKey(chain.slug, lower), { disagreed: row.disagreed, expiresAt });
          if (row.consensus !== undefined) this.consensusCache.set(currentCacheKey(chain.slug, lower), { consensus: row.consensus, expiresAt });
          trustRows.set(lower, row.trust);
        }
        this.trust().primeMany(chainId, fresh, trustRows);
      } catch (err) {
        this.logger.debug(`market state load failed for ${fresh.length} tokens: ${(err as Error)?.message}`);
      }
      return;
    }
    try {
      const state = await this.tokens.findDexMarketState(chainId, fresh);
      const expiresAt = Date.now() + CURRENT_CACHE_TTL_MS;
      for (const addr of fresh) {
        const backed = state.get(addr.toLowerCase());
        // Only cache a KNOWN verdict; leave unswept tokens absent (= unknown).
        if (backed !== undefined) {
          this.dexMarketCache.set(currentCacheKey(chain.slug, addr.toLowerCase()), { backed, expiresAt });
        }
      }
    } catch (err) {
      this.logger.debug(`dex-market state load failed for ${fresh.length} tokens: ${(err as Error)?.message}`);
    }
  }

  /**
   * DEX-market verdict for the value gate: 'backed' = a real on-chain DEX market
   * priced it, 'no-market' = priced ONLY by non-DEX aggregators (symbol/FX
   * match, no DEX pair), 'unknown' = not yet swept (gate fails OPEN). Reads the
   * cache warmed by `loadDexMarketState`; never does I/O on the hot path.
   */
  private dexMarketState(chainId: number, address: string): 'backed' | 'no-market' | 'unknown' {
    const chain = getChainConfig(chainId);
    if (!chain) return 'unknown';
    const c = this.dexMarketCache.get(currentCacheKey(chain.slug, address.toLowerCase()));
    if (!c || c.expiresAt <= Date.now()) return 'unknown';
    return c.backed ? 'backed' : 'no-market';
  }

  /**
   * Most-recent stored current price for a token from `{chainId}_tokens`, if
   * within the freshness window. Only NON-pool-derived quotes are ever
   * persisted (see `persistCurrentPrice` callers), so no provenance check is
   * needed here — a seeded pool's self-minted price never reaches the store.
   */
  private async lastKnownPrice(chainId: number, address: string): Promise<number> {
    if (!this.tokens || LAST_KNOWN_MAX_AGE_MS <= 0) return 0;
    try {
      const map = await this.readLastKnown(chainId, [address]);
      const row = map.get(address.toLowerCase());
      if (!row || !(row.priceUsd > 0) || !row.pricedAt) return 0;
      const ageMs = Date.now() - row.pricedAt.getTime();
      return ageMs <= LAST_KNOWN_MAX_AGE_MS ? row.priceUsd : 0;
    } catch {
      return 0;
    }
  }

  /** Persist a successful current price into `{chainId}_tokens` as durable
   * last-known-good (best-effort). Callers persist NON-pool-derived quotes only. */
  private persistCurrentPrice(
    chainId: number,
    address: string,
    priceUsd: number,
    provenance?: { provider: string; quote: PriceQuote },
  ): Promise<void> {
    if (!this.tokens) return Promise.resolve();
    return this.tokens.upsertPrices(chainId, [{ address, priceUsd, ...provenanceFields(provenance) }]).catch(() => {});
  }

  /**
   * Emits a single-line log per token price resolution showing the source
   * (cache, provider name, or 'none' if every provider failed). Verbose by
   * design — tx-sync backfills produce a lot of lines, but each one is
   * grep-friendly: `Price chainId=N source=X SYMBOL(0xshort)=$price`.
   */
  private logTokenPrice(
    chainId: number,
    source: string,
    symbol: string | undefined,
    address: string,
    priceUsd: number,
    bucketTs: number,
  ): void {
    // Per-token miss lines are noisy in prod (thousands per batch). Keep
    // them in dev only; aggregate `missed=N` count in the batch-summary
    // log still surfaces totals.
    if (process.env.NODE_ENV === 'production') return;
    const isMiss = priceUsd <= 0 || source === 'none' || source === 'mongo-cache(miss)';
    if (!isMiss) return;
    const sym = symbol ?? '?';
    const ts = bucketTs > 0 ? new Date(bucketTs * 1000).toISOString() : 'unknown';
    this.logger.log(`Price MISS chain=${chainId} source=${source} ${sym}(${address}) ts=${ts}`);
  }

}

/**
 * Project an internal `HistoricalTokenPriceRequest` (deduped + bucketed) into
 * the `HistoricalReq` shape providers consume. The bucketed timestamp is used
 * so providers and cache rows agree on bucket alignment. Extended pool-context
 * fields pass through untouched — external providers ignore them; the
 * pool-ratio provider relies on them.
 */
/**
 * Quote provenance for a hot-path persist (only with the guard / trust
 * evidence on — `undefined` adds nothing, so today's write is unchanged).
 */
/**
 * A cached own-pairs answer younger than this that contradicts a token's
 * sampled (b) reading is neither re-asked nor read as a decision: no verdict
 * that sweep (`sampleMarket`). Three consensus sweeps (every 5 min): a lasting
 * contradiction costs one request per token per 15 min instead of one per
 * sweep, and a rug inside the pair cache's TTL is revoked at most this much
 * later than a fresh answer would.
 */
const RECENT_PAIR_ANSWER_MS = 15 * 60_000;

/**
 * Most tokens `PricingService.pairAskedAt` remembers (every chain together;
 * the active-token universe is ~45k today). Past it the least recently asked
 * is forgotten, which only moves it to "never asked" — the front of the line,
 * where being the least recently asked already put it.
 */
const PAIR_ASKED_MAX = 200_000;

/**
 * Stable in-place sort by a numeric key tuple, compared left to right
 * (ascending); each item's key is computed once. Equal keys keep their order
 * — batch order is the last tiebreak of `orderPairRequests`.
 */
function sortByKeys<T>(items: T[], keyOf: (item: T) => readonly number[]): void {
  const keyed = items.map((item, i) => ({ item, key: keyOf(item), i }));
  keyed.sort((a, b) => {
    for (let k = 0; k < Math.max(a.key.length, b.key.length); k += 1) {
      const x = a.key[k] ?? 0;
      const y = b.key[k] ?? 0;
      if (x !== y) return x < y ? -1 : 1;
    }
    return a.i - b.i;
  });
  for (let i = 0; i < keyed.length; i += 1) items[i] = keyed[i]!.item;
}

/** The active-market floors (`DEX_MARKET_MIN_VOLUME_USD`, `DEX_MARKET_MIN_COUNTER_LIQUIDITY_USD`); an unknown counter side is not gated, never 0. */
function passesDexFloors(volume: number, counterUsd: number | undefined, minVol: number, minCounter: number): boolean {
  return volume >= minVol && (counterUsd === undefined || counterUsd >= minCounter);
}

type DatedQuote = SourceQuote & { quotedAtMs?: number; rejected: boolean };

/**
 * When an earned-trust verdict is judged (`earnedTrustRecord`): `main` —
 * inline, batch order, reading only answers to hand (and, for a per-chain
 * token whose served re-check waited, right after that re-check); `c` — the
 * batch's request phase, in priority order (`orderPairRequests`), for a
 * token whose (c) needs the request the rule before (b)-on-a-sample made;
 * `fail` / `pass` — after that, for a token whose (b) needs a request of its
 * own (its sample fails / passes).
 */
type VerdictPhase = 'main' | 'c' | 'fail' | 'pass';

/** One token's earned-trust inputs, as `prefetchConsensus` gathered them. */
interface VerdictJob {
  addr: string;
  dated: ReadonlyArray<DatedQuote>;
  /** The served `dexActive` (per-chain: after the served re-check). */
  dexActive: boolean | undefined;
  evidence: { pairs: DexPairSummary[]; complete: boolean } | undefined;
  failureDefinite: boolean;
  dexFailureDefinite: boolean;
  /** DexScreener priced it from a sample of its pairs: the batch-seen volume and the sample's own floor reading. */
  sample?: { seenVolume?: number; active: boolean };
}

/** A verdict that needs a pair request phase `main` does not make: judge it again in `deferred`'s phase. */
interface VerdictDeferral {
  deferred: 'c' | 'fail' | 'pass';
  /** When the token's cached answer was fetched (−∞ = none): the oldest asks first (`fail` / `pass`; `c` has its own order). */
  answerAt: number;
}

/** A per-chain served re-check that needs a request: made in the batch's request phase (`prefetchConsensus`). */
interface ServedRecheck {
  addr: string;
  /** The token's price record, as `main` built it (`dexActive: false`); a pass on its own market completes it. */
  record: TokenPriceRecord;
  /** The volume the batch saw (`ownMarket` reads at least this). */
  seenVolume: number | undefined;
  /** Its verdict job (trust evidence on), judged once the re-check has run — it shares that request. */
  job?: VerdictJob;
}

function isVerdictDeferral(v: unknown): v is VerdictDeferral {
  return typeof v === 'object' && v !== null && 'deferred' in v;
}

/** What one consensus sweep's earned-trust evidence shares across tokens. */
interface TrustEvidenceContext {
  /** The quotes that voted this sweep, per address. */
  byAddr: ReadonlyMap<string, SourceQuote[]>;
  /** Trusted counter tokens' prices, as `loadTrustCounters` resolved them. */
  counterPx: Map<string, number>;
  /** The provider answering per-token pair lookups (DexScreener), if any runs. */
  pairSource?: PriceProvider;
  /**
   * Earned trust's and per-chain's served re-check's pair-request budgets for
   * this batch: its share of the sweep RUN's (spread over the run's batches,
   * drawing from the process-wide rate — `ConsensusSweepRun`), or one lone
   * call's own (`batchPairLookupBudget`).
   */
  lookups: PairLookupShare;
  /** Pair answers this sweep already had (null = its request failed): one request per token per sweep. */
  pairAnswers: Map<string, TokenPairEvidence | null>;
  /** `DEXSCREENER_BATCH_ENDPOINT=per-chain`: a token's own market is read in both orientations (`ownMarket`). */
  perChain: boolean;
}

/** `dia:stale` → `dia`. */
function rejectedProviderOf(tag: string): string {
  const i = tag.lastIndexOf(':');
  return i > 0 ? tag.slice(0, i) : tag;
}

/**
 * Quote-guard evidence for one swept token (stored with its price when the
 * guard or trust evidence is on): the providers rejected / that would be
 * rejected, the consensus over only the accepted quotes (what the guard would
 * serve), whether ≥ 2 accepted quotes disagreed, and the provider date behind
 * the chosen price. The date is the OLDEST over the chosen sources the guard
 * ACCEPTS — a fresh consensus that a stale DIA quote happens to sit within 10%
 * of is not a months-old price (shadow: the stale quote still votes) — and
 * over the rejected ones only when no accepted source backs the price (then
 * their age IS the price's age).
 */
export function guardEvidenceOf(
  dated: ReadonlyArray<DatedQuote>,
  chosenSources: readonly string[],
  rejected: string[] | undefined,
): Pick<TokenPriceRecord, 'priceQuoteRejected' | 'priceGuardUsd' | 'priceQuotedAt' | 'priceSourcesDisagreed'> {
  const acceptedQuotes = dated.filter((q) => !q.rejected).map(({ source, priceUsd }) => ({ source, priceUsd }));
  const accepted = reconcileQuotes(acceptedQuotes);
  const acceptedPositive = acceptedQuotes.filter((q) => Number.isFinite(q.priceUsd) && q.priceUsd > 0).length;
  const chosen = dated.filter((q) => chosenSources.includes(q.source));
  const backing = chosen.some((q) => !q.rejected) ? chosen.filter((q) => !q.rejected) : chosen;
  let oldest: number | undefined;
  for (const q of backing) {
    if (typeof q.quotedAtMs === 'number' && Number.isFinite(q.quotedAtMs)) oldest = oldest === undefined ? q.quotedAtMs : Math.min(oldest, q.quotedAtMs);
  }
  return {
    priceQuoteRejected: rejected ?? [],
    priceGuardUsd: accepted.confidence === 'none' ? 0 : accepted.priceUsd,
    priceQuotedAt: oldest !== undefined ? new Date(oldest) : null,
    priceSourcesDisagreed: acceptedPositive >= 2 && accepted.confidence !== 'consensus',
  };
}

function provenanceFields(p?: { provider: string; quote: PriceQuote }): Pick<TokenPriceRecord, 'priceQuoteSource' | 'priceQuotedAt'> {
  if (!p) return {};
  const at = p.quote.quotedAtMs;
  return {
    priceQuoteSource: p.provider,
    // null, not undefined: an undated answer must overwrite an older dated one.
    priceQuotedAt: typeof at === 'number' && Number.isFinite(at) ? new Date(at) : null,
  };
}

function toProviderRequest(
  req: HistoricalTokenPriceRequest & { bucketTs: number },
): HistoricalReq {
  return {
    chainId: req.chainId,
    address: req.address,
    timestamp: req.bucketTs,
    poolHint: req.poolHint,
    anchorAddress: req.anchorAddress,
    protocol: req.protocol,
    tokenDecimals: req.tokenDecimals,
    anchorDecimals: req.anchorDecimals,
    isToken0: req.isToken0,
    unverified: req.unverified,
  };
}

function isMissStillValid(fetchedAt: Date | undefined, ttlMs: number, nowMs: number): boolean {
  if (!fetchedAt || ttlMs <= 0) return false;
  const fetchedMs = fetchedAt instanceof Date ? fetchedAt.getTime() : Number(new Date(fetchedAt));
  if (!Number.isFinite(fetchedMs)) return false;
  return nowMs - fetchedMs < ttlMs;
}

export function historicalTokenPriceRequestKey(
  chainId: number,
  address: string,
  timestamp: number,
): string {
  const bucketTs = Math.floor(timestamp / PRICE_CACHE_BUCKET_SECONDS) * PRICE_CACHE_BUCKET_SECONDS;
  return [chainId, address.toLowerCase(), bucketTs].join(':');
}

/** Outcome counters of a provider; zeros for a stub without `getMetrics` (specs). */
function metricsOf(provider: PriceProvider): { skip: number; ratelimit: number; error: number } {
  const m = typeof provider.getMetrics === 'function' ? provider.getMetrics() : undefined;
  return { skip: m?.skip ?? 0, ratelimit: m?.ratelimit ?? 0, error: m?.error ?? 0 };
}

function currentCacheKey(chainSlug: string, address: string): string {
  return `${chainSlug}:${address.toLowerCase()}`;
}

/** Current 30-min price bucket (seconds) — aligns last-known writes with the historical store. */
function currentBucketTs(): number {
  return Math.floor(Date.now() / 1000 / PRICE_CACHE_BUCKET_SECONDS) * PRICE_CACHE_BUCKET_SECONDS;
}

/**
 * Providers whose quotes come from pool state rather than an independent
 * market: the Uniswap subgraph family prices via `derivedETH` (propagated
 * through pool ratios), so for a token with no trusted market the "quote" is
 * just its own pool's seeded ratio dressed up as a price.
 */
function isPoolDerivedSource(providerName: string): boolean {
  return providerName.startsWith('subgraph');
}

/**
 * Pool TVL surrogate used by the current-pricing decision. Tracked and
 * untracked subgraph TVLs both surface here — v4 untracked tokens often
 * have only one valid side, so we pick the max rather than sum.
 *
 * Phase 2 of the pricing redesign should replace this with anchor-side
 * locked value; today's TVL fields underestimate v4 pool depth.
 */
// Background-sweep rate-limit wait: poll availability every 5s, up to 3 min
// (GeckoTerminal free tier refills 30 calls/min — one window is usually enough).
const PROVIDER_WAIT_POLL_MS = 5_000;
const PROVIDER_WAIT_MAX_MS = 180_000;

/** Wait for a rate-limited provider to come back. True = available again. */
async function waitForProvider(provider: PriceProvider): Promise<boolean> {
  const deadline = Date.now() + PROVIDER_WAIT_MAX_MS;
  while (!provider.isAvailable()) {
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, PROVIDER_WAIT_POLL_MS));
  }
  return true;
}

function pickPoolTvl(input: PriceInput): number {
  const tracked = Number(input.poolTvlUsd ?? 0);
  const untracked = Number(input.poolTvlUsdUntracked ?? 0);
  return Math.max(
    Number.isFinite(tracked) ? tracked : 0,
    Number.isFinite(untracked) ? untracked : 0,
  );
}

function externalDecision(
  token: TokenMeta,
  anchor: AnchorKind,
  priceUsd: number,
): TokenDecision {
  if (anchor === 'stable') {
    return { priceUsd, source: 'stable-anchor', confidence: 'anchor', derived: false };
  }
  if (anchor === 'native') {
    return { priceUsd, source: 'native-anchor', confidence: 'anchor', derived: false };
  }
  const confidence: PriceConfidence = token.verified === false ? 'external-unverified' : 'external-verified';
  return { priceUsd, source: 'external', confidence, derived: false };
}

function poolDerivedDecision(
  priceUsd: number,
  tvl: number,
  policy: PricingPolicy,
  strong: boolean,
): TokenDecision {
  const confidence: PriceConfidence = strong || tvl >= policy.derivation.minTvlUsdOverrideUnverified
    ? 'pool-derived-strong'
    : 'pool-derived-weak';
  return { priceUsd, source: 'pool-ratio', confidence, derived: true };
}

/**
 * Final listing-trust decision for one leg. Anchors and allowlisted tokens pass
 * through unchanged. A symbol-spoof impersonator is forced `suspect` ($0). A
 * non-listed, non-anchor token is trusted only when it carries a real external
 * aggregator/DEX quote (`external-verified`/`external-unverified`) — the
 * trust anchor the field uses (CoinGecko/DeFiLlama/etc.). A pool-only derived
 * price (`pool-derived-*`) means no real market for the token → dropped to $0,
 * so a token "priced" solely by a pool someone seeded at an arbitrary ratio
 * (e.g. a no-market "USD" token) never fabricates value. Per-position
 * pool-vs-market consistency is enforced separately by the valuation guard.
 */
function applyTrustGate(
  decision: TokenDecision,
  anchor: AnchorKind,
  listed: boolean,
  spoof: boolean,
  dexState: 'backed' | 'no-market' | 'unknown' = 'unknown',
  failClosed = false,
  noListedUpgrade = false,
): TokenDecision {
  if (spoof) return { priceUsd: 0, source: 'miss', confidence: 'suspect', derived: false };
  if (anchor !== 'none' || listed) {
    // Quote guard: the stored consensus says this listed token's sources did
    // NOT agree → its quote stays `external-unverified` (cross-checked
    // downstream against the pool) instead of being trusted for the listing.
    if (noListedUpgrade && anchor === 'none') return decision;
    // A CoinGecko-listed token's external quote IS a verified real market — the
    // tier must come from the allowlist, not the indexer's tiny `verified` flag
    // (PENDLE/LINK are allowlisted yet not on the indexer whitelist). Upgrading here lets a
    // listed leg serve as a pool-consistency REFERENCE downstream and keeps
    // listed/listed pools (no config anchor) from being zeroed by the
    // no-reference rule.
    if (listed && decision.confidence === 'external-unverified') {
      return { ...decision, confidence: 'external-verified' };
    }
    return decision;
  }
  // Non-anchor, non-listed: trust the external quote only if a real on-chain DEX
  // market corroborates it. A 'no-market' verdict (consensus sweep priced it
  // ONLY via non-DEX aggregators → symbol/FX-matched scam: EUR=$1.15 fiat,
  // GOLDX=$3735 gold, DTC=$1) is zeroed — that is what keeps RPC's real $10.5M
  // while killing the $1.1T fabrications. 'backed' keeps the quote (its
  // single-source tier is unchanged — a thin DEX market must not become a
  // pool-consistency reference). 'unknown' (not yet swept) fails OPEN by default,
  // or CLOSED ($0) under `failClosed` (DEX_MARKET_FAIL_CLOSED) — a freshly-
  // discovered non-listed token shows "price unavailable" until the next sweep
  // confirms a real market, rather than carrying an unverified quote into value.
  if (dexState === 'no-market' || (failClosed && dexState === 'unknown')) {
    return { priceUsd: 0, source: 'miss', confidence: 'missing', derived: false };
  }
  if (
    decision.confidence === 'external-verified' ||
    decision.confidence === 'external-unverified'
  ) {
    return decision;
  }
  return { priceUsd: 0, source: 'miss', confidence: 'missing', derived: false };
}

/**
 * Decide whether the derived price should overwrite the external quote.
 * Three-way fork:
 *   - verified external: only override on severe divergence AND deep pool
 *   - unverified external: override on milder divergence AND mid-tier pool
 *   - missing external: never enters this branch (handled by fill-missing)
 */
function decideOverride(
  existing: TokenDecision,
  derivedUsd: number,
  tvl: number,
  policy: PricingPolicy,
): TokenDecision | null {
  if (existing.priceUsd <= 0 || derivedUsd <= 0) return null;
  const divergence =
    Math.max(existing.priceUsd, derivedUsd) / Math.min(existing.priceUsd, derivedUsd);

  // Distrust the pool ratio when it derives an absurd absolute price
  // (broken/thin pool — a real case derived $89B/token): keep the external,
  // never adopt it. (High divergence alone is NOT a reject signal — for
  // long-tail tokens the external is often the wrong, near-zero one and the
  // pool ratio is the truth, which is exactly what this override is for.)
  if (derivedUsd > MAX_DERIVED_TOKEN_PRICE_USD) {
    return null;
  }

  if (existing.confidence === 'external-verified') {
    if (tvl < policy.derivation.minTvlUsdOverrideVerified) return null;
    if (divergence < policy.derivation.maxVerifiedDivergence) return null;
    return { priceUsd: derivedUsd, source: 'pool-ratio', confidence: 'pool-derived-strong', derived: true };
  }
  if (existing.confidence === 'external-unverified') {
    if (tvl < policy.derivation.minTvlUsdOverrideUnverified) return null;
    const minDivergence = policy.derivation.maxUnverifiedDivergence ?? policy.derivation.maxVerifiedDivergence;
    if (divergence < minDivergence) return null;
    return { priceUsd: derivedUsd, source: 'pool-ratio', confidence: 'pool-derived-strong', derived: true };
  }
  return null;
}

/**
 * Collapse two `TokenDecision` rows into the public `PriceResult` shape.
 * `source` is the legacy single-field flavour used by valuation gating;
 * we choose the strongest signal of the two (anchor > external > pool-
 * derived > none). `usedFallback` stays true whenever either side was
 * derived from a pool ratio.
 */
function buildPriceResult(t0: TokenDecision, t1: TokenDecision): PriceResult {
  return {
    token0Usd: t0.priceUsd,
    token1Usd: t1.priceUsd,
    source: collapseLegacySource(t0.source, t1.source),
    usedFallback: t0.derived || t1.derived,
    token0Source: t0.source,
    token1Source: t1.source,
    token0Confidence: t0.confidence,
    token1Confidence: t1.confidence,
  };
}

function collapseLegacySource(s0: PriceSourceKind, s1: PriceSourceKind): PricingSource {
  const rank: Record<PriceSourceKind, number> = {
    'stable-anchor': 5,
    'native-anchor': 5,
    external: 4,
    historical: 3,
    'pool-ratio': 2,
    'last-known': 1,
    miss: 0,
    none: 0,
  };
  const best = rank[s0] >= rank[s1] ? s0 : s1;
  switch (best) {
    case 'stable-anchor':
      return 'stable-anchor';
    case 'native-anchor':
      return 'native-anchor';
    case 'external':
      return 'external';
    case 'historical':
      return 'historical';
    case 'pool-ratio':
    case 'last-known':
    case 'miss':
    case 'none':
    default:
      return best === 'pool-ratio' ? 'external' : 'none';
  }
}

function getChainSlug(chainId: number): string {
  return getChainConfig(chainId)?.slug ?? `chain-${chainId}`;
}

async function mapConcurrent<T>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<void>,
): Promise<void> {
  if (values.length === 0) return;

  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), values.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < values.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        const value = values[currentIndex];
        if (value !== undefined) await mapper(value, currentIndex);
      }
    }),
  );
}

/**
 * Race a provider call against a wall-clock timeout. On timeout, mark the
 * provider backed-off (so the next batch skips it) and throw — caller's
 * catch then moves on to the next provider in the chain.
 *
 * The underlying provider call still runs to completion in the background
 * (we don't have AbortController plumbing here); its result is just
 * discarded. Acceptable trade-off — we get fast fail-over without
 * complicating every provider's HTTP path.
 */
async function withProviderTimeout<T>(
  provider: PriceProvider,
  timeoutMs: number,
  call: () => Promise<T>,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race<T>([
      call(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          provider.markBackoff(undefined, `call timed out after ${timeoutMs}ms`);
          reject(new Error(`provider ${provider.name} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
