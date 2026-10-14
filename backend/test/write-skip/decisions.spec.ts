/*
 * P2.3 through the real `PositionsRepository` (design §4.2 / §4.4 / §7):
 * what each mode SENDS, row by row, over the in-memory shard.
 */
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerProcessWriteBudget } from '../../src/common/write-budget.js';
import { WRITE_BUDGET_OFF, WRITE_UNITS } from '../../src/common/write-budget-model.js';
import { encodeWh, forcedRewriteIntervalMs, SECTIONS, WRITE_SKIP_OFF } from '../../src/database/position-write-hash.js';
import {
  DETAIL_OVERLAY_PROJECTION,
  DETAIL_PROJECTION,
  LIST_OVERLAY_PROJECTION,
  LIST_PROJECTION,
  type FeeRowHint,
} from '../../src/database/positions.repository.js';
import type { NormalizedPosition } from '../../src/subgraph/normalized-position.js';
import { CHAIN, logsOf, normalized, PROTOCOL, repoOver } from './support/fixtures.js';
import { PositionSim, type Doc } from './support/position-sim.js';

const T0 = new Date('2026-10-04T00:00:00Z');
const ON = { positionsWriteSkip: 'on' };

beforeEach(() => {
  vi.useFakeTimers({ now: T0, toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
  registerProcessWriteBudget(undefined);
});

/** A shard's counters, closed windows and the open one together. */
function counters(repo: ReturnType<typeof repoOver>) {
  const shard = repo.writeSkipStatus().shards[`${CHAIN}:${PROTOCOL}`]!;
  const out = structuredClone(shard.total);
  const w = shard.window;
  out.rows += w.rows;
  for (const k of Object.keys(out.decisions) as Array<keyof typeof out.decisions>) out.decisions[k] += w.decisions[k];
  for (const [k, v] of Object.entries(w.fullReasons)) out.fullReasons[k as keyof typeof out.fullReasons] = (out.fullReasons[k as keyof typeof out.fullReasons] ?? 0) + (v ?? 0);
  for (const [k, v] of Object.entries(w.reasons)) out.reasons[k] = (out.reasons[k] ?? 0) + v;
  for (const [k, v] of Object.entries(w.reasonSamples)) out.reasonSamples[k] = [...(out.reasonSamples[k] ?? []), ...v];
  out.gasFullWrite.rows += w.gasFullWrite.rows;
  out.gasFullWrite.skipped += w.gasFullWrite.skipped;
  out.gasFullWrite.sectioned += w.gasFullWrite.sectioned;
  out.setBytes += w.setBytes;
  out.fullBytes += w.fullBytes;
  out.reupserted += w.reupserted;
  out.conflicts += w.conflicts;
  out.sectionErrors += w.sectionErrors;
  out.stampDropped += w.stampDropped;
  return out;
}

type Sent = { filter: Doc; update: Doc & { $set?: Doc; $unset?: Doc }; upsert?: boolean };
const sentOps = (sim: PositionSim, from = 0) =>
  sim.ops.slice(from).filter((o) => o.kind === 'updateOne').map((o) => o.op as Sent);

/** The next walk, `minutes` later: normalize re-stamps the clock-driven fields (closed rows keep their age). */
function walk(p: NormalizedPosition, minutes = 30): NormalizedPosition {
  vi.setSystemTime(Date.now() + minutes * 60_000);
  const closed = p.closedAtTimestamp && p.closedAtTimestamp > p.createdAtTimestamp;
  const ageSeconds = closed ? p.metrics.ageSeconds : p.metrics.ageSeconds + minutes * 60;
  return { ...p, metrics: { ...p.metrics, ageSeconds }, pricing: { ...p.pricing, pricedAt: new Date() } };
}

describe('skip off = today', () => {
  it('one read and one bulkWrite per shard for the whole flush; today\'s projection; `$unset wh` added', async () => {
    const sim = new PositionSim();
    const repo = repoOver(sim);
    const rows = Array.from({ length: 1200 }, (_, i) => normalized({ positionId: String(i + 1), tokenId: String(i + 1) }));
    await repo.upsertMany(rows);
    expect(sim.finds).toHaveLength(1);
    expect(Object.keys(sim.finds[0]!.projection!).sort()).toEqual(
      ['chainId', 'protocol', 'positionId', 'isActive', 'metrics', 'token0.priceUsd', 'token1.priceUsd'].sort(),
    );
    const ops = sentOps(sim);
    expect(ops).toHaveLength(1200);
    expect(ops.every((o) => o.upsert === true)).toBe(true);
    // (`revertMetrics` is undeclared: Mongoose strict mode drops its `$unset`, today as before.)
    expect(ops[0]!.update.$unset).toMatchObject({ wh: '' });
    expect(ops[0]!.update.$set).not.toHaveProperty('wh');
    // The raw indexer row is no longer stored: never `$set` (the fixture's
    // object still carries one), and `$unset` — which survives Mongoose's strict
    // cast only because the schema still DECLARES the path.
    expect(ops[0]!.update.$set).not.toHaveProperty('rawSubgraph');
    expect(ops[0]!.update.$unset).toMatchObject({ rawSubgraph: '' });
    expect(ops[0]!.update.$set).toHaveProperty('lastVerifiedAt'); // a whole-row write
    expect(sim.byId('1')).not.toHaveProperty('rawSubgraph');
    expect(sim.byId('1')!.wh).toBeUndefined();
  });

  it('reads the stored reading only when a P3.1 stamp is carried', async () => {
    const sim = new PositionSim();
    const repo = repoOver(sim);
    await repo.upsertMany([normalized()]);
    await repo.upsertMany([normalized({ rpcFeesUncollected0: '1', rpcFeesUncollected1: '2', rpcFeesBlock: 5, rpcFeesAt: new Date() })]);
    expect(sim.finds[0]!.projection).not.toHaveProperty('rpcFeesBlock');
    expect(sim.finds[1]!.projection).toMatchObject({ rpcFeesBlock: 1, rpcFeesUncollected0: 1, rpcFeesUncollected1: 1, rpcFeesAt: 1 });
  });

  it('MONGO_BULK_WRITE_MAX_OPS caps the bulkWrites with the write budget off (upsertMany and the performance healer)', async () => {
    const sim = new PositionSim();
    const repo = repoOver(sim, { writeBudget: { ...WRITE_BUDGET_OFF, maxOps: 200 } });
    const sizes: number[] = [];
    const bulk = sim.bulkWrite.bind(sim);
    sim.bulkWrite = (async (ops: Array<Record<string, Doc>>) => {
      sizes.push(ops.length);
      return bulk(ops);
    }) as typeof sim.bulkWrite;
    const rows = Array.from({ length: 450 }, (_, i) => normalized({ positionId: String(i + 1), tokenId: String(i + 1) }));
    await repo.upsertMany(rows);
    expect(sizes).toEqual([200, 200, 50]);
    sizes.length = 0;
    await repo.updatePerformanceMetrics(CHAIN, PROTOCOL, rows.map((r) => ({ positionId: r.positionId, metrics: { apr: 1 }, amounts: {} }) as never));
    expect(sizes).toEqual([200, 200, 50]);
  });

  it('list / detail projections are the plain ones', () => {
    const repo = repoOver(new PositionSim());
    expect(repo.listProjection()).toBe(LIST_PROJECTION);
    expect(repo.detailProjection()).toBe(DETAIL_PROJECTION);
    const on = repoOver(new PositionSim(), ON);
    expect(on.listProjection()).toBe(LIST_OVERLAY_PROJECTION);
    expect(on.listProjection()).toHaveProperty('staleMisses', 1);
    expect(on.detailProjection()).toBe(DETAIL_OVERLAY_PROJECTION);
  });
});

describe('skip on — decisions', () => {
  /** Inserted, then written once more (the stored cash flows now feed the metrics: that walk legitimately moves). */
  async function seeded(over: Parameters<typeof normalized>[0] = {}) {
    const sim = new PositionSim();
    const repo = repoOver(sim, ON);
    const p = normalized(over);
    await repo.upsertMany([p]);
    await repo.upsertMany([p]);
    return { sim, repo, p };
  }

  it('insert: the whole update + wh (64 bytes) + wAt, upsert', async () => {
    const { sim, repo } = await seeded();
    const [op] = sentOps(sim);
    expect(op!.upsert).toBe(true);
    expect(op!.update.$set!.wAt).toEqual(T0);
    const doc = sim.byId('424242')!;
    expect(Buffer.isBuffer(doc.wh) && (doc.wh as Buffer).length).toBe(64);
    expect(doc.wAt).toEqual(T0);
    expect(doc.lastVerifiedAt).toEqual(T0);
    expect(counters(repo).fullReasons).toEqual({ insert: 1 });
  });

  it('nothing changed: no write at all (and the read is still charged)', async () => {
    const { sim, repo, p } = await seeded();
    const before = sim.ops.length;
    await repo.upsertMany([walk(p)]);
    expect(sim.ops.length).toBe(before);
    expect(sim.byId('424242')!.lastSyncedAt).toEqual(T0);
  });

  it('a changed section: its leaves only, defaults for absent leaves, $unset for the rest; upsert:false; no lastVerifiedAt / staleMisses / rawSubgraph', async () => {
    const { sim, repo, p } = await seeded({ metrics: { feesSource: 'onchain', priceUnavailable: true } });
    const before = sim.ops.length;
    const next = walk(p);
    const metrics = { ...next.metrics, underlyingValueUsd: 9000 } as Record<string, unknown>;
    delete metrics.feesSource;
    delete metrics.priceUnavailable;
    await repo.upsertMany([{ ...next, metrics: metrics as NormalizedPosition['metrics'] }]);
    const [op] = sentOps(sim, before);
    expect(op!.upsert).toBe(false);
    const set = op!.update.$set!;
    expect(set['metrics.underlyingValueUsd']).toBe(9000);
    expect(set['metrics.priceUnavailable']).toBe(false); // its default, as a whole-subdoc $set stores
    expect(op!.update.$unset).toMatchObject({ 'metrics.feesSource': '' }); // no default: removed
    expect(set.lastSyncedAt).toEqual(new Date());
    expect(Buffer.isBuffer(set.wh) || (set.wh as { _bsontype?: string })._bsontype === 'Binary').toBe(true);
    for (const k of Object.keys(set)) expect(k).not.toMatch(/^(lastVerifiedAt|staleMisses|rawSubgraph|amounts|token0|token1|poolStats|pricing|wAt)/);
    const doc = sim.byId('424242')!;
    expect((doc.metrics as Doc).feesSource).toBeUndefined();
    expect((doc.metrics as Doc).priceUnavailable).toBe(false);
    expect(doc.lastVerifiedAt).toEqual(T0);
    expect(doc.wAt).toEqual(T0);
  });

  it.each([
    ['staleMisses > 0', (s: PositionSim) => void ((s.byId('424242')!.staleMisses = 2)), 'stale-misses'],
    ['wh missing', (s: PositionSim) => void delete s.byId('424242')!.wh, 'no-hash'],
    ['wh not 64 bytes', (s: PositionSim) => void ((s.byId('424242')!.wh = Buffer.alloc(8))), 'no-hash'],
    ['stored inactive', (s: PositionSim) => void ((s.byId('424242')!.isActive = false)), 'active-flip'],
    ['stored poolStats null', (s: PositionSim) => void ((s.byId('424242')!.poolStats = null)), 'legacy-shape'],
  ])('full write when %s', async (_name, tamper, reason) => {
    const { sim, repo, p } = await seeded();
    tamper(sim);
    const before = sim.ops.length;
    await repo.upsertMany([walk(p)]);
    const [op] = sentOps(sim, before);
    expect(op!.upsert).toBe(true);
    expect(op!.update.$set).toHaveProperty('lastVerifiedAt'); // full writes only (a section write has none)
    expect(op!.update.$set).not.toHaveProperty('rawSubgraph');
    expect(op!.update.$unset).toMatchObject({ rawSubgraph: '' });
    expect(op!.update.$set!.wAt).toEqual(new Date());
    expect(counters(repo).fullReasons).toMatchObject({ [reason]: 1 });
  });

  it('forced full write once wAt is older than the per-position interval', async () => {
    const { sim, repo, p } = await seeded();
    const interval = Math.ceil(forcedRewriteIntervalMs('424242', false, { ...WRITE_SKIP_OFF, mode: 'on' }));
    vi.setSystemTime(T0.getTime() + interval - 60_000);
    let before = sim.ops.length;
    await repo.upsertMany([{ ...p, pricing: { ...p.pricing, pricedAt: new Date() } }]);
    expect(sim.ops.length).toBe(before); // still inside the window: skipped
    vi.setSystemTime(T0.getTime() + interval);
    before = sim.ops.length;
    await repo.upsertMany([{ ...p, pricing: { ...p.pricing, pricedAt: new Date() } }]);
    const [op] = sentOps(sim, before);
    expect(op!.upsert).toBe(true);
    expect(sim.byId('424242')!.wAt).toEqual(new Date());
  });

  it('an unknown $set field forces a full write and is warned about once', async () => {
    const { sim, repo, p } = await seeded();
    const before = sim.ops.length;
    await repo.upsertMany([{ ...walk(p), shinyNew: 1 } as unknown as NormalizedPosition]);
    await repo.upsertMany([{ ...walk(p), shinyNew: 1 } as unknown as NormalizedPosition]);
    expect(sentOps(sim, before).every((o) => o.upsert)).toBe(true);
    expect(sentOps(sim, before)).toHaveLength(2);
    expect(logsOf(repo).filter((l) => l.includes('"shinyNew"'))).toHaveLength(1);
  });

  it('a section write whose row was deleted after the read is re-issued as an INSERT (counted reupserted)', async () => {
    const { sim, repo, p } = await seeded();
    sim.beforeBulkWrite = () => sim.remove('424242');
    await repo.upsertMany([{ ...walk(p), currentTick: 77 }]);
    sim.beforeBulkWrite = undefined;
    const doc = sim.byId('424242')!;
    expect(doc).toBeDefined();
    expect(doc.currentTick).toBe(77);
    // A whole document, not a stub of leaves.
    expect(doc.lastVerifiedAt).toBeDefined();
    expect(doc.amounts).toBeDefined();
    expect(doc.owner).toBeDefined();
    expect(doc).not.toHaveProperty('rawSubgraph');
    expect(doc.txSyncStatus).toBe('pending');
    // Written as an INSERT: nothing carried over from the vanished row's metrics.
    expect((doc.amounts as Doc).totalFeesCollectedUsd).toBe('0');
    expect(counters(repo).reupserted).toBe(1);
    expect(counters(repo).conflicts).toBe(0); // vanished, not conflicted
  });

  it('a section write whose row another writer changed after the read (wh moved) is re-issued as a FULL write', async () => {
    const { sim, repo, p } = await seeded();
    // The fee job's served write lands between the read and the write: new served
    // figures, and `$unset wh` (its invalidation).
    sim.beforeBulkWrite = () => {
      const doc = sim.byId('424242')!;
      (doc.metrics as Doc).pendingFeesUsd = 99;
      delete doc.wh;
    };
    const before = sim.ops.length;
    await repo.upsertMany([{ ...walk(p), currentTick: 78 }]);
    sim.beforeBulkWrite = undefined;
    const ops = sentOps(sim, before);
    expect(ops[0]!.upsert).toBe(false);
    expect(ops[0]!.filter.wh).toBeDefined(); // the section op is guarded on the wh it read
    expect(ops[1]!.upsert).toBe(true); // …and re-issued whole when it missed
    const doc = sim.byId('424242')!;
    expect(doc.currentTick).toBe(78);
    // Today's full-write semantics: the normalized figures, and a wh that describes them.
    expect((doc.metrics as Doc).pendingFeesUsd).toBe(p.metrics.pendingFeesUsd);
    // …computed from the row as read (not as an insert: the stored cash flows still feed it).
    expect((doc.amounts as Doc).totalFeesCollectedUsd).toBe('63.33');
    expect(Buffer.isBuffer(doc.wh)).toBe(true);
    const c = counters(repo);
    expect(c.conflicts).toBe(1);
    expect(c.reupserted).toBe(1);
    // The next walk of the same input compares against a correct wh: nothing to write.
    const b2 = sim.ops.length;
    await repo.upsertMany([{ ...walk(p), currentTick: 78 }]);
    expect(sim.ops.length).toBe(b2);
  });

  it('one conflicted row in a chunk: only that row is re-issued; the rows whose section op landed are not', async () => {
    const sim = new PositionSim();
    const repo = repoOver(sim, ON);
    const rows = Array.from({ length: 5 }, (_, i) => normalized({ positionId: String(i + 1), tokenId: String(i + 1) }));
    await repo.upsertMany(rows);
    await repo.upsertMany(rows);
    const before = sim.ops.length;
    // A fee served write lands on row 1 only, between the read and the write.
    sim.beforeBulkWrite = () => {
      delete sim.byId('1')!.wh;
      sim.beforeBulkWrite = undefined;
    };
    await repo.upsertMany(rows.map((r) => ({ ...walk(r, 0), currentTick: 99 })));
    const ops = sentOps(sim, before);
    expect(ops.filter((o) => o.upsert === false)).toHaveLength(5);
    const whole = ops.filter((o) => o.upsert === true);
    expect(whole.map((o) => o.filter.positionId)).toEqual(['1']);
    const c = counters(repo);
    expect(c.conflicts).toBe(1);
    expect(c.reupserted).toBe(1);
    for (const id of ['1', '2', '3', '4', '5']) expect(sim.byId(id)!.currentTick).toBe(99);
  });

  it('a conflict re-issue is decided from a FRESH read: a newer stamp written meanwhile is not regressed', async () => {
    const sim = new PositionSim();
    const observer = { onWritten: vi.fn(), onFeeReread: vi.fn() };
    const repo = repoOver(sim, ON, observer);
    const p = normalized({ metrics: { feesSource: 'onchain' } });
    await repo.upsertMany([p]);
    await repo.upsertMany([p]);
    const at = new Date(T0.getTime() - 1_000);
    const carried = { ...walk(p), rpcFeesUncollected0: '0.5', rpcFeesUncollected1: '7', rpcFeesBlock: 600, rpcFeesAt: new Date() };
    // The fee job serves a NEWER reading between the read and the write.
    sim.beforeBulkWrite = () => {
      const doc = sim.byId('424242')!;
      Object.assign(doc, { rpcFeesUncollected0: '0.25', rpcFeesUncollected1: '2', rpcFeesBlock: 700, rpcFeesAt: at });
      delete doc.wh;
      sim.beforeBulkWrite = undefined;
    };
    await repo.upsertMany([carried]);
    const doc = sim.byId('424242')!;
    expect(counters(repo).conflicts).toBe(1);
    expect(doc.rpcFeesBlock).toBe(700);
    expect((doc.amounts as Doc).totalFeesUncollected1).toBe('2');
    expect((doc.metrics as Doc).pendingFeesUsd).toBe(0.25 * 3000 + 2);
    expect(observer.onFeeReread).toHaveBeenCalledWith(CHAIN, PROTOCOL, ['424242']);
    // The hint reports what was written: no stamp.
    expect((observer.onWritten.mock.calls.at(-1)![2] as FeeRowHint[])[0]!.rpc).toBeUndefined();
  });

  it('after a conflict re-issue, a section the update lacked is unknown in wh (the other writer may have changed it)', async () => {
    const stamp = { rpcFeesUncollected0: '0.5', rpcFeesUncollected1: '7', rpcFeesBlock: 500, rpcFeesAt: new Date() };
    const sim = new PositionSim();
    const repo = repoOver(sim, ON);
    const p = normalized();
    await repo.upsertMany([{ ...p, ...stamp }]);
    await repo.upsertMany([p]);
    const f = SECTIONS.indexOf('f');
    expect((sim.byId('424242')!.wh as Buffer).subarray(f * 8, f * 8 + 8).equals(Buffer.alloc(8))).toBe(false);
    sim.beforeBulkWrite = () => {
      const doc = sim.byId('424242')!;
      doc.rpcFeesBlock = 900;
      delete doc.wh;
    };
    await repo.upsertMany([{ ...walk(p), currentTick: 5 }]);
    sim.beforeBulkWrite = undefined;
    expect(counters(repo).conflicts).toBe(1);
    expect((sim.byId('424242')!.wh as Buffer).subarray(f * 8, f * 8 + 8).equals(Buffer.alloc(8))).toBe(true);
  });

  it('a section write refused by the server (code 28) is re-issued whole', async () => {
    const { sim, repo, p } = await seeded();
    sim.typeProjection = false; // a server that ignores the $type projection
    sim.byId('424242')!.poolStats = null;
    await repo.upsertMany([{ ...walk(p), poolStats: { ...p.poolStats, tvlUsd: 5 } }]);
    expect((sim.byId('424242')!.poolStats as Doc).tvlUsd).toBe(5);
    const w = counters(repo);
    expect(w.sectionErrors).toBe(1);
    expect(w.reupserted).toBe(1);
  });

  it('a failure of a whole write still fails the flush (today)', async () => {
    const sim = new PositionSim();
    const repo = repoOver(sim, ON);
    sim.bulkWrite = async () => {
      const err = new Error('boom') as Error & { writeErrors: unknown[] };
      err.writeErrors = [{ index: 0, code: 11000 }];
      throw err;
    };
    await expect(repo.upsertMany([normalized()])).rejects.toThrow('boom');
  });

  it('a failed WHOLE op in a chunk that also holds section ops fails the flush; nothing is re-issued', async () => {
    const sim = new PositionSim();
    const repo = repoOver(sim, ON);
    const a = normalized({ positionId: '1', tokenId: '1' });
    const b = normalized({ positionId: '2', tokenId: '2' });
    await repo.upsertMany([a, b]);
    await repo.upsertMany([a, b]);
    sim.byId('2')!.staleMisses = 2; // row 2: a full write (rule 2); row 1: a section write
    const calls: Array<Array<Record<string, Doc>>> = [];
    const bulk = sim.bulkWrite.bind(sim);
    sim.bulkWrite = (async (ops: Array<Record<string, Doc>>) => {
      calls.push(ops);
      const result = await bulk(ops);
      const err = new Error('dup') as Error & { writeErrors: unknown[]; result: unknown };
      err.writeErrors = [{ index: 1, code: 11000 }];
      err.result = { ...result, matchedCount: result.matchedCount - 1 };
      throw err;
    }) as typeof sim.bulkWrite;
    await expect(repo.upsertMany([{ ...walk(a), currentTick: 3 }, { ...walk(b, 0), currentTick: 3 }])).rejects.toThrow('dup');
    expect(calls).toHaveLength(1);
    expect((calls[0]![0]!.updateOne as Doc).upsert).toBe(false);
    expect((calls[0]![1]!.updateOne as Doc).upsert).toBe(true);
  });

  it('a full write by a writer that does not know wh (lastVerifiedAt after wAt) makes the next upsert write the row whole', async () => {
    const { sim, repo, p } = await seeded();
    // A pre-P2.3 image rewrites the row later: other figures, `lastVerifiedAt`, and `wh` / `wAt` left as they were.
    vi.setSystemTime(Date.now() + 5 * 60_000);
    const doc = sim.byId('424242')!;
    (doc.token0 as Doc).priceUsd = 2999;
    doc.lastVerifiedAt = new Date();
    const before = sim.ops.length;
    await repo.upsertMany([walk(p)]); // equal to what the hash describes
    const [op] = sentOps(sim, before);
    expect(op!.upsert).toBe(true);
    expect((sim.byId('424242')!.token0 as Doc).priceUsd).toBe(3000);
    expect(counters(repo).fullReasons).toMatchObject({ 'no-hash': 1 });
    // Written whole: `lastVerifiedAt` and `wAt` agree again → the next identical walk skips.
    const b2 = sim.ops.length;
    await repo.upsertMany([walk(p)]);
    expect(sim.ops.length).toBe(b2);
  });

  it('reads and writes per chunk of ≤ 500, each chunk read right before its own write', async () => {
    const sim = new PositionSim();
    const repo = repoOver(sim, ON);
    const order: string[] = [];
    const find = sim.find.bind(sim);
    sim.find = ((f: Doc, p?: Doc) => {
      order.push('read');
      return find(f, p);
    }) as typeof sim.find;
    const bulk = sim.bulkWrite.bind(sim);
    sim.bulkWrite = (async (ops: Array<Record<string, Doc>>) => {
      order.push(`write:${ops.length}`);
      return bulk(ops);
    }) as typeof sim.bulkWrite;
    const rows = Array.from({ length: 1100 }, (_, i) => normalized({ positionId: String(i + 1), tokenId: String(i + 1) }));
    await repo.upsertMany(rows);
    expect(order).toEqual(['read', 'write:500', 'read', 'write:500', 'read', 'write:100']);
  });

  it('duplicate rows of one flush: the last one is written', async () => {
    const sim = new PositionSim();
    const repo = repoOver(sim, ON);
    await repo.upsertMany([normalized({ currentTick: 1 }), normalized({ currentTick: 2 })]);
    expect(sentOps(sim)).toHaveLength(1);
    expect(sim.byId('424242')!.currentTick).toBe(2);
  });

  it('skip `on` reads the decision inputs, including each subdocument\'s $type', async () => {
    const { sim } = await seeded();
    const projection = sim.finds[0]!.projection!;
    expect(projection).toMatchObject({ wh: 1, wAt: 1, lastVerifiedAt: 1, staleMisses: 1, rpcFeesBlock: 1, 'amounts.totalGasCostEth': 1 });
    expect(projection._wt).toEqual({
      amounts: { $type: '$amounts' },
      metrics: { $type: '$metrics' },
      token0: { $type: '$token0' },
      token1: { $type: '$token1' },
      poolStats: { $type: '$poolStats' },
      pricing: { $type: '$pricing' },
    });
  });
});

describe('P3.1 stamp guard (every mode) and the writer hints', () => {
  const stamp = (block: number) => ({ rpcFeesUncollected0: '0.5', rpcFeesUncollected1: '7', rpcFeesBlock: block, rpcFeesAt: new Date() });

  for (const mode of ['off', 'on'] as const) {
    it(`${mode}: a carried reading OLDER than the stored one is not written; the row goes back for a re-read; the same block is written`, async () => {
      const sim = new PositionSim();
      const observer = { onWritten: vi.fn(), onFeeReread: vi.fn() };
      const repo = repoOver(sim, mode === 'on' ? ON : undefined, observer);
      await repo.upsertMany([normalized(stamp(500))]);
      expect(sim.byId('424242')!.rpcFeesBlock).toBe(500);
      // The same block: the same measurement (the indexer's merge gives the tie to it too) — written, nothing to re-read.
      const sameAt = new Date(Date.now() + 1_000);
      await repo.upsertMany([walk(normalized({ ...stamp(500), rpcFeesAt: sameAt, currentTick: 9 }))]);
      expect(sim.byId('424242')!.rpcFeesAt).toEqual(sameAt);
      expect(observer.onFeeReread).not.toHaveBeenCalled();
      if (mode === 'on') expect(counters(repo).stampDropped).toBe(0);
      await repo.upsertMany([walk(normalized({ ...stamp(400), currentTick: 10 }))]);
      expect(sim.byId('424242')!.rpcFeesBlock).toBe(500);
      expect(sim.byId('424242')!.rpcFeesAt).toEqual(sameAt);
      expect(sim.byId('424242')!.currentTick).toBe(10);
      expect(observer.onFeeReread).toHaveBeenCalledTimes(1);
      expect(observer.onFeeReread).toHaveBeenLastCalledWith(CHAIN, PROTOCOL, ['424242']);
      if (mode === 'on') expect(counters(repo).stampDropped).toBe(1);
      // A newer reading is written, with the stamp in the hint.
      await repo.upsertMany([walk(normalized(stamp(600)))]);
      expect(sim.byId('424242')!.rpcFeesBlock).toBe(600);
      const hints = observer.onWritten.mock.calls.at(-1)![2] as FeeRowHint[];
      expect(hints[0]!.rpc).toMatchObject({ fees0: '0.5', fees1: '7', block: 600 });
    });
  }

  for (const mode of ['off', 'on'] as const) {
    it(`${mode}: a refused reading's served fee leaves are re-served from the stored (newer) reading, not the carried one`, async () => {
      const sim = new PositionSim();
      const repo = repoOver(sim, mode === 'on' ? ON : undefined);
      const storedAt = new Date(T0.getTime() - 60_000);
      await repo.upsertMany([normalized({ ...stamp(500), rpcFeesAt: storedAt, metrics: { feesSource: 'onchain', feesMeasuredAt: storedAt } })]);
      // An older reading normalize served as `onchain`: 3 / 3 → $9,003 pending.
      const olderAt = new Date(T0.getTime() - 120_000);
      const older = walk(
        normalized({
          rpcFeesUncollected0: '3',
          rpcFeesUncollected1: '3',
          rpcFeesBlock: 400,
          rpcFeesAt: olderAt,
          currentTick: 11,
          amounts: { totalFeesUncollected0: '3', totalFeesUncollected1: '3', totalFeesUncollectedUsd: '9003' },
          metrics: { feesSource: 'onchain', feesMeasuredAt: olderAt, pendingFeesUsd: 9003, totalFeesUsd: 9003 + 63.33 },
        }),
      );
      await repo.upsertMany([older]);
      const doc = sim.byId('424242')!;
      expect(doc.currentTick).toBe(11);
      expect(doc.rpcFeesBlock).toBe(500);
      const amounts = doc.amounts as Doc;
      const metrics = doc.metrics as Doc;
      // The stored reading (0.5 WETH + 7 USDC) at this row's prices (3000 / 1).
      expect(amounts.totalFeesUncollected0).toBe('0.5');
      expect(amounts.totalFeesUncollected1).toBe('7');
      expect(amounts.totalFeesUncollectedUsd).toBe('1507');
      expect(metrics.pendingFeesUsd).toBe(1507);
      expect(metrics.feesSource).toBe('onchain');
      expect(metrics.feesMeasuredAt).toEqual(storedAt);
    });
  }

  it('a refused reading that normalize did not serve (not `onchain`) only loses its stamp', async () => {
    const sim = new PositionSim();
    const repo = repoOver(sim, ON);
    await repo.upsertMany([normalized(stamp(500))]);
    await repo.upsertMany([walk(normalized({ ...stamp(400), metrics: { feesSource: 'settled' }, amounts: { totalFeesUncollected0: '0', totalFeesUncollected1: '0' } }))]);
    const doc = sim.byId('424242')!;
    expect(doc.rpcFeesBlock).toBe(500);
    expect((doc.amounts as Doc).totalFeesUncollected0).toBe('0');
    expect((doc.metrics as Doc).feesSource).toBe('settled');
  });

  it('onWritten gets the fee fields of every WRITTEN row (not the skipped ones); a throwing observer never fails the write', async () => {
    const sim = new PositionSim();
    const observer = { onWritten: vi.fn() };
    const repo = repoOver(sim, ON, observer);
    const a = normalized({ positionId: '1', tokenId: '1' });
    const b = normalized({ positionId: '2', tokenId: '2' });
    await repo.upsertMany([a, b]);
    expect(observer.onWritten).toHaveBeenCalledTimes(1);
    const firstCall = observer.onWritten.mock.calls[0]!;
    await repo.upsertMany([a, b]); // the stored cash flows now feed the metrics: both move once
    observer.onWritten.mock.calls[0] = firstCall;
    const [chain, protocol, rows] = observer.onWritten.mock.calls[0]!;
    expect([chain, protocol]).toEqual([CHAIN, PROTOCOL]);
    expect(rows).toEqual([
      expect.objectContaining({ positionId: '1', isActive: true, poolId: '0xpool', tickLower: -600, tickUpper: 600, decimals0: 18, decimals1: 6, price0: 3000, price1: 1, lastModifyBlock: 23_000_000, feesSource: 'indexer', wAt: T0.getTime() }),
      expect.objectContaining({ positionId: '2' }),
    ]);
    expect((rows as FeeRowHint[])[0]!.rpc).toBeUndefined();
    observer.onWritten.mockImplementation(() => {
      throw new Error('store down');
    });
    await repo.upsertMany([walk(a), { ...walk(b, 0), currentTick: 5 }]);
    expect((observer.onWritten.mock.calls.at(-1)![2] as FeeRowHint[]).map((r) => r.positionId)).toEqual(['2']);
    expect(sim.byId('2')!.currentTick).toBe(5);
  });
});

describe('D-1b (POSITIONS_GAS_REVALUE)', () => {
  const perf = { metrics: { performanceReady: true, depositedUsd: 8000, withdrawnUsd: 0, collectedFeesUsd: 60 } };

  it('full-write: a section write keeps the stored gas valuation; the forced write re-values it at the current ETH price', async () => {
    const sim = new PositionSim();
    const repo = repoOver(sim, { ...ON, positionsGasRevalue: 'full-write' });
    const closed = normalized({ ...perf, isActive: false, closedAtTimestamp: 1_759_500_000 });
    await repo.upsertMany([closed], { aggregates: { ethPriceNow: 3000 } });
    await repo.upsertMany([closed], { aggregates: { ethPriceNow: 3000 } });
    const gasAt3000 = (sim.byId('424242')!.metrics as Doc).totalGasCostUsd;
    expect(gasAt3000).toBeCloseTo(0.0123 * 3000, 9);
    // ETH moves; nothing else does → nothing to write.
    let before = sim.ops.length;
    await repo.upsertMany([walk(closed)], { aggregates: { ethPriceNow: 4000 } });
    expect(sim.ops.length).toBe(before);
    // Another leaf moves → a section write, gas still at the stored valuation.
    before = sim.ops.length;
    await repo.upsertMany([{ ...walk(closed), currentTick: 3 }], { aggregates: { ethPriceNow: 4000 } });
    expect(sentOps(sim, before)[0]!.upsert).toBe(false);
    expect((sim.byId('424242')!.metrics as Doc).totalGasCostUsd).toBe(gasAt3000);
    expect((sim.byId('424242')!.amounts as Doc).totalGasCostUsd).toBe(String(gasAt3000));
    // The forced rewrite re-values at the current price.
    vi.setSystemTime(T0.getTime() + 2 * 86_400_000);
    await repo.upsertMany([walk(closed, 0)], { aggregates: { ethPriceNow: 4000 } });
    expect((sim.byId('424242')!.metrics as Doc).totalGasCostUsd).toBeCloseTo(0.0123 * 4000, 9);
  });

  it('always (default): the moving ETH price rewrites the gas leaves on every write, as today', async () => {
    const sim = new PositionSim();
    const repo = repoOver(sim, ON);
    const closed = normalized({ ...perf, isActive: false, closedAtTimestamp: 1_759_500_000 });
    await repo.upsertMany([closed], { aggregates: { ethPriceNow: 3000 } });
    await repo.upsertMany([closed], { aggregates: { ethPriceNow: 3000 } });
    const before = sim.ops.length;
    await repo.upsertMany([walk(closed)], { aggregates: { ethPriceNow: 4000 } });
    const [op] = sentOps(sim, before);
    expect(op!.upsert).toBe(false);
    expect((sim.byId('424242')!.metrics as Doc).totalGasCostUsd).toBeCloseTo(0.0123 * 4000, 9);
  });
});

describe('D-1 (POSITIONS_WRITE_SKIP_AGE=bucket)', () => {
  it('an active row whose APR depends on age is skipped while its age stays in one bucket', async () => {
    const perf = { metrics: { performanceReady: true, depositedUsd: 8000, withdrawnUsd: 0, collectedFeesUsd: 60, ageSeconds: 400 * 86_400 } };
    const refresh = new PositionSim();
    const bucket = new PositionSim();
    const repoRefresh = repoOver(refresh, ON);
    const repoBucket = repoOver(bucket, { ...ON, positionsWriteSkipAge: 'bucket' });
    const p = normalized(perf);
    for (const repo of [repoRefresh, repoBucket]) await repo.upsertMany([p], { aggregates: { ethPriceNow: 3000 } });
    for (const repo of [repoRefresh, repoBucket]) await repo.upsertMany([p], { aggregates: { ethPriceNow: 3000 } });
    const rb = refresh.ops.length;
    const bb = bucket.ops.length;
    // One minute later: the exact age moved, the 6 h bucket did not.
    const later = { ...p, metrics: { ...p.metrics, ageSeconds: p.metrics.ageSeconds + 60 } };
    vi.setSystemTime(Date.now() + 60_000);
    await repoRefresh.upsertMany([later], { aggregates: { ethPriceNow: 3000 } });
    await repoBucket.upsertMany([later], { aggregates: { ethPriceNow: 3000 } });
    expect(refresh.ops.length - rb).toBe(1);
    expect(bucket.ops.length - bb).toBe(0);
  });
});

describe('shadow', () => {
  it('writes every row whole (+ wh / wAt) and counts what `on` would do, with the reasons', async () => {
    const sim = new PositionSim();
    const repo = repoOver(sim, { positionsWriteSkip: 'shadow' });
    const p = normalized();
    await repo.upsertMany([p]);
    await repo.upsertMany([p]); // the stored cash flows now feed the metrics: a real change
    let before = sim.ops.length;
    await repo.upsertMany([walk(p)]);
    expect(sentOps(sim, before)[0]!.upsert).toBe(true);
    expect(sentOps(sim, before)[0]!.update.$set).toHaveProperty('lastVerifiedAt'); // whole
    expect(sentOps(sim, before)[0]!.update.$set).not.toHaveProperty('rawSubgraph');
    before = sim.ops.length;
    await repo.upsertMany([{ ...walk(p), currentTick: 99, token0: { ...p.token0, priceUsd: 2900 } }]);
    expect(sentOps(sim, before)[0]!.upsert).toBe(true);
    const w = counters(repo);
    expect(w.decisions).toEqual({ insert: 1, full: 0, section: 2, skip: 1 });
    expect(w.reasons).toMatchObject({ 'i:pool-state': 1, 't0:token-price': 1 });
    expect(w.reasonSamples['i:pool-state']).toEqual(['424242']);
    expect(w.fullBytes).toBeGreaterThan(w.setBytes);
    expect(Buffer.isBuffer(sim.byId('424242')!.wh)).toBe(true);
    expect(sim.byId('424242')!.wAt).toEqual(new Date());
  });

  it('evaluates D-1b: a gas-only change would be a section write with `always`, nothing with `full-write`', async () => {
    const sim = new PositionSim();
    const repo = repoOver(sim, { positionsWriteSkip: 'shadow' });
    const closed = normalized({ isActive: false, closedAtTimestamp: 1_759_500_000, metrics: { performanceReady: true, depositedUsd: 8000, withdrawnUsd: 0, collectedFeesUsd: 60 } });
    await repo.upsertMany([closed], { aggregates: { ethPriceNow: 3000 } });
    await repo.upsertMany([closed], { aggregates: { ethPriceNow: 3000 } });
    await repo.upsertMany([walk(closed)], { aggregates: { ethPriceNow: 4000 } });
    const w = counters(repo);
    expect(w.decisions.section).toBe(1);
    expect(w.decisions.skip).toBe(1);
    expect(w.reasons).toMatchObject({ 'm:gas': 1, 'a:gas': 1 });
    // Both non-full rows (the unchanged warm-up and the gas-only one) skip under full-write.
    expect(w.gasFullWrite).toEqual({ rows: 2, skipped: 2, sectioned: 0 });
  });

  it('logs a window line and, in `on`, alerts skip_rate_low after 3 low windows', async () => {
    const sim = new PositionSim();
    const repo = repoOver(sim, ON);
    const rows = Array.from({ length: 1100 }, (_, i) => normalized({ positionId: String(i + 1), tokenId: String(i + 1) }));
    await repo.upsertMany(rows);
    const alerts = () => logsOf(repo).filter((l) => l.includes('[alert] positions.skip_rate_low')).length;
    const seen: number[] = [];
    for (let w = 0; w < 5; w++) {
      vi.setSystemTime(Date.now() + 11 * 60_000);
      await repo.upsertMany(rows.map((r) => ({ ...r, currentTick: w + 100, metrics: { ...r.metrics, ageSeconds: r.metrics.ageSeconds + w } })));
      seen.push(alerts());
    }
    expect(logsOf(repo).some((l) => l.startsWith('[write-skip] chain=1 protocol=uniswap-v4 mode=on'))).toBe(true);
    // Window 1 holds the inserts (< 1,000 updates: not judged); windows 2–4 are low → the 3rd low one alerts, once.
    expect(seen).toEqual([0, 0, 0, 1, 1]);
  });
});

describe('the shared write budget (P2.4)', () => {
  it('units per op and the read are charged; chunks of 500 even with skip off once the budget is on', async () => {
    const acquired: number[] = [];
    registerProcessWriteBudget({
      settings: { ...WRITE_BUDGET_OFF, mode: 'observe' },
      enabled: true,
      readUnits: (docs: number) => docs * 0.15,
      acquire: async (units: number) => {
        acquired.push(units);
        return { waitedMs: 0 };
      },
      charge: vi.fn(),
      recordChunk: vi.fn(),
    } as never);
    const sim = new PositionSim();
    const repo = repoOver(sim);
    const rows = Array.from({ length: 600 }, (_, i) => normalized({ positionId: String(i + 1), tokenId: String(i + 1), isActive: i % 3 !== 0 }));
    await repo.upsertMany(rows);
    expect(acquired).toHaveLength(2);
    // 400 active + 200 closed inserts, no stored rows read.
    expect(acquired[0]! + acquired[1]!).toBeCloseTo(400 * WRITE_UNITS.insertActive + 200 * WRITE_UNITS.insertClosed, 9);
    acquired.length = 0;
    await repo.upsertMany(rows.slice(0, 10));
    expect(acquired[0]).toBeCloseTo(10 * WRITE_UNITS.fullUpdate + 10 * 0.15, 9);
  });
});

describe('the fee writes\' budget lane', () => {
  it('fee writes are charged to the `fee` lane (not `other`) and carry the caller\'s wait bound', async () => {
    const acquired: Array<{ lane?: string; maxWaitMs?: number }> = [];
    registerProcessWriteBudget({
      settings: { ...WRITE_BUDGET_OFF, mode: 'enforce' },
      enabled: true,
      readUnits: (docs: number) => docs * 0.15,
      acquire: async (_units: number, opts: { lane?: string; maxWaitMs?: number } = {}) => {
        acquired.push({ lane: opts.lane, maxWaitMs: opts.maxWaitMs });
        return { waitedMs: 0 };
      },
      charge: vi.fn(),
      recordChunk: vi.fn(),
    } as never);
    const sim = new PositionSim();
    const repo = repoOver(sim);
    await repo.upsertMany([normalized({ positionId: '1', tokenId: '1' }), normalized({ positionId: '2', tokenId: '2' })]);
    acquired.length = 0;
    await repo.writeRpcFees(
      CHAIN,
      PROTOCOL,
      [
        { positionId: '1', fees0: '1', fees1: '2', block: 30_000_000, served: { 'metrics.pendingFeesUsd': 5 }, version: sim.byId('1')!.updatedAt as Date },
        { positionId: '2', fees0: '1', fees1: '2', block: 30_000_000 },
      ],
      new Date(),
      { maxBudgetWaitMs: 90_000 },
    );
    expect(acquired).toHaveLength(2);
    expect(acquired.every((a) => a.lane === 'fee' && a.maxWaitMs === 90_000)).toBe(true);
  });
});

describe('other writers invalidate wh (design §4.4)', () => {
  it('a served fee write $unsets wh; a stamp-only one does not', async () => {
    const sim = new PositionSim();
    const repo = repoOver(sim, ON);
    await repo.upsertMany([normalized({ positionId: '1', tokenId: '1' }), normalized({ positionId: '2', tokenId: '2' })]);
    const before = sim.ops.length;
    await repo.writeRpcFees(CHAIN, PROTOCOL, [
      { positionId: '1', fees0: '1', fees1: '2', block: 30_000_000, served: { 'metrics.pendingFeesUsd': 5 }, version: sim.byId('1')!.updatedAt as Date },
      { positionId: '2', fees0: '1', fees1: '2', block: 30_000_000 },
    ]);
    const ops = sentOps(sim, before);
    const served = ops.find((o) => (o.filter as Doc).positionId === '1')!;
    const plain = ops.find((o) => (o.filter as Doc).positionId === '2')!;
    expect(served.update.$unset).toMatchObject({ wh: '' });
    expect(plain.update.$unset ?? {}).not.toHaveProperty('wh');
    expect(sim.byId('1')!.wh).toBeUndefined();
    expect(sim.byId('2')!.wh).toBeDefined();
    // …so the next upsert of row 1 is a full write.
    const b2 = sim.ops.length;
    await repo.upsertMany([walk(normalized({ positionId: '1', tokenId: '1' }))]);
    expect(sentOps(sim, b2)[0]!.upsert).toBe(true);
  });

  it('the performance healer $unsets wh', async () => {
    const sim = new PositionSim();
    const repo = repoOver(sim, ON);
    await repo.upsertMany([normalized()]);
    await repo.updatePerformanceMetrics(CHAIN, PROTOCOL, [{ positionId: '424242', metrics: { apr: 1 }, amounts: { diffUsd: '1' } } as never]);
    expect(sim.byId('424242')!.wh).toBeUndefined();
    expect((sim.byId('424242')!.metrics as Doc).apr).toBe(1);
  });

  it('the stale sweep $unsets wh on the miss and the closure, and hints the closures', async () => {
    const sim = new PositionSim();
    const observer = { onWritten: vi.fn() };
    const repo = repoOver(sim, ON, observer);
    await repo.upsertMany([normalized({ positionId: '1', tokenId: '1' }), normalized({ positionId: '2', tokenId: '2' }), normalized({ positionId: '3', tokenId: '3' })]);
    sim.byId('2')!.staleMisses = 2;
    observer.onWritten.mockClear();
    const closed = await repo.markMissingStale(CHAIN, PROTOCOL, new Set(['1']), 3);
    expect(closed).toBe(1);
    expect(sim.byId('2')!.wh).toBeUndefined();
    expect(sim.byId('3')!.wh).toBeUndefined();
    expect(sim.byId('1')!.wh).toBeDefined();
    const updates = sim.ops.filter((o) => o.kind === 'updateMany').map((o) => (o.op as { update: Doc }).update);
    expect(updates.every((u) => (u.$unset as Doc).wh === '')).toBe(true);
    expect(observer.onWritten).toHaveBeenCalledWith(CHAIN, PROTOCOL, [{ positionId: '2', isActive: false, wAt: expect.any(Number) }]);
  });
});

describe('the wh slots', () => {
  it('a section write rewrites only the changed slots', async () => {
    const sim = new PositionSim();
    const repo = repoOver(sim, ON);
    const p = normalized();
    await repo.upsertMany([p]);
    await repo.upsertMany([p]);
    const first = Buffer.from(sim.byId('424242')!.wh as Buffer);
    await repo.upsertMany([{ ...walk(p), currentTick: 1 }]);
    const second = sim.byId('424242')!.wh as Buffer;
    SECTIONS.forEach((section, i) => {
      const same = first.subarray(i * 8, i * 8 + 8).equals(second.subarray(i * 8, i * 8 + 8));
      expect(same, section).toBe(section !== 'i');
    });
    expect(encodeWh([]).length).toBe(64);
  });
});
