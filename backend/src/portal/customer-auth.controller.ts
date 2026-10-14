import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Ip, Post, Req, UseGuards } from '@nestjs/common';
import { AllowUnverified } from './allow-unverified.decorator.js';
import { CustomerAuthService, toPublicCustomer } from './customer-auth.service.js';
import { CustomerJwtGuard, customerPrincipal, type AuthedCustomerRequest } from './customer-jwt.guard.js';
import {
  ChangePasswordDto,
  CustomerLoginDto,
  ForgotPasswordDto,
  ResetPasswordDto,
  SignupDto,
  VerifyEmailDto,
} from './portal.dto.js';

/**
 * Credential endpoints for the customer realm. Mirrors `/admin/auth/*` but
 * shares nothing with it: different secret, different `typ` claim, different
 * guard, different collection.
 *
 * The guard is applied per-route rather than at class level because `signup`,
 * `login` and `verify-email` are necessarily reachable signed-out.
 */
@Controller('account/auth')
export class CustomerAuthController {
  constructor(@Inject(CustomerAuthService) private readonly auth: CustomerAuthService) {}

  /**
   * The IP is what the anonymous-signup throttle spends: an attacker varies the
   * email freely, so counting by address is the only budget that binds. Without
   * it every signup falls back to the per-email key and the cap never fires.
   */
  @Post('signup')
  signup(@Body() body: SignupDto, @Ip() ip: string) {
    return this.auth.signup(body.email, body.password, body.planKey, ip);
  }

  /**
   * `@Ip()` is NOT optional here, for the same reason it is not on `signup`.
   *
   * Every failed login runs scrypt whether or not the address exists (see
   * `DUMMY_PASSWORD_HASH`), synchronously, at ~18ms on the one event loop — so
   * `loginIpLimiter` is the DoS control on this route and the per-address bucket
   * caps nothing an attacker cares about (they vary the address for free).
   * `login`'s `clientIp` is optional in the SIGNATURE so a direct service call in
   * a spec need not invent one, which means omitting it here compiles, throws
   * nothing, logs nothing, and silently leaves the per-IP bucket never charged.
   */
  @Post('login')
  login(@Body() body: CustomerLoginDto, @Ip() ip: string) {
    return this.auth.login(body.email, body.password, ip);
  }

  /**
   * Ask for a password reset link. OPEN — whoever needs this has no session.
   *
   * 202 ACCEPTED, and it is the same 202 for a registered, unregistered,
   * unverified and suspended address: the uniform answer is what stops this
   * route being an "does ceo@bigcorp.com bank here" oracle for anyone with curl.
   * The service documents each refusal branch and logs the reason server-side;
   * do not surface any of it here.
   *
   * `@Ip()` feeds `passwordResetIpLimiter` — the bucket that bounds mail-bombing
   * from one source across many addresses.
   */
  @Post('forgot-password')
  @HttpCode(HttpStatus.ACCEPTED)
  forgotPassword(@Body() body: ForgotPasswordDto, @Ip() ip: string) {
    return this.auth.requestPasswordReset(body.email, ip);
  }

  /**
   * Finish a password reset. OPEN — the emailed token IS the credential, and the
   * caller by definition cannot sign in.
   *
   * 200, explicitly: `@Post` defaults to 201 CREATED and this creates nothing.
   *
   * `@Ip()` IS LOAD-BEARING HERE. It is the ONLY key this request carries (no
   * address, no session, no account id), so `throttlePasswordResetConfirm` is the
   * route's entire budget — and that helper FAILS OPEN on a missing IP by
   * design, to keep one bad proxy hop from taking reset away from everybody.
   * Omit `@Ip()` and the anonymous route is unthrottled with no error anywhere:
   * every junk token buys a database lookup nobody authenticated for.
   *
   * No session is returned — the customer signs in again with the new password.
   */
  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  resetPassword(@Body() body: ResetPasswordDto, @Ip() ip: string) {
    return this.auth.resetPassword(body.token, body.newPassword, ip);
  }

  /** The guard already read the customer, so this is a pure projection. */
  @Get('me')
  @UseGuards(CustomerJwtGuard)
  @AllowUnverified()
  me(@Req() req: AuthedCustomerRequest) {
    return toPublicCustomer(customerPrincipal(req));
  }

  @Post('change-password')
  @UseGuards(CustomerJwtGuard)
  @AllowUnverified()
  changePassword(@Req() req: AuthedCustomerRequest, @Body() body: ChangePasswordDto) {
    return this.auth.changePassword(customerPrincipal(req).id, body.currentPassword, body.newPassword);
  }

  /**
   * GUARDED, unlike the long-token version this replaced.
   *
   * That route was public because a 32-byte emailed token IS itself the
   * credential and the link gets opened outside the requesting session. A
   * SIX-DIGIT code is not a credential — it is ~10^6 guesses — so the whole
   * defence is the per-code attempt cap, and the cap can only be charged against
   * a KNOWN account. Anonymously, a wrong code simply matches no document and
   * there is nothing to increment, which leaves blind guessing bounded only by a
   * shared throttle. Signup and login both return a session, so the person
   * typing the code always has one.
   *
   * `@AllowUnverified()` is mandatory here: the caller is by definition
   * unverified, so without it the guard 403s them out of the one route that
   * clears the flag.
   */
  @Post('verify-email')
  @UseGuards(CustomerJwtGuard)
  @AllowUnverified()
  verifyEmail(@Req() req: AuthedCustomerRequest, @Body() body: VerifyEmailDto, @Ip() ip: string) {
    return this.auth.verifyEmail(body.code, customerPrincipal(req).id, ip);
  }

  @Post('resend-verification')
  @UseGuards(CustomerJwtGuard)
  @AllowUnverified()
  resendVerification(@Req() req: AuthedCustomerRequest, @Ip() ip: string) {
    return this.auth.resendVerification(customerPrincipal(req).id, ip);
  }
}
