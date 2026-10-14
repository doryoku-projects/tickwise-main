'use client';

import Link from 'next/link';
import { useState } from 'react';
import { portalApi, setPortalToken } from '../../lib/portal-api';
import { PasswordField } from './PasswordField';

/**
 * The email + password half of signing in, shared by /login and the
 * /link-account ceremony. Same credentials, same failure copy, one
 * implementation — a second login form is a second place for the enumeration
 * rules below to be got wrong.
 *
 * It is split into a hook and a field set because the <form> belongs to the
 * CALLER: `AuthShell` makes the card itself the form, and the card's flex gap is
 * what lays these controls out. A nested <form> would need its own layout and
 * would break that. So the caller passes `submit` to `AuthShell` and renders
 * `<PasswordSignInFields>` as a direct child.
 */
export interface PasswordSignInState {
  email: string;
  password: string;
  error: string;
  busy: boolean;
  setEmail: (value: string) => void;
  setPassword: (value: string) => void;
  submit: (e: React.FormEvent) => void;
}

/** `onSignedIn` runs with the token already stored — navigate, or move the page
 *  on to its next step. `busy` stays true afterwards: the fields are on their
 *  way out either way, and re-enabling them invites a second login. */
export function usePasswordSignIn(onSignedIn: () => void): PasswordSignInState {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { token } = await portalApi.login(email, password);
      setPortalToken(token);
      onSignedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed');
      setBusy(false);
    }
  }

  return {
    email,
    password,
    error,
    busy,
    setEmail,
    setPassword,
    submit: (e) => void run(e),
  };
}

export function PasswordSignInFields({ state }: { state: PasswordSignInState }) {
  return (
    <>
      <input
        className="admin-input"
        type="email"
        autoComplete="email"
        placeholder="Email"
        aria-label="Email"
        value={state.email}
        onChange={(e) => state.setEmail(e.target.value)}
      />
      <PasswordField
        autoComplete="current-password"
        placeholder="Password"
        value={state.password}
        onChange={state.setPassword}
      />
      {/* ONE message, whatever went wrong, and no sign-up CTA here — the
          footer below already carries "No account? Create one free", so
          repeating it in the error just said the same thing twice.

          The server answers a wrong password and a non-existent account with a
          BYTE-IDENTICAL 401 on purpose: any difference — a distinct message,
          or bouncing to /signup only when the account is missing — is a user
          enumeration oracle, letting anyone probe one address at a time to
          learn who has an account here. So we never say "no such account" and
          we never redirect on failure. */}
      {state.error && <div className="admin-error">{state.error}</div>}
      <button
        className="admin-btn"
        type="submit"
        disabled={state.busy || !state.email || !state.password}
      >
        {state.busy ? 'Signing in…' : 'Sign in'}
      </button>
      {/* THE ONLY anonymous entry point into the reset flow. It shipped disabled
          while reset was unbuilt; now that /forgot-password answers, a disabled
          span here would strand exactly the person the flow exists for — someone
          who cannot sign in and so cannot reach Settings.

          Deliberately plain: it must not hint at whether an address is
          registered, because the request route answers identically either way and
          a helpful nudge here would leak what that route refuses to. */}
      <span className="admin-note" style={{ margin: 0 }}>
        <Link href="/forgot-password">Forgot your password?</Link> We will email a link to set a new one.
      </span>
    </>
  );
}
