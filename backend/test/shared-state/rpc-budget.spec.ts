/*
 * P2.2 §3.4 — the Dwellir RPC budget: ONE bucket per ACCOUNT (not per host,
 * not per namespace), every HTTP attempt charged (viem's retries included,
 * via `budgetedFetch` as the transport's `fetchFn`), a JSON-RPC batch charged
 * per member, a month counter with 50/75/90 % alerts. Off by default: the
 * fetch is untouched and nothing reaches Redis.
 */
import { createPublicClient, http } from 'viem';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __resetAlertPacing, RedisGcra } from '../../src/common/redis-gcra.js';
import {
  parseRpcAccountMap,
  rpcAccountFor,
  rpcBucketKey,
  RpcBudget,
  RpcBudgetTimeoutError,
  rpcMonthKey,
  rpcRequestCost,
} from '../../src/common/rpc-budget.js';
import { FakeSharedRedis } from './fake-redis.js';

const DWELLIR_ETH = 'https://api-ethereum-mainnet.n.dwellir.com/KEY1';
const DWELLIR_ARB = 'https://api-arbitrum-mainnet-archive.n.dwellir.com/KEY2';

function clock(start = Date.UTC(2026, 9, 4, 12)) {
  const c = { t: start, slept: [] as number[], now: () => c.t, sleep: async (ms: number) => void (c.slept.push(ms), (c.t += ms)) };
  return c;
}

function budget(
  config: Record<string, unknown>,
  opts: { redis?: FakeSharedRedis; down?: boolean; c?: ReturnType<typeof clock>; role?: 'all' | 'fee' } = {},
) {
  const c = opts.c ?? clock();
  const redis = opts.redis ?? new FakeSharedRedis(c.now);
  const gcra = new RedisGcra(async () => (opts.down ? undefined : (redis as never)));
  const warned: string[] = [];
  const b = new RpcBudget(config as never, undefined, { now: c.now, sleep: c.sleep, gcra, role: opts.role });
  (b as unknown as { logger: { warn: (m: string) => void } }).logger = { warn: (m) => void warned.push(m) };
  return { b, redis, c, warned };
}

const okFetch = async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x10' }), { status: 200 });

beforeEach(() => __resetAlertPacing());

describe('account mapping', () => {
  it('parses host=account pairs, ignores junk', () => {
    const map = parseRpcAccountMap(' API-ETHEREUM-MAINNET.n.dwellir.com = growth , bad, =x, y=, h=acc!');
    expect([...map]).toEqual([['api-ethereum-mainnet.n.dwellir.com', 'growth']]);
    expect(parseRpcAccountMap(undefined).size).toBe(0);
  });

  it('every host not listed (or an unparseable url) is `default`', () => {
    const map = parseRpcAccountMap('api-ethereum-mainnet.n.dwellir.com=rig');
    expect(rpcAccountFor(DWELLIR_ETH, map)).toBe('rig');
    expect(rpcAccountFor(DWELLIR_ARB, map)).toBe('default');
    expect(rpcAccountFor('not a url', map)).toBe('default');
    expect(rpcAccountFor(undefined, map)).toBe('default');
  });

  it('keys are per account and NOT namespaced', () => {
    expect(rpcBucketKey('default')).toBe('tw:rpc:v1:acct:default');
    expect(rpcMonthKey('default', new Date(Date.UTC(2026, 0, 31)))).toBe('tw:rpc:v1:acct:default:month:2026-01');
  });

  it('two hosts share ONE bucket by default; RPC_ACCOUNT_MAP splits them', async () => {
    const one = budget({ rpcBudgetPerSec: 10 });
    await one.b.take('fee', 1, { url: DWELLIR_ETH });
    await one.b.take('fee', 1, { url: DWELLIR_ARB });
    expect(new Set(one.redis.evals.map((r) => r.buckets[0].key))).toEqual(new Set(['tw:rpc:v1:acct:default']));

    const split = budget({ rpcBudgetPerSec: 10, rpcAccountMap: 'api-arbitrum-mainnet-archive.n.dwellir.com=arb' });
    await split.b.take('fee', 1, { url: DWELLIR_ETH });
    await split.b.take('fee', 1, { url: DWELLIR_ARB });
    expect(split.redis.evals.map((r) => r.buckets[0].key)).toEqual(['tw:rpc:v1:acct:default', 'tw:rpc:v1:acct:arb']);
  });
});

describe('off by default = today', () => {
  it('RPC_BUDGET_PER_SEC unset/0: nothing taken, budgetedFetch is the plain fetch', async () => {
    for (const cfg of [{}, { rpcBudgetPerSec: 0 }, { rpcBudgetPerSec: -5 }, { rpcBudgetPerSec: Number.NaN }]) {
      const { b, redis } = budget(cfg);
      expect(b.enabled).toBe(false);
      expect(await b.take('fee')).toEqual({ waitedMs: 0, source: 'off' });
      let calls = 0;
      const plain = async () => (calls++, okFetch());
      const fetchFn = b.budgetedFetch('fee', plain);
      expect(fetchFn).toBe(plain); // not a wrapper: the transport is exactly today's
      const res = await fetchFn(DWELLIR_ETH, { method: 'POST', body: '{}' });
      expect(res.status).toBe(200);
      expect(calls).toBe(1);
      expect(redis.calls).toBe(0);
    }
  });
});

describe('the bucket', () => {
  it('waits for tokens past the burst (2 s of the rate) and refuses past maxWait, taking nothing', async () => {
    const { b, c, redis } = budget({ rpcBudgetPerSec: 2 });
    for (let i = 0; i < 4; i++) await b.take('fee'); // burst = 4
    expect(c.slept).toEqual([]);
    await b.take('fee');
    expect(c.slept).toEqual([500]);
    // -1 after the 5th take; the 500 ms slept refill it to 0 — a refused take
    // records that refill and debits NOTHING (it would read -1 otherwise).
    await expect(b.take('fee', 1, { maxWaitMs: 100 })).rejects.toBeInstanceOf(RpcBudgetTimeoutError);
    expect(redis.gcra.peek('tw:rpc:v1:acct:default')!.tokens).toBeCloseTo(0);
    expect(b.status().accounts.default.refused).toBe(1);
  });

  it('a JSON-RPC batch costs one token per member', () => {
    expect(rpcRequestCost('{"jsonrpc":"2.0"}')).toBe(1);
    expect(rpcRequestCost('[{"id":1},{"id":2},{"id":3}]')).toBe(3);
    expect(rpcRequestCost('  [{"id":1}]')).toBe(1);
    expect(rpcRequestCost('[')).toBe(1);
    expect(rpcRequestCost(undefined)).toBe(1);
  });

  it('an abort while waiting rejects with the signal\'s reason', async () => {
    const c = clock();
    const redis = new FakeSharedRedis(c.now);
    const b = new RpcBudget({ rpcBudgetPerSec: 1 } as never, undefined, { now: c.now, gcra: new RedisGcra(async () => redis as never) });
    await b.take('fee');
    await b.take('fee');
    const ctl = new AbortController();
    const p = b.take('fee', 1, { signal: ctl.signal });
    ctl.abort(new Error('viem timeout'));
    await expect(p).rejects.toThrow('viem timeout');
  });

  it('Redis down in a split role → a per-process bucket at 25 % of the rate (fail open)', async () => {
    const { b, c, warned } = budget({ rpcBudgetPerSec: 4 }, { down: true, role: 'fee' });
    // 25 %: 1/s, burst 2
    await b.take('fee');
    await b.take('fee');
    expect(c.slept).toEqual([]);
    await b.take('fee');
    expect(c.slept).toEqual([1000]);
    expect(b.status().accounts.default.local).toBe(3);
    expect(warned.some((m) => m.includes('per-process bucket'))).toBe(true);
  });
});

describe('budgetedFetch as viem\'s fetchFn', () => {
  it('a viem retry is a second HTTP attempt and takes a second token', async () => {
    const { b, redis } = budget({ rpcBudgetPerSec: 100 });
    let attempts = 0;
    const flaky = async () => {
      attempts += 1;
      if (attempts === 1) return new Response('busy', { status: 500 });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 0, result: '0x2a' }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const client = createPublicClient({
      transport: http(DWELLIR_ETH, { fetchFn: b.budgetedFetch('fee', flaky), retryCount: 1, retryDelay: 1 }),
    });
    expect(await client.getBlockNumber({ cacheTime: 0 })).toBe(42n);
    expect(attempts).toBe(2);
    expect(redis.evals).toHaveLength(2);
    expect(b.status().byLane.fee).toBe(2);
  });

  it('charges a batch body per member and passes the request through unchanged', async () => {
    const { b, redis } = budget({ rpcBudgetPerSec: 100 });
    const seen: Array<{ url: string; body: unknown }> = [];
    const f = b.budgetedFetch('backfill', async (input, init) => {
      seen.push({ url: String(input), body: init?.body });
      return okFetch();
    });
    await f(DWELLIR_ETH, { method: 'POST', body: '[{"id":1},{"id":2}]' });
    expect(redis.evals[0].buckets[0].cost).toBe(2);
    expect(seen).toEqual([{ url: DWELLIR_ETH, body: '[{"id":1},{"id":2}]' }]);
  });
});

describe('month counter', () => {
  afterEach(() => undefined);

  it('counts per account per UTC month and rolls over at the month boundary', async () => {
    const c = clock(Date.UTC(2026, 0, 31, 23, 59, 59));
    const { b, redis } = budget({ rpcBudgetPerSec: 100 }, { c });
    await b.take('fee', 3);
    c.t = Date.UTC(2026, 1, 1, 0, 0, 1);
    await b.take('fee', 2);
    expect(redis.evals.map((r) => r.counter)).toEqual([
      { key: 'tw:rpc:v1:acct:default:month:2026-01', by: 3, ttlSec: 40 * 24 * 3600 },
      { key: 'tw:rpc:v1:acct:default:month:2026-02', by: 2, ttlSec: 40 * 24 * 3600 },
    ]);
    expect(b.status().accounts.default.month).toBe(2);
  });

  it('alerts once each at 50 / 75 / 90 % of RPC_MONTHLY_CAP', async () => {
    const { b, warned } = budget({ rpcBudgetPerSec: 1000, rpcMonthlyCap: 100 });
    for (let i = 0; i < 49; i++) await b.take('fee');
    expect(warned.filter((m) => m.includes('[alert] rpc.month_'))).toEqual([]);
    await b.take('fee'); // 50
    await b.take('fee', 30); // 80
    await b.take('fee', 20); // 100
    await b.take('fee'); // 101 — nothing new
    const alerts = warned.filter((m) => m.includes('[alert] rpc.month_')).map((m) => m.split(' ')[1]);
    expect(alerts).toEqual(['rpc.month_50', 'rpc.month_75', 'rpc.month_90']);
    expect(b.status().accounts.default.monthPct).toBe(101);
  });

  it('defaults the cap to 150M (the Dwellir plan) when unset', () => {
    expect(budget({ rpcBudgetPerSec: 1 }).b.monthlyCap).toBe(150_000_000);
  });
});
