/*
 * The fee-signal Lua against a REAL Redis (opt-in): every script must do
 * exactly what `MemoryFeeSignals` (today's queues) does, on long random
 * sequences — views with cooldowns and a full queue, requeues, both dirty
 * lanes with ∞ blocks, cross-lane moves and FIFO drains.
 *
 *   FEE_SIGNALS_TEST_REDIS_URL=redis://127.0.0.1:6398 npx vitest run test/fee-p3/signals-redis-contract.spec.ts
 *
 * Use a THROWAWAY instance: the spec flushes its database before each case.
 * Cooldowns are real PX expiries here, so the sequence never advances a
 * simulated clock past them (the memory side uses the same fixed `now`).
 */
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BACKFILL_MAX_PER_CHAIN,
  DIRTY_MAX_PER_CHAIN,
  FORCE_REREAD,
  MemoryFeeSignals,
  RedisFeeSignals,
  VIEW_QUEUE_MAX_PER_CHAIN,
  type FeeRedis,
} from '../../src/sync/fee-signals.js';

const URL = process.env.FEE_SIGNALS_TEST_REDIS_URL;
const KEY = '4663:uniswap-v4';

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe.skipIf(!URL)('fee signal Lua (real Redis) = MemoryFeeSignals', () => {
  let redis: Redis;
  beforeAll(() => {
    redis = new Redis(URL!, { lazyConnect: false, maxRetriesPerRequest: 1 });
  });
  beforeEach(async () => {
    await redis.flushdb();
  });
  afterAll(async () => {
    await redis.quit();
  });

  for (const seed of [3, 11, 99, 2026]) {
    it(`random sequence, seed ${seed}`, async () => {
      const mem = new MemoryFeeSignals();
      const failures: string[] = [];
      const red = new RedisFeeSignals(async () => redis as unknown as FeeRedis, `contract${seed}`, (l) => failures.push(l));
      const rnd = mulberry32(seed);
      const now = Date.now();
      const id = () => String(1 + Math.floor(rnd() * 60));
      const block = () => (rnd() < 0.1 ? FORCE_REREAD : 1 + Math.floor(rnd() * 80));
      for (let step = 0; step < 1_500; step++) {
        const op = rnd();
        if (op < 0.2) {
          const i = id();
          expect(await red.markViewed(KEY, i, now), `step ${step}`).toBe(mem.markViewed(KEY, i, now));
        } else if (op < 0.25) {
          const ids = [id(), id(), id()];
          mem.requeueViews(KEY, ids);
          await red.requeueViews(KEY, ids);
        } else if (op < 0.3) {
          // SPOP picks at random (design: view order is not significant), so a
          // take empties the queue and the two are compared as sets.
          const a = mem.takeViews(KEY, 10_000).sort();
          const b = (await red.takeViews(KEY, 10_000)).sort();
          expect(b, `step ${step}`).toEqual(a);
        } else if (op < 0.75) {
          const lane = rnd() < 0.5 ? 'live' : 'backfill';
          const entries: Array<[string, number]> = [
            [id(), block()],
            [id(), block()],
            [id(), block()],
          ];
          expect(await red.markDirty(KEY, lane, entries), `step ${step}`).toBe(mem.markDirty(KEY, lane, entries));
        } else {
          const lane = rnd() < 0.5 ? 'live' : 'backfill';
          const n = 1 + Math.floor(rnd() * 5);
          expect([...(await red.takeDirty(KEY, lane, n))], `step ${step} take ${lane}`).toEqual([...mem.takeDirty(KEY, lane, n)]);
        }
        expect(await red.sizes(KEY), `step ${step}`).toEqual(mem.sizes(KEY));
      }
      expect(failures).toEqual([]);
      expect(red.fallbacks).toBe(0);
    });
  }

  it('a full view queue: -1 and no cooldown key; a requeue that does not fit deletes the cooldown', async () => {
    const red = new RedisFeeSignals(async () => redis as unknown as FeeRedis, 'full');
    const now = Date.now();
    expect(await red.markViewed(KEY, '7', now)).toBe('queued');
    expect(await redis.exists('tw:fee:v1:full:sig:4663:uniswap-v4:vcool:7')).toBe(1);
    expect(await red.takeViews(KEY, 1)).toEqual(['7']);
    for (let i = 0; i < VIEW_QUEUE_MAX_PER_CHAIN; i++) await red.markViewed(KEY, String(1000 + i), now);
    expect(await red.markViewed(KEY, '8', now)).toBe('full');
    expect(await redis.exists('tw:fee:v1:full:sig:4663:uniswap-v4:vcool:8')).toBe(0);
    await red.requeueViews(KEY, ['7']);
    expect(await redis.exists('tw:fee:v1:full:sig:4663:uniswap-v4:vcool:7')).toBe(0);
  });

  it('a full backfill lane drops (counted) and keys carry a TTL', async () => {
    const red = new RedisFeeSignals(async () => redis as unknown as FeeRedis, 'cap');
    const fill: Array<[string, number]> = Array.from({ length: BACKFILL_MAX_PER_CHAIN }, (_, i) => [String(10_000 + i), 1]);
    for (let i = 0; i < fill.length; i += 5_000) expect(await red.markDirty(KEY, 'backfill', fill.slice(i, i + 5_000))).toBe(0);
    expect(await red.markDirty(KEY, 'backfill', [['7', 1]])).toBe(1);
    expect(await redis.pttl('tw:fee:v1:cap:sig:4663:uniswap-v4:seq:backfill')).toBeGreaterThan(0);
  });

  it('a full LIVE set: a backfill-held id stays in the backfill lane (updated), any other id is dropped — as in memory', async () => {
    const red = new RedisFeeSignals(async () => redis as unknown as FeeRedis, 'livecap');
    const mem = new MemoryFeeSignals();
    const fill: Array<[string, number]> = Array.from({ length: DIRTY_MAX_PER_CHAIN }, (_, i) => [String(100_000 + i), 1]);
    for (let i = 0; i < fill.length; i += 5_000) {
      const part = fill.slice(i, i + 5_000);
      expect(await red.markDirty(KEY, 'live', part)).toBe(mem.markDirty(KEY, 'live', part));
    }
    for (const s of [red, mem]) await s.markDirty(KEY, 'backfill', [['7', 5]]);
    expect(await red.markDirty(KEY, 'live', [['7', 9], ['8', 9]])).toBe(mem.markDirty(KEY, 'live', [['7', 9], ['8', 9]]));
    expect(await red.sizes(KEY)).toEqual(mem.sizes(KEY));
    expect([...(await red.takeDirty(KEY, 'backfill', 5))]).toEqual([...mem.takeDirty(KEY, 'backfill', 5)]);
  });

  it('blocks round-trip exactly, ∞ included', async () => {
    const red = new RedisFeeSignals(async () => redis as unknown as FeeRedis, 'blk');
    await red.markDirty(KEY, 'live', [
      ['1', 432_424_123],
      ['2', FORCE_REREAD],
    ]);
    expect([...(await red.takeDirty(KEY, 'live', 5))]).toEqual([
      ['1', 432_424_123],
      ['2', FORCE_REREAD],
    ]);
  });
});
