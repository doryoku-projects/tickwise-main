/*
 * Backfill safety in `sync_cursors` (2026-10-03):
 *  - a `fromStart` reset happens ONCE per run key, so a BullMQ retry or a
 *    stalled re-run of the same job resumes from its cursor instead of
 *    restarting a 21 h walk;
 *  - the backfill flag counts as "in progress" only while its heartbeat is at
 *    most 10 min old, so a backfill a deploy killed stops suspending the stale
 *    sweep.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  BACKFILL_HEARTBEAT_STALE_MS,
  SyncRepository,
  backfillLooksAlive,
} from '../src/database/sync.repository.js';

type Cursor = Record<string, unknown>;

/** A `sync_cursors` collection with its unique {chainId, protocol} index. */
function cursors(initial?: Cursor) {
  let doc: Cursor | undefined = initial ? { ...initial } : undefined;
  const cursorModel = {
    updateOne: vi.fn(async (filter: Record<string, unknown>, update: { $set?: Cursor }, opts?: { upsert?: boolean }) => {
      const ne = (filter.backfillResetRunKey as { $ne?: string } | undefined)?.$ne;
      const matches = doc !== undefined && (ne === undefined || doc.backfillResetRunKey !== ne);
      if (matches) {
        doc = { ...doc, ...update.$set };
        return { matchedCount: 1, upsertedCount: 0 };
      }
      if (!opts?.upsert) return { matchedCount: 0, upsertedCount: 0 };
      if (doc !== undefined) {
        // The upsert's insert collides with the existing row on the unique index.
        throw Object.assign(new Error('E11000 duplicate key error collection: sync_cursors'), { code: 11000 });
      }
      doc = { chainId: filter.chainId, protocol: filter.protocol, ...update.$set };
      return { matchedCount: 0, upsertedCount: 1 };
    }),
    findOne: vi.fn(() => ({
      select: () => ({ lean: async () => (doc ? { ...doc } : null) }),
    })),
  };
  const repo = new SyncRepository(cursorModel as never, {} as never);
  return { repo, cursorModel, doc: () => doc };
}

describe('SyncRepository.resetCursorForRun — once per run', () => {
  const advanced = { chainId: 4663, protocol: 'uniswap-v4', lastTimestamp: 1_700_000_500, lastPositionId: '9000', lastBlockNumber: 77 };

  it('the first attempt of a run resets the cursor and claims the run', async () => {
    const { repo, doc } = cursors(advanced);
    await expect(repo.resetCursorForRun(4663, 'uniswap-v4', 'job-1')).resolves.toBe(true);
    expect(doc()).toMatchObject({ lastTimestamp: 0, lastPositionId: '', lastBlockNumber: 0, backfillResetRunKey: 'job-1' });
  });

  it('a retry of the SAME run resets nothing — it resumes from the cursor its flushes advanced', async () => {
    const { repo, doc } = cursors({ ...advanced, backfillResetRunKey: 'job-1' });
    await expect(repo.resetCursorForRun(4663, 'uniswap-v4', 'job-1')).resolves.toBe(false);
    expect(doc()).toMatchObject({ lastTimestamp: 1_700_000_500, lastPositionId: '9000', lastBlockNumber: 77 });
  });

  it('a NEW run resets again', async () => {
    const { repo, doc } = cursors({ ...advanced, backfillResetRunKey: 'job-1' });
    await expect(repo.resetCursorForRun(4663, 'uniswap-v4', 'job-2')).resolves.toBe(true);
    expect(doc()).toMatchObject({ lastTimestamp: 0, backfillResetRunKey: 'job-2' });
  });

  it('creates the cursor row when there is none', async () => {
    const { repo, doc } = cursors();
    await expect(repo.resetCursorForRun(4663, 'uniswap-v4', 'job-1')).resolves.toBe(true);
    expect(doc()).toMatchObject({ chainId: 4663, lastTimestamp: 0, backfillResetRunKey: 'job-1' });
  });

  it('rethrows anything that is not the duplicate-key answer', async () => {
    const { repo, cursorModel } = cursors(advanced);
    cursorModel.updateOne.mockRejectedValueOnce(Object.assign(new Error('not primary'), { code: 10107 }));
    await expect(repo.resetCursorForRun(4663, 'uniswap-v4', 'job-1')).rejects.toThrow('not primary');
  });
});

describe('backfill heartbeat', () => {
  const now = Date.parse('2026-10-03T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms);

  it('reads a flag with a fresh heartbeat as in progress, and a stale one as dead', () => {
    expect(BACKFILL_HEARTBEAT_STALE_MS).toBe(10 * 60_000);
    expect(backfillLooksAlive({ backfillInProgress: true, backfillHeartbeatAt: ago(5 * 60_000) }, now)).toBe(true);
    expect(backfillLooksAlive({ backfillInProgress: true, backfillHeartbeatAt: ago(BACKFILL_HEARTBEAT_STALE_MS) }, now)).toBe(true);
    expect(backfillLooksAlive({ backfillInProgress: true, backfillHeartbeatAt: ago(BACKFILL_HEARTBEAT_STALE_MS + 1) }, now)).toBe(false);
    expect(backfillLooksAlive({ backfillInProgress: true, backfillHeartbeatAt: ago(3 * 3_600_000) }, now)).toBe(false);
  });

  it('never reads an unset flag as in progress, however fresh the heartbeat', () => {
    expect(backfillLooksAlive({ backfillInProgress: false, backfillHeartbeatAt: ago(1_000) }, now)).toBe(false);
    expect(backfillLooksAlive(null, now)).toBe(false);
  });

  it('falls back to backfillStartedAt for a flag written before heartbeats existed; neither → dead', () => {
    expect(backfillLooksAlive({ backfillInProgress: true, backfillStartedAt: ago(60_000) }, now)).toBe(true);
    expect(backfillLooksAlive({ backfillInProgress: true, backfillStartedAt: ago(BACKFILL_HEARTBEAT_STALE_MS + 1) }, now)).toBe(false);
    expect(backfillLooksAlive({ backfillInProgress: true }, now)).toBe(false);
    // The heartbeat wins over an old start.
    expect(
      backfillLooksAlive(
        { backfillInProgress: true, backfillStartedAt: ago(20 * 3_600_000), backfillHeartbeatAt: ago(60_000) },
        now,
      ),
    ).toBe(true);
  });

  it('isBackfillInProgress applies it to the stored cursor', async () => {
    const live = cursors({ chainId: 1, protocol: 'uniswap-v4', backfillInProgress: true, backfillHeartbeatAt: ago(60_000) });
    expect(await live.repo.isBackfillInProgress(1, 'uniswap-v4', now)).toBe(true);
    const dead = cursors({ chainId: 1, protocol: 'uniswap-v4', backfillInProgress: true, backfillHeartbeatAt: ago(11 * 60_000) });
    expect(await dead.repo.isBackfillInProgress(1, 'uniswap-v4', now)).toBe(false);
  });

  it('markBackfillStarted stamps the first heartbeat with the start, and touchBackfillHeartbeat moves it', async () => {
    const { repo, cursorModel } = cursors({ chainId: 1, protocol: 'uniswap-v4' });
    await repo.markBackfillStarted(1, 'uniswap-v4');
    const started = cursorModel.updateOne.mock.calls[0]![1] as { $set: Cursor };
    expect(started.$set.backfillInProgress).toBe(true);
    expect(started.$set.backfillHeartbeatAt).toBeInstanceOf(Date);
    expect(started.$set.backfillHeartbeatAt).toEqual(started.$set.backfillStartedAt);

    await repo.touchBackfillHeartbeat(1, 'uniswap-v4');
    const beat = cursorModel.updateOne.mock.calls[1]!;
    expect(beat[0]).toEqual({ chainId: 1, protocol: 'uniswap-v4' });
    expect(Object.keys((beat[1] as { $set: Cursor }).$set)).toEqual(['backfillHeartbeatAt']);
  });
});

describe('SyncRepository pool-walk totals (/v1/stats reads them, 2026-10-03)', () => {
  it('recordPoolWalk $sets the four DECLARED fields, upserting the cursor row', async () => {
    const { repo, cursorModel } = cursors();
    const at = new Date('2026-10-03T10:00:00Z');
    await repo.recordPoolWalk(4663, 'uniswap-v4', { pools: 953_000, tvlUsd: 68e6, skipped: 3, finishedAt: at });
    expect(cursorModel.updateOne).toHaveBeenCalledWith(
      { chainId: 4663, protocol: 'uniswap-v4' },
      { $set: { poolWalkPools: 953_000, poolWalkTvlUsd: 68e6, poolWalkSkipped: 3, poolWalkFinishedAt: at } },
      { upsert: true },
    );
    // Strict mode drops an undeclared path: every one of them must be on the schema.
    const { SyncCursorSchema } = await import('../src/database/schemas/sync-cursor.schema.js');
    for (const path of ['poolWalkPools', 'poolWalkTvlUsd', 'poolWalkSkipped', 'poolWalkFinishedAt']) {
      expect(SyncCursorSchema.path(path), path).toBeDefined();
    }
  });

  it('poolWalkStats: per chainId:protocol, only rows with a complete, well-formed walk', async () => {
    const at = new Date('2026-10-03T10:00:00Z');
    const rows = [
      { chainId: 1, protocol: 'uniswap-v4', poolWalkPools: 133_000, poolWalkTvlUsd: 5e8, poolWalkSkipped: 0, poolWalkFinishedAt: at },
      { chainId: 4663, protocol: 'uniswap-v4', poolWalkPools: 'garbage', poolWalkTvlUsd: 1, poolWalkFinishedAt: at },
      { chainId: 42161, protocol: 'uniswap-v4', poolWalkPools: 10, poolWalkTvlUsd: 2 },
    ];
    let filter: unknown;
    const cursorModel = { find: (f: unknown) => ((filter = f), { select: () => ({ lean: async () => rows }) }) };
    const repo = new SyncRepository(cursorModel as never, {} as never);
    const stats = await repo.poolWalkStats();
    expect(filter).toEqual({ poolWalkFinishedAt: { $exists: true } });
    expect([...stats]).toEqual([['1:uniswap-v4', { pools: 133_000, tvlUsd: 5e8, skipped: 0, finishedAt: at }]]);
  });
});
