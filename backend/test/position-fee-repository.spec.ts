/*
 * The fee refresh's Mongo shapes: the tier keyset reads, the dirty-set read
 * (hinted), the guarded rpcFees + served write, the overlay's measurement time,
 * and the sync_cursors tier cursors. explain() for these shapes was taken on a
 * local 430k-doc shard — see position-fee-refresh.service.ts / the W5 report.
 */
import { describe, expect, it, vi } from 'vitest';
import { FEE_WRITE_CHUNK, PositionsRepository } from '../src/database/positions.repository.js';
import { SyncCursorSchema } from '../src/database/schemas/sync-cursor.schema.js';
import { FEE_PASS_TALLY_KEYS, SyncRepository, emptyFeePassTally } from '../src/database/sync.repository.js';

const CHAIN = 4663;
const PROTO = 'uniswap-v4';

function fakeModel(rows: unknown[] = []) {
  const calls: Record<string, unknown[]> = {};
  const query = {
    sort: vi.fn((v: unknown) => ((calls.sort = [v]), query)),
    limit: vi.fn((v: unknown) => ((calls.limit = [v]), query)),
    select: vi.fn((v: unknown) => ((calls.select = [v]), query)),
    hint: vi.fn((v: unknown) => ((calls.hint = [v]), query)),
    collation: vi.fn((v: unknown) => ((calls.collation = [v]), query)),
    lean: vi.fn(async () => rows),
  };
  const model = {
    find: vi.fn((filter: unknown) => ((calls.find = [filter]), query)),
    bulkWrite: vi.fn(async (ops: unknown[]) => ({ matchedCount: ops.length - 1, modifiedCount: ops.length - 1 })),
  };
  const repo = new PositionsRepository({ positionModel: () => model } as never, {} as never);
  return { repo, model, query, calls };
}

const ROW = {
  positionId: '3468131',
  tokenId: '3468131',
  poolId: `0x${'d7'.repeat(32)}`,
  isActive: true,
  tickLower: 335000,
  tickUpper: 341000,
  lastModifyBlock: 77_236_915,
  token0: { decimals: 6, priceUsd: 1 },
  token1: { decimals: 18, priceUsd: 0.002 },
  amounts: { totalFeesCollected0: '50' },
  metrics: { pendingFeesUsd: 0, feesSource: 'unmeasured', isPriceable: true },
};

describe('tier keyset reads', () => {
  it('full tier: active rows after the cursor, in tokenId order, no collation, no hint', async () => {
    const { repo, calls, query } = fakeModel([ROW]);
    const out = await repo.findFeeRefreshCandidates(CHAIN, PROTO, '100', 1000);
    expect(calls.find![0]).toEqual({ chainId: CHAIN, protocol: PROTO, isActive: true, tokenId: { $gt: '100' } });
    expect(calls.sort![0]).toEqual({ tokenId: 1 });
    expect(calls.limit![0]).toBe(1000);
    expect(query.collation).not.toHaveBeenCalled();
    expect(query.hint).not.toHaveBeenCalled();
    expect(out[0]).toMatchObject({
      positionId: '3468131',
      decimals0: 6,
      decimals1: 18,
      lastModifyBlock: 77_236_915,
      stored: { token0: { priceUsd: 1 }, token1: { priceUsd: 0.002 }, metrics: { feesSource: 'unmeasured' } },
    });
  });

  it('carries the stored on-chain measurement, so an identical re-read can be skipped', async () => {
    const at = new Date('2026-10-01T11:00:00Z');
    const measured = { ...ROW, rpcFeesUncollected0: '2.5', rpcFeesUncollected1: '0', rpcFeesBlock: 77_300_000, rpcFeesAt: at };
    const { repo, calls } = fakeModel([measured, ROW]);
    const out = await repo.findFeeRefreshCandidates(CHAIN, PROTO, '', 10);
    expect(calls.select![0]).toMatchObject({ rpcFeesUncollected0: 1, rpcFeesUncollected1: 1, rpcFeesBlock: 1, rpcFeesAt: 1 });
    expect(out[0].rpc).toEqual({ fees0: '2.5', fees1: '0', block: 77_300_000, at });
    // never measured → no rpc, so the measurement is always written
    expect(out[1].rpc).toBeUndefined();
  });

  it('first page has no tokenId bound', async () => {
    const { repo, calls } = fakeModel([]);
    await repo.findFeeRefreshCandidates(CHAIN, PROTO, '', 10);
    expect(calls.find![0]).toEqual({ chainId: CHAIN, protocol: PROTO, isActive: true });
  });

  it('hot tier adds in-range and the value floor (the bg_fee_hot shape)', async () => {
    const { repo, calls } = fakeModel([]);
    await repo.findFeeRefreshCandidates(CHAIN, PROTO, '7', 500, { hotMinUsd: 50 });
    expect(calls.find![0]).toEqual({
      chainId: CHAIN,
      protocol: PROTO,
      isActive: true,
      'metrics.inRange': true,
      'metrics.underlyingValueUsd': { $gte: 50 },
      tokenId: { $gt: '7' },
    });
  });

  it('projects what the job needs and nothing heavy (no rawSubgraph, no tx*)', async () => {
    const { repo, calls } = fakeModel([]);
    await repo.findFeeRefreshCandidates(CHAIN, PROTO, '', 1);
    const projection = calls.select![0] as Record<string, number>;
    expect(projection).toMatchObject({ _id: 0, lastModifyBlock: 1, amounts: 1, metrics: 1, 'token0.priceUsd': 1 });
    expect(projection).not.toHaveProperty('rawSubgraph');
  });

  it('a row without lastModifyBlock (not yet re-synced) reads as 0', async () => {
    const { lastModifyBlock: _omit, ...legacy } = ROW;
    const { repo } = fakeModel([legacy]);
    const [c] = await repo.findFeeRefreshCandidates(CHAIN, PROTO, '', 1);
    expect(c.lastModifyBlock).toBe(0);
  });

  it('a non-numeric stored lastModifyBlock reads as 0, never NaN', async () => {
    const { repo } = fakeModel([{ ...ROW, lastModifyBlock: 'garbage' }]);
    const [c] = await repo.findFeeRefreshCandidates(CHAIN, PROTO, '', 1);
    expect(c.lastModifyBlock).toBe(0);
  });

  it('dirty read: active rows by id, hinted to the unique positionId index', async () => {
    const { repo, calls } = fakeModel([ROW]);
    await repo.findFeeRefreshCandidatesByIds(CHAIN, PROTO, ['1', '2']);
    expect(calls.find![0]).toEqual({ chainId: CHAIN, protocol: PROTO, positionId: { $in: ['1', '2'] }, isActive: true });
    expect(calls.hint![0]).toBe('chainId_1_protocol_1_positionId_1');
  });

  it('dirty read of nothing touches nothing', async () => {
    const { repo, model } = fakeModel([]);
    expect(await repo.findFeeRefreshCandidatesByIds(CHAIN, PROTO, [])).toEqual([]);
    expect(model.find).not.toHaveBeenCalled();
  });
});

describe('writeRpcFees', () => {
  type Op = { updateOne: { filter: Record<string, unknown>; update: { $set: Record<string, unknown> }; upsert?: boolean } };
  const at = new Date('2026-10-01T12:00:00Z');
  const version = new Date('2026-10-01T11:59:00Z');
  const servedRow = {
    positionId: '1',
    fees0: '1.5',
    fees1: '0',
    block: 900,
    version,
    served: { 'metrics.feesSource': 'onchain', 'metrics.pendingFeesUsd': 1.5 },
  };
  const plainRow = { positionId: '2', fees0: '0', fees1: '0', block: 901 };

  /** A model whose bulkWrite matches every op except those `refuse` names. */
  function model(refuse: (op: Op) => boolean = () => false) {
    const calls: Op[][] = [];
    const m = {
      bulkWrite: vi.fn(async (ops: Op[]) => {
        calls.push(ops);
        const n = ops.filter((op) => !refuse(op)).length;
        return { matchedCount: n, modifiedCount: n };
      }),
    };
    const repo = new PositionsRepository({ positionModel: () => m } as never, {} as never);
    return { repo, calls };
  }

  it('stamps rpcFees, merges the served paths, and refuses rows older than the stored last modify', async () => {
    const { repo, calls } = model();
    const res = await repo.writeRpcFees(CHAIN, PROTO, [servedRow, plainRow], at);
    const ops = calls.flat();
    const served = ops.find((op) => op.updateOne.filter.positionId === '1')!;
    expect(served.updateOne.filter).toEqual({
      chainId: CHAIN,
      protocol: PROTO,
      positionId: '1',
      lastModifyBlock: { $not: { $gt: 900 } },
      updatedAt: version,
    });
    expect(served.updateOne.update.$set).toEqual({
      rpcFeesUncollected0: '1.5',
      rpcFeesUncollected1: '0',
      rpcFeesBlock: 900,
      rpcFeesAt: at,
      'metrics.feesSource': 'onchain',
      'metrics.pendingFeesUsd': 1.5,
    });
    // An unchanged / immaterial measurement is still stamped, unversioned.
    const plain = ops.find((op) => op.updateOne.filter.positionId === '2')!;
    expect(plain.updateOne.filter).toEqual({ chainId: CHAIN, protocol: PROTO, positionId: '2', lastModifyBlock: { $not: { $gt: 901 } } });
    expect(plain.updateOne.update.$set).toEqual({ rpcFeesUncollected0: '0', rpcFeesUncollected1: '0', rpcFeesBlock: 901, rpcFeesAt: at });
    expect(plain.updateOne.upsert).toBeUndefined();
    // Every served write landed: no stamp-only fallback round trip.
    expect(calls).toHaveLength(2);
    expect(res).toEqual({ matched: 2, modified: 2, served: 1 });
  });

  it('a document that changed since the read gets the stamp only — its fresh cash flows are not reverted', async () => {
    // The served op is refused (its updatedAt moved); the fallback stamp matches.
    const { repo, calls } = model((op) => op.updateOne.filter.updatedAt !== undefined);
    const res = await repo.writeRpcFees(CHAIN, PROTO, [servedRow], at);
    expect(calls).toHaveLength(2);
    const [fallback] = calls[1]!;
    expect(fallback!.updateOne.filter).toEqual({
      chainId: CHAIN,
      protocol: PROTO,
      positionId: '1',
      lastModifyBlock: { $not: { $gt: 900 } },
      rpcFeesAt: { $ne: at },
    });
    expect(fallback!.updateOne.update.$set).toEqual({
      rpcFeesUncollected0: '1.5',
      rpcFeesUncollected1: '0',
      rpcFeesBlock: 900,
      rpcFeesAt: at,
    });
    expect(res).toEqual({ matched: 1, modified: 1, served: 0 });
  });

  it('the stamp-only fallback is paced BEFORE it is sent, for the rows expected to need it', async () => {
    const order: string[] = [];
    const calls: Op[][] = [];
    const m = {
      bulkWrite: vi.fn(async (ops: Op[]) => {
        calls.push(ops);
        order.push(`bulk:${ops.length}`);
        // Of two served rows, one document had moved on: its served op is refused.
        const n = ops.filter((op) => op.updateOne.filter.positionId !== 'moved').length;
        return { matchedCount: n, modifiedCount: n };
      }),
    };
    const repo = new PositionsRepository({ positionModel: () => m } as never, {} as never);
    const beforeFallback = vi.fn(async (n: number) => {
      order.push(`gate:${n}`);
    });
    await repo.writeRpcFees(CHAIN, PROTO, [servedRow, { ...servedRow, positionId: 'moved' }, plainRow], at, { beforeFallback });
    expect(beforeFallback).toHaveBeenCalledWith(1);
    // plain + served go out together, then the gate, then the fallback.
    expect(order).toEqual(['bulk:1', 'bulk:2', 'gate:1', 'bulk:2']);
    expect(calls[2]!.every((op) => op.updateOne.filter.rpcFeesAt !== undefined)).toBe(true);
  });

  it('no fallback, no gate wait, when every served write landed', async () => {
    const { repo } = model();
    const beforeFallback = vi.fn(async () => undefined);
    await repo.writeRpcFees(CHAIN, PROTO, [servedRow, plainRow], at, { beforeFallback });
    expect(beforeFallback).not.toHaveBeenCalled();
  });

  it('passes a driver-side timeout (timeoutMS) to every bulkWrite when asked, and none otherwise', async () => {
    const options: unknown[] = [];
    const m = {
      bulkWrite: vi.fn(async (ops: Op[], o: unknown) => {
        options.push(o);
        return { matchedCount: 0, modifiedCount: 0 };
      }),
    };
    const repo = new PositionsRepository({ positionModel: () => m } as never, {} as never);
    await repo.writeRpcFees(CHAIN, PROTO, [servedRow, plainRow], at, { timeoutMs: 60_000 });
    // plain, served, and the fallback (the served op matched nothing).
    expect(options).toEqual([
      { ordered: false, timeoutMS: 60_000 },
      { ordered: false, timeoutMS: 60_000 },
      { ordered: false, timeoutMS: 60_000 },
    ]);
    options.length = 0;
    await repo.writeRpcFees(CHAIN, PROTO, [plainRow], at);
    expect(options).toEqual([{ ordered: false }]);
  });

  it('a served row read from a document with no updatedAt is guarded on its absence', async () => {
    const { repo, calls } = model();
    const { version: _omit, ...unversioned } = servedRow;
    await repo.writeRpcFees(CHAIN, PROTO, [unversioned], at);
    expect(calls[0]![0]!.updateOne.filter.updatedAt).toEqual({ $exists: false });
  });

  it('sends at most FEE_WRITE_CHUNK (100) ops per bulkWrite, one chunk after another', async () => {
    const { repo, calls } = model();
    const rows = Array.from({ length: 250 }, (_, i) => ({ positionId: String(i), fees0: '1', fees1: '0', block: 900 }));
    const res = await repo.writeRpcFees(CHAIN, PROTO, rows, at);
    expect(FEE_WRITE_CHUNK).toBe(100);
    expect(calls.map((ops) => ops.length)).toEqual([100, 100, 50]);
    expect(res).toEqual({ matched: 250, modified: 250, served: 0 });
    // Every row exactly once.
    expect(new Set(calls.flat().map((op) => op.updateOne.filter.positionId)).size).toBe(250);
  });

  it('chunks a mixed page too: no chunk carries more than 100 plain + served ops', async () => {
    const { repo, calls } = model();
    const rows = Array.from({ length: 150 }, (_, i) =>
      i % 2 ? { positionId: String(i), fees0: '1', fees1: '0', block: 900 } : { ...servedRow, positionId: String(i) },
    );
    await repo.writeRpcFees(CHAIN, PROTO, rows, at);
    // [plain, served] per chunk: 50 + 50, then 25 + 25.
    expect(calls.map((ops) => ops.length)).toEqual([50, 50, 25, 25]);
  });

  it('writes nothing for no rows', async () => {
    const { repo, calls } = model();
    expect(await repo.writeRpcFees(CHAIN, PROTO, [])).toEqual({ matched: 0, modified: 0, served: 0 });
    expect(calls).toHaveLength(0);
  });

  it('reads the version with the candidate', async () => {
    const updatedAt = new Date('2026-10-01T11:00:00Z');
    const { repo, calls } = fakeModel([{ ...ROW, updatedAt }]);
    const [c] = await repo.findFeeRefreshCandidates(CHAIN, PROTO, '', 1);
    expect(c!.version).toBe(updatedAt);
    expect(calls.select![0]).toMatchObject({ updatedAt: 1 });
  });
});

describe('findRpcFees (the adapter overlay)', () => {
  it('returns the measurement time alongside the figure and block', async () => {
    const at = new Date('2026-10-01T12:00:00Z');
    const { repo, calls } = fakeModel([
      { positionId: '1', rpcFeesUncollected0: '1.5', rpcFeesUncollected1: '2', rpcFeesBlock: 900, rpcFeesAt: at },
      { positionId: '2', rpcFeesUncollected0: '0', rpcFeesUncollected1: '0', rpcFeesBlock: 901 },
    ]);
    const out = await repo.findRpcFees(CHAIN, PROTO, ['1', '2']);
    expect(out.get('1')).toEqual({ fees0: 1.5, fees1: 2, block: 900, at });
    expect(out.get('2')).toEqual({ fees0: 0, fees1: 0, block: 901 });
    expect(calls.select![0]).toMatchObject({ rpcFeesAt: 1 });
  });
});

describe('sync_cursors fee tier cursors', () => {
  function fakeCursorModel(row: Record<string, unknown> | null) {
    const query = { select: vi.fn(() => query), lean: vi.fn(async () => row) };
    return {
      findOne: vi.fn(() => query),
      updateOne: vi.fn(async () => ({})),
      query,
    };
  }

  it('reads both tiers, defaulting an absent row to never-run', async () => {
    const started = new Date('2026-10-01T10:00:00Z');
    const m = fakeCursorModel({ feeCursorHot: '42', feeHotStartedAt: started });
    const repo = new SyncRepository(m as never, {} as never);
    expect(await repo.getFeeCursors(CHAIN, PROTO)).toEqual({
      hot: { cursor: '42', startedAt: started, finishedAt: undefined },
      all: { cursor: '', startedAt: undefined, finishedAt: undefined },
    });
    expect(m.query.select).toHaveBeenCalledWith(
      expect.objectContaining({ feeCursorHot: 1, feeHotStartedAt: 1, feeHotFinishedAt: 1, feeCursorAll: 1, feeAllStartedAt: 1, feeAllFinishedAt: 1 }),
    );
    const none = new SyncRepository(fakeCursorModel(null) as never, {} as never);
    expect((await none.getFeeCursors(CHAIN, PROTO)).hot).toEqual({ cursor: '', startedAt: undefined, finishedAt: undefined });
  });

  it('persists one tier per call, upserting the (chain, protocol) row', async () => {
    const m = fakeCursorModel(null);
    const repo = new SyncRepository(m as never, {} as never);
    const startedAt = new Date('2026-10-01T10:00:00Z');
    await repo.saveFeeCursor(CHAIN, PROTO, 'all', { cursor: '99', startedAt });
    expect(m.updateOne).toHaveBeenCalledWith(
      { chainId: CHAIN, protocol: PROTO },
      { $set: { feeCursorAll: '99', feeAllStartedAt: startedAt } },
      { upsert: true },
    );
  });

  it('the pass tally: the first page REPLACES it ($set), later pages ADD to it ($inc, zeros skipped)', async () => {
    const m = fakeCursorModel(null);
    const repo = new SyncRepository(m as never, {} as never);
    const counts = { ...emptyFeePassTally(), scanned: 2000, measured: 1990, written: 120, unreadable: 10 };
    await repo.saveFeeCursor(CHAIN, PROTO, 'all', { cursor: '9' }, { mode: 'set', counts });
    const [, first] = m.updateOne.mock.calls[0] as unknown as [unknown, { $set: Record<string, unknown>; $inc?: unknown }];
    expect(first.$set).toMatchObject({ feeCursorAll: '9', 'feeAllTally.scanned': 2000, 'feeAllTally.failed': 0, 'feeAllTally.unanswered': 0 });
    expect(first.$inc).toBeUndefined();
    await repo.saveFeeCursor(CHAIN, PROTO, 'hot', { cursor: '12' }, { mode: 'inc', counts });
    const [, next] = m.updateOne.mock.calls[1] as unknown as [unknown, { $set: Record<string, unknown>; $inc: Record<string, number> }];
    expect(next.$set).toEqual({ feeCursorHot: '12' });
    expect(next.$inc).toEqual({
      'feeHotTally.scanned': 2000,
      'feeHotTally.measured': 1990,
      'feeHotTally.written': 120,
      'feeHotTally.unreadable': 10,
    });
  });

  it('reads the tally back, a missing or non-numeric counter as 0', async () => {
    const m = fakeCursorModel({ feeCursorAll: '5', feeAllTally: { scanned: 7, failed: 'x' } });
    const repo = new SyncRepository(m as never, {} as never);
    const cursors = await repo.getFeeCursors(CHAIN, PROTO);
    expect(cursors.all.tally).toEqual({ ...emptyFeePassTally(), scanned: 7 });
    expect(cursors.hot.tally).toBeUndefined();
    expect(m.query.select).toHaveBeenCalledWith(expect.objectContaining({ feeHotTally: 1, feeAllTally: 1 }));
  });

  it('every tally counter is DECLARED in the schema (strict mode would drop it from the $set/$inc)', () => {
    for (const tier of ['feeHotTally', 'feeAllTally']) {
      for (const k of FEE_PASS_TALLY_KEYS) expect(SyncCursorSchema.path(`${tier}.${k}`), `${tier}.${k}`).toBeDefined();
    }
  });
});
