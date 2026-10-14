/*
 * Lease gating (design §2.3 `fee-worker`, §9.5) and the per-chain budget:
 *   - not the holder → refreshChain (the BullMQ backstop included) is a no-op;
 *   - the ramp starts at lease ACQUISITION, not at boot;
 *   - every cursor/tally write carries the fence; a refused (deposed) write ends
 *     the tick; the lease lost mid-walk stops before the next page;
 *   - leases on → signals on Redis: any process marks, the holder drains;
 *   - POSITION_FEE_BUDGET=per-chain sizes the tick from N and the latency.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FeeCoordination, FeeWorkerLease } from '../../src/sync/fee-signals.js';
import { FakeFeeRedis } from './fake-redis.js';
import { CHAIN, MIN, PROTO, flush, makeP3Harness, measured } from './service-harness.js';

afterEach(() => {
  vi.useRealTimers();
});

function lease(over: Partial<{ held: boolean; fence: number; acquiredAt: number }> = {}) {
  const st = { held: true, fence: 7, acquiredAt: Date.now() - 60 * MIN, ...over };
  const l: FeeWorkerLease & { st: typeof st } = {
    st,
    held: () => st.held,
    fence: () => (st.held ? st.fence : undefined),
    acquiredAt: () => (st.held ? st.acquiredAt : undefined),
  };
  return l;
}

function coord(l: FeeWorkerLease, redis = new FakeFeeRedis()): FeeCoordination {
  return { leasesEnabled: true, namespace: 'ns', stateRedis: async () => redis, modelsRedis: async () => redis, lease: l };
}

describe('fee-worker lease', () => {
  it('not the holder: the tick (and so the BullMQ backstop) is a no-op — no cursor read, no RPC', async () => {
    const h = makeP3Harness({ coord: coord(lease({ held: false })) });
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(r.skipped).toBe('not the fee-worker lease holder');
    expect(h.syncRepo.getFeeCursors).not.toHaveBeenCalled();
    expect(h.client.getBlockNumber).not.toHaveBeenCalled();
  });

  it('the holder: every cursor/tally write carries the fence (6th argument)', async () => {
    const h = makeP3Harness({ coord: coord(lease({ fence: 42 })) });
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(r.finished).toEqual(['all']);
    expect(h.saves.length).toBeGreaterThan(0);
    for (const s of h.saves) expect(s[5]).toBe(42);
  });

  it('leases off: the cursor write is today\'s 5-argument call', async () => {
    const h = makeP3Harness();
    await h.service.refreshChain(CHAIN, PROTO);
    for (const s of h.saves) expect(s).toHaveLength(5);
  });

  it('a refused fenced write (deposed holder) ends the tick with [alert] fees.fence_refused — no further pages', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => measured(String(10 + i)));
    const h = makeP3Harness({ rows, coord: coord(lease()), saveAnswer: () => false, config: { positionFeeMaxPerTick: 2 } });
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(r.skipped).toMatch(/aborted: fee cursor write refused/);
    expect(h.warnings().some((w) => w.includes('[alert] fees.fence_refused'))).toBe(true);
    expect(h.positions.findFeeRefreshCandidates).toHaveBeenCalledTimes(1);
  });

  it('the lease lost mid-walk: the walk stops before the next page', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => measured(String(10 + i)));
    const l = lease();
    const h = makeP3Harness({
      rows,
      coord: coord(l),
      config: { positionFeeMaxPerTick: 100 },
      respond: (contracts, _b, n) => {
        if (n === 0) l.st.held = false;
        return contracts.map((c) =>
          c.functionName === 'getFeeGrowthInside' ? { status: 'success', result: [0n, 0n] } : { status: 'success', result: [0n, 0n, 0n] },
        );
      },
    });
    const r = await h.service.refreshChain(CHAIN, PROTO);
    // MONGO_PAGE ≫ 6, so one page held every row: measured, then its cursor write refused for want of the lease.
    expect(r.skipped).toMatch(/fee-worker lease lost/);
    expect(h.saves).toHaveLength(0);
  });

  it('the lease lost between pages: the next page is never measured', async () => {
    const rows = Array.from({ length: 2_500 }, (_, i) => measured(String(100_000 + i)));
    const l = lease();
    const h = makeP3Harness({
      rows,
      coord: coord(l),
      config: { positionFeeBatchSize: 500, positionFeeMaxPerTick: 5_000 },
      saveAnswer: () => {
        l.st.held = false;
      },
    });
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(r.tiers.all).toBe(2_000);
    expect(h.calls.flatMap((c) => c.salts)).toHaveLength(2_000);
    expect(h.saves).toHaveLength(1);
  });

  it('the ramp starts at ACQUISITION: a lease just taken ticks at the floor, one held for long at full budget', async () => {
    const config = { positionFeeRampMs: 10 * MIN, positionFeeMaxPerTick: 1000 };
    const fresh = makeP3Harness({ coord: coord(lease({ acquiredAt: Date.now() })), config });
    fresh.service.onModuleInit(); // boot = now, ignored in favour of the acquisition
    expect(fresh.service.allotment(`${CHAIN}:${PROTO}`)).toBe(250);
    fresh.service.onModuleDestroy();
    const old = makeP3Harness({ coord: coord(lease({ acquiredAt: Date.now() - 20 * MIN })), config });
    old.service.onModuleInit();
    expect(old.service.allotment(`${CHAIN}:${PROTO}`)).toBe(1000);
    old.service.onModuleDestroy();
  });
});

describe('signals over Redis (leases on)', () => {
  it('a mark from ANY process lands in redis-state; the holder drains it', async () => {
    const redis = new FakeFeeRedis();
    const producer = makeP3Harness({ coord: coord(lease({ held: false }), redis) });
    const worker = makeP3Harness({
      coord: coord(lease(), redis),
      cursors: { all: { cursor: '', startedAt: new Date(Date.now() - MIN), finishedAt: new Date() } },
    });
    producer.service.markDirty(CHAIN, ['12'], PROTO, new Map([['12', 950]]));
    producer.service.markViewed(CHAIN, PROTO, '11');
    await flush();
    expect(producer.service.dirtySize(CHAIN, PROTO)).toBe(0); // not in the producer's memory
    const r = await worker.service.refreshChain(CHAIN, PROTO);
    expect(r.tiers.view).toBe(1);
    expect(r.tiers.dirty).toBe(1);
    expect(worker.positions.findFeeRefreshCandidatesByIds.mock.calls.map((c) => c[2])).toEqual([['11'], ['12']]);
    expect((worker.service.feeStatus() as { signals: string }).signals).toBe('redis');
  });

  it('leases off (default): the in-process queues, exactly today', () => {
    const h = makeP3Harness();
    h.service.markDirty(CHAIN, ['12'], PROTO);
    expect(h.service.dirtySize(CHAIN, PROTO)).toBe(1);
    expect((h.service.feeStatus() as { signals: string }).signals).toBe('memory');
  });
});

describe('POSITION_FEE_BUDGET', () => {
  it('round (default): the tick gets exactly today\'s shared allotment', () => {
    const h = makeP3Harness({ config: { positionFeeMaxPerTick: 3000 } });
    expect(h.service.chainAllotment(CHAIN, PROTO)).toBe(h.service.allotment(`${CHAIN}:${PROTO}`));
  });

  it('per-chain with a complete RAM store: sized from N, the pass target and the measured latency — not capped by the round budget', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => measured(String(10 + i)));
    const h = makeP3Harness({
      rows,
      config: { positionFeeCandidates: 'memory', positionFeeBudget: 'per-chain', positionFeeMaxPerTick: 10, positionFeePassTargetMs: 60_000 },
    });
    await h.service.feedLoop();
    await flush();
    // 5 actives → the 2,000 floor (no latency measured yet), far above the round budget of 10.
    expect(h.service.chainAllotment(CHAIN, PROTO)).toBe(2_000);
  });

  it('per-chain without a store (Mongo pages): the round budget stays the Mongo read ceiling', async () => {
    const h = makeP3Harness({ config: { positionFeeBudget: 'per-chain', positionFeeMaxPerTick: 10 } });
    await h.service.refreshChain(CHAIN, PROTO); // finishes a pass: N known (5)
    expect(h.service.chainAllotment(CHAIN, PROTO)).toBe(10);
  });

  it('per-chain before N is known: today\'s round allotment', () => {
    const h = makeP3Harness({ config: { positionFeeBudget: 'per-chain', positionFeeMaxPerTick: 3000 } });
    expect(h.service.chainAllotment(CHAIN, PROTO)).toBe(h.service.allotment(`${CHAIN}:${PROTO}`));
  });
});
