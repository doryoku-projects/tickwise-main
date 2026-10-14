import { Inject, Injectable, Logger, Optional, type OnModuleDestroy } from '@nestjs/common';
import { Redis, type RedisOptions } from 'ioredis';
import { AppConfigService } from '../config/app-config.service.js';

/**
 * The read models' Redis clients (design §2.3).
 *
 * redis-models (`REDIS_MODELS_URL`, else `REDIS_URL`) — three lazily
 * connected clients, because ioredis applies `commandTimeout` to every
 * command (`XREAD BLOCK` included) and one connection serialises its commands:
 *  - control  — fenced append, fence seed, incarnation, manifest: 1 s command
 *               timeout, one retry, no offline queue;
 *  - blocking — `XREAD BLOCK 1000`: no command timeout, a client-side blocking
 *               timeout of BLOCK + 2 s;
 *  - bulk     — snapshot chunks: 10 s command timeout.
 * redis-state (`REDIS_URL`) has its own client: `state-redis.ts`.
 *
 * Nothing here connects until a read model is on (`off` makes no Redis
 * connection and writes no key). `client()` answers undefined while
 * connecting or unreachable; callers treat that as "Redis unavailable".
 */

type Role = 'control' | 'blocking' | 'bulk';

const BASE: RedisOptions = {
  lazyConnect: true,
  enableOfflineQueue: false,
  connectTimeout: 2_000,
  keepAlive: 10_000,
  retryStrategy: (times) => Math.min(times * 1_000, 30_000),
};

export const ROLE_OPTIONS: Record<Role, RedisOptions> = {
  control: { ...BASE, commandTimeout: 1_000, maxRetriesPerRequest: 1 },
  blocking: { ...BASE, maxRetriesPerRequest: 1, blockingTimeout: 1_000, blockingTimeoutGrace: 2_000 },
  bulk: { ...BASE, commandTimeout: 10_000, maxRetriesPerRequest: 1 },
};

/**
 * redis-models control: a command whose reply was lost in a reconnect is
 * REJECTED, never resent — the fenced append is not idempotent, and a resent
 * EVAL that already ran turns into a `seq_gap` refusal. The holder retries the
 * same entry and recognises its own landed entry instead (holder.ts `landedAs`).
 */
export const MODELS_CONTROL_OPTIONS: RedisOptions = { ...ROLE_OPTIONS.control, autoResendUnfulfilledCommands: false };

export class LazyClient {
  private redis?: Redis;
  private errorLoggedAt = 0;

  constructor(
    private readonly url: () => string,
    private readonly options: RedisOptions,
    private readonly name: string,
    private readonly logger: Logger,
  ) {}

  async get(): Promise<Redis | undefined> {
    if (!this.redis) {
      this.redis = new Redis(this.url(), { ...this.options, connectionName: this.name });
      this.redis.on('error', (err) => this.logError(err));
    }
    const redis = this.redis;
    if (redis.status === 'ready') return redis;
    if (redis.status === 'wait') {
      try {
        await redis.connect();
      } catch (err) {
        this.logError(err);
      }
    }
    return (redis.status as string) === 'ready' ? redis : undefined;
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

@Injectable()
export class ModelsRedis implements OnModuleDestroy {
  private readonly logger = new Logger(ModelsRedis.name);
  private readonly clients: Record<Role, LazyClient>;

  constructor(@Optional() @Inject(AppConfigService) private readonly config?: AppConfigService) {
    const url = () => this.url;
    this.clients = {
      control: new LazyClient(url, MODELS_CONTROL_OPTIONS, 'tw-rm-control', this.logger),
      blocking: new LazyClient(url, ROLE_OPTIONS.blocking, 'tw-rm-blocking', this.logger),
      bulk: new LazyClient(url, ROLE_OPTIONS.bulk, 'tw-rm-bulk', this.logger),
    };
  }

  get url(): string {
    return this.config?.redisModelsUrl ?? 'redis://localhost:6379';
  }

  /** True when REDIS_MODELS_URL names its own instance. */
  get separate(): boolean {
    return this.config?.redisModelsSeparate ?? false;
  }

  control(): Promise<Redis | undefined> {
    return this.clients.control.get();
  }

  blocking(): Promise<Redis | undefined> {
    return this.clients.blocking.get();
  }

  bulk(): Promise<Redis | undefined> {
    return this.clients.bulk.get();
  }

  /**
   * The boot check (§2.3): `maxmemory-policy` must be `noeviction` (an evicted
   * chunk or stream entry is silent data loss) and `maxmemory` must be set (an
   * unbounded instance OOMs instead of refusing writes). A managed Redis that
   * refuses `CONFIG` is not an alert.
   */
  async checkPolicy(): Promise<{ policy?: string; maxmemory?: number; alerts: string[]; refused?: boolean }> {
    const redis = await this.control();
    if (!redis) return { alerts: [] };
    try {
      const policy = (await redis.config('GET', 'maxmemory-policy')) as string[];
      const max = (await redis.config('GET', 'maxmemory')) as string[];
      const policyValue = policy?.[1];
      const maxmemory = Number(max?.[1]);
      const alerts: string[] = [];
      if (policyValue && policyValue !== 'noeviction') alerts.push('read_models.redis_policy');
      if (Number.isFinite(maxmemory) && maxmemory === 0) alerts.push('read_models.redis_maxmemory');
      return { policy: policyValue, maxmemory: Number.isFinite(maxmemory) ? maxmemory : undefined, alerts };
    } catch {
      return { alerts: [], refused: true };
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(Object.values(this.clients).map((client) => client.quit()));
  }
}
