import { Module } from '@nestjs/common';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { MongooseModule } from '@nestjs/mongoose';
import { AppConfigModule } from '../config/app-config.module.js';
import { AppConfigService } from '../config/app-config.service.js';
import { AdminUser, AdminUserSchema } from './admin-user.schema.js';
import { AdminJwtGuard } from './admin-jwt.guard.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { CUSTOMER_JWT } from './customer-jwt.tokens.js';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: AdminUser.name, schema: AdminUserSchema }]),
    JwtModule.registerAsync({
      imports: [AppConfigModule],
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        secret: config.jwtSecret,
        // expiresIn is typed as ms's `StringValue` template literal; our value
        // is a free-form env string, so cast through unknown.
        signOptions: { expiresIn: config.jwtExpiresIn as unknown as number },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    AdminJwtGuard,
    {
      // The customer realm's own JwtService. `JwtModule` can only be registered
      // once per injector (single `JWT_MODULE_OPTIONS` token), so the second
      // instance is built by hand — see `customer-jwt.tokens.ts`.
      provide: CUSTOMER_JWT,
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) =>
        new JwtService({
          secret: config.customerJwtSecret,
          // Same `ms` StringValue cast as the admin registration above.
          signOptions: { expiresIn: config.customerJwtExpiresIn as unknown as number },
        }),
    },
  ],
  // NOTE: `JwtService` itself stays unexported — the admin signer must not leak
  // out of this module. Only the customer token is shared.
  exports: [AuthService, AdminJwtGuard, CUSTOMER_JWT],
})
export class AuthModule {}
