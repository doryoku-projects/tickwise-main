/*
 * I1 — the side effects the integrator gated with `can()` (design §2.2):
 *  - TokensRepository's 60 s exclusion-set rebuild: all + api only (it serves
 *    the read path; sync / fee / feeder never serve a list);
 *  - SyncRepository's run heartbeat / reaper: all + sync only (covered in
 *    sync-repository-p2p3.spec.ts);
 * and the UNGATED inventory: every matrix cell is gated somewhere or listed
 * with a reason (test/process-roles/capability-consumers.spec.ts enforces it).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureProcessRole, resetProcessRoleForTests, UNGATED_CAPABILITIES } from '../../src/common/process-role.js';
import { TokensRepository } from '../../src/database/token.repository.js';

afterEach(() => {
  resetProcessRoleForTests();
  vi.useRealTimers();
});

function repo() {
  const model = {
    find: () => ({ select: () => ({ lean: async () => [] }), lean: async () => [] }),
    aggregate: async () => [],
    distinct: async () => [],
  };
  const config = { enabledIntegrations: [{ chainId: 1, protocol: 'uniswap-v4' }] };
  return new TokensRepository({ tokenModel: () => model } as never, config as never);
}

describe('TokensRepository exclusion-set timer — role gate', () => {
  it.each([
    ['all', true],
    ['api', true],
    ['sync', false],
    ['fee', false],
    ['feeder', false],
  ] as const)('role %s → the 60 s rebuild timer runs: %s', (role, runs) => {
    configureProcessRole({ processRole: role });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const r = repo();
    const spy = vi.spyOn(r as unknown as { refreshAllExclusions: () => Promise<void> }, 'refreshAllExclusions').mockResolvedValue();
    r.onModuleInit();
    expect(vi.getTimerCount() > 0).toBe(runs);
    expect(spy.mock.calls.length > 0).toBe(runs); // the boot warm too
    r.onModuleDestroy();
  });
});

describe('UNGATED_CAPABILITIES after I1', () => {
  it('lists only request-driven (via-http-api) or producer-gated cells — nothing "owed" is left', () => {
    for (const [cap, reason] of Object.entries(UNGATED_CAPABILITIES)) {
      expect(reason, cap).not.toMatch(/^owed:/);
    }
    expect(Object.keys(UNGATED_CAPABILITIES)).not.toContain('exclusion-timer');
    expect(Object.keys(UNGATED_CAPABILITIES)).not.toContain('run-reaper');
    expect(Object.keys(UNGATED_CAPABILITIES)).not.toContain('write-budget-controller');
    expect(Object.keys(UNGATED_CAPABILITIES)).not.toContain('backfill-fee-read');
  });
});

describe('status contributors (design §2.1 record): fee', () => {
  it('the fee service adds `fee` to the status record while it runs (fee refresh on), and removes it at destroy', async () => {
    const { PositionFeeRefreshService } = await import('../../src/sync/position-fee-refresh.service.js');
    const { ProcessStatusService, resetProcessStatusForTests } = await import('../../src/common/process-status.js');
    resetProcessStatusForTests();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const config = { positionFeeRefreshEnabled: true, enabledIntegrations: [], evmRpcUrls: new Map() };
    const svc = new PositionFeeRefreshService(config as never, {} as never, {} as never);
    const status = new ProcessStatusService(undefined, { namespace: 'ns', client: async () => undefined } as never);
    expect(status.record()).not.toHaveProperty('fee');
    svc.onModuleInit();
    expect(status.record().fee).toMatchObject({ worker: true });
    svc.onModuleDestroy();
    expect(status.record()).not.toHaveProperty('fee');
  });

  it('fee refresh OFF: no fee block (the service does nothing at all)', async () => {
    const { PositionFeeRefreshService } = await import('../../src/sync/position-fee-refresh.service.js');
    const { ProcessStatusService, resetProcessStatusForTests } = await import('../../src/common/process-status.js');
    resetProcessStatusForTests();
    const svc = new PositionFeeRefreshService({ positionFeeRefreshEnabled: false } as never, {} as never, {} as never);
    svc.onModuleInit();
    const status = new ProcessStatusService(undefined, { namespace: 'ns', client: async () => undefined } as never);
    expect(status.record()).not.toHaveProperty('fee');
  });
});
