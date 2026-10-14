/*
 * The /api budget refunds a count's miss surcharge when the count was cached.
 * `resolveCountRoute` says so through `meta.cache` (so `X-Cache` on the count
 * routes): hit = every shard's count was already cached; anything else = miss.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetReadPathMeter } from '../../src/common/cache/read-path-meter.js';
import type { ReadMeta } from '../../src/common/cache/swr-cache.js';
import { LeaderboardCountService, resolveCountRoute } from '../../src/leaderboard/count-cache.js';

beforeEach(() => resetReadPathMeter());

const task = (key: string, count = 7) => ({ key, run: async () => ({ count, capped: false }) });

describe('resolveCountRoute: meta.cache', () => {
  it('miss on the first ask (the scan ran), hit on the next (cached)', async () => {
    const counts = new LeaderboardCountService();
    const first: ReadMeta = {};
    expect(await resolveCountRoute({ route: 'positions', counts, meta: first, tasks: async () => [task('k')] })).toEqual({ total: 7, capped: false });
    expect(first.cache).toBe('miss');
    const second: ReadMeta = {};
    await resolveCountRoute({ route: 'positions', counts, meta: second, tasks: async () => [task('k')] });
    expect(second.cache).toBe('hit');
  });

  it('is a miss while any shard is not cached', async () => {
    const counts = new LeaderboardCountService();
    await resolveCountRoute({ route: 'positions', counts, tasks: async () => [task('a')] });
    const meta: ReadMeta = {};
    await resolveCountRoute({ route: 'positions', counts, meta, tasks: async () => [task('a'), task('b')] });
    expect(meta.cache).toBe('miss');
    const again: ReadMeta = {};
    await resolveCountRoute({ route: 'positions', counts, meta: again, tasks: async () => [task('a'), task('b')] });
    expect(again.cache).toBe('hit');
  });

  it('is a miss (and no-store) when the count is not in yet', async () => {
    const meta: ReadMeta = {};
    const res = await resolveCountRoute({
      route: 'positions',
      counts: new LeaderboardCountService(),
      meta,
      waitMs: 5,
      tasks: async () => [{ key: 'slow', run: () => new Promise(() => undefined) }],
    });
    expect(res).toEqual({ total: null, capped: false, pending: true });
    expect(meta).toMatchObject({ cache: 'miss', noStore: true });
  });

  it('is a miss when building the plan failed', async () => {
    const meta: ReadMeta = {};
    await resolveCountRoute({
      route: 'positions',
      counts: new LeaderboardCountService(),
      meta,
      tasks: async () => {
        throw new Error('exclusion set not loaded');
      },
    });
    expect(meta.cache).toBe('miss');
  });
});
