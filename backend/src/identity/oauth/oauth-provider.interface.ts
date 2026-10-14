import { request, type Dispatcher } from 'undici';
import type { OauthProviderKey } from '../../config/app-config.service.js';

/**
 * Tokens returned by the provider's code exchange. SECRETS — never log an
 * instance, never put one in a URL, never persist one: we exchange the code,
 * read the profile once, and drop them on the floor (no refresh flow, because
 * the only thing SSO grants here is a customer JWT).
 */
export interface OauthTokens {
  accessToken: string;
  tokenType?: string;
  /** Space-separated scopes the provider actually granted (may be narrower than asked). */
  scope?: string;
  expiresInSec?: number;
  /** OIDC id_token when the provider issues one (Google does; GitHub does not). */
  idToken?: string;
}

/**
 * The normalized identity a provider hands back — the ONLY shape the linking
 * layer sees, so every provider's quirks are resolved here rather than there.
 */
export interface OauthProfile {
  /** Provider's STABLE user id (Google `sub`, GitHub numeric id). Never the email. */
  subject: string;
  /** Absent when the provider exposes no usable address. */
  email?: string;
  /**
   * Whether the PROVIDER asserts it verified `email` — not a guess, not
   * "an email came back". This is the single input the linking rules depend on
   * (an unverified provider email must never attach to an existing account), so
   * every implementation coerces it strictly and fails closed to `false`.
   */
  emailVerified: boolean;
  displayName?: string;
}

export interface OauthAuthorizeUrlArgs {
  /** Single-use CSRF state from `OauthStateService.generate()`. */
  state: string;
  /** PKCE S256 challenge; the matching verifier stays server-side in Redis. */
  codeChallenge: string;
  /** Must byte-match the URI registered in the provider's app console. */
  redirectUri: string;
  /** Overrides the provider's `defaultScopes` when supplied. */
  scopes?: readonly string[];
}

export interface OauthExchangeCodeArgs {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}

/**
 * Contract every SSO provider implements — the OAuth mirror of `PriceProvider`.
 * Adding a provider is this interface plus one entry in `OauthProviderRegistry`.
 */
export interface OauthProvider {
  /** Stable id; matches the `:provider` route param and `Identity.provider`. */
  readonly id: OauthProviderKey;
  /** Human label for the portal's sign-in button. */
  readonly label: string;
  /** Scopes requested when the caller doesn't override them. */
  readonly defaultScopes: readonly string[];

  /** False when the provider's client id/secret aren't both configured. */
  isEnabled(): boolean;

  /** Absolute URL to redirect the browser to. Contains no secret. */
  buildAuthorizeUrl(args: OauthAuthorizeUrlArgs): string;

  /** Back-channel code→token exchange (POST, client secret in the body). */
  exchangeCode(args: OauthExchangeCodeArgs): Promise<OauthTokens>;

  /** Read the identity the tokens grant access to. */
  fetchProfile(tokens: OauthTokens): Promise<OauthProfile>;
}

export interface OauthHttpResult<T> {
  statusCode: number;
  data?: T;
}

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * `undici.request` + JSON parsing for the two OAuth hops (token exchange, profile
 * fetch) — same shape as `BaseProvider.httpJson`, minus the rate-limit state
 * machine (an SSO round trip is user-driven and one-shot, so there is nothing to
 * back off). Bounded by an AbortController so a hanging provider can't pin the
 * request that a customer is waiting on.
 *
 * Returns `{ statusCode }` with no `data` on any non-200 or unparseable body —
 * callers decide the user-facing error. NOTHING here logs the URL, the body or
 * the response: the request body carries the client secret and the authorization
 * code, and the response carries the access token.
 */
export async function oauthJson<T>(
  url: string,
  options: {
    method?: Dispatcher.HttpMethod;
    headers?: Record<string, string>;
    body?: string;
    timeoutMs?: number;
  } = {},
): Promise<OauthHttpResult<T>> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await request(url, {
      method: options.method ?? 'GET',
      headers: { accept: 'application/json', ...(options.headers ?? {}) },
      body: options.body,
      signal: controller.signal,
      bodyTimeout: timeoutMs,
      headersTimeout: timeoutMs,
    });

    const statusCode = response.statusCode;
    if (statusCode !== 200) {
      await response.body.dump();
      return { statusCode };
    }
    try {
      return { statusCode, data: (await response.body.json()) as T };
    } catch {
      return { statusCode };
    }
  } catch {
    // Timeout / socket error / abort. 0 = "never reached the provider".
    return { statusCode: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/** Space-joined scope parameter, deduped, preserving the caller's order. */
export function joinScopes(scopes: readonly string[]): string {
  return [...new Set(scopes)].join(' ');
}
