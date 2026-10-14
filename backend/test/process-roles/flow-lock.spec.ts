import { afterEach, describe, expect, it, vi } from 'vitest';
import { FlowLocks, sweepFlowLockName, withFlowLock } from '../../src/common/flow-lock.js';
import { CoordinationRedis, leaseKey } from '../../src/common/coordination-redis.js';
import { configureProcessRole, resetProcessRoleForTests } from '../../src/common/process-role.js';
import { flowLockName } from '../../src/sync/sync.service.js';
import { FakeLeaseRedis, ManualClock, flush } from './fakes.js';

const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };
const NS = 'spec';

afterEach(() => {
  resetProcessRoleForTests();
  vi.restoreAllMocks();
});

function opts(redis: FakeLeaseRedis | undefined, clock: ManualClock, extra: Record<string, unknown> = {}) {
  return { redis: async () => redis as never, namespace: NS, clock, logger: quiet, ...extra };
}

describe('withFlowLock — leases OFF (the default) is a pass-through', () => {
  it('runs fn and never touches Redis', async () => {
    const clock = new ManualClock();
    const redis = new FakeLeaseRedis(clock.now);
    const out = await withFlowLock('flow:backfill:1:uniswap-v4', async () => 42, opts(redis, clock, { leases: false }));
    expect(out).toEqual({ held: false, value: 42 });
    expect(redis.calls).toEqual([]);
  });

  it('defaults to leasesEnabled() — `all` + auto is off', async () => {
    const clock = new ManualClock();
    const redis = new FakeLeaseRedis(clock.now);
    redis.steal(leaseKey(NS, 'flow:backfill:1:uniswap-v4'));
    const out = await withFlowLock('flow:backfill:1:uniswap-v4', async () => 'ran', opts(redis, clock));
    expect(out).toEqual({ held: false, value: 'ran' });
    expect(redis.calls).toEqual([]);
  });

  it('the injectable FlowLocks is a pass-through too while leases are off', async () => {
    let ran = 0;
    const locks = new FlowLocks(undefined);
    expect(await locks.run('x', async () => ++ran)).toEqual({ held: false, value: 1 });
  });
});

describe('withFlowLock — leases ON', () => {
  it('held elsewhere → {held:true}, fn not run, onHeld called', async () => {
    const clock = new ManualClock();
    const redis = new FakeLeaseRedis(clock.now);
    redis.steal(leaseKey(NS, 'flow:refresh:1:uniswap-v4'));
    let ran = false;
    let onHeld = 0;
    const out = await withFlowLock(
      'flow:refresh:1:uniswap-v4',
      async () => {
        ran = true;
      },
      opts(redis, clock, { leases: true, onHeld: () => onHeld++ }),
    );
    expect(out).toEqual({ held: true });
    expect(ran).toBe(false);
    expect(onHeld).toBe(1);
  });

  it('acquired → runs fn holding the key (TTL 60 s), heartbeats every 20 s, releases in finally', async () => {
    const clock = new ManualClock();
    const redis = new FakeLeaseRedis(clock.now);
    const key = leaseKey(NS, 'flow:backfill:4663:uniswap-v4');
    let release!: () => void;
    const pending = withFlowLock(
      'flow:backfill:4663:uniswap-v4',
      () => new Promise<string>((resolve) => (release = () => resolve('done'))),
      opts(redis, clock, { leases: true }),
    );
    await flush();
    expect(redis.kv.get(key)?.exp).toBe(clock.now() + 60_000);
    await clock.advance(50_000); // two heartbeats: still held past the first TTL window
    await clock.advance(20_000);
    expect(await redis.get(key)).not.toBeNull(); // TTL-aware: without the heartbeat it lapsed at 60 s
    expect(redis.calls.filter((c) => c === 'eval').length).toBeGreaterThanOrEqual(4); // acquire + 3 renews
    release();
    expect(await pending).toEqual({ held: false, value: 'done' });
    expect(redis.kv.get(key)).toBeUndefined();
  });

  it('releases even when fn throws', async () => {
    const clock = new ManualClock();
    const redis = new FakeLeaseRedis(clock.now);
    await expect(
      withFlowLock(
        'flow:refresh:1:p',
        async () => {
          throw new Error('boom');
        },
        opts(redis, clock, { leases: true }),
      ),
    ).rejects.toThrow('boom');
    expect(redis.kv.get(leaseKey(NS, 'flow:refresh:1:p'))).toBeUndefined();
  });

  it('a second caller while the first runs gets held (one walk at a time, fleet-wide)', async () => {
    const clock = new ManualClock();
    const redis = new FakeLeaseRedis(clock.now);
    let release!: () => void;
    const first = withFlowLock('L', () => new Promise<void>((r) => (release = r)), opts(redis, clock, { leases: true }));
    await flush();
    expect(await withFlowLock('L', async () => 'second', opts(redis, clock, { leases: true }))).toEqual({ held: true });
    release();
    await first;
    expect(await withFlowLock('L', async () => 'third', opts(redis, clock, { leases: true }))).toEqual({ held: false, value: 'third' });
  });

  it('Redis unavailable: role all runs unlocked (fail-open), a split role answers held (fail-closed)', async () => {
    const clock = new ManualClock();
    configureProcessRole({ processRole: 'all', processLeases: 'on' });
    expect(await withFlowLock('L', async () => 1, opts(undefined, clock, { leases: true }))).toEqual({ held: false, value: 1 });
    configureProcessRole({ processRole: 'sync' });
    let ran = false;
    expect(
      await withFlowLock(
        'L',
        async () => {
          ran = true;
        },
        opts(undefined, clock, { leases: true }),
      ),
    ).toEqual({ held: true });
    expect(ran).toBe(false);
  });

  it('a lock stolen mid-run is not released by the old holder', async () => {
    const clock = new ManualClock();
    const redis = new FakeLeaseRedis(clock.now);
    let release!: () => void;
    const pending = withFlowLock('L', () => new Promise<void>((r) => (release = r)), opts(redis, clock, { leases: true }));
    await flush();
    redis.steal(leaseKey(NS, 'L'), 'new-holder', 600_000);
    await clock.advance(20_000);
    release();
    await pending;
    expect(redis.kv.get(leaseKey(NS, 'L'))?.v).toBe('new-holder');
  });
});

describe('FlowLocks without a bound CoordinationRedis (review fix)', () => {
  it('builds its own from AppConfigService — a split role takes the lock in the configured namespace instead of refusing every flow', async () => {
    configureProcessRole({ processRole: 'sync' });
    const clock = new ManualClock();
    const redis = new FakeLeaseRedis(clock.now);
    vi.spyOn(CoordinationRedis.prototype, 'client').mockImplementation(async () => redis as never);
    const locks = new FlowLocks(undefined, { clock }, { redisUrl: 'redis://unused', leaderboardSnapshotNamespace: 'cfgns' } as never);
    let seenKey: string | undefined;
    const out = await locks.run('flow:refresh:1:uniswap-v4', async () => {
      seenKey = [...redis.kv.keys()].find((k) => !k.endsWith(':fence'));
      return 'ran';
    });
    expect(out).toEqual({ held: false, value: 'ran' });
    expect(seenKey).toBe(leaseKey('cfgns', 'flow:refresh:1:uniswap-v4'));
    await locks.onModuleDestroy();
  });

  it('leases off: still a pure pass-through that never builds or touches a client', async () => {
    const client = vi.spyOn(CoordinationRedis.prototype, 'client');
    const locks = new FlowLocks(undefined, undefined, { redisUrl: 'redis://unused' } as never);
    expect(await locks.run('x', async () => 7)).toEqual({ held: false, value: 7 });
    expect(client).not.toHaveBeenCalled();
  });
});

describe('lock names', () => {
  it('match the design (flow:<flow>:<chain>:<protocol>) for SyncService and the sweeps', () => {
    expect(flowLockName('backfill', 4663, 'uniswap-v4')).toBe('flow:backfill:4663:uniswap-v4');
    expect(sweepFlowLockName('pool-sync', 1, 'uniswap-v4')).toBe('flow:pool-sync:1:uniswap-v4');
    expect(sweepFlowLockName('token-price', 1, 'p')).toBe('flow:token-price:1:p');
    expect(sweepFlowLockName('token-security', 1, 'p')).toBe('flow:token-security:1:p');
    expect(leaseKey('ns', 'flow:backfill:1:p')).toBe('tw:lease:v1:ns:flow:backfill:1:p');
  });
});
