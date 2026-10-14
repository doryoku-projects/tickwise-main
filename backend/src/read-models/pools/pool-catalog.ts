import { EngineOverloadError, type EngineRunner } from '../core/engine-runner.js';
import { shardKey, type ShardKey } from '../core/fields.js';
import type { ModelStore } from '../core/model-store.js';
import type { ShardTable } from '../core/row-store.js';
import { sharedU32 } from '../core/shared-memory.js';
import { POOL_ID_COL, POOL_LEAF, POOL_PERMS, PoolColumns, type DictView, type PoolOverlay, type PoolShardRef } from './pool-columns.js';
import type { BoundQuery, PoolPassResult } from './pool-pass.js';
import { bindPoolQuery, ShardListFlags, type PoolQueryPlan } from './pool-query.js';

/**
 * The POOL CATALOG (Phase P-R R2, design §5): every pool of every served
 * pools shard — $0-TVL pools and Robinhood's stubs included — in shared
 * memory, with its five sort permutations, answering the pools list (any
 * filter the compiler accepts, any page, exact counts) without Mongo.
 *
 * GENERATIONS (§4.7). Every `READ_MODELS_GENERATION_MS` (`tick`):
 *  1. FREEZE: for each servable shard, the slots its R1 table changed since
 *     the last tick are captured (`captureOverlay`) — or the whole table is
 *     copied when the shard is new, was reset or replaced, or outgrew its
 *     capacity (a new INSTANCE). All shards freeze at the same stream position,
 *     whose clusterTime (`ct`) and confirm time (`ca`) the generation carries.
 *  2. BUILD: the next permutations, in the engine (a pass worker), into the
 *     A/B buffer the current generation does not use — passes keep running.
 *  3. SWAP: new passes wait, in-flight passes drain, the overlays are applied
 *     to the columns in place, the permutations flip, the generation is
 *     published. Nothing is allocated per generation (F15).
 * A tick with no change only moves `ct` / `ca` forward.
 *
 * A refused or failed build / update (an overloaded engine) publishes NOTHING:
 * every shard stays at the current generation (its `ct` then ages — flagged
 * stale, then `catalog_lag`), the slots the overlays took are re-queued for
 * the next tick and the copies made for builds are kept and patched — no shard
 * leaves the generation and no buffer is reallocated because the engine was
 * busy. Only after `MAX_GENERATION_RETRIES` consecutive failures is a shard
 * dropped and rebuilt from a fresh copy. A table that is not ready leaves the
 * generation and its recorded changes are drained (it is rebuilt when ready).
 *
 * Every answer is computed by ONE pass on ONE generation, holding it
 * (`acquire` / `release`): its order, its counts and its clusterTime agree.
 */

export interface CatalogShard {
  key: ShardKey;
  chainId: number;
  protocol: string;
  /** Unique per (re)build: cached answers and worker caches are scoped by it. */
  instance: number;
  /** Bumped when this shard's data changes (worker caches are per generation). */
  gen: number;
  table: ShardTable;
  resets: number;
  cols: PoolColumns;
  perms: [Uint32Array[], Uint32Array[]];
  current: 0 | 1;
  permLen: number;
  dict: DictView;
  /** R1 quarantine counts per leaf as of this generation. */
  quarantine: Int32Array;
  lists: ShardListFlags;
  builtAt: number;
}

export interface CatalogGeneration {
  /** Bumped by every published tick. */
  seq: number;
  /** clusterTime of the stream position the data is at (`t:i`). */
  ct: string;
  /** Wall time the feeder last confirmed it was caught up, as of that position (ms). */
  ca: number;
  publishedAt: number;
  shards: ReadonlyMap<ShardKey, CatalogShard>;
  /**
   * The stream position was FROZEN when this generation was taken: R1 stamps
   * every entry with the position taken before its first blocked repair while
   * still applying later changes, so the data can be newer than `ct` and rows
   * read at `ct` would not match the order. Such a generation is neither
   * served nor lane-checked (`position_frozen`).
   */
  frozen?: boolean;
}

/**
 * Is R1's stream position frozen (a repair is blocked)? Read defensively: the
 * flag is optional on the position (absent = not frozen).
 */
export function positionFrozen(pos: object): boolean {
  return (pos as { frozen?: unknown }).frozen === true;
}

/**
 * Consecutive failed generation tasks (build / update) of one shard that are
 * retried while the shard keeps its published state; past this the shard is
 * dropped from the generation and rebuilt from a fresh copy.
 */
export const MAX_GENERATION_RETRIES = 3;

/** How long a pass waits for a generation swap in progress before it is refused (ms). */
export const ACQUIRE_WAIT_MS = 2_000;

export interface CatalogSource {
  store: ModelStore;
  /** The served pools shards. */
  shards: Array<{ chainId: number; protocol: string }>;
}

export interface PoolCatalogDeps {
  engine: EngineRunner;
  source: () => CatalogSource | undefined;
  alert: (name: string, detail: string) => void;
  log?: (message: string) => void;
  now?: () => number;
  /** Capacity of a (re)built shard: at least the table's, and table slots × this (+ 1024). */
  headroom?: number;
  /** After a swap: the poolIds whose rows changed, per shard (only called when set). */
  onChanged?: (shard: CatalogShard, poolIds: string[]) => void;
}

/** Why a shard cannot answer a query (the request goes to Mongo). */
export class CatalogUnsupported extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

/** One shard's part of an answer request. */
export interface AnswerShardInput {
  key: ShardKey;
  plan: PoolQueryPlan;
  /** The plan's exclusion list (bound to the placeholder). */
  excluded: readonly string[];
}

/** A computed answer: the merged order of the matching slots at one generation. */
export interface CatalogAnswer {
  seq: number;
  ct: string;
  ca: number;
  perm: number;
  shards: Array<{ key: ShardKey; chainId: number; protocol: string; instance: number; gen: number }>;
  /** Exact matches per shard. */
  counts: number[];
  /** Per shard, per clause, per atom (lane-A estimates; when asked). */
  atomCounts?: number[][][];
  slots: Uint32Array;
  /** Shard index per entry (several shards only). */
  shard?: Uint8Array;
  computedAt: number;
}

let instanceSerial = 0;

export class PoolCatalog {
  current?: CatalogGeneration;
  private ticking = false;
  private inflight = 0;
  private gate?: Promise<void>;
  private drained?: () => void;
  private readonly now: () => number;
  private stopped = false;
  /**
   * Slots an overlay took from its table but that were never applied (its
   * generation was not published): they go into the next tick's overlay.
   */
  private readonly requeued = new Map<ShardKey, number[]>();
  /**
   * Copies made for a (re)build that was never published: reused — patched
   * with the changes since — next tick instead of allocating new buffers.
   */
  private readonly stash = new Map<ShardKey, CatalogShard>();
  /** Consecutive failed generation tasks per shard (`MAX_GENERATION_RETRIES`). */
  private readonly retries = new Map<ShardKey, number>();
  /** Shards dropped because their R1 table was replaced or removed (meter). */
  replacedDrops = 0;
  /** Meter. */
  ticks = 0;
  swaps = 0;
  builds = 0;
  lastTickMs = 0;
  lastSwapWaitMs = 0;
  lastBuildMs = 0;
  failures = 0;

  constructor(private readonly deps: PoolCatalogDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** Hold the current generation for one pass (waits while a swap is draining). */
  /**
   * Enter the current generation for one pass. While a swap holds the gate,
   * a pass waits at most `ACQUIRE_WAIT_MS` and is then refused as an overload
   * (`EngineOverloadError('deadline')` → 503 + Retry-After) — a slow swap must
   * not park every pools request behind it (the rank engine's rule).
   */
  async acquire(waitMs = ACQUIRE_WAIT_MS): Promise<CatalogGeneration | undefined> {
    if (this.gate) {
      const deadline = this.now() + waitMs;
      while (this.gate) {
        const left = deadline - this.now();
        if (left <= 0) throw new EngineOverloadError('deadline');
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([this.gate, new Promise<void>((resolve) => (timer = setTimeout(resolve, left)))]);
        if (timer) clearTimeout(timer);
      }
    }
    this.inflight++;
    return this.current;
  }

  release(): void {
    this.inflight--;
    if (this.inflight === 0) this.drained?.();
  }

  /** Run `apply` with no pass in flight and none starting. */
  private async swap(apply: () => void): Promise<void> {
    while (this.gate) await this.gate;
    let open!: () => void;
    this.gate = new Promise<void>((resolve) => (open = resolve));
    const started = this.now();
    try {
      if (this.inflight > 0) await new Promise<void>((resolve) => (this.drained = resolve));
      this.lastSwapWaitMs = this.now() - started;
      apply();
    } finally {
      this.drained = undefined;
      this.gate = undefined;
      open();
    }
  }

  stop(): void {
    this.stopped = true;
    this.current = undefined;
    this.requeued.clear();
    this.stash.clear();
    this.retries.clear();
  }

  /** Forget every unpublished copy and every taken-but-unapplied slot (the next tick rebuilds). */
  private forgetPending(): void {
    for (const shard of this.stash.values()) this.deps.engine.broadcast('drop', { instanceKey: `${shard.key}#${shard.instance}` });
    this.stash.clear();
    this.requeued.clear();
  }

  /** One generation step (see the class comment). Never overlaps itself. */
  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    const started = this.now();
    try {
      await this.step();
      this.ticks++;
    } catch (err) {
      this.failures++;
      // The changes this tick took from the tables may be lost: rebuild every shard next tick
      // rather than keep serving a copy that silently misses them.
      for (const shard of this.current?.shards.values() ?? []) shard.resets = -1;
      this.forgetPending();
      this.deps.alert('read_models.catalog_failed', `pool catalog generation failed: ${(err as Error)?.message ?? String(err)} — rebuilding`);
    } finally {
      this.lastTickMs = this.now() - started;
      this.ticking = false;
    }
  }

  private async step(): Promise<void> {
    const source = this.deps.source();
    if (!source) {
      this.forgetPending();
      if (this.current) await this.swap(() => this.dropAll());
      return;
    }
    const { store } = source;
    // A shard whose R1 table was replaced (a snapshot reload: the store dropped
    // its tables first) or removed leaves the generation NOW, before anything
    // is copied — its old copy must not be held while the new one is built.
    const stale = [...(this.current?.shards.values() ?? [])].filter((s) => store.table('pools', s.key) !== s.table);
    if (stale.length > 0) {
      await this.swap(() => {
        const cur = this.current;
        if (!cur) return;
        const shards = new Map(cur.shards);
        for (const s of stale) {
          if (shards.get(s.key) !== s) continue;
          shards.delete(s.key);
          this.deps.engine.broadcast('drop', { instanceKey: `${s.key}#${s.instance}` });
          this.replacedDrops++;
        }
        this.current = { ...cur, shards };
      });
      for (const s of stale) this.dropPending(s.key);
    }
    const pos = store.pos;
    const frozen = positionFrozen(pos);
    const prev = this.current;
    type Work =
      | { kind: 'keep'; shard: CatalogShard; dict: DictView; quarantine: Int32Array }
      | { kind: 'overlay'; shard: CatalogShard; overlay: PoolOverlay; changes: number[]; dict: DictView; quarantine: Int32Array; length?: number }
      | { kind: 'build'; shard: CatalogShard };
    const work: Work[] = [];
    // A shard no longer served: its unpublished copy and taken slots go with it.
    const served = new Set(source.shards.map(({ chainId, protocol }) => shardKey(chainId, protocol)));
    for (const key of new Set([...this.stash.keys(), ...this.requeued.keys(), ...this.retries.keys()])) {
      if (served.has(key)) continue;
      this.dropPending(key);
      this.retries.delete(key);
    }
    // 1. FREEZE — synchronous, so every shard is captured at the same stream position.
    for (const { chainId, protocol } of source.shards) {
      const key = shardKey(chainId, protocol);
      const table = store.table('pools', key);
      if (!table || table.state !== 'ready' || table.missingLeaves.size > 0) {
        // The shard leaves this generation and is rebuilt from a fresh copy once
        // ready again, so what its table records meanwhile (a rescan re-inserts
        // every slot) is of no use: drain it rather than let it grow.
        table?.takeChanges();
        this.dropPending(key);
        continue;
      }
      table.trackChanges();
      const old = prev?.shards.get(key);
      const dict = table.dict.sharedView();
      const quarantine = Int32Array.from(table.quarantine);
      const changes = this.changesOf(key, table);
      // A copy made for an unpublished (re)build: patch it with the changes since and build it again.
      const stashed = this.stash.get(key);
      if (stashed) {
        this.stash.delete(key);
        if (stashed.table === table && stashed.resets === table.resets && table.slots <= stashed.cols.arrays.capacity) {
          const overlay = changes.length > 0 ? stashed.cols.captureOverlay(table, changes) : undefined;
          if (!overlay || !stashed.cols.changesPoolId(overlay)) {
            if (overlay) stashed.cols.applyOverlay(overlay, dict);
            stashed.dict = dict;
            stashed.quarantine = quarantine;
            work.push({ kind: 'build', shard: stashed });
            continue;
          }
        }
        this.deps.engine.broadcast('drop', { instanceKey: `${stashed.key}#${stashed.instance}` });
      }
      const rebuild = !old || old.table !== table || old.resets !== table.resets || table.slots > old.cols.arrays.capacity;
      if (!rebuild) {
        if (changes.length === 0) {
          work.push({ kind: 'keep', shard: old, dict, quarantine });
          continue;
        }
        const overlay = old.cols.captureOverlay(table, changes);
        if (!old.cols.changesPoolId(overlay)) {
          work.push({ kind: 'overlay', shard: old, overlay, changes, dict, quarantine });
          continue;
        }
        this.deps.alert('read_models.catalog_rebuild', `${key}: a row changed its poolId — rebuilding the shard`);
      }
      work.push({ kind: 'build', shard: this.copyShard(table, chainId, protocol, dict, quarantine) });
    }
    const changed = work.some((w) => w.kind !== 'keep') || (prev?.shards.size ?? 0) !== work.length;
    if (!changed) {
      // Nothing moved: the generation only advances its stream position.
      if (prev) this.current = { ...prev, ct: pos.ct, ca: pos.ca, seq: prev.seq + 1, publishedAt: this.now(), frozen };
      else this.current = { seq: 1, ct: pos.ct, ca: pos.ca, publishedAt: this.now(), shards: new Map(), frozen };
      return;
    }
    // 2. BUILD the next permutations (passes on the current generation continue).
    const buildStarted = this.now();
    const failed = new Set<ShardKey>();
    await Promise.all(
      work.map(async (w) => {
        try {
          if (w.kind === 'build') {
            const s = w.shard;
            const { length } = await this.deps.engine.run('pools.build', { cols: s.cols.arrays, dict: s.dict, slots: s.cols.slots, out: s.perms[0] }, { deadlineMs: 60_000 });
            s.permLen = length;
            this.builds++;
          } else if (w.kind === 'overlay') {
            const s = w.shard;
            const next = (1 - s.current) as 0 | 1;
            const { length } = await this.deps.engine.run(
              'pools.update',
              { cols: s.cols.arrays, dict: w.dict, overlay: w.overlay, prev: s.perms[s.current], prevLen: s.permLen, out: s.perms[next] },
              { deadlineMs: 60_000 },
            );
            w.length = length;
          }
        } catch (err) {
          failed.add(w.shard.key);
          this.failures++;
          this.deps.alert('read_models.catalog_failed', `${w.shard.key}: ${w.kind} failed (${(err as Error)?.message ?? String(err)})`);
        }
      }),
    );
    this.lastBuildMs = this.now() - buildStarted;
    if (this.stopped) return;
    for (const w of work) if (!failed.has(w.shard.key)) this.retries.delete(w.shard.key);
    for (const key of failed) this.retries.set(key, (this.retries.get(key) ?? 0) + 1);
    if (failed.size > 0 && [...failed].every((key) => (this.retries.get(key) ?? 0) < MAX_GENERATION_RETRIES)) {
      // A refused or failed task (an overloaded engine, typically) publishes
      // NOTHING: every shard stays at the current generation — consistent with
      // its `ct`, which then ages (flagged stale, then `catalog_lag`) — the
      // taken slots go into the next tick's overlay, and the copies made for
      // builds are kept for it. No shard leaves the generation and no buffer
      // is reallocated because the engine was busy.
      for (const w of work) {
        if (w.kind === 'overlay') this.requeue(w.shard.key, w.changes);
        else if (w.kind === 'build') this.stash.set(w.shard.key, w.shard);
      }
      return;
    }
    // Past its retries: the shard leaves the generation and is rebuilt from a fresh copy.
    for (const key of failed) {
      this.retries.delete(key);
      this.deps.alert('read_models.catalog_failed', `${key}: generation task failed ${MAX_GENERATION_RETRIES} times — the shard is rebuilt next tick`);
    }
    // 3. SWAP.
    await this.swap(() => {
      const shards = new Map<ShardKey, CatalogShard>();
      for (const w of work) {
        if (failed.has(w.shard.key)) continue;
        if (w.kind === 'keep') {
          w.shard.dict = w.dict;
          w.shard.quarantine = w.quarantine;
          shards.set(w.shard.key, w.shard);
        } else if (w.kind === 'overlay') {
          const s = w.shard;
          s.cols.applyOverlay(w.overlay, w.dict);
          s.current = (1 - s.current) as 0 | 1;
          s.permLen = w.length!;
          s.dict = w.dict;
          s.quarantine = w.quarantine;
          s.gen++;
          shards.set(s.key, s);
        } else {
          shards.set(w.shard.key, w.shard);
        }
      }
      for (const key of prev?.shards.keys() ?? []) {
        const old = prev!.shards.get(key)!;
        const kept = shards.get(key);
        if (!kept || kept.instance !== old.instance) this.deps.engine.broadcast('drop', { instanceKey: `${old.key}#${old.instance}` });
      }
      // A shard whose update failed must not keep serving its pre-failure state:
      // force a full rebuild (its changes were taken).
      for (const w of work) if (failed.has(w.shard.key) && w.kind !== 'build') w.shard.resets = -1;
      this.current = { seq: (prev?.seq ?? 0) + 1, ct: pos.ct, ca: pos.ca, publishedAt: this.now(), shards, frozen };
      this.swaps++;
    });
    const onChanged = this.deps.onChanged;
    if (!onChanged) return;
    for (const w of work) {
      if (w.kind !== 'overlay' || failed.has(w.shard.key)) continue;
      const ids = new Set<string>();
      const sid = w.overlay.sid[POOL_ID_COL];
      for (let i = 0; i < w.overlay.n; i++) if (sid[i] > 0) ids.add(w.shard.table.dict.get(sid[i] - 1));
      try {
        onChanged(w.shard, [...ids]);
      } catch {
        // a listener's failure is not the catalog's
      }
    }
  }

  /** The table's changed slots since the last tick, plus any an unpublished overlay had taken. */
  private changesOf(key: ShardKey, table: ShardTable): number[] {
    const taken = table.takeChanges();
    const again = this.requeued.get(key);
    if (!again) return taken;
    this.requeued.delete(key);
    if (taken.length === 0) return again;
    return [...new Set([...again, ...taken])];
  }

  private requeue(key: ShardKey, slots: number[]): void {
    const pending = this.requeued.get(key);
    this.requeued.set(key, pending ? [...new Set([...pending, ...slots])] : slots);
  }

  /** A shard left the generation (not ready): its unpublished copy and taken slots are moot. */
  private dropPending(key: ShardKey): void {
    this.requeued.delete(key);
    const stashed = this.stash.get(key);
    if (!stashed) return;
    this.stash.delete(key);
    this.deps.engine.broadcast('drop', { instanceKey: `${stashed.key}#${stashed.instance}` });
  }

  private copyShard(table: ShardTable, chainId: number, protocol: string, dict: DictView, quarantine: Int32Array): CatalogShard {
    // The table's own capacity already carries headroom (R1 grows it by doubling, a
    // snapshot load reserves 1.25×); past it the table reallocates and the catalog rebuilds.
    const capacity = Math.max(table.capacity, Math.ceil(table.slots * (this.deps.headroom ?? 1.1))) + 1024;
    const cols = new PoolColumns(capacity);
    cols.copyFrom(table);
    const perms = (): Uint32Array[] => POOL_PERMS.map(() => sharedU32(cols.arrays.capacity));
    return {
      key: shardKey(chainId, protocol),
      chainId,
      protocol,
      instance: ++instanceSerial,
      gen: 1,
      table,
      resets: table.resets,
      cols,
      perms: [perms(), perms()],
      current: 0,
      permLen: 0,
      dict,
      quarantine,
      lists: new ShardListFlags(),
      builtAt: this.now(),
    };
  }

  private dropAll(): void {
    for (const shard of this.current?.shards.values() ?? []) this.deps.engine.broadcast('drop', { instanceKey: `${shard.key}#${shard.instance}` });
    this.current = undefined;
  }

  /** The pass-ready reference of a shard at its current generation. */
  static ref(shard: CatalogShard): PoolShardRef {
    return {
      shard: shard.key,
      chainId: shard.chainId,
      instance: shard.instance,
      gen: shard.gen,
      slots: shard.cols.slots,
      cols: shard.cols.arrays,
      dict: shard.dict,
      perms: shard.perms[shard.current],
      permLen: POOL_PERMS.map(() => shard.permLen),
    };
  }

  /**
   * Leaves a query reads whose (shard, field) holds a row the catalog cannot
   * reproduce MongoDB for (§4.8) — an odd value (R1), a foreign chainId /
   * protocol (R1), a null or non-BMP poolId (here). Any → the query goes to
   * Mongo.
   */
  static quarantined(shard: CatalogShard, leaves: Iterable<number>): string | undefined {
    for (const leaf of leaves) {
      if (shard.quarantine[leaf] > 0) return `quarantine:${leaf}`;
      if (leaf === POOL_LEAF.poolId && shard.cols.poolIdQuarantine > 0) return `quarantine:${leaf}`;
    }
    return undefined;
  }

  /**
   * One answer: bind each shard's compiled query to its current generation,
   * one pass in the engine, materialised order + exact counts. Throws
   * `CatalogUnsupported` when a shard is missing or reads a quarantined leaf.
   */
  /**
   * Why `inputs` cannot be answered on `generation` (undefined = they can):
   * exactly the refusals of `answer` — no generation, an unknown sort, a shard
   * not built into it, a quarantined leaf the query reads. Lets a caller send
   * a request to Mongo BEFORE it commits to the catalog (a count, whose
   * failure would otherwise be remembered under a key Mongo shares).
   */
  unservable(inputs: readonly AnswerShardInput[], perm: number, generation: CatalogGeneration | undefined = this.current): string | undefined {
    if (!generation) return 'catalog_not_built';
    const spec = POOL_PERMS[perm];
    if (!spec) return 'sort';
    for (const input of inputs) {
      const shard = generation.shards.get(input.key);
      if (!shard) return 'shard_not_built';
      const reason = PoolCatalog.quarantined(shard, [...input.plan.leaves, spec.leaf, POOL_LEAF.poolId, POOL_LEAF.chainId, POOL_LEAF.protocol]);
      if (reason) return reason;
    }
    return undefined;
  }

  async answer(inputs: AnswerShardInput[], perm: number, options: { atomCounts?: boolean; materialize?: boolean; affinity?: string } = {}): Promise<CatalogAnswer> {
    const generation = await this.acquire();
    try {
      const reason = this.unservable(inputs, perm, generation);
      if (reason) throw new CatalogUnsupported(reason);
      const parts: Array<{ shard: CatalogShard; query: BoundQuery }> = [];
      for (const input of inputs) {
        const shard = generation!.shards.get(input.key)!;
        const query = bindPoolQuery(input.plan, { dict: shard.table.dict, dictSize: shard.dict.size, lists: shard.lists }, input.excluded);
        parts.push({ shard, query });
      }
      const result: PoolPassResult = await this.deps.engine.run(
        'pools.pass',
        { shards: parts.map((p) => ({ ref: PoolCatalog.ref(p.shard), query: p.query })), perm, materialize: options.materialize ?? true, atomCounts: options.atomCounts },
        { affinity: options.affinity },
      );
      return {
        seq: generation!.seq,
        ct: generation!.ct,
        ca: generation!.ca,
        perm,
        shards: parts.map(({ shard }) => ({ key: shard.key, chainId: shard.chainId, protocol: shard.protocol, instance: shard.instance, gen: shard.gen })),
        counts: result.n,
        ...(result.atomCounts ? { atomCounts: result.atomCounts } : {}),
        slots: result.slots ?? new Uint32Array(0),
        ...(result.shard ? { shard: result.shard } : {}),
        computedAt: this.now(),
      };
    } finally {
      this.release();
    }
  }

  /** Is every shard of `answer` still the instance it was computed on? */
  isCurrent(answer: Pick<CatalogAnswer, 'shards'>): boolean {
    const generation = this.current;
    if (!generation) return false;
    return answer.shards.every((s) => generation.shards.get(s.key)?.instance === s.instance);
  }

  /** The poolId of a slot of an answer's shard (`answer.shards[index]`), from the live instance. */
  poolIdOf(answer: Pick<CatalogAnswer, 'shards'>, index: number, slot: number): string | undefined {
    const ref = answer.shards[index];
    const shard = this.current?.shards.get(ref.key);
    if (!shard || shard.instance !== ref.instance) return undefined;
    const sid = shard.cols.arrays.sid[POOL_ID_COL][slot];
    return sid === 0 ? undefined : shard.table.dict.get(sid - 1);
  }

  /** Status block. */
  status(now = this.now()) {
    const generation = this.current;
    return {
      seq: generation?.seq ?? 0,
      ct: generation?.ct ?? null,
      dataAt: generation?.ca ? new Date(generation.ca).toISOString() : null,
      dataAgeMs: generation?.ca ? now - generation.ca : null,
      publishedAgoMs: generation ? now - generation.publishedAt : null,
      ticks: this.ticks,
      swaps: this.swaps,
      builds: this.builds,
      failures: this.failures,
      frozen: generation?.frozen === true,
      /** Shards whose generation task was refused / failed and is being retried (nothing published meanwhile). */
      retrying: Object.fromEntries(this.retries),
      stashed: [...this.stash.keys()],
      requeuedSlots: [...this.requeued.values()].reduce((sum, slots) => sum + slots.length, 0),
      replacedDrops: this.replacedDrops,
      lastTickMs: this.lastTickMs,
      lastBuildMs: this.lastBuildMs,
      lastSwapWaitMs: this.lastSwapWaitMs,
      inflight: this.inflight,
      shards: [...(generation?.shards.values() ?? [])].map((s) => ({
        shard: s.key,
        instance: s.instance,
        gen: s.gen,
        live: s.cols.live,
        slots: s.cols.slots,
        capacity: s.cols.arrays.capacity,
        permLen: s.permLen,
        dict: s.dict.size,
        bytes: s.cols.memoryBytes + s.perms.flat().reduce((sum, p) => sum + p.byteLength, 0),
        lists: s.lists.size,
        poolIdQuarantine: s.cols.poolIdQuarantine,
        builtAt: new Date(s.builtAt).toISOString(),
      })),
    };
  }
}
