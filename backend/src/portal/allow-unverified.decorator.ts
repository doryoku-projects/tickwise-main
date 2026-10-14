import { SetMetadata } from '@nestjs/common';

export const ALLOW_UNVERIFIED_KEY = 'portal:allowUnverified';

/**
 * Lets a route run for a customer whose email address is still unverified.
 *
 * `CustomerJwtGuard` blocks unverified customers ONLY when email verification
 * is switched on (see `isEmailVerificationRequired`). The routes that exist to
 * GET verified — `verify-email`, `resend-verification` — plus the ones a
 * locked-out customer still needs (`me`, `change-password`) must carry this, or
 * enabling the flag locks every unverified account out of the very endpoints
 * that would unlock it.
 */
export const AllowUnverified = () => SetMetadata(ALLOW_UNVERIFIED_KEY, true);
