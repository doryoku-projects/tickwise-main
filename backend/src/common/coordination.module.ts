import { Global, Module } from '@nestjs/common';
import { FEE_COORDINATION } from '../sync/fee-signals.js';
import { FEE_RPC_FETCH } from '../sync/fee-measurer.js';
import { SYNC_FLOW_LOCKS } from '../sync/sync.service.js';
import { CoordinationRedis } from './coordination-redis.js';
import { FeeModelsRedis, FeeWorkerLeaseHolder, feeCoordination, feeRpcFetch } from './fee-coordination.js';
import { FlowLocks } from './flow-lock.js';
import { InvalidationBus } from './invalidation-bus.js';
import { LimiterFactory } from './limiter-factory.js';
import { ProcessStatusService } from './process-status.js';
import { RpcBudget } from './rpc-budget.js';
import { WRITE_BUDGET_REDIS } from './write-budget.js';

/**
 * P2/P3 coordination, global (integrator, I1). ONE DI graph in every role
 * (design §2.1): everything here is built everywhere and does nothing until
 * its flag or `PROCESS_ROLE` asks — with the defaults (`all`,
 * `PROCESS_LEASES=auto`, every P2/P3 flag off) no provider connects to Redis,
 * starts a timer that touches Redis, or changes a write.
 *
 *  - `CoordinationRedis`  the ONE lazy control client on redis-state
 *                         (`REDIS_URL`): leases, flow locks, status fan-in, the
 *                         shared limiters, the invalidation bus, the GCRA
 *                         buckets, the write budget (`WRITE_BUDGET_REDIS`), the
 *                         fee signals.
 *  - `FlowLocks`          P2.1 per-flow locks; also `SYNC_FLOW_LOCKS` for
 *                         `SyncService` (pass-through with leases off).
 *  - `ProcessStatusService` status fan-in (`tw:proc:v1:<ns>:…`; off in `all`
 *                         with leases off).
 *  - `LimiterFactory`, `InvalidationBus`, `RpcBudget`  P2.2 (memory / off / 0 =
 *                         today).
 *  - `FEE_COORDINATION`   P3 fee signals + hint streams + the `fee-worker`
 *                         lease; UNDEFINED with leases off (today).
 *  - `FEE_RPC_FETCH`      every fee / P3.1 viem attempt through `RpcBudget`
 *                         (plain fetch while `RPC_BUDGET_PER_SEC=0`).
 *
 * Bound elsewhere (their consumers' modules): the write budget, its monitor
 * and controller and `POSITION_WRITE_OBSERVER` (DatabaseModule),
 * `PAGE_FEE_READER` (SubgraphModule), `GECKOTERMINAL_GCRA` (PricingModule).
 */
@Global()
@Module({
  providers: [
    CoordinationRedis,
    { provide: WRITE_BUDGET_REDIS, useExisting: CoordinationRedis },
    FlowLocks,
    { provide: SYNC_FLOW_LOCKS, useExisting: FlowLocks },
    ProcessStatusService,
    LimiterFactory,
    InvalidationBus,
    RpcBudget,
    FeeModelsRedis,
    FeeWorkerLeaseHolder,
    {
      provide: FEE_COORDINATION,
      inject: [CoordinationRedis, FeeModelsRedis, FeeWorkerLeaseHolder],
      useFactory: (coordination: CoordinationRedis, models: FeeModelsRedis, holder: FeeWorkerLeaseHolder) =>
        feeCoordination(coordination, models, holder),
    },
    {
      provide: FEE_RPC_FETCH,
      inject: [RpcBudget],
      useFactory: (budget: RpcBudget) => feeRpcFetch(budget),
    },
  ],
  exports: [
    CoordinationRedis,
    WRITE_BUDGET_REDIS,
    FlowLocks,
    SYNC_FLOW_LOCKS,
    ProcessStatusService,
    LimiterFactory,
    InvalidationBus,
    RpcBudget,
    FeeWorkerLeaseHolder,
    FEE_COORDINATION,
    FEE_RPC_FETCH,
  ],
})
export class CoordinationModule {}
