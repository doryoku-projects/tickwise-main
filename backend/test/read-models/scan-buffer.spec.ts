/*
 * The scan buffer (design §3.2 step 2): coalescing the change events of a
 * shard under scan per `_id` must equal replaying them in order on top of the
 * scanned row — for any interleaving of insert / replace / update / delete.
 */
import { describe, expect, it } from 'vitest';
import { rowsEqual, type Cell } from '../../src/read-models/core/cells.js';
import { leafIndex, RANK_LEAVES } from '../../src/read-models/core/fields.js';
import type { RowChange } from '../../src/read-models/feeder/messages.js';
import { applySets, normalizeDoc, type LeafSet } from '../../src/read-models/feeder/normalize.js';
import { ScanBuffer } from '../../src/read-models/feeder/scan-buffer.js';
import { positionDoc } from './fake-cluster.js';

/** A seeded PRNG so a failure reproduces. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Row = Cell[] | null; // null = absent / deleted

/** Apply one change to a row the way the main thread does (state ⊕ sets; delete; sets on the current row). */
function apply(row: Row, change: RowChange): Row {
  if (change.base === 'delete') return null;
  if (change.base === 'state') return applySets(change.state!, change.sets ?? []);
  if (!row) return null; // an update on an absent row: nothing to update (the holder repairs it)
  return applySets(row, change.sets ?? []);
}

function randomChange(random: () => number, oid: string): RowChange {
  const r = random();
  if (r < 0.15) return { coll: 'c', oid, base: 'state', state: normalizeDoc('rank', positionDoc(Math.floor(random() * 1000))) };
  if (r < 0.25) return { coll: 'c', oid, base: 'delete' };
  const sets: LeafSet[] = [];
  const n = 1 + Math.floor(random() * 4);
  for (let i = 0; i < n; i++) {
    const leaf = Math.floor(random() * RANK_LEAVES.length);
    const kind = RANK_LEAVES[leaf].kind;
    const cell: Cell = random() < 0.2 ? null : kind === 'num' ? Math.round(random() * 1e6) / 100 : kind === 'bool' ? random() < 0.5 : kind === 'pid' ? Math.floor(random() * 1e6) : `s${Math.floor(random() * 50)}`;
    sets.push([leaf, cell]);
  }
  return { coll: 'c', oid, base: 'none', sets };
}

describe('scan buffer', () => {
  it('coalesced apply equals in-order replay over random histories (2,000 rows × up to 12 events)', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const random = rng(seed);
      const buffer = new ScanBuffer(Number.POSITIVE_INFINITY);
      const scanned = new Map<string, Row>();
      const replayed = new Map<string, Row>();
      for (let r = 0; r < 100; r++) {
        const oid = r.toString(16).padStart(24, '0');
        // The row the scan saw (or not: inserted later / deleted before the cursor).
        const start: Row = random() < 0.8 ? normalizeDoc('rank', positionDoc(r)) : null;
        scanned.set(oid, start);
        let row = start;
        const events = Math.floor(random() * 12);
        for (let e = 0; e < events; e++) {
          const change = randomChange(random, oid);
          // MongoDB never delivers an update / delete for an absent doc; model that.
          if (!row && change.base !== 'state') continue;
          row = apply(row, change);
          buffer.add(change);
        }
        replayed.set(oid, row);
      }
      for (const record of buffer.drain()) scanned.set(record.oid, apply(scanned.get(record.oid) ?? null, record));
      for (const [oid, expected] of replayed) {
        const got = scanned.get(oid) ?? null;
        expect(got === null ? null : got.length).toBe(expected === null ? null : expected.length);
        if (got && expected) expect(rowsEqual(got, expected)).toBe(true);
      }
    }
  });

  it('a later set of the same leaf wins; an insert after a delete is a fresh base', () => {
    const buffer = new ScanBuffer(1e9);
    const value = leafIndex('rank', 'metrics.underlyingValueUsd');
    buffer.add({ coll: 'c', oid: 'a', base: 'none', sets: [[value, 1]] });
    buffer.add({ coll: 'c', oid: 'a', base: 'none', sets: [[value, 2]] });
    buffer.add({ coll: 'c', oid: 'b', base: 'delete' });
    const state = normalizeDoc('rank', positionDoc(9));
    buffer.add({ coll: 'c', oid: 'b', base: 'state', state });
    buffer.add({ coll: 'c', oid: 'b', base: 'none', sets: [[value, 3]] });
    const [a, b] = buffer.drain();
    expect(a).toMatchObject({ base: 'none', sets: [[value, 2]] });
    expect(b.base).toBe('state');
    expect(b.state?.[value]).toBe(3);
    expect(buffer.size).toBe(0);
    expect(buffer.bytes).toBe(0);
  });

  it('drains one collection at a time (in-epoch shard scans) and remembers the last token / time', () => {
    const buffer = new ScanBuffer(1e9);
    buffer.add({ coll: 'x', oid: '1', base: 'delete', rt: '82aa', ct: '1:1' });
    buffer.add({ coll: 'y', oid: '1', base: 'delete', rt: '82bb', ct: '1:2' });
    expect(buffer.drain('x')).toHaveLength(1);
    expect(buffer.size).toBe(1);
    expect(buffer.lastRt).toBe('82bb');
    expect(buffer.lastCt).toBe('1:2');
  });

  it('past its cap it refuses (overflow): nothing more is buffered, and lastRt is the replay point', () => {
    const buffer = new ScanBuffer(2_000);
    let accepted = 0;
    for (let i = 0; i < 100; i++) {
      if (buffer.add({ coll: 'c', oid: String(i), base: 'state', state: normalizeDoc('rank', positionDoc(i)), rt: `82${i}` })) accepted++;
      else break;
    }
    expect(buffer.overflowed).toBe(true);
    expect(accepted).toBeGreaterThan(0);
    expect(buffer.lastRt).toBe(`82${accepted - 1}`);
    expect(buffer.add({ coll: 'c', oid: 'late', base: 'delete' })).toBe(false);
    expect(buffer.bytes).toBeLessThanOrEqual(2_000);
  });
});
