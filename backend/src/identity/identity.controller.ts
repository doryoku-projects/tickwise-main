import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Ip,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { AllowUnverified } from '../portal/allow-unverified.decorator.js';
import {
  CustomerJwtGuard,
  customerPrincipal,
  type AuthedCustomerRequest,
} from '../portal/customer-jwt.guard.js';
import {
  LinkPendingDto,
  OauthExchangeDto,
  OauthStartDto,
  WalletNonceDto,
  WalletVerifyDto,
} from './identity.dto.js';
import { IdentityService } from './identity.service.js';
import { readBinderCookie, readLinkBinderCookie } from './oauth-state.service.js';

/**
 * The only slices of the Express req/res this file touches. Declared locally for
 * the same reason `main.ts` declares its request shape: `@types/express` is not a
 * dependency of this package.
 */
interface CookieSettingResponse {
  setHeader(name: string, value: string): void;
}
interface RedirectingResponse extends CookieSettingResponse {
  redirect(status: number, url: string): void;
}
/** Just the raw `Cookie` header — parsed by `readBinderCookie`, no cookie-parser. */
interface CookieBearingRequest {
  headers?: { cookie?: string | string[] };
}

/**
 * Customer SSO handshake routes, alongside `CustomerAuthController` on the same
 * `/account/auth` prefix — same realm, same token, different credential.
 *
 * EVERY route here is reachable SIGNED OUT, by necessity: they are what a visitor
 * with no session uses to get one. The credential is the provider's; the
 * single-use state / nonce / handoff code makes each step usable once, and the
 * BINDER COOKIE is what ties the OAuth steps to one browser (see
 * `OauthStateService`). Nothing here may put the binder in a body or a URL.
 *
 * `@Res({ passthrough: true })` on the two JSON routes: they need one header set
 * and then their normal body returned, which is exactly what passthrough is for.
 * The callback keeps a plain `@Res()` because it already answers by calling
 * `res.redirect` itself — under passthrough Nest would send a SECOND response
 * after it.
 */
@Controller('account/auth')
export class IdentityAuthController {
  constructor(@Inject(IdentityService) private readonly identity: IdentityService) {}

  /** Which sign-in methods this deployment has. Names no account and no secret. */
  @Get('providers')
  providers() {
    return this.identity.listProviders();
  }

  /**
   * The IP is what the throttle spends. Anonymous route, and each call writes a
   * 10-minute Redis key, so the budget has to bind to the network rather than to
   * anything the caller picks.
   */
  @Post('oauth/:provider/start')
  async startOauth(
    @Param('provider') provider: string,
    @Body() body: OauthStartDto,
    @Ip() ip: string,
    @Res({ passthrough: true }) res: CookieSettingResponse,
  ): Promise<{ authorizeUrl: string }> {
    const started = await this.identity.startOauth(provider, body.returnTo, ip);
    // The binder leaves ONLY as a header. Returning `started` wholesale would
    // publish it in the JSON body, where any script on the page could read it —
    // which is precisely what `HttpOnly` is meant to prevent.
    res.setHeader('Set-Cookie', started.binderCookie);
    return { authorizeUrl: started.authorizeUrl };
  }

  /**
   * The provider's redirect target. ALWAYS answers 302 — `completeOauthCallback`
   * maps every failure to an error slug, because a JSON exception body at the end
   * of a browser redirect chain is not a page anyone can act on.
   *
   * `@Query()` is bound PER PARAMETER on purpose: the global ValidationPipe runs
   * `forbidNonWhitelisted`, and providers append their own params (`scope`,
   * `authuser`, `prompt`, `hd`, `error_description`), so binding a DTO here would
   * 400 real callbacks. Nothing is trusted — the service re-validates all three.
   */
  @Get('oauth/:provider/callback')
  async oauthCallback(
    @Param('provider') provider: string,
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Req() req: CookieBearingRequest,
    @Res() res: RedirectingResponse,
  ): Promise<void> {
    const outcome = await this.identity.completeOauthCallback({
      provider,
      code,
      state,
      providerError: error,
      // Reaches us because the cookie is `SameSite=Lax` and this is a top-level
      // navigation. A rejection here still answers 302, with an error slug.
      binder: readBinderCookie(req.headers?.cookie),
    });
    // Only the ceremony branch asks for a cookie, and it is the pending link's
    // OWN binder (`sso_link_binder`) — planted on the same 302 that carries the
    // token, so the two are inseparable from the start.
    //
    // `sso_binder` is NOT cleared here: the same binder has to authenticate the
    // exchange call the portal is about to make. It expires on its own, and the
    // exchange clears it once the session has actually been handed over.
    if (outcome.setCookie) res.setHeader('Set-Cookie', outcome.setCookie);
    res.redirect(302, outcome.url);
  }

  /**
   * Redeem the single-use handoff code for the session. The token comes back in
   * the response BODY — never in the redirect that got the browser here.
   *
   * TWO factors: the code from the URL and the binder cookie from the browser
   * that started the flow. Whoever reads the code out of a log, the browser
   * history or a `Referer` header has one of them and cannot get the other.
   */
  @Post('oauth/exchange')
  async exchange(
    @Body() body: OauthExchangeDto,
    @Req() req: CookieBearingRequest,
    @Res({ passthrough: true }) res: CookieSettingResponse,
  ) {
    const result = await this.identity.exchangeHandoff(
      body.code,
      readBinderCookie(req.headers?.cookie),
    );
    // Spent. Only reached on success, so a failed exchange never clears a cookie
    // the legitimate browser may still need for its own retry.
    res.setHeader('Set-Cookie', this.identity.expiredBinderCookie());
    return result;
  }

  /**
   * Describe a pending link so the ceremony page can say WHOSE account it is
   * about. UNAUTHENTICATED on purpose: the visitor is about to sign in, and this
   * is what tells them which account to sign in to.
   *
   * The binder cookie is the only credential here, and the response is the
   * MASKED address — never the one from a query parameter, or a crafted URL
   * would render a lure for an arbitrary address on our own domain. Unknown,
   * expired and wrong-browser are one identical 404.
   *
   * The CEREMONY binder, not the round trip's: this page is reloaded after the
   * visitor signs in, and that sign-in may be another OAuth round trip which
   * overwrites `sso_binder` on its way out and deletes it on its way back.
   */
  @Get('oauth/pending-link')
  pendingLink(@Query('token') token: string | undefined, @Req() req: CookieBearingRequest) {
    return this.identity.describePendingLink(token, readLinkBinderCookie(req.headers?.cookie));
  }

  @Post('wallet/nonce')
  walletNonce(@Body() body: WalletNonceDto, @Ip() ip: string) {
    return this.identity.walletNonce(body.address, ip);
  }

  /** No `message` parameter, ever: the server verifies against its stored copy. */
  @Post('wallet/verify')
  walletVerify(@Body() body: WalletVerifyDto, @Ip() ip: string) {
    return this.identity.walletVerify(body.nonce, body.signature, ip);
  }
}

/**
 * Connected-accounts management for a SIGNED-IN customer.
 *
 * The tenant comes from `req.customerUser` (written by `CustomerJwtGuard`) and
 * from nowhere else — same rule as `PortalController`. The `:id` on DELETE is
 * scoped inside the service by a Mongo filter that carries the caller's id.
 */
@Controller('account/identities')
@UseGuards(CustomerJwtGuard)
export class IdentityController {
  constructor(@Inject(IdentityService) private readonly identity: IdentityService) {}

  @Get()
  list(@Req() req: AuthedCustomerRequest) {
    return this.identity.listIdentities(customerPrincipal(req).id);
  }

  /**
   * Same provider round trip as signing in, but it ATTACHES to this account.
   *
   * The account it attaches to is `req.customerUser` at THIS call, sealed into
   * the state record — never a value the callback receives. And the same binder
   * cookie is planted here as on a login: without it, an attacker could request
   * this URL for their own account and hand it to a victim, whose Google/GitHub
   * identity would then be permanently attached to the attacker's tenant.
   *
   * The cookie's `Path` is `/account`, which covers this route as well as the
   * callback and exchange that actually read it — `Path` says where a cookie is
   * SENT, not where it may be set, so the two need not coincide.
   */
  @Post(':provider/link')
  async link(
    @Req() req: AuthedCustomerRequest,
    @Param('provider') provider: string,
    @Body() body: OauthStartDto,
    @Res({ passthrough: true }) res: CookieSettingResponse,
  ): Promise<{ authorizeUrl: string }> {
    const started = await this.identity.startIdentityLink(
      customerPrincipal(req).id,
      provider,
      body.returnTo,
    );
    res.setHeader('Set-Cookie', started.binderCookie);
    return { authorizeUrl: started.authorizeUrl };
  }

  /**
   * Finish the pending-link ceremony — the collision path's counterpart to the
   * handoff exchange.
   *
   * THREE factors, and the route needs all three: the token (single-use, from
   * the redirect), the CEREMONY binder cookie (the browser that met the
   * provider), and this session (the account the link is allowed to land on).
   * The service refuses any signed-in customer other than the one that held the
   * address.
   *
   * The binder here is `sso_link_binder` and not `sso_binder` for a functional
   * reason as much as a tidy one: getting to this route means signing in, and if
   * that sign-in was an OAuth round trip the round-trip cookie is already gone.
   *
   * `@AllowUnverified()` is LOAD-BEARING, not defensive. The overwhelmingly
   * common caller is a customer whose `emailVerifiedAt` is null — that is what
   * made rule (b) decline to auto-link in the first place — so without it the
   * guard 403s them out of the one route that fixes it.
   */
  @Post('link-pending')
  @AllowUnverified()
  async linkPending(
    @Req() req: AuthedCustomerRequest,
    @Body() body: LinkPendingDto,
    @Res({ passthrough: true }) res: CookieSettingResponse,
  ) {
    const result = await this.identity.completePendingLink({
      customerId: customerPrincipal(req).id,
      token: body.token,
      binder: readLinkBinderCookie(req.headers?.cookie),
    });
    // Spent, and only on success — mirroring the handoff exchange, so a refused
    // attempt never clears a cookie the legitimate browser still needs to retry.
    res.setHeader('Set-Cookie', this.identity.expiredLinkBinderCookie());
    return result;
  }

  @Delete(':id')
  unlink(@Req() req: AuthedCustomerRequest, @Param('id') id: string) {
    return this.identity.unlinkIdentity(customerPrincipal(req).id, id);
  }
}
