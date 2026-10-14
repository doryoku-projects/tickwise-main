/*
 * The delta consumer (design §2.5): a replica that does not hold the lease
 * loads the newest manifest and applies entries strictly in (fence, epoch, s)
 * order — a gap reloads, a lower fence is ignored, a new epoch is accepted
 * through its manifest (seamless when it `continues` this position), and a
 * changed incarnation waits for its continuation.
 */
import { describe, expect, it, vi } from 'vitest';
import { DeltaConsumer, judgeEntry, continuesFrom } from '../../src/read-models/consumer/delta-consumer.js';
import { rowsEqual } from '../../src/read-models/core/cells.js';
import { leafIndex } from '../../src/read-models/core/fields.js';
import { ModelStore, NO_POSITION } from '../../src/read-models/core/model-store.js';
import { encodeCells } from '../../src/read-models/core/row-store.js';
import { EMPTY_PAYLOAD, encodePayload, entryFields, type DeltaEntry, type DeltaRecord } from '../../src/read-models/feeder/delta-codec.js';
import { normalizeDoc } from '../../src/read-models/feeder/normalize.js';
import { loadSnapshotSet, writeSnapshotSet, type Manifest } from '../../src/read-models/feeder/snapshot-store.js';
import { rmKeys } from '../../src/read-models/keys.js';
import { MemoryModelsTransport, MemoryRedis } from '../../src/read-models/transport.js';
import { positionDoc } from './fake-cluster.js';

const keys = rmKeys('consumer');
const TTL = 3_600_000;
const SHARD = '1:uniswap-v4';
const oid = (n: number) => n.toString(16).padStart(24, '0');

/** A minimal holder: a store it applies its own appends to, and a snapshot writer. */
class MiniHolder {
  readonly store = new ModelStore(new Set(['rank']));
  epoch = 1;
  s = 0;
  snapSeq = 0;

  constructor(
    readonly transport: MemoryModelsTransport,
    public fence: number,
    public inc: string,
  ) {
    this.store.ensureTable('rank', SHARD).state = 'ready';
    this.store.pos = { ...NO_POSITION, fence, epoch: 1, inc, rt: '82000000010000000100', ct: '1:1', ca: Date.now() };
  }

  records(n: number, value: number): DeltaRecord[] {
    const table = this.store.table('rank', SHARD)!;
    const adds: DeltaRecord[] = [];
    const tentative = new Map<string, number>();
    const row = encodeCells(table.leaves, normalizeDoc('rank', positionDoc(n, { metrics: { underlyingValueUsd: value }, owner: `0xowner${n}` })), (v) => {
      const found = table.dict.find(v);
      if (found >= 0) return found;
      let id = tentative.get(v);
      if (id === undefined) {
        id = table.dict.size + tentative.size;
        tentative.set(v, id);
        adds.push({ t: 'dict', model: 'rank', shard: SHARD, id, value: v });
      }
      return id;
    });
    return [...adds, { t: 'upsert', model: 'rank', shard: SHARD, oid: oid(n), row }];
  }

  entry(records: DeltaRecord[] | null): DeltaEntry {
    return { f: this.fence, e: this.epoch, inc: this.inc, s: this.s + 1, ct: `2:${this.s + 1}`, rt: `82${(this.s + 1).toString(16).padStart(16, '0')}`, k: records ? 'batch' : 'heartbeat', ca: Date.now(), d: records ? encodePayload(records) : EMPTY_PAYLOAD };
  }

  async append(records: DeltaRecord[] | null): Promise<DeltaEntry> {
    const entry = this.entry(records);
    const outcome = await this.transport.append(entry, TTL);
    if (!outcome.ok) throw new Error(`append refused: ${outcome.reason}`);
    const applied = { ...entry, id: outcome.id };
    this.store.applyEntry(applied);
    this.s = entry.s;
    return applied;
  }

  async snapshot(continues?: Manifest['continues']): Promise<Manifest> {
    const manifest = await writeSnapshotSet({ transport: this.transport, keys, store: this.store, head: { fence: this.fence, epoch: this.epoch, inc: this.inc, snapSeq: ++this.snapSeq, continues }, writingTtlMs: TTL, maxEncodeMs: 20_000 });
    expect(await this.transport.putManifest(manifest, TTL)).toBe('ok');
    return manifest;
  }
}

async function setup() {
  const redis = new MemoryRedis();
  const transport = new MemoryModelsTransport(redis, keys);
  const { inc } = await transport.ensureIncarnation(TTL);
  await transport.seedFence(10, TTL);
  const holder = new MiniHolder(transport, 10, inc);
  await holder.snapshot();
  const store = new ModelStore(new Set(['rank']));
  const consumer = new DeltaConsumer({
    store,
    transport,
    blockMs: 20,
    pollMs: 20,
    load: async (manifest) => {
      const loaded = await loadSnapshotSet({ transport, keys, manifest, models: store.models });
      store.clear();
      for (const table of loaded.tables) store.setTable(table);
      store.pos = { fence: manifest.fence, epoch: manifest.epoch, s: manifest.s, id: manifest.streamId, rt: manifest.rt, ct: manifest.ct, ca: manifest.ca, inc: manifest.inc };
    },
  });
  return { redis, transport, holder, store, consumer };
}

function sameModel(a: ModelStore, b: ModelStore): void {
  const ta = a.table('rank', SHARD)!;
  const tb = b.table('rank', SHARD)!;
  expect(tb.live).toBe(ta.live);
  expect(tb.dict.size).toBe(ta.dict.size);
  ta.forEachLive((slot) => expect(rowsEqual(tb.cellsAt(tb.liveSlotOf(ta.oidAt(slot))), ta.cellsAt(slot))).toBe(true));
}

describe('ordering rule', () => {
  const pos = { ...NO_POSITION, fence: 10, epoch: 5, s: 7 };
  it('applies s+1, skips duplicates, older epochs and lower fences, flags gaps and new epochs, accepts a takeover', () => {
    expect(judgeEntry(pos, 10, { f: 10, e: 5, s: 8 })).toEqual({ verdict: 'apply', takeover: false });
    expect(judgeEntry(pos, 10, { f: 11, e: 5, s: 8 })).toEqual({ verdict: 'apply', takeover: true });
    expect(judgeEntry(pos, 10, { f: 10, e: 5, s: 7 })).toMatchObject({ verdict: 'skip', reason: 'duplicate' });
    expect(judgeEntry(pos, 10, { f: 10, e: 5, s: 9 })).toEqual({ verdict: 'gap', expected: 8 });
    expect(judgeEntry(pos, 11, { f: 10, e: 5, s: 8 })).toMatchObject({ verdict: 'skip', reason: 'below_floor' });
    expect(judgeEntry(pos, 10, { f: 10, e: 4, s: 8 })).toMatchObject({ verdict: 'skip', reason: 'older_epoch' });
    expect(judgeEntry(pos, 10, { f: 10, e: 6, s: 1 })).toEqual({ verdict: 'new_epoch' });
    expect(continuesFrom({ continues: { fence: 10, epoch: 5, s: 7 } }, pos)).toBe(true);
    expect(continuesFrom({ continues: { fence: 10, epoch: 5, s: 6 } }, pos)).toBe(false);
    expect(continuesFrom({}, pos)).toBe(false);
  });
});

describe('DeltaConsumer', () => {
  it('loads the manifest, follows the stream, and is caught up on a fresh heartbeat with nothing newer', async () => {
    const { holder, store, consumer } = await setup();
    consumer.start(false);
    try {
      for (let n = 1; n <= 5; n++) await holder.append(holder.records(n, n * 10));
      await holder.append(null);
      await vi.waitFor(() => expect(store.pos.s).toBe(6), { timeout: 2_000 });
      sameModel(holder.store, store);
      await vi.waitFor(() => expect(consumer.caughtUp()).toBe(true), { timeout: 2_000 });
      expect(consumer.reloads).toBe(1);
    } finally {
      await consumer.stop();
    }
  });

  it('a gap (an entry the stream lost) reloads from the newest manifest instead of applying out of order', async () => {
    const { redis, holder, store, consumer } = await setup();
    consumer.start(false);
    try {
      await holder.append(holder.records(1, 1));
      await vi.waitFor(() => expect(store.pos.s).toBe(1), { timeout: 2_000 });
      // The holder appends s = 2 and 3, then the stream loses s = 2 (trimmed / evicted): inject s = 3 alone.
      const e2 = holder.entry(holder.records(2, 2));
      holder.store.applyEntry({ ...e2, id: '0-1' });
      holder.s = 2;
      const e3 = holder.entry(holder.records(3, 3));
      redis.xadd(keys.deltas, entryFields(e3));
      holder.store.applyEntry({ ...e3, id: '0-2' });
      holder.s = 3;
      // The consumer must not apply s = 3 over s = 1.
      await vi.waitFor(() => expect(consumer.lastReloadReason).toMatch(/gap/), { timeout: 2_000 });
      expect(store.pos.s).toBe(1);
      // A fresh manifest (with s = 3) brings it back.
      await holder.snapshot();
      await vi.waitFor(() => expect(store.pos.s).toBe(3), { timeout: 2_000 });
      sameModel(holder.store, store);
    } finally {
      await consumer.stop();
    }
  });

  it('a lower fence is ignored after a takeover; the takeover raises the floor', async () => {
    const { redis, transport, holder, store, consumer } = await setup();
    consumer.start(false);
    try {
      await holder.append(holder.records(1, 1));
      // Takeover: fence 11 continues the epoch at s = 2.
      await transport.seedFence(11, TTL);
      holder.fence = 11;
      await holder.append(holder.records(2, 2));
      await vi.waitFor(() => expect(consumer.floor).toBe(11), { timeout: 2_000 });
      // The paused ex-holder's entry somehow lands (fence 10, s = 3): ignored.
      const stale = { ...holder.entry(holder.records(9, 999)), f: 10 };
      redis.xadd(keys.deltas, entryFields(stale));
      await holder.append(holder.records(3, 3)); // the real s = 3, fence 11
      await vi.waitFor(() => expect(store.pos.s).toBe(3), { timeout: 2_000 });
      expect(store.table('rank', SHARD)!.liveSlotOf(oid(9))).toBe(-1);
      expect(consumer.skipped).toBeGreaterThanOrEqual(1);
      sameModel(holder.store, store);
    } finally {
      await consumer.stop();
    }
  });

  it('a new epoch that continues this position switches seamlessly; one that does not reloads', async () => {
    const { holder, store, consumer } = await setup();
    consumer.start(false);
    try {
      await holder.append(holder.records(1, 1));
      await holder.append(holder.records(2, 2));
      await vi.waitFor(() => expect(store.pos.s).toBe(2), { timeout: 2_000 });
      const reloads = consumer.reloads;
      // Continuation epoch (flush recovery style): manifest first, then s = 1.
      const continues = { fence: holder.fence, epoch: holder.epoch, s: holder.s };
      holder.epoch = 2;
      holder.s = 0;
      holder.store.pos = { ...holder.store.pos, epoch: 2, s: 0 };
      await holder.snapshot(continues);
      await holder.append(holder.records(3, 3));
      await vi.waitFor(() => expect(store.pos).toMatchObject({ epoch: 2, s: 1 }), { timeout: 2_000 });
      expect(consumer.reloads).toBe(reloads);
      // A fresh epoch (history lost): no continues → reload.
      holder.epoch = 3;
      holder.s = 0;
      holder.store.pos = { ...holder.store.pos, epoch: 3, s: 0 };
      await holder.snapshot();
      await holder.append(holder.records(4, 4));
      await vi.waitFor(() => expect(store.pos).toMatchObject({ epoch: 3, s: 1 }), { timeout: 2_000 });
      expect(consumer.reloads).toBe(reloads + 1);
      sameModel(holder.store, store);
    } finally {
      await consumer.stop();
    }
  });

  it('redis-models lost (incarnation changed): waits for the new incarnation and continues without a reload', async () => {
    const { redis, transport, holder, store, consumer } = await setup();
    consumer.start(false);
    try {
      await holder.append(holder.records(1, 1));
      await vi.waitFor(() => expect(store.pos.s).toBe(1), { timeout: 2_000 });
      const reloads = consumer.reloads;
      redis.flushAll();
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(store.pos.s).toBe(1); // nothing to do until the new incarnation's manifest exists
      const { inc } = await transport.ensureIncarnation(TTL);
      await transport.seedFence(holder.fence, TTL);
      const continues = { fence: holder.fence, epoch: holder.epoch, s: holder.s };
      holder.inc = inc;
      holder.epoch = 2;
      holder.s = 0;
      holder.store.pos = { ...holder.store.pos, epoch: 2, s: 0, inc };
      await holder.snapshot(continues);
      await holder.append(holder.records(2, 2));
      await vi.waitFor(() => expect(store.pos).toMatchObject({ epoch: 2, s: 1, inc }), { timeout: 2_000 });
      expect(consumer.reloads).toBe(reloads);
      expect(store.table('rank', SHARD)!.liveSlotOf(oid(2))).toBeGreaterThanOrEqual(0);
      sameModel(holder.store, store);
    } finally {
      await consumer.stop();
    }
  });

  it('is not caught up while it is still reading a backlog (a read that came back full)', async () => {
    const { holder, transport, store } = await setup();
    for (let n = 1; n <= 1_200; n++) await holder.append(n % 2 ? null : holder.records(n % 50, n));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reads = 0;
    const gated = Object.create(transport) as typeof transport;
    gated.read = async (after, count, block) => {
      reads++;
      if (reads === 2) await gate; // hold the consumer between its first (full) read and the rest
      return transport.read(after, count, block);
    };
    const consumer = new DeltaConsumer({
      store,
      transport: gated,
      blockMs: 20,
      pollMs: 20,
      load: async (manifest) => {
        const loaded = await loadSnapshotSet({ transport, keys, manifest, models: store.models });
        store.clear();
        for (const table of loaded.tables) store.setTable(table);
        store.pos = { fence: manifest.fence, epoch: manifest.epoch, s: manifest.s, id: manifest.streamId, rt: manifest.rt, ct: manifest.ct, ca: manifest.ca, inc: manifest.inc };
      },
    });
    consumer.start(false);
    try {
      await vi.waitFor(() => expect(store.pos.s).toBe(1_000), { timeout: 2_000 });
      expect(consumer.lastAppliedAt).toBeGreaterThan(0);
      expect(consumer.caughtUp()).toBe(false); // applied a full page: there may be more behind it
      release();
      await vi.waitFor(() => expect(store.pos.s).toBe(1_200), { timeout: 2_000 });
      await vi.waitFor(() => expect(consumer.caughtUp()).toBe(true), { timeout: 2_000 });
    } finally {
      release();
      await consumer.stop();
    }
  });

  it('a payload the replica cannot apply consistently (a dictionary id out of step) reloads', async () => {
    const { redis, holder, store, consumer } = await setup();
    consumer.start(false);
    try {
      await holder.append(holder.records(1, 1));
      await vi.waitFor(() => expect(store.pos.s).toBe(1), { timeout: 2_000 });
      const bad = holder.entry([{ t: 'dict', model: 'rank', shard: SHARD, id: 999, value: 'skipped-ids' }]);
      redis.xadd(keys.deltas, entryFields(bad));
      await vi.waitFor(() => expect(consumer.lastReloadReason).toBe('diverged'), { timeout: 2_000 });
      expect(store.table('rank', SHARD)!.cellAt(0, leafIndex('rank', 'metrics.underlyingValueUsd'))).toBe(1);
    } finally {
      await consumer.stop();
    }
  });
});
