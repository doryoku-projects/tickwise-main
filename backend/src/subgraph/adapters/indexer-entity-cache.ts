/*
 * Run-scoped caches for a tokenId range walk (`BACKFILL_PIPELINE=on`).
 *
 * WHAT MAY BE CACHED, AND WHY ONLY THAT. A backfill touches the same tokens
 * thousands of times (the rig's 4663 actives reference 15,848 distinct token0
 * and 142,898 distinct token1 across 2.7M positions), and a token's decimals,
 * symbol and name never change — so the run asks for each once. A POOL is
 * different: `tick` and `sqrtPriceX96` move with every swap, and they decide
 * `currentTick`, `metrics.inRange` and the pool ratio every leg's valuation
 * leans on. Caching them for a multi-hour run would freeze a pool at the price
 * it had when the walk first met it. So pools are NOT cached here at all: every
 * range asks for its pools' static AND dynamic fields AND poolStats in ONE
 * request (`EnvioAdapter.fetchRangePools`) — the request is made anyway for the
 * dynamic fields, so a static-field cache would save bytes, not calls.
 *
 * `staticPoolFields` exists for the one place a pool row is kept between
 * ranges (none today) and is what a future cache must go through: it builds a
 * NEW object from the static allow-list, so a dynamic field can never ride
 * along by accident.
 *
 * Bounded (LRU, 300k entries per map by default, ~100 MB worst case) and
 * dropped with the run.
 */

/** A token's indexer row, minus nothing: every column it has is static. */
export interface CachedToken {
  id: string;
  symbol: string;
  name: string;
  decimals: number;
  verified: boolean;
}

/** The pool columns that never change after creation. */
export interface StaticPoolFields {
  id: string;
  name: string;
  fee: number;
  tickSpacing: number;
  token0Id: string;
  token1Id: string;
}

const STATIC_POOL_KEYS = ['id', 'name', 'fee', 'tickSpacing', 'token0Id', 'token1Id'] as const;

/**
 * A pool row reduced to its static columns — a NEW object built from an
 * allow-list, so `tick`, `sqrtPriceX96` and every poolStats column are dropped
 * whatever the input carried.
 */
export function staticPoolFields(row: Record<string, unknown>): StaticPoolFields {
  const out: Record<string, unknown> = {};
  for (const key of STATIC_POOL_KEYS) out[key] = row[key];
  return out as unknown as StaticPoolFields;
}

/** Insertion-ordered Map used as an LRU: a hit moves the key to the newest end. */
export class LruMap<K, V> {
  private readonly map = new Map<K, V>();

  constructor(readonly maxEntries: number) {
    if (!Number.isFinite(maxEntries) || maxEntries < 1) throw new Error(`LruMap: maxEntries must be ≥ 1 (got ${maxEntries})`);
  }

  get size(): number {
    return this.map.size;
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  clear(): void {
    this.map.clear();
  }
}

export const DEFAULT_ENTITY_CACHE_ENTRIES = 300_000;

export interface EntityCacheStats {
  tokenHits: number;
  tokenMisses: number;
  tokens: number;
}

/** The token cache of ONE walk. Keys are lowercased indexer ids. */
export class IndexerEntityCache {
  private readonly tokens: LruMap<string, CachedToken>;
  private tokenHits = 0;
  private tokenMisses = 0;

  constructor(maxEntries = DEFAULT_ENTITY_CACHE_ENTRIES) {
    this.tokens = new LruMap(maxEntries);
  }

  /** Split `ids` into the cached tokens and the ids still to fetch (de-duplicated, lowercased). */
  lookupTokens(ids: Iterable<string>): { hit: Map<string, CachedToken>; miss: string[] } {
    const hit = new Map<string, CachedToken>();
    const miss: string[] = [];
    const seen = new Set<string>();
    for (const raw of ids) {
      const id = raw.toLowerCase();
      if (seen.has(id)) continue;
      seen.add(id);
      const cached = this.tokens.get(id);
      if (cached) {
        hit.set(id, cached);
        this.tokenHits += 1;
      } else {
        miss.push(id);
        this.tokenMisses += 1;
      }
    }
    return { hit, miss };
  }

  putTokens(rows: Iterable<CachedToken>): void {
    for (const row of rows) {
      this.tokens.set(row.id.toLowerCase(), {
        id: row.id,
        symbol: row.symbol,
        name: row.name,
        decimals: row.decimals,
        verified: row.verified,
      });
    }
  }

  stats(): EntityCacheStats {
    return { tokenHits: this.tokenHits, tokenMisses: this.tokenMisses, tokens: this.tokens.size };
  }
}
