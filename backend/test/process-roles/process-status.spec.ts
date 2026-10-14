import { afterEach, describe, expect, it, vi } from 'vitest';

const blocks = vi.hoisted(() => ({ backfill: [] as unknown[], indexer: [] as unknown[] }));
vi.mock('../../src/sync/backfill-profile.js', async (orig) => ({
  ...(await orig<typeof import('../../src/sync/backfill-profile.js')>()),
  backfillProfiles: () => blocks.backfill,
}));
vi.mock('../../src/subgraph/hyperindex/indexer-gateway.js', async (orig) => ({
  ...(await orig<typeof import('../../src/subgraph/hyperindex/indexer-gateway.js')>()),
  indexerBudgetSnapshot: () => blocks.indexer,
}));
import {
  LEASE_ABSENT_ALERT_MS,
  MIXED_ALERT_MS,
  ProcessStatusService,
  STATUS_INDEX_TTL_SEC,
  STATUS_INDEX_WINDOW_MS,
  STATUS_WITHDRAW_MS,
  fleetRoles,
  lastRedisMemorySample,
  parseRedisMemoryInfo,
  readFleetFrom,
  registerStatusContributor,
  resetProcessStatusForTests,
  sampleRedisMemory,
  statusIndexKey,
} from '../../src/common/process-status.js';
import { configureProcessRole, resetProcessRoleForTests } from '../../src/common/process-role.js';
import { leaseKey } from '../../src/common/coordination-redis.js';
import { FakeLeaseRedis } from './fakes.js';

afterEach(() => {
  resetProcessStatusForTests();
  resetProcessRoleForTests();
  blocks.backfill = [];
  blocks.indexer = [];
});

describe('redis-state memory sample (design §3.6)', () => {
  it('parses INFO memory', () => {
    expect(parseRedisMemoryInfo('# Memory\r\nused_memory:700\r\nused_memory_human:700B\r\nmaxmemory:1000\r\n', 0)).toMatchObject({
      usedBytes: 700,
      maxBytes: 1000,
      usedPct: 70,
    });
    expect(parseRedisMemoryInfo('used_memory:5\r\nmaxmemory:0\r\n')).toMatchObject({ maxBytes: null, usedPct: null });
    expect(parseRedisMemoryInfo('nothing')).toBeUndefined();
  });

  it('alerts at >= 70 % of maxmemory, at most once a minute; not below', async () => {
    const warn = vi.fn();
    await sampleRedisMemory({ info: async () => 'used_memory:699\r\nmaxmemory:1000\r\n' } as never, { warn }, 0);
    expect(warn).not.toHaveBeenCalled();
    await sampleRedisMemory({ info: async () => 'used_memory:700\r\nmaxmemory:1000\r\n' } as never, { warn }, 1_000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/\[alert\] redis_state\.memory usedPct=70/);
    await sampleRedisMemory({ info: async () => 'used_memory:900\r\nmaxmemory:1000\r\n' } as never, { warn }, 30_000);
    expect(warn).toHaveBeenCalledTimes(1);
    await sampleRedisMemory({ info: async () => 'used_memory:900\r\nmaxmemory:1000\r\n' } as never, { warn }, 61_000);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(lastRedisMemorySample()?.usedPct).toBe(90);
  });

  it('never throws on a Redis error', async () => {
    await expect(
      sampleRedisMemory({ info: async () => { throw new Error('down'); } } as never, { warn: vi.fn() }),
    ).resolves.toBeUndefined();
  });
});

describe('status fan-in', () => {
  function service(redis: FakeLeaseRedis, cfg: Record<string, unknown> = {}) {
    const svc = new ProcessStatusService(cfg as never, { client: async () => redis, namespace: 'spec' } as never);
    (svc as unknown as { logger: unknown }).logger = { warn: vi.fn(), debug: vi.fn(), log: vi.fn() };
    return svc;
  }

  it('publish interval: role default 0 in all (no fan-in, today), 10 s in split roles; env wins', () => {
    const redis = new FakeLeaseRedis(Date.now);
    expect(service(redis).publishMs).toBe(0);
    configureProcessRole({ processRole: 'sync' });
    expect(service(redis).publishMs).toBe(10_000);
    expect(service(redis, { processStatusPublishMs: 5_000 }).publishMs).toBe(5_000);
  });

  it('all + default: onModuleInit starts nothing', () => {
    const redis = new FakeLeaseRedis(Date.now);
    const svc = service(redis);
    svc.onModuleInit();
    expect(redis.calls).toEqual([]);
  });

  it('one tick writes the record (EX 30), indexes it and trims the index past 60 s, in one pipeline', async () => {
    let now = 1_000_000;
    const redis = new FakeLeaseRedis(() => now);
    configureProcessRole({ processRole: 'fee' });
    registerStatusContributor('fee', () => ({ store: 'ready' }));
    registerStatusContributor('broken', () => {
      throw new Error('x');
    });
    const svc = service(redis);
    redis.zsets.set(statusIndexKey('spec'), new Map([['stale-key', now - STATUS_INDEX_WINDOW_MS - 1]]));
    await svc.tick(now);
    expect(redis.calls.filter((c) => c === 'exec')).toHaveLength(1);
    const index = redis.zsets.get(statusIndexKey('spec'))!;
    expect([...index.keys()]).toHaveLength(1);
    expect(index.has('stale-key')).toBe(false);
    const fleet = await readFleetFrom(redis as never, 'spec', now);
    expect(fleet).toHaveLength(1);
    expect(fleet[0]).toMatchObject({ role: 'fee', leases: { enabled: true, held: [] }, fee: { store: 'ready' } });
    expect(fleet[0]).not.toHaveProperty('broken');
    // EX 30: gone after 30 s
    now += 31_000;
    expect(await readFleetFrom(redis as never, 'spec', now)).toEqual([]);
  });

  it('fleetRoles: mixed only when `all` runs beside a split role', () => {
    expect(fleetRoles([{ role: 'all' }])).toMatchObject({ mixed: false });
    expect(fleetRoles([{ role: 'api' }, { role: 'sync' }])).toMatchObject({ mixed: false });
    expect(fleetRoles([{ role: 'all' }, { role: 'sync' }])).toMatchObject({ mixed: true });
  });

  it('alerts no_scheduler after the scheduler lease is absent > 2 min; clears when it returns', async () => {
    let now = 5_000_000;
    const redis = new FakeLeaseRedis(() => now);
    configureProcessRole({ processRole: 'api' });
    const svc = service(redis);
    const warn = (svc as unknown as { logger: { warn: ReturnType<typeof vi.fn> } }).logger.warn;
    await svc.tick(now);
    now += LEASE_ABSENT_ALERT_MS;
    await svc.tick(now);
    expect(warn).not.toHaveBeenCalled();
    now += 1_000;
    await svc.tick(now);
    expect(warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/\[alert\] process_role\.no_scheduler/);
    // fee-worker is only watched with the fee refresh enabled
    expect(warn.mock.calls.map((c) => c[0]).join('\n')).not.toMatch(/fees\.no_worker/);
    redis.steal(leaseKey('spec', 'scheduler'), 'sync-1', 600_000);
    warn.mockClear();
    now += 200_000;
    await svc.tick(now);
    expect(warn).not.toHaveBeenCalled();
  });

  it('alerts fees.no_worker when the fee refresh is enabled and no fee-worker lease exists', async () => {
    let now = 5_000_000;
    const redis = new FakeLeaseRedis(() => now);
    redis.steal(leaseKey('spec', 'scheduler'), 'sync-1', 10_000_000);
    configureProcessRole({ processRole: 'sync' });
    const svc = service(redis, { positionFeeRefreshEnabled: true });
    const warn = (svc as unknown as { logger: { warn: ReturnType<typeof vi.fn> } }).logger.warn;
    await svc.tick(now);
    now += LEASE_ABSENT_ALERT_MS + 1;
    await svc.tick(now);
    expect(warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/\[alert\] fees\.no_worker/);
  });

  it('alerts process_role.mixed after 10 min of `all` beside a split role; leases off → no fleet checks at all', async () => {
    let now = 9_000_000;
    const redis = new FakeLeaseRedis(() => now);
    redis.steal(leaseKey('spec', 'scheduler'), 'x', 100_000_000);
    configureProcessRole({ processRole: 'all', processLeases: 'on' });
    const all = service(redis);
    configureProcessRole({ processRole: 'sync' });
    const sync = service(redis);
    const warn = (sync as unknown as { logger: { warn: ReturnType<typeof vi.fn> } }).logger.warn;
    configureProcessRole({ processRole: 'all', processLeases: 'on' });
    await all.tick(now);
    configureProcessRole({ processRole: 'sync' });
    await sync.tick(now);
    for (let t = 0; t <= MIXED_ALERT_MS + 20_000; t += 20_000) {
      now += 20_000;
      configureProcessRole({ processRole: 'all', processLeases: 'on' });
      await all.tick(now);
      configureProcessRole({ processRole: 'sync' });
      await sync.tick(now);
    }
    expect(warn.mock.calls.map((c) => c[0]).join('\n')).toMatch(/\[alert\] process_role\.mixed/);

    // leases off: no EXISTS / fleet reads at all
    resetProcessRoleForTests();
    const r2 = new FakeLeaseRedis(() => now);
    const quiet = service(r2, { processStatusPublishMs: 10_000 });
    await quiet.tick(now);
    expect(r2.calls).toEqual(['exec']);
  });

  it('all + PROCESS_LEASES=on publishes by default (10 s), so `[alert] process_role.mixed` can see it (review fix)', async () => {
    configureProcessRole({ processRole: 'all', processLeases: 'on' });
    const redis = new FakeLeaseRedis(Date.now);
    const svc = service(redis);
    expect(svc.publishMs).toBe(10_000);
    svc.onModuleInit();
    await vi.waitFor(() => expect(redis.calls).toContain('exec'));
    const fleet = await readFleetFrom(redis as never, 'spec');
    expect(fleetRoles([...fleet, { role: 'sync' }])).toMatchObject({ all: true, mixed: true });
    await svc.onModuleDestroy();
    // …and `all` with leases off keeps today's 0 (no fan-in)
    resetProcessRoleForTests();
    expect(service(new FakeLeaseRedis(Date.now)).publishMs).toBe(0);
  });

  it('a graceful exit WITHDRAWS the record (smoke finding): key and index entry gone at once, not 30 s later; the index carries a TTL', async () => {
    configureProcessRole({ processRole: 'api' });
    const redis = new FakeLeaseRedis(Date.now);
    const svc = service(redis);
    svc.onModuleInit();
    await vi.waitFor(() => expect(redis.calls).toContain('exec'));
    expect(await readFleetFrom(redis as never, 'spec')).toHaveLength(1);
    expect(redis.ttls.get(statusIndexKey('spec'))).toBe(STATUS_INDEX_TTL_SEC);
    expect(STATUS_INDEX_TTL_SEC).toBe((2 * STATUS_INDEX_WINDOW_MS) / 1000);
    await svc.onModuleDestroy();
    expect(await readFleetFrom(redis as never, 'spec')).toEqual([]);
    expect([...redis.kv.keys()].filter((k) => k.startsWith('tw:proc:'))).toEqual([]);
    expect(redis.zsets.get(statusIndexKey('spec'))?.size ?? 0).toBe(0);
    // …and nothing publishes after it
    const calls = redis.calls.length;
    await svc.tick();
    expect(redis.calls.length).toBe(calls);
  });

  it('the withdraw waits for a publish in flight (its SET would re-create the record) and leaves other processes alone', async () => {
    configureProcessRole({ processRole: 'sync' });
    const redis = new FakeLeaseRedis(Date.now);
    // another process's record
    redis.kv.set('tw:proc:v1:spec:api:other:1', { v: JSON.stringify({ role: 'api' }) });
    redis.zsets.set(statusIndexKey('spec'), new Map([['tw:proc:v1:spec:api:other:1', Date.now()]]));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const svc = new ProcessStatusService({ processStatusPublishMs: 10_000 } as never, {
      // The first call (the publish) is slow; the withdraw's would answer at once.
      client: async () => {
        if (calls++ === 0) await gate;
        return redis;
      },
      namespace: 'spec',
    } as never);
    (svc as unknown as { logger: unknown }).logger = { warn: vi.fn(), debug: vi.fn(), log: vi.fn() };
    svc.onModuleInit(); // the first publish is now waiting on the client
    const destroyed = svc.onModuleDestroy();
    await new Promise((r) => setTimeout(r, 20)); // a withdraw that did not wait would have run by now
    release();
    await destroyed;
    await new Promise((r) => setTimeout(r, 20));
    const fleet = await readFleetFrom(redis as never, 'spec');
    expect(fleet.map((r) => r.role)).toEqual(['api']);
  });

  it('a withdraw that cannot reach Redis gives up within STATUS_WITHDRAW_MS; a process that never published sends nothing', async () => {
    configureProcessRole({ processRole: 'fee' });
    const hung = new ProcessStatusService({ processStatusPublishMs: 10_000 } as never, {
      client: () => new Promise(() => undefined),
      namespace: 'spec',
    } as never);
    hung.onModuleInit();
    const t0 = Date.now();
    await hung.onModuleDestroy();
    expect(Date.now() - t0).toBeLessThan(STATUS_WITHDRAW_MS + 500);

    resetProcessRoleForTests();
    const redis = new FakeLeaseRedis(Date.now);
    const quiet = service(redis); // all + leases off: publishMs 0
    quiet.onModuleInit();
    await quiet.onModuleDestroy();
    expect(redis.calls).toEqual([]);
  });

  it('the record carries the built-in indexer / backfill blocks once non-empty; a contributor cannot overwrite them', () => {
    const redis = new FakeLeaseRedis(Date.now);
    const svc = service(redis);
    expect(svc.record()).not.toHaveProperty('indexer');
    expect(svc.record()).not.toHaveProperty('backfill');
    blocks.indexer = [{ url: 'https://indexer.test', meter: null, gateway: null }];
    blocks.backfill = [{ chainId: 4663, protocol: 'uniswap-v4' }];
    registerStatusContributor('backfill', () => 'imposter');
    registerStatusContributor('writeBudget', () => ({ mode: 'observe' }));
    const rec = svc.record();
    expect(rec.indexer).toEqual(blocks.indexer);
    expect(rec.backfill).toEqual(blocks.backfill);
    expect(rec.writeBudget).toEqual({ mode: 'observe' });
  });
});
