import { Logger } from '@nestjs/common';
import type { CoordinationRedisSource } from './coordination-redis.js';
import { LeaseRunner, defaultLeaseClock, type LeaseRunnerClock, type LeaseWorkContext } from './lease-runner.js';
import { currentProcessRole } from './process-role.js';

/**
 * Leader-only pollers for the role split (capacity plan step 1).
 *
 * A per-replica poller — the token exclusion-set rebuild, the indexing-status
 * probes, the leaderboard warm cycle — runs ONCE per fleet under a Redis lease
 * (`tw:lease:v1:<ns>:<name>`), and publishes what it computed; every other
 * replica runs a cheap FOLLOWER cycle that reads the published copy and falls
 * back to the local work only when that copy is missing, stale or Redis is
 * unreachable (each consumer owns that rule).
 *
 * Only built when leases are on (`leasesEnabled()`). With `PROCESS_ROLE=all` +
 * `PROCESS_LEASES=auto` (the default) nothing here is constructed: no lease,
 * no Redis key, today's per-process timers.
 *
 *  - `lead(ctx)` runs on the holder: once on acquire, then every `intervalMs`
 *    for as long as the lease is held — at a FIXED RATE, like the
 *    `setInterval` it replaces: the next cycle starts `intervalMs` after the
 *    previous one STARTED, and a cycle that overruns skips the ticks it ran
 *    over (it never queues them; `nextLeadDelayMs`). A fixed delay after each
 *    cycle stretched the period by every cycle's duration, which ate the
 *    leaderboard followers' margin before their copies expire. An error in one
 *    cycle is logged and the next cycle runs on time — a cycle never ends the
 *    holding.
 *  - `follow()` runs every `followIntervalMs` on every process that is NOT
 *    leading (standby, or a split role while Redis is down). Single-flight.
 *  - `leading` is true while this process holds the lease, or runs fail-open
 *    (role `all` with Redis down — the LeaseRunner's `local` mode).
 *
 * The lease is released whenever the lead loop returns (`stillHeld()` lapsed),
 * so a holder never keeps a lease with no poller behind it.
 */
export interface LeaderLoopOptions {
  /** Lease name (`tw:lease:v1:<ns>:<name>`). */
  name: string;
  coordination: CoordinationRedisSource;
  /** The leader's cycle period. */
  intervalMs: number;
  lead: (ctx: LeaseWorkContext) => Promise<void> | void;
  follow?: () => Promise<void> | void;
  /** Default `intervalMs`. */
  followIntervalMs?: number;
  /** Lease TTL. Default 30 s (renewed every 10 s). */
  ttlMs?: number;
  /** Default: role `all` runs fail-open (no new hard dependency on Redis). */
  failOpen?: boolean;
  clock?: LeaseRunnerClock;
  logger?: Pick<Logger, 'log' | 'warn' | 'error'>;
  owner?: string;
}

export const LEADER_LOOP_DEFAULT_TTL_MS = 30_000;

/**
 * Fixed rate: the wait before the next leader cycle, given how long the last
 * one ran. `interval − elapsed` while it ran shorter than the interval; past
 * it, the remainder to the next tick of the original grid (`setInterval` with
 * an overlap skip), so an overrunning cycle is followed by a full-length gap
 * at most, never by a burst.
 */
export function nextLeadDelayMs(intervalMs: number, elapsedMs: number): number {
  const interval = Math.max(1, intervalMs);
  const elapsed = Math.max(0, elapsedMs);
  return interval - (elapsed % interval);
}

export class LeaderLoop {
  readonly runner: LeaseRunner;
  private readonly clock: LeaseRunnerClock;
  private readonly logger: Pick<Logger, 'log' | 'warn' | 'error'>;
  private readonly stopController = new AbortController();
  private following = false;
  private started = false;
  private followLoop?: Promise<void>;

  constructor(private readonly options: LeaderLoopOptions) {
    this.clock = options.clock ?? defaultLeaseClock;
    this.logger = options.logger ?? new Logger(`LeaderLoop:${options.name}`);
    const coordination = options.coordination;
    this.runner = new LeaseRunner({
      name: options.name,
      redis: () => coordination.client(),
      namespace: coordination.namespace,
      ttlMs: options.ttlMs ?? LEADER_LOOP_DEFAULT_TTL_MS,
      failOpen: options.failOpen ?? currentProcessRole() === 'all',
      releaseWhenWorkReturns: true,
      clock: this.clock,
      logger: this.logger,
      owner: options.owner,
      work: (ctx) => this.leadLoop(ctx),
    });
  }

  get name(): string {
    return this.options.name;
  }

  /** Holding the lease, or running fail-open (role `all`, Redis down). */
  get leading(): boolean {
    const mode = this.runner.mode;
    return mode === 'held' || mode === 'local';
  }

  /** Non-blocking (never awaited from a Nest hook). Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.runner.start();
    if (this.options.follow) this.followLoop = this.runFollowLoop();
  }

  async stop(): Promise<void> {
    if (!this.stopController.signal.aborted) this.stopController.abort('stop');
    await this.runner.stop();
    await this.followLoop?.catch(() => undefined);
  }

  /** One follower tick, now (skipped while leading or while one is in flight). */
  async followOnce(): Promise<boolean> {
    if (!this.options.follow || this.leading || this.following) return false;
    this.following = true;
    try {
      await this.options.follow();
      return true;
    } catch (err) {
      this.logger.warn(`${this.options.name}: follower cycle failed: ${(err as Error)?.message ?? String(err)}`);
      return false;
    } finally {
      this.following = false;
    }
  }

  private async leadLoop(ctx: LeaseWorkContext): Promise<void> {
    while (ctx.stillHeld() && !ctx.signal.aborted) {
      const startedAt = this.clock.now();
      try {
        await this.options.lead(ctx);
      } catch (err) {
        this.logger.warn(`${this.options.name}: leader cycle failed: ${(err as Error)?.message ?? String(err)}`);
      }
      await this.clock.sleep(nextLeadDelayMs(this.options.intervalMs, this.clock.now() - startedAt), ctx.signal);
    }
  }

  private async runFollowLoop(): Promise<void> {
    const stop = this.stopController.signal;
    const every = Math.max(1, this.options.followIntervalMs ?? this.options.intervalMs);
    while (!stop.aborted) {
      await this.clock.sleep(every, stop);
      if (stop.aborted) break;
      await this.followOnce();
    }
  }
}
