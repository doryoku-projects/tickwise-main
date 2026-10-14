/*
 * The external-price MISS LEDGER (`PRICE_MISS_LEDGER=on`, decision D-8).
 *
 * WHY. 97 % of Robinhood's 153,587 tokens have no external price, and every
 * prefetch re-asked every provider about every one of them whose 45 s miss
 * entry had lapsed — GeckoTerminal's 30 calls/min went to tokens nobody
 * prices, 429'd, and backed off for 60 s, which then starved the tokens that
 * DO have a market. The ledger stops asking about a token no provider priced
 * for a while that grows with each consecutive miss: 30 min → 1 h → 2 h → 6 h
 * (cap), and forgets it the moment any provider prices it.
 *
 * WHAT IT GATES — and what it never does:
 *  - ONLY the independent aggregators (pass 1 of the price walk). The
 *    pool-derived sources (`subgraph-current`, pass 2) and pool-ratio
 *    derivation come with the indexer's own token entity and are NEVER subject
 *    to it, so a token that gains a v4 market is priced exactly as today.
 *  - A held token still gets its last-known-good price (`{chainId}_tokens`).
 *  - A miss is recorded only from a HEALTHY answer: a provider that was rate
 *    limited, errored, was skipped by a budget, or answered GeckoTerminal's
 *    429-as-HTTP-200-without-data makes the token `unknown` for that walk — no
 *    ledger entry, retried next time exactly as today.
 *
 * PROCESS-WIDE AND PERSISTED. One instance per process (inside
 * `PricingService`), shared by the backfill, the refresh and the consensus
 * sweep; entries are persisted as `priceMissAt` / `priceMissStreak` on
 * `{chainId}_tokens`, so restarts and other processes agree. The local copy is
 * trusted for `cacheTtlMs` (60 s) before it is re-read.
 */

/** 30 min → 1 h → 2 h → 6 h (cap), indexed by consecutive-miss streak − 1. */
export const PRICE_MISS_LADDER_MS: readonly number[] = [30 * 60_000, 60 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000];

/** How long the ladder holds a token after `streak` consecutive misses (0 for none). */
export function priceMissHoldMs(streak: number): number {
  if (!Number.isFinite(streak) || streak < 1) return 0;
  const idx = Math.min(PRICE_MISS_LADDER_MS.length, Math.floor(streak)) - 1;
  return PRICE_MISS_LADDER_MS[idx]!;
}

/** True while a token that missed at `missAtMs` with `streak` must not be re-asked. */
export function isPriceMissHeld(entry: { missAtMs: number; streak: number } | undefined, nowMs: number): boolean {
  if (!entry) return false;
  return nowMs < entry.missAtMs + priceMissHoldMs(entry.streak);
}

/**
 * The Mongo filter clauses (`$or`) matching a stored token whose miss ledger
 * is NOT inside a live hold at `atMs` — no entry, or its ladder step has
 * elapsed. The store increments the streak ONLY on such a row: several walks
 * or processes that see the same miss episode (the refresh and the consensus
 * sweep pricing the same long-tail token, two lookahead ranges, two
 * processes) then climb the ladder ONCE, not once per concurrent asker.
 * Built from `PRICE_MISS_LADDER_MS`, so the store and `isPriceMissHeld` agree.
 */
export function priceMissNotHeldClauses(atMs: number): Record<string, unknown>[] {
  const clauses: Record<string, unknown>[] = [
    { priceMissStreak: null },
    { priceMissStreak: { $lte: 0 } },
    { priceMissStreak: { $gt: 0 }, priceMissAt: null },
  ];
  const last = PRICE_MISS_LADDER_MS.length;
  for (let streak = 1; streak <= last; streak += 1) {
    clauses.push({
      priceMissStreak: streak === last ? { $gte: streak } : streak,
      priceMissAt: { $lte: new Date(atMs - priceMissHoldMs(streak)) },
    });
  }
  return clauses;
}

/** Persistence for the ledger — implemented by `TokensRepository`. */
export interface PriceMissStore {
  /** Stored entries for these addresses (only those that have one). */
  findPriceMisses(chainId: number, addresses: string[]): Promise<Map<string, { at: Date; streak: number }>>;
  /**
   * One more consecutive miss: `$inc priceMissStreak` + `$set priceMissAt = at`
   * — but ONLY on a row with no live hold at `at` (`priceMissNotHeldClauses`);
   * a row already held by this episode is left as it is. Upserts a missing row.
   */
  recordPriceMisses(chainId: number, addresses: string[], at: Date): Promise<void>;
  /** `$unset` both fields. */
  clearPriceMisses(chainId: number, addresses: string[]): Promise<void>;
}

interface LocalEntry {
  missAtMs: number;
  streak: number;
  /** When this copy was read from / written to the store (staleness bound). */
  loadedAtMs: number;
}

/** A loaded "no entry" — remembered so a clean token is not re-read every page. */
const NONE: Omit<LocalEntry, 'loadedAtMs'> = Object.freeze({ missAtMs: 0, streak: 0 });

export interface PriceMissLedgerStats {
  /** Tokens a walk did not ask the aggregators about because they were held. */
  skips: number;
  /** Definite misses recorded. */
  misses: number;
  /** Entries cleared by a positive price. */
  resets: number;
  /** Store reads (one per `held` call that had anything to load). */
  reads: number;
}

export class PriceMissLedger {
  private readonly entries = new Map<string, LocalEntry>();
  private readonly counters: PriceMissLedgerStats = { skips: 0, misses: 0, resets: 0, reads: 0 };

  constructor(
    private readonly store: PriceMissStore | undefined,
    private readonly now: () => number = () => Date.now(),
    private readonly cacheTtlMs = 60_000,
    /** Bound on the local copy; past it the oldest entries are dropped (they re-read from the store). */
    private readonly maxEntries = 500_000,
  ) {}

  private key(chainId: number, address: string): string {
    return `${chainId}:${address.toLowerCase()}`;
  }

  /**
   * The addresses (lowercased) still inside their ladder window. Entries this
   * process has not seen within `cacheTtlMs` are read from the store in ONE
   * query first; a store failure reads as "not held" (fail open = today).
   */
  async held(chainId: number, addresses: Iterable<string>): Promise<Set<string>> {
    const nowMs = this.now();
    const lowers = [...new Set([...addresses].map((a) => a.toLowerCase()))];
    const toLoad = lowers.filter((a) => {
      const e = this.entries.get(this.key(chainId, a));
      return !e || nowMs - e.loadedAtMs > this.cacheTtlMs;
    });
    if (toLoad.length > 0 && this.store) {
      this.counters.reads += 1;
      try {
        const stored = await this.store.findPriceMisses(chainId, toLoad);
        for (const addr of toLoad) {
          const row = stored.get(addr);
          const at = row?.at instanceof Date ? row.at.getTime() : NaN;
          const streak = Number(row?.streak);
          this.put(
            this.key(chainId, addr),
            Number.isFinite(at) && Number.isFinite(streak) && streak > 0
              ? { missAtMs: at, streak, loadedAtMs: nowMs }
              : { ...NONE, loadedAtMs: nowMs },
          );
        }
      } catch {
        // Fail open: nothing held, everything asked — today's behaviour.
      }
    }
    const out = new Set<string>();
    for (const addr of lowers) {
      if (isPriceMissHeld(this.entries.get(this.key(chainId, addr)), nowMs)) out.add(addr);
    }
    this.counters.skips += out.size;
    return out;
  }

  /** Synchronous check against the LOCAL copy only (no I/O) — for the single-token path. */
  isHeldLocally(chainId: number, address: string): boolean {
    return isPriceMissHeld(this.entries.get(this.key(chainId, address)), this.now());
  }

  /** Record DEFINITE misses (healthy answers, no price). Best-effort persistence. */
  async recordMisses(chainId: number, addresses: Iterable<string>): Promise<void> {
    const nowMs = this.now();
    const lowers = [...new Set([...addresses].map((a) => a.toLowerCase()))];
    if (lowers.length === 0) return;
    for (const addr of lowers) {
      const k = this.key(chainId, addr);
      const prev = this.entries.get(k);
      // Already held by this episode (another walk recorded it first): the
      // ladder does not climb again — the store applies the same rule.
      if (isPriceMissHeld(prev, nowMs)) continue;
      this.put(k, { missAtMs: nowMs, streak: (prev?.streak ?? 0) + 1, loadedAtMs: nowMs });
    }
    this.counters.misses += lowers.length;
    if (!this.store) return;
    try {
      await this.store.recordPriceMisses(chainId, lowers, new Date(nowMs));
    } catch {
      // The local copy still holds them for this process; others re-ask (today).
    }
  }

  /**
   * Forget the tokens a provider just priced — ALWAYS sent to the store for
   * every one of them. This process's local copy may be stale ("no entry"
   * while another process recorded a miss), and skipping the clear then left
   * the stored hold in place fleet-wide for a token that was just priced. The
   * store's clear filters on `priceMissStreak: {$exists: true}`, so a clean
   * row costs nothing but the one indexed `updateMany` per walk.
   */
  async recordPositives(chainId: number, addresses: Iterable<string>): Promise<void> {
    const nowMs = this.now();
    const toClear = new Set<string>();
    for (const raw of addresses) {
      const addr = raw.toLowerCase();
      const k = this.key(chainId, addr);
      const e = this.entries.get(k);
      if (e && e.streak > 0) this.counters.resets += 1;
      toClear.add(addr);
      this.put(k, { ...NONE, loadedAtMs: nowMs });
    }
    if (toClear.size === 0) return;
    if (!this.store) return;
    try {
      await this.store.clearPriceMisses(chainId, [...toClear]);
    } catch {
      // A stale stored entry only delays the token's next ask (≤ its ladder step).
    }
  }

  stats(): PriceMissLedgerStats {
    return { ...this.counters };
  }

  private put(key: string, entry: LocalEntry): void {
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}

/**
 * Which tokens a price walk may record as DEFINITE misses: unpriced by every
 * provider that answered, AND every provider the walk meant to ask answered
 * healthily for them. `asked` = provider → addresses it was asked about;
 * `unhealthy` = providers that were rate limited / errored / skipped during the
 * walk (their whole share is `unknown`); `skipped` = providers that could not be
 * asked at all (in backoff) — while one is, NOTHING is a definite miss.
 */
export function definiteMisses(input: {
  candidates: Iterable<string>;
  priced: ReadonlySet<string>;
  expectedProviders: readonly string[];
  asked: ReadonlyMap<string, ReadonlySet<string>>;
  unhealthy: ReadonlySet<string>;
}): string[] {
  const out: string[] = [];
  if (input.expectedProviders.length === 0) return out;
  for (const addr of input.candidates) {
    if (input.priced.has(addr)) continue;
    let definite = true;
    for (const provider of input.expectedProviders) {
      if (input.unhealthy.has(provider) || !input.asked.get(provider)?.has(addr)) {
        definite = false;
        break;
      }
    }
    if (definite) out.push(addr);
  }
  return out;
}
