/*
 * The per-IP budget on the keyless /api routes (src/common/api-limit.service.ts).
 *
 * Every number here is chosen so that ONE rule decides the outcome: a refund
 * that did not happen, a window that did not roll back, or an address that was
 * keyed wrongly changes which request is the first refused.
 */
import 'reflect-metadata';
import { EventEmitter } from 'node:events';
import { HttpException } from '@nestjs/common';
import { RateLimiterRes } from 'rate-limiter-flexible';
import { describe, expect, it } from 'vitest';
import { ApiLimitService, API_LIMIT_MESSAGE } from '../../src/common/api-limit.service.js';
import { runInLane, type IndexerRequestStats } from '../../src/subgraph/hyperindex/indexer-context.js';

class FakeRes extends EventEmitter {
  statusCode = 200;
  private readonly headers = new Map<string, unknown>();
  getHeader(name: string): unknown {
    return this.headers.get(name.toLowerCase());
  }
  setHeader(name: string, value: string): this {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }
  /** The response is over (finished, aborted or errored): Node emits `close` either way. */
  end(): void {
    this.emit('close');
  }
}

function config(over: Record<string, unknown> = {}) {
  return {
    apiLimitMode: 'enforce',
    apiLimiterStore: 'memory',
    apiLimitPoints10s: 100,
    apiLimitPointsHour: 100_000,
    apiLimitMaxInFlight: 24,
    apiLimitCountMissPerMin: 3,
    apiReadShare: 1,
    isProduction: false,
    trustProxyHops: 1,
    ...over,
  } as never;
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const IP = '203.0.113.7';

/** `admit` and report how it went: 'ok' | the HttpException's reason. */
async function attempt(
  svc: ApiLimitService,
  kind: 'list' | 'count' | 'detail' | 'chart',
  over: { ip?: string; query?: Record<string, unknown>; res?: FakeRes } = {},
): Promise<{ outcome: string; res: FakeRes }> {
  const res = over.res ?? new FakeRes();
  try {
    await svc.admit(kind, { ip: over.ip ?? IP, query: over.query ?? {} }, res);
    return { outcome: 'ok', res };
  } catch (err) {
    if (err instanceof HttpException) {
      expect(err.getStatus()).toBe(429);
      return { outcome: (err.getResponse() as { reason: string }).reason, res };
    }
    throw err;
  }
}

/** One request that finishes: admitted, answered with `xCache`, closed. */
async function served(svc: ApiLimitService, kind: 'list' | 'count' | 'detail' | 'chart', xCache?: string, status = 200, ip = IP) {
  const { outcome, res } = await attempt(svc, kind, { ip });
  if (outcome === 'ok') {
    res.statusCode = status;
    if (xCache) res.setHeader('X-Cache', xCache);
    res.end();
    await flush();
  }
  return outcome;
}

describe('ApiLimitService: modes', () => {
  it('off reads and writes nothing: no limiter is even built', async () => {
    let built = 0;
    const factory = {
      create: () => {
        built += 1;
        throw new Error('must not be built');
      },
    };
    const svc = new ApiLimitService(config({ apiLimitMode: 'off' }), factory as never);
    for (let i = 0; i < 50; i += 1) expect((await attempt(svc, 'list')).outcome).toBe('ok');
    expect(built).toBe(0);
    expect(svc.runningByAddress.size).toBe(0);
  });

  it('marks the request keyless for the read budget in EVERY mode, off included', async () => {
    for (const apiLimitMode of ['off', 'observe', 'enforce']) {
      const svc = new ApiLimitService(config({ apiLimitMode }));
      const stats: IndexerRequestStats = { indexerMs: 0, indexerCalls: 0, queuedMs: 0 };
      await runInLane({ lane: 'interactive', stats }, () => attempt(svc, 'list'));
      expect(stats.keyless, apiLimitMode).toBe(true);
    }
  });

  it('observe never refuses, yet counts exactly the refusals enforce would have made', async () => {
    const run = async (apiLimitMode: string) => {
      const svc = new ApiLimitService(config({ apiLimitMode, apiLimitPoints10s: 10 }));
      const seen: string[] = [];
      for (let i = 0; i < 6; i += 1) seen.push((await attempt(svc, 'list')).outcome);
      return { seen, svc };
    };
    const enforce = await run('enforce');
    const observe = await run('observe');
    expect(enforce.seen).toEqual(['ok', 'ok', 'ok', 'rate-10s', 'rate-10s', 'rate-10s']);
    expect(observe.seen.every((o) => o === 'ok')).toBe(true);
    const minute = (observe.svc as unknown as { meter: { takeMinute: () => { wouldLimit: Record<string, number>; limited: number } } }).meter.takeMinute();
    expect(minute.wouldLimit).toEqual({ 'rate-10s': 3 });
    expect(minute.limited).toBe(0);
  });

  it('observe refunds a would-be refusal once, not again when its (cached) answer closes', async () => {
    const svc = new ApiLimitService(config({ apiLimitMode: 'observe', apiLimitPoints10s: 10 }));
    for (let i = 0; i < 3; i += 1) await attempt(svc, 'list'); // 9 of 10, none closed
    const over = await attempt(svc, 'list'); // would be refused: its 3 points went back at once
    over.res.setHeader('X-Cache', 'hit');
    over.res.end(); // a second refund of 2 here would open room for the next request
    await flush();
    const again = new ApiLimitService(config({ apiLimitMode: 'enforce', apiLimitPoints10s: 10 }));
    for (let i = 0; i < 3; i += 1) await attempt(again, 'list');
    expect((await attempt(again, 'list')).outcome).toBe('rate-10s');
    // The observe run's next request must be a would-be refusal too (12 > 10), exactly as in enforce.
    const next = await attempt(svc, 'list');
    const minute = (svc as unknown as { meter: { takeMinute: () => { wouldLimit: Record<string, number> } } }).meter.takeMinute();
    expect(next.outcome).toBe('ok');
    expect(minute.wouldLimit).toEqual({ 'rate-10s': 2 });
  });

  it('refuses to enforce in production while TRUST_PROXY_HOPS is 0 (one shared bucket for the whole site)', async () => {
    const gap = new ApiLimitService(config({ isProduction: true, trustProxyHops: 0, apiLimitPoints10s: 3 }));
    expect(gap.mode).toBe('observe');
    for (let i = 0; i < 5; i += 1) expect((await attempt(gap, 'list')).outcome).toBe('ok');
    const counted = new ApiLimitService(config({ isProduction: true, trustProxyHops: 1 }));
    expect(counted.mode).toBe('enforce');
    expect(new ApiLimitService(config({ isProduction: false, trustProxyHops: 0 })).mode).toBe('enforce');
  });
});

describe('ApiLimitService: the points budget', () => {
  it('charges base + surcharge up front, so the third 3-point list fills a 10-point window', async () => {
    const svc = new ApiLimitService(config({ apiLimitPoints10s: 10 }));
    expect(await served(svc, 'list')).toBe('ok');
    expect(await served(svc, 'list')).toBe('ok');
    expect(await served(svc, 'list')).toBe('ok'); // 9 of 10
    expect(await served(svc, 'list')).toBe('rate-10s'); // 12 > 10
  });

  it('gives the surcharge back when the answer came from a cache (hit and stale), and only then', async () => {
    const svc = new ApiLimitService(config({ apiLimitPoints10s: 10 }));
    // Seven cache hits cost 1 each: 7 of 10 used.
    for (let i = 0; i < 7; i += 1) expect(await served(svc, 'list', i % 2 ? 'stale' : 'hit')).toBe('ok');
    expect(await served(svc, 'list', 'miss')).toBe('ok'); // 7 + 3 = 10, a miss keeps its charge
    expect(await served(svc, 'list', 'hit')).toBe('rate-10s'); // 10 + 3 > 10
  });

  it('keeps the charge of a request the client aborted: a script that fires and drops still pays', async () => {
    const svc = new ApiLimitService(config({ apiLimitPoints10s: 10 }));
    for (let i = 0; i < 3; i += 1) {
      const { outcome, res } = await attempt(svc, 'list');
      expect(outcome).toBe('ok');
      res.end(); // closed with no answer written: no X-Cache, nothing to refund
      await flush();
    }
    expect(await served(svc, 'list')).toBe('rate-10s');
  });

  it('keeps the charge of a refused request even when its X-Cache says hit: junk is not cheap', async () => {
    const svc = new ApiLimitService(config({ apiLimitPoints10s: 10 }));
    for (let i = 0; i < 3; i += 1) expect(await served(svc, 'list', 'hit', 400)).toBe('ok');
    // 3 × 3 = 9 still charged
    expect(await served(svc, 'list')).toBe('rate-10s');
  });

  it('refunds a detail or a chart that made no indexer call, and charges one that did', async () => {
    for (const [kind, base, surcharge] of [['detail', 2, 2], ['chart', 5, 3]] as const) {
      const svc = new ApiLimitService(config({ apiLimitPoints10s: base + surcharge + base })); // room for one miss + one more base
      const stats: IndexerRequestStats = { indexerMs: 0, indexerCalls: 0, queuedMs: 0 };
      const { res } = await runInLane({ lane: 'interactive', stats }, () => attempt(svc, kind));
      stats.indexerCalls = 2; // it went to the indexer: the surcharge stays
      res.end();
      await flush();
      expect((await attempt(svc, kind)).outcome, `${kind} after a miss`).toBe('rate-10s');

      const cheap = new ApiLimitService(config({ apiLimitPoints10s: base + surcharge + base }));
      const cheapStats: IndexerRequestStats = { indexerMs: 0, indexerCalls: 0, queuedMs: 0 };
      const first = await runInLane({ lane: 'interactive', stats: cheapStats }, () => attempt(cheap, kind));
      first.res.end(); // no indexer call: the surcharge goes back
      await flush();
      expect((await attempt(cheap, kind)).outcome, `${kind} after a cache answer`).toBe('ok');
    }
  });

  it('prices a deep page and a search above a plain list', async () => {
    const svc = new ApiLimitService(config({ apiLimitPoints10s: 7 }));
    expect((await attempt(svc, 'list', { query: { page: '41', limit: '25' } })).outcome).toBe('ok'); // deep: 5 + 2
    expect((await attempt(svc, 'list')).outcome).toBe('rate-10s');
    const search = new ApiLimitService(config({ apiLimitPoints10s: 5 }));
    expect((await attempt(search, 'list', { query: { search: 'usdc' } })).outcome).toBe('ok'); // 3 + 2
    expect((await attempt(search, 'list')).outcome).toBe('rate-10s');
  });

  it('applies the hourly window after the 10-second one, and rolls back the first when the second refuses', async () => {
    const svc = new ApiLimitService(config({ apiLimitPoints10s: 100, apiLimitPointsHour: 6 }));
    expect(await served(svc, 'list')).toBe('ok');
    expect(await served(svc, 'list')).toBe('ok'); // 6 of 6
    expect(await served(svc, 'list')).toBe('rate-hour');
    // The refused request gave its points back to the 10-second window too:
    // were it not, 3 more would be 9 and 12 > 10 would be the 10-second window's refusal.
    const tight = new ApiLimitService(config({ apiLimitPoints10s: 9, apiLimitPointsHour: 3 }));
    expect(await served(tight, 'list')).toBe('ok');
    for (let i = 0; i < 6; i += 1) expect(await served(tight, 'list')).toBe('rate-hour');
  });

  it('sends a 429 a script can act on: Retry-After, RateLimit headers, no-store, and the /v1 pointer', async () => {
    const svc = new ApiLimitService(config({ apiLimitPoints10s: 3 }));
    await served(svc, 'list');
    const res = new FakeRes();
    let thrown: HttpException | undefined;
    try {
      await svc.admit('list', { ip: IP, query: {} }, res);
    } catch (err) {
      thrown = err as HttpException;
    }
    expect(thrown?.getStatus()).toBe(429);
    const body = thrown!.getResponse() as { error: string; reason: string; retryAfterSeconds: number };
    expect(body.error).toBe(API_LIMIT_MESSAGE);
    expect(body.error).toMatch(/\/v1/);
    expect(body.reason).toBe('rate-10s');
    expect(Number(res.getHeader('retry-after'))).toBeGreaterThanOrEqual(1);
    expect(Number(res.getHeader('retry-after'))).toBeLessThanOrEqual(10);
    expect(body.retryAfterSeconds).toBe(Number(res.getHeader('retry-after')));
    expect(res.getHeader('cache-control')).toBe('no-store');
    expect(res.getHeader('ratelimit-limit')).toBe('3');
    expect(res.getHeader('ratelimit-remaining')).toBe('0');
    expect(res.getHeader('ratelimit-reset')).toBe(res.getHeader('retry-after'));
  });
});

describe('ApiLimitService: the address', () => {
  it('budgets each address on its own', async () => {
    const svc = new ApiLimitService(config({ apiLimitPoints10s: 3 }));
    expect(await served(svc, 'list', undefined, 200, '198.51.100.1')).toBe('ok');
    expect(await served(svc, 'list', undefined, 200, '198.51.100.1')).toBe('rate-10s');
    expect(await served(svc, 'list', undefined, 200, '198.51.100.2')).toBe('ok');
  });

  it('groups IPv6 by its /64, so one household cannot mint 2^64 budgets', async () => {
    const svc = new ApiLimitService(config({ apiLimitPoints10s: 3 }));
    expect(await served(svc, 'list', undefined, 200, '2001:db8:1:2::1')).toBe('ok');
    expect(await served(svc, 'list', undefined, 200, '2001:db8:1:2:ffff:ffff:ffff:9')).toBe('rate-10s');
    expect(await served(svc, 'list', undefined, 200, '2001:db8:1:3::1')).toBe('ok'); // the next /64
  });

  it('sees an IPv4-mapped IPv6 address as the IPv4 it is', async () => {
    const svc = new ApiLimitService(config({ apiLimitPoints10s: 3 }));
    expect(await served(svc, 'list', undefined, 200, '::ffff:198.51.100.9')).toBe('ok');
    expect(await served(svc, 'list', undefined, 200, '198.51.100.9')).toBe('rate-10s');
  });

  it('lets a request through that has no usable address (it cannot be attributed), and counts it', async () => {
    const svc = new ApiLimitService(config({ apiLimitPoints10s: 1 }));
    for (const ip of [undefined, '', 'not-an-ip']) {
      for (let i = 0; i < 3; i += 1) {
        const res = new FakeRes();
        await svc.admit('list', { ...(ip === undefined ? {} : { ip }), query: {} }, res);
      }
    }
    const minute = (svc as unknown as { meter: { takeMinute: () => { failOpen: number } } }).meter.takeMinute();
    expect(minute.failOpen).toBe(9);
  });
});

describe('ApiLimitService: requests running at once', () => {
  it('refuses the request over the cap, releases a slot on close, and never leaks one for a refused request', async () => {
    const svc = new ApiLimitService(config({ apiLimitMaxInFlight: 2 }));
    const a = await attempt(svc, 'list');
    const b = await attempt(svc, 'list');
    expect([a.outcome, b.outcome]).toEqual(['ok', 'ok']);
    expect(svc.runningByAddress.get(IP)).toBe(2);
    const c = await attempt(svc, 'list');
    expect(c.outcome).toBe('in-flight');
    expect(svc.runningByAddress.get(IP)).toBe(3); // counted while it is being answered
    c.res.end(); // the 429 is written and the connection closes
    expect(svc.runningByAddress.get(IP)).toBe(2);
    a.res.end();
    expect(svc.runningByAddress.get(IP)).toBe(1);
    expect((await attempt(svc, 'list')).outcome).toBe('ok');
    b.res.end();
    expect(svc.runningByAddress.get(IP)).toBe(1);
  });

  it('does not charge points for a request refused on the cap', async () => {
    const svc = new ApiLimitService(config({ apiLimitMaxInFlight: 1, apiLimitPoints10s: 4 }));
    const first = await attempt(svc, 'list'); // 3 of 4
    const refused: FakeRes[] = [];
    for (let i = 0; i < 4; i += 1) {
      const r = await attempt(svc, 'list');
      expect(r.outcome).toBe('in-flight');
      refused.push(r.res);
    }
    for (const res of refused) res.end();
    first.res.end();
    await flush();
    // Four refusals at 3 points each would have emptied the window; only the first request's 3 is in it.
    // One more 1-point request fits, a second does not.
    const cheap = await attempt(svc, 'list', { query: { page: '1' } });
    expect(cheap.outcome).toBe('rate-10s'); // 3 + 3 > 4: the first request's charge (no cache header) stays
    const svc2 = new ApiLimitService(config({ apiLimitMaxInFlight: 1, apiLimitPoints10s: 6 }));
    const a = await attempt(svc2, 'list');
    const b = await attempt(svc2, 'list');
    expect(b.outcome).toBe('in-flight');
    a.res.end();
    b.res.end();
    expect((await attempt(svc2, 'list')).outcome).toBe('ok'); // 3 + 3 = 6: the refused one cost nothing
  });

  it('forgets an address once nothing of it is running', async () => {
    const svc = new ApiLimitService(config());
    const a = await attempt(svc, 'list');
    a.res.end();
    expect(svc.runningByAddress.size).toBe(0);
  });
});

describe('ApiLimitService: counts that miss the cache', () => {
  it('allows 3 misses a minute per address and refuses the 4th, whatever the points window says', async () => {
    const svc = new ApiLimitService(config({ apiLimitPoints10s: 10_000, apiLimitPointsHour: 1_000_000, apiLimitCountMissPerMin: 3 }));
    for (let i = 0; i < 3; i += 1) expect(await served(svc, 'count', 'miss')).toBe('ok');
    expect(await served(svc, 'count', 'miss')).toBe('count-miss');
  });

  it('gives the miss slot back for a count answered from the cache, so cached counts are not limited by it', async () => {
    const svc = new ApiLimitService(config({ apiLimitPoints10s: 10_000, apiLimitPointsHour: 1_000_000, apiLimitCountMissPerMin: 3 }));
    for (let i = 0; i < 40; i += 1) expect(await served(svc, 'count', 'hit'), `hit ${i}`).toBe('ok');
    for (let i = 0; i < 3; i += 1) expect(await served(svc, 'count', 'miss')).toBe('ok');
    expect(await served(svc, 'count', 'miss')).toBe('count-miss');
  });

  it('takes the windows in order and gives back everything taken when a later one refuses', async () => {
    const calls: string[] = [];
    // A limiter that records what it is asked and refuses on demand.
    const recorder = (name: string, refuse: () => boolean) => ({
      consume: async (_key: string, points: number) => {
        calls.push(`${name}:consume:${points}`);
        if (refuse()) throw new RateLimiterRes(0, 1000, 99, 0);
        return undefined;
      },
      reward: async (_key: string, points: number) => {
        calls.push(`${name}:reward:${points}`);
        return undefined;
      },
      delete: async () => undefined,
    });
    const refusing = { short: false, hour: false, miss: false };
    const factory = {
      create: (_realm: string, name: string) =>
        recorder(name, () => (name === '10s' ? refusing.short : name === 'hour' ? refusing.hour : refusing.miss)),
    };
    const svc = new ApiLimitService(config(), factory as never);

    refusing.miss = true;
    expect((await attempt(svc, 'count')).outcome).toBe('count-miss');
    // 10s and hour were taken (4 points) and given back; the miss slot's own points went back too.
    expect(calls).toEqual([
      '10s:consume:4',
      'hour:consume:4',
      'count-miss:consume:1',
      'count-miss:reward:1',
      '10s:reward:4',
      'hour:reward:4',
    ]);

    calls.length = 0;
    refusing.miss = false;
    refusing.short = true;
    expect((await attempt(svc, 'count')).outcome).toBe('rate-10s');
    // Refused by the first window: the later ones were never touched.
    expect(calls).toEqual(['10s:consume:4', '10s:reward:4']);
  });
});

describe('ApiLimitService: failing open', () => {
  it('lets a request through when the limiter store errors, in both modes, and counts it', async () => {
    const broken = {
      create: () => ({
        consume: async () => {
          throw new Error('redis down');
        },
        reward: async () => undefined,
        delete: async () => undefined,
      }),
    };
    for (const apiLimitMode of ['observe', 'enforce']) {
      const svc = new ApiLimitService(config({ apiLimitMode }), broken as never);
      expect((await attempt(svc, 'list')).outcome).toBe('ok');
      const minute = (svc as unknown as { meter: { takeMinute: () => { failOpen: number } } }).meter.takeMinute();
      expect(minute.failOpen).toBe(1);
    }
  });
});
