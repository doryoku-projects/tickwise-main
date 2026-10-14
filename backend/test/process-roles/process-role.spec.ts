import { afterEach, describe, expect, it } from 'vitest';
import {
  CAPABILITIES,
  ROLE_DEFAULTS,
  ROLE_MATRIX,
  can,
  capabilitiesOf,
  configureProcessRole,
  currentProcessRole,
  leasesEnabled,
  processRoleBootLine,
  readModelsRoleFor,
  resetProcessRoleForTests,
  resolveProcessRoleSettings,
  roleCan,
  type Capability,
  type ProcessRole,
} from '../../src/common/process-role.js';
import { resolveRole } from '../../src/read-models/flags.js';

afterEach(() => {
  resetProcessRoleForTests();
  delete process.env.PROCESS_ROLE;
  delete process.env.PROCESS_LEASES;
});

/**
 * The design's §2.2 matrix, written out cell by cell (✔ = true). Every cell is
 * asserted, so a mutation of any one row of ROLE_MATRIX fails here.
 */
const EXPECTED: Record<Capability, Record<ProcessRole, boolean>> = {
  'http-api': { all: true, api: true, sync: false, fee: false, feeder: false },
  'health-full': { all: true, api: true, sync: false, fee: false, feeder: false },
  'queue-workers': { all: true, api: false, sync: true, fee: false, feeder: false },
  'payments-worker': { all: true, api: false, sync: true, fee: false, feeder: false },
  'token-verification': { all: true, api: true, sync: true, fee: false, feeder: false },
  scheduler: { all: true, api: false, sync: true, fee: false, feeder: false },
  'live-listener': { all: true, api: false, sync: true, fee: false, feeder: false },
  'fee-worker': { all: true, api: false, sync: false, fee: true, feeder: false },
  'fee-view-signals': { all: true, api: true, sync: false, fee: false, feeder: false },
  'fee-dirty-signals': { all: true, api: false, sync: true, fee: false, feeder: false },
  'backfill-fee-read': { all: true, api: false, sync: true, fee: false, feeder: false },
  'write-budget-controller': { all: true, api: true, sync: true, fee: true, feeder: false },
  'leaderboard-warmup': { all: true, api: true, sync: false, fee: false, feeder: false },
  'exclusion-timer': { all: true, api: true, sync: false, fee: false, feeder: false },
  'indexing-status-warm': { all: true, api: true, sync: false, fee: false, feeder: false },
  'count-cache-warm': { all: true, api: true, sync: false, fee: false, feeder: false },
  'deep-walks': { all: true, api: true, sync: false, fee: false, feeder: false },
  'v1-stats': { all: true, api: true, sync: false, fee: false, feeder: false },
  'x402-relay': { all: true, api: true, sync: false, fee: false, feeder: false },
  'run-reaper': { all: true, api: false, sync: true, fee: false, feeder: false },
};

const ROLES: ProcessRole[] = ['all', 'api', 'sync', 'fee', 'feeder'];

describe('process-role matrix (design §2.2)', () => {
  it('lists exactly the expected capabilities', () => {
    expect([...CAPABILITIES].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const capability of Object.keys(EXPECTED) as Capability[]) {
    for (const role of ROLES) {
      it(`${role} × ${capability} = ${EXPECTED[capability][role]}`, () => {
        expect(roleCan(role, capability)).toBe(EXPECTED[capability][role]);
        configureProcessRole({ role, leasesSetting: 'auto', leases: role !== 'all' });
        expect(can(capability)).toBe(EXPECTED[capability][role]);
      });
    }
  }

  it('`all` holds every capability (today = one process runs everything)', () => {
    for (const capability of CAPABILITIES) expect(ROLE_MATRIX[capability]).toContain('all');
    expect(capabilitiesOf('all')).toEqual(CAPABILITIES);
  });

  it('an unknown capability is never held', () => {
    expect(roleCan('all', 'nope' as Capability)).toBe(false);
  });
});

describe('leasesEnabled resolution', () => {
  it.each([
    ['all', 'auto', false],
    ['all', 'on', true],
    ['all', 'off', false],
    ['api', 'auto', true],
    ['sync', 'auto', true],
    ['fee', 'auto', true],
    ['feeder', 'auto', true],
    ['sync', 'on', true],
  ] as const)('%s + %s → leases %s', (role, leases, expected) => {
    expect(resolveProcessRoleSettings({ role, leases }).leases).toBe(expected);
  });

  it.each(['api', 'sync', 'fee', 'feeder'] as const)('split role %s + PROCESS_LEASES=off is refused at boot', (role) => {
    expect(() => resolveProcessRoleSettings({ role, leases: 'off' })).toThrow(/process_role\.no_leases/);
  });

  it('blank / unset values read as the defaults (all + auto)', () => {
    expect(resolveProcessRoleSettings({})).toEqual({ role: 'all', leasesSetting: 'auto', leases: false });
    expect(resolveProcessRoleSettings({ role: '  ', leases: '' })).toEqual({ role: 'all', leasesSetting: 'auto', leases: false });
    expect(resolveProcessRoleSettings({ role: ' SYNC ', leases: 'AUTO' }).role).toBe('sync');
  });

  it('garbage values throw', () => {
    expect(() => resolveProcessRoleSettings({ role: 'worker' })).toThrow(/PROCESS_ROLE/);
    expect(() => resolveProcessRoleSettings({ leases: 'maybe' })).toThrow(/PROCESS_LEASES/);
  });
});

describe('current settings', () => {
  it('with nothing configured and no env, the process is `all` with leases off (today)', () => {
    expect(currentProcessRole()).toBe('all');
    expect(leasesEnabled()).toBe(false);
    for (const capability of CAPABILITIES) expect(can(capability)).toBe(true);
  });

  it('falls back to the env, parsed like the Zod schema', () => {
    process.env.PROCESS_ROLE = 'fee';
    expect(currentProcessRole()).toBe('fee');
    expect(leasesEnabled()).toBe(true);
    expect(can('http-api')).toBe(false);
  });

  it('a bad env value answers today (Zod refuses the boot separately)', () => {
    process.env.PROCESS_ROLE = 'bogus';
    expect(currentProcessRole()).toBe('all');
    expect(leasesEnabled()).toBe(false);
  });

  it('configureProcessRole (config view) wins over the env', () => {
    process.env.PROCESS_ROLE = 'fee';
    configureProcessRole({ processRole: 'api', processLeases: 'auto' });
    expect(currentProcessRole()).toBe('api');
    expect(leasesEnabled()).toBe(true);
  });

  it('configureProcessRole refuses split + off', () => {
    expect(() => configureProcessRole({ processRole: 'sync', processLeases: 'off' })).toThrow(/no_leases/);
  });

  it('boot line names role, leases and capabilities', () => {
    configureProcessRole({ processRole: 'fee' });
    expect(processRoleBootLine()).toMatch(/role=fee leases=on \(PROCESS_LEASES=auto\) caps=fee-worker,write-budget-controller$/);
  });
});

describe('per-role defaults (design §2.2) and READ_MODELS_ROLE=auto', () => {
  it('`all` keeps today: pool 60 / 10 s, in-flight 12, local share 1.0, no status fan-in', () => {
    expect(ROLE_DEFAULTS.all).toEqual({
      mongoMaxPoolSize: 60,
      mongoWaitQueueTimeoutMs: 10_000,
      indexerMaxInFlight: 12,
      indexerBudgetLocalShare: 1,
      statusPublishMs: 0,
      indexerInteractiveReservedInFlight: 4,
    });
  });

  it('split roles: api 12/2 s/3/0.25, sync 30/30 s/6/0.5, fee 15, feeder 5; status every 10 s', () => {
    expect(ROLE_DEFAULTS.api).toMatchObject({ mongoMaxPoolSize: 12, mongoWaitQueueTimeoutMs: 2_000, indexerMaxInFlight: 3, indexerBudgetLocalShare: 0.25 });
    expect(ROLE_DEFAULTS.sync).toMatchObject({ mongoMaxPoolSize: 30, mongoWaitQueueTimeoutMs: 30_000, indexerMaxInFlight: 6, indexerBudgetLocalShare: 0.5 });
    expect(ROLE_DEFAULTS.fee.mongoMaxPoolSize).toBe(15);
    expect(ROLE_DEFAULTS.feeder.mongoMaxPoolSize).toBe(5);
    for (const role of ['api', 'sync', 'fee', 'feeder'] as const) expect(ROLE_DEFAULTS[role].statusPublishMs).toBe(10_000);
    // api×2 + sync = today's 12 in-flight
    expect(2 * ROLE_DEFAULTS.api.indexerMaxInFlight + ROLE_DEFAULTS.sync.indexerMaxInFlight).toBe(12);
  });

  it('readModelsRoleFor matches read-models/flags resolveRole for every role', () => {
    for (const role of ROLES) expect(readModelsRoleFor(role)).toBe(resolveRole('auto', role));
  });
});
