/*
 * The published exclusion set's codec and publish rule (leases on only).
 */
import { describe, expect, it } from 'vitest';
import {
  decodeExclusionSnapshot,
  encodeExclusionSnapshot,
  exclusionBlobKey,
  exclusionContentHash,
  exclusionMetaKey,
  parseExclusionMeta,
  publishExclusionSnapshot,
} from '../../src/database/exclusion-snapshot.js';
import { LeaderRedis } from './fakes.js';

const A = '0x' + 'a1'.repeat(20);
const B = '0x' + '0b'.repeat(20);
const ODD = 'not-an-evm-address';

describe('exclusion snapshot codec', () => {
  it('round-trips packed and unpacked addresses, and names the content', () => {
    const buf = encodeExclusionSnapshot(1, 1234, [A, ODD, B]);
    const decoded = decodeExclusionSnapshot(buf, 1);
    expect(decoded?.builtAt).toBe(1234);
    expect([...decoded!.addresses].sort()).toEqual([A, B, ODD].sort());
    expect(decoded?.hash).toBe(exclusionContentHash([B, A, ODD])); // order is not content
  });

  it('packs an address in 20 bytes, not 42', () => {
    const many = Array.from({ length: 1000 }, (_, i) => '0x' + i.toString(16).padStart(40, '0'));
    expect(encodeExclusionSnapshot(1, 1, many).length).toBeLessThan(1000 * 21 + 200);
  });

  it('refuses another chain, a tampered body, a wrong magic and garbage', () => {
    const buf = encodeExclusionSnapshot(1, 1, [A, B]);
    expect(decodeExclusionSnapshot(buf, 42161)).toBeUndefined();
    const tampered = Buffer.from(buf);
    tampered[tampered.length - 1] ^= 0xff;
    expect(decodeExclusionSnapshot(tampered, 1)).toBeUndefined();
    const magic = Buffer.from(buf);
    magic[0] = 0x58;
    expect(decodeExclusionSnapshot(magic, 1)).toBeUndefined();
    expect(decodeExclusionSnapshot(Buffer.from('nope'), 1)).toBeUndefined();
    expect(decodeExclusionSnapshot(null, 1)).toBeUndefined();
  });

  it('parses only a v1 meta of the right chain', () => {
    const meta = JSON.stringify({ v: 1, chainId: 1, builtAt: 5, hash: 'h', count: 2 });
    expect(parseExclusionMeta(meta, 1)?.hash).toBe('h');
    expect(parseExclusionMeta(meta, 2)).toBeUndefined();
    expect(parseExclusionMeta(JSON.stringify({ v: 2, chainId: 1, builtAt: 5, hash: 'h', count: 2 }), 1)).toBeUndefined();
    expect(parseExclusionMeta('{', 1)).toBeUndefined();
    expect(parseExclusionMeta(null, 1)).toBeUndefined();
  });
});

describe('publishExclusionSnapshot', () => {
  it('a first publish writes blob + meta together (one MULTI), with a TTL', async () => {
    const redis = new LeaderRedis();
    const out = await publishExclusionSnapshot(redis as never, 'ns', 1, [A, B], 100, 210_000);
    expect(out).toEqual({ hash: exclusionContentHash([A, B]), extended: false });
    expect(redis.calls).toEqual(['eval', 'exec']); // the extend found nothing → the atomic write
    const meta = parseExclusionMeta(await redis.get(exclusionMetaKey('ns', 1)), 1);
    expect(meta).toMatchObject({ builtAt: 100, count: 2, hash: exclusionContentHash([A, B]) });
    expect(redis.kv.get(exclusionBlobKey('ns', 1))?.exp).toBeGreaterThan(Date.now());
  });

  it('an unchanged set only extends the stored pair (no blob rewrite) and refreshes the meta', async () => {
    const redis = new LeaderRedis();
    await publishExclusionSnapshot(redis as never, 'ns', 1, [A, B], 100, 210_000);
    const blobBefore = redis.kv.get(exclusionBlobKey('ns', 1))?.v;
    redis.calls.length = 0;
    const out = await publishExclusionSnapshot(redis as never, 'ns', 1, [B, A], 200, 210_000);
    expect(out.extended).toBe(true);
    expect(redis.calls).toEqual(['eval']);
    expect(redis.kv.get(exclusionBlobKey('ns', 1))?.v).toBe(blobBefore);
    expect(parseExclusionMeta(await redis.get(exclusionMetaKey('ns', 1)), 1)?.builtAt).toBe(200);
  });

  it('rewrites the blob when it vanished although the meta still names the same content', async () => {
    const redis = new LeaderRedis();
    await publishExclusionSnapshot(redis as never, 'ns', 1, [A], 100, 210_000);
    redis.drop(exclusionBlobKey('ns', 1));
    redis.calls.length = 0;
    await publishExclusionSnapshot(redis as never, 'ns', 1, [A], 200, 210_000);
    expect(redis.calls).toEqual(['eval', 'exec']);
    expect(decodeExclusionSnapshot(await redis.getBuffer(exclusionBlobKey('ns', 1)), 1)?.addresses).toEqual([A]);
  });

  it('never extends a blob another publisher overwrote: the pair stays consistent (review finding)', async () => {
    // B publishes X; an old holder A, finishing its last cycle after losing the
    // lease, publishes Y; B publishes X again. Before: B extended the foreign
    // blob Y and wrote a meta naming X — every follower without X then failed
    // the hash check and rescanned Mongo every minute, silently.
    const redis = new LeaderRedis();
    const X = [A, B];
    const Y = [ODD];
    await publishExclusionSnapshot(redis as never, 'ns', 1, X, 100, 210_000);
    await publishExclusionSnapshot(redis as never, 'ns', 1, Y, 150, 210_000);
    const out = await publishExclusionSnapshot(redis as never, 'ns', 1, X, 200, 210_000);
    expect(out.extended).toBe(false);
    const meta = parseExclusionMeta(await redis.get(exclusionMetaKey('ns', 1)), 1);
    const blob = decodeExclusionSnapshot(await redis.getBuffer(exclusionBlobKey('ns', 1)), 1);
    expect(blob?.hash).toBe(meta?.hash);
    expect(meta?.hash).toBe(exclusionContentHash(X));
  });

  it('a MULTI whose command failed (or that aborted) throws instead of passing for published', async () => {
    const chain = (results: unknown) => {
      const c = { set: () => c, exec: async () => results };
      return c;
    };
    const failedSet = { eval: async () => 0, multi: () => chain([[new Error('OOM command not allowed'), null], [null, 'OK']]) };
    await expect(publishExclusionSnapshot(failedSet as never, 'ns', 1, [A], 100, 210_000)).rejects.toThrow('OOM');
    const aborted = { eval: async () => 0, multi: () => chain(null) };
    await expect(publishExclusionSnapshot(aborted as never, 'ns', 1, [A], 100, 210_000)).rejects.toThrow(/aborted/);
  });

  it('a Redis error is thrown to the caller (it logs and carries on)', async () => {
    const redis = new LeaderRedis();
    redis.failing = true;
    await expect(publishExclusionSnapshot(redis as never, 'ns', 1, [A], 100, 210_000)).rejects.toThrow('redis down');
  });
});
