import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AppConfigService, type OauthProviderKey } from '../../config/app-config.service.js';
import { GithubOauthProvider } from './github.provider.js';
import { GoogleOauthProvider } from './google.provider.js';
import type { OauthProvider } from './oauth-provider.interface.js';

/** What the portal needs to render a sign-in button. Carries no secret. */
export interface OauthProviderDescriptor {
  id: OauthProviderKey;
  label: string;
}

/** Route params are echoed back in the 404; keep the echo to a safe slug. */
function safeProviderId(id: string): string {
  return /^[a-z0-9_-]{1,32}$/.test(id) ? id : 'unknown';
}

/**
 * Registry of SSO providers, mirroring `ProviderRegistry` in `pricing/`.
 *
 * "Which providers are live" is NOT recomputed here — it is read from
 * `AppConfigService.configuredOauthProviders`, the single source of truth the
 * public providers route uses too, so the list a customer is shown and the list
 * a callback will accept cannot drift (a half-configured provider must never be
 * advertised by one and rejected by the other).
 *
 * Adding a provider = one file implementing `OauthProvider` + one entry in
 * `byId` below (plus its two env vars). Nothing else in the flow changes.
 */
@Injectable()
export class OauthProviderRegistry {
  private readonly logger = new Logger(OauthProviderRegistry.name);
  private readonly byId: Record<OauthProviderKey, OauthProvider>;

  constructor(
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(GoogleOauthProvider) google: GoogleOauthProvider,
    @Inject(GithubOauthProvider) github: GithubOauthProvider,
  ) {
    this.byId = { google, github };
    const enabled = this.config.configuredOauthProviders;
    if (enabled.length === 0) {
      this.logger.log('no OAuth providers configured — customer SSO offers password/wallet only');
    } else {
      this.logger.log(`OAuth providers enabled: ${enabled.join(', ')}`);
    }
  }

  /** Ids of every configured provider, in the config's stable order. */
  enabledIds(): OauthProviderKey[] {
    return this.config.configuredOauthProviders;
  }

  /** Configured providers, in the same order. */
  list(): OauthProvider[] {
    return this.enabledIds().map((id) => this.byId[id]);
  }

  /** `{ id, label }` for the public providers route. */
  describe(): OauthProviderDescriptor[] {
    return this.list().map((provider) => ({ id: provider.id, label: provider.label }));
  }

  /** Whether a raw route param names a configured provider. */
  has(id: string): boolean {
    return this.config.isOauthProviderConfigured(id) && Boolean(this.byId[id as OauthProviderKey]);
  }

  /**
   * Resolve a raw `:provider` route param. Unknown OR unconfigured both 404 —
   * an unconfigured provider is indistinguishable from a nonexistent one from
   * the outside, which is also what stops a probe enumerating which credentials
   * an operator has installed.
   */
  resolve(id: string): OauthProvider {
    if (!this.has(id)) {
      throw new NotFoundException(`Unsupported SSO provider '${safeProviderId(id)}'`);
    }
    return this.byId[id as OauthProviderKey];
  }
}
