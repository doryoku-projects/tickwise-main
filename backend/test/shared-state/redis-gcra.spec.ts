/*
 * The generic bucket every P2.2 budget is built on. `LocalGcra` is both the
 * Redis-down fallback and the reference model the Lua is checked against
 * (test/shared-state/redis-contract.spec.ts, opt-in, real Redis).
 */
import { describe, expect, it } from 'vitest';
import {
  decodeGcraReply,
  gcraArgs,
  geckoTerminalGcraBackend,
  LocalGcra,
  RedisGcra,
} from '../../src/common/redis-gcra.js';
import { decodeGcraCall, FakeSharedRedis } from './fake-redis.js';

function clock(start = 1_000_000) {
  const c = { t: start, now: () => c.t };
  return c;
}

describe('LocalGcra (the reference model)', () => {
  it('starts full, takes, then makes the next caller wait (cost/rate)', () => {
    const c = clock();
    const g = new LocalGcra(c.now);
    const b = { key: 'k', perSec: 10, burst: 2, cost: 1 };
    expect(g.take({ buckets: [b], maxWaitMs: -1 })).toEqual({ status: 'taken', waitMs: 0, counter: undefined });
    expect(g.take({ buckets: [b], maxWaitMs: -1 })).toMatchObject({ status: 'taken', waitMs: 0 });
    // Empty: the third waits 100 ms (1 token at 10/s) and goes into debt.
    expect(g.take({ buckets: [b], maxWaitMs: -1 })).toMatchObject({ status: 'taken', waitMs: 100 });
    expect(g.peek('k')?.tokens).toBeCloseTo(-1);
    c.t += 100; // repays the debt exactly: the next caller waits a full token again
    expect(g.take({ buckets: [b], maxWaitMs: -1 })).toMatchObject({ status: 'taken', waitMs: 100 });
    c.t += 300; // back above one token
    expect(g.take({ buckets: [b], maxWaitMs: -1 })).toMatchObject({ status: 'taken', waitMs: 0 });
  });

  it('a wait past maxWait takes NOTHING (refill still recorded)', () => {
    const c = clock();
    const g = new LocalGcra(c.now);
    const b = { key: 'k', perSec: 1, burst: 1, cost: 1 };
    g.take({ buckets: [b], maxWaitMs: 0 });
    expect(g.take({ buckets: [b], maxWaitMs: 0 })).toEqual({ status: 'refused', waitMs: 1000 });
    expect(g.peek('k')?.tokens).toBeCloseTo(0);
    c.t += 1000;
    expect(g.take({ buckets: [b], maxWaitMs: 0 }).status).toBe('taken');
  });

  it('two buckets are taken atomically: one short → neither is debited', () => {
    const g = new LocalGcra(clock().now);
    const all = { key: 'all', perSec: 10, burst: 5, cost: 1 };
    const bg = { key: 'bg', perSec: 1, burst: 1, cost: 1 };
    expect(g.take({ buckets: [all, bg], maxWaitMs: 0 }).status).toBe('taken');
    expect(g.take({ buckets: [all, bg], maxWaitMs: 0 })).toEqual({ status: 'refused', waitMs: 1000 });
    expect(g.peek('all')?.tokens).toBeCloseTo(4); // not 3: the refused take left `all` alone
    expect(g.take({ buckets: [all], maxWaitMs: 0 }).status).toBe('taken'); // interactive needs only `all`
  });

  it('a live pause refuses before anything is taken; a shorter pause never shortens a longer one', () => {
    const c = clock();
    const g = new LocalGcra(c.now);
    const b = { key: 'k', perSec: 10, burst: 5, cost: 1 };
    g.pause('p', 5000);
    g.pause('p', 1000);
    expect(g.take({ buckets: [b], maxWaitMs: -1, pauseKey: 'p' })).toEqual({ status: 'paused', waitMs: 5000 });
    expect(g.peek('k')).toBeUndefined();
    c.t += 5000;
    expect(g.take({ buckets: [b], maxWaitMs: -1, pauseKey: 'p' }).status).toBe('taken');
  });

  it('the counter moves only on a successful take', () => {
    const g = new LocalGcra(clock().now);
    const b = { key: 'k', perSec: 1, burst: 3, cost: 3 };
    const counter = { key: 'm', by: 3, ttlSec: 60 };
    expect(g.take({ buckets: [b], maxWaitMs: 0, counter })).toMatchObject({ status: 'taken', counter: 3 });
    expect(g.take({ buckets: [b], maxWaitMs: 0, counter })).toMatchObject({ status: 'refused' });
    expect(g.take({ buckets: [b], maxWaitMs: -1, counter })).toMatchObject({ status: 'taken', counter: 6 });
  });
});

describe('Lua argument encoding', () => {
  it('round-trips buckets, pause and counter in the KEYS/ARGV order the script reads', () => {
    const req = {
      buckets: [
        { key: 'a', perSec: 15, burst: 30, cost: 1 },
        { key: 'b', perSec: 10, burst: 20, cost: 2 },
      ],
      maxWaitMs: 250,
      pauseKey: 'p',
      counter: { key: 'm', by: 3, ttlSec: 99 },
      ttlMs: 1234,
    };
    const { keys, argv } = gcraArgs(req);
    expect(keys).toEqual(['a', 'b', 'p', 'm']);
    expect(decodeGcraCall(keys.length, [...keys, ...argv])).toEqual(req);
  });

  it('counter without pause sits right after the buckets', () => {
    const { keys, argv } = gcraArgs({ buckets: [{ key: 'a', perSec: 1, burst: 1, cost: 1 }], maxWaitMs: -1, counter: { key: 'm', by: 1, ttlSec: 5 } });
    expect(keys).toEqual(['a', 'm']);
    expect(argv.slice(0, 6)).toEqual(['1', '-1', '60000', '0', '1', '5']);
  });

  it('decodes the three reply codes and refuses anything else', () => {
    expect(decodeGcraReply([12, 1, 7])).toEqual({ status: 'taken', waitMs: 12, counter: 7 });
    expect(decodeGcraReply([0, 1, 0])).toEqual({ status: 'taken', waitMs: 0, counter: undefined });
    expect(decodeGcraReply([-40, 0, 0])).toEqual({ status: 'refused', waitMs: 40 });
    expect(decodeGcraReply([-900, 2, 0])).toEqual({ status: 'paused', waitMs: 900 });
    expect(() => decodeGcraReply('OK')).toThrow();
  });
});

describe('RedisGcra', () => {
  it('answers undefined (caller falls back) with no client or a failing command', async () => {
    const redis = new FakeSharedRedis();
    const errors: unknown[] = [];
    const none = new RedisGcra(async () => undefined);
    expect(await none.take({ buckets: [{ key: 'k', perSec: 1, burst: 1, cost: 1 }], maxWaitMs: 0 })).toBeUndefined();
    redis.failing = true;
    const down = new RedisGcra(async () => redis as never, (e) => errors.push(e));
    expect(await down.take({ buckets: [{ key: 'k', perSec: 1, burst: 1, cost: 1 }], maxWaitMs: 0 })).toBeUndefined();
    expect(await down.pause('p', 10)).toBe(false);
    expect(errors).toHaveLength(2);
  });
});

describe('GeckoTerminal adapter (package E contract)', () => {
  it('≥ 0 = taken wait, < 0 = refused, throws when Redis is unavailable', async () => {
    const c = clock();
    const redis = new FakeSharedRedis(c.now);
    const backend = geckoTerminalGcraBackend(new RedisGcra(async () => redis as never));
    expect(await backend.take('tw:gt:v1:all', 30, 1, 0)).toBe(0);
    expect(await backend.take('tw:gt:v1:all', 30, 1, 0)).toBe(-2000); // 30/min → 2 s per token
    expect(await backend.take('tw:gt:v1:all', 30, 1, 5000)).toBe(2000);
    const down = geckoTerminalGcraBackend(new RedisGcra(async () => undefined));
    await expect(down.take('k', 30, 1, 0)).rejects.toThrow(/unavailable/);
  });
});
