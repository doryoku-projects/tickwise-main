import 'reflect-metadata';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { IdentityService, PendingLinkRequiredError } from '../src/identity/identity.service.js';

/**
 * THE account-resolution rules — the whole security value of customer SSO.
 *
 * These run the REAL `IdentityService` against in-memory models that enforce the
 * two unique indexes that actually arbitrate (`{provider, subject}` on
 * identities, the partial `{email}` on customers), because those indexes are
 * load-bearing: the race safety of a first login is the index rejecting a
 * duplicate, not a read.
 *
 * Where a rule is about AUTHORIZATION the assertion is on the MONGO FILTER, not
 * just the returned value — a `findById` followed by a JS owner comparison can
 * produce the same 404 while still leaving a TOCTOU window, so "the caller's id
 * reached the query" is the property worth pinning (same reasoning as
 * `portal-ownership.spec.ts`).
 */

const CUSTOMER_A = '507f1f77bcf86cd799439011';
const CUSTOMER_B = '507f1f77bcf86cd799439012';
const IDENTITY_OF_B = '507f191e810c19729de860ea';

interface CustomerDoc {
  _id: string;
  name?: string;
  email?: string;
  planKey: string;
  status: 'active' | 'suspended';
  origin?: string;
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

interface Captured {
  collection: 'identities' | 'customers';
  op: string;
  filter?: Record<string, unknown>;
  update?: Record<string, unknown>;
}

/** Mongo's duplicate-key error, as the driver surfaces it. */
function duplicateKey(): Error {
  return Object.assign(new Error('E11000 duplicate key error'), { code: 11000 });
}

/** Filter match by stringified equality — the ids arrive as ObjectIds. */
function matches(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, value]) => String(doc[key]) === String(value));
}

function applySet(doc: Record<string, unknown>, update: Record<string, unknown>): void {
  const set = (update.$set ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(set)) doc[key] = value;
}

/**
 * The real service over in-memory collections.
 *
 * `identityReadMisses` models the ONE race that matters: a concurrent first
 * login for the same provider account committed its identity row between our
 * read and our insert, so the read misses and the insert gets E11000.
 */
function buildStack(
  seed: {
    customers?: CustomerDoc[];
    identities?: IdentityDoc[];
    /** How many `identities.findOne` calls report "not found" regardless of state. */
    identityReadMisses?: number;
    /**
     * How many `customers.findOne` calls report "not found" regardless of state.
     *
     * This models the OTHER race, the one the E11000 handler exists for: a
     * concurrent signup committed a row holding this address between our
     * pre-flight read and our insert. One miss puts the pre-flight check on the
     * "no collision" path and lets `customers.create` hit the unique email index,
     * which is the only way to reach that handler at all.
     */
    customerReadMisses?: number;
    /**
     * Make `identities.deleteOne` report `deletedCount: 0` even when it removed
     * the row — i.e. a cleanup whose success cannot be CONFIRMED.
     *
     * Its own switch because the `deletedOne()` guard turns on precisely that
     * distinction: an orphan identity row that survived would dead-end
     * `linkIdentity` with "already linked to a different account", so a
     * would-be ceremony has to downgrade to the plain 409.
     */
    deleteReportsNothing?: boolean;
  } = {},
) {
  const customers: CustomerDoc[] = [...(seed.customers ?? [])];
  const identities: IdentityDoc[] = [...(seed.identities ?? [])];
  const queries: Captured[] = [];
  let readMisses = seed.identityReadMisses ?? 0;
  let customerReadMisses = seed.customerReadMisses ?? 0;
  let generated = 0;
  const nextId = () => `6650000000000000000000${(generated += 1).toString().padStart(2, '0')}`;

  const identityModel = {
    findOne: (filter: Record<string, unknown>) => {
      queries.push({ collection: 'identities', op: 'findOne', filter });
      const hit = readMisses-- > 0 ? undefined : identities.find((row) => matches(row, filter));
      return { lean: () => ({ exec: async () => hit ?? null }) };
    },
    find: (filter: Record<string, unknown>) => {
      queries.push({ collection: 'identities', op: 'find', filter });
      const hits = identities.filter((row) => matches(row, filter));
      return { sort: () => ({ lean: () => ({ exec: async () => hits }) }) };
    },
    countDocuments: (filter: Record<string, unknown>) => {
      queries.push({ collection: 'identities', op: 'countDocuments', filter });
      return { exec: async () => identities.filter((row) => matches(row, filter)).length };
    },
    create: async (doc: Record<string, unknown>) => {
      // The unique {provider, subject} index — the race arbitrator.
      if (identities.some((row) => row.provider === doc.provider && row.subject === doc.subject)) {
        throw duplicateKey();
      }
      // Ids are stored as strings here (Mongo stores ObjectIds); every read path
      // compares stringified, exactly as the real filters do.
      const row = { ...doc, _id: String(doc._id ?? nextId()), customerId: String(doc.customerId) } as IdentityDoc;
      identities.push(row);
      return row;
    },
    updateOne: (filter: Record<string, unknown>, update: Record<string, unknown>) => {
      queries.push({ collection: 'identities', op: 'updateOne', filter, update });
      const hit = identities.find((row) => matches(row, filter));
      if (hit) applySet(hit as unknown as Record<string, unknown>, update);
      return { exec: async () => ({ matchedCount: hit ? 1 : 0 }) };
    },
    findOneAndUpdate: (
      filter: Record<string, unknown>,
      update: Record<string, unknown>,
      options: { upsert?: boolean } = {},
    ) => {
      queries.push({ collection: 'identities', op: 'findOneAndUpdate', filter, update });
      const hit = identities.find((row) => matches(row, filter));
      return {
        lean: () => ({
          exec: async () => {
            if (hit) {
              applySet(hit as unknown as Record<string, unknown>, update);
              return hit;
            }
            if (!options.upsert) return null;
            // Mongo builds the insert from the filter's equality clauses plus the
            // update — and then the unique index has the last word.
            if (
              identities.some((row) => row.provider === filter.provider && row.subject === filter.subject)
            ) {
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
      };
    },
    findOneAndDelete: (filter: Record<string, unknown>) => {
      queries.push({ collection: 'identities', op: 'findOneAndDelete', filter });
      const index = identities.findIndex((row) => matches(row, filter));
      return {
        lean: () => ({
          exec: async () => (index < 0 ? null : identities.splice(index, 1)[0]),
        }),
      };
    },
    deleteOne: (filter: Record<string, unknown>) => {
      queries.push({ collection: 'identities', op: 'deleteOne', filter });
      const index = identities.findIndex((row) => matches(row, filter));
      if (index >= 0) identities.splice(index, 1);
      const deletedCount = seed.deleteReportsNothing || index < 0 ? 0 : 1;
      return { exec: async () => ({ deletedCount }) };
    },
  };

  const customerModel = {
    findOne: (filter: Record<string, unknown>) => {
      queries.push({ collection: 'customers', op: 'findOne', filter });
      const hit =
        customerReadMisses-- > 0 ? undefined : customers.find((row) => matches(row, filter));
      return { lean: () => ({ exec: async () => hit ?? null }) };
    },
    findById: (id: unknown) => {
      queries.push({ collection: 'customers', op: 'findById', filter: { _id: id } });
      const hit = customers.find((row) => row._id === String(id));
      const chain = {
        // `select('+passwordHash')` is the only reason `hasPassword` is knowable.
        select: () => ({ lean: () => ({ exec: async () => hit ?? null }) }),
        lean: () => ({
          exec: async () => {
            if (!hit) return null;
            // Default projection: the schema's select:false columns stay out.
            const { passwordHash: _hidden, ...visible } = hit;
            return visible;
          },
        }),
      };
      return chain;
    },
    create: async (doc: Record<string, unknown>) => {
      // The PARTIAL unique email index: only string emails are constrained, so
      // any number of no-email (wallet) accounts is legal.
      if (typeof doc.email === 'string' && customers.some((row) => row.email === doc.email)) {
        throw duplicateKey();
      }
      const row = { status: 'active', ...doc, _id: String(doc._id ?? nextId()) } as CustomerDoc;
      customers.push(row);
      return row;
    },
    updateOne: (filter: Record<string, unknown>, update: Record<string, unknown>) => {
      queries.push({ collection: 'customers', op: 'updateOne', filter, update });
      const hit = customers.find((row) => matches(row, filter));
      if (hit) applySet(hit as unknown as Record<string, unknown>, update);
      return { exec: async () => ({ matchedCount: hit ? 1 : 0 }) };
    },
  };

  const config = {
    redisUrl: 'redis://127.0.0.1:6379',
    portalBaseUrl: 'http://localhost:3011',
    oauthCallbackBaseUrl: 'http://localhost:3000',
  };
  const service = new IdentityService(
    identityModel as never,
    customerModel as never,
    { signAsync: async () => 'signed.customer.token' } as never,
    config as never,
    {} as never,
    {} as never,
    {} as never,
  );
  return { service, customers, identities, queries };
}

function activeCustomer(over: Partial<CustomerDoc> = {}): CustomerDoc {
  return { _id: CUSTOMER_A, planKey: 'standard', status: 'active', ...over };
}

/**
 * The thrown value itself, so a test can assert its TYPE.
 *
 * `PendingLinkRequiredError extends ConflictException`, so "is it a 409" cannot
 * distinguish the ceremony from the dead end — which of the two was thrown is
 * exactly the property under test.
 */
async function captureRejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    throw new Error('expected the call to reject');
  } catch (err) {
    return err;
  }
}

describe('SSO account resolution — resolveLogin', () => {
  // REGRESSION — observed live: `POST /account/auth/wallet/verify` 503'd on every
  // attempt with "SSO identity resolved to a customer that does not exist". An
  // identity outliving its customer used to be a PERMANENT brick: the 503 refused
  // the login, and the unique {provider, subject} index simultaneously blocked
  // minting a replacement identity, so that wallet could never sign in again
  // without hand surgery on the database. Adoption is safe — the signature has
  // already proved control of the subject, so it grants exactly what a
  // first-ever login would, and a ban is `status: 'suspended'` on a customer
  // that EXISTS, so a missing row was never a ban.
  it('adopts an orphaned identity instead of bricking the wallet forever', async () => {
    const { service, identities, customers } = buildStack({
      customers: [], // the customer the identity points at is GONE
      identities: [
        { _id: IDENTITY_OF_B, customerId: CUSTOMER_A, provider: 'wallet', subject: '0xdeadbeef' },
      ],
    });

    const result = await service.resolveLogin({
      provider: 'wallet',
      subject: '0xdeadbeef',
      emailVerified: false,
    });

    // A fresh free account, and the dangling row is gone rather than duplicated.
    expect(result.isNewCustomer).toBe(true);
    expect(result.customer.id).not.toBe(CUSTOMER_A);
    expect(customers).toHaveLength(1);
    expect(identities).toHaveLength(1);
    expect(identities[0]).toMatchObject({ provider: 'wallet', subject: '0xdeadbeef' });
    expect(String(identities[0].customerId)).toBe(result.customer.id);
  });

  it('(a) logs in as the customer a known identity already points at', async () => {
    const { service, identities, customers } = buildStack({
      customers: [activeCustomer({ email: 'owner@example.com' })],
      identities: [
        {
          _id: IDENTITY_OF_B,
          customerId: CUSTOMER_A,
          provider: 'google',
          subject: 'google-sub-1',
          email: 'owner@example.com',
          emailVerified: true,
        },
      ],
    });

    const result = await service.resolveLogin({
      provider: 'google',
      subject: 'google-sub-1',
      email: 'owner@example.com',
      emailVerified: true,
    });

    expect(result.isNewCustomer).toBe(false);
    expect(result.customer.id).toBe(CUSTOMER_A);
    expect(result.customer.planKey).toBe('standard');
    // No second identity, no second customer — the common path writes nothing new.
    expect(identities).toHaveLength(1);
    expect(customers).toHaveLength(1);
    expect(identities[0].lastLoginAt).toBeInstanceOf(Date);
    expect(customers[0].lastLoginAt).toBeInstanceOf(Date);
  });

  it('(a) matches on {provider, subject} — the SAME subject at another provider is a different account', async () => {
    const { service, customers } = buildStack({
      customers: [activeCustomer()],
      identities: [{ _id: IDENTITY_OF_B, customerId: CUSTOMER_A, provider: 'google', subject: 'shared-id' }],
    });

    const result = await service.resolveLogin({
      provider: 'github',
      subject: 'shared-id',
      emailVerified: false,
    });

    expect(result.isNewCustomer).toBe(true);
    expect(result.customer.id).not.toBe(CUSTOMER_A);
    expect(customers).toHaveLength(2);
  });

  // REGRESSION — pre-registration account takeover (found by adversarial review).
  // Signup is open and unauthenticated, so anyone can create a row holding
  // victim@corp.com. If auto-link trusted the PROVIDER's claim alone, the
  // victim's genuine Google sign-in would be merged into the attacker's account,
  // whose password still works. Both sides must have proved the address.
  it('(b) REFUSES a provider-verified email when WE never verified the holder — the takeover case', async () => {
    const { service, identities, customers } = buildStack({
      // No `emailVerifiedAt`: nobody ever proved this row owns the address.
      customers: [activeCustomer({ email: 'victim@example.com', passwordHash: 'scrypt:hash' })],
    });

    await expect(
      service.resolveLogin({
        provider: 'google',
        subject: 'google-sub-attacker-target',
        email: 'victim@example.com',
        emailVerified: true,
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    // Nothing written: no merge, and no second account on that address either.
    expect(identities).toHaveLength(0);
    expect(customers).toHaveLength(1);
  });

  it('(b) links a provider-VERIFIED email when WE verified the holder too', async () => {
    const { service, identities, customers } = buildStack({
      customers: [
        activeCustomer({
          email: 'owner@example.com',
          passwordHash: 'scrypt:hash',
          // We proved it as well — this is what makes the merge safe.
          emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
        }),
      ],
    });

    const result = await service.resolveLogin({
      provider: 'google',
      subject: 'google-sub-1',
      email: 'Owner@Example.com ',
      emailVerified: true,
    });

    expect(result.isNewCustomer).toBe(false);
    expect(result.customer.id).toBe(CUSTOMER_A);
    // ONE new identity attached to the EXISTING customer, and no new account.
    expect(customers).toHaveLength(1);
    expect(identities).toHaveLength(1);
    expect(identities[0]).toMatchObject({
      customerId: CUSTOMER_A,
      provider: 'google',
      subject: 'google-sub-1',
      email: 'owner@example.com',
      emailVerified: true,
    });
  });

  it('(c) REFUSES an UNVERIFIED email that collides with an existing customer — no link, no new account', async () => {
    // The account-takeover case: GitHub's public-profile email is user-typed, so
    // an unverified address is a claim, not a proof. Linking it would hand over
    // somebody else's account, keys and usage history.
    const { service, identities, customers, queries } = buildStack({
      customers: [activeCustomer({ email: 'victim@example.com', passwordHash: 'scrypt:hash' })],
    });

    await expect(
      service.resolveLogin({
        provider: 'github',
        subject: 'github-99',
        email: 'victim@example.com',
        emailVerified: false,
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    // Neither outcome happened: nothing linked, and no shadow second account on
    // the same address either.
    expect(identities).toHaveLength(0);
    expect(customers).toHaveLength(1);
    expect(customers[0].passwordHash).toBe('scrypt:hash');
    // And it refused BEFORE any write.
    expect(queries.some((q) => ['create', 'updateOne', 'findOneAndUpdate'].includes(q.op))).toBe(false);
  });

  it('(c) an UNVERIFIED email with NO collision creates an account but does NOT store the address', async () => {
    // Storing it would make rule (b) find it later and link the REAL owner's
    // verified login into this account — the same takeover, one step slower.
    const { service, customers, identities } = buildStack();

    const result = await service.resolveLogin({
      provider: 'github',
      subject: 'github-99',
      email: 'not-mine@example.com',
      emailVerified: false,
    });

    expect(result.isNewCustomer).toBe(true);
    expect(customers).toHaveLength(1);
    expect(customers[0].email).toBeUndefined();
    expect(customers[0].emailVerifiedAt).toBeUndefined();
    expect(result.customer.emailVerifiedAt).toBeNull();
    // The address survives as identity METADATA only — never as a join key.
    expect(identities[0].email).toBe('not-mine@example.com');
    expect(identities[0].emailVerified).toBe(false);
  });

  it('(d) creates a fresh free-plan, self-serve customer with NO password when nothing collides', async () => {
    const { service, customers, identities } = buildStack();

    const result = await service.resolveLogin({
      provider: 'google',
      subject: 'google-new',
      email: 'new@example.com',
      emailVerified: true,
      displayName: 'New Person',
    });

    expect(result.isNewCustomer).toBe(true);
    expect(customers).toHaveLength(1);
    expect(customers[0]).toMatchObject({
      email: 'new@example.com',
      planKey: 'free',
      origin: 'self_serve',
      status: 'active',
    });
    expect(customers[0].passwordHash).toBeUndefined();
    expect(customers[0].emailVerifiedAt).toBeInstanceOf(Date);
    expect(identities[0].customerId).toBe(customers[0]._id);
    // The response never carries a credential column.
    expect(JSON.stringify(result.customer)).not.toContain('passwordHash');
  });

  it('(e) a wallet has no email at all: it creates its own account and matches NO existing one', async () => {
    const address = '0x1111111111111111111111111111111111111111';
    const { service, customers, identities } = buildStack({
      customers: [activeCustomer({ email: 'owner@example.com', passwordHash: 'scrypt:hash' })],
    });

    const result = await service.resolveLogin({
      provider: 'wallet',
      subject: address,
      emailVerified: false,
    });

    expect(result.isNewCustomer).toBe(true);
    expect(result.customer.id).not.toBe(CUSTOMER_A);
    expect(customers).toHaveLength(2);
    // Legal precisely because the unique email index is PARTIAL on
    // `{ email: { $type: 'string' } }`.
    expect(customers[1].email).toBeUndefined();
    expect(identities[0]).toMatchObject({ provider: 'wallet', subject: address });
  });

  it('(e) a wallet NEVER auto-links, even if a caller hands it a verified email', async () => {
    // Structural, not conventional: the rule holds against the caller, not just
    // against the current wallet route.
    const { service, customers, identities } = buildStack({
      customers: [activeCustomer({ email: 'owner@example.com' })],
    });

    const result = await service.resolveLogin({
      provider: 'wallet',
      subject: '0x2222222222222222222222222222222222222222',
      email: 'owner@example.com',
      emailVerified: true,
    });

    expect(result.customer.id).not.toBe(CUSTOMER_A);
    expect(customers).toHaveLength(2);
    expect(identities[0].email).toBeUndefined();
  });

  it('a SECOND wallet login reuses the same customer', async () => {
    const address = '0x3333333333333333333333333333333333333333';
    const { service, customers, identities } = buildStack();

    const first = await service.resolveLogin({ provider: 'wallet', subject: address, emailVerified: false });
    const second = await service.resolveLogin({ provider: 'wallet', subject: address, emailVerified: false });

    expect(first.isNewCustomer).toBe(true);
    expect(second.isNewCustomer).toBe(false);
    expect(second.customer.id).toBe(first.customer.id);
    expect(customers).toHaveLength(1);
    expect(identities).toHaveLength(1);
  });

  it('two simultaneous first logins for one provider account do NOT create two customers', async () => {
    // The loser's read misses, its insert hits E11000, and it resolves to the
    // winner instead of forking the account. The unique index is the arbitrator —
    // a check-then-insert would produce two customers here.
    const { service, customers, identities } = buildStack({
      customers: [activeCustomer({ _id: CUSTOMER_B })],
      identities: [
        { _id: IDENTITY_OF_B, customerId: CUSTOMER_B, provider: 'google', subject: 'racing-sub' },
      ],
      identityReadMisses: 1,
    });

    const result = await service.resolveLogin({
      provider: 'google',
      subject: 'racing-sub',
      emailVerified: false,
    });

    expect(result.isNewCustomer).toBe(false);
    expect(result.customer.id).toBe(CUSTOMER_B);
    expect(customers).toHaveLength(1);
    expect(identities).toHaveLength(1);
  });

  /**
   * FINDING 2 — the E11000 handler used to re-implement rule (b) and keep only
   * the PROVIDER's half of it.
   *
   * How it is reached: the pre-flight `customers.findOne({email})` misses because
   * a concurrent signup has not committed yet, so this login takes the
   * "no collision" path, writes its identity row, and only then does
   * `customers.create` hit the partial-unique email index. The handler then reads
   * the winner — and it used to check `assertion.emailVerified` alone.
   *
   * That is the takeover rule (b) exists to stop, by the slower route: signup is
   * open and unauthenticated, so the row that WINS this race can be an
   * attacker's UNVERIFIED password account holding victim@corp.example, and the
   * victim's genuine Google identity was repointed straight into it — password
   * and all still working.
   *
   * The fix is one method, `assertEmailCollisionLinkable`, asked by BOTH call
   * sites and THROWING rather than returning a verdict (a returned refusal is
   * inert until a caller remembers to raise it, and a caller that forgets is
   * precisely the takeover). These three cases pin that the two call sites reach
   * the identical answer.
   */
  describe('the E11000 email race reaches the SAME verdict as the pre-flight check', () => {
    /** Provider-verified Google login for an address a racing row already holds. */
    const googleAssertion = {
      provider: 'google' as const,
      subject: 'racing-google-sub',
      email: 'victim@corp.example',
      emailVerified: true,
    };

    it('refuses an UNVERIFIED winner with the CEREMONY, and deletes the orphan identity', async () => {
      const { service, customers, identities } = buildStack({
        // The attacker's row: holds the address, never proved it, active.
        customers: [activeCustomer({ email: 'victim@corp.example', passwordHash: 'scrypt:hash' })],
        customerReadMisses: 1,
      });

      const refusal = await captureRejection(() => service.resolveLogin(googleAssertion));

      // A resolvable collision — the human can settle it by signing in — and
      // still a ConflictException, so any caller that does not know about the
      // subclass degrades to exactly the old 409.
      expect(refusal).toBeInstanceOf(PendingLinkRequiredError);
      expect(refusal).toBeInstanceOf(ConflictException);
      expect((refusal as PendingLinkRequiredError).assertion).toMatchObject({
        targetCustomerId: CUSTOMER_A,
        provider: 'google',
        subject: 'racing-google-sub',
        emailVerified: true,
      });
      // NOTHING was linked, and no second customer was forked.
      expect(customers).toHaveLength(1);
      expect(customers[0].emailVerifiedAt).toBeUndefined();
      // THE CLEANUP: the identity row was written against a customer that will
      // now never exist, and the unique {provider, subject} index blocks minting
      // a replacement — leaving it would brick this provider account for good.
      expect(identities).toHaveLength(0);
    });

    it('refuses a SUSPENDED winner with the PLAIN 409 — no ceremony at all', async () => {
      // A ceremony would confirm the account exists AND hand a suspended tenant
      // a fresh way in, so it is withheld even though the provider verified.
      const { service, identities } = buildStack({
        customers: [
          activeCustomer({ email: 'victim@corp.example', status: 'suspended' }),
        ],
        customerReadMisses: 1,
      });

      const refusal = await captureRejection(() => service.resolveLogin(googleAssertion));

      expect(refusal).toBeInstanceOf(ConflictException);
      expect(refusal).not.toBeInstanceOf(PendingLinkRequiredError);
      expect(identities).toHaveLength(0);
    });

    it('still LINKS when the winner verified the address too — rule (b) intact', async () => {
      // Both halves proved: the provider asserted the address and we verified it
      // ourselves. This is the case the fix must not break.
      const { service, customers, identities } = buildStack({
        customers: [
          activeCustomer({
            email: 'victim@corp.example',
            emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
          }),
        ],
        customerReadMisses: 1,
      });

      const result = await service.resolveLogin(googleAssertion);

      expect(result.isNewCustomer).toBe(false);
      expect(result.customer.id).toBe(CUSTOMER_A);
      // The identity SURVIVES and is repointed at the winner rather than deleted.
      expect(customers).toHaveLength(1);
      expect(identities).toHaveLength(1);
      expect(String(identities[0].customerId)).toBe(CUSTOMER_A);
    });

    it('downgrades the ceremony to a plain 409 when the cleanup cannot be CONFIRMED', async () => {
      // `deleteOne` is `.catch(() => undefined)`-wrapped, so a failed cleanup is
      // swallowed. A surviving orphan row turns the ceremony we would otherwise
      // offer into `linkIdentity`'s "already linked to a different account" dead
      // end — so an unconfirmed delete must answer the plain thing instead of
      // inviting the customer into a flow that cannot complete.
      const { service } = buildStack({
        customers: [activeCustomer({ email: 'victim@corp.example' })],
        customerReadMisses: 1,
        deleteReportsNothing: true,
      });

      const refusal = await captureRejection(() => service.resolveLogin(googleAssertion));

      expect(refusal).toBeInstanceOf(ConflictException);
      expect(refusal).not.toBeInstanceOf(PendingLinkRequiredError);
    });
  });

  it('refuses a SUSPENDED customer, exactly like the password login does', async () => {
    const { service } = buildStack({
      customers: [activeCustomer({ status: 'suspended', email: 'owner@example.com' })],
      identities: [{ _id: IDENTITY_OF_B, customerId: CUSTOMER_A, provider: 'google', subject: 'sub-1' }],
    });

    await expect(
      service.resolveLogin({ provider: 'google', subject: 'sub-1', emailVerified: false }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses to link a verified email onto a SUSPENDED account, and writes nothing', async () => {
    const { service, identities } = buildStack({
      // `emailVerifiedAt` is set so the mutual-verification gate PASSES and the
      // suspension check is what actually refuses — otherwise this asserts the
      // 409 from the gate above and stops covering suspension at all.
      customers: [
        activeCustomer({
          status: 'suspended',
          email: 'owner@example.com',
          emailVerifiedAt: new Date('2026-01-01T00:00:00.000Z'),
        }),
      ],
    });

    await expect(
      service.resolveLogin({
        provider: 'google',
        subject: 'sub-new',
        email: 'owner@example.com',
        emailVerified: true,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(identities).toHaveLength(0);
  });
});

describe('SSO linking to the signed-in account — linkIdentity', () => {
  it('refuses a provider account already linked to a DIFFERENT customer, and never moves it', async () => {
    const { service, identities } = buildStack({
      customers: [activeCustomer(), activeCustomer({ _id: CUSTOMER_B })],
      identities: [
        { _id: IDENTITY_OF_B, customerId: CUSTOMER_B, provider: 'google', subject: 'google-sub-b' },
      ],
    });

    await expect(
      service.linkIdentity(CUSTOMER_A, {
        provider: 'google',
        subject: 'google-sub-b',
        emailVerified: true,
        email: 'a@example.com',
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    // Still B's. Moving an identity would TRANSFER a login, not add one.
    expect(identities).toHaveLength(1);
    expect(identities[0].customerId).toBe(CUSTOMER_B);
  });

  it('scopes the upsert to the caller — the customerId is in the FILTER', async () => {
    const { service, queries } = buildStack({ customers: [activeCustomer()] });

    await service.linkIdentity(CUSTOMER_A, {
      provider: 'github',
      subject: 'github-7',
      emailVerified: false,
    });

    const upsert = queries.find((q) => q.op === 'findOneAndUpdate');
    expect(upsert).toBeDefined();
    expect(String(upsert?.filter?.customerId)).toBe(CUSTOMER_A);
    expect(upsert?.filter?.subject).toBe('github-7');
  });

  it('is idempotent for an identity the caller already owns', async () => {
    const { service, identities } = buildStack({
      customers: [activeCustomer()],
      identities: [
        { _id: IDENTITY_OF_B, customerId: CUSTOMER_A, provider: 'google', subject: 'mine', linkedAt: new Date(0) },
      ],
    });

    const linked = await service.linkIdentity(CUSTOMER_A, {
      provider: 'google',
      subject: 'mine',
      email: 'me@example.com',
      emailVerified: true,
    });

    expect(identities).toHaveLength(1);
    expect(linked.id).toBe(IDENTITY_OF_B);
    expect(linked.email).toBe('me@example.com');
    // The projection never carries the tenant id.
    expect(linked).not.toHaveProperty('customerId');
  });

  it('refuses to link onto a suspended account', async () => {
    const { service } = buildStack({ customers: [activeCustomer({ status: 'suspended' })] });

    await expect(
      service.linkIdentity(CUSTOMER_A, { provider: 'google', subject: 'x', emailVerified: false }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('SSO unlinking — unlinkIdentity', () => {
  const onlyIdentity: IdentityDoc = {
    _id: IDENTITY_OF_B,
    customerId: CUSTOMER_A,
    provider: 'google',
    subject: 'google-sub-1',
  };

  it('REFUSES to remove the last credential of a password-less account', async () => {
    // Otherwise the account is permanently unreachable — no password, no
    // provider, and support has no way to restore it either.
    const { service, identities } = buildStack({
      customers: [activeCustomer()],
      identities: [{ ...onlyIdentity }],
    });

    await expect(service.unlinkIdentity(CUSTOMER_A, IDENTITY_OF_B)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(identities).toHaveLength(1);
  });

  it('allows it when a PASSWORD remains — read via select("+passwordHash")', async () => {
    // `passwordHash` is `select: false`; without the explicit `+` every account
    // reads as password-less and this unlink would be refused.
    const { service, identities } = buildStack({
      customers: [activeCustomer({ passwordHash: 'scrypt:hash' })],
      identities: [{ ...onlyIdentity }],
    });

    await expect(service.unlinkIdentity(CUSTOMER_A, IDENTITY_OF_B)).resolves.toEqual({ ok: true });
    expect(identities).toHaveLength(0);
  });

  it('allows it when ANOTHER identity remains', async () => {
    const { service, identities } = buildStack({
      customers: [activeCustomer()],
      identities: [
        { ...onlyIdentity },
        { _id: '507f191e810c19729de860eb', customerId: CUSTOMER_A, provider: 'wallet', subject: '0xabc' },
      ],
    });

    await expect(service.unlinkIdentity(CUSTOMER_A, IDENTITY_OF_B)).resolves.toEqual({ ok: true });
    expect(identities).toHaveLength(1);
    expect(identities[0].provider).toBe('wallet');
  });

  it('scopes the DELETE to the caller: the customerId is in the filter, and another tenant’s row is untouched', async () => {
    const { service, identities, queries } = buildStack({
      customers: [activeCustomer({ passwordHash: 'scrypt:hash' }), activeCustomer({ _id: CUSTOMER_B })],
      identities: [{ ...onlyIdentity, customerId: CUSTOMER_B }],
    });

    await expect(service.unlinkIdentity(CUSTOMER_A, IDENTITY_OF_B)).rejects.toBeInstanceOf(
      NotFoundException,
    );

    const del = queries.find((q) => q.op === 'findOneAndDelete');
    expect(del).toBeDefined();
    // The security property: the caller's id went INTO the filter, so the write
    // could never have matched B's row.
    expect(String(del?.filter?.customerId)).toBe(CUSTOMER_A);
    expect(String(del?.filter?._id)).toBe(IDENTITY_OF_B);
    expect(identities).toHaveLength(1);
    expect(identities[0].customerId).toBe(CUSTOMER_B);
  });

  it('returns 404 for a malformed identity id without touching the database', async () => {
    const { service, queries } = buildStack({ customers: [activeCustomer()] });

    await expect(service.unlinkIdentity(CUSTOMER_A, 'not-an-object-id')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(queries).toHaveLength(0);
  });

  it('lists a customer’s methods without ever exposing the tenant id or a hash', async () => {
    const { service } = buildStack({
      customers: [activeCustomer({ passwordHash: 'scrypt:hash' })],
      identities: [
        { ...onlyIdentity, email: 'me@example.com', emailVerified: true, linkedAt: new Date('2026-01-02T03:04:05Z') },
      ],
    });

    const result = await service.listIdentities(CUSTOMER_A);

    expect(result.hasPassword).toBe(true);
    expect(result.identities).toEqual([
      {
        id: IDENTITY_OF_B,
        provider: 'google',
        subject: 'google-sub-1',
        email: 'me@example.com',
        emailVerified: true,
        linkedAt: '2026-01-02T03:04:05.000Z',
        lastLoginAt: null,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('scrypt:hash');
    expect(JSON.stringify(result)).not.toContain(CUSTOMER_A);
  });

  it('reports hasPassword false for an SSO-only account, which is what locks the last unlink', async () => {
    const { service } = buildStack({
      customers: [activeCustomer()],
      identities: [{ ...onlyIdentity }],
    });

    await expect(service.listIdentities(CUSTOMER_A)).resolves.toMatchObject({ hasPassword: false });
  });
});

describe('the ObjectId the pre-allocated customer gets', () => {
  it('is a real ObjectId, so the identity row and the customer row agree', async () => {
    // The identity is inserted against a PRE-ALLOCATED id (that is what lets the
    // unique index arbitrate before any customer exists), so the two must match.
    const { service, customers, identities } = buildStack();

    await service.resolveLogin({ provider: 'google', subject: 'sub-z', emailVerified: false });

    expect(Types.ObjectId.isValid(customers[0]._id)).toBe(true);
    expect(identities[0].customerId).toBe(customers[0]._id);
  });
});
