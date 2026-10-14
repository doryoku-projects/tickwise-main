import { afterEach, describe, expect, it } from 'vitest';
import { LeaseRunner, RENEW_OWNED_SCRIPT, leasesHeld, resetLeaseRunnersForTests, type LeaseWorkContext } from '../../src/common/lease-runner.js';
import { leaseKey } from '../../src/common/coordination-redis.js';
import { beginShutdown, resetShutdownForTests } from '../../src/common/shutdown.js';
import { FakeLeaseRedis, ManualClock, flush } from './fakes.js';

const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };
const NS = 'spec';
const runners: LeaseRunner[] = [];

afterEach(async () => {
  for (const r of runners.splice(0)) await r.stop();
  resetLeaseRunnersForTests();
  resetShutdownForTests();
});

function runner(
  redis: FakeLeaseRedis | undefined,
  clock: ManualClock,
  work: (ctx: LeaseWorkContext) => Promise<void> | void,
  extra: Partial<ConstructorParameters<typeof LeaseRunner>[0]> = {},
): LeaseRunner {
  const r = new LeaseRunner({
    name: 'scheduler',
    redis: async () => redis as never,
    namespace: NS,
    ttlMs: 30_000,
    renewMs: 10_000,
    work,
    clock,
    logger: quiet,
    owner: `owner-${runners.length}`,
    ...extra,
  });
  runners.push(r);
  return r;
}

/** A work that runs until aborted, recording its contexts. */
function longWork(seen: LeaseWorkContext[]) {
  return (ctx: LeaseWorkContext) => {
    seen.push(ctx);
    return new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve(), { once: true }));
  };
}

describe('LeaseRunner — background acquire', () => {
  it('start() returns at once while the lease is held elsewhere; the standby keeps retrying, never runs the work', async () => {
    const clock = new ManualClock();
    const redis = new FakeLeaseRedis(clock.now);
    redis.steal(leaseKey(NS, 'scheduler'), 'old-holder');
    let ran = 0;
    const r = runner(redis, clock, () => {
      ran += 1;
    });
    const started = r.start();
    expect(started).toBeUndefined(); // synchronous, nothing to await
    await clock.advance(25_000);
    expect(ran).toBe(0);
    expect(r.mode).toBe('standby');
    // The old holder dies (its lease lapses): the standby takes over within one retry.
    await clock.advance(10_000);
    expect(ran).toBe(1);
    expect(r.held).toBe(true);
  });

  it('acquires, takes a fence, and passes {signal, fence, stillHeld}', async () => {
    const clock = new ManualClock();
    const redis = new FakeLeaseRedis(clock.now);
    const seen: LeaseWorkContext[] = [];
    const r = runner(redis, clock, longWork(seen));
    r.start();
    await flush();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.fence).toBe(1);
    expect(seen[0]!.stillHeld()).toBe(true);
    expect(seen[0]!.signal.aborted).toBe(false);
    expect(leasesHeld()).toEqual(['scheduler']);
    expect(redis.kv.get(leaseKey(NS, 'scheduler'))?.v).toBe(r.owner);
  });

  it('fences are monotonic across holders', async () => {
    const clock = new ManualClock();
    const redis = new FakeLeaseRedis(clock.now);
    const a: LeaseWorkContext[] = [];
    const b: LeaseWorkContext[] = [];
    const first = runner(redis, clock, longWork(a));
    first.start();
    await flush();
    const firstFence = a[0]!.fence;
    const second = runner(redis, clock, longWork(b));
    second.start();
    await flush();
    expect(b).toHaveLength(0); // standby while the first holds it
    await first.stop(); // releases
    expect(a[0]!.fence).toBeUndefined(); // a finished session no longer claims a fence
    await clock.advance(10_000);
    expect(firstFence).toBe(1);
    expect(b[0]!.fence).toBe(2);
  });

  it('renews every ttl/3 while held, also after a one-shot work resolved (nobody else repeats it)', async () => {
    const clock = new ManualClock();
    const redis = new FakeLeaseRedis(clock.now);
    let ran = 0;
    const r = runner(redis, clock, () => {
      ran += 1;
    });
    r.start();
    await clock.advance(95_000);
    expect(ran).toBe(1);
    expect(r.held).toBe(true);
    expect(redis.kv.get(leaseKey(NS, 'scheduler'))?.exp).toBeGreaterThan(clock.now());
  });
});

describe('LeaseRunner — loss', () => {
  it('a renew that ERRORS is not a loss; the work keeps running until stillHeld expires (ttl − renew)', async () => {
    const clock = new ManualClock();
    const redis = new FakeLeaseRedis(clock.now);
    const seen: LeaseWorkContext[] = [];
    const r = runner(redis, clock, longWork(seen));
    r.start();
    await flush();
    redis.failing = true;
    await clock.advance(10_000); // renew #1 errors
    expect(seen[0]!.signal.aborted).toBe(false);
    expect(seen[0]!.stillHeld()).toBe(true);
    expect(r.status().renewFailures).toBe(1);
    await clock.advance(9_000); // 19 s since the last good renew: still < 20 s
    expect(seen[0]!.stillHeld()).toBe(true);
    await clock.advance(1_000); // 20 s: stillHeld boundary → false
    expect(seen[0]!.stillHeld()).toBe(false);
    await clock.advance(10_000); // renew #2 errors, stillHeld false → abort
    expect(seen[0]!.signal.aborted).toBe(true);
    expect(r.status().lost).toBe(1);
  });

  it('a renew that answers CAS-lost aborts at once (another owner)', async () => {
    const clock = new ManualClock();
    const redis = new FakeLeaseRedis(clock.now);
    const seen: LeaseWorkContext[] = [];
    const r = runner(redis, clock, longWork(seen));
    r.start();
    await flush();
    redis.steal(leaseKey(NS, 'scheduler'));
    await clock.advance(10_000);
    expect(seen[0]!.signal.aborted).toBe(true);
    expect(seen[0]!.stillHeld()).toBe(false);
    // A lost lease is never released (it is someone else's now).
    expect(redis.kv.get(leaseKey(NS, 'scheduler'))?.v).toBe('thief');
    expect(r.mode).toBe('standby');
  });

  it('a failing work releases the lease (never a held lease with no work) and retries later', async () => {
    const clock = new ManualClock();
    const redis = new FakeLeaseRedis(clock.now);
    let calls = 0;
    const r = runner(redis, clock, async (ctx) => {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => resolve()));
    });
    r.start();
    await clock.advance(5_000);
    expect(calls).toBe(1);
    expect(redis.kv.get(leaseKey(NS, 'scheduler'))).toBeUndefined();
    await clock.advance(10_000); // one retry interval later
    expect(calls).toBe(2);
    expect(r.held).toBe(true);
  });
});

describe('LeaseRunner — stop / shutdown', () => {
  it('stop() aborts, awaits the unit in flight, then releases', async () => {
    const clock = new ManualClock();
    const redis = new FakeLeaseRedis(clock.now);
    let finished = false;
    const r = runner(redis, clock, (ctx) =>
      new Promise<void>((resolve) =>
        ctx.signal.addEventListener('abort', () => setImmediate(() => {
          finished = true;
          resolve();
        })),
      ),
    );
    r.start();
    await flush();
    await r.stop();
    expect(finished).toBe(true);
    expect(redis.kv.get(leaseKey(NS, 'scheduler'))).toBeUndefined();
    expect(r.mode).toBe('stopped');
  });

  it('the process shutdown signal stops it too', async () => {
    const clock = new ManualClock();
    const redis = new FakeLeaseRedis(clock.now);
    const seen: LeaseWorkContext[] = [];
    const r = runner(redis, clock, longWork(seen));
    r.start();
    await flush();
    beginShutdown('spec');
    await flush();
    expect(seen[0]!.signal.aborted).toBe(true);
    expect(redis.kv.get(leaseKey(NS, 'scheduler'))).toBeUndefined();
  });
});

describe('LeaseRunner — Redis unavailable', () => {
  it('split role (no failOpen): the singleton does not run', async () => {
    const clock = new ManualClock();
    let ran = 0;
    const r = runner(undefined, clock, () => {
      ran += 1;
    });
    r.start();
    await clock.advance(60_000);
    expect(ran).toBe(0);
    expect(r.mode).toBe('standby');
  });

  it('role all (failOpen): the work runs locally without a fence, then upgrades to holder when Redis returns', async () => {
    const clock = new ManualClock();
    const redis = new FakeLeaseRedis(clock.now);
    redis.failing = true;
    const seen: LeaseWorkContext[] = [];
    const r = runner(redis, clock, longWork(seen), { failOpen: true });
    r.start();
    await flush();
    expect(seen).toHaveLength(1);
    expect(r.mode).toBe('local');
    expect(seen[0]!.fence).toBeUndefined();
    expect(seen[0]!.stillHeld()).toBe(true);
    redis.failing = false;
    await clock.advance(10_000);
    expect(r.mode).toBe('held');
    expect(seen).toHaveLength(1); // the same run continues, not a second one
    expect(seen[0]!.fence).toBe(1);
    expect(seen[0]!.signal.aborted).toBe(false);
  });

  it('role all (failOpen): a local run stops when another process turns out to hold the lease', async () => {
    const clock = new ManualClock();
    const redis = new FakeLeaseRedis(clock.now);
    redis.failing = true;
    const seen: LeaseWorkContext[] = [];
    const r = runner(redis, clock, longWork(seen), { failOpen: true });
    r.start();
    await flush();
    redis.failing = false;
    redis.steal(leaseKey(NS, 'scheduler'), 'other', 120_000);
    await clock.advance(10_000);
    expect(seen[0]!.signal.aborted).toBe(true);
    expect(r.mode).toBe('standby');
  });
});

/** A Redis whose NEXT renew answers only after `delayMs` of the clock (a slow reply that still lands). */
function slowRenewOnce(redis: FakeLeaseRedis, clock: ManualClock, delayMs: number) {
  let armed = true;
  const proxy = new Proxy(redis, {
    get(target, prop, receiver) {
      if (prop === 'eval') {
        return async (script: string, ...rest: Array<string | number>) => {
          if (armed && script === RENEW_OWNED_SCRIPT) {
            armed = false;
            await clock.sleep(delayMs);
          }
          return target.eval(script, rest[0] as number, ...rest.slice(1));
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return proxy;
}

/** A unit-by-unit loop that stops on its own once stillHeld() is false (the live listener's shape). */
function pollingWork(starts: LeaseWorkContext[], clock: ManualClock) {
  return async (ctx: LeaseWorkContext) => {
    starts.push(ctx);
    while (!ctx.signal.aborted && ctx.stillHeld()) await clock.sleep(100, ctx.signal);
  };
}

describe('LeaseRunner — no held lease without its work (review fix)', () => {
  it('a renew that lands AFTER the hold window lapsed ends the session; the next acquire restarts the work with a new fence', async () => {
    const clock = new ManualClock();
    const base = new FakeLeaseRedis(clock.now);
    const redis = slowRenewOnce(base, clock, 11_000);
    const starts: LeaseWorkContext[] = [];
    const r = runner(redis as unknown as FakeLeaseRedis, clock, pollingWork(starts, clock));
    r.start();
    await flush();
    expect(starts).toHaveLength(1);
    // t+10 s the renew starts and answers 'ok' only at t+21 s. stillHeld()
    // is false from t+20 s, so the loop has stopped by then.
    await clock.advance(25_000);
    expect(starts[0]!.signal.aborted).toBe(true);
    expect(r.status().lost).toBe(1);
    // …and it is NOT a renewed lease with nothing behind it: the work runs again.
    expect(starts).toHaveLength(2);
    expect(starts[1]!.fence).toBe(2);
    expect(starts[1]!.stillHeld()).toBe(true);
    expect(r.held).toBe(true);
  });

  it('one renew that ERRORS is retried after renewMs/4, so the hold window never lapses on a single slow reply', async () => {
    const clock = new ManualClock();
    const redis = new FakeLeaseRedis(clock.now);
    const seen: LeaseWorkContext[] = [];
    const r = runner(redis, clock, longWork(seen));
    r.start();
    await flush();
    redis.failing = true;
    await clock.advance(10_000); // renew #1 errors at t+10 s
    redis.failing = false;
    await clock.advance(15_000); // t+25 s: the t+12.5 s retry succeeded
    expect(r.renewRetryMs).toBe(2_500);
    expect(seen[0]!.signal.aborted).toBe(false);
    expect(seen[0]!.stillHeld()).toBe(true);
    expect(r.status().lost).toBe(0);
  });

  it('releaseWhenWorkReturns: a work that returns releases the lease and runs again one retry later', async () => {
    const clock = new ManualClock();
    const redis = new FakeLeaseRedis(clock.now);
    let calls = 0;
    const r = runner(redis, clock, () => {
      calls += 1;
    }, { releaseWhenWorkReturns: true });
    r.start();
    await flush();
    expect(calls).toBe(1);
    expect(redis.kv.get(leaseKey(NS, 'scheduler'))).toBeUndefined();
    expect(r.held).toBe(false);
    await clock.advance(10_000);
    expect(calls).toBe(2);
  });

  it('onAcquired fires before the work on a fresh acquire, and again on a fail-open local → held upgrade', async () => {
    const clock = new ManualClock();
    const redis = new FakeLeaseRedis(clock.now);
    const events: string[] = [];
    const r = runner(redis, clock, (ctx) => {
      events.push(`work:${ctx.fence}`);
      return longWork([])(ctx);
    }, { onAcquired: (fence) => void events.push(`acquired:${fence}`) });
    r.start();
    await flush();
    expect(events).toEqual(['acquired:1', 'work:1']);

    const clock2 = new ManualClock();
    const redis2 = new FakeLeaseRedis(clock2.now);
    redis2.failing = true;
    const upgraded: number[] = [];
    const r2 = runner(redis2, clock2, longWork([]), { failOpen: true, onAcquired: (fence) => void upgraded.push(fence) });
    r2.start();
    await flush();
    expect(r2.mode).toBe('local');
    expect(upgraded).toEqual([]);
    redis2.failing = false;
    await clock2.advance(10_000);
    expect(r2.mode).toBe('held');
    expect(upgraded).toEqual([1]);
  });

  it('a slow onAcquired holds up the work, never the renewals', async () => {
    const clock = new ManualClock();
    const redis = new FakeLeaseRedis(clock.now);
    let release!: () => void;
    let started = 0;
    const r = runner(redis, clock, (ctx) => {
      started += 1;
      return longWork([])(ctx);
    }, { onAcquired: () => new Promise<void>((resolve) => (release = resolve)) });
    r.start();
    await clock.advance(45_000); // > ttl: only renewals keep the key alive
    expect(started).toBe(0);
    expect(r.held).toBe(true);
    expect(redis.kv.get(leaseKey(NS, 'scheduler'))?.exp).toBeGreaterThan(clock.now());
    expect(r.status().lost).toBe(0);
    release();
    await flush();
    expect(started).toBe(1);
  });

  it('acquiredAt: ms while held, undefined in fail-open local mode and after stop', async () => {
    const clock = new ManualClock();
    const redis = new FakeLeaseRedis(clock.now);
    const r = runner(redis, clock, longWork([]));
    r.start();
    await flush();
    expect(r.acquiredAt).toBe(clock.now());
    await r.stop();
    expect(r.acquiredAt).toBeUndefined();

    const clock2 = new ManualClock();
    const down = new FakeLeaseRedis(clock2.now);
    down.failing = true;
    const local = runner(down, clock2, longWork([]), { failOpen: true });
    local.start();
    await flush();
    expect(local.mode).toBe('local');
    expect(local.acquiredAt).toBeUndefined();
  });
});
