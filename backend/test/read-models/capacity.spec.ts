/*
 * READ_MODELS_POSITIONS_CAPACITY per chain (audit C-cap). A plain number keeps
 * today's meaning (every positions table reserves it); `chainId:rows,…`
 * reserves only the listed chains' tables (unlisted = today's growth);
 * garbage fails the boot. The runtime's create AND load paths, the status and
 * the memory guard's reservation report all resolve per shard.
 */
import 'reflect-metadata';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppConfigService } from '../../src/config/app-config.service.js';
import { capacityReport, createCapacity, describeCapacity, loadCapacity, rankEngineRowBytes, rankRowBytes, reservedRows } from '../../src/read-models/capacity.js';
import { RankColumns } from '../../src/read-models/rank/rank-columns.js';
import { ShardTable } from '../../src/read-models/core/row-store.js';
import { ModelStore } from '../../src/read-models/core/model-store.js';
import { encodeCells } from '../../src/read-models/core/row-store.js';
import { ReadModelsRuntime } from '../../src/read-models/feeder/feeder.service.js';
import { InThreadFeederHost } from '../../src/read-models/feeder/feeder-host.js';
import type { ShardCollection } from '../../src/read-models/feeder/messages.js';
import { normalizeDoc } from '../../src/read-models/feeder/normalize.js';
import { NoopSnapshotSink } from '../../src/read-models/feeder/snapshot-sink.js';
import { writeSnapshotSet } from '../../src/read-models/feeder/snapshot-store.js';
import { ReadModelsService } from '../../src/read-models/read-models.service.js';
import { MemoryModelsTransport, MemoryRedis, MemoryStateTransport } from '../../src/read-models/transport.js';
import { poolDoc, positionDoc } from './fake-cluster.js';
import { HOLDER_CONFIG, KEYS, SpecAlerts } from './support.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const ETH = '1:uniswap-v4';
const RH = '4663:uniswap-v4';

describe('READ_MODELS_POSITIONS_CAPACITY — config', () => {
  const read = (value?: string) => {
    if (value !== undefined) vi.stubEnv('READ_MODELS_POSITIONS_CAPACITY', value);
    return new AppConfigService().readModelsPositionsCapacity;
  };

  it('unset / blank / 0 = no reservation (today)', () => {
    expect(read()).toBe(0);
    expect(read('')).toBe(0);
    expect(read('0')).toBe(0);
  });

  it('a plain number keeps its meaning (Number semantics, floored)', () => {
    expect(read('6000000')).toBe(6_000_000);
    expect(read(' 600000 ')).toBe(600_000);
    expect(read('1.5e6')).toBe(1_500_000);
    expect(read('1024.9')).toBe(1024);
  });

  it('a per-chain map parses to { perChain } (spaces tolerated)', () => {
    expect(read('4663:6000000,1:600000')).toEqual({ perChain: { 4663: 6_000_000, 1: 600_000 } });
    expect(read(' 4663 : 6000000 , 1:600000 ')).toEqual({ perChain: { 4663: 6_000_000, 1: 600_000 } });
    expect(read('4663:0')).toEqual({ perChain: { 4663: 0 } });
  });

  it.each([
    ['abc'],
    ['-5'],
    ['Infinity'],
    ['4663:'],
    [':6000000'],
    ['4663:abc'],
    ['4663:-1'],
    ['4663:6000000,'],
    ['4663:6000000,600000'],
    ['4663:6000000:1'],
    ['999999:5'],
    ['1:5,1:6'],
    ['4663:1e6'],
    ['4663:99999999999999999999'],
  ])('garbage %j fails the boot with a message naming the variable', (value) => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
    vi.stubEnv('READ_MODELS_POSITIONS_CAPACITY', value);
    expect(() => new AppConfigService()).toThrow(/Invalid positions-backend configuration/);
    expect(errors.join('\n')).toMatch(/READ_MODELS_POSITIONS_CAPACITY must be a row count/);
  });

  it('names the offending part: an unknown chain, a repeated chain', () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(JSON.stringify(args));
    });
    vi.stubEnv('READ_MODELS_POSITIONS_CAPACITY', '999999:5');
    expect(() => new AppConfigService()).toThrow();
    expect(errors.join('\n')).toMatch(/chain 999999 is not a known chain/);
    vi.stubEnv('READ_MODELS_POSITIONS_CAPACITY', '1:5,1:6');
    expect(() => new AppConfigService()).toThrow();
    expect(errors.join('\n')).toMatch(/chain 1 is listed twice/);
  });
});

describe('per-shard resolution', () => {
  const map = { perChain: { 4663: 6_000_000 } };

  it('a plain number reserves EVERY positions table (today), never a pools table', () => {
    expect(reservedRows(6_000_000, ETH)).toBe(6_000_000);
    expect(reservedRows(6_000_000, RH)).toBe(6_000_000);
    expect(createCapacity(6_000_000, 'rank', ETH)).toBe(6_000_000);
    expect(createCapacity(6_000_000, 'pools', ETH)).toBe(1024);
    expect(loadCapacity(6_000_000, 'rank', ETH, 100)).toBe(6_000_000);
    expect(loadCapacity(6_000_000, 'rank', ETH, 7_000_000)).toBe(7_000_000);
  });

  it('0 = today: create 1024, load 1.5 × rows + 16 (rank) / 1.25 × rows + 16 (pools)', () => {
    expect(createCapacity(0, 'rank', RH)).toBe(1024);
    expect(loadCapacity(0, 'rank', RH, 1000)).toBe(1516);
    expect(loadCapacity(0, 'pools', RH, 1000)).toBe(1266);
  });

  it('a map reserves only the listed chain; an unlisted chain grows as today', () => {
    expect(reservedRows(map, RH)).toBe(6_000_000);
    expect(reservedRows(map, '4663:other-protocol')).toBe(6_000_000);
    expect(reservedRows(map, ETH)).toBe(0);
    expect(createCapacity(map, 'rank', RH)).toBe(6_000_000);
    expect(createCapacity(map, 'rank', ETH)).toBe(1024);
    expect(createCapacity(map, 'pools', RH)).toBe(1024);
    expect(loadCapacity(map, 'rank', RH, 10)).toBe(6_000_000);
    expect(loadCapacity(map, 'rank', ETH, 1000)).toBe(1516);
  });

  it('a 0 entry in the map is "no reservation" for that chain', () => {
    expect(createCapacity({ perChain: { 4663: 0 } }, 'rank', RH)).toBe(1024);
  });

  it('describes itself for the status', () => {
    expect(describeCapacity(0)).toEqual({ mode: 'growth' });
    expect(describeCapacity(6_000_000)).toEqual({ mode: 'every_table', rows: 6_000_000 });
    expect(describeCapacity(map)).toEqual({ mode: 'per_chain', perChain: { 4663: 6_000_000 } });
  });

  it('the report sums only the reserved shards and compares them with the cap', () => {
    const perRow = rankRowBytes();
    expect(perRow).toBeGreaterThan(50);
    const plain = capacityReport(1_000_000, [ETH, RH, '42161:uniswap-v4', '43114:uniswap-v4'], undefined, false);
    expect(plain.reservedRows).toBe(4_000_000);
    expect(Object.keys(plain.shards)).toHaveLength(4);
    expect(plain.capMb).toBeNull();
    expect(plain.overCap).toBe(false);
    expect(plain.overReload).toBe(false);
    const perChain = capacityReport({ perChain: { 4663: 1_000_000 } }, [ETH, RH, '42161:uniswap-v4', '43114:uniswap-v4'], undefined, false);
    expect(perChain.reservedRows).toBe(1_000_000);
    expect(perChain.shards).toEqual({ [RH]: 1_000_000 });
    expect(perChain.estimatedMb).toBe(Math.round((1_000_000 * perRow) / 1_048_576));
    expect(perChain).toMatchObject({ engine: false, engineMb: 0, r1Mb: perChain.estimatedMb });
    // The plain value reserves four times what the per-chain one does.
    expect(plain.estimatedMb).toBeGreaterThan(3 * perChain.estimatedMb);
    const cap = 1_000_000 * perRow + 1;
    expect(capacityReport({ perChain: { 4663: 1_000_000 } }, [ETH, RH], cap, false).overCap).toBe(false);
    expect(capacityReport(1_000_000, [ETH, RH], cap, false).overCap).toBe(true);
    expect(capacityReport(0, [ETH, RH], 1).overCap).toBe(false);
    expect(capacityReport(0, [ETH, RH], 1).overReload).toBe(false);
  });

  it('the rank engine copy is counted (review fix): it costs ~1.2 × the R1 row, measured from the real columns', () => {
    const r1 = rankRowBytes();
    const engine = rankEngineRowBytes();
    // The engine's copy: RankColumns + A/B permutations + A/B pool and owner CSRs, at the table's capacity.
    const cols = (new RankColumns(4096).memoryBytes - new RankColumns(2048).memoryBytes) / 2048;
    expect(engine).toBeGreaterThan(cols);
    expect(engine).toBeGreaterThan(r1);
    expect(engine).toBeLessThan(2 * r1);
    // R1's own per-row figure agrees with a real table at another size.
    expect(r1).toBeCloseTo((new ShardTable('rank', RH, 8192).memoryBytes - new ShardTable('rank', RH, 4096).memoryBytes) / 4096, 3);

    const withEngine = capacityReport({ perChain: { 4663: 1_000_000 } }, [ETH, RH], undefined);
    expect(withEngine.engine).toBe(true);
    expect(withEngine.r1Mb).toBe(Math.round((1_000_000 * r1) / 1_048_576));
    expect(withEngine.engineMb).toBe(Math.round((1_000_000 * engine) / 1_048_576));
    expect(withEngine.estimatedMb).toBe(Math.round((1_000_000 * (r1 + engine)) / 1_048_576));
    // No engine on this replica (a feeder): R1 only.
    const feeder = capacityReport({ perChain: { 4663: 1_000_000 } }, [ETH, RH], undefined, false);
    expect(feeder.engineMb).toBe(0);
    expect(feeder.estimatedMb).toBe(withEngine.r1Mb);
  });

  it('the plain 6,000,000 on four positions shards against the 8,000 MB cap is flagged (it used to report ~3.1 GB and stay silent)', () => {
    const MB = 1_048_576;
    const four = [ETH, RH, '42161:uniswap-v4', '43114:uniswap-v4'];
    const plain = capacityReport(6_000_000, four, 8_000 * MB);
    // ~7 GB: R1 (~0.8 GB) + engine (~1 GB) per table, four tables.
    expect(plain.estimatedMb).toBeGreaterThan(0.7 * 8_000);
    expect(plain.estimatedMb).toBeGreaterThan(2 * plain.r1Mb);
    expect(plain.overReload).toBe(true); // > 70% of the cap: a shed rank could never reload
    expect(capacityReport(6_000_000, four, 6_500 * MB).overCap).toBe(true);
    // R1 alone (no engine here) stays under the cap — the figure the guard used to be compared with.
    expect(capacityReport(6_000_000, four, 8_000 * MB, false).overCap).toBe(false);
    // The per-chain form the runbook advises is comfortably inside it.
    const perChain = capacityReport({ perChain: { 4663: 6_000_000 } }, four, 8_000 * MB);
    expect(perChain.overCap).toBe(false);
    expect(perChain.overReload).toBe(false);
    expect(perChain.estimatedMb).toBeLessThan(2_500);
    // overReload sits at RELOAD_SHARE × cap exactly.
    const bytes = 1_000_000 * (rankRowBytes() + rankEngineRowBytes());
    expect(capacityReport({ perChain: { 4663: 1_000_000 } }, [RH], bytes / 0.7 + 1).overReload).toBe(false);
    expect(capacityReport({ perChain: { 4663: 1_000_000 } }, [RH], bytes / 0.7 - 1).overReload).toBe(true);
  });
});

const SHARDS: ShardCollection[] = [
  { coll: '1_uniswap_v4_positions', model: 'rank', chainId: 1, protocol: 'uniswap-v4' },
  { coll: '4663_uniswap_v4_positions', model: 'rank', chainId: 4663, protocol: 'uniswap-v4' },
  { coll: '4663_uniswap_v4_pools', model: 'pools', chainId: 4663, protocol: 'uniswap-v4' },
];

function runtimeWith(positionsCapacity: ConstructorParameters<typeof ReadModelsRuntime>[1]['positionsCapacity'], redis = new MemoryRedis()) {
  return new ReadModelsRuntime(
    {
      transport: new MemoryModelsTransport(redis, KEYS),
      state: new MemoryStateTransport(redis, KEYS),
      keys: KEYS,
      sink: new NoopSnapshotSink(),
      createHost: () => new InThreadFeederHost(() => undefined as never),
      alerts: new SpecAlerts(),
    },
    { role: 'both', shards: SHARDS, holder: HOLDER_CONFIG, maxLagMs: 120_000, positionsCapacity, leaseTtlMs: 1_000, leaseRetryMs: 100, oplogRetryMs: 60_000 },
    { rank: 'shadow', pools: 'shadow' },
  );
}

const oid = (n: number) => n.toString(16).padStart(24, '0');

async function snapshot(redis: MemoryRedis) {
  const store = new ModelStore(new Set(['rank', 'pools']));
  for (const [shard, chainId] of [[ETH, 1], [RH, 4663]] as const) {
    const table = store.ensureTable('rank', shard);
    for (let n = 0; n < 40; n++) {
      table.upsert(oid(chainId * 1000 + n), encodeCells(table.leaves, normalizeDoc('rank', positionDoc(n, { chainId })), (v) => table.dict.intern(v)));
    }
    table.state = 'ready';
  }
  const pools = store.ensureTable('pools', RH);
  for (let n = 0; n < 40; n++) pools.upsert(oid(90_000 + n), encodeCells(pools.leaves, normalizeDoc('pools', poolDoc(n, { chainId: 4663 })), (v) => pools.dict.intern(v)));
  pools.state = 'ready';
  store.pos = { fence: 9, epoch: 3, s: 0, id: '100-0', rt: '82aa', ct: '5:5', ca: 1234, inc: 'inc1' };
  const transport = new MemoryModelsTransport(redis, KEYS);
  const manifest = await writeSnapshotSet({ transport, keys: KEYS, store, head: { fence: 9, epoch: 3, inc: 'inc1', snapSeq: 1 }, writingTtlMs: 600_000, maxEncodeMs: 20_000 });
  return { manifest, transport };
}

describe('the runtime reserves per shard', () => {
  it('create path: a per-chain map reserves only the listed chain’s positions table', () => {
    const runtime = runtimeWith({ perChain: { 4663: 50_000 } });
    expect(runtime.store.ensureTable('rank', RH).capacity).toBe(50_000);
    expect(runtime.store.ensureTable('rank', ETH).capacity).toBe(1024);
    expect(runtime.store.ensureTable('pools', RH).capacity).toBe(1024);
  });

  it('create path: a plain number still reserves every positions table (backward compatible)', () => {
    const runtime = runtimeWith(30_000);
    expect(runtime.store.ensureTable('rank', RH).capacity).toBe(30_000);
    expect(runtime.store.ensureTable('rank', ETH).capacity).toBe(30_000);
    expect(runtime.store.ensureTable('pools', RH).capacity).toBe(1024);
  });

  it('load path: a snapshot load reserves the listed chain and grows the rest from the loaded count', async () => {
    const redis = new MemoryRedis();
    const { manifest, transport } = await snapshot(redis);
    const runtime = runtimeWith({ perChain: { 4663: 50_000 } }, redis);
    await runtime.loadManifest(manifest, transport);
    expect(runtime.store.table('rank', RH)!.capacity).toBe(50_000);
    expect(runtime.store.table('rank', ETH)!.capacity).toBe(Math.ceil(40 * 1.5) + 16);
    expect(runtime.store.table('pools', RH)!.capacity).toBe(Math.ceil(40 * 1.25) + 16);
    expect(runtime.store.table('rank', RH)!.live).toBe(40);

    const plain = runtimeWith(30_000, redis);
    await plain.loadManifest(manifest, transport);
    expect(plain.store.table('rank', RH)!.capacity).toBe(30_000);
    expect(plain.store.table('rank', ETH)!.capacity).toBe(30_000);
  });

  it('status: the configured value and each positions table’s reservation next to its real capacity', () => {
    const runtime = runtimeWith({ perChain: { 4663: 50_000 } });
    runtime.store.ensureTable('rank', RH);
    const status = runtime.status().positionsCapacity;
    expect(status.configured).toEqual({ mode: 'per_chain', perChain: { 4663: 50_000 } });
    expect(status.shards[RH]).toMatchObject({ reservedRows: 50_000, capacity: 50_000, rows: 0 });
    expect(status.shards[RH].bytes).toBeGreaterThan(0);
    expect(status.shards[ETH]).toEqual({ reservedRows: 0, capacity: null, rows: null, bytes: null });
    expect(status.shards['4663:uniswap-v4']).toBeDefined();
    expect(Object.keys(status.shards)).toEqual([ETH, RH]);
  });
});

function serviceConfig(over: Record<string, unknown> = {}) {
  return {
    readModelsMode: 'serve',
    poolCatalogMode: undefined,
    rankEngineMode: undefined,
    readModelsRole: 'server',
    isProduction: false,
    leaderboardSnapshotNamespace: 'ns',
    enabledIntegrations: [
      { chainId: 1, protocol: 'uniswap-v4' },
      { chainId: 4663, protocol: 'uniswap-v4' },
    ],
    readModelsSnapshotIntervalMs: 300_000,
    readModelsOplogWindowHintMs: 10_800_000,
    readModelsScanDocsPerSec: 5_000,
    readModelsVerifyDocsPerSec: 500,
    readModelsWorkers: 0,
    readModelsMaxLagMs: 120_000,
    readModelsReadyTimeoutMs: 300_000,
    readModelsPositionsCapacity: 0,
    readModelsDurableSnapshotUrl: undefined,
    readModelsDegradedPolicy: 'p1',
    readModelsMaxMb: 0,
    redisModelsSeparate: false,
    mongodbUri: 'mongodb://localhost:27017/x',
    ...over,
  } as never;
}

const noRedis = () => ({ control: vi.fn(async () => undefined), get: vi.fn(async () => undefined), separate: false });

async function bootService(over: Record<string, unknown>) {
  const service = new ReadModelsService(serviceConfig(over), noRedis() as never, noRedis() as never);
  await (service as unknown as { boot(): Promise<void> }).boot();
  return service;
}

describe('the memory guard sees the per-shard reservation', () => {
  it('a plain value over the cap raises [alert] read_models.capacity at boot; the per-chain value under it does not', async () => {
    // This replica serves rank (role server): the engine's copy counts too.
    const perRow = rankRowBytes() + rankEngineRowBytes();
    // Cap: room for ONE 1M-row table (R1 + engine) under 70%, not two.
    const capMb = Math.ceil((1_000_000 * perRow) / 1_048_576 / 0.7) + 1;
    const plain = await bootService({ readModelsPositionsCapacity: 1_000_000, readModelsMaxMb: capMb });
    expect(plain.alerts.snapshot().counts['read_models.capacity']).toBe(1);
    const status = (await plain.status()) as { memoryGuard: { positionsReservation: Record<string, unknown> } };
    expect(status.memoryGuard.positionsReservation).toMatchObject({ reservedRows: 2_000_000, capMb, overCap: true, shards: { [ETH]: 1_000_000, [RH]: 1_000_000 } });
    await plain.onApplicationShutdown?.();

    const perChain = await bootService({ readModelsPositionsCapacity: { perChain: { 4663: 1_000_000 } }, readModelsMaxMb: capMb });
    expect(perChain.alerts.snapshot().counts['read_models.capacity']).toBeUndefined();
    const status2 = (await perChain.status()) as { memoryGuard: { positionsReservation: Record<string, unknown> } };
    expect(status2.memoryGuard.positionsReservation).toMatchObject({ reservedRows: 1_000_000, overCap: false, shards: { [RH]: 1_000_000 } });
    await perChain.onApplicationShutdown?.();
  });

  it('over 70% of the cap but under it: the alert still fires and says rank could never reload; a feeder counts no engine', async () => {
    const perRow = rankRowBytes() + rankEngineRowBytes();
    // Two 1M-row tables (R1 + engine) fit the cap but not 70% of it.
    const capMb = Math.ceil((2_000_000 * perRow) / 1_048_576 / 0.8);
    const service = await bootService({ readModelsPositionsCapacity: 1_000_000, readModelsMaxMb: capMb });
    expect(service.alerts.snapshot().counts['read_models.capacity']).toBe(1);
    const status = (await service.status()) as { memoryGuard: { positionsReservation: Record<string, unknown> } };
    expect(status.memoryGuard.positionsReservation).toMatchObject({ engine: true, overCap: false, overReload: true });
    expect(JSON.stringify(service.alerts.snapshot())).toContain('never reload');
    await service.onApplicationShutdown?.();

    // A role that runs no rank engine (here `none`; `feeder` likewise): R1 alone is well under 70%.
    const feeder = await bootService({ readModelsRole: 'none', readModelsPositionsCapacity: 1_000_000, readModelsMaxMb: capMb });
    expect(feeder.alerts.snapshot().counts['read_models.capacity']).toBeUndefined();
    const status2 = (await feeder.status()) as { memoryGuard: { positionsReservation: Record<string, unknown> } };
    expect(status2.memoryGuard.positionsReservation).toMatchObject({ engine: false, engineMb: 0, overReload: false });
    await feeder.onApplicationShutdown?.();
  });

  it('nothing reserved: no log line, no alert, an empty report', async () => {
    const service = await bootService({ readModelsMaxMb: 1 });
    expect(service.alerts.snapshot().counts['read_models.capacity']).toBeUndefined();
    const status = (await service.status()) as { memoryGuard: { positionsReservation: Record<string, unknown> } };
    expect(status.memoryGuard.positionsReservation).toMatchObject({ reservedRows: 0, estimatedMb: 0, overCap: false, shards: {} });
    await service.onApplicationShutdown?.();
  });
});
