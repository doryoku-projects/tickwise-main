import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { createPublicClient, formatUnits, http, type PublicClient } from 'viem';
import { AppConfigService } from '../config/app-config.service.js';
import { MULTICALL3, uniswapV4ContractsFor, type UniswapV4Contracts } from '../config/chains.config.js';
import type { PageFeeReader, PageFeeReading, PageFeeRow } from '../subgraph/adapters/envio.adapter.js';
import { owedFeesRaw, positionSalt, type RpcFees } from './position-fee-math.js';
import {
  FEE_BATCH_MAX,
  FEE_CONCURRENCY_MAX,
  SPLIT_MAX_DEPTH,
  classifyRpcError,
  failingTailStart,
  parseChainMap,
  rpcErrorSummary,
  splitTail,
  wholeRequestFailure,
  type CallResult,
  type RpcFailureKind,
} from './position-fee-rpc.js';

/*
 * The fee job's on-chain measurement, shared by the 60 s fee ticks
 * (`PositionFeeRefreshService`) and the backfill's first reading (P3.1,
 * `PageFeeReader`, bound to PAGE_FEE_READER by the integrator): the same
 * StateView multicall, head pin, whole-request detection and gas-tail split
 * for both, so a backfilled row is measured exactly as a pass would measure it.
 *
 * P3.2 knobs, each defaulting to today's behaviour:
 *   - batch / concurrency PER CHAIN (`POSITION_FEE_BATCH_SIZE_BY_CHAIN`,
 *     `POSITION_FEE_CONCURRENCY_BY_CHAIN`, ≤ 64), falling back to the globals;
 *   - a process-wide ceiling on multicalls in flight across every chain and
 *     both lanes (`POSITION_FEE_MAX_IN_FLIGHT`, 64 — today's 4 chains × 8 = 32
 *     never reach it);
 *   - ONE head per page (`POSITION_FEE_HEAD_PER=page`; default `batch` = one
 *     `eth_blockNumber` per batch, as today): every batch of a page is pinned
 *     to it. The 1 s retry for a node a block behind the head stays;
 *   - every HTTP attempt (retries included) through the RPC budget's
 *     `budgetedFetch` when one is bound (`FEE_RPC_FETCH`), lane `fee` for the
 *     ticks and `backfill` for P3.1.
 */

/** Which RPC budget lane a measurement draws on. */
export type FeeRpcLane = 'fee' | 'backfill';

/**
 * `(url, lane, chainId) → fetch`: the RPC budget's `budgetedFetch` as viem's
 * `http({fetchFn})` (every attempt, retries included, takes a token first).
 * Bound by the integrator from `common/rpc-budget.ts`; absent = plain fetch.
 *
 * WIRING (exactly): `(_url, lane) => rpcBudget.budgetedFetch(lane)`. Never pass
 * the url as the second argument — `budgetedFetch(lane, fetchImpl?)` takes an
 * optional fetch IMPLEMENTATION there and, with the budget off, hands it back as
 * the fetch itself (a string would then be called for every RPC request).
 * `budgetedFetch` reads the url from each request. A factory answer that is not
 * a function is ignored with `[alert] fees.rpc_fetch_invalid` (`checkedFetch`).
 */
export type FeeRpcFetchFactory = (url: string, lane: FeeRpcLane, chainId: number) => typeof fetch;

/**
 * The factory's answer as a viem `fetchFn`, or undefined (plain fetch) when it
 * is not a function — a miswired factory must degrade to today's transport, not
 * turn every multicall into a TypeError (whole-request failures, every page
 * held back, no measurement at all).
 */
export function checkedFetch(fn: unknown, onInvalid: () => void): typeof fetch | undefined {
  if (fn === undefined || fn === null) return undefined;
  if (typeof fn === 'function') return fn as typeof fetch;
  onInvalid();
  return undefined;
}
/** Injection token for the `FeeRpcFetchFactory`. */
export const FEE_RPC_FETCH = 'FEE_RPC_FETCH';
/** Injection token for test/host overrides of the measurer's I/O (never bound in production). */
export const FEE_MEASURER_HOOKS = 'FEE_MEASURER_HOOKS';

/** P3 settings, read structurally from the config (an absent getter = today's default). */
export interface FeeP3Settings {
  batchSize: number;
  batchByChain: Map<number, number>;
  concurrency: number;
  concurrencyByChain: Map<number, number>;
  maxInFlight: number;
  headPer: 'batch' | 'page';
  budget: 'round' | 'per-chain';
  passTargetMs: number;
  candidates: 'mongo' | 'memory';
  loadDocsPerSec: number;
  reconcileMs: number;
  reconcileDocsPerSec: number;
  signalsTransport: 'auto' | 'memory' | 'redis';
}

const DEFAULT_MAX_IN_FLIGHT = 64;
const DEFAULT_PASS_TARGET_MS = 480_000;
const DEFAULT_LOAD_DOCS_PER_SEC = 5_000;
const MAX_LOAD_DOCS_PER_SEC = 8_000;
const DEFAULT_RECONCILE_MS = 6 * 3_600_000;
const DEFAULT_RECONCILE_DOCS_PER_SEC = 3_000;
const MAX_RECONCILE_DOCS_PER_SEC = 5_000;

function positiveInt(v: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? Math.min(max, n) : fallback;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

/**
 * Reads the P3 knobs off `AppConfigService` WITHOUT requiring its getters to
 * exist (the integrator adds them with exactly these names): a missing or
 * garbage value is the default, and every default is today's behaviour.
 */
export function resolveFeeP3Settings(config: unknown): FeeP3Settings {
  const c = (config ?? {}) as Record<string, unknown>;
  return {
    // The globals keep today's (unbounded) reading; only the per-chain overrides are clamped.
    batchSize: positiveInt(c.positionFeeBatchSize, 200),
    batchByChain: parseChainMap(c.positionFeeBatchSizeByChain, FEE_BATCH_MAX),
    concurrency: positiveInt(c.positionFeeConcurrency, 8),
    concurrencyByChain: parseChainMap(c.positionFeeConcurrencyByChain, FEE_CONCURRENCY_MAX),
    maxInFlight: positiveInt(c.positionFeeMaxInFlight, DEFAULT_MAX_IN_FLIGHT, 1_024),
    headPer: oneOf(c.positionFeeHeadPer, ['batch', 'page'] as const, 'batch'),
    budget: oneOf(c.positionFeeBudget, ['round', 'per-chain'] as const, 'round'),
    passTargetMs: positiveInt(c.positionFeePassTargetMs, DEFAULT_PASS_TARGET_MS),
    candidates: oneOf(c.positionFeeCandidates, ['mongo', 'memory'] as const, 'mongo'),
    loadDocsPerSec: positiveInt(c.positionFeeLoadDocsPerSec, DEFAULT_LOAD_DOCS_PER_SEC, MAX_LOAD_DOCS_PER_SEC),
    reconcileMs: positiveInt(c.positionFeeReconcileMs, DEFAULT_RECONCILE_MS),
    reconcileDocsPerSec: positiveInt(c.positionFeeReconcileDocsPerSec, DEFAULT_RECONCILE_DOCS_PER_SEC, MAX_RECONCILE_DOCS_PER_SEC),
    signalsTransport: oneOf(c.feeSignalsTransport, ['auto', 'memory', 'redis'] as const, 'auto'),
  };
}

/** The batch a chain measures with (per-chain override, else the global). */
export function batchSizeFor(s: FeeP3Settings, chainId: number): number {
  return s.batchByChain.get(chainId) ?? s.batchSize;
}

/** Concurrent multicalls one chain may have in flight (per-chain override, else the global). */
export function concurrencyFor(s: FeeP3Settings, chainId: number): number {
  return s.concurrencyByChain.get(chainId) ?? s.concurrency;
}

/**
 * Process-wide ceiling on multicalls in flight, every chain and both lanes
 * together. FIFO; the limit is read on every acquire so a config change (or a
 * spec) takes effect at once.
 */
export class InFlightGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  /** Highest concurrent count seen (observability, specs). */
  peak = 0;

  constructor(private readonly limit: () => number) {}

  get inFlight(): number {
    return this.active;
  }

  async acquire(): Promise<() => void> {
    if (this.active >= Math.max(1, this.limit())) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.active++;
    }
    this.peak = Math.max(this.peak, this.active);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      // The slot passes straight to the next waiter (count unchanged).
      if (next) next();
      else this.active--;
    };
  }
}

/** One per process: the ceiling is fleet-of-chains wide, not per measurer instance. */
const PROCESS_IN_FLIGHT = { gate: undefined as InFlightGate | undefined, limit: DEFAULT_MAX_IN_FLIGHT };
function processGate(limit: number): InFlightGate {
  PROCESS_IN_FLIGHT.limit = limit;
  PROCESS_IN_FLIGHT.gate ??= new InFlightGate(() => PROCESS_IN_FLIGHT.limit);
  return PROCESS_IN_FLIGHT.gate;
}

/** What a measurement needs off a row (a fee candidate and a backfill row both carry it). */
export interface MeasureInput {
  positionId: string;
  tokenId: string;
  poolId: string;
  tickLower: number;
  tickUpper: number;
  decimals0: number;
  decimals1: number;
  lastModifyBlock: number;
}

export interface MeasuredRow<R extends MeasureInput> {
  candidate: R;
  /** Decimal-adjusted (formatUnits) owed fees. */
  fees0: string;
  fees1: string;
  block: number;
}

export interface MeasureOutcome<R extends MeasureInput> {
  rows: MeasuredRow<R>[];
  /** Per-call failures after the split retries (real reverts). */
  failed: R[];
  /** The RPC never answered: not measured, not failed. */
  unanswered: R[];
  /** Rows whose stored inputs can never be read (bad poolId, ticks or decimals). */
  unreadable: R[];
}

export interface FeeMeasurerHooks {
  /** The viem client for a chain (specs inject fakes; the service keeps its own map). */
  client?: (chainId: number, lane: FeeRpcLane) => PublicClient | undefined;
  /** The 1 s RPC retry wait (specs record it instead). */
  delay?: (ms: number) => Promise<void>;
  /** Where alerts go (the service passes its own logger, which specs spy on). */
  logger?: Pick<Logger, 'warn' | 'log' | 'debug'>;
  /** The P3 settings (the service passes its resolver, so specs can vary them). */
  settings?: () => FeeP3Settings;
}

/** Wait before retrying a whole-request RPC failure (same block). */
export const RPC_RETRY_DELAY_MS = 1_000;
/** `[alert] fees.rpc_batch_failed` at most once per chain per this. */
export const RPC_ALERT_INTERVAL_MS = 10 * 60_000;
/** `[alert] fees.gas_split` at most once per chain per this. */
export const GAS_SPLIT_ALERT_INTERVAL_MS = 10 * 60_000;
const LATENCY_SAMPLES = 64;
const LATENCY_EWMA_ALPHA = 0.2;
const POOL_ID = /^0x[0-9a-fA-F]{64}$/;
const TOKEN_ID = /^\d+$/;

const STATE_VIEW_ABI = [
  {
    type: 'function',
    name: 'getFeeGrowthInside',
    stateMutability: 'view',
    inputs: [
      { name: 'poolId', type: 'bytes32' },
      { name: 'tickLower', type: 'int24' },
      { name: 'tickUpper', type: 'int24' },
    ],
    outputs: [
      { name: 'feeGrowthInside0X128', type: 'uint256' },
      { name: 'feeGrowthInside1X128', type: 'uint256' },
    ],
  },
  {
    type: 'function',
    name: 'getPositionInfo',
    stateMutability: 'view',
    inputs: [
      { name: 'poolId', type: 'bytes32' },
      { name: 'owner', type: 'address' },
      { name: 'tickLower', type: 'int24' },
      { name: 'tickUpper', type: 'int24' },
      { name: 'salt', type: 'bytes32' },
    ],
    outputs: [
      { name: 'liquidity', type: 'uint128' },
      { name: 'feeGrowthInside0LastX128', type: 'uint256' },
      { name: 'feeGrowthInside1LastX128', type: 'uint256' },
    ],
  },
] as const;

/** Per-chain measurement statistics (status block, per-chain budget capacity, slot suggestion). */
export interface FeeChainStats {
  batches: number;
  heads: number;
  gasSplits: number;
  rpcFailures: number;
  /** EWMA of a depth-0 multicall's wall time, ms (0 = none yet). */
  latencyEwmaMs: number;
  latencyP95Ms: number;
  /** The batch size the latency was measured at (latest). */
  batchSize: number;
}

interface ChainState {
  batches: number;
  heads: number;
  gasSplits: number;
  rpc: { total: number; sinceAlert: number; lastAlertAt: number };
  gasAlertAt: number;
  ewma: number;
  samples: number[];
  batchSize: number;
}

/** One chain's measurement context: its client, contracts and lane. */
interface Ctx {
  chainId: number;
  client: PublicClient;
  contracts: UniswapV4Contracts;
  lane: FeeRpcLane;
}

@Injectable()
export class FeeMeasurer implements PageFeeReader {
  private readonly ownLogger = new Logger(FeeMeasurer.name);
  private readonly clients = new Map<string, PublicClient>();
  private readonly chains = new Map<number, ChainState>();

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Optional() @Inject(FEE_RPC_FETCH) private readonly fetchFactory?: FeeRpcFetchFactory,
    @Optional() @Inject(FEE_MEASURER_HOOKS) private readonly hooks: FeeMeasurerHooks = {},
  ) {}

  private get logger(): Pick<Logger, 'warn' | 'log' | 'debug'> {
    return this.hooks.logger ?? this.ownLogger;
  }

  settings(): FeeP3Settings {
    return this.hooks.settings?.() ?? resolveFeeP3Settings(this.config);
  }

  /** Whether this process can measure `chainId` at all (an RPC url and the v4 contracts). */
  canMeasure(chainId: number): boolean {
    return this.config.evmRpcUrls.has(chainId) && Boolean(uniswapV4ContractsFor(chainId));
  }

  /**
   * P3.1 — `PageFeeReader`: the ACTIVE rows of one backfill range, measured on
   * the `backfill` RPC lane. A reading per row it could measure (keyed by
   * positionId); a row it could not — unreadable, reverted, unanswered, or
   * already older than its own `lastModifyBlock` — is simply absent, and the
   * backfill queues it for the fee job as before. Never throws for a row; a
   * chain this process cannot read answers an empty map.
   */
  async measure(
    chainId: number,
    protocol: string,
    rows: PageFeeRow[],
    opts: { signal?: AbortSignal } = {},
  ): Promise<Map<string, PageFeeReading>> {
    const out = new Map<string, PageFeeReading>();
    if (protocol !== 'uniswap-v4' || rows.length === 0 || !this.canMeasure(chainId)) return out;
    if (opts.signal?.aborted) return out;
    const outcome = await this.measureRows(chainId, rows, 'backfill', opts.signal);
    const at = new Date();
    for (const m of outcome.rows) {
      // A modify after the reading's block settled what it saw: refused here so
      // the row reaches the fee job's backfill lane instead of being served stale.
      if (m.candidate.lastModifyBlock > m.block) continue;
      const fees0 = Number(m.fees0);
      const fees1 = Number(m.fees1);
      if (!Number.isFinite(fees0) || !Number.isFinite(fees1)) continue;
      // The exact decimals (formatUnits) ride along: the backfill stamps them,
      // so a stamp never loses digits a double cannot hold (E, P3.1 stamp).
      out.set(m.candidate.positionId, { fees0, fees1, block: m.block, at, fees0Exact: m.fees0, fees1Exact: m.fees1 });
    }
    return out;
  }

  /**
   * Measure rows of ONE chain: readable rows in batches (per-chain size and
   * concurrency), each batch pinned to its own head — or, with
   * `POSITION_FEE_HEAD_PER=page`, every batch pinned to one head read for the
   * whole call. Never throws for an RPC failure (those rows come back
   * `unanswered`); a chain with no client answers everything `unanswered`.
   */
  async measureRows<R extends MeasureInput>(
    chainId: number,
    page: R[],
    lane: FeeRpcLane = 'fee',
    /** Aborted (the P3.1 read's deadline passed): no new head read or batch starts; those rows come back `unanswered`. */
    signal?: AbortSignal,
  ): Promise<MeasureOutcome<R>> {
    const out: MeasureOutcome<R> = { rows: [], failed: [], unanswered: [], unreadable: [] };
    const readable: R[] = [];
    for (const p of page) (isReadable(p) ? readable : out.unreadable).push(p);
    if (readable.length === 0) return out;
    const ctx = this.ctx(chainId, lane);
    if (!ctx) {
      out.unanswered.push(...readable);
      return out;
    }
    const s = this.settings();
    const batchSize = Math.max(1, batchSizeFor(s, chainId));
    const concurrency = Math.max(1, concurrencyFor(s, chainId));
    const gate = processGate(s.maxInFlight);
    let pinned: bigint | undefined;
    if (s.headPer === 'page') {
      pinned = await this.headBlock(ctx, readable.length);
      if (pinned === undefined) {
        out.unanswered.push(...readable);
        return out;
      }
    }
    await mapConcurrent(chunk(readable, batchSize), concurrency, async (batch) => {
      const release = await gate.acquire();
      try {
        // Checked once the slot is ours (a batch may have queued for it while the deadline passed).
        if (signal?.aborted) {
          out.unanswered.push(...batch);
          return;
        }
        const block = pinned ?? (await this.headBlock(ctx, batch.length));
        const r: MeasureOutcome<R> =
          block === undefined ? { rows: [], failed: [], unanswered: batch, unreadable: [] } : await this.measureAt(ctx, batch, block, 0);
        out.rows.push(...r.rows);
        out.failed.push(...r.failed);
        out.unanswered.push(...r.unanswered);
      } finally {
        release();
      }
    });
    return out;
  }

  /** Whole-request RPC failures seen on `chainId` since boot (observability, specs). */
  rpcBatchFailures(chainId: number): number {
    return this.chains.get(chainId)?.rpc.total ?? 0;
  }

  stats(chainId: number): FeeChainStats {
    const st = this.chains.get(chainId);
    if (!st) return { batches: 0, heads: 0, gasSplits: 0, rpcFailures: 0, latencyEwmaMs: 0, latencyP95Ms: 0, batchSize: 0 };
    const sorted = [...st.samples].sort((a, b) => a - b);
    const p95 = sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)]!;
    return {
      batches: st.batches,
      heads: st.heads,
      gasSplits: st.gasSplits,
      rpcFailures: st.rpc.total,
      latencyEwmaMs: Math.round(st.ewma),
      latencyP95Ms: p95,
      batchSize: st.batchSize,
    };
  }

  /** Seed a chain's latency (specs; a restart starts with none). */
  recordLatency(chainId: number, ms: number, batchSize: number): void {
    const st = this.state(chainId);
    st.ewma = st.ewma > 0 ? st.ewma + LATENCY_EWMA_ALPHA * (ms - st.ewma) : ms;
    st.samples.push(ms);
    if (st.samples.length > LATENCY_SAMPLES) st.samples.shift();
    st.batchSize = batchSize;
  }

  private state(chainId: number): ChainState {
    let st = this.chains.get(chainId);
    if (!st) {
      st = {
        batches: 0,
        heads: 0,
        gasSplits: 0,
        rpc: { total: 0, sinceAlert: 0, lastAlertAt: Number.NEGATIVE_INFINITY },
        gasAlertAt: Number.NEGATIVE_INFINITY,
        ewma: 0,
        samples: [],
        batchSize: 0,
      };
      this.chains.set(chainId, st);
    }
    return st;
  }

  private ctx(chainId: number, lane: FeeRpcLane): Ctx | undefined {
    const contracts = uniswapV4ContractsFor(chainId);
    if (!contracts) return undefined;
    const client = this.hooks.client ? this.hooks.client(chainId, lane) : this.client(chainId, lane);
    return client ? { chainId, client, contracts, lane } : undefined;
  }

  /** One viem client per (chain, lane): the lanes draw on different RPC budget lanes. */
  client(chainId: number, lane: FeeRpcLane): PublicClient | undefined {
    const url = this.config.evmRpcUrls.get(chainId);
    if (!url) return undefined;
    const key = `${chainId}:${lane}`;
    let c = this.clients.get(key);
    if (!c) {
      const fetchFn = checkedFetch(this.fetchFactory?.(url, lane, chainId), () =>
        this.logger.warn(`[alert] fees.rpc_fetch_invalid chain=${chainId} lane=${lane} — FEE_RPC_FETCH returned a non-function; using plain fetch`),
      );
      c = createPublicClient({
        transport: http(url, { timeout: 30_000, retryCount: 1, ...(fetchFn ? { fetchFn } : {}) }),
      }) as PublicClient;
      this.clients.set(key, c);
    }
    return c;
  }

  private delay(ms: number): Promise<void> {
    return this.hooks.delay ? this.hooks.delay(ms) : new Promise((r) => setTimeout(r, ms));
  }

  /**
   * The head to pin to: read, then run pinned to it, so the block stamped on
   * the rows is exactly the state they were read from. `cacheTime: 0` — viem
   * otherwise reuses a head up to 4 s old. A failed read is retried once;
   * still failing, the rows are unanswered.
   */
  private async headBlock(ctx: Ctx, positions: number): Promise<bigint | undefined> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const b = await ctx.client.getBlockNumber({ cacheTime: 0 });
        this.state(ctx.chainId).heads++;
        return b;
      } catch (err) {
        this.noteRpcFailure(ctx.chainId, positions, err);
        if (attempt === 0) await this.delay(RPC_RETRY_DELAY_MS);
      }
    }
    return undefined;
  }

  /**
   * One batch at one block. A whole-request failure (the RPC, not N contracts)
   * is retried once and otherwise left unanswered — never split; a gas-cut
   * tail is retried alone, in halves, at the same block (depth ≤
   * SPLIT_MAX_DEPTH); scattered failures are reverts.
   */
  private async measureAt<R extends MeasureInput>(ctx: Ctx, batch: R[], block: bigint, depth: number): Promise<MeasureOutcome<R>> {
    const st = this.state(ctx.chainId);
    const t0 = Date.now();
    let answer = await this.multicall(ctx, batch, block);
    if (depth === 0) {
      st.batches++;
      if (!answer.whole) this.recordLatency(ctx.chainId, Date.now() - t0, batch.length);
    }
    if (answer.whole && answer.whole.kind !== 'gas') {
      this.noteRpcFailure(ctx.chainId, batch.length, answer.whole.error);
      if (depth > 0) return { rows: [], failed: [], unanswered: batch, unreadable: [] };
      // A load-balanced RPC can route the call to a node a block or two behind
      // the one that answered eth_blockNumber; a second later it has caught up.
      await this.delay(RPC_RETRY_DELAY_MS);
      answer = await this.multicall(ctx, batch, block);
      if (answer.whole && answer.whole.kind !== 'gas') {
        this.noteRpcFailure(ctx.chainId, batch.length, answer.whole.error);
        return { rows: [], failed: [], unanswered: batch, unreadable: [] };
      }
    }

    // Calls are interleaved per position: results[2i] / results[2i + 1].
    const out: MeasureOutcome<R> = { rows: [], failed: [], unanswered: [], unreadable: [] };
    const ok: boolean[] = [];
    for (let i = 0; i < batch.length; i++) {
      const fg = answer.whole ? undefined : answer.results[2 * i];
      const info = answer.whole ? undefined : answer.results[2 * i + 1];
      if (fg?.status !== 'success' || info?.status !== 'success') {
        ok.push(false);
        continue;
      }
      ok.push(true);
      const [inside0, inside1] = fg.result as readonly [bigint, bigint];
      const [liquidity, last0, last1] = info.result as readonly [bigint, bigint, bigint];
      const p = batch[i]!;
      out.rows.push({
        candidate: p,
        fees0: formatUnits(owedFeesRaw(inside0, last0, liquidity), p.decimals0),
        fees1: formatUnits(owedFeesRaw(inside1, last1, liquidity), p.decimals1),
        block: Number(block),
      });
    }
    const tailStart = failingTailStart(ok);
    for (let i = 0; i < batch.length; i++) {
      if (!ok[i] && (tailStart < 0 || i < tailStart)) out.failed.push(batch[i]!);
    }
    if (tailStart < 0) return out;
    const tail = batch.slice(tailStart);
    // The gas signature: a failing tail AFTER an answered position, or a gas
    // error on the whole request. A batch that failed per call from its first
    // position is reverting, not running out of gas.
    const gasCut = answer.whole ? true : tailStart > 0;
    if (!gasCut || depth >= SPLIT_MAX_DEPTH) {
      out.failed.push(...tail);
      return out;
    }
    this.noteGasSplit(ctx.chainId, batch.length, tail.length);
    for (const part of splitTail(tail)) {
      const sub = await this.measureAt(ctx, part, block, depth + 1);
      out.rows.push(...sub.rows);
      out.failed.push(...sub.failed);
      out.unanswered.push(...sub.unanswered);
    }
    return out;
  }

  private async multicall(
    ctx: Ctx,
    batch: MeasureInput[],
    block: bigint,
  ): Promise<{ results: ReadonlyArray<CallResult>; whole?: { error: unknown; kind: RpcFailureKind } }> {
    let results: ReadonlyArray<CallResult>;
    try {
      results = (await ctx.client.multicall({
        // The tuple types of a mixed two-function batch do not survive spreading
        // into one array; the per-index result is narrowed explicitly in measureAt().
        contracts: feeCalls(ctx.contracts, batch) as never,
        allowFailure: true,
        blockNumber: block,
        multicallAddress: MULTICALL3,
        // 0 disables viem's default 1 KB calldata split, which would otherwise
        // turn one batch into dozens of requests and defeat the whole point.
        batchSize: 0,
      })) as ReadonlyArray<CallResult>;
    } catch (err) {
      // `allowFailure: true` reports transport failures per call instead of
      // throwing; anything that does throw is the same kind of outcome.
      return { results: [], whole: { error: err, kind: classifyRpcError(err) } };
    }
    const error = wholeRequestFailure(results);
    return error === undefined ? { results } : { results, whole: { error, kind: classifyRpcError(error) } };
  }

  /** Counts a whole-request failure; `[alert] fees.rpc_batch_failed` at most once per chain per RPC_ALERT_INTERVAL_MS. */
  private noteRpcFailure(chainId: number, positions: number, err: unknown): void {
    const now = Date.now();
    const s = this.state(chainId).rpc;
    s.total++;
    s.sinceAlert++;
    if (now - s.lastAlertAt >= RPC_ALERT_INTERVAL_MS) {
      this.logger.warn(
        `[alert] fees.rpc_batch_failed chain=${chainId} positions=${positions} err=${rpcErrorSummary(err)} ` +
          `failures=${s.sinceAlert} (since the last alert; ${s.total} since boot)`,
      );
      s.lastAlertAt = now;
      s.sinceAlert = 0;
    }
  }

  /**
   * A gas-cut tail at the batch's size: at batch 500 (~14.5M of 16.78M gas)
   * that means the chain's positions are heavier than the design assumed — the
   * batch for that chain should come down (`POSITION_FEE_BATCH_SIZE_BY_CHAIN`).
   */
  private noteGasSplit(chainId: number, batch: number, tail: number): void {
    const st = this.state(chainId);
    st.gasSplits++;
    const now = Date.now();
    if (now - st.gasAlertAt < GAS_SPLIT_ALERT_INTERVAL_MS) return;
    st.gasAlertAt = now;
    this.logger.warn(
      `[alert] fees.gas_split chain=${chainId} batch=${batch} tail=${tail} splits=${st.gasSplits} — a multicall ran out of gas; ` +
        `lower POSITION_FEE_BATCH_SIZE_BY_CHAIN for this chain if this repeats`,
    );
  }
}

/**
 * The batch's calls, INTERLEAVED per position — [feeGrowthInside_0,
 * positionInfo_0, feeGrowthInside_1, positionInfo_1, …] — so a gas cutoff
 * (which fails every call from some index on) fails a contiguous tail of
 * POSITIONS, and every position before it is fully answered.
 */
function feeCalls(contracts: UniswapV4Contracts, batch: MeasureInput[]) {
  const sv = { address: contracts.stateView, abi: STATE_VIEW_ABI } as const;
  return batch.flatMap((p) => [
    {
      ...sv,
      functionName: 'getFeeGrowthInside' as const,
      args: [p.poolId as `0x${string}`, p.tickLower, p.tickUpper] as const,
    },
    {
      ...sv,
      functionName: 'getPositionInfo' as const,
      args: [p.poolId as `0x${string}`, contracts.positionManager, p.tickLower, p.tickUpper, positionSalt(p.tokenId)] as const,
    },
  ]);
}

/** Whether a row's stored StateView inputs can be read at all. */
export function isReadable(p: MeasureInput): boolean {
  return (
    POOL_ID.test(p.poolId) &&
    TOKEN_ID.test(p.tokenId) &&
    Number.isInteger(p.tickLower) &&
    Number.isInteger(p.tickUpper) &&
    p.tickLower < p.tickUpper &&
    Number.isInteger(p.decimals0) &&
    Number.isInteger(p.decimals1) &&
    p.decimals0 >= 0 &&
    p.decimals0 <= 77 &&
    p.decimals1 >= 0 &&
    p.decimals1 <= 77
  );
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function mapConcurrent<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
