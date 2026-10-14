/**
 * A driver-shaped in-memory database for the impact-report specs: the subset
 * of the MongoDB Node driver the report touches (`listCollections`,
 * `collection().find(filter, {projection, sort, limit, …}).toArray()`,
 * `aggregate`, `listIndexes`), with matching and sorting from
 * `test/support/mini-mongo.ts` (MongoDB's own semantics, written independently
 * of the report). Every call is recorded, and the collection object ALSO
 * carries write methods that throw — so a spec can prove the report's
 * read-only wrapper never reaches them.
 */
import { matches, mongoSort, type Doc } from '../support/mini-mongo.js';

export interface FakeCall {
  collection?: string;
  op: string;
  filter?: Doc;
  opts?: Record<string, unknown>;
}

export interface FakeIndex {
  name: string;
  key: Record<string, number>;
  partialFilterExpression?: Doc;
  collation?: { locale: string };
}

function at(doc: unknown, path: string): unknown {
  let current: unknown = doc;
  for (const key of path.split('.')) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function project(doc: Doc, projection: Record<string, number> | undefined): Doc {
  if (!projection) return structuredClone(doc);
  const include = Object.entries(projection).filter(([k, v]) => v === 1 && k !== '_id');
  if (include.length === 0) return structuredClone(doc);
  const out: Doc = {};
  for (const [path] of include) {
    const value = at(doc, path);
    if (value === undefined) continue;
    const keys = path.split('.');
    let target = out;
    for (const key of keys.slice(0, -1)) {
      target[key] = (target[key] as Doc | undefined) ?? {};
      target = target[key] as Doc;
    }
    target[keys[keys.length - 1]!] = structuredClone(value);
  }
  return out;
}

const WRITE_METHODS = [
  'insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany',
  'bulkWrite', 'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace', 'createIndex', 'createIndexes',
  'dropIndex', 'dropIndexes', 'drop', 'rename',
];

export function fakeDb(collections: Record<string, Doc[]>, indexes: Record<string, FakeIndex[]> = {}) {
  const calls: FakeCall[] = [];
  const writes: string[] = [];
  const collection = (name: string) => {
    const coll: Record<string, unknown> = {
      find: (filter: Doc, opts: Record<string, unknown> = {}) => {
        calls.push({ collection: name, op: 'find', filter, opts });
        return {
          toArray: async () => {
            let rows = (collections[name] ?? []).filter((d) => matches(d, filter, false));
            if (opts.sort) rows = mongoSort(rows, opts.sort as Record<string, 1 | -1>, false);
            if (typeof opts.limit === 'number' && opts.limit > 0) rows = rows.slice(0, opts.limit);
            return rows.map((d) => project(d, opts.projection as Record<string, number> | undefined));
          },
        };
      },
      aggregate: (pipeline: Doc[]) => {
        calls.push({ collection: name, op: 'aggregate', opts: { pipeline } });
        return { toArray: async () => [] };
      },
      listIndexes: () => {
        calls.push({ collection: name, op: 'listIndexes' });
        return { toArray: async () => indexes[name] ?? [] };
      },
    };
    for (const m of WRITE_METHODS) {
      coll[m] = () => {
        writes.push(`${name}.${m}`);
        throw new Error(`fake db: write ${m} attempted on ${name}`);
      };
    }
    return coll;
  };
  const db = {
    listCollections: (_filter?: Doc, _opts?: Doc) => {
      calls.push({ op: 'listCollections' });
      return { toArray: async () => Object.keys(collections).map((name) => ({ name, type: 'collection' })) };
    },
    collection,
    dropDatabase: () => {
      writes.push('dropDatabase');
      throw new Error('fake db: dropDatabase attempted');
    },
    createCollection: () => {
      writes.push('createCollection');
      throw new Error('fake db: createCollection attempted');
    },
  };
  return { db, calls, writes };
}
