import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { AppConfigService } from '../config/app-config.service.js';
import { CoordinationRedis } from './coordination-redis.js';
import { sharedStateRedis, type SharedStateRedisSource } from './redis-gcra.js';

/**
 * P2.2 §3.2 — cross-replica cache invalidation over redis-state pub/sub.
 *
 *   CACHE_INVALIDATION=off (default)  nothing is published, nothing is
 *                                     subscribed, no connection: today.
 *   CACHE_INVALIDATION=redis          channel `tw:inv:v1:<ns>`.
 *
 * Messages (each carries `src` = this process's bus id, `seq` = its publish
 * counter, `at` = publish time):
 *   {t:'apikey', keyHash?|customerId?|all?}  ClientsService resolve cache
 *   {t:'origins'}                             ClientsService CORS origin set
 *   {t:'settings'}                            SettingsCacheService reload
 *   {t:'plan', planKey}                       settings reload + metering limiter evict
 *
 * Rules that keep it from looping or lying:
 *  - NO ECHO: a publisher has already applied its change locally; a
 *    subscriber applies a message through a LOCAL-ONLY path (never the
 *    publishing one), and a message whose `src` is this bus is dropped.
 *  - `publish(msg, {local: true})` ALSO runs this process's handlers — for a
 *    writer that does not own the cache (the payments lifecycle moving a
 *    customer's plan): its own replica must forget too.
 *  - At-most-once. A message missed during a reconnect is not replayed; the
 *    caches' own TTLs (30 s / 60 s) remain the backstop, as today.
 *  - Never throws into a caller: publish is fire-and-forget, handlers are
 *    isolated, malformed messages are counted and ignored.
 */

export type InvalidationMessage =
  | { t: 'apikey'; keyHash?: string; customerId?: string; all?: boolean }
  | { t: 'origins' }
  | { t: 'settings' }
  | { t: 'plan'; planKey: string };

export type InvalidationType = InvalidationMessage['t'];

/** A message as it travels (`src`/`seq`/`at` added by the bus). */
export type InvalidationEnvelope = InvalidationMessage & { v: 1; src: string; seq: number; at: number };

export type CacheInvalidationMode = 'off' | 'redis';

export function resolveCacheInvalidationMode(value: unknown): CacheInvalidationMode {
  return typeof value === 'string' && value.trim().toLowerCase() === 'redis' ? 'redis' : 'off';
}

/** `tw:inv:v1:<ns>` */
export function invalidationChannel(namespace: string): string {
  return `tw:inv:v1:${namespace}`;
}

/** Parse + validate one wire message; undefined = malformed (ignored and counted). */
export function parseInvalidation(raw: string): InvalidationEnvelope | undefined {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!m || typeof m !== 'object') return undefined;
  const o = m as Record<string, unknown>;
  if (o.v !== 1 || typeof o.src !== 'string' || o.src === '') return undefined;
  const seq = typeof o.seq === 'number' && Number.isFinite(o.seq) ? o.seq : 0;
  const at = typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : 0;
  const base = { v: 1 as const, src: o.src, seq, at };
  const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
  switch (o.t) {
    case 'apikey': {
      const keyHash = str(o.keyHash);
      const customerId = str(o.customerId);
      const all = o.all === true;
      // A scope-less apikey message would read as "forget everything" — only an
      // explicit `all: true` may mean that.
      if (!keyHash && !customerId && !all) return undefined;
      return { ...base, t: 'apikey', ...(keyHash ? { keyHash } : {}), ...(customerId ? { customerId } : {}), ...(all ? { all } : {}) };
    }
    case 'origins':
      return { ...base, t: 'origins' };
    case 'settings':
      return { ...base, t: 'settings' };
    case 'plan': {
      const planKey = str(o.planKey);
      return planKey ? { ...base, t: 'plan', planKey } : undefined;
    }
    default:
      return undefined;
  }
}

export interface InvalidationStats {
  mode: CacheInvalidationMode;
  subscribed: boolean;
  published: number;
  publishFailed: number;
  received: number;
  droppedSelf: number;
  malformed: number;
  handlerErrors: number;
  /** Resolves whose result was not cached because an invalidation landed meanwhile (ClientsService). */
  staleLoadsNotCached: number;
  /** Publish → receive delay of the last remote message (clock skew included). */
  lastLagMs: number | null;
}

type Handler<T extends InvalidationType> = (msg: Extract<InvalidationMessage, { t: T }>) => void | Promise<void>;

interface BusConfigView {
  cacheInvalidation?: string;
}

@Injectable()
export class InvalidationBus implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(InvalidationBus.name);
  /** This bus's id: messages carrying it are our own echo. */
  readonly id = `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`;
  private readonly handlers = new Map<InvalidationType, Set<Handler<InvalidationType>>>();
  private seq = 0;
  private sub?: Redis;
  private source?: SharedStateRedisSource;
  private readonly counters = {
    published: 0,
    publishFailed: 0,
    received: 0,
    droppedSelf: 0,
    malformed: 0,
    handlerErrors: 0,
    staleLoadsNotCached: 0,
  };
  private lastLagMs: number | null = null;
  private destroyed = false;
  private subscribing?: Promise<void>;

  constructor(
    @Optional() @Inject(AppConfigService) private readonly config?: AppConfigService,
    @Optional() @Inject(CoordinationRedis) private readonly redis?: SharedStateRedisSource,
  ) {}

  get mode(): CacheInvalidationMode {
    return resolveCacheInvalidationMode((this.config as unknown as BusConfigView | undefined)?.cacheInvalidation);
  }

  get enabled(): boolean {
    return this.mode === 'redis';
  }

  private stateRedis(): SharedStateRedisSource {
    this.source ??= sharedStateRedis(this.redis, this.config);
    return this.source;
  }

  get channel(): string {
    return invalidationChannel(this.stateRedis().namespace);
  }

  /**
   * Subscribe in the BACKGROUND (never awaited: a boot must not wait on
   * Redis). Off → nothing, no connection.
   */
  onModuleInit(): void {
    if (!this.enabled) return;
    this.subscribing = this.subscribe().catch((err) =>
      this.logger.warn(`invalidation bus: subscribe failed (TTL fallback): ${(err as Error)?.message ?? String(err)}`),
    );
  }

  /** Specs / status: resolves once the background subscribe settled (at once while off). */
  whenSubscribed(): Promise<void> {
    return this.subscribing ?? Promise.resolve();
  }

  async onModuleDestroy(): Promise<void> {
    this.destroyed = true;
    const sub = this.sub;
    this.sub = undefined;
    await sub?.quit().catch(() => undefined);
  }

  /** Register a LOCAL-ONLY handler for one message type (subscribers). */
  on<T extends InvalidationType>(type: T, handler: Handler<T>): void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler as unknown as Handler<InvalidationType>);
  }

  /**
   * Tell the other replicas. Call AFTER the local change. `local: true` also
   * runs this process's handlers (a writer that does not own the cache).
   * Off → nothing at all (today).
   */
  publish(msg: InvalidationMessage, opts: { local?: boolean } = {}): void {
    if (!this.enabled) return;
    if (opts.local) this.dispatch(msg);
    const envelope: InvalidationEnvelope = { ...msg, v: 1, src: this.id, seq: ++this.seq, at: Date.now() };
    void this.send(JSON.stringify(envelope));
  }

  /** ClientsService counts the resolves it declined to cache. */
  noteStaleLoadNotCached(): void {
    this.counters.staleLoadsNotCached += 1;
  }

  stats(): InvalidationStats {
    return { mode: this.mode, subscribed: Boolean(this.sub), ...this.counters, lastLagMs: this.lastLagMs };
  }

  /** The subscriber's entry point (exported through the class for specs). */
  receive(raw: string): void {
    const msg = parseInvalidation(raw);
    if (!msg) {
      this.counters.malformed += 1;
      return;
    }
    if (msg.src === this.id) {
      this.counters.droppedSelf += 1;
      return;
    }
    this.counters.received += 1;
    if (msg.at > 0) this.lastLagMs = Math.max(0, Date.now() - msg.at);
    this.dispatch(msg);
  }

  private dispatch(msg: InvalidationMessage): void {
    const set = this.handlers.get(msg.t);
    if (!set) return;
    for (const handler of set) {
      try {
        const out = handler(msg as never);
        if (out && typeof (out as Promise<void>).catch === 'function') {
          (out as Promise<void>).catch((err) => this.handlerFailed(msg.t, err));
        }
      } catch (err) {
        this.handlerFailed(msg.t, err);
      }
    }
  }

  private handlerFailed(type: InvalidationType, err: unknown): void {
    this.counters.handlerErrors += 1;
    this.logger.warn(`invalidation bus: ${type} handler failed: ${(err as Error)?.message ?? String(err)}`);
  }

  private async send(payload: string): Promise<void> {
    const client = await this.stateRedis().client().catch(() => undefined);
    if (!client) {
      this.counters.publishFailed += 1;
      return;
    }
    try {
      await client.publish(this.channel, payload);
      this.counters.published += 1;
    } catch {
      this.counters.publishFailed += 1;
    }
  }

  private async subscribe(): Promise<void> {
    const source = this.stateRedis();
    const sub = source.subscriber?.('inv');
    if (!sub) {
      this.logger.warn('invalidation bus: the redis-state source cannot open a subscriber — TTL fallback only');
      return;
    }
    if (this.destroyed) {
      await sub.quit().catch(() => undefined);
      return;
    }
    this.sub = sub;
    sub.on('message', (channel: string, message: string) => {
      if (channel === this.channel) this.receive(message);
    });
    // ioredis re-subscribes on its own after a reconnect (`autoResubscribe`).
    await sub.subscribe(this.channel);
    this.logger.log(`invalidation bus: subscribed to ${this.channel}`);
  }
}
