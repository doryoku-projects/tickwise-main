import { createHash } from 'node:crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service.js';
import type { LadderRungLike, LadderStore } from '../shard-stream-merge.js';
import { ReadPathRedis } from './read-path-redis.js';

/**
 * The deep-page LADDER: boundary sort keys recorded by every deep walk
 * (`walkDeepPage`), so the next deep page of the same query starts from the
 * nearest boundary at or before its offset instead of from the top.
 *
 * A rung is `{offset, at, value, id, chainId, counts}`: the sort key of the
 * last row before `offset` in the merged order, the chain it came from, and how
 * many of those `offset` rows each chain held. Rungs are recorded every 1,000
 * walked rows and at both edges of every served deep page, so sequential
 * next/previous paging starts exactly where the last page ended.
 *
 * TRUST: a rung's `at` is when the row count before it was MEASURED — the
 * start of the walk from the top that counted it, inherited by every rung a
 * later walk derives from it (`walkDeepPage`). A rung at most the staleness
 * budget old (`READ_STALENESS_BUDGET_MS`, 45 s) is TRUSTED: a page walked from
 * it has offsets accurate to within 45 s, as every list's data is, and is
 * served unflagged. An older rung, up to `LEADERBOARD_LADDER_MAX_AGE_MS`
 * (10 min), is kept as an AGED start for a page no trusted start can reach
 * within a request (`nearest(…, maxAgeMs)`): that page is served flagged
 * `stale: true` + `dataAsOf` = the rung's `at`, so a deep page is never
 * refused for its depth. The seek from any rung is exact BY SORT KEY
 * (`seekSegments`); only the row count before it is as old as `at`.
 *
 * STORE: a Redis ZSET per query (`tw:lad:v1:<deployment>:<sha1(ladderKey)>`,
 * score = offset, at most 4,000 rungs, the key's TTL refreshed to the max age
 * on every write — a hard TTL like every other L2 entry), shared by every
 * process; and a small per-process copy, which is all there is when Redis is
 * off or unreachable. A lookup takes the deepest qualifying rung of the two.
 * A rung never replaces a FRESHER one at the same offset.
 */

/** Rungs kept per query in Redis (≈ 4M rows of reach at one rung per 1,000). */
const MAX_REDIS_RUNGS = 4_000;
/** Rungs kept per query in process, and queries kept: a bounded fallback, not a second store. */
const MAX_LOCAL_RUNGS = 1_000;
const MAX_LOCAL_LADDERS = 200;
/**
 * Candidates read back per lookup: the deepest few at or before the offset.
 * Every write refreshes the whole key's TTL, so a key can hold untrusted deep
 * rungs in front of a fresh shallower one; 32 (~5 KB) reaches past them.
 */
const LOOKUP_CANDIDATES = 32;

const KEY_PREFIX = 'tw:lad:v1:';

/** A rung's value as it travels through JSON (`NaN`, `±Infinity` and `null` are not JSON numbers). */
type EncodedValue = { z: 1 } | { nan: 1 } | { inf: 1 | -1 } | { n: number } | { s: string };

export function encodeLadderValue(value: unknown): EncodedValue | undefined {
  if (value === null || value === undefined) return { z: 1 };
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return { nan: 1 };
    if (value === Infinity) return { inf: 1 };
    if (value === -Infinity) return { inf: -1 };
    return { n: value };
  }
  if (typeof value === 'string') return { s: value };
  return undefined; // a value no seek can express — the rung is not recorded
}

export function decodeLadderValue(encoded: unknown): { ok: true; value: unknown } | { ok: false } {
  if (!encoded || typeof encoded !== 'object') return { ok: false };
  const e = encoded as Record<string, unknown>;
  if (e.z === 1) return { ok: true, value: null };
  if (e.nan === 1) return { ok: true, value: NaN };
  if (e.inf === 1) return { ok: true, value: Infinity };
  if (e.inf === -1) return { ok: true, value: -Infinity };
  if (typeof e.n === 'number' && Number.isFinite(e.n)) return { ok: true, value: e.n };
  if (typeof e.s === 'string') return { ok: true, value: e.s };
  return { ok: false };
}

function encodeRung(rung: LadderRungLike): string | undefined {
  const v = encodeLadderValue(rung.value);
  if (!v) return undefined;
  return JSON.stringify({ o: rung.offset, t: rung.at, v, p: rung.id, c: rung.chainId, n: rung.counts });
}

function decodeRung(member: string): LadderRungLike | undefined {
  try {
    const raw = JSON.parse(member) as Record<string, unknown>;
    const value = decodeLadderValue(raw.v);
    if (!value.ok) return undefined;
    if (typeof raw.o !== 'number' || typeof raw.t !== 'number' || typeof raw.p !== 'string') return undefined;
    if (typeof raw.c !== 'number' || !raw.n || typeof raw.n !== 'object') return undefined;
    const counts: Record<number, number> = {};
    for (const [chain, n] of Object.entries(raw.n as Record<string, unknown>)) {
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return undefined;
      counts[Number(chain)] = n;
    }
    return { offset: raw.o, at: raw.t, value: value.value, id: raw.p, chainId: raw.c, counts };
  } catch {
    return undefined;
  }
}

@Injectable()
export class PageLadderService implements LadderStore {
  private readonly local = new Map<string, LadderRungLike[]>();
  private readonly now: () => number;

  constructor(
    @Optional() @Inject(AppConfigService) private readonly config?: AppConfigService,
    @Optional() @Inject(ReadPathRedis) private readonly redis?: ReadPathRedis,
    // Specs only (a fake clock); Nest finds nothing to inject and passes undefined.
    @Optional() now?: () => number,
  ) {
    this.now = now ?? Date.now;
  }

  /** How long a rung is trusted (served unflagged): the staleness budget. */
  get trustMs(): number {
    return this.config?.readStalenessBudgetMs ?? 45_000;
  }

  /** How long a rung is kept at all: the oldest AGED start a deep page may use (flagged). */
  get maxAgeMs(): number {
    return Math.max(this.trustMs, this.config?.leaderboardLadderMaxAgeMs ?? 600_000);
  }

  /**
   * The deepest rung at or before `offset` measured at most `maxAgeMs` ago
   * (default: the trust window; never more than `maxAgeMs` of the store).
   */
  async nearest(key: string, offset: number, maxAgeMs?: number): Promise<LadderRungLike | undefined> {
    const oldest = this.now() - Math.min(maxAgeMs ?? this.trustMs, this.maxAgeMs);
    let best = this.nearestLocal(key, offset, oldest);
    const client = await this.redis?.client();
    if (client) {
      try {
        const members = await client.zrevrangebyscore(this.redisKey(key), offset, '-inf', 'LIMIT', 0, LOOKUP_CANDIDATES);
        for (const member of members) {
          const rung = decodeRung(member);
          if (!rung || rung.at < oldest || rung.offset > offset) continue;
          if (!best || rung.offset > best.offset || (rung.offset === best.offset && rung.at > best.at)) best = rung;
          break; // the deepest qualifying Redis rung
        }
      } catch (err) {
        this.redis?.logError(err);
      }
    }
    return best;
  }

  /** Store `rungs` (fire-and-forget; replaces an OLDER rung at the same offset, never a fresher one). */
  record(key: string, rungs: LadderRungLike[]): void {
    const encoded = rungs
      .map((rung) => ({ rung, member: encodeRung(rung) }))
      .filter((entry): entry is { rung: LadderRungLike; member: string } => entry.member !== undefined);
    if (encoded.length === 0) return;
    this.recordLocal(key, encoded.map((entry) => entry.rung));
    void this.recordRedis(key, encoded);
  }

  private async recordRedis(key: string, encoded: Array<{ rung: LadderRungLike; member: string }>): Promise<void> {
    const client = await this.redis?.client();
    if (!client) return;
    try {
      const redisKey = this.redisKey(key);
      // What is already stored at these offsets: a fresher rung there is kept.
      // (Not atomic with the write below; a race only keeps the older of two
      // valid rungs, i.e. an accelerator a little less fresh.)
      const read = client.multi();
      for (const { rung } of encoded) read.zrangebyscore(redisKey, rung.offset, rung.offset);
      const existing = (await read.exec()) ?? [];
      const multi = client.multi();
      encoded.forEach(({ rung, member }, i) => {
        const stored = (existing[i]?.[1] as string[] | undefined) ?? [];
        if (stored.some((m) => (decodeRung(m)?.at ?? -Infinity) > rung.at)) return;
        multi.zremrangebyscore(redisKey, rung.offset, rung.offset);
        multi.zadd(redisKey, rung.offset, member);
      });
      // Keep the deepest MAX_REDIS_RUNGS (the shallow ones are the cheap ones to re-walk).
      multi.zremrangebyrank(redisKey, 0, -(MAX_REDIS_RUNGS + 1));
      multi.pexpire(redisKey, this.maxAgeMs);
      await multi.exec();
    } catch (err) {
      this.redis?.logError(err);
    }
  }

  private nearestLocal(key: string, offset: number, oldest: number): LadderRungLike | undefined {
    const rungs = this.local.get(key);
    if (!rungs) return undefined;
    for (let i = rungs.length - 1; i >= 0; i--) {
      const rung = rungs[i]!;
      if (rung.offset <= offset && rung.at >= oldest) return rung;
    }
    return undefined;
  }

  private recordLocal(key: string, rungs: LadderRungLike[]): void {
    const oldest = this.now() - this.maxAgeMs;
    const byOffset = new Map<number, LadderRungLike>();
    for (const rung of this.local.get(key) ?? []) if (rung.at >= oldest) byOffset.set(rung.offset, rung);
    for (const rung of rungs) {
      const stored = byOffset.get(rung.offset);
      if (!stored || stored.at <= rung.at) byOffset.set(rung.offset, rung);
    }
    const merged = [...byOffset.values()].sort((a, b) => a.offset - b.offset).slice(-MAX_LOCAL_RUNGS);
    this.local.delete(key); // re-insert last: the least recently written ladder is evicted first
    this.local.set(key, merged);
    while (this.local.size > MAX_LOCAL_LADDERS) {
      const first = this.local.keys().next().value;
      if (first === undefined) break;
      this.local.delete(first);
    }
  }

  private redisKey(key: string): string {
    return `${KEY_PREFIX}${this.redis?.namespace ?? 'local'}:${createHash('sha1').update(key).digest('hex')}`;
  }
}
