/*
 * The fee service built with its P2/P3 ctor params (coordination, RPC fetch,
 * hint publisher) on top of the shared fee harness's fakes: a fake Mongo
 * (pages, by-id reads, writes), the fake cursor row and the fake viem client.
 * Plus a "secondary" for the RAM store's load that serves the same rows.
 */
import { vi } from 'vitest';
import type { FeeRefreshCandidate, RpcFeeWrite } from '../../src/database/positions.repository.js';
import { emptyFeePassTally, FEE_PASS_TALLY_KEYS, type FeePassTally, type FeeTier, type FeeTierCursor } from '../../src/database/sync.repository.js';
import type { FeeStoreDoc, FeeStoreSource } from '../../src/sync/fee-candidate-feed.js';
import type { FeeCoordination } from '../../src/sync/fee-signals.js';
import { PositionFeeRefreshService } from '../../src/sync/position-fee-refresh.service.js';
import { CHAIN, MIN, PROTO, candidate, fakeClient, type Respond } from '../fee-refresh-harness.js';

export { CHAIN, MIN, PROTO, candidate };

/** The doc the store's secondary walk would read for a candidate. */
export function docOf(c: FeeRefreshCandidate): FeeStoreDoc {
  return {
    positionId: c.positionId,
    tokenId: c.tokenId,
    poolId: c.poolId,
    tickLower: c.tickLower,
    tickUpper: c.tickUpper,
    lastModifyBlock: c.lastModifyBlock,
    token0: { decimals: c.decimals0, priceUsd: c.stored.token0.priceUsd },
    token1: { decimals: c.decimals1, priceUsd: c.stored.token1.priceUsd },
    metrics: {
      feesSource: c.stored.metrics.feesSource,
      isPriceable: c.stored.metrics.isPriceable,
      pendingFeesUsd: c.stored.metrics.pendingFeesUsd,
    },
    updatedAt: c.version ?? new Date(1_000),
    ...(c.rpc
      ? { rpcFeesUncollected0: c.rpc.fees0, rpcFeesUncollected1: c.rpc.fees1, rpcFeesBlock: c.rpc.block, rpcFeesAt: c.rpc.at }
      : {}),
  };
}

/** A candidate already measured on-chain at (2, 3) — what the fake StateView answers — and served from it. */
export function measured(tokenId: string, over: Partial<FeeRefreshCandidate> = {}): FeeRefreshCandidate {
  const base = candidate(tokenId);
  return {
    ...base,
    stored: { ...base.stored, metrics: { isPriceable: true, pendingFeesUsd: 5, feesSource: 'onchain' } },
    rpc: { fees0: '2', fees1: '3', block: 900, at: new Date(Date.now() - MIN) },
    version: new Date(1_000),
    ...over,
  };
}

export interface P3HarnessOpts {
  rows?: FeeRefreshCandidate[];
  cursors?: Partial<Record<FeeTier, FeeTierCursor>>;
  config?: Record<string, unknown>;
  blocks?: number[];
  respond?: Respond;
  coord?: FeeCoordination;
  /** The store's secondary; default serves `rows`. */
  source?: FeeStoreSource;
  /** saveFeeCursor's answer (a fenced repository answers false when deposed). */
  saveAnswer?: () => boolean | void;
}

export function makeP3Harness(opts: P3HarnessOpts = {}) {
  const rows = opts.rows ?? Array.from({ length: 5 }, (_, i) => measured(String(10 + i)));
  const byId = () => new Map(rows.map((r) => [r.positionId, r]));
  const sorted = () => [...rows].sort((a, b) => (a.tokenId < b.tokenId ? -1 : 1));
  const store: Record<FeeTier, FeeTierCursor> = {
    hot: { cursor: '', ...opts.cursors?.hot },
    all: { cursor: '', ...opts.cursors?.all },
  };
  const tallies: Partial<Record<FeeTier, FeePassTally>> = {};
  const saves: unknown[][] = [];
  const syncRepo = {
    getFeeCursors: vi.fn(async () => ({
      hot: { ...store.hot, ...(tallies.hot ? { tally: { ...tallies.hot } } : {}) },
      all: { ...store.all, ...(tallies.all ? { tally: { ...tallies.all } } : {}) },
    })),
    saveFeeCursor: vi.fn(async (...args: unknown[]) => {
      saves.push(args);
      const answer = opts.saveAnswer?.();
      if (answer === false) return false;
      const [, , tier, v, tally] = args as [number, string, FeeTier, FeeTierCursor, { mode: 'set' | 'inc'; counts: FeePassTally } | undefined];
      store[tier] = { ...v };
      if (tally) {
        const base = tally.mode === 'set' ? emptyFeePassTally() : (tallies[tier] ?? emptyFeePassTally());
        const out = { ...base };
        for (const k of FEE_PASS_TALLY_KEYS) out[k] += tally.counts[k];
        tallies[tier] = out;
      }
      return undefined;
    }),
  };
  const writes: RpcFeeWrite[][] = [];
  let writeAnswer: ((w: RpcFeeWrite[]) => { matched: number; modified: number; served?: number }) | undefined;
  const positions = {
    findFeeRefreshCandidates: vi.fn(async (_c: number, _p: string, after: string, limit: number) =>
      sorted()
        .filter((r) => !after || r.tokenId > after)
        .slice(0, limit),
    ),
    findFeeRefreshCandidatesByIds: vi.fn(async (_c: number, _p: string, ids: string[]) =>
      ids.map((id) => byId().get(id)).filter((r): r is FeeRefreshCandidate => !!r),
    ),
    writeRpcFees: vi.fn(async (_c: number, _p: string, w: RpcFeeWrite[]) => {
      writes.push(w);
      return writeAnswer ? writeAnswer(w) : { matched: w.length, modified: w.length };
    }),
  };
  const config = {
    positionFeeRefreshEnabled: true,
    evmRpcUrls: new Map([[CHAIN, 'http://rpc.local']]),
    enabledIntegrations: [{ chainId: CHAIN, protocol: PROTO }],
    positionFeeBatchSize: 2,
    positionFeeConcurrency: 2,
    positionFeeHotMinUsd: 50,
    positionFeeHotIntervalMs: 0,
    positionFeeFullIntervalMs: 360 * MIN,
    positionFeeMaxPerTick: 3000,
    positionFeeViewPerTick: 200,
    positionFeePassAlertMs: 50 * MIN,
    positionFeeRestampMs: 24 * 60 * MIN,
    ...opts.config,
  };
  const service = new PositionFeeRefreshService(config as never, positions as never, syncRepo as never, opts.coord);
  const source: FeeStoreSource = opts.source ?? {
    walk: async (_c, _p, after, limit) =>
      sorted()
        .filter((r) => !after || r.positionId > after)
        .slice(0, limit)
        .map(docOf),
  };
  service.useStoreSource(source);
  const { client, calls } = fakeClient(opts.blocks ?? [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007], opts.respond);
  const internals = service as unknown as {
    clients: Map<number, unknown>;
    delay: (ms: number) => Promise<void>;
    logger: { log: () => void; warn: () => void; debug: () => void };
    feed?: { store(c: number, p: string): import('../../src/sync/fee-candidate-store.js').FeeCandidateStore | undefined };
  };
  internals.clients.set(CHAIN, client);
  internals.delay = async () => undefined;
  vi.spyOn(internals.logger, 'log').mockImplementation(() => {});
  vi.spyOn(internals.logger, 'debug').mockImplementation(() => {});
  const warn = vi.spyOn(internals.logger, 'warn').mockImplementation(() => {});
  return {
    service,
    positions,
    syncRepo,
    saves,
    store,
    tallies,
    rows,
    writes,
    written: () => writes.flat(),
    client,
    calls,
    warnings: () => warn.mock.calls.map((c) => String((c as unknown[])[0])),
    setWriteAnswer: (f: typeof writeAnswer) => (writeAnswer = f),
    ramStore: () => internals.feed?.store(CHAIN, PROTO),
    config,
  };
}

/** Let background work (the store load) run. */
export async function flush(n = 50): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}
