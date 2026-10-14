import { Suspense } from 'react';
import { CheckoutReturnClient } from './CheckoutReturnClient';

/**
 * `useSearchParams` forces a client boundary, and Next requires it to sit under
 * a `Suspense` — without one the whole route opts out of static rendering and
 * the build warns.
 */
export default function CheckoutReturnPage() {
  return (
    <Suspense fallback={<div className="admin-card">Checking your payment…</div>}>
      <CheckoutReturnClient />
    </Suspense>
  );
}
