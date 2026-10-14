import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ANON_COST_METADATA, type AnonCostKind } from './api-cost.js';
import { ApiLimitService, type LimitedRequest, type LimitedResponse } from './api-limit.service.js';

/**
 * The per-IP budget on the keyless `/api/*` handlers (`ApiLimitService` has the
 * rules). Apply it AFTER `FirstPartyOriginGuard`, which stays as the cheap first
 * filter, and name each handler's kind with `@AnonCost(...)`: a handler without
 * one is not charged (a new route is never throttled by accident, and a spec
 * pins that every handler of the three controllers has one).
 *
 * Never put it on `/v1`: those routes are metered per API key, and the paid API
 * must not meet a limit meant for anonymous callers.
 *
 * Thin on purpose: Nest builds a guard once per module that names it, and the
 * limiters, the in-flight table and the meter must be ONE per process, so they
 * live in the `ApiLimitService` provider.
 */
@Injectable()
export class ApiRateLimitGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(ApiLimitService) private readonly limit: ApiLimitService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const kind = this.reflector.get<AnonCostKind | undefined>(ANON_COST_METADATA, context.getHandler());
    if (!kind) return true;
    const http = context.switchToHttp();
    await this.limit.admit(kind, http.getRequest<LimitedRequest>(), http.getResponse<LimitedResponse>());
    return true;
  }
}
