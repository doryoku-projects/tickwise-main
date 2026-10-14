/*
 * `requestWithRetry` is now the ONE retry policy (the charts and pools-sync
 * private copies retried every error 3x and ignored Retry-After), and it reads
 * the caller's indexer lane:
 *
 *  - interactive: at most ONE retry, only inside the request's deadline, and a
 *    429 waits its Retry-After capped at 2s instead of the exponential schedule;
 *  - background, observe mode: today's schedule, unchanged (pinned in
 *    envio-pool-stats.spec.ts);
 *  - background, enforce mode: a 429 retries with no sleep of its own, because
 *    the gateway already paused the bucket and the retry waits there;
 *  - nobody retries for a client that has hung up.
 */

import { Logger } from '@nestjs/common';
import type { GraphQLClient } from 'graphql-request';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientClosedError, runInLane, type IndexerContext } from '../src/subgraph/hyperindex/indexer-context.js';
import { __resetIndexerGateways, configureIndexerGateways } from '../src/subgraph/hyperindex/indexer-gateway.js';
import { requestWithRetry } from '../src/subgraph/request-retry.js';

function httpError(status: number, retryAfter?: string): Error {
  const err = new Error(`GraphQL Error (Code: ${status})`);
  (err as unknown as { response: unknown }).response = {
    status,
    headers: new Headers(retryAfter ? { 'retry-after': retryAfter } : {}),
  };
  return err;
}

function client(request: ReturnType<typeof vi.fn>): GraphQLClient {
  return { request } as unknown as GraphQLClient;
}

const interactive = (over: Partial<IndexerContext> = {}): IndexerContext => ({
  lane: 'interactive',
  job: '/api/top-positions/:id/uniswap-v4/:id/charts',
  deadlineAt: Date.now() + 8_000,
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
  vi.spyOn(Math, 'random').mockReturnValue(0); // no jitter, so delays are exact
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  __resetIndexerGateways();
});

describe('interactive lane', () => {
  it('retries a 5xx at most ONCE, then gives up', async () => {
    const request = vi.fn().mockRejectedValue(httpError(502));
    const p = runInLane(interactive(), () => requestWithRetry(client(request), 'q')).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await p).toBeInstanceOf(Error);
    expect(request).toHaveBeenCalledTimes(2); // background would make 4
  });

  it('a 429 waits its Retry-After, not the exponential schedule', async () => {
    const request = vi.fn().mockRejectedValueOnce(httpError(429, '1')).mockResolvedValueOnce({ ok: 1 });
    const p = runInLane(interactive(), () => requestWithRetry(client(request), 'q'));
    await vi.advanceTimersByTimeAsync(999);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(request).toHaveBeenCalledTimes(2);
    await expect(p).resolves.toEqual({ ok: 1 });
  });

  it('caps a long Retry-After at 2s', async () => {
    const request = vi.fn().mockRejectedValueOnce(httpError(429, '30')).mockResolvedValueOnce({ ok: 1 });
    const p = runInLane(interactive(), () => requestWithRetry(client(request), 'q'));
    await vi.advanceTimersByTimeAsync(2_001);
    expect(request).toHaveBeenCalledTimes(2);
    await p;
  });

  it('does not retry when the wait would run past the request deadline', async () => {
    const request = vi.fn().mockRejectedValue(httpError(503));
    // 500ms base delay, 300ms of deadline left.
    const p = runInLane(interactive({ deadlineAt: Date.now() + 300 }), () =>
      requestWithRetry(client(request), 'q'),
    ).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await p).toBeInstanceOf(Error);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('never retries for a client that has already hung up — and does not log that it will', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const ac = new AbortController();
    ac.abort(new ClientClosedError());
    const request = vi.fn().mockRejectedValue(httpError(502));
    const p = runInLane(interactive({ signal: ac.signal }), () => requestWithRetry(client(request), 'q')).catch(
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await p).toBeInstanceOf(Error);
    expect(request).toHaveBeenCalledTimes(1);
    // A "retrying in Nms" line for a retry that never happens sends whoever reads
    // the log after the wrong cause.
    expect(warn.mock.calls.filter(([m]) => String(m).includes('retrying in'))).toHaveLength(0);
  });

  it('abandons the retry when the client hangs up during the backoff', async () => {
    const ac = new AbortController();
    const request = vi.fn().mockRejectedValueOnce(httpError(502)).mockResolvedValueOnce({ ok: 1 });
    const p = runInLane(interactive({ signal: ac.signal }), () => requestWithRetry(client(request), 'q')).catch(
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(100);
    ac.abort(new ClientClosedError());
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await p).toBeInstanceOf(Error);
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('a Postgres statement timeout (HTTP 200 + errors[])', () => {
  const statementTimeout = () => new Error('canceling statement due to statement timeout');

  it('is retried on a background lane — a pool-sync page rides it out instead of failing the walk', async () => {
    const request = vi.fn().mockRejectedValueOnce(statementTimeout()).mockResolvedValueOnce({ pools: [] });
    const p = runInLane({ lane: 'sweep', job: 'pool-sync' }, () => requestWithRetry(client(request), 'q'));
    await vi.advanceTimersByTimeAsync(501);
    await expect(p).resolves.toEqual({ pools: [] });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('is NOT retried for an interactive request: one attempt, then it degrades', async () => {
    const request = vi.fn().mockRejectedValue(statementTimeout());
    const p = runInLane(interactive(), () => requestWithRetry(client(request), 'q')).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await p).toBeInstanceOf(Error);
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('background lanes', () => {
  it('observe mode keeps the exponential schedule for a 429 (500ms, then 1s)', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(httpError(429, '0'))
      .mockRejectedValueOnce(httpError(429, '0'))
      .mockResolvedValueOnce({ ok: 1 });
    const p = runInLane({ lane: 'refresh', job: 'refresh' }, () => requestWithRetry(client(request), 'q'));
    await vi.advanceTimersByTimeAsync(499);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(request).toHaveBeenCalledTimes(3);
    await p;
  });

  it('enforce mode retries a 429 with NO sleep of its own — it waits on the paused bucket instead', async () => {
    configureIndexerGateways({ mode: 'enforce' });
    const request = vi.fn().mockRejectedValueOnce(httpError(429, '30')).mockResolvedValueOnce({ ok: 1 });
    const p = runInLane({ lane: 'sweep', job: 'pool-sync' }, () => requestWithRetry(client(request), 'q'));
    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(2);
    await expect(p).resolves.toEqual({ ok: 1 });
  });

  it('enforce mode still backs off exponentially on a 5xx (that is not a budget problem)', async () => {
    configureIndexerGateways({ mode: 'enforce' });
    const request = vi.fn().mockRejectedValueOnce(httpError(502)).mockResolvedValueOnce({ ok: 1 });
    const p = runInLane({ lane: 'sweep', job: 'pool-sync' }, () => requestWithRetry(client(request), 'q'));
    await vi.advanceTimersByTimeAsync(499);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(request).toHaveBeenCalledTimes(2);
    await p;
  });

  it('does not retry a non-transient GraphQL error (a bad field) on any lane', async () => {
    const request = vi.fn().mockRejectedValue(new Error('Cannot query field "nope" on type "Pool"'));
    await expect(
      runInLane({ lane: 'sweep', job: 'pool-sync' }, () => requestWithRetry(client(request), 'q')),
    ).rejects.toThrow(/Cannot query field/);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
