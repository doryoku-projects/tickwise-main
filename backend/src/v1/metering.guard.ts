import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { seedCostFor } from '../billing/endpoint-costs.seed.js';
import { MeteringRejectionError, MeteringService, type LimitView } from '../billing/metering.service.js';
import { SettingsCacheService } from '../billing/settings-cache.service.js';
import type { MeteredRequest } from './metering-context.js';
import { UNIT_COST_KEY, type UnitCostMeta } from './unit-cost.decorator.js';

interface ResponseLike {
  setHeader(name: string, value: string | number): void;
}

/**
 * Enforces burst rate-limit + monthly unit quota for `/v1` data routes. Runs
 * after `ApiKeyGuard` (which attaches the client + plan). Resolves the live
 * unit cost from the admin-editable settings cache, consumes atomically via
 * `MeteringService`, sets standard headers, and returns 429 when a limit hits.
 */
@Injectable()
export class MeteringGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SettingsCacheService) private readonly cache: SettingsCacheService,
    @Inject(MeteringService) private readonly metering: MeteringService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<MeteredRequest>();
    const res = context.switchToHttp().getResponse<ResponseLike>();
    const client = req.apiClient;
    if (!client) throw new ForbiddenException({ error: 'Unauthenticated request' });

    const meta = this.reflector.get<UnitCostMeta | undefined>(UNIT_COST_KEY, context.getHandler());
    const routeKey = meta?.routeKey ?? 'v1.unknown';
    // The fallback comes from the PUBLISHED LADDER, not from a literal in the
    // decorator. `endpoint_costs` has no row for a route key that did not exist
    // when this install first booted (seeds only fill an EMPTY collection), and
    // the old per-decorator `1` meant the meter then charged 1 for charts while
    // `GET /v1/pricing/units` advertised 10. `seedCostFor` is the single lookup
    // both sides use; `meta.fallback` survives only as an override for a route
    // absent from the ladder entirely.
    const unitCost = this.cache.getEndpointCost(routeKey, seedCostFor(routeKey, meta?.fallback));

    const plan = this.cache.getPlan(client.planKey);
    if (!plan) {
      throw new ForbiddenException({ error: `No active plan '${client.planKey}' for this key` });
    }

    // Stamped BEFORE the consume, so `quotaCharged` starts FALSE and only the
    // line after a returning consume can set it true.
    //
    // The order matters and used to be the bug: the context was written up front
    // with no charge flag at all, so a quota consume that swallowed a Redis error
    // and failed OPEN — consuming nothing — still left the interceptor a context
    // that looked charged. A subsequent 4xx then "refunded" units nobody had
    // spent, INCRBY-ing the counter negative under a 35-day TTL.
    //
    // Everything the response-finish usage writer needs is stamped HERE, so it
    // performs zero extra reads: the key's prefix and label ride along on the
    // resolved key (`ClientsService.resolveByRawKey` already loaded the whole
    // document), and `chargedAt` is captured ONCE — the day/period buckets are
    // derived from it, so a request that crosses midnight is billed to the day
    // it was charged on rather than the day it happened to finish.
    req.metering = {
      customerId: client.customerId,
      planKey: client.planKey,
      routeKey,
      apiKeyId: client.apiKeyId,
      keyPrefix: client.keyPrefix,
      keyLabel: client.keyLabel,
      unitCost,
      unitsCharged: 0,
      quotaCharged: false,
      chargedAt: new Date(),
    };

    try {
      const result = await this.metering.checkAndConsume({
        apiKeyId: client.apiKeyId,
        customerId: client.customerId,
        plan,
        unitCost,
      });
      req.metering.quotaCharged = result.quotaCharged;
      req.metering.unitsCharged = unitCost;
      setRateHeaders(res, result.rate);
      if (result.quota) setQuotaHeaders(res, result.quota);
      return true;
    } catch (err) {
      if (err instanceof MeteringRejectionError) {
        // A rejected consume takes no points, so the 429 the finish-writer is
        // about to record must carry ZERO units. `req.metering` survives this
        // throw — the guard mutates the object hanging off the request, and the
        // access-log middleware's `res.on('finish')` still fires for a 429 —
        // which is exactly what lets a rejection be attributed to the customer
        // and the endpoint that caused it.
        req.metering.unitsCharged = 0;
        res.setHeader('Retry-After', String(err.retryAfterSec));
        // Advertised on the public pricing page and in the docs, so integrators
        // can tell a burst rejection from an exhausted monthly quota without
        // parsing the body: the two need completely different responses (retry
        // shortly vs. upgrade or wait for the 1st).
        res.setHeader('X-RateLimit-Reason', err.kind);
        if (err.kind === 'rate') setRateHeaders(res, err.view);
        else setQuotaHeaders(res, err.view);
        throw new HttpException(
          { error: err.kind === 'rate' ? 'Rate limit exceeded' : 'Monthly quota exceeded', retryAfterSec: err.retryAfterSec },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      throw err;
    }
  }
}

function setRateHeaders(res: ResponseLike, v: LimitView): void {
  res.setHeader('X-RateLimit-Limit', v.limit);
  res.setHeader('X-RateLimit-Remaining', v.remaining);
  res.setHeader('X-RateLimit-Reset', v.resetSec);
}

function setQuotaHeaders(res: ResponseLike, v: LimitView): void {
  res.setHeader('X-Quota-Limit', v.limit);
  res.setHeader('X-Quota-Remaining', v.remaining);
  res.setHeader('X-Quota-Reset', v.resetSec);
}
