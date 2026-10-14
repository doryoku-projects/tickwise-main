import type { Metadata } from 'next';
import { Suspense } from 'react';
import { SignupForm } from './SignupForm';

export const metadata: Metadata = {
  title: 'Create an account',
  description: 'Create a free Tickwise account and get an API key for Uniswap v4 position data.',
  robots: { index: false },
};

export default function SignupPage() {
  // SignupForm reads ?plan= via useSearchParams, which must sit inside a
  // Suspense boundary or the route can't be prerendered.
  return (
    <Suspense fallback={null}>
      <SignupForm />
    </Suspense>
  );
}
