import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AdminJwtGuard } from '../src/auth/admin-jwt.guard.js';
import { AuthService } from '../src/auth/auth.service.js';
import { hashPassword } from '../src/auth/password.util.js';

function build(user: any) {
  const adminUsers = {
    findOne: () => ({ exec: async () => user }),
  };
  const jwt = { signAsync: vi.fn(async () => 'signed.jwt.token'), verifyAsync: vi.fn() };
  const config = { adminEmail: undefined, adminPassword: undefined } as any;
  return { service: new AuthService(adminUsers as never, jwt as never, config), jwt };
}

describe('AuthService.login', () => {
  it('returns a signed token for valid credentials', async () => {
    const user = {
      _id: 'u1',
      email: 'admin@example.com',
      role: 'admin',
      passwordHash: hashPassword('correct-horse'),
      save: vi.fn(async () => undefined),
    };
    const { service, jwt } = build(user);

    const result = await service.login('Admin@Example.com', 'correct-horse');

    expect(result).toEqual({ token: 'signed.jwt.token', email: 'admin@example.com', role: 'admin' });
    // `typ` is the realm discriminator AdminJwtGuard asserts — it must be on
    // every admin token, so this deep-equality assertion pins it.
    expect(jwt.signAsync).toHaveBeenCalledWith({
      sub: 'u1',
      email: 'admin@example.com',
      role: 'admin',
      typ: 'admin',
    });
    expect(user.save).toHaveBeenCalled();
  });

  it('rejects a wrong password', async () => {
    const user = { _id: 'u1', email: 'admin@example.com', role: 'admin', passwordHash: hashPassword('correct'), save: vi.fn() };
    const { service } = build(user);
    await expect(service.login('admin@example.com', 'nope')).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an unknown email', async () => {
    const { service } = build(null);
    await expect(service.login('ghost@example.com', 'whatever')).rejects.toBeInstanceOf(UnauthorizedException);
  });
});

// ─── AdminJwtGuard realm gate ─────────────────────────────────────────────

const ctx = (headers: Record<string, string>) => {
  const request: Record<string, unknown> = { headers };
  return { request, ctx: { switchToHttp: () => ({ getRequest: () => request }) } as never };
};

function guardFor(payload: unknown) {
  const auth = { verify: vi.fn(async () => payload) };
  return { guard: new AdminJwtGuard(auth as never), auth };
}

describe('AdminJwtGuard', () => {
  it('admits a token carrying typ: admin and stashes it on req.adminUser', async () => {
    const payload = { sub: 'u1', email: 'admin@example.com', role: 'admin', typ: 'admin' };
    const { guard } = guardFor(payload);
    const { request, ctx: context } = ctx({ authorization: 'Bearer good.jwt.token' });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.adminUser).toEqual(payload);
  });

  it('rejects a validly-signed token from another realm (typ: customer)', async () => {
    // The whole point of the split: a customer token must not open /admin even
    // if a shared secret ever makes its signature verify.
    const { guard } = guardFor({ sub: 'c1', email: 'buyer@example.com', role: 'admin', typ: 'customer' });
    const { ctx: context } = ctx({ authorization: 'Bearer customer.jwt.token' });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a legacy token with no typ claim — no grace window', async () => {
    const { guard } = guardFor({ sub: 'u1', email: 'admin@example.com', role: 'admin' });
    const { request, ctx: context } = ctx({ authorization: 'Bearer legacy.jwt.token' });

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(request.adminUser).toBeUndefined();
  });

  it('rejects a missing bearer header before touching the verifier', async () => {
    const { guard, auth } = guardFor({ typ: 'admin' });
    const { ctx: context } = ctx({});

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(auth.verify).not.toHaveBeenCalled();
  });
});
