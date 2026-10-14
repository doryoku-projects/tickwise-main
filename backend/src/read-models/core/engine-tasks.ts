import type { DictView, PoolColumnArrays, PoolOverlay } from '../pools/pool-columns.js';
import { PoolPassCache, runPoolPass, type PoolPassResult, type PoolPassTask } from '../pools/pool-pass.js';
import { buildPoolPerms, updatePoolPerms } from '../pools/pool-perms.js';
import { RankPassCache, runRankPass, type RankPassResult, type RankPassTask } from '../rank/rank-pass.js';
import { buildRank, updateRank, type RankBuildResult, type RankBuildTask, type RankUpdateResult, type RankUpdateTask } from '../rank/rank-perms.js';

/**
 * The engines' CPU work, as tasks a pass worker (`engine.worker.ts`) or the
 * main thread (`READ_MODELS_WORKERS=0`, specs) runs with the same code. Every
 * input is plain data or shared memory, so a task message carries handles to
 * the shared columns, never copies of them. R2 = `pools.*`, R3 = `rank.*`.
 */

export interface PoolBuildTask {
  cols: PoolColumnArrays;
  dict: DictView;
  slots: number;
  out: Uint32Array[];
}

export interface PoolUpdateTask {
  cols: PoolColumnArrays;
  dict: DictView;
  overlay: PoolOverlay;
  prev: Uint32Array[];
  prevLen: number;
  out: Uint32Array[];
}

export interface EngineTaskMap {
  'pools.pass': { input: PoolPassTask; output: PoolPassResult };
  'pools.build': { input: PoolBuildTask; output: { length: number } };
  'pools.update': { input: PoolUpdateTask; output: { length: number } };
  'rank.pass': { input: RankPassTask; output: RankPassResult };
  'rank.build': { input: RankBuildTask; output: RankBuildResult };
  'rank.update': { input: RankUpdateTask; output: RankUpdateResult };
  /** Forget an instance's cached bitsets / needles (rebuilt or dropped). Rank instance keys start `rank:`. */
  'drop': { input: { instanceKey: string }; output: { dropped: true } };
  /** Busy-wait `ms` on the engine (specs: a task that holds its worker). */
  'spin': { input: { ms: number }; output: { spunMs: number } };
  /** Both caches' sizes (bitsets, bytes, needles, hits / misses). */
  'stats': { input: Record<string, never>; output: { pools: PoolPassCache['stats']; rank: RankPassCache['stats'] } };
}

export type EngineTaskKind = keyof EngineTaskMap;

/**
 * Bitset cache per engine per model (bytes) when none is configured. Each
 * worker holds one per model, so with `READ_MODELS_WORKERS=2` that is 64 MB
 * of off-heap bitsets per process — inside design §11's budget (~40 MB rank,
 * part of 80 MB pools). The pool cache's own default (64 MB each) put 256 MB
 * per process, filled by retired generations.
 */
export const DEFAULT_ENGINE_BIT_BYTES = 16 * 1024 * 1024;

/** One engine's state between tasks (a worker's, or the in-thread one's). */
export class EngineState {
  readonly pools: PoolPassCache;
  readonly rank: RankPassCache;

  constructor(opts: { maxBitBytes?: number; maxNeedles?: number } = {}) {
    const maxBitBytes = opts.maxBitBytes ?? DEFAULT_ENGINE_BIT_BYTES;
    this.pools = new PoolPassCache(maxBitBytes, opts.maxNeedles);
    this.rank = new RankPassCache(maxBitBytes, 1);
  }
}

export function handleEngineTask<K extends EngineTaskKind>(state: EngineState, kind: K, input: EngineTaskMap[K]['input']): EngineTaskMap[K]['output'] {
  switch (kind) {
    case 'pools.pass':
      return runPoolPass(input as PoolPassTask, state.pools) as EngineTaskMap[K]['output'];
    case 'pools.build': {
      const task = input as PoolBuildTask;
      return { length: buildPoolPerms(task.cols, task.dict, task.slots, task.out) } as EngineTaskMap[K]['output'];
    }
    case 'pools.update': {
      const task = input as PoolUpdateTask;
      return { length: updatePoolPerms(task.cols, task.dict, task.overlay, task.prev, task.prevLen, task.out) } as EngineTaskMap[K]['output'];
    }
    case 'rank.pass':
      return runRankPass(input as RankPassTask, state.rank) as EngineTaskMap[K]['output'];
    case 'rank.build':
      return buildRank(input as RankBuildTask) as EngineTaskMap[K]['output'];
    case 'rank.update':
      return updateRank(input as RankUpdateTask) as EngineTaskMap[K]['output'];
    case 'drop': {
      const key = (input as { instanceKey: string }).instanceKey;
      if (key.startsWith('rank:')) state.rank.dropInstance(key);
      else state.pools.dropInstance(key);
      return { dropped: true } as EngineTaskMap[K]['output'];
    }
    case 'spin': {
      const started = Date.now();
      const ms = Math.max(0, Math.min(600_000, Number((input as { ms: number }).ms) || 0));
      while (Date.now() - started < ms) {
        // hold the thread
      }
      return { spunMs: Date.now() - started } as EngineTaskMap[K]['output'];
    }
    case 'stats':
      return { pools: state.pools.stats, rank: state.rank.stats } as EngineTaskMap[K]['output'];
    default:
      throw new Error(`unknown engine task ${String(kind)}`);
  }
}

/** An engine's cache footprint (reported with every worker reply → the runner's stats → status). */
export interface EngineCacheSize {
  bitBytes: number;
  bitsets: number;
  needles: number;
}

export function cacheSize(state: EngineState): EngineCacheSize {
  const pools = state.pools.stats;
  const rank = state.rank.stats;
  return { bitBytes: pools.bitBytes + rank.bitBytes, bitsets: pools.bitsets + rank.bitsets, needles: pools.needles + rank.needles };
}

/** The ArrayBuffers of a result that may be transferred (not shared memory). */
export function transferables(output: unknown): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  if (output && typeof output === 'object') {
    for (const value of Object.values(output as Record<string, unknown>)) {
      if (ArrayBuffer.isView(value) && value.buffer instanceof ArrayBuffer && !out.includes(value.buffer)) out.push(value.buffer);
    }
  }
  return out;
}
