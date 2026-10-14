import { Inject, Injectable } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service.js';
import { getChainConfig } from '../../config/chains.config.js';
import { BaseProvider } from './base-provider.js';
import { trustPolicyOf } from '../token-trust.js';
import type { CurrentBatchCoverage, DexPairSummary, HistoricalReq, PriceQuote, TokenPairEvidence } from './price-provider.interface.js';
import { providerAddressKey } from './price-provider.interface.js';

const TOKENS_URL = 'https://api.dexscreener.com/latest/dex/tokens';
// The per-chain batch (`DEXSCREENER_BATCH_ENDPOINT=per-chain`): same 30-address
// limit, a JSON ARRAY of pairs (not `{pairs}`), the same pair shape. Probed
// 2026-10-05: 30 Avalanche tokens → 30 pairs over 30 distinct BASE tokens, at
// most one per token. The /latest endpoint over the same 30 tokens answered 30
// pairs over only 5 tokens. The one pair is DexScreener's OWN pick among the
// token's base-side pairs — activity-weighted (roughly the most trades above
// some liquidity floor), NOT the deepest: re-probed the same day, WETH answered
// a $7.1M pool beside a $111M one, WBTC $27M beside $70M, UNI $179k beside
// $218M (long-tail tokens got their deepest pair every time). So the price,
// counter side and 24h volume are that ONE pair's, and the consensus sweep
// checks a floor failure on it against the token's own pairs before it bakes
// "no real market". A token with no base-side pair is NOT simply absent: it can
// come back as the QUOTE side of another token's pair (USDG on 4663 → its
// AI/USDG pair; asked together with AI, that same pair twice). It is still no
// quote for it (the parse keys on the base token), and a repeated pair is
// counted once (`uniquePairs`).
const PER_CHAIN_TOKENS_URL = 'https://api.dexscreener.com/tokens/v1';
// Every pair of ONE token on ONE chain (both orientations). Probed 2026-10-05:
// a JSON array, capped at 30 pairs, not sorted by liquidity; BTC.b on
// Ethereum answers its one v4 pool, WBTC answers 30.
const TOKEN_PAIRS_URL = 'https://api.dexscreener.com/token-pairs/v1';
// Both endpoints return at most this many pairs. The batch endpoint applies it
// to the WHOLE request — every address, every chain — so a full answer is a
// sample (live 2026-10-05: /tokens/BTC.b,cbBTC = 30 pairs, none on Ethereum).
export const DEXSCREENER_RESPONSE_PAIR_CAP = 30;
// DexScreener accepts a comma-separated list of token addresses (up to ~30).
const MAX_BATCH = 30;
// At most this many pairs per token travel on the quote (deepest first) — the
// earned-trust evidence needs the pool count and the liquidity outside the
// deepest pool, not every dust pair a launchpad mints.
export const DEX_PAIRS_MAX = 20;

// DexScreener `chainId` strings. Add chains as we enable them.
export const DEXSCREENER_CHAIN: Record<number, string> = {
  1: 'ethereum',
  43114: 'avalanche',
  // Verified live: pairs for Arbitrum tokens return chainId 'arbitrum'.
  42161: 'arbitrum',
  // Probed 2026-09-02: tokens/<WETH on 4663> returns 30 pairs, all chainId
  // 'robinhood', across 14 dexIds; pairs/robinhood/<v4 pool id> resolves with
  // labels:["v4"], so v4 pools are indexed and not just v2/v3.
  4663: 'robinhood',
};

export interface DexPair {
  chainId?: string;
  pairAddress?: string;
  priceUsd?: string;
  liquidity?: { usd?: number; base?: number; quote?: number };
  volume?: { h24?: number };
  baseToken?: { address?: string };
  quoteToken?: { address?: string };
}
interface DexResponse {
  pairs?: DexPair[] | null;
}

/**
 * DexScreener price provider — free, no auth. Covers DEX-only / CoinGecko-
 * delisted tokens that aggregators miss (e.g. RPC). Picks the HIGHEST-liquidity
 * pair on the chain for each token as the price (per-chain mode: the one pair
 * DexScreener answers, its own pick). This is a DEX-derived quote
 * (one venue), so for an unlisted token it's an independent CORROBORATING
 * source for consensus — NOT a trust anchor on its own, and still subject to
 * the realizability gate (its `liquidity.usd` is the both-sides headline, not
 * the real exit reserve).
 */
@Injectable()
export class DexScreenerProvider extends BaseProvider {
  readonly name = 'dexscreener';
  readonly supportsCurrentBatch = true;
  readonly supportsHistoricalBatch = false;
  readonly maxBatchSize = MAX_BATCH;
  readonly singleConcurrency: number;
  readonly defaultBackoffMs = 30_000;
  /** Per-token pair evidence (`getTokenPairs`), kept well inside the quote window. */
  private readonly pairCache = new Map<string, { value: TokenPairEvidence; expiresAt: number }>();

  constructor(@Inject(AppConfigService) private readonly config: AppConfigService) {
    super({
      name: 'DexScreenerProvider',
      maxConcurrency: Math.max(1, config.pricingProviderMaxConcurrency),
      defaultBackoffMs: 30_000,
    });
    this.singleConcurrency = Math.max(1, config.pricingHistoricalSingleConcurrency);
  }

  isEnabled(): boolean {
    return true;
  }

  async getCurrentBatch(chainId: number, addresses: string[]): Promise<Map<string, PriceQuote>> {
    return (await this.fetchCurrentBatch(chainId, addresses)).quotes;
  }

  /**
   * `getCurrentBatch` plus the addresses its answer cannot vouch for. A
   * requested token with no quote is a definite "no base-side pair here" ONLY
   * when DexScreener answered healthily AND below the pair cap. In a capped
   * answer (≥ 30 pairs) the missing tokens may just have been crowded out
   * (latest: WAVAX's pairs fill the request; per-chain: 30 tokens, 30 pairs),
   * and an answer that never came (skipped, rate-limited, failed, unsupported
   * chain) proves nothing about any of them: all such tokens are `uncertain`.
   * The request and the quotes are exactly `getCurrentBatch`'s.
   */
  async getCurrentBatchWithCoverage(chainId: number, addresses: string[]): Promise<CurrentBatchCoverage> {
    return this.fetchCurrentBatch(chainId, addresses);
  }

  /**
   * `DEXSCREENER_BLIND_CHAINS` (default Arbitrum): DexScreener cannot see the
   * chain's v4 pools, so its silence about a token proves nothing. Read
   * structurally so a spec config without the getter is today's behaviour.
   */
  private isBlind(chainId: number): boolean {
    const blind = (this.config as { dexscreenerBlindChains?: ReadonlySet<number> } | undefined)?.dexscreenerBlindChains;
    return blind instanceof Set && blind.has(chainId);
  }

  private async fetchCurrentBatch(chainId: number, addresses: string[]): Promise<CurrentBatchCoverage> {
    const result = new Map<string, PriceQuote>();
    const lowers = addresses.map((a) => a.toLowerCase());
    // Until a healthy answer says otherwise, nobody's absence is known (a quote
    // already set before a throw is still a quote, never "uncertain").
    const unanswered = (): CurrentBatchCoverage => ({
      quotes: result,
      uncertain: new Set(lowers.filter((a) => !result.has(providerAddressKey(chainId, a)))),
    });
    const dexChain = DEXSCREENER_CHAIN[chainId];
    if (!dexChain || !getChainConfig(chainId) || addresses.length === 0) return unanswered();
    if (!this.isAvailable()) {
      this.recordOutcome('skip');
      return unanswered();
    }
    // `latest` (default) = today's request, byte for byte; `per-chain` asks the
    // chain's own endpoint, which answers one pair per token (see the URL).
    const perChain = this.config.dexscreenerBatchEndpoint === 'per-chain';
    const url = perChain ? `${PER_CHAIN_TOKENS_URL}/${dexChain}/${lowers.join(',')}` : `${TOKENS_URL}/${lowers.join(',')}`;
    await this.acquireSlot();
    try {
      const res = await this.httpJson<DexResponse | DexPair[]>(url, { bodyTimeoutMs: 10_000, headersTimeoutMs: 10_000 });
      if (res.statusCode === 429 || res.statusCode >= 500) {
        this.markRateLimited(res.retryAfterMs, res.statusCode);
        return unanswered();
      }
      if (res.statusCode !== 200 || !res.data || (perChain && !Array.isArray(res.data))) {
        this.recordOutcome('error');
        return unanswered();
      }
      // Highest-liquidity pair per base token on this chain.
      const rawPairs = perChain ? (res.data as DexPair[]) : ((res.data as DexResponse).pairs ?? []);
      // per-chain: a pair answered for two requested tokens (its base token,
      // and a quote-only token it is the answer for) arrives twice — summing
      // its volume twice would double it. latest: today's parse, untouched.
      const bestByAddr = pickBestPairs(perChain ? uniquePairs(rawPairs) : rawPairs, dexChain);
      // A capped answer is a sample of the request's pairs (see the cap). On
      // the RAW length: a repeated pair still took one of the 30 slots.
      const capped = rawPairs.length >= DEXSCREENER_RESPONSE_PAIR_CAP;
      // per-chain: ONE pair per token by construction (DexScreener's pick, not
      // necessarily the deepest), never every pair, so earned trust looks a
      // token's own pairs up when one pair would fail (c), and the sweep does
      // the same before a floor failure on that pair becomes "no market". Its
      // 24h volume is that one pair's, not the sum over the token's pairs.
      const pairsComplete = !perChain && !capped;
      const uncertain = new Set<string>();
      const unseen = new Set<string>();
      const blind = this.isBlind(chainId);
      for (const addr of lowers) {
        const best = bestByAddr.get(addr);
        if (best && best.price > 0) {
          result.set(providerAddressKey(chainId, addr), {
            priceUsd: best.price,
            source: 'dexscreener',
            // Activity signals for the active-market gate (real market vs dead
            // seeded pool). counter-side = the quote-token reserve, in QUOTE-TOKEN
            // UNITS (not USD) — the consensus sweep converts via the counter
            // token's own price (`counterTokenAddress`).
            volume24hUsd: best.volume24h,
            counterLiquidity: best.counter,
            counterTokenAddress: best.counterToken,
            dexPairs: best.pairs.length > 0 ? best.pairs : undefined,
            dexPairsComplete: pairsComplete,
          });
          this.recordOutcome('success');
        } else {
          this.recordOutcome('miss');
          // A blind chain: no pair here is not "no market" — see `isBlind`.
          if (blind) unseen.add(addr);
          else if (capped) uncertain.add(addr);
        }
      }
      return unseen.size > 0 ? { quotes: result, uncertain, unseen } : { quotes: result, uncertain };
    } catch (error) {
      this.logger.error(`dexscreener batch failed for ${addresses.length} tokens: ${error}`);
      this.recordOutcome('error');
      return unanswered();
    } finally {
      this.releaseSlot();
    }
  }

  async getCurrentSingle(chainId: number, address: string): Promise<PriceQuote | null> {
    const batch = await this.getCurrentBatch(chainId, [address]);
    return batch.get(providerAddressKey(chainId, address.toLowerCase())) ?? null;
  }

  /**
   * Every pair of one token on one chain, for earned trust's "not one pool"
   * evidence when the batch answer was a capped sample. Both orientations: the
   * counter side is the OTHER token's reserve. Cached for a quarter of the
   * quote window (`PRICE_QUOTE_MAX_AGE_MS`), so a verdict re-derived every
   * sweep asks at most a few times a day per token. `refresh` skips the cached
   * answer and asks again (a failed request keeps the cached one). null = no
   * answer.
   */
  async getTokenPairs(chainId: number, address: string, opts?: { refresh?: boolean }): Promise<TokenPairEvidence | null> {
    const dexChain = DEXSCREENER_CHAIN[chainId];
    if (!dexChain || !getChainConfig(chainId)) return null;
    // A blind chain has no pair evidence to give; "no answer" keeps every
    // caller on its unanswered path (no verdict) and sends no request.
    if (this.isBlind(chainId)) return null;
    const lower = address.toLowerCase();
    const key = `${chainId}:${lower}`;
    const now = Date.now();
    const hit = opts?.refresh ? undefined : this.cachedTokenPairs(chainId, lower);
    if (hit) return hit;
    if (!this.isAvailable()) {
      this.recordOutcome('skip');
      return null;
    }
    await this.acquireSlot();
    try {
      const res = await this.httpJson<DexPair[]>(`${TOKEN_PAIRS_URL}/${dexChain}/${lower}`, {
        bodyTimeoutMs: 10_000,
        headersTimeoutMs: 10_000,
      });
      if (res.statusCode === 429 || res.statusCode >= 500) {
        this.markRateLimited(res.retryAfterMs, res.statusCode);
        return null;
      }
      if (res.statusCode !== 200 || !Array.isArray(res.data)) {
        this.recordOutcome('error');
        return null;
      }
      // The batch parse over the same pairs (base side only, volume summed,
      // the deepest pair's counter) — what latest mode's earned trust reads a
      // sampled token's market as; and the same over both orientations —
      // what per-chain mode reads (`TokenPairEvidence.market`).
      const unique = uniquePairs(res.data);
      const own = pickBestPairs(unique, dexChain).get(lower);
      const value: TokenPairEvidence = {
        pairs: pairsOfToken(res.data, dexChain, lower),
        complete: res.data.length < DEXSCREENER_RESPONSE_PAIR_CAP,
        base: own ? { volume24hUsd: own.volume24h, counterLiquidity: own.counter, counterTokenAddress: own.counterToken } : undefined,
        market: marketOfToken(unique, dexChain, lower),
        fetchedAt: now,
      };
      const ttl = Math.max(5 * 60_000, Math.floor(trustPolicyOf(this.config).quoteMaxAgeMs / 4));
      this.pairCache.set(key, { value, expiresAt: now + ttl });
      if (this.pairCache.size > 20_000) {
        for (const [k, v] of this.pairCache) if (v.expiresAt <= now) this.pairCache.delete(k);
      }
      this.recordOutcome('success');
      return value;
    } catch (error) {
      this.logger.error(`dexscreener token-pairs failed for ${lower}: ${error}`);
      this.recordOutcome('error');
      return null;
    } finally {
      this.releaseSlot();
    }
  }

  /**
   * `getTokenPairs`'s cached answer while it is fresh, else undefined — no
   * request, no outcome recorded. The consensus sweep's per-sweep lookup
   * budget charges only a lookup that would go to the network: charging a
   * cache hit let the same first ~100 tokens of a batch spend the budget every
   * sweep (their answers cost DexScreener nothing after the first) while the
   * rest never got a lookup, so never a verdict.
   */
  cachedTokenPairs(chainId: number, address: string): TokenPairEvidence | undefined {
    const hit = this.pairCache.get(`${chainId}:${address.toLowerCase()}`);
    return hit && hit.expiresAt > Date.now() ? hit.value : undefined;
  }

  // DexScreener has no historical endpoint we use.
  async getHistoricalSingle(_request: HistoricalReq): Promise<PriceQuote | null> {
    return null;
  }
}

/**
 * Pairs de-duplicated by `chainId:pairAddress` (first copy kept; a pair with
 * no address is kept as is — nothing to compare it by; a non-object entry is
 * dropped). The per-chain batch answers a quote-only token with another
 * token's pair, which is also that token's own answer when both are asked
 * (USDG/AI on 4663: the same pair twice), and `pickBestPairs` sums 24h volume
 * per pair it sees. Never applied to a /latest answer (today's parse).
 */
export function uniquePairs(pairs: DexPair[]): DexPair[] {
  const seen = new Set<string>();
  const out: DexPair[] = [];
  for (const p of pairs) {
    if (!p || typeof p !== 'object') continue;
    const id = p.pairAddress ? `${p.chainId}:${p.pairAddress.toLowerCase()}` : undefined;
    if (id !== undefined) {
      if (seen.has(id)) continue;
      seen.add(id);
    }
    out.push(p);
  }
  return out;
}

/**
 * A token's pairs on one chain from a per-token answer, either orientation:
 * the counter side is the other token's reserve (in that token's units).
 * De-duplicated by pair id, deepest headline first.
 */
export function pairsOfToken(pairs: DexPair[], dexChain: string, address: string): DexPairSummary[] {
  const out = new Map<string, DexPairSummary>();
  for (const p of pairs) {
    if (p?.chainId !== dexChain || !p.pairAddress) continue;
    const base = p.baseToken?.address?.toLowerCase();
    const quote = p.quoteToken?.address?.toLowerCase();
    let counter: number;
    let counterToken: string | undefined;
    if (base === address) {
      counter = Number(p.liquidity?.quote ?? 0);
      counterToken = quote;
    } else if (quote === address) {
      counter = Number(p.liquidity?.base ?? 0);
      counterToken = base;
    } else continue;
    const liq = Number(p.liquidity?.usd ?? 0);
    const id = p.pairAddress.toLowerCase();
    if (out.has(id)) continue;
    out.set(id, {
      id,
      liquidityUsd: Number.isFinite(liq) ? liq : 0,
      counterLiquidity: Number.isFinite(counter) ? counter : 0,
      counterTokenAddress: counterToken,
    });
  }
  return [...out.values()].sort((x, y) => y.liquidityUsd - x.liquidityUsd);
}

/**
 * A token's DEX market over every pair it is in on one chain, EITHER
 * orientation (`TokenPairEvidence.market`): 24h volume summed over the pairs,
 * and the deepest pair's (headline liquidity; the first one on a tie, as in
 * `pickBestPairs`) counter side — the other token's reserve, in its units.
 * Only pairs with a positive price count, as in the batch parse. Pairs must
 * already be unique (`uniquePairs`), or a repeat would count its volume twice.
 * undefined = no such pair.
 */
export function marketOfToken(pairs: DexPair[], dexChain: string, address: string): TokenPairEvidence['market'] {
  let volume = 0;
  let deepest: { liq: number; counter: number; counterToken?: string } | undefined;
  for (const p of pairs) {
    if (p?.chainId !== dexChain) continue;
    const price = Number(p.priceUsd);
    if (!Number.isFinite(price) || price <= 0) continue;
    const base = p.baseToken?.address?.toLowerCase();
    const quote = p.quoteToken?.address?.toLowerCase();
    let counter: number;
    let counterToken: string | undefined;
    if (base === address) {
      counter = Number(p.liquidity?.quote ?? 0);
      counterToken = quote;
    } else if (quote === address) {
      counter = Number(p.liquidity?.base ?? 0);
      counterToken = base;
    } else continue;
    const vol = Number(p.volume?.h24 ?? 0);
    volume += Number.isFinite(vol) ? vol : 0;
    const rawLiq = Number(p.liquidity?.usd ?? 0);
    const liq = Number.isFinite(rawLiq) ? rawLiq : 0;
    if (!deepest || liq > deepest.liq) deepest = { liq, counter: Number.isFinite(counter) ? counter : 0, counterToken };
  }
  return deepest ? { volume24hUsd: volume, counterLiquidity: deepest.counter, counterTokenAddress: deepest.counterToken } : undefined;
}

interface BestPair {
  price: number;
  liq: number;
  volume24h: number;
  counter: number;
  counterToken?: string;
  /** Every pair of the token on the chain, deepest (headline liquidity) first, capped at `DEX_PAIRS_MAX`. */
  pairs: DexPairSummary[];
}

/**
 * address(lower) → highest-liquidity pair on the given DexScreener chain, with
 * its price + activity signals (24h volume, counter-side reserve). 24h volume is
 * SUMMED across the token's pairs on the chain (total traded activity), while
 * price/counter come from the single highest-liquidity pair.
 */
function pickBestPairs(pairs: DexPair[], dexChain: string): Map<string, BestPair> {
  const best = new Map<string, BestPair>();
  for (const p of pairs) {
    if (p.chainId !== dexChain) continue;
    const addr = p.baseToken?.address?.toLowerCase();
    const price = Number(p.priceUsd);
    if (!addr || !Number.isFinite(price) || price <= 0) continue;
    const liq = Number(p.liquidity?.usd ?? 0);
    const vol = Number(p.volume?.h24 ?? 0);
    const counter = Number(p.liquidity?.quote ?? 0);
    const counterToken = p.quoteToken?.address?.toLowerCase();
    const pair: DexPairSummary | undefined = p.pairAddress
      ? {
          id: p.pairAddress.toLowerCase(),
          liquidityUsd: Number.isFinite(liq) ? liq : 0,
          counterLiquidity: Number.isFinite(counter) ? counter : 0,
          counterTokenAddress: counterToken,
        }
      : undefined;
    const cur = best.get(addr);
    if (!cur) {
      best.set(addr, {
        price,
        liq,
        volume24h: Number.isFinite(vol) ? vol : 0,
        counter: Number.isFinite(counter) ? counter : 0,
        counterToken,
        pairs: pair ? [pair] : [],
      });
    } else {
      if (pair) cur.pairs.push(pair);
      // Sum 24h volume across pairs; price/liq/counter/counterToken track the deepest pair.
      cur.volume24h += Number.isFinite(vol) ? vol : 0;
      if (liq > cur.liq) {
        cur.liq = liq;
        cur.price = price;
        cur.counter = Number.isFinite(counter) ? counter : 0;
        cur.counterToken = counterToken;
      }
    }
  }
  for (const b of best.values()) {
    b.pairs.sort((x, y) => y.liquidityUsd - x.liquidityUsd);
    if (b.pairs.length > DEX_PAIRS_MAX) b.pairs.length = DEX_PAIRS_MAX;
  }
  return best;
}
