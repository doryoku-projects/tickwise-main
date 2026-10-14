/*
 * The indexer lane travels implicitly, in AsyncLocalStorage, from four entry
 * points down to the one socket. Two hops are where it can be lost, and both are
 * pinned here against the REAL code rather than a stand-in:
 *
 *  1. graphql-request → the translating fetch (`subgraphFetch`) →
 *     `HyperindexUpstream.execute`, which is where the gateway reads it;
 *  2. Express middleware → the Nest controller. The middleware must wrap
 *     `next()` ITSELF; wrapping a promise chain would leave the handler outside.
 *     So a real Nest app is booted on an ephemeral port with the same middleware
 *     shape `main.ts` uses, and `main.ts` is pinned to that shape by its source.
 */

import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { GraphQLClient } from 'graphql-request';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { __resetSubgraphFetchCache, subgraphFetch } from '../../src/subgraph/hyperindex/client.js';
import {
  anySignal,
  ClientClosedError,
  currentIndexerContext,
  indexerSummary,
  installServerTiming,
  interactiveContextFor,
  isInteractivePath,
  laneForJob,
  recordJoinWait,
  routeJobName,
  runInLane,
  serverTimingValue,
  type IndexerContext,
} from '../../src/subgraph/hyperindex/indexer-context.js';
import { __resetIndexerGateways } from '../../src/subgraph/hyperindex/indexer-gateway.js';
import { __resetIndexerMeters, indexerMeterSnapshots } from '../../src/subgraph/hyperindex/indexer-meter.js';
import { requestWithRetry } from '../../src/subgraph/request-retry.js';

const URL_ = 'https://indexer.example.test/v1/graphql';
const integration = { chainId: 4663, dialect: 'hyperindex' as const, subgraphUrl: URL_ };

function stubIndexer() {
  const seen: Array<{ signal: AbortSignal | undefined }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      seen.push({ signal: init?.signal ?? undefined });
      // The translator aliases each Hasura root back to its subgraph name.
      return new Response(JSON.stringify({ data: { bundles: [{ id: '4663', ethPriceUSD: '1' }] } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return seen;
}

const BUNDLE_QUERY = 'query B { bundles(first: 1) { id ethPriceUSD } }';

afterEach(() => {
  vi.unstubAllGlobals();
  __resetSubgraphFetchCache();
  __resetIndexerGateways();
  __resetIndexerMeters();
});

describe('the lane survives graphql-request → subgraphFetch → execute', () => {
  it('reaches the gateway meter under the tagged lane and job', async () => {
    stubIndexer();
    const client = new GraphQLClient(URL_, subgraphFetch(integration));

    await runInLane({ lane: 'live', job: 'live-listener', chainId: 4663 }, async () => {
      // An extra hop through the event loop, the way real callers await things.
      await new Promise((r) => setTimeout(r, 1));
      await client.request(BUNDLE_QUERY);
    });

    const [m] = indexerMeterSnapshots();
    expect(m.current.lanes.live).toBe(1);
    expect(m.current.jobs['live-listener']).toBe(1);
  });

  it('also survives requestWithRetry, the wrapper most callers use', async () => {
    stubIndexer();
    const client = new GraphQLClient(URL_, subgraphFetch(integration));
    await runInLane({ lane: 'refresh', job: 'refresh' }, () => requestWithRetry(client, BUNDLE_QUERY));
    expect(indexerMeterSnapshots()[0].current.lanes.refresh).toBe(1);
  });

  it('carries the abort signal all the way to fetch (observe mode)', async () => {
    const seen = stubIndexer();
    const client = new GraphQLClient(URL_, subgraphFetch(integration));
    const ac = new AbortController();
    await runInLane({ lane: 'interactive', job: '/api/x', signal: ac.signal }, () => client.request(BUNDLE_QUERY));
    expect(seen[0].signal).toBe(ac.signal);
  });

  it('meters an untagged call as the LOWEST lane, `sweep`', async () => {
    stubIndexer();
    const client = new GraphQLClient(URL_, subgraphFetch(integration));
    await client.request(BUNDLE_QUERY);
    const w = indexerMeterSnapshots()[0].current;
    expect(w.lanes.sweep).toBe(1);
    expect(w.jobs.untagged).toBe(1);
  });

  it('keeps concurrent contexts apart', async () => {
    stubIndexer();
    const client = new GraphQLClient(URL_, subgraphFetch(integration));
    await Promise.all([
      runInLane({ lane: 'interactive', job: 'a' }, () => client.request(BUNDLE_QUERY)),
      runInLane({ lane: 'health', job: 'b' }, () => client.request(BUNDLE_QUERY)),
      runInLane({ lane: 'interactive', job: 'a' }, () => client.request(BUNDLE_QUERY)),
    ]);
    const w = indexerMeterSnapshots()[0].current;
    expect(w.jobs).toEqual({ a: 2, b: 1 });
    expect(w.lanes.health).toBe(1);
  });
});

/*
 * A real Nest app with the middleware in the shape `main.ts` uses: an
 * interactive context for /api and /v1, entered by wrapping `next()` itself.
 */
let observed: IndexerContext | undefined;
let release: (() => void) | undefined;

@Controller()
class ProbeController {
  @Get('api/top-positions/:chainId/:protocol/:positionId/charts')
  async charts() {
    await new Promise((r) => setTimeout(r, 5)); // cross an await before reading
    observed = currentIndexerContext();
    return { ok: true };
  }

  @Get('v1/positions')
  list() {
    observed = currentIndexerContext();
    return { ok: true };
  }

  @Get('v1/positions/:chainId/:protocol/:positionId')
  async detail() {
    // Stand in for two indexer calls the gateway would have recorded.
    const stats = currentIndexerContext().stats!;
    stats.indexerCalls += 2;
    stats.indexerMs += 345;
    return { ok: true };
  }

  @Get('account/me')
  me() {
    observed = currentIndexerContext();
    return { ok: true };
  }

  @Get('api/slow')
  async slow() {
    observed = currentIndexerContext();
    // Resolves only when the client hangs up — the request's signal is the trigger.
    await new Promise<void>((resolve) => {
      release = resolve;
      observed!.signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    return { ok: true };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

describe('HTTP middleware → Nest handler', () => {
  let app: Awaited<ReturnType<typeof NestFactory.create>>;
  let base: string;

  beforeAll(async () => {
    app = await NestFactory.create(ProbeModule, { logger: false });
    // The same three calls, in the same order, as the main.ts middleware.
    app.use((req: { url: string; originalUrl?: string }, res: Parameters<typeof installServerTiming>[0] & Parameters<typeof interactiveContextFor>[1], next: () => void) => {
      const startedAt = Date.now();
      const ctx = interactiveContextFor(req, res, 8_000, startedAt);
      if (ctx) installServerTiming(res, ctx, startedAt);
      if (ctx) return runInLane(ctx, next);
      next();
    });
    await app.listen(0, '127.0.0.1');
    const addr = app.getHttpServer().address() as { port: number };
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('reaches the controller as `interactive`, with the route template as the job', async () => {
    observed = undefined;
    const res = await fetch(`${base}/api/top-positions/4663/uniswap-v4/3468131/charts?range=all`);
    expect(res.status).toBe(200);
    expect(observed?.lane).toBe('interactive');
    expect(observed?.job).toBe('/api/top-positions/:id/uniswap-v4/:id/charts');
    expect(observed?.deadlineAt).toBeGreaterThan(Date.now());
    expect(observed?.signal?.aborted).toBe(false);
  });

  it('tags /v1 too, and leaves every other realm untagged', async () => {
    await fetch(`${base}/v1/positions?owner=0xabc`);
    expect(observed?.lane).toBe('interactive');
    expect(observed?.job).toBe('/v1/positions');

    await fetch(`${base}/account/me`);
    expect(observed?.lane).toBe('sweep');
    expect(observed?.job).toBe('untagged');
  });

  it('aborts the request signal when the client hangs up mid-request', async () => {
    observed = undefined;
    const ac = new AbortController();
    const pending = fetch(`${base}/api/slow`, { signal: ac.signal }).catch(() => undefined);
    for (let i = 0; i < 100 && !observed; i++) await new Promise((r) => setTimeout(r, 5));
    expect(observed?.signal?.aborted).toBe(false);

    ac.abort();
    await pending;
    for (let i = 0; i < 100 && !observed!.signal!.aborted; i++) await new Promise((r) => setTimeout(r, 5));
    expect(observed!.signal!.aborted).toBe(true);
    expect(observed!.signal!.reason).toBeInstanceOf(ClientClosedError);
    release?.();
  });

  it('stamps Server-Timing with the total and the indexer time the request spent', async () => {
    const res = await fetch(`${base}/v1/positions/1/uniswap-v4/42`);
    const header = res.headers.get('server-timing');
    expect(header).toMatch(/^total;dur=\d+, indexer;dur=345;desc="2 calls"$/);

    // Routes outside /api and /v1 carry none.
    const other = await fetch(`${base}/account/me`);
    expect(other.headers.get('server-timing')).toBeNull();
  });

  it('does NOT abort a request that finished normally (close also follows finish)', async () => {
    await fetch(`${base}/v1/positions`);
    await new Promise((r) => setTimeout(r, 20));
    expect(observed!.signal!.aborted).toBe(false);
  });
});

describe('main.ts is wired the way the spec above exercises', () => {
  const source = readFileSync(new URL('../../src/main.ts', import.meta.url), 'utf8');

  it('enters the lane by wrapping next() itself, from the interactive context', () => {
    expect(source).toContain('const indexerCtx = interactiveContextFor(req, res, interactiveDeadlineMs, startedAt);');
    expect(source).toContain('if (indexerCtx) return runInLane(indexerCtx, next);');
  });

  it('configures the gateways before listen(), compresses, and stamps Server-Timing', () => {
    expect(source.indexOf('configureIndexerGateways(config.indexerGatewayConfig);')).toBeGreaterThan(-1);
    expect(source.indexOf('configureIndexerGateways(')).toBeLessThan(source.indexOf('await app.listen('));
    expect(source).toContain('app.use(compression({ threshold: 1024 }));');
    expect(source).toContain('if (indexerCtx) installServerTiming(res, indexerCtx, startedAt);');
    // Compression goes in after CORS, before the access-log middleware.
    expect(source.indexOf('app.enableCors(')).toBeLessThan(source.indexOf('app.use(compression('));
  });

  it('warns on a slow /api or /v1 request even when it succeeded', () => {
    expect(source).toContain('const slow = indexerCtx !== undefined && ms > SLOW_REQUEST_MS;');
    expect(source).toContain('else if (slow) httpLogger.warn(line + detail);');
    expect(source).toMatch(/const SLOW_REQUEST_MS = 1_000;/);
  });
});

describe('helpers', () => {
  it('maps BullMQ job names to lanes, defaulting to the lowest', () => {
    expect(laneForJob('backfill')).toBe('refresh');
    expect(laneForJob('refresh')).toBe('refresh');
    expect(laneForJob('live-refresh')).toBe('live');
    for (const sweep of ['pool-sync', 'token-security-sync', 'token-price-sync', 'position-fee-refresh', 'brand-new-job']) {
      expect(laneForJob(sweep)).toBe('sweep');
    }
  });

  it('routeJobName drops ids, hex and the query, and keeps the route words', () => {
    expect(routeJobName('/api/top-positions/1/uniswap-v4/3468131/charts?range=30d')).toBe(
      '/api/top-positions/:id/uniswap-v4/:id/charts',
    );
    expect(routeJobName('/v1/pools/43114/uniswap-v4/0xABCDEF0123')).toBe('/v1/pools/:id/uniswap-v4/:id');
    expect(routeJobName('/api/top-pools/1/uniswap-v4/0x' + 'a'.repeat(64) + '/charts')).toBe(
      '/api/top-pools/:id/uniswap-v4/:id/charts',
    );
    // Anything odd collapses rather than minting a new meter row.
    expect(routeJobName('/api/top-positions/' + 'x'.repeat(40))).toBe('/api/top-positions/:id');
    expect(routeJobName('/api/top-positions/a%20b')).toBe('/api/top-positions/:id');
  });

  it('only /api and /v1 are interactive', () => {
    expect(isInteractivePath('/api/top-positions')).toBe(true);
    expect(isInteractivePath('/v1')).toBe(true);
    expect(isInteractivePath('/v1?x=1')).toBe(true);
    expect(isInteractivePath('/apix')).toBe(false);
    expect(isInteractivePath('/account/me')).toBe(false);
    expect(isInteractivePath('/admin/sync/status')).toBe(false);
    expect(isInteractivePath('/health')).toBe(false);
  });

  it('Server-Timing carries total, indexer time and call count, and queue wait when there was some', () => {
    const ctx: IndexerContext = { lane: 'interactive', stats: { indexerMs: 812.4, indexerCalls: 3, queuedMs: 0 } };
    expect(serverTimingValue(ctx, 1_000, 2_250)).toBe('total;dur=1250, indexer;dur=812;desc="3 calls"');
    ctx.stats!.queuedMs = 40;
    expect(serverTimingValue(ctx, 1_000, 2_250)).toContain('indexer-queue;dur=40');
    expect(indexerSummary(ctx)).toBe('indexer=812ms calls=3 queued=40ms');
  });

  it('a joined single-flight wait is reported apart from indexer time, and only when there was one', () => {
    const ctx: IndexerContext = {
      lane: 'interactive',
      stats: { indexerMs: 0, indexerCalls: 0, queuedMs: 0, joinedMs: 0, joins: 0 },
    };
    // A wait with no join is not a join, and must not leak into a later one.
    recordJoinWait(ctx, 500, 0);
    expect(ctx.stats!.joinedMs).toBe(0);
    expect(serverTimingValue(ctx, 1_000, 2_250)).toBe('total;dur=1250, indexer;dur=0;desc="0 calls"');
    expect(indexerSummary(ctx)).toBe('indexer=0ms calls=0');

    recordJoinWait(ctx, 1_499.6, 1);
    recordJoinWait(ctx, -5, 1); // a clock step backwards never subtracts
    expect(ctx.stats!.joins).toBe(2);
    expect(serverTimingValue(ctx, 1_000, 2_750)).toBe(
      'total;dur=1750, indexer;dur=0;desc="0 calls", indexer-join;dur=1500;desc="2 joined"',
    );
    expect(indexerSummary(ctx)).toBe('indexer=0ms calls=0 joined=1500ms/2');

    // Stats built without the join fields (older call sites) read as none.
    const bare: IndexerContext = { lane: 'interactive', stats: { indexerMs: 5, indexerCalls: 1, queuedMs: 0 } };
    expect(indexerSummary(bare)).toBe('indexer=5ms calls=1');
    recordJoinWait(bare, 200, 1);
    expect(indexerSummary(bare)).toBe('indexer=5ms calls=1 joined=200ms/1');
    // No stats (a job, not an HTTP request): nothing to record into.
    expect(() => recordJoinWait({ lane: 'refresh' }, 100, 1)).not.toThrow();
  });

  it('an interactive context starts with no joins', () => {
    const res = { writableFinished: false, on: () => undefined };
    const ctx = interactiveContextFor({ url: '/api/top-positions/1/uniswap-v4/9' }, res, 8_000, 0)!;
    expect(ctx.stats).toEqual({ indexerMs: 0, indexerCalls: 0, queuedMs: 0, joinedMs: 0, joins: 0 });
  });

  it('anySignal fires on whichever source aborts first, with or without AbortSignal.any', () => {
    const a = new AbortController();
    const b = new AbortController();
    expect(anySignal([undefined, undefined])).toBeUndefined();
    expect(anySignal([a.signal])).toBe(a.signal);

    const combined = anySignal([a.signal, b.signal])!;
    b.abort('b');
    expect(combined.aborted).toBe(true);
    expect(combined.reason).toBe('b');

    // The fallback path, for a Node without AbortSignal.any (engines allows 20.0).
    const native = (AbortSignal as unknown as { any?: unknown }).any;
    (AbortSignal as unknown as { any?: unknown }).any = undefined;
    try {
      const c = new AbortController();
      const d = new AbortController();
      const fallback = anySignal([c.signal, d.signal])!;
      expect(fallback.aborted).toBe(false);
      c.abort('c');
      expect(fallback.aborted).toBe(true);
      expect(fallback.reason).toBe('c');
      const pre = new AbortController();
      pre.abort('early');
      expect(anySignal([pre.signal, d.signal])!.reason).toBe('early');
    } finally {
      (AbortSignal as unknown as { any?: unknown }).any = native;
    }
  });
});
