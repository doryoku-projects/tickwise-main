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

const AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';
const USER_EMAILS_URL = 'https://api.github.com/user/emails';

/** GitHub rejects API calls without a User-Agent and version-pins its JSON API. */
const API_HEADERS: Record<string, string> = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'tickwise-api-portal',
};

interface GithubTokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
}

interface GithubUser {
  id?: number | string;
  login?: string;
  name?: string;
  /** PUBLIC PROFILE email — may be null, and is NOT proof of ownership. */
  email?: string | null;
}

interface GithubEmail {
  email?: string;
  primary?: boolean;
  verified?: boolean;
}

/**
 * GitHub OAuth2 (not OIDC — no id_token, no userinfo endpoint).
 *
 * PKCE: GitHub's OAuth app flow does not implement RFC 7636 and IGNORES
 * `code_challenge`. We send it anyway (harmless, and it starts working the day
 * they support it), which means the single-use `state` is the load-bearing CSRF
 * defence for this provider — see `OauthStateService.consume`, which is atomic
 * for exactly that reason.
 */
@Injectable()
export class GithubOauthProvider implements OauthProvider {
  readonly id = 'github' as const;
  readonly label = 'GitHub';
  readonly defaultScopes = ['read:user', 'user:email'] as const;

  private readonly logger = new Logger(GithubOauthProvider.name);

  constructor(@Inject(AppConfigService) private readonly config: AppConfigService) {}

  isEnabled(): boolean {
    return this.config.isOauthProviderConfigured(this.id);
  }

  buildAuthorizeUrl(args: OauthAuthorizeUrlArgs): string {
    const clientId = this.config.oauthGithubClientId;
    if (!clientId) throw new ServiceUnavailableException('GitHub sign-in is not configured');
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: args.redirectUri,
      scope: joinScopes(args.scopes ?? this.defaultScopes),
      state: args.state,
      code_challenge: args.codeChallenge,
      code_challenge_method: 'S256',
      allow_signup: 'true',
    });
    return `${AUTHORIZE_URL}?${params.toString()}`;
  }

  async exchangeCode(args: OauthExchangeCodeArgs): Promise<OauthTokens> {
    const clientId = this.config.oauthGithubClientId;
    const clientSecret = this.config.oauthGithubClientSecret;
    if (!clientId || !clientSecret) {
      throw new ServiceUnavailableException('GitHub sign-in is not configured');
    }

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code: args.code,
      code_verifier: args.codeVerifier,
      redirect_uri: args.redirectUri,
    });

    // GitHub defaults this endpoint to form-encoded RESPONSES; `accept: json`
    // (set by `oauthJson`) is what makes it answer with JSON.
    const res = await oauthJson<GithubTokenResponse>(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    // GitHub answers 200 with `{ error: 'bad_verification_code' }` on failure.
    if (res.statusCode !== 200 || !res.data?.access_token) {
      this.logger.warn(
        `github token exchange failed (status ${res.statusCode}${res.data?.error ? `, ${res.data.error}` : ''})`,
      );
      throw new UnauthorizedException('GitHub sign-in could not be completed');
    }

    return {
      accessToken: res.data.access_token,
      tokenType: res.data.token_type,
      scope: res.data.scope,
    };
  }

  async fetchProfile(tokens: OauthTokens): Promise<OauthProfile> {
    const authHeaders = { ...API_HEADERS, authorization: `Bearer ${tokens.accessToken}` };

    const userRes = await oauthJson<GithubUser>(USER_URL, { headers: authHeaders });
    if (userRes.statusCode !== 200 || !userRes.data) {
      this.logger.warn(`github /user failed (status ${userRes.statusCode})`);
      throw new UnauthorizedException('GitHub sign-in could not be completed');
    }

    // The numeric account id is the only stable handle: `login` is renameable
    // (and re-claimable by someone else afterwards) and the email is not an
    // identity at all — see the `Identity.subject` comment.
    const rawId = userRes.data.id;
    const subject = typeof rawId === 'number' ? String(rawId) : typeof rawId === 'string' ? rawId.trim() : '';
    if (!subject) {
      this.logger.warn('github /user returned no id');
      throw new UnauthorizedException('GitHub sign-in could not be completed');
    }

    const displayName =
      typeof userRes.data.name === 'string' && userRes.data.name.trim()
        ? userRes.data.name.trim()
        : typeof userRes.data.login === 'string' && userRes.data.login.trim()
          ? userRes.data.login.trim()
          : undefined;

    // THE classic GitHub account-takeover vector: `/user.email` is the PUBLIC
    // PROFILE email. A user can set it to any string, verified or not (GitHub
    // does not require ownership for the public profile field), so trusting it
    // as a verified address lets an attacker point it at a victim's address and
    // have the linking layer attach to the victim's existing customer account.
    // The only trustworthy source is `/user/emails`, and only the entry that is
    // BOTH `primary` and `verified`. No such entry (scope not granted, no
    // verified address at all) → no email and `emailVerified: false`, i.e. this
    // login can only ever create/own its own account.
    const verifiedEmail = await this.fetchPrimaryVerifiedEmail(authHeaders);

    return {
      subject,
      email: verifiedEmail,
      emailVerified: Boolean(verifiedEmail),
      displayName,
    };
  }

  /** The `primary && verified` address from `/user/emails`, or undefined. */
  private async fetchPrimaryVerifiedEmail(headers: Record<string, string>): Promise<string | undefined> {
    const res = await oauthJson<GithubEmail[]>(USER_EMAILS_URL, { headers });
    // 403/404 = `user:email` not granted. Not fatal: sign-in still works, the
    // identity just carries no email.
    if (res.statusCode !== 200 || !Array.isArray(res.data)) {
      this.logger.warn(`github /user/emails unavailable (status ${res.statusCode}) — treating email as unverified`);
      return undefined;
    }
    const match = res.data.find(
      (entry) => entry?.primary === true && entry?.verified === true && typeof entry.email === 'string',
    );
    const email = match?.email?.trim().toLowerCase();
    return email || undefined;
  }
}
