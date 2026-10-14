/*
 * PositionFeeRefreshService — the tiered on-chain fee refresh.
 *
 * Pinned here: each Multicall3 batch reads and stamps ITS OWN block (no
 * run-start pin); the hot / full tiers resume from the cursor persisted in
 * sync_cursors (no restart at ''); hot before full when hot is enabled,
 * nothing when neither is due; the per-tick budget and its 2000-row pages; the
 * live listener's dirty set (drained first, at most half the tick while a pass
 * is due, re-queued when the RPC never answered); stale measurements refused;
 * the rpcFees stamp written unless an identical re-read is still valid and
 * recent, and the served fields only on a material move; the 60 s timer;
 * single-flight. The harness is shared (test/fee-refresh-harness.ts); the
 * 2026-10-03 reliability / speed / Mongo-protection behaviour is in
 * position-fee-reliability.spec.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FEE_RAMP_MS,
  FEE_TICK_INTERVAL_MS,
  isUnchangedMeasurement,
  nextTier,
  tierDue,
  tierInProgress,
} from '../src/sync/position-fee-refresh.service.js';
import type { FeeRefreshCandidate, RpcFeeWrite } from '../src/database/positions.repository.js';
import { positionSalt } from '../src/sync/position-fee-math.js';
import { CHAIN, MIN, PROTO, candidate, makeHarness, universe } from './fee-refresh-harness.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('tier scheduling (pure)', () => {
  const now = Date.parse('2026-10-01T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms);

  it('a pass is in progress while its start is newer than its last finish', () => {
    expect(tierInProgress({ cursor: '' })).toBe(false);
    expect(tierInProgress({ cursor: '5', startedAt: ago(MIN) })).toBe(true);
    expect(tierInProgress({ cursor: '5', startedAt: ago(MIN), finishedAt: ago(2 * MIN) })).toBe(true);
    expect(tierInProgress({ cursor: '', startedAt: ago(2 * MIN), finishedAt: ago(MIN) })).toBe(false);
  });

  it('is due when never run, in progress, or its interval has elapsed since it STARTED', () => {
    expect(tierDue({ cursor: '' }, 30 * MIN, now)).toBe(true);
    expect(tierDue({ cursor: '', startedAt: ago(29 * MIN), finishedAt: ago(28 * MIN) }, 30 * MIN, now)).toBe(false);
    expect(tierDue({ cursor: '', startedAt: ago(30 * MIN), finishedAt: ago(28 * MIN) }, 30 * MIN, now)).toBe(true);
    expect(tierDue({ cursor: 'x', startedAt: ago(5 * MIN) }, 30 * MIN, now)).toBe(true);
  });

  it('serves hot before all, and nothing when neither is due', () => {
    const idle = { cursor: '', startedAt: ago(MIN), finishedAt: ago(MIN / 2) };
    const intervals = { hot: 30 * MIN, all: 360 * MIN };
    expect(nextTier({ hot: { cursor: '' }, all: { cursor: '' } }, now, intervals)).toBe('hot');
    expect(nextTier({ hot: idle, all: { cursor: '' } }, now, intervals)).toBe('all');
    expect(nextTier({ hot: idle, all: idle }, now, intervals)).toBeNull();
  });
});

describe('per-batch block', () => {
  it('reads the head per batch, pins each multicall to its own block, and stamps that block on its rows', async () => {
    // hot pass covers 5 positions in 3 batches of ≤2; full not reached (budget)
    const h = makeHarness({ config: { positionFeeMaxPerTick: 5 } });
    await h.service.refreshChain(CHAIN, PROTO);

    expect(h.client.getBlockNumber).toHaveBeenCalledTimes(3);
    for (const call of h.client.getBlockNumber.mock.calls) expect(call[0]).toEqual({ cacheTime: 0 });
    expect(h.calls).toHaveLength(3);
    // Every batch ran at a block it read itself — no run-start pin.
    expect(new Set(h.calls.map((c) => c.blockNumber)).size).toBe(3);
    const blockBySalt = new Map(h.calls.flatMap((c) => c.salts.map((s) => [s, Number(c.blockNumber)] as const)));
    const rows = h.written();
    expect(rows).toHaveLength(5);
    for (const row of rows) expect(row.block).toBe(blockBySalt.get(positionSalt(row.positionId)));
    // owed (2, 3) x 1e6 liquidity at 6 decimals
    expect(rows[0]).toMatchObject({ fees0: '2', fees1: '3' });
  });

  it('a head read that fails once is retried after ~1 s and the batch is measured', async () => {
    const h = makeHarness({ config: { positionFeeMaxPerTick: 2 } });
    h.client.getBlockNumber.mockRejectedValueOnce(new Error('rpc down'));
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(h.client.getBlockNumber).toHaveBeenCalledTimes(2);
    expect(h.delays).toEqual([1000]);
    expect(r.failed).toBe(0);
    expect(h.written()).toHaveLength(2);
  });

  it('a batch whose head read keeps failing is UNANSWERED, not failed, and writes nothing', async () => {
    const h = makeHarness({ config: { positionFeeMaxPerTick: 2 } });
    h.client.getBlockNumber.mockRejectedValue(new Error('rpc down'));
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(r.failed).toBe(0);
    expect(r.unanswered).toBe(2);
    expect(h.written()).toHaveLength(0);
    expect(r.heldBack).toBe('hot');
  });
});

describe('resumable tiers', () => {
  it('resumes an in-progress hot pass from its persisted cursor and saves the next one', async () => {
    const rows = universe(6);
    const startedAt = new Date(Date.now() - 10 * MIN);
    const h = makeHarness({ rows, cursors: { hot: { cursor: rows[1].c.tokenId, startedAt } }, config: { positionFeeMaxPerTick: 2 } });
    await h.service.refreshChain(CHAIN, PROTO);

    expect(h.positions.findFeeRefreshCandidates).toHaveBeenCalledTimes(1);
    expect(h.positions.findFeeRefreshCandidates.mock.calls[0]).toEqual([CHAIN, PROTO, rows[1].c.tokenId, 2, { hotMinUsd: 50 }]);
    expect(h.store.hot).toEqual({ cursor: rows[3].c.tokenId, startedAt });
  });

  it('a new process picks up where the last one stopped — no restart at ""', async () => {
    const rows = universe(6);
    const first = makeHarness({ rows, config: { positionFeeMaxPerTick: 3 } });
    await first.service.refreshChain(CHAIN, PROTO);
    expect(first.store.hot.cursor).toBe(rows[2].c.tokenId);

    // "Restart": a fresh service over the same persisted cursors.
    const second = makeHarness({ rows, cursors: { hot: first.store.hot, all: first.store.all }, config: { positionFeeMaxPerTick: 3 } });
    await second.service.refreshChain(CHAIN, PROTO);
    expect(second.positions.findFeeRefreshCandidates.mock.calls[0][2]).toBe(rows[2].c.tokenId);
    expect(second.written().map((w) => w.positionId)).toEqual(rows.slice(3).map((r) => r.c.positionId));
  });

  it('finishes a pass on a short page: cursor back to "", finishedAt stamped, reported', async () => {
    const h = makeHarness({ rows: universe(3) });
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(r.finished).toContain('hot');
    expect(h.store.hot.cursor).toBe('');
    expect(h.store.hot.finishedAt).toBeInstanceOf(Date);
    expect(tierInProgress(h.store.hot)).toBe(false);
  });

  it('hot tier filters to hot positions; the full tier reads every active one', async () => {
    const rows = universe(4, (i) => i % 2 === 0);
    const h = makeHarness({ rows });
    const r = await h.service.refreshChain(CHAIN, PROTO);
    // hot pass (2 hot rows, short page → finished), then the full pass (4 rows)
    expect(h.positions.findFeeRefreshCandidates.mock.calls.map((c) => c[4])).toEqual([{ hotMinUsd: 50 }, {}]);
    expect(r.tiers).toEqual({ view: 0, dirty: 0, backfill: 0, hot: 2, all: 4 });
    expect(r.finished).toEqual(['hot', 'all']);
  });

  it('reads nothing when neither pass is due', async () => {
    const recent = { cursor: '', startedAt: new Date(Date.now() - MIN), finishedAt: new Date(Date.now() - MIN / 2) };
    const h = makeHarness({ cursors: { hot: recent, all: recent } });
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(h.positions.findFeeRefreshCandidates).not.toHaveBeenCalled();
    expect(r.scanned).toBe(0);
  });

  it('the full tier runs once hot is done and not yet due again', async () => {
    const recent = { cursor: '', startedAt: new Date(Date.now() - MIN), finishedAt: new Date(Date.now() - MIN / 2) };
    const h = makeHarness({ cursors: { hot: recent } });
    await h.service.refreshChain(CHAIN, PROTO);
    expect(h.positions.findFeeRefreshCandidates.mock.calls[0][4]).toEqual({});
  });

  it('logs one summary line per completed pass, counting every tick of it', async () => {
    const h = makeHarness({ rows: universe(5), config: { positionFeeMaxPerTick: 3 } });
    await h.service.refreshChain(CHAIN, PROTO); // hot: 3 of 5
    expect(h.log).not.toHaveBeenCalledWith(expect.stringContaining('hot pass'));
    await h.service.refreshChain(CHAIN, PROTO); // hot: last 2 → finished
    const line = h.log.mock.calls.map(String).find((l) => l.includes('hot pass'));
    expect(line).toMatch(/Position fee hot pass 4663:uniswap-v4 finished in \d+s scanned=5 measured=5 written=5 served=5 stale=0 unchanged=0 failed=0/);
  });

  it('caps a tick at POSITION_FEE_MAX_PER_TICK positions, in pages of at most 2000', async () => {
    const h = makeHarness({ rows: universe(6000), config: { positionFeeMaxPerTick: 4500, positionFeeBatchSize: 200 } });
    await h.service.refreshChain(CHAIN, PROTO);
    expect(h.positions.findFeeRefreshCandidates.mock.calls.map((c) => c[3])).toEqual([2000, 2000, 500]);
    expect(h.written()).toHaveLength(4500);
  });
});

describe('dirty set (live listener)', () => {
  it('drains changed positions first, by id, before any tier page', async () => {
    const recent = { cursor: '', startedAt: new Date(Date.now() - MIN), finishedAt: new Date(Date.now() - MIN / 2) };
    const h = makeHarness({ cursors: { hot: recent, all: recent } });
    h.service.markDirty(CHAIN, ['7', '8', 'not-a-token', '7'], PROTO);
    expect(h.service.dirtySize(CHAIN, PROTO)).toBe(2);

    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(h.positions.findFeeRefreshCandidatesByIds).toHaveBeenCalledWith(CHAIN, PROTO, ['7', '8']);
    expect(h.written().map((w) => w.positionId).sort()).toEqual(['7', '8']);
    expect(r.tiers.dirty).toBe(2);
    expect(h.service.dirtySize(CHAIN, PROTO)).toBe(0);
  });

  it('puts back what the RPC never answered', async () => {
    const recent = { cursor: '', startedAt: new Date(Date.now() - MIN), finishedAt: new Date(Date.now() - MIN / 2) };
    const h = makeHarness({ cursors: { hot: recent, all: recent } });
    h.service.markDirty(CHAIN, ['7', '8'], PROTO);
    h.client.getBlockNumber.mockRejectedValue(new Error('rpc down'));
    await h.service.refreshChain(CHAIN, PROTO);
    expect(h.service.dirtySize(CHAIN, PROTO)).toBe(2);
  });

  it('puts the batch back when the Mongo read fails, and aborts the tick', async () => {
    const h = makeHarness();
    h.service.markDirty(CHAIN, ['7', '8'], PROTO);
    h.positions.findFeeRefreshCandidatesByIds.mockRejectedValueOnce(new Error('pool stalled'));
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(r.skipped).toMatch(/aborted: pool stalled/);
    expect(h.service.dirtySize(CHAIN, PROTO)).toBe(2);
  });

  it('ignores chains it cannot read, and everything when the refresh is disabled', () => {
    const h = makeHarness();
    h.service.markDirty(1, ['7'], PROTO); // no RPC url for chain 1
    expect(h.service.dirtySize(1, PROTO)).toBe(0);
    const off = makeHarness({ config: { positionFeeRefreshEnabled: false } });
    off.service.markDirty(CHAIN, ['7'], PROTO);
    expect(off.service.dirtySize(CHAIN, PROTO)).toBe(0);
  });

  it('is bounded; the overflow is left to the tier passes, with a warning', () => {
    const h = makeHarness();
    h.service.markDirty(CHAIN, Array.from({ length: 50_005 }, (_, i) => String(i)), PROTO);
    expect(h.service.dirtySize(CHAIN, PROTO)).toBe(50_000);
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('5 changed positions left to the tier passes'));
  });
});

describe('what gets written', () => {
  const recent = () => ({ cursor: '', startedAt: new Date(Date.now() - MIN), finishedAt: new Date(Date.now() - MIN / 2) });

  it('refuses a measurement older than the stored last modify', async () => {
    const h = makeHarness({ cursors: { hot: recent(), all: recent() } });
    h.positions.findFeeRefreshCandidatesByIds.mockResolvedValueOnce([
      candidate('7', { lastModifyBlock: 5_000 }), // modify AFTER the block-1000 read
      candidate('8', { lastModifyBlock: 1_000 }), // modify AT the read block: state includes it
    ]);
    h.service.markDirty(CHAIN, ['7', '8'], PROTO);
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(h.written().map((w) => w.positionId)).toEqual(['8']);
    expect(r.stale).toBe(1);
  });

  it('always stamps rpcFees, but rewrites the served fields only when the figure moved materially', async () => {
    const onchain = (pending: number) => ({
      positionId: '',
      isActive: true,
      token0: { priceUsd: 1 },
      token1: { priceUsd: 1 },
      amounts: { totalGasCostEth: '0' },
      metrics: { isPriceable: true, pendingFeesUsd: pending, feesSource: 'onchain' as const },
    });
    const h = makeHarness({ cursors: { hot: recent(), all: recent() } });
    h.positions.findFeeRefreshCandidatesByIds.mockResolvedValueOnce([
      candidate('7', { stored: { ...onchain(5), positionId: '7' } }), // new 2 + 3 = $5 → unchanged
      candidate('8', { stored: { ...onchain(1), positionId: '8' } }), // $1 → $5: material
      candidate('9'), // unmeasured → always (clears "Pending")
    ]);
    h.service.markDirty(CHAIN, ['7', '8', '9'], PROTO);
    const r = await h.service.refreshChain(CHAIN, PROTO);
    const byId = new Map(h.written().map((w) => [w.positionId, w]));
    expect([...byId.keys()].sort()).toEqual(['7', '8', '9']);
    expect(byId.get('7')!.served).toBeUndefined();
    expect(byId.get('8')!.served).toMatchObject({ 'metrics.pendingFeesUsd': 5, 'metrics.feesSource': 'onchain' });
    expect(byId.get('9')!.served).toMatchObject({ 'metrics.feesSource': 'onchain' });
    expect(r.served).toBe(2);
    expect(r.written).toBe(3);
  });

  it('stamps the served measurement time with the same instant as rpcFeesAt', async () => {
    const h = makeHarness({ cursors: { hot: recent(), all: recent() } });
    h.service.markDirty(CHAIN, ['9'], PROTO);
    await h.service.refreshChain(CHAIN, PROTO);
    const [, , rows, at] = h.positions.writeRpcFees.mock.calls[0] as unknown as [number, string, RpcFeeWrite[], Date];
    expect(rows[0].served?.['metrics.feesMeasuredAt']).toBe(at);
  });

  it('a served write carries the version its revalue was read at; one the repository refused is not counted served', async () => {
    const version = new Date('2026-10-01T11:00:00Z');
    const h = makeHarness({ cursors: { hot: recent(), all: recent() } });
    h.positions.findFeeRefreshCandidatesByIds.mockResolvedValueOnce([candidate('9', { version })]);
    h.positions.writeRpcFees.mockResolvedValueOnce({ matched: 1, modified: 1, served: 0 } as never);
    h.service.markDirty(CHAIN, ['9'], PROTO);
    const r = await h.service.refreshChain(CHAIN, PROTO);
    const [, , rows] = h.positions.writeRpcFees.mock.calls[0] as unknown as [number, string, RpcFeeWrite[]];
    expect(rows[0]!.served).toBeDefined();
    expect(rows[0]!.version).toBe(version);
    expect(r.written).toBe(1); // the stamp landed…
    expect(r.served).toBe(0); // …the served fields did not (the document had moved on)
  });

  it('counts unmatched writes (refused by the repository guard) as stale', async () => {
    const h = makeHarness({ config: { positionFeeMaxPerTick: 2 } });
    h.positions.writeRpcFees.mockResolvedValueOnce({ matched: 1, modified: 1 });
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(r.written).toBe(1);
    expect(r.stale).toBe(1);
  });
});

describe('one write budget shared by every chain', () => {
  const recent = () => ({ cursor: '', startedAt: new Date(Date.now() - MIN), finishedAt: new Date(Date.now() - MIN / 2) });
  const twoChains = (config: Record<string, unknown> = {}) =>
    makeHarness({
      rows: universe(5000),
      config: {
        evmRpcUrls: new Map([
          [CHAIN, 'http://rpc.local'],
          [42161, 'http://rpc2.local'],
        ]),
        enabledIntegrations: [
          { chainId: CHAIN, protocol: PROTO },
          { chainId: 42161, protocol: PROTO },
        ],
        positionFeeMaxPerTick: 3000,
        ...config,
      },
    });

  it('chains that are both busy get a fair share each; a chain alone with a backlog gets the rest', async () => {
    const h = twoChains();
    // Before the other chain has ticked, it is assumed to need its fair share.
    expect(h.service.allotment(`${CHAIN}:${PROTO}`)).toBe(1500);
    await h.service.refreshChain(CHAIN, PROTO);
    expect(h.written()).toHaveLength(1500);
    // The other chain ticked and needed nothing: the busy one may use it all.
    (h.service as unknown as { lastUsed: Map<string, number> }).lastUsed.set(`42161:${PROTO}`, 0);
    expect(h.service.allotment(`${CHAIN}:${PROTO}`)).toBe(3000);
    // It needed a little: that little is held back for it.
    (h.service as unknown as { lastUsed: Map<string, number> }).lastUsed.set(`42161:${PROTO}`, 200);
    expect(h.service.allotment(`${CHAIN}:${PROTO}`)).toBe(2800);
    // It took the whole round last tick: nothing is left in this round (the
    // budget is a ceiling); it is cut back to its fair share on its own next tick.
    (h.service as unknown as { lastUsed: Map<string, number> }).lastUsed.set(`42161:${PROTO}`, 3000);
    expect(h.service.allotment(`${CHAIN}:${PROTO}`)).toBe(0);
    (h.service as unknown as { lastUsed: Map<string, number> }).lastUsed.set(`${CHAIN}:${PROTO}`, 0);
    (h.service as unknown as { wanted: Map<string, boolean> }).wanted.set(`${CHAIN}:${PROTO}`, true);
    expect(h.service.allotment(`42161:${PROTO}`)).toBe(1500);
  });

  it('with three chains, a greedy one leaves nothing this round and is cut to its share on its next; an idle one lends its share', () => {
    const h = makeHarness({
      config: {
        evmRpcUrls: new Map([
          [CHAIN, 'http://rpc.local'],
          [42161, 'http://rpc2.local'],
          [43114, 'http://rpc3.local'],
        ]),
        enabledIntegrations: [
          { chainId: CHAIN, protocol: PROTO },
          { chainId: 42161, protocol: PROTO },
          { chainId: 43114, protocol: PROTO },
        ],
        positionFeeMaxPerTick: 3000,
      },
    });
    const lastUsed = (h.service as unknown as { lastUsed: Map<string, number> }).lastUsed;
    lastUsed.set(`42161:${PROTO}`, 3000); // greedy: took the whole round
    lastUsed.set(`43114:${PROTO}`, 0); // idle
    expect(h.service.allotment(`${CHAIN}:${PROTO}`)).toBe(0);
    // CHAIN got nothing and wanted more: the greedy chain's next tick splits
    // the round with it, the idle one lending its share.
    lastUsed.set(`${CHAIN}:${PROTO}`, 0);
    (h.service as unknown as { wanted: Map<string, boolean> }).wanted.set(`${CHAIN}:${PROTO}`, true);
    expect(h.service.allotment(`42161:${PROTO}`)).toBe(1500);
  });

  it('dirty re-reads are charged against the budget; what does not fit stays queued', async () => {
    const h = makeHarness({ cursors: { hot: recent(), all: recent() }, config: { positionFeeMaxPerTick: 3 } });
    h.service.markDirty(CHAIN, ['7', '8', '9', '11', '12'], PROTO);
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(r.tiers.dirty).toBe(3);
    expect(h.written()).toHaveLength(3);
    expect(h.service.dirtySize(CHAIN, PROTO)).toBe(2);
  });

  it('while a pass is due, the dirty set gets at most half the tick and the pass gets the rest', async () => {
    const h = makeHarness({ rows: universe(20), config: { positionFeeMaxPerTick: 10 } });
    h.service.markDirty(CHAIN, Array.from({ length: 30 }, (_, i) => String(100 + i)), PROTO);
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(r.tiers.dirty).toBe(5);
    expect(r.tiers.hot).toBe(5);
    expect(h.service.dirtySize(CHAIN, PROTO)).toBe(25);
  });

  it('with no pass due, a dirty drain may use the whole tick', async () => {
    const h = makeHarness({ cursors: { hot: recent(), all: recent() }, config: { positionFeeMaxPerTick: 10 } });
    h.service.markDirty(CHAIN, Array.from({ length: 30 }, (_, i) => String(100 + i)), PROTO);
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(r.tiers.dirty).toBe(10);
    expect(h.positions.findFeeRefreshCandidates).not.toHaveBeenCalled();
  });

  it('ramps up from a quarter of the budget over the default 5 minutes after boot', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    expect(FEE_RAMP_MS).toBe(5 * 60_000);
    const h = makeHarness({ config: { positionFeeMaxPerTick: 1000 } });
    h.service.onModuleInit();
    const key = `${CHAIN}:${PROTO}`;
    expect(h.service.allotment(key)).toBe(250);
    vi.setSystemTime(Date.now() + FEE_RAMP_MS / 2);
    expect(h.service.allotment(key)).toBe(625);
    vi.setSystemTime(Date.now() + FEE_RAMP_MS);
    expect(h.service.allotment(key)).toBe(1000);
    h.service.onModuleDestroy();
  });

  it('POSITION_FEE_RAMP_MS sets the ramp (reads AND the write gate), and 0 turns it off', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const key = `${CHAIN}:${PROTO}`;
    const slow = makeHarness({ config: { positionFeeMaxPerTick: 1000, positionFeeRampMs: 20 * 60_000, positionFeeMaxWritesPerSec: 40, positionFeeMaxServedWritesPerSec: 20 } });
    slow.service.onModuleInit();
    const gate = (slow.service as unknown as { writeGate: { rates: (now: number) => { all: number; served: number } } }).writeGate;
    expect(slow.service.allotment(key)).toBe(250);
    expect(gate.rates(Date.now())).toEqual({ all: 10, served: 5 });
    vi.setSystemTime(Date.now() + 10 * 60_000); // halfway through 20 min
    expect(slow.service.allotment(key)).toBe(625);
    expect(gate.rates(Date.now())).toEqual({ all: 25, served: 12.5 });
    slow.service.onModuleDestroy();

    const none = makeHarness({ config: { positionFeeMaxPerTick: 1000, positionFeeRampMs: 0 } });
    none.service.onModuleInit();
    expect(none.service.allotment(key)).toBe(1000);
    none.service.onModuleDestroy();
  });

  it('staggers the chains across the minute instead of ticking them all at once', async () => {
    vi.useFakeTimers();
    const h = twoChains();
    const spy = vi.spyOn(h.service, 'refreshChain').mockResolvedValue({} as never);
    h.service.onModuleInit();
    await vi.advanceTimersByTimeAsync(FEE_TICK_INTERVAL_MS / 2);
    expect(spy.mock.calls).toEqual([[CHAIN, PROTO]]);
    await vi.advanceTimersByTimeAsync(FEE_TICK_INTERVAL_MS / 2);
    expect(spy.mock.calls).toEqual([
      [CHAIN, PROTO],
      [42161, PROTO],
    ]);
    await vi.advanceTimersByTimeAsync(FEE_TICK_INTERVAL_MS);
    expect(spy).toHaveBeenCalledTimes(4); // each chain still once a minute
    h.service.onModuleDestroy();
  });
});

describe('scheduling and guards', () => {
  it('ticks every chain it can read every 60 s, and stops on destroy', async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    const spy = vi.spyOn(h.service, 'refreshChain').mockResolvedValue({} as never);
    h.service.onModuleInit();
    expect(spy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(FEE_TICK_INTERVAL_MS);
    expect(spy.mock.calls).toEqual([[CHAIN, PROTO]]);
    await vi.advanceTimersByTimeAsync(FEE_TICK_INTERVAL_MS);
    expect(spy).toHaveBeenCalledTimes(2);
    h.service.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(5 * FEE_TICK_INTERVAL_MS);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(FEE_TICK_INTERVAL_MS).toBe(60_000);
  });

  it('starts no timer when the refresh is disabled', async () => {
    vi.useFakeTimers();
    const h = makeHarness({ config: { positionFeeRefreshEnabled: false } });
    const spy = vi.spyOn(h.service, 'refreshChain').mockResolvedValue({} as never);
    h.service.onModuleInit();
    await vi.advanceTimersByTimeAsync(3 * FEE_TICK_INTERVAL_MS);
    expect(spy).not.toHaveBeenCalled();
  });

  it('is single-flight per chain: a second tick returns at once', async () => {
    const h = makeHarness();
    let release!: () => void;
    h.syncRepo.getFeeCursors.mockImplementationOnce(
      () => new Promise((resolve) => { release = () => resolve({ hot: { cursor: '' }, all: { cursor: '' } }); }),
    );
    const first = h.service.refreshChain(CHAIN, PROTO);
    const second = await h.service.refreshChain(CHAIN, PROTO);
    expect(second.skipped).toBe('a run is already in progress');
    release();
    expect((await first).skipped).toBeUndefined();
  });

  it('releases the single-flight slot when the RPC client cannot even be built', async () => {
    const h = makeHarness();
    (h.service as unknown as { clients: Map<number, unknown> }).clients.clear();
    const build = vi
      .spyOn(h.service as unknown as { client: () => unknown }, 'client')
      .mockImplementationOnce(() => {
        throw new Error('bad url');
      });
    expect((await h.service.refreshChain(CHAIN, PROTO)).skipped).toMatch(/aborted: bad url/);
    build.mockRestore();
    (h.service as unknown as { clients: Map<number, unknown> }).clients.set(CHAIN, h.client);
    expect((await h.service.refreshChain(CHAIN, PROTO)).skipped).toBeUndefined();
  });

  it('skips a non-v4 integration and a chain with no RPC url', async () => {
    const h = makeHarness();
    expect((await h.service.refreshChain(CHAIN, 'uniswap-v3')).skipped).toBe('not a Uniswap v4 integration');
    expect((await h.service.refreshChain(1, PROTO)).skipped).toMatch(/no RPC url/);
    expect(h.syncRepo.getFeeCursors).not.toHaveBeenCalled();
  });
});

describe('identical re-reads are not written again', () => {
  const now = Date.parse('2026-10-01T12:00:00Z');
  const HOUR = 60 * MIN;
  const rpc = (over: Partial<NonNullable<FeeRefreshCandidate['rpc']>> = {}) => ({
    fees0: '2',
    fees1: '3',
    block: 900,
    at: new Date(now - HOUR),
    ...over,
  });

  it('skips only an identical, still-valid, recent measurement (pure)', () => {
    const c = { lastModifyBlock: 800, rpc: rpc() };
    expect(isUnchangedMeasurement(c, '2', '3', now, 6 * HOUR)).toBe(true);
    // value moved by more than the 1% re-read tolerance
    expect(isUnchangedMeasurement(c, '2.5', '3', now, 6 * HOUR)).toBe(false);
    expect(isUnchangedMeasurement(c, '2', '3.1', now, 6 * HOUR)).toBe(false);
    // accrued a little (≤1%): still unchanged, the served gate covers it
    expect(isUnchangedMeasurement(c, '2.01', '3.02', now, 6 * HOUR)).toBe(true);
    expect(isUnchangedMeasurement(c, '2.03', '3', now, 6 * HOUR)).toBe(false);
    // zero ↔ non-zero is always a change
    expect(isUnchangedMeasurement({ lastModifyBlock: 800, rpc: rpc({ fees0: '0' }) }, '0.000001', '3', now, 6 * HOUR)).toBe(false);
    // a modify after the stored block settled fees: the stored figure is stale
    expect(isUnchangedMeasurement({ lastModifyBlock: 901, rpc: rpc() }, '2', '3', now, 6 * HOUR)).toBe(false);
    // stamp older than the restamp interval
    expect(isUnchangedMeasurement({ lastModifyBlock: 800, rpc: rpc({ at: new Date(now - 7 * HOUR) }) }, '2', '3', now, 6 * HOUR)).toBe(false);
    // never measured, or no stamp time
    expect(isUnchangedMeasurement({ lastModifyBlock: 0 }, '2', '3', now, 6 * HOUR)).toBe(false);
    expect(isUnchangedMeasurement({ lastModifyBlock: 0, rpc: rpc({ at: undefined }) }, '2', '3', now, 6 * HOUR)).toBe(false);
    // 0 restores always-write
    expect(isUnchangedMeasurement(c, '2', '3', now, 0)).toBe(false);
  });

  it('writes nothing for positions whose re-read is identical, and still writes the ones that moved', async () => {
    // First run learns the exact strings the measurement produces.
    const probe = makeHarness({ rows: universe(2), config: { positionFeeRestampMs: 6 * HOUR } });
    await probe.service.refreshChain(CHAIN, PROTO);
    const sample = probe.written()[0];
    expect(sample).toBeDefined();

    const onchain = (tokenId: string, fees: { fees0: string; fees1: string }) =>
      candidate(tokenId, {
        lastModifyBlock: 500,
        rpc: { ...fees, block: 900, at: new Date(Date.now() - HOUR) },
        stored: {
          positionId: tokenId,
          isActive: true,
          token0: { priceUsd: 1 },
          token1: { priceUsd: 1 },
          amounts: { totalGasCostEth: '0' },
          metrics: {
            isPriceable: true,
            pendingFeesUsd: Number(sample.fees0) + Number(sample.fees1),
            feesSource: 'onchain',
          },
        },
      });
    const notServed = onchain('12', { fees0: sample.fees0, fees1: sample.fees1 });
    notServed.stored.metrics = { ...notServed.stored.metrics, feesSource: 'unmeasured' };
    const rows = [
      { c: onchain('10', { fees0: sample.fees0, fees1: sample.fees1 }), hot: true }, // identical → skipped
      { c: onchain('11', { fees0: '0', fees1: '0' }), hot: true }, // value moved → written
      // identical measurement, but the served figure is not on-chain yet → written (served)
      { c: notServed, hot: true },
    ];
    const h = makeHarness({ rows, config: { positionFeeRestampMs: 6 * HOUR } });
    const res = await h.service.refreshChain(CHAIN, PROTO);

    // '11' and '12' are written by both the hot and the full pass of this tick; '10' by neither.
    expect(new Set(h.written().map((w) => w.positionId))).toEqual(new Set(['11', '12']));
    expect(h.written().find((w) => w.positionId === '12')?.served).toBeDefined();
    expect(res.unchanged).toBeGreaterThanOrEqual(1);
  });
});
