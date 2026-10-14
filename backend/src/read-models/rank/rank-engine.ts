import { CkeyIndex } from '../core/ckey.js';
import { EngineOverloadError, type EngineRunner } from '../core/engine-runner.js';
import { shardKey, type ShardKey } from '../core/fields.js';
import type { ModelStore } from '../core/model-store.js';
import type { ShardTable } from '../core/row-store.js';
import { sharedU32 } from '../core/shared-memory.js';
import type { DictView } from '../pools/pool-columns.js';
import { MAX_GENERATION_RETRIES, positionFrozen } from '../pools/pool-catalog.js';
import { ShardListFlags } from '../pools/pool-query.js';
import { PC_PID, PID_COL, RANK_LEAF, RANK_PERMS, RANK_STR_LEAVES, RankColumns, type RankOverlay } from './rank-columns.js';
import type { HolderCountsDelta, RankBuildOut, RankCsr } from './rank-perms.js';
import type { RankBoundQuery, RankPassResult, RankScope, RankShardRef } from './rank-pass.js';
import { bindRankQuery, ClassListFlags, type RankQueryPlan } from './rank-query.js';

/**
 * The POSITIONS RANK ENGINE (Phase P-R R3, design §6): every position of
 * every served positions shard in shared memory, with its seven sort
 * permutations, the pool / owner CSRs and the per-pool holder counts,
 * answering the leaderboard (any filter the compiler accepts, every shape,
 * any page, exact counts) without Mongo.
 *
 * GENERATIONS — the pool catalog's scheme (`pools/pool-catalog.ts`), every
 * `READ_MODELS_GENERATION_MS`:
 *  1. FREEZE (synchronous, every shard at one stream position): the slots each
 *     R1 table changed since the last tick, captured as an overlay — or the
 *     whole table copied into a NEW INSTANCE when the shard is new, was reset
 *     or replaced, outgrew its capacity, or a row changed its positionId
 *     (slots must keep their id within an instance: cached answers resolve
 *     slots to positionIds later). New dictionary entries get their collation
 *     classes here (`CkeyIndex.extend`).
 *  2. BUILD in a pass worker into the A/B buffers the current generation does
 *     not use: permutations (always), CSRs (only when a row's live / pool /
 *     owner class changed), holder counts of the pools whose rows changed.
 *  3. SWAP: new passes wait, in-flight passes drain, the overlay is applied
 *     to the columns in place, the buffers flip, the holder counts update, the
 *     generation (`seq`, `ct`, `ca`) is published. Nothing is allocated per
 *     generation (F15) except a CSR key array that outgrew its headroom.
 * Every answer is ONE pass on ONE generation, holding it (`acquire` /
 * `release`): its order, its counts and its clusterTime agree.
 *
 * A refused or failed build / update publishes NOTHING (the pool catalog's
 * rule): every shard stays at the current generation (its `ct` ages
 * honestly), the slots the overlay took are re-queued into the next tick's,
 * and the copies made for builds are kept and patched next tick instead of
 * reallocated; only after `MAX_GENERATION_RETRIES` consecutive failures does
 * a shard leave the generation and get rebuilt from a fresh copy. A table
 * that is not ready has its changes drained every tick (it is rebuilt from a
 * fresh copy once ready). A shard whose R1 table was REPLACED (a snapshot
 * reload) or dropped leaves the generation at the start of the next tick,
 * before any new copy is built — so a reload never holds the old engine copy,
 * the new R1 tables and the new copy at once.
 */

export interface RankShard {
  key: ShardKey;
  chainId: number;
  protocol: string;
  /** Unique per (re)build: cached answers and worker caches are scoped by it. */
  instance: number;
  /** Bumped when this shard's data changes (worker caches are per generation). */
  gen: number;
  table: ShardTable;
  resets: number;
  cols: RankColumns;
  ckeys: CkeyIndex;
  perms: [Uint32Array[], Uint32Array[]];
  permCur: 0 | 1;
  permLen: number[];
  pools: [RankCsr, RankCsr];
  owners: [RankCsr, RankCsr];
  csrCur: 0 | 1;
  /** Holder counts per pool key (dictionary id + 1) — main-thread only. */
  holders: { positions: Uint32Array; holders: Uint32Array; ambiguous: Uint8Array };
  dict: DictView;
  /** R1 quarantine counts per leaf as of this generation. */
  quarantine: Int32Array;
  lists: ShardListFlags;
  classLists: ClassListFlags;
  builtAt: number;
}

export interface RankGeneration {
  seq: number;
  ct: string;
  ca: number;
  publishedAt: number;
  shards: ReadonlyMap<ShardKey, RankShard>;
  /**
   * R1's position was frozen (a repair is blocked: the store holds changes
   * newer than `ct`) when this generation was published — it is neither
   * served nor lane-checked (`position_frozen`), as the pool catalog's.
   */
  frozen?: boolean;
}

export interface RankSource {
  store: ModelStore;
  /** The served positions shards. */
  shards: Array<{ chainId: number; protocol: string }>;
}

export interface RankEngineDeps {
  engine: EngineRunner;
  source: () => RankSource | undefined;
  alert: (name: string, detail: string) => void;
  log?: (message: string) => void;
  now?: () => number;
  /** Capacity of a (re)built shard: at least the table's, and table slots × this (+ 1024). */
  headroom?: number;
  /** After a swap: the pool keys whose holder counts changed, per shard (only called when set). */
  onHolders?: (shard: RankShard, poolIds: string[]) => void;
}

/** How long a pass waits for a generation swap in progress before it is refused (ms). */
export const ACQUIRE_WAIT_MS = 2_000;

/** Why a shard cannot answer a query (the request goes to Mongo). */
export class RankUnsupported extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

export interface RankAnswerShardInput {
  key: ShardKey;
  plan: RankQueryPlan;
  excluded: readonly string[];
}

/** A computed answer: the merged order of the matching slots at one generation. */
export interface RankAnswer {
  seq: number;
  ct: string;
  ca: number;
  perm: number;
  reverse: boolean;
  shards: Array<{ key: ShardKey; chainId: number; protocol: string; instance: number; gen: number }>;
  counts: number[];
  /** Rows each shard's scope offered (lane-A estimates). */
  scope: number[];
  slots: Uint32Array;
  shard?: Uint8Array;
  computedAt: number;
}

let instanceSerial = 0;

/**
 * Collation classes per shard DICTIONARY (not per engine instance): R1 keeps a
 * table's dictionary across a reset, so a rebuilt instance reuses the classes
 * instead of re-deriving millions of ckeys on the main thread. A replaced
 * table (snapshot load) has a new dictionary and gets a new index.
 */
const ckeysByDict = new WeakMap<object, CkeyIndex>();

function ckeysFor(table: ShardTable, dict: DictView): CkeyIndex {
  const index = ckeysOf(table, dict.size);
  index.extend(dict);
  return index;
}

function ckeysOf(table: ShardTable, size: number): CkeyIndex {
  let index = ckeysByDict.get(table.dict);
  if (!index) {
    index = new CkeyIndex(Math.ceil(size * 1.25) + 1024);
    ckeysByDict.set(table.dict, index);
  }
  return index;
}

/** Entries classified per slice before yielding to the event loop. */
const CLASSIFY_SLICE = 50_000;

/**
 * Classify the dictionary entries the next freeze will need, in slices with
 * event-loop yields in between (1.76M entries ≈ 400 ms of work at full
 * Robinhood). Safe outside the freeze: entries are immutable and appended, so
 * whatever arrives meanwhile is classified by the freeze itself.
 */
async function preclassify(tables: ShardTable[]): Promise<void> {
  for (const table of tables) {
    const index = ckeysOf(table, table.dict.size);
    for (;;) {
      const dict = table.dict.sharedView();
      if (index.size >= dict.size) break;
      index.extend({ ...dict, size: Math.min(dict.size, index.size + CLASSIFY_SLICE) });
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}

function csr(capacity: number, keys: number): RankCsr {
  return { order: sharedU32(capacity), start: sharedU32(keyCapacity(keys)), keys: 0 };
}

function keyCapacity(keys: number): number {
  return Math.ceil((keys + 2) * 1.5) + 1024;
}

/** Make sure a CSR buffer can take `keys` keys (it is the FREE A/B side: nobody reads it). */
function ensureKeys(target: RankCsr, keys: number): void {
  if (target.start.length >= keys + 2) return;
  target.start = sharedU32(keyCapacity(keys));
}

export class RankEngine {
  current?: RankGeneration;
  private ticking = false;
  private inflight = 0;
  private gate?: Promise<void>;
  private drained?: () => void;
  private readonly now: () => number;
  private stopped = false;
  ticks = 0;
  swaps = 0;
  builds = 0;
  csrRebuilds = 0;
  lastTickMs = 0;
  lastSwapWaitMs = 0;
  lastBuildMs = 0;
  failures = 0;
  /** Slots an overlay took that were never applied (its generation was not published): next tick's. */
  private readonly requeued = new Map<ShardKey, number[]>();
  /** Copies made for a (re)build that was never published: patched and built again next tick. */
  private readonly stash = new Map<ShardKey, RankShard>();
  /** Consecutive failed generation tasks per shard. */
  private readonly retries = new Map<ShardKey, number>();
  /** Shards dropped because their R1 table was replaced or removed (meter). */
  replacedDrops = 0;

  constructor(private readonly deps: RankEngineDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Enter the current generation for one pass. While a swap holds the gate
   * (it waits for the passes in flight, then applies), a pass waits at most
   * `ACQUIRE_WAIT_MS` and is then refused as an overload (503 + Retry-After,
   * like a task that could not start within its deadline) — a slow swap must
   * not park every request behind it.
   */
  async acquire(waitMs = ACQUIRE_WAIT_MS): Promise<RankGeneration | undefined> {
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
  }

  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    const started = this.now();
    try {
      await this.step();
      this.ticks++;
    } catch (err) {
      this.failures++;
      for (const shard of this.current?.shards.values() ?? []) shard.resets = -1;
      this.forgetPending();
      this.deps.alert('read_models.rank_failed', `rank engine generation failed: ${(err as Error)?.message ?? String(err)} — rebuilding`);
    } finally {
      this.lastTickMs = this.now() - started;
      this.ticking = false;
    }
  }

  private forgetPending(): void {
    for (const shard of this.stash.values()) this.deps.engine.broadcast('drop', { instanceKey: `rank:${shard.key}#${shard.instance}` });
    this.stash.clear();
    this.requeued.clear();
  }

  /** A shard left the generation (not ready / not served): its unpublished copy and taken slots are moot. */
  private dropPending(key: ShardKey): void {
    this.requeued.delete(key);
    const stashed = this.stash.get(key);
    if (!stashed) return;
    this.stash.delete(key);
    this.deps.engine.broadcast('drop', { instanceKey: `rank:${stashed.key}#${stashed.instance}` });
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
    const stale = [...(this.current?.shards.values() ?? [])].filter((s) => store.table('rank', s.key) !== s.table);
    if (stale.length > 0) {
      await this.swap(() => {
        const cur = this.current;
        if (!cur) return;
        const shards = new Map(cur.shards);
        for (const s of stale) {
          if (shards.get(s.key) !== s) continue;
          shards.delete(s.key);
          this.deps.engine.broadcast('drop', { instanceKey: `rank:${s.key}#${s.instance}` });
          this.replacedDrops++;
        }
        this.current = { ...cur, shards };
      });
      for (const s of stale) this.dropPending(s.key);
    }
    // Off the synchronous freeze: collation classes of new dictionary entries.
    await preclassify(
      source.shards.flatMap(({ chainId, protocol }) => {
        const table = store.table('rank', shardKey(chainId, protocol));
        return table && table.state === 'ready' ? [table] : [];
      }),
    );
    if (this.stopped) return;
    const pos = store.pos;
    const frozen = positionFrozen(pos);
    const prev = this.current;
    type Work =
      | { kind: 'keep'; shard: RankShard; dict: DictView; quarantine: Int32Array }
      | {
          kind: 'overlay';
          shard: RankShard;
          overlay: RankOverlay;
          changes: number[];
          dict: DictView;
          quarantine: Int32Array;
          keys?: { pool: number; owner: number };
          result?: { permLen: number[]; csrRebuilt: boolean; holders: HolderCountsDelta };
        }
      | { kind: 'build'; shard: RankShard; keys?: { pool: number; owner: number }; result?: { permLen: number[]; holders: HolderCountsDelta } };
    const work: Work[] = [];
    // A shard no longer served: its unpublished copy and taken slots go with it.
    const served = new Set(source.shards.map(({ chainId, protocol }) => shardKey(chainId, protocol)));
    for (const key of new Set([...this.stash.keys(), ...this.requeued.keys(), ...this.retries.keys()])) {
      if (served.has(key)) continue;
      this.dropPending(key);
      this.retries.delete(key);
    }
    // 1. FREEZE — synchronous.
    for (const { chainId, protocol } of source.shards) {
      const key = shardKey(chainId, protocol);
      const table = store.table('rank', key);
      if (!table || table.state !== 'ready' || table.missingLeaves.size > 0) {
        // The shard leaves this generation and is rebuilt from a fresh copy once
        // ready again: what its table records meanwhile (a rescan re-inserts every
        // slot) is of no use — drain it rather than let it grow.
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
          stashed.ckeys.extend(dict);
          const overlay = changes.length > 0 ? stashed.cols.captureOverlay(table, changes) : undefined;
          if (!overlay || !changesPid(stashed.cols.arrays.pc[PID_COL], stashed.cols.arrays.pv[PID_COL], stashed.cols.slots, overlay)) {
            if (overlay) stashed.cols.applyOverlay(overlay, (id) => stashed.ckeys.outside(id));
            stashed.dict = dict;
            stashed.quarantine = quarantine;
            work.push({ kind: 'build', shard: stashed });
            continue;
          }
        }
        this.deps.engine.broadcast('drop', { instanceKey: `rank:${stashed.key}#${stashed.instance}` });
      }
      const rebuild = !old || old.table !== table || old.resets !== table.resets || table.slots > old.cols.arrays.capacity;
      if (!rebuild) {
        old.ckeys.extend(dict);
        if (changes.length === 0) {
          work.push({ kind: 'keep', shard: old, dict, quarantine });
          continue;
        }
        const overlay = old.cols.captureOverlay(table, changes);
        if (!changesPid(old.cols.arrays.pc[PID_COL], old.cols.arrays.pv[PID_COL], old.cols.slots, overlay)) {
          work.push({ kind: 'overlay', shard: old, overlay, changes, dict, quarantine });
          continue;
        }
        this.deps.alert('read_models.rank_rebuild', `${key}: a row changed its positionId — rebuilding the shard`);
      }
      work.push({ kind: 'build', shard: this.copyShard(table, chainId, protocol, dict, quarantine) });
    }
    const changed = work.some((w) => w.kind !== 'keep') || (prev?.shards.size ?? 0) !== work.length;
    if (!changed) {
      if (prev) this.current = { ...prev, ct: pos.ct, ca: pos.ca, seq: prev.seq + 1, publishedAt: this.now(), frozen };
      else this.current = { seq: 1, ct: pos.ct, ca: pos.ca, publishedAt: this.now(), shards: new Map(), frozen };
      return;
    }
    // 2. BUILD (passes on the current generation continue).
    const buildStarted = this.now();
    const failed = new Set<ShardKey>();
    await Promise.all(
      work.map(async (w) => {
        try {
          if (w.kind === 'build') {
            const s = w.shard;
            const out: RankBuildOut = { perms: s.perms[0], pool: s.pools[0], owner: s.owners[0] };
            const poolKeys = s.dict.size + 1;
            const ownerKeys = s.ckeys.classes.size + 1;
            ensureKeys(out.pool, poolKeys);
            ensureKeys(out.owner, ownerKeys);
            w.keys = { pool: poolKeys, owner: ownerKeys };
            const result = await this.deps.engine.run(
              'rank.build',
              { cols: s.cols.arrays, ckeys: s.ckeys.view(), slots: s.cols.slots, poolKeys, ownerKeys, out },
              { deadlineMs: 120_000 },
            );
            w.result = result;
            this.builds++;
          } else if (w.kind === 'overlay') {
            const s = w.shard;
            const nextPerm = (1 - s.permCur) as 0 | 1;
            const nextCsr = (1 - s.csrCur) as 0 | 1;
            const out: RankBuildOut = { perms: s.perms[nextPerm], pool: s.pools[nextCsr], owner: s.owners[nextCsr] };
            const poolKeys = w.dict.size + 1;
            const ownerKeys = s.ckeys.classes.size + 1;
            ensureKeys(out.pool, poolKeys);
            ensureKeys(out.owner, ownerKeys);
            w.keys = { pool: poolKeys, owner: ownerKeys };
            const result = await this.deps.engine.run(
              'rank.update',
              {
                cols: s.cols.arrays,
                ckeys: s.ckeys.view(),
                overlay: w.overlay,
                prev: { perms: s.perms[s.permCur], pool: s.pools[s.csrCur], owner: s.owners[s.csrCur] },
                prevLen: s.permLen,
                slots: s.cols.slots,
                poolKeys,
                ownerKeys,
                out,
              },
              { deadlineMs: 120_000 },
            );
            w.result = result;
          }
        } catch (err) {
          failed.add(w.shard.key);
          this.failures++;
          this.deps.alert('read_models.rank_failed', `${w.shard.key}: ${w.kind} failed (${(err as Error)?.message ?? String(err)})`);
        }
      }),
    );
    this.lastBuildMs = this.now() - buildStarted;
    if (this.stopped) return;
    for (const w of work) if (!failed.has(w.shard.key)) this.retries.delete(w.shard.key);
    for (const key of failed) this.retries.set(key, (this.retries.get(key) ?? 0) + 1);
    if (failed.size > 0 && [...failed].every((key) => (this.retries.get(key) ?? 0) < MAX_GENERATION_RETRIES)) {
      // A refused or failed task publishes NOTHING: every shard stays at the
      // current generation (consistent with its `ct`, which then ages), the
      // taken slots go into the next tick's overlay, and the copies made for
      // builds are kept for it — no shard leaves the generation and no buffer
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
      this.deps.alert('read_models.rank_failed', `${key}: generation task failed ${MAX_GENERATION_RETRIES} times — the shard is rebuilt next tick`);
    }
    // 3. SWAP.
    const holderChanges: Array<{ shard: RankShard; pools: Uint32Array }> = [];
    await this.swap(() => {
      const shards = new Map<ShardKey, RankShard>();
      for (const w of work) {
        if (failed.has(w.shard.key)) continue;
        const s = w.shard;
        if (w.kind === 'keep') {
          s.dict = w.dict;
          s.quarantine = w.quarantine;
          shards.set(s.key, s);
        } else if (w.kind === 'overlay') {
          const result = w.result!;
          s.cols.applyOverlay(w.overlay, (id) => s.ckeys.outside(id));
          s.permCur = (1 - s.permCur) as 0 | 1;
          s.permLen = result.permLen;
          if (result.csrRebuilt) {
            s.csrCur = (1 - s.csrCur) as 0 | 1;
            // The worker filled the arrays (shared memory) but set `keys` on ITS copy of
            // the CSR object: the key count is the one this thread asked for.
            s.pools[s.csrCur].keys = w.keys!.pool;
            s.owners[s.csrCur].keys = w.keys!.owner;
            this.csrRebuilds++;
          }
          this.applyHolders(s, result.holders, w.dict.size);
          if (result.holders.pools.length > 0) holderChanges.push({ shard: s, pools: result.holders.pools });
          s.dict = w.dict;
          s.quarantine = w.quarantine;
          s.gen++;
          shards.set(s.key, s);
        } else {
          const result = w.result!;
          s.permLen = result.permLen;
          s.permCur = 0;
          s.csrCur = 0;
          s.pools[0].keys = w.keys!.pool;
          s.owners[0].keys = w.keys!.owner;
          this.applyHolders(s, result.holders, s.dict.size);
          shards.set(s.key, s);
        }
      }
      for (const key of prev?.shards.keys() ?? []) {
        const old = prev!.shards.get(key)!;
        const kept = shards.get(key);
        if (!kept || kept.instance !== old.instance) this.deps.engine.broadcast('drop', { instanceKey: `rank:${old.key}#${old.instance}` });
      }
      for (const w of work) if (failed.has(w.shard.key) && w.kind !== 'build') w.shard.resets = -1;
      this.current = { seq: (prev?.seq ?? 0) + 1, ct: pos.ct, ca: pos.ca, publishedAt: this.now(), shards, frozen };
      this.swaps++;
    });
    const onHolders = this.deps.onHolders;
    if (!onHolders) return;
    for (const { shard, pools } of holderChanges) {
      const ids: string[] = [];
      for (let i = 0; i < pools.length; i++) if (pools[i] > 0) ids.push(shard.table.dict.get(pools[i] - 1));
      try {
        onHolders(shard, ids);
      } catch {
        // a listener's failure is not the engine's
      }
    }
  }

  /** Write a holder-count delta into the shard's (main-thread) arrays, growing them to the dictionary. */
  private applyHolders(shard: RankShard, delta: HolderCountsDelta, dictSize: number): void {
    const need = dictSize + 2;
    const h = shard.holders;
    if (h.positions.length < need) {
      const size = Math.ceil(need * 1.5) + 1024;
      const grow = <T extends Uint32Array | Uint8Array>(a: T, make: (n: number) => T): T => {
        const next = make(size);
        next.set(a);
        return next;
      };
      shard.holders = {
        positions: grow(h.positions, (n) => new Uint32Array(n)),
        holders: grow(h.holders, (n) => new Uint32Array(n)),
        ambiguous: grow(h.ambiguous, (n) => new Uint8Array(n)),
      };
    }
    const out = shard.holders;
    for (let i = 0; i < delta.pools.length; i++) {
      const k = delta.pools[i];
      out.positions[k] = delta.positions[i];
      out.holders[k] = delta.holders[i];
      out.ambiguous[k] = delta.ambiguous[i];
    }
  }

  private copyShard(table: ShardTable, chainId: number, protocol: string, dict: DictView, quarantine: Int32Array): RankShard {
    const capacity = Math.max(table.capacity, Math.ceil(table.slots * (this.deps.headroom ?? 1.1))) + 1024;
    const ckeys = ckeysFor(table, dict);
    const cols = new RankColumns(capacity);
    cols.copyFrom(table, (id) => ckeys.outside(id));
    const cap = cols.arrays.capacity;
    const perms = (): Uint32Array[] => RANK_PERMS.map(() => sharedU32(cap));
    const poolKeys = dict.size + 1;
    const ownerKeys = ckeys.classes.size + 1;
    const holderSize = Math.ceil((dict.size + 2) * 1.5) + 1024;
    return {
      key: shardKey(chainId, protocol),
      chainId,
      protocol,
      instance: ++instanceSerial,
      gen: 1,
      table,
      resets: table.resets,
      cols,
      ckeys,
      perms: [perms(), perms()],
      permCur: 0,
      permLen: RANK_PERMS.map(() => 0),
      pools: [csr(cap, poolKeys), csr(cap, poolKeys)],
      owners: [csr(cap, ownerKeys), csr(cap, ownerKeys)],
      csrCur: 0,
      holders: { positions: new Uint32Array(holderSize), holders: new Uint32Array(holderSize), ambiguous: new Uint8Array(holderSize) },
      dict,
      quarantine,
      lists: new ShardListFlags(),
      classLists: new ClassListFlags(),
      builtAt: this.now(),
    };
  }

  private dropAll(): void {
    for (const shard of this.current?.shards.values() ?? []) this.deps.engine.broadcast('drop', { instanceKey: `rank:${shard.key}#${shard.instance}` });
    this.current = undefined;
  }

  static ref(shard: RankShard): RankShardRef {
    return {
      shard: shard.key,
      chainId: shard.chainId,
      instance: shard.instance,
      gen: shard.gen,
      slots: shard.cols.slots,
      live: shard.cols.live,
      cols: shard.cols.arrays,
      ckeys: shard.ckeys.view(),
      perms: shard.perms[shard.permCur],
      permLen: shard.permLen,
      pool: shard.pools[shard.csrCur],
      owner: shard.owners[shard.csrCur],
    };
  }

  /**
   * Leaves a query reads whose (shard, field) holds a row the engine cannot
   * reproduce MongoDB for (§4.8): an odd value, a foreign chainId / protocol,
   * tokenId ≠ positionId, a non-printable collated string (all R1); a
   * positionId that is not a canonical id, a collated string outside the ckey
   * domain (here). Any → the query goes to Mongo.
   */
  static quarantined(shard: RankShard, leaves: Iterable<number>, collated: boolean): string | undefined {
    for (const leaf of leaves) {
      if (shard.quarantine[leaf] > 0) return `quarantine:${leaf}`;
      if (leaf === RANK_LEAF.positionId && shard.cols.quarantine.pid > 0) return `quarantine:${leaf}`;
      if (collated) {
        const c = RANK_STR_LEAVES.indexOf(leaf);
        if (c >= 0 && shard.cols.quarantine.str[c] > 0) return `quarantine:${leaf}`;
      }
    }
    return undefined;
  }

  /**
   * Does any leaf of the shard hold a quarantined row at the current
   * generation (R1's, a non-canonical positionId, a collated string outside
   * the ckey domain)? Then some queries on it go to Mongo — the warmup must
   * keep its full cycle there (design §3.8). Undefined shard = not built.
   */
  quarantineActive(key: ShardKey): boolean | undefined {
    const shard = this.current?.shards.get(key);
    if (!shard) return undefined;
    return shard.quarantine.some((n) => n > 0) || shard.cols.quarantine.pid > 0 || shard.cols.quarantine.str.some((n) => n > 0);
  }

  /**
   * Bind each shard's compiled plan to `generation` — or throw
   * `RankUnsupported` with why it cannot answer: not built, a missing shard,
   * a quarantined read leaf, a rate sort without A+, a bind refusal. The ONE
   * set of refusals: `answer` runs it, and `refusal` asks it ahead of time.
   */
  private static bind(
    generation: RankGeneration | undefined,
    inputs: RankAnswerShardInput[],
    perm: number,
    materialize: boolean,
  ): Array<{ shard: RankShard; query: RankBoundQuery; scope: RankScope }> {
    if (!generation) throw new RankUnsupported('engine_not_built');
    const spec = RANK_PERMS[perm];
    if (!spec) throw new RankUnsupported('sort');
    const parts: Array<{ shard: RankShard; query: RankBoundQuery; scope: RankScope }> = [];
    for (const input of inputs) {
      const shard = generation.shards.get(input.key);
      if (!shard) throw new RankUnsupported('shard_not_built');
      // Every answer reads positionId (the tie-break and the row fetch) and the identity leaves.
      const read = [...input.plan.leaves, RANK_LEAF.positionId, RANK_LEAF.chainId, RANK_LEAF.protocol];
      // The sort's leaf (the pid permutation's is tokenId: nft order = pid order only while tokenId === positionId).
      if (materialize) read.push(spec.leaf);
      if (input.plan.scopeLiteral?.kind === 'pid') read.push(RANK_LEAF.tokenId);
      const reason = RankEngine.quarantined(shard, read, input.plan.collated);
      if (reason) throw new RankUnsupported(reason);
      // A ranked walk of a rate sort's A+ permutation needs a filter that implies A+.
      if (materialize && spec.aplus && !input.plan.scopeLiteral && !input.plan.aplus) throw new RankUnsupported('rate_sort_without_aplus');
      const bound = bindRankQuery(
        input.plan,
        { dict: shard.table.dict, dictSize: shard.dict.size, ckeys: shard.ckeys, lists: shard.lists, classLists: shard.classLists },
        input.excluded,
      );
      if (!bound.ok) throw new RankUnsupported(bound.reason);
      parts.push({ shard, query: bound.query, scope: bound.scope });
    }
    return parts;
  }

  /**
   * Why `answer(inputs, …)` would refuse at the CURRENT generation (undefined
   * = it would answer): the same checks, synchronously, with no pass. A caller
   * that must commit to the engine before running it (a count task) asks
   * this first, so a refusal goes to Mongo up front instead of failing later.
   */
  refusal(inputs: RankAnswerShardInput[], perm: number, materialize: boolean): string | undefined {
    try {
      RankEngine.bind(this.current, inputs, perm, materialize);
      return undefined;
    } catch (err) {
      if (err instanceof RankUnsupported) return err.reason;
      throw err;
    }
  }

  /**
   * One answer: bind each shard's compiled plan to its current generation,
   * one pass in the engine, materialised order + exact counts. Throws
   * `RankUnsupported` when a shard is missing, reads a quarantined leaf, or
   * the query cannot be bound.
   */
  async answer(
    inputs: RankAnswerShardInput[],
    sort: { perm: number; reverse: boolean },
    options: { materialize?: boolean; affinity?: string } = {},
  ): Promise<RankAnswer> {
    const generation = await this.acquire();
    try {
      if (!generation) throw new RankUnsupported('engine_not_built');
      const materialize = options.materialize ?? true;
      const parts = RankEngine.bind(generation, inputs, sort.perm, materialize);
      const result: RankPassResult = await this.deps.engine.run(
        'rank.pass',
        { shards: parts.map((p) => ({ ref: RankEngine.ref(p.shard), query: p.query, scope: p.scope })), perm: sort.perm, reverse: sort.reverse, materialize },
        { affinity: options.affinity },
      );
      return {
        seq: generation.seq,
        ct: generation.ct,
        ca: generation.ca,
        perm: sort.perm,
        reverse: sort.reverse,
        shards: parts.map(({ shard }) => ({ key: shard.key, chainId: shard.chainId, protocol: shard.protocol, instance: shard.instance, gen: shard.gen })),
        counts: result.n,
        scope: result.scope,
        slots: result.slots ?? new Uint32Array(0),
        ...(result.shard ? { shard: result.shard } : {}),
        computedAt: this.now(),
      };
    } finally {
      this.release();
    }
  }

  /** Is every shard of `answer` still the instance it was computed on? */
  isCurrent(answer: Pick<RankAnswer, 'shards'>): boolean {
    const generation = this.current;
    if (!generation) return false;
    return answer.shards.every((s) => generation.shards.get(s.key)?.instance === s.instance);
  }

  /** The positionId of a slot of an answer's shard (`answer.shards[index]`), from the live instance. */
  pidOf(answer: Pick<RankAnswer, 'shards'>, index: number, slot: number): string | undefined {
    const ref = answer.shards[index];
    const shard = this.current?.shards.get(ref.key);
    if (!shard || shard.instance !== ref.instance) return undefined;
    const a = shard.cols.arrays;
    return a.pc[PID_COL][slot] === PC_PID ? String(a.pv[PID_COL][slot]) : undefined;
  }

  /**
   * Holder counts (`countsByPoolIds` semantics, design §6.6) of `poolIds` on
   * one shard at the current generation: per lowercased poolId, absent = 0/0
   * (as the Mongo path's map); `ambiguous` = pools the engine cannot count
   * exactly (an active row with a null / missing owner) — for Mongo. Undefined
   * when the shard cannot answer at all (not built, quarantined).
   */
  holderCounts(
    chainId: number,
    protocol: string,
    poolIds: readonly string[],
  ): { counts: Map<string, { positionsCount: number; holdersCount: number }>; ambiguous: string[]; ca: number; publishedAt: number } | undefined {
    const generation = this.current;
    const shard = generation?.shards.get(shardKey(chainId, protocol));
    if (!generation || !shard) return undefined;
    if (RankEngine.quarantined(shard, [RANK_LEAF.poolId, RANK_LEAF.owner, RANK_LEAF.isActive, RANK_LEAF.chainId, RANK_LEAF.protocol], false)) return undefined;
    const counts = new Map<string, { positionsCount: number; holdersCount: number }>();
    const ambiguous: string[] = [];
    for (const raw of poolIds) {
      const id = raw.toLowerCase();
      const found = shard.table.dict.find(id);
      if (found < 0 || found >= shard.dict.size) continue; // no such pool: 0/0, absent — as the aggregation
      const key = found + 1;
      const h = shard.holders;
      if (key >= h.positions.length) continue;
      if (h.ambiguous[key] === 1) {
        ambiguous.push(id);
        continue;
      }
      const positionsCount = h.positions[key];
      const holdersCount = h.holders[key];
      if (positionsCount > 0 || holdersCount > 0) counts.set(id, { positionsCount, holdersCount });
    }
    return { counts, ambiguous, ca: generation.ca, publishedAt: generation.publishedAt };
  }

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
      csrRebuilds: this.csrRebuilds,
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
        permLen: Object.fromEntries(RANK_PERMS.map((p, i) => [p.name, s.permLen[i]])),
        dict: s.dict.size,
        classes: s.ckeys.classes.size,
        bytes:
          s.cols.memoryBytes +
          s.perms.flat().reduce((sum, p) => sum + p.byteLength, 0) +
          [...s.pools, ...s.owners].reduce((sum, c) => sum + c.order.byteLength + c.start.byteLength, 0) +
          s.ckeys.memoryBytes +
          s.holders.positions.byteLength * 2 +
          s.holders.ambiguous.byteLength,
        lists: s.lists.size + s.classLists.size,
        pidQuarantine: s.cols.quarantine.pid,
        domainQuarantine: s.cols.quarantine.str.reduce((a, b) => a + b, 0),
        builtAt: new Date(s.builtAt).toISOString(),
      })),
    };
  }
}

/** Would applying `overlay` change a live-before slot's positionId? (Slots must keep their id within an instance.) */
function changesPid(pc: Uint8Array, pv: Uint32Array, slots: number, overlay: RankOverlay): boolean {
  for (let i = 0; i < overlay.n; i++) {
    const slot = overlay.slots[i];
    if (slot >= slots) continue;
    const before = pc[slot] === PC_PID ? pv[slot] : -1;
    const after = overlay.pc[PID_COL][i] === PC_PID ? overlay.pv[PID_COL][i] : -1;
    if (before !== -1 && after !== -1 && before !== after) return true;
  }
  return false;
}
