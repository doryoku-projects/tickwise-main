/*
 * The background entry points tag their indexer lane: BullMQ job handlers by job
 * name, and the live listener's whole poll loop as `live`. An untagged path falls
 * to `sweep` — slow rather than queue-jumping — so the cost of a missing tag is
 * that a job is mis-metered and, when the gateway enforces, mis-prioritised.
 * These pin the tags at the handler, where the service method actually runs.
 */

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { currentIndexerContext, type IndexerContext } from '../../src/subgraph/hyperindex/indexer-context.js';

const mocks = vi.hoisted(() => ({
  workers: [] as Array<{ processor: (job: unknown) => Promise<unknown> }>,
  requestMock: vi.fn(),
}));

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    ping: vi.fn(async () => 'PONG'),
    quit: vi.fn(async () => undefined),
  })),
}));

vi.mock('bullmq', () => ({
  Job: class {},
  Queue: vi.fn().mockImplementation(() => ({
    add: vi.fn(async () => ({ id: 'x' })),
    close: vi.fn(async () => undefined),
    getJobCounts: vi.fn(async () => ({})),
    getRepeatableJobs: vi.fn(async () => []),
    removeRepeatableByKey: vi.fn(async () => undefined),
    obliterate: vi.fn(async () => undefined),
  })),
  Worker: vi.fn().mockImplementation((_name: string, processor: (job: unknown) => Promise<unknown>) => {
    mocks.workers.push({ processor });
    return { close: vi.fn(async () => undefined), on: vi.fn() };
  }),
}));

vi.mock('graphql-request', () => ({
  GraphQLClient: vi.fn().mockImplementation(() => ({ request: mocks.requestMock })),
  gql: (strings: TemplateStringsArray) => strings.join(''),
}));

const { QueueService } = await import('../../src/queues/queue.service.js');
const { LiveEventListenerService } = await import('../../src/sync/live-event-listener.service.js');

/** Every service method records the context it ran under. */
function recorder() {
  const seen: Array<{ method: string; ctx: IndexerContext }> = [];
  const fn = (method: string) =>
    vi.fn(async () => {
      seen.push({ method, ctx: currentIndexerContext() });
      return { ok: true };
    });
  return { seen, fn };
}

describe('QueueService job handlers', () => {
  beforeEach(() => {
    mocks.workers.length = 0;
  });

  async function boot() {
    const r = recorder();
    const service = new QueueService(
      {
        redisUrl: 'redis://localhost:6379',
        positionsSyncCronEnabled: false,
        positionsSyncIntervalMs: 300_000,
        poolsSyncCronEnabled: false,
        tokenSecuritySyncEnabled: false,
        tokenPriceSyncEnabled: false,
        positionFeeRefreshEnabled: false,
        liveRefreshEnabled: true,
        liveRefreshConcurrency: 1,
        enabledIntegrations: [],
        evmRpcUrls: new Map(),
        getIntegration: () => ({ chainId: 1, protocol: 'uniswap-v4' }),
      } as never,
      {
        backfillTarget: r.fn('backfill'),
        refreshTarget: r.fn('refresh'),
        interruptedBackfills: async () => [],
      } as never,
      { registerEnqueue: vi.fn() } as never,
      { refreshPosition: r.fn('live-refresh') } as never,
      { syncPools: r.fn('pool-sync') } as never,
      { syncChain: r.fn('token-security-sync') } as never,
      { syncChain: r.fn('token-price-sync') } as never,
      { refreshChain: r.fn('position-fee-refresh') } as never,
    );
    await service.onModuleInit();
    // [0] positions-sync, [1] position-live-refresh, [2] background-sweeps, [3] positions-refresh.
    return {
      r,
      positions: mocks.workers[0].processor,
      live: mocks.workers[1].processor,
      refresh: mocks.workers[3].processor,
    };
  }

  it.each([
    ['backfill', 'refresh'],
    ['refresh', 'refresh'],
    ['pool-sync', 'sweep'],
    ['token-security-sync', 'sweep'],
    ['token-price-sync', 'sweep'],
    ['position-fee-refresh', 'sweep'],
  ])('runs a %s job in the %s lane, named after the job, scoped to its chain', async (name, lane) => {
    const { r, positions } = await boot();
    await positions({ name, data: { chainId: 4663, protocol: 'uniswap-v4' } });

    expect(r.seen).toHaveLength(1);
    expect(r.seen[0].method).toBe(name);
    expect(r.seen[0].ctx).toMatchObject({ lane, job: name, chainId: 4663 });
  });

  it('runs the cron refresh on its own positions-refresh worker, in the refresh lane', async () => {
    const { r, refresh } = await boot();
    await refresh({ name: 'refresh', data: { chainId: 42161, protocol: 'uniswap-v4' } });
    expect(r.seen).toHaveLength(1);
    expect(r.seen[0].method).toBe('refresh');
    expect(r.seen[0].ctx).toMatchObject({ lane: 'refresh', job: 'refresh', chainId: 42161 });
  });

  it('runs a live-refresh job in the live lane', async () => {
    const { r, live } = await boot();
    await live({ name: 'live-refresh', data: { chainId: 1, protocol: 'uniswap-v4', tokenId: '42', blockNumber: 7 } });
    expect(r.seen[0].ctx).toMatchObject({ lane: 'live', job: 'live-refresh', chainId: 1 });
  });

  it('does not leak a job lane outside the job', async () => {
    const { positions } = await boot();
    await positions({ name: 'backfill', data: { chainId: 1, protocol: 'uniswap-v4' } });
    expect(currentIndexerContext().lane).toBe('sweep');
    expect(currentIndexerContext().job).toBe('untagged');
  });
});

describe('LiveEventListenerService poll loop', () => {
  it('issues every poll and head probe in the live lane', async () => {
    const lanes: IndexerContext[] = [];
    mocks.requestMock.mockReset();
    mocks.requestMock.mockImplementation(async (query: string) => {
      lanes.push(currentIndexerContext());
      if (query.includes('orderDirection: asc')) return { positions: [] };
      return { positions: [{ updatedAtBlock: '100', updatedAtTimestamp: '1700000000' }] };
    });
    const service = new LiveEventListenerService(
      {
        liveRefreshEnabled: true,
        livePollMinMs: 1,
        livePollIntervalFallbackMs: 1,
        liveRefreshConcurrency: 1,
        enabledIntegrations: [
          { chainId: 1, protocol: 'uniswap-v4', subgraphUrl: 'https://indexer.example.test/v1/graphql', enabled: true },
        ],
      } as never,
      { getCursor: vi.fn(async () => null), markLiveCursor: vi.fn(async () => undefined) } as never,
      { resolve: () => ({ recomputeMode: 'aggregates' }) } as never,
    );
    service.registerEnqueue(vi.fn(async () => undefined));

    await service.onModuleInit();
    await new Promise((r) => setTimeout(r, 60));
    await service.onModuleDestroy();

    expect(lanes.length).toBeGreaterThan(0);
    for (const ctx of lanes) expect(ctx).toMatchObject({ lane: 'live', job: 'live-listener', chainId: 1 });
  });
});

describe('the private retry copies are gone', () => {
  // The charts' indexer reads moved to chart-inputs.service.ts (W6).
  it.each(['../../src/charts/chart-inputs.service.ts', '../../src/sync/pools-sync.service.ts'])(
    '%s uses the shared lane-aware requestWithRetry',
    (path) => {
      const source = readFileSync(new URL(path, import.meta.url), 'utf8');
      expect(source).not.toMatch(/function requestWithRetry/);
      expect(source).toContain("import { requestWithRetry } from '../subgraph/request-retry.js';");
    },
  );

  it('charts.service.ts carries no private copy either', () => {
    const source = readFileSync(new URL('../../src/charts/charts.service.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/function requestWithRetry/);
  });
});
