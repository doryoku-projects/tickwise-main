import { describe, expect, it } from 'vitest';
import { Dictionary } from '../../src/read-models/core/dictionary.js';
import { shardKey } from '../../src/read-models/core/fields.js';
import { OID_BYTES } from '../../src/read-models/core/oid-map.js';
import { ShardTable } from '../../src/read-models/core/row-store.js';
import { buildRankStore, makePositions, PROTO } from './rank-support.js';

/**
 * Snapshot loads in slices (review finding: a whole table's load blocked the
 * event loop in one go on a replica already answering HTTP). The sliced
 * (async) load produces exactly the table the one-shot load does, and gives
 * the event loop turns while it runs.
 */

function snapshotOf(table: ShardTable) {
  const rows = table.slots;
  const cls = table.leaves.map((_, l) => table.cls[l].slice(0, rows));
  const val = table.leaves.map((_, l) => table.num[l]?.slice(0, rows) ?? table.ids[l]?.slice(0, rows));
  const { offsets, bytes } = table.dict.exportColumns();
  return { rows, oids: table.oids.slice(0, rows * OID_BYTES), cls, val, offsets: offsets.slice(), bytes: bytes.slice() };
}

describe('sliced snapshot loads', () => {
  it('loadColumnsAsync / fromColumnsAsync build exactly what the one-shot load builds, yielding between slices', async () => {
    const docs = makePositions(61, 1, 3_000);
    docs[0]!.isActive = 'true'; // quarantined rows (the first and the last slot): the counts must match too
    docs[docs.length - 1]!.isActive = 'true';
    const source = buildRankStore(new Map([[1, docs]])).table('rank', shardKey(1, PROTO))!;
    const snap = snapshotOf(source);

    const syncDict = Dictionary.fromColumns(snap.offsets, snap.bytes);
    const sync = new ShardTable('rank', shardKey(1, PROTO), snap.rows + 16, syncDict);
    sync.loadColumns(snap.rows, snap.oids, snap.cls, snap.val);

    let turns = 0;
    let spinning = true;
    const spin = () => {
      if (!spinning) return;
      turns++;
      setImmediate(spin);
    };
    setImmediate(spin);
    const asyncDict = await Dictionary.fromColumnsAsync(snap.offsets, snap.bytes, 1.25, 256);
    const loaded = new ShardTable('rank', shardKey(1, PROTO), snap.rows + 16, asyncDict);
    await loaded.loadColumnsAsync(snap.rows, snap.oids, snap.cls, snap.val, 256);
    spinning = false;
    expect(turns).toBeGreaterThan(10);

    expect(loaded.slots).toBe(sync.slots);
    expect(loaded.live).toBe(sync.live);
    expect([...loaded.quarantine]).toEqual([...sync.quarantine]);
    expect([...loaded.quarantine]).toEqual([...source.quarantine]);
    expect([...loaded.quarantine].some((n) => n > 0)).toBe(true);
    for (let slot = 0; slot < sync.slots; slot++) {
      expect(loaded.cellsAt(slot)).toEqual(sync.cellsAt(slot));
      const oid = sync.oidAt(slot);
      expect(loaded.slotOf(oid)).toBe(slot);
    }
    for (let id = 0; id < syncDict.size; id++) expect(asyncDict.find(syncDict.get(id)!)).toBe(id);
  });
});
