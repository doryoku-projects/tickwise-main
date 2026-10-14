import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ADMIN_TOKEN_TYPE, AuthService } from './auth.service.js';

interface AuthedRequest {
  headers: Record<string, string | string[] | undefined>;
  adminUser?: unknown;
}

/**
 * Guards the new admin-panel management routes (`/admin/clients`,
 * `/admin/plans`, `/admin/endpoint-costs`) with a Bearer JWT issued by
 * `AuthService.login`. The legacy ops routes (`/admin/sync/*`) keep their own
 * `x-admin-secret` gate.
 *
 * A valid signature is NOT sufficient: the token must also carry
 * `typ: 'admin'`. Signature alone would admit any token minted by another
 * realm, and the customer realm is a paying self-serve signup.
 */
@Injectable()
export class AdminJwtGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers['authorization'];
    const raw = Array.isArray(header) ? header[0] : header;
    if (!raw || !raw.toLowerCase().startsWith('bearer ')) {
      throw new UnauthorizedException({ error: 'Missing bearer token' });
    }
    const token = raw.slice(7).trim();
    const payload = await this.auth.verify(token);
    // Exact-literal realm check — a missing `typ` (a token issued before this
    // claim existed) is rejected too. Deliberately no grace window: accepting
    // an absent `typ` would reopen the hole for the price of one login.
    if (payload.typ !== ADMIN_TOKEN_TYPE) {
      throw new UnauthorizedException({ error: 'Invalid or expired token' });
    }
    req.adminUser = payload;
    return true;
  }
}
