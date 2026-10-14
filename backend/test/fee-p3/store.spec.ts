/*
 * P3.3 RAM store (design §9.1): pass order = the Mongo keyset's lexicographic
 * tokenId order; typed-array round trip incl. uint128 fees and the string-id
 * fallback; binary-search lookups; sorted batch inserts; tombstones and
 * in-place compaction; the in-place reconcile diff; newer-wins; coverage.
 */
import { describe, expect, it } from 'vitest';
import { FeeCandidateStore, STORE_BYTES_PER_ROW, compareIds, newerWins, toRaw, type StoreRow } from '../../src/sync/fee-candidate-store.js';

const POOL = `0x${'ab'.repeat(32)}`;

function row(tokenId: string, over: Partial<StoreRow> = {}): StoreRow {
  return {
    positionId: tokenId,
    tokenId,
    poolId: POOL,
    tickLower: -600,
    tickUpper: 600,
    lastModifyBlock: 100,
    decimals0: 6,
    decimals1: 18,
    price0: 1,
    price1: 2500,
    isPriceable: true,
    feesSource: 'onchain',
    pendingFeesUsd: 3.5,
    rpc: { fees0: '1.5', fees1: '0.000000000000000001', block: 120, at: new Date(1_700_000_000_000) },
    updatedAtMs: 1_700_000_000_000,
    ...over,
  };
}

function complete(store: FeeCandidateStore, rows: StoreRow[]): void {
  store.reconcileRange('', undefined, rows, Date.now());
}

describe('fee candidate store', () => {
  it('pages in the Mongo keyset order (lexicographic: "10" < "9"), across inserts in any order', () => {
    const s = new FeeCandidateStore();
    const ids = ['9', '10', '100', '2', '11', '1', '20'];
    complete(s, ids.map((i) => row(i)));
    const all = s.page('', 100);
    expect(all.rows.map((r) => r.tokenId)).toEqual([...ids].sort(compareIds));
    expect(all.end).toBe(true);
    expect(s.page('10', 2).rows.map((r) => r.tokenId)).toEqual(['100', '11']);
    expect(s.page('9', 5)).toEqual({ rows: [], end: true });
  });

  it('round-trips every column, uint128 fees exactly (the decimal string formatUnits wrote)', () => {
    const s = new FeeCandidateStore();
    const big = '340282366920938463463.374607431768211455'; // 2^128 − 1 raw at 18 decimals
    const r = row('5', { decimals1: 18, rpc: { fees0: '123456.789012', fees1: big, block: 9, at: new Date(5) } });
    complete(s, [r]);
    expect(s.get('5')).toEqual(r);
    expect(toRaw(big, 18)).toBe((1n << 128n) - 1n);
  });

  it('a stamp past uint128 (junk-token amounts, seen on the rig) is kept exactly, outside the words', () => {
    const s = new FeeCandidateStore();
    const huge = '2747956404093045011047.579914432262452775'; // 2.7e39 raw at 18 decimals (rig, chain 1)
    complete(s, [row('5', { rpc: { fees0: '205.554754', fees1: huge, block: 9, at: new Date(3) } }), row('6')]);
    expect(s.get('5')!.rpc).toEqual({ fees0: '205.554754', fees1: huge, block: 9, at: new Date(3) });
    // A later normal stamp replaces it; moves and compaction never mix rows up.
    s.upsert([row('1'), row('2'), row('3')]);
    expect(s.get('5')!.rpc!.fees1).toBe(huge);
    expect(s.applyStamp('5', { fees0: '1', fees1: '2', block: 10 })).toBe(true);
    expect(s.get('5')!.rpc).toEqual({ fees0: '1', fees1: '2', block: 10 });
    expect(s.get('6')!.rpc!.fees1).toBe('0.000000000000000001');
  });

  it('forgets a stamp it cannot read at all (never a wrong "unchanged" skip)', () => {
    const s = new FeeCandidateStore();
    complete(s, [row('5', { rpc: { fees0: 'NaN', fees1: '1', block: 9 } })]);
    expect(s.get('5')!.rpc).toBeUndefined();
  });

  it('falls back to string ids for the whole chain when one id is not a safe canonical integer', () => {
    const s = new FeeCandidateStore();
    complete(s, [row('5'), row('12')]);
    expect(s.stringIds).toBe(false);
    const huge = '123456789012345678901234567890';
    s.upsert([row(huge), row('007')]);
    expect(s.stringIds).toBe(true);
    expect(s.page('', 10).rows.map((r) => r.tokenId)).toEqual(['007', '12', huge, '5']);
    expect(s.get(huge)!.tokenId).toBe(huge);
  });

  it('binary-search lookups and sorted batch inserts keep order (merge from the tail)', () => {
    const s = new FeeCandidateStore();
    const base = Array.from({ length: 500 }, (_, i) => row(String(i * 3)));
    complete(s, base);
    const extra = Array.from({ length: 300 }, (_, i) => row(String(i * 5 + 1)));
    s.upsert(extra);
    const ids = s.page('', 10_000).rows.map((r) => r.tokenId);
    const expected = [...new Set([...base, ...extra].map((r) => r.tokenId))].sort(compareIds);
    expect(ids).toEqual(expected);
    for (const id of expected) expect(s.get(id)?.tokenId).toBe(id);
    expect(s.get('2')).toBeUndefined();
  });

  it('a batch with duplicate ids keeps the newest; an older row never replaces a newer one', () => {
    const s = new FeeCandidateStore();
    s.upsert([row('7', { price0: 1, updatedAtMs: 10 }), row('7', { price0: 2, updatedAtMs: 20 })]);
    expect(s.get('7')!.price0).toBe(2);
    expect(s.upsert([row('7', { price0: 3, updatedAtMs: 15 })])).toBe(0);
    expect(s.get('7')!.price0).toBe(2);
    expect(s.upsert([row('7', { price0: 4, updatedAtMs: 1, lastModifyBlock: 101 })])).toBe(1);
    expect(s.get('7')!.price0).toBe(4);
  });

  it('newerWins: a later lastModifyBlock wins outright, then the later time (ties to the incoming)', () => {
    expect(newerWins({ lastModifyBlock: 5, updatedAtMs: 100 }, { lastModifyBlock: 6, updatedAtMs: 1 })).toBe(true);
    expect(newerWins({ lastModifyBlock: 6, updatedAtMs: 1 }, { lastModifyBlock: 5, updatedAtMs: 100 })).toBe(false);
    expect(newerWins({ lastModifyBlock: 5, updatedAtMs: 100 }, { lastModifyBlock: 5, updatedAtMs: 100 })).toBe(true);
    expect(newerWins({ lastModifyBlock: 5, updatedAtMs: 100 }, { lastModifyBlock: 5, updatedAtMs: 99 })).toBe(false);
  });

  it('remove = tombstone (skipped by pages and lookups), revived by a newer row, compacted in place', () => {
    const s = new FeeCandidateStore();
    complete(s, Array.from({ length: 2_500 }, (_, i) => row(String(1000 + i))));
    expect(s.remove('1001', 2_000_000_000_000)).toBe(true);
    expect(s.get('1001')).toBeUndefined();
    expect(s.page('1000', 1).rows[0]!.tokenId).toBe('1002');
    // A doc read BEFORE the closure cannot revive it…
    expect(s.upsert([row('1001', { updatedAtMs: 1_900_000_000_000 })])).toBe(0);
    // …a later one can.
    expect(s.upsert([row('1001', { updatedAtMs: 2_100_000_000_000 })])).toBe(1);
    expect(s.get('1001')).toBeDefined();
    // An older closure is ignored.
    expect(s.remove('1001', 1)).toBe(false);
    for (let i = 0; i < 1_200; i++) s.remove(String(1000 + i * 2));
    // ≥ 1,000 tombstones: compacted on the way.
    expect(s.size).toBe(2_500 - 1_200);
    expect(s.page('', 10_000).rows.map((r) => r.tokenId)).toEqual(
      Array.from({ length: 2_500 }, (_, i) => String(1000 + i)).filter((id, i) => i % 2 === 1 || i >= 2_400),
    );
  });

  it('reconcileRange: updates, inserts, and removes rows the walk did not return — not ones a writer touched after the read', () => {
    const s = new FeeCandidateStore();
    complete(s, [row('1'), row('2'), row('3'), row('4')]);
    const readAt = 2_000_000_000_000;
    s.upsert([row('3', { updatedAtMs: readAt + 1, lastModifyBlock: 100 })]); // a hint newer than the walk's read
    const changed = s.reconcileRange('', undefined, [row('1', { price0: 9, updatedAtMs: readAt - 1 }), row('5', { updatedAtMs: readAt - 1 })], readAt, 0);
    expect(s.page('', 10).rows.map((r) => r.tokenId)).toEqual(['1', '3', '5']);
    expect(s.get('1')!.price0).toBe(9);
    expect(changed).toBe(4); // 2 and 4 removed, 1 updated, 5 inserted
  });

  it('coverage: pages never run past what the load covered, and only a complete store ENDS a pass', () => {
    const s = new FeeCandidateStore();
    s.reconcileRange('', '3', [row('1'), row('2'), row('3')], Date.now());
    s.upsert([row('7')]); // a hint above the covered range
    expect(s.covers('3')).toBe(true);
    expect(s.covers('7')).toBe(false);
    expect(s.page('', 10)).toEqual({ rows: [row('1'), row('2'), row('3')], end: false });
    s.reconcileRange('3', undefined, [row('5'), row('7')], Date.now());
    expect(s.complete).toBe(true);
    expect(s.page('3', 10).rows.map((r) => r.tokenId)).toEqual(['5', '7']);
    expect(s.page('3', 10).end).toBe(true);
  });

  it('stamps only move forward; own writes apply the stamp and the served figure and clear verify', () => {
    const s = new FeeCandidateStore();
    complete(s, [row('7', { feesSource: 'indexer' })]);
    expect(s.applyStamp('7', { fees0: '9', fees1: '9', block: 119 })).toBe(false);
    expect(s.applyStamp('7', { fees0: '9', fees1: '9', block: 121 })).toBe(true);
    expect(s.get('7')!.rpc!.block).toBe(121);
    s.markVerify('7');
    expect(s.get('7')!.verify).toBe(true);
    s.applyOwnWrite('7', { fees0: '2', fees1: '3', block: 130, at: new Date(7) }, { pendingFeesUsd: 11 });
    const r = s.get('7')!;
    expect(r.verify).toBeUndefined();
    expect(r.feesSource).toBe('onchain');
    expect(r.pendingFeesUsd).toBe(11);
    expect(r.rpc).toEqual({ fees0: '2', fees1: '3', block: 130, at: new Date(7) });
  });

  it('~111 bytes a row of typed arrays (≈ 0.15 GB at 1.3M), at most ×1.5 capacity slack', () => {
    const s = new FeeCandidateStore();
    complete(s, Array.from({ length: 20_000 }, (_, i) => row(String(i + 1))));
    expect(STORE_BYTES_PER_ROW).toBeLessThanOrEqual(115);
    expect((STORE_BYTES_PER_ROW * 1_300_000) / 1e9).toBeLessThan(0.16);
    expect(s.byteSize() / s.size).toBeLessThan(1.5 * STORE_BYTES_PER_ROW + 1);
  });
});
