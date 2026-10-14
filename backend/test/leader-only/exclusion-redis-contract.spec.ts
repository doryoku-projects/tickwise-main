/*
 * Opt-in: the REAL `EXCLUSION_EXTEND_SCRIPT` + MULTI publish of
 * `src/database/exclusion-snapshot.ts` on a real Redis, against `LeaderRedis`
 * (which every other leader-only spec runs on). Set
 * LEADER_ONLY_TEST_REDIS_URL to a THROWAWAY Redis — the spec FLUSHDBs it.
 */
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  EXCLUSION_EXTEND_SCRIPT,
  decodeExclusionSnapshot,
  exclusionBlobKey,
  exclusionContentHash,
  exclusionMetaKey,
  parseExclusionMeta,
  publishExclusionSnapshot,
} from '../../src/database/exclusion-snapshot.js';
import { LeaderRedis } from './fakes.js';

const URL = process.env.LEADER_ONLY_TEST_REDIS_URL;
const A = '0x' + 'a1'.repeat(20);
const B = '0x' + '0b'.repeat(20);
const C = '0x' + 'cc'.repeat(20);

describe.skipIf(!URL)('exclusion snapshot publish (real Redis) = LeaderRedis', () => {
  let real: Redis;

  beforeAll(async () => {
    real = new Redis(URL as string, { lazyConnect: true, maxRetriesPerRequest: 1 });
    await real.connect();
    await real.flushdb();
  });

  afterAll(async () => {
    await real?.flushdb();
    await real?.quit();
  });

  it('the extend script answers identically on the same sequence', async () => {
    const fake = new LeaderRedis();
    const meta = (hash: string, builtAt: number) => JSON.stringify({ v: 1, chainId: 1, builtAt, hash, count: 2 });
    const steps: Array<() => [Array<string | number>, 'eval' | 'set' | 'del', string?]> = [
      () => [['m', 'b', 'h1', meta('h1', 1), 60_000], 'eval'], // nothing stored → 0
      () => [['m', meta('h1', 1)], 'set'],
      () => [['m', 'b', 'h1', meta('h1', 2), 60_000], 'eval'], // meta matches, blob missing → 0
      () => [['b', 'blob'], 'set'],
      () => [['m', 'b', 'h2', meta('h2', 3), 60_000], 'eval'], // another hash stored → 0
      () => [['m', 'b', 'h1', meta('h1', 4), 60_000], 'eval'], // match + blob → 1
      () => [['m', 'not json'], 'set'],
      () => [['m', 'b', 'h1', meta('h1', 5), 60_000], 'eval'], // garbage meta → 0
    ];
    for (const step of steps) {
      const [args, op] = step();
      if (op === 'set') {
        await real.set(String(args[0]), String(args[1]));
        await fake.set(String(args[0]), String(args[1]));
        continue;
      }
      const want = await real.eval(EXCLUSION_EXTEND_SCRIPT, 2, ...args);
      const got = await fake.eval(EXCLUSION_EXTEND_SCRIPT, 2, ...args);
      expect(got).toBe(want);
    }
    expect(await real.get('m')).toBe(await fake.get('m'));
    expect(Number(await real.pttl('b'))).toBeGreaterThan(0); // extended by the one successful step
  });

  it('publish: first write, extend, and no extend of a foreign pair — consistent every time', async () => {
    await real.flushdb();
    const first = await publishExclusionSnapshot(real, 'ns', 1, [A, B], 100, 60_000);
    expect(first.extended).toBe(false);
    const again = await publishExclusionSnapshot(real, 'ns', 1, [B, A], 200, 60_000);
    expect(again.extended).toBe(true);
    expect(parseExclusionMeta(await real.get(exclusionMetaKey('ns', 1)), 1)?.builtAt).toBe(200);
    await publishExclusionSnapshot(real, 'ns', 1, [C], 300, 60_000); // another publisher
    const back = await publishExclusionSnapshot(real, 'ns', 1, [A, B], 400, 60_000);
    expect(back.extended).toBe(false);
    const meta = parseExclusionMeta(await real.get(exclusionMetaKey('ns', 1)), 1);
    const blob = decodeExclusionSnapshot(await real.getBuffer(exclusionBlobKey('ns', 1)), 1);
    expect(meta?.hash).toBe(exclusionContentHash([A, B]));
    expect(blob?.hash).toBe(meta?.hash);
    expect(Number(await real.pttl(exclusionBlobKey('ns', 1)))).toBeGreaterThan(50_000);
  });
});
