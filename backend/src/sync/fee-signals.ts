/*
 * The fee job's signal queues (design §9.4): detail-view re-reads
 * (`markViewed`) and changed positions (`markDirty`, a LIVE lane and a
 * BACKFILL lane), and the drains that take them.
 *
 * Two transports with ONE set of rules (C3, `PositionFeeRefreshService`):
 *   - `MemoryFeeSignals` — in-process, synchronous; exactly today's queues.
 *     The default (`FEE_SIGNALS_TRANSPORT=auto` with leases off).
 *   - `RedisFeeSignals` — the same rules as Lua on redis-state, so producers in
 *     one process (api: views; sync: live + backfill marks) feed the fee worker
 *     in another, and a `fee-worker` lease that moves loses nothing. Used
 *     whenever leases are on, in EVERY role (`auto`), or when forced (`redis`).
 *     A Redis failure falls back to a local in-process queue (same caps; the
 *     store's reconcile repairs anything dropped) and is counted.
 *
 * The rules both enforce:
 *   - markViewed: a cooldown (5 min) starts only when the id is QUEUED; an id
 *     already queued, or cooling, is a no-op; a full queue queues nothing and
 *     sets NO cooldown, so the next open can queue it. A requeued view that no
 *     longer fits loses its cooldown (DEL vcool).
 *   - markDirty: re-marking keeps the LATER block (∞ = always re-read wins);
 *     a live mark moves an id out of the backfill lane carrying
 *     max(block, backfillBlock); a backfill mark of an id the live lane holds
 *     updates the live entry; a full live lane leaves a backfill-held id in the
 *     backfill lane (updated if later), else drops it (counted); a full
 *     backfill lane drops new ids (counted). Drains are FIFO by first arrival.
 */

/** A dirty entry whose change block is unknown: never skipped as already fresh. */
export const FORCE_REREAD = Number.POSITIVE_INFINITY;
/** Live dirty-set bound per chain; past it, changes are left to the tier passes. */
export const DIRTY_MAX_PER_CHAIN = 50_000;
/** Backfill-lane bound per chain; past it, backfilled positions are left to the tier passes. */
export const BACKFILL_MAX_PER_CHAIN = 100_000;
/** A position opened in the detail view is re-queued at most once per this. */
export const VIEW_COOLDOWN_MS = 5 * 60_000;
/** Bound on the cooldown map (process-wide, memory transport); the oldest entries are evicted. */
export const VIEW_COOLDOWN_MAX = 20_000;
/** Bound on one chain's view queue. */
export const VIEW_QUEUE_MAX_PER_CHAIN = 2_000;
/** Redis signal keys idle this long expire (a chain that stopped producing frees its queues). */
export const SIGNAL_KEY_TTL_MS = 24 * 3_600_000;

/** Which side lane a `markDirty` feeds: the live set (default) or the backfill queue. */
export type DirtyLane = 'live' | 'backfill';
export const DIRTY_LANES: readonly DirtyLane[] = ['live', 'backfill'];

/** What a `markViewed` did. */
export type ViewMark = 'queued' | 'cooling' | 'already' | 'full';

type MaybePromise<T> = T | Promise<T>;

/** One transport. `key` = `${chainId}:${protocol}`; blocks are numbers, ∞ = force re-read. */
export interface FeeSignals {
  readonly kind: 'memory' | 'redis';
  markViewed(key: string, id: string, now: number): MaybePromise<ViewMark>;
  requeueViews(key: string, ids: Iterable<string>): MaybePromise<void>;
  takeViews(key: string, max: number): MaybePromise<string[]>;
  /** Returns how many ids were dropped because a lane was full. */
  markDirty(key: string, lane: DirtyLane, entries: ReadonlyArray<readonly [string, number]>): MaybePromise<number>;
  /** Up to `max` ids of one lane, FIFO, removed from the queue, with their blocks. */
  takeDirty(key: string, lane: DirtyLane, max: number): MaybePromise<Map<string, number>>;
  sizes(key: string): MaybePromise<{ views: number; live: number; backfill: number }>;
}

// ─── memory transport (today's queues, verbatim) ─────────────────────────────

export class MemoryFeeSignals implements FeeSignals {
  readonly kind = 'memory' as const;
  /** Live dirty set per (chain, protocol): positionId → the block of the change that queued it. */
  private readonly dirty = new Map<string, Map<string, number>>();
  /** Backfill lane per (chain, protocol), drained after the live set: positionId → its lastModifyBlock. */
  private readonly backfill = new Map<string, Map<string, number>>();
  /** Positions opened in the detail view, per (chain, protocol). */
  private readonly viewed = new Map<string, Set<string>>();
  /** When each `chain:protocol:positionId` was last queued from a view (bounded, oldest evicted). */
  private readonly viewCooldown = new Map<string, number>();

  markViewed(key: string, id: string, now: number): ViewMark {
    const cooldownKey = `${key}:${id}`;
    const last = this.viewCooldown.get(cooldownKey);
    if (last !== undefined && now - last < VIEW_COOLDOWN_MS) return 'cooling';
    const queue = setOf(this.viewed, key);
    // Already waiting: its cooldown was set when it was queued.
    if (queue.has(id)) return 'already';
    if (queue.size >= VIEW_QUEUE_MAX_PER_CHAIN) return 'full';
    queue.add(id);
    // Re-insert so the map stays in last-queued order, then evict the oldest.
    this.viewCooldown.delete(cooldownKey);
    this.viewCooldown.set(cooldownKey, now);
    while (this.viewCooldown.size > VIEW_COOLDOWN_MAX) {
      const oldest = this.viewCooldown.keys().next().value;
      if (oldest === undefined) break;
      this.viewCooldown.delete(oldest);
    }
    return 'queued';
  }

  /** Put viewed positions back; one that no longer fits loses its cooldown, so its next open can queue it. */
  requeueViews(key: string, ids: Iterable<string>): void {
    const queue = setOf(this.viewed, key);
    for (const id of ids) {
      if (queue.has(id)) continue;
      if (queue.size < VIEW_QUEUE_MAX_PER_CHAIN) queue.add(id);
      else this.viewCooldown.delete(`${key}:${id}`);
    }
  }

  takeViews(key: string, max: number): string[] {
    const queue = this.viewed.get(key);
    if (!queue || queue.size === 0 || max <= 0) return [];
    const ids: string[] = [];
    for (const id of queue) {
      ids.push(id);
      if (ids.length >= max) break;
    }
    for (const id of ids) queue.delete(id);
    return ids;
  }

  markDirty(key: string, lane: DirtyLane, entries: ReadonlyArray<readonly [string, number]>): number {
    const live = mapOf(this.dirty, key);
    const bf = mapOf(this.backfill, key);
    let dropped = 0;
    for (const [id, block] of entries) {
      const inLive = live.get(id);
      if (inLive !== undefined) {
        // Already queued at the higher priority: keep the LATER change, so a skip can never be decided on an older one.
        if (block > inLive) live.set(id, block);
        continue;
      }
      const inBackfill = bf.get(id);
      if (lane === 'backfill') {
        if (inBackfill !== undefined) {
          if (block > inBackfill) bf.set(id, block);
          continue;
        }
        if (bf.size >= BACKFILL_MAX_PER_CHAIN) {
          dropped++;
          continue;
        }
        bf.set(id, block);
        continue;
      }
      if (live.size >= DIRTY_MAX_PER_CHAIN) {
        // The live set is full: a position the backfill lane holds stays queued there.
        if (inBackfill !== undefined) {
          if (block > inBackfill) bf.set(id, block);
          continue;
        }
        dropped++;
        continue;
      }
      if (inBackfill !== undefined) bf.delete(id);
      live.set(id, Math.max(block, inBackfill ?? Number.NEGATIVE_INFINITY));
    }
    return dropped;
  }

  takeDirty(key: string, lane: DirtyLane, max: number): Map<string, number> {
    const queue = (lane === 'live' ? this.dirty : this.backfill).get(key);
    const taken = new Map<string, number>();
    if (!queue || max <= 0) return taken;
    for (const [id, block] of queue) {
      taken.set(id, block);
      if (taken.size >= max) break;
    }
    for (const id of taken.keys()) queue.delete(id);
    return taken;
  }

  sizes(key: string): { views: number; live: number; backfill: number } {
    return {
      views: this.viewed.get(key)?.size ?? 0,
      live: this.dirty.get(key)?.size ?? 0,
      backfill: this.backfill.get(key)?.size ?? 0,
    };
  }

  /** Every (chain, protocol) key with anything queued. */
  keys(): string[] {
    const out = new Set<string>();
    for (const m of [this.dirty, this.backfill, this.viewed] as Array<Map<string, { size: number }>>) {
      for (const [k, q] of m) if (q.size > 0) out.add(k);
    }
    return [...out];
  }
}

function setOf(m: Map<string, Set<string>>, key: string): Set<string> {
  let s = m.get(key);
  if (!s) {
    s = new Set();
    m.set(key, s);
  }
  return s;
}

function mapOf(m: Map<string, Map<string, number>>, key: string): Map<string, number> {
  let q = m.get(key);
  if (!q) {
    q = new Map();
    m.set(key, q);
  }
  return q;
}

// ─── Redis transport ─────────────────────────────────────────────────────────

/**
 * The Redis commands the fee package uses (ioredis satisfies it; the integrator
 * hands over its clients cast to this). Kept minimal so specs can fake it.
 */
export interface FeeRedis {
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
  spop(key: string, count: number): Promise<string[]>;
  scard(key: string): Promise<number>;
  zcard(key: string): Promise<number>;
  xadd(key: string, ...args: Array<string | number>): Promise<string | null>;
  xrange(key: string, start: string, end: string, count: 'COUNT', n: number): Promise<Array<[string, string[]]>>;
  xrevrange(key: string, end: string, start: string, count: 'COUNT', n: number): Promise<Array<[string, string[]]>>;
  xread(...args: Array<string | number>): Promise<Array<[string, Array<[string, string[]]>]> | null>;
  incr(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
}

/**
 * This process's view of the `fee-worker` lease (package A's `LeaseRunner`,
 * adapted by the integrator). Absent with leases off = the process is the
 * worker, as today; absent with leases ON = NOT a worker (`[alert]
 * fees.lease_unbound`). Mapped (integrator, `common/fee-coordination.ts`
 * `feeWorkerLeaseView`) EXACTLY as:
 *   held:       () => runner.stillHeld()          // NOT the `held` getter (false in fail-open local mode)
 *   fence:      () => runner.fence                // undefined while held = fail-open local mode
 *   acquiredAt: () => runner.acquiredAt           // the getter: undefined unless holding (local mode → boot ramp)
 */
export interface FeeWorkerLease {
  /** This process may act as the holder right now (`stillHeld()`: held and renewed, or fail-open local). */
  held(): boolean;
  /**
   * The fence of the current holding (monotonic across holders). Undefined
   * while `held()` is true = the runner's fail-open LOCAL mode (role `all`,
   * Redis down): cursor writes are then today's unfenced call.
   */
  fence(): number | undefined;
  /** When the current holding began (ms since epoch); undefined = use the boot time for the ramp. */
  acquiredAt(): number | undefined;
}

/**
 * Everything the fee package needs from P2's coordination layer, in one
 * optional injection (`FEE_COORDINATION`). Absent = leases off, memory
 * transport, direct hint delivery — today.
 */
export interface FeeCoordination {
  /** `leasesEnabled()` of package A (PROCESS_LEASES resolved). */
  leasesEnabled: boolean;
  /** Deployment namespace (`leaderboardSnapshotNamespace`). */
  namespace: string;
  /** redis-state (`REDIS_URL`): signals and the hint loss counters. */
  stateRedis(): Promise<FeeRedis | undefined>;
  /** redis-models (`REDIS_MODELS_URL ?? REDIS_URL`): the row-hint streams. */
  modelsRedis(): Promise<FeeRedis | undefined>;
  /** The `fee-worker` lease; present whenever leases are on. */
  lease?: FeeWorkerLease;
}
export const FEE_COORDINATION = 'FEE_COORDINATION';

/**
 * `tw:fee:v1:<ns>:mode` on redis-state: written (PX) by a fee worker running
 * POSITION_FEE_CANDIDATES=memory with leases on, so WRITERS in other processes
 * publish row hints whatever their own setting says (`FeeRowHintPublisher`).
 */
export function feeModeKey(namespace: string): string {
  return `tw:fee:v1:${namespace}:mode`;
}
/** How long one announcement of the consumer's mode lasts (re-announced every FEE_MODE_ANNOUNCE_MS). */
export const FEE_MODE_TTL_MS = 10 * 60_000;
export const FEE_MODE_ANNOUNCE_MS = 60_000;
/** `SET KEYS[1] ARGV[1] PX ARGV[2]` (FeeRedis has no SET; one EVAL keeps the interface minimal). */
export const SET_MODE_SCRIPT = `redis.call('SET', KEYS[1], ARGV[1], 'PX', tonumber(ARGV[2]))
return 1`;

/** `auto` → `redis` whenever leases are on (every role), else `memory`. */
export function resolveSignalsTransport(setting: 'auto' | 'memory' | 'redis', leasesOn: boolean): 'memory' | 'redis' {
  if (setting === 'auto') return leasesOn ? 'redis' : 'memory';
  return setting;
}

/** `tw:fee:v1:<ns>:sig:<chainId>:<protocol>:…` */
export function feeSignalKeys(namespace: string, key: string) {
  const base = `tw:fee:v1:${namespace}:sig:${key}:`;
  return {
    views: `${base}views`,
    vcoolPrefix: `${base}vcool:`,
    seqLive: `${base}seq:live`,
    blkLive: `${base}blk:live`,
    seqBackfill: `${base}seq:backfill`,
    blkBackfill: `${base}blk:backfill`,
    ctr: `${base}ctr`,
  };
}

/**
 * KEYS: views, vcool:<id>. ARGV: id, cap, cooldownMs, ttlMs.
 * → 1 queued, 0 cooling, 2 already queued, -1 full (NO cooldown set).
 */
export const MARK_VIEWED_SCRIPT = `
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
if redis.call('SISMEMBER', KEYS[1], ARGV[1]) == 1 then return 2 end
if redis.call('SCARD', KEYS[1]) >= tonumber(ARGV[2]) then return -1 end
redis.call('SADD', KEYS[1], ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
return 1
`;

/**
 * KEYS: views. ARGV: cap, vcoolPrefix, ttlMs, ids…
 * An id that no longer fits loses its cooldown (DEL vcool), as in memory.
 * (vcool keys are derived inside the script: single-node redis-state only.)
 */
export const REQUEUE_VIEWS_SCRIPT = `
local cap = tonumber(ARGV[1])
for i = 4, #ARGV do
  local id = ARGV[i]
  if redis.call('SISMEMBER', KEYS[1], id) == 0 then
    if redis.call('SCARD', KEYS[1]) < cap then
      redis.call('SADD', KEYS[1], id)
    else
      redis.call('DEL', ARGV[2] .. id)
    end
  end
end
if redis.call('EXISTS', KEYS[1]) == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[3]) end
return 0
`;

/**
 * KEYS: seq:live, blk:live, seq:backfill, blk:backfill, ctr.
 * ARGV: lane, liveCap, backfillCap, ttlMs, (id, block)…  — block 'inf' = ∞.
 * Two structures per lane: a sequence ZSET (score = arrival INCR, so the drain
 * is FIFO by first arrival like a Map) and a block HASH. → dropped count.
 * The winning block is stored as the ORIGINAL string (no float formatting).
 */
export const MARK_DIRTY_SCRIPT = `
local function num(s)
  if s == 'inf' then return math.huge end
  return tonumber(s)
end
local lane = ARGV[1]
local liveCap = tonumber(ARGV[2])
local bfCap = tonumber(ARGV[3])
local dropped = 0
for i = 5, #ARGV, 2 do
  local id = ARGV[i]
  local b = ARGV[i + 1]
  local inLive = redis.call('HGET', KEYS[2], id)
  if inLive then
    if num(b) > num(inLive) then redis.call('HSET', KEYS[2], id, b) end
  else
    local inBf = redis.call('HGET', KEYS[4], id)
    if lane == 'backfill' then
      if inBf then
        if num(b) > num(inBf) then redis.call('HSET', KEYS[4], id, b) end
      elseif redis.call('ZCARD', KEYS[3]) >= bfCap then
        dropped = dropped + 1
      else
        redis.call('ZADD', KEYS[3], redis.call('INCR', KEYS[5]), id)
        redis.call('HSET', KEYS[4], id, b)
      end
    elseif redis.call('ZCARD', KEYS[1]) >= liveCap then
      if inBf then
        if num(b) > num(inBf) then redis.call('HSET', KEYS[4], id, b) end
      else
        dropped = dropped + 1
      end
    else
      local w = b
      if inBf then
        redis.call('ZREM', KEYS[3], id)
        redis.call('HDEL', KEYS[4], id)
        if num(inBf) > num(b) then w = inBf end
      end
      redis.call('ZADD', KEYS[1], redis.call('INCR', KEYS[5]), id)
      redis.call('HSET', KEYS[2], id, w)
    end
  end
end
for k = 1, 5 do
  if redis.call('EXISTS', KEYS[k]) == 1 then redis.call('PEXPIRE', KEYS[k], ARGV[4]) end
end
return dropped
`;

/** KEYS: seq:<lane>, blk:<lane>. ARGV: max. → flat [id, block, …] in FIFO order. */
export const TAKE_DIRTY_SCRIPT = `
local popped = redis.call('ZPOPMIN', KEYS[1], ARGV[1])
local out = {}
for i = 1, #popped, 2 do
  local id = popped[i]
  local b = redis.call('HGET', KEYS[2], id)
  redis.call('HDEL', KEYS[2], id)
  out[#out + 1] = id
  out[#out + 1] = b or 'inf'
end
return out
`;

export function encodeBlock(block: number): string {
  return Number.isFinite(block) ? String(Math.floor(block)) : 'inf';
}

export function decodeBlock(raw: unknown): number {
  if (raw === 'inf' || raw === null || raw === undefined || raw === false) return FORCE_REREAD;
  const n = Number(raw);
  return Number.isFinite(n) ? n : FORCE_REREAD;
}

/** `[alert] fees.signals_redis` at most once per this. */
export const SIGNALS_ALERT_INTERVAL_MS = 60_000;

export class RedisFeeSignals implements FeeSignals {
  readonly kind = 'redis' as const;
  /**
   * Where marks go while Redis cannot take them (same caps). The fee worker
   * drains it first; in ANY process it is forwarded to redis-state after the
   * next successful mark (`forwardLocal`) — in a split role (api: views; sync:
   * marks) nothing else would ever drain it.
   */
  readonly local = new MemoryFeeSignals();
  /** Redis calls that failed and fell back to the local queue (observability, specs). */
  fallbacks = 0;
  /** Local marks forwarded to redis-state once it answered again (observability, specs). */
  forwarded = 0;
  private forwarding?: Promise<void>;
  private alertedAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly redis: () => Promise<FeeRedis | undefined>,
    private readonly namespace: string,
    private readonly warn: (line: string) => void = () => undefined,
  ) {}

  async markViewed(key: string, id: string, now: number): Promise<ViewMark> {
    const k = feeSignalKeys(this.namespace, key);
    try {
      const r = await this.client();
      const res = Number(
        await r.eval(MARK_VIEWED_SCRIPT, 2, k.views, `${k.vcoolPrefix}${id}`, id, VIEW_QUEUE_MAX_PER_CHAIN, VIEW_COOLDOWN_MS, SIGNAL_KEY_TTL_MS),
      );
      this.forwardLocal();
      return res === 1 ? 'queued' : res === 2 ? 'already' : res === -1 ? 'full' : 'cooling';
    } catch (err) {
      this.failed('markViewed', err);
      return this.local.markViewed(key, id, now);
    }
  }

  async requeueViews(key: string, ids: Iterable<string>): Promise<void> {
    const list = [...ids];
    if (list.length === 0) return;
    const k = feeSignalKeys(this.namespace, key);
    try {
      const r = await this.client();
      await r.eval(REQUEUE_VIEWS_SCRIPT, 1, k.views, VIEW_QUEUE_MAX_PER_CHAIN, k.vcoolPrefix, SIGNAL_KEY_TTL_MS, ...list);
    } catch (err) {
      this.failed('requeueViews', err);
      this.local.requeueViews(key, list);
    }
  }

  async takeViews(key: string, max: number): Promise<string[]> {
    const out = this.local.takeViews(key, max);
    if (out.length >= max) return out;
    try {
      const r = await this.client();
      const got = await r.spop(feeSignalKeys(this.namespace, key).views, max - out.length);
      for (const id of Array.isArray(got) ? got : []) if (!out.includes(id)) out.push(String(id));
    } catch (err) {
      this.failed('takeViews', err);
    }
    return out;
  }

  async markDirty(key: string, lane: DirtyLane, entries: ReadonlyArray<readonly [string, number]>): Promise<number> {
    if (entries.length === 0) return 0;
    const k = feeSignalKeys(this.namespace, key);
    const args: Array<string | number> = [lane, DIRTY_MAX_PER_CHAIN, BACKFILL_MAX_PER_CHAIN, SIGNAL_KEY_TTL_MS];
    for (const [id, block] of entries) args.push(id, encodeBlock(block));
    try {
      const r = await this.client();
      const dropped = Number(await r.eval(MARK_DIRTY_SCRIPT, 5, k.seqLive, k.blkLive, k.seqBackfill, k.blkBackfill, k.ctr, ...args)) || 0;
      this.forwardLocal();
      return dropped;
    } catch (err) {
      this.failed('markDirty', err);
      return this.local.markDirty(key, lane, entries);
    }
  }

  /**
   * Best-effort: move whatever the local fallback queue holds into redis-state
   * (views → the view set, dirty lanes → the same Lua as a mark), once Redis
   * answers again. Runs in the background after a successful mark, one at a
   * time; a failure puts the entries back. A view forwarded keeps its local
   * cooldown only (requeue semantics: queued if the Redis set has room).
   */
  forwardLocal(): Promise<void> {
    if (this.forwarding) return this.forwarding;
    const keys = this.local.keys();
    if (keys.length === 0) return Promise.resolve();
    this.forwarding = (async () => {
      try {
        for (const key of keys) {
          const views = this.local.takeViews(key, VIEW_QUEUE_MAX_PER_CHAIN);
          if (views.length > 0) {
            const k = feeSignalKeys(this.namespace, key);
            try {
              const r = await this.client();
              await r.eval(REQUEUE_VIEWS_SCRIPT, 1, k.views, VIEW_QUEUE_MAX_PER_CHAIN, k.vcoolPrefix, SIGNAL_KEY_TTL_MS, ...views);
              this.forwarded += views.length;
            } catch {
              this.local.requeueViews(key, views);
              return;
            }
          }
          for (const lane of DIRTY_LANES) {
            const taken = this.local.takeDirty(key, lane, lane === 'live' ? DIRTY_MAX_PER_CHAIN : BACKFILL_MAX_PER_CHAIN);
            if (taken.size === 0) continue;
            const entries = [...taken];
            const k = feeSignalKeys(this.namespace, key);
            const args: Array<string | number> = [lane, DIRTY_MAX_PER_CHAIN, BACKFILL_MAX_PER_CHAIN, SIGNAL_KEY_TTL_MS];
            for (const [id, block] of entries) args.push(id, encodeBlock(block));
            try {
              const r = await this.client();
              await r.eval(MARK_DIRTY_SCRIPT, 5, k.seqLive, k.blkLive, k.seqBackfill, k.blkBackfill, k.ctr, ...args);
              this.forwarded += entries.length;
            } catch {
              this.local.markDirty(key, lane, entries);
              return;
            }
          }
        }
      } finally {
        this.forwarding = undefined;
      }
    })();
    return this.forwarding;
  }

  async takeDirty(key: string, lane: DirtyLane, max: number): Promise<Map<string, number>> {
    const out = this.local.takeDirty(key, lane, max);
    if (out.size >= max) return out;
    const k = feeSignalKeys(this.namespace, key);
    try {
      const r = await this.client();
      const flat = (await r.eval(
        TAKE_DIRTY_SCRIPT,
        2,
        lane === 'live' ? k.seqLive : k.seqBackfill,
        lane === 'live' ? k.blkLive : k.blkBackfill,
        max - out.size,
      )) as unknown[];
      for (let i = 0; i + 1 < (flat?.length ?? 0); i += 2) {
        const id = String(flat[i]);
        const b = decodeBlock(flat[i + 1]);
        const prev = out.get(id);
        out.set(id, prev === undefined ? b : Math.max(prev, b));
      }
    } catch (err) {
      this.failed('takeDirty', err);
    }
    return out;
  }

  async sizes(key: string): Promise<{ views: number; live: number; backfill: number }> {
    const local = this.local.sizes(key);
    const k = feeSignalKeys(this.namespace, key);
    try {
      const r = await this.client();
      const [views, live, backfill] = await Promise.all([r.scard(k.views), r.zcard(k.seqLive), r.zcard(k.seqBackfill)]);
      return { views: local.views + Number(views), live: local.live + Number(live), backfill: local.backfill + Number(backfill) };
    } catch {
      return local;
    }
  }

  private async client(): Promise<FeeRedis> {
    const r = await this.redis();
    if (!r) throw new Error('redis-state unavailable');
    return r;
  }

  private failed(op: string, err: unknown): void {
    this.fallbacks++;
    const now = Date.now();
    if (now - this.alertedAt < SIGNALS_ALERT_INTERVAL_MS) return;
    this.alertedAt = now;
    this.warn(
      `[alert] fees.signals_redis op=${op} err=${(err as Error)?.message ?? String(err)} fallbacks=${this.fallbacks} — ` +
        `fee signals held in this process and forwarded to redis-state after its next successful mark ` +
        `(drained directly if this is the fee worker; the full pass covers anything still lost within one interval)`,
    );
  }
}
