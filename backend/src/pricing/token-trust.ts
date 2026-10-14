// Token trust, in ONE place: "is this token trusted for valuation, and why".
//
// Three modes (`TOKEN_TRUST_MODE`):
//   - `allowlist` (default = today): a token is trusted when it is a config
//     anchor (stable / native / trusted) or on the committed CoinGecko
//     allowlist (`isAllowlisted`).
//   - `earned`: a config anchor, or a token whose EARNED-TRUST verdict — baked
//     by the consensus price sweep from market evidence and stored on
//     `{chainId}_tokens` — is positive and fresh. Nothing to maintain by hand:
//     the sweep re-derives the verdict every pass and revokes it the moment the
//     evidence stops holding. The committed allowlist is NOT consulted.
//   - `combined`: a config anchor, OR allowlisted, OR a fresh positive earned
//     verdict — the union, so it can only ADD trust to either mode (a property
//     the specs pin over every case). Earned mode alone drops listed tokens a
//     DEX market cannot vouch for (4663's tokenized stocks are single-source
//     by construction); the allowlist alone misses real tokens nobody listed
//     (BTC.b on Ethereum). What combined buys over plain `allowlist` for a
//     LISTED token is the pools sync's 10% pool-price cross-check, which runs
//     in every mode that loads stored verdicts (`usesStoredVerdicts`).
// An EMERGENCY DENY list removes trust from a non-anchor token. It is a
// denial list only — there is no allow list. `TOKEN_TRUST_DENY` (env) works in
// EVERY mode, everywhere. The `trustDenied` flag on the token's document works
// in the modes that load stored verdicts (`earned`, `combined`): those are the
// modes in which every reader (position path, pools sync, leaderboard
// exclusion) loads the stored trust fields, so a hand-set flag gives one
// answer everywhere — and it is the ONE thing combined trusts LESS than
// allowlist mode would (a flagged listed token). In `allowlist` mode nothing
// but the exclusion scan reads token documents for trust, and honouring the
// flag there alone made a denied token vanish from ranked lists while its
// pools kept their TVL and its positions stayed valued as listed.
//
// Pure (no NestJS) so the pools sync, the position path, the repositories and
// the specs all evaluate the identical rule. `TokenTrustService` adds the
// per-process cache of stored verdicts the synchronous callers read.

import { isAnchorTokenStandalone } from './pricing-policy.js';
import { isAllowlisted } from './token-allowlist.js';
import { CONSENSUS_AGREE_RATIO } from './quote-consensus.js';

export type TokenTrustMode = 'allowlist' | 'earned' | 'combined';

/** Why a token is (not) trusted. Stable strings: the impact report reads them. */
export type TokenTrustReason =
  | 'anchor'
  | 'allowlist'
  | 'earned'
  | 'denied'
  | 'not-allowlisted'
  | 'no-evidence'
  | 'stale-verdict'
  | EarnedTrustFailure;

/** The earned-trust criterion that failed (first in evaluation order). */
export type EarnedTrustFailure = 'stale-quote' | 'single-source' | 'no-dex-market' | 'single-pool';

export interface TokenTrustVerdict {
  trusted: boolean;
  reason: TokenTrustReason;
  mode: TokenTrustMode;
}

/** The trust fields of a `{chainId}_tokens` document (all optional; absent = no evidence). */
export interface StoredTokenTrust {
  trustEarned?: boolean;
  trustReason?: string;
  trustEvaluatedAt?: Date;
  /** Operator kill switch (set by hand in Mongo): never trusted while true — `earned` / `combined` only (see the header). */
  trustDenied?: boolean;
}

/** Everything the trust rule and the quote guard read from config, resolved once. */
export interface TrustPolicy {
  mode: TokenTrustMode;
  /** `TOKEN_TRUST_SHADOW=on`: compute + store earned verdicts while `mode` stays as set. */
  shadow: boolean;
  /** `PRICE_QUOTE_GUARD=on`: reject stale / thin provider quotes (fix 1). */
  quoteGuard: boolean;
  /** `PRICE_QUOTE_MAX_AGE_MS`: oldest provider quote accepted; also earned trust's (d) and its verdict lifetime. */
  quoteMaxAgeMs: number;
  /** `PRICE_DIA_MIN_VOLUME_USD`: a DIA quote with less 24h volume is thin (rejected under the guard). */
  priceDiaMinVolumeUsd: number;
  /** `TOKEN_TRUST_DENY`: `chainId:address` / bare `address` (every chain), lowercased. */
  deny: ReadonlySet<string>;
  /** Earned (c): DEX pools, each with real counter-side liquidity ≥ `perPoolCounterUsd`. */
  minPools: number;
  /** Earned (c): counter-side liquidity outside the deepest pool. */
  minOutsideCounterUsd: number;
  /** Earned (c), single-pool exception: the deepest pool's counter-side liquidity (0 = off). */
  deepPoolCounterUsd: number;
  /** Earned (c), single-pool exception: that pool's counter side as a share of its headline liquidity. */
  deepPoolMinCounterShare: number;
  /**
   * A DEX pool counts toward (c) — the pool count AND the liquidity outside the
   * deepest pool — only with at least this much counter-side liquidity (USD)
   * and a counter side of at least `deepPoolMinCounterShare` of its headline
   * liquidity (`TOKEN_TRUST_MIN_POOL_LIQUIDITY_USD`, default $10,000). The DEX
   * market floor ($1,000) was too cheap: two self-seeded $1k pools next to a
   * single-sided launch pool earned trust for ~$2k.
   */
  perPoolCounterUsd: number;
}

export const DEFAULT_QUOTE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_DIA_MIN_VOLUME_USD = 1_000;
export const DEFAULT_TRUST_MIN_POOLS = 2;
export const DEFAULT_TRUST_MIN_OUTSIDE_COUNTER_USD = 50_000;
export const DEFAULT_TRUST_DEEP_POOL_COUNTER_USD = 250_000;
export const DEFAULT_TRUST_DEEP_POOL_MIN_SHARE = 0.25;
export const DEFAULT_TRUST_MIN_POOL_COUNTER_USD = 10_000;

const policyCache = new WeakMap<object, TrustPolicy>();

/**
 * Resolve the trust policy from `AppConfigService` (duck-typed: a getter that
 * does not exist yet reads as its default, which is today's behaviour). Cached
 * per config object — specs pass fresh literals, production one instance.
 */
export function trustPolicyOf(config: unknown): TrustPolicy {
  if (config && typeof config === 'object') {
    const hit = policyCache.get(config);
    if (hit) return hit;
  }
  const c = (config ?? {}) as Record<string, unknown>;
  const policy: TrustPolicy = {
    mode: parseMode(c.tokenTrustMode),
    shadow: onFlag(c.tokenTrustShadow),
    quoteGuard: onFlag(c.priceQuoteGuard),
    quoteMaxAgeMs: positive(c.priceQuoteMaxAgeMs, DEFAULT_QUOTE_MAX_AGE_MS),
    priceDiaMinVolumeUsd: nonNegative(c.priceDiaMinVolumeUsd, DEFAULT_DIA_MIN_VOLUME_USD),
    deny: parseDenyList(c.tokenTrustDeny),
    minPools: Math.max(1, Math.floor(positive(c.tokenTrustMinPools, DEFAULT_TRUST_MIN_POOLS))),
    minOutsideCounterUsd: nonNegative(c.tokenTrustMinOutsideLiquidityUsd, DEFAULT_TRUST_MIN_OUTSIDE_COUNTER_USD),
    deepPoolCounterUsd: nonNegative(c.tokenTrustDeepPoolLiquidityUsd, DEFAULT_TRUST_DEEP_POOL_COUNTER_USD),
    deepPoolMinCounterShare: DEFAULT_TRUST_DEEP_POOL_MIN_SHARE,
    perPoolCounterUsd: nonNegative(c.tokenTrustMinPoolLiquidityUsd, DEFAULT_TRUST_MIN_POOL_COUNTER_USD),
  };
  if (config && typeof config === 'object') policyCache.set(config, policy);
  return policy;
}

/**
 * True in the modes whose trust answer reads STORED verdicts (`earned`,
 * `combined`): the sweep must compute them, the readers must load them
 * (`TokenTrustService.warm`, the pricing layer's market-state read), the
 * `trustDenied` flag is honoured, and the pools sync cross-checks a non-anchor
 * leg against the pool's own price. `allowlist` (default) reads none of it —
 * today's rule needs no I/O. Every "does this mode use the stored trust
 * fields" decision asks this, so a new mode cannot be half-wired.
 */
export function usesStoredVerdicts(policy: TrustPolicy): boolean {
  return policy.mode !== 'allowlist';
}

/** True when the sweep must compute + store earned-trust evidence (shadow, or a mode that reads it). */
export function trustEvidenceOn(policy: TrustPolicy): boolean {
  return policy.shadow || usesStoredVerdicts(policy);
}

/** True when quote provenance (source, quote time, would-be-rejected) is stored. */
export function quoteEvidenceOn(policy: TrustPolicy): boolean {
  return trustEvidenceOn(policy) || policy.quoteGuard;
}

/**
 * `TOKEN_TRUST_DENY`: comma / whitespace separated `chainId:0x…` or bare
 * `0x…` (every chain). Anything else is ignored (it can only ever deny, so a
 * malformed entry denying nothing is the safe failure).
 */
export function parseDenyList(raw: unknown): ReadonlySet<string> {
  const out = new Set<string>();
  const items = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.split(/[\s,]+/) : [];
  for (const item of items) {
    const v = item.trim().toLowerCase();
    if (!v) continue;
    const m = /^(?:(\d+):)?(0x[0-9a-f]{40})$/.exec(v);
    if (!m) continue;
    out.add(m[1] ? `${m[1]}:${m[2]}` : `*:${m[2]}`);
  }
  return out;
}

export function isDenied(policy: TrustPolicy, chainId: number, address: string, stored?: StoredTokenTrust | null): boolean {
  // The Mongo flag: only the modes that load stored verdicts (header) — one
  // answer per mode.
  if (usesStoredVerdicts(policy) && stored?.trustDenied === true) return true;
  if (policy.deny.size === 0) return false;
  const a = address.toLowerCase();
  return policy.deny.has(`${chainId}:${a}`) || policy.deny.has(`*:${a}`);
}

/**
 * THE trust rule. `stored` is the token's stored trust evidence (undefined =
 * not loaded / no document). Anchors are always trusted (config, not data — to
 * remove an anchor, edit `chains.config`). `now` is injectable for specs.
 */
export function resolveTokenTrust(
  chainId: number,
  address: string,
  stored: StoredTokenTrust | null | undefined,
  policy: TrustPolicy,
  now: number = Date.now(),
): TokenTrustVerdict {
  const mode = policy.mode;
  const a = address.toLowerCase();
  if (isAnchorTokenStandalone(chainId, a)) return { trusted: true, reason: 'anchor', mode };
  if (isDenied(policy, chainId, a, stored)) return { trusted: false, reason: 'denied', mode };
  if (mode === 'allowlist') {
    return isAllowlisted(chainId, a)
      ? { trusted: true, reason: 'allowlist', mode }
      : { trusted: false, reason: 'not-allowlisted', mode };
  }
  const earned = earnedVerdict(stored, policy, now);
  if (mode === 'earned' || earned.trusted) return { ...earned, mode };
  // `combined`: the earned verdict is checked FIRST so a listed token that has
  // also earned trust reports `earned` — the stronger, evidence-backed fact
  // (`PricingService.legCorroborated` counts it as corroboration). Otherwise
  // the allowlist alone confers trust, exactly as in `allowlist` mode; a
  // token that is neither carries the earned failure (as in `earned` mode).
  if (isAllowlisted(chainId, a)) return { trusted: true, reason: 'allowlist', mode };
  return { ...earned, mode };
}

/** The stored earned verdict as the rule reads it (anchor + deny already handled by the caller). */
function earnedVerdict(
  stored: StoredTokenTrust | null | undefined,
  policy: TrustPolicy,
  now: number,
): { trusted: boolean; reason: TokenTrustReason } {
  if (!stored || typeof stored.trustEarned !== 'boolean') return { trusted: false, reason: 'no-evidence' };
  const checkedAt = stored.trustEvaluatedAt instanceof Date ? stored.trustEvaluatedAt.getTime() : NaN;
  // A verdict the sweep has not re-derived within the quote window is revoked:
  // it was built from quotes that are now themselves too old to accept.
  if (!Number.isFinite(checkedAt) || now - checkedAt > policy.quoteMaxAgeMs) {
    return { trusted: false, reason: 'stale-verdict' };
  }
  if (stored.trustEarned) return { trusted: true, reason: 'earned' };
  return { trusted: false, reason: asFailure(stored.trustReason) };
}

function asFailure(reason: string | undefined): EarnedTrustFailure {
  return reason === 'stale-quote' || reason === 'single-source' || reason === 'no-dex-market' || reason === 'single-pool'
    ? reason
    : 'single-source';
}

// ─── Earned trust (computed by the consensus sweep) ───────────────────────────

/** Market evidence for one token, gathered by one consensus sweep. */
export interface EarnedTrustEvidence {
  /** (a) ≥ 2 sources agree (`reconcileQuotes` → 'consensus') using FRESH quotes only. */
  freshConsensus: boolean;
  /** Consensus held only when stale quotes were counted → the failure is `stale-quote`, not `single-source`. */
  consensusNeedsStale: boolean;
  /** (b) the existing active-market verdict (`dexActive`): true / false / undefined (not covered). */
  dexActive: boolean | undefined;
  /** (c) DEX pools with counter-side liquidity ≥ the per-pool floor. */
  dexPoolCount: number;
  /** (c) counter-side liquidity (USD) in pools other than the deepest one. */
  dexOutsideLiquidityUsd: number;
  /** (c) the deepest pool's counter-side liquidity (USD). */
  dexTopCounterUsd: number;
  /** (c) the deepest pool's counter side as a share of its headline liquidity (0..1). */
  dexTopCounterShare: number;
  /**
   * (a) + (c) the agreeing fresh sources include a non-DEX aggregator.
   * DexScreener and GeckoTerminal read the SAME on-chain pools, so two of them
   * agreeing is one on-chain source, not two independent ones.
   */
  hasNonDexSource: boolean;
}

export interface EarnedTrustResult {
  earned: boolean;
  reason: 'earned' | EarnedTrustFailure;
}

/**
 * The earned-trust criteria, ALL required, checked in this order (the first
 * failure is the stored reason):
 *  (d)+(a) fresh consensus — ≥ 2 independent sources within 10% using only
 *      quotes younger than `PRICE_QUOTE_MAX_AGE_MS`, at least one of them a
 *      non-DEX aggregator (DexScreener + GeckoTerminal agreeing is ONE on-chain
 *      source; pool-derived subgraph sources never vote — the sweep excludes
 *      them);
 *  (b) a real active DEX market (`dexActive`: DEX source + 24h volume +
 *      counter-side liquidity floors);
 *  (c) the market is not one pool: ≥ `minPools` pools each with ≥
 *      `perPoolCounterUsd` of counter-side liquidity AND a balanced counter
 *      side (≥ `deepPoolMinCounterShare` of the pool — a single-sided seed does
 *      not count), OR ≥ `minOutsideCounterUsd` of such counter-side liquidity
 *      outside the deepest pool, OR — the single-pool exception — the deepest pool
 *      alone holds ≥ `deepPoolCounterUsd` of counter-side liquidity, its
 *      counter side is ≥ `deepPoolMinCounterShare` of the pool (not a
 *      single-sided seed) and a non-DEX aggregator is among the agreeing
 *      sources (the price is not only read off that pool).
 */
export function evaluateEarnedTrust(e: EarnedTrustEvidence, policy: TrustPolicy): EarnedTrustResult {
  if (!e.freshConsensus) return { earned: false, reason: e.consensusNeedsStale ? 'stale-quote' : 'single-source' };
  // DEX-only agreement is one on-chain source (both read the same pools).
  if (!e.hasNonDexSource) return { earned: false, reason: 'single-source' };
  if (e.dexActive !== true) return { earned: false, reason: 'no-dex-market' };
  const multiPool = e.dexPoolCount >= policy.minPools;
  const outside = e.dexOutsideLiquidityUsd >= policy.minOutsideCounterUsd && policy.minOutsideCounterUsd > 0;
  const deepSingle =
    policy.deepPoolCounterUsd > 0 &&
    e.dexTopCounterUsd >= policy.deepPoolCounterUsd &&
    e.dexTopCounterShare >= policy.deepPoolMinCounterShare &&
    e.hasNonDexSource;
  if (!multiPool && !outside && !deepSingle) return { earned: false, reason: 'single-pool' };
  return { earned: true, reason: 'earned' };
}

/** One DEX pool's counter-side liquidity (already in USD) and headline liquidity. */
export interface DexPoolLiquidity {
  id: string;
  counterUsd: number;
  liquidityUsd: number;
}

/**
 * Fold a token's DEX pools into the (c) evidence numbers. A pool COUNTS (pool
 * count, liquidity outside the deepest pool) only when its counter side clears
 * `perPoolCounterUsd` AND is at least `minCounterShare` of the pool's headline
 * liquidity — a single-sided seed (MOW: $1,050 of counter in an $11.9M pool) or
 * a dust pool proves nothing about a market. An unknown headline (0) fails the
 * share test. The deepest pool (`dexTop*`) is reported whatever it is: the
 * single-pool exception applies its own share test to it.
 */
export function summarizeDexPools(
  pools: readonly DexPoolLiquidity[],
  perPoolCounterUsd: number,
  minCounterShare: number = DEFAULT_TRUST_DEEP_POOL_MIN_SHARE,
): Pick<EarnedTrustEvidence, 'dexPoolCount' | 'dexOutsideLiquidityUsd' | 'dexTopCounterUsd' | 'dexTopCounterShare'> & { dexTopPoolId?: string } {
  let top: DexPoolLiquidity | undefined;
  let total = 0;
  let count = 0;
  let topCounts = false;
  const seen = new Set<string>();
  for (const p of pools) {
    const id = p.id.toLowerCase();
    if (seen.has(id)) continue;
    seen.add(id);
    const c = Number.isFinite(p.counterUsd) && p.counterUsd > 0 ? p.counterUsd : 0;
    const liq = Number.isFinite(p.liquidityUsd) && p.liquidityUsd > 0 ? p.liquidityUsd : 0;
    const counts = c > 0 && c >= perPoolCounterUsd && liq > 0 && c / liq >= minCounterShare;
    if (counts) {
      total += c;
      count += 1;
    }
    if (!top || c > top.counterUsd) {
      top = { ...p, counterUsd: c };
      topCounts = counts;
    }
  }
  const topCounter = top?.counterUsd ?? 0;
  const topLiq = top && Number.isFinite(top.liquidityUsd) && top.liquidityUsd > 0 ? top.liquidityUsd : 0;
  return {
    dexPoolCount: count,
    dexOutsideLiquidityUsd: Math.max(0, total - (topCounts ? topCounter : 0)),
    dexTopCounterUsd: topCounter,
    dexTopCounterShare: topLiq > 0 ? Math.min(1, topCounter / topLiq) : 0,
    dexTopPoolId: top?.id.toLowerCase(),
  };
}

// ─── Quote guard (fix 1) ──────────────────────────────────────────────────────

export type QuoteRejection = 'stale' | 'thin';

/**
 * Would the quote guard reject this provider quote? `stale` = the provider
 * dated it (DIA `Time`, DeFiLlama `timestamp`) and it is older than
 * `quoteMaxAgeMs`; `thin` = a DIA quote with under `priceDiaMinVolumeUsd` of 24h
 * volume (DIA's stale quotes come with ~$0 volume — HPP: $0.098/day). A quote
 * with no timestamp is a live API answer and is never stale. Pure: callers
 * decide whether the guard is on (reject) or only shadowing (record).
 */
export function quoteRejection(
  quote: { quotedAtMs?: number; volume24hUsd?: number },
  providerName: string,
  policy: TrustPolicy,
  now: number = Date.now(),
): QuoteRejection | null {
  const at = quote.quotedAtMs;
  if (typeof at === 'number' && Number.isFinite(at) && now - at > policy.quoteMaxAgeMs) return 'stale';
  if (providerName === 'dia' && policy.priceDiaMinVolumeUsd > 0) {
    const vol = typeof quote.volume24hUsd === 'number' && Number.isFinite(quote.volume24hUsd) ? quote.volume24hUsd : 0;
    if (vol < policy.priceDiaMinVolumeUsd) return 'thin';
  }
  return null;
}

// ─── Pool cross-check (earned + combined modes, pools sync) ───────────────────

/**
 * Does the pool's own price agree with the two legs' market prices within the
 * consensus ratio (10%)? `ratio` = token1 per token0 (human units), so the
 * pool says 1 token0 = `ratio` token1 = `ratio × price1` USD. Unknown inputs
 * (a zero price, an unusable ratio) are NOT a disagreement — the caller's
 * other gates handle missing prices.
 */
export function poolPriceAgrees(price0: number, price1: number, ratio: number, agreeRatio: number = CONSENSUS_AGREE_RATIO): boolean {
  if (!(price0 > 0) || !(price1 > 0) || !(ratio > 0) || !Number.isFinite(ratio)) return true;
  const implied0 = ratio * price1;
  if (!(implied0 > 0) || !Number.isFinite(implied0)) return true;
  const hi = Math.max(implied0, price0);
  const lo = Math.min(implied0, price0);
  return hi / lo <= agreeRatio;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function lower(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}
/** `TOKEN_TRUST_MODE`, any case; anything unrecognised is today's `allowlist`. */
function parseMode(v: unknown): TokenTrustMode {
  const m = lower(v);
  return m === 'earned' || m === 'combined' ? m : 'allowlist';
}
function onFlag(v: unknown): boolean {
  return v === true || lower(v) === 'on' || lower(v) === 'true';
}
function positive(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
function nonNegative(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
