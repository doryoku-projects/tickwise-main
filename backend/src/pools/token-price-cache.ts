import { Logger } from '@nestjs/common';
import type { TokensRepository } from '../database/token.repository.js';

/** A price this young is served as is. */
export const TOKEN_PRICE_FRESH_MS = 30_000;
/** Older, up to this age, it is still served while ONE background read refreshes it — data ≤ 45 s old. */
export const TOKEN_PRICE_MAX_AGE_MS = 45_000;
/** Addresses kept per process (least recently used out first). */
export const TOKEN_PRICE_MAX_ENTRIES = 50_000;
/** Server-side budget of one batched read. */
export const TOKEN_PRICE_READ_MAX_TIME_MS = 1_000;
/** After a failed read, a chain's misses resolve as "no price" for this long instead of re-reading. */
export const TOKEN_PRICE_FAILURE_BACKOFF_MS = 5_000;

interface Entry {
  /** USD price, or null: the token has no positive stored price (cached too). */
  price: number | null;
  loadedAt: number;
}

/**
 * Current USD prices for the POOLS read path only (list and detail): the
 * `priceUsd` each pool leg carries in the response. It replaces an uncached
 * `TokensRepository.findLatestPrices` per request — 1–4 PRIMARY `$in` reads per
 * pools list, window-cache hits included — with a per-process LRU:
 *  - fresh 30 s, then served stale up to 45 s while ONE background read
 *    refreshes it (the accepted trade-off: data at most ~45 s old); older is a
 *    miss;
 *  - misses are BATCHED and single-flight: every address asked for in the same
 *    tick goes into one `$in` per chain, and a request asking for an address
 *    already being read waits for that read instead of starting another;
 *  - reads are `secondaryPreferred` with `maxTimeMS` 1 s
 *    (`findLatestPricesForRead`);
 *  - a token with no stored price is cached as "none" too, so it does not
 *    cost a read per request.
 * Fails OPEN, as before: a read that fails leaves the missed prices out (the
 * response degrades them to 0) and holds that chain's misses back for 5 s.
 * The pricing service keeps its own caches; nothing else uses this one.
 */
export class TokenPriceCache {
  private readonly logger = new Logger(TokenPriceCache.name);
  private readonly entries = new Map<string, Entry>();
  /** Keys being read right now → the read they ride on. */
  private readonly loading = new Map<string, Promise<void>>();
  /** Per chain: the batch filling in this tick (read on the next microtask). */
  private readonly pending = new Map<number, { addresses: Set<string>; done: Promise<void> }>();
  private readonly failedUntil = new Map<number, number>();
  /** Reads issued (for specs and the log). */
  reads = 0;

  constructor(
    private readonly tokens: Pick<TokensRepository, 'findLatestPricesForRead'> | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * `priceUsd` per `${chainId}:${address}` (lowercased) for the addresses
   * asked; an address with no known price is absent. `meta.oldestLoadedAt`:
   * when the oldest entry served was read (a value cached on top of these
   * prices — pool detail — is no younger than that).
   */
  async prices(byChain: Map<number, Set<string>>, meta?: { oldestLoadedAt?: number }): Promise<Map<string, number>> {
    const waits: Promise<void>[] = [];
    for (const [chainId, addresses] of byChain) {
      for (const raw of addresses) {
        const address = raw.toLowerCase();
        const key = priceKey(chainId, address);
        const entry = this.entries.get(key);
        const age = entry ? this.now() - entry.loadedAt : Infinity;
        if (age < TOKEN_PRICE_FRESH_MS) continue;
        if (age < TOKEN_PRICE_MAX_AGE_MS) {
          // Served stale; ONE background read refreshes it.
          if (!this.loading.has(key)) void this.enqueue(chainId, address);
          continue;
        }
        waits.push(this.loading.get(key) ?? this.enqueue(chainId, address));
      }
    }
    if (waits.length > 0) await Promise.all(waits);

    const out = new Map<string, number>();
    const now = this.now();
    for (const [chainId, addresses] of byChain) {
      for (const raw of addresses) {
        const key = priceKey(chainId, raw.toLowerCase());
        const entry = this.entries.get(key);
        if (!entry || now - entry.loadedAt >= TOKEN_PRICE_MAX_AGE_MS) continue;
        // LRU: a served entry moves to the back of the eviction order.
        this.entries.delete(key);
        this.entries.set(key, entry);
        if (meta) meta.oldestLoadedAt = Math.min(meta.oldestLoadedAt ?? Infinity, entry.loadedAt);
        if (entry.price !== null) out.set(key, entry.price);
      }
    }
    return out;
  }

  /** Put `address` into this tick's batch for `chainId`; resolves once that batch is read. */
  private enqueue(chainId: number, address: string): Promise<void> {
    const key = priceKey(chainId, address);
    if ((this.failedUntil.get(chainId) ?? 0) > this.now()) return Promise.resolve();
    let batch = this.pending.get(chainId);
    if (!batch) {
      const addresses = new Set<string>();
      const done = Promise.resolve().then(() => this.load(chainId, addresses));
      batch = { addresses, done };
      this.pending.set(chainId, batch);
    }
    batch.addresses.add(address);
    this.loading.set(key, batch.done);
    return batch.done;
  }

  private async load(chainId: number, addresses: Set<string>): Promise<void> {
    if (this.pending.get(chainId)?.addresses === addresses) this.pending.delete(chainId);
    const list = [...addresses];
    try {
      if (!this.tokens) throw new Error('no tokens repository');
      this.reads++;
      const found = await this.tokens.findLatestPricesForRead(chainId, list, TOKEN_PRICE_READ_MAX_TIME_MS);
      const loadedAt = this.now();
      for (const address of list) {
        const row = found.get(address);
        this.store(priceKey(chainId, address), { price: row && row.priceUsd > 0 ? row.priceUsd : null, loadedAt });
      }
    } catch (err) {
      // Fail open: the misses go unpriced (0 in the response), as before.
      this.failedUntil.set(chainId, this.now() + TOKEN_PRICE_FAILURE_BACKOFF_MS);
      this.logger.warn(
        `token price read failed chain=${chainId} tokens=${list.length} — served unpriced, retried after ` +
          `${TOKEN_PRICE_FAILURE_BACKOFF_MS} ms: ${(err as Error)?.message ?? String(err)}`,
      );
    } finally {
      for (const address of list) this.loading.delete(priceKey(chainId, address));
    }
  }

  private store(key: string, entry: Entry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > TOKEN_PRICE_MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }
}

function priceKey(chainId: number, address: string): string {
  return `${chainId}:${address}`;
}
