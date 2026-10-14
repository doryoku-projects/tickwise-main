/*
 * PositionFeeRefreshService — reliability, speed and Mongo protection
 * (2026-10-03).
 *
 * Pinned here: viem's REAL rejected-request shape (every entry
 * `{status:'failure', error:E}`, one shared E) is a whole-request failure —
 * retried once after ~1 s, then UNANSWERED (not failed), the page held back
 * (cursor not advanced, re-read next tick) for at most 3 ticks; transport
 * failures are never split; a gas-cut tail is retried alone, in halves, at the
 * same block, bounded; scattered failures are reverts (counted failed, one
 * quick dirty retry); calls are interleaved per position; the hot tier off by
 * default and never starving `all`; the new defaults; the next page read while
 * the current one is measured, with no row skipped or double-counted and the
 * cursor saved only after persist; the per-second write gate (chunks ≤ 100,
 * backpressure); deterministic restamp jitter; persisted pass tallies and the
 * alerts; dirty rows already fresh skipped with no RPC call; backfill flushes
 * marking active rows; detail views queued with a quota and a cooldown, never
 * an RPC call on the request path.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppConfigService } from '../src/config/app-config.service.js';
import { emptyFeePassTally } from '../src/database/sync.repository.js';
import { LeaderboardCountService } from '../src/leaderboard/count-cache.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { FeeWriteGate } from '../src/sync/fee-write-gate.js';
import { positionSalt } from '../src/sync/position-fee-math.js';
import {
  HOLD_BACK_MAX_TICKS,
  MONGO_PAGE,
  RESTAMP_JITTER,
  VIEW_COOLDOWN_MAX,
  VIEW_COOLDOWN_MS,
  isFreshForChange,
  isUnchangedMeasurement,
  nextTier,
  restampJitter,
} from '../src/sync/position-fee-refresh.service.js';
import { classifyRpcError, failingTailStart, splitTail, wholeRequestFailure } from '../src/sync/position-fee-rpc.js';
import { SyncService } from '../src/sync/sync.service.js';
import {
  CHAIN,
  MIN,
  PROTO,
  candidate,
  makeHarness,
  recent,
  rejectedShape,
  revert,
  successFor,
  universe,
  type FakeCall,
} from './fee-refresh-harness.js';

const HOUR = 60 * MIN;
/** viem's HttpRequestError, as `multicall` puts it on every entry of a rejected request. */
function httpError(status = 503) {
  return Object.assign(new Error(`HTTP request failed.\n\nStatus: ${status}\nURL: http://rpc.local`), {
    name: 'HttpRequestError',
    status,
    shortMessage: 'HTTP request failed.',
  });
}
/** The full tier only (hot is off by default since 2026-10-03). */
const ALL_ONLY = { positionFeeHotIntervalMs: 0 };
const positionOf = (j: number) => Math.floor(j / 2);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('a whole-request RPC failure (viem never throws with allowFailure)', () => {
  it('is retried once after ~1 s, then the batch is UNANSWERED — not failed — and nothing is written', async () => {
    const E = httpError();
    const h = makeHarness({ rows: universe(4), config: ALL_ONLY, respond: (c) => rejectedShape(c, E) });
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(r.unanswered).toBe(4);
    expect(r.failed).toBe(0);
    expect(r.measured).toBe(0);
    expect(h.written()).toHaveLength(0);
    // 2 batches × (first try + one retry), each retry after 1 s.
    expect(h.client.multicall).toHaveBeenCalledTimes(4);
    expect(h.delays).toEqual([1000, 1000]);
  });

  it('holds the page back — cursor not saved — and re-reads it next tick; at most 3 ticks, then advances with an alert', async () => {
    const E = httpError();
    const h = makeHarness({ rows: universe(4), config: ALL_ONLY, respond: (c) => rejectedShape(c, E) });
    for (let tick = 1; tick <= HOLD_BACK_MAX_TICKS; tick++) {
      const r = await h.service.refreshChain(CHAIN, PROTO);
      expect(r.heldBack).toBe('all');
      expect(h.syncRepo.saveFeeCursor).not.toHaveBeenCalled();
      // Every tick re-reads the same page.
      expect(h.positions.findFeeRefreshCandidates.mock.calls[tick - 1]![2]).toBe('');
    }
    const last = await h.service.refreshChain(CHAIN, PROTO);
    expect(last.heldBack).toBeUndefined();
    expect(h.syncRepo.saveFeeCursor).toHaveBeenCalledTimes(1);
    expect(last.finished).toEqual(['all']);
    expect(h.warnings().filter((w) => w.startsWith('[alert] fees.page_unanswered'))).toHaveLength(1);
    // The pass finished with rows never answered: that is a pass failure.
    expect(h.warnings().find((w) => w.startsWith('[alert] fees.pass_failures'))).toMatch(/tier=all failed=0 unanswered=4/);
    expect(h.tallies.all).toMatchObject({ scanned: 4, unanswered: 4, failed: 0 });
  });

  it('a page whose rows are answered on a later tick advances normally and the hold-back resets', async () => {
    let down = true;
    const E = httpError();
    const h = makeHarness({
      rows: universe(4),
      config: ALL_ONLY,
      respond: (c) => (down ? rejectedShape(c, E) : c.map(successFor)),
    });
    expect((await h.service.refreshChain(CHAIN, PROTO)).heldBack).toBe('all');
    down = false;
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(r.heldBack).toBeUndefined();
    expect(r.unanswered).toBe(0);
    expect(h.written()).toHaveLength(4);
    expect(h.tallies.all).toMatchObject({ scanned: 4, measured: 4, unanswered: 0 });
    expect(h.warnings().some((w) => w.includes('fees.pass_failures'))).toBe(false);
  });

  it('a request that fails once and succeeds on the retry is measured', async () => {
    const E = httpError();
    const h = makeHarness({
      rows: universe(2),
      config: ALL_ONLY,
      respond: (c, _b, n) => (n === 0 ? rejectedShape(c, E) : c.map(successFor)),
    });
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(h.client.multicall).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ measured: 2, unanswered: 0, failed: 0 });
    expect(h.written()).toHaveLength(2);
  });

  it('a transport failure is never split: two requests carrying the whole batch, nothing smaller', async () => {
    const E = httpError(429);
    const h = makeHarness({
      rows: universe(60),
      config: { ...ALL_ONLY, positionFeeBatchSize: 60 },
      respond: (c) => rejectedShape(c, E),
    });
    await h.service.refreshChain(CHAIN, PROTO);
    expect(h.calls.map((c) => c.salts.length)).toEqual([60, 60]);
  });

  it('raises a throttled [alert] fees.rpc_batch_failed — once per chain per 10 min — and counts every failure', async () => {
    const E = httpError();
    const h = makeHarness({ rows: universe(4), config: ALL_ONLY, respond: (c) => rejectedShape(c, E) });
    await h.service.refreshChain(CHAIN, PROTO);
    await h.service.refreshChain(CHAIN, PROTO);
    const alerts = h.warnings().filter((w) => w.startsWith('[alert] fees.rpc_batch_failed'));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatch(/chain=4663 positions=2 err=HTTP request failed\. failures=1/);
    expect(h.service.rpcBatchFailures(CHAIN)).toBe(8);
  });

  it('a whole-request GAS error is split, not retried as an outage', async () => {
    const E = new Error('execution reverted: out of gas');
    const h = makeHarness({
      rows: universe(60),
      config: { ...ALL_ONLY, positionFeeBatchSize: 60 },
      respond: (c, _b, n) => (n === 0 ? rejectedShape(c, E) : c.map(successFor)),
    });
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(h.calls.map((c) => c.salts.length)).toEqual([60, 30, 30]);
    expect(h.delays).toEqual([]);
    expect(h.service.rpcBatchFailures(CHAIN)).toBe(0);
    expect(r.measured).toBe(60);
  });
});

describe('gas tails and reverts', () => {
  it('retries ONLY the failed tail, in halves, at the same pinned block', async () => {
    const rows = universe(100);
    const h = makeHarness({
      rows,
      config: { ...ALL_ONLY, positionFeeBatchSize: 100 },
      // First request: positions 0..19 answered, 20..99 cut off (each its own error).
      respond: (c, _b, n) => c.map((call, j) => (n === 0 && positionOf(j) >= 20 ? revert(call, j) : successFor(call))),
    });
    const r = await h.service.refreshChain(CHAIN, PROTO);
    const salt = (i: number) => positionSalt(rows[i]!.c.tokenId);
    expect(h.calls).toHaveLength(3);
    expect(h.calls[1]!.salts).toEqual(rows.slice(20, 60).map((_, k) => salt(20 + k)));
    expect(h.calls[2]!.salts).toEqual(rows.slice(60, 100).map((_, k) => salt(60 + k)));
    expect(new Set(h.calls.map((c) => c.blockNumber))).toEqual(new Set([1000n]));
    expect(h.client.getBlockNumber).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ measured: 100, failed: 0, unanswered: 0 });
    expect(h.written()).toHaveLength(100);
  });

  it('a tail that keeps failing is bounded (depth ≤ 3), counted failed, and sent to the dirty set once', async () => {
    const h = makeHarness({
      rows: universe(100),
      config: { ...ALL_ONLY, positionFeeBatchSize: 100 },
      // Every request answers its first position only.
      respond: (c) => c.map((call, j) => (positionOf(j) === 0 ? successFor(call) : revert(call, j))),
    });
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(h.calls).toHaveLength(7);
    expect(r.measured).toBe(7);
    expect(r.failed).toBe(93);
    expect(r.unanswered).toBe(0);
    expect(h.service.dirtySize(CHAIN, PROTO)).toBe(93);
  });

  it('scattered failures are reverts: counted failed, no split, one quick dirty retry', async () => {
    const rows = universe(10);
    const h = makeHarness({
      rows,
      config: { ...ALL_ONLY, positionFeeBatchSize: 10 },
      respond: (c) => c.map((call, j) => (positionOf(j) === 3 ? revert(call, j) : successFor(call))),
    });
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(h.calls).toHaveLength(1);
    expect(r).toMatchObject({ measured: 9, failed: 1, unanswered: 0 });
    expect(h.service.dirtySize(CHAIN, PROTO)).toBe(1);
  });

  it('a batch failing per call from its first position is reverting, not out of gas: no split', async () => {
    const h = makeHarness({
      rows: universe(60),
      config: { ...ALL_ONLY, positionFeeBatchSize: 60 },
      respond: (c) => c.map((call, j) => revert(call, j)),
    });
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(h.calls).toHaveLength(1);
    expect(r.failed).toBe(60);
  });

  it('the quick retry lands on the NEXT tick, not in this tick’s own dirty drains', async () => {
    let failing = true;
    const h = makeHarness({
      rows: universe(10),
      config: { ...ALL_ONLY, positionFeeBatchSize: 10 },
      respond: (c) => c.map((call, j) => (failing && positionOf(j) === 3 ? revert(call, j) : successFor(call))),
    });
    const first = await h.service.refreshChain(CHAIN, PROTO);
    expect(first.tiers.dirty).toBe(0);
    expect(h.service.dirtySize(CHAIN, PROTO)).toBe(1);
    failing = false;
    const second = await h.service.refreshChain(CHAIN, PROTO);
    expect(second.tiers.dirty).toBe(1);
    expect(second.failed).toBe(0);
    expect(h.service.dirtySize(CHAIN, PROTO)).toBe(0);
  });

  it('a dirty row that reverts is not re-queued again (the retry is bounded to one)', async () => {
    const h = makeHarness({
      cursors: { hot: recent(), all: recent() },
      respond: (c) => c.map((call, j) => revert(call, j)),
    });
    h.service.markDirty(CHAIN, ['7'], PROTO);
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(r.failed).toBe(1);
    expect(h.service.dirtySize(CHAIN, PROTO)).toBe(0);
  });

  it('interleaves the calls per position: [feeGrowthInside_i, positionInfo_i, …]', async () => {
    const rows = universe(3);
    const h = makeHarness({ rows, config: { ...ALL_ONLY, positionFeeBatchSize: 3 } });
    await h.service.refreshChain(CHAIN, PROTO);
    expect(h.calls[0]!.functions).toEqual([
      'getFeeGrowthInside',
      'getPositionInfo',
      'getFeeGrowthInside',
      'getPositionInfo',
      'getFeeGrowthInside',
      'getPositionInfo',
    ]);
    expect(h.calls[0]!.salts).toEqual(rows.map((r) => positionSalt(r.c.tokenId)));
  });

  it('pure: whole-request detection, classification, the failing tail and its split', () => {
    const E = httpError();
    const calls: FakeCall[] = [
      { functionName: 'getFeeGrowthInside', args: ['0x1'] },
      { functionName: 'getPositionInfo', args: ['0x1'] },
    ];
    expect(wholeRequestFailure(rejectedShape(calls, E))).toBe(E);
    // Same message on distinct objects still reads as one failure.
    expect(wholeRequestFailure([{ status: 'failure', error: new Error('x') }, { status: 'failure', error: new Error('x') }])).toBeDefined();
    expect(wholeRequestFailure(calls.map((c, j) => revert(c, j)))).toBeUndefined();
    expect(wholeRequestFailure([{ status: 'success', result: 1 }, { status: 'failure', error: E }])).toBeUndefined();
    expect(wholeRequestFailure([])).toBeUndefined();

    expect(classifyRpcError(E)).toBe('transport');
    expect(classifyRpcError(Object.assign(new Error('boom'), { name: 'TimeoutError' }))).toBe('transport');
    expect(classifyRpcError(Object.assign(new Error('limit'), { name: 'LimitExceededRpcError' }))).toBe('transport');
    expect(classifyRpcError(new Error('wrapped', { cause: { status: 429, message: 'x' } }))).toBe('transport');
    expect(classifyRpcError(new Error('execution reverted: out of gas'))).toBe('gas');
    expect(classifyRpcError(new Error('gas required exceeds allowance (50000000)'))).toBe('gas');
    expect(classifyRpcError(new Error('rate limited, but also out of gas'))).toBe('transport');
    expect(classifyRpcError(new Error('something else'))).toBe('other');

    expect(failingTailStart([true, true, false, false])).toBe(2);
    expect(failingTailStart([true, false, true])).toBe(-1);
    expect(failingTailStart([false, false])).toBe(0);
    expect(splitTail(Array.from({ length: 49 }, (_, i) => i))).toHaveLength(1);
    expect(splitTail(Array.from({ length: 50 }, (_, i) => i)).map((p) => p.length)).toEqual([25, 25]);
  });
});

describe('tiers: hot off by default, never starving all', () => {
  const now = Date.parse('2026-10-03T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms);

  it('a hot interval of 0 disables hot, even with a hot pass left in progress', () => {
    const intervals = { hot: 0, all: 45 * MIN };
    expect(nextTier({ hot: { cursor: '9', startedAt: ago(MIN) }, all: { cursor: '' } }, now, intervals)).toBe('all');
    expect(nextTier({ hot: { cursor: '' }, all: { cursor: '', startedAt: ago(2 * MIN), finishedAt: ago(MIN) } }, now, intervals)).toBeNull();
  });

  it('the service reads only the full tier when hot is off', async () => {
    const h = makeHarness({ rows: universe(4, (i) => i % 2 === 0), config: ALL_ONLY });
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(h.positions.findFeeRefreshCandidates.mock.calls.map((c) => c[4])).toEqual([{}]);
    expect(r.tiers).toMatchObject({ hot: 0, all: 4 });
  });

  it('hot enabled: an all pass in progress for more than half its interval goes before hot', () => {
    const intervals = { hot: 30 * MIN, all: 45 * MIN };
    const hotDue = { cursor: '' };
    expect(nextTier({ hot: hotDue, all: { cursor: '5', startedAt: ago(23 * MIN) } }, now, intervals)).toBe('all');
    expect(nextTier({ hot: hotDue, all: { cursor: '5', startedAt: ago(22 * MIN) } }, now, intervals)).toBe('hot');
    // Not in progress (due but not started): hot still first.
    expect(nextTier({ hot: hotDue, all: { cursor: '' } }, now, intervals)).toBe('hot');
  });
});

describe('defaults (AppConfigService)', () => {
  function config(env: Record<string, string> = {}) {
    vi.stubEnv('ETHEREUM_UNISWAP_V4_SUBGRAPH_URL', 'https://indexer.hyperindex.xyz/abc123/v1/graphql');
    vi.stubEnv('ETHEREUM_UNISWAP_V4_SUBGRAPH_DIALECT', 'hyperindex');
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    return new AppConfigService();
  }

  it('ships the 2026-10-03 budget, page, concurrency, interval and pacing defaults', () => {
    const c = config();
    expect(c.positionFeeHotIntervalMs).toBe(0);
    expect(c.positionFeeFullIntervalMs).toBe(2_700_000);
    expect(c.positionFeeMaxPerTick).toBe(25_000);
    expect(c.positionFeeRampMs).toBe(300_000);
    expect(c.positionFeeConcurrency).toBe(8);
    expect(c.positionFeeBatchSize).toBe(200);
    expect(c.positionFeeHotMinUsd).toBe(50);
    expect(c.positionFeeRestampMs).toBe(86_400_000);
    expect(c.positionFeeMaxWritesPerSec).toBe(40);
    expect(c.positionFeeMaxServedWritesPerSec).toBe(25);
    expect(c.positionFeePassAlertMs).toBe(3_000_000);
    expect(c.positionFeeViewPerTick).toBe(200);
    expect(MONGO_PAGE).toBe(2000);
  });

  it('the hot interval: 0 or garbage is off, a positive value is floored at 60 s', () => {
    expect(config({ POSITION_FEE_HOT_INTERVAL_MS: '1800000' }).positionFeeHotIntervalMs).toBe(1_800_000);
    expect(config({ POSITION_FEE_HOT_INTERVAL_MS: '1000' }).positionFeeHotIntervalMs).toBe(60_000);
    expect(config({ POSITION_FEE_HOT_INTERVAL_MS: 'nope' }).positionFeeHotIntervalMs).toBe(0);
  });

  it('write rates have no "unlimited": 0 reads as the default; restamp 0 stays 0 (always write)', () => {
    const c = config({ POSITION_FEE_MAX_WRITES_PER_SEC: '0', POSITION_FEE_MAX_SERVED_WRITES_PER_SEC: '-1', POSITION_FEE_RESTAMP_MS: '0' });
    expect(c.positionFeeMaxWritesPerSec).toBe(40);
    expect(c.positionFeeMaxServedWritesPerSec).toBe(25);
    expect(c.positionFeeRestampMs).toBe(0);
    expect(config({ POSITION_FEE_VIEW_PER_TICK: '0' }).positionFeeViewPerTick).toBe(0);
  });
});

describe('the next page is read while the current one is measured', () => {
  it('no row skipped or double-counted; each cursor saved only after its page was written', async () => {
    const rows = universe(5000);
    const h = makeHarness({ rows, config: { ...ALL_ONLY, positionFeeBatchSize: 200, positionFeeConcurrency: 8, positionFeeMaxPerTick: 5000 } });
    await h.service.refreshChain(CHAIN, PROTO);

    const reads = h.positions.findFeeRefreshCandidates.mock.calls.map((c) => [c[2], c[3]]);
    const last = (i: number) => rows[i]!.c.tokenId;
    expect(reads).toEqual([
      ['', 2000],
      [last(1999), 2000],
      [last(3999), 1000],
    ]);
    const ids = h.written().map((w) => w.positionId);
    expect(ids).toHaveLength(5000);
    expect(new Set(ids).size).toBe(5000);

    const page1 = new Set(rows.slice(0, 2000).map((r) => r.c.positionId));
    const writesOf = (page: Set<string>) =>
      h.events.flatMap((e, i) => (e.startsWith('write:') && page.has(e.slice(6).split(',')[0]!) ? [i] : []));
    const p1Writes = writesOf(page1);
    const prefetch2 = h.events.indexOf(`read:all:${last(1999)}:2000`);
    const save1 = h.events.indexOf(`save:all:${last(1999)}`);
    // Page 2 was being read before page 1's first write…
    expect(prefetch2).toBeLessThan(p1Writes[0]!);
    // …and page 1's cursor was saved only after its last write.
    expect(save1).toBeGreaterThan(p1Writes[p1Writes.length - 1]!);
    expect(h.store.all.cursor).toBe(last(4999));
    expect(h.tallies.all).toMatchObject({ scanned: 5000, measured: 5000, written: 5000 });
  });

  it('a page read ahead for one tier is discarded when the next page comes from another', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    // Hot (every other row) last ran 29.5 min ago: not due when the tick starts…
    const rows = universe(5000, (i) => i % 2 === 0);
    const hotRan = { cursor: '', startedAt: new Date(Date.now() - 29.5 * MIN), finishedAt: new Date(Date.now() - 29 * MIN) };
    let advanced = false;
    const h = makeHarness({
      rows,
      cursors: { hot: hotRan },
      config: { positionFeeBatchSize: 200, positionFeeConcurrency: 8, positionFeeMaxPerTick: 4000 },
      respond: (c) => {
        // …and due a minute later, while the first `all` page is being measured.
        if (!advanced) {
          advanced = true;
          vi.setSystemTime(Date.now() + MIN);
        }
        return c.map(successFor);
      },
    });
    await h.service.refreshChain(CHAIN, PROTO);
    const reads = h.positions.findFeeRefreshCandidates.mock.calls.map((c) => [c[2], c[3], c[4]]);
    expect(reads.slice(0, 3)).toEqual([
      ['', 2000, {}],
      [rows[1999]!.c.tokenId, 2000, {}], // read ahead for `all`…
      ['', 2000, { hotMinUsd: 50 }], // …but hot came next: its own page, from its own start
    ]);
    const hotRows = new Set(rows.filter((r) => r.hot).map((r) => r.c.positionId));
    const hotPage = rows.filter((r) => r.hot).slice(0, 2000);
    expect(h.store.hot.cursor).toBe(hotPage[hotPage.length - 1]!.c.tokenId);
    expect(h.store.all.cursor).toBe(rows[1999]!.c.tokenId);
    // Every row the hot pass wrote is a hot row.
    const hotWrites = h.written().slice(2000);
    expect(hotWrites.length).toBe(2000);
    expect(hotWrites.every((w) => hotRows.has(w.positionId))).toBe(true);
  });

  it('a held-back page discards the page read ahead of it: nothing of it is measured or counted', async () => {
    const rows = universe(4500);
    const firstSalt = positionSalt(rows[0]!.c.tokenId);
    const E = httpError();
    const h = makeHarness({
      rows,
      config: { ...ALL_ONLY, positionFeeBatchSize: 200, positionFeeConcurrency: 8, positionFeeMaxPerTick: 4500 },
      respond: (c) => (String(c[1]!.args[4]) === firstSalt ? rejectedShape(c, E) : c.map(successFor)),
    });
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(r.heldBack).toBe('all');
    expect(h.events).toContain(`read:all:${rows[1999]!.c.tokenId}:2000`); // the read-ahead happened…
    const page2 = new Set(rows.slice(2000).map((x) => x.c.positionId));
    expect(h.written().some((w) => page2.has(w.positionId))).toBe(false); // …and was dropped
    expect(r.tiers.all).toBe(2000);
    expect(r.unanswered).toBe(200);
    expect(h.syncRepo.saveFeeCursor).not.toHaveBeenCalled();
    // Next tick starts from the same page.
    await h.service.refreshChain(CHAIN, PROTO);
    expect(h.positions.findFeeRefreshCandidates.mock.calls[2]![2]).toBe('');
  });
});

describe('the per-second write gate', () => {
  function clockedGate(rates = { all: 40, served: 25 }) {
    let t = 0;
    const sleeps: number[] = [];
    const gate = new FeeWriteGate(
      () => rates,
      () => t,
      async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
    );
    return { gate, sleeps, now: () => t };
  }

  it('paces chunks to the rate: a one-second burst, then exactly the rate', async () => {
    const { gate, sleeps, now } = clockedGate();
    await gate.acquire(100, 0);
    await gate.acquire(100, 0);
    expect(sleeps).toEqual([1500, 2500]);
    for (let i = 0; i < 8; i++) await gate.acquire(100, 0);
    // 1000 writes at 40/s, less the 40-write initial burst.
    expect(now()).toBe(24_000);
  });

  it('a chunk waits for the slower bucket; served writes count against both', async () => {
    const { gate, sleeps } = clockedGate();
    await gate.acquire(50, 50);
    // all: 40 − 50 → 250 ms; served: 25 − 50 → 1000 ms.
    expect(sleeps).toEqual([1000]);
  });

  it('concurrent waiters queue behind each other', async () => {
    // Both arrive at t = 0 (the clock does not move while they wait).
    const gate = new FeeWriteGate(() => ({ all: 40, served: 25 }), () => 0, async () => undefined);
    const waits = [gate.acquire(100, 0), gate.acquire(100, 0)];
    expect(await Promise.all(waits)).toEqual([1500, 4000]);
  });

  it('a rate that is not positive disables its bucket', async () => {
    const { gate, sleeps } = clockedGate({ all: Number.NaN, served: 0 });
    await gate.acquire(10_000, 10_000);
    expect(sleeps).toEqual([]);
  });

  it('the service writes in chunks of ≤ 100, each waiting for tokens (backpressure, never dropped)', async () => {
    vi.useFakeTimers();
    const h = makeHarness({
      rows: universe(250),
      config: { ...ALL_ONLY, positionFeeBatchSize: 50, positionFeeConcurrency: 8, positionFeeMaxWritesPerSec: 40, positionFeeMaxServedWritesPerSec: 1000 },
    });
    const run = h.service.refreshChain(CHAIN, PROTO);
    await vi.advanceTimersByTimeAsync(1400);
    expect(h.positions.writeRpcFees).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100); // t = 1.5 s
    expect(h.writes.map((w) => w.length)).toEqual([100]);
    await vi.advanceTimersByTimeAsync(2500); // t = 4 s
    expect(h.writes.map((w) => w.length)).toEqual([100, 100]);
    await vi.advanceTimersByTimeAsync(1250); // t = 5.25 s
    expect(h.writes.map((w) => w.length)).toEqual([100, 100, 50]);
    const r = await run;
    expect(r.written).toBe(250);
  });

  it('the boot ramp applies to the write rate too', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const h = makeHarness({ config: { positionFeeMaxWritesPerSec: 40, positionFeeMaxServedWritesPerSec: 25 } });
    h.service.onModuleInit();
    const gate = (h.service as unknown as { writeGate: { rates: (now: number) => { all: number; served: number } } }).writeGate;
    expect(gate.rates(Date.now())).toEqual({ all: 10, served: 6.25 });
    h.service.onModuleDestroy();
  });
});

describe('restamp jitter', () => {
  it('is deterministic per position and stays within ±25%', () => {
    expect(restampJitter('3468131')).toBe(restampJitter('3468131'));
    const factors = Array.from({ length: 10_000 }, (_, i) => restampJitter(String(1_000_000 + i)));
    expect(Math.min(...factors)).toBeGreaterThanOrEqual(1 - RESTAMP_JITTER);
    expect(Math.max(...factors)).toBeLessThan(1 + RESTAMP_JITTER);
    // Actually spread, not a constant.
    expect(factors.some((f) => f < 0.8)).toBe(true);
    expect(factors.some((f) => f > 1.2)).toBe(true);
  });

  it('moves each position’s restamp window, and only when its id is known', () => {
    const now = Date.parse('2026-10-03T12:00:00Z');
    const id = Array.from({ length: 1000 }, (_, i) => String(i)).find((x) => restampJitter(x) < 0.9)!;
    const f = restampJitter(id);
    const at = (ageMs: number) => ({ fees0: '2', fees1: '3', block: 900, at: new Date(now - ageMs) });
    const restamp = 24 * HOUR;
    const between = restamp * (f + 1) / 2; // older than this id's window, younger than the plain one
    expect(isUnchangedMeasurement({ positionId: id, lastModifyBlock: 0, rpc: at(between) }, '2', '3', now, restamp)).toBe(false);
    expect(isUnchangedMeasurement({ lastModifyBlock: 0, rpc: at(between) }, '2', '3', now, restamp)).toBe(true);
    expect(isUnchangedMeasurement({ positionId: id, lastModifyBlock: 0, rpc: at(restamp * f * 0.99) }, '2', '3', now, restamp)).toBe(true);
  });
});

describe('pass tallies (persisted) and alerts', () => {
  it('the end-of-pass line counts the whole pass across a restart', async () => {
    const rows = universe(5);
    const first = makeHarness({ rows, config: { ...ALL_ONLY, positionFeeMaxPerTick: 3 } });
    await first.service.refreshChain(CHAIN, PROTO);
    expect(first.syncRepo.saveFeeCursor.mock.calls[0]![4]).toMatchObject({ mode: 'set' });
    expect(first.tallies.all).toMatchObject({ scanned: 3, measured: 3 });

    // "Restart": a fresh service over the same persisted cursor and counts.
    const second = makeHarness({
      rows,
      cursors: { all: { ...first.store.all, tally: first.tallies.all } },
      config: { ...ALL_ONLY, positionFeeMaxPerTick: 3 },
    });
    await second.service.refreshChain(CHAIN, PROTO);
    expect(second.syncRepo.saveFeeCursor.mock.calls[0]![4]).toMatchObject({ mode: 'inc' });
    const line = second.log.mock.calls.map(String).find((l) => l.includes('all pass'));
    expect(line).toMatch(/scanned=5 measured=5 written=5 served=5 stale=0 unchanged=0 failed=0 unanswered=0 unreadable=0/);
  });

  it('a new pass resets the counts left by the last one', async () => {
    const stale = { ...emptyFeePassTally(), scanned: 999, failed: 7 };
    // Finished, and due again (the harness's full interval is 6 h).
    const done = { cursor: '', startedAt: new Date(Date.now() - 7 * HOUR), finishedAt: new Date(Date.now() - 6.5 * HOUR), tally: stale };
    const h = makeHarness({ rows: universe(3), cursors: { all: done }, config: ALL_ONLY });
    await h.service.refreshChain(CHAIN, PROTO);
    expect(h.tallies.all).toMatchObject({ scanned: 3, failed: 0 });
    expect(h.warnings().some((w) => w.includes('fees.pass_failures'))).toBe(false);
  });

  it('[alert] fees.pass_failures when a pass finishes with failures; unreadable rows are counted apart', async () => {
    const rows = universe(3);
    rows.push({ c: candidate('99', { poolId: 'not-a-pool' }), hot: true });
    const h = makeHarness({
      rows,
      config: { ...ALL_ONLY, positionFeeBatchSize: 3 },
      respond: (c) => c.map((call, j) => (positionOf(j) === 0 ? revert(call, j) : successFor(call))),
    });
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(r.unreadable).toBe(1);
    expect(r.failed).toBe(1);
    expect(h.warnings().filter((w) => w.startsWith('[alert] fees.pass_failures'))).toEqual([
      expect.stringMatching(/chain=4663 tier=all failed=1 unanswered=0 scanned=4/),
    ]);
  });

  it('unreadable rows alone raise no failure alert', async () => {
    const h = makeHarness({ rows: [{ c: candidate('99', { tickLower: 5, tickUpper: 5 }), hot: true }], config: ALL_ONLY });
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(r).toMatchObject({ unreadable: 1, failed: 0 });
    expect(h.warnings().some((w) => w.includes('fees.pass_failures'))).toBe(false);
  });

  it('[alert] fees.pass_overdue once per (chain, tier, pass start)', async () => {
    const running = { cursor: '1', startedAt: new Date(Date.now() - 60 * MIN) };
    const h = makeHarness({ rows: universe(10), cursors: { all: running }, config: { ...ALL_ONLY, positionFeeMaxPerTick: 2 } });
    await h.service.refreshChain(CHAIN, PROTO);
    await h.service.refreshChain(CHAIN, PROTO);
    const overdue = () => h.warnings().filter((w) => w.startsWith('[alert] fees.pass_overdue'));
    expect(overdue()).toHaveLength(1);
    expect(overdue()[0]).toMatch(/chain=4663 tier=all elapsedMin=60/);
    // A different pass start alerts again.
    h.store.all = { ...h.store.all, startedAt: new Date(Date.now() - 55 * MIN) };
    await h.service.refreshChain(CHAIN, PROTO);
    expect(overdue()).toHaveLength(2);
  });

  it('no overdue alert inside POSITION_FEE_PASS_ALERT_MS', async () => {
    const running = { cursor: '1', startedAt: new Date(Date.now() - 40 * MIN) };
    const h = makeHarness({ rows: universe(10), cursors: { all: running }, config: { ...ALL_ONLY, positionFeeMaxPerTick: 2 } });
    await h.service.refreshChain(CHAIN, PROTO);
    expect(h.warnings().some((w) => w.includes('fees.pass_overdue'))).toBe(false);
  });
});

describe('dirty rows already fresh are skipped with no RPC call', () => {
  const at = new Date();
  const measuredAt = (block: number) => ({ fees0: '1', fees1: '1', block, at });

  it('pure: the stored reading must be at or after both the change and the last modify', () => {
    expect(isFreshForChange({ lastModifyBlock: 1000, rpc: measuredAt(2000) }, 1500)).toBe(true);
    expect(isFreshForChange({ lastModifyBlock: 1000, rpc: measuredAt(1500) }, 1500)).toBe(true);
    expect(isFreshForChange({ lastModifyBlock: 1000, rpc: measuredAt(1400) }, 1500)).toBe(false);
    expect(isFreshForChange({ lastModifyBlock: 2500, rpc: measuredAt(2000) }, 1500)).toBe(false);
    expect(isFreshForChange({ lastModifyBlock: 0 }, 1500)).toBe(false);
    expect(isFreshForChange({ lastModifyBlock: 0, rpc: measuredAt(2000) }, Number.POSITIVE_INFINITY)).toBe(false);
    expect(isFreshForChange({ lastModifyBlock: 0, rpc: measuredAt(2000) }, 0)).toBe(false);
  });

  it('the drain skips the fresh row, re-reads the stale one and every row queued without a block', async () => {
    const rows = [
      { c: candidate('7', { lastModifyBlock: 1000, rpc: measuredAt(2000) }), hot: true },
      { c: candidate('8', { lastModifyBlock: 1000, rpc: measuredAt(1400) }), hot: true },
      { c: candidate('9', { lastModifyBlock: 1000, rpc: measuredAt(2000) }), hot: true },
    ];
    const h = makeHarness({ rows, cursors: { hot: recent(), all: recent() } });
    h.service.markDirty(CHAIN, ['7', '8'], PROTO, new Map([['7', 1500], ['8', 1500]]));
    h.service.markDirty(CHAIN, ['9'], PROTO);
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(r.skippedFresh).toBe(1);
    expect(r.tiers.dirty).toBe(2);
    const salts = h.calls.flatMap((c) => c.salts);
    expect(salts.sort()).toEqual([positionSalt('8'), positionSalt('9')].sort());
  });

  it('a position marked twice keeps the LATER change block', async () => {
    const rows = [{ c: candidate('7', { lastModifyBlock: 1000, rpc: measuredAt(2000) }), hot: true }];
    const h = makeHarness({ rows, cursors: { hot: recent(), all: recent() } });
    h.service.markDirty(CHAIN, ['7'], PROTO, new Map([['7', 2500]]));
    h.service.markDirty(CHAIN, ['7'], PROTO, new Map([['7', 1500]]));
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(r.skippedFresh).toBe(0);
    expect(r.tiers.dirty).toBe(1);
  });

  it('skipped rows give their budget back to the tick', async () => {
    const rows = universe(10);
    const fresh = Array.from({ length: 5 }, (_, i) => ({
      c: candidate(String(500 + i), { lastModifyBlock: 1, rpc: measuredAt(5000) }),
      hot: true,
    }));
    const h = makeHarness({ rows: [...rows, ...fresh], config: { positionFeeMaxPerTick: 10 } });
    h.service.markDirty(CHAIN, fresh.map((f) => f.c.positionId), PROTO, new Map(fresh.map((f) => [f.c.positionId, 10] as const)));
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(r.skippedFresh).toBe(5);
    // The tier pass got the whole tick: nothing was measured for the skipped rows.
    expect(r.tiers.hot).toBe(10);
  });
});

describe('backfill flushes queue their active rows', () => {
  const integration = { chainId: 4663, protocol: 'uniswap-v4', subgraphUrl: 'https://example.com', enabled: true };
  const pos = (positionId: string, isActive: boolean, lastModifyBlock?: number) =>
    ({ positionId, tokenId: positionId, isActive, ...(lastModifyBlock !== undefined ? { lastModifyBlock } : {}) }) as never;

  function makeSync(feeRefresh?: { markDirty: ReturnType<typeof vi.fn> }, upsertMany = vi.fn(async (p: unknown[]) => p.length)) {
    const fetchPositions = vi.fn(async (opts: { onFlush: (p: unknown[], c: unknown) => Promise<number> }) => {
      await opts.onFlush([pos('1', true, 500), pos('2', false, 600), pos('3', true)], {
        maxTimestamp: 1,
        maxPositionId: '3',
        maxBlockNumber: 1,
      });
      return {
        positions: [pos('4', true, 700)],
        seenPositionIds: [],
        maxTimestamp: 2,
        maxPositionId: '4',
        maxBlockNumber: 2,
        hasMore: false,
        flushedCount: 3,
      };
    });
    const syncRepo = {
      startRun: vi.fn(async () => 'run'),
      getCursor: vi.fn(async () => null),
      markCursorSuccess: vi.fn(async () => undefined),
      markCursorFailure: vi.fn(async () => undefined),
      finishRun: vi.fn(async () => undefined),
      markBackfillStarted: vi.fn(async () => undefined),
      markBackfillFinished: vi.fn(async () => undefined),
      resetCursor: vi.fn(async () => undefined),
    };
    const service = new SyncService(
      { testMode: false, testModePositionLimit: 0, positionsBackfillBuckets: 1 } as never,
      { resolve: () => ({ fetchPositions, recomputeMode: 'aggregates' }) } as never,
      { upsertMany } as never,
      syncRepo as never,
      {} as never,
      { syncTokenIdsFromPositionSync: vi.fn(async () => ({})) } as never,
      { recompute: vi.fn(async () => 0) } as never,
      feeRefresh as never,
    );
    return { service };
  }

  it('marks only ACTIVE rows, into the backfill lane, after the upsert, each with its lastModifyBlock (0 when unknown)', async () => {
    const order: string[] = [];
    const markDirty = vi.fn((_c: number, ids: string[]) => {
      order.push(`mark:${[...ids].join(',')}`);
    });
    const upsertMany = vi.fn(async (p: Array<{ positionId: string }>) => {
      order.push(`upsert:${p.map((x) => x.positionId).join(',')}`);
      return p.length;
    });
    const { service } = makeSync({ markDirty }, upsertMany as never);
    await service.runBackfill(integration);
    expect(markDirty).toHaveBeenCalledTimes(2);
    const [chain, ids, proto, blocks, opts] = markDirty.mock.calls[0] as unknown as [number, string[], string, Map<string, number>, unknown];
    expect([chain, ids, proto]).toEqual([4663, ['1', '3'], 'uniswap-v4']);
    expect([...blocks]).toEqual([
      ['1', 500],
      ['3', 0],
    ]);
    expect(opts).toEqual({ lane: 'backfill' });
    expect(markDirty.mock.calls[1]![1]).toEqual(['4']);
    expect(markDirty.mock.calls[1]![4]).toEqual({ lane: 'backfill' });
    // Each flush's mark comes only after that flush's upsert resolved.
    expect(order).toEqual(['upsert:1,2,3', 'mark:1,3', 'upsert:4', 'mark:4']);
  });

  it('a flush whose upsert fails queues nothing', async () => {
    const markDirty = vi.fn();
    const upsertMany = vi.fn(async () => {
      throw new Error('mongo write error');
    });
    const { service } = makeSync({ markDirty }, upsertMany as never);
    vi.spyOn((service as unknown as { logger: { error: () => void } }).logger, 'error').mockImplementation(() => {});
    await expect(service.runBackfill(integration)).rejects.toThrow('mongo write error');
    expect(markDirty).not.toHaveBeenCalled();
  });

  it('a failing mark never fails the backfill, and no fee refresh is fine too', async () => {
    const throwing = makeSync({ markDirty: vi.fn(() => { throw new Error('boom'); }) });
    vi.spyOn((throwing.service as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => {});
    await expect(throwing.service.runBackfill(integration)).resolves.toMatchObject({ upserted: 4 });
    await expect(makeSync(undefined).service.runBackfill(integration)).resolves.toMatchObject({ upserted: 4 });
  });

  it('end to end: an unknown block (0) is always re-read, a known one may be skipped', async () => {
    const h = makeHarness({
      rows: [
        { c: candidate('1', { lastModifyBlock: 500, rpc: { fees0: '1', fees1: '1', block: 900, at: new Date() } }), hot: true },
        { c: candidate('3', { rpc: { fees0: '1', fees1: '1', block: 900, at: new Date() } }), hot: true },
      ],
      cursors: { hot: recent(), all: recent() },
    });
    h.service.markDirty(CHAIN, ['1', '3'], PROTO, new Map([['1', 500], ['3', 0]]));
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(r.skippedFresh).toBe(1);
    expect(h.calls.flatMap((c) => c.salts)).toEqual([positionSalt('3')]);
  });
});

describe('detail views (markViewed)', () => {
  it('queues once per position per 5-min cooldown and drains on the next tick', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const h = makeHarness({ cursors: { hot: recent(), all: recent() } });
    h.service.markViewed(CHAIN, PROTO, '7');
    h.service.markViewed(CHAIN, PROTO, '7');
    expect(h.service.viewedSize(CHAIN, PROTO)).toBe(1);
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(r.tiers.view).toBe(1);
    expect(h.written().map((w) => w.positionId)).toEqual(['7']);
    expect(h.service.viewedSize(CHAIN, PROTO)).toBe(0);
    h.service.markViewed(CHAIN, PROTO, '7'); // inside the cooldown
    expect(h.service.viewedSize(CHAIN, PROTO)).toBe(0);
    vi.setSystemTime(Date.now() + VIEW_COOLDOWN_MS);
    h.service.markViewed(CHAIN, PROTO, '7');
    expect(h.service.viewedSize(CHAIN, PROTO)).toBe(1);
  });

  it('has its own per-tick quota', async () => {
    const h = makeHarness({ cursors: { hot: recent(), all: recent() }, config: { positionFeeViewPerTick: 200 } });
    for (let i = 0; i < 250; i++) h.service.markViewed(CHAIN, PROTO, String(1000 + i));
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(r.tiers.view).toBe(200);
    expect(h.service.viewedSize(CHAIN, PROTO)).toBe(50);
  });

  it('is not limited by the dirty share, and the dirty set is not limited by it', async () => {
    const h = makeHarness({ cursors: { hot: recent(), all: recent() }, config: { positionFeeViewPerTick: 3 } });
    for (let i = 0; i < 5; i++) h.service.markViewed(CHAIN, PROTO, String(1000 + i));
    h.service.markDirty(CHAIN, ['7', '8'], PROTO);
    const r = await h.service.refreshChain(CHAIN, PROTO);
    expect(r.tiers).toMatchObject({ view: 3, dirty: 2 });
  });

  it('ignores what it cannot read: non-v4, a chain with no RPC, a non-numeric id, the quota at 0, the refresh off', () => {
    const h = makeHarness();
    h.service.markViewed(CHAIN, 'uniswap-v3', '7');
    h.service.markViewed(1, PROTO, '7');
    h.service.markViewed(CHAIN, PROTO, '0xabc');
    expect(h.service.viewedSize(CHAIN, PROTO) + h.service.viewedSize(1, PROTO)).toBe(0);
    const off = makeHarness({ config: { positionFeeViewPerTick: 0 } });
    off.service.markViewed(CHAIN, PROTO, '7');
    expect(off.service.viewedSize(CHAIN, PROTO)).toBe(0);
    const disabled = makeHarness({ config: { positionFeeRefreshEnabled: false } });
    disabled.service.markViewed(CHAIN, PROTO, '7');
    expect(disabled.service.viewedSize(CHAIN, PROTO)).toBe(0);
  });

  it('the cooldown map is bounded (oldest evicted)', () => {
    const h = makeHarness();
    const queue = () => (h.service as unknown as { viewed: Map<string, Set<string>> }).viewed.get(`${CHAIN}:${PROTO}`);
    for (let i = 0; i < VIEW_COOLDOWN_MAX + 5; i++) {
      h.service.markViewed(CHAIN, PROTO, String(i));
      // Stand-in for the drains: the queue's own cap must not be what bounds the map.
      if (queue()!.size >= 1000) queue()!.clear();
    }
    const map = (h.service as unknown as { viewCooldown: Map<string, number> }).viewCooldown;
    expect(map.size).toBe(VIEW_COOLDOWN_MAX);
    expect(map.has(`${CHAIN}:${PROTO}:0`)).toBe(false);
    expect(map.has(`${CHAIN}:${PROTO}:${VIEW_COOLDOWN_MAX + 4}`)).toBe(true);
  });

  it('what the RPC never answered goes back in', async () => {
    const h = makeHarness({ cursors: { hot: recent(), all: recent() } });
    h.client.getBlockNumber.mockRejectedValue(new Error('rpc down'));
    h.service.markViewed(CHAIN, PROTO, '7');
    await h.service.refreshChain(CHAIN, PROTO);
    expect(h.service.viewedSize(CHAIN, PROTO)).toBe(1);
  });
});

describe('LeaderboardService.getPosition queues a re-read and never waits on the RPC', () => {
  const INTEGRATION = { chainId: CHAIN, protocol: PROTO, subgraphUrl: 'https://example.com', enabled: true };
  const stored = (isActive: boolean) => ({
    chainId: CHAIN,
    protocol: PROTO,
    positionId: '3468131',
    tokenId: '3468131',
    owner: '0xowner',
    poolId: `0x${'d7'.repeat(32)}`,
    token0: { address: '0xa', symbol: 'A', decimals: 6, verified: true, priceUsd: 1 },
    token1: { address: '0xb', symbol: 'B', decimals: 18, verified: true, priceUsd: 2 },
    isActive,
    amounts: { amount0: '1', amount1: '1' },
    metrics: { underlyingValueUsd: 3, isPriceable: true, feesSource: 'onchain' },
    poolStats: {},
    pricing: { source: 'orchestrated', usedFallback: false },
    // What the stored document carries and the detail mapper must never pass
    // through (as if the read projection ever widened to include them).
    rpcFeesBlock: 900,
    rpcFeesAt: new Date('2026-10-03T00:00:00Z'),
    rpcFeesUncollected0: '1',
    rpcFeesUncollected1: '2',
    lastModifyBlock: 800,
  });
  function leaderboard(position: Record<string, unknown>, feeRefresh: unknown) {
    return new LeaderboardService(
      {
        isSupportedChain: () => true,
        isSupportedProtocol: () => true,
        getIntegration: () => INTEGRATION,
        leaderboardCountCap: 25_000,
        enabledIntegrations: [INTEGRATION],
      } as never,
      { findOneForRead: async () => position } as never,
      { findForPosition: async () => [] } as never,
      { resolve: () => ({ recomputeMode: 'aggregates', fetchPositionTransactions: async () => ({ transactions: [] }) }) } as never,
      new LeaderboardCountService(),
      undefined,
      feeRefresh as never,
    );
  }

  it('an active position is queued; the request resolves although the RPC never answers', async () => {
    const h = makeHarness();
    h.client.getBlockNumber.mockImplementation(() => new Promise(() => undefined)); // hangs forever
    const svc = leaderboard(stored(true), h.service);
    const detail = (await svc.getPosition(CHAIN, PROTO, '3468131')) as Record<string, unknown>;
    expect(h.service.viewedSize(CHAIN, PROTO)).toBe(1);
    expect(h.client.getBlockNumber).not.toHaveBeenCalled();
    expect(h.client.multicall).not.toHaveBeenCalled();
    for (const k of ['rpcFeesBlock', 'rpcFeesAt', 'rpcFeesUncollected0', 'rpcFeesUncollected1', 'lastModifyBlock']) {
      expect(detail).not.toHaveProperty(k);
    }
    // The fixture is not vacuous: the read really handed those fields over.
    expect(stored(true)).toHaveProperty('rpcFeesBlock', 900);
  });

  it('a closed position is not queued', async () => {
    const markViewed = vi.fn();
    await leaderboard(stored(false), { markViewed }).getPosition(CHAIN, PROTO, '3468131');
    expect(markViewed).not.toHaveBeenCalled();
  });

  it('calls markViewed(chainId, protocol, positionId), and a throw there never fails the read', async () => {
    const markViewed = vi.fn(() => {
      throw new Error('boom');
    });
    const svc = leaderboard(stored(true), { markViewed });
    vi.spyOn((svc as unknown as { logger: { warn: () => void } }).logger, 'warn').mockImplementation(() => {});
    await expect(svc.getPosition(CHAIN, PROTO, '3468131')).resolves.toBeDefined();
    expect(markViewed).toHaveBeenCalledWith(CHAIN, PROTO, '3468131');
  });
});
