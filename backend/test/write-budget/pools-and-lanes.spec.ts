import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerProcessWriteBudget, WriteBudgetService } from '../../src/common/write-budget.js';
import { resolveWriteBudgetSettings } from '../../src/common/write-budget-model.js';
import { currentWriteLane, explicitWriteLane, isWriteLane, runInWriteLane } from '../../src/common/write-lane.js';
import { PoolsRepository, POOL_WRITE_CHUNK, type PoolUpsert } from '../../src/database/pools.repository.js';
import { fakeClock, FakeRedis } from './fake-redis.js';

afterEach(() => registerProcessWriteBudget(undefined));

describe('write lanes (AsyncLocalStorage)', () => {
  it('defaults to other outside any scope; explicit lane is undefined there', () => {
    expect(currentWriteLane()).toBe('other');
    expect(explicitWriteLane()).toBeUndefined();
  });

  it('follows the async context, nested scopes take the inner lane', async () => {
    await runInWriteLane('backfill', async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(currentWriteLane()).toBe('backfill');
      await runInWriteLane('fee', async () => {
        await Promise.resolve();
        expect(currentWriteLane()).toBe('fee');
      });
      expect(currentWriteLane()).toBe('backfill');
    });
    expect(currentWriteLane()).toBe('other');
  });

  it('two concurrent scopes do not leak into each other', async () => {
    const seen: string[] = [];
    await Promise.all([
      runInWriteLane('refresh', async () => {
        await new Promise((r) => setTimeout(r, 5));
        seen.push(currentWriteLane());
      }),
      runInWriteLane('live', async () => {
        await new Promise((r) => setTimeout(r, 1));
        seen.push(currentWriteLane());
      }),
    ]);
    expect(seen.sort()).toEqual(['live', 'refresh']);
  });

  it('an unknown lane runs as other', () => {
    expect(isWriteLane('nope')).toBe(false);
    expect(runInWriteLane('nope' as never, () => currentWriteLane())).toBe('other');
  });
});

const base = {
  chainId: 1,
  protocol: 'uniswap-v4',
  token0: { address: '0xa', symbol: 'A', decimals: 18 },
  token1: { address: '0xb', symbol: 'B', decimals: 6 },
  fee: 3000,
  tickSpacing: 60,
  currentTick: 10,
  sqrtPriceX96: '1',
  liquidity: '1',
  createdAtTimestamp: 1,
  metrics: { tvlUsd: 0, volumeUsd24h: 0, volumeUsd7d: 0, feesUsd24h: 0, feesUsd7d: 0, feeApr: 0, txCount: 0, currentPrice: 1 },
  pricing: { source: 'none', usedFallback: true },
} as unknown as PoolUpsert;

function poolsRepo(writeBudget?: WriteBudgetService) {
  const batches: Array<{ n: number; options?: Record<string, unknown> }> = [];
  const model = {
    estimatedDocumentCount: () => ({ exec: async () => 0 }),
    find: () => ({ lean: () => ({ exec: async () => [] }) }),
    bulkWrite: async (batch: unknown[], options?: Record<string, unknown>) => {
      batches.push({ n: batch.length, options });
      return { upsertedCount: batch.length, modifiedCount: 0 };
    },
  };
  const repo = new PoolsRepository({ poolModel: () => model } as never, {} as never, undefined, undefined, undefined, writeBudget);
  return { repo, batches };
}

function enforceBudget() {
  const clock = fakeClock();
  const redis = new FakeRedis(clock.now);
  const svc = new WriteBudgetService(
    { writeBudget: resolveWriteBudgetSettings({ WRITE_BUDGET_MODE: 'enforce' }) } as never,
    { client: async () => redis as never, namespace: 'p' },
    { now: clock.now, sleep: clock.sleep },
  );
  (svc as unknown as { logger: unknown }).logger = { warn: () => {}, log: () => {} };
  return { svc, redis, clock };
}

const pools = (n: number) => Array.from({ length: n }, (_, i) => ({ ...base, poolId: `0x${i.toString(16).padStart(6, '0')}` }));

describe('pool writes through the shared budget', () => {
  it('with no budget (today): ≤ 500-op chunks with { ordered: false } exactly', async () => {
    const { repo, batches } = poolsRepo();
    const result = await repo.upsertMany(pools(1_200), new Date('2026-10-02T12:00:00Z'));
    expect(result).toEqual({ written: 1_200, unchanged: 0, hashReads: 1_200 });
    expect(batches).toEqual([
      { n: POOL_WRITE_CHUNK, options: { ordered: false } },
      { n: POOL_WRITE_CHUNK, options: { ordered: false } },
      { n: 200, options: { ordered: false } },
    ]);
  });

  it('enforce: lane pools, 0.5 u per pool, the cold hash read charged with the FIRST chunk', async () => {
    const { svc } = enforceBudget();
    const spy = vi.spyOn(svc, 'acquire');
    const { repo, batches } = poolsRepo(svc);
    await repo.upsertMany(pools(600));
    expect(batches.map((b) => b.n)).toEqual([500, 100]);
    expect(batches[0]!.options).toMatchObject({ ordered: false });
    expect(batches[0]!.options!.timeoutMS).toBeGreaterThan(0);
    expect(spy.mock.calls.map((c) => c[0])).toEqual([500 * 0.5 + 600 * 0.15, 100 * 0.5]);
    expect(spy.mock.calls.every((c) => c[1]?.lane === 'pools')).toBe(true);
  });

  it('a caller’s explicit lane wins over the pools default', async () => {
    const { svc } = enforceBudget();
    const spy = vi.spyOn(svc, 'acquire');
    const { repo } = poolsRepo(svc);
    await runInWriteLane('backfill', () => repo.upsertMany(pools(3)));
    expect(spy.mock.calls[0]![1]).toMatchObject({ lane: 'backfill' });
  });

  it('every chunk’s pools are remembered (the chunk offset maps back to the right pools)', async () => {
    const { svc } = enforceBudget();
    const { repo } = poolsRepo(svc);
    const t0 = new Date('2026-10-02T12:00:00Z');
    await repo.upsertMany(pools(1_200), t0);
    expect(await repo.upsertMany(pools(1_200), new Date(t0.getTime() + 60_000))).toEqual({ written: 0, unchanged: 1_200, hashReads: 0 });
  });

  it('a warm walk with nothing changed writes nothing and reads nothing', async () => {
    const { svc } = enforceBudget();
    const { repo, batches } = poolsRepo(svc);
    const t0 = new Date('2026-10-02T12:00:00Z');
    await repo.upsertMany(pools(10), t0);
    const spy = vi.spyOn(svc, 'acquire');
    const charge = vi.spyOn(svc, 'charge');
    const again = await repo.upsertMany(pools(10), new Date(t0.getTime() + 60_000));
    expect(again).toEqual({ written: 0, unchanged: 10, hashReads: 0 });
    expect(batches).toHaveLength(1);
    expect(spy).not.toHaveBeenCalled();
    expect(charge).not.toHaveBeenCalled();
  });
});
