import { Inject, Injectable, Logger, Optional, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { AppConfigService } from '../../config/app-config.service.js';

/**
 * The read path's own lazily-connected Redis client: the global read budget
 * (`tw:rb:v1:*`) and the deep-page ladder (`tw:lad:v1:*`). Every key it
 * writes carries a TTL. Fail-open by construction: `client()` answers
 * undefined while Redis is off (`READ_PATH_REDIS_ENABLED`, unset = production
 * only), still connecting, or unreachable, and every caller then falls back to
 * a per-process copy — the read path never waits on, or fails because of,
 * this connection.
 *
 * Same connection options as the leaderboard snapshot client: no offline
 * queue (a command fails at once instead of piling up while disconnected), a
 * 1 s command timeout, one retry per request.
 */
@Injectable()
export class ReadPathRedis implements OnModuleDestroy {
  private readonly logger = new Logger(ReadPathRedis.name);
  private redis?: Redis;
  private errorLoggedAt = 0;

  constructor(@Optional() @Inject(AppConfigService) private readonly config?: AppConfigService) {}

  /** Namespace of every key: the deployment the data came from (`leaderboardSnapshotNamespace`). */
  get namespace(): string {
    return this.config?.leaderboardSnapshotNamespace ?? 'local';
  }

  /** The client once connected; undefined when disabled or unreachable. */
  async client(): Promise<Redis | undefined> {
    if (!this.config?.readPathRedisEnabled) return undefined;
    if (!this.redis) {
      this.redis = new Redis(this.config.redisUrl, {
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        connectTimeout: 2_000,
        commandTimeout: 1_000,
        retryStrategy: (times) => Math.min(times * 1_000, 30_000),
      });
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

  /** At most one line a minute: a Redis outage must not flood the log from the read path. */
  logError(err: unknown): void {
    const now = Date.now();
    if (now - this.errorLoggedAt < 60_000) return;
    this.errorLoggedAt = now;
    this.logger.warn(`Read-path Redis unavailable (per-process fallback): ${(err as Error)?.message ?? String(err)}`);
  }

  onModuleDestroy(): void {
    void this.redis?.quit().catch(() => undefined);
  }
}
