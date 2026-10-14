/*
 * The backfill PAUSE lever, storage + admin side (audit C-pause):
 *  - `SyncRepository`: pause / resume are ONE atomic update each (the filter is
 *    the claim; a second pause keeps the first), the heartbeat returns the
 *    pause in the same round trip, only a real Date is a pause;
 *  - `POST /admin/sync/backfill/pause|resume` (x-admin-secret; one chain or
 *    all): validation, the stored note, resume re-enqueues only an interrupted
 *    walk;
 *  - `POST /admin/sync/run` refuses a paused chain (409, nothing enqueued —
 *    above all no fromStart reset) and `{all}` skips it; with nothing paused
 *    both are today's calls;
 *  - `POST /admin/ops/sync` (the admin panel's JWT route) answers a paused chain
 *    exactly like `sync/run` (review fix: it used to enqueue a job SyncService
 *    then refused silently, and `{all}` neither skipped nor named it);
 *  - `GET /admin/sync/status` lists paused chains.
 */
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { AdminController } from '../../src/admin/admin.controller.js';
import { AdminBillingController } from '../../src/billing/admin-billing.controller.js';
import { SyncRepository, pausedBackfillsOf, readPauseState } from '../../src/database/sync.repository.js';

const SECRET = 'test-admin-secret';
const ETH = { chainId: 1, protocol: 'uniswap-v4' };
const RH = { chainId: 4663, protocol: 'uniswap-v4' };

// ─── a sync_cursors collection with its unique {chainId, protocol} index ─────

type Row = Record<string, unknown>;

function cursors(initial: Row[] = []) {
  const rows: Row[] = initial.map((r) => ({ ...r }));
  const find = (f: Row) => rows.find((r) => r.chainId === f.chainId && r.protocol === f.protocol);
  const matches = (row: Row | undefined, f: Row): boolean => {
    if (!row) return false;
    const ex = (f.backfillPausedAt as { $exists?: boolean } | undefined)?.$exists;
    if (ex === undefined) return true;
    return ex ? row.backfillPausedAt !== undefined : row.backfillPausedAt === undefined;
  };
  const apply = (row: Row, u: { $set?: Row; $unset?: Row }) => {
    Object.assign(row, u.$set ?? {});
    for (const k of Object.keys(u.$unset ?? {})) delete row[k];
  };
  const model = {
    updateOne: vi.fn(async (f: Row, u: { $set?: Row; $unset?: Row }, o?: { upsert?: boolean }) => {
      const row = find(f);
      if (matches(row, f)) {
        apply(row!, u);
        return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
      }
      if (!o?.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      if (row) throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
      const created: Row = { chainId: f.chainId, protocol: f.protocol };
      apply(created, u);
      rows.push(created);
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
    }),
    findOneAndUpdate: vi.fn((f: Row, u: { $set?: Row }, o?: { upsert?: boolean; returnDocument?: string }) => ({
      select: () => ({
        lean: async () => {
          let row = find(f);
          if (!row && o?.upsert) rows.push((row = { chainId: f.chainId, protocol: f.protocol }));
          if (row) apply(row, u);
          return row ? { ...row } : null;
        },
      }),
    })),
    findOne: vi.fn((f: Row) => {
      const lean = async () => (find(f) ? { ...find(f) } : null);
      return { lean, select: () => ({ lean }) };
    }),
    find: vi.fn((f: Row) => ({
      select: () => ({ lean: async () => rows.filter((r) => matches(r, f)).map((r) => ({ ...r })) }),
    })),
  };
  const repo = new SyncRepository(model as never, {} as never);
  return { repo, model, rows };
}

describe('SyncRepository — the pause fields', () => {
  it('pause: ONE update sets both fields; the filter only matches an unpaused row', async () => {
    const { repo, model, rows } = cursors([{ ...ETH, lastTimestamp: 900, backfillInProgress: true }]);
    const at = new Date('2026-10-04T10:00:00Z');
    await expect(repo.pauseBackfill(1, 'uniswap-v4', 'admin: rh first', at)).resolves.toEqual({
      pausedAt: at,
      pausedBy: 'admin: rh first',
      alreadyPaused: false,
    });
    expect(model.updateOne).toHaveBeenCalledTimes(1);
    expect(model.updateOne.mock.calls[0]![0]).toEqual({ ...ETH, backfillPausedAt: { $exists: false } });
    expect(Object.keys((model.updateOne.mock.calls[0]![1] as { $set: Row }).$set).sort()).toEqual(['backfillPausedAt', 'backfillPausedBy']);
    // nothing else on the cursor moved
    expect(rows[0]).toMatchObject({ lastTimestamp: 900, backfillInProgress: true, backfillPausedAt: at });
  });

  it('a second pause keeps the FIRST one (time and note): E11000 is the "already paused" answer', async () => {
    const first = new Date('2026-10-04T10:00:00Z');
    const { repo, rows } = cursors([{ ...ETH, backfillPausedAt: first, backfillPausedBy: 'admin: one' }]);
    await expect(repo.pauseBackfill(1, 'uniswap-v4', 'admin: two', new Date('2026-10-04T11:00:00Z'))).resolves.toEqual({
      pausedAt: first,
      pausedBy: 'admin: one',
      alreadyPaused: true,
    });
    expect(rows[0]).toMatchObject({ backfillPausedAt: first, backfillPausedBy: 'admin: one' });
  });

  it('pausing a chain with no cursor row creates one (paused before its first backfill)', async () => {
    const { repo, rows } = cursors();
    await repo.pauseBackfill(4663, 'uniswap-v4', 'admin');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ...RH, backfillPausedBy: 'admin' });
    expect(rows[0]!.backfillPausedAt).toBeInstanceOf(Date);
  });

  it('rethrows anything that is not the duplicate-key answer', async () => {
    const { repo, model } = cursors([ETH]);
    model.updateOne.mockRejectedValueOnce(Object.assign(new Error('not primary'), { code: 10107 }));
    await expect(repo.pauseBackfill(1, 'uniswap-v4', 'admin')).rejects.toThrow('not primary');
  });

  it('resume: ONE $unset of both fields; true only when it WAS paused', async () => {
    const { repo, model, rows } = cursors([{ ...ETH, lastTimestamp: 5, backfillPausedAt: new Date(), backfillPausedBy: 'admin' }]);
    await expect(repo.resumeBackfill(1, 'uniswap-v4')).resolves.toBe(true);
    expect(model.updateOne.mock.calls[0]![1]).toEqual({ $unset: { backfillPausedAt: '', backfillPausedBy: '' } });
    expect(rows[0]).toEqual({ ...ETH, lastTimestamp: 5 });
    await expect(repo.resumeBackfill(1, 'uniswap-v4')).resolves.toBe(false);
  });

  it('the heartbeat stamps ONLY backfillHeartbeatAt and returns the pause in the same call', async () => {
    const { repo, model, rows } = cursors([{ ...ETH, backfillInProgress: true }]);
    await expect(repo.heartbeatBackfillReadPause(1, 'uniswap-v4')).resolves.toBeNull();
    expect(model.findOneAndUpdate.mock.calls[0]![0]).toEqual(ETH);
    expect(Object.keys((model.findOneAndUpdate.mock.calls[0]![1] as { $set: Row }).$set)).toEqual(['backfillHeartbeatAt']);
    expect(model.findOneAndUpdate.mock.calls[0]![2]).toMatchObject({ upsert: true, returnDocument: 'after' });
    rows[0]!.backfillPausedAt = new Date('2026-10-04T10:00:00Z');
    rows[0]!.backfillPausedBy = 'admin: x';
    await expect(repo.heartbeatBackfillReadPause(1, 'uniswap-v4')).resolves.toMatchObject({ pausedBy: 'admin: x', inProgress: true });
  });

  it('only a real Date is a pause; pausedBackfillsOf keeps those, sorted', () => {
    expect(readPauseState(null)).toBeNull();
    expect(readPauseState({ backfillPausedAt: 'yesterday' })).toBeNull();
    expect(readPauseState({ backfillPausedAt: new Date('nope') })).toBeNull();
    expect(readPauseState({ backfillPausedAt: new Date(0) })).toMatchObject({ pausedBy: 'admin', inProgress: false });
    const at = new Date('2026-10-04T10:00:00Z');
    expect(
      pausedBackfillsOf([
        { ...RH, backfillPausedAt: at, backfillPausedBy: 'admin: b', backfillInProgress: true },
        { ...ETH, lastTimestamp: 1 },
        { ...ETH, protocol: 'uniswap-v3', backfillPausedAt: at },
        { ...ETH, backfillPausedAt: at },
        null,
      ]).map((p) => `${p.chainId}:${p.protocol}`),
    ).toEqual(['1:uniswap-v3', '1:uniswap-v4', '4663:uniswap-v4']);
  });
});

// ─── the admin routes ────────────────────────────────────────────────────────

function controller(opts: { rows?: Row[]; queues?: Record<string, unknown>; secret?: string } = {}) {
  const store = cursors(opts.rows ?? []);
  const queues = {
    enqueueBackfill: vi.fn(async (c: number, p: string) => `backfill-${c}-${p}`),
    enqueueBackfillAll: vi.fn(async () => [
      { ...ETH, jobId: 'a' },
      { ...RH, jobId: 'b' },
    ]),
    status: vi.fn(async () => ({})),
    ...opts.queues,
  };
  const syncRepo = Object.assign(store.repo, {
    status: async () => ({ cursors: store.rows.map((r) => ({ ...r })), latestRuns: [] }),
  });
  const c = new AdminController(
    { adminSecret: opts.secret ?? SECRET, enabledIntegrations: [ETH, RH] } as never,
    queues as never,
    syncRepo as never,
  );
  return { c, queues, rows: store.rows, model: store.model };
}

describe('POST /admin/sync/backfill/pause', () => {
  it('pauses one chain with the note; reports it; idempotent', async () => {
    const { c, rows } = controller({ rows: [{ ...RH, backfillInProgress: true }] });
    const res = await c.pauseBackfill(SECRET, { ...RH, note: '  full Robinhood: M10 at 90% ' });
    expect(res.paused).toEqual([
      expect.objectContaining({ ...RH, pausedBy: 'admin: full Robinhood: M10 at 90%', alreadyPaused: false }),
    ]);
    expect(rows.find((r) => r.chainId === 4663)).toMatchObject({ backfillPausedBy: 'admin: full Robinhood: M10 at 90%', backfillInProgress: true });
    const again = await c.pauseBackfill(SECRET, { ...RH });
    expect(again.paused[0]).toMatchObject({ alreadyPaused: true, pausedBy: 'admin: full Robinhood: M10 at 90%' });
  });

  it('all=true pauses every enabled integration', async () => {
    const { c, rows } = controller();
    const res = await c.pauseBackfill(SECRET, { all: true });
    expect(res.paused.map((p) => p.chainId)).toEqual([1, 4663]);
    expect(rows.every((r) => r.backfillPausedAt instanceof Date && r.backfillPausedBy === 'admin')).toBe(true);
  });

  it('400 without a target, 400 for an integration that is not enabled; 403 on a wrong secret — before any write', async () => {
    const { c, model } = controller();
    await expect(c.pauseBackfill(SECRET, {})).rejects.toBeInstanceOf(BadRequestException);
    await expect(c.pauseBackfill(SECRET, { chainId: 137, protocol: 'uniswap-v4' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(c.pauseBackfill('wrong', { all: true })).rejects.toBeInstanceOf(ForbiddenException);
    expect(model.updateOne).not.toHaveBeenCalled();
  });
});

describe('POST /admin/sync/backfill/resume', () => {
  it('lifts the pause and re-enqueues the interrupted walk from its cursor (fromStart=false)', async () => {
    const { c, queues, rows } = controller({
      rows: [{ ...RH, backfillInProgress: true, backfillPausedAt: new Date(), backfillPausedBy: 'admin' }],
    });
    const res = await c.resumeBackfill(SECRET, { ...RH });
    expect(res.resumed).toEqual([{ ...RH, wasPaused: true, jobId: 'backfill-4663-uniswap-v4' }]);
    expect(queues.enqueueBackfill).toHaveBeenCalledWith(4663, 'uniswap-v4', false);
    expect(rows[0]).not.toHaveProperty('backfillPausedAt');
  });

  it('no job for a chain with no interrupted walk, for a chain that was not paused, or with enqueue=false', async () => {
    const { c, queues } = controller({
      rows: [
        { ...ETH, backfillInProgress: false, backfillPausedAt: new Date() },
        { ...RH, backfillInProgress: true },
      ],
    });
    const res = await c.resumeBackfill(SECRET, { all: true });
    expect(res.resumed).toEqual([
      { ...ETH, wasPaused: true },
      { ...RH, wasPaused: false },
    ]);
    expect(queues.enqueueBackfill).not.toHaveBeenCalled();

    const { c: c2, queues: q2 } = controller({ rows: [{ ...RH, backfillInProgress: true, backfillPausedAt: new Date() }] });
    const res2 = await c2.resumeBackfill(SECRET, { ...RH, enqueue: false });
    expect(res2.resumed).toEqual([{ ...RH, wasPaused: true }]);
    expect(q2.enqueueBackfill).not.toHaveBeenCalled();
  });
});

describe('POST /admin/sync/run while paused', () => {
  it('one paused chain: 409 naming the pause, nothing enqueued (no fromStart reset can happen)', async () => {
    const { c, queues } = controller({ rows: [{ ...RH, backfillPausedAt: new Date('2026-10-04T10:00:00Z'), backfillPausedBy: 'admin: x' }] });
    const err = await c.runSync(SECRET, { ...RH, fromStart: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(JSON.stringify((err as ConflictException).getResponse())).toContain('PAUSED since 2026-10-04T10:00:00.000Z (admin: x)');
    expect(queues.enqueueBackfill).not.toHaveBeenCalled();
  });

  it('an unpaused chain enqueues as today', async () => {
    const { c, queues } = controller({ rows: [{ ...ETH, backfillPausedAt: new Date() }] });
    await expect(c.runSync(SECRET, { ...RH })).resolves.toEqual({ jobId: 'backfill-4663-uniswap-v4', ...RH, fromStart: false });
    expect(queues.enqueueBackfill).toHaveBeenCalledWith(4663, 'uniswap-v4', false);
  });

  it('all=true: nothing paused → today’s enqueueBackfillAll; one paused → skipped and named', async () => {
    const none = controller();
    await expect(none.c.runSync(SECRET, { all: true })).resolves.toEqual({ jobs: [{ ...ETH, jobId: 'a' }, { ...RH, jobId: 'b' }], fromStart: false });
    expect(none.queues.enqueueBackfillAll).toHaveBeenCalledWith(false);

    const one = controller({ rows: [{ ...RH, backfillPausedAt: new Date('2026-10-04T10:00:00Z'), backfillInProgress: true }] });
    const res = (await one.c.runSync(SECRET, { all: true, fromStart: true })) as Record<string, unknown>;
    expect(one.queues.enqueueBackfillAll).not.toHaveBeenCalled();
    expect(one.queues.enqueueBackfill).toHaveBeenCalledTimes(1);
    expect(one.queues.enqueueBackfill).toHaveBeenCalledWith(1, 'uniswap-v4', true);
    expect(res.jobs).toEqual([{ ...ETH, jobId: 'backfill-1-uniswap-v4' }]);
    expect(res.skippedPaused).toEqual([{ ...RH, pausedAt: '2026-10-04T10:00:00.000Z', pausedBy: 'admin', inProgress: true }]);
  });
});

describe('GET /admin/sync/status', () => {
  it('lists the paused chains (empty when none)', async () => {
    const none = (await controller({ rows: [ETH] }).c.syncStatus(SECRET)) as Record<string, unknown>;
    expect(none.backfillPaused).toEqual([]);
    const at = new Date('2026-10-04T10:00:00Z');
    const res = (await controller({ rows: [ETH, { ...RH, backfillPausedAt: at, backfillPausedBy: 'admin: y', backfillInProgress: true }] }).c.syncStatus(
      SECRET,
    )) as Record<string, unknown>;
    expect(res.backfillPaused).toEqual([{ ...RH, pausedAt: at.toISOString(), pausedBy: 'admin: y', inProgress: true }]);
  });
});

describe('POST /admin/ops/sync (admin panel, JWT) while paused — same answer as sync/run (review fix)', () => {
  function panel(rows: Row[] = [], opts: { repo?: boolean; config?: boolean } = {}) {
    const store = cursors(rows);
    const queues = {
      enqueueBackfill: vi.fn(async (c: number, p: string) => `backfill-${c}-${p}`),
      enqueueBackfillAll: vi.fn(async () => [
        { ...ETH, jobId: 'a' },
        { ...RH, jobId: 'b' },
      ]),
    };
    const c = new AdminBillingController(
      {} as never,
      {} as never,
      {} as never,
      queues as never,
      opts.repo === false ? undefined : (store.repo as never),
      opts.config === false ? undefined : ({ enabledIntegrations: [ETH, RH] } as never),
    );
    return { c, queues };
  }

  it('one paused chain: 409 naming the pause, nothing enqueued', async () => {
    const { c, queues } = panel([{ ...RH, backfillPausedAt: new Date('2026-10-04T10:00:00Z'), backfillPausedBy: 'admin: x' }]);
    const err = await c.runSync({ ...RH, fromStart: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(JSON.stringify((err as ConflictException).getResponse())).toContain('PAUSED since 2026-10-04T10:00:00.000Z (admin: x)');
    expect(queues.enqueueBackfill).not.toHaveBeenCalled();
  });

  it('an unpaused chain enqueues as today (chainId / protocol still default to 1 / uniswap-v4)', async () => {
    const { c, queues } = panel([{ ...RH, backfillPausedAt: new Date() }]);
    await expect(c.runSync({})).resolves.toEqual({ jobId: 'backfill-1-uniswap-v4', ...ETH, fromStart: false });
    expect(queues.enqueueBackfill).toHaveBeenCalledWith(1, 'uniswap-v4', false);
  });

  it('all=true: nothing paused → today’s enqueueBackfillAll; one paused → skipped and named', async () => {
    const none = panel();
    await expect(none.c.runSync({ all: true })).resolves.toEqual({ jobs: [{ ...ETH, jobId: 'a' }, { ...RH, jobId: 'b' }], fromStart: false });
    expect(none.queues.enqueueBackfillAll).toHaveBeenCalledWith(false);

    const one = panel([{ ...RH, backfillPausedAt: new Date('2026-10-04T10:00:00Z'), backfillInProgress: true }]);
    const res = (await one.c.runSync({ all: true, fromStart: true })) as Record<string, unknown>;
    expect(one.queues.enqueueBackfillAll).not.toHaveBeenCalled();
    expect(one.queues.enqueueBackfill).toHaveBeenCalledTimes(1);
    expect(one.queues.enqueueBackfill).toHaveBeenCalledWith(1, 'uniswap-v4', true);
    expect(res.jobs).toEqual([{ ...ETH, jobId: 'backfill-1-uniswap-v4' }]);
    expect(res.skippedPaused).toEqual([{ ...RH, pausedAt: '2026-10-04T10:00:00.000Z', pausedBy: 'admin', inProgress: true }]);
  });

  it('without the repository (positional construction) it is today’s route', async () => {
    const { c, queues } = panel([], { repo: false, config: false });
    await expect(c.runSync({ all: true })).resolves.toMatchObject({ fromStart: false });
    expect(queues.enqueueBackfillAll).toHaveBeenCalledWith(false);
    await expect(c.runSync({ ...RH })).resolves.toEqual({ jobId: 'backfill-4663-uniswap-v4', ...RH, fromStart: false });
  });
});
