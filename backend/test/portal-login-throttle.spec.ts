import 'reflect-metadata';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { hashPassword } from '../src/auth/password.util.js';
import { CustomerAuthService } from '../src/portal/customer-auth.service.js';

/**
 * The PER-IP login bucket, and why it is a denial-of-service control rather
 * than a nicety.
 *
 * Login now runs scrypt whether or not the address exists — that is what closes
 * the enumeration oracle (`DUMMY_PASSWORD_HASH`), and it is why every failed
 * login costs ~18ms of SYNCHRONOUS event loop, `/v1` traffic included. The
 * per-ADDRESS bucket caps nothing an attacker cares about: they vary the address
 * for free. So the properties pinned here are:
 *
 *  1. the budget is spent per SOURCE, across different addresses (a per-address
 *     bucket alone would never fire on a spray);
 *  2. `::ffff:1.2.3.4` and `1.2.3.4` are ONE bucket — Express reports an IPv4
 *     client over a dual-stack socket in the mapped form, so two spellings of
 *     one source would otherwise silently double the budget;
 *  3. a successful login clears the ADDRESS bucket and deliberately NOT the IP
 *     one. Clearing both would let an attacker who owns any valid account wipe
 *     their own spray budget on demand — one cheap login every 19 guesses and
 *     the limiter never fires again;
 *  4. with no usable IP the fallback is the address bucket ALONE. There is no
 *     shared last-resort bucket, because one misconfigured proxy hop collapses
 *     every visitor onto one key and a shared bucket would then lock every
 *     customer in the world out of logging in — the guard becoming the outage.
 *
 * NO WALL-CLOCK TIMING TEST HERE, on purpose: a KDF-duration assertion flakes
 * under parallel workers and gets deleted by whoever gets paged for it. The
 * unconditional-work property is asserted structurally instead — an unknown
 * address answers 401 rather than short-circuiting.
 */

/** `loginIpLimiter` — points per source address per 5 minutes. */
const IP_POINTS = 20;
/** `loginLimiter` — points per email address per 5 minutes. */
const ADDRESS_POINTS = 10;

const PASSWORD = 'a-good-password';
const KNOWN_ADDRESS = 'real@example.com';

interface StoredCustomer {
  _id: string;
  email: string;
  planKey: string;
  status: 'active' | 'suspended';
  passwordHash: string;
  lastLoginAt?: Date;
  emailVerifiedAt?: Date;
}

/**
 * A real `CustomerAuthService` over one in-memory customer.
 *
 * `login` reads a HYDRATED document (it writes `lastLoginAt` back with
 * `.save()`), so the stub returns an object carrying `save`, and `select` is a
 * pass-through because `passwordHash` is `select: false` in the real schema.
 */
function buildService(opts: { status?: 'active' | 'suspended' } = {}) {
  const saved: StoredCustomer[] = [];
  const customer: StoredCustomer & { save(): Promise<void> } = {
    _id: '507f1f77bcf86cd799439011',
    email: KNOWN_ADDRESS,
    planKey: 'free',
    status: opts.status ?? 'active',
    passwordHash: hashPassword(PASSWORD),
    async save() {
      saved.push({ ...this });
    },
  };

  const customers = {
    findOne: (filter: Record<string, unknown>) => ({
      select: () => ({
        exec: async () => (filter.email === KNOWN_ADDRESS ? customer : null),
      }),
    }),
  };

  const service = new CustomerAuthService(
    customers as never,
    { signAsync: async () => 'signed.customer.token' } as never,
    { getPlan: () => undefined } as never,
    { isProduction: false, customerEmailVerificationRequired: true } as never,
  );
  return { service, saved };
}

/** The status of a rejected login, or 0 when it unexpectedly resolved. */
async function statusOf(run: () => Promise<unknown>): Promise<number> {
  try {
    await run();
    return 0;
  } catch (err) {
    const error = err as { getStatus?: () => number };
    if (typeof error.getStatus !== 'function') throw err;
    return error.getStatus();
  }
}

/** A wrong-password attempt against an address that does not exist. */
function miss(service: CustomerAuthService, index: number, ip?: string): Promise<number> {
  return statusOf(() => service.login(`nobody-${index}@example.com`, 'wrong-password', ip));
}

describe('per-IP login metering', () => {
  it('spends the budget per SOURCE across different addresses, and fires on the 21st', async () => {
    // Every attempt uses a DIFFERENT address, so the per-address bucket
    // (10/5min) is never even at 2. Only the IP bucket can fire.
    const { service } = buildService();
    const ip = '203.0.113.7';

    for (let attempt = 1; attempt < IP_POINTS; attempt += 1) {
      // 19 attempts: refused as bad credentials, NOT throttled.
      expect(await miss(service, attempt, ip)).toBe(401);
    }

    // The 20th spends the last point and is still a credential refusal.
    expect(await miss(service, IP_POINTS, ip)).toBe(401);
    // The 21st has no budget left.
    expect(await miss(service, IP_POINTS + 1, ip)).toBe(429);
  });

  it('collapses ::ffff: mapped IPv4 onto the SAME bucket as its plain form', async () => {
    // Otherwise a caller reaching a dual-stack socket gets two budgets for one
    // source, and the cap silently doubles.
    const { service } = buildService();

    for (let attempt = 1; attempt <= IP_POINTS; attempt += 1) {
      expect(await miss(service, attempt, '203.0.113.9')).toBe(401);
    }

    expect(await miss(service, 99, '::ffff:203.0.113.9')).toBe(429);
  });

  it.each([
    ['nothing supplied', undefined],
    ['the IPv6 unspecified address', '::'],
    ['the IPv4 unspecified address', '0.0.0.0'],
  ])('falls back to the address bucket ALONE when the IP is %s', async (_label, ip) => {
    // No shared last-resort bucket: a flood from an unusable IP may only ever
    // exhaust the budget of the ADDRESS it was spent on.
    const { service } = buildService();

    for (let attempt = 1; attempt <= ADDRESS_POINTS; attempt += 1) {
      expect(await statusOf(() => service.login('one@example.com', 'wrong', ip))).toBe(401);
    }
    expect(await statusOf(() => service.login('one@example.com', 'wrong', ip))).toBe(429);

    // A DIFFERENT address still has its own full budget — the exhausted one did
    // not land in a bucket shared by everybody.
    expect(await statusOf(() => service.login('two@example.com', 'wrong', ip))).toBe(401);
  });
});

describe('what a successful login resets', () => {
  it('clears the ADDRESS bucket', async () => {
    const { service } = buildService();
    const ip = '203.0.113.11';

    for (let attempt = 1; attempt < ADDRESS_POINTS; attempt += 1) {
      expect(await statusOf(() => service.login(KNOWN_ADDRESS, 'wrong', ip))).toBe(401);
    }

    await expect(service.login(KNOWN_ADDRESS, PASSWORD, ip)).resolves.toMatchObject({
      token: 'signed.customer.token',
    });

    // Without the reset the budget would be spent and these would be 429s: 9
    // failures plus the successful attempt is already at the 10-point cap.
    for (let attempt = 1; attempt < ADDRESS_POINTS; attempt += 1) {
      expect(await statusOf(() => service.login(KNOWN_ADDRESS, 'wrong', ip))).toBe(401);
    }
  });

  it('does NOT clear the IP bucket — the spray budget survives a valid login', async () => {
    // THE attack this closes: an attacker who owns one valid account interleaves
    // a cheap successful login to wipe their own per-source budget, and the
    // limiter never fires no matter how long they spray.
    const { service } = buildService();
    const ip = '203.0.113.13';

    for (let attempt = 1; attempt < IP_POINTS; attempt += 1) {
      expect(await miss(service, attempt, ip)).toBe(401);
    }

    // Point 20 of 20, spent on a login that SUCCEEDS.
    await expect(service.login(KNOWN_ADDRESS, PASSWORD, ip)).resolves.toMatchObject({
      token: 'signed.customer.token',
    });

    // If the success had cleared the IP bucket this would be a 401.
    expect(await miss(service, IP_POINTS + 1, ip)).toBe(429);
  });

  it('is charged BEFORE the credential check, so a suspended account still meters', async () => {
    // The throttle runs first on purpose: a bucket charged only on the paths
    // that reach the password comparison is a bucket an attacker can dodge.
    const { service } = buildService({ status: 'suspended' });
    const ip = '203.0.113.15';

    expect(await statusOf(() => service.login(KNOWN_ADDRESS, PASSWORD, ip))).toBe(403);

    for (let attempt = 1; attempt < IP_POINTS; attempt += 1) {
      await miss(service, attempt, ip);
    }
    // 1 (the 403) + 19 = 20 spent, so the next attempt has nothing left.
    expect(await miss(service, IP_POINTS, ip)).toBe(429);
  });
});

describe('login answers a missing account and a wrong password identically', () => {
  it('returns the same 401 body for both, having hashed on both paths', async () => {
    // The KDF runs against `DUMMY_PASSWORD_HASH` when the address is unknown, so
    // the two paths cost the same work. The observable half of that — one
    // indistinguishable answer — is what is asserted here.
    const { service } = buildService();

    const unknown = await captureError(() =>
      service.login('nobody@example.com', PASSWORD, '203.0.113.17'),
    );
    const wrongPassword = await captureError(() =>
      service.login(KNOWN_ADDRESS, 'not-the-password', '203.0.113.17'),
    );

    expect(unknown.status).toBe(401);
    expect(unknown.status).toBe(wrongPassword.status);
    expect(unknown.body).toEqual(wrongPassword.body);
    expect(unknown.body).toEqual({ error: 'Invalid email or password' });
  });

  it('refuses a suspended account at the door rather than issuing a token', async () => {
    const { service } = buildService({ status: 'suspended' });

    await expect(service.login(KNOWN_ADDRESS, PASSWORD, '203.0.113.19')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('is an UnauthorizedException, not a bare Error, on the miss path', async () => {
    const { service } = buildService();

    await expect(
      service.login('nobody@example.com', PASSWORD, '203.0.113.21'),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

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
