import { Inject, Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { AppConfigService } from '../config/app-config.service.js';

/**
 * Replication lag, from the driver's OWN heartbeats — no extra query, no
 * privilege. Every `hello` reply a replica-set member sends the driver's
 * monitor carries `lastWrite.lastWriteDate`; a secondary's lag is how far its
 * last write trails the primary's, each measured against when its reply
 * arrived (the same arithmetic the driver uses for `maxStalenessSeconds`):
 *
 *   lag(S) = (S.receivedAt − S.lastWriteDate) − (P.receivedAt − P.lastWriteDate)
 *
 * User reads go `secondaryPreferred`, so this lag is added to the age of every
 * answer read from a secondary. The read path does not assume it is small:
 * `userReadLagMs()` is the worst lag of the secondaries a user read can be
 * routed to, every list cache stamps its entries with it (`SwrCache`'s
 * `dataLag` → `dataAt`), and an answer whose data is older than the
 * staleness budget once the lag is counted is served flagged `stale: true` +
 * `dataAsOf` (`staleSince`) instead of passing as fresh. Past
 * `MONGO_REPLICATION_LAG_ALERT_MS` (10 s) it logs
 * `[alert] mongo.replication_lag`, at most once a minute per member, and
 * `GET /admin/sync/status` shows the latest reading per member.
 */

interface MemberReading {
  role: 'primary' | 'secondary' | 'other';
  lastWriteMs: number;
  receivedAt: number;
  /**
   * PRIMARY only: `lastWrite.lastWriteDate − lastWrite.majorityWriteDate` of
   * its own reply — how far the majority-committed point trails its newest
   * write (both on the primary's clock). Undefined when the reply has no
   * majority date (a standalone, an old server).
   */
  majorityLagMs?: number;
  /**
   * SECONDARY only: a LOWER BOUND on its lag, for the write budget —
   * `P.lastWriteDate − S.lastWriteDate` against the newest primary reading
   * received at or before this reply. Sound because a primary's lastWrite
   * only moves forward: at `S.receivedAt` the primary had applied at least
   * `P.lastWriteDate`, so S trails it by at least this much. Unlike the
   * cross-heartbeat `maxStalenessSeconds` estimate above (an UPPER bound,
   * exact only while the primary writes continuously), it never reports a
   * caught-up secondary as behind when the primary is idle or bursty (the
   * no-op writer every 10 s + independently phased 10 s heartbeats put up
   * to ~10 s of phantom lag into that estimate). Undefined while no primary
   * reading precedes the reply.
   */
  writeLagFloorMs?: number;
}

const members = new Map<string, MemberReading>();
const alertedAt = new Map<string, number>();
const ALERT_EVERY_MS = 60_000;

/** One heartbeat reply (the parts this reads). */
export interface HeartbeatReply {
  isWritablePrimary?: boolean;
  ismaster?: boolean;
  secondary?: boolean;
  lastWrite?: { lastWriteDate?: Date | string | number; majorityWriteDate?: Date | string | number };
}

/** Record a heartbeat; returns the members now past `alertMs` (for the alert line). */
export function observeHeartbeat(
  address: string,
  reply: HeartbeatReply | undefined,
  receivedAt: number,
  alertMs: number,
): Array<{ member: string; lagMs: number }> {
  const raw = reply?.lastWrite?.lastWriteDate;
  const lastWriteMs = raw === undefined ? Number.NaN : new Date(raw).getTime();
  if (!Number.isFinite(lastWriteMs)) return [];
  const role = reply?.isWritablePrimary === true || reply?.ismaster === true ? 'primary' : reply?.secondary ? 'secondary' : 'other';
  const majorityRaw = reply?.lastWrite?.majorityWriteDate;
  const majorityMs = role === 'primary' && majorityRaw !== undefined ? new Date(majorityRaw).getTime() : Number.NaN;
  let floorMs: number | undefined;
  if (role === 'secondary') {
    let primary: MemberReading | undefined;
    for (const reading of members.values()) {
      if (reading.role !== 'primary' || reading.receivedAt > receivedAt) continue;
      if (!primary || reading.receivedAt > primary.receivedAt) primary = reading;
    }
    if (primary && receivedAt - primary.receivedAt <= READING_MAX_AGE_MS) floorMs = Math.max(0, Math.round(primary.lastWriteMs - lastWriteMs));
  }
  members.set(address, {
    role,
    lastWriteMs,
    receivedAt,
    ...(Number.isFinite(majorityMs) ? { majorityLagMs: Math.max(0, lastWriteMs - majorityMs) } : {}),
    ...(floorMs !== undefined ? { writeLagFloorMs: floorMs } : {}),
  });
  return replicationLagSnapshot()
    .members.filter((entry) => entry.lagMs !== null && entry.lagMs > alertMs)
    .map(({ member, lagMs }) => ({ member, lagMs: lagMs as number }));
}

/** The latest lag per secondary (null while no primary reading exists). */
export function replicationLagSnapshot(): { members: Array<{ member: string; role: string; lagMs: number | null }> } {
  const primary = [...members.values()].find((reading) => reading.role === 'primary');
  return {
    members: [...members].map(([member, reading]) => ({
      member,
      role: reading.role,
      lagMs:
        reading.role !== 'secondary' || !primary
          ? null
          : Math.max(
              0,
              Math.round(reading.receivedAt - reading.lastWriteMs - (primary.receivedAt - primary.lastWriteMs)),
            ),
    })),
  };
}

/** A member silent this long has stopped answering heartbeats: no read is routed to it. */
const READING_MAX_AGE_MS = 60_000;
/** `USER_READ_PREFERENCE`'s `maxStalenessSeconds`: a secondary further behind is never read. */
const USER_READ_MAX_STALENESS_MS = 120_000;

/**
 * The replication lag a USER read can carry: the worst lag among the
 * secondaries a `secondaryPreferred` read with `maxStalenessSeconds: 120` may
 * be routed to (heard from within the last minute, at most 120 s behind).
 * 0 when none is (the read then goes to the primary) or nothing is known yet.
 * Conservative by design — the driver may pick a better secondary — because
 * it decides whether an answer may pass as within the staleness budget.
 */
export function userReadLagMs(now: number = Date.now()): number {
  let worst = 0;
  for (const { member, lagMs } of replicationLagSnapshot().members) {
    const reading = members.get(member);
    if (lagMs === null || !reading || now - reading.receivedAt > READING_MAX_AGE_MS) continue;
    if (lagMs > USER_READ_MAX_STALENESS_MS) continue;
    worst = Math.max(worst, lagMs);
  }
  return worst;
}

/**
 * The write budget's lag input (P2.4, `write-budget-controller.ts`): the
 * worse of
 *  - MAJORITY lag — the current primary's own `lastWriteDate −
 *    majorityWriteDate` (exact: one reply, one clock; writes the majority has
 *    not yet applied — a write flood shows here first), and
 *  - the worst SECONDARY lag FLOOR heard within the last minute (any
 *    secondary, not only the ones a user read may use: a lagging secondary
 *    is load the writes caused) — `writeLagFloorMs`, a lower bound, NOT the
 *    read path's `replicationLagSnapshot()` upper-bound estimate. The red
 *    threshold (`WRITE_BUDGET_LAG_RED_MS`, 5 s) is far below that
 *    estimate's idle-primary error (heartbeat + idle-write period, the
 *    reason `maxStalenessSeconds` must be ≥ 90 s), so the estimate would
 *    halve R on every quiet stretch. The floor can under-read a lagging
 *    secondary by up to the heartbeat phase (≤ 10 s) while the primary
 *    writes continuously; the majority term stays exact meanwhile.
 * null while no fresh reading exists. Free: both come from the driver's
 * heartbeats.
 */
export function writeLagMs(now: number = Date.now()): { lagMs: number | null; majorityLagMs: number | null; secondaryLagMs: number | null } {
  let majority: number | null = null;
  for (const reading of members.values()) {
    // Only a PRIMARY's reply is ever stored with a majority lag (`observeHeartbeat`).
    if (reading.majorityLagMs === undefined) continue;
    if (now - reading.receivedAt > READING_MAX_AGE_MS) continue;
    majority = Math.max(majority ?? 0, reading.majorityLagMs);
  }
  let secondary: number | null = null;
  for (const reading of members.values()) {
    // Only a SECONDARY's reply is ever stored with a floor (`observeHeartbeat`).
    if (reading.writeLagFloorMs === undefined) continue;
    if (now - reading.receivedAt > READING_MAX_AGE_MS) continue;
    secondary = Math.max(secondary ?? 0, reading.writeLagFloorMs);
  }
  const lagMs = majority === null && secondary === null ? null : Math.max(majority ?? 0, secondary ?? 0);
  return { lagMs, majorityLagMs: majority, secondaryLagMs: secondary };
}

/** Specs only. */
export function resetReplicationLag(): void {
  members.clear();
  alertedAt.clear();
}

@Injectable()
export class ReplicationLagMonitor implements OnModuleInit {
  private readonly logger = new Logger(ReplicationLagMonitor.name);

  constructor(
    @InjectConnection() private readonly connection: Connection,
    @Optional() @Inject(AppConfigService) private readonly config?: AppConfigService,
  ) {}

  onModuleInit(): void {
    const client = this.connection.getClient?.();
    if (!client) return;
    client.on('serverHeartbeatSucceeded', (event: { connectionId: string; reply?: HeartbeatReply }) => {
      try {
        const now = Date.now();
        const lagging = observeHeartbeat(event.connectionId, event.reply, now, this.config?.mongoReplicationLagAlertMs ?? 10_000);
        for (const { member, lagMs } of lagging) {
          if (now - (alertedAt.get(member) ?? 0) < ALERT_EVERY_MS) continue;
          alertedAt.set(member, now);
          this.logger.warn(
            `[alert] mongo.replication_lag member=${member} lagMs=${lagMs} — secondaryPreferred reads are this ` +
              `much older than the primary (staleness budget ${this.config?.readStalenessBudgetMs ?? 45_000} ms)`,
          );
        }
      } catch {
        // monitoring must never disturb the driver's event loop
      }
    });
  }
}
