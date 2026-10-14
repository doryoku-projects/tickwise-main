/*
 * Proxy error taxonomy.
 *
 * The governing rule: an unsupported or failed request must NEVER produce a
 * well-formed empty `data`. `{ data: { pools: [] } }` is indistinguishable from
 * a healthy end-of-walk, so a total outage would look like a completed sync.
 * Every error path below omits the `data` key entirely.
 */

import type { ASTNode } from "graphql";

/*
 * `EnvioAdapter` retries HTTP-200 responses whose error message
 * matches this pattern (envio.adapter.ts:890). A proxy-generated
 * message that collides with it turns a permanent translation bug into four
 * slow retries, so collisions throw at construction rather than at 3am.
 */
export const GATEWAY_RETRY_RE =
  /bad indexers|no attestation|indexing_error|too far behind|unavailable/i;

export type ProxyErrorCode =
  | "PROXY_UNSUPPORTED"
  | "PROXY_UPSTREAM_SHAPE"
  | "PROXY_UPSTREAM"
  | "PROXY_INTERNAL";

export interface ProxyError extends Error {
  readonly code: ProxyErrorCode;
  readonly httpStatus: number;
  readonly path?: string | undefined;
  readonly node?: ASTNode | undefined;
}

function guardWording(message: string): void {
  if (GATEWAY_RETRY_RE.test(message)) {
    throw new Error(
      `hyperindex: error text collides with the backend gateway-retry regex: ${message}`,
    );
  }
}

/** The document asked for something this proxy does not translate. */
export class TranslationError extends Error implements ProxyError {
  readonly code = "PROXY_UNSUPPORTED" as const;
  readonly httpStatus = 200;
  constructor(
    message: string,
    readonly path?: string | undefined,
    readonly node?: ASTNode | undefined,
  ) {
    super(`hyperindex: ${message}`);
    guardWording(this.message);
  }
}

/** Hasura answered, but with data this proxy cannot map back to Graph shape. */
export class UpstreamShapeError extends Error implements ProxyError {
  readonly code = "PROXY_UPSTREAM_SHAPE" as const;
  readonly httpStatus = 200;
  constructor(
    message: string,
    readonly path?: string | undefined,
    readonly node?: ASTNode | undefined,
  ) {
    super(`hyperindex: ${message}`);
    guardWording(this.message);
  }
}

/** The indexer is down, throttling, or unreachable. Genuinely transient. */
export class UpstreamTransportError extends Error implements ProxyError {
  readonly code = "PROXY_UPSTREAM" as const;
  readonly path = undefined;
  readonly node = undefined;
  constructor(
    message: string,
    readonly httpStatus: 429 | 502,
    readonly retryAfter?: string | undefined,
  ) {
    super(message);
  }
}

/** A bug in this proxy. */
export class InternalError extends Error implements ProxyError {
  readonly code = "PROXY_INTERNAL" as const;
  readonly httpStatus = 500;
  readonly path = undefined;
  readonly node = undefined;
}

export function isProxyError(e: unknown): e is ProxyError {
  return (
    e instanceof TranslationError ||
    e instanceof UpstreamShapeError ||
    e instanceof UpstreamTransportError ||
    e instanceof InternalError
  );
}

/** GraphQL error envelope with NO `data` key. */
export function errorBody(errors: readonly ProxyError[], chainId: number) {
  return {
    errors: errors.map((e) => {
      const loc = e.node?.loc;
      return {
        message: e.message,
        ...(loc
          ? {
              locations: [
                { line: loc.startToken.line, column: loc.startToken.column },
              ],
            }
          : {}),
        extensions: {
          code: e.code,
          proxyChainId: chainId,
          ...(e.path ? { path: e.path } : {}),
        },
      };
    }),
  };
}
