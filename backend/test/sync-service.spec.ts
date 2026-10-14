import { afterEach, describe, expect, it, vi } from 'vitest';

// How many requests a FALLBACK indexer has answered, per chain. Stays 0 unless a
// test moves it, so every other test sees a primary-only world.
const failover = vi.hoisted(() => ({ serves: 0 }));
vi.mock('../src/subgraph/indexer-failover.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/subgraph/indexer-failover.js')>()),
  indexerFallbackServes: () => failover.serves,
}));

import { BACKFILL_HEARTBEAT_INTERVAL_MS, SyncService } from '../src/sync/sync.service.js';

const integration = {
  chainId: 1,
  protocol: 'uniswap-v4',
  subgraphUrl: 'https://example.com/subgraph',
  enabled: true,
};

describe('SyncService runBackfill', () => {
  it('marks backfillInProgress at start, clears it when subgraph reports hasMore=false', async () => {
    const fetchPositions = vi.fn(async () => ({
      positions: [],
      seenPositionIds: [],
      maxTimestamp: 10,
      maxPositionId: '10',
      maxBlockNumber: 1,
      hasMore: false,
      flushedCount: 0,
    }));
    const { syncRepo, service } = makeService({ fetchPositions });

    await service.runBackfill(integration);

    expect(syncRepo.markBackfillStarted).toHaveBeenCalledWith(1, 'uniswap-v4');
    expect(syncRepo.markBackfillFinished).toHaveBeenCalledWith(1, 'uniswap-v4');
    // started before finished.
    expect(syncRepo.markBackfillStarted.mock.invocationCallOrder[0])
      .toBeLessThan(syncRepo.markBackfillFinished.mock.invocationCallOrder[0]!);
  });

  it('leaves backfillInProgress set when subgraph still has more pages', async () => {
    const fetchPositions = vi.fn(async () => ({
      positions: [],
      seenPositionIds: [],
      maxTimestamp: 10,
      maxPositionId: '10',
      maxBlockNumber: 1,
      hasMore: true,
      flushedCount: 0,
    }));
    const { syncRepo, service } = makeService({ fetchPositions });

    await service.runBackfill(integration);

    expect(syncRepo.markBackfillStarted).toHaveBeenCalledTimes(1);
    expect(syncRepo.markBackfillFinished).not.toHaveBeenCalled();
  });

  it('resets the cursor when fromStart=true, claiming the reset for the run', async () => {
    const fetchPositions = vi.fn(async () => ({
      positions: [],
      seenPositionIds: [],
      maxTimestamp: 0,
      maxPositionId: '',
      maxBlockNumber: 0,
      hasMore: false,
      flushedCount: 0,
    }));
    const { syncRepo, service } = makeService({ fetchPositions });

    await service.runBackfill(integration, { fromStart: true, runKey: 'job-7' });

    expect(syncRepo.resetCursorForRun).toHaveBeenCalledWith(1, 'uniswap-v4', 'job-7');
    // The flag is up before the reset, so the cursor row exists when it is claimed.
    expect(syncRepo.markBackfillStarted.mock.invocationCallOrder[0])
      .toBeLessThan(syncRepo.resetCursorForRun.mock.invocationCallOrder[0]!);
  });

  it('a direct fromStart call (no run key) still resets — with a fresh key every time', async () => {
    const fetchPositions = vi.fn(async () => emptyWalk());
    const { syncRepo, service } = makeService({ fetchPositions });

    await service.runBackfill(integration, { fromStart: true });
    await new Promise((r) => setTimeout(r, 2));
    await service.runBackfill(integration, { fromStart: true });

    const keys = syncRepo.resetCursorForRun.mock.calls.map((c) => c[2]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
  });

  // A fromStart job created by OLDER code carries no recorded reset key; with
  // QUEUE_CLEAR_ON_BOOT off it survives the deploy and re-runs. Seen on the M10
  // rig: it reset the cursor of a Robinhood walk it was 400k positions into.
  // A request is served by any run that started at or after it was created.
  it('a fromStart job that a run already started after resumes instead of resetting', async () => {
    const fetchPositions = vi.fn(async () => emptyWalk());
    const { syncRepo, service } = makeService({ fetchPositions });
    syncRepo.lastBackfillStartedAt.mockResolvedValue(new Date(2_000));
    syncRepo.getCursor.mockResolvedValue({ lastTimestamp: 1_700_000_123, lastPositionId: '403514' });

    await service.runBackfill(integration, { fromStart: true, runKey: 'old-job', runCreatedAt: 1_000 });

    expect(syncRepo.resetCursorForRun).not.toHaveBeenCalled();
    expect(fetchPositions.mock.calls[0]?.[0]).toMatchObject({ cursorTimestamp: 1_700_000_123, cursorPositionId: '403514' });
    // The prior start is read before this run's own start overwrites it.
    expect(syncRepo.lastBackfillStartedAt.mock.invocationCallOrder[0])
      .toBeLessThan(syncRepo.markBackfillStarted.mock.invocationCallOrder[0]!);
  });

  it('a fromStart job requested after the last run started still resets', async () => {
    const fetchPositions = vi.fn(async () => emptyWalk());
    const { syncRepo, service } = makeService({ fetchPositions });
    syncRepo.lastBackfillStartedAt.mockResolvedValue(new Date(1_000));

    await service.runBackfill(integration, { fromStart: true, runKey: 'new-job', runCreatedAt: 2_000 });

    expect(syncRepo.resetCursorForRun).toHaveBeenCalledWith(1, 'uniswap-v4', 'new-job');
  });

  it('a fromStart job on a chain that never ran a backfill resets', async () => {
    const fetchPositions = vi.fn(async () => emptyWalk());
    const { syncRepo, service } = makeService({ fetchPositions });

    await service.runBackfill(integration, { fromStart: true, runKey: 'first-job', runCreatedAt: 2_000 });

    expect(syncRepo.resetCursorForRun).toHaveBeenCalledWith(1, 'uniswap-v4', 'first-job');
  });

  // A BullMQ retry (attempts: 3) or a stalled re-run of the SAME fromStart job
  // used to reset the cursor to 0 again — a 21 h Robinhood walk restarted from
  // scratch. The reset is now claimed once per run key.
  it('a retried fromStart run whose reset was already claimed resumes from the persisted cursor', async () => {
    const fetchPositions = vi.fn(async () => emptyWalk());
    const { syncRepo, service } = makeService({ fetchPositions });
    syncRepo.resetCursorForRun.mockResolvedValue(false);
    syncRepo.getCursor.mockResolvedValue({ lastTimestamp: 1_700_000_123, lastPositionId: '987654' });

    await service.runBackfill(integration, { fromStart: true, runKey: 'job-7' });

    expect(fetchPositions.mock.calls[0]?.[0]).toMatchObject({
      mode: 'backfill',
      cursorTimestamp: 1_700_000_123,
      cursorPositionId: '987654',
    });
  });

  it('takes the parallel buckets only on a FRESH fromStart — a retry walks serially from the cursor', async () => {
    const fetchPositionTimestampRange = vi.fn(async () => ({ minTimestamp: 1, maxTimestamp: 100 }));
    const fetchPositions = vi.fn(async () => emptyWalk());

    const fresh = makeService({ fetchPositions, fetchPositionTimestampRange, config: { positionsBackfillBuckets: 4 } });
    await fresh.service.runBackfill(integration, { fromStart: true, runKey: 'job-1' });
    expect(fetchPositionTimestampRange).toHaveBeenCalledTimes(1);
    expect(fetchPositions).toHaveBeenCalledTimes(4); // one walk per bucket

    fetchPositionTimestampRange.mockClear();
    fetchPositions.mockClear();
    const retry = makeService({ fetchPositions, fetchPositionTimestampRange, config: { positionsBackfillBuckets: 4 } });
    retry.syncRepo.resetCursorForRun.mockResolvedValue(false);
    await retry.service.runBackfill(integration, { fromStart: true, runKey: 'job-1' });
    expect(fetchPositionTimestampRange).not.toHaveBeenCalled();
    expect(fetchPositions).toHaveBeenCalledTimes(1);
  });

  it('a bucketed fromStart no longer runs a second whole-shard recompute pass (aggregates mode)', async () => {
    const fetchPositionTimestampRange = vi.fn(async () => ({ minTimestamp: 1, maxTimestamp: 100 }));
    const { service, aggregateRecompute, positions } = makeService({
      fetchPositions: vi.fn(async () => emptyWalk()),
      fetchPositionTimestampRange,
      recomputeMode: 'aggregates',
      config: { positionsBackfillBuckets: 2 },
    });

    await service.runBackfill(integration, { fromStart: true, runKey: 'job-1' });

    expect(aggregateRecompute.recompute).not.toHaveBeenCalled();
    expect(positions.findActiveRefsWithTokensPage).not.toHaveBeenCalled();
  });

  it('does not reset the cursor by default (resume mode)', async () => {
    const fetchPositions = vi.fn(async () => ({
      positions: [],
      seenPositionIds: [],
      maxTimestamp: 0,
      maxPositionId: '',
      maxBlockNumber: 0,
      hasMore: false,
      flushedCount: 0,
    }));
    const { syncRepo, service } = makeService({ fetchPositions });

    await service.runBackfill(integration);

    expect(syncRepo.resetCursorForRun).not.toHaveBeenCalled();
  });

  it('never calls findActiveRefs in backfill (refresh is a separate flow)', async () => {
    const fetchPositions = vi.fn(async () => ({
      positions: [],
      seenPositionIds: [],
      maxTimestamp: 0,
      maxPositionId: '',
      maxBlockNumber: 0,
      hasMore: false,
      flushedCount: 0,
    }));
    const { positions, service } = makeService({ fetchPositions });

    await service.runBackfill(integration);

    expect(positions.findActiveRefs).not.toHaveBeenCalled();
    expect(positions.markMissingStale).not.toHaveBeenCalled();
  });
});

describe('SyncService runBackfill — heartbeat, flush writes, resume', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A walk that flushes `rows` once through `onFlush`, then ends. */
  const flushingWalk = (rows: Array<Record<string, unknown>>) =>
    vi.fn(async (opts: { onFlush?: (p: unknown[], c: unknown) => Promise<number> }) => {
      await opts.onFlush?.(rows, { maxTimestamp: 10, maxPositionId: '10', maxBlockNumber: 5 });
      return { ...emptyWalk(), flushedCount: rows.length };
    });

  it('stamps the heartbeat on every flush, after the cursor', async () => {
    const { service, syncRepo } = makeService({ fetchPositions: flushingWalk([{ positionId: '1', isActive: true }]) });

    await service.runBackfill(integration);

    expect(syncRepo.touchBackfillHeartbeat).toHaveBeenCalledWith(1, 'uniswap-v4');
    expect(syncRepo.markCursorSuccess.mock.invocationCallOrder[0])
      .toBeLessThan(syncRepo.touchBackfillHeartbeat.mock.invocationCallOrder[0]!);
  });

  it('keeps the heartbeat fresh on a timer while the walk runs, and stops it when the run ends', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const fetchPositions = vi.fn(
      () =>
        new Promise((resolve) => {
          release = () => resolve(emptyWalk());
        }),
    );
    const { service, syncRepo } = makeService({ fetchPositions });

    const run = service.runBackfill(integration);
    await vi.advanceTimersByTimeAsync(0);
    expect(syncRepo.touchBackfillHeartbeat).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(BACKFILL_HEARTBEAT_INTERVAL_MS * 3);
    expect(syncRepo.touchBackfillHeartbeat).toHaveBeenCalledTimes(3);

    release();
    await run;
    await vi.advanceTimersByTimeAsync(BACKFILL_HEARTBEAT_INTERVAL_MS * 3);
    expect(syncRepo.touchBackfillHeartbeat).toHaveBeenCalledTimes(3);
  });

  it('a failed heartbeat never fails the backfill', async () => {
    const { service, syncRepo } = makeService({ fetchPositions: flushingWalk([{ positionId: '1', isActive: true }]) });
    syncRepo.touchBackfillHeartbeat.mockRejectedValue(new Error('mongo blip'));

    await expect(service.runBackfill(integration)).resolves.toMatchObject({ chainId: 1 });
    expect(syncRepo.finishRun).toHaveBeenCalledWith('run-1', expect.objectContaining({ status: 'success' }));
  });

  it('a throw while starting the run does not wedge the chain for the life of the process', async () => {
    const { service, syncRepo } = makeService({ fetchPositions: vi.fn(async () => emptyWalk()) });
    syncRepo.startRun.mockRejectedValueOnce(new Error('mongo down'));

    await expect(service.runBackfill(integration)).rejects.toThrow('mongo down');
    await expect(service.runBackfill(integration)).resolves.toBeDefined();
    expect(syncRepo.startRun).toHaveBeenCalledTimes(2);
  });

  it('aggregates mode: each flush upserts ONCE with the metrics computed inside, at a native price read per flush', async () => {
    const rows = [{ positionId: '1', isActive: true }, { positionId: '2', isActive: true }];
    const { service, positions, pricing, aggregateRecompute } = makeService({
      fetchPositions: flushingWalk(rows),
      recomputeMode: 'aggregates',
    });
    pricing.currentNativeUsd.mockResolvedValue(3150);

    await service.runBackfill(integration);

    expect(positions.upsertMany).toHaveBeenCalledTimes(1);
    expect(positions.upsertMany).toHaveBeenCalledWith(rows, { aggregates: { ethPriceNow: 3150 } });
    expect(pricing.currentNativeUsd).toHaveBeenCalledTimes(1);
    // No second write: the separate recompute is gone from the flush.
    expect(aggregateRecompute.recompute).not.toHaveBeenCalled();
  });

  it('aggregates mode: a native-price failure values gas at 0 (tx-time fallback) instead of failing the flush', async () => {
    const rows = [{ positionId: '1', isActive: true }];
    const { service, positions, pricing } = makeService({ fetchPositions: flushingWalk(rows), recomputeMode: 'aggregates' });
    pricing.currentNativeUsd.mockRejectedValue(new Error('provider down'));

    await service.runBackfill(integration);

    expect(positions.upsertMany).toHaveBeenCalledWith(rows, { aggregates: { ethPriceNow: 0 } });
  });

  it('transaction mode: the flush upserts without aggregates and still dispatches the tx sync', async () => {
    const rows = [{ positionId: '1', isActive: true }];
    const { service, positions, transactionSync } = makeService({
      fetchPositions: flushingWalk(rows),
      recomputeMode: 'transactions',
    });

    await service.runBackfill(integration);

    expect(positions.upsertMany).toHaveBeenCalledWith(rows, {});
    expect(transactionSync.syncTokenIdsFromPositionSync).toHaveBeenCalledWith(
      integration,
      expect.objectContaining({ positionIds: ['1'], origin: 'backfill-flush' }),
    );
  });

  it('interruptedBackfills lists the enabled integrations whose flag is set, not one running here', async () => {
    const chains = [integration, { ...integration, chainId: 4663 }, { ...integration, chainId: 42161 }];
    const { service, syncRepo } = makeService({
      fetchPositions: vi.fn(async () => emptyWalk()),
      config: { enabledIntegrations: chains },
    });
    syncRepo.getCursor.mockImplementation(async (chainId: number) =>
      chainId === 4663 || chainId === 1 ? { backfillInProgress: true } : { backfillInProgress: false },
    );

    expect((await service.interruptedBackfills()).map((i) => i.chainId)).toEqual([1, 4663]);
  });
});

describe('SyncService runRefresh', () => {
  const activeRef = {
    positionId: '40',
    tokenId: '40',
    token0Address: '0xaaa',
    token0Symbol: 'AAA',
    token1Address: '0xbbb',
    token1Symbol: 'BBB',
  };
  const refreshedPositions = () => ({
    positions: [{ positionId: '40', tokenId: '40' }],
    seenPositionIds: ['40'],
    maxTimestamp: 10,
    maxPositionId: '10',
    maxBlockNumber: 1,
    hasMore: false,
    flushedCount: 0,
  });
  // A single partial page (length < the internal page size) terminates the
  // walk after one call; the `after` guard returns [] on any follow-up call.
  // Pending-aware: refresh runs a pending pass (performanceReady=false) then a
  // ready pass. These fixtures carry no pending rows, so the data lands in the
  // ready pass (pending=false) and the pending pass is empty. (Closed-candidate
  // mocks pass no `options`, so they fall through to the rows/[] behaviour.)
  const onePage = (rows: unknown[]) =>
    vi.fn(
      async (
        _c: number,
        _p: string,
        _size: number,
        after?: string,
        options?: { pending?: boolean },
      ) => (options?.pending === true ? [] : after ? [] : rows),
    );

  it('refreshes all active positions, dispatches open tx-sync, reprices+heals, then stale-sweeps', async () => {
    const fetchPositions = vi.fn(async () => refreshedPositions());
    const { service, positions, transactionSync } = makeService({
      fetchPositions,
      findActiveRefsWithTokensPage: onePage([activeRef]),
    });

    await service.runRefresh(integration);

    expect(fetchPositions).toHaveBeenCalledTimes(1);
    expect(fetchPositions.mock.calls[0]?.[0]).toMatchObject({
      mode: 'refresh',
      positionIds: ['40'],
      skipPrefetch: true,
    });
    // Open-position tx-sync dispatched for the refreshed batch.
    const openCall = transactionSync.syncTokenIdsFromPositionSync.mock.calls.find(
      (c) => (c[1] as { origin?: string })?.origin === 'refresh-open',
    );
    expect(openCall?.[1]).toMatchObject({ fromZero: false, origin: 'refresh-open', positionIds: ['40'] });
    // Background reprice + heal fired once per tick.
    expect(transactionSync.repriceAndHealForRefresh).toHaveBeenCalledWith(integration);
    // Stale sweep sees the full active set — one Set, not an array AND a set.
    expect(positions.markMissingStale).toHaveBeenCalledWith(1, 'uniswap-v4', new Set(['40']), 3);
  });

  it('covers all closed candidates after open, dispatching closed tx-sync (open before closed)', async () => {
    const fetchPositions = vi.fn(async () => refreshedPositions());
    const closed = { positionId: '99', tokenId: '99', isActive: false, poolId: '0xpool', token0: {}, token1: {} };
    const { service, transactionSync } = makeService({
      fetchPositions,
      findActiveRefsWithTokensPage: onePage([activeRef]),
      findHotClosedCandidatesPage: onePage([closed]),
    });

    await service.runRefresh(integration);

    const origins = transactionSync.syncTokenIdsFromPositionSync.mock.calls.map(
      (c) => (c[1] as { origin?: string })?.origin,
    );
    expect(origins).toContain('refresh-open');
    expect(origins).toContain('refresh-closed');
    // Phase B (open) fully completes before Phase C (closed).
    expect(origins.indexOf('refresh-open')).toBeLessThan(origins.indexOf('refresh-closed'));
    const closedCall = transactionSync.syncTokenIdsFromPositionSync.mock.calls.find(
      (c) => (c[1] as { origin?: string })?.origin === 'refresh-closed',
    );
    expect(closedCall?.[1]).toMatchObject({ fromZero: false, positionIds: ['99'] });
  });

  it('skips closed candidates already refreshed as active (dedup vs seen set)', async () => {
    const fetchPositions = vi.fn(async () => refreshedPositions());
    // Closed candidate shares positionId '40' with the active ref just seen.
    const dupClosed = { positionId: '40', tokenId: '40', isActive: false, poolId: '0xpool', token0: {}, token1: {} };
    const { service, transactionSync } = makeService({
      fetchPositions,
      findActiveRefsWithTokensPage: onePage([activeRef]),
      findHotClosedCandidatesPage: onePage([dupClosed]),
    });

    await service.runRefresh(integration);

    const origins = transactionSync.syncTokenIdsFromPositionSync.mock.calls.map(
      (c) => (c[1] as { origin?: string })?.origin,
    );
    expect(origins).not.toContain('refresh-closed');
  });

  it('runs refresh even when backfill is in progress (only stale sweep defers)', async () => {
    const fetchPositions = vi.fn(async () => refreshedPositions());
    const { service, positions, syncRepo } = makeService({
      fetchPositions,
      findActiveRefsWithTokensPage: onePage([activeRef]),
    });
    syncRepo.isBackfillInProgress.mockResolvedValue(true);

    await service.runRefresh(integration);

    expect(positions.findActiveRefsWithTokensPage).toHaveBeenCalled();
    expect(fetchPositions).toHaveBeenCalled();
    // Stale sweep is gated when backfill is in flight.
    expect(positions.markMissingStale).not.toHaveBeenCalled();
  });

  it('completes the refresh even if reprice+heal rejects (fire-and-forget)', async () => {
    const fetchPositions = vi.fn(async () => refreshedPositions());
    const repriceAndHealForRefresh = vi.fn(async () => {
      throw new Error('reprice boom');
    });
    const { service, syncRepo } = makeService({
      fetchPositions,
      findActiveRefsWithTokensPage: onePage([activeRef]),
      repriceAndHealForRefresh,
    });

    await expect(service.runRefresh(integration)).resolves.toBeDefined();
    expect(syncRepo.finishRun).toHaveBeenCalledWith('run-1', expect.objectContaining({ status: 'success' }));
  });

  it('paginates active positions across pages until a short page ends the walk', async () => {
    const PAGE_SIZE = 5000;
    const fullPage = Array.from({ length: PAGE_SIZE }, (_, i) => ({
      positionId: `p${i}`,
      tokenId: `${i}`,
      token0Address: '0xaaa',
      token1Address: '0xbbb',
    }));
    // First page is full (== page size) so the loop continues; the second
    // call (cursor advanced) returns empty and terminates the walk. Pending-
    // aware: the data is in the ready pass (pending=false); the pending pass is
    // empty.
    const findActiveRefsWithTokensPage = vi.fn(
      async (
        _c: number,
        _p: string,
        _size: number,
        after?: string,
        options?: { pending?: boolean },
      ) => (options?.pending === true ? [] : after ? [] : fullPage),
    );
    const fetchPositions = vi.fn(async () => ({
      positions: [],
      seenPositionIds: [],
      maxTimestamp: 0,
      maxPositionId: '',
      maxBlockNumber: 0,
      hasMore: false,
      flushedCount: 0,
    }));
    const { service } = makeService({ fetchPositions, findActiveRefsWithTokensPage });

    await service.runRefresh(integration);

    // Pending pass: 1 empty probe. Ready pass: full page + terminating empty
    // page = 2. Total = 3.
    expect(findActiveRefsWithTokensPage).toHaveBeenCalledTimes(3);
  });
});

describe('SyncService runRefresh — aggregates mode (v4)', () => {
  const activeRef = { positionId: '40', tokenId: '40', token0Address: '0xaaa', token1Address: '0xbbb' };
  const readyOnly = (rows: unknown[]) =>
    vi.fn(async (_c: number, _p: string, _s: number, after?: string, options?: { pending?: boolean }) =>
      options?.pending === true ? [] : after ? [] : rows,
    );
  const refreshed = () => ({
    positions: [{ positionId: '40', tokenId: '40' }],
    seenPositionIds: ['40'],
    maxTimestamp: 0,
    maxPositionId: '',
    maxBlockNumber: 0,
    hasMore: false,
    flushedCount: 0,
  });

  it('skips Phase C (closed catch-up) and Phase D (reprice/heal), keeps Phase B and the stale sweep', async () => {
    const closed = { positionId: '99', tokenId: '99', isActive: false };
    const { service, positions, transactionSync, aggregateRecompute } = makeService({
      fetchPositions: vi.fn(async () => refreshed()),
      findActiveRefsWithTokensPage: readyOnly([activeRef]),
      findHotClosedCandidatesPage: readyOnly([closed]),
      recomputeMode: 'aggregates',
    });

    const result = await service.runRefresh(integration);

    expect(positions.findHotClosedCandidatesPage).not.toHaveBeenCalled();
    expect(transactionSync.repriceAndHealForRefresh).not.toHaveBeenCalled();
    // Phase B computes the refreshed actives' metrics INSIDE their one upsert —
    // the separate recompute (a second read + write per row) is gone…
    expect(positions.upsertMany).toHaveBeenCalledWith([{ positionId: '40', tokenId: '40' }], {
      aggregates: { ethPriceNow: 2500 },
    });
    expect(aggregateRecompute.recompute).not.toHaveBeenCalled();
    // …and never touches the closed candidate.
    expect(positions.markMissingStale).toHaveBeenCalledWith(1, 'uniswap-v4', new Set(['40']), 3);
    expect(result).toMatchObject({ status: 'success', failedChunks: 0, refreshed: 1 });
  });

  it('skips the stale sweep when the fallback indexer answered during the refresh', async () => {
    // The fallback serves the same rows but may be behind the primary: a live
    // position it has not indexed yet would be counted as a miss, and three
    // misses close it. So any fallback answer in the window stands the sweep down.
    const { service, positions } = makeService({
      fetchPositions: vi.fn(async () => {
        failover.serves += 1; // this page came from the fallback
        return refreshed();
      }),
      findActiveRefsWithTokensPage: readyOnly([activeRef]),
      recomputeMode: 'aggregates',
    });

    const result = await service.runRefresh(integration);

    expect(result).toMatchObject({ status: 'success', failedChunks: 0, refreshed: 1 });
    expect(positions.markMissingStale).not.toHaveBeenCalled();
  });

  it('still sweeps when the fallback answered only BEFORE the refresh began', async () => {
    failover.serves += 5; // an earlier outage, already over
    const { service, positions } = makeService({
      fetchPositions: vi.fn(async () => refreshed()),
      findActiveRefsWithTokensPage: readyOnly([activeRef]),
      recomputeMode: 'aggregates',
    });

    await service.runRefresh(integration);

    expect(positions.markMissingStale).toHaveBeenCalledWith(1, 'uniswap-v4', new Set(['40']), 3);
  });

  it('reads the native price once per page, shared by the page\'s chunks', async () => {
    // 1,500 refs → one page, two chunks of 1,000 / 500.
    const refs = Array.from({ length: 1500 }, (_, i) => ({ positionId: `p${i}`, tokenId: `${i}` }));
    const { service, pricing, positions } = makeService({
      fetchPositions: vi.fn(async (opts: { positionIds: string[] }) => ({
        ...emptyWalk(),
        positions: opts.positionIds.map((id) => ({ positionId: id, tokenId: id })),
        seenPositionIds: opts.positionIds,
      })),
      findActiveRefsWithTokensPage: readyOnly(refs),
      recomputeMode: 'aggregates',
    });

    await service.runRefresh(integration);

    expect(positions.upsertMany).toHaveBeenCalledTimes(2);
    expect(pricing.currentNativeUsd).toHaveBeenCalledTimes(1);
  });

  it('still runs Phase C and D for a transaction-mode adapter', async () => {
    const closed = { positionId: '99', tokenId: '99', isActive: false };
    const { service, positions, transactionSync } = makeService({
      fetchPositions: vi.fn(async () => refreshed()),
      findActiveRefsWithTokensPage: readyOnly([activeRef]),
      findHotClosedCandidatesPage: readyOnly([closed]),
      recomputeMode: 'transactions',
    });

    await service.runRefresh(integration);

    expect(positions.findHotClosedCandidatesPage).toHaveBeenCalled();
    expect(transactionSync.repriceAndHealForRefresh).toHaveBeenCalledWith(integration);
  });
});

describe('SyncService runRefresh — chunk failures are non-fatal', () => {
  // POSITIONS_PAGE_SIZE defaults to 1000, so 1,500 refs make two chunks:
  // p0..p999 and p1000..p1499.
  const refs = Array.from({ length: 1500 }, (_, i) => ({
    positionId: `p${i}`,
    tokenId: `${i}`,
    token0Address: '0xaaa',
    token1Address: '0xbbb',
  }));
  const pagedRefs = (pendingRows: unknown[], readyRows: unknown[]) =>
    vi.fn(async (_c: number, _p: string, _s: number, after?: string, options?: { pending?: boolean }) =>
      after ? [] : options?.pending === true ? pendingRows : readyRows,
    );
  /** Succeeds for every chunk except the one containing `failId`. */
  const fetchFailingOn = (failId: string) =>
    vi.fn(async (opts: { positionIds: string[] }) => {
      if (opts.positionIds.includes(failId)) throw new Error('indexer is rate limiting');
      return {
        positions: opts.positionIds.map((id) => ({ positionId: id, tokenId: id })),
        seenPositionIds: opts.positionIds,
        maxTimestamp: 0,
        maxPositionId: '',
        maxBlockNumber: 0,
        hasMore: false,
        flushedCount: 0,
      };
    });

  it('finishes partial without throwing, keeps the good chunk, and skips the stale sweep', async () => {
    const upsertMany = vi.fn(async (rows: unknown[]) => rows.length);
    const { service, positions, syncRepo } = makeService({
      fetchPositions: fetchFailingOn('p1000'),
      findActiveRefsWithTokensPage: pagedRefs([], refs),
      upsertMany,
      recomputeMode: 'aggregates',
    });

    const result = await service.runRefresh(integration);

    expect(result).toMatchObject({ status: 'partial', failedChunks: 1, refreshed: 1000, upserted: 1000 });
    expect(upsertMany).toHaveBeenCalledTimes(1);
    // The failed chunk's ids never reached the seen set: sweeping now would
    // count 500 live positions as misses.
    expect(positions.markMissingStale).not.toHaveBeenCalled();
    expect(syncRepo.finishRun).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ status: 'partial', error: '1/2 refresh chunks failed', refreshed: 1000 }),
    );
    expect(syncRepo.finishRun).not.toHaveBeenCalledWith('run-1', expect.objectContaining({ status: 'failed' }));
  });

  it('counts a chunk whose upsert throws as failed too', async () => {
    const upsertMany = vi.fn(async () => {
      throw new Error('mongo write error');
    });
    const { service, positions } = makeService({
      fetchPositions: fetchFailingOn('never'),
      findActiveRefsWithTokensPage: pagedRefs([], refs),
      upsertMany,
      recomputeMode: 'aggregates',
    });

    const result = await service.runRefresh(integration);

    expect(result).toMatchObject({ status: 'partial', failedChunks: 2 });
    expect(positions.markMissingStale).not.toHaveBeenCalled();
  });

  it('a failure in the pending pass skips the stale sweep even when the ready pass is clean', async () => {
    const pendingRef = { positionId: 'pending-1', tokenId: '1', token0Address: '0xaaa', token1Address: '0xbbb' };
    const readyRef = { positionId: 'ready-1', tokenId: '2', token0Address: '0xaaa', token1Address: '0xbbb' };
    const { service, positions } = makeService({
      fetchPositions: fetchFailingOn('pending-1'),
      findActiveRefsWithTokensPage: pagedRefs([pendingRef], [readyRef]),
      recomputeMode: 'aggregates',
    });

    const result = await service.runRefresh(integration);

    expect(result).toMatchObject({ status: 'partial', failedChunks: 1 });
    expect(positions.markMissingStale).not.toHaveBeenCalled();
  });

  it('a clean walk finishes success and sweeps', async () => {
    const { service, positions, syncRepo } = makeService({
      fetchPositions: fetchFailingOn('never'),
      findActiveRefsWithTokensPage: pagedRefs([], refs),
      upsertMany: vi.fn(async (rows: unknown[]) => rows.length),
      recomputeMode: 'aggregates',
    });

    const result = await service.runRefresh(integration);

    expect(result).toMatchObject({ status: 'success', failedChunks: 0, refreshed: 1500 });
    expect(positions.markMissingStale).toHaveBeenCalledTimes(1);
    expect(syncRepo.finishRun).toHaveBeenCalledWith('run-1', expect.objectContaining({ status: 'success' }));
    expect(syncRepo.finishRun.mock.calls[0]?.[1]).not.toHaveProperty('error');
  });
});

describe('SyncService.recomputeAggregatesTarget — the admin healer', () => {
  it('walks every row, closed included, through the separate recompute', async () => {
    const refs = [{ positionId: '1' }, { positionId: '2' }];
    const findActiveRefsWithTokensPage = vi.fn(async (_c: number, _p: string, _s: number, after?: string) =>
      after ? [] : refs,
    );
    const { service, aggregateRecompute } = makeService({
      fetchPositions: vi.fn(),
      findActiveRefsWithTokensPage,
      recomputeMode: 'aggregates',
    });

    const result = await service.recomputeAggregatesTarget(1, 'uniswap-v4');

    expect(findActiveRefsWithTokensPage.mock.calls[0]?.[4]).toEqual({ includeClosed: true });
    expect(aggregateRecompute.recompute).toHaveBeenCalledWith(1, 'uniswap-v4', ['1', '2']);
    expect(result.updated).toBe(2);
  });

  it('refuses a protocol that does not recompute from row aggregates', async () => {
    const { service, aggregateRecompute } = makeService({ fetchPositions: vi.fn(), recomputeMode: 'transactions' });
    await expect(service.recomputeAggregatesTarget(1, 'uniswap-v4')).rejects.toThrow(/row aggregates/);
    expect(aggregateRecompute.recompute).not.toHaveBeenCalled();
  });
});

function makeService(opts: {
  fetchPositions: ReturnType<typeof vi.fn>;
  findActiveRefs?: ReturnType<typeof vi.fn>;
  findActiveRefsWithTokensPage?: ReturnType<typeof vi.fn>;
  findHotClosedCandidatesPage?: ReturnType<typeof vi.fn>;
  repriceAndHealForRefresh?: ReturnType<typeof vi.fn>;
  upsertMany?: ReturnType<typeof vi.fn>;
  recomputeMode?: 'aggregates' | 'transactions';
  fetchPositionTimestampRange?: ReturnType<typeof vi.fn>;
  config?: {
    testMode?: boolean;
    testModePositionLimit?: number;
    positionsBackfillBuckets?: number;
    enabledIntegrations?: unknown[];
  };
}) {
  const positions = {
    upsertMany: opts.upsertMany ?? vi.fn(async () => 0),
    findActiveRefs: opts.findActiveRefs ?? vi.fn(async () => []),
    findActiveRefsWithTokensPage: opts.findActiveRefsWithTokensPage ?? vi.fn(async () => []),
    findHotClosedCandidatesPage: opts.findHotClosedCandidatesPage ?? vi.fn(async () => []),
    markMissingStale: vi.fn(async () => 0),
  };
  const syncRepo = {
    startRun: vi.fn(async () => 'run-1'),
    getCursor: vi.fn(async () => null),
    markCursorSuccess: vi.fn(async () => undefined),
    markCursorFailure: vi.fn(async () => undefined),
    finishRun: vi.fn(async () => undefined),
    markBackfillStarted: vi.fn(async () => undefined),
    markBackfillFinished: vi.fn(async () => undefined),
    touchBackfillHeartbeat: vi.fn(async () => undefined),
    isBackfillInProgress: vi.fn(async () => false),
    resetCursorForRun: vi.fn(async () => true),
    lastBackfillStartedAt: vi.fn(async (): Promise<Date | undefined> => undefined),
  };
  const pricing = {
    prefetchPrices: vi.fn(async () => undefined),
    currentNativeUsd: vi.fn(async () => 2500),
  };
  const transactionSync = {
    syncTokenIdsFromPositionSync: vi.fn(async () => ({
      positionsScanned: 0,
      positionsSucceeded: 0,
      positionsFailed: 0,
      transactionsFetched: 0,
      transactionsUpserted: 0,
      durationMs: 0,
    })),
    repriceAndHealForRefresh: opts.repriceAndHealForRefresh ?? vi.fn(async () => undefined),
    runTxBackfillBuckets: vi.fn(async () => undefined),
  };
  const aggregateRecompute = {
    recompute: vi.fn(async (_c: number, _p: string, ids: string[]) => ids.length),
  };
  const service = new SyncService(
    {
      testMode: opts.config?.testMode ?? false,
      testModePositionLimit: opts.config?.testModePositionLimit ?? 20_000,
      positionsBackfillBuckets: opts.config?.positionsBackfillBuckets ?? 1,
      enabledIntegrations: opts.config?.enabledIntegrations ?? [integration],
      getIntegration: () => integration,
    } as never,
    {
      resolve: () => ({
        fetchPositions: opts.fetchPositions,
        recomputeMode: opts.recomputeMode,
        ...(opts.fetchPositionTimestampRange ? { fetchPositionTimestampRange: opts.fetchPositionTimestampRange } : {}),
      }),
    } as never,
    positions as never,
    syncRepo as never,
    pricing as never,
    transactionSync as never,
    aggregateRecompute as never,
  );
  return { service, positions, syncRepo, transactionSync, pricing, aggregateRecompute };
}

function emptyWalk() {
  return {
    positions: [],
    seenPositionIds: [],
    maxTimestamp: 0,
    maxPositionId: '',
    maxBlockNumber: 0,
    hasMore: false,
    flushedCount: 0,
  };
}
