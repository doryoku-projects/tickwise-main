/*
 * Ordering and fencing (design §2.5), on the TypeScript model of the Lua
 * scripts — the same model `MemoryModelsTransport` runs, and the contract
 * `redis-contract.spec` checks the real scripts against (opt-in).
 */
import { describe, expect, it } from 'vitest';
import { rmKeys } from '../../src/read-models/keys.js';
import { MemoryModelsTransport, MemoryRedis, MemoryStateTransport } from '../../src/read-models/transport.js';
import type { DeltaEntry } from '../../src/read-models/feeder/delta-codec.js';
import { EMPTY_PAYLOAD } from '../../src/read-models/feeder/delta-codec.js';
import { APPEND_SCRIPT, parseCursor } from '../../src/read-models/feeder/fenced-append.js';

const keys = rmKeys('test');
const TTL = 60_000;

function entry(over: Partial<DeltaEntry>): DeltaEntry {
  return { f: 100, e: 1, inc: 'inc-a', s: 1, ct: '1:1', rt: '82', k: 'heartbeat', ca: 0, d: EMPTY_PAYLOAD, ...over };
}

async function setup() {
  const redis = new MemoryRedis();
  const models = new MemoryModelsTransport(redis, keys);
  const { inc } = await models.ensureIncarnation(TTL);
  return { redis, models, inc };
}

describe('fenced append (TS model of the Lua)', () => {
  it('appends only with the fence copy AND the incarnation, contiguous s per epoch', async () => {
    const { models, inc } = await setup();
    expect(await models.append(entry({ inc }), TTL)).toMatchObject({ ok: false, reason: 'fence_missing' });
    expect(await models.seedFence(100, TTL)).toBe(true);
    expect(await models.append(entry({ inc: 'other' }), TTL)).toMatchObject({ ok: false, reason: 'inc_mismatch' });
    expect(await models.append(entry({ inc, f: 99 }), TTL)).toMatchObject({ ok: false, reason: 'fence_mismatch', detail: '100' });
    expect(await models.append(entry({ inc, s: 2 }), TTL)).toMatchObject({ ok: false, reason: 'seq_gap' }); // no cursor → s must be 1
    const first = await models.append(entry({ inc, s: 1 }), TTL);
    expect(first.ok).toBe(true);
    expect(await models.append(entry({ inc, s: 3 }), TTL)).toMatchObject({ ok: false, reason: 'seq_gap' });
    expect(await models.append(entry({ inc, s: 1 }), TTL)).toMatchObject({ ok: false, reason: 'seq_gap' }); // no duplicates either
    expect((await models.append(entry({ inc, s: 2 }), TTL)).ok).toBe(true);
    expect(await models.cursor()).toMatchObject({ epoch: 1, s: 2, fence: 100 });
    // A NEWER epoch starts at s = 1; an older one can never append again.
    expect(await models.append(entry({ inc, e: 2, s: 5 }), TTL)).toMatchObject({ ok: false, reason: 'seq_gap' });
    expect((await models.append(entry({ inc, e: 2, s: 1 }), TTL)).ok).toBe(true);
    expect(await models.append(entry({ inc, e: 1, s: 3 }), TTL)).toMatchObject({ ok: false, reason: 'epoch_behind' });
  });

  it('seed-if-greater: the copy only ever rises; the same fence refreshes it', async () => {
    const { models } = await setup();
    expect(await models.seedFence(200, TTL)).toBe(true);
    expect(await models.seedFence(150, TTL)).toBe(false);
    expect(await models.fenceCopy()).toBe(200);
    expect(await models.seedFence(200, TTL)).toBe(true);
    expect(await models.seedFence(300, TTL)).toBe(true);
    expect(await models.fenceCopy()).toBe(300);
  });

  it('a takeover: the new holder seeds a greater fence and the old one can no longer append', async () => {
    const { models, inc } = await setup();
    await models.seedFence(100, TTL);
    expect((await models.append(entry({ inc, f: 100, s: 1 }), TTL)).ok).toBe(true);
    await models.seedFence(101, TTL);
    // The paused ex-holder wakes up and tries s = 2 under its old fence.
    expect(await models.append(entry({ inc, f: 100, s: 2 }), TTL)).toMatchObject({ ok: false, reason: 'fence_mismatch' });
    // The new holder continues the epoch at s = 2.
    expect((await models.append(entry({ inc, f: 101, s: 2 }), TTL)).ok).toBe(true);
  });

  it('the flush race: an ex-holder seeding its LOWER fence into a flushed instance cannot continue its sequence', async () => {
    const { redis, models, inc } = await setup();
    await models.seedFence(101, TTL);
    for (let s = 1; s <= 3; s++) await models.append(entry({ inc, f: 101, s }), TTL);
    redis.flushAll();
    // The paused ex-holder (fence 100) seeds first into the empty instance…
    const { inc: inc2, created } = await models.ensureIncarnation(TTL);
    expect(created).toBe(true);
    expect(await models.seedFence(100, TTL)).toBe(true);
    // …but its next sequence number does not start an epoch: refused.
    expect(await models.append(entry({ inc: inc2, f: 100, s: 4 }), TTL)).toMatchObject({ ok: false, reason: 'seq_gap' });
    // The current holder's append fails on the fence, it re-seeds its greater fence (the copy only rises)…
    expect(await models.append(entry({ inc: inc2, f: 101, e: 2, s: 1 }), TTL)).toMatchObject({ ok: false, reason: 'fence_mismatch' });
    expect(await models.seedFence(101, TTL)).toBe(true);
    // …and starts its continuation epoch at s = 1. The ex-holder is out for good.
    expect((await models.append(entry({ inc: inc2, f: 101, e: 2, s: 1 }), TTL)).ok).toBe(true);
    expect(await models.append(entry({ inc: inc2, f: 100, e: 2, s: 2 }), TTL)).toMatchObject({ ok: false, reason: 'fence_mismatch' });
  });

  it('the manifest switch is fenced too', async () => {
    const { models, inc } = await setup();
    const manifest = { layout: 1 as const, fence: 5, epoch: 1, inc, snapSeq: 1, streamId: '0-0', s: 0, rt: '', ct: '0:0', ca: 0, createdAt: 0, models: [], shards: [], columns: [], encodeMs: 0, stored: 0 };
    expect(await models.putManifest(manifest, TTL)).toBe('fence_missing');
    await models.seedFence(6, TTL);
    expect(await models.putManifest(manifest, TTL)).toBe('fence_mismatch');
    expect(await models.putManifest({ ...manifest, fence: 6, inc: 'x' }, TTL)).toBe('inc_mismatch');
    expect(await models.putManifest({ ...manifest, fence: 6 }, TTL)).toBe('ok');
    expect((await models.manifest())?.fence).toBe(6);
  });

  it('the fence authority starts at now-ms when missing and only increments', async () => {
    const redis = new MemoryRedis();
    const state = new MemoryStateTransport(redis, keys);
    expect(await state.nextFence(1_790_000_000_000)).toBe(1_790_000_000_001);
    expect(await state.nextFence(5)).toBe(1_790_000_000_002);
    redis.flushAll(); // redis-state lost: time-seeded again, never below an earlier INCR count
    expect(await state.nextFence(1_790_000_000_500)).toBe(1_790_000_000_501);
  });

  it('the cursor format round-trips, and the Lua carries every guard the model has', () => {
    expect(parseCursor('17:9:100:1700-3')).toEqual({ epoch: 17, s: 9, fence: 100, id: '1700-3' });
    expect(parseCursor('garbage')).toBeNull();
    for (const guard of ['fence_missing', 'fence_mismatch', 'inc_missing', 'inc_mismatch', 'seq_gap', 'epoch_behind', 'XADD', 'PEXPIRE']) {
      expect(APPEND_SCRIPT).toContain(guard);
    }
  });
});
