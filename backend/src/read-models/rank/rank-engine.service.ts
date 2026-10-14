import { Inject, Injectable, Logger, Optional, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { listCacheTtl, listWindowRows, type CacheStatus } from '../../common/cache/swr-cache.js';
import { ReadBudgetService } from '../../common/read-budget.js';
import { AppConfigService } from '../../config/app-config.service.js';
import type { LeaderboardPlan, PoolPositionCounts, PositionsSnapshotReference } from '../../database/positions.repository.js';
import type { Position } from '../../database/schemas/position.schema.js';
import { QueryTimeoutException, SnapshotUnavailableError } from '../../database/user-read.js';
import { CountQueueFullError, unmeteredCount, type CountResult, type CountTask } from '../../leaderboard/count-cache.js';
import { createEngineRunner, EngineOverloadError, type EngineRunner } from '../core/engine-runner.js';
import { shardKey } from '../core/fields.js';
import { ResultCache } from '../core/result-cache.js';
import { resolveRole, selectedForServe, type ReadModelMode } from '../flags.js';
import { parseClusterTime } from '../pools/pool-catalog.service.js';
import { ReadModelsService } from '../read-models.service.js';
import { LANE_A_MAX_AGE_MS, LANE_A_MAX_DOCS, LaneABudget, LaneAMeter } from '../shadow/pools-lane-a.js';
import { diffRankLaneAnswers, estimateRankReferenceDocs, mongoRankLaneAnswer, rankBucket, type RankLaneAnswer, type RankReferenceShard } from '../shadow/rank-lane-a.js';
import { RANK_PERMS, rankPermFor } from './rank-columns.js';
import { RankEngine, RankUnsupported, type RankAnswer, type RankAnswerShardInput } from './rank-engine.js';
import { compileRankFilter, type RankCompileResult } from './rank-query.js';

/**
 * The rank engine's Nest face (Phase P-R R3): the generation timer, the
 * per-request route (`serve` → the engine answers; anything not servable →
 * today's Mongo path, metered by reason), the answer cache, engine counts,
 * engine holder counts for the pools routes, and lane A (shadow AND serve).
 *
 * `off` (the default): nothing starts — no timer, no worker, no memory.
 * `shadow`: the engine is built and maintained and lane A checks sampled
 * requests against Mongo at the answer's clusterTime; every response is still
 * Mongo's, byte for byte (no engine answer, no holder count, no eviction).
 * `serve`: the engine answers what it can.
 *
 * It reaches Mongo only through `PositionsAccess` (the leaderboard service's
 * repository): the cast of a plan, rows by positionId at a clusterTime, and
 * the lane-A reference reads.
 */

/** What the engine needs of the positions repository. */
export interface PositionsAccess {
  cast(chainId: number, protocol: string, filter: Record<string, unknown>): Record<string, unknown>;
  rows(chainId: number, protocol: string, positionIds: readonly string[], options: { atClusterTime?: { t: number; i: number }; meta?: { snapshotFallback?: boolean } }): Promise<Position[]>;
  reference(
    chainId: number,
    protocol: string,
    args: {
      filter: Record<string, unknown>;
      collated: boolean;
      sortField: string;
      sortDirection: 1 | -1;
      tieDirection: 1 | -1;
      skip: number;
      limit: number;
      cap: number;
      atClusterTime: { t: number; i: number };
      maxTimeMS: number;
    },
  ): Promise<PositionsSnapshotReference>;
  poolCounts?(chainId: number, protocol: string, poolIds: readonly string[], args: { atClusterTime: { t: number; i: number }; maxTimeMS: number }): Promise<Map<string, PoolPositionCounts>>;
}

export interface CachedRankAnswer extends RankAnswer {
  key: string;
  pages: Map<string, RankPage>;
}

export interface RankPage {
  positions: Position[];
  hasMore: boolean;
  /** Exact matches over the chains on the page (uncapped). */
  total: number;
  missingChains: number[];
  errors: Array<{ chainId: number; error: unknown }>;
}

export type RankListOutcome =
  | ({ kind: 'ok'; cache: CacheStatus; dataAt: number; answer: CachedRankAnswer } & RankPage)
  | { kind: 'fallback'; reason: string };

interface Prepared {
  inputs: RankAnswerShardInput[];
  perm: number;
  reverse: boolean;
  key: string;
  cacheable: boolean;
  collated: boolean;
  shape: LeaderboardPlan['shape'];
}

const ROW_BYTES_ESTIMATE = 3_000;
const COMPILED_MAX = 4_000;
/** How long an answer-time refusal on a shard keeps the warmup's full cycle there (design §3.8). */
const REFUSAL_HOLD_MS = 10 * 60_000;

@Injectable()
export class RankEngineService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('RankEngine');
  private engineRunner?: EngineRunner;
  private sharedEngine = false;
  engine?: RankEngine;
  private timer?: ReturnType<typeof setInterval>;
  private readonly compiled = new Map<string, RankCompileResult>();
  private readonly answers: ResultCache<CachedRankAnswer>;
  readonly lane = new LaneAMeter();
  readonly holderLane = new LaneAMeter();
  private readonly meter = {
    served: 0,
    counted: 0,
    overload: 0,
    partial: 0,
    recomputed: 0,
    snapshotFallback: 0,
    holderCounts: 0,
    holderAmbiguous: 0,
    fallback: {} as Record<string, number>,
  };
  private holdersListener?: (keys: string[]) => void;
  /** When the engine last refused an answer on a shard (`shardKey` → ms). */
  private readonly refusedAt = new Map<string, number>();
  private stopping = false;
  /** Lane A's own read budget (≤ 2k docs/s per process) — never the user one. */
  private readonly laneBudget = new LaneABudget();

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(ReadModelsService) private readonly readModels: ReadModelsService,
    @Optional() @Inject(ReadBudgetService) private readonly budget?: ReadBudgetService,
  ) {
    const ttl = listCacheTtl(config);
    this.answers = new ResultCache<CachedRankAnswer>(
      { ...ttl, maxBytes: 96 * 1024 * 1024, jitter: 0.1, onBackgroundError: (key, err) => this.logger.warn(`answer refresh failed ${key.slice(0, 80)}: ${(err as Error)?.message ?? err}`) },
      (answer) => answer.slots.byteLength + (answer.shard?.byteLength ?? 0) + [...answer.pages.values()].reduce((sum, page) => sum + page.positions.length * ROW_BYTES_ESTIMATE, 0) + 512,
      (answer) => this.engine?.isCurrent(answer) ?? false,
    );
  }

  onApplicationBootstrap(): void {
    if (this.readModels.configuredModes().rank === 'off') return;
    const role = resolveRole(this.config.readModelsRole, this.config.processRole);
    if (role !== 'both' && role !== 'server') return;
    this.readModels.registerStatus('rank', () => this.status());
    // The memory guard's cache stages (§4.11): 80% drops the answer cache, 85%
    // also the compiled plans (the passes' bitsets are bounded per worker).
    (this.readModels as { registerShedder?: (name: string, shed: (stage: 80 | 85) => void) => void }).registerShedder?.('rank', (stage) => {
      this.answers.clear();
      if (stage === 85) this.compiled.clear();
    });
    this.timer = setInterval(() => void this.tick(), this.config.readModelsGenerationMs);
    this.timer.unref?.();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.teardown();
  }

  /** The rank model's effective mode in this process. */
  mode(): ReadModelMode {
    return this.readModels.effectiveMode('rank');
  }

  /** Called (serve only) with `chainId:protocol:poolId` of every pool whose holder counts a generation changed — the pool detail cache evicts them (§3.8). */
  onChangedHolders(listener: (keys: string[]) => void): void {
    this.holdersListener = listener;
  }

  private ensure(): RankEngine {
    if (this.engine) return this.engine;
    const shared = (this.readModels as { acquireEngine?: (user: string) => EngineRunner }).acquireEngine;
    this.sharedEngine = typeof shared === 'function';
    this.engineRunner = this.sharedEngine
      ? shared!.call(this.readModels, 'rank')
      : createEngineRunner(this.config.readModelsWorkers, { onAlert: (name, detail) => this.readModels.alerts.alert(name, detail) });
    this.engine = new RankEngine({
      engine: this.engineRunner,
      source: () => (this.readModels as { rankSource?: () => ReturnType<ReadModelsService['rankSource']> }).rankSource?.call(this.readModels),
      alert: (name, detail) => this.readModels.alerts.alert(name, detail),
      log: (message) => this.logger.log(message),
      onHolders: (shard, poolIds) => {
        if (!this.holdersListener || this.mode() !== 'serve') return;
        this.holdersListener(poolIds.map((poolId) => `${shard.chainId}:${shard.protocol}:${poolId.toLowerCase()}`));
      },
    });
    return this.engine;
  }

  private async teardown(): Promise<void> {
    const runner = this.engineRunner;
    this.engine?.stop();
    this.engine = undefined;
    this.engineRunner = undefined;
    this.answers.clear();
    this.compiled.clear();
    this.refusedAt.clear();
    if (!runner) return;
    if (this.sharedEngine) await this.readModels.releaseEngine('rank');
    else await runner.stop();
  }

  /** One generation step (the timer; specs call it directly). */
  async tick(): Promise<void> {
    if (this.stopping) return;
    if (this.mode() === 'off') {
      if (this.engine) await this.teardown();
      return;
    }
    await this.ensure().tick();
  }

  // ── routing ──

  private fallback(reason: string): { kind: 'fallback'; reason: string } {
    this.meter.fallback[reason] = (this.meter.fallback[reason] ?? 0) + 1;
    return { kind: 'fallback', reason };
  }

  /**
   * Why `chainIds` cannot be answered by the engine right now (undefined = it
   * can): the model's readiness (§6.7), each spanned shard ready and built
   * into the current generation, data younger than `READ_MODELS_MAX_LAG_MS`.
   */
  notServable(chainIds: number[], protocol: string, now = Date.now()): string | undefined {
    const engine = this.engine;
    if (!engine) return 'not_running';
    const readiness = this.readModels.readiness()?.rank;
    if (!readiness) return 'not_running';
    const maxLag = this.config.readModelsMaxLagMs;
    if (!readiness.ready) {
      if (readiness.reason !== 'shard_not_ready' || !readiness.caughtUp || readiness.dataAt === null || now - readiness.dataAt >= maxLag) {
        return readiness.reason ?? 'not_ready';
      }
    }
    const generation = engine.current;
    if (!generation) return 'engine_not_built';
    if (generation.frozen) return 'position_frozen';
    if (!(generation.ca > 0) || now - generation.ca >= maxLag) return 'engine_lag';
    for (const chainId of chainIds) {
      const key = shardKey(chainId, protocol);
      if (!readiness.shards[key]?.ready) return 'shard_not_ready';
      if (!generation.shards.has(key)) return 'shard_not_built';
    }
    return undefined;
  }

  /** Should this request be answered by the engine? (`serve`, the ramp percent, servable.) */
  route(chainIds: number[], protocol: string): { serve: true } | { serve: false; reason: string } {
    if (this.mode() !== 'serve') return { serve: false, reason: 'mode' };
    if (!selectedForServe(this.config.readModelsServePercent)) return { serve: false, reason: 'percent' };
    const reason = this.notServable(chainIds, protocol);
    if (reason) {
      this.meter.fallback[reason] = (this.meter.fallback[reason] ?? 0) + 1;
      return { serve: false, reason };
    }
    return { serve: true };
  }

  /**
   * Design §3.8: in `serve` the warmup keeps only its reduced cycle (the
   * default sort's landing windows), and runs its full cycle whenever the
   * engine would not answer every request here — percent below 100, a kill
   * switch below the env's mode, not servable on every shard, a quarantined
   * leaf on a shard (its queries reading that leaf go to Mongo), or an answer
   * the engine refused on the shard in the last `REFUSAL_HOLD_MS` (a bind or
   * sort refusal sends that request to Mongo).
   */
  warmupReduced(chainIds: number[], protocol: string, now = Date.now()): boolean {
    if (this.readModels.configuredModes().rank !== 'serve' || this.mode() !== 'serve') return false;
    if (this.config.readModelsServePercent < 100) return false;
    if (this.notServable(chainIds, protocol, now) !== undefined) return false;
    for (const chainId of chainIds) {
      const key = shardKey(chainId, protocol);
      if (this.engine?.quarantineActive(key) !== false) return false;
      const refusedAt = this.refusedAt.get(key);
      if (refusedAt !== undefined && now - refusedAt < REFUSAL_HOLD_MS) return false;
    }
    return true;
  }

  /** An answer-time refusal on these shards: the warmup keeps its full cycle there for a while. */
  private noteRefusal(plans: LeaderboardPlan[]): void {
    const now = Date.now();
    for (const plan of plans) this.refusedAt.set(shardKey(plan.chainId, plan.protocol), now);
  }

  // ── answers ──

  private compile(plan: LeaderboardPlan, access: PositionsAccess): RankCompileResult {
    const cached = this.compiled.get(plan.countKey);
    if (cached) {
      this.compiled.delete(plan.countKey);
      this.compiled.set(plan.countKey, cached);
      return cached;
    }
    let result: RankCompileResult;
    try {
      result = compileRankFilter(access.cast(plan.chainId, plan.protocol, plan.shapeFilter), plan.chainId, plan.protocol, plan.shape);
    } catch (err) {
      result = { ok: false, reason: `cast:${(err as Error)?.name ?? 'error'}` };
    }
    this.compiled.set(plan.countKey, result);
    while (this.compiled.size > COMPILED_MAX) this.compiled.delete(this.compiled.keys().next().value!);
    return result;
  }

  private prepare(plans: LeaderboardPlan[], access: PositionsAccess): Prepared | { reason: string } {
    const first = plans[0];
    if (!first) return { reason: 'no_plan' };
    const sort = rankPermFor(first.sortField, first.sortDirection, first.tieDirection);
    if (!sort) return { reason: 'sort' };
    const inputs: RankAnswerShardInput[] = [];
    for (const plan of plans) {
      if (plan.sortField !== first.sortField || plan.sortDirection !== first.sortDirection || plan.tieDirection !== first.tieDirection) return { reason: 'sort' };
      if (plan.shape !== first.shape) return { reason: 'shape' };
      const compiled = this.compile(plan, access);
      if (!compiled.ok) return { reason: `unsupported:${compiled.reason}` };
      inputs.push({ key: shardKey(plan.chainId, plan.protocol), plan: compiled.plan, excluded: plan.excluded });
    }
    return {
      inputs,
      perm: sort.perm,
      reverse: sort.reverse,
      key: `rank|${sort.perm}|${sort.reverse ? 'r' : 'f'}|${plans.map((plan) => plan.key).join('||')}`,
      cacheable: plans.every((plan) => plan.cacheable),
      collated: first.collated,
      shape: first.shape,
    };
  }

  private async compute(prepared: Prepared): Promise<CachedRankAnswer> {
    const answer = await this.engine!.answer(prepared.inputs, { perm: prepared.perm, reverse: prepared.reverse }, { affinity: prepared.key });
    return { ...answer, key: prepared.key, pages: new Map() };
  }

  /**
   * One leaderboard page from the engine, or why not (the caller then takes
   * the Mongo path). Overload (the engine's queue) is a 503 + Retry-After —
   * the stale cached answer, when there is one, was already served by the cache.
   */
  async list(input: { plans: LeaderboardPlan[]; page: number; limit: number }, access: PositionsAccess): Promise<RankListOutcome> {
    if (!this.engine) return this.fallback('not_running');
    const prepared = this.prepare(input.plans, access);
    if ('reason' in prepared) return this.fallback(prepared.reason);
    const skip = (input.page - 1) * input.limit;
    for (let attempt = 0; attempt < 2; attempt++) {
      let got: { value: CachedRankAnswer; status: CacheStatus };
      try {
        got = await this.answers.get(prepared.key, () => this.compute(prepared), { store: prepared.cacheable });
      } catch (err) {
        if (err instanceof RankUnsupported) {
          this.noteRefusal(input.plans);
          return this.fallback(err.reason);
        }
        if (err instanceof EngineOverloadError) {
          this.meter.overload++;
          this.readModels.alerts.alert('read_models.worker_overload', `rank engine: ${err.reason} — 503 + Retry-After`);
          throw new QueryTimeoutException();
        }
        this.readModels.alerts.alert('read_models.engine_error', `rank engine answer failed: ${(err as Error)?.message ?? String(err)} — served by Mongo`);
        return this.fallback('engine_error');
      }
      let page: RankPage | 'stale';
      try {
        page = await this.page(got.value, skip, input.limit, access);
      } catch (err) {
        if (got.value.shards.length === 1) return this.fallback(`rows:${(err as Error)?.name ?? 'error'}`);
        throw err;
      }
      if (page === 'stale') {
        this.answers.delete(prepared.key);
        this.meter.recomputed++;
        continue;
      }
      this.meter.served++;
      if (page.missingChains.length > 0) this.meter.partial++;
      return { kind: 'ok', cache: got.status, dataAt: got.value.ca, answer: got.value, ...page };
    }
    return this.fallback('instance_changed');
  }

  /** Entries `[skip, skip + take)` of an answer's order over the shards in `live`. */
  private window(answer: RankAnswer, live: Set<number>, skip: number, take: number): Array<{ index: number; slot: number }> {
    const out: Array<{ index: number; slot: number }> = [];
    if (live.size === answer.shards.length) {
      const end = Math.min(answer.slots.length, skip + take);
      for (let i = skip; i < end; i++) out.push({ index: answer.shard ? answer.shard[i] : 0, slot: answer.slots[i] });
      return out;
    }
    let k = 0;
    for (let i = 0; i < answer.slots.length && k < skip + take; i++) {
      const index = answer.shard ? answer.shard[i] : 0;
      if (!live.has(index)) continue;
      if (k >= skip) out.push({ index, slot: answer.slots[i] });
      k++;
    }
    return out;
  }

  /**
   * The page's documents, read by positionId at the answer's clusterTime and
   * put in the engine's order (§6.7). All chains: a chain whose read fails
   * twice is dropped and the page re-cut over the others (`partial` +
   * `missingChains`, as the Mongo path does); a single chain throws.
   * 'stale': a shard was rebuilt since the answer (recompute).
   */
  private async page(answer: CachedRankAnswer, skip: number, limit: number, access: PositionsAccess): Promise<RankPage | 'stale'> {
    const pageKey = `${skip}:${limit}`;
    const cached = answer.pages.get(pageKey);
    if (cached) return cached;
    const live = new Set(answer.shards.map((_, i) => i));
    const missingChains: number[] = [];
    const errors: Array<{ chainId: number; error: unknown }> = [];
    const atClusterTime = parseClusterTime(answer.ct);
    for (;;) {
      const entries = this.window(answer, live, skip, limit + 1);
      const total = [...live].reduce((sum, i) => sum + answer.counts[i], 0);
      const byShard = new Map<number, string[]>();
      const ids: string[] = [];
      for (const { index, slot } of entries.slice(0, limit)) {
        const pid = this.engine?.pidOf(answer, index, slot);
        if (pid === undefined) return 'stale';
        ids.push(pid);
        const list = byShard.get(index) ?? [];
        list.push(pid);
        byShard.set(index, list);
      }
      const found = new Map<string, Position>();
      const failed: Array<{ index: number; error: unknown }> = [];
      await Promise.all(
        [...byShard].map(async ([index, positionIds]) => {
          const shard = answer.shards[index];
          const read = async () => {
            const meta: { snapshotFallback?: boolean } = {};
            const docs = await access.rows(shard.chainId, shard.protocol, positionIds, { atClusterTime, meta });
            if (meta.snapshotFallback) this.meter.snapshotFallback++;
            return docs;
          };
          try {
            let docs: Position[];
            try {
              docs = await read();
            } catch {
              docs = await read();
            }
            for (const doc of docs) found.set(`${index}:${String(doc.positionId)}`, doc);
          } catch (error) {
            failed.push({ index, error });
          }
        }),
      );
      if (failed.length > 0) {
        if (answer.shards.length === 1) throw failed[0].error;
        for (const { index, error } of failed) {
          live.delete(index);
          missingChains.push(answer.shards[index].chainId);
          errors.push({ chainId: answer.shards[index].chainId, error });
        }
        if (live.size === 0) throw errors[0]?.error ?? new Error('no chain left');
        continue;
      }
      const positions: Position[] = [];
      entries.slice(0, limit).forEach(({ index }, i) => {
        const doc = found.get(`${index}:${ids[i]}`);
        if (doc) positions.push(doc);
      });
      const page: RankPage = { positions, hasMore: total > skip + limit, total, missingChains, errors };
      if (missingChains.length === 0) {
        answer.pages.set(pageKey, page);
        this.answers.resize(answer.key);
      }
      return page;
    }
  }

  // ── counts ──

  /**
   * The count task of one shard's plan from the engine — the contract of
   * `countDocuments({limit: cap})` (the count capped at `cap`, `capped` when it
   * reached it) — under the plan's own `countKey`, so it shares the list-count
   * cache with the Mongo path; unmetered (no read budget, no count slot). Or
   * undefined when the engine would not answer it — a compile refusal, or
   * (asked of the current generation, the same checks `answer` runs) a
   * missing shard, a quarantined read leaf, a bind refusal — and the caller
   * builds today's Mongo tasks.
   *
   * `fallback` is the plan's Mongo count, METERED (`LeaderboardCountService.
   * metered`): a refusal that appears only when the task runs (a generation
   * swapped in between) is counted by Mongo instead, so an engine refusal is
   * never stored as the key's failure — the key the Mongo path shares.
   */
  countTask(plan: LeaderboardPlan, access: PositionsAccess, cap: number, fallback?: () => Promise<CountResult>): CountTask | undefined {
    const engine = this.engine;
    if (!engine) {
      this.meter.fallback.not_running = (this.meter.fallback.not_running ?? 0) + 1;
      return undefined;
    }
    const prepared = this.prepare([plan], access);
    if ('reason' in prepared) {
      this.meter.fallback[prepared.reason] = (this.meter.fallback[prepared.reason] ?? 0) + 1;
      return undefined;
    }
    const refusal = engine.refusal(prepared.inputs, prepared.perm, false);
    if (refusal) {
      this.noteRefusal([plan]);
      this.meter.fallback[refusal] = (this.meter.fallback[refusal] ?? 0) + 1;
      return undefined;
    }
    return {
      key: plan.countKey,
      run: unmeteredCount(async (): Promise<CountResult> => {
        const current = this.engine;
        let answer: RankAnswer;
        try {
          if (!current) throw new RankUnsupported('not_running');
          answer = await current.answer(prepared.inputs, { perm: prepared.perm, reverse: prepared.reverse }, { materialize: false, affinity: prepared.key });
        } catch (err) {
          if (err instanceof EngineOverloadError) throw new CountQueueFullError();
          if (!fallback) throw err;
          const reason = err instanceof RankUnsupported ? err.reason : 'engine_error';
          if (err instanceof RankUnsupported) this.noteRefusal([plan]);
          this.meter.fallback[`count:${reason}`] = (this.meter.fallback[`count:${reason}`] ?? 0) + 1;
          if (!(err instanceof RankUnsupported)) {
            this.readModels.alerts.alert('read_models.engine_error', `rank engine count failed: ${(err as Error)?.message ?? String(err)} — counted by Mongo`);
          }
          return fallback();
        }
        this.meter.counted++;
        const n = answer.counts[0] ?? 0;
        return { count: Math.min(n, cap), capped: n >= cap, dataAt: answer.ca } as CountResult;
      }),
    };
  }

  /**
   * Count tasks for every plan, or undefined when any would not be answered
   * by the engine (all go to Mongo then). `fallback(plan)` is that plan's
   * metered Mongo count (see `countTask`).
   */
  countTasks(
    plans: LeaderboardPlan[],
    access: PositionsAccess,
    cap: number,
    fallback?: (plan: LeaderboardPlan) => () => Promise<CountResult>,
  ): CountTask[] | undefined {
    const tasks: CountTask[] = [];
    for (const plan of plans) {
      const task = this.countTask(plan, access, cap, fallback?.(plan));
      if (!task) return undefined;
      tasks.push(task);
    }
    return tasks;
  }

  // ── holder counts (design §6.6, §8.3) ──

  /**
   * The engine's open-position / holder counts for a page of pools on one
   * shard (serve only): `counts` keyed by lowercased poolId (absent = 0/0, as
   * `countsByPoolIds`), `fallback` = the pools the engine cannot count exactly
   * (an active row with a null / missing owner), for Mongo. Undefined when the
   * shard cannot answer at all (not serve, not ready, quarantined).
   */
  holderCounts(
    chainId: number,
    protocol: string,
    poolIds: readonly string[],
  ): { counts: Map<string, PoolPositionCounts>; fallback: string[]; dataAt: number; storedAt: number } | undefined {
    const engine = this.engine;
    if (!engine || this.mode() !== 'serve' || !selectedForServe(this.config.readModelsServePercent)) return undefined;
    if (this.notServable([chainId], protocol)) return undefined;
    const got = engine.holderCounts(chainId, protocol, poolIds);
    if (!got) return undefined;
    this.meter.holderCounts++;
    this.meter.holderAmbiguous += got.ambiguous.length;
    return { counts: got.counts, fallback: got.ambiguous, dataAt: got.ca, storedAt: got.publishedAt };
  }

  // ── lane A ──

  /**
   * Offer a list / count request for a lane-A check (shadow AND serve).
   * Sampled, run in the background — after the response, never altering it.
   */
  offer(args: { plans: () => Promise<LeaderboardPlan[]>; page: number; limit: number; kind: 'list' | 'count'; served?: CachedRankAnswer }, access: PositionsAccess): void {
    if (this.mode() === 'off' || !this.engine) return;
    if (!(Math.random() < this.config.readModelsShadowSample)) return;
    void (async () => this.check({ ...args, plans: await args.plans() }, access))().catch((err) => {
      this.lane.skip('error');
      this.logger.warn(`lane A check failed: ${(err as Error)?.message ?? String(err)}`);
    });
  }

  private async check(args: { plans: LeaderboardPlan[]; page: number; limit: number; kind: 'list' | 'count'; served?: CachedRankAnswer }, access: PositionsAccess): Promise<void> {
    const engine = this.engine;
    const first = args.plans[0];
    if (!engine || !first) return;
    const single = args.plans.length === 1;
    const skip = args.kind === 'count' ? 0 : (args.page - 1) * args.limit;
    const limit = args.kind === 'count' ? 0 : args.limit;
    const unservable = this.notServable(args.plans.map((p) => p.chainId), first.protocol);
    if (unservable) return this.lane.skip(unservable === 'position_frozen' ? 'position_frozen' : 'not_ready');
    const prepared = this.prepare(args.plans, access);
    if ('reason' in prepared) return this.lane.skip('unsupported');
    // Everything that can skip a check is decided BEFORE any engine work (a
    // sampled check that a gate then discards must cost nothing): the bucket,
    // its once-a-minute gate, the generation's age, the shadow ticket.
    const now = Date.now();
    const bucketOf = (kind: 'shallow' | 'deep' | 'pastEnd' | 'count') => rankBucket({ shape: first.shape, sortField: first.sortField, single, kind });
    const windowKind: 'shallow' | 'deep' = listWindowRows(args.page, args.limit) === null ? 'deep' : 'shallow';
    const candidates = args.kind === 'count' ? [bucketOf('count')] : skip > 0 ? [bucketOf('pastEnd'), bucketOf(windowKind)] : [bucketOf(windowKind)];
    if (candidates.every((bucket) => this.lane.recent(bucket, now))) return this.lane.skip('bucket_recent');
    const generation = engine.current;
    if (!generation || now - parseClusterTime(generation.ct).t * 1000 > LANE_A_MAX_AGE_MS) return this.lane.skip('window');
    // The total decides 'pastEnd': from the served / cached answer when there
    // is one, else a count-only pass (no materialised order).
    let total: number | undefined;
    if (args.served && engine.isCurrent(args.served)) total = args.served.counts.reduce((sum, n) => sum + n, 0);
    else {
      const cached = this.answers.peek(prepared.key)?.value;
      if (cached && engine.isCurrent(cached)) total = cached.counts.reduce((sum, n) => sum + n, 0);
    }
    if (total === undefined && candidates.length > 1) {
      try {
        const counted = await engine.answer(prepared.inputs, { perm: prepared.perm, reverse: prepared.reverse }, { materialize: false, affinity: prepared.key });
        total = counted.counts.reduce((sum, n) => sum + n, 0);
      } catch {
        return this.lane.skip('engine');
      }
    }
    const bucket = args.kind === 'count' ? bucketOf('count') : skip > 0 && total !== undefined && skip >= total ? bucketOf('pastEnd') : bucketOf(windowKind);
    if (this.lane.recent(bucket, now)) return this.lane.skip('bucket_recent');
    if (!(await this.readModels.shadowTicket(this.config.readModelsShadowMaxPerMin))) return this.lane.skip('sample_cap');
    // The engine's side: the served answer, else the answer cache (shared with
    // the requests, single-flight) — a count check needs no materialised order.
    let answer: RankAnswer;
    try {
      if (args.served && engine.isCurrent(args.served)) answer = args.served;
      else if (args.kind === 'count') {
        answer = await engine.answer(prepared.inputs, { perm: prepared.perm, reverse: prepared.reverse }, { materialize: false, affinity: prepared.key });
      } else {
        answer = (await this.answers.get(prepared.key, () => this.compute(prepared), { store: prepared.cacheable })).value;
      }
    } catch {
      return this.lane.skip('engine');
    }
    const atClusterTime = parseClusterTime(answer.ct);
    if (now - atClusterTime.t * 1000 > LANE_A_MAX_AGE_MS) return this.lane.skip('window');
    const cap = this.config.leaderboardCountCap;
    const estimate = estimateRankReferenceDocs(
      answer.shards.map((_, i) => ({ offered: answer.scope[i] ?? 0, matches: answer.counts[i] ?? 0 })),
      { skip, limit, cap, collated: first.collated },
    );
    if (estimate > LANE_A_MAX_DOCS) return this.lane.skip('heavy', bucket, now);
    // Lane A yields to users: never while the user read budget is under
    // pressure, and its reads come from its own ≤ 2k docs/s bucket — never
    // from the user one (a check must not delay a user's count or deep walk).
    if (this.budget?.underPressure()) return this.lane.skip('budget');
    if (!this.laneBudget.take(estimate)) return this.lane.skip('budget');
    let shards: RankReferenceShard[];
    try {
      shards = await Promise.all(
        args.plans.map(async (plan) => {
          const reference = await access.reference(plan.chainId, plan.protocol, {
            filter: access.cast(plan.chainId, plan.protocol, plan.filter),
            collated: plan.collated,
            sortField: plan.sortField,
            sortDirection: plan.sortDirection,
            tieDirection: plan.tieDirection,
            skip: single ? skip : 0,
            limit: single ? limit + 1 : skip + limit + 1,
            cap,
            atClusterTime,
            maxTimeMS: 10_000,
          });
          return { chainId: plan.chainId, rows: reference.rows, count: reference.count };
        }),
      );
    } catch (err) {
      return this.lane.skip(err instanceof SnapshotUnavailableError ? 'snapshot_too_old' : 'mongo');
    }
    const mongo = mongoRankLaneAnswer(shards, { skip, limit, cap, sortDirection: first.sortDirection, tieDirection: first.tieDirection, single, collated: first.collated });
    const engineSide = this.laneAnswer(answer, skip, limit, cap, first.collated);
    if (!engineSide) return this.lane.skip('instance_changed');
    const diff = diffRankLaneAnswers(engineSide, mongo);
    const detail = { model: 'rank', shape: first.shape, shards: answer.shards.map((s) => s.chainId), sort: `${first.sortField}:${first.sortDirection}`, skip, limit, seq: answer.seq, ct: answer.ct, filterKey: prepared.key.slice(0, 200) };
    this.lane.record(bucket, diff, detail, now);
    if (diff) this.readModels.alerts.evidence('read_models.shadow_diff', JSON.stringify({ lane: 'A', bucket, ...detail, ...diff }));
  }

  /** The engine's side of a lane-A comparison. */
  private laneAnswer(answer: RankAnswer, skip: number, limit: number, cap: number, collated: boolean): RankLaneAnswer | undefined {
    const engine = this.engine;
    if (!engine) return undefined;
    const entries: RankLaneAnswer['entries'] = [];
    const end = Math.min(answer.slots.length, skip + limit);
    for (let i = skip; i < end; i++) {
      const index = answer.shard ? answer.shard[i] : 0;
      const positionId = engine.pidOf(answer, index, answer.slots[i]);
      if (positionId === undefined) return undefined;
      entries.push({ chainId: answer.shards[index].chainId, positionId });
    }
    const total = answer.counts.reduce((sum, n) => sum + n, 0);
    return {
      entries,
      hasMore: total > skip + limit,
      counts: answer.shards.map((s, i) => ({ chainId: s.chainId, count: collated ? Math.min(answer.counts[i], cap) : answer.counts[i], capped: collated && answer.counts[i] >= cap })),
    };
  }

  /**
   * Offer a page of pools for a holder-count lane-A check (shadow AND serve):
   * the engine's counts at its generation vs the `$group` at the same
   * clusterTime. Sampled; after the response, never altering it.
   */
  offerHolderCounts(chainId: number, protocol: string, poolIds: readonly string[], kind: 'list' | 'detail', access: PositionsAccess): void {
    const engine = this.engine;
    if (this.mode() === 'off' || !engine || poolIds.length === 0 || !access.poolCounts) return;
    if (!(Math.random() < this.config.readModelsShadowSample)) return;
    void (async () => {
      const bucket = `holders|${kind}`;
      const now = Date.now();
      if (this.holderLane.recent(bucket, now)) return this.holderLane.skip('bucket_recent');
      if (this.notServable([chainId], protocol)) return this.holderLane.skip('not_ready');
      const generation = engine.current;
      const got = engine.holderCounts(chainId, protocol, poolIds);
      if (!generation || !got) return this.holderLane.skip('unsupported');
      const atClusterTime = parseClusterTime(generation.ct);
      if (now - atClusterTime.t * 1000 > LANE_A_MAX_AGE_MS) return this.holderLane.skip('window');
      // The `$group` reads the pools' open positions (index keys only): budgeted like lane A.
      let estimate = poolIds.length;
      for (const c of got.counts.values()) estimate += c.positionsCount;
      if (this.budget?.underPressure()) return this.holderLane.skip('budget');
      if (!this.laneBudget.take(Math.min(estimate, LANE_A_MAX_DOCS))) return this.holderLane.skip('budget');
      if (!(await this.readModels.shadowTicket(this.config.readModelsShadowMaxPerMin))) return this.holderLane.skip('sample_cap');
      let mongo: Map<string, PoolPositionCounts>;
      try {
        mongo = await access.poolCounts!(chainId, protocol, poolIds, { atClusterTime, maxTimeMS: 10_000 });
      } catch (err) {
        return this.holderLane.skip(err instanceof SnapshotUnavailableError ? 'snapshot_too_old' : 'mongo');
      }
      const ambiguous = new Set(got.ambiguous);
      let diff: { kind: 'count'; engine: unknown; mongo: unknown } | undefined;
      for (const raw of poolIds) {
        const id = raw.toLowerCase();
        if (ambiguous.has(id)) continue;
        const e = got.counts.get(id) ?? { positionsCount: 0, holdersCount: 0 };
        const m = mongo.get(id) ?? { positionsCount: 0, holdersCount: 0 };
        if (e.positionsCount !== m.positionsCount || e.holdersCount !== m.holdersCount) {
          diff = { kind: 'count', engine: { poolId: id, ...e }, mongo: { poolId: id, ...m } };
          break;
        }
      }
      const detail = { model: 'rank-holders', chainId, pools: poolIds.length, seq: generation.seq, ct: generation.ct };
      this.holderLane.record(bucket, diff, detail, now);
      if (diff) this.readModels.alerts.evidence('read_models.shadow_diff', JSON.stringify({ lane: 'A', bucket, ...detail, ...diff }));
    })().catch((err) => {
      this.holderLane.skip('error');
      this.logger.warn(`holder-count lane A check failed: ${(err as Error)?.message ?? String(err)}`);
    });
  }

  // ── status ──

  status(): Record<string, unknown> {
    return {
      mode: this.mode(),
      engine: this.engine?.status() ?? null,
      runner: this.engineRunner?.stats() ?? null,
      answers: this.answers.stats(),
      compiled: this.compiled.size,
      perms: RANK_PERMS.map((p) => p.name),
      requests: { ...this.meter, fallback: { ...this.meter.fallback } },
      shadow: this.lane.snapshot(),
      holderShadow: this.holderLane.snapshot(),
    };
  }
}
