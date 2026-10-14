/**
 * Where an SSO round-trip should land, carried across the provider redirect.
 *
 * The backend callback bounces to `/auth/callback?provider=&code=` and nothing
 * else — the destination never leaves our origin, so it has to survive on this
 * side. sessionStorage, not localStorage: it is scoped to the tab that started
 * the handshake and dies with it.
 */
const RETURN_KEY = 'tk-sso-return-to';

/**
 * The pending-link token behind the "sign in to connect" ceremony.
 *
 * It arrives in the URL (`/link-account?token=`), but finishing the ceremony
 * through a provider is a full redirect round trip — out to Google and back in
 * through /auth/callback — and the query string does not survive that. So the
 * token is MIRRORED here on arrival: same tab scope and same lifetime as the
 * return path above.
 *
 * The mirror is a carrier, never the source of truth. The URL is read first, so
 * a freshly issued ceremony always beats a stale copy an abandoned one left
 * behind, and the page clears it the moment the token is spent or dead.
 */
const PENDING_LINK_KEY = 'tk-pending-link';

export const DEFAULT_RETURN_TO = '/portal';

/**
 * Root-relative paths only. A session token is minted immediately after this
 * redirect, so a caller-supplied absolute URL must never be honoured —
 * `//evil.example` and `/\evil.example` are protocol-relative and both leave
 * our origin.
 *
 * Kept STATEMENT FOR STATEMENT in lockstep with `sanitizeReturnTo` in the
 * backend's `identity/oauth-state.service.ts`: same order, same limits, same
 * rejected range. The two guard the same value on the two halves of one
 * redirect, so a check that exists on only one side is a hole on the other.
 * Change both or neither.
 */
export function safeReturnTo(value: string | null | undefined): string {
  if (typeof value !== 'string') return DEFAULT_RETURN_TO;
  const path = value.trim();
  if (!path || path.length > 512) return DEFAULT_RETURN_TO;
  if (!path.startsWith('/')) return DEFAULT_RETURN_TO;
  if (path.startsWith('//') || path.includes('\\')) return DEFAULT_RETURN_TO;
  // Reject every C0 control character and DEL, not just CRLF. The URL parser
  // DELETES these before it parses, so a raw TAB slipped past both the `//` and
  // the `\` checks above and then resolved off-origin — `/<TAB>/evil.example`
  // becomes `//evil.example` once parsed, and `location.replace` carries the
  // in-flight sign-in there. Anything the parser silently removes can smuggle an
  // authority, so the whole range goes rather than the few we thought of.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(path)) return DEFAULT_RETURN_TO;
  return path;
}

export function rememberReturnTo(value: string): void {
  try {
    window.sessionStorage.setItem(RETURN_KEY, safeReturnTo(value));
  } catch {
    /* private mode / storage disabled — the callback falls back to /portal */
  }
}

/**
 * Reads AND clears: a stale destination must not hijack a later sign-in. The
 * value is re-sanitised on the way out.
 *
 * `rememberReturnTo` already sanitises on the way in, so the second pass is
 * defence in depth, not a hole being closed: sessionStorage is writable by any
 * same-origin script, so what comes back out is not provably what we put in.
 * `null` is preserved as `null` so callers can still tell "nothing was stored"
 * from "/portal was stored".
 */
export function takeReturnTo(): string | null {
  try {
    const value = window.sessionStorage.getItem(RETURN_KEY);
    window.sessionStorage.removeItem(RETURN_KEY);
    return value === null ? null : safeReturnTo(value);
  } catch {
    return null;
  }
}

/**
 * Provider ids and error slugs arrive in the query string, i.e. from anywhere.
 * Anything that isn't a plain slug is dropped rather than rendered.
 */
export function readSlug(value: string | null | undefined): string {
  if (!value || value.length > 64) return '';
  return /^[a-z0-9][a-z0-9_-]*$/i.test(value) ? value : '';
}

/**
 * An opaque server-minted token off the query string (or out of the mirror
 * below, which is just as untrusted — any script that ran in this tab could
 * have written it).
 *
 * Shape and cap mirror `isPlausibleToken` in the backend's
 * `oauth-state.service.ts`: base64url only, 256 characters at most. Garbage is
 * dropped here rather than sent, so it never becomes a Redis key on the way to
 * being rejected, and never lands in a rendered URL.
 */
export function readOpaqueToken(value: string | null | undefined): string {
  if (!value || value.length > 256) return '';
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : '';
}

export function rememberPendingLink(token: string): void {
  try {
    window.sessionStorage.setItem(PENDING_LINK_KEY, token);
  } catch {
    /* private mode / storage disabled — the ceremony still works from the URL */
  }
}

/** Reads WITHOUT clearing: the page re-reads it on every step of the ceremony. */
export function readPendingLink(): string {
  try {
    return readOpaqueToken(window.sessionStorage.getItem(PENDING_LINK_KEY));
  } catch {
    return '';
  }
}

/** Call once the token is spent or provably dead — never leave a stale one to
 *  hijack an unrelated visit to /link-account. */
export function clearPendingLink(): void {
  try {
    window.sessionStorage.removeItem(PENDING_LINK_KEY);
  } catch {
    /* nothing to clear if it was never stored */
  }
}
