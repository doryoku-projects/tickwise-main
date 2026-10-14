/**
 * Ordering and fencing on Redis (design §2.5), as Lua scripts plus a
 * TypeScript model of each — the model is what `MemoryModelsTransport` runs
 * and what `fenced-append.spec` checks; `test/read-models/redis-contract.spec`
 * runs the same contract against a real Redis (opt-in).
 *
 *  - The fence AUTHORITY lives on redis-state (AOF): `INCR`, first seeded with
 *    `SET NX now-ms` when the key is missing (redis-state lost) — far above
 *    any earlier INCR count, so the fence never goes backwards.
 *  - A COPY of the fence lives on redis-models, raised with "set only if
 *    missing or greater" (`SEED_FENCE`) by a holder right after a successful
 *    lease renew.
 *  - Every append is ONE Lua call (`APPEND`): it lands only when the fence
 *    copy equals the appender's fence AND the incarnation equals the one the
 *    appender knows AND the sequence is the next one — `s == cursor.s + 1` in
 *    the cursor's epoch, `s == 1` for a newer epoch or an empty cursor. A
 *    paused ex-holder (GC pause, network split) can therefore never
 *    interleave entries with the new holder, and the stream can never skip.
 *  - The manifest switch is fenced the same way (`FENCED_SET`).
 */

/** KEYS: fenceCopy, incarnation, deltas, cursor · ARGV: fence, inc, epoch, s, ttlMs, field, value, … */
export const APPEND_SCRIPT = `
local fence = redis.call('GET', KEYS[1])
if not fence then return {0, 'fence_missing', ''} end
if fence ~= ARGV[1] then return {0, 'fence_mismatch', fence} end
local inc = redis.call('GET', KEYS[2])
if not inc then return {0, 'inc_missing', ''} end
if inc ~= ARGV[2] then return {0, 'inc_mismatch', inc} end
local epoch = tonumber(ARGV[3])
local s = tonumber(ARGV[4])
local cur = redis.call('GET', KEYS[4])
if cur then
  local ce, cs = string.match(cur, '^(%d+):(%d+):')
  ce = tonumber(ce)
  cs = tonumber(cs)
  if epoch == ce then
    if s ~= cs + 1 then return {0, 'seq_gap', cur} end
  elseif epoch < ce then
    return {0, 'epoch_behind', cur}
  elseif s ~= 1 then
    return {0, 'seq_gap', cur}
  end
elseif s ~= 1 then
  return {0, 'seq_gap', ''}
end
local fields = {}
for i = 6, #ARGV do fields[#fields + 1] = ARGV[i] end
local id = redis.call('XADD', KEYS[3], '*', unpack(fields))
redis.call('SET', KEYS[4], ARGV[3] .. ':' .. ARGV[4] .. ':' .. ARGV[1] .. ':' .. id, 'PX', ARGV[5])
redis.call('PEXPIRE', KEYS[3], ARGV[5])
return {1, id, ''}
`;

/** KEYS: fenceCopy · ARGV: fence, ttlMs → 1 seeded (or refreshed at the same value), 0 refused (a greater fence is there). */
export const SEED_FENCE_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
local f = tonumber(ARGV[1])
if (not cur) or f > tonumber(cur) then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
  return 1
end
if f == tonumber(cur) then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
return 0
`;

/** KEYS: fenceCopy, incarnation, target · ARGV: fence, inc, value, ttlMs */
export const FENCED_SET_SCRIPT = `
local fence = redis.call('GET', KEYS[1])
if not fence then return {0, 'fence_missing'} end
if fence ~= ARGV[1] then return {0, 'fence_mismatch'} end
local inc = redis.call('GET', KEYS[2])
if not inc then return {0, 'inc_missing'} end
if inc ~= ARGV[2] then return {0, 'inc_mismatch'} end
redis.call('SET', KEYS[3], ARGV[3], 'PX', ARGV[4])
return {1, 'ok'}
`;

/** KEYS: fenceAuthority (redis-state) · ARGV: nowMs → the new fence. */
export const NEXT_FENCE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then redis.call('SET', KEYS[1], ARGV[1]) end
return redis.call('INCR', KEYS[1])
`;

/** KEYS: incarnation · ARGV: candidate, ttlMs → {value, created(1|0)}; refreshes the TTL. */
export const INCARNATION_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
if cur then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return {cur, 0}
end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return {ARGV[1], 1}
`;

export type AppendRefusal = 'fence_missing' | 'fence_mismatch' | 'inc_missing' | 'inc_mismatch' | 'seq_gap' | 'epoch_behind';
export type AppendOutcome = { ok: true; id: string } | { ok: false; reason: AppendRefusal | 'error'; detail: string };

export type FencedSetOutcome = 'ok' | 'fence_missing' | 'fence_mismatch' | 'inc_missing' | 'inc_mismatch';

/** The cursor value: `epoch:s:fence:streamId`. */
export interface CursorValue {
  epoch: number;
  s: number;
  fence: number;
  id: string;
}

export function parseCursor(value: string | null | undefined): CursorValue | null {
  if (!value) return null;
  const m = /^(\d+):(\d+):(\d+):(.+)$/.exec(value);
  return m ? { epoch: Number(m[1]), s: Number(m[2]), fence: Number(m[3]), id: m[4] } : null;
}

export function formatCursor(cursor: CursorValue): string {
  return `${cursor.epoch}:${cursor.s}:${cursor.fence}:${cursor.id}`;
}

// ── the TypeScript model (what the scripts do, over a key/value view) ──

/** The key/value operations the models need. */
export interface ScriptStore {
  get(key: string): string | null;
  set(key: string, value: string, ttlMs?: number): void;
  expire(key: string, ttlMs: number): void;
  exists(key: string): boolean;
  /** Append a stream entry, returning its id. */
  xadd(key: string, fields: Array<string | Uint8Array>): string;
}

export function appendModel(
  store: ScriptStore,
  keys: { fenceCopy: string; incarnation: string; deltas: string; cursor: string },
  args: { fence: number; inc: string; epoch: number; s: number; ttlMs: number; fields: Array<string | Uint8Array> },
): AppendOutcome {
  const fence = store.get(keys.fenceCopy);
  if (fence === null) return { ok: false, reason: 'fence_missing', detail: '' };
  if (fence !== String(args.fence)) return { ok: false, reason: 'fence_mismatch', detail: fence };
  const inc = store.get(keys.incarnation);
  if (inc === null) return { ok: false, reason: 'inc_missing', detail: '' };
  if (inc !== args.inc) return { ok: false, reason: 'inc_mismatch', detail: inc };
  const raw = store.get(keys.cursor);
  const cur = parseCursor(raw);
  if (cur) {
    if (args.epoch === cur.epoch) {
      if (args.s !== cur.s + 1) return { ok: false, reason: 'seq_gap', detail: raw ?? '' };
    } else if (args.epoch < cur.epoch) {
      return { ok: false, reason: 'epoch_behind', detail: raw ?? '' };
    } else if (args.s !== 1) {
      return { ok: false, reason: 'seq_gap', detail: raw ?? '' };
    }
  } else if (args.s !== 1) {
    return { ok: false, reason: 'seq_gap', detail: '' };
  }
  const id = store.xadd(keys.deltas, args.fields);
  store.set(keys.cursor, formatCursor({ epoch: args.epoch, s: args.s, fence: args.fence, id }), args.ttlMs);
  store.expire(keys.deltas, args.ttlMs);
  return { ok: true, id };
}

export function seedFenceModel(store: ScriptStore, key: string, fence: number, ttlMs: number): boolean {
  const cur = store.get(key);
  if (cur === null || fence > Number(cur)) {
    store.set(key, String(fence), ttlMs);
    return true;
  }
  if (fence === Number(cur)) {
    store.expire(key, ttlMs);
    return true;
  }
  return false;
}

export function fencedSetModel(
  store: ScriptStore,
  keys: { fenceCopy: string; incarnation: string; target: string },
  args: { fence: number; inc: string; value: string; ttlMs: number },
): FencedSetOutcome {
  const fence = store.get(keys.fenceCopy);
  if (fence === null) return 'fence_missing';
  if (fence !== String(args.fence)) return 'fence_mismatch';
  const inc = store.get(keys.incarnation);
  if (inc === null) return 'inc_missing';
  if (inc !== args.inc) return 'inc_mismatch';
  store.set(keys.target, args.value, args.ttlMs);
  return 'ok';
}

export function nextFenceModel(store: ScriptStore, key: string, nowMs: number): number {
  if (!store.exists(key)) store.set(key, String(Math.floor(nowMs)));
  const next = Number(store.get(key)) + 1;
  store.set(key, String(next));
  return next;
}

export function incarnationModel(store: ScriptStore, key: string, candidate: string, ttlMs: number): { inc: string; created: boolean } {
  const cur = store.get(key);
  if (cur !== null) {
    store.expire(key, ttlMs);
    return { inc: cur, created: false };
  }
  store.set(key, candidate, ttlMs);
  return { inc: candidate, created: true };
}
