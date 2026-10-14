import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { normalizeOrigin } from '../billing/api-key.util.js';
import { AppConfigService } from '../config/app-config.service.js';

interface OriginRequest {
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Gate for the OPEN, keyless `/api/*` data routes: only requests from a
 * first-party origin (the `CORS_ORIGINS` allowlist) may use them without an
 * API key — everyone else must use the metered `/v1` API with a `KC-APIKey`
 * key. In dev (`!isProduction`) all origins are allowed, mirroring the CORS
 * dev behaviour so local work and tests are frictionless.
 *
 * A request with NO `Origin` header (curl / server-to-server) is rejected, so
 * non-browser callers are pushed onto `/v1` + key.
 *
 * LIMITATION (by design): the `Origin` header is authoritative only for real
 * browsers — cross-site JS cannot forge it. A non-browser client can SPOOF any
 * `Origin`, so this is a soft first-party gate, not a hard boundary. The real
 * boundary is the API key on `/v1`; this only stops other websites' browsers
 * and honest/no-Origin clients from hitting the unmetered routes.
 */
@Injectable()
export class FirstPartyOriginGuard implements CanActivate {
  private allow: Set<string> | null = null;

  constructor(@Inject(AppConfigService) private readonly config: AppConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.config.isProduction) return true; // dev: allow any origin (mirrors CORS)
    const req = context.switchToHttp().getRequest<OriginRequest>();
    const raw = req.headers['origin'];
    const origin = normalizeOrigin((Array.isArray(raw) ? raw[0] : raw) ?? '');
    if (origin && this.allowedOrigins().has(origin)) return true;
    throw new ForbiddenException({
      error: 'Direct API access is restricted to first-party apps. Use the /v1 API with a KC-APIKey key.',
    });
  }

  /** First-party origins from CORS_ORIGINS, normalized to canonical form (built once). */
  private allowedOrigins(): Set<string> {
    if (this.allow) return this.allow;
    const set = new Set<string>();
    for (const o of this.config.corsOrigins) {
      const n = normalizeOrigin(o);
      if (n) set.add(n);
    }
    this.allow = set;
    return set;
  }
}
