/*
 * One write per position (2026-10-03) must store EXACTLY what the old two
 * writes stored.
 *
 * Before: `upsertMany` wrote the normalized row (token prices through
 * `preserveTokenPrice`, metrics through `refreshPerformanceFromStoredCashFlows`),
 * then `AggregateRecomputeService.recompute` re-read that document and
 * `updatePerformanceMetrics` `$set` `computePerformanceFromAggregates(doc)` onto
 * it, path by path. After: `upsertMany(…, { aggregates })` computes the same
 * thing on the merged document inside the one update.
 *
 * Both flows run here through the REAL repository and recompute code against a
 * fake model that only captures the operations. The captured updates are
 * applied to an in-memory document, and every stored state is cast through the
 * real `PositionSchema` (defaults included) — what the old second pass read
 * back is the cast document, not the update that produced it. The final
 * documents must be deep-equal.
 */
import mongoose from 'mongoose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PositionsRepository } from '../src/database/positions.repository.js';
import { PositionSchema } from '../src/database/schemas/position.schema.js';
import type { NormalizedPosition } from '../src/subgraph/normalized-position.js';
import { AggregateRecomputeService } from '../src/sync/aggregate-recompute.service.js';

/** Mainnet anchors: `preserveTokenPrice` carries their last positive price forward. */
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
/** On no list: never preserved. */
const LONGTAIL = '0x00000000000000000000000000000000deadbeef';

const Model = (mongoose.models.ParityPosition as mongoose.Model<unknown> | undefined)
  ?? mongoose.model('ParityPosition', PositionSchema);

type Doc = Record<string, unknown>;

beforeAll(() => {
  // Only Date: both flows stamp `lastSyncedAt` / `lastVerifiedAt` with `now`.
  vi.useFakeTimers({ now: new Date('2026-10-03T12:00:00Z'), toFake: ['Date'] });
});
afterAll(() => {
  vi.useRealTimers();
});

/** What Mongo would store: the document cast by the schema, ids/timestamps aside. */
function cast(doc: Doc): Doc {
  const plain = new Model(doc).toObject({ versionKey: false }) as Doc;
  return stripIds(plain) as Doc;
}

function stripIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripIds);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const out: Doc = {};
    for (const [k, v] of Object.entries(value as Doc)) {
      if (k === '_id' || k === 'createdAt' || k === 'updatedAt') continue;
      out[k] = stripIds(v);
    }
    return out;
  }
  return value;
}

function clone<T>(v: T): T {
  return v instanceof Date ? (new Date(v.getTime()) as T) : (structuredClone(v) as T);
}

function setPath(doc: Doc, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = doc;
  for (const p of parts.slice(0, -1)) {
    if (!cur[p] || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p] as Doc;
  }
  cur[parts.at(-1)!] = clone(value);
}

function unsetPath(doc: Doc, path: string): void {
  const parts = path.split('.');
  let cur: Doc | undefined = doc;
  for (const p of parts.slice(0, -1)) cur = cur?.[p] as Doc | undefined;
  if (cur) delete cur[parts.at(-1)!];
}

/** MongoDB's semantics for the operators these updates use. */
function applyUpdate(stored: Doc | undefined, filter: Doc, update: Doc): Doc {
  const doc: Doc = stored ? clone(stored) : { ...filter };
  for (const [k, v] of Object.entries((update.$set as Doc) ?? {})) setPath(doc, k, v);
  if (!stored) for (const [k, v] of Object.entries((update.$setOnInsert as Doc) ?? {})) setPath(doc, k, v);
  for (const k of Object.keys((update.$unset as Doc) ?? {})) unsetPath(doc, k);
  return doc;
}

/** A one-row shard: `find` answers with the stored row, `bulkWrite` records and applies. */
function shard(initial: Doc | undefined) {
  const state = { doc: initial ? cast(initial) : undefined, writes: 0 };
  const model = {
    find: vi.fn((_filter: Doc, projection?: Record<string, 1>) => ({
      lean: async () => {
        if (!state.doc) return [];
        if (!projection) return [clone(state.doc)];
        const row: Doc = {};
        for (const key of Object.keys(projection)) {
          const [top, sub] = key.split('.');
          const value = state.doc[top!];
          if (sub === undefined) row[top!] = clone(value);
          else if (value && typeof value === 'object') {
            row[top!] = { ...((row[top!] as Doc) ?? {}), [sub]: (value as Doc)[sub] };
          }
        }
        return [row];
      },
    })),
    bulkWrite: vi.fn(async (ops: Array<{ updateOne: { filter: Doc; update: Doc } }>) => {
      for (const op of ops) {
        state.doc = cast(applyUpdate(state.doc, op.updateOne.filter, op.updateOne.update));
        state.writes += 1;
      }
      return { upsertedCount: 0, modifiedCount: ops.length, matchedCount: ops.length };
    }),
  };
  const repo = new PositionsRepository({ positionModel: () => model } as never);
  return { state, model, repo };
}

/** The old flow: the plain upsert, then the separate aggregate recompute. */
async function twoPass(stored: Doc | undefined, position: NormalizedPosition, ethPriceNow: number) {
  const { state, repo } = shard(stored);
  await repo.upsertMany([position]);
  const recompute = new AggregateRecomputeService(repo, { currentNativeUsd: async () => ethPriceNow } as never);
  await recompute.recompute(position.chainId, position.protocol, [position.positionId]);
  return state;
}

/** The new flow: one upsert carrying the aggregates. */
async function onePass(stored: Doc | undefined, position: NormalizedPosition, ethPriceNow: number) {
  const { state, repo } = shard(stored);
  await repo.upsertMany([position], { aggregates: { ethPriceNow } });
  return state;
}

function normalized(over: Partial<NormalizedPosition> & {
  metrics?: Partial<NormalizedPosition['metrics']>;
  amounts?: Partial<NormalizedPosition['amounts']>;
} = {}): NormalizedPosition {
  const { metrics, amounts, ...rest } = over;
  return {
    chainId: 1,
    protocol: 'uniswap-v4',
    positionId: '424242',
    tokenId: '424242',
    owner: '0x1111111111111111111111111111111111111111',
    poolId: '0xpool',
    token0: { address: WETH, symbol: 'WETH', decimals: 18, verified: true, priceUsd: 3000, priceConfidence: 'anchor' },
    token1: { address: USDC, symbol: 'USDC', decimals: 6, verified: true, priceUsd: 1, priceConfidence: 'anchor' },
    fee: 3000,
    tickSpacing: 60,
    tickLower: -600,
    tickUpper: 600,
    currentTick: 12,
    sqrtPriceX96: '79228162514264337593543950336',
    liquidity: '123456789',
    isActive: true,
    createdAtTimestamp: 1_759_000_000,
    closedAtTimestamp: null,
    lastModifyBlock: 23_000_000,
    amounts: {
      amount0: '1.25',
      amount1: '4100.5',
      depositedToken0: '2',
      depositedToken1: '2000',
      depositedUsd: '0',
      withdrawnToken0: '0.75',
      withdrawnToken1: '0',
      withdrawnUsd: '0',
      totalFeesCollected0: '0.01',
      totalFeesCollected1: '33.3333333333333333',
      totalFeesCollectedUsd: '0',
      totalFeesUncollected0: '0.002',
      totalFeesUncollected1: '4.4',
      totalFeesUncollectedUsd: '10.4',
      totalGasCostEth: '0.0123',
      totalGasCostUsd: '0',
      diffToken0: '0',
      diffToken1: '0',
      diffUsd: '0',
      ...amounts,
    },
    metrics: {
      apr: 0,
      aprExGas: 0,
      feeApr: 0,
      poolApr: 0,
      roi: 0,
      pnlUsd: 0,
      pnlEth: 0,
      pnlHodl: 0,
      poolPnlUsd: 0,
      divergenceLossUsd: 0,
      underlyingValueUsd: 7850.5,
      nominalValueUsd: 7850.5,
      pendingFeesUsd: 10.4,
      collectedFeesUsd: 63.33,
      totalFeesUsd: 73.73,
      totalGasCostUsd: 0,
      investedUsd: 0,
      depositedUsd: 0,
      withdrawnUsd: 0,
      diffUsd: 0,
      unclaimedRewardsUsd: 1.5,
      claimedRewardsUsd: 2.25,
      ageSeconds: 40 * 86_400,
      inRange: true,
      isPriceable: true,
      unrealizableLeg: false,
      priceUnavailable: false,
      performanceReady: false,
      performanceSource: 'pending-transactions',
      aprWarmup: false,
      feesSource: 'indexer',
      feesMeasuredAt: null,
      ...metrics,
    },
    poolStats: { tvlUsd: 1_000_000, tvlUsdUntracked: 0, volumeUsd: 50_000, totalFeesUsd: 150, priceDivergence: 0 },
    pricing: { source: 'subgraph-current', usedFallback: false, pricedAt: new Date('2026-10-03T11:59:00Z') },
    rawSubgraph: {},
    ...rest,
  } as NormalizedPosition;
}

/** A row as a previous sync (upsert + recompute) left it. */
async function previouslyStored(position: NormalizedPosition, ethPriceNow = 2900): Promise<Doc> {
  return (await twoPass(undefined, position, ethPriceNow)).doc!;
}

const CASES: Array<{
  name: string;
  stored: () => Promise<Doc | undefined>;
  position: NormalizedPosition;
  ethPriceNow: number;
  expectSource: string;
}> = [
  {
    name: 'a first insert (no previous row)',
    stored: async () => undefined,
    position: normalized(),
    ethPriceNow: 3150,
    expectSource: 'ponder-aggregates',
  },
  {
    name: 'an update of a ready row (refreshPerformanceFromStoredCashFlows runs first)',
    stored: () => previouslyStored(normalized({ metrics: { underlyingValueUsd: 7000, pendingFeesUsd: 3 } })),
    position: normalized({ metrics: { underlyingValueUsd: 8100, pendingFeesUsd: 12 } }),
    ethPriceNow: 3150,
    expectSource: 'ponder-aggregates',
  },
  {
    name: 'isPriceable=false (invalid-valuation)',
    stored: () => previouslyStored(normalized()),
    position: normalized({ metrics: { isPriceable: false, underlyingValueUsd: 0 } }),
    ethPriceNow: 3150,
    expectSource: 'invalid-valuation',
  },
  {
    name: 'no deposit (pending-aggregates)',
    stored: () => previouslyStored(normalized()),
    position: normalized({ amounts: { depositedToken0: '0', depositedToken1: '0' } }),
    ethPriceNow: 3150,
    expectSource: 'pending-aggregates',
  },
  {
    name: 'a missing price on a token that is not preserved (pending-prices)',
    stored: () =>
      previouslyStored(
        normalized({ token1: { address: LONGTAIL, symbol: 'LT', decimals: 18, verified: false, priceUsd: 0.5 } }),
      ),
    position: normalized({ token1: { address: LONGTAIL, symbol: 'LT', decimals: 18, verified: false, priceUsd: 0 } }),
    ethPriceNow: 3150,
    expectSource: 'pending-prices',
  },
  {
    name: 'a missing anchor price rescued by preserveTokenPrice (computed with the PRESERVED price)',
    stored: () => previouslyStored(normalized()),
    position: normalized({
      token1: { address: USDC, symbol: 'USDC', decimals: 6, verified: false, priceUsd: 0 },
    }),
    ethPriceNow: 3150,
    expectSource: 'ponder-aggregates',
  },
  {
    name: 'an active → closed transition ($unset / txSyncStatus)',
    stored: () => previouslyStored(normalized()),
    position: normalized({
      isActive: false,
      closedAtTimestamp: 1_759_500_000,
      amounts: { amount0: '0', amount1: '0', withdrawnToken0: '2', withdrawnToken1: '2000' },
      metrics: { underlyingValueUsd: 0, pendingFeesUsd: 0, inRange: false },
    }),
    ethPriceNow: 3150,
    expectSource: 'ponder-aggregates',
  },
  {
    name: 'an unknown native price (gas falls back to tx-time USD) on a young position (aprWarmup)',
    stored: async () => undefined,
    position: normalized({ metrics: { ageSeconds: 3_600 } }),
    ethPriceNow: 0,
    expectSource: 'ponder-aggregates',
  },
];

describe('one write per position — parity with the old upsert + aggregate recompute', () => {
  it.each(CASES)('$name', async ({ stored, position, ethPriceNow, expectSource }) => {
    const initial = await stored();
    const before = await twoPass(initial, position, ethPriceNow);
    const after = await onePass(initial, position, ethPriceNow);

    expect(after.doc).toEqual(before.doc);
    // …in one write instead of two.
    expect(before.writes).toBe(2);
    expect(after.writes).toBe(1);
    // The case reaches the branch it is named after.
    expect((after.doc!.metrics as Doc).performanceSource).toBe(expectSource);
  });

  it('computes on the PRESERVED token price, not the normalized 0', async () => {
    const initial = await previouslyStored(normalized());
    const after = await onePass(
      initial,
      normalized({ token1: { address: USDC, symbol: 'USDC', decimals: 6, verified: false, priceUsd: 0 } }),
      3150,
    );
    expect((after.doc!.token1 as Doc).priceUsd).toBe(1);
    expect((after.doc!.metrics as Doc).performanceReady).toBe(true);
  });

  it('without `aggregates` the upsert writes what it always wrote (transaction-mode adapters)', async () => {
    const position = normalized();
    const plain = shard(undefined);
    await plain.repo.upsertMany([position]);
    expect((plain.state.doc!.metrics as Doc).performanceReady).toBe(false);
    expect((plain.state.doc!.metrics as Doc).performanceSource).toBe('pending-transactions');
  });

  it('does not mutate the caller\'s NormalizedPosition', async () => {
    const position = normalized();
    const snapshot = structuredClone(position);
    await onePass(undefined, position, 3150);
    expect(position).toEqual(snapshot);
  });
});
