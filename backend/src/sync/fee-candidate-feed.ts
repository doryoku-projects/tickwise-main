import type { Logger } from '@nestjs/common';
import type { FeeRefreshCandidate, FeeRowHint } from '../database/positions.repository.js';
import { FeeCandidateStore, type StoreRow } from './fee-candidate-store.js';
import type { FeeP3Settings } from './fee-measurer.js';
import { decodeEntry, hintLossKey, hintStreamKey } from './fee-row-hint-publisher.js';
import { FEE_MODE_ANNOUNCE_MS, FEE_MODE_TTL_MS, SET_MODE_SCRIPT, feeModeKey, type FeeCoordination, type FeeRedis } from './fee-signals.js';

/*
 * P3.3 feeds of the RAM store (design §9.2):
 *
 *   - BOOT LOAD = the first pass's page source: a keyset walk by positionId
 *     over `{chainId, protocol, isActive: true}` hinted `bg_active_walk`, read
 *     preference `secondary` (fails rather than loading the primary), a small
 *     projection (no `amounts`), paced at POSITION_FEE_LOAD_DOCS_PER_SEC. Each
 *     loaded page extends what the store covers, so the fee pass measures it on
 *     its next page — no chain stays in Mongo mode once its load runs. Runs in
 *     the background (never awaited from onModuleInit, C19).
 *   - RECONCILE: the same walk at POSITION_FEE_RECONCILE_DOCS_PER_SEC, diffed
 *     in place, every POSITION_FEE_RECONCILE_MS and whenever a hint may have
 *     been lost (loss counter moved, stream trimmed past us or reset, 60 s of
 *     XREAD errors). `[alert] fees.reconcile_drift` when > 1 % of rows changed.
 *   - WRITER HINTS: applied newer-wins; while a load runs they are BUFFERED and
 *     applied after each loaded page (those the page now covers), so a load
 *     page read from a lagging secondary can never overwrite a newer hint.
 *     The buffer is bounded (HINT_BUFFER_MAX) and kept only while the load
 *     RUNS: past the bound, or while a failed load waits for its retry, hints
 *     for rows the load has not reached are dropped and a reconcile is queued
 *     for when it completes (the retried load reads those rows anyway).
 *     With leases on they arrive on the redis-models stream; this process
 *     records the stream's last id BEFORE its load scan and reads after it,
 *     announces `memory` on redis-state (`feeModeKey`) so writers in other
 *     roles publish, and raises `[alert] fees.hint_stream_absent` once when a
 *     ready store has never seen a hint for HINT_STREAM_ABSENT_MS.
 *
 * If a chain's walk keeps failing (no secondary, say) the store is not used
 * and the fee pass reads Mongo pages as today (`usable` false), with
 * `[alert] fees.store_load_failed`.
 */

/** What one load/reconcile page reads off a position (no `amounts`, no whole `metrics`). */
export const STORE_LOAD_PROJECTION = {
  _id: 0,
  positionId: 1,
  tokenId: 1,
  poolId: 1,
  tickLower: 1,
  tickUpper: 1,
  lastModifyBlock: 1,
  'token0.decimals': 1,
  'token1.decimals': 1,
  'token0.priceUsd': 1,
  'token1.priceUsd': 1,
  'metrics.feesSource': 1,
  'metrics.isPriceable': 1,
  'metrics.pendingFeesUsd': 1,
  updatedAt: 1,
  rpcFeesUncollected0: 1,
  rpcFeesUncollected1: 1,
  rpcFeesBlock: 1,
  rpcFeesAt: 1,
} as const;

export interface FeeStoreDoc {
  positionId: unknown;
  tokenId?: unknown;
  poolId?: unknown;
  tickLower?: unknown;
  tickUpper?: unknown;
  lastModifyBlock?: unknown;
  token0?: { decimals?: unknown; priceUsd?: unknown };
  token1?: { decimals?: unknown; priceUsd?: unknown };
  metrics?: { feesSource?: unknown; isPriceable?: unknown; pendingFeesUsd?: unknown };
  updatedAt?: unknown;
  rpcFeesUncollected0?: unknown;
  rpcFeesUncollected1?: unknown;
  rpcFeesBlock?: unknown;
  rpcFeesAt?: unknown;
}

/** One page of the walk, in positionId order, strictly after `after`. */
export interface FeeStoreSource {
  walk(chainId: number, protocol: string, after: string, limit: number): Promise<FeeStoreDoc[]>;
}

/** The index the walk is hinted to (partial on actives, no collation). */
export const STORE_WALK_INDEX = 'bg_active_walk';
/** Server-side budget of one walk page. */
export const STORE_WALK_MAX_TIME_MS = 30_000;

interface WalkModel {
  find(filter: Record<string, unknown>): {
    sort(s: Record<string, 1 | -1>): unknown;
  };
}

/**
 * The production source: `CollectionResolver.positionModel(…)` read on a
 * SECONDARY. A hint the server refuses (index missing) is dropped for that
 * shard and the page retried unhinted.
 */
export function mongoStoreSource(resolver: { positionModel(chainId: number, protocol: string): unknown }): FeeStoreSource {
  const noHint = new Set<string>();
  return {
    async walk(chainId, protocol, after, limit) {
      const model = resolver.positionModel(chainId, protocol) as WalkModel;
      const run = (hinted: boolean) => {
        const filter: Record<string, unknown> = { chainId, protocol, isActive: true };
        if (after) filter.positionId = { $gt: after };
        type Q = {
          limit(n: number): Q;
          select(p: Record<string, 0 | 1>): Q;
          read(pref: string): Q;
          maxTimeMS(ms: number): Q;
          hint(h: string): Q;
          lean<T>(): Promise<T>;
        };
        let q = (model.find(filter).sort({ positionId: 1 }) as Q)
          .limit(limit)
          .select(STORE_LOAD_PROJECTION)
          .read('secondary')
          .maxTimeMS(STORE_WALK_MAX_TIME_MS);
        if (hinted) q = q.hint(STORE_WALK_INDEX);
        return q.lean<FeeStoreDoc[]>();
      };
      const key = `${chainId}:${protocol}`;
      if (noHint.has(key)) return run(false);
      try {
        return await run(true);
      } catch (err) {
        if (!/hint|bad ?value|planner returned error/i.test(String((err as Error)?.message ?? err))) throw err;
        noHint.add(key);
        return run(false);
      }
    },
  };
}

/** A store row from a load/reconcile doc; undefined for a doc the store cannot key. */
export function storeRowFromDoc(d: FeeStoreDoc): StoreRow | undefined {
  const positionId = String(d.positionId ?? '');
  if (!positionId) return undefined;
  const tokenId = d.tokenId === undefined || d.tokenId === null ? positionId : String(d.tokenId);
  const rpcBlock = Number(d.rpcFeesBlock);
  const updated = d.updatedAt instanceof Date ? d.updatedAt.getTime() : Number(d.updatedAt ?? 0);
  return {
    positionId,
    tokenId,
    poolId: String(d.poolId ?? ''),
    tickLower: Number(d.tickLower),
    tickUpper: Number(d.tickUpper),
    lastModifyBlock: finiteOr0(d.lastModifyBlock),
    decimals0: Number(d.token0?.decimals),
    decimals1: Number(d.token1?.decimals),
    price0: finiteOr0(d.token0?.priceUsd),
    price1: finiteOr0(d.token1?.priceUsd),
    isPriceable: d.metrics?.isPriceable !== false,
    ...(typeof d.metrics?.feesSource === 'string' ? { feesSource: d.metrics.feesSource } : {}),
    pendingFeesUsd: finiteOr0(d.metrics?.pendingFeesUsd),
    ...(rpcBlock > 0 && d.rpcFeesUncollected0 !== undefined && d.rpcFeesUncollected1 !== undefined
      ? {
          rpc: {
            fees0: String(d.rpcFeesUncollected0),
            fees1: String(d.rpcFeesUncollected1),
            block: rpcBlock,
            ...(d.rpcFeesAt instanceof Date ? { at: d.rpcFeesAt } : {}),
          },
        }
      : {}),
    updatedAtMs: Number.isFinite(updated) ? updated : 0,
  };
}

/** A store row from a fee candidate read by id (the drains' and the served path's fresh docs). */
export function storeRowFromCandidate(c: FeeRefreshCandidate): StoreRow {
  const m = c.stored.metrics ?? {};
  return {
    positionId: c.positionId,
    tokenId: c.tokenId,
    poolId: c.poolId,
    tickLower: c.tickLower,
    tickUpper: c.tickUpper,
    lastModifyBlock: c.lastModifyBlock,
    decimals0: c.decimals0,
    decimals1: c.decimals1,
    price0: finiteOr0(c.stored.token0?.priceUsd),
    price1: finiteOr0(c.stored.token1?.priceUsd),
    isPriceable: m.isPriceable !== false,
    ...(typeof m.feesSource === 'string' ? { feesSource: m.feesSource } : {}),
    pendingFeesUsd: finiteOr0(m.pendingFeesUsd),
    ...(c.rpc ? { rpc: c.rpc } : {}),
    updatedAtMs: c.version instanceof Date ? c.version.getTime() : 0,
  };
}

/**
 * A fee candidate built from RAM, for the DECISIONS only (stale, unchanged,
 * needs-served): a served write always re-reads the doc from the primary.
 */
export function candidateFromStore(r: StoreRow): FeeRefreshCandidate & { fromStore: true; verify?: boolean } {
  return {
    positionId: r.positionId,
    tokenId: r.tokenId,
    poolId: r.poolId,
    tickLower: r.tickLower,
    tickUpper: r.tickUpper,
    decimals0: r.decimals0,
    decimals1: r.decimals1,
    lastModifyBlock: r.lastModifyBlock,
    stored: {
      positionId: r.positionId,
      isActive: true,
      token0: { priceUsd: r.price0 },
      token1: { priceUsd: r.price1 },
      amounts: {},
      metrics: {
        isPriceable: r.isPriceable,
        pendingFeesUsd: r.pendingFeesUsd,
        ...(r.feesSource ? { feesSource: r.feesSource as never } : {}),
      },
    },
    ...(r.rpc ? { rpc: r.rpc } : {}),
    fromStore: true,
    ...(r.verify ? { verify: true } : {}),
  };
}

/** Merge a hint into the row it updates (or build a new row from a complete hint). */
export function rowFromHint(h: FeeRowHint, existing: StoreRow | undefined): StoreRow | undefined {
  const tokenId = h.tokenId ?? existing?.tokenId ?? h.positionId;
  const poolId = h.poolId ?? existing?.poolId;
  const tickLower = h.tickLower ?? existing?.tickLower;
  const tickUpper = h.tickUpper ?? existing?.tickUpper;
  const decimals0 = h.decimals0 ?? existing?.decimals0;
  const decimals1 = h.decimals1 ?? existing?.decimals1;
  if (poolId === undefined || tickLower === undefined || tickUpper === undefined || decimals0 === undefined || decimals1 === undefined) {
    return undefined;
  }
  const feesSource = h.feesSource ?? existing?.feesSource;
  return {
    positionId: h.positionId,
    tokenId,
    poolId,
    tickLower,
    tickUpper,
    lastModifyBlock: h.lastModifyBlock ?? existing?.lastModifyBlock ?? 0,
    decimals0,
    decimals1,
    price0: h.price0 ?? existing?.price0 ?? 0,
    price1: h.price1 ?? existing?.price1 ?? 0,
    isPriceable: h.isPriceable ?? existing?.isPriceable ?? true,
    ...(feesSource !== undefined ? { feesSource } : {}),
    pendingFeesUsd: h.pendingFeesUsd ?? existing?.pendingFeesUsd ?? 0,
    ...(existing?.verify ? { verify: true } : {}),
    ...(existing?.rpc ? { rpc: existing.rpc } : {}),
    updatedAtMs: h.wAt,
  };
}

/** Apply hints to a store (newer-wins; stamps only forward; closures remove). Returns rows changed. */
export function applyHintsToStore(store: FeeCandidateStore, hints: readonly FeeRowHint[]): number {
  let changed = 0;
  for (const h of hints) {
    if (!h.isActive) {
      if (store.remove(h.positionId, h.wAt)) changed++;
      continue;
    }
    const existing = store.get(h.positionId);
    const row = rowFromHint(h, existing);
    if (row) changed += store.upsert([row]);
    if (h.rpc && store.applyStamp(h.positionId, h.rpc)) changed++;
  }
  return changed;
}

/** `[alert] fees.store_not_ready` when a load has run this long without completing. */
export const STORE_NOT_READY_ALERT_MS = 15 * 60_000;
/** `[alert] fees.reconcile_drift` above this share of rows changed by one reconcile. */
export const RECONCILE_DRIFT_ALERT = 0.01;
/** Reconcile after this long of continuous XREAD errors. */
export const XREAD_ERROR_RECONCILE_MS = 60_000;
/** Rows per walk page. */
export const STORE_WALK_PAGE = 1_000;
/** Hints buffered per chain while its load runs (the refresh cron writes every active row: unbounded, ~all actives). */
export const HINT_BUFFER_MAX = 50_000;
/** `[alert] fees.hint_stream_absent` when a ready store (leases on) has seen no hint entry for this long. */
export const HINT_STREAM_ABSENT_MS = 2 * 3_600_000;
/** A failed walk is retried after this (doubling, capped). */
const RETRY_MIN_MS = 30_000;
const RETRY_MAX_MS = 5 * 60_000;

type ChainState = 'idle' | 'loading' | 'ready' | 'error';

interface ChainFeed {
  key: string;
  chainId: number;
  protocol: string;
  store: FeeCandidateStore;
  state: ChainState;
  walking: boolean;
  loadStartedAt?: number;
  loadMs?: number;
  lastReconcileAt?: number;
  reconcileReason?: string;
  retryAt?: number;
  retryMs: number;
  /** Hints held while the boot load runs (latest per id; ≤ HINT_BUFFER_MAX). */
  buffered: Map<string, FeeRowHint>;
  /** Hints dropped instead of buffered (over the bound, or no load running). */
  bufferDropped: number;
  notReadyAlerted: boolean;
  /** When the load completed (the hint-stream-absent clock). */
  readyAt?: number;
  absentAlerted: boolean;
  /** Stream position (leases on): the last entry id read. */
  streamId?: string;
  streamSeen: boolean;
  lossSeen?: string;
  xreadErrorSince?: number;
  /** Counters. */
  hintGaps: number;
  lossEpochs: number;
  reconciles: number;
  lastDrift: number;
  hintsApplied: number;
  mismatched: number;
}

export interface FeeFeedDeps {
  source: FeeStoreSource;
  settings: () => FeeP3Settings;
  logger: Pick<Logger, 'warn' | 'log' | 'debug'>;
  coord?: FeeCoordination;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface FeeStoreStatus {
  rows: number;
  ready: boolean;
  state: ChainState;
  loadMs?: number;
  lastReconcileAt?: string;
  hintGaps: number;
  lossEpochs: number;
  reconciles: number;
  lastDrift: number;
  bytes: number;
  stringIds: boolean;
  buffered: number;
  bufferDropped: number;
}

export class FeeCandidateFeed {
  private readonly chains = new Map<string, ChainFeed>();
  private stopped = false;

  constructor(private readonly deps: FeeFeedDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private sleep(ms: number): Promise<void> {
    return this.deps.sleep ? this.deps.sleep(ms) : new Promise((r) => setTimeout(r, ms));
  }

  private leasesOn(): boolean {
    return Boolean(this.deps.coord?.leasesEnabled);
  }

  stop(): void {
    this.stopped = true;
  }

  store(chainId: number, protocol: string): FeeCandidateStore | undefined {
    return this.chains.get(`${chainId}:${protocol}`)?.store;
  }

  /** Whether the fee pass may take its pages from this chain's store (loading or ready, not failing). */
  usable(chainId: number, protocol: string): boolean {
    const cf = this.chains.get(`${chainId}:${protocol}`);
    return !!cf && (cf.state === 'loading' || cf.state === 'ready');
  }

  /**
   * Start the chain's boot load in the BACKGROUND if it has not started (or
   * retry a failed one once its backoff passed). Never awaits the walk.
   */
  start(chainId: number, protocol: string): void {
    if (this.stopped) return;
    const key = `${chainId}:${protocol}`;
    let cf = this.chains.get(key);
    if (!cf) {
      cf = {
        key,
        chainId,
        protocol,
        store: new FeeCandidateStore(),
        state: 'idle',
        walking: false,
        retryMs: RETRY_MIN_MS,
        buffered: new Map(),
        bufferDropped: 0,
        notReadyAlerted: false,
        absentAlerted: false,
        streamSeen: false,
        hintGaps: 0,
        lossEpochs: 0,
        reconciles: 0,
        lastDrift: 0,
        hintsApplied: 0,
        mismatched: 0,
      };
      this.chains.set(key, cf);
    }
    if (cf.walking) return;
    if (cf.state === 'idle' || (cf.state === 'error' && this.now() >= (cf.retryAt ?? 0) && !cf.store.complete)) {
      void this.load(cf);
    }
  }

  /** Ask for a reconcile of a chain (a loss signal); runs on the next `maintain`. */
  requestReconcile(chainId: number, protocol: string, reason: string): void {
    const cf = this.chains.get(`${chainId}:${protocol}`);
    if (cf && !cf.reconcileReason) cf.reconcileReason = reason;
  }

  /**
   * Periodic upkeep for one chain: the not-ready alert, a due or requested
   * reconcile (background), a failed load's retry.
   */
  maintain(chainId: number, protocol: string): void {
    const cf = this.chains.get(`${chainId}:${protocol}`);
    if (!cf || this.stopped) return;
    const now = this.now();
    if (!cf.store.complete && cf.loadStartedAt !== undefined && !cf.notReadyAlerted && now - cf.loadStartedAt > STORE_NOT_READY_ALERT_MS) {
      cf.notReadyAlerted = true;
      this.deps.logger.warn(
        `[alert] fees.store_not_ready chain=${chainId} rows=${cf.store.size} state=${cf.state} — ` +
          `the boot load has run ${Math.round((now - cf.loadStartedAt) / 60_000)} min`,
      );
    }
    if (cf.walking) return;
    if (!cf.store.complete) {
      if (cf.state === 'error' && now >= (cf.retryAt ?? 0)) void this.load(cf);
      return;
    }
    const due = cf.lastReconcileAt !== undefined && now - cf.lastReconcileAt >= this.deps.settings().reconcileMs;
    const retryOk = cf.retryAt === undefined || now >= cf.retryAt;
    if ((cf.reconcileReason || due) && retryOk) void this.reconcile(cf, cf.reconcileReason ?? 'interval');
  }

  /**
   * Hints from this process's writers (leases off) or from the stream. While
   * the chain's boot load runs they are buffered and applied after each page.
   */
  applyHints(chainId: number, protocol: string, hints: readonly FeeRowHint[]): void {
    const cf = this.chains.get(`${chainId}:${protocol}`);
    if (!cf || hints.length === 0) return;
    if (!cf.store.complete) {
      const ready: FeeRowHint[] = [];
      let dropped = 0;
      for (const h of hints) {
        // Already covered by the load: applied now (newer-wins), never buffered.
        if (cf.store.covers(h.positionId)) {
          ready.push(h);
          continue;
        }
        const prev = cf.buffered.get(h.positionId);
        if (prev) {
          if (h.wAt >= prev.wAt || (h.lastModifyBlock ?? 0) > (prev.lastModifyBlock ?? 0)) cf.buffered.set(h.positionId, h);
          continue;
        }
        // Only while a load is actually walking, and bounded.
        if (cf.state !== 'loading' || cf.buffered.size >= HINT_BUFFER_MAX) {
          dropped++;
          continue;
        }
        cf.buffered.set(h.positionId, h);
      }
      if (ready.length > 0) cf.hintsApplied += applyHintsToStore(cf.store, ready);
      if (dropped > 0) this.dropHints(cf, dropped, cf.state === 'loading' ? 'hint buffer full' : 'hints while the load is not running');
      this.applyBuffered(cf);
      return;
    }
    cf.hintsApplied += applyHintsToStore(cf.store, hints);
  }

  /**
   * Hints for rows the load has not reached, not kept: the load reads those rows
   * itself; a reconcile once it completes catches any it read from a secondary
   * still behind the dropped hint.
   */
  private dropHints(cf: ChainFeed, n: number, why: string): void {
    cf.bufferDropped += n;
    if (!cf.reconcileReason) {
      cf.reconcileReason = `${why} (${n} dropped)`;
      this.deps.logger.warn(
        `Fee store ${cf.key}: ${why} — ${n} hints for rows the load has not reached dropped; reconciling once it completes`,
      );
    }
  }

  /** Buffered hints the load now covers (all of them once complete). */
  private applyBuffered(cf: ChainFeed): void {
    if (cf.buffered.size === 0) return;
    const ready: FeeRowHint[] = [];
    for (const [id, h] of cf.buffered) {
      if (cf.store.covers(id)) {
        ready.push(h);
        cf.buffered.delete(id);
      }
    }
    if (ready.length > 0) cf.hintsApplied += applyHintsToStore(cf.store, ready);
  }

  private async load(cf: ChainFeed): Promise<void> {
    cf.walking = true;
    cf.state = 'loading';
    cf.loadStartedAt ??= this.now();
    try {
      if (this.leasesOn()) await this.recordStreamTail(cf);
      await this.walk(cf, 'load');
      cf.state = 'ready';
      cf.readyAt = this.now();
      cf.loadMs = this.now() - (cf.loadStartedAt ?? this.now());
      cf.lastReconcileAt = this.now();
      cf.retryAt = undefined;
      cf.retryMs = RETRY_MIN_MS;
      this.applyBuffered(cf);
      this.deps.logger.log(
        `Fee store ${cf.key} loaded rows=${cf.store.size} in ${Math.round((cf.loadMs ?? 0) / 1000)}s ` +
          `(~${Math.round(cf.store.byteSize() / 1_048_576)} MB)`,
      );
    } catch (err) {
      this.failed(cf, 'load', err);
    } finally {
      cf.walking = false;
    }
  }

  private async reconcile(cf: ChainFeed, reason: string): Promise<void> {
    cf.walking = true;
    cf.reconcileReason = undefined;
    const before = cf.store.size;
    try {
      const changed = await this.walk(cf, 'reconcile');
      cf.reconciles++;
      cf.lastReconcileAt = this.now();
      cf.retryAt = undefined;
      cf.retryMs = RETRY_MIN_MS;
      cf.lastDrift = changed / Math.max(1, Math.max(before, cf.store.size));
      const line = `Fee store ${cf.key} reconciled (${reason}) rows=${cf.store.size} changed=${changed}`;
      if (cf.lastDrift > RECONCILE_DRIFT_ALERT) {
        this.deps.logger.warn(
          `[alert] fees.reconcile_drift chain=${cf.chainId} reason=${reason} changed=${changed} rows=${cf.store.size} ` +
            `drift=${(cf.lastDrift * 100).toFixed(2)}% — writer hints are being lost or the store was stale`,
        );
      } else {
        this.deps.logger.log(line);
      }
    } catch (err) {
      cf.reconcileReason ??= reason;
      this.failed(cf, 'reconcile', err);
    } finally {
      cf.walking = false;
    }
  }

  private failed(cf: ChainFeed, what: string, err: unknown): void {
    cf.retryAt = this.now() + cf.retryMs;
    cf.retryMs = Math.min(RETRY_MAX_MS, cf.retryMs * 2);
    // A failed LOAD makes the chain unusable (the pass reads Mongo pages as today); a
    // failed reconcile leaves a complete store in service.
    if (!cf.store.complete) {
      cf.state = 'error';
      // Nothing walks until the retry: the buffer would only grow (≈ every active row a refresh cycle).
      if (cf.buffered.size > 0) {
        const n = cf.buffered.size;
        cf.buffered.clear();
        this.dropHints(cf, n, 'load failed');
      }
    }
    this.deps.logger.warn(
      `[alert] fees.store_${what}_failed chain=${cf.chainId} rows=${cf.store.size} err=${(err as Error)?.message ?? String(err)} — ` +
        `retry in ${Math.round((cf.retryAt - this.now()) / 1000)}s${cf.store.complete ? '' : '; the fee pass reads Mongo pages meanwhile'}`,
    );
  }

  /** The keyset walk: pages diffed into the store, paced. Returns rows changed. */
  private async walk(cf: ChainFeed, mode: 'load' | 'reconcile'): Promise<number> {
    const s = this.deps.settings();
    const pace = mode === 'load' ? s.loadDocsPerSec : s.reconcileDocsPerSec;
    const pageSize = Math.max(1, Math.min(STORE_WALK_PAGE, pace));
    let after = mode === 'load' ? cf.store.coveredThrough : '';
    let changed = 0;
    for (;;) {
      if (this.stopped) throw new Error('feed stopped');
      const t0 = this.now();
      const docs = await this.deps.source.walk(cf.chainId, cf.protocol, after, pageSize);
      const rows: StoreRow[] = [];
      for (const d of docs) {
        const r = storeRowFromDoc(d);
        if (!r) continue;
        if (r.tokenId !== r.positionId) {
          cf.mismatched++;
          throw new Error(`positionId ${r.positionId} != tokenId ${r.tokenId}: the store's order would not be the pass's`);
        }
        rows.push(r);
      }
      const last = docs.length < pageSize ? undefined : String(docs[docs.length - 1]!.positionId);
      changed += cf.store.reconcileRange(after, last, rows, t0);
      if (mode === 'load') this.applyBuffered(cf);
      if (last === undefined) break;
      after = last;
      const wantMs = (docs.length / pace) * 1000;
      const spent = this.now() - t0;
      if (wantMs > spent) await this.sleep(wantMs - spent);
    }
    return changed;
  }

  // ─── the hint stream (leases on) ───────────────────────────────────────────

  /** Before a load scan: the stream's newest id, so hints written during the scan are read after it. */
  private async recordStreamTail(cf: ChainFeed): Promise<void> {
    if (cf.streamId !== undefined) return;
    const coord = this.deps.coord;
    if (!coord) return;
    const redis = await coord.modelsRedis().catch(() => undefined);
    if (!redis) {
      cf.streamId = '0-0';
      return;
    }
    try {
      const tail = await redis.xrevrange(hintStreamKey(coord.namespace, cf.chainId, cf.protocol), '+', '-', 'COUNT', 1);
      cf.streamId = tail?.[0]?.[0] ?? '0-0';
      cf.streamSeen = Boolean(tail?.[0]);
    } catch {
      cf.streamId = '0-0';
    }
  }

  /**
   * One non-blocking XREAD over every started chain's stream (never BLOCK: the
   * redis-models connection is shared), then the loss / gap / reset checks.
   * Called about once a second by the fee worker while it holds the lease.
   */
  async consumeOnce(): Promise<number> {
    const coord = this.deps.coord;
    if (!coord || !this.leasesOn() || this.stopped) return 0;
    const feeds = [...this.chains.values()].filter((cf) => cf.streamId !== undefined);
    if (feeds.length === 0) return 0;
    let applied = 0;
    let redis: FeeRedis | undefined;
    try {
      redis = await coord.modelsRedis();
      if (!redis) throw new Error('redis-models unavailable');
      // BEFORE reading: a stream trimmed past our position would otherwise hand
      // us the survivors and the gap would go unnoticed.
      await this.checkGaps(redis, feeds);
      const keys = feeds.map((cf) => hintStreamKey(coord.namespace, cf.chainId, cf.protocol));
      const res = await redis.xread('COUNT', 500, 'STREAMS', ...keys, ...feeds.map((cf) => cf.streamId!));
      for (const [stream, entries] of res ?? []) {
        const cf = feeds[keys.indexOf(String(stream))];
        if (!cf) continue;
        for (const [id, fields] of entries) {
          const hints = decodeEntry(fields);
          this.applyHints(cf.chainId, cf.protocol, hints);
          applied += hints.length;
          cf.streamId = id;
          cf.streamSeen = true;
        }
      }
      for (const cf of feeds) cf.xreadErrorSince = undefined;
    } catch (err) {
      const now = this.now();
      for (const cf of feeds) {
        cf.xreadErrorSince ??= now;
        if (now - cf.xreadErrorSince >= XREAD_ERROR_RECONCILE_MS) {
          cf.xreadErrorSince = now;
          this.signalLoss(cf, `xread errors for ${Math.round(XREAD_ERROR_RECONCILE_MS / 1000)}s (${(err as Error)?.message ?? String(err)})`);
        }
      }
      return applied;
    }
    await this.checkLoss(feeds);
    await this.announceMode();
    this.checkAbsent(feeds);
    return applied;
  }

  private announcedAt = Number.NEGATIVE_INFINITY;

  /** Leases on, memory candidates: tell writers in other roles to publish (`feeModeKey`, PX). */
  private async announceMode(): Promise<void> {
    const coord = this.deps.coord;
    if (!coord || this.deps.settings().candidates !== 'memory') return;
    const now = this.now();
    if (now - this.announcedAt < FEE_MODE_ANNOUNCE_MS) return;
    const state = await coord.stateRedis().catch(() => undefined);
    if (!state) return;
    try {
      await state.eval(SET_MODE_SCRIPT, 1, feeModeKey(coord.namespace), 'memory', FEE_MODE_TTL_MS);
      this.announcedAt = now;
    } catch {
      // retried next loop
    }
  }

  /** A ready store that has never seen a hint entry: writers are not publishing (misconfigured role, say). */
  private checkAbsent(feeds: ChainFeed[]): void {
    const now = this.now();
    for (const cf of feeds) {
      if (cf.absentAlerted || cf.streamSeen || cf.readyAt === undefined) continue;
      if (now - cf.readyAt < HINT_STREAM_ABSENT_MS) continue;
      cf.absentAlerted = true;
      this.deps.logger.warn(
        `[alert] fees.hint_stream_absent chain=${cf.chainId} — the store has been ready ${Math.round((now - cf.readyAt) / 60_000)} min ` +
          `with no writer hint on its stream: positions created or reopened since the load miss every pass until a reconcile ` +
          `(check the writers reach redis-models and see the mode announcement)`,
      );
    }
  }

  private async checkGaps(redis: FeeRedis, feeds: ChainFeed[]): Promise<void> {
    const coord = this.deps.coord!;
    for (const cf of feeds) {
      try {
        const first = await redis.xrange(hintStreamKey(coord.namespace, cf.chainId, cf.protocol), '-', '+', 'COUNT', 1);
        const firstId = first?.[0]?.[0];
        if (!firstId) {
          // The stream is gone after we had read from it: redis-models restarted or was flushed.
          if (cf.streamSeen) {
            cf.streamSeen = false;
            cf.streamId = '0-0';
            this.signalLoss(cf, 'hint stream reset');
          }
          continue;
        }
        if (cf.streamId !== '0-0' && compareStreamIds(firstId, cf.streamId!) > 0) {
          // Trimmed past what we read: entries between were never applied.
          cf.streamId = '0-0';
          this.signalLoss(cf, 'hint stream trimmed past the consumer');
        }
      } catch {
        // The next consume's error path covers a dead connection.
      }
    }
  }

  private async checkLoss(feeds: ChainFeed[]): Promise<void> {
    const coord = this.deps.coord!;
    const state = await coord.stateRedis().catch(() => undefined);
    if (!state) return;
    for (const cf of feeds) {
      try {
        const v = (await state.get(hintLossKey(coord.namespace, cf.chainId, cf.protocol))) ?? '0';
        if (cf.lossSeen === undefined) {
          cf.lossSeen = v;
          continue;
        }
        if (v !== cf.lossSeen) {
          cf.lossSeen = v;
          cf.lossEpochs++;
          this.signalLoss(cf, `hint loss counter moved to ${v}`);
        }
      } catch {
        // Unreadable now; checked again next loop.
      }
    }
  }

  private signalLoss(cf: ChainFeed, reason: string): void {
    cf.hintGaps++;
    this.deps.logger.warn(`[alert] fees.hint_gap chain=${cf.chainId} reason=${reason} — reconciling the chain's store from the secondary`);
    cf.reconcileReason ??= reason;
  }

  status(): Record<string, FeeStoreStatus> {
    const out: Record<string, FeeStoreStatus> = {};
    for (const [key, cf] of this.chains) {
      out[key] = {
        rows: cf.store.size,
        ready: cf.store.complete,
        state: cf.state,
        ...(cf.loadMs !== undefined ? { loadMs: cf.loadMs } : {}),
        ...(cf.lastReconcileAt !== undefined ? { lastReconcileAt: new Date(cf.lastReconcileAt).toISOString() } : {}),
        hintGaps: cf.hintGaps,
        lossEpochs: cf.lossEpochs,
        reconciles: cf.reconciles,
        lastDrift: cf.lastDrift,
        bytes: cf.store.byteSize(),
        stringIds: cf.store.stringIds,
        buffered: cf.buffered.size,
        bufferDropped: cf.bufferDropped,
      };
    }
    return out;
  }
}

/** Redis stream ids `<ms>-<seq>` compared numerically. */
export function compareStreamIds(a: string, b: string): number {
  const [am, as] = a.split('-').map((x) => BigInt(x || '0'));
  const [bm, bs] = b.split('-').map((x) => BigInt(x || '0'));
  if (am !== bm) return am! < bm! ? -1 : 1;
  if (as !== bs) return (as ?? 0n) < (bs ?? 0n) ? -1 : 1;
  return 0;
}

function finiteOr0(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
