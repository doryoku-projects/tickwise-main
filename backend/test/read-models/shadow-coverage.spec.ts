/*
 * The lane-A bucket lists, their coverage and the rollout gate (design §7.1 /
 * §7.3, P-R R4) — per process (`shadowSummary`) and across replicas and
 * restarts (`coverageRecord` → `aggregateCoverage` → `fleetGate`).
 */
import { describe, expect, it } from 'vitest';
import { coverage, HOLDER_BUCKETS, poolsBuckets, rankBuckets } from '../../src/read-models/shadow/buckets.js';
import { LaneAMeter, poolsBucket } from '../../src/read-models/shadow/pools-lane-a.js';
import { rankBucket } from '../../src/read-models/shadow/rank-lane-a.js';
import { aggregateCoverage, coverageRecord, fleetGate, shadowSummary } from '../../src/read-models/shadow/summary.js';

const SHARDS = { rank: ['1:uniswap-v4'], pools: ['1:uniswap-v4'] };

function fill(meter: LaneAMeter, buckets: readonly string[], n: number, now = 1): void {
  for (const bucket of buckets) for (let i = 0; i < n; i++) meter.record(bucket, undefined, {}, now);
}

describe('bucket lists', () => {
  it('pools: 2 sort × 5 search × 2 floor × 2 chains × 4 kinds = 160, made by lane A’s own labeller', () => {
    const list = poolsBuckets();
    expect(list).toHaveLength(160);
    expect(new Set(list).size).toBe(160);
    expect(list).toContain(poolsBucket({ sort: 'volume24h', search: '0xDEAD', minTvlUsd: 1_000_000, single: false, kind: 'deep' }));
    expect(list).toContain(poolsBucket({ sort: 'age', search: 'ü', minTvlUsd: 123, single: true, kind: 'count' }));
  });

  it('rank: 4 shapes × 3 sort classes × 2 chains × 4 kinds minus lookup deep/count (12) and pool count (6) = 78', () => {
    const list = rankBuckets();
    expect(list).toHaveLength(78);
    expect(list).toContain(rankBucket({ shape: 'owner', sortField: 'metrics.roi', single: false, kind: 'count' }));
    expect(list).not.toContain(rankBucket({ shape: 'lookup', sortField: 'tokenId', single: true, kind: 'deep' }));
    expect(list).not.toContain(rankBucket({ shape: 'pool', sortField: 'createdAtTimestamp', single: true, kind: 'count' }));
    expect(HOLDER_BUCKETS).toEqual(['holders|detail', 'holders|list']);
  });
});

describe('coverage', () => {
  it('a bucket is covered at ≥ 50 checks; the gate needs every bucket covered and zero diffs', () => {
    const list = ['a', 'b', 'c'];
    const meter = new LaneAMeter();
    fill(meter, ['a', 'b'], 50);
    fill(meter, ['c'], 49);
    let cov = coverage(list, meter.snapshot());
    expect(cov).toMatchObject({ total: 3, covered: 2, partial: 1, uncovered: 0, gate: false });
    expect(cov.short).toEqual([{ bucket: 'c', checks: 49 }]);
    fill(meter, ['c'], 1);
    expect(coverage(list, meter.snapshot()).gate).toBe(true);
    meter.record('b', { kind: 'order', engine: [], mongo: [] }, {}, 2);
    cov = coverage(list, meter.snapshot());
    expect(cov.gate).toBe(false);
    expect(cov.diffBuckets).toEqual(['b']);
  });

  it('a bucket lane A keeps finding too heavy (≥ 50 heavy skips, < 50 checks) is EXEMPT: the gate is covered ∪ exempt', () => {
    const list = ['a', 'heavy', 'rare'];
    const meter = new LaneAMeter();
    fill(meter, ['a'], 50);
    for (let i = 0; i < 49; i++) meter.skip('heavy', 'heavy', i * 60_000);
    meter.skip('heavy', 'rare'); // one heavy skip is not "cannot afford"
    let cov = coverage(list, meter.snapshot());
    expect(cov).toMatchObject({ covered: 1, exempt: 0, gate: false });
    meter.skip('heavy', 'heavy', 50 * 60_000);
    fill(meter, ['rare'], 50);
    cov = coverage(list, meter.snapshot());
    expect(cov).toMatchObject({ covered: 2, exempt: 1, uncovered: 0, gate: true, exemptBuckets: ['heavy'] });
    // a heavy skip gates the bucket for a minute (one engine pass a minute at most)
    expect(meter.recent('heavy', 50 * 60_000 + 59_999)).toBe(true);
    // other skip reasons never count towards an exemption
    const other = new LaneAMeter();
    for (let i = 0; i < 60; i++) other.skip('budget', 'x');
    expect(coverage(['x'], other.snapshot()).exempt).toBe(0);
  });

  it('a checked bucket the list does not know is reported, and its diffs still count', () => {
    const meter = new LaneAMeter();
    meter.record('renamed|axis', { kind: 'ids', engine: [], mongo: [] }, {}, 1);
    const cov = coverage(['a'], meter.snapshot(), 1);
    expect(cov.unlisted).toEqual(['renamed|axis']);
    expect(cov.diffs).toBe(1);
    expect(cov.gate).toBe(false);
  });
});

describe('the per-process summary and the fleet gate', () => {
  const engines = (pools: LaneAMeter, rank: LaneAMeter, holders: LaneAMeter) => ({
    pools: { shadow: pools.snapshot() },
    rank: { shadow: rank.snapshot(), holderShadow: holders.snapshot() },
  });

  it('a model is ready only when lane A covers every bucket with zero diffs AND lane B passed every shard clean', () => {
    const pools = new LaneAMeter();
    const rank = new LaneAMeter();
    const holders = new LaneAMeter();
    fill(pools, poolsBuckets(), 50);
    const laneB = { checks: 10, diffs: 0, diffsByModel: { pools: 0, rank: 0 }, verify: { shards: { 'pools|1:uniswap-v4': { passes: 1 } } } };
    let s = shadowSummary({ engines: engines(pools, rank, holders), laneB, shards: SHARDS });
    expect(s.gate.pools.ready).toBe(true);
    expect(s.gate.rank.ready).toBe(false);
    // lane B: a confirmed rank diff does not block pools; no pass on a shard does
    s = shadowSummary({ engines: engines(pools, rank, holders), laneB: { ...laneB, diffsByModel: { pools: 0, rank: 1 } }, shards: SHARDS });
    expect(s.gate.pools.ready).toBe(true);
    s = shadowSummary({ engines: engines(pools, rank, holders), laneB: { ...laneB, verify: { shards: {} } }, shards: SHARDS });
    expect(s.gate.pools.ready).toBe(false);
    expect(s.gate.pools.laneB).toMatchObject({ clean: false, passedShards: 0, shards: 1 });
  });

  it('records add across replicas and restarts; garbled records are skipped', () => {
    const a = new LaneAMeter();
    const b = new LaneAMeter();
    fill(a, poolsBuckets(), 30);
    fill(b, poolsBuckets(), 20);
    const empty = new LaneAMeter();
    const recA = coverageRecord('replica-a', 1_000, 2_000, engines(a, empty, empty), { diffsByModel: { pools: 0 }, verify: { shards: { 'pools|1:uniswap-v4': { passes: 1 } } } });
    const recB = coverageRecord('replica-b', 500, 2_000, engines(b, empty, empty));
    const agg = aggregateCoverage([JSON.stringify(recA), JSON.stringify(recB), 'not json', '{}']);
    expect(agg.records).toBe(2);
    expect(agg.since).toBe(500);
    const gate = fleetGate(agg, SHARDS);
    expect(gate.coverage.pools.covered).toBe(160); // 30 + 20 = 50 per bucket
    expect(gate.gate.pools.ready).toBe(true);
    expect(gate.since).toBe(new Date(500).toISOString());
    // one replica alone is short of the minimum
    expect(fleetGate(aggregateCoverage([JSON.stringify(recA)]), SHARDS).gate.pools.ready).toBe(false);
  });

  it('only the CURRENT continuous shadow period counts: a gap of > 10 min starts a new one', () => {
    const a = new LaneAMeter();
    fill(a, poolsBuckets(), 50);
    const empty = new LaneAMeter();
    const H = 3_600_000;
    // A period that ended 2 h before the current one began (the model was off in between)…
    const old = coverageRecord('replica-a', 0, 10 * H, engines(a, empty, empty), { verify: { shards: { 'pools|1:uniswap-v4': { passes: 1 } } } });
    // …and the current one: two overlapping deploys, then a third 5 min after.
    const cur1 = coverageRecord('replica-b', 12 * H, 20 * H, engines(empty, empty, empty));
    const cur2 = coverageRecord('replica-c', 19 * H, 30 * H, engines(empty, empty, empty));
    const cur3 = coverageRecord('replica-d', 30 * H + 300_000, 40 * H, engines(empty, empty, empty));
    const agg = aggregateCoverage([old, cur1, cur2, cur3].map((r) => JSON.stringify(r)));
    expect(agg).toMatchObject({ records: 3, older: 1, since: 12 * H });
    // the old period's checks and passes are not summed into the current gate
    const gate = fleetGate(agg, SHARDS);
    expect(gate.coverage.pools.covered).toBe(0);
    expect(gate.gate.pools.laneB.passedShards).toBe(0);
    expect(gate.olderRecords).toBe(1);
  });

  it('heavy skips survive the cross-replica sum', () => {
    const a = new LaneAMeter();
    const b = new LaneAMeter();
    for (let i = 0; i < 30; i++) a.skip('heavy', 'h', i);
    for (let i = 0; i < 20; i++) b.skip('heavy', 'h', i);
    const empty = new LaneAMeter();
    const agg = aggregateCoverage([coverageRecord('a', 1, 2, engines(a, empty, empty)), coverageRecord('b', 1, 2, engines(b, empty, empty))].map((r) => JSON.stringify(r)));
    expect(agg.lanes.pools.buckets!.h).toEqual({ checks: 0, diffs: 0, heavy: 50 });
  });

  it('a record keeps only what the gate needs (no diff lines, no filter keys)', () => {
    const m = new LaneAMeter();
    m.record('x', { kind: 'ids', engine: ['secret'], mongo: [] }, { filterKey: 'k' }, 1);
    const rec = coverageRecord('r', 1, 2, { pools: { shadow: m.snapshot() } });
    expect(rec.lanes.pools).toEqual({ checks: 1, diffs: 1, buckets: { x: { checks: 1, diffs: 1 } } });
    expect(JSON.stringify(rec)).not.toContain('secret');
  });
});
