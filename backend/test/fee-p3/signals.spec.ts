/*
 * Fee signals (design §9.4): the in-process transport and the Redis transport
 * obey ONE set of rules — the memory one is today's queues, the Redis one the
 * same rules as Lua. Every rule is driven through BOTH (the Redis one over the
 * TS emulation in fake-redis.ts; the real Lua is pinned by the opt-in
 * signals-redis-contract.spec.ts), plus a random sequence compared step by step.
 */
import { describe, expect, it } from 'vitest';
import {
  BACKFILL_MAX_PER_CHAIN,
  DIRTY_MAX_PER_CHAIN,
  FORCE_REREAD,
  MemoryFeeSignals,
  RedisFeeSignals,
  VIEW_COOLDOWN_MS,
  VIEW_QUEUE_MAX_PER_CHAIN,
  decodeBlock,
  encodeBlock,
  feeSignalKeys,
  resolveSignalsTransport,
  type FeeSignals,
} from '../../src/sync/fee-signals.js';
import { FakeFeeRedis } from './fake-redis.js';

const KEY = '4663:uniswap-v4';

function transports(clock: () => number = () => Date.now()): Array<[string, () => { s: FeeSignals; redis?: FakeFeeRedis }]> {
  return [
    ['memory', () => ({ s: new MemoryFeeSignals() })],
    [
      'redis',
      () => {
        const redis = new FakeFeeRedis(clock);
        return { s: new RedisFeeSignals(async () => redis, 'ns'), redis };
      },
    ],
  ];
}

describe.each(transports())('fee signals rules — %s transport', (_name, make) => {
  it('markViewed: queued once, then cooling; the cooldown starts only when queued', async () => {
    const { s } = make();
    const t = Date.now();
    expect(await s.markViewed(KEY, '7', t)).toBe('queued');
    expect(await s.markViewed(KEY, '7', t + 1)).toBe('cooling');
    expect((await s.sizes(KEY)).views).toBe(1);
  });

  it('markViewed: a full queue queues nothing and sets NO cooldown', async () => {
    const { s } = make();
    const t = Date.now();
    for (let i = 0; i < VIEW_QUEUE_MAX_PER_CHAIN; i++) expect(await s.markViewed(KEY, String(1000 + i), t)).toBe('queued');
    expect(await s.markViewed(KEY, '7', t)).toBe('full');
    // Room again: the same id queues at once (no cooldown was left behind).
    await s.takeViews(KEY, 1);
    expect(await s.markViewed(KEY, '7', t + 1)).toBe('queued');
  });

  it('requeueViews: an id that no longer fits loses its cooldown (DEL vcool)', async () => {
    const { s } = make();
    const t = Date.now();
    expect(await s.markViewed(KEY, '7', t)).toBe('queued');
    expect(await s.takeViews(KEY, 10)).toEqual(['7']);
    for (let i = 0; i < VIEW_QUEUE_MAX_PER_CHAIN; i++) await s.markViewed(KEY, String(1000 + i), t);
    await s.requeueViews(KEY, ['7']);
    expect((await s.sizes(KEY)).views).toBe(VIEW_QUEUE_MAX_PER_CHAIN);
    await s.takeViews(KEY, 1);
    // No cooldown left: a re-open queues it straight away.
    expect(await s.markViewed(KEY, '7', t + 1)).toBe('queued');
  });

  it('requeueViews: an id that fits goes back and keeps its cooldown', async () => {
    const { s } = make();
    const t = Date.now();
    await s.markViewed(KEY, '7', t);
    await s.takeViews(KEY, 10);
    await s.requeueViews(KEY, ['7']);
    expect((await s.sizes(KEY)).views).toBe(1);
    expect(await s.markViewed(KEY, '7', t + 1)).toBe('cooling');
  });

  it('markDirty: re-marking keeps the LATER block, ∞ always wins', async () => {
    const { s } = make();
    await s.markDirty(KEY, 'live', [['7', 500]]);
    await s.markDirty(KEY, 'live', [['7', 400]]);
    await s.markDirty(KEY, 'live', [['7', 900]]);
    expect([...(await s.takeDirty(KEY, 'live', 10))]).toEqual([['7', 900]]);
    await s.markDirty(KEY, 'live', [['8', 900]]);
    await s.markDirty(KEY, 'live', [['8', FORCE_REREAD]]);
    expect((await s.takeDirty(KEY, 'live', 10)).get('8')).toBe(FORCE_REREAD);
  });

  it('a live mark moves an id out of the backfill lane with max(block, backfillBlock)', async () => {
    const { s } = make();
    await s.markDirty(KEY, 'backfill', [['7', 800]]);
    await s.markDirty(KEY, 'live', [['7', 500]]);
    expect(await s.sizes(KEY)).toEqual({ views: 0, live: 1, backfill: 0 });
    expect((await s.takeDirty(KEY, 'live', 10)).get('7')).toBe(800);
  });

  it('a backfill mark of a live-held id updates the live entry (and stays there)', async () => {
    const { s } = make();
    await s.markDirty(KEY, 'live', [['7', 500]]);
    await s.markDirty(KEY, 'backfill', [['7', 900]]);
    expect(await s.sizes(KEY)).toEqual({ views: 0, live: 1, backfill: 0 });
    expect((await s.takeDirty(KEY, 'live', 10)).get('7')).toBe(900);
  });

  it('drains are FIFO by first arrival; a re-mark keeps its place', async () => {
    const { s } = make();
    await s.markDirty(KEY, 'live', [
      ['3', 1],
      ['1', 1],
      ['2', 1],
    ]);
    await s.markDirty(KEY, 'live', [['3', 5]]);
    expect([...(await s.takeDirty(KEY, 'live', 2)).keys()]).toEqual(['3', '1']);
    expect([...(await s.takeDirty(KEY, 'live', 2)).keys()]).toEqual(['2']);
  });

  it('a full backfill lane drops new ids (counted) and still updates held ones', async () => {
    const { s } = make();
    const fill: Array<[string, number]> = Array.from({ length: BACKFILL_MAX_PER_CHAIN }, (_, i) => [String(10_000 + i), 1]);
    expect(await s.markDirty(KEY, 'backfill', fill)).toBe(0);
    expect(await s.markDirty(KEY, 'backfill', [['7', 1], ['10000', 9]])).toBe(1);
    expect((await s.sizes(KEY)).backfill).toBe(BACKFILL_MAX_PER_CHAIN);
    expect((await s.takeDirty(KEY, 'backfill', 1)).get('10000')).toBe(9);
  });

  it('a full live set leaves a backfill-held id in the backfill lane, drops the rest', async () => {
    const { s } = make();
    const fill: Array<[string, number]> = Array.from({ length: DIRTY_MAX_PER_CHAIN }, (_, i) => [String(100_000 + i), 1]);
    await s.markDirty(KEY, 'live', fill);
    await s.markDirty(KEY, 'backfill', [['7', 5]]);
    expect(await s.markDirty(KEY, 'live', [['7', 8], ['8', 8]])).toBe(1);
    const sizes = await s.sizes(KEY);
    expect(sizes.live).toBe(DIRTY_MAX_PER_CHAIN);
    expect(sizes.backfill).toBe(1);
    expect((await s.takeDirty(KEY, 'backfill', 10)).get('7')).toBe(8);
  });
});

describe('both transports agree step by step (random sequence)', () => {
  function mulberry32(seed: number) {
    return () => {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  for (const seed of [1, 7, 42]) {
    it(`seed ${seed}`, async () => {
      let clock = 1_000_000;
      const mem = new MemoryFeeSignals();
      const fake = new FakeFeeRedis(() => clock);
      const red = new RedisFeeSignals(async () => fake, 'ns');
      const rnd = mulberry32(seed);
      const id = () => String(1 + Math.floor(rnd() * 40));
      const block = () => (rnd() < 0.1 ? FORCE_REREAD : 1 + Math.floor(rnd() * 50));
      for (let step = 0; step < 2_000; step++) {
        const op = rnd();
        if (op < 0.2) {
          const i = id();
          expect(await red.markViewed(KEY, i, clock), `step ${step} view ${i}`).toBe(mem.markViewed(KEY, i, clock));
        } else if (op < 0.25) {
          const ids = [id(), id()];
          mem.requeueViews(KEY, ids);
          await red.requeueViews(KEY, ids);
        } else if (op < 0.3) {
          const a = mem.takeViews(KEY, 3).sort();
          const b = (await red.takeViews(KEY, 3)).sort();
          expect(b, `step ${step}`).toEqual(a);
        } else if (op < 0.75) {
          const lane = rnd() < 0.5 ? 'live' : 'backfill';
          const entries: Array<[string, number]> = [
            [id(), block()],
            [id(), block()],
          ];
          expect(await red.markDirty(KEY, lane, entries)).toBe(mem.markDirty(KEY, lane, entries));
        } else if (op < 0.95) {
          const lane = rnd() < 0.5 ? 'live' : 'backfill';
          const n = 1 + Math.floor(rnd() * 4);
          expect([...(await red.takeDirty(KEY, lane, n))], `step ${step} take ${lane}`).toEqual([...mem.takeDirty(KEY, lane, n)]);
        } else {
          clock += Math.floor(rnd() * VIEW_COOLDOWN_MS);
        }
        expect(await red.sizes(KEY)).toEqual(mem.sizes(KEY));
      }
    });
  }
});

describe('Redis transport failure policy', () => {
  it('a Redis error queues the mark in-process (counted, one alert) and the drain takes it from there first', async () => {
    const fake = new FakeFeeRedis();
    const warns: string[] = [];
    const red = new RedisFeeSignals(async () => fake, 'ns', (l) => warns.push(l));
    fake.failing = true;
    expect(await red.markDirty(KEY, 'live', [['7', 5]])).toBe(0);
    expect(await red.markViewed(KEY, '9', Date.now())).toBe('queued');
    expect(red.fallbacks).toBe(2);
    expect(warns.filter((w) => w.includes('[alert] fees.signals_redis'))).toHaveLength(1);
    fake.failing = false;
    await red.markDirty(KEY, 'live', [['8', 6]]);
    expect([...(await red.takeDirty(KEY, 'live', 10))]).toEqual([
      ['7', 5],
      ['8', 6],
    ]);
    expect(await red.takeViews(KEY, 10)).toEqual(['9']);
  });

  it('no client at all is a failure too (redis-state unavailable)', async () => {
    const red = new RedisFeeSignals(async () => undefined, 'ns');
    await red.markDirty(KEY, 'backfill', [['7', 5]]);
    expect(red.local.sizes(KEY).backfill).toBe(1);
  });

  it('keys are namespaced per deployment and chain', () => {
    expect(feeSignalKeys('abc', KEY).seqLive).toBe('tw:fee:v1:abc:sig:4663:uniswap-v4:seq:live');
    expect(feeSignalKeys('abc', KEY).vcoolPrefix).toBe('tw:fee:v1:abc:sig:4663:uniswap-v4:vcool:');
  });

  it('block encoding: ∞ ⇄ "inf", integers exact', () => {
    expect(encodeBlock(FORCE_REREAD)).toBe('inf');
    expect(decodeBlock('inf')).toBe(FORCE_REREAD);
    expect(decodeBlock(encodeBlock(123456789))).toBe(123456789);
    expect(decodeBlock(false)).toBe(FORCE_REREAD);
  });
});

describe('transport resolution', () => {
  it('auto → redis exactly when leases are on; explicit settings win', () => {
    expect(resolveSignalsTransport('auto', false)).toBe('memory');
    expect(resolveSignalsTransport('auto', true)).toBe('redis');
    expect(resolveSignalsTransport('memory', true)).toBe('memory');
    expect(resolveSignalsTransport('redis', false)).toBe('redis');
  });
});
