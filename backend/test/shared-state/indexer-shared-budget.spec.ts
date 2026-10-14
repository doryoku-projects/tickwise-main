/*
 * P2.2 §3.3 — ONE Envio budget across processes (INDEXER_BUDGET_SCOPE=shared,
 * enforce mode only). Two gateways over one fake Redis stand in for two
 * processes: their TOTAL stays within the budget, background within its own
 * cap, a 429 on one pauses the other, and losing Redis drops each process to
 * its local share. `process` scope (the default) never touches Redis.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAlertPacing, RedisGcra } from '../../src/common/redis-gcra.js';
import type { IndexerContext, IndexerLane } from '../../src/subgraph/hyperindex/indexer-context.js';
import {
  DEFAULT_INDEXER_GATEWAY_CONFIG,
  IndexerGateway,
  indexerBudgetKeyBase,
  RedisIndexerSharedBudget,
  type GatewaySettled,
  type IndexerGatewayConfig,
  type IndexerSharedBudget,
} from '../../src/subgraph/hyperindex/indexer-gateway.js';
import { IndexerMeter } from '../../src/subgraph/hyperindex/indexer-meter.js';
import { FakeSharedRedis } from './fake-redis.js';

const URL_ = 'https://indexer.example.test/v1/graphql?key=s3cret';

const lane = (l: IndexerLane): IndexerContext => ({ lane: l, job: `${l}-job` });

function gatewayOf(config: Partial<IndexerGatewayConfig>, backend: IndexerSharedBudget | undefined) {
  const g = new IndexerGateway(
    URL_,
    { ...DEFAULT_INDEXER_GATEWAY_CONFIG, mode: 'enforce', scope: 'shared', ...config },
    new IndexerMeter(URL_),
    () => backend,
  );
  (g as unknown as { logger: { warn: () => void } }).logger = { warn: () => undefined };
  return g;
}

/** Fire `n` calls that settle at once with `status`; count how many were dispatched. */
function fire(g: IndexerGateway, n: number, l: IndexerLane, status = 200) {
  const counter = { dispatched: 0 };
  for (let i = 0; i < n; i++) {
    void g
      .run(lane(l), async (): Promise<GatewaySettled> => {
        counter.dispatched += 1;
        return { status, retryAfter: status === 429 ? '5' : undefined };
      })
      .catch(() => undefined);
  }
  return counter;
}

let redis: FakeSharedRedis;
let backend: RedisIndexerSharedBudget;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date('2026-10-04T12:00:00Z'));
  __resetAlertPacing();
  redis = new FakeSharedRedis();
  backend = new RedisIndexerSharedBudget(new RedisGcra(async () => redis as never));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('one budget for the fleet', () => {
  it('two processes together stay within INDEXER_BUDGET_PER_MIN (process scope would double it)', async () => {
    const cfg = { budgetPerMin: 60, backgroundMaxPerMin: 600, maxInFlight: 100, interactiveReservedInFlight: 0 };
    const a = fire(gatewayOf(cfg, backend), 60, 'interactive');
    const b = fire(gatewayOf(cfg, backend), 60, 'interactive');
    await vi.advanceTimersByTimeAsync(30_000);
    const total = a.dispatched + b.dispatched;
    // capacity 2 + 1/s × 30 s
    expect(total).toBeLessThanOrEqual(32);
    expect(total).toBeGreaterThanOrEqual(28);
    expect(Math.min(a.dispatched, b.dispatched)).toBeGreaterThan(0); // both make progress

    // Control: the same two processes in `process` scope each spend a whole budget.
    const pa = fire(gatewayOf({ ...cfg, scope: 'process' }, backend), 60, 'interactive');
    const pb = fire(gatewayOf({ ...cfg, scope: 'process' }, backend), 60, 'interactive');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(pa.dispatched + pb.dispatched).toBeGreaterThan(50);
  });

  it('background lanes also stay within INDEXER_BACKGROUND_MAX_PER_MIN fleet-wide', async () => {
    const cfg = { budgetPerMin: 6000, backgroundMaxPerMin: 60, maxInFlight: 100, interactiveReservedInFlight: 0 };
    const a = fire(gatewayOf(cfg, backend), 60, 'sweep');
    const b = fire(gatewayOf(cfg, backend), 60, 'refresh');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(a.dispatched + b.dispatched).toBeLessThanOrEqual(32);
    expect(a.dispatched + b.dispatched).toBeGreaterThanOrEqual(28);
  });

  it('interactive is not held by the background cap; background takes all + bg in ONE call', async () => {
    const cfg = { budgetPerMin: 6000, backgroundMaxPerMin: 60, maxInFlight: 100, interactiveReservedInFlight: 0 };
    const g = gatewayOf(cfg, backend);
    const sweep = fire(g, 1, 'sweep');
    await vi.advanceTimersByTimeAsync(0);
    const interactive = fire(g, 30, 'interactive');
    await vi.advanceTimersByTimeAsync(100);
    expect(sweep.dispatched).toBe(1);
    expect(interactive.dispatched).toBe(30);
    const base = indexerBudgetKeyBase(URL_);
    expect(redis.evals[0].buckets.map((b) => b.key)).toEqual([`${base}:all`, `${base}:bg`]);
    expect(redis.evals.slice(1).every((r) => r.buckets.length === 1 && r.buckets[0].key === `${base}:all`)).toBe(true);
    expect(redis.evals.every((r) => r.pauseKey === `${base}:pause`)).toBe(true);
  });

  it('an interactive take never pays for background: a sweep after it still takes bg', async () => {
    const cfg = { budgetPerMin: 6000, backgroundMaxPerMin: 60, maxInFlight: 100, interactiveReservedInFlight: 0 };
    const g = gatewayOf(cfg, backend);
    fire(g, 1, 'interactive');
    await vi.advanceTimersByTimeAsync(0);
    fire(g, 1, 'sweep');
    await vi.advanceTimersByTimeAsync(0);
    const base = indexerBudgetKeyBase(URL_);
    expect(redis.evals.map((r) => r.buckets.map((b) => b.key))).toEqual([[`${base}:all`], [`${base}:all`, `${base}:bg`]]);
  });

  it('a credit left by an abandoned interactive call is spent by a sweep only together with a bg token', async () => {
    const cfg = { budgetPerMin: 6000, backgroundMaxPerMin: 60, maxInFlight: 100, interactiveReservedInFlight: 0 };
    const g = gatewayOf(cfg, backend);
    const ctl = new AbortController();
    void g.run({ lane: 'interactive', job: 'x', signal: ctl.signal }, async () => ({ status: 200 })).catch(() => undefined);
    ctl.abort(); // gone while its fleet take is in flight: the `all` token becomes a credit
    await vi.advanceTimersByTimeAsync(0);
    expect(g.snapshot().shared?.credits).toEqual({ all: 1, bg: 0 });
    const sweep = fire(g, 1, 'sweep');
    await vi.advanceTimersByTimeAsync(0);
    expect(sweep.dispatched).toBe(1);
    const base = indexerBudgetKeyBase(URL_);
    expect(redis.evals.map((r) => r.buckets.map((b) => b.key))).toEqual([[`${base}:all`], [`${base}:bg`]]);
    expect(g.snapshot().shared?.credits).toEqual({ all: 0, bg: 0 });
  });

  it('keys hash the indexer URL (a key in its query string never reaches Redis)', () => {
    const base = indexerBudgetKeyBase(URL_);
    expect(base).toMatch(/^tw:ix:v1:[0-9a-f]{16}$/);
    expect(base).not.toContain('s3cret');
    expect(indexerBudgetKeyBase('https://other.example/graphql')).not.toBe(base);
  });
});

describe('429 pause propagates', () => {
  it('a 429 on process A pauses process B before its next dispatch', async () => {
    const cfg = { budgetPerMin: 6000, backgroundMaxPerMin: 6000, maxInFlight: 100, interactiveReservedInFlight: 0 };
    const a = gatewayOf(cfg, backend);
    const b = gatewayOf(cfg, backend);
    fire(a, 1, 'interactive', 429);
    await vi.advanceTimersByTimeAsync(0);
    expect(redis.pauses).toEqual([{ key: `${indexerBudgetKeyBase(URL_)}:pause`, ms: 5000 }]);
    const later = fire(b, 3, 'sweep');
    await vi.advanceTimersByTimeAsync(4_900);
    expect(later.dispatched).toBe(0);
    expect(b.snapshot().paused).toBe(true);
    expect(b.snapshot().shared?.pausedReads).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(later.dispatched).toBe(3);
  });
});

describe('Redis unavailable → local share', () => {
  it('a failing shared bucket drops this process to budget × INDEXER_BUDGET_LOCAL_SHARE, then retries Redis', async () => {
    redis.failing = true;
    const cfg = { budgetPerMin: 120, backgroundMaxPerMin: 600, maxInFlight: 100, interactiveReservedInFlight: 0, localShare: 0.25 };
    const g = gatewayOf(cfg, backend);
    const c = fire(g, 50, 'interactive');
    await vi.advanceTimersByTimeAsync(20_000);
    // 30/min locally = 0.5/s, capacity 1 → ≤ 11 in 20 s (the whole budget would be ≥ 40)
    expect(c.dispatched).toBeLessThanOrEqual(11);
    expect(c.dispatched).toBeGreaterThanOrEqual(8);
    expect(g.snapshot().shared).toMatchObject({ active: false, bound: true });
    expect(g.snapshot().shared!.fallbacks).toBeGreaterThan(0);

    redis.failing = false;
    await vi.advanceTimersByTimeAsync(6_000);
    expect(g.snapshot().shared!.active).toBe(true);
  });

  it('shared scope with NO backend bound runs on the local share (and says so)', async () => {
    const cfg = { budgetPerMin: 120, backgroundMaxPerMin: 600, maxInFlight: 100, interactiveReservedInFlight: 0, localShare: 0.25 };
    const g = gatewayOf(cfg, undefined);
    const warned: string[] = [];
    (g as unknown as { logger: { warn: (m: string) => void } }).logger = { warn: (m) => void warned.push(m) };
    const c = fire(g, 50, 'interactive');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(c.dispatched).toBeLessThanOrEqual(11);
    expect(g.snapshot().shared).toMatchObject({ active: false, bound: false });
    expect(warned.some((m) => m.includes('[alert] indexer.shared_unbound'))).toBe(true);
  });

  it('a garbage, zero or negative local share reads as 1 (today), never 0', async () => {
    for (const localShare of [Number.NaN, 0, -0.5, undefined]) {
      const g = gatewayOf({ budgetPerMin: 60, localShare, maxInFlight: 100, interactiveReservedInFlight: 0 }, undefined);
      expect(g.snapshot().shared?.localShare).toBe(1);
    }
    expect(gatewayOf({ localShare: 7 }, undefined).snapshot().shared?.localShare).toBe(1);
    expect(gatewayOf({ localShare: 0.25 }, undefined).snapshot().shared?.localShare).toBe(0.25);
  });
});

describe('defaults = today', () => {
  it('process scope (default) never calls the shared backend', async () => {
    const g = gatewayOf({ scope: undefined, budgetPerMin: 60, maxInFlight: 100, interactiveReservedInFlight: 0 }, backend);
    fire(g, 10, 'sweep');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(redis.calls).toBe(0);
    expect(g.snapshot().shared).toBeUndefined();
  });

  it('observe mode with shared scope never calls the backend either', async () => {
    const g = gatewayOf({ mode: 'observe', budgetPerMin: 60 }, backend);
    const c = fire(g, 10, 'sweep');
    await vi.advanceTimersByTimeAsync(0);
    expect(c.dispatched).toBe(10);
    expect(redis.calls).toBe(0);
  });

  it('the minute line carries shared{…} only in shared scope', () => {
    expect(gatewayOf({ scope: 'process' }, backend).budgetLineSuffix()).toBeUndefined();
    expect(gatewayOf({}, backend).budgetLineSuffix()).toMatch(/^shared\{active=true takes=0 /);
  });
});
