/*
 * `off` is today's behaviour exactly (design §2.2): with every model off the
 * read-models service connects to nothing, writes no key and starts no
 * worker. Plus the Nest wiring nothing else checks (an @Optional dependency
 * that silently resolves to undefined), the admin routes' validation, and the
 * no-Redis rule (production: NOT READY + alert, never a private feeder).
 */
import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { MODULE_METADATA, OPTIONAL_DEPS_METADATA, SELF_DECLARED_DEPS_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it, vi } from 'vitest';
import { AdminController } from '../../src/admin/admin.controller.js';
import { AdminModule } from '../../src/admin/admin.module.js';
import { AppModule } from '../../src/app.module.js';
import { ReadModelsModule } from '../../src/read-models/read-models.module.js';
import { ReadModelsService } from '../../src/read-models/read-models.service.js';

const SECRET = 's3cret';

function configStub(over: Record<string, unknown> = {}) {
  return {
    readModelsMode: 'off',
    poolCatalogMode: undefined,
    rankEngineMode: undefined,
    readModelsRole: 'auto',
    isProduction: false,
    leaderboardSnapshotNamespace: 'ns',
    enabledIntegrations: [{ chainId: 1, protocol: 'uniswap-v4' }],
    readModelsSnapshotIntervalMs: 300_000,
    readModelsOplogWindowHintMs: 10_800_000,
    readModelsScanDocsPerSec: 5_000,
    readModelsWorkers: 0,
    readModelsMaxLagMs: 120_000,
    readModelsPositionsCapacity: 0,
    readModelsDurableSnapshotUrl: undefined,
    redisModelsSeparate: false,
    mongodbUri: 'mongodb://localhost:27017/x',
    adminSecret: SECRET,
    ...over,
  } as never;
}

/** A Redis client getter that fails the spec if anything asks for a connection. */
const forbidden = () => ({
  control: vi.fn(async () => {
    throw new Error('must not connect while off');
  }),
  blocking: vi.fn(),
  bulk: vi.fn(),
  checkPolicy: vi.fn(),
  get: vi.fn(async () => {
    throw new Error('must not connect while off');
  }),
});

describe('read models: off', () => {
  it('connects to nothing, starts nothing, and reports {mode: off}', async () => {
    const models = forbidden();
    const state = forbidden();
    const service = new ReadModelsService(configStub(), models as never, state as never, undefined);
    expect(service.enabled).toBe(false);
    service.onApplicationBootstrap();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(models.control).not.toHaveBeenCalled();
    expect(state.get).not.toHaveBeenCalled();
    expect(await service.status()).toEqual({ mode: 'off', configured: { rank: 'off', pools: 'off' } });
    expect(service.readiness()).toBeNull();
    await service.onApplicationShutdown();
  });

  it('one model on is enough to make the service live', () => {
    expect(new ReadModelsService(configStub({ poolCatalogMode: 'shadow' }), forbidden() as never, forbidden() as never).enabled).toBe(true);
    expect(new ReadModelsService(configStub({ readModelsMode: 'serve', rankEngineMode: 'off', poolCatalogMode: 'off' }), forbidden() as never, forbidden() as never).enabled).toBe(false);
  });

  it('production with no Redis: NOT READY with an alert, never a private in-memory feeder', async () => {
    const unavailable = { control: vi.fn(async () => undefined), get: vi.fn(async () => undefined), separate: false };
    const service = new ReadModelsService(configStub({ readModelsMode: 'shadow', isProduction: true }), unavailable as never, unavailable as never);
    await (service as unknown as { boot(): Promise<void> }).boot();
    const status = (await service.status()) as { phase?: string; redis: { transport: string }; alerts: { recent: Array<{ name: string }> } };
    expect(status.phase).toBe('booting');
    expect(status.redis.transport).toBe('none');
    expect(status.alerts.recent.map((a) => a.name)).toContain('read_models.redis_unavailable');
    await service.onApplicationShutdown();
  });

  it('outside production with no Redis: a private feeder on in-memory transports (dev)', async () => {
    const unavailable = { control: vi.fn(async () => undefined), get: vi.fn(async () => undefined), separate: false };
    const service = new ReadModelsService(configStub({ readModelsMode: 'shadow', readModelsRole: 'server' }), unavailable as never, unavailable as never);
    await (service as unknown as { boot(): Promise<void> }).boot();
    const status = (await service.status()) as { redis: { transport: string }; phase: string; role: string };
    expect(status.redis.transport).toBe('memory');
    expect(status.role).toBe('server');
    expect(status.phase).toBe('consumer');
    await service.onApplicationShutdown();
  });
});

describe('read models: wiring', () => {
  it('AppModule and AdminModule import ReadModelsModule, which exports the service', () => {
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule)).toContain(ReadModelsModule);
    expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, AdminModule)).toContain(ReadModelsModule);
    expect(Reflect.getMetadata(MODULE_METADATA.EXPORTS, ReadModelsModule)).toContain(ReadModelsService);
  });

  it('AdminController takes the service as its 4th, optional parameter (specs construct it positionally)', () => {
    const deps = (Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, AdminController) ?? []) as Array<{ index: number; param: unknown }>;
    const dep = deps.find((d) => d.param === ReadModelsService);
    // P-R appended it 4th; P2/P3 (integrator I1) appended their status
    // sources AFTER it, every one optional, so positional specs are unchanged.
    expect(dep?.index).toBe(3);
    const optional = Reflect.getMetadata(OPTIONAL_DEPS_METADATA, AdminController) as number[];
    expect(optional).toContain(dep!.index);
    for (let i = dep!.index + 1; i < AdminController.length; i++) expect(optional, `param ${i}`).toContain(i);
  });
});

describe('admin routes', () => {
  const controller = (readModels?: unknown) => new AdminController({ adminSecret: SECRET } as never, { status: async () => ({}) } as never, { status: async () => ({}) } as never, readModels as never);

  it('the status block says off without the service, and carries the service status with it', async () => {
    expect((await controller().syncStatus(SECRET)).readModels).toEqual({ mode: 'off' });
    const status = { mode: 'x' };
    expect((await controller({ status: async () => status }).syncStatus(SECRET)).readModels).toBe(status);
  });

  it('the kill switch validates model and mode, and needs the admin secret', async () => {
    const override = vi.fn(async () => ({ ok: true }));
    const c = controller({ override });
    await expect(c.readModelsOverride(SECRET, { model: 'positions' as never, mode: 'off' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(c.readModelsOverride(SECRET, { model: 'rank', mode: 'on' as never })).rejects.toBeInstanceOf(BadRequestException);
    await expect(c.readModelsOverride('wrong', { model: 'rank', mode: 'off' })).rejects.toThrow();
    await c.readModelsOverride(SECRET, { model: 'rank', mode: 'off' });
    expect(override).toHaveBeenCalledWith('rank', 'off', 'admin');
  });

  it('rescan / scan / snapshot queue commands for the lease holder; scan pace is capped at 5000', async () => {
    const command = vi.fn(async (cmd: unknown) => ({ queued: 'id', cmd }));
    const c = controller({ command });
    await c.readModelsRescan(SECRET, { model: 'pools', shard: ' 4663:uniswap-v4 ' });
    expect(command).toHaveBeenLastCalledWith({ type: 'rescan', model: 'pools', shard: '4663:uniswap-v4' }, 'admin');
    await c.readModelsRescan(SECRET, { model: 'rank' });
    expect(command).toHaveBeenLastCalledWith({ type: 'rescan', model: 'rank' }, 'admin');
    await expect(c.readModelsScan(SECRET, { action: 'pace', docsPerSec: 9_000 })).rejects.toBeInstanceOf(BadRequestException);
    await c.readModelsScan(SECRET, { action: 'pause' });
    expect(command).toHaveBeenLastCalledWith({ type: 'scan', action: 'pause', target: 'feeder' }, 'admin');
    await c.readModelsScan(SECRET, { action: 'pause', target: 'verify' });
    expect(command).toHaveBeenLastCalledWith({ type: 'scan', action: 'pause', target: 'verify' }, 'admin');
    await expect(c.readModelsScan(SECRET, { action: 'pause', target: 'both' as never })).rejects.toThrow();
    await c.readModelsSnapshot(SECRET);
    expect(command).toHaveBeenLastCalledWith({ type: 'snapshot' }, 'admin');
  });
});
