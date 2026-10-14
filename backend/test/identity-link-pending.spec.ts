import 'reflect-metadata';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE PENDING-LINK CEREMONY — what an SSO email collision does instead of
 * dead-ending on `?error=email_in_use`.
 *
 * A collision is not an error, it is a fork: the provider has proved the address,
 * so ask the human to prove the ACCOUNT by signing in to it, then attach the
 * provider. That satisfies both halves of rule (b) SEQUENTIALLY rather than
 * simultaneously, and these tests exist to pin the parts of it that are security
 * properties rather than UX:
 *
 *  - the ceremony is offered ONLY when the PROVIDER verified the address (an
 *    unverified provider email is attacker-typed text — offering "sign in to
 *    connect m•••@corp.com" for one turns our own login page into a lure);
 *  - never for a SUSPENDED holder (it would confirm the account exists and hand
 *    a suspended tenant a fresh way in);
 *  - the token is binder-bound, single-use and expiring, because it travels in a
 *    redirect URL (browser history, the next `Referer`, our own access log);
 *  - it can only ever land on the account that held the colliding address.
 *
 * Run against the REAL `OauthStateService` + `IdentityService` — only Redis and
 * Mongo are in-memory — because every one of those guarantees is structural.
 */

const redisMock = vi.hoisted(() => ({
  store: new Map<string, string>(),
  /** Every `SET` as `[key, ttlSeconds]`, so the TTL contract is assertable. */
  writes: [] as Array<[string, number]>,
  commands: [] as string[],
}));

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    quit: vi.fn(async () => undefined),
    set: async (key: string, value: string, _mode: string, ttl: number) => {
      redisMock.commands.push('set');
      redisMock.writes.push([key, ttl]);
      redisMock.store.set(key, value);
      return 'OK';
    },
    get: async (key: string) => {
      redisMock.commands.push('get');
      return redisMock.store.get(key) ?? null;
    },
    getdel: async (key: string) => {
      redisMock.commands.push('getdel');
      const value = redisMock.store.get(key) ?? null;
      redisMock.store.delete(key);
      return value;
    },
    multi: () => {
      const ops: Array<[string, string]> = [];
      const chain = {
        get(key: string) {
          ops.push(['get', key]);
          return chain;
        },
        del(key: string) {
          ops.push(['del', key]);
          return chain;
        },
        exec: async () =>
          ops.map(([op, key]) => {
            if (op === 'get') return [null, redisMock.store.get(key) ?? null];
            return [null, redisMock.store.delete(key) ? 1 : 0];
          }),
      };
      return chain;
    },
  })),
}));

const { IdentityService } = await import('../src/identity/identity.service.js');
const {
  LINK_BINDER_COOKIE,
  OAUTH_BINDER_COOKIE,
  OauthStateService,
  readBinderCookie,
  readLinkBinderCookie,
} = await import('../src/identity/oauth-state.service.js');

const PENDING_LINK_PREFIX = 'sso:oauth:pendinglink:';
/** The customer that already holds the colliding address. */
const HOLDER = '507f1f77bcf86cd799439011';
/** Somebody else, signed in to their own account. */
const STRANGER = '507f1f77bcf86cd799439012';

interface CustomerDoc {
  _id: string;
  name?: string;
  email?: string;
  pendingEmail?: string;
  planKey: string;
  status: 'active' | 'suspended';
  passwordHash?: string;
  emailVerifiedAt?: Date;
  emailVerificationTokenHash?: string;
  emailVerificationExpiresAt?: Date;
  lastLoginAt?: Date;
}

interface IdentityDoc {
  _id: string;
  customerId: string;
  provider: string;
  subject: string;
  email?: string;
  emailVerified?: boolean;
  displayName?: string;
  linkedAt?: Date;
  lastLoginAt?: Date;
}

function matches(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, value]) => String(doc[key]) === String(value));
}

/** `$set` and `$unset` — the ceremony's stamp uses both. */
function applyUpdate(doc: Record<string, unknown>, update: Record<string, unknown>): void {
  for (const [key, value] of Object.entries((update.$set ?? {}) as Record<string, unknown>)) {
    doc[key] = value;
  }
  for (const key of Object.keys((update.$unset ?? {}) as Record<string, unknown>)) {
    delete doc[key];
  }
}

function duplicateKey(): Error {
  return Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
}

interface StubProfile {
  subject: string;
  email?: string;
  emailVerified: boolean;
  displayName?: string;
}

function buildStack(seed: { customers?: CustomerDoc[]; identities?: IdentityDoc[] } = {}) {
  const customers: CustomerDoc[] = [...(seed.customers ?? [])];
  const identities: IdentityDoc[] = [...(seed.identities ?? [])];
  let generated = 0;
  const nextId = () => `6650000000000000000000${(generated += 1).toString().padStart(2, '0')}`;

  const identityModel = {
    findOne: (filter: Record<string, unknown>) => ({
      lean: () => ({ exec: async () => identities.find((row) => matches(row, filter)) ?? null }),
    }),
    find: (filter: Record<string, unknown>) => ({
      sort: () => ({ lean: () => ({ exec: async () => identities.filter((row) => matches(row, filter)) }) }),
    }),
    countDocuments: (filter: Record<string, unknown>) => ({
      exec: async () => identities.filter((row) => matches(row, filter)).length,
    }),
    create: async (doc: Record<string, unknown>) => {
      if (identities.some((row) => row.provider === doc.provider && row.subject === doc.subject)) {
        throw duplicateKey();
      }
      const row = { ...doc, _id: String(doc._id ?? nextId()), customerId: String(doc.customerId) } as IdentityDoc;
      identities.push(row);
      return row;
    },
    updateOne: (filter: Record<string, unknown>, update: Record<string, unknown>) => {
      const hit = identities.find((row) => matches(row, filter));
      if (hit) applyUpdate(hit as unknown as Record<string, unknown>, update);
      return { exec: async () => ({ matchedCount: hit ? 1 : 0 }) };
    },
    findOneAndUpdate: (
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
      options: { upsert?: boolean } = {},
    ) => ({
      lean: () => ({
        exec: async () => {
          const hit = identities.find((row) => matches(row, filter));
          if (hit) {
            applyUpdate(hit as unknown as Record<string, unknown>, update);
            return hit;
          }
          if (!options.upsert) return null;
          // The unique {provider, subject} index has the last word.
          if (identities.some((row) => row.provider === filter.provider && row.subject === filter.subject)) {
            throw duplicateKey();
          }
          const row = {
            _id: nextId(),
            ...filter,
            ...(update.$setOnInsert as Record<string, unknown>),
            ...(update.$set as Record<string, unknown>),
            customerId: String(filter.customerId),
          } as IdentityDoc;
          identities.push(row);
          return row;
        },
      }),
    }),
    findOneAndDelete: (filter: Record<string, unknown>) => ({
      lean: () => ({
        exec: async () => {
          const index = identities.findIndex((row) => matches(row, filter));
          return index < 0 ? null : identities.splice(index, 1)[0];
        },
      }),
    }),
    deleteOne: (filter: Record<string, unknown>) => {
      const index = identities.findIndex((row) => matches(row, filter));
      if (index >= 0) identities.splice(index, 1);
      return { exec: async () => ({ deletedCount: index < 0 ? 0 : 1 }) };
    },
  };

  const customerModel = {
    findOne: (filter: Record<string, unknown>) => ({
      lean: () => ({ exec: async () => customers.find((row) => matches(row, filter)) ?? null }),
    }),
    findById: (id: unknown) => {
      const hit = customers.find((row) => row._id === String(id));
      return {
        select: () => ({ lean: () => ({ exec: async () => hit ?? null }) }),
        lean: () => ({ exec: async () => hit ?? null }),
      };
    },
    create: async (doc: Record<string, unknown>) => {
      if (typeof doc.email === 'string' && customers.some((row) => row.email === doc.email)) {
        throw duplicateKey();
      }
      const row = { status: 'active', ...doc, _id: String(doc._id ?? nextId()) } as CustomerDoc;
      customers.push(row);
      return row;
    },
    updateOne: (filter: Record<string, unknown>, update: Record<string, unknown>) => {
      const hit = customers.find((row) => matches(row, filter));
      if (hit) applyUpdate(hit as unknown as Record<string, unknown>, update);
      return { exec: async () => ({ matchedCount: hit ? 1 : 0 }) };
    },
  };

  const config = {
    redisUrl: 'redis://127.0.0.1:6379',
    portalBaseUrl: 'https://portal.example.com',
    oauthCallbackBaseUrl: 'https://api.example.com',
    isProduction: false,
  };

  let profile: StubProfile = {
    subject: 'google-owner',
    email: 'alice@example.com',
    emailVerified: true,
    displayName: 'Alice',
  };
  const provider = {
    id: 'google' as const,
    label: 'Google',
    defaultScopes: [],
    isEnabled: () => true,
    buildAuthorizeUrl: (args: { state: string }) =>
      `https://accounts.example.com/authorize?state=${args.state}`,
    exchangeCode: async () => ({ accessToken: 'provider-access-token' }),
    fetchProfile: async () => profile,
  };
  const registry = {
    has: (id: string) => id === 'google',
    resolve: (id: string) => {
      if (id !== 'google') throw new NotFoundException({ error: 'Unknown provider' });
      return provider;
    },
    describe: () => [{ id: 'google', label: 'Google' }],
  };

  const state = new OauthStateService(config as never);
  const service = new IdentityService(
    identityModel as never,
    customerModel as never,
    { signAsync: async () => 'signed.customer.token' } as never,
    config as never,
    registry as never,
    state as never,
    { isEnabled: () => false } as never,
  );

  return {
    service,
    customers,
    identities,
    setProfile: (next: StubProfile) => {
      profile = next;
    },
  };
}

/** An account holding the address, which nobody has ever proved. */
function unverifiedHolder(over: Partial<CustomerDoc> = {}): CustomerDoc {
  return {
    _id: HOLDER,
    name: 'alice@example.com',
    email: 'alice@example.com',
    planKey: 'free',
    status: 'active',
    passwordHash: 'scrypt:hash',
    ...over,
  };
}

function binderFrom(setCookie: string): string {
  const match = new RegExp(`^${OAUTH_BINDER_COOKIE}=([^;]*)`).exec(setCookie);
  if (!match) throw new Error(`no ${OAUTH_BINDER_COOKIE} in: ${setCookie}`);
  return match[1];
}

/** The ceremony binder, read exactly as a browser would present it back to us. */
function linkBinderFrom(setCookie: string | undefined): string {
  const value = readLinkBinderCookie(String(setCookie ?? '').split(';')[0]);
  if (!value) throw new Error(`no ${LINK_BINDER_COOKIE} in: ${setCookie}`);
  return value;
}

function stateFrom(authorizeUrl: string): string {
  return new URL(authorizeUrl).searchParams.get('state') ?? '';
}

/**
 * ONE browser's cookie store: applies a `Set-Cookie` the way a browser would and
 * renders the `Cookie` header it would send back.
 *
 * The ceremony's whole failure mode was about cookie CHURN across a second round
 * trip — one name being overwritten and then deleted while another had to
 * survive — and that is invisible to a test that passes binder strings around by
 * hand. Names and `Max-Age=0` are all this needs to model; `Path` and `Secure`
 * are asserted separately.
 */
function cookieJar() {
  const jar = new Map<string, string>();
  return {
    apply(setCookie: string | undefined): void {
      if (!setCookie) return;
      const [pair, ...attributes] = setCookie.split(';');
      const separator = pair.indexOf('=');
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (!value || attributes.some((a) => a.trim().toLowerCase() === 'max-age=0')) jar.delete(name);
      else jar.set(name, value);
    },
    header: () => [...jar].map(([name, value]) => `${name}=${value}`).join('; '),
  };
}

/**
 * Drive a whole signed-out OAuth login for the seeded stack and hand back where
 * the browser was sent, plus the binder it is holding.
 */
async function signInWithGoogle(stack: ReturnType<typeof buildStack>) {
  const started = await stack.service.startOauth('google', undefined, '203.0.113.9');
  const oauthBinder = binderFrom(started.binderCookie);
  const { url, setCookie } = await stack.service.completeOauthCallback({
    provider: 'google',
    code: 'provider-auth-code',
    state: stateFrom(started.authorizeUrl),
    binder: oauthBinder,
  });
  return { url, oauthBinder, setCookie, redirect: new URL(url) };
}

/**
 * The whole way to a live ceremony: a verified Google login onto a stranger's row.
 *
 * `binder` is the CEREMONY binder — the cookie the callback plants alongside the
 * token, and the only one the two pending-link routes read. `oauthBinder` is the
 * round trip's own, kept so the tests can prove the two are not interchangeable.
 */
async function pendingCeremony(seed: { customers?: CustomerDoc[]; identities?: IdentityDoc[] } = {}) {
  const stack = buildStack({ customers: [unverifiedHolder()], ...seed });
  const { redirect, oauthBinder, setCookie } = await signInWithGoogle(stack);
  const token = redirect.searchParams.get('token');
  if (!token) throw new Error(`expected a pending-link token, got ${redirect.toString()}`);
  return { ...stack, token, binder: linkBinderFrom(setCookie), oauthBinder, setCookie };
}

beforeEach(() => {
  redisMock.store.clear();
  redisMock.writes.length = 0;
  redisMock.commands.length = 0;
});

describe('the collision fork — who is offered the ceremony', () => {
  it('sends a PROVIDER-VERIFIED collision to /link-account with a token and NOTHING else', async () => {
    const stack = buildStack({ customers: [unverifiedHolder()] });

    const { redirect } = await signInWithGoogle(stack);

    expect(redirect.origin + redirect.pathname).toBe('https://portal.example.com/link-account');
    expect(redirect.searchParams.get('provider')).toBe('google');
    expect(redirect.searchParams.get('token')).toBeTruthy();
    // The address must NOT ride in the URL: a crafted /link-account?email=… would
    // render a convincing "sign in to connect" lure on our own domain.
    expect(redirect.toString()).not.toContain('alice');
    expect(redirect.searchParams.get('error')).toBeNull();
    // Nothing is linked and no shadow account is created — the refusal still holds.
    expect(stack.identities).toHaveLength(0);
    expect(stack.customers).toHaveLength(1);
    expect(stack.customers[0].emailVerifiedAt).toBeUndefined();
  });

  it('stores the pending link under its own 10-minute key', async () => {
    const { token, binder } = await pendingCeremony();

    const write = redisMock.writes.find(([key]) => key.startsWith(PENDING_LINK_PREFIX));
    expect(write).toEqual([`${PENDING_LINK_PREFIX}${token}`, 600]);
    // The raw binder is never stored — only its hash travels into Redis, so a
    // dump of the store hands nobody a usable cookie.
    expect([...redisMock.store.values()].join('|')).not.toContain(binder);
  });

  it('REFUSES an UNVERIFIED provider email exactly as before — no ceremony, no lure', async () => {
    // GitHub-shaped: the profile address is user-typed, so "sign in to connect
    // k•••@example.com" would be a phishing prompt for an address the attacker
    // chose. Settings-initiated linking already covers this case safely.
    const stack = buildStack({ customers: [unverifiedHolder()] });
    stack.setProfile({ subject: 'google-typer', email: 'alice@example.com', emailVerified: false });

    const { redirect } = await signInWithGoogle(stack);

    expect(redirect.pathname).toBe('/auth/callback');
    expect(redirect.searchParams.get('error')).toBe('email_in_use');
    expect(redirect.searchParams.get('token')).toBeNull();
    expect([...redisMock.store.keys()].some((key) => key.startsWith(PENDING_LINK_PREFIX))).toBe(false);
    expect(stack.identities).toHaveLength(0);
  });

  it('REFUSES a SUSPENDED holder — the ceremony would confirm the account and let it back in', async () => {
    const stack = buildStack({ customers: [unverifiedHolder({ status: 'suspended' })] });

    const { redirect } = await signInWithGoogle(stack);

    expect(redirect.pathname).toBe('/auth/callback');
    expect(redirect.searchParams.get('error')).toBe('email_in_use');
    expect([...redisMock.store.keys()].some((key) => key.startsWith(PENDING_LINK_PREFIX))).toBe(false);
  });

  it('does not fire at all when rule (b) can auto-link — both sides already proved control', async () => {
    const stack = buildStack({
      customers: [unverifiedHolder({ emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z') })],
    });

    const { redirect } = await signInWithGoogle(stack);

    expect(redirect.pathname).toBe('/auth/callback');
    expect(redirect.searchParams.get('code')).toBeTruthy();
    expect(stack.identities).toHaveLength(1);
    expect(stack.identities[0].customerId).toBe(HOLDER);
  });
});

/**
 * The ceremony binder lives in its OWN cookie, and that is a security-relevant
 * structural choice rather than tidiness: the page's entire job is to ask for a
 * sign-in, and one of the sign-ins it offers is another OAuth round trip, which
 * OVERWRITES `sso_binder` at `start` and DELETES it at the handoff exchange.
 * Binding the pending link to that cookie made the recommended path destroy the
 * ceremony every time, with a generic "no longer valid" as the only symptom.
 */
describe('the ceremony binder — its own cookie, because signing in is a round trip', () => {
  it('is planted by the CALLBACK, alongside the token, with the browser-only attributes', async () => {
    const { setCookie } = await pendingCeremony();

    expect(setCookie).toContain(`${LINK_BINDER_COOKIE}=`);
    // Script must never read it: an XSS on the portal could otherwise finish a
    // ceremony it did not start.
    expect(setCookie).toContain('HttpOnly');
    // Lax, not Strict — the same reasoning as the round-trip binder: Strict is
    // withheld on the provider's top-level redirect back.
    expect(setCookie).toContain('SameSite=Lax');
    // Scoped to the readers, WITH the semicolon so a re-widening to `/` fails.
    expect(setCookie).toContain('Path=/account;');
    // Non-prod: a `Secure` cookie is dropped over plain http and would look like
    // a mismatch rather than a missing cookie.
    expect(setCookie).not.toContain('Secure');
  });

  it('expires WITH the record, not with the round trip that preceded it', async () => {
    // The two clocks start at different moments — the round-trip binder at
    // `start`, this one at the callback — so borrowing the round trip's budget
    // silently made the ceremony's real window `600s − time spent at the
    // provider`, and the cliff was the same generic 404 while Redis still held a
    // live record. Pinned as an equality so the two cannot drift apart again.
    const { setCookie, token } = await pendingCeremony();

    const recordTtl = redisMock.writes.find(([key]) => key === `${PENDING_LINK_PREFIX}${token}`)?.[1];
    const cookieMaxAge = Number(/Max-Age=(\d+)/.exec(String(setCookie))?.[1]);
    expect(cookieMaxAge).toBe(recordTtl);
    expect(cookieMaxAge).toBe(600);
  });

  it('SURVIVES the sign-in the page asks for, even when that sign-in is another OAuth round trip', async () => {
    // THE REGRESSION. The holder's existing way in is a provider account already
    // attached to them, which is the overwhelmingly common shape: the ceremony
    // page offers those buttons, and pressing one used to leave the visitor
    // correctly signed in with the ceremony dead.
    const stack = buildStack({
      customers: [unverifiedHolder()],
      identities: [
        {
          _id: '507f191e810c19729de860eb',
          customerId: HOLDER,
          provider: 'google',
          subject: 'google-existing',
        },
      ],
    });
    const jar = cookieJar();

    // ── round trip 1: the colliding login that opens the ceremony
    const first = await stack.service.startOauth('google', undefined, '203.0.113.9');
    jar.apply(first.binderCookie);
    const opened = await stack.service.completeOauthCallback({
      provider: 'google',
      code: 'provider-auth-code',
      state: stateFrom(first.authorizeUrl),
      binder: readBinderCookie(jar.header()),
    });
    jar.apply(opened.setCookie);
    const token = new URL(opened.url).searchParams.get('token') as string;
    expect(token).toBeTruthy();

    // ── round trip 2: signing in with the provider account they already have
    stack.setProfile({
      subject: 'google-existing',
      email: 'alice@example.com',
      emailVerified: true,
    });
    const second = await stack.service.startOauth('google', undefined, '203.0.113.9');
    // Overwrites `sso_binder` — same name, same path. This is the first half of
    // what used to kill the ceremony.
    jar.apply(second.binderCookie);
    const landed = await stack.service.completeOauthCallback({
      provider: 'google',
      code: 'second-auth-code',
      state: stateFrom(second.authorizeUrl),
      binder: readBinderCookie(jar.header()),
    });
    const handoff = new URL(landed.url).searchParams.get('code') as string;
    await stack.service.exchangeHandoff(handoff, readBinderCookie(jar.header()));
    // …and the exchange deletes it. The second half.
    jar.apply(stack.service.expiredBinderCookie());

    expect(readBinderCookie(jar.header())).toBeUndefined();
    const ceremonyBinder = readLinkBinderCookie(jar.header());
    expect(ceremonyBinder).toBeTruthy();

    // The ceremony is untouched by any of that: still describable, still
    // completable, by the browser that met the provider in the first place.
    await expect(stack.service.describePendingLink(token, ceremonyBinder)).resolves.toMatchObject({
      provider: 'google',
      maskedEmail: 'a•••e@example.com',
    });
    await expect(
      stack.service.completePendingLink({ customerId: HOLDER, token, binder: ceremonyBinder }),
    ).resolves.toEqual({ ok: true, provider: 'google' });
    expect(stack.identities.map((row) => row.subject).sort()).toEqual([
      'google-existing',
      'google-owner',
    ]);

    // Spent — and clearing it must not disturb the round-trip cookie's slot.
    jar.apply(stack.service.expiredLinkBinderCookie());
    expect(readLinkBinderCookie(jar.header())).toBeUndefined();
  });

  it('reads ONLY its own name — the two binders are never substituted for each other', async () => {
    const { binder } = await pendingCeremony();

    // A browser still holding a live round-trip binder and nothing else has no
    // ceremony binding, and vice versa. Exact-name matching is what stops a
    // stale `sso_binder` from reading as a ceremony the visitor never opened.
    expect(readLinkBinderCookie(`${OAUTH_BINDER_COOKIE}=${binder}`)).toBeUndefined();
    expect(readBinderCookie(`${LINK_BINDER_COOKIE}=${binder}`)).toBeUndefined();
    expect(readLinkBinderCookie(`theme=dark; ${LINK_BINDER_COOKIE}=${binder}; other=1`)).toBe(binder);
  });

  it('fails CLOSED on a planted duplicate, exactly like the round-trip binder', async () => {
    // Any XSS or takeover on a sibling subdomain can set a `Domain=` cookie, and
    // the `Cookie` header carries no attributes to tell the twin from ours.
    const { service, token, binder } = await pendingCeremony();
    const tossed = `${LINK_BINDER_COOKIE}=${binder}; ${LINK_BINDER_COOKIE}=planted`;

    expect(readLinkBinderCookie(tossed)).toBeUndefined();
    await expect(
      service.describePendingLink(token, readLinkBinderCookie(tossed)),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('describing a pending link — the unauthenticated peek', () => {
  it('names the provider and MASKS the address', async () => {
    const { service, token, binder } = await pendingCeremony();

    await expect(service.describePendingLink(token, binder)).resolves.toEqual({
      provider: 'google',
      providerLabel: 'Google',
      maskedEmail: 'a•••e@example.com',
      // The holder fixture has a `passwordHash` and no identities yet.
      signInMethods: { password: true, providers: [] },
    });
  });

  /**
   * WHAT THE TARGET CAN ACTUALLY SIGN IN WITH — the allow-list that ends the
   * provider ping-pong.
   *
   * The page used to hide only the COLLIDING provider and offer every other
   * configured one. Each of those collides on the same address and mints a fresh
   * ceremony, so the buttons flipped the heading between providers forever with no
   * error anywhere. Only identities ALREADY attached to the target reach rule (a)
   * and sign the caller in, so only those may be offered.
   */
  it('lists only the providers ALREADY linked to the target, never the colliding one', async () => {
    const { service, token, binder } = await pendingCeremony({
      identities: [
        {
          _id: '665000000000000000000099',
          customerId: HOLDER,
          provider: 'github',
          subject: 'gh-1',
          email: 'alice@example.com',
          emailVerified: true,
        },
      ],
    });

    const described = await service.describePendingLink(token, binder);

    // The ID is the contract; the LABEL comes from the provider registry, which
    // this stack only stubs Google into, so `github` takes the capitalised-id
    // fallback here and reads "GitHub" in a real deployment. Asserting the id
    // avoids pinning that incidental difference.
    expect(described.signInMethods.providers).toHaveLength(1);
    expect(described.signInMethods.providers[0].id).toBe('github');
    expect(described.signInMethods.providers[0].label).toBeTruthy();
    // Never the provider being connected — offering it IS the loop.
    expect(described.signInMethods.providers.map((p) => p.id)).not.toContain('google');
  });

  /**
   * A password-less account must not be shown the password form. `passwordHash` is
   * `select: false`, so this also pins that the read asks for it explicitly — drop
   * the `+passwordHash` and every account reports `password: false`, which hides
   * the one method that works.
   */
  it('reports password: false for an account with no passwordHash', async () => {
    const { service, token, binder } = await pendingCeremony({
      customers: [unverifiedHolder({ passwordHash: undefined })],
    });

    const described = await service.describePendingLink(token, binder);

    expect(described.signInMethods.password).toBe(false);
  });

  it('keeps two addresses at the same provider DISTINGUISHABLE', async () => {
    // A first-letter-only mask rendered `kbrown@example.com` and
    // `kyle.green222@example.com` identically, so somebody holding both could
    // not tell which account the ceremony was waiting for — and guessing wrong
    // is a 403. Masking is defence in depth here (the token is minted only after
    // a verified sign-in AS this address, and reading it needs that browser's
    // binder), so a mask that cannot tell its own subjects apart is failing the
    // only job it has on this screen.
    const masks = [];
    for (const [i, email] of ['kbrown@example.com', 'kyle.green222@example.com'].entries()) {
      const stack = buildStack({ customers: [unverifiedHolder({ email })] });
      stack.setProfile({ subject: `google-owner-${i}`, email, emailVerified: true });
      const { redirect, setCookie } = await signInWithGoogle(stack);
      const token = redirect.searchParams.get('token') as string;
      const described = await stack.service.describePendingLink(token, linkBinderFrom(setCookie));
      masks.push(described.maskedEmail);
      // Still a mask: the middle of the local part never appears.
      expect(described.maskedEmail).not.toContain(email.slice(0, email.indexOf('@')));
    }
    expect(masks[0]).not.toBe(masks[1]);
  });

  it('masks a one-character local part ENTIRELY — it would otherwise round-trip in full', async () => {
    const stack = buildStack({ customers: [unverifiedHolder({ email: 'k@example.com' })] });
    stack.setProfile({ subject: 'google-owner', email: 'k@example.com', emailVerified: true });
    const { redirect, setCookie } = await signInWithGoogle(stack);
    const token = redirect.searchParams.get('token') as string;

    const described = await stack.service.describePendingLink(token, linkBinderFrom(setCookie));
    expect(described.maskedEmail).toBe('•••@example.com');
    expect(described.maskedEmail).not.toContain('k@');
  });

  it('does NOT consume — the page is loaded, refreshed and returned to', async () => {
    const { service, token, binder } = await pendingCeremony();

    await service.describePendingLink(token, binder);
    await service.describePendingLink(token, binder);

    // Still redeemable afterwards: peeking must not burn the ceremony.
    await expect(
      service.completePendingLink({ customerId: HOLDER, token, binder }),
    ).resolves.toEqual({ ok: true, provider: 'google' });
  });

  it('answers ONE generic 404 for unknown, expired and wrong-browser alike', async () => {
    const { service, token, binder } = await pendingCeremony();
    const wrongBrowser = service.describePendingLink(token, 'some-other-binder');
    const noBrowser = service.describePendingLink(token, undefined);
    const unknown = service.describePendingLink('never-minted-token', binder);

    for (const attempt of [wrongBrowser, noBrowser, unknown]) {
      await expect(attempt).rejects.toBeInstanceOf(NotFoundException);
    }
    // Identical bodies: distinguishing them tells a token thief whether the token
    // is live and whether the cookie is the only thing they are missing.
    const bodies = await Promise.all(
      [
        service.describePendingLink(token, 'some-other-binder'),
        service.describePendingLink('never-minted-token', binder),
      ].map((p) => p.catch((e: NotFoundException) => JSON.stringify(e.getResponse()))),
    );
    expect(bodies[0]).toBe(bodies[1]);
  });

  it('404s once the record has EXPIRED out of Redis', async () => {
    const { service, token, binder } = await pendingCeremony();
    redisMock.store.delete(`${PENDING_LINK_PREFIX}${token}`);

    await expect(service.describePendingLink(token, binder)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('completing the ceremony', () => {
  it('attaches the provider to the account that held the address, and stamps it verified', async () => {
    const { service, identities, customers, token, binder } = await pendingCeremony();

    await expect(service.completePendingLink({ customerId: HOLDER, token, binder })).resolves.toEqual({
      ok: true,
      provider: 'google',
    });

    expect(identities).toHaveLength(1);
    expect(identities[0]).toMatchObject({
      customerId: HOLDER,
      provider: 'google',
      subject: 'google-owner',
      email: 'alice@example.com',
      emailVerified: true,
    });
    // BOTH halves of rule (b) have now been proved, in sequence: the provider
    // asserted the address, and the human authenticated into the account holding
    // it. Recording that is what lets the NEXT provider auto-link, and it is what
    // unblocks the portal for a customer who never verified by OTP.
    expect(customers[0].emailVerifiedAt).toBeInstanceOf(Date);
  });

  it('REFUSES a DIFFERENT signed-in customer WITHOUT burning the token', async () => {
    const { service, identities, token, binder } = await pendingCeremony({
      customers: [unverifiedHolder(), { _id: STRANGER, planKey: 'free', status: 'active' }],
    });

    await expect(
      service.completePendingLink({ customerId: STRANGER, token, binder }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(identities).toHaveLength(0);

    // THE POINT OF THIS TEST. Landing here signed in to the wrong account is an
    // ordinary mistake, not an attack: the caller already presented a valid
    // binder and a valid session, and the link can only ever reach
    // `targetCustomerId` no matter how often it is offered — so a refusal proves
    // nothing to anybody and must not destroy the link. Consuming first (the
    // SIWE-nonce discipline, which is right when the failing input is a GUESS
    // against a secret) left the real owner a 404 one request later, with no way
    // to reissue but to repeat the entire provider round trip.
    await expect(service.completePendingLink({ customerId: HOLDER, token, binder })).resolves.toEqual({
      ok: true,
      provider: 'google',
    });
    expect(identities).toHaveLength(1);
  });

  it('is SINGLE-USE', async () => {
    const { service, token, binder } = await pendingCeremony();

    await service.completePendingLink({ customerId: HOLDER, token, binder });
    await expect(
      service.completePendingLink({ customerId: HOLDER, token, binder }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('REFUSES a browser that does not hold the binder — the copied-URL case', async () => {
    // The token has been in a redirect URL, so it is in browser history, in the
    // portal's `Referer` and in our own access log. Holding a copy is not enough.
    const { service, identities, token } = await pendingCeremony();

    await expect(
      service.completePendingLink({ customerId: HOLDER, token, binder: undefined }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(identities).toHaveLength(0);
  });

  it('404s after the record has EXPIRED', async () => {
    const { service, token, binder } = await pendingCeremony();
    redisMock.store.delete(`${PENDING_LINK_PREFIX}${token}`);

    await expect(
      service.completePendingLink({ customerId: HOLDER, token, binder }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('409s when that provider account was linked elsewhere in the meantime', async () => {
    const { service, identities, token, binder } = await pendingCeremony({
      customers: [unverifiedHolder(), { _id: STRANGER, planKey: 'free', status: 'active' }],
    });
    // Seeded AFTER the ceremony was minted — that is the race: somebody attached
    // this Google account to their own tenant while the page sat open. Seeding it
    // up front would instead be rule (a), a plain known-identity login.
    identities.push({
      _id: '507f191e810c19729de860ea',
      customerId: STRANGER,
      provider: 'google',
      subject: 'google-owner',
    });

    await expect(
      service.completePendingLink({ customerId: HOLDER, token, binder }),
    ).rejects.toBeInstanceOf(ConflictException);
    // The other customer's row is untouched: an identity is never MOVED.
    expect(identities).toHaveLength(1);
    expect(identities[0].customerId).toBe(STRANGER);
  });

  it('refuses an account suspended between the callback and the confirmation', async () => {
    const { service, customers, identities, token, binder } = await pendingCeremony();
    customers[0].status = 'suspended';

    await expect(
      service.completePendingLink({ customerId: HOLDER, token, binder }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(identities).toHaveLength(0);
  });
});

describe('the verification stamp — narrow by construction', () => {
  it('does NOT stamp when the account moved to a different address in the meantime', async () => {
    const { service, customers, identities, token, binder } = await pendingCeremony();
    // A profile edit promoted a different address while the ceremony was open.
    customers[0].email = 'someone.else@example.com';

    await service.completePendingLink({ customerId: HOLDER, token, binder });

    // The link still happens — the provider account is genuinely theirs — but the
    // proof is about an address the account no longer holds.
    expect(identities).toHaveLength(1);
    expect(customers[0].emailVerifiedAt).toBeUndefined();
  });

  it('leaves an ALREADY-verified stamp alone', async () => {
    const verifiedAt = new Date('2026-01-01T00:00:00.000Z');
    const { service, customers, token, binder } = await pendingCeremony();
    customers[0].emailVerifiedAt = verifiedAt;

    await service.completePendingLink({ customerId: HOLDER, token, binder });

    expect(customers[0].emailVerifiedAt).toBe(verifiedAt);
  });

  it('clears a pending claim for the SAME address, along with its outstanding code', async () => {
    const { service, customers, token, binder } = await pendingCeremony();
    customers[0].pendingEmail = 'Alice@Example.com'.toLowerCase();
    customers[0].emailVerificationTokenHash = 'deadbeef:0';
    customers[0].emailVerificationExpiresAt = new Date(Date.now() + 60_000);

    await service.completePendingLink({ customerId: HOLDER, token, binder });

    expect(customers[0].emailVerifiedAt).toBeInstanceOf(Date);
    expect(customers[0].pendingEmail).toBeUndefined();
    expect(customers[0].emailVerificationTokenHash).toBeUndefined();
    expect(customers[0].emailVerificationExpiresAt).toBeUndefined();
  });

  it('leaves a pending claim for a DIFFERENT address — that is somebody’s live claim', async () => {
    const { service, customers, token, binder } = await pendingCeremony();
    customers[0].pendingEmail = 'new-address@example.com';
    customers[0].emailVerificationTokenHash = 'deadbeef:0';

    await service.completePendingLink({ customerId: HOLDER, token, binder });

    expect(customers[0].emailVerifiedAt).toBeInstanceOf(Date);
    expect(customers[0].pendingEmail).toBe('new-address@example.com');
    expect(customers[0].emailVerificationTokenHash).toBe('deadbeef:0');
  });
});
