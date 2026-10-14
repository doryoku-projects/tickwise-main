/*
 * The redis-models janitor (design §2.3): orphaned snapshot sets older than
 * 2 min and older key layouts of THIS deployment are swept; the live set, a
 * set being written right now, and other deployments' keys are untouched.
 */
import { describe, expect, it } from 'vitest';
import { inventoryModels, sweepModels } from '../../src/read-models/feeder/janitor.js';
import { rmKeys, snapSetOf } from '../../src/read-models/keys.js';
import { MemoryModelsTransport, MemoryRedis } from '../../src/read-models/transport.js';
import type { Manifest } from '../../src/read-models/feeder/snapshot-store.js';

const keys = rmKeys('deploy1');
const WRITING = 600_000;

describe('janitor', () => {
  it('sweeps orphaned sets and old layouts, keeps the live set, young sets and other deployments', async () => {
    let now = 1_000_000;
    const redis = new MemoryRedis(() => now);
    const models = new MemoryModelsTransport(redis, keys);
    const { inc } = await models.ensureIncarnation(3_600_000);
    await models.seedFence(5, 3_600_000);
    const chunk = (set: string, i: number) => `${keys.snapPrefix}${set}:rank:1:uniswap-v4.oid:${i}`;
    // live set 5:1:3, an orphan 5:1:2 written 5 min ago, a set being written now 5:1:4.
    for (let i = 0; i < 3; i++) await models.putChunk(chunk('5:1:3', i), new Uint8Array(10), 3_600_000);
    now -= 300_000;
    for (let i = 0; i < 2; i++) await models.putChunk(chunk('5:1:2', i), new Uint8Array(20), WRITING);
    now += 300_000;
    await models.putChunk(chunk('5:1:4', 0), new Uint8Array(5), WRITING);
    const manifest = { layout: 1, fence: 5, epoch: 1, inc, snapSeq: 3, streamId: '0-0', s: 0, rt: '', ct: '0:0', ca: 0, createdAt: now, models: [], shards: [], columns: [], encodeMs: 0, stored: 0 } satisfies Manifest;
    expect(await models.putManifest(manifest, 3_600_000)).toBe('ok');
    // An older layout of this deployment, and another deployment's keys.
    redis.set('tw:rm:v0:{deploy1}:snap:1:1:1:rank:x:0', 'old', 3_600_000);
    redis.set('tw:rm:v1:{deploy2}:snap:9:9:9:rank:x:0', 'theirs', 3_600_000);
    redis.set('tw:rm:v0:{deploy2}:inc', 'theirs', 3_600_000);

    const before = await inventoryModels(models, keys);
    expect(before.liveSet).toBe('5:1:3');
    expect(before.sets.map((s) => [s.set, s.keys, s.live])).toEqual([
      ['5:1:2', 2, false],
      ['5:1:3', 3, true],
      ['5:1:4', 1, false],
    ]);
    expect(before.otherLayoutKeys).toBe(1);

    const result = await sweepModels(models, keys, { writingTtlMs: WRITING });
    expect(result.sweptSets).toEqual(['5:1:2']);
    expect(result.keptYoung).toEqual(['5:1:4']);
    expect(result.otherLayoutKeys).toBe(1);
    expect(redis.exists(chunk('5:1:3', 0))).toBe(true);
    expect(redis.exists(chunk('5:1:2', 0))).toBe(false);
    expect(redis.exists('tw:rm:v0:{deploy1}:snap:1:1:1:rank:x:0')).toBe(false);
    expect(redis.exists('tw:rm:v1:{deploy2}:snap:9:9:9:rank:x:0')).toBe(true);
    expect(redis.exists('tw:rm:v0:{deploy2}:inc')).toBe(true);
  });

  it('snapSetOf names the set of a chunk key and nothing else', () => {
    expect(snapSetOf(keys, `${keys.snapPrefix}12:34:56:rank:1:uniswap-v4.oid:0`)).toBe('12:34:56');
    expect(snapSetOf(keys, keys.manifest)).toBeUndefined();
    expect(snapSetOf(keys, keys.deltas)).toBeUndefined();
  });
});
