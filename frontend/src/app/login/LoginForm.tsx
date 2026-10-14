'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { AuthShell } from '../../components/AuthShell';
import { PasswordSignInFields, usePasswordSignIn } from '../../components/auth/PasswordSignIn';
import { SsoPanel } from '../../components/auth/SsoPanel';
import { useSignedOutOnly } from '../../components/auth/SignedOutOnly';
import { safeReturnTo } from '../../lib/sso';

export function LoginForm() {
  const router = useRouter();
  // ?returnTo= lets a deep link (or an expired session) come back to where it
  // started. Validated: it drives a redirect right after a token is minted.
  const returnTo = safeReturnTo(useSearchParams()?.get('returnTo'));
  // Already signed in? Go to the dashboard instead of offering a second sign-in.
  const gate = useSignedOutOnly(returnTo);
  const signIn = usePasswordSignIn(() => router.replace(returnTo));

  // Nothing at all until the session check has run. Rendering the form first
  // and yanking it away is worse than a blank frame, and the SSO panel below
  // would start a provider handshake for someone who is already signed in.
  if (gate !== 'signed-out') return null;

  return (
    <AuthShell
      title="Sign in"
      subtitle="Your API keys, usage and plan."
      onSubmit={signIn.submit}
      footer={
        <>
          No account? <Link href="/signup">Create one free</Link>
        </>
      }
    >
      <>
        {/* Providers first, password below the divider — both are first-class
            ways in, so neither hides behind a link. */}
        <SsoPanel mode="signin" returnTo={returnTo} />
        <PasswordSignInFields state={signIn} />
      </>
    </AuthShell>
  );
}
