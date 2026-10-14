/*
 * `[alert] positions.refresh_overdue` (design §5.4, §13): the one guard against
 * a chain's refresh starving at the write budget's floor.
 *
 *  - On only with the write budget on (`WRITE_BUDGET_MODE` observe / enforce),
 *    the refresh cron enabled and a scheduling role (all, sync). Off (the
 *    default): no timer, no `lastRefreshOkAt` write, no read, no alert.
 *  - A successful refresh (no failed chunk; a stale sweep deferred for a
 *    backfill still counts) stamps `lastRefreshOkAt` = its END.
 *  - A shard is overdue when that stamp is older than 2 × the refresh interval,
 *    measured from the later of the stamp and when this process began watching
 *    (a boot gets a full grace). At most one alert line per shard per minute.
 */
import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configureProcessRole, resetProcessRoleForTests } from '../../src/common/process-role.js';
import {
  REFRESH_OVERDUE_CHECK_MS,
  SyncService,
  refreshOverdueAgeMs,
  refreshOverdueWatchOn,
} from '../../src/sync/sync.service.js';

const MIN = 60_000;
const INTERVAL = 30 * MIN;
const chain1 = { chainId: 1, protocol: 'uniswap-v4', enabled: true, subgraphUrl: 'http://envio.local' };
const chain4663 = { chainId: 4663, protocol: 'uniswap-v4', enabled: true, subgraphUrl: 'http://envio.local' };

let warnings: string[] = [];

beforeEach(() => {
  warnings = [];
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(function (msg: unknown) {
    warnings.push(String(msg));
  });
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  resetProcessRoleForTests();
});

function makeService(opts: {
  config?: Record<string, unknown>;
  times?: Map<string, Date> | (() => Promise<Map<string, Date>>);
  syncRepo?: Record<string, unknown>;
  chunkFails?: boolean;
  backfillInProgress?: boolean;
}) {
  const times = opts.times;
  const syncRepo = {
    startRun: vi.fn(async () => 'run-1'),
    finishRun: vi.fn(async () => undefined),
    isBackfillInProgress: vi.fn(async () => opts.backfillInProgress === true),
    setLastCleanRefreshAt: vi.fn(async () => undefined),
    setLastRefreshOkAt: vi.fn(async () => undefined),
    lastRefreshOkTimes: vi.fn(async () => (typeof times === 'function' ? times() : (times ?? new Map()))),
    ...opts.syncRepo,
  };
  let served = 0;
  const positions = {
    upsertMany: vi.fn(async (rows: unknown[]) => rows.length),
    findActiveRefsWithTokensPage: vi.fn(async () => (served++ === 0 ? [{ positionId: '1', token0Address: '0xa', token1Address: '0xb' }] : [])),
    findHotClosedCandidatesPage: vi.fn(async () => []),
    markMissingStale: vi.fn(async () => 0),
  };
  const adapter = {
    recomputeMode: 'aggregates',
    fetchPositions: vi.fn(async () => {
      if (opts.chunkFails) throw new Error('indexer 503');
      return { positions: [], seenPositionIds: ['1'], maxTimestamp: 0, maxPositionId: '', maxBlockNumber: 0, hasMore: false, flushedCount: 0 };
    }),
  };
  const service = new SyncService(
    {
      testMode: false,
      testModePositionLimit: 0,
      positionsBackfillBuckets: 1,
      positionsSyncIntervalMs: INTERVAL,
      positionsSyncCronEnabled: true,
      enabledIntegrations: [chain1, chain4663],
      getIntegration: () => chain1,
      ...opts.config,
    } as never,
    { resolve: () => adapter } as never,
    positions as never,
    syncRepo as never,
    { prefetchPrices: vi.fn(async () => undefined), currentNativeUsd: vi.fn(async () => 2500) } as never,
    { repriceAndHealForRefresh: vi.fn(async () => undefined) } as never,
    { recompute: vi.fn() } as never,
  );
  return { service, syncRepo, positions };
}

const budgetOn = (mode: 'observe' | 'enforce' = 'enforce') => ({ writeBudget: { mode } });
const overdueLines = () => warnings.filter((w) => w.includes('[alert] positions.refresh_overdue'));

describe('refreshOverdueAgeMs (pure)', () => {
  const T0 = 1_000_000_000;

  it('a boot gets a full grace: no stamp, watched for exactly 2 × interval → not overdue; one ms later → overdue', () => {
    expect(refreshOverdueAgeMs({ nowMs: T0 + 2 * INTERVAL, intervalMs: INTERVAL, lastOkMs: undefined, watchStartedMs: T0 })).toBeUndefined();
    expect(refreshOverdueAgeMs({ nowMs: T0 + 2 * INTERVAL + 1, intervalMs: INTERVAL, lastOkMs: undefined, watchStartedMs: T0 })).toBe(2 * INTERVAL + 1);
  });

  it('measured from the LATER of the stamp and the watch start', () => {
    // A stale stamp from before this boot does not alert inside the boot's grace…
    expect(refreshOverdueAgeMs({ nowMs: T0 + 10 * MIN, intervalMs: INTERVAL, lastOkMs: T0 - 10 * INTERVAL, watchStartedMs: T0 })).toBeUndefined();
    // …and a fresh stamp after the watch began restarts the clock.
    expect(refreshOverdueAgeMs({ nowMs: T0 + 100 * MIN, intervalMs: INTERVAL, lastOkMs: T0 + 50 * MIN, watchStartedMs: T0 })).toBeUndefined();
    expect(refreshOverdueAgeMs({ nowMs: T0 + 200 * MIN, intervalMs: INTERVAL, lastOkMs: T0 + 50 * MIN, watchStartedMs: T0 })).toBe(150 * MIN);
  });

  it('no verdict without a usable interval', () => {
    for (const intervalMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(refreshOverdueAgeMs({ nowMs: T0 + 1e12, intervalMs, lastOkMs: undefined, watchStartedMs: T0 })).toBeUndefined();
    }
  });
});

describe('refreshOverdueWatchOn', () => {
  it.each([
    [undefined, false],
    [{}, false],
    [{ writeBudget: { mode: 'off' } }, false],
    [{ writeBudget: { mode: 'observe' } }, true],
    [{ writeBudget: { mode: 'enforce' } }, true],
  ])('%o → %s', (config, on) => {
    expect(refreshOverdueWatchOn(config)).toBe(on);
  });
});

describe('checkRefreshOverdue', () => {
  const T0 = Date.parse('2026-10-04T12:00:00Z');

  it('alerts the overdue shard only, with evidence fields; a fresh one stays quiet', async () => {
    const times = new Map([
      ['1:uniswap-v4', new Date(T0 + 170 * MIN)], // 10 min old at the check
      ['4663:uniswap-v4', new Date(T0 + 60 * MIN)], // 120 min old > 60
    ]);
    const { service } = makeService({ config: budgetOn(), times });
    await service.checkRefreshOverdue(T0); // starts the watch at T0
    const overdue = await service.checkRefreshOverdue(T0 + 180 * MIN);
    expect(overdue).toEqual([{ chainId: 4663, protocol: 'uniswap-v4', ageMs: 120 * MIN }]);
    expect(overdueLines()).toHaveLength(1);
    expect(overdueLines()[0]).toContain('chain=4663 protocol=uniswap-v4 ageMs=7200000');
    expect(overdueLines()[0]).toContain(`limitMs=${2 * INTERVAL}`);
    expect(overdueLines()[0]).toContain('lastOkAt=2026-10-04T13:00:00.000Z');
  });

  it('a shard that never succeeded alerts once the boot grace is over ("never")', async () => {
    const { service } = makeService({ config: budgetOn(), times: new Map() });
    expect(await service.checkRefreshOverdue(T0)).toEqual([]);
    expect(await service.checkRefreshOverdue(T0 + 2 * INTERVAL)).toEqual([]);
    const overdue = await service.checkRefreshOverdue(T0 + 2 * INTERVAL + MIN);
    expect(overdue.map((o) => o.chainId)).toEqual([1, 4663]);
    expect(overdueLines().every((l) => l.includes('lastOkAt=never'))).toBe(true);
  });

  it('at most one line per shard per minute, then again', async () => {
    const { service } = makeService({ config: budgetOn(), times: new Map([['1:uniswap-v4', new Date(T0 - 10 * INTERVAL)], ['4663:uniswap-v4', new Date(T0 + 10 * INTERVAL)]]) });
    await service.checkRefreshOverdue(T0 - 10 * INTERVAL); // watch began long ago
    await service.checkRefreshOverdue(T0);
    await service.checkRefreshOverdue(T0 + REFRESH_OVERDUE_CHECK_MS - 1);
    expect(overdueLines()).toHaveLength(1);
    await service.checkRefreshOverdue(T0 + REFRESH_OVERDUE_CHECK_MS);
    expect(overdueLines()).toHaveLength(2);
  });

  it('a failed read is no verdict: nothing returned, no alert', async () => {
    const { service } = makeService({
      config: budgetOn(),
      times: async () => {
        throw new Error('primary down');
      },
    });
    await service.checkRefreshOverdue(T0 - 10 * INTERVAL);
    expect(await service.checkRefreshOverdue(T0)).toEqual([]);
    expect(overdueLines()).toEqual([]);
  });

  it('a repository without the read (an older binding) is no verdict', async () => {
    const { service } = makeService({ config: budgetOn(), syncRepo: { lastRefreshOkTimes: undefined } });
    await service.checkRefreshOverdue(T0 - 10 * INTERVAL);
    expect(await service.checkRefreshOverdue(T0)).toEqual([]);
  });
});

describe('the watch timer (onModuleInit)', () => {
  const timerOf = (s: SyncService) => (s as unknown as { overdueTimer?: unknown }).overdueTimer;

  it('defaults (write budget off): no timer, nothing read', () => {
    const { service, syncRepo } = makeService({});
    service.onModuleInit();
    expect(timerOf(service)).toBeUndefined();
    expect(syncRepo.lastRefreshOkTimes).not.toHaveBeenCalled();
  });

  it('write budget on + cron on + role all → a timer (cleared on destroy)', () => {
    const { service } = makeService({ config: budgetOn('observe') });
    service.onModuleInit();
    expect(timerOf(service)).toBeDefined();
    service.onModuleDestroy();
    expect(timerOf(service)).toBeUndefined();
  });

  it('refresh cron disabled → no timer (nothing is scheduled to be overdue)', () => {
    const { service } = makeService({ config: { ...budgetOn(), positionsSyncCronEnabled: false } });
    service.onModuleInit();
    expect(timerOf(service)).toBeUndefined();
  });

  it.each([
    ['sync', true],
    ['api', false],
    ['fee', false],
    ['feeder', false],
  ] as const)('role %s → timer: %s (scheduling roles only)', (role, started) => {
    configureProcessRole({ processRole: role });
    const { service } = makeService({ config: budgetOn() });
    service.onModuleInit();
    expect(timerOf(service) !== undefined).toBe(started);
    service.onModuleDestroy();
  });

  it('the timer checks once a minute', async () => {
    vi.useFakeTimers();
    try {
      const { service, syncRepo } = makeService({ config: budgetOn() });
      service.onModuleInit();
      await vi.advanceTimersByTimeAsync(REFRESH_OVERDUE_CHECK_MS * 3);
      expect(syncRepo.lastRefreshOkTimes).toHaveBeenCalledTimes(3);
      service.onModuleDestroy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the lastRefreshOkAt stamp (runRefresh)', () => {
  it('defaults (budget off): a successful refresh writes no stamp (today)', async () => {
    const { service, syncRepo } = makeService({});
    const res = await service.runRefresh(chain1 as never);
    expect(res.status).toBe('success');
    expect(syncRepo.setLastRefreshOkAt).not.toHaveBeenCalled();
  });

  it('budget on: a successful refresh stamps its END', async () => {
    const { service, syncRepo } = makeService({ config: budgetOn() });
    const before = Date.now();
    await service.runRefresh(chain1 as never);
    expect(syncRepo.setLastRefreshOkAt).toHaveBeenCalledTimes(1);
    const [chainId, protocol, at] = syncRepo.setLastRefreshOkAt.mock.calls[0] as unknown as [number, string, Date];
    expect([chainId, protocol]).toEqual([1, 'uniswap-v4']);
    expect(at.getTime()).toBeGreaterThanOrEqual(before);
    expect(syncRepo.finishRun.mock.invocationCallOrder[0]).toBeLessThan(syncRepo.setLastRefreshOkAt.mock.invocationCallOrder[0]!);
  });

  it('budget on: a sweep deferred for a running backfill still counts as a success (unlike lastCleanRefreshAt)', async () => {
    const { service, syncRepo } = makeService({ config: budgetOn(), backfillInProgress: true });
    await service.runRefresh(chain1 as never);
    expect(syncRepo.setLastRefreshOkAt).toHaveBeenCalledTimes(1);
  });

  it('budget on: a partial refresh (a chunk failed) is not a success', async () => {
    const { service, syncRepo } = makeService({ config: budgetOn(), chunkFails: true });
    const res = await service.runRefresh(chain1 as never);
    expect(res.status).toBe('partial');
    expect(syncRepo.setLastRefreshOkAt).not.toHaveBeenCalled();
  });

  it('a failed stamp never fails the refresh', async () => {
    const { service } = makeService({
      config: budgetOn(),
      syncRepo: {
        setLastRefreshOkAt: vi.fn(async () => {
          throw new Error('write failed');
        }),
      },
    });
    await expect(service.runRefresh(chain1 as never)).resolves.toMatchObject({ status: 'success' });
    expect(warnings.some((w) => w.includes('lastRefreshOkAt not recorded'))).toBe(true);
  });
});
