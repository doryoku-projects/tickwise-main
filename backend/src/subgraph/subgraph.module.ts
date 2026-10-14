import { Module } from '@nestjs/common';
import { PricingModule } from '../pricing/pricing.module.js';
import { AdapterRegistryService } from './adapter-registry.service.js';
import { RevertCompatibleAdapter } from './adapters/revert-compatible.adapter.js';
import { EnvioAdapter } from './adapters/envio.adapter.js';
import { PoolSnapshotFetcherService } from './pool-snapshot-fetcher.service.js';
import { PAGE_FEE_READER } from './adapters/envio.adapter.js';
import { FeeMeasurer } from '../sync/fee-measurer.js';

@Module({
  imports: [PricingModule],
  providers: [
    AdapterRegistryService,
    RevertCompatibleAdapter,
    EnvioAdapter,
    PoolSnapshotFetcherService,
    // P3.1: the first fee reading inside the backfill flush. EnvioAdapter injects
    // PAGE_FEE_READER; it reads only with BACKFILL_FEE_READ=on (default off =
    // today) in a role that may (`can('backfill-fee-read')`). FeeMeasurer needs
    // only the config and FEE_RPC_FETCH (CoordinationModule, global): no cycle
    // with SyncModule.
    FeeMeasurer,
    { provide: PAGE_FEE_READER, useExisting: FeeMeasurer },
  ],
  exports: [AdapterRegistryService],
})
export class SubgraphModule {}
