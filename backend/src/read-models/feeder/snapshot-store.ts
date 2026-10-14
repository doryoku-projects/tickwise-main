import { promisify } from 'node:util';
import { deflateRaw, inflateRaw } from 'node:zlib';
import { Dictionary } from '../core/dictionary.js';
import { leavesOf, type ReadModelName, type ShardKey } from '../core/fields.js';
import type { ModelStore } from '../core/model-store.js';
import { OID_BYTES } from '../core/oid-map.js';
import { ShardTable, type QuarantineListener, type ShardState } from '../core/row-store.js';
import type { RmKeys } from '../keys.js';
import type { ModelsTransport } from '../transport.js';

/**
 * Self-describing columnar snapshots in redis-models (design §3.5).
 *
 * A snapshot SET is every live row of every (model, shard) table, column by
 * column — the `_id`s (12 B), per leaf its class bytes and its values (f64 /
 * u32), the shard's dictionary (offsets + bytes) — each column cut into raw
 * chunks of ≤ 8 MB, deflated at level 1, written to
 *   `…:snap:<fence>:<epoch>:<snapSeq>:<model>:<shard>.<column>:<chunk>`
 * with at most 2 chunk writes in flight; no whole-set buffer is ever held.
 * The MANIFEST is written last, through the fenced script, and that write is
 * the atomic switch: a reader never sees a half-written set.
 *
 * `streamId` / `s` / `rt` / `ct` / `ca` in the manifest are those of the last
 * entry the snapshot contains (the holder freezes its tables while encoding,
 * so this is exact): a loader `XREAD`s from `streamId` exclusive and checks
 * `s == manifest.s + 1`.
 *
 * Each column carries its codec and version; the loader reads the current
 * version and the previous one (N-1). A column the snapshot lacks — a newly
 * projected leaf — loads as null and marks the leaf missing (the holder then
 * rescans the shard: R1's field backfill).
 */

export type ColumnCodec = 'u8' | 'f64' | 'u32' | 'oid12' | 'bytes';

export interface SnapshotColumn {
  model: ReadModelName;
  shard: ShardKey;
  /** `oid`, `<leaf>.cls`, `<leaf>.val`, `dict.offsets`, `dict.bytes`. */
  name: string;
  codec: ColumnCodec;
  version: number;
  /** Elements (rows, or dictionary entries + 1, or bytes). */
  rows: number;
  chunks: number;
  /** Raw bytes. */
  bytes: number;
  /** Deflated bytes stored. */
  stored: number;
}

export interface SnapshotShard {
  model: ReadModelName;
  shard: ShardKey;
  state: ShardState;
  rows: number;
  dict: number;
}

export interface Manifest {
  layout: 1;
  fence: number;
  epoch: number;
  inc: string;
  snapSeq: number;
  /** Stream id of the last entry contained (`0-0`-style tail of an older epoch for a fresh epoch). */
  streamId: string;
  s: number;
  rt: string;
  ct: string;
  ca: number;
  createdAt: number;
  /** A new epoch that CONTINUES an older position (flush recovery, §3.6): consumers there switch without reloading. */
  continues?: { fence: number; epoch: number; s: number };
  /** The position was frozen (a repair blocked) at the snapshot: its rows may be newer than `ct`. */
  frozen?: true;
  models: ReadModelName[];
  shards: SnapshotShard[];
  columns: SnapshotColumn[];
  encodeMs: number;
  /** Deflated bytes of the whole set. */
  stored: number;
}

/** The column codec versions this build writes. */
export const COLUMN_VERSION = 1;
/** …and reads (current and previous). */
const READABLE_VERSIONS = new Set([COLUMN_VERSION, COLUMN_VERSION - 1].filter((v) => v > 0));

export const CHUNK_RAW_BYTES = 8 * 1024 * 1024;
const MAX_IN_FLIGHT = 2;

const deflate = promisify(deflateRaw);
const inflate = promisify(inflateRaw);

export class SnapshotAbortedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotAbortedError';
  }
}

/** Every chunk key of a manifest's set. */
export function chunkKeys(keys: RmKeys, manifest: Pick<Manifest, 'fence' | 'epoch' | 'snapSeq' | 'columns'>): string[] {
  const out: string[] = [];
  for (const column of manifest.columns) {
    for (let chunk = 0; chunk < column.chunks; chunk++) {
      out.push(keys.snapChunk(manifest.fence, manifest.epoch, manifest.snapSeq, column.model, `${column.shard}.${column.name}`, chunk));
    }
  }
  return out;
}

/** The raw bytes of one column, produced chunk by chunk over the table's LIVE slots. */
function* columnChunks(table: ShardTable, live: Uint32Array, name: string, codec: ColumnCodec): Generator<Uint8Array> {
  if (name === 'dict.offsets' || name === 'dict.bytes') {
    const { offsets, bytes } = table.dict.exportColumns();
    const raw = name === 'dict.bytes' ? bytes : new Uint8Array(offsets.buffer, offsets.byteOffset, offsets.byteLength);
    for (let at = 0; at < raw.length; at += CHUNK_RAW_BYTES) yield raw.slice(at, Math.min(raw.length, at + CHUNK_RAW_BYTES));
    return;
  }
  const width = codec === 'oid12' ? OID_BYTES : codec === 'f64' ? 8 : codec === 'u32' ? 4 : 1;
  const perChunk = Math.max(1, Math.floor(CHUNK_RAW_BYTES / width));
  const leaf = name === 'oid' ? -1 : table.leaves.findIndex((spec) => spec.name === name.slice(0, name.lastIndexOf('.')));
  for (let start = 0; start < live.length; start += perChunk) {
    const end = Math.min(live.length, start + perChunk);
    const n = end - start;
    if (codec === 'oid12') {
      const out = new Uint8Array(n * OID_BYTES);
      for (let r = 0; r < n; r++) out.set(table.oids.subarray(live[start + r] * OID_BYTES, live[start + r] * OID_BYTES + OID_BYTES), r * OID_BYTES);
      yield out;
    } else if (codec === 'u8') {
      const src = table.cls[leaf];
      const out = new Uint8Array(n);
      for (let r = 0; r < n; r++) out[r] = src[live[start + r]];
      yield out;
    } else if (codec === 'f64') {
      const src = table.num[leaf]!;
      const out = new Float64Array(n);
      for (let r = 0; r < n; r++) out[r] = src[live[start + r]];
      yield new Uint8Array(out.buffer);
    } else {
      const src = table.ids[leaf]!;
      const out = new Uint32Array(n);
      for (let r = 0; r < n; r++) out[r] = src[live[start + r]];
      yield new Uint8Array(out.buffer);
    }
  }
}

/** The columns of one table: name, codec and element count. */
function tableColumns(table: ShardTable): Array<{ name: string; codec: ColumnCodec; rows: number }> {
  const rows = table.live;
  const cols: Array<{ name: string; codec: ColumnCodec; rows: number }> = [{ name: 'oid', codec: 'oid12', rows }];
  for (const spec of table.leaves) {
    cols.push({ name: `${spec.name}.cls`, codec: 'u8', rows });
    if (spec.kind === 'num') cols.push({ name: `${spec.name}.val`, codec: 'f64', rows });
    else if (spec.kind === 'str' || spec.kind === 'pid') cols.push({ name: `${spec.name}.val`, codec: 'u32', rows });
  }
  const { offsets, bytes } = table.dict.exportColumns();
  cols.push({ name: 'dict.offsets', codec: 'u32', rows: offsets.length });
  cols.push({ name: 'dict.bytes', codec: 'bytes', rows: bytes.length });
  return cols;
}

export interface WriteSnapshotOptions {
  transport: ModelsTransport;
  keys: RmKeys;
  store: ModelStore;
  /** Manifest fields the writer decides. */
  head: Pick<Manifest, 'fence' | 'epoch' | 'inc' | 'snapSeq' | 'continues'>;
  /** TTL of the chunks while the set is being written (10 min). */
  writingTtlMs: number;
  /** Abort past this many ms of encoding (§3.5): the holder passes `snapshotEncodeCapMs` — default 20 s, `READ_MODELS_SNAPSHOT_ENCODE_TIMEOUT_MS`. */
  maxEncodeMs: number;
  /** Optional extra copy of every chunk + the manifest (the durable sink). */
  copy?: { chunk(key: string, data: Uint8Array): Promise<void> };
  now?: () => number;
  /**
   * True once the encode must stop (the holder session ended: its hold may
   * already be released, so the tables are no longer the frozen state).
   * Checked before every chunk, like `maxEncodeMs`; throws `SnapshotAbortedError`.
   */
  aborted?: () => boolean;
}

/**
 * Encode and write the CURRENT state of `store` as a snapshot set and return
 * its manifest — NOT yet committed (the caller holds the store during this
 * call, then commits the manifest with `transport.putManifest`, then
 * releases). Throws `SnapshotAbortedError` past `maxEncodeMs`.
 */
export async function writeSnapshotSet(opts: WriteSnapshotOptions): Promise<Manifest> {
  const now = opts.now ?? Date.now;
  const started = now();
  const { store, head, keys, transport } = opts;
  // The position of the frozen state, taken at hold time (the caller holds the
  // store before this call): never a position read after the encode, which a
  // released hold could have moved past what the columns contain.
  const pos = { ...store.pos };
  const columns: SnapshotColumn[] = [];
  const shards: SnapshotShard[] = [];
  let stored = 0;
  const inFlight = new Set<Promise<void>>();
  const put = async (key: string, data: Uint8Array) => {
    while (inFlight.size >= MAX_IN_FLIGHT) await Promise.race(inFlight);
    const p = (async () => {
      await transport.putChunk(key, data, opts.writingTtlMs);
      await opts.copy?.chunk(key, data);
    })().finally(() => inFlight.delete(p));
    inFlight.add(p);
  };
  for (const table of store.tables.values()) {
    if (!store.models.has(table.model)) continue;
    const live = new Uint32Array(table.live);
    let n = 0;
    table.forEachLive((slot) => {
      live[n++] = slot;
    });
    shards.push({ model: table.model, shard: table.shard, state: table.state, rows: table.live, dict: table.dict.size });
    for (const col of tableColumns(table)) {
      let chunks = 0;
      let raw = 0;
      let deflated = 0;
      for (const chunk of columnChunks(table, live, col.name, col.codec)) {
        if (opts.aborted?.()) {
          await Promise.allSettled(inFlight);
          throw new SnapshotAbortedError('snapshot encode aborted: the holder session ended');
        }
        if (now() - started > opts.maxEncodeMs) {
          await Promise.allSettled(inFlight);
          throw new SnapshotAbortedError(`snapshot encode ran past ${opts.maxEncodeMs} ms`);
        }
        const packed = new Uint8Array(await deflate(chunk, { level: 1 }));
        await put(keys.snapChunk(head.fence, head.epoch, head.snapSeq, table.model, `${table.shard}.${col.name}`, chunks), packed);
        chunks++;
        raw += chunk.byteLength;
        deflated += packed.byteLength;
      }
      stored += deflated;
      columns.push({ model: table.model, shard: table.shard, name: col.name, codec: col.codec, version: COLUMN_VERSION, rows: col.rows, chunks, bytes: raw, stored: deflated });
    }
  }
  await Promise.all(inFlight);
  if (opts.aborted?.()) throw new SnapshotAbortedError('snapshot aborted before its manifest: the holder session ended');
  return {
    layout: 1,
    fence: head.fence,
    epoch: head.epoch,
    inc: head.inc,
    snapSeq: head.snapSeq,
    streamId: pos.id,
    s: pos.s,
    rt: pos.rt,
    ct: pos.ct,
    ca: pos.ca,
    createdAt: now(),
    ...(head.continues ? { continues: head.continues } : {}),
    ...(pos.frozen ? { frozen: true as const } : {}),
    models: [...store.models],
    shards,
    columns,
    encodeMs: now() - started,
    stored,
  };
}

export interface LoadedSnapshot {
  tables: ShardTable[];
  /** Leaves whose column the snapshot lacked (a field backfill is due), per table. */
  missing: Array<{ model: ReadModelName; shard: ShardKey; leaves: string[] }>;
  /** Deflated bytes read. */
  bytes: number;
}

export class SnapshotLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotLoadError';
  }
}

/**
 * Read a manifest's set back into tables (one table at a time, chunk by
 * chunk). Throws `SnapshotLoadError` when a chunk is missing or corrupt (the
 * set expired or was swept mid-load: the caller retries with the newest
 * manifest).
 */
export async function loadSnapshotSet(opts: {
  transport: Pick<ModelsTransport, 'getChunk'>;
  keys: RmKeys;
  manifest: Manifest;
  models: ReadonlySet<ReadModelName>;
  capacityFor?: (model: ReadModelName, shard: ShardKey, rows: number) => number;
  onQuarantine?: QuarantineListener;
}): Promise<LoadedSnapshot> {
  const { manifest, keys } = opts;
  const tables: ShardTable[] = [];
  const missing: LoadedSnapshot['missing'] = [];
  let bytes = 0;
  const read = async (column: SnapshotColumn): Promise<Uint8Array> => {
    const out = new Uint8Array(column.bytes);
    let at = 0;
    for (let chunk = 0; chunk < column.chunks; chunk++) {
      const key = keys.snapChunk(manifest.fence, manifest.epoch, manifest.snapSeq, column.model, `${column.shard}.${column.name}`, chunk);
      const packed = await opts.transport.getChunk(key);
      if (!packed) throw new SnapshotLoadError(`snapshot chunk missing: ${key}`);
      let raw: Uint8Array;
      try {
        raw = new Uint8Array(await inflate(packed));
      } catch (err) {
        throw new SnapshotLoadError(`snapshot chunk corrupt: ${key}: ${(err as Error).message}`);
      }
      if (at + raw.length > out.length) throw new SnapshotLoadError(`snapshot column ${column.shard}.${column.name} longer than declared`);
      out.set(raw, at);
      at += raw.length;
      bytes += packed.byteLength;
    }
    if (at !== out.length) throw new SnapshotLoadError(`snapshot column ${column.shard}.${column.name} shorter than declared`);
    return out;
  };
  for (const shard of manifest.shards) {
    if (!opts.models.has(shard.model)) continue;
    const cols = new Map(
      manifest.columns
        .filter((c) => c.model === shard.model && c.shard === shard.shard && READABLE_VERSIONS.has(c.version))
        .map((c) => [c.name, c] as const),
    );
    const oidCol = cols.get('oid');
    const offCol = cols.get('dict.offsets');
    const dictCol = cols.get('dict.bytes');
    if (!oidCol || !offCol || !dictCol) throw new SnapshotLoadError(`snapshot ${shard.model} ${shard.shard} lacks its oid or dictionary columns`);
    const oids = await read(oidCol);
    const offRaw = await read(offCol);
    const dictBytes = await read(dictCol);
    const offsets = new Uint32Array(offRaw.buffer, offRaw.byteOffset, offRaw.byteLength / 4);
    // Sliced (yields every 65,536 entries): a 4M-row shard is not one ~800 ms block on a replica answering HTTP.
    const dict = await Dictionary.fromColumnsAsync(offsets, dictBytes);
    const rows = shard.rows;
    if (oids.length !== rows * OID_BYTES) throw new SnapshotLoadError(`snapshot ${shard.shard} oid column has ${oids.length / OID_BYTES} rows, manifest ${rows}`);
    const capacity = opts.capacityFor?.(shard.model, shard.shard, rows) ?? Math.ceil(rows * 1.25) + 16;
    const table = new ShardTable(shard.model, shard.shard, capacity, dict, opts.onQuarantine);
    const leaves = leavesOf(shard.model);
    const cls: Array<Uint8Array | undefined> = [];
    const val: Array<Float64Array | Uint32Array | undefined> = [];
    const lacking: string[] = [];
    for (const spec of leaves) {
      const c = cols.get(`${spec.name}.cls`);
      const v = cols.get(`${spec.name}.val`);
      const needsVal = spec.kind !== 'bool';
      if (!c || (needsVal && !v) || c.rows !== rows || (v && v.rows !== rows)) {
        cls.push(undefined);
        val.push(undefined);
        lacking.push(spec.name);
        continue;
      }
      cls.push(await read(c));
      if (v) {
        const raw = await read(v);
        val.push(v.codec === 'f64' ? new Float64Array(raw.buffer, raw.byteOffset, rows) : new Uint32Array(raw.buffer, raw.byteOffset, rows));
      } else val.push(undefined);
    }
    await table.loadColumnsAsync(rows, oids, cls, val);
    table.state = shard.state;
    if (lacking.length > 0) missing.push({ model: shard.model, shard: shard.shard, leaves: lacking });
    tables.push(table);
  }
  return { tables, missing, bytes };
}
