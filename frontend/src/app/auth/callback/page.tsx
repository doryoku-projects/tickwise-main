import type { Metadata } from 'next';
import { Suspense } from 'react';
import { AuthCallbackClient } from './AuthCallbackClient';

export const metadata: Metadata = {
  title: 'Signing you in',
  description: 'Finishing your Tickwise sign-in.',
  robots: { index: false },
};

export default function AuthCallbackPage() {
  // The client reads ?provider/?code/?error via useSearchParams, which must sit
  // inside a Suspense boundary or the route can't be prerendered.
  return (
    <Suspense fallback={null}>
      <AuthCallbackClient />
    </Suspense>
  );
}
