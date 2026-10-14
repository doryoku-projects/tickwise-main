/**
 * The engines' answer cache (design §4.10): per query key, the materialised
 * answer of one generation (ordered ids + exact counts + its clusterTime and
 * data time), and the page rows read at that clusterTime.
 *
 * The accepted trade-off, as for every list cache: FRESH 15 s (served as is),
 * STALE up to 30 s (served while ONE background recompute replaces it), then
 * gone — with ±`jitter`. Single-flight per key. Byte-capped LRU with EXPLICIT
 * sizes (the values are typed arrays; `SwrCache`'s JSON sizing would
 * serialise them). `valid` lets the owner reject an entry whose catalog
 * instance has been rebuilt since (slots would mean other rows).
 */

export type ResultStatus = 'hit' | 'stale' | 'miss';

export interface ResultCacheOptions {
  freshMs: number;
  staleMs: number;
  maxBytes: number;
  jitter?: number;
  maxBackground?: number;
  now?: () => number;
  random?: () => number;
  onBackgroundError?: (key: string, err: unknown) => void;
}

interface Entry<V> {
  value: V;
  bytes: number;
  storedAt: number;
  freshUntil: number;
  staleUntil: number;
}

export class ResultCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly inflight = new Map<string, Promise<V>>();
  private bytes = 0;
  private background = 0;
  private readonly now: () => number;
  private readonly random: () => number;
  hits = 0;
  stale = 0;
  misses = 0;

  constructor(
    private readonly opts: ResultCacheOptions,
    private readonly sizeOf: (value: V) => number,
    private readonly valid: (value: V) => boolean = () => true,
  ) {
    this.now = opts.now ?? (() => Date.now());
    this.random = opts.random ?? Math.random;
  }

  get size(): number {
    return this.entries.size;
  }

  get totalBytes(): number {
    return this.bytes;
  }

  /** The servable entry for `key`, without loading. */
  peek(key: string): { value: V; status: 'hit' | 'stale'; storedAt: number } | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const now = this.now();
    if (now >= entry.staleUntil || !this.valid(entry.value)) {
      this.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return { value: entry.value, status: now < entry.freshUntil ? 'hit' : 'stale', storedAt: entry.storedAt };
  }

  /**
   * Serve `key`: fresh → hit; stale → the old value plus one background
   * recompute; else a single-flight load (`store: false` serves without
   * keeping it — an uncacheable plan).
   */
  async get(key: string, loader: () => Promise<V>, options: { store?: boolean } = {}): Promise<{ value: V; status: ResultStatus }> {
    const cached = this.peek(key);
    if (cached) {
      if (cached.status === 'stale') {
        this.stale++;
        this.refreshInBackground(key, loader, options);
      } else this.hits++;
      return { value: cached.value, status: cached.status };
    }
    this.misses++;
    return { value: await this.load(key, loader, options), status: 'miss' };
  }

  /** Load now (sharing an in-flight load). */
  load(key: string, loader: () => Promise<V>, options: { store?: boolean } = {}): Promise<V> {
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const run = (async () => {
      try {
        const value = await loader();
        if (options.store !== false) this.set(key, value);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, run);
    return run;
  }

  private refreshInBackground(key: string, loader: () => Promise<V>, options: { store?: boolean }): void {
    if (this.inflight.has(key) || this.background >= (this.opts.maxBackground ?? 4)) return;
    this.background++;
    this.load(key, loader, options)
      .catch((err) => this.opts.onBackgroundError?.(key, err))
      .finally(() => {
        this.background--;
      });
  }

  set(key: string, value: V): void {
    this.delete(key);
    const bytes = Math.max(1, this.sizeOf(value));
    if (bytes > this.opts.maxBytes) return;
    const jitter = this.opts.jitter ?? 0.1;
    const factor = 1 + (this.random() * 2 - 1) * jitter;
    const now = this.now();
    const freshMs = Math.max(0, this.opts.freshMs * factor);
    const staleMs = Math.max(freshMs, this.opts.staleMs * factor);
    this.entries.set(key, { value, bytes, storedAt: now, freshUntil: now + freshMs, staleUntil: now + staleMs });
    this.bytes += bytes;
    for (const [k] of this.entries) {
      if (this.bytes <= this.opts.maxBytes) break;
      this.delete(k);
    }
  }

  /** Re-account an entry whose value grew (page rows added). */
  resize(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    const bytes = Math.max(1, this.sizeOf(entry.value));
    this.bytes += bytes - entry.bytes;
    entry.bytes = bytes;
    for (const [k] of this.entries) {
      if (this.bytes <= this.opts.maxBytes) break;
      if (k === key) continue;
      this.delete(k);
    }
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

  stats() {
    return { entries: this.entries.size, bytes: this.bytes, hits: this.hits, stale: this.stale, misses: this.misses, inflight: this.inflight.size };
  }
}
