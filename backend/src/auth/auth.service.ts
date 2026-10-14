import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  OnModuleInit,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { LimiterFactory, MEMORY_LIMITER_FACTORY, type AuthLimiter } from '../common/limiter-factory.js';
import { Model } from 'mongoose';
import { AppConfigService } from '../config/app-config.service.js';
import { AdminUser } from './admin-user.schema.js';
import { hashPassword, verifyPassword } from './password.util.js';

/**
 * Realm discriminator stamped on every admin token's `typ` claim and asserted
 * by `AdminJwtGuard`. `role` is NOT usable for this — `AdminUser.role` is an
 * unconstrained string with a `'admin'` default.
 */
export const ADMIN_TOKEN_TYPE = 'admin' as const;

/**
 * Brute-force limiter keys are realm-namespaced so a future customer login path
 * can reuse this limiter without an admin and a customer sharing (and mutually
 * exhausting) one 10-attempt budget for the same email address.
 */
const LIMITER_REALM = ADMIN_TOKEN_TYPE;

export interface AdminJwtPayload {
  sub: string;
  email: string;
  role: string;
  /** Always `'admin'`. Tokens from any other realm must never satisfy this. */
  typ: typeof ADMIN_TOKEN_TYPE;
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);
  // Brute-force guard: max 10 login attempts per email per 5 minutes, reset on
  // success. Per process by default; fleet-wide with AUTH_LIMITER_STORE=redis.
  private readonly loginLimiter: AuthLimiter;

  constructor(
    @InjectModel(AdminUser.name) private readonly adminUsers: Model<AdminUser>,
    @Inject(JwtService) private readonly jwt: JwtService,
    @Inject(AppConfigService) private readonly config: AppConfigService,
    /**
     * APPENDED and optional (P2.2 §3.1): where the login limiter keeps its
     * counters. Absent, or `AUTH_LIMITER_STORE=memory`, today's per-process
     * `RateLimiterMemory` (10 per 5 minutes).
     */
    @Optional() @Inject(LimiterFactory) limiterFactory?: LimiterFactory,
  ) {
    const limiters = limiterFactory ?? MEMORY_LIMITER_FACTORY;
    this.loginLimiter = limiters.create(LIMITER_REALM, 'login', { points: 10, duration: 300 });
  }

  /** Seed the first admin from env if none exists yet. Idempotent. */
  async onModuleInit(): Promise<void> {
    const email = this.config.adminEmail?.toLowerCase().trim();
    const password = this.config.adminPassword;
    if (!email || !password) {
      const count = await this.adminUsers.estimatedDocumentCount();
      if (count === 0) {
        this.logger.warn(
          'No admin users exist and ADMIN_EMAIL/ADMIN_PASSWORD are unset — admin panel login is unavailable until one is created.',
        );
      }
      return;
    }
    const existing = await this.adminUsers.findOne({ email }).lean().exec();
    if (existing) return;
    try {
      await this.adminUsers.create({ email, passwordHash: hashPassword(password), role: 'admin' });
    } catch (err) {
      // P2: several processes boot together, and each may have seen no admin.
      // The unique email index makes the loser's insert E11000 — the admin
      // exists, which is all this seed wants.
      if ((err as { code?: number })?.code === 11000) {
        this.logger.log(`Admin user ${email} already seeded by a concurrent boot`);
        return;
      }
      throw err;
    }
    this.logger.log(`Seeded admin user ${email}`);
  }

  async login(email: string, password: string): Promise<{ token: string; email: string; role: string }> {
    const normalized = email.toLowerCase().trim();
    const limiterKey = `${LIMITER_REALM}:${normalized}`;
    try {
      await this.loginLimiter.consume(limiterKey, 1);
    } catch {
      throw new HttpException(
        { error: 'Too many login attempts. Try again in a few minutes.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const user = await this.adminUsers.findOne({ email: normalized }).exec();
    if (!user || !verifyPassword(password, user.passwordHash)) {
      throw new UnauthorizedException({ error: 'Invalid email or password' });
    }
    user.lastLoginAt = new Date();
    await user.save();
    await this.loginLimiter.delete(limiterKey); // reset the counter on success
    const payload: AdminJwtPayload = {
      sub: String(user._id),
      email: user.email,
      role: user.role,
      typ: ADMIN_TOKEN_TYPE,
    };
    const token = await this.jwt.signAsync(payload);
    return { token, email: user.email, role: user.role };
  }

  async verify(token: string): Promise<AdminJwtPayload> {
    try {
      return await this.jwt.verifyAsync<AdminJwtPayload>(token);
    } catch {
      throw new UnauthorizedException({ error: 'Invalid or expired token' });
    }
  }
}
