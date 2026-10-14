/*
 * Readiness gating (`GET /health/ready`, design §6.7 / §13) and the R4 blocks
 * of `GET /admin/sync/status` → `readModels`, through a real
 * `ReadModelsService` on in-memory transports (role `server`: a consumer that
 * never loads a model here, so it stays NOT READY — exactly the state the
 * gate exists for). Also: the memory guard and the kill switch lowering what
 * gates, the fleet heartbeat reporting a shed model as NOT READY, the scan
 * command reaching lane B, and `off` staying exactly today's behaviour.
 */
import 'reflect-metadata';
import { MODULE_METADATA, OPTIONAL_DEPS_METADATA, PATH_METADATA, SELF_DECLARED_DEPS_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it, vi } from 'vitest';
import { ReadModelsReadyController } from '../../src/read-models/health-ready.controller.js';
import { MemoryGuard } from '../../src/read-models/memory-guard.js';
import { ReadModelsModule } from '../../src/read-models/read-models.module.js';
import { ReadModelsService } from '../../src/read-models/read-models.service.js';
import { healthReady } from '../../src/read-models/readiness.js';
import { AlertLog } from '../../src/read-models/status.js';

function configStub(over: Record<string, unknown> = {}) {
  return {
    readModelsMode: 'serve',
    poolCatalogMode: undefined,
    rankEngineMode: undefined,
    readModelsRole: 'server',
    isProduction: false,
    leaderboardSnapshotNamespace: 'ns',
    enabledIntegrations: [{ chainId: 43114, protocol: 'uniswap-v4' }],
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

type Internals = {
  boot(): Promise<void>;
  guardTick(now?: number): void;
  heartbeat(): Promise<void>;
  holdsEveryModel(): boolean;
  runtime: { phase: string; modes: Record<string, string>; store: { models: Set<string> } };
  killSwitch: { read(): Promise<unknown> };
  fleet: { members(): Promise<Array<{ ready: Record<string, boolean> }>> };
  popCommand(commands: unknown): Promise<string | null>;
  memoryGuard?: MemoryGuard;
  commands: unknown;
  laneB?: { status(): { verify: { paused: boolean; docsPerSec: number } } };
  state: { hgetall(key: string): Promise<Record<string, string>>; hset(key: string, field: string, value: string, ttlMs: number): Promise<void> };
  observeDegraded(): void;
};

async function booted(over: Record<string, unknown> = {}) {
  const service = new ReadModelsService(configStub(over), noRedis() as never, noRedis() as never);
  const internals = service as unknown as Internals;
  await internals.boot();
  return { service, internals };
}

describe('healthReady (the rule)', () => {
  const base = { enabled: true, bootAt: 0, now: 10_000, timeoutMs: 300_000 };
  it('every model off: 200, always (today’s behaviour for a deploy that does not use it)', () => {
    expect(healthReady({ ...base, enabled: false, modes: null, readiness: null })).toEqual({ status: 200, body: { ready: true, readModels: 'off', sinceBootMs: 10_000, models: {} } });
  });
  it('a serve model not ready: 503 with the reason; ready: 200', () => {
    const r = healthReady({ ...base, modes: { rank: 'serve', pools: 'serve' }, readiness: { rank: { ready: false, reason: 'not_caught_up' }, pools: { ready: true } } });
    expect(r.status).toBe(503);
    expect(r.body.models.rank).toEqual({ mode: 'serve', ready: false, gates: true, reason: 'not_caught_up' });
    expect(healthReady({ ...base, modes: { rank: 'serve', pools: 'serve' }, readiness: { rank: { ready: true }, pools: { ready: true } } }).status).toBe(200);
  });
  it('shadow / off models never gate; a booting runtime (no readiness) gates its serve models', () => {
    expect(healthReady({ ...base, modes: { rank: 'shadow', pools: 'off' }, readiness: { rank: { ready: false }, pools: { ready: false } } }).status).toBe(200);
    const booting = healthReady({ ...base, modes: { rank: 'serve', pools: 'off' }, readiness: null });
    expect(booting.status).toBe(503);
    expect(booting.body.models.rank.reason).toBe('booting');
  });
  it('past READ_MODELS_READY_TIMEOUT_MS since boot: 200 flagged timedOut (a broken model never blocks a deploy)', () => {
    const args = { ...base, modes: { rank: 'serve' as const, pools: 'serve' as const }, readiness: { rank: { ready: false }, pools: { ready: true } } };
    expect(healthReady({ ...args, now: 299_999 }).status).toBe(503);
    expect(healthReady({ ...args, now: 300_000 })).toMatchObject({ status: 200, body: { ready: true, timedOut: true } });
  });
});

describe('GET /health/ready', () => {
  it('is mounted by ReadModelsModule under /health, sets the status and no-store', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.CONTROLLERS, ReadModelsModule)).toContain(ReadModelsReadyController);
    expect(Reflect.getMetadata(PATH_METADATA, ReadModelsReadyController)).toBe('health');
    expect(Reflect.getMetadata(PATH_METADATA, ReadModelsReadyController.prototype.ready)).toBe('ready');
    const res = { status: vi.fn(), setHeader: vi.fn() };
    const body = { ready: false };
    const controller = new ReadModelsReadyController({ healthReady: () => ({ status: 503, body }) } as never);
    expect(controller.ready(res)).toBe(body);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
  });

  it('ReadModelsService takes the Mongo connection as its LAST, optional parameter (specs construct it positionally)', () => {
    const deps = (Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, ReadModelsService) ?? []) as Array<{ index: number; param: unknown }>;
    const last = ReadModelsService.length - 1;
    expect(deps.map((d) => d.index)).toContain(last);
    expect(Reflect.getMetadata(OPTIONAL_DEPS_METADATA, ReadModelsService)).toContain(last);
  });
});

describe('the service (memory transports, role server)', () => {
  it('off: status, readiness and the route are exactly today’s', async () => {
    const service = new ReadModelsService(configStub({ readModelsMode: 'off' }), noRedis() as never, noRedis() as never);
    service.onApplicationBootstrap();
    expect(await service.status()).toEqual({ mode: 'off', configured: { rank: 'off', pools: 'off' } });
    expect(service.healthReady().status).toBe(200);
    expect(service.healthReady().body.readModels).toBe('off');
    await service.onApplicationShutdown();
  });

  it('serve, not loaded: /health/ready is 503 until the timeout; the status carries router / memoryGuard / ready / shadow', async () => {
    const { service } = await booted();
    const r = service.healthReady();
    expect(r.status).toBe(503);
    expect(r.body.models.rank).toMatchObject({ mode: 'serve', gates: true, ready: false });
    expect(service.healthReady(service.bootAt + 300_000).status).toBe(200);
    const status = (await service.status()) as Record<string, any>;
    expect(status.router.policy).toEqual({ configured: 'p1', effective: 'p1' });
    expect(status.router.degraded).toBeDefined();
    expect(status.memoryGuard).toMatchObject({ active: expect.any(Boolean), shed: [] });
    expect(status.ready).toMatchObject({ ready: false, readModels: 'on' });
    expect(status.shadow.coverage.pools.total).toBe(160);
    expect(status.shadow.gate.pools.ready).toBe(false);
    expect(status.shadow.fleet).toMatchObject({ records: 0 });
    await service.onApplicationShutdown();
  });

  it('a configured narrow policy reports that it is not wired (it behaves as p1)', async () => {
    const { service } = await booted({ readModelsDegradedPolicy: 'narrow' });
    const status = (await service.status()) as Record<string, any>;
    expect(status.router.policy).toMatchObject({ configured: 'narrow', effective: 'p1', note: expect.stringMatching(/not wired/) });
    expect(service.degradedRoute('rank')).toBe('p1');
    await service.onApplicationShutdown();
  });

  it('the kill switch lowering a model removes it from the gate', async () => {
    const { service } = await booted({ readModelsMode: 'off', rankEngineMode: 'serve', poolCatalogMode: 'shadow' });
    expect(service.healthReady().status).toBe(503);
    await service.override('rank', 'shadow', 'spec');
    expect(service.healthReady().status).toBe(200);
    await service.onApplicationShutdown();
  });

  it('the memory guard sheds a model: unloaded on this replica, out of the gate, and reported NOT READY in the fleet heartbeat', async () => {
    const { service, internals } = await booted();
    const lines: string[] = [];
    internals.memoryGuard = new MemoryGuard({ containerBytes: 1 }, new AlertLog({ warn: (l: string) => lines.push(l) }), () => undefined);
    // RSS is far above a 1-byte "container": every stage fires, both models shed.
    internals.guardTick();
    await service.syncModes();
    expect(service.effectiveMode('rank')).toBe('off');
    expect(service.effectiveMode('pools')).toBe('off');
    expect(service.isShed('rank')).toBe(true);
    expect(service.healthReady().status).toBe(200);
    expect(lines.some((l) => l.includes('read_models.memory') && l.includes('unloading rank'))).toBe(true);
    await internals.heartbeat();
    const beats = Object.values(await internals.state.hgetall('tw:rm:v1:{ns}:fleet'));
    expect(beats).toHaveLength(1);
    expect(JSON.parse(beats[0]).ready).toEqual({ rank: false, pools: false });
    // and the degraded tracker names the memory guard
    internals.observeDegraded();
    expect(((await service.status()) as Record<string, any>).router.degraded.rank).toMatchObject({ degraded: true, reason: 'memory' });
    await service.onApplicationShutdown();
  });

  it('the kill switch cannot bring back a model the memory guard shed', async () => {
    const { service, internals } = await booted();
    internals.memoryGuard = new MemoryGuard({ containerBytes: 1 }, new AlertLog({ warn: () => undefined }), () => undefined);
    internals.guardTick();
    await service.syncModes();
    expect(service.effectiveMode('pools')).toBe('off');
    await service.override('pools', 'shadow', 'spec');
    expect(service.effectiveMode('pools')).toBe('off');
    expect(service.effectiveMode('rank')).toBe('off');
    await service.onApplicationShutdown();
  });

  it('a VERIFY scan command popped by the holder pauses / re-paces lane B; a feeder one never does', async () => {
    const { service, internals } = await booted();
    await service.command({ type: 'scan', action: 'pause', docsPerSec: 100, target: 'feeder' }, 'spec');
    expect(JSON.parse((await internals.popCommand(internals.commands))!)).toMatchObject({ type: 'scan', target: 'feeder' });
    expect(internals.laneB!.status().verify).toMatchObject({ paused: false, docsPerSec: 500 });
    await service.command({ type: 'scan', action: 'pause', docsPerSec: 100, target: 'verify' }, 'spec');
    const raw = await internals.popCommand(internals.commands);
    expect(JSON.parse(raw!)).toMatchObject({ type: 'scan', action: 'pause', target: 'verify' });
    expect(internals.laneB!.status().verify).toMatchObject({ paused: true, docsPerSec: 100 });
    await service.onApplicationShutdown();
  });

  it('on the LEASE HOLDER a memory shed unloads only the engine: the runtime keeps feeding every model', async () => {
    const { service, internals } = await booted();
    internals.runtime.phase = 'holder'; // as a holder (its rows are the fleet's delta stream)
    internals.memoryGuard = new MemoryGuard({ containerBytes: 1 }, new AlertLog({ warn: () => undefined }), () => undefined);
    internals.guardTick();
    await service.syncModes();
    expect(service.effectiveMode('rank')).toBe('off'); // the engines tear down here
    expect(service.effectiveMode('pools')).toBe('off');
    expect(internals.runtime.modes).toEqual({ rank: 'serve', pools: 'serve' }); // the feed is untouched
    expect([...internals.runtime.store.models].sort()).toEqual(['pools', 'rank']);
    // …and the heartbeat still reports the shed models NOT READY (the circuit counts them),
    // even where the runtime itself could serve them.
    const realReadiness = (internals.runtime as unknown as { readiness: () => unknown }).readiness;
    (internals.runtime as unknown as { readiness: () => unknown }).readiness = () => ({
      rank: { ready: false, reason: 'shard_not_ready', canServe: true },
      pools: { ready: false, reason: 'shard_not_ready', canServe: true },
    });
    await internals.heartbeat();
    expect(JSON.parse(Object.values(await internals.state.hgetall('tw:rm:v1:{ns}:fleet'))[0]).ready).toEqual({ rank: false, pools: false });
    // Unshed, a model that can serve SOME shards (one rescanning) reports ready: a rescan is not an outage.
    internals.memoryGuard = new MemoryGuard({}, new AlertLog({ warn: () => undefined }), () => undefined);
    await internals.heartbeat();
    expect(JSON.parse(Object.values(await internals.state.hgetall('tw:rm:v1:{ns}:fleet'))[0]).ready).toEqual({ rank: true, pools: true });
    (internals.runtime as unknown as { readiness: () => unknown }).readiness = realReadiness;
    internals.memoryGuard = new MemoryGuard({ containerBytes: 1 }, new AlertLog({ warn: () => undefined }), () => undefined);
    internals.guardTick();
    // As a consumer the same shed drops the rows locally, and the replica stops being a lease candidate.
    internals.runtime.phase = 'consumer';
    expect(internals.holdsEveryModel()).toBe(true);
    await service.syncModes();
    expect(internals.runtime.modes).toEqual({ rank: 'off', pools: 'off' });
    expect(internals.holdsEveryModel()).toBe(false);
    await service.onApplicationShutdown();
  });

  it('an override racing a kill-switch poll: applied once, last write wins, no spurious kill-switch alert', async () => {
    const { service, internals } = await booted();
    const original = internals.killSwitch.read.bind(internals.killSwitch);
    let first = true;
    internals.killSwitch.read = async () => {
      const value = await original();
      if (first) {
        first = false;
        await new Promise((resolve) => setTimeout(resolve, 50)); // the poll read the switch BEFORE the override wrote it
      }
      return value;
    };
    const poll = service.syncModes();
    const override = service.override('rank', 'shadow', 'spec');
    await Promise.all([poll, override]);
    expect(internals.runtime.modes.rank).toBe('shadow');
    expect(service.alerts.snapshot().counts['read_models.killswitch']).toBeUndefined();
    await service.onApplicationShutdown();
  });

  it('the fleet circuit is about the models the KILL SWITCH has on: a killed model is not reported, nor counted', async () => {
    const { service, internals } = await booted();
    await service.override('rank', 'off', 'spec');
    await internals.heartbeat();
    expect(Object.keys(JSON.parse(Object.values(await internals.state.hgetall('tw:rm:v1:{ns}:fleet'))[0]).ready)).toEqual(['pools']);
    const status = (await service.status()) as Record<string, any>;
    expect(Object.keys(status.fleet.circuit)).toEqual(['pools']);
    await service.onApplicationShutdown();
  });

  it('fleet heartbeats live in ONE hash: a stale field is dropped from the members and deleted', async () => {
    const { internals } = await booted();
    await internals.heartbeat();
    await internals.state.hset('tw:rm:v1:{ns}:fleet', 'dead-replica', JSON.stringify({ replica: 'dead-replica', ready: { rank: false }, at: Date.now() - 60_000, lastAppendAt: 0, role: 'both', holder: false }), 60_000);
    await internals.state.hset('tw:rm:v1:{ns}:fleet', 'garbled', '{', 60_000);
    expect(await internals.fleet.members()).toHaveLength(1);
    expect(Object.keys(await internals.state.hgetall('tw:rm:v1:{ns}:fleet'))).toHaveLength(1);
  });

  it('a replica whose role serves nothing (none) never gates /health/ready and is never degraded', async () => {
    const { service, internals } = await booted({ readModelsRole: 'none' });
    const r = service.healthReady();
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ readModels: 'on', role: 'none' });
    expect(r.body.models.rank).toMatchObject({ mode: 'serve', gates: false });
    internals.observeDegraded();
    expect(((await service.status()) as Record<string, any>).router.degraded.rank).toMatchObject({ degraded: false });
    await service.onApplicationShutdown();
  });
});

describe('healthReady: a role that serves nothing', () => {
  it('never gates (none / feeder replicas run no engine)', () => {
    const args = { enabled: true, bootAt: 0, now: 10_000, timeoutMs: 300_000, modes: { rank: 'serve' as const, pools: 'serve' as const }, readiness: { rank: { ready: false }, pools: { ready: false } } };
    expect(healthReady(args).status).toBe(503);
    expect(healthReady({ ...args, serves: false, role: 'none' })).toMatchObject({ status: 200, body: { role: 'none', models: { rank: { gates: false } } } });
  });
});

describe('AlertLog evidence lines', () => {
  it('logs every evidence line up to 100 a minute per name, then one "suppressed N" line when the next minute starts', () => {
    let now = 0;
    const lines: string[] = [];
    const log = new AlertLog({ warn: (l: string) => lines.push(l) }, () => now);
    for (let i = 0; i < 103; i++) log.evidence('read_models.data_diff', `row ${i}`);
    expect(lines).toHaveLength(100);
    expect(lines[99]).toBe('[alert] read_models.data_diff row 99');
    now = 60_000;
    log.evidence('read_models.data_diff', 'next');
    expect(lines.slice(100)).toEqual(['[alert] read_models.data_diff suppressed 3 line(s) in the previous minute (over 100/min)', '[alert] read_models.data_diff next']);
    expect(log.snapshot().counts['read_models.data_diff']).toBe(104);
    // an evidence line is not swallowed by a throttled alert of the same name
    log.alert('read_models.shadow_diff', 'a');
    log.evidence('read_models.shadow_diff', 'b');
    expect(lines.at(-1)).toBe('[alert] read_models.shadow_diff b');
  });
});

describe('AlertLog throttle key', () => {
  it('throttles once a minute per name, or per (name, key) when a key is given; counts every call', () => {
    let now = 0;
    const lines: string[] = [];
    const log = new AlertLog({ warn: (l: string) => lines.push(l) }, () => now);
    log.alert('read_models.x', 'a');
    log.alert('read_models.x', 'b');
    log.alert('read_models.y', 'c', 'rank');
    log.alert('read_models.y', 'd', 'pools');
    log.alert('read_models.y', 'e', 'rank');
    expect(lines).toEqual(['[alert] read_models.x a', '[alert] read_models.y c', '[alert] read_models.y d']);
    now = 60_000;
    log.alert('read_models.y', 'f', 'rank');
    expect(lines.at(-1)).toBe('[alert] read_models.y f');
    expect(log.snapshot().counts).toEqual({ 'read_models.x': 2, 'read_models.y': 4 });
  });
});
