import { randomBytes } from 'node:crypto';
import type { DeltaEntry } from './feeder/delta-codec.js';
import { entryFields, entryFromFields, compareStreamIds } from './feeder/delta-codec.js';
import {
  appendModel,
  fencedSetModel,
  incarnationModel,
  nextFenceModel,
  parseCursor,
  seedFenceModel,
  type AppendOutcome,
  type CursorValue,
  type FencedSetOutcome,
  type ScriptStore,
} from './feeder/fenced-append.js';
import type { Manifest } from './feeder/snapshot-store.js';
import type { RmKeys } from './keys.js';
import type { LeaseAcquireResult } from '../common/redis-lease.js';

/**
 * What the read models need from their two Redis instances, behind
 * interfaces: `RedisModelsTransport` / `RedisStateTransport` (ioredis, the
 * real thing) and the in-memory versions below, which run the SAME script
 * models (`fenced-append.ts`). The in-memory ones are what the specs share
 * between simulated processes, and what a dev process falls back to when no
 * Redis answers (a private feeder: self-consistent, nothing shared). They
 * are never used in production (design §2.4: no Redis ⇒ models NOT READY).
 */

export interface ModelsTransport {
  /** `redis` (shared by every process) or `memory` (process-private / spec-shared). */
  readonly kind: 'redis' | 'memory';
  /** Get-or-create the incarnation (refreshing its TTL); `created` = it was missing (redis-models empty or flushed). */
  ensureIncarnation(ttlMs: number): Promise<{ inc: string; created: boolean }>;
  incarnation(): Promise<string | null>;
  /** Raise the fence copy to `fence` (only if missing or lower); false when a greater fence is there. */
  seedFence(fence: number, ttlMs: number): Promise<boolean>;
  fenceCopy(): Promise<number | null>;
  /** The fenced append (one script). */
  append(entry: DeltaEntry, ttlMs: number): Promise<AppendOutcome>;
  /** Entries after `afterId` (exclusive), waiting up to `blockMs` for one (0 = no wait). */
  read(afterId: string, count: number, blockMs: number): Promise<DeltaEntry[]>;
  /** Entries after `afterId` (exclusive), no wait. */
  range(afterId: string, count: number): Promise<DeltaEntry[]>;
  /** The newest stream id, or null for an empty / missing stream. */
  tailId(): Promise<string | null>;
  cursor(): Promise<CursorValue | null>;
  /** `XTRIM MINID`: drop entries older than `minId`. */
  trim(minId: string): Promise<number>;
  manifest(): Promise<Manifest | null>;
  /** The fenced manifest switch. */
  putManifest(manifest: Manifest, ttlMs: number): Promise<FencedSetOutcome>;
  putChunk(key: string, data: Uint8Array, ttlMs: number): Promise<void>;
  getChunk(key: string): Promise<Uint8Array | null>;
  /** PEXPIRE each key (missing keys ignored). */
  expire(keys: readonly string[], ttlMs: number): Promise<void>;
  /** Keys matching `pattern` (a SCAN), in pages. */
  scan(pattern: string): AsyncIterable<string[]>;
  pttl(keys: readonly string[]): Promise<number[]>;
  /** Approximate stored bytes per key (`STRLEN`; a stream counts 0). */
  sizes(keys: readonly string[]): Promise<number[]>;
  unlink(keys: readonly string[]): Promise<number>;
  /** `INFO memory` (+ policy); null when unavailable. */
  memory(): Promise<{ used: number; max: number; policy?: string } | null>;
}

export interface Lease {
  readonly owner: string;
  acquire(): Promise<LeaseAcquireResult>;
  renew(): Promise<boolean>;
  release(): Promise<void>;
}

export interface StateTransport {
  readonly kind: 'redis' | 'memory';
  lease(key: string, ttlMs: number, owner?: string): Lease;
  /** The next fence from the authority (`INCR`, seeded with now-ms when missing). */
  nextFence(nowMs: number): Promise<number>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlMs?: number): Promise<void>;
  /** LPUSH (bounded list, TTL refreshed). */
  push(key: string, value: string, ttlMs: number): Promise<void>;
  /** RPOP (oldest first). */
  pop(key: string): Promise<string | null>;
  /** Values of every key with `prefix` (a SCAN of the whole keyspace — avoid on a timer). */
  scanValues(prefix: string): Promise<Array<{ key: string; value: string }>>;
  incr(key: string, ttlMs: number): Promise<number>;
  /**
   * One field of a hash (fleet heartbeats, shadow-coverage records — one hash
   * per deployment, read with ONE `HGETALL` instead of a SCAN of `REDIS_URL`,
   * which BullMQ shares). The HASH's TTL is refreshed to `ttlMs`; a field has
   * none of its own, so readers drop (and `hdel`) the stale ones.
   */
  hset(key: string, field: string, value: string, ttlMs: number): Promise<void>;
  hgetall(key: string): Promise<Record<string, string>>;
  hdel(key: string, fields: string[]): Promise<void>;
}

// ── in-memory implementation ──

interface StoredString {
  value: string | Uint8Array;
  expiresAt: number;
}

interface StoredStream {
  entries: Array<{ id: string; fields: Array<string | Uint8Array> }>;
  expiresAt: number;
  lastMs: number;
  lastSeq: number;
}

/**
 * A tiny Redis stand-in: strings with TTLs, lists, streams with `<ms>-<seq>`
 * ids, blocking reads. One instance = one Redis server; share it between
 * transports to simulate processes on one Redis, and call `flushAll()` to
 * simulate losing it.
 */
export class MemoryRedis implements ScriptStore {
  private readonly strings = new Map<string, StoredString>();
  private readonly lists = new Map<string, { items: string[]; expiresAt: number }>();
  private readonly streams = new Map<string, StoredStream>();
  private readonly hashes = new Map<string, { fields: Map<string, string>; expiresAt: number }>();
  private waiters: Array<() => void> = [];
  /** Set to make every call throw (an unreachable Redis). */
  down = false;
  maxmemory = 0;
  policy = 'noeviction';

  constructor(readonly now: () => number = Date.now) {}

  check(): void {
    if (this.down) throw new Error('memory redis: connection refused');
  }

  private alive<T extends { expiresAt: number }>(map: Map<string, T>, key: string): T | undefined {
    const entry = map.get(key);
    if (entry && entry.expiresAt <= this.now()) {
      map.delete(key);
      return undefined;
    }
    return entry;
  }

  get(key: string): string | null {
    const entry = this.alive(this.strings, key);
    if (!entry) return null;
    return typeof entry.value === 'string' ? entry.value : Buffer.from(entry.value).toString('binary');
  }

  getBytes(key: string): Uint8Array | null {
    const entry = this.alive(this.strings, key);
    if (!entry) return null;
    return typeof entry.value === 'string' ? new TextEncoder().encode(entry.value) : entry.value;
  }

  set(key: string, value: string | Uint8Array, ttlMs?: number): void {
    this.strings.set(key, { value: typeof value === 'string' ? value : Uint8Array.from(value), expiresAt: ttlMs ? this.now() + ttlMs : Number.POSITIVE_INFINITY });
  }

  hset(key: string, field: string, value: string, ttlMs: number): void {
    let hash = this.alive(this.hashes, key);
    if (!hash) {
      hash = { fields: new Map(), expiresAt: Number.POSITIVE_INFINITY };
      this.hashes.set(key, hash);
    }
    hash.fields.set(field, value);
    hash.expiresAt = this.now() + ttlMs;
  }

  hgetall(key: string): Record<string, string> {
    return Object.fromEntries(this.alive(this.hashes, key)?.fields ?? []);
  }

  hdel(key: string, fields: string[]): void {
    const hash = this.alive(this.hashes, key);
    if (!hash) return;
    for (const field of fields) hash.fields.delete(field);
    if (hash.fields.size === 0) this.hashes.delete(key);
  }

  expire(key: string, ttlMs: number): void {
    const at = this.now() + ttlMs;
    for (const map of [this.strings, this.lists, this.streams, this.hashes] as Array<Map<string, { expiresAt: number }>>) {
      const entry = this.alive(map, key);
      if (entry) entry.expiresAt = at;
    }
  }

  exists(key: string): boolean {
    return Boolean(this.alive(this.strings, key) ?? this.alive(this.lists, key) ?? this.alive(this.streams, key));
  }

  pttl(key: string): number {
    for (const map of [this.strings, this.lists, this.streams] as Array<Map<string, { expiresAt: number }>>) {
      const entry = this.alive(map, key);
      if (entry) return Number.isFinite(entry.expiresAt) ? entry.expiresAt - this.now() : -1;
    }
    return -2;
  }

  del(key: string): number {
    let n = 0;
    for (const map of [this.strings, this.lists, this.streams] as Array<Map<string, unknown>>) if (map.delete(key)) n++;
    return n;
  }

  keys(pattern: string): string[] {
    const rx = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
    const out: string[] = [];
    for (const map of [this.strings, this.lists, this.streams] as Array<Map<string, { expiresAt: number }>>) {
      for (const key of [...map.keys()]) if (this.alive(map, key) && rx.test(key)) out.push(key);
    }
    return out;
  }

  xadd(key: string, fields: Array<string | Uint8Array>): string {
    let stream = this.alive(this.streams, key);
    if (!stream) {
      stream = { entries: [], expiresAt: Number.POSITIVE_INFINITY, lastMs: 0, lastSeq: -1 };
      this.streams.set(key, stream);
    }
    const ms = Math.max(Math.floor(this.now()), stream.lastMs);
    const seq = ms === stream.lastMs ? stream.lastSeq + 1 : 0;
    stream.lastMs = ms;
    stream.lastSeq = seq;
    const id = `${ms}-${seq}`;
    stream.entries.push({ id, fields: fields.map((f) => (typeof f === 'string' ? f : Uint8Array.from(f))) });
    for (const wake of this.waiters.splice(0)) wake();
    return id;
  }

  xrange(key: string, afterId: string, count: number): Array<{ id: string; fields: Array<string | Uint8Array> }> {
    const stream = this.alive(this.streams, key);
    if (!stream) return [];
    const out = [];
    for (const entry of stream.entries) {
      if (compareStreamIds(entry.id, afterId) <= 0) continue;
      out.push(entry);
      if (out.length >= count) break;
    }
    return out;
  }

  xtail(key: string): string | null {
    const stream = this.alive(this.streams, key);
    return stream && stream.entries.length > 0 ? stream.entries[stream.entries.length - 1].id : null;
  }

  xtrimMinId(key: string, minId: string): number {
    const stream = this.alive(this.streams, key);
    if (!stream) return 0;
    const before = stream.entries.length;
    stream.entries = stream.entries.filter((entry) => compareStreamIds(entry.id, minId) >= 0);
    return before - stream.entries.length;
  }

  async waitForAppend(ms: number): Promise<void> {
    if (ms <= 0) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== wake);
        resolve();
      }, ms);
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      this.waiters.push(wake);
    });
  }

  lpush(key: string, value: string, ttlMs: number): void {
    let list = this.alive(this.lists, key);
    if (!list) {
      list = { items: [], expiresAt: 0 };
      this.lists.set(key, list);
    }
    list.items.unshift(value);
    list.expiresAt = this.now() + ttlMs;
  }

  rpop(key: string): string | null {
    const list = this.alive(this.lists, key);
    return list?.items.pop() ?? null;
  }

  /** Approximate used bytes (strings + stream payloads). */
  usedBytes(): number {
    let total = 0;
    for (const [key, entry] of this.strings) if (this.alive(this.strings, key)) total += key.length + (typeof entry.value === 'string' ? entry.value.length : entry.value.byteLength);
    for (const [key, stream] of this.streams) {
      if (!this.alive(this.streams, key)) continue;
      for (const entry of stream.entries) for (const f of entry.fields) total += typeof f === 'string' ? f.length : f.byteLength;
    }
    return total;
  }

  flushAll(): void {
    this.strings.clear();
    this.lists.clear();
    this.streams.clear();
    this.hashes.clear();
  }
}

export class MemoryModelsTransport implements ModelsTransport {
  readonly kind = 'memory' as const;

  constructor(
    readonly redis: MemoryRedis,
    private readonly keys: RmKeys,
  ) {}

  async ensureIncarnation(ttlMs: number) {
    this.redis.check();
    return incarnationModel(this.redis, this.keys.incarnation, randomBytes(8).toString('hex'), ttlMs);
  }

  async incarnation() {
    this.redis.check();
    return this.redis.get(this.keys.incarnation);
  }

  async seedFence(fence: number, ttlMs: number) {
    this.redis.check();
    return seedFenceModel(this.redis, this.keys.fenceCopy, fence, ttlMs);
  }

  async fenceCopy() {
    this.redis.check();
    const v = this.redis.get(this.keys.fenceCopy);
    return v === null ? null : Number(v);
  }

  async append(entry: DeltaEntry, ttlMs: number): Promise<AppendOutcome> {
    this.redis.check();
    return appendModel(
      this.redis,
      { fenceCopy: this.keys.fenceCopy, incarnation: this.keys.incarnation, deltas: this.keys.deltas, cursor: this.keys.cursor },
      { fence: entry.f, inc: entry.inc, epoch: entry.e, s: entry.s, ttlMs, fields: entryFields(entry) as Array<string | Uint8Array> },
    );
  }

  async read(afterId: string, count: number, blockMs: number): Promise<DeltaEntry[]> {
    this.redis.check();
    let rows = this.redis.xrange(this.keys.deltas, afterId, count);
    if (rows.length === 0 && blockMs > 0) {
      await this.redis.waitForAppend(blockMs);
      this.redis.check();
      rows = this.redis.xrange(this.keys.deltas, afterId, count);
    }
    return rows.map((row) => entryFromFields(row.id, row.fields.map((f) => (typeof f === 'string' ? f : Buffer.from(f)))));
  }

  async range(afterId: string, count: number): Promise<DeltaEntry[]> {
    return this.read(afterId, count, 0);
  }

  async tailId() {
    this.redis.check();
    return this.redis.xtail(this.keys.deltas);
  }

  async cursor() {
    this.redis.check();
    return parseCursor(this.redis.get(this.keys.cursor));
  }

  async trim(minId: string) {
    this.redis.check();
    return this.redis.xtrimMinId(this.keys.deltas, minId);
  }

  async manifest(): Promise<Manifest | null> {
    this.redis.check();
    const raw = this.redis.get(this.keys.manifest);
    return raw ? (JSON.parse(raw) as Manifest) : null;
  }

  async putManifest(manifest: Manifest, ttlMs: number): Promise<FencedSetOutcome> {
    this.redis.check();
    return fencedSetModel(
      this.redis,
      { fenceCopy: this.keys.fenceCopy, incarnation: this.keys.incarnation, target: this.keys.manifest },
      { fence: manifest.fence, inc: manifest.inc, value: JSON.stringify(manifest), ttlMs },
    );
  }

  async putChunk(key: string, data: Uint8Array, ttlMs: number) {
    this.redis.check();
    this.redis.set(key, data, ttlMs);
  }

  async getChunk(key: string) {
    this.redis.check();
    return this.redis.getBytes(key);
  }

  async expire(keys: readonly string[], ttlMs: number) {
    this.redis.check();
    for (const key of keys) this.redis.expire(key, ttlMs);
  }

  async *scan(pattern: string): AsyncIterable<string[]> {
    this.redis.check();
    yield this.redis.keys(pattern);
  }

  async pttl(keys: readonly string[]) {
    this.redis.check();
    return keys.map((key) => this.redis.pttl(key));
  }

  async sizes(keys: readonly string[]) {
    this.redis.check();
    return keys.map((key) => this.redis.getBytes(key)?.byteLength ?? 0);
  }

  async unlink(keys: readonly string[]) {
    this.redis.check();
    let n = 0;
    for (const key of keys) n += this.redis.del(key) > 0 ? 1 : 0;
    return n;
  }

  async memory() {
    this.redis.check();
    return { used: this.redis.usedBytes(), max: this.redis.maxmemory, policy: this.redis.policy };
  }
}

export class MemoryStateTransport implements StateTransport {
  readonly kind = 'memory' as const;

  constructor(
    readonly redis: MemoryRedis,
    private readonly keys: RmKeys,
  ) {}

  lease(key: string, ttlMs: number, owner?: string): Lease {
    const redis = this.redis;
    const me = owner ?? `mem:${randomBytes(4).toString('hex')}`;
    return {
      owner: me,
      async acquire() {
        if (redis.down) return 'unavailable';
        const cur = redis.get(key);
        if (cur === null) {
          redis.set(key, me, ttlMs);
          return 'acquired';
        }
        if (cur === me) {
          redis.expire(key, ttlMs);
          return 'acquired';
        }
        return 'held';
      },
      async renew() {
        if (redis.down) return false;
        if (redis.get(key) !== me) return false;
        redis.expire(key, ttlMs);
        return true;
      },
      async release() {
        if (redis.down) return;
        if (redis.get(key) === me) redis.del(key);
      },
    };
  }

  async nextFence(nowMs: number) {
    this.redis.check();
    return nextFenceModel(this.redis, this.keys.fenceAuthority, nowMs);
  }

  async get(key: string) {
    this.redis.check();
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlMs?: number) {
    this.redis.check();
    this.redis.set(key, value, ttlMs);
  }

  async push(key: string, value: string, ttlMs: number) {
    this.redis.check();
    this.redis.lpush(key, value, ttlMs);
  }

  async pop(key: string) {
    this.redis.check();
    return this.redis.rpop(key);
  }

  async scanValues(prefix: string) {
    this.redis.check();
    return this.redis
      .keys(`${prefix}*`)
      .map((key) => ({ key, value: this.redis.get(key) }))
      .filter((row): row is { key: string; value: string } => row.value !== null);
  }

  async incr(key: string, ttlMs: number) {
    this.redis.check();
    const next = Number(this.redis.get(key) ?? '0') + 1;
    this.redis.set(key, String(next), ttlMs);
    return next;
  }

  async hset(key: string, field: string, value: string, ttlMs: number) {
    this.redis.check();
    this.redis.hset(key, field, value, ttlMs);
  }

  async hgetall(key: string) {
    this.redis.check();
    return this.redis.hgetall(key);
  }

  async hdel(key: string, fields: string[]) {
    this.redis.check();
    this.redis.hdel(key, fields);
  }
}
