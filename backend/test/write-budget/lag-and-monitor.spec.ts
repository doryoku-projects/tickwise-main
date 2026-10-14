import { afterEach, describe, expect, it } from 'vitest';
import { observeHeartbeat, resetReplicationLag, userReadLagMs, writeLagMs } from '../../src/database/replication-lag.js';
import {
  dirtyPctFromServerStatus,
  MongoMonitor,
  OPLOG_EVERY_MS,
  oplogWindowSec,
  STALE_AFTER_MS,
  type MonitorClient,
} from '../../src/database/mongo-monitor.js';

afterEach(() => resetReplicationLag());

describe('write lag input (replication-lag.ts)', () => {
  const T = 1_760_000_000_000;

  it('majority lag = the primary’s own lastWriteDate − majorityWriteDate', () => {
    observeHeartbeat('p:1', { isWritablePrimary: true, lastWrite: { lastWriteDate: new Date(T), majorityWriteDate: new Date(T - 7000) } }, T, 1e9);
    expect(writeLagMs(T)).toEqual({ lagMs: 7000, majorityLagMs: 7000, secondaryLagMs: null });
  });

  it('the worst fresh secondary counts too, and the input is the worse of the two', () => {
    observeHeartbeat('p:1', { isWritablePrimary: true, lastWrite: { lastWriteDate: new Date(T), majorityWriteDate: new Date(T - 1000) } }, T, 1e9);
    observeHeartbeat('s:2', { secondary: true, lastWrite: { lastWriteDate: new Date(T - 9000) } }, T, 1e9);
    expect(writeLagMs(T)).toEqual({ lagMs: 9000, majorityLagMs: 1000, secondaryLagMs: 9000 });
  });

  it('readings older than a minute are ignored (null = unknown, never red)', () => {
    observeHeartbeat('p:1', { isWritablePrimary: true, lastWrite: { lastWriteDate: new Date(T), majorityWriteDate: new Date(T - 7000) } }, T, 1e9);
    expect(writeLagMs(T + 61_000).lagMs).toBeNull();
  });

  it('a reply without majorityWriteDate (standalone / old server) gives no majority reading', () => {
    observeHeartbeat('p:1', { isWritablePrimary: true, lastWrite: { lastWriteDate: new Date(T) } }, T, 1e9);
    expect(writeLagMs(T)).toEqual({ lagMs: null, majorityLagMs: null, secondaryLagMs: null });
  });

  it('a SECONDARY’s majorityWriteDate is not mistaken for the primary’s', () => {
    observeHeartbeat('s:2', { secondary: true, lastWrite: { lastWriteDate: new Date(T), majorityWriteDate: new Date(T - 60_000) } }, T, 1e9);
    expect(writeLagMs(T).majorityLagMs).toBeNull();
  });

  it('leaves the user-read lag untouched', () => {
    observeHeartbeat('p:1', { isWritablePrimary: true, lastWrite: { lastWriteDate: new Date(T), majorityWriteDate: new Date(T - 7000) } }, T, 1e9);
    observeHeartbeat('s:2', { secondary: true, lastWrite: { lastWriteDate: new Date(T - 3000) } }, T, 1e9);
    expect(userReadLagMs(T)).toBe(3000);
  });

  it('an idle primary + a phase-shifted, caught-up secondary reads GREEN (no phantom cross-heartbeat lag)', () => {
    // Primary heard at T+0.5 s, last write (the no-op writer) at T, majority caught up.
    observeHeartbeat('p:1', { isWritablePrimary: true, lastWrite: { lastWriteDate: new Date(T), majorityWriteDate: new Date(T) } }, T + 500, 1e9);
    // Secondary heard 9 s later, also at T: fully caught up.
    observeHeartbeat('s:2', { secondary: true, lastWrite: { lastWriteDate: new Date(T) } }, T + 9_500, 1e9);
    expect(writeLagMs(T + 9_600)).toEqual({ lagMs: 0, majorityLagMs: 0, secondaryLagMs: 0 });
    // The read path keeps its conservative upper-bound estimate (staleness flags err toward "older").
    expect(userReadLagMs(T + 9_600)).toBe(9_000);
  });

  it('a secondary behind the primary’s last known write still counts (floor against the preceding primary reading)', () => {
    observeHeartbeat('p:1', { isWritablePrimary: true, lastWrite: { lastWriteDate: new Date(T), majorityWriteDate: new Date(T) } }, T + 500, 1e9);
    observeHeartbeat('s:2', { secondary: true, lastWrite: { lastWriteDate: new Date(T - 12_000) } }, T + 9_500, 1e9);
    expect(writeLagMs(T + 9_600)).toEqual({ lagMs: 12_000, majorityLagMs: 0, secondaryLagMs: 12_000 });
  });

  it('a primary reading heard AFTER the secondary’s, or over a minute before it, gives that secondary no floor', () => {
    observeHeartbeat('p:1', { isWritablePrimary: true, lastWrite: { lastWriteDate: new Date(T - 70_000), majorityWriteDate: new Date(T - 70_000) } }, T - 70_000, 1e9);
    observeHeartbeat('s:2', { secondary: true, lastWrite: { lastWriteDate: new Date(T - 90_000) } }, T, 1e9);
    expect(writeLagMs(T).secondaryLagMs).toBeNull();
    resetReplicationLag();
    observeHeartbeat('p:1', { isWritablePrimary: true, lastWrite: { lastWriteDate: new Date(T + 5_000), majorityWriteDate: new Date(T + 5_000) } }, T + 5_000, 1e9);
    // Out-of-order receivedAt: the primary's state at the secondary's reply is unknown.
    observeHeartbeat('s:3', { secondary: true, lastWrite: { lastWriteDate: new Date(T) } }, T, 1e9);
    expect(writeLagMs(T + 5_000).secondaryLagMs).toBeNull();
  });

  it('the newest preceding primary reading is the one compared (failover: the old primary’s reading is not used)', () => {
    observeHeartbeat('old:1', { isWritablePrimary: true, lastWrite: { lastWriteDate: new Date(T - 30_000) } }, T - 30_000, 1e9);
    observeHeartbeat('new:2', { isWritablePrimary: true, lastWrite: { lastWriteDate: new Date(T - 1_000) } }, T - 1_000, 1e9);
    observeHeartbeat('s:3', { secondary: true, lastWrite: { lastWriteDate: new Date(T - 7_000) } }, T, 1e9);
    expect(writeLagMs(T).secondaryLagMs).toBe(6_000);
  });

  it('a silent secondary’s floor ages out after a minute', () => {
    observeHeartbeat('p:1', { isWritablePrimary: true, lastWrite: { lastWriteDate: new Date(T) } }, T, 1e9);
    observeHeartbeat('s:2', { secondary: true, lastWrite: { lastWriteDate: new Date(T - 8_000) } }, T, 1e9);
    expect(writeLagMs(T + 60_000).secondaryLagMs).toBe(8_000);
    expect(writeLagMs(T + 61_000).secondaryLagMs).toBeNull();
  });
});

describe('mongo monitor (MONGO_MONITOR_URI)', () => {
  it('dirty % from serverStatus.wiredTiger.cache', () => {
    expect(
      dirtyPctFromServerStatus({ wiredTiger: { cache: { 'tracked dirty bytes in the cache': 50, 'maximum bytes configured': 1000 } } }),
    ).toBe(5);
    expect(dirtyPctFromServerStatus({})).toBeNull();
    expect(dirtyPctFromServerStatus({ wiredTiger: { cache: { 'maximum bytes configured': 0, 'tracked dirty bytes in the cache': 1 } } })).toBeNull();
  });

  it('oplog window = newest − oldest entry, seconds (BSON Timestamp high bits)', () => {
    const ts = (s: number) => ({ getHighBits: () => s });
    expect(oplogWindowSec(ts(1000), ts(1000 + 3 * 3600))).toBe(10_800);
    expect(oplogWindowSec(undefined, ts(5))).toBeNull();
  });

  function fakeClient(opts: { failStatus?: () => boolean } = {}) {
    const oplogReads: number[] = [];
    let first = 1000;
    const client: MonitorClient = {
      db: (name: string) => ({
        command: async () => {
          if (opts.failStatus?.()) throw new Error('not authorized');
          return { wiredTiger: { cache: { 'tracked dirty bytes in the cache': 120, 'maximum bytes configured': 1000 } } };
        },
        collection: () => ({
          find: () => ({
            sort: (sort: Record<string, unknown>) => ({
              limit: () => ({
                toArray: async () => {
                  oplogReads.push(Number(sort.$natural));
                  expect(name).toBe('local');
                  return [{ ts: { getHighBits: () => (Number(sort.$natural) === 1 ? first : first + 7200) } }];
                },
              }),
            }),
          }),
        }),
      }),
    };
    return { client, oplogReads, moveFirst: (s: number) => (first = s) };
  }

  it('unset URI: not configured, reading absent, no connection', async () => {
    const monitor = new MongoMonitor({} as never);
    expect(monitor.configured).toBe(false);
    expect(await monitor.sample()).toMatchObject({ dirtyPct: null, oplogWindowSec: null });
  });

  it('samples dirty % every call and the oplog bounds at most once a minute', async () => {
    let t = 1_000_000;
    const fake = fakeClient();
    const monitor = new MongoMonitor({ mongoMonitorUri: 'mongodb://mon@x/' } as never, { client: () => fake.client, now: () => t });
    expect(await monitor.sample()).toMatchObject({ dirtyPct: 12, oplogWindowSec: 7200 });
    t += 5000;
    await monitor.sample();
    expect(fake.oplogReads).toEqual([1, -1]);
    t += OPLOG_EVERY_MS;
    await monitor.sample();
    expect(fake.oplogReads).toEqual([1, -1, 1, -1]);
  });

  it('a failed sample keeps the previous reading until it is stale, then reads absent', async () => {
    let t = 1_000_000;
    let fail = false;
    const fake = fakeClient({ failStatus: () => fail });
    const monitor = new MongoMonitor({ mongoMonitorUri: 'mongodb://mon@x/' } as never, { client: () => fake.client, now: () => t });
    (monitor as unknown as { logger: unknown }).logger = { warn: () => {} };
    await monitor.sample();
    fail = true;
    t += 10_000;
    expect(await monitor.sample()).toMatchObject({ dirtyPct: 12, error: 'not authorized' });
    t += STALE_AFTER_MS;
    expect(await monitor.sample()).toMatchObject({ dirtyPct: null, oplogWindowSec: null });
  });

  it('a failed connect is retried on the next sample', async () => {
    let attempts = 0;
    const fake = fakeClient();
    const monitor = new MongoMonitor({ mongoMonitorUri: 'mongodb://mon@x/' } as never, {
      client: () => {
        attempts++;
        if (attempts === 1) throw new Error('auth failed');
        return fake.client;
      },
    });
    (monitor as unknown as { logger: unknown }).logger = { warn: () => {} };
    expect((await monitor.sample()).dirtyPct).toBeNull();
    expect((await monitor.sample()).dirtyPct).toBe(12);
    expect(attempts).toBe(2);
  });
});
