import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONTROLLER_MISSING_MS,
  processWriteBudget,
  registerProcessWriteBudget,
  WriteBudgetService,
  WriteBudgetTimeoutError,
  writeBudgetKeys,
} from '../../src/common/write-budget.js';
import { resolveWriteBudgetSettings, type WriteBudgetSettings } from '../../src/common/write-budget-model.js';
import { runInWriteLane } from '../../src/common/write-lane.js';
import { BUDGETED_CHUNK_TIMEOUT_MS, budgetedBulkWrite, budgetedWrite, chargePrimaryRead } from '../../src/database/budgeted-write.js';
import { fakeClock, FakeRedis } from './fake-redis.js';

const NS = 'spec';

function budget(env: Record<string, unknown>, opts: { redis?: FakeRedis | null; clock?: ReturnType<typeof fakeClock> } = {}) {
  const clock = opts.clock ?? fakeClock();
  const redis = opts.redis === undefined ? new FakeRedis(clock.now) : opts.redis;
  const settings: WriteBudgetSettings = resolveWriteBudgetSettings(env as never);
  const source = redis ? { client: async () => redis as never, namespace: NS } : { client: async () => undefined, namespace: NS };
  const svc = new WriteBudgetService({ writeBudget: settings } as never, source, { now: clock.now, sleep: clock.sleep });
  const warns: string[] = [];
  (svc as unknown as { logger: unknown }).logger = { warn: (l: string) => warns.push(l), log: () => {} };
  return { svc, redis, clock, warns };
}

/** A fake model recording every bulkWrite call. */
function model(opts: { failOnCall?: number; latencyMs?: number; clock?: ReturnType<typeof fakeClock> } = {}) {
  const calls: Array<{ ops: unknown[]; options?: Record<string, unknown> }> = [];
  return {
    calls,
    bulkWrite: async (ops: unknown[], options?: Record<string, unknown>) => {
      calls.push(options === undefined ? { ops } : { ops, options });
      if (opts.latencyMs) opts.clock?.advance(opts.latencyMs);
      if (opts.failOnCall === calls.length) throw new Error('bulkWrite failed');
      return { upsertedCount: ops.length, modifiedCount: 0, matchedCount: 0, upsertedIds: { 0: `id${calls.length}` } };
    },
  };
}

const ops = (n: number) => Array.from({ length: n }, (_, i) => ({ updateOne: { filter: { i }, update: { $set: { i } } } }));

afterEach(() => registerProcessWriteBudget(undefined));

describe('write budget — off (the default) is today', () => {
  it('acquire does nothing and touches no Redis', async () => {
    const { svc, redis } = budget({});
    const grant = await svc.acquire(500, { lane: 'backfill' });
    expect(grant).toMatchObject({ mode: 'off', waitedMs: 0, source: 'off' });
    expect(redis!.calls).toEqual([]);
    expect(processWriteBudget()).toBeUndefined();
  });

  it('budgetedBulkWrite = one bulkWrite with the caller’s options, no timeoutMS, no chunking', async () => {
    const { svc, redis } = budget({});
    const m = model();
    const out = await budgetedBulkWrite(m, ops(1200), { budget: svc, bulkOptions: { ordered: false } });
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]!.ops).toHaveLength(1200);
    expect(m.calls[0]!.options).toEqual({ ordered: false });
    expect(out).toMatchObject({ chunks: 1, ops: 1200, upsertedCount: 1200, waitedMs: 0 });
    expect(redis!.calls).toEqual([]);
  });

  it('with no budget and no options it calls bulkWrite(ops) exactly', async () => {
    const m = model();
    await budgetedBulkWrite(m, ops(3));
    expect(m.calls).toEqual([{ ops: ops(3) }]);
  });

  it('keeps the caller’s own chunk cap (today’s pool writes of 500)', async () => {
    const m = model();
    await budgetedBulkWrite(m, ops(1200), { maxOps: 500 });
    expect(m.calls.map((c) => c.ops.length)).toEqual([500, 500, 200]);
  });

  it('MONGO_BULK_WRITE_MAX_OPS chunks even while the budget is off', async () => {
    const { svc } = budget({ MONGO_BULK_WRITE_MAX_OPS: 300 });
    const m = model();
    await budgetedBulkWrite(m, ops(700), { budget: svc });
    expect(m.calls.map((c) => c.ops.length)).toEqual([300, 300, 100]);
    expect(m.calls[0]!.options).toBeUndefined();
  });
});

describe('write budget — observe', () => {
  it('chunks at ≤ 500, takes units per chunk, never sleeps, and records every chunk’s latency by size class', async () => {
    const { svc, redis, clock } = budget({ WRITE_BUDGET_MODE: 'observe' });
    const m = model({ latencyMs: 40, clock });
    await runInWriteLane('refresh', () => budgetedBulkWrite(m, ops(1200), { budget: svc, unitsPerOp: 1 }));
    expect(m.calls.map((c) => c.ops.length)).toEqual([500, 500, 200]);
    expect(m.calls[0]!.options).toEqual({ timeoutMS: BUDGETED_CHUNK_TIMEOUT_MS });
    expect(clock.slept).toEqual([]);
    await new Promise((r) => setImmediate(r));
    const keys = writeBudgetKeys(NS);
    expect(await redis!.lrange(keys.latency('m'), 0, -1)).toHaveLength(3);
    const minute = await redis!.hgetall(keys.minute(Math.floor(clock.now() / 60_000)));
    expect(Number(minute.all)).toBe(1200);
    expect(Number(minute.refresh)).toBe(1200);
    const snap = svc.snapshot();
    expect(snap.perLane.refresh.acquires).toBe(3);
    expect(snap.perLane.refresh.waitP95Ms).toBeGreaterThan(0); // the would-wait is reported
    expect(snap.chunks.byClass.m.count).toBe(3);
  });

  it('never refuses: a caller’s maxWaitMs is ignored, the would-wait is reported, the write goes out', async () => {
    const { svc } = budget({ WRITE_BUDGET_MODE: 'observe' });
    const m = model();
    svc.charge(225, 'pools');
    await new Promise((r) => setImmediate(r));
    const out = await budgetedBulkWrite(m, ops(1), { budget: svc, unitsPerOp: 50, lane: 'pools', maxWaitMs: 1 });
    expect(m.calls).toHaveLength(1);
    expect(out.waitedMs).toBe(0);
    expect(svc.snapshot().perLane.pools.refused).toBe(0);
    expect(svc.snapshot().perLane.pools.waitP95Ms).toBeGreaterThan(1);
  });

  it('laneWaitTotalMs stays 0 in observe (it never sleeps, so the budget holds nothing back)', async () => {
    const { svc } = budget({ WRITE_BUDGET_MODE: 'observe' });
    for (let i = 0; i < 4; i++) await svc.acquire(125, { lane: 'backfill' });
    expect(svc.snapshot().perLane.backfill.waitP95Ms).toBeGreaterThan(0); // a would-wait existed
    expect(svc.laneWaitTotalMs('backfill')).toBe(0);
  });

  it('registers itself as the process budget when on', () => {
    const { svc } = budget({ WRITE_BUDGET_MODE: 'observe' });
    expect(processWriteBudget()).toBe(svc);
  });
});

describe('write budget — enforce', () => {
  it('sleeps the wait the bucket asks for, charged to the async context’s lane', async () => {
    const { svc, clock } = budget({ WRITE_BUDGET_MODE: 'enforce' });
    // R = MIN 100 with no controller: fee lane 25 u/s + pool 100 → the 3rd 125-u chunk waits
    const waits: number[] = [];
    await runInWriteLane('fee', async () => {
      for (let i = 0; i < 3; i++) waits.push((await svc.acquire(125)).waitedMs);
    });
    expect(waits[0]).toBe(0);
    expect(waits[2]).toBeGreaterThan(0);
    expect(clock.slept.length).toBeGreaterThan(0);
    expect(svc.snapshot().perLane.fee.acquires).toBe(3);
    expect(svc.snapshot().perLane.other.acquires).toBe(0);
  });

  it('laneWaitTotalMs: Σ granted waits per lane under enforce, booked before the sleep (backfill.slow reads it)', async () => {
    const { svc } = budget({ WRITE_BUDGET_MODE: 'enforce' });
    expect(svc.laneWaitTotalMs('backfill')).toBe(0);
    const grants: number[] = [];
    await runInWriteLane('backfill', async () => {
      for (let i = 0; i < 3; i++) grants.push((await svc.acquire(125)).wouldWaitMs);
    });
    expect(grants.some((g) => g > 0)).toBe(true);
    expect(svc.laneWaitTotalMs('backfill')).toBe(grants.reduce((a, b) => a + b, 0));
    expect(svc.laneWaitTotalMs('fee')).toBe(0);
  });

  it('charges the batch’s primary-read units with the FIRST chunk only', async () => {
    const { svc } = budget({ WRITE_BUDGET_MODE: 'enforce' });
    const spy = vi.spyOn(svc, 'acquire');
    const m = model();
    await budgetedBulkWrite(m, ops(600), { budget: svc, unitsPerOp: 1, readDocs: 1000, lane: 'refresh' });
    expect(spy.mock.calls.map((c) => c[0])).toEqual([500 + 150, 100]);
    expect(spy.mock.calls[0]![1]).toMatchObject({ lane: 'refresh' });
  });

  it('unitsOf prices each op (an insert costs more than a section update)', async () => {
    const { svc } = budget({ WRITE_BUDGET_MODE: 'enforce' });
    const spy = vi.spyOn(svc, 'acquire');
    const m = model();
    const mixed = [{ k: 'insert' }, { k: 'section' }, { k: 'section' }];
    await budgetedBulkWrite(m, mixed, { budget: svc, unitsOf: (op) => (op.k === 'insert' ? 1.5 : 0.6) });
    expect(spy.mock.calls[0]![0]).toBeCloseTo(2.7, 9);
  });

  it('a wait past maxWaitMs takes nothing, writes nothing and throws WriteBudgetTimeoutError', async () => {
    const { svc } = budget({ WRITE_BUDGET_MODE: 'enforce' });
    const m = model();
    svc.charge(225, 'pools'); // pools lane (5) + the pool (100) + 120 u of debt, never slept on
    await new Promise((r) => setImmediate(r));
    await expect(budgetedBulkWrite(m, ops(1), { budget: svc, unitsPerOp: 50, lane: 'pools', maxWaitMs: 100 })).rejects.toBeInstanceOf(
      WriteBudgetTimeoutError,
    );
    expect(m.calls).toHaveLength(0);
    expect(svc.snapshot().perLane.pools.refused).toBe(1);
    // nothing was taken by the refusal: the same call with room to wait goes through after (170 u debt / 5 u/s)
    await budgetedBulkWrite(m, ops(1), { budget: svc, unitsPerOp: 50, lane: 'pools', maxWaitMs: 34_000 });
    expect(m.calls).toHaveLength(1);
  });

  it('a chunk that throws is recorded and propagates; earlier chunks stay written and seen by onChunk', async () => {
    const { svc, redis } = budget({ WRITE_BUDGET_MODE: 'enforce' });
    const m = model({ failOnCall: 2 });
    const seen: number[] = [];
    await expect(
      budgetedBulkWrite(m, ops(700), { budget: svc, onChunk: (_r, chunk, offset) => void seen.push(offset, chunk.length) }),
    ).rejects.toThrow('bulkWrite failed');
    expect(seen).toEqual([0, 500]);
    await new Promise((r) => setImmediate(r));
    expect(await redis!.lrange(writeBudgetKeys(NS).latency('m'), 0, -1)).toHaveLength(2); // both chunks, the failed one too
  });

  it('rebases upserted ids to the index in the whole batch', async () => {
    const m = model();
    const out = await budgetedBulkWrite(m, ops(5), { maxOps: 2 });
    expect(out.upsertedIds).toEqual({ 0: 'id1', 2: 'id2', 4: 'id3' });
  });

  it('a read that decided "nothing to write" is still charged (never waited on)', async () => {
    const { svc, redis, clock } = budget({ WRITE_BUDGET_MODE: 'enforce' });
    const m = model();
    await budgetedBulkWrite(m, [], { budget: svc, readDocs: 2000, lane: 'refresh' });
    chargePrimaryRead(1000, { budget: svc, lane: 'refresh' });
    await new Promise((r) => setImmediate(r));
    expect(m.calls).toHaveLength(0);
    expect(clock.slept).toEqual([]);
    const minute = await redis!.hgetall(writeBudgetKeys(NS).minute(Math.floor(clock.now() / 60_000)));
    expect(Number(minute.refresh)).toBeCloseTo(450, 9);
  });

  it('the no-monitor cap holds the backfill lane at 100 u/s even with R at MAX', async () => {
    const { svc, redis, clock } = budget({ WRITE_BUDGET_MODE: 'enforce' });
    await redis!.set(writeBudgetKeys(NS).rate, '450', 'PX', 600_000);
    const start = clock.now();
    for (let i = 0; i < 40; i++) await svc.acquire(50, { lane: 'backfill' });
    const elapsedSec = (clock.now() - start) / 1000;
    // 100 u/s after the cap's own one-second burst, however much R and the pool hold
    expect(40 * 50).toBeLessThanOrEqual(100 * elapsedSec + 100 + 1e-6);
    expect((40 * 50) / elapsedSec).toBeGreaterThan(80);
  });

  it('with MONGO_MONITOR_URI the backfill lane may borrow past 100 u/s', async () => {
    const { svc, redis, clock } = budget({ WRITE_BUDGET_MODE: 'enforce', MONGO_MONITOR_URI: 'mongodb://mon/' });
    await redis!.set(writeBudgetKeys(NS).rate, '450', 'PX', 600_000);
    const start = clock.now();
    for (let i = 0; i < 40; i++) await svc.acquire(50, { lane: 'backfill' });
    expect((40 * 50) / ((clock.now() - start) / 1000)).toBeGreaterThan(300);
  });
});

describe('budgetedWrite (one non-bulk write: updateMany, findOneAndUpdate)', () => {
  it('off: runs the write and nothing else', async () => {
    const { svc, redis } = budget({});
    const acquire = vi.spyOn(svc, 'acquire');
    const rec = vi.spyOn(svc, 'recordChunk');
    expect(await budgetedWrite(async () => 'done', { units: 150, ops: 500, budget: svc })).toBe('done');
    expect(await budgetedWrite(async () => 'no budget', { units: 150, ops: 500 })).toBe('no budget');
    expect(redis!.calls).toEqual([]);
    expect(acquire).not.toHaveBeenCalled();
    expect(rec).not.toHaveBeenCalled();
  });

  it('on: acquires the units for the lane, then records the write as a chunk of `ops` docs', async () => {
    const { svc, clock } = budget({ WRITE_BUDGET_MODE: 'enforce' });
    const spy = vi.spyOn(svc, 'acquire');
    const rec = vi.spyOn(svc, 'recordChunk');
    const order: string[] = [];
    spy.mockImplementation(async (...args) => {
      order.push('acquire');
      return WriteBudgetService.prototype.acquire.apply(svc, args);
    });
    await runInWriteLane('refresh', () =>
      budgetedWrite(
        async () => {
          order.push('write');
          clock.advance(120);
          return 1;
        },
        { units: 150, ops: 500, budget: svc, now: clock.now },
      ),
    );
    expect(order).toEqual(['acquire', 'write']);
    expect(spy.mock.calls[0]).toEqual([150, { lane: 'refresh', maxWaitMs: undefined, signal: undefined }]);
    expect(rec.mock.calls[0]![0]).toEqual({ ms: 120, units: 150, ops: 500, lane: 'refresh' });
  });

  it('a write that throws is still recorded, and the error propagates', async () => {
    const { svc } = budget({ WRITE_BUDGET_MODE: 'enforce' });
    const rec = vi.spyOn(svc, 'recordChunk');
    await expect(budgetedWrite(async () => Promise.reject(new Error('boom')), { units: 1, ops: 1, budget: svc })).rejects.toThrow('boom');
    expect(rec).toHaveBeenCalledTimes(1);
  });
});

describe('write budget — fallbacks and alerts', () => {
  it('Redis down → a per-process floor at MIN / WRITE_BUDGET_LOCAL_DIVISOR', async () => {
    const { svc, redis } = budget({ WRITE_BUDGET_MODE: 'enforce' });
    redis!.failing = true;
    const grant = await svc.acquire(10, { lane: 'refresh' });
    expect(grant.source).toBe('local');
    expect(grant.rate).toBeCloseTo(100 / 3, 9);
    expect(svc.snapshot().localFallbacks).toBe(1);
  });

  it('no Redis configured at all → the same local floor', async () => {
    const { svc } = budget({ WRITE_BUDGET_MODE: 'enforce', WRITE_BUDGET_LOCAL_DIVISOR: 4 }, { redis: null });
    expect((await svc.acquire(1)).rate).toBe(25);
  });

  it('no controller-written R → acquirers run at MIN and, after 30 s, alert controller_missing', async () => {
    const { svc, clock, warns } = budget({ WRITE_BUDGET_MODE: 'observe' });
    expect((await svc.acquire(1)).rate).toBe(100);
    clock.advance(CONTROLLER_MISSING_MS + 1);
    await svc.acquire(1);
    expect(warns.some((w) => w.includes('[alert] write_budget.controller_missing'))).toBe(true);
  });

  it('a controller-written R is used and clears the missing state', async () => {
    const { svc, redis, warns, clock } = budget({ WRITE_BUDGET_MODE: 'observe' });
    await redis!.set(writeBudgetKeys(NS).rate, '320', 'PX', 30_000);
    expect((await svc.acquire(1)).rate).toBe(320);
    clock.advance(CONTROLLER_MISSING_MS + 1);
    await redis!.set(writeBudgetKeys(NS).rate, '320', 'PX', 30_000);
    await svc.acquire(1);
    expect(warns).toEqual([]);
  });

  it('a chunk above 500 ops while the budget is on alerts oversize_chunk', () => {
    const { svc, warns } = budget({ WRITE_BUDGET_MODE: 'observe' });
    svc.recordChunk({ ms: 300, units: 600, ops: 600 });
    svc.recordChunk({ ms: 100, units: 500, ops: 500 });
    expect(warns.filter((w) => w.includes('[alert] write_budget.oversize_chunk'))).toHaveLength(1);
    expect(svc.snapshot().chunks.oversize).toBe(1);
  });

  it('a single wait over 5 min alerts starved for that lane', async () => {
    const { svc, warns } = budget({ WRITE_BUDGET_MODE: 'observe' });
    // R = MIN 100 with no controller; every other lane idle, so the pools debt is
    // repaid at all of R (its 5 u/s + the idle 95): 40,000 u ≈ 400 s of debt.
    await svc.acquire(100 * 400, { lane: 'pools' });
    expect(warns.some((w) => w.includes('[alert] write_budget.starved lane=pools'))).toBe(true);
  });
});
