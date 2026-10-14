import { Inject, Injectable, Logger, Optional, type OnModuleDestroy } from '@nestjs/common';
import mongoose from 'mongoose';
import { AppConfigService } from '../config/app-config.service.js';
import type { WriteBudgetConfigView } from '../common/write-budget.js';

/*
 * The write budget's two PRIMARY-side inputs no application user can read
 * (P2.4, design §5.3): WiredTiger dirty cache % and the oplog window.
 *
 * Only with `MONGO_MONITOR_URI` — a separate connection as a read-only
 * monitoring user (Atlas: `clusterMonitor` + `read` on `local`). Unset, both
 * inputs are absent (never red) and the backfill lane is capped at
 * `WRITE_BUDGET_BACKFILL_MAX_NO_MONITOR` instead, because nothing would see
 * the oplog window shrink under it.
 *
 * Cheap by construction: one `serverStatus` (wiredTiger section only) per
 * sample, the oplog's first and last entry (`$natural` ±1, limit 1) at most
 * once a minute; a 2-connection pool, primary reads, 5 s server selection.
 * A failed sample keeps the previous reading for up to `STALE_AFTER_MS`, then
 * reads as absent (an unreachable monitor is not a red input — the lag and
 * latency inputs still are).
 */

export interface MongoMonitorReading {
  /** Tracked dirty bytes / maximum cache bytes × 100 on the primary; null = unknown. */
  dirtyPct: number | null;
  /** Newest − oldest oplog entry, seconds; null = unknown. */
  oplogWindowSec: number | null;
  /** When the reading was taken (ms); null = never. */
  at: number | null;
  error?: string;
}

/** A sample older than this reads as absent. */
export const STALE_AFTER_MS = 60_000;
/** The oplog bounds are re-read at most this often. */
export const OPLOG_EVERY_MS = 60_000;

/** `serverStatus.wiredTiger.cache` → dirty %; null when the fields are missing. */
export function dirtyPctFromServerStatus(status: unknown): number | null {
  const cache = (status as { wiredTiger?: { cache?: Record<string, unknown> } } | null | undefined)?.wiredTiger?.cache;
  if (!cache) return null;
  const dirty = Number(cache['tracked dirty bytes in the cache']);
  const max = Number(cache['maximum bytes configured']);
  if (!Number.isFinite(dirty) || !Number.isFinite(max) || max <= 0) return null;
  return Math.max(0, Math.min(100, (dirty / max) * 100));
}

/** Seconds of a BSON Timestamp (its high 32 bits), or of a Date/number. */
export function oplogSeconds(ts: unknown): number | null {
  if (ts === null || ts === undefined) return null;
  if (typeof (ts as { getHighBits?: unknown }).getHighBits === 'function') return (ts as { getHighBits(): number }).getHighBits();
  if (typeof (ts as { high?: unknown }).high === 'number') return (ts as { high: number }).high;
  if (ts instanceof Date) return Math.floor(ts.getTime() / 1000);
  if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
  return null;
}

/** last − first, seconds (≥ 0); null when either is unknown. */
export function oplogWindowSec(first: unknown, last: unknown): number | null {
  const a = oplogSeconds(first);
  const b = oplogSeconds(last);
  if (a === null || b === null) return null;
  return Math.max(0, b - a);
}

/** The part of a MongoClient the monitor uses (specs pass a fake). */
export interface MonitorClient {
  db(name: string): {
    command(cmd: Record<string, unknown>): Promise<unknown>;
    collection(name: string): {
      find(filter: Record<string, unknown>, options?: Record<string, unknown>): {
        sort(sort: Record<string, unknown>): { limit(n: number): { toArray(): Promise<Array<Record<string, unknown>>> } };
      };
    };
  };
  connect?(): Promise<unknown>;
  close?(): Promise<unknown>;
}

@Injectable()
export class MongoMonitor implements OnModuleDestroy {
  private readonly logger = new Logger(MongoMonitor.name);
  private client?: MonitorClient;
  private connecting?: Promise<MonitorClient | undefined>;
  private reading: MongoMonitorReading = { dirtyPct: null, oplogWindowSec: null, at: null };
  private oplogAt = Number.NEGATIVE_INFINITY;
  private oplogWindow: number | null = null;
  private errorLoggedAt = 0;
  private readonly now: () => number;

  constructor(
    @Optional() @Inject(AppConfigService) private readonly config?: AppConfigService,
    // Specs only: a fake client factory and clock.
    @Optional() private readonly factory?: { client?: (uri: string) => MonitorClient; now?: () => number },
  ) {
    this.now = factory?.now ?? Date.now;
  }

  private get uri(): string | undefined {
    const uri = (this.config as unknown as WriteBudgetConfigView | undefined)?.mongoMonitorUri?.trim();
    return uri ? uri : undefined;
  }

  /** `MONGO_MONITOR_URI` is set. */
  get configured(): boolean {
    return this.uri !== undefined;
  }

  /** The last reading, with stale values blanked. */
  current(): MongoMonitorReading {
    if (this.reading.at === null || this.now() - this.reading.at > STALE_AFTER_MS) {
      return { dirtyPct: null, oplogWindowSec: null, at: this.reading.at, ...(this.reading.error ? { error: this.reading.error } : {}) };
    }
    return this.reading;
  }

  /**
   * Take a reading (the controller calls this every tick). Never throws:
   * a failure keeps the previous reading (until stale) and records `error`.
   */
  async sample(): Promise<MongoMonitorReading> {
    const uri = this.uri;
    if (!uri) return this.current();
    const client = await this.connect(uri);
    if (!client) return this.current();
    try {
      const status = await client.db('admin').command({
        serverStatus: 1,
        repl: 0,
        metrics: 0,
        locks: 0,
        opcounters: 0,
        opcountersRepl: 0,
        network: 0,
        asserts: 0,
        connections: 0,
        tcmalloc: 0,
      });
      const dirtyPct = dirtyPctFromServerStatus(status);
      const now = this.now();
      if (now - this.oplogAt >= OPLOG_EVERY_MS) {
        const oplog = client.db('local').collection('oplog.rs');
        const [first] = await oplog.find({}, { projection: { ts: 1 } }).sort({ $natural: 1 }).limit(1).toArray();
        const [last] = await oplog.find({}, { projection: { ts: 1 } }).sort({ $natural: -1 }).limit(1).toArray();
        this.oplogWindow = oplogWindowSec(first?.ts, last?.ts);
        this.oplogAt = now;
      }
      this.reading = { dirtyPct, oplogWindowSec: this.oplogWindow, at: now };
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      this.reading = { ...this.reading, error: message };
      this.logError(message);
    }
    return this.current();
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.close?.().catch(() => undefined);
    this.client = undefined;
  }

  private async connect(uri: string): Promise<MonitorClient | undefined> {
    if (this.client) return this.client;
    // One connect attempt at a time; a failed one is forgotten so the next sample retries.
    this.connecting ??= this.open(uri);
    const client = await this.connecting;
    this.connecting = undefined;
    return client;
  }

  private async open(uri: string): Promise<MonitorClient | undefined> {
    try {
      const client =
        this.factory?.client?.(uri) ??
        (new mongoose.mongo.MongoClient(uri, {
          appName: 'tickwise-write-budget-monitor',
          maxPoolSize: 2,
          minPoolSize: 0,
          readPreference: 'primary',
          serverSelectionTimeoutMS: 5_000,
          connectTimeoutMS: 5_000,
        }) as unknown as MonitorClient);
      await client.connect?.();
      this.client = client;
      return client;
    } catch (err) {
      this.logError((err as Error)?.message ?? String(err));
      return undefined;
    }
  }

  private logError(message: string): void {
    const now = Date.now();
    if (now - this.errorLoggedAt < 60_000) return;
    this.errorLoggedAt = now;
    this.logger.warn(`write-budget monitor (MONGO_MONITOR_URI) sample failed — dirty %/oplog inputs absent: ${message}`);
  }
}
