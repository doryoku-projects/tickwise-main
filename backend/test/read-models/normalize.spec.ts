/*
 * Normalisation (design §3.3): Mongo document / update description → full
 * engine row state, with odd shapes quarantined. The trim's `{__odd: <$type>}`
 * markers and raw (untrimmed) shapes must read identically — the rig showed
 * 3000/3000 events normalise the same through the full trim and through none.
 */
import mongoose from 'mongoose';
import { describe, expect, it } from 'vitest';
import { oddCell, rowsEqual, type Cell } from '../../src/read-models/core/cells.js';
import { leafIndex, POOL_LEAVES, RANK_LEAVES } from '../../src/read-models/core/fields.js';
import { changeStreamPipeline, scanProjection, toStreamItem, trimExpression } from '../../src/read-models/feeder/change-stream.js';
import { applySets, classify, normalizeDoc, normalizeUpdate, oidHex } from '../../src/read-models/feeder/normalize.js';
import { positionDoc } from './fake-cluster.js';

const L = (path: string) => leafIndex('rank', path);
const at = (row: Cell[], path: string) => row[L(path)];

describe('normalizeDoc', () => {
  it('reads every leaf of a position document', () => {
    const row = normalizeDoc('rank', positionDoc(14));
    expect(row).toHaveLength(RANK_LEAVES.length);
    expect(at(row, 'chainId')).toBe(1);
    expect(at(row, 'protocol')).toBe('uniswap-v4');
    expect(at(row, 'positionId')).toBe(14);
    expect(at(row, 'token0.address')).toBe('0xa0b8');
    expect(at(row, 'metrics.poolPnlUsd')).toBeNaN(); // 14 % 7 === 0 → NaN is NATIVE, not odd
    expect(at(row, 'poolStats.tvlUsd')).toBe(14_000);
    expect(at(row, 'pricing.usedFallback')).toBe(false);
  });

  it('null and missing are one class; NaN and ±Infinity are native; -0 becomes +0', () => {
    const row = normalizeDoc('rank', positionDoc(1, { metrics: { roi: null, aprExGas: -0, feeApr: Number.POSITIVE_INFINITY, underlyingValueUsd: Number.NEGATIVE_INFINITY } }));
    expect(at(row, 'metrics.roi')).toBeNull();
    expect(at(row, 'metrics.poolPnlUsd')).toBeNull(); // absent from the new object
    expect(Object.is(at(row, 'metrics.aprExGas'), 0)).toBe(true);
    expect(at(row, 'metrics.feeApr')).toBe(Number.POSITIVE_INFINITY);
    expect(at(row, 'metrics.underlyingValueUsd')).toBe(Number.NEGATIVE_INFINITY);
    expect(at(normalizeDoc('rank', positionDoc(1, { metrics: null })), 'metrics.aprExGas')).toBeNull();
    expect(at(normalizeDoc('rank', { chainId: 1 }), 'metrics.aprExGas')).toBeNull();
  });

  it('an ancestor that is not an object quarantines its leaves — trimmed marker or raw shape alike', () => {
    for (const [metrics, type] of [
      [{ __odd: 'array' }, 'array'],
      [[{ aprExGas: 5 }], 'array'],
      [{ __odd: 'string' }, 'string'],
      ['str', 'string'],
      [{ __odd: 'int' }, 'number'],
      [42, 'number'],
    ] as const) {
      const row = normalizeDoc('rank', positionDoc(2, { metrics }));
      for (const spec of RANK_LEAVES.filter((s) => s.top === 'metrics')) expect(row[L(spec.path)]).toEqual(oddCell(type));
      expect(at(row, 'poolStats.tvlUsd')).toBe(2_000); // other subtrees untouched
    }
  });

  it('a value outside its leaf kind is odd: strings in numbers, arrays, BSON types, non-canonical ids', () => {
    const { Decimal128, Long } = mongoose.mongo;
    expect(classify('5', 'num')).toEqual(oddCell('string'));
    expect(classify([1], 'num')).toEqual(oddCell('array'));
    expect(classify(Decimal128.fromString('1.5'), 'num')).toEqual(oddCell('decimal'));
    expect(classify(Long.fromString('9007199254740993'), 'num')).toEqual(oddCell('long'));
    expect(classify(new Date(0), 'num')).toEqual(oddCell('date'));
    expect(classify(true, 'num')).toEqual(oddCell('bool'));
    expect(classify(5, 'str')).toEqual(oddCell('number'));
    expect(classify('true', 'bool')).toEqual(oddCell('string'));
    expect(classify(1, 'bool')).toEqual(oddCell('number'));
    expect(classify('42', 'pid')).toBe(42);
    expect(classify('0', 'pid')).toBe(0);
    expect(classify('042', 'pid')).toEqual(oddCell('pid'));
    expect(classify('4294967296', 'pid')).toEqual(oddCell('pid'));
    expect(classify('4294967295', 'pid')).toBe(4294967295);
    expect(classify(42, 'pid')).toEqual(oddCell('number'));
    expect(classify({ __odd: 'objectId' }, 'str')).toEqual(oddCell('objectId'));
  });

  it('pools read their own leaves', () => {
    const row = normalizeDoc('pools', { chainId: 4663, protocol: 'uniswap-v4', poolId: '0xab', token0: { address: '0x1', symbol: 'A' }, token1: { address: '0x2' }, metrics: { tvlUsd: 0 }, pricing: { source: 'none' } });
    expect(row).toHaveLength(POOL_LEAVES.length);
    expect(row[leafIndex('pools', 'metrics.tvlUsd')]).toBe(0); // $0-TVL pools are ordinary rows
    expect(row[leafIndex('pools', 'token1.symbol')]).toBeNull();
    expect(row[leafIndex('pools', 'pricing.source')]).toBe('none');
  });
});

describe('normalizeUpdate', () => {
  const base = normalizeDoc('rank', positionDoc(20));

  it('a top-level key REPLACES its subtree: a leaf absent from the new object becomes missing', () => {
    const sets = normalizeUpdate('rank', { updatedFields: { metrics: { aprExGas: 7, underlyingValueUsd: 3 } } });
    const row = applySets(base, sets);
    expect(at(row, 'metrics.aprExGas')).toBe(7);
    expect(at(row, 'metrics.underlyingValueUsd')).toBe(3);
    expect(at(row, 'metrics.feeApr')).toBeNull();
    expect(at(row, 'metrics.inRange')).toBeNull();
    expect(at(row, 'poolStats.tvlUsd')).toBe(base[L('poolStats.tvlUsd')]);
  });

  it('a dotted key sets one leaf and leaves its siblings alone', () => {
    const row = applySets(base, normalizeUpdate('rank', { updatedFields: { 'metrics.underlyingValueUsd': 5, 'metrics.apr': 9 } }));
    expect(at(row, 'metrics.underlyingValueUsd')).toBe(5);
    expect(at(row, 'metrics.aprExGas')).toBe(base[L('metrics.aprExGas')]);
    expect(rowsEqual(row.filter((_, i) => i !== L('metrics.underlyingValueUsd')), base.filter((_, i) => i !== L('metrics.underlyingValueUsd')))).toBe(true);
  });

  it('`metrics: null` makes every metrics leaf missing; a trimmed odd marker quarantines them', () => {
    expect(at(applySets(base, normalizeUpdate('rank', { updatedFields: { metrics: null } })), 'metrics.roi')).toBeNull();
    const odd = applySets(base, normalizeUpdate('rank', { updatedFields: { metrics: { __odd: 'array' } } }));
    expect(at(odd, 'metrics.inRange')).toEqual(oddCell('array'));
    const str = applySets(base, normalizeUpdate('rank', { updatedFields: { metrics: { __odd: 'string' } } }));
    expect(at(str, 'metrics.feeApr')).toEqual(oddCell('string'));
  });

  it('a numeric path component means an array ancestor; a key below a leaf makes the leaf a container', () => {
    const arr = applySets(base, normalizeUpdate('rank', { updatedFields: { 'metrics.0.aprExGas': 5 } }));
    for (const spec of RANK_LEAVES.filter((s) => s.top === 'metrics')) expect(arr[L(spec.path)]).toEqual(oddCell('array'));
    const deeper = applySets(base, normalizeUpdate('rank', { updatedFields: { 'metrics.aprExGas.x': 1 } }));
    expect(at(deeper, 'metrics.aprExGas')).toEqual(oddCell('object'));
    expect(at(applySets(base, normalizeUpdate('rank', { updatedFields: { 'owner.0': 'x' } })), 'owner')).toEqual(oddCell('array'));
  });

  it('removedFields: a removed leaf or subtree becomes missing; removing inside a container changes nothing', () => {
    const row = applySets(base, normalizeUpdate('rank', { removedFields: ['metrics.roi', 'poolStats', 'metrics.unknown', 'metrics.0'] }));
    expect(at(row, 'metrics.roi')).toBeNull();
    expect(at(row, 'poolStats.tvlUsd')).toBeNull();
    expect(at(row, 'metrics.aprExGas')).toBe(base[L('metrics.aprExGas')]);
    expect(at(applySets(base, normalizeUpdate('rank', { removedFields: ['owner'] })), 'owner')).toBeNull();
  });

  it('truncatedArrays on a subtree or a leaf quarantines', () => {
    const row = applySets(base, normalizeUpdate('rank', { truncatedArrays: [{ field: 'metrics.feeApr', newSize: 1 }, { field: 'poolStats', newSize: 0 }] }));
    expect(at(row, 'metrics.feeApr')).toEqual(oddCell('array'));
    expect(at(row, 'poolStats.tvlUsd')).toEqual(oddCell('array'));
    expect(at(row, 'metrics.aprExGas')).toBe(base[L('metrics.aprExGas')]);
  });

  it('keys that touch no engine leaf produce no assignment', () => {
    expect(normalizeUpdate('rank', { updatedFields: { amounts: { amount0: '5' }, 'metrics.apr': 3, updatedAt: new Date() } })).toEqual([]);
    expect(normalizeUpdate('pools', { updatedFields: { poolStats: { tvlUsd: 1 } } })).toEqual([]);
  });

  it('a later assignment to the same leaf wins (removed after set)', () => {
    const sets = normalizeUpdate('rank', { updatedFields: { 'metrics.roi': 4 }, removedFields: ['metrics.roi'] });
    expect(sets).toEqual([[L('metrics.roi'), null]]);
  });
});

describe('change stream events', () => {
  const { ObjectId } = mongoose.mongo;
  const shards = new Map([
    ['1_uniswap_v4_positions', { coll: '1_uniswap_v4_positions', model: 'rank' as const, chainId: 1, protocol: 'uniswap-v4' }],
    ['1_uniswap_v4_pools', { coll: '1_uniswap_v4_pools', model: 'pools' as const, chainId: 1, protocol: 'uniswap-v4' }],
  ]);
  const id = new ObjectId();
  const ev = (over: Record<string, unknown>) => ({ _id: { _data: '82000000050000000100' }, clusterTime: { t: 5, i: 1 }, ns: { db: 'd', coll: '1_uniswap_v4_positions' }, documentKey: { _id: id }, ...over });

  it('insert / replace carry a full state, update its sets, delete a tombstone', () => {
    const ins = toStreamItem(ev({ operationType: 'insert', fullDocument: positionDoc(3) }), shards);
    expect(ins.kind).toBe('row');
    expect(ins.kind === 'row' && ins.change).toMatchObject({ base: 'state', oid: id.toHexString(), rt: '82000000050000000100', ct: '5:1' });
    const rep = toStreamItem(ev({ operationType: 'replace', fullDocument: positionDoc(4) }), shards);
    expect(rep.kind === 'row' && rep.change.base).toBe('state');
    const upd = toStreamItem(ev({ operationType: 'update', updateDescription: { updatedFields: { 'metrics.roi': 1 }, removedFields: [] } }), shards);
    expect(upd.kind === 'row' && upd.change.sets).toEqual([[L('metrics.roi'), 1]]);
    const del = toStreamItem(ev({ operationType: 'delete' }), shards);
    expect(del.kind === 'row' && del.change.base).toBe('delete');
  });

  it('an update with no engine field is a no-op that still has a position', () => {
    expect(toStreamItem(ev({ operationType: 'update', updateDescription: { updatedFields: { amounts: {} }, removedFields: [] } }), shards)).toMatchObject({ kind: 'noop', rt: '82000000050000000100' });
  });

  it('drops, renames, foreign namespaces, non-ObjectId ids, invalidate and dropDatabase', () => {
    expect(toStreamItem(ev({ operationType: 'drop' }), shards)).toMatchObject({ kind: 'drop', coll: '1_uniswap_v4_positions', how: 'drop' });
    expect(toStreamItem(ev({ operationType: 'rename', to: { coll: 'elsewhere' } }), shards)).toMatchObject({ kind: 'drop', how: 'rename' });
    expect(toStreamItem(ev({ operationType: 'rename', ns: { coll: 'tmp_positions' }, to: { coll: '1_uniswap_v4_pools' } }), shards)).toMatchObject({ kind: 'renameInto', coll: '1_uniswap_v4_pools' });
    expect(toStreamItem(ev({ operationType: 'insert', ns: { coll: '99_x_positions' }, fullDocument: {} }), shards).kind).toBe('skip');
    expect(toStreamItem(ev({ operationType: 'delete', documentKey: { _id: 'string-id' } }), shards).kind).toBe('badId');
    expect(toStreamItem(ev({ operationType: 'invalidate' }), shards).kind).toBe('invalidate');
    expect(toStreamItem(ev({ operationType: 'dropDatabase' }), shards).kind).toBe('dropDatabase');
  });

  it('oidHex accepts ObjectIds only', () => {
    expect(oidHex(id)).toBe(id.toHexString());
    expect(oidHex('abc')).toBeUndefined();
    expect(oidHex({ _bsontype: 'ObjectId', toHexString: () => 'zz' })).toBeUndefined();
  });
});

describe('pipeline shapes', () => {
  it('matches shard namespaces, dropDatabase / invalidate and renames INTO a shard name', () => {
    const [match] = changeStreamPipeline('full') as Array<{ $match: { $or: Array<Record<string, unknown>> } }>;
    expect(match.$match.$or).toHaveLength(3);
    expect(JSON.stringify(match.$match.$or[0])).toContain('_(positions|pools)$');
    expect(match.$match.$or[2]).toMatchObject({ operationType: 'rename' });
    expect(changeStreamPipeline('none')).toHaveLength(1);
    expect(changeStreamPipeline('top')).toHaveLength(2);
  });

  it('the trim keeps the evidence quarantine needs (object → leaves, null/missing → as is, else {__odd})', () => {
    const expr = trimExpression('$metrics', ['aprExGas']) as { $switch: { branches: unknown[]; default: unknown } };
    expect(expr.$switch.branches).toHaveLength(2);
    expect(expr.$switch.default).toEqual({ __odd: { $type: '$metrics' } });
  });

  it('scan projections read each model’s subtrees through the same trim', () => {
    const rank = scanProjection('rank');
    expect(rank).toMatchObject({ _id: 1, owner: 1, positionId: 1 });
    expect(rank.metrics).toHaveProperty('$switch');
    expect(scanProjection('pools')).not.toHaveProperty('positionId');
    expect(scanProjection('rank', 'top').metrics).toBe(1);
  });
});
