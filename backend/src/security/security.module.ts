import { Global, Module } from '@nestjs/common';
import { GoplusService } from './goplus.service.js';

@Global()
@Module({
  providers: [GoplusService],
  exports: [GoplusService],
})
export class SecurityModule {}
