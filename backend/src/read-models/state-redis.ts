import { Inject, Injectable, Logger, Optional, type OnModuleDestroy } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AppConfigService } from '../config/app-config.service.js';
import { LazyClient, ROLE_OPTIONS } from './models-redis.js';

/**
 * The read models' redis-state client (`REDIS_URL`, AOF everysec,
 * noeviction — design §2.3): AUTHORITY and control, never data — the feeder
 * lease, the fence authority, the kill switch, admin commands, fleet
 * heartbeats, the shadow rate counter. Control options (1 s command timeout,
 * one retry, no offline queue); lazily connected, so a process with every
 * model `off` never connects.
 */
@Injectable()
export class StateRedis implements OnModuleDestroy {
  private readonly logger = new Logger(StateRedis.name);
  private readonly client: LazyClient;

  constructor(@Optional() @Inject(AppConfigService) private readonly config?: AppConfigService) {
    this.client = new LazyClient(() => this.config?.redisUrl ?? 'redis://localhost:6379', ROLE_OPTIONS.control, 'tw-rm-state', this.logger);
  }

  get(): Promise<Redis | undefined> {
    return this.client.get();
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }
}
