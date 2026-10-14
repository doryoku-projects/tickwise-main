/*
 * One place that decides which dialect an integration speaks — and, when it has
 * more than one indexer, which indexer answers.
 *
 * Call sites build their clients as `new GraphQLClient(url, subgraphFetch(cfg))`
 * instead of `{ fetch }`. Nothing else about them changes — no query document is
 * touched, and a single-source `thegraph` integration gets the global fetch
 * exactly as before. An integration with several `sources` (Envio and Ponder)
 * gets the failover fetch from `../indexer-failover.ts`, which ignores the url
 * the client passes and tries each source's own url in priority order.
 */

import type { IndexerSource, IntegrationConfig } from '../../config/integrations.config.js';
import { failoverFetch } from '../indexer-failover.js';
import { makeHyperindexFetch } from './fetch.js';

/**
 * Translating fetches are cached per (chainId, url) because the token cache
 * lives inside one. A fresh fetch per request would throw the cache away and
 * put the extra Token round trip back on every single page.
 */
const cache = new Map<string, typeof fetch>();

/** A plain fetch resolved at CALL time, so a stubbed `globalThis.fetch` is honoured. */
const plainFetch: typeof fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
  globalThis.fetch(input, init)) as typeof fetch;

function translatingFetch(chainId: number, url: string): typeof fetch {
  const key = `${chainId}:${url}`;
  let translating = cache.get(key);
  if (!translating) {
    translating = makeHyperindexFetch({
      chainId,
      url,
      warn: (m) => console.warn(`hyperindex: ${m}`),
    });
    cache.set(key, translating);
  }
  return translating;
}

/** The fetch for exactly one source: translating for `hyperindex`, plain otherwise. */
export function sourceFetch(chainId: number, source: Pick<IndexerSource, 'url' | 'dialect'>): typeof fetch {
  return source.dialect === 'hyperindex' ? translatingFetch(chainId, source.url) : plainFetch;
}

export function subgraphFetch(integration: {
  chainId: number;
  dialect: IntegrationConfig['dialect'];
  subgraphUrl?: string;
  sources?: IntegrationConfig['sources'];
}): { fetch: typeof fetch } {
  const sources = integration.sources;
  if (sources && sources.length > 1) {
    return {
      fetch: failoverFetch(integration.chainId, sources, (source) => sourceFetch(integration.chainId, source)),
    };
  }
  if (integration.dialect !== 'hyperindex' || !integration.subgraphUrl) {
    return { fetch };
  }
  return { fetch: translatingFetch(integration.chainId, integration.subgraphUrl) };
}

/** Test seam. */
export function __resetSubgraphFetchCache(): void {
  cache.clear();
}
