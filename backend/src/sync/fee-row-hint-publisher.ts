import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service.js';
import type { FeeRowHint, PositionWriteObserver } from '../database/positions.repository.js';
import { resolveFeeP3Settings } from './fee-measurer.js';
import { FEE_COORDINATION, feeModeKey, type FeeCoordination, type FeeRedis } from './fee-signals.js';

/*
 * P3.3 writer hints (design §9.2): every position write tells the fee store
 * what it stored — no extra Mongo read anywhere.
 *
 * Bound by the integrator as `POSITION_WRITE_OBSERVER` (useExisting) and
 * provided where `PositionsRepository` can see it (DatabaseModule is global).
 * The fee service attaches itself as the LOCAL sink at construction.
 *
 *   - Leases OFF (one process): hints go straight into this process's store
 *     (`sink.applyHints`) — synchronous, cannot be lost.
 *   - Leases ON (the writer and the fee worker may be different processes):
 *     `XADD tw:fee:v1:<ns>:rows:<chainId>:<protocol> MAXLEN ~ N` on
 *     redis-models (`REDIS_MODELS_URL ?? REDIS_URL`), ≤ HINTS_PER_ENTRY rows per
 *     entry (MAXLEN in entries = 20,000 rows / HINTS_PER_ENTRY). A failed XADD
 *     `INCR`s `tw:fee:v1:<ns>:loss:<chainId>:<protocol>` on redis-state, and if
 *     that fails too a local flag retries the INCR before the next XADD; the
 *     consumer reconciles the chain whenever that counter moves.
 *   - Nothing is published unless a store consumes it: leases off, this
 *     process's own `POSITION_FEE_CANDIDATES=memory`; leases ON, that OR the
 *     fee worker's announcement on redis-state (`tw:fee:v1:<ns>:mode` =
 *     `memory`, re-checked every MODE_CHECK_MS) — the WRITER (sync role) need
 *     not carry the fee role's setting, and a store that silently got no hints
 *     would leave new positions out of every pass until the reconcile.
 *     `onFeeReread` always reaches the fee job (a re-read request, not a hint).
 *
 * Never throws and never blocks the writer (the repository calls it
 * synchronously after each chunk): the XADD runs in the background.
 */

/** What the fee service exposes to the publisher. */
export interface FeeHintSink {
  /** Apply hints to this process's store (leases off). */
  applyHints(chainId: number, protocol: string, rows: readonly FeeRowHint[]): void;
  /** A carried P3.1 stamp was not newer than the stored one: re-read on the backfill lane. */
  markDirty(chainId: number, tokenIds: Iterable<string>, protocol: string, blocks?: ReadonlyMap<string, number>, opts?: { lane?: 'live' | 'backfill' }): void;
}

/** Rows per stream entry (one XADD carries up to this many hints). */
export const HINTS_PER_ENTRY = 25;
/** The stream holds about this many ROWS (design: MAXLEN ~ 20000). */
export const HINT_STREAM_ROWS = 20_000;
export const HINT_STREAM_MAXLEN = Math.ceil(HINT_STREAM_ROWS / HINTS_PER_ENTRY);
/** The single field of a stream entry. */
export const HINT_FIELD = 'h';
/** How often a writer re-reads the fee worker's mode announcement (leases on). */
export const MODE_CHECK_MS = 30_000;

export function hintStreamKey(namespace: string, chainId: number, protocol: string): string {
  return `tw:fee:v1:${namespace}:rows:${chainId}:${protocol}`;
}

export function hintLossKey(namespace: string, chainId: number, protocol: string): string {
  return `tw:fee:v1:${namespace}:loss:${chainId}:${protocol}`;
}

/** Compact JSON of one hint (~0.2 KB): short keys, absent fields omitted. */
export function encodeHint(h: FeeRowHint): Record<string, unknown> {
  const o: Record<string, unknown> = { p: h.positionId, a: h.isActive ? 1 : 0, w: h.wAt };
  if (h.tokenId !== undefined) o.t = h.tokenId;
  if (h.poolId !== undefined) o.o = h.poolId;
  if (h.tickLower !== undefined) o.l = h.tickLower;
  if (h.tickUpper !== undefined) o.u = h.tickUpper;
  if (h.lastModifyBlock !== undefined) o.b = h.lastModifyBlock;
  if (h.decimals0 !== undefined) o.d0 = h.decimals0;
  if (h.decimals1 !== undefined) o.d1 = h.decimals1;
  if (h.price0 !== undefined) o.x0 = h.price0;
  if (h.price1 !== undefined) o.x1 = h.price1;
  if (h.isPriceable !== undefined) o.q = h.isPriceable ? 1 : 0;
  if (h.feesSource !== undefined) o.s = h.feesSource;
  if (h.pendingFeesUsd !== undefined) o.f = h.pendingFeesUsd;
  if (h.rpc) o.r = [h.rpc.fees0, h.rpc.fees1, h.rpc.block, h.rpc.at instanceof Date ? h.rpc.at.getTime() : null];
  return o;
}

/** The inverse of `encodeHint`; undefined for anything malformed. */
export function decodeHint(o: unknown): FeeRowHint | undefined {
  if (!o || typeof o !== 'object') return undefined;
  const r = o as Record<string, unknown>;
  if (typeof r.p !== 'string' || !Number.isFinite(Number(r.w))) return undefined;
  const h: FeeRowHint = { positionId: r.p, isActive: r.a === 1 || r.a === true, wAt: Number(r.w) };
  if (typeof r.t === 'string') h.tokenId = r.t;
  if (typeof r.o === 'string') h.poolId = r.o;
  if (r.l !== undefined) h.tickLower = Number(r.l);
  if (r.u !== undefined) h.tickUpper = Number(r.u);
  if (r.b !== undefined) h.lastModifyBlock = Number(r.b);
  if (r.d0 !== undefined) h.decimals0 = Number(r.d0);
  if (r.d1 !== undefined) h.decimals1 = Number(r.d1);
  if (r.x0 !== undefined) h.price0 = Number(r.x0);
  if (r.x1 !== undefined) h.price1 = Number(r.x1);
  if (r.q !== undefined) h.isPriceable = r.q === 1 || r.q === true;
  if (typeof r.s === 'string') h.feesSource = r.s;
  if (r.f !== undefined) h.pendingFeesUsd = Number(r.f);
  if (Array.isArray(r.r) && r.r.length >= 3) {
    const [f0, f1, b, at] = r.r as unknown[];
    if (typeof f0 === 'string' && typeof f1 === 'string' && Number.isFinite(Number(b))) {
      h.rpc = { fees0: f0, fees1: f1, block: Number(b), ...(at !== null && at !== undefined && Number.isFinite(Number(at)) ? { at: new Date(Number(at)) } : {}) };
    }
  }
  return h;
}

/** Decode one stream entry's field list (`['h', '[…]']`) into hints. */
export function decodeEntry(fields: readonly string[]): FeeRowHint[] {
  const out: FeeRowHint[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    if (fields[i] !== HINT_FIELD) continue;
    try {
      const arr = JSON.parse(fields[i + 1]!) as unknown;
      if (!Array.isArray(arr)) continue;
      for (const o of arr) {
        const h = decodeHint(o);
        if (h) out.push(h);
      }
    } catch {
      // A malformed entry is skipped; the reconcile repairs whatever it carried.
    }
  }
  return out;
}

@Injectable()
export class FeeRowHintPublisher implements PositionWriteObserver {
  private readonly logger = new Logger(FeeRowHintPublisher.name);
  private sink?: FeeHintSink;
  /** Per stream: a loss whose INCR also failed — retried before the next XADD. */
  private readonly pendingLoss = new Set<string>();
  /** Counters (observability, specs). */
  readonly stats = { published: 0, entries: 0, failed: 0, lossIncrements: 0, direct: 0 };
  private alertedAt = Number.NEGATIVE_INFINITY;
  /** The fee worker's announced mode (leases on): last answer and when it was read. */
  private consumerMemory?: boolean;
  private modeCheckedAt = Number.NEGATIVE_INFINITY;
  private modeCheck?: Promise<boolean>;

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Optional() @Inject(FEE_COORDINATION) private readonly coord?: FeeCoordination,
  ) {}

  /** The fee service in this process. */
  attach(sink: FeeHintSink): void {
    this.sink = sink;
  }

  private memoryMode(): boolean {
    return resolveFeeP3Settings(this.config).candidates === 'memory';
  }

  onWritten(chainId: number, protocol: string, rows: readonly FeeRowHint[]): void {
    if (rows.length === 0) return;
    if (!this.coord?.leasesEnabled) {
      if (!this.memoryMode()) return;
      this.stats.direct += rows.length;
      this.sink?.applyHints(chainId, protocol, rows);
      return;
    }
    void this.publishIfConsumed(chainId, protocol, rows);
  }

  /** Leases on: publish when this process OR the fee worker runs memory candidates. */
  async publishIfConsumed(chainId: number, protocol: string, rows: readonly FeeRowHint[]): Promise<void> {
    if (!this.memoryMode() && !(await this.consumerInMemory())) return;
    await this.publish(chainId, protocol, rows);
  }

  /**
   * Whether the fee worker announced memory mode (cached MODE_CHECK_MS). An
   * unreadable answer keeps the last one — and before any answer, publishes
   * (fail toward the hints: an XADD is cheap, a store missing new positions is not).
   */
  private consumerInMemory(): Promise<boolean> {
    const now = Date.now();
    if (now - this.modeCheckedAt < MODE_CHECK_MS) return Promise.resolve(this.consumerMemory ?? true);
    this.modeCheck ??= (async () => {
      try {
        const state = await this.coord?.stateRedis();
        if (!state) throw new Error('redis-state unavailable');
        this.consumerMemory = (await state.get(feeModeKey(this.coord!.namespace))) === 'memory';
      } catch {
        // keep the last answer
      } finally {
        this.modeCheckedAt = Date.now();
        this.modeCheck = undefined;
      }
      return this.consumerMemory ?? true;
    })();
    return this.modeCheck;
  }

  onFeeReread(chainId: number, protocol: string, positionIds: readonly string[]): void {
    if (positionIds.length === 0) return;
    this.sink?.markDirty(chainId, positionIds, protocol, undefined, { lane: 'backfill' });
  }

  /** Publish rows to the chain's stream (awaitable for specs; production never awaits it). */
  async publish(chainId: number, protocol: string, rows: readonly FeeRowHint[]): Promise<void> {
    const coord = this.coord;
    if (!coord) return;
    const stream = hintStreamKey(coord.namespace, chainId, protocol);
    const lossKey = hintLossKey(coord.namespace, chainId, protocol);
    let redis: FeeRedis | undefined;
    try {
      redis = await coord.modelsRedis();
    } catch {
      redis = undefined;
    }
    try {
      if (!redis) throw new Error('redis-models unavailable');
      for (let i = 0; i < rows.length; i += HINTS_PER_ENTRY) {
        const payload = JSON.stringify(rows.slice(i, i + HINTS_PER_ENTRY).map(encodeHint));
        await redis.xadd(stream, 'MAXLEN', '~', HINT_STREAM_MAXLEN, '*', HINT_FIELD, payload);
        this.stats.entries++;
      }
      this.stats.published += rows.length;
      if (this.pendingLoss.has(lossKey)) await this.incrLoss(lossKey);
    } catch (err) {
      this.stats.failed += rows.length;
      this.alert(`[alert] fees.hint_publish_failed chain=${chainId} rows=${rows.length} err=${(err as Error)?.message ?? String(err)}`);
      await this.incrLoss(lossKey);
    }
  }

  private async incrLoss(lossKey: string): Promise<void> {
    try {
      const state = await this.coord?.stateRedis();
      if (!state) throw new Error('redis-state unavailable');
      await state.incr(lossKey);
      this.stats.lossIncrements++;
      this.pendingLoss.delete(lossKey);
    } catch {
      this.pendingLoss.add(lossKey);
    }
  }

  private alert(line: string): void {
    const now = Date.now();
    if (now - this.alertedAt < 60_000) return;
    this.alertedAt = now;
    this.logger.warn(`${line} — the consumer reconciles the chain from the secondary`);
  }
}
