/*
 * Package B review fixes (P2.2, 2026-10-04):
 *  1. a remote plan change can no longer pin the OLD metering limits on a
 *     replica (limiters keyed by the ceiling they were built with), and an
 *     older settings load can no longer overwrite a newer one (generations);
 *  2. seed inserts stay unordered AND loud on a row that fails validation;
 *  3. the RPC budget's Redis-down share follows the role (`all` keeps 100 %);
 *  4. `reqPerSec` is exact past 68 req/s (per-second ring, not 4,096 stamps);
 *  5. a process that serves no interactive traffic reserves no indexer slots.
 */
import 'reflect-metadata';
import mongoose, { Schema } from 'mongoose';
import { RateLimiterAbstract, RateLimiterMemory } from 'rate-limiter-flexible';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MeteringService } from '../../src/billing/metering.service.js';
import {
  isOnlyDuplicateKeyErrors,
  SEED_INSERT_OPTIONS,
  SettingsCacheService,
  type CachedPlan,
} from '../../src/billing/settings-cache.service.js';
import { InvalidationBus } from '../../src/common/invalidation-bus.js';
import { configureProcessRole, resetProcessRoleForTests } from '../../src/common/process-role.js';
import { __resetAlertPacing, RedisGcra } from '../../src/common/redis-gcra.js';
import { RPC_LOCAL_SHARE, RpcBudget, rpcLocalShareFor } from '../../src/common/rpc-budget.js';
import type { IndexerContext, IndexerLane } from '../../src/subgraph/hyperindex/indexer-context.js';
import {
  __resetIndexerGateways,
  DEFAULT_INDEXER_GATEWAY_CONFIG,
  defaultInteractiveReservedInFlight,
  IndexerGateway,
  type GatewaySettled,
  type IndexerGatewayConfig,
} from '../../src/subgraph/hyperindex/indexer-gateway.js';
import { __resetIndexerMeters, IndexerMeter } from '../../src/subgraph/hyperindex/indexer-meter.js';
import { FakePubSubHub, FakeSharedRedis, fakeSource } from './fake-redis.js';

function quiet<T>(svc: T): T {
  (svc as unknown as { logger: Record<string, () => void> }).logger = { log: () => {}, warn: () => {}, error: () => {} };
  return svc;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

afterEach(() => {
  resetProcessRoleForTests();
  vi.useRealTimers();
});

// ── 1. metering limits after a remote plan change ─────────────────────────────

class RecordingMetering extends MeteringService {
  readonly built: Array<{ prefix: string; points: number }> = [];
  protected override createLimiter(keyPrefix: string, points: number, duration: number): RateLimiterAbstract {
    this.built.push({ prefix: keyPrefix, points });
    return new RateLimiterMemory({ points, duration });
  }
}

const usageStub = { updateOne: () => ({ exec: async () => undefined }) };

function planRow(rateLimitPerMin: number) {
  return { key: 'pro', name: 'Pro', monthlyUnits: 0, rateLimitPerMin, price: 0, enabled: true };
}

describe('metering after a remote plan change (eviction vs async reload)', () => {
  it('a request landing between the eviction and the reload does not pin the old limit', async () => {
    const hub = new FakePubSubHub();
    const redis = new FakeSharedRedis(Date.now, hub);
    const bus = () => quiet(new InvalidationBus({ cacheInvalidation: 'redis' } as never, fakeSource(redis, 'ns1') as never));
    const a = bus();
    const b = bus();
    a.onModuleInit();
    b.onModuleInit();
    await Promise.all([a.whenSubscribed(), b.whenSubscribed()]);

    // Replica B: the stored plan says 60/min until the admin write; B's
    // reload after the remote message is held open to land a request in the gap.
    let stored = planRow(60);
    let hold: Promise<void> | undefined;
    const planModel = {
      find: () => ({
        lean: () => ({
          exec: async () => {
            const snapshot = stored;
            if (hold) await hold;
            return [snapshot];
          },
        }),
      }),
    };
    const costModel = { find: () => ({ lean: () => ({ exec: async () => [] }) }) };
    const settings = quiet(new SettingsCacheService(planModel as never, costModel as never, b));
    await settings.refresh();
    const metering = quiet(new RecordingMetering({ redisUrl: 'redis://127.0.0.1:1' } as never, usageStub as never, b));
    const consume = () =>
      metering.checkAndConsume({ apiKeyId: 'k', customerId: '6650aaaaaaaaaaaaaaaaaaaa', plan: settings.getPlan('pro')!, unitCost: 0 });

    await consume();
    expect(metering.built).toEqual([{ prefix: 'meter:burst', points: 60 }]);

    // The admin raises the limit on replica A.
    stored = planRow(600);
    let release!: () => void;
    hold = new Promise((r) => (release = r));
    a.publish({ t: 'plan', planKey: 'pro' });
    await flush();

    // In the gap: B evicted already, its settings still say 60.
    const gap = await consume();
    expect(gap.rate.limit).toBe(60);

    release();
    hold = undefined;
    await flush();
    expect(settings.getPlan('pro')!.rateLimitPerMin).toBe(600);

    // After the reload the NEW limit applies — it used to stay 60 until the next plan edit.
    const after = await consume();
    expect(after.rate.limit).toBe(600);
    expect(metering.built.at(-1)).toEqual({ prefix: 'meter:burst', points: 600 });
    // …and once rebuilt, it is reused (no limiter per request).
    await consume();
    expect(metering.built.filter((x) => x.points === 600)).toHaveLength(1);
    metering.onModuleDestroy();
  });

  it('a changed ceiling builds a new limiter even with no eviction at all', async () => {
    const metering = quiet(new RecordingMetering({ redisUrl: 'redis://127.0.0.1:1' } as never, usageStub as never));
    const plan = (rateLimitPerMin: number, monthlyUnits: number): CachedPlan =>
      ({ ...planRow(rateLimitPerMin), monthlyUnits, selfServe: false, maxApiKeys: 1, allowBrowserKeys: false, description: '', features: [], prices: [] }) as CachedPlan;
    const run = (p: CachedPlan) => metering.checkAndConsume({ apiKeyId: 'k', customerId: '6650aaaaaaaaaaaaaaaaaaaa', plan: p, unitCost: 1 });

    expect((await run(plan(60, 100))).quota?.limit).toBe(100);
    expect((await run(plan(60, 100))).rate.limit).toBe(60);
    const r = await run(plan(90, 500));
    expect(r.rate.limit).toBe(90);
    expect(r.quota?.limit).toBe(500);
    expect(metering.built).toEqual([
      { prefix: 'meter:burst', points: 60 },
      { prefix: 'meter:quota', points: 100 },
      { prefix: 'meter:burst', points: 90 },
      { prefix: 'meter:quota', points: 500 },
    ]);
    metering.onModuleDestroy();
  });
});

describe('settings cache load generations', () => {
  it('an older load that finishes last does not put the old plans back', async () => {
    const gates: Array<{ rows: unknown[]; release: () => void; done: Promise<void> }> = [];
    let next = planRow(60);
    const planModel = {
      find: () => ({
        lean: () => ({
          exec: async () => {
            const rows = [next];
            let release!: () => void;
            const done = new Promise<void>((r) => (release = r));
            gates.push({ rows, release, done });
            await done;
            return rows;
          },
        }),
      }),
    };
    const costModel = { find: () => ({ lean: () => ({ exec: async () => [] }) }) };
    const settings = quiet(new SettingsCacheService(planModel as never, costModel as never));

    const older = settings.refresh(); // read BEFORE the admin write
    await flush();
    next = planRow(600);
    const newer = settings.refresh(); // the bus-triggered reload, after the write
    await flush();
    expect(gates).toHaveLength(2);

    gates[1].release();
    await newer;
    expect(settings.getPlan('pro')!.rateLimitPerMin).toBe(600);
    gates[0].release();
    await older;
    expect(settings.getPlan('pro')!.rateLimitPerMin).toBe(600);
  });

  it('loads that finish in order all apply', async () => {
    let next = planRow(60);
    const planModel = { find: () => ({ lean: () => ({ exec: async () => [next] }) }) };
    const costModel = { find: () => ({ lean: () => ({ exec: async () => [] }) }) };
    const settings = quiet(new SettingsCacheService(planModel as never, costModel as never));
    await settings.refresh();
    expect(settings.getPlan('pro')!.rateLimitPerMin).toBe(60);
    next = planRow(600);
    await settings.refresh();
    expect(settings.getPlan('pro')!.rateLimitPerMin).toBe(600);
  });
});

// ── 2. seed inserts: unordered and still loud on a validation failure ─────────

describe('seed insert options (real Mongoose 9)', () => {
  const connection = mongoose.createConnection();
  const Model = connection.model('ReviewBSeed', new Schema({ key: { type: String, required: true } }));

  it('unordered alone silently drops an invalid row (the trap)', async () => {
    await expect(Model.insertMany([{}], { ordered: false })).resolves.toEqual([]);
  });

  it('SEED_INSERT_OPTIONS throws, and the error is not read as a concurrent boot', async () => {
    expect(SEED_INSERT_OPTIONS).toEqual({ ordered: false, throwOnValidationError: true });
    const err = await Model.insertMany([{}], SEED_INSERT_OPTIONS).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect((err as Error)?.name).toBe('MongooseBulkWriteError');
    expect(isOnlyDuplicateKeyErrors(err)).toBe(false);
  });

  it('a seed whose rows fail validation fails the boot', async () => {
    const model = {
      estimatedDocumentCount: async () => 0,
      insertMany: (docs: unknown[], opts: Record<string, unknown>) => Model.insertMany(docs.map(() => ({})), opts),
      find: () => ({ lean: () => ({ exec: async () => [] }) }),
    };
    const svc = quiet(new SettingsCacheService(model as never, model as never));
    await expect(svc.onModuleInit()).rejects.toMatchObject({ name: 'MongooseBulkWriteError' });
  });
});

// ── 3 + 4. RPC budget: role share when Redis is down; reqPerSec past 68/s ────

function rpcClock(start = Date.UTC(2026, 9, 4, 12)) {
  const c = { t: start, slept: [] as number[], now: () => c.t, sleep: async (ms: number) => void (c.slept.push(ms), (c.t += ms)) };
  return c;
}

describe('RPC budget local share by role', () => {
  beforeEach(() => __resetAlertPacing());

  it('all = 100 %, every split role = RPC_LOCAL_SHARE', () => {
    expect(rpcLocalShareFor('all')).toBe(1);
    for (const role of ['api', 'sync', 'fee', 'feeder'] as const) expect(rpcLocalShareFor(role)).toBe(RPC_LOCAL_SHARE);
  });

  function down(role?: 'all' | 'fee') {
    const c = rpcClock();
    const gcra = new RedisGcra(async () => undefined);
    const warned: string[] = [];
    const b = new RpcBudget({ rpcBudgetPerSec: 4 } as never, undefined, { now: c.now, sleep: c.sleep, gcra, role });
    (b as unknown as { logger: { warn: (m: string) => void } }).logger = { warn: (m) => void warned.push(m) };
    return { b, c, warned };
  }

  it('Redis down in role `all`: the whole rate (4/s, burst 8) — no slowdown', async () => {
    const { b, c, warned } = down('all');
    for (let i = 0; i < 8; i++) await b.take('fee');
    expect(c.slept).toEqual([]);
    await b.take('fee');
    expect(c.slept).toEqual([250]);
    expect(warned.some((m) => m.includes('at 100% of 4/s'))).toBe(true);
  });

  it('the process role decides when no hook is given', async () => {
    configureProcessRole({ processRole: 'fee' });
    const { b } = down();
    expect(b.localShare).toBe(RPC_LOCAL_SHARE);
    resetProcessRoleForTests();
    configureProcessRole({ processRole: 'all' });
    expect(b.localShare).toBe(1);
  });

  it('Redis down in a split role: 25 % (1/s, burst 2)', async () => {
    const { b, c } = down('fee');
    await b.take('fee');
    await b.take('fee');
    expect(c.slept).toEqual([]);
    await b.take('fee');
    expect(c.slept).toEqual([1000]);
  });
});

describe('RPC budget reqPerSec', () => {
  it('reports 300/s at a steady 300/s for a minute (it was capped at 68.3)', async () => {
    const c = rpcClock();
    const redis = new FakeSharedRedis(c.now);
    const gcra = new RedisGcra(async () => redis as never);
    const b = new RpcBudget({ rpcBudgetPerSec: 100_000 } as never, undefined, { now: c.now, sleep: c.sleep, gcra, role: 'all' });
    for (let s = 0; s < 60; s++) {
      for (let i = 0; i < 300; i++) await b.take('fee');
      c.t += 1000;
    }
    c.t -= 1; // still inside the last second of the window
    expect(b.status().reqPerSec).toBe(300);
    expect(b.status().accounts.default.requests).toBe(18_000);
  });

  it('forgets seconds older than the minute', async () => {
    const c = rpcClock();
    const redis = new FakeSharedRedis(c.now);
    const gcra = new RedisGcra(async () => redis as never);
    const b = new RpcBudget({ rpcBudgetPerSec: 1000 } as never, undefined, { now: c.now, sleep: c.sleep, gcra, role: 'all' });
    for (let i = 0; i < 60; i++) await b.take('fee');
    expect(b.status().reqPerSec).toBe(1);
    c.t += 60_000;
    expect(b.status().reqPerSec).toBe(0);
    await b.take('fee');
    expect(b.status().reqPerSec).toBe(0); // 1 in the minute → rounds to 0.0
    c.t += 30_000;
    for (let i = 0; i < 59; i++) await b.take('fee');
    expect(b.status().reqPerSec).toBe(1);
  });
});

// ── 5. indexer interactive reserve by role ────────────────────────────────────

const URL_ = 'https://indexer.example.test/v1/graphql';

describe('indexer in-flight reserve follows the role', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(new Date('2026-10-04T12:00:00Z'));
  });
  afterEach(() => {
    __resetIndexerGateways();
    __resetIndexerMeters();
  });

  /** Concurrent background calls the gateway lets through (enforce, ample budget). */
  async function backgroundSlots(config: Partial<IndexerGatewayConfig>): Promise<number> {
    const gateway = new IndexerGateway(
      URL_,
      { ...DEFAULT_INDEXER_GATEWAY_CONFIG, mode: 'enforce', budgetPerMin: 60_000, backgroundMaxPerMin: 60_000, ...config },
      new IndexerMeter(URL_),
    );
    let started = 0;
    const ctx = (lane: IndexerLane): IndexerContext => ({ lane, job: 'j' });
    for (let i = 0; i < 20; i++) {
      void gateway
        .run(ctx('refresh'), () => {
          started += 1;
          return new Promise<GatewaySettled>(() => {});
        })
        .catch(() => undefined);
    }
    await vi.advanceTimersByTimeAsync(0);
    return started;
  }

  it('role defaults: all 4, api 1, the rest 0', () => {
    expect(defaultInteractiveReservedInFlight('all')).toBe(4);
    expect(defaultInteractiveReservedInFlight('api')).toBe(1);
    for (const role of ['sync', 'fee', 'feeder'] as const) expect(defaultInteractiveReservedInFlight(role)).toBe(0);
  });

  it('`all` (today): 12 slots, 4 reserved → 8 background', async () => {
    expect(await backgroundSlots({ maxInFlight: 12, interactiveReservedInFlight: 4 })).toBe(8);
  });

  it('sync role: every slot is a background slot, even with the env reserve of 4', async () => {
    configureProcessRole({ processRole: 'sync' });
    expect(await backgroundSlots({ maxInFlight: 6, interactiveReservedInFlight: 4 })).toBe(6);
  });

  it('fee / feeder roles likewise', async () => {
    configureProcessRole({ processRole: 'fee' });
    expect(await backgroundSlots({ maxInFlight: 2, interactiveReservedInFlight: 4 })).toBe(2);
  });

  it('api role keeps its reserve (role default 1 of 3 → 2 background)', async () => {
    configureProcessRole({ processRole: 'api' });
    expect(await backgroundSlots({ maxInFlight: 3, interactiveReservedInFlight: defaultInteractiveReservedInFlight('api') })).toBe(2);
  });

  it('an explicit servesInteractive wins over the role', async () => {
    configureProcessRole({ processRole: 'sync' });
    expect(await backgroundSlots({ maxInFlight: 6, interactiveReservedInFlight: 4, servesInteractive: true })).toBe(2);
  });
});
