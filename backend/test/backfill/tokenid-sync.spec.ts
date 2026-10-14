/*
 * SyncService's side of the tokenId backfill (design §6.2-1, §2.1, §4.6):
 *  - which runs take the tokenId walk (fresh / resume / convert / none);
 *  - during the walk ONLY the tokenId state moves; the createdAt cursor is
 *    written at run END = max over start, walk and the completeness tail, whose
 *    start is runStart − 1 h;
 *  - a shutdown leaves the flag and the tokenId state (run `interrupted`);
 *  - END TO END on the fake indexer: a position created during the walk at a
 *    tokenId the walk had already passed is caught by the tail, so the tokenId
 *    run ends with exactly the offset walk's set of rows;
 *  - fleet flow locks: `heldElsewhere`, nothing runs;
 *  - `lastCleanRefreshAt` only when the stale sweep RAN, stamped with the
 *    refresh's START;
 *  - P3.1: rows carrying a fresh reading are not queued for the fee job again.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeIndexer } from './fake-indexer.js';

let indexer = new FakeIndexer();
vi.mock('graphql-request', async () => {
  const mod = await import('./fake-indexer.js');
  return mod.graphqlRequestMock(() => indexer);
});

const { SyncService, planTokenIdBackfill, TOKENID_TAIL_LOOKBACK_SEC, flowLockName } = await import('../../src/sync/sync.service.js');
const { registerProcessWriteBudget } = await import('../../src/common/write-budget.js');
const { backfillProfiles } = await import('../../src/sync/backfill-profile.js');
const { EnvioAdapter } = await import('../../src/subgraph/adapters/envio.adapter.js');
type NormalizedPosition = import('../../src/subgraph/normalized-position.js').NormalizedPosition;

const integration = {
  chainId: 1,
  protocol: 'uniswap-v4',
  dialect: 'hyperindex',
  enabled: true,
  subgraphUrl: 'http://envio.local/v1/graphql',
};

describe('planTokenIdBackfill', () => {
  const base = { supported: true, latestOnly: false, freshFromStart: false, nowSec: 5_000 };
  it('a fresh fromStart walks the whole chain from 0, starting now', () => {
    expect(planTokenIdBackfill({ ...base, freshFromStart: true, prior: null })).toEqual({ kind: 'fresh', from: '0', runStartTs: 5_000 });
  });
  it('an in-progress tokenId run resumes from its cursor and KEEPS its run start', () => {
    expect(
      planTokenIdBackfill({
        ...base,
        prior: { backfillInProgress: true, backfillPaging: 'tokenid', backfillTokenIdCursor: '1998', backfillRunStartTs: 1_234 },
      }),
    ).toEqual({ kind: 'resume', from: '1998', runStartTs: 1_234 });
  });
  it('a tokenId state without its run start is damaged → a full re-walk, never a late tail', () => {
    expect(
      planTokenIdBackfill({ ...base, prior: { backfillInProgress: true, backfillPaging: 'tokenid', backfillTokenIdCursor: '1998' } }),
    ).toEqual({ kind: 'fresh', from: '0', runStartTs: 5_000 });
  });
  it('an interrupted OFFSET run is converted at its createdAt cursor', () => {
    expect(planTokenIdBackfill({ ...base, prior: { backfillInProgress: true, lastTimestamp: 777 } })).toEqual({
      kind: 'convert',
      sinceTs: 777,
      runStartTs: 5_000,
    });
  });
  it('an interrupted run that never flushed is fresh', () => {
    expect(planTokenIdBackfill({ ...base, prior: { backfillInProgress: true, lastTimestamp: 0 } })?.kind).toBe('fresh');
  });
  it('an incremental run (no run in progress), test mode, or no support → today’s offset walk', () => {
    expect(planTokenIdBackfill({ ...base, prior: { backfillInProgress: false, lastTimestamp: 777 } })).toBeNull();
    expect(planTokenIdBackfill({ ...base, prior: null })).toBeNull();
    expect(planTokenIdBackfill({ ...base, latestOnly: true, freshFromStart: true, prior: null })).toBeNull();
    expect(planTokenIdBackfill({ ...base, supported: false, freshFromStart: true, prior: null })).toBeNull();
  });
});

// ─── harness ─────────────────────────────────────────────────────────────────

function cursorRow(over: Record<string, unknown> = {}) {
  return { chainId: 1, protocol: 'uniswap-v4', lastTimestamp: 0, lastPositionId: '', lastBlockNumber: 0, ...over };
}

function makeSyncRepo(state: Record<string, unknown> = {}) {
  const cursor = cursorRow(state);
  const calls: string[] = [];
  const repo = {
    cursor,
    calls,
    startRun: vi.fn(async () => 'run-1'),
    getCursor: vi.fn(async () => ({ ...cursor })),
    markCursorSuccess: vi.fn(async (_c: number, _p: string, v: { lastTimestamp: number; lastPositionId: string; lastBlockNumber: number }) => {
      calls.push('markCursorSuccess');
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
      delete (cursor as Record<string, unknown>).backfillPaging;
      delete (cursor as Record<string, unknown>).backfillTokenIdCursor;
      delete (cursor as Record<string, unknown>).backfillRunStartTs;
    }),
    setLastCleanRefreshAt: vi.fn(async () => undefined),
  };
  return repo;
}

function makeService(opts: {
  adapter: Record<string, unknown>;
  syncRepo?: ReturnType<typeof makeSyncRepo>;
  config?: Record<string, unknown>;
  flowLocks?: unknown;
  feeRefresh?: unknown;
  positions?: Record<string, unknown>;
}) {
  const upserted: NormalizedPosition[] = [];
  const positions = {
    upsertMany: vi.fn(async (rows: NormalizedPosition[]) => {
      upserted.push(...rows);
      return rows.length;
    }),
    findActiveRefsWithTokensPage: vi.fn(async () => []),
    findHotClosedCandidatesPage: vi.fn(async () => []),
    markMissingStale: vi.fn(async () => 0),
    ...opts.positions,
  };
  const syncRepo = opts.syncRepo ?? makeSyncRepo();
  const service = new SyncService(
    {
      testMode: false,
      testModePositionLimit: 0,
      positionsBackfillBuckets: 1,
      enabledIntegrations: [integration],
      getIntegration: () => integration,
      backfillPaging: 'tokenid',
      ...opts.config,
    } as never,
    { resolve: () => opts.adapter } as never,
    positions as never,
    syncRepo as never,
    { prefetchPrices: vi.fn(async () => undefined), currentNativeUsd: vi.fn(async () => 2500) } as never,
    { syncTokenIdsFromPositionSync: vi.fn(), repriceAndHealForRefresh: vi.fn(async () => undefined), runTxBackfillBuckets: vi.fn() } as never,
    { recompute: vi.fn() } as never,
    opts.feeRefresh as never,
    opts.flowLocks as never,
  );
  return { service, positions, syncRepo, upserted };
}

function pos(id: number, ts: number, extra: Partial<NormalizedPosition> = {}): NormalizedPosition {
  return { positionId: String(id), createdAtTimestamp: ts, isActive: true, lastModifyBlock: 1, ...extra } as NormalizedPosition;
}

function stats(rows: number) {
  return {
    pageMs: 1,
    dynMs: 1,
    tokensMs: 1,
    priceMs: 1,
    priceWaitMs: 1,
    priceDeadlineHit: false,
    feeReadMs: 0,
    normalizeMs: 1,
    rows,
    overflowPages: 0,
    unpricedClosed: new Map<string, number>(),
    feesMeasured: 0,
  };
}

/** A stub adapter whose walk writes `ranges` (in order) and whose tail returns `tail`. */
function stubAdapter(opts: {
  ranges: NormalizedPosition[][];
  tail?: NormalizedPosition[];
  abortAfter?: number;
  tailHasMore?: boolean;
  firstSince?: string | null;
}) {
  const adapter = {
    recomputeMode: 'aggregates',
    walkTokenIdRanges: vi.fn(async (o: Record<string, any>) => {
      let next = o.fromTokenId as string;
      let i = 0;
      for (const positions of opts.ranges) {
        const from = next;
        next = String(BigInt(from) + 999n);
        await o.onRange(positions, { from, to: next, index: i }, stats(positions.length));
        await o.onCursor?.(next);
        i += 1;
        if (opts.abortAfter !== undefined && i >= opts.abortAfter) {
          return { nextTokenId: next, completed: false, aborted: true, ranges: i, rows: 0, written: 0, maxTimestamp: 0, maxPositionId: '', maxBlockNumber: 0 };
        }
      }
      return { nextTokenId: next, completed: true, aborted: false, ranges: i, rows: opts.ranges.flat().length, written: 0, maxTimestamp: 0, maxPositionId: '', maxBlockNumber: 7 };
    }),
    findFirstTokenIdCreatedSince: vi.fn(async () => (opts.firstSince === undefined ? '500' : opts.firstSince)),
    fetchPositions: vi.fn(async () => ({
      positions: opts.tail ?? [],
      seenPositionIds: [],
      maxTimestamp: 0,
      maxPositionId: '',
      maxBlockNumber: 0,
      hasMore: opts.tailHasMore === true,
      flushedCount: 0,
    })),
  };
  return adapter;
}

describe('runBackfill — tokenid mode orchestration', () => {
  beforeEach(() => {
    indexer = new FakeIndexer();
  });

  it('fromStart: tokenId state only during the walk, tail from runStart − 1 h, createdAt cursor at the END', async () => {
    const adapter = stubAdapter({
      ranges: [[pos(1, 100), pos(2, 300)], [pos(1000, 200)]],
      tail: [pos(5, 900)], // created during the walk below the walk's position
    });
    const { service, syncRepo, upserted } = makeService({ adapter });
    const t0 = Date.now();
    await service.runBackfill(integration as never, { fromStart: true, runKey: 'job-1' });

    const runStartTs = (syncRepo.saveBackfillTokenIdState.mock.calls[0]?.[2] as { runStartTs: number }).runStartTs;
    expect(Math.abs(runStartTs - Math.floor(t0 / 1000))).toBeLessThanOrEqual(1);
    expect(syncRepo.calls).toEqual([
      'markBackfillStarted',
      'saveState:0',
      'cursor:999',
      'cursor:1998',
      'markCursorSuccess',
      'clearState',
      'markBackfillFinished',
    ]);
    // tail: createdAt mode from the run start − 1 h
    const tailCall = adapter.fetchPositions.mock.calls[0]?.[0] as { cursorTimestamp: number; mode: string; cursorPositionId: string };
    expect(tailCall.cursorTimestamp).toBe(runStartTs - TOKENID_TAIL_LOOKBACK_SEC);
    expect(tailCall.cursorPositionId).toBe('');
    expect(tailCall.mode).toBe('backfill');
    // never capped: a capped tail would stop with hasMore on every attempt
    expect((tailCall as unknown as { maxPages: number }).maxPages).toBe(0);
    // end cursor = max(createdAt, id) over walk + tail
    expect(syncRepo.markCursorSuccess).toHaveBeenCalledWith(1, 'uniswap-v4', { lastTimestamp: 900, lastPositionId: '5', lastBlockNumber: 7 });
    expect(upserted.map((p) => p.positionId).sort()).toEqual(['1', '1000', '2', '5']);
    expect(syncRepo.finishRun.mock.calls.at(-1)?.[1]).toMatchObject({ status: 'success' });
  });

  it('the end cursor never moves BACK below the cursor the run started from', async () => {
    const syncRepo = makeSyncRepo({
      backfillInProgress: true,
      backfillPaging: 'tokenid',
      backfillTokenIdCursor: '1998',
      backfillRunStartTs: 100_000,
      lastTimestamp: 5_000,
      lastPositionId: '42',
    });
    const adapter = stubAdapter({ ranges: [[pos(2001, 50)]] });
    const { service } = makeService({ adapter, syncRepo });
    await service.runBackfill(integration as never);
    expect(adapter.walkTokenIdRanges.mock.calls[0]?.[0]).toMatchObject({ fromTokenId: '1998' });
    // the resume keeps the ORIGINAL run start for the tail
    expect((adapter.fetchPositions.mock.calls[0]?.[0] as { cursorTimestamp: number }).cursorTimestamp).toBe(100_000 - TOKENID_TAIL_LOOKBACK_SEC);
    expect(syncRepo.markCursorSuccess).toHaveBeenCalledWith(1, 'uniswap-v4', expect.objectContaining({ lastTimestamp: 5_000, lastPositionId: '42' }));
  });

  it('converts an interrupted OFFSET run at its createdAt cursor', async () => {
    const syncRepo = makeSyncRepo({ backfillInProgress: true, lastTimestamp: 777, lastPositionId: '9' });
    const adapter = stubAdapter({ ranges: [[pos(600, 800)]], firstSince: '500' });
    const { service } = makeService({ adapter, syncRepo });
    await service.runBackfill(integration as never);
    expect(adapter.findFirstTokenIdCreatedSince).toHaveBeenCalledWith(integration, 777);
    expect(adapter.walkTokenIdRanges.mock.calls[0]?.[0]).toMatchObject({ fromTokenId: '500' });
  });

  it('a conversion whose edge read FAILS falls back to the offset walk from the createdAt cursor', async () => {
    const { TokenIdEdgeQueryError } = await import('../../src/subgraph/position-adapter.js');
    const syncRepo = makeSyncRepo({ backfillInProgress: true, lastTimestamp: 777, lastPositionId: '9' });
    const adapter = stubAdapter({ ranges: [[pos(600, 800)]], tail: [pos(700, 900)] });
    adapter.findFirstTokenIdCreatedSince.mockRejectedValueOnce(new TokenIdEdgeQueryError('first-since', new Error('timeout')));
    const { service, upserted } = makeService({ adapter, syncRepo });
    const warn = vi.spyOn((service as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn');
    await service.runBackfill(integration as never);
    expect(adapter.walkTokenIdRanges).not.toHaveBeenCalled();
    expect(syncRepo.saveBackfillTokenIdState).not.toHaveBeenCalled();
    // the offset walk: createdAt mode from the stored cursor
    expect(adapter.fetchPositions.mock.calls[0]?.[0]).toMatchObject({ cursorTimestamp: 777, cursorPositionId: '9' });
    expect(upserted.map((p) => p.positionId)).toEqual(['700']);
    expect(warn.mock.calls.some(([m]) => String(m).includes('[alert] backfill.tokenid_edge_failed'))).toBe(true);
    expect(syncRepo.finishRun.mock.calls.at(-1)?.[1]).toMatchObject({ status: 'success' });
  });

  it('a fresh run whose walk-start edge read FAILS drops its unused tokenId state and walks by offset', async () => {
    const { TokenIdEdgeQueryError } = await import('../../src/subgraph/position-adapter.js');
    const adapter = stubAdapter({ ranges: [], tail: [pos(1, 10)] });
    adapter.walkTokenIdRanges.mockRejectedValueOnce(new TokenIdEdgeQueryError('max', new Error('timeout')));
    const { service, syncRepo } = makeService({ adapter });
    await service.runBackfill(integration as never, { fromStart: true, runKey: 'job-edge' });
    expect(syncRepo.calls).toContain('clearState');
    expect(syncRepo.cursor.backfillPaging).toBeUndefined();
    expect(adapter.fetchPositions).toHaveBeenCalled();
    expect(syncRepo.finishRun.mock.calls.at(-1)?.[1]).toMatchObject({ status: 'success' });
  });

  it('any OTHER walk failure still fails the run (no silent fallback)', async () => {
    const adapter = stubAdapter({ ranges: [] });
    adapter.walkTokenIdRanges.mockRejectedValueOnce(new Error('mongo write failed'));
    const { service, syncRepo } = makeService({ adapter });
    await expect(service.runBackfill(integration as never, { fromStart: true, runKey: 'job-x' })).rejects.toThrow('mongo write failed');
    expect(adapter.fetchPositions).not.toHaveBeenCalled();
    expect(syncRepo.finishRun.mock.calls.at(-1)?.[1]).toMatchObject({ status: 'failed' });
  });

  it('BACKFILL_FEE_READ=on with no page fee reader bound: alert once, run WITHOUT the fee read', async () => {
    const adapter = { ...stubAdapter({ ranges: [[pos(1, 1)]] }), pageFeeReaderBound: () => false };
    const { service } = makeService({ adapter, config: { backfillFeeRead: 'on' } });
    const warn = vi.spyOn((service as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn');
    const log = vi.spyOn((service as unknown as { logger: { log: (m: string) => void } }).logger, 'log');
    await service.runBackfill(integration as never, { fromStart: true, runKey: 'job-fr1' });
    await service.runBackfill(integration as never, { fromStart: true, runKey: 'job-fr2' });
    expect(adapter.walkTokenIdRanges.mock.calls[0]?.[0]).toMatchObject({ feeRead: false });
    expect((adapter.fetchPositions.mock.calls[0]?.[0] as { feeRead?: boolean }).feeRead).toBeUndefined();
    expect(warn.mock.calls.filter(([m]) => String(m).includes('[alert] backfill.fee_read_unbound'))).toHaveLength(1);
    expect(log.mock.calls.some(([m]) => String(m).includes('feeRead=unbound'))).toBe(true);
  });

  it('BACKFILL_FEE_READ=on with a reader bound: the walk reads fees', async () => {
    const adapter = { ...stubAdapter({ ranges: [[pos(1, 1)]] }), pageFeeReaderBound: () => true };
    const { service } = makeService({ adapter, config: { backfillFeeRead: 'on' } });
    await service.runBackfill(integration as never, { fromStart: true, runKey: 'job-fr3' });
    expect(adapter.walkTokenIdRanges.mock.calls[0]?.[0]).toMatchObject({ feeRead: true });
  });

  it('P2.1 role gate: a role without `backfill-fee-read` never reads fees in the walk, whatever the flag says', async () => {
    const { configureProcessRole, resetProcessRoleForTests } = await import('../../src/common/process-role.js');
    configureProcessRole({ processRole: 'fee' });
    try {
      const adapter = { ...stubAdapter({ ranges: [[pos(1, 1)]] }), pageFeeReaderBound: () => true };
      const { service } = makeService({ adapter, config: { backfillFeeRead: 'on' } });
      await service.runBackfill(integration as never, { fromStart: true, runKey: 'job-fr4' });
      expect(adapter.walkTokenIdRanges.mock.calls[0]?.[0]).toMatchObject({ feeRead: false });
    } finally {
      resetProcessRoleForTests();
    }
  });

  it('a conversion with nothing left skips the walk but still runs the tail and finishes', async () => {
    const syncRepo = makeSyncRepo({ backfillInProgress: true, lastTimestamp: 777, lastPositionId: '9' });
    const adapter = stubAdapter({ ranges: [], firstSince: null, tail: [] });
    const { service } = makeService({ adapter, syncRepo });
    await service.runBackfill(integration as never);
    expect(adapter.walkTokenIdRanges).not.toHaveBeenCalled();
    expect(adapter.fetchPositions).toHaveBeenCalledTimes(1);
    expect(syncRepo.markBackfillFinished).toHaveBeenCalled();
  });

  it('shutdown mid-walk: no createdAt cursor, no finish, tokenId state kept, run interrupted', async () => {
    const adapter = stubAdapter({ ranges: [[pos(1, 1)], [pos(1000, 2)], [pos(2000, 3)]], abortAfter: 1 });
    const { service, syncRepo } = makeService({ adapter });
    await service.runBackfill(integration as never, { fromStart: true, runKey: 'job-2' });
    expect(syncRepo.markCursorSuccess).not.toHaveBeenCalled();
    expect(syncRepo.markBackfillFinished).not.toHaveBeenCalled();
    expect(syncRepo.clearBackfillTokenIdState).not.toHaveBeenCalled();
    expect(adapter.fetchPositions).not.toHaveBeenCalled();
    expect(syncRepo.cursor.backfillTokenIdCursor).toBe('999');
    expect(syncRepo.finishRun.mock.calls.at(-1)?.[1]).toMatchObject({ status: 'interrupted' });
  });

  it('shutdown in the tail: same — the next run re-reads the end and re-runs the tail', async () => {
    const adapter = stubAdapter({ ranges: [[pos(1, 1)]], tail: [pos(3, 9)], tailHasMore: true });
    const { service, syncRepo } = makeService({ adapter });
    await service.runBackfill(integration as never, { fromStart: true, runKey: 'job-3' });
    expect(syncRepo.markCursorSuccess).not.toHaveBeenCalled();
    expect(syncRepo.markBackfillFinished).not.toHaveBeenCalled();
    expect(syncRepo.finishRun.mock.calls.at(-1)?.[1]).toMatchObject({ status: 'interrupted' });
  });

  it('backfill.slow: the once-a-minute check runs during the walk and its timer is cleared at the end (and on a failure)', async () => {
    const intervals: Array<{ fn: () => void; ms: number }> = [];
    const cleared: unknown[] = [];
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    const setSpy = vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms: number) => {
      const t = realSet(() => undefined, 1e9);
      intervals.push({ fn, ms });
      (t as unknown as { __slow?: number }).__slow = ms;
      return t;
    }) as never);
    const clearSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(((t: unknown) => {
      cleared.push(t);
      realClear(t as never);
    }) as never);
    try {
      const { service } = makeService({ adapter: stubAdapter({ ranges: [[pos(1, 1)]] }) });
      await service.runBackfill(integration as never, { fromStart: true, runKey: 'slow-1' });
      const slow = intervals.filter((i) => i.ms === 60_000);
      expect(slow).toHaveLength(1);
      expect(() => slow[0]!.fn()).not.toThrow(); // the check itself (no full window yet → quiet)
      expect(cleared.some((t) => (t as { __slow?: number }).__slow === 60_000)).toBe(true);

      intervals.length = 0;
      cleared.length = 0;
      const failing = stubAdapter({ ranges: [[pos(1, 1)]] });
      failing.walkTokenIdRanges.mockRejectedValueOnce(new Error('indexer down'));
      const { service: s2 } = makeService({ adapter: failing });
      await expect(s2.runBackfill(integration as never, { fromStart: true, runKey: 'slow-2' })).rejects.toThrow('indexer down');
      expect(cleared.some((t) => (t as { __slow?: number }).__slow === 60_000)).toBe(true);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  it('the profile reads the write budget\'s backfill-lane wait (process budget)', async () => {
    let waited = 0;
    registerProcessWriteBudget({ laneWaitTotalMs: (lane: string) => (lane === 'backfill' ? (waited += 250) : 0) } as never);
    try {
      const { service } = makeService({ adapter: stubAdapter({ ranges: [[pos(1, 1)], [pos(2, 2)]] }) });
      await service.runBackfill(integration as never, { fromStart: true, runKey: 'budget-1' });
      const snap = backfillProfiles().find((p) => p.chainId === 1)!;
      expect(snap.budgetWaitMs).toBeGreaterThan(0);
    } finally {
      registerProcessWriteBudget(undefined);
    }
  });

  it('a large tail alerts (> 1% of the walk)', async () => {
    const walkRows = Array.from({ length: 100 }, (_, i) => pos(i + 1, 10));
    const adapter = stubAdapter({ ranges: [walkRows], tail: [pos(500, 20), pos(501, 21)] });
    const { service } = makeService({ adapter });
    const warn = vi.spyOn((service as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn');
    await service.runBackfill(integration as never, { fromStart: true, runKey: 'job-4' });
    expect(warn.mock.calls.some(([m]) => String(m).includes('[alert] backfill.tail_large'))).toBe(true);
  });

  it('BACKFILL_PAGING=offset (default): no tokenId call, the cursor is read once (today)', async () => {
    const adapter = stubAdapter({ ranges: [] });
    adapter.fetchPositions.mockResolvedValue({
      positions: [],
      seenPositionIds: [],
      maxTimestamp: 0,
      maxPositionId: '',
      maxBlockNumber: 0,
      hasMore: false,
      flushedCount: 0,
    });
    const { service, syncRepo } = makeService({ adapter, config: { backfillPaging: undefined } });
    await service.runBackfill(integration as never, { fromStart: true, runKey: 'job-5' });
    expect(adapter.walkTokenIdRanges).not.toHaveBeenCalled();
    expect(syncRepo.getCursor).toHaveBeenCalledTimes(1);
    expect(syncRepo.saveBackfillTokenIdState).not.toHaveBeenCalled();
  });

  it('a repository without the tokenId cursor falls back to the offset walk', async () => {
    const adapter = stubAdapter({ ranges: [[pos(1, 1)]] });
    const syncRepo = makeSyncRepo();
    delete (syncRepo as Record<string, unknown>).saveBackfillTokenIdCursor;
    const { service } = makeService({ adapter, syncRepo });
    await service.runBackfill(integration as never, { fromStart: true, runKey: 'job-6' });
    expect(adapter.walkTokenIdRanges).not.toHaveBeenCalled();
    expect(adapter.fetchPositions).toHaveBeenCalled();
  });
});

describe('END TO END on the fake indexer: tokenId run == offset walk, late rows caught by the tail', () => {
  beforeEach(() => {
    indexer = new FakeIndexer();
  });

  function adapter() {
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

  it('every row once — gaps, edges, a late-liquidity low tokenId, and one created mid-walk below the cursor', async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    indexer.positions = [
      ...[0, 1, 998, 999, 1000, 1997, 1998, 2500, 3000].map((t, i) => ({ tokenId: t, createdAt: nowSec - 100_000 + i })),
      { tokenId: 3, createdAt: nowSec - 50 }, // late first liquidity, low tokenId
    ];
    // While range 3 (tokenIds 2997..) is fetched, a position appears at tokenId 7
    // — already passed by the walk — created "now".
    indexer.afterRangePage = (from) => {
      if (from === '2997' && !indexer.positions.some((p) => p.tokenId === 7)) {
        indexer.positions.push({ tokenId: 7, createdAt: nowSec });
      }
    };
    const a = adapter();
    const tokenRun = makeService({ adapter: a as never });
    await tokenRun.service.runBackfill(integration as never, { fromStart: true, runKey: 'e2e-1' });
    const viaTokenId = new Set(tokenRun.upserted.map((p) => p.positionId));

    const offsetRun = makeService({ adapter: a as never, config: { backfillPaging: 'offset' } });
    await offsetRun.service.runBackfill(integration as never, { fromStart: true, runKey: 'e2e-2' });
    const viaOffset = new Set(offsetRun.upserted.map((p) => p.positionId));

    const all = indexer.positions.map((p) => String(p.tokenId)).sort();
    expect([...viaTokenId].sort()).toEqual(all);
    expect([...viaOffset].sort()).toEqual(all);
    // the run ends on the newest (createdAt, id): the row created mid-walk
    expect(tokenRun.syncRepo.cursor).toMatchObject({ lastTimestamp: nowSec, lastPositionId: '7', backfillInProgress: false });
    expect(tokenRun.syncRepo.cursor).not.toHaveProperty('backfillTokenIdCursor');
  });
});

describe('fleet flow locks', () => {
  it('held elsewhere → heldElsewhere, nothing runs (backfill)', async () => {
    const adapter = stubAdapter({ ranges: [[pos(1, 1)]] });
    const flowLocks = { run: vi.fn(async () => ({ held: true as const })) };
    const { service, syncRepo } = makeService({ adapter, flowLocks });
    const res = await service.runBackfill(integration as never, { fromStart: true });
    expect(res.heldElsewhere).toBe(true);
    expect(syncRepo.startRun).not.toHaveBeenCalled();
    expect(flowLocks.run.mock.calls[0]?.[0]).toBe(flowLockName('backfill', 1, 'uniswap-v4'));
    expect(flowLockName('backfill', 1, 'uniswap-v4')).toBe('flow:backfill:1:uniswap-v4');
  });

  it('not held → runs inside the lock and returns its result', async () => {
    const adapter = stubAdapter({ ranges: [[pos(1, 1)]] });
    const flowLocks = {
      run: vi.fn(async (_n: string, fn: () => Promise<unknown>) => ({ held: false as const, value: await fn() })),
    };
    const { service } = makeService({ adapter, flowLocks });
    const res = await service.runBackfill(integration as never, { fromStart: true, runKey: 'lock-1' });
    expect(res.heldElsewhere).toBeUndefined();
    expect(res.upserted).toBe(1);
  });

  it('a second call in the SAME process still answers "already running" (no lock asked)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const adapter = stubAdapter({ ranges: [[pos(1, 1)]] });
    const flowLocks = {
      run: vi.fn(async (_n: string, fn: () => Promise<unknown>) => {
        await gate;
        return { held: false as const, value: await fn() };
      }),
    };
    const { service } = makeService({ adapter, flowLocks });
    const first = service.runBackfill(integration as never, { fromStart: true, runKey: 'lock-2' });
    const second = await service.runBackfill(integration as never, { fromStart: true, runKey: 'lock-3' });
    expect(second.heldElsewhere).toBeUndefined();
    expect(flowLocks.run).toHaveBeenCalledTimes(1);
    release();
    await first;
  });

  it('refresh held elsewhere → skipped with heldElsewhere', async () => {
    const flowLocks = { run: vi.fn(async () => ({ held: true as const })) };
    const { service, syncRepo } = makeService({ adapter: stubAdapter({ ranges: [] }), flowLocks });
    const res = await service.runRefresh(integration as never);
    expect(res.heldElsewhere).toBe(true);
    expect(syncRepo.startRun).not.toHaveBeenCalled();
    expect(flowLocks.run.mock.calls[0]?.[0]).toBe('flow:refresh:1:uniswap-v4');
  });

  it('a refresh whose startRun throws does not leave the chain marked running', async () => {
    const syncRepo = makeSyncRepo();
    syncRepo.startRun.mockRejectedValueOnce(new Error('mongo blip'));
    const { service } = makeService({ adapter: stubAdapter({ ranges: [] }), syncRepo });
    await expect(service.runRefresh(integration as never)).rejects.toThrow('mongo blip');
    const again = await service.runRefresh(integration as never);
    expect(syncRepo.startRun).toHaveBeenCalledTimes(2);
    expect(again.status).toBe('success');
  });
});

describe('lastCleanRefreshAt', () => {
  const activeRefs = [{ positionId: '1', token0Address: '0xa', token1Address: '0xb' }];

  function refreshService(opts: { backfillInProgress?: boolean; chunkFails?: boolean; writeSkip?: string }) {
    const syncRepo = makeSyncRepo();
    syncRepo.isBackfillInProgress.mockResolvedValue(opts.backfillInProgress === true);
    const adapter = {
      recomputeMode: 'aggregates',
      fetchPositions: vi.fn(async () => {
        if (opts.chunkFails) throw new Error('indexer 503');
        return { positions: [], seenPositionIds: ['1'], maxTimestamp: 0, maxPositionId: '', maxBlockNumber: 0, hasMore: false, flushedCount: 0 };
      }),
    };
    let served = 0;
    const findActiveRefsWithTokensPage = vi.fn(async () => (served++ === 0 ? activeRefs : []));
    // The stamp's only reader is the skip-`on` overlay: recorded with skip shadow / on, never with off (today).
    const config = { positionsWriteSkip: opts.writeSkip ?? 'shadow' };
    return { ...makeService({ adapter, syncRepo, config, positions: { findActiveRefsWithTokensPage } }), syncRepo };
  }

  it('recorded with the refresh’s START when the stale sweep ran', async () => {
    const { service, syncRepo, positions } = refreshService({});
    const before = Date.now();
    await service.runRefresh(integration as never);
    expect(positions.markMissingStale).toHaveBeenCalled();
    const at = syncRepo.setLastCleanRefreshAt.mock.calls[0]?.[2] as unknown as Date;
    expect(at).toBeInstanceOf(Date);
    expect(at.getTime()).toBeGreaterThanOrEqual(before - 5);
    expect(at.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('NOT recorded when the sweep deferred for a backfill', async () => {
    const { service, syncRepo } = refreshService({ backfillInProgress: true });
    await service.runRefresh(integration as never);
    expect(syncRepo.setLastCleanRefreshAt).not.toHaveBeenCalled();
  });

  it.each(['on', 'shadow'])('recorded with POSITIONS_WRITE_SKIP=%s', async (mode) => {
    const { service, syncRepo } = refreshService({ writeSkip: mode });
    await service.runRefresh(integration as never);
    expect(syncRepo.setLastCleanRefreshAt).toHaveBeenCalledTimes(1);
  });

  it('NOT recorded with POSITIONS_WRITE_SKIP=off (the default): a default refresh writes no new field (today)', async () => {
    const { service, syncRepo, positions } = refreshService({ writeSkip: 'off' });
    await service.runRefresh(integration as never);
    expect(positions.markMissingStale).toHaveBeenCalled(); // the sweep ran — only the stamp is gated
    expect(syncRepo.setLastCleanRefreshAt).not.toHaveBeenCalled();
  });

  it('NOT recorded when the config carries no skip setting at all (= off)', async () => {
    const syncRepo = makeSyncRepo();
    const adapter = {
      recomputeMode: 'aggregates',
      fetchPositions: vi.fn(async () => ({ positions: [], seenPositionIds: ['1'], maxTimestamp: 0, maxPositionId: '', maxBlockNumber: 0, hasMore: false, flushedCount: 0 })),
    };
    let served = 0;
    const findActiveRefsWithTokensPage = vi.fn(async () => (served++ === 0 ? activeRefs : []));
    const { service } = makeService({ adapter, syncRepo, positions: { findActiveRefsWithTokensPage } });
    await service.runRefresh(integration as never);
    expect(syncRepo.setLastCleanRefreshAt).not.toHaveBeenCalled();
  });

  it('NOT recorded when a chunk failed (the sweep is skipped)', async () => {
    const { service, syncRepo } = refreshService({ chunkFails: true });
    const res = await service.runRefresh(integration as never);
    expect(res.status).toBe('partial');
    expect(syncRepo.setLastCleanRefreshAt).not.toHaveBeenCalled();
  });
});

describe('P3.1 — the fee job is not asked to re-read what the walk measured', () => {
  it('only unstamped ACTIVE rows go to the backfill lane', async () => {
    const markDirty = vi.fn();
    const adapter = stubAdapter({
      ranges: [[pos(1, 1), pos(2, 2, { rpcFeesBlock: 99 }), pos(3, 3, { isActive: false })]],
    });
    const { service } = makeService({ adapter, feeRefresh: { markDirty } });
    await service.runBackfill(integration as never, { fromStart: true, runKey: 'fee-1' });
    const lanes = markDirty.mock.calls.filter((c) => c[4]?.lane === 'backfill');
    expect(lanes.flatMap((c) => c[1])).toEqual(['1']);
  });
});
