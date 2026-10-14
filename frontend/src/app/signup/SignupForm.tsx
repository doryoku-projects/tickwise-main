'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AuthShell } from '../../components/AuthShell';
import { PasswordField } from '../../components/auth/PasswordField';
import { SsoPanel } from '../../components/auth/SsoPanel';
import { useSignedOutOnly } from '../../components/auth/SignedOutOnly';
import { catalogApi } from '../../lib/catalog-api';
import { markOtpIssued } from '../../lib/otp-cooldown';
import { portalApi, setPortalToken } from '../../lib/portal-api';
import { safeReturnTo } from '../../lib/sso';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

export function SignupForm() {
  const router = useRouter();
  const params = useSearchParams();
  // ?plan=<key> comes from the pricing page's plan cards.
  const planKey = params?.get('plan') ?? '';
  // Validated — it drives a redirect right after a token is minted.
  const returnTo = safeReturnTo(params?.get('returnTo'));
  // Already signed in? Creating a second account over a live session is never
  // what someone means by clicking "Get an API key" — send them to the dashboard.
  const gate = useSignedOutOnly(returnTo);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [planName, setPlanName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Resolve the preselected plan's display name. Cosmetic — a failure here must
  // not block signup, so we silently fall back to the raw key.
  useEffect(() => {
    if (!planKey) return;
    let cancelled = false;
    catalogApi
      .listPlans()
      .then((res) => {
        if (cancelled) return;
        setPlanName(res.plans?.find((p) => p.key === planKey)?.name ?? '');
      })
      .catch(() => {
        /* ignore */
      });
    return () => {
      cancelled = true;
    };
  }, [planKey]);

  // No validation library here by design — one regex and two length checks.
  function validate(): string {
    if (!EMAIL_RE.test(email)) return 'Enter a valid email address.';
    if (password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters for your password.`;
    if (password !== confirm) return 'The two passwords do not match.';
    return '';
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const invalid = validate();
    if (invalid) {
      setError(invalid);
      return;
    }
    setError('');
    setBusy(true);
    try {
      const { token } = await portalApi.signup({ email, password, planKey: planKey || undefined });
      setPortalToken(token);
      // Signing up MINTS a code (`CustomerAuthService.signup`), spending from
      // the same 5-per-hour budget the resend draws on — so the very next
      // screen's "Send me a code" must open counting down, not live. Without
      // this the first thing a new customer could do was re-mint the code
      // already sitting in their inbox. Lowercased to match the server's
      // normalisation, which is what the code was issued against.
      //
      // Only the success path: a rejected signup created no account and no
      // code. The one imprecise case is a deployment with
      // CUSTOMER_EMAIL_VERIFICATION_REQUIRED off — nothing is minted, but the
      // signup response does not carry that flag (it arrives later on
      // /account/overview), and with verification off no code prompt renders
      // at all, so nothing reads this stamp.
      markOtpIssued(email);
      router.replace(returnTo);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign up failed');
      setBusy(false);
    }
  }

  // See LoginForm: nothing renders until the session check has run.
  if (gate !== 'signed-out') return null;

  return (
    <AuthShell
      title="Create your account"
      subtitle="Start on Free — no card, and your first key takes a minute."
      onSubmit={submit}
      footer={
        <>
          Already have an account? <Link href="/login">Sign in</Link>
        </>
      }
    >
      <>
        {planKey && (
          <div className="admin-note" style={{ margin: 0 }}>
            Selected plan: <strong>{planName || planKey}</strong>. You can change it later from your dashboard.
          </div>
        )}
        {/* Same methods as /login — signing in with a provider that has no
            account yet creates one, on Free. */}
        <SsoPanel mode="signup" returnTo={returnTo} />
        <input
          className="admin-input"
          type="email"
          autoComplete="email"
          placeholder="Email"
          aria-label="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <PasswordField
          autoComplete="new-password"
          placeholder={`Password (${MIN_PASSWORD}+ characters)`}
          value={password}
          onChange={setPassword}
        />
        <PasswordField
          autoComplete="new-password"
          placeholder="Confirm password"
          value={confirm}
          onChange={setConfirm}
        />
        {error && <div className="admin-error">{error}</div>}
        <button className="admin-btn" type="submit" disabled={busy || !email || !password || !confirm}>
          {busy ? 'Creating account…' : 'Create account'}
        </button>
        {/* Still no promise of an email here. Whether an address has to be
            confirmed is a per-deployment switch the signup response doesn't
            carry (`emailVerificationRequired` comes back from /account/overview),
            so the dashboard is where the code prompt appears — this line must
            not commit to one that may never be sent. */}
        <span className="admin-note" style={{ margin: 0 }}>
          No card required. Your keys work straight away.
        </span>
      </>
    </AuthShell>
  );
}
