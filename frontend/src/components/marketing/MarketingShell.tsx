import type { ReactNode } from 'react';
import { MarketingFooter } from './Footer';
import { MarketingHeader } from './Header';

/**
 * The public shell.
 *
 * `tw` on the root is what scopes the Tickwise base rules to this subtree — see
 * the `tw-base` layer in app/app.css. Without it the Tickwise stylesheets,
 * which style `body`, `table` and `th, td` bare, would still be dressing the
 * content inside. It comes off every shell on the day the last legacy route is
 * converted and those stylesheets are deleted.
 */
export function MarketingShell({ children }: { children: ReactNode }) {
  return (
    <div className="tw relative flex min-h-screen flex-col">
      <MarketingHeader />
      <main className="flex-1">{children}</main>
      <MarketingFooter />
    </div>
  );
}
