import { Inject, Injectable, Logger, Optional, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { listCacheTtl, listWindowRows, type CacheStatus } from '../../common/cache/swr-cache.js';
import { ReadBudgetService } from '../../common/read-budget.js';
import { AppConfigService } from '../../config/app-config.service.js';
import type { PoolsPlan, PoolsSnapshotReference } from '../../database/pools.repository.js';
import { SnapshotUnavailableError } from '../../database/pools.repository.js';
import type { Pool } from '../../database/schemas/pool.schema.js';
import { QueryTimeoutException } from '../../database/user-read.js';
import { CountQueueFullError, unmeteredCount, type CountResult, type CountTask } from '../../leaderboard/count-cache.js';
import { createEngineRunner, EngineOverloadError, type EngineRunner } from '../core/engine-runner.js';
import { shardKey } from '../core/fields.js';
import { ResultCache } from '../core/result-cache.js';
import { resolveRole, selectedForServe, type ReadModelMode } from '../flags.js';
import { ReadModelsService } from '../read-models.service.js';
import {
  diffLaneAnswers,
  estimateReferenceDocs,
  LANE_A_MAX_AGE_MS,
  LANE_A_MAX_DOCS,
  LaneABudget,
  LaneAMeter,
  mongoLaneAnswer,
  poolsBucket,
  type LaneAnswer,
  type ReferenceShard,
} from '../shadow/pools-lane-a.js';
import { CatalogUnsupported, PoolCatalog, type AnswerShardInput, type CatalogAnswer } from './pool-catalog.js';
import { POOL_LEAF, permFor } from './pool-columns.js';
import { compilePoolFilter, type PoolCompileResult } from './pool-query.js';

/**
 * The pool catalog's Nest face (Phase P-R R2): the generation timer, the
 * per-request route (`serve` → the catalog answers; anything not servable →
 * today's Mongo path, metered by reason), the answer cache, the engine
 * counts, and lane A (shadow AND serve).
 *
 * `off` (the default): nothing starts — no timer, no worker, no memory.
 * `shadow`: the catalog is built and maintained and lane A checks sampled
 * requests against Mongo at the answer's clusterTime; every response is
 * still Mongo's, byte for byte. `serve`: the catalog answers what it can.
 *
 * It reaches Mongo only through `PoolsAccess` (the pools service's
 * repository): the cast of a plan, rows by poolId at a clusterTime, and the
 * lane-A reference reads.
 */

/** What the catalog needs of the pools repository. */
export interface PoolsAccess {
  /** A filter as MongoDB receives it (`PoolsRepository.castFilter`). */
  cast(chainId: number, protocol: string, filter: Record<string, unknown>): Record<string, unknown>;
  rows(chainId: number, protocol: string, poolIds: readonly string[], options: { atClusterTime?: { t: number; i: number }; meta?: { snapshotFallback?: boolean } }): Promise<Pool[]>;
  reference(
    chainId: number,
    protocol: string,
    args: { filter: Record<string, unknown>; sortField: string; sortDirection: 1 | -1; skip: number; limit: number; cap: number; atClusterTime: { t: number; i: number }; maxTimeMS: number },
  ): Promise<PoolsSnapshotReference>;
}

/** A cached answer: the engine's order + counts at one generation, and the page rows read at its clusterTime. */
export interface CachedPoolsAnswer extends CatalogAnswer {
  key: string;
  pages: Map<string, PoolsPage>;
  /**
   * Each shard input's exclusion list, as bound: the cache key carries the
   * placeholder, not the list, so a cached answer can outlive a rebuild of the
   * set (accepted, as the Mongo window cache does) — and lane A must then not
   * compare it with a reference built from the NEW list.
   */
  excluded: ReadonlyArray<readonly string[]>;
}

/** The same exclusion lists (the same array, or the same addresses in the same order) per shard. */
export function sameExclusions(bound: ReadonlyArray<readonly string[]>, inputs: readonly AnswerShardInput[]): boolean {
  if (bound.length !== inputs.length) return false;
  return inputs.every((input, i) => {
    const a = bound[i];
    const b = input.excluded;
    if (a === b) return true;
    if (!a || a.length !== b.length) return false;
    for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return false;
    return true;
  });
}

/**
 * A count the catalog accepted but could not run (a shard rebuilt or
 * quarantined between the check and the run): transient — the count cache
 * must not remember it under the key Mongo shares (`CountQueueFullError`
 * semantics), and the next count of the key goes to Mongo
 * (`ENGINE_COUNT_REFUSED_MS`).
 */
const ENGINE_COUNT_REFUSED_MS = 90_000;

export interface PoolsPage {
  pools: Pool[];
  hasMore: boolean;
  /** Exact matches over the chains on the page (uncapped). */
  total: number;
  missingChains: number[];
  errors: Array<{ chainId: number; error: unknown }>;
}

export type PoolsListOutcome =
  | ({ kind: 'ok'; cache: CacheStatus; dataAt: number; answer: CachedPoolsAnswer } & PoolsPage)
  | { kind: 'fallback'; reason: string };

interface Prepared {
  inputs: AnswerShardInput[];
  perm: number;
  key: string;
  cacheable: boolean;
}

/** `t:i` → `{t, i}`. */
export function parseClusterTime(ct: string): { t: number; i: number } {
  const at = ct.indexOf(':');
  return { t: Number(ct.slice(0, at)), i: Number(ct.slice(at + 1)) };
}

const ROW_BYTES_ESTIMATE = 1_500;
const COMPILED_MAX = 2_000;

@Injectable()
export class PoolCatalogService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('PoolCatalog');
  private engine?: EngineRunner;
  catalog?: PoolCatalog;
  private timer?: ReturnType<typeof setInterval>;
  private readonly compiled = new Map<string, PoolCompileResult>();
  private readonly answers: ResultCache<CachedPoolsAnswer>;
  readonly lane = new LaneAMeter();
  private readonly meter = {
    served: 0,
    counted: 0,
    overload: 0,
    partial: 0,
    recomputed: 0,
    snapshotFallback: 0,
    fallback: {} as Record<string, number>,
  };
  private changedListener?: (keys: string[]) => void;
  private stopping = false;
  /** Lane A's own read budget (never the user one). */
  private readonly laneBudget = new LaneABudget();
  /** countKeys whose engine count failed recently: counted by Mongo until then. */
  private readonly countRefused = new Map<string, number>();

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(ReadModelsService) private readonly readModels: ReadModelsService,
    @Optional() @Inject(ReadBudgetService) private readonly budget?: ReadBudgetService,
  ) {
    const ttl = listCacheTtl(config);
    this.answers = new ResultCache<CachedPoolsAnswer>(
      { ...ttl, maxBytes: 32 * 1024 * 1024, jitter: 0.1, onBackgroundError: (key, err) => this.logger.warn(`answer refresh failed ${key.slice(0, 80)}: ${(err as Error)?.message ?? err}`) },
      (answer) => answer.slots.byteLength + (answer.shard?.byteLength ?? 0) + [...answer.pages.values()].reduce((sum, page) => sum + page.pools.length * ROW_BYTES_ESTIMATE, 0) + 512,
      (answer) => this.catalog?.isCurrent(answer) ?? false,
    );
  }

  onApplicationBootstrap(): void {
    if (this.readModels.configuredModes().pools === 'off') return;
    // A process that never serves (P2's feeder role, or none) builds no catalog.
    const role = resolveRole(this.config.readModelsRole, this.config.processRole);
    if (role !== 'both' && role !== 'server') return;
    this.readModels.registerStatus('pools', () => this.status());
    // The memory guard's cache stages (§4.11): 80% drops the answer cache, 85%
    // also the compiled plans (the passes' bitsets are bounded per worker).
    (this.readModels as { registerShedder?: (name: string, shed: (stage: 80 | 85) => void) => void }).registerShedder?.('pools', (stage) => {
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

  /** The pools model's effective mode in this process. */
  mode(): ReadModelMode {
    return this.readModels.effectiveMode('pools');
  }

  /** Called (serve only) with `chainId:protocol:poolId` of every pool a generation changed — the detail cache evicts them (§3.8). */
  onChangedPools(listener: (keys: string[]) => void): void {
    this.changedListener = listener;
  }

  /** The runner came from `ReadModelsService` (shared with the rank engine) rather than being our own. */
  private sharedEngine = false;

  private ensure(): PoolCatalog {
    if (this.catalog) return this.catalog;
    // ONE runner per process, shared with the rank engine (R3); spec doubles of
    // the read-models service have none, and the catalog then owns its own.
    const shared = (this.readModels as { acquireEngine?: (user: string) => EngineRunner }).acquireEngine;
    this.sharedEngine = typeof shared === 'function';
    this.engine = this.sharedEngine
      ? shared!.call(this.readModels, 'pools')
      : createEngineRunner(this.config.readModelsWorkers, {
          onAlert: (name, detail) => this.readModels.alerts.alert(name, detail),
        });
    this.catalog = new PoolCatalog({
      engine: this.engine,
      source: () => this.readModels.catalogSource(),
      alert: (name, detail) => this.readModels.alerts.alert(name, detail),
      log: (message) => this.logger.log(message),
      onChanged: (shard, poolIds) => {
        if (!this.changedListener || this.mode() !== 'serve') return;
        this.changedListener(poolIds.map((poolId) => `${shard.chainId}:${shard.protocol}:${poolId.toLowerCase()}`));
      },
    });
    return this.catalog;
  }

  private async teardown(): Promise<void> {
    const engine = this.engine;
    this.catalog?.stop();
    this.catalog = undefined;
    this.engine = undefined;
    this.answers.clear();
    this.compiled.clear();
    if (!engine) return;
    if (this.sharedEngine) await this.readModels.releaseEngine('pools');
    else await engine.stop();
  }

  /** One generation step (the timer; specs call it directly). */
  async tick(): Promise<void> {
    if (this.stopping) return;
    if (this.mode() === 'off') {
      if (this.catalog) await this.teardown();
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
   * Why `chainIds` cannot be answered by the catalog right now (undefined =
   * it can): the model's readiness (§6.7 — caught up, data not older than
   * `READ_MODELS_MAX_LAG_MS`), each spanned shard ready, and built into the
   * catalog's current generation.
   */
  notServable(chainIds: number[], protocol: string, now = Date.now()): string | undefined {
    const catalog = this.catalog;
    if (!catalog) return 'not_running';
    const readiness = this.readModels.readiness()?.pools;
    if (!readiness) return 'not_running';
    const maxLag = this.config.readModelsMaxLagMs;
    if (!readiness.ready) {
      if (readiness.reason !== 'shard_not_ready' || !readiness.caughtUp || readiness.dataAt === null || now - readiness.dataAt >= maxLag) {
        return readiness.reason ?? 'not_ready';
      }
    }
    const generation = catalog.current;
    if (!generation) return 'catalog_not_built';
    if (generation.frozen) return 'position_frozen';
    if (!(generation.ca > 0) || now - generation.ca >= maxLag) return 'catalog_lag';
    for (const chainId of chainIds) {
      const key = shardKey(chainId, protocol);
      if (!readiness.shards[key]?.ready) return 'shard_not_ready';
      if (!generation.shards.has(key)) return 'shard_not_built';
    }
    return undefined;
  }

  /** Should this request be answered by the catalog? (`serve`, the ramp percent, servable.) */
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

  // ── answers ──

  private compile(plan: PoolsPlan, access: PoolsAccess): PoolCompileResult {
    const cached = this.compiled.get(plan.countKey);
    if (cached) {
      this.compiled.delete(plan.countKey);
      this.compiled.set(plan.countKey, cached);
      return cached;
    }
    let result: PoolCompileResult;
    try {
      result = compilePoolFilter(access.cast(plan.chainId, plan.protocol, plan.shapeFilter), plan.chainId, plan.protocol);
    } catch (err) {
      result = { ok: false, reason: `cast:${(err as Error)?.name ?? 'error'}` };
    }
    this.compiled.set(plan.countKey, result);
    while (this.compiled.size > COMPILED_MAX) this.compiled.delete(this.compiled.keys().next().value!);
    return result;
  }

  private prepare(plans: PoolsPlan[], access: PoolsAccess): Prepared | { reason: string } {
    const first = plans[0];
    if (!first) return { reason: 'no_plan' };
    const perm = permFor(first.sortField, first.sortDirection);
    if (perm < 0) return { reason: 'sort' };
    const inputs: AnswerShardInput[] = [];
    for (const plan of plans) {
      if (plan.sortField !== first.sortField || plan.sortDirection !== first.sortDirection) return { reason: 'sort' };
      const compiled = this.compile(plan, access);
      if (!compiled.ok) return { reason: `unsupported:${compiled.reason}` };
      inputs.push({ key: shardKey(plan.chainId, plan.protocol), plan: compiled.plan, excluded: plan.excluded });
    }
    return {
      inputs,
      perm,
      key: `pools|${perm}|${plans.map((plan) => plan.countKey).join('||')}`,
      cacheable: plans.every((plan) => plan.cacheable),
    };
  }

  private async compute(prepared: Prepared): Promise<CachedPoolsAnswer> {
    const answer = await this.catalog!.answer(prepared.inputs, prepared.perm, { atomCounts: true, affinity: prepared.key });
    return { ...answer, key: prepared.key, pages: new Map(), excluded: prepared.inputs.map((input) => input.excluded) };
  }

  /**
   * One pools page from the catalog, or why not (the caller then takes the
   * Mongo path). Overload (the engine's queue) is a 503 + Retry-After — the
   * stale cached answer, when there is one, was already served by the cache.
   */
  async list(input: { plans: PoolsPlan[]; page: number; limit: number }, access: PoolsAccess): Promise<PoolsListOutcome> {
    const catalog = this.catalog;
    if (!catalog) return this.fallback('not_running');
    const prepared = this.prepare(input.plans, access);
    if ('reason' in prepared) return this.fallback(prepared.reason);
    const skip = (input.page - 1) * input.limit;
    for (let attempt = 0; attempt < 2; attempt++) {
      let got: { value: CachedPoolsAnswer; status: CacheStatus };
      try {
        got = await this.answers.get(prepared.key, () => this.compute(prepared), { store: prepared.cacheable });
      } catch (err) {
        if (err instanceof CatalogUnsupported) return this.fallback(err.reason);
        if (err instanceof EngineOverloadError) {
          this.meter.overload++;
          this.readModels.alerts.alert('read_models.worker_overload', `pool catalog: ${err.reason} — 503 + Retry-After`);
          throw new QueryTimeoutException();
        }
        // An engine failure is never the user's 500: today's path answers.
        this.readModels.alerts.alert('read_models.engine_error', `pool catalog answer failed: ${(err as Error)?.message ?? String(err)} — served by Mongo`);
        return this.fallback('engine_error');
      }
      let page: PoolsPage | 'stale' | 'inconsistent';
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
      if (page === 'inconsistent') {
        // A pool the order holds has no document at the answer's clusterTime:
        // the order and the rows are not of one moment. Never a short page.
        this.answers.delete(prepared.key);
        this.readModels.alerts.alert('read_models.catalog_rows_missing', `pool catalog: a page row is missing at ct ${got.value.ct} — served by Mongo`);
        return this.fallback('rows_missing');
      }
      this.meter.served++;
      if (page.missingChains.length > 0) this.meter.partial++;
      return { kind: 'ok', cache: got.status, dataAt: got.value.ca, answer: got.value, ...page };
    }
    return this.fallback('instance_changed');
  }

  /** Entries `[skip, skip + take)` of an answer's order over the shards in `live`. */
  private window(answer: CatalogAnswer, live: Set<number>, skip: number, take: number): Array<{ index: number; slot: number }> {
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
   * The page's documents, read by poolId at the answer's clusterTime and put
   * in the engine's order (§5.4). All chains: a chain whose read fails twice
   * is dropped and the page re-cut over the others (`partial` +
   * `missingChains`, as the Mongo path does); a single chain throws. 'stale':
   * a shard was rebuilt since the answer (recompute). 'inconsistent': an
   * ordered pool has no document at the clusterTime (the caller goes to Mongo).
   */
  private async page(answer: CachedPoolsAnswer, skip: number, limit: number, access: PoolsAccess): Promise<PoolsPage | 'stale' | 'inconsistent'> {
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
        const poolId = this.catalog?.poolIdOf(answer, index, slot);
        if (poolId === undefined) return 'stale';
        ids.push(poolId);
        const list = byShard.get(index) ?? [];
        list.push(poolId);
        byShard.set(index, list);
      }
      const found = new Map<string, Pool>();
      const failed: Array<{ index: number; error: unknown }> = [];
      await Promise.all(
        [...byShard].map(async ([index, poolIds]) => {
          const shard = answer.shards[index];
          const read = async () => {
            const meta: { snapshotFallback?: boolean } = {};
            const docs = await access.rows(shard.chainId, shard.protocol, poolIds, { atClusterTime, meta });
            if (meta.snapshotFallback) this.meter.snapshotFallback++;
            return docs;
          };
          try {
            let docs: Pool[];
            try {
              docs = await read();
            } catch {
              docs = await read();
            }
            for (const doc of docs) found.set(`${index}:${doc.poolId}`, doc);
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
      const pools: Pool[] = [];
      const ordered = entries.slice(0, limit);
      for (let i = 0; i < ordered.length; i++) {
        const doc = found.get(`${ordered[i].index}:${ids[i]}`);
        if (!doc) return 'inconsistent';
        pools.push(doc);
      }
      const page: PoolsPage = { pools, hasMore: total > skip + limit, total, missingChains, errors };
      if (missingChains.length === 0) {
        answer.pages.set(pageKey, page);
        this.answers.resize(answer.key);
      }
      return page;
    }
  }

  // ── counts ──

  /**
   * The count task of one shard's plan from the catalog — the same contract
   * as `countDocuments({limit: cap})`: the count capped at `cap`, `capped`
   * when it reached it — under the plan's own `countKey`, so it shares the
   * list-count cache with the Mongo path (a page's total never depends on
   * which path counted it); unmetered (no read budget, no count slot). Or
   * undefined when the plan is not servable.
   */
  countTask(plan: PoolsPlan, access: PoolsAccess, cap: number, now = Date.now()): CountTask | undefined {
    const prepared = this.prepare([plan], access);
    const reason = 'reason' in prepared ? prepared.reason : this.countRefusal(plan.countKey, prepared, now);
    if (reason) {
      this.meter.fallback[reason] = (this.meter.fallback[reason] ?? 0) + 1;
      return undefined;
    }
    const ready = prepared as Prepared;
    return {
      key: plan.countKey,
      run: unmeteredCount(async (): Promise<CountResult> => {
        const catalog = this.catalog;
        let answer: CatalogAnswer;
        try {
          if (!catalog) throw new CatalogUnsupported('not_running');
          answer = await catalog.answer(ready.inputs, ready.perm, { materialize: false, affinity: ready.key });
        } catch (err) {
          // Overloaded: `pending` now, asked again by the next view (not remembered as a failure).
          if (err instanceof EngineOverloadError) throw new CountQueueFullError();
          // Any other engine failure says nothing about the count itself: it is
          // never remembered under the key Mongo shares (that would answer
          // `pending` on BOTH paths for 90 s) — `pending` now, and the key is
          // counted by Mongo for a while.
          this.countRefused.set(plan.countKey, Date.now() + ENGINE_COUNT_REFUSED_MS);
          if (this.countRefused.size > COMPILED_MAX) this.countRefused.delete(this.countRefused.keys().next().value!);
          const why = err instanceof CatalogUnsupported ? err.reason : 'engine_error';
          this.meter.fallback[`count:${why}`] = (this.meter.fallback[`count:${why}`] ?? 0) + 1;
          if (!(err instanceof CatalogUnsupported)) {
            this.readModels.alerts.alert('read_models.engine_error', `pool catalog count failed: ${(err as Error)?.message ?? String(err)} — counted by Mongo`);
          }
          throw new CountQueueFullError();
        }
        this.meter.counted++;
        const n = answer.counts[0] ?? 0;
        return { count: Math.min(n, cap), capped: n >= cap, dataAt: answer.ca } as CountResult;
      }),
    };
  }

  /**
   * Why a count of `prepared` must go to Mongo now (undefined = the catalog
   * counts it): the catalog's own refusals on its current generation (a
   * quarantined leaf, a shard not built — checked BEFORE the count is
   * committed, since a failed count is remembered under the key Mongo
   * shares), or a recent engine failure for this key.
   */
  private countRefusal(countKey: string, prepared: Prepared, now: number): string | undefined {
    const catalog = this.catalog;
    if (!catalog) return 'not_running';
    const until = this.countRefused.get(countKey);
    if (until !== undefined) {
      if (until > now) return 'count_refused';
      this.countRefused.delete(countKey);
    }
    return catalog.unservable(prepared.inputs, prepared.perm);
  }

  /** Count tasks for every plan, or undefined when any is not servable (all go to Mongo then). */
  countTasks(plans: PoolsPlan[], access: PoolsAccess, cap: number): CountTask[] | undefined {
    const tasks: CountTask[] = [];
    for (const plan of plans) {
      const task = this.countTask(plan, access, cap);
      if (!task) return undefined;
      tasks.push(task);
    }
    return tasks;
  }

  // ── lane A ──

  /**
   * Offer a request for a lane-A check (shadow AND serve). Sampled, then run
   * in the background — after the response, never altering it.
   */
  offer(
    args: { plans: () => Promise<PoolsPlan[]>; page: number; limit: number; sort: string; search?: string; minTvlUsd: number; kind: 'list' | 'count'; served?: CachedPoolsAnswer },
    access: PoolsAccess,
  ): void {
    const mode = this.mode();
    if (mode === 'off' || !this.catalog) return;
    if (!(Math.random() < this.config.readModelsShadowSample)) return;
    void (async () => this.check({ ...args, plans: await args.plans() }, access))().catch((err) => {
      this.lane.skip('error');
      this.logger.warn(`lane A check failed: ${(err as Error)?.message ?? String(err)}`);
    });
  }

  private async check(
    args: { plans: PoolsPlan[]; page: number; limit: number; sort: string; search?: string; minTvlUsd: number; kind: 'list' | 'count'; served?: CachedPoolsAnswer },
    access: PoolsAccess,
  ): Promise<void> {
    const catalog = this.catalog;
    if (!catalog) return;
    const single = args.plans.length === 1;
    const skip = args.kind === 'count' ? 0 : (args.page - 1) * args.limit;
    const limit = args.kind === 'count' ? 0 : args.limit;
    const unservable = this.notServable(args.plans.map((p) => p.chainId), args.plans[0]?.protocol ?? '');
    if (unservable) return this.lane.skip(unservable === 'position_frozen' ? 'position_frozen' : 'not_ready');
    const prepared = this.prepare(args.plans, access);
    if ('reason' in prepared) return this.lane.skip('unsupported');
    // Everything that can skip a check is decided BEFORE any engine work (a
    // sampled check that a gate then discards must cost nothing): the bucket,
    // its once-a-minute gate, the generation's age, the shadow ticket.
    const now = Date.now();
    const bucketOf = (kind: 'shallow' | 'deep' | 'pastEnd' | 'count') => poolsBucket({ sort: args.sort, search: args.search, minTvlUsd: args.minTvlUsd, single, kind });
    const windowKind: 'shallow' | 'deep' = listWindowRows(args.page, args.limit) === null ? 'deep' : 'shallow';
    const candidates = args.kind === 'count' ? [bucketOf('count')] : skip > 0 ? [bucketOf('pastEnd'), bucketOf(windowKind)] : [bucketOf(windowKind)];
    if (candidates.every((bucket) => this.lane.recent(bucket, now))) return this.lane.skip('bucket_recent');
    const generation = catalog.current;
    if (!generation || now - parseClusterTime(generation.ct).t * 1000 > LANE_A_MAX_AGE_MS) return this.lane.skip('window');
    if (!(await this.readModels.shadowTicket(this.config.readModelsShadowMaxPerMin))) return this.lane.skip('sample_cap');
    // The engine's side: the served answer, else the answer cache — each only
    // when bound to the SAME exclusion lists the reference is built from (the
    // plans are re-derived after the response); otherwise the engine answers
    // again with the current lists.
    const usable = (a: CachedPoolsAnswer | undefined): a is CachedPoolsAnswer => Boolean(a && catalog.isCurrent(a) && sameExclusions(a.excluded, prepared.inputs));
    const cached = this.answers.peek(prepared.key)?.value;
    let answer: CatalogAnswer;
    try {
      answer = usable(args.served) ? args.served : usable(cached) ? cached : await catalog.answer(prepared.inputs, prepared.perm, { atomCounts: true, affinity: prepared.key });
    } catch {
      return this.lane.skip('engine');
    }
    const total = answer.counts.reduce((sum, n) => sum + n, 0);
    const bucket = args.kind === 'count' ? bucketOf('count') : skip > 0 && skip >= total ? bucketOf('pastEnd') : bucketOf(windowKind);
    if (this.lane.recent(bucket, now)) return this.lane.skip('bucket_recent');
    const atClusterTime = parseClusterTime(answer.ct);
    if (now - atClusterTime.t * 1000 > LANE_A_MAX_AGE_MS) return this.lane.skip('window');
    const estimate = estimateReferenceDocs(
      answer.shards.map((s, i) => {
        const live = catalog.current?.shards.get(s.key)?.cols.live ?? 0;
        const tvl = this.tvlRangeRows(prepared.inputs[i], answer.atomCounts?.[i]);
        return { live, matches: answer.counts[i], rangeRows: tvl ?? live };
      }),
      { skip, limit },
    );
    if (estimate > LANE_A_MAX_DOCS) return this.lane.skip('heavy', bucket, now);
    // Lane A yields to users: never while the user read budget is under
    // pressure, and its reads come from its own ≤ 2k docs/s bucket — never
    // from the user one (a check must not delay a user's count or deep walk).
    if (this.budget?.underPressure()) return this.lane.skip('budget');
    if (!this.laneBudget.take(estimate)) return this.lane.skip('budget');
    const cap = this.config.leaderboardCountCap;
    let shards: ReferenceShard[];
    try {
      shards = await Promise.all(
        args.plans.map(async (plan) => {
          const reference = await access.reference(plan.chainId, plan.protocol, {
            filter: access.cast(plan.chainId, plan.protocol, plan.filter),
            sortField: plan.sortField,
            sortDirection: plan.sortDirection,
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
    const mongo = mongoLaneAnswer(shards, { skip, limit, cap, sortDirection: args.plans[0].sortDirection, single });
    const engine = this.laneAnswer(answer, skip, limit, cap);
    if (!engine) return this.lane.skip('instance_changed');
    const diff = diffLaneAnswers(engine, mongo);
    const detail = { model: 'pools', shards: answer.shards.map((s) => s.chainId), sort: args.sort, skip, limit, seq: answer.seq, ct: answer.ct, filterKey: prepared.key.slice(0, 200) };
    this.lane.record(bucket, diff, detail, now);
    if (diff) this.readModels.alerts.evidence('read_models.shadow_diff', JSON.stringify({ lane: 'A', bucket, ...detail, ...diff }));
  }

  /** The tvl range atom's live matches on a shard (the count's index range). */
  private tvlRangeRows(input: AnswerShardInput, counts: number[][] | undefined): number | undefined {
    if (!counts) return undefined;
    for (let c = 0; c < input.plan.clauses.length; c++) {
      const clause = input.plan.clauses[c];
      if (clause.length === 1 && clause[0].k === 'range' && clause[0].leaf === POOL_LEAF.tvl) return counts[c]?.[0];
    }
    return undefined;
  }

  /** The engine's side of a lane-A comparison. */
  private laneAnswer(answer: CatalogAnswer, skip: number, limit: number, cap: number): LaneAnswer | undefined {
    const catalog = this.catalog;
    if (!catalog) return undefined;
    const entries: LaneAnswer['entries'] = [];
    const end = Math.min(answer.slots.length, skip + limit);
    for (let i = skip; i < end; i++) {
      const index = answer.shard ? answer.shard[i] : 0;
      const poolId = catalog.poolIdOf(answer, index, answer.slots[i]);
      if (poolId === undefined) return undefined;
      entries.push({ chainId: answer.shards[index].chainId, poolId });
    }
    const total = answer.counts.reduce((sum, n) => sum + n, 0);
    return {
      entries,
      hasMore: total > skip + limit,
      counts: answer.shards.map((s, i) => ({ chainId: s.chainId, count: Math.min(answer.counts[i], cap), capped: answer.counts[i] >= cap })),
    };
  }

  // ── status ──

  status(): Record<string, unknown> {
    return {
      mode: this.mode(),
      catalog: this.catalog?.status() ?? null,
      engine: this.engine?.stats() ?? null,
      answers: this.answers.stats(),
      compiled: this.compiled.size,
      requests: { ...this.meter, fallback: { ...this.meter.fallback } },
      shadow: this.lane.snapshot(),
    };
  }
}
