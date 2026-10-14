import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { AppConfigService } from '../config/app-config.service.js';

const STATE_PREFIX = 'sso:oauth:state:';
const HANDOFF_PREFIX = 'sso:oauth:handoff:';
const PENDING_LINK_PREFIX = 'sso:oauth:pendinglink:';

/** Long enough for a slow consent screen, short enough that a leaked authorize
 *  URL is stale by the time it is found in a log or a shared screenshot. */
const STATE_TTL_SEC = 10 * 60;
/** The handoff code lives only for the frontend's immediate exchange call. */
const HANDOFF_TTL_SEC = 60;
/**
 * A pending link waits for a HUMAN to sign in to the account they collided with,
 * so it cannot be a 60-second code — but it is still a standing invitation to
 * attach a provider account, so it expires with the same 10-minute budget the
 * rest of the round trip gets.
 */
const PENDING_LINK_TTL_SEC = 10 * 60;

/** Cap before we touch Redis — bounds the key space a prober can address. */
const MAX_OPAQUE_TOKEN_LENGTH = 256;

/**
 * THE BROWSER BINDER — the cookie that ties an OAuth round trip to the browser
 * that began it.
 *
 * The `state` parameter alone proves only that SOME flow started here, not that
 * it started in THIS browser: the person who requested the authorize URL is
 * free to hand it (or the finished callback URL) to somebody else. Without a
 * binder that is three separate attacks, all of them confirmed by review:
 *
 *  - LOGIN CSRF / SESSION FIXATION — the attacker completes a login with their
 *    own provider account and gets the victim's browser to run the callback, so
 *    the victim ends up signed into the ATTACKER's account and types their data
 *    into it.
 *  - FORCED ACCOUNT LINKING — the attacker starts a LINK flow on their own
 *    account and gets the victim to finish it with the victim's Google/GitHub
 *    account. The victim's provider identity is then permanently attached to
 *    the attacker's account, so every future "sign in with Google" by the victim
 *    lands in the attacker's tenant.
 *  - HANDOFF THEFT — the handoff code travels in a redirect URL, i.e. through
 *    browser history, the `Referer` of whatever the portal loads next, and this
 *    service's own access log. Anyone who reads one of those copies inside the
 *    60-second window can exchange it for the session.
 *
 * So `start` mints a random binder, stores only its SHA-256 INSIDE the state
 * record, and sets the raw value as an HttpOnly cookie. The callback and the
 * handoff exchange both re-derive the hash from the cookie and compare it in
 * constant time. A stolen state, a stolen callback URL and a stolen handoff code
 * are all useless without the cookie, which never leaves the browser that
 * started the flow and is unreadable to script.
 */
export const OAUTH_BINDER_COOKIE = 'sso_binder';

/**
 * THE CEREMONY BINDER — a SECOND cookie, for the pending link only, and the
 * separation is the whole point.
 *
 * `sso_binder` belongs to ONE OAuth round trip: `start` overwrites it and the
 * handoff exchange deletes it the moment a session has been handed over. That is
 * correct for a round trip and fatal for a ceremony, because the ceremony
 * deliberately SPANS one: the /link-account page asks the visitor to sign in, and
 * signing in with a second provider is itself a full round trip that overwrites
 * the cookie on the way out and clears it on the way back. Binding the pending
 * link to `sso_binder` therefore guaranteed that the one path the page recommends
 * — "sign in the way you normally do" — destroyed the thing it was recommended
 * for, with a generic "no longer valid" as the only symptom.
 *
 * So the callback plants the same proven binder value under a name nothing else
 * touches, with the PENDING LINK's own lifetime. The security property is
 * unchanged and is established at the same instant: the cookie rides on the same
 * 302 that carries the token, so whoever later reads that URL out of browser
 * history, a `Referer` or our access log still has no way to present the cookie.
 * Only its BLAST RADIUS changed — a login round trip no longer collaterally
 * cancels a ceremony it knows nothing about.
 */
export const LINK_BINDER_COOKIE = 'sso_link_binder';

/**
 * Scoped to the routes that READ these cookies. A `Path=/` cookie would ride
 * along on every other request to this API for no reason.
 *
 * WIDENED from `/account/auth` to `/account` for the pending-link ceremony: its
 * completion route is `POST /account/identities/link-pending`, and `Path` decides
 * where the browser SENDS a cookie — under the old scope it would simply not have
 * been sent there, and a binder that never arrives is indistinguishable from one
 * that does not match, i.e. the ceremony would fail closed 100% of the time. Both
 * cookies share the scope because the readers between them span `/account/auth/*`
 * and `/account/identities/*`; a second path constant would only be one more
 * thing that can silently drift out of step with a route move.
 *
 * NOTE the link flow sets `sso_binder` from `POST /account/identities/:provider/link`.
 * That was already legal under the narrower scope and still is: `Path` constrains
 * where a cookie is sent, not where it may be set.
 *
 * DEPLOY NOTE: a browser holding a cookie planted by the previous build carries it
 * at the OLD path, and a `Set-Cookie` at the new path cannot delete it — for the
 * lifetime of that cookie (≤10 minutes) the browser may send BOTH, which
 * `readBinderCookie` treats as no binder at all. That costs those in-flight logins
 * one retry, which is the correct trade for never guessing which of two cookies is
 * ours.
 */
const BINDER_COOKIE_PATH = '/account';

/** Matches the state TTL: the cookie is useless the moment the state expires. */
const BINDER_MAX_AGE_SEC = STATE_TTL_SEC;

/**
 * Matches the PENDING LINK's TTL, and it must be this one rather than
 * `BINDER_MAX_AGE_SEC`.
 *
 * The two clocks start at different moments: the round-trip binder is planted at
 * `start`, the pending link is minted at the CALLBACK, i.e. after however long the
 * visitor spent at the provider's account chooser, password prompt and 2FA. Reusing
 * the round trip's budget made the ceremony's real window `600s − time at the
 * provider` while the Redis record was still live — a visitor who took four minutes
 * to sign in to Google got six minutes to find their password, and the cliff was
 * the same generic "no longer valid" 404. Planting a fresh `Max-Age` here is what
 * makes the advertised ten minutes the actual ten minutes.
 */
const LINK_BINDER_MAX_AGE_SEC = PENDING_LINK_TTL_SEC;

/** SHA-256, hex. */
const BINDER_HASH_PATTERN = /^[a-f0-9]{64}$/;

/** What the callback needs back, keyed by the state it was issued with. */
export interface OauthStateRecord {
  provider: string;
  /** PKCE verifier — the SECRET half. Never leaves the server. */
  codeVerifier: string;
  /** Portal-relative path to land on after login (already sanitized). */
  returnTo?: string;
  /**
   * `sha256(binder)` for the cookie set alongside this state. Only the HASH is
   * stored, so a dump of Redis does not hand anybody a usable binder.
   */
  binderHash: string;
  /**
   * Set ONLY for a link flow: the customer that started it, as a 24-hex string.
   *
   * It lives HERE rather than in a side key so the link target is covered by the
   * same atomic single-use consume as the rest of the round trip — one record,
   * one `GETDEL`, no window in which a state and its intent can be separated,
   * and no second key that can expire (or be written) independently.
   */
  linkCustomerId?: string;
}

export interface GeneratedOauthState {
  state: string;
  codeVerifier: string;
  /** base64url(SHA-256(codeVerifier)) — the S256 challenge. */
  codeChallenge: string;
  /**
   * The RAW binder. Belongs in exactly one place — the `Set-Cookie` header. It
   * must never reach a response body, a log line or a URL: anything that can
   * read it can complete somebody else's OAuth round trip.
   */
  binder: string;
}

/**
 * What the frontend gets when it redeems a handoff code. The customer token is
 * handed over in a RESPONSE BODY, never in a URL.
 */
export interface OauthHandoffRecord {
  /** The already-minted customer JWT (identical to a password login's). */
  token: string;
  customerId: string;
  /** Which provider completed the login. */
  provider: string;
  /** True when this login CREATED the customer (drives onboarding copy). */
  isNewCustomer: boolean;
  returnTo?: string;
  /**
   * Carried over from the state record, and re-checked at the exchange. This is
   * what makes possessing the handoff code INSUFFICIENT: the code travels in a
   * URL (history, `Referer`, our own access log), the cookie does not.
   */
  binderHash: string;
}

/**
 * A collision that is waiting for its owner to prove they own the account.
 *
 * Minted when an SSO login's PROVIDER-VERIFIED email lands on an existing
 * customer that we have not verified ourselves: instead of the dead-end 409, the
 * browser is sent to the portal's `/link-account` page to sign in to that
 * account, and completing that ceremony attaches this provider to it.
 *
 * BINDER-BOUND for exactly the reason the handoff code is: the token travels in a
 * redirect URL, so it exists in browser history, in the `Referer` of whatever the
 * portal loads next, and in this service's own access log. Anyone reading one of
 * those copies could otherwise drive the ceremony from another browser — and the
 * thing the ceremony grants is a permanent extra login on an account.
 *
 * The binder it is bound to lives in its OWN cookie (`LINK_BINDER_COOKIE`) rather
 * than in `sso_binder`, because the ceremony outlives the round trip that minted
 * it — see that constant for the failure this separation removes.
 *
 * NOTE what is NOT here: the token is the ONLY carrier. The email is deliberately
 * absent from the redirect URL, because a crafted `/link-account?...` naming an
 * arbitrary address would render a convincing "sign in to connect" lure on our own
 * domain; the masked address is served from this record instead.
 */
export interface OauthPendingLinkRecord {
  provider: string;
  /** Provider-stable id — the future `Identity.subject`. Never the email. */
  subject: string;
  /** Normalized, and the address the collision was ON. */
  email: string;
  /** Always true. A pending link is offered ONLY for a provider-verified email. */
  emailVerified: boolean;
  displayName?: string;
  /**
   * The ONLY account this link may ever land on, as a 24-hex string — the
   * customer that already holds `email`. The completion route refuses any other
   * signed-in caller, so this field IS the authorization.
   */
  targetCustomerId: string;
  /**
   * `sha256(binder)`, carried over from the state record — the binder the round
   * trip just proved. The callback re-plants that same raw value under
   * `LINK_BINDER_COOKIE`, which is the cookie both ceremony routes read.
   */
  binderHash: string;
  returnTo?: string;
}

/** URL-safe random token. `randomBytes`, never `Math.random`. */
function randomUrlToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** `sha256(binder)` in hex — the only form of the binder we ever store. */
export function hashBinder(binder: string): string {
  return createHash('sha256').update(binder, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of a stored binder hash against a presented cookie.
 *
 * BOTH sides are hashed before the compare, which is what makes the widths
 * unconditionally equal — `timingSafeEqual` THROWS on a length mismatch, so
 * comparing a 64-char hash against a truncated/garbage one would turn an
 * attacker-controlled cookie into a 500 (and, worse, a length oracle). Hashing
 * the already-hashed stored value is not redundant: it is what guarantees 32
 * bytes on the left even if the record was written by an older build or
 * tampered with.
 *
 * Absent, mis-shaped and mismatched all return the SAME `false` — the callback
 * turns every one of them into the same redirect slug, so there is no oracle.
 *
 * Typed as a PREDICATE on `presented` because a `true` here really does mean the
 * caller holds a well-formed binder string: the callback re-plants that value
 * under the ceremony's cookie name, and the alternative was a cast asserting
 * exactly what this function already checked.
 */
export function binderMatches(expectedHash: unknown, presented: unknown): presented is string {
  if (typeof expectedHash !== 'string' || !BINDER_HASH_PATTERN.test(expectedHash)) return false;
  if (!isPlausibleToken(presented)) return false;
  return timingSafeEqual(fixedWidthDigest(expectedHash), fixedWidthDigest(hashBinder(presented)));
}

function fixedWidthDigest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** `Set-Cookie` value that plants the binder for a round trip that just started. */
export function buildBinderCookie(binder: string, secure: boolean): string {
  return serializeBinderCookie(OAUTH_BINDER_COOKIE, binder, BINDER_MAX_AGE_SEC, secure);
}

/** `Set-Cookie` value that removes it — sent once the session has been handed over. */
export function clearBinderCookie(secure: boolean): string {
  return serializeBinderCookie(OAUTH_BINDER_COOKIE, '', 0, secure);
}

/**
 * `Set-Cookie` that binds a freshly minted pending link to this browser.
 *
 * Carries the SAME raw binder the round trip just proved — the callback has it in
 * hand and has already compared it against the state record, so re-using it binds
 * the ceremony to exactly the browser that met the provider without inventing a
 * second secret to keep in step. What differs is the NAME and the LIFETIME, which
 * is the entire fix: nothing in a later login round trip writes this name.
 */
export function buildLinkBinderCookie(binder: string, secure: boolean): string {
  return serializeBinderCookie(LINK_BINDER_COOKIE, binder, LINK_BINDER_MAX_AGE_SEC, secure);
}

/** Removes it — sent once the ceremony has actually been completed. */
export function clearLinkBinderCookie(secure: boolean): string {
  return serializeBinderCookie(LINK_BINDER_COOKIE, '', 0, secure);
}

/**
 * The cookie attributes, and why each one:
 *  - `HttpOnly` — script must never read the binder; XSS on the portal would
 *    otherwise let a page complete a round trip it did not start.
 *  - `SameSite=Lax`, NOT `Strict` — the cookie has to survive the provider's
 *    top-level redirect back into our callback. `Strict` withholds cookies on
 *    every cross-site navigation, including that one, which would reject EVERY
 *    real login. `Lax` sends them on top-level GET navigations, which is exactly
 *    (and only) the shape of the callback.
 *  - `Secure` only when `isProduction` — a `Secure` cookie is silently dropped
 *    over plain http, so hardcoding it would break local dev with a failure that
 *    looks like a mismatched binder rather than a missing one.
 *  - `Max-Age` bounded by the TTL of the record it binds to — the state's for the
 *    round-trip binder, the pending link's for the ceremony binder. A cookie that
 *    outlives its record buys nothing, and one that DIES FIRST silently shortens
 *    the window the record advertises.
 *
 * `encodeURIComponent` is a no-op on the base64url values we mint and a guard
 * against header injection if this is ever called with something else.
 */
function serializeBinderCookie(
  name: string,
  value: string,
  maxAgeSec: number,
  secure: boolean,
): string {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${BINDER_COOKIE_PATH}`,
    `Max-Age=${maxAgeSec}`,
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

/**
 * Pull the binder out of a raw `Cookie` header. No `cookie-parser`: one header,
 * one name, and a dependency whose whole job is a `split(';')` is not worth the
 * supply-chain surface on an unauthenticated route.
 *
 * Handles the three cases that matter:
 *  - ABSENT header, or no cookie by that name → `undefined`.
 *  - Other cookies alongside it (the common case) → ours, by exact name.
 *  - DUPLICATE names with DIFFERENT values → `undefined`, deliberately. A
 *    cookie-tossing attacker (any XSS or takeover on a sibling subdomain can set
 *    a `Domain=` cookie) can add a second `sso_binder` that the browser sends
 *    alongside ours, and the `Cookie` header carries no attributes to tell them
 *    apart. Guessing which one is ours is exactly how such an attacker plants a
 *    binder; an ambiguous header is therefore no binder at all.
 */
export function readBinderCookie(header: unknown): string | undefined {
  return readCookie(header, OAUTH_BINDER_COOKIE);
}

/**
 * The same, for the ceremony binder. A SEPARATE call rather than a fallback to
 * `sso_binder`: accepting either name would hand the pending-link routes back the
 * cookie a login round trip churns, which is exactly the coupling the second name
 * exists to remove — and would make a stale round-trip binder look like a valid
 * ceremony binding.
 */
export function readLinkBinderCookie(header: unknown): string | undefined {
  return readCookie(header, LINK_BINDER_COOKIE);
}

function readCookie(header: unknown, name: string): string | undefined {
  const raw = Array.isArray(header) ? header.join('; ') : header;
  if (typeof raw !== 'string' || !raw) return undefined;

  const values = new Set<string>();
  for (const segment of raw.split(';')) {
    const separator = segment.indexOf('=');
    if (separator <= 0) continue;
    // EXACT name match, so `sso_binder` and `sso_link_binder` can never be read
    // as one another however they are ordered in the header.
    if (segment.slice(0, separator).trim() !== name) continue;
    values.add(unquote(segment.slice(separator + 1).trim()));
  }

  if (values.size !== 1) return undefined;
  const [value] = values;
  // Shape-checked like every other opaque token here: a percent-encoded or
  // otherwise mangled value cannot be ours, so it is treated as absent.
  return isPlausibleToken(value) ? value : undefined;
}

function unquote(value: string): string {
  return value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value;
}

/**
 * Keep only a same-origin relative path (`/keys?tab=x`). Anything absolute,
 * protocol-relative (`//evil.tld`) or backslash-smuggled is dropped — the
 * callback redirects to `portalBaseUrl + returnTo`, so an unvalidated value here
 * is an open redirect that carries the login with it.
 */
export function sanitizeReturnTo(raw: string | undefined | null): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  if (!value || value.length > 512) return undefined;
  if (!value.startsWith('/')) return undefined;
  if (value.startsWith('//') || value.includes('\\')) return undefined;
  // Reject every C0 control character and DEL, not just CRLF. The URL parser
  // STRIPS these, so a raw TAB slipped through both the `//` and the `\` checks
  // and then resolved off-origin — `/<TAB>/evil.com` becomes `//evil.com` once
  // parsed. Anything the parser silently removes can smuggle an authority, so
  // the whole range goes rather than a list of the ones we thought of.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F]/.test(value)) return undefined;
  return value;
}

/**
 * Redis-backed, SINGLE-USE store for the OAuth round trip: CSRF state + PKCE
 * verifier on the way out, and the short-lived handoff code on the way back.
 *
 * WHY A HANDOFF CODE EXISTS AT ALL: the callback has a customer JWT and a
 * browser to hand it to. Putting the token in the redirect URL would write it to
 * stdout on the way out (the request logger in `main.ts` prints
 * `req.originalUrl` for EVERY response), into the browser's history, and into
 * the `Referer` of whatever the portal loads next — three durable copies of a
 * bearer credential. So the callback stores the token server-side, redirects
 * with an opaque 60-second single-use code, and the frontend exchanges that code
 * for the token in a response BODY. Do not "simplify" this into `?token=`.
 */
@Injectable()
export class OauthStateService implements OnModuleDestroy {
  private readonly logger = new Logger(OauthStateService.name);
  private readonly redis: Redis;

  constructor(@Inject(AppConfigService) config: AppConfigService) {
    // lazyConnect: the socket opens on the first command, so a boot with SSO
    // unused (and tests) never touches Redis. Mirrors MeteringService.
    this.redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null, lazyConnect: true });
    this.redis.on('error', (err) => this.logger.error(`OAuth state Redis error: ${err.message}`));
  }

  onModuleDestroy(): void {
    void this.redis.quit().catch(() => undefined);
  }

  /**
   * Mint a state + PKCE pair + browser binder, and store everything the callback
   * needs under the state. The PKCE verifier proves the CALLBACK reached the
   * server that started the flow; the binder proves it reached it from the same
   * BROWSER. Both are stored server-side — the verifier in full (it is spent
   * against the provider), the binder only as a hash.
   *
   * `linkCustomerId` turns this into a link round trip. It is stored here, in the
   * record the callback atomically consumes, so the "which account am I
   * attaching to" answer cannot be separated from (or outlive) its state.
   */
  async generate(args: {
    provider: string;
    returnTo?: string;
    linkCustomerId?: string;
  }): Promise<GeneratedOauthState> {
    const state = randomUrlToken();
    // 32 bytes → 43 base64url chars, inside RFC 7636's 43..128 range.
    const codeVerifier = randomUrlToken(32);
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const binder = randomUrlToken(32);

    const record: OauthStateRecord = {
      provider: args.provider,
      codeVerifier,
      returnTo: sanitizeReturnTo(args.returnTo),
      binderHash: hashBinder(binder),
      linkCustomerId: args.linkCustomerId,
    };
    await this.redis.set(`${STATE_PREFIX}${state}`, JSON.stringify(record), 'EX', STATE_TTL_SEC);

    return { state, codeVerifier, codeChallenge, binder };
  }

  /**
   * Redeem a state ONCE. Atomic: a replayed callback (back button, a copied URL,
   * a forged one racing the real one) finds the key already gone and gets null.
   * A plain GET-then-DEL is a race — two concurrent callbacks would both read
   * the verifier before either deleted it, which is exactly the CSRF replay the
   * state exists to stop.
   */
  async consume(state: string): Promise<OauthStateRecord | null> {
    if (!isPlausibleToken(state)) return null;
    const raw = await this.take(`${STATE_PREFIX}${state}`);
    const record = parseJson<OauthStateRecord>(raw);
    if (!record || typeof record.provider !== 'string' || typeof record.codeVerifier !== 'string') {
      return null;
    }
    // A record with no usable binder hash is unbindable, so it is unusable. This
    // FAILS CLOSED on purpose: it also rejects any state minted by a build from
    // before the binder existed, which costs those in-flight logins one retry
    // inside a 10-minute window and is the only way the check cannot be skipped
    // by replaying an old record.
    if (typeof record.binderHash !== 'string' || !BINDER_HASH_PATTERN.test(record.binderHash)) {
      return null;
    }
    // A link record whose target is not an ObjectId cannot be honoured, and
    // silently DROPPING the field would be worse than refusing: the callback
    // would read it as a plain login and resolve (or create) an account instead
    // of attaching to the one the customer asked for.
    if (record.linkCustomerId !== undefined && !OBJECT_ID_PATTERN.test(String(record.linkCustomerId))) {
      return null;
    }
    return record;
  }

  /** Store a completed login behind an opaque code. Returns the code. */
  async mintHandoff(record: OauthHandoffRecord): Promise<string> {
    const code = randomUrlToken();
    await this.redis.set(`${HANDOFF_PREFIX}${code}`, JSON.stringify(record), 'EX', HANDOFF_TTL_SEC);
    return code;
  }

  /** Redeem a handoff code ONCE — same atomicity requirement as `consume`. */
  async consumeHandoff(code: string): Promise<OauthHandoffRecord | null> {
    if (!isPlausibleToken(code)) return null;
    const raw = await this.take(`${HANDOFF_PREFIX}${code}`);
    const record = parseJson<OauthHandoffRecord>(raw);
    if (!record || typeof record.token !== 'string' || typeof record.customerId !== 'string') {
      return null;
    }
    // Same fail-closed rule as `consume`: no binder hash, no exchange. Without
    // this a code minted before the binder landed would be redeemable by anyone
    // who read it out of a log or a `Referer`.
    if (typeof record.binderHash !== 'string' || !BINDER_HASH_PATTERN.test(record.binderHash)) {
      return null;
    }
    return record;
  }

  /** Store a pending link behind an opaque token. Returns the token. */
  async mintPendingLink(record: OauthPendingLinkRecord): Promise<string> {
    const token = randomUrlToken();
    await this.redis.set(
      `${PENDING_LINK_PREFIX}${token}`,
      JSON.stringify(record),
      'EX',
      PENDING_LINK_TTL_SEC,
    );
    return token;
  }

  /**
   * PEEK — read a pending link WITHOUT consuming it.
   *
   * The describe route renders the ceremony page, and that page is loaded before
   * the customer has signed in, re-loaded after they come back from a second
   * provider round trip, and re-loaded again on any refresh. Consuming here would
   * burn the ceremony on the act of looking at it.
   */
  async readPendingLink(token: string): Promise<OauthPendingLinkRecord | null> {
    if (!isPlausibleToken(token)) return null;
    return parsePendingLink(await this.redis.get(`${PENDING_LINK_PREFIX}${token}`));
  }

  /** Redeem a pending link ONCE — same atomicity requirement as `consume`. */
  async consumePendingLink(token: string): Promise<OauthPendingLinkRecord | null> {
    if (!isPlausibleToken(token)) return null;
    return parsePendingLink(await this.take(`${PENDING_LINK_PREFIX}${token}`));
  }

  /**
   * Read-and-delete in one round trip. `GETDEL` needs Redis ≥ 6.2; on an older
   * server we fall back to a `MULTI`, which is still atomic (the pair executes
   * as one unit, nothing interleaves) — unlike a sequential GET then DEL.
   */
  private async take(key: string): Promise<string | null> {
    try {
      return await this.redis.getdel(key);
    } catch (error) {
      this.logger.warn(`GETDEL unavailable (${(error as Error).message}) — falling back to MULTI`);
      const results = await this.redis.multi().get(key).del(key).exec();
      const first = results?.[0];
      if (!first || first[0]) return null;
      return typeof first[1] === 'string' ? first[1] : null;
    }
  }
}

/** base64url shape + length cap. Rejects garbage before it becomes a Redis key. */
function isPlausibleToken(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_OPAQUE_TOKEN_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

/** 24 hex characters — a Mongo ObjectId as a string. */
const OBJECT_ID_PATTERN = /^[a-f0-9]{24}$/i;

/**
 * Validate a stored pending link. EVERY field is checked, and every failure is
 * the same `null`, because the routes turn that into one generic 404.
 *
 * FAIL CLOSED on `emailVerified !== true` and on a target that is not an
 * ObjectId: this build only ever writes a provider-VERIFIED collision against a
 * real customer id, so a record saying otherwise was not written by this build
 * (or was tampered with), and the one thing it must not do is get honoured.
 * `emailVerified` in particular is the gate that keeps the ceremony off
 * attacker-typed addresses — an unverified provider email must stay a plain
 * refusal, not a "sign in to connect" prompt on our own domain.
 */
function parsePendingLink(raw: string | null): OauthPendingLinkRecord | null {
  const record = parseJson<OauthPendingLinkRecord>(raw);
  if (!record) return null;
  if (!isNonEmptyString(record.provider)) return null;
  if (!isNonEmptyString(record.subject)) return null;
  if (!isNonEmptyString(record.email)) return null;
  if (record.emailVerified !== true) return null;
  if (!isNonEmptyString(record.targetCustomerId) || !OBJECT_ID_PATTERN.test(record.targetCustomerId)) {
    return null;
  }
  if (typeof record.binderHash !== 'string' || !BINDER_HASH_PATTERN.test(record.binderHash)) return null;
  return record;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
