import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { FirstPartyOriginGuard } from '../src/common/first-party-origin.guard.js';

function build(opts: { isProduction: boolean; corsOrigins: string[] }) {
  const guard = new FirstPartyOriginGuard({
    isProduction: opts.isProduction,
    corsOrigins: opts.corsOrigins,
  } as never);
  const ctx = (headers: Record<string, string>) =>
    ({ switchToHttp: () => ({ getRequest: () => ({ headers }) }) }) as never;
  return { guard, ctx };
}

describe('FirstPartyOriginGuard', () => {
  const ALLOW = ['https://app.doryoku.tech'];

  it('allows a first-party origin in prod (case-insensitive)', () => {
    const { guard, ctx } = build({ isProduction: true, corsOrigins: ALLOW });
    expect(guard.canActivate(ctx({ origin: 'https://app.doryoku.tech' }))).toBe(true);
    expect(guard.canActivate(ctx({ origin: 'HTTPS://App.Doryoku.Tech' }))).toBe(true); // normalized match
  });

  it('rejects (403) a non-allowlisted origin in prod', () => {
    const { guard, ctx } = build({ isProduction: true, corsOrigins: ALLOW });
    expect(() => guard.canActivate(ctx({ origin: 'https://evil.com' }))).toThrow(ForbiddenException);
  });

  it('rejects (403) a request with no Origin header in prod (curl / server-to-server)', () => {
    const { guard, ctx } = build({ isProduction: true, corsOrigins: ALLOW });
    expect(() => guard.canActivate(ctx({}))).toThrow(ForbiddenException);
  });

  it('allows ANY origin (and no Origin) in dev', () => {
    const { guard, ctx } = build({ isProduction: false, corsOrigins: ALLOW });
    expect(guard.canActivate(ctx({ origin: 'https://anywhere.com' }))).toBe(true);
    expect(guard.canActivate(ctx({}))).toBe(true);
  });
});
