import type { LeafKind } from './fields.js';

/**
 * One leaf's value in a read-model row (design §4.3 / §4.8).
 *
 * In JS a cell is the value itself, its class read off its type — the leaf's
 * kind (`fields.ts`) makes that unambiguous:
 *  - `null`          null OR missing (one class: MongoDB filters and sorts them alike)
 *  - `number`        `num` leaf: any double, NaN and ±Infinity included, -0 stored as +0;
 *                    `pid` leaf: the canonical u32 id
 *  - `string`        `str` leaf
 *  - `boolean`       `bool` leaf
 *  - `{ odd: t }`    anything outside the leaf's native classes (an array, an
 *                    object, a string in a numeric field, a Decimal128, a
 *                    non-canonical positionId, …). Quarantines (shard, field).
 *
 * On the wire (`delta-codec.ts`) and in columns (`row-store.ts`) a cell is a
 * class byte plus, for NUM / STR / PID, an 8- or 4-byte payload.
 */
export type Cell = null | number | string | boolean | OddCell;

export interface OddCell {
  readonly odd: OddType;
}

/** Why a cell is odd. The index is the wire code (`CLS.ODD_BASE + index`): append only. */
export const ODD_TYPES = [
  'array',
  'object',
  'string',
  'number',
  'bool',
  'date',
  'decimal',
  'long',
  'objectId',
  'binary',
  'pid',
  'other',
] as const;
export type OddType = (typeof ODD_TYPES)[number];

/** Cell class codes (one byte per cell in columns and on the wire). */
export const CLS = {
  NULL: 0,
  NUM: 2,
  STR: 3,
  TRUE: 4,
  FALSE: 5,
  PID: 6,
  /** `ODD_BASE + ODD_TYPES.indexOf(type)`. */
  ODD_BASE: 64,
} as const;

const ODD_SINGLETONS = new Map<OddType, OddCell>(ODD_TYPES.map((t) => [t, Object.freeze({ odd: t })]));

/** The shared, frozen odd cell for `type`. */
export function oddCell(type: OddType): OddCell {
  return ODD_SINGLETONS.get(type) ?? ODD_SINGLETONS.get('other')!;
}

export function isOdd(cell: Cell): cell is OddCell {
  return typeof cell === 'object' && cell !== null;
}

/**
 * Equality for the no-op drop and the parity checks: NaN equals NaN (a row
 * whose pnl stays NaN did not change), odd cells compare by type.
 */
export function cellsEqual(a: Cell, b: Cell): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Number.isNaN(a) && Number.isNaN(b);
  if (isOdd(a) && isOdd(b)) return a.odd === b.odd;
  return false;
}

export function rowsEqual(a: readonly Cell[], b: readonly Cell[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!cellsEqual(a[i], b[i])) return false;
  return true;
}

/** The class byte of `cell` for a leaf of `kind`. */
export function classOf(cell: Cell, kind: LeafKind): number {
  if (cell === null) return CLS.NULL;
  if (isOdd(cell)) return CLS.ODD_BASE + ODD_TYPES.indexOf(cell.odd);
  switch (kind) {
    case 'num':
      return typeof cell === 'number' ? CLS.NUM : CLS.ODD_BASE + ODD_TYPES.indexOf('other');
    case 'pid':
      return typeof cell === 'number' ? CLS.PID : CLS.ODD_BASE + ODD_TYPES.indexOf('other');
    case 'str':
      return typeof cell === 'string' ? CLS.STR : CLS.ODD_BASE + ODD_TYPES.indexOf('other');
    case 'bool':
      return cell === true ? CLS.TRUE : cell === false ? CLS.FALSE : CLS.ODD_BASE + ODD_TYPES.indexOf('other');
  }
}

/** The odd cell for a class byte at or above `ODD_BASE`. */
export function oddFromClass(cls: number): OddCell {
  return oddCell(ODD_TYPES[cls - CLS.ODD_BASE] ?? 'other');
}

export function isOddClass(cls: number): boolean {
  return cls >= CLS.ODD_BASE;
}

/** -0 → +0 (they tie in every comparison MongoDB makes, design F2). */
export function canonicalNumber(value: number): number {
  return value === 0 ? 0 : value;
}

/** A canonical u32 id string: `0` or `[1-9][0-9]*`, below 2^32. */
export function canonicalPid(value: string): number | undefined {
  if (value.length === 0 || value.length > 10) return undefined;
  if (value.length > 1 && value.charCodeAt(0) === 48 /* '0' */) return undefined;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 48 || c > 57) return undefined;
  }
  const n = Number(value);
  return n <= 0xffffffff ? n : undefined;
}

/** A short, stable description of a cell for logs and diff lines. */
export function describeCell(cell: Cell): string {
  if (cell === null) return 'null';
  if (isOdd(cell)) return `odd:${cell.odd}`;
  if (typeof cell === 'string') return JSON.stringify(cell);
  if (typeof cell === 'number' && !Number.isFinite(cell)) return String(cell);
  return String(cell);
}
