import { CLS, ODD_TYPES, canonicalNumber, isOdd, isOddClass, oddFromClass, type Cell } from './cells.js';
import { Dictionary } from './dictionary.js';
import { leavesOf, parseShardKey, type LeafSpec, type ReadModelName, type ShardKey } from './fields.js';
import { OID_BYTES, OidMap, oidToBytes, oidToHex } from './oid-map.js';
import { LOAD_SLICE_ROWS, runSteps, runStepsAsync } from './yield-steps.js';
import type { EncodedRow } from '../feeder/delta-codec.js';

/**
 * One (model, shard)'s rows as typed columns (design §4.2): rows are slots,
 * deletes are tombstones (the live bit), slots are compacted only by a
 * snapshot load. Per leaf a class byte column (`cls`) plus, by kind, an f64
 * (`num`) or u32 (`str` dictionary id, `pid`) value column; the 12-byte
 * `_id` column with its open-addressing index; the shard's dictionary.
 *
 * R1 scope: this is the row-state table the feeder, the delta consumers and
 * the snapshots maintain; nothing serves from it yet. The engine core (the
 * next work package) moves the columns onto pooled SharedArrayBuffers and adds
 * perms, CSRs and bitsets over them. Single writer: the main thread.
 *
 * Quarantine (§4.8): per leaf, the number of LIVE rows whose value the
 * engines cannot reproduce Mongo's semantics for — an odd cell, a foreign
 * `chainId` / `protocol`, (rank) `tokenId ≠ positionId`, and (rank, whose
 * string comparisons run under the numericOrdering collation) a string
 * outside printable ASCII. A query reading a quarantined field on a shard it
 * spans will go to Mongo (R2/R3).
 */

export type ShardState = 'scanning' | 'ready' | 'unsupported';

/** Called when a (shard, field) gets its first quarantined row. */
export type QuarantineListener = (model: ReadModelName, shard: ShardKey, leaf: string) => void;

export class ShardTable {
  readonly leaves: readonly LeafSpec[];
  readonly chainId: number;
  readonly protocol: string;
  capacity: number;
  /** Slots handed out (live + tombstoned). */
  slots = 0;
  /** Live rows. */
  live = 0;
  cls: Uint8Array[];
  num: Array<Float64Array | undefined>;
  ids: Array<Uint32Array | undefined>;
  oids: Uint8Array;
  alive: Uint8Array;
  readonly oidMap: OidMap;
  dict: Dictionary;
  state: ShardState = 'scanning';
  /** Leaves a short row or a snapshot without their column left unknown (a field backfill is due). */
  readonly missingLeaves = new Set<number>();
  /** Per leaf: live rows quarantined for that field. */
  readonly quarantine: Int32Array;
  /**
   * Bumped whenever slots stop meaning what they meant (`reset`, a bulk
   * `loadColumns`): a reader holding slot ids from before (the pool catalog's
   * frozen copy, R2) must rebuild instead of applying changes slot by slot.
   */
  resets = 0;
  /** Slots upserted or deleted since the last `takeChanges` — only while a reader tracks them. */
  private changed?: Set<number>;
  private readonly key = new Uint8Array(OID_BYTES);
  private protocolId = -1;
  private readonly chainLeaf: number;
  private readonly protocolLeaf: number;
  private readonly positionLeaf: number;
  private readonly tokenLeaf: number;
  /** Rank: every string leaf is compared under the numericOrdering collation (printable ASCII domain). */
  private readonly collated: boolean;

  constructor(
    readonly model: ReadModelName,
    readonly shard: ShardKey,
    capacity = 1024,
    dict?: Dictionary,
    private readonly onQuarantine?: QuarantineListener,
  ) {
    this.leaves = leavesOf(model);
    const { chainId, protocol } = parseShardKey(shard);
    this.chainId = chainId;
    this.protocol = protocol;
    this.capacity = Math.max(16, capacity);
    this.cls = this.leaves.map(() => new Uint8Array(this.capacity));
    this.num = this.leaves.map((spec) => (spec.kind === 'num' ? new Float64Array(this.capacity) : undefined));
    this.ids = this.leaves.map((spec) => (spec.kind === 'str' || spec.kind === 'pid' ? new Uint32Array(this.capacity) : undefined));
    this.oids = new Uint8Array(this.capacity * OID_BYTES);
    this.alive = new Uint8Array(this.capacity);
    this.oidMap = new OidMap(this.capacity);
    this.dict = dict ?? new Dictionary();
    this.quarantine = new Int32Array(this.leaves.length);
    const at = (name: string) => this.leaves.findIndex((spec) => spec.name === name);
    this.chainLeaf = at('chainId');
    this.protocolLeaf = at('protocol');
    this.positionLeaf = at('positionId');
    this.tokenLeaf = at('tokenId');
    this.collated = model === 'rank';
  }

  /**
   * Start recording which slots change (R2: the pool catalog applies them,
   * generation by generation, to its frozen copy). Idempotent.
   */
  trackChanges(): void {
    this.changed ??= new Set();
  }

  /** The slots changed since the last call (in no particular order), and forget them. */
  takeChanges(): number[] {
    const changed = this.changed;
    if (!changed || changed.size === 0) return [];
    const out = [...changed];
    changed.clear();
    return out;
  }

  /** Changed slots waiting to be taken (status / specs). */
  get pendingChanges(): number {
    return this.changed?.size ?? 0;
  }

  /** Bytes held by this table's arrays. */
  get memoryBytes(): number {
    let total = this.oids.byteLength + this.alive.byteLength + this.oidMap.memoryBytes + this.dict.memoryBytes;
    for (let l = 0; l < this.leaves.length; l++) {
      total += this.cls[l].byteLength + (this.num[l]?.byteLength ?? 0) + (this.ids[l]?.byteLength ?? 0);
    }
    return total;
  }

  /** The slot of `_id` (24-hex), or -1. Tombstoned slots are returned too: check `alive`. */
  slotOf(oid: string): number {
    if (!oidToBytes(oid, this.key)) return -1;
    return this.oidMap.find(this.oids, this.key);
  }

  /** The live slot of `_id`, or -1. */
  liveSlotOf(oid: string): number {
    const slot = this.slotOf(oid);
    return slot >= 0 && this.alive[slot] === 1 ? slot : -1;
  }

  oidAt(slot: number): string {
    return oidToHex(this.oids, slot * OID_BYTES);
  }

  /** Insert or replace a row (its full state). */
  upsert(oid: string, row: EncodedRow): void {
    if (!oidToBytes(oid, this.key)) throw new Error(`not an ObjectId hex: ${oid}`);
    let slot = this.oidMap.find(this.oids, this.key);
    if (slot < 0) {
      if (this.slots >= this.capacity) this.grow(this.capacity * 2);
      slot = this.slots++;
      this.oids.set(this.key, slot * OID_BYTES);
      this.oidMap.add(this.oids, slot);
    } else if (this.alive[slot] === 1) {
      this.countQuarantine(slot, -1);
    }
    for (let l = 0; l < this.leaves.length; l++) {
      const c = row.cls[l];
      this.cls[l][slot] = c;
      const num = this.num[l];
      if (num) num[slot] = c === CLS.NUM ? canonicalNumber(row.val[l]) : 0;
      const ids = this.ids[l];
      if (ids) ids[slot] = c === CLS.STR || c === CLS.PID ? row.val[l] : 0;
    }
    if (this.alive[slot] !== 1) {
      this.alive[slot] = 1;
      this.live++;
    }
    this.countQuarantine(slot, 1);
    this.changed?.add(slot);
  }

  /** Tombstone a row; false when it was not live. */
  delete(oid: string): boolean {
    const slot = this.liveSlotOf(oid);
    if (slot < 0) return false;
    this.countQuarantine(slot, -1);
    this.alive[slot] = 0;
    this.live--;
    this.changed?.add(slot);
    return true;
  }

  /** Drop every row (a rescan or a dropped collection). The dictionary is kept: ids in flight stay valid. */
  reset(): void {
    this.resets++;
    this.changed?.clear();
    this.alive.fill(0);
    this.slots = 0;
    this.live = 0;
    this.quarantine.fill(0);
    this.missingLeaves.clear();
    this.oidMap.rebuild(this.oids, 0, this.capacity);
  }

  /** A row's encoded form (copy). */
  encodedAt(slot: number): EncodedRow {
    const n = this.leaves.length;
    const cls = new Uint8Array(n);
    const val = new Float64Array(n);
    for (let l = 0; l < n; l++) {
      cls[l] = this.cls[l][slot];
      val[l] = this.num[l]?.[slot] ?? this.ids[l]?.[slot] ?? 0;
    }
    return { cls, val };
  }

  /** A row as cells (strings resolved through the dictionary). */
  cellsAt(slot: number): Cell[] {
    const out: Cell[] = new Array(this.leaves.length);
    for (let l = 0; l < this.leaves.length; l++) out[l] = this.cellAt(slot, l);
    return out;
  }

  cellAt(slot: number, leaf: number): Cell {
    const c = this.cls[leaf][slot];
    switch (c) {
      case CLS.NULL:
        return null;
      case CLS.NUM:
        return this.num[leaf]![slot];
      case CLS.STR:
        return this.dict.get(this.ids[leaf]![slot]);
      case CLS.PID:
        return this.ids[leaf]![slot];
      case CLS.TRUE:
        return true;
      case CLS.FALSE:
        return false;
      default:
        return isOddClass(c) ? oddFromClass(c) : null;
    }
  }

  /**
   * Does the live row at `slot` hold exactly `cells`? (The no-op drop: never
   * mints a dictionary id — a string the dictionary lacks is a change.)
   */
  sameAs(slot: number, cells: readonly Cell[]): boolean {
    for (let l = 0; l < this.leaves.length; l++) {
      const cell = cells[l];
      const c = this.cls[l][slot];
      if (cell === null) {
        if (c !== CLS.NULL) return false;
      } else if (isOdd(cell)) {
        if (!isOddClass(c) || oddFromClass(c).odd !== cell.odd) return false;
      } else if (typeof cell === 'boolean') {
        if (c !== (cell ? CLS.TRUE : CLS.FALSE)) return false;
      } else if (typeof cell === 'string') {
        if (c !== CLS.STR || this.ids[l]![slot] !== this.dict.find(cell)) return false;
      } else if (this.leaves[l].kind === 'pid') {
        if (c !== CLS.PID || this.ids[l]![slot] !== cell) return false;
      } else {
        if (c !== CLS.NUM) return false;
        const v = this.num[l]![slot];
        if (!(v === cell || (Number.isNaN(v) && Number.isNaN(cell)))) return false;
      }
    }
    return true;
  }

  /**
   * Fill an EMPTY table with `rows` live rows straight from snapshot columns
   * (slots compacted: row r is slot r). A leaf whose column is absent
   * (`cls[l]` undefined) reads null for every row and is recorded in
   * `missingLeaves` (a field backfill is due).
   */
  loadColumns(rows: number, oids: Uint8Array, cls: Array<Uint8Array | undefined>, val: Array<Float64Array | Uint32Array | undefined>): void {
    runSteps(this.loadColumnsSteps(rows, oids, cls, val));
  }

  /**
   * `loadColumns` with an event-loop turn between slices of `slice` rows (the
   * per-leaf copies, the oid index, the quarantine counts): a 4.2M-row shard
   * is ~0.8 s of CPU, and a replica loading a snapshot is already answering
   * HTTP. The table must not be read or written until the promise resolves
   * (load it before it is attached to a store).
   */
  loadColumnsAsync(
    rows: number,
    oids: Uint8Array,
    cls: Array<Uint8Array | undefined>,
    val: Array<Float64Array | Uint32Array | undefined>,
    slice = LOAD_SLICE_ROWS,
  ): Promise<void> {
    return runStepsAsync(this.loadColumnsSteps(rows, oids, cls, val, slice));
  }

  private *loadColumnsSteps(
    rows: number,
    oids: Uint8Array,
    cls: Array<Uint8Array | undefined>,
    val: Array<Float64Array | Uint32Array | undefined>,
    slice = LOAD_SLICE_ROWS,
  ): Generator<void, void, void> {
    if (this.slots !== 0) throw new Error('loadColumns needs an empty table');
    this.resets++;
    this.changed?.clear();
    if (rows > this.capacity) this.grow(Math.max(rows, this.capacity * 2));
    this.oids.set(oids.subarray(0, rows * OID_BYTES));
    for (let l = 0; l < this.leaves.length; l++) {
      const c = cls[l];
      if (!c) {
        this.missingLeaves.add(l);
        continue;
      }
      this.cls[l].set(c.subarray(0, rows));
      const v = val[l];
      const num = this.num[l];
      const ids = this.ids[l];
      for (let from = 0; from < rows; from += slice) {
        const to = Math.min(rows, from + slice);
        if (v && num) for (let r = from; r < to; r++) num[r] = c[r] === CLS.NUM ? canonicalNumber(v[r]) : 0;
        if (v && ids) for (let r = from; r < to; r++) ids[r] = c[r] === CLS.STR || c[r] === CLS.PID ? v[r] : 0;
        yield;
      }
    }
    this.alive.fill(1, 0, rows);
    this.slots = rows;
    this.live = rows;
    yield* this.oidMap.rebuildSteps(this.oids, rows, this.capacity, slice);
    for (let slot = 0; slot < rows; slot++) {
      this.countQuarantine(slot, 1);
      if ((slot + 1) % slice === 0 && slot + 1 < rows) yield;
    }
  }

  /** Visit every live slot in slot order. */
  forEachLive(visit: (slot: number) => void): void {
    for (let slot = 0; slot < this.slots; slot++) if (this.alive[slot] === 1) visit(slot);
  }

  /** Planned reallocation to `capacity` rows (copying every column). */
  grow(capacity: number): void {
    if (capacity <= this.capacity) return;
    const copy8 = (a: Uint8Array, per = 1) => {
      const next = new Uint8Array(capacity * per);
      next.set(a.subarray(0, this.slots * per));
      return next;
    };
    this.cls = this.cls.map((a) => copy8(a));
    this.num = this.num.map((a) => {
      if (!a) return undefined;
      const next = new Float64Array(capacity);
      next.set(a.subarray(0, this.slots));
      return next;
    });
    this.ids = this.ids.map((a) => {
      if (!a) return undefined;
      const next = new Uint32Array(capacity);
      next.set(a.subarray(0, this.slots));
      return next;
    });
    this.oids = copy8(this.oids, OID_BYTES);
    this.alive = copy8(this.alive);
    this.capacity = capacity;
    this.oidMap.rebuild(this.oids, this.slots, capacity);
  }

  /** Is the row at `slot` quarantined for `leaf`? */
  quarantinedAt(slot: number, leaf: number): boolean {
    const c = this.cls[leaf][slot];
    if (isOddClass(c)) return true;
    if (leaf === this.chainLeaf) return !(c === CLS.NUM && this.num[leaf]![slot] === this.chainId);
    if (leaf === this.protocolLeaf) {
      if (c !== CLS.STR) return true;
      if (this.protocolId < 0) this.protocolId = this.dict.find(this.protocol);
      return this.ids[leaf]![slot] !== this.protocolId;
    }
    if (leaf === this.tokenLeaf && this.positionLeaf >= 0) {
      const p = this.cls[this.positionLeaf][slot];
      return !(c === CLS.PID && p === CLS.PID && this.ids[leaf]![slot] === this.ids[this.positionLeaf]![slot]);
    }
    if (this.collated && c === CLS.STR) return !this.dict.isPrintableAscii(this.ids[leaf]![slot]);
    return false;
  }

  /** Per-field quarantine counts (non-zero only). */
  quarantineCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (let l = 0; l < this.leaves.length; l++) if (this.quarantine[l] > 0) out[this.leaves[l].name] = this.quarantine[l];
    return out;
  }

  private countQuarantine(slot: number, delta: 1 | -1): void {
    for (let l = 0; l < this.leaves.length; l++) {
      if (!this.quarantinedAt(slot, l)) continue;
      const before = this.quarantine[l];
      this.quarantine[l] = before + delta;
      if (delta > 0 && before === 0) this.onQuarantine?.(this.model, this.shard, this.leaves[l].name);
    }
  }
}

/**
 * Cells → the encoded (column) form, interning strings through `intern`
 * (the holder mints ids; a reader that must not mint passes a lookup that
 * throws).
 */
export function encodeCells(leaves: readonly LeafSpec[], cells: readonly Cell[], intern: (value: string) => number): EncodedRow {
  const n = leaves.length;
  const cls = new Uint8Array(n);
  const val = new Float64Array(n);
  for (let l = 0; l < n; l++) {
    const cell = cells[l];
    const kind = leaves[l].kind;
    if (cell === null || cell === undefined) {
      cls[l] = CLS.NULL;
    } else if (isOdd(cell)) {
      cls[l] = CLS.ODD_BASE + ODD_INDEX.get(cell.odd)!;
    } else if (kind === 'bool') {
      cls[l] = cell === true ? CLS.TRUE : cell === false ? CLS.FALSE : CLS.ODD_BASE + ODD_INDEX.get('other')!;
    } else if (kind === 'str') {
      if (typeof cell === 'string') {
        cls[l] = CLS.STR;
        val[l] = intern(cell);
      } else cls[l] = CLS.ODD_BASE + ODD_INDEX.get('other')!;
    } else if (kind === 'pid') {
      if (typeof cell === 'number' && Number.isInteger(cell) && cell >= 0 && cell <= 0xffffffff) {
        cls[l] = CLS.PID;
        val[l] = cell;
      } else cls[l] = CLS.ODD_BASE + ODD_INDEX.get('pid')!;
    } else if (typeof cell === 'number') {
      cls[l] = CLS.NUM;
      val[l] = canonicalNumber(cell);
    } else {
      cls[l] = CLS.ODD_BASE + ODD_INDEX.get('other')!;
    }
  }
  return { cls, val };
}

const ODD_INDEX = new Map(ODD_TYPES.map((t, i) => [t, i]));
