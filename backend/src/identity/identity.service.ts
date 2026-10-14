import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { LimiterFactory, MEMORY_LIMITER_FACTORY, type AuthLimiter } from '../common/limiter-factory.js';
import { Model, Types } from 'mongoose';
import { CUSTOMER_JWT } from '../auth/customer-jwt.tokens.js';
import { Customer } from '../billing/customer.schema.js';
import { DEFAULT_PLAN_KEY } from '../billing/plans.seed.js';
import { AppConfigService } from '../config/app-config.service.js';
import {
  CUSTOMER_TOKEN_TYPE,
  toPublicCustomer,
  type CustomerAuthResult,
  type CustomerJwtPayload,
  type PublicCustomer,
} from '../portal/customer-auth.service.js';
import { Identity, type IdentityProvider } from './identity.schema.js';
import {
  binderMatches,
  buildBinderCookie,
  buildLinkBinderCookie,
  clearBinderCookie,
  clearLinkBinderCookie,
  OauthStateService,
  sanitizeReturnTo,
  type OauthPendingLinkRecord,
} from './oauth-state.service.js';
import type { OauthProfile } from './oauth/oauth-provider.interface.js';
import { OauthProviderRegistry } from './oauth/oauth-provider.registry.js';
import { SiweService } from './siwe.service.js';

/**
 * Limiter namespace. DISTINCT from `CustomerAuthService`'s `customer:` realm so
 * an SSO flood can neither drain nor lock out the password login (10/5min),
 * signup (5/hr) or resend (5/hr) budgets for the same visitor.
 */
const LIMITER_REALM = 'sso';

/** Longest provider-reported email we will put anywhere near the unique index. */
const MAX_EMAIL_LENGTH = 200;

/**
 * The one refusal copy for a colliding address, shared by rule (c) and by the
 * ceremony's fallback so the two cannot drift into telling a customer different
 * stories about the same situation.
 */
const EMAIL_IN_USE_MESSAGE =
  'An account already uses that email address. Sign in with your existing method, then link this provider from Settings.';

/**
 * The single answer for an unknown, expired, already-used or wrong-browser
 * pending link. ONE message on purpose: distinguishing them would tell whoever
 * holds a copied token whether it is still live, and whether the browser is the
 * only thing missing.
 */
function pendingLinkGone(): NotFoundException {
  return new NotFoundException({
    error: 'That link has expired or is no longer valid. Sign in again to connect this provider.',
  });
}

/** What the portal renders as a sign-in button. Carries no secret. */
export interface AuthProviderDescriptor {
  id: string;
  label: string;
  /** `oauth` = browser redirect handshake; `wallet` = local signature. */
  kind: 'oauth' | 'wallet';
  enabled: boolean;
}

/** A linked sign-in method, as the portal shows it. NEVER carries `customerId`. */
export interface PublicIdentity {
  id: string;
  provider: IdentityProvider;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  linkedAt: string | null;
  lastLoginAt: string | null;
}

export interface IdentityListResult {
  identities: PublicIdentity[];
  /** false = SSO is the only way in, so the last identity must not be unlinked. */
  hasPassword: boolean;
}

/** The normalized provider assertion the linking rules operate on. */
export interface ResolveLoginArgs {
  provider: IdentityProvider;
  /** Provider-stable id (Google `sub`, GitHub numeric id, lowercased address). */
  subject: string;
  email?: string;
  /** Whether THE PROVIDER asserted the address — the single linking input. */
  emailVerified: boolean;
  displayName?: string;
}

export interface ResolvedLogin {
  customer: PublicCustomer;
  /** True when this login CREATED the account (drives onboarding copy). */
  isNewCustomer: boolean;
}

/** Everything a pending link needs to remember about the refused login. */
export interface PendingLinkAssertion {
  /** 24-hex id of the customer that already holds `email`. */
  targetCustomerId: string;
  provider: IdentityProvider;
  subject: string;
  email: string;
  /** Always true — the ceremony is offered for a provider-VERIFIED address only. */
  emailVerified: true;
  displayName?: string;
}

/**
 * Rule (c) refined: the collision can be RESOLVED by the human, so say so
 * instead of dead-ending.
 *
 * It extends `ConflictException` deliberately. The ceremony is a refinement of
 * the 409 refusal, not a different verdict, so any caller that does not know
 * about this type degrades to EXACTLY the previous behaviour — the same 409 body
 * over HTTP, the same `email_in_use` slug out of `loginFailureSlug` — rather than
 * to a 500 or, far worse, to a silent success.
 */
export class PendingLinkRequiredError extends ConflictException {
  constructor(readonly assertion: PendingLinkAssertion) {
    super({ error: EMAIL_IN_USE_MESSAGE });
  }
}

/**
 * What the ceremony page is allowed to know before anybody has signed in. The
 * address is MASKED and comes from the server-side record — never from a query
 * parameter, or a crafted URL would render a lure for an arbitrary address on our
 * own domain.
 */
export interface PendingLinkDescriptor {
  provider: string;
  providerLabel: string;
  /** `k•••@gmail.com`. Enough to recognise your own address, not to learn one. */
  maskedEmail: string;
  /**
   * HOW THE TARGET ACCOUNT CAN ACTUALLY BE SIGNED IN TO — the allow-list the
   * ceremony page renders, and the difference between an instruction and a maze.
   *
   * Without it the page could only say "sign in to connect", and it offered every
   * OTHER configured provider as the way to do it. Every one of those re-enters
   * `resolveLogin`, collides on the same address, and mints a FRESH ceremony —
   * so pressing them flips the heading between providers forever. Reported live:
   * Google → GitHub → Google, with no error anywhere, because each lap is
   * internally perfect.
   *
   * `providers` therefore lists ONLY identities already attached to the target,
   * i.e. the ones that reach rule (a) and log the caller in. `password` says
   * whether the email + password form can work at all. Both can be false — an
   * account whose only identity is the provider now colliding — and the page has
   * to say so rather than offer nothing and look broken.
   *
   * DISCLOSURE, deliberately: this is the same class as `maskedEmail`, and safe
   * for the same reason. The token exists only because a provider VERIFIED
   * control of that mailbox, and reading it additionally requires this browser's
   * `sso_link_binder` — so the viewer has already authenticated as the address
   * whose sign-in methods are being named. What it must never carry is anything
   * about a DIFFERENT account, and it cannot: every field is read from
   * `targetCustomerId`, which is fixed inside the token.
   */
  signInMethods: {
    /** The email + password form can sign this account in. */
    password: boolean;
    /** Providers ALREADY linked — the only ones that can complete the ceremony. */
    providers: Array<{ id: string; label: string }>;
  };
}

/**
 * What a `start` route hands back. The `authorizeUrl` is the response BODY; the
 * `binderCookie` is a `Set-Cookie` HEADER and must never be merged into the body
 * — the binder is HttpOnly precisely so that no script, ours included, can read
 * it. The controller is the only thing that ever touches this field.
 */
export interface OauthStartResult {
  authorizeUrl: string;
  binderCookie: string;
}

/**
 * Where the provider's callback sends the browser, and the cookie (if any) that
 * has to travel with the redirect.
 *
 * The cookie is here rather than left to the controller because only this service
 * knows WHICH outcome happened: the ceremony branch has to plant the pending
 * link's own binder on the very response that carries the token, and a controller
 * that had to infer that from the URL would be one route rename away from silently
 * not planting it.
 */
export interface OauthCallbackRedirect {
  url: string;
  /** A `Set-Cookie` header value, or nothing to set. */
  setCookie?: string;
}

/** Error slugs the callback may put in the redirect. Short, non-descriptive. */
type CallbackErrorSlug =
  | 'access_denied'
  | 'invalid_state'
  | 'expired_state'
  | 'provider_error'
  | 'email_in_use'
  | 'already_linked'
  | 'account_suspended'
  | 'server_error';

/**
 * Internal failure carrying the slug the browser is redirected with. The
 * `detail` never reaches the user — it is logged server-side, because a
 * provider's own error text is not ours to render and can carry the code back.
 */
class CallbackFailure extends Error {
  constructor(
    readonly slug: CallbackErrorSlug,
    detail: string,
  ) {
    super(detail);
  }
}

/** The lean customer columns this service reads. */
interface CustomerRow {
  _id: unknown;
  email?: string;
  /** A claimed-but-unproved address. Read only by the ceremony's stamp step. */
  pendingEmail?: string;
  planKey: string;
  emailVerifiedAt?: Date;
  status: 'active' | 'suspended';
  /** Only present when the query asked for it (`select: false` on the schema). */
  passwordHash?: string;
}

/** The lean identity columns this service reads. */
interface IdentityRow {
  _id: unknown;
  customerId: unknown;
  provider: IdentityProvider;
  subject: string;
  email?: string;
  emailVerified?: boolean;
  displayName?: string;
  linkedAt?: Date;
  lastLoginAt?: Date;
}

/**
 * Customer SSO: OAuth (Google/GitHub) and wallet (SIWE) sign-in, plus the
 * connected-accounts management the portal shows.
 *
 * IT MINTS THE SAME TOKEN AS A PASSWORD LOGIN — the `CUSTOMER_JWT` signer and
 * `typ: 'customer'` — so `CustomerJwtGuard`, metering, ownership and every
 * `/account/*` route need no knowledge that SSO exists. An SSO session is a
 * customer session; there is no second realm here.
 *
 * The account-resolution rules in `resolveLogin` are the security core of the
 * feature. Read that method's comment before changing anything in this file.
 */
@Injectable()
export class IdentityService {
  private readonly logger = new Logger(IdentityService.name);

  /**
   * Three budgets, all per client IP, all in their own `sso:` namespace.
   *
   * `oauth:start` is generous but present: each call writes a 10-minute Redis
   * key, so an unbounded route is a memory-growth primitive with no credentials.
   * The wallet pair is tighter — `nonce` writes a key per call and `verify` runs
   * a secp256k1 recovery, and neither is a route an honest visitor hits in bulk.
   */
  private readonly oauthStartLimiter: AuthLimiter;
  private readonly walletNonceLimiter: AuthLimiter;
  private readonly walletVerifyLimiter: AuthLimiter;

  constructor(
    @InjectModel(Identity.name) private readonly identities: Model<Identity>,
    @InjectModel(Customer.name) private readonly customers: Model<Customer>,
    @Inject(CUSTOMER_JWT) private readonly jwt: JwtService,
    @Inject(AppConfigService) private readonly config: AppConfigService,
    @Inject(OauthProviderRegistry) private readonly providers: OauthProviderRegistry,
    @Inject(OauthStateService) private readonly state: OauthStateService,
    @Inject(SiweService) private readonly siwe: SiweService,
    /**
     * APPENDED and optional (P2.2 §3.1): where the limiters above keep their
     * counters. Absent, or `AUTH_LIMITER_STORE=memory`, today's per-process
     * `RateLimiterMemory` with the same points and duration.
     */
    @Optional() @Inject(LimiterFactory) limiterFactory?: LimiterFactory,
  ) {
    const limiters = limiterFactory ?? MEMORY_LIMITER_FACTORY;
    this.oauthStartLimiter = limiters.create(LIMITER_REALM, 'oauthStart', { points: 60, duration: 300 });
    this.walletNonceLimiter = limiters.create(LIMITER_REALM, 'walletNonce', { points: 20, duration: 300 });
    this.walletVerifyLimiter = limiters.create(LIMITER_REALM, 'walletVerify', { points: 20, duration: 300 });
  }

  // ─── public catalogue ──────────────────────────────────────────────────────

  /**
   * The sign-in methods this deployment actually has. PUBLIC and unauthenticated
   * — it names no secret and no account.
   *
   * Only CONFIGURED providers appear, from the same source of truth the callback
   * accepts (`AppConfigService.configuredOauthProviders`), so the portal can
   * never render a button that 404s on click.
   */
  listProviders(): { providers: AuthProviderDescriptor[] } {
    const providers: AuthProviderDescriptor[] = this.providers
      .describe()
      .map((provider) => ({ id: provider.id, label: provider.label, kind: 'oauth', enabled: true }));
    // `id: 'wallet'` matches `IdentityProvider`, which is what lets the portal
    // match a linked identity row against this catalogue entry.
    if (this.siwe.isEnabled()) {
      providers.push({ id: 'wallet', label: 'Wallet', kind: 'wallet', enabled: true });
    }
    return { providers };
  }

  // ─── OAuth: start ─────────────────────────────────────────────────────────

  /**
   * Begin a SIGNED-OUT OAuth login. Returns the provider URL to send the browser
   * to, PLUS the `Set-Cookie` that binds the round trip to this browser — the
   * caller must send both or the callback will (correctly) refuse the login.
   */
  async startOauth(
    providerId: string,
    returnTo: string | undefined,
    clientIp?: string,
  ): Promise<OauthStartResult> {
    // Unknown OR unconfigured both 404 here (see `OauthProviderRegistry.resolve`).
    const provider = this.providers.resolve(providerId);
    // Charged BEFORE the Redis write, so the budget caps the work rather than
    // being spent after it.
    await this.throttle(
      this.oauthStartLimiter,
      this.limiterKey('oauth:start', clientIp, provider.id),
      'Too many sign-in attempts. Try again in a few minutes.',
    );
    const generated = await this.state.generate({ provider: provider.id, returnTo });
    return {
      authorizeUrl: provider.buildAuthorizeUrl({
        state: generated.state,
        codeChallenge: generated.codeChallenge,
        redirectUri: this.redirectUriFor(provider.id),
      }),
      binderCookie: this.binderCookie(generated.binder),
    };
  }

  /**
   * Begin an OAuth round trip that will ATTACH to the caller's existing account
   * instead of resolving one. Same provider handshake, same callback URL (the
   * `redirect_uri` must byte-match what is registered with the provider), so the
   * intent is what the callback reads to tell the two flows apart.
   *
   * THE INTENT LIVES IN THE STATE RECORD. It used to be a second Redis key keyed
   * by the state, which meant the "attach to account X" fact could in principle
   * be present without its state or vice versa; now one atomic `GETDEL` returns
   * the provider, the PKCE verifier, the binder hash and the target customer
   * together, or returns nothing at all.
   *
   * The binder is what stops the FORCED-LINK attack: without it an attacker can
   * request this URL for their OWN account and hand it to a victim, whose
   * provider identity then attaches permanently to the attacker's tenant.
   */
  async startIdentityLink(
    customerId: string,
    providerId: string,
    returnTo?: string,
  ): Promise<OauthStartResult> {
    const provider = this.providers.resolve(providerId);
    // Normalized here so a malformed id is a clean 404 on THIS call rather than
    // an unusable state record that only fails at the far end of the round trip.
    const owner = parseObjectId(customerId, 'Account not found').toHexString();
    await this.throttle(
      this.oauthStartLimiter,
      `${LIMITER_REALM}:oauth:link:${owner}`,
      'Too many linking attempts. Try again in a few minutes.',
    );
    const generated = await this.state.generate({
      provider: provider.id,
      returnTo,
      linkCustomerId: owner,
    });
    return {
      authorizeUrl: provider.buildAuthorizeUrl({
        state: generated.state,
        codeChallenge: generated.codeChallenge,
        redirectUri: this.redirectUriFor(provider.id),
      }),
      binderCookie: this.binderCookie(generated.binder),
    };
  }

  // ─── OAuth: callback ──────────────────────────────────────────────────────

  /**
   * THE route the provider talks to. Always resolves to a portal URL and NEVER
   * throws: a thrown exception here would render a JSON error page at the end of
   * a browser redirect chain.
   *
   * The redirect carries a provider slug and either an opaque single-use handoff
   * code or a short error slug — never the authorization code, never the state,
   * never the token. `main.ts` logs `req.originalUrl` for every response, and a
   * redirect URL also lands in browser history and in the next request's
   * `Referer`; all three are durable copies of whatever is in it.
   */
  async completeOauthCallback(args: {
    provider: string;
    code?: string;
    state?: string;
    providerError?: string;
    /** Raw binder cookie as the browser presented it, or `undefined`. */
    binder?: string;
  }): Promise<OauthCallbackRedirect> {
    const slug = safeSlug(args.provider);
    try {
      const outcome = await this.runOauthCallback(args);
      // A collision that the human can resolve is not an error page: it goes to
      // the portal's ceremony route with an opaque token and NOTHING else — no
      // address, no account id, no error slug.
      //
      // The ceremony's binder cookie rides on THIS response, alongside the token
      // it binds. Same browser, same instant, one round trip — and from here on
      // the ceremony is independent of `sso_binder`, which the sign-in it is
      // about to ask for will overwrite and then delete.
      return outcome.kind === 'pending-link'
        ? {
            url: this.portalLinkAccountUrl(slug, outcome.token),
            setCookie: this.linkBinderCookie(outcome.binder),
          }
        : { url: this.portalCallbackUrl(slug, { code: outcome.code, returnTo: outcome.returnTo }) };
    } catch (error) {
      const failure =
        error instanceof CallbackFailure
          ? error
          : new CallbackFailure('server_error', errorMessage(error));
      // Server-side only. The user gets the slug.
      this.logger.warn(`SSO callback for '${slug}' failed [${failure.slug}]: ${failure.message}`);
      return { url: this.portalCallbackUrl(slug, { error: failure.slug }) };
    }
  }

  /**
   * The callback's happy path. Throws `CallbackFailure` for every refusal.
   *
   * Two successful shapes: a `session` (the handoff code) and a `pending-link`
   * (a resolvable email collision — see `resolveLogin` rules (b)/(c)).
   */
  private async runOauthCallback(args: {
    provider: string;
    code?: string;
    state?: string;
    providerError?: string;
    binder?: string;
  }): Promise<
    | { kind: 'session'; code: string; returnTo?: string }
    /** `binder` is the RAW cookie value, re-planted under the ceremony's name. */
    | { kind: 'pending-link'; token: string; binder: string }
  > {
    // The provider refused before an authorization code ever existed — nearly
    // always the person declining the consent screen.
    if (args.providerError) {
      const reported = safeSlug(args.providerError);
      throw new CallbackFailure(
        reported === 'access_denied' ? 'access_denied' : 'provider_error',
        `provider reported '${reported}'`,
      );
    }
    if (!this.providers.has(args.provider)) {
      throw new CallbackFailure('provider_error', 'callback named an unknown or unconfigured provider');
    }
    const provider = this.providers.resolve(args.provider);

    const state = typeof args.state === 'string' ? args.state : '';
    if (!state) throw new CallbackFailure('invalid_state', 'callback carried no state');

    // ATOMIC single-use. A replay — back button, a copied URL, a forged callback
    // racing the real one — finds the key gone and stops here.
    const record = await this.state.consume(state);
    if (!record) {
      throw new CallbackFailure('expired_state', 'state was unknown, expired or already used');
    }
    // The state proves the flow started here; this proves it started for THIS
    // provider, so a state minted for one provider cannot be replayed into the
    // callback of another (whose profile trust rules differ).
    if (record.provider !== provider.id) {
      throw new CallbackFailure('invalid_state', 'state was issued for a different provider');
    }

    // THE BROWSER BINDER. The state proves a flow started here; this proves it
    // started in the browser now finishing it. Absent and mismatched are the
    // same refusal, deliberately — and both arrive at a redirect with a slug
    // rather than an exception body, because this is the end of a browser
    // redirect chain and a JSON 4xx is not a page anyone can act on.
    //
    // Checked AFTER the state is consumed, which is the right order: a forced
    // callback burns the state it carried, so an attacker cannot keep retrying
    // one state until a victim's browser happens to present a cookie.
    if (!binderMatches(record.binderHash, args.binder)) {
      throw new CallbackFailure(
        'invalid_state',
        'binder cookie was absent or did not match the state that was issued',
      );
    }

    // The link target travelled INSIDE the record, so it was covered by the same
    // atomic single-use consume as everything else above.
    const linkCustomerId = record.linkCustomerId;

    const code = typeof args.code === 'string' ? args.code.trim() : '';
    if (!code) throw new CallbackFailure('provider_error', 'callback carried no authorization code');

    let profile: OauthProfile;
    try {
      const tokens = await provider.exchangeCode({
        code,
        codeVerifier: record.codeVerifier,
        redirectUri: this.redirectUriFor(provider.id),
      });
      profile = await provider.fetchProfile(tokens);
    } catch (error) {
      throw new CallbackFailure('provider_error', `exchange/profile failed: ${errorMessage(error)}`);
    }

    const assertion: ResolveLoginArgs = {
      provider: provider.id,
      subject: profile.subject,
      email: profile.email,
      emailVerified: profile.emailVerified,
      displayName: profile.displayName,
    };

    let login: ResolvedLogin;
    if (linkCustomerId) {
      try {
        await this.linkIdentity(linkCustomerId, assertion);
        // The customer is already signed in; a fresh token for the SAME account
        // keeps the portal on one code path (its callback page always exchanges).
        login = { customer: await this.publicCustomerById(linkCustomerId), isNewCustomer: false };
      } catch (error) {
        throw new CallbackFailure(linkFailureSlug(error), `link failed: ${errorMessage(error)}`);
      }
    } else {
      try {
        login = await this.resolveLogin(assertion);
      } catch (error) {
        // The collision is resolvable: mint the ceremony token instead of a slug.
        // It inherits THIS round trip's binder hash, so the browser that reached
        // the provider is the only one that can finish what the provider started.
        if (error instanceof PendingLinkRequiredError) {
          const token = await this.state.mintPendingLink({
            ...error.assertion,
            binderHash: record.binderHash,
            returnTo: record.returnTo,
          });
          // `args.binder` is a string here — `binderMatches` above returned true,
          // which is exactly the assertion that it is well-formed and correct.
          return { kind: 'pending-link', token, binder: args.binder };
        }
        throw new CallbackFailure(loginFailureSlug(error), `login failed: ${errorMessage(error)}`);
      }
    }

    const token = await this.sign(login.customer);
    const handoff = await this.state.mintHandoff({
      token,
      customerId: login.customer.id,
      provider: provider.id,
      isNewCustomer: login.isNewCustomer,
      returnTo: record.returnTo,
      // The SAME binder guards the second leg. The code below is about to be put
      // in a redirect URL — i.e. into browser history, the portal's `Referer`
      // and this service's access log — so holding a copy of it must not be
      // enough to redeem the session.
      binderHash: record.binderHash,
    });
    return { kind: 'session', code: handoff, returnTo: record.returnTo };
  }

  /**
   * Trade a single-use handoff code for the session it stands for. The token
   * crosses the wire in a RESPONSE BODY here, which is the entire reason the
   * handoff code exists.
   *
   * TWO factors, and both are required: the code (single-use, 60 seconds, from
   * the redirect) and the binder cookie (HttpOnly, from the browser that started
   * the flow). The code alone is not enough BECAUSE of where it has been —
   * `main.ts` logs `req.originalUrl` on every response, and the portal's next
   * request carries the callback URL in `Referer`.
   *
   * Both failures answer with the SAME message. A distinct "wrong browser" error
   * would confirm to a code thief that the code itself was good.
   */
  async exchangeHandoff(code: string, binder?: string): Promise<CustomerAuthResult> {
    const record = await this.state.consumeHandoff(code);
    if (!record || !binderMatches(record.binderHash, binder)) {
      throw new UnauthorizedException({
        error: 'That sign-in link has expired or was already used. Please sign in again.',
      });
    }
    // Re-read the account rather than trusting the minute-old snapshot: it may
    // have been suspended since, and the portal wants the current plan anyway.
    const customer = await this.publicCustomerById(record.customerId);
    return { token: record.token, customer };
  }

  /** The `Set-Cookie` header value that ends a completed round trip's binder. */
  expiredBinderCookie(): string {
    return clearBinderCookie(this.config.isProduction);
  }

  /**
   * The same, for the ceremony binder. A DISTINCT cookie name, so clearing one
   * never cancels the other — which is the whole reason the ceremony has its own.
   */
  expiredLinkBinderCookie(): string {
    return clearLinkBinderCookie(this.config.isProduction);
  }

  // ─── the pending-link ceremony ────────────────────────────────────────────

  /**
   * What the `/link-account` page renders, for a visitor who is not signed in
   * yet. UNAUTHENTICATED by necessity — signing in is the whole point of the
   * page — so the binder cookie is the only thing standing between a copied
   * token and a description of somebody's account.
   *
   * PEEKS. The page is loaded before the sign-in, again after a second provider
   * round trip, and again on every refresh; consuming here would burn the
   * ceremony on the act of looking at it. `binder` is the CEREMONY cookie
   * (`sso_link_binder`), which is what survives that second round trip.
   *
   * Unknown, expired and wrong-browser are ONE 404 — see `pendingLinkGone`.
   */
  async describePendingLink(token: string | undefined, binder?: string): Promise<PendingLinkDescriptor> {
    const record = typeof token === 'string' ? await this.state.readPendingLink(token) : null;
    if (!record || !binderMatches(record.binderHash, binder)) throw pendingLinkGone();
    return {
      provider: record.provider,
      providerLabel: this.providerLabel(record.provider),
      maskedEmail: maskEmail(record.email),
      signInMethods: await this.targetSignInMethods(record.targetCustomerId, record.provider),
    };
  }

  /**
   * What the ceremony's target account can be signed in with — see
   * `PendingLinkDescriptor.signInMethods` for why this is published at all.
   *
   * Read entirely from `targetCustomerId`, which is fixed inside the token, so it
   * can never describe an account the caller did not already prove control of the
   * mailbox for.
   *
   * `passwordHash` is `select: false`, so it is asked for EXPLICITLY (the same
   * trap `login` documents) — without the `+` the field comes back undefined and
   * every account looks password-less, which would hide the one form that works.
   *
   * The COLLIDING provider is excluded even on the vanishing chance an identity
   * row for it exists: if it did, rule (a) would have logged the caller straight
   * in and there would be no ceremony, so offering it can only restart the loop.
   */
  private async targetSignInMethods(
    targetCustomerId: string,
    collidingProvider: string,
  ): Promise<PendingLinkDescriptor['signInMethods']> {
    const id = toObjectId(targetCustomerId);
    const [customer, rows] = await Promise.all([
      this.customers.findById(id).select('+passwordHash').lean().exec() as Promise<
        (CustomerRow & { passwordHash?: string }) | null
      >,
      this.identities.find({ customerId: id }).sort({ linkedAt: 1 }).lean().exec() as Promise<
        IdentityRow[]
      >,
    ]);
    const seen = new Set<string>();
    const providers: Array<{ id: string; label: string }> = [];
    for (const row of rows ?? []) {
      const provider = String(row.provider);
      if (provider === collidingProvider || seen.has(provider)) continue;
      seen.add(provider);
      providers.push({ id: provider, label: this.providerLabel(provider) });
    }
    return { password: Boolean(customer?.passwordHash), providers };
  }

  /**
   * Finish the ceremony: attach the provider account to the customer the
   * collision was ON, now that its owner has authenticated.
   *
   * THE ORDER IS THE DESIGN:
   *  (a) CONSUME the token first — same discipline as the SIWE nonce, which is
   *      spent before the signature is checked. A failed attempt burns the
   *      challenge, so a wrong-browser or wrong-account attempt cannot be
   *      retried until it lands.
   *  (b) the CEREMONY binder must match, because the token has been in a URL.
   *      Deliberately not `sso_binder`: the sign-in this route waits for may
   *      itself be an OAuth round trip, which overwrites and then deletes that
   *      cookie — see `LINK_BINDER_COOKIE`.
   *  (c) the caller must BE the target account. This is the whole authorization:
   *      the link can only ever land on the customer that already held the
   *      colliding address, so no signed-in customer can attach a provider
   *      identity to anyone else — and no crafted token can redirect one.
   *  (d) that customer must still be active, and (e) the unique
   *      `{provider, subject}` index still has the final word (`linkIdentity`).
   */
  async completePendingLink(args: {
    customerId: string;
    token: string;
    binder?: string;
  }): Promise<{ ok: true; provider: IdentityProvider }> {
    // PEEK first, and consume only once this caller is known to be the right
    // one. The reverse — burning the token on any attempt, the way the SIWE
    // nonce is consumed before its signature check — is wrong HERE, and the
    // difference is what the failing attempt represents. A bad SIWE signature is
    // a guess against a secret, so the challenge must not survive it. Landing
    // here signed in to the wrong account is not a guess: the caller already
    // presented a valid binder and a valid session, and the link can only ever
    // reach `targetCustomerId` however many times it is offered. So a wrong
    // account proves nothing to an attacker and destroys the link for the
    // legitimate owner — who, having no way to reissue it, must repeat the whole
    // provider round trip. Observed exactly that: a 403 for the wrong account
    // left the real owner with a 404 one request later.
    const record = await this.state.readPendingLink(args.token);
    if (!record || !binderMatches(record.binderHash, args.binder)) throw pendingLinkGone();

    // Both sides are hex ids; compare them as such rather than trusting either
    // side's casing. A mismatch is 403 and NOT 404: the token is still good, and
    // the customer needs to be told to switch accounts — signing in to the right
    // one and returning completes the SAME ceremony. It deliberately does not
    // echo the target address back — they have not proved they own it.
    if (args.customerId.toLowerCase() !== record.targetCustomerId.toLowerCase()) {
      throw new ForbiddenException({
        error:
          'You are signed in to a different account. Sign in to the account that already uses that email address, then open this link again.',
      });
    }

    // NOW spend it, atomically, immediately before the write. `GETDEL` is what
    // makes single-use hold: two concurrent completions race here and exactly
    // one gets a record, so the loser is told the link is gone rather than both
    // proceeding to a duplicate-key error.
    const spent = await this.state.consumePendingLink(args.token);
    if (!spent) throw pendingLinkGone();

    const provider = record.provider as IdentityProvider;
    await this.linkIdentity(record.targetCustomerId, {
      provider,
      subject: record.subject,
      email: record.email,
      emailVerified: record.emailVerified,
      displayName: record.displayName,
    });
    await this.stampCeremonyVerification(record);
    return { ok: true, provider };
  }

  /**
   * Stamp `emailVerifiedAt` when the ceremony has just proved BOTH halves of
   * rule (b) — in sequence rather than simultaneously.
   *
   * THE ARGUMENT. Rule (b) links silently when the provider asserted the address
   * AND we had already verified the holder. Here the provider asserted the
   * address, and then a human AUTHENTICATED into the account that holds it. That
   * is the same two proofs, from the same two authorities, in a different order —
   * and the takeover rule (b) defends against does not reach it: an attacker who
   * pre-registered `victim@corp.com` can sign into their own squatted account,
   * but they cannot produce this record, because minting it required a
   * provider-verified login as the victim's address. Whoever completes the
   * ceremony has demonstrated control of the mailbox AND of the account.
   *
   * THE CONSEQUENCE, stated rather than discovered later: this makes the NEXT
   * provider carrying the same verified address auto-link via rule (b). That is
   * the intended semantic — it is precisely the state "both sides proved control"
   * is supposed to record — and it also unblocks the portal for a customer who
   * never verified by OTP (`CustomerJwtGuard`'s verification gate reads the same
   * field), which is why the completion route carries `@AllowUnverified()`.
   *
   * NARROW BY CONSTRUCTION: only when the provider verified the address, only
   * when it still equals the customer's CURRENT `email` (both normalized — a
   * profile edit could have moved it since the callback), and only when nothing
   * has verified it already.
   */
  private async stampCeremonyVerification(record: OauthPendingLinkRecord): Promise<void> {
    if (record.emailVerified !== true) return;
    try {
      const customer = (await this.customers
        .findById(record.targetCustomerId)
        .lean()
        .exec()) as CustomerRow | null;
      if (!customer || customer.emailVerifiedAt) return;
      if (normalizeEmail(customer.email) !== record.email) return;

      const update: Record<string, unknown> = { $set: { emailVerifiedAt: new Date() } };
      // The same address, staged and waiting for a code: the claim has just been
      // proved by a stronger route, so it and its outstanding code go together.
      // A DIFFERENT pending address is somebody's live claim and is left alone.
      if (normalizeEmail(customer.pendingEmail) === record.email) {
        update.$unset = {
          pendingEmail: '',
          emailVerificationTokenHash: '',
          emailVerificationExpiresAt: '',
        };
      }
      await this.customers.updateOne({ _id: customer._id }, update).exec();
    } catch (error) {
      // The LINK is what the customer asked for and it has already happened; the
      // stamp is a derived convenience. Failing the request here would report a
      // failure for work that succeeded, and the token is spent so they could not
      // retry — they can still verify by OTP.
      this.logger.warn(
        `Pending link completed but verification stamp failed for ${record.targetCustomerId}: ${errorMessage(error)}`,
      );
    }
  }

  // ─── wallet (SIWE) ────────────────────────────────────────────────────────

  /** Issue a wallet challenge. The message is composed and stored server-side. */
  async walletNonce(address: string, clientIp?: string): Promise<{ nonce: string; message: string }> {
    await this.throttle(
      this.walletNonceLimiter,
      this.limiterKey('wallet:nonce', clientIp, String(address).toLowerCase()),
      'Too many wallet sign-in attempts. Try again in a few minutes.',
    );
    const challenge = await this.siwe.createChallenge({ address });
    return { nonce: challenge.nonce, message: challenge.message };
  }

  /**
   * Verify a wallet signature and hand back a customer session.
   *
   * A wallet carries NO email, so only rules (a) and (d) of `resolveLogin` can
   * ever apply — a wallet never auto-links to an existing account.
   */
  async walletVerify(nonce: string, signature: string, clientIp?: string): Promise<CustomerAuthResult> {
    await this.throttle(
      this.walletVerifyLimiter,
      this.limiterKey('wallet:verify', clientIp, nonce),
      'Too many wallet sign-in attempts. Try again in a few minutes.',
    );
    const verified = await this.siwe.verify({ nonce, signature });
    const login = await this.resolveLogin({
      provider: 'wallet',
      // Lowercased — the canonical `Identity.subject` for a wallet.
      subject: verified.address,
      emailVerified: false,
      displayName: verified.checksumAddress,
    });
    return { token: await this.sign(login.customer), customer: login.customer };
  }

  // ─── THE LINKING RULES ────────────────────────────────────────────────────

  /**
   * Resolve a provider assertion to a customer session. THE security core.
   *
   *  (a) `{provider, subject}` already exists → log in as its customer. The
   *      common path.
   *  (b) no identity, email VERIFIED by the provider, and a customer holds that
   *      address → link and log in. This is what makes "sign in with Google"
   *      land on the account you signed up for with a password.
   *  (c) no identity, a customer holds that address, and (b) did not fire →
   *      REFUSE. Never link, never create a second account on that address.
   *      THIS IS THE ACCOUNT-TAKEOVER DEFENCE: a provider that lets a user type
   *      an arbitrary address (GitHub's public profile field is exactly that)
   *      would otherwise hand over somebody else's account, API keys and usage
   *      history for the cost of one profile edit. Two shapes of refusal:
   *      `PendingLinkRequiredError` when the PROVIDER verified the address and
   *      the holder is active (the human can resolve it by signing in — see the
   *      fork below), and a plain 409 otherwise.
   *  (d) no identity, no colliding customer → create one on the free plan, with
   *      NO password. A wallet account has no email at all; that is legal (the
   *      unique email index is partial on `{ email: { $type: 'string' } }`).
   *  (e) a wallet never auto-links — enforced structurally below by dropping any
   *      email for `provider: 'wallet'`, not merely by callers not passing one.
   *
   * RACE SAFETY: the unique `{provider, subject}` index arbitrates, not a read.
   * The identity row is inserted FIRST (against a pre-allocated customer id) and
   * E11000 is the answer "a concurrent first login already won" — so two
   * simultaneous callbacks for one provider account cannot fork into two
   * customers, and the loser has no customer row to clean up.
   *
   * An UNVERIFIED address is never written to `Customer.email`, only to the
   * identity row as metadata. Storing it would make rule (b) find it later and
   * link the REAL owner's verified login into the squatter's account — the same
   * takeover by a slower route.
   */
  async resolveLogin(args: ResolveLoginArgs): Promise<ResolvedLogin> {
    const provider = args.provider;
    const subject = typeof args.subject === 'string' ? args.subject.trim() : '';
    if (!subject) {
      throw new UnauthorizedException({ error: 'That provider account could not be identified' });
    }
    // (e) — a wallet's linking inputs are the address and nothing else.
    const email = provider === 'wallet' ? undefined : normalizeEmail(args.email);
    const emailVerified = Boolean(email) && args.emailVerified === true;
    const now = new Date();

    // ── (a) known identity
    // `let`, not `const`: an orphaned row is cleared below and the flow falls
    // through to the normal create path.
    let existing = (await this.identities.findOne({ provider, subject }).lean().exec()) as IdentityRow | null;
    // An identity whose customer is GONE. Adopt it rather than refusing: this
    // used to 503 on the grounds that self-healing was "a destructive guess",
    // but there is nothing left to destroy and the refusal is permanent — the
    // unique {provider, subject} index also blocks minting a replacement
    // identity, so the wallet or provider account is bricked forever and only
    // hand surgery on the database gets it back. Observed in the wild after the
    // customers collection was replaced under a live identity row.
    //
    // Safe because the caller has ALREADY proved control of `subject` (a
    // verified signature for a wallet, a completed OAuth handshake otherwise),
    // so adoption grants exactly what a first-ever login would — and suspension
    // is `status: 'suspended'` on an EXISTING customer, so a missing row was
    // never a ban and this bypasses nothing.
    if (existing && !(await this.customerExists(existing.customerId))) {
      this.logger.warn(
        `Adopting orphaned ${provider} identity: customer ${String(existing.customerId)} is gone, issuing a fresh account`,
      );
      await this.identities.deleteOne({ _id: existing._id }).exec();
      existing = null;
    }

    if (existing) {
      const customer = await this.loginAs(existing.customerId);
      // Descriptive metadata only — `subject` is the join key and is never
      // rewritten, and `Customer.email` is not touched from here.
      const refresh: Record<string, unknown> = { lastLoginAt: now };
      if (email) {
        refresh.email = email;
        refresh.emailVerified = emailVerified;
      }
      if (args.displayName) refresh.displayName = args.displayName;
      await this.identities.updateOne({ _id: existing._id }, { $set: refresh }).exec();
      return { customer, isNewCustomer: false };
    }

    // ── (b)/(c) an existing account on this address. The verdict itself lives in
    // `assertEmailCollisionLinkable` below, because the E11000 path further down
    // has to reach EXACTLY the same one — see that method.
    let owner: Types.ObjectId | null = null;
    if (email) {
      const holder = (await this.customers.findOne({ email }).lean().exec()) as CustomerRow | null;
      // Asked BEFORE any write, so a refused login never leaves a new identity
      // attached to somebody else's account.
      if (holder) {
        owner = this.assertEmailCollisionLinkable(holder, { ...args, subject, email, emailVerified });
      }
    }

    const isNewCustomer = owner === null;
    // Pre-allocated so the identity — the row the unique index arbitrates — can
    // be written first.
    const customerId = owner ?? new Types.ObjectId();

    let identityId: unknown;
    try {
      const created = await this.identities.create({
        customerId,
        provider,
        subject,
        email,
        emailVerified,
        displayName: args.displayName,
        linkedAt: now,
        lastLoginAt: now,
      });
      identityId = (created as unknown as { _id: unknown })._id;
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      // Lost the race on `{provider, subject}`. Nothing to undo — no customer
      // has been written yet — so re-read the winner and log in as its owner.
      const winner = (await this.identities.findOne({ provider, subject }).lean().exec()) as IdentityRow | null;
      if (!winner) throw error;
      const customer = await this.loginAs(winner.customerId);
      await this.identities.updateOne({ _id: winner._id }, { $set: { lastLoginAt: new Date() } }).exec();
      return { customer, isNewCustomer: false };
    }

    // ── (b) linked to the existing account
    if (!isNewCustomer) {
      return { customer: await this.loginAs(customerId), isNewCustomer: false };
    }

    // ── (d) brand-new account
    try {
      await this.customers.create({
        _id: customerId,
        // `name` is required and is what the admin panel lists accounts by. An
        // SSO account has no separate display name, so: address, then the
        // provider's label, then the opaque subject.
        name: email ?? args.displayName ?? `${provider}:${subject}`,
        // ONLY a provider-verified address reaches `Customer.email` — see the
        // method comment.
        email: emailVerified ? email : undefined,
        planKey: DEFAULT_PLAN_KEY,
        origin: 'self_serve',
        // No `passwordHash`: this account has no password, and the portal's
        // unlink guard is what keeps it reachable.
        emailVerifiedAt: emailVerified ? now : undefined,
        lastLoginAt: now,
      });
    } catch (error) {
      // A concurrent login for the same address won the unique email index.
      // That can be rule (b) arriving late — repoint this identity at the winner
      // rather than fail a login entitled to succeed — but ONLY if the winner
      // passes the same gate the pre-flight check applied.
      //
      // It used to keep just the provider's half of the rule and never read the
      // winner's `emailVerifiedAt`, which is the takeover rule (b) exists to
      // stop, by a slower route: signup is open and unauthenticated, so the row
      // that wins this race can be an attacker's UNVERIFIED password account on
      // victim@corp.com — and the victim's genuine Google identity was then
      // repointed straight into it, password and all still working.
      if (isDuplicateKeyError(error) && emailVerified && email) {
        const holder = (await this.customers.findOne({ email }).lean().exec()) as CustomerRow | null;
        if (holder) {
          let ownerId: Types.ObjectId;
          // NARROW on purpose: only the verdict is inside this `try`. Widening it
          // over the `updateOne`/`loginAs` below would delete the identity row of
          // a correctly repointed login on any transient failure.
          try {
            ownerId = this.assertEmailCollisionLinkable(holder, { ...args, subject, email, emailVerified });
          } catch (refusal) {
            // The identity row now points at a customer that will never be
            // created, and the unique {provider, subject} index blocks minting a
            // replacement — leaving it bricks this provider account for good.
            const cleanup = await this.identities
              .deleteOne({ _id: identityId })
              .exec()
              .catch(() => undefined);
            // …and that `.catch` swallows the failure. An orphan row that
            // survived turns the ceremony we would otherwise offer into
            // `linkIdentity`'s "already linked to a different account" dead end,
            // so when the delete did not report a deletion, say the plain thing.
            if (refusal instanceof PendingLinkRequiredError && !deletedOne(cleanup)) {
              throw new ConflictException({ error: EMAIL_IN_USE_MESSAGE });
            }
            throw refusal;
          }
          await this.identities.updateOne({ _id: identityId }, { $set: { customerId: ownerId } }).exec();
          return { customer: await this.loginAs(ownerId), isNewCustomer: false };
        }
      }
      // Otherwise the identity row would point at a customer that does not
      // exist, which would break this provider account's login for good.
      await this.identities
        .deleteOne({ _id: identityId })
        .exec()
        .catch(() => undefined);
      throw error;
    }

    // Built here, not from the created document: `select: false` is a QUERY
    // projection, so a freshly-created doc carries every path that was set.
    const customer = toPublicCustomer({
      id: String(customerId),
      email: emailVerified ? email : undefined,
      planKey: DEFAULT_PLAN_KEY,
      emailVerifiedAt: emailVerified ? now : undefined,
      status: 'active',
    });
    return { customer, isNewCustomer: true };
  }

  /**
   * Rules (b)/(c) for a customer who ALREADY holds the asserted address: the
   * customer to link into, or a throw. THE security core's decision point.
   *
   * (b) links only when BOTH sides proved control of this address — the provider
   * asserted it (`assertion.emailVerified`) AND we verified it ourselves
   * (`holder.emailVerifiedAt`). (c) refuses everything else.
   *
   * The provider's word alone is NOT enough, and trusting it is a critical
   * account-takeover: signup is open and unauthenticated, so anyone can create a
   * row holding victim@corp.com. If auto-link keyed only off the provider, the
   * victim's genuine Google sign-in would be merged INTO the attacker's account —
   * and the attacker's password still works, so they keep the victim's keys,
   * usage and plan. Rule (b) is NOT dormant: `MailService` stamps
   * `emailVerifiedAt` on OTP verification and the ceremony stamps it too, so this
   * auto-links for real in any mailer-configured deployment.
   *
   * IT THROWS RATHER THAN RETURNING A VERDICT, and that is the point of the
   * shape: a returned refusal is inert until some caller remembers to raise it,
   * and a caller that forgets is precisely the takeover above. `resolveLogin`
   * asks this twice — once before any write, once when the unique email index
   * reports a concurrent winner — and both must reach the identical answer.
   */
  private assertEmailCollisionLinkable(
    holder: Pick<CustomerRow, '_id' | 'emailVerifiedAt' | 'status'>,
    assertion: ResolveLoginArgs & { email: string },
  ): Types.ObjectId {
    if (!assertion.emailVerified || !holder.emailVerifiedAt) {
      // THE CEREMONY FORK. A refusal is still the answer here — nothing is
      // linked — but when the PROVIDER verified the address and the holder is
      // usable, the human can settle it themselves, so hand back a resolvable
      // collision instead of a dead end.
      //
      // This does NOT weaken rule (b); it satisfies the same two halves in
      // SEQUENCE rather than simultaneously. The provider has proved the
      // address; the completion route then makes the human prove control of the
      // account that holds it by AUTHENTICATING into it. Silent auto-linking is
      // unchanged — falling out of this branch is the only path that links
      // without anyone signing in.
      //
      // Both conditions are load-bearing:
      //  - `emailVerified` — an unverified provider email is attacker-typed text
      //    (GitHub's public profile field is exactly that), and offering "sign in
      //    to connect m•••@corp.com" for an arbitrary typed address turns our own
      //    login page into a targeted phishing lure. That case keeps the plain
      //    refusal, and Settings-initiated linking already covers it safely.
      //  - the holder must be ACTIVE — a ceremony for a suspended account both
      //    confirms the account exists and hands a suspended tenant a fresh way
      //    in. `assertLoginAllowed` would refuse the login, so the invitation
      //    must not be issued either.
      if (assertion.emailVerified && holder.status === 'active') {
        throw new PendingLinkRequiredError({
          targetCustomerId: toObjectId(holder._id).toHexString(),
          provider: assertion.provider,
          subject: assertion.subject,
          email: assertion.email,
          emailVerified: true,
          displayName: assertion.displayName,
        });
      }
      throw new ConflictException({ error: EMAIL_IN_USE_MESSAGE });
    }
    // Rule (b) holds; suspension is still a hard gate, so a linkable collision on
    // a suspended account is a refused login rather than a new identity on it.
    this.assertLoginAllowed(holder);
    return toObjectId(holder._id);
  }

  /**
   * Attach a provider account to the CURRENT signed-in customer.
   *
   * One upsert whose FILTER carries `customerId`: a row already held by a
   * different customer cannot match, the upsert falls through to an insert, and
   * the unique `{provider, subject}` index rejects it — so E11000 IS the answer
   * "somebody else owns this". No check-then-act, and an identity is NEVER moved
   * between customers (moving one would transfer a login, not add one).
   */
  async linkIdentity(customerId: string, args: ResolveLoginArgs): Promise<PublicIdentity> {
    const owner = parseObjectId(customerId, 'Account not found');
    const provider = args.provider;
    const subject = typeof args.subject === 'string' ? args.subject.trim() : '';
    if (!subject) {
      throw new BadRequestException({ error: 'That provider account could not be identified' });
    }

    const customer = (await this.customers.findById(owner).lean().exec()) as CustomerRow | null;
    if (!customer) throw new NotFoundException({ error: 'Account not found' });
    this.assertLoginAllowed(customer);

    // A provider account already held by SOMEBODY ELSE is refused outright.
    //
    // This is a second lock on the same door, not the lock itself: the upsert
    // below is already scoped by `customerId` and the unique `{provider,
    // subject}` index still has the final word (a row created between this read
    // and that write yields E11000, handled at the bottom). It exists because
    // "the victim's identity ended up on the attacker's account" is the exact
    // damage the forced-link attack does, and a rule that important should be
    // stated where a reader can see it rather than inferred from an index.
    const held = (await this.identities.findOne({ provider, subject }).lean().exec()) as IdentityRow | null;
    if (held && String(held.customerId) !== String(owner)) {
      throw new ConflictException({
        error: 'That provider account is already linked to a different account.',
      });
    }

    // Same rule as `resolveLogin`: a wallet's email plays no part, and an
    // unverified address stays on the identity row as metadata.
    const email = provider === 'wallet' ? undefined : normalizeEmail(args.email);
    const now = new Date();
    const set: Record<string, unknown> = {
      emailVerified: Boolean(email) && args.emailVerified === true,
      lastLoginAt: now,
    };
    if (email) set.email = email;
    if (args.displayName) set.displayName = args.displayName;

    try {
      const linked = (await this.identities
        .findOneAndUpdate(
          { provider, subject, customerId: owner },
          { $set: set, $setOnInsert: { linkedAt: now } },
          { upsert: true, new: true, setDefaultsOnInsert: true },
        )
        .lean()
        .exec()) as IdentityRow | null;
      if (!linked) throw new NotFoundException({ error: 'Sign-in method not found' });
      return toPublicIdentity(linked);
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        throw new ConflictException({
          error: 'That provider account is already linked to a different account.',
        });
      }
      throw error;
    }
  }

  // ─── connected accounts ───────────────────────────────────────────────────

  async listIdentities(customerId: string): Promise<IdentityListResult> {
    const owner = parseObjectId(customerId, 'Account not found');
    const [customer, rows] = await Promise.all([
      // `passwordHash` is `select: false`; without the explicit `+` EVERY
      // account reads as password-less and the unlink guard below would refuse
      // the last identity of accounts that do have a password.
      this.customers.findById(owner).select('+passwordHash').lean().exec() as Promise<CustomerRow | null>,
      this.identities.find({ customerId: owner }).sort({ linkedAt: 1 }).lean().exec() as Promise<IdentityRow[]>,
    ]);
    if (!customer) throw new NotFoundException({ error: 'Account not found' });
    return {
      identities: (rows ?? []).map(toPublicIdentity),
      hasPassword: Boolean(customer.passwordHash),
    };
  }

  /**
   * Detach a sign-in method the caller owns.
   *
   * TWO separate concerns, deliberately not conflated:
   *  - AUTHORIZATION is the Mongo FILTER (`{_id, customerId}`) — a single scoped
   *    write, so there is no TOCTOU window and a row belonging to somebody else
   *    is not even confirmed to exist. Same pattern as `ClientsService.*Owned`.
   *  - LOCKOUT is the credential count: an account with no password and no other
   *    identity has no way back in, so removing its last one is refused.
   */
  async unlinkIdentity(customerId: string, identityId: string): Promise<{ ok: true }> {
    const owner = parseObjectId(customerId, 'Account not found');
    const id = parseObjectId(identityId, 'Sign-in method not found');

    const [customer, count] = await Promise.all([
      this.customers.findById(owner).select('+passwordHash').lean().exec() as Promise<CustomerRow | null>,
      this.identities.countDocuments({ customerId: owner }).exec(),
    ]);
    if (!customer) throw new NotFoundException({ error: 'Account not found' });
    const hasPassword = Boolean(customer.passwordHash);
    if (!hasPassword && count <= 1) {
      throw new BadRequestException({
        error:
          'That is the only way into your account. Set a password or link another provider first, then remove this one.',
      });
    }

    const removed = (await this.identities
      .findOneAndDelete({ _id: id, customerId: owner })
      .lean()
      .exec()) as IdentityRow | null;
    if (!removed) throw new NotFoundException({ error: 'Sign-in method not found' });

    // The count above is a read, so two concurrent unlinks of DIFFERENT rows can
    // both pass it. Re-check and put the row back rather than leave an account
    // nobody — including support — can sign into.
    if (!hasPassword) {
      const remaining = await this.identities.countDocuments({ customerId: owner }).exec();
      if (remaining === 0) {
        await this.identities.create({
          _id: toObjectId(removed._id),
          customerId: toObjectId(removed.customerId),
          provider: removed.provider,
          subject: removed.subject,
          email: removed.email,
          emailVerified: Boolean(removed.emailVerified),
          displayName: removed.displayName,
          linkedAt: removed.linkedAt ?? new Date(),
          lastLoginAt: removed.lastLoginAt,
        });
        throw new BadRequestException({
          error:
            'That is the only way into your account. Set a password or link another provider first, then remove this one.',
        });
      }
    }
    return { ok: true };
  }

  // ─── internals ────────────────────────────────────────────────────────────

  /** `${OAUTH_CALLBACK_BASE_URL}/account/auth/oauth/<provider>/callback`. */
  private redirectUriFor(provider: string): string {
    // The getter strips any trailing slash, so this concatenation is safe.
    return `${this.config.oauthCallbackBaseUrl}/account/auth/oauth/${provider}/callback`;
  }

  /**
   * Where the browser lands. `returnTo` is re-sanitized HERE even though it was
   * sanitized on the way in: it round-tripped through Redis, and an absolute
   * value appended to `PORTAL_BASE_URL` is an open redirect carrying a session.
   */
  private portalCallbackUrl(
    provider: string,
    params: { code?: string; error?: string; returnTo?: string },
  ): string {
    const query = new URLSearchParams({ provider });
    if (params.code) query.set('code', params.code);
    if (params.error) query.set('error', params.error);
    const returnTo = sanitizeReturnTo(params.returnTo);
    if (returnTo) query.set('returnTo', returnTo);
    return `${this.config.portalBaseUrl}/auth/callback?${query.toString()}`;
  }

  /**
   * Where a resolvable collision lands. The token is the ONLY parameter beyond
   * the provider slug: no address, because a crafted URL naming an arbitrary one
   * would render a convincing "you already have an account for …" lure on our own
   * domain, and the page has a describe route for the masked version.
   */
  private portalLinkAccountUrl(provider: string, token: string): string {
    const query = new URLSearchParams({ provider, token });
    return `${this.config.portalBaseUrl}/link-account?${query.toString()}`;
  }

  /**
   * The provider's display label. Falls back to the slug rather than 404ing when
   * the registry does not know it: a pending link outlives a config change, and a
   * ceremony started before an operator pulled the credentials is still
   * completable — it needs no further call to the provider.
   */
  private providerLabel(providerId: string): string {
    if (this.providers.has(providerId)) return this.providers.resolve(providerId).label;
    return providerId.charAt(0).toUpperCase() + providerId.slice(1);
  }

  /**
   * The browser binder as a `Set-Cookie` header value. `Secure` is conditional on
   * production for a practical reason: over plain http a `Secure` cookie is
   * dropped by the browser without a word, so a hardcoded flag would break local
   * dev with a symptom ("binder did not match") that points at the wrong thing.
   */
  private binderCookie(binder: string): string {
    return buildBinderCookie(binder, this.config.isProduction);
  }

  /** The ceremony's own binder cookie — same value, its own name and lifetime. */
  private linkBinderCookie(binder: string): string {
    return buildLinkBinderCookie(binder, this.config.isProduction);
  }

  /**
   * The SAME token a password login mints: the `CUSTOMER_JWT` signer, the
   * `typ: 'customer'` claim, no extra claims. An SSO-specific claim would create
   * a second class of customer token that every guard would have to learn about.
   */
  private sign(customer: PublicCustomer): Promise<string> {
    const payload: CustomerJwtPayload = {
      sub: customer.id,
      email: customer.email,
      typ: CUSTOMER_TOKEN_TYPE,
    };
    return this.jwt.signAsync(payload);
  }

  /** Load, gate, stamp `lastLoginAt`, project. The single SSO login gate. */
  private async loginAs(customerId: unknown): Promise<PublicCustomer> {
    const customer = await this.readCustomer(customerId);
    this.assertLoginAllowed(customer);
    await this.customers.updateOne({ _id: customer._id }, { $set: { lastLoginAt: new Date() } }).exec();
    return projectCustomer(customer);
  }

  /** Load + gate, WITHOUT stamping a login (handoff exchange, link flow). */
  private async publicCustomerById(customerId: string): Promise<PublicCustomer> {
    const customer = await this.readCustomer(parseObjectId(customerId, 'Account not found'));
    this.assertLoginAllowed(customer);
    return projectCustomer(customer);
  }

  /**
   * Existence only — never throws, so an orphan check cannot itself 503.
   *
   * Uses `findById`, not `countDocuments`: it is the read every other path in
   * this service already uses, so anything that can serve a login can answer
   * this too.
   */
  private async customerExists(customerId: unknown): Promise<boolean> {
    return Boolean(await this.customers.findById(customerId).lean().exec());
  }

  private async readCustomer(customerId: unknown): Promise<CustomerRow> {
    const customer = (await this.customers.findById(customerId).lean().exec()) as CustomerRow | null;
    if (!customer) {
      // An identity pointing at a missing customer: either an admin deleted the
      // account, or a create failed after its identity was written. Transient to
      // the caller and LOUD here — it needs an operator, and self-healing by
      // deleting the identity would be a destructive guess.
      this.logger.error(`SSO identity resolved to a customer that does not exist: ${String(customerId)}`);
      throw new ServiceUnavailableException({
        error: 'Sign-in could not be completed. Please try again or contact support.',
      });
    }
    return customer;
  }

  /** Suspension is a HARD gate — the same one the password login applies. */
  private assertLoginAllowed(customer: Pick<CustomerRow, 'status'>): void {
    if (customer.status !== 'active') {
      throw new ForbiddenException({ error: 'This account is suspended — contact support.' });
    }
  }

  /**
   * Limiter key. Keyed on the CLIENT IP; with no usable one (a proxy hop that
   * collapses every visitor, an unspecified address) it degrades to a
   * per-subject key rather than ONE shared bucket — a shared bucket would turn
   * the guard into the outage it exists to prevent.
   */
  private limiterKey(namespace: string, clientIp: string | undefined, fallback: string): string {
    const ip = normalizeClientIp(clientIp);
    return ip
      ? `${LIMITER_REALM}:${namespace}:ip:${ip}`
      : `${LIMITER_REALM}:${namespace}:alt:${fallback}`;
  }

  private async throttle(limiter: AuthLimiter, key: string, message: string): Promise<void> {
    try {
      await limiter.consume(key, 1);
    } catch {
      throw new HttpException({ error: message }, HttpStatus.TOO_MANY_REQUESTS);
    }
  }
}

/** `PublicCustomer` from a stored row — always through `toPublicCustomer`. */
function projectCustomer(customer: CustomerRow): PublicCustomer {
  return toPublicCustomer({
    id: String(customer._id),
    email: customer.email,
    planKey: customer.planKey,
    emailVerifiedAt: customer.emailVerifiedAt,
    status: customer.status,
  });
}

/** The only identity projection allowed to cross the wire. No `customerId`. */
function toPublicIdentity(row: IdentityRow): PublicIdentity {
  return {
    id: String(row._id),
    provider: row.provider,
    subject: row.subject,
    email: row.email ?? null,
    emailVerified: Boolean(row.emailVerified),
    linkedAt: row.linkedAt ? new Date(row.linkedAt).toISOString() : null,
    lastLoginAt: row.lastLoginAt ? new Date(row.lastLoginAt).toISOString() : null,
  };
}

/**
 * A provider email reduced to the form the unique index stores, or `undefined`.
 * Anything unparseable is treated as ABSENT rather than stored: a junk value in
 * `Customer.email` occupies the unique index for an address nobody owns.
 */
function normalizeEmail(raw: string | undefined): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const email = raw.trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL_LENGTH) return undefined;
  // Shape only — the provider already owns the address; we just refuse garbage.
  if (!/^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(email)) return undefined;
  return email;
}

/**
 * `kate@example.com` → `k•••@example.com`. Enough for someone to RECOGNISE their own
 * address on the ceremony page, not enough for a token holder to learn one.
 *
 * A ONE-CHARACTER local part shows nothing (`•••@example.com`): keeping the first
 * character there would print the whole address back, which is the one thing this
 * function exists to prevent. Anything without a usable `@` is masked entirely.
 */
/**
 * The address the ceremony is about, shown to a browser that has not yet proved
 * it owns it.
 *
 * FIRST **AND LAST** character of the local part, with the middle run scaled to
 * its real length. Masking to a bare first letter looked more careful and was
 * actively harmful: `kbrown@example.com` and `kyle.green222@example.com` both
 * rendered `k•••@example.com`, so a person holding two accounts at the same
 * provider could not tell WHICH ONE the ceremony was waiting for — and picking
 * wrong is a 403 and a round of confusion. Observed live, on exactly that pair.
 *
 * Disclosure is barely the point here anyway: the token is minted only after a
 * provider-verified sign-in AS this address, and reading it needs the binder
 * cookie from that same browser, so the viewer has already authenticated as the
 * mailbox. The mask is defence in depth for a leaked token, not a secret — and a
 * mask that cannot distinguish the accounts it describes fails its actual job.
 *
 * A one-character local part still masks whole: there is no middle to hide, so
 * revealing both ends would be revealing all of it.
 */
function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0 || at === email.length - 1) return '•••';
  const local = email.slice(0, at);
  const domain = email.slice(at);
  if (local.length < 2) return `•••${domain}`;
  // Bounded so a very long local part cannot spray dots across the layout, and
  // never shorter than 3 so the mask does not imply a short address.
  const hidden = '•'.repeat(Math.min(Math.max(local.length - 2, 1), 8));
  return `${local[0]}${hidden}${local[local.length - 1]}${domain}`;
}

/** Route params and provider-reported codes are echoed into a URL — clamp them. */
function safeSlug(value: unknown): string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,31}$/i.test(value) ? value : 'unknown';
}

function parseObjectId(value: string, notFound: string): Types.ObjectId {
  try {
    return new Types.ObjectId(value);
  } catch {
    throw new NotFoundException({ error: notFound });
  }
}

function toObjectId(value: unknown): Types.ObjectId {
  return value instanceof Types.ObjectId ? value : new Types.ObjectId(String(value));
}

/** Mongo duplicate-key (E11000) — a unique index rejecting a race. */
function isDuplicateKeyError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  if ((err as { code?: number }).code === 11000) return true;
  // Stubs and some driver wrappers surface it as a message only.
  return /E11000/.test(String((err as { message?: unknown }).message ?? ''));
}

/**
 * True only when a `deleteOne` actually REPORTED removing a row. Anything else —
 * a swallowed rejection (`undefined`), an unacknowledged write, `deletedCount: 0`
 * — means the row may still be there, and a caller that is deciding whether to
 * offer the linking ceremony must treat "cannot confirm" as "did not happen".
 */
function deletedOne(result: unknown): boolean {
  if (typeof result !== 'object' || result === null) return false;
  return (result as { deletedCount?: unknown }).deletedCount === 1;
}

/** Never rendered to a user — logged only. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 409 from `linkIdentity` = the provider account belongs to somebody else. */
function linkFailureSlug(error: unknown): CallbackErrorSlug {
  if (error instanceof ConflictException) return 'already_linked';
  if (error instanceof ForbiddenException) return 'account_suspended';
  return 'server_error';
}

/**
 * 409 from `resolveLogin` = rule (c), a colliding address that the caller cannot
 * resolve. The resolvable variant (`PendingLinkRequiredError`) is handled before
 * this is reached; it subclasses `ConflictException` so that if that handling is
 * ever removed, the redirect degrades to this exact slug instead of `server_error`.
 */
function loginFailureSlug(error: unknown): CallbackErrorSlug {
  if (error instanceof ConflictException) return 'email_in_use';
  if (error instanceof ForbiddenException) return 'account_suspended';
  return 'server_error';
}

/**
 * The client IP reduced to a stable limiter key, or `undefined` when there isn't
 * a usable one. Mirrors `CustomerAuthService`: a dual-stack socket reports an
 * IPv4 client as `::ffff:1.2.3.4`, so both spellings must collapse onto one
 * bucket or the budget silently doubles.
 */
function normalizeClientIp(raw: string | undefined): string | undefined {
  const trimmed = (raw ?? '').trim().toLowerCase();
  if (!trimmed || trimmed === '::' || trimmed === '0.0.0.0') return undefined;
  const unmapped = trimmed.startsWith('::ffff:') ? trimmed.slice('::ffff:'.length) : trimmed;
  return unmapped || undefined;
}
