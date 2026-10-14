/*
 * A `fetch` that speaks The Graph on the outside and Hasura on the inside.
 *
 * This is the whole integration surface. Because graphql-request takes `fetch`
 * as an option, passing this covers every `new GraphQLClient(...)` call site
 * without touching a single query document.
 *
 * The contract was verified against graphql-request 6.1.0 rather than assumed:
 *
 *  - it calls fetch ONCE per request, with a plain `url: string` and a plain
 *    object `{ method, headers, body }` — never a Request, never batched, never
 *    form-encoded. `headers` is a plain object, NOT a Headers instance.
 *  - the body is always JSON `{ query, variables, operationName }`.
 *  - it reads only `.ok`, `.status`, `.headers` (iterated via forEach, so a
 *    real Headers is required) and `.text()`. It never calls `.json()`.
 *  - success needs ALL THREE of: ok === true, a Content-Type starting with
 *    application/json, and a truthy top-level `data`. Note `{"data":{}}` is
 *    success, because `{}` is truthy.
 *  - a custom fetch MAY make several upstream calls before returning one
 *    Response — nothing assumes 1:1. That is what lets the token stitch work.
 */

import { errorBody, isProxyError, UpstreamTransportError, InternalError } from './errors.js';
import { makeIdCodec } from './ids.js';
import { postProcess, type PostProcessCtx } from './postprocess.js';
import { translate } from './translate.js';
import { HyperindexUpstream } from './upstream.js';

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

function jsonResponse(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extra },
  });
}

export interface HyperindexFetchOptions {
  readonly chainId: number;
  readonly url: string;
  readonly tokenCacheMax?: number;
  warn?(message: string): void;
}

/**
 * Build the translating fetch for one chain's HyperIndex endpoint.
 *
 * Returned as `typeof fetch` deliberately: graphql-request's exported
 * `RequestConfig.fetch` is typed to the WHATWG shape, so the narrow
 * `(url: string, init: RequestInit) => Promise<Response>` it actually calls at
 * runtime does NOT typecheck against it.
 */
export function makeHyperindexFetch(opts: HyperindexFetchOptions): typeof fetch {
  const ids = makeIdCodec(opts.chainId);
  const upstream = new HyperindexUpstream(opts.url, { tokenCacheMax: opts.tokenCacheMax });
  const ctx: PostProcessCtx = {
    ids,
    chainId: opts.chainId,
    loadTokens: (list) => upstream.loadTokens(list),
    warn: opts.warn,
  };

  return async function hyperindexFetch(input, init): Promise<Response> {
    const raw = typeof init?.body === 'string' ? init.body : undefined;
    if (!raw) {
      return jsonResponse(400, errorBody([new UpstreamTransportError('expected a JSON body', 502)], opts.chainId));
    }

    let parsed: { query?: unknown; variables?: unknown; operationName?: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return jsonResponse(400, errorBody([new UpstreamTransportError('body is not JSON', 502)], opts.chainId));
    }
    if (typeof parsed.query !== 'string') {
      return jsonResponse(400, errorBody([new UpstreamTransportError('missing `query`', 502)], opts.chainId));
    }

    const variables = (parsed.variables ?? {}) as Record<string, unknown>;
    const operationName = typeof parsed.operationName === 'string' ? parsed.operationName : undefined;

    // `init.signal` is still NOT forwarded: cancellation comes from the caller's
    // indexer context instead (`indexer-context.ts`), which the gateway inside
    // `upstream.execute` reads — no signal has to travel through graphql-request.
    try {
      const plan = translate(parsed.query, variables, opts.chainId, operationName);
      const result = await upstream.execute(plan.query, plan.variables);

      // Pass Hasura's own errors through untouched. Rewording them would either
      // destroy or fabricate a match against the callers' retry heuristics.
      if (result.errors?.length) return jsonResponse(200, { errors: result.errors });
      if (!result.data) {
        return jsonResponse(200, errorBody([new UpstreamTransportError('indexer returned no data', 502)], opts.chainId));
      }

      const data = await postProcess(plan.shape, result.data, ctx);
      return jsonResponse(200, { data });
    } catch (e) {
      if (isProxyError(e)) {
        // A translation bug must NOT look like congestion. requestWithRetry and
        // the pricing providers both treat >= 500 as transient and back off, so
        // a 5xx here would mask a permanent bug behind retries. 200 + errors[]
        // surfaces it immediately instead.
        const status = e instanceof UpstreamTransportError ? e.httpStatus : 200;
        const extra: Record<string, string> = {};
        if (e instanceof UpstreamTransportError && e.retryAfter) {
          extra['retry-after'] = e.retryAfter;
        }
        return jsonResponse(status, errorBody([e], opts.chainId), extra);
      }
      // Anything else is an unexpected bug in this layer, and rethrowing it
      // would make the injected fetch REJECT — which graphql-request surfaces
      // as an opaque failure rather than a GraphQL error, and which this
      // function's own contract forbids. Report it the same way a translation
      // bug is reported: 200 + errors[], so it is immediately visible and is
      // NOT mistaken for congestion and retried.
      return jsonResponse(
        200,
        errorBody(
          [new InternalError(`hyperindex: unexpected internal error: ${(e as Error)?.message ?? String(e)}`)],
          opts.chainId,
        ),
      );
    }
  } as typeof fetch;
}
