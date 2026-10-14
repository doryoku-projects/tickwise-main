/**
 * In-process stale-while-revalidate cache for the user-facing read path
 * (leaderboard windows, pool pages, counts). No dependency: a `Map` kept in
 * recency order is the LRU, and its byte budget is the JSON length of each
 * value at store time — an approximation of heap cost that is cheap to take and
 * proportional to what the entry costs to serve.
 *
 * Semantics, per entry (all ages measured from when the value was LOADED):
 *  - `age < freshMs`   → `hit`, served as is.
 *  - `age < staleMs`   → `stale`, served immediately while ONE background
 *                        refresh replaces it (at most `maxBackgroundRefreshes`
 *                        in flight; past that the refresh is skipped and the
 *                        next request tries again).
 *  - `age < staleMs + fallbackMs` → invisible to `get`, but still returned by
 *                        `peekFallback`, which is what a route serves when the
 *                        database times out rather than answering a 503.
 *  - older             → gone.
 * Both TTLs carry ±20% jitter per entry so a set of keys stored together (a
 * warmup cycle) does not expire together and stampede the database.
 *
 * A miss is single-flight per key: concurrent requests for the same key share
 * one load. A failed load is not cached and propagates to every waiter.
 *
 * DATA AGE vs CACHE AGE. Every entry also carries `dataAt`: when the data it
 * holds was current — its load time less the replication lag of the read
 * (`dataLag`, for caches fed from secondaries), or the oldest input of a
 * composed value. The TTLs above run on the load time (a lagging secondary
 * must not turn every entry into a miss and multiply the reads that made it
 * lag); `dataAt` is what decides whether an answer may pass as within the
 * staleness budget (`staleSince`).
 */

export type CacheStatus = 'hit' | 'stale' | 'miss';

/** Out-parameter a read path fills so its controller can set `X-Cache` / `Cache-Control`. */
export interface ReadMeta {
  cache?: CacheStatus;
  /**
   * The answer must not be stored by any cache in front of the API: a
   * `partial` all-chains page, a `stale` timeout fallback, a count still
   * `pending`. `withReadHeaders` sends `Cache-Control: no-store`.
   */
  noStore?: boolean;
}

export interface SwrTtl {
  /** How long a value is served without revalidating. */
  freshMs: number;
  /** Total age after which `get` stops serving the value (≥ freshMs). */
  staleMs: number;
}

export interface SwrCacheOptions extends SwrTtl {
  /** For log lines only. */
  name: string;
  /** Byte budget across all entries (JSON length). */
  maxBytes: number;
  /** Retention past `staleMs` usable only by `peekFallback`. Default: staleMs. */
  fallbackMs?: number;
  /** ± fraction applied to both TTLs per entry. Default 0.2. */
  jitter?: number;
  /** Concurrent stale-entry refreshes. Default 4. */
  maxBackgroundRefreshes?: number;
  /** Entry-count ceiling, alongside the byte budget. Default 10 000. */
  maxEntries?: number;
  /** Called when a background refresh fails (the old value is kept). */
  onBackgroundError?: (key: string, err: unknown) => void;
  /**
   * How far behind the primary the data a load reads is, in ms (the
   * replication lag of a secondary read: `userReadLagMs`). Subtracted from the
   * load time to give the entry's `dataAt`. Default 0.
   */
  dataLag?: () => number;
  now?: () => number;
  random?: () => number;
}

export interface SwrGetOptions<T> {
  /** Per-call TTL; a function sees the loaded value and how long the load took. */
  ttl?: SwrTtl | ((value: T, loadMs: number) => SwrTtl);
  /** Return false to serve a loaded value without storing it. */
  shouldStore?: (value: T) => boolean;
  /**
   * A value COMPOSED from inputs that are themselves cached: how old its
   * oldest input already was. `storedAt` backdates the entry's TTLs (so cache
   * ages do not stack: a detail built from a 25 s old count is 25 s old, not
   * new), `dataAt` its data age. Each is capped at the load time.
   */
  times?: (value: T) => { storedAt?: number; dataAt?: number };
}

interface Entry<T> {
  value: T;
  bytes: number;
  storedAt: number;
  /** When the data was current (≤ storedAt): the load time less the read's replication lag. */
  dataAt: number;
  freshUntil: number;
  staleUntil: number;
  keepUntil: number;
}

export class SwrCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private readonly inflight = new Map<string, Promise<T>>();
  private bytes = 0;
  private backgroundActive = 0;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly opts: SwrCacheOptions) {
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
  }

  get size(): number {
    return this.entries.size;
  }

  get totalBytes(): number {
    return this.bytes;
  }

  /** The servable value for `key`, without loading anything. */
  peek(key: string): { value: T; status: 'hit' | 'stale'; ageMs: number; dataAt: number } | undefined {
    const entry = this.live(key);
    if (!entry) return undefined;
    const now = this.now();
    if (now >= entry.staleUntil) return undefined;
    this.touch(key, entry);
    return {
      value: entry.value,
      status: now < entry.freshUntil ? 'hit' : 'stale',
      ageMs: now - entry.storedAt,
      dataAt: entry.dataAt,
    };
  }

  /** Any retained value, however stale — the database-timeout fallback. */
  peekFallback(key: string): T | undefined {
    return this.live(key)?.value;
  }

  /**
   * `peekFallback` with WHEN the value was loaded, so a route serving it can
   * say how old it is (`stale: true` + `dataAsOf`) — anything past the stale
   * age is older than the staleness budget allows unflagged.
   */
  peekRetained(key: string): { value: T; storedAt: number; dataAt: number; pastStale: boolean } | undefined {
    const entry = this.live(key);
    if (!entry) return undefined;
    return { value: entry.value, storedAt: entry.storedAt, dataAt: entry.dataAt, pastStale: this.now() >= entry.staleUntil };
  }

  /**
   * Serve `key`: fresh → hit; stale → the old value now plus one background
   * refresh; otherwise await a single-flight load.
   */
  async get(
    key: string,
    loader: () => Promise<T>,
    options: SwrGetOptions<T> = {},
  ): Promise<{ value: T; status: CacheStatus; dataAt: number }> {
    const cached = this.peek(key);
    if (cached) {
      if (cached.status === 'stale') this.refreshInBackground(key, loader, options);
      return { value: cached.value, status: cached.status, dataAt: cached.dataAt };
    }
    const value = await this.refresh(key, loader, options);
    const stored = this.entries.get(key);
    const dataAt = stored && stored.value === value ? stored.dataAt : this.dataAtOf(value, options);
    return { value, status: 'miss', dataAt };
  }

  /** The `dataAt` of a value loaded now (not stored, or no longer). */
  private dataAtOf(value: T, options: SwrGetOptions<T>): number {
    const now = this.now();
    const own = now - Math.max(0, this.opts.dataLag?.() ?? 0);
    const times = options.times?.(value);
    return Math.min(own, times?.dataAt ?? Infinity, times?.storedAt ?? Infinity);
  }

  /** Load and store `key` now, sharing an in-flight load if there is one. */
  refresh(key: string, loader: () => Promise<T>, options: SwrGetOptions<T> = {}): Promise<T> {
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const startedAt = this.now();
    const run = (async () => {
      try {
        const value = await loader();
        if (options.shouldStore?.(value) !== false) {
          const loadMs = this.now() - startedAt;
          const ttl = typeof options.ttl === 'function' ? options.ttl(value, loadMs) : options.ttl;
          const times = options.times?.(value);
          const now = this.now();
          const storedAt = Math.min(now, times?.storedAt ?? now);
          this.set(key, value, { ttl, storedAt, dataAt: this.dataAtOf(value, options) });
        }
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, run);
    return run;
  }

  /**
   * Fire-and-forget refresh, bounded by `maxBackgroundRefreshes`. Returns false
   * when it was skipped (saturated, or a load is already in flight). A failure
   * keeps whatever is stored.
   */
  refreshInBackground(key: string, loader: () => Promise<T>, options: SwrGetOptions<T> = {}): boolean {
    if (this.inflight.has(key)) return false;
    if (this.backgroundActive >= (this.opts.maxBackgroundRefreshes ?? 4)) return false;
    this.backgroundActive++;
    this.refresh(key, loader, options)
      .catch((err) => this.opts.onBackgroundError?.(key, err))
      .finally(() => {
        this.backgroundActive--;
      });
    return true;
  }

  /**
   * Store a value. `storedAt` backdates it (a snapshot loaded from Redis is as
   * old as when it was computed, not when this process read it); `dataAt`
   * (default: `storedAt` less `dataLag`) is when its data was current.
   * Returns false when the value alone exceeds the budget or is already past
   * its retention.
   */
  set(key: string, value: T, options: { ttl?: SwrTtl; storedAt?: number; dataAt?: number } = {}): boolean {
    this.delete(key);
    const bytes = sizeOf(value);
    if (bytes > this.opts.maxBytes) return false;
    const ttl = options.ttl ?? this.opts;
    const jitter = this.opts.jitter ?? 0.2;
    const factor = 1 + (this.random() * 2 - 1) * jitter;
    const storedAt = options.storedAt ?? this.now();
    const dataAt = Math.min(storedAt, options.dataAt ?? storedAt - Math.max(0, this.opts.dataLag?.() ?? 0));
    const freshMs = Math.max(0, ttl.freshMs * factor);
    const staleMs = Math.max(freshMs, ttl.staleMs * factor);
    const entry: Entry<T> = {
      value,
      bytes,
      storedAt,
      dataAt,
      freshUntil: storedAt + freshMs,
      staleUntil: storedAt + staleMs,
      keepUntil: storedAt + staleMs + (this.opts.fallbackMs ?? ttl.staleMs),
    };
    if (entry.keepUntil <= this.now()) return false;
    this.entries.set(key, entry);
    this.bytes += bytes;
    this.evict();
    return true;
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.bytes -= entry.bytes;
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }

  /** The entry for `key` if it is still retained (dropping it if not). */
  private live(key: string): Entry<T> | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() >= entry.keepUntil) {
      this.delete(key);
      return undefined;
    }
    return entry;
  }

  /** Move to the most-recently-used end. */
  private touch(key: string, entry: Entry<T>): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  private evict(): void {
    const maxEntries = this.opts.maxEntries ?? 10_000;
    for (const [key] of this.entries) {
      if (this.bytes <= this.opts.maxBytes && this.entries.size <= maxEntries) return;
      this.delete(key);
    }
  }
}

/** JSON length of a value — the budget unit. Unserialisable values cost 0. */
function sizeOf(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

/**
 * A deterministic string for a query description: object keys sorted, `undefined`
 * dropped, RegExp and Date given a distinct form (JSON would turn a RegExp into
 * `{}` and make every search key collide). Used to derive cache keys from the
 * query a route ACTUALLY runs, so a parameter that changes the result cannot be
 * left out of the key by omission.
 */
export function stableKey(value: unknown): string {
  if (value === undefined) return 'u';
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'bigint') return `n${String(value)}`;
  if (typeof value === 'boolean') return value ? 'T' : 'F';
  if (typeof value === 'string') return JSON.stringify(value);
  if (value instanceof RegExp) return `re${JSON.stringify(value.source)}/${value.flags}`;
  if (value instanceof Date) return `d${value.toISOString()}`;
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableKey(record[k])}`).join(',')}}`;
  }
  return String(value);
}

/**
 * The list read path's TTLs: positions + pools windows, list counts, pool
 * detail and pool holder counts — fresh 15 s, served stale (one background
 * refresh) up to 30 s, from `LEADERBOARD_LIST_FRESH_MS` / `_STALE_MS`, which
 * the config keeps inside the staleness budget. The list caches jitter by
 * ±10 % (`LIST_CACHE_JITTER`), so the oldest unflagged answer is
 * stale × 1.1 (33 s at the defaults) plus replication lag.
 */
export const LIST_CACHE_DEFAULTS: SwrTtl = { freshMs: 15_000, staleMs: 30_000 };
export const LIST_CACHE_JITTER = 0.1;

export function listCacheTtl(config?: { leaderboardListFreshMs?: number; leaderboardListStaleMs?: number }): SwrTtl {
  const freshMs = config?.leaderboardListFreshMs ?? LIST_CACHE_DEFAULTS.freshMs;
  const staleMs = config?.leaderboardListStaleMs ?? LIST_CACHE_DEFAULTS.staleMs;
  return { freshMs, staleMs: Math.max(freshMs, staleMs) };
}

/**
 * The `dataAsOf` an answer must carry: `dataAt` when its data is older than
 * the staleness budget allows unflagged (a timeout fallback, a read from a
 * secondary lagging past the budget, a deep page from an aged ladder rung),
 * else undefined. The ONE rule for "may this pass as fresh".
 */
export function staleSince(dataAt: number | undefined, budgetMs: number, now: number = Date.now()): number | undefined {
  return dataAt !== undefined && now - dataAt > budgetMs ? dataAt : undefined;
}

/** The staleness budget (`READ_STALENESS_BUDGET_MS`), defaulted for specs that pass no config. */
export function stalenessBudgetMs(config?: { readStalenessBudgetMs?: number }): number {
  return config?.readStalenessBudgetMs ?? 45_000;
}

/** The status of a response assembled from several cached reads (all-chains). */
export function combineCacheStatus(statuses: CacheStatus[]): CacheStatus {
  if (statuses.length === 0 || statuses.includes('miss')) return 'miss';
  return statuses.includes('stale') ? 'stale' : 'hit';
}

/** Rows a list cache stores per (shard, query): pages are served from it. */
export const LIST_WINDOW_STEP = 50;
/** Deeper than this a page is read directly and never cached. */
export const LIST_WINDOW_MAX_ROWS = 1000;

/**
 * The window a page falls in — `ceil(page × limit / 50) × 50` rows from the top —
 * or null when that is too deep to be worth caching. Page 1 and page 2 of a
 * 25-row view share the 50-row window, and the all-chains merge, which needs
 * each shard's top `page × limit`, lands on exactly the same windows as the
 * single-chain views.
 */
export function listWindowRows(page: number, limit: number): number | null {
  const rows = Math.ceil((page * limit) / LIST_WINDOW_STEP) * LIST_WINDOW_STEP;
  return rows > LIST_WINDOW_MAX_ROWS ? null : rows;
}
