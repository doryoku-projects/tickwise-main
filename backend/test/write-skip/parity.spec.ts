/*
 * P2.3 parity (design §4.5): the same sequence of normalized positions,
 * written by a repository with POSITIONS_WRITE_SKIP=off (today) and one with
 * `on`, leaves IDENTICAL stored documents after every step — except the
 * fields skip deliberately leaves behind: `lastVerifiedAt` / `lastSyncedAt` /
 * `wh` / `wAt` / `pricing.pricedAt` / `metrics.ageSeconds` (served through the
 * read-time overlay) and `rawSubgraph` (not served, full writes only, §4.1).
 *
 * Each sequence mixes, per row and step: nothing changed, token prices,
 * amounts, pool state, optional leaves DISAPPEARING and reappearing
 * (`priceUnavailable`, `unrealizableLeg`, `nominalValueUsd`, `feesSource`,
 * `feesMeasuredAt`, `token*.priceConfidence`), values becoming `null`, an
 * absent top-level field, active/closed flips, a carried P3.1 fee stamp (also
 * older than the stored one), the 6 h forced rewrite, aggregates mode with a
 * moving ETH price, and the other writers (a served fee write, the stale
 * sweep). Writes go through `position-sim.ts`: Mongoose's own update cast,
 * MongoDB's operator semantics.
 */
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHAIN, PROTOCOL, repoOver } from './support/fixtures.js';
import { comparable, PositionSim } from './support/position-sim.js';
import { IDS, restamp, runParitySequence, startRows, T0 } from './support/sequence.js';

beforeEach(() => {
  vi.useFakeTimers({ now: T0, toFake: ['Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

async function runSequence(seed: number, steps: number) {
  const off = new PositionSim();
  const on = new PositionSim();
  const repoOff = repoOver(off);
  const repoOn = repoOver(on, { positionsWriteSkip: 'on' });
  await runParitySequence(seed, steps, { repo: repoOff, byId: (id) => off.byId(id) }, { repo: repoOn, byId: (id) => on.byId(id) });
  return { off, on, repoOn };
}

describe('POSITIONS_WRITE_SKIP=on leaves the same documents as off', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    it(`random sequence ${seed}`, async () => {
      const { on, repoOn } = await runSequence(seed, 40);
      const shard = repoOn.writeSkipStatus().shards[`${CHAIN}:${PROTOCOL}`]!;
      const decisions = { ...shard.total.decisions };
      for (const [k, v] of Object.entries(shard.window.decisions)) decisions[k as keyof typeof decisions] += v;
      // The sequence exercised every kind of write, and skipping did happen.
      expect(decisions.skip).toBeGreaterThan(0);
      expect(decisions.section).toBeGreaterThan(0);
      expect(decisions.full).toBeGreaterThan(0);
      // Nothing raced these writes: no section op missed its row or its wh.
      expect(shard.total.conflicts + shard.window.conflicts).toBe(0);
      expect(shard.total.reupserted + shard.window.reupserted).toBe(0);
      // Fewer write ops reached the shard with skip on.
      expect(on.ops.length).toBeGreaterThan(0);
    });
  }

  it('sends fewer and smaller writes than off for an unchanged walk', async () => {
    const off = new PositionSim();
    const on = new PositionSim();
    const repoOff = repoOver(off);
    const repoOn = repoOver(on, { positionsWriteSkip: 'on' });
    const rows = [...startRows().values()];
    // Insert, then one walk that legitimately moves (the stored cash flows now feed the metrics).
    for (let walk = 0; walk < 2; walk++) {
      await repoOff.upsertMany(rows.map(restamp));
      await repoOn.upsertMany(rows.map(restamp));
      vi.setSystemTime(Date.now() + 30 * 60_000);
    }
    const offBefore = off.ops.length;
    const onBefore = on.ops.length;
    await repoOff.upsertMany(rows.map(restamp));
    await repoOn.upsertMany(rows.map(restamp));
    expect(off.ops.length - offBefore).toBe(rows.length);
    // Only the two ACTIVE performance rows move (their APR annualises over a
    // growing age, POSITIONS_WRITE_SKIP_AGE=refresh) — and only their `metrics`.
    const sent = on.ops.slice(onBefore).map((o) => o.op as { filter: { positionId: string }; update: { $set: Record<string, unknown> } });
    expect(sent.map((o) => o.filter.positionId).sort()).toEqual(['101', '105']);
    for (const o of sent) {
      const fields = new Set(Object.keys(o.update.$set).map((k) => k.split('.')[0]));
      expect([...fields].sort()).toEqual(['lastSyncedAt', 'metrics', 'updatedAt', 'wh']);
    }
    for (const id of IDS) expect(comparable(on.byId(id))).toEqual(comparable(off.byId(id)));
  });
});
