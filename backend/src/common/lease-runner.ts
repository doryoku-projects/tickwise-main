import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { RELEASE_SCRIPT, leaseOwnerId } from './redis-lease.js';
import { fenceKey, leaseKey } from './coordination-redis.js';
import { shutdownSignal } from './shutdown.js';

/**
 * P2.1 — run a fleet-wide singleton under a Redis lease (design §2.1, §2.3).
 *
 * `start()` returns IMMEDIATELY and runs the acquire loop in the background:
 * it is never awaited from `onModuleInit` (C19 — every `onModuleInit` runs
 * inside `listen()`, so an awaited wait there blocks the healthcheck, and a
 * standby must pass its healthcheck while the old holder is still alive).
 *
 * On acquire it takes a FENCE (`INCR tw:lease:v1:<ns>:<name>:fence`, in the
 * same Lua call as the `SET NX PX`) and calls `work({signal, fence, stillHeld})`
 * ONCE per acquisition. The lease is renewed every `renewMs` (default ttl/3)
 * for as long as it is held — after `work` resolves too, so a one-shot holder
 * keeps the lease and nobody else repeats it — unless `releaseWhenWorkReturns`
 * (a loop such as the live listener): then a work that returns ends the
 * session, releases the lease and re-acquires after `retryMs`.
 * `onAcquired(fence)` runs every time the session BECOMES the holder: before
 * the work on a fresh acquire, and on a fail-open local → held upgrade.
 *
 * ABORT when:
 *  - a renew answers CAS-lost (the key is gone or holds another owner), or
 *  - `stillHeld()` turned false: the last GOOD renew is older than
 *    `ttl − renewMs`. A renew that merely errored or timed out is retried
 *    after `renewMs/4` (not a full `renewMs`), so one slow Redis reply is not
 *    a lost lease; but once the window HAS lapsed the session ends for good,
 *    even if a later renew succeeds — the work may already have seen
 *    `stillHeld() === false` and stopped, and a lease renewed with no work
 *    behind it would block every other process from the singleton forever.
 *    The next acquire takes a new fence and restarts the work.
 * Work checks `stillHeld()` before each unit (a fee page, a live poll, a
 * scheduler step). On abort / stop: the signal fires, the unit in flight is
 * awaited, the lease is released (unless it was lost).
 *
 * Redis unavailable: with `failOpen` (role `all`) the work runs WITHOUT a lease
 * (fence undefined) — `all` gains no new hard dependency — and the runner keeps
 * trying to acquire; if it gets the lease the run continues as the holder, if
 * another process turns out to hold it the local run is aborted. Without
 * `failOpen` (split roles) the singleton does not run (`[alert]
 * process_role.lease_unavailable`, at most once a minute).
 */

export interface LeaseWorkContext {
  readonly name: string;
  /** Fires on lease loss, `stillHeld()` expiry, a work failure, or stop/shutdown. */
  readonly signal: AbortSignal;
  /** The fence taken at acquisition (monotonic per lease); undefined while running fail-open without Redis. */
  readonly fence: number | undefined;
  /** True while this process may still act as the holder. Check before each unit. */
  stillHeld(): boolean;
}

export type LeaseRunnerMode = 'idle' | 'standby' | 'held' | 'local' | 'stopped';

export interface LeaseRunnerStatus {
  name: string;
  mode: LeaseRunnerMode;
  held: boolean;
  fence: number | null;
  acquiredAt: string | null;
  renewFailures: number;
  lost: number;
}

export interface LeaseRunnerClock {
  now(): number;
  /** Resolves after `ms`, or as soon as `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface LeaseRunnerOptions {
  name: string;
  /** Redis source (the coordination control client). Undefined answer = unavailable. */
  redis: () => Promise<Redis | undefined>;
  namespace: string;
  ttlMs: number;
  /** Default ttl/3. */
  renewMs?: number;
  /** How often a standby retries the acquire. Default `renewMs`. */
  retryMs?: number;
  /** Run the work without a lease while Redis is unavailable (role `all`). */
  failOpen?: boolean;
  work: (ctx: LeaseWorkContext) => Promise<void> | void;
  /**
   * End the session (release, re-acquire after `retryMs`) when `work` returns
   * without being aborted. Default false: a one-shot work keeps the lease.
   */
  releaseWhenWorkReturns?: boolean;
  /** Runs each time the session becomes the holder (fresh acquire, or local → held). Errors are logged, never fatal. */
  onAcquired?: (fence: number) => Promise<void> | void;
  /** Stop when the process-wide shutdown begins (default true). */
  stopOnShutdown?: boolean;
  logger?: Pick<Logger, 'log' | 'warn' | 'error'>;
  clock?: LeaseRunnerClock;
  owner?: string;
}

/**
 * `SET key owner NX PX ttl` + `INCR fenceKey` in one call.
 * → {1, fence} acquired; {2, fence} already ours (re-entrant, extended); {0, 0} held elsewhere.
 */
export const ACQUIRE_FENCED_SCRIPT = `
if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then
  return {1, redis.call('INCR', KEYS[2])}
end
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return {2, tonumber(redis.call('GET', KEYS[2]) or '0')}
end
return {0, 0}
`;

/** 1 = renewed; 0 = CAS-lost (gone or another owner). */
export const RENEW_OWNED_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
return 0
`;

export type AcquireOutcome = { status: 'acquired'; fence: number } | { status: 'held' } | { status: 'unavailable' };
export type RenewOutcome = 'ok' | 'lost' | 'error';

export const defaultLeaseClock: LeaseRunnerClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      const timer = setTimeout(done, Math.max(0, ms));
      timer.unref?.();
      function done() {
        signal?.removeEventListener('abort', done);
        clearTimeout(timer);
        resolve();
      }
      signal?.addEventListener('abort', done, { once: true });
    }),
};

const UNAVAILABLE_ALERT_MS = 60_000;

/** Every runner started in this process (status fan-in, `/health` in worker roles). */
const runners = new Set<LeaseRunner>();

export function activeLeaseRunners(): LeaseRunner[] {
  return [...runners];
}

/** The lease names this process holds right now. */
export function leasesHeld(): string[] {
  return activeLeaseRunners()
    .filter((runner) => runner.held)
    .map((runner) => runner.name);
}

/** Specs only. */
export function resetLeaseRunnersForTests(): void {
  runners.clear();
}

function anySignal(signals: AbortSignal[]): AbortSignal {
  const ac = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ac.abort(s.reason);
      return ac.signal;
    }
  }
  const onAbort = (event: Event) => {
    if (!ac.signal.aborted) ac.abort((event.target as AbortSignal).reason);
    for (const s of signals) s.removeEventListener('abort', onAbort);
  };
  for (const s of signals) s.addEventListener('abort', onAbort, { once: true });
  return ac.signal;
}

export class LeaseRunner {
  readonly name: string;
  readonly owner: string;
  readonly ttlMs: number;
  readonly renewMs: number;
  private readonly retryMs: number;
  private readonly clock: LeaseRunnerClock;
  private readonly logger: Pick<Logger, 'log' | 'warn' | 'error'>;
  private readonly stopController = new AbortController();
  private loopPromise?: Promise<void>;
  private modeValue: LeaseRunnerMode = 'idle';
  private fenceValue: number | undefined;
  private acquiredAtValue: number | undefined;
  private lastGoodRenewAt = 0;
  private lastRenewErrored = false;
  private renewFailuresValue = 0;
  private lostCount = 0;
  private unavailableAlertAt: number | undefined;
  private sessionAbort?: AbortController;

  constructor(private readonly options: LeaseRunnerOptions) {
    this.name = options.name;
    this.owner = options.owner ?? leaseOwnerId();
    this.ttlMs = Math.max(1, Math.floor(options.ttlMs));
    this.renewMs = Math.max(1, Math.floor(options.renewMs ?? this.ttlMs / 3));
    this.retryMs = Math.max(1, Math.floor(options.retryMs ?? this.renewMs));
    this.clock = options.clock ?? defaultLeaseClock;
    this.logger = options.logger ?? new Logger(`LeaseRunner:${options.name}`);
  }

  get key(): string {
    return leaseKey(this.options.namespace, this.name);
  }

  get fenceKey(): string {
    return fenceKey(this.options.namespace, this.name);
  }

  get mode(): LeaseRunnerMode {
    return this.modeValue;
  }

  /** Holding the Redis lease (not fail-open local mode). */
  get held(): boolean {
    return this.modeValue === 'held';
  }

  get fence(): number | undefined {
    return this.fenceValue;
  }

  /** When the current holding began (ms since epoch); undefined when not holding (fail-open local included). */
  get acquiredAt(): number | undefined {
    return this.modeValue === 'held' ? this.acquiredAtValue : undefined;
  }

  /** The retry delay after a renew that ERRORED (a quarter of `renewMs`). */
  get renewRetryMs(): number {
    return Math.max(1, Math.floor(this.renewMs / 4));
  }

  status(): LeaseRunnerStatus {
    return {
      name: this.name,
      mode: this.modeValue,
      held: this.held,
      fence: this.fenceValue ?? null,
      acquiredAt: this.acquiredAtValue ? new Date(this.acquiredAtValue).toISOString() : null,
      renewFailures: this.renewFailuresValue,
      lost: this.lostCount,
    };
  }

  /** Non-blocking: the acquire loop runs in the background. Idempotent. */
  start(): void {
    if (this.loopPromise || this.stopController.signal.aborted) return;
    runners.add(this);
    if (this.options.stopOnShutdown !== false) {
      const shutdown = shutdownSignal();
      if (shutdown.aborted) {
        this.modeValue = 'stopped';
        return;
      }
      shutdown.addEventListener('abort', () => void this.stop(), { once: true });
    }
    this.modeValue = 'standby';
    this.loopPromise = this.loop().catch((err: unknown) => {
      this.logger.error(`lease ${this.name}: runner loop failed: ${(err as Error)?.message ?? String(err)}`);
    });
  }

  /** Abort the work, await the unit in flight, release the lease. Never throws. */
  async stop(): Promise<void> {
    if (!this.stopController.signal.aborted) this.stopController.abort('stop');
    this.sessionAbort?.abort('stop');
    await this.loopPromise?.catch(() => undefined);
    this.modeValue = 'stopped';
    runners.delete(this);
  }

  /** stillHeld() for the CURRENT session (false when none). */
  stillHeld(): boolean {
    const session = this.sessionAbort;
    if (!session || session.signal.aborted) return false;
    if (this.modeValue === 'local') return true;
    if (this.modeValue !== 'held') return false;
    return this.withinHoldWindow();
  }

  /** The last good renew is younger than `ttl − renewMs`. */
  private withinHoldWindow(): boolean {
    return this.clock.now() - this.lastGoodRenewAt < this.ttlMs - this.renewMs;
  }

  private async fireOnAcquired(fence: number): Promise<void> {
    if (!this.options.onAcquired) return;
    try {
      await this.options.onAcquired(fence);
    } catch (err) {
      this.logger.error(`lease ${this.name}: onAcquired failed: ${(err as Error)?.message ?? String(err)}`);
    }
  }

  /** One fenced acquire attempt. */
  async tryAcquire(): Promise<AcquireOutcome> {
    const redis = await this.options.redis().catch(() => undefined);
    if (!redis) return { status: 'unavailable' };
    try {
      const reply = (await redis.eval(ACQUIRE_FENCED_SCRIPT, 2, this.key, this.fenceKey, this.owner, String(this.ttlMs))) as unknown;
      const [code, fence] = Array.isArray(reply) ? reply.map(Number) : [0, 0];
      if (code === 1 || code === 2) return { status: 'acquired', fence: Number(fence) };
      return { status: 'held' };
    } catch {
      return { status: 'unavailable' };
    }
  }

  /** One renew: `ok`, CAS-`lost`, or a transport `error` (retried until stillHeld expires). */
  async renewOnce(): Promise<RenewOutcome> {
    const redis = await this.options.redis().catch(() => undefined);
    if (!redis) return 'error';
    try {
      const reply = Number(await redis.eval(RENEW_OWNED_SCRIPT, 1, this.key, this.owner, String(this.ttlMs)));
      return reply === 1 ? 'ok' : 'lost';
    } catch {
      return 'error';
    }
  }

  private async release(): Promise<void> {
    const redis = await this.options.redis().catch(() => undefined);
    if (!redis) return;
    try {
      await redis.eval(RELEASE_SCRIPT, 1, this.key, this.owner);
    } catch {
      // The TTL frees it anyway.
    }
  }

  private alertUnavailable(): void {
    const now = this.clock.now();
    if (this.unavailableAlertAt !== undefined && now - this.unavailableAlertAt < UNAVAILABLE_ALERT_MS) return;
    this.unavailableAlertAt = now;
    this.logger.warn(
      `[alert] process_role.lease_unavailable lease=${this.name} — Redis unreachable; ${
        this.options.failOpen ? 'running fail-open (role all)' : 'singleton stopped until Redis returns'
      }`,
    );
  }

  private async loop(): Promise<void> {
    const stop = this.stopController.signal;
    while (!stop.aborted) {
      const got = await this.tryAcquire();
      if (stop.aborted) break;
      if (got.status === 'acquired') {
        await this.session('held', got.fence);
        continue;
      }
      if (got.status === 'unavailable') {
        this.alertUnavailable();
        if (this.options.failOpen) {
          await this.session('local', undefined);
          continue;
        }
      }
      this.modeValue = 'standby';
      await this.clock.sleep(this.retryMs, stop);
    }
  }

  private async session(initial: 'held' | 'local', fence: number | undefined): Promise<void> {
    const stop = this.stopController.signal;
    const abort = new AbortController();
    this.sessionAbort = abort;
    this.modeValue = initial;
    this.fenceValue = fence;
    this.acquiredAtValue = initial === 'held' ? this.clock.now() : undefined;
    this.lastGoodRenewAt = this.clock.now();
    this.lastRenewErrored = false;
    let workFailed = false;
    let workReturned = false;
    if (initial === 'held') this.logger.log(`lease ${this.name} acquired (fence ${fence})`);

    const runner = this;
    const ctx: LeaseWorkContext = {
      name: this.name,
      signal: abort.signal,
      get fence() {
        return runner.sessionAbort === abort ? runner.fenceValue : undefined;
      },
      stillHeld: () => this.sessionAbort === abort && this.stillHeld(),
    };

    // `onAcquired` runs BEFORE the work (the scheduler's fleet-wide BullMQ
    // concurrency must be in place before anything is enqueued) but inside the
    // work's chain, so a slow hook never holds up the renew loop below.
    const work = Promise.resolve()
      .then(() => (initial === 'held' ? this.fireOnAcquired(fence as number) : undefined))
      .then(() => this.options.work(ctx))
      .then(() => {
        if (this.options.releaseWhenWorkReturns && !abort.signal.aborted) {
          workReturned = true;
          abort.abort('work_returned');
        }
      })
      .catch((err: unknown) => {
        workFailed = true;
        this.logger.error(`lease ${this.name}: work failed: ${(err as Error)?.message ?? String(err)}`);
        if (!abort.signal.aborted) abort.abort('work_failed');
      });

    const wake = anySignal([abort.signal, stop]);
    while (!abort.signal.aborted && !stop.aborted) {
      const delay = this.modeValue !== 'held' ? this.retryMs : this.lastRenewErrored ? this.renewRetryMs : this.renewMs;
      await this.clock.sleep(delay, wake);
      if (abort.signal.aborted || stop.aborted) break;
      if (this.modeValue === 'held') {
        const renewed = await this.renewOnce();
        this.lastRenewErrored = renewed === 'error';
        if (renewed === 'ok' && !this.withinHoldWindow()) {
          // The hold window lapsed before this renew landed: the work may
          // already have stopped on `stillHeld() === false`. End the session
          // for good — never a renewed lease with nothing running behind it.
          this.lostCount += 1;
          this.logger.warn(
            `[alert] process_role.lease_lost lease=${this.name} fence=${this.fenceValue} reason=renew_late lastGoodMsAgo=${
              this.clock.now() - this.lastGoodRenewAt
            } — releasing and re-acquiring`,
          );
          abort.abort('lease_expired');
        } else if (renewed === 'ok') {
          this.lastGoodRenewAt = this.clock.now();
        } else if (renewed === 'lost') {
          this.lostCount += 1;
          this.logger.warn(`[alert] process_role.lease_lost lease=${this.name} fence=${this.fenceValue} reason=cas_lost`);
          abort.abort('lease_lost');
        } else {
          this.renewFailuresValue += 1;
          if (!this.stillHeld()) {
            this.lostCount += 1;
            this.logger.warn(
              `[alert] process_role.lease_lost lease=${this.name} fence=${this.fenceValue} reason=renew_expired lastGoodMsAgo=${
                this.clock.now() - this.lastGoodRenewAt
              }`,
            );
            abort.abort('lease_expired');
          }
        }
      } else {
        // Fail-open local run: keep trying to take the lease for real.
        const got = await this.tryAcquire();
        if (got.status === 'acquired') {
          this.modeValue = 'held';
          this.fenceValue = got.fence;
          this.acquiredAtValue = this.clock.now();
          this.lastGoodRenewAt = this.clock.now();
          this.lastRenewErrored = false;
          this.logger.log(`lease ${this.name} acquired after a fail-open run (fence ${got.fence})`);
          // Not awaited: renewals must keep running while the hook does (it never throws).
          void this.fireOnAcquired(got.fence);
        } else if (got.status === 'held') {
          this.logger.warn(`lease ${this.name}: another process holds it — stopping the fail-open local run`);
          abort.abort('held_elsewhere');
        } else {
          this.alertUnavailable();
        }
      }
    }
    if (!abort.signal.aborted) abort.abort(stop.aborted ? 'stop' : 'ended');
    await work;
    // Release only what we held; the CAS script makes releasing a LOST lease a
    // no-op anyway (it is someone else's now), so no separate `lost` check.
    if (this.modeValue === 'held') await this.release();
    this.modeValue = stop.aborted ? 'stopped' : 'standby';
    this.fenceValue = undefined;
    this.acquiredAtValue = undefined;
    if (this.sessionAbort === abort) this.sessionAbort = undefined;
    // A failed work (or, with `releaseWhenWorkReturns`, a returned one)
    // releases the lease and backs off one retry, so another process (or this
    // one, later) runs it — never a held lease with no work, never a hot loop.
    if ((workFailed || workReturned) && !stop.aborted) await this.clock.sleep(this.retryMs, stop);
  }
}

/** Convenience: build + start. */
export function startLeaseRunner(options: LeaseRunnerOptions): LeaseRunner {
  const runner = new LeaseRunner(options);
  runner.start();
  return runner;
}
