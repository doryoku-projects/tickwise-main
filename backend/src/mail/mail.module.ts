import { Module } from '@nestjs/common';
import { MailService } from './mail.service.js';

/**
 * Outbound mail.
 *
 * Depends on nothing but `AppConfigService` (which is `@Global()`), so it has no
 * imports and cannot participate in a DI cycle — import it anywhere that needs
 * to send. `PortalModule` is the only consumer today.
 */
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
