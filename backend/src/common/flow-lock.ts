import { Inject, Injectable, Logger, Optional, type OnModuleDestroy } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import type { Redis } from 'ioredis';
import type { SyncFlowLocks } from '../sync/sync.service.js';
import { CoordinationRedis } from './coordination-redis.js';
import { LeaseRunner, defaultLeaseClock, type LeaseRunnerClock } from './lease-runner.js';
import { RELEASE_SCRIPT } from './redis-lease.js';
import { currentProcessRole, leasesEnabled } from './process-role.js';

/**
 * P2.1 — fleet-wide per-flow exclusivity (design §2.1, §2.3):
 * `flow:{backfill,refresh,pool-sync,token-price,token-security}:<chain>:<protocol>`
 * on `tw:lease:v1:<ns>:<name>`, TTL 60 s, heartbeat every 20 s, released in
 * `finally`.
 *
 * Leases OFF (role `all` + `PROCESS_LEASES=auto`, the default): a pure
 * pass-through — `fn` runs, nothing touches Redis, and the caller's own
 * in-process guard (`SyncService.activeBackfills` etc.) is today's only
 * exclusivity.
 *
 * Leases ON: `held` when another process holds the lock — `fn` does NOT run.
 * The caller decides what that means (backfill: re-delay the job; refresh,
 * pool sync, token sweeps: skip — the next repeatable tick runs).
 *
 * Redis unavailable while leases are on: role `all` runs `fn` unlocked
 * (fail-open = today's single process); a split role answers `held` (fail
 * closed — design §3.6: split singletons stop while Redis is down; a backfill
 * re-delays, a sweep skips).
 *
 * A lock lost mid-run (CAS-lost renew) cannot stop `fn` (SyncService takes no
 * signal); it is logged as `[alert] process_role.lease_lost`.
 */

export const FLOW_LOCK_TTL_MS = 60_000;
export const FLOW_LOCK_RENEW_MS = 20_000;

export type FlowLockResult<T> = { held: true } | { held: false; value: T };

export interface FlowLockOptions {
  redis: () => Promise<Redis | undefined>;
  namespace: string;
  /** Default: `leasesEnabled()`. */
  leases?: boolean;
  /** Run unlocked when Redis is unavailable. Default: role `all`. */
  failOpen?: boolean;
  ttlMs?: number;
  renewMs?: number;
  clock?: LeaseRunnerClock;
  logger?: Pick<Logger, 'log' | 'warn' | 'error'>;
  onHeld?: () => void;
}

/** Run `fn` under the fleet lock `name` (see the header for every outcome). */
export async function withFlowLock<T>(name: string, fn: () => Promise<T>, options: FlowLockOptions): Promise<FlowLockResult<T>> {
  const leases = options.leases ?? leasesEnabled();
  if (!leases) return { held: false, value: await fn() };

  const failOpen = options.failOpen ?? currentProcessRole() === 'all';
  const logger = options.logger ?? new Logger('FlowLock');
  const clock = options.clock ?? defaultLeaseClock;
  // A LeaseRunner object is only used for its fenced acquire / renew / key
  // helpers here: the lock is held for exactly one `fn`, not run in a loop.
  const lock = new LeaseRunner({
    name,
    redis: options.redis,
    namespace: options.namespace,
    ttlMs: options.ttlMs ?? FLOW_LOCK_TTL_MS,
    renewMs: options.renewMs ?? FLOW_LOCK_RENEW_MS,
    work: () => undefined,
    stopOnShutdown: false,
    clock,
    logger,
  });

  const got = await lock.tryAcquire();
  if (got.status === 'held') {
    options.onHeld?.();
    return { held: true };
  }
  if (got.status === 'unavailable') {
    if (!failOpen) {
      logger.warn(`[alert] process_role.lease_unavailable lock=${name} — Redis unreachable; flow not started (split role fails closed)`);
      options.onHeld?.();
      return { held: true };
    }
    logger.warn(`[alert] process_role.lease_unavailable lock=${name} — Redis unreachable; running unlocked (role all, fail-open)`);
    return { held: false, value: await fn() };
  }

  const heartbeat = new AbortController();
  let lost = false;
  const beat = (async () => {
    while (!heartbeat.signal.aborted) {
      await clock.sleep(lock.renewMs, heartbeat.signal);
      if (heartbeat.signal.aborted) return;
      const renewed = await lock.renewOnce();
      if (renewed === 'lost' && !lost) {
        lost = true;
        logger.warn(`[alert] process_role.lease_lost lock=${name} fence=${got.fence} reason=cas_lost — the flow keeps running; another process may start it`);
        return;
      }
    }
  })();
  try {
    return { held: false, value: await fn() };
  } finally {
    heartbeat.abort('done');
    await beat.catch(() => undefined);
    // Compare-and-delete: a lock stolen mid-run is someone else's and stays.
    await releaseLock(options.redis, lock.key, lock.owner);
  }
}

async function releaseLock(redis: () => Promise<Redis | undefined>, key: string, owner: string): Promise<void> {
  const client = await redis().catch(() => undefined);
  if (!client) return;
  try {
    await client.eval(RELEASE_SCRIPT, 1, key, owner);
  } catch {
    // The TTL frees it anyway.
  }
}

/** `flow:<flow>:<chainId>:<protocol>` for the sweeps (SyncService has its own `flowLockName`). */
export function sweepFlowLockName(flow: 'pool-sync' | 'token-price' | 'token-security', chainId: number, protocol: string): string {
  return `flow:${flow}:${chainId}:${protocol}`;
}

/**
 * The injectable form, bound by the integrator to `SYNC_FLOW_LOCKS`
 * (`SyncService`'s contract) and used by the sweeps. Pass-through while
 * leases are off.
 *
 * Without a bound `CoordinationRedis` it builds its own from
 * `AppConfigService` (like `QueueService` / `LiveEventListenerService` /
 * `ProcessStatusService`): an unbound coordination must never read as "Redis
 * unavailable" forever — in a split role that refused every flow (backfills
 * re-delayed until `sync.backfill_held_timeout`, every refresh and sweep
 * skipped) with nothing but a warning per call.
 */
@Injectable()
export class FlowLocks implements SyncFlowLocks, OnModuleDestroy {
  private readonly logger = new Logger(FlowLocks.name);
  private ownCoordination?: CoordinationRedis;

  constructor(
    @Optional() @Inject(CoordinationRedis) private readonly coordination?: CoordinationRedis,
    // Specs only.
    @Optional() private readonly overrides?: Partial<Pick<FlowLockOptions, 'leases' | 'failOpen' | 'clock' | 'ttlMs' | 'renewMs'>>,
    // APPENDED (specs construct this positionally): the fallback's config.
    @Optional() @Inject(AppConfigService) private readonly config?: AppConfigService,
  ) {}

  /** The bound coordination, else one built here (lazily; it connects only when a lock is taken with leases on). */
  private coord(): CoordinationRedis {
    if (this.coordination) return this.coordination;
    this.ownCoordination ??= new CoordinationRedis(this.config);
    return this.ownCoordination;
  }

  async onModuleDestroy(): Promise<void> {
    await this.ownCoordination?.close().catch(() => undefined);
  }

  run<T>(name: string, fn: () => Promise<T>): Promise<FlowLockResult<T>> {
    const leases = this.overrides?.leases ?? leasesEnabled();
    // Leases off: pure pass-through — never build (or connect) a client.
    if (!leases) return withFlowLock(name, fn, { redis: () => Promise.resolve(undefined), namespace: 'local', leases: false });
    const coordination = this.coord();
    return withFlowLock(name, fn, {
      redis: () => coordination.client(),
      namespace: coordination.namespace,
      logger: this.logger,
      ...this.overrides,
    });
  }
}
