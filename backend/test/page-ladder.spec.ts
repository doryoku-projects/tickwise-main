import { describe, expect, it, vi } from 'vitest';
import { decodeLadderValue, encodeLadderValue, PageLadderService } from '../src/common/cache/page-ladder.js';
import type { LadderRungLike } from '../src/common/shard-stream-merge.js';

const rung = (offset: number, at: number, value: unknown = offset, id = String(offset)): LadderRungLike => ({
  offset,
  at,
  value,
  id,
  chainId: 1,
  counts: { 1: offset },
});

/** Enough of an ioredis ZSET for the ladder: score-sorted members, MULTI, PEXPIRE. */
function fakeRedis() {
  const zsets = new Map<string, Array<{ score: number; member: string }>>();
  const ttl = new Map<string, number>();
  const zset = (key: string) => zsets.get(key) ?? (zsets.set(key, []), zsets.get(key)!);
  const client = {
    zsets,
    ttl,
    zrevrangebyscore: vi.fn(async (key: string, max: number, _min: string, _limit: string, offset: number, count: number) =>
      zset(key)
        .filter((e) => e.score <= max)
        .sort((a, b) => b.score - a.score)
        .slice(offset, offset + count)
        .map((e) => e.member),
    ),
    multi: () => {
      const ops: Array<() => unknown> = [];
      const tx = {
        zrangebyscore: (key: string, min: number, max: number) => {
          ops.push(() => zset(key).filter((e) => e.score >= min && e.score <= max).map((e) => e.member));
          return tx;
        },
        zremrangebyscore: (key: string, min: number, max: number) => {
          ops.push(() => zsets.set(key, zset(key).filter((e) => e.score < min || e.score > max)));
          return tx;
        },
        zadd: (key: string, score: number, member: string) => {
          ops.push(() => zset(key).push({ score, member }));
          return tx;
        },
        zremrangebyrank: (key: string, start: number, stop: number) => {
          ops.push(() => {
            const sorted = zset(key).sort((a, b) => a.score - b.score);
            const end = stop < 0 ? sorted.length + stop : stop;
            zsets.set(key, sorted.filter((_, i) => i < start || i > end));
          });
          return tx;
        },
        pexpire: (key: string, ms: number) => {
          ops.push(() => ttl.set(key, ms));
          return tx;
        },
        exec: async () => ops.map((op) => [null, op() ?? null]),
      };
      return tx;
    },
  };
  return client;
}

function readPathRedis(client: unknown) {
  return { namespace: 'prod0000aaaa1111', client: async () => client, logError: vi.fn() };
}

describe('page ladder', () => {
  it('trusts a rung only within the staleness budget (45 s), and returns the deepest one at or before the offset', async () => {
    let now = 100_000;
    const ladder = new PageLadderService(undefined, undefined, () => now);
    ladder.record('q', [rung(1_000, now), rung(2_000, now), rung(3_000, now)]);
    expect((await ladder.nearest('q', 2_500))?.offset).toBe(2_000);
    expect((await ladder.nearest('q', 3_000))?.offset).toBe(3_000);
    expect(await ladder.nearest('q', 999)).toBeUndefined();
    expect(await ladder.nearest('other', 5_000)).toBeUndefined();
    now += 45_000;
    expect((await ladder.nearest('q', 2_500))?.offset).toBe(2_000); // exactly the budget: still trusted
    now += 1;
    expect(await ladder.nearest('q', 2_500)).toBeUndefined();
  });

  it('takes its trust window from READ_STALENESS_BUDGET_MS', async () => {
    let now = 0;
    const ladder = new PageLadderService({ readStalenessBudgetMs: 10_000 } as never, undefined, () => now);
    ladder.record('q', [rung(1_000, now)]);
    now = 10_001;
    expect(await ladder.nearest('q', 1_000)).toBeUndefined();
  });

  it('a re-walk replaces the rung at the same offset', async () => {
    let now = 0;
    const ladder = new PageLadderService(undefined, undefined, () => now);
    ladder.record('q', [rung(1_000, now, 5, 'a')]);
    now = 20_000;
    ladder.record('q', [rung(1_000, now, 7, 'b')]);
    expect(await ladder.nearest('q', 1_000)).toMatchObject({ value: 7, id: 'b', at: 20_000 });
  });

  it('round-trips every boundary bracket through JSON (null, NaN, ±Infinity, numbers, strings) and refuses objects', () => {
    for (const value of [null, NaN, Infinity, -Infinity, -0.5, 0, 12.25, '3559231', '']) {
      const decoded = decodeLadderValue(JSON.parse(JSON.stringify(encodeLadderValue(value))));
      expect(decoded.ok).toBe(true);
      expect(Object.is((decoded as { value: unknown }).value, value) || (decoded as { value: unknown }).value === value).toBe(true);
    }
    expect(decodeLadderValue(JSON.parse(JSON.stringify(encodeLadderValue(undefined))))).toEqual({ ok: true, value: null });
    expect(encodeLadderValue({ a: 1 })).toBeUndefined();
    expect(encodeLadderValue(true)).toBeUndefined();
    expect(decodeLadderValue({ n: 'x' })).toEqual({ ok: false });
  });

  it('shares rungs through Redis: one ZSET per query, a hard TTL of the budget, deepest kept', async () => {
    const redis = fakeRedis();
    let now = 50_000;
    const writer = new PageLadderService(undefined, readPathRedis(redis) as never, () => now);
    writer.record('pos|q', [rung(1_000, now), rung(2_000, now, NaN), rung(3_000, now, null)]);
    await new Promise((r) => setTimeout(r, 0));
    const [key] = [...redis.zsets.keys()];
    expect(key).toMatch(/^tw:lad:v1:prod0000aaaa1111:[0-9a-f]{40}$/);
    // A hard TTL: the longest a rung is KEPT (the aged-start window, 10 min by default).
    expect(redis.ttl.get(key!)).toBe(600_000);

    // Another process (empty local copy) finds them.
    const reader = new PageLadderService(undefined, readPathRedis(redis) as never, () => now);
    expect(await reader.nearest('pos|q', 2_999)).toMatchObject({ offset: 2_000, chainId: 1, counts: { 1: 2_000 } });
    expect(Number.isNaN((await reader.nearest('pos|q', 2_999))!.value)).toBe(true);
    expect((await reader.nearest('pos|q', 9_000))!.value).toBeNull();
    now += 46_000;
    expect(await reader.nearest('pos|q', 2_999)).toBeUndefined();
  });

  it('keeps a rung past the budget as an AGED start (asked for with maxAgeMs), up to LEADERBOARD_LADDER_MAX_AGE_MS', async () => {
    let now = 0;
    const ladder = new PageLadderService({ readStalenessBudgetMs: 45_000, leaderboardLadderMaxAgeMs: 120_000 } as never, undefined, () => now);
    ladder.record('q', [rung(1_000, 0), rung(9_000, 0)]);
    now = 60_000;
    expect(await ladder.nearest('q', 9_500)).toBeUndefined(); // not trusted
    expect((await ladder.nearest('q', 9_500, 120_000))?.offset).toBe(9_000); // an aged start
    expect((await ladder.nearest('q', 9_500, 10 * 60_000))?.offset).toBe(9_000); // capped at the store's max age…
    now = 120_001;
    expect(await ladder.nearest('q', 9_500, 10 * 60_000)).toBeUndefined(); // …which also forgets it
  });

  it('never replaces a FRESHER rung at the same offset with an older one (local and Redis)', async () => {
    const redis = fakeRedis();
    let now = 100_000;
    const ladder = new PageLadderService(undefined, readPathRedis(redis) as never, () => now);
    ladder.record('q', [rung(2_000, 90_000, 5, 'fresh')]);
    await new Promise((r) => setTimeout(r, 0));
    // A walk derived from an older anchor passes the same offset later: it must not win.
    ladder.record('q', [rung(2_000, 10_000, 5, 'derived')]);
    await new Promise((r) => setTimeout(r, 0));
    expect(await ladder.nearest('q', 2_000, 600_000)).toMatchObject({ id: 'fresh', at: 90_000 });
    const reader = new PageLadderService(undefined, readPathRedis(redis) as never, () => now);
    expect(await reader.nearest('q', 2_000, 600_000)).toMatchObject({ id: 'fresh', at: 90_000 });
    // A newer measurement does replace it.
    now = 130_000;
    ladder.record('q', [rung(2_000, 125_000, 6, 'newer')]);
    await new Promise((r) => setTimeout(r, 0));
    expect(await reader.nearest('q', 2_000)).toMatchObject({ id: 'newer', at: 125_000 });
  });

  it('the per-process copy alone (Redis off) also keeps the fresher rung at an offset', async () => {
    const ladder = new PageLadderService(undefined, undefined, () => 100_000);
    ladder.record('q', [rung(2_000, 90_000, 5, 'fresh')]);
    ladder.record('q', [rung(2_000, 10_000, 5, 'derived')]);
    expect(await ladder.nearest('q', 2_000, 600_000)).toMatchObject({ id: 'fresh', at: 90_000 });
  });

  it('the per-process copy keeps AGED rungs (up to the max age) when later rungs are recorded', async () => {
    let now = 0;
    const ladder = new PageLadderService(undefined, undefined, () => now);
    ladder.record('q', [rung(9_000, 0)]);
    now = 100_000; // aged (past 45 s), inside the 10-min max age
    ladder.record('q', [rung(1_000, now)]);
    expect((await ladder.nearest('q', 9_500, 600_000))?.offset).toBe(9_000);
  });

  it('a Redis failure is an accelerator lost, never an error: the per-process copy answers', async () => {
    const redis = readPathRedis({
      zrevrangebyscore: async () => {
        throw new Error('ECONNRESET');
      },
      multi: () => {
        throw new Error('ECONNRESET');
      },
    });
    const now = 1_000;
    const ladder = new PageLadderService(undefined, redis as never, () => now);
    ladder.record('q', [rung(1_000, now)]);
    await new Promise((r) => setTimeout(r, 0));
    expect((await ladder.nearest('q', 1_500))?.offset).toBe(1_000);
    expect(redis.logError).toHaveBeenCalled();
  });
});
