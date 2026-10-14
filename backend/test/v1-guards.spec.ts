import { ForbiddenException, HttpException, HttpStatus, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { UNIT_COST_TIERS } from '../src/billing/endpoint-costs.seed.js';
import { MeteringRejectionError } from '../src/billing/metering.service.js';
import { ApiKeyGuard } from '../src/v1/api-key.guard.js';
import { MeteringGuard } from '../src/v1/metering.guard.js';

function ctxFor(req: any, res: any = { setHeader: vi.fn() }) {
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
    getHandler: () => () => undefined,
  } as any;
}

const config = { apiKeyHeader: 'KC-APIKey' } as any;

describe('ApiKeyGuard', () => {
  it('rejects a missing key header', async () => {
    const guard = new ApiKeyGuard({} as never, config);
    await expect(guard.canActivate(ctxFor({ headers: {} }))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an invalid / revoked key', async () => {
    const clients = { resolveByRawKey: vi.fn(async () => null) };
    const guard = new ApiKeyGuard(clients as never, config);
    await expect(
      guard.canActivate(ctxFor({ headers: { 'kc-apikey': 'kc_live_bad' } })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('attaches the resolved client on a valid key', async () => {
    const resolved = { apiKeyId: 'k1', customerId: 'c1', planKey: 'free' };
    const clients = { resolveByRawKey: vi.fn(async () => resolved) };
    const guard = new ApiKeyGuard(clients as never, config);
    const req: any = { headers: { 'kc-apikey': 'kc_live_good' } };
    await expect(guard.canActivate(ctxFor(req))).resolves.toBe(true);
    expect(req.apiClient).toEqual(resolved);
  });
});

describe('MeteringGuard', () => {
  const reflector = { get: () => ({ routeKey: 'v1.positions.list', fallback: 1 }) };

  it('consumes, sets headers, and allows on success', async () => {
    const cache = { getEndpointCost: () => 10, getPlan: () => ({ key: 'free', monthlyUnits: 100, rateLimitPerMin: 60 }) };
    const metering = {
      checkAndConsume: vi.fn(async () => ({
        rate: { limit: 60, remaining: 59, resetSec: 60 },
        quota: { limit: 100, remaining: 90, resetSec: 1000 },
        quotaCharged: true,
      })),
    };
    const guard = new MeteringGuard(reflector as never, cache as never, metering as never);
    const res = { setHeader: vi.fn() };
    const req: any = { apiClient: { apiKeyId: 'k', customerId: 'c', planKey: 'free' } };

    await expect(guard.canActivate(ctxFor(req, res))).resolves.toBe(true);
    expect(metering.checkAndConsume).toHaveBeenCalledWith(
      expect.objectContaining({ apiKeyId: 'k', customerId: 'c', unitCost: 10 }),
    );
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', 59);
    expect(res.setHeader).toHaveBeenCalledWith('X-Quota-Remaining', 90);
    expect(req.metering).toMatchObject({ customerId: 'c', unitCost: 10, quotaCharged: true });
  });

  it('resolves the no-DB-row fallback from the LADDER, not the decorator literal', async () => {
    // FINDING 5. The reflector stub above carries `fallback: 1`, exactly as every
    // decorator used to. `getEndpointCost` must still be asked with the SEEDED
    // cost for a route that is on the published ladder, or the meter charges 1 for
    // something `GET /v1/pricing/units` advertises at 2 (or, for charts, at 10).
    const getEndpointCost = vi.fn((_routeKey: string, fallback: number) => fallback);
    const cache = { getEndpointCost, getPlan: () => ({ key: 'free', monthlyUnits: 100, rateLimitPerMin: 60 }) };
    const metering = {
      checkAndConsume: vi.fn(async () => ({
        rate: { limit: 60, remaining: 59, resetSec: 60 },
        quota: null,
        quotaCharged: false,
      })),
    };
    const guard = new MeteringGuard(reflector as never, cache as never, metering as never);
    const req: any = { apiClient: { apiKeyId: 'k', customerId: 'c', planKey: 'free' } };

    await guard.canActivate(ctxFor(req));

    expect(getEndpointCost).toHaveBeenCalledWith('v1.positions.list', UNIT_COST_TIERS.list);
    expect(req.metering.unitCost).toBe(UNIT_COST_TIERS.list);
  });

  it('stamps quotaCharged FALSE before the consume, and only the result can raise it', async () => {
    // FINDING 9, at the guard layer. The quota limiter FAILS OPEN on a Redis
    // error: the request is allowed through having consumed nothing, and the
    // interceptor must not then credit units back (an INCRBY of a negative amount
    // leaves a negative counter under a 35-day TTL). So the flag starts false and
    // is raised ONLY from `result.quotaCharged`.
    let stampedAtConsumeTime: unknown;
    const cache = { getEndpointCost: () => 10, getPlan: () => ({ key: 'free', monthlyUnits: 100, rateLimitPerMin: 60 }) };
    const req: any = { apiClient: { apiKeyId: 'k', customerId: 'c', planKey: 'free' } };
    const metering = {
      checkAndConsume: vi.fn(async () => {
        // The context already exists here — that ordering is the point.
        stampedAtConsumeTime = req.metering.quotaCharged;
        return {
          rate: { limit: 60, remaining: 59, resetSec: 60 },
          // A fail-open quota: a full-budget view IS returned, so the view alone
          // cannot tell the interceptor whether anything was charged.
          quota: { limit: 100, remaining: 100, resetSec: 1000 },
          quotaCharged: false,
        };
      }),
    };
    const guard = new MeteringGuard(reflector as never, cache as never, metering as never);

    await expect(guard.canActivate(ctxFor(req))).resolves.toBe(true);

    expect(stampedAtConsumeTime).toBe(false);
    expect(req.metering.quotaCharged).toBe(false);
  });

  it('maps a metering rejection to 429 with Retry-After', async () => {
    const cache = { getEndpointCost: () => 10, getPlan: () => ({ key: 'free', monthlyUnits: 100, rateLimitPerMin: 60 }) };
    const metering = {
      checkAndConsume: vi.fn(async () => {
        throw new MeteringRejectionError('quota', 1234, { limit: 100, remaining: 0, resetSec: 1234 });
      }),
    };
    const guard = new MeteringGuard(reflector as never, cache as never, metering as never);
    const res = { setHeader: vi.fn() };
    const req: any = { apiClient: { apiKeyId: 'k', customerId: 'c', planKey: 'free' } };

    try {
      await guard.canActivate(ctxFor(req, res));
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(HttpException);
      expect((err as HttpException).getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    }
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '1234');
  });

  it('rejects when the client plan no longer exists', async () => {
    const cache = { getEndpointCost: () => 10, getPlan: () => undefined };
    const guard = new MeteringGuard(reflector as never, cache as never, {} as never);
    const req: any = { apiClient: { apiKeyId: 'k', customerId: 'c', planKey: 'ghost' } };
    await expect(guard.canActivate(ctxFor(req))).rejects.toBeInstanceOf(ForbiddenException);
  });
});
