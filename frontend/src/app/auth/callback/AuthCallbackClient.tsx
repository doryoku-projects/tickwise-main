'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AuthShell } from '../../../components/AuthShell';
import { portalApi, setPortalToken, type AuthResult } from '../../../lib/portal-api';
import { DEFAULT_RETURN_TO, readSlug, safeReturnTo, takeReturnTo } from '../../../lib/sso';

type State = 'exchanging' | 'error' | 'missing';

/**
 * Handoff codes are SINGLE USE: the second POST always fails. StrictMode
 * double-invokes effects in dev and Fast Refresh can remount at any time, so
 * dedupe by code at module scope — a repeat mount awaits the same in-flight
 * promise instead of burning the code and reporting a failure that never
 * happened. A ref wouldn't survive the remount; this does.
 */
const exchanges = new Map<string, Promise<AuthResult>>();

function exchangeOnce(code: string): Promise<AuthResult> {
  const existing = exchanges.get(code);
  if (existing) return existing;
  const pending = portalApi.exchangeOauthCode(code);
  exchanges.set(code, pending);
  return pending;
}

/**
 * Honest copy for the slugs the callback can hand back. Keep this in step with
 * `CallbackErrorSlug` in backend/src/identity/identity.service.ts — a slug with
 * no entry here falls through to the raw slug below, which is a dead end
 * dressed up as an explanation.
 */
const ERROR_COPY: Record<string, string> = {
  access_denied: 'You cancelled the sign-in, or the provider declined it.',
  invalid_state: "That sign-in attempt didn't match this browser. Start again.",
  expired_state: 'That sign-in attempt expired. Start again.',
  provider_error: "The provider couldn't complete the sign-in.",
  // The collision an SSO login can hit: an account already uses that address.
  // A provider-VERIFIED address never lands here any more — it is offered the
  // /link-account ceremony instead. This is the remaining case, where the
  // provider has not verified the address, so nothing has proved the person
  // signing in owns it. Linking from a session that already holds the account
  // is the safe route, and it is self-serve.
  email_in_use:
    'An account here already uses that address, and the provider has not verified it belongs to you. Sign in the way you normally do, then add this provider under Settings → Sign-in methods.',
  already_linked:
    'That provider account is already connected to a different account here. Sign in to that one, or use a different provider account.',
  account_suspended: 'That account is suspended, so it cannot be used to sign in.',
  server_error: 'Something went wrong on our side. Nothing was changed — try again.',
};

/**
 * Lands the OAuth round-trip: trade the handoff code for a session, then leave.
 * Also handles the link flow from /portal/settings — same code, same exchange,
 * it just returns to settings.
 */
export function AuthCallbackClient() {
  const router = useRouter();
  const params = useSearchParams();
  const code = params?.get('code') ?? '';
  const errorSlug = readSlug(params?.get('error'));
  const provider = readSlug(params?.get('provider'));

  const [state, setState] = useState<State>(() => {
    if (errorSlug) return 'error';
    return code ? 'exchanging' : 'missing';
  });
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!code || errorSlug) return;
    let cancelled = false;
    exchangeOnce(code)
      .then(({ token }) => {
        if (cancelled) return;
        setPortalToken(token);
        // The destination was stashed before we left for the provider; the query
        // string is honoured too in case the backend starts round-tripping it.
        const dest = safeReturnTo(params?.get('returnTo') ?? takeReturnTo() ?? DEFAULT_RETURN_TO);
        // replace(), so the URL holding the handoff code leaves the history
        // stack instead of sitting in it (and in the back button).
        router.replace(dest);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setMessage(err instanceof Error ? err.message : 'That sign-in link could not be used.');
        setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, [code, errorSlug, params, router]);

  const copy: Record<State, { title: string; subtitle: string }> = {
    exchanging: {
      title: 'Signing you in',
      subtitle: provider
        ? `One moment — finishing the handshake with ${provider}.`
        : 'One moment — finishing the handshake.',
    },
    error: {
      title: "That sign-in didn't complete",
      subtitle: 'Nothing was changed on your account. You can try again.',
    },
    missing: {
      title: 'Nothing to finish here',
      subtitle: 'This page is the last step of a provider sign-in.',
    },
  };

  return (
    <AuthShell
      title={copy[state].title}
      subtitle={copy[state].subtitle}
      footer={
        <>
          Trouble signing in? <Link href="/pricing">Read about plans</Link>
        </>
      }
    >
      <>
        {state === 'exchanging' && (
          <div className="skeletonRows" aria-busy="true">
            <div className="skeletonRow" />
          </div>
        )}

        {state === 'error' && (
          <div className="admin-error">
            {message || ERROR_COPY[errorSlug] || 'The provider returned an error.'}
          </div>
        )}
        {/* The raw slug only when we have no wording for it — it's the only clue
            worth passing on, and readSlug() has already vetted it. */}
        {state === 'error' && errorSlug && !ERROR_COPY[errorSlug] && (
          <span className="admin-note" style={{ margin: 0 }}>
            Provider reason: <span className="mono">{errorSlug}</span>
          </span>
        )}

        {state === 'missing' && (
          <div className="admin-note" style={{ margin: 0 }}>
            Start from the sign-in page and pick a provider there.
          </div>
        )}

        {state !== 'exchanging' && (
          <Link className="admin-btn" href="/login" style={{ textAlign: 'center' }}>
            Back to sign in
          </Link>
        )}
      </>
    </AuthShell>
  );
}
