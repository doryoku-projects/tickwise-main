/*
 * Shared wiring for the rank engine specs (P-R R3): random positions shards
 * with MongoDB's odd corners, an R1 model store holding exactly those
 * documents, and the two leaderboard services the parity specs compare — the
 * ORACLE (today's Mongo path over mini-mongo shards) and the ENGINE (the same
 * service with the rank engine in `serve`).
 */
import mongoose from 'mongoose';
import { shardKey } from '../../src/read-models/core/fields.js';
import { ModelStore } from '../../src/read-models/core/model-store.js';
import { encodeCells } from '../../src/read-models/core/row-store.js';
import { normalizeDoc } from '../../src/read-models/feeder/normalize.js';
import type { ReadModelMode } from '../../src/read-models/flags.js';
import { RankEngineService } from '../../src/read-models/rank/rank-engine.service.js';
import { AlertLog } from '../../src/read-models/status.js';
import { PositionsRepository } from '../../src/database/positions.repository.js';
import { LeaderboardCountService } from '../../src/leaderboard/count-cache.js';
import { LeaderboardService } from '../../src/leaderboard/leaderboard.service.js';
import { equityAddresses } from '../../src/pricing/tokenized-equities.js';
import { miniModel, prng, type Doc } from '../support/mini-mongo.js';

const { ObjectId } = mongoose.mongo;

export const PROTO = 'uniswap-v4';
/** Not in chainId order on purpose: the all-chains order must break ties on chainId, not on config order. */
export const CHAINS = [42161, 1, 4663];

const HEX = '0123456789abcdef';

function hex(rand: () => number, n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) out += HEX[Math.floor(rand() * 16)];
  return out;
}

function pick<T>(rand: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rand() * xs.length)]!;
}

/** Owners, with collation-equal variants (`0x00a1…` == `0x0a01…`, binary different) and a case variant (not equal). */
export const OWNERS = [
  `0x00a1${'b'.repeat(36)}`,
  `0x0a01${'b'.repeat(36)}`,
  `0x00A1${'b'.repeat(36)}`,
  ...Array.from({ length: 30 }, (_, i) => `0x${i.toString(16).padStart(2, '0')}${'e'.repeat(38)}`),
];

/** Pools, with a collation-equal pair. */
export const POOLS = [
  `0x00a1${'c'.repeat(60)}`,
  `0x0a01${'c'.repeat(60)}`,
  ...Array.from({ length: 24 }, (_, i) => `0x${i.toString(16).padStart(2, '0')}${'d'.repeat(62)}`),
];

export const ADDRESSES = Array.from({ length: 30 }, (_, i) => `0x${i.toString(16).padStart(2, '0')}${'a'.repeat(38)}`);
/** A token collation-equal to an EXCLUDED address (`0x00a1…` excluded, `0x0a01…` held): out of the ranked shapes, in the pool shape. */
export const TWIN_EXCLUDED = `0x00a1${'f'.repeat(36)}`;
export const TWIN_HELD = `0x0a01${'f'.repeat(36)}`;

/** Excluded per chain (stable array identity, as `TokensRepository` keeps it). */
export const EXCLUDED = new Map<number, string[]>([
  [1, [ADDRESSES[0]!, ADDRESSES[1]!, TWIN_EXCLUDED, '0xnotinanyposition']],
  [42161, [ADDRESSES[2]!, TWIN_EXCLUDED]],
  [4663, [ADDRESSES[0]!, ADDRESSES[3]!]],
]);

const VALUES: unknown[] = [0, 0, 0, 0, -0, 0.3, 0.5, 1, 499.99, 500, 500, 600, 1000, 1500, 10_000, 25_000, 123.45, 1e6, NaN, null, undefined, -1, Infinity];
const PNLS: unknown[] = [NaN, null, undefined, -10, 0, 0, 5, 5, 100, Infinity, -Infinity, -0];
const APRS: unknown[] = [-20_000, -10_000, -5, 0, 0, 5, 5, 12.5, 9_999, 10_000, 10_001, NaN, null, undefined, Infinity, -Infinity];
const FEE_APRS: unknown[] = [0, 2, 2, 7, NaN, null, 1e6];
const ROIS: unknown[] = [-1_001, -1_000, -0.2, 0, 0.5, 1, 1_000, 1_001, NaN, null, undefined];
const TVLS: unknown[] = [0, -0, -5, 500, 777, 999, 1_000, 5_000, 1e6, NaN, null, undefined, -Infinity];
const CREATED: unknown[] = [1_700_000_000, 1_700_000_100, 1_700_000_100, 1_700_000_200, 1_700_000_300, null, undefined, NaN];

export interface PositionsOptions {
  /** Base positionId (positions of different chains overlap on purpose). */
  idBase?: number;
}

/** `n` random position documents of one chain. */
export function makePositions(seed: number, chainId: number, n: number, opts: PositionsOptions = {}): Doc[] {
  const rand = prng(seed * 7919 + chainId);
  const equity = equityAddresses(chainId);
  const docs: Doc[] = [];
  const base = opts.idBase ?? 1;
  for (let i = 0; i < n; i++) {
    const id = String(base + i * 2 + (chainId === 4663 ? 1 : 0));
    const address = () => {
      const r = rand();
      if (equity.length > 0 && r < 0.06) return pick(rand, equity);
      if (r < 0.1) return pick(rand, [TWIN_HELD, TWIN_EXCLUDED]);
      return pick(rand, ADDRESSES);
    };
    const metrics: Doc = {};
    const put = (key: string, xs: readonly unknown[]) => {
      const v = pick(rand, xs);
      if (v !== undefined) metrics[key] = v;
    };
    put('underlyingValueUsd', VALUES);
    put('poolPnlUsd', PNLS);
    put('aprExGas', APRS);
    put('feeApr', FEE_APRS);
    put('roi', ROIS);
    const inRange = pick(rand, [true, true, false, null, undefined]);
    if (inRange !== undefined) metrics.inRange = inRange;
    const ready = pick(rand, [true, true, true, false, undefined]);
    if (ready !== undefined) metrics.performanceReady = ready;
    const poolStats: Doc = {};
    const tvl = pick(rand, TVLS);
    if (tvl !== undefined) poolStats.tvlUsd = tvl;
    const pricing: Doc = {};
    const source = pick(rand, ['dex', 'dex', 'none', 'NONE', null, undefined]);
    if (source !== undefined) pricing.source = source;
    const fallback = pick(rand, [true, false, false, null, undefined]);
    if (fallback !== undefined) pricing.usedFallback = fallback;
    const doc: Doc = {
      _id: new ObjectId(),
      chainId,
      protocol: PROTO,
      positionId: id,
      tokenId: id,
      owner: pick(rand, OWNERS),
      poolId: pick(rand, POOLS),
      isActive: rand() < 0.75,
      token0: { address: address(), symbol: 'T0', decimals: 18 },
      token1: { address: address(), symbol: 'T1', decimals: 6 },
      metrics,
      poolStats,
      pricing,
      fee: 3000,
      tickSpacing: 60,
      tickLower: -60,
      tickUpper: 60,
      currentTick: 0,
      liquidity: '1',
      amounts: {},
      lastSyncedAt: new Date(1_790_000_000_000),
    };
    const created = pick(rand, CREATED);
    if (created !== undefined) doc.createdAtTimestamp = created;
    docs.push(doc);
  }
  return docs;
}

export function oidOf(doc: Doc): string {
  return (doc._id as { toHexString(): string }).toHexString();
}

/** Write one document's row into the store's table (insert or replace). */
export function upsertRow(store: ModelStore, chainId: number, doc: Doc): void {
  const table = store.ensureTable('rank', shardKey(chainId, PROTO));
  table.upsert(oidOf(doc), encodeCells(table.leaves, normalizeDoc('rank', doc), (value) => table.dict.intern(value)));
}

/** An R1 model store holding exactly `shards` (every table `ready`), at a fresh stream position. */
export function buildRankStore(shards: Map<number, Doc[]>): ModelStore {
  const store = new ModelStore(new Set(['rank']));
  for (const [chainId, docs] of shards) {
    const table = store.ensureTable('rank', shardKey(chainId, PROTO));
    for (const doc of docs) upsertRow(store, chainId, doc);
    table.state = 'ready';
  }
  touch(store);
  return store;
}

export function touch(store: ModelStore): void {
  const now = Date.now();
  store.pos = { ...store.pos, epoch: 1, s: store.pos.s + 1, ct: `${Math.floor(now / 1000)}:1`, ca: now };
}

/** The read-models surface the rank engine service uses, over `store`. */
export function fakeRankReadModels(store: ModelStore, chainIds: number[], mode: ReadModelMode = 'serve') {
  const self = {
    mode,
    alerts: new AlertLog({ warn: () => undefined }),
    configuredModes: () => ({ rank: self.mode, pools: 'off' as ReadModelMode }),
    effectiveMode: (model: string) => (model === 'rank' ? self.mode : 'off'),
    readiness: () => ({
      rank: {
        mode: self.mode,
        ready: true,
        caughtUp: true,
        dataAt: store.pos.ca,
        lagMs: 0,
        shards: Object.fromEntries(chainIds.map((c) => [shardKey(c, PROTO), { state: 'ready', rows: 0, ready: true, quarantine: {}, missingLeaves: [] }])),
      },
    }),
    rankSource: () => (self.mode === 'off' ? undefined : { store, shards: chainIds.map((chainId) => ({ chainId, protocol: PROTO })) }),
    registerStatus: () => undefined,
    shadowTicket: async () => true,
  };
  return self;
}

export function makeRankConfig(over: Record<string, unknown> = {}) {
  return {
    isSupportedChain: () => true,
    isSupportedProtocol: () => true,
    isProduction: false,
    leaderboardCountCap: 37,
    enabledIntegrations: CHAINS.map((chainId) => ({ chainId, protocol: PROTO })),
    getIntegration: () => undefined,
    readModelsWorkers: 0,
    readModelsGenerationMs: 1_000,
    readModelsMaxLagMs: 120_000,
    readModelsServePercent: 100,
    readModelsShadowSample: 0,
    readModelsShadowMaxPerMin: 60,
    readModelsRole: 'auto',
    ...over,
  };
}

/** A positions repository over mini-mongo shards (`shards` is read live: mutate it to change the data). */
export function positionsRepo(shards: Map<number, Doc[]>, config: ReturnType<typeof makeRankConfig>, hooks: Map<number, Parameters<typeof miniModel>[1]> = new Map()) {
  const models = new Map([...shards].map(([chainId, docs]) => [chainId, miniModel(docs, hooks.get(chainId))]));
  const resolver = { positionModel: (chainId: number) => models.get(chainId)!.model };
  const tokens = { readyLeaderboardExclusions: async (chainId: number) => ({ addresses: EXCLUDED.get(chainId) ?? [], ok: true }) };
  return { repo: new PositionsRepository(resolver as never, tokens as never, config as never), models };
}

/** The leaderboard service over a repository, optionally with the rank engine. */
export function leaderboardService(repo: PositionsRepository, config: ReturnType<typeof makeRankConfig>, rank?: RankEngineService): LeaderboardService {
  return new LeaderboardService(
    config as never,
    repo,
    { findForPosition: async () => [] } as never,
    { resolve: () => ({ recomputeMode: 'aggregates' }) } as never,
    new LeaderboardCountService(config as never),
    { positionTransactions: async () => ({ transactions: [] }) } as never,
    undefined,
    rank,
  );
}

/** The rank engine service over a store, built (one tick). */
export async function rankFor(store: ModelStore, config: ReturnType<typeof makeRankConfig>, mode: ReadModelMode = 'serve', chainIds = CHAINS) {
  const readModels = fakeRankReadModels(store, chainIds, mode);
  const rank = new RankEngineService(config as never, readModels as never);
  await rank.tick();
  return { rank, readModels };
}

export function shardsFor(seed: number, sizes: Record<number, number>): Map<number, Doc[]> {
  return new Map(CHAINS.map((chainId) => [chainId, makePositions(seed, chainId, sizes[chainId] ?? 0)]));
}

export const SORTS = ['apr', 'fee_apr', 'roi', 'age', 'pnl', 'underlying_value', 'nft_id_asc', 'nft_id_desc'] as const;
