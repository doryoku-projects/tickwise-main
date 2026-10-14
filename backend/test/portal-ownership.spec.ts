import 'reflect-metadata';
import { ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ClientsService } from '../src/billing/clients.service.js';
import { CustomerAuthService } from '../src/portal/customer-auth.service.js';
import { CustomerSelfService } from '../src/portal/customer-self.service.js';

/**
 * Cross-tenant key access, at the layer that actually decides it.
 *
 * These assert on the MONGO FILTER the service builds, not just on the value
 * returned: the filter IS the authorization. A `findById(keyId)` followed by a
 * JS owner comparison could be made to return the same 404 while still leaving
 * a TOCTOU window, so "the customerId reached the query" is the property worth
 * pinning. The real `ClientsService` is used (only the model is stubbed) —
 * asserting against a stubbed service would test nothing.
 */

const CUSTOMER_A = '507f1f77bcf86cd799439011';
const CUSTOMER_B = '507f1f77bcf86cd799439012';
const KEY_OF_B = '507f191e810c19729de860ea';

interface CapturedQuery {
  op: 'findOneAndUpdate' | 'findOneAndDelete';
  filter: { _id?: unknown; customerId?: unknown };
  update?: unknown;
}

const PLAN = {
  key: 'standard',
  name: 'Standard',
  monthlyUnits: 5_000_000,
  rateLimitPerMin: 300,
  price: 99,
  enabled: true,
  selfServe: true,
  maxApiKeys: 5,
  allowBrowserKeys: true,
  description: '',
  features: [],
  prices: [],
};

/**
 * The portal facade over a real `ClientsService` whose api-keys model records
 * every filter it is handed. The stored key belongs to customer B.
 */
function buildStack(opts: { plan?: unknown; activeKeys?: number } = {}) {
  const queries: CapturedQuery[] = [];
  const stored = {
    _id: KEY_OF_B,
    customerId: CUSTOMER_B,
    keyPrefix: 'kc_live_bbbbbbbb',
    keyHash: 'never-leaves-the-database',
    label: 'B production',
    status: 'active',
    keyType: 'server',
    allowedOrigins: [],
  };
  const matches = (filter: CapturedQuery['filter']) =>
    String(filter._id) === stored._id && String(filter.customerId) === stored.customerId;

  const apiKeys = {
    findOneAndUpdate: (filter: CapturedQuery['filter'], update: unknown) => {
      queries.push({ op: 'findOneAndUpdate', filter, update });
      const hit = matches(filter) ? { ...stored, ...(update as Record<string, unknown>) } : null;
      return { lean: () => ({ exec: async () => hit }) };
    },
    findOneAndDelete: (filter: CapturedQuery['filter']) => {
      queries.push({ op: 'findOneAndDelete', filter });
      return { lean: () => ({ exec: async () => (matches(filter) ? stored : null) }) };
    },
    countDocuments: () => ({ exec: async () => opts.activeKeys ?? 0 }),
    create: async (doc: Record<string, unknown>) => ({ _id: 'newkey', ...doc }),
  };
  const customers = {
    findById: () => ({ lean: () => ({ exec: async () => ({ _id: CUSTOMER_A, status: 'active', planKey: 'standard' }) }) }),
  };

  const clients = new ClientsService(customers as never, apiKeys as never, {} as never);
  // `'plan' in opts` so a test can pass `plan: undefined` to model a DELETED plan.
  const settings = { getPlan: () => ('plan' in opts ? opts.plan : PLAN) };
  return { self: new CustomerSelfService(clients as never, settings as never), queries };
}

describe('portal key ownership', () => {
  it('refuses to revoke another customer’s key, and scopes the query to the caller', async () => {
    const { self, queries } = buildStack();

    await expect(self.revokeKey(CUSTOMER_A, KEY_OF_B)).rejects.toBeInstanceOf(NotFoundException);

    expect(queries).toHaveLength(1);
    // The security property: the caller's id went INTO the filter, so the write
    // could never have matched B's row.
    expect(String(queries[0].filter.customerId)).toBe(CUSTOMER_A);
    expect(String(queries[0].filter._id)).toBe(KEY_OF_B);
  });

  it('refuses to delete another customer’s key, and scopes the query to the caller', async () => {
    const { self, queries } = buildStack();

    await expect(self.deleteKey(CUSTOMER_A, KEY_OF_B)).rejects.toBeInstanceOf(NotFoundException);

    expect(queries).toHaveLength(1);
    expect(queries[0].op).toBe('findOneAndDelete');
    expect(String(queries[0].filter.customerId)).toBe(CUSTOMER_A);
  });

  it('refuses to re-origin another customer’s browser key', async () => {
    // The nastiest variant: without the owner in the filter this would let one
    // tenant point a competitor's browser key at their own domain.
    const { self, queries } = buildStack();

    await expect(
      self.setKeyOrigins(CUSTOMER_A, 'standard', KEY_OF_B, ['https://attacker.example.com']),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(String(queries[0].filter.customerId)).toBe(CUSTOMER_A);
  });

  it('lets the owner revoke their own key and never returns the hash', async () => {
    const { self, queries } = buildStack();

    const result = await self.revokeKey(CUSTOMER_B, KEY_OF_B);

    expect(String(queries[0].filter.customerId)).toBe(CUSTOMER_B);
    expect(result).toEqual({
      id: KEY_OF_B,
      label: 'B production',
      prefix: 'kc_live_bbbbbbbb',
      keyType: 'server',
      allowedOrigins: [],
      status: 'revoked',
      createdAt: undefined,
      lastUsedAt: null,
    });
    // The portal projection drops everything that isn't the customer's business.
    expect(result).not.toHaveProperty('keyHash');
    expect(result).not.toHaveProperty('customerId');
  });

  it('returns 404 (not 500) for a malformed key id, without confirming existence', async () => {
    const { self, queries } = buildStack();

    await expect(self.revokeKey(CUSTOMER_A, 'not-an-object-id')).rejects.toBeInstanceOf(NotFoundException);
    expect(queries).toHaveLength(0); // never reached the database
  });
});

describe('portal plan ceilings', () => {
  it('refuses a browser key on a plan that does not allow them', async () => {
    const { self } = buildStack({ plan: { ...PLAN, allowBrowserKeys: false } });

    await expect(
      self.createKey(CUSTOMER_A, 'standard', { keyType: 'browser', origins: ['https://app.example.com'] }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a new key once the plan’s active-key ceiling is reached', async () => {
    const { self } = buildStack({ plan: { ...PLAN, maxApiKeys: 1 }, activeKeys: 1 });

    await expect(self.createKey(CUSTOMER_A, 'standard', { label: 'second' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('issues under the ceiling and hands back the raw secret exactly once', async () => {
    const { self } = buildStack({ plan: { ...PLAN, maxApiKeys: 1 }, activeKeys: 0 });

    const issued = await self.createKey(CUSTOMER_A, 'standard', { label: 'first' });

    expect(issued.key.startsWith('kc_live_')).toBe(true);
    expect(issued.prefix).toBe(issued.key.slice(0, 16));
    expect(issued.keyType).toBe('server');
    expect(issued).not.toHaveProperty('keyHash');
  });

  it('falls back to the tightest ceiling when the plan no longer exists', async () => {
    // A deleted plan must not unlock unlimited keys or browser keys.
    const { self } = buildStack({ plan: undefined, activeKeys: 1 });

    await expect(
      self.createKey(CUSTOMER_A, 'ghost', { keyType: 'browser', origins: ['https://x.example.com'] }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

/**
 * Setting origins is the OTHER way to produce a browser key: `setKeyOriginsOwned`
 * rewrites `keyType` from the list alone. Gating only `createKey` left a
 * two-step bypass of the whole plan ceiling — issue a `server` key (allowed on
 * every plan), then PATCH an origin onto it — so the ceiling has to hold on
 * both paths, and it has to hold on the SERVER: the portal hiding the button is
 * cosmetic.
 */
describe('portal browser-key ceiling on the origins path', () => {
  const FREE = { ...PLAN, key: 'free', allowBrowserKeys: false };

  it('refuses to re-origin a key into a browser key on a plan without them', async () => {
    const { self, queries } = buildStack({ plan: FREE });

    await expect(
      self.setKeyOrigins(CUSTOMER_B, 'free', KEY_OF_B, ['https://app.example.com']),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // Refused BEFORE the write: the stored key is still whatever it was.
    expect(queries).toHaveLength(0);
  });

  it('refuses even when only one entry of a longer list would bind', async () => {
    const { self, queries } = buildStack({ plan: FREE });

    await expect(
      self.setKeyOrigins(CUSTOMER_B, 'free', KEY_OF_B, [
        'https://a.example.com',
        'https://b.example.com',
      ]),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(queries).toHaveLength(0);
  });

  it('still lets a plan without browser keys CLEAR origins back to a server key', async () => {
    // Clearing only ever removes an entitlement — a customer who downgrades
    // must not be stuck holding a browser key they cannot turn off.
    const { self, queries } = buildStack({ plan: FREE });

    const result = await self.setKeyOrigins(CUSTOMER_B, 'free', KEY_OF_B, []);

    expect(result.keyType).toBe('server');
    expect(result.allowedOrigins).toEqual([]);
    expect(queries).toHaveLength(1);
    expect(String(queries[0].filter.customerId)).toBe(CUSTOMER_B);
  });

  it('allows the re-origin on a plan that does include browser keys', async () => {
    const { self } = buildStack(); // PLAN.allowBrowserKeys === true

    const result = await self.setKeyOrigins(CUSTOMER_B, 'standard', KEY_OF_B, [
      'https://app.example.com',
    ]);

    expect(result.keyType).toBe('browser');
    expect(result.allowedOrigins).toEqual(['https://app.example.com']);
  });

  it('fails closed on the origins path when the plan no longer exists', async () => {
    const { self, queries } = buildStack({ plan: undefined });

    await expect(
      self.setKeyOrigins(CUSTOMER_B, 'ghost', KEY_OF_B, ['https://app.example.com']),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(queries).toHaveLength(0);
  });
});

describe('portal signup entitlement', () => {
  /**
   * The rule that separates a business from a giveaway: a `planKey` in the
   * signup body grants access ONLY when the plan costs nothing. Anything
   * payable is remembered as `intendedPlanKey`, which grants nothing.
   */
  const PLANS: Record<string, unknown> = {
    free: { key: 'free', name: 'Free', monthlyUnits: 50_000, rateLimitPerMin: 60, price: 0, enabled: true, selfServe: true, maxApiKeys: 1, allowBrowserKeys: false, description: '', features: [], prices: [] },
    pro: { ...PLAN, key: 'pro', name: 'Pro', price: 790, prices: [{ id: 'pro_monthly', interval: 'month', intervalCount: 1, unitAmountMinor: 79_000, currency: 'USD', active: true }] },
    // Headline price 0 but a real annual price row — must NOT be granted.
    sneaky: { ...PLAN, key: 'sneaky', price: 0, prices: [{ id: 'sneaky_annual', interval: 'year', intervalCount: 1, unitAmountMinor: 99_000, currency: 'USD', active: true }] },
    retired: { ...PLAN, key: 'retired', price: 0, enabled: false, prices: [] },
  };

  function buildAuth() {
    let created: Record<string, unknown> | undefined;
    const customers = {
      findOne: () => ({ lean: () => ({ exec: async () => null }) }),
      create: async (doc: Record<string, unknown>) => ((created = doc), { _id: '507f1f77bcf86cd799439099', ...doc }),
    };
    const jwt = { signAsync: async () => 'signed.customer.token' };
    const settings = { getPlan: (key: string) => PLANS[key] };
    const config = { isProduction: false } as never;
    const service = new CustomerAuthService(customers as never, jwt as never, settings as never, config);
    return { service, createdDoc: () => created };
  }

  it('grants a free plan asked for at signup', async () => {
    const { service, createdDoc } = buildAuth();

    const result = await service.signup('New@Example.com ', 'a-good-password', 'free');

    expect(createdDoc()).toMatchObject({ planKey: 'free', email: 'new@example.com', origin: 'self_serve' });
    expect(createdDoc()?.intendedPlanKey).toBeUndefined();
    expect(result.customer.planKey).toBe('free');
  });

  it('does NOT grant a PAID plan asked for at signup — it only records the intent', async () => {
    const { service, createdDoc } = buildAuth();

    const result = await service.signup('buyer@example.com', 'a-good-password', 'pro');

    expect(createdDoc()).toMatchObject({ planKey: 'free', intendedPlanKey: 'pro' });
    expect(result.customer.planKey).toBe('free');
  });

  it('does NOT grant a plan whose headline price is 0 but which has a payable price row', async () => {
    const { service, createdDoc } = buildAuth();

    await service.signup('buyer@example.com', 'a-good-password', 'sneaky');

    expect(createdDoc()).toMatchObject({ planKey: 'free', intendedPlanKey: 'sneaky' });
  });

  it('ignores an unknown or retired plan key rather than failing the signup', async () => {
    for (const key of ['ghost', 'retired']) {
      const { service, createdDoc } = buildAuth();
      await service.signup('buyer@example.com', 'a-good-password', key);
      expect(createdDoc()?.planKey).toBe('free');
      expect(createdDoc()?.intendedPlanKey).toBeUndefined();
    }
  });

  it('never returns the password hash, even though create() is not subject to select:false', async () => {
    const { service, createdDoc } = buildAuth();

    const result = await service.signup('buyer@example.com', 'a-good-password');

    // The hash IS written…
    expect(typeof createdDoc()?.passwordHash).toBe('string');
    // …and is nowhere in the response.
    expect(JSON.stringify(result)).not.toContain(String(createdDoc()?.passwordHash));
    expect(result.customer).toEqual({
      id: '507f1f77bcf86cd799439099',
      email: 'buyer@example.com',
      planKey: 'free',
      // NULL, not a timestamp. Signup used to stamp `emailVerifiedAt` whenever
      // verification was switched off, which asserted an address nobody had
      // proved — and SSO trusted that assertion, making pre-registration account
      // takeover possible. An unproven address must read as unproven.
      emailVerifiedAt: null,
      // Signup's own address is not a "claim" — it goes straight to `email`
      // because it is the login identifier. Only an address added LATER via
      // PATCH /account/profile is staged in `pendingEmail`.
      pendingEmail: null,
      status: 'active',
    });
  });

  /**
   * Signup is anonymous, unauthenticated AND expensive: `hashPassword` is
   * scrypt, which runs synchronously on the single event loop, so an unthrottled
   * signup route is a credential-free way to stall every other request in the
   * process — metered `/v1` included. The budget keys on the CLIENT IP; keying
   * on the email would throttle nothing, since the attacker picks it.
   */
  describe('anonymous signup throttle', () => {
    const IP = '203.0.113.7';
    const BUDGET = 5;

    /** 201-ish on success, else the HTTP status the service refused with. */
    async function signupStatus(
      service: CustomerAuthService,
      email: string,
      ip?: string,
    ): Promise<number> {
      try {
        await service.signup(email, 'a-good-password', undefined, ip);
        return 201;
      } catch (err) {
        return err instanceof HttpException ? err.getStatus() : -1;
      }
    }

    it('throttles a varied-email flood from a single IP', async () => {
      const { service } = buildAuth();

      for (let i = 0; i < BUDGET; i += 1) {
        expect(await signupStatus(service, `flood-${i}@example.com`, IP)).toBe(201);
      }

      // Sixth attempt, sixth DISTINCT email, same network — the email is not
      // what is being counted.
      await expect(
        service.signup('flood-5@example.com', 'a-good-password', undefined, IP),
      ).rejects.toMatchObject({
        response: { error: 'Too many signup attempts. Try again later.' },
      });
    });

    it('never spends another network’s budget', async () => {
      const { service } = buildAuth();
      for (let i = 0; i < BUDGET; i += 1) {
        await signupStatus(service, `a-${i}@example.com`, IP);
      }
      expect(await signupStatus(service, 'a-5@example.com', IP)).toBe(429);

      expect(await signupStatus(service, 'b-0@example.com', '198.51.100.4')).toBe(201);
    });

    it('counts ::ffff:-mapped IPv4 as the same client as its bare form', async () => {
      // A dual-stack socket reports an IPv4 client as `::ffff:1.2.3.4`; if the
      // two spellings landed in different buckets the budget would silently
      // double for anyone who could provoke both.
      const { service } = buildAuth();
      for (let i = 0; i < BUDGET; i += 1) {
        await signupStatus(service, `dual-${i}@example.com`, '::ffff:203.0.113.9');
      }

      expect(await signupStatus(service, 'dual-5@example.com', '203.0.113.9')).toBe(429);
    });

    it('degrades to a per-email budget — not one shared bucket — with no usable IP', async () => {
      // The failure mode to avoid: every IP-less request sharing one key, so
      // five of them lock out every honest signup for an hour. `'::'`, blank
      // and absent all mean "no idea who this is".
      const { service } = buildAuth();
      for (let i = 0; i < BUDGET; i += 1) {
        expect(await signupStatus(service, 'repeat@example.com', '::')).toBe(201);
      }
      expect(await signupStatus(service, 'repeat@example.com', undefined)).toBe(429);

      expect(await signupStatus(service, 'someone-else@example.com', '   ')).toBe(201);
    });
  });
});
