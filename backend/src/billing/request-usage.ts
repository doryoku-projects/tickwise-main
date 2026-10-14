import type { MeteringContext } from '../v1/metering-context.js';
import type { UsageBucketService } from './usage-bucket.service.js';

/**
 * nginx's "client closed request". Never sent on the wire (nobody is left to
 * receive it); it is what the usage detail records for a request whose client
 * hung up first, and it lands in the `4xx` status class.
 */
export const CLIENT_CLOSED_REQUEST = 499;

interface TrackedRequest {
  /** Read at EVENT time, never at attach time — the guard stamps it later. */
  metering?: MeteringContext;
}

interface TrackedResponse {
  statusCode: number;
  writableFinished: boolean;
  on(event: 'finish' | 'close', listener: () => void): void;
}

export interface RequestUsageDeps {
  usageBuckets: Pick<UsageBucketService, 'record'>;
  /** `refundCharge` bound to the live services — see metering.interceptor.ts. */
  refund(ctx: MeteringContext): void;
}

/**
 * Records one metered request's usage detail exactly once, whichever way it
 * ends.
 *
 * `finish` covers every response that was actually written, the guard's 429s
 * included. It does NOT fire when the client disconnects first, and that gap
 * used to bill silently: the guard charges up front, the interceptor only
 * refunds on a response it sees, so a caller that gave up — the portal
 * playground aborts at 15s, and every call did while Redis was backlogged —
 * paid the unit while no detail row was written at all. The monthly counter
 * moved and the breakdown showed nothing.
 *
 * Such a request is now refunded (no data was delivered) and recorded as a
 * 499 carrying zero units, so it is visible without being billed. Only a
 * COMPLETED charge is refunded: the guard stamps the context before its
 * consume returns, and crediting a consume still in flight would compensate a
 * Mongo snapshot that has not been written yet. A client that hangs up inside
 * that window (one Redis round trip) is still charged; the 15s abort this
 * exists for is nowhere near it.
 */
export function trackRequestUsage(req: TrackedRequest, res: TrackedResponse, deps: RequestUsageDeps): void {
  let recorded = false;

  res.on('finish', () => {
    // A request the client already abandoned was recorded as a 499 on
    // `close`; a late finish must not count it twice.
    if (recorded || !req.metering) return;
    recorded = true;
    deps.usageBuckets.record(req.metering, res.statusCode);
  });

  res.on('close', () => {
    // `close` fires after every response; only one that never finished writing
    // was abandoned.
    if (recorded || res.writableFinished || !req.metering) return;
    recorded = true;
    // Refund BEFORE recording: the bucket takes NET units from the context,
    // and the refund is what zeroes them.
    if (req.metering.unitsCharged > 0) deps.refund(req.metering);
    deps.usageBuckets.record(req.metering, CLIENT_CLOSED_REQUEST);
  });
}
