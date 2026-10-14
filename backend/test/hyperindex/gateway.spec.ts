/*
 * The indexer gateway: one budget per upstream URL.
 *
 * OBSERVE (the default) must be a pure pass-through plus a meter — no queue, no
 * bucket, no pause, no timeout — because it ships first, to measure, and must not
 * change behaviour. ENFORCE is the budget: strict lane priority, an in-flight cap
 * with slots reserved for users, a background-only per-minute cap, a 429 that
 * pauses the whole bucket, per-call timeouts, and queued calls dropped when their
 * client goes away. Fake timers throughout; Date is faked too because the bucket
 * refills from `Date.now()`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpstreamTransportError } from '../../src/subgraph/hyperindex/errors.js';
import {
  ClientClosedError,
  type IndexerContext,
  type IndexerLane,
} from '../../src/subgraph/hyperindex/indexer-context.js';
import {
  __resetIndexerGateways,
  configureIndexerGateways,
  DEFAULT_INDEXER_GATEWAY_CONFIG,
  GatewayRejection,
  GatewayTimeoutError,
  gatewayForUrl,
  indexerBudgetSnapshot,
  IndexerGateway,
  indexerGatewayMode,
  parseRetryAfterMs,
  type GatewaySettled,
  type IndexerGatewayConfig,
} from '../../src/subgraph/hyperindex/indexer-gateway.js';
import { __resetIndexerMeters, IndexerMeter } from '../../src/subgraph/hyperindex/indexer-meter.js';
import { HyperindexUpstream } from '../../src/subgraph/hyperindex/upstream.js';

const URL_ = 'https://indexer.example.test/v1/graphql';

function enforce(over: Partial<IndexerGatewayConfig> = {}): IndexerGatewayConfig {
  return { ...DEFAULT_INDEXER_GATEWAY_CONFIG, mode: 'enforce', ...over };
}

function make(config: IndexerGatewayConfig) {
  const meter = new IndexerMeter(URL_);
  return { gateway: new IndexerGateway(URL_, config, meter), meter };
}

/** A call the test settles by hand, recording the signal it was given. */
interface Pending {
  readonly name: string;
  readonly signal: AbortSignal | undefined;
  settle(out?: GatewaySettled): void;
  fail(e: Error): void;
}

function harness(gateway: IndexerGateway) {
  const started: Pending[] = [];
  const run = (ctx: IndexerContext, name: string = ctx.lane) =>
    gateway.run(ctx, (signal) =>
      new Promise<GatewaySettled>((resolve, reject) => {
        started.push({
          name,
          signal,
          settle: (out = { status: 200 }) => resolve(out),
          fail: reject,
        });
        // A real fetch rejects when its signal fires; so does this one.
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
    );
  return { started, run, names: () => started.map((p) => p.name) };
}

const lane = (l: IndexerLane, over: Partial<IndexerContext> = {}): IndexerContext => ({ lane: l, job: `${l}-job`, ...over });
const tick = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  __resetIndexerGateways();
  __resetIndexerMeters();
});

describe('observe mode — meter only, a pure pass-through', () => {
  it('dispatches every call at once: no queue, no in-flight cap, no bucket', async () => {
    const { gateway } = make({ ...DEFAULT_INDEXER_GATEWAY_CONFIG, mode: 'observe' });
    const h = harness(gateway);

    for (let i = 0; i < 60; i++) void h.run(lane('sweep'));
    await tick();

    // 60 at once: past the 12-slot cap AND the 20-call background burst.
    expect(h.started).toHaveLength(60);
  });

  it('hands fetch the caller signal only — no timeout signal of its own', async () => {
    const { gateway } = make({ ...DEFAULT_INDEXER_GATEWAY_CONFIG, mode: 'observe' });
    const h = harness(gateway);
    const ac = new AbortController();

    void h.run(lane('sweep'));
    void h.run(lane('interactive', { signal: ac.signal, deadlineAt: Date.now() + 10 }));
    await tick();

    expect(h.started[0].signal).toBeUndefined();
    expect(h.started[1].signal).toBe(ac.signal);
    // The interactive deadline passes and nothing is aborted: observe adds no timeouts.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.started[1].signal!.aborted).toBe(false);
  });

  it('a 429 does not pause anything', async () => {
    const { gateway } = make({ ...DEFAULT_INDEXER_GATEWAY_CONFIG, mode: 'observe' });
    const h = harness(gateway);

    const first = h.run(lane('sweep'));
    await tick();
    h.started[0].settle({ status: 429, retryAfter: '30' });
    await first;

    void h.run(lane('sweep'));
    await tick();
    expect(h.started).toHaveLength(2);
  });

  it('drops a call whose client already hung up, without reaching the indexer', async () => {
    const { gateway, meter } = make({ ...DEFAULT_INDEXER_GATEWAY_CONFIG, mode: 'observe' });
    const h = harness(gateway);
    const ac = new AbortController();
    ac.abort(new ClientClosedError());

    await expect(h.run(lane('interactive', { signal: ac.signal }))).rejects.toBeInstanceOf(GatewayRejection);
    expect(h.started).toHaveLength(0);
    expect(meter.snapshot().current.outcomes.abort).toBe(1);
  });

  it('meters lane, job and outcome, and adds to the request stats', async () => {
    const { gateway, meter } = make({ ...DEFAULT_INDEXER_GATEWAY_CONFIG, mode: 'observe' });
    const h = harness(gateway);
    const stats = { indexerMs: 0, indexerCalls: 0, queuedMs: 0 };

    const p = h.run(lane('interactive', { job: '/api/top-positions', stats }));
    await tick();
    await vi.advanceTimersByTimeAsync(250);
    h.started[0].settle({ status: 200 });
    await p;

    const w = meter.snapshot().current;
    expect(w.lanes.interactive).toBe(1);
    expect(w.jobs['/api/top-positions']).toBe(1);
    expect(w.outcomes['2xx']).toBe(1);
    expect(stats.indexerCalls).toBe(1);
    expect(stats.indexerMs).toBe(250);
  });
});

describe('enforce mode — priority', () => {
  it('serves strictly interactive > live > health > refresh > sweep, whatever the arrival order', async () => {
    // One slot, so each release dispatches exactly one waiter and the order shows.
    const { gateway } = make(enforce({ maxInFlight: 1, interactiveReservedInFlight: 0 }));
    const h = harness(gateway);

    void h.run(lane('sweep'), 'blocker');
    await tick();
    for (const l of ['sweep', 'refresh', 'health', 'live', 'interactive'] as const) void h.run(lane(l));
    await tick();
    expect(h.names()).toEqual(['blocker']);

    for (let i = 0; i < 5; i++) {
      h.started[h.started.length - 1].settle();
      await tick();
    }
    expect(h.names()).toEqual(['blocker', 'interactive', 'live', 'health', 'refresh', 'sweep']);
  });

  it('keeps FIFO order within a lane', async () => {
    const { gateway } = make(enforce({ maxInFlight: 1, interactiveReservedInFlight: 0 }));
    const h = harness(gateway);

    void h.run(lane('refresh'), 'r0');
    void h.run(lane('refresh'), 'r1');
    void h.run(lane('refresh'), 'r2');
    await tick();
    h.started[0].settle();
    await tick();
    h.started[1].settle();
    await tick();
    expect(h.names()).toEqual(['r0', 'r1', 'r2']);
  });
});

describe('enforce mode — in-flight cap and the interactive reserve', () => {
  it('lets background fill only maxInFlight − reserved slots, and users the rest', async () => {
    const { gateway } = make(enforce({ maxInFlight: 12, interactiveReservedInFlight: 4 }));
    const h = harness(gateway);

    for (let i = 0; i < 15; i++) void h.run(lane('sweep'));
    await tick();
    expect(h.started).toHaveLength(8); // 12 − 4

    // A user arriving now is not stuck behind the seven queued sweeps.
    for (let i = 0; i < 5; i++) void h.run(lane('interactive'), `user${i}`);
    await tick();
    expect(h.names().filter((n) => n.startsWith('user'))).toEqual(['user0', 'user1', 'user2', 'user3']);
    expect(h.started).toHaveLength(12);
    expect(gateway.snapshot().inFlight).toBe(12);
    expect(gateway.snapshot().queued).toMatchObject({ interactive: 1, sweep: 7 });

    // A freed slot goes to the waiting user first, not to the older sweeps.
    h.started[0].settle();
    await tick();
    expect(h.started[h.started.length - 1].name).toBe('user4');
  });
});

describe('enforce mode — the per-minute budget', () => {
  it('caps background at its own bucket while users still have budget', async () => {
    // Defaults: 900/min total (burst 30), 600/min background (burst 20).
    const { gateway } = make(enforce({ maxInFlight: 100, interactiveReservedInFlight: 0 }));
    const h = harness(gateway);

    for (let i = 0; i < 25; i++) void h.run(lane('sweep'));
    await tick();
    expect(h.started).toHaveLength(20); // background burst spent

    // Users still get through: 30 − 20 = 10 tokens left in the shared bucket.
    void h.run(lane('interactive'), 'user');
    await tick();
    expect(h.started.map((p) => p.name)).toContain('user');

    // Background refills at 600/min = one per 100ms.
    await vi.advanceTimersByTimeAsync(99);
    expect(h.started).toHaveLength(21);
    await vi.advanceTimersByTimeAsync(2);
    expect(h.started).toHaveLength(22);
  });

  it('holds users to the shared bucket too — the budget is a ceiling for everyone', async () => {
    const { gateway } = make(enforce({ maxInFlight: 100, interactiveReservedInFlight: 0 }));
    const h = harness(gateway);

    for (let i = 0; i < 31; i++) void h.run(lane('interactive'));
    await tick();
    expect(h.started).toHaveLength(30); // burst = 900/30

    await vi.advanceTimersByTimeAsync(67); // 900/min = one per ~66.7ms
    expect(h.started).toHaveLength(31);
  });
});

describe('enforce mode — 429 pauses the bucket', () => {
  it('honours Retry-After: nothing dispatches until it has passed', async () => {
    const { gateway, meter } = make(enforce());
    const h = harness(gateway);

    const first = h.run(lane('refresh'));
    await tick();
    h.started[0].settle({ status: 429, retryAfter: '3' });
    await first;
    expect(gateway.snapshot().paused).toBe(true);

    void h.run(lane('interactive'), 'user');
    await tick();
    await vi.advanceTimersByTimeAsync(2_900);
    expect(h.started).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(150);
    expect(h.names()).toEqual(['refresh', 'user']);
    expect(meter.snapshot().current.outcomes['429']).toBe(1);
  });

  it('without Retry-After: 2s, doubling per consecutive 429, reset by a success', async () => {
    const { gateway } = make(enforce());
    const h = harness(gateway);
    const pausedFor = () => gateway.snapshot().pausedForMs;

    const a = h.run(lane('sweep'));
    await tick();
    h.started[0].settle({ status: 429 });
    await a;
    expect(pausedFor()).toBe(2_000);

    await vi.advanceTimersByTimeAsync(2_000);
    const b = h.run(lane('sweep'));
    await tick();
    h.started[1].settle({ status: 429 });
    await b;
    expect(pausedFor()).toBe(4_000);

    await vi.advanceTimersByTimeAsync(4_000);
    const c = h.run(lane('sweep'));
    await tick();
    h.started[2].settle({ status: 200 });
    await c;
    const d = h.run(lane('sweep'));
    await tick();
    h.started[3].settle({ status: 429 });
    await d;
    expect(pausedFor()).toBe(2_000); // back to the base after a success
  });

  it('caps the doubling at 30s and a hostile Retry-After at 60s', async () => {
    const { gateway } = make(enforce());
    const h = harness(gateway);
    // 2s, 4s, 8s, 16s, 32s→30s, 30s.
    for (let i = 0; i < 6; i++) {
      const p = h.run(lane('sweep'));
      // Wait out the current pause so the call dispatches, then answer it at once
      // (well inside its own 30s timeout).
      await vi.advanceTimersByTimeAsync(gateway.snapshot().pausedForMs + 1);
      h.started[i].settle({ status: 429 });
      await p;
    }
    expect(gateway.snapshot().pausedForMs).toBe(30_000);

    const p = h.run(lane('sweep'));
    await vi.advanceTimersByTimeAsync(30_001);
    h.started[6].settle({ status: 429, retryAfter: '3600' });
    await p;
    expect(gateway.snapshot().pausedForMs).toBe(60_000);
  });
});

describe('enforce mode — deadlines and timeouts', () => {
  it('rejects an interactive call still queued at its deadline, as rate limiting when paused', async () => {
    const { gateway, meter } = make(enforce());
    const h = harness(gateway);

    const first = h.run(lane('sweep'));
    await tick();
    h.started[0].settle({ status: 429, retryAfter: '30' });
    await first;

    const user = h.run(lane('interactive', { deadlineAt: Date.now() + 8_000 }));
    const settled = user.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(8_001);
    const err = (await settled) as GatewayRejection;

    expect(err).toBeInstanceOf(GatewayRejection);
    expect(err.reason).toBe('deadline');
    expect(err.rateLimited).toBe(true);
    expect(Number(err.retryAfter)).toBeGreaterThan(0);
    expect(h.started).toHaveLength(1); // never sent
    expect(gateway.snapshot().queued.interactive).toBe(0);
    expect(meter.snapshot().current.outcomes.timeout).toBe(1);
  });

  it('times an interactive call out against what is left of its deadline', async () => {
    const { gateway, meter } = make(enforce());
    const h = harness(gateway);

    const user = h.run(lane('interactive', { deadlineAt: Date.now() + 3_000 })).catch((e: unknown) => e);
    await tick();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(h.started[0].signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(h.started[0].signal!.aborted).toBe(true);
    expect(await user).toBeInstanceOf(GatewayTimeoutError);
    expect(meter.snapshot().current.outcomes.timeout).toBe(1);
  });

  it('caps an interactive call at interactiveTimeoutMs, and background calls at backgroundTimeoutMs', async () => {
    const { gateway } = make(enforce({ interactiveTimeoutMs: 8_000, backgroundTimeoutMs: 30_000 }));
    const h = harness(gateway);

    void h.run(lane('interactive', { deadlineAt: Date.now() + 60_000 })).catch(() => undefined);
    void h.run(lane('refresh')).catch(() => undefined);
    await tick();

    await vi.advanceTimersByTimeAsync(8_001);
    expect(h.started[0].signal!.aborted).toBe(true);
    expect(h.started[1].signal!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(22_000);
    expect(h.started[1].signal!.aborted).toBe(true);
  });

  it('refuses an interactive call whose deadline has already passed, before queuing it', async () => {
    const { gateway } = make(enforce());
    const h = harness(gateway);
    await expect(h.run(lane('interactive', { deadlineAt: Date.now() - 1 }))).rejects.toMatchObject({
      reason: 'deadline',
      rateLimited: false,
    });
    expect(h.started).toHaveLength(0);
  });
});

describe('enforce mode — a client that hangs up', () => {
  it('removes its queued call, never sends it, and lets the next lane through', async () => {
    const { gateway } = make(enforce({ maxInFlight: 1, interactiveReservedInFlight: 0 }));
    const h = harness(gateway);
    const ac = new AbortController();

    void h.run(lane('sweep'), 'blocker');
    await tick();
    const user = h.run(lane('interactive', { signal: ac.signal }), 'user').catch((e: unknown) => e);
    void h.run(lane('live'), 'live');
    await tick();
    expect(gateway.snapshot().queued).toMatchObject({ interactive: 1, live: 1 });

    ac.abort(new ClientClosedError());
    const err = (await user) as GatewayRejection;
    expect(err).toBeInstanceOf(GatewayRejection);
    expect(err.reason).toBe('aborted');
    expect(gateway.snapshot().queued.interactive).toBe(0);

    h.started[0].settle();
    await tick();
    expect(h.names()).toEqual(['blocker', 'live']); // the user's call never went out
  });

  it('aborts its in-flight call through the signal handed to fetch', async () => {
    const { gateway, meter } = make(enforce());
    const h = harness(gateway);
    const ac = new AbortController();

    const user = h.run(lane('interactive', { signal: ac.signal, deadlineAt: Date.now() + 8_000 })).catch((e: unknown) => e);
    await tick();
    ac.abort(new ClientClosedError());
    expect(h.started[0].signal!.aborted).toBe(true);
    expect(await user).toBeInstanceOf(ClientClosedError);
    expect(meter.snapshot().current.outcomes.abort).toBe(1);
    // The slot is free again.
    expect(gateway.snapshot().inFlight).toBe(0);
  });
});

describe('module registry and config', () => {
  it('defaults to observe, one gateway per URL, and follows a boot-time reconfigure', async () => {
    expect(indexerGatewayMode()).toBe('observe');
    const a = gatewayForUrl(URL_);
    expect(gatewayForUrl(URL_)).toBe(a);
    expect(gatewayForUrl('https://other.example.test/graphql')).not.toBe(a);

    configureIndexerGateways({ mode: 'enforce', budgetPerMin: 60 });
    expect(indexerGatewayMode()).toBe('enforce');
    expect(a.mode).toBe('enforce');
  });

  it('clamps nonsense: background never above the budget, never zero slots left for background', () => {
    const g = new IndexerGateway(URL_, enforce({ budgetPerMin: 100, backgroundMaxPerMin: 900, maxInFlight: 2, interactiveReservedInFlight: 5 }), new IndexerMeter(URL_));
    // background bucket capped to the total: burst = round(100/30) = 3, not 30.
    expect(g.snapshot().backgroundTokens).toBe(3);
  });

  it('reports meter and gateway state per URL for /admin/sync/status, URL stripped of its query', async () => {
    expect(indexerBudgetSnapshot()).toEqual([]);
    const g = gatewayForUrl(`${URL_}?key=secret`);
    await g.run({ lane: 'health', job: 'health' }, async () => ({ status: 200 }));
    const [row] = indexerBudgetSnapshot();
    expect(row.url).toBe(URL_);
    expect(row.meter!.current.lanes.health).toBe(1);
    expect(row.gateway!.mode).toBe('observe');
    expect(JSON.stringify(row)).not.toContain('secret');
  });

  it('parses Retry-After as seconds or an HTTP date', () => {
    const now = Date.parse('2026-10-01T12:00:00Z');
    expect(parseRetryAfterMs('3', now)).toBe(3_000);
    expect(parseRetryAfterMs('1.5', now)).toBe(1_500);
    expect(parseRetryAfterMs('Thu, 01 Oct 2026 12:00:05 GMT', now)).toBe(5_000);
    expect(parseRetryAfterMs('soon', now)).toBeUndefined();
    expect(parseRetryAfterMs(undefined, now)).toBeUndefined();
  });
});

/*
 * The socket itself: `HyperindexUpstream.execute` (and so `loadTokens`) runs
 * through the gateway, reads the lane from the caller's context, and maps what
 * the gateway refuses onto the transport errors the callers already understand.
 */
describe('HyperindexUpstream through the gateway', () => {
  function stubFetch(reply: (init: RequestInit) => Promise<Response> | Response) {
    const spy = vi.fn(async (_url: unknown, init: RequestInit) => reply(init));
    vi.stubGlobal('fetch', spy);
    return spy;
  }
  const ok = () => new Response(JSON.stringify({ data: { Pool: [] } }), { status: 200, headers: { 'content-type': 'application/json' } });

  it('meters every execute and loadTokens call under the caller lane', async () => {
    const { gateway, meter } = make({ ...DEFAULT_INDEXER_GATEWAY_CONFIG, mode: 'observe' });
    stubFetch(() => new Response(JSON.stringify({ data: { Token: [] } }), { status: 200 }));
    const upstream = new HyperindexUpstream(URL_, { gateway });

    const { runInLane } = await import('../../src/subgraph/hyperindex/indexer-context.js');
    await runInLane({ lane: 'refresh', job: 'refresh' }, async () => {
      await upstream.execute('query { Pool { id } }', {});
      await upstream.loadTokens(['1_0xabc']);
    });

    const w = meter.snapshot().current;
    expect(w.lanes.refresh).toBe(2);
    expect(w.jobs.refresh).toBe(2);
  });

  it('surfaces a 429 with its Retry-After, and pauses the bucket in enforce mode', async () => {
    const { gateway } = make(enforce());
    stubFetch(() => new Response('slow down', { status: 429, headers: { 'retry-after': '4' } }));
    const upstream = new HyperindexUpstream(URL_, { gateway });

    const err = (await upstream.execute('q', {}).catch((e: unknown) => e)) as UpstreamTransportError;
    expect(err).toBeInstanceOf(UpstreamTransportError);
    expect(err.httpStatus).toBe(429);
    expect(err.retryAfter).toBe('4');
    expect(gateway.snapshot().pausedForMs).toBe(4_000);
  });

  it('maps a deadline hit while paused to a 429, and a dropped call to a worded 502', async () => {
    const { gateway } = make(enforce());
    const spy = stubFetch(() => new Response('slow down', { status: 429, headers: { 'retry-after': '30' } }));
    const upstream = new HyperindexUpstream(URL_, { gateway });
    const { runInLane } = await import('../../src/subgraph/hyperindex/indexer-context.js');
    await upstream.execute('q', {}).catch(() => undefined);
    expect(spy).toHaveBeenCalledTimes(1);

    const queued = runInLane({ lane: 'interactive', deadlineAt: Date.now() + 1_000 }, () =>
      upstream.execute('q', {}),
    ).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_001);
    const rl = (await queued) as UpstreamTransportError;
    expect(rl.httpStatus).toBe(429);
    expect(spy).toHaveBeenCalledTimes(1);

    const ac = new AbortController();
    const dropped = runInLane({ lane: 'interactive', signal: ac.signal, deadlineAt: Date.now() + 8_000 }, () =>
      upstream.execute('q', {}),
    ).catch((e: unknown) => e);
    await tick();
    ac.abort(new ClientClosedError());
    const d = (await dropped) as UpstreamTransportError;
    expect(d).toBeInstanceOf(UpstreamTransportError);
    expect(d.httpStatus).toBe(502);
    expect(d.message).toMatch(/client closed/);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('turns a gateway timeout into "abandoned", not "unreachable"', async () => {
    const { gateway } = make(enforce({ backgroundTimeoutMs: 1_000 }));
    stubFetch(
      (init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
        }),
    );
    const upstream = new HyperindexUpstream(URL_, { gateway });

    const p = upstream.execute('q', {}).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_001);
    const err = (await p) as UpstreamTransportError;
    expect(err.httpStatus).toBe(502);
    expect(err.message).toMatch(/abandoned: timed out after 1000ms/);
  });

  it('passes the caller signal to fetch in observe mode, and a body still parses', async () => {
    const { gateway } = make({ ...DEFAULT_INDEXER_GATEWAY_CONFIG, mode: 'observe' });
    const spy = stubFetch(() => ok());
    const upstream = new HyperindexUpstream(URL_, { gateway });
    const { runInLane } = await import('../../src/subgraph/hyperindex/indexer-context.js');
    const ac = new AbortController();

    const out = await runInLane({ lane: 'interactive', signal: ac.signal }, () => upstream.execute('q', {}));
    expect(out).toEqual({ data: { Pool: [] } });
    expect((spy.mock.calls[0][1] as RequestInit).signal).toBe(ac.signal);
  });
});
