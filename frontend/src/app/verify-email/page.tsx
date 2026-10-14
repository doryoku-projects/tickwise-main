import type { Metadata } from 'next';
import { Suspense } from 'react';
import { VerifyEmailClient } from './VerifyEmailClient';

export const metadata: Metadata = {
  title: 'Verify your email',
  robots: { index: false },
};

export default function VerifyEmailPage() {
  // useSearchParams (?token=) needs a Suspense boundary to prerender.
  return (
    <Suspense fallback={null}>
      <VerifyEmailClient />
    </Suspense>
  );
}
