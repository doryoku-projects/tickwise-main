import { IsEmail, IsIn, IsOptional, IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';

// The global ValidationPipe runs `whitelist` + `forbidNonWhitelisted`, so EVERY
// property here needs a decorator or a request carrying it 400s. Note also that
// the pipe is inert under `tsx` dev (esbuild drops the decorator metadata) —
// these bounds only bite in the prod `tsc` build, so nothing security-relevant
// may rely on them alone.

/** Upper bound on any password we will run through scrypt (CPU-cost guard). */
const MAX_PASSWORD_LENGTH = 200;
/**
 * The password floor every DTO in this file bounds, and it MUST equal
 * `MIN_PASSWORD_LENGTH` exported from `customer-auth.service.ts` — which is
 * where the floor is actually ENFORCED (`assertPasswordPolicy`; the pipe is
 * inert under `tsx` dev, so a DTO bound is a courtesy to the caller and never a
 * control).
 *
 * WHY THE TWO ARE EQUAL RATHER THAN ONE IMPORTED FROM THE OTHER: if signup's
 * bound were higher than the service's floor, `reset-password` would become the
 * weakest way into an account — an attacker holding a mailbox could set a
 * password signup itself would have refused. Declared here rather than imported
 * so a DTO never depends on a service (the rule `VERIFICATION_CODE_DIGITS`
 * below already follows), and EXPORTED so `test/portal-reset.spec.ts` can pin
 * the two together and the pair cannot drift.
 */
export const MIN_PASSWORD_LENGTH = 8;
/**
 * Digits in an email verification code. Mirrors `VERIFICATION_CODE_DIGITS` in
 * `customer-auth.service.ts` — declared here rather than imported so a DTO
 * never depends on a service, and pinned by `test/email-otp.spec.ts` so the two
 * cannot drift.
 */
const VERIFICATION_CODE_DIGITS = 6;

export class SignupDto {
  @IsEmail()
  @MaxLength(200)
  email!: string;

  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH)
  @MaxLength(MAX_PASSWORD_LENGTH)
  password!: string;

  /**
   * The plan the visitor picked on the pricing page. ADVISORY ONLY — it grants
   * entitlement solely when the plan costs nothing; see
   * `CustomerAuthService.resolveSignupPlan`.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  planKey?: string;
}

export class CustomerLoginDto {
  @IsEmail()
  @MaxLength(200)
  email!: string;

  // No MinLength beyond 1: a login must not leak the password policy, and the
  // stored hash decides.
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_PASSWORD_LENGTH)
  password!: string;
}

/**
 * Ask for a password reset link. ANONYMOUS.
 *
 * `@IsEmail()` here is a shape check and NOT a gate on who may ask: the route
 * answers an identical 202 for a registered, unregistered, unverified or
 * suspended address (see `CustomerAuthService.requestPasswordReset`), so a
 * malformed address is the only thing this can distinguish and it distinguishes
 * nothing about accounts. The 200-char cap matches `SignupDto` so the two cannot
 * disagree about what a storable address is.
 */
export class ForgotPasswordDto {
  @IsEmail()
  @MaxLength(200)
  email!: string;
}

/**
 * Finish a password reset. ANONYMOUS — the token IS the credential.
 *
 * THE PROPERTY NAME IS `newPassword`, NOT `password`. The portal sends
 * `{ token, newPassword }` (`frontend/src/lib/portal-api.ts`), and the global
 * pipe runs `whitelist` + `forbidNonWhitelisted`, so a rename here 400s every
 * real reset with an "unexpected property" error that reads like a client bug.
 * It also mirrors `ChangePasswordDto.newPassword`, which is the other route that
 * sets a password.
 *
 * `MinLength(1)` on the token and not a fixed width: it is 32 random bytes as
 * base64url (43 chars today), and pinning that here would break the day the byte
 * count changes. `MaxLength(256)` is the CPU-cost guard — `resetPassword` hashes
 * whatever it is handed to compare against the stored digest.
 *
 * The password bounds are the same pair `ChangePasswordDto` carries, and the
 * floor is re-enforced in the service (`assertPasswordPolicy`) because this
 * route sets a password with no session and no current password to compare
 * against, which makes it the weakest way into an account if the floor is only
 * ever a DTO.
 */
export class ResetPasswordDto {
  @IsString()
  @MinLength(1)
  @MaxLength(256)
  token!: string;

  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH)
  @MaxLength(MAX_PASSWORD_LENGTH)
  newPassword!: string;
}

export class ChangePasswordDto {
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_PASSWORD_LENGTH)
  currentPassword!: string;

  @IsString()
  @MinLength(MIN_PASSWORD_LENGTH)
  @MaxLength(MAX_PASSWORD_LENGTH)
  newPassword!: string;
}

export class VerifyEmailDto {
  /**
   * The 6-digit code from the verification email; only its SHA-256 is stored.
   *
   * `Length(6, 6)` AND the digits-only pattern, both: the pattern alone would
   * accept nothing else but the explicit length is what documents the contract,
   * and neither may be relaxed without revisiting the attempt cap — the whole
   * security argument for a short code assumes a 10^6 space.
   */
  @IsString()
  @Length(VERIFICATION_CODE_DIGITS, VERIFICATION_CODE_DIGITS)
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code!: string;
}

/**
 * Set or change the signed-in customer's email address.
 *
 * No customer id: the tenant comes from the token, which is what makes IDOR
 * structurally impossible on `/account/*`. The 200-char cap matches `SignupDto`
 * so the two write paths cannot disagree about what a storable address is.
 */
export class UpdateProfileDto {
  @IsEmail()
  @MaxLength(200)
  email!: string;
}

/**
 * The window + breakdown for `GET /account/usage/detail`. The FIRST query DTO
 * in this file, which is why the note at the top matters more here than
 * anywhere else: with the pipe inert under `tsx` dev, a query string arrives
 * raw, so `?from[$gt]=` reaches the handler as an OBJECT. Every bound below is
 * therefore restated as a real check inside `ClientsService.getUsageDetail`,
 * which is what actually refuses it — these decorators only give a prod caller
 * a clean 400 instead of a service-level one.
 *
 * NO CUSTOMER ID, here or in the path: the tenant is `req.customerUser` and
 * nothing else, which is what makes IDOR structurally impossible on
 * `/account/*`.
 *
 * The `groupBy` values are restated rather than imported from
 * `clients.service.ts` for the same reason `VERIFICATION_CODE_DIGITS` above is
 * restated — a DTO never depends on a service — and they are pinned to the
 * service's `USAGE_DETAIL_GROUPS` by that service's own 400.
 */
export class UsageDetailQueryDto {
  /** Inclusive lower bound, `YYYY-MM-DD` UTC. Defaults to the 1st of `to`'s month. */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'from must be a date as YYYY-MM-DD' })
  from?: string;

  /** Inclusive upper bound, `YYYY-MM-DD` UTC. Defaults to today. */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'to must be a date as YYYY-MM-DD' })
  to?: string;

  /** Omitted = all four breakdowns; named = only that one is populated. */
  @IsOptional()
  @IsIn(['day', 'routeKey', 'apiKey', 'status'])
  groupBy?: 'day' | 'routeKey' | 'apiKey' | 'status';
}
