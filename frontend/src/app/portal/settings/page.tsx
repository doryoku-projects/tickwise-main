'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ErrorNotice, SkeletonRows } from '../../../components/StateViews';
import { PasswordField } from '../../../components/auth/PasswordField';
import { EmailCard } from '../../../components/portal/EmailControls';
import { SignInMethods } from '../../../components/portal/SignInMethods';
import { portalApi, type AccountOverview } from '../../../lib/portal-api';

const MIN_PASSWORD = 8;

export default function PortalSettingsPage() {
  const [overview, setOverview] = useState<AccountOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  /** null until the identities card reports — assume a password until told otherwise. */
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);

  // change password
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [pwError, setPwError] = useState('');
  const [pwOk, setPwOk] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setOverview(await portalApi.overview());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load your account');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwError('');
    setPwOk('');
    if (next.length < MIN_PASSWORD) {
      setPwError(`Use at least ${MIN_PASSWORD} characters for your new password.`);
      return;
    }
    if (next !== confirm) {
      setPwError('The two new passwords do not match.');
      return;
    }
    setSaving(true);
    try {
      await portalApi.changePassword(current, next);
      setPwOk('Password changed.');
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (err) {
      setPwError(err instanceof Error ? err.message : 'Could not change your password');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <div className="portalHead">
        <div>
          <h1>Settings</h1>
          <p>Your account details, sign-in methods and password.</p>
        </div>
      </div>

      <div className="admin-card">
        <h2 className="admin-h">Account</h2>
        {loading ? (
          <SkeletonRows rows={2} />
        ) : error ? (
          <ErrorNotice message={error} onRetry={() => void load()} />
        ) : overview ? (
          <div className="statGrid">
            <div className="statTile">
              <span>Plan</span>
              <strong>{overview.plan?.name ?? overview.customer.planKey}</strong>
            </div>
            <div className="statTile">
              <span>Status</span>
              <strong>{overview.customer.status ?? 'active'}</strong>
            </div>
          </div>
        ) : null}
        <p className="admin-note" style={{ marginTop: 14 }}>
          Changing plan isn&apos;t self-serve yet — <Link href="/pricing">see the plans</Link> and get in touch and
          we&apos;ll move you.
        </p>
      </div>

      {/* The address, whether it is confirmed, any address CLAIMED but not yet
          proved, and how to set or change it, all in one card. It used to be
          two read-only tiles above plus a banner on the overview that only said
          to email support: a wallet-only account had nowhere to go looking for
          this.
          The card reads `customer.pendingEmail` itself, so a claim left
          half-finished is still here — with its code entry — after a reload or
          a fresh sign-in, on this page as much as on the overview. Its resend
          comes back mid-countdown in that case rather than live: the wait is
          derived from when the code was issued (`lib/otp-cooldown.ts`), not
          from when the button was last pressed, so a reload neither restarts
          nor loses it. */}
      {overview && <EmailCard overview={overview} onChanged={load} />}

      <SignInMethods onHasPassword={setHasPassword} />

      <div className="admin-card">
        <h2 className="admin-h">Change password</h2>
        {/* A provider-only account has no current password to type, and the
            endpoint needs one — so offer nothing rather than a form that 400s. */}
        {hasPassword === false ? (
          <p className="admin-note" style={{ margin: 0 }}>
            You sign in with a provider and have no password set, so there is nothing to change here.
          </p>
        ) : (
          <>
            <form
              onSubmit={changePassword}
              style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 380 }}
            >
              <PasswordField
                autoComplete="current-password"
                placeholder="Current password"
                value={current}
                onChange={setCurrent}
              />
              <PasswordField
                autoComplete="new-password"
                placeholder={`New password (${MIN_PASSWORD}+ characters)`}
                value={next}
                onChange={setNext}
              />
              <PasswordField
                autoComplete="new-password"
                placeholder="Confirm new password"
                value={confirm}
                onChange={setConfirm}
              />
              {pwError && <div className="admin-error">{pwError}</div>}
              {pwOk && <div className="admin-ok">{pwOk}</div>}
              <div className="admin-row">
                <button className="admin-btn" type="submit" disabled={saving || !current || !next || !confirm}>
                  {saving ? 'Saving…' : 'Change password'}
                </button>
              </div>
            </form>
            <p className="admin-note">
              Your API keys are unaffected by a password change — revoke a key from{' '}
              <Link href="/portal/keys">API keys</Link> if you think it leaked.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
