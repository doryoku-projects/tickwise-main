import { ENGINE_TOP_FIELDS, SUBTREE_LEAVES, leavesOf, type ReadModelName } from '../core/fields.js';
import { normalizeDoc, normalizeUpdate, oidHex } from './normalize.js';
import { timeFromBson, formatTime, tokenData } from './resume-token.js';
import type { RowChange, ShardCollection } from './messages.js';

/**
 * The feeder's change stream (design §3.1): ONE `db.watch` on the positions
 * database serves both models.
 *
 * Pipeline:
 *  1. `$match` — `{ ns.coll ~ /_(positions|pools)$/, operationType in
 *     [insert, update, replace, delete, drop, rename] }` OR `dropDatabase` /
 *     `invalidate` (they carry no `ns.coll`) OR a `rename` whose TARGET is a
 *     shard name (a rename carries the SOURCE in `ns.coll`).
 *     `_position_transactions` does not match.
 *  2. A shape-preserving trim, server-side, so Atlas egress pays only for
 *     engine fields (F5, F11): `updatedFields` keeps the keys whose first
 *     segment is an engine field; each whole engine subtree in it and in
 *     `fullDocument` is `$switch`ed on its `$type` — object → an object of the
 *     needed leaves (`$getField`; a missing leaf stays missing); null /
 *     missing → as is; anything else → `{ __odd: <$type> }` (the evidence
 *     quarantine needs, F13: `$getField` on an array would answer missing).
 * If the server refuses the trim (`trim: 'top'`) the subtree trim is dropped
 * and only the top-level filter stays; `trim: 'none'` keeps the `$match`
 * alone. `normalize.ts` reads all three shapes identically.
 */

export type TrimLevel = 'full' | 'top' | 'none';

const ROW_OPS = ['insert', 'update', 'replace', 'delete', 'drop', 'rename'];
const SUBTREE_TOPS = [...SUBTREE_LEAVES.keys()];
const TOP_LEVEL_LEAVES = ENGINE_TOP_FIELDS.filter((field) => !SUBTREE_LEAVES.has(field));

/** `$switch` that reduces the subtree at `input` (an expression) to its `leaves`. */
export function trimExpression(input: string, leaves: readonly string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const leaf of leaves) picked[leaf] = { $getField: { field: leaf, input } };
  return {
    $switch: {
      branches: [
        { case: { $eq: [{ $type: input }, 'object'] }, then: picked },
        { case: { $in: [{ $type: input }, ['null', 'missing']] }, then: input },
      ],
      default: { __odd: { $type: input } },
    },
  };
}

/** The `$match` stage (shared by every trim level). */
export function matchStage(): Record<string, unknown> {
  const rx = '_(positions|pools)$';
  return {
    $match: {
      $or: [
        { 'ns.coll': { $regex: rx }, operationType: { $in: ROW_OPS } },
        { operationType: { $in: ['dropDatabase', 'invalidate'] } },
        { operationType: 'rename', 'to.coll': { $regex: rx } },
      ],
    },
  };
}

/** The change-stream pipeline at a trim level. */
export function changeStreamPipeline(trim: TrimLevel = 'full'): Array<Record<string, unknown>> {
  if (trim === 'none') return [matchStage()];
  const fullDoc: Record<string, unknown> = { _id: '$fullDocument._id' };
  for (const field of TOP_LEVEL_LEAVES) fullDoc[field] = `$fullDocument.${field}`;
  for (const top of SUBTREE_TOPS) {
    fullDoc[top] = trim === 'full' ? trimExpression(`$fullDocument.${top}`, SUBTREE_LEAVES.get(top)!) : `$fullDocument.${top}`;
  }
  const valueOf =
    trim === 'full'
      ? {
          $switch: {
            branches: SUBTREE_TOPS.map((top) => ({
              case: { $eq: ['$$kv.k', top] },
              then: trimExpression('$$kv.v', SUBTREE_LEAVES.get(top)!),
            })),
            default: '$$kv.v',
          },
        }
      : '$$kv.v';
  return [
    matchStage(),
    {
      $project: {
        _id: 1,
        operationType: 1,
        ns: 1,
        to: 1,
        documentKey: 1,
        clusterTime: 1,
        'updateDescription.removedFields': 1,
        'updateDescription.truncatedArrays': 1,
        'updateDescription.updatedFields': {
          $arrayToObject: {
            $map: {
              input: {
                $filter: {
                  input: { $objectToArray: '$updateDescription.updatedFields' },
                  as: 'kv',
                  cond: { $in: [{ $arrayElemAt: [{ $split: ['$$kv.k', '.'] }, 0] }, [...ENGINE_TOP_FIELDS]] },
                },
              },
              as: 'kv',
              in: { k: '$$kv.k', v: valueOf },
            },
          },
        },
        fullDocument: { $cond: [{ $eq: [{ $type: '$fullDocument' }, 'object'] }, fullDoc, '$$REMOVE'] },
      },
    },
  ];
}

/**
 * The scan projection of a model (§3.2 step 3, `FEEDER_PROJECTION`): the
 * same trim expressions as the stream, so a scanned row and an event read a
 * subtree identically (find projections take aggregation expressions since
 * MongoDB 4.4).
 */
export function scanProjection(model: ReadModelName, trim: TrimLevel = 'full'): Record<string, unknown> {
  const projection: Record<string, unknown> = { _id: 1 };
  const subtrees = new Map<string, Set<string>>();
  for (const spec of leavesOf(model)) {
    if (!spec.sub) {
      projection[spec.top] = 1;
      continue;
    }
    const set = subtrees.get(spec.top) ?? new Set<string>();
    set.add(spec.sub);
    subtrees.set(spec.top, set);
  }
  for (const [top, leaves] of subtrees) {
    projection[top] = trim === 'full' ? trimExpression(`$${top}`, [...leaves].sort()) : 1;
  }
  return projection;
}

/** What one change-stream event means to the feeder. */
export type StreamItem =
  | { kind: 'row'; change: RowChange }
  /** An update that touched no engine field (still advances the stream position). */
  | { kind: 'noop'; coll: string; rt: string; ct: string }
  | { kind: 'drop'; coll: string; how: 'drop' | 'rename'; rt: string; ct: string }
  | { kind: 'renameInto'; coll: string; rt: string; ct: string }
  /** A rename from one served shard collection (`from`) to another (`coll`): both effects. */
  | { kind: 'renameBetween'; from: string; coll: string; rt: string; ct: string }
  | { kind: 'badId'; coll: string; rt: string; ct: string }
  | { kind: 'dropDatabase'; rt: string; ct: string }
  | { kind: 'invalidate'; rt: string; ct: string }
  /** A namespace the feeder does not serve. */
  | { kind: 'skip'; rt: string; ct: string };

/** A raw (trimmed) change event → what it means, given the served shards. */
export function toStreamItem(event: Record<string, unknown>, shards: ReadonlyMap<string, ShardCollection>): StreamItem {
  const rt = tokenData(event._id) ?? '';
  const time = timeFromBson(event.clusterTime);
  const ct = time ? formatTime(time) : '';
  const op = String(event.operationType ?? '');
  const ns = event.ns as { coll?: unknown } | undefined;
  const coll = typeof ns?.coll === 'string' ? ns.coll : '';
  if (op === 'dropDatabase') return { kind: 'dropDatabase', rt, ct };
  if (op === 'invalidate') return { kind: 'invalidate', rt, ct };
  if (op === 'rename') {
    const to = (event.to as { coll?: unknown } | undefined)?.coll;
    if (typeof to === 'string' && shards.has(to)) {
      return shards.has(coll) && coll !== to ? { kind: 'renameBetween', from: coll, coll: to, rt, ct } : { kind: 'renameInto', coll: to, rt, ct };
    }
    if (shards.has(coll)) return { kind: 'drop', coll, how: 'rename', rt, ct };
    return { kind: 'skip', rt, ct };
  }
  const shard = shards.get(coll);
  if (!shard) return { kind: 'skip', rt, ct };
  if (op === 'drop') return { kind: 'drop', coll, how: 'drop', rt, ct };
  const oid = oidHex((event.documentKey as { _id?: unknown } | undefined)?._id);
  if (!oid) return { kind: 'badId', coll, rt, ct };
  switch (op) {
    case 'insert':
    case 'replace': {
      const doc = event.fullDocument;
      if (!doc || typeof doc !== 'object') return { kind: 'badId', coll, rt, ct };
      return { kind: 'row', change: { coll, oid, base: 'state', state: normalizeDoc(shard.model, doc as Record<string, unknown>), rt, ct } };
    }
    case 'delete':
      return { kind: 'row', change: { coll, oid, base: 'delete', rt, ct } };
    case 'update': {
      const sets = normalizeUpdate(shard.model, (event.updateDescription ?? {}) as Parameters<typeof normalizeUpdate>[1]);
      if (sets.length === 0) return { kind: 'noop', coll, rt, ct };
      return { kind: 'row', change: { coll, oid, base: 'none', sets, rt, ct } };
    }
    default:
      return { kind: 'skip', rt, ct };
  }
}

/** Is this error the server refusing a pipeline expression (so the trim must fall back)? */
export function isPipelineRefusal(err: unknown): boolean {
  const record = err as { code?: unknown; codeName?: unknown; message?: unknown } | null;
  if (!record || typeof record !== 'object') return false;
  // InvalidPipelineOperator (168), Location/40xxx expression errors, FailedToParse (9), and
  // "is not allowed in a $changeStream pipeline" style refusals.
  const code = typeof record.code === 'number' ? record.code : -1;
  if (code === 168 || code === 9 || code === 15983 || code === 31324) return true;
  const message = typeof record.message === 'string' ? record.message : '';
  return /unrecognized expression|invalid \$project|not allowed in .*change ?stream|unknown operator|\$getField/i.test(message);
}

/** History lost: the resume point is no longer in the oplog (`ChangeStreamHistoryLost` 286, `ChangeStreamFatalError` 280). */
export function isHistoryLost(err: unknown): boolean {
  const record = err as { code?: unknown; codeName?: unknown; message?: unknown } | null;
  if (!record || typeof record !== 'object') return false;
  if (record.code === 286 || record.codeName === 'ChangeStreamHistoryLost') return true;
  if (record.code === 280 || record.codeName === 'ChangeStreamFatalError') return true;
  return typeof record.message === 'string' && /resume point may no longer be in the oplog|ChangeStreamHistoryLost/i.test(record.message);
}
