'use client';

import { LogOut } from 'lucide-react';
import { useState } from 'react';
import { type Customer } from '../../lib/portal-api';
import { OtpForm } from '../auth/OtpForm';
import {
  DevCodeHint,
  EmailAddressForm,
  PendingEmailNotice,
  SignupCodeResend,
} from './EmailControls';

/**
 * The screen an unverified customer gets INSTEAD of the portal.
 *
 * This is not the overview's verify banner. That one is a nag beside a working
 * page; this one stands in for a portal that will not open at all, because
 * `CustomerJwtGuard` 403s every `/account/*` route until the address is proved.
 * Without it the shell rendered a generic error with a "Try again" button that
 * could only ever fail again — a permanent dead end for anyone whose account
 * predates `CUSTOMER_EMAIL_VERIFICATION_REQUIRED` being turned on.
 *
 * So everything needed to get OUT lives here: which address the code is for, a
 * button that mints one, the entry that spends it, a way to correct a mistyped
 * address, and the way out of the session entirely.
 */
export function VerifyEmailGate({
  customer,
  onVerified,
  onLogOut,
  loggingOut,
}: {
  /** From `GET /account/auth/me`, which stays reachable while unverified. */
  customer: Customer | null;
  /** Re-runs the shell's load, so a verified portal opens without a refresh. */
  onVerified: () => void | Promise<void>;
  onLogOut: () => void;
  loggingOut: boolean;
}) {
  const email = customer?.email ?? null;
  const pendingEmail = customer?.pendingEmail ?? null;

  return (
    <div className="admin-card">
      <h1 className="font-display text-2xl font-semibold">
        Verify your email to open the portal
      </h1>
      <p className="admin-note" style={{ maxWidth: '68ch', lineHeight: 1.6 }}>
        This deployment requires a proved email address before your account pages will load, and
        this one has not been proved yet. Enter a 6-digit code below and the portal opens
        immediately. Any API keys you already hold are unaffected — only these pages are closed.
      </p>

      {/* Three states, same priority order the overview uses — never ask for a
          code that was never minted, and never point at an inbox we don't know.

          1. A PENDING claim outranks everything: only ONE verification code is
             stored per customer, so the code in someone's hand belongs to the
             most recent mint, which is the claim. Offering the signup entry too
             would be giving one code two contradictory jobs.
          2. An address on the account: mint a code for it, and type it in.
          3. No address at all (a wallet-only signup): there is nowhere to send
             anything, so the way forward is to claim an address first. PATCH
             /account/profile is `@AllowUnverified` precisely so this is
             reachable from behind the gate. */}
      {pendingEmail ? (
        <PendingEmailNotice email={pendingEmail} onVerified={onVerified} />
      ) : email ? (
        <SignupCodePanel email={email} onVerified={onVerified} />
      ) : (
        <NoAddressPanel onStaged={onVerified} />
      )}

      <div className="admin-row" style={{ marginTop: 18 }}>
        <button className="admin-btn ghost sm" type="button" disabled={loggingOut} onClick={onLogOut}>
          <LogOut size={14} style={{ marginRight: 6, verticalAlign: 'text-bottom' }} />
          {loggingOut ? 'Logging out…' : 'Log out'}
        </button>
        <span className="admin-note" style={{ margin: 0 }}>
          Signing out always works from here — nobody should be trapped on this screen.
        </span>
      </div>
    </div>
  );
}

/**
 * The address is on the account but unproved: mint a code for it, spend it.
 *
 * The entry only SPENDS a code; the request is rendered separately as
 * `SignupCodeResend`. Deliberate — two resend controls would carry two
 * independent cooldowns, which is the same as having none. That shared control
 * derives its cooldown from the moment the last code for this address was
 * issued, so it is honest about a code minted before this panel mounted.
 */
function SignupCodePanel({
  email,
  onVerified,
}: {
  email: string;
  onVerified: () => void | Promise<void>;
}) {
  /** Reveals the change-address form — a mistyped signup address is otherwise
   *  unrecoverable, since the code goes somewhere its owner cannot read. */
  const [correcting, setCorrecting] = useState(false);

  return (
    <div className="emailPrompt">
      <div className="infoBanner">
        Your code is for {email}
        <span>— the address this account was registered with.</span>
      </div>

      {/* Landing here does not always mean a code is outstanding — someone can
          arrive months after signing up — so this reads whatever timestamp the
          last mint for `email` left behind: counting down if a code was just
          issued (signup, another tab, the settings card), live if not. The
          panel is otherwise unchanged; the timer simply no longer starts only
          on a press. */}
      <SignupCodeResend address={email} idleLabel="Send me a code" className="admin-btn" />

      {/* `email` is deliberately NOT passed down: the entry's label would then
          read "the code sent to …", and nothing was sent. The banner above
          already says which address it is for. */}
      <OtpForm onVerified={onVerified} />
      <DevCodeHint />

      {correcting ? (
        <div>
          <p className="admin-note" style={{ marginTop: 0 }}>
            Claiming a different address issues the code for that one instead. Your account address
            only changes once you enter it.
          </p>
          <EmailAddressForm currentEmail={email} onStaged={onVerified} />
        </div>
      ) : (
        <button
          className="admin-btn ghost sm"
          type="button"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => setCorrecting(true)}
        >
          Wrong address?
        </button>
      )}
    </div>
  );
}

/** A wallet-only account: no address exists, so no code can go anywhere yet. */
function NoAddressPanel({ onStaged }: { onStaged: () => void | Promise<void> }) {
  return (
    <div className="emailPrompt">
      <div className="infoBanner">
        This account has no email address
        <span>— add one and we will issue a code for it.</span>
      </div>
      {/* No DevCodeHint here: no code has been minted yet, so pointing at the
          server log would be pointing at nothing. It appears with the pending
          notice the moment an address is claimed. */}
      <EmailAddressForm onStaged={onStaged} />
    </div>
  );
}
