import {
  CallHandler,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import { MeteringService } from '../billing/metering.service.js';
import { SettingsCacheService } from '../billing/settings-cache.service.js';
import type { MeteredRequest, MeteringContext } from './metering-context.js';

/**
 * Refunds the quota units a request consumed when the API did not actually
 * serve it. `MeteringGuard` charges up front (it has to — the charge must be
 * atomic and must happen before any work), so anything that fails afterwards
 * has already been billed and needs crediting back.
 *
 * Refunded: every 4xx AND 5xx. A 5xx is our outage; a 4xx is a request the API
 * REFUSED — a malformed `?protocol=` 400ing in validation costs us nothing and
 * billing a unit for it is indefensible on a metered product. (Observed live:
 * a 400 "Unsupported protocol" decremented `X-Quota-Remaining`.)
 *
 * NOT refunded, deliberately:
 *  - **2xx/3xx** — the request was served, the charge stands. Structurally
 *    impossible to refund here anyway: `catchError` only fires on a throw. That
 *    also means this interceptor never learns the status of a request that
 *    SUCCEEDED, which is why no `tap`/`finalize` was added when the per-request
 *    usage buckets landed: recording the final status code is the access-log
 *    middleware's job (`main.ts`), the one seam that sees every outcome —
 *    including the 429 raised by the guard, which never reaches an interceptor
 *    at all.
 *  - **429** — that IS the meter working. It is raised by `MeteringGuard`, and
 *    guards run BEFORE interceptors, so a rate/quota rejection never reaches
 *    this code and the units were never consumed (a rejected
 *    `rate-limiter-flexible` consume takes no points). Excluded explicitly all
 *    the same: if the rejection ever moves into the handler chain, refunding it
 *    would MINT units — `reward` decrements the consumed counter, so a client
 *    could loop "get 429 → get refunded" into an unlimited plan.
 *  - **401/403** — nothing to refund. `ApiKeyGuard`/`MeteringGuard` reject
 *    before the charge, and `req.metering` is only stamped once a customer and
 *    plan resolved, so the `req.metering` check below covers this without a
 *    status special-case.
 *
 * Three more guards against crediting a request that was never charged:
 *  - the `refunded` flag makes the credit idempotent, so a second interceptor
 *    pass (the same interceptor bound both globally and per-controller) cannot
 *    double-refund;
 *  - `MeteringService.reward` no-ops for zero-cost routes and skips the Redis
 *    half for unlimited plans — the two ways a metered request gets a
 *    `req.metering` context without consuming quota;
 *  - `quotaCharged`, which is the one that closes the reachable hole. The quota
 *    limiter FAILS OPEN on a Redis error: the request is allowed through having
 *    consumed nothing, and a 4xx afterwards used to credit units anyway. `reward`
 *    is an INCRBY of a negative amount, so that left a NEGATIVE consumed counter
 *    sitting under a 35-day TTL — free units for the rest of the period.
 */
@Injectable()
export class MeteringInterceptor implements NestInterceptor {
  constructor(
    @Inject(MeteringService) private readonly metering: MeteringService,
    @Inject(SettingsCacheService) private readonly cache: SettingsCacheService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<MeteredRequest>();
    return next.handle().pipe(
      // A route can also FAIL while returning 200. The position-detail endpoint
      // degrades rather than 500ing when its upstream indexer times out, which
      // otherwise means the customer pays full price for a response missing the
      // transaction list, and the outage is recorded as a clean 2xx in their own
      // usage breakdown. Refunding puts it back in the "refunded" column, which
      // is both the honest charge and the only place the incident stays visible.
      tap((value: unknown) => {
        if (isDegradedPayload(value)) this.refund(req);
      }),
      catchError((err: unknown) => {
        // A non-HttpException escaped the handler: that is a 500 by the time
        // the exception filter is done with it, so treat it as one.
        const status = err instanceof HttpException ? err.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
        if (isRefundable(status)) this.refund(req);
        return throwError(() => err);
      }),
    );
  }

  private refund(req: MeteredRequest): void {
    refundCharge(req.metering, this.cache, this.metering);
  }
}

/**
 * Credit a request's charge back. The ONE refund implementation: the
 * interceptor calls it for a failed or degraded response, and the access-log
 * middleware (`trackRequestUsage`) calls it for a client that hung up before
 * any response was written. Idempotent via `refunded`, so the two can both
 * reach the same request — a handler that throws AFTER its client aborted —
 * and credit it once.
 */
export function refundCharge(
  ctx: MeteringContext | undefined,
  cache: Pick<SettingsCacheService, 'getPlan'>,
  metering: Pick<MeteringService, 'reward'>,
): void {
  if (!ctx || ctx.refunded) return;
  const plan = cache.getPlan(ctx.planKey);
  if (!plan) return;
  ctx.refunded = true;
  // The usage buckets record NET units, with no compensating row, so the
  // credit has to be reflected in the context the usage writer reads.
  ctx.unitsCharged = 0;
  void metering.reward({
    customerId: ctx.customerId,
    plan,
    unitCost: ctx.unitCost,
    // `?? false` is the fail-safe read: an absent flag means we cannot show the
    // counter was charged, and not refunding a real charge costs one customer
    // a few units, while refunding a phantom one MINTS units for everybody.
    quotaCharged: ctx.quotaCharged ?? false,
  });
}

/** The request failed and we charged for it — every error status except 429. */
export function isRefundable(status: number): boolean {
  return status >= HttpStatus.BAD_REQUEST && status !== HttpStatus.TOO_MANY_REQUESTS;
}

/**
 * Response-body flags that mean "this 200 did not deliver what was asked".
 *
 * Deliberately an EXPLICIT list rather than a pattern like /Degraded$/: a
 * refund moves money, so a field name should have to be added here on purpose,
 * not become billable-relevant by being named a certain way. Adding a new
 * degrade flag to a metered route means adding it here in the same change.
 */
// `partial`: a position or pool chart missing an input (upstream failure, or
// not ready by the request deadline) — `ChartsService`, /v1/*/charts.
// `transactionsPartial` (2026-10-03): position detail served only the NEWEST
// transaction page while the full walk loads in the background. Detail sets
// `transactionsDegraded` alongside it, so this entry is belt and braces — the
// flag means "incomplete" on its own and must refund on its own.
const DEGRADED_PAYLOAD_FLAGS = ['transactionsDegraded', 'partial', 'transactionsPartial'] as const;

/**
 * True when a successful response reports its own partial delivery. Only own,
 * top-level, strictly-`true` properties count — a nested or truthy-ish value
 * must not silently zero a charge.
 */
export function isDegradedPayload(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  return DEGRADED_PAYLOAD_FLAGS.some(
    (flag) => Object.prototype.hasOwnProperty.call(obj, flag) && obj[flag] === true,
  );
}
