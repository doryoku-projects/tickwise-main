import {
  isPhishingSymbol,
  isSymbolSpoof,
  PHISHING_SYMBOL_PREFILTER_SOURCE,
  PROTECTED_MAJOR_ADDRESSES,
} from '../config/chains.config.js';
import { isAnchorTokenStandalone } from '../pricing/pricing-policy.js';
import { isAllowlisted } from '../pricing/token-allowlist.js';

/**
 * Token IDENTITY spam (2026-10-06): a verdict read off a token's own symbol and
 * address, needing no third party — the class GoPlus misses. GoPlus returns no
 * hard flag for a fake USDT whose only tell is that it is not Tether's
 * contract, nor for a token whose ticker is a phishing sentence, and it only
 * ever scans tokens of OPEN positions (`TOKEN_SECURITY_SCOPE=active`), so a
 * search-only spam token never gets a security doc at all.
 *
 *  - `symbol-spoof`: the symbol is a protected major's (`USDT`, `WETH`, …) at a
 *    non-canonical address (`isSymbolSpoof`, the map pricing already uses);
 *  - `phishing-symbol`: the symbol carries a link or "visit" (`isPhishingSymbol`).
 *
 * Config anchors and allowlisted tokens are NEVER identity spam — the same
 * exemption GoPlus applies (`goplus.service.ts`): SAI (0x89d2…0359) reports the
 * symbol `DAI` and is allowlisted, so it stays clean without widening the
 * pricing-side spoof map.
 *
 * Pure (no Nest, no Mongo): `TokensRepository.findSpamAddresses` (the ranked
 * lists' exclusion), the pools / positions services (the per-row flags) and
 * `scripts/valuation-impact-report.mjs` all read this one rule.
 */
export type IdentitySpamReason = 'symbol-spoof' | 'phishing-symbol';

export function identitySpamReason(
  chainId: number,
  address: unknown,
  symbols: ReadonlyArray<unknown>,
): IdentitySpamReason | undefined {
  if (typeof address !== 'string' || address.length === 0) return undefined;
  const addr = address.toLowerCase();
  if (isAnchorTokenStandalone(chainId, addr) || isAllowlisted(chainId, addr)) return undefined;
  const named = symbols.filter((s): s is string => typeof s === 'string' && s.length > 0);
  for (const symbol of named) if (isSymbolSpoof(chainId, symbol, addr)) return 'symbol-spoof';
  for (const symbol of named) if (isPhishingSymbol(symbol)) return 'phishing-symbol';
  return undefined;
}

/**
 * Whitespace `String.prototype.trim` removes, as LITERAL characters (MongoDB's
 * PCRE2 has no `\u` escape): the spoof alternative must match `" USDT "` the
 * way `isSymbolSpoof`'s `trim()` does. U+2028 / U+2029 are deliberately LEFT
 * OUT: `RegExp#source` — what js-bson sends — escapes a line terminator as
 * ` `, which PCRE2 rejects (error 51091), and that would fail the whole
 * exclusion scan. A symbol padded with one is not pre-filtered (a gap, like
 * homoglyphs).
 */
const TRIMMED_SPACE = `[\\s   -   　﻿]*`;

const prefilterByChain = new Map<number, RegExp>();

/**
 * A `$regex` (case-insensitive) that matches EVERY symbol `identitySpamReason`
 * could flag on `chainId` — a protected major's symbol (anchored, trimmed) or
 * the phishing pre-filter — so the exclusion scan returns only candidate rows
 * and decides in JS. A SUPERSET by construction: case-insensitive PCRE2 folds
 * at least the ASCII pairs `toUpperCase` maps, and the phishing alternatives
 * are the JS patterns minus their word boundaries. One per chain, cached.
 */
export function identitySymbolPrefilter(chainId: number): RegExp {
  const cached = prefilterByChain.get(chainId);
  if (cached) return cached;
  const majors = Object.keys(PROTECTED_MAJOR_ADDRESSES[chainId] ?? {}).map(escapeRegExp);
  const spoof = majors.length > 0 ? `^${TRIMMED_SPACE}(?:${majors.join('|')})${TRIMMED_SPACE}$` : undefined;
  const pattern = new RegExp(spoof ? `${spoof}|${PHISHING_SYMBOL_PREFILTER_SOURCE}` : PHISHING_SYMBOL_PREFILTER_SOURCE, 'i');
  prefilterByChain.set(chainId, pattern);
  return pattern;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

// ─── Per-row risk flags (search, lookups, detail) ─────────────────────────────

/**
 * Why a served pool / position row is flagged. Additive on `/api` and `/v1`
 * rows as `risk: { flags }`, present only when non-empty:
 *  - `symbol-spoof` / `phishing-symbol`: a leg's own symbol (`identitySpamReason`);
 *  - `excluded-token`: a leg is in the chain's ranked-list exclusion set —
 *    GoPlus hard flags or GoPlus `fake_token`, identity spam on the token's
 *    stored symbols, no real active DEX market, or an operator deny. The set
 *    is published as addresses only (`exclusion-snapshot.ts`), so the reason
 *    behind it is not broken down here;
 *  - `risky-pool`: the pool is one the Pools page flags risky.
 * Ranked lists EXCLUDE what this FLAGS; search and id / owner lookups keep the
 * row and carry the flag, so a $0 spam pool stays findable but is labelled.
 */
export type RiskFlag = IdentitySpamReason | 'excluded-token' | 'risky-pool';

export interface RowRisk {
  flags: RiskFlag[];
}

const FLAG_ORDER: readonly RiskFlag[] = ['symbol-spoof', 'phishing-symbol', 'excluded-token', 'risky-pool'];

export function rowRisk(
  chainId: number,
  legs: ReadonlyArray<{ address?: unknown; symbol?: unknown } | null | undefined>,
  excluded: ReadonlySet<string> | undefined,
  riskyPool: boolean,
): RowRisk | undefined {
  const flags = new Set<RiskFlag>();
  for (const leg of legs) {
    if (!leg || typeof leg.address !== 'string' || leg.address.length === 0) continue;
    const addr = leg.address.toLowerCase();
    const identity = identitySpamReason(chainId, addr, [leg.symbol]);
    if (identity) flags.add(identity);
    if (excluded?.has(addr)) flags.add('excluded-token');
  }
  if (riskyPool) flags.add('risky-pool');
  return flags.size > 0 ? { flags: FLAG_ORDER.filter((flag) => flags.has(flag)) } : undefined;
}

const exclusionSets = new WeakMap<readonly string[], ReadonlySet<string>>();

/**
 * The exclusion list as a Set, built once per published list: the list object
 * is kept across rebuilds while its content is unchanged (`TokensRepository`
 * keeps the previous object), so its identity is the cache key.
 */
export function exclusionSetOf(addresses: readonly string[] | undefined): ReadonlySet<string> | undefined {
  if (!addresses || addresses.length === 0) return undefined;
  let set = exclusionSets.get(addresses);
  if (!set) {
    set = new Set(addresses.map((a) => a.toLowerCase()));
    exclusionSets.set(addresses, set);
  }
  return set;
}
