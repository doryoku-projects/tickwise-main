import { Worker } from 'node:worker_threads';
import { FeederCore, type FeederCoreDeps } from './feeder-core.js';
import type { FeederStartOptions, MainCommand, WorkerMessage } from './messages.js';
import type { FeederSource } from './source.js';

/**
 * Where the feeder's Mongo side runs: a worker thread (production — the
 * change stream, the scans, BSON decoding and normalisation never touch the
 * main event loop or the app's Mongo pool, design §2.4) or in-thread
 * (`READ_MODELS_WORKERS=0`: specs, debugging). Same protocol either way.
 */
export interface FeederHost {
  start(options: FeederStartOptions): void;
  send(command: MainCommand): void;
  onMessage(handler: (message: WorkerMessage) => void): void;
  /** Called once when the feeder ends (stopped, fatal, or crashed). */
  onExit(handler: (error?: Error) => void): void;
  stop(): Promise<void>;
}

/** Runs `FeederCore` on this thread; messages cross an async boundary both ways, as they would between threads. */
export class InThreadFeederHost implements FeederHost {
  private core?: FeederCore;
  private handler: (message: WorkerMessage) => void = () => undefined;
  private exitHandler: (error?: Error) => void = () => undefined;
  private running?: Promise<void>;

  constructor(
    private readonly sourceFactory: () => FeederSource,
    private readonly deps: Omit<FeederCoreDeps, 'source' | 'emit'> = {},
  ) {}

  start(options: FeederStartOptions): void {
    const core = new FeederCore({
      ...this.deps,
      source: this.sourceFactory(),
      emit: (message) => queueMicrotask(() => this.handler(message)),
    });
    this.core = core;
    this.running = core.run(options).then(
      () => this.exitHandler(),
      (err) => this.exitHandler(err as Error),
    );
  }

  send(command: MainCommand): void {
    const core = this.core;
    if (core) queueMicrotask(() => core.command(command));
  }

  onMessage(handler: (message: WorkerMessage) => void): void {
    this.handler = handler;
  }

  onExit(handler: (error?: Error) => void): void {
    this.exitHandler = handler;
  }

  /** The core, for specs that drive timers by hand. */
  get feeder(): FeederCore | undefined {
    return this.core;
  }

  async stop(): Promise<void> {
    this.core?.stop();
    await this.running;
  }
}

export interface WorkerHostOptions {
  uri: string;
  /** Old-space limit of the worker (MB). */
  maxOldGenerationSizeMb?: number;
}

/** Runs the feeder in `feeder.worker` (its own isolate, heap limit and Mongo client). */
export class WorkerFeederHost implements FeederHost {
  private worker?: Worker;
  private handler: (message: WorkerMessage) => void = () => undefined;
  private exitHandler: (error?: Error) => void = () => undefined;
  private exited = false;

  constructor(private readonly opts: WorkerHostOptions) {}

  start(options: FeederStartOptions): void {
    const workerData = { uri: this.opts.uri, options };
    const common = { workerData, resourceLimits: { maxOldGenerationSizeMb: this.opts.maxOldGenerationSizeMb ?? 256 }, name: 'tw-feeder' };
    let worker: Worker;
    if (import.meta.url.endsWith('.ts')) {
      // Dev under tsx: a worker does not inherit tsx's loader (neither through the inherited
      // execArgv nor an explicit `--import tsx` — the entry loads, its `.js` → `.ts` imports do
      // not). Register tsx inside the worker first, then import the TypeScript entry.
      const api = import.meta.resolve('tsx/esm/api');
      const entry = new URL('./feeder.worker.ts', import.meta.url).href;
      const boot = `import(${JSON.stringify(api)}).then(({ register }) => { register(); return import(${JSON.stringify(entry)}); });`;
      worker = new Worker(boot, { ...common, eval: true });
    } else {
      worker = new Worker(new URL('./feeder.worker.js', import.meta.url), common);
    }
    this.worker = worker;
    worker.on('message', (message: WorkerMessage) => this.handler(message));
    worker.on('error', (err) => this.finish(err));
    worker.on('exit', (code) => this.finish(code === 0 ? undefined : new Error(`feeder worker exited with code ${code}`)));
  }

  private finish(error?: Error): void {
    if (this.exited) return;
    this.exited = true;
    this.exitHandler(error);
  }

  send(command: MainCommand): void {
    this.worker?.postMessage(command);
  }

  onMessage(handler: (message: WorkerMessage) => void): void {
    this.handler = handler;
  }

  onExit(handler: (error?: Error) => void): void {
    this.exitHandler = handler;
  }

  async stop(): Promise<void> {
    const worker = this.worker;
    if (!worker || this.exited) return;
    worker.postMessage({ type: 'stop' } satisfies MainCommand);
    const exited = new Promise<void>((resolve) => worker.once('exit', () => resolve()));
    const timer = setTimeout(() => void worker.terminate(), 5_000);
    timer.unref?.();
    await exited;
    clearTimeout(timer);
  }
}
