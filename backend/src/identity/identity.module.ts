import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AuthModule } from '../auth/auth.module.js';
import { BillingModule } from '../billing/billing.module.js';
import { CustomerJwtGuard } from '../portal/customer-jwt.guard.js';
import { IdentityAuthController, IdentityController } from './identity.controller.js';
import { Identity, IdentitySchema } from './identity.schema.js';
import { IdentityService } from './identity.service.js';
import { OauthStateService } from './oauth-state.service.js';
import { GithubOauthProvider } from './oauth/github.provider.js';
import { GoogleOauthProvider } from './oauth/google.provider.js';
import { OauthProviderRegistry } from './oauth/oauth-provider.registry.js';
import { SiweService } from './siwe.service.js';

/**
 * Customer SSO — OAuth (Google/GitHub) and wallet (SIWE) sign-in for the
 * `/account/*` realm.
 *
 * Imports run in ONE direction, `identity → {billing, auth}`:
 *  - `BillingModule` re-exports its `MongooseModule.forFeature`, so `Customer`
 *    is injectable here without a second registration for the same schema;
 *  - `AuthModule` exports the `CUSTOMER_JWT` signer, so SSO mints the SAME token
 *    a password login does.
 * Nothing here may be imported back into either — `BillingModule` already
 * imports `AuthModule`, and a reverse edge would be this repo's first DI cycle.
 *
 * `CustomerJwtGuard` is declared as a LOCAL provider rather than imported:
 * `PortalModule` does not export it, and that file is not owned by this change.
 * The guard is stateless (its state is the request), so a second instance behind
 * the same class token is equivalent — it resolves the same `Customer` model,
 * the same `CUSTOMER_JWT`, the same `Reflector` and the same global config.
 * Exporting it from `PortalModule` and importing that instead is the tidier end
 * state; see the follow-ups.
 */
@Module({
  imports: [
    BillingModule,
    AuthModule,
    MongooseModule.forFeature([{ name: Identity.name, schema: IdentitySchema }]),
  ],
  controllers: [IdentityAuthController, IdentityController],
  providers: [
    IdentityService,
    OauthProviderRegistry,
    GoogleOauthProvider,
    GithubOauthProvider,
    OauthStateService,
    SiweService,
    CustomerJwtGuard,
  ],
  exports: [IdentityService],
})
export class IdentityModule {}
