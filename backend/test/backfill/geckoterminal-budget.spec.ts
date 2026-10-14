/*
 * GeckoTerminal: the 429-as-HTTP-200 answer, and the fleet-wide call budget
 * (`GECKOTERMINAL_BUDGET`, design §6.2-3).
 *
 *  - A 200 whose body has no `data` (GT's rate-limit body) is a RATE LIMIT:
 *    backoff, no `miss` outcomes, provider unavailable — so the price walk
 *    reads it as UNKNOWN and the consensus sweep never counts it as covered.
 *  - With the budget on, every call takes the lane's token then the shared
 *    one; a lane can use at most its share (backfill 60 %, refresh 50 %,
 *    sweeps 40 % of 30/min); a refused call is NOT made and is a `skip`.
 *  - `off` (default) makes no budget call at all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const responses: Array<{ statusCode: number; body?: unknown }> = [];
const requested: string[] = [];

vi.mock('undici', () => ({
  request: vi.fn(async (url: string) => {
    requested.push(url);
    const next = responses.shift() ?? { statusCode: 200, body: { data: { attributes: { token_prices: {} } } } };
    return {
      statusCode: next.statusCode,
      headers: {},
      body: {
        json: async () => next.body,
        dump: async () => undefined,
      },
    };
  }),
}));

const gt = await import('../../src/pricing/providers/geckoterminal.provider.js');
const { runInLane } = await import('../../src/subgraph/hyperindex/indexer-context.js');
const { GeckoTerminalProvider, LocalGcra, takeGtBudget, GT_ALL_KEY, gtLaneKey, isGtSuccessBody } = gt;

const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const TOKEN = '0x00000000000000000000000000000000000000aa';

beforeEach(() => {
  responses.length = 0;
  requested.length = 0;
});

describe('the 429-as-200 answer', () => {
  it.each([
    ['PRICE_MISS_LEDGER=on', { priceMissLedger: 'on' }],
    ['GECKOTERMINAL_BUDGET=local', { geckoterminalBudget: 'local' }],
    ['GECKOTERMINAL_BUDGET=shared', { geckoterminalBudget: 'shared' }],
  ])('%s: a 200 without `data` backs off and records no miss', async (_label, config) => {
    const p = new GeckoTerminalProvider(config as never, { take: async () => 0 });
    responses.push({ statusCode: 200, body: { status: { error_code: 429, error_message: 'Rate Limit' } } });
    const out = await p.getCurrentBatch(1, [TOKEN, WETH]);
    expect(out.size).toBe(0);
    expect(p.isAvailable()).toBe(false);
    const m = p.getMetrics();
    expect(m.ratelimit).toBe(1);
    expect(m.miss).toBe(0);
  });

  it.each([
    ['no config', undefined],
    ['both flags off', { priceMissLedger: 'off', geckoterminalBudget: 'off' }],
  ])('%s (the default): today\'s reading — every address a miss, the provider stays available', async (_label, config) => {
    const p = new GeckoTerminalProvider(config as never);
    responses.push({ statusCode: 200, body: { status: { error_code: 429, error_message: 'Rate Limit' } } });
    const out = await p.getCurrentBatch(1, [TOKEN, WETH]);
    expect(out.size).toBe(0);
    expect(p.isAvailable()).toBe(true);
    expect(p.getMetrics()).toMatchObject({ miss: 2, ratelimit: 0 });
  });

  it('strictProviderHealthOf: on with the ledger or any GT budget, off otherwise', () => {
    expect(gt.strictProviderHealthOf(undefined)).toBe(false);
    expect(gt.strictProviderHealthOf({})).toBe(false);
    expect(gt.strictProviderHealthOf({ priceMissLedger: 'off', geckoterminalBudget: 'off' })).toBe(false);
    expect(gt.strictProviderHealthOf({ priceMissLedger: 'on' })).toBe(true);
    expect(gt.strictProviderHealthOf({ priceMissLedger: true })).toBe(true);
    expect(gt.strictProviderHealthOf({ geckoterminalBudget: 'local' })).toBe(true);
    expect(gt.strictProviderHealthOf({ geckoterminalBudget: 'shared' })).toBe(true);
    expect(gt.strictProviderHealthOf({ geckoterminalBudget: 'LOCAL' })).toBe(false); // the getter lowercases; anything else = off
  });

  it('a real empty answer is a healthy miss (provider stays available)', async () => {
    const p = new GeckoTerminalProvider();
    responses.push({ statusCode: 200, body: { data: { attributes: { token_prices: {} } } } });
    await p.getCurrentBatch(1, [TOKEN]);
    expect(p.isAvailable()).toBe(true);
    expect(p.getMetrics().miss).toBe(1);
    expect(p.getMetrics().ratelimit).toBe(0);
  });

  it('isGtSuccessBody: only a body carrying the `data` object', () => {
    expect(isGtSuccessBody({ data: { attributes: {} } })).toBe(true);
    expect(isGtSuccessBody({ status: { error_code: 429 } } as never)).toBe(false);
    expect(isGtSuccessBody(undefined)).toBe(false);
  });
});

describe('LocalGcra', () => {
  it('serves the burst, then makes callers wait at the rate, and refuses past maxWait', async () => {
    let now = 0;
    const g = new LocalGcra(() => now);
    // 30/min, burst 2
    expect(await g.take('k', 30, 2, 0)).toBe(0);
    expect(await g.take('k', 30, 2, 0)).toBe(0);
    // empty: the next token is 2 s away at 30/min
    expect(await g.take('k', 30, 2, 0)).toBe(-2000);
    expect(await g.take('k', 30, 2, 5_000)).toBe(2000);
    now += 2000;
    // the waited token was taken (debt) → the next one is another 2 s out
    expect(await g.take('k', 30, 2, 5_000)).toBe(2000);
  });
});

describe('takeGtBudget — lane caps', () => {
  it('a lane cannot exceed its share even with the shared bucket idle', async () => {
    let now = 0;
    const local = new LocalGcra(() => now);
    // sweeps: 40% of 30/min = 12/min, burst floor(12/6)=2, maxWait 60s
    const waits: Array<number | null> = [];
    for (let i = 0; i < 4; i++) waits.push(await takeGtBudget(local, local, 'sweeps'));
    expect(waits.slice(0, 2)).toEqual([0, 0]);
    // the lane (12/min = 5 s per token) is now the binding bucket, not the shared one
    expect(waits[2]).toBe(5000);
    expect(waits[3]).toBe(10000);
  });

  it('interactive takes only the shared bucket', async () => {
    const calls: string[] = [];
    const backend = {
      take: vi.fn(async (key: string) => {
        calls.push(key);
        return 0;
      }),
    };
    await takeGtBudget(backend, backend, 'interactive');
    expect(calls).toEqual([GT_ALL_KEY]);
    await takeGtBudget(backend, backend, 'backfill');
    expect(calls).toEqual([GT_ALL_KEY, gtLaneKey('backfill'), GT_ALL_KEY]);
  });

  it('a refused lane token refuses the call (null)', async () => {
    const backend = { take: vi.fn(async (key: string) => (key === gtLaneKey('refresh') ? -1 : 0)) };
    expect(await takeGtBudget(backend, backend, 'refresh')).toBeNull();
  });

  it('a shared bucket that throws falls back to the local one', async () => {
    const shared = {
      take: vi.fn(async () => {
        throw new Error('redis down');
      }),
    };
    const local = new LocalGcra(() => 0);
    expect(await takeGtBudget(shared, local, 'backfill')).toBe(0);
    expect(gt.geckoTerminalBudgetStats().localFallbacks).toBeGreaterThan(0);
  });
});

describe('GeckoTerminalProvider with the budget', () => {
  it('off (no config): no budget at all — no bucket touched, the request goes out', async () => {
    const shared = { take: vi.fn(async () => 0) };
    const local = { take: vi.fn(async () => 0) };
    const p = new GeckoTerminalProvider(undefined, shared);
    p.setBudgetHooks({ local });
    const before = gt.geckoTerminalBudgetStats();
    await p.getCurrentBatch(1, [TOKEN]);
    expect(shared.take).not.toHaveBeenCalled();
    expect(local.take).not.toHaveBeenCalled();
    expect(gt.geckoTerminalBudgetStats().taken).toBe(before.taken);
    expect(requested).toHaveLength(1);
  });

  it('shared: takes the backfill lane + shared token inside a backfill job, then calls', async () => {
    const keys: string[] = [];
    const shared = {
      take: vi.fn(async (key: string) => {
        keys.push(key);
        return 0;
      }),
    };
    const p = new GeckoTerminalProvider({ geckoterminalBudget: 'shared' } as never, shared);
    await runInLane({ lane: 'refresh', job: 'backfill' }, () => p.getCurrentBatch(1, [TOKEN]));
    expect(keys).toEqual([gtLaneKey('backfill'), GT_ALL_KEY]);
    expect(requested).toHaveLength(1);
  });

  it('a refused call is not made, is a SKIP, and leaves the provider available', async () => {
    const shared = { take: vi.fn(async () => -30_000) };
    const p = new GeckoTerminalProvider({ geckoterminalBudget: 'shared' } as never, shared);
    const out = await runInLane({ lane: 'sweep', job: 'token-price-sync' }, () => p.getCurrentBatch(1, [TOKEN]));
    expect(out.size).toBe(0);
    expect(requested).toHaveLength(0);
    expect(p.getMetrics().skip).toBe(1);
    expect(p.getMetrics().miss).toBe(0);
    expect(p.isAvailable()).toBe(true);
  });

  it('waits the granted time before calling (local mode)', async () => {
    const sleeps: number[] = [];
    const p = new GeckoTerminalProvider({ geckoterminalBudget: 'local' } as never);
    p.setBudgetHooks({
      local: { take: async () => 1500 },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await runInLane({ lane: 'refresh', job: 'refresh' }, () => p.getCurrentBatch(1, [TOKEN]));
    expect(sleeps).toEqual([1500]);
    expect(requested).toHaveLength(1);
  });
});

describe('currentGtLane — a live refresh is not a sweep', () => {
  it('lane live (live-refresh job, live listener) → the short-wait live lane', () => {
    expect(runInLane({ lane: 'live', job: 'live-refresh' }, () => gt.currentGtLane())).toBe('live');
    expect(gt.GT_LANE_MAX_WAIT_MS.live).toBeLessThanOrEqual(5_000);
    expect(runInLane({ lane: 'sweep', job: 'token-price-sync' }, () => gt.currentGtLane())).toBe('sweeps');
    expect(runInLane({ lane: 'refresh', job: 'backfill' }, () => gt.currentGtLane())).toBe('backfill');
    expect(runInLane({ lane: 'interactive' }, () => gt.currentGtLane())).toBe('interactive');
  });

  it('the live lane takes its own key with a ≤ 5 s max wait', async () => {
    const seen: Array<[string, number]> = [];
    const backend = {
      take: vi.fn(async (key: string, _p: number, _b: number, maxWait: number) => {
        seen.push([key, maxWait]);
        return 0;
      }),
    };
    await takeGtBudget(backend, backend, 'live');
    expect(seen).toEqual([
      [gtLaneKey('live'), 5_000],
      [GT_ALL_KEY, 5_000],
    ]);
  });
});

describe('local buckets spend a per-process share of the fleet rate', () => {
  it('gtLocalShareOf: all/unset = 1, sync = 0.5, other roles = 0.25, override wins', () => {
    expect(gt.gtLocalShareOf(undefined)).toBe(1);
    expect(gt.gtLocalShareOf({ processRole: 'all' })).toBe(1);
    expect(gt.gtLocalShareOf({ processRole: 'sync' })).toBe(0.5);
    expect(gt.gtLocalShareOf({ processRole: 'api' })).toBe(0.25);
    expect(gt.gtLocalShareOf({ processRole: 'api', geckoterminalLocalShare: 0.4 })).toBe(0.4);
    expect(gt.gtLocalShareOf({ processRole: 'api', geckoterminalLocalShare: 7 })).toBe(0.25);
  });

  it('local mode scales both the lane and the shared rate', async () => {
    const rates: Array<[string, number, number]> = [];
    const local = {
      take: vi.fn(async (key: string, perMin: number, burst: number) => {
        rates.push([key, perMin, burst]);
        return 0;
      }),
    };
    await takeGtBudget(local, local, 'backfill', 0.5);
    expect(rates).toEqual([
      [gtLaneKey('backfill'), 9, 1],
      [GT_ALL_KEY, 15, 2],
    ]);
  });

  it('a shared bucket that throws falls back to the SCALED local rate, not the full fleet rate', async () => {
    const rates: number[] = [];
    const shared = {
      take: vi.fn(async () => {
        throw new Error('redis down');
      }),
    };
    const local = {
      take: vi.fn(async (_k: string, perMin: number) => {
        rates.push(perMin);
        return 0;
      }),
    };
    await takeGtBudget(shared, local, 'interactive', 0.25);
    expect(rates).toEqual([7.5]);
  });

  it('shared with no GECKOTERMINAL_GCRA bound: counted as a fallback, uses the local share', async () => {
    const rates: number[] = [];
    const p = new GeckoTerminalProvider({ geckoterminalBudget: 'shared', processRole: 'sync' } as never);
    p.setBudgetHooks({
      local: {
        take: async (_k: string, perMin: number) => {
          rates.push(perMin);
          return 0;
        },
      },
    });
    const before = gt.geckoTerminalBudgetStats().localFallbacks;
    await runInLane({ lane: 'refresh', job: 'backfill' }, () => p.getCurrentBatch(1, [TOKEN]));
    expect(gt.geckoTerminalBudgetStats().localFallbacks).toBe(before + 1);
    expect(rates).toEqual([GT_CALLS_PER_MIN_FOR_SPEC * 0.6 * 0.5, GT_CALLS_PER_MIN_FOR_SPEC * 0.5]);
    expect(requested).toHaveLength(1);
  });
});

const GT_CALLS_PER_MIN_FOR_SPEC = 30;
