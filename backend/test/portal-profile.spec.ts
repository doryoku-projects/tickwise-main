import 'reflect-metadata';
import { BadRequestException, ConflictException, Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashApiKey } from '../src/billing/api-key.util.js';
import { CustomerAuthService } from '../src/portal/customer-auth.service.js';
import { CustomerSelfService } from '../src/portal/customer-self.service.js';
import type { CustomerPrincipal } from '../src/portal/customer-jwt.guard.js';
import { UpdateProfileDto } from '../src/portal/portal.dto.js';

/**
 * `PATCH /account/profile` — letting a wallet-only account add an email, and
 * the OTP that turns that claim into the account's real address.
 *
 * An email is STAGED, then PROMOTED. It is never written to `customer.email`
 * until a code proves it, and BOTH halves are asserted on the MONGO WRITE
 * rather than on the return value:
 *
 *  1. the update filter carries the caller's own customerId (it comes from the
 *     token; there is no id in the path), so the write could not have landed on
 *     another tenant even if the returned document looked right;
 *  2. the claim lands in `pendingEmail` and `email` is NOT in the `$set`.
 *     `email` carries a unique partial index, so writing an unproven address
 *     there SQUATS it — anyone could claim ceo@bigcorp.com, never verify, and
 *     permanently block the real owner from registering. Denial of
 *     registration, no auth required; and
 *  3. `emailVerifiedAt` is neither stamped NOR cleared by the claim. It is read
 *     elsewhere as PROOF of control — `IdentityService.resolveLogin` rule (b)
 *     auto-links a provider identity into an account that carries it — so
 *     stamping it on a typed-in address rebuilds the pre-registration takeover
 *     this codebase already fixed once, while CLEARING it would mean a typo
 *     costs you the address you already proved.
 *
 * Promotion (`verifyForCustomer` on a correct code) is the security-critical
 * half: it is the only place `pendingEmail` becomes `email`, and the unique
 * index — not the read before it — is what arbitrates a race, so first to
 * PROVE an address wins and the loser keeps their pending claim.
 */

const CUSTOMER_A = '507f1f77bcf86cd799439011';
const CUSTOMER_B = '507f1f77bcf86cd799439012';

/** `MAX_VERIFICATION_ATTEMPTS` in the service. */
const MAX_ATTEMPTS = 5;

/**
 * A regex matching a stored verification slot bound to `target`:
 * `<sha256-hex>:<attempts>:<target-address>`.
 *
 * The third segment is the address the code was mailed to, and it is what makes
 * promotion safe: `verifyForCustomer` will not promote a claim — or stamp
 * `emailVerifiedAt` at all — unless the code was issued FOR the address being
 * proved. Asserting the target rather than just the counter is the point; the
 * two-segment assertions these replaced would have passed just as happily with
 * the binding stripped out.
 */
function slotRe(attempts: number, target: string): RegExp {
  return new RegExp(`^[0-9a-f]{64}:${attempts}:${target.replace(/\./g, '\\.')}$`);
}

interface CapturedWrite {
  op: 'findOneAndUpdate' | 'updateOne';
  filter: Record<string, unknown>;
  update: { $set?: Record<string, unknown>; $unset?: Record<string, unknown> };
}

interface StoredCustomer {
  _id: string;
  planKey: string;
  status: 'active' | 'suspended';
  email?: string;
  pendingEmail?: string;
  emailVerifiedAt?: Date;
  emailVerificationTokenHash?: string;
  emailVerificationExpiresAt?: Date;
  [key: string]: unknown;
}

function principal(id: string): CustomerPrincipal {
  return { id, email: '', planKey: 'free', status: 'active' };
}

/**
 * The portal facade over a real `CustomerAuthService` whose customers model is
 * in-memory and records every write it is handed.
 */
function buildStack(
  opts: { seed?: StoredCustomer[]; verification?: boolean; duplicateKeyOnWrite?: boolean } = {},
) {
  const writes: CapturedWrite[] = [];
  const store = new Map<string, StoredCustomer>();
  for (const doc of opts.seed ?? [{ _id: CUSTOMER_A, planKey: 'free', status: 'active' as const }]) {
    store.set(doc._id, { ...doc });
  }
  // Mutable so a test can let the CLAIM land and fail only the PROMOTION —
  // which is exactly the race the unique index exists to arbitrate.
  let duplicateKey = opts.duplicateKeyOnWrite ?? false;

  const apply = (doc: StoredCustomer, update: CapturedWrite['update']): void => {
    for (const [field, value] of Object.entries(update.$set ?? {})) doc[field] = value;
    for (const field of Object.keys(update.$unset ?? {})) delete doc[field];
  };

  const customers = {
    findOne: (filter: Record<string, unknown>) => ({
      lean: () => ({
        exec: async () =>
          [...store.values()].find((doc) =>
            Object.entries(filter).every(([field, value]) => doc[field] === value),
          ) ?? null,
      }),
    }),
    findOneAndUpdate: (
      filter: Record<string, unknown>,
      update: CapturedWrite['update'],
    ) => ({
      lean: () => ({
        exec: async () => {
          writes.push({ op: 'findOneAndUpdate', filter, update });
          if (duplicateKey) throw Object.assign(new Error('E11000'), { code: 11000 });
          const doc = store.get(String(filter._id));
          if (!doc) return null;
          apply(doc, update);
          return doc;
        },
      }),
    }),
    findById: (id: unknown) => {
      const query = {
        select: () => query,
        lean: () => ({ exec: async () => store.get(String(id)) ?? null }),
      };
      return query;
    },
    // Carries the attempt counter and the dead-code sweep, so it has to really
    // write — and it is captured alongside the rest for the same reason.
    updateOne: (filter: Record<string, unknown>, update: CapturedWrite['update']) => ({
      exec: async () => {
        writes.push({ op: 'updateOne', filter, update });
        const doc = store.get(String(filter._id));
        if (!doc) return { modifiedCount: 0 };
        apply(doc, update);
        return { modifiedCount: 1 };
      },
    }),
    create: async (doc: Record<string, unknown>) => doc,
  };

  const config = {
    isProduction: false,
    customerEmailVerificationRequired: opts.verification ?? false,
  } as never;
  const auth = new CustomerAuthService(
    customers as never,
    { signAsync: async () => 'token' } as never,
    { getPlan: () => undefined } as never,
    config,
  );
  // `CustomerSelfService` takes (clients, settings, config, auth); the first two
  // are untouched by this path, and both are APPENDED params so the existing
  // positional constructions elsewhere stay valid.
  const self = new CustomerSelfService({} as never, {} as never, config, auth);
  return {
    self,
    auth,
    writes,
    store,
    doc: (id: string) => store.get(id)!,
    /** Make every subsequent `findOneAndUpdate` raise E11000. */
    failWritesWithDuplicateKey: (on = true) => {
      duplicateKey = on;
    },
  };
}

/**
 * There is still no mail transport, so the dev-only log line is the ONLY
 * channel the raw code exists on — the tests read it exactly as a developer
 * would, which also keeps the staging half honest end-to-end.
 */
let warnings: string[] = [];

beforeEach(() => {
  warnings = [];
  vi.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => {
    warnings.push(String(message));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PATCH /account/profile — staging an email claim', () => {
  it('stages the claim on an account that had none, and scopes the write to the caller', async () => {
    const { self, writes, doc } = buildStack();

    const result = await self.updateEmail(principal(CUSTOMER_A), 'Wallet.User@Example.com ');

    // CLAIMED, not held: `pendingEmail` carries it and `email` stays empty.
    expect(result.customer.pendingEmail).toBe('wallet.user@example.com');
    expect(result.customer.email).toBe('');
    expect(doc(CUSTOMER_A).pendingEmail).toBe('wallet.user@example.com');
    expect(doc(CUSTOMER_A).email).toBeUndefined();
    // The write touches the three staging fields and NOTHING else — above all
    // not the unique-indexed `email`, which an unproven claim must never squat.
    expect(writes).toHaveLength(1);
    expect(Object.keys(writes[0].update.$set ?? {}).sort()).toEqual([
      'emailVerificationExpiresAt',
      'emailVerificationTokenHash',
      'pendingEmail',
    ]);
    expect(writes[0].update.$set).not.toHaveProperty('email');
    // THE authorization property: the caller's own id went into the filter, so
    // the write could never have touched another customer's row.
    expect(String(writes[0].filter._id)).toBe(CUSTOMER_A);
  });

  it('normalises exactly like signup does — trimmed and lowercased', async () => {
    // The unique index and the login lookup both key on the normalised form; a
    // divergence here means "the same address" means two different things — and
    // the claim is promoted verbatim, so it has to be normalised on the way IN.
    const { self, writes } = buildStack();

    await self.updateEmail(principal(CUSTOMER_A), '  MiXeD@Example.COM  ');

    expect(writes[0].update.$set?.pendingEmail).toBe('mixed@example.com');
  });

  it('never stamps emailVerifiedAt — and never clears it either', async () => {
    const { self, writes, doc } = buildStack();

    const result = await self.updateEmail(principal(CUSTOMER_A), 'new@example.com');

    expect(result.customer.emailVerifiedAt).toBeNull();
    expect(doc(CUSTOMER_A).emailVerifiedAt).toBeUndefined();
    expect(writes[0].update.$set).not.toHaveProperty('emailVerifiedAt');
    expect(writes[0].update.$unset ?? {}).not.toHaveProperty('emailVerifiedAt');
  });

  it('leaves an ALREADY-VERIFIED address live while the new one is only claimed', async () => {
    // The nastiest variant, and the reason the claim is staged rather than
    // written: an account that has PROVED one address keeps it — a typo, or a
    // hostile edit on a stolen session, must not cost the address you own.
    const { self, writes, doc } = buildStack({ seed: [verifiedHolder()] });

    const result = await self.updateEmail(principal(CUSTOMER_A), 'attacker-chosen@example.com');

    expect(result.customer.email).toBe('proved@example.com');
    expect(result.customer.emailVerifiedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(result.customer.pendingEmail).toBe('attacker-chosen@example.com');
    expect(doc(CUSTOMER_A).email).toBe('proved@example.com');
    expect(doc(CUSTOMER_A).emailVerifiedAt).toEqual(new Date('2026-01-01T00:00:00.000Z'));
    expect(doc(CUSTOMER_A).pendingEmail).toBe('attacker-chosen@example.com');
    expect(writes[0].update.$set).not.toHaveProperty('email');
    expect(writes[0].update.$unset ?? {}).not.toHaveProperty('emailVerifiedAt');
  });

  it('mints an outstanding verification code when verification is enabled', async () => {
    const { self, doc } = buildStack({ verification: true });

    await self.updateEmail(principal(CUSTOMER_A), 'new@example.com');

    const stored = doc(CUSTOMER_A).emailVerificationTokenHash ?? '';
    // Bound to the address being CLAIMED — not to whatever the account holds.
    expect(stored).toMatch(slotRe(0, 'new@example.com'));
    expect(doc(CUSTOMER_A).emailVerificationExpiresAt).toBeInstanceOf(Date);
    // Only the hash — the code is never persisted in any form.
    expect(stored.startsWith(hashApiKey('000000'))).toBe(false);
  });

  it('mints a code EVEN WHEN verification is OFF — a claim is always outstanding', async () => {
    // `CUSTOMER_EMAIL_VERIFICATION_REQUIRED` governs whether an unverified
    // SIGNUP is locked out of the portal. It must NOT govern whether a claimed
    // address gets proved: with the flag off and no code minted, `pendingEmail`
    // could never be promoted, so the claim would be either dead weight or —
    // worse, if it were written straight through — an unprovable squat.
    const { self, writes, doc } = buildStack({ verification: false });

    await self.updateEmail(principal(CUSTOMER_A), 'new@example.com');

    expect(writes[0].update.$set).toHaveProperty('emailVerificationTokenHash');
    expect(writes[0].update.$set).toHaveProperty('emailVerificationExpiresAt');
    expect(doc(CUSTOMER_A).emailVerificationTokenHash ?? '').toMatch(slotRe(0, 'new@example.com'));
    expect(doc(CUSTOMER_A).emailVerificationExpiresAt).toBeInstanceOf(Date);
    // …and it is reachable: with no mailer the dev log is the delivery channel.
    expect(loggedCode()).toMatch(/^\d{6}$/);
  });
});

describe('PATCH /account/profile — collisions', () => {
  it('409s when ANOTHER customer already holds the address, and writes nothing', async () => {
    const { self, writes, doc } = buildStack({
      seed: [
        { _id: CUSTOMER_A, planKey: 'free', status: 'active' },
        { _id: CUSTOMER_B, planKey: 'free', status: 'active', email: 'taken@example.com' },
      ],
    });

    await expect(
      self.updateEmail(principal(CUSTOMER_A), 'taken@example.com'),
    ).rejects.toBeInstanceOf(ConflictException);

    // Refused BEFORE the write: neither row moved, and no claim was staged.
    expect(writes).toHaveLength(0);
    expect(doc(CUSTOMER_A).pendingEmail).toBeUndefined();
    expect(doc(CUSTOMER_A).email).toBeUndefined();
    expect(doc(CUSTOMER_B).email).toBe('taken@example.com');
  });

  it('detects the collision on the NORMALISED address, not the raw one', async () => {
    const { self, writes } = buildStack({
      seed: [
        { _id: CUSTOMER_A, planKey: 'free', status: 'active' },
        { _id: CUSTOMER_B, planKey: 'free', status: 'active', email: 'taken@example.com' },
      ],
    });

    await expect(
      self.updateEmail(principal(CUSTOMER_A), ' TAKEN@Example.com '),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(writes).toHaveLength(0);
  });

  it('turns the unique-index E11000 into a 409 too — the read is only a courtesy', async () => {
    // The read above cannot see a concurrent claim; the partial-unique index is
    // the actual race guard, and its error must not surface as a raw 500.
    const { self } = buildStack({ duplicateKeyOnWrite: true });

    await expect(
      self.updateEmail(principal(CUSTOMER_A), 'racing@example.com'),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('charges a collision probe to its OWN budget, never the mail budget', async () => {
    // `setEmail` answers 409 for an address somebody else holds, so an
    // authenticated caller can test any address they like — hence a budget. It
    // must NOT be the 5/hr RESEND budget: five typos would then leave a customer
    // unable to request a verification code for their own address, i.e. the
    // anti-enumeration guard becomes the lockout.
    //
    // 19 failed probes is nearly four times the mail budget. If they were
    // charged to it, the legitimate change below would 429 instead of minting.
    const { self, doc } = buildStack({
      verification: true,
      seed: [
        { _id: CUSTOMER_A, planKey: 'free', status: 'active' },
        { _id: CUSTOMER_B, planKey: 'free', status: 'active', email: 'taken@example.com' },
      ],
    });

    for (let probe = 0; probe < 19; probe += 1) {
      await expect(
        self.updateEmail(principal(CUSTOMER_A), 'taken@example.com'),
      ).rejects.toBeInstanceOf(ConflictException);
    }

    await expect(
      self.updateEmail(principal(CUSTOMER_A), 'genuinely-mine@example.com'),
    ).resolves.toMatchObject({ customer: { pendingEmail: 'genuinely-mine@example.com' } });
    expect(doc(CUSTOMER_A).emailVerificationTokenHash ?? '').toMatch(
      slotRe(0, 'genuinely-mine@example.com'),
    );
    expect(loggedCode()).toMatch(/^\d{6}$/);
  });

  it('429s once the probe budget is spent, and says so as the PROBE bucket', async () => {
    const { self } = buildStack({
      seed: [
        { _id: CUSTOMER_A, planKey: 'free', status: 'active' },
        { _id: CUSTOMER_B, planKey: 'free', status: 'active', email: 'taken@example.com' },
      ],
    });

    for (let probe = 0; probe < 20; probe += 1) {
      await expect(
        self.updateEmail(principal(CUSTOMER_A), 'taken@example.com'),
      ).rejects.toBeInstanceOf(ConflictException);
    }

    // The 21st is refused by the limiter rather than by the collision check —
    // and the body identifies WHICH budget fired, so a future shared key would
    // show up here rather than as a mysterious lockout in production.
    const refusal = await captureError(() =>
      self.updateEmail(principal(CUSTOMER_A), 'taken@example.com'),
    );
    expect(refusal.status).toBe(429);
    expect(refusal.body).toEqual({ error: 'Too many email address changes. Try again later.' });
  });

  it('lets a customer re-submit their OWN address, staging it without unverifying them', async () => {
    const { self, writes, doc } = buildStack({
      seed: [
        {
          _id: CUSTOMER_A,
          planKey: 'free',
          status: 'active',
          email: 'mine@example.com',
          emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
        },
      ],
    });

    const result = await self.updateEmail(principal(CUSTOMER_A), 'mine@example.com');

    expect(writes).toHaveLength(1);
    expect(result.customer.email).toBe('mine@example.com');
    expect(result.customer.pendingEmail).toBe('mine@example.com');
    // Re-claiming your own address is a no-op on the proof you already have —
    // it stages a fresh code and nothing else.
    expect(doc(CUSTOMER_A).emailVerifiedAt).toEqual(new Date('2026-01-01T00:00:00.000Z'));
    expect(result.customer.emailVerifiedAt).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('verify-email — promoting the claim', () => {
  it('promotes pendingEmail into email, stamps the proof and clears every staging field', async () => {
    // The wallet-only account from the first test, now proving what it claimed.
    const stack = buildStack();
    const code = await stageClaim(stack, 'claimed@example.com');

    const result = await stack.auth.verifyEmail(code, CUSTOMER_A);

    expect(result.customer.email).toBe('claimed@example.com');
    expect(result.customer.pendingEmail).toBeNull();
    expect(result.customer.emailVerifiedAt).not.toBeNull();

    // The promotion is ONE write, and it is the only place `email` is ever set
    // from a claim.
    const promotion = stack.writes.at(-1)!;
    expect(promotion.op).toBe('findOneAndUpdate');
    expect(String(promotion.filter._id)).toBe(CUSTOMER_A);
    expect(promotion.update.$set?.email).toBe('claimed@example.com');
    expect(promotion.update.$set?.emailVerifiedAt).toBeInstanceOf(Date);
    expect(promotion.update.$unset).toHaveProperty('pendingEmail');
    expect(promotion.update.$unset).toHaveProperty('emailVerificationTokenHash');
    expect(promotion.update.$unset).toHaveProperty('emailVerificationExpiresAt');

    expect(stack.doc(CUSTOMER_A).email).toBe('claimed@example.com');
    expect(stack.doc(CUSTOMER_A).pendingEmail).toBeUndefined();
    expect(stack.doc(CUSTOMER_A).emailVerificationTokenHash).toBeUndefined();
    expect(stack.doc(CUSTOMER_A).emailVerificationExpiresAt).toBeUndefined();
    expect(stack.doc(CUSTOMER_A).emailVerifiedAt).toBeInstanceOf(Date);
  });

  it('promotes NOTHING on a wrong code — the address stands, the claim stays pending', async () => {
    const stack = buildStack({ seed: [verifiedHolder()] });
    const code = await stageClaim(stack, 'claimed@example.com');

    await expect(stack.auth.verifyEmail(wrongCode(code), CUSTOMER_A)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    // No second `findOneAndUpdate`: guessing cannot move `email` at all.
    expect(stack.writes.filter((write) => write.op === 'findOneAndUpdate')).toHaveLength(1);
    expect(stack.doc(CUSTOMER_A).email).toBe('proved@example.com');
    expect(stack.doc(CUSTOMER_A).pendingEmail).toBe('claimed@example.com');
    // Only the attempt counter moved — and the re-encode PRESERVED the target.
    // Dropping it would unbind the code on the first wrong digit, and an unbound
    // code fails closed, so one typo would kill a code still inside its budget.
    expect(stack.doc(CUSTOMER_A).emailVerificationTokenHash).toMatch(
      slotRe(1, 'claimed@example.com'),
    );
  });

  it('promotes nothing on an EXPIRED code, and the claim survives the sweep', async () => {
    const stack = buildStack({ seed: [verifiedHolder()] });
    const code = await stageClaim(stack, 'claimed@example.com');
    stack.doc(CUSTOMER_A).emailVerificationExpiresAt = new Date(Date.now() - 1_000);

    await expect(stack.auth.verifyEmail(code, CUSTOMER_A)).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(stack.writes.filter((write) => write.op === 'findOneAndUpdate')).toHaveLength(1);
    expect(stack.doc(CUSTOMER_A).email).toBe('proved@example.com');
    // The dead code is swept, but the CLAIM is not — the customer asks for a
    // new code rather than retyping the address.
    expect(stack.doc(CUSTOMER_A).emailVerificationTokenHash).toBeUndefined();
    expect(stack.doc(CUSTOMER_A).pendingEmail).toBe('claimed@example.com');
  });

  it('destroys the code on the 5th wrong attempt and STILL leaves email untouched', async () => {
    // The control that makes six digits defensible: without it 10^6 is minutes
    // of scripted guessing against a promotion that rewrites the account's
    // address.
    const stack = buildStack({ seed: [verifiedHolder()] });
    const code = await stageClaim(stack, 'claimed@example.com');

    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
      await expect(stack.auth.verifyEmail(wrongCode(code), CUSTOMER_A)).rejects.toThrow();
      expect(stack.doc(CUSTOMER_A).emailVerificationTokenHash).toMatch(
        slotRe(attempt, 'claimed@example.com'),
      );
    }

    await expect(stack.auth.verifyEmail(wrongCode(code), CUSTOMER_A)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(stack.doc(CUSTOMER_A).emailVerificationTokenHash).toBeUndefined();
    expect(stack.doc(CUSTOMER_A).emailVerificationExpiresAt).toBeUndefined();
    expect(stack.doc(CUSTOMER_A).email).toBe('proved@example.com');
    expect(stack.doc(CUSTOMER_A).pendingEmail).toBe('claimed@example.com');

    // …and the CORRECT code is refused too, so the burnt-out code cannot be
    // ridden into a promotion.
    await expect(stack.auth.verifyEmail(code, CUSTOMER_A)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(stack.doc(CUSTOMER_A).email).toBe('proved@example.com');
    expect(stack.writes.filter((write) => write.op === 'findOneAndUpdate')).toHaveLength(1);
  });

  it('stamps the proof and leaves email alone when there is NO pending claim', async () => {
    // Ordinary signup verifying its OWN address: the login identifier is not a
    // claim, so there is nothing to promote and `email` must not appear in the
    // write at all.
    const stack = buildStack({
      seed: [
        {
          _id: CUSTOMER_A,
          planKey: 'free',
          status: 'active',
          email: 'signed-up@example.com',
          // Bound to the account's OWN address, which is what signup mints.
          emailVerificationTokenHash: `${hashApiKey('424242')}:0:signed-up@example.com`,
          emailVerificationExpiresAt: new Date(Date.now() + 60_000),
        },
      ],
    });

    const result = await stack.auth.verifyEmail('424242', CUSTOMER_A);

    expect(result.customer.email).toBe('signed-up@example.com');
    expect(result.customer.emailVerifiedAt).not.toBeNull();
    expect(result.customer.pendingEmail).toBeNull();

    const promotion = stack.writes.at(-1)!;
    expect(promotion.update.$set).not.toHaveProperty('email');
    expect(promotion.update.$set?.emailVerifiedAt).toBeInstanceOf(Date);
    expect(promotion.update.$unset).not.toHaveProperty('pendingEmail');
    expect(stack.doc(CUSTOMER_A).email).toBe('signed-up@example.com');
  });

  it('turns a duplicate key during promotion into a 409 WITHOUT losing the claim', async () => {
    // Two accounts claimed the same address and the other one proved it first.
    // The unique index is the arbiter — first to PROVE wins — and the loser
    // keeps their pending claim, so the 409 is actionable rather than terminal.
    const stack = buildStack({ seed: [verifiedHolder()] });
    const code = await stageClaim(stack, 'claimed@example.com');
    stack.failWritesWithDuplicateKey();

    await expect(stack.auth.verifyEmail(code, CUSTOMER_A)).rejects.toBeInstanceOf(
      ConflictException,
    );

    expect(stack.doc(CUSTOMER_A).pendingEmail).toBe('claimed@example.com');
    expect(stack.doc(CUSTOMER_A).email).toBe('proved@example.com');
    expect(stack.doc(CUSTOMER_A).emailVerifiedAt).toEqual(new Date('2026-01-01T00:00:00.000Z'));
    // The code was not spent either — the failure was ours, not the customer's.
    expect(stack.doc(CUSTOMER_A).emailVerificationTokenHash).toMatch(
      slotRe(0, 'claimed@example.com'),
    );
  });
});

describe('UpdateProfileDto', () => {
  it('requires a real email and caps its length', () => {
    expect(errorsFor({ email: 'someone@example.com' })).toEqual([]);
    expect(errorsFor({ email: 'not-an-email' }).length).toBeGreaterThan(0);
    expect(errorsFor({ email: `${'a'.repeat(200)}@example.com` }).length).toBeGreaterThan(0);
  });

  it('carries no customer id — the tenant can only come from the token', () => {
    // A body field would be a whole IDOR surface; `forbidNonWhitelisted` also
    // 400s one, but the DTO not declaring it is the structural half.
    const dto = plainToInstance(UpdateProfileDto, { email: 'a@example.com' });

    expect(Object.keys(dto)).toEqual(['email']);
    expect(dto).not.toHaveProperty('customerId');
    expect(dto).not.toHaveProperty('id');
  });
});

/** An account that has already PROVED `proved@example.com`. */
function verifiedHolder(): StoredCustomer {
  return {
    _id: CUSTOMER_A,
    planKey: 'free',
    status: 'active',
    email: 'proved@example.com',
    emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
  };
}

/** Stage a claim through the real profile route and hand back its OTP. */
async function stageClaim(
  stack: ReturnType<typeof buildStack>,
  email: string,
  customerId = CUSTOMER_A,
): Promise<string> {
  await stack.self.updateEmail(principal(customerId), email);
  const code = loggedCode();
  if (!code) throw new Error('setEmail staged a claim without minting a code');
  return code;
}

/** The most recently logged verification code, or undefined if none was logged. */
function loggedCode(): string | undefined {
  for (let i = warnings.length - 1; i >= 0; i -= 1) {
    const hit = /Email verification code for [^:]+: (\d+)/.exec(warnings[i]);
    if (hit) return hit[1];
  }
  return undefined;
}

/** A 6-digit code guaranteed different from `code`. */
function wrongCode(code: string): string {
  return String((Number.parseInt(code, 10) + 1) % 1_000_000).padStart(6, '0');
}

/**
 * The status and body of a rejection. Used where WHICH refusal fired is the
 * property under test — a 429 from the probe bucket and a 429 from the mail
 * bucket are the same status and different facts.
 */
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

function errorsFor(payload: Record<string, unknown>): unknown[] {
  return validateSync(plainToInstance(UpdateProfileDto, payload), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}
