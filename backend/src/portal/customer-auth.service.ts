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
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { CUSTOMER_JWT } from '../auth/customer-jwt.tokens.js';
import { hashPassword, verifyPassword } from '../auth/password.util.js';
import { LimiterFactory, MEMORY_LIMITER_FACTORY, type AuthLimiter } from '../common/limiter-factory.js';
import { hashApiKey } from '../billing/api-key.util.js';
import { Customer } from '../billing/customer.schema.js';
import { DEFAULT_PLAN_KEY } from '../billing/plans.seed.js';
import { SettingsCacheService, type CachedPlan } from '../billing/settings-cache.service.js';
import { AppConfigService } from '../config/app-config.service.js';
import { MailService } from '../mail/mail.service.js';

/**
 * Realm discriminator stamped on every customer token's `typ` claim and
 * asserted by `CustomerJwtGuard` — the mirror of `ADMIN_TOKEN_TYPE`. The two
 * realms also use different secrets; either guard alone is not enough (a shared
 * secret with only a `typ` check is one forgotten guard away from a full
 * compromise, and separate secrets with no `typ` check breaks the day someone
 * "simplifies" the config).
 */
export const CUSTOMER_TOKEN_TYPE = 'customer' as const;

/** Namespaces the brute-force limiter so admin and customer logins for the same
 * address cannot exhaust — or lock out — each other's 10-attempt budget. */
const LIMITER_REALM = CUSTOMER_TOKEN_TYPE;

/**
 * The scrypt hash a login for an UNKNOWN address is verified against, so that
 * the miss path costs the same KDF work as the hit path.
 *
 * Without it `!customer` short-circuits and a login for an address that does not
 * exist answers in microseconds while a real one answers ~18ms later — an
 * account-enumeration oracle on an unauthenticated route, readable over the
 * network with no credentials at all.
 *
 * A LITERAL seed on purpose, NOT `randomBytes`: this value authenticates
 * nothing (the `!customer` check rejects before its result is ever trusted), so
 * unpredictability buys nothing, while a literal keeps module import
 * deterministic and adds no crypto import to this file.
 */
const DUMMY_PASSWORD_HASH = hashPassword('dummy-hash-seed-not-a-credential');

/**
 * TEN MINUTES, not the 24 hours a long emailed token carried.
 *
 * The code is six digits — about 10^6 possibilities — so the window it is
 * guessable in is a first-class security parameter, not a UX knob. It bounds
 * how long a live code exists to be guessed at all, alongside the per-code
 * attempt cap. Do not lengthen it without shortening something else.
 */
const VERIFICATION_TTL_MS = 10 * 60 * 1000;

/**
 * THIRTY MINUTES for a password reset link, and deliberately far shorter than a
 * session.
 *
 * A live reset token is a bearer credential that outranks the password — spend
 * it and you own the account, and (see `resetPassword`) you also evict whoever
 * was already signed in. It is not guessable the way a 6-digit code is, so this
 * window is not bounding brute force; it bounds EXPOSURE. The token travels
 * through a mailbox and then through a URL, so every copy of it — the mail
 * itself, the portal's access log, browser history, the `Referer` of the next
 * request off the reset page — is a place it can be read later. Thirty minutes
 * is comfortably longer than "open the mail and click it" and much shorter than
 * the life of any of those copies.
 */
const PASSWORD_RESET_TTL_MS = 30 * 60 * 1000;

/**
 * The shortest password this service will store, and the ONLY place that floor
 * is actually enforced.
 *
 * The DTOs carry a matching bound, but a DTO bound is a convenience for the
 * caller and nothing more: the global `ValidationPipe` is inert under `tsx` dev
 * (esbuild drops the decorator metadata), so a deployment running that way
 * accepts whatever the body says. This repo's rule is that nothing
 * security-relevant may rest on those bounds alone — see the header of
 * `identity.dto.ts` — and "how weak may a stored credential be" is exactly that.
 * Before this constant existed, `resetPassword` hashed whatever it was handed
 * and `changePassword` checked only that it differed from the current password:
 * a one-character password was reachable on both.
 *
 * Eight is the NIST 800-63B floor, and it is a LENGTH rule with NO composition
 * rules bolted on deliberately — forced character classes produce `Password1!`
 * and buy nothing measurable. The controls that do the work here are scrypt and
 * the login limiters.
 *
 * MUST BE RECONCILED WITH `SignupDto` (portal.dto.ts): if signup's bound is
 * higher, then reset is the weakest way into an account and an attacker who
 * takes over a mailbox can pick a password signup would have refused. Make both
 * refer to this constant.
 */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * The password floor, thrown as one 400 from every path that sets a password.
 *
 * A function and not two copies of the `if`: a floor written out twice is a
 * floor that gets raised in one place only.
 *
 * The `typeof` check is NOT belt-and-braces on the DTO's `@IsString()` — it is
 * the whole guard when the pipe is inert. With a non-string body value,
 * `password.length` is `undefined`, `undefined < 8` is `false`, and a
 * length-only check would wave through a JSON number or object on its way to
 * `hashPassword`.
 */
function assertPasswordPolicy(password: string): void {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new BadRequestException({
      error: `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters`,
    });
  }
}

/** Digits in an emailed verification code. Six, and `VerifyEmailDto` pins it. */
const VERIFICATION_CODE_DIGITS = 6;

/** Subject line of the verification email. */
const VERIFICATION_EMAIL_SUBJECT = 'Your Tickwise verification code';

/**
 * The verification email, plain text (no HTML — a six-digit code needs none, and
 * text/plain lands in fewer spam filters).
 *
 * The expiry is derived from `VERIFICATION_TTL_MS` rather than written out, so
 * shortening the window cannot leave the mail promising the old one.
 */
function verificationEmailText(code: string): string {
  const minutes = Math.round(VERIFICATION_TTL_MS / 60_000);
  return [
    'Here is your Tickwise verification code:',
    '',
    `    ${code}`,
    '',
    `It expires in ${minutes} minutes and can be used once.`,
    'Do not share it with anyone — nobody from Tickwise will ever ask you for it.',
    '',
    'If you did not ask to verify this address, you can ignore this email.',
  ].join('\n');
}

/**
 * Wrong submissions tolerated against ONE outstanding code before it is
 * destroyed and the customer has to request a new one.
 *
 * Without this the code is not a secret at all: 10^6 is minutes of scripted
 * guessing. Five is generous for a human typing six digits off a screen.
 */
const MAX_VERIFICATION_ATTEMPTS = 5;

/**
 * The single error every failed verification returns.
 *
 * Wrong code, expired code, burnt-out code and NO outstanding code are one
 * message on purpose — a distinguishable "no pending verification" reply turns
 * this public route into an oracle for whether a given address is mid-signup.
 */
function invalidCodeError(): BadRequestException {
  return new BadRequestException({
    error: 'That verification code is invalid or has expired. Request a new one.',
  });
}

/**
 * Bytes of entropy behind a password reset token — 32, i.e. 256 bits, emitted as
 * base64url.
 *
 * THE ENTROPY IS THE WHOLE CONTROL, which is why this token carries no packed
 * attempt counter of the kind `encodeVerification` gives the 6-digit code. That
 * counter exists because 10^6 is minutes of scripted guessing and a cap is the
 * only thing standing between a code and a script; there is nothing to cap here,
 * because 2^256 cannot be searched and a per-token counter would only add a
 * write on a path nobody can reach. The asymmetry is deliberate — do not "make
 * the two consistent" by deleting the OTP's counter.
 *
 * `base64url` and not `base64`, and not `hex`: the token is put in a URL and
 * then into an email body, and `+ / =` would be escaped by one hop and possibly
 * mangled by another — so what the customer clicks must be BYTE-IDENTICAL to
 * what was hashed, or a valid reset reads as an expired one.
 */
const PASSWORD_RESET_TOKEN_BYTES = 32;

/** Subject line of the reset mail. Sibling of `VERIFICATION_EMAIL_SUBJECT`. */
const PASSWORD_RESET_EMAIL_SUBJECT = 'Reset your Tickwise password';

/**
 * The reset email, plain text for the same reasons the verification one is.
 *
 * The expiry is derived from `PASSWORD_RESET_TTL_MS` rather than written out, so
 * shortening the window cannot leave the mail promising the old one.
 *
 * It states the sign-out consequence, because a customer who resets from one
 * device and is silently logged out on three others will read that as a breach
 * rather than as the feature it is.
 *
 * AND IT STATES THE LIMIT OF THAT CONSEQUENCE, which is the more important half.
 * This mail used to promise that a new password "signs you out of Tickwise
 * everywhere" — false, and dangerously so for the reader who is doing this
 * BECAUSE they were compromised. The eviction is `passwordChangedAt`, and
 * `CustomerJwtGuard` is its only reader: it ends portal sessions and touches no
 * API key, so a key the attacker minted keeps working through the reset (see the
 * note at the `passwordChangedAt` write in `resetPassword`). Until keys are
 * revoked here, the mail must not imply they were — a customer who believes the
 * reset closed the door stops looking for the one still open.
 */
function passwordResetEmailText(link: string): string {
  const minutes = Math.round(PASSWORD_RESET_TTL_MS / 60_000);
  return [
    'Someone asked to reset the password on your Tickwise account.',
    '',
    `    ${link}`,
    '',
    `The link expires in ${minutes} minutes and can be used once.`,
    'Setting a new password ends every signed-in Tickwise session, on every',
    'device. It does NOT revoke your API keys — if you did not expect this',
    'reset, sign in and review your API keys, and delete any you do not',
    'recognise.',
    '',
    'If this was not you, ignore this email. Your password has not changed, and',
    'nobody can reset it without the link above.',
  ].join('\n');
}

/**
 * The single error every failed reset returns.
 *
 * Unknown token, expired token and ALREADY-SPENT token are one message on
 * purpose — the same discipline as `invalidCodeError`. Telling a caller that a
 * token was real but expired, or real but already used, confirms that the token
 * they hold (out of a log, a `Referer`, a forwarded email) belongs to a live
 * account, which is exactly the fact the uniform answer on the request route is
 * there to withhold.
 */
function invalidResetError(): BadRequestException {
  return new BadRequestException({
    error: 'That password reset link is invalid or has expired. Request a new one.',
  });
}

export interface CustomerJwtPayload {
  sub: string;
  email: string;
  /** Always `'customer'`. Tokens from any other realm must never satisfy this. */
  typ: typeof CUSTOMER_TOKEN_TYPE;
  /** Issued-at, seconds since epoch. Added by jsonwebtoken, read by the guard. */
  iat?: number;
}

/** Everything about a customer that may cross the wire. Never the hashes. */
export interface PublicCustomer {
  id: string;
  email: string;
  planKey: string;
  /** ISO timestamp, or null while the address is unverified. */
  emailVerifiedAt: string | null;
  /**
   * An address claimed but not yet proved, or null. NOT the account's address —
   * it becomes `email` only when the code verifies. The portal needs it to show
   * which address a pending code was sent to.
   */
  pendingEmail: string | null;
  status: 'active' | 'suspended';
}

export interface CustomerAuthResult {
  token: string;
  customer: PublicCustomer;
}

/**
 * The single customer projection, used by BOTH `/account/auth/*` and
 * `/account/*`. `ClientsService` hands raw `.lean()` documents to the wire, so
 * every portal response is built here instead — one mapper means the projection
 * cannot drift and a newly-added secret column cannot leak by omission.
 */
export function toPublicCustomer(source: {
  id: string;
  email?: string;
  planKey: string;
  emailVerifiedAt?: Date | null;
  pendingEmail?: string | null;
  status: 'active' | 'suspended';
}): PublicCustomer {
  return {
    id: source.id,
    email: source.email ?? '',
    planKey: source.planKey,
    emailVerifiedAt: source.emailVerifiedAt ? source.emailVerifiedAt.toISOString() : null,
    pendingEmail: source.pendingEmail ?? null,
    status: source.status,
  };
}

/**
 * Whether an unverified customer is locked out of the portal.
 *
 * ON by default — an unproven address should be proven. The lockout that
 * default could cause is handled at boot, not here: production refuses to start
 * when this is on AND no mailer is configured, because prod deliberately never
 * logs the code, so a customer would have no way to receive one. With
 * `RESEND_API_KEY` + `MAIL_FROM` set it boots normally; in development the code
 * goes to the server log either way, so the loop is walkable with no mailer.
 *
 * Takes the config rather than reading `process.env` directly — this repo's
 * rule is that an env var is a Zod schema entry plus a typed getter, so that it
 * is validated at boot and visible in one place.
 */
export function isEmailVerificationRequired(config: AppConfigService): boolean {
  return config.customerEmailVerificationRequired;
}

/** A plan may be granted at signup only when there is genuinely nothing to pay. */
function isFreePlan(plan: CachedPlan): boolean {
  if (plan.price > 0) return false;
  return !plan.prices.some((price) => price.active && price.unitAmountMinor > 0);
}

/**
 * Credential handling for the self-serve customer realm: signup, login,
 * password change, email verification. Separate from `AuthService` in every
 * dimension that matters — its own secret (`CUSTOMER_JWT`), its own `typ`
 * claim, its own collection, its own limiter namespace.
 */
@Injectable()
export class CustomerAuthService {
  private readonly logger = new Logger(CustomerAuthService.name);
  // Same shape as AuthService's admin limiter: 10 attempts per email per 5
  // minutes, reset on a successful login. Per process by default; fleet-wide
  // with AUTH_LIMITER_STORE=redis (the constructor builds every limiter).
  private readonly loginLimiter: AuthLimiter;
  /**
   * The per-IP login bucket, and it is a DoS control rather than a nicety.
   *
   * Every failed login now runs scrypt whether or not the address exists (see
   * `DUMMY_PASSWORD_HASH`), and scrypt runs SYNCHRONOUSLY on the single event
   * loop at ~18ms. The per-ADDRESS bucket above caps nothing here: an attacker
   * varies the address for free and buys unbounded CPU with no credentials.
   * Login and signup are the only two unauthenticated routes in this service
   * that run scrypt UNCONDITIONALLY — verify and resend are both guarded, and
   * the two password-reset routes either send mail or hash only after a valid
   * 256-bit token — so this and `signupLimiter` are the bulk of the
   * anonymous-CPU budget. 20 per 5 minutes matches `verifyIpLimiter`, and
   * NOT a laxer 60: an honest human never spends 20 failed logins in 5 minutes,
   * and 60 would be 60 × 18ms of free stall per window per source address.
   */
  private readonly loginIpLimiter: AuthLimiter;
  // Verification mails are a spend and a spam vector: 5 per account per hour.
  private readonly resendLimiter: AuthLimiter;
  /**
   * The address-collision probe budget for `setEmail`, keyed on the customer id.
   *
   * DELIBERATELY SEPARATE from `resendLimiter`, and the separation is the fix:
   * `setEmail` answers 409 for an address another account already holds, which
   * makes an authenticated caller able to test any address they like. Charging
   * those probes to the 5/hr MAIL budget would mean five typos — or five
   * deliberate collisions — leave a customer unable to request a verification
   * code for their own address, i.e. the anti-enumeration guard becomes the
   * lockout. 20/hr bounds enumeration to a rate no scraper cares for while
   * leaving the mail budget untouched by attempts that never send mail.
   */
  private readonly emailProbeLimiter: AuthLimiter;
  /**
   * Verification budgets. All three sit under their own `verify:` / `resend:`
   * namespaces so they can neither drain nor be drained by the login (10/5min)
   * or signup (5/hr) budgets — a shared key between two routes is how one
   * endpoint locks a customer out of another.
   *
   * The per-ACCOUNT budget is the meaningful one (it bounds guessing at a known
   * account alongside the persisted attempt cap); the per-IP one bounds a
   * scripted flood across many accounts.
   */
  private readonly verifyAccountLimiter: AuthLimiter;
  private readonly verifyIpLimiter: AuthLimiter;
  /**
   * LAST-RESORT bucket for a verification attempt that carries neither an
   * account nor a usable IP. `verify-email` is guarded now, so an account id is
   * always present and this should never be charged — it stays as the floor for
   * a caller behind a proxy with `TRUST_PROXY_HOPS` unset, where `req.ip` is
   * unusable and the account budget is the only other bucket.
   *
   * This is the one shared bucket in the file, and it is deliberately shaped so
   * it cannot become the outage it prevents (the failure mode called out for
   * the signup limiter): a 60-second window means the worst a flood can do is
   * make an honest customer retype their code a minute later, and 20/min still
   * caps blind guessing at ~29k/day against a code that lives 10 minutes.
   */
  private readonly verifyAnonymousLimiter: AuthLimiter;
  private readonly resendIpLimiter: AuthLimiter;
  /**
   * The password-reset REQUEST budgets, sized off `resendLimiter`/`resendIpLimiter`
   * because they buy the same thing: an outbound email to an address the caller
   * merely typed. 5 per address per hour, 20 per IP per hour, in their own
   * `reset:` namespace so a reset flood cannot drain — or lock a customer out of
   * — the login, signup, verification or resend budgets.
   *
   * The per-ADDRESS bucket is not an anti-guessing control (there is nothing to
   * guess on that route). It exists so that mail-bombing ONE mailbox from a
   * rotating pool of source addresses stays bounded, which the per-IP bucket
   * alone cannot do. Its cost is that a third party who knows an address can
   * spend its budget and make the owner wait an hour — a nuisance, never a loss
   * of the account, and the alternative is an unbounded mail cannon aimed at a
   * chosen inbox from our domain.
   *
   * Both buckets are charged for an address that does not exist, exactly as for
   * one that does. A budget spent only on hits would BE the enumeration oracle
   * the uniform 202 exists to close, just read off the 429 instead of the body.
   */
  private readonly passwordResetLimiter: AuthLimiter;
  private readonly passwordResetIpLimiter: AuthLimiter;
  /**
   * The password-reset CONFIRM budget, and the ONLY limiter that route can have:
   * the caller presents an opaque token and nothing else — no address, no
   * session, no account id — so the client IP is the one key in the request.
   *
   * It is a DoS control and NOT an anti-guessing one. 2^256 is not searchable
   * (see `PASSWORD_RESET_TOKEN_BYTES`), so nobody is guessing their way to a
   * token; what an unthrottled caller buys is a database lookup per junk token
   * on a route that needs no credentials at all, which before the sparse index
   * on `passwordResetTokenHash` was a full scan of `customers` per request.
   *
   * Its own `reset:confirm:` namespace, so a flood of bogus tokens cannot drain
   * — or lock a customer out of — the REQUEST budget above, which is a different
   * route with a different key and a real mail spend behind it.
   *
   * 30 per 5 minutes is far above honest use: a human clicks a mailed link once
   * and retries a mangled one a handful of times.
   */
  private readonly passwordResetConfirmIpLimiter: AuthLimiter;
  /**
   * Signup is the anonymous, unauthenticated route in this service that does
   * real CPU work UNCONDITIONALLY: `hashPassword` is scrypt, and scrypt runs
   * SYNCHRONOUSLY on the single event loop (~18ms measured). (`resetPassword` is
   * anonymous and hashes too, but only after a 256-bit token matched — an
   * attacker cannot reach that branch.) A few dozen requests a second is
   * therefore enough to stall the whole process — metered `/v1` traffic
   * included — with no credentials at all. 5 accounts per client IP per hour is
   * an order of magnitude above any honest rate.
   */
  private readonly signupLimiter: AuthLimiter;

  constructor(
    @InjectModel(Customer.name) private readonly customers: Model<Customer>,
    @Inject(CUSTOMER_JWT) private readonly jwt: JwtService,
    @Inject(SettingsCacheService) private readonly settings: SettingsCacheService,
    @Inject(AppConfigService) private readonly config: AppConfigService,
    /**
     * APPENDED and `@Optional()` on purpose: three specs construct this service
     * positionally with the four params above, and an absent mailer is already a
     * supported state (it is exactly the unconfigured branch of
     * `deliverVerificationCode`). The HTTP path always has it — `PortalModule`
     * imports `MailModule`.
     */
    @Optional() @Inject(MailService) private readonly mail?: MailService,
    /**
     * APPENDED and optional (P2.2 §3.1): where the limiters below keep their
     * counters. Absent, or `AUTH_LIMITER_STORE=memory`, each is today's
     * per-process `RateLimiterMemory` with the same points and duration.
     */
    @Optional() @Inject(LimiterFactory) limiterFactory?: LimiterFactory,
  ) {
    const limiters = limiterFactory ?? MEMORY_LIMITER_FACTORY;
    this.loginLimiter = limiters.create(LIMITER_REALM, 'login', { points: 10, duration: 300 });
    this.loginIpLimiter = limiters.create(LIMITER_REALM, 'loginIp', { points: 20, duration: 300 });
    this.resendLimiter = limiters.create(LIMITER_REALM, 'resend', { points: 5, duration: 3600 });
    this.emailProbeLimiter = limiters.create(LIMITER_REALM, 'emailProbe', { points: 20, duration: 3600 });
    this.verifyAccountLimiter = limiters.create(LIMITER_REALM, 'verifyAccount', { points: 10, duration: 900 });
    this.verifyIpLimiter = limiters.create(LIMITER_REALM, 'verifyIp', { points: 20, duration: 300 });
    this.verifyAnonymousLimiter = limiters.create(LIMITER_REALM, 'verifyAnonymous', { points: 20, duration: 60 });
    this.resendIpLimiter = limiters.create(LIMITER_REALM, 'resendIp', { points: 20, duration: 3600 });
    this.passwordResetLimiter = limiters.create(LIMITER_REALM, 'passwordReset', { points: 5, duration: 3600 });
    this.passwordResetIpLimiter = limiters.create(LIMITER_REALM, 'passwordResetIp', { points: 20, duration: 3600 });
    this.passwordResetConfirmIpLimiter = limiters.create(LIMITER_REALM, 'passwordResetConfirmIp', { points: 30, duration: 300 });
    this.signupLimiter = limiters.create(LIMITER_REALM, 'signup', { points: 5, duration: 3600 });
  }

  /**
   * `clientIp` is the caller's address (`@Ip()` at the controller) and feeds the
   * anonymous-signup throttle below. Optional in the signature only so a direct
   * service call in a test or a script is not forced to invent one — the HTTP
   * path always supplies it.
   */
  async signup(
    email: string,
    password: string,
    planKey?: string,
    clientIp?: string,
  ): Promise<CustomerAuthResult> {
    const normalized = email.toLowerCase().trim();
    // Spent BEFORE the duplicate read and before scrypt — the point of the
    // budget is to cap the work an anonymous caller can make this process do,
    // so it has to be charged ahead of the work, not after a happy path.
    await this.throttleSignup(clientIp, normalized);
    const { grantedPlanKey, intendedPlanKey } = this.resolveSignupPlan(planKey);

    const existing = await this.customers.findOne({ email: normalized }).lean().exec();
    if (existing) throw new ConflictException({ error: 'An account with that email already exists' });

    // The code is BOUND to the address it is minted for — see
    // `encodeVerification`. At signup that is the account's own address.
    const verification = this.mintVerificationCode(normalized);
    let created;
    try {
      created = await this.customers.create({
        // `name` is required on the schema and is what the admin panel lists
        // clients by; a self-serve account has no separate display name.
        name: normalized,
        email: normalized,
        planKey: grantedPlanKey,
        origin: 'self_serve',
        passwordHash: hashPassword(password),
        // NEVER stamped without a real verification. This used to be set to
        // `now` whenever the flag was off, which asserted an address nobody had
        // proved — and SSO then trusted that assertion: an attacker could
        // pre-register victim@corp.com, and the victim's later provider-verified
        // sign-in MERGED them into the attacker's account (which kept its
        // password). `emailVerifiedAt` must mean "we proved this", so with no
        // mail transport it stays null and the SSO collision path demands an
        // explicit, authenticated link instead. See IdentityService.resolveLogin.
        emailVerifiedAt: undefined,
        emailVerificationTokenHash: verification?.stored,
        emailVerificationExpiresAt: verification?.expiresAt,
        // Entitlement is NEVER taken from the client: a paid plan is only
        // remembered here and granted once a payment confirms.
        intendedPlanKey,
      });
    } catch (err) {
      // The partial-unique email index is the real race guard; the read above
      // only buys a friendlier message on the common path.
      if (isDuplicateKeyError(err)) {
        throw new ConflictException({ error: 'An account with that email already exists' });
      }
      throw err;
    }

    // Awaited, but incapable of failing the signup: `deliverVerificationCode`
    // resolves whether the mail went out, bounced off the provider or fell back
    // to the console. The account already exists at this point either way.
    if (verification) await this.deliverVerificationCode(normalized, verification.raw);

    // NEVER `created.toObject()` — `select: false` is a query projection and a
    // freshly-created document carries every path that was set, hashes included.
    const customer = toPublicCustomer({
      id: String(created._id),
      email: normalized,
      planKey: grantedPlanKey,
      emailVerifiedAt: created.emailVerifiedAt,
      status: 'active',
    });
    return { token: await this.sign(customer), customer };
  }

  /**
   * `clientIp` is the caller's address (`@Ip()` at the controller) and feeds the
   * per-IP login bucket. Optional in the signature only so a direct service call
   * in a test or a script is not forced to invent one — the HTTP path always
   * supplies it, and without it the IP bucket is simply never charged.
   */
  async login(email: string, password: string, clientIp?: string): Promise<CustomerAuthResult> {
    const normalized = email.toLowerCase().trim();
    const limiterKey = `${LIMITER_REALM}:${normalized}`;
    await this.throttleLogin(limiterKey, clientIp);
    // `passwordHash` is `select: false`, so it must be asked for explicitly.
    // Hydrated (not `.lean()`) because `lastLoginAt` is written back.
    const customer = await this.customers.findOne({ email: normalized }).select('+passwordHash').exec();
    // The KDF runs whether or not the address exists. The old shape
    // short-circuited on `!customer`, so a miss answered in microseconds and a
    // hit ~18ms later: an anonymous caller could enumerate registered addresses
    // off the clock alone.
    //
    // Three things not to "simplify":
    //  - `!customer ||` is LOAD-BEARING for type narrowing — `customer` is used
    //    unguarded on every line below. Dropping it does not just weaken the
    //    check, it fails to compile.
    //  - this NARROWS the channel, it does not close it: the `findOne` itself is
    //    still faster on a miss than on a hit, so a residual delta remains.
    //  - signup answers 409 for an address that already exists, which leaks the
    //    same existence fact outright to an anonymous caller. Until that is
    //    fixed this is defence-in-depth, not a complete anti-enumeration story
    //    (noted as a follow-up).
    // And the cost of doing the work unconditionally is that EVERY failed login
    // now burns ~18ms of synchronous event loop, which is precisely why
    // `loginIpLimiter` above is a DoS control rather than a nicety.
    const passwordOk = verifyPassword(password, customer?.passwordHash ?? DUMMY_PASSWORD_HASH);
    if (!customer || !passwordOk) {
      throw new UnauthorizedException({ error: 'Invalid email or password' });
    }
    // Refuse at the door rather than handing out a token every route then 403s.
    if (customer.status !== 'active') {
      throw new ForbiddenException({ error: 'This account is suspended — contact support.' });
    }
    customer.lastLoginAt = new Date();
    await customer.save();
    // ONLY the address bucket is reset on success. The per-IP bucket
    // deliberately survives: it exists to bound the CPU one source can spend on
    // failed logins, and clearing it here would let an attacker who owns a
    // single valid account wipe their own spray budget on demand — one cheap
    // successful login every 19 guesses and the limiter never fires.
    await this.loginLimiter.delete(limiterKey);

    const publicCustomer = toPublicCustomer({
      id: String(customer._id),
      email: customer.email,
      planKey: customer.planKey,
      emailVerifiedAt: customer.emailVerifiedAt,
      status: customer.status,
    });
    return { token: await this.sign(publicCustomer), customer: publicCustomer };
  }

  /**
   * Change a signed-in customer's password. Stamps `passwordChangedAt`, which
   * `CustomerJwtGuard` compares against every token's `iat` — so this also ends
   * every PORTAL SESSION, INCLUDING the one that performed the change (no new
   * token is issued, so the next portal request lands on the login page). It
   * revokes no API key; see the note at the same write in `resetPassword`.
   */
  async changePassword(
    customerId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ ok: true }> {
    // The same floor `resetPassword` enforces, and for the same reason: this
    // route had no length check at all, so "different from the current one" was
    // the entire policy and a one-character password satisfied it. Charged
    // before the read, so a rejected password costs no query.
    assertPasswordPolicy(newPassword);
    if (newPassword === currentPassword) {
      throw new BadRequestException({ error: 'Choose a password different from your current one' });
    }
    const customer = await this.byId(customerId, '+passwordHash');
    if (!verifyPassword(currentPassword, customer.passwordHash)) {
      throw new UnauthorizedException({ error: 'Current password is incorrect' });
    }
    // Update operators rather than a hydrated `save()`: three of these paths are
    // `select: false`, so they are not loaded and cannot be assigned on a doc.
    await this.customers
      .updateOne(
        { _id: customer._id },
        {
          $set: { passwordHash: hashPassword(newPassword), passwordChangedAt: new Date() },
          // A pending reset link must not survive a password the owner just set.
          $unset: { passwordResetTokenHash: '', passwordResetExpiresAt: '' },
        },
      )
      .exec();
    return { ok: true };
  }

  /**
   * Start a password reset. ANONYMOUS, and it ALWAYS answers `{ ok: true }`.
   *
   * THE UNIFORM ANSWER IS THE FEATURE, not laziness. Unknown address, known but
   * unverified address, address staged in `pendingEmail`, suspended account and
   * a mail transport that is not configured all return exactly this: the same
   * status and the same body, and every rate-limit bucket is charged the same
   * way whether or not the address exists. Anything else re-opens the
   * account-enumeration oracle this service just spent a pass closing on login
   * (see `DUMMY_PASSWORD_HASH`) — and on an unauthenticated route, "does
   * ceo@bigcorp.com bank here" is answerable by anyone with curl. Do NOT
   * "improve" any branch below into a helpful 404 or a "please verify first".
   *
   * WHAT IT IS NOT is constant-time, and the gap is not a micro-delta worth
   * hand-waving: a hit awaits a Mongo write AND a live Resend HTTP round trip
   * before answering, while a miss returns straight after the `findOne`. That is
   * tens to hundreds of milliseconds of difference, measurable over the network
   * without credentials — a working enumeration oracle read off the clock rather
   * than off the body. The status and body are uniform; the TIMING is not, and
   * this doc used to claim otherwise. The fix is structural, not a sleep: hand
   * delivery to a queue and answer before it runs, so the response is emitted at
   * the same point on both paths. See the RESIDUAL note at the bottom of the
   * method, which has always described this honestly.
   *
   * `clientIp` is the caller's address (`@Ip()` at the controller). Optional in
   * the signature only so a direct service call in a test or a script is not
   * forced to invent one — the HTTP path always supplies it.
   */
  async requestPasswordReset(email: string, clientIp?: string): Promise<{ ok: true }> {
    // Normalized exactly as signup and login do it — the limiter key has to be
    // the canonical address or two spellings of one mailbox get two budgets, and
    // the lookup has to agree with the unique index about what "the same
    // address" means.
    const normalized = email.toLowerCase().trim();
    // Spent BEFORE the read and before the mail, so the budget caps the work
    // rather than being charged after it — and so the throttle's own timing is
    // identical whether or not the address turns out to exist.
    await this.throttlePasswordReset(normalized, clientIp);

    // Matched on `email` and NEVER on `pendingEmail`. A pending address is a
    // CLAIM, not proof (see `Customer.pendingEmail`), so mailing a reset to one
    // would let anybody who staged victim@corp.com on their own account collect
    // a credential for it — the promotion path `setEmail` was deliberately made
    // to fail closed, rebuilt on a route that needs no session at all.
    const customer = await this.customers.findOne({ email: normalized }).lean().exec();

    // Four conditions, all of them refusals, all of them silent TO THE CALLER
    // and every one of them logged HERE, server-side, naming the reason.
    //
    // The uniform 202 is deliberate (see the doc above) but it made this flow
    // undiagnosable from BOTH ends: the customer sees "check your inbox" and no
    // mail arrives, and the operator they complain to has no record of which of
    // four branches refused — or that a refusal happened at all. The log line is
    // the only diagnosis that exists. `debug` and not `warn`, because these are
    // ordinary outcomes on a public route (a typo'd address hits the first one
    // all day) and a level that fires constantly is a level nobody reads.
    //
    // NEVER put any of this in the response. The reason IS the enumeration
    // oracle; it is safe here only because "here" is a server log.
    if (!customer) {
      this.logger.debug(`Password reset refused: no account for ${normalized}`);
      return { ok: true };
    }
    // A reset is a way back in, and a suspended tenant must not have one
    // (`login` and `CustomerJwtGuard` both refuse them already).
    if (customer.status !== 'active') {
      this.logger.debug(`Password reset refused: account ${String(customer._id)} is suspended`);
      return { ok: true };
    }
    // A wallet-only (SIWE) account has no address — nowhere to send it. Also
    // load-bearing for type narrowing: `email` is optional on the lean row and
    // is passed as a recipient below.
    if (!customer.email) {
      this.logger.debug(
        `Password reset refused: account ${String(customer._id)} has no email address`,
      );
      return { ok: true };
    }
    // Address never proved. `emailVerifiedAt` is the only record that anyone
    // demonstrated they receive mail there, and a reset link is a full account
    // credential — sending one to an unproven address hands the account to
    // whoever typed it at signup.
    //
    // KNOWN CONSEQUENCE, written down so it is a decision and not an accident:
    // this gate makes password reset a PERMANENT, SILENT no-op for whole classes
    // of account, not a "verify first and come back" speed bump.
    //  - With `CUSTOMER_EMAIL_VERIFICATION_REQUIRED` off, `mintVerificationCode`
    //    returns undefined at signup and `resendVerification` returns early, so
    //    NO self-serve account in that deployment ever gets `emailVerifiedAt`
    //    stamped — and therefore NONE of them can ever reset a password.
    //  - An admin-created customer is in the same position: nothing in the admin
    //    path proves the address either.
    // The only unconditional route to a stamp is `setEmail` (it mints with
    // `force`), and that route needs a session — which is precisely what the
    // person locked out does not have.
    //
    // Weakening this gate is NOT the fix; mailing a credential to an unproven
    // address is the takeover described above. The fix is one of: require
    // verification in every deployment, or give operators an explicit "mark this
    // address verified" action. Neither is done here.
    if (!customer.emailVerifiedAt) {
      this.logger.debug(
        `Password reset refused: account ${String(customer._id)} has no verified email address`,
      );
      return { ok: true };
    }

    // Delivered raw exactly once, stored only as a digest — same discipline as
    // an API key and as the OTP: nothing that reads the database later can
    // reconstruct a live reset link, so a leaked backup is not a set of keys to
    // every account.
    const raw = randomBytes(PASSWORD_RESET_TOKEN_BYTES).toString('base64url');
    // Update operators rather than a hydrated `save()`: `passwordResetTokenHash`
    // is `select: false`, so it is not loaded and cannot be assigned on a doc
    // (the same reason `changePassword` writes this way).
    //
    // A single stored digest means minting a new token INVALIDATES the previous
    // one, so five clicks on "email me a link" leave exactly one live token.
    await this.customers
      .updateOne(
        { _id: customer._id },
        {
          $set: {
            passwordResetTokenHash: hashApiKey(raw),
            passwordResetExpiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
          },
        },
      )
      .exec();

    // Awaited, but incapable of failing the request: `deliverPasswordResetToken`
    // resolves whether the mail went out, bounced off the provider or fell back
    // to the console — mirroring `deliverVerificationCode`, whose totality is
    // load-bearing here for a second reason. A 500 from the mailer would be a
    // response shape that ONLY an existing, verified, active account can
    // produce, i.e. the enumeration oracle the uniform answer above exists to
    // close, reached through the error path instead of the success path.
    //
    // RESIDUAL, stated rather than discovered later: this narrows the timing
    // channel, it does not close it. A hit awaits a write and a provider round
    // trip while a miss returns straight after the read, so the two are still
    // separable by a patient observer with a stopwatch. Closing that means
    // handing delivery to a queue and returning before it runs — noted as a
    // follow-up rather than done here, because a floating promise would drop the
    // logging the fallback path depends on.
    await this.deliverPasswordResetToken(customer.email, raw);
    return { ok: true };
  }

  /**
   * Finish a password reset. ANONYMOUS — the token IS the credential.
   *
   * THE ORDER IS THE DESIGN, and it is the same discipline as the SIWE nonce and
   * the pending-link token: CONSUME FIRST, atomically, before anything about the
   * token is judged. Expiry, account state and the write all happen against a
   * token that is already spent, so a replay — a back button, a mail client
   * prefetching the link, an attacker retrying a copy pulled out of a log —
   * finds nothing and gets the same generic refusal. A peek-then-validate shape
   * would leave a live token behind on every failed attempt.
   *
   * NO SESSION IS RETURNED. Whoever resets signs in again with the new password,
   * which keeps this route incapable of minting a token and means the reset
   * proves control of a mailbox rather than granting a session outright.
   *
   * `clientIp` is the caller's address (`@Ip()` at the controller) and feeds the
   * per-IP confirm budget. Optional in the signature only so a direct service
   * call in a test or a script is not forced to invent one — the HTTP path
   * always supplies it, and without it the bucket is simply never charged.
   */
  async resetPassword(
    token: string,
    newPassword: string,
    clientIp?: string,
  ): Promise<{ ok: true }> {
    // Spent BEFORE the query, and the query is why the bucket exists: the filter
    // below is on `passwordResetTokenHash` from an ANONYMOUS route, so every
    // junk token an attacker submits — the only kind they can produce — costs a
    // database lookup that nobody had to authenticate to buy.
    await this.throttlePasswordResetConfirm(clientIp);
    // Enforced HERE, and this is the enforcement rather than a second opinion:
    // `ResetPasswordDto`'s length bound is a convenience for the caller, and the
    // global `ValidationPipe` is inert under `tsx` dev, so the DTO may not be
    // running at all. This route sets a password with NO session and NO current
    // password to compare against, which makes it the weakest way into an
    // account if the floor is missing — and it was.
    //
    // Before the consume, deliberately: a customer who types a short password
    // must not spend their one live token discovering it was too short.
    assertPasswordPolicy(newPassword);
    const presented = hashApiKey(token);
    // ATOMIC single-use: the filter matches the digest and the same operation
    // clears it, so exactly one of two concurrent submissions of the same token
    // gets a document back and the loser is told the link is gone.
    //
    // `new: false` — the PRE-image is what carries the values being judged (the
    // post-image has just had them unset). `+passwordResetTokenHash` because the
    // path is `select: false`; every other field read below is in the default
    // projection.
    //
    // The filter field now carries a sparse index (declared in
    // `customer.schema.ts`), so this is a key lookup rather than the full
    // collection scan it used to be. That matters because the route is
    // anonymous: every garbage token paid for a scan, and the per-IP budget
    // charged above is the other half of the same fix. Do not drop either — an
    // unindexed filter on an unauthenticated route is a free denial of service.
    const consumed = await this.customers
      .findOneAndUpdate(
        { passwordResetTokenHash: presented },
        { $unset: { passwordResetTokenHash: '', passwordResetExpiresAt: '' } },
        { new: false },
      )
      .select('+passwordResetTokenHash')
      .lean()
      .exec();
    if (!consumed) throw invalidResetError();

    // Belt to the filter's braces, and NOT redundant in the way it looks: the
    // equality above is Mongo's, performed server-side on an index-shaped
    // comparison we do not control. Re-asserting it here in constant time means
    // that if the filter is ever widened — a regex, an `$in`, a case-insensitive
    // collation — the widening cannot silently become "close enough counts".
    if (!constantTimeEquals(consumed.passwordResetTokenHash ?? '', presented)) {
      throw invalidResetError();
    }

    // Expiry is judged AFTER the token is spent, deliberately: an expired token
    // must be destroyed by the attempt, not left sitting there for a caller who
    // fixes their clock. Missing, unparseable and past all fail closed.
    const expiresAt = msOf(consumed.passwordResetExpiresAt);
    if (expiresAt === undefined || expiresAt <= Date.now()) throw invalidResetError();

    // Re-checked at spend time, not merely at mint time: an account suspended in
    // the half hour since the link was issued must not be walked back in through
    // it. This one is a DISTINGUISHABLE error, and that is correct — the caller
    // has already proved control of the mailbox, so the suspension is their own
    // account's news, not somebody else's. It is the same copy `login` uses.
    if (consumed.status !== 'active') {
      throw new ForbiddenException({ error: 'This account is suspended — contact support.' });
    }

    // `passwordChangedAt` IS the session eviction. `CustomerJwtGuard` compares it
    // against every customer token's `iat`, so writing it invalidates every
    // PORTAL SESSION for this account at once — no token blacklist, no second
    // mechanism. Whoever was signed in, on whatever device, is thrown out by the
    // act of setting the new password rather than left there until their token
    // expires.
    //
    // AND THAT IS ALL IT DOES — this comment used to claim it invalidated "every
    // session in existence", which is false in the case that matters most. When
    // the reset is a recovery from compromise, the attacker's cheapest move was
    // to mint an API key while they were inside, and `/v1` resolves a raw key
    // against that key's own status and NEVER against `passwordChangedAt`, so
    // the key survives the reset untouched. `CustomerJwtGuard` is the only
    // reader of this field.
    //
    // Two ways to close it, neither taken in this pass: revoke the account's
    // self-serve keys here (the real fix, and it belongs to the key service,
    // which this change does not own), or tell the customer. The mail copy does
    // the telling — see `passwordResetEmailText` — and that is a stopgap, not a
    // fix. Do not restore the "everywhere" wording in either place while a key
    // can outlive a reset.
    //
    // The `$unset` repeats what the consume above already did. Cheap, and it
    // keeps this write correct on its own terms — if the consume is ever
    // refactored into a peek, a live token would otherwise survive the very
    // password change that must kill it (the invariant `changePassword` states).
    await this.customers
      .updateOne(
        { _id: consumed._id },
        {
          $set: { passwordHash: hashPassword(newPassword), passwordChangedAt: new Date() },
          $unset: { passwordResetTokenHash: '', passwordResetExpiresAt: '' },
        },
      )
      .exec();
    return { ok: true };
  }

  /**
   * Consume a 6-digit verification code.
   *
   * `customerId` is REQUIRED. There used to be an anonymous fallback that found
   * the account by hashing the code and scanning, and it was removed rather than
   * fixed:
   *  - the route is guarded, so nothing could reach it;
   *  - a six-digit code's only real defence is the PER-CODE attempt cap, and a
   *    wrong code matched no document anonymously, so there was no counter to
   *    charge — the cap silently did not apply on that path;
   *  - it stamped the proof without promoting a staged `pendingEmail`, quietly
   *    marking the OLD address verified.
   * Under an OTP the code is typed in the session that asked for it, so there is
   * no case left to serve. Do not reintroduce it without the cap and promotion.
   */
  async verifyEmail(
    code: string,
    customerId: string,
    clientIp?: string,
  ): Promise<{ ok: true; customer: PublicCustomer }> {
    await this.throttleVerification(customerId, clientIp);
    return this.verifyForCustomer(customerId, code);
  }

  /** Mint and send a fresh verification code for the signed-in customer. */
  /**
   * `delivered` is absent on the early-return paths (nothing was sent because
   * nothing needed sending) and boolean when a code was actually minted. The
   * portal treats only an explicit `false` as a problem — see `VerifyEmailGate`.
   */
  async resendVerification(
    customerId: string,
    clientIp?: string,
  ): Promise<{ ok: true; delivered?: boolean }> {
    // Nothing to send, and nothing gates on it — succeed silently so the portal
    // needs no knowledge of whether the mailer exists.
    if (!isEmailVerificationRequired(this.config)) return { ok: true };
    await this.throttleResend(customerId, clientIp);
    const customer = await this.byId(customerId);
    if (customer.emailVerifiedAt) return { ok: true }; // already done; idempotent

    // THE RECIPIENT IS THE ADDRESS THE OUTSTANDING CLAIM IS FOR — pending
    // first, and only then the account's own address.
    //
    // This used to mail `customer.email ?? customerId`, which was an account
    // takeover: stage victim@corp.com on an unverified account via `setEmail`,
    // then call resend and the fresh code arrives at YOUR address, because the
    // account's own `email` was still yours. `verifyForCustomer` promotes
    // `pendingEmail` on any hash match, so submitting it stamped
    // `emailVerifiedAt` on the victim's address — and rule (b) of
    // `IdentityService.resolveLogin` auto-links a genuine provider sign-in into
    // any account whose `emailVerifiedAt` is set. The victim's real SSO login
    // then lands in the attacker's account.
    //
    // `?? customerId` was its own bug: a wallet-only account has no address, so
    // the mailer was handed a raw ObjectId as a recipient.
    //
    // Resolved BEFORE minting, deliberately: an account with no address at all
    // must not burn (and thereby invalidate) whatever code is already
    // outstanding just to discover there is nowhere to send a new one.
    const recipient = customer.pendingEmail ?? customer.email;
    if (!recipient) return { ok: true };

    const verification = this.mintVerificationCode(recipient);
    if (!verification) return { ok: true };
    // Minting a NEW code invalidates the previous one — a single stored hash
    // means only the most recent code works, and the fresh `:0` suffix resets
    // the attempt counter along with it.
    await this.customers
      .updateOne(
        { _id: customer._id },
        {
          $set: {
            emailVerificationTokenHash: verification.stored,
            emailVerificationExpiresAt: verification.expiresAt,
          },
        },
      )
      .exec();
    const delivered = await this.deliverVerificationCode(recipient, verification.raw);
    // `delivered: false` means the code IS valid and stored — it just never left
    // the building. The caller must not be told to check an inbox that will stay
    // empty, and must not be told the code is broken either.
    return { ok: true, delivered };
  }

  /**
   * Set — or change — the caller's own email address.
   *
   * Exists because a wallet (SIWE) signup creates a customer with NO email at
   * all, which makes renewal notices and password reset structurally
   * undeliverable; the profile was read-only, so there was no way to add one.
   *
   * THE RULE THAT MATTERS: the address ALWAYS lands UNVERIFIED, including when
   * it replaces an already-verified one. Writing an address is a CLAIM, never
   * proof, and `emailVerifiedAt` is trusted as proof elsewhere — rule (b) of
   * `IdentityService.resolveLogin` auto-links a provider identity into an
   * account whose `emailVerifiedAt` is set. Stamping it here would rebuild, on
   * an authenticated route, exactly the pre-registration takeover this codebase
   * already fixed once: claim victim@corp.com, inherit the victim's genuine SSO
   * sign-in. `customerId` comes from the token and only from the token.
   */
  async setEmail(customerId: string, email: string): Promise<PublicCustomer> {
    // Normalized exactly as signup does it, or the unique index and the login
    // lookup would disagree about what "the same address" means.
    const normalized = email.toLowerCase().trim();
    const id = toObjectId(customerId);

    // Spent BEFORE the duplicate read, because the read is the oracle: a 409
    // tells the caller that SOMEONE holds that address, so the probe has to be
    // charged whether or not the address turns out to be free. Its own budget,
    // never the resend one — see `emailProbeLimiter`.
    await this.throttleEmailProbe(customerId);

    // The read only buys a friendlier message on the common path; the partial
    // unique index below is the actual race guard.
    const holder = await this.customers.findOne({ email: normalized }).lean().exec();
    if (holder && String(holder._id) !== String(id)) {
      throw new ConflictException({ error: 'An account with that email already exists' });
    }

    // Charged against the RESEND budget on purpose: minting a code here sends
    // the same mail `resend-verification` does, so an unthrottled profile edit
    // would be a free way around that budget.
    await this.throttleResend(customerId, undefined);

    // ALWAYS minted, regardless of `CUSTOMER_EMAIL_VERIFICATION_REQUIRED`.
    // That flag governs whether an unverified SIGNUP is locked out of the
    // portal; it must not govern whether changing the address is proved. An
    // unproven address written on request is the squat described on
    // `Customer.pendingEmail`, and with no mailer the code still reaches the
    // operator through the dev log below.
    // Bound to the address being CLAIMED, not to the one the account currently
    // holds — that binding is what `verifyForCustomer` checks before promoting.
    const verification = this.mintVerificationCode(normalized, true);

    // STAGED, NOT COMMITTED. `email` and `emailVerifiedAt` are untouched: the
    // claim lands in `pendingEmail` and is promoted by `verifyForCustomer` only
    // once the code comes back. Two consequences worth keeping:
    //  - a typo cannot cost you the verified address you already had, and
    //  - an unproven claim never occupies the unique-indexed `email`, so it
    //    cannot lock the rightful owner out of registering.
    const set: Record<string, unknown> = {
      pendingEmail: normalized,
      emailVerificationTokenHash: verification!.stored,
      emailVerificationExpiresAt: verification!.expiresAt,
    };
    // A live reset token dies the moment the customer starts moving the address,
    // not when the move completes. The outstanding link was mailed to the
    // address on file; from here on the customer is telling us that mailbox is
    // no longer the one they want the account reachable at, and a token sitting
    // in it is a spendable credential for up to `PASSWORD_RESET_TTL_MS`. Cleared
    // even though the promotion in `verifyForCustomer` clears it too — this
    // route completes without the promotion whenever the code is never entered,
    // which is exactly the abandoned-change case where the old mailbox is most
    // likely to be the compromised one.
    const unset: Record<string, string> = {
      passwordResetTokenHash: '',
      passwordResetExpiresAt: '',
    };

    let updated;
    try {
      updated = await this.customers
        .findOneAndUpdate({ _id: id }, { $set: set, $unset: unset }, { new: true })
        .lean()
        .exec();
    } catch (err) {
      // E11000 from the partial-unique email index — the concurrent-claim case
      // the read above cannot see.
      if (isDuplicateKeyError(err)) {
        throw new ConflictException({ error: 'An account with that email already exists' });
      }
      throw err;
    }
    if (!updated) throw new NotFoundException({ error: 'Account not found' });

    // The claim is already staged in `pendingEmail`; a mail failure must not
    // undo that or 500 the profile edit, so this only ever logs.
    if (verification) await this.deliverVerificationCode(normalized, verification.raw);
    return toPublicCustomer({
      id: String(updated._id),
      email: updated.email,
      pendingEmail: updated.pendingEmail,
      planKey: updated.planKey,
      emailVerifiedAt: updated.emailVerifiedAt,
      status: updated.status,
    });
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  /**
   * The anonymous-signup budget, keyed on the CLIENT IP. Deliberately not the
   * email: an attacker varies that for free, so an email key throttles nothing.
   *
   * Its own `signup:` namespace under `LIMITER_REALM`, so it can neither drain
   * nor be drained by the login (10/5min) or resend (5/hr) budgets — those key
   * on an email and a customer id respectively, and a collision between two of
   * them would let one route lock a customer out of another.
   *
   * DEGRADATION: when there is no usable IP — none supplied, or a proxy hop
   * that collapses every visitor onto one address — we do NOT fall back to a
   * single shared bucket. Five requests would then lock every legitimate signup
   * out for an hour and the guard would become the outage it exists to prevent.
   * The fallback is per-email: weaker against a varied-email flood, but it can
   * only ever spend the budget of the address it was spent on.
   */
  private async throttleSignup(clientIp: string | undefined, email: string): Promise<void> {
    const ip = normalizeClientIp(clientIp);
    const key = ip
      ? `${LIMITER_REALM}:signup:ip:${ip}`
      : `${LIMITER_REALM}:signup:email:${email}`;
    try {
      await this.signupLimiter.consume(key, 1);
    } catch {
      throw new HttpException(
        { error: 'Too many signup attempts. Try again later.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * THE signup entitlement rule: a plan asked for by the client grants access
   * only when it costs nothing. Anything payable is remembered as
   * `intendedPlanKey` (which grants nothing) and drives the checkout redirect —
   * trusting the request body here would make every paid tier free.
   *
   * An unknown, disabled or sales-led key is ignored rather than rejected: a
   * stale link from the pricing page must not block a signup.
   */
  private resolveSignupPlan(requested?: string): { grantedPlanKey: string; intendedPlanKey?: string } {
    const key = requested?.trim();
    if (!key) return { grantedPlanKey: DEFAULT_PLAN_KEY };
    const plan = this.settings.getPlan(key);
    if (!plan || !plan.enabled || !plan.selfServe) return { grantedPlanKey: DEFAULT_PLAN_KEY };
    if (isFreePlan(plan)) return { grantedPlanKey: plan.key };
    return { grantedPlanKey: DEFAULT_PLAN_KEY, intendedPlanKey: plan.key };
  }

  /**
   * The ACCOUNT-SCOPED verification path — the one with a working attempt cap.
   *
   * Read-then-write rather than one atomic match, because a wrong code has to
   * increment a counter on a specific document and a filter that matched the
   * code would (by definition) never match a wrong one. The race it opens is
   * benign: two concurrent submissions of the same correct code both verify,
   * which is the same answer.
   */
  private async verifyForCustomer(
    customerId: string,
    code: string,
  ): Promise<{ ok: true; customer: PublicCustomer }> {
    const customer = await this.byId(customerId, '+emailVerificationTokenHash');
    const outstanding = decodeVerification(customer.emailVerificationTokenHash);
    const expiresAt = msOf(customer.emailVerificationExpiresAt);
    const live =
      outstanding !== undefined &&
      expiresAt !== undefined &&
      expiresAt > Date.now() &&
      outstanding.attempts < MAX_VERIFICATION_ATTEMPTS;

    if (!live) {
      // Sweep a dead code away so an expired or burnt-out hash can never be
      // revived by a clock change or a later schema tweak.
      if (outstanding !== undefined) await this.clearVerification(customer._id);
      throw invalidCodeError();
    }

    if (constantTimeEquals(outstanding.hash, hashApiKey(code))) {
      // THE PROMOTION. A staged `pendingEmail` becomes the real address here and
      // nowhere else — this is the only point at which anyone has proved they
      // receive mail at it. Accounts verifying an address they already hold
      // (ordinary signup) have no pending claim, so `email` is left alone.
      const set: Record<string, unknown> = { emailVerifiedAt: new Date() };
      // Single use: the hash, the deadline AND the counter all go, so a replay
      // of the same code finds nothing and gets the same generic error.
      const unset: Record<string, string> = {
        emailVerificationTokenHash: '',
        emailVerificationExpiresAt: '',
      };
      // THE BINDING CHECK, and it fails CLOSED on purpose.
      //
      // A correct code alone proves only that the submitter read SOME mail we
      // sent; it says nothing about WHICH address that mail went to. Promotion
      // and the `emailVerifiedAt` stamp are both claims of proof, and rule (b)
      // of `IdentityService.resolveLogin` auto-links a provider sign-in into any
      // account carrying that stamp — so a code issued for one address must
      // never be spendable against another.
      //
      // NOTE there is deliberately NO legacy grace for `target === undefined`.
      // An unbound slot proves control of neither address, and granting it a
      // grace window would keep the takeover alive after deploy for anyone
      // holding a code minted by the old build. Those customers request a new
      // code; that is the whole cost.
      if (customer.pendingEmail && sameAddress(outstanding.target, customer.pendingEmail)) {
        set.email = customer.pendingEmail;
        unset.pendingEmail = '';
        // The account's address CHANGES on this branch, so any live reset token
        // has to die with it: that link was mailed to the PREVIOUS address, and
        // leaving it spendable means whoever still reads that mailbox can take
        // the account for up to `PASSWORD_RESET_TTL_MS` after it stopped being
        // theirs. Same invariant `changePassword` keeps, applied to the other
        // way the address a reset was authorised against can stop being current.
        unset.passwordResetTokenHash = '';
        unset.passwordResetExpiresAt = '';
      } else if (!sameAddress(outstanding.target, customer.email)) {
        // Not for the pending address and not for the current one. Burn it and
        // answer with the same generic error every other failure returns —
        // WITHOUT stamping `emailVerifiedAt`, because stamping it here would
        // assert proof of an address this code never went to.
        await this.clearVerification(customer._id);
        throw invalidCodeError();
      }

      let updated;
      try {
        updated = await this.customers
          .findOneAndUpdate({ _id: customer._id }, { $set: set, $unset: unset }, { new: true })
          .lean()
          .exec();
      } catch (err) {
        // Someone else verified this address between the claim and the proof.
        // The unique index is the arbiter — first to PROVE it wins — and the
        // loser keeps their pending claim so the error is actionable.
        if (isDuplicateKeyError(err)) {
          throw new ConflictException({ error: 'An account with that email already exists' });
        }
        throw err;
      }
      if (!updated) throw invalidCodeError();
      return {
        ok: true,
        customer: toPublicCustomer({
          id: String(updated._id),
          email: updated.email,
          pendingEmail: updated.pendingEmail,
          planKey: updated.planKey,
          emailVerifiedAt: updated.emailVerifiedAt,
          status: updated.status,
        }),
      };
    }

    const attempts = outstanding.attempts + 1;
    if (attempts >= MAX_VERIFICATION_ATTEMPTS) {
      // Budget spent — destroy the code. The customer must request a new one,
      // which resets the counter to 0 along with the hash.
      await this.clearVerification(customer._id);
    } else {
      await this.customers
        .updateOne(
          { _id: customer._id },
          {
            $set: {
              // The TARGET is re-emitted, not dropped. Re-encoding without it
              // would unbind the code on the first wrong digit, and an unbound
              // code fails closed above — one typo would kill a code that is
              // otherwise still live and within its attempt budget.
              emailVerificationTokenHash: encodeVerification(
                outstanding.hash,
                attempts,
                outstanding.target,
              ),
            },
          },
        )
        .exec();
    }
    throw invalidCodeError();
  }

  /**
   * Destroy the outstanding code: the hash, the deadline AND (because they share
   * one field) the attempt counter and the target address.
   *
   * Called on every terminal verification outcome — expired, burnt out, bound to
   * the wrong address, budget just spent — so a dead code can never be revived by
   * a clock change or a later schema tweak. It deliberately does NOT touch
   * `pendingEmail`: the claim outlives the code, so the customer requests a new
   * one rather than retyping the address.
   *
   * (This docblock used to describe an anonymous "code-only fallback" and an
   * `$in` over attempt encodings. Both were deleted with the unauthenticated
   * verify path — see `verifyEmail` — and the stale text outlived them.)
   */
  private async clearVerification(id: unknown): Promise<void> {
    await this.customers
      .updateOne(
        { _id: id },
        { $unset: { emailVerificationTokenHash: '', emailVerificationExpiresAt: '' } },
      )
      .exec();
  }

  /**
   * Spend the verification budgets. Every bucket that has a usable key is
   * charged; the shared anonymous bucket is used ONLY when there is neither an
   * account nor an IP, so a normal authenticated attempt never touches it.
   */
  private async throttleVerification(
    customerId: string | undefined,
    clientIp: string | undefined,
  ): Promise<void> {
    const ip = normalizeClientIp(clientIp);
    const buckets: Array<[AuthLimiter, string]> = [];
    if (customerId) {
      buckets.push([this.verifyAccountLimiter, `${LIMITER_REALM}:verify:acct:${customerId}`]);
    }
    if (ip) buckets.push([this.verifyIpLimiter, `${LIMITER_REALM}:verify:ip:${ip}`]);
    if (buckets.length === 0) {
      buckets.push([this.verifyAnonymousLimiter, `${LIMITER_REALM}:verify:anon`]);
    }
    for (const [limiter, key] of buckets) {
      try {
        await limiter.consume(key, 1);
      } catch {
        throw new HttpException(
          { error: 'Too many verification attempts. Try again in a few minutes.' },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
  }

  /**
   * Per-address (10/5min) plus, when we know it, per-IP (20/5min) login budget.
   *
   * `addressKey` is already namespaced by the caller so the counter it spends is
   * the same one a successful login resets.
   *
   * DEGRADATION, same rule as `throttleSignup`: with no usable IP we fall back
   * to the address bucket ALONE — there is deliberately no shared last-resort
   * bucket here. One misconfigured proxy hop collapses every visitor onto one
   * key, and a shared 20-point bucket would then lock every customer in the
   * world out of logging in.
   *
   * Both buckets raise the SAME 429 body login has always returned, so the
   * response cannot be used to tell which budget was exhausted.
   */
  private async throttleLogin(addressKey: string, clientIp: string | undefined): Promise<void> {
    const ip = normalizeClientIp(clientIp);
    const buckets: Array<[AuthLimiter, string]> = [[this.loginLimiter, addressKey]];
    if (ip) buckets.push([this.loginIpLimiter, `${LIMITER_REALM}:login:ip:${ip}`]);
    for (const [limiter, key] of buckets) {
      try {
        await limiter.consume(key, 1);
      } catch {
        throw new HttpException(
          { error: 'Too many login attempts. Try again in a few minutes.' },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
  }

  /**
   * Spend one address-collision probe for `setEmail`. Keyed on the customer id
   * (the route is authenticated, so there is always one) and under its own
   * `probe:` namespace, so it can neither drain nor be drained by the resend
   * mail budget.
   */
  private async throttleEmailProbe(customerId: string): Promise<void> {
    try {
      await this.emailProbeLimiter.consume(`${LIMITER_REALM}:probe:${customerId}`, 1);
    } catch {
      throw new HttpException(
        { error: 'Too many email address changes. Try again later.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** Per-account (5/hr) plus, when we know it, per-IP (20/hr) mail budget. */
  private async throttleResend(customerId: string, clientIp: string | undefined): Promise<void> {
    const ip = normalizeClientIp(clientIp);
    const buckets: Array<[AuthLimiter, string]> = [
      [this.resendLimiter, `${LIMITER_REALM}:resend:${customerId}`],
    ];
    if (ip) buckets.push([this.resendIpLimiter, `${LIMITER_REALM}:resend:ip:${ip}`]);
    for (const [limiter, key] of buckets) {
      try {
        await limiter.consume(key, 1);
      } catch {
        throw new HttpException(
          { error: 'Too many verification emails requested. Try again later.' },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
  }

  /**
   * Per-address (5/hr) plus, when we know it, per-IP (20/hr) password-reset
   * budget. Shaped after `throttleResend` because it spends the same thing.
   *
   * DEGRADATION, the same rule as `throttleSignup` and `throttleLogin`: with no
   * usable IP we fall back to the address bucket ALONE, and there is deliberately
   * NO shared last-resort bucket. One misconfigured proxy hop collapses every
   * visitor onto one key, and a shared bucket would then take password reset
   * away from every customer in the world — the guard becoming the outage it
   * exists to prevent.
   *
   * Both buckets raise the SAME 429 body, so the response cannot be used to tell
   * WHICH budget was exhausted.
   *
   * IT DOES NOT HIDE THAT ONE WAS, and the earlier claim that a 429 "cannot be
   * used to probe whether anyone else has been asking about this address" was
   * wrong. The address bucket is shared across requesters — that is the whole
   * point of it, otherwise a rotating IP pool would mail-bomb one inbox freely —
   * so a 429 on a caller's FIRST request for an address says somebody else asked
   * about that address in the last hour.
   *
   * What leaks is reset ACTIVITY, not account EXISTENCE: both buckets are
   * charged identically for an address with no account behind it, so the 429
   * says nothing about whether the address is registered. That is the accepted
   * trade — the alternative is an unbounded mail cannon aimed at a chosen inbox
   * from our domain.
   */
  private async throttlePasswordReset(email: string, clientIp: string | undefined): Promise<void> {
    const ip = normalizeClientIp(clientIp);
    const buckets: Array<[AuthLimiter, string]> = [
      [this.passwordResetLimiter, `${LIMITER_REALM}:reset:email:${email}`],
    ];
    if (ip) buckets.push([this.passwordResetIpLimiter, `${LIMITER_REALM}:reset:ip:${ip}`]);
    for (const [limiter, key] of buckets) {
      try {
        await limiter.consume(key, 1);
      } catch {
        throw new HttpException(
          { error: 'Too many password reset requests. Try again later.' },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }
  }

  /**
   * Spend one password-reset CONFIRM attempt, keyed on the client IP — the only
   * key the request carries (see `passwordResetConfirmIpLimiter`).
   *
   * DEGRADATION, the same rule as `throttleSignup`, `throttleLogin` and
   * `throttlePasswordReset`: with no usable IP this charges NOTHING rather than
   * falling back to a shared bucket. Here the rule bites harder than it does
   * there, because there is no second key to degrade onto — a shared bucket
   * would BE the route's entire budget, so one misconfigured proxy hop
   * collapsing every visitor onto one address would take password reset away
   * from every customer in the world at once. The guard must not become the
   * outage it exists to prevent.
   *
   * The sparse index on `passwordResetTokenHash` is what makes failing open here
   * tolerable: with the lookup indexed, the worst an unthrottled flood buys is a
   * key lookup that misses, not a scan of `customers`.
   */
  private async throttlePasswordResetConfirm(clientIp: string | undefined): Promise<void> {
    const ip = normalizeClientIp(clientIp);
    if (!ip) return;
    try {
      await this.passwordResetConfirmIpLimiter.consume(
        `${LIMITER_REALM}:reset:confirm:ip:${ip}`,
        1,
      );
    } catch {
      // Deliberately NOT `invalidResetError()`: a 400 "invalid or expired link"
      // would tell a throttled customer their link is dead and send them to
      // request another, spending the request budget as well. 429 is the honest
      // answer and it leaks nothing about the token.
      throw new HttpException(
        { error: 'Too many password reset attempts. Try again in a few minutes.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * A fresh 6-digit code plus the string actually stored.
   *
   * `randomInt` (node:crypto), NEVER `Math.random` — a predictable PRNG makes
   * the code guessable in one attempt regardless of every other control here,
   * and `Math.random`'s state is recoverable from a handful of outputs. Zero
   * padded, so `000042` is a legal code and the space really is 10^6.
   *
   * MERGED FROM TWO STACKED BLOCKS. Both used to sit here and TypeScript only
   * takes the LAST one, so the `randomInt` rationale above was invisible to
   * every editor and every hover. Keep this as one block.
   *
   * @param target the address this code PROVES CONTROL OF, packed into the
   *   stored value and re-checked at verification time. Required and non-empty:
   *   an unbound code proves control of nothing, and `verifyForCustomer` fails
   *   closed on one, so silently minting an unbound code from a degenerate
   *   caller would hand the customer a code that can never work.
   * @param force mint even when `CUSTOMER_EMAIL_VERIFICATION_REQUIRED` is off.
   *   Used by `setEmail`: that flag decides whether an unverified SIGNUP is
   *   locked out of the portal, not whether a claimed address gets proved.
   *   Changing an address must always be proved or the claim is a squat.
   */
  private mintVerificationCode(
    target: string,
    force = false,
  ): { raw: string; stored: string; expiresAt: Date } | undefined {
    // THROWS rather than minting an unbound code — see `@param target`. This is
    // a programming error (every call site resolves a real address first), so it
    // must be loud at the point of the mistake, not a code that mysteriously
    // never verifies.
    if (!target || !target.trim()) {
      throw new Error('mintVerificationCode requires the address the code is issued for');
    }
    if (!force && !isEmailVerificationRequired(this.config)) return undefined;
    const raw = String(randomInt(0, 1_000_000)).padStart(VERIFICATION_CODE_DIGITS, '0');
    // SHA-256 via the api-key helper: the raw code is delivered once and never
    // stored. (Passwords use scrypt; six digits would not survive a slow KDF
    // being the ONLY control either, which is why the attempt cap exists.)
    return {
      raw,
      stored: encodeVerification(hashApiKey(raw), 0, target),
      expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS),
    };
  }

  /**
   * Get a freshly minted code to its owner.
   *
   * Two branches, and the fallback is the same console path this service used
   * before a mailer existed:
   *
   *  - MAIL CONFIGURED → send it. A FAILED send falls through to the fallback,
   *    deliberately: a transient provider outage in dev must still leave the
   *    tester a way through, and in production the fallback is a loud ERROR that
   *    names the recipient without printing the code.
   *  - NOT CONFIGURED → unchanged behaviour. Dev logs the code; production logs
   *    the loud error and prints nothing.
   *
   * TOTAL by construction: it never throws, because none of signup / resend /
   * setEmail may fail on account of mail. `MailService.send` already swallows
   * everything, and the `catch` is the belt to that braces.
   */
  private async deliverVerificationCode(recipient: string, raw: string): Promise<boolean> {
    if (!this.mail?.isConfigured()) {
      this.logUndelivered(
        recipient,
        raw,
        `Email verification is enabled but no mail transport is configured — the code for ${recipient} cannot be delivered.`,
      );
      return false;
    }

    let sent = false;
    try {
      sent = await this.mail.send({
        to: recipient,
        subject: VERIFICATION_EMAIL_SUBJECT,
        text: verificationEmailText(raw),
      });
    } catch (err) {
      // `send` is documented never to throw; if that ever changes, a signup must
      // still not 500 over it. NEVER log the error's payload — only the shape.
      const reason = err instanceof Error ? err.name : 'unknown error';
      this.logger.warn(`Mail transport threw for ${recipient} (${reason}) — using the fallback path`);
    }
    if (sent) return true;

    this.logUndelivered(
      recipient,
      raw,
      `Email verification code for ${recipient} could not be delivered — the mail provider did not accept it.`,
    );
    return false;
  }

  /**
   * Get a freshly minted reset LINK to its owner. The sibling of
   * `deliverVerificationCode`, deliberately making the identical `MailService`
   * call with different copy rather than reaching for a new mailer method.
   *
   * TOTAL by construction, for the same reason and one more: `requestPasswordReset`
   * may not fail on account of mail, AND its answer must be the same one an
   * unknown address gets. A throw from here would be a response only a real,
   * verified, active account can produce.
   */
  private async deliverPasswordResetToken(recipient: string, raw: string): Promise<void> {
    const link = this.passwordResetUrl(raw);
    if (!this.mail?.isConfigured()) {
      this.logUndelivered(
        recipient,
        link,
        `A password reset was requested for ${recipient} but no mail transport is configured — the link cannot be delivered.`,
        'Password reset link',
      );
      return;
    }

    let sent = false;
    try {
      sent = await this.mail.send({
        to: recipient,
        subject: PASSWORD_RESET_EMAIL_SUBJECT,
        text: passwordResetEmailText(link),
      });
    } catch (err) {
      // `send` is documented never to throw; if that ever changes, the uniform
      // answer must survive it. NEVER log the error's payload — only the shape,
      // because the payload can carry the recipient and the body back with it.
      const reason = err instanceof Error ? err.name : 'unknown error';
      this.logger.warn(`Mail transport threw for ${recipient} (${reason}) — using the fallback path`);
    }
    if (sent) return;

    this.logUndelivered(
      recipient,
      link,
      `Password reset link for ${recipient} could not be delivered — the mail provider did not accept it.`,
      'Password reset link',
    );
  }

  /**
   * Where the reset link points. Built from `PORTAL_BASE_URL` — the same
   * accessor `IdentityService` builds its callback and ceremony URLs from, and
   * the getter strips any trailing slash, so this concatenation is safe.
   *
   * The token is base64url, so it needs no percent-encoding and the value the
   * customer clicks is byte-identical to the one that was hashed.
   */
  private passwordResetUrl(raw: string): string {
    return `${this.config.portalBaseUrl}/reset-password?token=${raw}`;
  }

  /**
   * The undeliverable-secret path. In dev the value is logged so the flow is
   * exercisable end-to-end; in production it is emphatically NOT logged — the
   * loud error is the point, because an operator whose customers cannot receive
   * a code has locked them out and needs to know, and printing the secret into a
   * shipped log would put a live credential in every log sink.
   *
   * `devLabel` exists so the reset path can reuse this rather than copy it: the
   * production/dev fork is a security gate, and a duplicated gate is one that
   * gets fixed in one place only.
   */
  private logUndelivered(
    recipient: string,
    raw: string,
    productionError: string,
    devLabel = 'Email verification code',
  ): void {
    if (this.config.isProduction) {
      this.logger.error(productionError);
      return;
    }
    this.logger.warn(`[dev] ${devLabel} for ${recipient}: ${raw}`);
  }

  /**
   * Load the caller's own record. Lean throughout — every write in this service
   * touches at least one `select: false` path, so they all go through update
   * operators rather than a hydrated `save()`.
   */
  private async byId(customerId: string, select?: string) {
    const id = toObjectId(customerId);
    const query = this.customers.findById(id);
    if (select) query.select(select);
    const customer = await query.lean().exec();
    if (!customer) throw new NotFoundException({ error: 'Account not found' });
    return customer;
  }

  private sign(customer: PublicCustomer): Promise<string> {
    const payload: CustomerJwtPayload = {
      sub: customer.id,
      email: customer.email,
      typ: CUSTOMER_TOKEN_TYPE,
    };
    // No per-call options: the CUSTOMER_JWT instance carries the customer
    // secret and expiry.
    return this.jwt.signAsync(payload);
  }
}

/**
 * The client IP reduced to a stable limiter key, or `undefined` when there
 * isn't a usable one. Express reports an IPv4 client over a dual-stack socket
 * as `::ffff:1.2.3.4`, so both spellings have to collapse onto one bucket or
 * the budget silently doubles; the unspecified addresses (`::`, `0.0.0.0`) and
 * the empty string mean "no idea who this is" and take the fallback path.
 */
function normalizeClientIp(raw: string | undefined): string | undefined {
  const trimmed = (raw ?? '').trim().toLowerCase();
  if (!trimmed || trimmed === '::' || trimmed === '0.0.0.0') return undefined;
  const unmapped = trimmed.startsWith('::ffff:') ? trimmed.slice('::ffff:'.length) : trimmed;
  return unmapped || undefined;
}

/** Mongo duplicate-key (E11000) — the unique email index rejecting a race. */
function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

/** A customer id from a token, as an ObjectId. Garbage reads as "not found". */
function toObjectId(customerId: string): Types.ObjectId {
  try {
    return new Types.ObjectId(customerId);
  } catch {
    throw new NotFoundException({ error: 'Account not found' });
  }
}

/**
 * `<sha256-hex>:<wrong-attempts>:<target-address>` — the outstanding code, its
 * attempt counter AND the address it proves control of, packed into the one
 * field this layer can persist.
 *
 * WHY PACKED, and it is not a preference: the counter belongs in its own
 * `emailVerificationAttempts` column on `Customer`, but Mongoose runs `strict`
 * by default and SILENTLY DROPS an undeclared path from a `$set` — a separate
 * field would look like it worked and count nothing, which is worse than no
 * cap at all. `customer.schema.ts` is not a file this change owns, so the
 * counter lives beside the hash in a field that IS declared. The separator is
 * `:`, which cannot occur in hex, so the split is unambiguous.
 *
 * Consequence to keep in mind: the stored value is no longer a bare hash, so
 * any query matching a code has to match the ENCODED form, not the hash alone.
 * Replacing this with a real `emailVerificationAttempts` column is a one-line
 * schema addition plus a migration — see the follow-up note.
 *
 * THE THIRD SEGMENT is the address the code was issued for, and it is what stops
 * a code minted for one address being spent to prove another (see the binding
 * check in `verifyForCustomer`). It is parsed by SPLITTING and rejoining the
 * tail, never by `lastIndexOf(':')` — an address is arbitrary user input and may
 * contain a colon (a quoted local part is legal), and `lastIndexOf` would then
 * slice the target in half and read a fragment of it as the attempt counter.
 *
 * ROLLBACK NOTE, because it is silent: deploy this, then roll back, and the old
 * two-segment decoder reads `<hash>:<attempts>:<target>` with `lastIndexOf`,
 * parses the target as the counter, gets NaN and falls to its
 * `MAX_VERIFICATION_ATTEMPTS` fail-closed branch. Every outstanding code dies
 * instantly. That is the safe direction to fail, but nobody is told — customers
 * simply see "invalid or expired" until they request a new code.
 */
function encodeVerification(hash: string, attempts: number, target?: string): string {
  return target === undefined ? `${hash}:${attempts}` : `${hash}:${attempts}:${target}`;
}

function decodeVerification(
  stored: string | undefined | null,
): { hash: string; attempts: number; target: string | undefined } | undefined {
  if (!stored) return undefined;
  const parts = stored.split(':');
  // One part = a row written by the pre-OTP build (a 32-byte token hash). It can
  // never equal the hash of a 6-digit code, so treating it as a live 0-attempt
  // code is harmless; it simply expires. `target` is undefined, which
  // `verifyForCustomer` treats as proof of nothing.
  if (parts.length < 2) return { hash: stored, attempts: 0, target: undefined };
  const [hash, rawAttempts, ...targetParts] = parts;
  const attempts = Number.parseInt(rawAttempts, 10);
  return {
    hash,
    // An unparseable counter fails CLOSED (treated as exhausted) rather than
    // resetting the budget to zero-attempts-used.
    attempts: Number.isInteger(attempts) && attempts >= 0 ? attempts : MAX_VERIFICATION_ATTEMPTS,
    // REJOINED, not `parts[2]`: a colon is legal inside an address, so the tail
    // has to be put back together or a quoted local part decodes truncated and
    // the binding check rejects a code that was in fact issued for that address.
    target: targetParts.length > 0 ? targetParts.join(':') : undefined,
  };
}

/**
 * Whether two addresses are the same one, compared the way the rest of this
 * service normalizes them (`toLowerCase().trim()`).
 *
 * `undefined` on EITHER side is never a match — an absent target is an unbound
 * code and an absent account address is a wallet-only account; neither is
 * something a code can prove control of, and both must fail closed.
 */
function sameAddress(a: string | undefined | null, b: string | undefined | null): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Epoch ms for a value Mongo may hand back as a Date or a string. */
function msOf(value: Date | string | undefined | null): number | undefined {
  if (value === undefined || value === null) return undefined;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Constant-time comparison of two hex digests.
 *
 * Both sides are re-hashed to a fixed 32 bytes before the compare — NOT
 * redundant: `timingSafeEqual` THROWS on unequal lengths, so handing it a
 * stored value of unexpected width (a legacy row, a truncated write) would turn
 * a security check into a 500 and a length oracle. Same lesson as the SSO
 * browser binder.
 */
function constantTimeEquals(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(hashApiKey(a), 'hex'), Buffer.from(hashApiKey(b), 'hex'));
}
