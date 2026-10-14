import { describe, expect, it, vi } from 'vitest';
import { LeaderboardCountService, resolveListPagination, type CountResult } from '../src/leaderboard/count-cache.js';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A count whose completion the test controls. */
function deferredCount() {
  let resolve!: (value: CountResult) => void;
  const run = vi.fn(() => new Promise<CountResult>((r) => (resolve = r)));
  return { run, finish: (count: number, capped = false) => resolve({ count, capped }) };
}

describe('LeaderboardCountService', () => {
  it('peek never waits: undefined at first, one background count, then the value', async () => {
    const counts = new LeaderboardCountService();
    const { run, finish } = deferredCount();
    expect(counts.peek('k', run)).toBeUndefined();
    expect(counts.peek('k', run)).toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1); // single-flight
    finish(42);
    await flush();
    expect(counts.peek('k', run)).toEqual({ count: 42, capped: false });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('get joins the background count a page already started', async () => {
    const counts = new LeaderboardCountService();
    const { run, finish } = deferredCount();
    counts.peek('k', run);
    const awaited = counts.get('k', run);
    finish(7, true);
    expect(await awaited).toEqual({ count: 7, capped: true });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('runs at most two counts at once, across keys and callers', async () => {
    const counts = new LeaderboardCountService();
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const run = () =>
      new Promise<CountResult>((resolve) => {
        active++;
        peak = Math.max(peak, active);
        releases.push(() => {
          active--;
          resolve({ count: 1, capped: false });
        });
      });
    const all = ['a', 'b', 'c', 'd', 'e'].map((key) => counts.get(key, run));
    await flush();
    expect(active).toBe(2);
    while (releases.length > 0) {
      releases.shift()!();
      await flush();
    }
    await Promise.all(all);
    expect(peak).toBe(2);
    expect(counts.activeCounts).toBe(0);
  });

  it('a failed count is remembered: views neither re-run it nor wait on it, until it expires', async () => {
    vi.useFakeTimers();
    try {
      const counts = new LeaderboardCountService();
      const timeout = Object.assign(new Error('operation exceeded time limit'), { code: 50 });
      const run = vi.fn(async (): Promise<CountResult> => {
        throw timeout;
      });
      expect(counts.peek('k', run)).toBeUndefined();
      await vi.advanceTimersByTimeAsync(0);
      expect(run).toHaveBeenCalledTimes(1);
      // Another list view, a /count call and a /v1 wait: no second count.
      expect(counts.peek('k', run)).toBeUndefined();
      await expect(counts.get('k', run)).rejects.toBe(timeout);
      expect(await counts.within('k', run, 2_000)).toBeUndefined();
      expect(run).toHaveBeenCalledTimes(1);
      // Past the memo the count is tried again.
      await vi.advanceTimersByTimeAsync(91_000);
      counts.peek('k', run);
      await vi.advanceTimersByTimeAsync(0);
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the wait queue is bounded: past it a count is refused, not queued, and not remembered as failed', async () => {
    const counts = new LeaderboardCountService();
    const releases: Array<() => void> = [];
    const run = () => new Promise<CountResult>((resolve) => releases.push(() => resolve({ count: 1, capped: false })));
    const queued = Array.from({ length: 2 + 32 }, (_, i) => counts.get(`k${i}`, run));
    await flush();
    await expect(counts.get('overflow', run)).rejects.toThrow('count queue is full');
    while (releases.length > 0) {
      releases.shift()!();
      await flush();
    }
    await Promise.all(queued);
    // The refused key was never a count failure: it runs as soon as asked again.
    await expect(counts.get('overflow', async () => ({ count: 3, capped: false }))).resolves.toEqual({
      count: 3,
      capped: false,
    });
  });

  it('within gives up after its budget, and the count still lands in the cache', async () => {
    vi.useFakeTimers();
    try {
      const counts = new LeaderboardCountService();
      const { run, finish } = deferredCount();
      const waited = counts.within('k', run, 2_000);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await waited).toBeUndefined();
      finish(9);
      await vi.advanceTimersByTimeAsync(0);
      expect(counts.peek('k', run)).toEqual({ count: 9, capped: false });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('resolveListPagination', () => {
  const noTasks = async () => [];

  it('a page with no next row proves its own total — no count needed', async () => {
    const tasks = vi.fn(noTasks);
    const p = await resolveListPagination({
      page: 2,
      limit: 25,
      rowsOnPage: 10,
      hasMore: false,
      counts: new LeaderboardCountService(),
      tasks,
    });
    expect(p).toEqual({ page: 2, limit: 25, total: 35, totalPages: 2, hasMore: false });
    expect(tasks).not.toHaveBeenCalled();
  });

  it('/api: an uncached count is pending — total and totalPages null', async () => {
    const counts = new LeaderboardCountService();
    const { run } = deferredCount();
    const p = await resolveListPagination({
      page: 1,
      limit: 25,
      rowsOnPage: 25,
      hasMore: true,
      counts,
      tasks: async () => [{ key: 'k', run }],
    });
    expect(p).toEqual({ page: 1, limit: 25, total: null, totalPages: null, hasMore: true, totalPending: true });
    expect(run).toHaveBeenCalledTimes(1); // and the count was started
  });

  it('/v1: after the wait, a floor of the rows the page proves, flagged totalCapped', async () => {
    vi.useFakeTimers();
    try {
      const { run } = deferredCount();
      const pending = resolveListPagination({
        page: 3,
        limit: 25,
        rowsOnPage: 25,
        hasMore: true,
        counts: new LeaderboardCountService(),
        countWaitMs: 2_000,
        tasks: async () => [{ key: 'k', run }],
      });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(await pending).toEqual({ page: 3, limit: 25, total: 76, totalPages: 4, hasMore: true, totalCapped: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('sums shard counts and flags a capped one', async () => {
    const counts = new LeaderboardCountService();
    await counts.get('a', async () => ({ count: 25_000, capped: true }));
    await counts.get('b', async () => ({ count: 120, capped: false }));
    const p = await resolveListPagination({
      page: 1,
      limit: 25,
      rowsOnPage: 25,
      hasMore: true,
      counts,
      tasks: async () => [
        { key: 'a', run: async () => ({ count: 0, capped: false }) },
        { key: 'b', run: async () => ({ count: 0, capped: false }) },
      ],
    });
    expect(p).toMatchObject({ total: 25_120, totalPages: 1005, totalCapped: true });
    expect(p.totalPending).toBeUndefined();
  });

  it('a cached count below what the page proves is stale: the floor wins, flagged', async () => {
    const counts = new LeaderboardCountService();
    await counts.get('k', async () => ({ count: 30, capped: false }));
    const p = await resolveListPagination({
      page: 2,
      limit: 25,
      rowsOnPage: 25,
      hasMore: true,
      counts,
      tasks: async () => [{ key: 'k', run: async () => ({ count: 30, capped: false }) }],
    });
    expect(p).toMatchObject({ total: 51, totalCapped: true });
  });

  describe('a page past the end proves nothing about the pages before it', () => {
    it('exact total (pool / lookup shape): the read total, not (page-1)×limit', async () => {
      const p = await resolveListPagination({
        page: 5,
        limit: 25,
        rowsOnPage: 0,
        hasMore: false,
        exactTotal: 40,
        counts: new LeaderboardCountService(),
        tasks: noTasks,
      });
      expect(p).toEqual({ page: 5, limit: 25, total: 40, totalPages: 2, hasMore: false });
    });

    it('cached count: the count, uncapped', async () => {
      const counts = new LeaderboardCountService();
      await counts.get('k', async () => ({ count: 40, capped: false }));
      const p = await resolveListPagination({
        page: 5,
        limit: 25,
        rowsOnPage: 0,
        hasMore: false,
        counts,
        countWaitMs: 2_000,
        tasks: async () => [{ key: 'k', run: async () => ({ count: 40, capped: false }) }],
      });
      expect(p).toEqual({ page: 5, limit: 25, total: 40, totalPages: 2, hasMore: false });
    });

    it('/v1 floor with no count: a floor of 0, never 100', async () => {
      vi.useFakeTimers();
      try {
        const { run } = deferredCount();
        const pending = resolveListPagination({
          page: 5,
          limit: 25,
          rowsOnPage: 0,
          hasMore: false,
          counts: new LeaderboardCountService(),
          countWaitMs: 2_000,
          tasks: async () => [{ key: 'k', run }],
        });
        await vi.advanceTimersByTimeAsync(2_000);
        const p = await pending;
        expect(p.total).toBe(0);
        expect(p.totalCapped).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('uses an exact total the read already knew (pool scope)', async () => {
    const tasks = vi.fn(noTasks);
    const p = await resolveListPagination({
      page: 1,
      limit: 25,
      rowsOnPage: 25,
      hasMore: true,
      exactTotal: 268,
      counts: new LeaderboardCountService(),
      tasks,
    });
    expect(p).toEqual({ page: 1, limit: 25, total: 268, totalPages: 11, hasMore: true });
    expect(tasks).not.toHaveBeenCalled();
  });
});
