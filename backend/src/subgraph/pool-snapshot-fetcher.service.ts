import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import type { PoolSnapshotFetcher } from '../pricing/pool-snapshot-helpers.js';
import { PoolRatioProvider } from '../pricing/providers/pool-ratio.provider.js';
import { AdapterRegistryService } from './adapter-registry.service.js';
import type { PoolSnapshot } from './position-adapter.js';

/**
 * Bridges the pricing layer's `PoolRatioProvider` to the subgraph adapter
 * registry. The pricing module cannot directly depend on the subgraph module
 * (it's the other way around — would cycle), so this service lives in the
 * subgraph layer and registers itself with the provider at module init.
 */
@Injectable()
export class PoolSnapshotFetcherService implements PoolSnapshotFetcher, OnModuleInit {
  private readonly logger = new Logger(PoolSnapshotFetcherService.name);

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(AdapterRegistryService) private readonly adapters: AdapterRegistryService,
    @Inject(PoolRatioProvider) private readonly poolRatioProvider: PoolRatioProvider,
  ) {}

  onModuleInit(): void {
    this.poolRatioProvider.setSnapshotFetcher(this);
    this.logger.log('Pool-snapshot fetcher registered with pool-ratio price provider');
  }

  async fetchSnapshots(opts: {
    chainId: number;
    protocol: string;
    poolId: string;
    fromTimestamp: number;
    toTimestamp: number;
  }): Promise<PoolSnapshot[]> {
    const integration = this.config.getIntegration(opts.chainId, opts.protocol);
    if (!integration) return [];

    let adapter;
    try {
      adapter = this.adapters.resolve(opts.protocol);
    } catch {
      return [];
    }
    if (!adapter.fetchPoolSnapshots) return [];

    return adapter.fetchPoolSnapshots({
      integration,
      poolId: opts.poolId,
      fromTimestamp: opts.fromTimestamp,
      toTimestamp: opts.toTimestamp,
    });
  }
}
