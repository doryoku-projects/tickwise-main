/*
 * The process-wide "we are stopping" signal.
 *
 * WHY: on a deploy the old process got SIGTERM and died at once — Nest's
 * shutdown hooks were never enabled — so every job it held stayed `active` in
 * BullMQ until its 30-min lock lapsed, then failed as "job stalled more than
 * allowable limit" (3 on the M10 rig after four quick restarts), and every
 * `sync_runs` row it had open stayed `running` forever.
 *
 * Now `main.ts` enables the hooks and `QueueService.onModuleDestroy` calls
 * `beginShutdown()` first: long jobs return at once as `{ interrupted }`
 * (`raceShutdown`), so BullMQ records them COMPLETED — each one is re-started
 * by something that already exists (the boot resume for a backfill, the boot
 * kick for the sweeps, the cron for the refresh) — and `SyncRepository` closes
 * this process's open runs as `interrupted`.
 *
 * Railway's default grace between SIGTERM and SIGKILL is 0 s: set
 * RAILWAY_DEPLOYMENT_DRAINING_SECONDS (≥ 15) or none of this gets to run. A
 * process that is SIGKILLed anyway (or crashes, or OOMs) is covered by the
 * run reaper (`SyncRepository.reapStaleRuns`) and the boot backfill resume.
 */

import { setMaxListeners } from 'node:events';

/**
 * One listener per raced job sits on this ONE signal (`raceShutdown`), and the
 * sync workers run up to ~20 jobs at once — past Node's default of 10 that
 * printed `MaxListenersExceededWarning: Possible EventTarget memory leak` on
 * prod right after a boot. Not a leak: each listener is removed when its job
 * settles. 0 = no limit for this signal only.
 */
function newController(): AbortController {
  const c = new AbortController();
  setMaxListeners(0, c.signal);
  return c;
}

let controller = newController();

/** Starts the shutdown (idempotent). Everything racing `shutdownSignal()` stops waiting. */
export function beginShutdown(reason = 'shutdown'): void {
  if (!controller.signal.aborted) controller.abort(reason);
}

export function isShuttingDown(): boolean {
  return controller.signal.aborted;
}

export function shutdownSignal(): AbortSignal {
  return controller.signal;
}

/** What a raced job returns when the process stopped first. */
export interface Interrupted {
  interrupted: 'shutdown';
}

/**
 * Resolves with `work`'s outcome, or with `{ interrupted: 'shutdown' }` as soon
 * as the shutdown begins (immediately if it already has). The abandoned work
 * keeps running until the process exits; its later rejection goes to
 * `onAbandonedError` instead of becoming an unhandled rejection.
 */
export function raceShutdown<T>(
  work: Promise<T>,
  onAbandonedError: (err: unknown) => void = () => undefined,
): Promise<T | Interrupted> {
  const signal = controller.signal;
  if (signal.aborted) {
    work.catch(onAbandonedError);
    return Promise.resolve({ interrupted: 'shutdown' });
  }
  return new Promise<T | Interrupted>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      // The work's own rejection handler below reports a later failure (once).
      resolve({ interrupted: 'shutdown' });
    };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        if (settled) return;
        settled = true;
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        if (settled) return onAbandonedError(err);
        settled = true;
        reject(err);
      },
    );
  });
}

export function isInterrupted(value: unknown): value is Interrupted {
  return typeof value === 'object' && value !== null && (value as Interrupted).interrupted === 'shutdown';
}

/**
 * `close()` (BullMQ's waits for the jobs in flight), but never waits longer
 * than `ms`. NOT followed by `close(true)`: BullMQ returns the pending close
 * for any second call, so a "force" would wait just as long. A worker still
 * closing at `ms` is left to the process exit — its unfinished job goes to the
 * stalled checker, i.e. exactly the old behaviour. Never throws. True = closed.
 */
export async function closeWithin(close: () => Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref?.();
  });
  try {
    let closing: Promise<boolean>;
    try {
      closing = close().then(
        () => true,
        () => false,
      );
    } catch {
      return false;
    }
    return await Promise.race([closing, timedOut]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Specs only. */
export function resetShutdownForTests(): void {
  controller = newController();
}
