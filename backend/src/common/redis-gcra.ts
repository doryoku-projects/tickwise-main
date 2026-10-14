import type { Redis } from 'ioredis';
import { CoordinationRedis, type CoordinationRedisSource } from './coordination-redis.js';

/**
 * P2.2 — ONE generic token-bucket primitive for every fleet-wide rate in
 * Redis (design §3.3–§3.4): the shared Envio budget (`tw:ix:v1:*`), the
 * Dwellir RPC budget (`tw:rpc:v1:acct:*`) and GeckoTerminal (`tw:gt:v1:*`).
 *
 * The algorithm is `read-budget.ts`'s GCRA-style bucket, generalised to N
 * buckets taken ATOMICALLY in one Lua call (all or nothing — the indexer's
 * `all` + `bg` pair must never take one without the other), with an optional
 * pause key read before anything is taken and an optional counter (`INCRBY`,
 * the RPC month total) bumped only when the take succeeds.
 *
 *  - Refill by elapsed time on Redis's OWN clock (`TIME`), so processes with
 *    skewed clocks share one timeline.
 *  - `wait` = the longest any bucket must refill before `cost` is covered.
 *  - `maxWait ≥ 0` and `wait > maxWait` → nothing is taken (each bucket's
 *    refill is still recorded) and the answer is `refused` with `-wait`.
 *  - Otherwise every bucket is debited — possibly below zero, which is what
 *    queues the next caller behind this one — and the caller sleeps `wait`.
 *  - A live pause key answers `paused` with its remaining PTTL and takes
 *    nothing.
 *
 * `LocalGcra` is the same step in process: the Redis-down fallback of every
 * caller (each scales the rate by its own local share) and the reference
 * model the opt-in contract spec checks the Lua against.
 *
 * Keys here are NOT namespaced by deployment on purpose: each budget belongs
 * to an external account or deployment (an indexer URL, a Dwellir account,
 * GeckoTerminal's per-IP limit), and two environments on one Redis that point
 * at the same one MUST share it.
 */

export interface GcraBucket {
  key: string;
  /** Refill rate, tokens per second (> 0). */
  perSec: number;
  /** Capacity (≥ 1). */
  burst: number;
  /** Tokens this take costs from this bucket (> 0). */
  cost: number;
}

export interface GcraRequest {
  buckets: readonly GcraBucket[];
  /** Longest acceptable wait, ms; a wait past it takes nothing. `< 0` = no check (always take). */
  maxWaitMs: number;
  /** A key whose presence refuses the take (`paused`) for its remaining PTTL. */
  pauseKey?: string;
  /** `INCRBY key by` + `EXPIRE key ttlSec`, only when the take succeeds. Integer `by` > 0. */
  counter?: { key: string; by: number; ttlSec: number };
  /** State TTL of every bucket (an idle bucket forgets its debt). Default 60 s. */
  ttlMs?: number;
}

export type GcraStatus = 'taken' | 'refused' | 'paused';

export interface GcraResult {
  status: GcraStatus;
  /** `taken`: ms to sleep before acting (≥ 0). `refused`/`paused`: ms until it could (> 0). */
  waitMs: number;
  /** The counter after the increment (`taken` with a counter only). */
  counter?: number;
}

export const GCRA_DEFAULT_TTL_MS = 60_000;

/**
 * KEYS: bucket keys (n), then the pause key (if ARGV[4] == '1'), then the
 * counter key (if ARGV[5] > 0).
 * ARGV: 1 n, 2 maxWait (ms, < 0 = no check), 3 ttl (ms), 4 hasPause (0/1),
 * 5 counterBy (0 = none), 6 counterTtl (s), then per bucket i (1-based):
 * 6+3i-2 rate (tokens/ms), 6+3i-1 burst, 6+3i cost.
 * Returns {wait, code, counter}: code 1 taken (wait ≥ 0), 0 refused (−wait),
 * 2 paused (−pttl).
 */
export const GCRA_SCRIPT = `
local n = tonumber(ARGV[1])
local maxWait = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local hasPause = ARGV[4] == '1'
local counterBy = tonumber(ARGV[5])
local counterTtl = tonumber(ARGV[6])
if hasPause then
  local p = redis.call('PTTL', KEYS[n + 1])
  if p > 0 then return {-p, 2, 0} end
end
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local tokens = {}
local costs = {}
local wait = 0
for i = 1, n do
  local base = 6 + 3 * (i - 1)
  local rate = tonumber(ARGV[base + 1])
  local burst = tonumber(ARGV[base + 2])
  local cost = tonumber(ARGV[base + 3])
  local st = redis.call('HMGET', KEYS[i], 'tokens', 'ts')
  local tk = tonumber(st[1])
  local ts = tonumber(st[2])
  if tk == nil then tk = burst end
  if ts == nil then ts = now end
  tk = math.min(burst, tk + math.max(0, now - ts) * rate)
  tokens[i] = tk
  costs[i] = cost
  if tk < cost then
    local w = math.ceil((cost - tk) / rate)
    if w > wait then wait = w end
  end
end
local refused = maxWait >= 0 and wait > maxWait
for i = 1, n do
  local tk = tokens[i]
  if not refused then tk = tk - costs[i] end
  redis.call('HSET', KEYS[i], 'tokens', tostring(tk), 'ts', tostring(now))
  redis.call('PEXPIRE', KEYS[i], ttl)
end
if refused then return {-wait, 0, 0} end
local c = 0
if counterBy > 0 then
  local ck = KEYS[n + 1]
  if hasPause then ck = KEYS[n + 2] end
  c = redis.call('INCRBY', ck, counterBy)
  redis.call('EXPIRE', ck, counterTtl)
end
return {wait, 1, c}
`;

/** Set the pause key to `ms` unless a LONGER pause is already in place. Returns 1 when set. */
export const GCRA_PAUSE_SCRIPT = `
local cur = redis.call('PTTL', KEYS[1])
if cur < tonumber(ARGV[1]) then
  redis.call('SET', KEYS[1], '1', 'PX', ARGV[1])
  return 1
end
return 0
`;

function validBucket(b: GcraBucket): GcraBucket {
  return {
    key: b.key,
    perSec: Number.isFinite(b.perSec) && b.perSec > 0 ? b.perSec : 1e-9,
    burst: Number.isFinite(b.burst) && b.burst >= 1 ? b.burst : 1,
    cost: Number.isFinite(b.cost) && b.cost > 0 ? b.cost : 1,
  };
}

/** The Lua call's KEYS + ARGV for `req` (exported for the contract spec). */
export function gcraArgs(req: GcraRequest): { keys: string[]; argv: string[] } {
  const buckets = req.buckets.map(validBucket);
  const keys = buckets.map((b) => b.key);
  if (req.pauseKey) keys.push(req.pauseKey);
  const by = req.counter && req.counter.by > 0 ? Math.ceil(req.counter.by) : 0;
  if (by > 0) keys.push(req.counter!.key);
  const argv = [
    String(buckets.length),
    String(Number.isFinite(req.maxWaitMs) ? Math.floor(req.maxWaitMs) : -1),
    String(Math.max(1, Math.floor(req.ttlMs ?? GCRA_DEFAULT_TTL_MS))),
    req.pauseKey ? '1' : '0',
    String(by),
    String(by > 0 ? Math.max(1, Math.floor(req.counter!.ttlSec)) : 0),
  ];
  for (const b of buckets) argv.push(String(b.perSec / 1000), String(b.burst), String(b.cost));
  return { keys, argv };
}

/** Decode the Lua reply `{wait, code, counter}`. */
export function decodeGcraReply(reply: unknown): GcraResult {
  const [w, code, c] = Array.isArray(reply) ? reply.map(Number) : [Number.NaN, Number.NaN, 0];
  if (code === 2) return { status: 'paused', waitMs: Math.abs(w) };
  if (code === 0) return { status: 'refused', waitMs: Math.abs(w) };
  if (code === 1) return { status: 'taken', waitMs: Math.max(0, w), counter: c > 0 ? c : undefined };
  throw new Error(`gcra: unexpected reply ${JSON.stringify(reply)}`);
}

/** `() => client | undefined` — undefined while Redis is off, connecting or unreachable. */
export type RedisClientSource = () => Promise<Redis | undefined>;

/**
 * The Redis side. `take`/`pause` answer `undefined` when Redis is unavailable
 * (no client, or the command failed): the CALLER picks its fallback — every
 * P2.2 caller fails OPEN to a per-process `LocalGcra` at a share of the rate
 * (design §3.6).
 */
export class RedisGcra {
  constructor(
    private readonly client: RedisClientSource,
    private readonly onError?: (err: unknown) => void,
  ) {}

  async take(req: GcraRequest): Promise<GcraResult | undefined> {
    const redis = await this.client().catch(() => undefined);
    if (!redis) return undefined;
    try {
      const { keys, argv } = gcraArgs(req);
      return decodeGcraReply(await redis.eval(GCRA_SCRIPT, keys.length, ...keys, ...argv));
    } catch (err) {
      this.onError?.(err);
      return undefined;
    }
  }

  /** Pause `key` for `ms` (kept if a longer pause is already set). False when Redis is unavailable. */
  async pause(key: string, ms: number): Promise<boolean> {
    const redis = await this.client().catch(() => undefined);
    if (!redis) return false;
    try {
      await redis.eval(GCRA_PAUSE_SCRIPT, 1, key, String(Math.max(1, Math.ceil(ms))));
      return true;
    } catch (err) {
      this.onError?.(err);
      return false;
    }
  }
}

/**
 * The same step in process: the Redis-down fallback and the reference model of
 * `GCRA_SCRIPT` (line for line). Counters are kept here too, per process.
 */
export class LocalGcra {
  private readonly buckets = new Map<string, { tokens: number; ts: number }>();
  private readonly pauses = new Map<string, number>();
  private readonly counters = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  take(req: GcraRequest): GcraResult {
    const now = this.now();
    if (req.pauseKey) {
      const until = this.pauses.get(req.pauseKey) ?? 0;
      if (until > now) return { status: 'paused', waitMs: until - now };
    }
    const buckets = req.buckets.map(validBucket);
    const maxWait = Number.isFinite(req.maxWaitMs) ? Math.floor(req.maxWaitMs) : -1;
    const tokens: number[] = [];
    let wait = 0;
    for (const b of buckets) {
      const rate = b.perSec / 1000;
      const st = this.buckets.get(b.key);
      let tk = st?.tokens ?? b.burst;
      const ts = st?.ts ?? now;
      tk = Math.min(b.burst, tk + Math.max(0, now - ts) * rate);
      tokens.push(tk);
      if (tk < b.cost) wait = Math.max(wait, Math.ceil((b.cost - tk) / rate));
    }
    const refused = maxWait >= 0 && wait > maxWait;
    buckets.forEach((b, i) => {
      this.buckets.set(b.key, { tokens: refused ? tokens[i] : tokens[i] - b.cost, ts: now });
    });
    if (refused) return { status: 'refused', waitMs: wait };
    let counter: number | undefined;
    if (req.counter && req.counter.by > 0) {
      counter = (this.counters.get(req.counter.key) ?? 0) + Math.ceil(req.counter.by);
      this.counters.set(req.counter.key, counter);
    }
    return { status: 'taken', waitMs: wait, counter };
  }

  pause(key: string, ms: number): void {
    const until = this.now() + Math.max(1, Math.ceil(ms));
    if ((this.pauses.get(key) ?? 0) < until) this.pauses.set(key, until);
  }

  /** Specs: the stored state of a bucket. */
  peek(key: string): { tokens: number; ts: number } | undefined {
    return this.buckets.get(key);
  }
}

/**
 * Adapter for package E's `GECKOTERMINAL_GCRA` (`GtBucketBackend`): take ONE
 * token from `key` at `perMinute`, waiting at most `maxWaitMs`. Answers the
 * wait (≥ 0, taken) or its negation (< 0, refused, nothing taken); THROWS when
 * Redis is unavailable so the provider's own local fallback applies.
 */
export function geckoTerminalGcraBackend(gcra: RedisGcra): {
  take(key: string, perMinute: number, burst: number, maxWaitMs: number): Promise<number>;
} {
  return {
    async take(key, perMinute, burst, maxWaitMs) {
      const res = await gcra.take({
        buckets: [{ key, perSec: Math.max(1e-6, perMinute / 60), burst: Math.max(1, burst), cost: 1 }],
        maxWaitMs: Math.max(0, maxWaitMs),
        ttlMs: 5 * 60_000,
      });
      if (!res) throw new Error('geckoterminal gcra: Redis unavailable');
      if (res.status === 'taken') return res.waitMs;
      return -Math.max(1, res.waitMs);
    },
  };
}

// ─── the redis-state source shared by B's services ───────────────────────────

/** What B's services need from redis-state: package A's `CoordinationRedis` satisfies it. */
export interface SharedStateRedisSource extends CoordinationRedisSource {
  /** A NEW connection for SUBSCRIBE (the invalidation bus). */
  subscriber?(name: string): Redis;
}

const fallbackSources = new Map<string, CoordinationRedis>();

/**
 * The source to use when DI did not bind `CoordinationRedis` (specs, or a
 * module that has not been wired yet): ONE lazily connected
 * `CoordinationRedis` per Redis URL for the whole process, so the limiters,
 * the bus and the RPC budget share a connection. Nothing connects until a
 * caller asks for `client()` — i.e. until a P2.2 flag is on.
 */
export function sharedStateRedis(
  bound: SharedStateRedisSource | undefined,
  config: unknown,
): SharedStateRedisSource {
  if (bound) return bound;
  const url = (config as { redisUrl?: string } | undefined)?.redisUrl ?? 'redis://localhost:6379';
  let source = fallbackSources.get(url);
  if (!source) {
    source = new CoordinationRedis(config as never);
    fallbackSources.set(url, source);
  }
  return source;
}

/** Specs: close and forget the fallback sources. */
export async function __resetSharedStateRedisFallbacks(): Promise<void> {
  const all = [...fallbackSources.values()];
  fallbackSources.clear();
  await Promise.all(all.map((s) => s.close().catch(() => undefined)));
}

/** At most one line per `key` per minute (shared by B's alerts). */
const alertAt = new Map<string, number>();
export function onceAMinute(key: string, now: number = Date.now()): boolean {
  const last = alertAt.get(key) ?? Number.NEGATIVE_INFINITY;
  if (now - last < 60_000) return false;
  alertAt.set(key, now);
  return true;
}

/** Specs: forget alert pacing. */
export function __resetAlertPacing(): void {
  alertAt.clear();
}
