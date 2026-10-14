import type { Metadata } from 'next';
import { Suspense } from 'react';
import { ResetPasswordClient } from './ResetPasswordClient';

export const metadata: Metadata = {
  title: 'Choose a new password',
  description: 'Set a new password on your Tickwise account using an emailed reset link.',
  // Never indexed, for a stronger reason than the other auth pages have: the URL
  // a customer actually arrives on carries a live single-use credential in its
  // query string, and a crawler that followed one would both spend it and file it.
  robots: { index: false },
};

export default function ResetPasswordPage() {
  // The client reads ?token via useSearchParams, which must sit inside a
  // Suspense boundary or the route can't be prerendered.
  return (
    <Suspense fallback={null}>
      <ResetPasswordClient />
    </Suspense>
  );
}
