import { formatUnits, parseUnits } from 'viem';

/*
 * P3.3 — the fee job's candidates in RAM (design §9.1), one store per
 * (chain, protocol), COLUMNAR in typed arrays so 1.3M rows cost ~0.15 GB and
 * no per-row object lives on the heap:
 *
 *   tokenId      Float64 (a string column instead, for the whole chain, as
 *                soon as any id is not a canonical integer < 2^53)
 *   poolId       Uint32 index into a per-store dictionary
 *   ticks        Int32 × 2      lastModifyBlock  Float64
 *   decimals     Uint8 × 2      prices           Float64 × 2
 *   pendingFeesUsd Float64      flags            Uint8 (priceable, onchain,
 *                                                 verify, rpc, rpcAt, deleted)
 *   rpc fees     uint128 × 2 as two BigUint64 words each (raw units; the
 *                decimal string is rebuilt with formatUnits — exact)
 *   rpcBlock, rpcAt, updatedAt   Float64 × 3
 *
 * ORDER = the tokenId STRING order (`"10" < "9"`), i.e. exactly the order of
 * the Mongo keyset the full pass walks (`tokenId: {$gt}` with no collation)
 * and of `feeCursorAll`, so a pass over the store and a pass over Mongo visit
 * the same rows in the same order and share one cursor. Lookups binary-search
 * that order (≈ 21 steps at 1.3M); there is no id→slot Map. A sorted batch
 * is merged in with native `copyWithin` moves; a delete is a tombstone that a
 * lazy in-place compaction removes. A reconcile diffs a walked range in place:
 * there is never a second copy of the store.
 */

/** One row as the store hands it out (and takes it in). */
export interface StoreRow {
  positionId: string;
  tokenId: string;
  poolId: string;
  tickLower: number;
  tickUpper: number;
  lastModifyBlock: number;
  decimals0: number;
  decimals1: number;
  price0: number;
  price1: number;
  isPriceable: boolean;
  /** Only whether it is `onchain` matters to the pass (`needsServedWrite`). */
  feesSource?: string;
  pendingFeesUsd: number;
  /** A drained signal marked it: the pass must take the served path (one primary read). */
  verify?: boolean;
  rpc?: { fees0: string; fees1: string; block: number; at?: Date };
  /** The doc's `updatedAt` or the writer's `wAt` (ms) — newer-wins. */
  updatedAtMs: number;
}

const F_PRICEABLE = 1;
const F_ONCHAIN = 2;
const F_VERIFY = 4;
const F_RPC = 8;
const F_RPC_AT = 16;
const F_DELETED = 32;
/** The stamp's fees did not fit uint128: kept as strings in the (rare) overflow map. */
const F_RPC_BIG = 64;

const WORD = (1n << 64n) - 1n;
const U128 = 1n << 128n;
const MIN_CAPACITY = 1_024;
/** Compact once tombstones pass this share of the rows (and at least COMPACT_MIN). */
const COMPACT_SHARE = 0.01;
const COMPACT_MIN = 1_000;
/** Bytes per row across every column (the status block's estimate). */
export const STORE_BYTES_PER_ROW = 8 + 4 + 4 + 4 + 8 + 1 + 1 + 8 + 8 + 8 + 1 + 32 + 8 + 8 + 8;

const CANONICAL_INT = /^(0|[1-9]\d*)$/;
const DECIMAL = /^\d+(\.\d+)?$/;

function isDecimal(v: string): boolean {
  return DECIMAL.test(v);
}

/** Lexicographic (UTF-16 code unit) order — what MongoDB's binary collation does for these ASCII ids. */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A decimal string → raw uint128 (undefined when it does not fit or does not parse). */
export function toRaw(value: string, decimals: number): bigint | undefined {
  try {
    const raw = parseUnits(value, decimals);
    return raw >= 0n && raw < U128 ? raw : undefined;
  } catch {
    return undefined;
  }
}

type Column = Float64Array | Uint32Array | Int32Array | Uint8Array | BigUint64Array;

export class FeeCandidateStore {
  private cap = 0;
  private n = 0;
  private tombstones = 0;
  private idNum: Float64Array | null = new Float64Array(0);
  private idStr: string[] | null = null;
  private pool = new Uint32Array(0);
  private readonly poolDict: string[] = [];
  private readonly poolIndex = new Map<string, number>();
  /**
   * Stamps whose raw fees exceed uint128 (real on chain 1: 4 of 10,000 sampled
   * actives, all junk-token amounts like 2.7e21 tokens at 18 decimals), keyed by
   * tokenId so row moves never touch it. Dropping them instead would rewrite
   * those rows' stamps on every pass.
   */
  private readonly bigRpc = new Map<string, { fees0: string; fees1: string }>();
  private tickL = new Int32Array(0);
  private tickU = new Int32Array(0);
  private lmb = new Float64Array(0);
  private dec0 = new Uint8Array(0);
  private dec1 = new Uint8Array(0);
  private p0 = new Float64Array(0);
  private p1 = new Float64Array(0);
  private pend = new Float64Array(0);
  private flags = new Uint8Array(0);
  private r0hi = new BigUint64Array(0);
  private r0lo = new BigUint64Array(0);
  private r1hi = new BigUint64Array(0);
  private r1lo = new BigUint64Array(0);
  private rblk = new Float64Array(0);
  private rat = new Float64Array(0);
  private upd = new Float64Array(0);

  /**
   * The highest tokenId the boot load has covered ('' = nothing yet); rows
   * above it are not known to be absent. `complete` once a load/reconcile has
   * walked to the end — only then does a short page END a pass.
   */
  coveredThrough = '';
  complete = false;

  /** Live rows (tombstones excluded). */
  get size(): number {
    return this.n - this.tombstones;
  }

  /** Whether the chain fell back to the string id column. */
  get stringIds(): boolean {
    return this.idStr !== null;
  }

  byteSize(): number {
    return this.cap * STORE_BYTES_PER_ROW + this.poolDict.length * 140;
  }

  /** Whether `tokenId` lies inside what the load has covered. */
  covers(tokenId: string): boolean {
    return this.complete || (this.coveredThrough !== '' && compareIds(tokenId, this.coveredThrough) <= 0);
  }

  // ─── reads ─────────────────────────────────────────────────────────────────

  get(tokenId: string): StoreRow | undefined {
    const i = this.find(tokenId);
    return i >= 0 ? this.read(i) : undefined;
  }

  /**
   * Up to `limit` live rows with tokenId > `after`, in pass order, never past
   * what the load has covered. `end` is true when nothing is left above the
   * last row returned AND the store is complete — the only case in which a
   * short page means the pass is over.
   */
  page(after: string, limit: number): { rows: StoreRow[]; end: boolean } {
    const rows: StoreRow[] = [];
    let i = after === '' ? 0 : this.upperBound(after);
    for (; i < this.n && rows.length < limit; i++) {
      if (this.flags[i]! & F_DELETED) continue;
      if (!this.complete && (this.coveredThrough === '' || compareIds(this.id(i), this.coveredThrough) > 0)) break;
      rows.push(this.read(i));
    }
    if (rows.length >= limit) return { rows, end: false };
    if (!this.complete) return { rows, end: false };
    // Only tombstones (or nothing) remain above.
    for (; i < this.n; i++) if (!(this.flags[i]! & F_DELETED)) return { rows, end: false };
    return { rows, end: true };
  }

  /** Every live row (specs, the reconcile drift count). */
  *entries(): IterableIterator<StoreRow> {
    for (let i = 0; i < this.n; i++) if (!(this.flags[i]! & F_DELETED)) yield this.read(i);
  }

  // ─── writes ────────────────────────────────────────────────────────────────

  /**
   * Insert or update rows (any order). An existing row is replaced only when
   * the incoming one is newer (`newerWins`); a tombstoned one is revived.
   * Returns how many rows changed.
   */
  upsert(rows: readonly StoreRow[]): number {
    if (rows.length === 0) return 0;
    let changed = 0;
    const inserts: StoreRow[] = [];
    for (const r of rows) {
      const i = this.findAny(r.tokenId);
      if (i < 0) {
        inserts.push(r);
        continue;
      }
      const dead = (this.flags[i]! & F_DELETED) !== 0;
      const cur = this.read(i);
      // A tombstone keeps the closure's time, so a doc read before the closure cannot revive it.
      if (!newerWins(cur, r)) continue;
      // The same content again (a reconcile re-reading an unchanged row, a doc
      // whose `updatedAt` a later write bumped) is not a change: only the
      // newer-wins clock moves forward. Counting it would make every reconcile
      // read ~100 % drift (hint `wAt` and the doc's `updatedAt` never match).
      if (!dead && sameRow(cur, r)) {
        if (finite(r.updatedAtMs) > this.upd[i]!) this.upd[i] = finite(r.updatedAtMs);
        continue;
      }
      if (dead) this.tombstones--;
      this.write(i, r);
      changed++;
    }
    if (inserts.length > 0) {
      // De-duplicate (last wins) and sort into pass order.
      const byId = new Map<string, StoreRow>();
      for (const r of inserts) {
        const prev = byId.get(r.tokenId);
        if (!prev || newerWins(prev, r)) byId.set(r.tokenId, r);
      }
      const sorted = [...byId.values()].sort((a, b) => compareIds(a.tokenId, b.tokenId));
      this.mergeSorted(sorted);
      changed += sorted.length;
    }
    return changed;
  }

  /**
   * Remove a row (a closure at writer time `atMs`). A closure older than what
   * the row already holds is ignored. Returns whether it removed a row.
   */
  remove(tokenId: string, atMs?: number): boolean {
    const i = this.find(tokenId);
    if (i < 0) return false;
    if (atMs !== undefined) {
      if (atMs < this.upd[i]!) return false;
      this.upd[i] = atMs;
    }
    this.flags[i] = this.flags[i]! | F_DELETED;
    this.tombstones++;
    this.maybeCompact();
    return true;
  }

  /**
   * Mark a row `verify`: the pass takes the served path for it (one primary
   * read by id), so a lost writer hint can never leave a changed row serving
   * `indexer`/`unmeasured`. Set for a drained signal the drain could not
   * finish, and for a row whose write the guards refused.
   *
   * Deviation from design §9.2 (recorded): the RAM `lastModifyBlock` is NOT
   * raised to the signal's block. The served path re-reads the true one from
   * the primary anyway, and a live signal's block is the indexer's
   * `updatedAtBlock` (a Transfer moves it too) — raising RAM to it would make
   * the next writer hint, which carries the real, lower `lastModifyBlock`,
   * lose the newer-wins comparison and leave stale prices in RAM.
   */
  markVerify(tokenId: string): boolean {
    const i = this.find(tokenId);
    if (i < 0) return false;
    this.flags[i] = this.flags[i]! | F_VERIFY;
    return true;
  }

  /**
   * The fee job's own write landed: the stamp (and, for a served write, the
   * served figure) as written, `verify` cleared. A served row also takes the
   * fresh doc's inputs it was revalued from (`fresh`).
   */
  applyOwnWrite(
    tokenId: string,
    stamp: { fees0: string; fees1: string; block: number; at: Date },
    served?: { pendingFeesUsd: number; fresh?: Partial<StoreRow> },
  ): void {
    const i = this.find(tokenId);
    if (i < 0) return;
    if (served?.fresh) {
      const cur = this.read(i);
      this.write(i, { ...cur, ...served.fresh, tokenId, positionId: cur.positionId });
    }
    this.setRpc(i, stamp);
    if (served) {
      this.pend[i] = served.pendingFeesUsd;
      this.flags[i] = this.flags[i]! | F_ONCHAIN;
    }
    this.flags[i] = this.flags[i]! & ~F_VERIFY;
  }

  /** Clear `verify` (the served path ran and found nothing to write). */
  clearVerify(tokenId: string): void {
    const i = this.find(tokenId);
    if (i >= 0) this.flags[i] = this.flags[i]! & ~F_VERIFY;
  }

  /**
   * A writer's stamp (P3.1 / a hint): kept only when its block is newer than
   * the one held — stamps only move forward.
   */
  applyStamp(tokenId: string, stamp: { fees0: string; fees1: string; block: number; at?: Date }): boolean {
    const i = this.find(tokenId);
    if (i < 0) return false;
    if ((this.flags[i]! & F_RPC) !== 0 && !(stamp.block > this.rblk[i]!)) return false;
    this.setRpc(i, stamp);
    return true;
  }

  /**
   * In-place diff of one walked range `(after, through]` against the docs the
   * walk read there at `readAtMs` (sorted or not): new/changed docs are
   * upserted newer-wins; store rows in the range the walk did not return are
   * removed — unless a writer touched them after `readAtMs − graceMs` (a hint
   * newer than the read, or a secondary still behind). `through` = undefined
   * means "to the end" (the walk's last page). Returns rows changed/removed.
   */
  reconcileRange(after: string, through: string | undefined, docs: readonly StoreRow[], readAtMs: number, graceMs = 300_000): number {
    const seen = new Set<string>();
    for (const d of docs) seen.add(d.tokenId);
    let changed = 0;
    let i = after === '' ? 0 : this.upperBound(after);
    for (; i < this.n; i++) {
      const id = this.id(i);
      if (through !== undefined && compareIds(id, through) > 0) break;
      if (this.flags[i]! & F_DELETED) continue;
      if (seen.has(id)) continue;
      if (this.upd[i]! >= readAtMs - graceMs) continue;
      this.flags[i] = this.flags[i]! | F_DELETED;
      this.tombstones++;
      changed++;
    }
    changed += this.upsert(docs);
    if (through === undefined) {
      this.complete = true;
    } else if (compareIds(through, this.coveredThrough) > 0) {
      this.coveredThrough = through;
    }
    this.maybeCompact();
    return changed;
  }

  /** Drop every row (a reset before a cold reload). */
  clear(): void {
    this.bigRpc.clear();
    this.n = 0;
    this.tombstones = 0;
    this.coveredThrough = '';
    this.complete = false;
    if (this.idStr) this.idStr = [];
  }

  /** Remove tombstones now (in place, one pass of native moves). */
  compact(): void {
    if (this.tombstones === 0) return;
    let w = 0;
    let r = 0;
    while (r < this.n) {
      if (this.flags[r]! & F_DELETED) {
        if (this.flags[r]! & F_RPC_BIG) this.bigRpc.delete(this.id(r));
        r++;
        continue;
      }
      let end = r;
      while (end < this.n && !(this.flags[end]! & F_DELETED)) end++;
      if (w !== r) this.move(r, w, end - r);
      w += end - r;
      r = end;
    }
    if (this.idStr) this.idStr.length = w;
    this.n = w;
    this.tombstones = 0;
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  private maybeCompact(): void {
    if (this.tombstones >= Math.max(COMPACT_MIN, COMPACT_SHARE * this.n)) this.compact();
  }

  private id(i: number): string {
    return this.idStr ? this.idStr[i]! : String(this.idNum![i]!);
  }

  /** Index of the live row with this id, else -1. */
  private find(tokenId: string): number {
    const i = this.findAny(tokenId);
    return i >= 0 && !(this.flags[i]! & F_DELETED) ? i : -1;
  }

  /** Index of the row (live or tombstoned) with this id, else -1. */
  private findAny(tokenId: string): number {
    const i = this.lowerBound(tokenId);
    return i < this.n && this.id(i) === tokenId ? i : -1;
  }

  /** First index whose id ≥ `tokenId`. */
  private lowerBound(tokenId: string): number {
    let lo = 0;
    let hi = this.n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compareIds(this.id(mid), tokenId) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** First index whose id > `tokenId`. */
  private upperBound(tokenId: string): number {
    let lo = 0;
    let hi = this.n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compareIds(this.id(mid), tokenId) <= 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private columns(): Column[] {
    const cols: Column[] = [
      this.pool,
      this.tickL,
      this.tickU,
      this.lmb,
      this.dec0,
      this.dec1,
      this.p0,
      this.p1,
      this.pend,
      this.flags,
      this.r0hi,
      this.r0lo,
      this.r1hi,
      this.r1lo,
      this.rblk,
      this.rat,
      this.upd,
    ];
    if (this.idNum) cols.push(this.idNum);
    return cols;
  }

  /** Move `len` rows from `from` to `to` (overlap-safe, every column). */
  private move(from: number, to: number, len: number): void {
    if (len <= 0 || from === to) return;
    for (const c of this.columns()) c.copyWithin(to, from, from + len);
    if (this.idStr) {
      const part = this.idStr.slice(from, from + len);
      for (let k = 0; k < len; k++) this.idStr[to + k] = part[k]!;
    }
  }

  private ensureCapacity(need: number): void {
    if (need <= this.cap) return;
    let cap = Math.max(MIN_CAPACITY, this.cap);
    // ×1.5, not ×2: at 1.3M rows the slack of a doubling would be up to ~110 MB.
    while (cap < need) cap = Math.ceil(cap * 1.5);
    const grow = <T extends Column>(old: T, make: (n: number) => T): T => {
      const next = make(cap);
      (next as unknown as { set(a: ArrayLike<unknown>): void }).set(old.subarray(0, this.n) as unknown as ArrayLike<unknown>);
      return next;
    };
    if (this.idNum) this.idNum = grow(this.idNum, (k) => new Float64Array(k));
    this.pool = grow(this.pool, (k) => new Uint32Array(k));
    this.tickL = grow(this.tickL, (k) => new Int32Array(k));
    this.tickU = grow(this.tickU, (k) => new Int32Array(k));
    this.lmb = grow(this.lmb, (k) => new Float64Array(k));
    this.dec0 = grow(this.dec0, (k) => new Uint8Array(k));
    this.dec1 = grow(this.dec1, (k) => new Uint8Array(k));
    this.p0 = grow(this.p0, (k) => new Float64Array(k));
    this.p1 = grow(this.p1, (k) => new Float64Array(k));
    this.pend = grow(this.pend, (k) => new Float64Array(k));
    this.flags = grow(this.flags, (k) => new Uint8Array(k));
    this.r0hi = grow(this.r0hi, (k) => new BigUint64Array(k));
    this.r0lo = grow(this.r0lo, (k) => new BigUint64Array(k));
    this.r1hi = grow(this.r1hi, (k) => new BigUint64Array(k));
    this.r1lo = grow(this.r1lo, (k) => new BigUint64Array(k));
    this.rblk = grow(this.rblk, (k) => new Float64Array(k));
    this.rat = grow(this.rat, (k) => new Float64Array(k));
    this.upd = grow(this.upd, (k) => new Float64Array(k));
    this.cap = cap;
  }

  /** Switch the whole chain to the string id column (an id that is not a canonical integer < 2^53). */
  private toStringIds(): void {
    if (this.idStr) return;
    const ids: string[] = new Array<string>(this.n);
    for (let i = 0; i < this.n; i++) ids[i] = String(this.idNum![i]!);
    this.idStr = ids;
    this.idNum = null;
  }

  /** Merge rows that are NOT in the store, sorted in pass order, with native moves from the tail. */
  private mergeSorted(sorted: readonly StoreRow[]): void {
    for (const r of sorted) if (!numericId(r.tokenId)) this.toStringIds();
    const m = sorted.length;
    this.ensureCapacity(this.n + m);
    if (this.idStr) this.idStr.length = this.n + m;
    let end = this.n; // old rows [0, end) not yet moved
    for (let j = m - 1; j >= 0; j--) {
      const r = sorted[j]!;
      const pos = this.lowerBoundIn(r.tokenId, end);
      // Old rows [pos, end) shift right by j + 1 (the j new rows still to place sit before them).
      this.move(pos, pos + j + 1, end - pos);
      this.write(pos + j, r);
      end = pos;
    }
    this.n += m;
  }

  /** lowerBound restricted to [0, end). */
  private lowerBoundIn(tokenId: string, end: number): number {
    let lo = 0;
    let hi = end;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compareIds(this.id(mid), tokenId) < 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private poolIdx(poolId: string): number {
    let k = this.poolIndex.get(poolId);
    if (k === undefined) {
      k = this.poolDict.length;
      this.poolDict.push(poolId);
      this.poolIndex.set(poolId, k);
    }
    return k;
  }

  private write(i: number, r: StoreRow): void {
    if (this.idStr) this.idStr[i] = r.tokenId;
    else this.idNum![i] = Number(r.tokenId);
    this.pool[i] = this.poolIdx(r.poolId);
    this.tickL[i] = r.tickLower | 0;
    this.tickU[i] = r.tickUpper | 0;
    this.lmb[i] = finite(r.lastModifyBlock);
    this.dec0[i] = clampByte(r.decimals0);
    this.dec1[i] = clampByte(r.decimals1);
    this.p0[i] = finite(r.price0);
    this.p1[i] = finite(r.price1);
    this.pend[i] = finite(r.pendingFeesUsd);
    let f = 0;
    if (r.isPriceable) f |= F_PRICEABLE;
    if (r.feesSource === 'onchain') f |= F_ONCHAIN;
    if (r.verify) f |= F_VERIFY;
    this.flags[i] = f;
    this.rblk[i] = 0;
    this.rat[i] = 0;
    if (r.rpc) this.setRpc(i, r.rpc);
    else this.bigRpc.delete(r.tokenId);
    this.upd[i] = finite(r.updatedAtMs);
  }

  private setRpc(i: number, rpc: { fees0: string; fees1: string; block: number; at?: Date }): void {
    const id = this.id(i);
    this.bigRpc.delete(id);
    const raw0 = toRaw(rpc.fees0, this.dec0[i]!);
    const raw1 = toRaw(rpc.fees1, this.dec1[i]!);
    if (!(rpc.block > 0) || !isDecimal(rpc.fees0) || !isDecimal(rpc.fees1)) {
      // Unreadable: forget it, so the next measurement is written (a stamp, never a wrong skip).
      this.flags[i] = this.flags[i]! & ~(F_RPC | F_RPC_AT | F_RPC_BIG);
      return;
    }
    let f = this.flags[i]! | F_RPC;
    if (raw0 === undefined || raw1 === undefined) {
      this.bigRpc.set(id, { fees0: rpc.fees0, fees1: rpc.fees1 });
      f |= F_RPC_BIG;
    } else {
      this.r0hi[i] = raw0 >> 64n;
      this.r0lo[i] = raw0 & WORD;
      this.r1hi[i] = raw1 >> 64n;
      this.r1lo[i] = raw1 & WORD;
      f &= ~F_RPC_BIG;
    }
    this.rblk[i] = rpc.block;
    if (rpc.at instanceof Date && Number.isFinite(rpc.at.getTime())) {
      this.rat[i] = rpc.at.getTime();
      f |= F_RPC_AT;
    } else {
      f &= ~F_RPC_AT;
    }
    this.flags[i] = f;
  }

  private read(i: number): StoreRow {
    const f = this.flags[i]!;
    const tokenId = this.id(i);
    const row: StoreRow = {
      positionId: tokenId,
      tokenId,
      poolId: this.poolDict[this.pool[i]!]!,
      tickLower: this.tickL[i]!,
      tickUpper: this.tickU[i]!,
      lastModifyBlock: this.lmb[i]!,
      decimals0: this.dec0[i]!,
      decimals1: this.dec1[i]!,
      price0: this.p0[i]!,
      price1: this.p1[i]!,
      isPriceable: (f & F_PRICEABLE) !== 0,
      ...((f & F_ONCHAIN) !== 0 ? { feesSource: 'onchain' } : {}),
      pendingFeesUsd: this.pend[i]!,
      ...((f & F_VERIFY) !== 0 ? { verify: true } : {}),
      updatedAtMs: this.upd[i]!,
    };
    if (f & F_RPC) {
      const big = (f & F_RPC_BIG) !== 0 ? this.bigRpc.get(tokenId) : undefined;
      row.rpc = {
        fees0: big ? big.fees0 : formatUnits((this.r0hi[i]! << 64n) | this.r0lo[i]!, this.dec0[i]!),
        fees1: big ? big.fees1 : formatUnits((this.r1hi[i]! << 64n) | this.r1lo[i]!, this.dec1[i]!),
        block: this.rblk[i]!,
        ...((f & F_RPC_AT) !== 0 ? { at: new Date(this.rat[i]!) } : {}),
      };
    }
    return row;
  }
}

/**
 * Whether `incoming` replaces `current`: a later `lastModifyBlock` wins
 * outright; at the same block the later writer/doc time wins (ties go to the
 * incoming one — it was taken later). A lower block never wins: the stored row
 * already knows of a later settle.
 */
export function newerWins(current: Pick<StoreRow, 'lastModifyBlock' | 'updatedAtMs'>, incoming: Pick<StoreRow, 'lastModifyBlock' | 'updatedAtMs'>): boolean {
  const a = finite(current.lastModifyBlock);
  const b = finite(incoming.lastModifyBlock);
  if (b !== a) return b > a;
  return finite(incoming.updatedAtMs) >= finite(current.updatedAtMs);
}

/**
 * Whether two rows hold the same stored CONTENT (what a reconcile must not
 * count as drift). `updatedAtMs` is deliberately not compared: it is the
 * newer-wins clock, and a hint's writer time can never equal the doc's
 * `updatedAt` (Mongoose stamps it later), nor does a fee write's bump of it
 * change anything the store holds.
 */
export function sameRow(a: StoreRow, b: StoreRow): boolean {
  return (
    a.poolId === b.poolId &&
    a.tickLower === b.tickLower &&
    a.tickUpper === b.tickUpper &&
    finite(a.lastModifyBlock) === finite(b.lastModifyBlock) &&
    a.decimals0 === clampByte(b.decimals0) &&
    a.decimals1 === clampByte(b.decimals1) &&
    finite(a.price0) === finite(b.price0) &&
    finite(a.price1) === finite(b.price1) &&
    a.isPriceable === b.isPriceable &&
    (a.feesSource === 'onchain') === (b.feesSource === 'onchain') &&
    finite(a.pendingFeesUsd) === finite(b.pendingFeesUsd) &&
    sameRpc(a.rpc, b.rpc)
  );
}

function sameRpc(a: StoreRow['rpc'], b: StoreRow['rpc']): boolean {
  if (!a || !b) return !a && !b;
  return a.block === b.block && a.fees0 === b.fees0 && a.fees1 === b.fees1 && (a.at?.getTime() ?? 0) === (b.at?.getTime() ?? 0);
}

/** A canonical decimal integer below 2^53 round-trips through a Float64 exactly. */
function numericId(id: string): boolean {
  return CANONICAL_INT.test(id) && Number.isSafeInteger(Number(id));
}

function finite(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function clampByte(v: unknown): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n >= 0 && n <= 255 ? n : 255;
}
