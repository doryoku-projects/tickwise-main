'use client';

import { MarketingHeader } from '@/components/marketing/Header';

/**
 * Centred card used by /login, /signup, /verify-email, /forgot-password,
 * /reset-password and /link-account.
 *
 * The design source renders these chrome-free — just a logo above the card —
 * on the theory that there is nothing to click away to. In practice that
 * stranded anyone who landed on /login from a search result or a stale
 * bookmark: no way back to pricing, docs or the home page without editing the
 * URL. So the shared marketing header sits above the card here, exactly as it
 * does on every other public page, and the logo it already carries replaces
 * the standalone mark.
 *
 * The prop shape is unchanged from the Tickwise version, so every caller —
 * including the ones whose bodies are still built from `.admin-*` classes —
 * keeps working untouched. Those inner controls pick up the design tokens from
 * the `tw-bridge` layer in app.css because of the `tw` class on the root here.
 */
export function AuthShell({
  title,
  subtitle,
  children,
  footer,
  onSubmit,
}: {
  title: string;
  /** Node, not string: /link-account sets the colliding address in `.mono`. */
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** Pass to make the card itself the <form>. */
  onSubmit?: (e: React.FormEvent) => void;
}) {
  const body = (
    <>
      <div>
        <h1 className="font-display text-2xl font-semibold">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {children}
    </>
  );

  return (
    <div className="tw flex min-h-screen flex-col bg-hero">
      <MarketingHeader />
      <main className="px-gutter flex flex-1 flex-col items-center justify-center py-12">
        <div className="w-full max-w-sm">
        {onSubmit ? (
          <form
            className="flex flex-col gap-5 rounded-2xl border border-border/60 bg-surface p-8 shadow-card"
            onSubmit={onSubmit}
          >
            {body}
          </form>
        ) : (
          <div className="flex flex-col gap-5 rounded-2xl border border-border/60 bg-surface p-8 shadow-card">
            {body}
          </div>
        )}
          {footer && (
            <div className="mt-4 text-center text-sm text-muted-foreground [&_a]:text-primary [&_a:hover]:underline">
              {footer}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
