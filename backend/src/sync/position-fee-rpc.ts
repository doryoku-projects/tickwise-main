/*
 * Pure classification of one fee Multicall3 batch's outcome
 * (PositionFeeRefreshService.measure). No I/O, pinned by
 * test/position-fee-refresh.spec.ts.
 *
 * WHY THIS EXISTS: with `allowFailure: true`, viem's `multicall` NEVER throws
 * on an RPC or transport failure. A chunk whose `eth_call` was rejected is
 * reported as one `{status: 'failure', error}` entry PER CALL, every entry
 * carrying the same rejection (viem `actions/public/multicall.js`, the
 * `result.status === 'rejected'` branch). So a dead node, a 429 or a timeout
 * looked exactly like 400 contract reverts: the job's catch-and-retry never
 * ran, every row was counted failed, and the tier cursor advanced past rows
 * that were never read — they then waited a whole interval, silently.
 *
 * Three outcomes are told apart here:
 *   - WHOLE-REQUEST failure: every entry failed with the SAME error (one
 *     object, or one message). The RPC failed, not N contracts. Retried once;
 *     still failing → the batch is UNANSWERED (not measured, not failed).
 *   - GAS TAIL: a contiguous run of failures after the last success. Calls are
 *     interleaved per position, so an EVM gas cutoff can only fail a tail;
 *     only that tail is retried, in halves, at the same pinned block.
 *   - SCATTERED failures (a failure before the last success): real reverts,
 *     counted failed.
 */

export interface CallResult {
  status: 'success' | 'failure';
  result?: unknown;
  error?: unknown;
}

/** What a whole-request failure is, for deciding whether splitting can help. */
export type RpcFailureKind = 'transport' | 'gas' | 'other';

/** Deepest single-tail split (each level halves the tail it was handed). */
export const SPLIT_MAX_DEPTH = 3;
/** A tail shorter than twice this is retried as one piece rather than halved. */
export const SPLIT_MIN_POSITIONS = 25;

/**
 * The shared error when EVERY entry failed with one error object or one full
 * message, else undefined. A per-call revert's message carries that call's
 * function name and arguments, so N genuine reverts never share one.
 */
export function wholeRequestFailure(results: ReadonlyArray<CallResult>): unknown {
  if (results.length === 0) return undefined;
  const first = results[0]!;
  if (first.status !== 'failure') return undefined;
  const firstMessage = messageOf(first.error);
  for (const r of results) {
    if (r.status !== 'failure') return undefined;
    if (r.error === first.error) continue;
    if (firstMessage === undefined || messageOf(r.error) !== firstMessage) return undefined;
  }
  return first.error ?? new Error('multicall failed with no error');
}

const TRANSPORT_ERROR_NAMES = new Set([
  'HttpRequestError',
  'TimeoutError',
  'LimitExceededRpcError',
  'WebSocketRequestError',
  'SocketClosedError',
  'ResourceUnavailableRpcError',
  'AbortError',
]);
// Status codes only in an explicit "status 5xx"/"HTTP 5xx" form: a bare
// three-digit match would hit block numbers and calldata in the request body
// viem quotes in the message.
const TRANSPORT_MESSAGE =
  /rate.?limit|too many requests|(status|http)( code)?:? ?(429|5\d\d)\b|timed? ?out|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|network error|service unavailable|bad gateway/i;
const GAS_MESSAGE =
  /out of gas|gas required exceeds|exceeds (the )?(block )?gas limit|gas limit (reached|exceeded)|intrinsic gas too low|gas cap/i;

/**
 * Transport, rate limit, timeout and 5xx failures are `transport` and are never
 * split (a smaller request to a node that is down or throttling is just more
 * load); a gas-cap error on the whole request is `gas` (splitting is the fix);
 * anything else is `other`, handled like `transport`.
 */
export function classifyRpcError(err: unknown): RpcFailureKind {
  const chain = causeChain(err);
  for (const e of chain) {
    const rec = e as { name?: unknown; status?: unknown; code?: unknown };
    if (typeof rec.name === 'string' && TRANSPORT_ERROR_NAMES.has(rec.name)) return 'transport';
    const status = Number(rec.status);
    if (status === 429 || (status >= 500 && status < 600)) return 'transport';
    if (rec.code === -32005 || rec.code === 429) return 'transport';
  }
  const text = chain.map((e) => messageOf(e) ?? '').join(' | ');
  if (TRANSPORT_MESSAGE.test(text)) return 'transport';
  if (GAS_MESSAGE.test(text)) return 'gas';
  return 'other';
}

/** A short, single-line description for a log line. */
export function rpcErrorSummary(err: unknown): string {
  const rec = err as { shortMessage?: unknown; message?: unknown } | undefined;
  const raw =
    (typeof rec?.shortMessage === 'string' && rec.shortMessage) ||
    (typeof rec?.message === 'string' && rec.message) ||
    String(err);
  const line = raw.replace(/\s+/g, ' ').trim();
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

/**
 * Index of the first position of the failing tail — the run of failed
 * positions after the last answered one — or -1 when the last position was
 * answered. `ok[i]` is whether position i's two calls both succeeded.
 */
export function failingTailStart(ok: ReadonlyArray<boolean>): number {
  let last = -1;
  for (let i = 0; i < ok.length; i++) if (ok[i]) last = i;
  return last + 1 < ok.length ? last + 1 : -1;
}

/** The pieces a failing tail is retried in: halves when it is long enough, else whole. */
export function splitTail<T>(tail: T[]): T[][] {
  if (tail.length < 2 * SPLIT_MIN_POSITIONS) return [tail];
  const mid = Math.ceil(tail.length / 2);
  return [tail.slice(0, mid), tail.slice(mid)];
}

function messageOf(err: unknown): string | undefined {
  if (err === undefined || err === null) return undefined;
  const m = (err as { message?: unknown }).message;
  return typeof m === 'string' ? m : String(err);
}

function causeChain(err: unknown): unknown[] {
  const out: unknown[] = [];
  let e: unknown = err;
  for (let i = 0; i < 10 && e !== undefined && e !== null; i++) {
    out.push(e);
    e = (e as { cause?: unknown }).cause;
  }
  return out;
}

// ─── P3.2: per-chain sizing (pure; pinned by test/fee-p3/sizing.spec.ts) ─────

/** Zod-equivalent ceiling for a per-chain concurrency (`POSITION_FEE_CONCURRENCY_BY_CHAIN`). */
export const FEE_CONCURRENCY_MAX = 64;
/** Largest batch a chain may ask for: 500 × ~29k gas ≈ 14.5M < EIP-7825's 16.78M per call. */
export const FEE_BATCH_MAX = 500;
/** The per-chain allotment never drops below this many positions per 60 s tick (design §8). */
export const FEE_CHAIN_BUDGET_FLOOR = 2_000;
/** Head-room factor on the rate a chain needs to finish its pass inside the target. */
export const FEE_CHAIN_BUDGET_HEADROOM = 1.25;
/** Over-provisioning factor in the slot sizing rule. */
export const FEE_SLOT_HEADROOM = 1.5;

/**
 * `"1:400,4663:32"` (or a `Map`, as a config getter may already hand it over)
 * → chainId → positive integer, each value clamped to `[1, max]`. Garbage
 * entries are skipped, never fatal: a typo must not take the fee job down,
 * and an absent entry means the chain uses the global value — today's.
 */
export function parseChainMap(raw: unknown, max: number): Map<number, number> {
  const out = new Map<number, number>();
  const put = (k: unknown, v: unknown) => {
    const chain = Number(k);
    const n = Math.floor(Number(v));
    if (!Number.isInteger(chain) || chain <= 0 || !Number.isFinite(n) || n <= 0) return;
    out.set(chain, Math.min(max, n));
  };
  if (raw instanceof Map) {
    for (const [k, v] of raw) put(k, v);
    return out;
  }
  if (typeof raw !== 'string') return out;
  for (const part of raw.split(',')) {
    const [k, v, extra] = part.split(':').map((s) => s.trim());
    if (extra !== undefined || !k || !v) continue;
    put(k, v);
  }
  return out;
}

/**
 * The design's slot sizing rule (§8): `⌈rate × L / batch × 1.5⌉` concurrent
 * multicalls keep `rate` positions/s flowing when one batch of `batch` takes
 * `L` ms. Reported next to the configured slots (a suggestion — the configured
 * value is what runs); 0 while `L` is unknown.
 */
export function suggestedSlots(ratePerSec: number, latencyMs: number, batch: number): number {
  if (!(ratePerSec > 0) || !(latencyMs > 0) || !(batch > 0)) return 0;
  return Math.ceil(((ratePerSec * latencyMs) / 1000 / batch) * FEE_SLOT_HEADROOM);
}

/**
 * `POSITION_FEE_BUDGET=per-chain`: what ONE chain may measure in one 60 s tick
 * — enough to finish a pass over its `active` positions inside `passTargetMs`
 * with 25 % head-room, never below `FEE_CHAIN_BUDGET_FLOOR`, and never above
 * what its RPC slots can actually push through in a minute
 * (`slots × batch × 60 s / latency`; unknown latency = no capacity bound yet).
 * The capacity bound wins over the floor: asking for more than the RPC can
 * answer only stretches the tick.
 */
export function perChainAllotment(input: {
  active: number;
  passTargetMs: number;
  slots: number;
  batch: number;
  latencyMs?: number;
  tickMs?: number;
}): number {
  const tickMs = input.tickMs ?? 60_000;
  const active = Math.max(0, Math.floor(input.active));
  const target = input.passTargetMs > 0 ? input.passTargetMs : 480_000;
  const want = Math.ceil((FEE_CHAIN_BUDGET_HEADROOM * active * tickMs) / target);
  let n = Math.max(FEE_CHAIN_BUDGET_FLOOR, want);
  const latency = input.latencyMs ?? 0;
  if (latency > 0 && input.slots > 0 && input.batch > 0) {
    const capacity = Math.floor((input.slots * input.batch * tickMs) / latency);
    n = Math.min(n, Math.max(1, capacity));
  }
  return n;
}
