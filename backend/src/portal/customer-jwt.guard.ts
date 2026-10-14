import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { CUSTOMER_JWT } from '../auth/customer-jwt.tokens.js';
import { Customer } from '../billing/customer.schema.js';
import { AppConfigService } from '../config/app-config.service.js';
import { ALLOW_UNVERIFIED_KEY } from './allow-unverified.decorator.js';
import {
  CUSTOMER_TOKEN_TYPE,
  isEmailVerificationRequired,
  type CustomerJwtPayload,
} from './customer-auth.service.js';

/** The authenticated caller, as every `/account/*` handler sees it. */
export interface CustomerPrincipal {
  id: string;
  email: string;
  planKey: string;
  emailVerifiedAt?: Date;
  /**
   * An address claimed but not yet proved. Carried here because
   * `CustomerSelfService.profile` projects the PRINCIPAL, not a fresh read — so
   * a field the guard omits is a field `/account/overview` reports as null no
   * matter what the database holds. Leaving it out made a staged claim survive
   * only in React state: the code prompt vanished on refresh with no way back
   * to it, while `PATCH /account/profile` had correctly returned the claim.
   */
  pendingEmail?: string;
  status: 'active' | 'suspended';
}

export interface AuthedCustomerRequest {
  headers: Record<string, string | string[] | undefined>;
  /**
   * DELIBERATELY not `adminUser`: that property is what `AdminJwtGuard` writes
   * and what the admin handlers read. Sharing it would hand a customer token
   * the identity slot of an operator at the last step of the separation.
   */
  customerUser?: CustomerPrincipal;
}

/**
 * Bearer-token gate for the self-serve customer portal.
 *
 * Three assertions, all required:
 *  1. the signature verifies against the CUSTOMER secret (`CUSTOMER_JWT`), not
 *     `JWT_SECRET`;
 *  2. `typ === 'customer'` exactly — a missing claim is rejected, so an admin
 *     token (or anything minted before the claim existed) cannot pass;
 *  3. the customer still exists, is not suspended, and did not change their
 *     password after this token was issued.
 *
 * (3) costs ONE indexed read per request, which portal traffic can easily
 * afford, and is what makes suspension and "sign out everywhere" take effect
 * immediately instead of at the next token expiry.
 */
@Injectable()
export class CustomerJwtGuard implements CanActivate {
  constructor(
    @InjectModel(Customer.name) private readonly customers: Model<Customer>,
    @Inject(CUSTOMER_JWT) private readonly jwt: JwtService,
    @Inject(Reflector) private readonly reflector: Reflector,
    // Appended, never inserted: the specs construct this guard positionally.
    @Inject(AppConfigService) private readonly config: AppConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedCustomerRequest>();
    const header = req.headers['authorization'];
    const raw = Array.isArray(header) ? header[0] : header;
    if (!raw || !raw.toLowerCase().startsWith('bearer ')) {
      throw new UnauthorizedException({ error: 'Missing bearer token' });
    }
    const token = raw.slice(7).trim();

    let payload: CustomerJwtPayload;
    try {
      payload = await this.jwt.verifyAsync<CustomerJwtPayload>(token);
    } catch {
      throw new UnauthorizedException({ error: 'Invalid or expired token' });
    }
    // Exact-literal realm check, `undefined` included — see AdminJwtGuard.
    if (payload.typ !== CUSTOMER_TOKEN_TYPE) {
      throw new UnauthorizedException({ error: 'Invalid or expired token' });
    }

    let id: Types.ObjectId;
    try {
      id = new Types.ObjectId(payload.sub);
    } catch {
      throw new UnauthorizedException({ error: 'Invalid or expired token' });
    }
    // Default projection: every credential column on `Customer` is
    // `select: false`, so none of them is loaded here.
    const customer = await this.customers.findById(id).lean().exec();
    if (!customer) throw new UnauthorizedException({ error: 'Invalid or expired token' });

    if (customer.status !== 'active') {
      // 403, not 401: the token is genuine, so clearing it and bouncing to the
      // login page (what the portal does on a 401) would only loop.
      throw new ForbiddenException({ error: 'This account is suspended — contact support.' });
    }

    if (isStaleAfterPasswordChange(payload.iat, customer.passwordChangedAt)) {
      throw new UnauthorizedException({ error: 'Invalid or expired token' });
    }

    // `customer.email` is part of the condition, and it is the whole point:
    // this gate asks "have you proved the address on your account", which is
    // only a question if there IS one. A wallet account has none — SSO never
    // invents an address — so without this clause it was 403'd with "Verify
    // your email address to continue", an instruction with no possible action
    // behind it. Every wallet signup was locked out of the portal on arrival.
    //
    // Adding an address stays OPTIONAL and is done from the portal; the moment
    // one is claimed it goes through `pendingEmail` + the OTP like any other,
    // so nothing about proof is weakened — an unproven address still never
    // becomes `customer.email`.
    if (
      !this.allowsUnverified(context) &&
      isEmailVerificationRequired(this.config) &&
      customer.email &&
      !customer.emailVerifiedAt
    ) {
      throw new ForbiddenException({ error: 'Verify your email address to continue.' });
    }

    req.customerUser = {
      id: String(customer._id),
      email: customer.email ?? payload.email,
      planKey: customer.planKey,
      emailVerifiedAt: customer.emailVerifiedAt,
      pendingEmail: customer.pendingEmail,
      status: customer.status,
    };
    return true;
  }

  private allowsUnverified(context: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean>(ALLOW_UNVERIFIED_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? false
    );
  }
}

/**
 * Narrow the request's optional principal for a handler.
 *
 * `CustomerJwtGuard` always populates it, so this never throws in practice —
 * but it means a route added without `@UseGuards` fails CLOSED instead of
 * reading `undefined.id`, and it keeps `customerId` sourced from exactly one
 * place. No handler may take a customer id from a path or body.
 */
export function customerPrincipal(req: AuthedCustomerRequest): CustomerPrincipal {
  const user = req.customerUser;
  if (!user) throw new UnauthorizedException({ error: 'Invalid or expired token' });
  return user;
}

/**
 * True when the token predates the last password change — the "sign out
 * everywhere" primitive.
 *
 * `iat` is whole seconds while `passwordChangedAt` carries milliseconds, so the
 * comparison floors both. Without that, a token minted in the same second as
 * the change would look older than it and be rejected immediately.
 */
function isStaleAfterPasswordChange(iat: number | undefined, changedAt: Date | undefined): boolean {
  if (!changedAt) return false;
  // A token with no `iat` cannot be dated, so it cannot be shown to be current.
  if (typeof iat !== 'number') return true;
  return Math.floor(changedAt.getTime() / 1000) > iat;
}
