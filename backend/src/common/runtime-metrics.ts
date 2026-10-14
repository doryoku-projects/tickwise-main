import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { AppConfigService } from '../config/app-config.service.js';
import { percentile } from '../subgraph/hyperindex/indexer-meter.js';

/**
 * Two stalls that used to be invisible, measured per 60 s window and shown in
 * `GET /admin/sync/status` → `runtime`:
 *
 *  - EVENT-LOOP DELAY (`perf_hooks.monitorEventLoopDelay`, 20 ms resolution):
 *    how late a timer fires — every request and job in this process waits
 *    that long. The histogram records the whole gap between two ticks, so an
 *    idle loop reads ≈ the resolution (p50 "21 ms"); the windows subtract it
 *    and report the DELAY only (idle ≈ 1 ms; a 300 ms block ≈ 300 ms). One Node process serves the API AND runs every job today, so
 *    a long synchronous stretch in a job (a big decode, a sort) is a latency
 *    tail for every user. The SLO is p99 ≤ 50 ms.
 *  - MONGO POOL CHECKOUT WAIT (the driver's `connectionCheckedOut` /
 *    `connectionCheckOutFailed` events, no extra query): how long an operation
 *    waited for a pooled connection before it could even be sent, and how many
 *    gave up after `MONGO_WAIT_QUEUE_TIMEOUT_MS`. On 2026-10-01 this was the
 *    25–55 s that every API read spent queued behind unindexed scans, and
 *    nothing measured it.
 *
 * Each closed window whose p99 is above `RUNTIME_WARN_MS` (100 ms) logs ONE
 * `[alert] process.event_loop_delay` / `[alert] mongo.pool_checkout_wait`
 * line (a window with wait-queue timeouts always alerts). Process-local, like
 * the read-path meter: Phase 2 publishes each role's snapshot.
 */

/** A window's p99 above this logs an `[alert]` line. */
export const RUNTIME_WARN_MS = 100;
export const RUNTIME_WINDOW_MS = 60_000;
/** Checkout samples kept per window for the percentiles (the first N of the window, like the indexer meter). */
const MAX_CHECKOUT_SAMPLES = 4096;
/** The event-loop histogram's sampling interval (subtracted from every reading, see `loopWindow`). */
export const LOOP_RESOLUTION_MS = 20;

export interface EventLoopWindow {
  startedAt: string;
  durationMs: number;
  p50Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
}

export interface PoolCheckoutWindow {
  startedAt: string;
  durationMs: number;
  /** Connections checked out (operations that got one). */
  checkouts: number;
  /** Checkouts that waited at all (> 0 ms). */
  waited: number;
  p50Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
  /** Checkouts that failed, by the driver's reason (`timeout` = the wait-queue limit). */
  failed: Record<string, number>;
}

export interface RuntimeSnapshot {
  eventLoop: { last: EventLoopWindow | null; current: EventLoopWindow | null };
  mongoPool: {
    maxPoolSize: number | null;
    waitQueueTimeoutMs: number | null;
    last: PoolCheckoutWindow | null;
    current: PoolCheckoutWindow;
  };
  warnMs: number;
}

class CheckoutWindow {
  checkouts = 0;
  waited = 0;
  maxMs = 0;
  readonly failed = new Map<string, number>();
  private readonly samples: number[] = [];

  constructor(readonly startedAt: number) {}

  checkedOut(durationMs: number): void {
    this.checkouts++;
    const ms = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
    if (ms > 0) this.waited++;
    this.maxMs = Math.max(this.maxMs, ms);
    if (this.samples.length < MAX_CHECKOUT_SAMPLES) this.samples.push(ms);
  }

  checkOutFailed(reason: string, durationMs: number): void {
    this.failed.set(reason, (this.failed.get(reason) ?? 0) + 1);
    const ms = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0;
    this.maxMs = Math.max(this.maxMs, ms);
  }

  snapshot(now: number): PoolCheckoutWindow {
    return {
      startedAt: new Date(this.startedAt).toISOString(),
      durationMs: Math.max(0, now - this.startedAt),
      checkouts: this.checkouts,
      waited: this.waited,
      p50Ms: percentile(this.samples, 0.5),
      p99Ms: percentile(this.samples, 0.99),
      maxMs: this.checkouts > 0 || this.failed.size > 0 ? Math.round(this.maxMs) : null,
      failed: Object.fromEntries(this.failed),
    };
  }
}

/**
 * The p50/p99/max of a `monitorEventLoopDelay` histogram, in ms (it reports
 * ns), MINUS the sampling interval. The histogram records the full gap between
 * two timer ticks — measured on Node 24: idle p50 21.1 ms at a 20 ms
 * resolution, a 300 ms block max 316.7 ms — so without the subtraction every
 * window over-reported by 20 ms ("p50=21.4ms" on an idle loop). Clamped at 0.
 */
export function loopWindow(
  histogram: Pick<IntervalHistogram, 'count' | 'percentile' | 'max'>,
  startedAt: number,
  now: number,
): EventLoopWindow {
  const empty = histogram.count === 0;
  const ms = (ns: number) => Math.max(0, Math.round((ns / 1e6 - LOOP_RESOLUTION_MS) * 10) / 10);
  return {
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Math.max(0, now - startedAt),
    p50Ms: empty ? null : ms(histogram.percentile(50)),
    p99Ms: empty ? null : ms(histogram.percentile(99)),
    maxMs: empty ? null : ms(histogram.max),
  };
}

const state: {
  loop?: IntervalHistogram;
  loopStartedAt: number;
  loopLast: EventLoopWindow | null;
  checkout: CheckoutWindow;
  checkoutLast: PoolCheckoutWindow | null;
  maxPoolSize: number | null;
  waitQueueTimeoutMs: number | null;
} = {
  loopStartedAt: Date.now(),
  loopLast: null,
  checkout: new CheckoutWindow(Date.now()),
  checkoutLast: null,
  maxPoolSize: null,
  waitQueueTimeoutMs: null,
};

/** The driver told us a connection was checked out after `durationMs`. */
export function observeCheckout(durationMs: number): void {
  state.checkout.checkedOut(durationMs);
}

/** The driver told us a checkout failed (`reason`: `timeout`, `poolClosed`, `connectionError`). */
export function observeCheckoutFailed(reason: string, durationMs: number): void {
  state.checkout.checkOutFailed(reason || 'unknown', durationMs);
}

/**
 * Close the current windows (called every `RUNTIME_WINDOW_MS`) and return
 * the closed ones — the caller logs their alerts.
 */
export function rollRuntimeWindows(now: number = Date.now()): { loop: EventLoopWindow | null; checkout: PoolCheckoutWindow } {
  const loop = state.loop ? loopWindow(state.loop, state.loopStartedAt, now) : null;
  state.loop?.reset();
  state.loopStartedAt = now;
  state.loopLast = loop;
  const checkout = state.checkout.snapshot(now);
  state.checkout = new CheckoutWindow(now);
  state.checkoutLast = checkout;
  return { loop, checkout };
}

/** The windows as plain JSON (for `/admin/sync/status`). */
export function runtimeSnapshot(now: number = Date.now()): RuntimeSnapshot {
  return {
    eventLoop: {
      last: state.loopLast,
      current: state.loop ? loopWindow(state.loop, state.loopStartedAt, now) : null,
    },
    mongoPool: {
      maxPoolSize: state.maxPoolSize,
      waitQueueTimeoutMs: state.waitQueueTimeoutMs,
      last: state.checkoutLast,
      current: state.checkout.snapshot(now),
    },
    warnMs: RUNTIME_WARN_MS,
  };
}

/** The alert lines a closed window deserves (pure — the service logs them). */
export function runtimeAlerts(windows: { loop: EventLoopWindow | null; checkout: PoolCheckoutWindow }, warnMs = RUNTIME_WARN_MS): string[] {
  const out: string[] = [];
  const { loop, checkout } = windows;
  if (loop?.p99Ms != null && loop.p99Ms > warnMs) {
    out.push(
      `[alert] process.event_loop_delay p50=${loop.p50Ms}ms p99=${loop.p99Ms}ms max=${loop.maxMs}ms over ${Math.round(loop.durationMs / 1000)}s ` +
        `— every request and job in this process waited this long (SLO p99 ≤ 50 ms)`,
    );
  }
  const timeouts = checkout.failed.timeout ?? 0;
  if ((checkout.p99Ms != null && checkout.p99Ms > warnMs) || timeouts > 0) {
    out.push(
      `[alert] mongo.pool_checkout_wait p50=${checkout.p50Ms}ms p99=${checkout.p99Ms}ms max=${checkout.maxMs}ms ` +
        `checkouts=${checkout.checkouts} waited=${checkout.waited} timeouts=${timeouts}` +
        (state.maxPoolSize !== null ? ` (maxPoolSize ${state.maxPoolSize}, waitQueueTimeoutMS ${state.waitQueueTimeoutMs})` : '') +
        ' — operations queued for a pooled connection',
    );
  }
  return out;
}

/** Specs only. */
export function resetRuntimeMetrics(now: number = Date.now()): void {
  state.loop?.disable();
  state.loop = undefined;
  state.loopStartedAt = now;
  state.loopLast = null;
  state.checkout = new CheckoutWindow(now);
  state.checkoutLast = null;
  state.maxPoolSize = null;
  state.waitQueueTimeoutMs = null;
}

/**
 * Starts the event-loop histogram, subscribes to the driver's checkout
 * events, and rolls both windows every minute (logging their alerts).
 * Monitoring only: a failure here never touches a request or a query.
 */
@Injectable()
export class RuntimeMetricsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RuntimeMetricsService.name);
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @Optional() @Inject(AppConfigService) private readonly config?: AppConfigService,
  ) {}

  onModuleInit(): void {
    try {
      state.loop?.disable();
      state.loop = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });
      state.loop.enable();
      state.loopStartedAt = Date.now();
    } catch (err) {
      this.logger.warn(`event-loop delay monitor unavailable: ${(err as Error)?.message ?? String(err)}`);
    }
    state.maxPoolSize = this.config?.mongoMaxPoolSize ?? null;
    state.waitQueueTimeoutMs = this.config?.mongoWaitQueueTimeoutMs ?? null;
    const client = this.connection.getClient?.();
    if (client) {
      client.on('connectionCheckedOut', (event: { durationMS?: number }) => {
        try {
          observeCheckout(Number(event?.durationMS ?? 0));
        } catch {
          // monitoring must never disturb the driver
        }
      });
      client.on('connectionCheckOutFailed', (event: { reason?: string; durationMS?: number }) => {
        try {
          observeCheckoutFailed(String(event?.reason ?? 'unknown'), Number(event?.durationMS ?? 0));
        } catch {
          // monitoring must never disturb the driver
        }
      });
    }
    this.timer = setInterval(() => {
      for (const line of runtimeAlerts(rollRuntimeWindows())) this.logger.warn(line);
    }, RUNTIME_WINDOW_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    state.loop?.disable();
  }
}
