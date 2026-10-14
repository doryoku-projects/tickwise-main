/*
 * The live change feed.
 *
 * It watches the indexer's `Position.updatedAtBlock` — bumped by modify /
 * transfer / burn. The indexer no longer re-reads fees at all (its fee sweep and
 * the separate `feesUpdatedAtBlock` column are gone), so nothing else moves it,
 * and the listener's queries select no fee column. It used to watch the vanilla subgraph's
 * `positionTransactions` feed by `timestamp` on one path and Ponder's
 * `{items,pageInfo}` cursor pages on another; both are gone.
 *
 * Two properties carry all the risk and both are pinned below:
 *   - KEYSET paging. `updatedAtBlock` is a MUTABLE sort key, so an offset walk
 *     would step over rows that move mid-walk. The next page's bound must be the
 *     previous page's max block.
 *   - The fee-sweep backstop must drop ONLY the suspected sweep block's rows, not
 *     the whole poll.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requestMock = vi.fn();

vi.mock('graphql-request', () => ({
  GraphQLClient: vi.fn().mockImplementation(() => ({
    request: requestMock,
  })),
  gql: (strings: TemplateStringsArray) => strings.join(''),
}));

import { LiveEventListenerService } from '../src/sync/live-event-listener.service.js';

const integration = {
  chainId: 1,
  protocol: 'uniswap-v4',
  subgraphUrl: 'https://indexer.hyperindex.xyz/abc123/v1/graphql',
  dialect: 'hyperindex',
  enabled: true,
};

function makeService(opts: {
  pollMin?: number;
  pollFallback?: number;
  integration?: Record<string, unknown>;
  recomputeMode?: string;
} = {}) {
  const enqueueFn = vi.fn(async () => undefined);
  const syncRepo = {
    getCursor: vi.fn(async () => null),
    markLiveCursor: vi.fn(async () => undefined),
  };
  const config = {
    liveRefreshEnabled: true,
    livePollMinMs: opts.pollMin ?? 500,
    livePollIntervalFallbackMs: opts.pollFallback ?? 3000,
    liveRefreshConcurrency: 8,
    enabledIntegrations: [opts.integration ?? integration],
  };
  const adapters = {
    resolve: vi.fn(() => ({ recomputeMode: opts.recomputeMode ?? 'aggregates' })),
  };
  const service = new LiveEventListenerService(
    config as never,
    syncRepo as never,
    adapters as never,
  );
  service.registerEnqueue(enqueueFn);
  const warn = vi
    .spyOn((service as unknown as { logger: { warn: () => void } }).logger, 'warn')
    .mockImplementation(() => {});
  return { service, enqueueFn, syncRepo, adapters, warn };
}

/** Rows the feed returns: one position, at one block. */
function row(tokenId: string, block: number, ts = 1_700_000_000 + block) {
  return { tokenId, updatedAtBlock: String(block), updatedAtTimestamp: String(ts) };
}

// The feed and the head probe hit the same entity; `orderDirection: asc` is what
// separates them (the head probe is `desc`, first: 1).
function isFeedQuery(q: unknown): boolean {
  return typeof q === 'string' && q.includes('orderDirection: asc');
}

function feedCalls() {
  return requestMock.mock.calls.filter((c) => isFeedQuery(c[0]));
}

/** `updatedAtBlock_gt` on a feed call — the keyset bound. */
function boundOf(call: unknown[]): string {
  return (call[1] as { where: { updatedAtBlock_gt: string } }).where.updatedAtBlock_gt;
}

async function runOnce(service: LiveEventListenerService, ms = 80) {
  await service.onModuleInit();
  await new Promise((resolve) => setTimeout(resolve, ms));
  await service.onModuleDestroy();
}

describe('LiveEventListenerService', () => {
  beforeEach(() => {
    requestMock.mockReset();
  });

  // Deliberately NOT `vi.restoreAllMocks()`: that also restores the module-level
  // `GraphQLClient` mock's implementation, so every test after the first would
  // get a client with no `request` method and fail with an empty result rather
  // than an error. The logger spies are taken per service instance, so nothing
  // leaks between tests without it.
  afterEach(() => {
    requestMock.mockReset();
  });

  it('seeds from the indexer head on a cold start instead of walking the whole index', async () => {
    const { service, enqueueFn } = makeService();

    requestMock.mockImplementation(async (query: string) => {
      if (isFeedQuery(query)) return { positions: [] };
      return { positions: [{ updatedAtBlock: '25976860' }] }; // HEAD_QUERY
    });

    await runOnce(service, 60);

    // Without the seed, the first bound would be 0 and the poll would enqueue the
    // entire index — historical positions are owned by backfill + the cron.
    expect(boundOf(feedCalls()[0])).toBe('25976860');
    expect(enqueueFn).not.toHaveBeenCalled();
  });

  it('selects no fee column in either of its queries (the indexer dropped them; Hasura rejects the whole query)', async () => {
    const { service } = makeService();
    requestMock.mockImplementation(async (query: string) => {
      if (isFeedQuery(query)) return { positions: [] };
      return { positions: [{ updatedAtBlock: '25976860' }] };
    });

    await runOnce(service, 60);

    const queries = requestMock.mock.calls.map((c) => String(c[0]));
    expect(queries.length).toBeGreaterThanOrEqual(2); // the head probe and at least one feed poll
    for (const q of queries) {
      expect(q).toContain('updatedAtBlock');
      expect(q).not.toMatch(/feesUpdated|Uncollected/);
    }
  });

  it('enqueues one job per changed position and advances the cursor to the max block', async () => {
    const { service, enqueueFn, syncRepo } = makeService();
    syncRepo.getCursor.mockResolvedValue({ liveBlockNumber: 100, liveBlockTimestamp: 0 } as never);

    requestMock
      .mockResolvedValueOnce({ positions: [row('40', 101), row('41', 102), row('42', 103), row('40', 104)] })
      .mockImplementation(async () => ({ positions: [] }));

    await runOnce(service);

    // '40' appears twice in one page and is enqueued once.
    const ids = enqueueFn.mock.calls.map((c) => c[0].tokenId);
    expect(new Set(ids)).toEqual(new Set(['40', '41', '42']));
    expect(enqueueFn).toHaveBeenCalledTimes(3);
    expect(enqueueFn.mock.calls[0]?.[0]).toMatchObject({ chainId: 1, protocol: 'uniswap-v4', blockNumber: 104 });

    const lastCursor = syncRepo.markLiveCursor.mock.calls.at(-1);
    expect(lastCursor?.[2]).toBe(104);
  });

  it('does not enqueue or move the cursor when nothing changed', async () => {
    const { service, enqueueFn, syncRepo } = makeService();
    syncRepo.getCursor.mockResolvedValue({ liveBlockNumber: 100, liveBlockTimestamp: 0 } as never);
    requestMock.mockImplementation(async () => ({ positions: [] }));

    await runOnce(service, 60);

    expect(enqueueFn).not.toHaveBeenCalled();
    expect(syncRepo.markLiveCursor).not.toHaveBeenCalled();
  });

  it('pages by KEYSET — the next bound is the previous page max block, not an offset', async () => {
    const { service, enqueueFn } = makeService();

    // A full page (500) forces a second request; its rows run blocks 201..700,
    // one position per block.
    const fullPage = Array.from({ length: 500 }, (_, i) => row(String(1000 + i), 201 + i));
    // Block 700 is re-served, because a full page's TOP block may be truncated —
    // the walk cannot know it read all of it. Then the genuine tail.
    const tailPage = [row('1499', 700), row('9998', 705), row('9999', 706)];

    requestMock
      .mockResolvedValueOnce({ positions: [{ updatedAtBlock: '200' }] }) // head seed
      .mockResolvedValueOnce({ positions: fullPage })
      .mockResolvedValueOnce({ positions: tailPage })
      .mockImplementation(async () => ({ positions: [] }));

    await runOnce(service);

    const calls = feedCalls();
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(boundOf(calls[0])).toBe('200');
    // THE ASSERTION THAT MATTERS: page 2 asks by BLOCK, not by offset. An offset
    // walk (`skip: 500`) would silently drop any row that moved while the walk was
    // in flight, because updatedAtBlock is a mutable sort key. The bound is 699,
    // the last block read IN FULL — see the boundary test below for why not 700.
    expect(boundOf(calls[1])).toBe('699');
    expect(calls[1]?.[1]).not.toHaveProperty('skip');

    // 502 distinct positions, each enqueued exactly once despite 1499 being
    // served twice.
    const ids = enqueueFn.mock.calls.map((c) => c[0].tokenId);
    expect(new Set(ids).size).toBe(502);
    expect(ids).toHaveLength(502);
  });

  it('caps pagination when every page is full', async () => {
    const { service, syncRepo } = makeService();
    syncRepo.getCursor.mockResolvedValue({ liveBlockNumber: 100, liveBlockTimestamp: 0 } as never);

    let page = 0;
    requestMock.mockImplementation(async (query: string) => {
      if (!isFeedQuery(query)) return { positions: [{ updatedAtBlock: '100' }] };
      const base = 200 + page * 1000;
      page += 1;
      return { positions: Array.from({ length: 500 }, (_, i) => row(String(1000 + i), base + i)) };
    });

    await runOnce(service, 250);

    // PAGINATION_HARD_CAP = 20. Without it a hot chain walks forever in one poll.
    expect(feedCalls().length).toBeGreaterThanOrEqual(20);
    const lastCursor = syncRepo.markLiveCursor.mock.calls.at(-1);
    expect(lastCursor?.[2]).toBeGreaterThan(100);
  });

  /*
   * THE TIE AT THE PAGE BOUNDARY.
   *
   * `updatedAtBlock` is not unique, so a full page can end part-way through a
   * block. Advancing the bound to that block's number — the obvious keyset move —
   * excludes its remainder with a strict `_gt`, every time, deterministically
   * (the converter's `{id: asc}` tiebreak makes the ordering total), and the bound
   * is then PERSISTED, so those positions are skipped permanently rather than
   * caught on the next poll.
   */
  it('does not advance past a block it has only partly read', async () => {
    const { service, enqueueFn, syncRepo } = makeService();
    syncRepo.getCursor.mockResolvedValue({ liveBlockNumber: 100, liveBlockTimestamp: 0 } as never);

    // Page 1 is full: 494 rows at blocks 201..694, then 6 rows sharing block 695 —
    // and 4 MORE positions at block 695 did not fit on the page.
    const page1 = [
      ...Array.from({ length: 494 }, (_, i) => row(String(1000 + i), 201 + i)),
      ...Array.from({ length: 6 }, (_, i) => row(String(9000 + i), 695)),
    ];
    const page2 = [
      ...Array.from({ length: 6 }, (_, i) => row(String(9000 + i), 695)), // re-served
      ...Array.from({ length: 4 }, (_, i) => row(String(9100 + i), 695)), // the tail
    ];
    requestMock
      .mockResolvedValueOnce({ positions: page1 })
      .mockResolvedValueOnce({ positions: page2 })
      .mockImplementation(async () => ({ positions: [] }));

    await runOnce(service);

    const calls = feedCalls();
    // Page 2 asks from the last block read IN FULL (694), NOT from 695 — so block
    // 695 is re-served from its start and its tail is not skipped.
    expect(boundOf(calls[1])).toBe('694');
    const ids = enqueueFn.mock.calls.map((c) => c[0].tokenId);
    // All four tail positions arrive, and the six re-served ones exactly once each.
    for (const t of ['9100', '9101', '9102', '9103']) expect(ids).toContain(t);
    expect(new Set(ids).size).toBe(ids.length);
    // The persisted cursor is the fully-consumed bound.
    expect(syncRepo.markLiveCursor.mock.calls.at(-1)?.[2]).toBe(695);
  });

  it('alerts and steps past a block too large to page, rather than wedging on it', async () => {
    const { service, syncRepo, warn } = makeService();
    syncRepo.getCursor.mockResolvedValue({ liveBlockNumber: 100, liveBlockTimestamp: 0 } as never);

    // A full page that is ENTIRELY one block: there is no lower block to fall
    // back to, so the bound cannot be split any finer.
    requestMock
      .mockResolvedValueOnce({
        positions: Array.from({ length: 500 }, (_, i) => row(String(2000 + i), 101)),
      })
      .mockImplementation(async () => ({ positions: [] }));

    await runOnce(service, 80);

    // ONE feed call for that poll. Holding the bound instead would wedge the
    // listener on this block forever and it would never see anything newer.
    expect(feedCalls()).toHaveLength(1);
    expect(warn.mock.calls.map(String).join()).toMatch(/live\.block_overflow/);
    // It steps past, which is a real (bounded) gap — hence the alert.
    expect(syncRepo.markLiveCursor.mock.calls.at(-1)?.[2]).toBe(101);
  });

  /*
   * THE FEE-SWEEP BACKSTOP, and an honest note about its reach.
   *
   * `SWEEP_BLOCK_MIN_ROWS` (500) equals `EVENT_PAGE_SIZE` (500), so a block that
   * meets the floor NECESSARILY fills a whole page — which means the detector and
   * the block-overflow guard fire on exactly the same condition, and they compose:
   * overflow steps the bound past the block (the alternative is wedging on it
   * forever) and the detector suppresses its fan-out. There is therefore no
   * reachable case, on these constants, where a firing sweep block shares a poll
   * with other blocks.
   *
   * The suppression is still written per-BLOCK rather than per-poll, and uses
   * `detectFeeSweepBlocks` (every block over the floor) rather than the single
   * worst one. That costs nothing and is what keeps the two mechanisms correct if
   * either constant moves — a per-poll `return` would abandon genuine activity,
   * and suppressing only the worst block would fan out the other half of a sweep
   * whose batch commit straddled two blocks. `test/live-fee-sweep.spec.ts` pins
   * the multi-block rule at the unit level, where it IS reachable.
   */
  describe('fee-sweep backstop', () => {
    it('suppresses fan-out for a block that fills a whole page, and says so twice', async () => {
      const { service, enqueueFn, syncRepo, warn } = makeService();
      syncRepo.getCursor.mockResolvedValue({ liveBlockNumber: 100, liveBlockTimestamp: 0 } as never);

      requestMock
        .mockResolvedValueOnce({
          positions: Array.from({ length: 500 }, (_, i) => row(String(5000 + i), 777)),
        })
        .mockImplementation(async () => ({ positions: [] }));

      await runOnce(service);

      // NOT 500 refresh jobs, each of which would re-price a position and re-run
      // the aggregate recompute for a quantity that never moved.
      expect(enqueueFn).not.toHaveBeenCalled();
      const warnings = warn.mock.calls.map(String).join();
      expect(warnings).toMatch(/live\.sweep_suspected/);
      expect(warnings).toMatch(/live\.block_overflow/);
      // The cursor still advances — those rows ARE newer, and holding the bound
      // would stop the listener seeing anything after this block.
      expect(syncRepo.markLiveCursor.mock.calls.at(-1)?.[2]).toBe(777);
    });

    it('does not fire on ordinary activity, however busy the block', async () => {
      const { service, enqueueFn, warn } = makeService();
      requestMock
        .mockResolvedValueOnce({ positions: [{ updatedAtBlock: '100' }] })
        // 50 positions in one block is the busiest genuine cluster measured live
        // on mainnet; the floor is 500.
        .mockResolvedValueOnce({ positions: Array.from({ length: 50 }, (_, i) => row(String(600 + i), 101)) })
        .mockImplementation(async () => ({ positions: [] }));

      await runOnce(service);

      expect(enqueueFn).toHaveBeenCalledTimes(50);
      expect(warn).not.toHaveBeenCalled();
    });
  });

  describe('source gating', () => {
    it('alerts and starts nothing when the integration has no indexer URL', async () => {
      const { service, warn } = makeService({
        integration: { ...integration, subgraphUrl: undefined },
      });

      await runOnce(service, 40);

      expect(requestMock).not.toHaveBeenCalled();
      // A listener that skips a chain looks exactly like a quiet chain; that
      // ambiguity is what let the previous one sit dead.
      expect(String(warn.mock.calls[0][0])).toMatch(/live\.no_source/);
    });

    it('skips an adapter that is not in aggregates recompute mode', async () => {
      const { service, warn } = makeService({ recomputeMode: 'transactions' });

      await runOnce(service, 40);

      // The feed reads per-position aggregates; a transactions-mode protocol has
      // no `updatedAtBlock` column to order by.
      expect(requestMock).not.toHaveBeenCalled();
      expect(String(warn.mock.calls[0][0])).toMatch(/not aggregates-mode/);
    });

    it('starts nothing at all when live refresh is disabled', async () => {
      const { service } = makeService();
      (service as unknown as { config: { liveRefreshEnabled: boolean } }).config.liveRefreshEnabled = false;

      await runOnce(service, 40);

      expect(requestMock).not.toHaveBeenCalled();
    });
  });

  // A cursor ABOVE the indexer's frontier is a PERMANENT, SILENT freeze: every
  // poll asks `updatedAtBlock_gt <cursor>`, matches nothing, logs nothing, and
  // reads exactly like a quiet chain. Observed live on the indexer deployment then in use — a rebuild
  // landed BEHIND the previous deployment (chain 43114 cursor 84,600,385 vs
  // indexer max 83,419,281) while Mongo kept the higher cursor.
  it('detects a cursor stranded above the indexer head, alerts, and resets it', async () => {
    const { service, syncRepo, warn } = makeService();
    syncRepo.getCursor.mockResolvedValue({ liveBlockNumber: 84_600_385, liveBlockTimestamp: 0 } as never);

    requestMock.mockImplementation(async (query: string) => {
      if (isFeedQuery(query)) return { positions: [] };
      return { positions: [{ updatedAtBlock: '83419281', updatedAtTimestamp: '1700000000' }] };
    });

    await runOnce(service);

    expect(warn.mock.calls.flat().join(' ')).toContain('live.cursor_ahead_of_indexer');

    // Reset to the indexer's head — NOT to 0. The file's seeding guard exists
    // because `_gt 0` walks the entire index; the repair must not reintroduce it.
    const reset = syncRepo.markLiveCursor.mock.calls.at(-1);
    expect(reset?.[2]).toBe(83_419_281);
    expect(reset?.[3]).toBe(1_700_000_000);
    // The PERSISTED cursor is the assertion that matters: the stranded state is
    // inherited from Mongo at boot, so a repair that only fixed the in-memory
    // value would be undone by the next restart. (The following poll cannot be
    // observed here — `baseInterval` is `max(pollMin, chain.blockTimeMs)`, i.e.
    // 12s on chain 1, so one run covers exactly one poll.)
  });

  it('leaves a merely quiet chain alone when the cursor is at or behind the head', async () => {
    const { service, syncRepo, warn } = makeService();
    syncRepo.getCursor.mockResolvedValue({ liveBlockNumber: 100, liveBlockTimestamp: 0 } as never);

    requestMock.mockImplementation(async (query: string) => {
      if (isFeedQuery(query)) return { positions: [] };
      return { positions: [{ updatedAtBlock: '100', updatedAtTimestamp: '1700000000' }] };
    });

    await runOnce(service);

    expect(warn).not.toHaveBeenCalled();
    expect(syncRepo.markLiveCursor).not.toHaveBeenCalled();
    expect(boundOf(feedCalls().at(-1) as unknown[])).toBe('100');
  });

  // A probe that returns nothing proves nothing — an empty head must never be
  // read as "the indexer is at 0", which would reset every cursor to zero and
  // turn a quiet chain into a full-index walk.
  it('does not reset the cursor when the head probe comes back empty', async () => {
    const { service, syncRepo, warn } = makeService();
    syncRepo.getCursor.mockResolvedValue({ liveBlockNumber: 84_600_385, liveBlockTimestamp: 0 } as never);

    requestMock.mockImplementation(async () => ({ positions: [] }));

    await runOnce(service);

    expect(warn).not.toHaveBeenCalled();
    expect(syncRepo.markLiveCursor).not.toHaveBeenCalled();
  });

});
