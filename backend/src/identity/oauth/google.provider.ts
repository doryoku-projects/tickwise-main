import { Inject, Injectable, Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { AppConfigService } from '../../config/app-config.service.js';
import {
  joinScopes,
  oauthJson,
  type OauthAuthorizeUrlArgs,
  type OauthExchangeCodeArgs,
  type OauthProfile,
  type OauthProvider,
  type OauthTokens,
} from './oauth-provider.interface.js';

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** OIDC-standard userinfo endpoint — same claims as the id_token, no JWT parsing. */
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

interface GoogleTokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
}

interface GoogleUserInfo {
  sub?: string;
  email?: string;
  /** Boolean in the id_token, historically the STRING "true" from userinfo. */
  email_verified?: unknown;
  name?: string;
  given_name?: string;
}

/**
 * Google's `email_verified` claim, coerced STRICTLY.
 *
 * Google has shipped this as the string `"true"` (userinfo) as well as a real
 * boolean (id_token claims), so exactly those two count as verified and
 * EVERYTHING else — `"1"`, `"yes"`, `1`, `null`, absent — is unverified. A loose
 * truthy check is an account-takeover primitive: this boolean is what decides
 * whether an SSO login may attach to an existing password account, and `"false"`
 * is a truthy string.
 */
function isGoogleEmailVerified(raw: unknown): boolean {
  return raw === true || raw === 'true';
}

/**
 * Google OAuth2 + OIDC. Authorization code + PKCE (S256); profile read from the
 * OIDC userinfo endpoint.
 */
@Injectable()
export class GoogleOauthProvider implements OauthProvider {
  readonly id = 'google' as const;
  readonly label = 'Google';
  readonly defaultScopes = ['openid', 'email', 'profile'] as const;

  private readonly logger = new Logger(GoogleOauthProvider.name);

  constructor(@Inject(AppConfigService) private readonly config: AppConfigService) {}

  isEnabled(): boolean {
    return this.config.isOauthProviderConfigured(this.id);
  }

  buildAuthorizeUrl(args: OauthAuthorizeUrlArgs): string {
    const clientId = this.config.oauthGoogleClientId;
    if (!clientId) throw new ServiceUnavailableException('Google sign-in is not configured');
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: args.redirectUri,
      response_type: 'code',
      scope: joinScopes(args.scopes ?? this.defaultScopes),
      state: args.state,
      code_challenge: args.codeChallenge,
      code_challenge_method: 'S256',
      // Always show the chooser: without it a shared browser silently re-uses
      // whichever Google session is already signed in.
      prompt: 'select_account',
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  async exchangeCode(args: OauthExchangeCodeArgs): Promise<OauthTokens> {
    const clientId = this.config.oauthGoogleClientId;
    const clientSecret = this.config.oauthGoogleClientSecret;
    if (!clientId || !clientSecret) {
      throw new ServiceUnavailableException('Google sign-in is not configured');
    }

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      code: args.code,
      code_verifier: args.codeVerifier,
      redirect_uri: args.redirectUri,
    });

    const res = await oauthJson<GoogleTokenResponse>(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (res.statusCode !== 200 || !res.data?.access_token) {
      // Status only — the response body echoes the code back on some errors.
      this.logger.warn(`google token exchange failed (status ${res.statusCode})`);
      throw new UnauthorizedException('Google sign-in could not be completed');
    }

    return {
      accessToken: res.data.access_token,
      tokenType: res.data.token_type,
      scope: res.data.scope,
      expiresInSec: res.data.expires_in,
      idToken: res.data.id_token,
    };
  }

  async fetchProfile(tokens: OauthTokens): Promise<OauthProfile> {
    const res = await oauthJson<GoogleUserInfo>(USERINFO_URL, {
      headers: { authorization: `Bearer ${tokens.accessToken}` },
    });

    if (res.statusCode !== 200 || !res.data) {
      this.logger.warn(`google userinfo failed (status ${res.statusCode})`);
      throw new UnauthorizedException('Google sign-in could not be completed');
    }

    // `sub` is the join key. No sub, no identity — refuse rather than fall back
    // to the email (see the `Identity.subject` comment).
    const subject = typeof res.data.sub === 'string' ? res.data.sub.trim() : '';
    if (!subject) {
      this.logger.warn('google userinfo returned no `sub` claim');
      throw new UnauthorizedException('Google sign-in could not be completed');
    }

    const email = typeof res.data.email === 'string' ? res.data.email.trim().toLowerCase() : undefined;
    const displayName =
      typeof res.data.name === 'string' && res.data.name.trim()
        ? res.data.name.trim()
        : typeof res.data.given_name === 'string' && res.data.given_name.trim()
          ? res.data.given_name.trim()
          : undefined;

    return {
      subject,
      email: email || undefined,
      // Unverified keeps the address as metadata but the flag decides linking.
      emailVerified: Boolean(email) && isGoogleEmailVerified(res.data.email_verified),
      displayName,
    };
  }
}
