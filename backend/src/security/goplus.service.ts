import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  TokensRepository,
  isSpamSignals,
  type TokenSecurityRecord,
} from '../database/token.repository.js';
import { isAllowlisted } from '../pricing/token-allowlist.js';
import { isAnchorTokenStandalone } from '../pricing/pricing-policy.js';

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const BATCH_SIZE = 30; // GoPlus accepts comma-separated contract_addresses
const FETCH_TIMEOUT_MS = Math.max(1000, Number(process.env.GOPLUS_TIMEOUT_MS) || 8000);
// Free tier is ~30 req/min — pause between batches so a sweep doesn't get 429'd.
const INTER_BATCH_DELAY_MS = Math.max(0, Number(process.env.GOPLUS_BATCH_DELAY_MS) || 2200);
// GoPlus signals rate-limiting as HTTP 200 with body `code: 4029` (or HTTP
// 429). Instead of failing-open and losing the verdict, BACK OFF and retry the
// SAME batch — the sweep must eventually get a real answer for every token.
const RATELIMIT_MAX_RETRIES = Math.max(0, Number(process.env.GOPLUS_RATELIMIT_RETRIES) || 8);
const RATELIMIT_BASE_BACKOFF_MS = Math.max(500, Number(process.env.GOPLUS_RATELIMIT_BACKOFF_MS) || 3000);
const RATELIMIT_MAX_BACKOFF_MS = Math.max(RATELIMIT_BASE_BACKOFF_MS, Number(process.env.GOPLUS_RATELIMIT_MAX_BACKOFF_MS) || 60000);
const GOPLUS_RATE_LIMIT_CODE = 4029;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GoPlus encodes booleans as the strings '1'/'0'. */
const flag = (v: unknown): boolean => v === '1';
const num = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};
/**
 * GoPlus `fake_token`: an OBJECT `{true_token_address, value}` (absent/null
 * when GoPlus has no opinion), `value` 1 = this contract is a fake of
 * `true_token_address`. Seen live for a fake USDT on chain 1 (0x3173…f752 →
 * Tether's 0xdac1…1ec7) whose four hard flags are all clean. Number or string
 * `1` both count; anything else is not a verdict.
 */
export function fakeTokenFlag(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const value = (v as { value?: unknown }).value;
  return value === 1 || value === '1';
}

/**
 * Decode one GoPlus token_security entry into the structured raw signals we
 * store. There is NO `verified` field — spam is computed at read-time from
 * these signals (`isSpamSignals`). A missing entry (token not covered by
 * GoPlus) → all-false signals (⇒ not spam): fail-open by absence.
 */
export function parseGoplusToken(chainId: number, address: string, d: Record<string, unknown> | undefined): TokenSecurityRecord {
  if (!d) return { chainId, address };
  return {
    chainId,
    address,
    isHoneypot: flag(d.is_honeypot),
    isBlacklisted: flag(d.is_blacklisted),
    cannotSellAll: flag(d.cannot_sell_all),
    personalSlippageModifiable: flag(d.personal_slippage_modifiable),
    fakeToken: fakeTokenFlag(d.fake_token),
    cannotBuy: flag(d.cannot_buy),
    honeypotWithSameCreator: flag(d.honeypot_with_same_creator),
    trustList: flag(d.trust_list),
    isOpenSource: flag(d.is_open_source),
    isProxy: flag(d.is_proxy),
    buyTax: num(d.buy_tax),
    sellTax: num(d.sell_tax),
    holderCount: num(d.holder_count),
    creatorPercent: num(d.creator_percent),
    tokenName: typeof d.token_name === 'string' ? d.token_name : undefined,
    tokenSymbol: typeof d.token_symbol === 'string' ? d.token_symbol : undefined,
  };
}

/**
 * GoPlus token-security check. Persists raw signals into `{chainId}_tokens`;
 * the in-memory return maps address → `isSpam` (via the shared `isSpamSignals`
 * rule) for any programmatic caller. Two safety rails:
 *   - tokens whose security is already CERTAIN (config anchors + the committed
 *     CoinGecko allowlist) are treated as not-spam WITHOUT a network call;
 *   - every fetch has a timeout and FAILS OPEN (not-spam) — a GoPlus outage
 *     must never hide a token.
 * Must NOT be called on the resync hot path — driven only by the decoupled,
 * rate-limited background sweep (TokenSecuritySyncService).
 */
@Injectable()
export class GoplusService {
  private readonly logger = new Logger(GoplusService.name);

  constructor(@Inject(TokensRepository) private readonly tokens: TokensRepository) {}

  /**
   * Assess a list of token addresses for a chain. Returns address(lowercased)
   * → `isSpam` boolean. Security-certain tokens short-circuit to false; the
   * rest are served from the 7-day cache or fetched (rate-limited).
   */
  async assessTokens(chainId: number, addresses: string[]): Promise<Record<string, boolean>> {
    if (addresses.length === 0) return {};

    const result: Record<string, boolean> = {};
    const uniqueAddresses = [...new Set(addresses.map((a) => a.toLowerCase()))];

    // Security-certain tokens (anchors + allowlisted) never need GoPlus.
    const uncertain: string[] = [];
    for (const addr of uniqueAddresses) {
      if (isAnchorTokenStandalone(chainId, addr) || isAllowlisted(chainId, addr)) {
        result[addr] = false;
      } else {
        uncertain.push(addr);
      }
    }
    if (uncertain.length === 0) return result;

    const cached = await this.tokens.findMany(chainId, uncertain);
    const cachedByAddr = new Map(cached.map((c) => [c.address.toLowerCase(), c]));
    const now = Date.now();
    const toFetch: string[] = [];
    for (const addr of uncertain) {
      const entry = cachedByAddr.get(addr);
      if (entry && entry.lastCheckedAt && now - entry.lastCheckedAt.getTime() < CACHE_TTL_MS) {
        result[addr] = isSpamSignals(entry);
      } else {
        toFetch.push(addr);
      }
    }

    for (let i = 0; i < toFetch.length; i += BATCH_SIZE) {
      const batch = toFetch.slice(i, i + BATCH_SIZE);
      await this.fetchAndStoreBatch(chainId, batch, result);
      if (i + BATCH_SIZE < toFetch.length && INTER_BATCH_DELAY_MS > 0) {
        await sleep(INTER_BATCH_DELAY_MS);
      }
    }

    return result;
  }

  private async fetchAndStoreBatch(chainId: number, batch: string[], result: Record<string, boolean>): Promise<void> {
    // Retry the SAME batch with exponential backoff while GoPlus rate-limits
    // (HTTP 429 or body code 4029). Only after exhausting retries do we
    // fail-open — every other outcome (success / genuine error / timeout) exits
    // the loop. This lets a full sweep self-throttle to GoPlus's real rate
    // instead of dropping tokens on the first 4029.
    for (let attempt = 0; ; attempt++) {
      const outcome = await this.fetchBatchOnce(chainId, batch, result);
      if (outcome !== 'ratelimited') return;
      if (attempt >= RATELIMIT_MAX_RETRIES) {
        this.logger.warn(`GoPlus rate-limited ${batch.length} tokens after ${attempt + 1} attempts — failing open`);
        batch.forEach((addr) => (result[addr] = false)); // fail open (not spam) after exhausting
        return;
      }
      const backoff = Math.min(RATELIMIT_BASE_BACKOFF_MS * 2 ** attempt, RATELIMIT_MAX_BACKOFF_MS);
      await sleep(backoff);
    }
  }

  /** One GoPlus call. Returns 'ok' | 'ratelimited' | 'failed'. */
  private async fetchBatchOnce(
    chainId: number,
    batch: string[],
    result: Record<string, boolean>,
  ): Promise<'ok' | 'ratelimited' | 'failed'> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const url = `https://api.gopluslabs.io/api/v1/token_security/${chainId}?contract_addresses=${batch.join(',')}`;
      const response = await fetch(url, { signal: controller.signal });
      if (response.status === 429) return 'ratelimited';
      if (!response.ok) {
        this.logger.warn(`GoPlus API error ${response.status} for ${batch.length} tokens`);
        batch.forEach((addr) => (result[addr] = false)); // fail open (not spam)
        return 'failed';
      }

      const json = await response.json();
      if (json.code === GOPLUS_RATE_LIMIT_CODE) return 'ratelimited';
      if (json.code !== 1) {
        this.logger.warn(`GoPlus API returned code ${json.code} for ${batch.length} tokens: ${json.message}`);
        batch.forEach((addr) => (result[addr] = false)); // fail open (not spam)
        return 'failed';
      }

      const data = json.result || {};
      const upserts = batch.map((addr) => {
        const record = parseGoplusToken(chainId, addr, data[addr]);
        result[addr] = isSpamSignals(record);
        return record;
      });

      await this.tokens.upsertSecurity(upserts);
      this.logger.log(`GoPlus check: ${batch.length} tokens, ${upserts.filter(isSpamSignals).length} flagged spam`);
      return 'ok';
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `GoPlus request ${aborted ? 'timed out' : 'failed'} for ${batch.length} tokens on chain ${chainId}: ${msg}`,
      );
      batch.forEach((addr) => (result[addr] = false)); // fail open (not spam)
      return 'failed';
    } finally {
      clearTimeout(timer);
    }
  }
}
