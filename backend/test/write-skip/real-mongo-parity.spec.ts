/*
 * OPT-IN (`WRITE_SKIP_MONGO_URI=mongodb://…/db`): the parity sequences of
 * `parity.spec.ts`, against a REAL mongod through real Mongoose models — the
 * ground truth for the in-memory shard's cast + operator semantics (defaults
 * of a whole-subdoc `$set`, strict mode, code 28, `$type` projections, BinData
 * `wh`). Each run uses two fresh collections and drops them afterwards. Never
 * point it at a database that holds data you need.
 *
 *   WRITE_SKIP_MONGO_URI='mongodb://127.0.0.1:27017/write_skip_test?directConnection=true' \
 *     npx vitest run test/write-skip/real-mongo-parity.spec.ts
 */
import 'reflect-metadata';
import mongoose from 'mongoose';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PositionsRepository } from '../../src/database/positions.repository.js';
import { PositionSchema } from '../../src/database/schemas/position.schema.js';
import { CHAIN, normalized, PROTOCOL } from './support/fixtures.js';
import { comparable, type Doc } from './support/position-sim.js';
import { runParitySequence, T0 } from './support/sequence.js';

const URI = process.env.WRITE_SKIP_MONGO_URI;

describe.skipIf(!URI)('write-skip parity on a real mongod (opt-in)', () => {
  let conn: mongoose.Connection;
  const created: string[] = [];

  beforeAll(async () => {
    conn = await mongoose.createConnection(URI!).asPromise();
  });
  afterAll(async () => {
    for (const name of created) await conn.dropCollection(name).catch(() => undefined);
    await conn.close();
  });
  beforeEach(() => {
    vi.useFakeTimers({ now: T0, toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function shard(tag: string, config?: Record<string, unknown>) {
    const name = `ws_${tag}_${process.pid}_${created.length}`;
    created.push(name);
    const model = conn.model(name, PositionSchema.clone(), name);
    const repo = new PositionsRepository(
      { positionModel: () => model, hintUnusable: () => true } as never,
      {} as never,
      config as never,
    );
    (repo as unknown as { logger: unknown }).logger = { log: () => undefined, warn: () => undefined, debug: () => undefined, error: () => undefined };
    return {
      model,
      repo,
      byId: async (id: string) => (await model.collection.findOne({ positionId: id })) as Doc | null ?? undefined,
    };
  }

  for (const seed of [1, 2, 3]) {
    it(`random sequence ${seed}`, async () => {
      const off = shard('off');
      const on = shard('on', { positionsWriteSkip: 'on' });
      await runParitySequence(seed, 25, off, on, { timeJumps: true });
      // The section ops really matched on the server (their `wh` filter included):
      // no write was a silent conflict re-issue.
      const s = on.repo.writeSkipStatus().shards['1:uniswap-v4']!;
      expect(s.total.decisions.section + s.window.decisions.section).toBeGreaterThan(0);
      expect(s.total.conflicts + s.window.conflicts).toBe(0);
      expect(s.total.reupserted + s.window.reupserted).toBe(0);
    }, 60_000);
  }

  it('wh is stored as BinData(0, 64 B); a stored null subdocument is seen by the $type projection (legacy-shape full write)', async () => {
    const on = shard('code28', { positionsWriteSkip: 'on' });
    const p = normalized();
    await on.repo.upsertMany([p]);
    await on.repo.upsertMany([p]);
    const stored = (await on.model.collection.findOne({ positionId: '424242' })) as Doc;
    const wh = stored.wh as { sub_type?: number; position?: number };
    expect(wh.sub_type).toBe(0);
    expect(wh.position).toBe(64);
    // A legacy null section: the `$type` projection reports it, so the row is written whole up front
    // (the sim spec covers the code-28 fallback for a server that does not answer the projection).
    await on.model.collection.updateOne({ positionId: '424242' }, { $set: { poolStats: null } });
    vi.setSystemTime(Date.now() + 60_000);
    await on.repo.upsertMany([{ ...p, poolStats: { ...p.poolStats, tvlUsd: 5 } }]);
    const after = (await on.model.collection.findOne({ positionId: '424242' })) as Doc;
    expect((after.poolStats as Doc).tvlUsd).toBe(5);
    expect(comparable(after)).toMatchObject({ chainId: CHAIN, protocol: PROTOCOL });
  });

  it.each([
    ['off', undefined],
    ['on', { positionsWriteSkip: 'on' }],
  ] as const)('rawSubgraph is not stored (skip %s): an insert has none, a legacy value is removed by the next full write', async (tag, config) => {
    const s = shard(`raw_${tag}`, config);
    const p = normalized(); // the fixture's object still carries a `rawSubgraph`
    await s.repo.upsertMany([p]);
    expect(await s.model.collection.findOne({ positionId: '424242' })).not.toHaveProperty('rawSubgraph');

    // A row as an older build left it. The server refuses `$set` + `$unset` of one
    // path in one update (code 40), so this also proves the update never holds both.
    await s.model.collection.updateOne(
      { positionId: '424242' },
      { $set: { rawSubgraph: { id: '1_424242', updatedAtBlock: '23000000' } }, $unset: { wh: '' } },
    );
    vi.setSystemTime(Date.now() + 60_000);
    await s.repo.upsertMany([{ ...p, poolStats: { ...p.poolStats, tvlUsd: 7 } }]);
    const after = (await s.model.collection.findOne({ positionId: '424242' })) as Doc;
    expect(after).not.toHaveProperty('rawSubgraph');
    expect((after.poolStats as Doc).tvlUsd).toBe(7);
    expect(after.owner).toBe(p.owner);
  });
});
