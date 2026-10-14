import { Body, Controller, Get, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { AdminJwtGuard } from './admin-jwt.guard.js';
import { LoginDto } from './auth.dto.js';
import { AuthService, type AdminJwtPayload } from './auth.service.js';

@Controller('admin/auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Post('login')
  login(@Body() body: LoginDto) {
    return this.auth.login(body.email, body.password);
  }

  @Get('me')
  @UseGuards(AdminJwtGuard)
  me(@Req() req: { adminUser?: AdminJwtPayload }) {
    const user = req.adminUser;
    return { email: user?.email, role: user?.role };
  }
}
