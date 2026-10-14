/*
 * Package F review fixes (P2/P3 round 2):
 *   - memory mode pages are batch × slots rows, so a chain really has its
 *     configured slots in flight (a 2,000-row page capped it at ⌈2000/batch⌉);
 *   - the lease runner's fail-open LOCAL mode (held, no fence) writes today's
 *     unfenced cursor and the pass advances;
 *   - per-chain budget: a chain paging from RAM is not charged to the round, so
 *     a chain still on Mongo pages (its store failed) is not starved;
 *   - a reconcile does not count a re-read of identical content as drift;
 *   - a role without `fee-worker` never ticks, and leases on with no lease bound
 *     is not a worker;
 *   - a write the shared budget refuses is deferred (tick ends, RAM rows verify);
 *   - served hydration is charged to the write budget;
 *   - a FEE_RPC_FETCH factory that answers a non-function degrades to plain fetch;
 *   - signals held locally during a Redis outage are forwarded once it answers;
 *   - the store's load-time hint buffer is bounded and not kept while no load runs;
 *   - writers publish hints when the fee worker announces memory mode.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureProcessRole, resetProcessRoleForTests } from '../../src/common/process-role.js';
import { WriteBudgetTimeoutError } from '../../src/common/write-budget.js';
import { chargePrimaryRead } from '../../src/database/budgeted-write.js';
import type { FeeRowHint } from '../../src/database/positions.repository.js';
import { FeeCandidateFeed, HINT_BUFFER_MAX, type FeeStoreDoc, type FeeStoreSource } from '../../src/sync/fee-candidate-feed.js';
import { FeeCandidateStore, type StoreRow } from '../../src/sync/fee-candidate-store.js';
import { FeeMeasurer, checkedFetch, resolveFeeP3Settings } from '../../src/sync/fee-measurer.js';
import { FeeRowHintPublisher } from '../../src/sync/fee-row-hint-publisher.js';
import { RedisFeeSignals, feeModeKey, type FeeCoordination, type FeeWorkerLease } from '../../src/sync/fee-signals.js';
import { FakeFeeRedis } from './fake-redis.js';
import { CHAIN, MIN, PROTO, docOf, flush, makeP3Harness, measured } from './service-harness.js';

vi.mock('../../src/database/budgeted-write.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/database/budgeted-write.js')>()),
  chargePrimaryRead: vi.fn(),
}));

afterEach(() => {
  vi.useRealTimers();
  resetProcessRoleForTests();
});

const MEMORY = { positionFeeCandidates: 'memory' };

function coordWith(lease: FeeWorkerLease | undefined, redis = new FakeFeeRedis()): FeeCoordination {
  return { leasesEnabled: true, namespace: 'ns', stateRedis: async () => redis, modelsRedis: async () => redis, ...(lease ? { lease } : {}) };
}

/** Wrap the fake client's multicall with a delay and count concurrent calls. */
function trackInFlight(h: ReturnType<typeof makeP3Harness>) {
  const orig = h.client.multicall.getMockImplementation()!;
  const st = { active: 0, peak: 0 };
  h.client.multicall.mockImplementation(async (args: Parameters<typeof orig>[0]) => {
    st.active++;
    st.peak = Math.max(st.peak, st.active);
    await new Promise((r) => setTimeout(r, 5));
    try {
      return await orig(args);
    } finally {
      st.active--;
    }
  });
  return st;
}

describe('memory mode: a page keeps every slot of the chain busy', () => {
  it('peak multicalls in flight = POSITION_FEE_CONCURRENCY_BY_CHAIN (a 2,000-row page allowed only 2000 / batch)', async () => {
    const rows = Array.from({ length: 3_200 }, (_, i) => measured(String(100_000 + i)));
    const h = makeP3Harness({
      rows,
      config: {
        ...MEMORY,
        positionFeeBatchSize: 100,
        positionFeeConcurrency: 8,
        positionFeeConcurrencyByChain: `${CHAIN}:32`,
        positionFeeMaxPerTick: 10_000,
        positionFeeLoadDocsPerSec: 8_000,
      },
    });
    await h.service.feedLoop();
    await vi.waitFor(() => expect(h.ramStore()?.complete).toBe(true), { timeout: 5_000 });
    const inflight = trackInFlight(h);
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(r.tiers.all).toBe(3_200);
    expect(r.finished).toEqual(['all']);
    expect(inflight.peak).toBe(32);
    expect(h.positions.findFeeRefreshCandidates).not.toHaveBeenCalled();
  }, 10_000);

  it('mongo mode keeps MONGO_PAGE pages (one primary read of 2,000)', async () => {
    const rows = Array.from({ length: 2_500 }, (_, i) => measured(String(100_000 + i)));
    const h = makeP3Harness({ rows, config: { positionFeeBatchSize: 100, positionFeeConcurrency: 32, positionFeeMaxPerTick: 10_000 } });
    await h.service.refreshChain(CHAIN, PROTO);
    expect(h.positions.findFeeRefreshCandidates.mock.calls.map((c) => c[3])).toEqual([2_000, 2_000]);
  });

  it('a store page asked for but read from Mongo (store unusable meanwhile) is capped at MONGO_PAGE and does not end the pass', async () => {
    const rows = Array.from({ length: 2_500 }, (_, i) => measured(String(100_000 + i)));
    const h = makeP3Harness({ rows, config: { positionFeeBatchSize: 1_000, positionFeeConcurrency: 4, positionFeeMaxPerTick: 10_000 } });
    // The walk sizes the page for a store (4,000), the read finds none.
    const svc = h.service as unknown as { pageLimit: (t: unknown, tier: string, left: number) => number };
    vi.spyOn(svc, 'pageLimit').mockImplementation((_t, _tier, left) => Math.min(4_000, left));
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(h.positions.findFeeRefreshCandidates.mock.calls.map((c) => c[3])).toEqual([2_000, 2_000]);
    expect(r.tiers.all).toBe(2_500);
    expect(r.finished).toEqual(['all']);
  });
});

describe('fee-worker lease: fail-open local mode', () => {
  it('held with no fence (Redis down in role all): the cursor is saved unfenced and the pass advances', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => measured(String(10 + i)));
    const lease: FeeWorkerLease = { held: () => true, fence: () => undefined, acquiredAt: () => undefined };
    const h = makeP3Harness({ rows, coord: coordWith(lease) });
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(r.skipped).toBeUndefined();
    expect(r.finished).toEqual(['all']);
    expect(h.saves.length).toBeGreaterThan(0);
    for (const s of h.saves) expect(s).toHaveLength(5);
    expect(h.store.all.finishedAt).toBeInstanceOf(Date);
  });

  it('not held: still refused (no unfenced write by a deposed process)', async () => {
    const st = { held: true };
    const rows = Array.from({ length: 6 }, (_, i) => measured(String(10 + i)));
    const lease: FeeWorkerLease = { held: () => st.held, fence: () => undefined, acquiredAt: () => undefined };
    const h = makeP3Harness({
      rows,
      coord: coordWith(lease),
      respond: (contracts) => {
        st.held = false;
        return contracts.map((c) =>
          c.functionName === 'getFeeGrowthInside' ? { status: 'success', result: [0n, 0n] } : { status: 'success', result: [0n, 0n, 0n] },
        );
      },
    });
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(r.skipped).toMatch(/fee-worker lease lost/);
    expect(h.saves).toHaveLength(0);
  });

  it('no acquisition time (local mode): the boot ramp applies', () => {
    const lease: FeeWorkerLease = { held: () => true, fence: () => undefined, acquiredAt: () => undefined };
    const h = makeP3Harness({ coord: coordWith(lease), config: { positionFeeRampMs: 10 * MIN, positionFeeMaxPerTick: 1000 } });
    h.service.onModuleInit();
    expect(h.service.allotment(`${CHAIN}:${PROTO}`)).toBe(250);
    h.service.onModuleDestroy();
  });
});

describe('per-chain budget: RAM pages are not the round budget', () => {
  it("a chain whose store failed (Mongo pages) is not starved by a RAM chain's pages", async () => {
    const OTHER = 1;
    const rows = Array.from({ length: 60 }, (_, i) => measured(String(100 + i)));
    const source: FeeStoreSource = {
      walk: async (chainId, _p, after, limit) => {
        if (chainId === OTHER) throw new Error('positionId 7 != tokenId 8');
        return rows
          .filter((r) => !after || r.positionId > after)
          .slice(0, limit)
          .map(docOf);
      },
    };
    const h = makeP3Harness({
      rows,
      source,
      config: {
        ...MEMORY,
        positionFeeBudget: 'per-chain',
        positionFeeMaxPerTick: 10,
        enabledIntegrations: [
          { chainId: CHAIN, protocol: PROTO },
          { chainId: OTHER, protocol: PROTO },
        ],
        evmRpcUrls: new Map([
          [CHAIN, 'http://rpc.local'],
          [OTHER, 'http://rpc1.local'],
        ]),
      },
    });
    await h.service.feedLoop();
    await flush();
    expect(h.ramStore()?.complete).toBe(true);
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(r.tiers.all).toBe(60); // from RAM, far over the round of 10
    // The Mongo-paged chain still gets the whole round (the RAM chain read no Mongo).
    expect(h.service.chainAllotment(OTHER, PROTO)).toBe(10);
  });

  it("a RAM chain's views and side lanes stay within its share of the round (they DO read Mongo)", async () => {
    const OTHER = 1;
    const rows = Array.from({ length: 30 }, (_, i) => measured(String(100 + i)));
    const h = makeP3Harness({
      rows,
      cursors: { all: { cursor: '', startedAt: new Date(Date.now() - MIN), finishedAt: new Date() } },
      config: {
        ...MEMORY,
        positionFeeBudget: 'per-chain',
        positionFeeMaxPerTick: 10,
        enabledIntegrations: [
          { chainId: CHAIN, protocol: PROTO },
          { chainId: OTHER, protocol: PROTO },
        ],
        evmRpcUrls: new Map([
          [CHAIN, 'http://rpc.local'],
          [OTHER, 'http://rpc1.local'],
        ]),
      },
    });
    await h.service.feedLoop();
    await flush();
    expect(h.service.chainAllotment(CHAIN, PROTO)).toBe(2_000); // RAM pages: the per-chain floor
    h.service.markDirty(CHAIN, rows.map((r) => r.positionId), PROTO);
    const r = await h.service.refreshChain(CHAIN, PROTO);
    // The other chain has not ticked: it is held its fair share (5), so 5 by-id reads here.
    expect(r.tiers.dirty).toBe(5);
    expect(h.service.dirtySize(CHAIN, PROTO)).toBe(25);
  });

  it('round mode (default) still charges RAM pages to the round: the tick is bounded by it, and the others see it', async () => {
    const OTHER = 1;
    const rows = Array.from({ length: 60 }, (_, i) => measured(String(100 + i)));
    const h = makeP3Harness({
      rows,
      config: {
        ...MEMORY,
        positionFeeMaxPerTick: 10,
        enabledIntegrations: [
          { chainId: CHAIN, protocol: PROTO },
          { chainId: OTHER, protocol: PROTO },
        ],
        evmRpcUrls: new Map([
          [CHAIN, 'http://rpc.local'],
          [OTHER, 'http://rpc1.local'],
        ]),
      },
    });
    await h.service.feedLoop();
    await flush();
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(r.tiers.all).toBe(5); // half the round: the other chain has not ticked yet
    expect(h.service.chainAllotment(OTHER, PROTO)).toBe(5);
  });
});

describe('store reconcile drift', () => {
  const POOL = `0x${'ab'.repeat(32)}`;
  const row = (over: Partial<StoreRow> = {}): StoreRow => ({
    positionId: '7',
    tokenId: '7',
    poolId: POOL,
    tickLower: -60,
    tickUpper: 60,
    lastModifyBlock: 10,
    decimals0: 6,
    decimals1: 6,
    price0: 1,
    price1: 1,
    isPriceable: true,
    feesSource: 'onchain',
    pendingFeesUsd: 1,
    updatedAtMs: 1_000,
    ...over,
  });

  it('identical content with a later updatedAt (hint wAt, then the doc Mongoose stamped) is not a change — the clock still moves', () => {
    const s = new FeeCandidateStore();
    s.reconcileRange('', undefined, [row()], 2_000);
    expect(s.upsert([row({ updatedAtMs: 10_000 })])).toBe(0);
    expect(s.reconcileRange('', undefined, [row({ updatedAtMs: 10_007 })], 20_000, 0)).toBe(0);
    // The newer-wins clock advanced to 10,007: an older read with other content loses.
    expect(s.upsert([row({ updatedAtMs: 10_005, price0: 9 })])).toBe(0);
    expect(s.get('7')!.price0).toBe(1);
    expect(s.upsert([row({ updatedAtMs: 10_008, price0: 9 })])).toBe(1);
  });

  it('a feed reconcile over rows every writer rewrote (same content) reports 0 drift and no alert', async () => {
    const docs = Array.from({ length: 200 }, (_, i) => ({ ...docOf(measured(String(100 + i))), updatedAt: new Date(1_000) }) as FeeStoreDoc);
    const logger = { warn: vi.fn(), log: vi.fn(), debug: vi.fn() };
    let now = 1_000_000;
    const feed = new FeeCandidateFeed({
      source: { walk: async (_c, _p, after, limit) => docs.filter((d) => !after || String(d.positionId) > after).slice(0, limit) },
      settings: () => ({ ...resolveFeeP3Settings({}), candidates: 'memory', reconcileMs: 1 }),
      logger,
      now: () => now,
      sleep: async () => undefined,
    });
    feed.start(CHAIN, PROTO);
    await flush();
    // Every row rewritten: a hint at wAt, then the doc carries a later updatedAt.
    feed.applyHints(
      CHAIN,
      PROTO,
      docs.map((d) => {
        const r = feed.store(CHAIN, PROTO)!.get(String(d.positionId))!;
        return { ...r, isActive: true, wAt: 5_000 } as unknown as FeeRowHint;
      }),
    );
    for (const d of docs) d.updatedAt = new Date(5_007);
    now += 10;
    feed.maintain(CHAIN, PROTO);
    await flush();
    expect(feed.status()[`${CHAIN}:${PROTO}`]!.reconciles).toBe(1);
    expect(feed.status()[`${CHAIN}:${PROTO}`]!.lastDrift).toBe(0);
    expect(logger.warn.mock.calls.some((c) => String(c[0]).includes('reconcile_drift'))).toBe(false);
  });
});

describe('roles', () => {
  it('a role without fee-worker (api) never ticks, even with no coordination bound', async () => {
    configureProcessRole({ processRole: 'api', processLeases: 'on' });
    const h = makeP3Harness();
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(r.skipped).toBe('not the fee-worker lease holder');
    expect(h.syncRepo.getFeeCursors).not.toHaveBeenCalled();
    h.service.onModuleInit();
    expect((h.service as unknown as { timer?: unknown }).timer).toBeUndefined();
    // Marks still queue (for the fee role to drain).
    h.service.markDirty(CHAIN, ['12'], PROTO);
    expect(h.service.dirtySize(CHAIN, PROTO)).toBe(1);
  });

  it.each(['sync', 'feeder'] as const)('%s with leases on: refreshChain is a no-op', async (role) => {
    configureProcessRole({ processRole: role, processLeases: 'on' });
    const h = makeP3Harness({ coord: coordWith({ held: () => true, fence: () => 1, acquiredAt: () => 0 }) });
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(r.skipped).toBe('not the fee-worker lease holder');
  });

  it('fee role, leases on, no lease bound: not a worker, [alert] fees.lease_unbound at boot', async () => {
    configureProcessRole({ processRole: 'fee', processLeases: 'on' });
    const h = makeP3Harness({ coord: coordWith(undefined) });
    h.service.onModuleInit();
    expect(h.warnings().some((w) => w.includes('[alert] fees.lease_unbound'))).toBe(true);
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(r.skipped).toBe('not the fee-worker lease holder');
    h.service.onModuleDestroy();
  });

  it('role all with leases off (today): the worker', async () => {
    const h = makeP3Harness();
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(r.finished).toEqual(['all']);
  });
});

describe('the shared write budget refuses a fee chunk', () => {
  it('passes maxBudgetWaitMs + the tick signal; a WriteBudgetTimeoutError defers: tick ends unsaved, RAM rows verify, not failed', async () => {
    const rows = ['10', '11'].map((id) => ({ ...measured(id), rpc: { fees0: '1', fees1: '1', block: 900, at: new Date(Date.now() - MIN) } }));
    const h = makeP3Harness({ config: MEMORY, rows });
    await h.service.feedLoop();
    await flush();
    let opts: Record<string, unknown> | undefined;
    h.positions.writeRpcFees.mockImplementation(async (_c: number, _p: string, _w: unknown, _at: unknown, o: Record<string, unknown>) => {
      opts = o;
      throw new WriteBudgetTimeoutError('fee', 90_000);
    });
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(opts?.maxBudgetWaitMs).toBe(60_000);
    expect((opts?.signal as AbortSignal).aborted).toBe(true); // the tick ended
    expect(r.skipped).toMatch(/aborted: write budget/);
    expect(r.failed).toBe(0);
    expect(h.saves).toHaveLength(0);
    expect(h.ramStore()!.get('10')!.verify).toBe(true);
    expect(h.ramStore()!.get('11')!.verify).toBe(true);
    expect(h.warnings().some((w) => w.includes('Position fee writes deferred'))).toBe(true);
  });

  it('served hydration reads are charged to the fee lane', async () => {
    const charge = vi.mocked(chargePrimaryRead);
    charge.mockClear();
    const h = makeP3Harness({ config: MEMORY, rows: [measured('10'), measured('11')] });
    await h.service.feedLoop();
    await flush();
    h.ramStore()!.markVerify('11');
    await h.service.refreshChain(CHAIN, PROTO);
    expect(charge).toHaveBeenCalledWith(1, { lane: 'fee' });
  });
});

describe('FEE_RPC_FETCH factory answers', () => {
  it('checkedFetch: a function passes, undefined is plain fetch, anything else is reported and ignored', () => {
    const bad = vi.fn();
    const f = (async () => new Response()) as unknown as typeof fetch;
    expect(checkedFetch(f, bad)).toBe(f);
    expect(checkedFetch(undefined, bad)).toBeUndefined();
    expect(bad).not.toHaveBeenCalled();
    expect(checkedFetch('http://rpc.local', bad)).toBeUndefined();
    expect(bad).toHaveBeenCalledTimes(1);
  });

  it('the measurer builds a working client from a miswired factory (the url as "fetch") and alerts', () => {
    const logger = { warn: vi.fn(), log: vi.fn(), debug: vi.fn() };
    const m = new FeeMeasurer(
      { evmRpcUrls: new Map([[CHAIN, 'http://rpc.local']]) } as never,
      ((url: string) => url) as never,
      { logger },
    );
    expect(m.client(CHAIN, 'fee')).toBeDefined();
    expect(logger.warn.mock.calls.some((c) => String(c[0]).includes('[alert] fees.rpc_fetch_invalid'))).toBe(true);
  });
});

describe('signals held locally during a Redis outage', () => {
  it('are forwarded to redis-state after the next successful mark (a split role never drains them)', async () => {
    const redis = new FakeFeeRedis();
    const s = new RedisFeeSignals(async () => redis, 'ns');
    redis.failing = true;
    await s.markDirty('4663:uniswap-v4', 'live', [['1', 10]]);
    await s.markDirty('4663:uniswap-v4', 'backfill', [['2', 20]]);
    await s.markViewed('4663:uniswap-v4', '3', Date.now());
    expect(s.local.sizes('4663:uniswap-v4')).toEqual({ views: 1, live: 1, backfill: 1 });
    redis.failing = false;
    await s.markDirty('4663:uniswap-v4', 'live', [['4', 40]]);
    await flush(); // the background forward the successful mark started
    expect(s.local.sizes('4663:uniswap-v4')).toEqual({ views: 0, live: 0, backfill: 0 });
    expect(await s.sizes('4663:uniswap-v4')).toEqual({ views: 1, live: 2, backfill: 1 });
    expect(s.forwarded).toBe(3);
    const live = await s.takeDirty('4663:uniswap-v4', 'live', 10);
    expect(live.get('1')).toBe(10);
  });

  it('a forward that fails puts the entries back', async () => {
    const redis = new FakeFeeRedis();
    const s = new RedisFeeSignals(async () => redis, 'ns');
    redis.failing = true;
    await s.markDirty('4663:uniswap-v4', 'live', [['1', 10]]);
    redis.failing = false;
    redis.failOn.add('eval');
    await s.forwardLocal();
    expect(s.local.sizes('4663:uniswap-v4').live).toBe(1);
  });
});

describe('the load-time hint buffer', () => {
  const POOL = `0x${'ab'.repeat(32)}`;
  const hint = (id: string): FeeRowHint => ({
    positionId: id,
    isActive: true,
    wAt: 5_000,
    tokenId: id,
    poolId: POOL,
    tickLower: -60,
    tickUpper: 60,
    lastModifyBlock: 10,
    decimals0: 6,
    decimals1: 6,
  });

  function blockedFeed(fail = false) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const logger = { warn: vi.fn(), log: vi.fn(), debug: vi.fn() };
    const feed = new FeeCandidateFeed({
      source: {
        walk: async () => {
          await gate;
          if (fail) throw new Error('No suitable servers found');
          return [];
        },
      },
      settings: () => ({ ...resolveFeeP3Settings({}), candidates: 'memory' }),
      logger,
      sleep: async () => undefined,
    });
    return { feed, release: () => release(), logger };
  }

  it('is bounded while the load runs; the overflow queues a reconcile', async () => {
    const { feed, release } = blockedFeed();
    feed.start(CHAIN, PROTO);
    feed.applyHints(CHAIN, PROTO, Array.from({ length: HINT_BUFFER_MAX + 5 }, (_, i) => hint(String(1_000_000 + i))));
    const st = feed.status()[`${CHAIN}:${PROTO}`]!;
    expect(st.buffered).toBe(HINT_BUFFER_MAX);
    expect(st.bufferDropped).toBe(5);
    release();
    await flush();
  });

  it('a failed load clears it, and hints while the load is not running are not buffered', async () => {
    const { feed, release, logger } = blockedFeed(true);
    feed.start(CHAIN, PROTO);
    feed.applyHints(CHAIN, PROTO, [hint('10'), hint('11')]);
    expect(feed.status()[`${CHAIN}:${PROTO}`]!.buffered).toBe(2);
    release();
    await flush();
    const st = feed.status()[`${CHAIN}:${PROTO}`]!;
    expect(st.state).toBe('error');
    expect(st.buffered).toBe(0);
    feed.applyHints(CHAIN, PROTO, [hint('12')]);
    expect(feed.status()[`${CHAIN}:${PROTO}`]!.buffered).toBe(0);
    expect(feed.status()[`${CHAIN}:${PROTO}`]!.bufferDropped).toBe(3);
    expect(logger.warn.mock.calls.some((c) => String(c[0]).includes('load failed'))).toBe(true);
  });
});

describe('writer hints follow the fee worker, not the writer', () => {
  it('leases on: a writer without memory mode publishes once the fee worker announced memory', async () => {
    const redis = new FakeFeeRedis();
    const coord = coordWith(undefined, redis);
    const writer = new FeeRowHintPublisher({} as never, coord); // POSITION_FEE_CANDIDATES unset = mongo
    // redis-state unreadable and no answer yet: fail toward publishing.
    redis.failOn.add('get');
    await writer.publishIfConsumed(CHAIN, PROTO, [{ positionId: '1', isActive: false, wAt: 1 }]);
    expect(writer.stats.published).toBe(1);
    // Readable, no announcement: no consumer runs memory mode → nothing published.
    redis.failOn.delete('get');
    (writer as unknown as { modeCheckedAt: number }).modeCheckedAt = Number.NEGATIVE_INFINITY;
    await writer.publishIfConsumed(CHAIN, PROTO, [{ positionId: '2', isActive: false, wAt: 1 }]);
    expect(writer.stats.published).toBe(1);

    // The fee worker (memory) announces its mode from its consume loop.
    const feed = new FeeCandidateFeed({
      source: { walk: async () => [] },
      settings: () => ({ ...resolveFeeP3Settings({}), candidates: 'memory' }),
      logger: { warn: vi.fn(), log: vi.fn(), debug: vi.fn() },
      coord,
      sleep: async () => undefined,
    });
    feed.start(CHAIN, PROTO);
    await flush();
    await feed.consumeOnce();
    expect(await redis.get(feeModeKey('ns'))).toBe('memory');
    (writer as unknown as { modeCheckedAt: number }).modeCheckedAt = Number.NEGATIVE_INFINITY;
    await writer.publishIfConsumed(CHAIN, PROTO, [{ positionId: '3', isActive: false, wAt: 1 }]);
    expect(writer.stats.published).toBe(2);
  });

  it('a ready store that never sees a hint raises [alert] fees.hint_stream_absent once', async () => {
    const redis = new FakeFeeRedis();
    let now = 1_000_000;
    const logger = { warn: vi.fn(), log: vi.fn(), debug: vi.fn() };
    const feed = new FeeCandidateFeed({
      source: { walk: async () => [] },
      settings: () => ({ ...resolveFeeP3Settings({}), candidates: 'memory' }),
      logger,
      coord: coordWith(undefined, redis),
      now: () => now,
      sleep: async () => undefined,
    });
    feed.start(CHAIN, PROTO);
    await flush();
    await feed.consumeOnce();
    expect(logger.warn.mock.calls.some((c) => String(c[0]).includes('hint_stream_absent'))).toBe(false);
    now += 2 * 3_600_000;
    await feed.consumeOnce();
    await feed.consumeOnce();
    expect(logger.warn.mock.calls.filter((c) => String(c[0]).includes('[alert] fees.hint_stream_absent'))).toHaveLength(1);
  });
});
