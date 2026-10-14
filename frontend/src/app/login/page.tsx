import type { Metadata } from 'next';
import { Suspense } from 'react';
import { LoginForm } from './LoginForm';

export const metadata: Metadata = {
  title: 'Sign in',
  description: 'Sign in to your Tickwise account to manage API keys, usage and your plan.',
  robots: { index: false },
};

export default function LoginPage() {
  // LoginForm reads ?returnTo via useSearchParams, which must sit inside a
  // Suspense boundary or the route can't be prerendered.
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
