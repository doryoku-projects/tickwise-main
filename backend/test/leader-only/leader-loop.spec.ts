/*
 * LeaderLoop — the leader-only poller primitive (capacity plan step 1): ONE
 * process runs `lead` every interval under a Redis lease, every other process
 * runs `follow`; a holder that stops hands the work over.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LeaderLoop, nextLeadDelayMs } from '../../src/common/leader-loop.js';
import { configureProcessRole, resetProcessRoleForTests } from '../../src/common/process-role.js';
import { resetLeaseRunnersForTests } from '../../src/common/lease-runner.js';
import { resetShutdownForTests } from '../../src/common/shutdown.js';
import { LeaderRedis, ManualClock, coordinationOf, flush } from './fakes.js';

const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };

afterEach(() => {
  resetProcessRoleForTests();
  resetLeaseRunnersForTests();
  resetShutdownForTests();
});

function loop(clock: ManualClock, redis: LeaderRedis, owner: string, over: Partial<ConstructorParameters<typeof LeaderLoop>[0]> = {}) {
  const lead = vi.fn(async () => undefined);
  const follow = vi.fn(async () => undefined);
  const l = new LeaderLoop({
    name: 'spec-poller',
    coordination: coordinationOf(redis),
    intervalMs: 60_000,
    lead,
    follow,
    followIntervalMs: 60_000,
    clock,
    logger: quiet,
    owner,
    ...over,
  });
  return { l, lead, follow };
}

describe('LeaderLoop', () => {
  it('exactly one process leads; the other follows', async () => {
    configureProcessRole({ processRole: 'api' });
    const clock = new ManualClock();
    const redis = new LeaderRedis(clock.now);
    const a = loop(clock, redis, 'a');
    const b = loop(clock, redis, 'b');
    a.l.start();
    await flush();
    b.l.start();
    await flush();
    expect(a.l.leading).toBe(true);
    expect(b.l.leading).toBe(false);
    expect(a.lead).toHaveBeenCalledTimes(1); // once on acquire

    await clock.advance(60_000);
    expect(a.lead).toHaveBeenCalledTimes(2); // then every interval
    expect(b.lead).not.toHaveBeenCalled();
    expect(b.follow).toHaveBeenCalled();
    expect(a.follow).not.toHaveBeenCalled(); // the holder never follows

    await a.l.stop();
    await b.l.stop();
  });

  it('a holder that stops hands the work to the follower', async () => {
    configureProcessRole({ processRole: 'api' });
    const clock = new ManualClock();
    const redis = new LeaderRedis(clock.now);
    const a = loop(clock, redis, 'a');
    const b = loop(clock, redis, 'b');
    a.l.start();
    await flush();
    b.l.start();
    await flush();
    await a.l.stop(); // releases the lease
    await clock.advance(30_000);
    expect(b.l.leading).toBe(true);
    expect(b.lead).toHaveBeenCalled();
    await b.l.stop();
  });

  it('a failing cycle is logged and the next one still runs on time', async () => {
    configureProcessRole({ processRole: 'api' });
    const clock = new ManualClock();
    const redis = new LeaderRedis(clock.now);
    const lead = vi.fn(async () => {
      throw new Error('boom');
    });
    const { l } = loop(clock, redis, 'a', { lead });
    l.start();
    await flush();
    await clock.advance(120_000);
    expect(lead.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(l.leading).toBe(true);
    await l.stop();
  });

  it('leader cycles run at a FIXED RATE: the next starts one interval after the last STARTED (review finding)', async () => {
    // A fixed delay after each cycle stretched the period by the cycle's
    // duration — for the leaderboard warmup that ate the followers' margin.
    configureProcessRole({ processRole: 'api' });
    const clock = new ManualClock();
    const redis = new LeaderRedis(clock.now);
    const starts: number[] = [];
    const lead = vi.fn(async (ctx: { signal: AbortSignal }) => {
      starts.push(clock.now());
      await clock.sleep(20_000, ctx.signal);
    });
    const { l } = loop(clock, redis, 'a', { lead });
    l.start();
    await flush();
    await clock.advance(130_000);
    expect(starts.length).toBeGreaterThanOrEqual(3);
    expect(starts[1]! - starts[0]!).toBe(60_000);
    expect(starts[2]! - starts[1]!).toBe(60_000);
    await l.stop();
  });

  it('a cycle that overruns the interval skips the ticks it ran over (the next one lands on the grid)', async () => {
    configureProcessRole({ processRole: 'api' });
    const clock = new ManualClock();
    const redis = new LeaderRedis(clock.now);
    const starts: number[] = [];
    const lead = vi.fn(async (ctx: { signal: AbortSignal }) => {
      starts.push(clock.now());
      if (starts.length === 1) await clock.sleep(70_000, ctx.signal);
    });
    const { l } = loop(clock, redis, 'a', { lead });
    l.start();
    await flush();
    await clock.advance(130_000);
    expect(starts[1]! - starts[0]!).toBe(120_000); // not 70 s (a burst) nor 130 s (a fixed delay)
    await l.stop();
  });

  it('nextLeadDelayMs: interval − elapsed, else the remainder to the next tick; never 0', () => {
    expect(nextLeadDelayMs(10_000, 0)).toBe(10_000);
    expect(nextLeadDelayMs(10_000, 3_000)).toBe(7_000);
    expect(nextLeadDelayMs(10_000, 10_000)).toBe(10_000);
    expect(nextLeadDelayMs(10_000, 13_000)).toBe(7_000);
    expect(nextLeadDelayMs(10_000, -5)).toBe(10_000); // a clock step back
  });

  it('a split role does not lead while Redis is down (followers fall back on their own)', async () => {
    configureProcessRole({ processRole: 'api' });
    const clock = new ManualClock();
    const redis = new LeaderRedis(clock.now);
    redis.failing = true;
    const a = loop(clock, redis, 'a');
    a.l.start();
    await flush();
    await clock.advance(60_000);
    expect(a.l.leading).toBe(false);
    expect(a.lead).not.toHaveBeenCalled();
    expect(a.follow).toHaveBeenCalled();
    await a.l.stop();
  });

  it('role all (leases on) runs fail-open while Redis is down', async () => {
    configureProcessRole({ processRole: 'all', processLeases: 'on' });
    const clock = new ManualClock();
    const redis = new LeaderRedis(clock.now);
    redis.failing = true;
    const a = loop(clock, redis, 'a');
    a.l.start();
    await flush();
    expect(a.l.leading).toBe(true);
    expect(a.lead).toHaveBeenCalledTimes(1);
    await a.l.stop();
  });
});
