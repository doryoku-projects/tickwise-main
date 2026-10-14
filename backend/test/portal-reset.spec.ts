import 'reflect-metadata';
import { BadRequestException, ForbiddenException, HttpStatus } from '@nestjs/common';
import { HTTP_CODE_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants.js';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum.js';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { verifyPassword } from '../src/auth/password.util.js';
import { hashApiKey } from '../src/billing/api-key.util.js';
import { CustomerAuthController } from '../src/portal/customer-auth.controller.js';
import { CustomerAuthService, MIN_PASSWORD_LENGTH } from '../src/portal/customer-auth.service.js';
import {
  ForgotPasswordDto,
  MIN_PASSWORD_LENGTH as DTO_MIN_PASSWORD_LENGTH,
  ResetPasswordDto,
} from '../src/portal/portal.dto.js';

/**
 * SELF-SERVE PASSWORD RESET — the anonymous route that hands out a credential
 * outranking the password, and the one that ends portal sessions.
 *
 * Three properties carry the security of this flow, and each is pinned below
 * against the way it actually broke or could break:
 *
 *  1. THE ANSWER IS UNIFORM. Unknown address, unverified address, suspended
 *     account and wallet-only account all return the identical body, and every
 *     limiter bucket is charged the same way. Anything else re-opens the
 *     account-enumeration oracle login just spent a pass closing — on an
 *     unauthenticated route, "does ceo@bigcorp.com bank here" would be
 *     answerable by anyone with curl. (The TIMING is NOT uniform and the service
 *     says so honestly; that is a documented residual, not something asserted
 *     here.)
 *  2. CONSUME FIRST, ATOMICALLY. Expiry, account state and the write are all
 *     judged against a token that is ALREADY SPENT, so a replay — a back button,
 *     a mail client prefetching the link, an attacker retrying a copy out of a
 *     log — finds nothing. A peek-then-validate shape would leave a live token
 *     behind after every failed attempt.
 *  3. THE PASSWORD FLOOR IS ENFORCED IN THE SERVICE. The DTO bound is a
 *     courtesy: the global `ValidationPipe` is inert under `tsx` dev, so a
 *     deployment running that way accepts whatever the body says. This route
 *     sets a password with NO session and NO current password to compare
 *     against, which makes it the weakest way into an account if the floor lives
 *     only in a decorator.
 */

const CUSTOMER_ID = '507f1f77bcf86cd799439011';
const VERIFIED_ADDRESS = 'owner@example.com';
const PORTAL_BASE_URL = 'http://localhost:3011';

interface StoredCustomer {
  _id: string;
  email?: string;
  planKey: string;
  status: 'active' | 'suspended';
  passwordHash?: string;
  emailVerifiedAt?: Date;
  pendingEmail?: string;
  passwordResetTokenHash?: string;
  passwordResetExpiresAt?: Date;
  passwordChangedAt?: Date;
  [key: string]: unknown;
}

/** An account that can genuinely reset: active, has an address, proved it. */
function resettableCustomer(overrides: Partial<StoredCustomer> = {}): StoredCustomer {
  return {
    _id: CUSTOMER_ID,
    email: VERIFIED_ADDRESS,
    planKey: 'free',
    status: 'active',
    emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
    passwordHash: hashApiKey('not-a-real-scrypt-hash'),
    ...overrides,
  };
}

function buildService(seed: StoredCustomer[] = [resettableCustomer()]) {
  const store = new Map<string, StoredCustomer>();
  for (const doc of seed) store.set(doc._id, { ...doc });

  const find = (filter: Record<string, unknown>): StoredCustomer | undefined =>
    [...store.values()].find((doc) =>
      Object.entries(filter).every(([field, value]) =>
        field === '_id' ? String(doc._id) === String(value) : doc[field] === value,
      ),
    );

  const apply = (doc: StoredCustomer, update: Record<string, unknown>): void => {
    for (const [field, value] of Object.entries((update.$set ?? {}) as Record<string, unknown>)) {
      doc[field] = value;
    }
    for (const field of Object.keys((update.$unset ?? {}) as Record<string, unknown>)) {
      delete doc[field];
    }
  };

  const customers = {
    findOne: (filter: Record<string, unknown>) => ({
      lean: () => ({ exec: async () => find(filter) ?? null }),
    }),
    findById: (id: unknown) => {
      const query = {
        select: () => query,
        lean: () => ({ exec: async () => store.get(String(id)) ?? null }),
      };
      return query;
    },
    /**
     * The atomic consume. The find-and-unset is ONE synchronous critical section
     * exactly as Mongo's `findOneAndUpdate` is, which is what makes the
     * concurrent double-spend test below meaningful rather than decorative.
     *
     * `new: false` semantics: the PRE-image is returned, because that is what
     * carries the values `resetPassword` then judges.
     */
    findOneAndUpdate: (filter: Record<string, unknown>, update: Record<string, unknown>) => {
      const query = {
        select: () => query,
        lean: () => ({
          exec: async () => {
            const doc = find(filter);
            if (!doc) return null;
            const preImage = { ...doc };
            apply(doc, update);
            return preImage;
          },
        }),
      };
      return query;
    },
    updateOne: (filter: Record<string, unknown>, update: Record<string, unknown>) => ({
      exec: async () => {
        const doc = find(filter);
        if (doc) apply(doc, update);
        return { modifiedCount: doc ? 1 : 0 };
      },
    }),
  };

  const service = new CustomerAuthService(
    customers as never,
    { signAsync: async () => 'signed.customer.token' } as never,
    { getPlan: () => undefined } as never,
    {
      isProduction: false,
      customerEmailVerificationRequired: true,
      portalBaseUrl: PORTAL_BASE_URL,
    } as never,
  );
  return { service, store, doc: (id = CUSTOMER_ID) => store.get(id)! };
}

/**
 * With no mail transport the dev log is the delivery channel, so the tests read
 * the link exactly as a developer would — recipient included, because "was a
 * credential mailed, and to whom" is the property under test.
 */
let warnings: string[] = [];

beforeEach(() => {
  warnings = [];
  vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
    warnings.push(String(message));
  });
  // `debug` carries the server-side refusal reasons; captured so the
  // diagnosability half can be asserted without loosening the response.
  vi.spyOn(Logger.prototype, 'debug').mockImplementation((message: unknown) => {
    warnings.push(`DEBUG ${String(message)}`);
  });
  vi.spyOn(Logger.prototype, 'error').mockImplementation((message: unknown) => {
    warnings.push(`ERROR ${String(message)}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The most recent reset delivery, or undefined when nothing was mailed. */
function lastResetLink(): { recipient: string; link: string; token: string } | undefined {
  for (let i = warnings.length - 1; i >= 0; i -= 1) {
    const hit = /Password reset link for ([^:]+): (\S+)/.exec(warnings[i]);
    if (!hit) continue;
    const token = new URL(hit[2]).searchParams.get('token');
    if (!token) throw new Error(`reset link carried no token: ${hit[2]}`);
    return { recipient: hit[1], link: hit[2], token };
  }
  return undefined;
}

describe('requestPasswordReset — the uniform answer', () => {
  it('mails a link for an active, verified account, and the link is portal-shaped', async () => {
    const { service, doc } = buildService();

    await expect(service.requestPasswordReset(VERIFIED_ADDRESS, '203.0.113.1')).resolves.toEqual({
      ok: true,
    });

    const delivered = lastResetLink()!;
    expect(delivered.recipient).toBe(VERIFIED_ADDRESS);
    expect(delivered.link.startsWith(`${PORTAL_BASE_URL}/reset-password?token=`)).toBe(true);
    // Only the DIGEST is stored — the raw token exists in the mail and nowhere
    // else, so a database backup is not a set of keys to every account.
    expect(doc().passwordResetTokenHash).toBe(hashApiKey(delivered.token));
    expect(doc().passwordResetTokenHash).not.toBe(delivered.token);
    expect(doc().passwordResetExpiresAt).toBeInstanceOf(Date);
    // base64url: no `+`, `/` or `=`, so what the customer clicks is
    // byte-identical to what was hashed after a trip through a URL and a mailer.
    expect(delivered.token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('gives the token a 30-minute life — far shorter than a session', async () => {
    const { service, doc } = buildService();

    await service.requestPasswordReset(VERIFIED_ADDRESS, '203.0.113.1');

    const ttlMs = (doc().passwordResetExpiresAt as Date).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(29 * 60_000);
    expect(ttlMs).toBeLessThanOrEqual(30 * 60_000);
  });

  it.each([
    [
      'an address with no account at all',
      [] as StoredCustomer[],
      'nobody@example.com',
      'no account for',
    ],
    [
      'a SUSPENDED account',
      [resettableCustomer({ status: 'suspended' })],
      VERIFIED_ADDRESS,
      'is suspended',
    ],
    [
      'an account whose address was never PROVED',
      [resettableCustomer({ emailVerifiedAt: undefined })],
      VERIFIED_ADDRESS,
      'has no verified email address',
    ],
  ])('answers identically for %s, and mails nothing', async (_label, seed, address, logged) => {
    const { service } = buildService(seed);

    // Byte-identical to the success body above. The refusal is invisible to the
    // caller — and diagnosable to the operator, which is the whole reason each
    // branch logs.
    await expect(service.requestPasswordReset(address, '203.0.113.1')).resolves.toEqual({
      ok: true,
    });

    expect(lastResetLink()).toBeUndefined();
    expect(warnings.join('\n')).toContain(logged);
  });

  it('never treats a PENDING address as a reset target', async () => {
    // A pending address is a CLAIM, not proof. Mailing a reset to one would let
    // anybody who staged victim@corp.example on their own account collect a
    // credential for it — the takeover `setEmail` was made to fail closed
    // against, rebuilt on a route that needs no session at all.
    const { service } = buildService([
      resettableCustomer({ email: 'attacker@example.com', pendingEmail: 'victim@corp.example' }),
    ]);

    await expect(
      service.requestPasswordReset('victim@corp.example', '203.0.113.1'),
    ).resolves.toEqual({ ok: true });

    expect(lastResetLink()).toBeUndefined();
  });

  it('mints a fresh token that INVALIDATES the previous one', async () => {
    // One stored digest, so five clicks on "email me a link" leave exactly one
    // live token — the newest.
    const { service, doc } = buildService();

    await service.requestPasswordReset(VERIFIED_ADDRESS, '203.0.113.1');
    const first = lastResetLink()!.token;
    await service.requestPasswordReset(VERIFIED_ADDRESS, '203.0.113.1');
    const second = lastResetLink()!.token;

    expect(second).not.toBe(first);
    expect(doc().passwordResetTokenHash).toBe(hashApiKey(second));
    await expect(service.resetPassword(first, 'a-good-password', '203.0.113.1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('charges the per-address budget for an address with NO account', async () => {
    // A budget spent only on hits would BE the enumeration oracle, just read off
    // the 429 instead of the body: 5 requests for an unknown address must
    // exhaust it exactly as they would for a real one.
    const { service } = buildService([]);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        service.requestPasswordReset('nobody@example.com', '203.0.113.1'),
      ).resolves.toEqual({ ok: true });
    }

    const refusal = await captureError(() =>
      service.requestPasswordReset('nobody@example.com', '203.0.113.1'),
    );
    expect(refusal.status).toBe(429);
  });
});

describe('resetPassword — consume first, atomically', () => {
  /** Request a reset and hand back the raw token. */
  async function liveToken(stack: ReturnType<typeof buildService>): Promise<string> {
    await stack.service.requestPasswordReset(VERIFIED_ADDRESS, '203.0.113.1');
    return lastResetLink()!.token;
  }

  it('sets the new password, stamps passwordChangedAt and returns NO session', async () => {
    const stack = buildService();
    const token = await liveToken(stack);

    const result = await stack.service.resetPassword(token, 'a-brand-new-password', '203.0.113.1');

    // No token in the answer: the reset proves control of a mailbox, it does not
    // grant a session. Whoever resets signs in again.
    expect(result).toEqual({ ok: true });
    expect(result).not.toHaveProperty('token');
    expect(verifyPassword('a-brand-new-password', stack.doc().passwordHash)).toBe(true);
    // `passwordChangedAt` IS the portal-session eviction — `CustomerJwtGuard`
    // compares it against every customer token's `iat`.
    expect(stack.doc().passwordChangedAt).toBeInstanceOf(Date);
    // Single use: digest and deadline both gone.
    expect(stack.doc().passwordResetTokenHash).toBeUndefined();
    expect(stack.doc().passwordResetExpiresAt).toBeUndefined();
  });

  it('refuses a second use of the same token', async () => {
    const stack = buildService();
    const token = await liveToken(stack);
    await stack.service.resetPassword(token, 'a-brand-new-password', '203.0.113.1');

    await expect(
      stack.service.resetPassword(token, 'another-new-password', '203.0.113.1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    // …and the first password stands.
    expect(verifyPassword('a-brand-new-password', stack.doc().passwordHash)).toBe(true);
  });

  it('lets exactly ONE of two concurrent submissions win', async () => {
    // The atomic consume is the arbiter: the filter matches the digest and the
    // same operation clears it, so the loser gets nothing back.
    const stack = buildService();
    const token = await liveToken(stack);

    const outcomes = await Promise.allSettled([
      stack.service.resetPassword(token, 'first-new-password', '203.0.113.1'),
      stack.service.resetPassword(token, 'second-new-password', '203.0.113.1'),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
  });

  it('DESTROYS an expired token on the attempt rather than leaving it live', async () => {
    // Expiry is judged after the spend on purpose: an expired token must not sit
    // there waiting for a caller who fixes their clock.
    const stack = buildService();
    const token = await liveToken(stack);
    stack.doc().passwordResetExpiresAt = new Date(Date.now() - 1_000);

    await expect(
      stack.service.resetPassword(token, 'a-brand-new-password', '203.0.113.1'),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(stack.doc().passwordResetTokenHash).toBeUndefined();
    expect(stack.doc().passwordChangedAt).toBeUndefined();
  });

  it('re-checks suspension at SPEND time, not just at mint time', async () => {
    // An account suspended in the half hour since the link was issued must not
    // be walked back in through it. Distinguishable on purpose: the caller has
    // already proved control of the mailbox, so it is their own account's news.
    const stack = buildService();
    const token = await liveToken(stack);
    stack.doc().status = 'suspended';

    await expect(
      stack.service.resetPassword(token, 'a-brand-new-password', '203.0.113.1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(stack.doc().passwordChangedAt).toBeUndefined();
  });

  it('answers unknown, expired and already-spent tokens identically', async () => {
    // Telling a caller a token was real but expired confirms that the token they
    // hold — out of a log, a Referer, a forwarded mail — belongs to a live
    // account, which is exactly what the uniform request answer withholds.
    const stack = buildService();
    const spent = await liveToken(stack);
    await stack.service.resetPassword(spent, 'a-brand-new-password', '203.0.113.1');

    const expiredStack = buildService();
    const expiring = await liveToken(expiredStack);
    expiredStack.doc().passwordResetExpiresAt = new Date(Date.now() - 1_000);

    const unknown = await captureError(() =>
      buildService().service.resetPassword('never-issued-token', 'a-good-password', '203.0.113.1'),
    );
    const alreadySpent = await captureError(() =>
      stack.service.resetPassword(spent, 'a-good-password', '203.0.113.1'),
    );
    const expired = await captureError(() =>
      expiredStack.service.resetPassword(expiring, 'a-good-password', '203.0.113.1'),
    );

    expect(unknown.status).toBe(400);
    expect(alreadySpent).toEqual(unknown);
    expect(expired).toEqual(unknown);
  });
});

describe('the password floor', () => {
  it('is the SAME number in the DTO and in the service', () => {
    // If signup's bound were higher than the service's floor, reset would be the
    // weakest way into an account: an attacker holding a mailbox could set a
    // password signup itself would have refused.
    expect(DTO_MIN_PASSWORD_LENGTH).toBe(MIN_PASSWORD_LENGTH);
  });

  it('rejects a 7-character password on the reset path, BEFORE spending the token', async () => {
    const stack = buildService();
    await stack.service.requestPasswordReset(VERIFIED_ADDRESS, '203.0.113.1');
    const token = lastResetLink()!.token;

    await expect(stack.service.resetPassword(token, '1234567', '203.0.113.1')).rejects.toBeInstanceOf(
      BadRequestException,
    );

    // The customer must not spend their one live token discovering it was short.
    expect(stack.doc().passwordResetTokenHash).toBe(hashApiKey(token));
    await expect(
      stack.service.resetPassword(token, '12345678', '203.0.113.1'),
    ).resolves.toEqual({ ok: true });
  });

  it.each([
    ['a JSON number', 12345678],
    ['a JSON object', { length: 99 }],
    ['null', null],
    ['an array', ['aaaaaaaaaa']],
  ])('rejects %s rather than hashing it', async (_label, value) => {
    // The `typeof` half of the policy is the whole guard when the pipe is inert:
    // a non-string has `length === undefined`, and `undefined < 8` is FALSE, so a
    // length-only check waves a JSON number through to `hashPassword`.
    const stack = buildService();
    await stack.service.requestPasswordReset(VERIFIED_ADDRESS, '203.0.113.1');
    const token = lastResetLink()!.token;

    await expect(
      stack.service.resetPassword(token, value as never, '203.0.113.1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(stack.doc().passwordResetTokenHash).toBe(hashApiKey(token));
  });

  it('is enforced on changePassword too, not only on reset', async () => {
    // This route had no length check at all — "different from the current one"
    // was the entire policy, so a one-character password satisfied it.
    const stack = buildService([resettableCustomer({ passwordHash: undefined })]);

    await expect(
      stack.service.changePassword(CUSTOMER_ID, 'whatever-the-old-one-was', '1234567'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('ForgotPasswordDto / ResetPasswordDto', () => {
  it('accepts what the portal actually sends', () => {
    expect(errorsFor(ForgotPasswordDto, { email: 'someone@example.com' })).toEqual([]);
    expect(
      errorsFor(ResetPasswordDto, { token: 'abc123', newPassword: 'a-good-password' }),
    ).toEqual([]);
  });

  it('names the field `newPassword`, and REJECTS `password`', () => {
    // The client sends `newPassword`. Under `whitelist` + `forbidNonWhitelisted`
    // an unknown property 400s, so a rename here breaks every real reset with an
    // error that reads like a client bug. Two implementers guessed differently.
    expect(errorsFor(ResetPasswordDto, { token: 'abc123', password: 'a-good-password' }).length)
      .toBeGreaterThan(0);
    const dto = plainToInstance(ResetPasswordDto, {
      token: 'abc123',
      newPassword: 'a-good-password',
    });
    expect(Object.keys(dto).sort()).toEqual(['newPassword', 'token']);
  });

  it('bounds both fields', () => {
    expect(errorsFor(ResetPasswordDto, { token: '', newPassword: 'a-good-password' }).length)
      .toBeGreaterThan(0);
    expect(
      errorsFor(ResetPasswordDto, { token: 'a'.repeat(257), newPassword: 'a-good-password' }).length,
    ).toBeGreaterThan(0);
    expect(errorsFor(ResetPasswordDto, { token: 'abc123', newPassword: '1234567' }).length)
      .toBeGreaterThan(0);
    expect(errorsFor(ForgotPasswordDto, { email: 'not-an-email' }).length).toBeGreaterThan(0);
  });

  it('carries no customer id — an anonymous route must not take a tenant from the body', () => {
    const dto = plainToInstance(ForgotPasswordDto, { email: 'a@example.com' });
    expect(Object.keys(dto)).toEqual(['email']);
  });
});

describe('CustomerAuthController wiring', () => {
  /** The `RouteParamtypes` present on a handler, by parameter index. */
  function paramTypes(handler: string): number[] {
    const metadata =
      (Reflect.getMetadata(ROUTE_ARGS_METADATA, CustomerAuthController, handler) as Record<
        string,
        unknown
      >) ?? {};
    return Object.keys(metadata).map((key) => Number(key.split(':')[0]));
  }

  it.each(['login', 'forgotPassword', 'resetPassword', 'signup', 'verifyEmail'])(
    '%s takes @Ip() — the limiter it feeds is silently never charged without it',
    (handler) => {
      // Every one of these services takes `clientIp` as an OPTIONAL parameter so
      // a spec can call it directly, which means a controller that forgets the
      // decorator compiles, throws nothing, logs nothing, and leaves the bucket
      // at zero. On `reset-password` the IP is the ONLY key the request carries,
      // and `throttlePasswordResetConfirm` fails open without one — so the
      // anonymous route would be entirely unthrottled.
      expect(paramTypes(handler)).toContain(RouteParamtypes.IP);
    },
  );

  it('answers forgot-password with 202 and reset-password with 200', () => {
    // 202 for the request: it is accepted, and what happens next is deliberately
    // not reported. 200 for the confirm: `@Post` defaults to 201 CREATED and
    // this creates nothing.
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, CustomerAuthController.prototype.forgotPassword),
    ).toBe(HttpStatus.ACCEPTED);
    expect(
      Reflect.getMetadata(HTTP_CODE_METADATA, CustomerAuthController.prototype.resetPassword),
    ).toBe(HttpStatus.OK);
  });

  it('forwards the IP through to the service on all three routes', async () => {
    const calls: unknown[][] = [];
    const auth = {
      login: (...args: unknown[]) => (calls.push(['login', ...args]), Promise.resolve({})),
      requestPasswordReset: (...args: unknown[]) => (
        calls.push(['requestPasswordReset', ...args]), Promise.resolve({ ok: true })
      ),
      resetPassword: (...args: unknown[]) => (
        calls.push(['resetPassword', ...args]), Promise.resolve({ ok: true })
      ),
    };
    const controller = new CustomerAuthController(auth as never);

    await controller.login({ email: 'a@example.com', password: 'pw' } as never, '203.0.113.1');
    await controller.forgotPassword({ email: 'a@example.com' } as never, '203.0.113.2');
    await controller.resetPassword(
      { token: 'tok', newPassword: 'a-good-password' } as never,
      '203.0.113.3',
    );

    expect(calls).toEqual([
      ['login', 'a@example.com', 'pw', '203.0.113.1'],
      ['requestPasswordReset', 'a@example.com', '203.0.113.2'],
      ['resetPassword', 'tok', 'a-good-password', '203.0.113.3'],
    ]);
  });
});

function errorsFor(
  dto: new () => object,
  payload: Record<string, unknown>,
): unknown[] {
  return validateSync(plainToInstance(dto, payload), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

async function captureError(run: () => Promise<unknown>): Promise<{ status: number; body: unknown }> {
  try {
    await run();
    throw new Error('expected the call to reject');
  } catch (err) {
    const error = err as { getStatus?: () => number; getResponse?: () => unknown };
    if (typeof error.getStatus !== 'function' || typeof error.getResponse !== 'function') throw err;
    return { status: error.getStatus(), body: error.getResponse() };
  }
}
