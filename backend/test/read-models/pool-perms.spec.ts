import { describe, expect, it } from 'vitest';
import { compareNumCells, NC_NAN, NC_NULL, NC_NUM, writeSortKey } from '../../src/read-models/core/bson-order.js';
import { Dictionary } from '../../src/read-models/core/dictionary.js';
import { POOL_ID_COL, POOL_PERMS, PoolColumns, prefixKey, type PoolOverlay } from '../../src/read-models/pools/pool-columns.js';
import { buildPoolPerms, comparePoolIds, updatePoolPerms } from '../../src/read-models/pools/pool-perms.js';
import { sharedU32 } from '../../src/read-models/core/shared-memory.js';
import { mongoCompare, prng } from '../support/mini-mongo.js';

/**
 * The catalog's permutations (design §4.6): BSON order of the sort leaf
 * (null = missing < NaN < −∞ … +∞, -0 = +0) then poolId binary; the radix
 * build equals a comparator sort; the per-generation merge-update equals a
 * full rebuild after any sequence of inserts, updates and deletes.
 */

const VALUES: Array<number | null> = [null, NaN, -Infinity, -5, -0, 0, 0, 0, 1, 1, 2.5, 1e6, 6e10, Infinity];

/** A numeric cell, `-0` kept as is (the key must tie it with `+0` itself). */
function cellOf(value: number | null): { nc: number; v: number } {
  if (value === null) return { nc: NC_NULL, v: 0 };
  if (Number.isNaN(value)) return { nc: NC_NAN, v: 0 };
  return { nc: NC_NUM, v: value };
}

describe('bson-order', () => {
  it('sort keys order exactly as MongoDB compares (both directions, random mixes)', () => {
    const rand = prng(1);
    const hi = new Uint32Array(2);
    const lo = new Uint32Array(2);
    const pool = [...VALUES, 1e-300, -1e-300, 5e-324, -5e-324, 2 ** 53, -(2 ** 53), 123.456];
    for (let i = 0; i < 5_000; i++) {
      const a = pool[Math.floor(rand() * pool.length)];
      const b = pool[Math.floor(rand() * pool.length)];
      const expected = Math.sign(mongoCompare(a, b, false));
      const ca = cellOf(a);
      const cb = cellOf(b);
      expect(Math.sign(compareNumCells(ca.nc, ca.v, cb.nc, cb.v)), `${a} vs ${b}`).toBe(expected);
      for (const desc of [false, true]) {
        writeSortKey(ca.nc, ca.v, desc, hi, lo, 0);
        writeSortKey(cb.nc, cb.v, desc, hi, lo, 1);
        const byKey = hi[0] !== hi[1] ? (hi[0] < hi[1] ? -1 : 1) : lo[0] !== lo[1] ? (lo[0] < lo[1] ? -1 : 1) : 0;
        expect(byKey, `${a} vs ${b} desc=${desc}`).toBe(desc ? -expected || 0 : expected);
      }
    }
  });
});

/** A random shard: columns + dictionary of pool ids (some sharing 8-byte prefixes). */
function shard(seed: number, n: number) {
  const rand = prng(seed);
  const dict = new Dictionary();
  const cols = new PoolColumns(n * 3 + 64);
  const hex = () => Math.floor(rand() * 16).toString(16);
  const id = () => {
    const prefix = rand() < 0.4 ? ['0xaaaaaa', '0x000000', '0xffffff'][Math.floor(rand() * 3)] : `0x${Array.from({ length: 6 }, hex).join('')}`;
    // Short ids too: 'ab' vs 'ab…' prefix order, zero padding.
    const tail = rand() < 0.1 ? '' : Array.from({ length: Math.floor(rand() * 58) }, hex).join('');
    return prefix + tail;
  };
  const used = new Set<string>();
  const write = (slot: number, live: boolean) => {
    let poolId = id();
    while (used.has(poolId)) poolId = id();
    used.add(poolId);
    const sid = dict.intern(poolId) + 1;
    return { slot, live, sid, nums: POOL_PERMS.map(() => cellOf(VALUES[Math.floor(rand() * VALUES.length)])) };
  };
  return { rand, dict, cols, write };
}

function overlayOf(rows: Array<{ slot: number; live: boolean; sid: number; nums: Array<{ nc: number; v: number }> }>, dict: Dictionary): PoolOverlay {
  const n = rows.length;
  const overlay: PoolOverlay = {
    n,
    slots: Uint32Array.from(rows.map((r) => r.slot)),
    live: Uint8Array.from(rows.map((r) => (r.live ? 1 : 0))),
    nc: POOL_PERMS.map(() => new Uint8Array(n)),
    nv: POOL_PERMS.map(() => new Float64Array(n)),
    sid: Array.from({ length: 6 }, () => new Uint32Array(n)),
    bv: [new Uint8Array(n)],
    pkHi: new Uint32Array(n),
    pkLo: new Uint32Array(n),
  };
  const view = dict.sharedView();
  rows.forEach((row, i) => {
    POOL_PERMS.forEach((perm, p) => {
      overlay.nc[perm.numPos][i] = row.nums[p].nc;
      overlay.nv[perm.numPos][i] = row.nums[p].v;
    });
    overlay.sid[POOL_ID_COL][i] = row.sid;
    [overlay.pkHi[i], overlay.pkLo[i]] = prefixKey(view, row.sid - 1);
  });
  return overlay;
}

/** The reference order: live slots sorted by (leaf BSON × dir, poolId binary). */
function reference(cols: PoolColumns, dict: Dictionary, p: number): number[] {
  const perm = POOL_PERMS[p];
  const view = dict.sharedView();
  const a = cols.arrays;
  const slots: number[] = [];
  for (let s = 0; s < cols.slots; s++) if (a.live[s] === 1) slots.push(s);
  return slots.sort((x, y) => {
    const c = compareNumCells(a.nc[perm.numPos][x], a.nv[perm.numPos][x], a.nc[perm.numPos][y], a.nv[perm.numPos][y]) * (perm.descending ? -1 : 1);
    if (c !== 0) return c;
    const sx = a.sid[POOL_ID_COL][x];
    const sy = a.sid[POOL_ID_COL][y];
    const bx = Buffer.from(dict.get(sx - 1));
    const by = Buffer.from(dict.get(sy - 1));
    expect(comparePoolIds(view, sx, a.pkHi[x], a.pkLo[x], view, sy, a.pkHi[y], a.pkLo[y])).toBe(Buffer.compare(bx, by));
    return Buffer.compare(bx, by);
  });
}

describe('pool permutations', () => {
  it('a full radix build equals the comparator order for every sort', () => {
    const { dict, cols, write, rand } = shard(3, 600);
    const rows = Array.from({ length: 600 }, (_, slot) => write(slot, rand() < 0.9));
    cols.applyOverlay(overlayOf(rows, dict), dict.sharedView());
    const out = POOL_PERMS.map(() => sharedU32(cols.arrays.capacity));
    const length = buildPoolPerms(cols.arrays, dict.sharedView(), cols.slots, out);
    expect(length).toBe(cols.live);
    POOL_PERMS.forEach((_, p) => expect([...out[p].subarray(0, length)], `perm ${p}`).toEqual(reference(cols, dict, p)));
  });

  it('a merge-update equals a full rebuild after 300 random generations (inserts, updates, deletes, re-inserts)', () => {
    const { dict, cols, write, rand } = shard(5, 400);
    cols.applyOverlay(overlayOf(Array.from({ length: 400 }, (_, slot) => write(slot, true)), dict), dict.sharedView());
    let perms = POOL_PERMS.map(() => sharedU32(cols.arrays.capacity));
    let spare = POOL_PERMS.map(() => sharedU32(cols.arrays.capacity));
    let length = buildPoolPerms(cols.arrays, dict.sharedView(), cols.slots, perms);
    const sidOf = (slot: number) => cols.arrays.sid[POOL_ID_COL][slot];
    for (let gen = 0; gen < 300; gen++) {
      const changes = new Map<number, ReturnType<typeof write>>();
      const k = 1 + Math.floor(rand() * 25);
      for (let j = 0; j < k; j++) {
        const r = rand();
        if (r < 0.2) {
          const slot = cols.slots + changes.size; // insert past the high-water mark
          if (!changes.has(slot) && slot < cols.arrays.capacity - 1) changes.set(slot, write(slot, true));
        } else {
          const slot = Math.floor(rand() * cols.slots);
          const keep = sidOf(slot);
          const row = write(slot, r > 0.35); // deletes and re-inserts of the same slot too
          // A slot keeps its poolId (the catalog rebuilds when one changes).
          changes.set(slot, { ...row, sid: keep || row.sid });
        }
      }
      const overlay = overlayOf([...changes.values()], dict);
      const view = dict.sharedView();
      const next = updatePoolPerms(cols.arrays, view, overlay, perms, length, spare);
      cols.applyOverlay(overlay, view);
      [perms, spare] = [spare, perms];
      length = next;
      expect(length, `gen ${gen}`).toBe(cols.live);
      if (gen % 25 === 24 || gen < 5) {
        const rebuilt = POOL_PERMS.map(() => sharedU32(cols.arrays.capacity));
        buildPoolPerms(cols.arrays, view, cols.slots, rebuilt);
        POOL_PERMS.forEach((_, p) => expect([...perms[p].subarray(0, length)], `gen ${gen} perm ${p}`).toEqual([...rebuilt[p].subarray(0, length)]));
      }
    }
  });
});
