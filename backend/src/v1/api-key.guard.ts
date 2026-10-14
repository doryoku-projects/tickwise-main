import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ClientsService, type ResolvedKey } from '../billing/clients.service.js';
import { AppConfigService } from '../config/app-config.service.js';

export interface ApiClientContext extends ResolvedKey {}

interface KeyedRequest {
  headers: Record<string, string | string[] | undefined>;
  apiClient?: ApiClientContext;
}

/**
 * Authenticates `/v1` data routes by the `KC-APIKey` header. Resolves the key
 * to its client + plan and attaches it to the request for the metering guard.
 * No metering here — that is the next guard.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    @Inject(ClientsService) private readonly clients: ClientsService,
    @Inject(AppConfigService) private readonly config: AppConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<KeyedRequest>();
    const headerName = this.config.apiKeyHeader.toLowerCase();
    const raw = req.headers[headerName];
    const key = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    if (!key) {
      throw new UnauthorizedException({ error: `Missing ${this.config.apiKeyHeader} header` });
    }
    const resolved = await this.clients.resolveByRawKey(key);
    if (!resolved) {
      throw new UnauthorizedException({ error: 'Invalid or revoked API key' });
    }
    // Origin binding by key type. Only browsers send an `Origin` header, so its
    // presence marks a browser call:
    //  - `server` key + Origin  → 403: a backend key pasted into frontend JS
    //    stops working (it can't be exfiltrated into another site's browser).
    //  - `browser` key + Origin → must match one of its registered origins, so
    //    a leaked browser key is useless on any other website.
    // No Origin header (server-to-server / native app) → allowed for both types;
    // CORS never constrains non-browser callers anyway.
    const originRaw = req.headers['origin'];
    const origin = (Array.isArray(originRaw) ? originRaw[0] : originRaw)?.trim().toLowerCase();
    if (origin) {
      if (resolved.keyType === 'server') {
        throw new ForbiddenException({ error: 'This API key is server-only and cannot be used from a browser' });
      }
      if (!resolved.allowedOrigins.includes(origin)) {
        throw new ForbiddenException({ error: 'Origin not allowed for this API key' });
      }
    }
    req.apiClient = resolved;
    return true;
  }
}
