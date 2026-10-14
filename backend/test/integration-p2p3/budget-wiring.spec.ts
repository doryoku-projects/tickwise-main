/*
 * I1 — the shared write budget's integration seams:
 *  - the Nest-built WriteBudgetService is THE process budget in every mode
 *    (registered in onModuleInit), so MONGO_BULK_WRITE_MAX_OPS caps every
 *    `budgetedBulkWrite` caller even with the budget off;
 *  - the fee tick's AbortSignal reaches the budget through `writeRpcFees`
 *    (a chunk still waiting when its tick ends is refused, never sent late);
 *  - the token repository's writes are budgeted, charged to the caller's lane,
 *    and byte-identical to today with the budget off.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { processWriteBudget, registerProcessWriteBudget, WriteBudgetService } from '../../src/common/write-budget.js';
import { resolveWriteBudgetSettings } from '../../src/common/write-budget-model.js';
import { runInWriteLane } from '../../src/common/write-lane.js';
import { budgetedBulkWrite } from '../../src/database/budgeted-write.js';
import { PositionsRepository } from '../../src/database/positions.repository.js';
import { TokensRepository } from '../../src/database/token.repository.js';
import { FakeRedis } from '../write-budget/fake-redis.js';

afterEach(() => registerProcessWriteBudget(undefined));

function service(env: Record<string, unknown>) {
  const redis = new FakeRedis(Date.now);
  const svc = new WriteBudgetService({ writeBudget: resolveWriteBudgetSettings(env as never) } as never, { client: async () => redis as never, namespace: 'wiring' });
  (svc as unknown as { logger: unknown }).logger = { warn: () => {}, log: () => {} };
  return svc;
}

describe('the process budget (onModuleInit)', () => {
  it('a Nest-built budget registers in EVERY mode — off included — and unregisters at destroy', async () => {
    const svc = service({ MONGO_BULK_WRITE_MAX_OPS: '200' });
    expect(processWriteBudget()).toBeUndefined(); // the constructor registers only when on
    svc.onModuleInit();
    expect(processWriteBudget()).toBe(svc);
    // Budget OFF, MONGO_BULK_WRITE_MAX_OPS=200: a caller passing no budget is chunked by it.
    const model = { bulkWrite: vi.fn(async () => ({})) };
    await budgetedBulkWrite(model, Array.from({ length: 450 }, (_, i) => i), { bulkOptions: { ordered: false } });
    expect(model.bulkWrite.mock.calls.map((c) => (c[0] as unknown[]).length)).toEqual([200, 200, 50]);
    // …with today's options exactly (no timeoutMS while off).
    expect(model.bulkWrite.mock.calls[0]![1]).toEqual({ ordered: false });
    await svc.onModuleDestroy();
    expect(processWriteBudget()).toBeUndefined();
  });

  it('budget off and MONGO_BULK_WRITE_MAX_OPS unset: one bulkWrite, today', async () => {
    const svc = service({});
    svc.onModuleInit();
    const model = { bulkWrite: vi.fn(async () => ({})) };
    await budgetedBulkWrite(model, Array.from({ length: 1_200 }, (_, i) => i), { bulkOptions: { ordered: false } });
    expect(model.bulkWrite).toHaveBeenCalledTimes(1);
    await svc.onModuleDestroy();
  });
});

describe('writeRpcFees forwards the fee tick\'s AbortSignal to the budget', () => {
  it('a chunk waiting on a deep fee-lane debt is refused at once when the tick\'s signal is aborted — nothing is sent', async () => {
    const svc = service({ WRITE_BUDGET_MODE: 'enforce' });
    registerProcessWriteBudget(svc);
    svc.charge(1_000_000, 'fee'); // ~10,000 s of debt at R = MIN
    await new Promise((r) => setImmediate(r));
    const m = { bulkWrite: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })) };
    const repo = new PositionsRepository({ positionModel: () => m } as never, {} as never);
    const tick = new AbortController();
    tick.abort(new Error('tick ended'));
    await expect(
      repo.writeRpcFees(1, 'uniswap-v4', [{ positionId: '1', fees0: '1', fees1: '0', block: 9 }], new Date(), { signal: tick.signal }),
    ).rejects.toThrow('tick ended');
    expect(m.bulkWrite).not.toHaveBeenCalled();
  }, 5_000);
});

describe('token repository writes go through the budget', () => {
  function tokens(bulkWrite: ReturnType<typeof vi.fn>) {
    return new TokensRepository({ tokenModel: () => ({ bulkWrite }) } as never);
  }

  it('budget off: upsertPrices / upsertSecurity / recordPriceMisses are today\'s single bulkWrite with today\'s options', async () => {
    const bulkWrite = vi.fn(async () => ({}));
    const repo = tokens(bulkWrite);
    await repo.upsertPrices(1, [{ address: '0xA', priceUsd: 1 }]);
    await repo.upsertSecurity([{ chainId: 1, address: '0xB' } as never]);
    await repo.recordPriceMisses(1, ['0xC'], new Date());
    expect(bulkWrite).toHaveBeenCalledTimes(3);
    expect(bulkWrite.mock.calls[0]![1]).toEqual({ ordered: false });
    expect(bulkWrite.mock.calls[1]![1]).toEqual({ ordered: false });
    expect(bulkWrite.mock.calls[2]![1]).toEqual({ ordered: true });
  });

  it('budget on: each write takes units in the CALLER\'s lane', async () => {
    const svc = service({ WRITE_BUDGET_MODE: 'observe' });
    registerProcessWriteBudget(svc);
    const bulkWrite = vi.fn(async () => ({}));
    const repo = tokens(bulkWrite);
    await runInWriteLane('backfill', () => repo.recordPriceMisses(1, ['0xA', '0xB'], new Date()));
    await runInWriteLane('other', () => repo.upsertPrices(1, [{ address: '0xA', priceUsd: 2 }]));
    const lanes = svc.snapshot().perLane;
    expect(lanes.backfill.acquires).toBe(1);
    expect(lanes.other.acquires).toBe(1);
  });
});
