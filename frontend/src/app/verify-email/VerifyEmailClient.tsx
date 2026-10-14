'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AuthShell } from '../../components/AuthShell';
import { OtpForm } from '../../components/auth/OtpForm';
import { DevCodeHint, SignupCodeResend } from '../../components/portal/EmailControls';
import { getPortalToken, portalApi } from '../../lib/portal-api';

/**
 * Standalone email verification.
 *
 * Verification is a 6-DIGIT CODE now, not a link, so there is no token to read
 * out of the URL and nothing to consume on mount — the page just asks for the
 * code. That also makes it safe to open twice, which the link version was not.
 *
 * Works signed-out: a code is frequently typed in a different browser from the
 * one that asked for it. The only thing a session changes is the resend
 * control, which is authenticated and therefore hidden when there isn't one.
 */
export function VerifyEmailClient() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  /**
   * The account's address, purely so the resend below counts against the SAME
   * cooldown bucket the portal uses for it. Without it this page would keep its
   * own tally and hand out a live button for a code the portal just minted.
   */
  const [email, setEmail] = useState<string | null>(null);

  // Read after mount so the server and first client render agree.
  useEffect(() => {
    let live = true;
    if (!getPortalToken()) {
      setSignedIn(false);
      return;
    }
    void (async () => {
      try {
        const customer = await portalApi.me();
        if (live) setEmail(customer.email ?? null);
      } catch {
        // Not fatal: the address only picks the cooldown bucket, and
        // `otpCooldownKey` has a shared fallback for exactly this. The resend
        // itself still works — or fails with the server's own words.
      } finally {
        // Re-read rather than assuming: `me` answering 401 CLEARED the token,
        // so there is no session left to resend with and the signed-out copy
        // below is the honest thing to show. /verify-email is a public path, so
        // that 401 does not bounce anyone off this page mid-code.
        if (live) setSignedIn(Boolean(getPortalToken()));
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  return (
    <AuthShell
      title="Verify your email"
      subtitle="Confirming your address is what keeps renewal notices and password reset working."
      footer={
        <>
          Need a hand? <Link href="/pricing">Read about plans</Link>
        </>
      }
    >
      <>
        {signedIn === null ? (
          <div className="skeletonRows">
            <div className="skeletonRow" />
          </div>
        ) : (
          <>
            {/* The form's own resend is not used anywhere any more: its timer
                started on a press, so it could not know about the code that
                brought someone to this page. `SignupCodeResend` derives the
                wait from when that code was actually issued. */}
            <OtpForm />
            <DevCodeHint />
            {signedIn && <SignupCodeResend address={email} />}
            {!signedIn && (
              <span className="admin-note" style={{ margin: 0 }}>
                Signed out? Sign in first if you need a new code sent.
              </span>
            )}
            <Link
              className="admin-btn ghost"
              href={signedIn ? '/portal' : '/login'}
              style={{ textAlign: 'center' }}
            >
              {signedIn ? 'Go to your dashboard' : 'Sign in'}
            </Link>
          </>
        )}
      </>
    </AuthShell>
  );
}
