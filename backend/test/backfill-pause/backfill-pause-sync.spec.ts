/*
 * The backfill PAUSE lever, SyncService side (audit C-pause):
 *  - a paused chain's backfill does not start (no run row, no flag write, no
 *    `fromStart` cursor reset) — the one gate every start path shares;
 *  - a pause set mid-walk is seen by the heartbeat (flush or timer) and the
 *    walk stops at its next boundary EXACTLY like an interrupted run: flag and
 *    cursor kept, run row `interrupted`, no cursor reset — in every paging
 *    mode: the createdAt offset walk, the tokenId range walk (serial and
 *    pipelined with lookahead), the completeness tail and the parallel buckets;
 *  - resuming continues from the kept cursor and the two runs together write
 *    every row;
 *  - the boot / lease resume (`interruptedBackfills`) skips a paused chain;
 *  - never paused = today (the run completes, the flag clears).
 *
 * Real EnvioAdapter on the fake indexer for the offset and tokenId walks (the
 * adapter's own stop-between-pages / ranges is what is being relied on).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeIndexer } from '../backfill/fake-indexer.js';

// Small pages / flushes so a walk has several heartbeats (read at module load).
process.env.POSITIONS_PAGE_SIZE = '100';
process.env.POSITIONS_FLUSH_THRESHOLD = '100';

let indexer = new FakeIndexer();
vi.mock('graphql-request', async () => {
  const mod = await import('../backfill/fake-indexer.js');
  return mod.graphqlRequestMock(() => indexer);
});

const { SyncService, hasBackfillPauseOps } = await import('../../src/sync/sync.service.js');
const { EnvioAdapter } = await import('../../src/subgraph/adapters/envio.adapter.js');
type NormalizedPosition = import('../../src/subgraph/normalized-position.js').NormalizedPosition;

const integration = {
  chainId: 1,
  protocol: 'uniswap-v4',
  dialect: 'hyperindex',
  enabled: true,
  subgraphUrl: 'http://envio.local/v1/graphql',
};

// ─── harness ─────────────────────────────────────────────────────────────────

type Cursor = Record<string, unknown>;

/**
 * A `sync_cursors` row with the pause lever. `pauseOnBeat = n`: the n-th
 * heartbeat of the run finds the chain paused (as if an operator paused it
 * just before) — the beat that returns the pause, like the real
 * `findOneAndUpdate`.
 */
function makeSyncRepo(state: Cursor = {}, opts: { pauseOnBeat?: number; withPauseOps?: boolean } = {}) {
  const cursor: Cursor = { chainId: 1, protocol: 'uniswap-v4', lastTimestamp: 0, lastPositionId: '', lastBlockNumber: 0, ...state };
  const calls: string[] = [];
  let beats = 0;
  const pauseState = () =>
    cursor.backfillPausedAt instanceof Date
      ? { pausedAt: cursor.backfillPausedAt as Date, pausedBy: String(cursor.backfillPausedBy ?? 'admin'), inProgress: cursor.backfillInProgress === true }
      : null;
  const repo = {
    cursor,
    calls,
    pauseOnBeat: opts.pauseOnBeat,
    beats: () => beats,
    startRun: vi.fn(async () => 'run-1'),
    getCursor: vi.fn(async () => ({ ...cursor })),
    markCursorSuccess: vi.fn(async (_c: number, _p: string, v: Cursor) => {
      calls.push(`markCursorSuccess:${v.lastTimestamp}`);
      Object.assign(cursor, v);
    }),
    markCursorFailure: vi.fn(async () => undefined),
    finishRun: vi.fn(async () => undefined),
    markBackfillStarted: vi.fn(async () => {
      calls.push('markBackfillStarted');
      cursor.backfillInProgress = true;
    }),
    markBackfillFinished: vi.fn(async () => {
      calls.push('markBackfillFinished');
      cursor.backfillInProgress = false;
    }),
    touchBackfillHeartbeat: vi.fn(async () => undefined),
    isBackfillInProgress: vi.fn(async () => false),
    resetCursorForRun: vi.fn(async () => {
      calls.push('reset');
      Object.assign(cursor, { lastTimestamp: 0, lastPositionId: '', lastBlockNumber: 0 });
      return true;
    }),
    lastBackfillStartedAt: vi.fn(async (): Promise<Date | undefined> => undefined),
    saveBackfillTokenIdState: vi.fn(async (_c: number, _p: string, s: { tokenIdCursor: string; runStartTs: number }) => {
      calls.push(`saveState:${s.tokenIdCursor}`);
      Object.assign(cursor, { backfillPaging: 'tokenid', backfillTokenIdCursor: s.tokenIdCursor, backfillRunStartTs: s.runStartTs });
    }),
    saveBackfillTokenIdCursor: vi.fn(async (_c: number, _p: string, next: string) => {
      calls.push(`cursor:${next}`);
      cursor.backfillTokenIdCursor = next;
    }),
    clearBackfillTokenIdState: vi.fn(async () => {
      calls.push('clearState');
      delete cursor.backfillPaging;
      delete cursor.backfillTokenIdCursor;
      delete cursor.backfillRunStartTs;
    }),
    setLastCleanRefreshAt: vi.fn(async () => undefined),
    // ── the pause lever ──
    backfillPauseState: vi.fn(async () => pauseState()),
    heartbeatBackfillReadPause: vi.fn(async () => {
      beats += 1;
      cursor.backfillHeartbeatAt = new Date();
      if (repo.pauseOnBeat !== undefined && beats === repo.pauseOnBeat) {
        cursor.backfillPausedAt = new Date();
        cursor.backfillPausedBy = 'admin: test';
      }
      return pauseState();
    }),
    /** What `/resume` does to the row. */
    lift: () => {
      delete cursor.backfillPausedAt;
      delete cursor.backfillPausedBy;
      repo.pauseOnBeat = undefined;
    },
  };
  if (opts.withPauseOps === false) {
    delete (repo as Record<string, unknown>).backfillPauseState;
    delete (repo as Record<string, unknown>).heartbeatBackfillReadPause;
  }
  return repo;
}

function makeService(opts: { adapter: unknown; syncRepo: ReturnType<typeof makeSyncRepo>; config?: Record<string, unknown> }) {
  const upserted: NormalizedPosition[] = [];
  const positions = {
    upsertMany: vi.fn(async (rows: NormalizedPosition[]) => {
      upserted.push(...rows);
      return rows.length;
    }),
  };
  const transactionSync = { syncTokenIdsFromPositionSync: vi.fn(), runTxBackfillBuckets: vi.fn(async () => undefined) };
  const service = new SyncService(
    {
      testMode: false,
      testModePositionLimit: 0,
      positionsBackfillBuckets: 1,
      enabledIntegrations: [integration],
      getIntegration: () => integration,
      ...opts.config,
    } as never,
    { resolve: () => opts.adapter } as never,
    positions as never,
    opts.syncRepo as never,
    { prefetchPrices: vi.fn(async () => undefined), currentNativeUsd: vi.fn(async () => 2500) } as never,
    transactionSync as never,
    { recompute: vi.fn() } as never,
  );
  return { service, positions, upserted, transactionSync };
}

function envioAdapter() {
  return new EnvioAdapter(
    {
      prefetchPrices: vi.fn(async () => undefined),
      seedLastKnown: vi.fn(async () => 0),
      pricePool: vi.fn(async () => ({ token0Usd: 1, token1Usd: 1, source: 'external', usedFallback: false, token0Confidence: 'anchor', token1Confidence: 'anchor' })),
    } as never,
    { findByIds: async () => [] } as never,
    { minRealMarketBackingUsd: 1000 } as never,
    { findRpcFees: async () => new Map() } as never,
  );
}

function rangeStats(rows: number) {
  return { pageMs: 1, dynMs: 1, tokensMs: 1, priceMs: 1, priceWaitMs: 1, priceDeadlineHit: false, feeReadMs: 0, normalizeMs: 1, rows, overflowPages: 0, unpricedClosed: new Map<string, number>(), feesMeasured: 0 };
}

const lastFinish = (repo: ReturnType<typeof makeSyncRepo>) => repo.finishRun.mock.calls.at(-1)?.[1] as Record<string, unknown> | undefined;
const ids = (rows: NormalizedPosition[]) => [...new Set(rows.map((p) => p.positionId))].sort((a, b) => Number(a) - Number(b));

/** The interrupted-run contract a pause must satisfy. */
function expectStoppedLikeInterrupted(repo: ReturnType<typeof makeSyncRepo>) {
  expect(repo.markBackfillFinished).not.toHaveBeenCalled();
  expect(repo.cursor.backfillInProgress).toBe(true);
  expect(lastFinish(repo)).toMatchObject({ status: 'interrupted', error: expect.stringContaining('paused by admin: test') });
}

// ─── the start gate ──────────────────────────────────────────────────────────

describe('a PAUSED chain does not start a backfill', () => {
  it('fromStart on a paused chain: nothing runs, the cursor is NOT reset, the flag is untouched', async () => {
    const repo = makeSyncRepo({
      backfillInProgress: true,
      lastTimestamp: 777,
      lastPositionId: '42',
      backfillPausedAt: new Date('2026-10-04T10:00:00Z'),
      backfillPausedBy: 'admin: robinhood',
    });
    const adapter = { recomputeMode: 'aggregates', fetchPositions: vi.fn() };
    const { service } = makeService({ adapter, syncRepo: repo });
    const warn = vi.spyOn((service as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn');
    const res = await service.runBackfill(integration as never, { fromStart: true, runKey: 'job-1' });
    expect(res.paused).toBe(true);
    expect(repo.startRun).not.toHaveBeenCalled();
    expect(repo.resetCursorForRun).not.toHaveBeenCalled();
    expect(repo.markBackfillStarted).not.toHaveBeenCalled();
    expect(adapter.fetchPositions).not.toHaveBeenCalled();
    expect(repo.cursor).toMatchObject({ lastTimestamp: 777, lastPositionId: '42', backfillInProgress: true });
    expect(warn.mock.calls.some(([m]) => /PAUSED .*fromStart reset was NOT applied/.test(String(m)))).toBe(true);
  });

  it('a repository without the lever runs as today (the heartbeat stays touchBackfillHeartbeat)', async () => {
    indexer = new FakeIndexer();
    indexer.positions = Array.from({ length: 150 }, (_, i) => ({ tokenId: i + 1, createdAt: 1_000 + i }));
    const repo = makeSyncRepo({}, { withPauseOps: false });
    expect(hasBackfillPauseOps(repo)).toBe(false);
    const { service, upserted } = makeService({ adapter: envioAdapter(), syncRepo: repo });
    const res = await service.runBackfill(integration as never);
    expect(res.paused).toBeUndefined();
    expect(ids(upserted)).toHaveLength(150);
    expect(repo.touchBackfillHeartbeat).toHaveBeenCalled();
    expect(repo.markBackfillFinished).toHaveBeenCalled();
  });
});

// ─── the createdAt offset walk ───────────────────────────────────────────────

describe('offset walk (BACKFILL_PAGING=offset, the default)', () => {
  beforeEach(() => {
    indexer = new FakeIndexer();
    indexer.positions = Array.from({ length: 500 }, (_, i) => ({ tokenId: i + 1, createdAt: 1_000 + i }));
  });

  it('never paused = today: one run walks everything and clears the flag', async () => {
    const repo = makeSyncRepo();
    const { service, upserted } = makeService({ adapter: envioAdapter(), syncRepo: repo });
    const res = await service.runBackfill(integration as never);
    expect(res.paused).toBeUndefined();
    expect(ids(upserted)).toHaveLength(500);
    expect(repo.heartbeatBackfillReadPause).toHaveBeenCalled(); // the heartbeat now carries the check
    expect(repo.touchBackfillHeartbeat).not.toHaveBeenCalled();
    expect(repo.markBackfillFinished).toHaveBeenCalledTimes(1);
    expect(lastFinish(repo)).toMatchObject({ status: 'success' });
    expect(repo.cursor).toMatchObject({ lastTimestamp: 1_499, backfillInProgress: false });
  });

  it('paused mid-walk: stops before the next page, cursor = the last flush, then resume continues from it', async () => {
    const repo = makeSyncRepo({}, { pauseOnBeat: 2 });
    const { service, upserted } = makeService({ adapter: envioAdapter(), syncRepo: repo });
    const first = await service.runBackfill(integration as never);

    expect(first.paused).toBe(true);
    // two pages flushed, the third never fetched
    expect(ids(upserted)).toHaveLength(200);
    expect(indexer.count('Positions')).toBe(2);
    expectStoppedLikeInterrupted(repo);
    expect(repo.cursor).toMatchObject({ lastTimestamp: 1_199, lastPositionId: '200' });
    expect(repo.resetCursorForRun).not.toHaveBeenCalled();

    // While paused, nothing restarts it.
    const blocked = await service.runBackfill(integration as never);
    expect(blocked.paused).toBe(true);
    expect(repo.startRun).toHaveBeenCalledTimes(1);

    // Resume: from the kept cursor, every row once across both runs.
    repo.lift();
    upserted.length = 0;
    const second = await service.runBackfill(integration as never);
    expect(second.paused).toBeUndefined();
    expect(ids(upserted)).toEqual(Array.from({ length: 300 }, (_, i) => String(i + 201)));
    expect(repo.markBackfillFinished).toHaveBeenCalledTimes(1);
    expect(repo.cursor).toMatchObject({ lastTimestamp: 1_499, lastPositionId: '500', backfillInProgress: false });
  });

  it('the heartbeat TIMER trips the pause too (between flushes)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const repo = makeSyncRepo();
      // Pause as soon as the timer beats (the first beat), before any flush.
      const adapter = {
        recomputeMode: 'aggregates',
        fetchPositions: vi.fn(async (o: { signal?: AbortSignal; onFlush: (p: NormalizedPosition[], c: unknown) => Promise<number> }) => {
          repo.pauseOnBeat = 1;
          await vi.advanceTimersByTimeAsync(2 * 60_000);
          for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
          return { positions: [], seenPositionIds: [], maxTimestamp: 0, maxPositionId: '', maxBlockNumber: 0, hasMore: o.signal?.aborted === true, flushedCount: 0 };
        }),
      };
      const { service } = makeService({ adapter, syncRepo: repo });
      const res = await service.runBackfill(integration as never);
      expect(repo.beats()).toBeGreaterThanOrEqual(1);
      expect(res.paused).toBe(true);
      expect(repo.markCursorSuccess).not.toHaveBeenCalled(); // nothing residual: the cursor is not touched
      expectStoppedLikeInterrupted(repo);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a walk that ENDS on the flush that saw the pause is complete, not paused', async () => {
    const repo = makeSyncRepo({}, { pauseOnBeat: 1 });
    const adapter = {
      recomputeMode: 'aggregates',
      fetchPositions: vi.fn(async (o: { onFlush: (p: NormalizedPosition[], c: unknown) => Promise<number> }) => {
        await o.onFlush([{ positionId: '1', createdAtTimestamp: 5, isActive: true } as NormalizedPosition], { maxTimestamp: 5, maxPositionId: '1', maxBlockNumber: 1 });
        return { positions: [], seenPositionIds: [], maxTimestamp: 5, maxPositionId: '1', maxBlockNumber: 1, hasMore: false, flushedCount: 1 };
      }),
    };
    const { service } = makeService({ adapter, syncRepo: repo });
    const res = await service.runBackfill(integration as never);
    expect(res.paused).toBeUndefined();
    expect(repo.markBackfillFinished).toHaveBeenCalled();
    expect(lastFinish(repo)).toMatchObject({ status: 'success' });
  });
});

// ─── the tokenId range walk ──────────────────────────────────────────────────

describe.each([
  ['serial', { backfillPipeline: 'off', backfillLookaheadPages: 0 }],
  ['pipelined, lookahead 2', { backfillPipeline: 'on', backfillLookaheadPages: 2 }],
])('tokenId range walk (%s)', (_label, pipeline) => {
  beforeEach(() => {
    indexer = new FakeIndexer();
    // 5 ranges of 999 ids; createdAt far in the past so the completeness tail is empty.
    indexer.positions = Array.from({ length: 50 }, (_, i) => ({ tokenId: i * 100, createdAt: 1_000 + i }));
  });

  const config = { backfillPaging: 'tokenid', ...pipeline };

  it('paused mid-walk: the tokenId cursor is the last WRITTEN range, nothing finished; resume completes the walk', async () => {
    const repo = makeSyncRepo({}, { pauseOnBeat: 2 });
    const { service, upserted } = makeService({ adapter: envioAdapter(), syncRepo: repo, config });
    const first = await service.runBackfill(integration as never, { fromStart: true, runKey: 'tid-1' });

    expect(first.paused).toBe(true);
    expectStoppedLikeInterrupted(repo);
    // two ranges written; ranges prepared ahead (lookahead) were dropped, never written
    expect(repo.cursor.backfillTokenIdCursor).toBe('1998');
    expect(ids(upserted)).toEqual(Array.from({ length: 20 }, (_, i) => String(i * 100)));
    // during the walk only the tokenId state moves: no createdAt cursor, no clear
    expect(repo.markCursorSuccess).not.toHaveBeenCalled();
    expect(repo.clearBackfillTokenIdState).not.toHaveBeenCalled();
    expect(indexer.count('Positions')).toBe(0); // the tail never ran

    repo.lift();
    upserted.length = 0;
    const second = await service.runBackfill(integration as never);
    expect(second.paused).toBeUndefined();
    // resumed from the kept cursor (no reset: the job is not fromStart and the state says resume)
    expect(repo.resetCursorForRun).toHaveBeenCalledTimes(1);
    expect(ids(upserted)).toEqual(Array.from({ length: 30 }, (_, i) => String((i + 20) * 100)));
    expect(repo.cursor).toMatchObject({ backfillInProgress: false, lastPositionId: '4900' });
    expect(repo.cursor).not.toHaveProperty('backfillTokenIdCursor');
    expect(lastFinish(repo)).toMatchObject({ status: 'success' });
  });
});

describe('the completeness tail', () => {
  it('paused in the tail: tokenId state + flag kept, the resume re-runs the tail', async () => {
    const repo = makeSyncRepo({}, { pauseOnBeat: 2 });
    const tailRows = [{ positionId: '9', createdAtTimestamp: 9, isActive: true } as NormalizedPosition];
    const adapter = {
      recomputeMode: 'aggregates',
      findFirstTokenIdCreatedSince: vi.fn(async () => '0'),
      walkTokenIdRanges: vi.fn(async (o: Record<string, any>) => {
        await o.onRange([{ positionId: '1', createdAtTimestamp: 1, isActive: true }], { from: '0', to: '999', index: 0 }, rangeStats(1));
        await o.onCursor('999');
        return { nextTokenId: '999', completed: true, aborted: false, ranges: 1, rows: 1, written: 1, maxTimestamp: 1, maxPositionId: '1', maxBlockNumber: 1 };
      }),
      fetchPositions: vi.fn(async (o: { signal?: AbortSignal; onFlush: (p: NormalizedPosition[], c: unknown) => Promise<number> }) => {
        await o.onFlush(tailRows, { maxTimestamp: 9, maxPositionId: '9', maxBlockNumber: 1 });
        return { positions: [], seenPositionIds: [], maxTimestamp: 9, maxPositionId: '9', maxBlockNumber: 1, hasMore: o.signal?.aborted === true, flushedCount: 1 };
      }),
    };
    const { service } = makeService({ adapter, syncRepo: repo, config: { backfillPaging: 'tokenid' } });
    const res = await service.runBackfill(integration as never, { fromStart: true, runKey: 'tail-1' });
    expect(res.paused).toBe(true);
    expect((adapter.fetchPositions.mock.calls[0]?.[0] as { signal?: AbortSignal }).signal?.aborted).toBe(true);
    expectStoppedLikeInterrupted(repo);
    expect(repo.markCursorSuccess).not.toHaveBeenCalled();
    expect(repo.cursor.backfillTokenIdCursor).toBe('999');
  });
});

// ─── parallel buckets ────────────────────────────────────────────────────────

describe('parallel buckets (fresh fromStart, POSITIONS_BACKFILL_BUCKETS > 1)', () => {
  it('paused: no cursor written over the reset, flag kept, no bulk tx walk; the resume walks serially', async () => {
    const repo = makeSyncRepo({ lastTimestamp: 5_000, lastPositionId: '77' }, { pauseOnBeat: 1 });
    const adapter = {
      recomputeMode: 'aggregates',
      fetchPositionTimestampRange: vi.fn(async () => ({ minTimestamp: 1, maxTimestamp: 100 })),
      fetchPositions: vi.fn(async (o: { signal?: AbortSignal; onFlush: (p: NormalizedPosition[], c: unknown) => Promise<number>; cursorTimestamp: number }) => {
        const row = { positionId: String(o.cursorTimestamp + 1), createdAtTimestamp: o.cursorTimestamp + 1, isActive: true } as NormalizedPosition;
        await o.onFlush([row], { maxTimestamp: row.createdAtTimestamp, maxPositionId: row.positionId, maxBlockNumber: 1 });
        await Promise.resolve();
        return { positions: [], seenPositionIds: [], maxTimestamp: row.createdAtTimestamp, maxPositionId: row.positionId, maxBlockNumber: 1, hasMore: o.signal?.aborted === true, flushedCount: 1 };
      }),
    };
    const { service, transactionSync } = makeService({ adapter, syncRepo: repo, config: { positionsBackfillBuckets: 2 } });
    const res = await service.runBackfill(integration as never, { fromStart: true, runKey: 'b-1' });
    expect(res.paused).toBe(true);
    expect(repo.resetCursorForRun).toHaveBeenCalledTimes(1);
    expect(repo.markCursorSuccess).not.toHaveBeenCalled(); // the cursor stays where the fresh run reset it
    expect(repo.cursor).toMatchObject({ lastTimestamp: 0, lastPositionId: '' });
    expect(transactionSync.runTxBackfillBuckets).not.toHaveBeenCalled();
    expectStoppedLikeInterrupted(repo);

    // Not paused = today: the bucketed run finishes and runs the bulk tx walk.
    const ok = makeSyncRepo();
    const { service: s2, transactionSync: tx2 } = makeService({ adapter, syncRepo: ok, config: { positionsBackfillBuckets: 2 } });
    const done = await s2.runBackfill(integration as never, { fromStart: true, runKey: 'b-2' });
    expect(done.paused).toBeUndefined();
    expect(ok.markBackfillFinished).toHaveBeenCalled();
    expect(tx2.runTxBackfillBuckets).toHaveBeenCalled();
  });
});

// ─── boot / lease resume ─────────────────────────────────────────────────────

describe('interruptedBackfills (the boot and lease-acquisition resume) skips a paused chain', () => {
  it('flagged + paused → skipped (logged); flagged + not paused → resumed', async () => {
    const other = { ...integration, chainId: 4663 };
    const rows: Record<number, Cursor> = {
      1: { backfillInProgress: true, backfillPausedAt: new Date('2026-10-04T10:00:00Z'), backfillPausedBy: 'admin' },
      4663: { backfillInProgress: true },
    };
    const repo = makeSyncRepo();
    repo.getCursor.mockImplementation(async (chainId: number) => ({ ...rows[chainId] }) as never);
    const { service } = makeService({ adapter: {}, syncRepo: repo, config: { enabledIntegrations: [integration, other] } });
    const log = vi.spyOn((service as unknown as { logger: { log: (m: string) => void } }).logger, 'log');
    const out = await service.interruptedBackfills();
    expect(out.map((i) => i.chainId)).toEqual([4663]);
    expect(log.mock.calls.some(([m]) => String(m).includes('Backfill resume skipped: 1:uniswap-v4 is PAUSED'))).toBe(true);

    // lifted → resumed again
    delete rows[1]!.backfillPausedAt;
    expect((await service.interruptedBackfills()).map((i) => i.chainId)).toEqual([1, 4663]);
  });
});
