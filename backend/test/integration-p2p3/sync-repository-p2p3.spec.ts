/*
 * I0 — SyncRepository's P2/P3 surface (integrator-owned): the FENCED fee
 * cursor write (design §9.5), the tokenId walk's cursor state (§6.2-1), the
 * read overlay's `lastCleanRefreshAt` (§4.6) and the run-reaper role gate
 * (§2.2). The fence is proven twice: against a recording fake (the shape of
 * every call) and — opt-in, `P2P3_TEST_MONGO_URI` — against a real MongoDB,
 * because "a deposed holder's upsert fails E11000" is a SERVER behaviour no
 * fake can vouch for.
 *
 *   P2P3_TEST_MONGO_URI=mongodb://127.0.0.1:27118/p2p3_contract npx vitest run test/integration-p2p3/sync-repository-p2p3.spec.ts
 */
import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureProcessRole, resetProcessRoleForTests } from '../../src/common/process-role.js';
import { SyncCursorSchema } from '../../src/database/schemas/sync-cursor.schema.js';
import { emptyFeePassTally, LAST_CLEAN_REFRESH_CACHE_MS, SyncRepository } from '../../src/database/sync.repository.js';

interface Call {
  filter: Record<string, unknown>;
  update: Record<string, unknown>;
  options?: Record<string, unknown>;
}

function recordingModel(opts: { failWith?: unknown; findOne?: () => unknown; find?: () => unknown[] } = {}) {
  const calls: Call[] = [];
  const model = {
    calls,
    updateOne: vi.fn(async (filter: Record<string, unknown>, update: Record<string, unknown>, options?: Record<string, unknown>) => {
      calls.push({ filter, update, options });
      if (opts.failWith) throw opts.failWith;
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
    }),
    findOne: vi.fn(() => ({
      select: () => ({ lean: async () => (opts.findOne ? opts.findOne() : null) }),
    })),
    find: vi.fn((_filter: Record<string, unknown>) => ({
      select: (_projection: Record<string, unknown>) => ({ lean: async () => (opts.find ? opts.find() : []) }),
    })),
  };
  return model;
}

const repo = (cursorModel: unknown) => new SyncRepository(cursorModel as never, {} as never);
const tally = { mode: 'inc' as const, counts: { ...emptyFeePassTally(), scanned: 5, measured: 4 } };

afterEach(() => {
  resetProcessRoleForTests();
  vi.useRealTimers();
});

describe('saveFeeCursor — fenced (design §9.5)', () => {
  it('without a fence: today\'s unfenced upsert, no feeFence written, answers true', async () => {
    const model = recordingModel();
    await expect(repo(model).saveFeeCursor(1, 'uniswap-v4', 'all', { cursor: '42' }, tally)).resolves.toBe(true);
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]!.filter).toEqual({ chainId: 1, protocol: 'uniswap-v4' });
    expect(model.calls[0]!.update.$set).not.toHaveProperty('feeFence');
    expect(model.calls[0]!.options).toEqual({ upsert: true });
  });

  it('with a fence: writes only where the stored fence is absent or ≤ ours, and raises it to ours', async () => {
    const model = recordingModel();
    await expect(repo(model).saveFeeCursor(1, 'uniswap-v4', 'all', { cursor: '42' }, tally, 7)).resolves.toBe(true);
    const call = model.calls[0]!;
    expect(call.filter).toEqual({
      chainId: 1,
      protocol: 'uniswap-v4',
      $or: [{ feeFence: { $exists: false } }, { feeFence: { $lte: 7 } }],
    });
    expect(call.update.$set).toMatchObject({ feeCursorAll: '42', feeFence: 7 });
    // The cursor and its tally land in the SAME update (never apart).
    expect(call.update.$inc).toMatchObject({ 'feeAllTally.scanned': 5, 'feeAllTally.measured': 4 });
    expect(call.options).toEqual({ upsert: true });
  });

  it('E11000 on the fenced upsert = deposed: answers false (the fee tick then stops with fees.fence_refused)', async () => {
    const model = recordingModel({ failWith: Object.assign(new Error('E11000 duplicate key'), { code: 11000 }) });
    await expect(repo(model).saveFeeCursor(1, 'uniswap-v4', 'hot', { cursor: '1' }, undefined, 3)).resolves.toBe(false);
  });

  it('any other error still throws (a write that failed is not a deposition)', async () => {
    const model = recordingModel({ failWith: Object.assign(new Error('timeout'), { code: 50 }) });
    await expect(repo(model).saveFeeCursor(1, 'uniswap-v4', 'hot', { cursor: '1' }, undefined, 3)).rejects.toThrow('timeout');
  });

  it('a non-finite fence is treated as no fence (the lease runner\'s fail-open local mode writes unfenced)', async () => {
    const model = recordingModel();
    await expect(repo(model).saveFeeCursor(1, 'uniswap-v4', 'all', { cursor: '9' }, undefined, Number.NaN)).resolves.toBe(true);
    expect(model.calls[0]!.filter).toEqual({ chainId: 1, protocol: 'uniswap-v4' });
  });

  it('the schema DECLARES every P2/P3 field (strict mode silently drops an undeclared $set path)', () => {
    for (const path of ['feeFence', 'backfillPaging', 'backfillTokenIdCursor', 'backfillRunStartTs', 'lastCleanRefreshAt', 'lastRefreshOkAt']) {
      expect(SyncCursorSchema.path(path), path).toBeDefined();
    }
    // tokenIds are uint256: the cursor is a STRING, never a Number.
    expect(SyncCursorSchema.path('backfillTokenIdCursor').instance).toBe('String');
    expect(SyncCursorSchema.path('feeFence').instance).toBe('Number');
  });
});

describe('the tokenId walk\'s cursor state (SyncService.SyncTokenIdCursorOps)', () => {
  it('start writes paging, cursor (a string) and the run start in ONE update', async () => {
    const model = recordingModel();
    await repo(model).saveBackfillTokenIdState(4663, 'uniswap-v4', { tokenIdCursor: '12345678901234567890123', runStartTs: 1_700_000_000.9 });
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]!.update).toEqual({
      $set: { backfillPaging: 'tokenid', backfillTokenIdCursor: '12345678901234567890123', backfillRunStartTs: 1_700_000_000 },
    });
    expect(model.calls[0]!.options).toEqual({ upsert: true });
  });

  it('advance moves only the cursor; clear unsets all three', async () => {
    const model = recordingModel();
    const r = repo(model);
    await r.saveBackfillTokenIdCursor(4663, 'uniswap-v4', '999');
    await r.clearBackfillTokenIdState(4663, 'uniswap-v4');
    expect(model.calls[0]!.update).toEqual({ $set: { backfillTokenIdCursor: '999' } });
    expect(model.calls[1]!.update).toEqual({ $unset: { backfillPaging: '', backfillTokenIdCursor: '', backfillRunStartTs: '' } });
  });
});

describe('lastCleanRefreshAt (the P2.3 read overlay)', () => {
  it('is read once per shard per 30 s; a set is visible at once', async () => {
    let stored: Date | undefined = new Date('2026-10-04T10:00:00Z');
    const model = recordingModel({ findOne: () => (stored ? { lastCleanRefreshAt: stored } : null) });
    const r = repo(model);
    const t0 = 1_000_000;
    expect(await r.lastCleanRefreshAt(1, 'uniswap-v4', t0)).toEqual(stored);
    stored = new Date('2026-10-04T11:00:00Z');
    // Within the cache window: the cached value, no second read.
    expect(await r.lastCleanRefreshAt(1, 'uniswap-v4', t0 + LAST_CLEAN_REFRESH_CACHE_MS - 1)).toEqual(new Date('2026-10-04T10:00:00Z'));
    expect(model.findOne).toHaveBeenCalledTimes(1);
    // Past it: read again.
    expect(await r.lastCleanRefreshAt(1, 'uniswap-v4', t0 + LAST_CLEAN_REFRESH_CACHE_MS)).toEqual(stored);
    expect(model.findOne).toHaveBeenCalledTimes(2);
    // A set (SyncService, the refresh's START) updates the cache.
    const at = new Date('2026-10-04T12:00:00Z');
    await r.setLastCleanRefreshAt(1, 'uniswap-v4', at);
    expect(model.calls.at(-1)!.update).toEqual({ $set: { lastCleanRefreshAt: at } });
    expect(await r.lastCleanRefreshAt(1, 'uniswap-v4')).toEqual(at);
  });

  it('a failed read answers the cached value (else undefined) and never throws', async () => {
    const model = recordingModel();
    model.findOne.mockImplementation(() => {
      throw new Error('down');
    });
    await expect(repo(model).lastCleanRefreshAt(1, 'uniswap-v4')).resolves.toBeUndefined();
  });
});

describe('lastRefreshOkAt (the P2.4 refresh-overdue watch)', () => {
  it('set: one upsert of the one field', async () => {
    const model = recordingModel();
    const at = new Date('2026-10-04T12:00:00Z');
    await repo(model).setLastRefreshOkAt(4663, 'uniswap-v4', at);
    expect(model.calls).toEqual([{ filter: { chainId: 4663, protocol: 'uniswap-v4' }, update: { $set: { lastRefreshOkAt: at } }, options: { upsert: true } }]);
  });

  it('read: every shard in ONE query, keyed chainId:protocol; rows without a Date are skipped', async () => {
    const a = new Date('2026-10-04T10:00:00Z');
    const b = new Date('2026-10-04T11:00:00Z');
    const model = recordingModel({
      find: () => [
        { chainId: 1, protocol: 'uniswap-v4', lastRefreshOkAt: a },
        { chainId: 4663, protocol: 'uniswap-v4', lastRefreshOkAt: b },
        { chainId: 42161, protocol: 'uniswap-v4', lastRefreshOkAt: 'garbage' },
      ],
    });
    const times = await repo(model).lastRefreshOkTimes();
    expect(model.find).toHaveBeenCalledTimes(1);
    expect(model.find.mock.calls[0]![0]).toEqual({ lastRefreshOkAt: { $exists: true } });
    expect([...times.entries()]).toEqual([
      ['1:uniswap-v4', a],
      ['4663:uniswap-v4', b],
    ]);
  });

  it('a failed read throws (the watch then gives no verdict rather than a false alarm)', async () => {
    const model = recordingModel();
    model.find.mockImplementation(() => {
      throw new Error('down');
    });
    await expect(repo(model).lastRefreshOkTimes()).rejects.toThrow('down');
  });
});

describe('run heartbeat / reaper — role gate (design §2.2: all + sync only)', () => {
  it.each([
    ['all', true],
    ['sync', true],
    ['api', false],
    ['fee', false],
    ['feeder', false],
  ] as const)('role %s → timers started: %s', (role, started) => {
    configureProcessRole({ processRole: role });
    vi.useFakeTimers();
    const r = repo(recordingModel());
    r.onModuleInit();
    expect(vi.getTimerCount() > 0).toBe(started);
    r.onModuleDestroy();
  });
});

const MONGO = process.env.P2P3_TEST_MONGO_URI;

describe.skipIf(!MONGO)('saveFeeCursor fence on a REAL MongoDB (opt-in contract)', () => {
  let conn: mongoose.Connection;
  let model: mongoose.Model<unknown>;

  beforeAll(async () => {
    conn = await mongoose.createConnection(MONGO!).asPromise();
    model = conn.model('SyncCursorFenceContract', SyncCursorSchema, 'sync_cursors_fence_contract') as unknown as mongoose.Model<unknown>;
    await model.deleteMany({});
    await model.createIndexes();
  });
  beforeEach(async () => {
    await model.deleteMany({});
  });
  afterAll(async () => {
    await model?.collection.drop().catch(() => undefined);
    await conn?.close();
  });

  it('first holder creates the row with its fence; a higher fence writes and raises it; a LOWER one is refused (E11000 → false) and changes nothing', async () => {
    const r = repo(model);
    expect(await r.saveFeeCursor(1, 'uniswap-v4', 'all', { cursor: '10' }, undefined, 3)).toBe(true);
    expect(await model.findOne({ chainId: 1 }).lean()).toMatchObject({ feeCursorAll: '10', feeFence: 3 });
    expect(await r.saveFeeCursor(1, 'uniswap-v4', 'all', { cursor: '20' }, undefined, 3)).toBe(true); // same holder again
    expect(await r.saveFeeCursor(1, 'uniswap-v4', 'all', { cursor: '30' }, undefined, 5)).toBe(true); // new holder
    expect(await model.findOne({ chainId: 1 }).lean()).toMatchObject({ feeCursorAll: '30', feeFence: 5 });
    // The deposed holder (fence 3) tries again: refused, nothing written.
    expect(await r.saveFeeCursor(1, 'uniswap-v4', 'all', { cursor: '999' }, tally, 3)).toBe(false);
    const row = (await model.findOne({ chainId: 1 }).lean()) as Record<string, unknown>;
    expect(row).toMatchObject({ feeCursorAll: '30', feeFence: 5 });
    expect(row.feeAllTally).toBeUndefined();
    expect(await model.countDocuments({})).toBe(1);
  });

  it('an unfenced write (leases off / fail-open local) still writes over a fenced row, and leaves the fence', async () => {
    const r = repo(model);
    await r.saveFeeCursor(1, 'uniswap-v4', 'all', { cursor: '10' }, undefined, 9);
    expect(await r.saveFeeCursor(1, 'uniswap-v4', 'all', { cursor: '11' })).toBe(true);
    expect(await model.findOne({ chainId: 1 }).lean()).toMatchObject({ feeCursorAll: '11', feeFence: 9 });
  });

  it('a row written before fences existed (no feeFence) accepts the first fenced holder', async () => {
    await model.collection.insertOne({ chainId: 1, protocol: 'uniswap-v4', feeCursorAll: 'legacy' });
    expect(await repo(model).saveFeeCursor(1, 'uniswap-v4', 'all', { cursor: 'next' }, undefined, 1)).toBe(true);
    expect(await model.findOne({ chainId: 1 }).lean()).toMatchObject({ feeCursorAll: 'next', feeFence: 1 });
  });

  it('the tokenId state round-trips through getCursor (strict mode keeps every declared field; a uint256 cursor stays exact)', async () => {
    const r = repo(model);
    const huge = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
    await r.saveBackfillTokenIdState(4663, 'uniswap-v4', { tokenIdCursor: huge, runStartTs: 1_700_000_000 });
    const got = (await r.getCursor(4663, 'uniswap-v4')) as unknown as Record<string, unknown>;
    expect(got).toMatchObject({ backfillPaging: 'tokenid', backfillTokenIdCursor: huge, backfillRunStartTs: 1_700_000_000 });
    await r.clearBackfillTokenIdState(4663, 'uniswap-v4');
    const cleared = (await r.getCursor(4663, 'uniswap-v4')) as unknown as Record<string, unknown>;
    expect(cleared.backfillPaging).toBeUndefined();
    expect(cleared.backfillTokenIdCursor).toBeUndefined();
  });
});
