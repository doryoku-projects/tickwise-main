// Pure cross-source price reconciliation. Given quotes from multiple
// INDEPENDENT providers for one token, decide a single price + a confidence
// that reflects how well the sources agree — so a lone outlier (a provider
// quoting a thin token 10,000x high) can't win on a first-positive-wins fluke.
//
// No NestJS deps so it's trivially unit-tested and importable from scripts.

export type ConsensusConfidence = 'consensus' | 'single-source' | 'none';

export interface SourceQuote {
  source: string;
  priceUsd: number;
}

export interface ConsensusResult {
  /** Reconciled USD price (0 when no positive quote). */
  priceUsd: number;
  confidence: ConsensusConfidence;
  /** Sources that backed the chosen price (the agreeing cluster, or the single source). */
  sources: string[];
  /** Quotes rejected as outliers / discordant (for observability). */
  outliers: SourceQuote[];
}

// Two prices "agree" when within this ratio of each other. Lenient (10%) so
// honest cross-provider drift (fees, block lag, sampling) still clusters, but
// a 10,000x outlier never does. Env-tunable.
export const CONSENSUS_AGREE_RATIO = Math.max(1.001, Number(process.env.PRICING_CONSENSUS_AGREE_RATIO) || 1.1);

function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Reconcile multi-source quotes into one price + confidence:
 * - 0 positive quotes → { 0, 'none' }.
 * - 1 positive quote → that price, 'single-source'.
 * - ≥2 → take the median, keep the quotes within `CONSENSUS_AGREE_RATIO` of it
 *   (the agreeing cluster); if ≥2 agree → median of the cluster, 'consensus'
 *   (outliers rejected — this is what kills the lone 10,000x quote). If no two
 *   agree (e.g. two wildly different sources) → the MIN positive price (never
 *   let the high one inflate), 'single-source'.
 */
export function reconcileQuotes(quotes: SourceQuote[]): ConsensusResult {
  const positive = quotes.filter((q) => Number.isFinite(q.priceUsd) && q.priceUsd > 0);
  if (positive.length === 0) return { priceUsd: 0, confidence: 'none', sources: [], outliers: [] };
  if (positive.length === 1) {
    return { priceUsd: positive[0]!.priceUsd, confidence: 'single-source', sources: [positive[0]!.source], outliers: [] };
  }

  const med = median([...positive.map((q) => q.priceUsd)].sort((a, b) => a - b));
  const agreeing: SourceQuote[] = [];
  const outliers: SourceQuote[] = [];
  for (const q of positive) {
    const hi = Math.max(q.priceUsd, med);
    const lo = Math.min(q.priceUsd, med);
    (lo > 0 && hi / lo <= CONSENSUS_AGREE_RATIO ? agreeing : outliers).push(q);
  }

  if (agreeing.length >= 2) {
    const price = median([...agreeing.map((q) => q.priceUsd)].sort((a, b) => a - b));
    return { priceUsd: price, confidence: 'consensus', sources: agreeing.map((q) => q.source), outliers };
  }

  // No agreeing cluster — sources disagree. Be conservative (anti-inflation):
  // take the LOWEST positive quote and mark it low-confidence.
  const lowest = positive.reduce((a, b) => (b.priceUsd < a.priceUsd ? b : a));
  return {
    priceUsd: lowest.priceUsd,
    confidence: 'single-source',
    sources: [lowest.source],
    outliers: positive.filter((q) => q !== lowest),
  };
}

/** Map a consensus verdict to the downstream `PriceConfidence` trust tier. */
export function consensusToConfidence(c: ConsensusConfidence): 'external-verified' | 'external-unverified' | 'missing' {
  if (c === 'consensus') return 'external-verified';
  if (c === 'single-source') return 'external-unverified';
  return 'missing';
}

// Providers that ONLY return on-chain DEX-pair prices: they quote a token iff a
// real liquidity-backed market exists for it. A price corroborated by one of
// these is "DEX-backed" — a genuine market value. A price from a non-DEX
// aggregator ALONE (CoinGecko/DeFiLlama/Alchemy/Moralis/Chainbase) can be a
// symbol/FX/stablecoin-list MATCH for a scam token with no real market (a "EUR"
// token quoted the €/$ fiat rate, "GOLDX" the gold rate, "DTC" at $1) — those
// have NO DEX pair, so the DEX-market value gate doesn't trust them.
export const DEX_MARKET_SOURCES: ReadonlySet<string> = new Set(['dexscreener', 'geckoterminal']);

/** True when any of a token's consensus price sources is a real on-chain DEX market. */
export function isDexBacked(sources: readonly string[] | undefined): boolean {
  return Array.isArray(sources) && sources.some((s) => DEX_MARKET_SOURCES.has(s));
}
