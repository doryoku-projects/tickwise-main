import { createHash } from 'node:crypto';
import { can, currentProcessRole, leasesEnabled } from '../common/process-role.js';
import { CoordinationRedis } from '../common/coordination-redis.js';
import { LeaderLoop } from '../common/leader-loop.js';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import {
  Inject,
  Injectable,
  Logger,
  Optional,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { AppConfigService } from '../config/app-config.service.js';
import { PositionsRepository, type LeaderboardQuery } from '../database/positions.repository.js';
import type { Position } from '../database/schemas/position.schema.js';
import { RankEngineService } from '../read-models/rank/rank-engine.service.js';
import { LeaderboardCountService } from './count-cache.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/**
 * The warm cycle's tick (`LEADERBOARD_WARMUP_INTERVAL_MS`, default 10 s) and
 * the age at which it re-reads a window (`LEADERBOARD_WARMUP_MIN_AGE_MS`,
 * default = the list fresh age, 15 s). Windows are fresh 15 s and served stale
 * only up to 30 s (27 at the shortest jitter) — the staleness budget — so a
 * landing window is re-read at 15–25 s of age (the first tick past 15 s), never
 * expires, and is never re-read while still fresh: at 10 s every window was
 * read again on every other tick while still fresh, twice the secondary work
 * (measured on m10-3: ~0.9 s of secondary time per cycle for the 32 windows,
 * 414 ms of it one 4663 nft_id_asc window) for the same ≤ 45 s guarantee. A
 * window a user's request just refreshed is not read again. A cycle still
 * running when the next is due is skipped.
 */
const DEFAULT_WARMUP_INTERVAL_MS = 10_000;
const DEFAULT_WARMUP_MIN_AGE_MS = 15_000;
/**
 * A cycle starts no new read after this long; the windows it did not reach
 * (the oldest go first) are next cycle's. Before the Set R indexes one ranked
 * read takes 6–15 s, and 32 of them back to back would keep a heavy query
 * running on the secondaries around the clock.
 */
const WARMUP_CYCLE_BUDGET_MS = 30_000;
/** With no user leaderboard read for this long, only the default sort is kept warm. */
const WARMUP_IDLE_MS = 10 * 60_000;
/** The dashboard's default sort — the view a first visitor lands on. */
const DEFAULT_LANDING_SORT = 'apr';
/**
 * A warmup read is not a request: nobody is waiting on it, so it gets a longer
 * server-side budget than a page (5 s). That is what lets the landing views fill
 * on a shard whose ranked query is still slower than the page budget — until
 * the Set R indexes ship — so users are served from cache instead of a 503.
 * Reads run one at a time, which bounds what this costs the database.
 */
const WARMUP_FIND_MAX_TIME_MS = 15_000;

const SNAPSHOT_KEY_PREFIX = 'tw:lb:snap:v1:';
/**
 * Leases on only (capacity plan step 1) — the warm cycle runs on ONE process
 * (the `leaderboard-warmup` lease holder) and every other replica loads the
 * windows it writes:
 *  - `tw:lb:snapidx:v1:<ns>` HASH sha1(window key) → the snapshot's storedAt
 *    (PX = the snapshot TTL), written beside each snapshot, so a follower asks
 *    ONE cheap HGETALL every `FOLLOW_INTERVAL_MS` and GETs only the snapshots
 *    newer than the window it holds;
 *  - `tw:lb:warm:v1:<ns>:leader` JSON {v:1, at} — the holder's heartbeat (at the
 *    start and end of each cycle). A follower that sees none fresher than
 *    `heartbeatStaleMs` (or cannot reach Redis) runs the cycle itself, exactly
 *    as with leases off;
 *  - `tw:lb:warm:v1:<ns>:lastread` — the newest user leaderboard read on any
 *    follower (epoch ms), so the holder's idle rule ("no user read for 10 min →
 *    default sort only") sees the whole fleet's traffic, not its own share.
 * With leases off none of these keys is written (today: `tw:lb:snap` only).
 */
const SNAPSHOT_INDEX_PREFIX = 'tw:lb:snapidx:v1:';
const WARM_KEY_PREFIX = 'tw:lb:warm:v1:';
export const LEADERBOARD_WARMUP_LEASE = 'leaderboard-warmup';
/**
 * A follower checks the index this often. Windows are fresh 15 s and stale 30 s
 * (27 s at the shortest jitter); the holder's cycle runs at a fixed rate
 * (`LeaderLoop`) and re-reads a window this much (plus its last cycle's
 * duration) EARLIER than `LEADERBOARD_WARMUP_MIN_AGE_MS` (`dueAgeMs`), so the
 * pickup delay is budgeted for and a follower's copy stays servable.
 */
const FOLLOW_INTERVAL_MS = 2_000;
/** A snapshot larger than this (gzipped) is not written. */
const SNAPSHOT_MAX_BYTES = 256 * 1024;

/**
 * The positions dashboard's landing filters, per sort. MUST mirror
 * `listParams` in `frontend/src/components/PositionsDashboard.tsx` (All chains,
 * status active, in range, $500 minimum value, $1000 minimum pool TVL, risky
 * HIDDEN since 2026-10-06 — the toggle's default flipped to off, 25 rows): the
 * cache key is derived from the query that runs, so a drifted default simply
 * warms a view nobody asks for.
 */
const LANDING_SORTS = [
  'apr',
  'fee_apr',
  'roi',
  'age',
  'pnl',
  'underlying_value',
  'nft_id_asc',
  'nft_id_desc',
] as const;
const LANDING_FILTERS = {
  page: 1,
  limit: 25,
  activeOnly: true,
  status: 'active',
  range: 'in',
  minValueUsd: 500,
  minPoolTvl: 1000,
  includeRisky: false,
} as const;

/**
 * A no-read peek of the cached window a landing query lives in (its key, rows,
 * total and when it was stored). `PositionsRepository.peekLeaderboardWindow`;
 * read optionally so this service builds — and behaves as before — on a
 * repository that does not expose it.
 */
interface CachedWindowSource {
  peekLeaderboardWindow?(
    query: LeaderboardQuery,
  ): Promise<{ key: string; rows: Position[]; total?: number; storedAt: number } | undefined>;
}

/**
 * A follower's partial cycle: only these shards. Their default sort is skipped
 * by the age check alone when the holder's snapshot of it was loaded, and read
 * here when it was not.
 */
interface CycleScope {
  shards: ReadonlySet<string>;
}

interface Snapshot {
  v: 1;
  /** `AppConfigService.leaderboardSnapshotNamespace` of the writer. */
  ns: string;
  key: string;
  storedAt: number;
  rows: Position[];
  total?: number;
}

/**
 * Keeps the dashboard's landing views warm: every 10 s it refreshes the
 * leaderboard windows for the landing filters × 8 sorts × every enabled shard
 * that are getting old (see `runCycle`), and starts the matching counts. A plain timer on purpose — NOT the 10-slot
 * `positions-sync` BullMQ queue, where it would wait behind sync jobs.
 *
 * Optionally mirrors each window into Redis
 * (`tw:lb:snap:v1:<deployment>:<sha1(key)>`, gzip, EX = the staleness budget,
 * 45 s — a hard TTL, like every L2 entry; it was 300) through its OWN
 * lazily-connected client, and loads them back at boot so the landing page is
 * warm right after a deploy. `<deployment>` is NODE_ENV + the Mongo hosts and
 * database the rows came from, hashed, and is checked again on load: the
 * window key itself is identical in every environment, so without it a dev
 * backend pointed at the production Redis would have its fixture rows served
 * to customers as `X-Cache: hit` after the next deploy. Every Redis failure is
 * swallowed: the snapshot is an accelerator, never a dependency. Chart and
 * transaction payloads never go into this Redis — it is the BullMQ instance and
 * runs `noeviction`.
 *
 * Gated by `LEADERBOARD_WARMUP_ENABLED`; a process that serves no HTTP traffic
 * should run with it off.
 */
@Injectable()
export class LeaderboardWarmupService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(LeaderboardWarmupService.name);
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private redis?: Redis;
  private redisErrorLoggedAt = 0;
  /** Leases on + snapshots on: the `leaderboard-warmup` lease. Undefined otherwise (today). */
  private leader?: LeaderLoop;
  /** The newest user read on any follower, as last read by the holder (0 with leases off). */
  private fleetLastReadAt = 0;
  /** The last user-read time this follower published (it publishes only when it moves). */
  private publishedLastReadAt = 0;
  /** When this follower last ran its own cycle for want of a holder. */
  private lastFallbackAt = 0;
  /** When this follower last warmed the shards the holder reduces but its own engine does not serve. */
  private lastCoverAt = 0;
  /**
   * Leases on: the storedAt of the last snapshot this process wrote per window
   * key, so a window a request refreshed here (newer than its snapshot) is
   * snapshotted from the cache, and an unchanged one is not written again.
   */
  private readonly snapshotWrittenAt = new Map<string, number>();
  /**
   * The shards (`<chainId>:<protocol>`) the last cycle kept at the rank
   * engine's REDUCED cycle (default sort only). Published in the holder's
   * heartbeat so a follower whose own engine does not serve one of them warms
   * its other sorts itself (the reduced decision is per process).
   */
  private reducedShards: string[] = [];
  /** How long the last FULL cycle ran (leases on: it moves the re-read age earlier, `dueAgeMs`). */
  private lastCycleMs = 0;

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(PositionsRepository) private readonly positions: PositionsRepository,
    @Inject(LeaderboardCountService) private readonly counts: LeaderboardCountService,
    /**
     * The positions rank engine (P-R R3), APPENDED and optional: while it
     * answers every request of a shard (`serve`, 100%, servable) the warmup
     * keeps only its REDUCED cycle there — the default sort's landing window
     * (+ its snapshot) — so the Mongo fallback is never colder than P1 but the
     * secondaries are not read for windows nobody is served from (design §3.8).
     */
    @Optional() @Inject(RankEngineService) private readonly rank?: RankEngineService,
    /**
     * APPENDED and optional: the coordination client (global module). Read only
     * when leases are on AND snapshots are mirrored to Redis — without a shared
     * snapshot there is nothing a follower could load, so every replica warms
     * (today).
     */
    @Optional() @Inject(CoordinationRedis) private readonly coordination?: CoordinationRedis,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.leaderboardWarmupEnabled) {
      this.logger.log('Leaderboard warmup disabled (LEADERBOARD_WARMUP_ENABLED=false)');
      return;
    }
    // P2.1: only the roles that serve lists warm them (all, api). A worker role
    // serves no list, so its warmup would only read the secondaries for nobody.
    if (!can('leaderboard-warmup')) {
      this.logger.log(`Leaderboard warmup not started: role ${currentProcessRole()} serves no lists`);
      return;
    }
    if (this.config.leaderboardSnapshotRedisEnabled) {
      this.redis = new Redis(this.config.redisUrl, {
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
        connectTimeout: 2_000,
        commandTimeout: 1_000,
        retryStrategy: (times) => Math.min(times * 1_000, 30_000),
      });
      this.redis.on('error', (err) => this.logRedisError(err));
    }
    if (this.redis && leasesEnabled() && this.coordination) {
      // Leases on: ONE process runs the cycle (and writes the snapshots); the
      // others load them. Boot still loads whatever snapshots exist first.
      this.leader = new LeaderLoop({
        name: LEADERBOARD_WARMUP_LEASE,
        coordination: this.coordination,
        intervalMs: this.config.leaderboardWarmupIntervalMs ?? DEFAULT_WARMUP_INTERVAL_MS,
        lead: () => this.leadCycle(),
        follow: () => this.followCycle(),
        followIntervalMs: FOLLOW_INTERVAL_MS,
        logger: this.logger,
      });
      this.leader.start();
      void this.loadSnapshots();
      return;
    }
    this.timer = setInterval(
      () => void this.runCycle(),
      this.config.leaderboardWarmupIntervalMs ?? DEFAULT_WARMUP_INTERVAL_MS,
    );
    this.timer.unref?.();
    // Not awaited: boot must not wait on Redis or Mongo. Snapshots first, so a
    // request arriving right after the deploy finds them.
    void (async () => {
      await this.loadSnapshots();
      await this.runCycle();
    })();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    void this.leader?.stop();
    void this.redis?.quit().catch(() => undefined);
  }

  /** The landing queries, per enabled shard and sort. */
  landingQueries(): LeaderboardQuery[] {
    const out: LeaderboardQuery[] = [];
    for (const integration of this.config.enabledIntegrations) {
      for (const sort of LANDING_SORTS) {
        out.push({ ...LANDING_FILTERS, chainId: integration.chainId, protocol: integration.protocol, sort });
      }
    }
    return out;
  }

  /**
   * One warm pass. Single-flight: overlapping ticks are skipped, not queued.
   *
   * Reads only what needs it: windows at least `LEADERBOARD_WARMUP_MIN_AGE_MS` old (or not
   * cached), oldest first, until `WARMUP_CYCLE_BUDGET_MS` has gone by — and
   * while nobody is browsing (no user read for `WARMUP_IDLE_MS`, which includes
   * a process that has just booted) only the default sort's windows.
   */
  async runCycle(scope?: CycleScope): Promise<{ warmed: number; failed: number; deferred?: number } | null> {
    if (this.running) return null;
    this.running = true;
    const startedAt = Date.now();
    let warmed = 0;
    let failed = 0;
    let deferred = 0;
    let fromCache = 0;
    try {
      // `fleetLastReadAt` is 0 with leases off: today's per-process rule.
      const lastReadAt = Math.max(this.positions.lastLeaderboardReadAt, this.fleetLastReadAt);
      const idle = startedAt - lastReadAt > WARMUP_IDLE_MS;
      const dueAge = this.dueAgeMs;
      const due: Array<{ query: LeaderboardQuery; age: number }> = [];
      // Leases on, full cycle: the windows not due are snapshotted from the cache
      // when a request here refreshed them after their last snapshot. Without it
      // a window this process's own traffic keeps fresh is never re-read, so no
      // snapshot is written and every follower's copy expires (27–33 s) — the
      // first-visitor read the warmup exists to prevent. Leases off: never.
      const snapshotCached = this.leader !== undefined && !scope;
      const notDue: LeaderboardQuery[] = [];
      const reducedShards = new Set<string>();
      let reduced = false;
      for (const query of this.landingQueries()) {
        const shard = shardKey(query.chainId, query.protocol);
        if (scope && !scope.shards.has(shard)) continue;
        // In serve the rank engine answers this shard: only the default sort is
        // kept warm for the fallback (full cycle again the moment it is degraded,
        // killed, or ramped below 100%).
        const engineServes = this.rank?.warmupReduced([query.chainId], query.protocol) ?? false;
        if (engineServes) {
          reduced = true;
          reducedShards.add(shard);
        }
        if ((idle || engineServes) && query.sort !== DEFAULT_LANDING_SORT) continue;
        const age = (await this.positions.leaderboardWindowAgeMs(query)) ?? Number.POSITIVE_INFINITY;
        if (age >= dueAge) due.push({ query, age });
        else if (snapshotCached) notDue.push(query);
      }
      // Published only by the holder (whose cycles are never scoped); on a
      // follower it is read back only by its first beat after a takeover.
      this.reducedShards = [...reducedShards].sort();
      for (const query of notDue) {
        if (await this.snapshotCachedWindow(query)) fromCache++;
      }
      due.sort((a, b) => b.age - a.age);
      const countKeys = new Set<string>();
      for (const [index, { query }] of due.entries()) {
        if (Date.now() - startedAt >= WARMUP_CYCLE_BUDGET_MS) {
          deferred = due.length - index;
          break;
        }
        try {
          const window = await this.positions.warmLeaderboardWindow(query, WARMUP_FIND_MAX_TIME_MS);
          if (!window) continue;
          warmed++;
          await this.writeSnapshot(window.key, window.rows, window.total);
          // Counts depend on the filter, not the sort: start each distinct one
          // once (it runs in the background on the count service's slots).
          const plan = await this.positions.leaderboardPlan(query);
          if (!countKeys.has(plan.countKey)) {
            countKeys.add(plan.countKey);
            const cap = this.config.leaderboardCountCap;
            this.counts.peek(plan.countKey, () => this.positions.countLeaderboard(plan, cap));
          }
        } catch (err) {
          failed++;
          this.logger.warn(
            `Leaderboard warmup chain=${query.chainId} sort=${query.sort} failed: ${(err as Error)?.message ?? err}`,
          );
        }
      }
      this.logger.log(
        `Leaderboard warmup: ${warmed} windows warmed, ${failed} failed` +
          `${deferred > 0 ? `, ${deferred} deferred to the next cycle` : ''}${idle ? ' (idle: default sort only)' : ''}` +
          `${reduced ? ' (rank engine serving: default sort only there)' : ''}` +
          `${fromCache > 0 ? `, ${fromCache} snapshotted from cache` : ''}` +
          `${scope ? ' (shards the holder reduces)' : ''} ` +
          `in ${Date.now() - startedAt}ms`,
      );
      if (!scope) this.lastCycleMs = Date.now() - startedAt;
      return deferred > 0 ? { warmed, failed, deferred } : { warmed, failed };
    } finally {
      this.running = false;
    }
  }

  /** Leader (leases on): heartbeat, fleet-wide idle input, one warm cycle, heartbeat. */
  private async leadCycle(): Promise<void> {
    await this.writeHeartbeat();
    this.fleetLastReadAt = await this.readFleetLastRead();
    await this.runCycle();
    await this.writeHeartbeat();
  }

  /**
   * Follower (leases on): publish this replica's newest user read, then load
   * the holder's newer snapshots — or, with no fresh heartbeat (no holder, a
   * stuck holder) or no Redis, run the cycle locally exactly as with leases off.
   */
  async followCycle(): Promise<void> {
    const redis = await this.connectedRedis();
    if (!redis) {
      await this.fallbackCycle();
      return;
    }
    await this.publishLastRead(redis);
    const beat = await this.liveHeartbeat(redis);
    if (!beat) {
      await this.fallbackCycle();
      return;
    }
    await this.loadNewerSnapshots(redis);
    await this.coverReducedShards(beat.reduced);
  }

  /**
   * The holder keeps a shard at the reduced cycle (default sort only) when ITS
   * rank engine serves that shard — a per-process decision (readiness,
   * quarantine, refusals). A follower whose own engine does not serve it falls
   * back to Mongo for every sort there, so it warms that shard's other sorts
   * itself, at the cycle period, under the fleet-wide idle rule. Nothing to do
   * while the holder reduces no shard (rank off / shadow: today).
   */
  private async coverReducedShards(holderReduced: readonly string[]): Promise<void> {
    const mine = new Set<string>();
    for (const shard of holderReduced) {
      const parsed = parseShardKey(shard);
      if (!parsed) continue;
      if (!(this.rank?.warmupReduced([parsed.chainId], parsed.protocol) ?? false)) mine.add(shard);
    }
    if (mine.size === 0) return;
    const interval = this.config.leaderboardWarmupIntervalMs ?? DEFAULT_WARMUP_INTERVAL_MS;
    if (Date.now() - this.lastCoverAt < interval) return;
    this.lastCoverAt = Date.now();
    this.fleetLastReadAt = await this.readFleetLastRead();
    await this.runCycle({ shards: mine });
  }

  /**
   * Snapshot one landing window from the cache, without a read, when it was
   * stored after the last snapshot this process wrote for it (a request here
   * refreshed it). The snapshot keeps the window's own storedAt, so a follower
   * ages it from when its rows were read, never from now.
   */
  private async snapshotCachedWindow(query: LeaderboardQuery): Promise<boolean> {
    const source = this.positions as PositionsRepository & CachedWindowSource;
    if (typeof source.peekLeaderboardWindow !== 'function') return false;
    try {
      const window = await source.peekLeaderboardWindow(query);
      if (!window || window.storedAt <= (this.snapshotWrittenAt.get(window.key) ?? 0)) return false;
      return await this.writeSnapshot(window.key, window.rows, window.total, window.storedAt);
    } catch {
      return false; // an accelerator: the next cycle tries again
    }
  }

  /** The local cycle a follower runs without a live holder — at today's period, not every follower tick. */
  private async fallbackCycle(): Promise<void> {
    const interval = this.config.leaderboardWarmupIntervalMs ?? DEFAULT_WARMUP_INTERVAL_MS;
    if (Date.now() - this.lastFallbackAt < interval) return;
    this.lastFallbackAt = Date.now();
    await this.runCycle();
  }

  /** A follower falls back to its own cycle once the holder's heartbeat is older than this. */
  private get heartbeatStaleMs(): number {
    const interval = this.config.leaderboardWarmupIntervalMs ?? DEFAULT_WARMUP_INTERVAL_MS;
    // A cycle may run WARMUP_CYCLE_BUDGET_MS plus one read in flight between two beats.
    return 3 * interval + WARMUP_CYCLE_BUDGET_MS + WARMUP_FIND_MAX_TIME_MS;
  }

  private async writeHeartbeat(): Promise<void> {
    const redis = await this.connectedRedis();
    if (!redis) return;
    try {
      await redis.set(
        warmKey(this.namespace(), 'leader'),
        JSON.stringify({ v: 1, at: Date.now(), reduced: this.reducedShards }),
        'PX',
        this.heartbeatStaleMs + 10_000,
      );
    } catch (err) {
      this.logRedisError(err);
    }
  }

  /** The holder's heartbeat when it is fresh; undefined = no live holder. A beat without `reduced` reduces nothing. */
  private async liveHeartbeat(redis: Redis): Promise<{ reduced: string[] } | undefined> {
    try {
      const raw = await redis.get(warmKey(this.namespace(), 'leader'));
      if (!raw) return undefined;
      const beat = JSON.parse(raw) as { v?: unknown; at?: unknown; reduced?: unknown };
      if (beat?.v !== 1 || typeof beat.at !== 'number' || Date.now() - beat.at > this.heartbeatStaleMs) {
        return undefined;
      }
      const reduced = Array.isArray(beat.reduced) ? beat.reduced.filter((s): s is string => typeof s === 'string') : [];
      return { reduced };
    } catch (err) {
      this.logRedisError(err);
      return undefined;
    }
  }

  private async readFleetLastRead(): Promise<number> {
    const redis = await this.connectedRedis();
    if (!redis) return 0;
    try {
      const at = Number(await redis.get(warmKey(this.namespace(), 'lastread')));
      return Number.isFinite(at) && at > 0 ? at : 0;
    } catch (err) {
      this.logRedisError(err);
      return 0;
    }
  }

  /** One SET when this replica's newest user read moved (never more than one per follower tick). */
  private async publishLastRead(redis: Redis): Promise<void> {
    const at = this.positions.lastLeaderboardReadAt;
    if (!(at > this.publishedLastReadAt)) return;
    try {
      // Kept a little past the idle window: older than that, it changes nothing.
      await redis.set(warmKey(this.namespace(), 'lastread'), String(at), 'PX', WARMUP_IDLE_MS + 60_000);
      this.publishedLastReadAt = at;
    } catch (err) {
      this.logRedisError(err);
    }
  }

  /**
   * Prime every landing window whose indexed snapshot is NEWER than the window
   * this process holds (a window a request here refreshed more recently is
   * kept). One HGETALL; one GET per window actually newer.
   */
  private async loadNewerSnapshots(redis: Redis): Promise<number> {
    let index: Record<string, string>;
    try {
      index = (await redis.hgetall(snapshotIndexKey(this.namespace()))) ?? {};
    } catch (err) {
      this.logRedisError(err);
      return 0;
    }
    let loaded = 0;
    for (const query of this.landingQueries()) {
      try {
        const key = await this.positions.leaderboardWindowKey(query);
        if (!key) continue;
        const remoteAt = Number(index[windowKeyHash(key)]);
        if (!Number.isFinite(remoteAt) || remoteAt <= 0) continue;
        // Index entries are never removed (the hash's TTL moves with every
        // write), so one for a window the holder no longer warms (idle, reduced)
        // outlives its snapshot (EX = the TTL): skip it instead of a GET of an
        // expired key on every 2 s tick.
        if (Date.now() - remoteAt > this.snapshotTtlSeconds * 1000) continue;
        const age = await this.positions.leaderboardWindowAgeMs(query);
        const localAt = age === undefined ? Number.NEGATIVE_INFINITY : Date.now() - age;
        if (remoteAt <= localAt) continue;
        if (await this.primeFromSnapshot(redis, key)) loaded++;
      } catch (err) {
        this.logRedisError(err);
      }
    }
    return loaded;
  }

  /** GET + validate + prime one window's snapshot (the same checks as the boot load). */
  private async primeFromSnapshot(redis: Redis, key: string): Promise<boolean> {
    const raw = await redis.getBuffer(snapshotRedisKey(this.namespace(), key));
    if (!raw) return false;
    const snapshot = JSON.parse((await gunzipAsync(raw)).toString('utf8')) as Snapshot;
    if (snapshot?.v !== 1 || snapshot.ns !== this.namespace() || snapshot.key !== key || !Array.isArray(snapshot.rows)) {
      return false;
    }
    return this.positions.primeLeaderboardWindow(key, snapshot.rows, snapshot.storedAt, snapshot.total);
  }

  /** Re-read a window once it is this old (`LEADERBOARD_WARMUP_MIN_AGE_MS`). */
  private get minAgeMs(): number {
    return this.config.leaderboardWarmupMinAgeMs ?? DEFAULT_WARMUP_MIN_AGE_MS;
  }

  /**
   * The age at which this cycle re-reads a window. Leases off: `minAgeMs`
   * (today). Leases on (the holder's snapshots serve the fleet): earlier by one
   * follower pickup (`FOLLOW_INTERVAL_MS`) and the last full cycle's duration,
   * so the fresh snapshot reaches the followers before their copy expires (27 s
   * at the shortest jitter) — a re-read at 15–25 s of age, plus the reads ahead
   * of it in the cycle, plus a 2 s pickup, left no margin. Never below the tick
   * period (nor above `minAgeMs`): a window the previous tick read is younger
   * than one tick, so it is never re-read on the very next one — no extra
   * secondary reads in steady state; only windows a request refreshed between
   * ticks (off the tick grid) move earlier.
   */
  private get dueAgeMs(): number {
    if (!this.leader) return this.minAgeMs;
    const interval = this.config.leaderboardWarmupIntervalMs ?? DEFAULT_WARMUP_INTERVAL_MS;
    const floor = Math.min(this.minAgeMs, interval);
    return Math.max(floor, this.minAgeMs - FOLLOW_INTERVAL_MS - this.lastCycleMs);
  }

  /** The snapshot EX, in seconds: the staleness budget. */
  private get snapshotTtlSeconds(): number {
    return Math.max(1, Math.ceil((this.config.readStalenessBudgetMs ?? 45_000) / 1000));
  }

  /** Seed the window cache from Redis snapshots written by any process within the staleness budget. */
  async loadSnapshots(): Promise<number> {
    const redis = await this.connectedRedis();
    if (!redis) return 0;
    let loaded = 0;
    for (const query of this.landingQueries()) {
      try {
        const key = await this.positions.leaderboardWindowKey(query);
        if (!key) continue;
        const raw = await redis.getBuffer(snapshotRedisKey(this.namespace(), key));
        if (!raw) continue;
        const snapshot = JSON.parse((await gunzipAsync(raw)).toString('utf8')) as Snapshot;
        if (
          snapshot?.v !== 1 ||
          snapshot.ns !== this.namespace() ||
          snapshot.key !== key ||
          !Array.isArray(snapshot.rows)
        ) {
          continue;
        }
        if (this.positions.primeLeaderboardWindow(key, snapshot.rows, snapshot.storedAt, snapshot.total)) loaded++;
      } catch (err) {
        this.logRedisError(err);
      }
    }
    if (loaded > 0) this.logger.log(`Leaderboard warmup: loaded ${loaded} window snapshots from Redis`);
    return loaded;
  }

  /** `storedAt`: when the rows were read (default now — a window just warmed). True once written. */
  private async writeSnapshot(key: string, rows: Position[], total?: number, storedAt = Date.now()): Promise<boolean> {
    const redis = await this.connectedRedis();
    if (!redis) return false;
    try {
      const snapshot: Snapshot = { v: 1, ns: this.namespace(), key, storedAt, rows, total };
      const body = await gzipAsync(Buffer.from(JSON.stringify(snapshot), 'utf8'));
      if (body.length > SNAPSHOT_MAX_BYTES) return false;
      await redis.set(snapshotRedisKey(this.namespace(), key), body, 'EX', this.snapshotTtlSeconds);
      if (this.leader) {
        // Leases on: index it, so followers fetch only what is newer than theirs.
        const index = snapshotIndexKey(this.namespace());
        await redis.hset(index, windowKeyHash(key), String(snapshot.storedAt));
        await redis.pexpire(index, this.snapshotTtlSeconds * 1000);
        this.snapshotWrittenAt.set(key, storedAt);
      }
      return true;
    } catch (err) {
      this.logRedisError(err);
      return false;
    }
  }

  /** The snapshot client once connected; undefined when disabled or unreachable (fail-open). */
  private async connectedRedis(): Promise<Redis | undefined> {
    const redis = this.redis;
    if (!redis) return undefined;
    if (redis.status === 'ready') return redis;
    if (redis.status === 'wait') {
      try {
        await redis.connect();
      } catch (err) {
        this.logRedisError(err);
      }
    }
    // Re-read: `connect()` moved the status on (TS narrowed it above).
    return (redis.status as string) === 'ready' ? redis : undefined;
  }

  private namespace(): string {
    return this.config.leaderboardSnapshotNamespace;
  }

  /** At most one line a minute: a Redis outage must not flood the log from here. */
  private logRedisError(err: unknown): void {
    const now = Date.now();
    if (now - this.redisErrorLoggedAt < 60_000) return;
    this.redisErrorLoggedAt = now;
    this.logger.warn(`Leaderboard snapshot Redis unavailable (ignored): ${(err as Error)?.message ?? String(err)}`);
  }
}

function snapshotRedisKey(namespace: string, windowKey: string): string {
  return `${SNAPSHOT_KEY_PREFIX}${namespace}:${createHash('sha1').update(windowKey).digest('hex')}`;
}

function windowKeyHash(windowKey: string): string {
  return createHash('sha1').update(windowKey).digest('hex');
}

function snapshotIndexKey(namespace: string): string {
  return `${SNAPSHOT_INDEX_PREFIX}${namespace}`;
}

function shardKey(chainId: number, protocol: string): string {
  return `${chainId}:${protocol}`;
}

function parseShardKey(shard: string): { chainId: number; protocol: string } | undefined {
  const at = shard.indexOf(':');
  if (at <= 0) return undefined;
  const chainId = Number(shard.slice(0, at));
  const protocol = shard.slice(at + 1);
  return Number.isInteger(chainId) && chainId > 0 && protocol ? { chainId, protocol } : undefined;
}

function warmKey(namespace: string, name: 'leader' | 'lastread'): string {
  return `${WARM_KEY_PREFIX}${namespace}:${name}`;
}
