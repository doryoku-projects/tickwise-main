/*
 * P2.2 §3.2 — the writers that publish an invalidation, and the boot seeds
 * that must survive a concurrent boot.
 *
 * Publishers: PlansService (create/update/remove → `plan`), EndpointCostsService
 * (→ `settings`), PaymentApplyService.grantEntitlement and every
 * SubscriptionSweepService plan move (→ `apikey` by customer, also applied
 * locally — those writers do not own the resolve cache). Each is a no-op with
 * the bus absent or off.
 */
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { AuthService } from '../../src/auth/auth.service.js';
import { EndpointCostsService } from '../../src/billing/endpoint-costs.service.js';
import { PlansService } from '../../src/billing/plans.service.js';
import { InvalidationBus, type InvalidationMessage } from '../../src/common/invalidation-bus.js';
import { PaymentApplyService } from '../../src/payments/payment-apply.service.js';
import { SubscriptionSweepService } from '../../src/payments/subscription-sweep.service.js';

/** A bus that records publishes (and their `local` flag) instead of sending them. */
function recordingBus() {
  const sent: Array<{ msg: InvalidationMessage; local: boolean }> = [];
  const bus = {
    publish: (msg: InvalidationMessage, opts: { local?: boolean } = {}) => void sent.push({ msg, local: Boolean(opts.local) }),
    on: () => undefined,
  } as unknown as InvalidationBus;
  return { bus, sent };
}

function quiet<T>(svc: T): T {
  (svc as unknown as { logger: Record<string, () => void> }).logger = { log: () => {}, warn: () => {}, error: () => {} };
  return svc;
}

describe('PlansService publishes plan', () => {
  function plans(bus?: InvalidationBus) {
    const plan = { key: 'pro', name: 'Pro', price: 99, prices: [], __v: 0 };
    const model = {
      findOne: () => ({ lean: () => ({ exec: async () => ({ ...plan }) }) }),
      findOneAndUpdate: () => ({ lean: () => ({ exec: async () => ({ ...plan, name: 'Pro 2' }) }) }),
      findOneAndDelete: () => ({ lean: () => ({ exec: async () => ({ ...plan }) }) }),
    };
    const customers = { countDocuments: () => ({ exec: async () => 0 }) };
    const cache = { refresh: async () => undefined };
    const evicted: string[] = [];
    const metering = { evictPlanLimiter: (k: string) => void evicted.push(k) };
    return { svc: new PlansService(model as never, cache as never, metering as never, customers as never, bus), evicted };
  }

  it('update and remove publish {t:plan} after the local refresh + evict', async () => {
    const { bus, sent } = recordingBus();
    const { svc, evicted } = plans(bus);
    await svc.update('pro', { name: 'Pro 2' } as never);
    await svc.remove('pro');
    expect(evicted).toEqual(['pro', 'pro']);
    expect(sent).toEqual([
      { msg: { t: 'plan', planKey: 'pro' }, local: false },
      { msg: { t: 'plan', planKey: 'pro' }, local: false },
    ]);
  });

  it('no bus → behaves exactly as before', async () => {
    const { svc, evicted } = plans();
    await svc.update('pro', { name: 'Pro 2' } as never);
    expect(evicted).toEqual(['pro']);
  });
});

describe('EndpointCostsService publishes settings', () => {
  it('create and update', async () => {
    const { bus, sent } = recordingBus();
    const row = { routeKey: 'v1.positions.list', unitCost: 2 };
    const model = { findOneAndUpdate: () => ({ lean: () => ({ exec: async () => row }) }) };
    const svc = quiet(new EndpointCostsService(model as never, { refresh: async () => undefined } as never, bus));
    await svc.create({ routeKey: 'v1.positions.list', label: 'List', unitCost: 2 } as never);
    await svc.update('v1.positions.list', { unitCost: 3 } as never);
    expect(sent.map((s) => s.msg)).toEqual([{ t: 'settings' }, { t: 'settings' }]);
  });
});

describe('PaymentApplyService.grantEntitlement', () => {
  function apply(bus?: InvalidationBus) {
    const updates: string[] = [];
    const coll = (name: string) => ({
      updateOne: () => ({ exec: async () => (updates.push(name), { matchedCount: 1, modifiedCount: 1 }) }),
      findById: () => ({ lean: () => ({ exec: async () => null }) }),
    });
    const svc = quiet(
      new PaymentApplyService(
        coll('payments') as never,
        coll('invoices') as never,
        coll('subscriptions') as never,
        coll('customers') as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        bus,
      ),
    );
    return { svc, updates };
  }

  const args = (grant: boolean) => ({
    subscription: { _id: 'sub1', pendingPlanKey: undefined },
    invoice: { _id: 'inv1', customerId: 'cust1', planKey: 'pro', currency: 'USD' },
    decision: {
      subscriptionStatus: 'active',
      ...(grant ? { grant: { planKey: 'pro', priceId: 'pro_monthly', interval: 'month', unitAmountMinor: 9900 } } : {}),
    },
    overpaidMinor: 0,
  });

  it('a plan grant drops the customer\'s cached keys here and on the other replicas', async () => {
    const { bus, sent } = recordingBus();
    const { svc, updates } = apply(bus);
    await (svc as unknown as { grantEntitlement: (a: unknown) => Promise<void> }).grantEntitlement(args(true));
    expect(updates).toEqual(['subscriptions', 'customers']);
    expect(sent).toEqual([{ msg: { t: 'apikey', customerId: 'cust1' }, local: true }]);
  });

  it('no plan grant (a renewal of the same plan) publishes nothing', async () => {
    const { bus, sent } = recordingBus();
    const { svc } = apply(bus);
    await (svc as unknown as { grantEntitlement: (a: unknown) => Promise<void> }).grantEntitlement(args(false));
    expect(sent).toEqual([]);
  });
});

describe('SubscriptionSweepService plan moves', () => {
  function sweep(bus: InvalidationBus, opts: { moved?: boolean; liveSub?: boolean } = {}) {
    const customers = {
      find: () => ({ limit: () => ({ lean: () => ({ exec: async () => [{ _id: 'custH', planKey: 'pro' }] }) }) }),
      updateOne: () => ({ exec: async () => ({ matchedCount: opts.moved === false ? 0 : 1, modifiedCount: opts.moved === false ? 0 : 1 }) }),
    };
    const subscriptions = { findOne: () => ({ lean: () => ({ exec: async () => (opts.liveSub ? { _id: 'live' } : null) }) }) };
    const metering = { resetQuotaPeriod: async () => true };
    const svc = quiet(
      new SubscriptionSweepService(
        subscriptions as never,
        {} as never,
        customers as never,
        {} as never,
        {} as never,
        {} as never,
        metering as never,
        {} as never,
        {} as never,
        {} as never,
        bus,
      ),
    );
    return svc as unknown as {
      healPass: (now: Date, r: Record<string, number>) => Promise<void>;
      dropToFree: (s: unknown, r?: unknown) => Promise<void>;
    };
  }

  it('the self-heal drop to Free publishes for that customer (local + remote)', async () => {
    const { bus, sent } = recordingBus();
    await sweep(bus).healPass(new Date(), { healed: 0, errors: 0 });
    expect(sent).toEqual([{ msg: { t: 'apikey', customerId: 'custH' }, local: true }]);
  });

  it('a heal that finds a live subscription moves nothing and publishes nothing', async () => {
    const { bus, sent } = recordingBus();
    await sweep(bus, { liveSub: true }).healPass(new Date(), { healed: 0, errors: 0 });
    expect(sent).toEqual([]);
  });

  it('dropToFree publishes only when the customer actually moved (an admin plan is kept)', async () => {
    const moved = recordingBus();
    await sweep(moved.bus).dropToFree({ customerId: 'custD' });
    expect(moved.sent).toEqual([{ msg: { t: 'apikey', customerId: 'custD' }, local: true }]);
    const kept = recordingBus();
    await sweep(kept.bus, { moved: false }).dropToFree({ customerId: 'custD' });
    expect(kept.sent).toEqual([]);
  });
});

describe('SubscriptionSweepService scheduled downgrade', () => {
  it('a downgrade applied by the sweep publishes for that customer (local + remote)', async () => {
    const { bus, sent } = recordingBus();
    const sub = {
      _id: 'sub1',
      customerId: 'custS',
      status: 'active',
      planKey: 'pro',
      unitAmountMinor: 9900,
      interval: 'month',
      pendingPlanKey: 'standard',
      pendingPriceId: 'standard_monthly',
    };
    const subscriptions = {
      find: () => ({ limit: () => ({ exec: async () => [sub] }) }),
      updateOne: () => ({ exec: async () => ({ matchedCount: 1, modifiedCount: 1 }) }),
    };
    const customers = { updateOne: () => ({ exec: async () => ({ matchedCount: 1, modifiedCount: 1 }) }) };
    const plans = {
      getByKey: async () => ({
        key: 'standard',
        name: 'Standard',
        prices: [{ id: 'standard_monthly', interval: 'month', intervalCount: 1, unitAmountMinor: 1900, currency: 'USD', active: true }],
      }),
    };
    const svc = quiet(
      new SubscriptionSweepService(
        subscriptions as never,
        {} as never,
        customers as never,
        {} as never,
        plans as never,
        {} as never,
        { resetQuotaPeriod: async () => true } as never,
        {} as never,
        {} as never,
        {} as never,
        bus,
      ),
    );
    const report = { planChangesApplied: 0, errors: 0 };
    await (svc as unknown as { scheduledChangePass: (n: Date, r: unknown) => Promise<void> }).scheduledChangePass(new Date(), report);
    expect(report).toEqual({ planChangesApplied: 1, errors: 0 });
    expect(sent).toEqual([{ msg: { t: 'apikey', customerId: 'custS' }, local: true }]);
  });
});

describe('admin seed tolerates a concurrent boot', () => {
  function seeded(createError?: unknown) {
    const adminUsers = {
      findOne: () => ({ lean: () => ({ exec: async () => null }) }),
      create: async () => {
        if (createError) throw createError;
        return {};
      },
    };
    const config = { adminEmail: 'ops@x.io', adminPassword: 'correct-horse-battery' };
    return quiet(new AuthService(adminUsers as never, {} as never, config as never));
  }

  it('E11000 on the insert = another process seeded it → boot continues', async () => {
    await expect(seeded({ code: 11000 }).onModuleInit()).resolves.toBeUndefined();
  });

  it('any other failure still fails the boot', async () => {
    await expect(seeded({ code: 13 }).onModuleInit()).rejects.toMatchObject({ code: 13 });
  });

  it('the normal path still seeds', async () => {
    await expect(seeded().onModuleInit()).resolves.toBeUndefined();
  });
});
