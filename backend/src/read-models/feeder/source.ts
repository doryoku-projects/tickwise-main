import mongoose from 'mongoose';
import type { ReadModelName } from '../core/fields.js';
import { changeStreamPipeline, scanProjection, type TrimLevel } from './change-stream.js';
import type { IdProbe } from './messages.js';
import { timeFromBson, tokenData, type ClusterTime } from './resume-token.js';

/**
 * Everything the feeder reads from Mongo, behind an interface so the feeder's
 * logic runs against a simulated cluster in the specs (`feeder-replay.spec`).
 *
 * The Mongo implementation is the feeder worker's OWN client (`appName
 * tw-feeder`, `maxPoolSize 4`), never the app's pool (design §2.4):
 *  - the change stream reads `secondaryPreferred` (light: it tails the oplog;
 *    stalling the models is worse than briefly tailing the primary);
 *  - scans, `_id` probes, T0 and repair reads use `secondary` in production
 *    (they FAIL rather than load the primary, §3.2) — `secondaryPreferred`
 *    elsewhere, so a single-node dev replica set can run the feeder;
 *  - scan batches and repairs read `majority` in a causally consistent
 *    session advanced to their `afterClusterTime` (≥ T0): a lagging secondary
 *    then waits instead of answering with a state older than T0, and nothing
 *    read can be rolled back (§3.2 step 6).
 */

export interface StreamHandle {
  /** The next event, or null when none arrived within the await window. Throws on stream errors. */
  tryNext(): Promise<Record<string, unknown> | null>;
  /** `_data` of the token after the last returned event (the postBatchResumeToken when drained). */
  resumeToken(): string | undefined;
  close(): Promise<void>;
}

export interface FeederSource {
  /** Collection names of the positions database. */
  listCollections(): Promise<string[]>;
  /** First and last `_id` of a collection: both ObjectIds ⇒ every `_id` is (F10). */
  idProbe(coll: string): Promise<IdProbe>;
  /** Can a stream start at `startAt` (is it inside the oplog)? */
  oplogProbe(startAt: ClusterTime, trim: TrimLevel): Promise<'ok' | 'history_lost'>;
  /** T0: the operationTime of a `majority` read on the scan member (§3.2 step 1). */
  majorityTime(): Promise<ClusterTime>;
  /** One keyset scan batch (`_id > afterOid`, ascending), `majority` after `afterClusterTime`; its snapshot time. */
  scanBatch(
    coll: string,
    model: ReadModelName,
    afterOid: string | null,
    limit: number,
    afterClusterTime: ClusterTime,
    trim: TrimLevel,
  ): Promise<{ docs: Array<Record<string, unknown>>; opTime: ClusterTime }>;
  /** A repair read of one document (`majority`, after `afterClusterTime`). */
  findOne(coll: string, model: ReadModelName, oid: string, afterClusterTime: ClusterTime, trim: TrimLevel): Promise<Record<string, unknown> | null>;
  /** Approximate document count (progress / ETA only). */
  estimatedCount(coll: string): Promise<number | undefined>;
  openStream(start: { at: ClusterTime } | { after: string }, trim: TrimLevel): Promise<StreamHandle>;
  /** The cluster's majority commit point (`hello` → `lastWrite.majorityOpTime`). */
  clusterMajority(): Promise<ClusterTime>;
  close(): Promise<void>;
}

export interface MongoSourceOptions {
  uri: string;
  scanReadPreference: 'secondary' | 'secondaryPreferred';
  appName?: string;
  maxPoolSize?: number;
}

const { MongoClient, ReadPreference, Timestamp, ObjectId } = mongoose.mongo;
type Client = InstanceType<typeof MongoClient>;

function toTimestamp(time: ClusterTime) {
  return new Timestamp({ t: time.t, i: time.i });
}

export class MongoFeederSource implements FeederSource {
  private readonly client: Client;
  private connected?: Promise<unknown>;
  private readonly scanPref: InstanceType<typeof ReadPreference>;

  constructor(private readonly opts: MongoSourceOptions) {
    this.client = new MongoClient(opts.uri, {
      appName: opts.appName ?? 'tw-feeder',
      maxPoolSize: opts.maxPoolSize ?? 4,
      // Scans of 2000 rows with a 30 s server limit; generous socket timeout.
      socketTimeoutMS: 60_000,
    });
    this.scanPref = opts.scanReadPreference === 'secondary' ? ReadPreference.secondary : ReadPreference.secondaryPreferred;
  }

  private async db() {
    this.connected ??= this.client.connect();
    await this.connected;
    return this.client.db();
  }

  async listCollections(): Promise<string[]> {
    const db = await this.db();
    const rows = await db.listCollections({}, { nameOnly: true, readPreference: this.scanPref }).toArray();
    return rows.map((row) => String((row as { name?: unknown }).name));
  }

  async idProbe(coll: string): Promise<IdProbe> {
    const db = await this.db();
    const ends = await Promise.all(
      [1, -1].map((dir) =>
        db
          .collection(coll)
          .find({}, { projection: { _id: 1 }, sort: { _id: dir as 1 | -1 }, limit: 1, readPreference: this.scanPref, maxTimeMS: 10_000 })
          .toArray(),
      ),
    );
    const first = ends[0][0]?._id as unknown;
    const last = ends[1][0]?._id as unknown;
    if (first === undefined && last === undefined) return 'empty';
    return first instanceof ObjectId && last instanceof ObjectId ? 'ok' : 'bad';
  }

  async oplogProbe(startAt: ClusterTime, trim: TrimLevel): Promise<'ok' | 'history_lost'> {
    const db = await this.db();
    const stream = db.watch(changeStreamPipeline(trim), {
      startAtOperationTime: toTimestamp(startAt),
      batchSize: 1,
      maxAwaitTimeMS: 200,
      readPreference: ReadPreference.secondaryPreferred,
    });
    try {
      await stream.tryNext();
      return 'ok';
    } catch (err) {
      const record = err as { code?: unknown; codeName?: unknown };
      if (record?.code === 286 || record?.codeName === 'ChangeStreamHistoryLost') return 'history_lost';
      throw err;
    } finally {
      await stream.close().catch(() => undefined);
    }
  }

  async majorityTime(): Promise<ClusterTime> {
    const db = await this.db();
    const session = this.client.startSession({ causalConsistency: true });
    try {
      const names = await this.listCollections();
      const coll = names.find((name) => /_(positions|pools)$/.test(name)) ?? names[0] ?? 'sync_cursors';
      await db.collection(coll).find({ _id: null as never }, { session, readConcern: { level: 'majority' }, readPreference: this.scanPref, limit: 1 }).toArray();
      const time = timeFromBson(session.operationTime);
      if (!time) throw new Error('majority read returned no operationTime');
      return time;
    } finally {
      await session.endSession().catch(() => undefined);
    }
  }

  async scanBatch(
    coll: string,
    model: ReadModelName,
    afterOid: string | null,
    limit: number,
    afterClusterTime: ClusterTime,
    trim: TrimLevel,
  ): Promise<{ docs: Array<Record<string, unknown>>; opTime: ClusterTime }> {
    const db = await this.db();
    const session = this.client.startSession({ causalConsistency: true });
    try {
      session.advanceOperationTime(toTimestamp(afterClusterTime));
      const filter = afterOid ? { _id: { $gt: new ObjectId(afterOid) } } : {};
      const docs = (await db
        .collection(coll)
        .find(filter as never, {
          session,
          readConcern: { level: 'majority' },
          readPreference: this.scanPref,
          projection: scanProjection(model, trim),
          sort: { _id: 1 },
          limit,
          maxTimeMS: 30_000,
        })
        .toArray()) as Array<Record<string, unknown>>;
      return { docs, opTime: timeFromBson(session.operationTime) ?? afterClusterTime };
    } finally {
      await session.endSession().catch(() => undefined);
    }
  }

  async findOne(coll: string, model: ReadModelName, oid: string, afterClusterTime: ClusterTime, trim: TrimLevel) {
    const db = await this.db();
    const session = this.client.startSession({ causalConsistency: true });
    try {
      session.advanceOperationTime(toTimestamp(afterClusterTime));
      return (await db.collection(coll).findOne({ _id: new ObjectId(oid) } as never, {
        session,
        readConcern: { level: 'majority' },
        readPreference: this.scanPref,
        projection: scanProjection(model, trim),
        maxTimeMS: 10_000,
      })) as Record<string, unknown> | null;
    } finally {
      await session.endSession().catch(() => undefined);
    }
  }

  async estimatedCount(coll: string): Promise<number | undefined> {
    try {
      const db = await this.db();
      return await db.collection(coll).estimatedDocumentCount({ readPreference: this.scanPref, maxTimeMS: 5_000 });
    } catch {
      return undefined;
    }
  }

  async openStream(start: { at: ClusterTime } | { after: string }, trim: TrimLevel): Promise<StreamHandle> {
    const db = await this.db();
    const stream = db.watch(changeStreamPipeline(trim), {
      ...('at' in start ? { startAtOperationTime: toTimestamp(start.at) } : { startAfter: { _data: start.after } }),
      fullDocument: 'default',
      batchSize: 1000,
      maxAwaitTimeMS: 500,
      readPreference: ReadPreference.secondaryPreferred,
    });
    return {
      tryNext: async () => (await stream.tryNext()) as Record<string, unknown> | null,
      resumeToken: () => tokenData(stream.resumeToken),
      close: async () => {
        await stream.close().catch(() => undefined);
      },
    };
  }

  async clusterMajority(): Promise<ClusterTime> {
    const db = await this.db();
    const hello = (await db.admin().command({ hello: 1 })) as { lastWrite?: { majorityOpTime?: { ts?: unknown } }; operationTime?: unknown };
    const time = timeFromBson(hello.lastWrite?.majorityOpTime?.ts) ?? timeFromBson(hello.operationTime);
    if (!time) throw new Error('hello carried no majority optime (not a replica set?)');
    return time;
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => undefined);
  }
}
