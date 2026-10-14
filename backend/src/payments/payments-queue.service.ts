import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Job, Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { AppConfigService } from '../config/app-config.service.js';
import { can, currentProcessRole, leasesEnabled } from '../common/process-role.js';
import { PaymentReconcileService } from './payment-reconcile.service.js';
import { AuthorizationWatcherService } from './providers/x402/authorization-watcher.service.js';
import { SubscriptionSweepService } from './subscription-sweep.service.js';

/**
 * ITS OWN QUEUE, AND THAT IS THE POINT.
 *
 * `QueueService.clearAllQueuesOnBoot()` calls `obliterate({force: true})` on
 * `positions-sync` (and its sibling sync queues) at boot when
 * `QUEUE_CLEAR_ON_BOOT=true` (off by default since 2026-10-03) — waiting,
 * active, delayed, completed, failed, repeatables, the lot. That is tolerable
 * for position syncs, which are regenerable from the chain: the worst case is
 * re-doing work.
 *
 * Money jobs are not regenerable. A `payment-reconcile` job wiped mid-flight is
 * a customer who paid and does not have their plan, and nothing will ever
 * notice on its own. So the payments queue is a SEPARATE queue with a separate
 * name, deliberately outside the reach of that call, and this file must never
 * grow an `obliterate` of its own.
 *
 * The one thing that IS swept on boot is repeatables — by name, and only
 * repeatables. A repeatable carries no state; leaving a stale one behind means
 * an old interval keeps firing after the env changed. Actual jobs are left
 * exactly where they are.
 */
export const PAYMENTS_QUEUE = 'payments';

const JOB_SUBSCRIPTION_SWEEP = 'subscription-sweep';
const JOB_PAYMENT_RECONCILE = 'payment-reconcile';
/** One repeatable per watched chain: `chain-watch:<chainId>`. */
const JOB_CHAIN_WATCH_PREFIX = 'chain-watch';

/**
 * One at a time. Both jobs walk overlapping sets of subscriptions and invoices,
 * and both are written to be idempotent — but serialising them removes the
 * whole class of "the sweep lapsed it while the reconcile was paying it".
 */
const PAYMENTS_QUEUE_CONCURRENCY = 1;

@Injectable()
export class PaymentsQueueService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PaymentsQueueService.name);
  private readonly connection: Redis;
  private readonly queue: Queue;
  private worker?: Worker;

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(SubscriptionSweepService) private readonly sweep: SubscriptionSweepService,
    @Inject(PaymentReconcileService) private readonly reconcile: PaymentReconcileService,
    @Inject(AuthorizationWatcherService) private readonly watcher: AuthorizationWatcherService,
  ) {
    this.connection = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
    this.connection.on('error', (error) => {
      this.logger.error(`Payments queue Redis error: ${error.message}`);
    });
    this.queue = new Queue(PAYMENTS_QUEUE, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 30_000 },
        // Kept FAR longer than the positions queue keeps its history. A failed
        // money job is the audit trail for "why does this customer not have
        // what they paid for", and 500 entries of it is not a lot to hold.
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 5000 },
      },
    });
  }

  async onModuleInit(): Promise<void> {
    // P2.1: the payments Worker, its repeatables and the boot kick run only in
    // `all` and `sync`. An `api` process keeps the Queue (admin enqueues and
    // status) and takes no job.
    if (!can('payments-worker')) {
      this.logger.log(`Payments worker not started: role ${currentProcessRole()} is a producer only`);
      return;
    }
    // Leases on: the per-process concurrency 1 becomes FLEET-wide, so a deploy
    // overlap or a mixed `all` + `sync` fleet never runs the sweep beside the
    // reconcile (design §2.1; set here rather than by the scheduler holder
    // because this queue lives in its own module — same value, idempotent).
    if (leasesEnabled()) {
      try {
        await this.queue.setGlobalConcurrency(PAYMENTS_QUEUE_CONCURRENCY);
        this.logger.log(`Global concurrency set: ${PAYMENTS_QUEUE}=${PAYMENTS_QUEUE_CONCURRENCY}`);
      } catch (err) {
        this.logger.warn(`Failed to set global concurrency on ${PAYMENTS_QUEUE}: ${(err as Error)?.message ?? String(err)}`);
      }
    }
    // NO `obliterate` HERE. See the file comment — an unprocessed money job
    // does not come back.
    this.worker = new Worker(
      PAYMENTS_QUEUE,
      async (job: Job) => {
        if (job.name === JOB_SUBSCRIPTION_SWEEP) return this.sweep.sweep();
        if (job.name === JOB_PAYMENT_RECONCILE) return this.reconcile.reconcile();
        if (job.name.startsWith(`${JOB_CHAIN_WATCH_PREFIX}:`)) {
          const chainId = Number(job.name.slice(JOB_CHAIN_WATCH_PREFIX.length + 1));
          return this.watcher.watchChain(chainId);
        }
        // An unknown job name is a deploy that removed a handler while jobs of
        // that name were still queued. Loud, and NOT a throw: throwing would
        // retry it five times and then bury it in the failed set anyway.
        this.logger.error(`[alert] payments.unknown_job name=${job.name} id=${job.id ?? 'unknown'}`);
        return { ignored: job.name };
      },
      { connection: this.connection, concurrency: PAYMENTS_QUEUE_CONCURRENCY, lockDuration: 10 * 60_000 },
    );
    this.worker.on('failed', (job, error) => {
      this.logger.error(
        `[alert] payments.job_failed name=${job?.name ?? 'unknown'} id=${job?.id ?? 'unknown'} ` +
          `attempts=${job?.attemptsMade ?? 0} error=${error.message}`,
      );
    });

    await this.registerRepeatables();

    // Boot kick, same reasoning as the pool-sync one: a repeatable's first run
    // is a whole interval away, so a deploy cadence faster than the interval
    // would starve the sweep entirely. The sweep coalesces, so a kick landing
    // beside a cron tick is one run.
    if (this.config.subscriptionSweepEnabled) {
      await this.enqueueSweep();
      this.logger.log('Subscription sweep kicked on boot');
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
    await this.connection.quit();
  }

  /** Admin-triggered sweep. Same job the cron enqueues. */
  async enqueueSweep(): Promise<string | undefined> {
    const job = await this.queue.add(JOB_SUBSCRIPTION_SWEEP, {}, { jobId: `sweep-${Date.now()}` });
    return job.id;
  }

  async enqueueReconcile(): Promise<string | undefined> {
    const job = await this.queue.add(JOB_PAYMENT_RECONCILE, {}, { jobId: `reconcile-${Date.now()}` });
    return job.id;
  }

  async status(): Promise<Record<string, number>> {
    return this.queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed', 'paused');
  }

  /**
   * Re-register the two crons. Repeatables ONLY — the sweep of stale ones is by
   * NAME, so a job sitting in `waiting` is never touched.
   */
  private async registerRepeatables(): Promise<void> {
    const existing = await this.queue.getRepeatableJobs();
    await Promise.all(
      existing
        .filter(
          (job) =>
            job.name === JOB_SUBSCRIPTION_SWEEP ||
            job.name === JOB_PAYMENT_RECONCILE ||
            job.name.startsWith(`${JOB_CHAIN_WATCH_PREFIX}:`),
        )
        .map((job) => this.queue.removeRepeatableByKey(job.key)),
    );

    // `payment-reconcile` is registered UNCONDITIONALLY, and deliberately not
    // under the sweep's flag. The two jobs answer different questions: the
    // sweep decides who keeps access, while the reconcile only ever finishes
    // applying money a customer has ALREADY PAID. Turning the lifecycle clock
    // off — a legitimate thing to do during a migration — must not also switch
    // off the one job that notices a lost webhook, or the operator has quietly
    // chosen "nobody lapses" and got "nobody who pays gets their plan" as well.
    await this.queue.add(
      JOB_PAYMENT_RECONCILE,
      {},
      { jobId: `repeat-${JOB_PAYMENT_RECONCILE}`, repeat: { every: this.config.paymentReconcileIntervalMs } },
    );

    if (this.config.subscriptionSweepEnabled) {
      await this.queue.add(
        JOB_SUBSCRIPTION_SWEEP,
        {},
        { jobId: `repeat-${JOB_SUBSCRIPTION_SWEEP}`, repeat: { every: this.config.subscriptionSweepIntervalMs } },
      );
      this.logger.log(
        `Payments crons registered: sweep every ${this.config.subscriptionSweepIntervalMs}ms, ` +
          `reconcile every ${this.config.paymentReconcileIntervalMs}ms`,
      );
    } else {
      // Worth an alert rather than a log line: with the sweep off, nothing
      // renews, nothing lapses and nothing is ever cut off. That is a valid
      // thing to want during a migration and a disaster to leave switched on.
      this.logger.warn(
        '[alert] payments.sweep_disabled — no subscription will renew, lapse or expire while SUBSCRIPTION_SWEEP_ENABLED=false ' +
          `(payment-reconcile still runs every ${this.config.paymentReconcileIntervalMs}ms)`,
      );
    }

    // ONE WATCHER REPEATABLE PER CHAIN. A self-custody rail has no webhook, so
    // this poll is the ONLY thing that notices a payment — a chain with accepted
    // tokens but no watcher means customers authorize transfers nobody reads. The
    // per-chain job name lets the worker route to `watchChain(id)`, and the
    // watcher coalesces internally so a slow tick never stacks.
    const watched = this.watcher.watchedChainIds();
    for (const chainId of watched) {
      await this.queue.add(
        `${JOB_CHAIN_WATCH_PREFIX}:${chainId}`,
        {},
        {
          jobId: `repeat-${JOB_CHAIN_WATCH_PREFIX}-${chainId}`,
          repeat: { every: this.config.paymentWatchIntervalMs },
        },
      );
    }
    if (watched.length > 0) {
      this.logger.log(
        `x402 chain watchers registered for [${watched.join(', ')}] every ${this.config.paymentWatchIntervalMs}ms`,
      );

      // Advisory only — a malformed EVM_RPC_URLS entry drops that chain from the
      // map silently, and the chain list logged above is the one place that
      // absence is visible. Deliberately not fatal: see `evmRpcUrlWarnings`.
      const rpcWarning = this.config.evmRpcUrlWarnings();
      if (rpcWarning) {
        this.logger.warn(`[alert] x402.rpc_config_suspect ${rpcWarning}`);
      }
    } else if (this.config.x402PaymentsConfigured) {
      // Configured but unwatchable — every accepted token's chain is missing an
      // RPC endpoint. A rail that can take a signature with nothing to settle it
      // must not be discovered from a customer.
      this.logger.warn(
        '[alert] payments.no_chain_watcher — the x402 rail is configured but no chain has an ' +
          'EVM_RPC_URLS entry, so a signed authorization will NOT settle automatically.',
      );
    }
  }
}
