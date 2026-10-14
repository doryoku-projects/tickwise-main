import 'reflect-metadata';
import { BadRequestException, Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashApiKey } from '../src/billing/api-key.util.js';
import { CustomerAuthService } from '../src/portal/customer-auth.service.js';
import { VerifyEmailDto } from '../src/portal/portal.dto.js';

/**
 * Email verification as a 6-DIGIT OTP.
 *
 * The whole point of these tests is that shortening the credential from a
 * 32-byte token to six digits is only safe because of the controls around it,
 * so each control is pinned individually: the code's shape and randomness
 * source, that only its hash is persisted, the 10-minute deadline, single use,
 * the attempt cap that destroys the code, and the fact that a wrong code and no
 * outstanding code are indistinguishable from outside.
 *
 * The real `CustomerAuthService` is exercised against an in-memory customers
 * model — asserting against a stubbed service would test nothing, and the
 * STORED DOCUMENT is where most of these properties are actually visible.
 */

const CODE_RE = /^\d{6}$/;
/** `MAX_VERIFICATION_ATTEMPTS` in the service — wrong tries an outstanding code survives. */
const MAX_ATTEMPTS = 5;
/** The address every `signupWithCode` account below registers with. */
const OWNER = 'owner@example.com';

/**
 * The stored verification slot: `<sha256-hex>:<attempts>:<target-address>`.
 *
 * THE THIRD SEGMENT IS A SECURITY CONTROL, not bookkeeping — it is the address
 * the code was mailed to, and `verifyForCustomer` refuses to promote or stamp
 * anything when it does not match (see the binding tests below). Written out
 * through this helper so the format lives in one place: these assertions used to
 * hard-code the two-segment form, which is exactly how a spec keeps passing while
 * the binding it should be pinning goes missing.
 */
function slot(hash: string, attempts: number, target: string = OWNER): string {
  return `${hash}:${attempts}:${target}`;
}

interface StoredCustomer {
  _id: string;
  name: string;
  email?: string;
  planKey: string;
  status: 'active' | 'suspended';
  emailVerifiedAt?: Date;
  emailVerificationTokenHash?: string;
  emailVerificationExpiresAt?: Date;
  [key: string]: unknown;
}

/** Minimal Mongo filter matching: equality, `$in`, `$gt`. Enough for this file. */
function matches(doc: StoredCustomer, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([field, expected]) => {
    const actual = field === '_id' ? doc._id : (doc[field] as unknown);
    if (expected !== null && typeof expected === 'object' && !(expected instanceof Date)) {
      const operators = expected as { $in?: unknown[]; $gt?: Date };
      if (operators.$in) return operators.$in.some((value) => String(value) === String(actual));
      if (operators.$gt) {
        return actual instanceof Date && actual.getTime() > operators.$gt.getTime();
      }
      return false;
    }
    return String(actual) === String(expected);
  });
}

function applyUpdate(doc: StoredCustomer, update: Record<string, unknown>): void {
  const set = (update.$set ?? {}) as Record<string, unknown>;
  const unset = (update.$unset ?? {}) as Record<string, unknown>;
  for (const [field, value] of Object.entries(set)) doc[field] = value;
  for (const field of Object.keys(unset)) delete doc[field];
}

function buildService(opts: { verification?: boolean; production?: boolean } = {}) {
  const store = new Map<string, StoredCustomer>();
  let nextId = 0;
  const newId = () => `507f1f77bcf86cd7994390${String(nextId++).padStart(2, '0')}`;

  const find = (filter: Record<string, unknown>): StoredCustomer | undefined =>
    [...store.values()].find((doc) => matches(doc, filter));

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
    findOneAndUpdate: (filter: Record<string, unknown>, update: Record<string, unknown>) => ({
      lean: () => ({
        exec: async () => {
          const doc = find(filter);
          if (!doc) return null;
          applyUpdate(doc, update);
          return doc;
        },
      }),
    }),
    updateOne: (filter: Record<string, unknown>, update: Record<string, unknown>) => ({
      exec: async () => {
        const doc = find(filter);
        if (doc) applyUpdate(doc, update);
        return { modifiedCount: doc ? 1 : 0 };
      },
    }),
    create: async (doc: Record<string, unknown>) => {
      const _id = newId();
      const stored = { _id, ...doc } as StoredCustomer;
      store.set(_id, stored);
      return stored;
    },
  };

  const jwt = { signAsync: async () => 'signed.customer.token' };
  const settings = { getPlan: () => undefined };
  const config = {
    isProduction: opts.production ?? false,
    customerEmailVerificationRequired: opts.verification ?? true,
  } as never;

  const service = new CustomerAuthService(customers as never, jwt as never, settings as never, config);
  return {
    service,
    store,
    /** The single customer created by `signup` below. */
    only: () => [...store.values()][0],
  };
}

/**
 * The dev-only log line is the ONLY channel the raw code exists on (there is
 * still no mail transport), so the tests read it exactly as a developer would.
 */
let warnings: string[] = [];

beforeEach(() => {
  warnings = [];
  vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
    warnings.push(String(message));
  });
  vi.spyOn(Logger.prototype, 'error').mockImplementation((message: unknown) => {
    warnings.push(`ERROR ${String(message)}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The most recently logged verification code, or undefined if none was logged. */
function loggedCode(): string | undefined {
  return lastDelivery()?.code;
}

/**
 * The most recent delivery, RECIPIENT INCLUDED.
 *
 * The address matters as much as the code here: finding 1a was a takeover in
 * which the right code went to the WRONG mailbox, and a test that reads only the
 * digits cannot see that at all.
 */
function lastDelivery(): { recipient: string; code: string } | undefined {
  for (let i = warnings.length - 1; i >= 0; i -= 1) {
    const hit = /Email verification code for ([^:]+): (\d+)/.exec(warnings[i]);
    if (hit) return { recipient: hit[1], code: hit[2] };
  }
  return undefined;
}

async function signupWithCode(opts: { production?: boolean } = {}) {
  const stack = buildService({ verification: true, production: opts.production });
  await stack.service.signup('owner@example.com', 'a-good-password');
  return { ...stack, code: loggedCode() };
}

describe('verification code generation', () => {
  it('mints a 6-digit code, zero-padded, never a long token', async () => {
    // Many draws: `randomInt(0, 1_000_000)` produces values needing padding
    // roughly 1 time in 10, and an unpadded code would silently shrink the
    // space AND fail the DTO's Length(6, 6).
    for (let i = 0; i < 40; i += 1) {
      const { code } = await signupWithCode();
      expect(code).toMatch(CODE_RE);
    }
  });

  it('stores only the HASH of the code, never the code itself', async () => {
    const { code, only } = await signupWithCode();
    const stored = only().emailVerificationTokenHash ?? '';

    expect(code).toBeDefined();
    expect(stored).not.toContain(code!);
    // `<sha256-hex>:<attempts>:<target>` — the counter is packed beside the hash
    // because Mongoose silently drops an undeclared path from a `$set`, and the
    // target is the address the code proves control of.
    expect(stored).toBe(slot(hashApiKey(code!), 0));
    expect(JSON.stringify(only())).not.toContain(code!);
  });

  it('gives the code a 10-minute life, not 24 hours', async () => {
    const { only } = await signupWithCode();
    const ttlMs = (only().emailVerificationExpiresAt as Date).getTime() - Date.now();

    expect(ttlMs).toBeGreaterThan(9 * 60_000);
    expect(ttlMs).toBeLessThanOrEqual(10 * 60_000);
  });

  it('refuses to log the code in production', async () => {
    const { code } = await signupWithCode({ production: true });

    expect(code).toBeUndefined();
    expect(warnings.join('\n')).toContain('no mail transport is configured');
  });
});

describe('verifying a code', () => {
  it('accepts the correct code and clears every trace of it', async () => {
    const { service, only, code } = await signupWithCode();

    const result = await service.verifyEmail(code!, only()._id);

    expect(result.ok).toBe(true);
    expect(result.customer.emailVerifiedAt).not.toBeNull();
    expect(result.customer.email).toBe('owner@example.com');
    // Single use: hash, deadline and counter all gone.
    expect(only().emailVerificationTokenHash).toBeUndefined();
    expect(only().emailVerificationExpiresAt).toBeUndefined();
    expect(only().emailVerifiedAt).toBeInstanceOf(Date);
  });

  it('refuses to reuse a code that already verified the address', async () => {
    const { service, only, code } = await signupWithCode();
    await service.verifyEmail(code!, only()._id);

    await expect(service.verifyEmail(code!, only()._id)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses an EXPIRED code even though the hash still matches', async () => {
    const { service, only, code } = await signupWithCode();
    only().emailVerificationExpiresAt = new Date(Date.now() - 1_000);

    await expect(service.verifyEmail(code!, only()._id)).rejects.toBeInstanceOf(BadRequestException);
    expect(only().emailVerifiedAt).toBeUndefined();
    // An expired code is swept, not left lying around.
    expect(only().emailVerificationTokenHash).toBeUndefined();
  });

  it('counts a wrong code against the outstanding one', async () => {
    const { service, only, code } = await signupWithCode();
    const hash = hashApiKey(code!);

    await expect(service.verifyEmail(wrongCode(code!), only()._id)).rejects.toThrow();
    expect(only().emailVerificationTokenHash).toBe(slot(hash, 1));

    await expect(service.verifyEmail(wrongCode(code!), only()._id)).rejects.toThrow();
    expect(only().emailVerificationTokenHash).toBe(slot(hash, 2));

    // …and the real code still works while budget remains.
    await expect(service.verifyEmail(code!, only()._id)).resolves.toMatchObject({ ok: true });
  });

  it('destroys the code once the wrong-attempt budget is spent — the CORRECT code then fails too', async () => {
    // This is the control that makes six digits defensible at all: without it
    // 10^6 is minutes of scripted guessing.
    const { service, only, code } = await signupWithCode();
    const hash = hashApiKey(code!);

    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      await expect(service.verifyEmail(wrongCode(code!), only()._id)).rejects.toThrow();
      expect(only().emailVerificationTokenHash).toBe(slot(hash, attempt));
    }

    // The 5th wrong submission spends the budget and invalidates the code.
    await expect(service.verifyEmail(wrongCode(code!), only()._id)).rejects.toThrow();
    expect(only().emailVerificationTokenHash).toBeUndefined();
    expect(only().emailVerificationExpiresAt).toBeUndefined();

    // The 6th submission carries the RIGHT code and is still refused — the
    // customer has to request a new one, which is the point.
    await expect(service.verifyEmail(code!, only()._id)).rejects.toBeInstanceOf(BadRequestException);
    expect(only().emailVerifiedAt).toBeUndefined();
  });

  it('resets the attempt counter when a new code is issued', async () => {
    const { service, only, code } = await signupWithCode();
    await expect(service.verifyEmail(wrongCode(code!), only()._id)).rejects.toThrow();
    expect(only().emailVerificationTokenHash).toBe(slot(hashApiKey(code!), 1));

    await service.resendVerification(only()._id);
    const fresh = loggedCode();

    expect(fresh).toMatch(CODE_RE);
    expect(only().emailVerificationTokenHash).toBe(slot(hashApiKey(fresh!), 0));
    // The superseded code is dead — one stored hash means only the latest works.
    await expect(service.verifyEmail(code!, only()._id)).rejects.toThrow();
  });

  it('answers a wrong code and NO outstanding code identically', async () => {
    // Distinguishable replies would make this an oracle for whether a given
    // account is mid-verification.
    const { service, only, code } = await signupWithCode();

    const wrong = await captureError(() => service.verifyEmail(wrongCode(code!), only()._id));

    // Clear the outstanding code entirely, then ask again.
    delete only().emailVerificationTokenHash;
    delete only().emailVerificationExpiresAt;
    const absent = await captureError(() => service.verifyEmail(code!, only()._id));

    expect(wrong.status).toBe(absent.status);
    expect(wrong.body).toEqual(absent.body);
  });

  // The anonymous, code-only path is GONE, and these two cases went with it. It
  // found the account by scanning for the code's hash, which meant a wrong guess
  // matched no document and there was no counter to charge — the per-code
  // attempt cap, the entire defence of a six-digit secret, silently did not
  // apply there. It also stamped the proof without promoting a staged
  // `pendingEmail`. `verifyEmail` now REQUIRES a customerId and the route is
  // guarded, so every attempt is attributable and capped.
  it('requires an account — verification is never anonymous', async () => {
    const { service, only, code } = await signupWithCode();

    // Typed, so an anonymous call cannot even be written any more; this asserts
    // the runtime behaviour that goes with it.
    await expect(
      (service as unknown as { verifyEmail(c: string): Promise<unknown> }).verifyEmail(code!),
    ).rejects.toThrow();

    // …and the correct code still works when it is attributed to the account.
    await expect(service.verifyEmail(code!, only()._id)).resolves.toMatchObject({ ok: true });
    expect(only().emailVerifiedAt).toBeInstanceOf(Date);
  });
});

/**
 * THE CODE IS BOUND TO THE ADDRESS IT WAS MAILED TO — findings 1a and 1b.
 *
 * The attack these close, end to end: sign up unverified, stage a victim's
 * address with `PATCH /account/profile`, then press resend. The old code mailed
 * to `customer.email` — still the ATTACKER's address — while `verifyForCustomer`
 * promoted `pendingEmail` on any hash match. So the attacker received a code and
 * spending it stamped `emailVerifiedAt` on the VICTIM's address, which rule (b)
 * of `IdentityService.resolveLogin` then auto-links the victim's real Google or
 * GitHub sign-in into.
 *
 * Two independent fixes, and each is pinned separately below, because either one
 * alone leaves a hole: resend now mails the PENDING address (so the code never
 * reaches the attacker), and the stored slot carries the address it was issued
 * for and verification FAILS CLOSED when it does not match (so a code obtained
 * some other way still cannot prove an address it was not sent to).
 */
describe('the code is bound to the address it was mailed to', () => {
  it('resends to the PENDING address, never the account address', async () => {
    const { service, only } = await signupWithCode();
    // The staged claim, exactly as `setEmail` leaves it.
    only().pendingEmail = 'victim@corp.example';

    await service.resendVerification(only()._id);

    // THE takeover assertion: the mail goes to the address being claimed, so an
    // attacker who staged somebody else's address receives nothing.
    const delivered = lastDelivery()!;
    expect(delivered.recipient).toBe('victim@corp.example');
    expect(delivered.recipient).not.toBe(OWNER);
    // …and the slot is bound to that same address, so it can only prove that one.
    expect(only().emailVerificationTokenHash).toBe(
      slot(hashApiKey(delivered.code), 0, 'victim@corp.example'),
    );
  });

  it('sends nothing — and burns no outstanding code — for an account with no address at all', async () => {
    // A wallet-only (SIWE) account. The old code handed the mailer a raw
    // ObjectId as the recipient (`customer.email ?? customerId`); worse, the
    // recipient is now resolved BEFORE minting, so discovering there is nowhere
    // to send must not invalidate whatever code is already outstanding.
    const { service, store } = buildService();
    const id = '507f1f77bcf86cd799439099';
    const live = `${hashApiKey('123456')}:0:earlier@example.com`;
    store.set(id, {
      _id: id,
      name: 'wallet-only',
      planKey: 'free',
      status: 'active',
      emailVerificationTokenHash: live,
      emailVerificationExpiresAt: new Date(Date.now() + 60_000),
    });
    warnings = [];

    await expect(service.resendVerification(id)).resolves.toEqual({ ok: true });

    expect(lastDelivery()).toBeUndefined();
    // The outstanding code is untouched — not re-minted, not cleared.
    expect(store.get(id)!.emailVerificationTokenHash).toBe(live);
  });

  it('fails CLOSED on an UNBOUND slot — a code from the old build proves nothing', async () => {
    // There is deliberately no legacy grace: an unbound slot proves control of
    // neither address, and a grace window would keep the takeover alive after
    // deploy for anyone still holding a code minted by the previous build.
    const { service, store } = buildService();
    const id = '507f1f77bcf86cd799439098';
    store.set(id, {
      _id: id,
      name: 'legacy',
      planKey: 'free',
      status: 'active',
      email: 'legacy@example.com',
      // Two segments — the pre-binding encoding.
      emailVerificationTokenHash: `${hashApiKey('424242')}:0`,
      emailVerificationExpiresAt: new Date(Date.now() + 60_000),
    });

    // The CORRECT code, and it is still refused.
    await expect(service.verifyEmail('424242', id)).rejects.toBeInstanceOf(BadRequestException);

    expect(store.get(id)!.emailVerifiedAt).toBeUndefined();
    // Burnt on the attempt rather than left to be retried after a schema tweak.
    expect(store.get(id)!.emailVerificationTokenHash).toBeUndefined();
  });

  it('fails CLOSED when the slot is bound to a THIRD address', async () => {
    // Neither the pending claim nor the current address. Nothing may be stamped
    // and nothing may be promoted — the code went somewhere else entirely.
    const { service, store } = buildService();
    const id = '507f1f77bcf86cd799439097';
    store.set(id, {
      _id: id,
      name: 'third-party',
      planKey: 'free',
      status: 'active',
      email: 'account@example.com',
      pendingEmail: 'claimed@example.com',
      emailVerificationTokenHash: `${hashApiKey('424242')}:0:somewhere-else@example.com`,
      emailVerificationExpiresAt: new Date(Date.now() + 60_000),
    });

    await expect(service.verifyEmail('424242', id)).rejects.toBeInstanceOf(BadRequestException);

    const doc = store.get(id)!;
    expect(doc.emailVerifiedAt).toBeUndefined();
    expect(doc.email).toBe('account@example.com');
    // The claim survives — only the code dies, so the customer asks for a new
    // one rather than retyping the address.
    expect(doc.pendingEmail).toBe('claimed@example.com');
    expect(doc.emailVerificationTokenHash).toBeUndefined();
  });

  it('promotes when the slot IS bound to the pending address, and only then', async () => {
    const { service, store } = buildService();
    const id = '507f1f77bcf86cd799439096';
    store.set(id, {
      _id: id,
      name: 'promoting',
      planKey: 'free',
      status: 'active',
      email: 'old@example.com',
      pendingEmail: 'claimed@example.com',
      emailVerificationTokenHash: `${hashApiKey('424242')}:0:claimed@example.com`,
      emailVerificationExpiresAt: new Date(Date.now() + 60_000),
    });

    const result = await service.verifyEmail('424242', id);

    expect(result.customer.email).toBe('claimed@example.com');
    expect(result.customer.pendingEmail).toBeNull();
    expect(store.get(id)!.email).toBe('claimed@example.com');
    expect(store.get(id)!.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it('kills a live reset token when the promotion changes the address', async () => {
    // The outstanding link was mailed to the PREVIOUS address. Leaving it
    // spendable means whoever still reads that mailbox owns the account for up
    // to PASSWORD_RESET_TTL_MS after it stopped being theirs.
    const { service, store } = buildService();
    const id = '507f1f77bcf86cd799439095';
    store.set(id, {
      _id: id,
      name: 'moving',
      planKey: 'free',
      status: 'active',
      email: 'old@example.com',
      pendingEmail: 'new@example.com',
      emailVerificationTokenHash: `${hashApiKey('424242')}:0:new@example.com`,
      emailVerificationExpiresAt: new Date(Date.now() + 60_000),
      passwordResetTokenHash: hashApiKey('a-live-reset-token'),
      passwordResetExpiresAt: new Date(Date.now() + 60_000),
    });

    await service.verifyEmail('424242', id);

    expect(store.get(id)!.passwordResetTokenHash).toBeUndefined();
    expect(store.get(id)!.passwordResetExpiresAt).toBeUndefined();
  });
});

describe('VerifyEmailDto', () => {
  it('accepts a 6-digit code and rejects everything else', () => {
    expect(validationErrors({ code: '000123' })).toEqual([]);

    expect(validationErrors({ code: '12345' }).length).toBeGreaterThan(0); // too short
    expect(validationErrors({ code: '1234567' }).length).toBeGreaterThan(0); // too long
    expect(validationErrors({ code: 'abcdef' }).length).toBeGreaterThan(0); // not digits
    expect(validationErrors({ code: '12 456' }).length).toBeGreaterThan(0); // not digits
  });

  // The pre-rename `token` field is GONE, along with the temporary accessor that
  // bridged it while the controller still read `body.token`. The controller now
  // reads `body.code`, so a stale client sending `token` is simply rejected by
  // the global `forbidNonWhitelisted` pipe — which is the intended contract.
  it('rejects the pre-rename `token` field instead of honouring it', () => {
    const dto = plainToInstance(VerifyEmailDto, { code: '424242', token: 'legacy' });

    expect(dto.code).toBe('424242');
    expect((dto as Record<string, unknown>).token).toBe('legacy');
    // `token` carries no decorator, so whitelist validation flags it.
    expect(validationErrors({ code: '424242', token: 'legacy' }).length).toBeGreaterThan(0);
  });
});

/** A 6-digit code guaranteed different from `code`. */
function wrongCode(code: string): string {
  const wrong = (Number.parseInt(code, 10) + 1) % 1_000_000;
  return String(wrong).padStart(6, '0');
}

function validationErrors(payload: Record<string, unknown>): unknown[] {
  return validateSync(plainToInstance(VerifyEmailDto, payload), {
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
