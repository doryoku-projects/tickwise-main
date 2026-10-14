import 'reflect-metadata';
import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * THE BROWSER BINDER — what ties an OAuth round trip to the browser that started
 * it. Five confirmed findings shared one root cause: `state` proves that SOME
 * flow started on this server, never that it started HERE, in THIS browser.
 *
 * Without a binder the three attacks below all work, and all three are exercised
 * against the REAL `OauthStateService` + `IdentityService` (only Redis and Mongo
 * are in-memory) because the guarantees are structural — atomic single-use, a
 * hash stored instead of a secret, a cookie that never appears in a body or a
 * URL — and a stubbed state service would assert none of them:
 *
 *  - LOGIN CSRF / SESSION FIXATION: attacker completes their own login and makes
 *    the victim's browser run the callback, landing the victim in the attacker's
 *    account.
 *  - FORCED ACCOUNT LINKING: attacker starts a LINK on their own account and
 *    makes the victim finish it, permanently attaching the victim's Google
 *    identity to the attacker's tenant.
 *  - HANDOFF THEFT: the handoff code rides in a redirect URL, so it exists in
 *    browser history, in the portal's `Referer` and in this service's own access
 *    log (`main.ts` prints `req.originalUrl` on EVERY response).
 */

const redisMock = vi.hoisted(() => ({
  store: new Map<string, string>(),
  commands: [] as string[],
  /** Flip to model a Redis older than 6.2, where `GETDEL` does not exist. */
  flags: { getdelSupported: true },
}));

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    quit: vi.fn(async () => undefined),
    set: async (key: string, value: string) => {
      redisMock.commands.push('set');
      redisMock.store.set(key, value);
      return 'OK';
    },
    getdel: async (key: string) => {
      redisMock.commands.push('getdel');
      if (!redisMock.flags.getdelSupported) throw new Error("ERR unknown command 'getdel'");
      const value = redisMock.store.get(key) ?? null;
      redisMock.store.delete(key);
      return value;
    },
    // The MULTI fallback executes as ONE unit, which is the property that makes
    // it an acceptable substitute for GETDEL (a sequential GET then DEL is not).
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
        exec: async () => {
          redisMock.commands.push('multi');
          return ops.map(([op, key]) => {
            if (op === 'get') return [null, redisMock.store.get(key) ?? null];
            const existed = redisMock.store.delete(key);
            return [null, existed ? 1 : 0];
          });
        },
      };
      return chain;
    },
  })),
}));

const { IdentityService } = await import('../src/identity/identity.service.js');
const {
  OAUTH_BINDER_COOKIE,
  OauthStateService,
  binderMatches,
  hashBinder,
  readBinderCookie,
} = await import('../src/identity/oauth-state.service.js');

const CUSTOMER_A = '507f1f77bcf86cd799439011';
const CUSTOMER_B = '507f1f77bcf86cd799439012';

interface CustomerDoc {
  _id: string;
  email?: string;
  name?: string;
  planKey: string;
  status: 'active' | 'suspended';
  passwordHash?: string;
  emailVerifiedAt?: Date;
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

function applySet(doc: Record<string, unknown>, update: Record<string, unknown>): void {
  for (const [key, value] of Object.entries((update.$set ?? {}) as Record<string, unknown>)) {
    doc[key] = value;
  }
}

function duplicateKey(): Error {
  return Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
}

/** The Google profile the stub provider reports for whoever consented. */
interface StubProfile {
  subject: string;
  email?: string;
  emailVerified: boolean;
  displayName?: string;
}

/**
 * Real services over in-memory collections. `profile` is mutable so one stack can
 * play both parties: the attacker consents first, then the victim.
 */
function buildStack(
  seed: { customers?: CustomerDoc[]; identities?: IdentityDoc[]; isProduction?: boolean } = {},
) {
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
      const row = {
        ...doc,
        _id: String(doc._id ?? nextId()),
        customerId: String(doc.customerId),
      } as IdentityDoc;
      identities.push(row);
      return row;
    },
    updateOne: (filter: Record<string, unknown>, update: Record<string, unknown>) => {
      const hit = identities.find((row) => matches(row, filter));
      if (hit) applySet(hit as unknown as Record<string, unknown>, update);
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
            applySet(hit as unknown as Record<string, unknown>, update);
            return hit;
          }
          if (!options.upsert) return null;
          // The unique {provider, subject} index has the last word on the insert
          // the upsert falls through to.
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
      if (hit) applySet(hit as unknown as Record<string, unknown>, update);
      return { exec: async () => ({ matchedCount: hit ? 1 : 0 }) };
    },
  };

  const config = {
    redisUrl: 'redis://127.0.0.1:6379',
    portalBaseUrl: 'https://portal.example.com',
    oauthCallbackBaseUrl: 'https://api.example.com',
    isProduction: seed.isProduction ?? false,
  };

  let profile: StubProfile = { subject: 'google-victim', email: 'victim@example.com', emailVerified: true };
  const provider = {
    id: 'google' as const,
    label: 'Google',
    defaultScopes: [],
    isEnabled: () => true,
    buildAuthorizeUrl: (args: { state: string; codeChallenge: string; redirectUri: string }) =>
      `https://accounts.example.com/authorize?state=${args.state}&code_challenge=${args.codeChallenge}`,
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
    state,
    customers,
    identities,
    setProfile: (next: StubProfile) => {
      profile = next;
    },
  };
}

function activeCustomer(over: Partial<CustomerDoc> = {}): CustomerDoc {
  return { _id: CUSTOMER_A, planKey: 'free', status: 'active', ...over };
}

/** The raw binder out of a `Set-Cookie` value — what the browser would send back. */
function binderFrom(setCookie: string): string {
  const match = new RegExp(`^${OAUTH_BINDER_COOKIE}=([^;]*)`).exec(setCookie);
  if (!match) throw new Error(`no ${OAUTH_BINDER_COOKIE} in: ${setCookie}`);
  return match[1];
}

function stateFrom(authorizeUrl: string): string {
  return new URL(authorizeUrl).searchParams.get('state') ?? '';
}

/** `?code=` / `?error=` off the portal URL the callback redirects to. */
function redirectParams(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

beforeEach(() => {
  redisMock.store.clear();
  redisMock.commands.length = 0;
  redisMock.flags.getdelSupported = true;
});

describe('OauthStateService — single-use state, hashed binder', () => {
  it('consumes a state exactly ONCE even when two callbacks race it', async () => {
    const state = new OauthStateService({ redisUrl: 'redis://127.0.0.1:6379' } as never);
    const generated = await state.generate({ provider: 'google' });

    const [first, second] = await Promise.all([
      state.consume(generated.state),
      state.consume(generated.state),
    ]);

    // Exactly one winner. A replayed callback — back button, a copied URL, a
    // forged one racing the real one — finds the key gone.
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect((first ?? second)?.codeVerifier).toBe(generated.codeVerifier);
    // Read-and-delete in ONE round trip. A GET followed by a DEL would let both
    // racers read the verifier before either deleted it.
    expect(redisMock.commands).toContain('getdel');
    expect(redisMock.commands).not.toContain('get');
  });

  it('stays single-use on the MULTI fallback when the server has no GETDEL', async () => {
    redisMock.flags.getdelSupported = false;
    const state = new OauthStateService({ redisUrl: 'redis://127.0.0.1:6379' } as never);
    const generated = await state.generate({ provider: 'google' });

    const [first, second] = await Promise.all([
      state.consume(generated.state),
      state.consume(generated.state),
    ]);

    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(redisMock.commands).toContain('multi');
  });

  it('stores the binder HASH and never the binder itself', async () => {
    const state = new OauthStateService({ redisUrl: 'redis://127.0.0.1:6379' } as never);
    const generated = await state.generate({ provider: 'google' });

    const stored = [...redisMock.store.values()].join('|');
    // A Redis dump must not hand anybody a usable binder.
    expect(stored).not.toContain(generated.binder);
    expect(stored).toContain(hashBinder(generated.binder));

    const record = await state.consume(generated.state);
    expect(record?.binderHash).toBe(hashBinder(generated.binder));
  });

  it('REFUSES a state record carrying no binder hash — fail closed, not fall through', async () => {
    const state = new OauthStateService({ redisUrl: 'redis://127.0.0.1:6379' } as never);
    // Exactly what a build from before the binder wrote. Accepting it would make
    // the whole check skippable by replaying an old record.
    redisMock.store.set(
      'sso:oauth:state:legacy-state-token',
      JSON.stringify({ provider: 'google', codeVerifier: 'verifier' }),
    );

    expect(await state.consume('legacy-state-token')).toBeNull();
  });

  it('REFUSES a link record whose customer id is not an ObjectId', async () => {
    const state = new OauthStateService({ redisUrl: 'redis://127.0.0.1:6379' } as never);
    redisMock.store.set(
      'sso:oauth:state:bad-link-state',
      JSON.stringify({
        provider: 'google',
        codeVerifier: 'verifier',
        binderHash: hashBinder('binder'),
        linkCustomerId: 'not-an-object-id',
      }),
    );

    // Dropping the field instead would be worse than refusing: the callback would
    // read it as a plain login and resolve or CREATE an account.
    expect(await state.consume('bad-link-state')).toBeNull();
  });
});

describe('readBinderCookie / binderMatches', () => {
  it('finds the binder among other cookies, and copes with an absent header', () => {
    expect(readBinderCookie(`cp-other=1; ${OAUTH_BINDER_COOKIE}=abc123; theme=dark`)).toBe('abc123');
    expect(readBinderCookie(`${OAUTH_BINDER_COOKIE}="abc123"`)).toBe('abc123');
    expect(readBinderCookie(undefined)).toBeUndefined();
    expect(readBinderCookie('')).toBeUndefined();
    expect(readBinderCookie('cp-other=1')).toBeUndefined();
  });

  it('treats DUPLICATE binder cookies with different values as no binder at all', () => {
    // Cookie tossing: anyone who controls a sibling subdomain can set a second
    // `sso_binder` with a `Domain=` attribute, and the `Cookie` header carries no
    // attributes to tell the two apart. Guessing is how a planted binder wins.
    expect(readBinderCookie(`${OAUTH_BINDER_COOKIE}=mine; ${OAUTH_BINDER_COOKIE}=planted`)).toBeUndefined();
    // The same value twice is not ambiguous.
    expect(readBinderCookie(`${OAUTH_BINDER_COOKIE}=mine; ${OAUTH_BINDER_COOKIE}=mine`)).toBe('mine');
  });

  it('rejects values that cannot be one of ours', () => {
    expect(readBinderCookie(`${OAUTH_BINDER_COOKIE}=has%20space`)).toBeUndefined();
    expect(readBinderCookie(`${OAUTH_BINDER_COOKIE}=`)).toBeUndefined();
    expect(readBinderCookie(`${OAUTH_BINDER_COOKIE}=${'a'.repeat(300)}`)).toBeUndefined();
  });

  it('compares in constant time without throwing on mismatched widths', () => {
    const binder = 'a-real-binder-value';
    expect(binderMatches(hashBinder(binder), binder)).toBe(true);
    expect(binderMatches(hashBinder(binder), 'wrong-binder')).toBe(false);
    expect(binderMatches(hashBinder(binder), undefined)).toBe(false);
    // `timingSafeEqual` THROWS on unequal lengths, so both sides are re-hashed —
    // a truncated or junk stored hash must be a `false`, never a 500.
    expect(binderMatches('short', binder)).toBe(false);
    expect(binderMatches(undefined, binder)).toBe(false);
  });
});

describe('OAuth start — the cookie that gets planted', () => {
  it('sets an HttpOnly, SameSite=Lax cookie scoped to /account/auth, and keeps the binder OUT of the body', async () => {
    const { service } = buildStack();
    const started = await service.startOauth('google', '/portal/keys', '203.0.113.9');

    expect(started.binderCookie).toContain('HttpOnly');
    // Lax, NOT Strict: the cookie has to survive the provider's top-level
    // redirect back into our callback, which Strict would withhold.
    expect(started.binderCookie).toContain('SameSite=Lax');
    // `/account`, not `/account/auth`: the pending-link ceremony's completion
    // route is `POST /account/identities/link-pending`, and `Path` decides where
    // the browser SENDS a cookie — under the narrower scope it would never arrive
    // there and the ceremony would fail closed every time. The trailing `;` pins
    // the whole attribute, so a silent re-widening to `/` would fail here.
    expect(started.binderCookie).toContain('Path=/account;');
    expect(started.binderCookie).toContain('Max-Age=600');
    // No `Secure` in dev — over plain http the browser would drop the cookie
    // silently and every local login would fail as a "mismatched" binder.
    expect(started.binderCookie).not.toContain('Secure');
    expect(started.authorizeUrl).not.toContain(binderFrom(started.binderCookie));
  });

  it('adds Secure in production', async () => {
    const { service } = buildStack({ isProduction: true });
    const started = await service.startOauth('google', undefined, '203.0.113.9');
    expect(started.binderCookie).toContain('Secure');
  });
});

describe('OAuth callback — binding the round trip to one browser', () => {
  it('completes the login when the callback presents the binder it was issued', async () => {
    const { service, customers, identities } = buildStack();
    const started = await service.startOauth('google', '/portal/keys', '203.0.113.9');

    const { url } = await service.completeOauthCallback({
      provider: 'google',
      code: 'provider-auth-code',
      state: stateFrom(started.authorizeUrl),
      binder: binderFrom(started.binderCookie),
    });

    const params = redirectParams(url);
    expect(params.get('error')).toBeNull();
    expect(params.get('code')).toBeTruthy();
    expect(params.get('returnTo')).toBe('/portal/keys');
    expect(customers).toHaveLength(1);
    expect(identities).toHaveLength(1);
  });

  it('REFUSES a callback with no binder cookie — and still answers with a redirect', async () => {
    const { service, customers, identities } = buildStack();
    const started = await service.startOauth('google', undefined, '203.0.113.9');

    // The login-CSRF shape: the attacker holds a valid state (and could hold a
    // valid provider code), the victim's browser holds no cookie for it.
    const { url } = await service.completeOauthCallback({
      provider: 'google',
      code: 'provider-auth-code',
      state: stateFrom(started.authorizeUrl),
    });

    // A JSON 4xx at the end of a browser redirect chain is not actionable, so
    // the refusal is a 302 target carrying a short slug.
    expect(url.startsWith('https://portal.example.com/auth/callback?')).toBe(true);
    expect(redirectParams(url).get('error')).toBe('invalid_state');
    expect(redirectParams(url).get('code')).toBeNull();
    // No session was minted, and no account was created for the provider profile.
    expect(customers).toHaveLength(0);
    expect(identities).toHaveLength(0);
  });

  it('REFUSES a callback carrying somebody else’s binder', async () => {
    const { service, customers } = buildStack();
    const started = await service.startOauth('google', undefined, '203.0.113.9');
    const other = await service.startOauth('google', undefined, '198.51.100.7');

    const { url } = await service.completeOauthCallback({
      provider: 'google',
      code: 'provider-auth-code',
      state: stateFrom(started.authorizeUrl),
      binder: binderFrom(other.binderCookie),
    });

    expect(redirectParams(url).get('error')).toBe('invalid_state');
    expect(customers).toHaveLength(0);
  });

  it('burns the state even when the binder check refuses it', async () => {
    const { service } = buildStack();
    const started = await service.startOauth('google', undefined, '203.0.113.9');
    const state = stateFrom(started.authorizeUrl);

    await service.completeOauthCallback({ provider: 'google', code: 'c', state });
    // The state is consumed BEFORE the binder is checked, on purpose: otherwise a
    // forced callback could be retried until a victim's browser happened to
    // present a cookie.
    const { url: retry } = await service.completeOauthCallback({
      provider: 'google',
      code: 'c',
      state,
      binder: binderFrom(started.binderCookie),
    });
    expect(redirectParams(retry).get('error')).toBe('expired_state');
  });
});

describe('handoff exchange — the code alone is not enough', () => {
  async function completedLogin() {
    const stack = buildStack();
    const started = await stack.service.startOauth('google', undefined, '203.0.113.9');
    const binder = binderFrom(started.binderCookie);
    const { url } = await stack.service.completeOauthCallback({
      provider: 'google',
      code: 'provider-auth-code',
      state: stateFrom(started.authorizeUrl),
      binder,
    });
    return { ...stack, binder, code: redirectParams(url).get('code') as string };
  }

  it('returns the session to the browser that holds the binder', async () => {
    const { service, code, binder } = await completedLogin();
    const result = await service.exchangeHandoff(code, binder);
    expect(result.token).toBe('signed.customer.token');
    expect(result.customer.id).toBeTruthy();
  });

  it('is single-use', async () => {
    const { service, code, binder } = await completedLogin();
    await service.exchangeHandoff(code, binder);
    await expect(service.exchangeHandoff(code, binder)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('REFUSES a code presented without the binder — the log/Referer/history theft case', async () => {
    const { service, code } = await completedLogin();
    // The thief has the code (it was in a redirect URL, so it is in the access
    // log, the browser history and the portal's `Referer`) and nothing else.
    await expect(service.exchangeHandoff(code)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('REFUSES a code presented with the WRONG binder, and burns it either way', async () => {
    const { service, code } = await completedLogin();
    const other = await service.startOauth('google', undefined, '198.51.100.7');

    await expect(
      service.exchangeHandoff(code, binderFrom(other.binderCookie)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    // Single-use is applied before the binder decision, so a burnt code cannot be
    // re-presented once the right cookie is obtained.
    expect(redisMock.store.has(`sso:oauth:handoff:${code}`)).toBe(false);
  });
});

describe('link flow — the target account comes from the state, nowhere else', () => {
  it('attaches the provider account to the customer sealed into the state', async () => {
    const { service, identities } = buildStack({ customers: [activeCustomer()] });
    const started = await service.startIdentityLink(CUSTOMER_A, 'google', '/portal/profile');

    const { url } = await service.completeOauthCallback({
      provider: 'google',
      code: 'provider-auth-code',
      state: stateFrom(started.authorizeUrl),
      binder: binderFrom(started.binderCookie),
    });

    expect(redirectParams(url).get('error')).toBeNull();
    expect(identities).toHaveLength(1);
    expect(identities[0].customerId).toBe(CUSTOMER_A);
    expect(identities[0].subject).toBe('google-victim');
  });

  it('a link state naming customer A cannot attach an identity already held by customer B', async () => {
    const { service, identities } = buildStack({
      customers: [activeCustomer(), { _id: CUSTOMER_B, planKey: 'free', status: 'active' }],
      // B already owns this Google account — it is B's way into their tenant.
      identities: [
        { _id: '507f191e810c19729de860ea', customerId: CUSTOMER_B, provider: 'google', subject: 'google-victim' },
      ],
    });
    const started = await service.startIdentityLink(CUSTOMER_A, 'google');

    const { url } = await service.completeOauthCallback({
      provider: 'google',
      code: 'provider-auth-code',
      state: stateFrom(started.authorizeUrl),
      binder: binderFrom(started.binderCookie),
    });

    expect(redirectParams(url).get('error')).toBe('already_linked');
    // B's row is untouched, and nothing new was written for A. An identity is
    // never MOVED between customers — moving one transfers a login.
    expect(identities).toHaveLength(1);
    expect(identities[0].customerId).toBe(CUSTOMER_B);
  });

  // REGRESSION — forced account linking. The attacker (customer A) starts a link
  // on their OWN account and gets the victim's browser to finish it with the
  // VICTIM's Google account. Before the binder this attached the victim's
  // identity to the attacker's tenant permanently, so every later "sign in with
  // Google" by the victim landed in the attacker's account.
  it('cannot be finished by a browser that does not hold the binder', async () => {
    const { service, identities } = buildStack({ customers: [activeCustomer()] });
    const attackerLink = await service.startIdentityLink(CUSTOMER_A, 'google');

    const { url } = await service.completeOauthCallback({
      provider: 'google',
      code: 'victim-auth-code',
      state: stateFrom(attackerLink.authorizeUrl),
    });

    expect(redirectParams(url).get('error')).toBe('invalid_state');
    expect(identities).toHaveLength(0);
  });
});
