import { Controller, Get, Inject } from '@nestjs/common';
import { can } from '../common/process-role.js';
import { AppConfigService } from '../config/app-config.service.js';
import { IndexingStatusService } from './indexing-status.service.js';
import { livenessBody, workerHealthBody } from './health-live.controller.js';

@Controller('health')
export class HealthController {
  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(IndexingStatusService) private readonly indexingStatus: IndexingStatusService,
  ) {}

  @Get()
  async health() {
    // P2.1: a worker role (sync | fee | feeder) answers liveness + role +
    // leases, with no indexer probes — it serves no API, and its /health must
    // not spend indexer budget. `all` / `api` answer exactly as before.
    if (!can('health-full')) return workerHealthBody();
    const integrations = await Promise.all(
      this.config.enabledIntegrations.map(async (integration) => {
        // indexedBlock (synced) vs chainHeadBlock (current) + lagBlocks — the
        // indexing-status the client badge renders. Cached + fail-soft inside
        // the service, so /health never blocks on or hammers the indexer/RPC.
        const status = await this.indexingStatus.getStatus(integration);
        return {
          chainId: integration.chainId,
          protocol: integration.protocol,
          enabled: integration.enabled,
          ...status,
        };
      }),
    );
    return {
      status: 'ok',
      service: 'positions-backend',
      integrations,
      timestamp: new Date().toISOString(),
    };
  }

  /** P2.1: `GET /health/live` — every role, no I/O (the worker roles' Railway healthcheck). */
  @Get('live')
  live() {
    return livenessBody();
  }
}
