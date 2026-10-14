import type { ApiClientContext } from './api-key.guard.js';

/**
 * The per-request metering context, and the request shape that carries it.
 *
 * WHY THIS LIVES IN ITS OWN FILE: this interface used to be declared TWICE —
 * once in `metering.guard.ts` (which writes it) and once in
 * `metering.interceptor.ts` (which reads it on the refund path) — and the two
 * copies had ALREADY DIVERGED: the guard's knew nothing about `refunded`, the
 * interceptor's knew nothing about the fields it did not touch, and neither
 * compiler saw the other. Structural typing makes that silent: a field added
 * to one copy is simply invisible from the other side, and the request object
 * they both mutate is the same object at runtime.
 *
 * There are now THREE consumers, which is what forces the issue — the guard
 * stamps the context, the interceptor zeroes `unitsCharged` when it refunds,
 * and `UsageBucketService` reads the finished result at response finish. One
 * declaration is the only arrangement in which those three cannot drift.
 */
export interface MeteringContext {
  customerId: string;
  planKey: string;
  /**
   * The `@UnitCost(routeKey)` of the handler that served this request, so the
   * usage detail can be grouped by endpoint. `'v1.unknown'` for a metered route
   * that carries no decorator.
   */
  routeKey: string;
  apiKeyId: string;
  /**
   * The key's public prefix and label, captured here so the usage writer needs
   * NO second read — `ClientsService.resolveByRawKey` already has the whole key
   * document in memory. They are also the only thing that keeps a usage row
   * readable after the key is deleted, which is a HARD delete.
   */
  keyPrefix: string;
  keyLabel: string;
  /** The live per-request price from the endpoint-cost ladder. */
  unitCost: number;
  /**
   * What this request ACTUALLY cost the customer, and the whole refund
   * mechanism for the usage buckets: the guard raises it to `unitCost` only
   * once the charge has succeeded, a 429 leaves it at 0, and the interceptor's
   * refund path returns it to 0. The finish-writer therefore records the NET
   * units in a single upsert and never needs a compensating row — which also
   * keeps it clear of the month-boundary hazard the monthly snapshot has, where
   * charge and compensation each resolve `currentPeriod()` independently.
   */
  unitsCharged: number;
  /**
   * Whether `MeteringGuard`'s quota consume actually decremented the Redis
   * counter. Passed straight through to `reward`, which refunds Redis only when
   * it is true — the quota limiter fails OPEN on a Redis error, and crediting a
   * counter that was never charged drives it negative under a 35-day TTL.
   *
   * Optional in the type only to tolerate a stamp written by an older build; an
   * absent value is read as "not charged", which is the fail-safe direction.
   */
  quotaCharged?: boolean;
  /** Set once this request's units have been credited back — see `refund`. */
  refunded?: boolean;
  /**
   * When the charge was made, captured ONCE in the guard. The day and period
   * buckets are derived from this rather than from response-finish time, so a
   * request that crosses midnight is billed to the day it was charged on
   * instead of splitting a single charge across two buckets.
   */
  chargedAt: Date;
}

export interface MeteredRequest {
  apiClient?: ApiClientContext;
  metering?: MeteringContext;
}
