import { leavesOf, parseShardKey, shardKey, type ReadModelName, type ShardKey } from '../core/fields.js';
import { CLS } from '../core/cells.js';
import { OID_BYTES, oidToBytes, oidToHex } from '../core/oid-map.js';

/**
 * The delta stream's entries (design §3.4).
 *
 * An entry is the header fields of one Redis stream entry plus a binary
 * payload `d` — a list of records:
 *  - `dict`   — a dictionary add `(model, shard, id, value)`, always BEFORE
 *               the rows that use the id;
 *  - `upsert` — a row's FULL state (not a diff) keyed by its 12-byte `_id`,
 *               cells in the model's leaf order: applying an entry twice in
 *               sequence order is harmless;
 *  - `delete` — a tombstone by `_id`;
 *  - `shard`  — a shard lifecycle mark: `scanning` (not served until
 *               `ready`), `reset` (drop every row: the shard is being
 *               rescanned, or was dropped), `ready`, `unsupported` (its `_id`s
 *               are not all ObjectIds: never served).
 *
 * Rows are keyed by `_id` rather than the design's pid / pool index: one key
 * for both models, independent of the values the engine quarantines.
 *
 * Payload layout (little-endian):
 *   u32 magic 'RMD1' · u8 version · u16 shardCount · shards · u32 recordCount · records
 *   shard:   u8 model (0 rank, 1 pools) · u32 chainId · u8 len · protocol utf8
 *   record:  u8 type · u16 shard index · body
 *     dict:    u32 id · u32 len · utf8
 *     upsert:  12 B oid · u8 cellCount · cells (u8 class [+ f64 NUM | u32 STR/PID])
 *     delete:  12 B oid
 *     shard:   u8 state (1 scanning, 2 reset, 3 ready, 4 unsupported)
 * `cellCount` makes the format additive: a reader ignores trailing cells it
 * does not know and reports rows that carry fewer than it knows (`cells`).
 */

export type ShardRecordState = 'scanning' | 'reset' | 'ready' | 'unsupported';

/** A row as columns hold it: per leaf a class byte and a value (f64 for NUM, dict id for STR, the id for PID, else 0). */
export interface EncodedRow {
  cls: Uint8Array;
  val: Float64Array;
}

export type DeltaRecord =
  | { t: 'dict'; model: ReadModelName; shard: ShardKey; id: number; value: string }
  | { t: 'upsert'; model: ReadModelName; shard: ShardKey; oid: string; row: EncodedRow; cells?: number }
  | { t: 'delete'; model: ReadModelName; shard: ShardKey; oid: string }
  | { t: 'shard'; model: ReadModelName; shard: ShardKey; state: ShardRecordState };

export type EntryKind = 'batch' | 'heartbeat' | 'shard';

/** One delta-stream entry (design §3.4 entry fields). */
export interface DeltaEntry {
  /** The stream id (`<ms>-<seq>`), set when read back. */
  id?: string;
  /** Fence of the holder that appended it. */
  f: number;
  /** Epoch. */
  e: number;
  /** redis-models incarnation it was appended into. */
  inc: string;
  /** Sequence, contiguous per epoch across every kind (heartbeats included). */
  s: number;
  /** Cluster time of the last change it contains (or the stream position for a heartbeat), `t:i`. */
  ct: string;
  /** Resume token `_data` after which the feeder resumes. */
  rt: string;
  k: EntryKind;
  /** Wall time (ms) the feeder last confirmed it was caught up. */
  ca: number;
  /** The record payload (empty for a heartbeat). */
  d: Uint8Array;
  /**
   * The holder's position is FROZEN (a repair is blocked): the entry claims
   * the `rt` / `ct` from before the blocked change while carrying newer rows,
   * so a reader's rows are newer than its `ct` (the engines neither serve nor
   * lane-check such a generation). Absent = not frozen (older entries too).
   */
  fz?: boolean;
}

const MAGIC = 0x31444d52; // 'RMD1'
const VERSION = 1;
const TYPE = { dict: 1, upsert: 2, delete: 3, shard: 4 } as const;
const SHARD_STATE: Record<ShardRecordState, number> = { scanning: 1, reset: 2, ready: 3, unsupported: 4 };
const SHARD_STATE_BY_CODE: Array<ShardRecordState | undefined> = [undefined, 'scanning', 'reset', 'ready', 'unsupported'];
const MODEL_CODE: Record<ReadModelName, number> = { rank: 0, pools: 1 };
const MODEL_BY_CODE: ReadModelName[] = ['rank', 'pools'];

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** An empty payload (a heartbeat). */
export const EMPTY_PAYLOAD = new Uint8Array(0);

class Writer {
  private buf = new Uint8Array(4096);
  private view = new DataView(this.buf.buffer);
  at = 0;

  private ensure(n: number): void {
    if (this.at + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.at + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.at));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
  u8(v: number) {
    this.ensure(1);
    this.view.setUint8(this.at, v);
    this.at += 1;
  }
  u16(v: number) {
    this.ensure(2);
    this.view.setUint16(this.at, v, true);
    this.at += 2;
  }
  u32(v: number) {
    this.ensure(4);
    this.view.setUint32(this.at, v >>> 0, true);
    this.at += 4;
  }
  f64(v: number) {
    this.ensure(8);
    this.view.setFloat64(this.at, v, true);
    this.at += 8;
  }
  bytes(b: Uint8Array) {
    this.ensure(b.length);
    this.buf.set(b, this.at);
    this.at += b.length;
  }
  oid(hex: string) {
    this.ensure(OID_BYTES);
    if (!oidToBytes(hex, this.buf, this.at)) throw new Error(`not an ObjectId hex: ${hex}`);
    this.at += OID_BYTES;
  }
  done(): Uint8Array {
    return this.buf.slice(0, this.at);
  }
}

class Reader {
  private readonly view: DataView;
  at = 0;
  constructor(private readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  private need(n: number) {
    if (this.at + n > this.buf.length) throw new DeltaCodecError(`payload truncated at ${this.at} (+${n} of ${this.buf.length})`);
  }
  u8() {
    this.need(1);
    return this.view.getUint8(this.at++);
  }
  u16() {
    this.need(2);
    const v = this.view.getUint16(this.at, true);
    this.at += 2;
    return v;
  }
  u32() {
    this.need(4);
    const v = this.view.getUint32(this.at, true);
    this.at += 4;
    return v;
  }
  f64() {
    this.need(8);
    const v = this.view.getFloat64(this.at, true);
    this.at += 8;
    return v;
  }
  str(len: number) {
    this.need(len);
    const s = decoder.decode(this.buf.subarray(this.at, this.at + len));
    this.at += len;
    return s;
  }
  oid() {
    this.need(OID_BYTES);
    const hex = oidToHex(this.buf, this.at);
    this.at += OID_BYTES;
    return hex;
  }
  get remaining() {
    return this.buf.length - this.at;
  }
}

export class DeltaCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeltaCodecError';
  }
}

function cellHasF64(cls: number): boolean {
  return cls === CLS.NUM;
}
function cellHasU32(cls: number): boolean {
  return cls === CLS.STR || cls === CLS.PID;
}

/** Records → payload bytes. */
export function encodePayload(records: readonly DeltaRecord[]): Uint8Array {
  if (records.length === 0) return EMPTY_PAYLOAD;
  const shards: Array<{ model: ReadModelName; shard: ShardKey }> = [];
  const shardIndex = new Map<string, number>();
  const indexOf = (model: ReadModelName, shard: ShardKey) => {
    const key = `${model}|${shard}`;
    let idx = shardIndex.get(key);
    if (idx === undefined) {
      idx = shards.length;
      shards.push({ model, shard });
      shardIndex.set(key, idx);
    }
    return idx;
  };
  for (const record of records) indexOf(record.model, record.shard);
  if (shards.length > 0xffff) throw new DeltaCodecError('too many shards in one payload');

  const w = new Writer();
  w.u32(MAGIC);
  w.u8(VERSION);
  w.u16(shards.length);
  for (const { model, shard } of shards) {
    const { chainId, protocol } = parseShardKey(shard);
    const proto = encoder.encode(protocol);
    if (proto.length > 255) throw new DeltaCodecError('protocol name too long');
    w.u8(MODEL_CODE[model]);
    w.u32(chainId);
    w.u8(proto.length);
    w.bytes(proto);
  }
  w.u32(records.length);
  for (const record of records) {
    w.u8(TYPE[record.t]);
    w.u16(indexOf(record.model, record.shard));
    switch (record.t) {
      case 'dict': {
        const bytes = encoder.encode(record.value);
        w.u32(record.id);
        w.u32(bytes.length);
        w.bytes(bytes);
        break;
      }
      case 'upsert': {
        const { cls, val } = record.row;
        if (cls.length > 255) throw new DeltaCodecError('too many cells');
        w.oid(record.oid);
        w.u8(cls.length);
        for (let i = 0; i < cls.length; i++) {
          w.u8(cls[i]);
          if (cellHasF64(cls[i])) w.f64(val[i]);
          else if (cellHasU32(cls[i])) w.u32(val[i]);
        }
        break;
      }
      case 'delete':
        w.oid(record.oid);
        break;
      case 'shard':
        w.u8(SHARD_STATE[record.state]);
        break;
    }
  }
  return w.done();
}

/** Payload bytes → records (throws `DeltaCodecError` on anything malformed). */
export function decodePayload(payload: Uint8Array): DeltaRecord[] {
  if (payload.length === 0) return [];
  const r = new Reader(payload);
  if (r.u32() !== MAGIC) throw new DeltaCodecError('bad payload magic');
  const version = r.u8();
  if (version !== VERSION) throw new DeltaCodecError(`unsupported payload version ${version}`);
  const shardCount = r.u16();
  const shards: Array<{ model: ReadModelName; shard: ShardKey }> = [];
  for (let i = 0; i < shardCount; i++) {
    const model = MODEL_BY_CODE[r.u8()];
    if (!model) throw new DeltaCodecError('unknown model code');
    const chainId = r.u32();
    const protocol = r.str(r.u8());
    shards.push({ model, shard: shardKey(chainId, protocol) });
  }
  const count = r.u32();
  const out: DeltaRecord[] = [];
  for (let i = 0; i < count; i++) {
    const type = r.u8();
    const at = shards[r.u16()];
    if (!at) throw new DeltaCodecError('record names an unknown shard');
    const { model, shard } = at;
    switch (type) {
      case TYPE.dict: {
        const id = r.u32();
        out.push({ t: 'dict', model, shard, id, value: r.str(r.u32()) });
        break;
      }
      case TYPE.upsert: {
        const oid = r.oid();
        const cellCount = r.u8();
        const known = leavesOf(model).length;
        const cls = new Uint8Array(known);
        const val = new Float64Array(known);
        for (let c = 0; c < cellCount; c++) {
          const k = r.u8();
          const v = cellHasF64(k) ? r.f64() : cellHasU32(k) ? r.u32() : 0;
          if (c < known) {
            cls[c] = k;
            val[c] = v;
          }
        }
        // `cells`: only on a SHORT row (written by a holder that knows fewer
        // leaves than this reader) — its missing leaves read as null and the
        // shard needs a field backfill before they can be served.
        out.push(
          cellCount < known
            ? { t: 'upsert', model, shard, oid, row: { cls, val }, cells: cellCount }
            : { t: 'upsert', model, shard, oid, row: { cls, val } },
        );
        break;
      }
      case TYPE.delete:
        out.push({ t: 'delete', model, shard, oid: r.oid() });
        break;
      case TYPE.shard: {
        const state = SHARD_STATE_BY_CODE[r.u8()];
        if (!state) throw new DeltaCodecError('unknown shard state');
        out.push({ t: 'shard', model, shard, state });
        break;
      }
      default:
        throw new DeltaCodecError(`unknown record type ${type}`);
    }
  }
  if (r.remaining !== 0) throw new DeltaCodecError('trailing bytes after the last record');
  return out;
}

// ── stream entry fields ──

/** An entry as the flat field list `XADD` takes (values strings, `d` raw bytes). */
export function entryFields(entry: DeltaEntry): Array<string | Buffer> {
  return [
    'f', String(entry.f),
    'e', String(entry.e),
    'inc', entry.inc,
    's', String(entry.s),
    'ct', entry.ct,
    'rt', entry.rt,
    'k', entry.k,
    'ca', String(entry.ca),
    ...(entry.fz ? ['fz', '1'] : []),
    'd', Buffer.from(entry.d.buffer, entry.d.byteOffset, entry.d.byteLength),
  ];
}

/** A stream entry's fields (as `XREAD`/`XRANGE` return them, buffers or strings) → entry. */
export function entryFromFields(id: string, fields: ReadonlyArray<Buffer | string>): DeltaEntry {
  const map = new Map<string, Buffer | string>();
  for (let i = 0; i + 1 < fields.length; i += 2) map.set(String(fields[i]), fields[i + 1]);
  const text = (key: string) => {
    const v = map.get(key);
    return v === undefined ? '' : String(v);
  };
  const num = (key: string) => {
    const n = Number(text(key));
    if (!Number.isFinite(n)) throw new DeltaCodecError(`entry ${id}: field ${key} is not a number`);
    return n;
  };
  const k = text('k');
  if (k !== 'batch' && k !== 'heartbeat' && k !== 'shard') throw new DeltaCodecError(`entry ${id}: unknown kind ${k}`);
  const raw = map.get('d');
  const d = raw === undefined ? EMPTY_PAYLOAD : typeof raw === 'string' ? new Uint8Array(Buffer.from(raw, 'binary')) : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  return { id, f: num('f'), e: num('e'), inc: text('inc'), s: num('s'), ct: text('ct'), rt: text('rt'), k, ca: num('ca'), d, ...(text('fz') === '1' ? { fz: true } : {}) };
}

/** Compare two stream ids (`<ms>-<seq>`). */
export function compareStreamIds(a: string, b: string): number {
  const [am, as] = splitId(a);
  const [bm, bs] = splitId(b);
  return am !== bm ? (am < bm ? -1 : 1) : as === bs ? 0 : as < bs ? -1 : 1;
}

function splitId(id: string): [bigint, bigint] {
  const dash = id.indexOf('-');
  try {
    return dash < 0 ? [BigInt(id), 0n] : [BigInt(id.slice(0, dash)), BigInt(id.slice(dash + 1))];
  } catch {
    return [0n, 0n];
  }
}
