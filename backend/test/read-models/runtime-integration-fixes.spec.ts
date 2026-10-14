/*
 * Integration fixes to the R1 runtime (P-R review): readiness says when the
 * engines can still serve SOME shards (the fleet circuit counts that, not
 * "every shard ready"); a replica that dropped a model's rows locally does
 * not take the feeder lease; the holder's FROZEN position (a repair blocked)
 * travels with every entry it appends (`fz`) into every store's position; the
 * consumer gives the event loop a turn during a long catch-up.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { APPLY_YIELD_EVERY } from '../../src/read-models/consumer/delta-consumer.js';
import { positionOf } from '../../src/read-models/core/model-store.js';
import { EMPTY_PAYLOAD, entryFields, entryFromFields, type DeltaEntry } from '../../src/read-models/feeder/delta-codec.js';
import { ReadModelsRuntime } from '../../src/read-models/feeder/feeder.service.js';
import { NoopSnapshotSink } from '../../src/read-models/feeder/snapshot-sink.js';
import { AlertLog } from '../../src/read-models/status.js';
import { MemoryModelsTransport, MemoryRedis, MemoryStateTransport } from '../../src/read-models/transport.js';
import { FakeCluster, poolDoc, positionDoc } from './fake-cluster.js';
import { HOLDER_CONFIG, KEYS, makeRuntime, POOLS_COLL, RANK_COLL, waitUntil } from './support.js';

const running: ReadModelsRuntime[] = [];
afterEach(async () => {
  await Promise.all(running.splice(0).map((r) => r.stop()));
});

function bareRuntime(opts: { role?: 'both' | 'server'; canHold?: () => boolean } = {}) {
  const redis = new MemoryRedis();
  const runtime = new ReadModelsRuntime(
    {
      transport: new MemoryModelsTransport(redis, KEYS),
      state: new MemoryStateTransport(redis, KEYS),
      keys: KEYS,
      sink: new NoopSnapshotSink(),
      createHost: () => {
        throw new Error('no feeder in this spec');
      },
      alerts: new AlertLog({ warn: () => undefined }),
      canHold: opts.canHold,
    },
    {
      role: opts.role ?? 'server',
      shards: [
        { coll: RANK_COLL, model: 'rank', chainId: 1, protocol: 'uniswap-v4' },
        { coll: '43114_uniswap_v4_positions', model: 'rank', chainId: 43114, protocol: 'uniswap-v4' },
      ],
      holder: HOLDER_CONFIG,
      maxLagMs: 120_000,
      positionsCapacity: 0,
      leaseTtlMs: 1_000,
      leaseRetryMs: 100,
      oplogRetryMs: 60_000,
    },
    { rank: 'serve', pools: 'off' },
  );
  running.push(runtime);
  return { runtime, redis };
}

describe('readiness: can the engines serve SOME shards? (the fleet circuit counts this)', () => {
  it('one shard rescanning: not ready, but canServe while caught up and fresh with a ready shard', () => {
    const { runtime } = bareRuntime();
    runtime.phase = 'consumer';
    let caughtUp = true;
    runtime.consumer = { caughtUp: () => caughtUp, stop: async () => undefined } as never;
    const a = runtime.store.ensureTable('rank', '1:uniswap-v4');
    const b = runtime.store.ensureTable('rank', '43114:uniswap-v4');
    a.state = 'ready';
    b.state = 'scanning';
    const now = Date.now();
    runtime.store.pos = { ...runtime.store.pos, epoch: 1, ca: now };
    expect(runtime.readiness(now).rank).toMatchObject({ ready: false, reason: 'shard_not_ready', canServe: true });
    // no ready shard at all
    a.state = 'scanning';
    expect(runtime.readiness(now).rank.canServe).toBe(false);
    a.state = 'ready';
    // behind the stream, or stale
    caughtUp = false;
    expect(runtime.readiness(now).rank.canServe).toBe(false);
    caughtUp = true;
    expect(runtime.readiness(now + 120_000).rank.canServe).toBe(false);
    // every shard ready
    b.state = 'ready';
    expect(runtime.readiness(now).rank).toMatchObject({ ready: true, canServe: true });
  });
});

describe('the feeder lease', () => {
  it('a candidate that dropped a model’s rows locally (canHold false) never takes it', async () => {
    const { runtime, redis } = bareRuntime({ role: 'both', canHold: () => false });
    await runtime.start();
    await new Promise((resolve) => setTimeout(resolve, 250)); // two lease retries
    expect(runtime.phase).toBe('consumer');
    expect(runtime.takeovers).toBe(0);
    expect(redis.get(KEYS.lease)).toBeNull();
  });
});

describe('the frozen position (a repair blocked) travels with the entries', () => {
  it('fz round-trips through the stream fields and becomes StreamPosition.frozen; absent means not frozen', () => {
    const base: DeltaEntry = { f: 7, e: 1, inc: 'i', s: 3, ct: '10:1', rt: '82aa', k: 'heartbeat', ca: 5, d: EMPTY_PAYLOAD };
    const plain = entryFromFields('1-0', entryFields(base));
    expect(plain.fz).toBeUndefined();
    expect(positionOf(plain).frozen).toBeUndefined();
    const frozen = entryFromFields('2-0', entryFields({ ...base, fz: true }));
    expect(frozen.fz).toBe(true);
    expect(positionOf(frozen).frozen).toBe(true);
    expect(entryFields(base)).not.toContain('fz');
  });

  it('the holder stamps every entry it appends while frozen, and its own store reads frozen until it thaws', async () => {
    const cluster = new FakeCluster();
    cluster.t = Math.floor(Date.now() / 1000);
    for (let n = 0; n < 30; n++) cluster.insert(RANK_COLL, positionDoc(n));
    for (let n = 0; n < 10; n++) cluster.insert(POOLS_COLL, poolDoc(n));
    const redis = new MemoryRedis();
    const { runtime } = makeRuntime(redis, cluster, { owner: 'A' });
    running.push(runtime);
    await runtime.start();
    await waitUntil(() => runtime.holder?.phase === 'running', 8_000, 'running');
    const holder = runtime.holder as unknown as { frozenRt?: { rt: string; ct: string }; latestRt: string; latestCt: string; appendEntry(kind: 'heartbeat', payload: Uint8Array): Promise<boolean> };
    const transport = new MemoryModelsTransport(redis, KEYS);
    holder.frozenRt = { rt: holder.latestRt, ct: holder.latestCt };
    expect(await holder.appendEntry('heartbeat', EMPTY_PAYLOAD)).toBe(true);
    let tail = (await transport.range('0-0', 100_000)).at(-1)!;
    expect(tail.fz).toBe(true);
    expect(runtime.store.pos.frozen).toBe(true);
    holder.frozenRt = undefined;
    expect(await holder.appendEntry('heartbeat', EMPTY_PAYLOAD)).toBe(true);
    tail = (await transport.range('0-0', 100_000)).at(-1)!;
    expect(tail.fz).toBeUndefined();
    expect(runtime.store.pos.frozen).toBeUndefined();
    // A VERIFY scan command is lane B's (paced by the read-models service): the feeder is untouched.
    expect(await runtime.holder!.runCommand({ type: 'scan', action: 'pause', target: 'verify' })).toMatch(/lane B/);
    expect(await runtime.holder!.runCommand({ type: 'scan', action: 'resume' })).toBe('scan resume');
  }, 30_000);
});

describe('the consumer’s catch-up', () => {
  it('gives the event loop a turn every APPLY_YIELD_EVERY entries', async () => {
    const { runtime } = bareRuntime();
    const consumer = (runtime as unknown as { newConsumer(): { applyAll(entries: DeltaEntry[]): Promise<boolean> } }).newConsumer();
    runtime.store.pos = { ...runtime.store.pos, fence: 1, epoch: 1, s: 0, inc: 'i' };
    const entries: DeltaEntry[] = Array.from({ length: APPLY_YIELD_EVERY * 3 }, (_, i) => ({ id: `${i + 1}-0`, f: 1, e: 1, inc: 'i', s: i + 1, ct: `10:${i + 1}`, rt: '82', k: 'heartbeat', ca: 1, d: EMPTY_PAYLOAD }));
    let turns = 0;
    let stop = false;
    const spin = () => {
      if (stop) return;
      turns++;
      setImmediate(spin);
    };
    setImmediate(spin);
    expect(await consumer.applyAll(entries)).toBe(true);
    stop = true;
    expect(runtime.store.pos.s).toBe(APPLY_YIELD_EVERY * 3);
    expect(turns).toBeGreaterThanOrEqual(2);
  });
});
