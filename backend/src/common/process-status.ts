import { hostname } from 'node:os';
import { Inject, Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { AppConfigService } from '../config/app-config.service.js';
import { CoordinationRedis, leaseKey } from './coordination-redis.js';
import { activeLeaseRunners } from './lease-runner.js';
import { currentProcessRole, leasesEnabled, statusPublishMsDefault, type ProcessRole } from './process-role.js';
import { backfillProfiles } from '../sync/backfill-profile.js';
import { indexerBudgetSnapshot } from '../subgraph/hyperindex/indexer-gateway.js';

/**
 * P2.1 — status fan-in and fleet alerts (design §2.1 "Status fan-in", §2.5, §3.6).
 *
 * With `PROCESS_STATUS_PUBLISH_MS > 0` (unset: 10 000 whenever leases are on,
 * `all` included; 0 in `all` + leases off = today) each process writes, every
 * interval, ONE
 * pipeline:
 *   SET  tw:proc:v1:<ns>:<role>:<host>:<pid>  <json>  EX 30
 *   ZADD tw:proc:v1:<ns>:index  <now>  <that key>
 *   ZREMRANGEBYSCORE tw:proc:v1:<ns>:index  -inf  <now − 60 s>   (bounded index)
 *   EXPIRE tw:proc:v1:<ns>:index  120   (gone once the whole fleet stops publishing)
 * A graceful exit WITHDRAWS the record (DEL the key + ZREM it from the index,
 * after any publish in flight, bounded to 1 s), so a stopped process leaves
 * `processes` at once instead of lingering for the key's 30 s TTL.
 * `{role, startedAt, leasesHeld[], fences, runtime, indexer?, backfill?,
 * …contributors}` — `indexer` (`indexerBudgetSnapshot`) and `backfill`
 * (`backfillProfiles`) are built in, present once non-empty; services with an
 * instance (`writeBudget`, `fee`) add theirs through `registerStatusContributor`.
 * `GET /admin/sync/status` reads it back via `readFleet()` (integrator).
 *
 * Fleet alerts, from the publisher's tick, with leases on only:
 *   `[alert] process_role.no_scheduler` — the `scheduler` lease absent > 2 min
 *   `[alert] fees.no_worker`            — `fee-worker` absent > 2 min (fee refresh enabled)
 *   `[alert] process_role.mixed`        — `all` beside a split role > 10 min (expected in rollout step 5)
 * The `scheduler` holder also samples redis-state `INFO memory` every 60 s
 * (`sampleRedisMemory`): `[alert] redis_state.memory` at ≥ 70 % of maxmemory.
 * Every alert at most once a minute per key.
 */

export const STATUS_KEY_TTL_SEC = 30;
export const STATUS_INDEX_WINDOW_MS = 60_000;
/** TTL of the index ZSET, refreshed by every publish: twice the window it is read over. */
export const STATUS_INDEX_TTL_SEC = (2 * STATUS_INDEX_WINDOW_MS) / 1000;
/** How long a graceful exit waits to withdraw its record before giving up (the TTL then removes it). */
export const STATUS_WITHDRAW_MS = 1_000;
export const LEASE_ABSENT_ALERT_MS = 2 * 60_000;
export const MIXED_ALERT_MS = 10 * 60_000;
export const REDIS_MEMORY_ALERT_PCT = 70;
const ALERT_EVERY_MS = 60_000;

export function statusIndexKey(namespace: string): string {
  return `tw:proc:v1:${namespace}:index`;
}

export function statusKey(namespace: string, role: string, host: string, pid: number): string {
  return `tw:proc:v1:${namespace}:${role}:${host}:${pid}`;
}

/** Extra status blocks other packages add (indexer, writeBudget, fee, backfill …). Must be cheap and never throw. */
const contributors = new Map<string, () => unknown>();

export function registerStatusContributor(name: string, fn: () => unknown): void {
  contributors.set(name, fn);
}

export function unregisterStatusContributor(name: string): void {
  contributors.delete(name);
}

/** Process-wide blocks read from module state (no service instance needed). */
function builtInBlocks(now: number): Array<[string, () => unknown]> {
  return [
    ['indexer', () => indexerBudgetSnapshot(now)],
    ['backfill', () => backfillProfiles()],
  ];
}

// ── redis-state memory (design §3.6) ──────────────────────────────────────

export interface RedisMemorySample {
  usedBytes: number;
  maxBytes: number | null;
  usedPct: number | null;
  at: string;
}

let lastMemory: RedisMemorySample | undefined;
let memoryAlertAt: number | undefined;

export function lastRedisMemorySample(): RedisMemorySample | undefined {
  return lastMemory;
}

/** Parse `INFO memory` (pure). */
export function parseRedisMemoryInfo(info: string, now = Date.now()): RedisMemorySample | undefined {
  const field = (name: string): number | undefined => {
    const m = new RegExp(`^${name}:(\\d+)\\s*$`, 'm').exec(info);
    return m ? Number(m[1]) : undefined;
  };
  const used = field('used_memory');
  if (used === undefined) return undefined;
  const max = field('maxmemory');
  const maxBytes = max && max > 0 ? max : null;
  return {
    usedBytes: used,
    maxBytes,
    usedPct: maxBytes ? Math.round((used / maxBytes) * 1000) / 10 : null,
    at: new Date(now).toISOString(),
  };
}

/** One sample (scheduler holder, every 60 s). Never throws. */
export async function sampleRedisMemory(
  client: Pick<Redis, 'info'>,
  logger: Pick<Logger, 'warn'> = new Logger('RedisStateMemory'),
  now = Date.now(),
): Promise<RedisMemorySample | undefined> {
  try {
    const sample = parseRedisMemoryInfo(String(await client.info('memory')), now);
    if (!sample) return undefined;
    lastMemory = sample;
    if (
      sample.usedPct !== null &&
      sample.usedPct >= REDIS_MEMORY_ALERT_PCT &&
      (memoryAlertAt === undefined || now - memoryAlertAt >= ALERT_EVERY_MS)
    ) {
      memoryAlertAt = now;
      logger.warn(
        `[alert] redis_state.memory usedPct=${sample.usedPct} used=${sample.usedBytes} max=${sample.maxBytes} — ` +
          'redis-state is noeviction: at 100 % every write fails (BullMQ, leases, budgets). Inspect BullMQ retention first.',
      );
    }
    return sample;
  } catch {
    return undefined;
  }
}

/** Specs only. */
export function resetProcessStatusForTests(): void {
  lastMemory = undefined;
  memoryAlertAt = undefined;
  contributors.clear();
}

// ── fleet view ────────────────────────────────────────────────────────────

export interface ProcessStatusRecord {
  key: string;
  role: string;
  host: string;
  pid: number;
  startedAt: string;
  publishedAt: string;
  leases: { enabled: boolean; held: Array<{ name: string; fence: number | null; acquiredAt: string | null }> };
  runtime: { rssMb: number; heapUsedMb: number; uptimeSec: number };
  [extra: string]: unknown;
}

/** Fleet decisions from one read of the index (pure, for specs). */
export function fleetRoles(records: Array<Pick<ProcessStatusRecord, 'role'>>): { all: boolean; split: boolean; mixed: boolean } {
  const all = records.some((r) => r.role === 'all');
  const split = records.some((r) => r.role !== 'all');
  return { all, split, mixed: all && split };
}

interface StatusConfigView {
  processStatusPublishMs?: number;
  positionFeeRefreshEnabled?: boolean;
}

@Injectable()
export class ProcessStatusService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProcessStatusService.name);
  private readonly startedAt = Date.now();
  private readonly host = hostname();
  private timer?: ReturnType<typeof setInterval>;
  private publishing = false;
  /** The publish in flight (a withdraw waits for it, or its SET would re-create the record). */
  private inflight?: Promise<void>;
  /** Set by `onModuleDestroy`: no publish starts after it. */
  private stopped = false;
  private readonly absentSince = new Map<string, number>();
  private mixedSince: number | undefined;
  private readonly alertedAt = new Map<string, number>();
  private ownCoordination?: CoordinationRedis;

  constructor(
    @Optional() @Inject(AppConfigService) private readonly config?: AppConfigService,
    @Optional() @Inject(CoordinationRedis) private readonly coordination?: CoordinationRedis,
  ) {}

  /** `PROCESS_STATUS_PUBLISH_MS`; unset → 10 000 with leases on (`all` too), else the role default (0 in `all`). */
  get publishMs(): number {
    const raw = (this.config as unknown as StatusConfigView | undefined)?.processStatusPublishMs;
    const configured = raw === undefined || raw === null ? NaN : Number(raw);
    if (Number.isFinite(configured) && configured >= 0) return configured;
    return statusPublishMsDefault();
  }

  private coord(): CoordinationRedis {
    if (this.coordination) return this.coordination;
    this.ownCoordination ??= new CoordinationRedis(this.config);
    return this.ownCoordination;
  }

  /** Non-blocking: never awaits Redis in the boot path. */
  onModuleInit(): void {
    const ms = this.publishMs;
    if (ms <= 0) return;
    this.timer = setInterval(() => void this.tick(), Math.max(1_000, ms));
    this.timer.unref?.();
    void this.tick();
  }

  async onModuleDestroy(): Promise<void> {
    const published = this.timer !== undefined;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    // The shared coordination client closes in onApplicationShutdown, after
    // every destroy hook, so it is still up here.
    if (published) await this.withdraw();
    await this.ownCoordination?.close().catch(() => undefined);
  }

  /**
   * Graceful exit: DEL this process's record and ZREM it from the index, after
   * the publish in flight. Bounded (`STATUS_WITHDRAW_MS`) and never throws —
   * a withdraw that cannot run leaves the record to its 30 s TTL, as before.
   */
  async withdraw(): Promise<void> {
    const work = (async () => {
      await this.inflight?.catch(() => undefined);
      const client = await this.coord().client();
      if (!client) return;
      const ns = this.coord().namespace;
      const key = statusKey(ns, currentProcessRole(), this.host, process.pid);
      await client.multi().del(key).zrem(statusIndexKey(ns), key).exec();
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, STATUS_WITHDRAW_MS);
      timer.unref?.();
    });
    try {
      await Promise.race([work.catch(() => undefined), deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** This process's record. */
  record(now = Date.now()): ProcessStatusRecord {
    const role: ProcessRole = currentProcessRole();
    const mem = process.memoryUsage();
    const out: ProcessStatusRecord = {
      key: statusKey(this.coord().namespace, role, this.host, process.pid),
      role,
      host: this.host,
      pid: process.pid,
      startedAt: new Date(this.startedAt).toISOString(),
      publishedAt: new Date(now).toISOString(),
      leases: {
        enabled: leasesEnabled(),
        held: activeLeaseRunners()
          .filter((r) => r.held)
          .map((r) => ({ name: r.name, fence: r.fence ?? null, acquiredAt: r.status().acquiredAt })),
      },
      runtime: {
        rssMb: Math.round(mem.rss / 1_048_576),
        heapUsedMb: Math.round(mem.heapUsed / 1_048_576),
        uptimeSec: Math.round((now - this.startedAt) / 1000),
      },
    };
    for (const [name, fn] of builtInBlocks(now)) {
      try {
        const value = fn();
        if (Array.isArray(value) && value.length > 0) out[name] = value;
      } catch {
        // A block must never break the status line.
      }
    }
    for (const [name, fn] of contributors) {
      if (name in out) continue; // never overwrite a built-in field
      try {
        out[name] = fn();
      } catch {
        // A contributor must never break the status line.
      }
    }
    return out;
  }

  /** One publish + fleet check. Never throws. */
  async tick(now = Date.now()): Promise<void> {
    if (this.publishing || this.stopped) return;
    this.publishing = true;
    const run = this.publish(now);
    this.inflight = run;
    await run;
  }

  private async publish(now: number): Promise<void> {
    try {
      const client = await this.coord().client();
      if (!client) return;
      const ns = this.coord().namespace;
      const rec = this.record(now);
      await client
        .multi()
        .set(rec.key, JSON.stringify(rec), 'EX', STATUS_KEY_TTL_SEC)
        .zadd(statusIndexKey(ns), now, rec.key)
        .zremrangebyscore(statusIndexKey(ns), '-inf', now - STATUS_INDEX_WINDOW_MS)
        .expire(statusIndexKey(ns), STATUS_INDEX_TTL_SEC)
        .exec();
      if (leasesEnabled()) await this.checkFleet(client, ns, now);
    } catch (err) {
      this.logger.debug?.(`status publish failed: ${(err as Error)?.message ?? String(err)}`);
    } finally {
      this.publishing = false;
    }
  }

  /** Every live process's record (ZSET index window, then MGET). */
  async readFleet(now = Date.now()): Promise<ProcessStatusRecord[]> {
    const client = await this.coord().client();
    if (!client) return [];
    try {
      return await readFleetFrom(client, this.coord().namespace, now);
    } catch {
      return [];
    }
  }

  private alert(key: string, line: string, now: number): void {
    const last = this.alertedAt.get(key);
    if (last !== undefined && now - last < ALERT_EVERY_MS) return;
    this.alertedAt.set(key, now);
    this.logger.warn(line);
  }

  private async checkFleet(client: Redis, ns: string, now: number): Promise<void> {
    const watched: Array<{ lease: string; alert: string; when: boolean }> = [
      { lease: 'scheduler', alert: 'process_role.no_scheduler', when: true },
      {
        lease: 'fee-worker',
        alert: 'fees.no_worker',
        when: (this.config as unknown as StatusConfigView | undefined)?.positionFeeRefreshEnabled === true,
      },
    ];
    for (const w of watched) {
      if (!w.when) continue;
      const present = Number(await client.exists(leaseKey(ns, w.lease))) > 0;
      if (present) {
        this.absentSince.delete(w.lease);
        continue;
      }
      const since = this.absentSince.get(w.lease) ?? now;
      this.absentSince.set(w.lease, since);
      if (now - since > LEASE_ABSENT_ALERT_MS) {
        this.alert(w.alert, `[alert] ${w.alert} lease=${w.lease} absentFor=${Math.round((now - since) / 1000)}s — no process holds it`, now);
      }
    }
    const fleet = fleetRoles(await readFleetFrom(client, ns, now));
    if (!fleet.mixed) {
      this.mixedSince = undefined;
      return;
    }
    this.mixedSince ??= now;
    if (now - this.mixedSince > MIXED_ALERT_MS) {
      this.alert(
        'process_role.mixed',
        `[alert] process_role.mixed for ${Math.round((now - this.mixedSince) / 60_000)} min — an \`all\` process runs beside split roles (expected only during rollout step 5)`,
        now,
      );
    }
  }
}

export async function readFleetFrom(
  client: Pick<Redis, 'zrangebyscore' | 'mget'>,
  namespace: string,
  now = Date.now(),
): Promise<ProcessStatusRecord[]> {
  const keys = (await client.zrangebyscore(statusIndexKey(namespace), now - STATUS_INDEX_WINDOW_MS, '+inf')) as string[];
  if (keys.length === 0) return [];
  const values = (await client.mget(...keys)) as Array<string | null>;
  const out: ProcessStatusRecord[] = [];
  for (const v of values) {
    if (!v) continue;
    try {
      out.push(JSON.parse(v) as ProcessStatusRecord);
    } catch {
      // A malformed record is skipped.
    }
  }
  return out;
}
