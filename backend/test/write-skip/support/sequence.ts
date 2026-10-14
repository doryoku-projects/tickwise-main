/*
 * The random write sequences of the P2.3 parity specs (`parity.spec.ts` over
 * the in-memory shard, `real-mongo-parity.spec.ts` over a real mongod): the
 * same normalized positions written by a skip-`off` and a skip-`on`
 * repository, with the other writers interleaved, compared after every step.
 */
import { expect, vi } from 'vitest';
import type { PositionsRepository } from '../../../src/database/positions.repository.js';
import type { NormalizedPosition } from '../../../src/subgraph/normalized-position.js';
import { CHAIN, normalized, prng, PROTOCOL } from './fixtures.js';
import { comparable, type Doc } from './position-sim.js';

export const T0 = new Date('2026-10-04T00:00:00Z');

/** One side of a parity run: a repository and how to read its stored row. */
export interface ParityShard {
  repo: PositionsRepository;
  byId(positionId: string): Promise<Doc | undefined> | Doc | undefined;
}

export const IDS = ['101', '102', '103', '104', '105', '106'];

export function startRows(): Map<string, NormalizedPosition> {
  const rows = new Map<string, NormalizedPosition>();
  for (const [i, id] of IDS.entries()) {
    const closed = i % 3 === 2;
    rows.set(
      id,
      normalized({
        positionId: id,
        tokenId: id,
        isActive: !closed,
        closedAtTimestamp: closed ? 1_759_500_000 : null,
        createdAtTimestamp: 1_759_000_000 + i * 1000,
        metrics: i % 2 === 0 ? { performanceReady: true, depositedUsd: 8000, withdrawnUsd: 0, collectedFeesUsd: 60 } : {},
      }),
    );
  }
  return rows;
}

type Mutation = (p: NormalizedPosition, rand: () => number, step: number) => NormalizedPosition;

const OPTIONAL_LEAVES = ['priceUnavailable', 'unrealizableLeg', 'nominalValueUsd', 'feesSource', 'feesMeasuredAt'] as const;

const MUTATIONS: Array<[number, Mutation]> = [
  [30, (p) => p], // unchanged
  [12, (p, r) => ({ ...p, token0: { ...p.token0, priceUsd: Math.round(2500 + r() * 1000) } })],
  [8, (p, r) => ({ ...p, token1: { ...p.token1, priceUsd: r() < 0.5 ? 1 : 0.9995 } })],
  [8, (p, r) => ({ ...p, amounts: { ...p.amounts, amount0: (r() * 3).toFixed(4), totalFeesUncollected1: (r() * 9).toFixed(3) } })],
  [6, (p, r) => ({ ...p, currentTick: Math.round(-700 + r() * 1400), sqrtPriceX96: String(79228162514264337593543950336n + BigInt(Math.round(r() * 1e9))) })],
  [8, (p, r) => {
    // An optional leaf disappears (or comes back).
    const leaf = OPTIONAL_LEAVES[Math.floor(r() * OPTIONAL_LEAVES.length)]!;
    const metrics = { ...p.metrics } as Record<string, unknown>;
    if (leaf in metrics) delete metrics[leaf];
    else metrics[leaf] = leaf === 'feesSource' ? 'onchain' : leaf === 'feesMeasuredAt' ? new Date(T0.getTime() - 60_000) : leaf === 'nominalValueUsd' ? 7000 : true;
    return { ...p, metrics: metrics as NormalizedPosition['metrics'] };
  }],
  [4, (p) => {
    const token0 = { ...p.token0 } as Record<string, unknown>;
    if ('priceConfidence' in token0) delete token0.priceConfidence;
    else token0.priceConfidence = 'external-verified';
    return { ...p, token0: token0 as NormalizedPosition['token0'] };
  }],
  [5, (p, r) => ({
    ...p,
    metrics: { ...p.metrics, poolApr: r() < 0.5 ? (null as unknown as number) : 3.5, feesMeasuredAt: r() < 0.5 ? null : p.metrics.feesMeasuredAt },
    poolStats: { ...p.poolStats, priceDivergence: r() < 0.5 ? (null as unknown as number) : 0.01 },
  })],
  [3, (p) => ({ ...p, lastModifyBlock: p.lastModifyBlock === undefined ? 23_000_500 : undefined })],
  [3, (p) => ({
    ...p,
    isActive: !p.isActive,
    closedAtTimestamp: p.isActive ? Math.floor(Date.now() / 1000) - 100 : null,
  })],
  [6, (p, r, step) => {
    // A fresh P3.1 reading carried by the walk; sometimes OLDER than the stored one.
    const block = 23_100_000 + step * 10 - (r() < 0.3 ? 1_000 : 0);
    return {
      ...p,
      rpcFeesUncollected0: (r() * 0.01).toFixed(6),
      rpcFeesUncollected1: (r() * 5).toFixed(4),
      rpcFeesBlock: block,
      rpcFeesAt: new Date(),
      metrics: { ...p.metrics, feesSource: 'onchain', feesMeasuredAt: new Date() },
    };
  }],
];

function pick(rand: () => number): Mutation {
  const total = MUTATIONS.reduce((s, [w]) => s + w, 0);
  let x = rand() * total;
  for (const [w, m] of MUTATIONS) {
    if ((x -= w) < 0) return m;
  }
  return MUTATIONS[0]![1];
}

/** Today's normalize stamps: the clock-driven fields move with every walk. */
export function restamp(p: NormalizedPosition): NormalizedPosition {
  const nowSec = Math.floor(Date.now() / 1000);
  const end = p.closedAtTimestamp && p.closedAtTimestamp > p.createdAtTimestamp ? p.closedAtTimestamp : nowSec;
  const { rpcFeesUncollected0: _a, rpcFeesUncollected1: _b, rpcFeesBlock: _c, rpcFeesAt: _d, ...rest } = p;
  return {
    ...rest,
    metrics: { ...p.metrics, ageSeconds: Math.max(0, end - p.createdAtTimestamp) },
    pricing: { ...p.pricing, pricedAt: new Date() },
    rawSubgraph: { ...p.rawSubgraph, seenAt: nowSec },
  };
}

/**
 * `steps` random steps (seeded). `timeJumps` = sometimes jump 8 h (past the
 * forced rewrite); off for a real mongod, whose driver keeps its own clock.
 */
export async function runParitySequence(
  seed: number,
  steps: number,
  off: ParityShard,
  on: ParityShard,
  opts: { timeJumps?: boolean } = {},
): Promise<void> {
  const rand = prng(seed);
  let rows = startRows();
  let ethPrice = 3000;
  for (let step = 0; step < steps; step++) {
    // Time moves: mostly minutes, sometimes past the forced rewrite.
    const jump = rand() < 0.1 && opts.timeJumps !== false;
    vi.setSystemTime(Date.now() + (jump ? 8 * 3_600_000 : Math.round(60_000 + rand() * 40 * 60_000)));
    if (rand() < 0.15) ethPrice = Math.round(2500 + rand() * 1500);
    const next = new Map<string, NormalizedPosition>();
    const batch: NormalizedPosition[] = [];
    for (const [id, row] of rows) {
      const base = restamp(row);
      const mutated = pick(rand)(base, rand, step);
      next.set(id, mutated);
      if (rand() < 0.85) batch.push(mutated);
    }
    rows = next;
    const upsertOpts = rand() < 0.6 ? { aggregates: { ethPriceNow: rand() < 0.1 ? 0 : ethPrice } } : {};
    await off.repo.upsertMany(batch, upsertOpts);
    await on.repo.upsertMany(batch, upsertOpts);

    // The other writers, applied to both shards alike.
    if (rand() < 0.15) {
      const id = IDS[Math.floor(rand() * IDS.length)]!;
      for (const shard of [off, on]) {
        const doc = await shard.byId(id);
        if (!doc || doc.isActive !== true) continue;
        await shard.repo.writeRpcFees(CHAIN, PROTOCOL, [
          {
            positionId: id,
            fees0: '0.003',
            fees1: '7.5',
            block: 99_000_000 + step,
            served: { 'metrics.pendingFeesUsd': 16.5, 'amounts.totalFeesUncollectedUsd': '16.5', 'metrics.feesSource': 'onchain' },
            version: doc.updatedAt as Date,
          },
        ]);
      }
    }
    if (rand() < 0.1) {
      const seen = new Set(IDS.filter(() => rand() < 0.7));
      await off.repo.markMissingStale(CHAIN, PROTOCOL, seen, 3);
      await on.repo.markMissingStale(CHAIN, PROTOCOL, seen, 3);
    }

    for (const id of IDS) {
      expect(comparable(await on.byId(id)), `seed ${seed} step ${step} position ${id}`).toEqual(comparable(await off.byId(id)));
    }
  }
}
