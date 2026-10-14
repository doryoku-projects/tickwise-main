import { parentPort, workerData } from 'node:worker_threads';
import { FeederCore } from './feeder-core.js';
import type { FeederStartOptions, MainCommand } from './messages.js';
import { MongoFeederSource } from './source.js';

/**
 * The feeder worker thread (design §2.4): its own `MongoClient` (`appName
 * tw-feeder`, `maxPoolSize 4`), the change stream, the paced scans and the
 * normalisation, under its own heap limit. Started by `WorkerFeederHost` on
 * the lease holder only; talks to the main thread through `messages.ts`.
 */
const port = parentPort;
if (!port) throw new Error('feeder.worker must run as a worker thread');

const { uri, options } = workerData as { uri: string; options: FeederStartOptions };
const source = new MongoFeederSource({ uri, scanReadPreference: options.scanReadPreference });
const core = new FeederCore({ source, emit: (message) => port.postMessage(message) });
port.on('message', (command: MainCommand) => core.command(command));

core
  .run(options)
  .catch((err) => port.postMessage({ type: 'fatal', reason: 'error', detail: (err as Error)?.message ?? String(err) }))
  .finally(() => port.close());
