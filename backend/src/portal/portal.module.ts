import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { MailModule } from '../mail/mail.module.js';
import { CustomerAuthController } from './customer-auth.controller.js';
import { CustomerAuthService } from './customer-auth.service.js';
import { CustomerJwtGuard } from './customer-jwt.guard.js';
import { CustomerSelfService } from './customer-self.service.js';
import { PortalController } from './portal.controller.js';

/**
 * The self-serve customer portal (`/account/*`).
 *
 * Imports run in ONE direction: portal → billing/auth/mail. `BillingModule`
 * re-exports its `MongooseModule.forFeature` (so `Customer` is injectable here
 * without a second registration), `AuthModule` exports the `CUSTOMER_JWT` signer
 * and `MailModule` exports the transport that delivers verification codes.
 * Nothing here may be imported back into either of them — `BillingModule`
 * already imports `AuthModule`, and a reverse edge would be a DI cycle.
 * `MailModule` imports nothing at all, so it cannot form one.
 */
@Module({
  imports: [BillingModule, AuthModule, MailModule],
  controllers: [CustomerAuthController, PortalController],
  providers: [CustomerAuthService, CustomerSelfService, CustomerJwtGuard],
  // `CustomerJwtGuard` is exported so `PaymentsModule` can guard
  // `/account/billing/*` with THE SAME instance rather than declaring a second
  // local copy. The guard is stateless, so a duplicate would behave
  // identically — but two of them means a change to how the customer realm is
  // authenticated has two places to land, and the one nobody edits is the
  // security hole. `IdentityModule` still declares its own local copy; that
  // predates this export and is the tidier thing to fold in next.
  exports: [CustomerJwtGuard],
})
export class PortalModule {}
