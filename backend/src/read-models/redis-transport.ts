import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import { RedisLease } from '../common/redis-lease.js';
import { entryFields, entryFromFields, type DeltaEntry } from './feeder/delta-codec.js';
import {
  APPEND_SCRIPT,
  FENCED_SET_SCRIPT,
  INCARNATION_SCRIPT,
  NEXT_FENCE_SCRIPT,
  SEED_FENCE_SCRIPT,
  parseCursor,
  type AppendOutcome,
  type AppendRefusal,
  type FencedSetOutcome,
} from './feeder/fenced-append.js';
import type { Manifest } from './feeder/snapshot-store.js';
import type { RmKeys } from './keys.js';
import type { Lease, ModelsTransport, StateTransport } from './transport.js';

/** A client getter that answers undefined while Redis is unavailable. */
export type ClientGetter = () => Promise<Redis | undefined>;

export class RedisUnavailableError extends Error {
  constructor(which: string) {
    super(`${which} Redis is unavailable`);
    this.name = 'RedisUnavailableError';
  }
}

async function need(get: ClientGetter, which: string): Promise<Redis> {
  const client = await get();
  if (!client) throw new RedisUnavailableError(which);
  return client;
}

/** redis-models over ioredis (control / blocking / bulk clients, design §2.3). */
export class RedisModelsTransport implements ModelsTransport {
  readonly kind = 'redis' as const;

  constructor(
    private readonly clients: { control: ClientGetter; blocking: ClientGetter; bulk: ClientGetter },
    private readonly keys: RmKeys,
  ) {}

  private control() {
    return need(this.clients.control, 'redis-models');
  }

  async ensureIncarnation(ttlMs: number) {
    const redis = await this.control();
    const [value, created] = (await redis.eval(INCARNATION_SCRIPT, 1, this.keys.incarnation, randomBytes(8).toString('hex'), String(Math.floor(ttlMs)))) as [string, number];
    return { inc: String(value), created: Number(created) === 1 };
  }

  async incarnation() {
    return (await this.control()).get(this.keys.incarnation);
  }

  async seedFence(fence: number, ttlMs: number) {
    const redis = await this.control();
    return Number(await redis.eval(SEED_FENCE_SCRIPT, 1, this.keys.fenceCopy, String(fence), String(Math.floor(ttlMs)))) === 1;
  }

  async fenceCopy() {
    const v = await (await this.control()).get(this.keys.fenceCopy);
    return v === null ? null : Number(v);
  }

  async append(entry: DeltaEntry, ttlMs: number): Promise<AppendOutcome> {
    const redis = await this.control();
    const k = this.keys;
    const reply = (await redis.eval(
      APPEND_SCRIPT,
      4,
      k.fenceCopy,
      k.incarnation,
      k.deltas,
      k.cursor,
      String(entry.f),
      entry.inc,
      String(entry.e),
      String(entry.s),
      String(Math.floor(ttlMs)),
      ...entryFields(entry),
    )) as [number, string, string];
    if (Number(reply[0]) === 1) return { ok: true, id: String(reply[1]) };
    return { ok: false, reason: String(reply[1]) as AppendRefusal, detail: String(reply[2] ?? '') };
  }

  async read(afterId: string, count: number, blockMs: number): Promise<DeltaEntry[]> {
    const redis = blockMs > 0 ? await need(this.clients.blocking, 'redis-models') : await this.control();
    const args: Array<string | number> = ['COUNT', count];
    if (blockMs > 0) args.push('BLOCK', blockMs);
    const reply = (await (redis.xreadBuffer as (...a: unknown[]) => Promise<unknown>)(...args, 'STREAMS', this.keys.deltas, afterId)) as
      | Array<[Buffer, Array<[Buffer, Buffer[]]>]>
      | null;
    if (!reply) return [];
    const out: DeltaEntry[] = [];
    for (const [, entries] of reply) for (const [id, fields] of entries) out.push(entryFromFields(id.toString(), fields));
    return out;
  }

  async range(afterId: string, count: number): Promise<DeltaEntry[]> {
    const redis = await this.control();
    const rows = await redis.xrangeBuffer(this.keys.deltas, `(${afterId}`, '+', 'COUNT', count);
    return rows.map(([id, fields]) => entryFromFields(id.toString(), fields));
  }

  async tailId() {
    const redis = await this.control();
    const rows = (await redis.xrevrange(this.keys.deltas, '+', '-', 'COUNT', 1)) as Array<[string, string[]]>;
    return rows[0]?.[0] ?? null;
  }

  async cursor() {
    return parseCursor(await (await this.control()).get(this.keys.cursor));
  }

  async trim(minId: string) {
    const redis = await this.control();
    return Number(await redis.xtrim(this.keys.deltas, 'MINID', minId));
  }

  async manifest(): Promise<Manifest | null> {
    const raw = await (await this.control()).get(this.keys.manifest);
    return raw ? (JSON.parse(raw) as Manifest) : null;
  }

  async putManifest(manifest: Manifest, ttlMs: number): Promise<FencedSetOutcome> {
    const redis = await this.control();
    const reply = (await redis.eval(
      FENCED_SET_SCRIPT,
      3,
      this.keys.fenceCopy,
      this.keys.incarnation,
      this.keys.manifest,
      String(manifest.fence),
      manifest.inc,
      JSON.stringify(manifest),
      String(Math.floor(ttlMs)),
    )) as [number, string];
    return Number(reply[0]) === 1 ? 'ok' : (String(reply[1]) as FencedSetOutcome);
  }

  async putChunk(key: string, data: Uint8Array, ttlMs: number) {
    const redis = await need(this.clients.bulk, 'redis-models');
    await redis.set(key, Buffer.from(data.buffer, data.byteOffset, data.byteLength), 'PX', Math.floor(ttlMs));
  }

  async getChunk(key: string) {
    const redis = await need(this.clients.bulk, 'redis-models');
    const value = await redis.getBuffer(key);
    return value ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : null;
  }

  async expire(keys: readonly string[], ttlMs: number) {
    if (keys.length === 0) return;
    const redis = await need(this.clients.bulk, 'redis-models');
    for (let i = 0; i < keys.length; i += 500) {
      const pipeline = redis.pipeline();
      for (const key of keys.slice(i, i + 500)) pipeline.pexpire(key, Math.floor(ttlMs));
      await pipeline.exec();
    }
  }

  async *scan(pattern: string): AsyncIterable<string[]> {
    const redis = await need(this.clients.bulk, 'redis-models');
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
      cursor = next;
      if (keys.length > 0) yield keys;
    } while (cursor !== '0');
  }

  async pttl(keys: readonly string[]) {
    if (keys.length === 0) return [];
    const redis = await need(this.clients.bulk, 'redis-models');
    const pipeline = redis.pipeline();
    for (const key of keys) pipeline.pttl(key);
    return ((await pipeline.exec()) ?? []).map(([, value]) => Number(value));
  }

  async sizes(keys: readonly string[]) {
    if (keys.length === 0) return [];
    const redis = await need(this.clients.bulk, 'redis-models');
    const pipeline = redis.pipeline();
    for (const key of keys) pipeline.strlen(key);
    return ((await pipeline.exec()) ?? []).map(([err, value]) => (err ? 0 : Number(value)));
  }

  async unlink(keys: readonly string[]) {
    if (keys.length === 0) return 0;
    const redis = await need(this.clients.bulk, 'redis-models');
    let n = 0;
    for (let i = 0; i < keys.length; i += 500) n += Number(await redis.unlink(...keys.slice(i, i + 500)));
    return n;
  }

  async memory() {
    const redis = await this.control();
    const info = await redis.info('memory');
    const field = (name: string) => {
      const m = new RegExp(`^${name}:(.*)$`, 'm').exec(info);
      return m ? m[1].trim() : undefined;
    };
    return { used: Number(field('used_memory') ?? 0), max: Number(field('maxmemory') ?? 0), policy: field('maxmemory_policy') };
  }
}

/** redis-state over ioredis. */
export class RedisStateTransport implements StateTransport {
  readonly kind = 'redis' as const;

  constructor(
    private readonly client: ClientGetter,
    private readonly keys: RmKeys,
  ) {}

  lease(key: string, ttlMs: number, owner?: string): Lease {
    return new RedisLease(this.client, key, ttlMs, owner);
  }

  async nextFence(nowMs: number) {
    const redis = await need(this.client, 'redis-state');
    return Number(await redis.eval(NEXT_FENCE_SCRIPT, 1, this.keys.fenceAuthority, String(Math.floor(nowMs))));
  }

  async get(key: string) {
    return (await need(this.client, 'redis-state')).get(key);
  }

  async set(key: string, value: string, ttlMs?: number) {
    const redis = await need(this.client, 'redis-state');
    if (ttlMs) await redis.set(key, value, 'PX', Math.floor(ttlMs));
    else await redis.set(key, value);
  }

  async push(key: string, value: string, ttlMs: number) {
    const redis = await need(this.client, 'redis-state');
    await redis.multi().lpush(key, value).ltrim(key, 0, 99).pexpire(key, Math.floor(ttlMs)).exec();
  }

  async pop(key: string) {
    return (await need(this.client, 'redis-state')).rpop(key);
  }

  async scanValues(prefix: string) {
    const redis = await need(this.client, 'redis-state');
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, page] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
      cursor = next;
      keys.push(...page);
    } while (cursor !== '0');
    if (keys.length === 0) return [];
    const values = await redis.mget(...keys);
    return keys.map((key, i) => ({ key, value: values[i] })).filter((row): row is { key: string; value: string } => row.value !== null);
  }

  async incr(key: string, ttlMs: number) {
    const redis = await need(this.client, 'redis-state');
    const [[, value]] = (await redis.multi().incr(key).pexpire(key, Math.floor(ttlMs)).exec()) as Array<[Error | null, unknown]>;
    return Number(value);
  }

  async hset(key: string, field: string, value: string, ttlMs: number) {
    const redis = await need(this.client, 'redis-state');
    await redis.multi().hset(key, field, value).pexpire(key, Math.floor(ttlMs)).exec();
  }

  async hgetall(key: string) {
    return (await need(this.client, 'redis-state')).hgetall(key);
  }

  async hdel(key: string, fields: string[]) {
    if (fields.length === 0) return;
    await (await need(this.client, 'redis-state')).hdel(key, ...fields);
  }
}
