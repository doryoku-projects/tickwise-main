import { Body, Controller, Get, Inject, Post, Query, Req, UseGuards } from '@nestjs/common';
import { customerPrincipal, CustomerJwtGuard, type AuthedCustomerRequest } from '../portal/customer-jwt.guard.js';
import { BillingViewService } from './billing-view.service.js';
import {
  AuthorizeDto,
  CancelSubscriptionDto,
  ConfirmAuthorizationDto,
  StartCheckoutDto,
  SubmittedTxDto,
  SwitchNetworkDto,
} from './portal-billing.dto.js';
import { AuthorizationService } from './providers/x402/authorization.service.js';
import { SubscriptionsService } from './subscriptions.service.js';

/**
 * `/account/billing/*` — the customer's own billing surface.
 *
 * Same tenancy rule as `PortalController`: NO ROUTE CARRIES A CUSTOMER ID. The
 * tenant comes from `req.customerUser` and nowhere else, so IDOR is
 * structurally impossible rather than defended against.
 *
 * Mounted here rather than on `PortalController` because it belongs to
 * `PaymentsModule` — the portal must not import the payments services, or the
 * dependency runs the wrong way and `PortalModule` ends up owning money code.
 */
@Controller('account/billing')
@UseGuards(CustomerJwtGuard)
export class PortalBillingController {
  constructor(
    @Inject(BillingViewService) private readonly view: BillingViewService,
    @Inject(SubscriptionsService) private readonly subscriptions: SubscriptionsService,
    @Inject(AuthorizationService) private readonly authorizations: AuthorizationService,
  ) {}

  @Get()
  overview(@Req() req: AuthedCustomerRequest) {
    return this.view.overview(customerPrincipal(req).id);
  }

  @Get('invoices')
  invoices(@Req() req: AuthedCustomerRequest) {
    return this.view.invoices_(customerPrincipal(req).id);
  }

  /**
   * Buy, upgrade or schedule a downgrade. Which of the three happens is decided
   * by `SubscriptionsService` from the plan's monthly-equivalent price, not by
   * the caller — a client that could pick "upgrade" could pick "immediate" for
   * a cheaper plan and get a free early switch.
   *
   * A purchase already in flight comes back as a 409 CARRYING the existing pay
   * link, so the portal can send the customer to the payment they already
   * started instead of raising a second one.
   */
  @Post('checkout')
  checkout(@Req() req: AuthedCustomerRequest, @Body() body: StartCheckoutDto) {
    return this.subscriptions.startCheckout({
      customerId: customerPrincipal(req).id,
      planKey: body.planKey,
      priceId: body.priceId,
    });
  }

  /**
   * Issue the EIP-712 payload for the customer's connected wallet.
   *
   * The SERVER composes it and stores what it issued; the client only signs. Same
   * rule as `siwe.service.ts`, and it is why there is no way to have us verify one
   * message and relay another.
   */
  @Post('authorize')
  authorize(@Req() req: AuthedCustomerRequest, @Body() body: AuthorizeDto) {
    return this.authorizations.issue(customerPrincipal(req).id, body.from);
  }

  /**
   * Accept the signature, preflight it, and get it on chain.
   *
   * The payload is REBUILT FROM THE STORED ROW before verification — nothing in
   * this body contributes to it beyond the signature itself.
   */
  @Post('authorize/confirm')
  confirmAuthorization(@Req() req: AuthedCustomerRequest, @Body() body: ConfirmAuthorizationDto) {
    return this.authorizations.confirm(customerPrincipal(req).id, body.signature);
  }

  /**
   * The networks this customer can pay on. Only ones whose token domain is
   * VERIFIED — see `AuthorizationService.networks`.
   */
  /**
   * Record the hash of a self-submitted payment. UNTRUSTED — see
   * `AuthorizationService.recordSubmission`; it never decides that anyone has paid.
   */
  @Post('authorize/submitted')
  recordSubmission(@Req() req: AuthedCustomerRequest, @Body() body: SubmittedTxDto) {
    return this.authorizations.recordSubmission(customerPrincipal(req).id, body.txHash);
  }

  @Get('networks')
  networks(@Req() req: AuthedCustomerRequest) {
    return this.authorizations.networks(customerPrincipal(req).id);
  }

  /**
   * Move the open invoice's quote to another network.
   *
   * The choice belongs here rather than at plan selection: a customer does not
   * know which wallet they will pay from until they are looking at the pay screen,
   * and with several networks accepted something has to choose — which was
   * silently the registry's order.
   */
  @Post('network')
  switchNetwork(@Req() req: AuthedCustomerRequest, @Body() body: SwitchNetworkDto) {
    return this.authorizations.switchNetwork(customerPrincipal(req).id, body.chainId);
  }

  @Post('cancel')
  cancel(@Req() req: AuthedCustomerRequest, @Body() body: CancelSubscriptionDto) {
    return this.subscriptions.cancel(customerPrincipal(req).id, body.reason);
  }

  /**
   * Abandon a pending upgrade. NOT the same thing as `cancel`, which ends the
   * subscription the customer is actually paying for — see the note on
   * `cancelPendingChange`.
   */
  @Post('cancel-change')
  cancelChange(@Req() req: AuthedCustomerRequest) {
    return this.subscriptions.cancelPendingChange(customerPrincipal(req).id);
  }

  @Post('resume')
  resume(@Req() req: AuthedCustomerRequest) {
    return this.subscriptions.resume(customerPrincipal(req).id);
  }
}

/**
 * The checkout return status — OPEN, and deliberately so.
 *
 * A crypto rail commonly returns the customer inside a wallet's in-app browser,
 * which is a different browsing context with no portal session. Requiring the
 * JWT here would show a login form to somebody who has just paid, which reads
 * as the payment having failed. Authority instead comes from the invoice's
 * `returnToken` — 32 random bytes minted with the invoice and carried in the
 * URL the rail redirects to.
 *
 * SEPARATE CONTROLLER, not an `@AllowUnverified()`-style exception on the
 * guarded one above: `@UseGuards` is applied at class level there, and an open
 * route living inside a guarded controller is one refactor away from being
 * quietly re-guarded — or, far worse, from a future guarded route being added
 * to a controller somebody has since made open.
 */
@Controller('billing')
export class CheckoutReturnController {
  constructor(@Inject(BillingViewService) private readonly view: BillingViewService) {}

  @Get('checkout-status')
  status(@Query('invoice') invoiceId: string, @Query('t') token: string) {
    return this.view.checkoutReturn(invoiceId ?? '', token ?? '');
  }
}
