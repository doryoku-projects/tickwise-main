/*
 * Shared wiring for the pool catalog specs (P-R R2): random pools shards with
 * MongoDB's odd corners, an R1 model store holding exactly those documents,
 * and the two pools services the parity specs compare — the ORACLE (today's
 * Mongo path over mini-mongo shards) and the ENGINE (the same service with the
 * pool catalog in `serve`).
 */
import mongoose from 'mongoose';
import { shardKey } from '../../src/read-models/core/fields.js';
import { ModelStore } from '../../src/read-models/core/model-store.js';
import { encodeCells } from '../../src/read-models/core/row-store.js';
import { normalizeDoc } from '../../src/read-models/feeder/normalize.js';
import type { ReadModelMode } from '../../src/read-models/flags.js';
import { PoolCatalogService } from '../../src/read-models/pools/pool-catalog.service.js';
import { AlertLog } from '../../src/read-models/status.js';
import { PoolsRepository } from '../../src/database/pools.repository.js';
import { LeaderboardCountService } from '../../src/leaderboard/count-cache.js';
import { PoolsService } from '../../src/pools/pools.service.js';
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

/** A pool id; one in four shares one of a few 8-byte prefixes (`0x` + 6 hex), so the full-id tie path runs. */
export function poolIdFor(rand: () => number): string {
  if (rand() < 0.25) return `0x${['abcdef', '000000', 'ffffff', '123456'][Math.floor(rand() * 4)]}${hex(rand, 58)}`;
  return `0x${hex(rand, 64)}`;
}

export const ADDRESSES = Array.from({ length: 40 }, (_, i) => `0x${i.toString(16).padStart(2, '0')}${'a'.repeat(38)}`);
/** Excluded per chain (stable array identity, as `TokensRepository` keeps it). */
export const EXCLUDED = new Map<number, string[]>([
  [1, [ADDRESSES[0], ADDRESSES[1], '0xnotinanypool']],
  [42161, [ADDRESSES[2]]],
  [4663, [ADDRESSES[0], ADDRESSES[3], ADDRESSES[4]]],
]);

export const SYMBOLS = [
  'USDC',
  'usdc',
  'Usdc',
  'WETH',
  'weth',
  'ETH',
  'ſtable',
  'stable',
  'KELVIN',
  'Kelvin K',
  'Ünï',
  '金狗',
  '🍏',
  'APPLЕ',
  'a.b',
  '(x)',
  'back\\slash',
  'x',
  '',
  'USD Coin',
  'ab12',
  'AB12',
  '0xdeadbeef',
  'line\nbreak',
  'İstanbul',
];

/** Values for numeric fields, MongoDB's odd corners included (no odd TYPES: those quarantine). */
const NUMBERS: unknown[] = [0, 0, 0, 0, -0, 1, 5, 5, 10_000, 10_000, 10_001, 123.45, 99_999.5, 1e6, 6e10, 5e10, -5, NaN, Infinity, -Infinity, null, undefined];

function pick<T>(rand: () => number, xs: readonly T[]): T {
  return xs[Math.floor(rand() * xs.length)]!;
}

/** `n` random pool documents of one chain. */
export function makePools(seed: number, chainId: number, n: number, opts: { missingAddresses?: boolean } = {}): Doc[] {
  const rand = prng(seed + chainId);
  const equity = equityAddresses(chainId);
  const docs: Doc[] = [];
  const ids = new Set<string>();
  for (let i = 0; i < n; i++) {
    let poolId = poolIdFor(rand);
    while (ids.has(poolId)) poolId = poolIdFor(rand);
    ids.add(poolId);
    const address = () => (equity.length > 0 && rand() < 0.08 ? pick(rand, equity) : pick(rand, ADDRESSES));
    const token = () => {
      // Opt-in: rarely no address at all ($nin lets it through, $in never matches it). The
      // pools response builder itself throws on such a pool (`address.toLowerCase()`, both paths).
      const t: Doc = opts.missingAddresses && rand() < 0.01 ? { decimals: 18 } : { address: opts.missingAddresses && rand() < 0.005 ? null : address(), decimals: 18 };
      const symbol = rand() < 0.05 ? undefined : pick(rand, SYMBOLS);
      if (symbol !== undefined) t.symbol = symbol;
      return t;
    };
    const metrics: Doc = {};
    for (const key of ['tvlUsd', 'volumeUsd24h', 'feesUsd24h', 'feeApr']) {
      // Stubs: mostly 0 TVL, like Robinhood's.
      const value = key === 'tvlUsd' && rand() < 0.5 ? 0 : pick(rand, NUMBERS);
      if (value !== undefined) metrics[key] = value;
    }
    metrics.txCount = 1;
    const pricing: Doc = {};
    const source = pick(rand, ['none', 'none', 'none', 'NONE', 'stable-anchor', 'external', null, undefined]);
    if (source !== undefined) pricing.source = source;
    const usedFallback = pick(rand, [true, true, false, false, null, undefined]);
    if (usedFallback !== undefined) pricing.usedFallback = usedFallback;
    const doc: Doc = {
      _id: new ObjectId(),
      chainId,
      protocol: PROTO,
      poolId,
      token0: token(),
      token1: token(),
      fee: 3000,
      tickSpacing: 60,
      currentTick: 0,
      sqrtPriceX96: '0',
      liquidity: '0',
      pricing,
      updatedAt: new Date(1_790_000_000_000),
    };
    const created = pick(rand, [1_700_000_000, 1_700_000_000, 1_700_000_100, 1_700_000_200, null, undefined, NaN]);
    if (created !== undefined) doc.createdAtTimestamp = created;
    if (rand() < 0.03) delete doc.pricing;
    doc.metrics = rand() < 0.02 ? null : metrics;
    docs.push(doc);
  }
  return docs;
}

export function oidOf(doc: Doc): string {
  return (doc._id as { toHexString(): string }).toHexString();
}

/** Write one document's row into the store's table (insert or replace). */
export function upsertRow(store: ModelStore, chainId: number, doc: Doc): void {
  const table = store.ensureTable('pools', shardKey(chainId, PROTO));
  table.upsert(oidOf(doc), encodeCells(table.leaves, normalizeDoc('pools', doc), (value) => table.dict.intern(value)));
}

/** An R1 model store holding exactly `shards` (every table `ready`), at a fresh stream position. */
export function buildStore(shards: Map<number, Doc[]>): ModelStore {
  const store = new ModelStore(new Set(['pools']));
  for (const [chainId, docs] of shards) {
    const table = store.ensureTable('pools', shardKey(chainId, PROTO));
    for (const doc of docs) upsertRow(store, chainId, doc);
    table.state = 'ready';
  }
  touch(store);
  return store;
}

/** Move the store's stream position to "now" (fresh `ct` / `ca`). */
export function touch(store: ModelStore): void {
  const now = Date.now();
  store.pos = { ...store.pos, epoch: 1, s: store.pos.s + 1, ct: `${Math.floor(now / 1000)}:1`, ca: now };
}

/** The read-models surface the catalog service uses, over `store`. */
export function fakeReadModels(store: ModelStore, chainIds: number[], mode: ReadModelMode = 'serve') {
  const self = {
    mode,
    alerts: new AlertLog({ warn: () => undefined }),
    tickets: 0,
    configuredModes: () => ({ rank: 'off' as ReadModelMode, pools: self.mode }),
    effectiveMode: (model: string) => (model === 'pools' ? self.mode : 'off'),
    readiness: () => ({
      pools: {
        mode: self.mode,
        ready: true,
        caughtUp: true,
        dataAt: store.pos.ca,
        lagMs: 0,
        shards: Object.fromEntries(chainIds.map((c) => [shardKey(c, PROTO), { state: 'ready', rows: 0, ready: true, quarantine: {}, missingLeaves: [] }])),
      },
    }),
    catalogSource: () => (self.mode === 'off' ? undefined : { store, shards: chainIds.map((chainId) => ({ chainId, protocol: PROTO })) }),
    registerStatus: () => undefined,
    shadowTicket: async () => {
      self.tickets++;
      return true;
    },
  };
  return self;
}

export function makeConfig(over: Record<string, unknown> = {}) {
  return {
    isSupportedChain: () => true,
    isSupportedProtocol: () => true,
    isProduction: false,
    leaderboardCountCap: 37,
    enabledIntegrations: CHAINS.map((chainId) => ({ chainId, protocol: PROTO })),
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

/** A pools repository over mini-mongo shards (`shards` is read live: mutate it to change the data). */
export function poolsRepo(shards: Map<number, Doc[]>, config: ReturnType<typeof makeConfig>, hooks: Map<number, Parameters<typeof miniModel>[1]> = new Map()) {
  const models = new Map([...shards].map(([chainId, docs]) => [chainId, miniModel(docs, hooks.get(chainId))]));
  const resolver = { poolModel: (chainId: number) => models.get(chainId)!.model };
  const tokens = { readyLeaderboardExclusions: async (chainId: number) => ({ addresses: EXCLUDED.get(chainId) ?? [], ok: true }) };
  return { repo: new PoolsRepository(resolver as never, tokens as never, config as never), models };
}

function hash(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (Math.imul(h, 31) + value.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Holder counts, deterministic per pool (both services get the same). */
export const positionsFake = {
  countsByPoolIds: async (_chainId: number, _protocol: string, ids: string[]) =>
    new Map(ids.map((id) => [id.toLowerCase(), { positionsCount: hash(id) % 7, holdersCount: hash(id) % 3 }])),
};

export const tokensFake = { findLatestPrices: async () => new Map(), findLatestPricesForRead: async () => new Map() };

export function poolsService(repo: PoolsRepository, config: ReturnType<typeof makeConfig>, catalog?: PoolCatalogService): PoolsService {
  return new PoolsService(config as never, repo, positionsFake as never, tokensFake as never, new LeaderboardCountService(config as never), catalog);
}

/** The catalog service over a store, built (one tick). */
export async function catalogFor(store: ModelStore, config: ReturnType<typeof makeConfig>, mode: ReadModelMode = 'serve') {
  const readModels = fakeReadModels(store, CHAINS, mode);
  const catalog = new PoolCatalogService(config as never, readModels as never);
  await catalog.tick();
  return { catalog, readModels };
}

/**
 * Random shards. Some pools of 42161 carry the SAME poolId (and TVL) as a pool
 * of chain 1 — the all-chains order then breaks their tie on chainId.
 */
export function shardsFor(seed: number, sizes: Record<number, number>, opts: { missingAddresses?: boolean } = {}): Map<number, Doc[]> {
  const shards = new Map(CHAINS.map((chainId) => [chainId, makePools(seed, chainId, sizes[chainId] ?? 0, opts)]));
  const one = shards.get(1) ?? [];
  const arb = shards.get(42161) ?? [];
  for (let i = 0; i < Math.min(40, one.length, arb.length); i++) {
    arb[i]!.poolId = one[i]!.poolId;
    arb[i]!.metrics = one[i]!.metrics === null ? null : { ...(one[i]!.metrics as Doc) };
    arb[i]!.createdAtTimestamp = one[i]!.createdAtTimestamp;
  }
  return shards;
}
