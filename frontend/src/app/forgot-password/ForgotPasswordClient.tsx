'use client';

import Link from 'next/link';
import { useState } from 'react';
import { AuthShell } from '../../components/AuthShell';
import { httpStatus, portalApi } from '../../lib/portal-api';

/**
 * Ask for a reset link. The first half of the flow `/reset-password` finishes.
 *
 * THE WHOLE PAGE IS BUILT AROUND ONE RULE: it must never reveal whether an
 * address has an account. The server already refuses to — `requestPasswordReset`
 * answers an identical 202 for a registered address, an unregistered one, an
 * unverified one and a suspended one, and logs the real reason server-side where
 * only we can see it. That guarantee is worth nothing if this page hands it back:
 * a distinct error, a bounce to /signup when the address is unknown, even a
 * different spinner duration, and anyone can probe the customer list one address
 * at a time. So there is exactly ONE success state and it is stated in the
 * conditional — "if that address has an account".
 *
 * The same reasoning is already written on the sign-in form's byte-identical 401
 * (components/auth/PasswordSignIn.tsx) — this is that rule, on the other route
 * that takes an address from a stranger.
 *
 * ONE HONEST ASYMMETRY, so nobody "fixes" it later by making the copy vaguer:
 * the response is uniform in body and status but NOT in timing — a hit awaits a
 * database write and a live mail round trip, a miss returns after the read. The
 * backend says so plainly in its own doc comment. Closing it needs a delivery
 * queue on the server, not a change here; a fake delay on the client would only
 * hide it from someone who is not measuring.
 */
export function ForgotPasswordClient() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (busy || !email.trim()) return;
    setBusy(true);
    setError('');
    try {
      await portalApi.forgotPassword(email.trim());
      setSent(true);
    } catch (err) {
      // The ONLY failures worth showing are ours, never the account's. A 429 is
      // the request budget (per-address and per-IP, both charged whether or not
      // the address resolves — charging only on a hit would turn the limiter
      // itself into the oracle the 202 exists to close). Anything else is a
      // network or server fault. Neither says anything about the address, which
      // is exactly why both are safe to surface.
      const status = httpStatus(err);
      setError(
        status === 429
          ? 'Too many requests. Wait a few minutes and try again.'
          : err instanceof Error && err.message
            ? err.message
            : 'Something went wrong. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <AuthShell
        title="Check your email"
        subtitle="If that address has an account, a link to set a new password is on its way."
        footer={<Link href="/login">Back to sign in</Link>}
      >
        {/* Deliberately NOT "we sent you an email": we do not say whether we
            did. The conditional is the anti-enumeration guarantee in plain
            words, and it must survive every future copy edit.

            The expiry IS safe to state — it is a property of the link, not of
            the account, and someone who never receives one learns nothing from
            it. Saying it here is what stops a customer sitting on a dead link
            an hour later wondering why nothing works. */}
        <div className="admin-ok">
          The link works once and expires in 30 minutes. Opening it signs you out of every existing
          session.
        </div>
        <p className="admin-note" style={{ margin: 0 }}>
          Nothing arrived? Check spam, then request another link. If the account uses Google, GitHub
          or a wallet to sign in, there may be no password to reset — try those instead.
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Reset your password"
      subtitle="Enter the address on your account and we'll email a link to set a new password."
      onSubmit={submit}
      footer={
        <>
          Remembered it? <Link href="/login">Back to sign in</Link>
        </>
      }
    >
      <input
        className="admin-input"
        type="email"
        autoComplete="email"
        placeholder="Email"
        aria-label="Email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      {error && <div className="admin-error">{error}</div>}
      <button className="admin-btn" type="submit" disabled={busy || !email.trim()}>
        {busy ? 'Sending…' : 'Send reset link'}
      </button>
    </AuthShell>
  );
}
