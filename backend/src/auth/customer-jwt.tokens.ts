/**
 * Injection token for the CUSTOMER-realm `JwtService` (signed/verified with
 * `CUSTOMER_JWT_SECRET`, never `JWT_SECRET`).
 *
 * `@nestjs/jwt` exposes exactly one `JwtService` class token and one
 * `"JWT_MODULE_OPTIONS"` options token, so registering `JwtModule` twice
 * silently yields a SINGLE service configured from whichever registration
 * resolved last. The second realm therefore gets its own hand-built instance
 * behind this token (provided + exported by `AuthModule`).
 *
 * Kept in its own file so a consumer can `@Inject(CUSTOMER_JWT)` without
 * importing `AuthModule` (which imports nothing from the billing side and must
 * stay that way — `BillingModule` already imports `AuthModule`).
 */
export const CUSTOMER_JWT = 'CUSTOMER_JWT' as const;
