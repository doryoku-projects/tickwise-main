import { describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';

import {
  MeteringInterceptor,
  isDegradedPayload,
  isRefundable,
} from '../src/v1/metering.interceptor.js';

/**
 * A metered route can now FAIL while returning 200 — position detail degrades
 * instead of 500ing when its upstream indexer times out. `catchError` only fires
 * on a throw, so without this path the customer pays full price for a response
 * missing the transaction list AND the incident is filed as a clean 2xx.
 */

describe('isDegradedPayload', () => {
  it('detects a degraded response body', () => {
    expect(isDegradedPayload({ transactionsDegraded: true })).toBe(true);
  });

  it('a newest-page-only transaction list refunds on its own flag too', () => {
    // Detail sets transactionsDegraded alongside it; the flag must not depend on that.
    expect(isDegradedPayload({ transactionsPartial: true })).toBe(true);
    expect(isDegradedPayload({ transactionsPartial: true, transactionsDegraded: false })).toBe(true);
    expect(isDegradedPayload({ transactionsPartial: 'true' })).toBe(false);
  });

  it('an all-chains list missing a chain (`partial` + `missingChains`) is refunded', () => {
    expect(isDegradedPayload({ positions: [], partial: true, missingChains: [4663] })).toBe(true);
    expect(isDegradedPayload({ pools: [], partial: true, missingChains: [1] })).toBe(true);
    // A stale timeout fallback is flagged for the client, not refunded.
    expect(isDegradedPayload({ positions: [], stale: true, dataAsOf: '2026-10-03T00:00:00.000Z' })).toBe(false);
  });

  it('does not fire on a healthy or absent flag', () => {
    expect(isDegradedPayload({ transactionsDegraded: false })).toBe(false);
    expect(isDegradedPayload({})).toBe(false);
  });

  it('requires strictly true — a refund moves money, so truthy is not enough', () => {
    for (const v of ['true', 1, {}, [], 'yes']) {
      expect(isDegradedPayload({ transactionsDegraded: v })).toBe(false);
    }
  });

  it('ignores non-objects and arrays rather than throwing on them', () => {
    for (const v of [null, undefined, 0, '', 'x', [{ transactionsDegraded: true }]]) {
      expect(isDegradedPayload(v)).toBe(false);
    }
  });

  it('does not treat a NESTED flag as a degraded response', () => {
    expect(isDegradedPayload({ data: { transactionsDegraded: true } })).toBe(false);
  });
});

function harness(body: unknown) {
  const reward = vi.fn();
  const req = {
    metering: {
      customerId: 'c1',
      planKey: 'pro',
      unitCost: 1,
      unitsCharged: 1,
      quotaCharged: true,
      refunded: false,
    },
  };
  const interceptor = new MeteringInterceptor(
    { reward } as never,
    { getPlan: () => ({ key: 'pro', points: 1000 }) } as never,
  );
  const ctx = { switchToHttp: () => ({ getRequest: () => req }) } as never;
  const next = { handle: () => of(body) } as never;
  return { interceptor, ctx, next, req, reward };
}

describe('MeteringInterceptor — degraded 200', () => {
  it('refunds a degraded success and zeroes the units the bucket writer reads', async () => {
    const { interceptor, ctx, next, req, reward } = harness({ transactionsDegraded: true });

    await new Promise((resolve, reject) =>
      interceptor.intercept(ctx, next).subscribe({ next: resolve, error: reject }),
    );

    expect(reward).toHaveBeenCalledTimes(1);
    expect(req.metering.refunded).toBe(true);
    expect(req.metering.unitsCharged).toBe(0);
  });

  it('does NOT refund a healthy success', async () => {
    const { interceptor, ctx, next, req, reward } = harness({ transactionsDegraded: false });

    await new Promise((resolve, reject) =>
      interceptor.intercept(ctx, next).subscribe({ next: resolve, error: reject }),
    );

    expect(reward).not.toHaveBeenCalled();
    expect(req.metering.unitsCharged).toBe(1);
  });

  it('passes the response through unchanged — this is an observer, not a transform', async () => {
    const body = { transactionsDegraded: true, transactions: [], positionId: '1' };
    const { interceptor, ctx, next } = harness(body);

    const seen = await new Promise((resolve, reject) =>
      interceptor.intercept(ctx, next).subscribe({ next: resolve, error: reject }),
    );

    expect(seen).toBe(body);
  });

  it('refunds only once even though refund() is reachable from both paths', async () => {
    const { interceptor, ctx, req, reward } = harness(null);
    const next = {
      handle: () => throwError(() => Object.assign(new Error('boom'), { getStatus: () => 500 })),
    } as never;
    req.metering.refunded = true; // already credited

    await new Promise((resolve) =>
      interceptor.intercept(ctx, next).subscribe({ next: resolve, error: resolve }),
    );

    expect(reward).not.toHaveBeenCalled();
  });

  it('leaves the status-based refund rule untouched', () => {
    expect(isRefundable(500)).toBe(true);
    expect(isRefundable(400)).toBe(true);
    expect(isRefundable(429)).toBe(false);
    expect(isRefundable(200)).toBe(false);
  });
});
