import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IssueKeyDto, SetKeyOriginsDto } from '../billing/billing.dto.js';
import { AllowUnverified } from './allow-unverified.decorator.js';
import { CustomerSelfService } from './customer-self.service.js';
import { CustomerJwtGuard, customerPrincipal, type AuthedCustomerRequest } from './customer-jwt.guard.js';
import { UpdateProfileDto, UsageDetailQueryDto } from './portal.dto.js';

/**
 * The self-serve portal API.
 *
 * NO ROUTE CARRIES A CUSTOMER ID. The tenant comes from `req.customerUser`
 * (written by `CustomerJwtGuard`) and from nowhere else, which makes IDOR
 * structurally impossible on the collection routes — there is no id to tamper
 * with. The key routes do take a `:id`, and it is scoped by the owner inside
 * `CustomerSelfService`, whose Mongo filter carries the customerId.
 *
 * `CustomerSelfService` is the only service injected here on purpose: it has no
 * method that accepts an unscoped id, so nothing reachable from this file can
 * read or write another tenant's data.
 */
@Controller('account')
@UseGuards(CustomerJwtGuard)
export class PortalController {
  constructor(@Inject(CustomerSelfService) private readonly self: CustomerSelfService) {}

  @Get('overview')
  overview(@Req() req: AuthedCustomerRequest) {
    return this.self.overview(customerPrincipal(req));
  }

  @Get('profile')
  profile(@Req() req: AuthedCustomerRequest) {
    return this.self.profile(customerPrincipal(req));
  }

  /**
   * Set or change the caller's own email address. No id in the path — the
   * tenant is `req.customerUser` and nothing else, which is what makes IDOR
   * structurally impossible here.
   *
   * `@AllowUnverified()` is LOAD-BEARING, not defensive. A wallet-only account
   * has no email at all, so with `CUSTOMER_EMAIL_VERIFICATION_REQUIRED` on, the
   * guard would 403 it out of every route — including the only route that can
   * give it a verifiable address. Without this decorator the feature is
   * unreachable for exactly the accounts it exists for.
   */
  @Patch('profile')
  @AllowUnverified()
  updateProfile(@Req() req: AuthedCustomerRequest, @Body() body: UpdateProfileDto) {
    return this.self.updateEmail(customerPrincipal(req), body.email);
  }

  @Get('keys')
  listKeys(@Req() req: AuthedCustomerRequest) {
    return this.self.listKeys(customerPrincipal(req).id);
  }

  @Post('keys')
  createKey(@Req() req: AuthedCustomerRequest, @Body() body: IssueKeyDto) {
    const principal = customerPrincipal(req);
    // planKey comes from the customer record the guard just read — never from
    // the request, or a caller could buy themselves a bigger key ceiling.
    return this.self.createKey(principal.id, principal.planKey, {
      label: body.label,
      keyType: body.keyType,
      origins: body.origins,
    });
  }

  @Patch('keys/:id/origins')
  setKeyOrigins(
    @Req() req: AuthedCustomerRequest,
    @Param('id') id: string,
    @Body() body: SetKeyOriginsDto,
  ) {
    const principal = customerPrincipal(req);
    // planKey travels with the origins for the same reason it travels with
    // `createKey`: adding an origin CONVERTS the key to a browser key, so the
    // plan ceiling has to be re-checked here — and, as there, the plan comes
    // from the customer record the guard read, never from the request.
    return this.self.setKeyOrigins(principal.id, principal.planKey, id, body.origins);
  }

  @Post('keys/:id/revoke')
  revokeKey(@Req() req: AuthedCustomerRequest, @Param('id') id: string) {
    return this.self.revokeKey(customerPrincipal(req).id, id);
  }

  @Delete('keys/:id')
  deleteKey(@Req() req: AuthedCustomerRequest, @Param('id') id: string) {
    return this.self.deleteKey(customerPrincipal(req).id, id);
  }

  @Get('usage')
  usage(@Req() req: AuthedCustomerRequest) {
    return this.self.usage(customerPrincipal(req));
  }

  /**
   * Per-day / per-route / per-key / per-status breakdown of the caller's own
   * consumption. Same response shape as the admin panel's view of the same
   * customer — support and the customer must be looking at one report.
   *
   * NOT `@AllowUnverified()`: this is an ordinary account page, and an account
   * that has not proved its address has no business reading its own billing
   * detail before it can reach the rest of the portal.
   */
  @Get('usage/detail')
  usageDetail(@Req() req: AuthedCustomerRequest, @Query() query: UsageDetailQueryDto) {
    return this.self.usageDetail(customerPrincipal(req), query);
  }
}
