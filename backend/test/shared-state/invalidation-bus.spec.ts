/*
 * P2.2 §3.2 — the cache invalidation bus and the caches it serves.
 *
 * Off (default): no publish, no subscribe, no connection — today. Redis: a
 * change on one replica reaches the others through a LOCAL-ONLY apply path,
 * a process drops its own echo, nothing re-publishes, malformed messages are
 * ignored, and a resolve that STARTED before an invalidation is not cached.
 */
import 'reflect-metadata';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateApiKey, hashApiKey } from '../../src/billing/api-key.util.js';
import { ClientsService } from '../../src/billing/clients.service.js';
import { MeteringService } from '../../src/billing/metering.service.js';
import { isOnlyDuplicateKeyErrors, SettingsCacheService } from '../../src/billing/settings-cache.service.js';
import { InvalidationBus, invalidationChannel, parseInvalidation } from '../../src/common/invalidation-bus.js';
import { FakePubSubHub, FakeSharedRedis, fakeSource } from './fake-redis.js';

const KEY_ID = '6650bbbbbbbbbbbbbbbbbbbb';
const CUSTOMER_ID = '6650aaaaaaaaaaaaaaaaaaaa';

function quiet<T>(svc: T): T {
  (svc as unknown as { logger: Record<string, () => void> }).logger = { log: () => {}, warn: () => {}, error: () => {} };
  return svc;
}

/** Two "processes" on one Redis: each gets its own bus over the shared hub. */
function fleet(mode: 'redis' | 'off' = 'redis') {
  const hub = new FakePubSubHub();
  const redis = new FakeSharedRedis(Date.now, hub);
  const make = () => quiet(new InvalidationBus({ cacheInvalidation: mode } as never, fakeSource(redis, 'ns1') as never));
  return { hub, redis, make };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** A ClientsService whose key read can be held open (to race an invalidation into it). */
function clients(bus?: InvalidationBus) {
  const raw = generateApiKey().raw;
  const keyDoc = {
    _id: KEY_ID,
    customerId: CUSTOMER_ID,
    keyHash: hashApiKey(raw),
    keyPrefix: 'kc_live_abcd',
    label: 'ci',
    status: 'active',
    allowedOrigins: [] as string[],
  };
  const reads = { keys: 0, origins: 0 };
  let gate: Promise<void> | undefined;
  const apiKeys = {
    findOne: () => ({
      exec: async () => {
        reads.keys++;
        if (gate) await gate;
        return { ...keyDoc };
      },
    }),
    distinct: () => ({
      exec: async () => {
        reads.origins++;
        if (gate) await gate;
        return ['https://a.example'];
      },
    }),
    updateOne: () => ({ exec: async () => undefined }),
    findByIdAndUpdate: () => ({ lean: () => ({ exec: async () => ({ ...keyDoc }) }) }),
  };
  const customers = {
    findById: () => ({ lean: () => ({ exec: async () => ({ _id: CUSTOMER_ID, status: 'active', planKey: 'pro' }) }) }),
  };
  const service = new ClientsService(customers as never, apiKeys as never, {} as never, {} as never, {} as never, bus);
  const hold = () => {
    let release!: () => void;
    gate = new Promise<void>((r) => (release = r));
    return () => {
      gate = undefined;
      release();
    };
  };
  return { service, raw, keyDoc, reads, hold };
}

describe('message parsing', () => {
  const base = { v: 1, src: 'p1', seq: 1, at: 1 };
  it('accepts the four message types', () => {
    expect(parseInvalidation(JSON.stringify({ ...base, t: 'apikey', keyHash: 'h' }))).toMatchObject({ t: 'apikey', keyHash: 'h' });
    expect(parseInvalidation(JSON.stringify({ ...base, t: 'apikey', customerId: 'c' }))).toMatchObject({ customerId: 'c' });
    expect(parseInvalidation(JSON.stringify({ ...base, t: 'apikey', all: true }))).toMatchObject({ all: true });
    expect(parseInvalidation(JSON.stringify({ ...base, t: 'origins' }))).toMatchObject({ t: 'origins' });
    expect(parseInvalidation(JSON.stringify({ ...base, t: 'settings' }))).toMatchObject({ t: 'settings' });
    expect(parseInvalidation(JSON.stringify({ ...base, t: 'plan', planKey: 'pro' }))).toMatchObject({ planKey: 'pro' });
  });

  it('ignores malformed messages — never reads one as "forget everything"', () => {
    for (const raw of [
      'not json',
      'null',
      JSON.stringify({ ...base, v: 2, t: 'settings' }),
      JSON.stringify({ ...base, src: '', t: 'settings' }),
      JSON.stringify({ v: 1, t: 'settings' }),
      JSON.stringify({ ...base, t: 'apikey' }),
      JSON.stringify({ ...base, t: 'apikey', all: 'yes' }),
      JSON.stringify({ ...base, t: 'plan' }),
      JSON.stringify({ ...base, t: 'plan', planKey: 7 }),
      JSON.stringify({ ...base, t: 'flush-everything' }),
    ]) {
      expect(parseInvalidation(raw)).toBeUndefined();
    }
  });
});

describe('off (default) = today', () => {
  it('publishes nothing, subscribes nothing, opens no connection', async () => {
    const { hub, redis, make } = fleet('off');
    const bus = make();
    bus.onModuleInit();
    await bus.whenSubscribed();
    bus.publish({ t: 'settings' });
    bus.publish({ t: 'apikey', customerId: 'c' }, { local: true });
    await flush();
    expect(redis.calls).toBe(0);
    expect(hub.subscribers.size).toBe(0);
    expect(new InvalidationBus().enabled).toBe(false);
  });

  it('an unset or unknown CACHE_INVALIDATION is off', () => {
    for (const v of [undefined, '', 'on', 'true', 'memory']) {
      expect(new InvalidationBus({ cacheInvalidation: v } as never).enabled).toBe(false);
    }
  });

  it('local:true runs no handler while off (a payments write behaves as today)', () => {
    const { make } = fleet('off');
    const bus = make();
    const seen: unknown[] = [];
    bus.on('apikey', (m) => void seen.push(m));
    bus.publish({ t: 'apikey', customerId: 'c' }, { local: true });
    expect(seen).toEqual([]);
  });
});

describe('redis: across replicas', () => {
  let a: InvalidationBus;
  let b: InvalidationBus;
  let hub: FakePubSubHub;

  beforeEach(async () => {
    const f = fleet('redis');
    hub = f.hub;
    a = f.make();
    b = f.make();
    a.onModuleInit();
    b.onModuleInit();
    await Promise.all([a.whenSubscribed(), b.whenSubscribed()]);
  });

  it('subscribes to tw:inv:v1:<ns>', () => {
    expect(a.channel).toBe(invalidationChannel('ns1'));
    expect([...hub.subscribers].every((s) => s.channels.has('tw:inv:v1:ns1'))).toBe(true);
  });

  it('a publish on A reaches B through its handler; A drops its own echo', async () => {
    const onA: unknown[] = [];
    const onB: unknown[] = [];
    a.on('plan', (m) => void onA.push(m));
    b.on('plan', (m) => void onB.push(m));
    a.publish({ t: 'plan', planKey: 'pro' });
    await flush();
    expect(onB).toEqual([{ t: 'plan', planKey: 'pro', v: 1, src: a.id, seq: 1, at: expect.any(Number) }]);
    expect(onA).toEqual([]);
    expect(a.stats()).toMatchObject({ published: 1, droppedSelf: 1, received: 0 });
    expect(b.stats()).toMatchObject({ received: 1, droppedSelf: 0 });
  });

  it('local:true also runs this process\'s own handlers (a writer that does not own the cache)', async () => {
    const onA: unknown[] = [];
    a.on('apikey', (m) => void onA.push(m));
    a.publish({ t: 'apikey', customerId: 'c' }, { local: true });
    await flush();
    expect(onA).toEqual([{ t: 'apikey', customerId: 'c' }]); // the local copy, before the wire
    expect(a.stats().droppedSelf).toBe(1); // and its own echo is still dropped
  });

  it('a handler that throws is counted and does not stop the others', async () => {
    const seen: string[] = [];
    b.on('settings', () => {
      throw new Error('boom');
    });
    b.on('settings', () => void seen.push('second'));
    a.publish({ t: 'settings' });
    await flush();
    expect(seen).toEqual(['second']);
    expect(b.stats().handlerErrors).toBe(1);
  });

  it('a malformed message on the channel is counted and ignored', async () => {
    const seen: unknown[] = [];
    b.on('apikey', (m) => void seen.push(m));
    hub.deliver('tw:inv:v1:ns1', JSON.stringify({ v: 1, src: 'x', t: 'apikey' }));
    expect(seen).toEqual([]);
    expect(b.stats().malformed).toBe(1);
  });

  it('a publish while Redis is down is counted and never throws into the caller', async () => {
    const f = fleet('redis');
    f.redis.failing = true;
    const bus = f.make();
    expect(() => bus.publish({ t: 'settings' })).not.toThrow();
    await flush();
    expect(bus.stats().publishFailed).toBe(1);
  });

  it('closes its subscriber at shutdown', async () => {
    await a.onModuleDestroy();
    expect(hub.subscribers.size).toBe(1);
  });
});

describe('ClientsService over the bus', () => {
  let busA: InvalidationBus;
  let busB: InvalidationBus;
  let hub: FakePubSubHub;
  beforeEach(async () => {
    const f = fleet('redis');
    hub = f.hub;
    busA = f.make();
    busB = f.make();
    busA.onModuleInit();
    busB.onModuleInit();
    await Promise.all([busA.whenSubscribed(), busB.whenSubscribed()]);
  });

  it('a revoke on replica A drops replica B\'s cached resolution (no 30 s wait)', async () => {
    const A = clients(busA);
    const B = clients(busB);
    B.keyDoc.keyHash = A.keyDoc.keyHash;
    await B.service.resolveByRawKey(A.raw);
    await B.service.resolveByRawKey(A.raw);
    expect(B.reads.keys).toBe(1); // cached
    await A.service.revokeKey(KEY_ID);
    await flush();
    await B.service.resolveByRawKey(A.raw);
    expect(B.reads.keys).toBe(2); // re-read
  });

  it('applying a remote message never re-publishes (no loop)', async () => {
    const A = clients(busA);
    clients(busB);
    await A.service.revokeKey(KEY_ID);
    await flush();
    // revoke publishes apikey + origins; B applied both and published nothing.
    expect(hub.published.map((p) => JSON.parse(p.message).t)).toEqual(['origins', 'apikey']);
    expect(busB.stats().published).toBe(0);
  });

  it('a plan move published by a non-owner (payments) drops the customer\'s keys everywhere, here included', async () => {
    const A = clients(busA);
    const B = clients(busB);
    await A.service.resolveByRawKey(A.raw);
    await B.service.resolveByRawKey(B.raw);
    busA.publish({ t: 'apikey', customerId: CUSTOMER_ID }, { local: true });
    await flush();
    await A.service.resolveByRawKey(A.raw);
    await B.service.resolveByRawKey(B.raw);
    expect(A.reads.keys).toBe(2);
    expect(B.reads.keys).toBe(2);
  });

  it('origins: a remote change clears the CORS origin set', async () => {
    const A = clients(busA);
    const B = clients(busB);
    await B.service.isRegisteredOrigin('https://a.example');
    await B.service.isRegisteredOrigin('https://a.example');
    expect(B.reads.origins).toBe(1);
    await A.service.setKeyOrigins(KEY_ID, ['https://b.example']);
    await flush();
    await B.service.isRegisteredOrigin('https://a.example');
    expect(B.reads.origins).toBe(2);
  });
});

describe('generations: a load that started before an invalidation is not cached', () => {
  for (const [name, forget] of [
    ['its key hash', (s: ClientsService, hash: string) => s.forgetLocal({ keyHash: hash })],
    ['its customer', (s: ClientsService) => s.forgetLocal({ customerId: CUSTOMER_ID })],
    ['everything', (s: ClientsService) => s.forgetLocal({})],
  ] as const) {
    it(`forgetting ${name} mid-load: served to this request, not cached`, async () => {
      const bus = fleet('redis').make();
      const { service, raw, reads, hold, keyDoc } = clients(bus);
      const release = hold();
      const pending = service.resolveByRawKey(raw);
      await flush();
      forget(service, keyDoc.keyHash);
      release();
      expect(await pending).toMatchObject({ apiKeyId: KEY_ID });
      await service.resolveByRawKey(raw);
      expect(reads.keys).toBe(2);
      expect(bus.stats().staleLoadsNotCached).toBe(1);
    });
  }

  it('control: an unrelated invalidation mid-load does not stop caching', async () => {
    const { service, raw, reads, hold } = clients();
    const release = hold();
    const pending = service.resolveByRawKey(raw);
    await flush();
    service.forgetLocal({ keyHash: 'some-other-hash' });
    service.forgetLocal({ customerId: 'other-customer' });
    release();
    await pending;
    await service.resolveByRawKey(raw);
    expect(reads.keys).toBe(1);
  });

  it('no invalidation: cached as before', async () => {
    const { service, raw, reads } = clients();
    await service.resolveByRawKey(raw);
    await service.resolveByRawKey(raw);
    expect(reads.keys).toBe(1);
  });

  it('an origin change mid-read is not cached', async () => {
    const { service, reads, hold } = clients();
    const release = hold();
    const pending = service.isRegisteredOrigin('https://a.example');
    await flush();
    service.forgetOriginsLocal();
    release();
    expect(await pending).toBe(true);
    await service.isRegisteredOrigin('https://a.example');
    expect(reads.origins).toBe(2);
  });

  it('the per-id stamp maps are bounded: past the cap, everything in flight counts as invalidated', async () => {
    const { service, raw, reads, hold } = clients();
    const release = hold();
    const pending = service.resolveByRawKey(raw);
    await flush();
    for (let i = 0; i <= 10_000; i++) service.forgetLocal({ customerId: `c${i}` });
    release();
    await pending;
    await service.resolveByRawKey(raw);
    expect(reads.keys).toBe(2);
  });
});

describe('settings + metering subscribers', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a remote settings or plan message reloads the settings cache', async () => {
    const f = fleet('redis');
    const a = f.make();
    const b = f.make();
    a.onModuleInit();
    b.onModuleInit();
    await Promise.all([a.whenSubscribed(), b.whenSubscribed()]);
    const finds = { plans: 0 };
    const planModel = { find: () => ({ lean: () => ({ exec: async () => (finds.plans++, []) }) }) };
    const costModel = { find: () => ({ lean: () => ({ exec: async () => [] }) }) };
    new SettingsCacheService(planModel as never, costModel as never, b);
    a.publish({ t: 'settings' });
    a.publish({ t: 'plan', planKey: 'pro' });
    await flush();
    expect(finds.plans).toBe(2);
  });

  it('a remote plan message evicts that plan\'s metering limiters', async () => {
    const f = fleet('redis');
    const a = f.make();
    const b = f.make();
    a.onModuleInit();
    b.onModuleInit();
    await Promise.all([a.whenSubscribed(), b.whenSubscribed()]);
    const metering = new MeteringService({ redisUrl: 'redis://127.0.0.1:1' } as never, {} as never, b);
    const evicted: string[] = [];
    metering.evictPlanLimiter = (key: string) => void evicted.push(key);
    a.publish({ t: 'plan', planKey: 'pro' });
    await flush();
    expect(evicted).toEqual(['pro']);
    metering.onModuleDestroy();
  });
});

describe('seeds tolerate a concurrent boot (E11000)', () => {
  it('isOnlyDuplicateKeyErrors: single dup, bulk of dups → true; anything else → false', () => {
    expect(isOnlyDuplicateKeyErrors({ code: 11000 })).toBe(true);
    expect(isOnlyDuplicateKeyErrors({ writeErrors: [{ code: 11000 }, { err: { code: 11000 } }] })).toBe(true);
    expect(isOnlyDuplicateKeyErrors({ writeErrors: [{ code: 11000 }, { code: 121 }] })).toBe(false);
    expect(isOnlyDuplicateKeyErrors({ code: 13 })).toBe(false);
    expect(isOnlyDuplicateKeyErrors(new Error('network'))).toBe(false);
    expect(isOnlyDuplicateKeyErrors(null)).toBe(false);
  });

  function seeding(insertError?: unknown) {
    const inserts: unknown[] = [];
    const model = {
      estimatedDocumentCount: async () => 0,
      insertMany: async (docs: unknown, opts: unknown) => {
        inserts.push(opts);
        if (insertError) throw insertError;
        return docs;
      },
      find: () => ({ lean: () => ({ exec: async () => [] }) }),
    };
    const svc = quiet(new SettingsCacheService(model as never, model as never));
    return { svc, inserts };
  }

  it('a duplicate-key race on both seeds boots normally', async () => {
    const { svc, inserts } = seeding({ writeErrors: [{ code: 11000 }] });
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
    expect(inserts).toEqual([
      { ordered: false, throwOnValidationError: true },
      { ordered: false, throwOnValidationError: true },
    ]);
  });

  it('any other insert failure still fails the boot', async () => {
    const { svc } = seeding({ code: 13, message: 'unauthorized' });
    await expect(svc.onModuleInit()).rejects.toMatchObject({ code: 13 });
  });
});
