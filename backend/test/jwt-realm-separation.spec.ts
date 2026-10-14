import 'reflect-metadata';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { describe, expect, it, vi } from 'vitest';
import { AdminJwtGuard } from '../src/auth/admin-jwt.guard.js';
import { AuthService } from '../src/auth/auth.service.js';
import { CustomerJwtGuard } from '../src/portal/customer-jwt.guard.js';

/**
 * The admin panel and the customer portal are two auth realms. Separation rests
 * on TWO independent facts, and these tests pin both:
 *   1. different signing secrets, so a token from one realm does not even
 *      verify in the other;
 *   2. an exact-literal `typ` claim asserted by each guard, so a shared secret
 *      (an operator pasting one value into both envs) still does not collapse
 *      them.
 * Either alone is one mistake away from full compromise, so neither may regress.
 */

const ADMIN_SECRET = 'admin-secret-that-is-long-enough';
const CUSTOMER_SECRET = 'customer-secret-that-is-long-enough';

const adminJwt = new JwtService({ secret: ADMIN_SECRET });
const customerJwt = new JwtService({ secret: CUSTOMER_SECRET });

/** A live customer row, as the customer guard's one read returns it. */
const CUSTOMER_ROW = {
  _id: '507f1f77bcf86cd799439011',
  email: 'buyer@example.com',
  planKey: 'free',
  status: 'active',
};

function ctxFor(token: string) {
  const request: Record<string, unknown> = { headers: { authorization: `Bearer ${token}` } };
  return {
    request,
    ctx: {
      switchToHttp: () => ({ getRequest: () => request }),
      getHandler: () => () => undefined,
      getClass: () => class {},
    } as never,
  };
}

/** The real customer guard over the real customer `JwtService`. */
function customerGuard(row: unknown = CUSTOMER_ROW) {
  const customers = { findById: () => ({ lean: () => ({ exec: async () => row }) }) };
  const reflector = { getAllAndOverride: () => false };
  // Verification off — the default, and the only supported posture until a mail
  // transport exists. With it on and no mailer, every signup is locked out.
  const config = { customerEmailVerificationRequired: false };
  return new CustomerJwtGuard(
    customers as never,
    customerJwt as never,
    reflector as never,
    config as never,
  );
}

/** The real admin guard over the real admin `JwtService`, via `AuthService`. */
function adminGuard() {
  const adminUsers = { findOne: () => ({ exec: async () => null }) };
  const config = { adminEmail: undefined, adminPassword: undefined } as never;
  const auth = new AuthService(adminUsers as never, adminJwt as never, config);
  return new AdminJwtGuard(auth);
}

describe('JWT realm separation', () => {
  it('rejects an admin token at the customer guard', async () => {
    const token = await adminJwt.signAsync({ sub: 'a1', email: 'ops@example.com', role: 'admin', typ: 'admin' });
    const { ctx, request } = ctxFor(token);

    await expect(customerGuard().canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(request.customerUser).toBeUndefined();
  });

  it('rejects a customer token at the admin guard', async () => {
    const token = await customerJwt.signAsync({ sub: 'c1', email: 'buyer@example.com', typ: 'customer' });
    const { ctx, request } = ctxFor(token);

    await expect(adminGuard().canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(request.adminUser).toBeUndefined();
  });

  it('rejects a token with NO typ claim at BOTH guards', async () => {
    // Legacy tokens minted before the claim existed. Deliberately no grace
    // window — accepting an absent `typ` reopens the whole hole.
    const legacyAdmin = await adminJwt.signAsync({ sub: 'a1', email: 'ops@example.com', role: 'admin' });
    const legacyCustomer = await customerJwt.signAsync({ sub: CUSTOMER_ROW._id, email: CUSTOMER_ROW.email });

    await expect(adminGuard().canActivate(ctxFor(legacyAdmin).ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(customerGuard().canActivate(ctxFor(legacyCustomer).ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('fails each realm secret against the other realm verifier', async () => {
    const adminToken = await adminJwt.signAsync({ sub: 'a1', typ: 'admin' });
    const customerToken = await customerJwt.signAsync({ sub: 'c1', typ: 'customer' });

    await expect(customerJwt.verifyAsync(adminToken)).rejects.toThrow();
    await expect(adminJwt.verifyAsync(customerToken)).rejects.toThrow();
    // …and each still verifies against its own, so the test isn't vacuous.
    await expect(adminJwt.verifyAsync(adminToken)).resolves.toMatchObject({ typ: 'admin' });
    await expect(customerJwt.verifyAsync(customerToken)).resolves.toMatchObject({ typ: 'customer' });
  });

  it('would STILL reject a cross-realm token if both realms shared one secret', async () => {
    // The belt to the separate-secret braces: an admin payload signed with the
    // CUSTOMER secret verifies fine, and is refused purely on `typ`.
    const token = await customerJwt.signAsync({ sub: CUSTOMER_ROW._id, email: 'ops@example.com', typ: 'admin' });

    await expect(customerGuard().canActivate(ctxFor(token).ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

describe('CustomerJwtGuard live-state checks', () => {
  it('admits a valid customer token and stashes the principal on req.customerUser', async () => {
    const token = await customerJwt.signAsync({ sub: CUSTOMER_ROW._id, email: CUSTOMER_ROW.email, typ: 'customer' });
    const { ctx, request } = ctxFor(token);

    await expect(customerGuard().canActivate(ctx)).resolves.toBe(true);
    expect(request.customerUser).toMatchObject({ id: CUSTOMER_ROW._id, email: CUSTOMER_ROW.email, planKey: 'free' });
    // Never the admin slot.
    expect(request.adminUser).toBeUndefined();
  });

  it('rejects a suspended customer immediately, without waiting for expiry', async () => {
    const token = await customerJwt.signAsync({ sub: CUSTOMER_ROW._id, email: CUSTOMER_ROW.email, typ: 'customer' });
    const guard = customerGuard({ ...CUSTOMER_ROW, status: 'suspended' });

    await expect(guard.canActivate(ctxFor(token).ctx)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a token issued before the last password change (sign out everywhere)', async () => {
    const token = await customerJwt.signAsync({ sub: CUSTOMER_ROW._id, email: CUSTOMER_ROW.email, typ: 'customer' });
    const guard = customerGuard({ ...CUSTOMER_ROW, passwordChangedAt: new Date(Date.now() + 60_000) });

    await expect(guard.canActivate(ctxFor(token).ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a token whose subject no longer exists', async () => {
    const token = await customerJwt.signAsync({ sub: CUSTOMER_ROW._id, email: CUSTOMER_ROW.email, typ: 'customer' });

    await expect(customerGuard(null).canActivate(ctxFor(token).ctx)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a missing bearer header before verifying anything', async () => {
    const verifyAsync = vi.fn();
    const guard = new CustomerJwtGuard(
      { findById: () => ({ lean: () => ({ exec: async () => CUSTOMER_ROW }) }) } as never,
      { verifyAsync } as never,
      { getAllAndOverride: () => false } as never,
      { customerEmailVerificationRequired: false } as never,
    );
    const request: Record<string, unknown> = { headers: {} };
    const ctx = { switchToHttp: () => ({ getRequest: () => request }) } as never;

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(verifyAsync).not.toHaveBeenCalled();
  });
});
