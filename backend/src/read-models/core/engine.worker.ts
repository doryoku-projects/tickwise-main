import { parentPort, workerData } from 'node:worker_threads';
import { cacheSize, EngineState, handleEngineTask, transferables, type EngineTaskKind } from './engine-tasks.js';

/**
 * A read-model pass worker (design §4.10): runs `engine-tasks.ts` over the
 * shared columns the main thread sends handles to — permutation builds and
 * updates, passes, search. Keeps its own caches (bitsets per generation,
 * search needles per catalog instance). Results (materialised slot lists)
 * are transferred back, not copied. Started by `WorkerEngine`.
 */
const port = parentPort;
if (!port) throw new Error('engine.worker must run as a worker thread');

const options = (workerData ?? {}) as { maxBitBytes?: number };
const state = new EngineState({ maxBitBytes: options.maxBitBytes });

port.on('message', (message: { id: number; kind: EngineTaskKind; input: never }) => {
  try {
    const output = handleEngineTask(state, message.kind, message.input);
    port.postMessage({ id: message.id, ok: true, output, cache: cacheSize(state) }, transferables(output));
  } catch (err) {
    port.postMessage({ id: message.id, ok: false, error: (err as Error)?.stack ?? String(err), cache: cacheSize(state) });
  }
});
