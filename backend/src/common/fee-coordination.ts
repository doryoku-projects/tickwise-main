import { Inject, Injectable, Logger, Optional, type OnApplicationShutdown, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AppConfigService } from '../config/app-config.service.js';
import { ROLE_OPTIONS } from '../read-models/models-redis.js';
import type { FeeCoordination, FeeRedis, FeeWorkerLease } from '../sync/fee-signals.js';
import type { FeeRpcFetchFactory } from '../sync/fee-measurer.js';
import { CoordinationRedis, SharedControlClient } from './coordination-redis.js';
import { LeaseRunner } from './lease-runner.js';
import { can, currentProcessRole, leasesEnabled } from './process-role.js';
import type { RpcBudget } from './rpc-budget.js';

/**
 * Integrator wiring (I1) between package A's coordination layer and package
 * F's fee pass (design §2.3 lease `fee-worker`, §9.4 signals, §9.5 fence).
 *
 * `FeeWorkerLeaseHolder` owns the fleet-wide `fee-worker` lease — TTL 30 s,
 * renewed every 10 s, FENCED — in the roles that run fee ticks
 * (`can('fee-worker')`: all, fee), only while leases are on and the fee
 * refresh is enabled. Its work holds the lease and does nothing else: the fee
 * service asks `held()` before every tick, page and cursor write, and fences
 * its cursor / tally writes with `fence()`. `failOpen` in role `all`: while
 * Redis is down the `all` process keeps ticking (unfenced, the runner's local
 * mode) — `all` gains no new hard dependency (design §2.1).
 *
 * `feeCoordination()` builds the `FEE_COORDINATION` value; it is UNDEFINED
 * with leases off (role `all` + `PROCESS_LEASES=auto`, the default): the fee
 * service, the hint publisher and the store feed then run exactly as today
 * (in-process signals, direct hints, no Redis). With leases on, EVERY role gets
 * it (signals go to redis-state from every producer), and only roles holding
 * `fee-worker` get a `lease`; a role without it is never a worker
 * (`isWorker` checks `can('fee-worker')` itself).
 */

export const FEE_WORKER_LEASE = 'fee-worker';
export const FEE_WORKER_LEASE_TTL_MS = 30_000;
export const FEE_WORKER_LEASE_RENEW_MS = 10_000;

interface FeeCoordinationConfigView {
  positionFeeRefreshEnabled?: boolean;
  redisModelsUrl?: string;
  redisUrl?: string;
}

/**
 * The `FeeWorkerLease` view of a `LeaseRunner`, mapped EXACTLY as
 * `FeeWorkerLease` documents it (fee-signals.ts):
 *   held       → `runner.stillHeld()` (NOT the `held` getter: it is false in the
 *                fail-open local mode, and true for a lapsed hold window)
 *   fence      → `runner.fence` (undefined while held = fail-open local mode → unfenced writes)
 *   acquiredAt → `runner.acquiredAt` (undefined = the ramp uses the boot time)
 */
export function feeWorkerLeaseView(
  runner: Pick<LeaseRunner, 'stillHeld' | 'fence' | 'acquiredAt'>,
): FeeWorkerLease {
  return {
    held: () => runner.stillHeld(),
    fence: () => runner.fence,
    acquiredAt: () => runner.acquiredAt,
  };
}

@Injectable()
export class FeeWorkerLeaseHolder implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FeeWorkerLeaseHolder.name);
  private runnerValue?: LeaseRunner;
  private ownCoordination?: CoordinationRedis;

  constructor(
    @Optional() @Inject(AppConfigService) private readonly config?: AppConfigService,
    @Optional() @Inject(CoordinationRedis) private readonly coordination?: CoordinationRedis,
  ) {}

  /** This role takes part in the `fee-worker` lease at all. */
  get applies(): boolean {
    const view = this.config as unknown as FeeCoordinationConfigView | undefined;
    return leasesEnabled() && can('fee-worker') && view?.positionFeeRefreshEnabled === true;
  }

  /** The runner (built lazily, started in `onModuleInit`); undefined where the lease does not apply. */
  get runner(): LeaseRunner | undefined {
    if (!this.applies) return undefined;
    if (!this.runnerValue) {
      const coordination = this.coordination ?? (this.ownCoordination ??= new CoordinationRedis(this.config));
      this.runnerValue = new LeaseRunner({
        name: FEE_WORKER_LEASE,
        redis: () => coordination.client(),
        namespace: coordination.namespace,
        ttlMs: FEE_WORKER_LEASE_TTL_MS,
        renewMs: FEE_WORKER_LEASE_RENEW_MS,
        failOpen: currentProcessRole() === 'all',
        // Hold, do nothing: the fee service's ticks ask `held()` themselves.
        work: () => undefined,
        logger: this.logger,
      });
    }
    return this.runnerValue;
  }

  /** Non-blocking: the acquire loop runs in the background (C19). */
  onModuleInit(): void {
    this.runner?.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.runnerValue?.stop();
    await this.ownCoordination?.close().catch(() => undefined);
  }
}

/** One lazily connected control client on redis-models (`REDIS_MODELS_URL ?? REDIS_URL`): the row-hint streams. */
@Injectable()
export class FeeModelsRedis implements OnApplicationShutdown {
  private readonly logger = new Logger(FeeModelsRedis.name);
  private readonly control: SharedControlClient;

  constructor(@Optional() @Inject(AppConfigService) private readonly config?: AppConfigService) {
    const view = () => this.config as unknown as FeeCoordinationConfigView | undefined;
    this.control = new SharedControlClient(
      () => view()?.redisModelsUrl ?? view()?.redisUrl ?? 'redis://localhost:6379',
      ROLE_OPTIONS.control,
      'tw-fee-models',
      this.logger,
    );
  }

  async client(): Promise<Redis | undefined> {
    try {
      return await this.control.get();
    } catch {
      return undefined;
    }
  }

  /** Last shutdown phase (see `CoordinationRedis.onApplicationShutdown`): a final hint publish may still be in flight. */
  async onApplicationShutdown(): Promise<void> {
    await this.control.quit();
  }
}

/**
 * The `FEE_COORDINATION` value (see the file comment): undefined with leases
 * off; with leases on, signals + loss counters on redis-state, hint streams on
 * redis-models, and the `fee-worker` lease view where this role holds one.
 */
export function feeCoordination(
  coordination: Pick<CoordinationRedis, 'client' | 'namespace'>,
  models: Pick<FeeModelsRedis, 'client'>,
  holder: Pick<FeeWorkerLeaseHolder, 'runner'>,
  leases: boolean = leasesEnabled(),
): FeeCoordination | undefined {
  if (!leases) return undefined;
  const runner = holder.runner;
  return {
    leasesEnabled: true,
    namespace: coordination.namespace,
    stateRedis: async () => (await coordination.client()) as unknown as FeeRedis | undefined,
    modelsRedis: async () => (await models.client()) as unknown as FeeRedis | undefined,
    ...(runner ? { lease: feeWorkerLeaseView(runner) } : {}),
  };
}

/**
 * The `FEE_RPC_FETCH` factory: every fee (`fee`) and P3.1 (`backfill`) RPC
 * attempt through the Dwellir account budget. `budgetedFetch(lane)` — NEVER
 * `budgetedFetch(lane, url)`: its second parameter is a fetch implementation
 * (the account is derived from each request's URL). With
 * `RPC_BUDGET_PER_SEC=0` (the default) it hands back plain `fetch` — today.
 */
export function feeRpcFetch(budget: Pick<RpcBudget, 'budgetedFetch'>): FeeRpcFetchFactory {
  return (_url, lane) => budget.budgetedFetch(lane) as typeof fetch;
}
