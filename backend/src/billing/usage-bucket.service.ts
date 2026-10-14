import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { MeteringContext } from '../v1/metering-context.js';
import { UsageBucket } from './usage-bucket.schema.js';
import { UsageFlushService } from './usage-flush.service.js';

/**
 * Writes the per-request detail rows behind the usage-detail views: one upsert
 * per request into `usage_buckets`, keyed
 * `(customer, day, routeKey, apiKeyId, statusClass)`.
 *
 * Called from the access-log middleware's `res.on('finish')` in `main.ts`,
 * because that is the only seam that sees the FINAL status code and it is
 * reached by the guard's 429 rejections too. Everything it needs was stamped
 * onto `req.metering` up front, so this performs ZERO reads.
 *
 * THE COST, stated plainly: this is a THIRD Mongo write on the `/v1` hot path,
 * alongside the `lastUsedAt` bump in `ClientsService.resolveByRawKey` and the
 * monthly snapshot in `MeteringService.snapshotUsage`. The connection pool is
 * built from `{ uri }` alone (no `maxPoolSize`) and is SHARED with the
 * in-process sync workers, which are the heavy writers here — so if `/v1`
 * latency or pool saturation ever becomes the symptom, the escape hatch is to
 * buffer these in Redis (`HINCRBY` per bucket key) and flush on a timer, which
 * turns N writes per request into one write per flush interval without changing
 * the stored shape. Not done now: an unbuffered upsert is one round trip off
 * the response path (fire-and-forget) and a Redis buffer adds a window in which
 * a process death loses usage detail.
 *
 * THAT ESCAPE HATCH NOW EXISTS, behind `USAGE_WRITE_MODE=batched` (default
 * `direct` = the upsert below, unchanged): the same row identity and deltas are
 * `HINCRBY`'d into redis-state and flushed as `bulkWrite` upserts by one
 * process every `USAGE_FLUSH_INTERVAL_MS` — see `usage-flush.service.ts` for
 * the claim/ack protocol that keeps a crash from losing (or, but for one
 * documented window, double-counting) a delta.
 *
 * Fire-and-forget with the same discipline as the monthly snapshot: it logs and
 * swallows, and never throws into the response path. Losing a detail row costs
 * a gap in a report; Redis remains the source of truth for enforcement and the
 * monthly `usage` document for the headline totals.
 */
@Injectable()
export class UsageBucketService {
  private readonly logger = new Logger(UsageBucketService.name);

  constructor(
    @InjectModel(UsageBucket.name) private readonly buckets: Model<UsageBucket>,
    /** APPENDED and optional: the batched writer; absent or `direct` = today. */
    @Optional() @Inject(UsageFlushService) private readonly usageFlush?: UsageFlushService,
  ) {}

  /**
   * Record one finished request. `statusCode` is the status actually sent.
   *
   * `units` takes `unitsCharged` — the NET amount, already zeroed by the guard
   * on a 429 and by the interceptor on a refund — so a single upsert is the
   * whole story and there is never a compensating row to reconcile. `requests`
   * always increments: the request happened even when the charge was reversed.
   */
  record(ctx: MeteringContext, statusCode: number): void {
    try {
      const { day, period } = utcBuckets(ctx.chargedAt);
      // Batched: the same identity (day from `chargedAt`), the same NET units,
      // one request; summed per bucket and upserted by the flusher. False =
      // direct mode (or an input the buffer refuses) → today's upsert below.
      if (
        this.usageFlush?.enqueueBucket(
          {
            customerId: ctx.customerId,
            day,
            routeKey: ctx.routeKey,
            apiKeyId: ctx.apiKeyId,
            statusClass: statusClassOf(statusCode),
            keyPrefix: ctx.keyPrefix,
            keyLabel: ctx.keyLabel,
          },
          ctx.unitsCharged,
        )
      ) {
        return;
      }
      this.buckets
        .updateOne(
          {
            customerId: new Types.ObjectId(ctx.customerId),
            day,
            routeKey: ctx.routeKey,
            apiKeyId: new Types.ObjectId(ctx.apiKeyId),
            statusClass: statusClassOf(statusCode),
          },
          {
            $inc: { units: ctx.unitsCharged, requests: 1 },
            // Only on insert: the filter fields are written by the upsert
            // itself, and these three are properties of the bucket rather than
            // of the request — re-`$set`ting the label on every request would
            // be a wasted write, and a key renamed mid-day would rewrite the
            // history of that day rather than only its future rows.
            //
            // `tenantId` is deliberately absent: nothing resolves a tenant on a
            // request yet, so there is no value to write. When the multi-tenant
            // rollout lands, the guard stamps it onto the context and it joins
            // this block.
            $setOnInsert: { period, keyPrefix: ctx.keyPrefix, keyLabel: ctx.keyLabel },
          },
          { upsert: true },
        )
        .exec()
        .catch((err) => this.logger.warn(`Usage bucket write failed: ${String(err)}`));
    } catch (err) {
      // A malformed id would throw synchronously out of `new Types.ObjectId`.
      this.logger.warn(`Usage bucket write skipped: ${String(err)}`);
    }
  }
}

/**
 * The response class this row is bucketed under. 429 is broken out of `4xx`
 * because "you were rate-limited" and "you sent a bad request" are the two
 * things a customer looking at an error spike most needs to tell apart.
 */
function statusClassOf(statusCode: number): UsageBucket['statusClass'] {
  if (statusCode === 429) return '429';
  if (statusCode >= 500) return '5xx';
  if (statusCode >= 400) return '4xx';
  return '2xx';
}

/**
 * UTC day + month for a charge instant. `period` is sliced off `day` rather
 * than formatted a second time, so the two can never disagree about which
 * month a row belongs to.
 */
function utcBuckets(chargedAt: Date): { day: string; period: string } {
  const y = chargedAt.getUTCFullYear();
  const m = String(chargedAt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(chargedAt.getUTCDate()).padStart(2, '0');
  const day = `${y}-${m}-${d}`;
  return { day, period: day.slice(0, 7) };
}
