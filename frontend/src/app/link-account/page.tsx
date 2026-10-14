import type { Metadata } from 'next';
import { Suspense } from 'react';
import { LinkAccountClient } from './LinkAccountClient';

export const metadata: Metadata = {
  title: 'Connect a sign-in method',
  description: 'Connect a provider to the Tickwise account that already uses this address.',
  robots: { index: false },
};

export default function LinkAccountPage() {
  // The client reads ?token/?provider via useSearchParams, which must sit
  // inside a Suspense boundary or the route can't be prerendered.
  return (
    <Suspense fallback={null}>
      <LinkAccountClient />
    </Suspense>
  );
}
