import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { RateLimiterMemory, RateLimiterRedis } from 'rate-limiter-flexible';
import { AppConfigService } from '../config/app-config.service.js';
import { CoordinationRedis } from './coordination-redis.js';
import { onceAMinute, sharedStateRedis, type SharedStateRedisSource } from './redis-gcra.js';

/**
 * P2.2 §3.1 — where the auth brute-force limiters keep their counters.
 *
 *   AUTH_LIMITER_STORE=memory (default)  `RateLimiterMemory`, per process —
 *                                        EXACTLY today's object.
 *   AUTH_LIMITER_STORE=redis             `RateLimiterRedis` on redis-state,
 *                                        keyPrefix `rl:v1:<ns>:<realm>:<name>`,
 *                                        so every replica spends ONE budget per
 *                                        key; a `RateLimiterMemory` of the same
 *                                        shape is its insurance limiter.
 *
 * Fail OPEN to today: while Redis is unavailable (no client yet, a command
 * error, a timeout) every consume/delete goes to the insurance limiter — the
 * per-process budget each replica has today — and `[alert]
 * auth_limiter.insurance` is logged at most once a minute. A rate-limit
 * REJECTION (`RateLimiterRes`) is never an error and is never retried on the
 * insurance limiter: the library rejects it as-is.
 *
 * Callers keep their points, durations, realm-namespaced keys and their two
 * calls (`consume`, `delete`); only the object behind them changes.
 */

/** The two calls every auth limiter caller makes. `RateLimiterMemory` satisfies it. */
export interface AuthLimiter {
  consume(key: string, points?: number): Promise<unknown>;
  delete(key: string): Promise<unknown>;
  /**
   * Give `points` back (a refund: a request that cost less than it was charged
   * up front). Never rejects for being under the limit. The auth limiters never
   * call it; the `/api` budget does.
   */
  reward(key: string, points?: number): Promise<unknown>;
}

export interface AuthLimiterSpec {
  points: number;
  /** Seconds. */
  duration: number;
  /**
   * This limiter's own store; unset = the factory's `AUTH_LIMITER_STORE`. A
   * feature that must not share the auth limiters' rollback (the `/api` budget:
   * `API_LIMITER_STORE`) names its own.
   */
  store?: AuthLimiterStore;
}

export type AuthLimiterStore = 'memory' | 'redis';

/** The structural config view read here (getters added by the integrator; absent = today). */
interface LimiterConfigView {
  authLimiterStore?: string;
  leaderboardSnapshotNamespace?: string;
  redisUrl?: string;
}

/** `rl:v1:<ns>:<realm>:<name>` — one prefix per limiter; a spec asserts every one is distinct. */
export function authLimiterPrefix(namespace: string, realm: string, name: string): string {
  return `rl:v1:${namespace}:${realm}:${name}`;
}

export function resolveAuthLimiterStore(value: unknown): AuthLimiterStore {
  return typeof value === 'string' && value.trim().toLowerCase() === 'redis' ? 'redis' : 'memory';
}

export interface LimiterStats {
  store: AuthLimiterStore;
  limiters: number;
  /** Consumes/deletes that went to the insurance limiter (Redis unavailable or erroring). */
  insuranceHits: number;
  prefixes: string[];
}

/**
 * The insurance limiter: a `RateLimiterMemory` (so the library accepts it)
 * that counts every call routed to it.
 */
class InsuranceLimiter extends RateLimiterMemory {
  constructor(
    spec: AuthLimiterSpec,
    private readonly onUse: () => void,
  ) {
    super({ points: spec.points, duration: spec.duration });
  }

  override consume(key: string | number, pointsToConsume?: number, options?: object): ReturnType<RateLimiterMemory['consume']> {
    this.onUse();
    return super.consume(key, pointsToConsume, options);
  }

  override delete(key: string | number, options?: object): ReturnType<RateLimiterMemory['delete']> {
    this.onUse();
    return super.delete(key, options);
  }

  /** Clear a key here without counting it as an insurance hit. */
  quietDelete(key: string): Promise<unknown> {
    return super.delete(key).catch(() => undefined);
  }
}

/**
 * A limiter whose store is redis-state, resolved PER CALL: the control client
 * is lazy and may not be ready at construction (or may come back after an
 * outage), so the `RateLimiterRedis` is (re)bound to whichever client
 * `source()` answers, and no client means the insurance limiter.
 */
export class SharedAuthLimiter implements AuthLimiter {
  private redisLimiter?: RateLimiterRedis;
  private boundTo?: Redis;

  constructor(
    private readonly source: () => Promise<Redis | undefined>,
    readonly keyPrefix: string,
    private readonly spec: AuthLimiterSpec,
    private readonly insurance: InsuranceLimiter,
  ) {}

  private async target(): Promise<AuthLimiter> {
    const client = await this.source().catch(() => undefined);
    if (!client) return this.insurance;
    if (this.boundTo !== client || !this.redisLimiter) {
      this.redisLimiter = new RateLimiterRedis({
        storeClient: client,
        keyPrefix: this.keyPrefix,
        points: this.spec.points,
        duration: this.spec.duration,
        insuranceLimiter: this.insurance,
        // A client that is not `ready` goes straight to the insurance limiter
        // rather than waiting on a command that cannot be sent.
        rejectIfRedisNotReady: true,
      });
      this.boundTo = client;
    }
    return this.redisLimiter;
  }

  async consume(key: string, points = 1): Promise<unknown> {
    return (await this.target()).consume(key, points);
  }

  async reward(key: string, points = 1): Promise<unknown> {
    return (await this.target()).reward(key, points);
  }

  /**
   * Reset `key` (a successful login). Cleared in the insurance store as well,
   * so counts left over from an earlier outage cannot lock the address out
   * during the next one.
   */
  async delete(key: string): Promise<unknown> {
    const target = await this.target();
    const out = await target.delete(key);
    if (target !== this.insurance) await this.insurance.quietDelete(key);
    return out;
  }
}

@Injectable()
export class LimiterFactory {
  private readonly logger = new Logger(LimiterFactory.name);
  private readonly prefixes = new Set<string>();
  private insuranceHits = 0;
  private source?: SharedStateRedisSource;

  constructor(
    @Optional() @Inject(AppConfigService) private readonly config?: AppConfigService,
    @Optional() @Inject(CoordinationRedis) private readonly redis?: SharedStateRedisSource,
  ) {}

  get store(): AuthLimiterStore {
    return resolveAuthLimiterStore((this.config as unknown as LimiterConfigView | undefined)?.authLimiterStore);
  }

  private get namespace(): string {
    return this.stateRedis().namespace;
  }

  private stateRedis(): SharedStateRedisSource {
    this.source ??= sharedStateRedis(this.redis, this.config);
    return this.source;
  }

  /**
   * A limiter of `points` per `duration` seconds for `realm`/`name`. With the
   * store `memory` this is a plain `RateLimiterMemory({points, duration})`.
   */
  create(realm: string, name: string, spec: AuthLimiterSpec): AuthLimiter {
    if ((spec.store ?? this.store) === 'memory') return new RateLimiterMemory({ points: spec.points, duration: spec.duration });
    // A second service instance asking for the same realm/name shares the
    // budget, which is the point; distinct limiters must have distinct names
    // (test/shared-state/limiter-factory.spec.ts asserts all of them).
    const prefix = authLimiterPrefix(this.namespace, realm, name);
    this.prefixes.add(prefix);
    const insurance = new InsuranceLimiter(spec, () => this.onInsurance(prefix));
    return new SharedAuthLimiter(() => this.stateRedis().client(), prefix, spec, insurance);
  }

  stats(): LimiterStats {
    return { store: this.store, limiters: this.prefixes.size, insuranceHits: this.insuranceHits, prefixes: [...this.prefixes].sort() };
  }

  private onInsurance(prefix: string): void {
    this.insuranceHits += 1;
    if (onceAMinute('auth_limiter.insurance')) {
      this.logger.warn(
        `[alert] auth_limiter.insurance prefix=${prefix} hits=${this.insuranceHits} — redis-state unavailable, ` +
          'auth limiters on their per-process insurance budget (today\'s behaviour)',
      );
    }
  }
}

/** What a service uses when no `LimiterFactory` was injected: today's memory limiters. */
export const MEMORY_LIMITER_FACTORY: Pick<LimiterFactory, 'create'> = {
  create: (_realm: string, _name: string, spec: AuthLimiterSpec): AuthLimiter =>
    new RateLimiterMemory({ points: spec.points, duration: spec.duration }),
};
