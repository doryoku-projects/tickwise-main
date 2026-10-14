import { Body, Controller, Delete, Get, Inject, Optional, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { enqueueBackfillAllUnlessPaused, enqueueBackfillUnlessPaused } from '../admin/backfill-run.js';
import { AdminJwtGuard } from '../auth/admin-jwt.guard.js';
import { AppConfigService } from '../config/app-config.service.js';
import { SyncRepository } from '../database/sync.repository.js';
import { QueueService } from '../queues/queue.service.js';
import {
  AssignPlanDto,
  ClientUsageDetailQueryDto,
  CreateClientDto,
  CreateEndpointCostDto,
  CreatePlanDto,
  IssueKeyDto,
  RunSyncDto,
  SetKeyOriginsDto,
  UpdateEndpointCostDto,
  UpdatePlanDto,
} from './billing.dto.js';
import { ClientsService } from './clients.service.js';
import { EndpointCostsService } from './endpoint-costs.service.js';
import { PlansService } from './plans.service.js';

/**
 * Admin-panel management API. All routes require a Bearer JWT from
 * `POST /admin/auth/login` (the legacy `/admin/sync/*` ops routes keep their
 * own `x-admin-secret`).
 */
@Controller('admin')
@UseGuards(AdminJwtGuard)
export class AdminBillingController {
  constructor(
    @Inject(ClientsService) private readonly clients: ClientsService,
    @Inject(PlansService) private readonly plans: PlansService,
    @Inject(EndpointCostsService) private readonly endpointCosts: EndpointCostsService,
    @Inject(QueueService) private readonly queues: QueueService,
    // Appended + @Optional (the backfill pause, audit C-pause): POST /admin/ops/sync
    // answers a paused chain like POST /admin/sync/run does.
    @Optional() @Inject(SyncRepository) private readonly syncRepo?: SyncRepository,
    @Optional() @Inject(AppConfigService) private readonly config?: AppConfigService,
  ) {}

  // ─── Clients ──────────────────────────────────────────
  @Post('clients')
  createClient(@Body() body: CreateClientDto) {
    return this.clients.createClient(body);
  }

  @Get('clients')
  listClients() {
    return this.clients.listClients();
  }

  @Get('clients/:id')
  getClient(@Param('id') id: string) {
    return this.clients.getClient(id);
  }

  @Patch('clients/:id/plan')
  assignPlan(@Param('id') id: string, @Body() body: AssignPlanDto) {
    return this.clients.assignPlan(id, body.planKey);
  }

  @Get('clients/:id/usage')
  usage(@Param('id') id: string) {
    return this.clients.getUsage(id);
  }

  /**
   * The same usage-detail report the customer sees for themselves at
   * `GET /account/usage/detail`, for one client.
   *
   * `:id` is parsed FAIL-CLOSED inside `getUsageDetail` — a malformed id is a
   * 404, never a list. That is the opposite of `AdminPaymentsController`'s
   * `if (customerId && Types.ObjectId.isValid(customerId))` idiom, which has no
   * `else` and so answers a malformed id with EVERY customer's rows.
   *
   * The plain `usage` route above stays exactly as it was: the admin panel's
   * period table reads it, and this is an addition rather than a replacement.
   */
  @Get('clients/:id/usage/detail')
  usageDetail(@Param('id') id: string, @Query() query: ClientUsageDetailQueryDto) {
    return this.clients.getUsageDetail(id, query);
  }

  // ─── API keys ─────────────────────────────────────────
  @Post('clients/:id/keys')
  issueKey(@Param('id') id: string, @Body() body: IssueKeyDto) {
    return this.clients.issueKey(id, { label: body.label, keyType: body.keyType, origins: body.origins });
  }

  @Get('clients/:id/keys')
  listKeys(@Param('id') id: string) {
    return this.clients.listKeys(id);
  }

  @Post('keys/:keyId/revoke')
  revokeKey(@Param('keyId') keyId: string) {
    return this.clients.revokeKey(keyId);
  }

  /** Replace a key's allowed browser origins (drives CORS + the guard's origin binding). */
  @Patch('keys/:keyId/origins')
  setKeyOrigins(@Param('keyId') keyId: string, @Body() body: SetKeyOriginsDto) {
    return this.clients.setKeyOrigins(keyId, body.origins);
  }

  @Delete('keys/:keyId')
  deleteKey(@Param('keyId') keyId: string) {
    return this.clients.deleteKey(keyId);
  }

  // ─── Ops: sync (JWT-gated, moved out of the public dashboard) ─────────
  // A PAUSED chain (POST /admin/sync/backfill/pause) is refused with a 409 on
  // its own and skipped + named (`skippedPaused`) by `{all}` — the same answer
  // as POST /admin/sync/run (`admin/backfill-run.ts`). Nothing paused = today.
  @Post('ops/sync')
  async runSync(@Body() body: RunSyncDto) {
    const fromStart = body.fromStart === true;
    if (body.all) {
      return enqueueBackfillAllUnlessPaused(this.queues, this.syncRepo, this.config?.enabledIntegrations ?? [], fromStart);
    }
    const chainId = body.chainId ?? 1;
    const protocol = body.protocol ?? 'uniswap-v4';
    return enqueueBackfillUnlessPaused(this.queues, this.syncRepo, chainId, protocol, fromStart);
  }

  // Pool sync — walks the vanilla subgraph pools, re-values TVL, upserts to
  // Mongo. Separate from position backfill (pools have no per-position walk).
  @Post('ops/sync-pools')
  async runPoolsSync(@Body() body: RunSyncDto) {
    if (body.all) {
      return { jobs: await this.queues.enqueuePoolsSyncAll() };
    }
    const chainId = body.chainId ?? 1;
    const protocol = body.protocol ?? 'uniswap-v4';
    return {
      jobId: await this.queues.enqueuePoolsSync(chainId, protocol),
      chainId,
      protocol,
    };
  }

  // Token-security sweep — decoupled GoPlus check over the indexer's token
  // universe (honeypot/blacklist detection). Never touches the resync path.
  @Post('ops/sync-token-security')
  async runTokenSecuritySync(@Body() body: RunSyncDto) {
    if (body.all) {
      return { jobs: await this.queues.enqueueTokenSecuritySyncAll() };
    }
    const chainId = body.chainId ?? 1;
    const protocol = body.protocol ?? 'uniswap-v4';
    return {
      jobId: await this.queues.enqueueTokenSecuritySync(chainId, protocol),
      chainId,
      protocol,
    };
  }

  // ─── Plans ────────────────────────────────────────────
  @Get('plans')
  listPlans() {
    return this.plans.list();
  }

  @Post('plans')
  createPlan(@Body() body: CreatePlanDto) {
    return this.plans.create(body);
  }

  @Patch('plans/:key')
  updatePlan(@Param('key') key: string, @Body() body: UpdatePlanDto) {
    return this.plans.update(key, body);
  }

  @Delete('plans/:key')
  removePlan(@Param('key') key: string) {
    return this.plans.remove(key);
  }

  // ─── Endpoint costs ───────────────────────────────────
  @Get('endpoint-costs')
  listEndpointCosts() {
    return this.endpointCosts.list();
  }

  /**
   * Create or re-state one route's price. Upserts by `routeKey` — see
   * `EndpointCostsService.create` for why the PATCH below cannot do this.
   */
  @Post('endpoint-costs')
  createEndpointCost(@Body() body: CreateEndpointCostDto) {
    return this.endpointCosts.create(body);
  }

  @Patch('endpoint-costs/:routeKey')
  updateEndpointCost(@Param('routeKey') routeKey: string, @Body() body: UpdateEndpointCostDto) {
    return this.endpointCosts.update(routeKey, body);
  }
}
