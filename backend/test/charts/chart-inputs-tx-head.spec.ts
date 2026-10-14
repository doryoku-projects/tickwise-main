/*
 * Detail and charts no longer wait on the serial transaction walk (scale plan
 * 1.7, full plan 1.5).
 *
 * The list is read NEWEST first. A short history is complete from that one page;
 * a long one is served its newest page while the full oldest-first walk runs in
 * the background on the `refresh` lane and fills the cache. An interactive
 * request waits for a transaction list at most `TX_WAIT_MS` — its own load or
 * one it JOINED — and the joined wait is reported apart from indexer time.
 *
 * Fixture '1003' is the busy position: 2,346 transactions in runs of four equal
 * timestamps, so the 1000-row newest page ends INSIDE a run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TX_WAIT_MS, TX_WALK_CONCURRENCY } from '../../src/charts/chart-inputs.service.js';
import {
  currentIndexerContext,
  indexerSummary,
  runInLane,
  serverTimingValue,
  type IndexerContext,
} from '../../src/subgraph/hyperindex/indexer-context.js';
import { isDegradedPayload } from '../../src/v1/metering.interceptor.js';
import { CHAIN, NOW_MS, PROTO } from './chart-fixtures.js';
import type { FakeCall, FakeTx } from './fake-subgraph.js';
import { makeWorld, rootCount } from './world.js';

const HOUR = 3_600_000;
/** The adapter's ascending walk document (the head is `TxnsNewest` or the combined `tx` root). */
const isWalk = (call: FakeCall) => call.query.includes('query Txns(');

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function interactive(deadlineInMs = 8_000): IndexerContext {
  return {
    lane: 'interactive',
    job: '/api/top-positions/:id/uniswap-v4/:id',
    deadlineAt: Date.now() + deadlineInMs,
    stats: { indexerMs: 0, indexerCalls: 0, queuedMs: 0, joinedMs: 0, joins: 0 },
  };
}

interface Detail {
  transactions: Array<{ transactionId: string; timestamp: number }>;
  transactionsDegraded: boolean;
  transactionsPartial?: true;
}

/** A world whose full walks are held until `walkGate.release()`. */
function heldWorld(options: { txWaitMs?: number } = {}) {
  const walkGate = deferred();
  const lanes: Array<{ walk: boolean; skip: unknown; lane: string; job?: string }> = [];
  const w = makeWorld({
    txWaitMs: options.txWaitMs ?? 100,
    subgraph: {
      onCall: (call) =>
        lanes.push({ walk: isWalk(call), skip: call.variables.skip, lane: currentIndexerContext().lane, job: currentIndexerContext().job }),
      delay: (call) => (isWalk(call) ? walkGate.promise : undefined),
    },
  });
  return { w, walkGate, lanes };
}

/** The busy position's rows, as the indexer's newest-first page returns them (timestamp desc, id asc). */
function newestPageIds(rows: FakeTx[], tokenId: string, size = 1000): Set<string> {
  const mine = rows.filter((r) => r.tokenId === tokenId);
  const id = (r: FakeTx) => `${r.txHash}-${r.logIndex.padStart(6, '0')}`;
  mine.sort((a, b) => Number(b.timestamp) - Number(a.timestamp) || id(a).localeCompare(id(b)));
  return new Set(mine.slice(0, size).map((r) => `${r.txHash.toLowerCase()}-${Number(r.logIndex)}-${r.type}`));
}

const settle = () => new Promise((r) => setTimeout(r, 10));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW_MS);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('the constants the plan fixed', () => {
  it('waits 1.5 s for a transaction list and runs at most 4 background walks', () => {
    expect(TX_WAIT_MS).toBe(1_500);
    expect(TX_WALK_CONCURRENCY).toBe(4);
  });
});

describe('a short history is complete from its newest page', () => {
  it('one newest-first read, no walk, and the same list (order and ties included) the ascending walk returns', async () => {
    const w = makeWorld();
    const detail = (await runInLane(interactive(), () => w.leaderboard.getPosition(CHAIN, PROTO, '1001'))) as unknown as Detail;
    expect(w.fake.calls).toHaveLength(1);
    expect(w.fake.calls[0]!.query).toContain('orderDirection: desc');
    expect(detail.transactionsDegraded).toBe(false);
    expect('transactionsPartial' in detail).toBe(false);
    const full = await w.adapter.fetchPositionTransactions!({
      integration: w.integration as never,
      positionIds: ['1001'],
      cursorTimestamp: 0,
      pageSize: 1000,
      maxPages: 100,
    });
    expect(detail.transactions.map((t) => t.transactionId)).toEqual(full.transactions.map((t) => t.transactionId));
  });

  it('read through the charts’ combined document, it is put back in the same order', async () => {
    const w = makeWorld();
    await runInLane(interactive(), () => w.charts.getPositionCharts(CHAIN, PROTO, '1001', 'all'));
    // Detail is served from the entry the charts' `tx` root stored.
    const detail = (await runInLane(interactive(), () => w.leaderboard.getPosition(CHAIN, PROTO, '1001'))) as unknown as Detail;
    expect(rootCount(w.fake.calls, 'positionTransactions')).toBe(1);
    const full = await w.adapter.fetchPositionTransactions!({
      integration: w.integration as never,
      positionIds: ['1001'],
      cursorTimestamp: 0,
      pageSize: 1000,
      maxPages: 100,
    });
    expect(detail.transactions.map((t) => t.transactionId)).toEqual(full.transactions.map((t) => t.transactionId));
  });
});

describe('position detail on a busy position', () => {
  it('answers by TX_WAIT_MS with the newest page, flagged, while the walk fills the cache on the refresh lane', async () => {
    const { w, walkGate, lanes } = heldWorld();
    const ctx = interactive();
    const startedAt = performance.now();
    const detail = (await runInLane(ctx, () => w.leaderboard.getPosition(CHAIN, PROTO, '1003'))) as unknown as Detail;
    const tookMs = performance.now() - startedAt;

    // Not the 8 s request deadline: the 100 ms transaction wait of this world.
    expect(tookMs).toBeLessThan(1_000);
    expect(detail.transactions).toHaveLength(1000);
    expect(detail.transactionsPartial).toBe(true);
    // Degraded too: it is not the history, and every client and the /v1
    // refund already key on that flag.
    expect(detail.transactionsDegraded).toBe(true);
    expect(isDegradedPayload(detail)).toBe(true);
    expect(isDegradedPayload({ transactionsPartial: true })).toBe(true);
    // The NEWEST thousand, put back oldest first.
    expect(new Set(detail.transactions.map((t) => t.transactionId))).toEqual(
      newestPageIds(w.fixture.data.positionTransactions, '1003'),
    );
    const stamps = detail.transactions.map((t) => t.timestamp);
    expect(stamps).toEqual([...stamps].sort((a, b) => a - b));
    // Logged as late-but-loading, never as an outage.
    expect(w.log.some((line) => line.includes('positions.tx_partial') && line.includes('rows=1000'))).toBe(true);
    expect(w.warn.some((line) => line.includes('[alert]'))).toBe(false);
    // The head was read in the request's own lane; the walk below every user.
    expect(lanes[0]).toMatchObject({ walk: false, lane: 'interactive' });
    expect(lanes.filter((l) => l.walk)).toEqual([{ walk: true, skip: 0, lane: 'refresh', job: 'chart-inputs-tx-walk' }]);

    walkGate.release();
    await settle();
    // The head is published only while its walk runs.
    expect((w.inputs as unknown as { txHeads: Map<string, unknown> }).txHeads.size).toBe(0);
    const callsBefore = w.fake.calls.length;
    const reopened = (await runInLane(interactive(), () => w.leaderboard.getPosition(CHAIN, PROTO, '1003'))) as unknown as Detail;
    expect(reopened.transactions).toHaveLength(2346);
    expect(reopened.transactionsDegraded).toBe(false);
    expect('transactionsPartial' in reopened).toBe(false);
    expect(isDegradedPayload(reopened)).toBe(false);
    // From the cache the walk filled.
    expect(w.fake.calls.length).toBe(callsBefore);
  });

  it('a newest page that is not back by the wait degrades to no list, as before', async () => {
    const gate = deferred();
    const w = makeWorld({ txWaitMs: 50, subgraph: { delay: () => gate.promise } });
    const detail = (await runInLane(interactive(), () => w.leaderboard.getPosition(CHAIN, PROTO, '1003'))) as unknown as Detail;
    gate.release();
    expect(detail.transactions).toEqual([]);
    expect(detail.transactionsDegraded).toBe(true);
    expect('transactionsPartial' in detail).toBe(false);
    expect(w.log.some((line) => line.includes('positions.tx_fetch_late'))).toBe(true);
  });

  it('a walk that FAILS behind its head serves the head, alerts once, and stores nothing', async () => {
    let failWalk = true;
    const w = makeWorld({
      txWaitMs: 2_000,
      // Not a retriable error: the refresh lane would retry a statement timeout.
      subgraph: { fail: (call) => (failWalk && isWalk(call) ? new Error('boom') : undefined) },
    });
    // The walk fails well inside the wait: the load's VALUE is the head.
    const detail = (await runInLane(interactive(), () => w.leaderboard.getPosition(CHAIN, PROTO, '1003'))) as unknown as Detail;
    expect(detail.transactions).toHaveLength(1000);
    expect(detail.transactionsPartial).toBe(true);
    expect(w.inputsWarn.filter((line) => line.includes('[alert] chart_inputs.tx_walk_failed'))).toHaveLength(1);
    // Not cached as the history: the next open reads again and, the indexer
    // healthy, gets all of it.
    failWalk = false;
    const again = (await runInLane(interactive(), () => w.leaderboard.getPosition(CHAIN, PROTO, '1003'))) as unknown as Detail;
    expect(again.transactions).toHaveLength(2346);
    expect('transactionsPartial' in again).toBe(false);
  });
});

describe('a request that JOINS a running walk', () => {
  it('waits for it at most TX_WAIT_MS, then gets the newest page; the wait is reported as joined, not as indexer time', async () => {
    const { w, walkGate } = heldWorld({ txWaitMs: 150 });
    // A starts the load and is answered with the head.
    await runInLane(interactive(), () => w.leaderboard.getPosition(CHAIN, PROTO, '1003'));
    // B arrives while the walk is still running: it joins and makes no call.
    const callsBefore = w.fake.calls.length;
    const ctx = interactive();
    const startedAt = performance.now();
    const joined = (await runInLane(ctx, () => w.leaderboard.getPosition(CHAIN, PROTO, '1003'))) as unknown as Detail;
    const tookMs = performance.now() - startedAt;
    walkGate.release();

    expect(tookMs).toBeLessThan(1_000);
    expect(joined.transactions).toHaveLength(1000);
    expect(joined.transactionsPartial).toBe(true);
    expect(w.fake.calls.length).toBe(callsBefore);
    expect(ctx.stats!.joins).toBe(1);
    expect(ctx.stats!.joinedMs).toBeGreaterThanOrEqual(100);
    expect(ctx.stats!.joinedMs).toBeLessThan(1_000);
    expect(serverTimingValue(ctx, 0, 1_000)).toMatch(/indexer-join;dur=\d+;desc="1 joined"/);
    expect(indexerSummary(ctx)).toMatch(/^indexer=0ms calls=0 joined=\d+ms\/1$/);
  });

  it('charts joining detail’s walk are answered without the series instead of waiting it out', async () => {
    const { w, walkGate } = heldWorld();
    await runInLane(interactive(), () => w.leaderboard.getPosition(CHAIN, PROTO, '1003'));
    const ctx = interactive();
    const startedAt = performance.now();
    const charts = await runInLane(ctx, () => w.charts.getPositionCharts(CHAIN, PROTO, '1003', 'all'));
    expect(performance.now() - startedAt).toBeLessThan(1_000);
    walkGate.release();
    expect(ctx.stats!.joins).toBe(1);
    // A series cannot start from the middle of a history.
    expect(charts.positionSeries).toBeNull();
    expect(charts.partial).toBe(true);
    expect(charts.missing).toEqual(['transactions']);
    expect(charts.poolPrice.length).toBeGreaterThan(0);
    expect(isDegradedPayload(charts)).toBe(true);

    await settle();
    const complete = await runInLane(interactive(), () => w.charts.getPositionCharts(CHAIN, PROTO, '1003', 'all'));
    expect(complete.partial).toBeUndefined();
    expect(complete.positionSeries).not.toBeNull();
  });

  it('a request that started its own loads records no join', async () => {
    const w = makeWorld();
    const ctx = interactive();
    await runInLane(ctx, () => w.charts.getPositionCharts(CHAIN, PROTO, '1001', 'all'));
    expect(ctx.stats!.joins).toBe(0);
    expect(serverTimingValue(ctx, 0, 1_000)).not.toContain('indexer-join');
  });
});

describe('charts on a busy position, cold', () => {
  it('the newest page rides in the combined document; the series waits for the full walk', async () => {
    const { w, walkGate } = heldWorld();
    const charts = await runInLane(interactive(), () => w.charts.getPositionCharts(CHAIN, PROTO, '1003', 'all'));
    expect(w.fake.calls[0]!.query).toContain('orderDirection: desc');
    expect(charts.missing).toEqual(['transactions']);
    expect(charts.positionSeries).toBeNull();
    expect(charts.liquidityDistribution.ticks.length).toBeGreaterThan(0);
    walkGate.release();
    await settle();
    // One walk, three pages; the reopen costs nothing.
    expect(w.fake.calls.filter(isWalk).map((c) => c.variables.skip)).toEqual([0, 1000, 2000]);
    const callsBefore = w.fake.calls.length;
    const warm = await runInLane(interactive(), () => w.charts.getPositionCharts(CHAIN, PROTO, '1003', 'all'));
    expect(warm.partial).toBeUndefined();
    expect(w.fake.calls.length).toBe(callsBefore);
  });
});

describe('the transaction list is kept a day', () => {
  it('a reopen 19 h later is a cache hit; a moved position is read again at once', async () => {
    const w = makeWorld();
    await w.leaderboard.getPosition(CHAIN, PROTO, '1001');
    expect(rootCount(w.fake.calls, 'positionTransactions')).toBe(1);
    // Fresh for 24 h ± 20%: 19 h is inside it on any jitter. (At the old
    // 30-minute TTL the entry was gone, retention included, after ~2.4 h.)
    vi.setSystemTime(NOW_MS + 19 * HOUR);
    await w.leaderboard.getPosition(CHAIN, PROTO, '1001');
    await settle();
    expect(rootCount(w.fake.calls, 'positionTransactions')).toBe(1);
    // The fingerprint, not the TTL, is what follows a change.
    w.fixture.positions['1001']!.amounts.withdrawnToken0 = '1';
    await w.leaderboard.getPosition(CHAIN, PROTO, '1001');
    expect(rootCount(w.fake.calls, 'positionTransactions')).toBe(2);
  });

  it('day data and live state keep their own TTLs (60 s ticks, 10 min day data), not the 45 s list budget; transactions keep their day', async () => {
    const w = makeWorld();
    await w.charts.getPositionCharts(CHAIN, PROTO, '1001', 'all');
    const roots = () => w.fake.calls.slice(1).flatMap((call) => call.roots);
    // 40 s: past the lists' 15 s fresh age, but every chart input is still fresh.
    vi.setSystemTime(NOW_MS + 40_000);
    await w.charts.getPositionCharts(CHAIN, PROTO, '1001', 'all');
    await settle();
    expect(roots()).toEqual([]);
    // 90 s: ticks (60 s) are stale and revalidate in the background; day data (10 min) is not.
    vi.setSystemTime(NOW_MS + 90_000);
    await w.charts.getPositionCharts(CHAIN, PROTO, '1001', 'all');
    await settle();
    expect(roots()).toContain('ticks');
    expect(roots()).not.toContain('poolDayDatas');
    expect(roots()).not.toContain('positionTransactions');
  });
});

describe('background walks are capped', () => {
  it(`at most ${TX_WALK_CONCURRENCY} run at once; the rest queue and still complete`, async () => {
    const { w, walkGate } = heldWorld();
    // Six more busy positions: copies of '1003' under new ids.
    const busy = ['2001', '2002', '2003', '2004', '2005', '2006'];
    const source = w.fixture.data.positionTransactions.filter((r) => r.tokenId === '1003');
    for (const id of busy) {
      w.fixture.positions[id] = { ...structuredClone(w.fixture.positions['1003']!), positionId: id, tokenId: id };
      w.fixture.data.positionTransactions.push(...source.map((r) => ({ ...r, tokenId: id, txHash: `${r.txHash}${id}` })));
    }
    // Outside a request: each detail waits for its full list.
    const opened = busy.map((id) => w.leaderboard.getPosition(CHAIN, PROTO, id));
    await settle();
    expect(w.fake.calls.filter((c) => isWalk(c) && c.variables.skip === 0)).toHaveLength(TX_WALK_CONCURRENCY);
    walkGate.release();
    const details = (await Promise.all(opened)) as unknown as Detail[];
    expect(details.every((d) => d.transactions.length === 2346 && d.transactionsDegraded === false)).toBe(true);
    expect(w.fake.calls.filter((c) => isWalk(c) && c.variables.skip === 0)).toHaveLength(busy.length);
  });
});
