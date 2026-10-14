import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import type { Redis } from 'ioredis';

/**
 * A Redis lease: ONE holder at a time across every process, for work that
 * must run once rather than once per replica (today `/v1/stats`; Phase 2's
 * leader-only pollers, crons and worker locks reuse it).
 *
 * `SET key owner NX PX ttl` takes it; renew and release are compare-and-set in
 * Lua, so a holder whose lease EXPIRED (it stalled past the TTL and someone
 * else took over) can neither extend nor delete the new holder's lease. The
 * TTL is the safety net, not the release path: a holder that dies just stops
 * renewing, and the lease frees itself.
 *
 * Fail-OPEN is the caller's call: `acquire` answers `'unavailable'` when there
 * is no Redis (off, connecting, unreachable, or a command error), so a caller
 * can decide whether to run the work locally (a cache refresh) or skip it (a
 * job that must never run twice).
 */
export type LeaseAcquireResult = 'acquired' | 'held' | 'unavailable';

/** Extend the lease only if WE still hold it. */
export const RENEW_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0
`;

/** Delete the lease only if WE still hold it. */
export const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/** `host:pid:random` — unique per lease object, readable in `redis-cli GET`. */
export function leaseOwnerId(): string {
  return `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
}

export class RedisLease {
  readonly owner: string;

  /**
   * @param redis   the client, or undefined when Redis is off / unreachable
   *                (resolved per call — e.g. `ReadPathRedis.client()`).
   * @param key     the lease key (namespace it by deployment).
   * @param ttlMs   how long a holder keeps it without renewing.
   */
  constructor(
    private readonly redis: () => Promise<Redis | undefined>,
    readonly key: string,
    readonly ttlMs: number,
    owner?: string,
  ) {
    this.owner = owner ?? leaseOwnerId();
  }

  /** Take the lease if nobody holds it (re-taking our own lease extends it). */
  async acquire(): Promise<LeaseAcquireResult> {
    const redis = await this.redis().catch(() => undefined);
    if (!redis) return 'unavailable';
    try {
      const set = await redis.set(this.key, this.owner, 'PX', Math.max(1, Math.floor(this.ttlMs)), 'NX');
      if (set === 'OK') return 'acquired';
      // Ours already (a re-entrant acquire): extend it rather than refuse ourselves.
      return (await this.renew()) ? 'acquired' : 'held';
    } catch {
      return 'unavailable';
    }
  }

  /** Extend our lease to a full TTL; false when we no longer hold it (or Redis is gone). */
  async renew(): Promise<boolean> {
    const redis = await this.redis().catch(() => undefined);
    if (!redis) return false;
    try {
      return Number(await redis.eval(RENEW_SCRIPT, 1, this.key, this.owner, String(Math.max(1, Math.floor(this.ttlMs))))) === 1;
    } catch {
      return false;
    }
  }

  /** Give the lease back early (only ours). Never throws. */
  async release(): Promise<void> {
    const redis = await this.redis().catch(() => undefined);
    if (!redis) return;
    try {
      await redis.eval(RELEASE_SCRIPT, 1, this.key, this.owner);
    } catch {
      // The TTL frees it anyway.
    }
  }
}

/**
 * Run `work` while holding `lease`, releasing it after. `held` and
 * `unavailable` do not run it — the caller decides what each means.
 */
export async function withLease<T>(
  lease: RedisLease,
  work: () => Promise<T>,
): Promise<{ ran: true; value: T } | { ran: false; reason: 'held' | 'unavailable' }> {
  const got = await lease.acquire();
  if (got !== 'acquired') return { ran: false, reason: got };
  try {
    return { ran: true, value: await work() };
  } finally {
    await lease.release();
  }
}
