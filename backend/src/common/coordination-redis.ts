import { Inject, Injectable, Logger, Optional, type OnApplicationShutdown } from '@nestjs/common';
import { Redis, type RedisOptions } from 'ioredis';
import { AppConfigService } from '../config/app-config.service.js';
import { ROLE_OPTIONS } from '../read-models/models-redis.js';
import { RedisLease } from './redis-lease.js';

/**
 * P2 coordination on redis-state (`REDIS_URL`, AOF everysec, noeviction):
 * leases, fences, flow locks, status fan-in, and — for packages B/D/F — the
 * shared limiters, invalidation bus, write budget and fee signals.
 *
 * ONE lazily connected control client (P-R's control options: 1 s command
 * timeout, one retry, no offline queue), so a process that never turns a P2
 * flag on never connects. `client()` answers undefined only when Redis is
 * really unavailable (a failed connect, `reconnecting`, `end`) — every caller
 * treats that as "Redis unavailable" and applies its own fail-open/closed
 * rule (design §3.6). A caller that arrives WHILE a connect is in flight
 * waits for it (bounded by `CONNECT_WAIT_MS`) instead of reading the race as
 * an outage: P-R's `LazyClient` answered undefined to every caller but the
 * first, so at boot leases ran fail-open beside their real holder, split-role
 * flow locks failed closed and invalidation publishes were dropped — each with
 * a false `[alert] process_role.lease_unavailable`.
 *
 * `subscriber(name)` opens a SEPARATE connection per call (a subscribed
 * connection cannot run other commands); the caller owns and quits it.
 *
 * Keys: `tw:<family>:v1:<ns>:…`, `<ns>` = `leaderboardSnapshotNamespace`
 * (NODE_ENV + Mongo deployment hash), so two environments on one Redis never
 * share a lease. Satisfies D's `WriteBudgetRedisSource` (`client()`, `namespace`).
 */
export interface CoordinationRedisSource {
  client(): Promise<Redis | undefined>;
  readonly namespace: string;
}

/** The structural config view read here (all getters exist today). */
interface CoordinationConfigView {
  redisUrl?: string;
  leaderboardSnapshotNamespace?: string;
}

/** How long a caller waits for an in-flight connect (ioredis `connectTimeout` 2 s + margin). */
export const CONNECT_WAIT_MS = 2_500;

type ConnectState = { status: string };

/** Resolves once `redis` is ready, or on close / end / `ms`, whichever is first. Never rejects. */
function waitForReady(redis: Redis, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    if ((redis as unknown as ConnectState).status === 'ready') return resolve();
    const done = () => {
      clearTimeout(timer);
      redis.removeListener('ready', done);
      redis.removeListener('close', done);
      redis.removeListener('end', done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    timer.unref?.();
    redis.once('ready', done);
    redis.once('close', done);
    redis.once('end', done);
  });
}

/**
 * The control connection, shared by every caller of `client()` — including
 * callers that arrive while the first connect is still in flight.
 */
export class SharedControlClient {
  private redis?: Redis;
  private errorLoggedAt = 0;

  constructor(
    private readonly url: () => string,
    private readonly options: RedisOptions,
    private readonly name: string,
    private readonly logger: Pick<Logger, 'warn'>,
    private readonly waitMs: number = CONNECT_WAIT_MS,
  ) {}

  async get(): Promise<Redis | undefined> {
    if (!this.redis) {
      this.redis = new Redis(this.url(), { ...this.options, connectionName: this.name });
      this.redis.on('error', (err: unknown) => this.logError(err));
    }
    const redis = this.redis;
    const status = (): string => (redis as unknown as ConnectState).status;
    if (status() === 'ready') return redis;
    if (status() === 'wait') {
      // Start the connect; its outcome is observed through the status below
      // (every concurrent caller waits on the same connection's events).
      redis.connect().catch((err: unknown) => this.logError(err));
    }
    if (status() === 'connecting' || status() === 'connect') await waitForReady(redis, this.waitMs);
    return status() === 'ready' ? redis : undefined;
  }

  private logError(err: unknown): void {
    const now = Date.now();
    if (now - this.errorLoggedAt < 60_000) return;
    this.errorLoggedAt = now;
    this.logger.warn(`${this.name} unavailable: ${(err as Error)?.message ?? String(err)}`);
  }

  async quit(): Promise<void> {
    await this.redis?.quit().catch(() => undefined);
    this.redis = undefined;
  }
}

/** `tw:lease:v1:<ns>:<name>` — the lease/lock key of `name` in deployment `ns`. */
export function leaseKey(namespace: string, name: string): string {
  return `tw:lease:v1:${namespace}:${name}`;
}

/** `tw:lease:v1:<ns>:<name>:fence` — the monotonic fence counter of a lease. */
export function fenceKey(namespace: string, name: string): string {
  return `${leaseKey(namespace, name)}:fence`;
}

@Injectable()
export class CoordinationRedis implements OnApplicationShutdown, CoordinationRedisSource {
  private readonly logger = new Logger(CoordinationRedis.name);
  private readonly control: SharedControlClient;
  private readonly subscribers = new Set<Redis>();

  constructor(@Optional() @Inject(AppConfigService) private readonly config?: AppConfigService) {
    this.control = new SharedControlClient(() => this.url, ROLE_OPTIONS.control, 'tw-coord', this.logger);
  }

  get url(): string {
    return (this.config as unknown as CoordinationConfigView | undefined)?.redisUrl ?? 'redis://localhost:6379';
  }

  /** The deployment namespace (`leaderboardSnapshotNamespace`; `local` without config). */
  get namespace(): string {
    return (this.config as unknown as CoordinationConfigView | undefined)?.leaderboardSnapshotNamespace ?? 'local';
  }

  /** The control client (waiting for an in-flight connect), or undefined when unreachable. Never throws. */
  async client(): Promise<Redis | undefined> {
    try {
      return await this.control.get();
    } catch {
      return undefined;
    }
  }

  /** `tw:<family>:v1:<ns>:<parts…>`. */
  key(family: string, ...parts: Array<string | number>): string {
    return [`tw:${family}:v1:${this.namespace}`, ...parts.map(String)].join(':');
  }

  leaseKey(name: string): string {
    return leaseKey(this.namespace, name);
  }

  /** A `RedisLease` on `tw:lease:v1:<ns>:<name>` over this control client. */
  lease(name: string, ttlMs: number, owner?: string): RedisLease {
    return new RedisLease(() => this.client(), this.leaseKey(name), ttlMs, owner);
  }

  /**
   * A NEW connection for SUBSCRIBE (no command timeout: a subscribed
   * connection idles). Lazily connected; closed with the module.
   */
  subscriber(name: string, options: RedisOptions = {}): Redis {
    const redis = new Redis(this.url, {
      lazyConnect: true,
      connectTimeout: 2_000,
      keepAlive: 10_000,
      maxRetriesPerRequest: null,
      retryStrategy: (times) => Math.min(times * 1_000, 30_000),
      ...options,
      connectionName: `tw-coord-sub-${name}`,
    });
    redis.on('error', () => undefined);
    this.subscribers.add(redis);
    redis.once('end', () => this.subscribers.delete(redis));
    return redis;
  }

  /** Close the control client and every subscriber (an owner of a private instance calls this). */
  async close(): Promise<void> {
    await Promise.all([...this.subscribers].map((redis) => redis.quit().catch(() => undefined)));
    this.subscribers.clear();
    await this.control.quit();
  }

  /**
   * The Nest-built client closes in the LAST shutdown phase, never in
   * `onModuleDestroy` (integrator, I1): Nest runs every module's destroy hooks
   * concurrently, so a lease holder releasing its lease there (the scheduler,
   * the live loops, `fee-worker`) raced this quit and lost — the lease then
   * lingered until its TTL and the next holder waited it out. Every holder's
   * release finishes in `onModuleDestroy`; the connection outlives it.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.close();
  }
}
