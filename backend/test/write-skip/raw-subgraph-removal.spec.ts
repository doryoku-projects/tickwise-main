/*
 * The raw indexer row is no longer stored on a position (2026-10-06): nothing
 * ever read it back, and it was ~0.7–0.8 KB of a ~3.1 KB document.
 *
 * Through the real `PositionsRepository` over the in-memory shard, whose every
 * update goes through Mongoose's own cast — so the strict-mode rule the removal
 * rests on (the `$unset` of an UNDECLARED path is silently dropped) is the real
 * one, not a model of it.
 */
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerProcessWriteBudget } from '../../src/common/write-budget.js';
import { sectionOfField } from '../../src/database/position-write-hash.js';
import { PositionSchema } from '../../src/database/schemas/position.schema.js';
import type { NormalizedPosition } from '../../src/subgraph/normalized-position.js';
import { normalized, repoOver } from './support/fixtures.js';
import { PositionSim, type Doc } from './support/position-sim.js';

const T0 = new Date('2026-10-06T00:00:00Z');
const ON = { positionsWriteSkip: 'on' };
const ID = '424242';

beforeEach(() => {
  vi.useFakeTimers({ now: T0, toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  registerProcessWriteBudget(undefined);
});

type Sent = { update: Doc & { $set?: Doc; $unset?: Doc }; upsert?: boolean };
const sentOps = (sim: PositionSim, from = 0) =>
  sim.ops.slice(from).filter((o) => o.kind === 'updateOne').map((o) => o.op as Sent);

/** The next walk, `minutes` later (the clock-driven fields move, nothing else). */
function walk(p: NormalizedPosition, minutes = 30): NormalizedPosition {
  vi.setSystemTime(Date.now() + minutes * 60_000);
  return {
    ...p,
    metrics: { ...p.metrics, ageSeconds: p.metrics.ageSeconds + minutes * 60 },
    pricing: { ...p.pricing, pricedAt: new Date() },
  };
}

/** A row as an older build left it: the raw indexer row still stored. */
function plantLegacyRaw(sim: PositionSim): void {
  sim.byId(ID)!.rawSubgraph = { id: `1_${ID}`, updatedAtBlock: '23000000', owner: '0xabc' };
}

describe('rawSubgraph is no longer stored on a position', () => {
  it('a new position is inserted without it, even when the caller object carries one', async () => {
    const sim = new PositionSim();
    const repo = repoOver(sim);
    const carrying = { ...normalized(), rawSubgraph: { id: `1_${ID}` } } as NormalizedPosition;
    await repo.upsertMany([carrying]);
    const [op] = sentOps(sim);
    expect(op!.upsert).toBe(true);
    expect(op!.update.$set).not.toHaveProperty('rawSubgraph');
    expect(sim.byId(ID)).toBeDefined();
    expect(sim.byId(ID)).not.toHaveProperty('rawSubgraph');
  });

  it('a stored row that still has one loses it on its next write (skip off: every write is a full write)', async () => {
    const sim = new PositionSim();
    const repo = repoOver(sim);
    const p = normalized();
    await repo.upsertMany([p]);
    plantLegacyRaw(sim);
    const before = sim.ops.length;
    await repo.upsertMany([walk(p)]);
    const [op] = sentOps(sim, before);
    // `$set` and `$unset` of one path in one update is a server error.
    expect(op!.update.$set).not.toHaveProperty('rawSubgraph');
    expect(op!.update.$unset).toMatchObject({ rawSubgraph: '' });
    expect(sim.byId(ID)).not.toHaveProperty('rawSubgraph');
    // Everything else on the row is what the write stored, as before.
    expect(sim.byId(ID)!.lastVerifiedAt).toEqual(new Date());
    expect(sim.byId(ID)!.owner).toBe(p.owner);
  });

  it('skip on: a section write leaves a legacy value alone, the next full write removes it', async () => {
    const sim = new PositionSim();
    const repo = repoOver(sim, ON);
    const p = normalized();
    await repo.upsertMany([p]);
    await repo.upsertMany([p]);
    plantLegacyRaw(sim);

    // A changed section only: leaves, no whole-row fields.
    let before = sim.ops.length;
    const moved = { ...walk(p), currentTick: 77 };
    await repo.upsertMany([moved]);
    const [section] = sentOps(sim, before);
    expect(section!.upsert).toBe(false);
    expect(section!.update.$set).not.toHaveProperty('lastVerifiedAt');
    expect(section!.update.$unset ?? {}).not.toHaveProperty('rawSubgraph');
    expect(sim.byId(ID)!.currentTick).toBe(77);
    expect(sim.byId(ID)).toHaveProperty('rawSubgraph');

    // A full write (here: the stored hash is gone) cleans it.
    delete sim.byId(ID)!.wh;
    before = sim.ops.length;
    await repo.upsertMany([walk(moved)]);
    const [full] = sentOps(sim, before);
    expect(full!.upsert).toBe(true);
    expect(full!.update.$set).toHaveProperty('lastVerifiedAt');
    expect(full!.update.$unset).toMatchObject({ rawSubgraph: '' });
    expect(sim.byId(ID)).not.toHaveProperty('rawSubgraph');
  });

  it('the schema still DECLARES the path, with no default — both are what the removal relies on', () => {
    const path = PositionSchema.path('rawSubgraph') as unknown as { defaultValue?: unknown } | undefined;
    // Declared: strict mode drops the `$unset` of an undeclared path, which
    // would leave the field on every stored row for good.
    expect(path).toBeDefined();
    // No default: an upsert that inserts must not put an empty object back.
    expect(path!.defaultValue).toBeUndefined();
    // Still a known, unhashed field: an object carrying one is not an
    // "unknown field" that forces a full write under write-skip.
    expect(sectionOfField('rawSubgraph')).toBe('unhashed');
  });
});
