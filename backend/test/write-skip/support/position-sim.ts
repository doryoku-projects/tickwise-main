/*
 * An in-memory positions shard for the write-skip specs, faithful where the
 * skip decisions are judged:
 *  - every update op goes through Mongoose's OWN cast (`castUpdateOne`, what
 *    `Model.bulkWrite` runs), so defaults of a whole-subdoc `$set`, strict mode
 *    (undeclared paths dropped), `setDefaultsOnInsert` and timestamps are the
 *    real ones;
 *  - the cast operators are applied with MongoDB's semantics: dotted `$set`
 *    creates missing parents and REFUSES a non-object parent (code 28, the
 *    op fails, an unordered bulk carries on and throws a bulk error at the
 *    end), `$unset` of a missing path is a no-op, `$setOnInsert` only on insert;
 *  - `find` supports the filters / projections `PositionsRepository` sends on
 *    the write path, including the `$type` expression projection (`_wt`).
 * Verified against a real mongod by `real-mongo-parity.spec.ts` (opt-in).
 */
import 'reflect-metadata';
import { createRequire } from 'node:module';
import mongoose from 'mongoose';
import { PositionSchema } from '../../../src/database/schemas/position.schema.js';

const require = createRequire(import.meta.url);
const { castUpdateOne } = require('mongoose/lib/helpers/model/castBulkWrite.js') as {
  castUpdateOne: (model: mongoose.Model<unknown>, op: Record<string, unknown>, options: Record<string, unknown>, now: Date) => void;
};

export type Doc = Record<string, unknown>;

const SimModel = (mongoose.models.WriteSkipSimPosition as mongoose.Model<unknown> | undefined)
  ?? mongoose.model('WriteSkipSimPosition', PositionSchema);

/** A value as MongoDB stores it: Mongoose docs → plain, Dates / bytes copied. */
export function plain(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return new Date(value.getTime());
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value !== 'object') return value;
  const bson = (value as { _bsontype?: unknown })._bsontype;
  if (bson === 'Binary') {
    const b = value as { buffer: Uint8Array; position?: number };
    return Buffer.from(b.buffer.subarray(0, b.position ?? b.buffer.length));
  }
  if (bson === 'ObjectId' || bson === 'ObjectID') return value;
  if (typeof (value as { toBSON?: unknown }).toBSON === 'function') {
    return plain((value as { toBSON: () => unknown }).toBSON());
  }
  if (Array.isArray(value)) return value.map(plain);
  const out: Doc = {};
  for (const [k, v] of Object.entries(value as Doc)) {
    if (v === undefined) continue;
    out[k] = plain(v);
  }
  return out;
}

function getPath(doc: Doc, path: string): unknown {
  let cur: unknown = doc;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Doc)[part];
  }
  return cur;
}

class PathError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

function setPath(doc: Doc, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur: Doc = doc;
  for (const part of parts.slice(0, -1)) {
    const next = cur[part];
    if (next === undefined) {
      cur[part] = {};
    } else if (next === null || typeof next !== 'object' || Array.isArray(next) || next instanceof Date || Buffer.isBuffer(next)) {
      throw new PathError(28, `Cannot create field '${parts.at(-1)}' in element {${part}: ${JSON.stringify(next)}}`);
    }
    cur = cur[part] as Doc;
  }
  cur[parts.at(-1)!] = plain(value);
}

function unsetPath(doc: Doc, path: string): void {
  const parts = path.split('.');
  let cur: unknown = doc;
  for (const part of parts.slice(0, -1)) {
    if (cur === null || typeof cur !== 'object') return;
    cur = (cur as Doc)[part];
  }
  if (cur !== null && typeof cur === 'object') delete (cur as Doc)[parts.at(-1)!];
}

function equalValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    // Bytes (a stored Buffer vs a filter's Buffer / BSON Binary).
    const x = plain(a);
    const y = plain(b);
    if (Buffer.isBuffer(x) && Buffer.isBuffer(y)) return x.equals(y);
  }
  return a === b;
}

function compare(a: unknown, b: unknown): number {
  const x = a instanceof Date ? a.getTime() : (a as number);
  const y = b instanceof Date ? b.getTime() : (b as number);
  return x < y ? -1 : x > y ? 1 : 0;
}

function matchCondition(value: unknown, cond: unknown): boolean {
  if (cond !== null && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
    const ops = cond as Doc;
    const keys = Object.keys(ops);
    if (keys.length > 0 && keys.every((k) => k.startsWith('$'))) {
      return keys.every((op) => {
        const arg = ops[op];
        switch (op) {
          case '$in':
            return (arg as unknown[]).some((x) => equalValue(value, x));
          case '$ne':
            return !equalValue(value, arg);
          case '$exists':
            return (value !== undefined) === Boolean(arg);
          case '$gt':
            return value !== undefined && value !== null && compare(value, arg) > 0;
          case '$gte':
            return value !== undefined && value !== null && compare(value, arg) >= 0;
          case '$lt':
            return value !== undefined && value !== null && compare(value, arg) < 0;
          case '$not':
            return !matchCondition(value, arg);
          default:
            throw new Error(`sim: unsupported operator ${op}`);
        }
      });
    }
  }
  return equalValue(value, cond);
}

export function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([path, cond]) => matchCondition(getPath(doc, path), cond));
}

function bsonType(value: unknown): string {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Date) return 'date';
  if (Buffer.isBuffer(value)) return 'binData';
  if (typeof value === 'object') return 'object';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'double';
  if (typeof value === 'boolean') return 'bool';
  return typeof value;
}

function project(doc: Doc, projection: Doc | undefined, typeProjection = true): Doc {
  if (!projection) return plain(doc) as Doc;
  const out: Doc = {};
  for (const [key, spec] of Object.entries(projection)) {
    if (spec === 0) continue;
    if (spec === 1) {
      const value = getPath(doc, key);
      if (value === undefined) continue;
      const parts = key.split('.');
      let cur = out;
      for (const part of parts.slice(0, -1)) cur = (cur[part] ??= {}) as Doc;
      cur[parts.at(-1)!] = plain(value);
      continue;
    }
    // A computed field: an object of `{$type: '$path'}` expressions.
    if (!typeProjection) continue;
    const computed: Doc = {};
    for (const [name, expr] of Object.entries(spec as Doc)) {
      const path = String((expr as { $type: string }).$type).slice(1);
      computed[name] = bsonType(getPath(doc, path));
    }
    out[key] = computed;
  }
  if (projection._id !== 0 && doc._id !== undefined) out._id = doc._id;
  return out;
}

export interface SimWriteError {
  index: number;
  code: number;
  errmsg: string;
}

/** A shard: `find` / `bulkWrite` / `updateMany` over an in-memory map. */
export class PositionSim {
  readonly docs: Doc[] = [];
  readonly ops: Array<{ kind: string; op: unknown }> = [];
  private seq = 0;
  /** The clock Mongoose's timestamps read (`castUpdateOne`). */
  now: () => Date = () => new Date();
  /** false = a server that ignores the `$type` projection (the legacy-shape guard then rests on the write-error fallback). */
  typeProjection = true;
  /** Runs before each bulkWrite is applied (a spec deletes a row between the read and the write). */
  beforeBulkWrite?: (ops: Array<Record<string, Doc>>) => void;
  /** A write error code the server answers an op with instead of applying it (undefined = apply). */
  injectWriteError?: (op: Doc, index: number) => number | undefined;

  /** Every `find` filter / projection the repository sent, in order. */
  readonly finds: Array<{ filter: Doc; projection?: Doc }> = [];

  find(filter: Doc, projection?: Doc) {
    this.finds.push({ filter, projection });
    const rows = () => this.docs.filter((d) => matches(d, filter)).map((d) => project(d, projection, this.typeProjection));
    const query = {
      lean: () =>
        Object.assign(Promise.resolve().then(rows), {
          cursor: () => ({
            async *[Symbol.asyncIterator]() {
              for (const row of rows()) yield row;
            },
          }),
        }),
      select: () => query,
      read: () => query,
      hint: () => query,
    };
    return query;
  }

  private applyOne(op: Doc): { matched: number; modified: number; upserted: number } {
    const update = op.update as Doc;
    const filter = op.filter as Doc;
    const existing = this.docs.filter((d) => matches(d, filter));
    const sets = (update.$set ?? {}) as Doc;
    const unsets = Object.keys((update.$unset ?? {}) as Doc);
    for (const k of unsets) if (k in sets) throw new PathError(40, `Updating the path '${k}' would create a conflict`);
    if (existing.length === 0) {
      if (!op.upsert) return { matched: 0, modified: 0, upserted: 0 };
      // The unique `{chainId, protocol, positionId}` index: an upsert whose
      // filter matched nothing (a guard refused the stored row) inserts a
      // duplicate and fails E11000, as the server does.
      if (
        this.docs.some((d) => d.chainId === filter.chainId && d.protocol === filter.protocol && d.positionId === filter.positionId)
      ) {
        throw new PathError(11000, `E11000 duplicate key error dup key: { positionId: "${String(filter.positionId)}" }`);
      }
      const doc: Doc = { _id: `sim${++this.seq}` };
      for (const [k, v] of Object.entries(filter)) {
        if (v === null || typeof v !== 'object' || v instanceof Date) setPath(doc, k, v);
      }
      for (const [k, v] of Object.entries((update.$setOnInsert ?? {}) as Doc)) setPath(doc, k, v);
      for (const [k, v] of Object.entries(sets)) setPath(doc, k, v);
      for (const k of unsets) unsetPath(doc, k);
      this.docs.push(doc);
      return { matched: 0, modified: 0, upserted: 1 };
    }
    const target = existing[0]!;
    const next = plain(target) as Doc;
    for (const [k, v] of Object.entries(sets)) setPath(next, k, v);
    for (const k of unsets) unsetPath(next, k);
    const changed = JSON.stringify(next) !== JSON.stringify(plain(target));
    for (const key of Object.keys(target)) delete target[key];
    Object.assign(target, next);
    return { matched: 1, modified: changed ? 1 : 0, upserted: 0 };
  }

  async bulkWrite(ops: Array<Record<string, Doc>>, _options?: unknown) {
    const result = { matchedCount: 0, modifiedCount: 0, upsertedCount: 0, insertedCount: 0, deletedCount: 0, upsertedIds: {} as Record<number, unknown> };
    const writeErrors: SimWriteError[] = [];
    this.beforeBulkWrite?.(ops);
    ops.forEach((wrapper, index) => {
      const op = { ...(wrapper.updateOne as Doc) };
      op.update = structuredCloneUpdate(op.update as Doc);
      castUpdateOne(SimModel, op, {}, this.now());
      this.ops.push({ kind: 'updateOne', op });
      try {
        const injected = this.injectWriteError?.(op, index);
        if (injected !== undefined) throw new PathError(injected, `sim injected error ${injected}`);
        const r = this.applyOne(op);
        result.matchedCount += r.matched;
        result.modifiedCount += r.modified;
        result.upsertedCount += r.upserted;
        if (r.upserted) result.upsertedIds[index] = this.docs.at(-1)!._id;
      } catch (err) {
        if (!(err instanceof PathError)) throw err;
        writeErrors.push({ index, code: err.code, errmsg: err.message });
      }
    });
    if (writeErrors.length > 0) {
      const error = new Error(`sim bulk write error: ${writeErrors.map((e) => e.errmsg).join('; ')}`) as Error & { writeErrors: SimWriteError[]; result: typeof result };
      error.name = 'MongoBulkWriteError';
      error.writeErrors = writeErrors;
      error.result = result;
      throw error;
    }
    return result;
  }

  async updateMany(filter: Doc, update: Doc, options?: Doc) {
    const op: Doc = { filter, update: structuredCloneUpdate(update), ...(options !== undefined ? { options } : {}) };
    // `updateMany` casts like `updateOne` (no upsert here).
    castUpdateOne(SimModel, op, {}, this.now());
    this.ops.push({ kind: 'updateMany', op });
    let matched = 0;
    let modified = 0;
    for (const doc of this.docs.filter((d) => matches(d, filter))) {
      const next = plain(doc) as Doc;
      for (const [k, v] of Object.entries(((op.update as Doc).$set ?? {}) as Doc)) setPath(next, k, v);
      for (const [k, v] of Object.entries(((op.update as Doc).$inc ?? {}) as Doc)) setPath(next, k, Number(getPath(next, k) ?? 0) + Number(v));
      for (const k of Object.keys(((op.update as Doc).$unset ?? {}) as Doc)) unsetPath(next, k);
      matched++;
      if (JSON.stringify(next) !== JSON.stringify(plain(doc))) modified++;
      for (const key of Object.keys(doc)) delete doc[key];
      Object.assign(doc, next);
    }
    return { matchedCount: matched, modifiedCount: modified };
  }

  byId(positionId: string): Doc | undefined {
    return this.docs.find((d) => d.positionId === positionId);
  }

  remove(positionId: string): void {
    const i = this.docs.findIndex((d) => d.positionId === positionId);
    if (i >= 0) this.docs.splice(i, 1);
  }
}

/** A deep copy of an update document that keeps Dates and Buffers (castUpdateOne mutates its input). */
function structuredCloneUpdate(update: Doc): Doc {
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (v instanceof Date) return new Date(v.getTime());
    if (Buffer.isBuffer(v)) return Buffer.from(v);
    if ((v as { _bsontype?: unknown })._bsontype !== undefined) return v; // ObjectId, Binary: as the driver gets them
    if (Array.isArray(v)) return v.map(walk);
    const out: Doc = {};
    for (const [k, x] of Object.entries(v as Doc)) out[k] = walk(x);
    return out;
  };
  return walk(update) as Doc;
}

/** Fields that legitimately differ between skip off and on (design §4.5 parity list + `rawSubgraph`, full-write only). */
export const PARITY_EXCLUDED_TOP = new Set([
  '_id',
  '__v',
  'createdAt',
  'updatedAt',
  'lastVerifiedAt',
  'lastSyncedAt',
  'wh',
  'wAt',
  'rawSubgraph',
]);

/** A stored doc as compared by the parity specs (subdocument `_id`s and the excluded leaves removed). */
export function comparable(doc: Doc | undefined): Doc | undefined {
  if (!doc) return undefined;
  const strip = (value: unknown, top: boolean): unknown => {
    if (Array.isArray(value)) return value.map((v) => strip(v, false));
    if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
      const out: Doc = {};
      for (const [k, v] of Object.entries(value as Doc)) {
        if (k === '_id') continue;
        if (top && PARITY_EXCLUDED_TOP.has(k)) continue;
        out[k] = strip(v, false);
      }
      return out;
    }
    return value;
  };
  const out = strip(plain(doc), true) as Doc;
  if (out.pricing && typeof out.pricing === 'object') delete (out.pricing as Doc).pricedAt;
  if (out.metrics && typeof out.metrics === 'object') delete (out.metrics as Doc).ageSeconds;
  return out;
}
