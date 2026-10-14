/**
 * Round-robin pool of API keys with per-key rate-limit windows.
 *
 * Each paid provider (Alchemy, Moralis, Chainbase) accepts a CSV of keys via
 * env. When one key hits 429, only that key is benched until its window
 * expires; other keys keep serving traffic. This effectively multiplies the
 * provider's free/paid tier by the number of keys provisioned.
 *
 * The cursor advances on every `pickAvailable()` call to spread load. If the
 * cursor lands on a benched key it scans forward (still round-robin) and
 * returns the first available; if every key is benched it returns `null`,
 * which the provider treats as a global unavailable signal.
 */
export interface PickedKey {
  key: string;
  index: number;
}

export class KeyPool {
  private cursor = 0;
  private readonly rateLimitedUntil: number[];
  /**
   * Per-key "next allowed log timestamp". `shouldLog(index)` returns true once
   * per backoff window per key, so providers stop spamming `key=N rate
   * limited` 30+ times in the same second.
   */
  private readonly logSilencedUntil: number[];

  constructor(private readonly keys: string[]) {
    this.rateLimitedUntil = new Array(keys.length).fill(0);
    this.logSilencedUntil = new Array(keys.length).fill(0);
  }

  /** Number of provisioned keys (0 → provider should report not-enabled). */
  get size(): number {
    return this.keys.length;
  }

  /** Picks the next available key in round-robin order, or null if all benched. */
  pickAvailable(now: number = Date.now()): PickedKey | null {
    if (this.keys.length === 0) return null;
    for (let attempt = 0; attempt < this.keys.length; attempt += 1) {
      const index = (this.cursor + attempt) % this.keys.length;
      const benchedUntil = this.rateLimitedUntil[index] ?? 0;
      if (now >= benchedUntil) {
        this.cursor = (index + 1) % this.keys.length;
        const key = this.keys[index];
        if (key) return { key, index };
      }
    }
    return null;
  }

  /** Mark a specific key rate-limited for `backoffMs` from now. */
  markRateLimited(index: number, backoffMs: number): void {
    if (index < 0 || index >= this.keys.length) return;
    this.rateLimitedUntil[index] = Date.now() + Math.max(0, backoffMs);
  }

  /**
   * Throttle helper for rate-limit logging. Returns `true` at most once per
   * `windowMs` per key, so concurrent in-flight requests that all hit the
   * same 429 wall don't each emit a log line. Default 30s window.
   */
  shouldLog(index: number, windowMs = 30_000): boolean {
    if (index < 0 || index >= this.keys.length) return false;
    const now = Date.now();
    if (now < (this.logSilencedUntil[index] ?? 0)) return false;
    this.logSilencedUntil[index] = now + windowMs;
    return true;
  }

  /** True if at least one key is currently available. */
  hasAvailable(now: number = Date.now()): boolean {
    if (this.keys.length === 0) return false;
    for (let i = 0; i < this.keys.length; i += 1) {
      if (now >= (this.rateLimitedUntil[i] ?? 0)) return true;
    }
    return false;
  }
}
