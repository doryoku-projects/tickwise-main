/*
 * Who is asking the indexer, carried implicitly.
 *
 * Every indexer request — a user's chart, the live listener's poll, a pool-sync
 * page — leaves through ONE socket (`HyperindexUpstream.execute`), and the hosted
 * deployment's 1000 req/min limit is shared by all of them. To meter that budget
 * per caller, and later to give user requests priority over background jobs, the
 * socket has to know whose request it is carrying. Threading a parameter through
 * fifteen GraphQLClient call sites, graphql-request and the translating fetch
 * would touch every query path in the backend; AsyncLocalStorage carries it for
 * free across every `await` in between.
 *
 * Tagging happens at the four entry points, and nowhere else:
 *  - `main.ts` HTTP middleware: `/api/*` and `/v1/*` → `interactive`;
 *  - `QueueService` job handlers: `laneForJob(job.name)`;
 *  - the live listener's poll loop → `live`;
 *  - `IndexingStatusService` refreshes → `health`.
 * Anything untagged is a `sweep`, the LOWEST priority — so a path that forgot to
 * tag itself is slow rather than one that jumps the queue ahead of users.
 *
 * THE WRAP MUST BE AROUND THE CALL ITSELF. `runInLane(ctx, next)` reaches the
 * Nest handler because Express calls the remaining middleware and the route
 * synchronously (or via `setImmediate`, which keeps the context) for a GET. A
 * `runInLane(ctx, () => promise).then(next)` would NOT: `next` would run outside.
 * One known gap, accepted because every `/api` and `/v1` route is a GET: a request
 * WITH a body is parsed by body-parser from stream events, which fire in the
 * socket's context rather than ours, so such a route would fall back to `sweep`.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export type IndexerLane = 'interactive' | 'live' | 'health' | 'refresh' | 'sweep';

/** Strict priority order, highest first. The gateway serves lanes in this order. */
export const INDEXER_LANES: readonly IndexerLane[] = ['interactive', 'live', 'health', 'refresh', 'sweep'];

/**
 * Per-request accumulator, set only on an interactive HTTP context, read by the
 * `Server-Timing` header and the slow-request log. Mutable on purpose: every
 * indexer call the request makes adds to the same object.
 */
export interface IndexerRequestStats {
  indexerMs: number;
  indexerCalls: number;
  /** Time spent waiting for the gateway to dispatch (enforce mode only). */
  queuedMs: number;
  /**
   * Wall time spent waiting on a single-flight load ANOTHER request started
   * (`chart-inputs.service.ts`), and how many loads it joined. That time is not
   * indexer time — the starter's request carries the calls — so without it a
   * request that sat behind somebody else's walk logged `indexer=0ms calls=0`
   * and looked like it had been slow for no reason at all. Optional so a
   * context built elsewhere without them still reads as "none".
   */
  joinedMs?: number;
  joins?: number;
  /**
   * The request is a keyless `/api` read (set by `ApiLimitService`), as opposed
   * to a keyed `/v1` one. The Mongo read budget reads it to bound the share of
   * itself that keyless reads may take (`API_READ_SHARE`).
   */
  keyless?: boolean;
}

export interface IndexerContext {
  readonly lane: IndexerLane;
  /** Route template for HTTP, BullMQ job name for workers. Bounded cardinality. */
  readonly job?: string;
  readonly chainId?: number;
  /** Aborted when the HTTP client hangs up; queued and in-flight calls are dropped. */
  readonly signal?: AbortSignal;
  /** Epoch ms after which an interactive request is no longer worth answering. */
  readonly deadlineAt?: number;
  readonly stats?: IndexerRequestStats;
}

const storage = new AsyncLocalStorage<IndexerContext>();

const UNTAGGED: IndexerContext = Object.freeze({ lane: 'sweep', job: 'untagged' });

export function runInLane<T>(ctx: IndexerContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** The caller's context, or the lowest-priority `sweep` lane when nothing tagged it. */
export function currentIndexerContext(): IndexerContext {
  return storage.getStore() ?? UNTAGGED;
}

/**
 * BullMQ job name → lane. `backfill`/`refresh` re-read positions on a schedule
 * someone is waiting on; `live-refresh` follows a user's on-chain action; every
 * other job (pool-sync, token-security-sync, token-price-sync,
 * position-fee-refresh, anything added later) is a sweep.
 */
export function laneForJob(name: string): IndexerLane {
  switch (name) {
    case 'backfill':
    case 'refresh':
      return 'refresh';
    case 'live-refresh':
      return 'live';
    default:
      return 'sweep';
  }
}

const INTERACTIVE_PATH = /^\/(api|v1)(\/|\?|$)/;

export function isInteractivePath(url: string): boolean {
  return INTERACTIVE_PATH.test(url);
}

/**
 * The route WITHOUT its ids, so the meter's per-job table stays a handful of rows
 * instead of one per position. Numbers (chain ids, token ids), hex (pool ids,
 * addresses) and anything long or unusual collapse to `:id`; short words such as
 * the protocol and `charts` are kept, because they ARE the route.
 */
export function routeJobName(url: string): string {
  const queryAt = url.indexOf('?');
  const path = queryAt === -1 ? url : url.slice(0, queryAt);
  const segments = path.split('/').filter((s) => s.length > 0);
  return (
    '/' +
    segments
      .map((s) => (/^\d+$/.test(s) || /^0x[0-9a-f]*$/i.test(s) || s.length > 32 || !/^[A-Za-z0-9_-]+$/.test(s) ? ':id' : s))
      .join('/')
  );
}

/** The reason a client-close abort carries, so logs say WHY a call was dropped. */
export class ClientClosedError extends Error {
  constructor() {
    super('client closed the request');
    this.name = 'AbortError';
  }
}

interface HttpRequestLike {
  url: string;
  originalUrl?: string;
}
interface HttpResponseLike {
  writableFinished: boolean;
  on(event: 'close', listener: () => void): void;
}

/**
 * The interactive context for one `/api` or `/v1` request, or `undefined` for any
 * other route (portal, admin, billing, webhooks), which stay untagged.
 *
 * The AbortController fires only on a REAL hang-up: `close` also follows a normal
 * `finish`, and `writableFinished` is what tells the two apart (the same test the
 * access log and `trackRequestUsage` use).
 */
export function interactiveContextFor(
  req: HttpRequestLike,
  res: HttpResponseLike,
  deadlineMs: number,
  now: number = Date.now(),
): IndexerContext | undefined {
  const url = req.originalUrl ?? req.url;
  if (!isInteractivePath(url)) return undefined;
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort(new ClientClosedError());
  });
  return {
    lane: 'interactive',
    job: routeJobName(url),
    signal: controller.signal,
    deadlineAt: now + Math.max(1, deadlineMs),
    stats: { indexerMs: 0, indexerCalls: 0, queuedMs: 0, joinedMs: 0, joins: 0 },
  };
}

/**
 * Adds one request's wait on loads it joined (`IndexerRequestStats.joinedMs`).
 * A no-op outside an interactive HTTP context, which has no stats.
 */
export function recordJoinWait(ctx: IndexerContext, waitedMs: number, joins: number): void {
  const stats = ctx.stats;
  if (!stats || joins <= 0) return;
  stats.joinedMs = (stats.joinedMs ?? 0) + Math.max(0, waitedMs);
  stats.joins = (stats.joins ?? 0) + joins;
}

/**
 * `Server-Timing` value for an interactive response: total, indexer time, queue
 * wait, and time spent waiting on a load another request started.
 */
export function serverTimingValue(ctx: IndexerContext, startedAt: number, now: number = Date.now()): string {
  const parts = [`total;dur=${Math.max(0, now - startedAt)}`];
  const stats = ctx.stats;
  if (stats) {
    parts.push(`indexer;dur=${Math.round(stats.indexerMs)};desc="${stats.indexerCalls} calls"`);
    if (stats.queuedMs > 0) parts.push(`indexer-queue;dur=${Math.round(stats.queuedMs)}`);
    const joins = stats.joins ?? 0;
    if (joins > 0) parts.push(`indexer-join;dur=${Math.round(stats.joinedMs ?? 0)};desc="${joins} joined"`);
  }
  return parts.join(', ');
}

interface WritableHeadersLike {
  headersSent: boolean;
  setHeader(name: string, value: string): unknown;
  writeHead(...args: unknown[]): unknown;
}

/**
 * Sets `Server-Timing` at the last moment headers can still change. Express has
 * no "before headers" hook, so this wraps `writeHead`, which Node calls for every
 * response — explicitly, or implicitly from the first `write`/`end` — which is
 * also how the `compression` middleware does it.
 */
export function installServerTiming(res: WritableHeadersLike, ctx: IndexerContext, startedAt: number): void {
  const writeHead = res.writeHead;
  res.writeHead = function (this: unknown, ...args: unknown[]) {
    if (!res.headersSent) {
      try {
        res.setHeader('Server-Timing', serverTimingValue(ctx, startedAt));
      } catch {
        // Headers already on the wire; the header is advisory, never fatal.
      }
    }
    return writeHead.apply(this, args);
  };
}

/**
 * One-line indexer summary for the access log:
 * `indexer=812ms calls=3 [queued=40ms] [joined=1500ms/1]` — the last is the
 * wait on loads another request started, kept apart from this request's own
 * indexer time.
 */
export function indexerSummary(ctx: IndexerContext): string {
  const s = ctx.stats;
  if (!s) return '';
  const queued = s.queuedMs > 0 ? ` queued=${Math.round(s.queuedMs)}ms` : '';
  const joins = s.joins ?? 0;
  const joined = joins > 0 ? ` joined=${Math.round(s.joinedMs ?? 0)}ms/${joins}` : '';
  return `indexer=${Math.round(s.indexerMs)}ms calls=${s.indexerCalls}${queued}${joined}`;
}

/**
 * `AbortSignal.any`, with a fallback for runtimes that lack it (it landed in Node
 * 20.3; `engines` says >=20.0). The fallback leaks a listener per source until
 * that source is collected, which is fine for the per-request signals used here.
 */
export function anySignal(signals: ReadonlyArray<AbortSignal | undefined>): AbortSignal | undefined {
  const list = signals.filter((s): s is AbortSignal => s !== undefined);
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  const native = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (typeof native === 'function') return native.call(AbortSignal, list);
  const controller = new AbortController();
  for (const s of list) {
    if (s.aborted) {
      controller.abort(s.reason);
      return controller.signal;
    }
    s.addEventListener('abort', () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}
