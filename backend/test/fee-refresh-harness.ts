/*
 * Shared harness for the PositionFeeRefreshService specs (not a spec itself).
 *
 * A fake Mongo (tier keyset reads, by-id reads, writes), a fake sync_cursors
 * row that persists cursors AND pass tallies the way SyncRepository does
 * (`set` replaces, `inc` adds), and a fake viem client whose multicall answer
 * can be scripted per call — including viem's REAL rejected-request shape,
 * where every entry is `{status: 'failure', error: E}` with one shared `E`.
 */
import { vi } from 'vitest';
import type { FeeRefreshCandidate, RpcFeeWrite } from '../src/database/positions.repository.js';
import {
  FEE_PASS_TALLY_KEYS,
  emptyFeePassTally,
  type FeePassTally,
  type FeeTier,
  type FeeTierCursor,
} from '../src/database/sync.repository.js';
import { PositionFeeRefreshService } from '../src/sync/position-fee-refresh.service.js';

export const Q128 = 1n << 128n;
export const CHAIN = 4663; // has a UNISWAP_V4_CONTRACTS entry
export const PROTO = 'uniswap-v4';
export const POOL = `0x${'ab'.repeat(32)}`;
export const MIN = 60_000;

export function candidate(tokenId: string, over: Partial<FeeRefreshCandidate> = {}): FeeRefreshCandidate {
  return {
    positionId: tokenId,
    tokenId,
    poolId: POOL,
    tickLower: -600,
    tickUpper: 600,
    decimals0: 6,
    decimals1: 6,
    lastModifyBlock: 0,
    stored: {
      positionId: tokenId,
      isActive: true,
      token0: { priceUsd: 1 },
      token1: { priceUsd: 1 },
      amounts: { totalGasCostEth: '0' },
      metrics: { isPriceable: true, pendingFeesUsd: 0, feesSource: 'unmeasured' },
    },
    ...over,
  };
}

/** tokenIds "10".."10+n-1" in the index's lexicographic order. */
export function universe(n: number, hot: (i: number) => boolean = () => true) {
  return Array.from({ length: n }, (_, i) => ({ c: candidate(String(10 + i)), hot: hot(i) })).sort((a, b) =>
    a.c.tokenId < b.c.tokenId ? -1 : 1,
  );
}

export interface FakeCall {
  functionName: string;
  args: unknown[];
}

export interface RecordedMulticall {
  blockNumber: bigint;
  /** The getPositionInfo salts, in call order. */
  salts: string[];
  /** Every call's function name, in order. */
  functions: string[];
}

/** One call's answer: a StateView that owes every position (2, 3) tokens at 6 decimals. */
export function successFor(c: FakeCall) {
  return c.functionName === 'getFeeGrowthInside'
    ? { status: 'success' as const, result: [2n * Q128, 3n * Q128] }
    : { status: 'success' as const, result: [1_000_000n, 0n, 0n] };
}

/** viem's shape for a REJECTED request with `allowFailure: true`: every entry, one shared error. */
export function rejectedShape(contracts: FakeCall[], error: unknown) {
  return contracts.map(() => ({ status: 'failure' as const, error, result: undefined }));
}

/** A per-call revert: its own error object and message (viem's carries the call's args). */
export function revert(c: FakeCall, i: number) {
  return { status: 'failure' as const, error: new Error(`reverted: ${c.functionName}(${String(c.args[0])}) #${i}`), result: undefined };
}

export type Respond = (contracts: FakeCall[], blockNumber: bigint, callNo: number) => unknown[] | Promise<unknown[]>;

export function fakeClient(blocks: number[], respond?: Respond) {
  let next = 0;
  let callNo = 0;
  const calls: RecordedMulticall[] = [];
  const client = {
    getBlockNumber: vi.fn(async (_opts?: { cacheTime?: number }) => BigInt(blocks[Math.min(next++, blocks.length - 1)]!)),
    multicall: vi.fn(async (args: { contracts: FakeCall[]; blockNumber: bigint }) => {
      calls.push({
        blockNumber: args.blockNumber,
        salts: args.contracts.filter((c) => c.functionName === 'getPositionInfo').map((c) => String(c.args[4])),
        functions: args.contracts.map((c) => c.functionName),
      });
      const n = callNo++;
      return respond ? respond(args.contracts, args.blockNumber, n) : args.contracts.map(successFor);
    }),
  };
  return { client, calls };
}

export function makeHarness(
  opts: {
    rows?: ReturnType<typeof universe>;
    cursors?: Partial<Record<FeeTier, FeeTierCursor>>;
    config?: Record<string, unknown>;
    blocks?: number[];
    respond?: Respond;
  } = {},
) {
  const rows = opts.rows ?? universe(5);
  const store: Record<FeeTier, FeeTierCursor> = {
    hot: { cursor: '', ...opts.cursors?.hot },
    all: { cursor: '', ...opts.cursors?.all },
  };
  const tallies: Partial<Record<FeeTier, FeePassTally>> = {};
  for (const t of ['hot', 'all'] as const) if (opts.cursors?.[t]?.tally) tallies[t] = { ...opts.cursors[t]!.tally! };
  /** Ordered log of reads, writes and cursor saves (prefetch / ordering specs). */
  const events: string[] = [];
  const syncRepo = {
    getFeeCursors: vi.fn(async () => ({
      hot: { ...store.hot, ...(tallies.hot ? { tally: { ...tallies.hot } } : {}) },
      all: { ...store.all, ...(tallies.all ? { tally: { ...tallies.all } } : {}) },
    })),
    saveFeeCursor: vi.fn(
      async (_c: number, _p: string, tier: FeeTier, v: FeeTierCursor, tally?: { mode: 'set' | 'inc'; counts: FeePassTally }) => {
        events.push(`save:${tier}:${v.cursor}`);
        store[tier] = { ...v };
        if (tally) {
          const base = tally.mode === 'set' ? emptyFeePassTally() : (tallies[tier] ?? emptyFeePassTally());
          const out = { ...base };
          for (const k of FEE_PASS_TALLY_KEYS) out[k] += tally.counts[k];
          tallies[tier] = out;
        }
      },
    ),
  };
  const writes: RpcFeeWrite[][] = [];
  const positions = {
    findFeeRefreshCandidates: vi.fn(
      async (_c: number, _p: string, after: string, limit: number, o: { hotMinUsd?: number } = {}) => {
        events.push(`read:${o.hotMinUsd === undefined ? 'all' : 'hot'}:${after}:${limit}`);
        return rows
          .filter((r) => (o.hotMinUsd === undefined || r.hot) && (!after || r.c.tokenId > after))
          .slice(0, limit)
          .map((r) => r.c);
      },
    ),
    findFeeRefreshCandidatesByIds: vi.fn(async (_c: number, _p: string, ids: string[]) =>
      ids.map((id) => rows.find((r) => r.c.positionId === id)?.c ?? candidate(id)),
    ),
    writeRpcFees: vi.fn(async (_c: number, _p: string, w: RpcFeeWrite[]) => {
      events.push(`write:${w.map((x) => x.positionId).join(',')}`);
      writes.push(w);
      return { matched: w.length, modified: w.length };
    }),
  };
  const config = {
    positionFeeRefreshEnabled: true,
    evmRpcUrls: new Map([[CHAIN, 'http://rpc.local']]),
    enabledIntegrations: [
      { chainId: CHAIN, protocol: PROTO },
      { chainId: 1, protocol: PROTO }, // no RPC url → never ticked
    ],
    positionFeeBatchSize: 2,
    positionFeeConcurrency: 2,
    positionFeeHotMinUsd: 50,
    positionFeeHotIntervalMs: 30 * MIN,
    positionFeeFullIntervalMs: 360 * MIN,
    positionFeeMaxPerTick: 3000,
    positionFeeViewPerTick: 200,
    positionFeePassAlertMs: 50 * MIN,
    // positionFeeMaxWritesPerSec / …ServedWritesPerSec unset → the write gate is off.
    ...opts.config,
  };
  const service = new PositionFeeRefreshService(config as never, positions as never, syncRepo as never);
  const { client, calls } = fakeClient(opts.blocks ?? [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007], opts.respond);
  const internals = service as unknown as {
    clients: Map<number, unknown>;
    delay: (ms: number) => Promise<void>;
    lastUsed: Map<string, number>;
    logger: { log: () => void; warn: () => void; debug: () => void };
  };
  internals.clients.set(CHAIN, client);
  // The 1 s RPC retry wait, recorded instead of slept.
  const delays: number[] = [];
  internals.delay = async (ms: number) => {
    delays.push(ms);
  };
  const log = vi.spyOn(internals.logger, 'log').mockImplementation(() => {});
  vi.spyOn(internals.logger, 'debug').mockImplementation(() => {});
  const warn = vi.spyOn(internals.logger, 'warn').mockImplementation(() => {});
  const written = () => writes.flat();
  const warnings = () => warn.mock.calls.map((c) => String(c[0]));
  return { service, positions, syncRepo, store, tallies, events, client, calls, writes, written, warn, warnings, log, config, delays, internals };
}

/** A cursor that ran and finished a minute ago: not due for a long while. */
export function recent(): FeeTierCursor {
  return { cursor: '', startedAt: new Date(Date.now() - MIN), finishedAt: new Date(Date.now() - MIN / 2) };
}
