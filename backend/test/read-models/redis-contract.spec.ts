/*
 * The Redis transports against a REAL Redis (opt-in): the Lua scripts must do
 * exactly what their TypeScript models do (`fenced-append.spec`), and the
 * whole runtime must hold together on ioredis (buffers, XREAD BLOCK, XRANGE
 * exclusive starts, MINID trims, SCAN, PTTL, INFO).
 *
 *   READ_MODELS_TEST_REDIS_URL=redis://127.0.0.1:6390 npx vitest run test/read-models/redis-contract.spec.ts
 *
 * Use a THROWAWAY instance: the spec flushes its database before each case.
 */
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EMPTY_PAYLOAD, encodePayload, type DeltaEntry } from '../../src/read-models/feeder/delta-codec.js';
import { InThreadFeederHost } from '../../src/read-models/feeder/feeder-host.js';
import { ReadModelsRuntime } from '../../src/read-models/feeder/feeder.service.js';
import { inventoryModels, sweepModels } from '../../src/read-models/feeder/janitor.js';
import { NoopSnapshotSink } from '../../src/read-models/feeder/snapshot-sink.js';
import { Fleet } from '../../src/read-models/fleet.js';
import { rmKeys } from '../../src/read-models/keys.js';
import { RedisModelsTransport, RedisStateTransport } from '../../src/read-models/redis-transport.js';
import { FakeCluster, poolDoc, positionDoc } from './fake-cluster.js';
import { expectModelEqualsCluster, HOLDER_CONFIG, POOLS_COLL, RANK_COLL, settled, SHARDS, SpecAlerts, waitUntil } from './support.js';

const URL = process.env.READ_MODELS_TEST_REDIS_URL;
const keys = rmKeys('contract');
const TTL = 60_000;

describe.skipIf(!URL)('redis transports (real Redis)', () => {
  let control: Redis;
  let blocking: Redis;
  const clients: Redis[] = [];
  const connect = (opts: ConstructorParameters<typeof Redis>[1] = {}) => {
    const client = new Redis(URL!, { lazyConnect: false, maxRetriesPerRequest: 1, ...opts });
    clients.push(client);
    return client;
  };
  const transport = () => new RedisModelsTransport({ control: async () => control, blocking: async () => blocking, bulk: async () => control }, keys);
  const state = () => new RedisStateTransport(async () => control, keys);
  const entry = (over: Partial<DeltaEntry>): DeltaEntry => ({ f: 100, e: 1, inc: '', s: 1, ct: '1:1', rt: '82', k: 'heartbeat', ca: 0, d: EMPTY_PAYLOAD, ...over });

  beforeAll(() => {
    control = connect({ commandTimeout: 2_000 });
    blocking = connect();
  });
  beforeEach(async () => {
    await control.flushdb();
  });
  afterAll(async () => {
    await Promise.all(clients.map((c) => c.quit().catch(() => undefined)));
  });

  it('fenced append: the same guards as the model, binary payloads intact, cursor kept', async () => {
    const t = transport();
    const { inc, created } = await t.ensureIncarnation(TTL);
    expect(created).toBe(true);
    expect((await t.ensureIncarnation(TTL)).created).toBe(false);
    expect(await t.append(entry({ inc }), TTL)).toMatchObject({ ok: false, reason: 'fence_missing' });
    expect(await t.seedFence(100, TTL)).toBe(true);
    expect(await t.seedFence(99, TTL)).toBe(false);
    expect(await t.append(entry({ inc: 'x' }), TTL)).toMatchObject({ ok: false, reason: 'inc_mismatch' });
    expect(await t.append(entry({ inc, f: 99 }), TTL)).toMatchObject({ ok: false, reason: 'fence_mismatch', detail: '100' });
    expect(await t.append(entry({ inc, s: 2 }), TTL)).toMatchObject({ ok: false, reason: 'seq_gap' });
    const payload = encodePayload([{ t: 'dict', model: 'rank', shard: '1:uniswap-v4', id: 0, value: 'Ω\u0000 bytes ✓' }]);
    const first = await t.append(entry({ inc, s: 1, k: 'batch', d: payload }), TTL);
    expect(first.ok).toBe(true);
    expect(await t.append(entry({ inc, s: 3 }), TTL)).toMatchObject({ ok: false, reason: 'seq_gap' });
    expect((await t.append(entry({ inc, s: 2 }), TTL)).ok).toBe(true);
    expect(await t.append(entry({ inc, e: 0, s: 3 }), TTL)).toMatchObject({ ok: false, reason: 'epoch_behind' });
    expect(await t.cursor()).toMatchObject({ epoch: 1, s: 2, fence: 100 });
    const read = await t.read('0-0', 10, 0);
    expect(read.map((e) => e.s)).toEqual([1, 2]);
    expect([...read[0].d]).toEqual([...payload]);
    expect((await t.range(read[0].id!, 10)).map((e) => e.s)).toEqual([2]); // exclusive start
    expect(await t.tailId()).toBe(read[1].id);
    expect(await control.pttl(keys.deltas)).toBeGreaterThan(0);
    expect(await control.pttl(keys.cursor)).toBeGreaterThan(0);
  });

  it('XREAD BLOCK wakes on an append and returns nothing after its block', async () => {
    const t = transport();
    const { inc } = await t.ensureIncarnation(TTL);
    await t.seedFence(1, TTL);
    const started = Date.now();
    expect(await t.read('$', 10, 200)).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    const pending = t.read('0-0', 10, 2_000);
    await t.append(entry({ f: 1, inc, s: 1 }), TTL);
    expect((await pending).map((e) => e.s)).toEqual([1]);
  });

  it('manifest switch is fenced; chunks, PTTL, sizes, SCAN, UNLINK, MINID trim and INFO memory work', async () => {
    const t = transport();
    const { inc } = await t.ensureIncarnation(TTL);
    await t.seedFence(5, TTL);
    const manifest = { layout: 1 as const, fence: 5, epoch: 1, inc, snapSeq: 1, streamId: '0-0', s: 0, rt: '', ct: '0:0', ca: 0, createdAt: 0, models: [], shards: [], columns: [], encodeMs: 0, stored: 0 };
    expect(await t.putManifest({ ...manifest, fence: 4 }, TTL)).toBe('fence_mismatch');
    expect(await t.putManifest(manifest, TTL)).toBe('ok');
    expect((await t.manifest())?.fence).toBe(5);
    const key = keys.snapChunk(5, 1, 1, 'rank', '1:uniswap-v4.oid', 0);
    await t.putChunk(key, new Uint8Array([0, 255, 7]), 10_000);
    expect([...(await t.getChunk(key))!]).toEqual([0, 255, 7]);
    expect((await t.pttl([key]))[0]).toBeGreaterThan(9_000);
    expect(await t.sizes([key])).toEqual([3]);
    const scanned: string[] = [];
    for await (const page of t.scan(`${keys.snapPrefix}*`)) scanned.push(...page);
    expect(scanned).toEqual(expect.arrayContaining([key, keys.manifest]));
    for (let s = 1; s <= 3; s++) await t.append(entry({ f: 5, inc, s }), TTL);
    const [e1, e2] = await t.read('0-0', 10, 0);
    expect(await t.trim(e2.id!)).toBe(1);
    expect((await t.read('0-0', 10, 0)).map((e) => e.s)).toEqual([2, 3]);
    expect(e1.s).toBe(1);
    const memory = await t.memory();
    expect(memory?.used).toBeGreaterThan(0);
    const inventory = await inventoryModels(t, keys);
    expect(inventory.sets.map((s) => s.set)).toEqual(['5:1:1']);
    expect((await sweepModels(t, keys, { writingTtlMs: 600_000 })).sweptSets).toEqual([]);
    expect(await t.unlink([key])).toBe(1);
  });

  it('state: the fence authority, the lease, commands, fleet values, counters', async () => {
    const s = state();
    const first = await s.nextFence(1_790_000_000_000);
    expect(first).toBe(1_790_000_000_001);
    expect(await s.nextFence(1)).toBe(first + 1);
    const a = s.lease(keys.lease, 5_000, 'A');
    const b = s.lease(keys.lease, 5_000, 'B');
    expect(await a.acquire()).toBe('acquired');
    expect(await b.acquire()).toBe('held');
    expect(await b.renew()).toBe(false);
    await a.release();
    expect(await b.acquire()).toBe('acquired');
    await s.push(keys.commands, '{"type":"snapshot"}', 10_000);
    await s.push(keys.commands, '{"type":"sweep"}', 10_000);
    expect(await s.pop(keys.commands)).toBe('{"type":"snapshot"}');
    await s.set(`${keys.prefix}:probe:r1`, '{"replica":"r1"}', 5_000);
    expect(await s.scanValues(`${keys.prefix}:probe:`)).toEqual([{ key: `${keys.prefix}:probe:r1`, value: '{"replica":"r1"}' }]);
    // The fleet beats / coverage records: ONE hash, its TTL refreshed by every HSET, stale fields HDELed by the reader.
    await s.hset(keys.fleet, 'r1', '{"replica":"r1"}', 5_000);
    await s.hset(keys.fleet, 'r2', '{"replica":"r2"}', 5_000);
    expect(await s.hgetall(keys.fleet)).toEqual({ r1: '{"replica":"r1"}', r2: '{"replica":"r2"}' });
    const ttl = await control.pttl(keys.fleet);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(5_000);
    await s.hdel(keys.fleet, ['r1']);
    await s.hdel(keys.fleet, []);
    expect(await s.hgetall(keys.fleet)).toEqual({ r2: '{"replica":"r2"}' });
    const fleet = new Fleet(s, keys);
    await fleet.beat({ replica: 'r3', role: 'both', holder: true, ready: { rank: true }, lastAppendAt: Date.now(), at: Date.now() });
    expect((await fleet.members()).map((m) => m.replica)).toEqual(['r3']); // 'r2' (no `at`) is stale: dropped and deleted
    expect(Object.keys(await s.hgetall(keys.fleet))).toEqual(['r3']);
    expect(await s.incr(keys.shadowCounter(1), 60_000)).toBe(1);
    expect(await s.incr(keys.shadowCounter(1), 60_000)).toBe(2);
  });

  describe('runtime on real Redis', () => {
    const runtimes: ReadModelsRuntime[] = [];
    afterEach(async () => {
      await Promise.all(runtimes.splice(0).map((r) => r.stop()));
    });

    const runtime = (cluster: FakeCluster, owner: string, role: 'both' | 'server' = 'both') => {
      const ctl = connect({ commandTimeout: 2_000, enableOfflineQueue: false });
      const blk = connect();
      const r = new ReadModelsRuntime(
        {
          transport: new RedisModelsTransport({ control: async () => ctl, blocking: async () => blk, bulk: async () => ctl }, keys),
          state: new RedisStateTransport(async () => ctl, keys),
          keys,
          sink: new NoopSnapshotSink(),
          createHost: () => new InThreadFeederHost(() => cluster, { liveFlushMs: 10, confirmEveryMs: 40, statsEveryMs: 60_000 }),
          alerts: new SpecAlerts(),
          owner,
        },
        { role, shards: SHARDS, holder: HOLDER_CONFIG, maxLagMs: 120_000, positionsCapacity: 0, leaseTtlMs: 1_000, leaseRetryMs: 100, oplogRetryMs: 60_000 },
        { rank: 'shadow', pools: 'shadow' },
      );
      runtimes.push(r);
      return r;
    };

    it('cold scan, live, a consumer, a takeover — the models equal Mongo on every replica', async () => {
      const cluster = new FakeCluster();
      cluster.t = Math.floor(Date.now() / 1000);
      for (let n = 0; n < 120; n++) cluster.insert(RANK_COLL, positionDoc(n));
      for (let n = 0; n < 30; n++) cluster.insert(POOLS_COLL, poolDoc(n));
      const a = runtime(cluster, 'A');
      await a.start();
      await waitUntil(() => a.holder?.phase === 'running', 10_000, 'A holds');
      for (let n = 0; n < 40; n++) cluster.update(RANK_COLL, cluster.liveDocs(RANK_COLL)[n].oid, { set: { 'metrics.underlyingValueUsd': n * 3 } });
      await settled(a, cluster);
      const c = runtime(cluster, 'C', 'server');
      await c.start();
      await waitUntil(() => c.store.pos.s === a.holder!.appended.s, 10_000, 'C follows');
      const b = runtime(cluster, 'B');
      await b.start();
      await a.holder!.stop(); // A "dies" holding the lease
      for (let n = 0; n < 20; n++) cluster.update(POOLS_COLL, cluster.liveDocs(POOLS_COLL)[n].oid, { set: { metrics: { tvlUsd: n } } });
      await waitUntil(() => b.holder?.phase === 'running', 10_000, 'B takes over');
      await settled(b, cluster);
      await waitUntil(() => c.store.pos.s === b.holder!.appended.s, 10_000, 'C follows B');
      for (const store of [b.store, c.store]) {
        expectModelEqualsCluster(store, cluster, RANK_COLL, 'rank');
        expectModelEqualsCluster(store, cluster, POOLS_COLL, 'pools');
      }
    }, 60_000);
  });
});
