/*
 * Envio ⇄ Ponder: which indexer serves a chain, and what happens when one is
 * down or behind.
 *
 * The failover is exercised through a REAL graphql-request client and a stubbed
 * global fetch, because the property that matters is that callers need no change:
 * `new GraphQLClient(url, subgraphFetch(integration))` must keep returning data
 * while the primary is failing, and must surface the primary's own error when
 * nothing can answer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLClient } from 'graphql-request';

import { buildIntegrations, parseSourceOrder, type IndexerSource } from '../src/config/integrations.config.js';
import { subgraphFetch, __resetSubgraphFetchCache } from '../src/subgraph/hyperindex/client.js';
import {
  __resetIndexerFailover,
  __setIndexerFailoverClock,
  __setIndexerSourceBlock,
  indexerFailoverSnapshot,
  indexerFallbackServes,
  probeIndexerSources,
  routeOrder,
} from '../src/subgraph/indexer-failover.js';
import { SubgraphCurrentProvider } from '../src/pricing/providers/subgraph-current.provider.js';

const ENVIO = 'https://indexer.hyperindex.xyz/abc123/v1/graphql';
const PONDER = 'https://ponder-mainnet.example/subgraph';

describe('buildIntegrations — indexer sources', () => {
  const eth = (env: Record<string, string>) => buildIntegrations(env).find((i) => i.chainId === 1)!;

  it('Envio alone behaves exactly as before: one source, same url and dialect', () => {
    const row = eth({ UNISWAP_V4_INDEXER_URL: ENVIO, UNISWAP_V4_INDEXER_DIALECT: 'hyperindex' });
    expect(row).toMatchObject({ enabled: true, subgraphUrl: ENVIO, dialect: 'hyperindex' });
    expect(row.sources).toEqual([{ kind: 'envio', url: ENVIO, dialect: 'hyperindex' }]);
  });

  it('with both configured and no order, Envio is primary and Ponder the fallback', () => {
    const row = eth({
      UNISWAP_V4_INDEXER_URL: ENVIO,
      UNISWAP_V4_INDEXER_DIALECT: 'hyperindex',
      ETHEREUM_UNISWAP_V4_PONDER_URL: PONDER,
    });
    expect(row.sources?.map((s) => s.kind)).toEqual(['envio', 'ponder']);
    expect(row).toMatchObject({ subgraphUrl: ENVIO, dialect: 'hyperindex' });
  });

  it('the fleet order can put Ponder first; the primary then defines subgraphUrl and dialect', () => {
    const row = eth({
      UNISWAP_V4_INDEXER_URL: ENVIO,
      UNISWAP_V4_INDEXER_DIALECT: 'hyperindex',
      ETHEREUM_UNISWAP_V4_PONDER_URL: PONDER,
      UNISWAP_V4_INDEXER_SOURCES: 'ponder,envio',
    });
    expect(row.sources?.map((s) => s.kind)).toEqual(['ponder', 'envio']);
    // Ponder's /subgraph speaks the Graph dialect natively, whatever Envio's is.
    expect(row).toMatchObject({ subgraphUrl: PONDER, dialect: 'thegraph' });
  });

  it('a per-chain order overrides the fleet order', () => {
    const env = {
      UNISWAP_V4_INDEXER_URL: ENVIO,
      ETHEREUM_UNISWAP_V4_PONDER_URL: PONDER,
      AVALANCHE_UNISWAP_V4_PONDER_URL: 'https://ponder-avax.example/subgraph',
      UNISWAP_V4_INDEXER_SOURCES: 'ponder,envio',
      AVALANCHE_UNISWAP_V4_INDEXER_SOURCES: 'envio,ponder',
    };
    const rows = buildIntegrations(env);
    expect(rows.find((i) => i.chainId === 1)!.sources?.map((s) => s.kind)).toEqual(['ponder', 'envio']);
    expect(rows.find((i) => i.chainId === 43114)!.sources?.map((s) => s.kind)).toEqual(['envio', 'ponder']);
  });

  it('a one-name order uses only that indexer, even when the other is configured', () => {
    const row = eth({ UNISWAP_V4_INDEXER_URL: ENVIO, ETHEREUM_UNISWAP_V4_PONDER_URL: PONDER, UNISWAP_V4_INDEXER_SOURCES: 'ponder' });
    expect(row.sources?.map((s) => s.kind)).toEqual(['ponder']);
  });

  it('a listed source the chain has no url for is skipped, not an error', () => {
    // Fleet-wide `ponder,envio`, but this chain has no Ponder deployment.
    const row = eth({ UNISWAP_V4_INDEXER_URL: ENVIO, UNISWAP_V4_INDEXER_SOURCES: 'ponder,envio' });
    expect(row.sources?.map((s) => s.kind)).toEqual(['envio']);
    expect(row.enabled).toBe(true);
  });

  it('Ponder alone enables a chain with no Envio url', () => {
    const row = eth({ ETHEREUM_UNISWAP_V4_PONDER_URL: PONDER });
    expect(row).toMatchObject({ enabled: true, subgraphUrl: PONDER, dialect: 'thegraph' });
  });

  it('a chain with neither is disabled', () => {
    expect(eth({}).enabled).toBe(false);
  });

  it('an unknown or repeated source name fails loudly', () => {
    expect(() => eth({ UNISWAP_V4_INDEXER_URL: ENVIO, UNISWAP_V4_INDEXER_SOURCES: 'envio,pondr' })).toThrow(/unknown indexer source "pondr"/);
    expect(() => parseSourceOrder('envio,envio', 'X')).toThrow(/more than once/);
    expect(() => parseSourceOrder(' , ', 'X')).toThrow(/empty/);
    expect(parseSourceOrder(' Ponder , ENVIO ', 'X')).toEqual(['ponder', 'envio']);
  });
});

// ─── Failover through a real client ─────────────────────────────────────────

type Behaviour = 'ok' | 'down' | '503' | '429' | 'gqlerror' | 'notfound';

const QUERY = 'query Q { positions(first: 1) { id } }';
const SOURCES: IndexerSource[] = [
  { kind: 'envio', url: 'https://envio.test/graphql', dialect: 'thegraph' },
  { kind: 'ponder', url: 'https://ponder.test/subgraph', dialect: 'thegraph' },
];
const integration = {
  chainId: 1,
  protocol: 'uniswap-v4' as const,
  subgraphUrl: SOURCES[0]!.url,
  dialect: 'thegraph' as const,
  sources: SOURCES,
  enabled: true,
};

let behaviour: Record<string, Behaviour>;
let blocks: Record<string, number>;
let calls: string[];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push(url);
      const b = behaviour[url] ?? 'ok';
      const body = JSON.parse(String(init.body)) as { query: string };
      if (b === 'down') throw new TypeError('fetch failed');
      if (b === '503') return json(503, { error: 'unavailable' });
      if (b === '429') return json(429, { error: 'slow down' });
      if (b === 'notfound') return json(404, { error: 'no route' });
      if (b === 'gqlerror') return json(200, { errors: [{ message: `from ${url}: too far behind` }] });
      if (body.query.includes('_meta')) return json(200, { data: { _meta: { block: { number: blocks[url] ?? 1000 } } } });
      return json(200, { data: { positions: [{ id: url.includes('ponder') ? 'from-ponder' : 'from-envio' }] } });
    }),
  );
}

const request = () =>
  new GraphQLClient(integration.subgraphUrl, subgraphFetch(integration)).request<{ positions: Array<{ id: string }> }>(QUERY);

describe('failover fetch', () => {
  let now = 1_000_000;

  beforeEach(() => {
    process.env.INDEXER_FAILOVER_PROBE_MS = '0'; // no background timers; probes are driven explicitly
    __resetIndexerFailover();
    __resetSubgraphFetchCache();
    now = 1_000_000;
    __setIndexerFailoverClock(() => now);
    behaviour = {};
    blocks = {};
    calls = [];
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.INDEXER_FAILOVER_PROBE_MS;
    __resetIndexerFailover();
  });

  it('serves from the primary while it is healthy, never touching the fallback', async () => {
    await expect(request()).resolves.toEqual({ positions: [{ id: 'from-envio' }] });
    expect(calls).toEqual([SOURCES[0]!.url]);
    expect(indexerFallbackServes(1)).toBe(0);
  });

  it.each<[Behaviour, string]>([
    ['down', 'a network error'],
    ['503', 'a 5xx'],
    ['429', 'a rate limit'],
    ['notfound', 'a 404 (mis-pointed url)'],
  ])('fails over to the fallback on %s (%s)', async (b) => {
    behaviour[SOURCES[0]!.url] = b;
    await expect(request()).resolves.toEqual({ positions: [{ id: 'from-ponder' }] });
    expect(calls).toEqual([SOURCES[0]!.url, SOURCES[1]!.url]);
    expect(indexerFallbackServes(1)).toBe(1);
  });

  it('fails over a request on a 200 carrying GraphQL errors, without cooling the primary down', async () => {
    behaviour[SOURCES[0]!.url] = 'gqlerror';
    await expect(request()).resolves.toEqual({ positions: [{ id: 'from-ponder' }] });
    expect(calls).toEqual([SOURCES[0]!.url, SOURCES[1]!.url]);
    expect(indexerFallbackServes(1)).toBe(1);

    // One heavy query erroring is not an outage: the next request still tries the primary first.
    behaviour[SOURCES[0]!.url] = 'ok';
    calls = [];
    await expect(request()).resolves.toEqual({ positions: [{ id: 'from-envio' }] });
    expect(calls).toEqual([SOURCES[0]!.url]);
  });

  it('cools the primary down once it has answered with GraphQL errors three times running', async () => {
    behaviour[SOURCES[0]!.url] = 'gqlerror';
    await request();
    await request();
    await request(); // third in a row → cooldown
    calls = [];
    await request();
    expect(calls).toEqual([SOURCES[1]!.url]);
  });

  it('a success between GraphQL errors resets the streak', async () => {
    behaviour[SOURCES[0]!.url] = 'gqlerror';
    await request();
    await request();
    behaviour[SOURCES[0]!.url] = 'ok';
    await request(); // primary answers → streak reset
    behaviour[SOURCES[0]!.url] = 'gqlerror';
    await request();
    await request(); // only two in a row again
    calls = [];
    await request();
    expect(calls[0]).toBe(SOURCES[0]!.url);
  });

  it('skips a failed primary for its cooldown, then tries it again and returns to it', async () => {
    behaviour[SOURCES[0]!.url] = 'down';
    await request();
    calls = [];

    // Inside the 15s cooldown the primary is not even attempted.
    now += 5_000;
    await expect(request()).resolves.toEqual({ positions: [{ id: 'from-ponder' }] });
    expect(calls).toEqual([SOURCES[1]!.url]);

    // The primary recovers; after the cooldown it is tried first again and wins.
    behaviour[SOURCES[0]!.url] = 'ok';
    now += 20_000;
    calls = [];
    await expect(request()).resolves.toEqual({ positions: [{ id: 'from-envio' }] });
    expect(calls).toEqual([SOURCES[0]!.url]);
    expect(indexerFallbackServes(1)).toBe(2); // only the two fallback answers counted
  });

  it('backs off longer each time the primary keeps failing', async () => {
    behaviour[SOURCES[0]!.url] = 'down';
    await request(); // 1st failure → 15s
    now += 16_000;
    await request(); // tried again, 2nd failure → 30s
    calls = [];
    now += 20_000; // still inside the doubled cooldown
    await request();
    expect(calls).toEqual([SOURCES[1]!.url]);
  });

  it("when nothing answers, the caller sees the PRIMARY's own error, as with one source", async () => {
    behaviour[SOURCES[0]!.url] = 'gqlerror';
    behaviour[SOURCES[1]!.url] = '503';
    await expect(request()).rejects.toThrow(/from https:\/\/envio\.test\/graphql: too far behind/);
  });

  it('when every source throws, the first network error propagates (retry logic still sees it)', async () => {
    behaviour[SOURCES[0]!.url] = 'down';
    behaviour[SOURCES[1]!.url] = 'down';
    await expect(request()).rejects.toThrow(/fetch failed/);
  });

  it('with every source cooling down, all are still tried — failover never makes an outage worse', async () => {
    behaviour[SOURCES[0]!.url] = 'down';
    behaviour[SOURCES[1]!.url] = 'down';
    await request().catch(() => undefined);
    behaviour[SOURCES[1]!.url] = 'ok';
    calls = [];
    await expect(request()).resolves.toEqual({ positions: [{ id: 'from-ponder' }] });
  });

  it('prefers the fallback while the primary lags beyond the budget, and returns once it catches up', async () => {
    // Mainnet, 12s blocks, default 300s budget → 25 blocks.
    __setIndexerSourceBlock(1, SOURCES[0]!, 1_000);
    __setIndexerSourceBlock(1, SOURCES[1]!, 1_020);
    expect(routeOrder(1, SOURCES).map((s) => s.kind)).toEqual(['envio', 'ponder']); // 20 blocks: within budget

    __setIndexerSourceBlock(1, SOURCES[1]!, 1_100); // 100 blocks behind
    expect(routeOrder(1, SOURCES).map((s) => s.kind)).toEqual(['ponder', 'envio']);
    await expect(request()).resolves.toEqual({ positions: [{ id: 'from-ponder' }] });

    __setIndexerSourceBlock(1, SOURCES[0]!, 1_100);
    expect(routeOrder(1, SOURCES).map((s) => s.kind)).toEqual(['envio', 'ponder']);
  });

  it('the background probe reads each source block and marks an unreachable one down', async () => {
    blocks = { [SOURCES[0]!.url]: 500, [SOURCES[1]!.url]: 900 };
    behaviour[SOURCES[1]!.url] = '503';
    request(); // registers the chain
    await probeIndexerSources(1);

    const snap = indexerFailoverSnapshot(1)!;
    expect(snap.sources).toEqual([
      { kind: 'envio', state: 'ok', indexedBlock: 500 },
      { kind: 'ponder', state: 'down', indexedBlock: null, lastError: 'probe: HTTP 503' },
    ]);
  });

  it('never puts a url into the error /health shows', async () => {
    behaviour[SOURCES[0]!.url] = 'gqlerror';
    await request();
    await request();
    await request(); // third GraphQL-error answer in a row → down, with the redacted message
    const envio = indexerFailoverSnapshot(1)!.sources[0]!;
    expect(envio.state).toBe('down');
    expect(envio.lastError).toBe('from <url> too far behind');
    expect(indexerFailoverSnapshot(1)!.serving).toBe('ponder');
  });

  it('a single-source integration is untouched: the plain global fetch, no failover state', () => {
    const single = { chainId: 1, dialect: 'thegraph' as const, subgraphUrl: SOURCES[0]!.url, sources: [SOURCES[0]!] };
    expect(subgraphFetch(single).fetch).toBe(fetch);
    expect(indexerFailoverSnapshot(1)).toBeUndefined();
  });

  it('pricing fails over too, and a fallback answer does not trip its 30s rate-limit backoff', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        calls.push(url);
        if (url === SOURCES[0]!.url) return json(429, { error: 'slow down' });
        return json(200, {
          data: { bundles: [{ ethPriceUSD: '2000' }], tokens: [{ id: '0xabc', derivedETH: '0.5' }] },
        });
      }),
    );
    const provider = new SubgraphCurrentProvider({
      pricingProviderMaxConcurrency: 1,
      enabledIntegrations: [integration],
    } as never);

    const prices = await provider.getCurrentBatch(1, ['0xABC']);
    expect([...prices.values()][0]?.priceUsd).toBe(1000);
    expect(calls).toEqual([SOURCES[0]!.url, SOURCES[1]!.url]);
    expect(provider.isAvailable()).toBe(true);
  });
});
