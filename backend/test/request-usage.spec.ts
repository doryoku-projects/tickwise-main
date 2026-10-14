import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { CLIENT_CLOSED_REQUEST, trackRequestUsage } from '../src/billing/request-usage.js';
import { refundCharge } from '../src/v1/metering.interceptor.js';
import type { MeteringContext } from '../src/v1/metering-context.js';

/**
 * A client that hangs up before the response is written gets no `finish`
 * event. While Redis was backlogged every playground call did exactly that at
 * its 15s abort, and each one kept its unit while writing no usage detail —
 * the monthly counter rose and the breakdown stayed empty.
 */

function ctx(over: Partial<MeteringContext> = {}): MeteringContext {
  return {
    customerId: '64b000000000000000000001',
    planKey: 'standard',
    routeKey: 'v1.positions.list',
    apiKeyId: '64b000000000000000000002',
    keyPrefix: 'kc_live_abcdefgh',
    keyLabel: 'test',
    unitCost: 2,
    unitsCharged: 2,
    quotaCharged: true,
    chargedAt: new Date('2026-10-01T00:00:00Z'),
    ...over,
  };
}

function harness(metering: MeteringContext | undefined) {
  const res = Object.assign(new EventEmitter(), { statusCode: 200, writableFinished: false });
  const req: { metering?: MeteringContext } = { metering };
  // Snapshot units at record time — the context is mutated afterwards.
  const recorded: Array<{ status: number; units: number }> = [];
  const usageBuckets = { record: vi.fn((c: MeteringContext, status: number) => recorded.push({ status, units: c.unitsCharged })) };
  const reward = vi.fn(async () => undefined);
  const cache = { getPlan: vi.fn(() => ({ key: 'standard', monthlyUnits: 1000 }) as never) };
  trackRequestUsage(req, res, {
    usageBuckets,
    refund: (c) => refundCharge(c, cache, { reward }),
  });
  return { req, res, recorded, reward, usageBuckets };
}

function finish(res: EventEmitter & { writableFinished: boolean; statusCode: number }, status = 200) {
  res.statusCode = status;
  res.writableFinished = true;
  res.emit('finish');
  res.emit('close');
}

describe('trackRequestUsage', () => {
  it('records a written response once, with its status, and refunds nothing', () => {
    const h = harness(ctx());
    finish(h.res);
    expect(h.recorded).toEqual([{ status: 200, units: 2 }]);
    expect(h.reward).not.toHaveBeenCalled();
  });

  it('refunds a charged request whose client hung up, and records it as a 499 with zero units', () => {
    const h = harness(ctx());
    h.res.emit('close');
    expect(h.reward).toHaveBeenCalledTimes(1);
    expect(h.reward).toHaveBeenCalledWith(expect.objectContaining({ unitCost: 2, quotaCharged: true }));
    expect(h.recorded).toEqual([{ status: CLIENT_CLOSED_REQUEST, units: 0 }]);
    expect(h.req.metering?.refunded).toBe(true);
  });

  it('does not treat the close that follows every completed response as an abort', () => {
    const h = harness(ctx());
    h.res.writableFinished = true;
    h.res.emit('close');
    expect(h.reward).not.toHaveBeenCalled();
    expect(h.recorded).toEqual([]);
  });

  it('does not refund a charge that never completed', () => {
    // The guard stamps the context before its consume returns; crediting then
    // would compensate a usage snapshot nobody has written.
    const h = harness(ctx({ unitsCharged: 0, quotaCharged: false }));
    h.res.emit('close');
    expect(h.reward).not.toHaveBeenCalled();
    expect(h.recorded).toEqual([{ status: CLIENT_CLOSED_REQUEST, units: 0 }]);
  });

  it('counts an abandoned request once even if the handler later finishes writing', () => {
    const h = harness(ctx());
    h.res.emit('close');
    finish(h.res);
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0].status).toBe(CLIENT_CLOSED_REQUEST);
  });

  it('does not credit twice when the interceptor already refunded the request', () => {
    const h = harness(ctx({ refunded: true, unitsCharged: 0 }));
    h.res.emit('close');
    expect(h.reward).not.toHaveBeenCalled();
    expect(h.recorded).toEqual([{ status: CLIENT_CLOSED_REQUEST, units: 0 }]);
  });

  it('records nothing for a request with no metering context', () => {
    const h = harness(undefined);
    h.res.emit('close');
    finish(h.res);
    expect(h.usageBuckets.record).not.toHaveBeenCalled();
  });

  it('reads the context at event time, since the guard stamps it after attach', () => {
    const h = harness(undefined);
    h.req.metering = ctx();
    h.res.emit('close');
    expect(h.reward).toHaveBeenCalledTimes(1);
  });
});
