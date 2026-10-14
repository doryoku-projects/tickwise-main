import { Inject, Injectable, Optional } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import { TokensRepository } from '../database/token.repository.js';
import {
  resolveTokenTrust,
  trustPolicyOf,
  usesStoredVerdicts,
  type StoredTokenTrust,
  type TokenTrustVerdict,
  type TrustPolicy,
} from './token-trust.js';

/** How long a loaded stored verdict is served from memory before it is re-read. */
const TRUST_CACHE_TTL_MS = 5 * 60_000;

/**
 * The ONE place the rest of the backend asks "is this token trusted for
 * valuation, and why" (`trust(chainId, address)`): the position path
 * (`PricingService.pricePool` / `hasTrustedMarket`), the pools sync's leg gate,
 * and — through the same pure `resolveTokenTrust` over the documents they
 * already hold — the leaderboard exclusion scan. So the Pools page and the
 * Positions page can no longer disagree about a token (BTC.b).
 *
 * `trust` is synchronous (it is called per leg inside tight loops). In
 * `allowlist` mode (default) it needs no I/O at all and answers exactly
 * today's `isAnchorTokenStandalone || isAllowlisted` (minus the env deny list,
 * empty by default). In `earned` and `combined` mode (`usesStoredVerdicts`)
 * it reads the stored verdicts that `warm(chainId, addresses)` (or `prime`)
 * loaded; an address nobody warmed has no evidence — untrusted in `earned`
 * mode (fail closed, like an unswept token under `DEX_MARKET_FAIL_CLOSED`),
 * and in `combined` mode trusted exactly when it is allowlisted (the stored
 * `trustDenied` flag of a token nobody warmed is then not seen).
 */
@Injectable()
export class TokenTrustService {
  private readonly cache = new Map<string, { stored: StoredTokenTrust | null; expiresAt: number }>();

  constructor(
    @Optional() @Inject(AppConfigService) private readonly config?: AppConfigService,
    @Optional() @Inject(TokensRepository) private readonly tokens?: TokensRepository,
  ) {}

  policy(): TrustPolicy {
    return trustPolicyOf(this.config);
  }

  /** Is this token trusted (and why)? Synchronous; see the class doc for when it needs `warm`. */
  trust(chainId: number, address: string): TokenTrustVerdict {
    const policy = this.policy();
    const a = address.toLowerCase();
    const stored = usesStoredVerdicts(policy) ? this.cached(chainId, a) : this.cachedIfAny(chainId, a);
    return resolveTokenTrust(chainId, a, stored, policy);
  }

  /** Convenience: `trust(...).trusted`. */
  isTrusted(chainId: number, address: string): boolean {
    return this.trust(chainId, address).trusted;
  }

  /**
   * Load the stored verdicts of these addresses (one indexed read), skipping
   * ones still fresh in memory. A no-op in `allowlist` mode — today's rule
   * reads nothing. Best-effort: a read failure leaves them unloaded (earned
   * mode then fails closed for them; combined mode falls back to the
   * allowlist alone).
   */
  async warm(chainId: number, addresses: readonly string[]): Promise<void> {
    if (!usesStoredVerdicts(this.policy()) || !this.tokens || addresses.length === 0) return;
    const now = Date.now();
    const need = [...new Set(addresses.map((a) => a.toLowerCase()))].filter((a) => {
      const c = this.cache.get(key(chainId, a));
      return !c || c.expiresAt <= now;
    });
    if (need.length === 0) return;
    try {
      const rows = await this.tokens.findTrustState(chainId, need);
      this.primeMany(chainId, need, rows);
    } catch {
      /* the addresses stay unloaded: earned mode fails closed, combined keeps the allowlist */
    }
  }

  /**
   * Store already-read verdicts (the pricing layer reads them together with
   * the DEX-market state, in the same query). Addresses in `addresses` missing
   * from `rows` are cached as "no document" so they are not re-read per leg.
   */
  primeMany(chainId: number, addresses: readonly string[], rows: ReadonlyMap<string, StoredTokenTrust>): void {
    const expiresAt = Date.now() + TRUST_CACHE_TTL_MS;
    for (const raw of addresses) {
      const a = raw.toLowerCase();
      this.cache.set(key(chainId, a), { stored: rows.get(a) ?? null, expiresAt });
    }
  }

  private cached(chainId: number, address: string): StoredTokenTrust | null | undefined {
    const c = this.cache.get(key(chainId, address));
    if (!c || c.expiresAt <= Date.now()) return undefined;
    return c.stored;
  }

  /**
   * Allowlist mode: whatever happens to be loaded (the quote guard primes the
   * cache) is passed through, and the rule reads none of it there — the
   * `trustDenied` flag is honoured only in the modes that load verdicts
   * everywhere (`isDenied`), so the answer is the same with or without it.
   */
  private cachedIfAny(chainId: number, address: string): StoredTokenTrust | null | undefined {
    if (this.cache.size === 0) return undefined;
    return this.cached(chainId, address);
  }
}

function key(chainId: number, address: string): string {
  return `${chainId}:${address}`;
}
