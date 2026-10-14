import { Types } from 'mongoose';

/**
 * Pure half of the batched usage writer (`USAGE_WRITE_MODE=batched`, see
 * `usage-flush.service.ts`): the buffer's field encoding, the Lua that claims
 * and acknowledges buffered deltas on redis-state, and the translation of a
 * claimed hash into Mongo `bulkWrite` upserts. No I/O here, so the rules that
 * decide what reaches Mongo are testable on their own.
 *
 * ONE Redis hash holds every pending delta of the fleet (`tw:usage:v1:<ns>:buf`).
 * Each field is a JSON array naming the Mongo row and the counter:
 *
 *   ["u", customerId, period, metric]                       → `usage`
 *       metric  u = units charged (+), r = requests, c = units compensated (+)
 *   ["b", customerId, day, routeKey, apiKeyId, statusClass, keyPrefix, keyLabel, metric]
 *       metric  u = net units, r = requests                 → `usage_buckets`
 *
 * JSON rather than a delimiter because `keyLabel` is customer text and may hold
 * any character. The value is an integer delta (`HINCRBY`); every unit cost is
 * an integer (`@IsInt` on the endpoint-cost DTOs), and a non-integer is never
 * buffered — the caller writes it directly, exactly as today.
 *
 * Charges and compensations of the monthly snapshot are kept APART (`u` vs
 * `c`) because the direct path treats them differently: a charge UPSERTS, a
 * compensation never does (an upsert would create a row holding negative
 * units). The flush applies the same rule per row — see `buildUsageFlushOps`.
 */

/**
 * `direct` = today; `batched` = buffer + flush; `drain` = producers write
 * directly (as `direct`) while the flusher keeps running until the buffer is
 * empty — the step between `batched` and `direct` on a rollback, because a
 * fleet that is all `direct` has no flusher and would strand what is buffered.
 */
export type UsageWriteMode = 'direct' | 'batched' | 'drain';

export const USAGE_FLUSH_DEFAULT_INTERVAL_MS = 10_000;
export const USAGE_FLUSH_MIN_INTERVAL_MS = 1_000;
export const USAGE_FLUSH_MAX_INTERVAL_MS = 300_000;

/**
 * `USAGE_WRITE_MODE` (case-insensitive): `batched`, `drain`, anything else is
 * `direct` = today. The Zod entry refuses an unknown value at boot; this pure
 * helper stays lenient so a spec or a structural config view can never turn
 * buffering on by accident.
 */
export function resolveUsageWriteMode(raw: unknown): UsageWriteMode {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return v === 'batched' ? 'batched' : v === 'drain' ? 'drain' : 'direct';
}

/** `USAGE_FLUSH_INTERVAL_MS`: garbage / ≤ 0 → 10 000; clamped 1 s – 5 min. Pure, so the config getter can import it without a cycle. */
export function resolveUsageFlushIntervalMs(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return USAGE_FLUSH_DEFAULT_INTERVAL_MS;
  return Math.min(USAGE_FLUSH_MAX_INTERVAL_MS, Math.max(USAGE_FLUSH_MIN_INTERVAL_MS, Math.floor(n)));
}

export type UsageMetric = 'u' | 'r' | 'c';
export type BucketMetric = 'u' | 'r';
export type StatusClass = '2xx' | '4xx' | '5xx' | '429';

const STATUS_CLASSES: readonly string[] = ['2xx', '4xx', '5xx', '429'];

export function usageField(customerId: string, period: string, metric: UsageMetric): string {
  return JSON.stringify(['u', customerId, period, metric]);
}

export interface BucketIdentity {
  customerId: string;
  day: string;
  routeKey: string;
  apiKeyId: string;
  statusClass: StatusClass;
  keyPrefix: string;
  keyLabel: string;
}

export function bucketField(b: BucketIdentity, metric: BucketMetric): string {
  return JSON.stringify(['b', b.customerId, b.day, b.routeKey, b.apiKeyId, b.statusClass, b.keyPrefix, b.keyLabel, metric]);
}

/** Hex form of a valid ObjectId, or undefined — the same acceptance as `new Types.ObjectId(x)`. */
export function objectIdHex(value: string): string | undefined {
  try {
    return new Types.ObjectId(value).toHexString();
  } catch {
    return undefined;
  }
}

/** How long an INCR's op marker lives: the window inside which a retry of an ambiguous INCR is recognised. */
export const USAGE_OP_TTL_MS = 120_000;
/** An ambiguous INCR is retried (same op id) while younger than this; well inside `USAGE_OP_TTL_MS`. */
export const USAGE_AMBIGUOUS_MAX_AGE_MS = 90_000;

/**
 * `HINCRBY` every (field, delta) pair into the live hash in ONE atomic call, so
 * a request's counters never straddle a claim (`RENAME`) boundary — ONCE per
 * op id. The marker makes a retry of an INCR whose reply was lost (a 1 s
 * command timeout, a reset after the write) safe: the second run sees the
 * marker and adds nothing. Without it the caller cannot tell "not sent" from
 * "ran, reply lost", and falling back to the local buffer counted the request
 * twice.
 * KEYS[1] = live hash, KEYS[2] = op marker; ARGV[1] = marker TTL ms,
 * ARGV[2..] = field1, delta1, field2, delta2, …
 * → 1 applied now, 0 already applied by an earlier run of the same op.
 */
export const USAGE_INCR_SCRIPT = `
if not redis.call('SET', KEYS[2], '1', 'NX', 'PX', ARGV[1]) then return 0 end
for i = 2, #ARGV, 2 do
  redis.call('HINCRBY', KEYS[1], ARGV[i], ARGV[i + 1])
end
return 1
`;

/**
 * Claim the live hash: `RENAME` it to a per-flush key and register that key in
 * the claims ZSET (score = claim time, refreshed by `TOUCH`). Atomic, so two
 * flushers can never claim the same deltas and a request either lands before
 * the claim (in it) or after (in the next live hash).
 *
 * Refuses while ANY claim is still registered (-3): deltas must reach Mongo in
 * claim order, because a compensation-only delta is a non-upsert `$inc` — if a
 * newer claim holding only the refund is written before an older claim holding
 * the charge's upsert, the refund matches no row and is lost while the charge
 * later lands at full value. A flusher processes its own claims and every claim
 * it can take over first, so what blocks here is a claim another flusher is
 * still writing (or a dead one's, until it is stale).
 * Refuses to overwrite an existing destination (-2): `RENAME` replaces it, so a
 * re-run of an already-executed CLAIM would destroy the first claim's deltas.
 * KEYS[1] = live, KEYS[2] = claim key, KEYS[3] = claims zset; ARGV[1] = now ms.
 * → 1 claimed, 0 nothing buffered, -2 destination exists, -3 an earlier claim is pending.
 */
export const USAGE_CLAIM_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
if redis.call('ZCARD', KEYS[3]) > 0 then return -3 end
if redis.call('EXISTS', KEYS[2]) == 1 then return -2 end
redis.call('RENAME', KEYS[1], KEYS[2])
redis.call('ZADD', KEYS[3], ARGV[1], KEYS[2])
return 1
`;

/**
 * Take over a STALE claim (its owner has not touched it since ARGV[2]) left by
 * a flusher that died between claim and write. Re-checked inside the script, so
 * two flushers racing for one leftover claim cannot both win it. Never renames
 * onto an existing key (-2), for the same reason as CLAIM.
 * KEYS[1] = claims zset, KEYS[2] = stale claim key, KEYS[3] = new claim key;
 * ARGV[1] = now ms, ARGV[2] = stale-before ms.
 * → 1 taken over, 0 not stale / already taken, -1 registered but empty (dropped), -2 destination exists.
 */
export const USAGE_TAKEOVER_SCRIPT = `
if redis.call('EXISTS', KEYS[3]) == 1 then return -2 end
local s = redis.call('ZSCORE', KEYS[1], KEYS[2])
if not s or tonumber(s) > tonumber(ARGV[2]) then return 0 end
redis.call('ZREM', KEYS[1], KEYS[2])
if redis.call('EXISTS', KEYS[2]) == 0 then return -1 end
redis.call('RENAME', KEYS[2], KEYS[3])
redis.call('ZADD', KEYS[1], ARGV[1], KEYS[3])
return 1
`;

/**
 * Prove a claim is still ours and keep it fresh (so it never looks stale while
 * its owner works on it). KEYS[1] = claims zset, KEYS[2] = claim key; ARGV[1] = now.
 * → 1 still ours, 0 taken over (or finished).
 */
export const USAGE_TOUCH_SCRIPT = `
if not redis.call('ZSCORE', KEYS[1], KEYS[2]) then return 0 end
redis.call('ZADD', KEYS[1], ARGV[1], KEYS[2])
return 1
`;

/** How long an ACK's marker lives (its retries happen within a second). */
export const USAGE_ACK_MARKER_TTL_MS = 60_000;

/**
 * Acknowledge fields written to Mongo: `HDEL` them from the claim, and retire
 * the claim once it is empty. Only while the claim is still ours. Idempotent
 * per ack id: an ACK that ran but whose reply was lost has usually RETIRED the
 * claim (its last fields), so a plain retry would read "no longer ours" and
 * raise a false double-count alert — the marker answers 1 instead.
 * KEYS[1] = claims zset, KEYS[2] = claim key, KEYS[3] = ack marker;
 * ARGV[1] = marker TTL ms, ARGV[2..] = fields.
 * → 1 acknowledged (now or by an earlier run of this ack), 0 the claim was no
 * longer ours (the fields may be replayed).
 */
export const USAGE_ACK_SCRIPT = `
if redis.call('EXISTS', KEYS[3]) == 1 then return 1 end
if not redis.call('ZSCORE', KEYS[1], KEYS[2]) then return 0 end
for i = 2, #ARGV, 500 do
  redis.call('HDEL', KEYS[2], unpack(ARGV, i, math.min(i + 499, #ARGV)))
end
if redis.call('EXISTS', KEYS[2]) == 0 then redis.call('ZREM', KEYS[1], KEYS[2]) end
redis.call('SET', KEYS[3], '1', 'PX', ARGV[1])
return 1
`;

/** Retire an empty or fully-acknowledged claim. KEYS[1] = claims zset, KEYS[2] = claim key. */
export const USAGE_RETIRE_SCRIPT = `
if not redis.call('ZSCORE', KEYS[1], KEYS[2]) then return 0 end
if redis.call('HLEN', KEYS[2]) > 0 then return 0 end
redis.call('DEL', KEYS[2])
redis.call('ZREM', KEYS[1], KEYS[2])
return 1
`;

/** One Mongo write and the buffer fields it settles. */
export interface FlushOp {
  kind: 'usage' | 'bucket';
  fields: string[];
  /** A Mongoose `bulkWrite` `updateOne` op. */
  op: { updateOne: { filter: Record<string, unknown>; update: Record<string, unknown>; upsert?: boolean } };
}

export interface FlushPlan {
  usage: FlushOp[];
  buckets: FlushOp[];
  /** Fields that settle with no write: zero deltas and malformed entries (logged by the caller). */
  noWrite: string[];
  malformed: string[];
}

function toInt(raw: string | number): number | undefined {
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isSafeInteger(n) ? n : undefined;
}

/**
 * Turn a claimed hash into Mongo ops, one per row.
 *
 * `usage` (the monthly snapshot), the SAME rule as the direct path:
 *  - the window holds at least one request (`r > 0`) → UPSERT
 *    `$inc {unitsConsumed: u − c, requestCount: r}` — the charge's own upsert,
 *    with any compensation of the same window netted in;
 *  - compensations only (`r = 0`) → `$inc {unitsConsumed: −c}` WITHOUT upsert:
 *    a compensation reverses a charge that must already be in the row, and a
 *    missing row means there is nothing to reverse (an upsert would create one
 *    holding negative units — `compensateUsageSnapshot`'s rule);
 *  - nothing net (`r = 0`, `u = c`) → no write.
 *
 * `usage_buckets`: the upsert `UsageBucketService.record` sends, with the
 * window's deltas summed; `$setOnInsert` carries `period` (sliced off `day`)
 * and the first-seen `keyPrefix`/`keyLabel` of that bucket, exactly like the
 * first request of the bucket would have.
 */
export function buildUsageFlushOps(entries: Record<string, string | number>): FlushPlan {
  const usage = new Map<string, { customerId: string; period: string; u: number; r: number; c: number; fields: string[] }>();
  const buckets = new Map<string, { id: BucketIdentity; u: number; r: number; fields: string[] }>();
  const malformed: string[] = [];
  const noWrite: string[] = [];

  for (const [field, raw] of Object.entries(entries)) {
    const delta = toInt(raw);
    let parts: unknown;
    try {
      parts = JSON.parse(field);
    } catch {
      parts = undefined;
    }
    if (delta === undefined || !Array.isArray(parts) || !parts.every((p) => typeof p === 'string')) {
      malformed.push(field);
      continue;
    }
    const p = parts as string[];
    if (p[0] === 'u' && p.length === 4 && (p[3] === 'u' || p[3] === 'r' || p[3] === 'c')) {
      const [, customerId, period, metric] = p as [string, string, string, UsageMetric];
      if (!objectIdHex(customerId) || !/^\d{4}-\d{2}$/.test(period)) {
        malformed.push(field);
        continue;
      }
      const key = `${customerId}\u0000${period}`;
      const row = usage.get(key) ?? { customerId, period, u: 0, r: 0, c: 0, fields: [] };
      row[metric] += delta;
      row.fields.push(field);
      usage.set(key, row);
      continue;
    }
    if (p[0] === 'b' && p.length === 9 && (p[8] === 'u' || p[8] === 'r')) {
      const [, customerId, day, routeKey, apiKeyId, statusClass, keyPrefix, keyLabel, metric] = p as [
        string, string, string, string, string, string, string, string, BucketMetric,
      ];
      if (!objectIdHex(customerId) || !objectIdHex(apiKeyId) || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !STATUS_CLASSES.includes(statusClass)) {
        malformed.push(field);
        continue;
      }
      // The row identity is the unique index; the label is only a property of
      // the row's insert. Two labels for one bucket (a key renamed inside the
      // window) are ONE row: the first label seen wins, as on the direct path.
      const key = [customerId, day, routeKey, apiKeyId, statusClass].join('\u0000');
      const row = buckets.get(key) ?? {
        id: { customerId, day, routeKey, apiKeyId, statusClass: statusClass as StatusClass, keyPrefix, keyLabel },
        u: 0,
        r: 0,
        fields: [],
      };
      row[metric] += delta;
      row.fields.push(field);
      buckets.set(key, row);
      continue;
    }
    malformed.push(field);
  }

  const usageOps: FlushOp[] = [];
  for (const row of usage.values()) {
    const filter = { customerId: new Types.ObjectId(row.customerId), period: row.period };
    if (row.r > 0) {
      usageOps.push({
        kind: 'usage',
        fields: row.fields,
        op: { updateOne: { filter, update: { $inc: { unitsConsumed: row.u - row.c, requestCount: row.r } }, upsert: true } },
      });
    } else if (row.u - row.c !== 0) {
      usageOps.push({
        kind: 'usage',
        fields: row.fields,
        op: { updateOne: { filter, update: { $inc: { unitsConsumed: row.u - row.c } } } },
      });
    } else {
      noWrite.push(...row.fields);
    }
  }

  const bucketOps: FlushOp[] = [];
  for (const row of buckets.values()) {
    if (row.r <= 0) {
      // Every recorded request adds r=1 in the same atomic call as its units,
      // so this is unreachable for real data; never invent a row from it.
      noWrite.push(...row.fields);
      continue;
    }
    const { id } = row;
    bucketOps.push({
      kind: 'bucket',
      fields: row.fields,
      op: {
        updateOne: {
          filter: {
            customerId: new Types.ObjectId(id.customerId),
            day: id.day,
            routeKey: id.routeKey,
            apiKeyId: new Types.ObjectId(id.apiKeyId),
            statusClass: id.statusClass,
          },
          update: {
            $inc: { units: row.u, requests: row.r },
            $setOnInsert: { period: id.day.slice(0, 7), keyPrefix: id.keyPrefix, keyLabel: id.keyLabel },
          },
          upsert: true,
        },
      },
    });
  }

  return { usage: usageOps, buckets: bucketOps, noWrite, malformed };
}

/** The Mongo row a buffer field belongs to (malformed fields are their own row). */
function rowOfField(field: string): string {
  try {
    const p = JSON.parse(field) as unknown;
    if (Array.isArray(p) && p[0] === 'u' && p.length === 4) return JSON.stringify(p.slice(0, 3));
    if (Array.isArray(p) && p[0] === 'b' && p.length === 9) return JSON.stringify(p.slice(0, 6));
  } catch {
    // fall through
  }
  return field;
}

/**
 * Split (field, delta) pairs into INCR batches of at most `maxFields` without
 * ever splitting one row's fields across two batches: each batch is its own
 * atomic call, and a row whose `r` lands in one claim and its `u` in the next
 * turns the `u` half into a non-upsert `$inc` that can match nothing.
 */
export function rowBatches(pairs: Array<[string, number]>, maxFields: number): Array<Array<[string, number]>> {
  const rows = new Map<string, Array<[string, number]>>();
  for (const pair of pairs) {
    const k = rowOfField(pair[0]);
    const list = rows.get(k);
    if (list) list.push(pair);
    else rows.set(k, [pair]);
  }
  const out: Array<Array<[string, number]>> = [];
  let cur: Array<[string, number]> = [];
  const cap = Math.max(1, Math.floor(maxFields));
  for (const group of rows.values()) {
    if (cur.length && cur.length + group.length > cap) {
      out.push(cur);
      cur = [];
    }
    cur.push(...group);
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * True when an ioredis rejection proves the command never reached the server:
 * the client refused it locally (offline queue disabled, stream not writeable)
 * or the server answered with an error reply. Anything else — a command
 * timeout, `MaxRetriesPerRequestError`, a connection closed with the command
 * queued — is AMBIGUOUS: the script may have run and its reply been lost.
 */
export function redisNotSent(err: unknown): boolean {
  const e = err as { name?: unknown; message?: unknown } | undefined;
  if (e?.name === 'ReplyError') return true;
  const msg = typeof e?.message === 'string' ? e.message : '';
  return /Stream isn't writeable|enableOfflineQueue/i.test(msg);
}

/** Split into chunks of at most `size`. */
export function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  const n = Math.max(1, Math.floor(size));
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

/**
 * How many ops of an ORDERED `bulkWrite` were applied before it threw: the
 * index of the first write error (ops before it are committed, it and every op
 * after are not). Undefined when the error carries no write errors — a network
 * error or timeout, where the outcome is unknown.
 */
export function appliedBeforeError(err: unknown): { applied: number; code: number | undefined } | undefined {
  const e = err as { writeErrors?: unknown; code?: unknown } | undefined;
  const raw = e?.writeErrors;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const indexes = list
    .map((w) => (w as { index?: unknown; err?: { index?: unknown } })?.index ?? (w as { err?: { index?: unknown } })?.err?.index)
    .filter((i): i is number => typeof i === 'number' && Number.isInteger(i) && i >= 0);
  if (indexes.length === 0) return undefined;
  const first = Math.min(...indexes);
  const firstErr = list.find((w) => (w as { index?: unknown })?.index === first) as { code?: unknown } | undefined;
  const code = typeof firstErr?.code === 'number' ? firstErr.code : typeof e?.code === 'number' ? e.code : undefined;
  return { applied: first, code };
}
