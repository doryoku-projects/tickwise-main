import { describe, expect, it } from 'vitest';
import { PoolHooksCache, type PoolHooksLoader } from '../src/pools/pool-hooks-cache.js';

/**
 * The per-page hook lookup behind the position rows' `hooks` / `customAccounting`
 * (pool-hooks-cache.ts): one `$in` per shard, an immutable fact remembered, a
 * pool the collection does not hold yet asked again later, and a page that is
 * never failed or held by it.
 */

const ANGSTROM = '0x0000000aa232009084bd71a5797d089aa4edfad4';
const PLAIN = '0xcdf0049105d85b0a32d39d0ea7a99818733d80c0';
const row = (poolId: string, chainId = 1, protocol = 'uniswap-v4') => ({ chainId, protocol, poolId });

function loaderOver(db: Record<string, string | null>) {
  const calls: Array<{ chainId: number; protocol: string; poolIds: string[] }> = [];
  const load: PoolHooksLoader = async (chainId, protocol, poolIds) => {
    calls.push({ chainId, protocol, poolIds });
    return poolIds.filter((id) => Object.hasOwn(db, `${chainId}:${id}`)).map((id) => {
      const hooks = db[`${chainId}:${id}`];
      return hooks ? { poolId: id, hooks } : { poolId: id };
    });
  };
  return { load, calls };
}

describe('PoolHooksCache', () => {
  it('reads each shard once, with lower-cased distinct ids, and returns only the hooked pools', async () => {
    const { load, calls } = loaderOver({ '1:0xaa': ANGSTROM, '1:0xbb': null, '42161:0xcc': PLAIN });
    const cache = new PoolHooksCache(load);

    const out = await cache.hooksFor([row('0xAA'), row('0xaa'), row('0xBB'), row('0xCC', 42161)]);

    expect(calls).toHaveLength(2);
    expect(calls.find((c) => c.chainId === 1)).toEqual({ chainId: 1, protocol: 'uniswap-v4', poolIds: ['0xaa', '0xbb'] });
    expect(calls.find((c) => c.chainId === 42161)!.poolIds).toEqual(['0xcc']);
    expect([...out]).toEqual([
      ['1:uniswap-v4:0xaa', ANGSTROM],
      ['42161:uniswap-v4:0xcc', PLAIN],
    ]);
  });

  it('remembers a pool for good, hooked or not: a warm page reads nothing', async () => {
    const { load, calls } = loaderOver({ '1:0xaa': ANGSTROM, '1:0xbb': null });
    const cache = new PoolHooksCache(load);
    await cache.hooksFor([row('0xaa'), row('0xbb')]);
    expect(calls).toHaveLength(1);

    const again = await cache.hooksFor([row('0xAA'), row('0xbb')]);
    expect(calls).toHaveLength(1);
    expect(again.get(PoolHooksCache.key(1, 'uniswap-v4', '0xaa'))).toBe(ANGSTROM);
    expect(again.has(PoolHooksCache.key(1, 'uniswap-v4', '0xbb'))).toBe(false);
  });

  it('asks only for the pools it does not know (a mixed page)', async () => {
    const { load, calls } = loaderOver({ '1:0xaa': ANGSTROM, '1:0xdd': PLAIN });
    const cache = new PoolHooksCache(load);
    await cache.hooksFor([row('0xaa')]);
    await cache.hooksFor([row('0xaa'), row('0xdd')]);
    expect(calls.map((c) => c.poolIds)).toEqual([['0xaa'], ['0xdd']]);
  });

  it('does not remember a pool the collection does not hold as hook-less: it is asked again once pool sync has it', async () => {
    let nowMs = 1_000_000;
    const db: Record<string, string | null> = {};
    const { load, calls } = loaderOver(db);
    const cache = new PoolHooksCache(load, { missTtlMs: 60_000, now: () => nowMs });

    expect((await cache.hooksFor([row('0xnew')])).size).toBe(0);
    expect(calls).toHaveLength(1);

    // Inside the miss window it is not asked again…
    nowMs += 59_000;
    await cache.hooksFor([row('0xnew')]);
    expect(calls).toHaveLength(1);

    // …and past it, with the pool now synced, it is found.
    db['1:0xnew'] = ANGSTROM;
    nowMs += 2_000;
    const out = await cache.hooksFor([row('0xnew')]);
    expect(calls).toHaveLength(2);
    expect(out.get(PoolHooksCache.key(1, 'uniswap-v4', '0xnew'))).toBe(ANGSTROM);
  });

  it('never rejects: a failed read serves the page without hooks, and the next page tries again', async () => {
    let fail = true;
    let calls = 0;
    const load: PoolHooksLoader = async (_c, _p, ids) => {
      calls++;
      if (fail) throw new Error('mongo down');
      return ids.map((poolId) => ({ poolId, hooks: ANGSTROM }));
    };
    const cache = new PoolHooksCache(load);

    expect((await cache.hooksFor([row('0xaa')])).size).toBe(0);
    fail = false;
    expect((await cache.hooksFor([row('0xaa')])).size).toBe(1);
    expect(calls).toBe(2);
  });

  it('does not hold a page past its deadline, and the slow read still fills the cache for the next one', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let calls = 0;
    const load: PoolHooksLoader = async (_c, _p, ids) => {
      calls++;
      await gate;
      return ids.map((poolId) => ({ poolId, hooks: ANGSTROM }));
    };
    const cache = new PoolHooksCache(load, { deadlineMs: 15 });

    const started = Date.now();
    const first = await cache.hooksFor([row('0xaa')]);
    expect(Date.now() - started).toBeLessThan(500);
    expect(first.size).toBe(0);

    release();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await cache.hooksFor([row('0xaa')]);
    expect(second.get(PoolHooksCache.key(1, 'uniswap-v4', '0xaa'))).toBe(ANGSTROM);
    expect(calls).toBe(1);
  });

  it('stores a malformed or zero-address `hooks` as no hook (never trusts the document)', async () => {
    const load: PoolHooksLoader = async (_c, _p, ids) => ids.map((poolId, i) => ({ poolId, hooks: i === 0 ? '0x0000000000000000000000000000000000000000' : 'garbage' }));
    const cache = new PoolHooksCache(load);
    expect((await cache.hooksFor([row('0xaa'), row('0xbb')])).size).toBe(0);
  });

  it('is bounded: the oldest remembered pool goes first', async () => {
    const { load, calls } = loaderOver({ '1:0x01': ANGSTROM, '1:0x02': ANGSTROM, '1:0x03': ANGSTROM });
    const cache = new PoolHooksCache(load, { maxEntries: 2 });
    await cache.hooksFor([row('0x01')]);
    await cache.hooksFor([row('0x02')]);
    await cache.hooksFor([row('0x03')]);
    expect(calls).toHaveLength(3);

    await cache.hooksFor([row('0x03'), row('0x02')]); // both still remembered
    expect(calls).toHaveLength(3);
    await cache.hooksFor([row('0x01')]); // evicted: read again
    expect(calls).toHaveLength(4);
  });

  it('skips a row with no pool id', async () => {
    const { load, calls } = loaderOver({});
    const cache = new PoolHooksCache(load);
    expect((await cache.hooksFor([{ chainId: 1, protocol: 'uniswap-v4' } as never])).size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
