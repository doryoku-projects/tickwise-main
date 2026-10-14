/*
 * Boot smoke finding (2026-10-04): a PROCESS_ROLE=feeder process with every
 * read model off booted with no capabilities, answered /health and did
 * nothing, without a word. It now raises `[alert] process_role.idle_feeder`
 * once at boot — also when READ_MODELS_ROLE is pinned to a role that cannot
 * hold the feeder lease. Every other role, and a feeder with work, is silent.
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { idleFeederReason } from '../../src/read-models/flags.js';
import { ReadModelsService } from '../../src/read-models/read-models.service.js';

const OFF = { rank: 'off', pools: 'off' } as const;
const SHADOW = { rank: 'shadow', pools: 'off' } as const;

describe('idleFeederReason', () => {
  it('feeder with every model off → a reason naming the mode variables', () => {
    expect(idleFeederReason('feeder', 'auto', OFF)).toMatch(/every read model is off/);
    expect(idleFeederReason(' FEEDER ', 'auto', OFF)).toMatch(/every read model is off/);
  });

  it('feeder with READ_MODELS_ROLE pinned to a role that cannot hold the lease → a reason naming it', () => {
    expect(idleFeederReason('feeder', 'server', SHADOW)).toBe('READ_MODELS_ROLE=server resolves to server, which cannot hold the feeder lease');
    expect(idleFeederReason('feeder', 'none', SHADOW)).toMatch(/resolves to none/);
  });

  it('a feeder with work, and every other role, → undefined', () => {
    expect(idleFeederReason('feeder', 'auto', SHADOW)).toBeUndefined();
    expect(idleFeederReason('feeder', 'feeder', SHADOW)).toBeUndefined();
    expect(idleFeederReason('feeder', 'both', SHADOW)).toBeUndefined();
    for (const role of ['all', 'api', 'sync', 'fee', '', undefined]) expect(idleFeederReason(role, 'auto', OFF)).toBeUndefined();
  });
});

describe('ReadModelsService boot', () => {
  function service(over: Record<string, unknown>) {
    const config = { readModelsMode: 'off', poolCatalogMode: undefined, rankEngineMode: undefined, readModelsRole: 'auto', processRole: 'all', ...over };
    const svc = new ReadModelsService(config as never);
    const warn = vi.fn();
    (svc as unknown as { logger: unknown }).logger = { warn, log: vi.fn(), error: vi.fn(), debug: vi.fn() };
    return { svc, warn };
  }

  it('PROCESS_ROLE=feeder with READ_MODELS_MODE=off logs [alert] process_role.idle_feeder once, and stays inert', () => {
    const { svc, warn } = service({ processRole: 'feeder' });
    svc.onApplicationBootstrap();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/^\[alert\] process_role\.idle_feeder PROCESS_ROLE=feeder but every read model is off/);
  });

  it('role all with the models off (today’s default) logs nothing', () => {
    const { svc, warn } = service({});
    svc.onApplicationBootstrap();
    expect(warn).not.toHaveBeenCalled();
  });
});
