'use client';

import { EmailClaim } from './EmailControls';
import type { Customer } from '../../lib/portal-api';

/**
 * A wallet-only account has no email address, which is legal — but renewal
 * notices and password reset both need one.
 *
 * This used to say "email support and we'll add it", because there was no
 * endpoint behind it. There is now (PATCH /account/profile), so the banner
 * carries the form that uses it.
 *
 * The code entry is rendered here too, via `EmailClaim`. It used to be left to
 * the caller's refreshed overview on the theory that saving an address moved
 * the account out of the "no email" state — it no longer does. A claimed
 * address is staged as `pendingEmail` and `email` stays empty until the code is
 * entered, so this banner is exactly where the person still is, and the next
 * step has to be in it rather than somewhere they have to go find.
 */
export function NoEmailNotice({
  customer,
  emailVerificationRequired,
  onSaved,
}: {
  customer: Customer;
  emailVerificationRequired: boolean;
  onSaved: () => void | Promise<void>;
}) {
  return (
    <div className="emailPrompt">
      <div className="infoBanner">
        No email on your account
        <span>— renewal notices and password reset need one.</span>
      </div>
      <EmailClaim
        customer={customer}
        emailVerificationRequired={emailVerificationRequired}
        onChanged={onSaved}
      />
    </div>
  );
}
