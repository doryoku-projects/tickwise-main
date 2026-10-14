/*
 * `/health`'s per-integration indexing status.
 *
 * The INDEXED head comes from the indexer's own `_meta` through the same
 * translating fetch every other indexer read uses — it used to be a REST call to
 * Ponder's `/status`. The CHAIN head still comes from DeFiLlama's keyless
 * block-by-timestamp endpoint, deliberately: it is an INDEPENDENT observer, so a
 * stalled or unreachable indexer shows up as lag rather than as a self-reported
 * zero. Everything about the lag budget, the time-scaling, the SWR cache and the
 * single-flight is unchanged.
 *
 * A refresh is now ONE indexer request. The second one — `_meta { block {
 * timestamp } }`, a `ModifyLiquidity order_by timestamp desc` scan that took
 * 18-30s+ off mainnet and kept running on the indexer's Postgres after we gave up
 * on it — is gone, and `indexedUpToTimestamp` is derived as `now − lagSeconds`.
 * A failed probe still does not overwrite the last good reading: it stands in
 * for up to five minutes, then gives way to `null`. The TTL is 60s, not 15s.
 *
 * `graphql-request` is mocked so each `_meta` document can be asserted and made
 * to fail; global `fetch` is stubbed for the DeFiLlama half only.
 */

import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../src/config/app-config.service.js';
import type { IntegrationConfig } from '../src/config/integrations.config.js';
import {
  currentIndexerContext,
  runInLane,
  type IndexerContext,
} from '../src/subgraph/hyperindex/indexer-context.js';
import {
  __resetIndexerGateways,
  configureIndexerGateways,
} from '../src/subgraph/hyperindex/indexer-gateway.js';

/** Every `_meta` request, with the indexer context it was issued under. */
const gqlRequests: Array<{ url: string; query: string; ctx: IndexerContext }> = [];
/** Answers ONE `_meta` request. */
let metaResponder: (query: string) => unknown;

vi.mock('graphql-request', () => ({
  gql: (strings: TemplateStringsArray, ...values: unknown[]) =>
    strings.reduce((acc, s, i) => acc + s + (i < values.length ? String(values[i]) : ''), ''),
  GraphQLClient: class {
    constructor(private readonly url: string) {}
    async request<T>(query: string): Promise<T> {
      gqlRequests.push({ url: this.url, query, ctx: currentIndexerContext() });
      return metaResponder(query) as T;
    }
  },
}));

const { IndexingStatusService, LLAMA_CHAIN_SLUG } = await import(
  '../src/health/indexing-status.service.js'
);

const INDEXER_URL = 'https://indexer.hyperindex.xyz/abc123/v1/graphql';

function integrationFor(chainId: number, over: Partial<IntegrationConfig> = {}): IntegrationConfig {
  return {
    chainId,
    protocol: 'uniswap-v4',
    enabled: true,
    dialect: 'hyperindex',
    subgraphUrl: INDEXER_URL,
    ...over,
  } as IntegrationConfig;
}

const integration = integrationFor(1);

function makeConfig(over: { indexerMaxLagBlocks?: number } = {}): AppConfigService {
  return {
    indexerMaxLagBlocks: over.indexerMaxLagBlocks ?? 250,
  } as unknown as AppConfigService;
}

/**
 * `number` is 0 (never null) for a chain the deployment does not cover, which
 * the service must map to `null` rather than to block 0.
 */
function meta(block: { number?: number } | null) {
  return (query: string) => {
    if (block === null) return {};
    // Like the real translator, answer only what the document selected.
    const picked: { number?: number } = {};
    if (/\bnumber\b/.test(query) && block.number !== undefined) picked.number = block.number;
    return { _meta: { block: { hash: null, ...picked } } };
  };
}

/** The block probe failing outright (a 504, a rate limit, a Hasura error). */
const failing = () => () => {
  throw new Error('indexer returned HTTP 504');
};

interface FetchOpts {
  head?: number | null; // DeFiLlama height; null → missing height field
  headOk?: boolean; // false → non-200 from DeFiLlama
  headThrows?: boolean; // DeFiLlama fetch throws
}

function stubFetch(opts: FetchOpts = {}) {
  const fn = vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes('coins.llama.fi/block/')) {
      if (opts.headThrows) throw new Error('llama down');
      if (opts.headOk === false) return { ok: false, json: async () => ({}) } as Response;
      if (opts.head === null) return { ok: true, json: async () => ({}) } as Response;
      return { ok: true, json: async () => ({ height: opts.head ?? 150, timestamp: 1800 }) } as Response;
    }
    throw new Error(`unexpected fetch: ${u}`);
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

/**
 * `indexedUpToTimestamp` is `floor(now / 1000) − lagSeconds`. With real timers
 * "now" is somewhere inside the call, so assert the window it must fall in.
 */
async function expectNowMinus(
  run: () => Promise<{ indexedUpToTimestamp: number | null }>,
  lagSeconds: number,
): Promise<void> {
  const before = Math.floor(Date.now() / 1000);
  const s = await run();
  const after = Math.floor(Date.now() / 1000);
  expect(s.indexedUpToTimestamp).not.toBeNull();
  expect(s.indexedUpToTimestamp!).toBeGreaterThanOrEqual(before - lagSeconds);
  expect(s.indexedUpToTimestamp!).toBeLessThanOrEqual(after - lagSeconds);
}

describe('IndexingStatusService', () => {
  beforeEach(() => {
    gqlRequests.length = 0;
    metaResponder = meta({ number: 100 });
    // Captured rather than printed: the probe-failure paths log by design, and
    // several tests below assert on exactly WHEN they do.
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    __resetIndexerGateways();
  });

  it('reads the indexed head from the indexer `_meta` in ONE request', async () => {
    stubFetch({ head: 150 });
    const svc = new IndexingStatusService(makeConfig());

    await svc.getStatus(integration);

    expect(gqlRequests).toHaveLength(1);
    expect(gqlRequests[0].url).toBe(INDEXER_URL);
    // `_meta` must be the ONLY root selection — the converter routes a meta-only
    // document down its own path and throws if it is mixed with entity queries.
    expect(gqlRequests[0].query).toMatch(/_meta/);
    expect(gqlRequests[0].query).not.toMatch(/positions|pools|tokens/);
  });

  // THE CHANGE. Selecting `timestamp` makes the converter add the
  // `ModifyLiquidity order_by timestamp desc` scan (18-30s+ on 42161/43114/4663,
  // left running on the indexer's Postgres). No document may ask for it.
  it('never asks the indexer for the timestamp — the ModifyLiquidity scan is gone', async () => {
    stubFetch({ head: 150 });
    const svc = new IndexingStatusService(makeConfig());

    await svc.getStatus(integration);
    await svc.getStatus(integrationFor(43114));

    expect(gqlRequests.length).toBeGreaterThan(0);
    for (const r of gqlRequests) {
      expect(r.query).toMatch(/\bnumber\b/);
      expect(r.query).not.toMatch(/\btimestamp\b/);
    }
  });

  it('reports synced + current block and lag (healthy), with the timestamp derived from the lag', async () => {
    stubFetch({ head: 150 });
    const svc = new IndexingStatusService(makeConfig());

    await expectNowMinus(async () => {
      const s = await svc.getStatus(integration);
      expect(s.indexedBlock).toBe(100);
      expect(s.chainHeadBlock).toBe(150);
      expect(s.lagBlocks).toBe(50);
      expect(s.lagSeconds).toBe(600); // 50 blocks × 12s
      expect(s.synced).toBe(true);
      expect(s.status).toBe('healthy');
      return s;
    }, 600);
  });

  // The "~N days" line on /status.
  describe('lagSeconds (lag in blocks × the chain block time)', () => {
    it.each([
      [1, 150, 600], // 50 blocks × 12s
      [43114, 3000, 2900], // 2,900 × 1s
      [42161, 12_000, 2975], // 11,900 × 250ms
      [4663, 10_100, 1000], // 10,000 × 100ms
      // Rounded to WHOLE seconds, to the nearest — not truncated, not ceiled.
      [42161, 105, 1], // 5 × 250ms = 1.25s
      [42161, 107, 2], // 7 × 250ms = 1.75s
    ])('chain %i: head %i → %is', async (chainId, head, seconds) => {
      stubFetch({ head });
      const svc = new IndexingStatusService(makeConfig());
      expect((await svc.getStatus(integrationFor(chainId))).lagSeconds).toBe(seconds);
    });

    it('is null — and so is indexedUpToTimestamp — when the lag in blocks is unknown', async () => {
      stubFetch({ headThrows: true });
      const svc = new IndexingStatusService(makeConfig());
      const s = await svc.getStatus(integration);
      expect(s.lagBlocks).toBeNull();
      expect(s.lagSeconds).toBeNull();
      // Never a guess from the wall clock alone.
      expect(s.indexedUpToTimestamp).toBeNull();
    });

    it('is null for a chain with no configured block time, even with a known lag', async () => {
      // 137 is not in CHAINS, so it has no block time. Give it a chain-head source
      // so the lag in BLOCKS is known — otherwise this would only re-test the
      // "lag unknown" case above and never reach the block-time check.
      LLAMA_CHAIN_SLUG[137] = 'polygon';
      try {
        stubFetch({ head: 150 });
        const svc = new IndexingStatusService(makeConfig());
        const s = await svc.getStatus(integrationFor(137));
        expect(s.lagBlocks).toBe(50);
        expect(s.lagSeconds).toBeNull();
        expect(s.indexedUpToTimestamp).toBeNull();
      } finally {
        delete LLAMA_CHAIN_SLUG[137];
      }
    });

    it('is 0, not null, for a chain that is caught up — and the data is current to now', async () => {
      metaResponder = meta({ number: 150 });
      stubFetch({ head: 150 });
      const svc = new IndexingStatusService(makeConfig());
      await expectNowMinus(async () => {
        const s = await svc.getStatus(integration);
        expect(s.lagSeconds).toBe(0);
        return s;
      }, 0);
    });

    it('follows the chain block time: 4663 lags 1000s behind now, not 1000 × 12s', async () => {
      stubFetch({ head: 10_100 });
      const svc = new IndexingStatusService(makeConfig());
      await expectNowMinus(() => svc.getStatus(integrationFor(4663)), 1000);
    });
  });

  it('marks degraded when lag exceeds the threshold', async () => {
    stubFetch({ head: 10000 });
    const svc = new IndexingStatusService(makeConfig({ indexerMaxLagBlocks: 250 }));

    const s = await svc.getStatus(integration);
    expect(s.lagBlocks).toBe(9900);
    expect(s.synced).toBe(false);
    expect(s.status).toBe('degraded');
  });

  it('tolerates a larger block lag on a fast chain (Avalanche scales the budget by block time)', async () => {
    // lag 2900 would be 'degraded' on mainnet (>250) but is well within Avalanche's
    // scaled budget (250 × 12000ms / 1000ms = 3000 blocks ≈ same ~50min wall-clock).
    stubFetch({ head: 3000 });
    const svc = new IndexingStatusService(makeConfig({ indexerMaxLagBlocks: 250 }));

    const s = await svc.getStatus(integrationFor(43114));
    expect(s.lagBlocks).toBe(2900);
    expect(s.synced).toBe(true);
    expect(s.status).toBe('healthy');
  });

  // Arbitrum is the fastest chain we index: 251.7ms measured over 2,000,000 blocks
  // => 48x mainnet's block count for the same wall-clock tolerance. A block-count
  // threshold tuned on mainnet would mark this chain permanently degraded, which is
  // exactly what the time-scaling exists to prevent.
  it('scales the budget 48x on a ~250ms-block chain (Arbitrum)', async () => {
    // 250 x 12000ms / 250ms = 12000 blocks (~50min wall-clock, same as mainnet's 250).
    stubFetch({ head: 12_000 });
    const svc = new IndexingStatusService(makeConfig({ indexerMaxLagBlocks: 250 }));

    const s = await svc.getStatus(integrationFor(42161));
    expect(s.lagBlocks).toBe(11_900);
    expect(s.synced).toBe(true);
    expect(s.status).toBe('healthy');
  });

  it('still degrades a ~250ms-block chain past its scaled budget', async () => {
    stubFetch({ head: 20_000 });
    const svc = new IndexingStatusService(makeConfig({ indexerMaxLagBlocks: 250 }));

    const s = await svc.getStatus(integrationFor(42161));
    expect(s.lagBlocks).toBe(19_900);
    expect(s.synced).toBe(false);
    expect(s.status).toBe('degraded');
  });

  it('marks a fast chain degraded only past its scaled budget', async () => {
    stubFetch({ head: 4000 });
    const svc = new IndexingStatusService(makeConfig({ indexerMaxLagBlocks: 250 }));

    const s = await svc.getStatus(integrationFor(43114));
    expect(s.lagBlocks).toBe(3900); // > 3000 scaled budget
    expect(s.synced).toBe(false);
    expect(s.status).toBe('degraded');
  });

  // Measured live on the shared deployment: Avalanche came back FOUR blocks ahead
  // of DeFiLlama's approximate tip. The clamp is load-bearing, not defensive.
  it('clamps lag to 0 when the indexer is ahead of the llama tip', async () => {
    metaResponder = meta({ number: 200 });
    stubFetch({ head: 198 });
    const svc = new IndexingStatusService(makeConfig());

    const s = await svc.getStatus(integration);
    expect(s.lagBlocks).toBe(0);
    expect(s.status).toBe('healthy');
  });

  it('is unhealthy when the indexer reports no block', async () => {
    metaResponder = meta(null);
    stubFetch({ head: 150 });
    const svc = new IndexingStatusService(makeConfig());

    const s = await svc.getStatus(integration);
    expect(s.indexedBlock).toBeNull();
    expect(s.indexedUpToTimestamp).toBeNull();
    expect(s.status).toBe('unhealthy');
    expect(s.synced).toBe(false);
  });

  // `progressBlock` is 0 — not null — for a chain the deployment does not index,
  // and the `> 0` test is what maps that onto 'unhealthy' instead of block 0.
  it('treats a zero indexed block as unhealthy, not as block 0', async () => {
    metaResponder = meta({ number: 0 });
    stubFetch({ head: 150 });
    const svc = new IndexingStatusService(makeConfig());

    const s = await svc.getStatus(integration);
    expect(s.indexedBlock).toBeNull();
    // No lag, so no timestamp — it must NOT reach /v1/stats as a 1970 date or as
    // "current to now".
    expect(s.indexedUpToTimestamp).toBeNull();
    expect(s.status).toBe('unhealthy');
  });

  it('never throws when the indexer query fails — reports unhealthy instead', async () => {
    metaResponder = failing();
    stubFetch({ head: 150 });
    const svc = new IndexingStatusService(makeConfig());

    const s = await svc.getStatus(integration);
    expect(s.indexedBlock).toBeNull();
    expect(s.status).toBe('unhealthy');
    // The two halves are independent: DeFiLlama still answered, so the chain head
    // is reported even though the indexer could not be reached. That is the whole
    // reason the head comes from an outside observer.
    expect(s.chainHeadBlock).toBe(150);
    expect(s.lagBlocks).toBeNull(); // undefined on one side → no lag to report
    expect(s.indexedUpToTimestamp).toBeNull();
  });

  it('reports not_deployed when no indexer URL is configured', async () => {
    const fn = stubFetch();
    const svc = new IndexingStatusService(makeConfig());

    const s = await svc.getStatus(integrationFor(1, { subgraphUrl: undefined }));
    expect(s.status).toBe('not_deployed');
    expect(s.indexedBlock).toBeNull();
    expect(fn).not.toHaveBeenCalled();
    expect(gqlRequests).toHaveLength(0);
  });

  it('caches within the TTL — a second call does not refetch', async () => {
    const fn = stubFetch({ head: 150 });
    const svc = new IndexingStatusService(makeConfig());

    await svc.getStatus(integration);
    await svc.getStatus(integration);
    // One `_meta` request and one DeFiLlama call for the first (cold) call; the
    // second is served fresh.
    expect(gqlRequests).toHaveLength(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('single-flights concurrent cold calls', async () => {
    const fn = stubFetch({ head: 150 });
    const svc = new IndexingStatusService(makeConfig());

    const [a, b] = await Promise.all([svc.getStatus(integration), svc.getStatus(integration)]);
    expect(a).toEqual(b);
    expect(gqlRequests).toHaveLength(1); // one refresh's worth — both callers share it
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('queries DeFiLlama block-by-timestamp with the current unix seconds', async () => {
    const fn = stubFetch({ head: 150 });
    const svc = new IndexingStatusService(makeConfig());

    await svc.getStatus(integration);
    const llamaCall = fn.mock.calls.find(([url]) =>
      /^https:\/\/coins\.llama\.fi\/block\/ethereum\/\d+$/.test(String(url)),
    );
    expect(llamaCall).toBeDefined();
  });

  it('omits the chain head for a chain with no DeFiLlama slug', async () => {
    const fn = stubFetch();
    const svc = new IndexingStatusService(makeConfig());

    // chainId 137 is not in LLAMA_CHAIN_SLUG → no chain-head source.
    const s = await svc.getStatus(integrationFor(137));
    expect(s.indexedBlock).toBe(100);
    expect(s.chainHeadBlock).toBeNull();
    expect(s.lagBlocks).toBeNull();
    expect(s.indexedUpToTimestamp).toBeNull();
    expect(s.status).toBe('healthy'); // indexed shown alone
    expect(fn).not.toHaveBeenCalled(); // no DeFiLlama attempt
    expect(gqlRequests).toHaveLength(1);
  });

  it('fails soft when the DeFiLlama call throws', async () => {
    stubFetch({ headThrows: true });
    const svc = new IndexingStatusService(makeConfig());

    const s = await svc.getStatus(integration);
    expect(s.indexedBlock).toBe(100);
    expect(s.chainHeadBlock).toBeNull();
    expect(s.lagBlocks).toBeNull();
    expect(s.status).toBe('healthy');
  });

  /*
   * The probe runs in the indexer's `health` lane, so the gateway meters it as
   * such — and NOT in whichever lane happened to trigger the refresh. `/v1/stats`
   * reaches `getStatus` from an interactive HTTP request; a refresh is shared by
   * every caller that dedups onto it, so carrying that caller's abort signal
   * would let one hang-up cancel the probe for everybody.
   */
  describe('indexer lane', () => {
    it('tags the probe `health`, even when an interactive request triggers the refresh', async () => {
      stubFetch({ head: 150 });
      const svc = new IndexingStatusService(makeConfig());
      const callerAbort = new AbortController();

      await runInLane({ lane: 'interactive', job: '/v1/stats', signal: callerAbort.signal }, () =>
        svc.getStatus(integration),
      );

      expect(gqlRequests).toHaveLength(1);
      expect(gqlRequests[0].ctx.lane).toBe('health');
      expect(gqlRequests[0].ctx.job).toBe('health');
      expect(gqlRequests[0].ctx.chainId).toBe(1);
      expect(gqlRequests[0].ctx.signal).not.toBe(callerAbort.signal);
    });

    it('adds no deadline signal in observe mode (no new timeouts), one in enforce mode', async () => {
      stubFetch({ head: 150 });
      await new IndexingStatusService(makeConfig()).getStatus(integration);
      expect(gqlRequests[0].ctx.signal).toBeUndefined();

      configureIndexerGateways({ mode: 'enforce' });
      await new IndexingStatusService(makeConfig()).getStatus(integration);
      expect(gqlRequests[1].ctx.signal).toBeInstanceOf(AbortSignal);
      expect(gqlRequests[1].ctx.signal!.aborted).toBe(false);
    });
  });
});

/*
 * A failed probe must not overwrite the last good reading — the other half of the
 * "mainnet reports indexedBlock: null one refresh in four" bug. `fetchStatus`
 * fails soft (returns nulls rather than throwing), so the `keep last-good` the
 * refresh path promised never happened: every hiccup replaced a healthy value
 * with an unhealthy one for a full TTL.
 */
describe('IndexingStatusService — last-good carry-forward', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let info: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Only the timers the service uses; `setImmediate` stays real so the tests can
    // flush microtasks without advancing the fake clock.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-09-30T12:00:00Z'));
    gqlRequests.length = 0;
    metaResponder = meta({ number: 100 });
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    info = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    __resetIndexerGateways();
  });

  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  const blockFailed = () =>
    warn.mock.calls.filter(([m]) => String(m).includes('indexed-block probe failed'));
  /** The fake clock does not move inside a call, so this is exact. */
  const nowSeconds = () => Math.floor(Date.now() / 1000);

  /**
   * One full refresh cycle: move past the TTL, ask (which serves the STALE value
   * and kicks the background refresh), let that refresh finish, ask again.
   */
  async function refreshed(
    svc: InstanceType<typeof IndexingStatusService>,
    over = integration,
    advanceMs = 61_000,
  ) {
    await vi.advanceTimersByTimeAsync(advanceMs);
    await svc.getStatus(over);
    await flush();
    return svc.getStatus(over);
  }

  it('serves the cache for the whole 60s TTL, and refreshes once it has passed', async () => {
    stubFetch({ head: 150 });
    const svc = new IndexingStatusService(makeConfig());
    await svc.getStatus(integration);
    expect(gqlRequests).toHaveLength(1);

    // 59s on: still fresh. A 15s TTL (the old value) would have refetched here.
    await vi.advanceTimersByTimeAsync(59_000);
    await svc.getStatus(integration);
    await flush();
    expect(gqlRequests).toHaveLength(1);

    // Past 60s: stale → one background refresh.
    await vi.advanceTimersByTimeAsync(1_500);
    await svc.getStatus(integration);
    await flush();
    expect(gqlRequests).toHaveLength(2);
  });

  it('keeps the last good block when a later probe fails, and re-derives lag from the LIVE head', async () => {
    stubFetch({ head: 150 });
    const svc = new IndexingStatusService(makeConfig());
    const first = await svc.getStatus(integration);
    expect(first.indexedBlock).toBe(100);
    expect(first.lagBlocks).toBe(50);

    metaResponder = failing();
    stubFetch({ head: 400 });
    const s = await refreshed(svc);

    // Carried, NOT nulled: the status page keeps a real reading instead of
    // flipping mainnet to "indexed not reporting".
    expect(s.indexedBlock).toBe(100);
    // The chain moved on; the lag is measured against the head we just read, so a
    // carried block can only make it look WORSE, never hide it.
    expect(s.chainHeadBlock).toBe(400);
    expect(s.lagBlocks).toBe(300);
    expect(s.status).toBe('degraded'); // 300 > 250 — not 'unhealthy'
    // And the derived timestamp follows the carried block's lag: 300 × 12s.
    expect(s.indexedUpToTimestamp).toBe(nowSeconds() - 3600);
  });

  it('stops carrying after five minutes — a dead indexer must not stay green', async () => {
    stubFetch({ head: 150 });
    const svc = new IndexingStatusService(makeConfig());
    await svc.getStatus(integration);

    metaResponder = failing();
    stubFetch({ head: 150 });

    // 4 min after the last success: still inside the window.
    const within = await refreshed(svc, integration, 4 * 60_000);
    expect(within.indexedBlock).toBe(100);
    expect(within.status).toBe('healthy');
    expect(within.indexedUpToTimestamp).toBe(nowSeconds() - 600);

    // The window is measured from the last SUCCESS, not the last attempt — a
    // failing refresh does not refresh the carried reading.
    const past = await refreshed(svc, integration, 2 * 60_000);
    expect(past.indexedBlock).toBeNull();
    expect(past.indexedUpToTimestamp).toBeNull();
    expect(past.status).toBe('unhealthy');
  });

  it('does NOT mask a real "nothing indexed" answer with an older block', async () => {
    stubFetch({ head: 150 });
    const svc = new IndexingStatusService(makeConfig());
    await svc.getStatus(integration);

    // The indexer ANSWERS, and says it holds nothing for this chain (progressBlock
    // 0). That is data, not a failed probe — serving the old block over it would
    // hide exactly the outage this page exists to show.
    metaResponder = meta({ number: 0 });
    const empty = await refreshed(svc);
    expect(empty.indexedBlock).toBeNull();
    expect(empty.status).toBe('unhealthy');

    // …and the old reading is gone for good: a later FAILURE must not resurrect it.
    metaResponder = failing();
    const failed = await refreshed(svc);
    expect(failed.indexedBlock).toBeNull();
    expect(failed.status).toBe('unhealthy');
  });

  it('replaces a carried reading as soon as a probe succeeds again', async () => {
    stubFetch({ head: 150 });
    const svc = new IndexingStatusService(makeConfig());
    await svc.getStatus(integration);

    metaResponder = failing();
    expect((await refreshed(svc)).indexedBlock).toBe(100); // carried

    metaResponder = meta({ number: 140 });
    const s = await refreshed(svc);
    expect(s.indexedBlock).toBe(140);
    expect(s.indexedUpToTimestamp).toBe(nowSeconds() - 120); // 10 blocks × 12s
  });

  it('has nothing to carry on a cold start, and says so rather than inventing a block', async () => {
    metaResponder = failing();
    stubFetch({ head: 150 });
    const svc = new IndexingStatusService(makeConfig());

    const s = await svc.getStatus(integration);
    expect(s.indexedBlock).toBeNull();
    expect(s.indexedUpToTimestamp).toBeNull();
    expect(s.chainHeadBlock).toBe(150);
    expect(s.status).toBe('unhealthy');
  });

  // Refreshes are DEMAND-DRIVEN, so the five-minute window can elapse with no
  // failed refresh at all: nobody asks for twenty minutes, then one slow probe
  // lands on the first request back. That is a blip, not an outage.
  it('carries the FIRST failed refresh after a long idle gap, and only the second is an outage', async () => {
    stubFetch({ head: 150 });
    const svc = new IndexingStatusService(makeConfig());
    await svc.getStatus(integration);

    metaResponder = failing();
    stubFetch({ head: 150 });

    const first = await refreshed(svc, integration, 10 * 60_000); // nobody asked for 10 min
    expect(first.indexedBlock).toBe(100);
    expect(first.indexedUpToTimestamp).toBe(nowSeconds() - 600);
    expect(first.status).toBe('healthy');
    expect(blockFailed()).toHaveLength(1);

    // The same failure a refresh later IS an outage: the age bound applies from the
    // second consecutive failure on.
    const second = await refreshed(svc);
    expect(second.indexedBlock).toBeNull();
    expect(second.indexedUpToTimestamp).toBeNull();
    expect(second.status).toBe('unhealthy');
  });

  it('leaves no timer behind once a refresh has settled', async () => {
    stubFetch({ head: 150 });
    const svc = new IndexingStatusService(makeConfig());

    await svc.getStatus(integration);
    expect(vi.getTimerCount()).toBe(0);
  });

  describe('deadlines', () => {
    it('gives the block probe a 10s leash: a reading that lands at 6s is published', async () => {
      stubFetch({ head: 150 });
      const svc = new IndexingStatusService(makeConfig());
      await svc.getStatus(integration);

      // A SLOW but answering indexer: the block arrives at 6s, inside the 10s.
      metaResponder = (query) =>
        new Promise((resolve) => setTimeout(() => resolve(meta({ number: 130 })(query)), 6_000));
      await vi.advanceTimersByTimeAsync(61_000);
      await svc.getStatus(integration); // stale → kicks the refresh
      await vi.advanceTimersByTimeAsync(6_100);
      await flush();

      const s = await svc.getStatus(integration);
      expect(s.indexedBlock).toBe(130); // the slow answer, not the carried 100
      expect(s.status).toBe('healthy');
    });

    it('gives up on a block probe that never answers after 10s, and carries the last good one', async () => {
      stubFetch({ head: 150 });
      const svc = new IndexingStatusService(makeConfig());
      await svc.getStatus(integration);

      metaResponder = () => new Promise(() => {});
      await vi.advanceTimersByTimeAsync(61_000);
      await svc.getStatus(integration); // stale → kicks the refresh
      await vi.advanceTimersByTimeAsync(10_100);
      await flush();

      const s = await svc.getStatus(integration);
      expect(s.indexedBlock).toBe(100); // the 10s deadline passed; carried, not nulled
      expect(s.status).toBe('healthy');
    });
  });

  describe('parallelism', () => {
    it('a hung block probe releases the refresh at its 10s deadline', async () => {
      metaResponder = () => new Promise(() => {});
      stubFetch({ head: 150 });
      const svc = new IndexingStatusService(makeConfig());

      let done = false;
      void svc.getStatus(integration).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(9_900);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(done).toBe(true);
    });

    it('runs the chain-head fetch alongside the indexer probe, not after it', async () => {
      metaResponder = () => new Promise(() => {}); // the block hangs to its 10s deadline
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, 9_000)); // a slow DeFiLlama
          return { ok: true, json: async () => ({ height: 150 }) } as Response;
        }),
      );
      const svc = new IndexingStatusService(makeConfig());

      let done = false;
      void svc.getStatus(integration).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(10_001); // parallel: max(10s, 9s); serial: 19s
      expect(done).toBe(true);
    });
  });

  describe('warm-up', () => {
    it('warms every enabled integration at boot so the first /health is served from cache', async () => {
      const fn = stubFetch({ head: 150 });
      const eth = integrationFor(1);
      const avax = integrationFor(43114);
      const svc = new IndexingStatusService({
        indexerMaxLagBlocks: 250,
        enabledIntegrations: [eth, avax],
      } as unknown as AppConfigService);

      svc.onModuleInit();
      await flush();

      expect(gqlRequests).toHaveLength(2); // one block probe per chain
      expect(fn).toHaveBeenCalledTimes(2); // DeFiLlama, per chain

      const before = gqlRequests.length;
      expect((await svc.getStatus(eth)).indexedBlock).toBe(100);
      expect((await svc.getStatus(avax)).indexedBlock).toBe(100);
      expect(gqlRequests).toHaveLength(before); // served from the warmed cache
    });

    it('never lets a failing warm-up break boot', async () => {
      metaResponder = failing();
      stubFetch({ head: 150 });
      const svc = new IndexingStatusService({
        indexerMaxLagBlocks: 250,
        enabledIntegrations: [integration],
      } as unknown as AppConfigService);

      expect(() => svc.onModuleInit()).not.toThrow();
      // Let the fire-and-forget refresh settle INSIDE the test, so its log line
      // lands on the spy rather than on the real logger after teardown.
      await flush();
      expect((await svc.getStatus(integration)).status).toBe('unhealthy');
    });
  });

  describe('logging', () => {
    it('reports a failing block probe once, not once per refresh', async () => {
      stubFetch({ head: 150 });
      const svc = new IndexingStatusService(makeConfig());
      await svc.getStatus(integration);

      metaResponder = failing();
      await refreshed(svc);
      await refreshed(svc);
      await refreshed(svc);

      expect(blockFailed()).toHaveLength(1);
    });

    it('logs a recovery, and reports a second failure afresh', async () => {
      stubFetch({ head: 150 });
      const svc = new IndexingStatusService(makeConfig());
      await svc.getStatus(integration);

      metaResponder = failing();
      await refreshed(svc);
      expect(blockFailed()).toHaveLength(1);

      metaResponder = meta({ number: 110 });
      await refreshed(svc);
      const recovered = info.mock.calls.filter(([m]) => String(m).includes('probe recovered'));
      expect(recovered).toHaveLength(1);

      metaResponder = failing();
      await refreshed(svc);
      expect(blockFailed()).toHaveLength(2);
    });

    it('stays silent while the block probe keeps succeeding', async () => {
      stubFetch({ head: 150 });
      const svc = new IndexingStatusService(makeConfig());
      await svc.getStatus(integration);

      await refreshed(svc);
      await refreshed(svc);

      expect(warn).not.toHaveBeenCalled();
    });
  });
});
