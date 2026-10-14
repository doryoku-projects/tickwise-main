/*
 * The only module here that opens a socket.
 *
 * Kept separate from the translator so translate/postprocess stay pure and
 * testable with no network, which is where nearly all the risk lives.
 *
 * Every request — the translated query AND the token stitch — goes through the
 * per-URL `IndexerGateway`, which meters it by lane/job and, in enforce mode,
 * budgets, prioritises and times it out. The lane comes from the caller's
 * AsyncLocalStorage context (`indexer-context.ts`), read here rather than passed
 * down, so no query path above this file had to change.
 */

import { UpstreamTransportError } from './errors.js';
import { currentIndexerContext } from './indexer-context.js';
import { GatewayRejection, gatewayForUrl, type GatewaySettled, type IndexerGateway } from './indexer-gateway.js';
import type { Row } from './postprocess.js';
import { STITCHED_TOKEN_FIELDS } from './schema-map.js';

/** One upstream call, settled inside the gateway so the slot is held until the body is read. */
interface Settled extends GatewaySettled {
  readonly body?: UpstreamResult;
  readonly parseError?: string;
}

export interface UpstreamResult {
  readonly data?: Record<string, unknown>;
  readonly errors?: unknown[];
}

/**
 * Fields the indexer writes ONCE, at Token creation. Safe to cache.
 * Defined in schema-map so `translate.ts` rejects a selection of anything else
 * rather than letting it read back a fabricated null.
 */
const CACHEABLE_TOKEN_FIELDS = STITCHED_TOKEN_FIELDS;

export class HyperindexUpstream {
  /*
   * Token cache, field-scoped on purpose.
   *
   * initialize-handler sets symbol/name/decimals/chainId only inside its
   * `if (!token0)` branch, so those four never change for a given address.
   * EVERY other Token column — volume, volumeUSD, txCount, poolCount, the TVLs,
   * derivedETH — is rewritten on every swap, so caching a whole Token row would
   * serve stale prices. The field scoping is the load-bearing rule here, not a
   * nicety: it is what makes the cache correct rather than merely fast.
   */
  private readonly tokenCache = new Map<string, Row>();

  constructor(
    private readonly url: string,
    private readonly opts: { readonly tokenCacheMax?: number; readonly gateway?: IndexerGateway } = {},
  ) {}

  /** Resolved per call (not cached) so a spec's or the boot's gateway config is always the one used. */
  private get gateway(): IndexerGateway {
    return this.opts.gateway ?? gatewayForUrl(this.url);
  }

  async execute(query: string, variables: Record<string, unknown>): Promise<UpstreamResult> {
    let settled: Settled;
    try {
      settled = await this.gateway.run<Settled>(currentIndexerContext(), async (signal) => {
        const res = await fetch(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query, variables }),
          signal,
        });
        if (res.status === 429) {
          return { status: 429, retryAfter: res.headers.get('retry-after') ?? undefined };
        }
        if (!res.ok) return { status: res.status };
        // Parsing has to be guarded too. A 200 carrying an HTML error page or a
        // truncated body — a proxy hiccup, an auth wall, a gateway notice — threw
        // a raw SyntaxError from here, which `isProxyError` does not recognise, so
        // `fetch.ts` rethrew it and the injected fetch REJECTED instead of
        // returning a Response. That breaks the contract graphql-request relies on
        // and bypasses the no-`data`-key path entirely. Metered as a 5xx: the
        // upstream answered, with something unusable.
        try {
          return { status: res.status, body: (await res.json()) as UpstreamResult };
        } catch (e) {
          // An abort mid-body is the caller going away, not a bad body.
          if (signal?.aborted) throw e;
          return { status: 502, parseError: (e as Error).message };
        }
      });
    } catch (e) {
      if (e instanceof GatewayRejection) {
        throw new UpstreamTransportError(e.message, e.rateLimited ? 429 : 502, e.retryAfter);
      }
      const err = e as Error;
      // A gateway timeout or a client hang-up arrives as the signal's reason.
      // Same 502 as any transport failure (the callers' retry rules already know
      // it), worded so a log says which it was.
      if (err?.name === 'AbortError' || err?.name === 'TimeoutError') {
        throw new UpstreamTransportError(`indexer request abandoned: ${err.message}`, 502);
      }
      throw new UpstreamTransportError(`indexer unreachable: ${err?.message ?? String(e)}`, 502);
    }
    if (settled.status === 429) {
      throw new UpstreamTransportError('indexer is rate limiting', 429, settled.retryAfter);
    }
    if (settled.parseError !== undefined) {
      throw new UpstreamTransportError(`indexer returned a non-JSON body: ${settled.parseError}`, 502);
    }
    if (settled.status < 200 || settled.status >= 300) {
      throw new UpstreamTransportError(`indexer returned HTTP ${settled.status}`, 502);
    }
    return settled.body as UpstreamResult;
  }

  /**
   * Batched Token lookup for the Pool.token0/token1 stitch.
   *
   * Cache-first because the miss path costs a full extra round trip per page —
   * ~300 per pools sync, which against a hosted endpoint is seconds to tens of
   * seconds of added latency per chain per hour.
   */
  async loadTokens(envioIds: readonly string[]): Promise<Map<string, Row>> {
    const out = new Map<string, Row>();
    const missing: string[] = [];
    for (const id of envioIds) {
      const hit = this.tokenCache.get(id);
      if (hit) out.set(id, hit);
      else missing.push(id);
    }
    if (missing.length === 0) return out;

    const CHUNK = 500;
    const cols = CACHEABLE_TOKEN_FIELDS.join(' ');
    for (let i = 0; i < missing.length; i += CHUNK) {
      const slice = missing.slice(i, i + CHUNK);
      const r = await this.execute(
        `query HxTokens($ids: [String!]!) { Token(where: { id: { _in: $ids } }, limit: ${CHUNK}) { ${cols} } }`,
        { ids: slice },
      );
      if (r.errors?.length) {
        throw new UpstreamTransportError('indexer error while loading tokens', 502);
      }
      for (const row of (r.data?.Token as Row[] | undefined) ?? []) {
        const id = String(row.id);
        out.set(id, row);
        this.remember(id, row);
      }
    }
    return out;
  }

  private remember(id: string, row: Row): void {
    const max = this.opts.tokenCacheMax ?? 200_000;
    // Plain FIFO eviction. These rows are immutable, so which one is dropped
    // only costs a refetch — never correctness.
    if (this.tokenCache.size >= max) {
      const oldest = this.tokenCache.keys().next();
      if (!oldest.done) this.tokenCache.delete(oldest.value);
    }
    this.tokenCache.set(id, row);
  }

  /** Test seam. */
  get cacheSize(): number {
    return this.tokenCache.size;
  }
}
