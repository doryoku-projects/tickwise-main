import { CLS } from './cells.js';
import { DictionaryMismatchError } from './dictionary.js';
import { type ReadModelName, type ShardKey } from './fields.js';
import { ShardTable, type QuarantineListener } from './row-store.js';
import { decodePayload, type DeltaEntry, type DeltaRecord } from '../feeder/delta-codec.js';

/**
 * Where a replica's model stands in the delta stream: the (fence, epoch, s)
 * order of the last entry it applied (design §2.5), that entry's stream id,
 * resume token, cluster time and confirm time, and the redis-models
 * incarnation it came from.
 */
export interface StreamPosition {
  fence: number;
  epoch: number;
  s: number;
  /** Stream id of the last applied entry (`0-0` before any). */
  id: string;
  rt: string;
  ct: string;
  /** Wall time (ms) the feeder last confirmed it was caught up, as of the last applied entry. */
  ca: number;
  inc: string;
  /**
   * The last applied entry was appended while the holder's position was
   * frozen (a repair blocked): the rows may be newer than `ct`. The pool
   * catalog and the rank engine neither serve nor lane-check it.
   */
  frozen?: boolean;
}

export const NO_POSITION: Readonly<StreamPosition> = Object.freeze({
  fence: 0,
  epoch: 0,
  s: 0,
  id: '0-0',
  rt: '',
  ct: '0:0',
  ca: 0,
  inc: '',
});

/** The model's contents broke the protocol's invariants: the replica must reload from a snapshot. */
export class ModelDivergedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelDivergedError';
  }
}

/**
 * Every (model, shard) table of this process plus its stream position. The
 * holder applies its own entries after they were appended (apply-after-append,
 * §2.4) and every other replica applies them from the stream, through the
 * same `applyEntry`, so all replicas hold identical tables and dictionaries.
 *
 * `hold()` / `release()` freeze the tables while a snapshot is encoded from
 * them (§3.5: snapshots are captured from one consistent state): entries
 * applied meanwhile queue and are applied, in order, on release.
 */
export class ModelStore {
  readonly tables = new Map<string, ShardTable>();
  pos: StreamPosition = { ...NO_POSITION };
  private held = 0;
  private readonly queue: DeltaEntry[] = [];

  constructor(
    /** The models this process keeps (records for others are skipped). */
    public models: Set<ReadModelName>,
    private readonly opts: { capacityFor?: (model: ReadModelName, shard: ShardKey) => number; onQuarantine?: QuarantineListener } = {},
  ) {}

  static key(model: ReadModelName, shard: ShardKey): string {
    return `${model}|${shard}`;
  }

  table(model: ReadModelName, shard: ShardKey): ShardTable | undefined {
    return this.tables.get(ModelStore.key(model, shard));
  }

  /** The table for (model, shard), created empty (state `scanning`) when absent. */
  ensureTable(model: ReadModelName, shard: ShardKey): ShardTable {
    const key = ModelStore.key(model, shard);
    let table = this.tables.get(key);
    if (!table) {
      table = new ShardTable(model, shard, this.opts.capacityFor?.(model, shard) ?? 1024, undefined, this.opts.onQuarantine);
      this.tables.set(key, table);
    }
    return table;
  }

  /** Replace the table for (model, shard) (a snapshot load). */
  setTable(table: ShardTable): void {
    this.tables.set(ModelStore.key(table.model, table.shard), table);
  }

  get onQuarantine(): QuarantineListener | undefined {
    return this.opts.onQuarantine;
  }

  /** Drop the tables of `model` (the kill switch turned it off). */
  dropModel(model: ReadModelName): void {
    for (const [key, table] of this.tables) if (table.model === model) this.tables.delete(key);
  }

  /** Drop everything (a reload or a new epoch). */
  clear(): void {
    this.tables.clear();
    this.queue.length = 0;
    this.pos = { ...NO_POSITION };
  }

  get isHeld(): boolean {
    return this.held > 0;
  }

  get queued(): number {
    return this.queue.length;
  }

  hold(): void {
    this.held++;
  }

  /** Release a hold; when the last one goes, apply the queued entries in order. */
  release(): void {
    if (this.held === 0) return;
    this.held--;
    if (this.held > 0) return;
    while (this.queue.length > 0 && this.held === 0) this.applyNow(this.queue.shift()!);
  }

  /**
   * Apply one entry's records and advance the position. The caller has
   * already decided the entry is the next one (contiguity, fence floor —
   * `delta-consumer.ts` / the holder). Throws `ModelDivergedError` when a
   * record cannot be applied consistently (a dictionary id out of step, a
   * corrupt payload): the replica must reload.
   */
  applyEntry(entry: DeltaEntry): void {
    if (this.held > 0) {
      this.queue.push(entry);
      return;
    }
    this.applyNow(entry);
  }

  /** The position as of the last QUEUED-or-applied entry (what the holder appends after). */
  get tailPosition(): StreamPosition {
    const last = this.queue[this.queue.length - 1];
    return last ? positionOf(last) : this.pos;
  }

  private applyNow(entry: DeltaEntry): void {
    let records: DeltaRecord[];
    try {
      records = decodePayload(entry.d);
    } catch (err) {
      throw new ModelDivergedError(`entry ${entry.id ?? '?'} s=${entry.s}: ${(err as Error).message}`);
    }
    this.applyRecords(records);
    this.pos = positionOf(entry);
  }

  /** Apply records (no position change): scans building a model locally, and `applyEntry`. */
  applyRecords(records: readonly DeltaRecord[]): void {
    for (const record of records) {
      if (!this.models.has(record.model)) continue;
      const table = this.ensureTable(record.model, record.shard);
      switch (record.t) {
        case 'dict':
          try {
            table.dict.addAt(record.id, record.value);
          } catch (err) {
            if (err instanceof DictionaryMismatchError) throw new ModelDivergedError(`${record.model} ${record.shard}: ${err.message}`);
            throw err;
          }
          break;
        case 'upsert':
          for (let l = 0; l < table.leaves.length; l++) {
            const kind = table.leaves[l].kind;
            if (kind === 'str' && record.row.cls[l] === CLS.STR && record.row.val[l] >= table.dict.size) {
              throw new ModelDivergedError(`${record.model} ${record.shard}: row ${record.oid} names dictionary id ${record.row.val[l]} (size ${table.dict.size})`);
            }
          }
          table.upsert(record.oid, record.row);
          if (record.cells !== undefined) for (let l = record.cells; l < table.leaves.length; l++) table.missingLeaves.add(l);
          break;
        case 'delete':
          table.delete(record.oid);
          break;
        case 'shard':
          switch (record.state) {
            case 'scanning':
              table.state = 'scanning';
              break;
            case 'reset':
              table.reset();
              break;
            case 'ready':
              table.state = 'ready';
              break;
            case 'unsupported':
              table.reset();
              table.state = 'unsupported';
              break;
          }
          break;
      }
    }
  }

  /** Live rows and bytes, per (model, shard). */
  stats(): Array<{ model: ReadModelName; shard: ShardKey; state: string; rows: number; slots: number; dict: number; bytes: number; quarantine: Record<string, number>; missingLeaves: string[] }> {
    return [...this.tables.values()].map((t) => ({
      model: t.model,
      shard: t.shard,
      state: t.state,
      rows: t.live,
      slots: t.slots,
      dict: t.dict.size,
      bytes: t.memoryBytes,
      quarantine: t.quarantineCounts(),
      missingLeaves: [...t.missingLeaves].map((l) => t.leaves[l].name),
    }));
  }

  get memoryBytes(): number {
    let total = 0;
    for (const table of this.tables.values()) total += table.memoryBytes;
    return total;
  }
}

export function positionOf(entry: DeltaEntry): StreamPosition {
  return { fence: entry.f, epoch: entry.e, s: entry.s, id: entry.id ?? '0-0', rt: entry.rt, ct: entry.ct, ca: entry.ca, inc: entry.inc, ...(entry.fz ? { frozen: true } : {}) };
}
