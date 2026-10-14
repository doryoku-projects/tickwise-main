import { Logger } from '@nestjs/common';
import type { GraphQLClient } from 'graphql-request';
import { currentIndexerContext } from './hyperindex/indexer-context.js';
import { indexerGatewayMode, parseRetryAfterMs } from './hyperindex/indexer-gateway.js';

/*
 * Retry wrapper for indexer GraphQL requests — the ONE retry policy.
 *
 * It used to live inside the position adapter and was named after Ponder, which
 * made it look like Ponder-specific machinery. It never was: every Envio request
 * the adapter issues goes through it too, and it is the ONE retry classifier that
 * understands an error arriving as HTTP 200 with a GraphQL `errors[]` body.
 *
 * `charts.service.ts` and `pools-sync.service.ts` used to carry private copies
 * that retried EVERY error 3x at 300/600/900ms, ignoring Retry-After — so a 429
 * burst was multiplied by every job at once, and a user's chart sat in up to
 * four serial backoff rounds. Both now call this. The one private copy left is
 * `revert-compatible.adapter.ts` (the dormant v3 path), deliberately untouched.
 *
 * LANE-AWARE (the lane comes from the caller's indexer context):
 *  - interactive (an HTTP request someone is waiting on): at most ONE retry, and
 *    only if it fits inside the request's deadline. A 429 waits Retry-After
 *    (capped at 2s) rather than the exponential schedule.
 *  - everything else keeps the schedule below — except a 429 while the gateway
 *    is ENFORCING, which retries with no sleep of its own: the gateway has
 *    already paused the bucket, so the retry simply queues behind that pause in
 *    priority order instead of every caller sleeping its own backoff. A
 *    background caller also retries a Postgres statement timeout; an
 *    interactive one does not.
 *  - a caller whose request was aborted (the client hung up) is never retried.
 */

// Env names were `PONDER_RETRY_*`. They are raw `process.env` reads rather than
// Zod-schema entries, which is a wart — but they are also undocumented and unset
// in every env file in this repo, which is what makes renaming them safe.
const REQUEST_RETRY_MAX_ATTEMPTS = Math.max(1, Number(process.env.INDEXER_RETRY_ATTEMPTS) || 4);
const REQUEST_RETRY_BASE_MS = Math.max(100, Number(process.env.INDEXER_RETRY_BASE_MS) || 500);
/** An interactive caller makes at most this many attempts (one retry). */
const INTERACTIVE_MAX_ATTEMPTS = 2;
/** The longest an interactive caller will honour a Retry-After before its one retry. */
const INTERACTIVE_RETRY_AFTER_CAP_MS = 2_000;
const requestRetryLogger = new Logger('IndexerRequestRetry');

export async function requestWithRetry<T>(
  client: GraphQLClient,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const ctx = currentIndexerContext();
  const interactive = ctx.lane === 'interactive';
  const maxAttempts = interactive
    ? Math.min(INTERACTIVE_MAX_ATTEMPTS, REQUEST_RETRY_MAX_ATTEMPTS)
    : REQUEST_RETRY_MAX_ATTEMPTS;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await client.request<T>(query, variables ?? {});
    } catch (err) {
      lastErr = err;
      const status = (err as { response?: { status?: number } })?.response?.status ?? 0;
      const code =
        (err as { code?: string })?.code ??
        (err as { cause?: { code?: string } })?.cause?.code ??
        '';
      const message = err instanceof Error ? err.message : String(err);
      const networkError =
        /fetch failed|other side closed|socket|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR/i.test(
          `${message} ${code}`,
        );
      // Some upstream failures arrive as HTTP 200 carrying a GraphQL errors[]
      // body, so the status checks above never match them. Two known shapes: the
      // indexer proxy reporting the upstream unavailable or too far behind, and
      // (historically) The Graph gateway's "bad indexers" cohort flap. Both are
      // transient and a retry usually lands a healthy response.
      //
      // Rate limiting is deliberately NOT in this list. The indexer returns it as
      // a 429, which the status test above already catches; adding the literal
      // here would ALSO catch a 200-bodied variant — and this helper is on a read
      // hot path (`getPosition` → `fetchPositionTransactions` on the metered /v1
      // detail route), where it would turn a sub-second degrade into ~3.5s of
      // backoff while adding load to an endpoint that is already shedding.
      const transientUpstream =
        /bad indexers|no attestation|indexing_error|too far behind|unavailable/i.test(message);
      // A Postgres statement timeout also arrives as HTTP 200 + errors[]. For a
      // user request it is not worth a retry — one attempt, then the request
      // degrades. For a BACKGROUND walk it is: pool sync pages a large chain by
      // offset, the deep pages are the slow ones, and without a page-level
      // retry one timeout failed the job and its BullMQ retry re-walked every
      // page from skip 0 (the private copy this replaced retried everything).
      const statementTimeout = !interactive && /statement timeout|canceling statement/i.test(message);
      const retriable =
        (status >= 500 && status < 600) || status === 429 || networkError || transientUpstream || statementTimeout;
      if (!retriable || attempt === maxAttempts) throw err;
      // The caller has gone; a retry would spend budget on a response nobody reads.
      if (ctx.signal?.aborted) throw err;

      const delay = retryDelayMs({ status, attempt, interactive, err });
      if (interactive && ctx.deadlineAt !== undefined && Date.now() + delay >= ctx.deadlineAt) throw err;
      requestRetryLogger.warn(
        `indexer ${status || code || (transientUpstream ? 'transient-upstream' : statementTimeout ? 'statement-timeout' : 'network-error')} on attempt ${attempt}/${maxAttempts} ` +
          `(lane=${ctx.lane}${ctx.job ? ` job=${ctx.job}` : ''}), retrying in ${delay}ms`,
      );
      if (delay > 0) await sleep(delay, ctx.signal);
      if (ctx.signal?.aborted) throw err;
    }
  }
  throw lastErr;
}

function retryDelayMs(args: { status: number; attempt: number; interactive: boolean; err: unknown }): number {
  if (args.status === 429) {
    // The enforcing gateway already paused the bucket for this URL; the retry
    // waits there, in priority order, so sleeping here as well would double it.
    if (indexerGatewayMode() === 'enforce') return 0;
    if (args.interactive) {
      const headers = (args.err as { response?: { headers?: { get?: (name: string) => string | null } } })
        ?.response?.headers;
      const retryAfter = parseRetryAfterMs(typeof headers?.get === 'function' ? headers.get('retry-after') : undefined);
      return Math.min(INTERACTIVE_RETRY_AFTER_CAP_MS, retryAfter ?? REQUEST_RETRY_BASE_MS);
    }
  }
  return REQUEST_RETRY_BASE_MS * Math.pow(2, args.attempt - 1) + Math.floor(Math.random() * 250);
}

/** A sleep that ends early when the caller's request is aborted. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}
