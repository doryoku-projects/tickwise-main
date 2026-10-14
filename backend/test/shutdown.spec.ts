/*
 * The process-wide stop signal (`common/shutdown.ts`): a long job raced against
 * it returns `{ interrupted }` the moment the shutdown begins, so BullMQ
 * records it COMPLETED instead of leaving it `active` to fail as "stalled";
 * and a worker close never holds the shutdown past its grace.
 */
import { getMaxListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  beginShutdown,
  closeWithin,
  isInterrupted,
  isShuttingDown,
  raceShutdown,
  resetShutdownForTests,
  shutdownSignal,
} from '../src/common/shutdown.js';

afterEach(() => {
  resetShutdownForTests();
  vi.useRealTimers();
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('the stop signal', () => {
  it('is off until begun, idempotent, and keeps the first reason', () => {
    expect(isShuttingDown()).toBe(false);
    beginShutdown('SIGTERM');
    beginShutdown('SIGINT');
    expect(isShuttingDown()).toBe(true);
    expect(shutdownSignal().reason).toBe('SIGTERM');
  });
});

describe('raceShutdown', () => {
  it('passes the work through untouched when nothing stops', async () => {
    await expect(raceShutdown(Promise.resolve(42))).resolves.toBe(42);
    await expect(raceShutdown(Promise.reject(new Error('boom')))).rejects.toThrow('boom');
  });

  it('answers { interrupted } the moment the shutdown begins, without waiting for the work', async () => {
    const work = deferred<number>();
    const raced = raceShutdown(work.promise);
    beginShutdown('SIGTERM');
    const outcome = await raced;
    expect(outcome).toEqual({ interrupted: 'shutdown' });
    expect(isInterrupted(outcome)).toBe(true);
    work.resolve(1); // finishing later changes nothing
  });

  it('answers { interrupted } at once when the shutdown has already begun', async () => {
    beginShutdown('SIGTERM');
    const work = deferred<number>();
    await expect(raceShutdown(work.promise)).resolves.toEqual({ interrupted: 'shutdown' });
  });

  it('sends a rejection of the ABANDONED work to its handler, never to unhandledRejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const abandoned = vi.fn();
      const work = deferred<number>();
      const raced = raceShutdown(work.promise, abandoned);
      beginShutdown('SIGTERM');
      await raced;
      work.reject(new Error('client was closed'));
      await new Promise((r) => setTimeout(r, 0));
      expect(abandoned).toHaveBeenCalledTimes(1);
      expect((abandoned.mock.calls[0]![0] as Error).message).toBe('client was closed');
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('a work that wins the race is not reported as abandoned', async () => {
    const abandoned = vi.fn();
    await raceShutdown(Promise.resolve('done'), abandoned);
    beginShutdown('SIGTERM');
    await new Promise((r) => setTimeout(r, 0));
    expect(abandoned).not.toHaveBeenCalled();
  });

  it('the shared signal has no listener limit (Node 20, prod, warned "MaxListenersExceededWarning" past 10 raced jobs)', () => {
    // Prod runs node:20 (Dockerfile), where an AbortSignal's default limit is 10; Node 24, which
    // runs these specs, defaults it to 0 and never warns — so this only catches a regression
    // when the suite runs on Node < 24. The fix was checked on node:20-alpine with a repro.
    expect(getMaxListeners(shutdownSignal())).toBe(0);
    resetShutdownForTests();
    expect(getMaxListeners(shutdownSignal())).toBe(0);
  });

  it('only the exact marker reads as interrupted', () => {
    expect(isInterrupted({ interrupted: 'shutdown' })).toBe(true);
    expect(isInterrupted({ interrupted: true })).toBe(false);
    expect(isInterrupted(null)).toBe(false);
    expect(isInterrupted({})).toBe(false);
  });
});

describe('closeWithin', () => {
  it('true when the close finishes in time', async () => {
    await expect(closeWithin(async () => undefined, 1_000)).resolves.toBe(true);
  });

  it('false — and stops waiting — when the close outlives the grace', async () => {
    vi.useFakeTimers();
    const close = vi.fn(() => new Promise<void>(() => undefined)); // BullMQ waiting on a job forever
    const result = closeWithin(close, 8_000);
    await vi.advanceTimersByTimeAsync(8_000);
    await expect(result).resolves.toBe(false);
    // No second ("force") call: BullMQ hands back the same pending close.
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('false, never a throw, when the close fails or throws synchronously', async () => {
    await expect(closeWithin(async () => Promise.reject(new Error('redis gone')), 1_000)).resolves.toBe(false);
    await expect(
      closeWithin(() => {
        throw new Error('sync throw');
      }, 1_000),
    ).resolves.toBe(false);
  });
});
