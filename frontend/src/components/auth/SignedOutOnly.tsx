'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { getPortalToken, PORTAL_PUBLIC_PATHS } from '../../lib/portal-api';
import { DEFAULT_RETURN_TO, safeReturnTo } from '../../lib/sso';

/**
 * 'checking'    — localStorage hasn't been read yet (one tick, server render included)
 * 'signed-out'  — no session; render the form
 * 'redirecting' — a session exists; a replace() is already in flight
 */
export type AuthGate = 'checking' | 'signed-out' | 'redirecting';

/**
 * Keeps a signed-in visitor off /login and /signup.
 *
 * Sitting on a sign-in form with a live session is not a neutral no-op: the
 * forms mint a NEW token over the top of the old one, and the SSO handshake
 * behind them assumes a signed-out caller. Bouncing to the dashboard is both
 * the safer and the more obvious behaviour.
 *
 * Client-side, exactly like the /portal and /admin guards: the JWT lives in
 * localStorage, which no server component or middleware can read. Callers must
 * render NOTHING until this reports 'signed-out' — flashing a sign-in form at
 * someone who is already signed in is the bug this exists to remove.
 */
export function useSignedOutOnly(returnTo?: string): AuthGate {
  const router = useRouter();
  const [gate, setGate] = useState<AuthGate>('checking');

  useEffect(() => {
    if (!getPortalToken()) {
      setGate('signed-out');
      return;
    }
    setGate('redirecting');
    router.replace(signedInDestination(returnTo));
  }, [returnTo, router]);

  return gate;
}

/**
 * Where an already-signed-in visitor lands. `?returnTo=` is honoured so a deep
 * link that bounced through /login still ends up where it was headed, but it
 * can never point back INTO the auth flow — that would be an immediate loop.
 */
function signedInDestination(returnTo?: string): string {
  const to = safeReturnTo(returnTo);
  const path = to.split(/[?#]/)[0];
  return PORTAL_PUBLIC_PATHS.includes(path) ? DEFAULT_RETURN_TO : to;
}
