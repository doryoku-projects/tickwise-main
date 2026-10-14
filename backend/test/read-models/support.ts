/*
 * Shared wiring for the read-model runtime specs: a runtime per simulated
 * process on one in-memory "Redis", fed by the simulated replica set.
 */
import { expect } from 'vitest';
import { rowsEqual } from '../../src/read-models/core/cells.js';
import { type ReadModelName } from '../../src/read-models/core/fields.js';
import type { ModelStore } from '../../src/read-models/core/model-store.js';
import { InThreadFeederHost } from '../../src/read-models/feeder/feeder-host.js';
import { ReadModelsRuntime } from '../../src/read-models/feeder/feeder.service.js';
import { DEFAULT_HOLDER_CONFIG, type HolderConfig } from '../../src/read-models/feeder/holder.js';
import type { ShardCollection } from '../../src/read-models/feeder/messages.js';
import { normalizeDoc } from '../../src/read-models/feeder/normalize.js';
import { NoopSnapshotSink } from '../../src/read-models/feeder/snapshot-sink.js';
import type { ReadModelMode, ReadModelsRole } from '../../src/read-models/flags.js';
import { rmKeys } from '../../src/read-models/keys.js';
import { AlertLog } from '../../src/read-models/status.js';
import { MemoryModelsTransport, MemoryRedis, MemoryStateTransport } from '../../src/read-models/transport.js';
import type { FakeCluster } from './fake-cluster.js';

export const KEYS = rmKeys('spec');
export const RANK_COLL = '1_uniswap_v4_positions';
export const POOLS_COLL = '1_uniswap_v4_pools';
export const SHARDS: ShardCollection[] = [
  { coll: RANK_COLL, model: 'rank', chainId: 1, protocol: 'uniswap-v4' },
  { coll: POOLS_COLL, model: 'pools', chainId: 1, protocol: 'uniswap-v4' },
];

export const HOLDER_CONFIG: HolderConfig = {
  ...DEFAULT_HOLDER_CONFIG,
  snapshotIntervalMs: 60_000,
  liveTtlMs: 3_600_000,
  batchMs: 30,
  heartbeatMs: 60,
  renewMs: 300,
  feeder: { scanDocsPerSec: 5_000, oplogWindowHintMs: 3_600_000, scanReadPreference: 'secondary', scanBatchSize: 40, scanBufferBytes: 64 * 1024 * 1024 },
};

/** Collects alert names (and runs an optional hook) instead of logging them. */
export class SpecAlerts extends AlertLog {
  readonly names: string[] = [];
  constructor(hook?: (line: string) => void) {
    super({
      warn: (line: string) => {
        hook?.(line);
      },
    });
  }
  override alert(name: string, detail: string): void {
    this.names.push(name.startsWith('read_models.') ? name : `read_models.${name}`);
    super.alert(name, detail);
  }
}

export function makeRuntime(
  redis: MemoryRedis,
  cluster: FakeCluster,
  opts: {
    role?: ReadModelsRole;
    owner?: string;
    alerts?: SpecAlerts;
    modes?: Record<ReadModelName, ReadModelMode>;
    holder?: Partial<HolderConfig>;
    /** A separate redis-state instance (REDIS_MODELS_URL set); default: the same one. */
    stateRedis?: MemoryRedis;
  } = {},
): { runtime: ReadModelsRuntime; alerts: SpecAlerts } {
  const alerts = opts.alerts ?? new SpecAlerts();
  const runtime = new ReadModelsRuntime(
    {
      transport: new MemoryModelsTransport(redis, KEYS),
      state: new MemoryStateTransport(opts.stateRedis ?? redis, KEYS),
      keys: KEYS,
      sink: new NoopSnapshotSink(),
      createHost: () => new InThreadFeederHost(() => cluster, { liveFlushMs: 10, confirmEveryMs: 40, statsEveryMs: 60_000 }),
      alerts,
      owner: opts.owner,
    },
    {
      role: opts.role ?? 'both',
      shards: SHARDS,
      holder: { ...HOLDER_CONFIG, ...opts.holder },
      maxLagMs: 120_000,
      positionsCapacity: 0,
      leaseTtlMs: 1_000,
      leaseRetryMs: 100,
      oplogRetryMs: 60_000,
    },
    opts.modes ?? { rank: 'shadow', pools: 'shadow' },
  );
  return { runtime, alerts };
}

/** The model of `coll` equals the cluster's current documents, normalised. */
export function expectModelEqualsCluster(store: ModelStore, cluster: FakeCluster, coll: string, model: ReadModelName): void {
  const table = store.table(model, '1:uniswap-v4');
  expect(table, `${model} table`).toBeDefined();
  const docs = cluster.liveDocs(coll);
  const mismatches: string[] = [];
  for (const { oid, doc } of docs) {
    const slot = table!.liveSlotOf(oid);
    if (slot < 0) {
      mismatches.push(`${oid} missing`);
      continue;
    }
    if (!rowsEqual(table!.cellsAt(slot), normalizeDoc(model, doc))) mismatches.push(`${oid} differs`);
  }
  expect(mismatches.slice(0, 5)).toEqual([]);
  expect(table!.live).toBe(docs.length);
}

/** Wait until the holder has applied everything up to the cluster's current time and confirmed it. */
export async function settled(runtime: ReadModelsRuntime, cluster: FakeCluster, timeout = 8_000): Promise<void> {
  const target = cluster.now();
  const started = Date.now();
  for (;;) {
    const holder = runtime.holder;
    if (holder && holder.phase === 'running' && holder.caughtUp() && holder.pendingRows === 0 && compare(holder.latestCt, target) >= 0) {
      // One more confirm round so the last batch is appended.
      await sleep(80);
      if (runtime.holder?.pendingRows === 0) return;
    }
    if (Date.now() - started > timeout) throw new Error(`not settled: phase=${runtime.phase} holder=${holder?.phase} pending=${holder?.pendingRows} ct=${holder?.latestCt} target=${target.t}:${target.i}`);
    await sleep(20);
  }
}

function compare(ct: string, target: { t: number; i: number }): number {
  const [t, i] = ct.split(':').map(Number);
  return t !== target.t ? t - target.t : i - target.i;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitUntil(condition: () => boolean, timeout = 8_000, what = 'condition'): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

/** A seeded PRNG. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export { MemoryRedis };
