/*
 * The delta stream's binary payload and entry fields (design §3.4), and the
 * row-state core it lands in: the off-heap dictionary, the `_id` table and the
 * shard table (with its quarantine counts).
 */
import { describe, expect, it } from 'vitest';
import { CLS, oddCell, rowsEqual, type Cell } from '../../src/read-models/core/cells.js';
import { Dictionary, DictionaryMismatchError } from '../../src/read-models/core/dictionary.js';
import { leafIndex, RANK_LEAVES } from '../../src/read-models/core/fields.js';
import { ModelDivergedError, ModelStore } from '../../src/read-models/core/model-store.js';
import { OidMap, oidToBytes, oidToHex } from '../../src/read-models/core/oid-map.js';
import { encodeCells, ShardTable } from '../../src/read-models/core/row-store.js';
import {
  compareStreamIds,
  decodePayload,
  DeltaCodecError,
  encodePayload,
  entryFields,
  entryFromFields,
  type DeltaRecord,
} from '../../src/read-models/feeder/delta-codec.js';
import { normalizeDoc } from '../../src/read-models/feeder/normalize.js';
import { positionDoc } from './fake-cluster.js';

const oid = (n: number) => n.toString(16).padStart(24, '0');

function encodeRow(cells: Cell[], dict: Dictionary) {
  return encodeCells(RANK_LEAVES, cells, (v) => dict.intern(v));
}

describe('delta payload codec', () => {
  it('round-trips dictionary adds, full-state upserts (NaN, ±Inf, odd, null), deletes and shard marks', () => {
    const dict = new Dictionary();
    const cells = normalizeDoc('rank', positionDoc(7, { metrics: { underlyingValueUsd: Number.POSITIVE_INFINITY, poolPnlUsd: Number.NaN, aprExGas: [1], roi: null } }));
    const row = encodeRow(cells, dict);
    const records: DeltaRecord[] = [
      ...Array.from({ length: dict.size }, (_, id) => ({ t: 'dict' as const, model: 'rank' as const, shard: '1:uniswap-v4', id, value: dict.get(id) })),
      { t: 'upsert', model: 'rank', shard: '1:uniswap-v4', oid: oid(1), row },
      { t: 'delete', model: 'pools', shard: '4663:uniswap-v4', oid: oid(2) },
      { t: 'shard', model: 'pools', shard: '4663:uniswap-v4', state: 'reset' },
      { t: 'shard', model: 'rank', shard: '1:uniswap-v4', state: 'ready' },
    ];
    const decoded = decodePayload(encodePayload(records));
    expect(decoded).toHaveLength(records.length);
    const upsert = decoded.find((r) => r.t === 'upsert');
    expect(upsert && upsert.t === 'upsert' && upsert.oid).toBe(oid(1));
    if (upsert?.t !== 'upsert') throw new Error('no upsert');
    expect([...upsert.row.cls]).toEqual([...row.cls]);
    const valueLeaf = leafIndex('rank', 'metrics.underlyingValueUsd');
    const pnlLeaf = leafIndex('rank', 'metrics.poolPnlUsd');
    expect(upsert.row.val[valueLeaf]).toBe(Number.POSITIVE_INFINITY);
    expect(Number.isNaN(upsert.row.val[pnlLeaf])).toBe(true);
    expect(upsert.row.cls[leafIndex('rank', 'metrics.aprExGas')]).toBe(CLS.ODD_BASE); // odd: array
    expect(upsert.row.cls[leafIndex('rank', 'metrics.roi')]).toBe(CLS.NULL);
    expect(decoded.filter((r) => r.t === 'shard').map((r) => r.t === 'shard' && r.state)).toEqual(['reset', 'ready']);
    expect(decoded.filter((r) => r.t === 'dict').map((r) => r.t === 'dict' && r.value)).toEqual(Array.from({ length: dict.size }, (_, id) => dict.get(id)));
  });

  it('an empty record list is the empty (heartbeat) payload', () => {
    expect(encodePayload([]).byteLength).toBe(0);
    expect(decodePayload(new Uint8Array(0))).toEqual([]);
  });

  it('refuses malformed payloads instead of guessing', () => {
    const good = encodePayload([{ t: 'delete', model: 'rank', shard: '1:uniswap-v4', oid: oid(3) }]);
    expect(() => decodePayload(good.slice(0, good.length - 1))).toThrow(DeltaCodecError);
    const bad = good.slice();
    bad[0] ^= 0xff;
    expect(() => decodePayload(bad)).toThrow(/magic/);
    const trailing = new Uint8Array(good.length + 1);
    trailing.set(good);
    expect(() => decodePayload(trailing)).toThrow(/trailing/);
  });

  it('a row with MORE cells than this build knows is read; one with fewer is flagged (field backfill)', () => {
    const row = encodeRow(normalizeDoc('rank', positionDoc(1)), new Dictionary());
    const longer = { cls: new Uint8Array([...row.cls, CLS.NUM]), val: new Float64Array([...row.val, 42]) };
    const [wide] = decodePayload(encodePayload([{ t: 'upsert', model: 'rank', shard: '1:uniswap-v4', oid: oid(1), row: longer }]));
    expect(wide.t === 'upsert' && wide.cells).toBeUndefined();
    const shorter = { cls: row.cls.slice(0, 5), val: row.val.slice(0, 5) };
    const [narrow] = decodePayload(encodePayload([{ t: 'upsert', model: 'rank', shard: '1:uniswap-v4', oid: oid(1), row: shorter }]));
    expect(narrow.t === 'upsert' && narrow.cells).toBe(5);
  });

  it('stream entry fields round-trip, the payload as raw bytes', () => {
    const d = encodePayload([{ t: 'shard', model: 'rank', shard: '42161:uniswap-v4', state: 'scanning' }]);
    const entry = { f: 1_790_000_000_123, e: 1_790_000_000_000, inc: 'abc', s: 7, ct: '5:1', rt: '8200', k: 'batch' as const, ca: 99, d };
    const back = entryFromFields('1-0', entryFields(entry).map((f) => (typeof f === 'string' ? Buffer.from(f) : f)));
    expect({ ...back, d: [...back.d] }).toEqual({ ...entry, id: '1-0', d: [...d] });
    expect(() => entryFromFields('1-0', ['k', 'nope'])).toThrow(/unknown kind/);
  });

  it('orders stream ids numerically, not as strings', () => {
    expect(compareStreamIds('9-0', '10-0')).toBeLessThan(0);
    expect(compareStreamIds('10-2', '10-10')).toBeLessThan(0);
    expect(compareStreamIds('10-1', '10-1')).toBe(0);
  });
});

describe('dictionary', () => {
  it('assigns dense ids in insertion order and finds them again (UTF-8, long strings)', () => {
    const dict = new Dictionary(4, 16);
    const values = ['0xabc', 'USD₮0', '', 'x'.repeat(5_000), '🦄', ...Array.from({ length: 3_000 }, (_, i) => `0x${i.toString(16).padStart(40, '0')}`)];
    values.forEach((v, i) => expect(dict.intern(v)).toBe(i));
    values.forEach((v, i) => {
      expect(dict.find(v)).toBe(i);
      expect(dict.get(i)).toBe(v);
    });
    expect(dict.find('missing')).toBe(-1);
    expect(dict.intern('USD₮0')).toBe(1);
  });

  it('a replica must add the holder’s ids in order, never a duplicate', () => {
    const dict = new Dictionary();
    dict.addAt(0, 'a');
    expect(() => dict.addAt(2, 'b')).toThrow(DictionaryMismatchError);
    expect(() => dict.addAt(1, 'a')).toThrow(DictionaryMismatchError);
    dict.addAt(1, 'b');
    expect(dict.size).toBe(2);
  });

  it('survives its snapshot form with ids preserved', () => {
    const dict = new Dictionary();
    for (let i = 0; i < 500; i++) dict.intern(`v${i}`);
    const { offsets, bytes } = dict.exportColumns();
    const back = Dictionary.fromColumns(offsets.slice(), bytes.slice());
    for (let i = 0; i < 500; i++) expect(back.find(`v${i}`)).toBe(i);
    expect(back.intern('new')).toBe(500);
  });

  it('flags strings outside printable ASCII (the collation-key domain: C0, DEL, ZWSP are ignorable under the collation)', () => {
    const dict = new Dictionary();
    expect(dict.isPrintableAscii(dict.intern('0xabcDEF 09~'))).toBe(true);
    for (const v of ['a\u0000b', 'a\u007fb', 'a​b', 'é', 'a\tb']) expect(dict.isPrintableAscii(dict.intern(v))).toBe(false);
  });
});

describe('oid map', () => {
  it('finds slots by 12-byte id across growth', () => {
    const oids = new Uint8Array(20_000 * 12);
    const map = new OidMap(16);
    const key = new Uint8Array(12);
    for (let slot = 0; slot < 20_000; slot++) {
      oidToBytes(oid(slot * 7919), oids, slot * 12);
      map.add(oids, slot);
    }
    for (let slot = 0; slot < 20_000; slot += 97) {
      oidToBytes(oid(slot * 7919), key);
      expect(map.find(oids, key)).toBe(slot);
    }
    oidToBytes(oid(1), key);
    expect(map.find(oids, key)).toBe(-1);
    expect(oidToHex(oids, 12)).toBe(oid(7919));
    expect(oidToBytes('zz', key)).toBe(false);
  });
});

describe('shard table + model store', () => {
  it('upserts, deletes and reinserts by _id, growing capacity, cells read back exactly', () => {
    const table = new ShardTable('rank', '1:uniswap-v4', 16);
    const states = new Map<string, Cell[]>();
    for (let n = 0; n < 200; n++) {
      const cells = normalizeDoc('rank', positionDoc(n));
      states.set(oid(n), cells);
      table.upsert(oid(n), encodeCells(table.leaves, cells, (v) => table.dict.intern(v)));
    }
    expect(table.live).toBe(200);
    expect(table.capacity).toBeGreaterThanOrEqual(200);
    for (const [id, cells] of states) {
      const slot = table.liveSlotOf(id);
      expect(rowsEqual(table.cellsAt(slot), cells)).toBe(true);
      expect(table.sameAs(slot, cells)).toBe(true);
    }
    expect(table.delete(oid(5))).toBe(true);
    expect(table.delete(oid(5))).toBe(false);
    expect(table.liveSlotOf(oid(5))).toBe(-1);
    const slotBefore = table.slotOf(oid(5));
    table.upsert(oid(5), encodeCells(table.leaves, states.get(oid(5))!, (v) => table.dict.intern(v)));
    expect(table.liveSlotOf(oid(5))).toBe(slotBefore); // a reinsert reuses the tombstoned slot
    expect(table.live).toBe(200);
  });

  it('the no-op check never mints: an unknown string is a change', () => {
    const table = new ShardTable('rank', '1:uniswap-v4');
    const cells = normalizeDoc('rank', positionDoc(3));
    table.upsert(oid(1), encodeCells(table.leaves, cells, (v) => table.dict.intern(v)));
    const size = table.dict.size;
    const changed = cells.slice();
    changed[leafIndex('rank', 'owner')] = '0xnew';
    expect(table.sameAs(table.liveSlotOf(oid(1)), changed)).toBe(false);
    expect(table.dict.size).toBe(size);
  });

  it('counts quarantine per field: odd cells, a foreign chain / protocol, tokenId ≠ positionId, non-printable collated strings', () => {
    const seen: string[] = [];
    const table = new ShardTable('rank', '1:uniswap-v4', 16, undefined, (_m, _s, leaf) => seen.push(leaf));
    const put = (n: number, over: Record<string, unknown>) =>
      table.upsert(oid(n), encodeCells(table.leaves, normalizeDoc('rank', positionDoc(n, over)), (v) => table.dict.intern(v)));
    put(1, {});
    expect(table.quarantineCounts()).toEqual({});
    put(2, { chainId: 42161 });
    put(3, { protocol: 'uniswap-v3' });
    put(4, { tokenId: '5' });
    put(5, { owner: 'a\u0000b' });
    put(6, { metrics: 'oops' });
    const counts = table.quarantineCounts();
    expect(counts).toMatchObject({ chainId: 1, protocol: 1, tokenId: 1, owner: 1, value: 1, aprExGas: 1 });
    expect(seen).toEqual(expect.arrayContaining(['chainId', 'protocol', 'tokenId', 'owner', 'value']));
    // Fixing or deleting the row clears its count.
    put(2, {});
    table.delete(oid(3));
    expect(table.quarantineCounts().chainId).toBeUndefined();
    expect(table.quarantineCounts().protocol).toBeUndefined();
  });

  it('pools compare strings in binary: no printable-ASCII quarantine there', () => {
    const table = new ShardTable('pools', '1:uniswap-v4');
    table.upsert(oid(1), encodeCells(table.leaves, normalizeDoc('pools', { chainId: 1, protocol: 'uniswap-v4', poolId: '0x1', token0: { symbol: 'Ω\u0000' } }), (v) => table.dict.intern(v)));
    expect(table.quarantineCounts()).toEqual({});
  });

  it('a record naming a dictionary id the replica does not have is a divergence (reload), not a crash', () => {
    const store = new ModelStore(new Set(['rank']));
    const row = encodeCells(RANK_LEAVES, normalizeDoc('rank', positionDoc(1)), () => 0);
    expect(() => store.applyRecords([{ t: 'upsert', model: 'rank', shard: '1:uniswap-v4', oid: oid(1), row }])).toThrow(ModelDivergedError);
  });

  it('skips records of a model this process does not keep; hold() queues entries until release()', () => {
    const store = new ModelStore(new Set(['pools']));
    store.applyRecords([{ t: 'shard', model: 'rank', shard: '1:uniswap-v4', state: 'ready' }]);
    expect(store.tables.size).toBe(0);
    store.hold();
    store.applyEntry({ f: 1, e: 1, inc: 'i', s: 1, ct: '1:1', rt: '82', k: 'shard', ca: 0, d: encodePayload([{ t: 'shard', model: 'pools', shard: '1:uniswap-v4', state: 'ready' }]), id: '5-0' });
    expect(store.tables.size).toBe(0);
    expect(store.tailPosition.s).toBe(1);
    expect(store.pos.s).toBe(0);
    store.release();
    expect(store.table('pools', '1:uniswap-v4')?.state).toBe('ready');
    expect(store.pos).toMatchObject({ s: 1, id: '5-0' });
  });

  it('odd cells encode by type and decode back', () => {
    const cells = normalizeDoc('rank', positionDoc(1, { metrics: [1] }));
    const table = new ShardTable('rank', '1:uniswap-v4');
    table.upsert(oid(9), encodeCells(table.leaves, cells, (v) => table.dict.intern(v)));
    expect(table.cellAt(table.liveSlotOf(oid(9)), leafIndex('rank', 'metrics.roi'))).toEqual(oddCell('array'));
  });
});
