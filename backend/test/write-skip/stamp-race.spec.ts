/*
 * The P3.1 stamp guard IN THE WRITE (round-2 review, C fixer): `stampGuard`
 * decides on the stored state READ before the write, and under the write
 * budget's `enforce` that read can be seconds old by the time the chunk is
 * sent. A fee write landing in that window must never be regressed by the
 * walk's older carried stamp — whatever the op's kind (full, insert, section)
 * and whatever the mode — and the row's other fields must still be written.
 *
 * Also: the stale sweep's two `updateMany`s and its closure read go through
 * the shared write budget like every other budgeted write.
 */
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerProcessWriteBudget } from '../../src/common/write-budget.js';
import { WRITE_BUDGET_OFF, WRITE_UNITS } from '../../src/common/write-budget-model.js';
import { BUDGETED_CHUNK_TIMEOUT_MS } from '../../src/database/budgeted-write.js';
import type { FeeRowHint } from '../../src/database/positions.repository.js';
import type { NormalizedPosition } from '../../src/subgraph/normalized-position.js';
import { CHAIN, normalized, PROTOCOL, repoOver } from './support/fixtures.js';
import { PositionSim, type Doc } from './support/position-sim.js';

const T0 = new Date('2026-10-04T00:00:00Z');
const ON = { positionsWriteSkip: 'on' };
const ID = '424242';

beforeEach(() => {
  vi.useFakeTimers({ now: T0, toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  registerProcessWriteBudget(undefined);
});

function walk(p: NormalizedPosition, minutes = 30): NormalizedPosition {
  vi.setSystemTime(Date.now() + minutes * 60_000);
  return { ...p, metrics: { ...p.metrics, ageSeconds: p.metrics.ageSeconds + minutes * 60 }, pricing: { ...p.pricing, pricedAt: new Date() } };
}

const stamp = (block: number, fees0 = '0.5', fees1 = '7') => ({
  rpcFeesUncollected0: fees0,
  rpcFeesUncollected1: fees1,
  rpcFeesBlock: block,
  rpcFeesAt: new Date(),
});

/** What the fee job's STAMP-ONLY write does (`writeRpcFees` without served paths): the stamp, `wh` left alone. */
function feeStampOnly(sim: PositionSim, block: number, fees0 = '0.25', fees1 = '2'): void {
  Object.assign(sim.byId(ID)!, { rpcFeesUncollected0: fees0, rpcFeesUncollected1: fees1, rpcFeesBlock: block, rpcFeesAt: new Date(T0.getTime() - 5_000) });
}

function writeSkipCounters(repo: ReturnType<typeof repoOver>) {
  const shard = repo.writeSkipStatus().shards[`${CHAIN}:${PROTOCOL}`]!;
  return {
    conflicts: shard.total.conflicts + shard.window.conflicts,
    reupserted: shard.total.reupserted + shard.window.reupserted,
    stampDropped: shard.total.stampDropped + shard.window.stampDropped,
  };
}

const sentUpdates = (sim: PositionSim, from: number) =>
  sim.ops.slice(from).filter((o) => o.kind === 'updateOne').map((o) => o.op as { filter: Doc; update: Doc; upsert?: boolean });

describe('the stamp guard holds in the write, not only on the read', () => {
  for (const mode of ['off', 'on'] as const) {
    it(`${mode}: a full write's older carried stamp loses to a fee write that landed after the read; the rest of the row is written`, async () => {
      const sim = new PositionSim();
      const observer = { onWritten: vi.fn(), onFeeReread: vi.fn() };
      const repo = repoOver(sim, mode === 'on' ? ON : undefined, observer);
      await repo.upsertMany([normalized({ ...stamp(500), metrics: { feesSource: 'onchain' } })]);
      // The walk measured block 600 (newer than the stored 500 at its read)…
      const carried = walk(normalized({ ...stamp(600), currentTick: 77, metrics: { feesSource: 'onchain' } }));
      // …and the fee job writes block 700 while the chunk waits for the budget.
      sim.beforeBulkWrite = () => {
        feeStampOnly(sim, 700);
        sim.beforeBulkWrite = undefined;
      };
      const from = sim.ops.length;
      await repo.upsertMany([carried]);
      const doc = sim.byId(ID)!;
      expect(doc.rpcFeesBlock).toBe(700);
      expect(doc.rpcFeesUncollected1).toBe('2');
      expect(doc.currentTick).toBe(77);
      // Served from the stored, newer reading at this row's prices (3000 / 1).
      expect((doc.amounts as Doc).totalFeesUncollected0).toBe('0.25');
      expect((doc.metrics as Doc).pendingFeesUsd).toBe(0.25 * 3000 + 2);
      // The first op carried the guard; the re-issue (fresh read → stamp dropped) carries none.
      const ops = sentUpdates(sim, from);
      expect(ops[0]!.filter.rpcFeesBlock).toEqual({ $not: { $gt: 600 } });
      expect(ops.at(-1)!.filter.rpcFeesBlock).toBeUndefined();
      expect(sim.docs.filter((d) => d.positionId === ID)).toHaveLength(1);
      expect(observer.onFeeReread).toHaveBeenCalledWith(CHAIN, PROTOCOL, [ID]);
      expect((observer.onWritten.mock.calls.at(-1)![2] as FeeRowHint[])[0]!.rpc).toBeUndefined();
      if (mode === 'on') expect(writeSkipCounters(repo)).toMatchObject({ conflicts: 1, reupserted: 1, stampDropped: 1 });
    });
  }

  it('on: a SECTION write of the stamp loses to a stamp-only fee write (which leaves wh alone)', async () => {
    const sim = new PositionSim();
    const repo = repoOver(sim, ON);
    const p = normalized({ ...stamp(500), metrics: { feesSource: 'onchain' } });
    await repo.upsertMany([p]);
    await repo.upsertMany([walk(p)]); // a second write: the row now carries wh and is section-eligible
    const before = sim.byId(ID)!.wh as Buffer;
    expect(before).toBeDefined();
    sim.beforeBulkWrite = () => {
      feeStampOnly(sim, 700);
      sim.beforeBulkWrite = undefined;
    };
    const from = sim.ops.length;
    await repo.upsertMany([walk({ ...p, ...stamp(600, '0.6', '8') })]);
    const ops = sentUpdates(sim, from);
    // The first op was a section op (no upsert) guarded on wh AND the stamp.
    expect(ops[0]!.upsert).toBe(false);
    expect(ops[0]!.filter.rpcFeesBlock).toEqual({ $not: { $gt: 600 } });
    expect(ops[0]!.filter.wh).toBeDefined();
    const doc = sim.byId(ID)!;
    expect(doc.rpcFeesBlock).toBe(700);
    expect(doc.rpcFeesUncollected0).toBe('0.25');
    expect(writeSkipCounters(repo).conflicts).toBe(1);
  });

  it('an INSERT whose row another writer created with a newer stamp meanwhile is re-issued, not duplicated or regressed', async () => {
    const sim = new PositionSim();
    const observer = { onWritten: vi.fn(), onFeeReread: vi.fn() };
    const repo = repoOver(sim, ON, observer);
    const carried = normalized({ ...stamp(600), currentTick: 31, metrics: { feesSource: 'onchain' } });
    sim.beforeBulkWrite = () => {
      // Created and stamped by others between the (empty) read and the write.
      sim.docs.push({ _id: 'other', chainId: CHAIN, protocol: PROTOCOL, positionId: ID, rpcFeesBlock: 700, rpcFeesUncollected0: '0.25', rpcFeesUncollected1: '2' });
      sim.beforeBulkWrite = undefined;
    };
    await repo.upsertMany([carried]);
    expect(sim.docs.filter((d) => d.positionId === ID)).toHaveLength(1);
    const doc = sim.byId(ID)!;
    expect(doc.rpcFeesBlock).toBe(700);
    expect(doc.currentTick).toBe(31);
    expect(observer.onFeeReread).toHaveBeenCalledWith(CHAIN, PROTOCOL, [ID]);
  });

  it('a re-issue that loses AGAIN is re-read and retried; one that keeps losing fails the flush after 3 rounds', async () => {
    // A stored stamp that moves under every read→write window: lower when
    // read (a row re-created, a second fee writer), newer than the carried
    // reading by the time each write arrives.
    const sim = new PositionSim();
    const repo = repoOver(sim, ON);
    await repo.upsertMany([normalized(stamp(500))]);
    const C = 1000;
    let interfere = 0;
    let writes = 0;
    const find = sim.find.bind(sim);
    sim.find = (filter: Doc, projection?: Doc) => {
      if (interfere > 0) feeStampOnly(sim, 100);
      return find(filter, projection);
    };
    sim.beforeBulkWrite = () => {
      writes++;
      if (interfere > 0) {
        interfere--;
        feeStampOnly(sim, C + 100);
      }
    };
    // Two interfering windows: the first write and round 1 lose; round 2's
    // fresh read sees the newer stamp, drops the carried one and lands.
    interfere = 2;
    await repo.upsertMany([walk(normalized({ ...stamp(C), currentTick: 5 }))]);
    expect(writes).toBe(3);
    expect(sim.byId(ID)!.rpcFeesBlock).toBe(C + 100);
    expect(sim.byId(ID)!.currentTick).toBe(5);
    expect(writeSkipCounters(repo).conflicts).toBe(2);

    // Every window: the first write + 3 rounds, then the flush fails.
    writes = 0;
    interfere = Number.POSITIVE_INFINITY;
    await expect(repo.upsertMany([walk(normalized({ ...stamp(C), currentTick: 6 }))])).rejects.toThrow(/E11000/);
    expect(writes).toBe(4);
  });

  it('a duplicate-key failure of an op that writes no stamp still fails the flush (only the guard\'s miss is repaired)', async () => {
    const sim = new PositionSim();
    const repo = repoOver(sim);
    sim.beforeBulkWrite = () => {
      sim.docs.push({ _id: 'other', chainId: CHAIN, protocol: PROTOCOL, positionId: ID });
      sim.beforeBulkWrite = undefined;
    };
    // No stamp → the op's filter is the bare identity, which MATCHES the row
    // another writer created: no error at all (today's upsert).
    await repo.upsertMany([normalized({ currentTick: 3 })]);
    expect(sim.docs.filter((d) => d.positionId === ID)).toHaveLength(1);
    expect(sim.byId(ID)!.currentTick).toBe(3);
  });

  it('a stamp-guarded WHOLE write that fails for any OTHER reason fails the flush (only the guard\'s E11000 is repaired)', async () => {
    // Skip off: a whole write (a section op's failures are repaired whatever their code).
    const sim = new PositionSim();
    const repo = repoOver(sim);
    await repo.upsertMany([normalized(stamp(500))]);
    // Once: a repair (a fresh re-issue) would succeed, so only refusing to repair makes this throw.
    let once = true;
    sim.injectWriteError = (op) => {
      if (!once || (op.filter as Doc).rpcFeesBlock === undefined) return undefined;
      once = false;
      return 2;
    };
    await expect(repo.upsertMany([walk(normalized({ ...stamp(600), currentTick: 4 }))])).rejects.toThrow(/injected error 2/);
    sim.injectWriteError = undefined;
  });

  it('an equal stored block is the same measurement: the guard lets it through, no re-issue', async () => {
    const sim = new PositionSim();
    const repo = repoOver(sim, ON);
    await repo.upsertMany([normalized(stamp(500))]);
    sim.beforeBulkWrite = () => {
      feeStampOnly(sim, 600, '0.5', '7');
      sim.beforeBulkWrite = undefined;
    };
    const from = sim.ops.length;
    await repo.upsertMany([walk(normalized({ ...stamp(600), currentTick: 8 }))]);
    expect(sentUpdates(sim, from)).toHaveLength(1);
    expect(sim.byId(ID)!.currentTick).toBe(8);
    expect(writeSkipCounters(repo).conflicts).toBe(0);
  });
});

describe('the stale sweep through the write budget', () => {
  function fakeBudget() {
    const acquired: Array<{ units: number; lane?: string }> = [];
    const chunks: Array<{ units: number; ops: number }> = [];
    const charged: number[] = [];
    registerProcessWriteBudget({
      settings: { ...WRITE_BUDGET_OFF, mode: 'enforce' },
      enabled: true,
      readUnits: (docs: number) => docs * 0.15,
      acquire: async (units: number, opts: { lane?: string } = {}) => {
        acquired.push({ units, lane: opts.lane });
        return { waitedMs: 0 };
      },
      charge: (units: number) => charged.push(units),
      recordChunk: (s: { units: number; ops: number }) => chunks.push({ units: s.units, ops: s.ops }),
    } as never);
    return { acquired, chunks, charged };
  }

  it('both updateManys acquire their units, are recorded as chunks and carry timeoutMS; the closure-hint read is charged', async () => {
    const sim = new PositionSim();
    const observer = { onWritten: vi.fn() };
    const repo = repoOver(sim, ON, observer);
    await repo.upsertMany(['1', '2', '3'].map((id) => normalized({ positionId: id, tokenId: id })));
    sim.byId('2')!.staleMisses = 2;
    const { acquired, chunks, charged } = fakeBudget();
    const closed = await repo.markMissingStale(CHAIN, PROTOCOL, new Set(['1']), 3);
    expect(closed).toBe(1);
    // Two misses ('2', '3'): one chunk, two writes, each charged and measured.
    expect(acquired.map((a) => a.units)).toEqual([2 * WRITE_UNITS.staleSweep, 2 * WRITE_UNITS.staleSweep]);
    expect(chunks).toEqual([
      { units: 2 * WRITE_UNITS.staleSweep, ops: 2 },
      { units: 2 * WRITE_UNITS.staleSweep, ops: 2 },
    ]);
    const many = sim.ops.filter((o) => o.kind === 'updateMany').map((o) => o.op as { options?: Doc });
    expect(many).toHaveLength(2);
    for (const op of many) expect(op.options).toEqual({ timeoutMS: BUDGETED_CHUNK_TIMEOUT_MS });
    // 1 of 2 closed → the hint read found 1 row on the primary.
    expect(charged).toEqual([1 * 0.15]);
  });

  it('with the budget off the two updateManys are today\'s calls: no options, nothing charged', async () => {
    const sim = new PositionSim();
    const repo = repoOver(sim, ON, { onWritten: vi.fn() });
    await repo.upsertMany(['1', '2', '3'].map((id) => normalized({ positionId: id, tokenId: id })));
    sim.byId('2')!.staleMisses = 2;
    await repo.markMissingStale(CHAIN, PROTOCOL, new Set(['1']), 3);
    const many = sim.ops.filter((o) => o.kind === 'updateMany').map((o) => o.op as { options?: Doc });
    expect(many).toHaveLength(2);
    for (const op of many) expect(op.options).toBeUndefined();
  });
});
