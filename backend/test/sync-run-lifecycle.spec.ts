/*
 * `sync_runs` rows can no longer stay `running` forever. A live process stamps
 * its open runs every 2 min and closes them as `interrupted` when it shuts
 * down; a process that dies without shutting down (SIGKILL, crash, OOM) leaves
 * rows whose stamp goes quiet, and the reaper marks those `interrupted` after
 * 10 min. On the M10 rig six rows sat at `running` after four quick restarts.
 */
import { Types } from 'mongoose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { beginShutdown, resetShutdownForTests } from '../src/common/shutdown.js';
import {
  RUN_HEARTBEAT_INTERVAL_MS,
  RUN_STALE_MS,
  SyncRepository,
} from '../src/database/sync.repository.js';
import { matches, type Doc } from './support/mini-mongo.js';

afterEach(() => {
  resetShutdownForTests();
  vi.useRealTimers();
});

const MIN = 60_000;
const NOW = new Date('2026-10-03T14:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);

/** An in-memory `sync_runs` with the three calls the repository makes. */
function runStore(rows: Doc[] = []) {
  const select = (filter: Doc) => {
    const { _id, ...rest } = filter as { _id?: { $in?: unknown[] } } & Doc;
    const ids = _id?.$in?.map(String);
    return rows.filter((row) => (!ids || ids.includes(String(row._id))) && matches(row, rest, false));
  };
  const model = {
    create: vi.fn(async (doc: Doc) => {
      const row = { _id: new Types.ObjectId(), ...doc };
      rows.push(row);
      return row;
    }),
    findByIdAndUpdate: vi.fn(async (id: string, update: { $set: Doc }) => {
      const row = rows.find((r) => String(r._id) === String(id));
      if (row) Object.assign(row, update.$set);
      return row ?? null;
    }),
    updateMany: vi.fn(async (filter: Doc, update: { $set: Doc }) => {
      const hit = select(filter);
      for (const row of hit) Object.assign(row, update.$set);
      return { modifiedCount: hit.length };
    }),
  };
  return { rows, model };
}

function repo(runModel: unknown, cursorModel: unknown = { updateOne: vi.fn(async () => ({})) }) {
  return new SyncRepository(cursorModel as never, runModel as never);
}

describe('open runs: heartbeat and shutdown', () => {
  it('a new run is stamped at start, beaten while open, and left alone once finished', async () => {
    const store = runStore([
      // another process's live run — never touched by this process
      { _id: new Types.ObjectId(), chainId: 1, status: 'running', startedAt: ago(5 * MIN), heartbeatAt: ago(1 * MIN) },
    ]);
    const r = repo(store.model);
    const id = await r.startRun(4663, 'uniswap-v4');
    const mine = store.rows.find((row) => String(row._id) === id)!;
    expect(mine.status).toBe('running');
    expect(mine.heartbeatAt).toEqual(mine.startedAt);

    expect(await r.beatOpenRuns(NOW)).toBe(1);
    expect(mine.heartbeatAt).toEqual(NOW);
    expect(store.rows[0]!.heartbeatAt).toEqual(ago(1 * MIN));

    await r.finishRun(id, { status: 'success', durationMs: 5 });
    expect(mine.status).toBe('success');
    expect(await r.beatOpenRuns(new Date(NOW.getTime() + MIN))).toBe(0);
  });

  it('shutdown closes THIS process\'s open runs as interrupted — never another process\'s, never a finished one', async () => {
    const other = { _id: new Types.ObjectId(), status: 'running', startedAt: ago(MIN), heartbeatAt: ago(MIN) };
    const store = runStore([other]);
    const r = repo(store.model);
    const open = await r.startRun(1, 'uniswap-v4');
    const done = await r.startRun(42161, 'uniswap-v4');
    await r.finishRun(done, { status: 'partial', durationMs: 1 });

    await r.beforeApplicationShutdown();

    const byId = (id: string) => store.rows.find((row) => String(row._id) === id)!;
    expect(byId(open)).toMatchObject({ status: 'interrupted' });
    expect(String(byId(open).error)).toMatch(/process stopped mid-run/);
    expect(byId(open).finishedAt).toBeInstanceOf(Date);
    expect(byId(done).status).toBe('partial');
    expect(other.status).toBe('running');
    // closed runs leave the open set: a second close finds nothing
    expect(await r.closeOpenRuns('again')).toBe(0);
  });

  it('a shutdown that cannot reach Mongo is logged, never thrown (it must not stop the rest of the shutdown)', async () => {
    const store = runStore();
    const r = repo({ ...store.model, updateMany: vi.fn(async () => Promise.reject(new Error('client closed'))) });
    await r.startRun(1, 'uniswap-v4');
    await expect(r.beforeApplicationShutdown()).resolves.toBeUndefined();
  });

  it('a run that FAILS while the process is stopping is recorded interrupted; a success stays a success', async () => {
    const store = runStore();
    const r = repo(store.model);
    const a = await r.startRun(1, 'uniswap-v4');
    const b = await r.startRun(1, 'uniswap-v4');
    const c = await r.startRun(1, 'uniswap-v4');
    await r.finishRun(a, { status: 'failed', durationMs: 1, error: 'boom' });
    beginShutdown('SIGTERM');
    await r.finishRun(b, { status: 'failed', durationMs: 1, error: 'client was closed' });
    await r.finishRun(c, { status: 'success', durationMs: 1 });
    const status = (id: string) => store.rows.find((row) => String(row._id) === id)!.status;
    expect(status(a)).toBe('failed');
    expect(status(b)).toBe('interrupted');
    expect(status(c)).toBe('success');
  });

  it('a shutdown-caused failure does not become the cursor\'s last error', async () => {
    const cursorModel = { updateOne: vi.fn(async () => ({})) };
    const r = repo(runStore().model, cursorModel);
    await r.markCursorFailure(1, 'uniswap-v4', 'indexer 502');
    expect(cursorModel.updateOne).toHaveBeenCalledTimes(1);
    beginShutdown('SIGTERM');
    await r.markCursorFailure(1, 'uniswap-v4', 'client was closed');
    expect(cursorModel.updateOne).toHaveBeenCalledTimes(1);
  });
});

describe('the reaper', () => {
  it('marks interrupted exactly the running rows whose heartbeat (or, lacking one, whose start) is older than 10 min', async () => {
    const row = (name: string, extra: Doc): Doc => ({ _id: new Types.ObjectId(), name, chainId: 4663, ...extra });
    const store = runStore([
      row('legacy-dead', { status: 'running', startedAt: ago(120 * MIN) }), // pre-heartbeat code, long gone
      row('live-backfill', { status: 'running', startedAt: ago(16 * 60 * MIN), heartbeatAt: ago(1 * MIN) }),
      row('quiet', { status: 'running', startedAt: ago(60 * MIN), heartbeatAt: ago(11 * MIN) }),
      row('just-quiet-enough', { status: 'running', startedAt: ago(60 * MIN), heartbeatAt: ago(RUN_STALE_MS - 1) }),
      row('legacy-fresh', { status: 'running', startedAt: ago(5 * MIN) }), // old code mid-deploy, still young
      row('finished', { status: 'success', startedAt: ago(120 * MIN), heartbeatAt: ago(120 * MIN) }),
      row('ancient', { status: 'running', startedAt: ago(40 * 24 * 60 * MIN) }), // beyond the 30-day look-back
    ]);
    const reaped = await repo(store.model).reapStaleRuns(NOW);
    const status = Object.fromEntries(store.rows.map((r) => [r.name, r.status]));
    expect(status).toEqual({
      'legacy-dead': 'interrupted',
      'live-backfill': 'running',
      quiet: 'interrupted',
      'just-quiet-enough': 'running',
      'legacy-fresh': 'running',
      finished: 'success',
      ancient: 'running',
    });
    expect(reaped).toBe(2);
    const dead = store.rows.find((r) => r.name === 'legacy-dead')!;
    expect(dead.finishedAt).toEqual(NOW);
    expect(String(dead.error)).toMatch(/no heartbeat for 10 min/);
  });

  it('a run the reaper closed by mistake is corrected by its own finish', async () => {
    const store = runStore();
    const r = repo(store.model);
    const id = await r.startRun(1, 'uniswap-v4');
    const mine = store.rows[0]!;
    mine.heartbeatAt = ago(30 * MIN); // e.g. Mongo unreachable from this process for a while
    mine.startedAt = ago(30 * MIN);
    await r.reapStaleRuns(NOW);
    expect(mine.status).toBe('interrupted');
    await r.finishRun(id, { status: 'success', durationMs: 1 });
    expect(mine.status).toBe('success');
  });
});

describe('the timers', () => {
  it('reaps once shortly after boot, beats every 2 min, reaps every 5th beat, and stops on destroy', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const store = runStore();
    const r = repo(store.model);
    const beat = vi.spyOn(r, 'beatOpenRuns');
    const reap = vi.spyOn(r, 'reapStaleRuns');
    r.onModuleInit();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(reap).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS * 5 - 30_000);
    expect(beat).toHaveBeenCalledTimes(5);
    expect(reap).toHaveBeenCalledTimes(2);

    r.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(RUN_HEARTBEAT_INTERVAL_MS * 10);
    expect(beat).toHaveBeenCalledTimes(5);
  });
});
