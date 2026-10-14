import { afterEach, describe, expect, it } from 'vitest';
import type { Job } from 'bullmq';
import { inJobLane, writeLaneForJob } from '../../src/queues/queue.service.js';
import { currentWriteLane } from '../../src/common/write-lane.js';
import { currentIndexerContext } from '../../src/subgraph/hyperindex/indexer-context.js';
import { registerProcessWriteBudget, WriteBudgetService, writeBudgetKeys } from '../../src/common/write-budget.js';
import { resolveWriteBudgetSettings } from '../../src/common/write-budget-model.js';
import { budgetedBulkWrite } from '../../src/database/budgeted-write.js';
import { fakeClock, FakeRedis } from '../write-budget/fake-redis.js';

const job = (name: string, chainId = 4663) => ({ name, data: { chainId } }) as unknown as Job<{ chainId: number }>;

afterEach(() => registerProcessWriteBudget(undefined));

describe('QueueService job → write lane (P2.4)', () => {
  it.each([
    ['backfill', 'backfill'],
    ['refresh', 'refresh'],
    ['live-refresh', 'live'],
    ['pool-sync', 'pools'],
    ['position-fee-refresh', 'fee'],
    ['token-price-sync', 'other'],
    ['token-security-sync', 'other'],
    // The admin healer rewrites a whole shard: a bulk rewrite like a backfill, never the 5 % `other` lane.
    ['recompute-aggregates', 'backfill'],
    ['something-new', 'other'],
  ])('%s → %s', (name, lane) => {
    expect(writeLaneForJob(name)).toBe(lane);
  });

  it('a processor wrapped by inJobLane sees its write lane AND its indexer lane; both end with the job', async () => {
    const seen: Array<{ write: string; indexer: string; job?: string }> = [];
    const wrapped = inJobLane(async () => {
      await Promise.resolve();
      seen.push({ write: currentWriteLane(), indexer: currentIndexerContext().lane, job: currentIndexerContext().job });
    });
    await Promise.all([wrapped(job('backfill')), wrapped(job('live-refresh')), wrapped(job('position-fee-refresh'))]);
    expect(seen).toEqual([
      { write: 'backfill', indexer: 'refresh', job: 'backfill' },
      { write: 'live', indexer: 'live', job: 'live-refresh' },
      { write: 'fee', indexer: 'sweep', job: 'position-fee-refresh' },
    ]);
    expect(currentWriteLane()).toBe('other');
  });

  it('a budgeted write inside a backfill job is charged to the backfill lane (the cap and oplog rule key on it)', async () => {
    const clock = fakeClock();
    const redis = new FakeRedis(clock.now);
    const svc = new WriteBudgetService(
      { writeBudget: resolveWriteBudgetSettings({ WRITE_BUDGET_MODE: 'observe' } as never) } as never,
      { client: async () => redis as never, namespace: 'spec' },
      { now: clock.now, sleep: clock.sleep },
    );
    (svc as unknown as { logger: unknown }).logger = { warn: () => {}, log: () => {} };
    const model = { bulkWrite: async (ops: unknown[]) => ({ upsertedCount: ops.length, modifiedCount: 0, matchedCount: 0 }) };
    const ops = Array.from({ length: 10 }, (_, i) => ({ updateOne: { filter: { i }, update: { $set: { i } } } }));
    await inJobLane(() => budgetedBulkWrite(model, ops, { budget: svc, unitsPerOp: 1 }))(job('backfill'));
    await new Promise((r) => setImmediate(r));
    const minute = await redis.hgetall(writeBudgetKeys('spec').minute(Math.floor(clock.now() / 60_000)));
    expect(Number(minute.backfill)).toBe(10);
    expect(minute.other).toBeUndefined();
  });
});
