/*
 * Snapshots (design §3.5): self-describing deflated columns in redis-models,
 * manifest written last; captured from one frozen state (the holder holds the
 * store while encoding); a loader catches up from the manifest's stream id.
 */
import { describe, expect, it } from 'vitest';
import { rowsEqual } from '../../src/read-models/core/cells.js';
import { leafIndex } from '../../src/read-models/core/fields.js';
import { ModelStore } from '../../src/read-models/core/model-store.js';
import { encodeCells } from '../../src/read-models/core/row-store.js';
import { encodePayload, type DeltaEntry, type DeltaRecord } from '../../src/read-models/feeder/delta-codec.js';
import { FileSnapshotSink, NoopSnapshotSink, snapshotSinkFor } from '../../src/read-models/feeder/snapshot-sink.js';
import { chunkKeys, COLUMN_VERSION, loadSnapshotSet, SnapshotAbortedError, SnapshotLoadError, writeSnapshotSet, type Manifest } from '../../src/read-models/feeder/snapshot-store.js';
import { normalizeDoc } from '../../src/read-models/feeder/normalize.js';
import { rmKeys } from '../../src/read-models/keys.js';
import { MemoryModelsTransport, MemoryRedis } from '../../src/read-models/transport.js';
import { poolDoc, positionDoc } from './fake-cluster.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const keys = rmKeys('snap');
const oid = (n: number) => n.toString(16).padStart(24, '0');

function seeded(rows = 300): ModelStore {
  const store = new ModelStore(new Set(['rank', 'pools']));
  const rank = store.ensureTable('rank', '1:uniswap-v4');
  const pools = store.ensureTable('pools', '4663:uniswap-v4');
  for (let n = 0; n < rows; n++) {
    rank.upsert(oid(n), encodeCells(rank.leaves, normalizeDoc('rank', positionDoc(n)), (v) => rank.dict.intern(v)));
    pools.upsert(oid(10_000 + n), encodeCells(pools.leaves, normalizeDoc('pools', poolDoc(n, { chainId: 4663 })), (v) => pools.dict.intern(v)));
  }
  rank.delete(oid(7)); // a tombstone the snapshot must compact away
  rank.state = 'ready';
  pools.state = 'ready';
  store.pos = { fence: 9, epoch: 3, s: 0, id: '100-0', rt: '82aa', ct: '5:5', ca: 1234, inc: 'inc1' };
  return store;
}

function sameTables(a: ModelStore, b: ModelStore): void {
  expect([...b.tables.keys()].sort()).toEqual([...a.tables.keys()].sort());
  for (const [key, ta] of a.tables) {
    const tb = b.tables.get(key)!;
    expect(tb.live).toBe(ta.live);
    expect(tb.state).toBe(ta.state);
    expect(tb.dict.size).toBe(ta.dict.size);
    ta.forEachLive((slot) => {
      const other = tb.liveSlotOf(ta.oidAt(slot));
      expect(other).toBeGreaterThanOrEqual(0);
      expect(rowsEqual(tb.cellsAt(other), ta.cellsAt(slot))).toBe(true);
    });
    expect(tb.quarantineCounts()).toEqual(ta.quarantineCounts());
  }
}

async function write(store: ModelStore, transport: MemoryModelsTransport, extra: Partial<Parameters<typeof writeSnapshotSet>[0]> = {}): Promise<Manifest> {
  return writeSnapshotSet({ transport, keys, store, head: { fence: 9, epoch: 3, inc: 'inc1', snapSeq: 1 }, writingTtlMs: 600_000, maxEncodeMs: 20_000, ...extra });
}

describe('snapshot sets', () => {
  it('round-trip: every live row, dictionary id, state and quarantine count (tombstones compacted)', async () => {
    const store = seeded();
    const transport = new MemoryModelsTransport(new MemoryRedis(), keys);
    const manifest = await write(store, transport);
    expect(manifest.shards.find((s) => s.model === 'rank')?.rows).toBe(299);
    expect(manifest.columns.every((c) => c.version === COLUMN_VERSION)).toBe(true);
    expect(manifest.stored).toBeGreaterThan(0);
    const loaded = await loadSnapshotSet({ transport, keys, manifest, models: new Set(['rank', 'pools']) });
    const back = new ModelStore(new Set(['rank', 'pools']));
    for (const table of loaded.tables) back.setTable(table);
    sameTables(store, back);
    expect(loaded.missing).toEqual([]);
    // A loaded table keeps working: the dictionary continues from the holder's ids.
    const t = back.table('rank', '1:uniswap-v4')!;
    expect(t.dict.intern('brand-new')).toBe(store.table('rank', '1:uniswap-v4')!.dict.size);
  });

  it('a snapshot taken while entries queue behind the hold, then loaded and caught up from the stream, equals the final state', async () => {
    const store = seeded(50);
    const redis = new MemoryRedis();
    const transport = new MemoryModelsTransport(redis, keys);
    const entries: DeltaEntry[] = [];
    const rank = store.table('rank', '1:uniswap-v4')!;
    for (let s = 1; s <= 5; s++) {
      const records: DeltaRecord[] = [
        { t: 'dict', model: 'rank', shard: '1:uniswap-v4', id: rank.dict.size + s - 1, value: `owner-${s}` },
        { t: 'upsert', model: 'rank', shard: '1:uniswap-v4', oid: oid(s), row: encodeCells(rank.leaves, normalizeDoc('rank', positionDoc(s, { owner: `owner-${s}`, metrics: { underlyingValueUsd: s * 1000 } })), (v) => (v === `owner-${s}` ? rank.dict.size + s - 1 : rank.dict.find(v))) },
      ];
      entries.push({ f: 9, e: 3, inc: 'inc1', s, ct: `5:${5 + s}`, rt: `82bb${s}`, k: 'batch', ca: 2000 + s, d: encodePayload(records), id: `${100 + s}-0` });
    }
    // Two entries applied, then a hold: three more queue while the snapshot encodes.
    store.applyEntry(entries[0]);
    store.applyEntry(entries[1]);
    store.hold();
    for (const entry of entries.slice(2)) store.applyEntry(entry);
    const manifest = await write(store, transport);
    expect(manifest.s).toBe(2);
    expect(manifest.streamId).toBe('102-0');
    store.release();
    expect(store.pos.s).toBe(5);
    // A loader: the snapshot, then every entry after the manifest's s.
    const loaded = await loadSnapshotSet({ transport, keys, manifest, models: new Set(['rank', 'pools']) });
    const replica = new ModelStore(new Set(['rank', 'pools']));
    for (const table of loaded.tables) replica.setTable(table);
    replica.pos = { fence: manifest.fence, epoch: manifest.epoch, s: manifest.s, id: manifest.streamId, rt: manifest.rt, ct: manifest.ct, ca: manifest.ca, inc: manifest.inc };
    for (const entry of entries.filter((e) => e.s > manifest.s)) replica.applyEntry(entry);
    sameTables(store, replica);
    expect(replica.pos.s).toBe(5);
  });

  it('a column the snapshot lacks (or of an unknown version) loads as null and marks the leaf for a field backfill', async () => {
    const store = seeded(20);
    const transport = new MemoryModelsTransport(new MemoryRedis(), keys);
    const manifest = await write(store, transport);
    const pruned: Manifest = {
      ...manifest,
      columns: manifest.columns
        .filter((c) => !(c.model === 'rank' && c.name.startsWith('roi.')))
        .map((c) => (c.model === 'pools' && c.name.startsWith('feeApr.') ? { ...c, version: COLUMN_VERSION + 5 } : c)),
    };
    const loaded = await loadSnapshotSet({ transport, keys, manifest: pruned, models: new Set(['rank', 'pools']) });
    expect(loaded.missing).toEqual(
      expect.arrayContaining([
        { model: 'rank', shard: '1:uniswap-v4', leaves: ['roi'] },
        { model: 'pools', shard: '4663:uniswap-v4', leaves: ['feeApr'] },
      ]),
    );
    const rank = loaded.tables.find((t) => t.model === 'rank')!;
    expect(rank.missingLeaves.has(leafIndex('rank', 'metrics.roi'))).toBe(true);
    expect(rank.cellAt(0, leafIndex('rank', 'metrics.roi'))).toBeNull();
  });

  it('a chunk that vanished mid-load (the set expired or was swept) is a load error, not a half model', async () => {
    const store = seeded(20);
    const redis = new MemoryRedis();
    const transport = new MemoryModelsTransport(redis, keys);
    const manifest = await write(store, transport);
    await transport.unlink([chunkKeys(keys, manifest)[3]]);
    await expect(loadSnapshotSet({ transport, keys, manifest, models: new Set(['rank', 'pools']) })).rejects.toBeInstanceOf(SnapshotLoadError);
  });

  it('only the models a process keeps are loaded', async () => {
    const store = seeded(10);
    const transport = new MemoryModelsTransport(new MemoryRedis(), keys);
    const manifest = await write(store, transport);
    const loaded = await loadSnapshotSet({ transport, keys, manifest, models: new Set(['pools']) });
    expect(loaded.tables.map((t) => t.model)).toEqual(['pools']);
  });

  it('chunks are written with the "being written" TTL; an encode past its limit aborts', async () => {
    const store = seeded(10);
    const redis = new MemoryRedis();
    const transport = new MemoryModelsTransport(redis, keys);
    const manifest = await write(store, transport);
    const ttls = await transport.pttl(chunkKeys(keys, manifest));
    expect(ttls.every((ttl) => ttl > 590_000 && ttl <= 600_000)).toBe(true);
    let clock = 0;
    await expect(write(store, transport, { maxEncodeMs: 5, now: () => (clock += 10) })).rejects.toBeInstanceOf(SnapshotAbortedError);
  });
});

describe('durable snapshot sink', () => {
  it('file:// keeps chunks and the manifest; unset is a no-op; other schemes are refused', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rm-sink-'));
    try {
      const { sink } = snapshotSinkFor(`file://${dir}`);
      expect(sink).toBeInstanceOf(FileSnapshotSink);
      await sink.chunk('tw:rm:v1:{x}:snap:1:1:1:rank:1:uniswap-v4.oid:0', new Uint8Array([1, 2, 3]));
      expect(await sink.latest()).toBeNull();
      await sink.commit({ fence: 1 } as Manifest);
      expect((await sink.latest())?.fence).toBe(1);
      expect([...(await sink.getChunk('tw:rm:v1:{x}:snap:1:1:1:rank:1:uniswap-v4.oid:0'))!]).toEqual([1, 2, 3]);
      expect(snapshotSinkFor(undefined).sink).toBeInstanceOf(NoopSnapshotSink);
      const s3 = snapshotSinkFor('s3://user:secret@bucket/prefix');
      expect(s3.sink).toBeInstanceOf(NoopSnapshotSink);
      expect(s3.error).toMatch(/not supported/);
      expect(s3.error).not.toContain('secret');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
