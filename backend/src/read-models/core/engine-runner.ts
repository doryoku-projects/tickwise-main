import { Worker } from 'node:worker_threads';
import { cacheSize, EngineState, handleEngineTask, type EngineCacheSize, type EngineTaskKind, type EngineTaskMap } from './engine-tasks.js';
import { tsWorkerBootstrap } from './worker-bootstrap.js';

/**
 * Where the engines' CPU work runs (design §4.10): `READ_MODELS_WORKERS`
 * pass workers, or — with 0 — the main thread (specs, debugging).
 *
 * Admission: at most `maxQueued` tasks wait (across workers); a task that has
 * not STARTED within its deadline (default 2 s) is refused with
 * `EngineOverloadError` AT its deadline (a timer per queued task — not when a
 * slot frees up), never run late. The caller answers an overload from a stale
 * cached answer or with a 503 + Retry-After — never by sending the request to
 * Mongo, which is exactly when Mongo can least take it.
 * `affinity` PREFERS one worker for related tasks so its caches (a search
 * needle's per-entry results, a generation's bitsets) are reused — but a task
 * whose preferred worker is busy goes to an idle one rather than wait.
 * A task running past `runTimeoutMs` (default 30 s) has its worker terminated
 * and replaced, and is failed with `EngineTaskTimeoutError` — a stuck pass
 * must not hold a worker, a generation swap and every request behind it.
 * A worker that dies fails its running task and is replaced.
 *
 * GENERATION tasks (`pools.build` / `pools.update` / `rank.build` /
 * `rank.update`, `isGenerationTask`) are admitted past `maxQueued`, go to the
 * HEAD of their worker's queue (ahead of user passes, behind a running task)
 * and run under `GENERATION_RUN_TIMEOUT_MS` (5 min) instead of `runTimeoutMs`:
 * a refused build leaves the model's data ageing until the engine accepts one,
 * which is exactly when users are busiest — and a full-size build is not a
 * stuck pass.
 */

export class EngineOverloadError extends Error {
  constructor(readonly reason: 'queue_full' | 'deadline' | 'stopped') {
    super(`read-model engine overloaded (${reason})`);
    this.name = 'EngineOverloadError';
  }
}

/** A task ran past the runner's `runTimeoutMs`: its worker was terminated and replaced. */
export class EngineTaskTimeoutError extends Error {
  constructor(readonly kind: string, readonly ms: number) {
    super(`read-model engine task ${kind} ran past ${ms} ms — worker replaced`);
    this.name = 'EngineTaskTimeoutError';
  }
}

export interface RunOptions {
  /** Same affinity → same worker. */
  affinity?: string;
  /** How long the task may wait to START (ms). */
  deadlineMs?: number;
}

export interface EngineRunner {
  readonly kind: 'in-thread' | 'workers';
  run<K extends EngineTaskKind>(kind: K, input: EngineTaskMap[K]['input'], options?: RunOptions): Promise<EngineTaskMap[K]['output']>;
  /** Run on every engine (cache invalidation); errors are ignored. */
  broadcast<K extends EngineTaskKind>(kind: K, input: EngineTaskMap[K]['input']): void;
  stats(): EngineRunnerStats;
  stop(): Promise<void>;
}

export interface EngineRunnerStats {
  kind: 'in-thread' | 'workers';
  workers: number;
  queued: number;
  running: number;
  tasks: number;
  refused: number;
  failed: number;
  restarts: number;
  /** Queue wait and run time of recent tasks (ms). */
  waitP99Ms: number;
  runP99Ms: number;
  /** Tasks failed by the run timeout (their worker replaced). */
  timedOut?: number;
  /** The engines' bitset / needle caches (summed over workers, as of each one's last task). */
  cache?: EngineCacheSize;
}

const DEFAULT_DEADLINE_MS = 2_000;
const DEFAULT_RUN_TIMEOUT_MS = 30_000;
/** A generation task's run timeout (a 4M-row build is long, not stuck). */
export const GENERATION_RUN_TIMEOUT_MS = 5 * 60_000;

/** The generation steps (builds / updates of a model's permutations): never refused for a full queue, first in line. */
export function isGenerationTask(kind: string): boolean {
  return kind === 'pools.build' || kind === 'pools.update' || kind === 'rank.build' || kind === 'rank.update';
}

class Timings {
  private readonly values: number[] = [];
  add(ms: number): void {
    this.values.push(ms);
    if (this.values.length > 512) this.values.splice(0, this.values.length - 512);
  }
  p99(): number {
    if (this.values.length === 0) return 0;
    const sorted = [...this.values].sort((a, b) => a - b);
    return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))] * 10) / 10;
  }
}

/** The main thread runs every task itself (`READ_MODELS_WORKERS=0`). */
export class InThreadEngine implements EngineRunner {
  readonly kind = 'in-thread' as const;
  readonly state: EngineState;
  private tasks = 0;
  private failed = 0;
  private readonly runTimes = new Timings();

  constructor(opts: { maxBitBytes?: number } = {}) {
    this.state = new EngineState(opts);
  }

  async run<K extends EngineTaskKind>(kind: K, input: EngineTaskMap[K]['input']): Promise<EngineTaskMap[K]['output']> {
    // An async boundary, as with a worker: callers never depend on synchronous completion.
    await Promise.resolve();
    const started = performance.now();
    this.tasks++;
    try {
      return handleEngineTask(this.state, kind, input);
    } catch (err) {
      this.failed++;
      throw err;
    } finally {
      this.runTimes.add(performance.now() - started);
    }
  }

  broadcast<K extends EngineTaskKind>(kind: K, input: EngineTaskMap[K]['input']): void {
    try {
      handleEngineTask(this.state, kind, input);
    } catch {
      // cache invalidation only
    }
  }

  stats(): EngineRunnerStats {
    return {
      kind: this.kind,
      workers: 0,
      queued: 0,
      running: 0,
      tasks: this.tasks,
      refused: 0,
      failed: this.failed,
      restarts: 0,
      waitP99Ms: 0,
      runP99Ms: this.runTimes.p99(),
      cache: cacheSize(this.state),
    };
  }

  async stop(): Promise<void> {}
}

interface Pending {
  id: number;
  kind: EngineTaskKind;
  input: unknown;
  enqueuedAt: number;
  deadlineAt: number;
  startedAt?: number;
  /** Rejects the task at `deadlineAt` while it waits (cleared when it starts). */
  timer?: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

interface Slot {
  worker?: Worker;
  queue: Pending[];
  running?: Pending;
  /** Terminates the worker if its running task outlives `runTimeoutMs`. */
  runTimer?: ReturnType<typeof setTimeout>;
  ready: boolean;
  cache?: EngineCacheSize;
}

type WorkerReply = ({ id: number; ok: true; output: unknown } | { id: number; ok: false; error: string }) & { cache?: EngineCacheSize };

export interface WorkerEngineOptions {
  workers: number;
  maxQueued?: number;
  /** Old-space limit per worker (MB). */
  maxOldGenerationSizeMb?: number;
  /** Bitset cache per worker (bytes). */
  maxBitBytes?: number;
  /** A running task past this (ms) has its worker terminated and replaced (default 30 s). */
  runTimeoutMs?: number;
  onAlert?: (name: string, detail: string) => void;
  now?: () => number;
}

/** `READ_MODELS_WORKERS` pass workers (`engine.worker.ts`), one task at a time each. */
export class WorkerEngine implements EngineRunner {
  readonly kind = 'workers' as const;
  private readonly slots: Slot[];
  private nextId = 1;
  private stopped = false;
  private tasks = 0;
  private refused = 0;
  private failed = 0;
  private restarts = 0;
  private timedOut = 0;
  private readonly waitTimes = new Timings();
  private readonly runTimes = new Timings();
  private readonly now: () => number;

  constructor(private readonly opts: WorkerEngineOptions) {
    this.now = opts.now ?? Date.now;
    this.slots = Array.from({ length: Math.max(1, opts.workers) }, () => ({ queue: [], ready: false }));
    this.slots.forEach((slot) => this.spawn(slot));
  }

  private spawn(slot: Slot): void {
    if (this.stopped) return;
    const workerData = { maxBitBytes: this.opts.maxBitBytes };
    const common = { workerData, resourceLimits: { maxOldGenerationSizeMb: this.opts.maxOldGenerationSizeMb ?? 128 }, name: 'tw-engine' };
    let worker: Worker;
    if (import.meta.url.endsWith('.ts')) {
      // Dev / specs from TypeScript sources: register tsx inside the worker first (`worker-bootstrap.ts`).
      worker = new Worker(tsWorkerBootstrap(new URL('./engine.worker.ts', import.meta.url).href), { ...common, eval: true });
    } else {
      worker = new Worker(new URL('./engine.worker.js', import.meta.url), common);
    }
    slot.worker = worker;
    slot.ready = true;
    slot.cache = undefined;
    worker.on('message', (reply: WorkerReply) => this.onReply(slot, reply));
    const fail = (err: Error) => this.retire(slot, worker, err, `engine worker died: ${err.message} — replacing it`);
    worker.on('error', fail);
    worker.on('exit', (code) => fail(new Error(`engine worker exited with code ${code}`)));
  }

  /** Take `worker` out of `slot`, fail its running task with `err`, and replace it (unless stopped). */
  private retire(slot: Slot, worker: Worker, err: Error, alert: string): void {
    if (slot.worker !== worker) return;
    slot.worker = undefined;
    slot.ready = false;
    slot.cache = undefined;
    if (slot.runTimer) clearTimeout(slot.runTimer);
    slot.runTimer = undefined;
    const running = slot.running;
    slot.running = undefined;
    if (running) {
      this.failed++;
      running.reject(err);
    }
    if (this.stopped) return;
    this.restarts++;
    this.opts.onAlert?.('read_models.worker_failed', alert);
    // Its queued tasks may go to another worker now (their own timers still bound the wait).
    for (const other of this.slots) if (other !== slot) this.pump(other);
    setTimeout(() => {
      this.spawn(slot);
      this.pump(slot);
    }, 250).unref?.();
  }

  private onReply(slot: Slot, reply: WorkerReply): void {
    const task = slot.running;
    if (!task || task.id !== reply.id) return;
    if (slot.runTimer) clearTimeout(slot.runTimer);
    slot.runTimer = undefined;
    if (reply.cache) slot.cache = reply.cache;
    slot.running = undefined;
    this.runTimes.add(this.now() - (task.startedAt ?? this.now()));
    if (reply.ok) task.resolve(reply.output);
    else {
      this.failed++;
      task.reject(new Error(reply.error));
    }
    this.pump(slot);
  }

  private queued(): number {
    return this.slots.reduce((sum, slot) => sum + slot.queue.length, 0);
  }

  private static load(slot: Slot): number {
    // A slot with no worker (being replaced) is the last resort.
    return slot.queue.length + (slot.running ? 1 : 0) + (slot.worker ? 0 : 1_000);
  }

  /**
   * The slot for a task: the affinity's slot when it is free (its caches are
   * there), else the least-loaded one — a task never waits behind a busy
   * worker while another sits idle.
   */
  private pick(affinity?: string): Slot {
    if (affinity !== undefined) {
      let h = 0;
      for (let i = 0; i < affinity.length; i++) h = (Math.imul(h, 31) + affinity.charCodeAt(i)) | 0;
      const preferred = this.slots[Math.abs(h) % this.slots.length];
      if (WorkerEngine.load(preferred) === 0) return preferred;
      const least = this.leastLoaded();
      return WorkerEngine.load(least) < WorkerEngine.load(preferred) ? least : preferred;
    }
    return this.leastLoaded();
  }

  private leastLoaded(): Slot {
    let best = this.slots[0];
    for (const slot of this.slots) if (WorkerEngine.load(slot) < WorkerEngine.load(best)) best = slot;
    return best;
  }

  run<K extends EngineTaskKind>(kind: K, input: EngineTaskMap[K]['input'], options: RunOptions = {}): Promise<EngineTaskMap[K]['output']> {
    if (this.stopped) return Promise.reject(new EngineOverloadError('stopped'));
    const generation = isGenerationTask(kind);
    if (!generation && this.queued() >= (this.opts.maxQueued ?? 64)) {
      this.refused++;
      return Promise.reject(new EngineOverloadError('queue_full'));
    }
    const slot = this.pick(options.affinity);
    return new Promise((resolve, reject) => {
      const now = this.now();
      const deadlineMs = Math.max(0, options.deadlineMs ?? DEFAULT_DEADLINE_MS);
      const task: Pending = {
        id: this.nextId++,
        kind,
        input,
        enqueuedAt: now,
        deadlineAt: now + deadlineMs,
        resolve: resolve as (value: unknown) => void,
        reject,
      };
      // A generation task goes ahead of the user passes waiting on its worker
      // (behind other generation tasks, in order).
      if (generation) {
        let at = 0;
        while (at < slot.queue.length && isGenerationTask(slot.queue[at].kind)) at++;
        slot.queue.splice(at, 0, task);
      } else slot.queue.push(task);
      this.pump(slot);
      if (task.startedAt === undefined) {
        // Refused AT its deadline if it has not started by then — not whenever its slot frees up.
        task.timer = setTimeout(() => this.expire(slot, task), deadlineMs + 1);
        task.timer.unref?.();
      }
    });
  }

  /** A queued task's deadline passed before it started: take it out of the queue and refuse it. */
  private expire(slot: Slot, task: Pending): void {
    task.timer = undefined;
    if (task.startedAt !== undefined) return;
    const at = slot.queue.indexOf(task);
    if (at < 0) return;
    slot.queue.splice(at, 1);
    this.refused++;
    task.reject(new EngineOverloadError('deadline'));
  }

  private pump(slot: Slot): void {
    if (slot.running || !slot.worker || !slot.ready) return;
    for (;;) {
      const task = slot.queue.shift();
      if (!task) return;
      if (task.timer) clearTimeout(task.timer);
      task.timer = undefined;
      const now = this.now();
      if (now > task.deadlineAt) {
        this.refused++;
        task.reject(new EngineOverloadError('deadline'));
        continue;
      }
      task.startedAt = now;
      this.waitTimes.add(now - task.enqueuedAt);
      this.tasks++;
      slot.running = task;
      const worker = slot.worker;
      worker.postMessage({ id: task.id, kind: task.kind, input: task.input });
      if (Number.isFinite(task.deadlineAt)) {
        // Broadcasts (cache drops, deadline ∞) are not timed; every request / build task is.
        const base = this.opts.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
        const runTimeoutMs = isGenerationTask(task.kind) ? Math.max(base, GENERATION_RUN_TIMEOUT_MS) : base;
        slot.runTimer = setTimeout(() => {
          if (slot.running !== task || slot.worker !== worker) return;
          this.timedOut++;
          this.retire(slot, worker, new EngineTaskTimeoutError(task.kind, runTimeoutMs), `engine task ${task.kind} ran past ${runTimeoutMs} ms — worker terminated and replaced`);
          void worker.terminate().catch(() => undefined);
        }, runTimeoutMs);
        slot.runTimer.unref?.();
      }
      return;
    }
  }

  broadcast<K extends EngineTaskKind>(kind: K, input: EngineTaskMap[K]['input']): void {
    for (const slot of this.slots) {
      if (!slot.worker) continue;
      const pending: Pending = {
        id: this.nextId++,
        kind,
        input,
        enqueuedAt: this.now(),
        deadlineAt: Number.POSITIVE_INFINITY,
        resolve: () => undefined,
        reject: () => undefined,
      };
      slot.queue.push(pending);
      this.pump(slot);
    }
  }

  stats(): EngineRunnerStats {
    return {
      kind: this.kind,
      workers: this.slots.filter((slot) => slot.worker).length,
      queued: this.queued(),
      running: this.slots.filter((slot) => slot.running).length,
      tasks: this.tasks,
      refused: this.refused,
      failed: this.failed,
      restarts: this.restarts,
      waitP99Ms: this.waitTimes.p99(),
      runP99Ms: this.runTimes.p99(),
      timedOut: this.timedOut,
      cache: this.slots.reduce<EngineCacheSize>(
        (sum, slot) => ({
          bitBytes: sum.bitBytes + (slot.cache?.bitBytes ?? 0),
          bitsets: sum.bitsets + (slot.cache?.bitsets ?? 0),
          needles: sum.needles + (slot.cache?.needles ?? 0),
        }),
        { bitBytes: 0, bitsets: 0, needles: 0 },
      ),
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all(
      this.slots.map(async (slot) => {
        if (slot.runTimer) clearTimeout(slot.runTimer);
        slot.runTimer = undefined;
        for (const task of slot.queue.splice(0)) {
          if (task.timer) clearTimeout(task.timer);
          task.reject(new EngineOverloadError('stopped'));
        }
        const running = slot.running;
        slot.running = undefined;
        running?.reject(new EngineOverloadError('stopped'));
        const worker = slot.worker;
        slot.worker = undefined;
        if (worker) await worker.terminate().catch(() => undefined);
      }),
    );
  }
}

/** The runner for `READ_MODELS_WORKERS`. */
export function createEngineRunner(workers: number, opts: Omit<WorkerEngineOptions, 'workers'> = {}): EngineRunner {
  return workers > 0 ? new WorkerEngine({ ...opts, workers }) : new InThreadEngine({ maxBitBytes: opts.maxBitBytes });
}
